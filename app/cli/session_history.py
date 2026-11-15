# -*- coding: utf-8 -*-
"""`dispatch sessions history`: every agent session left on this Mac, to look at and search, without importing any.

Claude Code, Codex, OpenCode, pi, Hermes, Gemini CLI and ZCode keep their conversations on disk. The transcript index
(dispatch.py `refresh_index`, one row per conversation: folder, title, first message, counts, models) already reads
them; this adds what a history list needs on top and keeps it in its own cache, `<DISPATCH_DIR>/session-history.db`:

    sess(key, agent, mtime, size, off,          key = the index's key (a transcript path, or <agent>:<id>)
         last_role, last_text, last_model,      the last message (you / the agent) and the last model used
         prompts, n_prompts, parent, v)         what the person typed (searchable, capped), a Codex helper's parent
    native(host_id, sid)                        an Agents-window session's id -> the agent's own id

Both are updated incrementally: a transcript file is read from where the last read stopped, a database session only
when its time changed. A first read of a big history is done in the background (`--refresh`), while the list already
shows what the index has.

Looking does not change anything: no project is registered, no session is imported or opened. Continuing one is the
window's business (it runs the agent's own resume command in a terminal session, or opens the session when the Agents
window already has it).

    dispatch sessions history [--scope all|project|workspace] [--folder PATH] [--query TEXT] [--agents a,b]
                              [--sort updated|created] [--limit N] [--show-empty] [--machine ID] [--user-data DIR] --json
      {ok, machine, machines, scope, folder, project, total, matched, shown, agents:[{id,name,count}],
       refreshing, indexing, groups:[{project, root, count, sessions:[row]}]}
      row: {key, agent, agent_name, icon, session_id, title, preview:{role,text}, snippet, matches, messages, subagents,
            last_at, created_at, model, cwd, folder_exists, project, project_root, branch, first_prompt,
            resume:{ok, command, cwd, why}, window:{provider, id}|null, host}
    dispatch sessions history --refresh       bring the index and this cache up to date (what the background run does)
"""
import sys
from lang import t as _t

sys.dont_write_bytecode = True

import json
import os
import re
import shlex
import sqlite3
import time

import engines as E

D = None  # the dispatch module (set by dispatch.py)

V = 1                       # bump to read everything again when what a row keeps changes
DB_NAME = "session-history.db"
LOCK_NAME = "session-history.lock"
PROMPTS_CAP = 200_000       # characters of typed text kept per session for search
PREVIEW_CAP = 400
CHUNK = 8 << 20
TAIL = 512 << 10            # the last message is looked for in the last 512 KB of what was read
INLINE_BUDGET_S = 0.8       # what one answer may spend reading transcripts; the rest goes to the background
STALE_S = 60                # an index older than this is refreshed in the background
DEFAULT_LIMIT = 80


def _window_agent(provider, default=None):
    """The agent of an Agents-window provider id (claude -> claude-code) for the engines whose window sessions this
    page lists (the ones Dispatch runs); `default` for any other."""
    eng = E.find(provider)
    return eng.agent if eng and eng.runnable else default


_TAG_BLOCK = re.compile(r"<([A-Za-z][\w-]{0,40})\b[^>]*>[\s\S]*?</\1>")
_SPACES = re.compile(r"\s+")
CODEX_PREAMBLE = "# AGENTS.md instructions"
NOISE_PREFIXES = ("<", "[Image", "Caveat:", "[Request interrupted")


# ---- reading text ------------------------------------------------------------------------------

def clean(text):
    """What a person reads of a message: system envelopes (<tag>…</tag>) out, whitespace folded."""
    if not isinstance(text, str):
        return ""
    text = _TAG_BLOCK.sub("", text).strip()
    if not text or text.startswith(NOISE_PREFIXES) or text.startswith(CODEX_PREAMBLE):
        return ""
    return _SPACES.sub(" ", text)


def _blocks_text(content, kinds=("text", "input_text", "output_text")):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") in kinds and isinstance(b.get("text"), str))


def message_of(agent, d):
    """(role, text) of one transcript record when it is a message a person would read: what was typed ("user")
    or what the agent wrote back ("agent"); None for tool calls, tool output, system records."""
    if not isinstance(d, dict):
        return None
    got = E.get(agent).history_message(d)  # its adapter knows its records
    if not got:
        return None
    txt = clean(_blocks_text(got[1]))
    return (got[0], txt) if txt else None


_MODEL = re.compile(rb'"(?:model|modelId)":"([^"]{2,80})"')
_TEXT_BLOCK = re.compile(rb'"type":\s*"(?:input_text|text)",\s*"text":\s*"((?:[^"\\]|\\.){1,20000})"')
BIG_LINE = 256 << 10


def last_model_in(buf):
    """The last model named near the end of a piece of transcript (Claude: the reply's model, Codex: the turn's, pi: its change)."""
    for m in reversed(list(_MODEL.finditer(buf, max(0, len(buf) - TAIL)))):
        name = m.group(1).decode("utf-8", "replace")
        if not name.startswith("<") and name != "synthetic":
            return name
    return ""


