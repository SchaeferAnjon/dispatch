# -*- coding: utf-8 -*-
"""Asking the board service in chatd (board_service.py) instead of starting bd.

`call(argv, env, timeout)` returns (code, stdout, stderr) like running `bd argv` would, or None when
the caller should run bd itself: no chatd on this Mac, a chatd without the service (an older one),
a chatd serving another board, `DISPATCH_BOARD_SERVICE=0`, or a command for another database.

One connection per process, opened on the first call and kept. When the connection breaks:
  a read   is simply run with bd here;
  a write  that the service had not started yet is run with bd here (it was never applied, so
           nothing is done twice); one it had started may or may not be saved: the caller gets a
           failure that says so instead of a guess (no write is ever confirmed without being saved).
"""
import json
import os
import socket
import threading
import time

PASS_ENV = ("BEADS_", "BD_")
CONNECT_TIMEOUT = 2.0
EXTRA_WAIT = 600.0   # a write waits its turn in the queue on top of bd's own time limit

RETRY_AFTER = 15.0   # after the service could not be reached, bd runs here this long before it is asked again
_state = {"conn": None, "off_until": 0.0}
_lock = threading.Lock()

UNSURE = ("The task board service stopped while saving this change, so it may or may not be saved. "
          "Look at the task (dispatch show) before doing it again.")


class _Conn:
    def __init__(self, sock):
        self.sock = sock
        self.buf = b""
        self.n = 0

    def send(self, obj):
        self.sock.sendall((json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))

    def read(self, deadline):
        while b"\n" not in self.buf:
            left = deadline - time.time()
            if left <= 0:
                raise TimeoutError("the board service did not answer in time")
            self.sock.settimeout(min(left, 5.0))
            try:
                chunk = self.sock.recv(1 << 20)
            except socket.timeout:
                continue
            if not chunk:
                raise ConnectionError("the board service closed the connection")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return json.loads(line.decode("utf-8", "replace"))

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def _registry(dispatch_dir):
    try:
        with open(os.path.join(dispatch_dir, "chatd.json"), encoding="utf-8") as f:
            reg = json.load(f)
    except (OSError, ValueError):
        return None
    return reg if isinstance(reg, dict) else None


def _pid_alive(pid):
    import dplatform  # not os.kill(pid, 0): on Windows that is not a probe
    return dplatform.pid_alive(pid)


