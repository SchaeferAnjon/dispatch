# -*- coding: utf-8 -*-
"""`dispatch assistant survey`: for each registered project, what looks unfinished, in plain words.

  open tasks            the board's tasks for the project that are not done
  uncommitted changes   files changed in the working folder that git has not saved
  stopped sessions      a session of the last 14 days whose transcript ends in the middle of work and
                        that is not running now
  notes                 TODO-like lines in the newest handoff or notes file in the project folder

Every finding that is not on the board yet comes with a ready title and description (`candidates`), so the
Assistant can offer to put it on the board and, when the person agrees, run `dispatch begin` with them.
Nothing here writes anything or calls a model. Other Macs answer for their own projects
(`assistant survey --local` over the machines plumbing).
"""
import sys

sys.dont_write_bytecode = True

import glob
import os
import re
import subprocess
import time

D = None

DAYS = 14
STOP_AFTER_S = 15 * 60       # a transcript that says "working" and has been quiet this long, with no process: it stopped
MAX_FILES = 6
MAX_NOTES = 4
NOTE_NAMES = re.compile(r"(handoff|hand-off|todo|next[-_ ]?steps|notes?)", re.I)
HEADING_NEXT = re.compile(r"^\s{0,3}#{1,6}\s*.*(next|todo|remaining|follow[- ]?up|open items|not done|下一步|接下来|待办|未完成|还没|待做)", re.I)
INLINE_TODO = re.compile(r"^\s*(?:[-*]\s*)?(?:TODO|FIXME|Next|Remaining|待办|下一步|还没做|未完成)\s*[:：]\s*(\S.*)", re.I)
UNCHECKED = re.compile(r"^\s*[-*]\s*\[ \]\s*(\S.*)")


def _git(root, *args, timeout=8):
    try:
        r = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.returncode == 0 else None


NOISE = re.compile(r"(^|/)(\.DS_Store|__pycache__|node_modules|\.playwright-mcp|\.claude|\.idea|\.vscode|\.pytest_cache|\.venv|dist|build)(/|$)|\.(pyc|log|tmp|swp)$")


def changes(root):
    """{"files": n, "names": [...], "ahead": n, "branch": str}: what git has not saved yet, or None when it is not a repository.
    Editor and tool leftovers (.DS_Store, __pycache__, ...) that git does not track are not counted."""
    out = _git(root, "status", "--porcelain")
    if out is None:
        return None
    if _git(root, "rev-parse", "--verify", "-q", "HEAD") is None:
        # a repository with no commit yet: Dispatch made it one when the folder became a project, so its
        # files are not half-done work
        return {"files": 0, "names": [], "ahead": 0, "branch": "", "unborn": True}
    names = []
    for line in out.splitlines():
        name = line[3:].strip().strip('"')
        if " -> " in name:
            name = name.split(" -> ", 1)[1]
        if name and not (line.startswith("??") and NOISE.search(name)):
            names.append(name)
    branch = (_git(root, "rev-parse", "--abbrev-ref", "HEAD") or "").strip()
    ahead = (_git(root, "rev-list", "--count", "@{u}..HEAD") or "0").strip()
    return {"files": len(names), "names": names[:MAX_FILES], "ahead": int(ahead) if ahead.isdigit() else 0, "branch": branch}


def _note_files(root):
    found = []
    for pattern in ("*.md", "docs/*.md", "design/*.md", "design/handoff/*.md", "docs/handoff/*.md", ".dispatch/**/*.md"):
        for p in glob.glob(os.path.join(root, pattern), recursive=True):
            rel = os.path.relpath(p, root)
            if os.path.isfile(p) and NOTE_NAMES.search(rel) and not rel.upper().startswith(("README", "CHANGELOG", "LICENSE")):
                found.append(p)
    return sorted(set(found), key=lambda p: -os.path.getmtime(p))


