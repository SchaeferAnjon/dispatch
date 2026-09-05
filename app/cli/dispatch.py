#!/usr/bin/env python3
"""dispatch — the Agent-facing CLI for the global task board.

Everything Dispatch.app shows, an Agent can ask for here (JSON with --json):

  dispatch sessions                 live Agent sessions (who is running where, busy or waiting)
  dispatch find <task-id>           sessions whose transcript mentions the task, with resume commands
  dispatch resume <session|task>    print (or --copy) the command that resumes a session
  dispatch focus <session|task>     jump to the Herdr tab running that session
  dispatch skills list|show|enable|disable|open|path
  dispatch prime [--hook-json]      compact session-start digest: identity, this project's tasks, relevant wiki
  dispatch wiki add|list|search|show   knowledge base: pits (坑), wins (做对), retros (复盘), howtos (方法)
  dispatch pit add|list|show        = wiki --kind pit

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


def live_sessions():
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
    sessions.sort(key=lambda s: (s.get("state") != "working", -(s.get("last_at") or 0)))
    return sessions


def cmd_sessions(a):
    s = live_sessions()

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
        if agent == "codex":
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
        (parse_codex_stats if agent == "codex" else parse_claude_stats)(e, buf, re_ts)
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
    return f"{cd}{'codex resume' if agent == 'codex' else 'claude --resume'} {sid}"


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


def cmd_session(a):
    refs = resolve(load_index() or refresh_index(), a.key)
    if not refs:
        print(f"找不到 {a.key}", file=sys.stderr)
        sys.exit(1)
    d = read_session_detail(refs[0])

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
            for line in body.splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    fm[k.strip()] = v.strip().strip('"').strip("'")
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


def cmd_begin(a):
    """Create + claim a task in one go: the first thing an Agent does once it knows what it is doing."""
    labels = [f"project:{a.project}"] if a.project else []
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


def cmd_done(a):
    """Close a task with a reason; unverified work lands in 已完成·待审. Follow-ups become new tasks."""
    reason = a.reason
    if not a.verified:
        reason = reason + "（未核验）" if "核验" not in reason else reason
    bd_json(["close", a.task, "--reason", reason, "--json"])
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
    msg = f"{a.task} 已完成" + ("（已核验）" if a.verified else "，在「已完成 · 待审」等人验收")
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

    def until(epoch):
        m = int((epoch - time.time()) / 60)
        return f"{m}m 后重置" if m < 60 else f"{m // 60}h{m % 60:02d} 后重置" if m < 2880 else f"{m // 1440}d 后重置"

    def text(rows):
        for r in rows:
            parts = [f"{w['label']} {round(w['used_percent']) if w['used_percent'] is not None else '?'}%" + (f"（{until(w['resets_at'])}）" if w.get("resets_at") and w["resets_at"] > time.time() else "") for w in r["windows"]]
            print(f"{r['agent']:<12} {r['plan']:<14} {' · '.join(parts) if parts else r['note']}" + (f"   [数据 {ago(r['updated_at'])} 前]" if r.get("updated_at") else ""))
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
    # Read by Qoder desktop and Qoder CLI. Qoder IDE keeps its global rules in its own
    # settings UI, so it only sees these through a project's AGENTS.md.
    "qoder": {"path": os.path.join(HOME, ".qoder", "AGENTS.md"), "mode": "inline"},
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


def cmd_prime(a):
    """What an Agent needs at session start, and nothing else: who it is, the board's
    protocol in four lines, this project's tasks, and the wiki entries for this project
    (plus the few global ones). Everything else is one `dispatch wiki search` away."""
    cwd = a.cwd or os.getcwd()
    actor = os.environ.get("BEADS_ACTOR") or os.environ.get("DISPATCH_ACTOR") or ""
    names = project_names()
    proj = project_of_cwd(cwd, names)
    ptag = proj or "<项目名>"
    lines = [f"# Dispatch 中央任务板" + (f" · 当前项目 {proj}" if proj else "") + (f" · 你是 {actor}" if actor else "")]
    lines.append(f"任务：明白要做什么后 `dispatch begin \"标题\" -P {ptag} -d \"背景+要做什么\" -a \"- [ ] 验收项\"`（已有任务则 `bd update <id> --claim`）；进展 `dispatch log <id> \"…\"`；收尾 `dispatch done <id> --reason \"做了什么、怎么验证\" [--verified] [--retro \"【技术】…【做对】…【做错】…\"] [--next \"后续\"]`。")
    lines.append(f"知识库：`dispatch wiki search <词>` 动手前查一下；踩坑 `dispatch wiki add --kind pit \"现象\" --fix \"解法\" -P {ptag} --task <id>`；做对的做法 `--kind win \"…\" --why \"…\"`。")
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
    shown = mine[:8]
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
    pick = local[-a.limit:] + glob_[-max(2, a.limit // 2):]
    if pick:
        lines.append(f"## 知识库（{proj + ' + ' if proj else ''}通用；全部 {len(items)} 条，`dispatch wiki list`）")
        for it in pick:
            lines.append(wiki_line(it))
    text = "\n".join(lines)
    if a.hook_json:
        print(json.dumps({"continue": True, "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}, ensure_ascii=False))
    else:
        print(text)


# ---------------------------------------------------------------- main

def main():
    p = argparse.ArgumentParser(prog="dispatch", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sessions", help="live Agent sessions"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_sessions)
    s = sub.add_parser("find", help="sessions that mention a task"); s.add_argument("task"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_find)
    s = sub.add_parser("index", help="refresh the transcript index"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_index)
    s = sub.add_parser("folders", help="directories agents have worked in"); s.add_argument("--query", "-q"); s.add_argument("--cached", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_folders)
    s = sub.add_parser("list", help="browse all sessions"); s.add_argument("--agent", help="claude-code | codex | zcode"); s.add_argument("--project"); s.add_argument("--cwd", help="only sessions in this directory"); s.add_argument("--query", "-q"); s.add_argument("--limit", type=int, default=200); s.add_argument("--cached", action="store_true", help="use the cached index without rescanning"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_list)
    s = sub.add_parser("session", help="timeline + file changes of one session"); s.add_argument("key", help="session id (prefix ok) or task id"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_session)
    s = sub.add_parser("resume", help="print the resume command"); s.add_argument("key", help="session id (prefix ok) or task id"); s.add_argument("--copy", action="store_true"); s.set_defaults(fn=cmd_resume)
    s = sub.add_parser("focus", help="jump to the Herdr tab of a session"); s.add_argument("key"); s.set_defaults(fn=cmd_focus)
    s = sub.add_parser("skills", help="skill pool + per-agent mounts"); s.add_argument("op", choices=["list", "show", "path", "open", "enable", "disable", "improve"]); s.add_argument("name", nargs="?"); s.add_argument("--agent", choices=["claude", "codex", "all"]); s.add_argument("--query", "-q"); s.add_argument("--days", type=int, default=14, help="improve: 回看最近 N 天"); s.add_argument("--copy", action="store_true", help="improve: 启动命令复制到剪贴板"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_skills)
    s = sub.add_parser("begin", help="create + claim a task (do this once you know what you're doing)"); s.add_argument("title"); s.add_argument("--project", "-P"); s.add_argument("--desc", "-d"); s.add_argument("--acceptance", "-a", help="one '- [ ] …' per line"); s.add_argument("--type", "-t", default="task"); s.add_argument("--priority", "-p", type=int, default=2); s.add_argument("--deps"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_begin)
    s = sub.add_parser("log", help="progress note on a task (the process log)"); s.add_argument("task"); s.add_argument("text", nargs="?", default=""); s.add_argument("--tick", nargs="*", help="acceptance items (substring) to mark done"); s.set_defaults(fn=cmd_log)
    s = sub.add_parser("done", help="close a task; --next creates follow-ups; --retro writes the retrospective to the wiki"); s.add_argument("task"); s.add_argument("--reason", "-r", required=True); s.add_argument("--verified", action="store_true", help="you actually checked it works; otherwise it waits for review"); s.add_argument("--retro", help="复盘：做了什么【技术】用了什么【做对】哪里对了【做错】哪里错了 → wiki retro-<task>"); s.add_argument("--next", nargs="*", help="follow-up task titles"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_done)
    s = sub.add_parser("graph", help="task lineage: nodes + typed edges"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_graph)
    s = sub.add_parser("stats", help="tokens, activity heatmap, tools/skills across all agents"); s.add_argument("--agent", help="claude-code | codex | zcode"); s.add_argument("--days", type=int, default=0, help="only the last N days (0 = all)"); s.add_argument("--cached", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_stats)
    s = sub.add_parser("quota", help="usage limits per agent (5h / weekly)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_quota)
    s = sub.add_parser("rules", help="machine-wide rules for every agent"); s.add_argument("op", choices=["show", "path", "open", "status", "sync"]); s.add_argument("--force", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_rules)
    s = sub.add_parser("pit", help="pitfall log (= wiki --kind pit)"); s.add_argument("op", choices=["add", "list", "show"]); s.add_argument("text", nargs="?"); s.add_argument("--fix"); s.add_argument("--project", "-P"); s.add_argument("--task"); s.add_argument("--key"); s.add_argument("--all", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_pit)
    s = sub.add_parser("wiki", help="knowledge base: pits / wins / retros / howtos"); s.add_argument("op", choices=["add", "list", "search", "show"]); s.add_argument("text", nargs="?"); s.add_argument("--kind", "-k", choices=list(WIKI_KINDS)); s.add_argument("--fix", help="pit: 解法"); s.add_argument("--why", help="win: 为什么对"); s.add_argument("--tech", help="retro: 技术"); s.add_argument("--good", help="retro: 做对"); s.add_argument("--bad", help="retro: 做错"); s.add_argument("--project", "-P"); s.add_argument("--task"); s.add_argument("--key"); s.add_argument("--all", action="store_true", help="include plain memories"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_wiki)
    s = sub.add_parser("prime", help="compact session-start digest (SessionStart hook)"); s.add_argument("--hook-json", action="store_true"); s.add_argument("--cwd"); s.add_argument("--limit", type=int, default=6, help="wiki entries for this project"); s.set_defaults(fn=cmd_prime)
    a = p.parse_args()
    if a.cmd == "skills" and a.op not in ("list", "improve") and not a.name:
        p.error("需要技能名")
    if a.cmd in ("pit", "wiki") and a.op == "add" and not a.text:
        p.error("需要写内容")
    if a.cmd == "wiki" and a.op == "search":
        a.op = "list"
    a.fn(a)


if __name__ == "__main__":
    main()
