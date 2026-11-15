# -*- coding: utf-8 -*-
"""Wake the dispatcher: a worker state change is written to disk first, then handed to whoever
dispatches. The dispatcher's context is only a cache, so nothing here depends on it being awake.

Notifications are one JSON file each in DISPATCH_DIR/notifications (unread) and
DISPATCH_DIR/notifications/read (seen). The file name is a digest of the event key
(run, event, attempt), so a repeated sweep never writes the same fact twice.

Who reads them:
  * chatd (resident): sweeps every WAKE_EVERY seconds, and delivers unread ones as one message
    into the dispatcher's Agents-window session (queued behind a running turn).
  * terminal dispatcher: handoff.hook adds unread ones to additionalContext on UserPromptSubmit,
    PostToolUse and Stop; `dispatch worker wait` blocks until something arrives.
  * prime lists unread ones (also right after a compaction) and `dispatcher claim` returns them,
    so a dispatcher that starts later still finds what happened while nobody was registered.
"""
import contextlib
import datetime
import hashlib
import json
import os
import re
import subprocess
import time
import uuid

import workers as W
from lang import t as _t

SETTLE_SECONDS = 20      # a report of a still running worker must be this old to count as handed back
KEEP_READ_DAYS = 30
REMIND_SECONDS = 600     # the Stop reminder for running workers repeats at most this often per session
SCAN_SECONDS = 20        # a hook sweeps the workers itself at most this often (chatd does it every 15 s when it runs)
WAIT_FRESH = 60          # a `worker wait` heartbeat older than this does not count as waiting
SHOW_LINES = 6
NAME = re.compile(r"^[0-9a-f]{16}\.json$")
EVENTS = ("reported", "failed", "restarted", "need-you")


# ---------------------------------------------------------------- storage
def folder(d):
    return os.path.join(d.DISPATCH_DIR, "notifications")


def read_folder(d):
    return os.path.join(folder(d), "read")


