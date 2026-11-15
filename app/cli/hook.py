# -*- coding: utf-8 -*-
"""Dispatch's one hook entry. Each agent has exactly one Dispatch hook, this command, for every event it hooks:

    hook.py <agent>                          Claude Code's and Codex's hooks (the hook JSON on stdin names the event)
    hook.py opencode                         Dispatch's OpenCode plugin (agent/opencode/dispatch.js), the same shape
    hook.py <agent> --terminal [<event>]     an agent run in Dispatch's terminal: its turn signals (the launch adds
                                             these; nothing of the person's is touched), Codex's notify JSON last

It looks the event up in the agent's routes (its adapter's `hook_routes`, engines/) and runs the features there, in
order, in this one process; their answers are merged into one hook answer:

    prime       the session brief at a session start (`dispatch prime --hook-json`, in a child: it reads the board);
                not in a side chat (DISPATCH_SIDE_CHAT set), which has it from the conversation it came from; a start
                or a resume waits for it at most START_BUDGET, then says to run `dispatch prime`
    presence    what the session is doing, and the bell when it starts waiting for you (presence.py)
    edit-guard  another session's or task's file is pointed out before an edit (edit-guard.py); off until turned on
    plan        the agent's to-do list becomes the plan of its task (`dispatch task plan --hook`, in the background)
    life        the context lifetime, the attribution marks and, in Dispatch's terminal, the prompt to the board
                (life_hook.py); at a turn's end, what the board holds for the conversation and the reply says is
                done or not needed is closed (capture.settle)

DISPATCH_HOOK_LOG=<file> writes one line per event (what ran, what it answered); DISPATCH_HOOK_DEBUG=1 prints a
feature's error. A feature can be turned off per agent in Settings › Soul (its Hooks card), which writes ~/.dispatch/config.json
("hooks": {"<agent>": {"<feature>": false}}); the edit guard is the one that is off unless turned on. Turning a
feature on or off never edits the agent's own settings file: the entry stays, it just skips that feature.

Installing, removing and bringing the entry up to date is hooks_setup.py, through each agent's adapter. Never fails
the agent's turn: every error is swallowed and the exit code is 0.
"""
import json
import os
import subprocess
import sys
import time

STARTED = time.monotonic()
sys.dont_write_bytecode = True  # it runs from inside the signed app: no __pycache__ next to these files

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

MARK = "# dispatch-hook"
FEATURES = ("prime", "presence", "edit-guard", "plan", "life")
DEFAULT_OFF = ("edit-guard",)
# After a /clear or a compaction the brief carries the handoff, the conversation's memory: it gets the time it needs.
PRIME_TIMEOUT = 40
# A start or a resume waits for this hook: the Claude Agent SDK (Dispatch IDE's sessions) gives the whole start 60 s,
# hooks included, then fails the message with "Subprocess initialization did not complete within 60000ms". On a
# loaded Mac the brief took 17 to 30 s and more (2026-10-11), so this hook stops waiting for it 20 s after it started
# and tells the agent where the brief is instead.
START_BUDGET = 20


# ---------------------------------------------------------------- switches
def config_path():
    root = os.environ.get("DISPATCH_HOME", "").strip()
    root = os.path.abspath(os.path.expanduser(root)) if root else os.path.join(os.path.expanduser("~"), ".dispatch")
    return os.path.join(root, "config.json")


def switches(agent, path=None):
    """{feature: on?} for one agent."""
    try:
        with open(path or config_path(), encoding="utf-8") as f:
            saved = (json.load(f).get("hooks") or {}).get(agent) or {}
    except (OSError, ValueError, AttributeError):
        saved = {}
    saved = saved if isinstance(saved, dict) else {}
    return {f: bool(saved.get(f, f not in DEFAULT_OFF)) for f in FEATURES}


# ---------------------------------------------------------------- the features
def cli_path():
    return os.path.join(HERE, "dispatch.py")


def _child_env(agent, data):
    """The agent speaks as itself on the board (BEADS_ACTOR), not as whoever owns the Mac or set it in their shell."""
    env = dict(os.environ, BEADS_ACTOR=agent, PYTHONDONTWRITEBYTECODE="1")
    if agent == "opencode":
        sid = str(data.get("session_id") or "")
        env.update(DISPATCH_ACTOR="opencode", **({"DISPATCH_SESSION_ID": sid} if sid else {}))
    return env


