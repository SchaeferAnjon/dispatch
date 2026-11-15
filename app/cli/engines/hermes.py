# -*- coding: utf-8 -*-
"""Hermes (Nous Research): `hermes`, the assistant behind Telegram / WeChat / cron on a Mac. Dispatch reads its
sessions from its own SQLite file (~/.hermes/state.db, or $HERMES_HOME) and continues them in a terminal."""
import json
import os
import time
from lang import t as _t

from engines.base import Engine

# Hermes Agent (the assistant behind Telegram / 微信 / cron on the Mac mini) keeps every session in one SQLite file:
# `sessions` + `messages` (OpenAI-style tool_calls, one `tool` row per result), a schema of its own, so it gets its own
# readers here. The session's `source` says where it came from: source -> (source_kind for the Agent page, app label).
SOURCES = {"cli": ("terminal", "Hermes"), "desktop": ("desktop", "Hermes"), "cron": ("cron", "Hermes Scheduled"), "telegram": ("chat", "Telegram"),
           "weixin": ("chat", "WeChat"), "whatsapp": ("chat", "WhatsApp"), "discord": ("chat", "Discord"), "slack": ("chat", "Slack")}


class Hermes(Engine):
    id = "hermes"
    name = "Hermes"
    color = "#8a6d3b"
    about = "Nous Research's open-source assistant. You bring your own AI service key."
    bins = ("hermes",)
    install_hint = "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"

    config_home = "{home}/.hermes"
    config_home_env = "HERMES_HOME"

    terminal_args = "--tui"

    database = True

    def history_store(self, sid):
        """(what was typed: [{text}], the model, the last messages: [(role, text)] newest first) from its state.db."""
        last = query("select role, content from messages where session_id=? and role in ('user','assistant') and content is not null "
                              "and content != '' order by timestamp desc, id desc limit 3", (sid,))
        typed = [{"text": text_of(r["content"])} for r in query("select content from messages where session_id=? and role='user' order by timestamp, id", (sid,))]
        model = query("select model from sessions where id=?", (sid,))
        return typed, (model[0]["model"] if model and model[0]["model"] else ""), [(r["role"], text_of(r["content"])) for r in last]

    def child_counts(self):
        return {r["p"]: r["n"] for r in query("select parent_session_id p, count(*) n from sessions where parent_session_id is not null "
                                                        "group by parent_session_id")}

    def live_sessions(self, table):
        return live(table)

    def index_pending(self, idx, seen):
        """Its sessions the index has to read again: [row]; every one's key added to `seen`. Delegations
        (parent_session_id set) are listed under their parent, like Claude Code's sub-agents."""
        import dispatch as D
        todo = []
        for r in query("select id, source, title, cwd, model, started_at, ended_at, last_activity_at, input_tokens, output_tokens, "
                       "cache_read_tokens, cache_write_tokens, reasoning_tokens from sessions where parent_session_id is null"):
            key = "hermes:" + r["id"]
            seen.add(key)
            e = idx.get(key)
            # it names a session a moment after creating it, without touching last_activity_at: read again on a new title too
            if e and e.get("mtime") == session_last(r) and e.get("title") == (r["title"] or "") and e.get("stats_v") == D.STATS_V:
                continue
            todo.append(r)
        return todo

    def index_row(self, idx, r, rx):
        index_row(idx, r, rx)

    def detail(self, ref, limit, since=None):
        return detail(ref, limit, since)

    def subagents(self, key):
        """Delegations run as child sessions (sessions.parent_session_id)."""
        rows = query("select id, title, source, started_at, ended_at, last_activity_at from sessions where parent_session_id = ? order by started_at",
                     (key.split(":", 1)[1],))
        return [{"agent_id": r["id"], "type": r["source"] or _t("sub-session", "子会话"), "description": r["title"] or "", "tool_use_id": "", "depth": 1, "size": 0,
                 "last_at": session_last(r), "path": "hermes:" + r["id"], "running": r["ended_at"] is None and time.time() - session_last(r) < 300}
                for r in rows]

    def resume(self, sid, key=""):
        return ["chat", "--resume", sid], {}

    def runs_on_its_own(self, row):
        return row.get("entrypoint") == "cron"

    def activity_sessions(self, home, db):
        return [(f"hermes:{s['session_id']}", s) for s in activity_sessions(home, db)]

    def memory_files(self, home):
        # two global files: MEMORY.md (what it learned) and USER.md (about the person)
        return os.path.join(self.home_dir(home), "memories", "*.md")



