# -*- coding: utf-8 -*-
"""`dispatch chatd install|uninstall|status|run`: chatd as a LaunchAgent, so `dispatch agent start`
(派活) and the phone's replies work with no window open (design/copilot-app §8.4, §8.5 B).

  install     write ~/Library/LaunchAgents/<label>.plist and load it (starts at login, KeepAlive)
  uninstall   unload it and remove the plist
  status      installed / loaded / pid, and who holds the door (chatd.json)
  run         what launchd runs: chatd with no app on stdin; clients come in through the door

`dispatch chatd` with no argument (a window speaking JSON lines on stdin/stdout) attaches to the
resident chatd when it is installed (`attach`): one chatd per Mac, the window is one more door client.

The door file (~/tasks/.dispatch/chatd.json) is the same one the app's chatd writes, so clients
(chat_client.py) do not care which chatd answers. While a window's own chatd holds the door (`dispatch chatd`
with the window on its stdin), `run` waits and takes over once that one is gone. A `chatd run` that launchd
does not manage (a "stray": `dispatch chatd ensure` started one before the LaunchAgent was there, or an
older Dispatch IDE's CLI did) never goes by itself, so the resident one stops it and takes the door
(task-0mwh: one from an older version held it for four days and every session ran the old code). SIGTERM
(launchctl bootout, logout) closes the sessions the way quitting the app does.
"""
import json
from lang import t as _t
import os
import signal
import subprocess
import sys
import threading
import time

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import launchd  # noqa: E402
import launchd_labels  # noqa: E402

HOME = os.path.expanduser("~")
LABEL = launchd_labels.label("chatd")
THROTTLE = 2          # launchd restarts a dead chatd after this many seconds
STANDBY_POLL = 2.0    # while another chatd holds the door: how often `run` looks again
START_WAIT = 10.0     # install / a client's kickstart: how long to wait for the door
STRAY_WAIT = 20.0     # a stray chatd closing its sessions after SIGTERM, before it is killed
# events worth a line in chatd.log (the rest, deltas and tool rows, would flood it)
LOGGED = ("chatd", "opened", "closed", "turn_done", "error", "permission_request")


def dispatch_dir():
    return os.environ.get("DISPATCH_DIR") or os.path.join(HOME, "tasks", ".dispatch")


def log_path():
    return os.path.join(dispatch_dir(), "chatd.log")


