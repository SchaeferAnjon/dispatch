# -*- coding: utf-8 -*-
"""What the Assistant sees and relays across Macs (`dispatch assistant overview | turns | send`).

  overview   every Mac Dispatch knows and its running sessions: agent, project, what each is doing now
             in plain words, working / waiting / idle, the task it is on, a link that opens it, and a
             feed of what finished, what is stuck and what waits for the person. The Assistant page in
             Dispatch IDE draws this; the Assistant itself reads it as JSON.
  turns      the last turns of one session (this Mac, or `--host` another one).
  send       a message into a session (this Mac, or `--host` another one), labelled "From Assistant".
             Into an Agents-window session it goes through that editor's Agent Host (the same socket
             `dispatch ide archive-session` uses); into a chat Dispatch holds it goes through chatd; a
             session that lives in a terminal cannot be typed into, and says so.

The label is the first line of the message, FROM_ASSISTANT. It is plain text on purpose: the agent reads
it, the Agents window draws it as a small "From Assistant" mark, and the phone shows it as written.
"""
import sys

sys.dont_write_bytecode = True

import base64
import json
import os
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

FROM_ASSISTANT = "[From Assistant]"
TAIL_BYTES = 300_000
FEED_WINDOW_S = 6 * 3600
FEED_MAX = 14
STATUS_LABEL = {"working": "Working", "waiting": "Waiting for you", "idle": "Idle"}
PEER_TTL = 5

D = None


def agent_name(agent):
    import engines
    eng = engines.find(agent)
    return eng.name if eng else (agent or "Agent").replace("-", " ").title()


# ---- plain words ------------------------------------------------------------------------------------

def _name(path):
    return os.path.basename(str(path or "").rstrip("/")) or str(path or "")


def _clip(text, n):
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[:n - 1].rstrip() + "..."


def tool_phrase(name, inp):
    """What a tool call means, in words a person reads: "Editing report.py", "Running the tests"."""
    inp = inp if isinstance(inp, dict) else {}
    n = (name or "").lower()
    path = inp.get("file_path") or inp.get("path") or inp.get("filePath") or ""
    if n in ("edit", "multiedit", "write", "notebookedit", "apply_patch", "str_replace_editor"):
        return f"Editing {_name(path)}" if path else "Editing files"
    if n in ("read", "view"):
        return f"Reading {_name(path)}" if path else "Reading files"
    if n in ("grep", "glob", "ls", "find", "search", "codesearch"):
        return "Searching the code"
    if n in ("bash", "shell", "exec_command", "local_shell", "run_command", "execute"):
        cmd = inp.get("command") or inp.get("cmd") or ""
        if isinstance(cmd, list):
            cmd = " ".join(str(c) for c in cmd)
        cmd = str(cmd)
        low = cmd.lower()
        if re.search(r"\b(pytest|unittest|npm (run )?test|vitest|jest|cargo test|go test)\b", low):
            return "Running the tests"
        if re.search(r"\bgit (commit|push|pull|merge|rebase)\b", low):
            return "Saving work with git"
        if re.search(r"\b(build|compile|tsc|make)\b", low):
            return "Building"
        d = inp.get("description")
        return _clip(d, 70) if d else ("Running " + _clip(cmd, 50) if cmd else "Running a command")
    if n in ("task", "agent"):
        return "Handing work to a helper agent"
    if n in ("sendmessage", "taskoutput", "taskstop"):
        return "Following a helper agent"
    if n in ("skill",):
        return "Reading its instructions"
    if n.startswith("mcp__"):
        # mcp__<server>__<tool>: the tool's own words ("Using browser click")
        tool = name.split("__")[-1].replace("_", " ").replace("-", " ").strip()
        return f"Using {tool}" if tool else "Working"
    if n in ("webfetch", "websearch", "web_search"):
        return "Looking something up online"
    if n in ("todowrite", "update_plan"):
        return "Updating its plan"
    return f"Using {name}" if name else "Working"


