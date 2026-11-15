# -*- coding: utf-8 -*-
"""`dispatch ide show <path | URL> [--session S] [--task T]`: open a deliverable in the right panel of the
running Dispatch Agent (the Agents window of Dispatch IDE).

The channel is a folder of request files, <DISPATCH_DIR>/ide/requests/:

  * dispatch-bridge, in the Agents window, keeps <DISPATCH_DIR>/ide/agents-window.json fresh
    ({pid, at}, every few seconds) and watches the folder;
  * this command writes `<id>.json` = {id, target, session, task, at} (atomically), then waits a few
    seconds for `<id>.done` = {ok, error?} that the bridge writes once the tab is open;
  * no fresh agents-window.json, or no answer in time: the request is taken back and the path is
    printed instead. Nothing else is opened (no system browser, no `open`).

The bridge hands the target to the workbench's `dispatch.docs.open` (Dispatch IDE
patches/435-docs.patch): the right panel switches to its Docs tab, the tab flashes, and a
Markdown or HTML file opens in the tab's reader in place ("‹ Docs" goes back to the list; the second
line says "Delivered just now for <task>" when --task is given). A URL opens in the integrated
browser, an image in the image preview. The keyboard focus stays in the chat input.
"""
import json, os, time, uuid

FRESH_S = 15
ACK_WAIT_S = 10.0
STALE_S = 60


def dispatch_dir():
    return os.environ.get("DISPATCH_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".dispatch")


def ide_dir(*parts):
    return os.path.join(dispatch_dir(), "ide", *parts)


def requests_dir():
    return ide_dir("requests")


def alive_path():
    return ide_dir("agents-window.json")


def _pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except PermissionError:
        return True
    except (OSError, ValueError, TypeError):
        return False


def agents_window(now=None):
    """The running Agents window's heartbeat {pid, at}, or None when it is not there or stale."""
    try:
        with open(alive_path(), encoding="utf-8") as f:
            rec = json.load(f)
    except (OSError, ValueError):
        return None
    now = now or time.time()
    if not isinstance(rec, dict) or now - float(rec.get("at") or 0) > FRESH_S or not _pid_alive(rec.get("pid")):
        return None
    return rec


def resolve_target(target):
    """(kind, value): ("url", "https://…") or ("path", absolute path that exists)."""
    t = (target or "").strip()
    if not t:
        raise ValueError("dispatch ide show <path or URL>")
    low = t.lower()
    if low.startswith(("http://", "https://")):
        return "url", t
    if low.startswith("file://"):
        from urllib.parse import unquote, urlparse
        t = unquote(urlparse(t).path)
    p = os.path.abspath(os.path.expanduser(t))
    if not os.path.exists(p):
        raise ValueError(f"no such file: {p}")
    return "path", p


def session_resource(session):
    """The Agents window's resource for a session (any form `dispatch` takes), "" when unknown."""
    s = (session or "").strip()
    if not s:
        return ""
    try:
        import ide_sessions
        hit = ide_sessions.find(s)
        if hit:
            return hit[2]["uri"]
    except Exception:
        pass
    return s if ":/" in s else ""


def _write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def _sweep(now):
    """Leftovers of requests nobody took (older than STALE_S) go."""
    d = requests_dir()
    for n in os.listdir(d) if os.path.isdir(d) else []:
        p = os.path.join(d, n)
        try:
            if now - os.path.getmtime(p) > STALE_S:
                os.remove(p)
        except OSError:
            pass


TURBO_NOTE = ("A Turbo part works in a copy of the project that goes away when the run ends, so nothing opens in the person's "
              "window (it would be left there pointing at nothing): {value}")


def turbo_part():
    """The Turbo run this command runs in, when an agent of a Turbo part or final step runs it (turbo.py sets
    DISPATCH_TURBO_RUN for them), else ''. Such an agent works unseen in a copy that Turbo deletes at the end: it must
    not put pages into the person's right panel (task-aqu6u: two "Todo List" tabs left pointing at a deleted copy)."""
    return os.environ.get("DISPATCH_TURBO_RUN", "")


def show(target, session="", wait=ACK_WAIT_S, sleep=time.sleep, task="", delivery=""):
    """Ask the Agents window to open `target`. Always returns a dict: `shown` says whether it did;
    `message` is the line to print. `delivery` (impl | proposal) marks a delivery page of `task`
    (`dispatch deliver`): the bridge serves its folder on 127.0.0.1 and opens it from there, so the
    page's Choose A / B can record the pick for that task and nothing else."""
    kind, value = resolve_target(target)
    base = {"ok": True, "target": value, "kind": kind}
    now = time.time()
    if turbo_part():
        return dict(base, shown=False, reason="turbo", message=TURBO_NOTE.format(value=value))
    if not agents_window(now):
        return dict(base, shown=False, reason="not_running", message=f"Dispatch Agent is not open. {value}")
    _sweep(now)
    rid = uuid.uuid4().hex[:12]
    req = os.path.join(requests_dir(), rid + ".json")
    done = os.path.join(requests_dir(), rid + ".done")
    # task: the Docs reader's "Delivered … for <task>"; delivery: a delivery page of that task
    rec = {"id": rid, "target": value, "kind": kind, "session": session_resource(session), "task": (task or "").strip(), "at": now}
    if delivery and kind == "path":
        rec["delivery"] = delivery
    _write(req, rec)
    deadline = time.time() + wait
    while time.time() < deadline:
        if os.path.exists(done):
            try:
                with open(done, encoding="utf-8") as f:
                    ack = json.load(f)
            except (OSError, ValueError):
                ack = {"ok": False, "error": "unreadable answer"}
            try:
                os.remove(done)
            except OSError:
                pass
            if ack.get("ok"):
                return dict(base, shown=True, message=f"Opened in Dispatch Agent: {value}")
            return dict(base, shown=False, reason="failed", error=ack.get("error") or "", message=f"Dispatch Agent could not open it ({ack.get('error') or 'unknown'}). {value}")
        sleep(0.1)
    # nobody took it: take it back so it does not pop up later
    try:
        os.remove(req)
    except OSError:
        pass
    return dict(base, shown=False, reason="no_answer", message=f"Dispatch Agent did not answer. {value}")
