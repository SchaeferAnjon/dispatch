# -*- coding: utf-8 -*-
"""`dispatch waiting`: what is waiting for the person, across every project (design/task-model/DECISIONS.md,
「Waiting for you」). The Agents window's badge, its hover card and the Waiting for you page read this.

One row per session that stopped for the person, plus the tasks only they can do:

  approve   a session waits for a permission: the phrase is the action in its own words
  decide    a session asks a question: the phrase is the question
  unread    a session finished and nobody looked yet: the phrase is its summary's first sentence
            (the last sentence of the reply when there is no summary)
  only_you  an open task only the person can do (`dispatch need-you`, label dispatch:needs-you): no session

One machine, one window (design/machines/redesign/README.md): the list is this machine's. Tasks and
unread replies of projects the registry puts on another Mac are left out (that Mac lists them); a
session here that asks for an approval or an answer always stays, since no other window can answer
it. `--host <id>` asks another Mac for its own list (`waiting --local` there).

Sources:
  - the Agents window (Dispatch IDE / VS Code agent host, ide_sessions.py): listSessions gives the
    status bits; a session with InputNeeded is subscribed to once for its `inputNeeded` list (the
    tool call waiting for confirmation, or the question). Allow / Deny dispatch `chat/toolCallConfirmed`
    to the chat that asked; Mark read dispatches `session/isReadChanged`.
  - chatd (Dispatch's in-app chat): its registry says waiting_permission / waiting_input; the pending
    request comes from the session's replay; Allow / Deny go through the door's `permission`; an unread
    reply is the activity index's, Mark read writes the read receipt.
  - the task board: `bd list` (the open tasks: the Only-you ones, and the task each waiting session
    works on, from its session-origin: / session: label).

What the page shows on each row (design/waiting/redesign, direction A):
  approve   tool, arg (the command or the path, ~ for the home folder), path, scope: outside_workspace
            (a file outside the session's folder), uploads (the command sends something off this
            Mac), destructive (it cannot be undone); Allow / Deny act on it in place
  decide    question and, for one single-select or yes/no question, options [{id, label}]: `pick`
            answers it in place
  sessions  stopped_at (when it stopped: how long it has been waiting) and task / task_title
  only_you  created_at (at is the creation, not the last edit), session (the conversation it came
            from), from_task, recent (created in the last 7 days), snooze_until
  counts    per kind, only_you_recent / only_you_older, only_you_new (since `waiting seen`) and
            attention = approve + decide + unread + only_you_new, the number on the sidebar row

Every source is best effort: one that is not running or fails adds nothing.
"""
import sys

sys.dont_write_bytecode = True

import json
import os
import re
import socket
import time
from urllib.parse import unquote

import ide_sessions as I

D = None  # dispatch.py, bound by the caller (cmd_waiting)

KINDS = ("approve", "decide", "unread", "only_you")
PHRASE_MAX = 160
NEEDS_YOU = "dispatch:needs-you"
DECIDE = "dispatch:decide"
RECENT_DAYS = 7  # Only you shows this week's tasks; older ones stay on the task board
SEEN_FILE = "waiting-seen.json"
OPTIONS_MAX = 9  # a decide card picks with the keys 1..9

# SessionInputRequestKind (agentHost protocol channels-session/state.ts)
REQ_CHAT_INPUT, REQ_TOOL_CONFIRMATION, REQ_CLIENT_EXECUTION, REQ_AUTH = "chatInput", "toolConfirmation", "toolClientExecution", "toolAuthentication"


# ---- phrases --------------------------------------------------------------------------------

def text_of(v):
    """StringOrMarkdown → plain text."""
    if isinstance(v, dict):
        v = v.get("markdown") or v.get("value") or v.get("text") or ""
    return v if isinstance(v, str) else ""


