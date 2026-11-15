# -*- coding: utf-8 -*-
"""Talking to the running chatd from outside the app window: `dispatch agent`, the phone service,
another Mac through `dispatch --host` over ssh. chatd.json names the door (port + token) while the
chatd that wrote it is alive. No door (or one nobody answers at): `connect` starts the resident
chatd once (`dispatch chatd install`, launchctl kickstart) and tries again.

    with ChatClient.connect(DISPATCH_DIR) as c:
        opened = c.request("open", agent="claude-code", cwd=cwd)
        c.request("send", session=opened["session"], message_id=c.new_id(), text="…")
        done = c.wait(lambda e: e["ev"] == "turn_done" and e.get("session") == opened["session"], timeout=600)

Every chatd event reaches every client; `request` keeps the one with its request_id, `wait` and
`events` see the rest in order.
"""
import collections
import json
import socket
import time
import uuid


class NotRunning(Exception):
    """Dispatch is not open on this Mac (or its chatd has no door)."""


NOT_RUNNING = "chatd is not running on this computer. Run `dispatch chatd install`, or open Dispatch and try again."


class ChatError(Exception):
    def __init__(self, event):
        super().__init__(event.get("message") or event.get("code") or "chatd error")
        self.code = event.get("code", "")
        self.event = event


def door(dispatch_dir):
    """{port, token} of the running chatd, or None."""
    import chatd
    reg = chatd.read_registry(dispatch_dir)
    d = (reg or {}).get("door")
    if not isinstance(d, dict) or not isinstance(d.get("port"), int) or not d.get("token"):
        return None
    return d


def start_resident(dispatch_dir):
    """Kickstart the chatd LaunchAgent (chatd_service) and wait for its door. False when it is not
    installed or did not come up."""
    try:
        import chatd_service
        return bool(chatd_service.ensure_running(dispatch_dir))
    except Exception:
        return False


class ChatClient:
    def __init__(self, sock):
        self.sock = sock
        self.buf = b""
        self.backlog = collections.deque()  # events read while looking for something else

    @classmethod
    def connect(cls, dispatch_dir, timeout=5.0, autostart=True):
        try:
            return cls._connect(dispatch_dir, timeout)
        except NotRunning:
            if not autostart or not start_resident(dispatch_dir):
                raise
        return cls._connect(dispatch_dir, timeout)

    @classmethod
    def _connect(cls, dispatch_dir, timeout):
        d = door(dispatch_dir)
        if d is None:
            raise NotRunning(NOT_RUNNING)
        try:
            sock = socket.create_connection(("127.0.0.1", d["port"]), timeout=timeout)
            sock.sendall((json.dumps({"token": d["token"]}) + "\n").encode("utf-8"))
        except OSError as e:
            raise NotRunning(f"{NOT_RUNNING}（{e}）")
        return cls(sock)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass

    @staticmethod
    def new_id():
        return uuid.uuid4().hex

    def send(self, cmd, **fields):
        line = json.dumps({"cmd": cmd, **fields}, ensure_ascii=False, separators=(",", ":"))
        try:
            self.sock.sendall((line + "\n").encode("utf-8"))
        except OSError as e:
            raise NotRunning(f"{NOT_RUNNING}（{e}）")

    def _read(self, deadline):
        """The next event from the socket, or None when the deadline passes."""
        while b"\n" not in self.buf:
            left = deadline - time.time()
            if left <= 0:
                return None
            self.sock.settimeout(min(left, 1.0))
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                continue
            except OSError as e:
                raise NotRunning(f"{NOT_RUNNING}（{e}）")
            if not chunk:
                raise NotRunning("Dispatch closed, ending the in-app conversation.")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        try:
            return json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            return {}

    def events(self, timeout):
        """Every event until `timeout` seconds pass (backlog first)."""
        deadline = time.time() + timeout
        while True:
            if self.backlog:
                yield self.backlog.popleft()
                continue
            e = self._read(deadline)
            if e is None:
                return
            if e:
                yield e

    def wait(self, match, timeout):
        """The first event `match` accepts, or None after `timeout` seconds. Others stay in the
        backlog in order."""
        deadline = time.time() + timeout
        kept = collections.deque()
        found = None
        while found is None:
            if self.backlog:
                e = self.backlog.popleft()
            else:
                e = self._read(deadline)
                if e is None:
                    break
            if e and match(e):
                found = e
            elif e:
                kept.append(e)
        self.backlog = kept + self.backlog
        return found

    def request(self, cmd, timeout=60.0, **fields):
        """Send `cmd` with a fresh request_id and return its one reply; an `error` reply raises."""
        rid = "cli-" + self.new_id()
        self.send(cmd, request_id=rid, **fields)
        e = self.wait(lambda e: e.get("request_id") == rid, timeout)
        if e is None:
            raise ChatError({"code": "timeout", "message": f"chatd did not respond to {cmd} within {int(timeout)} seconds"})
        if e.get("ev") == "error":
            raise ChatError(e)
        return e

