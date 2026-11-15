# -*- coding: utf-8 -*-
"""The phone's API behind mobile.py (docs/mobile-protocol.md, "Endpoints"). Every answer comes from
what the CLI already computes (`dispatch list`, `sessions`, `session`, `waiting`, `assistant`, `task`,
`docs`, `projects-view`, `customizations`, `machines`, `prefs`, `wiki`), called in process through
mobile.Cli, then shaped for the phone by the `phone_*` functions (pure, tested in test_mobile.py).
Sending, stopping, approving and answering go through chatd's door like `dispatch reply` does."""
import difflib
import json
import os
import queue
import re
import threading
import time
import uuid

import mobile

CHAT_EVENTS = {"opened", "state", "turn_started", "text_delta", "text_done", "tool_start", "tool_end", "permission_request",
               "permission_resolved", "queued", "queue", "turn_done", "closed", "error", "diff_updated"}
RECENT_DAYS = 14
SESSIONS_LIMIT = 80
# how many sessions of one project the phone gets when it asks for that project's history
PROJECT_HISTORY = 200
TOOL_VERBS = {
    "read": ("file", "Read"), "edit": ("pen", "Edited"), "shell": ("term", "Ran"), "search": ("search", "Searched"),
    "agent": ("agent", "Delegated"), "web": ("book", "Looked up"), "question": ("chat", "Asked"),
}


def chat_agents():
    """The session-key prefixes of the engines Dispatch drives (claude-code, codex, opencode): the phone lists and
    starts only those."""
    import engines
    return tuple(e.agent for e in engines.runnable())


def now():
    return time.time()


def _epoch(v):
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str) and v:
        try:
            from datetime import datetime
            return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0.0
    return 0.0


def _short(text, n=160):
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= n else text[: n - 1] + "…"


def _duration(seconds):
    s = int(max(0, seconds))
    return f"{s // 60}m {s % 60:02d}s" if s >= 60 else f"{s}s"


# ---- shaping for the phone (pure) ---------------------------------------------------------------

def session_state(live, waiting_kind=None, chat_life=None):
    """run / wait / idle / err for a session row: waiting for the person wins, then running."""
    if waiting_kind in ("approve", "decide"):
        return "wait"
    if chat_life in ("waiting_permission", "waiting_input"):
        return "wait"
    if chat_life in ("running", "starting"):
        return "run"
    if chat_life == "error":
        return "err"
    if chat_life:  # chatd holds it: its lifecycle is the truth (idle, stopped)
        return "idle"
    if live and (live.get("state") == "working"):
        return "run"
    if live and live.get("attention") in ("input", "permission"):
        return "wait"
    return "idle"


def phone_session(row, live=None, waiting_kind=None, chat=None, chats_dir=""):
    agent = row.get("agent") or ""
    sid = row.get("session_id") or ""
    cwd = row.get("cwd") or ""
    project = row.get("project") or ""
    if chats_dir and cwd.startswith(chats_dir):
        project = ""
    chat = chat or {}
    return {
        "id": f"{agent}:{sid}", "title": _short(row.get("title") or row.get("first_prompt") or "Untitled", 120),
        "project": project, "cwd": cwd, "engine": agent,
        "state": session_state(live, waiting_kind, chat.get("lifecycle")),
        "unread": waiting_kind == "unread",
        "last_at": float(row.get("last_at") or _epoch(row.get("last_ts")) or 0),
        "model": chat.get("model") or row.get("model") or "",
        # the names Settings › Agents gives the three levels (autonomy.py), the same everywhere (task-o2r5g)
        "mode": {"default": "Always ask", "acceptEdits": "Ask for risky actions", "plan": "Plan only",
                 "bypassPermissions": "Full auto"}.get(chat.get("permission_mode") or (live or {}).get("permission_mode") or "default", "Always ask"),
        "branch": row.get("branch") or "",
    }


def keep_row(row, started, assistant_dir, now_=None, days=RECENT_DAYS):
    """The sessions the phone lists: this Mac's own conversations of the last two weeks, not
    sub-agents, not scripted runs (`claude -p`) unless Dispatch started them, not the Assistant's."""
    now_ = now_ or now()
    if row.get("agent") not in chat_agents():
        return False
    if row.get("subagent") or "/sub/" in str(row.get("session_id") or ""):
        return False
    key = f"{row.get('agent')}:{row.get('session_id')}"
    if row.get("entrypoint") in ("sdk-cli", "exec", "sdk-py", "sdk-ts") and key not in started:
        return False
    if assistant_dir and (row.get("cwd") or "").rstrip("/") == assistant_dir.rstrip("/"):
        return False
    last = float(row.get("last_at") or _epoch(row.get("last_ts")) or 0)
    return now_ - last <= days * 86400


def tool_step(b):
    from chat_protocol import tool_kind
    kind = tool_kind(b.get("name") or "")
    icon, verb = TOOL_VERBS.get(kind, ("zap", b.get("name") or "Tool"))
    if (b.get("name") or "") == "TodoWrite":
        icon, verb = "tasks", "Planned"
    inp = b.get("input") or {}
    arg = b.get("summary") or inp.get("file_path") or inp.get("path") or inp.get("command") or inp.get("pattern") or ""
    step = {"id": str(b.get("id") or uuid.uuid4().hex[:8]), "icon": icon, "verb": verb, "arg": _short(arg, 120),
            "running": b.get("status") == "running", "ok": b.get("status") != "error"}
    if kind == "edit":
        old = str(inp.get("old_string") or inp.get("oldText") or "")
        new = str(inp.get("new_string") or inp.get("content") or inp.get("newText") or "")
        a, d = diff_counts(old, new)
        step["added"], step["deleted"] = a, d
    return step


def diff_counts(old, new):
    a = d = 0
    for line in difflib.ndiff(old.splitlines(), new.splitlines()):
        if line.startswith("+ "):
            a += 1
        elif line.startswith("- "):
            d += 1
    return a, d