def clean(text, limit=PHRASE_MAX):
    """One line: markdown marks and runs of whitespace gone, cut at `limit` with an ellipsis. Single
    underscores stay (snake_case names, paths)."""
    t = text_of(text)
    t = re.sub(r"```[a-zA-Z0-9_-]*", " ", t)
    t = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", t)  # [label](link) → label
    t = re.sub(r"(?m)^\s{0,3}(#{1,6}|>)\s*", "", t)  # headings, quotes
    t = re.sub(r"`+|\*\*|__", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t if len(t) <= limit else t[:limit - 1].rstrip() + "…"


# A sentence ends at 。！？, or at . ! ? followed by a space or the end: "~/.config" and "3.5" do not end one.
_END = re.compile(r"[。！？]|[.!?](?=\s|$)|\n+")


def sentences(text):
    t = text_of(text).strip()
    out, start = [], 0
    for m in _END.finditer(t):
        s = t[start:m.end()].strip()
        if s:
            out.append(s)
        start = m.end()
    if t[start:].strip():
        out.append(t[start:].strip())
    return [s for s in out if len(s.strip("。！？；!?. ")) > 1]


def first_sentence(text):
    s = sentences(text)
    return clean(s[0]) if s else clean(text)


def last_sentence(text):
    s = sentences(text)
    return clean(s[-1]) if s else clean(text)


def task_phrase(title, desc):
    """The first sentence of a task's description that the title does not already say. `need-you`
    cuts a long title and puts the whole sentence first in the description: then the phrase is the
    rest of that sentence."""
    desc = (desc or "").strip()
    title = (title or "").strip().rstrip("…")
    if title and desc.startswith(title):
        rest = desc[len(title):]
        first_para, _, more = rest.partition("\n")
        rest = first_para.lstrip(" ，,：:;；。.") or more.strip()
        return first_sentence(rest) if rest.strip() else ""
    return first_sentence(desc) if desc else ""


def tool_input_text(v):
    """A tool call's input (a JSON string or a ContentRef) → the part that says what it does."""
    if not isinstance(v, str):
        return ""
    try:
        d = json.loads(v)
    except ValueError:
        return v
    if not isinstance(d, dict):
        return v
    for k in ("command", "file_path", "path", "url", "pattern", "query", "description"):
        if isinstance(d.get(k), str) and d[k].strip():
            return d[k]
    return ""


# tools that run a shell command (Claude Code's and OpenCode's Bash, Codex's, VS Code's own)
SHELL_TOOLS = {"bash", "shell", "local_shell", "exec_command", "run_in_terminal", "execute_command"}


def pending_command(tc, msg):
    """The command a shell tool asks to run: its input's `command` (a string, or Codex's argv list),
    else what follows the harness's "Running " in the invocation message; "" for any other tool."""
    names = {str(tc.get(k) or "").lower() for k in ("toolName", "displayName")}
    running = msg.startswith("Running ")
    if not (names & SHELL_TOOLS) and not running:
        return ""
    raw = tc.get("toolInput")
    try:
        d = json.loads(raw) if isinstance(raw, str) else {}
    except ValueError:
        d = {}
    cmd = d.get("command") if isinstance(d, dict) else None
    if isinstance(cmd, list):
        cmd = " ".join(str(c) for c in cmd)
    if isinstance(cmd, str) and cmd.strip():
        return cmd
    return msg[len("Running "):] if running else ""


def approve_phrase(tool_call):
    """What the session wants to do, in its own words: a command it asks to run ("Wants to run
    npm test": it has not run yet), else the invocation message ("Write /x/y"), else the tool input's
    path, else the confirmation title or the tool's name."""
    tc = tool_call if isinstance(tool_call, dict) else {}
    # "Edit [outside.txt](file:///tmp/outside.txt)": the path says more than the file's name
    msg = re.sub(r"\[([^\]]*)\]\(file://([^)]*)\)", lambda m: unquote(m.group(2)) or m.group(1), text_of(tc.get("invocationMessage")))
    command = clean(pending_command(tc, clean(msg)))
    if command:
        return clean(f"Wants to run {command}")
    for v in (msg, tool_input_text(tc.get("toolInput")), tc.get("confirmationTitle"), tc.get("intention"), tc.get("displayName"), tc.get("toolName")):
        p = clean(v)
        if p:
            return p
    return ""


def question_phrase(request):
    """ChatInputRequest → its message, else the first question."""
    r = request if isinstance(request, dict) else {}
    if clean(r.get("message")):
        return clean(r.get("message"))
    for q in r.get("questions") or []:
        if isinstance(q, dict):
            p = clean(q.get("message")) or clean(q.get("title"))
            if p:
                return p
    return ""


# The tool's name as a person reads it on the card: Claude's own names stay, Codex's become the same words.
TOOL_NAMES = {"shell": "Bash", "exec_command": "Bash", "local_shell": "Bash", "file_edit": "Edit", "apply_patch": "Edit",
              "web_search": "WebSearch", "read_file": "Read", "write_file": "Write"}
PATH_KEYS = ("file_path", "notebook_path", "path")
# the command sends something off this Mac
_UPLOADS = re.compile(r"(?:^|[\s;&|(])(?:scp\s|sftp\s|rsync\s[^|;&]*\S+:|curl\s[^|;&]*(?:\s-T\s|--upload-file|\s-F\s|--form\s|--data-binary\s+@|\s-d\s+@)"
                      r"|git\s+push\b|gh\s+(?:release\s+(?:upload|create)|gist\s+create|pr\s+create)|xcrun\s+(?:notarytool\s+submit|altool)"
                      r"|aws\s+s3\s+(?:cp|sync|mv)\s[^|;&]*s3://|gsutil\s+(?:cp|rsync)\s|npm\s+publish|twine\s+upload|docker\s+push|pod\s+trunk\s+push)")
# the command cannot be undone
_DESTRUCTIVE = re.compile(r"(?:^|[\s;&|(])(?:rm\s|rmdir\s|git\s+reset\s+--hard|git\s+clean\s+-[a-zA-Z]*f|git\s+push\s[^|;&]*(?:--force|\s-f\b)"
                          r"|git\s+checkout\s+--\s|git\s+restore\s|git\s+branch\s+-D\s|dd\s+if=|mkfs|diskutil\s+(?:erase|partition)"
                          r"|drop\s+(?:table|database)\s|truncate\s+table\s|delete\s+from\s)", re.I)


def tool_input(tc):
    """A tool call's input as a dict ({} when it is not JSON)."""
    v = (tc or {}).get("toolInput")
    if isinstance(v, dict):
        return v
    if not isinstance(v, str):
        return {}
    try:
        d = json.loads(v)
    except ValueError:
        return {}
    return d if isinstance(d, dict) else {}


def home_short(p):
    """/Users/me/x → ~/x (the card shows paths the way the person types them)."""
    home = os.path.expanduser("~")
    return "~" + p[len(home):] if p == home or p.startswith(home + "/") else p


def inside(path, folders):
    path = os.path.normpath(path)
    return any(f and (path == os.path.normpath(f) or path.startswith(os.path.normpath(f).rstrip("/") + "/")) for f in folders)


def tool_detail(tc, folders=()):
    """What the approve card says about a tool call: {tool, arg, path, scope}. `tool` the tool's name
    (Bash, Write, Edit…), `arg` the command or the path, `path` the file it touches (absolute) or "",
    `scope` outside_workspace | uploads | destructive | None; `folders` are the session's own folders."""
    tc = tc if isinstance(tc, dict) else {}
    name = str(tc.get("toolName") or tc.get("displayName") or "")
    tool = TOOL_NAMES.get(name, name)
    ti = tool_input(tc)
    command = ti.get("command")
    raw = tc.get("toolInput")
    terminal = ((tc.get("_meta") or {}).get("toolKind") == "terminal") or tool == "Bash"
    if command is None and terminal and isinstance(raw, str) and raw.strip() and not raw.lstrip().startswith("{"):
        # the Agents window hands a shell tool's input over as the command line itself
        command = raw
    if isinstance(command, list):
        command = " ".join(str(x) for x in command)
    if isinstance(command, str):
        # the host runs `command <line>` so no alias or function stands in for the program: the person reads the line
        command = re.sub(r"^\s*command\s+", "", command)
    path = next((ti[k] for k in PATH_KEYS if isinstance(ti.get(k), str) and ti[k].strip()), "")
    if not path:
        # "Edit [x.txt](file:///tmp/x.txt)": the invocation message carries the path when the input does not
        m = re.search(r"\]\(file://([^)]+)\)", text_of(tc.get("invocationMessage")))
        path = unquote(m.group(1)) if m else ""
    if isinstance(command, str) and command.strip():
        arg = command.strip()
        tool = tool or "Bash"
    elif path:
        arg = home_short(path)
    else:
        arg = clean(next((ti[k] for k in ("url", "pattern", "query", "description") if isinstance(ti.get(k), str) and ti[k].strip()), "")
                    or approve_phrase(tc), 400)
    scope = None
    if isinstance(command, str) and _DESTRUCTIVE.search(" " + command):
        scope = "destructive"
    elif isinstance(command, str) and _UPLOADS.search(" " + command):
        scope = "uploads"
    elif path and path.startswith("/") and [f for f in folders if f] and not inside(path, folders):
        scope = "outside_workspace"
    return {"tool": tool or "Tool", "arg": arg, "path": path if path.startswith("/") else "", "scope": scope}


def decide_detail(request):
    """What the decide card offers: (question, options, question id, question kind). Options only for
    one single-select question (its options, at most OPTIONS_MAX) or one yes / no question; anything
    else is answered in the session."""
    r = request if isinstance(request, dict) else {}
    qs = [q for q in r.get("questions") or [] if isinstance(q, dict)]
    question = "\n\n".join(filter(None, (text_of(q.get("message") or q.get("title")).strip() for q in qs))) or text_of(r.get("message") or r.get("title")).strip() or question_phrase(r)
    if len(qs) != 1 or not qs[0].get("id"):
        return question, [], None, None
    q = qs[0]
    question = text_of(q.get("message")).strip() or text_of(q.get("title")).strip() or question
    kind = q.get("kind")
    if kind == "single-select":
        opts = [{"id": str(o["id"]), "label": text_of(o.get("label") or str(o["id"])).strip()} for o in q.get("options") or [] if isinstance(o, dict) and o.get("id")]
        if 0 < len(opts) <= OPTIONS_MAX:
            return question, opts, q["id"], kind
    if kind == "boolean":
        return question, [{"id": "yes", "label": "Yes"}, {"id": "no", "label": "No"}], q["id"], kind
    return question, [], q["id"], kind


def option_id(tool_call, kind):
    """The confirmation option of `kind` (approve | deny) a row's button picks: for approve the one-time
    one ("allow-once") when there is one, so Allow never widens to the whole session; else the first."""
    opts = [o for o in (tool_call or {}).get("options") or [] if isinstance(o, dict) and o.get("kind") == kind and o.get("id")]
    once = [o for o in opts if "once" in str(o["id"]).lower() or "once" in str(o.get("label", "")).lower()]
    return (once or opts or [{}])[0].get("id")


def last_reply(path, tail=256 * 1024):
    """The text of the Agent's last reply in a Claude Code or Codex transcript (the activity index only
    keeps its first 280 characters), or ""."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - tail))
            lines = f.read().decode("utf-8", "replace").splitlines()
    except (OSError, TypeError):
        return ""
    for line in reversed(lines):
        if not line.startswith("{"):
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get("type") == "assistant" and not d.get("isSidechain"):  # Claude Code
            c = (d.get("message") or {}).get("content")
            text = c if isinstance(c, str) else "\n".join(b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text")
        elif d.get("type") == "response_item" and (d.get("payload") or {}).get("role") == "assistant":  # Codex
            text = "\n".join(b.get("text", "") for b in d["payload"].get("content") or [] if isinstance(b, dict) and b.get("type") in ("output_text", "text"))
        else:
            continue
        if text.strip():
            return text
    # A single final reply may be larger than the initial tail; do not fall back to a clipped preview.
    return last_reply(path, tail * 2) if size > tail else ""


def unread_summary(a):
    """The full summary for a detail card, falling back to the complete last reply."""
    return text_of(a.get("unread_summary")).strip() or last_reply(a.get("path")) or text_of(a.get("reply_preview"))


def unread_phrase(a):
    """An unread reply's phrase: its summary's first sentence, else the reply's last sentence."""
    if a.get("unread_summary"):
        return first_sentence(a["unread_summary"])
    return last_sentence(last_reply(a.get("path")) or a.get("reply_preview") or "")


# ---- the Agents window ------------------------------------------------------------------------

def pending_request(state):
    """The first entry of a session's `inputNeeded` the person answers (client executions are work
    for a client, not a prompt), or None."""
    for r in (state or {}).get("inputNeeded") or []:
        if isinstance(r, dict) and r.get("kind") in (REQ_TOOL_CONFIRMATION, REQ_CHAT_INPUT, REQ_AUTH):
            return r
    return None


def ide_item(row, request, summary=None):
    """A waiting row for one Agents-window session. `row`: ide_sessions.to_row; `request`: its pending
    inputNeeded entry (None for an unread one); `summary`: (phrase) for an unread one. `stopped_at` is
    when the session stopped (its last change: nothing moves while it waits)."""
    stopped = row.get("last_at") or 0
    base = {"id": f"ide:{row['ide_key']}", "source": "ide", "app": row.get("ide_app") or "", "resource": row["ide_key"],
            "session": f"{row['agent']}:{row['session_id']}", "agent": row["agent"], "title": row.get("title") or "",
            "project": row.get("project") or "", "project_dir": row.get("project_dir") or "", "at": stopped, "stopped_at": stopped}
    if request is None:
        return {**base, "kind": "unread", "phrase": summary or "", "summary": "", "actions": ["open", "read"]}
    kind = request.get("kind")
    if kind == REQ_TOOL_CONFIRMATION:
        tc = request.get("toolCall") or {}
        detail = tool_detail(tc, [row.get("cwd") or "", row.get("project_dir") or "", row.get("worktree") or ""])
        return {**base, "kind": "approve", "phrase": approve_phrase(tc), **detail, "actions": ["allow", "deny", "open"],
                "request": {"chat": request.get("chat"), "turn_id": request.get("turnId"), "tool_call_id": tc.get("toolCallId"),
                            "allow_option": option_id(tc, "approve"), "deny_option": option_id(tc, "deny"),
                            "result": tc.get("status") == "pending-result-confirmation"}}
    if kind == REQ_CHAT_INPUT:
        r = request.get("request") or {}
        question, options, qid, qkind = decide_detail(r)
        item = {**base, "kind": "decide", "phrase": question_phrase(r), "question": question, "options": options,
                "actions": ["pick", "open"] if options else ["open"]}
        if options:
            item["request"] = {"chat": request.get("chat"), "request_id": r.get("id"), "question_id": qid, "question_kind": qkind}
        return item
    if kind == REQ_AUTH:
        tc = request.get("toolCall") or {}
        return {**base, "kind": "approve", "phrase": clean(f"Sign in for {tc.get('displayName') or tc.get('toolName') or 'a tool'}"),
                "tool": "Sign in", "arg": clean(tc.get("displayName") or tc.get("toolName") or "a tool"), "path": "", "scope": None, "actions": ["open"]}
    # InputNeeded without a readable request (an older host): still the person's turn
    phrase = clean(row.get("activity")) or "Needs your input"
    return {**base, "kind": "decide", "phrase": phrase, "question": phrase, "options": [], "actions": ["open"]}


def _connect(entry):
    return I.Ahp(entry)


def _connect_action(entry):
    # A user action must survive a cold catalog read; the short polling timeout is
    # only suitable for a list that can retain its previous result and retry.
    return I.Ahp(entry, timeout=15)


def ide_scan(now=None, connect=_connect, errors=None):
    """[(row, request or None, entry)] for every Agents-window session waiting for the person:
    InputNeeded ones with their pending request, unread idle ones with None. An Agents window that
    did not answer goes into `errors` (the page keeps the rows it had: a slow answer is not an empty
    list)."""
    now = now or time.time()
    out = []
    for app, user_data in I.apps():
        eps = I.endpoints(user_data) if hasattr(socket, "AF_UNIX") else []
        if not eps:
            continue
        cat = {c["uri"]: c for c in I.read_catalog(I.db_path(user_data))}
        for e in eps:
            try:
                c = connect(e)
            except (OSError, ValueError, KeyError) as err:
                if errors is not None:
                    errors.append(f"{e}: {err}")
                continue
            try:
                live, cursor = {}, None
                while len(live) < 1000:
                    params = {"channel": "ahp-root://", "limit": 100}
                    if cursor:
                        params["cursor"] = cursor
                    res = c.request("listSessions", params) or {}
                    for s in res.get("items") or []:
                        if isinstance(s, dict) and s.get("resource"):
                            live[s["resource"]] = s
                    cursor = res.get("nextCursor")
                    if not cursor:
                        break
                for uri, s in live.items():
                    status = s.get("status")
                    if not isinstance(status, int) or status & I.ST_ARCHIVED:
                        continue
                    row = I.to_row(cat.get(uri, {}), s, app, True)
                    if row["archived"] or I.outside_session_root(row):
                        continue
                    needs = status & I.ST_INPUT_NEEDED == I.ST_INPUT_NEEDED
                    if needs:
                        req = None
                        try:
                            snap = (c.request("subscribe", {"channel": uri}) or {}).get("snapshot") or {}
                            req = pending_request(snap.get("state"))
                        except (OSError, ValueError):
                            pass
                        out.append((row, req or {"kind": "unknown"}, e))
                    elif not (status & I.ST_READ) and not (status & I.ST_IN_PROGRESS) and not row["external"]:
                        out.append((row, None, e))
                break
            except (OSError, ValueError, KeyError) as err:
                if errors is not None:
                    errors.append(f"{e}: {err}")
                continue
            finally:
                c.close()
    return out


# ---- chatd ------------------------------------------------------------------------------------

def chat_pending(dispatch_dir, key, timeout=3.0):
    """The chatd session's open permission_request event (its replay: the last request that no
    permission_resolved answered), or None. chatd not reachable: None."""
    try:
        from chat_client import ChatClient
        with ChatClient.connect(dispatch_dir, timeout=timeout, autostart=False) as c:
            c.request("replay", timeout=timeout, session=key)
            events = list(c.events(0))
    except Exception:
        return None
    open_ = {}
    for e in events:
        if e.get("session") not in (None, key):
            continue
        if e.get("ev") == "permission_request" and e.get("permission_id"):
            open_[e["permission_id"]] = e
        elif e.get("ev") == "permission_resolved":
            open_.pop(e.get("permission_id"), None)
    return list(open_.values())[-1] if open_ else None


def chat_items(held, rows, pending=None):
    """Rows for chatd's sessions. `held`: chatd.json's sessions {key: {lifecycle, cwd, …}}; `rows`:
    activity rows by key; `pending(key)`: the open permission_request event."""
    out = []
    for key, h in (held or {}).items():
        if not isinstance(h, dict):
            continue
        a = rows.get(key) or {}
        agent, _, sid = key.partition(":")
        cwd = h.get("cwd") or a.get("cwd") or ""
        stopped = h.get("since") or a.get("last_at") or 0
        base = {"id": f"chat:{key}", "source": "chat", "session": key, "agent": agent, "title": a.get("title") or "",
                "project": os.path.basename(cwd.rstrip("/")) if cwd else "", "project_dir": cwd, "at": stopped, "stopped_at": stopped}
        life = h.get("lifecycle")
        if life in ("waiting_permission", "waiting_input"):
            ev = pending(key) if pending else None
            if life == "waiting_input" or (ev or {}).get("kind") == "question":
                qs = (ev or {}).get("questions") or []
                q = next((clean(x.get("question") or x.get("header")) for x in qs if isinstance(x, dict) and (x.get("question") or x.get("header"))), "")
                phrase = q or clean(a.get("question")) or "Needs your answer"
                out.append({**base, "kind": "decide", "phrase": phrase, "question": phrase, "options": [], "actions": ["open"]})
            else:
                ev = ev or {}
                summary = text_of(ev.get("summary")).strip()
                tool = TOOL_NAMES.get(str(ev.get("tool_name") or ""), str(ev.get("tool_name") or ""))
                arg = summary[len(tool):].strip() if tool and summary.startswith(tool + " ") else summary
                out.append({**base, "kind": "approve", "phrase": clean(summary) or clean(tool) or "Needs your permission",
                            "tool": tool or "Tool", "arg": home_short(arg) if arg.startswith("/") else arg, "path": "", "scope": None,
                            "actions": ["allow", "deny", "open"] if ev else ["open"], "request": {"permission_id": ev.get("permission_id")}})
        elif a.get("unread") and a.get("reply_id") and not a.get("archived"):
            phrase = unread_phrase(a)
            at = a.get("reply_at") or base["at"]
            out.append({**base, "kind": "unread", "phrase": phrase, "summary": unread_summary(a), "at": at, "stopped_at": at, "actions": ["open", "read"], "reply_id": a["reply_id"]})
    return out


# ---- the task board ---------------------------------------------------------------------------

def _epoch(v):
    return I._iso(v) if v else 0.0


def _meta(t):
    m = t.get("metadata")
    if isinstance(m, str):
        try:
            m = json.loads(m)
        except ValueError:
            m = {}
    return m if isinstance(m, dict) else {}


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def label_values(t, prefix):
    return [l[len(prefix):] for l in t.get("labels") or [] if isinstance(l, str) and l.startswith(prefix)]


# `dispatch need-you --task X` ends the description with this line
_FROM_TASK = re.compile(r"(?m)^来自任务\s*([a-z][a-z0-9]*-[a-z0-9]{2,8})\s*$")


def only_you_items(issues, now=None):
    """Open tasks only the person can do: the ones `dispatch need-you` files (label dispatch:needs-you).
    Tasks merely assigned to the person are not counted: an Agent working as them assigns itself.
    A task hidden with `waiting snooze` stays out until its snooze_until. Newest first."""
    now = now or time.time()
    out = []
    for t in issues or []:
        if not isinstance(t, dict) or t.get("status") in ("closed", "deferred", "tombstone"):
            continue
        labels = t.get("labels") or []
        if "dispatch:trashed" in labels:
            continue
        if NEEDS_YOU not in labels:
            continue
        snooze = _num(_meta(t).get("snooze_until"))
        if snooze > now:
            continue
        project = next((l.split(":", 1)[1] for l in labels if l.startswith("project:")), "")
        desc = (t.get("description") or "").strip()
        created = _epoch(t.get("created_at") or t.get("updated_at"))
        m = _FROM_TASK.search(desc)
        out.append({"id": f"task:{t['id']}", "source": "board", "kind": "only_you", "task": t["id"], "title": t.get("title") or "",
                    "project": project, "phrase": task_phrase(t.get("title"), desc), "description": desc,
                    "story": text_of(_meta(t).get("story")).strip(),
                    "at": created, "created_at": created, "updated_at": _epoch(t.get("updated_at")),
                    "recent": created >= now - RECENT_DAYS * 86400,
                    # the conversation it came from (need-you labels it), where Open shows what led to it
                    "session": next(iter(label_values(t, "session-origin:") + label_values(t, "session:")), ""),
                    "from_task": m.group(1) if m else "",
                    # a snooze that ran out: back on the list, counted as new again
                    "snooze_until": snooze or None,
                    "actions": ["done", "snooze", "reply", "open"]})
    out.sort(key=lambda it: -(it["created_at"] or 0))
    return out


def decide_phrase(options):
    """The directions by name ("A: Now reading on top / B: One list with progress"): the row's Decide
    pill and its A / B buttons already say it is a choice, so the phrase spends its width on the names."""
    if all(o.get("title") for o in options):
        return " / ".join(f"{o['key']}: {o['title']}" for o in options)
    return "Pick a direction: " + " / ".join(o["key"] for o in options)


def decide_items(issues):
    """Tasks waiting for the person to pick a direction (`dispatch flow design`, label dispatch:decide):
    a Decide row with the options as buttons and Open on the prototype."""
    out = []
    for t in issues or []:
        if not isinstance(t, dict) or t.get("status") in ("closed", "deferred", "tombstone"):
            continue
        labels = t.get("labels") or []
        if DECIDE not in labels or "dispatch:trashed" in labels:
            continue
        m = t.get("metadata")
        if isinstance(m, str):
            try:
                m = json.loads(m)
            except ValueError:
                m = {}
        flow = (m or {}).get("flow") if isinstance(m, dict) else None
        if not isinstance(flow, dict) or flow.get("state") != "deciding":
            continue
        options = [{"key": str(o.get("key")), "title": str(o.get("title") or "")} for o in flow.get("options") or [] if isinstance(o, dict) and o.get("key")]
        if not options:
            continue
        project = next((l.split(":", 1)[1] for l in labels if l.startswith("project:")), "")
        out.append({"id": f"task:{t['id']}", "source": "board", "kind": "decide", "task": t["id"], "title": t.get("title") or "",
                    "project": project, "phrase": decide_phrase(options), "question": t.get("description") or t.get("title") or "",
                    "options": options, "open": flow.get("prototype") or "", "at": _epoch(t.get("updated_at") or t.get("created_at")),
                    "actions": ["pick", "open"]})
    return out


def session_tasks(issues):
    """{session id: (task id, title)}: the unfinished task each session works on (its session-origin:
    or session: label; the most recently touched one when a session has several)."""
    best = {}
    for t in issues or []:
        if not isinstance(t, dict) or t.get("status") in ("closed", "deferred", "tombstone") or not t.get("id"):
            continue
        labels = t.get("labels") or []
        if "dispatch:trashed" in labels or NEEDS_YOU in labels:
            continue
        touched = _epoch(t.get("updated_at") or t.get("created_at"))
        for sid in label_values(t, "session-origin:") + label_values(t, "session:"):
            if sid and (sid not in best or touched > best[sid][0]):
                best[sid] = (touched, t["id"], t.get("title") or "")
    return {sid: (tid, title) for sid, (_touched, tid, title) in best.items()}


def with_task(item, by_session):
    """A session row with the task it works on (DECISIONS: the row names its task)."""
    sid = (item.get("session") or "").partition(":")[2]
    hit = by_session.get(sid) or next((v for k, v in by_session.items() if len(k) >= 8 and sid.startswith(k)), None)
    if hit:
        item["task"], item["task_title"] = hit
    return item


def board_issues():
    """Every unfinished task (one `bd list`): the Only-you ones and the ones sessions work on."""
    code, o, _ = D.sh(["bd", "list", "--json", "-n", "0", "--status", "open,in_progress,blocked"], timeout=30)
    if code != 0:
        return []
    try:
        j = json.loads(o[o.find("["):]) if "[" in o else []
    except ValueError:
        return []
    return j if isinstance(j, list) else []


def done_only_you(ids=None, reason="Done in Waiting for you"):
    """Close Only-you tasks: the given task ids (with or without the row's `task:` prefix), or every
    open one (`--all`, the page's Mark all done). Only tasks that are Only-you rows right now close;
    anything else in `ids` is ignored. Returns the ids closed."""
    open_ids = [it["task"] for it in only_you_items(board_issues())]
    wanted = open_ids if ids is None else [i[len("task:"):] if i.startswith("task:") else i for i in ids]
    closed = []
    for t in wanted:
        if t not in open_ids:
            continue
        code, _, _ = D.sh(["bd", "close", t, "--reason", reason, "--json"], timeout=30)
        if code == 0:
            closed.append(t)
    return closed


# ---- all of it ------------------------------------------------------------------------------

def counts(items, seen_at=0):
    """Per kind, plus: only_you_recent (this week) / only_you_older, only_you_new (created, or back from
    a snooze, since the page was last opened) and attention, the sidebar row's number: every session
    that waits (approve, decide, unread) and the new Only-you tasks."""
    c = {k: 0 for k in KINDS}
    for it in items:
        c[it["kind"]] = c.get(it["kind"], 0) + 1
    only = [it for it in items if it["kind"] == "only_you"]
    c["only_you_recent"] = sum(1 for it in only if it.get("recent"))
    c["only_you_older"] = len(only) - c["only_you_recent"]
    c["only_you_new"] = sum(1 for it in only if (it.get("created_at") or 0) > seen_at or (it.get("snooze_until") or 0) > seen_at)
    c["attention"] = c["approve"] + c["decide"] + c["unread"] + c["only_you_new"]
    c["all"] = len(items)
    return c


# ---- which machine a row belongs to -----------------------------------------------------------------

def places():
    """projects_view.placements(): where the registry puts each project it places. Unreadable: {}."""
    try:
        pv = D._mod("projects_view")
        pv.D = D
        return pv.placements()
    except Exception as e:
        try:
            D.debug("waiting.places", e)
        except Exception:
            pass
        return {"names": {}, "dirs": []}


def home_rel(path, home=None):
    """`~/…` for a folder under `home` (this machine's by default), the path as it is otherwise."""
    p = (path or "").rstrip("/")
    home = (home or getattr(D, "HOME", "") or "").rstrip("/")
    if home and (p == home or p.startswith(home + "/")):
        return "~" + p[len(home):]
    return p


def place_of(it, where, home=None):
    """The machine the registry puts a row's project on ("local" or a host id), or None (not placed).
    `home`: the home folder of the machine the row's folder is on (this one by default)."""
    host = (where.get("names") or {}).get((it.get("project") or "").lower())
    if host is None and it.get("project_dir"):
        rel = home_rel(it["project_dir"], home)
        for d, h in where.get("dirs") or []:
            if d and (rel == d or rel.startswith(d.rstrip("/") + "/")):
                return h
    return host


def keeps(it, where, view="local", home=None):
    """Whether the machine `view` lists this row: anything whose project is not placed on another machine,
    and always a session asking for an approval or an answer (it runs there; no other window can answer it)."""
    if it.get("source") in ("ide", "chat") and it.get("kind") in ("approve", "decide"):
        return True
    host = place_of(it, where, home)
    return host is None or host == view


def shared(it, where, home=None):
    """A task every machine lists: the board is shared and its project is placed nowhere."""
    return it.get("source") == "board" and place_of(it, where, home) is None


def this_machine(data, where=None, view="local", home=None):
    """collect()'s answer with only what the machine `view` lists ("local": this one; a host id: another
    Mac whose older dispatch sent its whole list, `home` its home folder), counts redone, plus how many
    rows are shared tasks (counts.shared: they show on every machine)."""
    where = places() if where is None else where
    items = [it for it in (data or {}).get("items") or [] if keeps(it, where, view, home)]
    c = counts(items)
    c["shared"] = sum(1 for it in items if shared(it, where, home))
    return dict(data or {}, items=items, counts=c)


def attention(data):
    """A list's counts the way `dispatch machines` reports them: {approve, decide, unread, only_you, total,
    shared, as_of}."""
    c = (data or {}).get("counts") or counts((data or {}).get("items") or [])
    return {**{k: c.get(k, 0) for k in KINDS}, "total": c.get("all", 0), "shared": c.get("shared", 0),
            "as_of": (data or {}).get("updated_at")}


# ---- another Mac's list -----------------------------------------------------------------------------

LOCAL_ARGS = ["waiting", "--local"]  # what another Mac is asked over ssh (remote_dispatch adds --json)
OLD_ARGS = ["waiting"]               # a dispatch without --local there: its whole list


def peer_is_old(h):
    """True when that Mac's last `hosts --local` answer (cached, no ssh) came from a dispatch that does not
    report its version yet: its `waiting` has no --local either."""
    try:
        with open(D.remote_cache_path(h, ["hosts", "--local"]), encoding="utf-8") as f:
            rows = json.load(f)
    except (OSError, ValueError):
        return False
    return isinstance(rows, list) and bool(rows) and isinstance(rows[0], dict) and "dispatch_version" not in rows[0]


def remote_list(h, ttl=15, timeout=12, background=False, cached_only=False, where=None):
    """That Mac's own list, tagged with it: its `waiting --local`, or from an older dispatch there its whole
    list with what belongs to other machines taken out here (`where`: placements, or a function giving
    them; read from the registry when None). cached_only: the last answer it gave (it is off), no ssh.
    None when there is no answer."""
    def ask(args):
        if cached_only:
            try:
                with open(D.remote_cache_path(h, args), encoding="utf-8") as f:
                    return json.load(f)
            except (OSError, ValueError):
                return None
        return D.remote_dispatch(h, args, ttl, timeout=timeout, background=background)

    data = None if peer_is_old(h) else ask(LOCAL_ARGS)
    if not (isinstance(data, dict) and "items" in data):
        data = ask(OLD_ARGS)
        if not (isinstance(data, dict) and "items" in data):
            return None
        user = (h.get("ssh") or "").split("@")[0] if "@" in (h.get("ssh") or "") else ""
        data = this_machine(data, where() if callable(where) else where, view=h["id"], home=f"/Users/{user}" if user else None)
    return dict(data, host=h["id"], host_name=h.get("name") or h["id"])


def is_here(key):
    """True for "local" and the names this machine goes by."""
    k = (key or "").strip().casefold()
    if k in ("", "local", "本机"):
        return True
    try:
        return k in {n.casefold() for n in [D.local_host_name()] + list(D.local_host_aliases()) if n}
    except Exception:
        return False


def seen_path():
    return os.path.join(D.DISPATCH_DIR, SEEN_FILE) if D is not None else ""


def seen_at(now=None):
    """When the person last opened the page (`waiting seen`). The first time there is no record: now,
    so the tasks that were already there do not count as new."""
    p = seen_path()
    if not p:
        return 0
    try:
        with open(p, encoding="utf-8") as f:
            return float(json.load(f).get("seen_at") or 0)
    except (OSError, ValueError, AttributeError):
        return mark_seen(now)


def mark_seen(now=None):
    now = now or time.time()
    p = seen_path()
    if p:
        try:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            tmp = p + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"seen_at": now}, f)
            os.replace(tmp, p)
        except OSError:
            pass
    return now


