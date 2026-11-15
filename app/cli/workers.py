# -*- coding: utf-8 -*-
"""Independent workers and the dispatcher's queue, stored in the board's KV store.

The board is authoritative (key dispatch.workers.v1). Only logs, launch specs and reports
live in DISPATCH_DIR/workers. A lock beside the board serializes this Mac's writers across
worktrees and sessions. Progress is appended as structured task comments, never read/modify/
written over another worker's progress. chatd polls failed workers for bounded recovery.
"""
import argparse
from contextlib import contextmanager
import datetime
import json
import os
import re
import shlex
import signal
import socket
import subprocess
import sys
import time
import uuid

import dplatform as P
import engines

KEY = "dispatch.workers.v1"
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
PROGRESS = "<!-- dispatch-worker-progress:v1\n"
STATES = ("running", "blocked", "done")
STATUS = {"running": "Running", "starting": "Starting", "failed": "Exited without report",
          "reported": "Report ready", "merged": "Merged", "remote": "Remote, unverified"}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def absolute(path):
    return os.path.abspath(os.path.expanduser(path))


def host():
    return socket.gethostname()


_MACHINE_ID = {}


def machine_id(home=None):
    """This Mac's id for worker rows: made once and kept in ~/.dispatch/machine-id. The host name
    is only for people to read; macOS changes it with the network (MacBookPro -> x.local) and
    renames, and a row that looked remote after that was counted as running forever."""
    path = os.path.join(home or os.path.expanduser("~"), ".dispatch", "machine-id")
    if path not in _MACHINE_ID:
        try:
            value = open(path, encoding="utf-8").read().strip()
        except OSError:
            value = ""
        if not value:
            import uuid
            value = uuid.uuid4().hex
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                tmp = f"{path}.{os.getpid()}.tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    f.write(value + "\n")
                os.replace(tmp, path)
            except OSError:
                pass
        _MACHINE_ID[path] = value
    return _MACHINE_ID[path]


def is_local(row):
    """Whether a worker or dispatcher row was registered on this Mac. Rows from before machine_id
    count as local when the host name still matches or their log or report is on this disk."""
    if row.get("host_id"):
        return row["host_id"] == machine_id()
    if row.get("host") == host():
        return True
    return any(p and os.path.exists(p) for p in (row.get("log"), row.get("report"), row.get("presence")))


def check_name(name):
    if not NAME.fullmatch(name or ""):
        raise ValueError("Worker name: 1 to 80 letters, digits, dots, underscores or hyphens")
    return name


def read_tail(path, lines=12, limit=32768):
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - limit))
            text = f.read(limit).decode("utf-8", "replace")
        return "\n".join(text.splitlines()[-lines:])
    except OSError:
        return ""


def process(pid):
    """A birth stamp protects against PID reuse. Zombies do not occupy a slot."""
    if not P.pid_alive(pid):
        return None
    if P.IS_WIN:
        # Worker orchestration is currently a macOS feature, never trust a foreign PID.
        return None
    r = subprocess.run(["ps", "-p", str(int(pid)), "-o", "lstart=", "-o", "stat="],
                       capture_output=True, text=True, timeout=3, env={**os.environ, "LC_ALL": "C"})
    cols = r.stdout.strip().rsplit(None, 1)
    if r.returncode or len(cols) != 2 or "Z" in cols[1]:
        return None
    return {"pid": int(pid), "birth": " ".join(cols[0].split())}


def alive(row):
    if not is_local(row):
        return None
    p = process(row.get("pid", 0))
    return bool(p and row.get("birth") and p["birth"] == row["birth"])


def git(cwd, *args):
    try:
        r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=10)
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, "", str(e)


def git_info(cwd):
    return {"branch": git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD")[1],
            "start_head": git(cwd, "rev-parse", "--verify", "HEAD")[1]}


def merge_info(row):
    cwd, branch = row["cwd"], row.get("branch", "")
    if not branch:
        return {"merged": False, "merge_note": "No branch recorded"}
    # Explicit refs prevent a branch name from being interpreted as a git option.
    head = git(cwd, "rev-parse", "--verify", "refs/heads/" + branch)[1]
    if not head:
        head = git(cwd, "rev-parse", "--verify", "refs/remotes/origin/" + branch)[1]
    main = git(cwd, "rev-parse", "--verify", "refs/remotes/origin/main")[1]
    if not head or not main:
        return {"merged": False, "merge_note": "Branch or origin/main unavailable"}
    changed = row.get("adopted") or head != row.get("start_head")
    merged = bool(changed and git(cwd, "merge-base", "--is-ancestor", head, main)[0] == 0)
    return {"merged": merged, "head": head, "origin_main": main,
            "merge_note": "" if changed else "No new branch commit since start"}


def failure_reason(log):
    tail = read_tail(log)
    # Prioritize the cause over shutdown errors. Keep the match even in long JSON log lines.
    for pattern in (r"usage.limit|rate.limit|quota|exceeded|credits|429|余额|额度",
                    r"error|failed|denied|exception|not.found"):
        for line in reversed(tail.splitlines()):
            match = re.search(pattern, line, re.I)
            if match:
                return line[max(0, match.start() - 40):match.start() + 560]
    return (tail.splitlines()[-1] if tail else "Process exited without a report")[-600:]


