"""One project on one screen —— `dispatch here` (现状 / 时间线 / 未完成 / 活会话能不能关) and
`dispatch lineage` (项目→任务→会话→进展, what the 脉络 page draws)."""
import json, os, re, sys, time

import dispatch as D

# ---------------------------------------------------------------- here: one project on one screen
# What happened, what is left, and which live conversations in this directory are safe to close.
# The project paragraph uses whatever model 设置 picked for summaries.

HERE_SKIP_NOTES = ("【讨论】", "【分工】", "提交：")


def iso_epoch(ts):
    dt = D.local_dt(ts or "")
    return dt.timestamp() if dt else 0.0


def first_sentence(text):
    """The first sentence of a progress note, whole — what a step node on the 脉络 page shows
    (the full note sits in its detail panel). Names are never shortened or invented: task nodes
    carry the task title as it is on the board, session nodes the session title."""
    return re.split(r"(?<=[。！？!?])|\n", (text or "").strip(), maxsplit=1)[0].strip()


def git_commits(root, days, since):
    """(ts, short hash, subject) of the repo's commits in the window, newest first."""
    if not root:
        return []
    code, o, _ = D.sh(["git", "-C", root, "log", f"--since={days} days ago", "--date=iso-strict", "--pretty=%h%x1f%cI%x1f%s"], timeout=20)
    if code != 0:
        return []
    rows = []
    for line in o.splitlines():
        parts = line.split("\x1f")
        if len(parts) != 3:
            continue
        ts = iso_epoch(parts[1])
        if ts >= since:
            rows.append((ts, parts[0], parts[2][:200]))
    return rows


def task_of_commit(subject, tids):
    """The board task a commit subject names (`feat: … (task-abc)`), if it is one of `tids`."""
    return next((x for x in re.findall(r"task-[a-z0-9]{2,}", subject) if x in tids), "")


def project_base(proj, cwd, names=None, roots=None):
    """Where a project's git log and sessions live: the current directory when it is that
    project, else the project's home — so `dispatch here -P atrium` run from anywhere still
    reads atrium's repo, not the caller's."""
    names = D.project_names() if names is None else names
    roots = (D.settings_load().get("workspace_roots") or []) if roots is None else roots
    if (D.project_of_cwd(cwd, names, roots) or "").lower() == proj.lower():
        return cwd
    return D.project_home(proj, names, roots=roots) or cwd


def acceptance_progress(issue):
    text = issue.get("acceptance_criteria") or ""
    done = text.count("- [x]") + text.count("- [X]")
    return done, done + text.count("- [ ]")


def board_export():
    """Every issue with its comments in one `bd export` call, instead of one `bd comments` per
    task — on a board with a few hundred tasks that is one 0.5s call instead of a minute."""
    code, o, _ = D.sh(["bd", "export"], timeout=60)
    if code != 0:
        return []
    rows = []
    for line in o.splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    return rows


def project_issues(name, rows=None):
    """Board items labeled project:<name>, minus outcomes and recycled tasks."""
    want = f"project:{name.lower()}"
    keep = []
    for t in board_export() if rows is None else rows:
        labels = t.get("labels") or []
        if not any(l.lower() == want for l in labels):
            continue
        if "dispatch:outcome" in labels or "dispatch:trashed" in labels:
            continue
        keep.append(t)
    return keep


def here_comments(issues, since):
    """Comments for open tasks (their last progress matters) and anything touched in the window,
    read straight off the one export that already carries them."""
    got = {}
    for t in issues:
        if (t.get("status") != "closed" or iso_epoch(t.get("updated_at")) >= since
                or iso_epoch(t.get("closed_at")) >= since):
            got[t["id"]] = sorted(t.get("comments") or [], key=lambda c: c.get("created_at") or "")
    return got


def session_task_map(issues):
    """session id → the task it belongs to on the board: the one it created (`session-origin:`)
    wins over ones it merely claimed (`session:`); newest task wins among equals."""
    out, origin = {}, {}
    for t in sorted(issues, key=lambda x: x.get("created_at") or ""):
        for l in t.get("labels") or []:
            if l.startswith("session-origin:"):
                origin[l.split(":", 1)[1]] = t.get("id", "")
            elif l.startswith("session:"):
                out[l.split(":", 1)[1]] = t.get("id", "")
    out.update(origin)
    return out