def unread_summaries():
    """{session key: activity row} for these transcript keys (claude-code:<id>, codex:<id>) and every
    chatd-held one: the unread flag, its summary, its reply preview. {} when the index is unreadable."""
    try:
        from activity import activity_list
        return {r["key"]: r for r in activity_list(D.HOME, D.DISPATCH_DIR, D.load_index())}
    except Exception:
        return {}


def collect(now=None, ide=None, held=None, activity_rows=None, issues=None, pending=None, seen=None):
    """{"items": [...], "counts": {...}, "seen_at": t, "updated_at": t}. Every argument overrides a
    source (tests). Order: approve, decide (the longest waiting first), unread (newest first), only_you
    (newest first)."""
    now = now or time.time()
    items = []
    errors = []
    try:
        scanned = ide_scan(now, errors=errors) if ide is None else ide
    except Exception as e:
        scanned = []
        errors.append(str(e))
    if held is None:
        try:
            from activity import chat_held
            held = chat_held(D.DISPATCH_DIR)
        except Exception:
            held = {}
    unread_ide = [(r, req) for r, req, _e in scanned if req is None]
    if activity_rows is None:
        activity_rows = unread_summaries() if (held or unread_ide) else {}
    for row, req, _e in scanned:
        if req is not None:
            items.append(ide_item(row, req))
            continue
        tkey = None
        try:
            tkey = I.transcript_key(row["ide_key"])
        except Exception:
            pass
        a = activity_rows.get(tkey or f"{row['agent']}:{row['session_id']}") or {}
        items.append({**ide_item(row, None, unread_phrase(a) if a else ""), "summary": unread_summary(a) if a else ""})
    items += chat_items(held, activity_rows, pending if pending is not None else (lambda k: chat_pending(D.DISPATCH_DIR, k)))
    board_failed = False
    try:
        board = board_issues() if issues is None else issues
    except Exception:
        # the board did not answer (a busy Mac): its rows are missing from this list, not done
        board, board_failed = [], True
    by_session = session_tasks(board)
    items = [with_task(it, by_session) for it in items]
    try:
        items += only_you_items(board, now)
    except Exception:
        pass
    try:
        items += decide_items(board)
    except Exception:
        pass
    order = {k: i for i, k in enumerate(KINDS)}

    def key(it):
        t = it.get("stopped_at") or it.get("at") or 0
        return (order.get(it["kind"], 9), t if it["kind"] in ("approve", "decide") else -t)
    items.sort(key=key)
    seen = seen_at(now) if seen is None else seen
    data = {"items": items, "counts": counts(items, seen), "seen_at": seen, "updated_at": now}
    partial = []
    if errors:
        # the Agents window's sessions are missing from this list, not gone
        partial.append("ide")
    if board_failed:
        partial.append("board")
    if partial:
        data["partial"] = partial
    return data


