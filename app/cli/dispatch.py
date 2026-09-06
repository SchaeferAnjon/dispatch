#!/usr/bin/env python3
"""dispatch — the Agent-facing CLI for the global task board.

Everything Dispatch.app shows, an Agent can ask for here (JSON with --json):

  dispatch sessions                 live Agent sessions (who is running where, busy or waiting)
  dispatch find <task-id>           sessions whose transcript mentions the task, with resume commands
  dispatch resume <session|task>    print (or --copy) the command that resumes a session
  dispatch focus <session|task>     jump to the Herdr tab running that session
  dispatch skills list|show|enable|disable|open|path
  dispatch prime [--hook-json]      compact session-start digest: identity, this project's tasks, relevant wiki, who else is in this dir, your quota
  dispatch claim <task> [--force]   claim without stealing: refuses a task another agent is working on
  dispatch wiki add|list|search|show   knowledge base: pits (坑), wins (做对), retros (复盘), howtos (方法)
  dispatch pit add|list|show        = wiki --kind pit
  dispatch insights [--days N]      cross-agent /insights: signals, samples, an improvement task to hand to an agent
  dispatch catalog [-q kw]          skills/plugins kept off by default; agents suggest one when it would help
  dispatch --host <id> <any subcommand>   run it on another Mac from hosts.json (ssh; stdin/stdout pass through)
  dispatch env list|get|set|unset|export|import   API keys & secrets (~/.config/dispatch/env, 0600; prime lists names only)

Data lives in ~/tasks/.dispatch (session registry, transcript index) and the
Beads board at $BEADS_DIR. bd remains the tool for tasks themselves.
"""
import argparse, glob, json, os, re, subprocess, sys, time

HOME = os.path.expanduser("~")
DISPATCH_DIR = os.path.join(HOME, "tasks", ".dispatch")
SESS_DIR = os.path.join(DISPATCH_DIR, "sessions")
INDEX_FILE = os.path.join(DISPATCH_DIR, "transcript-index.json")
BEADS_DIR = os.environ.get("BEADS_DIR", os.path.join(HOME, "tasks", ".beads"))
POOL = os.path.join(HOME, ".cc-switch", "skills")
# Where each agent looks for skills. The first dir is where `enable` creates the
# symlink; the rest are also scanned (Codex reads both its own dir and the
# cross-agent ~/.agents/skills).
AGENT_SKILL_DIRS = {
    "claude": [os.path.join(HOME, ".claude", "skills")],
    "codex": [os.path.join(HOME, ".agents", "skills"), os.path.join(HOME, ".codex", "skills")],
}
CC_SWITCH_DB = os.path.join(HOME, ".cc-switch", "cc-switch.db")
HERDR = os.path.join(HOME, ".local", "bin", "herdr")
ZCODE_DB = os.path.join(HOME, ".zcode", "cli", "db", "db.sqlite")
# Qoder ships two apps that share one account, one ~/.qoder/settings.json (hooks) and
# one ~/.qoder/AGENTS.md, but keep separate chat stores.
QODER_APP_DB = os.path.join(HOME, "Library", "Application Support", "com.qodercn.app.stable", "main.sqlite")
QODER_IDE_DB = os.path.join(HOME, "Library", "Application Support", "QoderCN", "SharedClientCache", "cache", "db", "local.db")
QODER_APPS = {"qoder": ("Qoder CN.app/Contents/MacOS/", "Qoder CN", "Qoder"), "qoder-ide": ("Qoder CN IDE.app/Contents/MacOS/", "Qoder CN IDE", "Qoder IDE")}
PATH_EXTRA = "/opt/homebrew/bin:/usr/local/bin:" + os.path.join(HOME, ".local", "bin")


def sh(args, timeout=20, env=None):
    e = dict(os.environ)
    e["PATH"] = PATH_EXTRA + ":" + e.get("PATH", "")
    e.setdefault("BEADS_DIR", BEADS_DIR)
    if env:
        e.update(env)
    # bd truncates long values mid-character; decode leniently or every write with a
    # long Chinese memory blows up with UnicodeDecodeError (task-8xp).
    r = subprocess.run(args, capture_output=True, timeout=timeout, env=e)
    return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")


def out(obj, as_json, text_fn):
    if as_json:
        print(json.dumps(obj, ensure_ascii=False, indent=2))
    else:
        text_fn(obj)


def ago(epoch):
    if not epoch:
        return "?"
    m = max(0, int((time.time() - epoch) / 60))
    return "刚刚" if m < 1 else f"{m}m" if m < 60 else f"{m // 60}h" if m < 1440 else f"{m // 1440}d"


# ---------------------------------------------------------------- sessions

def ps_table():
    _, o, _ = sh(["ps", "-axo", "pid=,ppid=,comm="])
    t = {}
    for line in o.splitlines():
        p = line.strip().split(None, 2)
        if len(p) == 3:
            t[int(p[0])] = (int(p[1]), p[2])
    return t


def herdr_agents():
    if not os.path.exists(HERDR):
        return []
    try:
        code, o, _ = sh([HERDR, "agent", "list"], timeout=5)
        if code != 0:
            return []
        return json.loads(o).get("result", {}).get("agents", [])
    except Exception:
        return []


def zcode_query(sql, params=()):
    """ZCode (OpenCode-based desktop app) keeps everything in one SQLite file; read-only."""
    if not os.path.exists(ZCODE_DB):
        return []
    try:
        import sqlite3
        con = sqlite3.connect(f"file:{ZCODE_DB}?mode=ro", uri=True, timeout=2)
        con.row_factory = sqlite3.Row
        rows = [dict(r) for r in con.execute(sql, params)]
        con.close()
        return rows
    except Exception:
        return []


def zcode_live(table):
    """ZCode has no hooks; a session updated in the last few minutes counts as live."""
    pids = [pid for pid, (_, comm) in table.items() if os.path.basename(comm) == "zcode-cli"]
    if not pids:
        return []
    now = time.time()
    rows = zcode_query("select id, directory, title, time_created, time_updated from session where parent_id is null and time_archived is null and time_updated > ? order by time_updated desc", ((now - 30 * 60) * 1000,))
    out = []
    for r in rows:
        last = r["time_updated"] / 1000
        state = "working" if now - last < 90 else "idle"
        out.append({"agent": "zcode", "session_id": r["id"], "cwd": r["directory"], "project": os.path.basename(r["directory"].rstrip("/")), "agent_pid": pids[0], "source_kind": "desktop", "source_app": "ZCode", "entrypoint": "", "started_at": r["time_created"] / 1000, "last_at": last, "state": state, "prompts": 0, "alive": True, "registered": True, "title": r["title"]})
    return out


def sqlite_rows(path, sql, params=()):
    """Read-only query against some app's SQLite file; never raises, never locks it."""
    if not os.path.exists(path):
        return []
    try:
        import sqlite3
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
        con.row_factory = sqlite3.Row
        rows = [dict(r) for r in con.execute(sql, params)]
        con.close()
        return rows
    except Exception:
        return []


def qoder_pids(table):
    """pid of each running Qoder app, keyed by agent id. The IDE's path contains the
    app's path as a prefix-free sibling, so match the longer name first."""
    pids = {}
    for pid, (_, comm) in table.items():
        if QODER_APPS["qoder-ide"][0] in comm:
            pids.setdefault("qoder-ide", pid)
        elif QODER_APPS["qoder"][0] in comm:
            pids.setdefault("qoder", pid)
    return pids


def qoder_live(table):
    """Fallback for sessions the presence hook did not register: a session touched in the
    last 30 minutes while its app is running counts as live."""
    pids = qoder_pids(table)
    now = time.time()
    since = (now - 30 * 60) * 1000
    out = []
    if "qoder" in pids:
        for r in sqlite_rows(QODER_APP_DB, "select session_id, title, cwd, created_at, updated_at from chat_sessions where deleted_at is null and archived = 0 and updated_at > ? order by updated_at desc", (since,)):
            last = r["updated_at"] / 1000
            out.append({"agent": "qoder", "session_id": r["session_id"], "cwd": r["cwd"] or "", "project": os.path.basename((r["cwd"] or "").rstrip("/")), "agent_pid": pids["qoder"], "source_kind": "desktop", "source_app": "Qoder", "entrypoint": "desktop", "started_at": r["created_at"] / 1000, "last_at": last, "state": "working" if now - last < 90 else "idle", "prompts": 0, "alive": True, "registered": True, "title": r["title"]})
    if "qoder-ide" in pids:
        for r in sqlite_rows(QODER_IDE_DB, "select session_id, session_title, project_uri, gmt_create, gmt_modified from chat_session where (parent_session_id = '' or parent_session_id is null) and gmt_modified > ? order by gmt_modified desc", (since,)):
            last = r["gmt_modified"] / 1000
            out.append({"agent": "qoder-ide", "session_id": r["session_id"], "cwd": r["project_uri"] or "", "project": os.path.basename((r["project_uri"] or "").rstrip("/")), "agent_pid": pids["qoder-ide"], "source_kind": "editor", "source_app": "Qoder IDE", "entrypoint": "editor", "started_at": r["gmt_create"] / 1000, "last_at": last, "state": "working" if now - last < 90 else "idle", "prompts": 0, "alive": True, "registered": True, "title": r["session_title"]})
    return out


# ---------------------------------------------------------------- other Macs over Tailscale

HOSTS_FILE = os.path.join(DISPATCH_DIR, "hosts.json")
REMOTE_DIR = os.path.join(DISPATCH_DIR, "remote")
_LOCAL_NAME = None


def local_host_name():
    global _LOCAL_NAME
    if _LOCAL_NAME is None:
        try:
            _LOCAL_NAME = subprocess.run(["scutil", "--get", "ComputerName"], capture_output=True, text=True, timeout=2).stdout.strip() or os.uname().nodename
        except Exception:
            _LOCAL_NAME = os.uname().nodename
    return _LOCAL_NAME


def hosts():
    """Other Macs that run the same dispatch checkout, reached over Tailscale by ssh.
    Edit ~/tasks/.dispatch/hosts.json to add one; an empty list turns the feature off."""
    try:
        return json.load(open(HOSTS_FILE))
    except Exception:
        default = [{"id": "mini", "name": "Mac mini", "ssh": "apple@100.118.80.86", "dispatch": "python3 ~/Projects/kanban/app/cli/dispatch.py"}]
        try:
            os.makedirs(DISPATCH_DIR, exist_ok=True)
            json.dump(default, open(HOSTS_FILE, "w"), ensure_ascii=False, indent=2)
        except Exception:
            pass
        return default


def _tag_host(rows, h):
    for r in rows or []:
        if isinstance(r, dict):
            r["host"], r["host_name"] = h["id"], h["name"]
    return rows or []


def remote_dispatch(h, args, ttl):
    """Run `dispatch <args> --json` on another host, cached for ttl seconds. Never blocks
    the caller for more than ~10s, and remembers an unreachable host for a minute so the
    app's 5-second presence polls stay cheap. Returns the stale cache (or None) on failure."""
    import shlex
    os.makedirs(REMOTE_DIR, exist_ok=True)
    key = re.sub(r"[^a-z0-9]+", "-", " ".join(args).lower()).strip("-")
    cache = os.path.join(REMOTE_DIR, f"{h['id']}--{key}.json")
    down = os.path.join(REMOTE_DIR, f"{h['id']}.down")
    now = time.time()

    def stale():
        try:
            return json.load(open(cache))
        except Exception:
            return None

    try:
        if now - os.stat(cache).st_mtime < ttl:
            return stale()
    except OSError:
        pass
    try:
        if now - os.stat(down).st_mtime < 60:
            return stale()
    except OSError:
        pass
    # The remote login shell is fish, so use `env` rather than FOO=bar prefixes.
    cmd = f"env BEADS_DIR=$HOME/tasks/.beads {h.get('dispatch', 'dispatch')} " + " ".join(shlex.quote(x) for x in args) + " --json"
    try:
        r = subprocess.run(["ssh", "-o", "ConnectTimeout=3", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", h["ssh"], cmd], capture_output=True, text=True, timeout=12)
        if r.returncode == 255:
            raise ConnectionError(r.stderr.strip()[:200])  # ssh itself failed: host unreachable
        if r.returncode != 0:
            return stale()  # the command failed there (old checkout, bad args): host is fine, don't mark it down
        s = r.stdout
        start = min(i for i in (s.find("["), s.find("{")) if i >= 0)
        data = json.loads(s[start:])
    except (ConnectionError, subprocess.TimeoutExpired):
        try:
            open(down, "w").close()
        except OSError:
            pass
        return stale()
    except Exception:
        return stale()
    try:
        tmp = cache + ".tmp"
        json.dump(data, open(tmp, "w"), ensure_ascii=False)
        os.replace(tmp, cache)
        if os.path.exists(down):
            os.remove(down)
    except OSError:
        pass
    return data


def tailscale_ip():
    for cmd in (["tailscale", "ip", "-4"], ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "ip", "-4"]):
        try:
            ip = subprocess.run(cmd, capture_output=True, text=True, timeout=3).stdout.strip().split("\n")[0]
            if ip.startswith("100."):
                return ip
        except Exception:
            pass
    try:
        m = re.search(r"inet (100\.\d+\.\d+\.\d+)", subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=3).stdout)
        return m.group(1) if m else ""
    except Exception:
        return ""


def port_open(ip, port, timeout=1.0):
    import socket
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except Exception:
        return False


def _app_present(*globs):
    for g in globs:
        if glob.glob(g):
            return True
    return False


def overlay_network():
    """Which private overlay this Mac is on, and its address there. Tailscale (and Headscale,
    same client) hand out 100.x; Netbird uses the same range; ZeroTier is a zt* interface."""
    ip = tailscale_ip()
    if ip:
        return {"kind": "tailscale", "ip": ip}
    try:
        o = subprocess.run(["netbird", "status", "--json"], capture_output=True, text=True, timeout=3).stdout
        m = re.search(r'"netbirdIp":\s*"([0-9.]+)', o)
        if m:
            return {"kind": "netbird", "ip": m.group(1)}
    except Exception:
        pass
    try:
        o = subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=3).stdout
        m = re.search(r"^(zt\w+|feth\d+|utun\d+):.*?\n\s+inet (\d+\.\d+\.\d+\.\d+)", o, re.S | re.M)
        if m and m.group(1).startswith("zt"):
            return {"kind": "zerotier", "ip": m.group(2)}
    except Exception:
        pass
    return {"kind": "", "ip": ""}


def lan_ip():
    try:
        o = subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=3).stdout
        m = re.search(r"inet (192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)", o)
        return m.group(1) if m else ""
    except Exception:
        return ""


def rustdesk_id():
    for p in (os.path.join(HOME, "Library", "Preferences", "com.carriez.RustDesk", "RustDesk.toml"),):
        try:
            m = re.search(r"^id\s*=\s*'?\"?([0-9]{6,12})", open(p).read(), re.M)
            if m:
                return m.group(1)
        except OSError:
            pass
    return ""


def detect_remote_backends():
    """What this Mac can be reached with. Dispatch never ships a video pipeline of its own;
    it detects the engines people already use — different ones in China and elsewhere —
    and recommends the first that works without extra setup."""
    ov = overlay_network()
    ip = ov["ip"] or lan_ip()
    b = {
        "overlay": ov,
        "lan_ip": lan_ip(),
        "screen_sharing": port_open("127.0.0.1", 5900, 0.5),
        "novnc_up": bool(ip) and port_open(ip, 6080, 0.5),
        "novnc": f"http://{ip}:6080/vnc.html?autoconnect=1&resize=scale" if ip else "",
        "vnc": f"vnc://{ip}" if ip else "",
        "rustdesk": _app_present("/Applications/RustDesk.app"),
        "rustdesk_id": rustdesk_id(),
        "sunshine": _app_present("/Applications/Sunshine.app", "/opt/homebrew/bin/sunshine", "/usr/local/bin/sunshine"),
        "sunshine_ui": f"https://{ip}:47990" if ip else "",
        "uu": _app_present("/Applications/*UU*远程*.app", "/Applications/UU Remote*.app", "/Applications/网易UU远程.app"),
    }
    # Recommendation, in the order that costs the user the least.
    if ov["kind"] and b["novnc_up"]:
        rec, why = "novnc", f"已在 {ov['kind']} 网里，浏览器直接开"
    elif ov["kind"] and b["screen_sharing"]:
        rec, why = "vnc", f"已在 {ov['kind']} 网里，屏幕共享已开；跑 novnc-setup.sh 就能手机看"
    elif b["rustdesk"]:
        rec, why = "rustdesk", "不用虚拟网，ID + 密码直连（国内外都好用，可自建中继）"
    elif b["sunshine"]:
        rec, why = "moonlight", "画质最高；手机装 Moonlight，配对后连"
    elif b["uu"]:
        rec, why = "uu", "已装网易UU远程，用它连（闭源，只能打开）"
    elif b["novnc_up"] or b["screen_sharing"]:
        rec, why = "novnc" if b["novnc_up"] else "vnc", "只能在同一局域网里用；出门要装 Tailscale/Netbird 或 RustDesk"
    else:
        rec, why = "", "没有可用的远程方式：装 Tailscale（国外）/ RustDesk（国内）之一，再开系统屏幕共享"
    b["recommend"], b["why"] = rec, why
    return b


def host_rows(local_only=False):
    """This Mac plus the others in hosts.json, each with the remote-desktop backends it
    actually has (detected on that machine) and a recommendation."""
    rows = []
    b = detect_remote_backends()
    ip = b["overlay"]["ip"] or b["lan_ip"]
    rows.append({"id": "local", "name": local_host_name(), "ip": ip, "ssh": "", "online": True, "local": True, **{k: v for k, v in b.items()}})
    if local_only:
        return rows
    for h in hosts():
        hip = h.get("ip") or (h.get("ssh", "").split("@")[-1])
        down = os.path.join(REMOTE_DIR, f"{h['id']}.down")
        try:
            recently_down = time.time() - os.stat(down).st_mtime < 60
        except OSError:
            recently_down = False
        online = (not recently_down) and port_open(hip, 22)
        row = {"id": h["id"], "name": h["name"], "ip": hip, "ssh": h.get("ssh", ""), "online": online, "local": False, "herdr_session": h.get("herdr_session", ""),
               "novnc": f"http://{hip}:6080/vnc.html?autoconnect=1&resize=scale", "novnc_up": online and port_open(hip, 6080), "vnc": f"vnc://{hip}",
               "screen_sharing": online and port_open(hip, 5900), "rustdesk": False, "rustdesk_id": "", "sunshine": False, "sunshine_ui": "", "uu": False, "overlay": {"kind": "", "ip": hip}, "recommend": "", "why": ""}
        if online:
            det = remote_dispatch(h, ["hosts", "--local"], 120)
            if isinstance(det, list) and det:
                d = det[0]
                for k in ("rustdesk", "rustdesk_id", "sunshine", "uu", "screen_sharing"):
                    row[k] = d.get(k, row[k])
                if isinstance(d.get("overlay"), dict) and d["overlay"].get("kind"):
                    row["overlay"] = d["overlay"]
                row["sunshine_ui"] = f"https://{hip}:47990" if d.get("sunshine") else ""
        if row["novnc_up"]:
            row["recommend"], row["why"] = "novnc", "浏览器直接开"
        elif row["screen_sharing"]:
            row["recommend"], row["why"] = "vnc", "屏幕共享已开；在那台上跑 novnc-setup.sh 就能手机看"
        elif row["rustdesk"]:
            row["recommend"], row["why"] = "rustdesk", "ID + 密码直连"
        elif row["sunshine"]:
            row["recommend"], row["why"] = "moonlight", "手机装 Moonlight 配对"
        elif not online:
            row["recommend"], row["why"] = "", "离线"
        else:
            row["recommend"], row["why"] = "", "那台机器上没有可用的远程方式"
        rows.append(row)
    return rows


# ---------------------------------------------------------------- hand work to another agent through Herdr

KIND_ACTOR = {"claude": "claude-code", "codex": "codex", "qodercli": "qoder", "opencode": "zcode", "gemini": "gemini", "cursor": "cursor", "kimi": "kimi", "amp": "amp"}
PANE_RE = re.compile(r"^w\d+:p\w+$")


def herdr_target_host(host):
    """None for this Mac, else the hosts.json entry (by id or name)."""
    if not host or host in ("local", "本机"):
        return None
    for h in hosts():
        if host in (h["id"], h["name"]):
            return h
    raise SystemExit(f"hosts.json 里没有叫 {host} 的机器")


def herdr(host, args, timeout=30, raw=False):
    """Run one herdr subcommand here or on another Mac (its headless session), returning the
    parsed JSON — {"result": …} or {"error": …} — or the raw text when raw=True."""
    import shlex
    if host is None:
        r = subprocess.run([HERDR] + args, capture_output=True, text=True, timeout=timeout)
    else:
        sess = host.get("herdr_session") or "main"
        remote = "env PATH=$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin herdr --session " + shlex.quote(sess) + " " + " ".join(shlex.quote(x) for x in args)
        r = subprocess.run(["ssh", "-o", "ConnectTimeout=3", "-o", "BatchMode=yes", host["ssh"], remote], capture_output=True, text=True, timeout=timeout + 15)
    if raw:
        return r.stdout
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"error": {"message": (r.stderr or r.stdout).strip()[:400] or f"herdr exit {r.returncode}"}}