def plist():
    """The LaunchAgent: `dispatch chatd run` from this CLI, restarted THROTTLE s after it exits."""
    env = {"BEADS_DIR": os.environ.get("BEADS_DIR") or os.path.join(HOME, "tasks", ".beads"),
           "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8", "LANG": os.environ.get("LANG") or "en_US.UTF-8"}
    # the job's own label is worked out from these (launchd_labels): without them a test instance's chatd
    # would take itself for the person's dev.dispatch.chatd
    for k in ("DISPATCH_DIR", "DISPATCH_LAUNCHD_PREFIX", "DISPATCH_E2E_INSTANCE"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return launchd.plist_body(LABEL, [sys.executable, os.path.join(HERE, "dispatch.py"), "chatd", "run"], log_path(),
                              env=env, keep_alive=True, throttle=THROTTLE)


# ---- who holds the door --------------------------------------------------------------------------

def _is_chatd(pid):
    """A live process that is a chatd (a dead chatd's pid may belong to something else by now)."""
    try:
        out = subprocess.run(["ps", "-o", "command=", "-p", str(int(pid))], capture_output=True, text=True, timeout=5).stdout
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
        return False
    return "chatd" in out


def _proc(pid):
    """(ppid, command line) of a live process, or None."""
    try:
        out = subprocess.run(["ps", "-o", "ppid=,command=", "-p", str(int(pid))], capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
        return None
    ppid, _, cmd = out.partition(" ")
    return (int(ppid), cmd.strip()) if ppid.isdigit() else None


def is_stray(pid, job_pid=None):
    """A chatd nothing manages: `chatd run` that is not the LaunchAgent's own process, or any chatd whose
    parent is gone. A window's chatd (`dispatch chatd`, the window on its stdin) is not one: it ends with
    its window."""
    if not pid or pid == job_pid:
        return False
    p = _proc(pid)
    if not p or "chatd" not in p[1]:
        return False
    ppid, cmd = p
    return cmd.rstrip().endswith(" chatd run") or ppid == 1


def stop_stray(pid, wait=STRAY_WAIT, log=None):
    """SIGTERM a stray chatd (it closes its sessions the way quitting the app does), SIGKILL it when it is still
    there after `wait` seconds. True once it is gone."""
    log = log or (lambda m: None)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    except OSError as e:
        log("chatd %d: cannot stop it (%s)" % (pid, e))
        return False
    end = time.time() + wait
    while time.time() < end:
        if not _is_chatd(pid):
            return True
        time.sleep(0.25)
    log("chatd %d did not quit in %d s; killing it" % (pid, wait))
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return True
    time.sleep(0.5)
    return not _is_chatd(pid)


def door_owner(d=None):
    """The pid of the chatd behind chatd.json, or None when there is none running."""
    import chatd
    reg = chatd.read_registry(d or dispatch_dir())
    pid = (reg or {}).get("pid")
    return pid if isinstance(pid, int) and _is_chatd(pid) else None


def door_open(d=None):
    import chat_client
    return chat_client.door(d or dispatch_dir()) is not None and door_owner(d) is not None


# ---- launchd -------------------------------------------------------------------------------------

def status():
    """door: "launchd" (the resident one holds it), "stray" (a chatd nothing manages: the resident one, when
    it runs, stops it and takes over), "other" (a window's own chatd), "" (nobody)."""
    job = launchd.info(LABEL)
    owner = door_owner()
    door = "launchd" if owner and owner == job["pid"] else "stray" if owner and is_stray(owner, job["pid"]) else "other" if owner else ""
    code = ((_registry() or {}).get("code") or {}) if owner else {}
    return {"label": LABEL, "plist": launchd.plist_path(LABEL), "installed": launchd.installed(LABEL),
            "loaded": job["loaded"], "pid": job["pid"], "door_pid": owner, "door": door,
            "door_cli": code.get("cli", "") if isinstance(code, dict) else "", "log": log_path()}


def _registry(d=None):
    import chatd
    return chatd.read_registry(d or dispatch_dir())


def wait_door(timeout=START_WAIT, d=None):
    end = time.time() + timeout
    while time.time() < end:
        if door_open(d):
            return True
        time.sleep(0.25)
    return door_open(d)


def install():
    if sys.platform != "darwin":
        raise SystemExit(_t("The resident chat service exists for macOS only (launchd)", "chatd 常驻服务只有 macOS 版（launchd）"))
    launchd.private_log(log_path())
    launchd.install(plist())  # stops the LaunchAgent's previous process; the new one stops a stray holding the door
    end = time.time() + START_WAIT + STRAY_WAIT
    st = status()
    while time.time() < end and not (st["pid"] and st["door"] == "launchd"):
        time.sleep(0.25)
        st = status()
    return st


def uninstall():
    launchd.uninstall(LABEL)
    return dict(status(), installed=False)


def ensure_running(d=None):
    """chat_client's fallback when there is no door: start the LaunchAgent if it is installed (load
    it first when it is not) and wait for the door. False when it is not installed or does not come up."""
    if sys.platform != "darwin" or not launchd.installed(LABEL):
        return False
    if not launchd.loaded(LABEL):
        launchd.load(launchd.plist_path(LABEL))
    launchd.kickstart(LABEL)
    return wait_door(START_WAIT, d)


# ---- run (under launchd) -------------------------------------------------------------------------

def _log(msg):
    print("[%s] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg), file=sys.stderr, flush=True)


def _event_log(line):
    """The event lines chatd.log keeps: one short line per session lifecycle event."""
    try:
        e = json.loads(line)
    except ValueError:
        return
    if not isinstance(e, dict) or e.get("ev") not in LOGGED:
        return
    bits = [str(e.get("ev"))] + ["%s=%s" % (k, e[k]) for k in ("session", "state", "reason", "code", "message", "pid") if e.get(k) not in (None, "")]
    _log(" ".join(bits)[:300])


def run(stop=None, poll=STANDBY_POLL, d=None):
    """chatd with no app window: its only clients come in through the door. Waits while another
    chatd holds the door; returns when `stop` is set (SIGTERM / SIGINT)."""
    stop = stop or threading.Event()
    previous = {}
    if threading.current_thread() is threading.main_thread():
        def on_signal(signum, _frame):
            _log("signal %d: closing the sessions" % signum)  # chatd's own `down` line then says "stdin closed"
            stop.set()
        for sig in (signal.SIGTERM, signal.SIGINT):
            previous[sig] = signal.signal(sig, on_signal)
    try:
        return _run(stop, poll, d)
    finally:
        # a run that returned leaves the process as it found it: the handler kept swallowing SIGTERM and Ctrl-C
        # in the process that called it (the test suite went on after a SIGTERM, 10-07)
        for sig, old in previous.items():
            signal.signal(sig, old)


def _run(stop, poll, d):
    import chatd
    resident = launchd.info(LABEL)["pid"] == os.getpid()  # the LaunchAgent's own process, not one `ensure` started
    _log("chatd %s pid %d" % ("(launchd)" if resident else "run, not under launchd,", os.getpid()))
    waited = None
    while not stop.is_set():
        other = door_owner()
        if not other or other == os.getpid():
            break
        if resident and is_stray(other, os.getpid()):
            cli = ((_registry() or {}).get("code") or {}).get("cli", "?")
            _log("chatd %d holds the door but nothing manages it (code in %s); stopping it and taking over" % (other, cli))
            stop_stray(other, log=_log)
            continue
        if other != waited:
            _log("chatd %d (a Dispatch window's own) holds the door; waiting for it to quit" % other)
            waited = other
        stop.wait(poll)
    if stop.is_set():
        return 0

    def lines():  # stdin of the app's chatd: here nothing arrives, and the end is the stop signal
        stop.wait()
        return
        yield  # noqa: unreachable, makes this a generator

    return chatd.serve(read=lines(), write=_event_log, d=d, doctor=True)


# ---- attach: a stdin/stdout window on the resident chatd ----------------------------------------

def attach(read=None, write=None, d=None):
    """`dispatch chatd` when the LaunchAgent is installed: relay the window's JSON lines to the
    resident chatd's door and its events back, instead of starting a second chatd. None when there
    is nothing to attach to (not installed, or it did not come up): the caller serves itself.
    `shutdown` from the window only ends the relay, the resident chatd and its sessions stay.
    Exit 1 when the resident chatd goes away, so a supervising window starts us again."""
    import chat_client
    d = d or dispatch_dir()
    if not launchd.installed(LABEL):
        return None
    try:
        c = chat_client.ChatClient.connect(d)
    except chat_client.NotRunning:
        return None
    read = sys.stdin if read is None else read
    write = write or (lambda line: (sys.stdout.write(line + "\n"), sys.stdout.flush()))
    lock = threading.Lock()

    def out(obj):
        with lock:
            write(json.dumps(obj, ensure_ascii=False))

    out({"ev": "chatd", "state": "up", "pid": door_owner(d), "attached": True, "seq": 0, "ts": round(time.time(), 3)})
    gone, closing = threading.Event(), threading.Event()

    def pump():
        try:
            while True:
                for e in c.events(3600):
                    out(e)
        except (chat_client.NotRunning, OSError):
            if not closing.is_set():
                gone.set()

    threading.Thread(target=pump, daemon=True).start()
    try:
        for raw in read:
            if gone.is_set():
                break
            try:
                obj = json.loads(raw)
            except ValueError:
                obj = None
            if isinstance(obj, dict) and obj.get("cmd") == "shutdown":
                break
            if isinstance(obj, dict):
                c.send(obj.get("cmd", ""), **{k: v for k, v in obj.items() if k != "cmd"})
    except chat_client.NotRunning:
        gone.set()
    finally:
        closing.set()
        c.close()
    if gone.is_set():
        out({"ev": "chatd", "state": "down", "reason": "resident chatd went away", "seq": 0, "ts": round(time.time(), 3)})
        return 1
    return 0


# ---- command line --------------------------------------------------------------------------------

def _text(op, r):
    if op == "uninstall":
        return _t("The resident chat service is uninstalled", "chatd 常驻服务已卸载")
    if not r["installed"]:
        return _t("The resident chat service is not installed (`dispatch chatd install`)", "chatd 常驻服务没装（`dispatch chatd install`）") + (_t("; Dispatch's chatd runs (process %d)", "；Dispatch 的 chatd 在跑（进程 %d）") % r["door_pid"] if r["door_pid"] else "")
    head = _t("Resident chat service: %s", "chatd 常驻服务：%s") % (_t("running, process %d", "在跑，进程 %d") % r["pid"] if r["pid"] else _t("installed, not running", "已装，没在跑") if r["loaded"] else _t("installed, not loaded", "已装，没加载"))
    if r["door"] == "stray":
        head += _t("; the door is held by a chatd nobody manages (process %d, code in %s), so sessions run that code; "
                   "`dispatch doctor --fix` stops it and the resident service takes over",
                   "；门在一个没人管的 chatd 手里（进程 %d，代码在 %s），会话跑的是它那份代码；"
                   "`dispatch doctor --fix` 停掉它，常驻服务接手") % (r["door_pid"], r.get("door_cli") or "?")
    elif r["door"] == "other":
        head += _t("; the door is held by the Dispatch window's own chatd (process %d); the resident service takes over when it quits", "；门现在在 Dispatch 窗口自己的 chatd 手里（进程 %d），它退出后常驻服务接手") % r["door_pid"]
    return head + _t(" (%s, log %s)", "（%s，日志 %s）") % (r["label"], r["log"])


def ensure(base):
    """`dispatch chatd ensure` (the window's board watch): one chatd per Dispatch data folder. The installed resident
    service is started when it is there, never a second chatd beside it: one started here is a "stray" nothing
    manages, which used to hold the door for days while the resident one, with newer code, waited (task-0mwh)."""
    import fcntl
    import chatd
    os.makedirs(base, exist_ok=True)
    with open(os.path.join(base, "chatd-ensure.lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if chatd.read_registry(base):
            return
        if launchd.installed(LABEL) and sys.platform == "darwin":
            if ensure_running(base):
                return
            raise RuntimeError("Dispatch's background service did not start (see %s)" % os.path.join(base, "chatd.log"))
        with open(os.path.join(base, "chatd.log"), "a") as log:
            child = subprocess.Popen([sys.executable, os.path.join(HERE, "dispatch.py"), "chatd", "run"],
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
                                     env=dict(os.environ, DISPATCH_DIR=base, PYTHONDONTWRITEBYTECODE="1"))
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if chatd.read_registry(base):
                return
            if child.poll() is not None:
                raise RuntimeError("Dispatch's background service failed to start")
            time.sleep(.1)
        raise RuntimeError("Dispatch's background service took too long to start")


def main(a):
    op = getattr(a, "op", "") or ""
    if op == "run":
        return run()
    if op == "ensure":
        import dispatch
        ensure(dispatch.DISPATCH_DIR)
        return 0
    r = install() if op == "install" else uninstall() if op == "uninstall" else status()
    if getattr(a, "json", False):
        print(json.dumps(r, ensure_ascii=False))
    else:
        print(_text(op, r))
    return 0 if op != "install" or r["pid"] else 1
