# -*- coding: utf-8 -*-
"""`dispatch task list | show | graph | plan | deliver | follow`: the task model of
design/task-model/DECISIONS.md on the bd board.

A task is one bd issue. Its project is the `project:` label, its session the `session-origin:`
label (the conversation the request was made in; `session:` labels are sessions that worked on
it). What bd has no column for lives in the issue's metadata, merged key by key:

    plan          [{"text", "state": todo|active|done}]   the few short directions
    deliverables  [{"kind": url|file|draft|commit|build, "ref", "label", "at"}]
                  file: `list` / `show` add "where" when the note has a Where to look picture next to it
                  (00-where.json, docs_view.where_of): {json, image, size, items, drawn, count}; not stored
                  build (`dispatch build`, builds.py): ref is the build name <ide sha12>-<kanban sha12>, plus
                  status, host, ide, kanban, app, log, summary (result.md), seconds, stage, tail, e2e, e2e_note
    follows       "<task id>"   this task carries on that one (same thing, one line in the graph)
    thing         "<name>"   what it is about: one row of the task graph (things.py)
    from          "<task id>"   the task its session was on when it was asked (things.py)
    owns          [{"path", "repo"}]   its territory while it is worked on (ownership.py)

The Agents window (Dispatch IDE: Tasks tab, task graph, task page) and the Projects page read
`list` / `graph` / `show` as JSON through dispatch-bridge; the field names are fixed.
"""
import json, os, re, subprocess, sys, time
from lang import t as _t

import engines as E
import ownership as O
import things as TH

D = None  # the dispatch module, bound by run()

PLAN_MAX, PLAN_TEXT_MAX = 8, 80
KINDS = ("url", "file", "draft", "commit", "build")
BUILD_KEYS = ("status", "host", "commit", "ide", "kanban", "app", "log", "summary", "stage", "tail", "e2e_note")
STATES = ("todo", "active", "done")
STATUS_ORDER = {"waiting": 0, "in_progress": 1, "todo": 2, "done": 3}
TASK_ID = re.compile(r"^[a-z][a-z0-9]*-[a-z0-9]{2,8}$")
WINDOW_DAYS = 30  # list / graph show the tasks touched in the last 30 days; older ones are the Archive


# ---------------------------------------------------------------- reading the board

def _sh(args, timeout=60):
    if D is not None:
        return D.sh(args, timeout=timeout)
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


def board_export():
    """Every issue, sharing the local Dolt fingerprint cache with the other views."""
    from board_export import export_issues
    return export_issues(_sh, beads_dir=getattr(D, "BEADS_DIR", None),
                         dispatch_dir=getattr(D, "DISPATCH_DIR", None), home=getattr(D, "HOME", None))


def session_issues(keys):
    """The tasks filed under any of a session's ids, by label straight from bd: about 0.2 s, where the whole board's
    export takes seconds and, while other agents write, tens of seconds (the This session list timed out, task-nu516).
    `bd list` has no comments or dependencies; those come from the last export on disk (the latest activity line, the
    `follows` of tasks from before it was stored)."""
    labels = ",".join(f"{p}:{k}" for k in keys for p in ("session-origin", "session"))
    code, o, err = _sh(["bd", "list", "--label-any", labels, "--all", "--json", "--limit", "0"])
    if code != 0:
        raise ValueError((err or o).strip() or "bd list failed")
    rows = json.loads(o[o.find("["):]) if "[" in o else []
    from board_export import cached_issues
    old = {t["id"]: t for t in cached_issues(beads_dir=getattr(D, "BEADS_DIR", None),
                                             dispatch_dir=getattr(D, "DISPATCH_DIR", None), home=getattr(D, "HOME", None))}
    return [{**{k: old[t["id"]][k] for k in ("comments", "dependencies") if k in old.get(t["id"], {})}, **t}
            for t in rows if isinstance(t, dict) and t.get("id")]


def window_session(sid):
    """The Agents window's id of the conversation a task names by the agent's own id (Claude's session, Codex's
    thread, OpenCode's ses_…), '' when the window does not run it. The window files that pair before each turn goes
    out (dispatchLife.ts → `dispatch handoff assess --register`, session_life's "managed"). The task page and the
    Tasks tab find the session by it (task-wwi8s: an Assistant's task read "A session not in this window")."""
    sid = session_key(sid)
    if not sid:
        return ""
    import session_life as L
    for eng in E.known():
        m = L.load(L.path_for("managed", f"{eng.agent}:{sid}"))
        if m.get("session"):
            return session_key(str(m["session"]))
    return ""


def with_window(rows):
    """Each row with `session_window`, the window's id of its origin session ('' when the window does not run it)."""
    for r in rows:
        r["session_window"] = window_session(r.get("session") or "")
    return rows


def show_issue(tid):
    code, o, err = _sh(["bd", "show", tid, "--json"])
    if code != 0:
        raise ValueError((err or o).strip() or f"no task {tid}")
    s = o[min([i for i in (o.find("["), o.find("{")) if i >= 0] or [0]):]
    try:
        d = json.loads(s)
    except ValueError:
        raise ValueError(f"no task {tid}")
    d = d[0] if isinstance(d, list) and d else d
    if not isinstance(d, dict) or not d.get("id"):
        raise ValueError(f"no task {tid}")
    return d


def epoch(ts):
    """ISO time from bd → epoch seconds (int), 0 when missing."""
    if not ts:
        return 0
    from datetime import datetime
    try:
        return int(datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp())
    except ValueError:
        return 0