def notes(root, now=None):
    """TODO-like lines from the newest handoff or notes file: {"file", "lines": [...]} or None."""
    now = now or time.time()
    for path in _note_files(root)[:3]:
        try:
            if now - os.path.getmtime(path) > 60 * 86400:
                break
            with open(path, encoding="utf-8", errors="replace") as fh:
                text = fh.read(200_000)
        except OSError:
            continue
        lines, in_next = [], False
        for line in text.splitlines():
            if re.match(r"^\s{0,3}#{1,6}\s", line):
                in_next = bool(HEADING_NEXT.match(line))
                continue
            m = UNCHECKED.match(line) or INLINE_TODO.match(line)
            if m:
                lines.append(m.group(1).strip())
            elif in_next and re.match(r"^\s*(?:[-*]|\d+[.)])\s+\S", line):
                lines.append(re.sub(r"^\s*(?:[-*]|\d+[.)])\s+", "", line).strip())
            if len(lines) >= MAX_NOTES:
                break
        if lines:
            return {"file": os.path.relpath(path, root), "lines": [_clip(l, 140) for l in lines[:MAX_NOTES]]}
    return None


def _clip(text, n):
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[:n - 1].rstrip() + "..."


def _under(cwd, root, extra):
    cwd = (cwd or "").rstrip("/")
    for base in [root, *extra]:
        base = base.rstrip("/")
        if base and (cwd == base or cwd.startswith(base + "/")):
            return True
    return False


def stopped_sessions(root, index, live_ids, now, states, extra=()):
    """Sessions of the last DAYS days in that folder (or its worktrees) that stopped in the middle of work."""
    out = []
    for path, e in (index or {}).items():
        sid = e.get("session_id")
        if not sid or e.get("subagent") or sid in live_ids:
            continue
        mtime = float(e.get("mtime") or 0)
        if now - mtime > DAYS * 86400 or not _under(e.get("cwd"), root, extra):
            continue
        state, at = states.get(sid, ("", 0))
        if state == "working" and now - (at or mtime) > STOP_AFTER_S:
            out.append({"id": sid, "agent": e.get("agent") or "", "title": (e.get("title") or e.get("first_prompt") or "").strip(),
                        "at": at or mtime})
    out.sort(key=lambda s: -s["at"])
    return out[:3]


def candidate(project, source, title, desc):
    return {"project": project, "source": source, "title": _clip(title, 80), "description": desc}