# ---- acting on a row ------------------------------------------------------------------------

def _find(item_id, scanned):
    for row, req, e in scanned:
        if f"ide:{row['ide_key']}" == item_id:
            return row, req, e
    return None


def ide_confirm(item_id, allow, scanned=None, connect=_connect, request=""):
    """Allow or deny the tool call an Agents-window session waits on (`request`: only that tool call)."""
    scanned = ide_scan() if scanned is None else scanned
    hit = _find(item_id, scanned)
    if not hit or hit[1] is None:
        return {"ok": False, "code": "not_waiting", "message": "This session is not waiting for a permission any more"}
    row, req, entry = hit
    it = ide_item(row, req)
    r = it.get("request") or {}
    if request and r.get("tool_call_id") != request:
        return {"ok": False, "code": "not_waiting", "message": "This session is not waiting for that permission any more"}
    if it["kind"] != "approve" or not r.get("tool_call_id") or not r.get("chat"):
        return {"ok": False, "code": "not_approvable", "message": "Open the session to answer it"}
    if r.get("result"):
        action = {"type": "chat/toolCallResultConfirmed", "turnId": r["turn_id"], "toolCallId": r["tool_call_id"], "approved": bool(allow)}
    elif allow:
        action = {"type": "chat/toolCallConfirmed", "turnId": r["turn_id"], "toolCallId": r["tool_call_id"], "approved": True, "confirmed": "user-action"}
        if r.get("allow_option"):
            action["selectedOptionId"] = r["allow_option"]
    else:
        action = {"type": "chat/toolCallConfirmed", "turnId": r["turn_id"], "toolCallId": r["tool_call_id"], "approved": False, "reason": "denied"}
        if r.get("deny_option"):
            action["selectedOptionId"] = r["deny_option"]
    _dispatch(entry, r["chat"], action, connect)
    return {"ok": True, "id": item_id, "decision": "allow" if allow else "deny", "title": row.get("title") or "",
            "message": f"{'Allowed' if allow else 'Denied'}: {re.sub(r'^Wants to ', '', it['phrase'])}"}