def labels_of(t):
    return t.get("labels") or []


def label_values(t, prefix):
    return [l[len(prefix):] for l in labels_of(t) if l.startswith(prefix)]


def project_of(t):
    return next(iter(label_values(t, "project:")), "")


def origin_session(t):
    """The conversation the task was asked in; else the first that worked on it."""
    return next(iter(label_values(t, "session-origin:")), "") or next(iter(label_values(t, "session:")), "")


def sessions_of(t):
    out = []
    for s in label_values(t, "session-origin:") + label_values(t, "session:"):
        if s and s not in out:
            out.append(s)
    return out


def meta(t):
    m = t.get("metadata")
    if isinstance(m, str):
        try:
            m = json.loads(m)
        except ValueError:
            m = {}
    return m if isinstance(m, dict) else {}


def hidden(t):
    ls = labels_of(t)
    return t.get("status") == "deferred" or "dispatch:trashed" in ls or "dispatch:outcome" in ls


def status_of(t):
    """todo | in_progress | waiting | done (the words: To do, In progress, Waiting for you, Done)."""
    st = t.get("status") or "open"
    ls = labels_of(t)
    if st == "closed":
        return "done"
    if st == "blocked" or "dispatch:waiting" in ls or "dispatch:needs-you" in ls:
        return "waiting"
    if st == "in_progress":
        return "in_progress"
    return "todo"


def clean_plan(items):
    out = []
    for it in items or []:
        if isinstance(it, str):
            it = {"text": it}
        if not isinstance(it, dict):
            continue
        text = " ".join(str(it.get("text") or "").split())[:PLAN_TEXT_MAX]
        if text:
            state = it.get("state") if it.get("state") in STATES else "todo"
            out.append({"text": text, "state": state})
    return out[:PLAN_MAX]


def clean_deliverables(items):
    out = []
    for it in items or []:
        if isinstance(it, dict) and it.get("kind") in KINDS and it.get("ref"):
            d = {"kind": it["kind"], "ref": str(it["ref"]), "label": str(it.get("label") or "")}
            if it.get("repo"):
                d["repo"] = str(it["repo"])
            if it.get("at"):
                d["at"] = int(it["at"])
            if it["kind"] == "build":
                d.update({k: str(it[k]) for k in BUILD_KEYS if it.get(k)})
                if isinstance(it.get("seconds"), (int, float)):
                    d["seconds"] = int(it["seconds"])
                if isinstance(it.get("e2e"), list):
                    d["e2e"] = [e for e in it["e2e"] if isinstance(e, dict)]
            out.append(d)
    return out


def with_where(items):
    """File deliverables with their Where to look (the Tasks tab draws them as the framed picture
    icon with a snippet on hover): read from the note's folder each time, never stored."""
    import docs_view
    out = []
    for d in items:
        if d["kind"] == "file":
            ref = d["ref"]
            note = ref
            if os.path.isdir(ref):
                note = next((os.path.join(ref, n) for n in ("notes.md", "README.md", "index.html") if os.path.isfile(os.path.join(ref, n))), os.path.join(ref, "README.md"))
            w = docs_view.where_of(note) if os.path.isfile(note) else None
            if w and w.get("items"):
                d = dict(d, where=dict(w, count=len(w["items"])))
        out.append(d)
    return out


def task_row(t):
    """One task in the fixed shape `task list --json` returns (Projects page reads it too)."""
    m = meta(t)
    status = status_of(t)
    follows = m.get("follows") if isinstance(m.get("follows"), str) and TASK_ID.match(m.get("follows") or "") else ""
    if not follows:
        # tasks from before `follows`: a follow-up (discovered-from) or subtask (parent-child) carries on its source
        follows = next((d.get("depends_on_id") for d in t.get("dependencies") or []
                        if isinstance(d, dict) and d.get("type") in ("discovered-from", "parent-child") and TASK_ID.match(d.get("depends_on_id") or "")), "")
    thing, frm = TH.stored(m)
    return {
        "id": t["id"],
        "title": t.get("title") or "",
        "status": status,
        "bd_status": t.get("status") or "open",
        "project": project_of(t),
        "session": origin_session(t),
        "sessions": sessions_of(t),
        "agent": t.get("assignee") or t.get("created_by") or "",
        "plan": clean_plan(m.get("plan")),
        "deliverables": with_where(clean_deliverables(m.get("deliverables"))),
        "handoffs": __import__("handoff").task_records(t["id"]),
        "follows": follows,
        "thing": thing,
        "from": frm if frm != t["id"] else "",
        "only_you": "dispatch:needs-you" in labels_of(t),
        "owns": O.owns_json(m),
        "created_at": epoch(t.get("created_at")),
        "updated_at": epoch(t.get("updated_at")),
        "done_at": epoch(t.get("closed_at")) if status == "done" else None,
        "last": last_activity(t),
    }


def last_activity(t):
    """Latest real activity from the export, without a separate query per task."""
    candidates = []
    for c in t.get("comments") or []:
        if isinstance(c, dict) and c.get("text"):
            # Structured worker data is an HTML comment; compact last-activity labels keep its readable part.
            text = str(c["text"]).split("<!-- dispatch-worker-progress:v1\n", 1)[0].rstrip()
            candidates.append({"at": epoch(c.get("created_at")), "text": text})
    for d in clean_deliverables(meta(t).get("deliverables")):
        if d.get("at"):
            candidates.append({"at": d["at"], "text": "Delivered: " + (d.get("label") or d["ref"])})
    if t.get("status") == "closed" and t.get("closed_at"):
        candidates.append({"at": epoch(t["closed_at"]), "text": t.get("close_reason") or "Done"})
    return max((c for c in candidates if c["at"]), key=lambda c: c["at"], default=None)