def tail_facts(path, agent):
    """(what it is doing, what it last said) from the end of an engine's transcript file (its adapter's record_steps
    reads each record). Either may be ''."""
    import engines
    eng = engines.get(agent)
    try:
        with open(path, "rb") as fh:
            fh.seek(max(0, os.path.getsize(path) - TAIL_BYTES))
            tail = fh.read().decode("utf-8", "replace")
    except OSError:
        return "", ""
    doing = said = ""
    for line in reversed(tail.splitlines()):
        if not line.startswith("{"):
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        for step in reversed(eng.record_steps(d)):
            if step[0] == "tool" and not doing:
                doing = tool_phrase(step[1], step[2])
            elif step[0] == "text" and not said and step[1].strip():
                import assistant as A
                said = _clip(A.plain(step[1]), 160)
        if doing and said:
            break
    return doing, said


# ---- this Mac ---------------------------------------------------------------------------------------

def status_of(row):
    if row.get("attention") == "input":
        return "waiting"
    return "working" if row.get("state") == "working" else "idle"


def session_key(row):
    """What `turns` and `send` take: the Agents window's own address for its sessions, `agent:id` for the rest
    (a bare process with no record of its own stands for the transcript it most likely writes)."""
    if row.get("ide_key"):
        return row["ide_key"]
    sid = row.get("session_id") or ""
    if sid.startswith("pid-") and row.get("probable_session_id"):
        sid = row["probable_session_id"]
    return f"{row.get('agent')}:{sid}"


def can_send(row):
    """(bool, why not). The Agents window and chats Dispatch holds can be typed into; a terminal cannot."""
    if row.get("source") == "ide":
        return True, ""
    import engines
    if not engines.get(row.get("agent") or "").runnable:
        return False, "Dispatch cannot send messages to this kind of agent."
    if row.get("source_kind") == "terminal":
        return False, "This session lives in a terminal. Dispatch can read it, but not type into it."
    return True, ""


def session_link(row):
    if row.get("source") != "ide" or ":" not in (row.get("ide_key") or ""):
        return None
    provider, rest = row["ide_key"].split(":", 1)
    return f"agent-host-session://{provider}/{rest.lstrip('/')}"


def _index_by_session(index):
    out = {}
    for path, e in (index or {}).items():
        sid = e.get("session_id")
        if sid and not e.get("subagent"):
            if sid not in out or (e.get("mtime") or 0) > (out[sid][1].get("mtime") or 0):
                out[sid] = (path, e)
    return out


def _transcript_of(row, by_sid):
    for sid in (row.get("native_session_id"), row.get("session_id"), row.get("probable_session_id")):
        if sid and sid in by_sid:
            return by_sid[sid]
    return None


def _task_of(row, issues, TV):
    if not issues:
        return None
    sids = [s for s in (row.get("session_id"), row.get("native_session_id"), row.get("probable_session_id")) if s and not str(s).startswith("pid-")]
    if not sids:
        return None
    try:
        rows = [TV.task_row(t) for t in TV.select(issues, session=sids)]
    except Exception as e:
        D.debug("assistant_live.task_of", e)
        return None
    rows = [r for r in rows if r["status"] != "done"]
    if not rows:
        return None
    rows.sort(key=lambda r: ({"in_progress": 0, "waiting": 1, "todo": 2}.get(r["status"], 3), -TV.last_touched(r)))
    t = rows[0]
    return {"id": t["id"], "title": t["title"], "status": t["status"]}


TEMP_PREFIXES = ("/private/tmp/", "/tmp/", "/private/var/folders/", "/var/folders/")


def _temp(path, projects=()):
    """A scratch folder (/tmp and the like) that is not one of the person's projects."""
    p = str(path or "").rstrip("/")
    if not p.startswith(TEMP_PREFIXES):
        return False
    real = os.path.realpath(p)
    return not any(x == d or x.startswith(d + "/") for d in projects for x in (p, real))


def project_dirs():
    """The registered projects' folders on this Mac (a project may live under /tmp, a test's projects do)."""
    try:
        PV = D._mod("projects_view")
        PV.D = D
        dirs = [str(r["dir"]).rstrip("/") for r in PV.registry(resolve_dirs=False) if r.get("dir")]
        return dirs + [os.path.realpath(d) for d in dirs]
    except Exception as e:
        D.debug("assistant_live.projects", e)
        return []


