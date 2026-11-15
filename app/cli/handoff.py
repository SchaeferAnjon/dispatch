# -*- coding: utf-8 -*-
"""Durable context handoffs. The file, task, Docs and transcript boundary share one id.

Files and the SQLite index live in DISPATCH_DIR/handoffs (the same state root as
checkpoints). A record becomes usable only after both task and Docs registration
succeed; a failed registration never authorizes discarding engine context.
"""
import contextlib
import json
import os
import re
import shlex
import sqlite3
import subprocess
import sys
import time
import uuid

import dispatch as D
import session_life as L
from lang import t as _t

FIELDS = ("goal", "completed", "running", "next", "pitfalls", "orchestration", "agents")
HEADINGS = ("目标", "已完成与证据", "在跑的", "下一步", "坑", "调度状态", "和其他 Agent 的往来")
HEADINGS_EN = ("Goal", "Completed, with evidence", "Running", "Next", "Pitfalls", "Orchestration", "Other agents")
AGENTS_HEADINGS = ("## 和其他 Agent 的往来", "## Other agents")


def agent_contacts(task, base=None):
    import workers
    import glob
    contacts = {"workers": [], "waiting_for": [], "discussion_files": []}
    try:
        rows = [r for r in workers.Store(D).load(timeout=3)["workers"].values()
                if not task or task in workers.worker_tasks(r)]
        contacts["workers"] = [{k: r.get(k) for k in ("name", "tasks", "task", "brief", "report", "log")}
                               for r in rows]
        contacts["waiting_for"] = [{"worker": r["name"], "tasks": workers.worker_tasks(r), "reply": r["report"]}
                                   for r in rows if workers.alive(r) is not False]
    except (ValueError, OSError, subprocess.SubprocessError):
        contacts["registry"] = _t("The worker registry cannot be read right now; after taking over run dispatch worker list / show.", "worker 登记暂不可读，接手运行 dispatch worker list / show。")
    tasks = {task} if task else {t for r in contacts["workers"] for t in workers.worker_tasks(r)}
    contacts["discussion_files"] = sorted({path for t in tasks for path in
        glob.glob(os.path.join(base or D.DISPATCH_DIR, "discussions", t + ".*"))})
    if contacts["workers"] or contacts["discussion_files"]:
        contacts["resume"] = _t("After taking over, read the listed discussion, progress and report files again; do not rely on memory.", "接手后重读列出的讨论、进度和报告文件，不靠记忆。")
    return contacts


def contacts_text(contacts):
    """The Other agents section: the record when there is one, else one plain sentence (no form to fill in)."""
    if any(contacts.get(k) for k in ("workers", "waiting_for", "discussion_files", "registry")):
        return contacts
    return _t("None: no workers, discussions or replies awaited for this task.", "无：这个任务没有 worker、讨论，也没有在等的回复。")


EARLIER_HOURS = 48


def earlier_handoffs(session, task, base=None, now=None):
    """This conversation's handoffs of its other tasks in the last two days, newest first and one per task (its
    latest): a conversation that worked on several tasks wrote one handoff each, and the next session should not
    find only the last one; a task handed off many times must not crowd the others out."""
    now = now or time.time()
    try:
        rows = records(session, base) if session else []
    except ValueError:
        return []
    out, tasks = [], set()
    for r in rows:
        mine = r.get("task")
        if (mine and (mine == task or mine in tasks)) or now - (r.get("created_at") or 0) >= EARLIER_HOURS * 3600:
            continue
        if mine:
            tasks.add(mine)  # one per task; handoffs without a task are each their own
        out.append(r)
    return out[:8]


@contextlib.contextmanager
def database(base=None):
    folder = os.path.join(base or D.DISPATCH_DIR, "handoffs")
    os.makedirs(folder, mode=0o700, exist_ok=True)
    path = os.path.join(folder, "index.sqlite")
    con = sqlite3.connect(path, timeout=15)
    os.chmod(path, 0o600)
    con.row_factory = sqlite3.Row
    con.execute("CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, task TEXT, session TEXT, native_session TEXT, created REAL, registered INTEGER, data TEXT)")
    con.execute("CREATE INDEX IF NOT EXISTS handoff_session ON handoffs(session, created)")
    con.execute("CREATE INDEX IF NOT EXISTS handoff_task ON handoffs(task, created)")
    try:
        yield con
        con.commit()
    finally:
        con.close()


def records(target="", base=None, registered=True):
    path = os.path.join(base or D.DISPATCH_DIR, "handoffs", "index.sqlite")
    if not os.path.isfile(path):
        return []
    with database(base) as db:
        where, args = ("registered=1" if registered else "1=1"), []
        if target:
            normalized = L.key(target)
            where += " AND (task=? OR session=? OR native_session=? OR id=?)"
            args = [target, normalized, normalized, target]
        rows = db.execute("SELECT data FROM handoffs WHERE " + where + " ORDER BY created DESC, id DESC", args).fetchall()
        if not rows and re.fullmatch(r"[A-Za-z0-9_-]{8,120}", target) and not target.startswith("task-"):
            rows = db.execute("SELECT data FROM handoffs WHERE registered=1 AND (session LIKE ? OR native_session LIKE ?) ORDER BY created DESC, id DESC",
                              ("%:" + target + "%", "%:" + target + "%")).fetchall()
            if len({json.loads(r[0])["session"] for r in rows}) > 1:
                raise ValueError(_t("That session prefix is not unique; give the whole session key.", "会话前缀不唯一，请给完整会话 key。"))
    return [json.loads(r[0]) for r in rows]