def worker_status(row, refresh=False):
    r = dict(row)
    active = alive(r)
    r["alive"] = active
    if active is None:
        return dict(r, status="remote", reason="Read on the worker's host to verify its process and files")
    if active:
        return dict(r, status="running", reason="")
    if not r.get("pid") and time.time() - float(r.get("launch_at", 0)) < 30 and not r.get("launch_error"):
        return dict(r, status="starting", reason="Waiting for launch registration")
    try:
        has_report = os.path.isfile(r["report"]) and os.path.getsize(r["report"]) > 0
    except OSError:
        has_report = False
    if not has_report:
        return dict(r, status="failed", reason=r.get("launch_error") or failure_reason(r.get("log", "")))
    if refresh:
        code, _, err = git(r["cwd"], "fetch", "--quiet", "origin", "main")
        if code:
            return dict(r, status="reported", reason="", merge_note="Could not refresh origin/main: " + err[:200])
    merge = merge_info(r)
    return dict(r, **merge, status="merged" if merge["merged"] else "reported", reason="")


class Store:
    def __init__(self, d):
        self.d = d
        self.root = os.path.join(d.DISPATCH_DIR, "workers")
        board = os.path.realpath(d.BEADS_DIR)
        # One lock for a board, even when callers have different DISPATCH_DIR values.
        self.lock_path = os.path.join(board, ".dispatch-workers.lock")

    @contextmanager
    def locked(self):
        import fcntl
        os.makedirs(os.path.dirname(self.lock_path), exist_ok=True)
        with open(self.lock_path, "a") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)

    def load(self, timeout=20):
        code, out, err = self.d.sh(["bd", "kv", "get", KEY, "--json"], timeout=timeout)
        try:
            wrapper = json.loads(out)
        except ValueError:
            raise ValueError((err or out).strip() or "Could not read worker registry")
        if not isinstance(wrapper, dict):
            raise ValueError("Invalid worker registry response, left untouched")
        if wrapper.get("found") is False:
            return {"version": 1, "limit": 4, "workers": {}, "queue": [], "dispatcher": None}
        if code:
            raise ValueError((err or out).strip() or "Could not read worker registry")
        try:
            state = json.loads(wrapper["value"])
            if (not isinstance(state, dict) or state.get("version") != 1
                    or not isinstance(state["workers"], dict) or not isinstance(state["queue"], list)
                    or type(state.get("limit")) is not int or not 1 <= state["limit"] <= 64):
                raise ValueError("Unexpected worker registry schema")
            return state
        except (KeyError, TypeError, ValueError) as e:
            raise ValueError(f"Invalid worker registry, left untouched: {e}")

    def save(self, state):
        code, out, err = self.d.sh(["bd", "kv", "set", KEY, json.dumps(state, ensure_ascii=False), "--json"])
        if code:
            raise ValueError((err or out).strip() or "Could not save worker registry")

    def issue(self, task):
        r = self.d.bd_json(["show", task, "--json"])
        if not isinstance(r, dict) or not r.get("id"):
            raise ValueError(f"Task does not exist: {task}")
        return r


def worker_rows(state, refresh=False):
    return [worker_status(r, refresh) for r in state["workers"].values()]


def slots(state, rows):
    running = sum(r["status"] in ("running", "starting", "remote") for r in rows)
    return {"limit": state["limit"], "running": running, "available": max(0, state["limit"] - running)}


def worker_tasks(row):
    return row.get("tasks") or [row["task"]]


def worker_prompt(r):
    # A persisted copy is both an audit record and the exact text sent to the engine.
    with open(r["brief"], encoding="utf-8") as f:
        brief = f.read()
    cli = shlex.join([sys.executable, os.path.join(os.path.dirname(__file__), "dispatch.py")])
    return (f"You are worker {r['name']}. Work in {r['cwd']} on tasks {', '.join(worker_tasks(r))}.\n"
            f"Read and follow this brief ({r['brief']}):\n\n{brief}\n\n"
            f"Write the final report to {r['report']} only when the work is ready to hand back. "
            "Include delivered changes, actual verification, and unfinished work. Do not create a placeholder report.\n"
            f"Record progress with: {cli} log {shlex.quote(r['task'])} --worker {shlex.quote(r['name'])} "
            '--step "current step" --evidence "commit/test/file:line" --next "next step" --state running\n'
            "Use --state blocked when blocked and --state done when ready. "
            "Do not start other agents unless the brief explicitly authorizes them.\n")


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp-" + uuid.uuid4().hex
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


def child_env(d, r):
    env = d.child_env()
    # Never let a child impersonate its dispatcher's session in hooks or task links.
    for k in (*engines.session_env_names(), "DISPATCH_DISPATCHER_SESSION", "DISPATCH_LIFE_MANAGED"):
        env.pop(k, None)
    env.update(DISPATCH_DIR=d.DISPATCH_DIR, BEADS_DIR=d.BEADS_DIR,
               BEADS_ACTOR=engines.agent_of(r["engine"]),
               DISPATCH_ACTOR=engines.agent_of(r["engine"]),
               DISPATCH_WORKER=r["name"], DISPATCH_WORKER_REPORT=r["report"],
               PYTHONDONTWRITEBYTECODE="1")
    env["PATH"] = engines.search_path(env)
    return env


