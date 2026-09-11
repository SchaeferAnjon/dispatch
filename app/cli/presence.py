#!/usr/bin/env python3
"""Session presence hook for Dispatch.

Usage:  presence.py <agent> <event>     (hook JSON on stdin)
Writes ~/tasks/.dispatch/sessions/<agent>__<session_id>.json so Dispatch can
show every live session, where it was launched from, and whether it is busy.
Never fails the hook: any error is swallowed and exit code is 0.
"""
import json, os, sys, time, subprocess, glob

DIR = os.path.expanduser("~/tasks/.dispatch/sessions")

SHELLS = {"sh", "bash", "zsh", "fish", "-fish", "-zsh", "-bash", "login", "python3", "python", "env", "node"}
# comm/app name → (kind, label)
APPS = [
    ("Codex.app/", ("desktop", "Codex 桌面端")),
    ("Claude.app/", ("desktop", "Claude 桌面端")),
    ("ChatGPT.app/", ("desktop", "ChatGPT 桌面端")),
    ("Cursor.app/", ("editor", "Cursor")),
    ("Visual Studio Code.app/", ("editor", "VS Code")),
    ("Code.app/", ("editor", "VS Code")),
    ("Windsurf.app/", ("editor", "Windsurf")),
    ("Zed.app/", ("editor", "Zed")),
    ("Warp.app/", ("terminal", "Warp")),
    ("iTerm.app/", ("terminal", "iTerm2")),
    ("Terminal.app/", ("terminal", "Terminal")),
    ("Ghostty.app/", ("terminal", "Ghostty")),
    ("kitty.app/", ("terminal", "kitty")),
    ("Alacritty.app/", ("terminal", "Alacritty")),
    ("WezTerm.app/", ("terminal", "WezTerm")),
    ("Hyper.app/", ("terminal", "Hyper")),
]
BARE = {"herdr": ("terminal", "Herdr"), "tmux": ("terminal", "tmux"), "zellij": ("terminal", "zellij"), "screen": ("terminal", "screen")}


def ps_table():
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,comm="], capture_output=True, text=True, timeout=3).stdout
    t = {}
    for line in out.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            t[int(parts[0])] = (int(parts[1]), parts[2])
    return t


def classify(chain):
    """chain: list of comm strings from the hook's parent upward."""
    for comm in chain:
        for key, val in APPS:
            if key in comm:
                return val
        base = os.path.basename(comm).lstrip("-")
        if base in BARE:
            return BARE[base]
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


def install_claude_hooks(path=None):
    """Add attention signals without replacing other extensions' hooks."""
    path = path or os.path.expanduser("~/.claude/settings.json")
    with open(path) as f:
        settings = json.load(f)
    hooks = settings.setdefault("hooks", {})
    for event in ("PermissionRequest", "Notification", "PreToolUse", "PostToolUse", "PostToolUseFailure"):
        command = f'python3 "$HOME/tasks/.dispatch/presence.py" claude-code {event} # dispatch-presence'
        groups = hooks.setdefault(event, [])
        if not any("dispatch-presence" in h.get("command", "") for g in groups for h in g.get("hooks", [])):
            groups.append({"hooks": [{"type": "command", "command": command}]})
    tmp = path + ".dispatch-tmp"
    with open(tmp, "w") as f:
        json.dump(settings, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.chmod(tmp, os.stat(path).st_mode & 0o777)
    os.replace(tmp, path)


def main():
    if sys.argv[1:] == ["--install-claude-hooks"]:
        install_claude_hooks()
        return
    agent = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    event = sys.argv[2] if len(sys.argv) > 2 else "unknown"
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    sid = data.get("session_id") or data.get("thread_id") or data.get("thread-id") or os.environ.get("CLAUDE_SESSION_ID") or ""
    cwd = data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()

    table = ps_table()
    chain, agent_pid = [], None
    pid = os.getppid()
    for _ in range(25):
        ent = table.get(pid)
        if not ent or pid <= 1:
            break
        ppid, comm = ent
        base = os.path.basename(comm).lstrip("-")
        if agent_pid is None and base not in SHELLS and "presence.py" not in comm:
            agent_pid = pid
        chain.append(comm)
        pid = ppid
    if not sid:
        sid = f"pid-{agent_pid or os.getppid()}"
    kind, label = classify(chain)

    os.makedirs(DIR, exist_ok=True)
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in sid)
    path = os.path.join(DIR, f"{agent}__{safe}.json")
    now = time.time()

    if event == "SessionEnd":
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        return

    prev = {}
    try:
        with open(path) as f:
            prev = json.load(f)
    except Exception:
        pass
    state, attention = event_status(event, data, prev)
    rec = {
        "agent": agent,
        "session_id": sid,
        "cwd": cwd,
        "project": os.path.basename(cwd.rstrip("/")) or cwd,
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
    with open(tmp, "w") as f:
        json.dump(rec, f, ensure_ascii=False)
    os.replace(tmp, path)

    # The session just started waiting for the user: push it once, not on every hook event.
    if attention == "input":
        try:
            sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
            import notify
            notify.send(f"{agent} 在等你回复", f"{rec['project']}（{rec['source_app']}）", level="high", key=f"presence:{agent}:{sid}")
        except Exception:
            pass

    # Sweep records whose process is gone (crashes, closed windows) — SessionEnd
    # does not always fire.
    for p in glob.glob(os.path.join(DIR, "*.json")):
        try:
            with open(p) as f:
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
