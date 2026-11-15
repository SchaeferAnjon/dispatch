# -*- coding: utf-8 -*-
"""A task's territory (地盘): the files and folders it owns while it is being worked on.

When several agents work at once, each task says what it will change: `dispatch begin … --owns
"app/cli/x.py,patches/*.patch"`, later `dispatch task own <task> --add … / --rm …`. It lives in
the issue's metadata:

    owns   [{"path": "app/cli/x.py", "repo": "/Users/me/Projects/kanban"}]

`path` is relative to the repository (its main checkout, so a worktree of the same repository
owns the same paths) and may be a glob (`*`, `?`, `**`); a path without a glob owns everything
below it. Outside a git repository `repo` is "" and `path` is absolute.

Two tasks that are In progress or Waiting for you and own overlapping paths are a conflict:
`dispatch task list / show --json` carry `owns` and `conflicts`, `dispatch task conflicts
--project X --json` lists them for the task graph. The live territories are also written to
<DISPATCH_DIR>/owns.json, which edit-guard.py reads before every file edit: a file in another
task's territory is pointed out (bypass mode) or held back once with an explanation (ask modes).

This module stays light: edit-guard imports it on every edit, so the board is only touched by the
functions that are handed a `tasks_view` module.
"""
import json, os, re, time

META_KEY = "owns"
ACTIVE = ("in_progress", "waiting")
INDEX_NAME = "owns.json"
GLOB = re.compile(r"[*?\[]")


def dispatch_dir():
    return os.environ.get("DISPATCH_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".dispatch")


def index_path():
    return os.path.join(dispatch_dir(), INDEX_NAME)


# ---------------------------------------------------------------- paths

def repo_of(path):
    """(main checkout, this checkout) of the git repository `path` is in, or ("", "").
    Pure file reads: no git process (the edit hook runs this on every edit). A worktree's `.git`
    file names `<main>/.git/worktrees/<name>`; its main checkout is what the paths are relative to."""
    d = os.path.abspath(path)
    while True:
        g = os.path.join(d, ".git")
        if os.path.isdir(g):
            return d, d
        if os.path.isfile(g):
            try:
                with open(g, encoding="utf-8") as f:
                    line = f.read().strip()
            except OSError:
                return d, d
            gitdir = line[len("gitdir:"):].strip() if line.startswith("gitdir:") else ""
            if gitdir and not os.path.isabs(gitdir):
                gitdir = os.path.normpath(os.path.join(d, gitdir))
            m = re.match(r"^(.*)/\.git/worktrees/[^/]+/?$", gitdir.replace(os.sep, "/"))
            return (m.group(1) if m else d), d
        parent = os.path.dirname(d)
        if parent == d:
            return "", ""
        d = parent


def literal_prefix(pattern):
    """The part of a pattern before its first glob character, cut back to a whole folder."""
    m = GLOB.search(pattern)
    if not m:
        return pattern
    return pattern[:m.start()].rsplit("/", 1)[0] if "/" in pattern[:m.start()] else ""


def normalize(spec, cwd=None):
    """A path or glob as typed → {"path", "repo"}. Relative ones start from `cwd`."""
    s = (spec or "").strip().strip("'\"")
    if not s:
        return None
    s = os.path.expanduser(s)
    if not os.path.isabs(s):
        s = os.path.join(cwd or os.getcwd(), s)
    s = os.path.normpath(s).replace(os.sep, "/")
    anchor = literal_prefix(s) or "/"
    repo, here = repo_of(anchor)
    if repo:
        here_s = here.replace(os.sep, "/")
        if s == here_s:
            return {"path": ".", "repo": repo}
        if s.startswith(here_s + "/"):
            return {"path": s[len(here_s) + 1:], "repo": repo}
    return {"path": s, "repo": ""}


def split_specs(text):
    out = []
    for part in re.split(r"[,\n]", text or ""):
        if part.strip():
            out.append(part.strip())
    return out


def label(o):
    """How a territory reads: `kanban/app/cli/x.py`, or the absolute path outside a repository."""
    if not o.get("repo"):
        return o["path"]
    name = os.path.basename(o["repo"].rstrip("/"))
    return name if o["path"] == "." else f"{name}/{o['path']}"


def _regex(pattern):
    out, i = [], 0
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith("**", i):
            out.append(".*")
            i += 2
            if i < len(pattern) and pattern[i] == "/":
                out[-1] = "(?:.*/)?"
                i += 1
            continue
        if c == "*":
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(c))
        i += 1
    return re.compile("^" + "".join(out) + "(?:/.*)?$")


def matches(pattern, rel):
    """Does `pattern` (a territory path) cover `rel` (a path in the same repository)?"""
    if pattern in (".", ""):
        return True
    return bool(_regex(pattern).match(rel))


def _sample(pattern):
    """A concrete path a glob stands for, to compare two globs."""
    return pattern.replace("**", "x/x").replace("*", "x").replace("?", "x")


def overlap(a, b):
    """Two territories {"path", "repo"} share a file."""
    if (a.get("repo") or "") != (b.get("repo") or ""):
        return False
    pa, pb = a["path"], b["path"]
    return pa == pb or matches(pa, _sample(pb)) or matches(pb, _sample(pa))


def locate(path, cwd=None):
    """A file about to be edited → {"path", "repo"} in the same terms as a territory."""
    return normalize(path, cwd)


def covers(o, where):
    """Territory `o` covers the located file `where`."""
    if (o.get("repo") or "") != (where.get("repo") or ""):
        return False
    return matches(o["path"], where["path"])


# ---------------------------------------------------------------- tasks

def owns_of(meta):
    out = []
    for o in (meta or {}).get(META_KEY) or []:
        if isinstance(o, dict) and isinstance(o.get("path"), str) and o["path"]:
            out.append({"path": o["path"], "repo": str(o.get("repo") or "")})
    return out