def start(store, a, adopt=False):
    check_name(a.name)
    if P.IS_WIN:
        raise ValueError("Independent workers currently require macOS or Linux")
    cwd, brief = absolute(a.cwd), absolute(a.brief)
    if not os.path.isdir(cwd) or not os.path.isfile(brief):
        raise ValueError("The worktree and brief must exist")
    issue = store.issue(a.task)
    if not adopt and issue.get("status") == "closed":
        raise ValueError("Task is already done; reopen it before starting a worker")
    with store.locked():
        state = store.load()
        if a.name in state["workers"]:
            raise ValueError(f"Worker {a.name} already exists; use a new name for a retry")
        rows = worker_rows(state)
        if not adopt and not slots(state, rows)["available"]:
            raise ValueError(f"All {state['limit']} worker slots are occupied")
        queued = [q for q in state["queue"] if q["status"] == "queued" and a.task in q["tasks"]]
        tasks = list(dict.fromkeys([a.task, *[t for q in queued for t in q["tasks"]]]))
        if not adopt:
            for q in queued:
                blocked = dependency_reasons(q, state, rows, store.issue)
                if blocked:
                    raise ValueError("Queue dependencies are not ready: " + "; ".join(blocked))
            if any(set(worker_tasks(r)) & set(tasks) and r["status"] in ("running", "starting", "reported", "remote") for r in rows):
                raise ValueError("This task already has a running worker or a report awaiting merge")
        run_id = uuid.uuid4().hex
        folder = os.path.join(store.root, a.name, run_id)
        report = absolute(a.report) if a.report else os.path.join(folder, "report.md")
        log = absolute(a.log) if a.log else os.path.join(folder, "engine.log")
        if not adopt and (os.path.lexists(report) or os.path.lexists(log)):
            raise ValueError("Report and log paths must be new for each run")
        if report == log or report == brief or log == brief:
            raise ValueError("Brief, log and report must have different paths")
        effort = a.effort or engines.get(a.engine).default_effort
        r = dict(name=a.name, run_id=run_id, task=a.task, tasks=tasks, task_title=issue["title"],
                 engine=a.engine, model=a.model, effort=effort, cwd=cwd, brief=brief,
                 report=report, log=log, started_at=now(), launch_at=time.time(), host=host(), host_id=machine_id(),
                 pid=0, birth="", adopted=adopt, **git_info(cwd))
        if a.branch:
            r["branch"] = a.branch
        if adopt:
            if a.pid <= 0:
                raise ValueError("--pid must be positive")
            p = process(a.pid)
            r.update(pid=a.pid, birth=p["birth"] if p else "")
            r["adopted_at"] = r["started_at"]
            if p:
                r["started_at"] = datetime.datetime.strptime(p["birth"], "%a %b %d %H:%M:%S %Y").astimezone().isoformat()
            if getattr(a, "started_at", ""):
                try:
                    datetime.datetime.fromisoformat(a.started_at.replace("Z", "+00:00"))
                except ValueError:
                    raise ValueError("--started-at must be an ISO timestamp")
                r["started_at"] = a.started_at
        else:
            launch(store, state, r)
        state["workers"][a.name] = r
        for q in queued:
            q.update(status="started", worker=a.name, started_at=now())
        store.save(state)
    return worker_status(r)


def launch(store, state, r, recovery=""):
    """Caller holds the board lock. Persist the attempt before opening its launch gate."""
    folder = os.path.join(store.root, r["name"], r["run_id"])
    state["workers"][r["name"]] = r
    store.save(state)
    try:
        eng = engines.get(r["engine"])
        binary = engines.which(eng.bin)
        if not binary:
            raise ValueError(f"Engine not installed: {r['engine']}")
        prompt = worker_prompt(r) + recovery
        argv = eng.headless_argv(r["model"], prompt, r["cwd"], effort=r.get("effort", ""),
                                 lastfile=os.path.join(folder, "last-message.txt"))
        argv[0] = binary
        os.makedirs(folder, exist_ok=True)
        os.makedirs(os.path.dirname(r["report"]), exist_ok=True)
        os.makedirs(os.path.dirname(r["log"]), exist_ok=True)
        spec, gate = os.path.join(folder, "launch.json"), os.path.join(folder, "registered.json")
        write_json(spec, {"argv": argv, "gate": gate})
        with open(r["log"], "xb") as output:
            p = P.spawn_detached([sys.executable, os.path.abspath(__file__), "_exec", spec],
                                 cwd=r["cwd"], env=child_env(store.d, r), stdin=subprocess.DEVNULL,
                                 stdout=output, stderr=subprocess.STDOUT)
        r["pid"] = p.pid
        r["birth"] = (process(p.pid) or {}).get("birth", "")
        if not r["birth"]:
            raise ValueError("Worker launcher exited before registration")
        store.save(state)
        write_json(gate, {"run_id": r["run_id"]})
    except (OSError, ValueError) as e:
        r["launch_error"] = str(e)
        store.save(state)
        raise