def lines_with(buf, needle):
    """The lines of `buf` (bytes) that contain `needle`, each once."""
    pos = 0
    while True:
        i = buf.find(needle, pos)
        if i < 0:
            return
        e = buf.find(b"\n", i)
        e = len(buf) if e < 0 else e
        yield buf[buf.rfind(b"\n", 0, i) + 1:e]
        pos = e + 1


def typed_in(agent, line):
    """What a person typed, from one user record (bytes); "" when it is not one. A very big record (a pasted picture)
    is not parsed whole: its text blocks are picked out."""
    if E.get(agent).typed_skip(line):
        return ""
    if len(line) > BIG_LINE:
        parts = []
        for m in _TEXT_BLOCK.finditer(line):
            try:
                parts.append(json.loads(b'"' + m.group(1) + b'"'))
            except ValueError:
                pass
        return clean("\n".join(parts))
    try:
        got = message_of(agent, json.loads(line))
    except ValueError:
        return ""
    return got[1] if got and got[0] == "user" else ""


def fold_piece(agent, row, buf):
    """Fold one piece of a transcript (bytes, whole lines) into the history row: typed messages, last message, last model."""
    for marker in E.get(agent).user_markers:
        for line in lines_with(buf, marker):
            txt = typed_in(agent, line)
            if txt:
                row["n_prompts"] += 1
                if len(row["prompts"]) < PROMPTS_CAP:
                    row["prompts"] = (row["prompts"] + "\n" + txt if row["prompts"] else txt)[:PROMPTS_CAP]
    tail = buf[-TAIL:]
    for line in reversed(tail.split(b"\n")):
        if not line.startswith(b"{") or (b'"user"' not in line and b'"assistant"' not in line):
            continue
        if len(line) > BIG_LINE:
            continue
        try:
            got = message_of(agent, json.loads(line))
        except ValueError:
            continue
        if got:
            row["last_role"], row["last_text"] = got[0], got[1][:PREVIEW_CAP]
            break
    model = last_model_in(buf)
    if model:
        row["last_model"] = model


def read_file(path, agent, row):
    """Read what the transcript gained since `row` last saw it."""
    st = os.stat(path)
    if st.st_size < row["off"]:
        row.update(new_row(row["key"], agent))
    pos, end = row["off"], st.st_size
    with open(path, "rb") as f:
        f.seek(pos)
        while pos < end:
            raw = f.read(min(CHUNK, end - pos))
            if not raw:
                break
            pos += len(raw)
            if pos < end and not raw.endswith(b"\n"):
                rest = f.readline()
                raw += rest
                pos += len(rest)
            if pos >= end and not raw.endswith(b"\n"):
                cut = raw.rfind(b"\n") + 1  # a record still being written: read it next time
                pos -= len(raw) - cut
                raw = raw[:cut]
            fold_piece(agent, row, raw)
    row["off"], row["mtime"], row["size"] = pos, st.st_mtime, st.st_size
    if E.get(agent).lists_subthreads and row["off"] and not row.get("parent_read"):
        row["parent"] = E.get(agent).transcript_parent(path)
        row["parent_read"] = 1


def read_store(agent, key, row):
    """OpenCode / ZCode (SQLite), Hermes: the last message, the model, what was typed."""
    sid = key.split(":", 1)[1]
    if agent in D.SQLITE_STORES:
        q = lambda sql, p=(sid,): D.zcode_query(sql, p, agent=agent)  # noqa: E731
        last = q("select json_extract(m.data,'$.role') role, json_extract(p.data,'$.text') text from part p join message m on m.id=p.message_id "
                 "where p.session_id=? and json_extract(p.data,'$.type')='text' and coalesce(json_extract(p.data,'$.synthetic'),0)=0 order by p.time_created desc limit 3")
        typed = q("select json_extract(p.data,'$.text') text from part p join message m on m.id=p.message_id where p.session_id=? "
                  "and json_extract(m.data,'$.role')='user' and json_extract(p.data,'$.type')='text' and coalesce(json_extract(p.data,'$.synthetic'),0)=0 order by p.time_created")
        model = q("select json_extract(data,'$.modelID') model from message where session_id=? and json_extract(data,'$.role')='assistant' order by time_created desc limit 1")
        msgs = [(r["role"], r["text"]) for r in last]
        row["last_model"] = (model[0]["model"] if model and model[0]["model"] else "") or row.get("last_model", "")
    elif E.get(agent).supports("history_store"):  # a database of its own schema (Hermes)
        typed, model, msgs = E.get(agent).history_store(sid)
        row["last_model"] = model or row.get("last_model", "")
    else:
        return
    for role, text in msgs:
        txt = clean(text)
        if txt:
            row["last_role"], row["last_text"] = ("user" if role == "user" else "agent"), txt[:PREVIEW_CAP]
            break
    texts = [clean(r.get("text")) for r in typed]
    texts = [t for t in texts if t]
    row["n_prompts"] = len(texts)
    row["prompts"] = "\n".join(texts)[:PROMPTS_CAP]