def db_path():
    import dispatch as D
    return os.path.join(os.environ.get("HERMES_HOME") or os.path.join(D.HOME, ".hermes"), "state.db")


def query(sql, params=()):
    """Read-only query against Hermes Agent's state.db (see HERMES_DB)."""
    import dispatch as D
    return D._sqlite_rows(db_path(), sql, params)


def session_last(r):
    """When a Hermes session row last moved: its last activity, else its end, else its start (epoch s)."""
    return float(r.get("last_activity_at") or r.get("ended_at") or r.get("started_at") or 0)


def live(table):
    """Hermes has no hooks either: while a Hermes process runs (the gateway or an interactive
    `hermes chat`, both python from ~/.hermes/hermes-agent), a session that is still open and was
    written to in the last 30 minutes counts as live (working if it wrote within 90 s)."""
    import dispatch as D
    pids = [pid for pid, (_, comm) in table.items() if "/hermes-agent/" in D.P.to_slash(comm) or D._exe(comm) == "hermes"]
    if not pids:
        return []
    now = time.time()
    out = []
    for r in query("select id, source, title, cwd, started_at, ended_at, last_activity_at from sessions where parent_session_id is null and ended_at is null and coalesce(last_activity_at, started_at) > ? order by last_activity_at desc", (now - 30 * 60,)):
        last = session_last(r)
        kind, app = SOURCES.get(r["source"] or "", ("unknown", "Hermes"))
        cwd = r["cwd"] or D.HOME
        out.append({"agent": "hermes", "session_id": r["id"], "cwd": cwd, "project": os.path.basename(cwd.rstrip("/")), "agent_pid": pids[0], "source_kind": kind, "source_app": app, "entrypoint": r["source"] or "", "started_at": float(r["started_at"] or last), "last_at": last, "state": "working" if now - last < 90 else "idle", "prompts": 0, "alive": True, "registered": True, "title": r["title"] or ""})
    if not out:
        # The gateway is a resident process (Telegram / 微信 / cron): it is "online" even between
        # conversations. One daemon row says so; the app shows it as presence, not as a session.
        out.append({"agent": "hermes", "session_id": "hermes-gateway", "cwd": D.HOME, "project": "", "agent_pid": pids[0], "source_kind": "chat", "source_app": "Hermes Gateway", "entrypoint": "gateway", "started_at": 0, "last_at": now, "state": "idle", "prompts": 0, "alive": True, "registered": True, "title": "Hermes Gateway (messages and scheduled tasks)", "daemon": True})
    return out


def tool_calls(raw):
    """Hermes stores an assistant turn's tool calls as an OpenAI-style JSON list; yield (id, name, input)."""
    try:
        calls = json.loads(raw) if raw else []
    except Exception:
        return
    for tc in calls if isinstance(calls, list) else []:
        if not isinstance(tc, dict):
            continue
        fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
        name = fn.get("name") or tc.get("name") or ""
        args = fn.get("arguments") if fn else tc.get("arguments")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {"arguments": args}
        yield tc.get("id") or tc.get("call_id") or "", name, args if isinstance(args, dict) else {}