def project_survey(p, issues, TV, index, live_ids, states, now):
    root = p["dir"]
    name = p["name"]
    label = p.get("label") or name
    open_tasks = []
    if issues:
        for t in TV.select(issues, project=name):
            row = TV.task_row(t)
            if row["status"] != "done":
                open_tasks.append({"id": row["id"], "title": row["title"], "status": row["status"]})
    open_tasks.sort(key=lambda t: {"waiting": 0, "in_progress": 1, "todo": 2}.get(t["status"], 3))
    ch = changes(root) if root and os.path.isdir(root) else None
    wt = [d for d in (root + ".worktrees", os.path.join(root, ".claude", "worktrees"), root + "-wt") if os.path.isdir(d)] if root else []
    stopped = stopped_sessions(root, index, live_ids, now, states, wt) if root else []
    note = notes(root, now) if root and os.path.isdir(root) else None
    lines, cands = [], []
    if open_tasks:
        n = len(open_tasks)
        lines.append(f"{n} task{'s' if n != 1 else ''} not done on the board, for example \"{_clip(open_tasks[0]['title'], 70)}\".")
    if ch and ch["files"]:
        more = f", and {ch['files'] - len(ch['names'])} more" if ch["files"] > len(ch["names"]) else ""
        lines.append(f"{ch['files']} file{'s' if ch['files'] != 1 else ''} changed but not saved with git ({', '.join(ch['names'][:3])}{more}).")
        cands.append(candidate(label, "changes", f"{label} finish or save {ch['files']} changed file{'s' if ch['files'] != 1 else ''}: {'they are' if ch['files'] != 1 else 'it is'} not committed",
                               f"Found by the Assistant's project survey: {ch['files']} files in {root} are changed and not committed ({', '.join(ch['names'][:4])}). "
                               "Decide whether the work is done, finish it, and commit it."))
    if ch and ch["ahead"]:
        lines.append(f"{ch['ahead']} saved commit{'s' if ch['ahead'] != 1 else ''} not pushed yet on {ch['branch'] or 'this branch'}.")
    for s in stopped:
        title = s["title"] or "an untitled session"
        lines.append(f"A session stopped in the middle of work: \"{_clip(title, 70)}\".")
        cands.append(candidate(label, "session", f"{label} finish \"{_clip(title, 40)}\": the session stopped in the middle",
                               f"Found by the Assistant's project survey: a {s['agent'] or 'agent'} session in {root} ({_clip(title, 100)}) stopped while it was still working. "
                               "Read what it did, then carry on or close it."))
    if note:
        lines.append(f"The note {note['file']} still lists open items: \"{_clip(note['lines'][0], 80)}\".")
        cands.append(candidate(label, "note", f"{label} follow up the open items in {os.path.basename(note['file'])}: {_clip(note['lines'][0], 40)}",
                               f"Found by the Assistant's project survey: {note['file']} in {root} lists open items: " + "; ".join(note["lines"][:3]) + "."))
    if open_tasks:
        cands = [c for c in cands if not any(_same(c["title"], t["title"]) for t in open_tasks)]
    return {"name": name, "label": label, "dir": root, "git": bool(ch is not None),
            "open_tasks": len(open_tasks), "tasks": open_tasks[:5],
            "changed_files": ch["files"] if ch else 0, "changed_names": ch["names"] if ch else [], "unpushed_commits": ch["ahead"] if ch else 0,
            "stopped_sessions": stopped, "note": note,
            "unfinished": bool(lines), "lines": lines, "candidates": cands,
            "summary": " ".join(lines) if lines else "Nothing looks unfinished."}


def _same(a, b):
    a, b = re.sub(r"\W+", " ", a.lower()).strip(), re.sub(r"\W+", " ", b.lower()).strip()
    return bool(a and b) and (a in b or b in a)


def local(project="", now=None):
    """This Mac's registered projects, surveyed."""
    now = now or time.time()
    PV = D._mod("projects_view")
    PV.D = D
    TV = D._mod("tasks_view")
    TV.D = D
    try:
        index = D.load_index()
    except Exception:
        index = {}
    reg = [r for r in PV.registry(index=index) if r["host"] == "local" and not r["archived"] and r["dir"] and os.path.isdir(r["dir"])]
    if project:
        want = project.strip().lower()
        reg = [r for r in reg if want in (r["name"].lower(), (r.get("label") or "").lower(), r["dir"].rstrip("/").lower())]
    try:
        issues = TV.board_export()
    except Exception as e:
        D.debug("assistant_survey.board", e)
        issues = []
    try:
        live_ids = {s.get("session_id") for s in D.live_sessions(local_only=True) if s.get("alive", True)}
        live_ids |= {s.get("native_session_id") for s in D.live_sessions(local_only=True) if s.get("native_session_id")}
    except Exception:
        live_ids = set()
    sids = [e.get("session_id") for e in index.values() if e.get("session_id") and now - float(e.get("mtime") or 0) <= DAYS * 86400]
    try:
        import activity
        states = activity.transcript_states(D.DISPATCH_DIR, sids[:400])
    except Exception:
        states = {}
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=6) as pool:  # git and the notes scan wait on the disk, not on each other
        return list(pool.map(lambda p: project_survey(p, issues, TV, index, live_ids, states, now), reg))


