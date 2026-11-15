# -*- coding: utf-8 -*-
"""`dispatch inbox`: what the agents did while you looked elsewhere. The bell in the Agents window's
title bar and the Dock badge read it; Waiting for you stays the list of things to act on.

Three kinds, decided by the agent's own end-of-turn signal, never by a silence timer:

  finished   the turn ended on its own: Claude's `result` success, Codex's turn completed, the
             Agents window's session going from working to done, a terminal Claude's Stop hook
  needs_you  the agent stopped to ask: a permission, a question (the session's InputNeeded,
             chatd's permission_request, Claude's Notification hook)
  stopped    the turn ended without finishing: an error, a usage limit, the process died (chatd's
             turn_done status error, the session's Error state, Claude's StopFailure hook), or the
             person pressed stop (`why` says so; that one is filed already read)

Only finished and needs_you ring (`ring`: a macOS notification when the window is not in front);
stopped waits in the bell without a sound. One row per session counts: a newer event of a session
files its older unread ones as read (`read_by: newer`), so the number on the bell and the Dock is
"sessions that have something new for you". A session that starts working again has been seen:
`read --session` (the window calls it when the status goes back to working, or the person opens it).

Store: <DISPATCH_DIR>/inbox.json, {"v": 1, "events": [...]} newest last, at most KEEP events and
KEEP_DAYS days, written whole under a lock file (chatd's thread, the window's bridge and hooks all
write). An event:

  id, at (epoch s), kind, why (one line or ""), ring (bool), session (the key the opener needs:
  the Agents window's resource "claude:/<id>", or chatd / terminal "<agent>:<id>"), source
  (ide | chat | terminal), agent, title, project, cwd, text (the last words, one line), read (bool),
  read_at, read_by (you | newer | working | stopped)
"""
import json
from lang import t as _t
import os
import sqlite3
import sys
import time
import uuid

sys.dont_write_bytecode = True

KINDS = ("finished", "needs_you", "stopped")
SOURCES = ("ide", "chat", "terminal")
KEEP = 300
KEEP_DAYS = 14
DEDUP_SECONDS = 5      # the same session and kind again this soon is the same event (a status flicker)
TEXT_MAX = 200
TITLE_MAX = 120
FILE = "inbox.json"

# How each engine says a turn ended → (kind, why). Unknown statuses are a stop with the status as why.
FINISHED = {"success", "completed", "complete", "done", "finished", "idle", "stop"}
BY_YOU = {"interrupted", "cancelled", "canceled", "aborted", "by_you"}
ASKS = {"needs_input", "input_needed", "waiting_permission", "waiting_input", "permission", "question", "permission_prompt", "needs_you"}


def path(base=None):
    if base is None:
        import dispatch as D
        base = D.DISPATCH_DIR
    return os.path.join(base, FILE)


def classify(status, error=""):
    """(kind, why, by_you) for an engine's end-of-turn status (chatd turn_done, the window's session
    status, a hook name)."""
    s = str(status or "").strip().lower().replace("-", "_")
    if s in FINISHED:
        return "finished", "", False
    if s in ASKS:
        return "needs_you", "", False
    if s in BY_YOU:
        return "stopped", "You stopped it", True
    why = one_line(error) or ("Hit a usage limit" if "limit" in s else "Something went wrong")
    return "stopped", why, False


def one_line(text, limit=TEXT_MAX):
    t = " ".join(str(text or "").split())
    return t if len(t) <= limit else t[:limit - 1].rstrip() + "…"


# ---- the file ------------------------------------------------------------------------------------

class _Lock:
    """An exclusive lock next to the file (fcntl; a no-op where there is none)."""

    def __init__(self, p):
        self.p = p + ".lock"
        self.f = None

    def __enter__(self):
        try:
            import fcntl
            os.makedirs(os.path.dirname(self.p), exist_ok=True)
            self.f = open(self.p, "a")
            fcntl.flock(self.f, fcntl.LOCK_EX)
        except (ImportError, OSError):
            self.f = None
        return self

    def __exit__(self, *exc):
        if self.f:
            try:
                import fcntl
                fcntl.flock(self.f, fcntl.LOCK_UN)
            except (ImportError, OSError):
                pass
            self.f.close()


def load(p):
    try:
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
        ev = d.get("events") if isinstance(d, dict) else None
        return [e for e in ev if isinstance(e, dict) and e.get("kind") in KINDS] if isinstance(ev, list) else []
    except (OSError, ValueError):
        return []


def save(p, events, now=None):
    now = now or time.time()
    events = [e for e in events if now - float(e.get("at") or 0) < KEEP_DAYS * 86400][-KEEP:]
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = f"{p}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"v": 1, "events": events}, f, ensure_ascii=False)
    os.replace(tmp, p)
    return events


def _mark(e, by, now):
    e["read"] = True
    e["read_at"] = now
    e["read_by"] = by