def herdr_ok(d, what):
    if not isinstance(d, dict) or d.get("error"):
        msg = (d or {}).get("error", {}).get("message", str(d)) if isinstance(d, dict) else str(d)
        raise SystemExit(f"{what} 失败：{msg}")
    return d.get("result") or {}


def herdr_list_agents(host):
    return herdr_ok(herdr(host, ["agent", "list"]), "列会话").get("agents", [])


def resolve_agent(host, key):
    """key: pane id (w1:p3), agent name, tab title substring, or a task id (matched by the
    directory the task's sessions ran in)."""
    if PANE_RE.match(key):
        return key
    agents = herdr_list_agents(host)
    for a in agents:
        if a.get("name") == key or a.get("pane_id") == key or a.get("tab_id") == key:
            return a["pane_id"]
    low = key.lower()
    for a in agents:
        if low in (a.get("terminal_title_stripped") or a.get("terminal_title") or "").lower():
            return a["pane_id"]
    if re.match(r"^[a-z]+-[a-z0-9]{2,8}$", key) and host is None:
        for s in live_sessions():
            if s.get("herdr") and (s.get("current_task") == key or key in (s.get("claims") or [])):
                return s["herdr"]["pane_id"]
        refs = session_refs(load_index(), task_id=key)
        cwds = {(r["cwd"] or "").rstrip("/") for r in refs}
        for a in agents:
            if (a.get("cwd") or "").rstrip("/") in cwds:
                return a["pane_id"]
    raise SystemExit(f"找不到 Agent「{key}」；dispatch agent list 看看有哪些")


def agent_row(a):
    return {"pane_id": a.get("pane_id"), "tab_id": a.get("tab_id"), "agent": a.get("agent"), "name": a.get("name", ""), "status": a.get("agent_status"), "cwd": a.get("cwd"), "title": a.get("terminal_title_stripped") or a.get("terminal_title", ""), "focused": a.get("focused")}