def sort_rows(rows):
    return sorted(rows, key=lambda r: (STATUS_ORDER[r["status"]],
                                       -(r["done_at"] or 0) if r["status"] == "done" else -max(r["updated_at"], r["created_at"])))


def session_key(s):
    """A session id from whatever the caller has: `abc…`, `claude:/abc…`, `agent-host-codex:/x/abc…`."""
    s = (s or "").strip()
    s = re.sub(r"^[a-z][\w+.-]*:/*", "", s, flags=re.I)
    return s.split("?")[0].split("#")[0].rstrip("/").split("/")[-1]


def session_keys(s):
    """Every id the session's tasks can be filed under: its own, and for an Agents-window OpenCode
    session (`agent-host-opencode:/<id>`, `opencode:/<id>`) OpenCode's own `ses_…` as well, which is
    what `dispatch begin / claim` see in OpenCode's shell (DISPATCH_SESSION_ID)."""
    sid = session_key(s)
    keys = [sid] if sid else []
    scheme = re.match(r"^(?:vscode-)?(?:agent-host-)?([a-z][\w+.-]*):", (s or "").strip(), flags=re.I)
    import engines
    owner = engines.find(scheme.group(1).lower()) if scheme else None
    if sid and owner and owner.supports("owns_session_id") and not owner.owns_session_id(sid):
        # the window's id of a session of an engine whose own ids look different (OpenCode's ses_…): its own id too
        try:
            import ide_sessions
            native = ide_sessions.transcript_key(f"{scheme.group(1).lower()}:{sid}") or ""
        except Exception:  # noqa: BLE001 - the window's catalog is not a contract; the window's id alone still works
            native = ""
        native = native.split(":", 1)[1] if ":" in native else ""
        if native and native not in keys:
            keys.append(native)
    # A /clear handoff changes the engine id while the window keeps its id.
    # Keep tasks from every context segment in that same conversation.
    if sid:
        import session_life as life
        provider = scheme.group(1).lower() if scheme else ""
        import engines
        agents = [engines.agent_of(provider)] if provider else [e.agent for e in engines.runnable()]
        for agent in agents:
            if not engines.get(agent).runnable:
                continue
            runtime = life.load(life.path_for("runtime", f"{agent}:{sid}"))
            aliases = list(runtime.get("native_contexts") or {}) + [runtime.get("native_session") or ""]
            aliases += [c.get("native_session", "") for c in runtime.get("contexts") or []]
            for alias in aliases:
                native = session_key(alias)
                if native and native not in keys:
                    keys.append(native)
    return keys


def in_session(t, sid):
    """Whether the task was filed under the session; `sid` is one id or a list of them (session_keys)."""
    sids = [session_key(x) for x in sid] if isinstance(sid, (list, tuple)) else [session_key(sid)]
    return any(bool(k) and any(s == k or (len(k) >= 8 and s.startswith(k)) for s in sessions_of(t)) for k in sids)


def in_project(t, name):
    return bool(name) and project_of(t).lower() == name.lower()


def resolve_project(project, folder):
    """The project named, else the one the folder belongs to. A folder that belongs to no project (or is
    gone) is no project, not an error: the window asks for the folder a session is in, and a session in
    such a folder simply has no project's tasks around it (the Task graph shows its empty states)."""
    if project:
        return project
    if folder:
        import dispatch_dir
        if dispatch_dir.chats_folder(folder):
            return ""  # a session without a project folder (Chats; OpenCode's run in the home folder): no project
        if D is None:
            return os.path.basename(os.path.normpath(folder))
        try:
            return D.docs_project_of_folder(folder)
        except ValueError:
            return ""
    return ""


def select(issues, project="", session=""):
    rows = [t for t in issues if not hidden(t)]
    if project:
        rows = [t for t in rows if in_project(t, project)]
    if session:
        rows = [t for t in rows if in_session(t, session)]
    return rows


def last_touched(r):
    return max(r["updated_at"], r["created_at"], r["done_at"] or 0)


def in_window(r, days, now=None):
    """A task is recent when it was touched in the last `days` days, or is still being worked on or
    waits for the person, however old. `days` 0 is every task. Plan and deliverables do not matter:
    a task from before they existed is drawn with what it has."""
    if not days or r["status"] in ("in_progress", "waiting"):
        return True
    return last_touched(r) >= (now or time.time()) - days * 86400


def windowed(rows, days, archived=False, now=None):
    """The rows in the window, or with `archived` the ones before it (newest first)."""
    if archived:
        return sorted((r for r in rows if not in_window(r, days or WINDOW_DAYS, now)), key=lambda r: -last_touched(r))
    return [r for r in rows if in_window(r, days, now)]


def list_tasks(issues, project="", session="", status="all", limit=200, days=0, archived=False):
    rows = windowed([task_row(t) for t in select(issues, project, session)], days, archived)
    if status == "open":
        rows = [r for r in rows if r["status"] != "done"]
    elif status == "done":
        rows = [r for r in rows if r["status"] == "done"]
    return (rows if archived else sort_rows(rows))[:max(1, limit)]