@contextlib.contextmanager
def locked(d):
    import fcntl
    os.makedirs(read_folder(d), mode=0o700, exist_ok=True)
    with open(os.path.join(folder(d), ".lock"), "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def write_json(path, obj):
    W.write_json(path, obj)


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            obj = json.load(f)
        return obj if isinstance(obj, dict) else {}
    except (OSError, ValueError):
        return {}


def digest(key):
    return hashlib.sha1(key.encode()).hexdigest()[:16]


def line(n):
    """The one sentence a dispatcher reads: worker, state, report path."""
    w, event = n["worker"], n["event"]
    if event == "reported":
        return _t(f"worker {w} handed back, report {n['report']}", f"worker {w} 已交回，报告 {n['report']}")
    if event == "failed":
        why = _t(f" ({n['note']})", f"（{n['note']}）") if n.get("note") else ""
        return _t(f"worker {w} quit without a report{why}, report {n['report']} (not written), log {n.get('log', '')}", f"worker {w} 退出没交报告{why}，报告 {n['report']}（未写），日志 {n.get('log', '')}")
    if event == "restarted":
        return _t(f"worker {w} restarted by itself (attempt {n.get('attempt', 1)}/2), report {n['report']}", f"worker {w} 已自动重启（第 {n.get('attempt', 1)}/2 次），报告 {n['report']}")
    return _t(f"worker {w} failed after two restarts; it went to need-you {n.get('need_you', '')}, log {n.get('log', '')}", f"worker {w} 两次自动重启都失败，已转 need-you {n.get('need_you', '')}，日志 {n.get('log', '')}")


def tidy(reason):
    """A log line about why a worker died, cut down to the message a person can read."""
    reason = str(reason or "")
    found = re.search(r'"message"\s*:\s*"((?:[^"\\]|\\.)*)"', reason)
    if found:
        reason = found.group(1)
    return " ".join(reason.replace("\\n", " ").split()).strip(" \"',{}")[:160]


def make(row, event, note="", attempt=0, need_you=""):
    at = time.time()
    run = row.get("original_run_id") or row.get("run_id") or row["name"]
    key = {"reported": f"{row.get('run_id') or run}:reported", "failed": f"{row.get('run_id') or run}:failed",
           "restarted": f"{run}:restarted:{attempt}", "need-you": f"{run}:need-you"}[event]
    n = {"id": digest(key), "key": key, "event": event, "worker": row["name"], "task": row.get("task", ""),
         "tasks": W.worker_tasks(row), "task_title": row.get("task_title", ""), "run_id": row.get("run_id", ""),
         "engine": row.get("engine", ""), "model": row.get("model", ""), "report": row.get("report", ""),
         "log": row.get("log", ""), "note": tidy(note), "attempt": attempt,
         "need_you": need_you, "at": datetime.datetime.fromtimestamp(at, datetime.timezone.utc).isoformat(timespec="seconds"),
         "at_ts": at, "read_at": None, "read_by": "", "delivered": []}
    n["text"] = line(n)
    return n


def add(d, row, event, note="", attempt=0, need_you="", silent=False):
    """Write one notification unless the same fact is already on disk. None when it existed."""
    n = make(row, event, note, attempt, need_you)
    name = n["id"] + ".json"
    with locked(d):
        if os.path.exists(os.path.join(folder(d), name)) or os.path.exists(os.path.join(read_folder(d), name)):
            return None
        if silent:
            n.update(read_at=time.time(), read_by="baseline")
            write_json(os.path.join(read_folder(d), name), n)
        else:
            write_json(os.path.join(folder(d), name), n)
    return n


def add_note(d, key, text, event="doctor", source="doctor"):
    """A notification that is not about a worker (`dispatch doctor`'s daily run): one line of text,
    written once per key even after it was read. None when the key was already written."""
    at = time.time()
    n = {"id": digest(key), "key": key, "event": event, "worker": source, "task": "", "tasks": [], "task_title": "", "run_id": "",
         "engine": "", "model": "", "report": "", "log": "", "note": "", "attempt": 0, "need_you": "",
         "at": datetime.datetime.fromtimestamp(at, datetime.timezone.utc).isoformat(timespec="seconds"),
         "at_ts": at, "read_at": None, "read_by": "", "delivered": [], "text": text}
    name = n["id"] + ".json"
    with locked(d):
        if os.path.exists(os.path.join(folder(d), name)) or os.path.exists(os.path.join(read_folder(d), name)):
            return None
        write_json(os.path.join(folder(d), name), n)
    return n


def unread(d):
    try:
        names = [x for x in os.listdir(folder(d)) if NAME.match(x)]
    except OSError:
        return []
    items = [n for n in (load(os.path.join(folder(d), x)) for x in names) if n.get("id")]
    return sorted(items, key=lambda n: (n.get("at_ts", 0), n["id"]))


def recent_read(d, limit=10):
    try:
        names = [x for x in os.listdir(read_folder(d)) if NAME.match(x)]
    except OSError:
        return []
    items = [n for n in (load(os.path.join(read_folder(d), x)) for x in names) if n.get("id")]
    return sorted(items, key=lambda n: (n.get("at_ts", 0), n["id"]))[-limit:]


def mark_read(d, ids, by, via=""):
    """Move the named notifications to read/, stamped with who saw them. Returns the ones moved."""
    moved = []
    with locked(d):
        for i in ids:
            src = os.path.join(folder(d), i + ".json")
            n = load(src)
            if not n:
                continue
            n.update(read_at=time.time(), read_by=by)
            if via:
                n["delivered"] = [*n.get("delivered", []), {"via": via, "at": time.time()}]
            write_json(os.path.join(read_folder(d), i + ".json"), n)
            try:
                os.unlink(src)
            except OSError:
                pass
            moved.append(n)
        cutoff = time.time() - KEEP_READ_DAYS * 86400
        for x in os.listdir(read_folder(d)):
            p = os.path.join(read_folder(d), x)
            try:
                if NAME.match(x) and os.path.getmtime(p) < cutoff:
                    os.unlink(p)
            except OSError:
                pass
    return moved


def ago(n):
    s = max(0, int(time.time() - n.get("at_ts", time.time())))
    if s < 60:
        return _t("just now", "刚刚")
    return _t(f"{s // 60} min ago", f"{s // 60} 分钟前") if s < 3600 else _t(f"{s // 3600} h ago", f"{s // 3600} 小时前") if s < 86400 else _t(f"{s // 86400} days ago", f"{s // 86400} 天前")


def render(items, limit=SHOW_LINES, max_bytes=0):
    """(text, shown): the lines a dispatcher reads, at most `limit` lines and `max_bytes` UTF-8 bytes."""
    shown, lines, used = [], [], 0
    for n in items[:limit]:
        text = _t(f"- {n['text']} ({ago(n)})", f"- {n['text']}（{ago(n)}）") if n.get("event") in ("doctor", "knowledge") else _t(f"- {n['text']} ({n.get('task') or 'no task'}, {ago(n)})", f"- {n['text']}（{n.get('task') or '无任务'}，{ago(n)}）")
        size = len(text.encode("utf-8")) + 1
        if max_bytes and shown and used + size > max_bytes:
            break
        shown.append(n)
        lines.append(text)
        used += size
    if len(items) > len(shown):
        lines.append(_t(f"{len(items) - len(shown)} more, `dispatch worker notifications`", f"还有 {len(items) - len(shown)} 条，`dispatch worker notifications`"))
    return "\n".join(lines), shown


# ---------------------------------------------------------------- what happened to the workers
def baseline_path(d):
    return os.path.join(folder(d), ".baseline")


def report_state(row):
    """('' | 'reported' | 'failed', reason) for one worker row, without touching git or bd."""
    if not W.is_local(row):
        return "", ""
    active = W.alive(row)
    if active is None:
        return "", ""
    try:
        size, mtime = os.path.getsize(row["report"]), os.path.getmtime(row["report"])
    except OSError:
        size, mtime = 0, 0
    if active:
        return ("reported", "") if size > 0 and time.time() - mtime >= SETTLE_SECONDS else ("", "")
    if not row.get("pid") and time.time() - float(row.get("launch_at", 0)) < 30 and not row.get("launch_error"):
        return "", ""
    if size > 0:
        return "reported", ""
    return "failed", row.get("launch_error") or W.failure_reason(row.get("log", ""))


def scan(store, state=None):
    """Write a notification for every worker that handed back or exited without a report.

    The first sweep on a machine only records what already ended, quietly, so old workers do not
    all wake the dispatcher at once. Returns the new notifications."""
    d = store.d
    state = state if state is not None else store.load()
    first = not os.path.exists(baseline_path(d))
    if first:
        os.makedirs(folder(d), mode=0o700, exist_ok=True)
        write_json(baseline_path(d), {"at": time.time()})
    out = []
    for row in state["workers"].values():
        event, why = report_state(row)
        if not event:
            continue
        n = add(d, row, event, note=why if event == "failed" else "", silent=first)
        if n and not first:
            out.append(n)
    return out


def running(state):
    return [r["name"] for r in state["workers"].values() if W.alive(r) is True]


def wait(store, timeout=0, interval=5, sleep=time.sleep, clock=time.time):
    """Block until a worker changes state or an unread notification exists; print-ready result.

    reason: notifications | idle (nothing running, nothing unread) | timeout."""
    d = store.d
    beat = os.path.join(folder(d), "waiting", f"{os.getpid()}.json")
    end = clock() + timeout if timeout else None
    birth = (W.process(os.getpid()) or {}).get("birth", "")
    failures = 0
    try:
        while True:
            try:
                state = store.load()
                failures = 0
            except (ValueError, OSError, subprocess.SubprocessError):
                # The board may be busy for a moment; a long wait should not die of it.
                failures += 1
                if failures >= 5:
                    raise
                sleep(interval)
                continue
            scan(store, state)
            items = unread(d)
            names = running(state)
            if items:
                mark_read(d, [n["id"] for n in items], "wait")
                return {"reason": "notifications", "notifications": items, "running": names}
            if not names:
                return {"reason": "idle", "notifications": [], "running": []}
            if end is not None and clock() >= end:
                return {"reason": "timeout", "notifications": [], "running": names}
            write_json(beat, {"pid": os.getpid(), "birth": birth, "at": time.time()})
            sleep(interval)
    finally:
        try:
            os.unlink(beat)
        except OSError:
            pass


def waiting(d):
    """A `worker wait` is running right now (pid alive, heartbeat fresh)."""
    try:
        names = os.listdir(os.path.join(folder(d), "waiting"))
    except OSError:
        return False
    for x in names:
        b = load(os.path.join(folder(d), "waiting", x))
        p = W.process(b.get("pid", 0)) if b.get("pid") else None
        if p and p["birth"] == b.get("birth") and time.time() - b.get("at", 0) < WAIT_FRESH:
            return True
    return False


def wait_text(r):
    if r["reason"] == "notifications":
        return "\n".join(n["text"] for n in r["notifications"])
    if r["reason"] == "timeout":
        return "Timed out; still running: " + ", ".join(r["running"])
    return "No worker is running and nothing is unread"


# ---------------------------------------------------------------- the dispatcher, cached for cheap reads
def dispatcher_file(d):
    return os.path.join(folder(d), "dispatcher.json")


def save_dispatcher(d, row):
    """Mirror of the board's dispatcher row; hooks read this instead of asking bd on every tool call."""
    try:
        os.makedirs(folder(d), mode=0o700, exist_ok=True)
        write_json(dispatcher_file(d), row or {})
    except OSError:
        pass


def dispatcher(d):
    row = load(dispatcher_file(d))
    return W.dispatcher_status(row) if row.get("session") else None


def raw_session(session):
    session = str(session or "")
    return session.split(":", 1)[1] if re.match(r"^(claude-code|claude|codex|opencode):", session) else session


def recipient(d, session):
    """dispatcher | other | unclaimed, for a session id."""
    if os.environ.get("DISPATCH_WORKER"):
        return "other"
    st = dispatcher(d)
    if st and st["active"]:
        return "dispatcher" if raw_session(session) == st["session"] else "other"
    return "unclaimed"


# ---------------------------------------------------------------- terminal hooks
def is_dispatcher(d, session):
    """Cheap first test for a hook: the local copy names this session and it is still active."""
    row = load(dispatcher_file(d))
    if not session or row.get("session") != raw_session(session) or row.get("released_at") or os.environ.get("DISPATCH_WORKER"):
        return False
    return bool((W.dispatcher_status(row) or {}).get("active"))


def refresh(d, force=False, now=time.time):
    """Sweep the workers from a hook, when no chatd is doing it: at most every SCAN_SECONDS. Returns
    the registry state it read, or None when it did not (or could not) look."""
    stamp = os.path.join(folder(d), "scan.json")
    if not force and now() - load(stamp).get("at", 0) < SCAN_SECONDS:
        return None
    try:
        store = W.Store(d)
        state = store.load(timeout=5)
        os.makedirs(folder(d), mode=0o700, exist_ok=True)
        write_json(stamp, {"at": now()})
        scan(store, state)
        return state
    except (ValueError, OSError, subprocess.SubprocessError):
        return None


def hook_note(d, session, event, stop_active=False, now=time.time):
    """{'text', 'block'} for a terminal dispatcher's hook, or None. Injected notifications are read."""
    if not is_dispatcher(d, session):
        return None
    state = refresh(d, force=event == "Stop", now=now)
    items = unread(d)
    if items:
        text, shown = render(items)
        mark_read(d, [n["id"] for n in shown], "hook:" + event)
        head = _t("Dispatch worker notifications (marked read):\n", "Dispatch worker 通知（已标已读）：\n") + text
        head += _t("\nRead a report with `dispatch worker show <name>`; while a worker still runs, wait with the background command `dispatch worker wait`.", "\n用 `dispatch worker show <名>` 读报告；还有 worker 在跑时，用后台命令 `dispatch worker wait` 挂着等。")
        return {"text": head, "block": event == "Stop"}
    if event != "Stop" or stop_active or state is None:
        return None
    names = running(state)
    if not names or waiting(d):
        return None
    stamp = os.path.join(folder(d), "remind.json")
    seen = load(stamp)
    key = raw_session(session)
    last = seen.get(key) or {}
    if last.get("workers") == sorted(names) and now() - last.get("at", 0) < REMIND_SECONDS:
        return None
    seen[key] = {"workers": sorted(names), "at": now()}
    write_json(stamp, seen)
    return {"text": _t("Workers still running: " + ", ".join(names) + ". Do not finish yet: wait with the background command `dispatch worker wait`, "
                       "which returns when any worker hands back or fails; read a report with `dispatch worker show <name>`.",
                       "还有 worker 在跑：" + "、".join(names) + "。先不要结束：用后台命令 `dispatch worker wait` 挂着等，"
                       "它在任一 worker 交回或出错时返回；报告用 `dispatch worker show <名>` 读。"), "block": True}


# ---------------------------------------------------------------- prime
def prime_lines(d, session, limit=SHOW_LINES, mark=False, read_later=None):
    """The unread section of the registered dispatcher's brief. Other sessions never see it; a
    dispatcher that registers later gets what came in meanwhile from `dispatcher claim`. `read_later`: a list
    that gets the ids of what is shown instead of marking them read, for a caller that marks them once the brief
    has really gone out (`dispatch prime` in a hook can be stopped before it prints)."""
    who = recipient(d, session)
    if who != "dispatcher":
        return []
    items = unread(d)
    if not items:
        return []
    text, shown = render(items, limit, max_bytes=800)
    if read_later is not None:
        read_later.extend(n["id"] for n in shown)
    elif mark:
        mark_read(d, [n["id"] for n in shown], "prime")
    return [_t(f"## Worker notifications ({len(items)} unread)", f"## Worker 通知（未读 {len(items)}）"), *text.splitlines()]


# ---------------------------------------------------------------- chatd: deliver into an Agents-window session
def chat_batch(store, hosted):
    """{'key', 'ids', 'text'} when the dispatcher is a session chatd holds and something is unread.

    `hosted(session_id)` returns chatd's key for the session, or None (a terminal session)."""
    st = W.dispatcher_status(store.load().get("dispatcher"))
    if not st or not st["active"]:
        return None
    key = hosted(st["session"])
    if not key:
        return None
    items = unread(store.d)
    if not items:
        return None
    return {"key": key, "ids": [n["id"] for n in items], "text": "\n".join(n["text"] for n in items)}


def sweep(store, hosted):
    """Off the chatd loop: write new notifications, then decide what goes to the dispatcher."""
    scan(store)
    return chat_batch(store, hosted)


def poll(host):
    """On the chatd loop: send what a sweep decided. Only a message that was accepted is marked read."""
    out, host._wake_out = host._wake_out, []
    for b in out:
        try:
            host.send({"session": b["key"], "message_id": "wake-" + uuid.uuid4().hex,
                       "text": b["text"]}, None)
        except Exception:
            continue
        mark_read(host.d, b["ids"], "chatd", via="chatd")
