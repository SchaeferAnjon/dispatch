# -*- coding: utf-8 -*-
"""Dispatch's own MCP server: the way every agent works with the board (`dispatch mcp serve`, `dispatch mcp register`).

Claude Code, Codex and OpenCode each start `dispatch mcp serve --agent <engine>` as a local MCP server (stdio, no
network, nothing to configure). Its tools are the board's: start, claim and log a task, its plan, deliverables and
completion, Waiting for you, handoffs, preferences, the wiki, the person's profile, a delivery page. The server
runs outside the agent's sandbox (an engine starts its MCP servers itself), so Codex's default permissions write the
board too; before, a sandboxed Codex had to drop request files into a mailbox for chatd to pick up (task-yb4c).

What a tool may do is fixed here. Each one builds the argument list of one `dispatch` command from typed fields and
runs this CLI's own dispatch.py with it: never another program, never a command line of the caller's choosing,
never `--host` (another Mac), and values never turn into options. A delivery page writes into its folder, so that
folder has to be inside the session's working folder.

Which session called: Claude Code starts one server per session and gives it CLAUDE_CODE_SESSION_ID; Codex names
the thread in each call (`_meta.threadId`); OpenCode's Dispatch plugin adds the session to the arguments of these
tools (`dispatch_session`). The data folders follow the agent's environment (DISPATCH_DIR, BEADS_DIR …), so a test
instance's agents write the instance's board; Codex passes only the variables named in its `env_vars`.

Registration (`register`) adds the server to the three engines' own MCP files through mcp_config, the same writes
`dispatch mcp add` makes. A server of the person's that is called "dispatch" is left alone. Codex runs these tools
without asking (default_tools_approval_mode = "approve") and Claude Code gets `mcp__dispatch` in its allow list:
they only ever touch Dispatch's own records, as the mailbox did. Removing the server (`dispatch mcp remove dispatch`)
is remembered, so the Agents window does not put it back at its next start; `dispatch mcp register` does.
"""
import json
import os
import re
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
NAME = "dispatch"
VERSION_FILE = os.path.join(HERE, "VERSION")
PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
RUN_TIMEOUT = 110          # one command; Codex is told to wait 120 s for a tool
MAX_OUTPUT = 30000         # characters of a command's answer handed back
MAX_TEXT = 200_000         # characters of one text argument
SESSION_ARG = "dispatch_session"  # OpenCode's plugin puts its session id here (never in a tool's schema)
# The variables the server needs from the agent's environment. Claude Code and OpenCode pass their whole
# environment; Codex only these (env_vars), besides HOME, PATH, USER and the like.
PASS_ENV = ("DISPATCH_DIR", "DISPATCH_HOME", "BEADS_DIR", "DISPATCH_SKILL_POOL", "DISPATCH_SESSION_ROOT",
            "DISPATCH_PROFILE_FILE", "DISPATCH_FACTS_FILE", "DISPATCH_TASTE_FILE", "DISPATCH_DESIGN_FILE",
            "DISPATCH_BOARD_SERVICE", "DISPATCH_IDE_USER_DATA_DIR", "DISPATCH_IDE_USER_DATA_DIRS",
            "XDG_CONFIG_HOME", "XDG_DATA_HOME", "DISPATCH_SESSION_ID", "DISPATCH_E2E_INSTANCE")
INSTRUCTIONS = ("Dispatch's task board and records for this person. Use these tools for tasks (begin, claim, log, plan, "
                "deliver, done), Waiting for you, handoffs, preferences, the wiki and the person's profile, instead of "
                "running the `dispatch` command. They act as this session; you never need to pass a session id.")

TASK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")


class ToolError(ValueError):
    """A call the tool refuses before running anything; the message goes back to the agent."""


# ---------------------------------------------------------------- the tools

def _s(desc, **kw):
    return dict(type="string", description=desc, **kw)


def _list(desc):
    return dict(type="array", items={"type": "string"}, description=desc)


def _schema(props, required=()):
    return {"type": "object", "properties": props, "required": list(required), "additionalProperties": False}


TASK = _s("The task id, e.g. task-ab12")
PROJECT = _s("The project's name on the board (usually the folder's name)")


class Tool:
    def __init__(self, name, title, description, props, required, build, read_only=False, stdin=None):
        self.name, self.title, self.description = name, title, description
        self.schema = _schema(props, required)
        self.build, self.read_only, self.stdin = build, read_only, stdin

    def listing(self):
        return {"name": self.name, "title": self.title, "description": self.description, "inputSchema": self.schema,
                "annotations": {"title": self.title, "readOnlyHint": self.read_only, "destructiveHint": False,
                                "idempotentHint": self.read_only, "openWorldHint": False}}