def survey(project="", local_only=False, now=None):
    """{updated_at, machines: [{id, name, local, online, projects}], unfinished, candidates, summary}."""
    now = now or time.time()
    machines = [{"id": "local", "name": D.local_host_name(), "local": True, "online": True, "projects": local(project, now)}]
    if not local_only:
        for h in D.hosts():
            if not isinstance(h, dict) or not h.get("id"):
                continue
            args = ["assistant", "survey", "--local"] + (["--project", project] if project else [])
            got = D.remote_dispatch(h, args, 60, timeout=20)
            projects = got.get("machines", [{}])[0].get("projects", []) if isinstance(got, dict) and got.get("machines") else None
            machines.append({"id": h["id"], "name": h.get("name") or h["id"], "local": False, "online": projects is not None, "projects": projects or []})
    projects = [(m, p) for m in machines for p in m["projects"]]
    cands = [dict(c, machine=m["name"], host=m["id"]) for m, p in projects for c in p["candidates"]]
    unfinished = [p for _, p in projects if p["unfinished"]]
    summary = (f"{len(unfinished)} of {len(projects)} projects have something unfinished." if projects
               else "No projects are registered yet.")
    return {"updated_at": now, "machines": machines, "unfinished": len(unfinished), "projects": len(projects), "candidates": cands, "summary": summary}


# ---- is this already on the board? --------------------------------------------------------------------

STOP = {"the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "it", "is", "this", "that", "with", "please", "make", "fix", "add", "do", "my",
        "的", "了", "把", "和", "在", "是", "我", "你", "要", "请"}
SIMILAR_AT = 0.5


def words(text):
    """The words of a title for comparing: lower-case words of 3+ letters, and pairs of neighbouring Chinese characters."""
    text = str(text or "").lower()
    out = {w for w in re.findall(r"[a-z0-9][a-z0-9\-]{2,}", text) if w not in STOP}
    for run in re.findall(r"[一-鿿]+", text):
        out |= {run[i:i + 2] for i in range(len(run) - 1) if run[i:i + 2] not in STOP and run[i] not in STOP and run[i + 1] not in STOP}
    return out


def overlap(a, b):
    """0 to 1: how much of the shorter title's words the other one has."""
    wa, wb = words(a), words(b)
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / min(len(wa), len(wb))


def similar(title, project="", now=None):
    """Open tasks of that project (or of any, without `project`) that look like the same work as `title`:
    [{id, title, status, thing, score}], best first. The Assistant adds to one of these (`dispatch task plan`,
    `dispatch log`) instead of making a task of its own. Words overlap, no model."""
    TV = D._mod("tasks_view")
    TV.D = D
    try:
        issues = TV.board_export()
    except Exception as e:
        D.debug("assistant_survey.similar", e)
        issues = []
    out = []
    for t in TV.select(issues, project=project):
        row = TV.task_row(t)
        if row["status"] == "done":
            continue
        score = overlap(title, row["title"])
        if score >= SIMILAR_AT or (_same(title, row["title"])):
            out.append({"id": row["id"], "title": row["title"], "status": row["status"], "thing": row.get("thing") or "", "score": round(max(score, 1.0 if _same(title, row["title"]) else 0), 2)})
    out.sort(key=lambda r: -r["score"])
    return {"title": title, "project": project, "matches": out[:5], "duplicate": bool(out and out[0]["score"] >= 0.75)}


def _noted_from_chat(title, project=""):
    """A thing Dispatch noted from the person's message (capture.py, label from-chat) that is the same work as `title`:
    the Assistant's own `add` must not put it on the board a second time. Noted things often have no project yet (the
    Assistant's chat has none); given one here, the noted thing gets it. {id, title, state, state_words} or None."""
    try:
        C = D._mod("capture")
        C.D = D
        best, score = None, 0.0
        for t in C.issues():
            if "from-chat" not in (t.get("labels") or []) or C.state_of(t) in ("done", "gone", "merged"):
                continue
            p = C.project_of(t)
            if project and p and p != project:
                continue
            sc = 1.0 if _same(title, t.get("title") or "") else overlap(title, t.get("title") or "")
            if sc >= 0.6 and sc > score:
                best, score = t, sc
    except Exception as e:
        D.debug("assistant_survey.noted", e)
        return None
    if not best:
        return None
    if project and not C.project_of(best):
        try:
            C.bd(["update", best["id"], "--add-label", f"project:{project}", "--json"])
        except ValueError as e:
            D.debug("assistant_survey.noted.project", e)
    st = C.state_of(best)
    words = {"next": "lined up in Next up", "later": "waiting in Later", "working": "being worked on", "waiting": "waiting for the person"}.get(st, "on the board")
    return {"id": best["id"], "title": best.get("title") or "", "state": st, "state_words": words}


