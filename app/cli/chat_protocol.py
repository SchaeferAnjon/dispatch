# -*- coding: utf-8 -*-
"""The in-app chat protocol: what `dispatch chatd` reads on stdin, what it writes on stdout, and
the adapter interface an agent driver (chat_claude.py, chat_codex.py) implements.

Mirror: app/src/chatProtocol.ts. Change both together; test_chat_protocol.py and
chatProtocol.test.ts pin the names that must agree.

Topology
    React ── invoke(chat_command {line}) ──▶ Rust ── one JSON line on chatd stdin ──▶ chatd
    chatd ── one JSON line per event on stdout ──▶ Rust ── app.emit("chat://all", evt) and
                                                            app.emit("chat://<session>", evt) ──▶ React

Wire format
    Every line is one JSON object, UTF-8, no embedded newlines. Commands carry `cmd`; events carry
    `ev`. Every event also carries `seq` (chatd-wide, increasing), `ts` (unix seconds, float) and,
    when it belongs to a session, `session`. A command that carries `request_id` yields exactly one
    reply: its natural event (see COMMANDS[...]["reply"]) or an `error` with the same `request_id`.

Session identity
    `session` is the same key activity.py uses: "<agent>:<id>" with agent in AGENTS, e.g.
    "claude-code:5f1c…-uuid", "codex:019…-thread-id" or "opencode:ses_…". For a new Claude session
    chatd generates the uuid and passes `--session-id`; a new Codex session gets its id from
    `thread/start`, an OpenCode one from ACP's `session/new`. All are the transcript's own id, so
    history comes from the existing transcript parsers and the live events only layer on top.

Lifecycle (per session)
    starting → idle ⇄ running ⇄ (waiting_permission | waiting_input) → stopping → stopped
    `error` is terminal for the process; the key stays resumable with `open {resume}`.

Single writer (Claude Code has no lock; two writers fork the transcript silently)
    chatd allows one headless process per session. `open {resume}` refuses with `writer_conflict`
    when a live TUI (hook record / process scan) holds that id; the UI then offers the
    `session-control release` path.
"""
import json
import os
import re
import time

import engines as _engines

PROTOCOL_VERSION = 1

# The oldest version of each engine its chat driver was verified against is its adapter's chat_min_version
# (engines/<id>.py); older versions are refused at `hello` and at `open`.

# The session-key prefixes of the engines with a chat driver (engines/<id>.py chat_driver): claude-code, codex, opencode.
AGENTS = tuple(e.agent for e in _engines.runnable())

# Tauri event channels. Rust emits every chatd line on EVENT_ALL and, when the line has a
# session, on event_channel(session) as well. Session-less events (hello, sessions, chatd) only
# reach EVENT_ALL.
EVENT_ALL = "chat://all"


def event_channel(session):
    return "chat://" + session


# ---------------------------------------------------------------- limits and files
TEXT_LIMIT = 16000            # characters of one user message (matches `reply send`)
OUTPUT_LIMIT = 16000          # characters of one tool output kept in `tool_end.output`
IMAGE_LIMIT = 8 * 1024 * 1024  # bytes of one base64-decoded image
QUEUE_LIMIT = 20              # messages waiting per session
IDLE_REAP_SECONDS = 30 * 60   # a headless Claude process idle this long is closed (resumed on the next send)
REPLAY_LIMIT = 4000           # events of the current turn chatd keeps for `replay`
REGISTRY_FILE = "chatd.json"  # under DISPATCH_DIR: {"pid", "started", "sessions": {key: {...}}}, read by activity.py for `runner`


def registry_path(dispatch_dir):
    return os.path.join(dispatch_dir, REGISTRY_FILE)


# Sessions chatd started or took over, kept after they stop: `claude -p` writes entrypoint "sdk-cli"
# into the transcript, which the lists would otherwise file under 定时 (script runs).
STARTED_FILE = "chat-sessions.json"  # {key: first-opened unix time}
STARTED_LIMIT = 5000
_started_cache = {}


def started_path(dispatch_dir):
    return os.path.join(dispatch_dir, STARTED_FILE)


def read_started(dispatch_dir):
    """{key: ts} of every session that ever ran in Dispatch (cached by mtime; {} when missing)."""
    path = started_path(dispatch_dir)
    try:
        mtime = os.stat(path).st_mtime_ns
    except OSError:
        return {}
    hit = _started_cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    data = data if isinstance(data, dict) else {}
    _started_cache[path] = (mtime, data)
    return data