def parse_stats(e, r):
    """Hermes keeps token totals per session (and per model in session_model_usage), not per message:
    the totals land on the day the session started; messages give the activity by time."""
    import dispatch as D
    from datetime import datetime as _dt
    T = e["tokens"]
    i, o, cr, cw, th = (int(r.get(k) or 0) for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"))
    T["in"] += i; T["out"] += o; T["cr"] += cr; T["cw"] += cw; T["think"] += th
    try:
        start = _dt.fromtimestamp(float(r.get("started_at") or 0))
    except Exception:
        start = None
    if start and i + o + cr + cw:
        D.bump_time(e, start, 0, i + o + cr + cw, (i, o, cr, cw))
    usage = query("select model, api_call_count from session_model_usage where session_id=?", (r["id"],))
    for u in usage:
        if u["model"]:
            e["models"][u["model"]] = e["models"].get(u["model"], 0) + (u["api_call_count"] or 1)
    if not usage and r.get("model"):
        e["models"][r["model"]] = e["models"].get(r["model"], 0) + 1
    for m in query("select role, tool_calls, timestamp from messages where session_id=? and role in ('user','assistant')", (r["id"],)):
        try:
            dt = _dt.fromtimestamp(float(m["timestamp"]))
        except Exception:
            continue
        D.bump_time(e, dt, 1, 0)
        if m["role"] == "assistant" and m["tool_calls"]:
            for _, name, inp in tool_calls(m["tool_calls"]):
                # Hermes loads a skill by viewing it: skill_view / skills_view {name}.
                if name in ("skill_view", "skills_view", "skill") and inp.get("name"):
                    e["skills"][inp["name"]] = e["skills"].get(inp["name"], 0) + 1


def index_row(idx, r, rx):
    import dispatch as D
    mtime = session_last(r)
    started = float(r["started_at"] or mtime)
    e = {"agent": "hermes", "session_id": r["id"], "cwd": r["cwd"] or D.HOME, "title": r["title"] or "", "mtime": mtime, "size": 0, "off": 0, "tasks": {}, "claims": [], "subagent": False, "entrypoint": r["source"] or "", "branch": "", "first_ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)), "last_ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(mtime)), "user_msgs": 0, "assistant_msgs": 0, "tools": {}, "first_prompt": "", "stats_v": D.STATS_V, **D.stats_fields()}
    parse_stats(e, r)
    fp = query("select content from messages where session_id=? and role='user' order by timestamp, id limit 1", (r["id"],))
    if fp:
        e["first_prompt"] = text_of(fp[0]["content"]).strip()[:240]
    for m in query("select role, count(*) n from messages where session_id=? group by role", (r["id"],)):
        if m["role"] == "user":
            e["user_msgs"] = m["n"]
        elif m["role"] == "assistant":
            e["assistant_msgs"] = m["n"]
    for t in query("select tool_name, count(*) n from messages where session_id=? and role='tool' group by tool_name", (r["id"],)):
        if t["tool_name"]:
            e["tools"][t["tool_name"]] = t["n"]
    blob = "\n".join((m["content"] or "") + "\n" + (m["tool_calls"] or "") for m in query("select content, tool_calls from messages where session_id=? and role in ('user','assistant')", (r["id"],)))
    for m in rx.task.finditer(blob):
        e["tasks"][m.group(0)] = e["tasks"].get(m.group(0), 0) + 1
    e["claims"].extend(D.claims_of_events((m["tool_calls"] for m in query("select tool_calls from messages where session_id=? and role='assistant' and tool_calls is not null", (r["id"],))), rx.claim_id, in_call=True))
    e["size"] = len(blob)
    idx["hermes:" + r["id"]] = e


def text_of(content, pictures=None):
    """A Hermes message's text: plain, or a JSON list of content parts (text / image; a picture reads as `pictures`)."""
    pictures = _t("[image]", "[图片]") if pictures is None else pictures
    if not content:
        return ""
    if isinstance(content, str) and content.lstrip().startswith("["):
        try:
            parts = json.loads(content)
            if isinstance(parts, list):
                return "\n".join(p.get("text", "") if isinstance(p, dict) and p.get("type") == "text" else (pictures if isinstance(p, dict) and "image" in str(p.get("type", "")) else "") for p in parts).strip()
        except Exception:
            pass
    return str(content)


def result_failed(content):
    """A Hermes tool result is JSON from the tool: {"success": false} or a non-empty "error" means it failed."""
    try:
        d = json.loads(content) if content else {}
    except Exception:
        return False
    return isinstance(d, dict) and (d.get("success") is False or bool(d.get("error")))