def text(args, key, required=True):
    """A text argument: a string, at most MAX_TEXT characters, not empty when required."""
    v = args.get(key)
    if v is None or v == "":
        if required:
            raise ToolError(f"{key} is required")
        return ""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        v = str(v)
    if not isinstance(v, str) or "\0" in v:
        raise ToolError(f"{key} must be text")
    if len(v) > MAX_TEXT:
        raise ToolError(f"{key} is longer than {MAX_TEXT} characters")
    return v


def task_id(args, key="task", required=True):
    v = text(args, key, required)
    if v and not TASK_ID.match(v):
        raise ToolError(f"{key} must be a task id such as task-ab12")
    return v


def texts(args, key):
    v = args.get(key)
    if v in (None, "", []):
        return []
    if isinstance(v, str):
        v = [v]
    if not isinstance(v, list):
        raise ToolError(f"{key} must be a list of text")
    return [text({key: x}, key) for x in v]


def flag(args, key):
    v = args.get(key)
    if v in (None, False, "", "false", 0):
        return False
    if v in (True, "true", 1):
        return True
    raise ToolError(f"{key} must be true or false")


def number(args, key):
    v = args.get(key)
    if v in (None, ""):
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise ToolError(f"{key} must be a whole number")
    if n < 0 or n > 100000:
        raise ToolError(f"{key} is out of range")
    return n


def numbers(args, key):
    """A list of step numbers, given as [1, 2] or "1,2"."""
    v = args.get(key)
    if v in (None, "", []):
        return ""
    items = v if isinstance(v, list) else str(v).split(",")
    out = []
    for x in items:
        out.append(str(number({key: str(x).strip()}, key)))
    return ",".join(out)


def opt(name, value):
    """`--name=value`: one argument, so a value that starts with '-' never reads as an option."""
    return [f"--{name}={value}"] if value not in (None, "", False) else []


def words(value):
    """Free text given as a positional argument. One that starts with '-' gets a space in front, so neither this
    CLI's argument parser nor bd's reads it as an option (`--` does not work after a sub-command's options)."""
    return [" " + value if value.startswith("-") else value]


def choice(args, key, allowed, required=False):
    v = text(args, key, required)
    if v and v not in allowed:
        raise ToolError(f"{key} must be one of: " + ", ".join(allowed))
    return v


def _begin(a):
    acc = "\n".join(x if x.lstrip().startswith("- [") else "- [ ] " + x for x in texts(a, "acceptance"))
    return (["begin", *opt("project", text(a, "project", False)), *opt("desc", text(a, "description")),
             *opt("thing", text(a, "thing", False)), *opt("acceptance", acc), *opt("owns", text(a, "owns", False)),
             "--json", *words(text(a, "title"))])


def _log(a):
    return ["log", task_id(a), *opt("claim", text(a, "claim", False)), *words(text(a, "text"))]


def _plan(a):
    steps = texts(a, "steps")
    done, active = numbers(a, "done"), number(a, "active")
    if not steps and not done and active is None:
        raise ToolError("give steps (the whole plan) or done / active (step numbers)")
    return ["task", "plan", task_id(a), *[f"--set={s}" for s in steps], *opt("done", done),
            *opt("active", "" if active is None else str(active))]


def _deliver(a):
    commit = a.get("commit")
    parts = []
    if commit is True or (isinstance(commit, str) and commit.strip().lower() in ("head", "true")):
        parts.append("--commit")
    elif commit and not (isinstance(commit, str) and commit.strip().lower() == "false"):
        c = text(a, "commit")
        if not re.match(r"^[0-9a-fA-F]{4,40}$", c):
            raise ToolError("commit must be a commit hash, or true for the newest commit of the working folder")
        parts.append(f"--commit={c}")
    parts += opt("url", text(a, "url", False)) + opt("file", text(a, "file", False)) + opt("draft", text(a, "draft", False))
    if not parts:
        raise ToolError("give one of commit, url, file or draft")
    return ["task", "deliver", task_id(a), *parts, *opt("label", text(a, "label", False)), *(["--show"] if flag(a, "show") else [])]


def _done(a):
    if any(x.startswith("-") for x in texts(a, "next")):
        raise ToolError("next: task titles do not start with '-'")
    return ["done", task_id(a), *opt("reason", text(a, "reason")), *(["--verified"] if flag(a, "verified") else []),
            *(["--next", *texts(a, "next")] if texts(a, "next") else [])]


def _task_list(a):
    status = choice(a, "status", ("all", "open", "done"))
    days = number(a, "days")
    project = text(a, "project", False)
    session = "" if project else session_of(env_now())
    if not project and not session:
        raise ToolError("give project: this session's id is not known here")
    return ["task", "list", *opt("project", project), *opt("session", session), *opt("status", status),
            *opt("days", "" if days is None else str(days)), "--json"]


def _need_you(a):
    return ["need-you", *opt("project", text(a, "project")), *opt("desc", text(a, "how")),
            *opt("why", text(a, "why", False)), *opt("task", task_id(a, "task", False)), "--json", *words(text(a, "what"))]


