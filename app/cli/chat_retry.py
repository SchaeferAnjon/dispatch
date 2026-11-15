# -*- coding: utf-8 -*-
"""chatd sends a message again when the connection dropped (net.is_network_error), so a flaky network loses nothing.

A turn that ends with a connection error (Claude Code's "Connection error", Codex's "stream disconnected", OpenCode's
"Unable to connect", or the engine's process ending with one) is tried again after RETRY_DELAYS: the same words the
person sent, with one line in front that tells the agent why it sees them twice. Before each try the conversation gets
a `system` notice in plain words ("Lost the connection … trying again in 10 seconds (2 of 5). Your message is kept.").
A process that ended is resumed first, as the next send after the idle reaper does. Stopping the turn cancels the
tries; a new message sends the waiting one first; a turn that works, or one that fails for another reason, ends them.
"""
import sys

sys.dont_write_bytecode = True

import chat_protocol as cp
import net

RETRY_DELAYS = (3, 10, 30, 60)  # seconds before tries 2, 3, 4 and 5
PREFIX = "[system] The connection dropped before you finished, so Dispatch sends my last message again:\n\n"


def _seconds(n):
    return f"{n} second" + ("" if n == 1 else "s")


def sent(sess, item):
    """A message went to the agent: remember it until its turn ends (a retry keeps the original words and count)."""
    if str(item.get("message_id") or "").startswith("life-"):
        return
    keep = getattr(sess, "net_retry", None)
    if keep and item.get("retry_of") == keep.get("message_id"):
        keep["in_flight"] = True
        return
    sess.net_retry = {"message_id": item["message_id"], "text": item.get("text") or "", "display": item.get("display"),
                      "images": list(item.get("images") or []), "tries": 1, "due": None, "in_flight": True}


def turn_done(chatd, key, sess, fields):
    """After the agent's turn_done: plan the next try, or forget the message."""
    r = getattr(sess, "net_retry", None)
    if not r or not r.get("in_flight"):
        return
    r["in_flight"] = False
    if fields.get("status") != "error" or not net.is_network_error(fields.get("error")):
        sess.net_retry = None
        return
    import engines
    where = engines.get(sess.agent).servers
    if r["tries"] > len(RETRY_DELAYS):
        sess.net_retry = None
        chatd.em.emit("system", session=key, kind="notice", text=(
            f"Still no connection to {where} after {r['tries']} tries. Your message stays in the conversation: "
            "send it again when the network is back. In mainland China, a proxy (Settings > Network) or a Chinese model in OpenCode helps."))
        return
    delay = RETRY_DELAYS[r["tries"] - 1]
    r["due"] = chatd.clock() + delay
    total = len(RETRY_DELAYS) + 1
    chatd.em.emit("system", session=key, kind="notice", text=(
        f"Lost the connection to {where}. Trying again in {_seconds(delay)} ({r['tries'] + 1} of {total}). "
        "Your message is kept and goes out again on its own."))


def waiting(sess):
    r = getattr(sess, "net_retry", None)
    return bool(r and r.get("due") is not None)


def cancel(chatd, key, sess, say=True):
    """The person stopped the turn: no more tries."""
    if not waiting(sess):
        return False
    sess.net_retry = None
    if say:
        chatd.em.emit("system", session=key, kind="notice", text="Stopped trying to reconnect. Your message stays in the conversation.")
    return True


def poll(chatd):
    """chatd's tick: send the tries that are due."""
    for key, sess in list(chatd.sessions.items()):
        r = getattr(sess, "net_retry", None)
        if r and r.get("due") is not None and chatd.clock() >= r["due"]:
            fire(chatd, key, sess)


def fire(chatd, key, sess):
    """Send the waiting message again now (resuming the process when it ended). Never raises."""
    r = getattr(sess, "net_retry", None)
    if not r or r.get("due") is None:
        return False
    r["due"] = None
    r["tries"] += 1
    text = r["text"]
    if len(PREFIX) + len(text) <= cp.TEXT_LIMIT:
        text = PREFIX + text
    a = sess.adapter
    if a.lifecycle == "error" and not a.alive():
        a.lifecycle = "stopped"  # a process that died of the dropped connection is resumed like a reaped one
    o = {"session": key, "message_id": f"{r['message_id']}-retry{r['tries']}", "text": text,
         "display": r.get("display") or r["text"], "retry_of": r["message_id"]}
    if r["images"]:
        o["images"] = r["images"]
    try:
        chatd.send(o, None)
    except cp.ChatError as e:
        sess.net_retry = None
        chatd.em.emit("system", session=key, kind="notice", text=f"Could not send your message again: {e}")
        return False
    return True
