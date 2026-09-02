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


def main():
    agent = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    event = sys.argv[2] if len(sys.argv) > 2 else "unknown"
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    sid = data.get("session_id") or os.environ.get("CLAUDE_SESSION_ID") or ""
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
    state = {"SessionStart": "idle", "UserPromptSubmit": "working", "Stop": "idle"}.get(event, prev.get("state", "idle"))
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
        "prompts": prev.get("prompts", 0) + (1 if event == "UserPromptSubmit" else 0),
    }
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(rec, f, ensure_ascii=False)
    os.replace(tmp, path)

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