# ---- operations ----------------------------------------------------------------------------------

def current_name(base, session, title):
    """The session's name as the person sees it now: a name given on this Mac (renamed by hand, or the
    namer's short name once the first turn is in) wins over the title the writer knew when the session
    started (chatd's label, a terminal's first prompt). Read only; the title as given when there is none."""
    p = os.path.join(base, "activity.sqlite")
    if not session or not os.path.exists(p):
        return title
    try:
        from contextlib import closing
        with closing(sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=2)) as db:
            row = db.execute("SELECT data FROM session_preferences WHERE key=?", (session,)).fetchone()
        name = (json.loads(row[0]) or {}).get("title_override") if row else ""
    except (sqlite3.Error, ValueError, TypeError, AttributeError):
        return title
    return name.strip() if isinstance(name, str) and name.strip() else title


def add(kind, session, source="ide", agent="", title="", project="", cwd="", text="", why="", by_you=False,
        base=None, now=None, turn="", words=None):
    """File one event. Returns {"event", "new"}: `new` False when it only refreshed the same event
    (the same session, kind and turn again within DEDUP_SECONDS, still unread).

    `words(session)` finds the agent's last words when the caller has none (a session that finished while
    the window did not have it loaded): a finished row then still says how it ended. When the transcript
    does not have them yet, the row is marked `text_pending` and `listing` looks again for a little while."""
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}")
    if not session:
        raise ValueError("session is required")
    now = now or time.time()
    pending = False
    if kind == "finished" and not one_line(text) and words:
        text = _words(words, session)
        pending = not text
    p = path(base)
    title = current_name(os.path.dirname(p), session, title)
    with _Lock(p):
        events = load(p)
        last = next((e for e in reversed(events) if e.get("session") == session), None)
        fields = {"agent": agent or "", "title": one_line(title, TITLE_MAX), "project": one_line(project, 80),
                  "cwd": cwd or "", "text": one_line(text), "why": one_line(why, 160)}
        if (last and last.get("kind") == kind and not last.get("read") and (last.get("turn") or "") == (turn or "")
                and now - float(last.get("at") or 0) < DEDUP_SECONDS):
            last.update({k: v for k, v in fields.items() if v})
            save(p, events, now)
            return {"event": last, "new": False}
        for e in events:
            if e.get("session") == session and not e.get("read"):
                _mark(e, "newer", now)
        ev = {"id": uuid.uuid4().hex[:12], "at": now, "kind": kind, "ring": kind in ("finished", "needs_you") and not by_you,
              "session": session, "source": source if source in SOURCES else "ide", **fields,
              "read": False, "read_at": None, "read_by": None, **({"turn": turn} if turn else {}),
              **({"text_pending": True} if pending else {})}
        if by_you:
            _mark(ev, "you", now)
        events.append(ev)
        save(p, events, now)
        return {"event": ev, "new": True}


PENDING_SECONDS = 180  # how long a finished row without words keeps looking for them


def _words(words, session):
    try:
        return one_line(words(session) or "")
    except Exception:
        return ""


def fill_pending(base=None, words=None, now=None):
    """Give finished rows that had no last words when they were filed the words the transcript has now; rows
    older than PENDING_SECONDS stop looking. Returns how many rows changed."""
    now = now or time.time()
    p = path(base)
    todo = [e for e in load(p) if e.get("text_pending")]
    if not todo:
        return 0
    found = {}
    for e in todo:
        if words and now - float(e.get("at") or 0) < PENDING_SECONDS and e["session"] not in found:
            found[e["session"]] = _words(words, e["session"])
    changed = 0
    with _Lock(p):
        events = load(p)
        for e in events:
            if not e.get("text_pending"):
                continue
            got = found.get(e["session"], "")
            if got:
                e["text"] = got
            if got or now - float(e.get("at") or 0) >= PENDING_SECONDS:
                e.pop("text_pending", None)
                changed += 1
        if changed:
            save(p, events, now)
    return changed


def listing(base=None, limit=50, unread_only=False, now=None, words=None):
    """Newest first. `unread` is the number on the bell and the Dock."""
    if words:
        fill_pending(base, words, now)
    events = load(path(base))
    unread = [e for e in events if not e.get("read")]
    counts = {k: sum(1 for e in unread if e.get("kind") == k) for k in KINDS}
    rows = unread if unread_only else events
    return {"events": list(reversed(rows))[:max(1, int(limit or 50))], "unread": len(unread), "counts": counts,
            "updated_at": now or time.time()}


