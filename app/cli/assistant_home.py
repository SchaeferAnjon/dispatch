# -*- coding: utf-8 -*-
"""The Assistant's home (`dispatch assistant home`).

  home   what the Assistant's home page shows above its input: three small cards, Waiting for you, Working
         now and Delivered today, three rows each with a count, and the Assistant's last conversation; `next`:
         what is lined up behind the working ones (things noted from chats, capture.py), in order.

A session's Now tab reads `dispatch now` (now_line.py), which finds the running session with `_match` here.

It only reads: `dispatch waiting`, the running sessions of `assistant overview` and the board.
"""
import sys

sys.dont_write_bytecode = True

import datetime
import time

D = None
ROWS = 12  # a lane shows a block per thing (up to 12) and the list under it the first five
KIND_WORD = {"approve": "Approve", "decide": "Decide", "unread": "Reply to read", "only_you": "Only you"}
DELIVERABLE_WORD = {"build": "Build", "commit": "Commit", "file": "File", "page": "Page", "url": "Page", "draft": "Draft", "doc": "Document"}


def _live():
    import assistant_live as L
    L.D = D
    return L


def _tv():
    TV = D._mod("tasks_view")
    TV.D = D
    return TV


def _today_start(now):
    d = datetime.datetime.fromtimestamp(now)
    return d.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def _clock(at):
    return time.strftime("%H:%M", time.localtime(at)) if at else ""


def waiting_card():
    try:
        W = D._mod("waiting")
        W.D = D
        got = W.collect()
    except Exception as e:
        D.debug("assistant_home.waiting", e)
        return {"count": 0, "items": [], "error": True}
    items = got.get("items") or []
    count = (got.get("counts") or {}).get("attention")
    count = count if isinstance(count, int) else len(items)
    # the same number as the Assistant row's badge and Waiting for you's row: what needs the person now
    # (approvals, questions, unread replies, Only-you tasks new since the page was last opened)
    rows = []
    for it in items[:min(count, ROWS)]:
        words = KIND_WORD.get(it.get("kind"), "Waiting")
        try:
            at = float(it.get("at") or 0)
        except (TypeError, ValueError):
            at = 0
        rows.append({"title": it.get("title") or it.get("phrase") or words, "sub": " · ".join(x for x in (it.get("project"), words) if x),
                     "project": it.get("project") or "", "tag": words, "at": at,
                     "kind": it.get("kind") or "", "task": it.get("task") or "", "resource": it.get("resource") or "", "id": it.get("id") or ""})
    return {"count": count, "items": rows, "older": max(0, len(items) - count)}


def working_card(rows):
    busy = [r for r in rows if r["status"] == "working"]
    out = []
    for r in busy[:ROWS]:
        title = (r.get("task") or {}).get("title") or r.get("title") or r["project"]
        out.append({"title": title, "sub": r.get("doing") or "Working", "project": r["project"], "key": r["key"], "id": r.get("id") or "", "at": r.get("last_at") or 0,
                    "tag": r.get("agent_name") or "",
                    "host": r.get("host") or "local", "agent": r.get("agent") or "", "agent_name": r.get("agent_name") or ""})
    return {"count": len(busy), "items": out}


def delivered_card(issues, now):
    TV = _tv()
    start = _today_start(now)
    found = []
    for t in issues or []:
        try:
            row = TV.task_row(t)
        except Exception:
            continue
        today = [d for d in row["deliverables"] if (d.get("at") or 0) >= start]
        if today:
            d = max(today, key=lambda x: x.get("at") or 0)
            word = DELIVERABLE_WORD.get(d['kind'], d['kind'].title())
            found.append({"title": row["title"], "sub": f"{word} · {_clock(d.get('at'))}", "tag": word,
                          "task": row["id"], "at": d.get("at") or 0, "project": row["project"]})
        elif row["status"] == "done" and (row.get("done_at") or 0) >= start:
            found.append({"title": row["title"], "sub": f"Done · {_clock(row['done_at'])}", "tag": "Done", "task": row["id"], "at": row["done_at"], "project": row["project"]})
    found.sort(key=lambda x: -x["at"])
    return {"count": len(found), "items": found[:ROWS]}


def home(now=None):
    """{waiting, working, delivered: {count, items}, last: the Assistant's last conversation or None}."""
    now = now or time.time()
    L = _live()
    try:
        rows = L.own_rows(now)
    except Exception as e:
        D.debug("assistant_home.rows", e)
        rows = []
    try:
        issues = _tv().board_export()
    except Exception as e:
        D.debug("assistant_home.board", e)
        issues = []
    import assistant as A
    last = None
    try:
        s = A.session_of(A.ensure()["folder"], now)
        if s:
            last = {"title": s.get("title") or "", "at": s.get("at") or s.get("last_at") or 0, "status": s.get("status") or ""}
    except Exception as e:
        D.debug("assistant_home.last", e)
    try:
        PV = D._mod("projects_view")
        PV.D = D
        folders = len([r for r in PV.registry(resolve_dirs=False) if r.get("dir") and not r.get("archived")])
    except Exception as e:
        D.debug("assistant_home.folders", e)
        folders = 0
    return {"updated_at": now, "waiting": waiting_card(), "working": working_card(rows), "delivered": delivered_card(issues, now), "last": last,
            "folders": folders, "mac": D.local_host_name(), "next": next_card(issues, now)}


def next_card(issues, now):
    """What waits in line behind the working sessions (things noted from chats, capture.py): {count, items, later,
    paused, limit}. Each item: title, project, task, pos, the person's words and whether it is new (the last hour)."""
    try:
        C = D._mod("capture")
        C.D = D
        q = C.queue_view(issues, now)
    except Exception as e:
        D.debug("assistant_home.next", e)
        return {"count": 0, "items": [], "later": [], "paused": False, "limit": 0, "failed": {}}

    def item(x):
        return {"title": x["title"], "sub": x["quote"], "project": x["project"], "task": x["id"], "at": x["at"], "pos": x.get("pos") or 0,
                "new": bool(x.get("new")), "session": x.get("session") or ""}
    return {"count": len(q["next"]), "items": [item(x) for x in q["next"]], "later": [item(x) for x in q["later"]],
            "paused": q["paused"], "limit": q["limit"], "failed": q.get("failed") or {}}


def _match(row, key):
    k = (key or "").strip()
    if not k:
        return False
    sid = row.get("id") or ""
    return k in (row.get("key"), sid, row.get("link")) or (sid and (k.endswith("/" + sid) or k.endswith(":" + sid)))