def waiting_phrases(W):
    """{agents-window key: what it waits for}, from Waiting for you. Empty when that scan fails."""
    try:
        W.D = D
        items = W.collect().get("items", [])
    except Exception as e:
        D.debug("assistant_live.waiting", e)
        return {}
    return {it.get("resource"): it.get("phrase") for it in items if it.get("resource") and it.get("kind") in ("approve", "decide")}


def row_from_live(s, host=None, idx=None, by_sid=None, issues=None, TV=None, phrases=None, now=None):
    """One overview row from a `dispatch sessions` row; with the transcript index and the board it also says
    what the session is doing and which task it is on."""
    now = now or time.time()
    status = status_of(s)
    send_ok, send_why = can_send(s)
    found = _transcript_of(s, by_sid or {})
    import engines
    tails = found and engines.get(found[1].get("agent") or "").supports("record_steps")
    doing, said = tail_facts(found[0], found[1].get("agent") or s.get("agent")) if tails else ("", "")
    if status == "waiting":
        doing = (phrases or {}).get(s.get("ide_key")) or "Waiting for you to answer"
    elif status == "working":
        doing = s.get("activity") or doing or "Working"
    else:
        doing = ""
    if not said and status != "working" and not engines.get(s.get("agent") or "").supports("record_steps") and idx is not None:
        said = _last_said(session_key(s))  # OpenCode and the rest keep no transcript file to tail
    title = (s.get("title") or (found[1].get("title") if found else "") or "").strip()
    host = host or {"id": s.get("host") or "local", "name": s.get("host_name") or ""}
    return {
        "key": session_key(s), "id": s.get("session_id") or "", "agent": s.get("agent") or "", "agent_name": agent_name(s.get("agent")),
        "title": title, "project": s.get("project") or _name(s.get("cwd")), "cwd": s.get("cwd") or "",
        "host": host["id"], "host_name": host["name"],
        "status": status, "status_label": STATUS_LABEL[status], "doing": doing, "said": said if status != "working" else "",
        "last_at": s.get("last_at") or 0, "source": s.get("source_app") or s.get("source_kind") or "",
        "where": "window" if s.get("source") == "ide" else "terminal" if s.get("source_kind") == "terminal" else "app",
        "task": _task_of(s, issues, TV) if TV else None, "link": session_link(s),
        "can_send": send_ok, "cannot_send": send_why,
        "failed": s.get("attention") == "failure",
    }


def own_rows(now=None, assistant_folder=None):
    """This Mac's running sessions as overview rows, newest first (working ones first). The Assistant's own
    session is left out: the page is about the others."""
    now = now or time.time()
    import assistant as A
    TV = D._mod("tasks_view")
    TV.D = D
    W = D._mod("waiting")
    try:
        live = D.live_sessions(local_only=True)
    except Exception as e:
        D.debug("assistant_live.live", e)
        live = []
    folder = (assistant_folder or A.folder()).rstrip("/")
    projects = project_dirs() if any(_temp(s.get("cwd")) for s in live) else []
    live = [s for s in live if s.get("alive", True) and not s.get("archived") and (s.get("host") or "local") == "local"
            and (s.get("cwd") or "").rstrip("/") != folder and not _temp(s.get("cwd"), projects)]
    # a bare process that is another listed session's own process (same transcript) is that session
    known = {s.get("session_id") for s in live if not str(s.get("session_id", "")).startswith("pid-")}
    live = [s for s in live if not (str(s.get("session_id", "")).startswith("pid-") and s.get("probable_session_id") in known)]
    try:
        index = D.load_index()
    except Exception:
        index = {}
    try:
        issues = TV.board_export()
    except Exception as e:
        D.debug("assistant_live.board", e)
        issues = []
    phrases = waiting_phrases(W) if any(status_of(s) == "waiting" for s in live) else {}
    by_sid = _index_by_session(index)
    host = {"id": "local", "name": D.local_host_name()}
    rows = [row_from_live(s, host, index, by_sid, issues, TV, phrases, now) for s in live]
    rows.sort(key=lambda r: ({"waiting": 0, "working": 1, "idle": 2}[r["status"]], -(r["last_at"] or 0)))
    return rows