_task_index = {}


def task_records(tid, base=None):
    """records(tid) for a task id, from one read of the index while its files do not change: a task list asked
    for every task's handoffs one by one, opening the database each time (1861 times, 0.4 s at idle, task-p03j)."""
    path = os.path.join(base or D.DISPATCH_DIR, "handoffs", "index.sqlite")
    stamp = []
    for f in (path, path + "-wal", path + "-journal"):
        try:
            st = os.stat(f)
            stamp.append((st.st_mtime_ns, st.st_size))
        except OSError:
            stamp.append(None)
    if stamp[0] is None:
        return []
    hit = _task_index.get(path)
    if hit is None or hit[0] != stamp:
        with database(base) as db:
            rows = db.execute("SELECT id, task, session, native_session, data FROM handoffs WHERE registered=1 ORDER BY created DESC, id DESC").fetchall()
        hit = _task_index[path] = (stamp, [tuple(r) for r in rows])
    key = L.key(tid)
    got = [json.loads(data) for rid, task, session, native, data in hit[1] if tid in (task, rid) or key in (session, native)]
    if not got and re.fullmatch(r"[A-Za-z0-9_-]{8,120}", tid) and not tid.startswith("task-"):
        return records(tid, base)  # a session prefix, as records() reads it
    return got


def latest(target, base=None):
    return next(iter(records(target, base)), None)


def current_session(agent=""):
    import engines
    eng, own = engines.session_from_env()
    raw = os.environ.get("DISPATCH_SESSION_ID") or own
    if not agent:
        agent = eng.agent if eng else os.environ.get("BEADS_ACTOR", "claude-code")
    return L.key(raw, agent)


def tasks_for(session, issues=None, *, claimed=False):
    import tasks_view as T
    if issues is None:
        code, out, err = D.sh(["bd", "list", "--all", "--json"])
        if code:
            return []
        try:
            issues = json.loads(out[out.find("["):])
        except ValueError:
            return []
    sid = L.key(session).split(":", 1)[-1]
    matches = [t for t in issues if any(L.key(s).split(":", 1)[-1] == sid for s in T.sessions_of(t))]
    if claimed:
        keys = set(T.session_keys(session) or [sid])
        matches = [t for t in issues if T.status_of(t) == "in_progress" and not T.hidden(t)
                   and L.key(T.meta(t).get("claim_session")).split(":", 1)[-1] in keys]
    return sorted(matches, key=lambda t: (T.status_of(t) == "in_progress", str(t.get("updated_at") or "")), reverse=True)


def handoff_task(*sessions, issues=None):
    """The task a session's handoff hangs on: the task it claimed; else the in-progress task this
    session logged on (`dispatch log` / `claim` / `begin` tie the session to it), newest first.
    "" when there is neither: the handoff stays with the session and says so."""
    import tasks_view as T
    sessions = [s for s in sessions if s]
    if issues is None and sessions:
        code, out, err = D.sh(["bd", "list", "--all", "--json"])
        try:
            issues = json.loads(out[out.find("["):]) if not code else []
        except ValueError:
            issues = []
    for s in sessions:
        claimed = tasks_for(s, issues, claimed=True)
        if claimed:
            return claimed[0]["id"]
    for s in sessions:
        linked = [t for t in tasks_for(s, issues) if T.status_of(t) == "in_progress" and not T.hidden(t)]
        if linked:
            return linked[0]["id"]
    return ""


UNATTACHED_FILE_EN = ("## Not attached to a task\n\nWhen this handoff was written the session had claimed no task and logged no task in progress, so it stays with the session only "
                      "and goes into no task and no Docs. Before going on, `dispatch claim <task>`, or make one with `dispatch begin` when none fits; "
                      "later handoffs then go to that task.")
UNATTACHED_FILE = ("## 没有挂到任务\n\n写这份交接时，本会话没有认领任务，也没有 log 过进行中的任务，所以它只挂在会话上，"
                   "不进任务和 Docs。接着做之前先 `dispatch claim <任务>`，没有合适的任务就 `dispatch begin` 建一条；"
                   "之后的交接会挂到那条任务上。")


def session_for_task(issue):
    import tasks_view as T
    return current_session() or L.key(T.origin_session(issue))


def plan_step(plan):
    """The plan step the handoff was written in, for the task card's marker: {"index" (its position in
    the task's plan, from 0), "text", "state"}. The active step; with none active, the last one done;
    None without a plan."""
    active = [i for i, p in enumerate(plan) if p["state"] == "active"]
    done = [i for i, p in enumerate(plan) if p["state"] == "done"]
    i = active[0] if active else done[-1] if done else None
    return None if i is None else {"index": i, "text": plan[i]["text"], "state": plan[i]["state"]}