def _dispatch(entry, channel, action, connect=_connect):
    c = connect(entry)
    try:
        c.notify("dispatchAction", {"channel": channel, "clientSeq": 1, "action": action})
        # dispatchAction has no reply: ask something afterwards so the action is read before we hang up
        c.request("listSessions", {"channel": "ahp-root://", "limit": 1})
    finally:
        c.close()


def ide_pick(item_id, option, scanned=None, connect=_connect):
    """Answer the question an Agents-window session waits on with one of its options (`option`: the
    option's id, its label, or its number 1..9 as on the card): `chat/inputCompleted` to the chat."""
    scanned = ide_scan() if scanned is None else scanned
    hit = _find(item_id, scanned)
    if not hit or hit[1] is None:
        return {"ok": False, "code": "not_waiting", "message": "This session is not waiting for an answer any more"}
    row, req, entry = hit
    it = ide_item(row, req)
    r = it.get("request") or {}
    if it["kind"] != "decide" or not it.get("options") or not r.get("request_id") or not r.get("chat"):
        return {"ok": False, "code": "not_pickable", "message": "Open the session to answer it"}
    want = str(option or "").strip()
    opts = it["options"]
    opt = next((o for o in opts if o["id"] == want), None) or next((o for o in opts if o["label"] == want), None)
    if opt is None and want.isdigit() and 1 <= int(want) <= len(opts):
        opt = opts[int(want) - 1]
    if opt is None:
        return {"ok": False, "code": "no_option", "message": f"No option {want}"}
    if r.get("question_kind") == "boolean":
        value = {"kind": "boolean", "value": opt["id"] == "yes"}
    else:
        value = {"kind": "selected", "value": opt["id"]}
    action = {"type": "chat/inputCompleted", "requestId": r["request_id"], "response": "accept",
              "answers": {r["question_id"]: {"state": "submitted", "value": value}}}
    _dispatch(entry, r["chat"], action, connect)
    return {"ok": True, "id": item_id, "option": opt["id"], "label": opt["label"], "title": row.get("title") or "",
            "message": f"Answered: {opt['label']}"}