def prime(agent, event, data):
    if os.environ.get("DISPATCH_SIDE_CHAT"):
        # a side chat of Dispatch IDE (claudeSideChatLaunch.ts): its forked conversation has the brief already, and
        # reading the board would hold its first answer up
        return None
    cwd = data.get("cwd") if isinstance(data.get("cwd"), str) and os.path.isdir(data.get("cwd") or "") else None
    handoff = data.get("source") in ("compact", "clear")
    wait = PRIME_TIMEOUT if handoff else max(1.0, START_BUDGET - (time.monotonic() - STARTED))
    try:
        if agent == "opencode":
            # OpenCode's plugin puts the text into the session's system prompt itself
            argv = [sys.executable, cli_path(), "prime", "--opencode", "--cwd", cwd or os.getcwd()]
            if handoff:
                argv += ["--source", data["source"]]
            r = subprocess.run(argv, capture_output=True, text=True, timeout=wait, env=_child_env(agent, data),
                               cwd=cwd, stdin=subprocess.DEVNULL)
            text = (r.stdout or "").strip() if r.returncode == 0 else ""
            return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}} if text else None
        r = subprocess.run([sys.executable, cli_path(), "prime", "--hook-json"], input=json.dumps(data), capture_output=True,
                           text=True, timeout=wait, env=_child_env(agent, data), cwd=cwd)
    except subprocess.TimeoutExpired:
        # the brief was stopped before it marked anything delivered, so nothing in it is lost: the agent reads it itself
        import lang as L
        seconds = round(time.monotonic() - STARTED)
        text = L.t(f"(The session brief was not ready within {seconds} s: the board is slow right now. "
                   "Run `dispatch prime` to read it before you start on the board.)",
                   f"（会话简报 {seconds} 秒内没准备好：任务板现在很慢。动任务板之前先跑 `dispatch prime` 读一遍。）")
        return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}
    out = (r.stdout or "").strip()
    return json.loads(out[out.find("{"):]) if r.returncode == 0 and "{" in out else None


def presence(agent, event, data):
    tools = _engine(agent).presence_tools
    if event == "PostToolUse" and tools and data.get("tool_name") not in tools:
        return None
    import presence as PR
    PR.record(agent, event, data)
    return None


def edit_guard(agent, event, data):
    if data.get("tool_name") not in _engine(agent).edit_tools:
        return None
    import importlib.util
    spec = importlib.util.spec_from_file_location("dispatch_edit_guard", os.path.join(HERE, "edit-guard.py"))
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    return guard.check(agent, "pre" if event == "PreToolUse" else "post", data)


def plan(agent, event, data):
    if data.get("tool_name") not in _engine(agent).plan_tools:
        return None
    # in the background: the board write takes a moment and the agent waits for its hooks
    p = subprocess.Popen([sys.executable, cli_path(), "task", "plan", "--hook"], stdin=subprocess.PIPE,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=_child_env(agent, data),
                         start_new_session=True)
    p.stdin.write(json.dumps(data).encode("utf-8"))
    p.stdin.close()
    return None


def settle(agent, event, data):
    """The end of a turn: what Dispatch noted as this conversation's work and its agent never took is closed when the
    reply says done or not needed (capture.settle, in the background, task-lj06.18)."""
    if event != "Stop":
        return
    try:
        import capture
        capture.settle_from_hook(data, agent)
    except Exception:  # noqa: BLE001 - never in the way of the turn
        pass


def life(agent, event, data):
    import life_hook
    settle(agent, event, data)
    if agent == "opencode":
        # OpenCode's plugin: a prompt (attribution start, the note about your changes, the terminal's prompt to the
        # board) or a turn's end (attribution end, then the lifetime check, which always asks the full hook there)
        life_hook.capture_prompt(data, agent)
        import attribution
        said = life_hook.join_notes(attribution.hook_mark(data, agent, source="plugin").get("note") or "",
                                    life_hook.prefs_note(data, event))
        if event == "Stop":
            import handoff
            return handoff.hook(data, agent)
        return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": said}} if said else None
    return life_hook.answer(data, agent)


RUN = {"prime": prime, "presence": presence, "edit-guard": edit_guard, "plan": plan, "life": life}


def _engine(agent):
    import engines
    return engines.get(agent)