def _item(x):
    """One line of a list: a finished piece with its evidence reads as words, not as a Python dict."""
    if isinstance(x, dict):
        head = x.get("item") or x.get("what") or x.get("text")
        rest = {k: v for k, v in x.items() if k not in ("item", "what", "text")}
        if head and set(rest) <= {"evidence"}:
            return str(head) + ((_t(" — evidence: ", " —— 证据：") + str(rest["evidence"])) if rest.get("evidence") else "")
        return json.dumps(x, ensure_ascii=False)
    return str(x)


def _value(value):
    if isinstance(value, list):
        return "\n".join("- " + _item(x) for x in value) or _t("Not recorded.", "未记录。")
    if isinstance(value, dict):
        return "```json\n" + json.dumps(value, ensure_ascii=False, indent=2) + "\n```"
    return str(value).strip() if value else _t("Not recorded.", "未记录。")


def write(task, session="", content=None, base=None, boundary=None, request="", strict=False, cwd=""):
    import tasks_view as T
    import docs_view
    docs_view.D = D
    from instructions import atomic_write
    issue = T.show_issue(task) if task else {}
    session = L.key(session or session_for_task(issue))
    if not session:
        raise ValueError(_t("Cannot tell which session; give --session <session>.", "无法确定会话，请给 --session <会话>。"))
    if request:
        old = next(iter(records(request, base, registered=False)), None)
        if old and (old["session"] != session or old["task"] != task):
            raise ValueError(_t("That handoff request belongs to another session or task.", "交接 request 已属于另一条会话或任务。"))
        if old and old.get("registered"):
            return old
    else:
        old = None
    if boundary is None:
        try:
            receipt = L.load(L.path_for("hooks", session, base))
            boundary = L.measure(session, base=base, transcript=receipt.get("transcript", ""),
                                 subagent="/subagent/" in session)
        except (Exception, SystemExit):
            boundary = {}
    meta = T.meta(issue)
    supplied = content or {}
    import handoff_facts as F
    if strict:
        bad = F.problems(supplied)
        if bad:
            raise ValueError(F.rejection(bad))
    plan = T.clean_plan(meta.get("plan"))
    if isinstance(supplied, dict):
        facts = {"goal": issue.get("description") or issue.get("title"),
                 "completed": [p["text"] for p in plan if p["state"] == "done"],
                 "running": [p["text"] for p in plan if p["state"] == "active"],
                 "next": [p["text"] for p in plan if p["state"] == "todo"],
                 "pitfalls": _t("Not recorded.", "未记录。"), "orchestration": {"status": T.status_of(issue), "assignee": issue.get("assignee"),
                     "sessions": T.sessions_of(issue), "metadata": meta},
                 "agents": contacts_text(agent_contacts(task, base)), **supplied}
        body = "\n\n".join(f"## {heading}\n\n{_value(facts.get(field))}" for field, heading in zip(FIELDS, _t(HEADINGS_EN, HEADINGS)))
    elif isinstance(supplied, str) and supplied.strip():
        body = F.strip_auto(supplied)
        if not any(h in body for h in AGENTS_HEADINGS):
            body += "\n\n" + _t(AGENTS_HEADINGS[1], AGENTS_HEADINGS[0]) + "\n\n" + _value(contacts_text(agent_contacts(task, base)))
    else:
        raise ValueError(_t("A handoff is Markdown, or JSON with goal/completed/running/next/pitfalls/orchestration.", "交接内容应为 Markdown 或包含 goal/completed/running/next/pitfalls/orchestration 的 JSON。"))
    since = 0
    if task:
        with contextlib.suppress(Exception):
            since = (next(iter(records(task, base)), None) or {}).get("created_at") or 0
    if not task and "/subagent/" not in session:
        body = _t(UNATTACHED_FILE_EN, UNATTACHED_FILE) + "\n\n" + body
    earlier = earlier_handoffs(session, task, base)
    if earlier:
        body += "\n\n## " + _t("This conversation's other handoffs", "这个会话的其他交接") + "\n\n" + _t(
            "The same conversation handed over these tasks too; read the ones still open.", "同一个会话还交接过这些任务，没做完的也要读。") + "\n\n" + "\n".join(
            "- %s %s: %s" % (r.get("task") or "-", (r.get("title") or "").replace("Context handoff: ", "", 1), r.get("path")) for r in earlier)
    body += "\n\n" + F.collect(task, issue, plan, base, cwd or os.getcwd(), F.test_log_of(supplied), since,
                              comments=(lambda: D.bd_comments(task)) if task else None)
    ident = request or str(uuid.uuid4())
    if not all(c.isalnum() or c in "-_" for c in ident) or len(ident) > 100:
        raise ValueError("Invalid handoff request id")
    created = old["created_at"] if old else time.time()
    folder = os.path.join(base or D.DISPATCH_DIR, "handoffs", task or "sessions")
    # bd validates the task before a path is derived from it.
    if task and not T.TASK_ID.fullmatch(task):
        raise ValueError("Invalid task id")
    os.makedirs(folder, mode=0o700, exist_ok=True)
    path = os.path.join(folder, ident + ".md")
    rec = dict(id=ident, task=task, session=session, native_session=boundary.get("native_session", session),
               created_at=created, path=path, title="Context handoff: " + issue.get("title", session),
               after_message=boundary.get("messages"), after_turn=boundary.get("rounds"),
               context_tokens=boundary.get("context_tokens"), registered=False,
               cwd=os.path.realpath(cwd or os.getcwd()), plan_step=plan_step(plan))
    after = f"After message: {rec['after_message']}\n" if rec.get("after_message") is not None else ""  # a terminal handoff has no message count
    document = f"# {rec['title']}\n\nTask: {task}\nSession: {session}\n{after}\n{body}\n"
    atomic_write(path, document)
    os.chmod(path, 0o600)
    with database(base) as db:
        db.execute("INSERT OR REPLACE INTO handoffs VALUES (?,?,?,?,?,?,?)",
                   (ident, task, session, rec["native_session"], created, 0, json.dumps(rec, ensure_ascii=False)))
    project = T.project_of(issue) or (D.project_of_cwd(os.getcwd(), D.project_names([issue])) if task else "")
    if task and not project:
        raise ValueError(_t(f"The handoff is saved in {path}; the task has no project, so it is not in Docs yet and the context is not cleared.", f"交接已保存到 {path}；任务没有项目，尚未登记 Docs，不清空上下文。"))
    doc = docs_view.register(project, path, title=rec["title"], kind="handoff", tasks=[task], session=session) if project else {}
    # Comments are append-only, unlike a read/modify/write of the task's plan metadata.
    marker = f"[handoff:{ident}]"
    comments = D.bd_comments(task) if task else []
    if task and not any(marker in str(c.get("text") or c.get("body") or "") for c in comments):
        code, out, err = D.sh(["bd", "comments", "add", task,
                              f"{marker} Context handed off after message {rec['after_message']}.\n{path}"])
        if code:
            raise ValueError(_t(f"The handoff is saved, but attaching it to the task failed: {err or out}", f"交接已保存，挂到任务失败：{err or out}"))
    rec.update(registered=True, doc_id=doc.get("id", ""), project=project)
    with database(base) as db:
        db.execute("UPDATE handoffs SET registered=1, data=? WHERE id=?", (json.dumps(rec, ensure_ascii=False), ident))
    stamp = L.path_for("hooks", session, base)
    receipt = L.load(stamp)
    generation = str(boundary.get("epoch", receipt.get("epoch", 0)))
    receipt.update(epoch=generation, written_at=created, written_epoch=generation)
    L.save(stamp, receipt)
    leave_ticket(rec, base)
    set_phase(session, "saved", base, handoff=ident)
    return rec