# ---------------------------------------------------------------- the task graph

def asked_in(r, sid):
    """Whether the task was asked in this session (its origin; the session graph is what the session asked for)."""
    s = r.get("session") or ""
    sids = sid if isinstance(sid, (list, tuple)) else [sid]  # one id, or every id the session goes by
    return bool(s) and any(k and (s == k or (len(k) >= 8 and s.startswith(k))) for k in sids)


def session_titles():
    """{session id: title} from the session index, when this runs inside dispatch."""
    if D is None:
        return {}
    try:
        return {e.get("session_id"): e.get("title") for e in D.load_index().values() if e.get("session_id") and e.get("title")}
    except Exception:
        return {}


def build_graph(rows, shown=None, now=None, session="", titles=None):
    """A project's task graph: one row per thing (things.py). `rows` are all the project's tasks (a
    thing's first task and a task's `from` can be older than the window), `shown` the ones drawn (the
    window; default all). With `session`, the whole project is still there: each node says whether
    that session asked it (`mine`) and each thing how many of them it has, so the session view keeps
    the project's rows and time axis and dims the rest."""
    now = int(now or time.time())
    shown = rows if shown is None else shown
    sid = [session_key(x) for x in session] if isinstance(session, (list, tuple)) else session_key(session)
    thing_of, from_of, source_of = TH.resolve(rows)
    ids = {r["id"] for r in shown}
    all_links = TH.links(rows, thing_of, from_of, source_of)
    mine = {r["id"] for r in shown if asked_in(r, sid)} if sid else None
    things = TH.summarize(shown, thing_of, all_links, now, mine)
    titles = session_titles() if titles is None else titles
    by_id = {r["id"]: r for r in rows}
    nodes = []
    for r in TH.by_created(shown):
        name = thing_of[r["id"]]
        frm = from_of.get(r["id"]) or ""
        n = {"id": r["id"], "title": r["title"], "status": r["status"], "thing": {"id": TH.thing_id(name), "name": name},
             "from": {"id": frm, "source": source_of[r["id"]], "thing": thing_of.get(frm, ""),
                      "title": by_id.get(frm, {}).get("title", "")} if frm else None, "at": r["created_at"], "done_at": r["done_at"],
             "session": r["session"], "session_title": titles.get(r["session"], "") if r["session"] else "", "agent": r["agent"],
             "deliverables": r["deliverables"], "plan_done": sum(1 for p in r["plan"] if p["state"] == "done"),
             "plan": r["plan"], "last": r.get("last"),
             "plan_total": len(r["plan"]), "plan_now": TH.plan_now(r["plan"])}
        if mine is not None:
            n["mine"] = r["id"] in mine
        nodes.append(n)
    return {"now": now, "things": things, "nodes": nodes,
            "links": [l for l in all_links if l["from"] in ids and l["to"] in ids],
            "counts": {"tasks": len(nodes), "things": len(things), "waiting": sum(1 for n in nodes if n["status"] == "waiting"),
                       **({"mine": len(mine)} if mine is not None else {})}}


def graph_text(g):
    if not g["things"]:
        return "No tasks"
    out = []
    for th in g["things"]:
        now_t = th["now_task"]
        out.append(f"{th['name']:<16} {th['n']:>4}  {LABEL[th['state']]:<16} {now_t['title']}" + ("  (quiet)" if th["quiet"] else ""))
    return "\n".join(out)


def things_text(r):
    if r.get("migrate"):
        head = (f"{r['project']}: {r['changed']} of {r['tasks']} tasks get a thing ({r['kept']} already have one)"
                + (", dry run: nothing written" if r["dry_run"] else f", written {r.get('written', 0)}"))
        lines = [head] + [f"  {t['name']:<16} {t['n']:>4}  e.g. {(t['titles'][-1] if t['titles'] else '')[:40]}" for t in r["things"]]
        if r.get("skipped"):
            lines.append(f"  skipped (changed meanwhile, run again): {', '.join(r['skipped'])}")
        return "\n".join(lines)
    return graph_text(r)


# ---------------------------------------------------------------- writing

def set_meta(tid, **changes):
    """Merge keys into the issue's metadata (bd's --metadata replaces the whole object)."""
    issue = show_issue(tid)
    m = meta(issue)
    m.update(changes)
    code, o, err = _sh(["bd", "update", tid, "--metadata", json.dumps(m, ensure_ascii=False), "--json"])
    if code != 0:
        raise ValueError((err or o).strip() or "bd update failed")
    return dict(issue, metadata=m)


def finished_plan(t):
    """`dispatch done`: a finished task finished its plan, so the steps still open get ticked (user
    2026-10-01: an open circle on a merged task read as "not done"). The task's whole metadata with the
    plan ticked and how many steps that ticked, or (None, 0) when there is nothing to tick."""
    m = meta(t)
    plan = clean_plan(m.get("plan"))
    left = sum(1 for p in plan if p["state"] != "done")
    if not left:
        return None, 0
    return dict(m, plan=[dict(p, state="done") for p in plan]), left