def here_timeline(proj, issues, comments, days, cwd, names=None, roots=None):
    """One line per event, newest first, grouped by local day: task progress, closes, commits,
    session summaries."""
    since = time.time() - days * 86400
    tids = {t.get("id", "") for t in issues}
    ttitles = {t.get("id", ""): t.get("title", "") for t in issues}
    entries = []
    for t in issues:
        title = t.get("title") or t.get("id", "")
        for c in comments.get(t["id"]) or []:
            body = re.sub(r"\s+", " ", c.get("text") or "").strip()
            ts = iso_epoch(c.get("created_at"))
            if not body or body.startswith(HERE_SKIP_NOTES) or ts < since:
                continue
            entries.append({"ts": ts, "kind": "task", "ref": t.get("id", ""), "task": t.get("id", ""), "task_title": title, "text": f"{title}：{body[:200]}"})
        if t.get("status") == "closed":
            ts = iso_epoch(t.get("closed_at"))
            reason = re.sub(r"\s+", " ", t.get("close_reason") or "").strip()
            if ts >= since:
                entries.append({"ts": ts, "kind": "done", "ref": t.get("id", ""), "task": t.get("id", ""), "task_title": t.get("title", ""), "text": f"完成「{title}」" + (f"：{reason[:200]}" if reason else "")})
    for ts, ref, subject in git_commits(D.git_root_of(cwd), days, since):
        found = task_of_commit(subject, tids)
        entries.append({"ts": ts, "kind": "commit", "ref": ref, "task": found, "task_title": ttitles.get(found, ""), "text": subject})
    from activity import session_preferences
    prefs = session_preferences(D.DISPATCH_DIR)
    names = D.project_names() if names is None else names
    roots = (D.settings_load().get("workspace_roots") or []) if roots is None else roots
    by_session = session_task_map(issues)
    for e in (D.load_index() or {}).values():
        if e.get("subagent") or not e.get("user_msgs"):
            continue
        summary = (prefs.get(f"{e.get('agent')}:{e.get('session_id')}") or {}).get("summary") or ""
        ts = e.get("mtime") or 0
        if not summary.strip() or ts < since:
            continue
        if (D.project_of_cwd(e.get("cwd") or "", names, roots) or "").lower() != proj.lower():
            continue
        # Which task a session belongs to: its last claim, else a `session:` label on the board.
        # A task id merely mentioned in the transcript is not ownership (one planning
        # conversation names dozens), so such sessions stay in the 未挂任务 group.
        sid = e.get("session_id", "")
        claimed = next((x for x in reversed(e.get("claims") or []) if x in tids), "") or by_session.get(sid, "")
        entries.append({"ts": ts, "kind": "session", "ref": sid, "task": claimed, "task_title": ttitles.get(claimed, ""), "text": f"会话「{e.get('title') or sid}」：{summary.strip()[:200]}"})
    entries.sort(key=lambda x: -x["ts"])
    grouped = []
    for e in entries:
        lt = time.localtime(e["ts"])
        day = time.strftime("%Y-%m-%d", lt)
        if not grouped or grouped[-1]["day"] != day:
            grouped.append({"day": day, "weekday": "周" + "一二三四五六日"[lt.tm_wday], "entries": []})
        grouped[-1]["entries"].append(e)
    return grouped


def here_open_tasks(issues, comments):
    rows = []
    for t in issues or []:
        if t.get("status") in ("closed", "tombstone", "deferred"):
            continue
        done, total = acceptance_progress(t)
        notes = comments.get(t["id"]) or []
        last = notes[-1] if notes else {}
        rows.append({"id": t.get("id", ""), "title": t.get("title", ""), "status": t.get("status", ""),
                     "assignee": t.get("assignee") or "", "acceptance_done": done, "acceptance_total": total,
                     "last_at": max(iso_epoch(t.get("updated_at")), iso_epoch(last.get("created_at"))),
                     "last_note": re.sub(r"\s+", " ", last.get("text") or "").strip()[:160]})
    rows.sort(key=lambda r: (r["status"] != "in_progress", -(r["last_at"] or 0)))
    return rows