# ---- the cache ---------------------------------------------------------------------------------

COLS = ("key", "agent", "mtime", "size", "off", "last_role", "last_text", "last_model", "prompts", "n_prompts", "parent", "parent_read", "v")


def db_path():
    return os.path.join(D.DISPATCH_DIR, DB_NAME)


def connect():
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    con = sqlite3.connect(db_path(), timeout=10)
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA journal_mode=WAL")
    except sqlite3.Error:
        pass
    con.execute("CREATE TABLE IF NOT EXISTS sess(key TEXT PRIMARY KEY, agent TEXT, mtime REAL, size INTEGER, off INTEGER, last_role TEXT, "
                "last_text TEXT, last_model TEXT, prompts TEXT, n_prompts INTEGER, parent TEXT, parent_read INTEGER, v INTEGER)")
    con.execute("CREATE TABLE IF NOT EXISTS native(host_id TEXT PRIMARY KEY, sid TEXT)")
    con.commit()
    return con


def new_row(key, agent):
    return {"key": key, "agent": agent, "mtime": 0, "size": 0, "off": 0, "last_role": "", "last_text": "", "last_model": "",
            "prompts": "", "n_prompts": 0, "parent": "", "parent_read": 0, "v": V}


def save(con, row):
    con.execute(f"INSERT OR REPLACE INTO sess({','.join(COLS)}) VALUES({','.join('?' * len(COLS))})", [row.get(c) for c in COLS])


def light_rows(con):
    """Every cached row without the typed text (that stays in the database for search)."""
    return {r["key"]: dict(r) for r in con.execute("SELECT key, agent, mtime, size, off, last_role, last_text, last_model, n_prompts, parent, parent_read, v FROM sess")}


def is_file_key(key):
    return key.startswith("/") or (len(key) > 2 and key[1] == ":" and key[2] in "\\/")


def wanted(idx):
    """The index rows the history keeps something for: conversations, and Codex helper threads (for their parent)."""
    for key, e in idx.items():
        if not e.get("session_id"):
            continue
        if e.get("subagent") and not E.get(e.get("agent")).lists_subthreads:
            continue
        yield key, e


def changed(cached, key, e):
    c = cached.get(key)
    if not c or c.get("v") != V:
        return True
    if is_file_key(key):
        return c["mtime"] != e.get("mtime") or c["size"] != e.get("size")
    return abs((c["mtime"] or 0) - (e.get("mtime") or 0)) > 1e-6


INLINE_MAX_BYTES = 16 << 20  # a transcript with more than this to read waits for the background run


def update(con, idx, budget_s=None, on_progress=None):
    """Read what changed, most recent first; with `budget_s` stop after that many seconds and leave big reads for the
    background run (None: everything). Returns how many are left."""
    cached = light_rows(con)
    todo = [(key, e) for key, e in wanted(idx) if changed(cached, key, e)]
    todo.sort(key=lambda t: -(t[1].get("mtime") or 0))
    t0, n, skipped = time.time(), 0, 0
    for i, (key, e) in enumerate(todo):
        if budget_s is not None and time.time() - t0 > budget_s:
            con.commit()
            return len(todo) - i + skipped
        if budget_s is not None and is_file_key(key) and (e.get("size") or 0) - ((cached.get(key) or {}).get("off") or 0) > INLINE_MAX_BYTES:
            skipped += 1
            continue
        agent = e["agent"]
        row = dict(cached.get(key) or new_row(key, agent))
        if row.get("v") != V:
            row = new_row(key, agent)
        if is_file_key(key) and row["off"]:
            row["prompts"] = (con.execute("SELECT prompts FROM sess WHERE key=?", (key,)).fetchone() or {"prompts": ""})["prompts"] or ""
        try:
            if E.get(agent).supports("history_read"):  # a store of its own kind (Gemini CLI's JSON files)
                E.get(agent).history_read(key, row)
            elif is_file_key(key):  # JSON-lines transcripts its adapter reads (Claude Code, Codex, pi)
                read_file(key, agent, row)
            else:
                read_store(agent, key, row)
                row["mtime"] = e.get("mtime") or 0
        except OSError as ex:
            D.debug(f"history {key}", ex)
            continue
        except Exception as ex:  # one odd transcript must not stop the rest
            D.debug(f"history {key}", ex)
            row.update(mtime=e.get("mtime") or 0, size=e.get("size") or 0)
        save(con, row)
        n += 1
        if n % 50 == 0:
            con.commit()
            if on_progress:
                on_progress(i + 1, len(todo))
    # rows of sessions no longer on disk
    keep = {k for k, _ in wanted(idx)}
    gone = [k for k in cached if k not in keep]
    for i in range(0, len(gone), 500):
        con.executemany("DELETE FROM sess WHERE key=?", [(k,) for k in gone[i:i + 500]])
    con.commit()
    return skipped