def _beads_dir(env, default=None):
    b = (env or {}).get("BEADS_DIR") or default or os.environ.get("BEADS_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".beads")
    return os.path.realpath(b)


def _dispatch_dir(default=None):
    return default or os.environ.get("DISPATCH_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".dispatch")


def _connect(env, dispatch_dir=None, beads_dir=None):
    """A connection to this Mac's board service for the board `env` names, or None."""
    reg = _registry(_dispatch_dir(dispatch_dir))
    if not reg or not _pid_alive(reg.get("pid")):
        return None
    board, door = reg.get("board"), reg.get("door")
    if not isinstance(board, dict) or not board.get("ready") or not isinstance(door, dict):
        return None
    if os.path.realpath(str(board.get("beads_dir") or "")) != _beads_dir(env, beads_dir):
        return None
    try:
        sock = socket.create_connection(("127.0.0.1", int(door["port"])), timeout=CONNECT_TIMEOUT)
        c = _Conn(sock)
        c.send({"token": door.get("token", ""), "board": 1})
        return c
    except (OSError, ValueError, KeyError, TypeError):
        return None


def enabled():
    return os.environ.get("DISPATCH_BOARD_SERVICE", "1") not in ("0", "off", "no")


def call(argv, env=None, timeout=20, dispatch_dir=None, beads_dir=None):
    """(code, stdout, stderr) from the board service, or None: run bd yourself. `dispatch_dir` /
    `beads_dir`: the caller's (dispatch.py's DISPATCH_DIR and BEADS_DIR)."""
    if not enabled():
        return None
    import board_service
    op = board_service.classify(argv)
    if op is None:
        return None
    svc = board_service.local()
    if svc is not None:  # inside chatd itself
        if os.path.realpath(svc.beads_dir) != _beads_dir(env, beads_dir):
            return None
        try:
            code, out, err, _via = svc.bd(argv, _pass_env(env), timeout)
            return code, out, err
        except (ValueError, RuntimeError):
            return None
    with _lock:
        return _call_door(argv, env, timeout, op, dispatch_dir, beads_dir)


def _pass_env(env):
    merged = dict(os.environ)
    merged.update(env or {})
    return {k: v for k, v in merged.items() if k.startswith(PASS_ENV) and k != "BEADS_DIR"}


def _call_door(argv, env, timeout, op, dispatch_dir=None, beads_dir=None):
    if time.time() < _state["off_until"]:
        return None
    for attempt in (1, 2):
        c = _state["conn"]
        if c is None:
            c = _connect(env, dispatch_dir, beads_dir)
            if c is None:
                # not now: bd here for a while, then the service again. A process that lives long (each
                # Agent's MCP server, chatd's helpers) used to run bd itself for good after one chatd restart
                _state["off_until"] = time.time() + RETRY_AFTER
                return None
            _state["conn"] = c
        c.n += 1
        rid = "b%d" % c.n
        started = False
        try:
            c.send({"cmd": "board.bd", "rid": rid, "argv": list(argv), "env": _pass_env(env), "timeout": timeout})
            deadline = time.time() + timeout + (EXTRA_WAIT if op.kind == "write" else 120)
            while True:
                msg = c.read(deadline)
                if msg.get("rid") != rid:
                    continue
                if msg.get("state") == "running":
                    started = True
                    continue
                if "code" in msg and "stdout" in msg:
                    return int(msg["code"]), msg.get("stdout") or "", msg.get("stderr") or ""
                # refused (another database, stopping): bd here
                return None
        except (OSError, ConnectionError, TimeoutError, ValueError):
            c.close()
            _state["conn"] = None
            if op.kind == "write" and started:
                return 75, "", UNSURE
            if attempt == 2:
                _state["off_until"] = time.time() + RETRY_AFTER
                return None
            # chatd went away before touching it (or between two calls): one fresh connection, else bd here
            continue
    return None


def reset():
    """Forget the connection (tests, or after chatd restarted)."""
    with _lock:
        if _state["conn"] is not None:
            _state["conn"].close()
        _state.update(conn=None, off_until=0.0)


def ask(cmd, dispatch_dir=None, beads_dir=None, timeout=10.0):
    """One board.* command (stats, refresh, hello) to the service; None when there is none."""
    c = _connect({}, dispatch_dir, beads_dir)
    if c is None:
        return None
    try:
        c.send({"cmd": cmd, "rid": "q"})
        deadline = time.time() + timeout
        while True:
            msg = c.read(deadline)
            if msg.get("rid") == "q":
                return msg
    except (OSError, ConnectionError, TimeoutError, ValueError):
        return None
    finally:
        c.close()


def command(a):
    """`dispatch board [status|stats|refresh] [--json]`."""
    op = getattr(a, "op", None) or "status"
    msg = ask({"status": "board.stats", "stats": "board.stats", "refresh": "board.refresh"}[op])
    if msg is None:
        r = {"ok": True, "running": False, "message": "No board service: chatd is not running on this Mac, so every command opens the board itself."}
    elif op == "refresh":
        r = {"ok": True, "running": True, "message": "The board service will read everything again."}
    else:
        r = {"ok": True, "running": True, "stats": msg.get("stats") or {}}
    if getattr(a, "json", False):
        print(json.dumps(r, ensure_ascii=False, indent=1))
        return 0
    if not r["running"] or op == "refresh":
        print(r["message"])
        return 0
    s = r["stats"]
    served = s.get("reads_memory", 0) + s.get("reads_shared", 0)
    print("Board service: running in chatd (%s board, %s at once)" % (s.get("mode"), "one bd" if s.get("lanes") == 1 else "%s bd" % s.get("lanes")))
    print("  reads answered from memory: %d, by bd: %d" % (served, s.get("reads_run", 0)))
    print("  writes: %d (failed %d), waiting now: %d, most waiting at once: %d, median %s ms" % (
        s.get("writes", 0), s.get("writes_failed", 0), s.get("queue", 0), s.get("max_queue", 0), s.get("write_ms_median")))
    print("  bd processes started: %d, change events sent: %d, cached answers: %d (%s MB)" % (
        s.get("bd_started", 0), s.get("events", 0), s.get("cached", 0), s.get("cache_mb")))
    snaps = s.get("snapshots") or {}
    print("  whole board in memory: %s; read whole %d times, changed issues read again %d times (%d issues)" % (
        ", ".join("%s %s" % (k, "%d issues" % v if v is not None else "not read yet") for k, v in snaps.items()) or "no",
        s.get("snap_loads", 0), s.get("snap_refreshes", 0), s.get("snap_ids", 0)))
    if s.get("write_wait_ms_median") is not None:
        print("  a write waited for its turn %s ms (median)" % s.get("write_wait_ms_median"))
    for row in (s.get("failed") or [])[-3:]:
        print("  failed: bd %s (%s ms): %s" % (row.get("cmd"), row.get("ms"), " ".join((row.get("error") or "").split())[-160:]))
    return 0