def recovery_context(store, r):
    import handoff
    events = [c for task in worker_tasks(r) for c in store.d.bd_comments(task)]
    progress = progress_groups(events).get(r["name"], [])
    records = [handoff.latest(task, base=store.d.DISPATCH_DIR) for task in worker_tasks(r)]
    latest = max((rec for rec in records if rec), key=lambda rec: rec["created_at"], default=None)
    text = "\n\nAutomatic recovery after exit without report. Continue the original brief; verify existing work first.\n"
    text += "Latest dispatch log progress:\n" + progress_text({r["name"]: progress[-1:]})
    if latest:
        text += "\nLatest handoff, reread this file and its linked Agent records:\n" + latest["path"]
        with open(latest["path"], encoding="utf-8") as f:
            text += "\n" + f.read()
    return text


def recovery_need_you(store, r):
    """A stable marker recovers a successful create even if saving the receipt failed."""
    marker = "[worker-recovery:" + r.get("original_run_id", r["name"]) + "]"
    # dispatch.bd_json unwraps the first element, so it cannot read a list here.
    code, out, err = store.d.sh(["bd", "list", "--all", "--limit", "0", "--json"])
    try:
        issues = json.loads(out[out.find("["):])
    except ValueError:
        issues = None
    if code or not isinstance(issues, list):
        raise ValueError("Could not check existing worker recovery requests")
    old = next((t for t in issues if marker in str(t.get("description") or "")), None)
    if old:
        return old["id"]
    import tasks_view
    issue = store.issue(r["task"])
    project = tasks_view.project_of(issue)
    cmd = [sys.executable, os.path.join(os.path.dirname(__file__), "dispatch.py"), "need-you",
           "Worker " + r["name"] + " needs recovery", "--task", r["task"], "--json",
           "-d", f"{marker}\nTwo automatic retries failed without a report. Inspect {r['log']} and {r['brief']}; "
           "resolve the engine failure, then start a new worker.\n" + failure_reason(r["log"])]
    if project:
        cmd += ["-P", project]
    proc = subprocess.run(cmd, env=child_env(store.d, r), capture_output=True, text=True, timeout=30)
    if proc.returncode:
        raise ValueError("Worker recovery request failed: " + proc.stderr[-500:])
    return json.loads(proc.stdout)["id"]


def notify(store, row, event, **fields):
    """A notification must never stop a recovery: writing it is best effort."""
    try:
        import wake
        return wake.add(store.d, row, event, **fields)
    except (OSError, ValueError, KeyError):
        return None


def recover_failed(store):
    """Resident chatd calls this off its event loop, even with no active sessions.

    Two retries share the worker name but retain each run's PID, logs and report paths.
    The board lock serializes daemons on the same host and prevents duplicate launches.
    """
    actions = []
    with store.locked():
        state = store.load()
        rows = worker_rows(state)
        available = slots(state, rows)["available"]
        for status in rows:
            if status["status"] != "failed":
                continue
            r = state["workers"][status["name"]]
            if r.get("recovery_need_you"):
                continue
            # Never resurrect completed tasks or duplicate another running/reported attempt.
            if any(store.issue(t).get("status") == "closed" for t in worker_tasks(r)):
                continue
            if any(other["name"] != r["name"] and set(worker_tasks(other)) & set(worker_tasks(r))
                   and other["status"] in ("running", "starting", "reported", "merged", "remote") for other in rows):
                continue
            notify(store, status, "failed", note=status.get("reason", ""))
            if r.get("restart_count", 0) >= 2:
                r["recovery_need_you"] = recovery_need_you(store, r)
                store.save(state)
                notify(store, r, "need-you", need_you=r["recovery_need_you"])
                actions.append({"name": r["name"], "action": "need-you", "id": r["recovery_need_you"]})
                continue
            if available <= 0:
                continue
            recovery = recovery_context(store, r)
            old = {k: v for k, v in r.items() if k != "attempts"}
            run_id = uuid.uuid4().hex
            folder = os.path.join(store.root, r["name"], run_id)
            r = dict(r, attempts=[*r.get("attempts", []), old],
                     original_run_id=r.get("original_run_id") or r.get("run_id") or run_id,
                     run_id=run_id, restart_count=r.get("restart_count", 0) + 1,
                     report=os.path.join(folder, "report.md"), log=os.path.join(folder, "engine.log"),
                     pid=0, birth="", launch_at=time.time(), started_at=now(), adopted=False)
            r.pop("launch_error", None)
            try:
                launch(store, state, r, recovery)
            except (OSError, ValueError) as e:
                actions.append({"name": r["name"], "action": "launch-failed", "error": str(e)})
            else:
                available -= 1
                notify(store, r, "restarted", attempt=r["restart_count"])
                # Subsequent failed rows for the same task see this reservation too.
                rows.append(dict(r, status="starting"))
                actions.append({"name": r["name"], "action": "restarted", "attempt": r["restart_count"]})
    return actions


def exec_registered(spec):
    with open(spec, encoding="utf-8") as f:
        job = json.load(f)
    deadline = time.monotonic() + 20
    while not os.path.isfile(job["gate"]):
        if time.monotonic() >= deadline:
            print("Worker registration failed: launch gate was not committed", flush=True)
            return 1
        time.sleep(.05)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    os.execvpe(job["argv"][0], job["argv"], os.environ)