def here_sessions(proj, detected, cwd, issues, names=None, roots=None):
    """Live conversations in this project/directory, each with a close-or-not verdict."""
    names = D.project_names() if names is None else names
    roots = (D.settings_load().get("workspace_roots") or []) if roots is None else roots
    from activity import session_preferences
    prefs = session_preferences(D.DISPATCH_DIR)
    try:
        live = D.live_sessions()
    except Exception:
        live = []
    try:
        edits = D.session_edit_map(window=24 * 3600)
    except Exception:
        edits = {}
    norm = os.path.normpath(cwd)
    titles = {}
    for e in (D.load_index() or {}).values():
        if e.get("session_id"):
            titles.setdefault(e["session_id"], e.get("title") or "")
    # One terminal process can hold several session records (cleared/resumed); only the first
    # gets herdr attached by cwd, so hand the same pane to the rest by agent_pid.
    pane_by_pid = {}
    for x in live:
        if (x.get("herdr") or {}).get("pane_id") and x.get("agent_pid"):
            pane_by_pid.setdefault(x["agent_pid"], x["herdr"]["pane_id"])

    def mine(scwd):
        sc = os.path.normpath(scwd or "")
        if not sc:
            return False
        if detected:
            return (D.project_of_cwd(sc, names, roots) or "").lower() == proj.lower()
        return sc == norm or sc.startswith(norm + os.sep) or norm.startswith(sc + os.sep)

    rows, seen = [], set()
    for s in live:
        if not s.get("alive") or not mine(s.get("cwd")):
            continue
        sid = s.get("session_id") or ""
        key = f"{s.get('agent')}:{sid}"
        if key in seen:
            continue
        seen.add(key)
        linked = [t for t in issues if any(l in (f"session:{sid}", f"session-origin:{sid}") for l in (t.get("labels") or []))]
        unfinished = [t for t in linked if t.get("status") != "closed"]
        files = sorted(((edits.get(sid) or {}).get("files") or {}).items(), key=lambda kv: -kv[1])
        state = s.get("state") or "unknown"
        if state == "working":
            verdict, reason = "别关", "正在跑"
        elif unfinished:
            verdict, reason = "别关", "还在做「" + (unfinished[0].get("title") or "")[:30] + "」"
        elif files:
            verdict, reason = "别关", f"最近改过 {len(files)} 个文件（可能有未提交改动）"
        else:
            verdict, reason = "可关", ""
        title = s.get("title") or (s.get("herdr") or {}).get("title") or titles.get(sid) or (linked[0].get("title") if linked else "") or ""
        pane_id = (s.get("herdr") or {}).get("pane_id") or pane_by_pid.get(s.get("agent_pid")) or ""
        rows.append({"agent": s.get("agent", ""), "session_id": sid,
                     "title": title,
                     "pane_id": pane_id,
                     "cwd": s.get("cwd") or "", "source_app": s.get("source_app") or "",
                     "summary": (prefs.get(key) or {}).get("summary") or "", "state": state,
                     "last_at": s.get("last_at") or 0,
                     "tasks": [{"id": t.get("id"), "title": t.get("title"), "status": t.get("status")} for t in linked],
                     "tasks_all_done": bool(linked) and not unfinished,
                     "files": [f for f, _ in files[:12]], "files_count": len(files),
                     "verdict": verdict, "reason": reason})
    rows.sort(key=lambda r: (r["verdict"] != "别关", -(r["last_at"] or 0)))
    return rows


HERE_REMOTE_TTL = 30


