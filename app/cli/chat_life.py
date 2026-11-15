# -*- coding: utf-8 -*-
"""chatd's handoff state machine. Engine I/O and board/prime work stay off the loop.

The public Session survives. Only its adapter is replaced, exactly the fresh
backing-context operation used by the Agents window's /clear implementation.
"""
import time
import uuid

import chat_protocol as cp
import handoff as H
import session_life as L


def initialize(host, key, sess):
    if hasattr(sess, "life"):
        return
    old = L.load(L.path_for("runtime", key, host.d.DISPATCH_DIR))
    sess.life = L.Meter(old.get("meter"))
    sess.life.data["started_at"] = sess.life.data["started_at"] or host.clock()
    sess.life_contexts = old.get("contexts", [])
    sess.life_phase = None
    sess.life_check = False
    sess.life_warned = None
    sess.life_internal = ""


def persist(host, key, sess):
    adapter = sess.adapter
    L.save(L.path_for("runtime", key, host.d.DISPATCH_DIR),
           {"session": key, "native_session": adapter.session, "cwd": sess.cwd,
            "meter": sess.life.data, "contexts": sess.life_contexts,
            "options": {k: adapter.options[k] for k in ("model", "effort", "permission_mode") if adapter.options.get(k)},
            "transcript": getattr(adapter, "transcript", "") or getattr(adapter, "transcript_path", "")})
    if adapter.session:
        import os
        L.save(L.path_for("managed", adapter.session, host.d.DISPATCH_DIR), {"session": key, "host_pid": os.getpid()})


def event(host, key, sess, ev, fields):
    initialize(host, key, sess)
    m = sess.life
    if ev == "life_usage":
        m.usage(fields.get("usage") or {}, fields.get("request_id") or "",
                fields.get("cumulative"), fields.get("window"))
        m.data["model"] = fields.get("model") or sess.adapter.options.get("model") or m.data["model"]
    elif ev == "turn_started":
        m.data["rounds"] += 1
        m.data["messages"] += 1
        if not str(fields.get("message_id", "")).startswith("life-"):
            sess.life_internal = ""
    elif ev == "tool_start" and not fields.get("parent_tool_id"):
        m.data["tool_steps"] += 1
    elif ev == "turn_done":
        m.data["messages"] += 1
        phase = sess.life_phase
        if phase and phase["stage"] == "writing":
            phase["stage"] = "written"
            phase["status"] = fields.get("status")
        elif sess.life_internal == "resume":
            sess.life_internal = ""
            H.set_phase(key, "resumed", host.d.DISPATCH_DIR)
        else:
            sess.life_check = fields.get("status") == "success"
    m.data["last_at"] = host.clock()
    if ev in ("turn_done", "life_usage", "opened", "state"):
        persist(host, key, sess)


def notice(host, key, text, **fields):
    host.em.emit("system", session=key, kind="notice", text=text, **fields)


def background(host, sess, stage, fn):
    job = {"stage": stage, "done": False, "result": None, "error": ""}
    sess.life_phase = job
    def run():
        try:
            job["result"] = fn()
        except (Exception, SystemExit) as e:
            job["error"] = str(e)
        finally:
            job["done"] = True
    host.background(run)


def send(host, key, sess, text, kind, display):
    sess.life_internal = kind
    mid = "life-" + kind + "-" + uuid.uuid4().hex
    # System-authored work uses the same queue as user messages and does not
    # take a new project checkpoint merely for a context change.
    payload = host.to_adapter(sess, mid, text, display)
    try:
        sess.adapter.send({"message_id": mid, "text": payload, "images": []})
    except cp.ChatError as e:
        host.restore_notes(sess, mid)
        sess.life_phase = None
        notice(host, key, "Context handoff paused: " + str(e) + ". Current context retained.")


