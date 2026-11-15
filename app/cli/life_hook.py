# -*- coding: utf-8 -*-
"""The context lifetime, one feature of Dispatch's hook entry (hook.py calls answer()).

Claude Code and Codex run the entry on every prompt, tool call and stop, synchronously. Most calls are far
below the reminder line, so this file answers them itself: read the new transcript lines from the
saved offset (session_life.transcript_meter), compare with the cached lifetime settings, print {}.
It imports neither dispatch.py nor the board. Anything it cannot decide cheaply (the reminder line or
the limit, the registered dispatcher's notifications, no transcript, no fresh settings copy, OpenCode)
goes to the full hook, `dispatch handoff hook`, in the same process.
"""
import json
import os
import re
import sys

sys.dont_write_bytecode = True  # it runs from inside the signed app: no __pycache__ next to these files

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

FULL = None  # "ask the full hook"


def _alive(pid):
    try:
        pid = int(pid or 0)
        if pid <= 1:
            return False
        os.kill(pid, 0)
        return True
    except (ValueError, TypeError, OSError):
        return False


def fast(data, agent, now=None):
    """{} when the answer is certainly "nothing to say", else FULL."""
    import session_life as L
    import engines
    if not engines.get(agent).life_hooks:
        return FULL
    sid = str(data.get("session_id") or data.get("thread_id") or data.get("conversation_id") or "")
    if not sid:
        return {}
    import engines
    if engines.foreign_session(agent, sid):
        return {}  # an OpenCode session replaying Claude Code's hooks (handoff.foreign)
    base = L.dispatch_dir()
    raw = sid.split(":", 1)[1] if ":" in sid and engines.find(sid.split(":", 1)[0]) else sid
    row = L.load(os.path.join(base, "notifications", "dispatcher.json"))
    if row.get("session") == raw and not row.get("released_at"):
        return FULL  # the registered dispatcher: worker notifications ride on its hooks
    session = L.key(sid, agent)
    path = data.get("transcript_path") or ""
    child = str(data.get("agent_id") or "") if engines.get(agent).hook_children else ""
    if child:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", child):
            return {}
        own = data.get("agent_transcript_path") or ""
        if not own:
            candidate = os.path.join(os.path.splitext(path)[0], "subagents", "agent-" + child + ".jsonl")
            own = candidate if os.path.isfile(candidate) else ""
        if not own or not os.path.isfile(own):
            return {}
        path = own
    else:
        if _alive(os.environ.get("DISPATCH_LIFE_MANAGED")) or \
                _alive(L.load(L.path_for("managed", session, base)).get("host_pid")):
            return {}  # the Agents window or chatd runs this context's handoff
    if not path or not os.path.isfile(path):
        return FULL
    settings = L.cached_settings(base, now)
    if settings is None:
        return FULL
    try:
        life = L.transcript_meter(path, agent, base, subagent=bool(child)).snapshot(settings, now)
    except (OSError, ValueError):
        return FULL
    return {} if life["status"] in ("ok", "unknown") else FULL


def attribution_mark(data, agent):
    """Who wrote which line (attribution.py): a mark when a turn starts or ends; on a prompt, the note
    about the lines you changed since this session's last turn. "" when there is nothing to say."""
    try:
        import attribution
        return attribution.hook_mark(data, agent).get("note") or ""
    except Exception:  # noqa: BLE001 - never in the way of the agent's turn
        return ""


def prefs_note(data, event):
    """On a prompt: the preferences this conversation recorded that the person took back since (prefs.undone_note)."""
    if event != "UserPromptSubmit":
        return ""
    try:
        import prefs
        return prefs.undone_note(str(data.get("session_id") or ""))
    except Exception:  # noqa: BLE001 - never in the way of the agent's turn
        return ""


def join_notes(*notes):
    return "\n\n".join(n for n in notes if n)


def with_note(out, said, event):
    if not said or event != "UserPromptSubmit" or not isinstance(out, dict):
        return out
    out = dict(out)
    inner = dict(out.get("hookSpecificOutput") or {"hookEventName": event})
    inner["additionalContext"] = (inner["additionalContext"] + "\n\n" if inner.get("additionalContext") else "") + said
    out["hookSpecificOutput"] = inner
    return out


def capture_prompt(data, agent):
    """A prompt typed in Dispatch's own terminal goes to the board like a message in the window (capture.py), in
    the background. Only inside that terminal; never in the way of the agent's turn."""
    if not os.environ.get("DISPATCH_TERMINAL_SESSION") or data.get("hook_event_name") != "UserPromptSubmit":
        return
    try:
        import capture
        capture.from_hook(data, agent)
    except Exception:  # noqa: BLE001
        pass


def answer(data, agent):
    """The lifetime feature of Dispatch's hook entry (hook.py) for one event: a prompt typed in Dispatch's terminal
    goes to the board, the attribution mark, then the lifetime check (fast here, else the full hook)."""
    capture_prompt(data, agent)
    said = join_notes(attribution_mark(data, agent), prefs_note(data, data.get("hook_event_name") or ""))
    try:
        out = fast(data, agent)
    except Exception:  # noqa: BLE001 - the full hook decides whatever the fast path could not
        out = FULL
    if out is FULL:
        import handoff
        out = handoff.hook(data, agent)
    return with_note(out, said, data.get("hook_event_name") or "")


def main(argv=None):
    """`life_hook.py --agent <agent>`: the lifetime entry hooks installed before Dispatch's one entry still run until
    `dispatch hooks sync` replaces them (hook.py does all of this now)."""
    argv = sys.argv[1:] if argv is None else argv
    agent = argv[argv.index("--agent") + 1] if "--agent" in argv and argv.index("--agent") + 1 < len(argv) else "claude-code"
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        print("{}")
        return 0
    if not isinstance(data, dict):
        print("{}")
        return 0
    print(json.dumps(answer(data, agent), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