def _now(a):
    return ["now", *words(text(a, "text"))]


SESSION_KEY = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.:/-]{7,200}$")


def _handoff_write(a):
    session = text(a, "session", False)
    if session and not SESSION_KEY.match(session):
        raise ToolError("session is the one Dispatch named in its handoff request")
    request = text(a, "request", False)
    if request and not re.match(r"^[A-Za-z0-9_.:-]{1,120}$", request):
        raise ToolError("request is the id Dispatch gave in its handoff request")
    task = task_id(a, "task", False)
    return ["handoff", "write", *([task] if task else []), *opt("session", session), *opt("request", request), "--stdin", "--json"]


def _prefs_add(a):
    kind = choice(a, "kind", ("like", "avoid"), required=True)
    sentence = text(a, "sentence")
    if sentence.strip() == "-":
        raise ToolError("sentence must say what to do")
    return ["prefs", "add", f"--{kind}", *opt("quote", text(a, "quote")), *opt("name", text(a, "name", False)),
            *opt("area", choice(a, "area", ("design", "workflow", "writing", "tools"))),
            *opt("scope", text(a, "scope", False)), *opt("part", text(a, "part", False)),
            *[f"--replaces={r}" for r in texts(a, "replaces")], "--json", *words(sentence)]


def _prefs_list(a):
    return ["prefs", "list", *opt("area", choice(a, "area", ("design", "workflow", "writing", "tools"))),
            *opt("project", text(a, "project", False)), "--json"]


def _wiki_add(a):
    kind = choice(a, "kind", ("pit", "win", "howto"), required=True)
    return ["wiki", "add", f"--kind={kind}", *opt("fix", text(a, "fix", False)), *opt("why", text(a, "why", False)),
            *opt("project", text(a, "project", False)), *opt("task", task_id(a, "task", False)), *words(text(a, "text"))]


def _wiki_search(a):
    return ["wiki", "search", *words(text(a, "query"))]


def _wiki_show(a):
    key = text(a, "key")
    if key.startswith("-"):
        raise ToolError("key is the entry's key from wiki_search")
    return ["wiki", "show", key]


def _profile_add(a):
    when = text(a, "upcoming", False)
    if when:
        if not re.match(r"^\d{4}-\d{2}-\d{2}", when):
            raise ToolError("upcoming starts with a date: 2026-11-02|what|todo")
        return ["profile", "upcoming", when, *words(text(a, "fact"))]
    return ["profile", "add", *words(text(a, "fact"))]


def _delivery_page(a):
    kind = choice(a, "kind", ("impl", "proposal"))
    return ["deliver", task_id(a), *opt("from", text(a, "folder")), *opt("kind", kind), *opt("title", text(a, "title", False)),
            *opt("model", text(a, "model", False)), *(["--show"] if flag(a, "show") else []), "--json"]