def ide_session_entry(item_id, connect=_connect):
    """(row, endpoint) of an Agents-window session by its row id, read or not (undo needs the read ones)."""
    want = item_id[len("ide:"):] if item_id.startswith("ide:") else item_id
    for app, user_data in I.apps():
        eps = I.endpoints(user_data) if hasattr(socket, "AF_UNIX") else []
        cat = {c["uri"]: c for c in I.read_catalog(I.db_path(user_data))} if eps else {}
        for e in eps:
            try:
                c = connect(e)
            except (OSError, ValueError, KeyError):
                continue
            try:
                res = c.request("listSessions", {"channel": "ahp-root://", "limit": 1000}) or {}
                for s in res.get("items") or []:
                    if isinstance(s, dict) and s.get("resource") == want:
                        return I.to_row(cat.get(want, {}), s, app, True), e
                break
            except (OSError, ValueError, KeyError):
                continue
            finally:
                c.close()
    return None, None


def ide_mark_unread(item_id, connect=_connect):
    """Undo Mark read: the session is unread again (`session/isReadChanged` false)."""
    row, entry = ide_session_entry(item_id, connect)
    if not row:
        return {"ok": False, "code": "not_found", "message": "This session is not in the Agents window any more"}
    _dispatch(entry, row["ide_key"], {"type": "session/isReadChanged", "isRead": False}, connect)
    return {"ok": True, "id": item_id, "message": "Marked unread"}


