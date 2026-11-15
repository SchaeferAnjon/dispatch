# -*- coding: utf-8 -*-
"""Snippets: words a person sends to agents often, kept once and put into any session from its right-click menu
(a terminal session or a chat session alike).

    dispatch terminal snippets list
    dispatch terminal snippets add --name "Run the tests" --text "Run the tests and fix what fails."
    dispatch terminal snippets update --id <id> [--name …] [--text …]
    dispatch terminal snippets remove --id <id>

Kept in ~/.dispatch/snippets.json ({"snippets": [{id, name, text, createdAt}]}). Until the person changes the
list, three starters are shown; the first change writes the file with them in it.
"""
import json
import os
import time
import uuid

import dispatch_dir

MAX_NAME = 80
MAX_TEXT = 20000

STARTERS = [
    {"id": "starter-tests", "name": "Run the tests and fix what fails", "text": "Run the tests. Fix what fails, then run them again until they pass."},
    {"id": "starter-explain", "name": "Explain what you changed", "text": "Explain what you just changed and why, in plain words, one short paragraph per file."},
    {"id": "starter-commit", "name": "Commit what is done", "text": "Commit what is done with a short message that says what changed."},
]


def store_path():
    return dispatch_dir.path("snippets.json")


def load():
    try:
        with open(store_path()) as f:
            data = json.load(f)
        items = data.get("snippets") if isinstance(data, dict) else None
        if isinstance(items, list):
            return [s for s in items if isinstance(s, dict) and s.get("id") and isinstance(s.get("text"), str)]
    except FileNotFoundError:
        return [dict(s) for s in STARTERS]
    except Exception:
        pass
    return []


def _save(items):
    p = store_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"snippets": items}, f, ensure_ascii=False, indent=1)
    os.replace(tmp, p)


def _clean(name, text):
    name = " ".join(str(name or "").split())[:MAX_NAME]
    text = str(text or "").rstrip()[:MAX_TEXT]
    if not name and text:
        first = text.strip().splitlines()[0]
        name = (first[:57] + "...") if len(first) > 60 else first
    return name, text


def add(name, text):
    name, text = _clean(name, text)
    if not text.strip():
        return {"ok": False, "message": "A snippet needs some words."}
    items = load()
    item = {"id": uuid.uuid4().hex[:12], "name": name, "text": text, "createdAt": int(time.time())}
    items.append(item)
    _save(items)
    return {"ok": True, "snippet": item, "snippets": items}


def update(sid, name=None, text=None):
    items = load()
    for s in items:
        if s["id"] == sid:
            new_name, new_text = _clean(s["name"] if name is None else name, s["text"] if text is None else text)
            if not new_text.strip():
                return {"ok": False, "message": "A snippet needs some words."}
            s["name"], s["text"] = new_name, new_text
            _save(items)
            return {"ok": True, "snippet": s, "snippets": items}
    return {"ok": False, "message": "No such snippet."}


def remove(sid):
    items = load()
    kept = [s for s in items if s["id"] != sid]
    if len(kept) == len(items):
        return {"ok": False, "message": "No such snippet."}
    _save(kept)
    return {"ok": True, "snippets": kept}


def command(op, sid="", name=None, text=None):
    if op in ("", "list"):
        return {"ok": True, "snippets": load()}
    if op == "add":
        return add(name, text)
    if op == "update":
        return update(sid, name, text)
    if op == "remove":
        return remove(sid)
    return {"ok": False, "message": "dispatch terminal snippets list | add | update | remove"}