# ---- background refresh ------------------------------------------------------------------------

def progress_path():
    return os.path.join(D.DISPATCH_DIR, "session-history-progress.json")


def read_progress():
    try:
        with open(progress_path(), encoding="utf-8") as f:
            p = json.load(f)
        if p.get("state") == "running" and not D.P.pid_alive(p.get("pid")):
            p["state"] = "interrupted"
        return p
    except (OSError, ValueError):
        return {}


def write_progress(rec):
    try:
        tmp = f"{progress_path()}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(rec, f)
        D.P.replace_retry(tmp, progress_path())
    except OSError:
        pass


def refresh_all():
    """The background run: the transcript index, then every history row. One at a time (a lock file)."""
    import fcntl
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    lock = open(os.path.join(D.DISPATCH_DIR, LOCK_NAME), "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        lock.close()
        return {"ok": True, "running": True}
    try:
        started = time.time()
        write_progress({"state": "running", "pid": os.getpid(), "done": 0, "total": 0, "started_at": started})
        idx = D.refresh_index()
        con = connect()
        try:
            update(con, idx, on_progress=lambda done, total: write_progress({"state": "running", "pid": os.getpid(), "done": done, "total": total, "started_at": started}))
        finally:
            con.close()
        write_progress({"state": "done", "pid": os.getpid(), "finished_at": time.time(), "started_at": started})
        return {"ok": True, "seconds": round(time.time() - started, 1)}
    finally:
        lock.close()


def start_refresh():
    """Start refresh_all in a process of its own unless one runs (or ran a moment ago)."""
    p = read_progress()
    if p.get("state") == "running":
        return True
    if p.get("state") == "done" and time.time() - (p.get("finished_at") or 0) < STALE_S:
        return False
    import subprocess
    try:
        D.P.spawn_detached([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), "sessions", "history", "--refresh", "--json"],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        write_progress({"state": "running", "pid": 0, "done": 0, "total": 0, "started_at": time.time()})
        return True
    except OSError as ex:
        D.debug("history refresh", ex)
        return False


# ---- folders and projects ----------------------------------------------------------------------

_ROOTS = {}
_WT_PATTERNS = (re.compile(r"^(.+?)/\.claude/worktrees/[^/]+"), re.compile(r"^(.+?)\.worktrees/[^/]+"),
                re.compile(r"^(.+?)-worktrees/[^/]+"), re.compile(r"^(.+?)-wt/[^/]+"))


def project_root(cwd):
    """The repository a folder belongs to (a linked worktree counts as its main repository's), else the folder. A
    folder that is gone is matched by the usual worktree spellings (<repo>/.claude/worktrees/x, <repo>.worktrees/x)."""
    if not cwd:
        return ""
    cwd = cwd.rstrip("/") or "/"
    if cwd in _ROOTS:
        return _ROOTS[cwd]
    found = ""
    probe = cwd
    if not os.path.isdir(probe):
        for rx in _WT_PATTERNS:
            m = rx.match(cwd)
            if m and os.path.isdir(m.group(1)):
                probe = m.group(1)
                break
    if os.path.isdir(probe) and probe != D.HOME and probe != "/":
        d = probe
        while d and d != "/" and d != D.HOME:
            g = os.path.join(d, ".git")
            if os.path.isdir(g):
                found = d
                break
            if os.path.isfile(g):
                try:
                    with open(g, encoding="utf-8") as f:
                        line = f.readline().strip()
                    gd = line.split(":", 1)[1].strip() if line.startswith("gitdir:") else ""
                    gd = gd if os.path.isabs(gd) else os.path.normpath(os.path.join(d, gd))
                    m = re.match(r"^(.+?)/\.git/worktrees/[^/]+/?$", gd)
                    found = m.group(1) if m else d
                except OSError:
                    found = d
                break
            d = os.path.dirname(d)
    if not found:
        for rx in _WT_PATTERNS:
            m = rx.match(cwd)
            if m:
                found = m.group(1)
                break
    _ROOTS[cwd] = found or cwd
    return _ROOTS[cwd]


def project_label(root):
    if not root or root == "/":
        return "/"
    if root == D.HOME:
        return "Home"
    return os.path.basename(root.rstrip("/")) or root


def real(p):
    try:
        return os.path.realpath(p)
    except OSError:
        return p


def under(path, folder):
    return path == folder or path.startswith(folder.rstrip("/") + "/")


# ---- the Agents window's own sessions ------------------------------------------------------------

def window_sessions(con, user_data):
    """{"<agent>:<agent's own id>": {"provider", "id", "title"}} for the sessions Dispatch IDE's Agents window lists:
    the catalog of `user_data` (the window that asks) and of Dispatch IDE's other profiles on this Mac."""
    import ide_sessions as S
    dirs = [user_data] if user_data else []
    dirs += [ud for name, ud in S.apps() if name != "VS Code" and ud not in dirs]
    known = {r["host_id"]: r["sid"] for r in con.execute("SELECT host_id, sid FROM native")}
    out = {}
    for ud in dirs:
        db = S.db_path(ud)
        if not db:
            continue
        for c in S.read_catalog(db):
            # archived ones are not listed. External ones (found in ~/.claude or ~/.codex) are listed only for the
            # range the person picked: they are a hint here, the window checks its own list before it says so.
            if c.get("archived"):
                continue
            provider, hid = c["provider"], c["id"]
            agent = _window_agent(provider)
            if not agent:
                continue
            sid = hid if c.get("external") else known.get(hid)
            if sid is None:
                sid = S.native_id(ud, hid) or ""
                known[hid] = sid
                con.execute("INSERT OR REPLACE INTO native(host_id, sid) VALUES(?, ?)", (hid, sid))
            out.setdefault(f"{agent}:{sid or hid}", {"provider": provider, "id": hid, "title": c.get("title") or ""})
    con.commit()
    return out


# ---- the last words of one conversation (the bell) ---------------------------------------------

LAST_WORDS_TAIL = 1 << 20


def session_ref(session, user_data=""):
    """(agent, the agent's own id) for the bell's session key: the Agents window's resource
    (agent-host-<provider>:/<host id>, its own id looked up in the window's session data) or <agent>:<id>."""
    import ide_sessions as S
    scheme, _, rest = (session or "").partition(":")
    hid = rest.lstrip("/")
    if not scheme or not hid:
        return "", ""
    if scheme.startswith("agent-host-"):
        provider = scheme[len("agent-host-"):]
        agent = _window_agent(provider, "")
        if not agent:
            return "", ""
        dirs = [user_data] if user_data else []
        dirs += [ud for _, ud in S.apps() if ud not in dirs]
        for ud in dirs:
            sid = S.native_id(ud, hid)
            if sid:
                return agent, sid
        return agent, ""
    agent = _window_agent(scheme, scheme)
    return agent, hid


def transcript_of(agent, sid):
    """Where one conversation is kept: a transcript path, `<agent>:<id>` for a database agent, or ""."""
    if not sid or not re.fullmatch(r"[\w.-]{4,120}", sid):
        return ""
    eng = E.get(agent)
    if eng.database:
        return f"{agent}:{sid}"  # its conversations are rows in a database (OpenCode, ZCode, Hermes)
    hits = eng.transcript_of(sid, D.HOME)
    if hits is None:
        hits = [k for k, e in D.load_index().items() if e.get("session_id") == sid and e.get("agent") == agent and is_file_key(k)]
    hits = [h for h in hits if os.path.isfile(h)]
    return max(hits, key=os.path.getmtime) if hits else ""


def _last_line(text):
    """The last sentence a person reads of a reply: its last line with words in it (not a fence or a table rule)."""
    for line in reversed(str(text or "").splitlines()):
        t = clean(line.strip().strip("#>*-` ").strip())
        if t and not set(t) <= set("|:-= "):
            return t
    return ""


def last_words(session, user_data=""):
    """The agent's last reply of one conversation, reduced to its last line; "" when it cannot tell. Reads only
    the end of the transcript, so it is cheap enough to run when a session finishes."""
    agent, sid = session_ref(session, user_data)
    key = transcript_of(agent, sid)
    if not key:
        return ""
    try:
        if is_file_key(key):
            with open(key, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - LAST_WORDS_TAIL))
                buf = f.read()
            for line in reversed(buf.split(b"\n")):
                if not line.startswith(b"{") or (b'"assistant"' not in line and b'"user"' not in line) or len(line) > BIG_LINE:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                got = message_of(agent, d)
                if not got:
                    continue
                if got[0] != "agent":
                    return ""
                raw = _blocks_text((E.get(agent).history_message(d) or ("", ""))[1])
                return _last_line(raw) or got[1]
            return ""
        if agent in D.SQLITE_STORES:
            rows = D.zcode_query("select json_extract(m.data,'$.role') role, json_extract(p.data,'$.text') text from part p join message m on m.id=p.message_id "
                                 "where p.session_id=? and json_extract(p.data,'$.type')='text' and coalesce(json_extract(p.data,'$.synthetic'),0)=0 "
                                 "order by p.time_created desc limit 1", (sid,), agent=agent)
            return _last_line(rows[0]["text"]) if rows and rows[0]["role"] == "assistant" else ""
        row = new_row(key, agent)
        read_store(agent, key, row)
        return row["last_text"] if row.get("last_role") == "agent" else ""
    except Exception as ex:  # the bell must never fail on a transcript
        D.debug(f"last words {session}", ex)
        return ""