def mark_started(dispatch_dir, key, now=None):
    """Remember `key` as a Dispatch conversation. Never raises."""
    try:
        data = dict(read_started(dispatch_dir))
        if key in data:
            return
        data[key] = now or time.time()
        if len(data) > STARTED_LIMIT:
            data = dict(sorted(data.items(), key=lambda kv: kv[1])[-STARTED_LIMIT:])
        os.makedirs(dispatch_dir, exist_ok=True)
        path = started_path(dispatch_dir)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except OSError:
        pass


# ---------------------------------------------------------------- vocabularies
LIFECYCLES = ("starting", "idle", "running", "waiting_permission", "waiting_input", "stopping", "stopped", "error")
# Claude Code's own names; the Codex adapter maps approvalPolicy/sandbox onto the same four.
PERMISSION_MODES = ("default", "acceptEdits", "plan", "bypassPermissions")
DECISIONS = ("allow", "allow_session", "deny")
PERMISSION_KINDS = ("command", "edit", "read", "fetch", "permission", "question", "other")
TOOL_KINDS = ("shell", "edit", "read", "search", "agent", "web", "question", "other")
TURN_STATUSES = ("success", "interrupted", "error")
CLOSE_REASONS = ("requested", "idle", "exited", "error", "shutdown")
SEND_MODES = ("queue", "interrupt")

# Tool name → kind. Claude Code tool names and Codex item types both land here.
_TOOL_KIND_RULES = (
    ("shell", {"Bash", "bash", "commandExecution", "exec_command", "shell", "run_command", "PowerShell"}),
    ("edit", {"Edit", "Write", "MultiEdit", "NotebookEdit", "fileChange", "apply_patch", "applyPatch"}),
    ("read", {"Read", "read_file", "fileRead"}),
    ("search", {"Grep", "Glob", "LS", "grep", "glob"}),
    ("agent", {"Agent", "Task", "agent", "task", "subAgent"}),
    ("web", {"WebFetch", "WebSearch", "webSearch", "web_search", "fetch"}),
    ("question", {"AskUserQuestion", "requestUserInput"}),
)


def tool_kind(name):
    for kind, names in _TOOL_KIND_RULES:
        if name in names:
            return kind
    return "other"


# ---------------------------------------------------------------- what a tool call is doing, in plain words
# 「在改 chatd.py 的 Door 类」「在跑 npm test」「在看 App.tsx」: the right panel's step line and the
# conversation's status line. Mirror: stepPhrase in chatProtocol.ts; both tests read the same cases
# (app/src/stepPhrase.cases.json), so the two sides say the same sentence for the same call.
PHRASE_ARG_MAX = 32
_SYMBOL_RE = re.compile(r"^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:pub(?:\([a-z]+\))?[ \t]+)?(?:async[ \t]+)?(class|def|function|interface|struct|fn|func)[ \t]+([A-Za-z_$][\w$]*)", re.M)
_SYMBOL_WORD = {"class": "class", "struct": "struct", "interface": "interface", "def": "function", "function": "function", "fn": "function", "func": "function"}


def _short(text, n=PHRASE_ARG_MAX):
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= n else text[: n - 1] + "…"


def _base(path):
    path = str(path or "").rstrip("/\\")
    return re.split(r"[/\\]", path)[-1] if path else ""


def command_brief(command):
    """The part of a shell command a person reads: first line, without a leading `cd <dir> &&`."""
    if isinstance(command, (list, tuple)):
        command = " ".join(str(c) for c in command)
        m = re.match(r"^(?:/bin/)?(?:ba|z)?sh -l?c (.*)$", command, re.S)
        if m:
            command = m.group(1)
    text = str(command or "").strip().split("\n")[0]
    text = re.sub(r"^cd\s+(?:\"[^\"]*\"|'[^']*'|\S+)\s*(?:&&|;)\s*", "", text)
    return _short(text)


def _symbol(inp):
    for key in ("old_string", "new_string", "content"):
        m = _SYMBOL_RE.search(str(inp.get(key) or ""))
        if m:
            return m.group(2), _SYMBOL_WORD[m.group(1)]
    return None