def merge_remote_here(proj, days, timeline, sessions):
    """Ask every other Mac in hosts.json for its own `here --local` and merge: board entries are
    shared (dedupe by kind+ref+ts), commits by hash, sessions by id; remote rows carry `host`.

    Never waits for the ssh: the other Mac needs seconds to compute its side, and the 项目回顾
    page must paint now. We merge whatever its cache holds and let a detached refresh write the
    next answer; a cache older than the ttl is reported in `stale_hosts` so the page can say so."""
    hosts_seen, unavailable, stale = [], [], []
    entries = [e for g in timeline for e in g["entries"]]
    seen = {(e["kind"], e.get("ref", ""), round(e.get("ts", 0))) for e in entries}
    seen_refs = {(e["kind"], e.get("ref", "")) for e in entries if e["kind"] in ("commit", "session")}
    sids = {s.get("session_id") for s in sessions}
    for h in D.hosts():
        rargs = ["here", proj, "--no-summary", "--local", "--days", str(days), "--json"]
        r = D.remote_dispatch(h, rargs, HERE_REMOTE_TTL, timeout=45, background=True)
        if not isinstance(r, dict) or "timeline" not in r:
            unavailable.append(h["name"])
            continue
        hosts_seen.append(h["name"])
        age = D.remote_cache_age(h, rargs)
        if age is not None and age >= HERE_REMOTE_TTL:
            stale.append({"name": h["name"], "age": int(age)})
        for g in r.get("timeline") or []:
            for e in g.get("entries") or []:
                key = (e.get("kind"), e.get("ref", ""), round(e.get("ts", 0)))
                if key in seen or (e.get("kind") in ("commit", "session") and (e.get("kind"), e.get("ref", "")) in seen_refs):
                    continue
                seen.add(key)
                entries.append(dict(e, host=h["name"]))
        for x in r.get("sessions") or []:
            if x.get("session_id") in sids:
                continue
            sids.add(x.get("session_id"))
            sessions.append(dict(x, host=h["name"], remote=True))
    entries.sort(key=lambda x: -x["ts"])
    grouped = []
    for e in entries:
        lt = time.localtime(e["ts"])
        day = time.strftime("%Y-%m-%d", lt)
        if not grouped or grouped[-1]["day"] != day:
            grouped.append({"day": day, "weekday": "周" + "一二三四五六日"[lt.tm_wday], "entries": []})
        grouped[-1]["entries"].append(e)
    return grouped, sessions, hosts_seen, unavailable, stale