def progress_entry(worker, step, evidence="", next_step="", state="running", text=""):
    check_name(worker)
    if not (step or "").strip():
        raise ValueError("Structured progress requires --step")
    if state not in STATES:
        raise ValueError("Progress state must be running, blocked or done")
    return {"worker": worker, "step": step.strip(), "evidence": evidence.strip(),
            "next": next_step.strip(), "state": state, "text": text.strip(), "at": now()}


def progress_comment(entry):
    lines = [f"[{entry['worker']} · {entry['state']}] {entry['step']}"]
    for key, label in (("evidence", "Evidence"), ("next", "Next"), ("text", "Note")):
        if entry.get(key):
            lines.append(f"{label}: {entry[key]}")
    # Escape HTML terminators in user-provided text. JSON decoding restores them.
    payload = json.dumps(entry, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e")
    return "\n".join(lines) + "\n" + PROGRESS + payload + "\n-->"


def progress_groups(comments):
    groups = {}
    for c in comments:
        text = c.get("text", "") if isinstance(c, dict) else ""
        if PROGRESS not in text:
            continue
        try:
            entry = json.loads(text.rsplit(PROGRESS, 1)[1].split("\n-->", 1)[0])
            if not NAME.fullmatch(entry.get("worker", "")) or entry.get("state") not in STATES or not entry.get("step"):
                continue
            entry["author"] = c.get("author", "")
            groups.setdefault(entry["worker"], []).append(entry)
        except (ValueError, TypeError, AttributeError):
            continue
    for rows in groups.values():
        rows.sort(key=lambda e: e.get("at", ""))
    return groups


def progress_text(groups, limit=5):
    lines = []
    for name, rows in groups.items():
        lines.append(f"Worker {name}:")
        for e in rows[-limit:]:
            lines.append(f"  {e.get('at', '')} [{e['state']}] {e['step']}")
            if e.get("evidence"):
                lines.append("    Evidence: " + e["evidence"])
            if e.get("next"):
                lines.append("    Next: " + e["next"])
    return "\n".join(lines)


def queue_add(store, a):
    tasks = list(dict.fromkeys([a.task, *a.also_task]))
    issues = [store.issue(t) for t in tasks]
    brief = absolute(a.brief)
    if not os.path.isfile(brief):
        raise ValueError("Queue brief must exist")
    after = list(dict.fromkeys(a.after))
    if any(x in tasks for x in after):
        raise ValueError("A queue entry cannot depend on itself")
    with store.locked():
        state = store.load()
        if any(q["status"] == "queued" and set(tasks) & set(q["tasks"]) for q in state["queue"]):
            raise ValueError("A task is already queued")
        q = dict(id="queue-" + uuid.uuid4().hex[:12], task=tasks[0], tasks=tasks,
                 title=" / ".join(t["title"] for t in issues), brief=brief, after=after,
                 status="queued", added_at=now(), worker="")
        # Reject cycles through tasks already queued. Unknown worker names stay blocked until registered.
        graph = {t: item["after"] for item in [*state["queue"], q] if item["status"] == "queued" for t in item["tasks"]}
        def cycle(node, path):
            return node in path or any(cycle(child, path | {node}) for child in graph.get(node, []))
        if any(cycle(t, set()) for t in tasks):
            raise ValueError("Queue dependency cycle")
        state["queue"].append(q)
        store.save(state)
    return q


def dependency_reasons(q, state, rows, issue):
    blocked = []
    by_name = {r["name"]: r for r in rows}
    for dep in q["after"]:
        if dep in by_name:
            if by_name[dep]["status"] != "merged":
                blocked.append(f"{dep}: {STATUS[by_name[dep]['status']]}")
            continue
        related = [r for r in rows if dep in worker_tasks(r)]
        if related:
            # A later retry supersedes a failed run of the same task.
            latest = max(related, key=lambda r: r.get("launch_at", 0))
            if latest["status"] != "merged":
                blocked.append(f"{dep}: {STATUS[latest['status']]}")
            continue
        try:
            task = issue(dep)
        except ValueError:
            blocked.append(f"{dep}: unknown worker or task")
            continue
        if task.get("status") != "closed":
            blocked.append(f"{task['title']}: task is not done")
    return blocked


def queue_rows(store, state, rows):
    issues = {}
    def issue(task):
        if task not in issues:
            issues[task] = store.issue(task)
        return issues[task]
    out = []
    for q in state["queue"]:
        if q["status"] != "queued":
            continue
        blocked = dependency_reasons(q, state, rows, issue)
        if not os.path.isfile(q["brief"]):
            blocked.append("Brief is missing")
        # Prevent redispatch after a task was completed independently of this queue.
        for t in q["tasks"]:
            try:
                task = issue(t)
                if task.get("status") == "closed":
                    blocked.append(f"{task['title']}: already done; remove or revise this queue entry")
            except ValueError:
                blocked.append(f"{t}: task unavailable")
        if any(set(worker_tasks(r)) & set(q["tasks"]) and r["status"] in ("running", "starting", "reported", "remote") for r in rows):
            blocked.append("Task has a worker running or awaiting merge")
        out.append(dict(q, position=len(out) + 1, blocked=blocked, ready=not blocked))
    return out


def dispatcher_status(row):
    if not row:
        return None
    r = dict(row)
    r["elapsed_seconds"] = max(0, int(time.time() - r["claimed_at"]))
    if row.get("released_at"):
        return dict(r, active=False, state="released")
    active = alive(row)
    # SessionEnd can arrive while the parent process still lives.
    if active and row.get("presence") and not os.path.isfile(row["presence"]):
        active = False
    return dict(r, active=active is not False, state="remote" if active is None else "active" if active else "ended")


def dispatcher_owner(d, session="", pid=0, engine=""):
    session = session or d.session_self()
    if not session:
        raise ValueError("Could not identify this session; give --session and --pid")
    presence = ""
    records = d._presence_by_pid()
    for candidate, r in records.items():
        if r.get("session_id") == session and (not pid or pid == candidate):
            pid = candidate
            engine = engine or r.get("agent") or ""
            safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in session)
            path = os.path.join(d.DISPATCH_DIR, "sessions", f"{r.get('agent')}__{safe}.json")
            presence = path if os.path.isfile(path) else ""
            break
    if not pid:
        # A session chatd holds lives as long as chatd does; some engines (OpenCode) have no pid of their own.
        try:
            import chatd
            reg = chatd.read_registry(d.DISPATCH_DIR) or {}
            info = next((v for k, v in reg.get("sessions", {}).items() if k.split(":", 1)[-1] == session), None)
            if info is not None:
                pid = info.get("pid") or reg.get("pid") or 0
                engine = engine or info.get("agent") or ""
        except Exception:
            pid = 0
    if not pid:
        # A session env id alone is not proof of a long-lived PID. Ask for an explicit one.
        raise ValueError("No live session process found; give the session's --pid")
    p = process(pid)
    if not p:
        raise ValueError("Dispatcher PID is not alive")
    if not engine:  # an id in an engine's own shape (OpenCode's ses_…) says whose session it is
        engine = next((e.id for e in engines.known() if e.owns_session_id(session)), "")
    return dict(session=session, engine=engine, host=host(), host_id=machine_id(), pid=pid, birth=p["birth"], presence=presence,
                cwd=os.getcwd(), started_at=now(), claimed_at=time.time())