def plan_from_json(obj):
    """Claude's TodoWrite todos, Codex's update_plan, OpenCode's todowrite, or our own {text, state}
    list → plan items. A step OpenCode marked cancelled is no longer part of the plan."""
    if isinstance(obj, dict):
        obj = obj.get("plan") or obj.get("todos") or obj.get("items") or []
    state = {"completed": "done", "done": "done", "in_progress": "active", "inprogress": "active", "active": "active"}
    out = []
    for it in obj if isinstance(obj, list) else []:
        if isinstance(it, str):
            out.append({"text": it, "state": "todo"})
        elif isinstance(it, dict):
            status = str(it.get("state") or it.get("status") or "").lower()
            if status == "cancelled":
                continue
            text = it.get("text") or it.get("content") or it.get("step") or it.get("title") or ""
            out.append({"text": text, "state": state.get(status, "todo")})
    return clean_plan(out)


def numbers(spec):
    return [int(x) for x in re.findall(r"\d+", spec or "")]


def git_head(cwd, ref="HEAD"):
    try:
        r = subprocess.run(["git", "-C", cwd, "log", "-1", "--format=%h%x1f%s", ref], capture_output=True, text=True, timeout=10)
        root = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0 or "\x1f" not in r.stdout:
        return None
    short, subject = r.stdout.strip().split("\x1f", 1)
    return {"short": short, "subject": subject, "repo": root.stdout.strip() if root.returncode == 0 else ""}


def do_plan(a):
    issue = show_issue(a.task)
    plan = clean_plan(meta(issue).get("plan"))
    if a.from_json:
        raw = sys.stdin.read() if a.from_json == "-" else open(os.path.expanduser(a.from_json), encoding="utf-8").read()
        plan = plan_from_json(json.loads(raw or "[]"))
    elif a.set:
        plan = clean_plan(a.set)
    for n in numbers(a.done):
        if 1 <= n <= len(plan):
            plan[n - 1]["state"] = "done"
    for n in numbers(a.active):
        if 1 <= n <= len(plan):
            for p in plan:
                if p["state"] == "active":
                    p["state"] = "todo"
            plan[n - 1]["state"] = "active"
    changes = {"plan": plan}
    if a.follows:
        changes["follows"] = check_follows(a.task, a.follows)
    return task_row(set_meta(a.task, **changes))


HOOK_TOOLS = ("TodoWrite", "update_plan", "todowrite")


def hook_plan(data):
    """(session id, plan list) from a PostToolUse hook's JSON, or ("", None) when it is not a plan.
    Claude Code: tool_name TodoWrite, session_id, tool_input.todos [{content, status}].
    Codex: tool_name update_plan, thread_id (or session_id), tool_input.plan [{step, status}];
    Codex may hand the arguments over as a JSON string.
    OpenCode (Dispatch's plugin, agent/opencode/dispatch.js): tool_name todowrite, session_id `ses_…`,
    tool_input.todos [{content, status, priority}]."""
    tool = data.get("tool_name") or data.get("tool") or "TodoWrite"
    if tool not in HOOK_TOOLS:
        return "", None
    ti = data.get("tool_input")
    if ti is None:
        ti = data.get("arguments") or data.get("input") or {}
    if isinstance(ti, str):
        try:
            ti = json.loads(ti)
        except ValueError:
            ti = {}
    ti = ti if isinstance(ti, dict) else {}
    items = ti.get("plan") if tool == "update_plan" else ti.get("todos")
    sid = (data.get("session_id") or data.get("thread_id") or data.get("thread-id") or data.get("conversation_id")
           or E.session_from_env()[1])
    return session_key(str(sid)), items if isinstance(items, list) else None


def do_plan_hook(a):
    """The PostToolUse hook for Claude Code's TodoWrite and Codex's update_plan (`dispatch task plan
    --hook`): the hook JSON on stdin names the session and carries the list; it becomes the plan of
    the session's current task (the open task most recently touched from that session). Nothing to
    do is fine: a hook must never fail the tool call, so every problem is swallowed and the exit
    code stays 0."""
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
        sid, items = hook_plan(data if isinstance(data, dict) else {})
        if not sid or not items:
            return 0
        own = [t for t in select(board_export(), "", sid) if task_row(t)["status"] != "done"]
        if not own:
            return 0
        own.sort(key=lambda t: -max(epoch(t.get("updated_at")), epoch(t.get("created_at"))))
        set_meta(own[0]["id"], plan=plan_from_json(items))
    except Exception as e:  # noqa: BLE001
        print(f"dispatch task plan --hook: {e}", file=sys.stderr)
    return 0


def check_follows(tid, prev):
    prev = prev.strip()
    if not TASK_ID.match(prev) or prev == tid:
        raise ValueError(f"not a task id: {prev}")
    show_issue(prev)
    return prev


def do_deliver(a):
    issue = show_issue(a.task)
    items = clean_deliverables(meta(issue).get("deliverables"))
    now = int(time.time())
    new = []
    if a.url:
        new.append({"kind": "url", "ref": a.url.strip(), "label": a.label or ""})
    if a.file:
        path = os.path.abspath(os.path.expanduser(a.file))
        if not os.path.exists(path):
            raise ValueError(f"no such file: {path}")
        new.append({"kind": "file", "ref": path, "label": a.label or doc_label(path)})
    if a.draft:
        ref = a.draft.strip()
        p = os.path.abspath(os.path.expanduser(ref))
        new.append({"kind": "draft", "ref": p if os.path.exists(p) else ref, "label": a.label or ""})
    if a.commit is not None:
        head = git_head(os.getcwd(), a.commit.strip() or "HEAD")
        if not head:
            raise ValueError("no git commit here: run it in the repository, or pass the hash")
        new.append({"kind": "commit", "ref": head["short"], "label": a.label or head["subject"], "repo": head["repo"]})
    if not new:
        raise ValueError("say what was delivered: --url, --file, --draft or --commit")
    for d in new:
        d["at"] = now
        items = [x for x in items if not (x["kind"] == d["kind"] and x["ref"] == d["ref"])] + [d]
    row = task_row(set_meta(a.task, deliverables=items))
    register_docs(new, a.task, project_of(issue), getattr(a, "session", "") or "")
    if getattr(a, "show", False):
        row["shown"] = show_delivered(new, getattr(a, "session", "") or "", project_of(issue), a.task)
    return row