TOOLS = [
    Tool("task_begin", "Start a task",
         "Put one request of the person's on the board as a new task and take it as this session's. Use it before working on a new "
         "request (not for a follow-up or a small change to the last one). Returns the task id.",
         {"title": _s("What and how, then why, in the person's words: \"<thing> <change>: <why>\" (8 to 80 characters)"),
          "project": _s("The project's name on the board (usually the folder's name); leave it out in a session without a "
                        "project folder (Chats): its tasks belong to no project"),
          "description": _s("What triggered it and the expected result (20 characters or more)"),
          "thing": _s("The matter it belongs to: a short name (about 12 characters); the same name carries on an existing thing"),
          "acceptance": _list("Your own checklist, one item each"),
          "owns": _s("Files, folders or globs this task will change, comma separated (parallel work)")},
         ("title", "description"), _begin),
    Tool("task_claim", "Take a task", "Take an existing task as this session's.", {"task": TASK}, ("task",),
         lambda a: ["claim", task_id(a)]),
    Tool("task_log", "Log progress", "Record real progress on a task (what was done, the evidence).",
         {"task": TASK, "text": _s("The progress, in a sentence or two"),
          "claim": _s("Optional: checklist item numbers this progress completes, e.g. 2 or 2,3")}, ("task", "text"), _log),
    Tool("task_plan", "Set a task's plan",
         "A task's plan is 2 to 5 short directions the person reads. `steps` replaces the plan; `done` and `active` mark steps by number.",
         {"task": TASK, "steps": _list("The whole plan, 2 to 5 short directions"),
          "done": {"type": "array", "items": {"type": "integer"}, "description": "Numbers of the steps done (1-based)"},
          "active": {"type": "integer", "description": "The number of the step being done now"}}, ("task",), _plan),
    Tool("task_check", "Tick a checklist item", "Tick items of a task's own checklist with the evidence.",
         {"task": TASK, "items": _s("Item numbers (2 or 2,3) or a keyword"), "claim": _s("The evidence: commit, test result, file:line")},
         ("task", "items", "claim"), lambda a: ["check", task_id(a), *opt("claim", text(a, "claim")), *words(text(a, "items"))]),
    Tool("task_deliver", "Attach a deliverable",
         "Record what the person can open for a task: a commit, a URL, a file or a draft. `show` also opens it in Dispatch's right panel.",
         {"task": TASK, "commit": {"type": ["string", "boolean"], "description": "A commit hash, or true for the newest commit of the working folder"},
          "url": _s("A URL"), "file": _s("A file path"), "draft": _s("A draft: a file or one sentence"), "label": _s("A short label"),
          "show": {"type": "boolean", "description": "Also open it in the right panel"}}, ("task",), _deliver),
    Tool("task_done", "Finish a task",
         "Close a task you finished: what was delivered and how you checked it. You decide when it is done; do not close unfinished work.",
         {"task": TASK, "reason": _s("What was delivered and how you checked it"),
          "verified": {"type": "boolean", "description": "You actually checked that the delivered work works"},
          "next": _list("Follow-up task titles")}, ("task", "reason"), _done),
    Tool("task_show", "Read a task", "A task's details: title, description, plan, log, checklist, deliverables.",
         {"task": TASK}, ("task",), lambda a: ["task", "show", task_id(a), "--json"], read_only=True),
    Tool("task_list", "List tasks", "This session's tasks, or a project's (the last 30 days, plus any still open).",
         {"project": _s("A project's name instead of this session"), "status": _s("all, open or done"),
          "days": {"type": "integer", "description": "How many days back (default 30; 0 = all)"}}, (), _task_list, read_only=True),
    Tool("task_follow", "Link to earlier work", "Mark a task as carrying on an earlier one (they form one line in the graph).",
         {"task": TASK, "previous": _s("The earlier task's id")}, ("task", "previous"),
         lambda a: ["task", "follow", task_id(a), task_id(a, "previous")]),
    Tool("task_things", "List a project's things", "The things (matters) a project's tasks belong to, to reuse a name in task_begin.",
         {"project": PROJECT}, ("project",), lambda a: ["task", "things", *opt("project", text(a, "project")), "--json"], read_only=True),
    Tool("task_own", "Claim files for a task",
         "Register files, folders or globs a task will change (or give some up), so parallel sessions are warned.",
         {"task": TASK, "add": _s("Paths or globs to add, comma separated"), "remove": _s("Paths or globs to give up, comma separated")},
         ("task",), lambda a: ["task", "own", task_id(a), *opt("add", text(a, "add", False)), *opt("rm", text(a, "remove", False))]),
    Tool("decide", "Record a decision", "Record a sentence the person decided (\"go with this version\") on a task.",
         {"task": TASK, "text": _s("The decision, in a sentence")}, ("task", "text"),
         lambda a: ["decide", task_id(a), *words(text(a, "text"))]),
    Tool("need_you", "Ask the person to do something",
         "Put something only the person can do (send, pay, sign in, decide) on the board under Waiting for you.",
         {"what": _s("What the person has to do, in one sentence"), "project": PROJECT, "how": _s("Why, and how to do it"),
          "why": _s("One or two sentences of background"), "task": _s("The task it comes from")},
         ("what", "project", "how"), _need_you),
    Tool("todo_add", "Note something for later",
         "Put something the person mentioned for later on the project's To do (nobody works on it until someone starts it). "
         "Reply \"Noted\" and nothing more.",
         {"title": _s("What to do, in the person's words"), "project": PROJECT, "description": _s("What and why"),
          "thing": _s("The matter it belongs to (optional short name)")}, ("title", "project"),
         lambda a: ["assistant", "add", *opt("project", text(a, "project")), *opt("desc", text(a, "description", False)),
                    *opt("thing", text(a, "thing", False)), "--json", *words(text(a, "title"))]),
    Tool("now", "Say what you are doing", "One plain line about what this session is doing right now, shown first in the Now tab.",
         {"text": _s("What you are doing, a few plain words")}, ("text",), _now),
    Tool("handoff_write", "Write a handoff",
         "Hand a task over to the next session: goal, what is done with its evidence, what is running, next steps, pitfalls.",
         {"task": _s("The task (leave out only when the session has none)"),
          "text": _s("JSON with goal, completed (a list, each with its evidence), running, next, pitfalls, orchestration, agents; "
                     "or Markdown with ## 目标, ## 已完成与证据 and ## 下一步"),
          "session": _s("Only when Dispatch's handoff request names one"), "request": _s("Only when Dispatch's handoff request gives one")},
         ("text",), _handoff_write, stdin="text"),
    Tool("handoff_show", "Read a handoff", "The latest handoff of a task or a session.",
         {"target": _s("A task id or a session id")}, ("target",), lambda a: ["handoff", "show", task_id(a, "target"), "--json"], read_only=True),
    Tool("prefs_add", "Remember a preference",
         "Record how the person wants something to look, read or be done (or not), in their words. It takes effect at once.",
         {"sentence": _s("One sentence an agent can follow"), "kind": _s("like or avoid"), "quote": _s("The person's own words"),
          "name": _s("A short name to cite it by"), "area": _s("design, workflow, writing or tools"),
          "scope": _s("everywhere (default), <project> or <project>:<screen>"), "part": _s("The delivered file and region it is about: <file>#<region>"),
          "replaces": _list("Short names of older preferences it replaces")}, ("sentence", "kind", "quote"), _prefs_add),
    Tool("prefs_list", "Read preferences", "The person's preferences, with their words and evidence.",
         {"area": _s("design, workflow, writing or tools"), "project": _s("Only those that apply to this project")}, (), _prefs_list, read_only=True),
    Tool("wiki_search", "Search the wiki", "Shared lessons (pitfalls and what worked) before a tricky change.",
         {"query": _s("A few words")}, ("query",), _wiki_search, read_only=True),
    Tool("wiki_show", "Read a wiki entry", "One wiki entry by its key.", {"key": _s("The entry's key")}, ("key",), _wiki_show, read_only=True),
    Tool("wiki_add", "Add to the wiki", "Record a trap and its fix (pit), something that worked (win) or a how-to.",
         {"kind": _s("pit, win or howto"), "text": _s("The symptom, or what worked"), "fix": _s("pit: the fix"), "why": _s("win: why it works"),
          "project": _s("The project"), "task": _s("The task")}, ("kind", "text"), _wiki_add),
    Tool("profile_add", "Note something about the person",
         "Record a fact about the person, their devices or an upcoming date, without asking.",
         {"fact": _s("The fact, in a sentence"), "upcoming": _s("For a future event: date|what|todo, e.g. 2026-11-02|flight home|todo")},
         ("fact",), _profile_add),
    Tool("delivery_page", "Make a delivery page",
         "Turn a folder of screenshots and notes.md into Dispatch's delivery page, attach it to the task and register it in Docs. "
         "The folder must be inside this session's working folder.",
         {"task": TASK, "folder": _s("The folder with the screenshots and notes.md"), "kind": _s("impl (what was built) or proposal (two directions)"),
          "title": _s("The page title in the person's words"), "model": _s("Who made it, e.g. \"Opus 5.5 · high\""),
          "show": {"type": "boolean", "description": "Also open it in the right panel"}}, ("task", "folder"), _delivery_page),
]
BY_NAME = {t.name: t for t in TOOLS}