def advance(host, key, sess):
    initialize(host, key, sess)
    phase = sess.life_phase
    if phase:
        if phase["stage"] in ("writing", "starting"):
            if phase["stage"] == "starting" and sess.adapter.lifecycle == "idle":
                rec, prompt = phase["result"]
                sess.life_phase = None
                H.set_phase(key, "resuming", host.d.DISPATCH_DIR, handoff=rec["id"])
                send(host, key, sess, prompt, "resume", "Continue from context handoff")
            elif sess.adapter.lifecycle in ("stopped", "error"):
                sess.life_phase = None
                H.set_phase(key, "failed", host.d.DISPATCH_DIR, error="the engine stopped")
                notice(host, key, "Context handoff paused: the engine stopped. The saved handoff is available in Docs.")
            return True
        if phase["stage"] == "written":
            request = phase["request"]
            if phase.get("status") != "success":
                sess.life_phase = None
                H.set_phase(key, "failed", host.d.DISPATCH_DIR, error="the handoff turn did not finish")
                notice(host, key, "Context handoff did not finish; the current context is retained.")
                return False
            def prepare():
                rec = H.latest(request, host.d.DISPATCH_DIR)
                if not rec or rec["session"] != key:
                    raise ValueError("the agent did not register the requested handoff")
                return rec, H.prime_for(sess.cwd, key, rec, host.d.DISPATCH_DIR)
            H.set_phase(key, "preparing", host.d.DISPATCH_DIR, request=request)
            background(host, sess, "prepare", prepare)
            return True
        if not phase.get("done"):
            return True
        if phase.get("error"):
            sess.life_phase = None
            H.set_phase(key, "failed", host.d.DISPATCH_DIR, error=phase["error"][:300])
            notice(host, key, "Context handoff paused: " + phase["error"] + ". Current context retained.")
            return False
        if sess.adapter.lifecycle != "idle" or sess.snap:
            return True
        if phase["stage"] == "request":
            task = phase["result"]
            request = uuid.uuid4().hex
            sess.life_phase = {"stage": "writing", "request": request}
            H.set_phase(key, "writing", host.d.DISPATCH_DIR, request=request)
            send(host, key, sess, H.write_instruction(task, key, request), "write", "Preparing context handoff")
            return True
        if phase["stage"] == "prepare":
            rec, prompt = phase["result"]
            old = sess.adapter
            sess.life_contexts.append({"native_session": old.session, "transcript": getattr(old, "transcript", "") or getattr(old, "transcript_path", ""), "handoff": rec["id"]})
            # Detach its public emitter before closing. The conversation stays
            # open to clients and queued user messages remain on the Session.
            old.emit = lambda *a, **k: None
            old.close("requested")
            options = {**sess.options, **old.options}
            import engines
            native = cp.session_key(sess.agent, str(uuid.uuid4())) if engines.get(sess.agent).chat_picks_session_id else None
            adapter = host.adapter_class(sess.agent)(None, native, sess.cwd, options)
            sess.adapter = adapter
            adapter.emit = host.emitter(adapter)
            sess.life.reset()
            sess.life.data["codex_total"] = 0
            sess.life_check = False
            sess.life_phase = {"stage": "starting", "result": (rec, prompt)}
            H.set_phase(key, "clearing", host.d.DISPATCH_DIR, handoff=rec["id"])
            notice(host, key, "Context handed off", handoff=rec, after_message=rec["after_message"])
            try:
                adapter.start()
            except cp.ChatError as e:
                sess.life_phase = None
                H.set_phase(key, "failed", host.d.DISPATCH_DIR, error=str(e)[:300])
                notice(host, key, "New context could not start: " + str(e) + ". Resume using the saved handoff in Docs.")
            persist(host, key, sess)
            return True
    if not sess.life_check or sess.adapter.lifecycle != "idle" or sess.snap:
        return False
    sess.life_check = False
    life = sess.life.snapshot(getattr(host, "life_settings", {}), host.clock())
    if life["status"] in ("warning", "limit") and sess.life_warned != life["epoch"]:
        sess.life_warned = life["epoch"]
        text = f"Context lifetime {life['percent']}% ({life['context_tokens']}/{life['limit_tokens']} tokens)."
        notice(host, key, text, life=life)
        sess.notes.append(text + " Prepare a concise handoff after a safe step.")
    if life["status"] == "limit" and life["auto_handoff"]:
        def task():
            return H.handoff_task(key)
        background(host, sess, "request", task)
        return True
    return False
