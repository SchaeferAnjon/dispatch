#!/usr/bin/env python3
"""dispatch — the Agent-facing CLI for the global task board.

Everything Dispatch.app shows, an Agent can ask for here (JSON with --json):

  dispatch sessions                 live Agent sessions (who is running where, busy or waiting)
  dispatch editing                  files each active session changed in the last 30 min, aggregated per file, with conflicts
  dispatch find <task-id>           sessions whose transcript mentions the task, with resume commands
  dispatch commits <task-id>        git commits of a task (id in the commit message, or hash in its close reason)
  dispatch resume <session|task>    print (or --copy) the command that resumes a session
  dispatch focus <session|task>     jump to the Herdr tab running that session
  dispatch adopt <session|pid-N>    take a session running in Warp/iTerm/Terminal into Herdr (stop when idle, resume there)
  dispatch skills list|show|enable|disable|open|path|new|import   pool + per-agent mounts; new writes the template, import pulls a public GitHub repo
  dispatch prime [--hook-json]      compact session-start digest: identity, this project's tasks, relevant wiki, who else is in this dir, your quota
  dispatch claim <task> [--force]   claim without stealing: refuses a task another agent is working on
  dispatch wiki add|list|search|show   knowledge base: pits (坑), wins (做对), retros (复盘), howtos (方法)
  dispatch docs <project>           research / review / design documents of a project (design/, docs/, 研究/ + registered ones)
  dispatch docs add|rm|read <project> …   register a path/URL, remove one, or read its markdown
  dispatch wiki search "<句子>" --semantic   find entries by meaning (智谱 embedding-3 + sqlite-vec), not spelling
  dispatch wiki related <task-id>   the pits that mean the same as this task (task page 右栏)
  dispatch pit add|list|show        = wiki --kind pit
  dispatch insights [--days N] [--alerts] [--ack]   cross-agent signal counts, samples, per-session alerts, an improvement task
  dispatch insights report|list|show|open|schedule|due   the model-written /insights-style report (dated, scheduled, opens as a page)
  dispatch catalog [-q kw]          skills/plugins kept off by default; agents suggest one when it would help
  dispatch notify "标题" "正文"      push to the phone (ntfy / Bark, keys in `dispatch env`) or a macOS banner
  dispatch --host <id> <any subcommand>   run it on another Mac from hosts.json (ssh; stdin/stdout pass through)
  dispatch env list|get|set|unset|export|import   API keys & secrets (~/.config/dispatch/env, 0600; prime lists names only)

Data lives in ~/tasks/.dispatch (session registry, transcript index) and the
Beads board at $BEADS_DIR. bd remains the tool for tasks themselves.
"""
import argparse, glob, hashlib, json, os, re, shutil, subprocess, sys, tarfile, tempfile, time

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
HERDR = next((p for p in (os.path.join(HOME, ".local", "bin", "herdr"), "/opt/homebrew/bin/herdr", "/usr/local/bin/herdr") if os.path.exists(p)), os.path.join(HOME, ".local", "bin", "herdr"))
ZCODE_DB = os.path.join(HOME, ".zcode", "cli", "db", "db.sqlite")
RETIRED_AGENTS = frozenset({"qoder", "qoder-ide", "qodercli"})
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


def herdr_local_command(args):
    # The Mac mini keeps its persistent terminal in the named "main" session.
    # GUI and SSH callers must resolve the same running server.
    root = os.path.join(HOME, '.config', 'herdr')
    named = not os.path.exists(os.path.join(root, 'herdr.sock')) and os.path.exists(os.path.join(root, 'sessions', 'main', 'herdr.sock'))
    return [HERDR] + (['--session', 'main'] if named else []) + args


def herdr_agents():
    if not os.path.exists(HERDR):
        return []
    try:
        code, o, _ = sh(herdr_local_command(["agent", "list"]), timeout=5)
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


# ---------------------------------------------------------------- other Macs over Tailscale

HOSTS_FILE = os.path.join(DISPATCH_DIR, "hosts.json")
SELF_NAME_FILE = os.path.join(DISPATCH_DIR, "self-name.json")
REMOTE_DIR = os.path.join(DISPATCH_DIR, "remote")
_LOCAL_NAME = None


def local_host_name():
    """The system ComputerName (e.g. "Apple的Mac mini"), unless renamed from Settings —
    that override lives in SELF_NAME_FILE, separate from the system name so it survives
    across reinstalls and doesn't touch macOS's own ComputerName."""
    global _LOCAL_NAME
    if _LOCAL_NAME is None:
        try:
            _LOCAL_NAME = json.load(open(SELF_NAME_FILE)).get("name", "").strip()
        except Exception:
            _LOCAL_NAME = ""
        if not _LOCAL_NAME:
            try:
                _LOCAL_NAME = subprocess.run(["/usr/sbin/scutil", "--get", "ComputerName"], capture_output=True, text=True, timeout=2).stdout.strip() or os.uname().nodename
            except Exception:
                _LOCAL_NAME = os.uname().nodename
    return _LOCAL_NAME


def hosts():
    """Other Macs that run the same dispatch checkout, reached over Tailscale by ssh.
    Edit ~/tasks/.dispatch/hosts.json to add one; an empty list turns the feature off."""
    try:
        return json.load(open(HOSTS_FILE))
    except Exception:
        return []  # no other Macs until `dispatch init` joins one


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
    from remote_screen import secure_screen_url
    ov = overlay_network()
    ip = ov["ip"] or lan_ip()
    screen_url = secure_screen_url(ip)
    screen_http = port_open("127.0.0.1", 6080, 0.5) or (bool(ip) and port_open(ip, 6080, 0.5))
    b = {
        "overlay": ov,
        "lan_ip": lan_ip(),
        "screen_sharing": port_open("127.0.0.1", 5900, 0.5),
        "novnc_up": bool(screen_url) and screen_http,
        "novnc": screen_url,
        "novnc_issue": "" if screen_url else "手机看屏幕需要开启 Tailscale HTTPS；旧 HTTP 链接无法在 Safari 登录 Mac。" if screen_http else "",
        "vnc": f"vnc://{ip}" if ip else "",
        "rustdesk": _app_present("/Applications/RustDesk.app"),
        "rustdesk_id": rustdesk_id(),
        "sunshine": _app_present("/Applications/Sunshine.app", "/opt/homebrew/bin/sunshine", "/usr/local/bin/sunshine"),
        "sunshine_ui": f"https://{ip}:47990" if ip else "",
        "uu": _app_present("/Applications/*UU*远程*.app", "/Applications/UU Remote*.app", "/Applications/网易UU远程.app"),
    }
    # Recommendation, in the order that costs the user the least.
    if ov["kind"] and b["novnc_up"]:
        rec, why = "novnc", f"已在 {ov['kind']} 网里，浏览器通过 HTTPS 打开"
    elif ov["kind"] and b["screen_sharing"]:
        rec, why = "vnc", f"已在 {ov['kind']} 网里，屏幕共享已开；设置页「屏幕访问」点「配置」就能手机看"
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
               "novnc": "", "novnc_up": False, "novnc_issue": "", "vnc": f"vnc://{hip}",
               "screen_sharing": online and port_open(hip, 5900), "rustdesk": False, "rustdesk_id": "", "sunshine": False, "sunshine_ui": "", "uu": False, "overlay": {"kind": "", "ip": hip}, "recommend": "", "why": ""}
        if online:
            det = remote_dispatch(h, ["hosts", "--local"], 120)
            if isinstance(det, list) and det:
                d = det[0]
                for k in ("rustdesk", "rustdesk_id", "sunshine", "uu", "screen_sharing", "novnc", "novnc_up", "novnc_issue"):
                    row[k] = d.get(k, row[k])
                # Older peers may still advertise the broken HTTP endpoint.
                if not row["novnc"].startswith("https://"):
                    row["novnc"], row["novnc_up"] = "", False
                    if row["screen_sharing"]:
                        row["novnc_issue"] = "手机看屏幕需要在这台机器开启 Tailscale HTTPS。"
                if isinstance(d.get("overlay"), dict) and d["overlay"].get("kind"):
                    row["overlay"] = d["overlay"]
                row["sunshine_ui"] = f"https://{hip}:47990" if d.get("sunshine") else ""
        if row["novnc_up"]:
            row["recommend"], row["why"] = "novnc", "浏览器通过 HTTPS 打开"
        elif row["screen_sharing"]:
            row["recommend"], row["why"] = "vnc", "屏幕共享已开；在那台的设置页「屏幕访问」点「配置」就能手机看"
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

KIND_ACTOR = {"claude": "claude-code", "codex": "codex", "pi": "pi", "opencode": "zcode", "gemini": "gemini", "cursor": "cursor", "kimi": "kimi", "amp": "amp"}
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
        r = subprocess.run(herdr_local_command(args), capture_output=True, text=True, timeout=timeout)
    else:
        sess = host.get("herdr_session") or "main"
        remote = "env PATH=$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin herdr --session " + shlex.quote(sess) + " " + " ".join(shlex.quote(x) for x in args)
        r = subprocess.run(["ssh", "-o", "ConnectTimeout=3", "-o", "BatchMode=yes", host["ssh"], remote], capture_output=True, text=True, timeout=timeout + 15)
    if raw:
        return r.stdout
    # Herdr prints its JSON error on stderr with a non-zero exit; keep the error code so callers
    # can tell "shell not ready yet" (retry) from a real failure.
    for text in (r.stdout, r.stderr):
        try:
            d = json.loads(text)
            if isinstance(d, dict):
                return d
        except Exception:
            pass
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


# An agent that works unattended (handed a task, or asked for one discussion turn) cannot
# stop at every sandbox / permission prompt; these are the CLIs' own "just do it" flags.
AUTONOMOUS_ARGS = {"codex": ["--dangerously-bypass-approvals-and-sandbox"], "claude": ["--dangerously-skip-permissions"]}

# Start-up dialogs that swallow the first prompt if nobody answers them.
STARTUP_DIALOGS = [
    (re.compile(r"Press t to trust all", re.I), ["t"]),
    (re.compile(r"Press enter to view hooks; esc to close", re.I), ["esc"]),
    (re.compile(r"trust the files in this folder|Do you trust|Yes, proceed", re.I), ["enter"]),
    (re.compile(r"Press Enter to continue", re.I), ["enter"]),
]


def dismiss_startup_dialogs(host, pane, tries=3):
    """Read the pane; if a known dialog is showing, answer it. Returns what was pressed."""
    pressed = []
    for _ in range(tries):
        txt = herdr(host, ["agent", "read", pane, "--lines", "40"], raw=True) or ""
        hit = next((keys for rx, keys in STARTUP_DIALOGS if rx.search(txt)), None)
        if not hit:
            break
        herdr(host, ["agent", "send-keys", pane] + hit)
        pressed += hit
        time.sleep(2.5)
    return pressed


def wait_interactive(host, pane, timeout=90):
    """Until the agent can take a prompt: first runs self-update, then may show a trust
    dialog, and Herdr's `interactive_ready` flips true only once the input box is up.
    Answers known dialogs along the way. Returns (ready, keys pressed)."""
    deadline = time.time() + timeout
    pressed, quiet, last = [], 0, None
    while time.time() < deadline:
        hit = dismiss_startup_dialogs(host, pane, tries=1)
        if hit:
            pressed += hit
            quiet, last = 0, None
            continue
        info = herdr(host, ["agent", "get", pane])
        ag = (info.get("result") or {}).get("agent", {}) if isinstance(info, dict) else {}
        if ag.get("interactive_ready") or ag.get("agent_status") in ("idle", "ready"):
            # interactive_ready flips true while the agent is still printing its start-up
            # (skills, extensions, update notice); a prompt sent then misses the 5-second
            # state-change window Herdr's `prompt --wait` needs, so wait for a quiet pane.
            # Compare the body, not the status bar: a blinking cursor or a ticking
            # context meter would otherwise keep the pane "changing" forever.
            txt = strip_pane_chrome(herdr(host, ["agent", "read", pane, "--lines", "40"], raw=True) or "")
            if txt == last:
                quiet += 1
                if quiet >= 2:  # two clean reads in a row: no dialog popped up after ready
                    return True, pressed
            else:
                last, quiet = txt, 0
        else:
            quiet, last = 0, None
        time.sleep(1.5)
    return False, pressed


# A pane read ends with the agent's own UI, never with the reply: separator rules, the
# empty input box, and the model / context / permission status. Strip that tail so the
# dialog shows the answer, not the chrome.
ANSI_RX = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\")
RULE_RX = re.compile(r"^\s*[─━═╌┄┅┈┉\-—_=·•]{16,}\s*$")
CHROME_RX = re.compile(
    r"^\s*(?:❯\s*$|"
    r"\[[^\]]+\]\s*│|"
    r"Context\s+[█▓▒░]|"
    r"[⏵▶⏸].*(?:permission|agents?)|"
    r"●\s*\S+\s*·\s*/|"
    r"↑\s*[\d.]+k?\s+↓|"
    r"esc interrupt\b|Press ctrl\+o\b|"
    r"Image in clipboard\b|"
    r"✻\s+\S+.*\bfor\s+\d)"
)


def strip_pane_chrome(text):
    """Keep the reply; drop the agent's status bar / input box at the tail of a pane read."""
    if not text:
        return text
    lines = ANSI_RX.sub("", text).split("\n")
    for i in range(len(lines) - 1, max(len(lines) - 14, -1), -1):
        if RULE_RX.match(lines[i]):  # everything below the last full-width rule is status
            lines = lines[:i]
            break
    while lines and (not lines[-1].strip() or RULE_RX.match(lines[-1]) or CHROME_RX.match(lines[-1])):
        lines.pop()
    return "\n".join(lines).strip("\n")


def read_pane(host, pane, lines, settle=False, cap=45):
    """Read a pane. settle=True keeps reading until the text stops changing, so the reply
    is complete even when Herdr reported idle before the agent had drawn it (pi)."""
    txt = herdr(host, ["agent", "read", pane, "--lines", str(lines)], raw=True) or ""
    if not settle:
        return txt
    last, deadline = txt, time.time() + cap
    while time.time() < deadline:
        time.sleep(1.0)
        cur = herdr(host, ["agent", "read", pane, "--lines", str(lines)], raw=True) or ""
        if cur == last:
            return cur
        last = cur
    return last


def new_pane_text(before, after):
    """The part of `after` the agent added since `before` — the answer, not the start-up
    screen that was already there when the prompt went in."""
    if not before or not after:
        return after
    n = min(len(before), len(after))
    i = 0
    while i < n and before[i] == after[i]:
        i += 1
    return after[i:].lstrip("\n") if i else after


def drop_echoed_prompt(text, prompt):
    """Claude and pi echo the prompt in the input box; the dialog already shows what was
    asked, so the first line is not part of the answer."""
    first = (prompt or "").strip().split("\n")[0].strip()
    if not text or not first:
        return text
    lines = text.split("\n")
    for i, line in enumerate(lines[:3]):
        if first in line:
            return "\n".join(lines[i + 1:]).lstrip("\n")
    return text