def dispatcher_claim(store, a):
    owner = dispatcher_owner(store.d, a.session, a.pid, getattr(a, "engine", ""))
    import wake
    with store.locked():
        state = store.load()
        current = dispatcher_status(state.get("dispatcher"))
        if current and current["active"]:
            if all(current.get(k) == owner.get(k) for k in ("session", "host", "pid", "birth")):
                wake.save_dispatcher(store.d, state["dispatcher"])
                return current
            raise ValueError(f"Dispatcher already active: {current['session']} on {current['host']} "
                             f"for {current['elapsed_seconds']}s. Release or hand it off first.")
        state["dispatcher"] = owner
        store.save(state)
        wake.save_dispatcher(store.d, owner)
    return dispatcher_status(owner)


def release_session(session, d=None, reason="session ended", if_owner=True):
    """Hook for SessionEnd and session-life handoff, idempotent and owner-specific."""
    if not session:
        raise ValueError("A session id is required to release the dispatcher")
    if d is None:
        import dispatch as d
    if not os.path.isdir(d.BEADS_DIR):
        return {"released": False, "session": session}
    store = Store(d)
    with store.locked():
        state = store.load(timeout=5)
        row = state.get("dispatcher")
        if not row or row.get("released_at"):
            return {"released": False, "session": session}
        if row["session"] != session or not is_local(row):
            if if_owner:
                return {"released": False, "session": session}
            raise ValueError("Only the registered dispatcher session can release its claim")
        row.update(released_at=now(), release_reason=reason)
        store.save(state)
        import wake
        wake.save_dispatcher(d, row)
        return {"released": True, "session": session, "reason": reason}


def prime_section(d, session=""):
    """No fetch and at most 650 UTF-8 bytes. Detailed output is always opt-in. Only the registered
    dispatcher's brief has it: the person does not care about dispatch internals in other sessions,
    and the check reads the local mirror of the claim, not the board."""
    import prime_brief as B
    import wake
    if not wake.is_dispatcher(d, session):
        return []
    try:
        state = Store(d).load(timeout=3)
    except (ValueError, OSError, subprocess.TimeoutExpired):
        return []
    rows = worker_rows(state)
    dispatcher = dispatcher_status(state.get("dispatcher"))
    pending = [q for q in state["queue"] if q["status"] == "queued"]
    if not rows and not pending and not (dispatcher and dispatcher["active"]):
        return []
    from lang import t as _t
    lines = [_t("## Dispatching and workers", "## 调度与 workers")]
    if dispatcher and dispatcher["active"]:
        mine = dispatcher["session"] == session
        mins = dispatcher['elapsed_seconds'] // 60
        lines.append(_t(f"{'This session dispatches' if mine else 'A dispatcher session is'} {B.clip(dispatcher['session'], 48)}, running for {mins} min.",
                        f"{'当前调度会话' if mine else '已有调度会话'} {B.clip(dispatcher['session'], 48)}，已运行 {mins} 分钟。"))
    running, reported, failed = slots(state, rows)['running'], sum(r['status'] == 'reported' for r in rows), sum(r['status'] == 'failed' for r in rows)
    lines.append(_t(f"Workers: {running}/{state['limit']} running, {reported} to merge, {failed} stopped.",
                    f"Workers：在跑 {running}/{state['limit']}，待合并 {reported}，中断 {failed}。"))
    if pending:
        lines.append(_t(f"{len(pending)} queued, the first: {B.clip(pending[0]['title'], 45)}.", f"排队 {len(pending)} 件，第一条：{B.clip(pending[0]['title'], 45)}。"))
    lines.append(_t("Full state: `dispatch worker list`; the next one: `dispatch worker next`.", "完整状态：`dispatch worker list`；下一件：`dispatch worker next`。"))
    return B.cap(lines, 650, lambda n: _t("Full state: `dispatch worker list`.", "完整状态：`dispatch worker list`。"))


