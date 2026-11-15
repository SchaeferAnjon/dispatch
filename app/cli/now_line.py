# -*- coding: utf-8 -*-
"""`dispatch now`: one line, in plain words, of what a session is doing right now (task-8osd).

The agent writes it itself when it moves on to a new step (`dispatch now "Building on mini, step 2 of 5"`);
the person reads it on the session's Now tab (Dispatch IDE patches/410-now.patch), in the
Assistant's overview and on a session row. Reading also gathers what the Now tab shows next to it: the
task the session is on, its plan, what it delivered and how many times the work was handed over.

    dispatch now "Finding every agent CLI on this Mac"     # the session from the agent's environment
    dispatch now --session <id> "…"                       # someone else's, or outside an agent
    dispatch now --clear
    dispatch now --session <id> --json                      # read: {session, now, task, handoffs}
    dispatch now --session <id> --live --json               # and `live`, while the session works or waits

With --live reading also says what the session's process shows this moment (`live`: working, waiting or idle, the step it is
on in plain words, its last reply), the same facts the Assistant's overview has, so the Now tab still says
something useful before the agent has written a line, and under it once it has. It costs a look at every
running session (a few seconds), so the tab asks for it only while the session works or waits.

Stored one small file per session under <DISPATCH_DIR>/now/, so writing is cheap and needs no board.
"""
import json
import os
import re
import sys
import time

import engines as E

D = None  # the dispatch module, bound by run()

MAX = 140
SESSION_ENV = E.session_env_names()
_KEY = re.compile(r"^[A-Za-z0-9_-]{4,120}$")


def _tv():
    import tasks_view as T
    if T.D is None:
        T.D = D
    return T


def folder():
    return os.path.join(D.DISPATCH_DIR, "now")


def session_key(s):
    """The bare id of a session from whatever form it comes in (`claude:/abc`, `agent-host-codex:/x/abc`)."""
    s = (s or "").strip()
    s = re.sub(r"^[a-z][\w+.-]*:/*", "", s, flags=re.I)
    return s.split("?")[0].split("#")[0].rstrip("/").split("/")[-1]


def current_session():
    for k in SESSION_ENV:
        v = os.environ.get(k)
        if v:
            return v
    return ""


def clean(text):
    """One line, no markup the row would show raw, at most MAX characters (cut at a word when it can)."""
    t = re.sub(r"\s+", " ", (text or "").replace("`", "")).strip()
    t = re.sub(r"^[#>*\-\s]+", "", t)
    if len(t) > MAX:
        cut = t[:MAX - 1]
        space = cut.rfind(" ")
        t = (cut[:space] if space > MAX * 0.6 else cut).rstrip(" ,.;:，。；：") + "…"
    return t


def path_of(key):
    if not _KEY.match(key or ""):
        raise ValueError("Not a session id: %r" % key)
    return os.path.join(folder(), key + ".json")


def write(session, text, now=None):
    key = session_key(session)
    line = clean(text)
    if not line:
        raise ValueError("Say what the session is doing, in a few plain words.")
    rec = {"session": key, "text": line, "at": int(now or time.time()),
           "agent": (E.session_from_env()[0] or E.Engine(agent=os.environ.get("BEADS_ACTOR") or "")).agent}
    os.makedirs(folder(), mode=0o700, exist_ok=True)
    p = path_of(key)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False)
    os.replace(tmp, p)
    return rec


def clear(session):
    try:
        os.remove(path_of(session_key(session)))
        return True
    except FileNotFoundError:
        return False


def line_of(session):
    """{text, at, agent} or None. An OpenCode session in the Agents window may be filed under its own `ses_…` too."""
    keys = [session_key(session)]
    try:
        keys += [k for k in _tv().session_keys(session) if k not in keys]
    except Exception:  # noqa: BLE001 - the extra OpenCode id is a nicety
        pass
    best = None
    for k in keys:
        try:
            with open(path_of(k), encoding="utf-8") as f:
                rec = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(rec, dict) and rec.get("text") and (not best or rec.get("at", 0) > best.get("at", 0)):
            best = rec
    return best