def cmd_agent(a):
    host = herdr_target_host(a.host)
    where = host["name"] if host else local_host_name()
    if a.op == "list":
        rows = [dict(agent_row(x), host=where) for x in herdr_list_agents(host) if x.get("agent") not in RETIRED_AGENTS]

        def text(rows):
            for r in rows:
                print(f"{r['pane_id']:<8} {r['agent']:<10} {r['status']:<8} {(r['cwd'] or '').replace(HOME, '~'):<40} {r['title']}")
            if not rows:
                print(f"{where} 的 Herdr 里没有 Agent")
        return out(rows, a.json, text)

    if a.op == "start":
        kind = a.kind
        if kind in RETIRED_AGENTS:
            raise SystemExit("该 Agent 已不再支持")
        actor = KIND_ACTOR.get(kind, kind)
        cwd = a.cwd
        if not cwd and host is None:
            # From the app there is no meaningful "current directory": use the task's project folder, else home.
            if a.task:
                issue = bd_json(["show", a.task, "--json"])
                cwd = task_project_dir(issue) if issue.get("id") else ""
                if cwd == os.getcwd() and not any(l.startswith("project:") for l in issue.get("labels") or []):
                    cwd = HOME
            cwd = cwd or (os.getcwd() if sys.stdin.isatty() else HOME)
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
        if (a.auto or a.task) and not any(x in extra for x in AUTONOMOUS_ARGS.get(kind, [])):
            extra = AUTONOMOUS_ARGS.get(kind, []) + extra
        if extra:
            sargs += ["--"] + extra
        # The new tab's shell needs a while before it counts as "an available shell":
        # fish start-up (prime, env export) can take most of a minute on a busy Mac.
        started = None
        # fish start-up in a fresh tab (the prime hook reads the board and the index) can take
        # well over a minute on a loaded Mac: keep asking for ~3 minutes before giving up.
        for attempt in range(70):
            d = herdr(host, sargs, timeout=150)
            if isinstance(d, dict) and d.get("error") and "agent_pane_busy" in json.dumps(d.get("error")) and attempt < 69:
                time.sleep(2.5)
                continue
            started = herdr_ok(d, "起 Agent").get("agent", {})
            break
        me = os.environ.get("BEADS_ACTOR", "schaefer")
        if a.task:
            code, o, e = sh(["bd", "update", a.task, "--claim", "--json"], env={"BEADS_ACTOR": actor})
            # who handed the task to whom: labels the views read, a comment for the record
            sh(["bd", "update", a.task, "--add-label", f"delegated-by:{me}", "--add-label", f"delegated-to:{actor}", "--json"], env={"BEADS_ACTOR": me})
            note = f"{me} 通过 dispatch agent 派给 {actor}（Herdr {pane} @ {where}，目录 {cwd}）"
            sh(["bd", "comments", "add", a.task, note], env={"BEADS_ACTOR": me})
        res = {"host": where, "pane_id": pane, "tab_id": tab_id, "name": name, "kind": kind, "actor": actor, "cwd": cwd, "status": started.get("agent_status"), "task": a.task or "", "output": ""}
        if a.prompt:
            # Prompts to an unfocused tab are dropped, and a prompt typed before the agent's
            # input box exists (self-update, trust dialogs) is swallowed: wait for both.
            if tab_id:
                herdr(host, ["tab", "focus", tab_id])
            ready, pressed = wait_interactive(host, pane)
            if pressed:
                res["dismissed"] = True
            if not ready:
                res["warning"] = "等了 90 秒 Agent 还没准备好接收输入；提示词已尝试发送，看输出确认"
            before = strip_pane_chrome(read_pane(host, pane, a.lines))
            pargs = ["agent", "prompt", pane, a.prompt]
            if a.wait:
                pargs += ["--wait", "--until", "done", "--until", "idle", "--until", "blocked", "--timeout", str(a.timeout)]
            d = herdr(host, pargs, timeout=a.timeout // 1000 + 20)
            if isinstance(d, dict) and d.get("error") and dismiss_startup_dialogs(host, pane):
                # a dialog appeared after the prompt went in: answer it and send the prompt once more
                d = herdr(host, pargs, timeout=a.timeout // 1000 + 20)
            # Read only after the reply stops drawing: Herdr can report idle before the
            # answer is on screen, and --wait gives up when an agent never flips its state.
            res["output"] = drop_echoed_prompt(new_pane_text(before, strip_pane_chrome(read_pane(host, pane, a.lines, settle=True, cap=min(max(a.timeout // 1000, 15), 120)))), a.prompt)
            if isinstance(d, dict) and d.get("error"):
                info = herdr(host, ["agent", "get", pane])
                now = ((info.get("result") or {}).get("agent") or {}).get("agent_status")
                if res["output"] and res["output"] != before and now in ("idle", "done"):
                    res["status"] = now  # it did answer; Herdr just never saw the state flip
                else:
                    res["status"], res["warning"] = "stalled", (d["error"].get("message") or "")[:200] + "——看输出，可能在等你回答一个对话框（dispatch agent keys <pane> enter）"
            else:
                res["status"] = (d.get("result") or {}).get("agent", {}).get("agent_status")

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
        before = strip_pane_chrome(read_pane(host, pane, a.lines))
        d = herdr(host, pargs, timeout=a.timeout // 1000 + 20)
        err = (d.get("error") or {}).get("message", "") if isinstance(d, dict) else str(d)
        status = "stalled" if err else (d.get("result") or {}).get("agent", {}).get("agent_status")
        output = drop_echoed_prompt(new_pane_text(before, strip_pane_chrome(read_pane(host, pane, a.lines, settle=True, cap=min(max(a.timeout // 1000, 15), 120)))), a.text)
        if err and output and output != before:
            info = herdr(host, ["agent", "get", pane])
            now = ((info.get("result") or {}).get("agent") or {}).get("agent_status")
            if now in ("idle", "done"):
                status, err = now, ""  # it answered; Herdr just never saw the state flip
        res = {"host": where, "pane_id": pane, "status": status, "warning": err[:200], "output": output}
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
    what = getattr(a, "what", "run")
    args = ["url"] if what == "url" else (["qr"] + (["--svg"] if getattr(a, "svg", False) else [])) if what == "qr" else []
    sys.argv = ["serve"] + args
    runpy.run_path(os.path.join(os.path.dirname(os.path.realpath(__file__)), "serve.py"), run_name="__main__")


def cmd_hosts(a):
    refresh = getattr(a, "refresh", "")
    if refresh:
        for p in glob.glob(os.path.join(REMOTE_DIR, f"{refresh}.down")) + glob.glob(os.path.join(REMOTE_DIR, f"{refresh}--*.json")):
            try:
                os.remove(p)
            except OSError:
                pass
    rows = host_rows(local_only=getattr(a, "local", False))

    def text(rows):
        for r in rows:
            have = [k for k in ("novnc_up", "screen_sharing", "rustdesk", "sunshine", "uu") if r.get(k)]
            ov = (r.get("overlay") or {}).get("kind") or "-"
            print(f"{r['name']:<12} {r['ip']:<16} {'在线' if r['online'] else '离线'}  网:{ov:<10} 有:{','.join(have) or '无':<36} 推荐:{r.get('recommend') or '无'}  {r.get('why', '')}")
    out(rows, a.json, text)


def cmd_screen(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import screen_setup
    screen_setup.main(a)


def _only_theirs(rows):
    """A host answers with its own sessions only; anything it merged from *other* hosts
    (including ours, mirrored back) is dropped, otherwise two Macs amplify each other."""
    return [r for r in rows or [] if isinstance(r, dict) and r.get("agent") not in RETIRED_AGENTS and not r.get("remote") and r.get("host") in (None, "local")]


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
        if r.get("agent") in RETIRED_AGENTS:
            continue
        pid = r.get("agent_pid")
        if pid and pid not in table:
            continue
        r["alive"] = True
        r["registered"] = True
        seen.add(pid)
        seen_sids.add((r.get("agent"), r.get("session_id")))
        sessions.append(r)
    idx = None
    for pid, (ppid, comm) in table.items():
        base = os.path.basename(comm).lstrip("-")
        if base in ("claude", "codex") and pid not in seen:
            # No hook wrote a record (another person's terminal, hooks not installed): still
            # say where it runs and which transcript it most likely is, so it can be adopted.
            cwd = pid_cwd(pid)
            app = host_app_of(pid, table) or ""
            idx = idx if idx is not None else (load_index() or {})
            row = {"agent": "claude-code" if base == "claude" else "codex", "session_id": f"pid-{pid}", "agent_pid": pid, "cwd": cwd, "project": os.path.basename(cwd.rstrip("/")) if cwd else "", "source_kind": "terminal" if app else "unknown", "source_app": app or "未登记", "state": "unknown", "alive": True, "registered": False, "started_at": 0, "last_at": 0}
            guess = probable_session(idx, row["agent"], cwd)
            if guess:
                row["probable_session_id"] = guess["session_id"]; row["title"] = guess.get("title", ""); row["last_at"] = guess.get("mtime", 0)
            sessions.append(row)
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


def pid_cwd(pid):
    """Working directory of a process (lsof; ~50 ms, only used for unregistered agents)."""
    try:
        r = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], capture_output=True, text=True, timeout=3)
        return next((l[1:] for l in r.stdout.splitlines() if l.startswith("n/")), "")
    except Exception:
        return ""


def probable_session(idx, agent, cwd, within=6 * 3600):
    """The transcript an unregistered live process is most likely writing: same agent and
    directory, touched recently. A guess — callers say so."""
    if not cwd:
        return None
    now = time.time()
    cands = [e for e in idx.values() if e.get("agent") == agent and not e.get("subagent") and e.get("cwd") == cwd and now - (e.get("mtime") or 0) < within]
    return max(cands, key=lambda e: e.get("mtime") or 0) if cands else None


def cmd_sessions(a):
    s = live_sessions(local_only=getattr(a, "local", False))
    # The files each session touched, from the hook registry only: cheap enough for the
    # 5-second presence poll, and it covers agents the transcript index does not parse.
    edits = session_edit_map(window=30 * 60, with_activity=False)
    for x in s:
        rec = edits.get(x.get("session_id"))
        if rec and rec["files"]:
            x["editing"] = [{"path": f, "ts": ts} for f, ts in sorted(rec["files"].items(), key=lambda kv: -kv[1])]

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
        with open(INDEX_FILE) as f:
            return {path: row for path, row in json.load(f).items()
                    if row.get("agent") not in RETIRED_AGENTS}
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


STATS_V = 2  # bump to force a full re-parse when the per-session stats shape changes

# A skill is "used" when the agent opens its SKILL.md. Codex has no Skill tool: it expands the
# skills listed in its system prompt (r0/task-board/SKILL.md) and cats the file. ZCode does have a
# Skill tool. Both spellings end in skills/<name>/SKILL.md, whatever the root (pool, .agents, plugins).
RE_SKILL_FILE = re.compile(r'skills/(?:[^/"\s]+/)*([^/"\s]+)/SKILL\.md')


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
        elif '"function_call"' in line or '"custom_tool_call"' in line:
            # Only tool calls count — the system prompt also lists every skill's SKILL.md path.
            for m in RE_SKILL_FILE.finditer(line):
                e["skills"][m.group(1)] = e["skills"].get(m.group(1), 0) + 1
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
    for r in zcode_query("select json_extract(data,'$.state.input.skill') sk from part where session_id=? and json_extract(data,'$.type')='tool' and json_extract(data,'$.tool')='Skill'", (sid,)):
        if r["sk"]:
            e["skills"][r["sk"]] = e["skills"].get(r["sk"], 0) + 1


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


def resume_command(agent, sid, cwd):
    if agent == "zcode":
        # ZCode is a desktop app without a resume CLI; the session id identifies it inside the app.
        return f"open -a ZCode  # 会话 {sid}"
    cd = f"cd '{cwd.replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}' && " if cwd else ""
    return f"{cd}{'codex resume' if agent == 'codex' else 'pi --session' if agent == 'pi' else 'claude --resume'} {sid}"


def subagents_of(path):
    """Claude Code keeps subagent transcripts next to the parent: <sid>/subagents/agent-<id>.{jsonl,meta.json}.
    ZCode records them as child sessions (session.parent_id) plus session_task_link metadata."""
    if path.startswith("zcode:"):
        sid = path[6:]
        rows = zcode_query("select s.id, s.title, s.time_updated, s.summary_files, l.agent_type, l.label, l.depth from session s left join session_task_link l on l.child_session_id = s.id where s.parent_id = ? order by s.time_created", (sid,))
        return [{"agent_id": r["id"], "type": r["agent_type"] or "子会话", "description": r["label"] or r["title"], "tool_use_id": "", "depth": r["depth"] or 1, "size": 0, "last_at": r["time_updated"] / 1000, "path": "zcode:" + r["id"]} for r in rows]
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
    if e['agent'] == 'codex':
        from activity import codex_titles, user_text
        e = dict(e, title=codex_titles(HOME).get(e['session_id']) or user_text(e.get('title', '')))
    return {"agent": e["agent"], "session_id": e["session_id"], "cwd": e["cwd"], "project": git_root_name(e["cwd"]) or os.path.basename(e["cwd"].rstrip("/")), "title": e.get("title", ""), "first_prompt": e.get("first_prompt", ""), "last_at": e["mtime"], "first_ts": e.get("first_ts", ""), "last_ts": e.get("last_ts", ""), "entrypoint": e.get("entrypoint", ""), "branch": e.get("branch", ""), "user_msgs": e.get("user_msgs", 0), "assistant_msgs": e.get("assistant_msgs", 0), "tools": e.get("tools", {}), "tasks": e.get("tasks", {}), "mentions": e["tasks"].get(task_id, 0) if task_id else sum(e["tasks"].values()), "current_task": (e.get("claims") or [None])[-1], "resume_cmd": resume_command(e["agent"], e["session_id"], e["cwd"]), "path": path, "size": e.get("size", 0), "subagents": subagents_of(path) if e["agent"] in ("claude-code", "zcode") else []}


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


def _rank_sum(a_list, b_list, key, nums):
    """Add two rank lists (tools / skills / subagents / projects / models) by their name."""
    out = {}
    for x in (a_list or []) + (b_list or []):
        name = x.get(key) or ""
        cur = out.get(name)
        if cur is None:
            cur = dict(x)
            if "by" in x:
                cur["by"] = dict(x.get("by") or {})
            out[name] = cur
            continue
        for f in nums:
            cur[f] = cur.get(f, 0) + x.get(f, 0)
        if "by" in x or "by" in cur:
            cur["by"] = dict(cur.get("by") or {})
            for ag, n in (x.get("by") or {}).items():
                cur["by"][ag] = cur["by"].get(ag, 0) + n
        for f in ("cwd", "agent"):
            if not cur.get(f):
                cur[f] = x.get(f, "")
    return list(out.values())


def merge_stats(base, extra):
    """Fold another Mac's `dispatch stats --cached --local` into this one. Day buckets and
    the weekday×hour grid are added; ranks and projects are added by name; the day, streak
    and active-hour counts are recomputed from the merged buckets so a day both Macs worked
    on is not counted twice."""
    if not extra or not isinstance(extra, dict):
        return base
    days = {d["date"]: dict(d, by=dict(d.get("by") or {})) for d in base.get("days") or []}
    for d in extra.get("days") or []:
        cur = days.get(d["date"])
        if cur is None:
            days[d["date"]] = dict(d, by=dict(d.get("by") or {}))
            continue
        for k in ("msgs", "tokens", "in", "out", "cr", "cw"):
            cur[k] = cur.get(k, 0) + d.get(k, 0)
        for ag, n in (d.get("by") or {}).items():
            cur["by"][ag] = cur["by"].get(ag, 0) + n
    hours = [row[:] for row in (base.get("hours") or [[0] * 24 for _ in range(7)])]
    for w, row in enumerate(extra.get("hours") or []):
        if w >= len(hours):
            continue
        for h, n in enumerate(row):
            if h < len(hours[w]):
                hours[w][h] += n
    agents = {}
    for A in (base.get("agents") or []) + (extra.get("agents") or []):
        cur = agents.setdefault(A["agent"], {"agent": A["agent"], "sessions": 0, "msgs": 0, "tokens": {k: 0 for k in ("in", "out", "cr", "cw", "think")}, "total": 0, "days": 0})
        cur["sessions"] += A.get("sessions", 0)
        cur["msgs"] += A.get("msgs", 0)
        cur["total"] += A.get("total", 0)
        for k, n in (A.get("tokens") or {}).items():
            cur["tokens"][k] = cur["tokens"].get(k, 0) + n
    day_list = sorted(days.values(), key=lambda d: d["date"])
    active = [d["date"] for d in day_list if d.get("msgs", 0) > 0]
    from datetime import datetime as _dt
    cur = longest = run = 0
    prev = None
    for day in active:
        dd = _dt.strptime(day, "%Y-%m-%d").date()
        run = run + 1 if prev and (dd - prev).days == 1 else 1
        longest = max(longest, run)
        prev = dd
    from datetime import date as _date
    if prev and (_date.today() - prev).days <= 1:
        cur = run
    tot = {k: 0 for k in ("in", "out", "cr", "cw", "think")}
    for A in agents.values():
        for k in tot:
            tot[k] += (A["tokens"] or {}).get(k, 0)
        # No per-agent message count per day in the JSON; token presence is the best proxy.
        A["days"] = sum(1 for d in day_list if (d.get("by") or {}).get(A["agent"]))
    total_tokens = tot["in"] + tot["out"] + tot["cr"] + tot["cw"]
    bt, et = base.get("total") or {}, extra.get("total") or {}
    tools = _rank_sum(base.get("tools"), extra.get("tools"), "name", ("count",))
    skills = _rank_sum(base.get("skills"), extra.get("skills"), "name", ("count",))
    subs = _rank_sum(base.get("subagents"), extra.get("subagents"), "name", ("count",))
    projects = _rank_sum(base.get("projects"), extra.get("projects"), "name", ("tokens", "msgs", "sessions"))
    models = _rank_sum(base.get("models"), extra.get("models"), "model", ("msgs",))
    res = dict(base)
    res.update({
        "total": {
            "tokens": tot, "total": total_tokens,
            "sub_tokens": bt.get("sub_tokens", 0) + et.get("sub_tokens", 0),
            "msgs": sum(d.get("msgs", 0) for d in day_list),
            "sessions": sum(A["sessions"] for A in agents.values()),
            "active_days": len(active), "streak_cur": cur, "streak_max": longest,
            "tools_distinct": len(tools),
            "active_hours": sum(1 for row in hours for n in row if n) if not base.get("range_days") else None,
            "first_day": active[0] if active else "", "last_day": active[-1] if active else "",
        },
        "agents": sorted(agents.values(), key=lambda A: -A["total"]),
        "days": day_list, "hours": hours,
        "models": sorted(models, key=lambda m: -m.get("msgs", 0)),
        "tools": sorted(tools, key=lambda t: -t.get("count", 0))[:30],
        "skills": sorted(skills, key=lambda t: -t.get("count", 0))[:30],
        "subagents": sorted(subs, key=lambda t: -t.get("count", 0))[:30],
        "projects": sorted(projects, key=lambda p: -p.get("tokens", 0))[:20],
        "generated_at": max(base.get("generated_at", 0), extra.get("generated_at", 0)),
    })
    return res


def cmd_stats(a):
    """Everything the agents burned, across all of them: tokens, activity by day and hour,
    tools / skills / subagents, models, projects. Ranges filter days by activity date and
    sessions (tools, models, projects) by their last activity. Other Macs in hosts.json are
    merged in (`--local` skips them); their day buckets and hour grid are added."""
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
            # Same naming as the sessions list: the git root wins over the leaf folder; the home directory is "零散会话", not the user name.
            pname = "零散会话" if cwd == HOME.rstrip("/") else (git_root_name(cwd) or os.path.basename(cwd) or cwd)
            P = projects.setdefault(pname, {"name": pname, "cwd": cwd, "tokens": 0, "msgs": 0, "sessions": 0, "by": {}})
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
    if not getattr(a, "local", False):
        merged = []
        for h in hosts():
            rargs = ["stats", "--cached", "--local", "--days", str(days_n)] + (["--agent", a.agent] if a.agent else [])
            other = remote_dispatch(h, rargs, 120)
            if not other:
                continue
            res = merge_stats(res, other)
            merged.append(h["name"])
        if merged:
            res["hosts"] = [local_host_name()] + merged

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
    from activity import session_preferences
    preferences = session_preferences(DISPATCH_DIR)
    for r in refs:
        r.update(preferences.get(r["agent"] + ":" + r["session_id"], {}))
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


def _text_images(txt, cwd):
    """Attachment ids for pictures a message names by path (see attachments.scan)."""
    import hashlib
    from attachments import BARE_IMAGE, local_path
    ids = []
    for m in BARE_IMAGE.finditer(txt or ""):
        path = local_path(m[0], cwd)
        if path and os.path.isfile(path):
            key = hashlib.sha256(path.encode()).hexdigest()[:24]
            if key not in ids:
                ids.append(key)
    return ids


def _block_images(content):
    """Attachment ids for the pictures in a message (pasted, or returned by a tool), matching attachments.scan()."""
    import hashlib
    ids = []
    blocks = []
    for b in content if isinstance(content, list) else []:
        if not isinstance(b, dict):
            continue
        blocks.append(b)
        if b.get("type") == "tool_result" and isinstance(b.get("content"), list):
            blocks.extend(x for x in b["content"] if isinstance(x, dict))
    for b in blocks:
        if b.get("type") == "image" and (b.get("source") or {}).get("type") == "base64":
            src = b["source"]
            url = f"data:{src.get('media_type', 'image/png')};base64,{src.get('data', '')}"
            ids.append("embedded:" + hashlib.sha256(url.encode()).hexdigest()[:24])
    return ids


def _block_text(content):
    if isinstance(content, str):
        return content
    parts = []
    for b in content or []:
        if isinstance(b, dict) and b.get("type") == "text":
            parts.append(b.get("text", ""))
    return "\n".join(parts)


# ---- the block timeline ---------------------------------------------------------------
# Every parsed message carries `blocks`, the same shape for all four agents (field names are
# a contract with the app, keep them verbatim):
#   {"type": "thinking",  "text": …}
#   {"type": "text",      "text": …}
#   {"type": "tool_call", "id", "name", "summary", "input": {compact}, "status": running|done|error|incomplete,
#                         "result": short text, "result_ts": ts}
# `text` and `tools` stay on the message for the older readers (reply box, sibling merge).
LONG_TEXT = 24000
LONG_NOTE = "\n（这条消息过长，剩余内容请在原会话查看）"
RESULT_CHARS = 600
INPUT_CHARS = 400
RUNNING_GRACE = 180  # a tool call still unanswered this long after the last write is "incomplete", not "running"


def _clip(txt, n=LONG_TEXT):
    txt = txt or ""
    return txt[:n] + (LONG_NOTE if len(txt) > n else "")


def _result_text(content):
    """The visible part of a tool result: a string, or the text blocks of a list."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(b.get("text", ""))
            elif isinstance(b, dict) and b.get("type") == "image":
                parts.append("[图片]")
        return "\n".join(parts)
    if isinstance(content, dict):
        return _result_text(content.get("output") or content.get("text") or content.get("content") or "")
    return "" if content is None else str(content)


def _summarize_result(content, limit=RESULT_CHARS):
    txt = _result_text(content).strip()
    if len(txt) <= limit:
        return txt
    head = txt[: limit // 2].rstrip()
    tail = txt[-(limit // 4):].lstrip()
    return f"{head}\n…（省略 {len(txt) - len(head) - len(tail)} 字）…\n{tail}"


def _compact_input(inp):
    """Tool arguments small enough to ship to the UI: strings clipped, nested values summarized."""
    if not isinstance(inp, dict):
        return {"value": str(inp)[:INPUT_CHARS]} if inp not in (None, "") else {}
    out = {}
    for k, v in list(inp.items())[:12]:
        if k == "questions" and isinstance(v, list):
            out[k] = v  # AskUserQuestion: the UI renders the choices and answers them
        elif isinstance(v, str):
            out[k] = v[:INPUT_CHARS] + ("…" if len(v) > INPUT_CHARS else "")
        elif isinstance(v, (int, float, bool)) or v is None:
            out[k] = v
        else:
            s = json.dumps(v, ensure_ascii=False)
            out[k] = s[:INPUT_CHARS] + ("…" if len(s) > INPUT_CHARS else "")
    return out


class _Timeline:
    """Collects messages/blocks while a transcript is read; pairs tool results with their calls."""

    def __init__(self):
        self.msgs, self.files, self.tool_names = [], {}, {}
        self.pending = {}    # tool id -> block still waiting for its result
        self.resolved = []   # results whose call was read before this pass (incremental reads)

    def add(self, ts, role, blocks=None, **extra):
        blocks = [b for b in (blocks or []) if b.get("type") != "text" or b.get("text", "").strip()]
        text = "\n".join(b["text"] for b in blocks if b["type"] == "text")
        tools = [{"name": b["name"], "summary": b["summary"], "id": b["id"]} for b in blocks if b["type"] == "tool_call"]
        m = {"ts": ts, "role": role, "text": _clip(text), "tools": tools, "blocks": blocks, **extra}
        self.msgs.append(m)
        return m

    def tool(self, ts, id_, name, inp, summary):
        self.tool_names[name] = self.tool_names.get(name, 0) + 1
        b = {"type": "tool_call", "id": str(id_ or ""), "name": name, "summary": str(summary or "")[:200], "input": _compact_input(inp), "status": "running", "ts": ts}
        if b["id"]:
            self.pending[b["id"]] = b
        return b

    def resolve(self, id_, content, is_error, ts, status=None):
        status = status or ("error" if is_error else "done")
        b = self.pending.pop(str(id_ or ""), None)
        if b is None:
            if id_:
                self.resolved.append({"id": str(id_), "status": status, "result": _summarize_result(content), "result_ts": ts})
            return
        b["status"], b["result"], b["result_ts"] = status, _summarize_result(content), ts

    def note_file(self, path, kind, old, new, ts):
        self.files.setdefault(path, []).append({"kind": kind, "old": old or "", "new": new or "", "ts": ts})

    def finish(self, live):
        for b in self.pending.values():
            # A question to the person waits as long as it takes; it is still running.
            if b["status"] == "running" and not live and b["name"] != "AskUserQuestion":
                b["status"] = "incomplete"
        self.pending = {}


def _thinking_block(text, note=""):
    text = (text or "").strip()
    if not text and not note:
        note = "内容未记录（模型只留签名）"
    return {"type": "thinking", "text": text[:LONG_TEXT], **({"note": note} if note else {})}


def _zcode_status(state):
    s = (state or {}).get("status") or ""
    return {"completed": "done", "error": "error", "pending": "running", "running": "running"}.get(s, "done" if s else "running")


def read_zcode_detail(ref, limit, since=None):
    sid = ref["session_id"]
    tl = _Timeline()
    sql = "select p.data pdata, m.data mdata, p.time_created ts, p.time_updated tu from part p join message m on m.id = p.message_id where p.session_id=?"
    params = [sid]
    if since:
        sql += " and p.time_updated > ?"; params.append(int(since))
    rows = zcode_query(sql + " order by p.time_created, p.sequence", tuple(params))
    offset = int(since or 0)
    last, last_mid = None, None
    for r in rows:
        try:
            p = json.loads(r["pdata"]); m = json.loads(r["mdata"])
        except Exception:
            continue
        offset = max(offset, int(r.get("tu") or r["ts"] or 0))
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r["ts"] / 1000))
        role = "user" if m.get("role") == "user" else "assistant"
        mid = p.get("messageID") or m.get("id")
        # One assistant turn spans several parts (reasoning, text, tool…): one message with several blocks.
        if last is None or last_mid != mid or last["role"] != role:
            last = None
        t = p.get("type")
        # OpenCode rewrites a part while it streams; the part id lets a later read replace the earlier copy.
        if t == "text" and p.get("text", "").strip():
            block = {"type": "text", "text": p["text"][:LONG_TEXT], **({"id": p["id"]} if p.get("id") else {})}
        elif t == "reasoning":
            if not (p.get("text") or "").strip():
                continue
            block = {**_thinking_block(p.get("text", "")), **({"id": p["id"]} if p.get("id") else {})}
        elif t == "tool":
            name = p.get("tool", "")
            st = p.get("state") or {}
            inp = st.get("input") or {}
            summary = inp.get("command") or inp.get("filePath") or inp.get("file_path") or inp.get("description") or inp.get("pattern") or st.get("title") or ""
            block = tl.tool(ts, p.get("callID") or p.get("id"), name, inp, summary)
            status = _zcode_status(st)
            if status != "running":
                tl.resolve(block["id"], st.get("output") or st.get("error") or "", status == "error", ts, status)
            fp = inp.get("filePath") or inp.get("file_path")
            if fp and name.lower() == "edit":
                tl.note_file(fp, "edit", inp.get("oldString", ""), inp.get("newString", ""), ts)
            elif fp and name.lower() == "write":
                tl.note_file(fp, "write", "", inp.get("content", ""), ts)
        else:
            continue
        if last is not None and role == "assistant":
            last["blocks"].append(block)
            if block["type"] == "text":
                last["text"] = _clip("\n".join(b["text"] for b in last["blocks"] if b["type"] == "text"))
            elif block["type"] == "tool_call":
                last["tools"].append({"name": block["name"], "summary": block["summary"], "id": block["id"]})
        else:
            last = tl.add(ts, role, [block], **({"mid": mid} if mid and role == "assistant" else {})); last_mid = mid
    return _finish_detail(ref, tl, limit, since, offset, live=bool(rows) and time.time() - offset / 1000 < RUNNING_GRACE)


def _finish_detail(ref, tl, limit, since, offset, live):
    tl.finish(live)
    msgs = tl.msgs
    if since is None and len(msgs) > limit:
        msgs = msgs[:40] + [{"ts": "", "role": "gap", "text": f"…省略 {len(msgs) - limit} 条…", "tools": [], "blocks": []}] + msgs[-(limit - 40):]
    d = {"meta": ref, "messages": msgs, "files": [{"path": p, "changes": c} for p, c in tl.files.items()], "tool_counts": tl.tool_names, "offset": offset}
    if since is not None:
        d["partial"] = True
        d["since"] = since
        d["resolved"] = tl.resolved
    return d


def read_session_detail(ref, limit=400, since=None):
    """Parse one transcript into a block timeline + file changes (from Edit/Write tool calls).

    `since` is the byte offset (zcode: time_updated) a previous read stopped at; with it only the
    new records are parsed and the result carries `partial`, `resolved` (results for tool calls
    already shown) and the new `offset` to continue from."""
    if ref["agent"] == "zcode":
        return read_zcode_detail(ref, limit, since)
    tl = _Timeline()
    seen_tool_images = []
    path = ref["path"]
    last, last_mid = None, None  # the assistant message still being assembled, and its transcript id
    from activity import user_text, is_synthetic_user, patch_files

    def assistant(ts, mid, blocks, **extra):
        nonlocal last, last_mid
        if last is not None and mid and last_mid == mid:
            last["blocks"].extend(b for b in blocks if b.get("type") != "text" or b.get("text", "").strip())
            if extra.get("images"):
                last["images"] = [*last.get("images", []), *[i for i in extra["images"] if i not in last.get("images", [])]]
            last["text"] = _clip("\n".join(b["text"] for b in last["blocks"] if b["type"] == "text"))
            last["tools"] = [{"name": b["name"], "summary": b["summary"], "id": b["id"]} for b in last["blocks"] if b["type"] == "tool_call"]
            return last
        last = tl.add(ts, "assistant", blocks, **({"mid": mid} if mid else {}), **extra); last_mid = mid
        return last

    def other(m):
        nonlocal last
        last = None
        return m

    codex_turn = ""
    offset = int(since or 0)
    try:
        st = os.stat(path)
    except OSError:
        st = None
    with open(path, "rb") as f:
        if offset:
            f.seek(offset)
        while True:
            raw = f.readline()
            if not raw:
                break
            if not raw.endswith(b"\n"):
                break  # an in-flight record: read it next time
            offset = f.tell()
            try:
                d = json.loads(raw.decode("utf-8", "replace"))
            except Exception:
                continue
            if not isinstance(d, dict):
                continue
            t = d.get("type")
            if ref["agent"] == "pi":
                if t != "message":
                    continue
                m = d.get("message") or {}
                role, ts, c = m.get("role", ""), d.get("timestamp", ""), m.get("content")
                blocks_in = c if isinstance(c, list) else [{"type": "text", "text": c or ""}]
                blocks = []
                for b in blocks_in:
                    if not isinstance(b, dict):
                        continue
                    bt = b.get("type")
                    if bt == "text":
                        blocks.append({"type": "text", "text": (b.get("text") or "")[:LONG_TEXT]})
                    elif bt == "thinking":
                        blocks.append(_thinking_block(b.get("thinking") or b.get("text") or "", "内容被打码" if b.get("redacted") else ""))
                    elif bt == "toolCall":
                        name = b.get("name", ""); inp = b.get("arguments") or b.get("input") or {}
                        blocks.append(tl.tool(ts, b.get("id"), name, inp, inp.get("command") or inp.get("path") or inp.get("file_path") or ""))
                        fp = inp.get("path") or inp.get("file_path")
                        if fp and name in ("edit", "write"):
                            tl.note_file(fp, name, inp.get("oldText", ""), inp.get("newText", inp.get("content", "")), ts)
                    elif bt == "toolResult":
                        tl.resolve(b.get("toolCallId") or b.get("id"), b.get("content") or b.get("output") or b.get("result"), bool(b.get("isError") or b.get("is_error")), ts)
                if role == "toolResult":
                    tl.resolve(m.get("toolCallId") or m.get("id"), c, bool(m.get("isError")), ts)
                    continue
                if role in ("user", "assistant") and any(b["type"] != "text" or b["text"].strip() for b in blocks):
                    if role == "assistant":
                        assistant(ts, m.get("id") or d.get("id"), blocks)
                    else:
                        other(tl.add(ts, "user", blocks))
                continue
            if ref["agent"] == "codex":
                # Codex rollouts: {"type":"event_msg"/"response_item", payload:{...}}; content blocks are input_text/output_text.
                p = d.get("payload", {})
                ts = d.get("timestamp", "")
                pt = p.get("type")
                if t != "response_item":
                    continue
                if last is None:
                    codex_turn = ts or "turn"
                if pt == "message":
                    role = p.get("role", "")
                    txt = "\n".join(b.get("text", "") for b in p.get("content") or [] if isinstance(b, dict) and b.get("type") in ("input_text", "output_text", "text"))
                    if role == "user":
                        txt = user_text(txt)
                    if txt.strip() and role == "user":
                        other(tl.add(ts, "user", [{"type": "text", "text": txt[:LONG_TEXT]}]))
                    elif txt.strip() and role == "assistant":
                        assistant(ts, codex_turn, [{"type": "text", "text": txt[:LONG_TEXT]}])
                elif pt == "reasoning":
                    summary = p.get("summary") or []
                    txt = "\n".join((s.get("text") if isinstance(s, dict) else str(s)) or "" for s in summary).strip()
                    assistant(ts, codex_turn, [_thinking_block(txt) if txt else _thinking_block("", "未开启可读摘要（model_reasoning_summary）")])
                elif pt in ("function_call", "custom_tool_call"):
                    name = p.get("name", "")
                    args = p.get("arguments", p.get("input", ""))
                    summary = args
                    aj = {}
                    try:
                        aj = json.loads(args) if isinstance(args, str) else (args or {})
                        if isinstance(aj, dict):
                            summary = aj.get("cmd") or aj.get("command") or aj.get("path") or aj.get("file_path") or args
                            if isinstance(summary, list):
                                summary = " ".join(map(str, summary))
                            fp = aj.get("path") or aj.get("file_path")
                            if name.split(".")[-1] == "apply_patch":
                                tl.note_file("(apply_patch)", "edit", "", str(aj.get("input") or args)[:20000], ts)
                            elif fp and name in ("write_file", "edit_file"):
                                tl.note_file(fp, "write", "", str(aj.get("content", ""))[:20000], ts)
                        else:
                            aj = {}
                    except Exception:
                        aj = {}
                    for fp in (patch_files(str(args)) if name.split(".")[-1] == "apply_patch" else []):
                        tl.note_file(fp, "patch", "", str(args)[:20000], ts)
                    block = tl.tool(ts, p.get("call_id") or p.get("id"), name, aj if aj else {"input": str(args)}, summary)
                    assistant(ts, codex_turn, [block])
                elif pt in ("function_call_output", "custom_tool_call_output"):
                    outp = p.get("output")
                    if isinstance(outp, dict):
                        is_err = bool(outp.get("is_error")) or (outp.get("metadata") or {}).get("exit_code") not in (None, 0)
                        outp = outp.get("output") or outp.get("content") or outp
                    else:
                        is_err = False
                    if isinstance(outp, str) and outp.startswith("Chunk ID:"):
                        # exec_command wraps the output in a header; the exit code is the status.
                        code = re.search(r"Process exited with code (\d+)", outp)
                        is_err = is_err or bool(code and code.group(1) != "0")
                        outp = outp.split("Output:\n", 1)[1] if "Output:\n" in outp else outp
                    tl.resolve(p.get("call_id"), outp, is_err, ts)
                    last = None
                continue
            if t not in ("user", "assistant"):
                continue
            if d.get("isSidechain") and not ref.get("subagent_view"):
                continue
            m = d.get("message") or {}
            content = m.get("content")
            ts = d.get("timestamp", "")
            if t == "user":
                if isinstance(content, list) and content and isinstance(content[0], dict) and content[0].get("type") == "tool_result":
                    seen_tool_images = _block_images(content)  # a picture the agent looked at; shown with the caption turn that follows
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_result":
                            tl.resolve(b.get("tool_use_id"), b.get("content"), bool(b.get("is_error")), ts)
                    continue
                txt = _block_text(content)
                if re.fullmatch(r"\s*(\[Image:[^\]]*\]\s*)+", txt) and not _block_images(content):
                    if seen_tool_images:
                        other(tl.add(ts, "tool", [{"type": "text", "text": "查看了图片"}], images=seen_tool_images))
                    seen_tool_images = []
                    continue
                # Slash-command echoes and caveats are injected by the CLI, not typed by the user.
                if txt.lstrip().startswith(("<local-command", "<command-name>", "<command-message>", "<system-reminder>")):
                    continue
                images = _block_images(content)
                if images:
                    # The "[Image: original …]" caption only describes the picture; show the picture.
                    txt = re.sub(r"\[Image:[^\]]*\]", "", txt).strip()
                images += [i for i in _text_images(txt, ref.get("cwd", "")) if i not in images]
                if is_synthetic_user(txt) and not images:
                    # Hook output / background-task notice: shown as a system event, never as "you said".
                    m2 = re.search(r"<summary>([\s\S]*?)</summary>", txt)
                    other(tl.add(ts, "user", [{"type": "text", "text": (m2.group(1).strip() if m2 else txt.strip())[:600]}], synthetic=True))
                    continue
                if txt.strip() or images:
                    other(tl.add(ts, "user", [{"type": "text", "text": txt[:LONG_TEXT]}], **({"images": images} if images else {})))
            else:
                blocks = []
                for b in content if isinstance(content, list) else ([{"type": "text", "text": content}] if isinstance(content, str) else []):
                    if not isinstance(b, dict):
                        continue
                    bt = b.get("type")
                    if bt == "text":
                        blocks.append({"type": "text", "text": (b.get("text") or "")[:LONG_TEXT]})
                    elif bt == "thinking":
                        blocks.append(_thinking_block(b.get("thinking") or ""))
                    elif bt == "redacted_thinking":
                        blocks.append(_thinking_block("", "内容被打码"))
                    elif bt == "tool_use":
                        name = b.get("name", "")
                        inp = b.get("input") or {}
                        summary = inp.get("command") or inp.get("file_path") or inp.get("description") or inp.get("prompt") or inp.get("pattern") or inp.get("url") or ""
                        blocks.append(tl.tool(ts, b.get("id", ""), name, inp, summary))
                        fp = inp.get("file_path")
                        if name == "Edit" and fp:
                            tl.note_file(fp, "edit", inp.get("old_string", ""), inp.get("new_string", ""), ts)
                        elif name == "Write" and fp:
                            tl.note_file(fp, "write", "", inp.get("content", ""), ts)
                        elif name in ("NotebookEdit",) and fp:
                            tl.note_file(fp, "edit", "", inp.get("new_source", ""), ts)
                if any(b["type"] != "text" or b["text"].strip() for b in blocks):
                    shots = _text_images("\n".join(b["text"] for b in blocks if b["type"] == "text"), ref.get("cwd", ""))
                    assistant(ts, m.get("id") or d.get("requestId"), blocks, **({"images": shots} if shots else {}))
    live = bool(st) and time.time() - st.st_mtime < RUNNING_GRACE
    return _finish_detail(ref, tl, limit, since, offset, live)


def remote_session_detail(key):
    """A session that is not in the local index may live on another Mac."""
    for h in hosts():
        d = remote_dispatch(h, ["session", key], 3)
        if isinstance(d, dict) and d.get("meta"):
            _tag_host([d["meta"]], h)
            d["meta"]["remote"] = True
            d["meta"]["resume_cmd"] = f"ssh -t {h['ssh']} {json.dumps(d['meta'].get('resume_cmd', ''))}"
            return d
    return None


def cmd_activity(a):
    from activity import activity_list
    rows = activity_list(HOME, DISPATCH_DIR, load_index())
    _tag_host(rows, {"id": "local", "name": local_host_name()})
    unavailable = []
    if not a.local:
        for h in hosts():
            remote = remote_dispatch(h, ["activity", "--local"], 5)
            if not isinstance(remote, dict) or time.time() - remote.get("updated_at", 0) > 25:
                unavailable.append(h["name"])
            if isinstance(remote, dict):
                more = _tag_host(_only_theirs(remote.get("sessions", [])), h)
                for r in more:
                    r["remote"] = True
                    if h["name"] in unavailable: r["stale"] = True
                rows.extend(more)
    out({"sessions": sorted(rows, key=lambda r: -r["last_at"]), "updated_at": time.time(), "unavailable_hosts": unavailable}, a.json, lambda x: print(json.dumps(x, ensure_ascii=False)))


def cmd_session_preferences(a):
    from activity import set_preferences
    out(set_preferences(DISPATCH_DIR, a.key, json.loads(a.changes)), a.json, lambda x: print(json.dumps(x, ensure_ascii=False)))


def cmd_seen(a):
    from activity import acknowledge, unacknowledge
    if a.reply == "unread":  # the same transport, reversed: drop the receipt
        return out(unacknowledge(DISPATCH_DIR, a.key), a.json, lambda _: print("已标为未读"))
    out(acknowledge(DISPATCH_DIR, a.key, a.reply), a.json, lambda _: print("已读"))


def cmd_adopt(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import session_control
    from session_reply import Rejected
    try:
        r = session_control.adopt(sys.modules[__name__], {"session_id": a.key, "keep": a.keep, "force": a.force})
    except Rejected as e:
        raise SystemExit(str(e))
    def text(r):
        print(r["message"])
        print(f"进度：dispatch session-control status（request_id {r['request_id']}）；Herdr 标签起来后会话页会自动出现它")
    out(r, a.json, text)


# ---------------------------------------------------------------- commits: what a task became in git

_HASH_RE = re.compile(r"\b[0-9a-f]{7,40}\b")


def git_root_of(path):
    code, o, _ = sh(["git", "-C", path, "rev-parse", "--show-toplevel"], timeout=5)
    return o.strip() if code == 0 else ""


def task_commits(tid, issue=None, comments=None):
    """Commits that belong to a task: those whose message names the task id, plus hashes
    written into its close reason / comments (`commit 3abefc0`). Looked up in the project's
    repo (the task's project dir → git root)."""
    if issue is None:
        code, o, _ = sh(["bd", "show", tid, "--json"])
        if code != 0:
            return {"root": "", "commits": []}
        d = json.loads(o[o.find("[") if o.find("[") >= 0 and o.find("[") < o.find("{") else o.find("{"):])
        issue = d[0] if isinstance(d, list) else d
    if comments is None:
        comments = bd_comments(tid)
    root = git_root_of(task_project_dir(issue))
    if not root:
        return {"root": "", "commits": []}
    seen, out = set(), []

    def add(h):
        code, o, _ = sh(["git", "-C", root, "show", "-s", "--format=%H%x1f%h%x1f%ad%x1f%an%x1f%s", "--date=iso-strict", h], timeout=5)
        if code != 0 or not o.strip():
            return
        full, short, date, author, subject = o.strip().split("\x1f", 4)
        if full in seen:
            return
        seen.add(full)
        _, st, _ = sh(["git", "-C", root, "show", "--stat=200", "--format=", full], timeout=5)
        files = [l.split("|")[0].strip() for l in st.splitlines() if "|" in l]
        m = re.search(r"(\d+) insertion", st); n = re.search(r"(\d+) deletion", st)
        out.append({"hash": full, "short": short, "date": date, "author": author, "subject": subject, "files": files[:40], "file_count": len(files), "add": int(m.group(1)) if m else 0, "del": int(n.group(1)) if n else 0})

    code, o, _ = sh(["git", "-C", root, "log", "--all", "--format=%H", f"--grep={re.escape(tid)}", "-n", "50"], timeout=10)
    for h in (o.split() if code == 0 else []):
        add(h)
    text = " ".join([issue.get("close_reason") or "", issue.get("notes") or ""] + [c.get("text", "") for c in comments])
    for h in _HASH_RE.findall(text):
        if len(h) >= 7 and not h.isdigit():
            add(h)
    out.sort(key=lambda c: c["date"], reverse=True)
    remote = ""
    code, o, _ = sh(["git", "-C", root, "remote", "get-url", "origin"], timeout=5)
    if code == 0:
        u = o.strip()
        m = re.match(r"(?:git@github\.com:|https://github\.com/)([^/]+/[^/.]+?)(?:\.git)?$", u)
        remote = f"https://github.com/{m.group(1)}" if m else ""
    return {"root": root, "remote": remote, "commits": out}


def cmd_save_image(a):
    """Store a pasted picture for a discussion (base64 JSON on stdin) and print its path, so the
    agents' Read tool can look at it. ~/tasks/.dispatch/images/<stamp>-<n>.<ext>."""
    import base64
    d = json.loads(sys.stdin.read() or "{}")
    data = d.get("data", "")
    if data.startswith("data:"):
        data = data.split(",", 1)[1]
    raw = base64.b64decode(data)
    if len(raw) > 20 * 1024 * 1024:
        raise SystemExit("图片超过 20 MB")
    ext = "jpg" if raw[:3] == b"\xff\xd8\xff" else "png" if raw[:4] == b"\x89PNG" else "gif" if raw[:3] == b"GIF" else "webp" if raw[8:12] == b"WEBP" else "bin"
    folder = os.path.join(DISPATCH_DIR, "images")
    os.makedirs(folder, exist_ok=True)
    name = re.sub(r"[^\w.-]", "_", (d.get("name") or "image"))[:40].rsplit(".", 1)[0]
    path = os.path.join(folder, f"{time.strftime('%Y%m%d-%H%M%S')}-{name}.{ext}")
    open(path, "wb").write(raw)
    out({"path": path, "size": len(raw)}, a.json, lambda x: print(x["path"]))


def cmd_commits(a):
    r = task_commits(a.task)

    def text(r):
        if not r["commits"]:
            print("没有找到这个任务的提交（提交信息里带任务 id，或在完成说明里写 commit 哈希，就能对上）")
        for c in r["commits"]:
            print(f"{c['short']}  {c['date'][:16]}  +{c['add']} −{c['del']}  {c['subject'][:90]}")
    out(r, a.json, text)


def cmd_session_control(a):
    from session_control import command
    command(sys.modules[__name__], a)


def cmd_reply(a):
    from session_reply import command
    command(sys.modules[__name__], a)


def cmd_attachment(a):
    from attachments import read, catalog, local_path, thumbs
    if "/sub/" in a.key:
        ref = subagent_ref(load_index(), a.key)
        refs = [ref] if ref else []
    else:
        refs = resolve(load_index(), a.key)
        if not refs: refs = resolve(refresh_index(), a.key)
    if not refs: raise ValueError("本机找不到这个会话")
    first = refs[0]
    if a.ref == "--thumbs" or getattr(a, "thumbs", False):
        return out(thumbs(first), True, None)
    for ref in refs:
        if (ref['agent'], ref['session_id']) != (first['agent'], first['session_id']): continue
        path = local_path(a.ref, ref.get('cwd',''))
        if any(x['id'] == a.ref or (path and x['path'] == path) for x in catalog(ref)):
            return out(read(ref, a.ref), a.json, lambda d: print(json.dumps(d, ensure_ascii=False)))
    raise ValueError('文件未附加或链接在此会话中')


def subagent_ref(idx, key):
    """`<session-key>/sub/<agent-id>`: the transcript of one sub-agent a session dispatched,
    presented as a session of its own (same agent kind and cwd, its description as title)."""
    parent_key, aid = key.split("/sub/", 1)
    refs = resolve(idx, parent_key) or resolve(refresh_index(), parent_key)
    for r in refs:
        for sub in subagents_of(r["path"]):
            if sub["agent_id"] == aid or sub["agent_id"].startswith(aid):
                return dict(r, path=sub["path"], session_id=f"{r['session_id']}/sub/{sub['agent_id']}", title=f"↳ {sub['type'] or '子 Agent'} · {sub['description'] or aid[:8]}",
                            subagents=[], subagent_view=True, parent_session_id=r["session_id"], user_msgs=0, size=sub["size"], resume_cmd="")
    return None


def cmd_session(a):
    idx = load_index()
    if "/sub/" in a.key:
        ref = subagent_ref(idx, a.key)
        if not ref:
            print(f"找不到子 Agent {a.key}", file=sys.stderr); sys.exit(1)
        d = read_session_detail(ref)
        from attachments import catalog
        d["attachments"] = catalog(ref)
        return out(d, a.json, lambda d: print(f"{d['meta']['title']} · {len(d['messages'])} 条 · 改动文件 {len(d['files'])}"))
    refs = resolve(idx, a.key)
    if not refs: refs = resolve(refresh_index(), a.key)
    since = getattr(a, "since", None)
    if since is not None:
        # Live tail: only what was appended after the offset a previous read returned.
        if not refs:
            print(f"找不到 {a.key}", file=sys.stderr); sys.exit(1)
        d = read_session_detail(refs[0], since=max(0, int(since)))
        return out(d, a.json, lambda d: print(f"+{len(d['messages'])} 条 · 已完成工具 {len(d['resolved'])} · offset {d['offset']}"))
    # Freeze the reply cursor before parsing the displayed content: a concurrently
    # appended reply must never be acknowledged before it was actually returned.
    st = {}
    if refs and refs[0]['agent'] in ('codex', 'claude-code'):
        from activity import read_stream, connect
        from contextlib import closing
        with closing(connect(DISPATCH_DIR)) as db, db:
            st = read_stream(db, refs[0]['path'], refs[0]['agent'])
    d = read_session_detail(refs[0]) if refs else remote_session_detail(a.key)
    if d and refs:
        from activity import workspace_changes
        from attachments import catalog
        siblings = [r for r in refs if (r['agent'],r['session_id']) == (refs[0]['agent'],refs[0]['session_id'])]
        assets = {}; messages = {}
        for ref in reversed(siblings):
            for asset in catalog(ref): assets[asset['id']] = asset
            part = d if ref['path'] == refs[0]['path'] else read_session_detail(ref)
            for message in part['messages']:
                key = (message['ts'],message['role'],message['text'],json.dumps(message.get('tools',[]),sort_keys=True))
                messages[key] = message
        d['attachments'] = list(assets.values())
        d['messages'] = sorted(messages.values(), key=lambda m: m['ts'])
        d['workspace'] = workspace_changes(refs[0]['cwd'])
        d['activity_version'] = st.get('version')
        d['reply_id'] = st.get('reply_id')
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
            for b in x.get("blocks") or []:
                if b["type"] == "thinking":
                    print(f"[{x['role']}] 💭 {(b.get('text') or b.get('note') or '')[:120].replace(chr(10), ' ')}")
                elif b["type"] == "tool_call":
                    mark = {"done": "✓", "error": "✗", "running": "…", "incomplete": "?"}.get(b["status"], "")
                    print(f"[{x['role']}] ⚙ {b['name']} {b['summary'][:80]}  {mark}{(' ' + b['result'][:60].replace(chr(10), ' ')) if b.get('result') else ''}")
                else:
                    print(f"[{x['role']}] {b['text'][:160].replace(chr(10), ' ')}")
            if not x.get("blocks") and x.get("text"):
                print(f"[{x['role']}] {x['text'][:160].replace(chr(10), ' ')}")
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
    if ':' in key:
        agent, sid = key.split(':', 1)
        return [r for r in session_refs(idx, session_id=sid) if r['agent'] == agent]
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
    """Per-skill invocation counts by agent, from the transcript index. Claude Code records
    Skill tool and slash-command calls; Codex records reads of a skill's SKILL.md (it has no
    Skill tool); ZCode records its Skill tool calls."""
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


# A new skill starts from the same four fields every useful SKILL.md has: the name and the
# one-line trigger in the frontmatter, then 触发条件 / 关键约束 in the body. Anything longer is
# the agent's job to fill in once the skill is actually used.
SKILL_TEMPLATE = '''---
name: {name}
description: "{description}"
---

# {name}

{description}

## 触发条件

- {trigger}

## 关键约束

- {constraint}
'''


def safe_skill_name(n):
    """A skill is a folder in the pool: no separators, no leading dot, keep CJK."""
    n = (n or "").strip()
    if not n or n in (".", "..") or n.startswith("."):
        return ""
    if not re.fullmatch(r"[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff._-]*", n):
        return ""
    return n


def want_agents(a):
    """--agent may repeat (claude/codex/all); none = create without mounting."""
    raw = a.agent if isinstance(a.agent, list) else ([a.agent] if a.agent else [])
    if "all" in raw:
        return list(AGENT_SKILL_DIRS)
    picked = []
    for x in raw:
        if x in AGENT_SKILL_DIRS and x not in picked:
            picked.append(x)
    return picked


def mount_skill(name, path, agents):
    """Symlink the skill into each agent's first skills dir (what `skills enable` does)."""
    mounts = {}
    for ag in agents:
        d = AGENT_SKILL_DIRS[ag][0]
        os.makedirs(d, exist_ok=True)
        link = os.path.join(d, name)
        if not (os.path.islink(link) or os.path.exists(link)):
            os.symlink(path, link)
        cc_switch_flag(name, ag, True)
        mounts[ag] = link
    return mounts


def cmd_skills_new(a):
    name = safe_skill_name(a.name)
    if not name:
        print("技能名不合法：用字母/数字/中文/点/下划线/连字符，别用斜杠或开头点", file=sys.stderr)
        sys.exit(2)
    dest = os.path.join(POOL, name)
    if os.path.exists(dest):
        print(f"{name} 已经存在（{dest}）——换个名字，或先在技能页删掉它", file=sys.stderr)
        sys.exit(2)
    description = (a.description or "").strip() or f"用户要做{name}相关的事时用。"
    body = SKILL_TEMPLATE.format(
        name=name,
        description=description.replace('"', "'"),
        trigger=(a.trigger or f"用户明确要做{name}相关的事时用。").strip(),
        constraint=(a.constraint or "先确认本机实际路径与命令；只写模型推不出来的内容。").strip(),
    )
    os.makedirs(dest, exist_ok=True)
    with open(os.path.join(dest, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write(body)
    agents = want_agents(a)
    mounts = mount_skill(name, dest, agents)
    res = {"name": name, "path": dest, "description": description, "agents": agents, "mounts": mounts}
    out(res, a.json, lambda r: print(f"已新建 {r['name']}：{r['path']}" +
                                     (f"\n已挂给 {', '.join(r['agents'])}（新会话生效）" if r["agents"] else "\n还没挂给任何 Agent——在技能页勾选即可")))


# ---- import a skill from a public GitHub repo ----

GH_URL_RE = re.compile(r"^https?://(?:www\.)?github\.com/([^/]+)/([^/]+?)(?:\.git)?(?:/tree/([^/]+)(?:/(.*))?)?/?$")
GH_RAW_RE = re.compile(r"^https?://raw\.githubusercontent\.com/([^/]+)/([^/]+)/([^/]+)/(.+)$")


def parse_github_ref(url):
    """owner/repo[@branch][/sub/path] or a GitHub URL → (owner, repo, branch, subpath)."""
    u = (url or "").strip().rstrip("/")
    if not u:
        return None
    m = GH_RAW_RE.match(u)
    if m:
        owner, repo, branch, path = m.groups()
        return owner, repo, branch, os.path.dirname(path)
    m = GH_URL_RE.match(u)
    if m:
        owner, repo, branch, path = m.group(1), m.group(2), m.group(3) or "", (m.group(4) or "").strip("/")
        return owner, repo, branch, path
    m = re.match(r"^([\w.-]+)/([\w.-]+?)(?:@([\w.-]+))?(?:/(.+))?$", u)
    if m:
        return m.group(1), m.group(2), m.group(3) or "", (m.group(4) or "").strip("/")
    return None


def gh_fetch_text(url, timeout=20):
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "dispatch-skill-import", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def github_default_branch(owner, repo):
    try:
        return json.loads(gh_fetch_text(f"https://api.github.com/repos/{owner}/{repo}")).get("default_branch") or ""
    except Exception:
        return ""


def download_repo(owner, repo, branch):
    """codeload tarball → a temp dir. Tries the given branch, then main/master, then the API default."""
    import urllib.request
    tried, errors = [], []
    for b in ([branch] if branch else []) + ["main", "master", github_default_branch(owner, repo)]:
        b = (b or "").strip()
        if not b or b in tried:
            continue
        tried.append(b)
        tmp = tempfile.mkdtemp(prefix="dispatch-skill-")
        tgz = os.path.join(tmp, "repo.tar.gz")
        try:
            req = urllib.request.Request(f"https://codeload.github.com/{owner}/{repo}/tar.gz/refs/heads/{b}", headers={"User-Agent": "dispatch-skill-import"})
            with urllib.request.urlopen(req, timeout=300) as r, open(tgz, "wb") as f:
                shutil.copyfileobj(r, f)
            with tarfile.open(tgz, "r:gz") as tf:
                try:
                    tf.extractall(tmp, filter="data")   # Python 3.12+ guards path traversal
                except TypeError:
                    tf.extractall(tmp)
            os.remove(tgz)
            roots = [os.path.join(tmp, n) for n in os.listdir(tmp)]
            root = next((p for p in roots if os.path.isdir(p)), tmp)
            return os.path.realpath(root), b, tmp
        except Exception as e:
            errors.append(f"{b}: {e}")
            shutil.rmtree(tmp, ignore_errors=True)
    raise RuntimeError(f"下载 {owner}/{repo} 失败（试过 {', '.join(tried) or '默认分支'}）。检查仓库是否公开、地址是否写对。" +
                       ("\n" + "\n".join(errors[:3]) if errors else ""))


def find_skill_dirs(root, subpath=""):
    base = os.path.realpath(os.path.join(root, subpath)) if subpath else os.path.realpath(root)
    if not os.path.isdir(base) or not base.startswith(os.path.realpath(root)):
        return []
    hits = []
    for dp, dns, fns in os.walk(base):
        dns[:] = [d for d in dns if d not in (".git", "node_modules", "__pycache__")]
        if "SKILL.md" in fns:
            hits.append(dp)
    return hits


def repo_license(root, sub=""):
    for base in ([sub, root] if sub and sub != root else [root]):
        for n in ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "COPYING.md"):
            if os.path.isfile(os.path.join(base, n)):
                return os.path.join(base, n)
    return ""


def add_frontmatter_source(skill_md, url):
    """Record where an imported skill came from, without touching the rest of the file."""
    try:
        txt = open(skill_md, encoding="utf-8").read()
    except Exception:
        return
    if re.search(r"^source:", txt, re.M) or not txt.startswith("---"):
        return
    end = txt.find("\n---", 3)
    if end < 0:
        return
    open(skill_md, "w", encoding="utf-8").write(txt[:end + 1] + f"source: {url}\n" + txt[end + 1:])


def cmd_skills_import(a):
    ref = parse_github_ref(a.name)
    if not ref:
        print(f"看不懂这个地址：{a.name}。给 owner/repo 或 https://github.com/owner/repo[/tree/分支/子目录]", file=sys.stderr)
        sys.exit(2)
    owner, repo, branch, subpath = ref
    subpath = (a.path or subpath or "").strip("/")
    src_url = a.name.strip() if str(a.name).strip().startswith("http") else \
        f"https://github.com/{owner}/{repo}" + (f"/tree/{branch}/{subpath}" if branch and subpath else (f"/tree/{branch}" if branch else ""))
    root, used_branch, tmp = download_repo(owner, repo, branch)
    try:
        hits = find_skill_dirs(root, subpath)
        if a.path and not hits:
            print(f"仓库里没有 {a.path} 这个目录（或它下面没有 SKILL.md）", file=sys.stderr)
            sys.exit(2)
        want = safe_skill_name(a.as_name) or repo
        if hits:
            src = next((h for h in hits if os.path.basename(h) == want), None) \
                or next((h for h in hits if read_frontmatter(h).get("name") == want), None) \
                or (hits[0] if len(hits) == 1 else None)
            if src is None:
                rels = "、".join(os.path.relpath(h, root) for h in hits[:12])
                print(f"这个仓库里有多个技能，用 --path 指定一个：{rels}", file=sys.stderr)
                sys.exit(2)
        else:
            src = None
        fm = read_frontmatter(src) if src else {}
        target = safe_skill_name(a.as_name or fm.get("name") or (os.path.basename(src) if src else "")) or \
            safe_skill_name(re.sub(r"[^A-Za-z0-9\u4e00-\u9fff._-]+", "-", repo).strip("-")) or repo
        dest = os.path.join(POOL, target)
        if os.path.exists(dest):
            if not a.force:
                print(f"{target} 已经存在（{dest}）——用 --as 换个名字，或加 --force 覆盖", file=sys.stderr)
                sys.exit(2)
            shutil.move(dest, f"{dest}.bak-{int(time.time())}")
        os.makedirs(POOL, exist_ok=True)
        if src:
            shutil.copytree(src, dest, ignore=shutil.ignore_patterns(".git", "__pycache__", "node_modules"))
        else:
            os.makedirs(dest, exist_ok=True)
        lic = repo_license(root, src or "")
        lic_name = os.path.basename(lic) if lic else ""
        if lic and not os.path.exists(os.path.join(dest, lic_name)):
            shutil.copy2(lic, os.path.join(dest, lic_name))
        prov = [f"来源：{src_url}", f"仓库：{owner}/{repo}" + (f"（分支 {used_branch}）" if used_branch else "")]
        if subpath:
            prov.append(f"目录：{subpath}")
        prov.append(f"许可证：{lic_name}（已一并复制）" if lic else "许可证：仓库里没找到 LICENSE，使用前自己确认")
        if src:
            add_frontmatter_source(os.path.join(dest, "SKILL.md"), src_url)
            with open(os.path.join(dest, "SOURCE.md"), "w", encoding="utf-8") as f:
                f.write("# 来源\n\n" + "\n".join(f"- {p}" for p in prov) + "\n")
        else:
            # No SKILL.md in the repo: write the entry point ourselves, the way skill-from-github
            # would — point at the project, keep the licence and the source, let the agent extract.
            description = (a.description or "").strip() or f"用户要参考 {owner}/{repo} 的做法时用。"
            body = SKILL_TEMPLATE.format(name=target, description=description.replace('"', "'"),
                                         trigger=f"用户要做 {owner}/{repo} 能解决的事、想借用它的做法时用。",
                                         constraint="只提炼模型推不出来的接口/格式/坑，不要照抄整仓文档；遵守下面的许可证。")
            body += "\n## 来源与提炼\n\n" + "\n".join(f"- {p}" for p in prov) + \
                    "\n\n读仓库里的 README、核心脚本和示例，把可复用的做法写进本技能。\n"
            with open(os.path.join(dest, "SKILL.md"), "w", encoding="utf-8") as f:
                f.write(body)
        agents = want_agents(a)
        mounts = mount_skill(target, dest, agents)
        res = {"name": target, "path": dest, "source": src_url, "branch": used_branch, "license": lic_name,
               "generated": not bool(src), "agents": agents, "mounts": mounts}
        out(res, a.json, lambda r: print(f"已导入 {r['name']}：{r['path']}" +
                                         ("（仓库里没有 SKILL.md，已生成入口待提炼）" if r["generated"] else "") +
                                         (f"\n已挂给 {', '.join(r['agents'])}（新会话生效）" if r["agents"] else "")))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


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
    if a.op == "new":
        return cmd_skills_new(a)
    if a.op == "import":
        return cmd_skills_import(a)
    if a.op == "list":
        rows = all_skills()
        only = want_agents(a)
        if only:
            rows = [r for r in rows if any(r["agents"].get(x) for x in only)]
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
    # A skill is a folder: SKILL.md plus whatever it links to (detail-*.md, references/…).
    # --file picks one of those; it must stay inside the skill folder.
    def skill_file(rel):
        rel = (rel or "SKILL.md").lstrip("/")
        full = os.path.realpath(os.path.join(r["path"], rel))
        if not full.startswith(os.path.realpath(r["path"]) + os.sep) and full != os.path.realpath(os.path.join(r["path"], "SKILL.md")):
            print(f"{rel} 不在技能目录里", file=sys.stderr)
            sys.exit(2)
        return full
    if a.op == "path":
        print(skill_file(a.file))
    elif a.op == "show":
        if a.json:
            files = sorted(os.path.relpath(os.path.join(dp, fn), r["path"]) for dp, _, fns in os.walk(r["path"]) for fn in fns if fn.endswith((".md", ".txt", ".py", ".sh", ".json", ".yaml", ".yml")) and not fn.endswith(".bak") and "/." not in dp[len(r["path"]):])
            print(json.dumps({**r, "files": files}, ensure_ascii=False, indent=2))
        else:
            print(open(skill_file(a.file), encoding="utf-8").read())
    elif a.op == "open":
        subprocess.run(["open", "-R", skill_file(a.file)] if a.reveal else ["open", skill_file(a.file)])
    elif a.op == "trash":
        # Unmount everywhere, then move the folder to the Trash (Finder), so it is recoverable.
        import shutil
        real = os.path.realpath(r["path"])
        for ag, dirs in AGENT_SKILL_DIRS.items():
            for d in dirs:
                p = os.path.join(d, a.name)
                if os.path.islink(p):
                    os.remove(p)
        if not real.startswith(os.path.realpath(POOL) + os.sep):
            print(f"{a.name} 不在技能池里（{real}），只卸了挂载，没删本体", file=sys.stderr)
            sys.exit(2)
        script = f'tell application "Finder" to delete POSIX file "{real}"'
        code, o, e = sh(["osascript", "-e", script], timeout=20)
        if code != 0:
            trash = os.path.join(HOME, ".Trash", os.path.basename(real))
            shutil.move(real, trash)
        if os.path.islink(r["path"]):
            os.remove(r["path"])
        print(f"{a.name} 已移到废纸篓（可从废纸篓拖回 {POOL}）")
    elif a.op == "write":
        new = sys.stdin.read()
        if not new.strip():
            print("stdin 为空，不写", file=sys.stderr)
            sys.exit(2)
        f = skill_file(a.file)
        import shutil
        if os.path.exists(f):
            shutil.copy2(f, f + ".bak")
        os.makedirs(os.path.dirname(f), exist_ok=True)
        open(f, "w", encoding="utf-8").write(new)
        print(f"{a.name}/{os.path.relpath(f, r['path'])} 已保存（旧版 .bak）")
    elif a.op in ("enable", "disable"):
        agents = want_agents(a) or list(AGENT_SKILL_DIRS)
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


def cmd_task(a):
    issue = bd_json(['show', a.task, '--json'])
    if not issue or not issue.get('id'): raise ValueError('任务不存在')
    labels = issue.get('labels', [])
    trashed = 'dispatch:trashed' in labels
    if (a.op == 'trash') == trashed:
        return out({'id': a.task, 'unchanged': True}, a.json, lambda _: print('状态未变'))
    argv = ['update', a.task]
    if a.op == 'trash':
        argv += ['--status', 'deferred', '--add-label', 'dispatch:trashed', '--add-label', 'dispatch:previous:' + issue['status']]
    else:
        previous = next((x.split(':', 2)[2] for x in labels if x.startswith('dispatch:previous:')), 'open')
        if previous not in ('open', 'in_progress', 'blocked', 'closed', 'deferred'): previous = 'open'
        argv += ['--status', previous, '--remove-label', 'dispatch:trashed']
        for label in labels:
            if label.startswith('dispatch:previous:'): argv += ['--remove-label', label]
    result = bd_json([*argv, '--json'])
    out(result, a.json, lambda _: print('已移到回收站' if a.op == 'trash' else '已恢复任务'))


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


# A task card is read by a person weeks later, cold. The title must say what changes and why;
# the description must carry the trigger. Vague titles are refused so the board stays readable.
_VAGUE_TITLES = re.compile(r"^(修复|修改|优化|改进|更新|调整|处理|完善|继续|测试|检查|fix|update|improve|refactor|wip|todo|misc|杂项|其他|bug|问题)[\s:：]*$", re.I)


def title_problems(title, desc):
    """Why a task title/description would leave the next reader guessing; empty when fine."""
    t = (title or "").strip()
    probs = []
    if len(t) < 8:
        probs.append("标题太短：要说清「改什么 + 为了什么」，例如「会话页 diff 改成可横向滚动：手机上右半截被截掉」")
    elif _VAGUE_TITLES.match(t):
        probs.append("标题只有动词没有对象：写成「<对象> <怎么改>：<为什么>」")
    if len(t) > 80:
        probs.append("标题超过 80 字：把细节放到描述里，标题一句话")
    if not any(sep in t for sep in ("：", ":", "，", "—", "→", "（", "(")) and len(t) < 16:
        probs.append("标题缺「为什么」：用冒号接一句原因或期望结果")
    d = (desc or "").strip()
    if len(d) < 20:
        probs.append("描述太短（-d）：至少写触发原因（谁在什么情况下遇到什么）和期望结果，接手的人才不用猜")
    return probs


def cmd_begin(a):
    """Create + claim a task in one go: the first thing an Agent does once it knows what it is doing."""
    probs = title_problems(a.title, a.desc)
    if probs and not getattr(a, "force", False):
        print("任务没建：先把标题和描述写清楚（或加 --force 硬建）", file=sys.stderr)
        for pr in probs:
            print("  · " + pr, file=sys.stderr)
        sys.exit(2)
    for pr in probs:
        print("⚠ " + pr, file=sys.stderr)
    for w in begin_warnings(a.title, a.project, os.getcwd()):
        print("⚠ " + w, file=sys.stderr)
    labels = [f"project:{a.project}"] if a.project else []
    labels.append(f"host:{local_host_name()}")  # which Mac this work runs on — Dispatch filters by it
    sid = getattr(a, 'session', None) or os.environ.get('CODEX_THREAD_ID') or os.environ.get('CLAUDE_SESSION_ID') or os.environ.get('CLAUDE_CODE_SESSION_ID')
    if sid and re.fullmatch(r'[A-Za-z0-9_-]{8,120}', sid): labels.extend(['session:' + sid, 'session-origin:' + sid])
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


def tick_acceptance(tid, issue, match=None, who=None):
    """Mark acceptance items done and sign them: `- [x] text @<who>` — who checked is part of the
    record (the assignee ticking its own work reads as 自审 in the app, someone else as 复核).
    match=None ticks every open item; otherwise items containing one of the substrings."""
    who = who or os.environ.get("BEADS_ACTOR", "schaefer")
    lines = (issue.get("acceptance_criteria") or "").splitlines()
    hit = 0
    for i, line in enumerate(lines):
        if "[ ]" not in line:
            continue
        if match is not None and not any(t.lower() in line.lower() for t in match):
            continue
        lines[i] = line.replace("[ ]", "[x]", 1).rstrip() + f" @{who}"
        hit += 1
    if hit:
        bd_json(["update", tid, "--acceptance", "\n".join(lines), "--json"])
    return hit


def cmd_log(a):
    """Progress note on a task — this is the process log, visible to everyone in Dispatch."""
    text = a.text
    if a.tick:
        issue = bd_json(["show", a.task, "--json"])
        hit = tick_acceptance(a.task, issue, match=a.tick)
        if hit:
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


def parent_autoclose(tid, issue):
    """Close the parent of a split when every child is closed; returns a note for the caller."""
    parents = [d for d in issue.get("dependencies") or [] if (d.get("dependency_type") or "parent-child") == "parent-child"]
    for p in parents:
        pid = p.get("id")
        if not pid:
            continue
        par = bd_json(["show", pid, "--json"])
        if not par.get("id") or par.get("status") == "closed":
            continue
        kids = [d for d in par.get("dependents") or [] if (d.get("dependency_type") or "parent-child") == "parent-child"]
        open_kids = [k for k in kids if k.get("status") != "closed" and k.get("id") != tid]
        if open_kids:
            continue
        unchecked = (par.get("acceptance_criteria") or "").count("- [ ]")
        if unchecked:
            sh(["bd", "comments", "add", pid, f"子任务已全部完成（最后一个 {tid}）；父任务还有 {unchecked} 项验收没勾，请核对后关闭。"])
            return f"父任务 {pid} 的子任务已全部完成，等你核对验收后关闭"
        bd_json(["close", pid, "--reason", f"子任务全部完成（最后一个 {tid}），自动关闭。", "--json"])
        return f"父任务 {pid} 已随之关闭"
    return ""


def cmd_done(a):
    """Close a task; verification and optional peer review are separate from completion."""
    reason = a.reason
    if not a.verified:
        reason = reason + "（未核验）" if "核验" not in reason else reason
    ticked = 0
    if a.verified:
        # --verified says "I checked it": every open acceptance item gets the signature.
        cur = bd_json(["show", a.task, "--json"])
        ticked = tick_acceptance(a.task, cur) if cur.get("id") else 0
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
    # The commits this task became: those in the current repo naming the task id, plus hashes
    # in the reason. Recorded as a comment so the task page (and anyone reading bd) sees them.
    commits = []
    root = git_root_of(os.getcwd())
    if root:
        code, o, _ = sh(["git", "-C", root, "log", "--format=%h %s", f"--grep={re.escape(a.task)}", "-n", "20"], timeout=10)
        commits = [l for l in o.splitlines() if l.strip()] if code == 0 else []
        for h in _HASH_RE.findall(reason):
            if len(h) >= 7 and not h.isdigit() and not any(l.startswith(h[:7]) for l in commits):
                code, o, _ = sh(["git", "-C", root, "log", "-1", "--format=%h %s", h], timeout=5)
                if code == 0 and o.strip():
                    commits.append(o.strip())
        if commits:
            sh(["bd", "comments", "add", a.task, "提交：\n" + "\n".join(commits[:20])])
    # A child of a split: when it was the last open sibling, the parent is done too — unless the
    # parent still has unchecked acceptance items, in which case it only gets a nudge.
    parent_msg = parent_autoclose(a.task, issue)
    msg = f"{a.task} 已完成" + ("（已核验）" if a.verified else "（未核验，详见完成说明）")
    if getattr(a, "review_by", None):
        msg += f"；等待 {a.review_by} 复核（不会自动启动 Agent）"
    if created:
        msg += f"；后续任务：{', '.join(created)}"
    if retro_key:
        msg += f"；复盘已入知识库 {retro_key}"
    if ticked:
        msg += f"；验收 {ticked} 项已勾（署名）"
    if parent_msg:
        msg += "；" + parent_msg
    if commits:
        msg += f"；关联提交 {len(commits)} 个"
    elif root:
        msg += "；没找到带任务 id 的提交（提交信息末尾写上任务 id 就能对上）"
    out({"closed": a.task, "next": created, "retro": retro_key, "commits": commits}, a.json, lambda o: print(msg))


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


def cmd_quota(a):
    rows = [quota_claude(), quota_codex(), quota_zcode()]
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
# "home" is the agent's config dir: an agent that is not installed gets no file written.
RULE_TARGETS = {
    "claude": {"path": os.path.join(HOME, ".claude", "CLAUDE.md"), "mode": "import", "home": os.path.join(HOME, ".claude")},
    "codex": {"path": os.path.join(HOME, ".codex", "AGENTS.md"), "mode": "inline", "home": os.path.join(HOME, ".codex")},
    "zcode": {"path": os.path.join(HOME, ".zcode", "AGENTS.md"), "mode": "inline", "home": os.path.join(HOME, ".zcode")},
    # pi loads ~/.pi/agent/AGENTS.md as its global context file (plus AGENTS.md up from cwd).
    "pi": {"path": os.path.join(HOME, ".pi", "agent", "AGENTS.md"), "mode": "inline", "home": os.path.join(HOME, ".pi")},
    "gemini": {"path": os.path.join(HOME, ".gemini", "GEMINI.md"), "mode": "inline", "home": os.path.join(HOME, ".gemini")},
    "opencode": {"path": os.path.join(HOME, ".config", "opencode", "AGENTS.md"), "mode": "inline", "home": os.path.join(HOME, ".config", "opencode")},
}
rule_agents_installed = lambda: [ag for ag, t in RULE_TARGETS.items() if not t.get("home") or os.path.isdir(t["home"])]


# ---------------------------------------------------------------- facts: 常用信息（服务器/域名/数据库/API 名字、常说的话）
# One markdown file next to GLOBAL.md. `## 通用` is for everyone; `## <项目名>` sections are
# injected by `dispatch prime` only when the session runs inside that project. Secrets never go
# here — they live in `dispatch env`; this file names them and says what they are for.
FACTS_FILE = os.path.join(HOME, ".agents", "rules", "FACTS.md")
FACTS_GENERAL = ("通用", "general", "common")


def facts_text():
    try:
        return open(FACTS_FILE, encoding="utf-8").read()
    except FileNotFoundError:
        return ""


def facts_sections(text):
    """Split on `## ` headings → [(heading, body)]; text before the first heading is dropped."""
    out, head, buf = [], None, []
    for line in text.splitlines():
        if line.startswith("## "):
            if head is not None:
                out.append((head, "\n".join(buf).strip()))
            head, buf = line[3:].strip(), []
        elif head is not None:
            buf.append(line)
    if head is not None:
        out.append((head, "\n".join(buf).strip()))
    return out


def facts_key(heading):
    """`relecture（ReLecture · 重讲）` → `relecture`: the first word, lowercased."""
    return re.split(r"[\s（(·:：,，/]", heading.strip(), maxsplit=1)[0].lower()


def facts_for(proj, text=None):
    """Sections for a session: the general one(s) plus the one whose first word is the project."""
    secs = facts_sections(facts_text() if text is None else text)
    want = {k for k in FACTS_GENERAL}
    if proj:
        want.add(proj.lower())
    return [(h, b) for h, b in secs if facts_key(h) in want and b]


def facts_topics(body):
    """A section body is a list of `**topic**` blocks → [(topic, block_text)]; lines before
    the first bold heading form a topic named ''."""
    out, head, buf = [], "", []
    for line in body.splitlines():
        m = re.match(r"^\*\*(.+?)\*\*\s*(.*)$", line.strip())
        if m and not line.strip().startswith("-"):
            if head or buf:
                out.append((head, "\n".join(buf).strip()))
            head, buf = m.group(1).strip(), ([m.group(2)] if m.group(2) else [])
        else:
            buf.append(line)
    if head or buf:
        out.append((head, "\n".join(buf).strip()))
    return [(h, b) for h, b in out if b]


def facts_get(query, proj="", text=None):
    """Topic blocks whose title contains the query (case-insensitive), from the general
    section and this project's section."""
    q = query.strip().lower()
    hits = []
    for h, b in facts_for(proj, text):
        for topic, block in facts_topics(b):
            if q in topic.lower() or (not topic and q in h.lower()):
                hits.append((h, topic, block))
    return hits


def facts_search(query, docs_text):
    """Lines matching every word of the query, across [(doc_name, text)], with their topic."""
    words = [w for w in query.lower().split() if w]
    rows = []
    for name, text in docs_text:
        topic = ""
        for line in text.splitlines():
            m = re.match(r"^\*\*(.+?)\*\*", line.strip())
            if m:
                topic = m.group(1).strip()
            elif line.startswith("## "):
                topic = line[3:].strip()
            low = line.lower()
            if line.strip() and all(w in low for w in words):
                rows.append((name, topic, line.strip()))
    return rows


FACT_WORDS = re.compile(r"(tailscale|100\.\d+\.\d+\.\d+|mac mini|macbook|ssh |hetzner|vps|supabase|cloudflare|stripe|\bR2\b|github|api[ _-]?key|密钥|token|域名|dns|数据库|postgres|sqlite|redis|apple id|xcode|udid|team|obsidian|hermes|telegram|deepseek|kimi|minimax|openai|zhipu|智谱|豆包|端口|port \d|launchagent|cron)", re.I)


def facts_candidates(sources, existing_text):
    """Paragraph-sized snippets from other agents' memory files that look like cross-project
    facts (machines, accounts, keys, tools) and are not already in FACTS.md.
    sources: [(path, text)] → [(path, snippet)] deduplicated."""
    def norm(s):
        return re.sub(r"[\s`*_#>\-·。，,.:：;；()（）\[\]]+", "", s.lower())
    have = norm(existing_text)
    seen, out = set(), []
    for path, text in sources:
        text = re.sub(r"^---\n[\s\S]*?\n---\n", "", text)  # frontmatter
        for para in re.split(r"\n\s*\n", text):
            para = para.strip()
            if len(para) < 20 or len(para) > 1200 or not FACT_WORDS.search(para):
                continue
            key = norm(para)[:160]
            if key in seen or (len(key) > 40 and key in have):
                continue
            seen.add(key)
            out.append((path, para))
    return out


def facts_docs():
    """The documents the 常用信息 page edits: the machine-wide FACTS.md plus, for every
    project label on the board whose directory is known from the session index, that
    project's own AGENTS.md — every agent reads it natively when working in that directory,
    so project-specific facts never need to sit in the global file."""
    docs = [{"key": "通用", "name": "通用（所有项目）", "path": FACTS_FILE, "dir": "", "exists": os.path.exists(FACTS_FILE),
             "hint": "每个会话都注入（dispatch prime）"}]
    names = project_names()
    dirs = {}
    try:
        for r in session_refs(load_index()):
            cwd = (r.get("cwd") or "").rstrip("/")
            if not cwd or not os.path.isdir(cwd):
                continue
            base = os.path.basename(cwd).lower()
            if base in names and (base not in dirs or r.get("last_at", 0) > dirs[base][1]):
                dirs[base] = (cwd, r.get("last_at", 0))
    except Exception:
        pass
    # Projects nobody has opened a session in on this Mac yet: look under ~/Projects too,
    # so a fresh clone shows up before its first session.
    try:
        for entry in os.listdir(os.path.join(HOME, "Projects")):
            full = os.path.join(HOME, "Projects", entry)
            if entry.lower() in names and entry.lower() not in dirs and os.path.isdir(full):
                dirs[entry.lower()] = (full, 0)
    except OSError:
        pass
    for key in sorted(dirs):
        d = dirs[key][0]
        path = os.path.join(d, "AGENTS.md")
        docs.append({"key": key, "name": names[key], "path": path, "dir": d, "exists": os.path.exists(path),
                     "hint": "只在这个目录的会话里生效（Agent 自己读 AGENTS.md）"})
    return docs


def facts_doc_path(a):
    """--path must be one of facts_docs(); otherwise the page could write anywhere."""
    if not getattr(a, "path", ""):
        return FACTS_FILE
    want = os.path.realpath(a.path)
    for d in facts_docs():
        if os.path.realpath(d["path"]) == want:
            return d["path"]
    print(f"{a.path} 不在常用信息的文档列表里（`dispatch facts docs`）", file=sys.stderr)
    sys.exit(2)


def cmd_facts(a):
    if a.op == 'vaults':
        from pathlib import Path
        config = Path(HOME) / 'Library/Application Support/obsidian/obsidian.json'
        if not config.exists(): config = Path(HOME) / '.config/obsidian/obsidian.json'
        try:
            data = json.loads(config.read_text())
        except (OSError, ValueError):
            data = {}
        rows = []
        for ident, vault in data.get('vaults', {}).items():
            path = Path(vault.get('path', ''))
            if not str(vault.get('path', '')).strip(): continue
            if path.name == 'Obsidian Sandbox' and 'Application Support/obsidian' in str(path): continue  # Obsidian's own demo vault
            rows.append({'id': ident, 'name': path.name, 'path': str(path), 'exists': path.is_dir(), 'open': bool(vault.get('open'))})
        out(rows, a.json, lambda rs: print(json.dumps(rs, ensure_ascii=False)))
    elif a.op == "topics":
        rows = [{"section": h, "topic": t, "lines": len(b.splitlines())} for h, b in facts_sections(facts_text()) for t, b2 in facts_topics(b) for b in [b2]]
        out(rows, a.json, lambda rs: [print(f"{r['section']:<10} {r['topic']}") for r in rs])
    elif a.op == "get":
        if not a.query:
            print("用法：dispatch facts get <主题词>（`dispatch facts topics` 列主题）", file=sys.stderr); sys.exit(2)
        hits = facts_get(a.query, a.project or project_of_cwd(os.getcwd(), project_names()))
        if a.json:
            print(json.dumps([{"section": h, "topic": t, "text": b} for h, t, b in hits], ensure_ascii=False)); return
        if not hits:
            print(f"没有叫「{a.query}」的主题；`dispatch facts topics` 看有哪些，或 `dispatch facts search {a.query}` 全文搜。", file=sys.stderr); sys.exit(1)
        for h, t, b in hits:
            print(f"### {t or h}\n{b}\n")
    elif a.op == "search":
        if not a.query:
            print("用法：dispatch facts search <关键词>", file=sys.stderr); sys.exit(2)
        docs = [(d["name"], open(d["path"], encoding="utf-8").read()) for d in facts_docs() if d["exists"]]
        rows = facts_search(a.query, docs)
        if a.json:
            print(json.dumps([{"doc": n, "topic": t, "line": l} for n, t, l in rows], ensure_ascii=False)); return
        if not rows:
            print("没找到；`dispatch facts topics` 看主题，或问用户。", file=sys.stderr); sys.exit(1)
        for n, t, l in rows[:40]:
            print(f"[{n} · {t}] {l}")
    elif a.op == "import":
        import glob, datetime
        sources = []
        for pat in [os.path.join(HOME, ".claude", "projects", "*", "memory", "*.md"), os.path.join(HOME, ".codex", "memories", "raw_memories.md")]:
            for path in sorted(glob.glob(pat)):
                if os.path.basename(path) == "MEMORY.md":
                    continue
                try:
                    sources.append((path, open(path, encoding="utf-8").read()))
                except OSError:
                    pass
        cands = facts_candidates(sources, facts_text())
        report = [f"# 记忆导入清单（{datetime.date.today()}）", "", f"扫描 {len(sources)} 个记忆文件，抽出 {len(cands)} 段像跨项目事实、且 FACTS.md 里还没有的内容。", "逐段看：该进 FACTS.md 的留下，其余删掉；确认后 `dispatch facts import --apply` 会把清单原样追加到 FACTS.md「通用」节末尾的「待整理」块，原记忆文件不动。", ""]
        by = {}
        for path, para in cands:
            by.setdefault(path, []).append(para)
        for path, paras in by.items():
            report.append(f"## {path.replace(HOME, '~')}")
            for p_ in paras:
                report.append(p_); report.append("")
        os.makedirs(DISPATCH_DIR, exist_ok=True)
        out_path = a.out or os.path.join(DISPATCH_DIR, "facts-import.md")
        open(out_path, "w", encoding="utf-8").write("\n".join(report))
        if a.apply:
            if not cands:
                print("没有可追加的内容"); return
            block = [f"\n**待整理（{datetime.date.today()} 从各 Agent 记忆导入，核对后并入上面的主题或删掉）**"]
            for path, para in cands:
                block.append(f"- （{os.path.basename(os.path.dirname(os.path.dirname(path))) if '/memory/' in path else 'codex'}）" + re.sub(r"\s*\n\s*", " ", para))
            text = facts_text()
            secs = facts_sections(text)
            gen = next((h for h, b in secs if facts_key(h) in FACTS_GENERAL), None)
            if gen is None:
                text = text.rstrip() + "\n\n## 通用\n" + "\n".join(block) + "\n"
            else:
                idx = text.index("## " + gen)
                nxt = re.search(r"^## ", text[idx + 3:], re.M)
                end = idx + 3 + nxt.start() if nxt else len(text)
                text = text[:end].rstrip() + "\n" + "\n".join(block) + "\n\n" + text[end:]
            open(FACTS_FILE, "w", encoding="utf-8").write(text)
            print(f"已把 {len(cands)} 段追加到 FACTS.md「通用」末尾的待整理块；清单在 {out_path}")
        else:
            print(f"清单写到 {out_path}（{len(cands)} 段，来自 {len(by)} 个文件）。看过后 `dispatch facts import --apply` 追加进 FACTS.md，或手动挑选粘贴。")
    elif a.op == "docs":
        rows = facts_docs()
        out(rows, a.json, lambda rs: [print(f"{r['key']:<12} {'有' if r['exists'] else '无':<2} {r['path']}") for r in rs])
    elif a.op == "path":
        print(facts_doc_path(a))
    elif a.op == "open":
        subprocess.run(["open", facts_doc_path(a)])
    elif a.op == "write":
        target = facts_doc_path(a)
        text = sys.stdin.read()
        os.makedirs(os.path.dirname(target), exist_ok=True)
        open(target, "w", encoding="utf-8").write(text if text.endswith("\n") else text + "\n")
        print(f"已写入 {target}（{len(text.splitlines())} 行）")
    elif a.op == "sections":
        rows = [{"heading": h, "key": facts_key(h), "lines": len(b.splitlines())} for h, b in facts_sections(facts_text())]
        out(rows, a.json, lambda rs: [print(f"{r['key']:<16} {r['lines']:>4} 行  {r['heading']}") for r in rs] or print(f"\n{len(rs)} 节（{FACTS_FILE}）"))
    else:  # show
        if a.project:
            picked = facts_for(a.project)
            text = "\n\n".join(f"## {h}\n{b}" for h, b in picked)
            if a.json:
                print(json.dumps([{"heading": h, "body": b} for h, b in picked], ensure_ascii=False))
            else:
                print(text or f"FACTS.md 里没有 {a.project} 这一节（`dispatch facts sections` 看有哪些）")
        else:
            target = facts_doc_path(a)
            try:
                t = open(target, encoding="utf-8").read()
            except FileNotFoundError:
                t = ""
            print(json.dumps({"path": target, "content": t, "exists": os.path.exists(target)}, ensure_ascii=False) if a.json else t, end="" if (t.endswith("\n") and not a.json) else "\n")


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
    if a.op in ('inspect', 'optimize', 'check', 'apply', 'restore'):
        from instructions import command
        project = None
        if getattr(a, 'project', ''):
            project = next((d['dir'] for d in facts_docs() if d['key'] == a.project and d['dir']), None)
            if not project: raise ValueError('请选择已检测到的项目')
        try:
            result = command(a, HOME, project=project)
        except ValueError as e:
            msg = str(e)
            if "托管块" in msg:
                msg = "这份文件里「BEGIN/END DISPATCH GLOBAL RULES」之间的内容是托管块，由 ~/.agents/rules/GLOBAL.md 生成，改它没用、也不能在这里改。要改共同规则请编辑左边的「所有 Agent 的共同规则」。托管块之外的内容可以随便改。"
            print(json.dumps({"error": msg}, ensure_ascii=False) if a.json else f"✗ {msg}")
            sys.exit(2)
        out(result, a.json, lambda d: print(json.dumps(d, ensure_ascii=False, indent=2)))
        return
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
        for ag in rule_agents_installed():
            st, p, _ = target_state(ag, h)
            rows.append({"agent": ag, "path": p, "state": st, "mode": RULE_TARGETS[ag]["mode"]})
        out({"hash": h, "source": RULES_FILE, "targets": rows}, a.json, lambda o: [print(f"{r['agent']:<8} {r['state']:<8} {r['path']}") for r in o["targets"]])
        return
    if a.op == "sync":
        if not text.strip():
            print(f"规则文件为空：{RULES_FILE}", file=sys.stderr)
            sys.exit(1)
        results = []
        for ag in rule_agents_installed():
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
    return [wiki_parse(k, v) for k, v in d.items() if k != "schema_version" and isinstance(v, str) and not k.startswith(INTERNAL_MEMORY_PREFIX)]


# ---------------------------------------------------------------- project flags (star / archive)
# Projects are labels, not records, so their two switches live in one shared bd memory
# (synced between the Macs with the board). Keys under this prefix are Dispatch's own
# bookkeeping and stay out of the wiki, prime and the knowledge-base view.
INTERNAL_MEMORY_PREFIX = "dispatch-"
PROJECT_FLAGS_KEY = "dispatch-projects"
PROJECT_FLAG_FIELDS = ("starred", "archived")


def project_flags_parse(raw):
    try:
        d = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    if not isinstance(d, dict):
        return {}
    out = {}
    for name, v in d.items():
        if isinstance(v, dict):
            flags = {f: True for f in PROJECT_FLAG_FIELDS if v.get(f) is True}
            if flags:
                out[name] = flags
    return out


def project_flags_apply(flags, name, changes):
    name = (name or "").strip()
    if not name or len(name) > 120 or any(ord(c) < 32 for c in name):
        raise ValueError("无效的项目名称")
    if set(changes) - set(PROJECT_FLAG_FIELDS) or any(type(v) is not bool for v in changes.values()):
        raise ValueError("只能设置 starred / archived，值为布尔")
    cur = {**flags.get(name, {}), **changes}
    cur = {f: True for f in PROJECT_FLAG_FIELDS if cur.get(f)}
    out = {k: v for k, v in flags.items() if k != name}
    if cur:
        out[name] = cur
    return out


def project_flags_load():
    code, o, err = sh(["bd", "memories", "--json"])
    if code != 0:
        print(err.strip() or o.strip(), file=sys.stderr)
        sys.exit(code)
    d = json.loads(o[o.find("{"):])
    return project_flags_parse(d.get(PROJECT_FLAGS_KEY, ""))


# ---------------------------------------------------------------- settings (shared, one bd memory)
SETTINGS_KEY = "dispatch-settings"
# Who each discussion member is (one line) and the group's rules on length: stable
# configuration that goes into the system prompt, so a round's prompt is just the new messages.
DISCUSS_RULES_DEFAULT = "闲聊就闲聊，两句以内；正事默认一两段、150 字左右，要论证再展开；只回应最新消息和别人已经说过的观点，不重复，不为了凑段落写风险和拆分；没有新东西就只回 SKIP。"
DISCUSS_PERSONA_DEFAULT = {"claude": "偏架构和验收：先问值不值得做、做完怎么验证，习惯把方案拆成可交付的步骤。",
                           "codex": "抠实现细节：关心具体改哪里、边界情况、能不能复用已有代码，不信没验证过的说法。",
                           "pi": "短句直给：一次只说最重要的一点，倾向先做最小可验证的版本，看到过度设计会直说。"}
SETTING_DEFAULTS = {"session_archive_days": 30, "task_archive_days": 0, "home_expanded": 2, "sdk_sessions_scheduled": 1, "workspace_roots": ["~/Projects"], "summary_auto": 1, "summary_model": "",
                    "discuss_rules": DISCUSS_RULES_DEFAULT, **{f"discuss_persona_{k}": v for k, v in DISCUSS_PERSONA_DEFAULT.items()}}
# free-text settings and their length caps; everything else numeric except workspace_roots
SETTING_STRINGS = {"summary_model": 80, "discuss_rules": 600, "discuss_persona_claude": 300, "discuss_persona_codex": 300, "discuss_persona_pi": 300}


def settings_parse(raw):
    try:
        d = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    if not isinstance(d, dict):
        return {}
    out = {k: v for k, v in d.items() if k in SETTING_DEFAULTS and k not in SETTING_STRINGS and isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0}
    for k, cap in SETTING_STRINGS.items():
        if isinstance(d.get(k), str):
            out[k] = d[k].strip()[:cap]
    if isinstance(d.get("workspace_roots"), list):
        out["workspace_roots"] = [x.strip() for x in d["workspace_roots"] if isinstance(x, str) and x.strip()]
    return out


def settings_load():
    code, o, err = sh(["bd", "memories", "--json"])
    if code != 0:
        return dict(SETTING_DEFAULTS)
    try:
        d = json.loads(o[o.find("{"):])
    except Exception:
        return dict(SETTING_DEFAULTS)
    return {**SETTING_DEFAULTS, **settings_parse(d.get(SETTINGS_KEY, ""))}


def cmd_settings(a):
    cur = settings_load()
    if a.key and a.key not in SETTING_DEFAULTS:
        print(f"没有这个设置：{a.key}；可用：{', '.join(SETTING_DEFAULTS)}", file=sys.stderr)
        sys.exit(2)
    if a.key and a.value is not None:
        if a.key == "workspace_roots":
            val = [x.strip() for x in a.value.split(",") if x.strip()]
        elif a.key in SETTING_STRINGS:
            val = a.value.strip()
        else:
            try:
                val = int(a.value)
                if val < 0:
                    raise ValueError
            except ValueError:
                print("值必须是非负整数", file=sys.stderr)
                sys.exit(2)
        cur[a.key] = val
        wiki_store(SETTINGS_KEY, json.dumps({k: v for k, v in cur.items() if k in SETTING_DEFAULTS}, ensure_ascii=False, sort_keys=True))
    shown = {a.key: cur[a.key]} if a.key else cur
    notes = {"session_archive_days": "天，普通会话无活动后自动归档；收藏的不归档", "task_archive_days": "天，已完成任务超过这些天自动打 dispatch:archived 标签；0=不自动", "home_expanded": "工作台默认展开前几个项目", "sdk_sessions_scheduled": "1=SDK 启动的会话自动当作定时会话", "workspace_roots": "工作区根目录，其直接子文件夹各算一个项目", "summary_auto": "1 = 一轮结束后自动给会话写总结（含以前的会话，逐步补齐）", "summary_model": "总结用的模型，如 claude:haiku（订阅）或 zhipu:glm-5.3-flash（API Key）；空 = 自动选",
             "discuss_rules": "讨论群的规矩（发言长度、什么时候 SKIP），进每个成员的系统提示", "discuss_persona_claude": "讨论里 claude 的一句人设", "discuss_persona_codex": "讨论里 codex 的一句人设", "discuss_persona_pi": "讨论里 pi 的一句人设"}
    out(shown, a.json, lambda x: [print(f"{k} = {v}（{notes[k]}）") for k, v in x.items()])


def cmd_project(a):
    flags = project_flags_load()
    changes = {}
    if a.star: changes["starred"] = True
    if a.unstar: changes["starred"] = False
    if a.archive: changes["archived"] = True
    if a.unarchive: changes["archived"] = False
    if changes:
        try:
            flags = project_flags_apply(flags, a.name, changes)
        except ValueError as e:
            print(str(e), file=sys.stderr)
            sys.exit(2)
        wiki_store(PROJECT_FLAGS_KEY, json.dumps(flags, ensure_ascii=False, sort_keys=True))
    cur = flags.get(a.name.strip(), {})
    out({"name": a.name.strip(), **{f: bool(cur.get(f)) for f in PROJECT_FLAG_FIELDS}}, a.json,
        lambda x: print(f"{x['name']}：{'★ 已收藏' if x['starred'] else '未收藏'} · {'已归档' if x['archived'] else '未归档'}"))


def cmd_projects(a):
    flags = project_flags_load()
    rows = [{"name": k, **{f: bool(v.get(f)) for f in PROJECT_FLAG_FIELDS}} for k, v in sorted(flags.items())]
    if a.json:
        print(json.dumps(rows, ensure_ascii=False))
        return
    if not rows:
        print("没有收藏或归档的项目。`dispatch project <名> --star` 收藏，`--archive` 归档。")
    for r in rows:
        print(f"{'★' if r['starred'] else ' '} {r['name']}{'（已归档）' if r['archived'] else ''}")


# Closed tasks stay in the done column forever unless something labels them. The manual
# button does 30 days once; this runs the same rule every day using the shared setting.
TASK_ARCHIVED_LABEL = "dispatch:archived"
TASK_ARCHIVE_SKIP = (TASK_ARCHIVED_LABEL, "dispatch:trashed", "dispatch:outcome")


def task_archive_candidates(issues, days, now=None):
    """Ids of tasks closed more than `days` days ago, not already archived/trashed/outcomes."""
    if days <= 0:
        return []
    cutoff = (time.time() if now is None else now) - days * 86400
    ids = []
    for it in issues:
        if it.get("status") != "closed":
            continue
        if any(l in TASK_ARCHIVE_SKIP for l in it.get("labels") or []):
            continue
        ts = _iso_epoch(it.get("closed_at") or it.get("updated_at") or "")
        if ts is not None and ts < cutoff:
            ids.append(it["id"])
    return ids


def cmd_task_archive(a):
    days = a.days if a.days is not None else int(settings_load().get("task_archive_days") or 0)
    if days <= 0:
        out({"days": 0, "archived": [], "count": 0}, a.json,
            lambda _: print("task_archive_days=0，没有自动归档任何任务（在设置页或 `dispatch settings task_archive_days <天>` 打开）"))
        return
    code, o, _ = sh(["bd", "list", "--all", "--json"], timeout=60)
    issues = []
    if code == 0:
        try:
            issues = json.loads(o[o.find("["):])
        except Exception:
            issues = []
    done = []
    for tid in task_archive_candidates(issues, days):
        code, _, _ = sh(["bd", "update", tid, "--add-label", TASK_ARCHIVED_LABEL, "--json"], timeout=20)
        if code == 0:
            done.append(tid)
    out({"days": days, "archived": done, "count": len(done)}, a.json,
        lambda x: print(f"已归档 {x['count']} 项完成超过 {x['days']} 天的任务" + ("：" + "、".join(x["archived"]) if x["archived"] else "")))


# ---------------------------------------------------------------- project documents (the 文档 tab)
# A project's research and review write-ups live in its repo (design/, docs/, 研究/), which the
# project page could not see. This scans those folders and adds explicitly registered paths/URLs
# (one shared bd memory per project, like dispatch-projects). The app only renders what this returns.
DOC_DIR_NAMES = ("design", "docs", "研究")
DOC_EXTS = (".md", ".html", ".htm")
DOC_KINDS = ("调研", "复审", "设计", "文档", "其他")
DOCS_KEY_PREFIX = INTERNAL_MEMORY_PREFIX + "docs-"   # dispatch-docs-<project>
DOC_MAX_READ = 4 * 1024 * 1024
DOC_MAX_ASSET = 20 * 1024 * 1024


def docs_key(project):
    return DOCS_KEY_PREFIX + (project or "").strip()


def docs_id(path):
    return hashlib.sha256(os.path.expanduser(path).encode("utf-8", "replace")).hexdigest()[:16]


def docs_is_url(value):
    return bool(re.match(r"^[a-zA-Z][\w+.-]*://", (value or "").strip()))


def docs_kind_of(name):
    """research/调研 → 调研, review/复审 → 复审, anything else in a doc folder → 文档."""
    low = (name or "").lower()
    if "research" in low or "调研" in name:
        return "调研"
    if "review" in low or "复审" in name:
        return "复审"
    return "文档"


def docs_title(path, limit=80):
    """First `# heading` (or <title>/<h1>), else the file name without its suffix."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            head = f.read(8192)
    except OSError:
        return os.path.splitext(os.path.basename(path))[0][:limit]
    if path.lower().endswith((".html", ".htm")):
        m = re.search(r"<title[^>]*>(.*?)</title>", head, re.S | re.I) or re.search(r"<h1[^>]*>(.*?)</h1>", head, re.S | re.I)
        if m:
            t = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", m.group(1))).strip()
            if t:
                return t[:limit]
    for line in head.splitlines():
        m = re.match(r"^#\s+(.+?)\s*#*\s*$", line)
        if m:
            return m.group(1).strip()[:limit]
    return os.path.splitext(os.path.basename(path))[0][:limit]


def docs_entries_parse(raw):
    try:
        rows = json.loads(raw) if raw else []
    except ValueError:
        return []
    if not isinstance(rows, list):
        return []
    out = []
    for r in rows:
        if not isinstance(r, dict) or not isinstance(r.get("path"), str) or not r["path"].strip():
            continue
        kind = r.get("kind") if r.get("kind") in DOC_KINDS else ""
        out.append({"id": r.get("id") or docs_id(r["path"]), "path": r["path"].strip(),
                    "title": (r.get("title") or "").strip(), "kind": kind,
                    "added_at": float(r.get("added_at") or 0)})
    return out


def docs_registered(project):
    code, o, _ = sh(["bd", "memories", "--json"])
    if code != 0:
        return []
    try:
        d = json.loads(o[o.find("{"):])
    except Exception:
        return []
    return docs_entries_parse(d.get(docs_key(project), ""))


def docs_save(project, entries):
    wiki_store(docs_key(project), json.dumps(entries, ensure_ascii=False, sort_keys=True))


def docs_project_dirs(project):
    """Where this project's files live: the git roots of its sessions' working directories,
    plus ~/Projects/<name>. Mirrors task_project_dir, without one bd call per task."""
    name = (project or "").strip()
    out, seen = [], set()

    def add(d):
        d = os.path.abspath(os.path.expanduser(d or ""))
        if not d or d in seen or not os.path.isdir(d):
            return
        # A git worktree (.git is a file pointing at the main repo) holds a copy of the same
        # documents: read them from the main repository instead, once.
        dotgit = os.path.join(d, ".git")
        if os.path.isfile(dotgit):
            try:
                gitdir = open(dotgit).read().strip().split("gitdir:", 1)[1].strip()
                main = os.path.abspath(os.path.join(gitdir.split("/.git/worktrees/")[0]))
                if os.path.isdir(main):
                    d = main
            except Exception:
                return
            if d in seen:
                return
        seen.add(d); out.append(d)

    try:
        names = project_names()
        roots = settings_load().get("workspace_roots") or []
        by_cwd = {}
        for e in load_index().values():
            cwd = (e.get("cwd") or "").rstrip("/")
            if not cwd or not os.path.isdir(cwd):
                continue
            if cwd not in by_cwd:
                by_cwd[cwd] = project_of_cwd(cwd, names, roots).lower() == name.lower()
            if by_cwd[cwd]:
                add(git_root_of(cwd) or cwd)
    except Exception:
        pass
    add(os.path.join(HOME, "Projects", name))
    return out


def docs_scan(dirs, max_depth=2):
    """Every .md/.html under design/, docs/ and 研究/ of the given roots, at most two folders deep."""
    rows, seen = [], set()
    for base in dirs:
        for sub in DOC_DIR_NAMES:
            root = os.path.abspath(os.path.join(base, sub))
            if not os.path.isdir(root):
                continue
            for cur, dnames, fnames in os.walk(root):
                rel = os.path.relpath(cur, root)
                depth = 0 if rel == "." else rel.count(os.sep) + 1
                dnames[:] = [d for d in dnames if d != "node_modules" and not d.startswith(".")]
                if depth >= max_depth:
                    dnames[:] = []
                for fname in fnames:
                    if os.path.splitext(fname)[1].lower() not in DOC_EXTS:
                        continue
                    real = os.path.realpath(os.path.join(cur, fname))
                    if real in seen:
                        continue
                    seen.add(real)
                    try:
                        st = os.stat(real)
                    except OSError:
                        continue
                    rows.append({"id": docs_id(real), "title": docs_title(real), "kind": docs_kind_of(fname),
                                 "path": real, "size": st.st_size, "mtime": st.st_mtime, "source": "scan",
                                 "ext": os.path.splitext(fname)[1].lower().lstrip("."), "dir": os.path.dirname(real)})
    return rows


def docs_registered_rows(entries):
    rows = []
    for e in entries:
        url = docs_is_url(e["path"])
        row = {"id": e["id"], "title": e["title"], "kind": e["kind"], "path": e["path"], "url": url,
               "source": "registered", "mtime": e.get("added_at") or 0}
        if url:
            if not row["title"]:
                row["title"] = e["path"].rstrip("/").rsplit("/", 1)[-1] or e["path"]
            if not row["kind"]:
                row["kind"] = "其他"
        else:
            path = os.path.abspath(os.path.expanduser(e["path"]))
            row["path"] = path
            row["dir"] = os.path.dirname(path)
            row["ext"] = os.path.splitext(path)[1].lower().lstrip(".")
            if os.path.isfile(path):
                try:
                    st = os.stat(path)
                    row["size"], row["mtime"] = st.st_size, st.st_mtime
                except OSError:
                    pass
                if not row["title"]:
                    row["title"] = docs_title(path)
                if not row["kind"]:
                    row["kind"] = docs_kind_of(os.path.basename(path))
            if not row["title"]:
                row["title"] = os.path.basename(path)
            if not row["kind"]:
                row["kind"] = "文档"
        rows.append(row)
    return rows


def docs_merge(scanned, registered):
    """Scanned files plus registered paths/URLs, newest first; a registration wins on title/kind."""
    by = {}
    for r in scanned:
        by[os.path.realpath(r["path"])] = r
    for r in registered:
        key = r["path"] if r.get("url") else os.path.realpath(r["path"])
        old = by.get(key)
        if not old:
            by[key] = r
            continue
        merged = dict(old)
        for k, v in r.items():
            if v not in ("", None, 0, 0.0, False) or k in ("url", "size", "mtime"):
                merged[k] = v
        merged["source"] = "registered"
        by[key] = merged
    rows = list(by.values())
    rows.sort(key=lambda r: r.get("mtime") or 0, reverse=True)
    return rows


def docs_list(project, dirs=None):
    name = (project or "").strip()
    if not name:
        raise ValueError("请给出项目名")
    return docs_merge(docs_scan(dirs if dirs is not None else docs_project_dirs(name)),
                      docs_registered_rows(docs_registered(name)))


def docs_register(project, value, title="", kind=""):
    name = (project or "").strip()
    if not name:
        raise ValueError("请给出项目名")
    value = (value or "").strip().strip("<>")
    if not value:
        raise ValueError("请给出文档路径或 URL")
    if kind and kind not in DOC_KINDS:
        raise ValueError("类型只能是：" + " / ".join(DOC_KINDS))
    url = docs_is_url(value)
    path = value if url else os.path.abspath(os.path.expanduser(value))
    if not url:
        if not os.path.isfile(path):
            raise ValueError("找不到这个文件：" + path)
        if not title:
            title = docs_title(path)
    entry = {"id": docs_id(path), "path": path, "title": (title or "").strip()[:120],
             "kind": kind or ("其他" if url else docs_kind_of(os.path.basename(path))),
             "added_at": time.time()}
    entries = [e for e in docs_registered(name) if e["id"] != entry["id"]]
    entries.append(entry)
    docs_save(name, entries)
    return docs_registered_rows([entry])[0]


def docs_unregister(project, doc_id):
    entries = docs_registered(project)
    keep = [e for e in entries if e["id"] != doc_id]
    if len(keep) == len(entries):
        return False
    docs_save(project, keep)
    return True


def docs_read(project, doc_id, asset=""):
    """Markdown body (html/URL stay on disk — the app opens those with openPath)."""
    row = next((r for r in docs_list(project) if r["id"] == doc_id), None)
    if not row:
        raise ValueError("找不到这份文档：" + doc_id)
    if row.get("url"):
        if asset:
            raise ValueError("网页文档没有本地附件")
        return {**row, "html": True, "text": ""}
    path = row["path"]
    if not os.path.isfile(path):
        raise ValueError("文件不在了：" + path)
    if asset:
        return docs_asset(path, asset)
    if os.path.splitext(path)[1].lower() in (".html", ".htm"):
        return {**row, "html": True, "text": ""}
    if os.path.getsize(path) > DOC_MAX_READ:
        raise ValueError("文档超过 4 MB，请在外部应用打开")
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    return {**row, "html": False, "text": text, "dir": os.path.dirname(path)}


def docs_asset(doc_path, rel):
    """An image/file next to a document, for relative references inside the markdown."""
    import base64, mimetypes
    base = os.path.realpath(os.path.dirname(doc_path))
    target = os.path.realpath(os.path.join(base, (rel or "").split("#")[0].split("?")[0]))
    if target != base and not target.startswith(base + os.sep):
        raise ValueError("只允许读取文档同目录下的文件")
    if not os.path.isfile(target):
        raise ValueError("文件不在了：" + rel)
    if os.path.getsize(target) > DOC_MAX_ASSET:
        raise ValueError("附件超过 20 MB，请在原应用打开")
    data = open(target, "rb").read()
    mime = mimetypes.guess_type(target)[0] or "application/octet-stream"
    if data.startswith(b"\xff\xd8\xff"):
        mime = "image/jpeg"
    elif data.startswith(b"\x89PNG\r\n"):
        mime = "image/png"
    return {"name": os.path.basename(target), "path": target, "mime": mime,
            "size": len(data), "data": base64.b64encode(data).decode()}


def cmd_docs(a):
    op = (a.op or "").strip()
    project, extra = (a.project or "").strip(), list(a.extra or [])
    if op not in ("add", "rm", "read", "list"):
        # `dispatch docs <project>` — the project is the first positional argument.
        extra = ([project] if project else []) + extra
        project, op = op, "list"
    try:
        if op == "list":
            rows = docs_list(project)
            result = {"project": project, "docs": rows, "dirs": docs_project_dirs(project)}
            out(result, a.json, lambda r: print(f"{r['project']}：{len(r['docs'])} 份文档") or [print(f"  {d['kind']} · {d['title']} · {d['path']}") for d in r["docs"]])
            return
        if op == "read":
            if not extra:
                raise ValueError("用法：dispatch docs read <项目> <文档 id>")
            row = docs_read(project, extra[0], a.asset or "")
            out(row, a.json, lambda r: print(r.get("text") or r["path"]))
            return
        if op == "add":
            if not extra:
                raise ValueError("用法：dispatch docs add <项目> <路径或 URL> [--title …] [--kind …]")
            row = docs_register(project, extra[0], title=a.title or "", kind=a.kind or "")
            out(row, a.json, lambda r: print(f"已登记：{r['kind']} · {r['title']} → {r['path']}"))
            return
        if not extra:
            raise ValueError("用法：dispatch docs rm <项目> <文档 id>")
        removed = docs_unregister(project, extra[0])
        out({"removed": removed, "project": project}, a.json,
            lambda r: print(f"已移除 {r['project']} 的登记" if r["removed"] else "没找到这条登记"))
    except ValueError as e:
        if a.json:
            print(json.dumps({"error": str(e)}, ensure_ascii=False))
        else:
            print(f"✗ {e}", file=sys.stderr)
        sys.exit(1)


def wiki_line(it, width=170):
    lab = WIKI_KINDS[it["kind"]]["label"] if it["kind"] else "记忆"
    body = it["text"]
    for label, v in it["fields"].items():
        if v:
            body += f" {label}{v}"
    body = re.sub(r"\s+", " ", body)
    return f"[{lab}] {it['key']}：{body[:width]}{'…' if len(body) > width else ''}"


def wiki_related(a, all_items):
    """`dispatch wiki related <task>`: the entries that mean the same thing as this task.
    Semantic first (智谱 embedding + sqlite-vec); falls back to the old project tag when the
    key is missing, the index cannot be built, or the semantic hits are empty."""
    limit = getattr(a, "limit", 8) or 8
    tid = (a.text or "").strip()
    issue = bd_json(["show", tid, "--json"])
    if not issue or not issue.get("id"):
        print(f"没有任务 {tid}", file=sys.stderr)
        sys.exit(1)
    kind = getattr(a, "kind", "pit") or "pit"
    proj = next((l.split(":", 1)[1] for l in issue.get("labels") or [] if l.startswith("project:")), "")
    query = "\n".join(x for x in [issue.get("title") or "", (issue.get("description") or "")[:1200]] if x)
    rows, why = [], ""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import semantic
        rows = semantic.related(tid, query, all_items, limit=limit, kind=kind)
    except Exception as e:
        why = str(e)[:120]
    if not rows:
        rows = [{**it, "score": None} for it in all_items
                if (kind == "all" or it["kind"] == kind) and (it["task"] == tid or (proj and it["project"].lower() == proj.lower()))]
        rows.sort(key=lambda it: (it["task"] != tid,))
        rows = rows[:limit]
        if why:
            print(f"语义搜索不可用（{why}），改用项目匹配", file=sys.stderr)
    semantic_hits = any(it.get("score") is not None for it in rows)

    def text(rs):
        for it in rs:
            score = f" {it['score']:.3f}" if it.get("score") is not None else ""
            print(wiki_line(it, 400) + score)
        print(f"\n{len(rs)} 条" + ("（语义）" if semantic_hits else "（按项目）"))
    out(rows, a.json, text)


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
    all_items = wiki_all()
    if a.op == "show":
        for it in all_items:
            if it["key"] == a.text or any(it["key"] == k["prefix"] + (a.text or "") for k in WIKI_KINDS.values()):
                print(it["raw"])
                return
        print("没有这条", file=sys.stderr)
        sys.exit(1)
    if a.op == "related":
        return wiki_related(a, all_items)
    kind = getattr(a, "kind", "") or ""
    q = (a.text or "").lower()
    if not a.all:
        all_items = [it for it in all_items if it["kind"]]
    items = [it for it in all_items if (not kind or kind == "all" or it["kind"] == kind)]
    if a.project:
        items = [it for it in items if it["project"] == a.project]
    keyword = lambda xs: [it for it in xs if q in it["raw"].lower() or q in it["key"].lower()]
    if getattr(a, "semantic", False) and q:
        # Meaning, not spelling: the query is embedded and the nearest entries come back.
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import semantic
            if not semantic.available():
                print("没有 ZHIPU_API_KEY，改用关键字匹配", file=sys.stderr)
                items = keyword(items)
            else:
                hits = semantic.search(a.text, all_items, limit=getattr(a, "limit", 8) or 8,
                                       kind=kind if kind != "all" else "", project=a.project or "")
                items = hits or keyword(items)
        except Exception as e:
            print(f"语义搜索不可用（{str(e)[:120]}），改用关键字匹配", file=sys.stderr)
            items = keyword(items)
    elif q:
        items = keyword(items)

    def text(items):
        for it in items:
            score = f" {it['score']:.3f}" if it.get("score") is not None else ""
            print(wiki_line(it, 400) + score)
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
_I_BOARD = re.compile(r"\bdispatch\s+(begin|claim|log|done)\b")
_I_LONG = 60
_I_BOARD_MIN = 15          # a session this long should have a task on the board
INSIGHTS_SEEN = os.path.join(DISPATCH_DIR, "insights-seen.json")

# What each signal means and how it is detected — shown in the app so the numbers are not a black box.
INSIGHT_RULES = [
    {"key": "asktail", "name": "问句/选项收尾", "how": "助手一条消息的最后 260 字里有「要不要 / 需要我 / 请确认 / 哪个 / ？」这类确认句式，且下一条是用户消息。若用户没有用「好 / 可以 / 继续」之类短句回答，而是直接说了别的事，就算「没被回答」——说明这个问题多半不必问。"},
    {"key": "correction", "name": "用户纠错/催促", "how": "用户消息（600 字以内）含「别问 / 直接做 / 怎么又 / 为什么没 / 不对 / 错了 / 说重点 / 别停 / 你忘 / 为什么不用」等词。每条都附上助手前一句作样本，由人判断属于哪类：没用工具、做过头、停太早、无效确认、忘记录。"},
    {"key": "overflow", "name": "上下文溢出", "how": "助手输出里出现 Prompt is too long / compaction failed / context window。这类会话应更早拆成新会话。"},
    {"key": "long", "name": "超长会话", "how": f"一个会话里用户发言 ≥ {_I_LONG} 轮。规则是一个任务一个会话，进度写到板上。"},
    {"key": "ends_on_question", "name": "停在问句上", "how": "会话最后一条是助手的问句，用户没有再回——可能是多余的确认，也可能是真卡住。"},
    {"key": "tool_errors", "name": "工具报错", "how": "转录里 tool_result 标了 is_error 的次数（命令失败、文件不存在、编辑没匹配到）。一个会话里超过 8 次通常是在原地打转。"},
    {"key": "no_board", "name": "长会话没上板", "how": f"用户发言 ≥ {_I_BOARD_MIN} 轮，但整个会话没有跑过 dispatch begin / claim / log / done。任务没记到板上，其他 Agent 和手机端都看不到它。"},
    {"key": "approve", "name": "纯确认回复", "how": "用户只回了「好 / 可以 / 继续 / 做吧」这类一两个字。多说明助手停下来等了一个本可不问的确认。"},
]


def insights_scan(days):
    from datetime import datetime, timedelta
    idx = load_index() or refresh_index()
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%dT") if days else ""
    per_agent, sessions, samples = {}, [], {"asktail": [], "correction": [], "overflow": []}
    def bump(ag, k, n=1):
        per_agent.setdefault(ag, {"sessions": 0, "user_turns": 0, "approve": 0, "continue": 0, "correction": 0, "asktail": 0, "ends_on_question": 0, "long": 0, "overflow": 0, "tool_errors": 0, "no_board": 0})[k] += n
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
        row = {"agent": ag, "session_id": e["session_id"], "cwd": e.get("cwd", ""), "title": (e.get("title") or "")[:60], "last_ts": (e.get("last_ts") or "")[:10], "last_at": e.get("last_ts") or "", "user_turns": len(U), "approve": 0, "continue": 0, "correction": 0, "asktail": 0, "overflow": 0, "ends_on_question": False, "tool_errors": 0, "no_board": False}
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
        row["tool_errors"] = tool_error_count(key)
        bump(ag, "tool_errors", row["tool_errors"])
        used_board = any(_I_BOARD.search(t.get("summary", "")) for m in msgs for t in m.get("tools", []))
        if len(U) >= _I_BOARD_MIN and not used_board:
            row["no_board"] = True; bump(ag, "no_board")
        sessions.append(row)
    sessions.sort(key=lambda r: -(r["correction"] * 3 + r["asktail"] + r["overflow"] * 3 + r["continue"] + min(r["tool_errors"], 10) // 2 + (3 if r["no_board"] else 0)))
    return {"days": days, "per_agent": per_agent, "sessions": sessions[:12], "all_sessions": sessions, "samples": {k: v[-8:] for k, v in samples.items()}, "total_sessions": len(sessions)}


INSIGHTS_CACHE = os.path.join(DISPATCH_DIR, "insights-cache.json")


def insights_scan_cached(days):
    """The scan reads every recent transcript (seconds); the app asks for it on every visit.
    Keyed by the transcript index's mtime+size, so it is only recomputed when a session changed."""
    try:
        st = os.stat(INDEX_FILE); key = f"{days}:{int(st.st_mtime)}:{st.st_size}"
    except OSError:
        return insights_scan(days)
    try:
        c = json.load(open(INSIGHTS_CACHE))
        if c.get("key") == key and c.get("days") == days:
            return c["rep"]
    except Exception:
        pass
    rep = insights_scan(days)
    try:
        os.makedirs(DISPATCH_DIR, exist_ok=True)
        tmp = INSIGHTS_CACHE + ".tmp"
        json.dump({"key": key, "days": days, "rep": rep}, open(tmp, "w"), ensure_ascii=False)
        os.replace(tmp, INSIGHTS_CACHE)
    except OSError:
        pass
    return rep


def tool_error_count(path):
    """How many tool results the transcript marked as errors; a cheap substring scan."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return sum(line.count('"is_error":true') + line.count('"is_error": true') for line in f if "is_error" in line)
    except OSError:
        return 0


def insights_alerts(rep):
    """Session-level events worth telling a person about *now*, each with a stable id so the
    app can notify once. This is the proactive half of /insights."""
    out = []
    for r in rep.get("all_sessions", rep["sessions"]):
        sid, tag = r["session_id"], f"{r['agent']} {r['session_id'][:8]}"
        name = r.get("title") or (r.get("cwd") or "").replace(HOME, "~")[-40:] or sid[:8]
        if r["correction"] >= 3:
            out.append({"id": f"corr:{sid}:{r['correction'] // 3}", "kind": "correction", "session_id": sid, "agent": r["agent"], "ts": r["last_at"], "text": f"「{name}」里你纠错/催促了 {r['correction']} 次——这个会话值得回看，看是哪类问题在重复。"})
        if r["overflow"]:
            out.append({"id": f"ovf:{sid}", "kind": "overflow", "session_id": sid, "agent": r["agent"], "ts": r["last_at"], "text": f"「{name}」撞到上下文上限 {r['overflow']} 次：让它把进度写到板上，开新会话续做。"})
        if r["tool_errors"] >= 8:
            out.append({"id": f"err:{sid}:{r['tool_errors'] // 8}", "kind": "tool_errors", "session_id": sid, "agent": r["agent"], "ts": r["last_at"], "text": f"「{name}」有 {r['tool_errors']} 次工具报错，可能在原地打转。"})
        if r["no_board"]:
            out.append({"id": f"board:{sid}:{r['user_turns'] // 15}", "kind": "no_board", "session_id": sid, "agent": r["agent"], "ts": r["last_at"], "text": f"「{name}」已经 {r['user_turns']} 轮却没有上任务板（没跑过 dispatch begin/log/done）。"})
        if r["user_turns"] >= _I_LONG:
            out.append({"id": f"long:{sid}:{r['user_turns'] // 30}", "kind": "long", "session_id": sid, "agent": r["agent"], "ts": r["last_at"], "text": f"「{name}」已经 {r['user_turns']} 轮：该拆新会话了。"})
    out.sort(key=lambda x: x["ts"], reverse=True)
    return out


def insights_seen_load():
    try:
        return json.load(open(INSIGHTS_SEEN))
    except Exception:
        return {"seen": [], "acked_at": 0}


def insights_seen_save(d):
    os.makedirs(DISPATCH_DIR, exist_ok=True)
    tmp = INSIGHTS_SEEN + ".tmp"
    json.dump(d, open(tmp, "w"), ensure_ascii=False)
    os.replace(tmp, INSIGHTS_SEEN)


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
    if tot("tool_errors"):
        worst = max(rep["sessions"], key=lambda r: r["tool_errors"], default=None)
        out.append(f"工具报错 {tot('tool_errors')} 次" + (f"，最多的一个会话 {worst['tool_errors']} 次（{worst['agent']} {worst['session_id'][:8]}）" if worst and worst["tool_errors"] >= 8 else "") + "：连续报错说明在原地打转，该换思路或问人。")
    if tot("no_board"):
        out.append(f"{tot('no_board')} 个 ≥ {_I_BOARD_MIN} 轮的会话从没跑过 dispatch begin/log/done：工作没记到板上，其他 Agent 和手机端看不到。")
    if not out:
        out.append("这段时间没有明显的行为信号。")
    return out


def cmd_insights(a):
    if getattr(a, "op", None):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import insights_report
        return insights_report.main(a)
    rep = insights_scan_cached(a.days)
    rep["findings"] = insights_findings(rep)
    rep["rules"] = INSIGHT_RULES
    seen = insights_seen_load()
    alerts = insights_alerts(rep)
    rep["alerts"] = [dict(x, seen=x["id"] in seen["seen"]) for x in alerts]
    rep.pop("all_sessions", None)
    if getattr(a, "ack", False):
        seen["seen"] = sorted(set(seen["seen"]) | {x["id"] for x in alerts})[-500:]
        seen["acked_at"] = time.time()
        insights_seen_save(seen)
    if getattr(a, "alerts", False):
        fresh = [x for x in rep["alerts"] if not x["seen"]]
        return out(fresh, a.json, lambda xs: [print(f"- [{x['agent']} {x['session_id'][:8]}] {x['text']}") for x in xs] or (print("没有新的洞察告警") if not xs else None))
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
        print(f"{'agent':<11}{'会话':>5}{'轮':>6}{'确认':>5}{'继续':>5}{'纠错':>5}{'问句':>5}{'停问':>5}{'长':>4}{'溢出':>5}{'报错':>5}{'没上板':>6}")
        for ag, c in rep["per_agent"].items():
            print(f"{ag:<11}{c['sessions']:>5}{c['user_turns']:>6}{c['approve']:>5}{c['continue']:>5}{c['correction']:>5}{c['asktail']:>5}{c['ends_on_question']:>5}{c['long']:>4}{c['overflow']:>5}{c['tool_errors']:>5}{c['no_board']:>6}")
        if rep["alerts"]:
            print("\n## 主动洞察（未确认的）")
            for x in rep["alerts"]:
                if not x["seen"]:
                    print(f"- [{x['agent']} {x['session_id'][:8]}] {x['text']}")
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


def cmd_project_summary(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import summarize
    try:
        r = summarize.project_summary(a.name, force=a.force, if_stale=a.if_stale)
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False) if a.json else f"✗ {e}")
        sys.exit(1)
    out(r, a.json, lambda x: print(x.get("summary") or "（还没有总结）"))


def cmd_session_summary(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import summarize
    summarize.main(a)


def cmd_move(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import move
    move.main(a)


def cmd_update(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import updater
    updater.main(a)


def cmd_init(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import init_wizard
    init_wizard.main(a)


def cmd_notify(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import notify
    notify.main(a)


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


def git_root_name(cwd):
    """The folder that holds .git, walking up from cwd but never past $HOME; '' if none."""
    d = os.path.normpath(cwd or "")
    while d and d not in ("/", HOME) and d.startswith(HOME):
        if os.path.isdir(os.path.join(d, ".git")) or os.path.isfile(os.path.join(d, ".git")):
            return os.path.basename(d)
        d = os.path.dirname(d)
    return ""


def workspace_project(cwd, roots=None):
    """~/Projects/<x>/… is <x> for every root in settings; '' when cwd is not under one."""
    cwd = os.path.normpath(cwd or "")
    for r in (roots if roots is not None else settings_load().get("workspace_roots") or []):
        root = os.path.normpath(os.path.expanduser(r))
        if cwd.startswith(root + os.sep):
            # `<project>-wt/<branch>` holds git worktrees of <project>: same project.
            return re.sub(r"-wt$", "", cwd[len(root) + 1:].split(os.sep)[0])
    return ""


def project_of_cwd(cwd, names, roots=None):
    # Same precedence as the app: workspace root, a known project name on the path, the git repo root.
    # Pass `roots` when calling in a loop: looking them up means a `bd memories` round-trip.
    ws = workspace_project(cwd, roots)
    if ws:
        return ws
    parts = [x.lower() for x in os.path.normpath(cwd).split(os.sep) if x]
    for part in reversed(parts):
        if part in names:
            return names[part]
    return git_root_name(cwd)


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


def session_edit_map(window=30 * 60, with_activity=True):
    """Recent file edits per session inside `window` seconds.

    Two sources, because neither is complete alone: the edit-guard registry (Pre/PostToolUse
    hooks — exact timestamp, but only agents that installed the hook) and the incremental
    transcript index (every Edit/Write a conversation ran, whichever agent). Keyed by
    session_id; files are absolute paths, values are epoch seconds.
    """
    now = time.time()
    out = {}

    def add(sid, agent, path, ts, source, cwd=""):
        if not sid or not path:
            return
        rec = out.setdefault(sid, {"session_id": sid, "agent": agent or "", "cwd": cwd or "", "files": {}, "source": {}})
        if agent and not rec["agent"]:
            rec["agent"] = agent
        if cwd and not rec["cwd"]:
            rec["cwd"] = cwd
        p = os.path.abspath(path)
        if p not in rec["files"] or ts > rec["files"][p]:
            rec["files"][p] = ts
        if source == "edit-guard" or p not in rec["source"]:
            rec["source"][p] = source

    for n in os.listdir(EDITS_DIR) if os.path.isdir(EDITS_DIR) else []:
        try:
            r = json.load(open(os.path.join(EDITS_DIR, n)))
        except Exception:
            continue
        ts = r.get("ts", 0)
        if now - ts <= window:
            add(r.get("session_id", ""), r.get("agent", ""), r.get("file", ""), ts, "edit-guard")
    if with_activity:
        try:
            from activity import activity_list
            for s in activity_list(HOME, DISPATCH_DIR, load_index()):
                for f, ts in (s.get("files") or {}).items():
                    if now - ts <= window:
                        add(s.get("session_id", ""), s.get("agent", ""), f, ts, "activity", s.get("cwd", ""))
        except Exception:
            pass
    return out


def session_cwd_map():
    """session_id → cwd for live sessions (edit-guard records carry no directory)."""
    m = {}
    try:
        for s in live_sessions(local_only=True):
            sid = s.get("session_id")
            if sid and s.get("cwd"):
                m.setdefault(sid, s["cwd"])
    except Exception:
        pass
    return m


def _edit_in_dir(rec, cwd):
    """Same directory or nested below it — matching neighbours(); falls back to the file
    paths when the session has no recorded cwd."""
    d = os.path.normpath(cwd)
    c = os.path.normpath(rec.get("cwd") or "")
    if c and (c == d or c.startswith(d + os.sep) or d.startswith(c + os.sep)):
        return True
    return any(f == d or f.startswith(d + os.sep) for f in rec["files"])


def cmd_editing(a):
    """Who is editing which file right now, and where two sessions landed on the same one."""
    window = max(1, int(getattr(a, "window", 30))) * 60
    edits = session_edit_map(window)
    cwds = session_cwd_map()
    for rec in edits.values():
        if not rec["cwd"]:
            rec["cwd"] = cwds.get(rec["session_id"], "")
    d = os.path.abspath(os.path.expanduser(a.dir)) if getattr(a, "dir", None) else ""
    recs = [r for r in edits.values() if r["files"] and (not d or _edit_in_dir(r, d))]
    by_file = {}
    for r in recs:
        for f, ts in r["files"].items():
            e = by_file.setdefault(f, {"file": f, "editors": []})
            e["editors"].append({"agent": r["agent"], "session_id": r["session_id"], "cwd": r["cwd"], "ts": ts, "source": r["source"].get(f, "")})
    for e in by_file.values():
        e["editors"].sort(key=lambda x: -x["ts"])
        e["conflict"] = len({x["session_id"] for x in e["editors"]}) > 1
    files = sorted(by_file.values(), key=lambda e: (not e["conflict"], -max(x["ts"] for x in e["editors"])))
    recs.sort(key=lambda r: -max(r["files"].values()))
    sessions = [{"agent": r["agent"], "session_id": r["session_id"], "cwd": r["cwd"],
                 "files": [f for f, _ in sorted(r["files"].items(), key=lambda kv: -kv[1])]} for r in recs]
    report = {"window_minutes": window // 60, "dir": d or None, "files": files, "sessions": sessions}

    def text(o):
        if not o["files"]:
            print(f"最近 {o['window_minutes']} 分钟没有会话改动文件")
            return
        print(f"最近 {o['window_minutes']} 分钟有 {len(o['sessions'])} 个会话改过 {len(o['files'])} 个文件")
        for e in o["files"]:
            who = "、".join(f"{x['agent'] or '?'} {x['session_id'][:8]}" for x in e["editors"])
            print(f"{'⚠ 冲突 ' if e['conflict'] else '   '}{e['file']}  ← {who}")
    out(report, a.json, text)


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


AGENT_ACTORS = {"claude-code", "claude", "codex", "pi", "zcode", "cursor"}


def bd_comments(tid):
    code, o, err = sh(["bd", "comments", tid, "--json"])
    if code != 0:
        return []
    try:
        d = json.loads(o[o.find("["):])
    except Exception:
        return []
    return sorted(d, key=lambda c: c.get("created_at", "")) if isinstance(d, list) else []


def human_note(comments, actor):
    """The user's latest note on a task, while no agent has answered it since.
    The task detail's 留言 box has no other reader; this is how it reaches the agent."""
    if not comments:
        return ""
    last = comments[-1]
    author = (last.get("author") or "").lower()
    if not author or author in AGENT_ACTORS or author == (actor or "").lower():
        return ""
    return re.sub(r"\s+", " ", last.get("text") or "").strip()[:240]


# ---------------------------------------------------------------- dynamic workflow: discuss, then split
# A task can be talked over by several agents before anyone touches code: each one reads
# the task and the earlier voices, leaves exactly one 【讨论】 comment, and stops. The
# initiator then splits the task into sub-tasks and hands each to an agent.
DISCUSS_TAG = "【讨论】"
SPLIT_TAG = "【分工】"


def self_cmd():
    return [sys.executable, os.path.realpath(__file__)]


def task_project_dir(issue, names=None):
    """Where an agent working on this task should sit: the project's latest conversation
    folder, else ~/Projects/<project>, else here."""
    proj = next((l.split(":", 1)[1] for l in issue.get("labels") or [] if l.startswith("project:")), "")
    if not proj:
        return os.getcwd()
    names = names if names is not None else project_names()
    best = ("", 0)
    try:
        roots = settings_load().get("workspace_roots") or []
        by_cwd = {}
        for e in load_index().values():
            cwd = (e.get("cwd") or "").rstrip("/")
            if not cwd or e.get("mtime", 0) <= best[1]:
                continue
            if cwd not in by_cwd:
                by_cwd[cwd] = os.path.isdir(cwd) and project_of_cwd(cwd, names, roots).lower() == proj.lower()
            if by_cwd[cwd]:
                best = (cwd, e.get("mtime", 0))
    except Exception:
        pass
    if best[0]:
        return best[0]
    guess = os.path.join(HOME, "Projects", proj)
    return guess if os.path.isdir(guess) else os.getcwd()


DISCUSSION_LABEL = "dispatch:discussion"   # a task that exists only to hold a discussion (topic / project)


DISCUSS_GUIDE = ("说话的规矩：你是讨论群里的一个成员，用自己的身份（Agent 名 + 模型）说话，像一个有主见的同事，不像表单。"
                 "先看发起人最新说的是什么：如果只是打招呼、闲聊或一句短话，就自然地回一两句（比如问好、问对方想聊什么），不要套任何格式、不要分析、不要写风险和拆分；"
                 "如果是一个可以做的提议或问题，再给出你的判断（做 / 不做 / 换个做法）和理由，需要时附做法、拆分建议（每个子任务一行：标题 · 建议谁做 · 为什么）和风险，但只写有内容的部分，别为了凑段落硬写。"
                 "针对别人已经说过的观点回应，不重复；不改代码、不认领任务；一次只留一条评论，写完就停。")


def discuss_prompt(tid, title, round_no, question="", topic=False, project="", who=""):
    ctx = ""
    if topic:
        ctx = ("这是一个念头/主题的讨论，不是已定的任务。"
               + (f" 它挂在项目「{project}」下：需要时用 `dispatch project-summary {project}` 看项目现状、`bd list -l project:{project} --json` 看未完成任务、`dispatch wiki search {project}` 看这个项目踩过的坑。" if project else ""))
    sign = f" 发言开头署名「{who}」。" if who else ""
    if round_no <= 1:
        return (f"你参加{'主题' if topic else '任务'} {tid}「{title}」的讨论。{ctx}{DISCUSS_GUIDE}{sign}"
                f"步骤：1) `bd show {tid}` 读背景（描述里若列了附图路径，先用 Read 看图）；2) `bd comments {tid}` 读已有发言（带{DISCUSS_TAG}的，发起人插话也在里面）；"
                f"3) 只写一条评论：`dispatch log {tid} \"{DISCUSS_TAG}<署名>：…\"`。" + (f" 发起人的问题：{question}" if question else ""))
    return (f"第 {round_no} 轮：`bd comments {tid}` 再读一遍，特别是发起人最新插的话和别人的{DISCUSS_TAG}发言（发言里若有附图路径，用 Read 看），用一条 `dispatch log {tid} \"{DISCUSS_TAG}<署名>：…\"` 回应。{DISCUSS_GUIDE}{sign}")


# ---- headless rounds: the CLI calls claude -p / codex exec / pi -p directly, feeds the thread
# in the prompt and writes the reply as the member's 【讨论】 comment. No Herdr tab, no shell
# start-up, no `bd show` + `bd comments` + `dispatch log` round trips per statement.
DISCUSSIONS_DIR = os.path.join(DISPATCH_DIR, "discussions")
HEADLESS_KINDS = ("claude", "codex", "pi")
IMG_RE = re.compile(r"((?:~|/)[^\s\"'`<>()\[\]]+?\.(?:png|jpe?g|gif|webp|bmp))", re.I)


def node_bin_dirs():
    """Where npm-installed CLIs (codex, pi, gemini…) live when the caller is the app, not a
    login shell: the global npm prefix, volta/bun, the newest nvm node."""
    dirs = [os.path.join(HOME, "npm-global", "bin"), os.path.join(HOME, ".npm-global", "bin"), os.path.join(HOME, ".volta", "bin"), os.path.join(HOME, ".bun", "bin")]
    dirs += sorted(glob.glob(os.path.join(HOME, ".nvm", "versions", "node", "*", "bin")), reverse=True)[:1]
    return [d for d in dirs if os.path.isdir(d)]


def child_env():
    """Environment for a headless CLI child: PATH extended (incl. npm's global bin, since the
    app's PATH is not a login shell's), every CLAUDE* variable stripped (a claude started from
    inside a Claude Code session refuses to nest otherwise), BEADS_DIR set."""
    e = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}
    e["PATH"] = ":".join([PATH_EXTRA] + node_bin_dirs() + [e.get("PATH", "")])
    e.setdefault("BEADS_DIR", BEADS_DIR)
    return e


def discussion_images(*texts):
    """Picture paths mentioned in the idea or a statement (the app writes them in as lines)."""
    seen, found = set(), []
    for t in texts:
        for m in IMG_RE.findall(t or ""):
            p = os.path.expanduser(m)
            if p not in seen and os.path.isfile(p):
                seen.add(p); found.append(p)
    return found


def discussion_lines(comments):
    """The 【讨论】 statements as `[author] text` lines, in order."""
    rows = []
    for c in comments:
        t = (c.get("text") or "").strip()
        if t.startswith(DISCUSS_TAG):
            rows.append(f"[{c.get('author')}] {t[len(DISCUSS_TAG):].strip()}")
    return rows


def discussion_thread(issue, comments):
    """The whole thread as one block of text: the idea, then every statement in order."""
    desc = (issue.get("description") or "").split("\n\n## 讨论文档", 1)[0].strip()
    title = (issue.get("title") or "").replace(DISCUSS_TAG, "", 1).strip()
    return f"主题：{title}\n{desc}\n\n发言（按时间）：\n" + "\n\n".join(discussion_lines(comments))


def discussion_system(who, kind, settings):
    """The member's standing identity — persona from settings, the group's rules, the output
    contract — injected at system level (claude/pi --append-system-prompt, codex
    developer_instructions), so no round has to repeat it."""
    persona = (settings.get(f"discuss_persona_{kind}") or "").strip()
    rules = (settings.get("discuss_rules") or DISCUSS_RULES_DEFAULT).strip()
    return (f"你是讨论群里的成员「{who}」，像一个有主见的同事说话，不像表单。" + (f"你的人设：{persona}" if persona else "")
            + f"群里的规矩：{rules}"
            "先看最新一条说的是什么：打招呼或闲聊就自然回一两句（问好、问对方想聊什么），不要分析、不要套格式；是一个可以做的提议或问题，才给判断（做 / 不做 / 换个做法）和理由，需要时附做法或拆分建议（每个子任务一行：标题 · 建议谁做 · 为什么）。"
            "你的输出就是这一条发言的正文：不署名、不加【讨论】、不用 Markdown 标题；不改代码、不认领任务；线程里没有的情况才用工具查。")


def headless_prompt(tid, title, round_no, thread, who, question="", topic=False, project="", images=()):
    ctx = ""
    if topic:
        ctx = ("这是一个念头/主题的讨论，不是已定的任务。"
               + (f" 它挂在项目「{project}」下（项目现状：`dispatch project-summary {project}`、`bd list -l project:{project} --json`、`dispatch wiki search {project}`）。" if project else ""))
    head = (f"你参加{'主题' if topic else '任务'} {tid}「{title}」的讨论（第 {round_no} 轮）。{ctx}线程完整贴在下面，不用再读板；回你的发言，没有新东西就只回 SKIP。"
            + (f" 发起人的问题：{question}" if question else "")
            + ("\n附图（发言前用 Read 工具看一遍）：\n" + "\n".join(images) if images else ""))
    return head + "\n\n=== 线程 ===\n" + thread


def headless_call(kind, model, prompt, cwd, timeout_ms, images=(), system="", session="", resume=False, on_event=None, thinking=""):
    """One statement from one member. Returns {text, session, error, secs}. The session id is
    what the next round resumes with (claude --resume, codex exec resume, pi --session-id).
    `thinking` is pi's --thinking level (a discussion turn runs it low: GLM-class models
    otherwise think for a minute before a two-line reply).
    on_event(status, text_so_far, step) is called as the reply streams in (claude and pi send
    text deltas; codex only says when it is thinking and when it is done). `step` names what the
    member is doing besides typing: 想：<the thought so far> or 查：<tool> <what> — the app's
    bubble shows it as 在想 / 在查."""
    t0 = time.time()
    env = child_env()
    lastfile = ""
    if kind == "claude":
        argv = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions"] + (["--model", model] if model else []) + (["--append-system-prompt", system] if system else []) + (["--resume", session] if resume and session else [])
    elif kind == "codex":
        lastfile = os.path.join(DISPATCH_DIR, "tmp", f"codex-{os.getpid()}-{int(t0 * 1000)}.txt")
        os.makedirs(os.path.dirname(lastfile), exist_ok=True)
        common = ["--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-o", lastfile] + (["-m", model] if model else []) + (["-c", "developer_instructions=" + json.dumps(system, ensure_ascii=False)] if system else [])
        imgs = [x for p in images for x in ("-i", p)]
        if resume and session:
            argv = ["codex", "exec", "resume", session] + common + imgs + [prompt]
        else:
            argv = ["codex", "exec", "-C", cwd] + common + imgs + [prompt]
    elif kind == "pi":
        sdir = os.path.join(DISCUSSIONS_DIR, "pi-sessions")
        os.makedirs(sdir, exist_ok=True)
        if not session:
            import uuid
            session = str(uuid.uuid4())
        argv = ["pi", "-p", "--mode", "json", "--session-dir", sdir, "--session-id", session] + (["--model", model] if model else []) + (["--thinking", thinking] if thinking else []) + (["--append-system-prompt", system] if system else []) + ["--"] + [f"@{p}" for p in images] + [prompt]
    else:
        return {"text": "", "session": "", "error": f"{kind} 没有无头模式", "secs": 0}
    raw_emit = on_event or (lambda status, text, step="": None)

    def emit(status, text, step=""):
        try:
            raw_emit(status, text, step)
        except TypeError:  # an older callback that only takes (status, text)
            raw_emit(status, text)
    emit("thinking", "")
    lines, partial = [], []
    thought, tool_json, cur = [], [], {"block": ""}  # the thinking / tool-input block being streamed

    def tool_step(name, args):
        inp = {}
        try:
            inp = json.loads(args) if args else {}
        except Exception:
            pass
        what = inp.get("command") or inp.get("file_path") or inp.get("path") or inp.get("pattern") or inp.get("description") or inp.get("prompt") or "" if isinstance(inp, dict) else ""
        return f"查：{name} {str(what)[:80]}".strip()

    def stream_line(line):
        """Live text for the typing bubble; the final parse below reads the whole output again."""
        try:
            ev = json.loads(line)
        except Exception:
            return
        if kind == "claude" and ev.get("type") == "stream_event":
            e = ev.get("event") or {}
            d = e.get("delta") or {}
            et = e.get("type")
            if et == "content_block_start":
                cb = e.get("content_block") or {}
                cur["block"] = cb.get("type", "")
                if cur["block"] == "thinking":
                    thought.clear(); emit("thinking", "".join(partial), "想：")
                elif cur["block"] == "tool_use":
                    tool_json.clear(); cur["tool"] = cb.get("name", ""); emit("thinking", "".join(partial), tool_step(cur["tool"], ""))
            elif d.get("type") == "text_delta" and d.get("text"):
                partial.append(d["text"]); emit("typing", "".join(partial))
            elif d.get("type") == "thinking_delta" and d.get("thinking"):
                thought.append(d["thinking"]); emit("thinking", "".join(partial), "想：" + "".join(thought)[-160:])
            elif d.get("type") == "input_json_delta":
                tool_json.append(d.get("partial_json") or "")
                if len(tool_json) % 8 == 0:  # the arguments take shape; refresh the "查：" line now and then
                    emit("thinking", "".join(partial), tool_step(cur.get("tool", ""), "".join(tool_json)))
            elif et == "content_block_stop" and cur["block"] == "tool_use":
                emit("thinking", "".join(partial), tool_step(cur.get("tool", ""), "".join(tool_json)))
        elif kind == "claude" and ev.get("type") == "assistant":
            # a whole message (after tool use the text so far is repeated): start the bubble over
            parts = [c.get("text", "") for c in ((ev.get("message") or {}).get("content") or []) if c.get("type") == "text"]
            if parts and not partial:
                emit("typing", "".join(parts))
        elif kind == "claude" and ev.get("type") == "user":
            # the tool answered; the member reads it and goes on
            emit("thinking", "".join(partial), "")
        elif kind == "pi" and ev.get("type") == "message_update":
            d = ev.get("assistantMessageEvent") or {}
            if d.get("type") == "text_delta" and d.get("delta"):
                partial.append(d["delta"]); emit("typing", "".join(partial))
            elif d.get("type") == "text_start":
                partial.clear()
            elif d.get("type") == "thinking_start":
                thought.clear(); emit("thinking", "".join(partial), "想：")
            elif d.get("type") == "thinking_delta" and d.get("delta"):
                thought.append(d["delta"]); emit("thinking", "".join(partial), "想：" + "".join(thought)[-160:])
            elif d.get("type") == "toolcall_start":
                emit("thinking", "".join(partial), tool_step((d.get("toolCall") or d.get("partial") or {}).get("name") or d.get("name") or "", ""))
        elif kind == "pi" and ev.get("type") in ("tool_execution_start",):
            emit("thinking", "".join(partial), tool_step(ev.get("toolName") or "", json.dumps(ev.get("args") or {}, ensure_ascii=False)))
        elif kind == "codex" and ev.get("type") == "item.started" and (ev.get("item") or {}).get("type") == "command_execution":
            emit("thinking", "".join(partial), f"查：{str((ev['item'].get('command') or ''))[:80]}")
        elif kind == "codex" and ev.get("type") == "item.completed" and (ev.get("item") or {}).get("type") == "reasoning":
            emit("thinking", "".join(partial), "想：" + str(ev["item"].get("text") or "")[-160:])
        elif kind == "codex" and ev.get("type") == "item.completed" and (ev.get("item") or {}).get("type") == "agent_message":
            emit("typing", ev["item"].get("text") or "")

    try:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, env=env, cwd=cwd)
    except FileNotFoundError:
        emit("error", f"没装 {kind}")
        return {"text": "", "session": session, "error": f"没装 {kind}", "secs": round(time.time() - t0, 1)}
    import threading as _th
    err_buf = []
    reader = _th.Thread(target=lambda: err_buf.append(proc.stderr.read()), daemon=True)
    reader.start()
    deadline = t0 + max(30, timeout_ms // 1000)
    timed_out = False
    for raw in proc.stdout:
        line = raw.decode("utf-8", "replace")
        lines.append(line)
        stream_line(line)
        if time.time() > deadline:
            timed_out = True
            proc.kill()
            break
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
    reader.join(timeout=5)
    if timed_out:
        emit("error", f"{timeout_ms // 1000} 秒没说完")
        return {"text": "", "session": session, "error": f"{timeout_ms // 1000} 秒没说完", "secs": round(time.time() - t0, 1)}
    o, err = "".join(lines), (err_buf[0] if err_buf else b"").decode("utf-8", "replace")
    returncode = proc.returncode
    text, sid, error, usage = "", session, "", {}
    if kind == "claude":
        d = {}
        for line in o.splitlines():
            try:
                ev = json.loads(line)
            except Exception:
                continue
            if ev.get("type") == "result":
                d = ev
            elif ev.get("type") == "system" and ev.get("subtype") == "init":
                sid = ev.get("session_id") or sid
        if d:
            text = d.get("result") or ""
            sid = d.get("session_id") or sid
            u = d.get("usage") or {}
            usage = {"input": u.get("input_tokens", 0), "cached": u.get("cache_read_input_tokens", 0), "output": u.get("output_tokens", 0)}
            if d.get("is_error"):
                error = (text or d.get("subtype") or "claude 报错")[:200]
        else:
            error = (err or o).strip()[-300:] or "claude 没有输出"
    elif kind == "codex":
        for line in o.splitlines():
            try:
                ev = json.loads(line)
            except Exception:
                continue
            if ev.get("type") == "thread.started":
                sid = ev.get("thread_id") or sid
            elif ev.get("type") == "item.completed" and (ev.get("item") or {}).get("type") == "agent_message":
                text = (ev["item"].get("text") or "") or text
            elif ev.get("type") == "turn.completed":
                u = ev.get("usage") or {}
                usage = {"input": u.get("input_tokens", 0) - u.get("cached_input_tokens", 0), "cached": u.get("cached_input_tokens", 0), "output": u.get("output_tokens", 0)}
            elif ev.get("type") == "error":
                error = (ev.get("message") or "codex 报错")[:200]
        try:
            text = open(lastfile).read().strip() or text
            os.unlink(lastfile)
        except Exception:
            pass
    else:
        # pi --mode json: one event per line; the last assistant message_end carries text + usage
        for line in o.splitlines():
            try:
                ev = json.loads(line)
            except Exception:
                continue
            m = ev.get("message") or {}
            if ev.get("type") == "message_end" and m.get("role") == "assistant":
                text = "".join(c.get("text", "") for c in m.get("content", []) if c.get("type") == "text") or text
                u = m.get("usage") or {}
                usage = {"input": u.get("input", 0), "cached": u.get("cacheRead", 0), "output": u.get("output", 0)}
            elif ev.get("type") == "error":
                error = (ev.get("message") or ev.get("error") or "pi 报错")[:200]
        if not text and not error and o.strip() and not o.lstrip().startswith("{"):
            text = o.strip()
    if returncode != 0 and not text:
        error = error or (err or o).strip()[-300:] or f"退出码 {returncode}"
    emit("error" if error and not text else ("skip" if is_skip(text) else "done"), text.strip())
    return {"text": text.strip(), "session": sid, "error": error, "secs": round(time.time() - t0, 1), "usage": usage, "prompt_chars": len(prompt)}


def discussion_state_path(tid):
    return os.path.join(DISCUSSIONS_DIR, f"{tid}.json")


def discussion_state_load(tid):
    try:
        d = json.load(open(discussion_state_path(tid)))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def discussion_state_save(tid, state):
    os.makedirs(DISCUSSIONS_DIR, exist_ok=True)
    tmp = discussion_state_path(tid) + ".tmp"
    json.dump(state, open(tmp, "w"), ensure_ascii=False, indent=1)
    os.replace(tmp, discussion_state_path(tid))


def headless_followup_prompt(tid, round_no, new_lines, who, question="", images=()):
    """For a member whose session is resumed: only what was said since it last spoke."""
    return (f"第 {round_no} 轮，新发言在下面（你自己说过的不再重复）；回你的发言，没有新东西就只回 SKIP。"
            + (f" 发起人的问题：{question}" if question else "")
            + ("\n附图（用 Read 工具看）：\n" + "\n".join(images) if images else "")
            + "\n\n=== 新发言 ===\n" + ("\n\n".join(new_lines) if new_lines else "（没有新发言）"))


class DiscussionLive:
    """discussions/<task>.live.json — what each member is doing right now (queued / thinking /
    typing + the text so far / done / skip / error), rewritten as the replies stream in; the
    app polls it to draw the typing bubbles."""

    def __init__(self, tid, round_no, members, judge=None):
        import threading as _th
        self.path = os.path.join(DISCUSSIONS_DIR, f"{tid}.live.json")
        self.lock = _th.Lock()
        self.last_write = 0.0
        self.state = {"task": tid, "round": round_no, "started": int(time.time()), "at": int(time.time()), "members": {who: {"kind": kind, "status": "queued", "text": "", "at": int(time.time())} for who, kind in members}, **({"judge": judge} if judge else {})}
        self.flush(force=True)

    def update(self, who, status, text, step=""):
        with self.lock:
            m = self.state["members"].setdefault(who, {})
            changed = m.get("status") != status or (m.get("step") or "") != (step or "")
            m.update({"status": status, "text": text[-4000:], "step": (step or "")[:200], "at": int(time.time())})
            self.flush(force=changed)   # a status / step change lands at once; text deltas are throttled

    def flush(self, force=False):
        now = time.time()
        if not force and now - self.last_write < 0.4:
            return
        self.last_write = now
        self.state["at"] = int(now)
        try:
            os.makedirs(DISCUSSIONS_DIR, exist_ok=True)
            tmp = self.path + ".tmp"
            json.dump(self.state, open(tmp, "w"), ensure_ascii=False)
            os.replace(tmp, self.path)
        except Exception:
            pass

    def finish(self):
        with self.lock:
            self.state["finished"] = int(time.time())
            self.flush(force=True)


def cmd_discuss_live(a):
    path = os.path.join(DISCUSSIONS_DIR, f"{a.task}.live.json")
    try:
        d = json.load(open(path))
    except Exception:
        d = {}
    out(d, True, None)


def clean_statement(text, who):
    """The model was told not to sign; drop a signature or tag if it did anyway."""
    t = text.strip()
    t = re.sub(r"^【讨论】\s*", "", t)
    for name in (who, who.split("（")[0]):
        if name and t.startswith(name):
            rest = t[len(name):].lstrip()
            if rest[:1] in ("：", ":"):
                t = rest[1:].strip(); break
    return t


def is_skip(text):
    t = text.strip().strip("`*_ 。.").upper()
    return t in ("SKIP", "【SKIP】", "跳过") or (t.startswith("SKIP") and len(t) <= 12)


DISCUSS_PI_THINKING = "low"   # pi's --thinking in a discussion turn; its default level makes GLM think longer than it talks
MENTION_ALL = ("all", "everyone", "大家", "所有人", "各位", "全体")
MENTION_RE = re.compile(r"@([A-Za-z][\w.-]*(?:[（(:][\w.-]+[）)]?)?|大家|所有人|各位|全体)")
# A member is "challenged" when someone else names it in a sentence that questions or refers
# to what it said — not when the name is just the CLI being talked about (`claude -p 直调`).
CHALLENGE_RE = re.compile(r"[?？]|不对|不同意|反对|质疑|有问题|存疑|不认同|错了|说错|未必|不一定|不见得|说的|说得|讲的|的方案|的提议|的建议|的观点|的看法|的判断|的说法|的结论|的做法|回应|解释|澄清|反驳|商榷|担心|顾虑|怎么看|什么看法|什么意见|你觉得|你认为|请.{0,6}(说|讲|答|解)")
SENTENCE_RE = re.compile(r"[。！？!?\n；;]+")


def member_names(kind, model):
    """How people write a member's name: the kind, the model, kind（model）/ kind:model, its actor."""
    names = {kind.lower(), KIND_ACTOR.get(kind, kind).lower()}
    if model:
        names |= {model.lower(), f"{kind}（{model}）".lower(), f"{kind}({model})".lower(), f"{kind}:{model}".lower()}
    return names


def discussion_judge(fresh, parts, member_actors=None):
    """The cheap referee: who has to speak this round, decided from what was said since the
    last round — no model call. Returns {"everyone": bool, "picked": [index…], "reasons": {index: [why…]}, "why": str}.
    Rules, in order: `@all` or a fresh line from a person that names nobody → everyone; `@name`
    → that member (kind, model, kind（model）); a member named by someone else in a sentence that
    questions or refers to what it said (CHALLENGE_RE) → that member; nobody named and no fresh
    line from a person → everyone (the members skip themselves)."""
    actors = member_actors or set(KIND_ACTOR.values())
    names = [member_names(k, m) for k, m in parts]
    whos = [f"{k}{'（' + m + '）' if m else ''}" for k, m in parts]
    picked, reasons, everyone, why = [], {}, False, []

    def pick(i, reason):
        if i not in picked:
            picked.append(i)
        reasons.setdefault(i, [])
        if reason not in reasons[i]:
            reasons[i].append(reason)

    def by_name(token):
        t = token.lower().replace("(", "（").replace(")", "）").rstrip("）")
        hits = [i for i, ns in enumerate(names) if t in ns or t + "）" in ns]
        if not hits and "（" in t:   # @claude（opus → kind + model
            k, _, m = t.partition("（")
            hits = [i for i, (kind, model) in enumerate(parts) if kind.lower() == k and (model or "").lower() == m]
        return hits

    for c in fresh:
        text = (c.get("text") or "").strip()
        body = text[len(DISCUSS_TAG):].lstrip() if text.startswith(DISCUSS_TAG) else text
        author = (c.get("author") or "").strip()
        person = author not in actors
        opener = body.startswith("发起")
        if opener:   # 【讨论】发起：me 邀请 … ：question — the question is the part after the last colon
            body = body.split("：", 2)[-1] if body.count("：") >= 2 else ""
        # Who is talking: the signature (pi（deepseek）：…) tells two members of one kind apart;
        # a member never picks itself, whether it @'s or questions its own name.
        sig = body.split("：", 1)[0].strip() if not opener else ""
        selves = {i for i, w in enumerate(whos) if w == sig} or ({i for i, (k, m) in enumerate(parts) if KIND_ACTOR.get(k, k) == author} if not person else set())
        speaker = author if person else (whos[next(iter(selves))] if len(selves) == 1 else sig or author)
        named_here = False
        for m in MENTION_RE.finditer(body):
            token = m.group(1)
            if token.lower() in MENTION_ALL:
                everyone = True; why.append(f"{speaker} @{token}"); named_here = True; continue
            for i in by_name(token):
                if i not in selves:
                    pick(i, f"被 {speaker} @"); named_here = True
        for sent in SENTENCE_RE.split(body):
            low = sent.lower()
            if not sent.strip() or not CHALLENGE_RE.search(sent):
                continue
            for i, ns in enumerate(names):
                if i in selves:
                    continue   # talking about yourself is not being challenged
                if any(re.search(r"(?<![\w@-])" + re.escape(n) + r"(?![\w-])", low) for n in ns if n):
                    pick(i, f"被 {speaker} 质疑"); named_here = True
        if person and body.strip() and not named_here:
            everyone = True; why.append(f"{speaker} 对大家说")
    if not fresh or (not picked and not everyone):
        everyone = True
        if fresh:
            why.append("没人被点名")
        else:
            why.append("没有新发言")
    if everyone:
        return {"everyone": True, "picked": list(range(len(parts))), "reasons": {}, "why": "全员：" + "；".join(why)}
    return {"everyone": False, "picked": picked, "reasons": reasons, "why": "、".join(f"{whos[i]}（{'，'.join(reasons[i])}）" for i in picked)}


CONCLUSION_HEADING = "## 讨论结论"


def description_sections(desc):
    """(original idea text, conclusion block or "", document block or "") — the three parts a
    discussion task's description is made of; each block keeps its own heading line."""
    desc = desc or ""
    doc = ""
    if "\n\n## 讨论文档" in desc:
        desc, doc = desc.split("\n\n## 讨论文档", 1)
        doc = "## 讨论文档" + doc
    con = ""
    if "\n\n" + CONCLUSION_HEADING in desc:
        desc, con = desc.split("\n\n" + CONCLUSION_HEADING, 1)
        con = CONCLUSION_HEADING + con
    elif desc.startswith(CONCLUSION_HEADING):
        con, desc = desc, ""
    return desc.rstrip(), con.strip(), doc.strip()


def description_join(original, conclusion, doc):
    return "\n\n".join(x for x in (original.rstrip(), conclusion.strip(), doc.strip()) if x)


def conclusion_of(issue, comments=()):
    """The current conclusion: the single block in the description, else (older threads) the
    last 【结论】 comment. Returns (text, when, by)."""
    _, con, _ = description_sections(issue.get("description") or "")
    if con:
        head, _, body = con.partition("\n")
        m = re.search(r"（(.+?) · (.+?)）", head)
        return body.strip(), (m.group(1) if m else ""), (m.group(2) if m else "")
    last = [c for c in comments if (c.get("text") or "").lstrip().startswith("【结论】")]
    if last:
        c = last[-1]
        return c["text"].lstrip()[4:].strip(), c.get("created_at", ""), c.get("author", "")
    return "", "", ""


LEADER_RE = re.compile(r"^领队[:：]\s*([a-z0-9_-]+)(?::([^\s]+))?\s*$", re.M | re.I)


def discussion_leader(issue, override=""):
    """(kind, model) of the discussion's leader: --leader on the command line, else the
    「领队：kind:model」 line the discussion task's description carries; ("", "") if none."""
    spec = (override or "").strip()
    if not spec:
        m = LEADER_RE.search(issue.get("description") or "")
        spec = (m.group(1) + (":" + m.group(2) if m.group(2) else "")) if m else ""
    if not spec:
        return "", ""
    kind, _, model = spec.partition(":")
    return kind.strip().lower(), model.strip()


def leader_chat(kind, model, system, prompt, cwd, timeout=180):
    """One answer from the leader's own model (a fresh headless session, no tools needed) —
    used for the conclusion and the document, so they carry the leader's judgement, not a
    cheap summariser's. Returns "" when the CLI is missing or fails (caller falls back)."""
    if kind not in HEADLESS_KINDS:
        return ""
    res = headless_call(kind, model, prompt, cwd or HOME, timeout * 1000, system=system)
    return "" if (res.get("error") and not res.get("text")) else (res.get("text") or "").strip()


def discussion_writer(issue, comments=(), leader=None):
    """Who writes the conclusion/document: the leader's model when there is one and its CLI
    answers, else the summary model. Returns (chat(system, user, timeout) -> text, label)."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import summarize
    kind, model = leader if leader is not None else discussion_leader(issue)
    if kind in HEADLESS_KINDS:
        label = f"{kind}:{model or 'default'}（领队）"
        cwd = task_project_dir(issue) if issue.get("id") else HOME

        def chat(system, user, timeout=180):
            text = leader_chat(kind, model, system, user, cwd, timeout)
            if text:
                return text
            p = summarize.provider()
            return summarize.chat(p, system, user, timeout=timeout) if p else ""
        return chat, label
    p = summarize.provider()
    if not p:
        return None, ""
    return (lambda system, user, timeout=180: summarize.chat(p, system, user, timeout=timeout)), f"{p['id']}:{p['model']}"


def discussion_conclude(tid, title, comments, issue=None, leader=None):
    """The summary model reads every 【讨论】 statement and writes one conclusion — where they
    agree, where they differ, what the next step is. It is one block in the task's description
    (## 讨论结论), replaced each time, never a growing pile of stale 【结论】 comments."""
    issue = issue or bd_json(["show", tid, "--json"])
    chat, by = discussion_writer(issue, comments, leader)
    if not chat:
        return ""
    said = [c for c in comments if (c.get("text") or "").startswith(DISCUSS_TAG) and not (c.get("text") or "")[len(DISCUSS_TAG):].lstrip().startswith("发起")]
    body = "\n\n".join(f"{c.get('author')}：{(c.get('text') or '')[len(DISCUSS_TAG):].strip()}" for c in said)
    if not body.strip():
        return ""
    role = "你是这场讨论的领队，下面是大家（含你自己）的发言，按时间排列。" if "领队" in by else "你是讨论的记录员。下面是几个 AI Agent（和发起人）对同一个主题的发言，按时间排列。"
    prompt = (role + "用简体中文写一段不超过 200 字的结论，按顺序：大家一致的判断；分歧在哪、各自理由；还没定的事和建议的下一步（最多三条，每条一句）。"
              + ("作为领队，分歧处给出你的决定和理由；" if "领队" in by else "只归纳发言，不加自己的观点；")
              + "Agent 的共识不等于发起人的决定，发起人明确说了的才算定了。不用标题、不用引号，不用工具，直接输出这段话。")
    try:
        text = chat(prompt, f"主题：{title}\n\n{body}", timeout=120).strip().replace("\n", " ")[:600]
    except Exception:
        return ""
    if not text:
        return ""
    original, _, doc = description_sections(issue.get("description") or "")
    block = f"{CONCLUSION_HEADING}（{time.strftime('%Y-%m-%d %H:%M')} · {by}）\n{text}"
    bd_json(["update", tid, "--description", description_join(original, block, doc), "--json"])
    return text


def cmd_discuss_conclude(a):
    issue = bd_json(["show", a.task, "--json"])
    if not issue.get("id"):
        raise SystemExit(f"没有任务 {a.task}")
    comments = bd_comments(a.task)
    text = discussion_conclude(a.task, issue.get("title", ""), comments, issue)
    if not text:
        raise SystemExit("写不出结论：没有发言，或没有可用的总结模型（设置里选一个）")
    out({"task": a.task, "conclusion": text}, a.json, lambda x: print(x["conclusion"]))


def split_spec(spec):
    """`codex:标题|说明` → (kind, title, description)."""
    if ":" not in spec:
        raise ValueError(f"格式是 kind:标题[|说明]，收到：{spec}")
    kind, rest = spec.split(":", 1)
    title, _, desc = rest.partition("|")
    if not kind.strip() or not title.strip():
        raise ValueError(f"kind 和标题都不能空：{spec}")
    return kind.strip(), title.strip(), desc.strip()


def discussion_of(comments):
    return [c for c in comments if (c.get("text") or "").lstrip().startswith(DISCUSS_TAG)]


DISCUSSION_DOC_PROMPT = ("你是讨论的整理者。下面是一个念头的原文和几个 AI Agent 的发言（以及可能有的发起人插话和一段结论）。把它整理成一份可以直接交给另一个 Agent 开工的 Markdown 文档，用简体中文，结构固定：\n"
                         "# <标题（≤30 字）>\n## 背景\n（这个念头是什么、为什么现在讨论）\n## 结论\n（讨论达成的判断，做/不做/怎么做，一段话）\n## 方案\n（具体怎么做，3–8 条要点）\n## 步骤\n（按顺序的执行步骤，每步一行，标出建议由谁做：Claude Code / Codex / pi）\n## 风险与注意\n（发言里提到的风险和坑，各一句）\n## 验收\n（做完怎么算做完，- [ ] 列表）\n"
                         "只归纳发言，不加发言里没有的内容；没有的段落写「无」。不要代码块包裹整份文档。")


def discussion_doc(tid):
    """Turn the thread into a document the next agent can start from; it becomes the task's
    description (so `bd show` is enough) and a file under ~/tasks/.dispatch/discussions/."""
    issue = bd_json(["show", tid, "--json"])
    if not issue.get("id"):
        raise SystemExit(f"没有任务 {tid}")
    comments = bd_comments(tid)
    chat, by = discussion_writer(issue, comments)
    if not chat:
        raise SystemExit("没有可用的模型：设置里选一个总结模型，或给讨论指定领队")
    said = [c for c in comments if (c.get("text") or "").startswith(DISCUSS_TAG)]
    if not said:
        raise SystemExit("这个讨论还没有发言")
    # 收尾 = 先把结论写成一条（覆盖旧的），再整理成文档。
    conclusion = discussion_conclude(tid, issue.get("title", ""), comments, issue)
    issue = bd_json(["show", tid, "--json"])
    original, con_block, _ = description_sections(issue.get("description") or "")
    if not conclusion:
        conclusion = conclusion_of(issue, comments)[0]
    body = f"念头：{issue.get('title', '').replace('【讨论】', '')}\n{original}\n\n" + "\n\n".join(f"{c.get('author')}：{(c.get('text') or '')[len(DISCUSS_TAG):].strip()}" for c in said) + (f"\n\n结论：{conclusion}" if conclusion else "")
    doc = chat(DISCUSSION_DOC_PROMPT + ("你是这场讨论的领队：分歧处按你的决定写，方案和步骤要能直接开工。不用工具，直接输出文档。" if "领队" in by else ""), body, timeout=240).strip()
    if doc.startswith("```"):
        doc = re.sub(r"^```\w*\n|\n```$", "", doc).strip()
    if not doc:
        raise SystemExit("模型没有返回文档")
    folder = os.path.join(DISPATCH_DIR, "discussions")
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{tid}.md")
    open(path, "w").write(doc + "\n")
    new_desc = description_join(original, con_block, f"## 讨论文档（{time.strftime('%Y-%m-%d %H:%M')} · {by}）\n\n" + doc)
    bd_json(["update", tid, "--description", new_desc, "--json"])
    m = re.search(r"##\s*验收\s*\n((?:\s*- \[[ x]\].*\n?)+)", doc)
    if m and not (issue.get("acceptance_criteria") or "").strip():
        bd_json(["update", tid, "--acceptance", m.group(1).strip(), "--json"])
    kind, model = discussion_leader(issue)
    return {"task": tid, "path": path, "doc": doc, "conclusion": conclusion, "by": by, "leader": {"kind": kind, "model": model} if kind else None}


def cmd_discuss_doc(a):
    r = discussion_doc(a.task)
    out(r, a.json, lambda x: print(x["doc"] + f"\n\n已写进 {x['task']} 的描述（{x['by']}），文件 {x['path']}；派人：dispatch agent start {(x.get('leader') or {}).get('kind') or 'claude'}" + (f" --model {x['leader']['model']}" if (x.get("leader") or {}).get("model") else "") + f" --task {x['task']}"))


def discuss_parts(spec):
    parts = []
    for k in (spec or "").split(","):
        k = k.strip()
        if k:
            kind, _, model = k.partition(":")
            parts.append((kind, model))
    return parts


def cmd_discuss_judge(a):
    parts = discuss_parts(a.with_)
    if not parts:
        raise SystemExit("要指定成员：--with codex,claude:opus,pi")
    state = discussion_state_load(a.task)
    members = state.get("members") or {}
    judged = set(state["judged"]) if isinstance(state.get("judged"), list) else set().union(*[set(m.get("seen") or []) for m in members.values()]) if members else set()
    disc = discussion_of(bd_comments(a.task))
    member_actors = {KIND_ACTOR.get(k, k) for k, _ in parts}
    fresh = [c for c in disc if c.get("id") not in judged]
    if not any(c.get("author") in member_actors for c in disc):
        r = {"everyone": True, "picked": [f"{k}{'（' + m + '）' if m else ''}" for k, m in parts], "why": "全员：成员还没说过话（第一轮）", "fresh": len(fresh)}
    else:
        j = discussion_judge(fresh, parts, member_actors)
        r = {**j, "picked": [f"{parts[i][0]}{'（' + parts[i][1] + '）' if parts[i][1] else ''}" for i in j["picked"]], "fresh": len(fresh)}
    out(r, a.json, lambda x: print(f"下一轮叫：{'、'.join(x['picked'])}\n{x['why']}（上次裁判后有 {x['fresh']} 条新发言）"))


def cmd_discuss(a):
    # Participants: `kind` or `kind:model`, repeated as often as wanted (claude:opus,claude:haiku,codex).
    parts = discuss_parts(a.with_)
    if not parts:
        raise SystemExit("要指定参加讨论的 Agent：--with codex,claude 或 claude:opus,claude:haiku")
    # The leader: one of the members (kind[:model]); it speaks last each round, and the
    # conclusion, the document and the hand-off default to it. Not in --with → added.
    leader_spec = (getattr(a, "leader", "") or "").strip()
    lead_kind, lead_model = "", ""
    if leader_spec:
        lead_kind, _, lead_model = leader_spec.partition(":")
        lead_kind, lead_model = lead_kind.strip().lower(), lead_model.strip()
        if (lead_kind, lead_model) not in parts:
            parts.append((lead_kind, lead_model))
    kinds = [k for k, _ in parts]
    me = os.environ.get("BEADS_ACTOR", "schaefer")
    topic = bool(getattr(a, "topic", ""))
    project = getattr(a, "project", "") or ""
    if topic:
        # A thought, not a task: make a task to hold the discussion (it can be split later).
        labels = [DISCUSSION_LABEL] + ([f"project:{project}"] if project else [])
        images = [os.path.abspath(os.path.expanduser(x)) for x in (getattr(a, "image", None) or []) if x]
        desc = a.topic.strip() + (f"\n\n项目：{project}" if project else "") + (f"\n\n发起人的问题：{a.question}" if a.question else "") + ("\n\n附图（发言前用 Read 工具看一遍）：\n" + "\n".join(images) if images else "") + f"\n\n参加：{', '.join(f'{k}:{m}' if m else k for k, m in parts)}。" + (f"\n领队：{lead_kind}{':' + lead_model if lead_model else ''}\n" if lead_kind else "") + "这是一次讨论，结论在评论里；要做就用 dispatch split 拆成子任务。"
        issue = bd_json(["create", "【讨论】" + a.topic.strip()[:70], "-t", "task", "-p", "3", "-l", ",".join(labels), "--description", desc, "--json"])
        if not issue.get("id"):
            raise SystemExit("建不了讨论任务")
        a.task = issue["id"]
        if getattr(a, "create_only", False):
            # The app creates first so it can watch the comments land, then runs the rounds on the id.
            return out({"task": a.task, "title": issue.get("title", "")}, a.json, lambda x: print(f"{x['task']} 已建：dispatch discuss {x['task']} --with … 开始讨论"))
    else:
        issue = bd_json(["show", a.task, "--json"])
        if not issue.get("id"):
            raise SystemExit(f"没有任务 {a.task}")
        topic = DISCUSSION_LABEL in (issue.get("labels") or [])
        project = project or next((l.split(":", 1)[1] for l in issue.get("labels") or [] if l.startswith("project:")), "")
        if not lead_kind:
            lead_kind, lead_model = discussion_leader(issue)
            if lead_kind and (lead_kind, lead_model) not in parts:
                parts.append((lead_kind, lead_model)); kinds = [k for k, _ in parts]
    leader_i = next((i for i, (k, m) in enumerate(parts) if (k, m) == (lead_kind, lead_model)), -1) if lead_kind else -1
    title = issue.get("title", "")
    cwd = a.cwd or (task_project_dir(issue) if project or not topic else HOME)
    existing = discussion_of(bd_comments(a.task))
    before = len(existing)
    # The opener line once per thread (or whenever there is a question to put): later rounds are
    # just the members answering what was said since, no ceremony in between.
    if a.question or not any((c.get("text") or "")[len(DISCUSS_TAG):].lstrip().startswith("发起") for c in existing):
        sh(["bd", "comments", "add", a.task, f"{DISCUSS_TAG}发起：{me} 邀请 {', '.join(kinds)} 讨论" + (f"：{a.question}" if a.question else "")], env={"BEADS_ACTOR": me})
    hostargs = ["--host", a.host] if a.host else []
    # Headless (claude -p / codex exec / pi -p) on this Mac is the normal path; --tui or a remote
    # host goes through a Herdr tab per member as before.
    tui = bool(getattr(a, "tui", False) or a.host)
    # Each member keeps its session between rounds (~/tasks/.dispatch/discussions/<task>.json):
    # the next round resumes it and feeds only what was said since, so it remembers what it
    # said and the prompt stays small. --fresh starts everyone over with the whole thread.
    state = {} if getattr(a, "fresh", False) else discussion_state_load(a.task)
    state["task"] = a.task
    settings = settings_load() if not tui else {}
    members = state.setdefault("members", {})
    member_actors = {KIND_ACTOR.get(k, k) for k, _ in parts}
    panes, missing, skipped, idle, timing, judges = {}, [], [], [], [], []
    import threading
    t_start = time.time()
    for r in range(1, max(1, a.rounds) + 1):
        now = bd_comments(a.task)
        disc_now = discussion_of(now)
        seen_before = {c.get("id") for c in disc_now}
        thread_text = discussion_thread(issue, now)
        images = discussion_images(issue.get("description"), *[c.get("text") for c in disc_now])
        results = {}
        # The cheap referee (no model call): once the members have spoken, a round only wakes
        # who was @'d or named-and-questioned in what was said since the last round; a fresh
        # line from a person that names nobody, or --everyone, calls the whole group.
        judge = None
        if not tui and not getattr(a, "everyone", False) and any(c.get("author") in member_actors for c in disc_now):
            judged = set(state["judged"]) if isinstance(state.get("judged"), list) else set().union(*[set(m.get("seen") or []) for m in members.values()]) if members else set()
            judge = discussion_judge([c for c in disc_now if c.get("id") not in judged], parts, member_actors)
            judges.append({"round": r, **judge, "picked": [f"{parts[i][0]}{'（' + parts[i][1] + '）' if parts[i][1] else ''}" for i in judge["picked"]]})
            if not a.json:
                print(f"· 第 {r} 轮裁判：{judge['why']}")
        chosen = set(judge["picked"]) if judge else set(range(len(parts)))
        live = None if tui else DiscussionLive(a.task, r, [(f"{kind}{'（' + model + '）' if model else ''}", kind) for i, (kind, model) in enumerate(parts) if i in chosen], judge=judges[-1] if judge else None)

        def run_tui(i, kind, model, who):
            prompt = discuss_prompt(a.task, title, r, a.question, topic=topic, project=project, who=who)
            if i not in panes:
                argv = self_cmd() + ["agent", "start", kind, "--cwd", cwd, "--label", f"讨论 {a.task} · {who}", "-p", prompt, "--auto", "--timeout", str(a.timeout), "--lines", "40", "--json"] + (["--model", model] if model else []) + hostargs
            else:
                argv = self_cmd() + ["agent", "ask", panes[i], prompt, "--timeout", str(a.timeout), "--lines", "40", "--json"] + hostargs
            t0 = time.time()
            code, o, err = sh(argv, timeout=a.timeout // 1000 + 240)
            try:
                res = json.loads(o[o.find("{"):])
            except Exception:
                res = {}
            results[i] = ("tui", who, code, res, (err or o).strip()[:300], round(time.time() - t0, 1))

        def run_headless(i, kind, model, who):
            claude = kind == "claude"   # claude reads pictures itself with Read; codex/pi get them attached
            thinking = DISCUSS_PI_THINKING if kind == "pi" else ""
            key = f"{kind}:{model}#{i}"
            mem = members.get(key) or {}
            system = discussion_system(who, kind, settings) + ("你是这场讨论的领队：每轮最后发言，先看完其他人说的，再归纳分歧、给出你的决定和下一步；闲聊时不用归纳。" if i == leader_i else "")
            on_event = (lambda status, text, step="", who=who: live.update(who, status, text, step)) if live else None
            resumed = bool(mem.get("session")) and mem.get("kind") == kind and (mem.get("model") or "") == (model or "")
            res = None
            if resumed:
                seen = set(mem.get("seen") or [])
                fresh_cs = [c for c in disc_now if c.get("id") not in seen]
                imgs = discussion_images(*[c.get("text") for c in fresh_cs])
                prompt = headless_followup_prompt(a.task, r, discussion_lines(fresh_cs), who, a.question, images=imgs if claude else ())
                res = headless_call(kind, model, prompt, cwd, a.timeout, images=() if claude else imgs, system=system, session=mem["session"], resume=True, on_event=on_event, thinking=thinking)
                if res["error"] and not res["text"]:
                    resumed = False   # the session is gone (or the CLI could not resume it): start over with the whole thread
            if not resumed:
                prompt = headless_prompt(a.task, title, r, thread_text, who, a.question, topic=topic, project=project, images=images if claude else ())
                res = headless_call(kind, model, prompt, cwd, a.timeout, images=() if claude else images, system=system, on_event=on_event, thinking=thinking)
            res["resumed"] = resumed
            # The statement lands on the board the moment it is ready, so the app shows the
            # quick members while the slow one is still thinking.
            own = ""
            if res["text"] and not is_skip(res["text"]):
                text = clean_statement(res["text"], who)
                code, o, err = sh(["bd", "comments", "add", a.task, f"{DISCUSS_TAG}{who}：{text}", "--json"], env={"BEADS_ACTOR": KIND_ACTOR.get(kind, kind)}, timeout=60)
                res["written"] = code == 0
                res["write_error"] = "" if code == 0 else (err or o).strip()[:120]
                res["chars"] = len(text)
                try:
                    own = json.loads(o[o.find("{"):]).get("id") or ""
                except Exception:
                    own = ""
                if live:
                    live.update(who, "posted" if code == 0 else "error", text if code == 0 else res["write_error"])
            if res.get("session"):
                members[key] = {"kind": kind, "model": model, "who": who, "session": res["session"], "rounds": (mem.get("rounds") or 0) + 1, "last_at": int(time.time()),
                                "seen": sorted(set(mem.get("seen") or []) | {c.get("id") for c in disc_now} | ({own} if own else set()))}
            results[i] = ("headless", who, res)

        # Everyone speaks at the same time — except the leader, who goes after the others so
        # it can read them (its prompt/session picks up their statements from the board).
        threads = []
        for i, (kind, model) in enumerate(parts):
            who = f"{kind}{'（' + model + '）' if model else ''}"
            if i not in chosen:
                results[i] = ("idle", who); continue
            use_tui = tui or kind not in HEADLESS_KINDS
            threads.append((i, use_tui, threading.Thread(target=run_tui if use_tui else run_headless, args=(i, kind, model, who), daemon=True)))
        for i, use_tui, t in threads:
            if i == leader_i:
                continue
            t.start()
            if use_tui:
                time.sleep(1.5)  # stagger tab creation a little; Herdr serialises it anyway
        for i, _, t in threads:
            if i != leader_i:
                t.join()
        if leader_i in chosen:
            now = bd_comments(a.task)
            disc_now = discussion_of(now)
            thread_text = discussion_thread(issue, now)
            images = discussion_images(issue.get("description"), *[c.get("text") for c in disc_now])
            t = next(t for i, _, t in threads if i == leader_i)
            t.start(); t.join()
        if not tui:
            state["judged"] = sorted(x for x in seen_before if x)   # next round's referee looks at what was said from here on
            discussion_state_save(a.task, state)
        if live:
            live.finish()
        after = [c for c in discussion_of(bd_comments(a.task)) if c.get("id") not in seen_before]
        for i, (kind, model) in enumerate(parts):
            row = results.get(i)
            actor = KIND_ACTOR.get(kind, kind)
            if not row:
                missing.append({"who": kind, "round": r, "reason": "没有结果"}); continue
            if row[0] == "idle":
                idle.append({"who": row[1], "round": r})
                if not a.json:
                    print(f"· 第 {r} 轮 {row[1]} 没被点名，不叫")
                continue
            if row[0] == "headless":
                _, who, res = row
                timing.append({"who": who, "round": r, "secs": res["secs"], "resumed": res.get("resumed", False), "prompt_chars": res.get("prompt_chars", 0), "usage": res.get("usage") or {}})
                if res["error"] and not res["text"]:
                    print(f"⚠ {who} 第 {r} 轮没说上话：{res['error']}", file=sys.stderr)
                    missing.append({"who": who, "round": r, "reason": res["error"][:160]}); continue
                if is_skip(res["text"]):
                    skipped.append({"who": who, "round": r})
                    if not a.json:
                        print(f"· 第 {r} 轮 {who} 这轮不说（{res['secs']}s）")
                    continue
                if not res.get("written"):
                    missing.append({"who": who, "round": r, "reason": "发言写不进板：" + res.get("write_error", "")}); continue
                if not a.json:
                    u = res.get("usage") or {}
                    print(f"· 第 {r} 轮 {who} 说了 {res.get('chars', 0)} 字（{res['secs']}s{'，续接会话' if res.get('resumed') else ''}，提示 {res.get('prompt_chars', 0)} 字" + (f"，输入 {u.get('input', 0)}+缓存 {u.get('cached', 0)} token" if u else "") + "）")
                continue
            _, who, code, res, errtxt, secs = row
            timing.append({"who": who, "round": r, "secs": secs})
            if code != 0 or not res:
                print(f"⚠ {who} 第 {r} 轮没跑起来：{errtxt}", file=sys.stderr)
                missing.append({"who": who, "round": r, "reason": errtxt[:160] or "没跑起来"})
                continue
            panes.setdefault(i, res.get("pane_id"))
            if not any(c.get("author") == actor for c in after):
                missing.append({"who": who, "round": r, "reason": "跑完了但没留下发言（可能被权限或登录对话框卡住，或它决定不说）"})
            if not a.json:
                print(f"· 第 {r} 轮 {who}（Herdr {res.get('pane_id')}）{res.get('status')}（{secs}s）" + (f" · {res.get('warning')}" if res.get("warning") else ""))
    comments = discussion_of(bd_comments(a.task))
    new = comments[before:]
    # A quiet round: nobody had anything new (all skipped, or only one-line acknowledgements).
    # Two in a row and the app suggests wrapping up; the conclusion itself is written on demand
    # (--conclude here, discuss-conclude, or 整理成文档), one block, replaced each time.
    spoke = [c for c in new if not (c.get("text") or "")[len(DISCUSS_TAG):].lstrip().startswith("发起")]
    quiet = not tui and (not spoke or all(len((c.get("text") or "")) < len(DISCUSS_TAG) + 60 for c in spoke))
    state["quiet_rounds"] = (state.get("quiet_rounds") or 0) + 1 if quiet else 0
    if not tui:
        discussion_state_save(a.task, state)
    conclusion = discussion_conclude(a.task, title, comments, issue, leader=(lead_kind, lead_model)) if getattr(a, "conclude", False) and spoke else ""
    if a.close:
        for pane in panes.values():
            if pane:
                sh(self_cmd() + ["agent", "close", pane] + hostargs, timeout=60)
    if missing:
        for m in missing:
            sh(["bd", "comments", "add", a.task, f"【系统】{m['who']} 第 {m['round']} 轮没有发言：{m['reason']}"], env={"BEADS_ACTOR": "dispatch"})
    elapsed = round(time.time() - t_start, 1)
    result = {"task": a.task, "participants": [f"{k}{':' + m if m else ''}" for k, m in parts], "missing": missing, "skipped": skipped, "idle": idle, "judge": judges, "rounds": a.rounds, "mode": "tui" if tui else "headless",
              "panes": {f"{parts[i][0]}{':' + parts[i][1] if parts[i][1] else ''}#{i}": p for i, p in panes.items()}, "comments": new, "conclusion": conclusion, "topic": topic, "elapsed": elapsed, "timing": timing, "quiet_rounds": state.get("quiet_rounds", 0), "leader": {"kind": lead_kind, "model": lead_model} if lead_kind else None}
    try:
        import notify
        spoken = "；".join(re.sub(r"\s+", " ", (c.get("text") or "")[len(DISCUSS_TAG):]).strip() for c in spoke)
        notify.send(f"讨论结束：{title}", (re.sub(r"\s+", " ", conclusion or "").strip() or spoken or "本轮没有新发言")[:100])
    except Exception:
        pass
    if a.json:
        print(json.dumps(result, ensure_ascii=False)); return
    print(f"\n讨论结束：{len(new)} 条新发言（含发起），{elapsed}s。" + (f"\n结论：{conclusion}" if conclusion else "") + ("\n连续两轮没有新提议了，可以收尾：dispatch discuss-doc " + a.task if state.get("quiet_rounds", 0) >= 2 else ""))
    for c in new:
        print(f"— {c.get('author')}：{re.sub(r'\\s+', ' ', (c.get('text') or '')[len(DISCUSS_TAG):]).strip()[:400]}")
    if panes and not a.close:
        print("\n讨论用的 Agent 还开着：" + "、".join(f"{k}={p}" for k, p in result["panes"].items()) + "（`dispatch agent close <pane>` 关掉）")
    print(f"\n下一步由你拍板拆分：dispatch split {a.task} --to codex:\"子任务标题|说明\" --to claude:\"…\"")


def cmd_split(a):
    parent = bd_json(["show", a.task, "--json"])
    if not parent.get("id"):
        raise SystemExit(f"没有任务 {a.task}")
    try:
        specs = [split_spec(s) for s in (a.to or [])]
    except ValueError as e:
        raise SystemExit(str(e))
    if not specs:
        raise SystemExit("要给至少一个 --to kind:\"标题|说明\"")
    me = os.environ.get("BEADS_ACTOR", "schaefer")
    proj = next((l.split(":", 1)[1] for l in parent.get("labels") or [] if l.startswith("project:")), "")
    cwd = a.cwd or task_project_dir(parent)
    hostargs = ["--host", a.host] if a.host else []
    made = []
    for kind, title, desc in specs:
        argv = ["create", title, "-t", "task", "-p", str(parent.get("priority", 2)), "--deps", f"parent-child:{a.task}", "--json"]
        labels = [f"discussed-in:{a.task}"] + ([f"project:{proj}"] if proj else [])
        argv += ["-l", ",".join(labels)]
        argv += ["--description", (desc + "\n\n" if desc else "") + f"父任务 {a.task}「{parent.get('title', '')}」的分工，由 {me} 按讨论拆出。\n\ndiscussed-in: {a.task}（`bd comments {a.task}` 看谁说过什么，`bd show {a.task}` 看结论和文档）"]
        sub = bd_json(argv)
        sid = sub.get("id")
        if not sid:
            print(f"⚠ 建不出子任务：{title}", file=sys.stderr)
            continue
        row = {"id": sid, "title": title, "kind": kind, "started": False}
        if not a.no_start:
            prompt = f"你接手子任务 {sid}「{title}」（父任务 {a.task}）。先 `bd show {sid}` 和 `bd comments {a.task}` 读讨论结论，按验收项做完，进展 dispatch log，收尾 dispatch done --reason。"
            code, o, err = sh(self_cmd() + ["agent", "start", kind, "--cwd", cwd, "--task", sid, "--label", title[:24], "-p", prompt, "--no-wait", "--json"] + hostargs, timeout=240)
            row["started"] = code == 0
            try:
                row["pane_id"] = json.loads(o[o.find("{"):]).get("pane_id")
            except Exception:
                pass
            if code != 0:
                print(f"⚠ {kind} 没起来（{sid} 已建好，可以稍后派）：{(err or o).strip()[:200]}", file=sys.stderr)
        made.append(row)
    note = SPLIT_TAG + "；".join(f"{r['id']} {r['title']} → {r['kind']}" + ("" if r["started"] else "（未起）") for r in made)
    sh(["bd", "comments", "add", a.task, note], env={"BEADS_ACTOR": me})
    if a.json:
        print(json.dumps({"task": a.task, "subtasks": made}, ensure_ascii=False)); return
    for r in made:
        print(f"{r['id']}  {r['title']}  → {r['kind']}" + (f" · Herdr {r.get('pane_id')}" if r.get("pane_id") else "") + ("" if r["started"] else "  （未派出）"))
    print(f"父任务 {a.task} 已留{SPLIT_TAG}记录；子任务做完各自 dispatch done，父任务最后由你收尾。")



def starred_sessions(prefs, idx, proj, names, limit=5):
    """Conversations the user marked 追踪中 in this project: the long threads an agent
    should know exist before it starts a new one."""
    rows = []
    for path, e in idx.items():
        pref = prefs.get(f"{e.get('agent')}:{e.get('session_id')}") or {}
        if not pref.get("starred") or pref.get("archived"):
            continue
        p = pref.get("project_override") or project_of_cwd(e.get("cwd", ""), names) or os.path.basename((e.get("cwd") or "").rstrip("/"))
        if proj and p.lower() != proj.lower():
            continue
        rows.append({"agent": e.get("agent", ""), "session_id": e.get("session_id", ""), "title": (e.get("title") or "")[:70], "last_at": e.get("mtime", 0)})
    rows.sort(key=lambda r: -(r["last_at"] or 0))
    return rows[:limit]


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
            by = next((l.split(":", 1)[1] for l in t.get("labels") or [] if l.startswith("delegated-by:")), "")
            lines.append(f"{mark} {t['id']}{who} {t.get('title', '')}" + (f" ← {by} 派的" if by else ""))
        if len(mine) > len(shown):
            lines.append(f"…还有 {len(mine) - len(shown)} 条：`bd ready`")
        # the user's unanswered note on a task this agent holds
        for t in shown:
            if t.get("status") == "in_progress" and actor and t.get("assignee") == actor:
                note = human_note(bd_comments(t["id"]), actor)
                if note:
                    lines.append(f"💬 {t['id']} 用户留言（未回复）：{note}")
    # conversations the user is tracking in this project
    try:
        from activity import session_preferences
        tracked = starred_sessions(session_preferences(DISPATCH_DIR), load_index(), proj, names)
    except Exception as e:
        tracked = []
        print(f"追踪中的会话读取失败：{e}", file=sys.stderr)
    if tracked:
        lines.append(f"## 追踪中的会话（{len(tracked)}）")
        for r in tracked:
            when = ago(r["last_at"])
            lines.append(f"★ {r['agent']} {r['session_id'][:8]} · {r['title']} · {when if when.startswith('刚') else when + '前'} · 看摘要 `dispatch session {r['session_id'][:8]}`")
        lines.append("这些是用户长期跟的线；相关的活先看它们的记录，别另起炉灶。")
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
    # 常用信息：服务器/域名/数据库/API 名字、用户常重复说的话——通用节 + 本项目节
    fx = facts_for(proj)
    if fx:
        lines.append("## 常用信息（跨项目事实只存这里，不写进各自的记忆；改：Dispatch → 规则与资料 → 常用资料）")
        for h, b in fx:
            if facts_key(h) in FACTS_GENERAL:
                topics = [t for t, _ in facts_topics(b) if t]
                sayings = next((blk for t, blk in facts_topics(b) if "常说" in t), "")
                lines.append("通用主题：" + " · ".join(topics) + "。要哪个 `dispatch facts get <主题词>`，全文 `dispatch facts search <词>`。")
                if sayings:
                    lines.append(sayings)
            else:
                lines.append(f"### {h}")
                lines.append(b)
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
            lines.append(f"{mark} {s_['agent']} {s_['session_id'][:8]} · {'在跑' if s_.get('state') == 'working' else '等用户'} · {(lambda t: t + '活动' if t.startswith('刚刚') else t + '前活动')(ago(s_.get('last_at') or 0))} · 目录 …{(s_.get('cwd') or '')[-28:]}" + (f" · {s_['host_name']}" if s_.get("host") not in (None, "local") else ""))
        # What the neighbours actually have open, from hooks + transcripts: the thing that
        # stops two agents from writing the same file. Conflicts are called out separately.
        edits = session_edit_map()
        per_file = {}
        for s_ in nb:
            rec = edits.get(s_["session_id"]) or {}
            for f, ts in (rec.get("files") or {}).items():
                per_file.setdefault(f, []).append((s_["session_id"], s_["agent"], ts))
        if per_file:
            ordered = sorted(per_file.items(), key=lambda kv: (len({sid for sid, _, _ in kv[1]}) < 2, -max(t for _, _, t in kv[1])))
            parts = [f"{'⚠' if len({sid for sid, _, _ in eds}) > 1 else ''}{os.path.basename(f)}（{'、'.join(sorted({a for _, a, _ in eds}))}）" for f, eds in ordered[:8]]
            lines.append(f"同目录 {len(nb)} 个会话最近改了这些文件：{'、'.join(parts)}{'…' if len(ordered) > 8 else ''}。动手前别碰它们正在改的文件，冲突先 `dispatch session <id>` 看它在做什么。")
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
    s = sub.add_parser('task', help='recoverable task removal'); s.add_argument('op', choices=['trash', 'restore']); s.add_argument('task'); s.add_argument('--json', action='store_true'); s.set_defaults(fn=cmd_task)
    s = sub.add_parser("sessions", help="live Agent sessions"); s.add_argument("--local", action="store_true", help="this Mac only (what other Macs ask for)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_sessions)
    s = sub.add_parser("attachment", help="read a file linked in a conversation; --thumbs returns every image as a small thumbnail in one call"); s.add_argument("key"); s.add_argument("ref", nargs="?", default=""); s.add_argument("--thumbs", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_attachment)
    s = sub.add_parser("activity", help="incremental conversation activity and unread replies"); s.add_argument("--local", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_activity)
    s = sub.add_parser("editing", help="files each active session changed in the last 30 min, aggregated per file, with conflicts"); s.add_argument("--dir", help="only sessions working in this directory (default: every directory)"); s.add_argument("--window", type=int, default=30, help="minutes back to look (default 30)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_editing)
    s = sub.add_parser("settings", help="shared settings (bd memory dispatch-settings): session_archive_days / task_archive_days"); s.add_argument("key", nargs="?"); s.add_argument("value", nargs="?"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_settings)
    s = sub.add_parser("task-archive", help="archive closed tasks older than task_archive_days (default: the setting)"); s.add_argument("--days", type=int); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_task_archive)
    s = sub.add_parser("project", help="star / archive a project (shared across machines)"); s.add_argument("name"); s.add_argument("--star", action="store_true"); s.add_argument("--unstar", action="store_true"); s.add_argument("--archive", action="store_true"); s.add_argument("--unarchive", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_project)
    s = sub.add_parser("projects", help="list starred / archived projects"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_projects)
    s = sub.add_parser("session-preferences", help="classify a conversation without changing its transcript"); s.add_argument("key"); s.add_argument("changes"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_session_preferences)
    s = sub.add_parser("seen", help="acknowledge exactly one observed reply; reply=unread drops the receipt"); s.add_argument("key"); s.add_argument("reply", help="reply id, or `unread` to mark the session unread again"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_seen)
    s = sub.add_parser("session-control", help="open exact sessions and create conversations"); s.add_argument("op", choices=["open", "browse", "start", "status", "adopt"]); s.set_defaults(fn=cmd_session_control)
    s = sub.add_parser("adopt", help="take a session running in another terminal (Warp/iTerm/Terminal/VS Code) into Herdr: stop it when idle, resume it in a new Herdr tab"); s.add_argument("key", help="session id, prefix, or pid-<n>"); s.add_argument("--keep", action="store_true", help="leave the old process running (the two will interleave writes)"); s.add_argument("--force", action="store_true", help="adopt even while it is working"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_adopt)
    s = sub.add_parser("reply", help="reply to an exact Agent session; `commands` lists the slash commands it accepts"); s.add_argument("op", choices=["status", "send", "commands", "answer", "control"]); s.add_argument("key"); s.add_argument("--agent", required=True); s.add_argument("--request"); s.add_argument("--mode", choices=["queue", "interrupt"], default="queue", help="while the agent works: queue for its next turn, or Esc first (steer it now)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_reply)
    s = sub.add_parser("save-image", help="store a pasted image (base64 JSON on stdin: {name, data}) and print its path"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_save_image)
    s = sub.add_parser("commits", help="git commits that belong to a task (id in the message, or hashes in its close reason / comments)"); s.add_argument("task"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_commits)
    s = sub.add_parser("find", help="sessions that mention a task"); s.add_argument("task"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_find)
    s = sub.add_parser("index", help="refresh the transcript index"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_index)
    s = sub.add_parser("folders", help="directories agents have worked in"); s.add_argument("--query", "-q"); s.add_argument("--cached", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_folders)
    s = sub.add_parser("list", help="browse all sessions"); s.add_argument("--local", action="store_true", help="this Mac only, skip other hosts"); s.add_argument("--agent", help="claude-code | codex | pi | zcode"); s.add_argument("--project"); s.add_argument("--cwd", help="only sessions in this directory"); s.add_argument("--query", "-q"); s.add_argument("--limit", type=int, default=200); s.add_argument("--cached", action="store_true", help="use the cached index without rescanning"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_list)
    s = sub.add_parser("session", help="timeline + file changes of one session"); s.add_argument("key", help="session id (prefix ok) or task id"); s.add_argument("--since", type=int, help="只读上次返回的 offset 之后新增的记录（实时 tail）"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_session)
    s = sub.add_parser("resume", help="print the resume command"); s.add_argument("key", help="session id (prefix ok) or task id"); s.add_argument("--copy", action="store_true"); s.set_defaults(fn=cmd_resume)
    s = sub.add_parser("focus", help="jump to the Herdr tab of a session"); s.add_argument("key"); s.set_defaults(fn=cmd_focus)
    s = sub.add_parser("skills", help="skill pool + per-agent mounts"); s.add_argument("op", choices=["list", "show", "path", "open", "enable", "disable", "improve", "write", "trash", "new", "import"]); s.add_argument("name", nargs="?", help="技能名；import 时是仓库地址（owner/repo 或 GitHub URL）"); s.add_argument("--file", help="技能目录里的某个文件（默认 SKILL.md）"); s.add_argument("--reveal", action="store_true", help="open: 在访达里显示"); s.add_argument("--agent", action="append", choices=["claude", "codex", "all"], help="可重复；不传 = enable/disable 两个都动、new/import 不挂载"); s.add_argument("--query", "-q"); s.add_argument("--days", type=int, default=14, help="improve: 回看最近 N 天"); s.add_argument("--copy", action="store_true", help="improve: 启动命令复制到剪贴板"); s.add_argument("--description", help="new/import: 一句话触发描述（写进 frontmatter）"); s.add_argument("--trigger", help="new: 触发条件"); s.add_argument("--constraint", help="new: 关键约束"); s.add_argument("--path", help="import: 仓库里的子目录"); s.add_argument("--as", dest="as_name", help="import: 落进技能池的名字"); s.add_argument("--force", action="store_true", help="import: 覆盖同名技能（旧的改名 .bak-时间戳）"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_skills)
    s = sub.add_parser("begin", help="create + claim a task (do this once you know what you're doing); the title must say what + why, the description the trigger"); s.add_argument("title", help="「<对象> <怎么改>：<为什么>」，8–80 字"); s.add_argument("--project", "-P"); s.add_argument("--desc", "-d", help="触发原因 + 期望结果，≥20 字"); s.add_argument("--force", action="store_true", help="create even when the title/description checks fail"); s.add_argument("--acceptance", "-a", help="one '- [ ] …' per line"); s.add_argument("--type", "-t", default="task"); s.add_argument("--priority", "-p", type=int, default=2); s.add_argument("--deps"); s.add_argument("--json", action="store_true"); s.add_argument("--session", help="explicit conversation id; otherwise use Agent session environment"); s.set_defaults(fn=cmd_begin)
    s = sub.add_parser("claim", help="claim a task; refuses one another agent is working on unless --force"); s.add_argument("task"); s.add_argument("--force", action="store_true"); s.set_defaults(fn=cmd_claim)
    s = sub.add_parser("log", help="progress note on a task (the process log)"); s.add_argument("task"); s.add_argument("text", nargs="?", default=""); s.add_argument("--tick", nargs="*", help="acceptance items (substring) to mark done"); s.set_defaults(fn=cmd_log)
    s = sub.add_parser("done", help="close a task; --next creates follow-ups; --retro writes the retrospective to the wiki"); s.add_argument("task"); s.add_argument("--reason", "-r", required=True); s.add_argument("--verified", action="store_true", help="you actually checked it works; this is not independent peer review"); s.add_argument("--retro", help="复盘：做了什么【技术】用了什么【做对】哪里对了【做错】哪里错了 → wiki retro-<task>"); s.add_argument("--next", nargs="*", help="follow-up task titles"); s.add_argument("--json", action="store_true"); s.add_argument("--review-by", help="request peer review from this Agent, without launching it"); s.set_defaults(fn=cmd_done)
    s = sub.add_parser("review", help="record independent Agent review and its evidence"); s.add_argument("task"); s.add_argument("--verdict", choices=["pass", "changes"], required=True); s.add_argument("--reason", required=True); s.set_defaults(fn=cmd_review)
    s = sub.add_parser("graph", help="task lineage: nodes + typed edges"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_graph)
    s = sub.add_parser("stats", help="tokens, activity heatmap, tools/skills across all agents"); s.add_argument("--agent", help="claude-code | codex | pi | zcode"); s.add_argument("--days", type=int, default=0, help="only the last N days (0 = all)"); s.add_argument("--local", action="store_true", help="this Mac only (other Macs are merged in by default)"); s.add_argument("--cached", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_stats)
    s = sub.add_parser("discuss-live", help="what each discussion member is doing right now (the typing bubbles): discussions/<task>.live.json"); s.add_argument("task"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_discuss_live)
    s = sub.add_parser("discuss-conclude", help="write (replace) the discussion's conclusion — one block in the task's description"); s.add_argument("task"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_discuss_conclude)
    s = sub.add_parser("discuss-doc", help="turn a discussion into a document (背景/结论/方案/步骤/风险/验收) written into the task, ready for an agent to start from"); s.add_argument("task"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_discuss_doc)
    s = sub.add_parser("discuss", help="several agents each leave one 【讨论】 comment on a task, or on a topic/idea (--topic, optionally under a project); a 【结论】 is written by the summary model"); s.add_argument("task", nargs="?", default="", help="task id; omit with --topic"); s.add_argument("--topic", default="", help="discuss an idea instead of a task: creates a 【讨论】 task to hold it"); s.add_argument("--project", "-P", default="", help="with --topic: the project the idea belongs to (context for the agents)"); s.add_argument("--conclude", action="store_true", help="after the rounds, write (replace) the model's conclusion in the task's description"); s.add_argument("--no-conclude", action="store_true", help=argparse.SUPPRESS); s.add_argument("--create-only", action="store_true", help="with --topic: create the 【讨论】 task and stop"); s.add_argument("--image", action="append", help="with --topic: a picture the agents should look at (path; repeatable)"); s.add_argument("--with", dest="with_", required=True, help="participants: kind or kind:model, repeatable — claude:opus,claude:haiku,codex"); s.add_argument("--leader", default="", help="the leader, kind[:model] (added to the members if missing): speaks last each round, writes the conclusion and the document, gets the hand-off by default"); s.add_argument("--rounds", type=int, default=1); s.add_argument("--question", "-q", default="", help="what you want them to decide"); s.add_argument("--cwd"); s.add_argument("--host"); s.add_argument("--timeout", type=int, default=600000); s.add_argument("--close", action="store_true", help="close the discussion agents afterwards (Herdr path)"); s.add_argument("--tui", action="store_true", help="run each member in a Herdr tab (the old way) instead of headless claude -p / codex exec / pi -p"); s.add_argument("--fresh", action="store_true", help="forget the members' saved sessions: everyone reads the whole thread again"); s.add_argument("--everyone", action="store_true", help="skip the referee: every member speaks this round (by default, once the members have spoken, a round only wakes who was @'d or named-and-questioned since the last round)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_discuss)
    s = sub.add_parser("discuss-judge", help="dry run of the discussion referee: who the next round would wake, and why"); s.add_argument("task"); s.add_argument("--with", dest="with_", required=True, help="the members, as for discuss"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_discuss_judge)
    s = sub.add_parser("split", help="dynamic workflow step 2: create sub-tasks from the discussion and hand each to an agent"); s.add_argument("task"); s.add_argument("--to", action="append", help='kind:"标题|说明"，可多次'); s.add_argument("--cwd"); s.add_argument("--host"); s.add_argument("--no-start", action="store_true", help="only create the sub-tasks"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_split)
    s = sub.add_parser("agent", help="hand work to another agent through Herdr: list | start <kind> | ask <target> <text> | read | wait | keys <target> <key…> | close")
    s.add_argument("op", choices=["list", "start", "ask", "read", "wait", "keys", "close"])
    s.add_argument("target_or_kind", nargs="?", help="start: kind (claude|codex|opencode|gemini…); others: pane id / name / title / task id")
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
    s.add_argument("--auto", action="store_true", help="start: unattended mode (Codex bypasses sandbox approvals, Claude skips permissions); implied by --task")
    s.set_defaults(fn=cmd_agent)
    s = sub.add_parser("serve", help="serve the web/phone version of Dispatch over HTTP (Tailscale); `serve url` prints the link, `serve qr` prints a scannable QR"); s.add_argument("what", nargs="?", choices=["run", "url", "qr"], default="run"); s.add_argument("--svg", action="store_true", help="qr: print SVG instead of terminal blocks"); s.set_defaults(fn=cmd_serve)
    s = sub.add_parser("hosts", help="this Mac and the others: overlay network, remote-desktop backends detected, recommendation"); s.add_argument("--local", action="store_true", help="only this Mac (used over ssh by other hosts)"); s.add_argument("--refresh", help="clear the cached probe for this host id first, forcing a fresh ssh check"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_hosts)
    s = sub.add_parser("screen", help="手机看屏幕的一键配置（noVNC + websockify 常驻 + Tailscale Serve HTTPS）"); s.add_argument("op", nargs="?", choices=["status", "setup"], default="status"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_screen)
    s = sub.add_parser("quota", help="usage limits per agent (5h / weekly), every Mac"); s.add_argument("--local", action="store_true", help="this Mac only"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_quota)
    s = sub.add_parser("rules", help="machine-wide rules for every agent"); s.add_argument("op", choices=["show", "path", "open", "status", "sync", "write", "inspect", "optimize", "check", "apply", "restore"]); s.add_argument("--force", action="store_true"); s.add_argument("--json", action="store_true"); s.add_argument("--path", default=""); s.add_argument("--profile", choices=["auto", "codex", "claude", "general"], default="auto"); s.add_argument("--model", default=""); s.add_argument("--backup", default=""); s.add_argument("--project", default=""); s.set_defaults(fn=cmd_rules)
    s = sub.add_parser("pit", help="pitfall log (= wiki --kind pit)"); s.add_argument("op", choices=["add", "list", "show"]); s.add_argument("text", nargs="?"); s.add_argument("--fix"); s.add_argument("--project", "-P"); s.add_argument("--task"); s.add_argument("--key"); s.add_argument("--all", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_pit)
    s = sub.add_parser("facts", help="常用信息（FACTS.md）：服务器/域名/数据库/API 名字、常说的话；prime 按项目注入"); s.add_argument("op", choices=["show", "path", "open", "write", "sections", "docs", "vaults", "topics", "get", "search", "import"]); s.add_argument("query", nargs="?", default=""); s.add_argument("--apply", action="store_true", help="import: 追加进 FACTS.md"); s.add_argument("--out", default="", help="import: 清单路径"); s.add_argument("--project", "-P", default=""); s.add_argument("--path", default="", help="docs 列表里的某一份（默认全局 FACTS.md）"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_facts)
    s = sub.add_parser("wiki", help="knowledge base: pits / wins / retros / howtos"); s.add_argument("op", choices=["add", "list", "search", "show", "related"]); s.add_argument("text", nargs="?", help="related: 任务 ID；search: 一句话"); s.add_argument("--kind", "-k", choices=list(WIKI_KINDS) + ["all"]); s.add_argument("--semantic", action="store_true", help="search: 按意思找（智谱 embedding-3 + sqlite-vec），不按关键字"); s.add_argument("--limit", type=int, default=8, help="search/related: 最多几条"); s.add_argument("--fix", help="pit: 解法"); s.add_argument("--why", help="win: 为什么对"); s.add_argument("--tech", help="retro: 技术"); s.add_argument("--good", help="retro: 做对"); s.add_argument("--bad", help="retro: 做错"); s.add_argument("--project", "-P"); s.add_argument("--task"); s.add_argument("--key"); s.add_argument("--all", action="store_true", help="include plain memories"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_wiki)
    s = sub.add_parser("insights", help="cross-agent review: signal counts (default) or the model-written report (report/list/show/open/schedule/due)"); s.add_argument("op", nargs="?", choices=["report", "list", "show", "open", "schedule", "due"], help="omit for the signal counts"); s.add_argument("id", nargs="?", default="", help="report id for show/open (default latest)"); s.add_argument("--days", type=int, default=14); s.add_argument("--model", default=None); s.add_argument("--wait", action="store_true", help="report: generate in the foreground"); s.add_argument("--force", action="store_true"); s.add_argument("--every", type=int, default=None, help="schedule: 0 (off) / 7 / 14 / 30 days"); s.add_argument("--copy", action="store_true", help="copy the improvement-task command"); s.add_argument("--alerts", action="store_true", help="only the per-session alerts not yet acknowledged (proactive insights)"); s.add_argument("--ack", action="store_true", help="mark the current alerts as seen"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_insights)
    s = sub.add_parser("catalog", help="capabilities kept off by default: unmounted skills, disabled plugins"); s.add_argument("--query", "-q"); s.add_argument("--kind", choices=["skill", "plugin"]); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_catalog)
    s = sub.add_parser("notify", help="push a message to the phone (ntfy / Bark) or a macOS banner; channels come from dispatch env NTFY_URL / BARK_KEY"); s.add_argument("title"); s.add_argument("body", nargs="?", default=""); s.add_argument("--url", default="", help="link to open when the notification is tapped"); s.add_argument("--level", choices=["normal", "high"], default="normal"); s.add_argument("--key", default="", help="dedup key: the same key inside 5 minutes is sent once"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_notify)
    s = sub.add_parser("docs", help="项目页「文档」：扫描 design/ docs/ 研究/ 下的 .md/.html，加上登记过的路径/URL"); s.add_argument("op", nargs="?", default="", help="add | rm | read（省略时第一个参数就是项目名，列出它的文档）"); s.add_argument("project", nargs="?"); s.add_argument("extra", nargs="*", help="add/read/rm：路径或 URL、文档 id"); s.add_argument("--title", help="add：显示标题（默认取首个 # 行或文件名）"); s.add_argument("--kind", choices=list(DOC_KINDS), help="add：类型"); s.add_argument("--asset", default="", help="read：读文档同目录下的相对文件（图片），返回 base64"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_docs)
    s = sub.add_parser("project-summary", help="让模型把一个项目总结成一段：是什么、到哪了、最近做了什么、还差什么"); s.add_argument("name"); s.add_argument("--force", action="store_true", help="已有也重写"); s.add_argument("--if-stale", action="store_true", help="只在没有或超过一天时重写"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_project_summary)
    s = sub.add_parser("session-summary", help="让模型给一段会话写一段总结（Claude 订阅或 dispatch env 里的 Key）"); s.add_argument("op", nargs="?", default="run", choices=["run", "provider", "providers", "auto"]); s.add_argument("key", nargs="?", help="会话 key，如 claude-code:<session_id>"); s.add_argument("--force", action="store_true", help="已有总结也重新生成"); s.add_argument("--limit", type=int, default=2, help="auto: 本次最多总结几段"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_session_summary)
    s = sub.add_parser("move", help="把一段会话连同项目目录搬到另一台 Mac 接着做"); s.add_argument("session", help="会话 id（前缀即可）"); s.add_argument("--to", required=True, help="hosts.json 里的机器 id 或名字"); s.add_argument("--prompt", help="交接时额外交代的话"); s.add_argument("--no-files", action="store_true", help="不同步项目目录（对方已有）"); s.add_argument("--dry-run", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_move)
    s = sub.add_parser("update", help="检查 / 安装 GitHub Release 上的新版本"); s.add_argument("op", nargs="?", choices=["check", "apply"]); s.add_argument("--no-relaunch", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_update)
    s = sub.add_parser("init", help="首次设置向导：装依赖、建/接入任务板、选 Agent、同步规则与技能（无参数=交互式）"); s.add_argument("op", nargs="?", choices=["wizard", "status", "run", "hub-info", "add-host", "rename-self", "rename-peer", "remove-host", "skip", "finish", "reset", "peers"]); s.add_argument("args", nargs="*", help="run: <deps|cli|board|agents|rules|review|reverse-ssh> [参数…]; rename-self <新名字>; rename-peer <ssh或id> <新名字>; remove-host <id>"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_init)
    s = sub.add_parser("env", help="API keys / secrets store (~/.config/dispatch/env, 0600)"); s.add_argument("op", choices=["list", "get", "set", "unset", "export", "import", "path"]); s.add_argument("name", nargs="?"); s.add_argument("value", nargs="?"); s.add_argument("--note", help="用途，一句话"); s.add_argument("--stdin", action="store_true", help="set: 值从 stdin 读（不进 shell 历史）"); s.add_argument("--fish", action="store_true", help="export: fish 语法"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_env)
    s = sub.add_parser("prime", help="compact session-start digest (SessionStart hook)"); s.add_argument("--hook-json", action="store_true"); s.add_argument("--cwd"); s.add_argument("--limit", type=int, default=4, help="wiki entries for this project"); s.set_defaults(fn=cmd_prime)
    a = p.parse_args()
    if a.cmd == "agent":
        a.kind = a.target = a.target_or_kind
        if a.op != "list" and not a.target_or_kind:
            p.error("start 要给 kind（claude|codex…），其它要给目标（pane id / 名字 / 标题 / 任务 ID）")
        if a.op == "ask" and not a.text:
            p.error("ask 要给提示词")
    if a.cmd == "skills" and a.op not in ("list", "improve") and not a.name:
        p.error("需要技能名")
    if a.cmd in ("pit", "wiki") and a.op == "add" and not a.text:
        p.error("需要写内容")
    if a.cmd == "wiki" and a.op == "related" and not a.text:
        p.error("需要任务 ID")
    if a.cmd == "env" and a.op in ("get", "set", "unset", "import") and not a.name:
        p.error("需要变量名" if a.op != "import" else "需要文件路径")
    if a.cmd == "wiki" and a.op == "search":
        a.op = "list"
    a.fn(a)


if __name__ == "__main__":
    main()