def leave_ticket(rec, base=None):
    """A terminal handoff (written at the reminder line or at the limit) is for the context after a
    /clear as well: Claude Code and Codex give that context a new id, so the ticket is keyed by the
    engine process and folder (terminal_ticket), the way the Stop hook leaves one."""
    session = rec["session"]
    import engines
    if not engines.get(session.split(":", 1)[0]).life_hooks or "/subagent/" in session or managed(session):
        return
    with contextlib.suppress(Exception):
        L.save(terminal_ticket({"cwd": rec.get("cwd")}, base), {"session": session, "at": rec["created_at"], "handoff": rec["id"]})


# Where a session's handoff is, for `dispatch session life` (handoff_state is what the Agents window's
# status line reads: saving | complete | failed; handoff_phase is the finer step).
PHASE_STATE = {"writing": "saving", "preparing": "complete", "saved": "complete", "clearing": "complete",
               "resuming": "complete", "resumed": "complete", "failed": "failed"}
STATE_SECONDS = {"saving": 1800, "complete": 600, "failed": 1800}


def set_phase(session, phase, base=None, **extra):
    session = L.key(session)
    if not session:
        return
    with contextlib.suppress(OSError):
        L.save(L.path_for("handoff-state", session, base), {"phase": phase, "at": time.time(), **extra})


def phase_of(session, base=None):
    return L.load(L.path_for("handoff-state", L.key(session), base))


def life_fields(*sessions, base=None, now=None, limit=20):
    """handoff_state, handoff_phase, handoff_error and handoffs (newest last) for session life.
    A state older than STATE_SECONDS is over: an empty state, not a stale banner."""
    now = now or time.time()
    state = phase = error = ""
    for session in sessions:
        st = phase_of(session, base) if session else {}
        mapped = PHASE_STATE.get(st.get("phase", ""), "")
        if mapped and now - (st.get("at") or 0) <= STATE_SECONDS[mapped]:
            state, phase, error = mapped, st["phase"], st.get("error", "") if mapped == "failed" else ""
            break
    rows, seen = [], set()
    for session in sessions:
        try:
            found = records(session, base) if session else []
        except ValueError:
            found = []
        for r in found:
            if r["id"] not in seen:
                seen.add(r["id"])
                rows.append({k: r.get(k) for k in ("id", "path", "task", "title", "session", "created_at",
                                                    "after_message", "after_turn", "registered", "plan_step")})
    rows.sort(key=lambda r: r.get("created_at") or 0)
    return {"handoff_state": state, "handoff_phase": phase, "handoff_error": error, "handoffs": rows[-limit:]}