# ---------------------------------------------------------------- one answer
def merge(outs, event):
    """The features' answers as one hook answer: contexts and messages joined, a deny or a block wins."""
    contexts, messages, blocks, denies, decision = [], [], [], [], None
    stop = None
    for o in outs:
        if not isinstance(o, dict):
            continue
        inner = o.get("hookSpecificOutput") if isinstance(o.get("hookSpecificOutput"), dict) else {}
        if inner.get("additionalContext"):
            contexts.append(str(inner["additionalContext"]))
        if inner.get("permissionDecision") == "deny":
            denies.append(str(inner.get("permissionDecisionReason") or ""))
        elif inner.get("permissionDecision") and decision is None:
            decision = (inner["permissionDecision"], str(inner.get("permissionDecisionReason") or ""))
        if o.get("systemMessage"):
            messages.append(str(o["systemMessage"]))
        if o.get("decision") == "block":
            blocks.append(str(o.get("reason") or ""))
        if o.get("continue") is False:
            stop = str(o.get("stopReason") or "")
    out = {}
    inner = {}
    if contexts:
        inner["additionalContext"] = "\n\n".join(contexts)
    if denies:
        inner.update(permissionDecision="deny", permissionDecisionReason=" ".join(r for r in denies if r))
    elif decision:
        inner.update(permissionDecision=decision[0], **({"permissionDecisionReason": decision[1]} if decision[1] else {}))
    if inner:
        out["hookSpecificOutput"] = {"hookEventName": event, **inner}
    if messages:
        out["systemMessage"] = "\n".join(messages)
    if blocks:
        out.update(decision="block", reason="\n\n".join(r for r in blocks if r))
    if stop is not None:
        out.update({"continue": False, **({"stopReason": stop} if stop else {})})
    return out


def answer(agent, data, event=None, only=None, config=None):
    """The merged answer of every feature the agent's routes give `event` (`only`: just these features)."""
    event = event or str(data.get("hook_event_name") or "")
    routes = _engine(agent).hook_routes.get(event) or ()
    on = switches(agent, config)
    outs, ran = [], []
    for feature in routes:
        if (only and feature not in only) or not on.get(feature):
            continue
        try:
            outs.append(RUN[feature](agent, event, data))
            ran.append(feature)
        except Exception as e:  # noqa: BLE001 - one feature failing never takes the others or the turn down
            ran.append(f"{feature}!")
            if os.environ.get("DISPATCH_HOOK_DEBUG"):
                sys.stderr.write(f"dispatch hook {feature}: {e}\n")
    out = merge(outs, event)
    trace(agent, event, data, ran, out)
    return out


def trace(agent, event, data, ran, out):
    """DISPATCH_HOOK_LOG=<file>: one JSON line per event (what ran, what it answered), to see the entry at work."""
    path = os.environ.get("DISPATCH_HOOK_LOG")
    if not path:
        return
    try:
        import time
        row = {"at": round(time.time(), 3), "agent": agent, "event": event, "session": str(data.get("session_id") or data.get("thread_id") or ""),
               "tool": data.get("tool_name") or "", "ran": ran, "answer": out}
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- in Dispatch's terminal
def terminal(agent, argv, stdin):
    """An agent's turn signal in Dispatch's terminal (terminal_hook.py): the bell and the session row hear it."""
    import terminal_hook
    event = argv[0] if argv else ""
    raw = argv[1] if len(argv) > 1 else ""
    payload = {}
    if not raw and event not in ("bell", "notify"):
        try:
            raw = stdin.read()
        except Exception:  # noqa: BLE001
            raw = ""
    if raw:
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = {}
    payload = payload if isinstance(payload, dict) else {}
    if not event:
        event = str(payload.get("hook_event_name") or "")
    return terminal_hook.handle(agent, event, payload)


def read_stdin(stdin):
    raw = getattr(stdin, "buffer", None)  # the hook JSON is UTF-8 whatever the console code page says
    text = raw.read().decode("utf-8", "replace") if raw is not None else stdin.read()
    data = json.loads(text or "{}")
    return data if isinstance(data, dict) else {}


def main(argv=None, stdin=None):
    argv = sys.argv[1:] if argv is None else argv
    stdin = sys.stdin if stdin is None else stdin
    if not argv:
        sys.stderr.write("usage: hook.py <agent> [--terminal [<event>] [<json>]]\n")
        return 0
    agent, rest = argv[0], argv[1:]
    if rest[:1] == ["--terminal"]:
        try:
            terminal(agent, rest[1:], stdin)
        except Exception as e:  # noqa: BLE001 - a hook must never get in the agent's way
            sys.stderr.write(f"dispatch terminal hook: {e}\n")
        return 0
    try:
        data = read_stdin(stdin)
    except Exception:  # noqa: BLE001
        data = {}
    out = answer(agent, data, event=rest[0] if rest else None)
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001
        print("{}")
    sys.exit(0)