def set_read(read, ids=(), session="", all_=False, by="you", base=None, now=None):
    """Mark events read (or unread again). By ids, every event of a session, or all. Returns how many
    changed and the new unread count."""
    now = now or time.time()
    ids = {i for i in ids if i}
    p = path(base)
    with _Lock(p):
        events = load(p)
        changed = 0
        for e in events:
            hit = all_ or e.get("id") in ids or (session and e.get("session") == session)
            if not hit or bool(e.get("read")) == bool(read):
                continue
            if read:
                _mark(e, by, now)
            else:
                e["read"], e["read_at"], e["read_by"] = False, None, None
            changed += 1
        if changed:
            save(p, events, now)
        return {"changed": changed, "unread": sum(1 for e in events if not e.get("read"))}


def clear(base=None):
    p = path(base)
    with _Lock(p):
        save(p, [])
    return {"changed": True, "unread": 0}


# ---- the command ---------------------------------------------------------------------------------

def _ago(at, now):
    s = max(0, int(now - float(at or 0)))
    return f"{s}s" if s < 60 else f"{s // 60}m" if s < 3600 else f"{s // 3600}h" if s < 86400 else f"{s // 86400}d"


WORD = _t({"finished": "finished", "needs_you": "needs you", "stopped": "stopped"}, {"finished": "做完了", "needs_you": "等你", "stopped": "停下了"})


def command(a, D):
    """dispatch inbox [list|add|read|unread|clear|prefs|sound]"""
    op = getattr(a, "op", "list") or "list"
    base = D.DISPATCH_DIR
    as_json = getattr(a, "json", False)
    user_data = getattr(a, "user_data", "") or ""

    def words(session):
        import session_history as H
        if H.D is None:
            H.D = D
        return H.last_words(session, user_data)

    try:
        if op == "list":
            r = listing(base, getattr(a, "limit", 50), getattr(a, "unread", False), words=words)
        elif op == "prefs":
            import notify_prefs as NP
            r = NP.prefs(D.settings_load())
        elif op == "sound":
            import notify_prefs as NP
            names = list(getattr(a, "ids", None) or [])
            r = NP.play(names[0] if names else D.settings_load().get("notify_sound", "default"))
        elif op == "add":
            status = getattr(a, "status", "") or ""
            kind = getattr(a, "kind", "") or ""
            why = getattr(a, "why", "") or ""
            by_you = False
            if status and not kind:
                kind, why0, by_you = classify(status, why)
                why = why or why0
            r = add(kind, getattr(a, "session", ""), getattr(a, "source", "ide"), getattr(a, "agent", ""),
                    getattr(a, "title", ""), getattr(a, "project", ""), getattr(a, "cwd", ""), getattr(a, "text", ""),
                    why, by_you or getattr(a, "by_you", False), base, words=words)
        elif op in ("read", "unread"):
            ids = list(getattr(a, "ids", None) or [])
            session = getattr(a, "session", "") or ""
            all_ = getattr(a, "all", False)
            if not (ids or session or all_):
                raise ValueError("give event ids, --session or --all")
            r = set_read(op == "read", ids, session, all_, getattr(a, "by", "you") or "you", base)
        elif op == "clear":
            r = clear(base)
        else:
            raise ValueError(f"unknown op {op}")
    except ValueError as e:
        D.out({"ok": False, "error": str(e)}, as_json, lambda r: print(r["error"], file=sys.stderr))
        sys.exit(2)
    r = {"ok": True, **r}

    def text(r):
        if op == "list":
            now = time.time()
            if not r["events"]:
                print(_t("Nothing new", "没有新消息"))
                return
            print(_t(f"{r['unread']} unread", f"{r['unread']} 条没看"))
            for e in r["events"]:
                mark = " " if e.get("read") else "•"
                head = e.get("title") or e.get("project") or e.get("session")
                tail = e.get("why") or e.get("text") or ""
                print(f"{mark} {WORD.get(e['kind'], e['kind'])}  {head}  {_ago(e.get('at'), now)}" + (f"\n    {tail}" if tail else ""))
        elif op == "add":
            print((_t("Recorded: ", "记下了：") if r["new"] else _t("Updated: ", "已更新：")) + WORD.get(r["event"]["kind"], ""))
        elif op == "prefs":
            on = [WORD[k] for k in KINDS if r.get(k)]
            print(_t(f"Banners on this Mac: {', '.join(on) or 'none'}; sound: {r['sound']}", f"这台 Mac 弹横幅：{'、'.join(on) or '都不弹'}；提示音：{r['sound']}"))
        elif op == "sound":
            print(_t(f"Played {r['sound']}", f"放了 {r['sound']}") if r.get("ok") and r.get("file") else _t("Silent", "不响") if r.get("ok") else _t(f"Cannot play it: {r.get('error') or r['sound']}", f"放不出来：{r.get('error') or r['sound']}"))
        else:
            print(_t(f"Changed {r.get('changed', 0)}, {r.get('unread', 0)} still unread", f"改了 {r.get('changed', 0)} 条，还有 {r.get('unread', 0)} 条没看"))

    D.out(r, as_json, text)