def write_instruction(task, session, request="", terminal=False, reminder=False):
    """What the agent is told to do. `reminder` is the warning line (80 % by default): the limit is
    not reached yet, so it must not say so; the handoff is written early and work goes on."""
    args = ["dispatch", "handoff", "write", *([task] if task else []), "--session", session, "--stdin"]
    if request:
        args += ["--request", request]
    # Dispatch's MCP tool first (dispatch_mcp.py): it runs outside an agent's sandbox, where the command may not
    tool = json.dumps({**({"task": task} if task else {}), "session": session, **({"request": request} if request else {}),
                       "text": "<the JSON object>"}, ensure_ascii=False)
    how = (f"Call Dispatch's handoff_write tool with {tool}. Without Dispatch's tools, run this command with the JSON "
           "object on stdin: ")
    lead = ("[Dispatch context handoff reminder]\nThe context is approaching its lifetime limit; the limit has not "
            "been reached yet. At the next safe step, write a factual handoff now, so nothing is lost when the "
            "context is compacted or cleared. " + how if reminder else
            "[Dispatch context handoff]\nThe context lifetime limit has been reached. Finish the current safe step, "
            "then write a factual handoff. " + how)
    if not task and "/subagent/" not in session:
        lead = lead.replace("\n", "\nThis session has no claimed task, so the handoff would stay with the session only. "
                            "If the work belongs to a task, take it first (task_claim, or `dispatch claim <task>`) and "
                            "give its task id to the handoff.\n", 1)
    return (lead + shlex.join(args) +
            "\nInclude goal, completed, running, next, pitfalls, orchestration "
            "(workers, ownership, queues and pending decisions), and agents (worker names and tasks, "
            "whose reply is pending, discussion record paths to reread). Requirements, checked on write: "
            "next is required and must be concrete (a command or a file); completed items carry evidence "
            "(a commit hash, a file path or a test count), and a completed list where none does is rejected; "
            "add test_log with the path of your latest test output if you ran tests. "
            "Do not write commits, uncommitted files, board progress, workers or notifications: Dispatch collects "
            "them itself in a section you cannot edit (Collected by Dispatch / 自动采集). A handoff that fails the check exits non-zero "
            "(the tool answers with an error), saves nothing and says what is missing plus a minimal valid JSON; fix it and write it again. "
            "Do not mark unfinished work done. " +
            ("After it succeeds, continue your task and worker scheduling in this same turn. "
             "Let the engine compact automatically; do not wait for user input."
             if terminal else "Do not start new work in this turn. After it succeeds, end this turn. "
             "Dispatch will start a fresh context in the same conversation and continue."))


def resume_text(rec, prime="", base=None):
    with open(rec["path"], encoding="utf-8") as f:
        body = f.read()
    full = (prime.strip() + "\n\n" if prime.strip() else "") + body + (
        _t("\n\nGo on, and first read the other agents' discussion, progress and report files again. ", "\n\n接着做，先重读其他 Agent 的讨论、进度和报告文件。交接是历史快照，最新指令和完成证据优先，已完成的步骤不要重做。")
        + "This handoff is a historical snapshot. Follow the latest user request and current "
        "progress; verify existing completion evidence and skip steps already done. Continue only the remaining work.")
    # Keep the combined prime + handoff under both hook limits, without dropping content.
    if len(full.encode("utf-8")) > 8500:
        from instructions import atomic_write
        path = os.path.join(base or D.DISPATCH_DIR, "handoffs", "resume-" + rec["id"] + "-" + uuid.uuid4().hex[:12] + ".md")
        atomic_write(path, full)
        os.chmod(path, 0o600)
        return _t(f"The whole text is in {path}. Read that file in full before you go on; it has the complete brief and the latest handoff.", f"全文在 {path}。先完整读取该文件，再接着做；其中包含完整 prime 和最新交接。") + f"\nContext handed off: {rec['path']}"
    return full


def prime_for(cwd, session, rec, base=None):
    env = dict(os.environ, DISPATCH_SESSION_ID=session)
    if base:
        env["DISPATCH_DIR"] = base
    proc = subprocess.run([sys.executable, D.__file__, "prime", "--cwd", cwd], capture_output=True, text=True, env=env, timeout=45)
    if proc.returncode:
        raise ValueError("prime failed: " + proc.stderr[-500:])
    return resume_text(rec, proc.stdout, base)