def cmd_agent(a):
    host = herdr_target_host(a.host)
    where = host["name"] if host else local_host_name()
    if a.op == "list":
        rows = [dict(agent_row(x), host=where) for x in herdr_list_agents(host)]

        def text(rows):
            for r in rows:
                print(f"{r['pane_id']:<8} {r['agent']:<10} {r['status']:<8} {(r['cwd'] or '').replace(HOME, '~'):<40} {r['title']}")
            if not rows:
                print(f"{where} 的 Herdr 里没有 Agent")
        return out(rows, a.json, text)

    if a.op == "start":
        kind = a.kind
        actor = KIND_ACTOR.get(kind, kind)
        cwd = a.cwd or (os.getcwd() if host is None else "")
        if host is not None:
            remote_home = "/Users/" + host["ssh"].split("@")[0] if "@" in host.get("ssh", "") else ""
            cwd = (cwd or remote_home).replace("~", remote_home, 1) if remote_home else (cwd or "~")
        targs = ["tab", "create", "--cwd", cwd, "--focus"]
        if a.label:
            targs += ["--label", a.label]
        tab = herdr_ok(herdr(host, targs), "开标签")
        pane = tab.get("root_pane", {}).get("pane_id") or tab.get("pane_id")
        tab_id = tab.get("root_pane", {}).get("tab_id") or tab.get("tab_id")
        name = a.name or f"{kind}-{int(time.time()) % 100000}"
        sargs = ["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", "120000"]
        import shlex
        extra = shlex.split(a.extra) if a.extra else []
        if a.model:
            extra = ["--model", a.model] + extra
        if extra:
            sargs += ["--"] + extra
        # The new tab's shell needs a moment before it counts as "an available shell".
        started = None
        for attempt in range(8):
            d = herdr(host, sargs, timeout=150)
            if isinstance(d, dict) and (d.get("error") or {}).get("code") == "agent_pane_busy" and attempt < 7:
                time.sleep(1.5)
                continue
            started = herdr_ok(d, "起 Agent").get("agent", {})
            break
        me = os.environ.get("BEADS_ACTOR", "schaefer")
        if a.task:
            code, o, e = sh(["bd", "update", a.task, "--claim", "--json"], env={"BEADS_ACTOR": actor})
            note = f"{me} 通过 dispatch agent 派给 {actor}（Herdr {pane} @ {where}，目录 {cwd}）"
            sh(["bd", "comments", "add", a.task, note], env={"BEADS_ACTOR": me})
        res = {"host": where, "pane_id": pane, "tab_id": tab_id, "name": name, "kind": kind, "actor": actor, "cwd": cwd, "status": started.get("agent_status"), "task": a.task or "", "output": ""}
        if a.prompt:
            # Ready per Herdr is not yet ready for input; and prompts to an unfocused tab are dropped.
            time.sleep(2)
            if tab_id:
                herdr(host, ["tab", "focus", tab_id])
            pargs = ["agent", "prompt", pane, a.prompt]
            if a.wait:
                pargs += ["--wait", "--until", "done", "--until", "idle", "--until", "blocked", "--timeout", str(a.timeout)]
            d = herdr(host, pargs, timeout=a.timeout // 1000 + 20)
            if isinstance(d, dict) and d.get("error"):
                res["status"], res["warning"] = "stalled", (d["error"].get("message") or "")[:200] + "——看输出，可能在等你回答一个对话框（dispatch agent keys <pane> enter）"
            else:
                res["status"] = (d.get("result") or {}).get("agent", {}).get("agent_status")
            res["output"] = herdr(host, ["agent", "read", pane, "--lines", str(a.lines)], raw=True)

        def text(r):
            print(f"已在 {r['host']} 起了 {r['kind']}（{r['actor']}）· Herdr {r['pane_id']} · {r['cwd']}" + (f" · 认领 {r['task']}" if r["task"] else ""))
            if r["output"]:
                print(r["output"].rstrip())
            elif a.prompt:
                print(f"提示词已发，状态 {r['status']}；dispatch agent read {r['pane_id']}" + (f" --host {a.host}" if a.host else "") + " 看输出")
        return out(res, a.json, text)

    pane = resolve_agent(host, a.target)
    if a.op == "ask":
        info = herdr_ok(herdr(host, ["agent", "get", pane]), "查 Agent").get("agent", {})
        if info.get("tab_id"):
            herdr(host, ["tab", "focus", info["tab_id"]])  # prompts to an unfocused tab are dropped silently
        pargs = ["agent", "prompt", pane, a.text]
        if a.wait:
            pargs += ["--wait", "--until", "done", "--until", "idle", "--until", "blocked", "--timeout", str(a.timeout)]
        d = herdr(host, pargs, timeout=a.timeout // 1000 + 20)
        err = (d.get("error") or {}).get("message", "") if isinstance(d, dict) else str(d)
        status = "stalled" if err else (d.get("result") or {}).get("agent", {}).get("agent_status")
        res = {"host": where, "pane_id": pane, "status": status, "warning": err[:200], "output": herdr(host, ["agent", "read", pane, "--lines", str(a.lines)], raw=True)}
        return out(res, a.json, lambda x: print((x["output"].rstrip() + ("\n[!] " + x["warning"] if x["warning"] else "")) if x["output"] else f"已发，状态 {x['status']}"))
    if a.op == "keys":
        keys = [a.text] + list(a.more or []) if a.text else []
        if not keys:
            raise SystemExit("要给按键名，比如 enter、esc、down、y")
        herdr_ok(herdr(host, ["agent", "send-keys", pane] + keys), "发按键")
        time.sleep(1.5)
        return out({"host": where, "pane_id": pane, "keys": keys, "output": herdr(host, ["agent", "read", pane, "--lines", str(a.lines)], raw=True)}, a.json, lambda x: print(x["output"].rstrip()))
    if a.op == "read":
        txt = herdr(host, ["agent", "read", pane, "--lines", str(a.lines)], raw=True)
        return out({"host": where, "pane_id": pane, "output": txt}, a.json, lambda x: print(x["output"].rstrip()))
    if a.op == "wait":
        r = herdr_ok(herdr(host, ["agent", "wait", pane, "--timeout", str(a.timeout)], timeout=a.timeout // 1000 + 20), "等待").get("agent", {})
        return out({"host": where, "pane_id": pane, "status": r.get("agent_status")}, a.json, lambda x: print(f"{x['pane_id']} 现在 {x['status']}"))
    if a.op == "close":
        info = herdr_ok(herdr(host, ["agent", "get", pane]), "查 Agent").get("agent", {})
        herdr_ok(herdr(host, ["tab", "close", info.get("tab_id", "")]), "关标签")
        return out({"closed": info.get("tab_id")}, a.json, lambda x: print(f"已关 {x['closed']}"))


def cmd_serve(a):
    import runpy
    sys.argv = ["serve"] + (["url"] if a.what == "url" else [])
    runpy.run_path(os.path.join(os.path.dirname(os.path.abspath(__file__)), "serve.py"), run_name="__main__")


def cmd_hosts(a):
    rows = host_rows(local_only=getattr(a, "local", False))

    def text(rows):
        for r in rows:
            have = [k for k in ("novnc_up", "screen_sharing", "rustdesk", "sunshine", "uu") if r.get(k)]
            ov = (r.get("overlay") or {}).get("kind") or "-"
            print(f"{r['name']:<12} {r['ip']:<16} {'在线' if r['online'] else '离线'}  网:{ov:<10} 有:{','.join(have) or '无':<36} 推荐:{r.get('recommend') or '无'}  {r.get('why', '')}")
    out(rows, a.json, text)


def _only_theirs(rows):
    """A host answers with its own sessions only; anything it merged from *other* hosts
    (including ours, mirrored back) is dropped, otherwise two Macs amplify each other."""
    return [r for r in rows or [] if isinstance(r, dict) and not r.get("remote") and r.get("host") in (None, "local")]


def remote_sessions():
    out = []
    for h in hosts():
        for s in _tag_host(_only_theirs(remote_dispatch(h, ["sessions", "--local"], 20)), h):
            s["remote"] = True
            out.append(s)
    return out


def remote_refs():
    out = []
    for h in hosts():
        for r in _tag_host(_only_theirs(remote_dispatch(h, ["list", "--cached", "--limit", "200", "--local"], 120)), h):
            r["remote"] = True
            r["resume_cmd"] = f"ssh -t {h['ssh']} {json.dumps(r.get('resume_cmd', ''))}"
            r["path"] = f"remote:{h['id']}:{r.get('path', '')}"
            out.append(r)
    return out


def live_sessions(local_only=False):
    table = ps_table()
    sessions = zcode_live(table)
    seen = set()
    seen_sids = set()
    for p in glob.glob(os.path.join(SESS_DIR, "*.json")):
        try:
            r = json.load(open(p))
        except Exception:
            continue
        pid = r.get("agent_pid")
        if pid and pid not in table:
            continue
        r["alive"] = True
        r["registered"] = True
        seen.add(pid)
        seen_sids.add((r.get("agent"), r.get("session_id")))
        sessions.append(r)
    for s in qoder_live(table):
        if (s["agent"], s["session_id"]) not in seen_sids:
            sessions.append(s)
    for pid, (ppid, comm) in table.items():
        base = os.path.basename(comm).lstrip("-")
        if base in ("claude", "codex") and pid not in seen:
            sessions.append({"agent": "claude-code" if base == "claude" else "codex", "session_id": f"pid-{pid}", "agent_pid": pid, "cwd": "", "project": "", "source_kind": "unknown", "source_app": "未登记", "state": "unknown", "alive": True, "registered": False, "started_at": 0, "last_at": 0})
    # Herdr knows tab titles and its own working/idle judgement; match by cwd.
    for a in herdr_agents():
        cands = [s for s in sessions if s.get("cwd") == a.get("cwd") and s["agent"].startswith(a.get("agent", "claude"))]
        cands = [s for s in cands if "herdr" not in s] or cands
        if cands:
            s = cands[0]
            s["herdr"] = {"pane_id": a.get("pane_id"), "tab_id": a.get("tab_id"), "title": a.get("terminal_title_stripped"), "status": a.get("agent_status"), "focused": a.get("focused")}
    for s in sessions:
        s.setdefault("host", "local")
        s.setdefault("host_name", local_host_name())
    if not local_only:
        sessions.extend(remote_sessions())
    sessions.sort(key=lambda s: (s.get("state") != "working", -(s.get("last_at") or 0)))
    return sessions


def cmd_sessions(a):
    s = live_sessions(local_only=getattr(a, "local", False))

    def text(s):
        if not s:
            print("没有检测到会话")
        for x in s:
            h = x.get("herdr") or {}
            st = {"working": "在跑", "idle": "等你", "unknown": "未登记"}.get(x.get("state"), x.get("state"))
            print(f"{x['agent']:<12} {st:<4} {x.get('project') or '?':<18} {x.get('source_app', ''):<14} {ago(x.get('last_at'))!s:<5} {x['session_id']}" + (f"  [Herdr {h.get('tab_id')}] {h.get('title', '')}" if h else ""))
    out(s, a.json, text)


# ---------------------------------------------------------------- transcript index

def task_prefix():
    try:
        return json.load(open(os.path.join(BEADS_DIR, "metadata.json"))).get("dolt_database", "task")
    except Exception:
        return "task"


def load_index():
    try:
        return json.load(open(INDEX_FILE))
    except Exception:
        return {}


def save_index(idx):
    os.makedirs(DISPATCH_DIR, exist_ok=True)
    tmp = INDEX_FILE + ".tmp"
    json.dump(idx, open(tmp, "w"), ensure_ascii=False)
    os.replace(tmp, INDEX_FILE)


def first_prompt_of(agent, buf):
    """The user's opening message — what this conversation was about, in their words."""
    for line in buf.split("\n", 400)[:400]:
        if not line.startswith("{"):
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        if agent == "claude-code":
            if d.get("type") != "user" or d.get("isSidechain"):
                continue
            c = (d.get("message") or {}).get("content")
            txt = c if isinstance(c, str) else "\n".join(b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text")
        elif agent == "pi":
            m = d.get("message") or {}
            if d.get("type") != "message" or m.get("role") != "user":
                continue
            c = m.get("content")
            txt = c if isinstance(c, str) else "\n".join(b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text")
        else:
            p = d.get("payload") or {}
            if d.get("type") != "response_item" or p.get("type") != "message" or p.get("role") != "user":
                continue
            txt = "\n".join(b.get("text", "") for b in p.get("content") or [] if isinstance(b, dict) and b.get("type") in ("input_text", "text"))
        txt = re.sub(r"<[^>]{1,40}>[\s\S]*?</[^>]{1,40}>", "", txt).strip()
        if txt and not txt.startswith("<") and not txt.startswith("[Image"):
            return txt[:240]
    return ""


STATS_V = 1  # bump to force a full re-parse when the per-session stats shape changes


def stats_fields():
    return {"tokens": {"in": 0, "out": 0, "cr": 0, "cw": 0, "think": 0}, "models": {}, "days": {}, "hours": {}, "skills": {}, "subs": {}, "last_req": "", "codex_prev": 0}


def bump_time(e, dt, msgs=0, tok=0, parts=None):
    """Attribute activity to the local day and to the weekday×hour bucket."""
    if dt is None:
        return
    day = dt.strftime("%Y-%m-%d")
    d = e["days"].setdefault(day, [0, 0, 0, 0, 0, 0])  # msgs, tokens, in, out, cache_read, cache_write
    d[0] += msgs
    d[1] += tok
    if parts:
        for i, v in enumerate(parts):
            d[2 + i] += v
    if msgs:
        k = f"{dt.weekday()}-{dt.hour}"
        e["hours"][k] = e["hours"].get(k, 0) + msgs


def local_dt(ts):
    from datetime import datetime as _dt
    try:
        return _dt.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
    except Exception:
        return None


def local_dt_ms(ms):
    from datetime import datetime as _dt
    try:
        return _dt.fromtimestamp(ms / 1000)
    except Exception:
        return None


def parse_claude_stats(e, buf, re_ts):
    """Token usage (deduped by requestId: one API response is logged once per content block),
    model, skills (Skill tool + slash commands), subagents (Task/Agent tool), activity by time."""
    for line in buf.split("\n"):
        if not line.startswith("{"):
            continue
        if '"type":"assistant"' in line:
            try:
                d = json.loads(line)
            except Exception:
                continue
            msg = d.get("message") or {}
            rid = d.get("requestId") or d.get("uuid") or ""
            u = msg.get("usage") or {}
            if u and rid != e["last_req"]:
                e["last_req"] = rid
                i, o = u.get("input_tokens", 0) or 0, u.get("output_tokens", 0) or 0
                cr, cw = u.get("cache_read_input_tokens", 0) or 0, u.get("cache_creation_input_tokens", 0) or 0
                th = (u.get("output_tokens_details") or {}).get("thinking_tokens", 0) or 0
                T = e["tokens"]
                T["in"] += i; T["out"] += o; T["cr"] += cr; T["cw"] += cw; T["think"] += th
                m = msg.get("model")
                if m:
                    e["models"][m] = e["models"].get(m, 0) + 1
                bump_time(e, local_dt(d.get("timestamp", "")), 1, i + o + cr + cw, (i, o, cr, cw))
            for b in msg.get("content") or []:
                if not isinstance(b, dict) or b.get("type") != "tool_use":
                    continue
                inp = b.get("input") or {}
                if b.get("name") == "Skill" and inp.get("skill"):
                    e["skills"][inp["skill"]] = e["skills"].get(inp["skill"], 0) + 1
                elif b.get("name") in ("Task", "Agent") and inp.get("subagent_type"):
                    e["subs"][inp["subagent_type"]] = e["subs"].get(inp["subagent_type"], 0) + 1
        elif '"type":"user"' in line and '"tool_use_id"' not in line:
            m = re_ts.search(line)
            if m:
                bump_time(e, local_dt(m.group(1)), 1, 0)
    for m in re.finditer(r"<command-name>/?([^<\s]{1,60})</command-name>", buf):
        k = "/" + m.group(1)
        e["skills"][k] = e["skills"].get(k, 0) + 1


def parse_pi_stats(e, buf, re_ts):
    """pi session files: {"type":"message","message":{role, content, provider, model, usage{input,output,cacheRead,cacheWrite}}}."""
    for line in buf.split("\n"):
        if not line.startswith("{") or '"type":"message"' not in line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        m = d.get("message") or {}
        ts = d.get("timestamp", "")
        if m.get("role") == "assistant":
            u = m.get("usage") or {}
            i, o, cr, cw = (u.get("input", 0) or 0), (u.get("output", 0) or 0), (u.get("cacheRead", 0) or 0), (u.get("cacheWrite", 0) or 0)
            T = e["tokens"]; T["in"] += i; T["out"] += o; T["cr"] += cr; T["cw"] += cw
            if m.get("model"):
                e["models"][m["model"]] = e["models"].get(m["model"], 0) + 1
            bump_time(e, local_dt(ts), 1, i + o + cr + cw, (i, o, cr, cw))
        elif m.get("role") == "user":
            bump_time(e, local_dt(ts), 1, 0)


def parse_codex_stats(e, buf, re_ts):
    """Codex logs a cumulative total_token_usage per turn; tokens = last total, activity = the deltas."""
    for line in buf.split("\n"):
        if not line.startswith("{"):
            continue
        if '"token_count"' in line and '"total_token_usage"' in line:
            try:
                d = json.loads(line)
            except Exception:
                continue
            tu = ((d.get("payload") or {}).get("info") or {}).get("total_token_usage") or {}
            if not tu:
                continue
            total = tu.get("total_tokens", 0) or 0
            delta = max(0, total - e["codex_prev"])
            e["codex_prev"] = total
            cached = tu.get("cached_input_tokens", 0) or 0
            e["tokens"] = {"in": max(0, (tu.get("input_tokens", 0) or 0) - cached), "out": tu.get("output_tokens", 0) or 0, "cr": cached, "cw": tu.get("cache_write_input_tokens", 0) or 0, "think": tu.get("reasoning_output_tokens", 0) or 0}
            bump_time(e, local_dt(d.get("timestamp", "")), 0, delta, (0, 0, 0, 0))
        elif '"turn_context"' in line:
            m = re.search(r'"model":"([^"]+)"', line)
            if m:
                e["models"][m.group(1)] = e["models"].get(m.group(1), 0) + 1
        elif '"type":"response_item"' in line and '"type":"message"' in line and ('"role":"user"' in line or '"role":"assistant"' in line):
            m = re_ts.search(line)
            if m:
                bump_time(e, local_dt(m.group(1)), 1, 0)


def parse_zcode_stats(e, sid):
    for m in zcode_query("select data, time_created from message where session_id=?", (sid,)):
        try:
            d = json.loads(m["data"])
        except Exception:
            continue
        tok = 0
        if d.get("role") == "assistant":
            tk = d.get("tokens") or {}
            c = tk.get("cache") or {}
            i, o, cr, cw, th = tk.get("input", 0) or 0, tk.get("output", 0) or 0, c.get("read", 0) or 0, c.get("write", 0) or 0, tk.get("reasoning", 0) or 0
            T = e["tokens"]
            T["in"] += i; T["out"] += o; T["cr"] += cr; T["cw"] += cw; T["think"] += th
            tok = i + o + cr + cw
            mid = d.get("modelID")
            if mid:
                e["models"][mid] = e["models"].get(mid, 0) + 1
            bump_time(e, local_dt_ms(m["time_created"]), 1, tok, (i, o, cr, cw))
        else:
            bump_time(e, local_dt_ms(m["time_created"]), 1, 0)


def refresh_index():
    """Incrementally scan Claude Code / Codex transcripts for task ids, titles, cwd."""
    prefix = task_prefix()
    re_task = re.compile(r"\b" + re.escape(prefix) + r"-[a-z0-9]{2,8}\b")
    re_cwd = re.compile(r'"cwd":"([^"]+)"')
    re_title = re.compile(r'"aiTitle":"((?:[^"\\]|\\.)*)"')
    re_claim = re.compile(r"bd update (" + re.escape(prefix) + r"-[a-z0-9]{2,8}) --claim")
    re_entry = re.compile(r'"entrypoint":"([^"]+)"')
    re_branch = re.compile(r'"gitBranch":"([^"]*)"')
    re_ts = re.compile(r'"timestamp":"([^"]+)"')
    files = []
    for p in glob.glob(os.path.join(HOME, ".claude", "projects", "**", "*.jsonl"), recursive=True):
        files.append((p, "claude-code"))
    for p in glob.glob(os.path.join(HOME, ".codex", "sessions", "**", "*.jsonl"), recursive=True):
        files.append((p, "codex"))
    for p in glob.glob(os.path.join(HOME, ".pi", "agent", "sessions", "*", "*.jsonl")):
        files.append((p, "pi"))
    idx = load_index()
    seen = set()
    for path, agent in files:
        seen.add(path)
        try:
            st = os.stat(path)
        except OSError:
            continue
        e = idx.get(path) or {"agent": agent, "session_id": "", "cwd": "", "title": "", "mtime": 0, "size": 0, "off": 0, "tasks": {}, "claims": [], "subagent": "/subagents/" in path, "entrypoint": "", "branch": "", "first_ts": "", "last_ts": "", "user_msgs": 0, "assistant_msgs": 0, "tools": {}, "first_prompt": ""}
        for k, v in (("entrypoint", ""), ("branch", ""), ("first_ts", ""), ("last_ts", ""), ("user_msgs", 0), ("assistant_msgs", 0), ("tools", {}), ("first_prompt", "")):
            e.setdefault(k, v)
        if e.get("stats_v") != STATS_V:
            # Shape changed: re-read the whole file once so the counters start from zero.
            e.update(off=0, mtime=0, tasks={}, claims=[], user_msgs=0, assistant_msgs=0, tools={}, stats_v=STATS_V, **stats_fields())
        if e["mtime"] == st.st_mtime and e["size"] == st.st_size:
            idx[path] = e
            continue
        if st.st_size < e["off"]:
            e.update(off=0, tasks={}, claims=[], user_msgs=0, assistant_msgs=0, tools={}, **stats_fields())
        with open(path, "rb") as f:
            f.seek(e["off"])
            buf = f.read().decode("utf-8", "replace")
        if not e["session_id"]:
            if agent == "claude-code":
                e["session_id"] = os.path.splitext(os.path.basename(path))[0]
                if e["subagent"]:
                    e["parent"] = path.split("/subagents/")[0].rsplit("/", 1)[-1]
            elif agent == "pi":
                # <timestamp>_<id>.jsonl; scripted runs (poker bots etc.) use custom ids, not UUIDs — hide them like subagents
                b = os.path.splitext(os.path.basename(path))[0]
                e["session_id"] = b.split("_", 1)[1] if "_" in b else b
                e["subagent"] = not re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-", e["session_id"])
                e["entrypoint"] = "cli"
            else:
                first = buf.split("\n", 1)[0]
                try:
                    d = json.loads(first)
                    p = d.get("payload", d)
                    e["session_id"] = p.get("id", "")
                    e["cwd"] = p.get("cwd", "")
                except Exception:
                    pass
        if not e["cwd"]:
            m = re_cwd.search(buf)
            if m:
                e["cwd"] = m.group(1)
        for m in re_title.finditer(buf):
            e["title"] = json.loads('"' + m.group(1) + '"')
        for m in re_task.finditer(buf):
            e["tasks"][m.group(0)] = e["tasks"].get(m.group(0), 0) + 1
        for m in re_claim.finditer(buf):
            e["claims"].append(m.group(1))
        if not e["entrypoint"]:
            m = re_entry.search(buf)
            if m:
                e["entrypoint"] = m.group(1)
        if not e["first_prompt"]:
            e["first_prompt"] = first_prompt_of(agent, buf)
        if not e["branch"]:
            m = re_branch.search(buf)
            if m:
                e["branch"] = m.group(1)
        tss = re_ts.findall(buf)
        if tss:
            if not e["first_ts"]:
                e["first_ts"] = tss[0]
            e["last_ts"] = tss[-1]
        if agent == "pi":
            e["user_msgs"] += len(re.findall(r'"type":"message"[^\n]{0,200}?"role":"user"', buf))
            e["assistant_msgs"] += len(re.findall(r'"type":"message"[^\n]{0,200}?"role":"assistant"', buf))
            for m in re.finditer(r'"type":"toolCall"[^}]*?"name":"([^"]+)"', buf):
                e["tools"][m.group(1)] = e["tools"].get(m.group(1), 0) + 1
        elif agent == "codex":
            # CLI rollouts carry event_msg user_message; the desktop app only has response_item messages.
            e["user_msgs"] += len(re.findall(r'"role":"user","content":\[\{"type":"input_text","text":"(?!<)', buf))
            e["assistant_msgs"] += buf.count('"role":"assistant"')
            for m in re.finditer(r'"type":"function_call","name":"([^"]+)"', buf):
                e["tools"][m.group(1)] = e["tools"].get(m.group(1), 0) + 1
        else:
            e["user_msgs"] += buf.count('"type":"user"')
            e["assistant_msgs"] += buf.count('"type":"assistant"')
        for m in re.finditer(r'"type":"tool_use","id":"[^"]+","name":"([^"]+)"', buf):
            e["tools"][m.group(1)] = e["tools"].get(m.group(1), 0) + 1
        (parse_codex_stats if agent == "codex" else parse_pi_stats if agent == "pi" else parse_claude_stats)(e, buf, re_ts)
        e["off"], e["mtime"], e["size"] = st.st_size, st.st_mtime, st.st_size
        idx[path] = e
    # ZCode sessions live in SQLite, not files; key them as zcode:<id>.
    for r in zcode_query("select id, parent_id, directory, title, time_created, time_updated from session where parent_id is null"):
        key = "zcode:" + r["id"]
        seen.add(key)
        mtime = r["time_updated"] / 1000
        e = idx.get(key)
        if e and e.get("mtime") == mtime and e.get("stats_v") == STATS_V:
            continue
        e = {"agent": "zcode", "session_id": r["id"], "cwd": r["directory"], "title": r["title"], "mtime": mtime, "size": 0, "off": 0, "tasks": {}, "claims": [], "subagent": False, "entrypoint": "desktop", "branch": "", "first_ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r["time_created"] / 1000)), "last_ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(mtime)), "user_msgs": 0, "assistant_msgs": 0, "tools": {}, "first_prompt": "", "stats_v": STATS_V, **stats_fields()}
        parse_zcode_stats(e, r["id"])
        fp = zcode_query("select p.data from part p join message m on m.id=p.message_id where p.session_id=? and json_extract(m.data,'$.role')='user' and json_extract(p.data,'$.type')='text' order by p.time_created limit 1", (r["id"],))
        if fp:
            try:
                e["first_prompt"] = (json.loads(fp[0]["data"]).get("text") or "").strip()[:240]
            except Exception:
                pass
        for m in zcode_query("select json_extract(data,'$.role') role, count(*) n from message where session_id=? group by role", (r["id"],)):
            if m["role"] == "user":
                e["user_msgs"] = m["n"]
            elif m["role"] == "assistant":
                e["assistant_msgs"] = m["n"]
        for t in zcode_query("select json_extract(data,'$.tool') tool, count(*) n from part where session_id=? and json_extract(data,'$.type')='tool' group by tool", (r["id"],)):
            if t["tool"]:
                e["tools"][t["tool"]] = t["n"]
        blob = "\n".join(p["data"] for p in zcode_query("select data from part where session_id=? and json_extract(data,'$.type') in ('text','tool')", (r["id"],)))
        for m in re_task.finditer(blob):
            e["tasks"][m.group(0)] = e["tasks"].get(m.group(0), 0) + 1
        for m in re_claim.finditer(blob):
            e["claims"].append(m.group(1))
        e["size"] = len(blob)
        idx[key] = e
    index_qoder(idx, seen, re_task, re_claim)
    for p in list(idx):
        if p not in seen:
            del idx[p]
    save_index(idx)
    return idx


def _tool_summary(inp):
    if not isinstance(inp, dict):
        return str(inp or "")[:200]
    for k in ("command", "file_path", "filePath", "path", "query", "pattern", "description", "url", "prompt"):
        if inp.get(k):
            return str(inp[k])[:200]
    return ""


def _tool_file_change(name, inp, ts, files):
    """Edit/Write-style tool inputs, whatever the agent calls its tools."""
    if not isinstance(inp, dict):
        return
    fp = inp.get("file_path") or inp.get("filePath") or inp.get("path")
    if not fp:
        return
    n = name.lower()
    if "old_string" in inp or "oldString" in inp:
        files.setdefault(fp, []).append({"kind": "edit", "old": inp.get("old_string") or inp.get("oldString") or "", "new": inp.get("new_string") or inp.get("newString") or "", "ts": ts})
    elif "content" in inp and any(w in n for w in ("write", "create", "save")):
        files.setdefault(fp, []).append({"kind": "write", "old": "", "new": inp.get("content") or "", "ts": ts})


def index_qoder(idx, seen, re_task, re_claim):
    """Qoder desktop: chat_sessions + chat_session_messages (plain JSON payloads).
    Qoder IDE: chat_session + chat_message; message text is encrypted at rest, but titles,
    token_info, tool calls (name + parameters) and expert sub-sessions are readable."""
    for r in sqlite_rows(QODER_APP_DB, "select session_id, title, cwd, model, git_branch, created_at, updated_at from chat_sessions where deleted_at is null"):
        key = "qoder:" + r["session_id"]
        seen.add(key)
        mtime = (r["updated_at"] or 0) / 1000
        e = idx.get(key)
        if e and e.get("mtime") == mtime and e.get("stats_v") == STATS_V:
            continue
        e = {"agent": "qoder", "session_id": r["session_id"], "cwd": r["cwd"] or "", "title": r["title"] or "", "mtime": mtime, "size": 0, "off": 0, "tasks": {}, "claims": [], "subagent": False, "entrypoint": "desktop", "branch": r["git_branch"] or "", "first_ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime((r["created_at"] or 0) / 1000)), "last_ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(mtime)), "user_msgs": 0, "assistant_msgs": 0, "tools": {}, "first_prompt": "", "stats_v": STATS_V, **stats_fields()}
        blob = []
        for m in sqlite_rows(QODER_APP_DB, "select payload_json, created_at from chat_session_messages where session_id = ? order by sequence", (r["session_id"],)):
            try:
                d = json.loads(m["payload_json"])
            except Exception:
                continue
            role = d.get("role")
            dt = local_dt(d.get("timestamp") or "") or local_dt_ms(m["created_at"])
            txt = d.get("text") or ""
            if role == "user":
                e["user_msgs"] += 1
                blob.append(txt)
                if not e["first_prompt"] and txt.strip():
                    e["first_prompt"] = txt.strip()[:240]
                bump_time(e, dt, 1, 0)
            elif role == "assistant":
                e["assistant_msgs"] += 1
                blob.append(txt)
                for t in d.get("tools") or []:
                    n = t.get("name") or ""
                    e["tools"][n] = e["tools"].get(n, 0) + 1
                    inp = t.get("input")
                    if isinstance(inp, dict):
                        blob.append(json.dumps(inp, ensure_ascii=False)[:2000])
                        if n == "Skill" and inp.get("skill"):
                            e["skills"][inp["skill"]] = e["skills"].get(inp["skill"], 0) + 1
                        elif n in ("Task", "Agent") and inp.get("subagent_type"):
                            e["subs"][inp["subagent_type"]] = e["subs"].get(inp["subagent_type"], 0) + 1
                tm = d.get("turnMetrics") or {}
                tm = tm if isinstance(tm, dict) else {}
                i = tm.get("inputTokens") or tm.get("input_tokens") or 0
                o = tm.get("outputTokens") or tm.get("output_tokens") or 0
                cr = tm.get("cacheReadTokens") or tm.get("cache_read_input_tokens") or 0
                cw = tm.get("cacheWriteTokens") or tm.get("cache_creation_input_tokens") or 0
                T = e["tokens"]
                T["in"] += i; T["out"] += o; T["cr"] += cr; T["cw"] += cw
                if r["model"]:
                    e["models"][r["model"]] = e["models"].get(r["model"], 0) + 1
                bump_time(e, dt, 1, i + o + cr + cw, (i, o, cr, cw))
        text = "\n".join(blob)
        for m in re_task.finditer(text):
            e["tasks"][m.group(0)] = e["tasks"].get(m.group(0), 0) + 1
        for m in re_claim.finditer(text):
            e["claims"].append(m.group(1))
        e["size"] = len(text)
        idx[key] = e

    for r in sqlite_rows(QODER_IDE_DB, "select session_id, session_title, project_uri, project_name, gmt_create, gmt_modified from chat_session where parent_session_id = '' or parent_session_id is null"):
        key = "qoder-ide:" + r["session_id"]
        seen.add(key)
        mtime = (r["gmt_modified"] or 0) / 1000
        e = idx.get(key)
        if e and e.get("mtime") == mtime and e.get("stats_v") == STATS_V:
            continue
        title = (r["session_title"] or "").strip()
        e = {"agent": "qoder-ide", "session_id": r["session_id"], "cwd": r["project_uri"] or "", "title": title.split("\n", 1)[0][:120], "mtime": mtime, "size": 0, "off": 0, "tasks": {}, "claims": [], "subagent": False, "entrypoint": "editor", "branch": "", "first_ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime((r["gmt_create"] or 0) / 1000)), "last_ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(mtime)), "user_msgs": 0, "assistant_msgs": 0, "tools": {}, "first_prompt": title[:240], "stats_v": STATS_V, **stats_fields()}
        blob = [title]
        for m in sqlite_rows(QODER_IDE_DB, "select role, token_info, model_info, tool_result, gmt_create from chat_message where session_id = ? order by gmt_create", (r["session_id"],)):
            dt = local_dt_ms(m["gmt_create"])
            role = m["role"]
            if role == "user":
                e["user_msgs"] += 1
                bump_time(e, dt, 1, 0)
            elif role == "assistant":
                e["assistant_msgs"] += 1
                try:
                    ti = json.loads(m["token_info"] or "{}")
                    mi = json.loads(m["model_info"] or "{}")
                except Exception:
                    ti, mi = {}, {}
                p, c, cached = ti.get("prompt_tokens", 0) or 0, ti.get("completion_tokens", 0) or 0, ti.get("cached_tokens", 0) or 0
                i, cr = max(0, p - cached), cached
                T = e["tokens"]
                T["in"] += i; T["out"] += c; T["cr"] += cr
                mk = mi.get("model_key") or mi.get("model")
                if mk:
                    e["models"][mk] = e["models"].get(mk, 0) + 1
                bump_time(e, dt, 1, i + c + cr, (i, c, cr, 0))
            elif role == "tool":
                try:
                    tr = json.loads(m["tool_result"] or "{}")
                except Exception:
                    tr = {}
                n = tr.get("toolCallName") or ""
                if n:
                    e["tools"][n] = e["tools"].get(n, 0) + 1
                params = tr.get("parameters")
                if params:
                    blob.append(params if isinstance(params, str) else json.dumps(params, ensure_ascii=False)[:2000])
        for c in sqlite_rows(QODER_IDE_DB, "select extra from chat_session where parent_session_id = ?", (r["session_id"],)):
            try:
                t = json.loads(c["extra"] or "{}").get("subAgentType") or "子会话"
            except Exception:
                t = "子会话"
            e["subs"][t] = e["subs"].get(t, 0) + 1
        text = "\n".join(blob)
        for m in re_task.finditer(text):
            e["tasks"][m.group(0)] = e["tasks"].get(m.group(0), 0) + 1
        for m in re_claim.finditer(text):
            e["claims"].append(m.group(1))
        e["size"] = len(text)
        idx[key] = e


def resume_command(agent, sid, cwd):
    if agent == "zcode":
        # ZCode is a desktop app without a resume CLI; the session id identifies it inside the app.
        return f"open -a ZCode  # 会话 {sid}"
    if agent in QODER_APPS:
        return f"open -a '{QODER_APPS[agent][1]}'  # 会话 {sid}"
    cd = f"cd '{cwd.replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}' && " if cwd else ""
    return f"{cd}{'codex resume' if agent == 'codex' else 'pi --session' if agent == 'pi' else 'claude --resume'} {sid}"


def subagents_of(path):
    """Claude Code keeps subagent transcripts next to the parent: <sid>/subagents/agent-<id>.{jsonl,meta.json}.
    ZCode records them as child sessions (session.parent_id) plus session_task_link metadata."""
    if path.startswith("zcode:"):
        sid = path[6:]
        rows = zcode_query("select s.id, s.title, s.time_updated, s.summary_files, l.agent_type, l.label, l.depth from session s left join session_task_link l on l.child_session_id = s.id where s.parent_id = ? order by s.time_created", (sid,))
        return [{"agent_id": r["id"], "type": r["agent_type"] or "子会话", "description": r["label"] or r["title"], "tool_use_id": "", "depth": r["depth"] or 1, "size": 0, "last_at": r["time_updated"] / 1000, "path": "zcode:" + r["id"]} for r in rows]
    if path.startswith("qoder-ide:"):
        # Experts mode spawns child sessions; extra_json names the expert (subAgentName/Role/Type).
        res = []
        for r in sqlite_rows(QODER_IDE_DB, "select session_id, session_title, gmt_modified, extra from chat_session where parent_session_id = ? order by gmt_create", (path[10:],)):
            try:
                x = json.loads(r["extra"] or "{}")
            except Exception:
                x = {}
            who = " · ".join(v for v in (x.get("subAgentName"), x.get("subAgentRole")) if v)
            res.append({"agent_id": r["session_id"], "type": x.get("subAgentType") or "子会话", "description": (who + "：" if who else "") + (r["session_title"] or "")[:160], "tool_use_id": "", "depth": 1, "size": 0, "last_at": r["gmt_modified"] / 1000, "path": "qoder-ide:" + r["session_id"]})
        return res
    if path.startswith("qoder:"):
        return []
    base = os.path.splitext(path)[0]
    res = []
    for meta in sorted(glob.glob(os.path.join(base, "subagents", "*.meta.json"))):
        try:
            m = json.load(open(meta))
        except Exception:
            m = {}
        jl = meta.replace(".meta.json", ".jsonl")
        aid = os.path.basename(meta).replace(".meta.json", "").replace("agent-", "")
        st = os.stat(jl) if os.path.exists(jl) else None
        res.append({"agent_id": aid, "type": m.get("agentType", ""), "description": m.get("description", ""), "tool_use_id": m.get("toolUseId", ""), "depth": m.get("spawnDepth", 1), "size": st.st_size if st else 0, "last_at": st.st_mtime if st else 0, "path": jl})
    return res


def ref_of(path, e, task_id=None):
    return {"agent": e["agent"], "session_id": e["session_id"], "cwd": e["cwd"], "project": os.path.basename(e["cwd"].rstrip("/")), "title": e.get("title", ""), "first_prompt": e.get("first_prompt", ""), "last_at": e["mtime"], "first_ts": e.get("first_ts", ""), "last_ts": e.get("last_ts", ""), "entrypoint": e.get("entrypoint", ""), "branch": e.get("branch", ""), "user_msgs": e.get("user_msgs", 0), "assistant_msgs": e.get("assistant_msgs", 0), "tools": e.get("tools", {}), "tasks": e.get("tasks", {}), "mentions": e["tasks"].get(task_id, 0) if task_id else sum(e["tasks"].values()), "current_task": (e.get("claims") or [None])[-1], "resume_cmd": resume_command(e["agent"], e["session_id"], e["cwd"]), "path": path, "size": e.get("size", 0), "subagents": subagents_of(path) if e["agent"] in ("claude-code", "zcode", "qoder-ide") else []}


_KNOWN_IDS = None


def known_task_ids():
    """The regex also matches English like 'task-board'; keep only ids that exist on the board."""
    global _KNOWN_IDS
    if _KNOWN_IDS is None:
        try:
            code, o, _ = sh(["bd", "list", "--all", "-n", "0", "--json"], timeout=15)
            _KNOWN_IDS = {i["id"] for i in json.loads(o[o.find("["):])} if code == 0 else set()
        except Exception:
            _KNOWN_IDS = set()
    return _KNOWN_IDS


def session_refs(idx, task_id=None, session_id=None):
    refs = []
    known = known_task_ids()
    for path, e in idx.items():
        if not e.get("session_id") or e.get("subagent"):
            continue
        if task_id and task_id not in e["tasks"]:
            continue
        if session_id and not e["session_id"].startswith(session_id):
            continue
        if known:
            e = dict(e, tasks={k: v for k, v in e["tasks"].items() if k in known}, claims=[c for c in e.get("claims", []) if c in known])
        refs.append(ref_of(path, e, task_id))
    refs.sort(key=lambda r: -r["last_at"])
    return refs


def cmd_index(a):
    idx = refresh_index()
    n = len([1 for e in idx.values() if not e.get("subagent")])
    out({"files": len(idx), "sessions": n, "index": INDEX_FILE}, a.json, lambda o: print(f"索引 {o['files']} 个文件，{o['sessions']} 个会话 → {o['index']}"))


def cmd_folders(a):
    """Every directory an agent has worked in: who came, how often, when, what tasks."""
    idx = load_index() if a.cached else refresh_index()
    refs = session_refs(idx)
    folders = {}
    for r in refs:
        cwd = (r["cwd"] or "").rstrip("/")
        if not cwd:
            continue
        f = folders.setdefault(cwd, {"cwd": cwd, "name": os.path.basename(cwd) or cwd, "sessions": 0, "agents": {}, "last_at": 0, "first_at": None, "turns": 0, "tasks": set()})
        f["sessions"] += 1
        f["agents"][r["agent"]] = f["agents"].get(r["agent"], 0) + 1
        f["last_at"] = max(f["last_at"], r["last_at"])
        f["turns"] += r.get("user_msgs", 0)
        f["tasks"].update(r.get("tasks", {}).keys())
        if r.get("first_ts"):
            f["first_at"] = min(f["first_at"] or r["first_ts"], r["first_ts"])
    rows = sorted(folders.values(), key=lambda f: -f["last_at"])
    for f in rows:
        f["tasks"] = sorted(f["tasks"])
        f["exists"] = os.path.isdir(f["cwd"])
    if a.query:
        q = a.query.lower()
        rows = [f for f in rows if q in f["cwd"].lower()]

    def text(rows):
        for f in rows:
            ag = " ".join(f"{k}×{v}" for k, v in f["agents"].items())
            print(f"{ago(f['last_at']):<5} {f['sessions']:>3} 会话  {ag:<40} {f['cwd'].replace(HOME, '~')}")
        print(f"\n{len(rows)} 个目录")
    out(rows, a.json, text)


def cmd_stats(a):
    """Everything the agents burned, across all of them: tokens, activity by day and hour,
    tools / skills / subagents, models, projects. Ranges filter days by activity date and
    sessions (tools, models, projects) by their last activity."""
    from datetime import date, timedelta
    idx = load_index() if a.cached else refresh_index()
    days_n = a.days or 0
    cutoff = (date.today() - timedelta(days=days_n - 1)).strftime("%Y-%m-%d") if days_n else ""
    cutoff_epoch = time.mktime(time.strptime(cutoff, "%Y-%m-%d")) if cutoff else 0
    agents = {}
    days = {}
    hours = [[0] * 24 for _ in range(7)]
    models, tools, skills, subs, projects = {}, {}, {}, {}, {}
    tok_sub = 0
    for path, e in idx.items():
        ag = e["agent"]
        if a.agent and ag != a.agent:
            continue
        if not e.get("days") and not e.get("tokens"):
            continue
        A = agents.setdefault(ag, {"agent": ag, "sessions": 0, "msgs": 0, "tokens": {"in": 0, "out": 0, "cr": 0, "cw": 0, "think": 0}, "total": 0, "days": set()})
        for day, v in (e.get("days") or {}).items():
            if cutoff and day < cutoff:
                continue
            D = days.setdefault(day, {"date": day, "msgs": 0, "tokens": 0, "in": 0, "out": 0, "cr": 0, "cw": 0, "by": {}})
            D["msgs"] += v[0]; D["tokens"] += v[1]; D["in"] += v[2]; D["out"] += v[3]; D["cr"] += v[4]; D["cw"] += v[5]
            D["by"][ag] = D["by"].get(ag, 0) + v[1]
            A["msgs"] += v[0]; A["total"] += v[1]
            for k, i in (("in", 2), ("out", 3), ("cr", 4), ("cw", 5)):
                A["tokens"][k] += v[i]
            if v[0]:
                A["days"].add(day)
            if e.get("subagent"):
                tok_sub += v[1]
        in_range = not cutoff or e.get("mtime", 0) >= cutoff_epoch
        if not in_range:
            continue
        A["tokens"]["think"] += (e.get("tokens") or {}).get("think", 0)
        if not e.get("subagent") and e.get("session_id"):
            A["sessions"] += 1
        # Only activity within the range; the weekday×hour grid is filtered the same way.
        if not cutoff:
            for k, n in (e.get("hours") or {}).items():
                w, h = k.split("-")
                hours[int(w)][int(h)] += n
        for m, n in (e.get("models") or {}).items():
            M = models.setdefault(m, {"model": m, "agent": ag, "msgs": 0})
            M["msgs"] += n
        for t, n in (e.get("tools") or {}).items():
            T = tools.setdefault(t, {"name": t, "count": 0, "by": {}})
            T["count"] += n; T["by"][ag] = T["by"].get(ag, 0) + n
        for s, n in (e.get("skills") or {}).items():
            S = skills.setdefault(s, {"name": s, "count": 0, "by": {}})
            S["count"] += n; S["by"][ag] = S["by"].get(ag, 0) + n
        for s, n in (e.get("subs") or {}).items():
            S = subs.setdefault(s, {"name": s, "count": 0, "by": {}})
            S["count"] += n; S["by"][ag] = S["by"].get(ag, 0) + n
        cwd = (e.get("cwd") or "").rstrip("/")
        if cwd and not e.get("subagent"):
            P = projects.setdefault(cwd, {"name": os.path.basename(cwd) or cwd, "cwd": cwd, "tokens": 0, "msgs": 0, "sessions": 0, "by": {}})
            tk = e.get("tokens") or {}
            tt = sum(v for k, v in tk.items() if k != "think")
            P["tokens"] += tt; P["sessions"] += 1; P["msgs"] += e.get("user_msgs", 0) + e.get("assistant_msgs", 0)
            P["by"][ag] = P["by"].get(ag, 0) + tt
    if cutoff:
        # Hour grid for a range: rebuild from the sessions' day buckets is impossible (no hour per day), so
        # approximate with sessions active in the range.
        for e in idx.values():
            if (a.agent and e["agent"] != a.agent) or e.get("mtime", 0) < cutoff_epoch:
                continue
            for k, n in (e.get("hours") or {}).items():
                w, h = k.split("-")
                hours[int(w)][int(h)] += n
    day_list = sorted(days.values(), key=lambda d: d["date"])
    active = sorted(d["date"] for d in day_list if d["msgs"] > 0)
    # streaks
    from datetime import datetime as _dt
    cur = longest = run = 0
    prev = None
    for d in active:
        dd = _dt.strptime(d, "%Y-%m-%d").date()
        run = run + 1 if prev and (dd - prev).days == 1 else 1
        longest = max(longest, run)
        prev = dd
    if prev and (date.today() - prev).days <= 1:
        cur = run
    tot = {"in": 0, "out": 0, "cr": 0, "cw": 0, "think": 0}
    for A in agents.values():
        for k in tot:
            tot[k] += A["tokens"][k]
        A["days"] = len(A["days"])
    total_tokens = tot["in"] + tot["out"] + tot["cr"] + tot["cw"]
    active_hours = sum(1 for row in hours for n in row if n) if not cutoff else None
    res = {
        "range_days": days_n,
        "agent": a.agent or "",
        "total": {"tokens": tot, "total": total_tokens, "sub_tokens": tok_sub, "msgs": sum(d["msgs"] for d in day_list), "sessions": sum(A["sessions"] for A in agents.values()),
                  "active_days": len(active), "streak_cur": cur, "streak_max": longest, "tools_distinct": len(tools), "active_hours": active_hours,
                  "first_day": active[0] if active else "", "last_day": active[-1] if active else ""},
        "agents": sorted(agents.values(), key=lambda A: -A["total"]),
        "days": day_list,
        "hours": hours,
        "models": sorted(models.values(), key=lambda m: -m["msgs"]),
        "tools": sorted(tools.values(), key=lambda t: -t["count"])[:30],
        "skills": sorted(skills.values(), key=lambda t: -t["count"])[:30],
        "subagents": sorted(subs.values(), key=lambda t: -t["count"])[:30],
        "projects": sorted(projects.values(), key=lambda p: -p["tokens"])[:20],
        "generated_at": time.time(),
    }

    def text(r):
        t = r["total"]
        print(f"token {t['total']:,}（输入 {t['tokens']['in']:,} · 输出 {t['tokens']['out']:,} · 缓存读 {t['tokens']['cr']:,} · 缓存写 {t['tokens']['cw']:,}） · 消息 {t['msgs']:,} · 会话 {t['sessions']} · 活跃 {t['active_days']} 天（当前连续 {t['streak_cur']}，最长 {t['streak_max']}）")
        for A in r["agents"]:
            print(f"  {A['agent']:<12} token {A['total']:>13,}  消息 {A['msgs']:>7,}  会话 {A['sessions']:>4}  活跃 {A['days']} 天")
        print("工具:", " · ".join(f"{x['name']} {x['count']}" for x in r["tools"][:10]))
        print("技能:", " · ".join(f"{x['name']} {x['count']}" for x in r["skills"][:10]) or "—")
        print("子 Agent:", " · ".join(f"{x['name']} {x['count']}" for x in r["subagents"][:8]) or "—")
        print("模型:", " · ".join(f"{x['model']} {x['msgs']}" for x in r["models"][:8]))
        print("项目:", " · ".join(f"{x['name']} {x['tokens']:,}" for x in r["projects"][:8]))
    out(res, a.json, text)


def cmd_list(a):
    idx = load_index() if a.cached else refresh_index()
    refs = session_refs(idx)
    for r in refs:
        r["host"], r["host_name"] = "local", local_host_name()
    if not getattr(a, "local", False):
        refs = sorted(refs + remote_refs(), key=lambda r: -(r.get("last_at") or 0))
    if a.agent:
        refs = [r for r in refs if r["agent"] == a.agent]
    if a.cwd:
        want = os.path.expanduser(a.cwd).rstrip("/")
        refs = [r for r in refs if (r["cwd"] or "").rstrip("/") == want]
    if a.project:
        refs = [r for r in refs if r["project"] == a.project]
    if a.query:
        q = a.query.lower()
        refs = [r for r in refs if q in (r["title"] or "").lower() or q in r["cwd"].lower() or q in r["session_id"]]
    refs = refs[: a.limit]

    def text(refs):
        for r in refs:
            print(f"{r['agent']:<12} {r['project']:<18} {ago(r['last_at']):<5} {r['user_msgs']:>4}轮 {len(r['subagents']):>2}子  {r['title'] or '(无标题)'}  {r['session_id'][:8]}")
    out(refs, a.json, text)


def _block_text(content):
    if isinstance(content, str):
        return content
    parts = []
    for b in content or []:
        if isinstance(b, dict) and b.get("type") == "text":
            parts.append(b.get("text", ""))
    return "\n".join(parts)


def read_zcode_detail(ref, limit):
    sid = ref["session_id"]
    msgs, files, tool_names = [], {}, {}
    rows = zcode_query("select p.data pdata, m.data mdata, p.time_created ts from part p join message m on m.id = p.message_id where p.session_id=? order by p.time_created, p.sequence", (sid,))
    for r in rows:
        try:
            p = json.loads(r["pdata"]); m = json.loads(r["mdata"])
        except Exception:
            continue
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r["ts"] / 1000))
        role = m.get("role", "")
        if p.get("type") == "text" and p.get("text", "").strip():
            msgs.append({"ts": ts, "role": "user" if role == "user" else "assistant", "text": p["text"][:600], "tools": []})
        elif p.get("type") == "tool":
            name = p.get("tool", "")
            inp = (p.get("state") or {}).get("input") or {}
            tool_names[name] = tool_names.get(name, 0) + 1
            summary = inp.get("command") or inp.get("filePath") or inp.get("file_path") or inp.get("description") or inp.get("pattern") or ""
            msgs.append({"ts": ts, "role": "tool", "text": "", "tools": [{"name": name, "summary": str(summary)[:200]}]})
            fp = inp.get("filePath") or inp.get("file_path")
            if fp and name.lower() in ("edit",):
                files.setdefault(fp, []).append({"kind": "edit", "old": inp.get("oldString", ""), "new": inp.get("newString", ""), "ts": ts})
            elif fp and name.lower() in ("write",):
                files.setdefault(fp, []).append({"kind": "write", "old": "", "new": inp.get("content", ""), "ts": ts})
    if len(msgs) > limit:
        msgs = msgs[:40] + [{"ts": "", "role": "gap", "text": f"…省略 {len(msgs) - limit} 条…", "tools": []}] + msgs[-(limit - 40):]
    return {"meta": ref, "messages": msgs, "files": [{"path": p, "changes": c} for p, c in files.items()], "tool_counts": tool_names}


def read_qoder_detail(ref, limit):
    """Qoder desktop: payload_json per message (role, text, tools[{name,input,response}], parts).
    File changes come from Edit/Write-style tool inputs plus the app's own turn_file_change
    patches (unified diffs, deflate-raw)."""
    sid = ref["session_id"]
    msgs, files, tool_names = [], {}, {}
    for m in sqlite_rows(QODER_APP_DB, "select payload_json from chat_session_messages where session_id = ? order by sequence", (sid,)):
        try:
            d = json.loads(m["payload_json"])
        except Exception:
            continue
        role, ts, txt = d.get("role"), d.get("timestamp") or "", (d.get("text") or "").strip()
        if role == "user" and txt:
            msgs.append({"ts": ts, "role": "user", "text": txt[:600], "tools": []})
        elif role == "assistant":
            tools = []
            for t in d.get("tools") or []:
                name = t.get("name") or ""
                inp = t.get("input")
                tool_names[name] = tool_names.get(name, 0) + 1
                tools.append({"name": name, "summary": _tool_summary(inp)})
                _tool_file_change(name, inp, ts, files)
            if txt or tools:
                msgs.append({"ts": ts, "role": "assistant", "text": txt[:600], "tools": tools})
    import zlib
    for p in sqlite_rows(QODER_APP_DB, "select f.path, f.display_path, f.operation, f.additions, f.deletions, p.content, p.compression, s.created_at from turn_file_change_sets s join turn_file_change_files f on f.change_set_id = s.change_set_id left join turn_file_change_patches p on p.change_set_id = f.change_set_id and p.path = f.path where s.session_id = ? order by s.created_at", (sid,)):
        diff = ""
        raw = p["content"]
        if raw:
            try:
                diff = (zlib.decompress(raw, -15) if p["compression"] == "deflate-raw" else raw).decode("utf-8", "replace")
            except Exception:
                diff = ""
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime((p["created_at"] or 0) / 1000))
        files.setdefault(p["display_path"] or p["path"], []).append({"kind": "patch", "old": "", "new": diff, "ts": ts, "op": p["operation"], "add": p["additions"], "del": p["deletions"]})
    if len(msgs) > limit:
        msgs = msgs[:40] + [{"ts": "", "role": "gap", "text": f"…省略 {len(msgs) - limit} 条…", "tools": []}] + msgs[-(limit - 40):]
    return {"meta": ref, "messages": msgs, "files": [{"path": p, "changes": c} for p, c in files.items()], "tool_counts": tool_names}