def step_phrase(name, inp=None):
    """One short sentence for a tool call: Edit/Write → 在改 X（的 Y 函数）, Read → 在看 X,
    Bash → 在跑 <命令>, Grep/Glob → 在找 …, Agent → Delegated to a subagent."""
    inp = inp if isinstance(inp, dict) else {}
    kind = tool_kind(name)
    path = inp.get("file_path") or inp.get("path") or inp.get("notebook_path") or ""
    if kind == "shell":
        brief = command_brief(inp.get("command") or inp.get("cmd") or "")
        return f"Running {brief}" if brief else "Running a command"
    if kind == "edit":
        if not path and isinstance(inp.get("changes"), list) and inp["changes"]:
            first = inp["changes"][0] if isinstance(inp["changes"][0], dict) else {}
            path = first.get("path") or ""
            if len(inp["changes"]) > 1:
                return f"Editing {len(inp['changes'])} files, including {_base(path)}"
        name_ = _base(path) or "a file"
        sym = _symbol(inp)
        return f"Editing {sym[1]} {sym[0]} in {name_}" if sym else f"Editing {name_}"
    if kind == "read":
        return f"Reading {_base(path)}" if path else "Reading a file"
    if kind == "search":
        if name in ("LS",):
            return f"Listing {_base(path) or 'a folder'}"
        pattern = inp.get("pattern") or inp.get("query") or ""
        where = _base(path)
        if not pattern:
            return "Finding files"
        return f"Searching for {_short(pattern, 24)}" + (f" in {where}" if where else "")
    if kind == "agent":
        return "Delegated to a subagent"
    if kind == "web":
        q = inp.get("query") or ""
        if q:
            return f"Searching the web for {_short(q, 24)}"
        url = str(inp.get("url") or "")
        host = re.sub(r"^[a-z]+://", "", url).split("/")[0]
        return f"Reading {host}" if host else "Reading a web page"
    if kind == "question":
        return "Waiting for your answer"
    if name in ("TodoWrite", "update_plan"):
        return "Planning"
    return f"Using {name}"


# ---------------------------------------------------------------- commands (stdin)
# name → {"fields": required keys, "optional": allowed extra keys, "reply": the natural reply event}
COMMANDS = {
    # Handshake; also the version check. Reply lists per-agent availability and support.
    "hello": {"fields": (), "optional": ("protocol",), "reply": "hello"},
    # Start or resume a headless session. `resume` is the transcript id (without the agent prefix).
    "open": {"fields": ("agent", "cwd"), "optional": ("resume", "model", "permission_mode", "effort", "task", "label", "moving"), "reply": "opened"},
    # A user message. `images`: [{"media_type","data"}] base64 or [{"path"}] absolute. `mode`
    # matters only while a turn runs: queue = after this turn, interrupt = stop it and send now.
    # `display`: what the bubble (turn_started.text, the queue) shows when the agent gets more than
    # the person typed (`@codebase` appends search results to `text`). Before the message goes out
    # chatd snapshots the project (checkpoint.py); turn_started carries that snapshot's id.
    "send": {"fields": ("session", "message_id", "text"), "optional": ("images", "mode", "display"), "reply": "turn_started|queued"},
    # Take a queued message back (the UI puts the words into the composer).
    "withdraw": {"fields": ("session", "message_id"), "optional": (), "reply": "queue"},
    "interrupt": {"fields": ("session",), "optional": (), "reply": "turn_done"},
    # Answer a permission_request. `message` goes with deny; `updated_input` with allow (Claude).
    "permission": {"fields": ("session", "permission_id", "decision"), "optional": ("message", "updated_input"), "reply": "permission_resolved"},
    # Answer a question card: {question_id: [answer, ...]}.
    "answer": {"fields": ("session", "permission_id", "answers"), "optional": (), "reply": "permission_resolved"},
    "set_model": {"fields": ("session", "model"), "optional": ("effort",), "reply": "state"},
    "set_permission_mode": {"fields": ("session", "mode"), "optional": (), "reply": "state"},
    # Slash commands / skills the agent accepts (Claude: initialize's list; Codex: skills/list).
    "commands": {"fields": ("session",), "optional": (), "reply": "commands"},
    # Re-emit the current turn's events (page remounted mid-turn), then a `state`.
    "replay": {"fields": ("session",), "optional": (), "reply": "state"},
    # A line for the agent, e.g. 你撤销了 install-device.sh 第 2 处. chatd answers
    # with a `system` notice (kind "notice") the page shows, and prepends every pending note as "[system] …" to
    # the next `send` of this session, so the agent reads it at the start of its next turn.
    "note": {"fields": ("session", "text"), "optional": (), "reply": "system"},
    # Stop the headless process. Codex: forget the thread only.
    "close": {"fields": ("session",), "optional": ("reason",), "reply": "closed"},
    "list": {"fields": (), "optional": (), "reply": "sessions"},
    "shutdown": {"fields": (), "optional": (), "reply": "chatd"},
}