def snooze_until(until, now=None):
    """`tomorrow` (08:00 tomorrow), `next-week` (08:00 next Monday), or epoch seconds."""
    from datetime import datetime, timedelta
    now = now or time.time()
    if isinstance(until, (int, float)) or (isinstance(until, str) and until.strip().isdigit()):
        return float(until)
    d = datetime.fromtimestamp(now)
    morning = d.replace(hour=8, minute=0, second=0, microsecond=0)
    if until == "next-week":
        return (morning + timedelta(days=7 - d.weekday())).timestamp()
    return (morning + timedelta(days=1)).timestamp()


def task_id_of(v):
    v = (v or "").strip()
    return v[len("task:"):] if v.startswith("task:") else v


def snooze_only_you(ids, until="tomorrow", now=None):
    """Not now: hide these Only-you tasks until `until` (metadata snooze_until). Returns the ids hidden."""
    t = int(snooze_until(until, now))
    done = []
    for tid in [task_id_of(i) for i in ids]:
        code, _, _ = D.sh(["bd", "update", tid, "--set-metadata", f"snooze_until={t}", "--json"], timeout=30)
        if code == 0:
            done.append(tid)
    return done, t


def unsnooze_only_you(ids):
    done = []
    for tid in [task_id_of(i) for i in ids]:
        code, _, _ = D.sh(["bd", "update", tid, "--unset-metadata", "snooze_until", "--json"], timeout=30)
        if code == 0:
            done.append(tid)
    return done


def reopen_tasks(ids):
    """Undo Done: open these tasks again."""
    done = []
    for tid in [task_id_of(i) for i in ids]:
        code, _, _ = D.sh(["bd", "reopen", tid, "--json"], timeout=30)
        if code == 0:
            done.append(tid)
    return done


def reply_to(task):
    """Reply to an Only-you task: where to start the conversation (the project's folder) and what to put
    in its input. The task is named in the text the way agents name tasks, title then id."""
    tid = task_id_of(task)
    code, o, err = D.sh(["bd", "show", tid, "--json"], timeout=30)
    if code != 0:
        return {"ok": False, "code": "not_found", "message": (err or o).strip() or f"No task {tid}"}
    try:
        d = json.loads(o[min([i for i in (o.find("["), o.find("{")) if i >= 0] or [0]):])
    except ValueError:
        return {"ok": False, "code": "not_found", "message": f"No task {tid}"}
    t = d[0] if isinstance(d, list) and d else d
    title = (t or {}).get("title") or ""
    project = next((l.split(":", 1)[1] for l in (t or {}).get("labels") or [] if isinstance(l, str) and l.startswith("project:")), "")
    home = ""
    try:
        home = D.project_home(project) if project else ""
    except Exception:
        home = ""
    return {"ok": True, "task": tid, "title": title, "project": project, "project_dir": home,
            "prompt": f"About “{title}” ({tid}): "}


MARK_READ_RETRY = "Could not read the Agents window. Try Mark read again."


def ide_mark_read(item_ids, scanned=None, connect=_connect_action, keep=None, failed=None):
    """Mark the Agents-window rows read. With `failed` (a list) nothing raises: every row that can be
    marked is, and what could not be (a window that did not answer, a row whose action failed) goes into
    `failed`. Without it, an error is raised only when a wanted row may sit in a window that did not
    answer (it was not found in the windows that did) or its own action failed."""
    errors = []
    if scanned is None:
        scanned = ide_scan(connect=connect, errors=errors)
    done = []
    for row, req, e in scanned:
        iid = f"ide:{row['ide_key']}"
        if req is None and (item_ids is None or iid in item_ids) and (keep is None or keep(ide_item(row, None))):
            try:
                _dispatch(e, row["ide_key"], {"type": "session/isReadChanged", "isRead": True}, connect)
            except (OSError, ValueError, KeyError):
                if failed is None:
                    raise OSError(MARK_READ_RETRY)
                failed.append({"id": iid, "message": MARK_READ_RETRY})
                continue
            done.append(iid)
    if errors:
        seen = {f"ide:{row['ide_key']}" for row, _, _ in scanned}
        missing = None if item_ids is None else [i for i in item_ids if i.startswith("ide:") and i not in seen]
        if failed is not None:
            failed.append({"id": "", "windows": len(errors), "message": MARK_READ_RETRY})
        elif missing is None or missing:
            raise OSError(MARK_READ_RETRY)
    return done


def chat_confirm(key, allow, pending_event=None, request=""):
    ev = pending_event if pending_event is not None else chat_pending(D.DISPATCH_DIR, key)
    if not ev or (request and ev.get("permission_id") != request):
        return {"ok": False, "code": "not_waiting", "message": "This conversation is not waiting for a permission any more"}
    from chat_client import ChatClient
    with ChatClient.connect(D.DISPATCH_DIR, timeout=5, autostart=False) as c:
        c.request("permission", timeout=10, session=key, permission_id=ev["permission_id"], decision="allow" if allow else "deny")
    return {"ok": True, "id": f"chat:{key}", "decision": "allow" if allow else "deny", "message": f"{'Allowed' if allow else 'Denied'}: {clean(ev.get('summary'))}"}


