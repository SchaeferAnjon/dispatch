"""Resident SSH attention subscriptions owned by chatd, one per configured peer.

Only counts cross the connection. A silent healthy stream is valid: waiting watch emits only
changes. SSH keepalives detect broken links. Cache leases let ordinary machines reads retain
the existing poll fallback when chatd, SSH or an old peer cannot provide the stream.
"""
import json
import os
import queue
import selectors
import subprocess
import threading
import time

FIELDS = ("approve", "decide", "unread", "only_you", "total", "shared")
LEASE_SECONDS = 30


def normalize(value):
    if not isinstance(value, dict):
        return None
    if any(type(value.get(k)) is not int or value[k] < 0 for k in FIELDS):
        return None
    if value["total"] != sum(value[k] for k in FIELDS[:4]):
        return None
    at = value.get("as_of")
    if not isinstance(at, (int, float)) or not 0 <= at < float("inf"):
        return None
    return {k: value[k] for k in (*FIELDS, "as_of")}


def cache_path(d, h):
    return d.remote_cache_path(h, ["attention", "watch"])


def read_attention(d, h, stale=False):
    try:
        with open(cache_path(d, h), encoding="utf-8") as f:
            rec = json.load(f)
        if not stale and (not rec.get("connected") or time.time() - rec.get("heartbeat", 0) > LEASE_SECONDS):
            return None
        return normalize(rec.get("attention"))
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def ssh_args(d, h):
    return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=2", h["ssh"],
            f"env {d.remote_beads(h)} {d.remote_cli(h)} waiting watch --json"]


def retry_delay(failures):
    return min(60, 2 ** min(max(0, failures), 6))


class Peer:
    def __init__(self, d, host, events, popen=subprocess.Popen):
        self.d, self.host, self.events, self.popen = d, dict(host), events, popen
        self.stop = threading.Event()
        self.process = None
        self.attention = read_attention(d, host, stale=True)
        self.thread = threading.Thread(target=self.run, daemon=True, name=f"waiting-{host['id']}")

    def save(self, connected):
        dest = cache_path(self.d, self.host)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        tmp = f"{dest}.{os.getpid()}.{threading.get_ident()}.tmp"
        rec = {"attention": self.attention, "connected": connected, "heartbeat": time.time()}
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(rec, f)
            os.replace(tmp, dest)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def accept(self, line):
        try:
            att = normalize(json.loads(line))
        except (ValueError, UnicodeError):
            return False
        if att is None:
            return False
        self.attention = att
        self.save(True)
        self.events.put({"host": self.host["id"], "attention": att, "online": True})
        return True

    def stream(self):
        child = self.popen(ssh_args(self.d, self.host), stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.process = child
        buf, received, pulse = b"", False, 0.0
        started = time.monotonic()
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                while not self.stop.is_set():
                    if selector.select(1):
                        chunk = os.read(child.stdout.fileno(), 65536)
                        if not chunk:
                            break
                        buf += chunk
                        if len(buf) > 1024 * 1024:
                            break
                        while b"\n" in buf:
                            line, buf = buf.split(b"\n", 1)
                            received = self.accept(line) or received
                    now = time.monotonic()
                    if not received and now - started > 30:
                        break  # a login shell or old CLI that never starts the protocol
                    if received and now - pulse >= 10:
                        self.save(True)
                        pulse = now
                    if child.poll() is not None:
                        break
        finally:
            self.terminate()
            child.stdout.close()
            self.process = None
        return received and time.monotonic() - started >= 30

    def terminate(self):
        child = self.process
        if child is not None and child.poll() is None:
            self.d.debug("machines.watch.stop", f"SIGTERM pid={child.pid}")
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass

    def run(self):
        failures = 0
        while not self.stop.is_set():
            try:
                if self.stream():
                    failures = 0
            except (OSError, ValueError) as e:
                self.d.debug("machines.watch", e)
            try:
                self.save(False)
            except OSError as e:
                self.d.debug("machines.watch.cache", e)
            # Do not call a peer offline merely because its CLI does not support watch.
            self.events.put({"host": self.host["id"], "stream": "disconnected"})
            if self.stop.wait(retry_delay(failures)):
                break
            failures += 1

    def close(self):
        self.stop.set()
        self.terminate()


class Watches:
    """Called by chatd's loop. Threads only enqueue; broadcasting stays on its loop thread."""
    def __init__(self, d, emit, factory=Peer):
        self.d, self.emit, self.factory = d, emit, factory
        self.events = queue.Queue()
        self.peers = {}
        self.next_scan = 0

    def tick(self):
        if time.monotonic() >= self.next_scan:
            self.next_scan = time.monotonic() + 30
            try:
                hosts = {h["id"]: h for h in self.d.hosts() if isinstance(h, dict) and h.get("id") and h.get("ssh")}
            except Exception as e:
                self.d.debug("machines.watch.hosts", e)
                hosts = {key: peer.host for key, peer in self.peers.items()}
            for key, peer in list(self.peers.items()):
                if hosts.get(key) != peer.host:
                    peer.close()
                    del self.peers[key]
            for key, host in hosts.items():
                if key not in self.peers:
                    peer = self.factory(self.d, host, self.events)
                    self.peers[key] = peer
                    peer.thread.start()
        while True:
            try:
                self.emit("attention", **self.events.get_nowait())
            except queue.Empty:
                return

    def close(self):
        for peer in self.peers.values():
            peer.close()