# ---------------------------------------------------------------- events (stdout)
# Field notes live in chatProtocol.ts next to the TypeScript types; the set here pins the names.
EVENTS = (
    "hello",                # {protocol, chatd_version, agents: {agent: {available, version, supported, reason}}, platform}
    "chatd",                # {state: "up"|"down"|"restarting", pid?, reason?}
    "attention",            # {host, attention?, online?, stream?}: a peer's Waiting counts
    "opened",               # {session, agent, cwd, resumed, model, permission_mode, transcript_path, capabilities}
    "state",                # {session, lifecycle, model, permission_mode, effort?, queue, pending, turn_id?, since, pid?}
    "turn_started",         # {session, turn_id, message_id, text, images_n, checkpoint?}
    "text_delta",           # {session, turn_id, text}
    "text_done",            # {session, turn_id, text}
    "thinking_delta",       # {session, turn_id, text}
    "thinking_done",        # {session, turn_id, text, tokens?, duration_ms}
    "tool_start",           # {session, turn_id, tool_id, name, kind, input, summary, parent_tool_id?}
    "tool_end",             # {session, turn_id, tool_id, ok, output, truncated, exit_code?, duration_ms, diff?}
    "permission_request",   # {session, turn_id, permission_id, kind, tool_id?, tool_name, input, summary, reason, cwd?, diff?, options, questions?}
    "permission_resolved",  # {session, permission_id, decision, by}
    "queued",               # {session, message_id, position}
    "queue",                # {session, queue: [{message_id, text, images_n, at}]}
    "diff_updated",         # {session, turn_id, files: [{path, add, del}], patch?}
    "turn_done",            # {session, turn_id, status, error?, duration_ms, cost_usd?, usage?, num_tools}
    "rate_limit",           # {session?, agent, windows: [{label, used_percent, resets_at}]}
    "system",               # {session, kind: "hook"|"init"|"notice", text}
    "life_usage",           # request-level usage; chatd consumes it for context lifetime
    "error",                # {session?, request_id?, code, message, fatal}
    "closed",               # {session, reason, exit_code?}
    "sessions",             # {sessions: [state...]}
    "commands",             # {session, commands: [{name, description, kind}]}
)

ERROR_CODES = (
    "bad_request",          # malformed line / unknown cmd / missing field
    "unsupported_version",  # agent binary older than *_MIN_VERSION or protocol handshake failed
    "agent_missing",        # binary not on PATH
    "spawn_failed",         # could not start the process
    "daemon_down",          # codex app-server daemon not reachable (after one restart attempt)
    "no_such_session",      # session not open in chatd
    "session_busy",         # e.g. set_model while a turn runs (Claude refuses)
    "writer_conflict",      # a live TUI holds this transcript; release it first
    "moved_away",           # `dispatch move` handed this conversation to another Mac; this copy is read-only
    "owner_elsewhere",      # the folder's project belongs to another Mac (dispatch-project-owners); its Agents start there
    "not_running",          # interrupt while idle
    "too_large",            # text/image over the limit
    "invalid_model",        # model / mode not accepted
    "process_exited",       # the agent process died mid-turn
    "queue_full",
    "unsupported",          # the adapter has no such capability (e.g. allow_session on Codex)
)

# Per-session `opened.capabilities`; the UI hides what an adapter cannot do.
CAPABILITIES = ("allow_session", "set_model", "set_permission_mode", "effort", "thinking_text", "diff_events", "images_base64", "images_path", "queue", "commands")