def notification_section(d, session="", mark=False, read_later=None):
    """Unread worker notifications for a dispatcher's brief, at most about 1000 UTF-8 bytes."""
    import wake
    try:
        return wake.prime_lines(d, session, mark=mark, read_later=read_later)
    except (OSError, ValueError):
        return []


def list_text(result):
    s = result["slots"]
    lines = [f"Workers: {s['running']}/{s['limit']} running, {s['available']} slots available"]
    for r in result["workers"]:
        lines.append(f"{r['name']}: {STATUS[r['status']]} | {r['task_title']} | {r['engine']} {r['model']}")
        lines.append(f"  PID {r['pid']} | {r['cwd']} | {r.get('branch') or '(no branch)'}")
        lines.append(f"  Report: {r['report']}")
        if r.get("restart_count"):
            lines.append(f"  Automatic retries: {r['restart_count']}/2")
        if r.get("recovery_need_you"):
            lines.append("  Waiting for you: " + r["recovery_need_you"])
        if r.get("reason"):
            lines.append("  Reason: " + r["reason"])
    return "\n".join(lines)


def queue_text(rows):
    return "\n".join(f"{q['position']}. {q['title']} | {'Ready' if q['ready'] else 'Waiting: ' + '; '.join(q['blocked'])}\n"
                     f"   {q['id']} | {q['brief']}" for q in rows) or "Queue empty"


def command(store, a):
    if a.group == "dispatcher":
        if a.op == "claim":
            r = dispatcher_claim(store, a)
            import wake
            unread = wake.unread(store.d)
            r["notifications"] = unread
            if unread:
                wake.mark_read(store.d, [n["id"] for n in unread], "claim")
                return r, json.dumps(r, ensure_ascii=False, indent=2) + "\n\nUnread worker notifications (now read):\n" + "\n".join(n["text"] for n in unread)
        elif a.op == "release":
            r = release_session(a.session or store.d.session_self(), store.d, a.reason, a.if_owner)
        else:
            r = dispatcher_status(store.load().get("dispatcher")) or {"active": False}
        return r, json.dumps(r, ensure_ascii=False, indent=2)
    if a.op in ("start", "adopt"):
        r = start(store, a, adopt=a.op == "adopt")
        return r, f"{r['name']}: {STATUS[r['status']]} | PID {r['pid']}\nLog: {r['log']}\nReport: {r['report']}"
    if a.op == "config":
        with store.locked():
            state = store.load()
            if a.limit is not None:
                if a.limit < 1 or a.limit > 64:
                    raise ValueError("Worker limit must be between 1 and 64")
                state["limit"] = a.limit
                store.save(state)
        r = {"limit": state["limit"]}
        return r, f"Worker limit: {r['limit']}"
    if a.op == "queue" and a.queue_op == "add":
        q = queue_add(store, a)
        return q, f"Queued: {q['title']}\n{q['id']} | {q['brief']}"
    if a.op == "queue" and a.queue_op == "remove":
        with store.locked():
            state = store.load()
            q = next((q for q in state["queue"] if q["status"] == "queued" and (q["id"] == a.task or a.task in q["tasks"])), None)
            if not q:
                raise ValueError("Queued entry not found")
            q.update(status="cancelled", cancelled_at=now())
            store.save(state)
        return q, f"Removed from queue: {q['title']}"
    if a.op == "wait":
        import wake
        r = wake.wait(store, a.timeout, a.interval)
        return r, wake.wait_text(r)
    if a.op == "notifications":
        import wake
        if a.ack:
            moved = wake.mark_read(store.d, [n["id"] for n in wake.unread(store.d)], "ack")
            return {"acknowledged": len(moved)}, f"Marked {len(moved)} notification(s) read"
        items = wake.recent_read(store.d, 20) + wake.unread(store.d) if a.all else wake.unread(store.d)
        text = "\n".join(("" if n.get("read_at") is None else "(read) ") + n["text"] for n in items) or "No unread worker notifications"
        return {"notifications": items}, text
    state = store.load()
    rows = worker_rows(state, getattr(a, "refresh", False))
    if a.op == "list":
        r = {"workers": rows, "slots": slots(state, rows), "dispatcher": dispatcher_status(state.get("dispatcher"))}
        return r, list_text(r)
    if a.op == "show":
        r = next((r for r in rows if r["name"] == a.name), None)
        if not r:
            raise ValueError(f"No worker named {a.name}")
        comments = [c for task in worker_tasks(r) for c in store.d.bd_comments(task)]
        r["progress"] = progress_groups(comments).get(a.name, [])
        r["report_text"] = read_tail(r["report"], lines=200, limit=65536) if is_local(r) else ""
        r["log_tail"] = read_tail(r["log"]) if is_local(r) else ""
        text = list_text({"workers": [r], "slots": slots(state, rows)}) + "\nLog: " + r["log"]
        text += "\n" + progress_text({a.name: r["progress"]})
        text += ("\n\nReport (last 200 lines):\n" + r["report_text"]) if r["report_text"] else ""
        text += ("\n\nRecent log:\n" + r["log_tail"]) if r["log_tail"] else ""
        return r, text
    queued = queue_rows(store, state, rows)
    if a.op == "queue":
        return {"queue": queued}, queue_text(queued)
    if a.op == "next":
        s = slots(state, rows)
        candidate = next((q for q in queued if q["ready"]), None) if s["available"] else None
        r = {"slots": s, "next": candidate, "queue": queued}
        return r, (f"Next: {candidate['title']}\nTask: {candidate['task']}\nBrief: {candidate['brief']}\n"
                   "Suggested only; the dispatcher decides when to start.") if candidate else (
                       "No free worker slot" if not s["available"] else "No ready queue entry\n" + queue_text(queued))
    raise ValueError(f"Unknown worker operation: {a.op}")