# ---- resuming ----------------------------------------------------------------------------------

_PROGRAMS = {}


def program(agent):
    """The agent's program on this Mac (its full path, so a terminal with a shorter search path finds it), or ""."""
    if agent not in _PROGRAMS:
        path = ""
        eng = E.find(agent)
        if eng:
            import agents_catalog as AC
            entry = AC.BY_ID.get(eng.id)
            try:
                path = AC.find(entry) if entry else ""
            except Exception:
                path = ""
        _PROGRAMS[agent] = path or ""
    return _PROGRAMS[agent]


def resume_of(key, e, folder_ok):
    """What continuing it runs: {ok, command (typed into a terminal in `cwd`), cwd} or {ok: False, why}."""
    agent, sid, cwd = e["agent"], e["session_id"], e.get("cwd") or ""
    eng = E.get(agent)
    try:
        args, env = eng.resume(sid, key)
    except E.Unsupported as why:
        if eng.desktop_app:  # its conversations continue only in its own app
            return {"ok": False, "why": str(why)}
        args, env = None, {}
        unknown = str(why)
    if not folder_ok:
        return {"ok": False, "why": "The folder this session worked in is gone, so it can't be continued here."}
    exe = program(agent)
    if not exe:
        return {"ok": False, "why": f"{eng.name} is not installed on this Mac."}
    if args is None:
        return {"ok": False, "why": unknown}
    cmd = " ".join([f"{k}={shlex.quote(v)}" for k, v in env.items()] + [shlex.quote(exe)] + [shlex.quote(a) for a in args])
    return {"ok": True, "command": cmd, "cwd": cwd}