def phone_items(detail, running=False):
    """A transcript (dispatch session --json) as the phone's blocks: user, assistant, steps (a turn's
    tool calls folded into one line: "Worked for 3m 40s · 5 steps"), working (the call running now)."""
    items = []
    steps, first_ts, last_ts = [], None, None

    def flush(final=False):
        nonlocal steps, first_ts, last_ts
        if not steps:
            return
        live = [s for s in steps if s["running"]]
        done = [s for s in steps if not s["running"]]
        if done:
            items.append({"id": "steps-" + done[0]["id"], "kind": "steps", "summary": f"Worked for {_duration((last_ts or 0) - (first_ts or 0))}",
                          "count": len(done), "items": done})
        if live and running and final:
            s = live[-1]
            items.append({"id": "working-" + s["id"], "kind": "working", "verb": s["verb"], "arg": s["arg"]})
        steps, first_ts, last_ts = [], None, None

    for m in detail.get("messages") or []:
        ts = _epoch(m.get("ts"))
        if m.get("role") == "user":
            flush()
            text = (m.get("text") or "").strip()
            if text:
                items.append({"id": f"u-{int(ts * 1000)}-{len(items)}", "kind": "user", "text": text[:16000]})
            continue
        for b in m.get("blocks") or [{"type": "text", "text": m.get("text") or ""}]:
            t = b.get("type")
            if t == "tool_call":
                steps.append(tool_step(b))
                bt = _epoch(b.get("ts")) or ts
                first_ts = bt if first_ts is None else first_ts
                last_ts = max(_epoch(b.get("result_ts")) or bt, last_ts or 0)
            elif t == "text" and (b.get("text") or "").strip():
                flush()
                items.append({"id": f"a-{int(ts * 1000)}-{len(items)}", "kind": "assistant", "text": b["text"].strip()[:24000]})
    flush(final=True)
    if running and (not items or items[-1]["kind"] not in ("working",)):
        items.append({"id": "thinking", "kind": "thinking", "seconds": 0})
    return items


def phone_changes(detail):
    """The files a session changed, each with its hunks (single column, the phone wraps long lines)."""
    files = []
    for f in detail.get("files") or []:
        path = f.get("path") or ""
        hunks, add, dele = [], 0, 0
        for i, ch in enumerate(f.get("changes") or []):
            old, new = str(ch.get("old") or ""), str(ch.get("new") or "")
            lines, n_old, n_new = [], 0, 0
            for line in difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=2):
                if line.startswith(("---", "+++")):
                    continue
                if line.startswith("@@"):
                    m = re.match(r"@@ -(\d+)(?:,\d+)? \+(\d+)", line)
                    n_old, n_new = (int(m.group(1)), int(m.group(2))) if m else (1, 1)
                    continue
                if line.startswith("+"):
                    lines.append({"n": n_new, "k": "add", "t": line[1:]})
                    n_new += 1
                    add += 1
                elif line.startswith("-"):
                    lines.append({"n": n_old, "k": "del", "t": line[1:]})
                    n_old += 1
                    dele += 1
                else:
                    lines.append({"n": n_new, "k": "ctx", "t": line[1:]})
                    n_old += 1
                    n_new += 1
            if lines:
                hunks.append({"id": f"{path}#{i}", "header": f"@@ {os.path.basename(path)} @@", "lines": lines[:200]})
        files.append({"path": path, "added": add, "deleted": dele, "hunks": hunks[:20]})
    return {"rounds": [{"id": "all", "title": "This session", "files": files}] if files else [],
            "files": len(files), "added": sum(f["added"] for f in files), "deleted": sum(f["deleted"] for f in files)}


def phone_waiting(data):
    """dispatch waiting --json → cards: approve, decide (design directions A / B), question, unread, only_you."""
    out = []
    for it in data.get("items") or []:
        kind = it.get("kind")
        base = {"id": it.get("id"), "project": it.get("project") or "", "session": it.get("session") or "",
                "session_title": _short(it.get("title") or "", 80), "at": float(it.get("stopped_at") or it.get("at") or 0),
                "task": it.get("task") or ""}
        if kind == "approve":
            cmd = it.get("arg") or it.get("phrase") or ""
            out.append({**base, "kind": "approve", "title": _short(it.get("phrase") or "Needs your permission", 160),
                        "command": _short(cmd, 400), "tool": it.get("tool") or "", "can_act": "allow" in (it.get("actions") or [])})
        elif kind == "decide" and str(it.get("id", "")).startswith("task:"):
            dirs = [{"key": o.get("key"), "title": o.get("title") or ""} for o in it.get("options") or [] if isinstance(o, dict) and o.get("key")]
            out.append({**base, "kind": "decide", "session_title": _short(it.get("title") or "", 40), "title": _short(it.get("title") or "", 160),
                        "proposal": _short((it.get("question") or "").split("\n\n")[-1], 400), "directions": dirs, "doc": it.get("open") or ""})
        elif kind == "decide":
            opts = [o.get("label") or o.get("id") for o in it.get("options") or [] if isinstance(o, dict)]
            out.append({**base, "kind": "question", "title": _short(it.get("question") or it.get("phrase") or "Needs your answer", 240),
                        "options": opts, "can_act": bool(opts)})
        elif kind == "unread":
            out.append({**base, "kind": "unread", "title": _short(it.get("phrase") or "Replied", 200), "detail": _short(it.get("summary") or "", 300)})
        elif kind == "only_you":
            out.append({**base, "kind": "only_you", "title": _short(it.get("title") or "", 160), "detail": _short(it.get("phrase") or "", 200)})
    counts = data.get("counts") or {}
    return {"items": out, "counts": counts, "host_name": data.get("host_name") or ""}


def phone_tasks(data):
    out = []
    for t in data.get("tasks") or []:
        st = t.get("status") or ""
        state = "wait" if st == "waiting" or t.get("only_you") else "done" if st in ("done", "closed") else "active" if st in ("in_progress", "doing", "active") else "todo"
        plan = []
        for i, p in enumerate(t.get("plan") or []):
            txt = p.get("text") if isinstance(p, dict) else str(p)
            s = (p.get("state") or p.get("status")) if isinstance(p, dict) else ""
            plan.append({"text": _short(txt, 80), "state": "done" if s in ("done", "completed") else "active" if s in ("active", "in_progress") else "todo"})
        dels = []
        for d in t.get("deliverables") or []:
            if not isinstance(d, dict):
                continue
            kind = d.get("kind") or ""
            dels.append({"icon": {"commit": "commit", "url": "link", "file": "file", "draft": "pen", "doc": "book"}.get(kind, "book"),
                         "title": _short(d.get("label") or d.get("title") or d.get("value") or kind, 80), "doc": d.get("doc") or "",
                         "url": d.get("url") or "", "commit": d.get("commit") or (d.get("value") if kind == "commit" else "")})
        for h in t.get("handoffs") or []:
            if isinstance(h, dict):
                dels.append({"icon": "hand", "title": "Handoff · " + time.strftime("%H:%M", time.localtime(_epoch(h.get("at") or h.get("created_at")) or now())),
                             "doc": h.get("doc") or "", "url": "", "commit": ""})
        commit = next((d["commit"] for d in dels if d["commit"]), "")
        out.append({"id": t.get("id"), "title": _short(t.get("title") or "", 120), "state": state,
                    "at": float(t.get("updated_at") or t.get("created_at") or 0), "note": "Only you can do this" if t.get("only_you") else "",
                    "plan": plan, "deliverables": [d for d in dels if d["icon"] != "commit"], "commit": commit[:7],
                    "session": (t.get("agent") or "claude-code") + ":" + t["session"] if t.get("session") else ""})
    return {"tasks": out}