def peer_rows(h):
    """Another Mac's rows: its own `assistant overview --local` when its dispatch has one, else its plain
    `sessions` list. None when it did not answer."""
    got = D.remote_dispatch(h, ["assistant", "overview", "--local"], PEER_TTL, timeout=2, background=True)
    if isinstance(got, dict) and isinstance(got.get("sessions"), list):
        host = {"id": h["id"], "name": h.get("name") or h["id"]}
        rows = []
        for r in got["sessions"]:
            rows.append(dict(r, host=host["id"], host_name=host["name"]))
        return rows
    plain = D.remote_dispatch(h, ["sessions", "--local"], PEER_TTL, timeout=2, background=True)
    if not isinstance(plain, list):
        return None
    host = {"id": h["id"], "name": h.get("name") or h["id"]}
    return [row_from_live(s, host) for s in plain if isinstance(s, dict) and s.get("alive", True) and (s.get("host") or "local") == "local" and not s.get("remote")]


def counts(rows):
    c = {"working": 0, "waiting": 0, "idle": 0}
    for r in rows:
        c[r["status"]] += 1
    return c


def feed(machines, now=None, window=FEED_WINDOW_S, limit=FEED_MAX):
    """What just happened across the Macs, newest first: a session that finished (with its last words), one
    that is stuck on a question, one that failed."""
    now = now or time.time()
    events = []
    for m in machines:
        for r in m["sessions"]:
            at = r.get("last_at") or 0
            if r["status"] == "waiting":
                kind, text = "waiting", r["doing"] or "Waiting for you"
            elif r.get("failed"):
                kind, text = "failed", "Stopped with an error"
            elif r["status"] == "idle" and at and now - at <= window and (r.get("said") or r.get("title")):
                kind, text = "finished", r.get("said") or r["title"]
            else:
                continue
            events.append({"kind": kind, "at": at, "text": _clip(text, 140), "key": r["key"], "id": r.get("id") or "", "where": r.get("where") or "", "host": r["host"], "host_name": r["host_name"],
                           "project": r["project"], "agent": r["agent"], "agent_name": r["agent_name"], "link": r.get("link")})
    events.sort(key=lambda e: -(e["at"] or 0))
    return events[:limit]


def overview(local_only=False, now=None):
    """{updated_at, machines: [{id, name, local, online, last_seen, counts, sessions}], feed, totals}."""
    now = now or time.time()
    mach = D._mod("machines")
    mach.D = D
    peers = [] if local_only else [h for h in D.hosts() if isinstance(h, dict) and h.get("id")]
    with ThreadPoolExecutor(max_workers=2 + 2 * len(peers)) as pool:
        f_own = pool.submit(own_rows, now)
        f_on = [pool.submit(mach._safe, mach.reachable, h, default=False) for h in peers]
        online = [f.result() for f in f_on]
        f_peer = [pool.submit(mach._safe, peer_rows, h, default=None) if on else None for h, on in zip(peers, online)]
        rows = f_own.result()
        out = [{"id": "local", "name": D.local_host_name(), "local": True, "online": True, "last_seen": now, "counts": counts(rows), "sessions": rows}]
        for h, on, f in zip(peers, online, f_peer):
            prow = f.result() if f is not None else None
            prow = prow or []
            out.append({"id": h["id"], "name": h.get("name") or h["id"], "local": False, "online": bool(on), "last_seen": mach.last_seen(h, on, now),
                        "counts": counts(prow), "sessions": prow})
    totals = {k: sum(m["counts"][k] for m in out) for k in ("working", "waiting", "idle")}
    totals["sessions"] = sum(totals.values())
    totals["machines"] = len(out)
    return {"updated_at": now, "machines": out, "feed": feed(out, now), "totals": totals}