def detail(ref, limit, since=None):
    """Hermes messages: user / assistant (text + reasoning + OpenAI-style tool_calls) / tool (one row per
    result, paired by tool_call_id). `since` is the last message id a previous read stopped at."""
    import dispatch as D
    sid = ref["session_id"]
    tl = D._Timeline()
    sql = "select id, role, content, tool_calls, tool_call_id, tool_name, timestamp, reasoning, reasoning_content, display_kind from messages where session_id=?"
    params = [sid]
    if since:
        sql += " and id > ?"; params.append(int(since))
    rows = query(sql + " order by timestamp, id", tuple(params))
    offset = int(since or 0)
    last_ts = 0
    for r in rows:
        offset = max(offset, int(r["id"] or 0))
        if r["role"] not in ("user", "assistant", "tool") or r.get("display_kind") == "hidden":
            continue
        last_ts = max(last_ts, float(r["timestamp"] or 0))
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(float(r["timestamp"] or 0)))
        if r["role"] == "user":
            text = text_of(r["content"])
            if text.strip():
                tl.add(ts, "user", [{"type": "text", "text": text[:D.LONG_TEXT]}])
            continue
        if r["role"] == "tool":
            content = r["content"] or ""
            tl.resolve(r["tool_call_id"], content, result_failed(content), ts)
            continue
        blocks = []
        think = (r.get("reasoning") or r.get("reasoning_content") or "").strip()
        if think:
            blocks.append(D._thinking_block(think))
        text = text_of(r["content"])
        if text.strip():
            blocks.append({"type": "text", "text": text[:D.LONG_TEXT]})
        for cid, name, inp in tool_calls(r["tool_calls"]):
            blocks.append(tl.tool(ts, cid, name, inp, D._tool_summary(inp)))
            D._tool_file_change(name, inp, ts, tl.files)
        if blocks:
            tl.add(ts, "assistant", blocks, mid=str(r["id"]))
    sess = query("select ended_at from sessions where id=?", (sid,))
    open_ = bool(sess) and sess[0]["ended_at"] is None
    return D._finish_detail(ref, tl, limit, since, offset, live=open_ and bool(rows) and time.time() - last_ts < D.RUNNING_GRACE)


# ---------------------------------------------------------------- its conversations in the activity list (activity.py)
ACTIVITY_PARSER = 2