def prime_section(session, hook, issues, base=None):
    if hook.get("agent_id"):
        session = L.key(session, "claude-code") + "/subagent/" + str(hook["agent_id"])
    if hook.get("source") not in ("clear", "compact"):
        return []
    rec = latest(L.key(session), base)
    if not rec and not hook.get("agent_id"):
        # /clear may create a new engine session id. Only follow tasks explicitly
        # linked to this session; never borrow a neighbour's same-folder handoff.
        candidates = [latest(t["id"], base) for t in tasks_for(session, issues)]
        rec = max((r for r in candidates if r), key=lambda r: r["created_at"], default=None)
    if not rec and not hook.get("agent_id"):
        path = terminal_ticket(hook, base)
        pending = L.load(path)
        if pending.get("session") and time.time() - pending.get("at", 0) < 86400 and \
                pending.get("taken_by", session) == session:
            rec = latest(pending["session"], base)
            if rec and rec["created_at"] < pending["at"]:
                rec = None
            if rec:
                L.save(path, dict(pending, taken_by=session))
    if not rec and not hook.get("agent_id") and hook.get("source") == "clear":
        rec = same_folder(session, hook, base)
    if not rec:
        return []
    if phase_of(rec["session"], base).get("phase") in ("saved", "preparing", "clearing", "resuming"):
        set_phase(rec["session"], "resumed", base, handoff=rec["id"])
    head = [_t("## Latest handoff", "## 最新交接")]
    if not rec.get("task") and "/subagent/" not in rec.get("session", ""):
        head.append(_t(UNATTACHED_PRIME_EN, UNATTACHED_PRIME))
    return head + [resume_text(rec, base=base)]


UNATTACHED_PRIME_EN = "(This handoff is not attached to a task: the session that wrote it had claimed none. Before going on, `dispatch claim <task>`, or `dispatch begin` one when none fits.)"
UNATTACHED_PRIME = "（这份交接没有挂到任务：写它的会话当时没有认领任务。接着做之前先 `dispatch claim <任务>`，没有合适的就 `dispatch begin` 建一条。）"


def engine_process():
    """(pid, agent) of the engine process this command runs under, one whose hooks follow the context's lifetime
    (Claude Code, Codex: its adapter's life_hooks), or (pid reached, "")."""
    import engines
    pid = os.getppid()
    for _ in range(6):
        try:
            row = subprocess.check_output(["ps", "-p", str(pid), "-o", "ppid=,comm="], text=True, timeout=2).strip().split(None, 1)
            eng = engines.by_process(os.path.basename(row[1]).lower(), row[1]) if len(row) > 1 else None
            if eng and eng.life_hooks:
                return pid, eng.agent
            if not row or int(row[0]) <= 1:
                break
            pid = int(row[0])
        except (OSError, ValueError, subprocess.SubprocessError):
            break
    return pid, ""


def terminal_ticket(data, base=None):
    """A clear creates a new engine id. Match the same engine PID and folder."""
    pid = engine_process()[0]
    return L.path_for("terminal", str(pid) + ":" + os.path.realpath(data.get("cwd") or os.getcwd()), base)


def same_folder(session, hook, base=None, now=None):
    """/clear with no ticket (the engine process could not be found, or the ticket was lost): the
    newest handoff of the same engine in the same folder from the last 24 hours. Skipped: a handoff
    whose session still runs in another live engine process (a neighbour in the same folder), and
    one another cleared context already took."""
    now = now or time.time()
    cwd = os.path.realpath(hook.get("cwd") or os.getcwd())
    pid, name = engine_process()
    actor = os.environ.get("BEADS_ACTOR") or ""
    import engines
    engine = actor if engines.find(actor) and engines.find(actor).life_hooks else name
    raw = L.key(session).split(":", 1)[-1]
    try:
        live = {str(r.get("session_id")): p for p, r in D._presence_by_pid().items() if p != pid and _alive(p)}
    except Exception:
        live = {}
    taken = L.path_for("clear-taken", cwd, base)
    took = L.load(taken)
    for rec in records("", base):
        if now - (rec.get("created_at") or 0) > 86400:
            break
        own = rec["session"]
        if rec.get("cwd") != cwd or "/subagent/" in own or (engine and not own.startswith(engine + ":")):
            continue
        if own.split(":", 1)[-1] in live or took.get(rec["id"], raw) != raw:
            continue
        took[rec["id"]] = raw
        L.save(taken, took)
        return rec
    return None


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


def managed(session):
    marker = L.load(L.path_for("managed", session))
    try:
        pid = int(os.environ.get("DISPATCH_LIFE_MANAGED") or 0)
        if pid <= 1:
            pid = int(marker.get("host_pid") or 0)
        if pid <= 1:
            return False
        os.kill(pid, 0)
        return True
    except (ValueError, TypeError, OSError):
        return False


def foreign(data, agent):
    """Claude Code's hooks run inside an OpenCode session (an OpenCode plugin such as oh-my-openagent replays
    ~/.claude/settings.json): the id is OpenCode's (ses_…). Not a Claude Code session: no lifetime, no worker
    notifications read off for it (chatd or OpenCode's own plugin serves that session)."""
    sid = str(data.get("session_id") or data.get("thread_id") or data.get("conversation_id") or "")
    import engines
    return engines.foreign_session(agent, sid)