def phone_quota(rows):
    """Subscription limits for the Home page: Claude and Codex, the 5-hour and the weekly window, as used percent.
    `rows` is `dispatch quota --local --json`; model-specific windows (Weekly · Fable) are left out."""
    out = []
    for r in rows or []:
        import engines as E
        if not E.get(r.get("agent") or "").accounts:  # the subscriptions whose sign-ins Dispatch keeps
            continue
        wins = {}
        for w in r.get("windows") or []:
            kind = w.get("kind")
            if kind in ("session", "weekly") and kind not in wins and w.get("used_percent") is not None:
                wins[kind] = {"used_percent": round(float(w["used_percent"]), 1), "resets_at": w.get("resets_at") or 0}
        out.append({"agent": r["agent"], "plan": r.get("plan") or "", "five_hour": wins.get("session"), "weekly": wins.get("weekly"),
                    "updated_at": r.get("updated_at") or 0, "note": r.get("note") or ""})
    return out


def phone_home_tasks(per_project, now_=None):
    """Tasks of every project for Home: those in progress, and those finished today with what they delivered.
    `per_project` is a list of `dispatch task list --project … --json` answers."""
    now_ = now_ or now()
    t = time.localtime(now_)
    midnight = time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1))
    active, done = [], []
    for data in per_project:
        project = data.get("project") or ""
        mapped = {x.get("id"): x for x in phone_tasks(data)["tasks"]}
        for raw in data.get("tasks") or []:
            m = mapped.get(raw.get("id"))
            if not m:
                continue
            m = dict(m, project=project)
            if m["state"] == "done":
                at = float(raw.get("done_at") or 0)
                if at >= midnight:
                    m["at"] = at
                    done.append(m)
            elif m["state"] in ("active", "wait"):
                active.append(m)
    active.sort(key=lambda x: -x["at"])
    done.sort(key=lambda x: -x["at"])
    return {"active": active[:8], "done_today": done[:30], "done_count": len(done)}


def active_hours_today(stats):
    """Hours of today in which any agent wrote something (the hour grid of `dispatch stats --days 1`).
    The transcripts keep messages per hour, not working time, so this is the closest honest number."""
    grid = stats.get("hours") or []
    wd = time.localtime().tm_wday  # Monday = 0, the grid's row order follows `dispatch stats`
    for row in ([grid[wd]] if len(grid) == 7 else grid):
        return sum(1 for n in row if n)
    return 0


DOC_ICONS = {"交付": "pkg", "设计": "pen", "handoff": "hand", "截图": "img", "调研": "book", "复审": "check"}


def phone_docs(data, session=""):
    rows = []
    seen = set()
    for d in (data.get("docs") or []) + (data.get("reader") or []):
        if d.get("id") in seen:
            continue
        seen.add(d.get("id"))
        at = float(d.get("delivered_at") or d.get("mtime") or 0)
        task = (d.get("tasks") or [{}])[0] if d.get("tasks") else {}
        rows.append({"id": d.get("id"), "title": _short(d.get("display_title") or d.get("title") or "", 120),
                     "icon": DOC_ICONS.get(d.get("kind") or "", "file"), "at": at, "unread": bool(d.get("unseen")),
                     "in_session": bool(session) and d.get("session") == session, "delivered_for": _short(task.get("title") or "", 80),
                     "ext": d.get("ext") or "", "project": data.get("project") or ""})
    rows.sort(key=lambda r: -r["at"])
    return {"docs": rows[:120]}


def phone_projects(data, waiting=None):
    waiting = waiting or {}
    out = []
    for p in data.get("projects") or []:
        if p.get("host") not in (None, "", "local"):
            continue
        out.append({"name": p.get("name"), "label": p.get("label") or p.get("name"), "dir": p.get("dir") or "",
                    "archived": bool(p.get("archived")), "running": len(p.get("running") or []),
                    "waiting": bool(p.get("waiting_phrase")) or waiting.get(p.get("name"), 0) > 0,
                    "last_at": float(p.get("last_at") or 0), "summary": p.get("summary") or "", "now": p.get("now") or ""})
    out.sort(key=lambda r: (r["archived"], -r["last_at"]))
    return {"projects": out}


def phone_machines(rows):
    out = []
    for m in rows or []:
        att = m.get("attention") or {}
        out.append({"id": m.get("id"), "name": m.get("label") or m.get("name"), "local": bool(m.get("local")), "online": bool(m.get("online")),
                    "running": int(m.get("running") or 0), "waiting": int(att.get("total") or 0)})
    return {"machines": out}


def phone_customizations(data):
    skills = data.get("skills") or []
    builtin = [s["name"] for s in skills if s.get("builtin")]
    yours = [s["name"] for s in skills if not s.get("builtin")]
    hooks = []
    for g in (data.get("hooks") or {}).get("groups") or []:
        hooks.append({"title": g.get("event") or g.get("name") or "", "sub": g.get("name") or "", "dispatch": True})
    for o in (data.get("hooks") or {}).get("others") or []:
        hooks.append({"title": o.get("event") or "", "sub": f"{o.get('count', 1)} from {o.get('agent')}", "dispatch": False})
    rules = data.get("rules") or {}
    instr = []
    if rules.get("dispatch"):
        instr.append({"title": os.path.basename(rules["dispatch"]), "sub": "~/.dispatch/rules · all engines", "dispatch": True})
    if rules.get("source"):
        instr.append({"title": os.path.basename(rules["source"]), "sub": "~/.agents/rules · all engines", "dispatch": False})
    return {"skills": {"dispatch": builtin, "yours": yours}, "hooks": hooks, "instructions": instr}