def cmd_here(a):
    cwd = os.path.abspath(os.path.expanduser(getattr(a, "dir", "") or os.getcwd()))
    days = max(1, int(getattr(a, "days", 14) or 14))
    # The export carries every issue's labels, so the project names come out of it — one whole-board
    # `bd list` less on every open of 项目回顾.
    rows = board_export()
    names = D.project_names(rows)
    roots = D.settings_load().get("workspace_roots") or []
    proj = (getattr(a, "project", "") or getattr(a, "project_opt", "") or "").strip() or D.project_of_cwd(cwd, names, roots)
    detected = bool(proj)
    proj = proj or os.path.basename(cwd.rstrip("/")) or "?"
    issues = project_issues(proj, rows)
    since = time.time() - days * 86400
    comments = here_comments(issues, since)
    summary = {"text": "", "cached": False}
    if not getattr(a, "no_summary", False):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import summarize
        if not summarize.use_enabled("here"):
            summary = {"text": "", "skipped": True, "reason": summarize.gate_message("here")}
        else:
            model = getattr(a, "summary_model", "") or ""
            try:
                r = summarize.project_summary(proj, force=getattr(a, "refresh_summary", False),
                                              if_stale=not getattr(a, "refresh_summary", False), model=model, use="here")
                summary = {"text": r.get("summary", ""), "at": r.get("at", 0), "by": r.get("by", ""), "cached": r.get("cached", False)}
            except Exception as e:
                summary = {"text": "", "error": str(e)}
    base = project_base(proj, cwd, names, roots)
    timeline = here_timeline(proj, issues, comments, days, base, names, roots)
    sessions = here_sessions(proj, detected, base, issues, names, roots)
    hosts_seen, unavailable, stale_hosts = [], [], []
    if not getattr(a, "local", False):
        # Commits come from this Mac's clone and session summaries from this Mac's index: the other
        # Mac has its own. Fold theirs in so the phone (served by the mini) and the desktop agree.
        timeline, sessions, hosts_seen, unavailable, stale_hosts = merge_remote_here(proj, days, timeline, sessions)
    report = {"project": proj, "detected": detected, "cwd": base, "timeline_days": days, "summary": summary,
              "timeline": timeline, "open_tasks": here_open_tasks(issues, comments), "sessions": sessions,
              "hosts": hosts_seen, "unavailable_hosts": unavailable, "stale_hosts": stale_hosts}

    def text(o):
        print(f"# {o['project']}" + ("" if o["detected"] else "（任务板上没认出这个项目，按目录看）") + f" · {o['cwd']}")
        s = o["summary"]
        print("\n## 现状")
        if s.get("skipped"):
            print(s.get("reason") or "总结已在设置里关闭")
        else:
            print(s.get("text") or ("（还没有项目总结：" + (s.get("error") or f"`dispatch project-summary {o['project']}` 生成") + "）"))
        print(f"\n## 最近 {o['timeline_days']} 天")
        if o["timeline"]:
            tag = {"task": "进展", "done": "完成", "commit": "提交", "session": "会话"}
            for day in o["timeline"]:
                print(f"{day['day']} {day['weekday']}")
                for e in day["entries"]:
                    print(f"  [{tag.get(e['kind'], e['kind'])}] {e['text']}")
        else:
            print("（这段时间没有记录）")
        print(f"\n## 还没做完（{len(o['open_tasks'])}）")
        for t in o["open_tasks"]:
            acc = f" {t['acceptance_done']}/{t['acceptance_total']}" if t["acceptance_total"] else ""
            who = f" · {t['assignee']}" if t["assignee"] else ""
            when = f" · {D.ago(t['last_at'])}前" if t["last_at"] else ""
            print(f"{'◐' if t['status'] == 'in_progress' else '○'} {t['title']}（{t['id']}）{acc}{who}{when}")
            if t["last_note"]:
                print(f"    {t['last_note']}")
        if not o["open_tasks"]:
            print("（没有未完成任务）")
        print(f"\n## 本目录活会话（{len(o['sessions'])}）")
        for x in o["sessions"]:
            st = {"working": "在跑", "idle": "等你", "unknown": "未登记"}.get(x["state"], x["state"])
            print(f"{'◐' if x['state'] == 'working' else '○'} {x['agent']} {x['session_id'][:8]} · 「{x['title']}」 · {st} · {D.ago(x['last_at'])}前活动")
            if x["summary"]:
                print(f"   在做：{x['summary'][:160]}")
            if x["tasks"]:
                print("   任务：" + "、".join(f"{t['title']}（{t['id']}，{'已完成' if t['status'] == 'closed' else t['status']}）" for t in x["tasks"]))
            if x["files_count"]:
                print(f"   最近改了 {x['files_count']} 个文件")
            print(f"   结论：{x['verdict']}" + (f"：{x['reason']}" if x["reason"] else ""))
        if not o["sessions"]:
            print("（本目录没有活会话）")

    D.out(report, a.json, text)


# ---------------------------------------------------------------- lineage: who is doing which task in which conversation