def read_qoder_ide_detail(ref, limit):
    """Qoder IDE encrypts message bodies; the timeline shows turns and tool calls with their
    (plain) parameters, which is where the commands and file edits are anyway."""
    sid = ref["session_id"]
    msgs = [{"ts": "", "role": "gap", "text": "Qoder IDE 把对话正文加密存储，这里只能看到轮次和工具调用（含参数）", "tools": []}]
    files, tool_names = {}, {}
    for m in sqlite_rows(QODER_IDE_DB, "select role, tool_result, gmt_create from chat_message where session_id = ? order by gmt_create", (sid,)):
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime((m["gmt_create"] or 0) / 1000))
        if m["role"] == "user":
            msgs.append({"ts": ts, "role": "user", "text": "（正文已加密）", "tools": []})
        elif m["role"] == "tool":
            try:
                tr = json.loads(m["tool_result"] or "{}")
            except Exception:
                continue
            name = tr.get("toolCallName") or ""
            if not name:
                continue
            params = tr.get("parameters")
            if isinstance(params, str):
                try:
                    params = json.loads(params)
                except Exception:
                    params = {"raw": params}
            tool_names[name] = tool_names.get(name, 0) + 1
            msgs.append({"ts": ts, "role": "tool", "text": "", "tools": [{"name": name, "summary": _tool_summary(params)}]})
            _tool_file_change(name, params, ts, files)
    if len(msgs) > limit:
        msgs = msgs[:40] + [{"ts": "", "role": "gap", "text": f"…省略 {len(msgs) - limit} 条…", "tools": []}] + msgs[-(limit - 40):]
    return {"meta": ref, "messages": msgs, "files": [{"path": p, "changes": c} for p, c in files.items()], "tool_counts": tool_names}


def read_session_detail(ref, limit=400):
    """Parse one transcript into a compact timeline + file changes (from Edit/Write tool calls)."""
    if ref["agent"] == "zcode":
        return read_zcode_detail(ref, limit)
    if ref["agent"] == "qoder":
        return read_qoder_detail(ref, limit)
    if ref["agent"] == "qoder-ide":
        return read_qoder_ide_detail(ref, limit)
    msgs, files, tool_names = [], {}, {}
    path = ref["path"]
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = d.get("type")
            if ref["agent"] == "pi":
                if t != "message":
                    continue
                m = d.get("message") or {}
                role, ts, c = m.get("role", ""), d.get("timestamp", ""), m.get("content")
                blocks = c if isinstance(c, list) else [{"type": "text", "text": c or ""}]
                txt = "\n".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
                tools = []
                for b in blocks:
                    if isinstance(b, dict) and b.get("type") == "toolCall":
                        name = b.get("name", ""); inp = b.get("arguments") or b.get("input") or {}
                        tool_names[name] = tool_names.get(name, 0) + 1
                        tools.append({"name": name, "summary": str(inp.get("command") or inp.get("path") or inp.get("file_path") or "")[:200]})
                        fp = inp.get("path") or inp.get("file_path")
                        if fp and name in ("edit", "write"):
                            files.setdefault(fp, []).append({"kind": name, "old": inp.get("oldText", ""), "new": inp.get("newText", inp.get("content", "")), "ts": ts})
                if role in ("user", "assistant") and (txt.strip() or tools):
                    msgs.append({"ts": ts, "role": role, "text": txt[:600], "tools": tools})
                continue
            if ref["agent"] == "codex":
                # Codex rollouts: {"type":"event_msg"/"response_item", payload:{...}}; content blocks are input_text/output_text.
                p = d.get("payload", {})
                ts = d.get("timestamp", "")
                if t == "response_item" and p.get("type") == "message":
                    role = p.get("role", "")
                    txt = "\n".join(b.get("text", "") for b in p.get("content") or [] if isinstance(b, dict) and b.get("type") in ("input_text", "output_text", "text"))
                    if txt.strip() and role in ("user", "assistant") and not txt.lstrip().startswith("<"):
                        msgs.append({"ts": ts, "role": role, "text": txt[:600], "tools": []})
                elif t == "response_item" and p.get("type") == "function_call":
                    name = p.get("name", "")
                    tool_names[name] = tool_names.get(name, 0) + 1
                    args = p.get("arguments", "")
                    try:
                        aj = json.loads(args) if isinstance(args, str) else args
                        summary = aj.get("cmd") or aj.get("command") or aj.get("path") or aj.get("file_path") or args
                        if isinstance(summary, list):
                            summary = " ".join(map(str, summary))
                        fp = aj.get("path") or aj.get("file_path")
                        if name in ("apply_patch",) or (isinstance(args, str) and "*** Begin Patch" in args):
                            files.setdefault("(apply_patch)", []).append({"kind": "edit", "old": "", "new": str(aj.get("input") or args)[:20000], "ts": ts})
                        elif fp and name in ("write_file", "edit_file"):
                            files.setdefault(fp, []).append({"kind": "write", "old": "", "new": str(aj.get("content", ""))[:20000], "ts": ts})
                    except Exception:
                        summary = args
                    msgs.append({"ts": ts, "role": "tool", "text": "", "tools": [{"name": name, "summary": str(summary)[:200]}]})
                continue
            if t not in ("user", "assistant"):
                continue
            if d.get("isSidechain"):
                continue
            m = d.get("message") or {}
            content = m.get("content")
            ts = d.get("timestamp", "")
            if t == "user":
                if isinstance(content, list) and content and isinstance(content[0], dict) and content[0].get("type") == "tool_result":
                    continue  # tool results are noise for the timeline
                txt = _block_text(content)
                # Slash-command echoes and caveats are injected by the CLI, not typed by the user.
                if txt.lstrip().startswith(("<local-command", "<command-name>", "<command-message>", "<system-reminder>")):
                    continue
                if txt.strip():
                    msgs.append({"ts": ts, "role": "user", "text": txt[:600], "tools": []})
            else:
                txt = _block_text(content)
                tools = []
                for b in content if isinstance(content, list) else []:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        name = b.get("name", "")
                        inp = b.get("input") or {}
                        tool_names[name] = tool_names.get(name, 0) + 1
                        summary = inp.get("command") or inp.get("file_path") or inp.get("description") or inp.get("prompt") or inp.get("pattern") or inp.get("url") or ""
                        tools.append({"name": name, "summary": str(summary)[:200], "id": b.get("id", "")})
                        fp = inp.get("file_path")
                        if name == "Edit" and fp:
                            files.setdefault(fp, []).append({"kind": "edit", "old": inp.get("old_string", ""), "new": inp.get("new_string", ""), "ts": ts})
                        elif name == "Write" and fp:
                            files.setdefault(fp, []).append({"kind": "write", "old": "", "new": inp.get("content", ""), "ts": ts})
                        elif name in ("NotebookEdit",) and fp:
                            files.setdefault(fp, []).append({"kind": "edit", "old": "", "new": inp.get("new_source", ""), "ts": ts})
                if txt.strip() or tools:
                    msgs.append({"ts": ts, "role": "assistant", "text": txt[:600], "tools": tools})
    if len(msgs) > limit:
        msgs = msgs[:40] + [{"ts": "", "role": "gap", "text": f"…省略 {len(msgs) - limit} 条…", "tools": []}] + msgs[-(limit - 40):]
    return {"meta": ref, "messages": msgs, "files": [{"path": p, "changes": c} for p, c in files.items()], "tool_counts": tool_names}