def owns_json(meta):
    return [dict(o, label=label(o)) for o in owns_of(meta)]


def session_ids(row):
    return [s for s in row.get("sessions") or [] if s]


def conflicts(rows):
    """{task id: [{"task", "title", "agent", "mine", "theirs"}]} among `rows` (task rows with
    `owns` as objects) that are In progress or Waiting for you."""
    live = [r for r in rows if r.get("status") in ACTIVE and r.get("owns")]
    out = {}
    for i, a in enumerate(live):
        for b in live[i + 1:]:
            for oa in a["owns"]:
                for ob in b["owns"]:
                    if overlap(oa, ob):
                        out.setdefault(a["id"], []).append({"task": b["id"], "title": b["title"], "agent": b.get("agent") or "", "mine": label(oa), "theirs": label(ob)})
                        out.setdefault(b["id"], []).append({"task": a["id"], "title": a["title"], "agent": a.get("agent") or "", "mine": label(ob), "theirs": label(oa)})
    return out


def annotate(rows, all_rows=None):
    """Give each row its `conflicts` (against every live row of the board, `all_rows`)."""
    c = conflicts(all_rows if all_rows is not None else rows)
    for r in rows:
        r["conflicts"] = c.get(r["id"], [])
    return rows


def pairs(rows, project=""):
    """The conflicts as pairs, for the task graph: [{"tasks": [a, b], "paths": [...]}]; with
    `project`, the pairs that touch one of its tasks."""
    c = conflicts(rows)
    by_id = {r["id"]: r for r in rows}
    seen, out = set(), []
    for tid, hits in c.items():
        for h in hits:
            key = tuple(sorted((tid, h["task"])))
            if project and not any((by_id.get(t) or {}).get("project", "").lower() == project.lower() for t in key):
                continue
            item = next((p for p in out if tuple(p["tasks"]) == key), None)
            if item is None:
                if key in seen:
                    continue
                seen.add(key)
                item = {"tasks": list(key), "titles": [by_id[k]["title"] for k in key], "paths": []}
                out.append(item)
            for p in (h["mine"], h["theirs"]):
                if p not in item["paths"]:
                    item["paths"].append(p)
    return out


# ---------------------------------------------------------------- the index edit-guard reads

def write_index(rows):
    """<DISPATCH_DIR>/owns.json: the live tasks that own something. Written only when it changes."""
    live = [{"id": r["id"], "title": r["title"], "agent": r.get("agent") or "", "status": r["status"],
             "sessions": session_ids(r), "owns": [{"path": o["path"], "repo": o["repo"]} for o in r["owns"]]}
            for r in rows if r.get("status") in ACTIVE and r.get("owns")]
    live.sort(key=lambda t: t["id"])
    path = index_path()
    old = read_index()
    if old.get("tasks") == live:
        return live
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"updated": int(time.time()), "tasks": live}, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    return live


def read_index():
    try:
        with open(index_path(), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def forget(tid):
    """Drop a task from the index (it was closed)."""
    d = read_index()
    tasks = [t for t in d.get("tasks") or [] if t.get("id") != tid]
    if len(tasks) == len(d.get("tasks") or []):
        return
    tmp = f"{index_path()}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"updated": int(time.time()), "tasks": tasks}, f, ensure_ascii=False, indent=1)
    os.replace(tmp, index_path())


def in_session(task, sid):
    sid = (sid or "").strip()
    return bool(sid) and any(s == sid or (len(s) >= 8 and sid.startswith(s)) or (len(sid) >= 8 and s.startswith(sid)) for s in task.get("sessions") or [])


def owners_of(path, sid="", cwd=None, index=None):
    """The live tasks, other than the calling session's own, whose territory covers `path`:
    [(task, territory)]. A session that works on a task owning the same file is on its own ground."""
    tasks = (index if index is not None else read_index()).get("tasks") or []
    where = locate(path, cwd)
    if not where:
        return []
    hits = [(t, o) for t in tasks for o in t.get("owns") or [] if covers(o, where)]
    if any(in_session(t, sid) for t, _ in hits):
        return []
    return hits


# ---------------------------------------------------------------- commands (with tasks_view bound)

def board_rows(T, issues=None):
    """The task rows of the board that own something (hidden ones left out), `owns` as objects: all that the
    conflicts and the index look at. A row for every task cost 0.5 s of a project list at idle and several
    seconds at load 190 (task-p03j); a few dozen tasks own something."""
    issues = T.board_export() if issues is None else issues
    return [T.task_row(t) for t in issues if owns_of(T.meta(t)) and not T.hidden(t)]


def set_owns(T, tid, add=(), rm=(), cwd=None):
    """Add and remove territories of a task; returns its row with `owns` and `conflicts`."""
    issue = T.show_issue(tid)
    cur = owns_of(T.meta(issue))
    for spec in add:
        o = normalize(spec, cwd)
        if o and o not in cur:
            cur.append(o)
    for spec in rm:
        o = normalize(spec, cwd)
        cur = [x for x in cur if x != o and label(x) != spec.strip() and x["path"] != spec.strip()]
    T.set_meta(tid, **{META_KEY: cur})
    rows = board_rows(T)
    write_index(rows)
    row = next((r for r in rows if r["id"] == tid), None) or T.task_row(T.show_issue(tid))
    annotate([row], rows)
    return row


def conflict_warnings(row):
    return [f"「{c['title']}」（{c['task']}，{c['agent'] or '?'}）也登记了 {c['theirs']}，和你的 {c['mine']} 重叠：先和它分工，或改小你的 --owns。"
            for c in row.get("conflicts") or []]