def lineage_report(proj, days=14, cwd="", names=None, roots=None):
    """Project → tasks → sessions → progress/commits. Task↔session links come from explicit
    labels plus claims the transcript index saw; a session that spans several tasks (「继续
    task-x」) shows up under each with the others listed in `also`. Its relation to each task:
    发起 — the task was created in it (`session-origin:`), the main line on the 脉络 page;
    在做 — it claimed / logged on it (`session:` label, claims, live link), drawn thin;
    提到 — the transcript only mentioned the id. Live status and the close-or-not verdict
    reuse `here`."""
    issues = project_issues(proj)
    tids = {t.get("id", "") for t in issues}
    since = time.time() - days * 86400
    comments = here_comments(issues, since)
    names = D.project_names() if names is None else names
    roots = (D.settings_load().get("workspace_roots") or []) if roots is None else roots
    base = project_base(proj, cwd, names, roots)
    live = here_sessions(proj, True, base, issues, names, roots)
    live_by_sid = {s["session_id"]: s for s in live}

    # Strong links (claims / explicit `session:` labels) drive the tree; transcript mentions are
    # kept separate, because one planning conversation can mention dozens of tasks and would
    # otherwise attach itself to every node.
    strong, origin, mentions, sess_meta = {}, {}, {}, {}
    for e in (D.load_index() or {}).values():
        if e.get("subagent") or not e.get("session_id"):
            continue
        sid = e["session_id"]
        for x in (e.get("claims") or []):
            if x in tids:
                strong.setdefault(sid, set()).add(x)
        for x in (e.get("tasks") or {}):
            if x in tids and x not in (strong.get(sid) or set()):
                mentions.setdefault(sid, set()).add(x)
        sess_meta.setdefault(sid, {"agent": e.get("agent", ""), "title": e.get("title") or "", "last_at": e.get("mtime", 0)})
    for t in issues:
        for l in t.get("labels") or []:
            if l.startswith("session:") or l.startswith("session-origin:"):
                strong.setdefault(l.split(":", 1)[1], set()).add(t["id"])
            if l.startswith("session-origin:"):
                origin.setdefault(l.split(":", 1)[1], set()).add(t["id"])
    titles = {t.get("id", ""): t.get("title", "") for t in issues}

    commits_by_task, loose_commits = {}, []
    for ts, ref, subject in git_commits(D.git_root_of(base), days, since):
        found = task_of_commit(subject, tids)
        rec = {"ts": ts, "kind": "commit", "ref": ref, "text": subject}
        (commits_by_task.setdefault(found, []) if found else loose_commits).append(rec)

    def deps_of(t):
        rows = []
        for d in t.get("dependencies") or []:
            other = d.get("depends_on_id")
            if other:
                rows.append({"type": d.get("type", ""), "label": {"parent-child": "包含", "blocks": "解锁", "discovered-from": "派生出"}.get(d.get("type"), d.get("type") or ""), "id": other})
        for l in t.get("labels") or []:
            if l.startswith("discussed-in:"):
                rows.append({"type": "discussed-in", "label": "拆分自", "id": l.split(":", 1)[1]})
        return rows

    order = {"in_progress": 0, "open": 1, "blocked": 2, "deferred": 3, "closed": 4}
    tasks_out = []
    for t in sorted(issues, key=lambda x: (order.get(x.get("status"), 5), -(iso_epoch(x.get("updated_at")) or 0))):
        tid = t.get("id", "")
        done, total = acceptance_progress(t)
        events = []
        for c in comments.get(tid) or []:
            body = re.sub(r"\s+", " ", c.get("text") or "").strip()
            ts = iso_epoch(c.get("created_at"))
            if body and not body.startswith(HERE_SKIP_NOTES) and ts >= since:
                events.append({"ts": ts, "kind": "task", "ref": tid, "text": body[:200], "sentence": first_sentence(body), "by": c.get("author") or ""})
        if t.get("status") == "closed":
            ts = iso_epoch(t.get("closed_at"))
            if ts >= since:
                done_text = (re.sub(r"\s+", " ", t.get("close_reason") or "").strip() or "已完成")[:200]
                events.append({"ts": ts, "kind": "done", "ref": tid, "by": t.get("assignee") or "", "text": done_text, "sentence": first_sentence(done_text)})
        events += [dict(c, by="", sentence=first_sentence(c["text"])) for c in commits_by_task.get(tid, [])]
        events.sort(key=lambda e: -e["ts"])

        def session_row(sid, relation):
            lv, meta = live_by_sid.get(sid) or {}, sess_meta.get(sid) or {}
            also = sorted((strong.get(sid) or set()) - {tid})
            return {"session_id": sid, "agent": lv.get("agent") or meta.get("agent", ""),
                    "title": lv.get("title") or meta.get("title", ""),
                    "summary": lv.get("summary", ""),
                    "state": lv.get("state") or "ended", "live": bool(lv), "relation": relation,
                    "verdict": lv.get("verdict", ""), "reason": lv.get("reason", ""),
                    "also": [titles.get(a, a) for a in also[:3]], "also_count": len(also),
                    "last_at": lv.get("last_at") or meta.get("last_at") or 0}

        sids = {sid for sid, s_tids in strong.items() if tid in s_tids}
        for s in live:
            if any(x["id"] == tid for x in s["tasks"]):
                sids.add(s["session_id"])
        sessions_out = [session_row(sid, "发起" if tid in (origin.get(sid) or ()) else "在做") for sid in sids]
        mention_sids = [sid for sid, s_tids in mentions.items() if tid in s_tids and sid not in sids]
        sessions_out += [session_row(sid, "提到") for sid in mention_sids[:8]]
        rank = {"发起": 0, "在做": 1, "提到": 2}
        sessions_out.sort(key=lambda s: (rank.get(s["relation"], 3), not s["live"], -(s["last_at"] or 0)))
        tasks_out.append({"id": tid, "title": t.get("title", ""), "status": t.get("status", ""),
                          "assignee": t.get("assignee") or "", "acceptance_done": done, "acceptance_total": total,
                          "last_at": iso_epoch(t.get("updated_at")), "deps": deps_of(t),
                          "mentions_count": len(mention_sids), "sessions": sessions_out, "events": events})

    assigned = {s["session_id"] for t in tasks_out for s in t["sessions"]}
    unassigned = [s for s in live if s["session_id"] not in assigned]
    return {"project": proj, "days": days, "cwd": base,
            "counts": {"tasks": len(tasks_out), "live_sessions": len(live), "unassigned_sessions": len(unassigned)},
            "tasks": tasks_out, "unassigned_sessions": unassigned,
            "unassigned_events": sorted(loose_commits, key=lambda e: -e["ts"])}