def remote_session_detail(key):
    """A session that is not in the local index may live on another Mac."""
    for h in hosts():
        d = remote_dispatch(h, ["session", key], 60)
        if isinstance(d, dict) and d.get("meta"):
            _tag_host([d["meta"]], h)
            d["meta"]["remote"] = True
            d["meta"]["resume_cmd"] = f"ssh -t {h['ssh']} {json.dumps(d['meta'].get('resume_cmd', ''))}"
            return d
    return None


def cmd_session(a):
    refs = resolve(load_index() or refresh_index(), a.key)
    d = read_session_detail(refs[0]) if refs else remote_session_detail(a.key)
    if not d:
        print(f"找不到 {a.key}", file=sys.stderr)
        sys.exit(1)

    def text(d):
        m = d["meta"]
        print(f"{m['title'] or '(无标题)'}  ·  {m['agent']}  ·  {m['cwd']}  ·  {m['session_id']}")
        print(f"{m['user_msgs']} 轮 · 子 Agent {len(m['subagents'])} · 改动文件 {len(d['files'])}")
        for s in m["subagents"]:
            print(f"  ↳ 子Agent {s['type']}: {s['description']}")
        for f in d["files"]:
            print(f"  ✎ {f['path']}  ({len(f['changes'])} 处)")
        print("--- 时间线 ---")
        for x in d["messages"][-30:]:
            if x["role"] == "tool":
                print(f"[tool] {x['tools'][0]['name']}: {x['tools'][0]['summary'][:80]}")
            else:
                print(f"[{x['role']}] {x['text'][:160].replace(chr(10), ' ')}" + (f"  ⚙ {', '.join(t['name'] for t in x['tools'])}" if x["tools"] else ""))
    out(d, a.json, text)


def cmd_find(a):
    idx = refresh_index()
    refs = session_refs(idx, task_id=a.task)

    def text(refs):
        if not refs:
            print(f"没有会话提到过 {a.task}")
        for r in refs:
            print(f"{r['agent']:<12} {r['project']:<18} {ago(r['last_at']):<5} {r['mentions']:>3}次  {r['title'] or ''}\n    {r['resume_cmd']}")
    out(refs, a.json, text)


def resolve(idx, key):
    """key may be a session id (prefix ok) or a task id."""
    if re.match(r"^[a-z]+-[a-z0-9]{2,8}$", key):
        return session_refs(idx, task_id=key)
    return session_refs(idx, session_id=key)


def cmd_resume(a):
    refs = resolve(refresh_index(), a.key)
    if not refs:
        print(f"找不到 {a.key}", file=sys.stderr)
        sys.exit(1)
    cmd = refs[0]["resume_cmd"]
    if a.copy:
        subprocess.run(["pbcopy"], input=cmd, text=True)
        print(f"已复制到剪贴板：{cmd}")
    else:
        print(cmd)


def host_app_of(pid, table):
    """Walk up from a pid to the .app that owns it (e.g. Ghostty hosting Herdr)."""
    for _ in range(30):
        ent = table.get(pid)
        if not ent:
            return None
        ppid, comm = ent
        m = re.search(r"/([^/]+)\.app/", comm)
        if m:
            return m.group(1)
        if ppid <= 1:
            return None
        pid = ppid


def activate(app_name):
    if app_name:
        sh(["open", "-a", app_name], timeout=5)


def zcode_click_session(title):
    """ZCode's deep links can only open a workspace (which starts a *new* session), so
    jump to an existing one by clicking its sidebar row through Accessibility.
    Electron only exposes the tree after AXManualAccessibility is switched on."""
    safe = title.replace("\\", "\\\\").replace('"', '\\"')
    # Only walk the left sidebar (x < 420 pt); the main pane can hold an embedded
    # browser with thousands of nodes and a full walk takes minutes.
    script = f'''
tell application "System Events"
  tell process "ZCode"
    try
      set value of attribute "AXManualAccessibility" to true
    end try
    if (count of windows) is 0 then return "nowindow"
    set w to window 1
    set wx to item 1 of (position of w)
    set pool to {{}}
    set queue to UI elements of w
    repeat 6 times
      set nextq to {{}}
      repeat with a in queue
        try
          set ax to item 1 of (position of a)
          set aw to item 1 of (size of a)
          if (ax - wx) < 420 and aw < 460 and aw > 120 then
            set end of pool to a
          else if (ax - wx) < 420 then
            set nextq to nextq & (UI elements of a)
          end if
        end try
      end repeat
      set queue to nextq
      if (count of queue) is 0 then exit repeat
    end repeat
    set best to missing value
    repeat with grp in pool
      repeat with el in entire contents of grp
        try
          if (name of el as text) is "{safe}" then
            if (class of el as text) is not "static text" then
              set best to el
              exit repeat
            else if best is missing value then
              set best to el
            end if
          end if
        end try
      end repeat
      if best is not missing value then exit repeat
    end repeat
    if best is missing value then return "notfound"
    try
      click best
    on error
      perform action "AXPress" of best
    end try
    return "clicked"
  end tell
end tell'''
    for attempt in range(2):
        try:
            code, out, err = sh(["osascript", "-e", script], timeout=45)
        except Exception:
            return False
        res = out.strip()
        if res == "clicked":
            return True
        if res == "nowindow" and attempt == 0:
            activate("ZCode")
            time.sleep(2)
            continue
        return False
    return False


def focus_session(s):
    """Bring the app that hosts this session to the front and, where the app
    supports it, jump to the session itself. Returns a message."""
    agent = s.get("agent", "")
    if s.get("remote"):
        return f"这个会话在 {s.get('host_name')} 上，得在那台机器上打开（或 ssh 过去后 herdr agent focus）"
    table = ps_table()
    h = s.get("herdr")
    if h:
        sh([HERDR, "agent", "focus", h["pane_id"]], timeout=5)
        host = None
        for pid, (_, comm) in table.items():
            if os.path.basename(comm) == "herdr" and host is None:
                host = host_app_of(pid, table)
        activate(host or "Ghostty")
        return f"已切到 {host or '终端'} 里的 Herdr 标签 {h['tab_id']}：{h.get('title', '')}"
    if agent == "zcode":
        title = s.get("title") or ""
        if not title:
            row = zcode_query("select title from session where id=?", (s.get("session_id"),))
            title = row[0]["title"] if row else ""
        activate("ZCode")
        if title and zcode_click_session(title):
            return f"已在 ZCode 里切到会话「{title}」"
        return f"已切到 ZCode，但没在侧栏找到「{title or s.get('session_id')}」——可能被折叠或已归档，手动点一下"
    if agent in QODER_APPS:
        # Qoder's deeplinks only start new chats; there is no way to address an existing session.
        activate(QODER_APPS[agent][1])
        return f"已切到 {QODER_APPS[agent][2]}；它的链接打不开旧会话，得在侧栏里点「{s.get('title') or s.get('session_id', '')[:8]}」"
    if agent == "claude-code" and (s.get("source_kind") == "desktop" or s.get("entrypoint") == "desktop"):
        sh(["open", f"claude://code/continue?session={s['session_id']}"], timeout=5)
        return "已让 Claude 桌面端打开这个会话"
    if agent == "codex" and s.get("source_kind") == "desktop":
        activate("ChatGPT")
        return "已切到 ChatGPT（Codex 桌面端）；会话得在里面点"
    app = s.get("source_app", "")
    if s.get("source_kind") == "terminal" and app and app not in ("终端", "Herdr"):
        activate(app)
        return f"已切到 {app}（找 {s.get('project') or s.get('cwd')} 那个标签）"
    pid = s.get("agent_pid")
    host = host_app_of(pid, table) if pid else None
    if host:
        activate(host)
        return f"已切到 {host}"
    return None