# ---- reading a session --------------------------------------------------------------------------------

def _last_said(key):
    """The last thing a session said, from Dispatch's reader of its store; '' when it cannot be read."""
    try:
        d = D.read_session_detail(_ref_of(key))
    except Exception as e:
        D.debug("assistant_live.last_said", e)
        return ""
    for m in reversed(d.get("messages", [])):
        if m.get("role") == "assistant" and (m.get("text") or "").strip():
            import assistant as A
            return _clip(A.plain(m["text"]), 160)
    return ""


def _ref_of(key):
    """The transcript index entry of a session key (`agent:id`, an Agents-window address, or a bare id)."""
    import ide_sessions as I
    k = (key or "").strip()
    if not k:
        raise ValueError("Which session? Give its key from `dispatch assistant overview`.")
    native = None
    try:
        native = I.transcript_key(k) if ":/" in k else None
    except Exception:
        native = None
    idx = D.load_index()
    for cand in [native, k]:
        if not cand:
            continue
        if ":/" in cand and not cand.startswith("agent-host"):
            cand = cand.split(":/", 1)[1]
        refs = D.resolve(idx, cand) or D.resolve(D.refresh_index(), cand)
        if refs:
            return refs[0]
    raise ValueError(f"No session {k} on this Mac.")


def turns(key, n=6):
    """The last `n` exchanges of a session, oldest first: {session, turns: [{role, text, at, from_assistant}]}."""
    ref = _ref_of(key)
    d = D.read_session_detail(ref)
    msgs = [m for m in d.get("messages", []) if m.get("role") in ("user", "assistant") and (m.get("text") or "").strip()]
    rows = []
    for m in msgs[-max(1, n) * 2:]:
        text = m["text"].strip()
        mine = text.startswith(FROM_ASSISTANT)
        if mine:
            text = text[len(FROM_ASSISTANT):].lstrip("\n ")
        rows.append({"role": m["role"], "text": _clip_block(text, 1500), "at": m.get("ts") or "", "from_assistant": mine})
    meta = d.get("meta") or {}
    return {"session": {"key": key, "agent": meta.get("agent"), "agent_name": agent_name(meta.get("agent")), "title": meta.get("title") or "",
                        "project": meta.get("project") or "", "cwd": meta.get("cwd") or ""},
            "turns": rows}


def _clip_block(text, n):
    text = str(text or "").strip()
    return text if len(text) <= n else text[:n - 1].rstrip() + "..."


# ---- sending ------------------------------------------------------------------------------------------

def labelled(text):
    """The message as the session receives it: the label line, then the words."""
    text = str(text or "").strip()
    if not text:
        raise ValueError("Nothing to send.")
    return text if text.startswith(FROM_ASSISTANT) else f"{FROM_ASSISTANT}\n{text}"


def _chat_uri(session_uri):
    enc = base64.urlsafe_b64encode(session_uri.encode()).decode().rstrip("=")
    return f"ahp-chat://default/{enc}"


DELEGATION_META = "vscode.chat.delegation"  # the Agents window's own "sent by another session" mark: it opens the source on a click


def assistant_source():
    """The Assistant's own session in the Agents window (its address), the source the label points back to."""
    try:
        import assistant as A
        import ide_sessions as I
        found = I.folder_session(A.folder())
    except Exception as e:
        D.debug("assistant_live.source", e)
        return None
    return found["uri"] if found else None