def activity_state(z, s, home):
    """One Hermes session (a row of its state.db) in the row shape activity.observe() produces."""
    import hashlib
    import activity as A
    sid = s['id']
    last_at = float(s['last_activity_at'] or s['ended_at'] or s['started_at'] or 0)
    state = {'parser_version': ACTIVITY_PARSER, 'agent': 'hermes', 'session_id': sid, 'cwd': s['cwd'] or home, 'title': (s['title'] or '')[:100],
             'last_at': last_at, 'state': 'idle', 'activity': '', 'events': [], 'version': f'0:{s["mid"] or 0}', 'entrypoint': s['source'] or ''}
    events = state['events']
    def event(ts, kind, summary, **extra):
        eid = hashlib.sha256((str(ts) + kind + summary).encode()).hexdigest()[:20]
        if not any(e['id'] == eid for e in events):
            events.append(dict(id=eid, ts=ts, kind=kind, text=summary[:400], **extra))
    pending = {}   # tool call id -> (name, paths)
    for r in z.execute("SELECT id, role, content, tool_calls, tool_call_id, tool_name, timestamp, display_kind FROM messages WHERE session_id=? AND role IN ('user','assistant','tool') ORDER BY timestamp, id", (sid,)):
        if r['display_kind'] == 'hidden': continue
        ts = float(r['timestamp'] or 0)
        state['last_at'] = max(state['last_at'], ts)
        if r['role'] == 'user':
            text = A.user_text(text_of(r['content'], pictures=''))
            if not text.strip(): continue
            state['user_at'] = ts
            A.remember_topic(state, text)
            state['state'], state['activity'] = 'working', _t('working on your message', '正在处理你的消息')
            if not state.get('title'): state['title'] = text.strip().split('\n')[0][:100]
            event(ts, 'user', text)
            continue
        if r['role'] == 'tool':
            name, paths = pending.pop(r['tool_call_id'] or '', (r['tool_name'] or '', []))
            failed = False
            try:
                d = json.loads(r['content'] or '{}')
                failed = isinstance(d, dict) and (d.get('success') is False or bool(d.get('error')))
            except (ValueError, TypeError): pass
            event(ts, 'error' if failed else 'result', (_t('failed · ', '失败 · ') if failed else _t('returned · ', '已返回 · ')) + name, paths=paths)
            if not failed:
                for path in paths: state.setdefault('files', {})[path] = ts
            state['activity'] = _t('a tool failed', '工具执行失败') if failed else _t(f'ran · {name}', f'已执行 · {name}')
            state['state'] = 'working'
            continue
        calls = list(tool_calls(r['tool_calls']))
        text = text_of(r['content'], pictures='')
        for cid, name, inp in calls:
            summary = A.operation_summary(name, inp, json.dumps(inp, ensure_ascii=False))
            paths = [x for x in [inp.get('path') or inp.get('file_path') or inp.get('filePath')] if x] if any(w in name.lower() for w in ('write', 'edit', 'patch')) else []
            pending[cid] = (name, paths)
            event(ts, 'tool', summary, tool=name, paths=paths)
            state['activity'] = f'{name} · {summary[:160]}'
            state['state'] = 'working'
        # A turn is over when the model answered without asking for another tool.
        finished = not calls
        if text.strip():
            event(ts, 'reply' if finished else 'message', text)
            if finished:
                digest = hashlib.sha256(text.encode()).hexdigest()[:20]
                if digest != state.get('reply_digest') or state.get('user_at', 0) > state.get('reply_at', 0):
                    state.update(reply_id=f'{ts}:{digest}', reply_at=ts, reply_digest=digest, reply_preview=text[:280], question=A.question_of(text))
            state['activity'] = _t('replied', '已回复') if finished else _t('replying', '正在回复')
        if finished:
            state['state'] = 'idle'
            if not text.strip(): state['activity'] = _t('this turn is over', '本轮已结束')
    if s['ended_at']:
        state['state'] = 'idle'
        if state['activity'] in ('', _t('working on your message', '正在处理你的消息')): state['activity'] = _t('this turn is over', '本轮已结束')
    state['events'] = events[-80:]
    return state


def activity_sessions(home, db, limit=60):
    """Its conversations for the activity list, parsed once per change (cached in activity's `streams`)."""
    import sqlite3
    from contextlib import closing
    import activity as A
    path = db_path() if home == os.path.expanduser('~') else os.path.join(home, '.hermes', 'state.db')
    if not os.path.exists(path): return []
    try:
        z = sqlite3.connect(A.ro_uri(path), uri=True, timeout=2)
        z.row_factory = sqlite3.Row
    except sqlite3.Error: return []
    rows = []
    with closing(z):
        try:
            sessions = z.execute('SELECT s.id, s.source, s.title, s.cwd, s.started_at, s.ended_at, s.last_activity_at, (SELECT max(id) FROM messages m WHERE m.session_id = s.id) mid FROM sessions s WHERE s.parent_session_id IS NULL ORDER BY coalesce(s.last_activity_at, s.ended_at, s.started_at) DESC LIMIT ?', (limit,)).fetchall()
        except sqlite3.Error: return []
        for s in sessions:
            key = f'hermes:{s["id"]}'
            # A new message, the session closing, or a (late) title change invalidates the cache.
            version = (int(s['mid'] or 0) * 2 + (1 if s['ended_at'] else 0)) * 1024 + len(s['title'] or '') % 1024
            cached = db.execute('SELECT off,data FROM streams WHERE path=?', (key,)).fetchone()
            if cached and cached[0] == version:
                state = json.loads(cached[1])
                if state.get('parser_version') == ACTIVITY_PARSER:
                    rows.append(state); continue
            try: state = activity_state(z, s, home)
            except sqlite3.Error: continue
            db.execute('INSERT OR REPLACE INTO streams VALUES (?,?,?,?,?)', (key, 0, version, state['last_at'], json.dumps(state, ensure_ascii=False)))
            if state.get('session_id'): db.execute('INSERT OR REPLACE INTO stream_sids VALUES (?,?)', (key, state['session_id']))
            rows.append(state)
    return rows


ENGINE = Hermes()