def cmd_focus(a):
    live = live_sessions()
    refs = resolve(load_index() or refresh_index(), a.key)
    wanted = {r["session_id"] for r in refs} | {a.key}
    for s in live:
        if s.get("session_id") in wanted or any(s.get("session_id", "").startswith(k) for k in wanted):
            msg = focus_session(s)
            if msg:
                print(msg)
                return
    # not live: fall back to a Herdr tab in the same directory, else say so
    for r in refs:
        for ag in herdr_agents():
            if ag.get("cwd") == r["cwd"]:
                sh([HERDR, "agent", "focus", ag["pane_id"]], timeout=5)
                activate("Ghostty")
                print(f"这个会话已结束；已切到同目录的 Herdr 标签 {ag['tab_id']}")
                return
        if r["agent"] == "zcode":
            print(focus_session({"agent": "zcode", "cwd": r["cwd"], "title": r["title"], "session_id": r["session_id"]}))
            return
    print("这个会话现在没在跑，用 `dispatch resume` 复制恢复命令吧", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------- skills

def read_frontmatter(skill_dir):
    p = os.path.join(skill_dir, "SKILL.md")
    fm = {"name": os.path.basename(skill_dir), "description": ""}
    try:
        with open(p, encoding="utf-8") as f:
            txt = f.read(4000)
        if txt.startswith("---"):
            body = txt.split("---", 2)[1]
            key = None
            for line in body.splitlines():
                if line[:1] not in (" ", "\t") and ":" in line:
                    k, v = line.split(":", 1)
                    key = k.strip()
                    v = v.strip()
                    fm[key] = "" if v in (">", "|", ">-", "|-") else v.strip('"').strip("'")
                elif key and line.strip():
                    # continuation of a folded / literal / indented multi-line value
                    fm[key] = (fm[key] + " " + line.strip()).strip()
            for k in fm:
                if isinstance(fm[k], str):
                    fm[k] = re.sub(r"\s+", " ", fm[k]).strip('"').strip("'")
    except Exception:
        pass
    return fm


def mounted(agent):
    """name -> (mount path, real path) for every skill an agent can see."""
    res = {}
    for d in AGENT_SKILL_DIRS[agent]:
        if not os.path.isdir(d):
            continue
        for n in os.listdir(d):
            p = os.path.join(d, n)
            if os.path.isdir(p) and not n.startswith(".") and n not in res:
                res[n] = (p, os.path.realpath(p))
    return res


def all_skills():
    names = {}
    if os.path.isdir(POOL):
        for n in sorted(os.listdir(POOL)):
            if os.path.isdir(os.path.join(POOL, n)) and not n.startswith("_") and not n.startswith("."):
                names[n] = os.path.join(POOL, n)
    m = {ag: mounted(ag) for ag in AGENT_SKILL_DIRS}
    for ag in m:
        for n, (_, real) in m[ag].items():
            names.setdefault(n, real)
    usage, last = skill_usage()
    rows = []
    for n, path in sorted(names.items()):
        fm = read_frontmatter(path)
        rows.append({"name": n, "path": path, "in_pool": path.startswith(POOL), "description": fm.get("description", ""), "agents": {ag: n in m[ag] for ag in m}, "mounts": {ag: (m[ag][n][0] if n in m[ag] else None) for ag in m},
                     "usage": usage.get(n, {}), "last_used": last.get(n, "")})
    return rows


def skill_usage():
    """Per-skill invocation counts by agent, from the transcript index (Claude Code records
    skill/slash-command calls; Codex and ZCode transcripts carry none, so their counts stay 0)."""
    usage, last = {}, {}
    for e in (load_index() or {}).values():
        for k, v in (e.get("skills") or {}).items():
            n = k.lstrip("/")
            usage.setdefault(n, {})
            usage[n][e["agent"]] = usage[n].get(e["agent"], 0) + int(v or 0)
            ts = (e.get("last_ts") or "")[:10]
            if ts > last.get(n, ""):
                last[n] = ts
    return usage, last


def cmd_skills_improve(a):
    """A ready-to-run agent task: review the skills actually used recently against the
    recent sessions and improve them. Printed (and copied) rather than executed, so the
    user picks which agent runs it."""
    days = a.days or 14
    rows = all_skills()
    used = sorted([r for r in rows if r["usage"]], key=lambda r: -sum(r["usage"].values()))
    top = ", ".join(f"{r['name']}({sum(r['usage'].values())})" for r in used[:10]) or "（索引里还没有技能调用记录）"
    prompt = (f"根据我最近 {days} 天的工作流改进技能。步骤：1) `dispatch stats --days {days} --json` 看各 Agent 的工具/技能/项目分布；"
              f"`dispatch list --limit 40 --json` 找最近会话，用 `dispatch session <id>` 读其中和技能相关的几段（哪里绕过了技能、哪里重复手工做了技能该做的事）。"
              f"2) 最常用技能：{top}。逐个读 `dispatch skills path <name>` 的 SKILL.md，对照会话找过时的路径/命令、缺失的触发词、写得啰嗦的部分。"
              f"3) 最近反复手工做、但没有技能覆盖的流程，提议新技能（先问我一次要不要）。"
              f"4) 直接改 SKILL.md（技能池 ~/.cc-switch/skills），每个技能一个 commit，不带 AI 署名；改完 `dispatch wiki add --kind win` 记一条做对的做法。"
              f"5) 最后给我一张表：技能、改了什么、为什么。用 dispatch begin 建任务再动手。")
    cmd = f"cd ~/.cc-switch/skills && claude {json.dumps(prompt, ensure_ascii=False)}"
    if a.copy:
        subprocess.run(["pbcopy"], input=cmd.encode("utf-8"))
    out({"prompt": prompt, "command": cmd, "top": [{"name": r["name"], "usage": r["usage"], "last_used": r["last_used"]} for r in used[:10]]}, a.json,
        lambda o: print(prompt + "\n\n启动命令" + ("（已复制）" if a.copy else "") + "：\n" + cmd))


def cc_switch_flag(name, agent, on):
    try:
        import sqlite3
        col = {"claude": "enabled_claude", "codex": "enabled_codex"}[agent]
        con = sqlite3.connect(CC_SWITCH_DB, timeout=2)
        con.execute(f"update skills set {col}=?, updated_at=? where name=?", (1 if on else 0, int(time.time()), name))
        con.commit()
        con.close()
    except Exception:
        pass


def cmd_skills(a):
    if a.op == "improve":
        return cmd_skills_improve(a)
    if a.op == "list":
        rows = all_skills()
        if a.agent:
            rows = [r for r in rows if r["agents"].get(a.agent)]
        if a.query:
            q = a.query.lower()
            rows = [r for r in rows if q in r["name"].lower() or q in r["description"].lower()]

        def text(rows):
            for r in rows:
                flags = " ".join(f"{ag}{'✓' if on else '·'}" for ag, on in r["agents"].items())
                print(f"{r['name']:<32} {flags:<16} {r['description'][:70]}")
            print(f"\n{len(rows)} 个技能（✓ = 该 Agent 已挂载）")
        out(rows, a.json, text)
        return
    rows = {r["name"]: r for r in all_skills()}
    r = rows.get(a.name)
    if not r:
        print(f"没有叫 {a.name} 的技能。`dispatch skills list` 看看有哪些", file=sys.stderr)
        sys.exit(1)
    if a.op == "path":
        print(os.path.join(r["path"], "SKILL.md"))
    elif a.op == "show":
        if a.json:
            print(json.dumps(r, ensure_ascii=False, indent=2))
        else:
            print(open(os.path.join(r["path"], "SKILL.md"), encoding="utf-8").read())
    elif a.op == "open":
        subprocess.run(["open", os.path.join(r["path"], "SKILL.md")])
    elif a.op == "write":
        new = sys.stdin.read()
        if not new.strip():
            print("stdin 为空，不写", file=sys.stderr)
            sys.exit(2)
        f = os.path.join(r["path"], "SKILL.md")
        import shutil
        shutil.copy2(f, f + ".bak")
        open(f, "w", encoding="utf-8").write(new)
        print(f"{a.name} 已保存（旧版 SKILL.md.bak）")
    elif a.op in ("enable", "disable"):
        agents = list(AGENT_SKILL_DIRS) if a.agent in (None, "all") else [a.agent]
        for ag in agents:
            existing = mounted(ag).get(a.name)
            if a.op == "enable":
                if existing:
                    print(f"{ag}: 已经挂着（{existing[0]}）")
                else:
                    d = AGENT_SKILL_DIRS[ag][0]
                    os.makedirs(d, exist_ok=True)
                    link = os.path.join(d, a.name)
                    os.symlink(r["path"], link)
                    print(f"{ag}: 已挂载 {link} -> {r['path']}")
                cc_switch_flag(a.name, ag, True)
            else:
                if not existing:
                    print(f"{ag}: 本来就没挂")
                elif os.path.islink(existing[0]):
                    os.remove(existing[0])
                    print(f"{ag}: 已卸载（本体仍在 {r['path']}）")
                else:
                    print(f"{ag}: {existing[0]} 是真目录不是软链，不敢删。先把它移进技能池 {POOL} 再用软链。")
                cc_switch_flag(a.name, ag, False)
        print("提示：Claude Code / Codex 重启会话后生效")


# ---------------------------------------------------------------- task workflow (begin / log / done)

def bd_json(argv):
    code, o, err = sh(["bd"] + argv)
    if code != 0:
        print(err.strip() or o.strip(), file=sys.stderr)
        sys.exit(code)
    j = o[o.find("[") if o.find("[") >= 0 and (o.find("{") < 0 or o.find("[") < o.find("{")) else o.find("{"):]
    try:
        d = json.loads(j)
        return d[0] if isinstance(d, list) and d else d
    except Exception:
        return {}


def similar(a_, b_):
    import difflib
    return difflib.SequenceMatcher(None, a_.lower(), b_.lower()).ratio()


def begin_warnings(title, project, cwd):
    """Things worth knowing before creating a task: someone already on something alike, or in this directory."""
    warns = []
    code, o, err = sh(["bd", "list", "--status", "in_progress", "--json"])
    try:
        for t in (json.loads(o[o.find("["):]) if code == 0 else []):
            proj = next((l.split(":", 1)[1] for l in t.get("labels") or [] if l.startswith("project:")), "")
            if project and proj and proj != project:
                continue
            if similar(title, t.get("title", "")) >= 0.5:
                warns.append(f"进行中的 {t['id']}「{t.get('title', '')}」（{t.get('assignee') or '?'}）和这个很像——先 `bd show {t['id']}`，是同一件事就 `dispatch claim {t['id']}` 或和对方分工。")
    except Exception:
        pass
    for s_ in neighbours(cwd)[:4]:
        warns.append(f"同目录有 {s_['agent']} {s_['session_id'][:8]} 在跑（{ago(s_.get('last_at') or 0)}前活动）——别改它正在改的文件；`dispatch session {s_['session_id'][:8]}` 看它在干什么。")
    return warns


def cmd_claim(a):
    """Claim a task, refusing to steal one that another actor is already working on (unless --force)."""
    issue = bd_json(["show", a.task, "--json"])
    actor = os.environ.get("BEADS_ACTOR") or ""
    owner = issue.get("assignee") or ""
    if owner and owner != actor and issue.get("status") == "in_progress" and not a.force:
        print(f"{a.task} 已由 {owner} 认领并在进行中。要接手先和它分工（`dispatch find {a.task}` 看是哪个会话），确实要抢用 --force。", file=sys.stderr)
        sys.exit(3)
    bd_json(["update", a.task, "--claim", "--json"])
    print(f"{a.task} 已认领" + (f"（从 {owner} 手里接过来）" if owner and owner != actor else ""))


def cmd_begin(a):
    """Create + claim a task in one go: the first thing an Agent does once it knows what it is doing."""
    for w in begin_warnings(a.title, a.project, os.getcwd()):
        print("⚠ " + w, file=sys.stderr)
    labels = [f"project:{a.project}"] if a.project else []
    labels.append(f"host:{local_host_name()}")  # which Mac this work runs on — Dispatch filters by it
    argv = ["create", a.title, "-t", a.type, "-p", str(a.priority), "--json"]
    if labels:
        argv += ["-l", ",".join(labels)]
    if a.desc:
        argv += ["--description", a.desc]
    if a.acceptance:
        argv += ["--acceptance", a.acceptance]
    if a.deps:
        argv += ["--deps", a.deps]
    issue = bd_json(argv)
    tid = issue.get("id")
    if not tid:
        print("创建失败", file=sys.stderr)
        sys.exit(1)
    bd_json(["update", tid, "--claim", "--json"])
    out({"id": tid, "title": a.title, "project": a.project}, a.json, lambda o: print(f"{tid} 已创建并认领。接下来在对话里提到 {tid}，进展用 `dispatch log {tid} \"…\"`，做完 `dispatch done {tid} --reason \"…\"`。"))


def cmd_log(a):
    """Progress note on a task — this is the process log, visible to everyone in Dispatch."""
    text = a.text
    if a.tick:
        # flip matching acceptance items to [x]
        issue = bd_json(["show", a.task, "--json"])
        ac = issue.get("acceptance_criteria") or ""
        lines = ac.splitlines()
        hit = 0
        for i, line in enumerate(lines):
            if any(t.lower() in line.lower() for t in a.tick) and "[ ]" in line:
                lines[i] = line.replace("[ ]", "[x]", 1)
                hit += 1
        if hit:
            bd_json(["update", a.task, "--acceptance", "\n".join(lines), "--json"])
            text = (text + " " if text else "") + f"（勾掉 {hit} 条验收项）"
    if text:
        code, o, err = sh(["bd", "comments", "add", a.task, text])
        if code != 0:
            print(err.strip(), file=sys.stderr)
            sys.exit(code)
    print(f"{a.task} 已记录")


def cmd_review(a):
    """Record an independent review with its author and evidence."""
    actor = os.environ.get("BEADS_ACTOR") or os.environ.get("DISPATCH_ACTOR") or ""
    issue = bd_json(["show", a.task, "--json"])
    if not actor or actor == issue.get("assignee"):
        raise SystemExit("复核需由执行者以外的 Agent 记录；请设置真实的 BEADS_ACTOR。")
    if issue.get("status") != "closed":
        raise SystemExit("任务尚未完成，不能记录交付复核。")
    reviewers = [x[9:] for x in issue.get("labels", []) if x.startswith("reviewer:")]
    if reviewers and actor not in reviewers:
        raise SystemExit("本任务已指定其他复核 Agent。")
    if not a.reason.strip():
        raise SystemExit("请填写检查内容、结果和依据。")
    text = f"【Agent 复核 · {'通过' if a.verdict == 'pass' else '需修改'}】{actor}\n{a.reason.strip()}"
    code, _, err = sh(["bd", "comments", "add", a.task, text], env={"BEADS_ACTOR": actor})
    if code:
        raise SystemExit(err or "复核记录写入失败")
    args = ["update", a.task, "--remove-label", "review-requested"]
    if a.verdict == "pass":
        args += ["--add-label", "reviewed", "--remove-label", "review-changes"]
    else:
        args += ["--status", "open", "--remove-label", "reviewed", "--add-label", "review-changes"]
    bd_json(args + ["--json"])
    print(f"{a.task} 复核已记录：{a.verdict}")


def cmd_done(a):
    """Close a task; verification and optional peer review are separate from completion."""
    reason = a.reason
    if not a.verified:
        reason = reason + "（未核验）" if "核验" not in reason else reason
    bd_json(["close", a.task, "--reason", reason, "--json"])
    if getattr(a, "review_by", None):
        bd_json(["update", a.task, "--add-label", "review-requested", "--add-label", "reviewer:" + a.review_by, "--remove-label", "reviewed", "--json"])
    created = []
    issue = bd_json(["show", a.task, "--json"])
    proj = next((l.split(":", 1)[1] for l in issue.get("labels", []) if l.startswith("project:")), "")
    for nxt in a.next or []:
        argv = ["create", nxt, "-t", "task", "-p", "2", "--deps", f"discovered-from:{a.task}", "--json"]
        if proj:
            argv += ["-l", f"project:{proj}"]
        d = bd_json(argv)
        if d.get("id"):
            created.append(d["id"])
    retro_key = ""
    if getattr(a, "retro", None):
        retro_key = "retro-" + a.task
        wiki_store(retro_key, wiki_compose("retro", a.retro, {}, proj, a.task))
    msg = f"{a.task} 已完成" + ("（已核验）" if a.verified else "（未核验，详见完成说明）")
    if getattr(a, "review_by", None):
        msg += f"；等待 {a.review_by} 复核（不会自动启动 Agent）"
    if created:
        msg += f"；后续任务：{', '.join(created)}"
    if retro_key:
        msg += f"；复盘已入知识库 {retro_key}"
    out({"closed": a.task, "next": created, "retro": retro_key}, a.json, lambda o: print(msg))


# ---------------------------------------------------------------- lineage graph (tasks as a thread)

def cmd_graph(a):
    """Nodes = every task, edges = bd dependencies. bd's dot output is the one call
    that carries edge *types*; direction is normalised to upstream → downstream
    (a task points at the ones it spawned / unblocks)."""
    code, o, err = sh(["bd", "list", "--all", "-n", "0", "--json"])
    if code != 0:
        print(err.strip(), file=sys.stderr)
        sys.exit(code)
    issues = json.loads(o[o.find("["):])
    code, dot, err = sh(["bd", "list", "--all", "-n", "0", "--format", "dot"])
    edges = []
    for m in re.finditer(r'"([a-z]+-[a-z0-9]+)"\s*->\s*"([a-z]+-[a-z0-9]+)"\s*\[([^\]]*)\]', dot):
        src, dst, attrs = m.group(1), m.group(2), m.group(3)
        lm = re.search(r'label="([^"]*)"', attrs)
        typ = lm.group(1) if lm else "blocks"
        # "A -> B" in bd's dot means A depends on B (A was discovered from B / A is blocked by B)
        edges.append({"from": dst, "to": src, "type": typ})
    nodes = [{k: i.get(k) for k in ("id", "title", "status", "priority", "issue_type", "assignee", "created_at", "updated_at", "closed_at", "labels", "acceptance_criteria")} for i in issues]
    out({"nodes": nodes, "edges": edges}, a.json, lambda g: [print(f"{e['from']} → {e['to']}  ({e['type']})") for e in g["edges"]] and print(f"{len(g['nodes'])} 个任务，{len(g['edges'])} 条边"))


# ---------------------------------------------------------------- quota (usage limits per agent)

QUOTA_DIR = os.path.join(DISPATCH_DIR, "quota")


CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_USAGE_TTL = 300  # seconds between calls; the app polls every minute, the API sees one call per 5


def _claude_oauth_token():
    """Claude Code's own login token, read from the keychain entry it maintains.
    Read-only: never refreshed here, never written anywhere, never printed."""
    try:
        import getpass
        raw = subprocess.run(["security", "find-generic-password", "-s", "Claude Code-credentials", "-a", getpass.getuser(), "-w"],
                             capture_output=True, text=True, timeout=10).stdout.strip()
        c = (json.loads(raw) if raw else {}).get("claudeAiOauth") or {}
    except Exception:
        return None
    if not c.get("accessToken") or (c.get("expiresAt") or 0) / 1000 < time.time():
        return None
    return c["accessToken"]


def _claude_usage():
    """Official usage numbers (the same ones /usage and the desktop app show), cached for CLAUDE_USAGE_TTL."""
    import urllib.request
    cache = os.path.join(QUOTA_DIR, "claude-usage.json")
    try:
        st = os.stat(cache)
        if time.time() - st.st_mtime < CLAUDE_USAGE_TTL:
            return json.load(open(cache)), st.st_mtime
    except Exception:
        pass
    tok = _claude_oauth_token()
    if not tok:
        return None, None
    req = urllib.request.Request(CLAUDE_USAGE_URL, headers={"Authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "dispatch-cli"})
    try:
        d = json.loads(urllib.request.urlopen(req, timeout=10).read())
    except Exception:
        try:  # offline: a stale answer beats none, the age is shown in the UI
            st = os.stat(cache)
            return json.load(open(cache)), st.st_mtime
        except Exception:
            return None, None
    os.makedirs(QUOTA_DIR, exist_ok=True)
    tmp = cache + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(d, fh)
    os.replace(tmp, cache)
    return d, time.time()


def _iso_epoch(s):
    from datetime import datetime as _dt
    try:
        return _dt.fromisoformat(s.replace("Z", "+00:00")).timestamp() if s else None
    except Exception:
        return None


def quota_claude():
    """Prefer the official usage API (has the per-model window, e.g. Fable); fall back to the
    rate_limits Claude Code feeds its statusline, which statusline-tee.sh caches."""
    p = os.path.join(QUOTA_DIR, "claude-code.json")
    try:
        sl = json.load(open(p))
    except Exception:
        sl = {}
    plan = (sl.get("model") or {}).get("display_name", "")
    usage, ts = _claude_usage()
    if usage:
        wins = []
        for lim in usage.get("limits") or []:
            if lim.get("percent") is None:
                continue
            kind = lim.get("kind")
            scope = ((lim.get("scope") or {}).get("model") or {}).get("display_name")
            label = {"session": "5 小时", "weekly_all": "每周"}.get(kind)
            if kind == "weekly_scoped":
                label = f"每周 · {scope or '单模型'}"
            if not label:
                continue
            wins.append({"label": label, "used_percent": lim["percent"], "resets_at": _iso_epoch(lim.get("resets_at"))})
        if wins:
            return {"agent": "claude-code", "plan": plan, "windows": wins, "updated_at": ts, "source": "oauth", "note": ""}
    try:
        st = os.stat(p)
    except Exception:
        return {"agent": "claude-code", "plan": "", "windows": [], "updated_at": None, "source": "statusline", "note": "还没拿到数据：Claude Code 新会话开一句话后状态栏会写入"}
    rl = sl.get("rate_limits") or {}
    wins = []
    for key, label in (("five_hour", "5 小时"), ("seven_day", "每周")):
        w = rl.get(key) or {}
        if w:
            wins.append({"label": label, "used_percent": w.get("used_percentage"), "resets_at": w.get("resets_at")})
    return {"agent": "claude-code", "plan": plan, "windows": wins, "updated_at": st.st_mtime, "source": "statusline", "note": "" if wins else "状态栏数据里没有 rate_limits（可能是 API key 计费而非订阅）"}


def quota_codex():
    """Codex writes a token_count event with rate_limits into each rollout; take the newest."""
    best = None
    files = sorted(glob.glob(os.path.join(HOME, ".codex", "sessions", "**", "*.jsonl"), recursive=True), key=os.path.getmtime, reverse=True)[:12]
    for f in files:
        try:
            with open(f, "rb") as fh:
                fh.seek(max(0, os.path.getsize(f) - 400_000))
                tail = fh.read().decode("utf-8", "replace")
        except OSError:
            continue
        for line in reversed(tail.splitlines()):
            if '"token_count"' not in line or '"rate_limits"' not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            rl = (d.get("payload") or {}).get("rate_limits")
            if not rl:
                continue
            ts = d.get("timestamp", "")
            if best is None or ts > best[0]:
                best = (ts, rl)
            break
    if not best:
        return {"agent": "codex", "plan": "", "windows": [], "updated_at": None, "source": "rollout", "note": "没有找到 Codex 的用量记录"}
    ts, rl = best
    wins = []
    for key, label in (("primary", "5 小时"), ("secondary", "每周")):
        w = rl.get(key) or {}
        if w:
            mins = w.get("window_minutes")
            lab = label if not mins else ("5 小时" if mins <= 360 else "每周" if mins >= 10000 else f"{mins // 60} 小时")
            wins.append({"label": lab, "used_percent": w.get("used_percent"), "resets_at": w.get("resets_at")})
    try:
        upd = time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
    except Exception:
        upd = None
    return {"agent": "codex", "plan": rl.get("plan_type") or "", "windows": wins, "updated_at": upd, "source": "rollout", "note": ""}


def quota_zcode():
    """ZCode's credentials are encrypted, so the API is off limits; scan its JSONL logs for the
    last quota snapshot it fetched itself (usage-stats logger)."""
    logs = sorted(glob.glob(os.path.join(HOME, ".zcode", "cli", "log", "zcode-*.jsonl")), reverse=True)[:2]
    for lg in logs:
        try:
            with open(lg, "rb") as fh:
                fh.seek(max(0, os.path.getsize(lg) - 2_000_000))
                tail = fh.read().decode("utf-8", "replace")
        except OSError:
            continue
        for line in reversed(tail.splitlines()):
            if "percentage" not in line and "TIME_LIMIT" not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            blob = json.dumps(d, ensure_ascii=False)
            m = re.search(r'"percentage":\s*([0-9.]+)', blob)
            if not m:
                continue
            pct = float(m.group(1))
            mr = re.search(r'"nextResetTime":\s*([0-9]+)', blob)
            reset = int(mr.group(1)) if mr else None
            if reset and reset > 10**11:
                reset //= 1000
            ml = re.search(r'"level":\s*"([^"]+)"', blob)
            ts = d.get("time") or d.get("timestamp") or d.get("ts")
            upd = None
            if isinstance(ts, (int, float)):
                upd = ts / 1000 if ts > 10**11 else ts
            return {"agent": "zcode", "plan": ("GLM Coding " + ml.group(1).capitalize()) if ml else "GLM Coding", "windows": [{"label": "当前周期", "used_percent": 100 - pct if pct <= 100 else None, "resets_at": reset}], "updated_at": upd, "source": "zcode log", "note": "ZCode 日志里的剩余比例换算"}
    return {"agent": "zcode", "plan": "", "windows": [], "updated_at": None, "source": "", "note": "ZCode 的凭证是加密的，额度只能在 ZCode 里看（或它的日志里还没记录）"}


def quota_qoder():
    """Qoder bills in Credits and only shows them inside the apps (/usage); nothing documented on disk."""
    note = "Qoder 没有公开的额度接口，Credits 在 Qoder 设置里看；Qoder IDE 用的是同一个账号"
    return [{"agent": "qoder", "plan": "", "windows": [], "updated_at": None, "source": "", "note": note},
            {"agent": "qoder-ide", "plan": "", "windows": [], "updated_at": None, "source": "", "note": note}]


def cmd_quota(a):
    rows = [quota_claude(), quota_codex(), quota_zcode(), *quota_qoder()]
    for r in rows:
        r["host"], r["host_name"] = "local", local_host_name()
    if not getattr(a, "local", False):
        for h in hosts():
            for r in _tag_host(_only_theirs(remote_dispatch(h, ["quota", "--local"], 60)), h):
                r["remote"] = True
                rows.append(r)

    def until(epoch):
        m = int((epoch - time.time()) / 60)
        return f"{m}m 后重置" if m < 60 else f"{m // 60}h{m % 60:02d} 后重置" if m < 2880 else f"{m // 1440}d 后重置"

    def text(rows):
        for r in rows:
            parts = [f"{w['label']} {round(w['used_percent']) if w['used_percent'] is not None else '?'}%" + (f"（{until(w['resets_at'])}）" if w.get("resets_at") and w["resets_at"] > time.time() else "") for w in r["windows"]]
            print(f"{r.get('host_name', ''):<10} {r['agent']:<12} {r['plan']:<14} {' · '.join(parts) if parts else r['note']}" + (f"   [数据 {ago(r['updated_at'])} 前]" if r.get("updated_at") else ""))
    out(rows, a.json, text)


# ---------------------------------------------------------------- global rules (one file → every agent)

# Machine-wide rules live next to the cross-agent skills dir, not inside any one agent's home.
RULES_FILE = os.path.join(HOME, ".agents", "rules", "GLOBAL.md")
RULES_BEGIN = "<!-- BEGIN DISPATCH GLOBAL RULES"
RULES_END = "<!-- END DISPATCH GLOBAL RULES -->"
# Where each agent reads machine-wide instructions. Claude Code can @import a
# file; the others get the content inlined inside the managed block.
RULE_TARGETS = {
    "claude": {"path": os.path.join(HOME, ".claude", "CLAUDE.md"), "mode": "import"},
    "codex": {"path": os.path.join(HOME, ".codex", "AGENTS.md"), "mode": "inline"},
    "zcode": {"path": os.path.join(HOME, ".zcode", "AGENTS.md"), "mode": "inline"},
    # pi loads ~/.pi/agent/AGENTS.md as its global context file (plus AGENTS.md up from cwd).
    "pi": {"path": os.path.join(HOME, ".pi", "agent", "AGENTS.md"), "mode": "inline"},
}


def rules_text():
    try:
        return open(RULES_FILE, encoding="utf-8").read()
    except FileNotFoundError:
        return ""


def rules_hash(text):
    import hashlib
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def render_block(agent, text, h):
    mode = RULE_TARGETS[agent]["mode"]
    if mode == "import":
        body = f"@{RULES_FILE}\n"
    else:
        body = text.rstrip() + "\n"
    return f"{RULES_BEGIN} hash:{h} source:{RULES_FILE} -->\n{body}{RULES_END}\n"


def target_state(agent, h):
    p = RULE_TARGETS[agent]["path"]
    if not os.path.exists(p):
        return "missing", p, ""
    s = open(p, encoding="utf-8").read()
    i = s.find(RULES_BEGIN)
    if i < 0:
        return "absent", p, s
    m = re.search(r"hash:([0-9a-f]+)", s[i:i + 200])
    return ("synced" if m and m.group(1) == h else "stale"), p, s


def cmd_rules(a):
    if a.op == "path":
        print(RULES_FILE)
        return
    if a.op == "show":
        print(rules_text() or f"（还没有规则文件：{RULES_FILE}）")
        return
    if a.op == "write":
        new = sys.stdin.read()
        if not new.strip():
            print("stdin 为空，不写", file=sys.stderr)
            sys.exit(2)
        os.makedirs(os.path.dirname(RULES_FILE), exist_ok=True)
        if os.path.exists(RULES_FILE):
            import shutil
            shutil.copy2(RULES_FILE, RULES_FILE + ".bak")
        open(RULES_FILE, "w", encoding="utf-8").write(new)
        a.op, a.force = "sync", True
        return cmd_rules(a)
    if a.op == "open":
        subprocess.run(["open", RULES_FILE])
        return
    text = rules_text()
    h = rules_hash(text)
    if a.op == "status":
        rows = []
        for ag in RULE_TARGETS:
            st, p, _ = target_state(ag, h)
            rows.append({"agent": ag, "path": p, "state": st, "mode": RULE_TARGETS[ag]["mode"]})
        out({"hash": h, "source": RULES_FILE, "targets": rows}, a.json, lambda o: [print(f"{r['agent']:<8} {r['state']:<8} {r['path']}") for r in o["targets"]])
        return
    if a.op == "sync":
        if not text.strip():
            print(f"规则文件为空：{RULES_FILE}", file=sys.stderr)
            sys.exit(1)
        results = []
        for ag in RULE_TARGETS:
            st, p, s = target_state(ag, h)
            if st == "synced" and not a.force:
                results.append({"agent": ag, "path": p, "action": "unchanged"})
                continue
            block = render_block(ag, text, h)
            if st in ("missing", "absent"):
                head = "" if st == "missing" else s.rstrip() + "\n\n"
                new = head + block
                action = "created" if st == "missing" else "appended"
            else:
                i = s.find(RULES_BEGIN)
                j = s.find(RULES_END, i)
                j = j + len(RULES_END) if j >= 0 else len(s)
                if s[j:j + 1] == "\n":
                    j += 1
                new = s[:i] + block + s[j:]
                action = "updated"
            os.makedirs(os.path.dirname(p), exist_ok=True)
            bak = p + ".bak"
            if os.path.exists(p):
                import shutil
                shutil.copy2(p, bak)
            with open(p, "w", encoding="utf-8") as f:
                f.write(new)
            results.append({"agent": ag, "path": p, "action": action})
        out({"hash": h, "results": results}, a.json, lambda o: [print(f"{r['agent']:<8} {r['action']:<10} {r['path']}") for r in o["results"]] and print("新会话生效"))
        return


# ---------------------------------------------------------------- wiki: pits, wins, retros, howtos (bd memories)

# One convention, four kinds. Content starts with the kind's head marker; optional
# labelled fields follow; `#project:` / `#task:` tags at the end. Keys carry the prefix.
WIKI_KINDS = {
    "pit":   {"prefix": "pit-",   "head": "【坑】",   "fields": [("fix", "【解法】")],                                   "label": "坑"},
    "win":   {"prefix": "win-",   "head": "【做对】", "fields": [("why", "【为什么】")],                                 "label": "做对"},
    "retro": {"prefix": "retro-", "head": "【复盘】", "fields": [("tech", "【技术】"), ("good", "【做对】"), ("bad", "【做错】")], "label": "复盘"},
    "howto": {"prefix": "howto-", "head": "【方法】", "fields": [],                                                    "label": "方法"},
}
_ALL_LABELS = sorted({lab for k in WIKI_KINDS.values() for _, lab in k["fields"]} | {k["head"] for k in WIKI_KINDS.values()}, key=len, reverse=True)


def wiki_compose(kind, text, fields, project=None, task=None):
    k = WIKI_KINDS[kind]
    body = text.strip()
    if not body.startswith(k["head"]):
        body = k["head"] + body
    for name, label in k["fields"]:
        v = (fields or {}).get(name)
        if v and label not in body:
            body += f" {label}{v.strip()}"
    if project:
        body += f" #project:{project}"
    if task:
        body += f" #task:{task}"
    return body


def wiki_kind_of(key, value):
    for kind, k in WIKI_KINDS.items():
        if key.startswith(k["prefix"]) or value.lstrip().startswith(k["head"]):
            return kind
    return None


def wiki_parse(key, value):
    kind = wiki_kind_of(key, value)
    tag = lambda n: (re.search(rf"#{n}:(\S+)", value) or [None, ""])[1] if re.search(rf"#{n}:(\S+)", value) else ""
    body = re.sub(r"#(project|task):\S+", "", value).strip()
    fields = {}
    if kind:
        pat = "(" + "|".join(re.escape(l) for l in _ALL_LABELS) + ")"
        parts = re.split(pat, body)
        cur = None
        for piece in parts:
            if piece in _ALL_LABELS:
                cur = piece
                fields.setdefault(cur, "")
            elif cur is not None:
                fields[cur] = (fields[cur] + piece).strip()
        head = WIKI_KINDS[kind]["head"]
        text = fields.pop(head, body)
    else:
        text = body
    return {"key": key, "kind": kind, "text": text, "fields": fields, "project": tag("project"), "task": tag("task"), "raw": value}


def wiki_store(key, content):
    code, o, err = sh(["bd", "remember", content, "--key", key])
    if code != 0:
        print(err.strip() or o.strip(), file=sys.stderr)
        sys.exit(code)
    return key


def wiki_all():
    code, o, err = sh(["bd", "memories", "--json"])
    if code != 0:
        print(err, file=sys.stderr)
        sys.exit(code)
    d = json.loads(o[o.find("{"):])
    return [wiki_parse(k, v) for k, v in d.items() if k != "schema_version" and isinstance(v, str)]


def wiki_line(it, width=170):
    lab = WIKI_KINDS[it["kind"]]["label"] if it["kind"] else "记忆"
    body = it["text"]
    for label, v in it["fields"].items():
        if v:
            body += f" {label}{v}"
    body = re.sub(r"\s+", " ", body)
    return f"[{lab}] {it['key']}：{body[:width]}{'…' if len(body) > width else ''}"


def cmd_wiki(a):
    if a.op == "add":
        kind = a.kind or "pit"
        fields = {"fix": a.fix, "why": a.why, "tech": a.tech, "good": a.good, "bad": a.bad}
        content = wiki_compose(kind, a.text, fields, a.project, a.task)
        pre = WIKI_KINDS[kind]["prefix"]
        slug = re.sub(r"[^a-z0-9]+", "-", a.text.lower()).strip("-")[:40] or str(int(time.time()))
        key = a.key or (pre + slug)
        if not key.startswith(pre):
            key = pre + key
        wiki_store(key, content)
        print(f"已记录 {key}（{WIKI_KINDS[kind]['label']}）。同项目的 Agent 下次会话启动会看到；任何时候 `dispatch wiki search 关键词` 可查。")
        return
    items = wiki_all()
    if a.op == "show":
        for it in items:
            if it["key"] == a.text or any(it["key"] == k["prefix"] + (a.text or "") for k in WIKI_KINDS.values()):
                print(it["raw"])
                return
        print("没有这条", file=sys.stderr)
        sys.exit(1)
    q = (a.text or "").lower()
    if not a.all:
        items = [it for it in items if it["kind"]]
    if a.kind:
        items = [it for it in items if it["kind"] == a.kind]
    if a.project:
        items = [it for it in items if it["project"] == a.project]
    if q:
        items = [it for it in items if q in it["raw"].lower() or q in it["key"].lower()]

    def text(items):
        for it in items:
            print(wiki_line(it, 400))
        print(f"\n{len(items)} 条")
    out(items, a.json, text)


def cmd_pit(a):
    """Backwards-compatible alias: dispatch pit add|list|show == dispatch wiki --kind pit."""
    a.kind = "pit"
    for f in ("why", "tech", "good", "bad"):
        setattr(a, f, None)
    if a.op == "list" and not getattr(a, "all", False):
        a.all = False
    cmd_wiki(a)


# ---------------------------------------------------------------- insights: how the agents behaved lately (the cross-agent /insights)

# Signals read straight off the transcripts. Every pattern is a *cue*, not a verdict — the
# report shows samples so a person (or an agent) can judge.
_I_APPROVE = re.compile(r"^\s*(y|yes|ok|okay|好|好的|可以|行|是|是的|对|嗯|go|do it|proceed|开始|做吧|同意|确认|没问题|就这样|按你说的|你决定|你来定|随便|都行)[。.!！\s]*$", re.I)
_I_CONTINUE = re.compile(r"^\s*(继续|接着|go on|continue|然后呢|接下来|下一步|继续做|接着做|继续吧)", re.I)
_I_CORRECT = re.compile(r"(别问|不要问|不用问|直接做|直接改|不要再|别再|怎么还|怎么又|为什么没|为什么不|你没|没做|没改|不对|错了|不是这个|不是我要|我说的是|我说了|算了|废话|啰嗦|太长|简短|说重点|别停|不要停|为什么停|做完|全部做|一次做完|又一遍|已经说过|前面说了|你忘|不记得|你不会用|为什么不用)")
_I_ASKTAIL = re.compile(r"(要不要|需不需要|需要我|要我|可以吗|好吗|行吗|哪种|哪个|请确认|请告诉我|请选择|你希望|你想|你定|你确认|等你|说一声|点头|shall i|should i|would you like|do you want|which (one|option)|let me know|继续吗|开始吗|\?\s*$|？\s*$)", re.I)
_I_OVERFLOW = re.compile(r"(Prompt is too long|compaction failed|context window)", re.I)
_I_LONG = 60


def insights_scan(days):
    from datetime import datetime, timedelta
    idx = load_index() or refresh_index()
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%dT") if days else ""
    per_agent, sessions, samples = {}, [], {"asktail": [], "correction": [], "overflow": []}
    def bump(ag, k, n=1):
        per_agent.setdefault(ag, {"sessions": 0, "user_turns": 0, "approve": 0, "continue": 0, "correction": 0, "asktail": 0, "ends_on_question": 0, "long": 0, "overflow": 0})[k] += n
    for key, e in idx.items():
        if e.get("subagent") or not e.get("user_msgs"):
            continue
        if cutoff and (e.get("last_ts") or "") < cutoff:
            continue
        ref = dict(e); ref["path"] = key; ref.setdefault("subagents", [])
        try:
            d = read_session_detail(ref, limit=100000)
        except Exception:
            continue
        msgs = [m for m in d["messages"] if m["role"] in ("user", "assistant") and not m["text"].startswith(("The TodoWrite", "<ide_", "<system", "<task-notification", "# In app browser", "# Files mentioned", "# Applications mentioned"))]
        U = [m for m in msgs if m["role"] == "user"]
        if not U:
            continue
        ag = e["agent"]
        bump(ag, "sessions"); bump(ag, "user_turns", len(U))
        row = {"agent": ag, "session_id": e["session_id"], "cwd": e.get("cwd", ""), "last_ts": (e.get("last_ts") or "")[:10], "user_turns": len(U), "approve": 0, "continue": 0, "correction": 0, "asktail": 0, "overflow": 0, "ends_on_question": False}
        for i, m in enumerate(msgs):
            t = m["text"].strip()
            if m["role"] == "user":
                if _I_APPROVE.match(t): row["approve"] += 1; bump(ag, "approve")
                if _I_CONTINUE.match(t): row["continue"] += 1; bump(ag, "continue")
                if _I_CORRECT.search(t) and len(t) < 600:
                    row["correction"] += 1; bump(ag, "correction")
                    prev = next((x["text"].strip()[-220:] for x in reversed(msgs[:i]) if x["role"] == "assistant" and x["text"].strip()), "")
                    samples["correction"].append({"agent": ag, "session_id": e["session_id"], "ts": row["last_ts"], "assistant": prev, "user": t[:220]})
            else:
                if not t:
                    continue
                if _I_OVERFLOW.search(t): row["overflow"] += 1; bump(ag, "overflow")
                if _I_ASKTAIL.search(t[-260:]) and i + 1 < len(msgs) and msgs[i + 1]["role"] == "user":
                    nxt = msgs[i + 1]["text"].strip()
                    answered = bool(_I_APPROVE.match(nxt)) or len(nxt) < 40
                    row["asktail"] += 1; bump(ag, "asktail")
                    if not answered:
                        samples["asktail"].append({"agent": ag, "session_id": e["session_id"], "ts": row["last_ts"], "assistant": t[-220:], "user": nxt[:160]})
        last = next((x for x in reversed(msgs) if x["text"].strip()), None)
        if last and last["role"] == "assistant" and _I_ASKTAIL.search(last["text"].strip()[-260:]):
            row["ends_on_question"] = True; bump(ag, "ends_on_question")
        if len(U) >= _I_LONG:
            bump(ag, "long")
        sessions.append(row)
    sessions.sort(key=lambda r: -(r["correction"] * 3 + r["asktail"] + r["overflow"] * 3 + r["continue"]))
    return {"days": days, "per_agent": per_agent, "sessions": sessions[:12], "samples": {k: v[-8:] for k, v in samples.items()}, "total_sessions": len(sessions)}


def insights_findings(rep):
    """Turn counts into plain sentences; the ranking is what a reviewer should look at first."""
    out = []
    tot = lambda k: sum(a[k] for a in rep["per_agent"].values())
    n = rep["total_sessions"] or 1
    if tot("asktail"):
        out.append(f"助手以问句/选项收尾 {tot('asktail')} 次，其中 {len(rep['samples']['asktail'])}+ 次用户没有回答而是直接说下一件事——这些问句可以不问，直接做或不提。")
    if tot("correction"):
        out.append(f"用户纠错/催促 {tot('correction')} 次（见样本）：优先看是哪类——没用工具、做过头、停太早、忘了记录。")
    if tot("overflow"):
        out.append(f"{tot('overflow')} 次撞到 Prompt is too long / 压缩失败：这些会话应该更早拆成新会话。")
    if tot("long"):
        out.append(f"{tot('long')} 个会话超过 {_I_LONG} 轮：一个任务一个会话，进度写板上。")
    if tot("ends_on_question"):
        out.append(f"{tot('ends_on_question')} 个会话停在助手的问句上（用户没再回）：可能是没必要的确认，也可能是真卡住了。")
    if not out:
        out.append("这段时间没有明显的行为信号。")
    return out


def cmd_insights(a):
    rep = insights_scan(a.days)
    rep["findings"] = insights_findings(rep)
    top = ", ".join(f"{r['agent']} {r['session_id'][:8]}（纠错 {r['correction']}·问句 {r['asktail']}·{r['user_turns']} 轮）" for r in rep["sessions"][:5])
    prompt = (f"按最近 {a.days} 天的会话做一次跨 Agent 复盘并落地改进。1) `dispatch insights --days {a.days} --json` 拿信号统计和样本；最值得看的会话：{top}。"
              f"用 `dispatch session <id>` 读这些会话里纠错和问句附近的几段，判断每条是哪类问题（没用工具 / 做过头 / 停太早 / 无效确认 / 忘记录）。"
              f"2) 每类给一条可执行的规则或习惯，能落到 ~/.agents/rules/GLOBAL.md 的直接改并 `dispatch rules sync`；跟某个技能有关的改那个 SKILL.md。"
              f"3) 结论写进知识库：坑 `dispatch wiki add --kind pit …`、做对 `--kind win …`，最后 `dispatch done --retro` 写一条复盘。"
              f"4) 给我一张表：现象、证据（会话 id）、改了什么。先 `dispatch begin` 建任务再动手。")
    rep["prompt"] = prompt
    rep["command"] = f"cd ~ && claude {json.dumps(prompt, ensure_ascii=False)}"
    if a.copy:
        subprocess.run(["pbcopy"], input=rep["command"].encode("utf-8"))

    def text(rep):
        print(f"# 洞察 · 最近 {a.days} 天 · {rep['total_sessions']} 个会话")
        for f in rep["findings"]:
            print("- " + f)
        print("\n## 按 Agent")
        print(f"{'agent':<11}{'会话':>5}{'轮':>6}{'确认':>5}{'继续':>5}{'纠错':>5}{'问句':>5}{'停问':>5}{'长':>4}{'溢出':>5}")
        for ag, c in rep["per_agent"].items():
            print(f"{ag:<11}{c['sessions']:>5}{c['user_turns']:>6}{c['approve']:>5}{c['continue']:>5}{c['correction']:>5}{c['asktail']:>5}{c['ends_on_question']:>5}{c['long']:>4}{c['overflow']:>5}")
        print("\n## 最值得回看的会话")
        for r in rep["sessions"][:8]:
            print(f"- {r['agent']} {r['session_id'][:12]} {r['last_ts']} · {r['user_turns']} 轮 · 纠错 {r['correction']} · 问句 {r['asktail']} · 溢出 {r['overflow']} · …{(r['cwd'] or '')[-30:]}")
        for kind, title in (("correction", "用户纠错样本"), ("asktail", "问句没被回答的样本")):
            if rep["samples"][kind]:
                print(f"\n## {title}")
                for smp in rep["samples"][kind][-5:]:
                    print(f"- [{smp['agent']} {smp['session_id'][:8]}] 助手…「{smp['assistant'][-120:].replace(chr(10), ' ')}」 → 用户「{smp['user'][:100].replace(chr(10), ' ')}」")
        print("\n启动改进任务" + ("（命令已复制）" if a.copy else "") + f"：\n{rep['command'][:200]}…")
    out(rep, a.json, text)


# ---------------------------------------------------------------- catalog: capabilities kept OFF by default, enabled on request

def catalog_items():
    """Skills in the pool that nobody has mounted, and Claude Code plugins that are disabled.
    prime shows only counts + a few names; agents suggest one when it would clearly help."""
    items = []
    for r in all_skills():
        if r["in_pool"] and not any(r["agents"].values()):
            items.append({"kind": "skill", "name": r["name"], "desc": (r["description"] or "")[:70], "enable": f"dispatch skills enable {r['name']} --agent claude|codex"})
    try:
        st = json.load(open(os.path.join(HOME, ".claude", "settings.json")))
        for name, on in sorted((st.get("enabledPlugins") or {}).items()):
            if on:
                continue
            pl, mk = name.split("@", 1)
            desc = ""
            for d in sorted(glob.glob(os.path.join(HOME, ".claude", "plugins", "cache", mk, pl, "*", ".claude-plugin", "plugin.json")))[-1:]:
                try:
                    desc = (json.load(open(d)).get("description") or "")[:70]
                except Exception:
                    pass
            items.append({"kind": "plugin", "name": name, "desc": desc, "enable": f"claude plugin enable {name}"})
    except Exception:
        pass
    return items


def catalog_line():
    items = catalog_items()
    if not items:
        return ""
    sk = [i for i in items if i["kind"] == "skill"]
    pl = [i for i in items if i["kind"] == "plugin"]
    names = "、".join(i["name"].split("@")[0] for i in pl[:4])
    return f"可按需启用（默认不注入）：技能 {len(sk)} 个、插件 {len(pl)} 个（{names}…）。明显有用时建议用户一句，同意再启用：`dispatch catalog -q 词`。"


def cmd_catalog(a):
    items = catalog_items()
    if a.kind:
        items = [i for i in items if i["kind"] == a.kind]
    if a.query:
        q = a.query.lower()
        items = [i for i in items if q in i["name"].lower() or q in i["desc"].lower()]

    def text(items):
        for i in items:
            print(f"{i['kind']:<7}{i['name']:<40}{i['desc']:<72} → {i['enable']}")
        print(f"\n{len(items)} 项（未挂载技能 + 已禁用插件；启用后新会话生效）")
    out(items, a.json, text)


# ---------------------------------------------------------------- env: API keys and other secrets, one file, 0600

ENV_DIR = os.path.join(HOME, ".config", "dispatch")
ENV_FILE = os.path.join(ENV_DIR, "env")          # `# 用途` line above each `KEY=value`
ENV_FISH = os.path.join(ENV_DIR, "env.fish")     # regenerated on every write; fish config sources it
_ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def env_read():
    """[{name, value, note}] in file order. Never reaches bd/Dolt or the wiki."""
    items, note = [], ""
    if not os.path.exists(ENV_FILE):
        return items
    for line in open(ENV_FILE, encoding="utf-8"):
        line = line.rstrip("\n")
        if not line.strip():
            note = ""
            continue
        if line.lstrip().startswith("#"):
            note = line.lstrip("# ").strip()
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            items.append({"name": k.strip(), "value": v, "note": note})
            note = ""
    return items


def env_write(items):
    os.makedirs(ENV_DIR, mode=0o700, exist_ok=True)
    os.chmod(ENV_DIR, 0o700)
    with open(ENV_FILE, "w", encoding="utf-8") as f:
        f.write("# Dispatch 环境/密钥库：`dispatch env` 维护；Agent 用 `dispatch env get <NAME>` 取值。不要复制到其他文件。\n\n")
        for it in items:
            if it.get("note"):
                f.write(f"# {it['note']}\n")
            f.write(f"{it['name']}={env_quote(it['value'])}\n\n")
    os.chmod(ENV_FILE, 0o600)
    with open(ENV_FISH, "w", encoding="utf-8") as f:
        f.write("# generated by `dispatch env`; sourced from config.fish\n")
        for it in items:
            f.write(f"set -gx {it['name']} {env_quote(it['value'])}\n")
    os.chmod(ENV_FISH, 0o600)


def env_quote(v):
    return "'" + v.replace("'", "'\\''") + "'" if re.search(r"[\s#$\"'\\]", v) else v


def env_mask(v):
    return v if len(v) <= 6 else v[:3] + "…" + v[-3:]


def env_summary_line():
    items = env_read()
    if not items:
        return ""
    short = lambda n: re.split(r"[（(，,；;]", n)[0][:14]
    return "Key（`dispatch env get 名`，别让用户重贴）：" + "，".join(f"{it['name']}" + (f"={short(it['note'])}" if it["note"] else "") for it in items)


def cmd_env(a):
    items = env_read()
    by = {it["name"]: it for it in items}
    if a.op == "path":
        print(ENV_FILE)
    elif a.op == "list":
        rows = [{"name": it["name"], "note": it["note"], "masked": env_mask(it["value"]), "length": len(it["value"])} for it in items]
        out(rows, a.json, lambda rs: [print(f"{r['name']:<28} {r['masked']:<14} {r['note']}") for r in rs] or print(f"\n{len(rs)} 个（文件 {ENV_FILE}，0600）"))
    elif a.op == "get":
        if a.name not in by:
            print(f"没有 {a.name}。`dispatch env list` 看有哪些", file=sys.stderr)
            sys.exit(1)
        print(by[a.name]["value"])
    elif a.op == "set":
        if not _ENV_KEY.match(a.name or ""):
            print("变量名只能是字母、数字、下划线", file=sys.stderr)
            sys.exit(2)
        value = sys.stdin.read().strip() if a.stdin else a.value
        if value is None or value == "":
            print("需要值（位置参数，或 --stdin）", file=sys.stderr)
            sys.exit(2)
        if a.name in by:
            by[a.name]["value"] = value
            if a.note is not None:
                by[a.name]["note"] = a.note
        else:
            items.append({"name": a.name, "value": value, "note": a.note or ""})
        env_write(items)
        print(f"{a.name} 已保存（{env_mask(value)}）。fish 新开终端自动可用；Agent 用 `dispatch env get {a.name}`。")
    elif a.op == "unset":
        if a.name not in by:
            print(f"本来就没有 {a.name}", file=sys.stderr)
            sys.exit(1)
        env_write([it for it in items if it["name"] != a.name])
        print(f"{a.name} 已删除")
    elif a.op == "export":
        for it in items:
            print(f"set -gx {it['name']} {env_quote(it['value'])}" if a.fish else f"export {it['name']}={env_quote(it['value'])}")
    elif a.op == "import":
        n = 0
        for line in open(a.name, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip().replace("export ", "")
            v = v.strip().strip("\"'")
            if _ENV_KEY.match(k) and v:
                if k in by:
                    by[k]["value"] = v
                else:
                    items.append({"name": k, "value": v, "note": a.note or f"从 {os.path.basename(a.name)} 导入"})
                    by[k] = items[-1]
                n += 1
        env_write(items)
        print(f"导入 {n} 个")


# ---------------------------------------------------------------- prime: compact session-start digest

def project_names():
    code, o, err = sh(["bd", "list", "--all", "--json"])
    names = {}
    if code != 0:
        return names
    try:
        for it in json.loads(o[o.find("["):]):
            for l in it.get("labels") or []:
                if l.startswith("project:"):
                    names[l.split(":", 1)[1].lower()] = l.split(":", 1)[1]
    except Exception:
        pass
    return names


def project_of_cwd(cwd, names):
    parts = [x.lower() for x in os.path.normpath(cwd).split(os.sep) if x]
    for part in reversed(parts):
        if part in names:
            return names[part]
    return ""


def neighbours(cwd, self_id=""):
    """Other live sessions working in this directory (or a parent/child of it)."""
    cwd = os.path.normpath(cwd)
    rows = []
    try:
        live = live_sessions()
    except Exception:
        return rows
    for s in live:
        if not s.get("alive") or s.get("session_id") == self_id:
            continue
        c = os.path.normpath(s.get("cwd") or "")
        if not c or c == "/":
            continue
        nested = cwd not in (HOME, "/") and c not in (HOME, "/") and (cwd.startswith(c + os.sep) or c.startswith(cwd + os.sep))
        if c == cwd or nested:
            rows.append(s)
    return rows


EDITS_DIR = os.path.join(DISPATCH_DIR, "edits")


def editing_now(session_id, window=30 * 60):
    """Files this session touched recently (edit-guard registry)."""
    files, now = [], time.time()
    for n in os.listdir(EDITS_DIR) if os.path.isdir(EDITS_DIR) else []:
        try:
            r = json.load(open(os.path.join(EDITS_DIR, n)))
        except Exception:
            continue
        if r.get("session_id") == session_id and now - r.get("ts", 0) < window:
            files.append(os.path.basename(r.get("file", "")))
    return sorted(files)


def quota_for(actor):
    """Quota windows for this agent from the cached collectors (fresh enough for a session start)."""
    try:
        if actor == "claude-code":
            return quota_claude()
        if actor == "codex":
            return quota_codex()
    except Exception:
        return None
    return None


def quota_mode(percent):
    """What the agent should do at this usage level; text goes straight into prime."""
    if percent is None:
        return None, ""
    if percent >= 95:
        return "critical", "额度告急（≥95%）：只做收尾——把进度 `dispatch log` 写到板上，未完成的 `dispatch done --next` 变成任务，然后告诉用户换一个额度充足的 Agent 继续（`dispatch quota` 看谁还有余量）。不要开新工作。"
    if percent >= 80:
        return "saving", "省 token 模式（≥80%）：回复只给结论和必要证据；不重读已读过的大文件，用 grep/sed -n 取片段；不派子 Agent、不跑 Explore；工具输出用 --json / tail 截短；不把整板拉进上下文；能合并的工具调用合并；非紧急的事写成任务留给额度多的 Agent。"
    return "normal", ""


def quota_line(actor):
    q = quota_for(actor)
    if not q or not q.get("windows"):
        return "", None
    parts, worst = [], 0
    for w in q["windows"]:
        pct = w.get("used_percent")
        if pct is None:
            continue
        worst = max(worst, pct)
        left = ""
        if w.get("resets_at") and w["resets_at"] > time.time():
            m = int((w["resets_at"] - time.time()) / 60)
            left = f"，{m // 60}h{m % 60:02d} 后重置" if m < 2880 else f"，{m // 1440}d 后重置"
        parts.append(f"{w['label']} {round(pct)}%{left}")
    if not parts:
        return "", None
    return f"额度（{actor}）：" + " · ".join(parts) + "。", worst


def cmd_prime(a):
    """What an Agent needs at session start, and nothing else: who it is, the board's
    protocol in four lines, this project's tasks, and the wiki entries for this project
    (plus the few global ones). Everything else is one `dispatch wiki search` away."""
    cwd = a.cwd or os.getcwd()
    actor = os.environ.get("BEADS_ACTOR") or os.environ.get("DISPATCH_ACTOR") or ""
    self_id = ""
    if a.hook_json and not sys.stdin.isatty():
        try:
            hook = json.loads(sys.stdin.read() or "{}")
            self_id = hook.get("session_id") or hook.get("sessionId") or ""
            cwd = a.cwd or hook.get("cwd") or cwd
        except Exception:
            pass
    names = project_names()
    proj = project_of_cwd(cwd, names)
    ptag = proj or "<项目名>"
    lines = [f"# Dispatch 中央任务板" + (f" · 当前项目 {proj}" if proj else "") + (f" · 你是 {actor}" if actor else "")]
    lines.append(f"任务：明白要做什么后 `dispatch begin \"标题\" -P {ptag} -d \"背景+要做什么\" -a \"- [ ] 验收项\"`（已有任务则 `bd update <id> --claim`）；进展 `dispatch log <id> \"…\"`；收尾 `dispatch done <id> --reason \"做了什么、怎么验证\" [--verified] [--retro \"【技术】…【做对】…【做错】…\"] [--next \"后续\"]`。")
    lines.append(f"知识库：动手前 `dispatch wiki search <词>`；踩坑 `dispatch wiki add --kind pit \"现象\" --fix \"解法\" -P {ptag}`，做对 `--kind win`。")
    # board
    code, o, err = sh(["bd", "list", "--all", "--json"])
    tasks = []
    try:
        tasks = json.loads(o[o.find("["):]) if code == 0 else []
    except Exception:
        tasks = []
    def lab(t):
        return next((l.split(":", 1)[1] for l in t.get("labels") or [] if l.startswith("project:")), "")
    mine = [t for t in tasks if t.get("status") in ("in_progress", "open") and (not proj or lab(t) == proj)]
    mine.sort(key=lambda t: (t.get("status") != "in_progress", t.get("priority", 9)))
    shown = mine[:6] if proj else [t for t in mine if t.get("status") == "in_progress"][:5]
    if shown:
        lines.append(f"## 板上（{proj or '全部'}）")
        for t in shown:
            mark = "◐" if t.get("status") == "in_progress" else "○"
            who = f" [{t.get('assignee')}]" if t.get("assignee") else ""
            lines.append(f"{mark} {t['id']}{who} {t.get('title', '')}")
        if len(mine) > len(shown):
            lines.append(f"…还有 {len(mine) - len(shown)} 条：`bd ready`")
    # wiki: this project's entries + global ones (no project tag)
    items = [it for it in wiki_all() if it["kind"]]
    local = [it for it in items if proj and it["project"].lower() == proj.lower()]
    glob_ = [it for it in items if not it["project"]]
    # pits and wins are what prevent repeat mistakes; retros are long and mostly history — newest one only
    short = lambda xs: [it for it in xs if it["kind"] != "retro"]
    retro = [it for it in local if it["kind"] == "retro"][-1:]
    pick = short(local)[-a.limit:] + retro + short(glob_)[-max(2, a.limit // 2):]
    if pick:
        lines.append(f"## 知识库（{proj + ' + ' if proj else ''}通用；全部 {len(items)} 条，`dispatch wiki list`）")
        for it in pick:
            lines.append(wiki_line(it, 140))
    env_line = env_summary_line()
    if env_line:
        lines.append(env_line)
    cat = catalog_line()
    if cat:
        lines.append(cat)
    # who else is in this directory right now — the thing that prevents two agents from fighting
    nb = neighbours(cwd, self_id)
    if nb:
        lines.append(f"## 同目录在跑（{len(nb)}）")
        for s_ in nb[:6]:
            mark = "◐" if s_.get("state") == "working" else "○"
            ed = editing_now(s_["session_id"])
            lines.append(f"{mark} {s_['agent']} {s_['session_id'][:8]} · {'在跑' if s_.get('state') == 'working' else '等用户'} · {(lambda t: t + '活动' if t.startswith('刚刚') else t + '前活动')(ago(s_.get('last_at') or 0))} · 目录 …{(s_.get('cwd') or '')[-28:]}" + (f" · {s_['host_name']}" if s_.get("host") not in (None, "local") else "") + (f" · 正在改：{', '.join(ed[:5])}{'…' if len(ed) > 5 else ''}" if ed else ""))
        lines.append("只改自己任务的文件，commit 按文件 add；看它在干什么 `dispatch session <id>`；认领用 `dispatch claim`。")
    ql, worst = quota_line(actor)
    if ql:
        mode, advice = quota_mode(worst)
        lines.append("## 额度")
        lines.append(ql + (" " + advice if advice else ""))
    text = "\n".join(lines)
    if a.hook_json:
        print(json.dumps({"continue": True, "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}, ensure_ascii=False))
    else:
        print(text)


# ---------------------------------------------------------------- main

def proxy_to_host(argv):
    """`dispatch --host mini <subcommand …>`: run the same command on another Mac from hosts.json
    over ssh. stdin, stdout and the exit code pass straight through, so every subcommand
    (rules write, env set, skills enable…) works remotely without knowing about hosts."""
    import shlex
    if len(argv) < 2 or argv[0] != "--host":
        return None
    hid, rest = argv[1], argv[2:]
    if hid in ("local", "", local_host_name()):
        return rest  # caller continues locally
    h = next((x for x in hosts() if x["id"] == hid or x["name"] == hid), None)
    if not h:
        print(f"hosts.json 里没有叫 {hid} 的机器（本机用 local）", file=sys.stderr)
        sys.exit(2)
    cmd = f"env BEADS_DIR=$HOME/tasks/.beads {h.get('dispatch', 'dispatch')} " + " ".join(shlex.quote(x) for x in rest)
    try:
        r = subprocess.run(["ssh", "-o", "ConnectTimeout=4", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", h["ssh"], cmd],
                           stdin=(subprocess.DEVNULL if sys.stdin.isatty() else sys.stdin), stderr=subprocess.PIPE, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        print(f"{h['name']} 没在 60 秒内响应", file=sys.stderr)
        sys.exit(124)
    err = (r.stderr or "").strip()
    if r.returncode == 255:
        if "Permission denied" in err:
            print(f"{h['name']} 拒绝了 ssh 登录（{h['ssh']}）：那台机器没有本机的公钥。把 ~/.ssh/id_*.pub 加进它的 ~/.ssh/authorized_keys，或在 hosts.json 里改成 ~/.ssh/config 里的别名。", file=sys.stderr)
        else:
            print(f"连不上 {h['name']}（{h['ssh']}）：Tailscale 没开，或那台机器离线。{err[:120]}", file=sys.stderr)
    elif err:
        print(err, file=sys.stderr)
    sys.exit(r.returncode)


def main():
    rest = proxy_to_host(sys.argv[1:])
    if rest is not None:
        sys.argv = [sys.argv[0]] + rest
    p = argparse.ArgumentParser(prog="dispatch", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sessions", help="live Agent sessions"); s.add_argument("--local", action="store_true", help="this Mac only (what other Macs ask for)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_sessions)
    s = sub.add_parser("find", help="sessions that mention a task"); s.add_argument("task"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_find)
    s = sub.add_parser("index", help="refresh the transcript index"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_index)
    s = sub.add_parser("folders", help="directories agents have worked in"); s.add_argument("--query", "-q"); s.add_argument("--cached", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_folders)
    s = sub.add_parser("list", help="browse all sessions"); s.add_argument("--local", action="store_true", help="this Mac only, skip other hosts"); s.add_argument("--agent", help="claude-code | codex | pi | zcode"); s.add_argument("--project"); s.add_argument("--cwd", help="only sessions in this directory"); s.add_argument("--query", "-q"); s.add_argument("--limit", type=int, default=200); s.add_argument("--cached", action="store_true", help="use the cached index without rescanning"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_list)
    s = sub.add_parser("session", help="timeline + file changes of one session"); s.add_argument("key", help="session id (prefix ok) or task id"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_session)
    s = sub.add_parser("resume", help="print the resume command"); s.add_argument("key", help="session id (prefix ok) or task id"); s.add_argument("--copy", action="store_true"); s.set_defaults(fn=cmd_resume)
    s = sub.add_parser("focus", help="jump to the Herdr tab of a session"); s.add_argument("key"); s.set_defaults(fn=cmd_focus)
    s = sub.add_parser("skills", help="skill pool + per-agent mounts"); s.add_argument("op", choices=["list", "show", "path", "open", "enable", "disable", "improve", "write"]); s.add_argument("name", nargs="?"); s.add_argument("--agent", choices=["claude", "codex", "all"]); s.add_argument("--query", "-q"); s.add_argument("--days", type=int, default=14, help="improve: 回看最近 N 天"); s.add_argument("--copy", action="store_true", help="improve: 启动命令复制到剪贴板"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_skills)
    s = sub.add_parser("begin", help="create + claim a task (do this once you know what you're doing)"); s.add_argument("title"); s.add_argument("--project", "-P"); s.add_argument("--desc", "-d"); s.add_argument("--acceptance", "-a", help="one '- [ ] …' per line"); s.add_argument("--type", "-t", default="task"); s.add_argument("--priority", "-p", type=int, default=2); s.add_argument("--deps"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_begin)
    s = sub.add_parser("claim", help="claim a task; refuses one another agent is working on unless --force"); s.add_argument("task"); s.add_argument("--force", action="store_true"); s.set_defaults(fn=cmd_claim)
    s = sub.add_parser("log", help="progress note on a task (the process log)"); s.add_argument("task"); s.add_argument("text", nargs="?", default=""); s.add_argument("--tick", nargs="*", help="acceptance items (substring) to mark done"); s.set_defaults(fn=cmd_log)
    s = sub.add_parser("done", help="close a task; --next creates follow-ups; --retro writes the retrospective to the wiki"); s.add_argument("task"); s.add_argument("--reason", "-r", required=True); s.add_argument("--verified", action="store_true", help="you actually checked it works; this is not independent peer review"); s.add_argument("--retro", help="复盘：做了什么【技术】用了什么【做对】哪里对了【做错】哪里错了 → wiki retro-<task>"); s.add_argument("--next", nargs="*", help="follow-up task titles"); s.add_argument("--json", action="store_true"); s.add_argument("--review-by", help="request peer review from this Agent, without launching it"); s.set_defaults(fn=cmd_done)
    s = sub.add_parser("review", help="record independent Agent review and its evidence"); s.add_argument("task"); s.add_argument("--verdict", choices=["pass", "changes"], required=True); s.add_argument("--reason", required=True); s.set_defaults(fn=cmd_review)
    s = sub.add_parser("graph", help="task lineage: nodes + typed edges"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_graph)
    s = sub.add_parser("stats", help="tokens, activity heatmap, tools/skills across all agents"); s.add_argument("--agent", help="claude-code | codex | pi | zcode"); s.add_argument("--days", type=int, default=0, help="only the last N days (0 = all)"); s.add_argument("--cached", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_stats)
    s = sub.add_parser("agent", help="hand work to another agent through Herdr: list | start <kind> | ask <target> <text> | read | wait | keys <target> <key…> | close")
    s.add_argument("op", choices=["list", "start", "ask", "read", "wait", "keys", "close"])
    s.add_argument("target_or_kind", nargs="?", help="start: kind (claude|codex|qodercli|opencode|gemini…); others: pane id / name / title / task id")
    s.add_argument("text", nargs="?", help="ask: the prompt; keys: first key name")
    s.add_argument("more", nargs="*", help="keys: further key names (enter, esc, down, up, tab, y, n …)")
    s.add_argument("--host", help="another Mac from hosts.json (id or name); default this one")
    s.add_argument("--cwd", help="start: directory for the new tab")
    s.add_argument("--label", help="start: tab title")
    s.add_argument("--name", help="start: agent name in Herdr")
    s.add_argument("--model", help="start: passed to the agent as --model")
    s.add_argument("--task", help="start: claim this task for the new agent and note who handed it over")
    s.add_argument("--prompt", "-p", help="start: first prompt to send once the agent is ready")
    s.add_argument("--no-wait", dest="wait", action="store_false", help="don't wait for the agent to finish the prompt")
    s.add_argument("--timeout", type=int, default=600000, help="ms to wait for the agent (default 10 min)")
    s.add_argument("--lines", type=int, default=80, help="lines of terminal output to read back")
    s.add_argument("--json", action="store_true")
    s.add_argument("--extra", default="", help="start: extra args for the agent CLI, as one quoted string (e.g. --extra '--effort high')")
    s.set_defaults(fn=cmd_agent)
    s = sub.add_parser("serve", help="serve the web/phone version of Dispatch over HTTP (Tailscale); `serve url` prints the link"); s.add_argument("what", nargs="?", choices=["run", "url"], default="run"); s.set_defaults(fn=cmd_serve)
    s = sub.add_parser("hosts", help="this Mac and the others: overlay network, remote-desktop backends detected, recommendation"); s.add_argument("--local", action="store_true", help="only this Mac (used over ssh by other hosts)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_hosts)
    s = sub.add_parser("quota", help="usage limits per agent (5h / weekly), every Mac"); s.add_argument("--local", action="store_true", help="this Mac only"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_quota)
    s = sub.add_parser("rules", help="machine-wide rules for every agent"); s.add_argument("op", choices=["show", "path", "open", "status", "sync", "write"]); s.add_argument("--force", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_rules)
    s = sub.add_parser("pit", help="pitfall log (= wiki --kind pit)"); s.add_argument("op", choices=["add", "list", "show"]); s.add_argument("text", nargs="?"); s.add_argument("--fix"); s.add_argument("--project", "-P"); s.add_argument("--task"); s.add_argument("--key"); s.add_argument("--all", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_pit)
    s = sub.add_parser("wiki", help="knowledge base: pits / wins / retros / howtos"); s.add_argument("op", choices=["add", "list", "search", "show"]); s.add_argument("text", nargs="?"); s.add_argument("--kind", "-k", choices=list(WIKI_KINDS)); s.add_argument("--fix", help="pit: 解法"); s.add_argument("--why", help="win: 为什么对"); s.add_argument("--tech", help="retro: 技术"); s.add_argument("--good", help="retro: 做对"); s.add_argument("--bad", help="retro: 做错"); s.add_argument("--project", "-P"); s.add_argument("--task"); s.add_argument("--key"); s.add_argument("--all", action="store_true", help="include plain memories"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_wiki)
    s = sub.add_parser("insights", help="cross-agent behaviour review: confirmations, corrections, early stops, overflow"); s.add_argument("--days", type=int, default=14); s.add_argument("--copy", action="store_true", help="copy the improvement-task command"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_insights)
    s = sub.add_parser("catalog", help="capabilities kept off by default: unmounted skills, disabled plugins"); s.add_argument("--query", "-q"); s.add_argument("--kind", choices=["skill", "plugin"]); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_catalog)
    s = sub.add_parser("env", help="API keys / secrets store (~/.config/dispatch/env, 0600)"); s.add_argument("op", choices=["list", "get", "set", "unset", "export", "import", "path"]); s.add_argument("name", nargs="?"); s.add_argument("value", nargs="?"); s.add_argument("--note", help="用途，一句话"); s.add_argument("--stdin", action="store_true", help="set: 值从 stdin 读（不进 shell 历史）"); s.add_argument("--fish", action="store_true", help="export: fish 语法"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_env)
    s = sub.add_parser("prime", help="compact session-start digest (SessionStart hook)"); s.add_argument("--hook-json", action="store_true"); s.add_argument("--cwd"); s.add_argument("--limit", type=int, default=4, help="wiki entries for this project"); s.set_defaults(fn=cmd_prime)
    a = p.parse_args()
    if a.cmd == "agent":
        a.kind = a.target = a.target_or_kind
        if a.op != "list" and not a.target_or_kind:
            p.error("start 要给 kind（claude|codex|qodercli…），其它要给目标（pane id / 名字 / 标题 / 任务 ID）")
        if a.op == "ask" and not a.text:
            p.error("ask 要给提示词")
    if a.cmd == "skills" and a.op not in ("list", "improve") and not a.name:
        p.error("需要技能名")
    if a.cmd in ("pit", "wiki") and a.op == "add" and not a.text:
        p.error("需要写内容")
    if a.cmd == "env" and a.op in ("get", "set", "unset", "import") and not a.name:
        p.error("需要变量名" if a.op != "import" else "需要文件路径")
    if a.cmd == "wiki" and a.op == "search":
        a.op = "list"
    a.fn(a)


if __name__ == "__main__":
    main()
