# -*- coding: utf-8 -*-
"""`dispatch link backfill`: link past conversations to the tasks they worked on.

A session is linked (`session:<id>` label) only when its transcript shows it ran a command on
the task (`bd update X --claim`, `dispatch claim|log|done|check|decide X`), which the transcript
index records as a claim. Mentions alone never link: `dispatch prime` lists the project's open
tasks at the start of every session, so "worked in the project and mentioned the id three times"
matched 41 kanban sessions for one task (task-7nn) when only 3 had worked on it. Sessions in the
task's project that mention it often are reported as 可能相关 and show as 提到过 in the app.
"""
import json, os, sys, time
from lang import t as _t

MIN_MENTIONS = 3


def _project(t):
    return next((l.split(":", 1)[1] for l in t.get("labels") or [] if l.startswith("project:")), "")


def plan(D, tasks, idx, names=None, roots=None):
    """[{task, title, status, has: [...], add: [{sid, why}], skip: [{sid, why}]}] for `tasks`."""
    names = names if names is not None else D.project_names()
    roots = roots if roots is not None else (D.settings_load().get("workspace_roots") or [])
    by_task = {}
    proj_cache = {}
    for path, e in idx.items():
        sid = e.get("session_id") or ""
        if not sid or e.get("subagent") or not D._SID_RE.match(sid):
            continue
        claims = set(e.get("claims") or [])
        for tid, n in (e.get("tasks") or {}).items():
            by_task.setdefault(tid, []).append((sid, e, n, tid in claims))
        for tid in claims - set(e.get("tasks") or {}):
            by_task.setdefault(tid, []).append((sid, e, 0, True))
    rows = []
    for t in tasks:
        tid = t["id"]
        has = sorted({l.split(":", 1)[1] for l in t.get("labels") or [] if l.startswith(("session:", "session-origin:"))})
        proj = _project(t).lower()
        add, skip, seen = [], [], set(has)
        for sid, e, n, claimed in sorted(by_task.get(tid, []), key=lambda r: -(r[1].get("mtime") or 0)):
            if sid in seen:
                continue
            seen.add(sid)
            cwd = e.get("cwd") or ""
            if cwd not in proj_cache:
                try:
                    proj_cache[cwd] = (D.project_of_cwd(cwd, names, roots) or "").lower() if cwd else ""
                except Exception:
                    proj_cache[cwd] = ""
            in_proj = bool(proj) and proj_cache[cwd] == proj
            short = f"{e.get('agent', '')}:{sid[:13]}"
            if claimed:
                add.append({"sid": sid, "agent": e.get("agent", ""), "why": _t("the transcript ran dispatch / bd commands on it", "转录里对它跑过 dispatch / bd 命令")})
            elif in_proj and n >= MIN_MENTIONS:
                skip.append({"sid": sid, "agent": e.get("agent", ""), "why": _t(f"maybe related: mentioned {n} times in project {proj}, but no command ran on it (the brief's task list counts as mentions)", f"可能相关：在项目 {proj} 里提到 {n} 次，但没对它跑过命令（prime 的任务列表也算提到）"), "label": short, "maybe": True})
            else:
                why = _t(f"only mentioned {n} times" + ("" if in_proj else f"; folder {cwd or '?'} is not in project {proj or '(the task has no project)'}"), f"只提到 {n} 次" + ("" if in_proj else f"，目录 {cwd or '?'} 不属于项目 {proj or '（任务没有项目）'}"))
                skip.append({"sid": sid, "agent": e.get("agent", ""), "why": why, "label": short})
        rows.append({"task": tid, "title": t.get("title", ""), "status": t.get("status", ""), "has": has, "add": add, "skip": skip})
    return rows


def backfill(D, a):
    statuses = [s.strip() for s in (getattr(a, "status", "") or "in_progress,closed").split(",") if s.strip()]
    days = getattr(a, "days", 30) or 30
    tasks = []
    for st in statuses:
        code, o, _ = D.sh(["bd", "list", "--status", st, "-n", "0", "--json"], timeout=30)
        try:
            tasks += json.loads(o[o.find("["):]) if code == 0 else []
        except ValueError:
            pass
    only = getattr(a, "only", "") or ""
    if only:
        tasks = [t for t in tasks if t["id"] in {x.strip() for x in only.split(",")}]
    cutoff = time.time() - days * 86400
    from datetime import datetime as _dt

    def recent(t):
        when = t.get("updated_at") or t.get("closed_at") or t.get("created_at") or ""
        try:
            return _dt.fromisoformat(when.replace("Z", "+00:00")).timestamp() >= cutoff
        except ValueError:
            return True
    tasks = [t for t in tasks if only or recent(t)]
    idx = D.refresh_index()
    rows = plan(D, tasks, idx)
    done = 0
    if not a.dry_run:
        for r in rows:
            labels = [f"session:{s}" for s in r["has"]]
            for x in r["add"]:
                if D.link_session(r["task"], sid=x["sid"], labels=labels):
                    done += 1
                    labels.append(f"session:{x['sid']}")
    shown = [r for r in rows if r["add"] or (r["skip"] and getattr(a, "verbose", False)) or only]
    if a.json:
        print(json.dumps({"dry_run": a.dry_run, "tasks": len(rows), "linked": done, "rows": shown}, ensure_ascii=False))
        return
    for r in shown:
        print(f"{r['task']} [{r['status']}] {r['title'][:44]}")
        print(_t(f"    Has: {', '.join(s[:8] for s in r['has']) or 'none'}", f"    现有：{', '.join(s[:8] for s in r['has']) or '无'}"))
        for x in r["add"]:
            print(_t(f"    {'Would add' if a.dry_run else 'Added'}: {x['agent']}:{x['sid'][:13]} ({x['why']})", f"    {'将新增' if a.dry_run else '已新增'}：{x['agent']}:{x['sid'][:13]}（{x['why']}）"))
        skips = sorted(r["skip"], key=lambda x: not x.get("maybe"))
        for x in skips[:6]:
            print(_t(f"    Skipped: {x['label']} ({x['why']})", f"    跳过：{x['label']}（{x['why']}）"))
        if len(skips) > 6:
            print(_t(f"    and skipped {len(skips) - 6} more sessions that only mention it", f"    还跳过 {len(skips) - 6} 个只提到过的会话"))
    n_add = sum(len(r["add"]) for r in rows)
    print(_t(f"Checked {len(rows)} tasks; " + (f"would add {n_add} links (dry run, nothing written; drop --dry-run to do it)" if a.dry_run else f"added {done} links"), f"共检查 {len(rows)} 个任务；" + (f"将新增 {n_add} 个关联（dry-run，没写板；去掉 --dry-run 执行）" if a.dry_run else f"新增 {done} 个关联")))
