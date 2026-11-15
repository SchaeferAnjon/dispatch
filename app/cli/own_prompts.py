# -*- coding: utf-8 -*-
"""What Dispatch itself tells an agent, as opposed to what the person types.

Some messages in a chat are Dispatch's words sent in the person's place: "Let the agent fix it" after a commit or
push failed (fixit.py), the handoff when a conversation moves to another agent (agent_switch.py), the automatic
tidy-up check (neat_auto.py). They read like requests, so the board's note-taker (capture.py) would put them on the
board as if the person had asked. Whatever makes such a prompt remembers it here (a hash of its words, kept for a
week); `dispatch capture note` asks before reading a message and leaves Dispatch's own alone. When the person added
words of their own to it (what to do next, typed into the switch), only those are read.

DISPATCH_DIR/capture/own-prompts.json: {"<hash>": <time remembered>} or {"<hash>": {"at": <time>, "user": "<their words>"}}.
"""
import hashlib
import json
import os
import time

KEEP_S = 7 * 24 * 3600
MAX_ENTRIES = 500
TEXT_MAX = 4000


def _dir():
    # dispatch.DISPATCH_DIR, worked out the same way (capture.py keeps its receipts next to this)
    return os.path.join(os.environ.get("DISPATCH_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".dispatch"), "capture")


def _path():
    return os.path.join(_dir(), "own-prompts.json")


def key(text):
    """The words with whitespace folded, as capture.py folds a message before it reads it."""
    t = " ".join(str(text or "").split())[:TEXT_MAX]
    return hashlib.sha1(t.encode("utf-8")).hexdigest()[:20] if t else ""


def _load():
    try:
        with open(_path(), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _at(entry):
    try:
        return float(entry.get("at") if isinstance(entry, dict) else entry or 0)
    except (TypeError, ValueError):
        return 0.0


def remember(text, now=None, user=""):
    """Mark `text` as Dispatch's own; `user` is the part of it the person typed themselves (read as theirs).
    Cheap to call again with the same words (nothing is written then)."""
    k = key(text)
    if not k:
        return ""
    now = now or time.time()
    user = str(user or "").strip()
    d = _load()
    if k in d and now - _at(d[k]) < KEEP_S / 2 and (d[k].get("user", "") if isinstance(d[k], dict) else "") == user:
        return k
    d = {x: v for x, v in d.items() if now - _at(v) < KEEP_S}
    d[k] = {"at": now, "user": user} if user else now
    if len(d) > MAX_ENTRIES:
        d = dict(sorted(d.items(), key=lambda kv: _at(kv[1]))[-MAX_ENTRIES:])
    try:
        os.makedirs(_dir(), exist_ok=True)
        tmp = _path() + ".%d.tmp" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f)
        os.replace(tmp, _path())
    except OSError:
        pass
    return k


def lookup(text, now=None):
    """None for the person's own message; for Dispatch's: {"user": the words in it the person typed, or ""}."""
    k = key(text)
    if not k:
        return None
    entry = _load().get(k)
    if entry is None or (now or time.time()) - _at(entry) >= KEEP_S:
        return None
    return {"user": entry.get("user", "") if isinstance(entry, dict) else ""}


def is_own(text, now=None):
    return lookup(text, now) is not None