def send_ide(hit, text, working, source=None):
    """Into an Agents-window session through its editor's Agent Host. `source`: the Assistant's session, so the
    window can say "From Assistant" above the message and open it. Returns {ok, how, note}."""
    import ide_sessions as I
    app, user_data, c = hit
    eps = I.endpoints(user_data)
    if not eps:
        return {"ok": False, "note": f"{app} is not running, so there is nobody to send to. Open it and try again."}
    channel = _chat_uri(c["uri"])
    meta = {"dispatch.from": "assistant"}
    if source and source != c["uri"]:
        meta[DELEGATION_META] = {"sourceSession": source}
    message = {"text": text, "origin": {"kind": "user"}, "_meta": meta}
    err = ""
    for e in eps:
        try:
            cl = I.Ahp(e)
            try:
                if working:
                    action = {"type": "chat/pendingMessageSet", "kind": "queued", "id": uuid.uuid4().hex, "message": message}
                else:
                    action = {"type": "chat/turnStarted", "turnId": str(uuid.uuid4()), "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "message": message}
                cl.notify("dispatchAction", {"channel": channel, "clientSeq": 1, "action": action})
                cl.request("listSessions", {"channel": "ahp-root://", "limit": 1})  # read before we hang up
            finally:
                cl.close()
            return {"ok": True, "how": "queued" if working else "started", "app": app,
                    "note": "It will see this when its current turn ends." if working else ""}
        except (OSError, ValueError, KeyError) as ex:
            err = str(ex)
    return {"ok": False, "note": f"Could not reach {app}'s agent service: {err}"}


def send(key, text, wait=0):
    """Send `text` to the session `key` on this Mac. {ok, key, how, note, reply?}. With `wait` seconds the
    answer of that turn comes back as `reply` when it finishes in time."""
    import ide_sessions as I
    body = labelled(text)
    hit = I.find(key, include_external=False) if ":" in key else None
    if hit:
        rows = {r["ide_key"]: r for r in I.scan() if r.get("ide_key")}
        working = rows.get(hit[2]["uri"], {}).get("state") == "working"
        before = _reply_mark(key)
        res = send_ide(hit, body, working, assistant_source())
        res["key"] = key
        if res["ok"] and wait:
            res.update(_await_reply(key, before, wait))
        return res
    return send_chat(key, body, wait)


def send_chat(key, body, wait):
    """Into a conversation chatd holds (or reopens), as the phone's reply box does."""
    import session_reply as R
    agent, _, sid = key.partition(":")
    try:
        ref = R.exact_ref(D, sid, agent)
        if R.terminal_holds(D, ref):
            return {"ok": False, "key": key, "note": "This session lives in a terminal. Dispatch can read it, but not type into it. Start the work in a session in the Agents window instead."}
        before = _reply_mark(key)
        r = R.submit(D, ref, body, str(uuid.uuid4()))
    except R.Rejected as e:
        return {"ok": False, "key": key, "note": str(e)}
    ok = r.get("state") == "accepted"
    res = {"ok": ok, "key": key, "how": "queued" if "queue" in (r.get("note") or "") or "排队" in (r.get("note") or "") else "started",
           "note": "" if ok else (r.get("note") or "The message did not go out.")}
    if ok and wait:
        res.update(_await_reply(key, before, wait))
    return res


def _reply_mark(key):
    """How many replies a session has so far, to tell the next one from the old ones."""
    try:
        d = D.read_session_detail(_ref_of(key))
        return sum(1 for m in d.get("messages", []) if m.get("role") == "assistant")
    except Exception:
        return 0


def _await_reply(key, before, wait):
    """Poll the transcript until the session has answered after our message, or `wait` seconds pass."""
    end = time.time() + wait
    time.sleep(1.5)
    while time.time() < end:
        try:
            d = D.read_session_detail(_ref_of(key))
        except Exception:
            time.sleep(1.5)
            continue
        msgs = [m for m in d.get("messages", []) if m.get("role") in ("user", "assistant") and (m.get("text") or "").strip()]
        ours = max((i for i, m in enumerate(msgs) if m["role"] == "user" and m["text"].lstrip().startswith(FROM_ASSISTANT)), default=None)
        if ours is not None:
            after = [m for m in msgs[ours + 1:] if m["role"] == "assistant"]
            live = [s for s in D.live_sessions(local_only=True) if key.endswith(str(s.get("session_id"))) or s.get("ide_key") == key]
            busy = any(s.get("state") == "working" for s in live)
            if after and not busy:
                return {"reply": _clip_block(after[-1]["text"], 2000), "answered": True}
        time.sleep(2)
    return {"reply": "", "answered": False, "note_wait": f"No answer within {wait} seconds. It is still working; read it later with `dispatch assistant turns {key}`."}