class ChatError(Exception):
    """An error the protocol can carry: `code` from ERROR_CODES; `fatal` ends the session."""

    def __init__(self, code, message, fatal=False):
        super().__init__(message)
        self.code = code if code in ERROR_CODES else "bad_request"
        self.fatal = bool(fatal)

    def event(self, session=None, request_id=None):
        e = {"ev": "error", "code": self.code, "message": str(self), "fatal": self.fatal}
        if session:
            e["session"] = session
        if request_id:
            e["request_id"] = request_id
        return e


# ---------------------------------------------------------------- keys, versions, env
_ID = r"[A-Za-z0-9][A-Za-z0-9_.:-]{2,120}"  # OpenCode's ids have underscores (ses_…)
KEY_RE = re.compile(r"^(" + "|".join(re.escape(a) for a in AGENTS) + r"):(" + _ID + r")$")


def session_key(agent, session_id):
    if agent not in AGENTS:
        raise ChatError("bad_request", f"unknown agent {agent!r}")
    if not re.fullmatch(_ID, session_id or ""):
        raise ChatError("bad_request", "invalid session id")
    return f"{agent}:{session_id}"


def split_key(key):
    """'claude-code:abc' → ('claude-code', 'abc'); ChatError on anything else."""
    m = KEY_RE.match(key or "")
    if not m:
        raise ChatError("bad_request", f"invalid session key {key!r}")
    return m.group(1), m.group(2)


def parse_version(text):
    """'2.1.282 (Claude Code)' → (2, 1, 282); () when there is no number."""
    m = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", text or "")
    return (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)) if m else ()


def version_ok(version, minimum):
    return bool(version) and tuple(version) >= tuple(minimum)


# Variables an agent's own shell leaves behind. A headless child that inherits them believes it
# is a sub-session (Claude then turns transcript saving off) or a Dispatch agent caller. The
# terminal multiplexer's own (Herdr, tmux, zellij) come along when Dispatch.app was launched from a
# pane: an agent that keeps them thinks it lives in that pane and aims pane commands at it.
_ENV_PREFIXES = ("HERDR_", "ZELLIJ")
_ENV_NAMES = {"DISPATCH_SESSION_ID", "DISPATCH_CALLER", "DISPATCH_ACTOR", "DISPATCH_TERMINAL_SESSION", "TMUX", "TMUX_PANE"}


def child_env(env=None):
    import engines
    src = os.environ if env is None else env
    return {k: v for k, v in engines.agent_env(src).items() if not k.startswith(_ENV_PREFIXES) and k not in _ENV_NAMES}


# ---------------------------------------------------------------- helpers shared by chatd and adapters
def truncate_output(text, limit=OUTPUT_LIMIT):
    """(text, truncated): keep the head and the tail, the middle is where nobody reads."""
    text = text if isinstance(text, str) else str(text or "")
    if len(text) <= limit:
        return text, False
    head = limit * 2 // 3
    tail = limit - head - 40
    return text[:head] + f"\n… [{len(text) - head - tail} characters cut] …\n" + text[-tail:], True


def validate_command(obj):
    """Check one parsed stdin line against COMMANDS. Returns the command name; raises ChatError."""
    if not isinstance(obj, dict):
        raise ChatError("bad_request", "a command is a JSON object")
    cmd = obj.get("cmd")
    spec = COMMANDS.get(cmd or "")
    if not spec:
        raise ChatError("bad_request", f"unknown command {cmd!r}")
    missing = [f for f in spec["fields"] if f not in obj]
    if missing:
        raise ChatError("bad_request", f"{cmd}: missing {', '.join(missing)}")
    unknown = [k for k in obj if k not in ("cmd", "request_id") and k not in spec["fields"] and k not in spec["optional"]]
    if unknown:
        raise ChatError("bad_request", f"{cmd}: unknown field {', '.join(sorted(unknown))}")
    if "session" in obj:
        split_key(obj["session"])
    if cmd == "open" and obj["agent"] not in AGENTS:
        raise ChatError("bad_request", f"unknown agent {obj['agent']!r}")
    if cmd == "send":
        if not isinstance(obj["text"], str) or (not obj["text"].strip() and not obj.get("images")):
            raise ChatError("bad_request", "send: text is empty")
        if len(obj["text"]) > TEXT_LIMIT:
            raise ChatError("too_large", f"send: text over {TEXT_LIMIT} characters")
        if obj.get("mode", "queue") not in SEND_MODES:
            raise ChatError("bad_request", "send: mode is queue or interrupt")
        if "display" in obj and (not isinstance(obj["display"], str) or len(obj["display"]) > TEXT_LIMIT):
            raise ChatError("bad_request", f"send: display is text of at most {TEXT_LIMIT} characters")
    if cmd == "permission" and obj["decision"] not in DECISIONS:
        raise ChatError("bad_request", "permission: decision is allow, allow_session or deny")
    if cmd == "set_permission_mode" and obj["mode"] not in PERMISSION_MODES:
        raise ChatError("invalid_model", f"unknown permission mode {obj['mode']!r}")
    if cmd == "note":
        if not isinstance(obj["text"], str) or not obj["text"].strip():
            raise ChatError("bad_request", "note: text is empty")
        if len(obj["text"]) > TEXT_LIMIT:
            raise ChatError("too_large", f"note: text over {TEXT_LIMIT} characters")
    if cmd == "close" and obj.get("reason", "requested") not in CLOSE_REASONS:
        raise ChatError("bad_request", "close: unknown reason")
    return cmd