# ---------------------------------------------------------------- one call

_CALL = threading.local()


def env_now():
    """The environment the current call runs with (Context.for_call), for a tool that needs its session."""
    return getattr(_CALL, "env", None) or os.environ


def session_of(env):
    """The session a call comes from: what the OpenCode plugin or Codex said, else what Claude Code exported."""
    for name in ("DISPATCH_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"):
        v = (env.get(name) or "").strip()
        if re.match(r"^[A-Za-z0-9_-]{8,120}$", v):
            return v
    return ""

def _inside(path, roots):
    real = os.path.realpath(path)
    return any(real == r or real.startswith(r.rstrip(os.sep) + os.sep) for r in (os.path.realpath(x) for x in roots if x))


def instance_scoped(env):
    """In a test instance (DISPATCH_E2E_INSTANCE), its own board and data folders, as its CLI shim sets them: an agent
    may carry the person's own BEADS_DIR (Claude Code's settings.json "env" sets it for everything Claude starts)."""
    name = env.get("DISPATCH_E2E_INSTANCE") or ""
    if not name:
        return env
    try:
        import ide_e2e
        import pwd
        # the record sits in the Dispatch folder of whoever started the instance; inside it DISPATCH_HOME is the instance's
        real = os.path.join(pwd.getpwuid(os.getuid()).pw_dir, ".dispatch", "state", "instances", ide_e2e.check_name(name) + ".json")
        for path in (ide_e2e.record_path(ide_e2e.check_name(name)), real):
            try:
                with open(path, encoding="utf-8") as f:
                    rec = json.load(f)
            except (OSError, ValueError):
                continue
            if env.get("DISPATCH_SESSION_ROOT") and os.path.realpath(env["DISPATCH_SESSION_ROOT"]) != os.path.realpath(rec.get("root") or ""):
                continue  # another instance of that name
            return {**env, **ide_e2e.scoped_env(rec)}
    except Exception:  # noqa: BLE001 - no record: the variables the agent passed are all there is
        pass
    return env


