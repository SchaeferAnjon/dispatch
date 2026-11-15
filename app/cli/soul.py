# -*- coding: utf-8 -*-
"""Soul: how every agent talks and works ("quick, exact, plain"), one file the person can change.

    dispatch soul show [--json]          the text in use, whether it is on, whether it is the default
    dispatch soul edit [--json]          new text from standard input; from a terminal, opens it in an editor
    dispatch soul reset [--json]         back to Dispatch's default
    dispatch soul on | off [--json]      put it into every agent's rules, or take it out
    dispatch soul path

Dispatch ships the default (agent/rules/SOUL.md). The person's copy is ~/.dispatch/rules/SOUL.md, made from the
default the first time it is needed. `dispatch rules sync` puts it into Claude Code, Codex and OpenCode with
GLOBAL.md and dispatch.md (dispatch.py render_block). Every change here ends with that sync.

Updates: config.json `soul.base` is the hash of the default the copy was made from. While the copy still equals
it (the person did not change it), a newer default replaces it; once they changed it, it stays theirs.
"""
import hashlib
import json
import os
import subprocess
import sys

import backups
import dispatch_dir as DD

_CLI = os.path.dirname(os.path.abspath(__file__))
SHIPPED = next((p for p in (os.path.join(os.path.dirname(os.path.dirname(_CLI)), "agent", "rules", "SOUL.md"),
                            os.path.join(os.path.dirname(_CLI), "agent", "rules", "SOUL.md")) if os.path.isfile(p)),
               os.path.join(os.path.dirname(os.path.dirname(_CLI)), "agent", "rules", "SOUL.md"))


def path():
    return DD.path("rules", "SOUL.md")


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def _read(p):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def default_text():
    return _read(SHIPPED) or ""


def _state():
    s = DD.config_load().get("soul")
    return s if isinstance(s, dict) else {}


def _save_state(**kw):
    cfg = DD.config_load()
    s = cfg.get("soul") if isinstance(cfg.get("soul"), dict) else {}
    s.update(kw)
    cfg["soul"] = s
    DD.config_save(cfg)


def is_on():
    return _state().get("on", True) is not False


def _write(text):
    p = path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".dispatch-tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, p)


def ensure():
    """The person's copy made current: created from the default when missing, replaced by a newer default while
    they have not changed it. Returns created / updated / theirs / current, or "" when this install has no default."""
    shipped = default_text()
    if not shipped.strip():
        return ""
    mine = _read(path())
    base = _state().get("base")
    if mine is None:
        _write(shipped)
        _save_state(base=digest(shipped))
        return "created"
    if digest(mine) == digest(shipped):
        if base != digest(shipped):
            _save_state(base=digest(shipped))
        return "current"
    if base and digest(mine) == base:
        backups.save(path())
        _write(shipped)
        _save_state(base=digest(shipped))
        return "updated"
    return "theirs"


def text_for_rules():
    """What `rules sync` puts into each agent: the person's Soul when it is on, else ""."""
    if not is_on():
        return ""
    t = _read(path())
    if t is None:
        t = default_text()
    return t.strip() + "\n" if t and t.strip() else ""


def status():
    mine = _read(path())
    shipped = default_text()
    content = mine if mine is not None else shipped
    return {"path": path(), "on": is_on(), "content": content, "default": shipped,
            "customized": bool(shipped) and content.strip() != shipped.strip(), "exists": mine is not None}


def write(text):
    if not text.strip():
        raise ValueError("Soul cannot be empty. To stop using it, turn it off: dispatch soul off")
    text = text if text.endswith("\n") else text + "\n"
    if _read(path()) == text:
        return False
    if _state().get("base") is None:
        ensure()
    backups.save(path())
    _write(text)
    return True


def reset():
    shipped = default_text()
    if not shipped.strip():
        raise ValueError("This copy of Dispatch has no default Soul to go back to.")
    changed = _read(path()) != shipped
    if changed:
        backups.save(path())
        _write(shipped)
    _save_state(base=digest(shipped))
    return changed


def set_on(on):
    _save_state(on=bool(on))


def _edit_in_editor():
    ensure()
    p = path()
    editor = os.environ.get("VISUAL") or os.environ.get("EDITOR")
    before = _read(p)
    if editor:
        subprocess.run(f'{editor} "{p}"', shell=True)
    elif sys.platform == "darwin":
        subprocess.run(["open", "-W", "-t", p])
    else:
        raise SystemExit(f"Set EDITOR, or give the new text on standard input: dispatch soul edit < file  ({p})")
    return _read(p) != before


def command(a, sync):
    """`sync()` runs `dispatch rules sync` and returns its results."""
    op = a.op or "show"
    as_json = getattr(a, "json", False)

    def done(changed, msg, after="New sessions of every agent use it."):
        res = sync() if changed else []
        if changed:
            msg += " " + (after if res else "Agents get it once Dispatch is set up for them (dispatch rules sync).")
        if as_json:
            print(json.dumps({"ok": True, "changed": changed, "synced": res, **status()}, ensure_ascii=False))
        else:
            print(msg)

    if op == "path":
        print(path())
        return
    if op == "show":
        # a new person gets the default here; an unchanged copy follows a newer default, and the agents with it
        if ensure() in ("created", "updated") and is_on():
            sync()
        st = status()
        if as_json:
            print(json.dumps(st, ensure_ascii=False))
        else:
            print(st["content"], end="" if st["content"].endswith("\n") else "\n")
            print(f"\n({'on' if st['on'] else 'off'}; {'changed by you' if st['customized'] else 'the default'}; {st['path']})", file=sys.stderr)
        return
    try:
        if op == "edit":
            if sys.stdin is not None and not sys.stdin.isatty():
                changed = write(sys.stdin.read())
            else:
                changed = _edit_in_editor()
            return done(changed, "Soul saved." if changed else "Soul unchanged.")
        if op == "reset":
            return done(reset(), "Soul is back to the default.")
        if op in ("on", "off"):
            changed = is_on() != (op == "on")
            set_on(op == "on")
            if op == "on":
                ensure()
            return done(changed, f"Soul is {op}." if changed else f"Soul was already {op}.",
                        "New sessions of every agent use it." if op == "on" else "New sessions use each agent's own tone.")
    except ValueError as e:
        if as_json:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        else:
            print(str(e), file=sys.stderr)
        sys.exit(2)
    raise SystemExit(f"unknown op {op}")


def add_parser(sub, fn):
    s = sub.add_parser("soul", help="how every agent talks and works (~/.dispatch/rules/SOUL.md): show | edit (text on stdin) | reset | on | off | path")
    s.add_argument("op", nargs="?", default="show", choices=["show", "edit", "reset", "on", "off", "path"])
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=fn)
    return s