class Emitter:
    """Stamps events with seq/ts/session and hands them to `write` (chatd: one JSON line to stdout).
    Adapters get a bound emitter per session so they never touch stdout themselves."""

    def __init__(self, write):
        self.write = write
        self.seq = 0

    def emit(self, ev, session=None, **fields):
        if ev not in EVENTS:
            raise ValueError(f"unknown event {ev!r}")
        self.seq += 1
        e = {"ev": ev, "seq": self.seq, "ts": round(time.time(), 3)}
        if session:
            e["session"] = session
        e.update(fields)
        self.write(json.dumps(e, ensure_ascii=False, separators=(",", ":")))
        return e

    def bound(self, session):
        return lambda ev, **fields: self.emit(ev, session=session, **fields)


class Adapter:
    """One live agent session as chatd drives it. chatd owns the queue, the session table and the
    idle reaper; the adapter owns the process / connection and turns the agent's own events into
    the normalized ones (calling `emit(ev, **fields)` with the events listed in EVENTS, session
    already bound). Every method is called from chatd's single loop thread; an adapter that reads
    its process on another thread must hand events over through a queue chatd drains
    (`drain()`), not call `emit` from that thread.

    Methods raise ChatError on refusal. `start` must end with `opened` then `state`; a turn must
    end with `turn_done` (so chatd can send the next queued message) even after a crash
    (status "error", code process_exited)."""

    agent = ""
    capabilities = ()

    def __init__(self, emit, session, cwd, options):
        self.emit = emit
        self.session = session
        self.cwd = cwd
        self.options = dict(options or {})
        self.lifecycle = "starting"
        self.turn_id = None
        self.since = time.time()

    # -- required
    def start(self, resume=None):
        raise NotImplementedError

    def send(self, message):
        """message: {message_id, text, images: [{media_type, data} | {path}]}. Emits turn_started."""
        raise NotImplementedError

    def interrupt(self):
        raise NotImplementedError

    def permission(self, permission_id, decision, message=None, updated_input=None):
        raise NotImplementedError

    def close(self, reason="requested"):
        raise NotImplementedError

    def alive(self):
        raise NotImplementedError

    # -- optional (default: unsupported)
    def answer(self, permission_id, answers):
        raise ChatError("unsupported", "this agent takes no answers here")

    def set_model(self, model, effort=None):
        raise ChatError("unsupported", "this agent cannot switch models here")

    def set_permission_mode(self, mode):
        raise ChatError("unsupported", "this agent cannot switch permission modes here")

    def commands(self):
        return []

    def drain(self):
        """Called by chatd's loop every tick and after every command: emit what the reader thread
        collected. Return True when something was emitted."""
        return False

    def state(self):
        """The `state` event body (chatd adds queue and session)."""
        return {"lifecycle": self.lifecycle, "model": self.options.get("model", ""), "permission_mode": self.options.get("permission_mode", ""),
                "effort": self.options.get("effort"), "turn_id": self.turn_id, "since": self.since, "pending": []}


# The adapter of each agent is its engine's chat_driver (engines/<id>.py), imported lazily so one missing driver never
# breaks the other. Each adapter module also exposes `probe() -> {available, version, supported, reason}` for `hello`.
