#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Session presence hook for Dispatch.

Usage:  presence.py <agent> <event>     (hook JSON on stdin)
Writes ~/tasks/.dispatch/sessions/<agent>__<session_id>.json so Dispatch can
show every live session, where it was launched from, and whether it is busy.
Never fails the hook: any error is swallowed and exit code is 0.
"""
import json, os, re, sys, time, subprocess, glob
sys.dont_write_bytecode = True  # never write __pycache__ next to these files: inside Dispatch.app that breaks the code signature
from lang import t as _t
# ~/tasks/.dispatch/presence.py is a link (or, on Windows, a copy) of the CLI's file: find dplatform next
# to the real file. Python already puts the resolved script folder on sys.path for a symlink.
sys.path.insert(1, os.path.dirname(os.path.realpath(__file__)))
try:
    import dplatform as P
except ImportError:  # a lone copy without the CLI beside it: macOS/Linux behaviour, no Windows helpers
    P = None
IS_WIN = bool(P and P.IS_WIN)

DIR = os.path.join(os.environ.get("DISPATCH_DIR") or os.path.expanduser("~/tasks/.dispatch"), "sessions")

SHELLS = {"sh", "bash", "zsh", "fish", "-fish", "-zsh", "-bash", "login", "python3", "python", "env", "node"}
# Windows: the hook runs under Git Bash (bash.exe), cmd or PowerShell, through python/pythonw or the py launcher.
WIN_SHELLS = {"cmd", "powershell", "pwsh", "conhost", "openconsole", "py", "pythonw", "bash"}
# comm/app name → (kind, label). Matched with a leading "/" so a real bundle path
# ("/Applications/Ghostty.app/...") always matches, but "Code.app/" never fires on
# "ClaudeCode.app/" — the CLI's own self-update wrapper, not a real host app (see below).
APPS = [
    ("/Codex.app/", ("desktop", "Codex 桌面端")),
    ("/Claude.app/", ("desktop", "Claude 桌面端")),
    ("/ChatGPT.app/", ("desktop", "ChatGPT 桌面端")),
    ("/Cursor.app/", ("editor", "Cursor")),
    ("/Visual Studio Code.app/", ("editor", "VS Code")),
    ("/Code.app/", ("editor", "VS Code")),
    ("/Windsurf.app/", ("editor", "Windsurf")),
    ("/Zed.app/", ("editor", "Zed")),
    # Obsidian hosts terminal plugins too; classify() names it Claudian only for Claude Code run through the SDK.
    ("/Obsidian.app/", ("editor", "Obsidian")),
    ("/Warp.app/", ("terminal", "Warp")),
    ("/iTerm.app/", ("terminal", "iTerm2")),
    ("/Terminal.app/", ("terminal", "Terminal")),
    ("/Ghostty.app/", ("terminal", "Ghostty")),
    ("/kitty.app/", ("terminal", "kitty")),
    ("/Alacritty.app/", ("terminal", "Alacritty")),
    ("/WezTerm.app/", ("terminal", "WezTerm")),
    ("/Hyper.app/", ("terminal", "Hyper")),
]
BARE = {"herdr": ("terminal", "Herdr"), "tmux": ("terminal", "tmux"), "zellij": ("terminal", "zellij"), "screen": ("terminal", "screen")}
# The `claude` CLI re-execs itself through its own updater wrapper on the way up from any
# terminal (…/​.local/share/claude/ClaudeCode.app/Contents/MacOS/claude, then a versioned
# binary) — not a hosting app. Left unskipped, "ClaudeCode.app/" used to satisfy the bare
# "Code.app/" pattern above and get misread as VS Code, hiding the real host (e.g. Ghostty)
# one hop further up the chain.
_CLAUDE_CLI_OWN_PATH = "/.local/share/claude/"
# Windows: executable base name (lower case, no .exe) -> (kind, label). Same table as dispatch.host_app_of.
WIN_APPS = {
    "windowsterminal": ("terminal", "Windows Terminal"),
    "wt": ("terminal", "Windows Terminal"),
    "openconsole": ("terminal", "Windows 控制台"),
    "conhost": ("terminal", "Windows 控制台"),
    "code": ("editor", "VS Code"),
    "cursor": ("editor", "Cursor"),
    "windsurf": ("editor", "Windsurf"),
    "zed": ("editor", "Zed"),
    "obsidian": ("editor", "Obsidian"),
    "wezterm-gui": ("terminal", "WezTerm"),
    "alacritty": ("terminal", "Alacritty"),
    "warp": ("terminal", "Warp"),
    "claude": ("desktop", "Claude 桌面端"),
    "codex": ("desktop", "Codex 桌面端"),
    "chatgpt": ("desktop", "ChatGPT 桌面端"),
    "herdr": ("terminal", "Herdr"),
}


def _win_cli_own(comm):
    """The claude CLI itself on Windows (~/.local/bin/claude.exe, ~/.local/share/claude/...), not the
    Claude desktop app whose exe is also claude.exe."""
    c = (comm or "").replace("\\", "/").lower()
    return "/.local/bin/" in c or "/.local/share/claude/" in c or "/node_modules/" in c


def exe_base(comm):
    if P:
        return P.exe_base(comm)
    return os.path.basename(comm or "").lower()


def spawn_detached(argv):
    kw = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
              env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    if P:
        P.spawn_detached(argv, **kw)
    else:
        subprocess.Popen(argv, start_new_session=True, **kw)


# A shell command that works on a task: the session running it gets linked to that task
# (`dispatch link`). Only a command in command position counts: `dispatch log X …`,
# `bd update X --claim`, also after `&&` / `;` / `|`, `env A=b`, `bash -lc "…"`. The same words
# inside a quoted argument (`grep "dispatch log task-7nn"`, a commit message) or in a command's
# output do not. dispatch.py uses this function too; it lives here so the hook never imports the CLI.
TASK_ID_RE = re.compile(r"^[A-Za-z0-9]+-[a-z0-9]{2,8}$")
TASK_VERBS = {"claim", "log", "done", "check", "decide", "begin"}
_WRAPPERS = {"command", "exec", "nohup", "time", "noglob", "builtin", "caffeinate", "do", "then", "else", "!", "{", "if", "while", "until"}
_SHELLS = {"sh", "bash", "zsh", "fish", "dash"}


def _segments(cmd):
    """Split a command line at unquoted ; & | && || newlines and parentheses / $( / backticks."""
    out, cur, q, i = [], [], "", 0
    while i < len(cmd):
        c = cmd[i]
        if q:
            cur.append(c)
            if c == "\\" and q == '"' and i + 1 < len(cmd):
                cur.append(cmd[i + 1]); i += 2; continue
            if c == q:
                q = ""
        elif c in "'\"":
            q = c; cur.append(c)
        elif c == "\\" and i + 1 < len(cmd):
            cur.append(cmd[i:i + 2]); i += 2; continue
        elif c in ";&|\n()`":
            out.append("".join(cur)); cur = []
        elif c == "$" and cmd[i + 1:i + 2] == "(":
            out.append("".join(cur)); cur = []; i += 2; continue
        else:
            cur.append(c)
        i += 1
    out.append("".join(cur))
    return [x for x in (s.strip() for s in out) if x]


def _tokens(seg):
    import shlex
    try:
        return shlex.split(seg, comments=True)
    except ValueError:
        return seg.split()


def _scan(tokens, ids, depth):
    i = 0
    while i < len(tokens):
        t = tokens[i]
        base = os.path.basename(t)
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t) or base in _WRAPPERS:
            i += 1
            continue
        if base == "env":
            i += 1
            while i < len(tokens) and (tokens[i].startswith("-") or "=" in tokens[i]):
                i += 2 if tokens[i] in ("-u", "-C", "-S") else 1
            continue
        if base in ("timeout", "gtimeout"):
            i += 1
            while i < len(tokens) and tokens[i].startswith("-"):
                i += 1
            i += 1  # the duration
            continue
        break
    rest = tokens[i:]
    if not rest:
        return
    head = os.path.basename(rest[0])
    if head in _SHELLS and depth < 3:
        for j, t in enumerate(rest[1:], 1):
            if t.startswith("-") and "c" in t[1:] and j + 1 < len(rest):
                ids.update(task_cmd_ids(rest[j + 1], depth + 1))
                break
        return
    if head.startswith("python") and len(rest) > 1 and os.path.basename(rest[1]) == "dispatch.py":
        rest, head = rest[1:], "dispatch.py"
    if head in ("dispatch", "dispatch.py"):
        args = rest[1:]
        while len(args) >= 2 and args[0] == "--host":
            args = args[2:]
        if len(args) >= 2 and args[0] in TASK_VERBS and TASK_ID_RE.match(args[1]):
            ids.add(args[1])
    elif head == "bd" and len(rest) >= 3 and rest[1] == "update" and TASK_ID_RE.match(rest[2]) and "--claim" in rest[3:]:
        ids.add(rest[2])


def task_cmd_ids(command, depth=0):
    """Task ids a shell command works on, in order of first appearance."""
    ids = set()
    if isinstance(command, (list, tuple)):
        _scan([str(x) for x in command], ids, depth)
        return sorted(ids)
    for seg in _segments(str(command or "")):
        _scan(_tokens(seg), ids, depth)
    return sorted(ids)


# The same, through a tool of Dispatch's MCP server (dispatch_mcp.py): Claude Code names it mcp__dispatch__task_log,
# OpenCode dispatch_task_log, Codex keeps {"type": "McpToolCall", "server": "dispatch", "tool": "task_log"}.
MCP_TASK_TOOLS = {"task_claim", "task_log", "task_done", "task_check", "decide"}
MCP_TOOL_RE = re.compile(r"^(?:mcp__dispatch__|dispatch_)(\w+)$")


def _mcp_args(v):
    if isinstance(v, str) and v.lstrip().startswith("{"):
        try:
            v = json.loads(v)
        except ValueError:
            return {}
    return v if isinstance(v, dict) else {}


def mcp_task_ids(obj):
    """Task ids the calls to Dispatch's MCP tools in one transcript event (or hook payload) worked on, in order."""
    ids = []

    def walk(o, depth=0):
        if depth > 12:
            return
        if isinstance(o, list):
            for x in o:
                walk(x, depth + 1)
            return
        if not isinstance(o, dict):
            return
        tool, args = "", None
        if o.get("type") == "McpToolCall" and o.get("server") == "dispatch":
            tool, args = str(o.get("tool") or ""), o.get("arguments")
        else:
            for key in ("name", "tool", "tool_name"):
                m = MCP_TOOL_RE.match(str(o.get(key) or "")) if isinstance(o.get(key), str) else None
                if m:
                    tool = m.group(1)
                    state = o.get("state") if isinstance(o.get("state"), dict) else {}
                    args = o.get("input") or o.get("arguments") or o.get("tool_input") or o.get("args") or state.get("input")
                    break
        if tool in MCP_TASK_TOOLS:
            tid = _mcp_args(args).get("task")
            if isinstance(tid, str) and TASK_ID_RE.match(tid) and tid not in ids:
                ids.append(tid)
        for k, v in o.items():
            if k in ("toolUseResult", "output", "result", "content") and not isinstance(v, list):
                continue
            if isinstance(v, (dict, list)):
                walk(v, depth + 1)

    walk(obj)
    return ids


def task_ids(data):
    """Task ids the finished Bash call (or call to Dispatch's MCP tools) worked on; [] for anything else."""
    if not isinstance(data, dict):
        return []
    mcp = mcp_task_ids({k: data.get(k) for k in ("tool_name", "tool_input")})
    if mcp:
        return mcp
    inp = data.get("tool_input")
    cmd = inp.get("command") if isinstance(inp, dict) else ""
    if not cmd:
        return []
    if not isinstance(cmd, list) and "dispatch" not in str(cmd) and "bd" not in str(cmd):
        return []
    return task_cmd_ids(cmd)


def link_tasks(sid, data):
    """Link the session to every task its command worked on, in the background."""
    ids = task_ids(data)
    if not ids or not sid or sid.startswith("pid-"):
        return []
    cli = os.path.join(os.path.dirname(os.path.realpath(__file__)), "dispatch.py")
    if not os.path.exists(cli):
        cli = os.path.join(os.path.dirname(os.path.realpath(os.path.expanduser("~/.local/bin/dispatch"))), "dispatch.py")
    if not os.path.exists(cli):
        return []
    for tid in ids:
        spawn_detached([sys.executable or "python3", cli, "link", tid, "--session", sid])
    return ids


def _alive(pid):
    """Is the agent process still running? dplatform probes without signalling (on Windows a
    signal-0 kill is CTRL_C_EVENT and would interrupt the agent's own console group)."""
    try:
        pid = int(pid)
    except (ValueError, TypeError):
        return True  # unknowable: do not drop what was learned
    if P is None:
        return True  # no probe available: keep what was learned; the sweep still clears dead records
    return P.pid_alive(pid)


def ps_table():
    if IS_WIN:
        return P.ps_table()
    if os.name == "nt":
        return {}
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,comm="], capture_output=True, text=True, timeout=3).stdout
    t = {}
    for line in out.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            t[int(parts[0])] = (int(parts[1]), parts[2])
    return t


def classify(chain, agent="", entrypoint=""):
    """chain: list of comm strings from the hook's parent upward. Under Obsidian, Claude Code started
    through the TypeScript Agent SDK (sdk-ts) is the Claudian plugin; anything else (Codex, `claude` in a terminal plugin) is plain Obsidian."""
    kind, label = classify_win(chain) if IS_WIN else _classify_mac(chain)
    if label == "Obsidian" and agent == "claude-code" and entrypoint == "sdk-ts":
        label = "Obsidian · Claudian"
    return kind, label


def _classify_mac(chain):
    for comm in chain:
        if _CLAUDE_CLI_OWN_PATH in comm:
            continue  # the CLI's own updater wrapper — keep climbing to the real host
        for key, val in APPS:
            if key in comm:
                return val
        base = os.path.basename(comm).lstrip("-")
        if base in BARE:
            return BARE[base]
    return ("terminal", "终端")


def classify_win(chain):
    """Windows: match executable names (WindowsTerminal.exe, Code.exe, ...) up the chain. The claude
    CLI's own exe is skipped so the Claude desktop entry only fires for the real app."""
    for comm in chain:
        base = exe_base(comm)
        if base == "claude" and _win_cli_own(comm):
            continue
        if base in WIN_APPS:
            return WIN_APPS[base]
    return ("terminal", "终端")


def event_status(event, data, prev):
    """Only explicit lifecycle events change attention; a stopped turn is idle."""
    state = prev.get("state", "unknown")
    attention = prev.get("attention")
    if event in ("SessionStart", "Stop"):
        state, attention = "idle", None
    elif event == "PreToolUse" and data.get("tool_name") == "AskUserQuestion":
        state, attention = "idle", "input"  # the picker is up; the turn waits for a choice
    elif event in ("UserPromptSubmit", "PreToolUse", "PostToolUse"):
        state, attention = "working", None
    elif event == "PermissionRequest" or (event == "Notification" and data.get("notification_type") in ("permission_prompt", "elicitation_dialog")):
        state, attention = "idle", "input"
    elif event == "Notification" and data.get("notification_type") == "idle_prompt":
        state, attention = "idle", None  # Claude has been waiting for input: an interrupted turn never sent Stop
    elif event == "PostToolUseFailure" and not data.get("is_interrupt"):
        state, attention = "working", None  # The Agent handles tool errors; they are not a request for the user.
    return state, attention


def main():
    """`presence.py <agent> <event>`, the hook JSON on stdin: what pi's extension runs (agent/pi/dispatch.ts).
    Claude Code, Codex and OpenCode reach record() through Dispatch's one hook entry (hook.py)."""
    agent = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    event = sys.argv[2] if len(sys.argv) > 2 else "unknown"
    try:
        raw = getattr(sys.stdin, "buffer", None)  # the hook JSON is UTF-8 whatever the console code page says
        data = json.loads(raw.read().decode("utf-8", "replace")) if raw is not None else json.load(sys.stdin)
    except Exception:
        data = {}
    record(agent, event, data if isinstance(data, dict) else {})


def record(agent, event, data):
    """Write the session's presence record for one hook event (and push once when it starts waiting for you)."""
    sid = data.get("session_id") or data.get("thread_id") or data.get("thread-id") or os.environ.get("CLAUDE_SESSION_ID") or ""
    import engines
    if engines.foreign_session(agent, sid):
        # Claude Code's hooks replayed in an OpenCode session by an OpenCode plugin (oh-my-openagent): not a
        # Claude Code session; recording it made a ghost claude-code row and a second Timeline row
        return
    cwd = data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()

    os.makedirs(DIR, exist_ok=True)
    now = time.time()
    # This hook runs on every tool call. Who hosts the session (the whole process table, walked
    # upwards) does not change while it lives: learn it on the first event, reuse it afterwards.
    known = {}
    if sid:
        safe0 = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in sid)
        try:
            with open(os.path.join(DIR, f"{agent}__{safe0}.json"), encoding="utf-8") as f:
                known = json.load(f)
        except Exception:
            known = {}
    table = None
    if event != "SessionStart" and known.get("agent_pid") and known.get("source_kind") and _alive(known["agent_pid"]):
        agent_pid, kind, label = known["agent_pid"], known["source_kind"], known.get("source_app", "")
    else:
        table = ps_table()
        chain, agent_pid = [], None
        pid = os.getppid()
        for _ in range(25):
            ent = table.get(pid)
            if not ent or pid <= 1:
                break
            ppid, comm = ent
            base = exe_base(comm).lstrip("-") if IS_WIN else os.path.basename(comm).lstrip("-")
            shell = base in SHELLS or (IS_WIN and base in WIN_SHELLS)
            if agent_pid is None and not shell and "presence.py" not in comm and "hook.py" not in comm:
                agent_pid = pid
            chain.append(comm)
            pid = ppid
        kind, label = classify(chain, agent, os.environ.get("CLAUDE_CODE_ENTRYPOINT", ""))
    if not sid:
        sid = f"pid-{agent_pid or os.getppid()}"

    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in sid)
    path = os.path.join(DIR, f"{agent}__{safe}.json")

    if event == "SessionEnd":
        try:
            import workers
            workers.release_session(sid)
        except Exception:
            pass  # the PID/presence check also releases stale claims after an unavailable board
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        return

    prev = {}
    try:
        with open(path, encoding="utf-8") as f:
            prev = json.load(f)
    except Exception:
        pass
    state, attention = event_status(event, data, prev)
    rec = {
        "agent": agent,
        "session_id": sid,
        "cwd": cwd,
        "project": os.path.basename(os.path.normpath(cwd)) or cwd,
        "agent_pid": agent_pid,
        "source_kind": kind,
        "source_app": label,
        "entrypoint": os.environ.get("CLAUDE_CODE_ENTRYPOINT", ""),
        "started_at": prev.get("started_at", now),
        "last_event": event,
        "last_at": now,
        "state": state,
        "attention": attention,
        "state_source": "hook",
        "prompts": prev.get("prompts", 0) + (1 if event == "UserPromptSubmit" else 0),
        "permission_mode": data.get("permission_mode") or prev.get("permission_mode"),
        "tool": data.get("tool_name") if event == "PreToolUse" else None,
    }
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False)
    if P:
        P.replace_retry(tmp, path)  # Windows refuses the rename while a reader has the record open
    else:
        os.replace(tmp, path)

    if event == "PostToolUse":
        try:
            link_tasks(sid, data)
        except Exception:
            pass

    # The session just started waiting for the user: push it once, not on every hook event.
    if attention == "input":
        # In the background: a push is a network call (up to 10 s) and the agent waits for its hooks.
        try:
            here = os.path.dirname(os.path.realpath(__file__))
            sibling = os.path.join(here, "notify.py")
            if not os.path.exists(sibling):  # this copy lives in ~/tasks/.dispatch; the CLI is elsewhere
                sibling = os.path.join(os.path.dirname(os.path.realpath(os.path.expanduser("~/.local/bin/dispatch"))), "notify.py")
            if os.path.exists(sibling):
                spawn_detached([sys.executable or "python3", sibling, _t(f"{agent} is waiting for your reply", f"{agent} 在等你回复"), _t(f"{rec['project']} ({rec['source_app']})", f"{rec['project']}（{rec['source_app']}）"), "--level", "high", "--key", f"presence:{agent}:{sid}"])
        except Exception:
            pass

    # Sweep records whose process is gone (crashes, closed windows) — SessionEnd does not always
    # fire. At most once a minute: it reads every record and needs the process table.
    stamp = os.path.join(DIR, ".swept")
    try:
        if now - os.stat(stamp).st_mtime < 60:
            return
    except OSError:
        pass
    try:
        with open(stamp, "w"):
            pass
    except OSError:
        pass
    table = table if table is not None else ps_table()
    if not table:
        return  # no process table (unreadable): every record would look dead
    for p in glob.glob(os.path.join(DIR, "*.json")):
        try:
            with open(p, encoding="utf-8") as f:
                r = json.load(f)
            ap = r.get("agent_pid")
            if ap and ap not in table and now - r.get("last_at", 0) > 60:
                os.remove(p)
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