def live_of(session, now=None):
    """{status, doing, said, at} of the running session from this Mac's live sessions (assistant_live), or None
    when it is not running or cannot be read."""
    try:
        import assistant_home as H
        H.D = D
        rows = H._live().own_rows(now)
    except Exception as e:  # noqa: BLE001 - the live part is a nicety next to the board
        D.debug("now.live", e)
        return None
    keys = {session, session_key(session)}
    row = next((r for r in rows if any(H._match(r, k) for k in keys if k)), None)
    if not row:
        return None
    return {"status": row.get("status") or "idle", "doing": row.get("doing") or "", "said": row.get("said") or "",
            "at": row.get("last_at") or 0}


def pick_task(rows):
    """The task the session is on: the newest still being worked on or waiting, else the newest done."""
    live = [r for r in rows if r["status"] in ("in_progress", "waiting")]
    pool = live or rows
    return max(pool, key=lambda r: max(r["updated_at"], r["created_at"], r["done_at"] or 0), default=None)


def read(session, issues=None, live=False):
    T = _tv()
    keys = T.session_keys(session)
    if issues is None:
        # the session's own tasks by label: the Now tab asks every few seconds, and a whole-board export each time
        # (seconds, and the board's lock for every other reader) slowed every bd call while agents wrote (task-nu516)
        issues = T.session_issues(keys) if keys else []
    rows = T.list_tasks(issues, session=keys, status="all", days=0)
    # a thing noted from this session that waits in line (Next up, Later; capture.py) is not what it is on
    lined = {t.get("id") for t in issues if {"nextup", "later"} & set(t.get("labels") or [])}
    own = [r for r in rows if r["id"] not in lined]
    task = pick_task(own)
    handoffs = []
    if task:
        # a handoff record (handoff.py) says when in `created_at`; the index's column is `created`
        when = lambda h: h.get("created_at") or h.get("created") or 0  # noqa: E731
        for h in sorted(task.get("handoffs") or [], key=when):
            handoffs.append({"at": int(when(h)), "session": h.get("session") or "", "native_session": h.get("native_session") or ""})
    return {
        "session": session_key(session),
        "now": line_of(session),
        "live": live_of(session) if live else None,
        "task": None if not task else {k: task.get(k) for k in ("id", "title", "status", "plan", "deliverables", "project", "agent", "updated_at")},
        "handoffs": handoffs,
        "tasks": len(rows),
        # every task of the session, not only the one it is on: a session that took four requests showed the newest
        # alone and the earlier ones were gone from Now (task-qa6rr); the ones in progress first, done ones last
        "session_tasks": [{k: r.get(k) for k in ("id", "title", "status", "plan", "deliverables", "updated_at")}
                          for r in sorted(own, key=lambda r: (r["status"] == "done", -max(r["updated_at"], r["created_at"], r["done_at"] or 0)))],
    }


def command(a):
    session = a.session or current_session()
    if not session:
        raise ValueError("No session here: run it inside an agent's session, or pass --session <id>.")
    if a.clear:
        gone = clear(session)
        return D.out({"ok": True, "cleared": gone}, a.json, lambda r: print("Cleared." if r["cleared"] else "Nothing to clear.")) or 0
    text = " ".join(a.text or []).strip()
    if text:
        rec = write(session, text)
        return D.out({"ok": True, **rec}, a.json, lambda r: print("Now: " + r["text"])) or 0
    res = read(session, live=bool(getattr(a, "live", False)))

    def human(r):
        print("Now: " + (r["now"]["text"] if r["now"] else "(nothing written yet)"))
        if r["task"]:
            t = r["task"]
            plan = t.get("plan") or []
            done = sum(1 for p in plan if p.get("state") == "done")
            print("Task: %s (%s)%s" % (t["title"], t["id"], " · plan %d of %d done" % (done, len(plan)) if plan else ""))
            print("Delivered: %d · handed over: %d" % (len(t.get("deliverables") or []), len(r["handoffs"])))
    return D.out(res, a.json, human) or 0


def run(a, d_module=None):
    global D
    if d_module is not None:
        D = d_module
    try:
        return command(a)
    except ValueError as e:
        if getattr(a, "json", False):
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        else:
            print(str(e), file=sys.stderr)
        return 1