def phone_knowledge(prefs, wiki):
    p = []
    for x in (prefs.get("items") or [])[:60]:
        if x.get("status") not in (None, "active"):
            continue
        p.append({"icon": "like" if x.get("polarity") == "like" else "ban", "text": _short(x.get("name") or x.get("text") or "", 80),
                  "sub": f"{'Like' if x.get('polarity') == 'like' else 'Avoid'} · {(x.get('area') or '').title()} · {x.get('scope_label') or x.get('scope') or 'everywhere'}"})
    w = []
    for x in (wiki if isinstance(wiki, list) else [])[:60]:
        kind = x.get("kind") or ""
        w.append({"icon": "zap" if kind == "pit" else "check", "text": _short(x.get("text") or "", 80),
                  "sub": f"{'Pitfall' if kind == 'pit' else 'Win' if kind == 'win' else kind.title()} · {x.get('project') or 'everywhere'}"})
    counts = prefs.get("counts") or {}
    return {"preferences": p, "wiki": w, "counts": {"preferences": counts.get("active", len(p)), "wiki": len(wiki) if isinstance(wiki, list) else 0,
                                                   "design": (counts.get("areas") or {}).get("design", 0)}}


IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
               ".svg": "image/svg+xml"}
# what /v1/doc sends at most when the phone does not say (`max`); the relay carries about 1 MB per message
DOC_MAX = 12_000_000
_SRC = re.compile(r"""(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2""", re.I)


def _data_uri(path, mime):
    import base64
    with open(path, "rb") as f:
        return f"data:{mime};base64," + base64.b64encode(f.read()).decode("ascii")


def inline_images(html, base_dir, budget):
    """A delivery page as one piece the phone can show: its local pictures (screenshots next to index.html) become data
    URIs while they fit in `budget` bytes; the rest get a line saying they are on the Mac."""
    left = budget - len(html.encode("utf-8"))
    skipped = 0

    def one(m):
        nonlocal left, skipped
        src = m.group(3)
        if re.match(r"^(https?:|data:|//)", src, re.I):
            return m.group(0)
        path = os.path.normpath(os.path.join(base_dir, src.split("#")[0].split("?")[0]))
        mime = IMAGE_TYPES.get(os.path.splitext(path)[1].lower())
        if not mime or not os.path.isfile(path):
            return m.group(0)
        size = os.path.getsize(path) * 4 // 3 + 40
        if size > left:
            skipped += 1
            return m.group(1) + m.group(2) + "" + m.group(2) + ' alt="This picture is too large to send right now. It is on your Mac."'
        left -= size
        return m.group(1) + m.group(2) + _data_uri(path, mime) + m.group(2)

    return _SRC.sub(one, html), skipped


def file_preview(path, title, meta, budget):
    """A picture or a PDF delivered as a document: the phone shows it as it is."""
    ext = os.path.splitext(path)[1].lower()
    size = os.path.getsize(path) * 4 // 3 + 40
    if size > budget:
        return {"ok": True, "title": title, "meta": meta, "parts": [
            {"k": "p", "t": f"This file is {os.path.getsize(path) // 1_000_000 or 1} MB, too large to send to the phone right now. "
                            "Open it on your Mac, or on the same Wi-Fi as your Mac."}]}
    if ext == ".pdf":
        return {"ok": True, "title": title, "meta": meta, "file": {"mime": "application/pdf", "data": _data_uri(path, "application/pdf")}}
    uri = _data_uri(path, IMAGE_TYPES[ext])
    html = ('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
            '<body style="margin:0;background:#888"><img style="width:100%;display:block" src="' + uri + '"></body></html>')
    return {"ok": True, "title": title, "meta": meta, "html": html}


def inline_part_images(parts, base_dir, budget):
    """The pictures of a Markdown document (screenshots next to it) as data URIs while they fit in `budget` bytes; the
    ones that do not fit, or are not on this Mac, are left out. Returns how many were left out."""
    left, skipped, out = budget, 0, []
    for p in parts:
        if p.get("k") != "img":
            out.append(p)
            continue
        src = p["src"]
        path = os.path.normpath(os.path.join(base_dir, src.split("#")[0].split("?")[0]))
        mime = IMAGE_TYPES.get(os.path.splitext(path)[1].lower())
        size = os.path.getsize(path) * 4 // 3 + 40 if mime and os.path.isfile(path) else None
        if size is None or size > left:
            skipped += 1
            continue
        left -= size
        out.append({"k": "img", "alt": p.get("alt") or "", "src": _data_uri(path, mime)})
    parts[:] = out
    return skipped


def markdown_parts(text):
    """A Markdown document as the reader's parts (headings, paragraphs, lists, code); the phone lays them out."""
    parts, para, bullets, numbered, code = [], [], [], [], None
    def end():
        nonlocal para, bullets, numbered
        if para:
            parts.append({"k": "p", "t": " ".join(para)})
        if bullets:
            parts.append({"k": "ul", "items": bullets})
        if numbered:
            parts.append({"k": "ol", "items": numbered})
        para, bullets, numbered = [], [], []
    title = ""
    for line in text.splitlines():
        if code is not None:
            if line.startswith("```"):
                parts.append({"k": "code", "t": "\n".join(code)})
                code = None
            else:
                code.append(line)
            continue
        if line.startswith("```"):
            end()
            code = []
            continue
        s = line.strip()
        if not s:
            end()
            continue
        m = re.match(r"^!\[([^\]]*)\]\(([^)\s]+)[^)]*\)$", s)
        if m and os.path.splitext(m.group(2).split("#")[0].split("?")[0])[1].lower() in IMAGE_TYPES:
            end()
            parts.append({"k": "img", "alt": m.group(1), "src": m.group(2)})
            continue
        m = re.match(r"^(#{1,6})\s+(.*)", s)
        if m:
            end()
            if len(m.group(1)) == 1 and not title:
                title = m.group(2)
            else:
                parts.append({"k": "h", "t": m.group(2)})
            continue
        m = re.match(r"^[-*+]\s+(.*)", s)
        if m:
            if para:
                end()
            bullets.append(m.group(1))
            continue
        m = re.match(r"^\d+[.)]\s+(.*)", s)
        if m:
            if para:
                end()
            numbered.append(m.group(1))
            continue
        para.append(s)
    end()
    return title, parts


# ---- events -------------------------------------------------------------------------------------