# ---- the list ----------------------------------------------------------------------------------

def _ts(iso):
    if not iso:
        return 0
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0


def subagent_counts(idx):
    counts = {}
    for key, e in idx.items():  # sub-agent transcripts the index found under their parent (Claude Code)
        if e.get("subagent") and e.get("parent"):
            k = f"{e['agent']}:{e['parent']}"
            counts[k] = counts.get(k, 0) + 1
    for agent in D.SQLITE_STORES:  # child sessions in OpenCode's tables
        for r in D.zcode_query("select parent_id, count(*) n from session where parent_id is not null group by parent_id", agent=agent):
            counts[f"{agent}:{r['parent_id']}"] = r["n"]
    for eng in E.known():  # a store of its own (Hermes' delegations)
        counts.update({f"{eng.agent}:{sid}": n for sid, n in eng.child_counts().items()})
    return counts


def best_model(e, c):
    m = (c or {}).get("last_model") or ""
    if m:
        return m
    models = {k: v for k, v in (e.get("models") or {}).items() if k and not k.startswith("<")}
    return max(models, key=models.get) if models else ""


def title_of(e, c, win, own_titles):
    for t in ((win or {}).get("title"), e.get("title"), own_titles.get(e["agent"], {}).get(e["session_id"])):
        t = clean(t or "")
        if t:
            return t[:200]
    for t in (e.get("first_prompt"), (c or {}).get("last_text")):
        t = clean(t or "")
        if t:
            return t[:120]
    return ""


def rows_of(idx, cached, win, counts):
    from activity import own_titles
    try:
        ctitles = own_titles(D.HOME)
    except Exception:
        ctitles = {}
    children = {}  # helper threads of the engines that list them (Codex), by the thread that started them
    for key, c in cached.items():
        if E.get(c.get("agent")).lists_subthreads and c.get("parent"):
            children[(c["agent"], c["parent"])] = children.get((c["agent"], c["parent"]), 0) + 1
    rows = []
    for key, e in idx.items():
        if not e.get("session_id") or e.get("subagent"):
            continue
        agent = e["agent"]
        c = cached.get(key) or {}
        skey = f"{agent}:{e['session_id']}"
        w = win.get(skey)
        cwd = e.get("cwd") or ""
        folder_ok = bool(cwd) and os.path.isdir(cwd)
        root = project_root(cwd)
        name, icon = E.get(agent).name, E.get(agent).icon
        last_text = c.get("last_text") or ""
        preview = {"role": c.get("last_role") or "user", "text": last_text} if last_text else (
            {"role": "user", "text": clean(e.get("first_prompt") or "")[:PREVIEW_CAP]} if e.get("first_prompt") else None)
        if preview and not preview["text"]:
            preview = None
        subs = counts.get(skey, 0) + children.get((agent, e["session_id"]), 0)
        rows.append({
            "key": key, "agent": agent, "agent_name": name, "icon": icon, "session_id": e["session_id"],
            "title": title_of(e, c, w, ctitles), "preview": preview, "first_prompt": clean(e.get("first_prompt") or "")[:PREVIEW_CAP],
            "messages": int(e.get("user_msgs") or 0) + int(e.get("assistant_msgs") or 0), "typed": int(c.get("n_prompts") or 0),
            "subagents": subs, "last_at": e.get("mtime") or _ts(e.get("last_ts")), "created_at": _ts(e.get("first_ts")) or e.get("mtime") or 0,
            "model": best_model(e, c), "cwd": cwd, "folder_exists": folder_ok, "project_root": root, "project": project_label(root),
            "branch": e.get("branch") or "", "resume": resume_of(key, e, folder_ok),
            "window": {"provider": w["provider"], "id": w["id"]} if w else None, "host": "local",
            # nothing a person would call a conversation: no messages, or only commands (/login) and no reply
            "empty": not (e.get("user_msgs") or e.get("assistant_msgs")) or not (e.get("first_prompt") or e.get("title") or c.get("n_prompts") or last_text)
            or (bool(c) and not c.get("n_prompts") and not last_text and not e.get("title")),
        })
    return rows