def add(title, project="", desc="", thing="", force=False):
    """Put work the person said yes to on the board as a to-do (nobody claims it): {added, id, title, project,
    thing} or, when the same work is already open there, {added: False, existing: {...}} and nothing new."""
    title = " ".join(str(title or "").split())
    if not title:
        raise ValueError("What should the task say?")
    if not force:
        noted = _noted_from_chat(title, project)
        if noted:
            return {"added": False, "existing": noted, "noted": True, "title": title, "project": project,
                    "note": f"Dispatch already noted this from the person's message: {noted['title']} ({noted['id']}), {noted['state_words']}. "
                            "Nothing new added; say in one line that it is on the board."}
        sim = similar(title, project)
        if sim["duplicate"]:
            return {"added": False, "existing": sim["matches"][0], "title": title, "project": project,
                    "note": f"Already on the board: {sim['matches'][0]['title']} ({sim['matches'][0]['id']}). Add to that one instead."}
    labels = [f"host:{D.local_host_name()}"] + ([f"project:{project}"] if project else [])
    sid = D.session_from_env()
    if sid and re.fullmatch(r"[A-Za-z0-9_-]{8,120}", sid):
        labels.append("session-origin:" + sid)
    argv = ["create", title, "-t", "task", "-p", "2", "--json", "-l", ",".join(labels)]
    if desc:
        argv += ["--description", desc]
    issue = D.bd_json(argv)
    tid = issue.get("id")
    if not tid:
        raise ValueError("The board did not take the task.")
    TV = D._mod("tasks_view")
    got = TV.begin_thing(tid, thing or "", "", project or "", D) or {}
    return {"added": True, "id": tid, "title": title, "project": project, "thing": got.get("thing") or "", "status": "todo"}


# ---- looking at a folder -------------------------------------------------------------------------------

def look(path):
    """What is in a folder, for "have a look at X": whether it is a project already, its git state and notes.
    Reading only: a folder that is looked at is never registered as a project."""
    path = os.path.abspath(os.path.expanduser(path or ""))
    if not os.path.isdir(path):
        return {"folder": path, "exists": False, "summary": "There is no such folder."}
    PV = D._mod("projects_view")
    PV.D = D
    try:
        reg = PV.registry(resolve_dirs=False)
    except Exception as e:
        D.debug("assistant_survey.look", e)
        reg = []
    mine = next((r for r in reg if r["dir"] and os.path.realpath(r["dir"]) == os.path.realpath(path)), None)
    ch = changes(path)
    note = notes(path)
    bits = []
    if ch is not None:
        bits.append(f"a git repository on {ch['branch'] or 'an unnamed branch'}" + (f" with {ch['files']} unsaved file{'s' if ch['files'] != 1 else ''}" if ch["files"] else ", nothing unsaved"))
    else:
        bits.append("a plain folder, not a git repository")
    if note:
        bits.append(f"{note['file']} lists open items")
    readme = ""
    for name in ("README.md", "README", "readme.md", "README.txt"):
        try:
            with open(os.path.join(path, name), encoding="utf-8", errors="replace") as fh:
                readme = _clip(" ".join(l.strip().lstrip("# ") for l in fh.read(4000).splitlines() if l.strip())[:300], 200)
            break
        except OSError:
            continue
    files = sorted(f for f in os.listdir(path) if not NOISE.search(f) and f != ".git")
    return {"folder": path, "exists": True, "is_project": bool(mine), "project": mine["name"] if mine else "", "git": ch is not None,
            "changes": ch, "note": note, "files": files[:20], "more_files": max(0, len(files) - 20), "readme": readme,
            "summary": f"{os.path.basename(path)} is " + ", ".join(bits) + ".",
            "ask": None if mine else f"Add {os.path.basename(path)} as a project?"}
