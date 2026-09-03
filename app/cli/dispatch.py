#!/usr/bin/env python3
"""dispatch — the Agent-facing CLI for the global task board.

Everything Dispatch.app shows, an Agent can ask for here (JSON with --json):

  dispatch sessions                 live Agent sessions (who is running where, busy or waiting)
  dispatch find <task-id>           sessions whose transcript mentions the task, with resume commands
  dispatch resume <session|task>    print (or --copy) the command that resumes a session
  dispatch focus <session|task>     jump to the Herdr tab running that session
  dispatch skills list|show|enable|disable|open|path
  dispatch pit add|list|show        pitfall log (stored as bd memories, injected by `bd prime`)

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
    "codex": [os.path.join(HOME, ".codex", "skills"), os.path.join(HOME, ".agents", "skills")],
}
CC_SWITCH_DB = os.path.join(HOME, ".cc-switch", "cc-switch.db")
HERDR = os.path.join(HOME, ".local", "bin", "herdr")
ZCODE_DB = os.path.join(HOME, ".zcode", "cli", "db", "db.sqlite")
PATH_EXTRA = "/opt/homebrew/bin:/usr/local/bin:" + os.path.join(HOME, ".local", "bin")


def sh(args, timeout=20, env=None):
    e = dict(os.environ)
    e["PATH"] = PATH_EXTRA + ":" + e.get("PATH", "")
    e.setdefault("BEADS_DIR", BEADS_DIR)
    if env:
        e.update(env)
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=e)
    return r.returncode, r.stdout, r.stderr


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


def live_sessions():
    table = ps_table()
    sessions = zcode_live(table)
    seen = set()
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
        sessions.append(r)
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
        e = idx.get(path) or {"agent": agent, "session_id": "", "cwd": "", "title": "", "mtime": 0, "size": 0, "off": 0, "tasks": {}, "claims": [], "subagent": "/subagents/" in path, "entrypoint": "", "branch": "", "first_ts": "", "last_ts": "", "user_msgs": 0, "assistant_msgs": 0, "tools": {}}
        for k, v in (("entrypoint", ""), ("branch", ""), ("first_ts", ""), ("last_ts", ""), ("user_msgs", 0), ("assistant_msgs", 0), ("tools", {})):
            e.setdefault(k, v)
        if e["mtime"] == st.st_mtime and e["size"] == st.st_size:
            idx[path] = e
            continue
        if st.st_size < e["off"]:
            e["off"], e["tasks"], e["claims"] = 0, {}, []
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
        e["off"], e["mtime"], e["size"] = st.st_size, st.st_mtime, st.st_size
        idx[path] = e
    # ZCode sessions live in SQLite, not files; key them as zcode:<id>.
    for r in zcode_query("select id, parent_id, directory, title, time_created, time_updated from session where parent_id is null"):
        key = "zcode:" + r["id"]
        seen.add(key)
        mtime = r["time_updated"] / 1000
        e = idx.get(key)
        if e and e.get("mtime") == mtime:
            continue
        e = {"agent": "zcode", "session_id": r["id"], "cwd": r["directory"], "title": r["title"], "mtime": mtime, "size": 0, "off": 0, "tasks": {}, "claims": [], "subagent": False, "entrypoint": "desktop", "branch": "", "first_ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r["time_created"] / 1000)), "last_ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(mtime)), "user_msgs": 0, "assistant_msgs": 0, "tools": {}}
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


def resume_command(agent, sid, cwd):
    if agent == "zcode":
        # ZCode is a desktop app without a resume CLI; the session id identifies it inside the app.
        return f"open -a ZCode  # 会话 {sid}"
    cd = f"cd '{cwd.replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}' && " if cwd else ""
    return f"{cd}{'codex resume' if agent == 'codex' else 'claude --resume'} {sid}"


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
    return {"agent": e["agent"], "session_id": e["session_id"], "cwd": e["cwd"], "project": os.path.basename(e["cwd"].rstrip("/")), "title": e.get("title", ""), "last_at": e["mtime"], "first_ts": e.get("first_ts", ""), "last_ts": e.get("last_ts", ""), "entrypoint": e.get("entrypoint", ""), "branch": e.get("branch", ""), "user_msgs": e.get("user_msgs", 0), "assistant_msgs": e.get("assistant_msgs", 0), "tools": e.get("tools", {}), "tasks": e.get("tasks", {}), "mentions": e["tasks"].get(task_id, 0) if task_id else sum(e["tasks"].values()), "current_task": (e.get("claims") or [None])[-1], "resume_cmd": resume_command(e["agent"], e["session_id"], e["cwd"]), "path": path, "size": e.get("size", 0), "subagents": subagents_of(path) if e["agent"] in ("claude-code", "zcode") else []}


def session_refs(idx, task_id=None, session_id=None):
    refs = []
    for path, e in idx.items():
        if not e.get("session_id") or e.get("subagent"):
            continue
        if task_id and task_id not in e["tasks"]:
            continue
        if session_id and not e["session_id"].startswith(session_id):
            continue
        refs.append(ref_of(path, e, task_id))
    refs.sort(key=lambda r: -r["last_at"])
    return refs


def cmd_index(a):
    idx = refresh_index()
    n = len([1 for e in idx.values() if not e.get("subagent")])
    out({"files": len(idx), "sessions": n, "index": INDEX_FILE}, a.json, lambda o: print(f"索引 {o['files']} 个文件，{o['sessions']} 个会话 → {o['index']}"))


def cmd_list(a):
    idx = load_index() if a.cached else refresh_index()
    refs = session_refs(idx)
    if a.agent:
        refs = [r for r in refs if r["agent"] == a.agent]
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


def read_session_detail(ref, limit=400):
    """Parse one transcript into a compact timeline + file changes (from Edit/Write tool calls)."""
    if ref["agent"] == "zcode":
        return read_zcode_detail(ref, limit)
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
    rows = []
    for n, path in sorted(names.items()):
        fm = read_frontmatter(path)
        rows.append({"name": n, "path": path, "in_pool": path.startswith(POOL), "description": fm.get("description", ""), "agents": {ag: n in m[ag] for ag in m}, "mounts": {ag: (m[ag][n][0] if n in m[ag] else None) for ag in m}})
    return rows


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
    msg = f"{a.task} 已完成" + ("（已核验）" if a.verified else "，在「已完成 · 待审」等人验收")
    if created:
        msg += f"；后续任务：{', '.join(created)}"
    out({"closed": a.task, "next": created}, a.json, lambda o: print(msg))


# ---------------------------------------------------------------- global rules (one file → every agent)

RULES_FILE = os.path.join(DISPATCH_DIR, "GLOBAL_RULES.md")
RULES_BEGIN = "<!-- BEGIN DISPATCH GLOBAL RULES"
RULES_END = "<!-- END DISPATCH GLOBAL RULES -->"
# Where each agent reads machine-wide instructions. Claude Code can @import a
# file; the others get the content inlined inside the managed block.
RULE_TARGETS = {
    "claude": {"path": os.path.join(HOME, ".claude", "CLAUDE.md"), "mode": "import"},
    "codex": {"path": os.path.join(HOME, ".codex", "AGENTS.md"), "mode": "inline"},
    "zcode": {"path": os.path.join(HOME, ".zcode", "AGENTS.md"), "mode": "inline"},
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


# ---------------------------------------------------------------- pitfalls

def cmd_pit(a):
    if a.op == "add":
        content = f"【坑】{a.text.strip()}"
        if a.fix:
            content += f" 【解法】{a.fix.strip()}"
        if a.project:
            content += f" #project:{a.project}"
        if a.task:
            content += f" #task:{a.task}"
        key = a.key or ("pit-" + (re.sub(r"[^a-z0-9]+", "-", a.text.lower()).strip("-")[:40] or str(int(time.time()))))
        if not key.startswith("pit-"):
            key = "pit-" + key
        code, o, err = sh(["bd", "remember", content, "--key", key])
        print(o.strip() or err.strip())
        if code == 0:
            print(f"已记录 {key}。所有 Agent 下次会话启动会看到。")
        sys.exit(code)
    code, o, err = sh(["bd", "memories", "--json"])
    if code != 0:
        print(err, file=sys.stderr)
        sys.exit(code)
    d = json.loads(o[o.find("{"):])
    items = [{"key": k, "value": v} for k, v in d.items() if k != "schema_version" and isinstance(v, str)]
    if a.op == "show":
        for it in items:
            if it["key"] == a.text or it["key"] == "pit-" + (a.text or ""):
                print(it["value"])
                return
        print("没有这条", file=sys.stderr)
        sys.exit(1)
    q = (a.text or "").lower()
    items = [it for it in items if (a.all or it["key"].startswith("pit-") or "【坑】" in it["value"]) and (not q or q in it["value"].lower() or q in it["key"].lower())]

    def text(items):
        for it in items:
            print(f"{it['key']}\n    {it['value']}")
        print(f"\n{len(items)} 条")
    out(items, a.json, text)


# ---------------------------------------------------------------- main

def main():
    p = argparse.ArgumentParser(prog="dispatch", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sessions", help="live Agent sessions"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_sessions)
    s = sub.add_parser("find", help="sessions that mention a task"); s.add_argument("task"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_find)
    s = sub.add_parser("index", help="refresh the transcript index"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_index)
    s = sub.add_parser("list", help="browse all sessions"); s.add_argument("--agent", help="claude-code | codex | zcode"); s.add_argument("--project"); s.set_defaults(include_subagents=None); s.add_argument("--query", "-q"); s.add_argument("--limit", type=int, default=200); s.add_argument("--cached", action="store_true", help="use the cached index without rescanning"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_list)
    s = sub.add_parser("session", help="timeline + file changes of one session"); s.add_argument("key", help="session id (prefix ok) or task id"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_session)
    s = sub.add_parser("resume", help="print the resume command"); s.add_argument("key", help="session id (prefix ok) or task id"); s.add_argument("--copy", action="store_true"); s.set_defaults(fn=cmd_resume)
    s = sub.add_parser("focus", help="jump to the Herdr tab of a session"); s.add_argument("key"); s.set_defaults(fn=cmd_focus)
    s = sub.add_parser("skills", help="skill pool + per-agent mounts"); s.add_argument("op", choices=["list", "show", "path", "open", "enable", "disable"]); s.add_argument("name", nargs="?"); s.add_argument("--agent", choices=["claude", "codex", "all"]); s.add_argument("--query", "-q"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_skills)
    s = sub.add_parser("begin", help="create + claim a task (do this once you know what you're doing)"); s.add_argument("title"); s.add_argument("--project", "-P"); s.add_argument("--desc", "-d"); s.add_argument("--acceptance", "-a", help="one '- [ ] …' per line"); s.add_argument("--type", "-t", default="task"); s.add_argument("--priority", "-p", type=int, default=2); s.add_argument("--deps"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_begin)
    s = sub.add_parser("log", help="progress note on a task (the process log)"); s.add_argument("task"); s.add_argument("text", nargs="?", default=""); s.add_argument("--tick", nargs="*", help="acceptance items (substring) to mark done"); s.set_defaults(fn=cmd_log)
    s = sub.add_parser("done", help="close a task; --next creates follow-ups"); s.add_argument("task"); s.add_argument("--reason", "-r", required=True); s.add_argument("--verified", action="store_true", help="you actually checked it works; otherwise it waits for review"); s.add_argument("--next", nargs="*", help="follow-up task titles"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_done)
    s = sub.add_parser("rules", help="machine-wide rules for every agent"); s.add_argument("op", choices=["show", "path", "open", "status", "sync"]); s.add_argument("--force", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_rules)
    s = sub.add_parser("pit", help="pitfall log"); s.add_argument("op", choices=["add", "list", "show"]); s.add_argument("text", nargs="?"); s.add_argument("--fix"); s.add_argument("--project"); s.add_argument("--task"); s.add_argument("--key"); s.add_argument("--all", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_pit)
    a = p.parse_args()
    if a.cmd == "skills" and a.op != "list" and not a.name:
        p.error("需要技能名")
    if a.cmd == "pit" and a.op == "add" and not a.text:
        p.error("需要写坑的内容")
    a.fn(a)


if __name__ == "__main__":
    main()