def add_parser(sub, d):
    for group in ("worker", "dispatcher"):
        parser = sub.add_parser(group, help="Independent workers and queue" if group == "worker" else "Claim or release the single dispatcher session")
        parser.set_defaults(group=group)
        ops = parser.add_subparsers(dest="op", required=True)
        if group == "worker":
            for op in ("start", "adopt"):
                p = ops.add_parser(op)
                p.add_argument("name")
                for flag in ("task", "engine", "model", "cwd", "brief"):
                    kw = {"choices": [e.id for e in engines.runnable() if e.supports("headless_argv")]} if flag == "engine" else {}
                    p.add_argument("--" + flag, required=True, **kw)
                for flag in ("effort", "report", "log", "branch"):
                    p.add_argument("--" + flag, default="")
                if op == "adopt":
                    p.add_argument("--pid", type=int, required=True)
                    p.add_argument("--started-at", default="")
                p.add_argument("--json", action="store_true")
            for op in ("list", "show", "next"):
                p = ops.add_parser(op)
                if op == "show":
                    p.add_argument("name")
                p.add_argument("--refresh", action="store_true", help="Fetch origin/main before checking merges")
                p.add_argument("--json", action="store_true")
            p = ops.add_parser("wait", help="Block until a running worker changes state or a notification is unread")
            p.add_argument("--timeout", type=float, default=0, help="Seconds to wait; 0 waits without limit")
            p.add_argument("--interval", type=float, default=5, help="Seconds between checks")
            p.add_argument("--json", action="store_true")
            p = ops.add_parser("notifications", help="Unread worker notifications (--all adds recent read ones)")
            p.add_argument("--all", action="store_true")
            p.add_argument("--ack", action="store_true", help="Mark every unread notification read")
            p.add_argument("--json", action="store_true")
            p = ops.add_parser("config")
            p.add_argument("--limit", type=int)
            p.add_argument("--json", action="store_true")
            queue = ops.add_parser("queue").add_subparsers(dest="queue_op", required=True)
            p = queue.add_parser("add")
            p.add_argument("task")
            p.add_argument("--brief", required=True)
            p.add_argument("--after", action="append", default=[], help="Worker or task to wait for (repeatable)")
            p.add_argument("--also-task", action="append", default=[], help="Another task in the same queue entry")
            p.add_argument("--json", action="store_true")
            p = queue.add_parser("list")
            p.add_argument("--refresh", action="store_true")
            p.add_argument("--json", action="store_true")
            p = queue.add_parser("remove")
            p.add_argument("task", help="Queue id or task id")
            p.add_argument("--json", action="store_true")
        else:
            p = ops.add_parser("claim")
            p.add_argument("--session", default="")
            p.add_argument("--pid", type=int, default=0)
            p.add_argument("--engine", default="", choices=["", *(e.agent for e in engines.runnable())],
                           help="The dispatcher's engine (default: from its presence record)")
            p.add_argument("--json", action="store_true")
            p = ops.add_parser("release")
            p.add_argument("--session", default="")
            p.add_argument("--reason", default="handoff")
            p.add_argument("--if-owner", action="store_true", help="SessionEnd hook: no-op for a different session")
            p.add_argument("--json", action="store_true")
            p = ops.add_parser("show")
            p.add_argument("--json", action="store_true")
        parser.set_defaults(fn=lambda a: sys.exit(run(a, d)))


def run(a, d):
    try:
        r, text = command(Store(d), a)
        print(json.dumps(r, ensure_ascii=False, indent=2) if a.json else text)
        return 0
    except (ValueError, OSError, subprocess.TimeoutExpired) as e:
        if getattr(a, "json", False):
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        else:
            print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "_exec":
    sys.exit(exec_registered(sys.argv[2]))