def cmd_lineage(a):
    cwd = os.path.abspath(os.path.expanduser(getattr(a, "dir", "") or os.getcwd()))
    days = max(1, int(getattr(a, "days", 14) or 14))
    names = D.project_names()
    roots = D.settings_load().get("workspace_roots") or []
    proj = (getattr(a, "project", "") or getattr(a, "project_opt", "") or "").strip() or D.project_of_cwd(cwd, names, roots)
    proj = proj or os.path.basename(cwd.rstrip("/")) or "?"
    report = lineage_report(proj, days, cwd, names, roots)

    def text(o):
        print(f"# {o['project']} · 脉络（最近 {o['days']} 天）")
        c = o["counts"]
        print(f"{c['tasks']} 个任务 · {c['live_sessions']} 个活会话 · {c['unassigned_sessions']} 个未挂任务的会话")
        tag = {"task": "进展", "done": "完成", "commit": "提交", "session": "会话"}
        for t in o["tasks"]:
            acc = f" {t['acceptance_done']}/{t['acceptance_total']}" if t["acceptance_total"] else ""
            who = f" · {t['assignee']}" if t["assignee"] else ""
            when = f" · {D.ago(t['last_at'])}前" if t["last_at"] else ""
            print(f"\n{'◐' if t['status'] == 'in_progress' else '○'} 「{t['title']}」（{t['id']}）{acc}{who}{when}")
            if t["deps"]:
                print("   关系：" + "、".join(f"{d['label']} {d['id']}" for d in t["deps"]))
            for s in t["sessions"]:
                if s["relation"] == "提到":
                    print(f"   （提到）{s['agent']} {s['session_id'][:8]} 「{s['title'] or s['session_id'][:8]}」")
                    continue
                st = {"working": "在跑", "idle": "等你"}.get(s["state"], "已结束")
                verdict = (f" · {s['verdict']}" + (f"：{s['reason']}" if s["reason"] else "")) if s["live"] else ""
                also = (f"（也在做 {'、'.join(s['also'])}" + (f" 等 {s['also_count']} 个" if s["also_count"] > len(s["also"]) else "") + "）") if s["also"] else ""
                print(f"   [{s['relation']}] {s['agent']} {s['session_id'][:8]} 「{s['title'] or s['session_id'][:8]}」 · {st}{verdict}{also}")
            if t["mentions_count"] > 8:
                print(f"   …另有 {t['mentions_count'] - 8} 个会话提到过")
            for e in t["events"][:6]:
                print(f"     [{tag.get(e['kind'], e['kind'])}] {e['text']}")
            if len(t["events"]) > 6:
                print(f"     …还有 {len(t['events']) - 6} 条")
        if o["unassigned_sessions"]:
            print(f"\n## 未挂任务的会话（{len(o['unassigned_sessions'])}）")
            for s in o["unassigned_sessions"]:
                st = {"working": "在跑", "idle": "等你"}.get(s["state"], "未登记")
                print(f"{'◐' if s['state'] == 'working' else '○'} {s['agent']} {s['session_id'][:8]} 「{s['title']}」 · {st} · {s['verdict']}")

    D.out(report, a.json, text)
