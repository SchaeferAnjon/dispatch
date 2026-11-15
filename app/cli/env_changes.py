# -*- coding: utf-8 -*-
"""What `dispatch env` changed, so it can be shown and taken back (Settings › Keys in Dispatch IDE, and the
"Key saved" toast that comes up whoever saved it: the person on that page, an agent in a chat, a terminal).

Each set, edit, unset and undo of a key:
- keeps a copy of the whole store first: ~/.dispatch/backups/<date>/.config/dispatch/env (backups.save; the copy
  keeps the file's 0600);
- writes an undo record, ~/.dispatch/backups/<date>/env-changes/<id>.json (0600): the key as it was, value
  included, and a fingerprint of the value it got, so Undo puts back exactly that and nothing newer;
- adds one line without any value to ~/.dispatch/state/env-events.jsonl: id, op, name, note, project, by, at.
  Dispatch IDE's bridge watches that file and shows the toast.

Values never reach the events file, the task board, the wiki or a log; only the undo record holds one, beside the
store's own backup copy.
"""
import datetime
import glob
import hashlib
import json
import os
import re
import secrets

import dispatch_dir as DD

EVENTS = "env-events.jsonl"
KEEP_EVENTS = 200
_ID = re.compile(r"^envc-[a-z0-9]{8}$")


def events_path():
    return DD.path("state", EVENTS)


def fingerprint(value):
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()[:16]


def _private_json(path, data):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = path + f".tmp{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def _plain(it):
    """A key as the undo record keeps it."""
    return None if it is None else {"value": it["value"], "note": it.get("note") or "", "project": it.get("project") or ""}


def record(op, name, before, after, by="", index=-1, now=None):
    """Keep what a change did (call it after the store is written). `before` / `after`: the key's item
    ({name, value, note, project}) before and after, None when it was not there. Returns the event (no value)."""
    now = now or datetime.datetime.now()
    cid = "envc-" + "".join(secrets.choice("abcdefghijkmnpqrstuvwxyz23456789") for _ in range(8))
    rec = {"id": cid, "op": op, "name": name, "at": now.isoformat(timespec="seconds"), "by": by or "",
           "index": index, "before": _plain(before),
           "after": None if after is None else {"fp": fingerprint(after["value"]), "note": after.get("note") or "", "project": after.get("project") or ""}}
    _private_json(os.path.join(DD.path("backups"), f"{now:%Y-%m-%d}", "env-changes", cid + ".json"), rec)
    shown = after if after is not None else before
    event = {"id": cid, "op": op, "name": name, "note": (shown or {}).get("note") or "", "project": (shown or {}).get("project") or "",
             "by": by or "", "at": rec["at"], "created": before is None and after is not None}
    _append_event(event)
    return event


def _append_event(event):
    path = events_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lines = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()[-(KEEP_EVENTS - 1):]
    lines.append(json.dumps(event, ensure_ascii=False))
    tmp = path + f".tmp{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, path)


def load(cid):
    """The undo record of a change, or None."""
    if not _ID.match(cid or ""):
        return None
    for p in sorted(glob.glob(os.path.join(DD.path("backups"), "*", "env-changes", cid + ".json")), reverse=True):
        with open(p, encoding="utf-8") as f:
            rec = json.load(f)
        rec["_path"] = p
        return rec
    return None


def undo(cid, items):
    """Takes one change back in `items` (the store as env_read gives it), in place.
    Returns (result, error): result {name, op, restored: "value" | "removed"}, or error a sentence to show."""
    rec = load(cid)
    if rec is None:
        return None, f"No change {cid} to undo (changes are kept 30 days)."
    if rec.get("undone"):
        return None, f"That change to {rec['name']} was already undone."
    name = rec["name"]
    idx = next((i for i, it in enumerate(items) if it["name"] == name), -1)
    now_item = items[idx] if idx >= 0 else None
    after = rec.get("after")
    if after is None:
        if now_item is not None:
            return None, f"{name} was saved again since; nothing was undone."
    elif now_item is None or fingerprint(now_item["value"]) != after["fp"] or (now_item.get("note") or "") != after["note"] \
            or (now_item.get("project") or "") != after["project"]:
        return None, f"{name} changed again since; nothing was undone."
    before = rec.get("before")
    if before is None:
        del items[idx]
        restored = "removed"
    else:
        item = {"name": name, **before}
        if idx >= 0:
            items[idx] = item
        else:
            at = rec.get("index", -1)
            items.insert(at if 0 <= at <= len(items) else len(items), item)
        restored = "value"
    rec["undone"] = datetime.datetime.now().isoformat(timespec="seconds")
    path = rec.pop("_path")
    _private_json(path, rec)
    return {"name": name, "op": rec["op"], "restored": restored, "before": before, "after_item": now_item}, None