class Context:
    """Who is calling: the engine, its session and its working folders (from the call's _meta, the arguments the
    OpenCode plugin adds, or the server's own environment)."""

    def __init__(self, agent="", env=None, cwd=""):
        self.agent = agent
        self.env = instance_scoped(dict(os.environ if env is None else env))
        self.cwd = cwd or os.getcwd()

    def for_call(self, meta, args):
        env = dict(self.env)
        roots = [self.cwd]
        meta = meta if isinstance(meta, dict) else {}
        thread = meta.get("threadId") or meta.get("sessionId")
        turn = meta.get("x-codex-turn-metadata") if isinstance(meta.get("x-codex-turn-metadata"), dict) else {}
        thread = thread or turn.get("thread_id")
        if isinstance(thread, str) and re.match(r"^[A-Za-z0-9_-]{8,120}$", thread):
            env["CODEX_THREAD_ID"] = thread
        work = turn.get("workspaces")
        if isinstance(work, dict):
            roots = [w for w in work if isinstance(w, str) and os.path.isabs(w) and os.path.isdir(w)] + roots
        session = args.pop(SESSION_ARG, None)
        if isinstance(session, str) and re.match(r"^[A-Za-z0-9_-]{8,120}$", session):
            env["DISPATCH_SESSION_ID"] = session
        if self.agent:
            env["BEADS_ACTOR"] = env["DISPATCH_ACTOR"] = self.agent
        env.update(DISPATCH_CALLER="agent", PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
        return env, roots


def call(tool_name, args, ctx, meta=None, runner=None):
    """Run one tool: (text, is_error)."""
    tool = BY_NAME.get(tool_name)
    if tool is None:
        return f"Unknown tool: {tool_name}", True
    args = dict(args) if isinstance(args, dict) else {}
    env, roots = ctx.for_call(meta, args)
    _CALL.env = env
    try:
        unknown = sorted(set(args) - set(tool.schema["properties"]))
        if unknown:
            raise ToolError("unknown argument: " + ", ".join(unknown))
        argv = tool.build(args)
        if tool.name == "delivery_page":
            folder = text(args, "folder")
            folder = folder if os.path.isabs(folder) else os.path.join(roots[0], folder)
            if not _inside(folder, roots):
                raise ToolError("the folder must be inside this session's working folder (" + roots[0] + ")")
            argv = [x if not x.startswith("--from=") else "--from=" + folder for x in argv]
        stdin = text(args, tool.stdin) if tool.stdin else ""
    except ToolError as e:
        return str(e), True
    if any(x == "--host" or x.startswith("--host=") for x in argv):
        return "invalid arguments", True  # never another Mac
    run = runner or _run
    code, out, err = run(argv, env, roots[0], stdin)
    answer = (out or "").strip()
    if code != 0:
        answer = "\n".join(x for x in (answer, (err or "").strip()) if x) or f"dispatch {argv[0]} failed ({code})"
    if len(answer) > MAX_OUTPUT:
        answer = answer[:MAX_OUTPUT] + "\n… (cut here)"
    return answer or "OK", code != 0


def _run(argv, env, cwd, stdin):
    cmd = [sys.executable, os.path.join(HERE, "dispatch.py"), *argv]
    try:
        r = subprocess.run(cmd, input=stdin or "", capture_output=True, text=True, encoding="utf-8", errors="replace",
                           cwd=cwd if os.path.isdir(cwd) else None, env=env, timeout=RUN_TIMEOUT)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", f"dispatch {argv[0]} did not answer within {RUN_TIMEOUT} seconds"
    except OSError as e:
        return 2, "", str(e)


# ---------------------------------------------------------------- the server (MCP over stdio: one JSON-RPC message per line)

def _version():
    try:
        with open(VERSION_FILE, encoding="utf-8") as f:
            return f.read().strip() or "dev"
    except OSError:
        return "dev"


class Server:
    def __init__(self, ctx, out=None, runner=None):
        self.ctx, self.out, self.runner = ctx, out or sys.stdout, runner
        self.lock = threading.Lock()
        self.threads = []

    def send(self, msg):
        line = json.dumps(msg, ensure_ascii=False)
        with self.lock:
            self.out.write(line + "\n")
            self.out.flush()

    def reply(self, ident, result=None, error=None):
        msg = {"jsonrpc": "2.0", "id": ident}
        if error is not None:
            msg["error"] = error
        else:
            msg["result"] = result
        self.send(msg)

    def handle(self, msg):
        if not isinstance(msg, dict):
            return
        method, ident, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
        if ident is None or not isinstance(method, str):
            return  # notifications (initialized, cancelled) and stray responses need no answer
        if method == "initialize":
            asked = params.get("protocolVersion") if isinstance(params, dict) else ""
            client = (params.get("clientInfo") or {}).get("name", "") if isinstance(params, dict) else ""
            if not self.ctx.agent:
                self.ctx.agent = agent_of_client(client)
            self.reply(ident, {"protocolVersion": asked if asked in PROTOCOLS else PROTOCOLS[0],
                               "capabilities": {"tools": {"listChanged": False}},
                               "serverInfo": {"name": NAME, "title": "Dispatch", "version": _version()},
                               "instructions": INSTRUCTIONS})
        elif method == "ping":
            self.reply(ident, {})
        elif method == "tools/list":
            self.reply(ident, {"tools": [t.listing() for t in TOOLS]})
        elif method == "tools/call":
            name = params.get("name") if isinstance(params, dict) else None
            args = params.get("arguments") if isinstance(params, dict) else None
            meta = params.get("_meta") if isinstance(params, dict) else None

            def work():
                try:
                    answer, failed = call(name, args or {}, self.ctx, meta, self.runner)
                except Exception as e:  # noqa: BLE001 - one bad call must not end the server
                    answer, failed = f"Dispatch could not run {name}: {e}", True
                self.reply(ident, {"content": [{"type": "text", "text": answer}], "isError": failed})
            t = threading.Thread(target=work, daemon=True)
            self.threads.append(t)
            t.start()
        elif method in ("resources/list", "prompts/list"):
            self.reply(ident, {method.split("/")[0]: []})
        else:
            self.reply(ident, error={"code": -32601, "message": f"Method not found: {method}"})

    def serve(self, lines):
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                self.send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
                continue
            for m in (msg if isinstance(msg, list) else [msg]):
                self.handle(m)
        for t in self.threads:
            t.join(RUN_TIMEOUT + 5)


def agent_of_client(client):
    """The board name of the engine an MCP client belongs to, from its clientInfo name."""
    client = (client or "").lower()
    for word, agent in (("claude", "claude-code"), ("codex", "codex"), ("opencode", "opencode")):
        if word in client:
            return agent
    return ""


def serve(agent=""):
    stdin = open(sys.stdin.fileno(), encoding="utf-8", errors="replace", closefd=False)
    sys.stdout = open(sys.stdout.fileno(), "w", encoding="utf-8", closefd=False)
    Server(Context(agent=agent)).serve(stdin)
    return 0


# ---------------------------------------------------------------- registration in each engine's MCP file

def engines():
    """The engines Dispatch runs whose MCP servers it writes: Claude Code, Codex, OpenCode."""
    import engines as E
    return [e for e in E.runnable() if e.supports("mcp_file")]


def spec(agent):
    """What `dispatch mcp add` would write for the server in one engine."""
    import init_wizard as I
    import mcp_config as M
    s = M.blank_spec()
    s.update(command=I.hook_python(), args=[os.path.join(HERE, "dispatch.py"), "mcp", "serve", "--agent", agent],
             pass_env=list(PASS_ENV), trusted=True, timeout=RUN_TIMEOUT + 10)
    return s


def is_ours(row):
    """A server named dispatch that is this server (any copy of the CLI), not one of the person's own."""
    args = [str(x) for x in row.get("args") or []]
    line = " ".join([str(row.get("command") or ""), *args])
    return bool(re.search(r"(^|[/\s])dispatch(\.py)?\s+mcp\s+serve(\s|$)", line))


def _state():
    import init_wizard as I
    return I.load_state()


def turned_off():
    return _state().get("mcp_server") == "off"


def remember(on):
    import init_wizard as I
    I.save_state(mcp_server="on" if on else "off")


def set_up():
    import builtin_agents
    return builtin_agents.set_up()


def wanted(env=None):
    """The engines that get the server: those picked in setup and those already on this Mac (their folder exists)."""
    import mcp_config as M
    picked = set(_state().get("agents") or [])
    p = M.paths(env)
    out = []
    for e in engines():
        folder = os.path.dirname(p[e.agent])
        home = e.home_dir(M.instance_home() or M.home()) if e.config_home else ""
        if e.agent in picked or (home and os.path.isdir(home)) or (not e.mcp_in_home and os.path.isdir(folder)):
            out.append(e)
    return out


def register(agents=None, if_set_up=False, env=None, by_hand=True, paths=None, allow=True):
    """Add (or bring up to date) the server in each engine. {"changed": [...], "same": [...], "skipped": [...]}
    by_hand: the person asked (`dispatch mcp register`), which also undoes an earlier removal; setup and the Agents
    window's start (if_set_up) leave a removal as it is. paths: {engine: file} to write instead of the engine's own
    (a test instance's CODEX_HOME); allow: also let the engine run the tools without asking where that is a setting."""
    import engines as E
    import mcp_config as M
    if if_set_up and not set_up():
        return {"skipped": [{"engine": "", "reason": "not set up yet"}], "changed": [], "same": []}
    if by_hand and not if_set_up:
        remember(True)
    elif turned_off():
        return {"skipped": [{"engine": "", "reason": "turned off (dispatch mcp remove dispatch); dispatch mcp register turns it back on"}], "changed": [], "same": []}
    targets = [E.get(a) for a in agents] if agents else wanted(env)
    files = {**M.paths(env), **(paths or {})}
    changed, same, skipped = [], [], []
    for eng in targets:
        if eng not in engines():
            skipped.append({"engine": eng.agent, "reason": "Dispatch does not run it"})
            continue
        path = files[eng.agent]
        want = spec(eng.agent)
        try:
            have = next((r for r in (eng.mcp_rows(path) if os.path.isfile(path) else []) if r["name"] == NAME and r["scope"] == "user"), None)
        except (ValueError, OSError) as e:
            skipped.append({"engine": eng.agent, "reason": f"could not read {path}: {e}"[:300]})
            continue
        if have and not is_ours(have):
            skipped.append({"engine": eng.agent, "reason": f"you have a server of your own called {NAME} there; it was left as it is"})
            continue
        if have and have["command"] == want["command"] and have["args"] == want["args"] and eng.mcp_current(path, NAME, want):
            same.append(eng.agent)
        else:
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                backup = eng.mcp_edit(path, NAME, want)
                changed.append({"engine": eng.agent, "path": path, "backup": backup or "", "action": "added"})
            except (ValueError, OSError) as e:
                skipped.append({"engine": eng.agent, "reason": str(e)[:300]})
                continue
        if not allow:
            continue
        try:
            allowed = eng.mcp_allow(NAME, home=M.instance_home() or M.home())
            if allowed:
                changed.append({"engine": eng.agent, "path": allowed, "action": "allowed its tools"})
        except (OSError, ValueError) as e:
            skipped.append({"engine": eng.agent, "reason": f"could not allow its tools: {e}"[:300]})
    return {"name": NAME, "changed": changed, "same": same, "skipped": skipped}


ABOUT = ("Lets your agents use Dispatch's task board, plans, Waiting for you, preferences and the wiki. "
         "It runs on this Mac only and touches nothing but Dispatch's own records.")
IF_OFF = "Agents no longer note tasks, plans and deliveries on Dispatch's board by themselves."


def turn_off(env=None):
    """Settings › Soul: Dispatch's server out of every engine (only where it is this server, not a server of the
    person's own called dispatch), remembered, so the Agents window does not put it back. {"name", "on", "changed", "skipped"}"""
    import mcp_config as M
    remember(False)
    changed, skipped = [], []
    for row in M.listing(env=env)["servers"]:
        if row["name"] == NAME and row["scope"] == "user" and row.get("builtin"):
            r = M.change(NAME, None, [row["engine"]], env=env)
            changed += r["changed"]
            skipped += r["skipped"]
    return {"name": NAME, "on": False, "changed": changed, "skipped": skipped}


def turn_on(env=None):
    """Settings › Soul: Dispatch's server back in each engine (the same as `dispatch mcp register`)."""
    r = register(env=env)
    return dict(r, on=True)


def status(env=None):
    """Per engine: is the server in, is it this copy, are its tools allowed."""
    import mcp_config as M
    rows = {(r["engine"], r["name"]): r for r in M.listing(env=env)["servers"] if r["scope"] == "user"}
    out = []
    for eng in engines():
        have = rows.get((eng.agent, NAME))
        want = spec(eng.agent)
        out.append({"engine": eng.agent, "path": M.paths(env)[eng.agent], "present": bool(have), "ours": bool(have and is_ours(have)),
                    "current": bool(have and have["command"] == want["command"] and have["args"] == want["args"]),
                    "enabled": bool(have and have.get("enabled"))})
    return {"name": NAME, "off": turned_off(), "engines": out, "tools": [t.name for t in TOOLS]}


def command(a):
    op = a.op
    if op == "serve":
        return serve(getattr(a, "agent", "") or "")
    if op in ("on", "off"):
        r = turn_on() if op == "on" else turn_off()
        if a.json:
            print(json.dumps(r, ensure_ascii=False, indent=1))
        else:
            for c in r["changed"]:
                print(f"{c['engine']}: {c['action']} ({c['path']})")
            print("Dispatch's tools are " + ("on." if op == "on" else "off. `dispatch mcp on` turns them back on."))
        return 0
    if op == "register":
        picked = [x.strip() for x in (a.engine or "").split(",") if x.strip()]
        r = register(picked or None, if_set_up=getattr(a, "if_set_up", False))
    else:
        r = status()
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=1))
    elif op == "register":
        for c in r["changed"]:
            print(f"{c['engine']}: {c['action']} ({c['path']})")
        for e in r.get("same", []):
            print(f"{e}: already in place")
        for s in r["skipped"]:
            print((s["engine"] + ": " if s["engine"] else "") + "skipped, " + s["reason"])
    else:
        print("Dispatch's MCP server" + (" (turned off)" if r["off"] else "") + ": " + ", ".join(r["tools"]))
        for e in r["engines"]:
            print(f"  {e['engine']}: " + ("not added" if not e["present"] else "someone else's server" if not e["ours"] else "in place" if e["current"] else "an older copy") + f"  {e['path']}")
    return 0
