# -*- coding: utf-8 -*-
"""How much the agents may do on their own: one of three plain choices, asked on first run and changeable later.

    ask-every   Always ask              (nothing happens without a yes)
    ask-risky   Ask for risky actions   (editing files in the project is allowed, commands still ask)
    auto        Full auto               (the default, the user's call on 2026-10-01: no questions, Orca's "YOLO")

The choice is kept in DISPATCH_DIR/autonomy.json. It reaches the agents two ways:
  - sessions Dispatch starts itself (chatd, the phone): `chat_mode(level, agent)` is the permission mode the
    session opens with (Claude Code `--permission-mode`, Codex approval policy and sandbox through the same
    names, OpenCode only knows "no questions"); chatd applies it when a session is opened without one.
  - sessions of the Agents window: `ide_approvals(level)` is the value of the window's
    `chat.defaultConfiguration` approvals setting, which sets every new session's permission level; the
    bridge (`dispatch.firstRun`) writes it. Claude Code and Codex have approvals of their own there, which the
    window sets from it (Full auto: Claude's bypassPermissions, Codex's Full Access, task-ngwit). A session's own
    permission picker still overrides it.

`dispatch autonomy [set <level>] [--json]` reads and writes it.
"""
import json
import os
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULT = "auto"
LEVELS = [
    {"id": "ask-every", "title": "Always ask",
     "detail": "Agents wait for your OK before they change a file or run a command. "
               "Codex has no such level: it works inside the project on its own and asks before anything outside it."},
    {"id": "ask-risky", "title": "Ask for risky actions",
     "detail": "Agents edit files in your project on their own and ask before running commands."},
    {"id": "auto", "title": "Full auto",
     "detail": "Agents change files and run commands without asking, so they can also delete or overwrite things."},
]
IDS = tuple(l["id"] for l in LEVELS)

_CHAT_MODE = {"ask-every": "", "ask-risky": "acceptEdits", "auto": "bypassPermissions"}
_IDE_APPROVALS = {"ask-every": "manual", "ask-risky": "assisted", "auto": "allowAll"}


def path():
    d = os.environ.get("DISPATCH_DIR")
    if not d:
        sys.path.insert(0, HERE)
        import engines
        d = engines.DISPATCH_DIR
    return os.path.join(d, "autonomy.json")


def load():
    """{level, saved}: the saved level, else the default (Full auto)."""
    try:
        with open(path(), encoding="utf-8") as f:
            level = (json.load(f) or {}).get("level")
    except (OSError, ValueError, AttributeError):
        level = None
    return {"level": level if level in IDS else DEFAULT, "saved": level in IDS}


def save(level):
    if level not in IDS:
        raise ValueError("Pick one of: " + ", ".join(IDS))
    os.makedirs(os.path.dirname(path()), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path()), prefix="autonomy-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"level": level}, f)
    os.replace(tmp, path())
    return load()


def chat_mode(level, agent):
    """The permission mode a session of `agent` (claude-code, codex, opencode) opens with; '' = the agent's own default."""
    import engines
    mode = _CHAT_MODE.get(level, "")
    return mode if mode in engines.get(agent).chat_permission_modes else ""


def ide_approvals(level):
    return _IDE_APPROVALS.get(level, "manual")


def snapshot():
    cur = load()
    return {"ok": True, **cur, "levels": LEVELS, "ide_approvals": ide_approvals(cur["level"])}


def command(a):
    as_json = getattr(a, "json", False)
    try:
        if a.op == "set":
            save(a.level or "")
        out = snapshot()
    except ValueError as e:
        out = {"ok": False, "message": str(e)}
    if as_json:
        print(json.dumps(out, ensure_ascii=False))
    elif not out["ok"]:
        print(out["message"], file=sys.stderr)
    else:
        print(f"{out['level']}: " + next(l["title"] for l in LEVELS if l["id"] == out["level"]))
    sys.exit(0 if out["ok"] else 1)