def doc_label(path):
    """A deliverable's label: a document's own title (its first # heading or <title>), not
    README.md; anything else its file name."""
    name = os.path.basename(path.rstrip("/"))
    if os.path.isdir(path) and os.path.isfile(os.path.join(path, "README.md")):
        path = os.path.join(path, "README.md")
    if os.path.isfile(path) and os.path.splitext(path)[1].lower() in (".md", ".html", ".htm"):
        import docs_view
        return docs_view.display_title(_title_of(path)) or name
    return name


def _title_of(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            head = f.read(8192)
    except OSError:
        return ""
    m = re.search(r"<title[^>]*>(.*?)</title>", head, re.S | re.I) if path.lower().endswith((".html", ".htm")) else None
    if m:
        return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", m.group(1))).strip()
    for line in head.splitlines():
        m = re.match(r"^#\s+(.+?)\s*#*\s*$", line)
        if m:
            return m.group(1).strip()
    return ""


def register_docs(new, task_id, project, session=""):
    """A delivered .md / .html goes into the project's Docs with the task on it (docs_view.py);
    a folder counts as its README.md."""
    if D is None or not project:
        return
    import docs_view
    docs_view.D = D
    for d in new:
        if d["kind"] not in ("file", "draft"):
            continue
        path = d["ref"]
        if os.path.isdir(path):
            path = os.path.join(path, "README.md")
        try:
            docs_view.on_deliver(project, task_id, path, session)
        except Exception as e:  # noqa: BLE001
            print(f"dispatch task deliver: not added to Docs ({e})", file=sys.stderr)


def begin_owns(tid, specs, d_module=None):
    """`dispatch begin … --owns`: the new task's territory, and a warning per overlap with a task
    already at work. Never fails the begin: the task is there either way."""
    global D
    if d_module is not None:
        D = d_module
    try:
        row = O.set_owns(sys.modules[__name__], tid, O.split_specs(specs), ())
    except Exception as e:  # noqa: BLE001
        print(_t(f"⚠ The area was not recorded ({e}): record it again with `dispatch task own {tid} --add \"…\"`", f"⚠ 地盘没记上（{e}）：`dispatch task own {tid} --add \"…\"` 再记一次"), file=sys.stderr)
        return None
    for w in O.conflict_warnings(row):
        print("⚠ " + w, file=sys.stderr)
    return row


def project_things(project, issues=None):
    """{thing id: name} of the things a project's tasks have stored."""
    rows = [task_row(t) for t in select(board_export() if issues is None else issues, project)] if project else []
    return {TH.thing_id(r["thing"]): r["thing"] for r in rows if r["thing"]}


def thing_name(value, project, issues=None):
    """What `--thing` names: a thing id of the project (th-xxxxxx) is that thing's name; anything
    else is the name itself."""
    value = TH.clean_name(value)
    if TH.THING_ID.match(value):
        name = project_things(project, issues).get(value)
        if not name:
            raise ValueError(f"no thing {value} in {project or 'this project'}: give its name, or `dispatch task things -P {project}`")
        return name
    return value


def resolved_thing(row, issues=None):
    """The thing of a task that has none stored: the one resolve() gives it among its project's tasks."""
    project = row.get("project") or ""
    rows = [task_row(t) for t in select(board_export() if issues is None else issues, project)] if project else [row]
    thing_of = TH.resolve(rows if any(r["id"] == row["id"] for r in rows) else rows + [row])[0]
    return thing_of.get(row["id"], "")


def begin_thing(tid, thing="", session="", project="", d_module=None):
    """`dispatch begin`: the new task's thing and from. `from` is the task asked last before it in the
    same session; without --thing the task goes with that task's thing. Never fails the begin.
    An empty `tid`: the task is not made yet; only say what to store (begin puts it into `bd create`,
    one write fewer: task-p03j)."""
    global D
    if d_module is not None:
        D = d_module
    try:
        sid = session_key(session)
        frm, name = "", thing_name(thing, project) if thing else ""
        if sid:
            code, o, _ = _sh(["bd", "list", "--label", "session-origin:" + sid, "--all", "--json", "--limit", "0"])
            try:
                own = json.loads(o[o.find("["):]) if code == 0 and "[" in o else []
            except ValueError:
                own = []
            before = sorted((t for t in own if isinstance(t, dict) and t.get("id") and t["id"] != tid and not hidden(t)),
                            key=lambda t: (epoch(t.get("created_at")), t["id"]))
            if before:
                prev = before[-1]
                frm = prev["id"]
                if not name:
                    name = TH.stored(meta(prev))[0]
                    if not name and project:
                        name = resolved_thing(task_row(prev))
        changes = {k: v for k, v in (("thing", name), ("from", frm)) if v}
        if changes and tid:
            set_meta(tid, **changes)
        return changes
    except Exception as e:  # noqa: BLE001
        print(_t(f"⚠ The piece of work was not recorded ({e}): record it again with `dispatch task thing {tid} \"<what>\"`", f"⚠ 事没记上（{e}）：`dispatch task thing {tid} \"<事>\"` 再记一次"), file=sys.stderr)
        return {}


def bd_import(jsonl):
    """`bd import -` with the rows on stdin; bd's JSON answer (or {})."""
    try:
        r = subprocess.run(["bd", "import", "-", "--json"], input=jsonl, capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise ValueError(f"bd import: {e}")
    if r.returncode != 0:
        raise ValueError((r.stderr or r.stdout).strip() or "bd import failed")
    o = r.stdout
    try:
        return json.loads(o[o.find("{"):]) if "{" in o else {}
    except ValueError:
        return {}


def do_things(a):
    """`dispatch task things -P X` lists a project's things; `things migrate -P X [--rules f.json]
    [--dry-run] [--days N]` gives every task without a thing one (rules first, else the session rule)."""
    project = resolve_project(a.project, a.folder)
    if not project:
        raise ValueError("give --project or --folder")
    issues = board_export()
    rows = [task_row(t) for t in select(issues, project)]
    days = getattr(a, "days", None)
    if a.task in ("", "list"):
        window = WINDOW_DAYS if days is None else max(0, days)
        g = build_graph(rows, windowed(rows, window))
        return emit({"project": project, "days": window, "things": g["things"], "counts": g["counts"]}, a.json, things_text) or 0
    if a.task != "migrate":
        raise ValueError("dispatch task things [list | migrate] -P <project>")
    target = windowed(rows, days) if days else rows
    rules = TH.load_rules(os.path.expanduser(a.rules)) if getattr(a, "rules", "") else None
    names = TH.plan_migration(target, rules)
    r = {"project": project, "migrate": True, "dry_run": bool(getattr(a, "dry_run", False)), "tasks": len(target),
         "changed": len(names), "kept": len(target) - len(names), "things": TH.migration_summary(target, names)}
    if names and not r["dry_run"]:
        ans = bd_import(TH.import_rows([t for t in issues if t.get("id") in names], names, meta))
        skipped = [i for k in ("stale_skipped_ids", "tie_kept_local_ids") for i in ans.get(k) or [] if i in names]
        r["written"] = len(names) - len(skipped)
        r["skipped"] = skipped
    return emit(r, a.json, things_text) or 0


def show_delivered(new, session="", project="", task=""):
    """`task deliver --show`: open what was just delivered in Dispatch Agent's right panel, in the
    Docs tab's reader (register_docs put it into the project's Docs already)."""
    import ide_show
    target = next((d["ref"] for d in new if d["kind"] in ("file", "url")), "") or \
        next((d["ref"] for d in new if d["kind"] == "draft" and os.path.exists(d["ref"])), "")
    if not target:
        return {"ok": False, "shown": False, "reason": "nothing to open (a commit)"}
    return ide_show.show(target, session=session, task=task)


# ---------------------------------------------------------------- the command

def emit(obj, as_json, text):
    if as_json:
        print(json.dumps(obj, ensure_ascii=False, indent=1))
    else:
        print(text(obj))


LABEL = {"todo": "To do", "in_progress": "In progress", "waiting": "Waiting for you", "done": "Done"}


def list_text(r):
    if not r["tasks"]:
        return "No tasks"
    lines = []
    for t in r["tasks"]:
        lines.append(f"{LABEL[t['status']]:<16} {t['title']} ({t['id']})")
        for p in t["plan"]:
            lines.append(f"    {'✓' if p['state'] == 'done' else '›' if p['state'] == 'active' else '·'} {p['text']}")
        for d in t["deliverables"]:
            lines.append(f"    → {d['kind']}: {d['label'] or d['ref']}")
        for h in t.get("handoffs") or []:
            lines.append(f"    → handoff: {h['path']} (after message {h.get('after_message')})")
        if t.get("owns"):
            lines.append("    owns: " + ", ".join(o["label"] for o in t["owns"]))
        for c in t.get("conflicts") or []:
            lines.append(f"    ⚠ overlaps \"{c['title']}\" ({c['task']}): {c['theirs']}")
    return "\n".join(lines)


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


def command(a):
    op = a.op
    if op in ("list", "graph"):
        project = resolve_project(a.project, a.folder)
        session = session_key(a.session)
        # the ids the session's tasks are filed under (an OpenCode window session: also OpenCode's own)
        sessions = session_keys(a.session) or session
        if not project and not session and not a.folder:
            raise ValueError("give --project, --folder or --session")
        if op == "list" and session and not project:
            # one session's tasks: by label, without the whole board (task-nu516); their overlaps with other tasks'
            # territories against the index of live territories (owns.json) instead of every task's row
            issues = session_issues(sessions if isinstance(sessions, list) else [sessions])
            mine = [task_row(t) for t in issues if not hidden(t)]
            ids = {r["id"] for r in mine}
            others = [dict(t, owns=[dict(o, label=O.label(o)) for o in t.get("owns") or []])
                      for t in O.read_index().get("tasks") or [] if t.get("id") not in ids]
            days = WINDOW_DAYS if getattr(a, "days", None) is None else max(0, a.days)
            archived = bool(getattr(a, "archived", False))
            r = {"project": project, "session": session or None, "days": days, "archived": archived,
                 "tasks": with_window(O.annotate(list_tasks(issues, project, sessions, a.status, a.limit, days, archived), mine + others))}
            return emit(r, a.json, list_text) or 0
        issues = board_export()
        # A supplied folder with no project is an empty scope, never the whole board.
        if not project and not session:
            issues = []
        days = WINDOW_DAYS if getattr(a, "days", None) is None else max(0, a.days)
        archived = bool(getattr(a, "archived", False))
        everyone = O.board_rows(sys.modules[__name__], issues)
        O.write_index(everyone)
        if op == "list":
            r = {"project": project, "session": session or None, "days": days, "archived": archived,
                 "tasks": with_window(O.annotate(list_tasks(issues, project, sessions, a.status, a.limit, days, archived), everyone))}
            return emit(r, a.json, list_text) or 0
        if archived:
            raise ValueError("--archived is for list: the graph draws the recent tasks")
        if session and not project:
            own = select(issues, "", sessions)
            project = next((project_of(t) for t in own if project_of(t)), "")
        rows = [task_row(t) for t in select(issues, project)] if project else [task_row(t) for t in select(issues, "", sessions)]
        g = build_graph(rows, windowed(rows, days), session=sessions)
        clash = O.conflicts(everyone)
        for n in g["nodes"]:
            n["conflicts"] = clash.get(n["id"], [])
        with_window(g["nodes"])
        g = {"project": project, "session": session or None, "days": days, **g}
        return emit(g, a.json, graph_text) or 0
    if op == "things":
        return do_things(a)
    if op == "plan" and getattr(a, "hook", False):
        return do_plan_hook(a)
    if op == "conflicts":
        project = resolve_project(a.project, a.folder)
        everyone = O.board_rows(sys.modules[__name__])
        O.write_index(everyone)
        r = {"project": project or None, "conflicts": O.pairs(everyone, project),
             "owns": {x["id"]: [o["label"] for o in x["owns"]] for x in everyone if x["status"] in O.ACTIVE and x["owns"]
                      and (not project or x["project"].lower() == project.lower())}}
        return emit(r, a.json, lambda x: "\n".join(f"{p['titles'][0]} ({p['tasks'][0]}) × {p['titles'][1]} ({p['tasks'][1]}): {', '.join(p['paths'])}" for p in x["conflicts"]) or "No conflicts") or 0
    if not a.task:
        raise ValueError(f"dispatch task {op} <task id>")
    if op == "own":
        add, rm = O.split_specs(getattr(a, "add", "") or ""), O.split_specs(getattr(a, "rm", "") or "")
        if not add and not rm:
            r = task_row(show_issue(a.task))
            O.annotate([r], O.board_rows(sys.modules[__name__]))
        else:
            r = O.set_owns(sys.modules[__name__], a.task, add, rm)
        if not a.json:
            for w in O.conflict_warnings(r):
                print("⚠ " + w, file=sys.stderr)
        return emit(r, a.json, lambda x: f"{x['title']} ({x['id']}) owns: " + (", ".join(o["label"] for o in x["owns"]) or "nothing")) or 0
    if op == "thing":
        name = TH.clean_name(a.prev)
        if not name:
            raise ValueError('dispatch task thing <task> "<name of the thing>"')
        issue = show_issue(a.task)
        r = task_row(set_meta(a.task, thing=thing_name(name, project_of(issue))))
        return emit(r, a.json, lambda x: f"{x['title']} ({x['id']}) → {x['thing']}") or 0
    if op == "show":
        issue = show_issue(a.task)
        r = with_window([task_row(issue)])[0]
        O.annotate([r], O.board_rows(sys.modules[__name__]) if r["owns"] else [r])
        if not r["thing"] and not getattr(a, "brief", False):
            r["thing"] = resolved_thing(r)
        r["description"] = issue.get("description") or ""
        if getattr(a, "brief", False):
            # a title lookup (a task named in a reply or a page): no commit search through the repository's history
            return emit(r, a.json, lambda x: list_text({"tasks": [x]})) or 0
        import workers
        comments = D.bd_comments(a.task) if D is not None else issue.get("comments") or []
        r["progress"] = workers.progress_groups(comments)
        try:
            r["commits"] = [{"short": c["short"], "subject": c["subject"], "date": c["date"]}
                            for c in (D.task_commits(a.task, issue, []) if D is not None else {"commits": []})["commits"]]
        except Exception:
            r["commits"] = []
        return emit(r, a.json, lambda x: list_text({"tasks": [x]}) + ("\n\n" + x["description"] if x["description"] else "")
                    + ("\n\n" + workers.progress_text(x["progress"]) if x["progress"] else "")) or 0
    if op == "plan":
        r = do_plan(a)
        return emit(r, a.json, lambda x: list_text({"tasks": [x]})) or 0
    if op == "deliver":
        r = do_deliver(a)
        return emit(r, a.json, lambda x: list_text({"tasks": [x]}) + (("\n" + x["shown"]["message"]) if x.get("shown") and x["shown"].get("message") else "")) or 0
    if op == "follow":
        if not a.prev:
            raise ValueError("dispatch task follow <task> <the task it carries on>")
        r = task_row(set_meta(a.task, follows=check_follows(a.task, a.prev)))
        return emit(r, a.json, lambda x: f"{x['title']} ({x['id']}) follows {x['follows']}") or 0
    raise ValueError(f"unknown op {op}")