def mark_read(item_ids=None, keep=None, failed=None):
    """Mark these rows (None: every unread row `keep` lets through, all of them without it) read.
    Returns the ids marked. Mark all read (None) marks everything it can, the chat rows too, and puts
    what it could not into `failed`; a single row raises only when its own window could not be read."""
    done = []
    want = None if item_ids is None else set(item_ids)
    if failed is None and want is None:
        failed = []
    if want is None or any(i.startswith("ide:") for i in want):
        done += ide_mark_read(want, keep=keep, failed=failed if want is None else None)
    chat_ids = None if want is None else {i for i in want if i.startswith("chat:")}
    if chat_ids is None or chat_ids:
        from activity import acknowledge
        data = collect(ide=[], issues=[])
        for it in data["items"]:
            if it["kind"] == "unread" and it["source"] == "chat" and (chat_ids is None or it["id"] in chat_ids) and it.get("reply_id") \
                    and (keep is None or keep(it)):
                acknowledge(D.DISPATCH_DIR, it["session"], it["reply_id"])
                done.append(it["id"])
    return done


# ---- CLI --------------------------------------------------------------------------------------

LABEL = {"approve": "Approve", "decide": "Decide", "unread": "Unread", "only_you": "Only you"}


HEARTBEAT_SECONDS = 15


def watch(write=None, sleep=time.sleep, interval=3.0, stop=None, parent=os.getppid, clock=time.monotonic):
    """NDJSON attention changes, including the initial snapshot. Timestamps are not changes.

    This runs on the source machine over one SSH connection. Collect locally, never ask peers
    (which would create a watch cycle). The SSH client going away must end it: a heartbeat line
    every HEARTBEAT_SECONDS (machines_watch ignores it) finds a broken stdout even when nothing
    changes, and a parent of 1 (sshd gone, the process orphaned) ends it at the next round.
    """
    write = write or (lambda row: print(json.dumps(row, ensure_ascii=False), flush=True))
    previous = None
    beat = clock()
    try:
        while stop is None or not stop():
            if parent() == 1:
                return 0
            row = attention(this_machine(collect()))
            signature = tuple(row.get(k, 0) for k in (*KINDS, "total", "shared"))
            if signature != previous:
                write(row)
                previous = signature
                beat = clock()
            elif clock() - beat >= HEARTBEAT_SECONDS:
                write({"heartbeat": int(time.time())})
                beat = clock()
            sleep(interval)
    except (BrokenPipeError, OSError, KeyboardInterrupt):
        return 0
    return 0


def command(a):
    op = a.op or "list"
    if op == "watch":
        return watch()
    if op == "list":
        key = getattr(a, "host", "") or ""
        if key and not is_here(key):
            import host_admin
            h = host_admin.match(D.hosts(), key)
            data = remote_list(h) if h else None
            if data is None:
                msg = f"Unknown Mac: {key}" if not h else f"{h.get('name') or h['id']} did not answer."
                print(json.dumps({"ok": False, "message": msg}, ensure_ascii=False) if a.json else msg)
                return 1
        else:
            # this machine's list; --local (what another Mac sends over ssh) asks for the same
            try:
                name = D.local_host_name()
            except Exception:
                name = ""
            data = dict(this_machine(collect()), host="local", host_name=name)
        if a.json:
            print(json.dumps(data, ensure_ascii=False, indent=1))
        else:
            if not data["items"]:
                print("Nothing is waiting for you")
            for it in data["items"]:
                print(f"{LABEL[it['kind']]:<9} {it.get('project') or '-':<16} {it.get('title') or it.get('session') or ''} · {it.get('phrase') or ''}")
        return 0
    if op in ("allow", "deny"):
        if not a.id:
            raise SystemExit("usage: dispatch waiting allow|deny <id>")
        only = getattr(a, "request", "") or ""
        if a.id.startswith("ide:"):
            res = ide_confirm(a.id, op == "allow", request=only)
        elif a.id.startswith("chat:"):
            res = chat_confirm(a.id[len("chat:"):], op == "allow", request=only)
        else:
            res = {"ok": False, "code": "bad_id", "message": f"{a.id} is not a session waiting for a permission"}
    elif op == "pick":
        option = getattr(a, "option", None)
        if not a.id or option is None:
            raise SystemExit("usage: dispatch waiting pick <ide:… id> <option id | label | 1..9> | pick task:<id> <A|B> [--reason …]")
        if a.id.startswith("ide:"):
            res = ide_pick(a.id, option)
        elif a.id.startswith("task:"):
            # a direction from `dispatch flow design` (A / B); why goes into the person's design preferences
            import flows
            flows.D, flows.T.D = D, D
            try:
                res = flows.pick(a.id[len("task:"):], option, getattr(a, "reason", "") or "")
            except ValueError as e:
                res = {"ok": False, "code": "not_deciding", "message": str(e)}
        else:
            res = {"ok": False, "code": "bad_id", "message": f"{a.id} is not a session waiting for an answer"}
    elif op == "read":
        if not a.id and not a.all:
            raise SystemExit("usage: dispatch waiting read <id> | --all")
        failed = []
        if a.all:  # Mark all read: the rows this machine lists, not another Mac's project's leftovers
            where = places()
            ids = mark_read(None, keep=lambda it: keeps(it, where), failed=failed)
        else:
            ids = mark_read([a.id])
        res = {"ok": not failed, "read": ids, "failed": failed,
               "message": f"Marked {len(ids)} read" + (f". {MARK_READ_RETRY}" if failed else "")}
    elif op == "unread":
        if not a.id or not a.id.startswith("ide:"):
            raise SystemExit("usage: dispatch waiting unread <ide:… id>")
        res = ide_mark_unread(a.id)
    elif op == "done":
        if not a.id and not a.all:
            raise SystemExit("usage: dispatch waiting done <task>[,<task>…] | --all")
        if a.all:  # Mark all done: the board is shared, so only the tasks this machine lists close
            where = places()
            ids = done_only_you([it["task"] for it in only_you_items(board_issues()) if keeps(it, where)])
        else:
            ids = done_only_you(a.id.split(","))
        res = {"ok": True, "done": ids, "message": f"Marked {len(ids)} done"}
    elif op == "reopen":
        if not a.id:
            raise SystemExit("usage: dispatch waiting reopen <task>[,<task>…]")
        ids = reopen_tasks(a.id.split(","))
        res = {"ok": bool(ids), "reopened": ids, "message": f"Reopened {len(ids)}"}
    elif op == "snooze":
        if not a.id:
            raise SystemExit("usage: dispatch waiting snooze <task>[,<task>…] [--until tomorrow|next-week]")
        ids, t = snooze_only_you(a.id.split(","), getattr(a, "until", None) or "tomorrow")
        res = {"ok": bool(ids), "snoozed": ids, "until": t, "message": f"Hidden until {time.strftime('%a %H:%M', time.localtime(t))}"}
    elif op == "unsnooze":
        if not a.id:
            raise SystemExit("usage: dispatch waiting unsnooze <task>[,<task>…]")
        ids = unsnooze_only_you(a.id.split(","))
        res = {"ok": bool(ids), "unsnoozed": ids, "message": f"Back: {len(ids)}"}
    elif op == "reply":
        if not a.id:
            raise SystemExit("usage: dispatch waiting reply <task>")
        res = reply_to(a.id)
    elif op == "seen":
        res = {"ok": True, "seen_at": mark_seen(), "message": "Seen"}
    else:
        raise SystemExit(f"unknown op {op}")
    if a.json:
        print(json.dumps(res, ensure_ascii=False))
    else:
        print(res.get("message", ""))
    return 0 if res.get("ok") else 1