def search(con, rows, query):
    """Rows matching every word of `query`: in their title, the message shown, folder, branch, model or agent, or in
    anything the person typed in them (kept in the cache). Each kept row says where it matched; a match in typed
    text brings the line it is in (`snippet`)."""
    words = [w.lower() for w in query.split() if w.strip()]
    if not words:
        return rows
    typed = [{r["key"]: r["s"] for r in con.execute(
        "SELECT key, substr(prompts, max(1, instr(lower(prompts), ?) - 40), 160) s FROM sess WHERE instr(lower(prompts), ?) > 0", (w, w))}
        for w in words]
    out = []
    for r in rows:
        fields = " ".join([r["title"], (r["preview"] or {}).get("text", ""), r["first_prompt"], r["cwd"], r["branch"], r["model"], r["agent_name"], r["project"]]).lower()
        if all(w in fields for w in words):
            out.append(dict(r, matches="title" if all(w in r["title"].lower() for w in words) else "details"))
        elif all(w in fields or r["key"] in t for w, t in zip(words, typed)):
            snip = next((t[r["key"]] for t in typed if r["key"] in t), "")
            out.append(dict(r, matches="text", snippet=_SPACES.sub(" ", snip).strip()))
    return out


def history(scope="all", folder="", query="", agents=None, sort="updated", limit=DEFAULT_LIMIT, show_empty=False, user_data="", refresh=True):
    idx_exists = os.path.exists(D.INDEX_FILE)
    indexing = None
    if not idx_exists:
        indexing = D.index_ensure() or D.index_progress()
    idx = D.load_index()
    con = connect()
    try:
        left = update(con, idx, budget_s=INLINE_BUDGET_S) if idx else 0
        refreshing = False
        if refresh and idx_exists:
            try:
                age = time.time() - os.stat(D.INDEX_FILE).st_mtime
            except OSError:
                age = STALE_S + 1
            if left or age > STALE_S:
                refreshing = start_refresh()
        cached = light_rows(con)
        try:
            win = window_sessions(con, user_data)
        except Exception as ex:
            D.debug("history window", ex)
            win = {}
        rows = rows_of(idx, cached, win, subagent_counts(idx))
        everything = len(rows)
        if not show_empty:
            rows = [r for r in rows if not r["empty"]]
        folder = (folder or "").rstrip("/")
        project = {"root": "", "name": ""}
        if folder:
            root = project_root(folder)
            project = {"root": root, "name": project_label(root)}
        if scope == "workspace" and folder:
            f = real(folder)
            rows = [r for r in rows if r["cwd"] and (under(r["cwd"].rstrip("/"), folder) or under(real(r["cwd"]), f))]
        elif scope == "project" and folder:
            # the project's folder as the window names it and as the agent recorded it: one may go through a
            # symlink the other does not (/tmp and /private/tmp, a folder linked from another disk; task-ez3yp)
            root, rroot = project["root"], real(project["root"])
            rows = [r for r in rows if r["project_root"] in (root, rroot) or real(r["project_root"]) == rroot
                    or (r["cwd"] and (under(r["cwd"], root) or under(real(r["cwd"]), rroot)))]
        else:
            scope = "all" if scope not in ("workspace", "project") or not folder else scope
        total = len(rows)
        by_agent = {}
        for r in rows:
            by_agent[r["agent"]] = by_agent.get(r["agent"], 0) + 1
        if agents:
            rows = [r for r in rows if r["agent"] in agents]
        if query:
            rows = search(con, rows, query)
        key = "created_at" if sort == "created" else "last_at"
        rows.sort(key=lambda r: -(r[key] or 0))
        matched = len(rows)
        shown = rows[:max(1, int(limit or DEFAULT_LIMIT))]
        groups, order = {}, []
        for r in shown:
            g = groups.get(r["project_root"])
            if not g:
                g = groups[r["project_root"]] = {"project": r["project"], "root": r["project_root"], "count": 0, "sessions": []}
                order.append(g)
            g["sessions"].append(r)
        for r in rows:  # how many the whole group has, shown or not
            g = groups.get(r["project_root"])
            if g:
                g["count"] += 1
        names = {}
        for g in order:
            names.setdefault(g["project"], []).append(g)
        for same in names.values():  # two folders with one name: add the first folder above them that tells them apart
            if len(same) > 1:
                parts = [g["root"].rstrip("/").split("/")[:-1] for g in same]
                at = lambda p, k: p[-k] if len(p) >= k else ""  # noqa: E731
                tags = []
                for i, p in enumerate(parts):
                    k = next((k for k in range(1, len(p) + 1) if at(p, k) and all(at(q, k) != at(p, k) for j, q in enumerate(parts) if j != i)), 1)
                    tags.append(at(p, k))
                for g, tag in zip(same, tags):
                    if tag:
                        g["project"] = f"{g['project']} · {tag}"
        if not indexing:
            p = read_progress()
            if p.get("state") == "running" and p.get("total"):
                indexing = {"state": "running", "done": p.get("done", 0), "total": p.get("total", 0)}
        return {"ok": True, "scope": scope, "folder": folder, "project": project, "total": total, "everything": everything,
                "matched": matched, "shown": len(shown), "sort": sort, "query": query,
                "agents": [{"id": a, "name": E.get(a).name, "icon": E.get(a).icon, "count": n} for a, n in sorted(by_agent.items(), key=lambda kv: -kv[1])],
                "refreshing": bool(refreshing), "indexing": indexing if indexing and indexing.get("state") == "running" else None,
                "groups": order}
    finally:
        con.close()


