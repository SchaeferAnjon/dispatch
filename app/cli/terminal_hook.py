# -*- coding: utf-8 -*-
"""An agent in Dispatch's terminal says its turn ended: the bell hears it, as it hears a chat session.

The agents reach it through Dispatch's one hook entry with --terminal (hook.py), added at launch, never written into
the person's settings:

    hook.py claude-code --terminal                 Claude Code's hooks (a settings file of the launch, engines/claude.py), payload on stdin
    hook.py codex --terminal notify <json>         Codex's `notify` program, payload as the last argument
    hook.py opencode --terminal <event>            OpenCode's turn plugin (engines/opencode.py), payload on stdin
    python3 terminal_hook.py <agent> bell          the terminal daemon heard the agent ring the terminal bell

The terminal is the one in DISPATCH_TERMINAL_SESSION (the daemon sets it in every terminal it starts); run
anywhere else, this does nothing. Like the chat (inbox.py), the kind comes from the agent's own end-of-turn signal,
never from the screen going quiet (each agent's adapter in engines/ reads its own signal: Engine.turn_state):

    Claude Code   UserPromptSubmit -> working (what it had for the person has been seen), Stop -> finished,
                  StopFailure -> stopped, Notification permission_prompt / elicitation_dialog -> needs you
    Codex         notify agent-turn-complete -> finished
    OpenCode      a plugin of Dispatch's, handed over in an inline config (OPENCODE_CONFIG_CONTENT; the person's own
                  config is read as usual; learned from Orca's OpenCode status plugin, MIT): its session busy ->
                  working, busy then idle -> finished, a permission or question -> needs you, a session error ->
                  stopped; a subagent's (child) session is not a turn of the terminal's
    any agent     a terminal bell -> needs you (the daemon only passes it on for agents without hooks)

Each one is filed in the inbox (source terminal, session "dispatch-terminal:/<id>", the key the Agents window's
terminal session has) and told to the daemon (POST /turn), which tells the open windows so the session row shows
working, waiting or done at once. The daemon answers with the terminal's title and folder for the inbox row.

Kept small and quick: an agent waits for its hooks. Only the standard library, inbox.py and the engine registry
(engines/, small files that import nothing heavy) are imported.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True  # it runs from inside the signed app: no __pycache__ next to these files

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import engines  # noqa: E402

SESSION_ENV = "DISPATCH_TERMINAL_SESSION"
KEY_PREFIX = "dispatch-terminal:/"
HOOK_SCRIPT = os.path.join(HERE, "hook.py")  # Dispatch's one hook entry: the adapters' terminal launch runs it with --terminal


def dispatch_dir():
    return os.environ.get("DISPATCH_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".dispatch")


def session_key(sid):
    return KEY_PREFIX + sid


def last_line(text):
    lines = [l.strip() for l in str(text or "").splitlines() if l.strip()]
    return lines[-1] if lines else ""


def classify(agent, event, payload):
    """(state, text, why) for an agent's signal, or (None, '', '') when it is not a turn ending or starting: a bell is
    the same for every agent, the rest is the agent's own word (its adapter's turn_state, engines/)."""
    payload = payload if isinstance(payload, dict) else {}
    if event == "bell":
        return "needs_you", "", ""
    return engines.get(agent).turn_state(event, payload)


def tell_daemon(sid, state, timeout=1.5):
    """POST /turn to the terminal daemon; its answer has the terminal's title, folder and agent ({} when it is not
    running)."""
    try:
        with open(os.path.join(dispatch_dir(), "termd", "daemon.json")) as f:
            info = json.load(f)
        q = urllib.parse.urlencode({"token": info["token"], "session": sid, "state": state})
        req = urllib.request.Request(f"http://127.0.0.1:{int(info['port'])}/turn?{q}", data=b"", method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8")).get("info") or {}
    except Exception:
        return {}


def handle(agent, event, payload, env=None, base=None, notify_daemon=True):
    """Files the event and tells the daemon. Returns what was done ({'state': None} when nothing was)."""
    env = os.environ if env is None else env
    sid = env.get(SESSION_ENV, "")
    if not sid:
        return {"state": None, "why": "not in a Dispatch terminal"}
    state, text, why = classify(agent, event, payload)
    if not state:
        return {"state": None}
    info = tell_daemon(sid, state) if notify_daemon else {}
    import inbox
    base = base or dispatch_dir()
    key = session_key(sid)
    if state == "working":
        inbox.set_read(True, session=key, by="working", base=base)
        return {"state": state}
    cwd = info.get("cwd") or (payload or {}).get("cwd") or env.get("PWD", "")
    title = info.get("title") or ""
    r = inbox.add(state, key, source="terminal", agent=engines.agent_of(agent), title=title,
                  project=os.path.basename(cwd.rstrip("/")) if cwd else "", cwd=cwd, text=text, why=why, base=base)
    return {"state": state, "event": r["event"]["id"], "new": r["new"]}


def main(argv, stdin):
    if len(argv) < 2:
        return {"state": None, "why": "usage: terminal_hook.py <agent> <event> [json]"}
    agent, event = argv[0], argv[1]
    payload = {}
    raw = argv[2] if len(argv) > 2 else ""
    if not raw and event not in ("bell", "notify"):
        try:
            raw = stdin.read()
        except Exception:
            raw = ""
    if raw:
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {}
    return handle(agent, event, payload)


if __name__ == "__main__":
    try:
        main(sys.argv[1:], sys.stdin)
    except Exception as e:  # a hook must never get in the agent's way
        sys.stderr.write(f"dispatch terminal hook: {e}\n")
    sys.exit(0)