class EventHub:
    """chatd's events (through its door, like `dispatch agent`) fanned out to the phones' event
    streams, trimmed to what a phone shows, plus a `changed` nudge when Waiting's counts move."""

    def __init__(self, d):
        self.d = d
        self.subs = []
        self.lock = threading.Lock()
        self.stop_ = threading.Event()
        self.counts = None
        self.last_seq = 0

    def start(self):
        threading.Thread(target=self._chat_loop, daemon=True).start()
        threading.Thread(target=self._watch_loop, daemon=True).start()

    def stop(self):
        self.stop_.set()

    def subscribe(self):
        q = queue.Queue(maxsize=2000)
        with self.lock:
            self.subs.append(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            if q in self.subs:
                self.subs.remove(q)

    def publish(self, kind, data):
        with self.lock:
            subs = list(self.subs)
        for q in subs:
            try:
                q.put_nowait((kind, data))
            except queue.Full:
                pass

    @staticmethod
    def trim(e):
        e = {k: v for k, v in e.items() if k not in ("patch", "transcript")}
        if e.get("ev") == "tool_end" and isinstance(e.get("output"), str):
            e["output"] = e["output"][:2000]
        if e.get("ev") == "tool_start" and isinstance(e.get("input"), dict):
            e["input"] = {k: (v[:400] if isinstance(v, str) else v) for k, v in list(e["input"].items())[:8]}
        return e

    def _chat_loop(self):
        import chat_client
        wait = 1.0
        while not self.stop_.is_set():
            try:
                with chat_client.ChatClient.connect(self.d, timeout=5, autostart=False) as c:
                    wait = 1.0
                    while not self.stop_.is_set():
                        for e in c.events(1.0):
                            # `replay` re-sends a turn verbatim with the original seq: already told
                            seq = e.get("seq") or 0
                            if seq and seq <= self.last_seq:
                                continue
                            if e.get("ev") == "chatd" and e.get("state") == "up":
                                self.last_seq = 0
                            self.last_seq = max(self.last_seq, seq)
                            if e.get("ev") in CHAT_EVENTS and e.get("session"):
                                self.publish("chat", self.trim(e))
            except Exception:
                self.stop_.wait(wait)
                wait = min(wait * 2, 15)

    def _watch_loop(self):
        while not self.stop_.wait(5.0):
            with self.lock:
                if not self.subs:
                    continue
            try:
                data = mobile.Cli.json(["waiting", "--json"], default={})
                counts = {k: (data.get("counts") or {}).get(k, 0) for k in ("approve", "decide", "unread", "only_you")}
                keys = sorted(i.get("id", "") for i in data.get("items") or [])
                sig = (counts, keys)
                if sig != self.counts:
                    self.counts = sig
                    self.publish("changed", {"what": "waiting", "counts": counts})
            except Exception:
                pass


# ---- the API --------------------------------------------------------------------------------------

class Api:
    def __init__(self, service):
        self.svc = service
        self.cache = {}
        self.cache_lock = threading.Lock()
        self.streams = {}        # pair id -> open event streams (mobile_push: in front only with one open)

    def cached(self, key, ttl, fn):
        with self.cache_lock:
            hit = self.cache.get(key)
            if hit and now() - hit[0] < ttl:
                return hit[1]
        val = fn()
        with self.cache_lock:
            self.cache[key] = (now(), val)
        return val

    def drop(self, *keys):
        with self.cache_lock:
            for k in keys:
                self.cache.pop(k, None)

    # routing ---------------------------------------------------------------------------------

    def handle(self, method, path, query, body, pair):
        q = {k: v[0] for k, v in query.items()}
        data = json.loads(body.decode("utf-8") or "{}") if body else {}
        routes = {
            ("GET", "/v1/hello"): self.hello,
            ("GET", "/v1/sessions"): self.sessions,
            ("GET", "/v1/session"): self.session,
            ("GET", "/v1/session/changes"): self.changes,
            ("POST", "/v1/session/send"): self.send,
            ("POST", "/v1/session/stop"): self.stop,
            ("POST", "/v1/session/permission"): self.permission,
            ("POST", "/v1/session/answer"): self.answer,
            ("POST", "/v1/session/new"): self.new_session,
            ("GET", "/v1/waiting"): self.waiting,
            ("POST", "/v1/waiting/act"): self.waiting_act,
            ("GET", "/v1/assistant"): self.assistant,
            ("POST", "/v1/assistant/send"): self.assistant_send,
            ("GET", "/v1/tasks"): self.tasks,
            ("GET", "/v1/docs"): self.docs,
            ("GET", "/v1/doc"): self.doc,
            ("GET", "/v1/projects"): self.projects,
            ("GET", "/v1/customizations"): self.customizations,
            ("GET", "/v1/machines"): self.machines,
            ("GET", "/v1/knowledge"): self.knowledge,
            ("GET", "/v1/home"): self.home,
            ("GET", "/v1/notify"): self.notify,
            ("POST", "/v1/notify"): self.notify_set,
            ("POST", "/v1/notify/test"): self.notify_test,
        }
        fn = routes.get((method, path))
        if not fn:
            return 404, {"ok": False, "code": "not_found", "message": f"No {method} {path}"}
        return 200, fn({**q, **data}, pair)

    # reading ---------------------------------------------------------------------------------

    def hello(self, a, pair):
        st = self.svc.store.load()
        w = self.waiting_raw()
        c = w.get("counts") or {}
        return {"ok": True, "protocol": mobile.PROTOCOL, "mac": st["mac"], "name": mobile.mac_name(), "model": mobile.mac_model(),
                "time": now(), "waiting": sum(c.get(k, 0) for k in ("approve", "decide", "unread")), "only_you": c.get("only_you", 0),
                "device": pair.get("device_name") or "", "relay": st["settings"].get("relay_url") or "", "cloud": st["settings"].get("cloud_container") or ""}

    def waiting_raw(self):
        return self.cached("waiting", 3, lambda: mobile.Cli.json(["waiting", "--json"], default={"items": []}))

    def assistant_dir(self):
        import assistant
        return assistant.folder()

    def sessions(self, a, pair):
        """The phone's session lists: the last two weeks across projects and chats, or with `project` the whole history of one
        project (newest first, up to PROJECT_HISTORY), so an old session can be opened and picked up again."""
        project = a.get("project") or ""

        def build():
            if project:
                rows = mobile.Cli.json(["list", "--local", "--cached", "--project", project, "--limit", str(PROJECT_HISTORY), "--json"], default=[])
                days = 3650
            else:
                rows = mobile.Cli.json(["list", "--local", "--cached", "--limit", "400", "--json"], default=[])
                days = RECENT_DAYS
            live = {f"{r.get('agent')}:{r.get('session_id')}": r for r in mobile.Cli.json(["sessions", "--local", "--json"], default=[])}
            wk = {}
            for it in self.waiting_raw().get("items") or []:
                if it.get("session"):
                    wk.setdefault(it["session"], it.get("kind"))
            held = {}
            try:
                import chatd
                held = (chatd.read_registry(self.svc.d) or {}).get("sessions") or {}
            except Exception:
                pass
            import chat_protocol as cp
            started = cp.read_started(self.svc.d)
            chats_dir = os.path.join(os.path.expanduser("~"), ".dispatch", "chats")
            out, seen = [], set()
            for r in rows:
                key = f"{r.get('agent')}:{r.get('session_id')}"
                if key in seen or not keep_row(r, started, self.assistant_dir(), days=days):
                    continue
                seen.add(key)
                out.append(phone_session(r, live.get(key), wk.get(key), held.get(key), chats_dir))
            if not project:
                for key, r in live.items():  # running but not indexed yet (not the bare processes a scan finds: pid-…)
                    if str(r.get("session_id") or "").startswith("pid-") or not (r.get("title") or r.get("last_at")):
                        continue
                    if key not in seen and r.get("agent") in chat_agents() and (r.get("cwd") or "").rstrip("/") != self.assistant_dir():
                        seen.add(key)
                        out.append(phone_session(r, r, wk.get(key), held.get(key), chats_dir))
            out.sort(key=lambda s: -s["last_at"])
            if project:
                mine = [s for s in out if s["project"] == project][:PROJECT_HISTORY]
                return {"sessions": mine, "chats": [], "more_projects": 0, "project": project}
            projects = [s for s in out if s["project"]][:SESSIONS_LIMIT]
            chats = [s for s in out if not s["project"]][:30]
            return {"sessions": projects, "chats": chats, "more_projects": 0}
        return self.cached("sessions:" + project if project else "sessions", 3, build)

    def _detail(self, key, since=None):
        sid = key.split(":", 1)[-1]
        argv = ["session", sid, "--json"] + (["--since", str(since)] if since not in (None, "") else [])
        return mobile.Cli.json(argv)

    def _running(self, key):
        try:
            import chatd
            h = ((chatd.read_registry(self.svc.d) or {}).get("sessions") or {}).get(key) or {}
            if h:  # chatd holds it: its lifecycle is the answer (a process heuristic says OpenCode always works)
                return h.get("lifecycle") in ("running", "starting")
        except Exception:
            pass
        live = {f"{r.get('agent')}:{r.get('session_id')}": r for r in self.cached("live", 2, lambda: mobile.Cli.json(["sessions", "--local", "--json"], default=[]))}
        return (live.get(key) or {}).get("state") == "working"

    def session(self, a, pair):
        key = a.get("key") or ""
        d = self._detail(key)
        running = self._running(key)
        items = phone_items(d, running)
        # what waits on this session, in place in the conversation
        for it in phone_waiting(self.waiting_raw())["items"]:
            if it.get("session") != key:
                continue
            if it["kind"] == "approve":
                items.append({"id": it["id"], "kind": "permission", "title": "Allow this command?", "command": it.get("command") or it["title"],
                              "detail": it["title"] if it.get("command") else "", "item": it["id"]})
            elif it["kind"] == "question":
                items.append({"id": it["id"], "kind": "question", "question": it["title"], "options": it.get("options") or [], "item": it["id"]})
        meta = d.get("meta") or {}
        ch = phone_changes(d)
        return {"key": key, "title": meta.get("title") or "", "project": meta.get("project") or "", "cwd": meta.get("cwd") or "",
                "engine": meta.get("agent") or key.split(":", 1)[0], "items": items, "offset": d.get("offset"), "running": running,
                "files": ch["files"], "added": ch["added"], "deleted": ch["deleted"], "branch": meta.get("branch") or ""}

    def changes(self, a, pair):
        return phone_changes(self._detail(a.get("key") or ""))

    def waiting(self, a, pair):
        self.drop("waiting")
        out = phone_waiting(self.waiting_raw())
        # the whole command of a chatd approval (the list's phrase is cut to a line)
        for it in out["items"]:
            if it["kind"] == "approve" and it["id"].startswith("chat:"):
                ev = self._pending(it["session"]) or {}
                cmd = (ev.get("input") or {}).get("command") if isinstance(ev.get("input"), dict) else None
                if cmd:
                    it["command"] = _short(cmd if isinstance(cmd, str) else " ".join(map(str, cmd)), 400)
        return out

    def tasks(self, a, pair):
        argv = ["task", "list", "--json", "--limit", "60"]
        if a.get("session"):
            argv += ["--session", a["session"].split(":", 1)[-1]]
        elif a.get("project"):
            argv += ["--project", a["project"]]
        return phone_tasks(mobile.Cli.json(argv, default={"tasks": []}))

    def docs(self, a, pair):
        project = a.get("project") or ""
        argv = ["docs", project, "--json"] if project else ["docs", "--json"]
        if a.get("session"):
            argv += ["--session", a["session"].split(":", 1)[-1]]
        return phone_docs(mobile.Cli.json(argv, default={"docs": []}), a.get("session", "").split(":", 1)[-1])

    def doc(self, a, pair):
        """One document to read: Markdown as parts, HTML as the page (the phone shows it in a web view)."""
        data = mobile.Cli.json(["docs", a.get("project") or "", "--json"], default={"docs": []})
        doc = next((d for d in (data.get("docs") or []) + (data.get("reader") or []) if d.get("id") == a.get("id")), None)
        if not doc:
            return {"ok": False, "code": "not_found", "message": "No such document"}
        path = doc.get("path") or ""
        if os.path.isdir(path):
            for name in ("index.html", "README.md"):
                if os.path.exists(os.path.join(path, name)):
                    path = os.path.join(path, name)
                    break
        task = (doc.get("tasks") or [{}])[0] if doc.get("tasks") else {}
        when = float(doc.get("delivered_at") or doc.get("mtime") or 0)
        ago = int((now() - when) / 3600)
        meta = f"Delivered {ago} hours ago" if ago else "Delivered just now"
        if task.get("title"):
            meta += f" for {task['title']}"
        try:
            budget = int(a.get("max") or DOC_MAX)
        except (TypeError, ValueError):
            budget = DOC_MAX
        title0 = doc.get("display_title") or doc.get("title")
        ext = os.path.splitext(path)[1].lower()
        if (ext in IMAGE_TYPES or ext == ".pdf") and os.path.isfile(path):
            return {"id": doc["id"], **file_preview(path, title0, meta, budget)}
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read(2_000_000)
        except OSError:
            return {"ok": False, "code": "unreadable", "message": "The document is not readable on this Mac"}
        if path.endswith((".html", ".htm")):
            html, skipped = inline_images(text, os.path.dirname(path), budget)
            return {"ok": True, "id": doc["id"], "title": title0, "meta": meta, "html": html, "skipped_images": skipped}
        title, parts = markdown_parts(text)
        skipped = inline_part_images(parts, os.path.dirname(path), budget - len(text.encode("utf-8")))
        return {"ok": True, "id": doc["id"], "title": title or title0, "meta": meta, "parts": parts, "skipped_images": skipped}

    def projects(self, a, pair):
        wait = {}
        for it in self.waiting_raw().get("items") or []:
            if it.get("kind") in ("approve", "decide"):
                wait[it.get("project")] = wait.get(it.get("project"), 0) + 1
        return self.cached("projects", 10, lambda: phone_projects(mobile.Cli.json(["projects-view", "--local", "--json"], default={}), wait))

    def customizations(self, a, pair):
        return self.cached("custom", 30, lambda: phone_customizations(mobile.Cli.json(["customizations", "list", "--json"], default={})))

    def home(self, a, pair):
        """What the phone's Home tab shows besides the lists it already has: limits, today's tasks, active hours."""
        def build():
            projects = [p for p in mobile.Cli.json(["projects-view", "--local", "--json"], default={}).get("projects", [])
                        if not p.get("archived") and now() - float(p.get("last_at") or 0) < 2 * 86400][:8]
            per = []
            for p in projects:
                name = p.get("name") or ""
                if name:
                    # open tasks, and the ones finished since midnight (a closed task is not in the default list)
                    per.append(mobile.Cli.json(["task", "list", "--project", name, "--json", "--status", "open", "--limit", "40"], default={}))
                    per.append(mobile.Cli.json(["task", "list", "--project", name, "--json", "--status", "done", "--days", "1", "--limit", "40"], default={}))
            stats = mobile.Cli.json(["stats", "--days", "1", "--local", "--cached", "--json"], default={})
            return {"quota": phone_quota(mobile.Cli.json(["quota", "--local", "--json"], default=[])), "tasks": phone_home_tasks(per),
                    "active_hours": active_hours_today(stats), "sessions_today": (stats.get("total") or {}).get("sessions", 0)}
        return self.cached("home", 30, build)

    def machines(self, a, pair):
        return self.cached("machines", 10, lambda: phone_machines(mobile.Cli.json(["machines", "--json"], default=[])))

    def knowledge(self, a, pair):
        return self.cached("knowledge", 30, lambda: phone_knowledge(mobile.Cli.json(["prefs", "list", "--json"], default={}),
                                                                   mobile.Cli.json(["wiki", "list", "--dated", "--json"], default=[])))

    # acting ----------------------------------------------------------------------------------

    def _ref(self, key):
        import session_reply
        D = mobile.Cli.module()
        agent, _, sid = key.partition(":")
        with mobile.Cli.lock:
            return session_reply.exact_ref(D, sid, agent)

    def send(self, a, pair):
        import session_reply
        key, text = a.get("key") or "", a.get("text") or ""
        rid = a.get("request_id") or str(uuid.uuid4())
        try:
            ref = self._ref(key)
            with mobile.Cli.lock:
                r = session_reply.submit(mobile.Cli.module(), ref, text, rid, mode=a.get("mode") or "queue")
        except session_reply.Rejected as e:
            return {"ok": False, "state": "failed", "note": str(e)}
        self.drop("sessions")
        return {"ok": r.get("state") == "accepted", "state": r.get("state"), "note": r.get("note") or "", "request_id": rid}

    def stop(self, a, pair):
        import chat_client
        try:
            with chat_client.ChatClient.connect(self.svc.d, timeout=5, autostart=False) as c:
                c.request("interrupt", session=a.get("key"), timeout=30)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "message": str(e)}

    def _pending(self, key):
        import waiting
        return waiting.chat_pending(self.svc.d, key)

    def permission(self, a, pair):
        """Allow once / Always allow / Deny: the Waiting row (ide:… through the Agents window, chat:…
        through chatd), or chatd's open request of the session. `permission` (Allow or Deny on a notice):
        only that request; one answered already or replaced by a newer one is left alone."""
        decision = a.get("decision") or "allow"
        item = a.get("item") or ""
        want = str(a.get("permission") or "")
        key = a.get("key") or (item[len("chat:"):] if item.startswith("chat:") else "")
        self.drop("waiting", "sessions")
        if item.startswith("ide:"):
            code, out, _ = mobile.Cli.run(["waiting", "deny" if decision == "deny" else "allow", item, "--json", *(["--request", want] if want else [])])
            return {"ok": code == 0, **_json_or_note(out)}
        ev = self._pending(key) if key else None
        if not ev:
            return {"ok": False, "code": "not_waiting", "message": "This session is not waiting for a permission any more"}
        if want and ev.get("permission_id") != want:
            return {"ok": False, "code": "not_waiting", "message": "That request was answered already; the session asks something else now"}
        import chat_client
        with chat_client.ChatClient.connect(self.svc.d, timeout=5, autostart=False) as c:
            c.request("permission", timeout=15, session=key, permission_id=ev["permission_id"], decision=decision)
        return {"ok": True, "decision": decision}

    def answer(self, a, pair):
        item, option = a.get("item") or "", int(a.get("option") or 0)
        key = a.get("key") or (item[len("chat:"):] if item.startswith("chat:") else "")
        self.drop("waiting", "sessions")
        if item.startswith("ide:"):
            code, out, _ = mobile.Cli.run(["waiting", "pick", item, str(option + 1), "--json"])
            return {"ok": code == 0, **_json_or_note(out)}
        ev = self._pending(key) if key else None
        if ev and ev.get("questions"):
            q = ev["questions"][0]
            opts = [o.get("label") for o in q.get("options") or [] if isinstance(o, dict)]
            label = a.get("text") or (opts[option] if option < len(opts) else "")
            import chat_client
            with chat_client.ChatClient.connect(self.svc.d, timeout=5, autostart=False) as c:
                c.request("answer", timeout=15, session=key, permission_id=ev["permission_id"], answers={q.get("question") or q.get("header") or "0": [label]})
            return {"ok": True}
        # no open question: the answer is just the next message
        return self.send({"key": key, "text": a.get("text") or str(option + 1)}, pair)

    def waiting_act(self, a, pair):
        """Mark read / unread, Done / Reopen, snooze, pick a design direction: `dispatch waiting <op>`."""
        op, ident = a.get("op") or "", a.get("id") or ""
        if op not in ("read", "unread", "done", "reopen", "snooze", "pick", "allow", "deny"):
            return {"ok": False, "code": "bad_op", "message": f"Unknown action {op}"}
        argv = ["waiting", op]
        if op in ("done", "reopen", "snooze"):
            ident = ident.split(":", 1)[-1] if ident.startswith("task:") else ident
        if op == "read" and ident == "all":
            argv += ["--all"]
        else:
            argv += [ident]
        if op == "pick":
            argv += [str(a.get("option") or "A")]
            if a.get("reason"):
                argv += [f"--reason={a['reason']}"]
        code, out, err = mobile.Cli.run(argv + ["--json"])
        self.drop("waiting", "sessions")
        return {"ok": code == 0, **_json_or_note(out or err)}

    def new_session(self, a, pair):
        """Open a new chatd session in a project's folder (or a chat) and send the first message."""
        import chat_client
        engine = a.get("engine") if a.get("engine") in chat_agents() else chat_agents()[0]
        cwd = a.get("cwd") or ""
        if not cwd and a.get("project"):
            p = next((x for x in self.projects({}, pair)["projects"] if x["name"] == a["project"]), None)
            cwd = (p or {}).get("dir") or ""
        if not cwd:
            cwd = os.path.join(os.path.expanduser("~"), ".dispatch", "chats", time.strftime("%Y%m%d-%H%M%S"))
            os.makedirs(cwd, exist_ok=True)
        with chat_client.ChatClient.connect(self.svc.d, timeout=5, autostart=False) as c:
            opened = c.request("open", agent=engine, cwd=cwd, timeout=120)
            key = opened.get("session")
            if a.get("text"):
                c.request("send", session=key, message_id=a.get("request_id") or str(uuid.uuid4()), text=a["text"], timeout=120)
        self.drop("sessions")
        return {"ok": True, "key": key, "cwd": cwd}

    # the Assistant -----------------------------------------------------------------------------

    def _assistant_key(self):
        """The Assistant's conversation: the one this service started, else `dispatch assistant`'s newest."""
        st = self.svc.store.load()
        mine = st["settings"].get("assistant_session") or ""
        info = mobile.Cli.json(["assistant", "--json"], default={})
        s = info.get("session") or {}
        theirs = f"{s.get('agent')}:{s.get('id')}" if s.get("id") else ""
        if mine and (not theirs or float(st["settings"].get("assistant_at") or 0) >= float(s.get("last_at") or 0)):
            return mine, info.get("folder") or self.assistant_dir()
        return theirs, info.get("folder") or self.assistant_dir()

    def assistant(self, a, pair):
        key, folder = self._assistant_key()
        if not key:
            return {"key": "", "items": [], "running": False, "model": ""}
        try:
            d = self._detail(key)
        except RuntimeError:
            return {"key": key, "items": [], "running": self._running(key), "model": ""}
        running = self._running(key)
        return {"key": key, "items": phone_items(d, running), "running": running, "engine": key.split(":", 1)[0]}

    def assistant_send(self, a, pair):
        key, folder = self._assistant_key()
        if key:
            return self.send({"key": key, "text": a.get("text") or "", "request_id": a.get("request_id")}, pair)
        engine = self.svc.store.setting("assistant_agent", "claude-code")
        mobile.Cli.run(["assistant", "--json"])  # makes the folder and ASSISTANT.md when missing
        res = self.new_session({"engine": engine, "cwd": folder, "text": a.get("text") or "", "request_id": a.get("request_id")}, pair)
        st = self.svc.store.load()
        st["settings"]["assistant_session"] = res.get("key") or ""
        st["settings"]["assistant_at"] = now()
        self.svc.store.save(st)
        return {**res, "state": "accepted"}

    # notifications (mobile_push.py) ----------------------------------------------------------------

    def notify(self, a, pair):
        import mobile_push
        st = self.svc.store.load()
        return mobile_push.describe(st["pairs"].get(pair["id"]), st["settings"])

    def notify_set(self, a, pair):
        import mobile_push
        mobile_push.update_prefs(self.svc.store, pair["id"], a)
        return self.notify(a, pair)

    def notify_test(self, a, pair):
        """A test notice of `kind` (default finished) after `delay` seconds (at most 30), so the phone can be locked first."""
        import mobile_push
        kind = a.get("kind") if a.get("kind") in mobile_push.KINDS else "finished"
        try:
            delay = max(0.0, min(30.0, float(a.get("delay") or 0)))
        except (TypeError, ValueError):
            delay = 0.0
        notifier = self.svc.notifier

        def later():
            notifier.emit(mobile_push.test_event(kind), test=True)
        t = threading.Timer(delay, later)
        t.daemon = True
        t.start()
        return {"ok": True, "kind": kind, "delay": delay}

    # the stream --------------------------------------------------------------------------------

    def stream(self, handler, pair):
        """GET /v1/events: Server-Sent Events. `hello` first, then `chat` (chatd events of the sessions),
        `changed` (Waiting moved; refetch), `notice` (finished / stopped / waits for you, the kinds this
        phone asked for; mobile_push.py), `ping` every 15 seconds."""
        q = self.svc.hub.subscribe()
        with self.cache_lock:
            self.streams[pair["id"]] = self.streams.get(pair["id"], 0) + 1
        try:
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream")
            handler.send_header("Cache-Control", "no-store")
            handler.send_header("Connection", "keep-alive")
            handler.end_headers()
            handler.close_connection = True

            def emit(kind, data):
                handler.wfile.write(f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8"))
                handler.wfile.flush()

            emit("hello", {"mac": self.svc.store.load()["mac"], "time": now()})
            last = now()
            while True:
                try:
                    kind, data = q.get(timeout=5)
                    if kind != "notice" or self.svc.notifier.stream_wants(pair["id"], data):
                        emit(kind, data)
                except queue.Empty:
                    pass
                if now() - last > 15:
                    emit("ping", {"time": now()})
                    last = now()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.svc.hub.unsubscribe(q)
            with self.cache_lock:
                left = self.streams.get(pair["id"], 1) - 1
                if left > 0:
                    self.streams[pair["id"]] = left
                else:
                    self.streams.pop(pair["id"], None)

    def streaming(self, pair_id):
        """This phone has an event stream open now (a suspended app's stream closes)."""
        with self.cache_lock:
            return self.streams.get(pair_id, 0) > 0

    # pairing by the six digits -----------------------------------------------------------------------

    def pair_by_code(self, body, lan=True):
        try:
            code = json.loads(body.decode("utf-8") or "{}").get("code") or ""
        except ValueError:
            code = ""
        p, state = self.svc.store.by_code(code)
        if not p:
            return 403, {"ok": False, "code": "bad_code", "message": "That code is not right, or it expired."}
        _, _, fp = mobile.ensure_cert(self.svc.d)
        payload = mobile.pairing_payload(state, p, fp)
        return 200, {"ok": True, "url": mobile.pairing_url(payload)}


def _json_or_note(text):
    text = (text or "").strip()
    try:
        obj = json.loads(text[text.find("{"):]) if "{" in text else {}
        return obj if isinstance(obj, dict) else {"result": obj}
    except ValueError:
        return {"note": text[:300]}