def machines_list():
    rows = [{"id": "local", "name": D.local_host_name() or "This Mac", "local": True}]
    for h in D.hosts():
        if isinstance(h, dict) and h.get("id"):
            rows.append({"id": h["id"], "name": h.get("name") or h["id"], "local": False})
    return rows


def remote_args(a):
    args = ["sessions", "history", "--scope", "all", "--sort", a.sort, "--limit", str(a.limit)]
    if a.query:
        args += ["--query", a.query]
    if a.agents:
        args += ["--agents", a.agents]
    if a.show_empty:
        args.append("--show-empty")
    return args


def on_machine(a, mid):
    h = next((x for x in D.hosts() if isinstance(x, dict) and x.get("id") == mid), None)
    if not h:
        return {"ok": False, "error": "That Mac is not in your list of Macs any more."}
    name = h.get("name") or mid
    # its history can take a while to read there (a first reading, a busy Mac): the page waits 8 s, the ssh goes on for
    # 45, and until it answers the page hears "still asking" and asks again
    ans = D.remote_dispatch(h, remote_args(a), 30, timeout=45, background=True, wait=8)
    if not isinstance(ans, dict) or not ans.get("ok"):
        if not isinstance(ans, dict) and D.remote_pending(h, remote_args(a)):
            return {"ok": False, "pending": True, "error": f"Asking {name} for its sessions…"}
        return {"ok": False, "error": f"{name} did not answer. It may be asleep, offline, or have an older Dispatch."}
    for g in ans.get("groups") or []:
        for r in g.get("sessions") or []:
            r["host"] = mid
            r["window"] = None
    ans["scope"] = "all"
    return ans


def command(a):
    if getattr(a, "refresh", False):
        return refresh_all()
    mid = getattr(a, "machine", "") or "local"
    agents = {x.strip() for x in (a.agents or "").split(",") if x.strip()} or None
    if mid != "local":
        res = on_machine(a, mid)
    else:
        res = history(scope=a.scope, folder=a.folder, query=a.query or "", agents=agents, sort=a.sort, limit=a.limit,
                      show_empty=a.show_empty, user_data=a.user_data or "", refresh=not a.no_refresh)
    res["machine"] = mid
    res["machines"] = machines_list()
    return res


def add_arguments(s):
    s.add_argument("--scope", choices=["all", "project", "workspace"], default="all", help="history: workspace = this folder, project = its repository with its worktrees")
    s.add_argument("--folder", default="", help="history: the folder the window is on")
    s.add_argument("--query", default="", help="history: words to look for (title, last message, folder, model, what you typed)")
    s.add_argument("--agents", default="", help="history: only these agents (claude-code,codex,…)")
    s.add_argument("--sort", choices=["updated", "created"], default="updated")
    s.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    s.add_argument("--show-empty", action="store_true", help="history: also sessions with nothing typed in them")
    s.add_argument("--machine", default="", help="history: another Mac's id (hosts.json)")
    s.add_argument("--user-data", default="", help="history: the Agents window's user data folder (marks the sessions it already has)")
    s.add_argument("--no-refresh", action="store_true", help="history: answer from the cache without starting a background refresh")
    s.add_argument("--refresh", action="store_true", help="history: bring the index and the cache up to date, then answer")


def text(res):
    if not res.get("ok"):
        print(res.get("error") or _t("No session history came back", "没有拿到会话历史"))
        return
    print(_t(f"{res['shown']} / {res['matched']} sessions ({res['total']} in this range)", f"{res['shown']} / {res['matched']} 个会话（这个范围共 {res['total']} 个）"))
    for g in res["groups"]:
        print(f"\n{g['project']}  {g['count']}")
        for r in g["sessions"]:
            print(f"  {D.ago(r['last_at']):<5} {r['agent_name']:<12} {r['messages']:>5} " + _t("msgs", "条") + f"  {r['title'][:70]}")