def hook(data, agent):
    if foreign(data, agent):
        return {}
    # Parallel tool completions must not each emit the same reminder / Stop block.
    import fcntl
    identity = L.key(data.get("session_id") or data.get("thread_id") or data.get("conversation_id"), agent)
    if not identity:
        return {}
    path = L.path_for("hook-locks", identity + ":" + str(data.get("agent_id") or ""))
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    with open(path, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return wake_merge(_hook(data, agent), data, agent)


def wake_merge(out, data, agent):
    """Put unread worker notifications into a terminal dispatcher's hook output (wake.py).

    Sessions chatd runs get them as a message instead; a subagent never does."""
    if data.get("agent_id"):
        return out
    event = data.get("hook_event_name") or "PostToolUse"
    session = data.get("session_id") or data.get("thread_id") or data.get("conversation_id") or ""
    try:
        import wake
        if managed(L.key(session, agent)):
            return out
        note = wake.hook_note(D, session, event, bool(data.get("stop_hook_active")))
    except Exception:
        return out
    if not note:
        return out
    out = dict(out or {})
    if event in ("Stop", "SubagentStop"):
        reason = out.get("reason")
        out.update(decision="block", reason=(reason + "\n\n" if reason else "") + note["text"])
        return out
    inner = dict(out.get("hookSpecificOutput") or {"hookEventName": event})
    inner["additionalContext"] = (inner["additionalContext"] + "\n\n" if inner.get("additionalContext") else "") + note["text"]
    out["hookSpecificOutput"] = inner
    return out


def _hook(data, agent):
    event = data.get("hook_event_name") or "PostToolUse"
    session = L.key(data.get("session_id") or data.get("thread_id") or data.get("conversation_id"), agent)
    path = data.get("transcript_path") or ""
    # https://code.claude.com/docs/en/hooks#common-input-fields and #subagentstop:
    # agent_id identifies child tool events; transcript_path can still be the parent.
    # Only SubagentStop guarantees agent_transcript_path. Never borrow parent usage.
    import engines
    child = str(data.get("agent_id") or "") if engines.get(agent).hook_children else ""
    if child:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", child):
            return {}
        session += "/subagent/" + child
        own_path = data.get("agent_transcript_path") or ""
        if not own_path:
            candidate = os.path.join(os.path.splitext(path)[0], "subagents", "agent-" + child + ".jsonl")
            # Conventional path is only used if present; absent child data is unknown.
            own_path = candidate if os.path.isfile(candidate) else ""
        if not own_path or not os.path.isfile(own_path):
            return {}
        path = own_path
    if not session or (not child and managed(session)):
        return {}
    try:
        life = L.measure(session, transcript=path, agent=agent, subagent=bool(child))
    except (Exception, SystemExit):
        return {}
    if life["status"] not in ("warning", "limit"):
        return {}
    stamp = L.path_for("hooks", session)
    previous = L.load(stamp)
    generation = str(life.get("epoch", 0))
    if previous.get("epoch") != generation:
        previous = {"epoch": generation}
    previous["transcript"] = path
    if previous.get("written_epoch") == generation:
        return {}
    rec = latest(session)
    if rec and rec.get("context_tokens") == life["context_tokens"] and rec["created_at"] >= life.get("last_at", 0):
        return {}
    message = f"Dispatch context lifetime: {life['percent']}% ({life['context_tokens']}/{life['limit_tokens']} tokens)."
    if life["status"] == "warning":
        if previous.get("warned"):
            return {}
        previous["warned"] = True
        message += "\n" + write_instruction(handoff_task(session), session, terminal=True, reminder=True)
    else:
        if previous.get("requested") or data.get("stop_hook_active"):
            return {}
        task = handoff_task(session)
        if event not in ("Stop", "SubagentStop"):
            if previous.get("limit_warned"):
                return {}
            previous["limit_warned"] = True
        else:
            previous["requested"] = True
            if not child:
                L.save(terminal_ticket(data), {"session": session, "at": time.time()})
        message += "\n" + write_instruction(task, session, terminal=True)
    L.save(stamp, previous)
    set_phase(session, "writing")
    if event in ("Stop", "SubagentStop"):
        return {"decision": "block", "reason": message} if life["status"] == "limit" else {"systemMessage": message}
    return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": message}}


def command(a):
    try:
        return _command(a)
    except (ValueError, OSError) as e:
        print(str(e), file=sys.stderr)
        raise SystemExit(2)


def _command(a):
    if a.op == "assess":
        data = json.load(sys.stdin)
        session, native = L.key(data["session"]), L.key(data["native_session"])
        if data.get("register"):
            L.save(L.path_for("managed", native), {"session": session, "host_pid": os.getppid()})
            print("{}")
            return
        life = L.measure(session, native_session=native, cwd=data.get("cwd") or os.getcwd())
        runtime = L.load(L.path_for("runtime", session))
        contexts = runtime.get("native_contexts", {})
        contexts[native] = life
        snapshot = {**life, **{k: sum(L.number(c.get(k)) for c in contexts.values())
                              for k in ("rounds", "tool_steps", "cumulative_read_tokens")}}
        snapshot["messages"] = data.get("messages", life["messages"])
        starts = [c["started_at"] for c in contexts.values() if c.get("started_at")]
        if starts:
            snapshot["started_at"] = min(starts)
            snapshot["elapsed_seconds"] = max(0, int(time.time() - snapshot["started_at"]))
        L.save(L.path_for("runtime", session), {"snapshot": snapshot, "native_contexts": contexts})
        L.save(L.path_for("managed", native), {"session": session, "host_pid": os.getppid()})
        result = {"life": snapshot}
        phase = phase_of(session)
        recent = time.time() - (phase.get("at") or 0) < STATE_SECONDS["complete"]
        if phase.get("phase") == "writing" and phase.get("request") and not latest(phase["request"]):
            # The turn that was to write the handoff has ended (assess runs at turn ends) and nothing
            # was registered: cancelled, failed, or the agent did not run the command.
            set_phase(session, "failed", request=phase["request"], error="The handoff turn ended without a saved handoff")
            phase = phase_of(session)
        if phase.get("phase") == "saved" and recent:
            # The Agents window measures once more after the handoff turn, before it clears.
            set_phase(session, "preparing", handoff=phase.get("handoff", ""))
        elif phase.get("phase") in ("clearing", "resuming") and recent:
            set_phase(session, "resumed", handoff=phase.get("handoff", ""))
        elif snapshot["status"] == "limit" and snapshot["auto_handoff"]:
            # The board is asked only here: most turns end below the line (audit 15).
            request = uuid.uuid4().hex
            task = handoff_task(session, native)
            result.update(request=request, task=task, instruction=write_instruction(task, session, request))
            set_phase(session, "writing", request=request)
        print(json.dumps(result, ensure_ascii=False))
        return
    if a.op == "fail":
        session = L.key(a.session) if a.session else current_session()
        if not session:
            raise ValueError("Give --session <session>.")
        request = a.request or phase_of(session).get("request", "")
        if request and latest(request):
            print(json.dumps({"ok": False, "message": "That handoff was saved; nothing failed."}))
            return
        set_phase(session, "failed", request=request, error=(a.reason or "The handoff turn was cancelled or failed")[:300])
        print(json.dumps({"ok": True, "session": session, "handoff_state": "failed"}))
        return
    if a.op == "resume":
        rec = latest(a.target)
        if not rec:
            pending = next(iter(records(a.target, registered=False)), None)
            if pending:
                set_phase(pending["session"], "failed", error="The handoff was not registered")
            raise ValueError("The requested handoff was not registered; context retained.")
        try:
            prompt = prime_for(a.cwd or os.getcwd(), rec["session"], rec)
        except (ValueError, OSError, subprocess.SubprocessError) as e:
            set_phase(rec["session"], "failed", error=str(e)[:300])
            raise
        set_phase(rec["session"], "clearing", handoff=rec["id"])
        print(json.dumps({"handoff": rec, "prompt": prompt}, ensure_ascii=False))
        return
    if a.op == "hook":
        data = json.load(sys.stdin)
        import engines
        if engines.get(a.agent).hooks_plugin and isinstance(data, dict):
            # an older OpenCode plugin only calls this at the end of a turn: the attribution mark too
            import attribution
            attribution.hook_mark(data, a.agent, source="plugin")
        print(json.dumps(hook(data, a.agent), ensure_ascii=False))
        return
    if a.op == "show":
        rec = latest(a.target)
        if not rec:
            raise ValueError(_t("There is no handoff for this task or session yet.", "还没有这个任务或会话的交接。"))
        if a.json:
            print(json.dumps(rec, ensure_ascii=False))
        else:
            print(rec["path"])
            print(open(rec["path"], encoding="utf-8").read())
        return
    raw = sys.stdin.read() if a.stdin else open(a.from_file, encoding="utf-8").read() if a.from_file else ""
    try:
        content = json.loads(raw) if raw.strip().startswith("{") else raw or None
    except ValueError as e:
        raise ValueError(_t("The handoff JSON cannot be read: ", "交接 JSON 读不出来：") + str(e))
    target = a.target
    if not target:
        session = L.key(a.session) if a.session else current_session()
        old = next(iter(records(a.request, registered=False)), None) if a.request else None
        target = old["task"] if old else handoff_task(session)
    try:
        rec = write(target, a.session, content, request=a.request, strict=True)
    except ValueError as e:
        set_phase(L.key(a.session) if a.session else current_session(), "failed", error=str(e).splitlines()[0][:300])
        raise
    D.out(rec, a.json, lambda r: print(_t(f"Handoff saved and attached to the task and Docs: {r['path']}", f"交接已保存并挂到任务和 Docs：{r['path']}") if r["task"] else
                                       _t(f"Handoff saved, attached to the session only: {r['path']}\nThis session has claimed no task. `dispatch claim <task>` first; later handoffs then go to the task.",
                                          f"交接已保存，只挂在会话上：{r['path']}\n本会话没有认领任务。先 `dispatch claim <任务>`，之后的交接会挂到任务上。")))
