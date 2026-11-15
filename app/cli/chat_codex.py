# -*- coding: utf-8 -*-
"""Codex driver for chatd: one WebSocket connection to the shared `codex app-server` daemon
(~/.codex/app-server-control/app-server-control.sock), every Codex session multiplexed on it by
threadId (design/in-app-chat/spike/README.md sections B and C).

Threads
    CodexHub (module singleton, `hub()`) owns the socket. Its reader thread decodes frames:
    JSON-RPC responses wake the caller waiting in `request()`; notifications and server requests
    go into the inbox of the adapter whose threadId they carry (other threads' traffic, e.g. the
    daemon's title-generation threads, is dropped). Nothing is emitted from the reader thread:
    chatd's loop calls `CodexAdapter.drain()`, which turns the inbox into protocol events.
    When the connection drops, a reconnect thread retries with exponential backoff (1 s to 30 s),
    starting the daemon once per outage, and `thread/resume`s every open thread; the adapter
    then emits `state` from its next `drain()`.

What chatd has to know (P1)
    * A new thread has no key until `thread/start` answers. Construct the adapter with
      `session=None` and set `adapter.rebind = emitter.bound`; `start()` sets `adapter.session`
      to "codex:<thread id>" and re-binds `emit` before `opened`.
    * The adapter emits `opened`, the `state` right after it, `state` after a reconnect and every
      agent-side event (turn_started, deltas, tools, permission_request / _resolved, turn_done,
      diff_updated, rate_limit, closed). `state` carries `queue` from `adapter.queue` (a list chatd
      keeps in sync; empty when chatd does not set it). Replies that are only a `state`
      (set_model, set_permission_mode) are left to chatd.
    * `commands()` returns [{name, description, kind}] from skills/list; chatd emits `commands`.
    * Codex keeps working when Dispatch goes away: `close()` only unsubscribes from the thread.
"""
import base64
import glob
import json
import os
import queue
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import uuid
sys.dont_write_bytecode = True

import chat_protocol as cp
import codex_window

try:
    import dplatform as _P
except Exception:  # the adapter must import even where dplatform is missing (tests, odd bundles)
    _P = None

# ---------------------------------------------------------------- constants from the schema
# design/in-app-chat/spike/codex_schema/codex_app_server_protocol.v2.schemas.json, codex-cli 0.157.0.
# AskForApproval (string arm): "untrusted" | "on-request" | "never"
APPROVAL_POLICIES = ("untrusted", "on-request", "never")
# SandboxMode (thread/start, thread/resume `sandbox`): "read-only" | "workspace-write" | "danger-full-access"
SANDBOX_MODES = ("read-only", "workspace-write", "danger-full-access")
# SandboxPolicy (turn/start `sandboxPolicy`, and the `sandbox` field of thread/start|resume responses)
# is an object tagged by `type`: readOnly | workspaceWrite | dangerFullAccess | externalSandbox.
SANDBOX_POLICY = {"read-only": {"type": "readOnly"}, "workspace-write": {"type": "workspaceWrite"}, "danger-full-access": {"type": "dangerFullAccess"}}
_POLICY_TYPE_MODE = {"readOnly": "read-only", "workspaceWrite": "workspace-write", "dangerFullAccess": "danger-full-access"}
# ApprovalsReviewer: "user" | "auto_review" | "guardian_subagent". The user's config may say
# auto_review; then approvals never reach a client, so Dispatch always asks for "user".
APPROVALS_REVIEWER = "user"
# Claude Code's permission modes (cp.PERMISSION_MODES) → (approvalPolicy, sandbox mode).
MODE_MAP = {
    "default": ("on-request", "workspace-write"),
    "acceptEdits": ("on-request", "workspace-write"),
    "plan": ("untrusted", "read-only"),
    "bypassPermissions": ("never", "danger-full-access"),
}
# CommandExecutionApprovalDecision / FileChangeApprovalDecision (string arms).
DECISION_MAP = {"allow": "accept", "allow_session": "acceptForSession", "deny": "decline"}
# PermissionGrantScope: "turn" | "session" (item/permissions/requestApproval answers).
GRANT_SCOPE = "turn"
# TurnStatus: completed | interrupted | failed | inProgress → cp.TURN_STATUSES.
TURN_STATUS = {"completed": "success", "interrupted": "interrupted", "failed": "error"}
# ThreadItem types shown as tool chips.
TOOL_ITEMS = ("commandExecution", "fileChange", "mcpToolCall", "webSearch", "dynamicToolCall", "collabAgentToolCall")

CAPABILITIES = ("allow_session", "set_model", "set_permission_mode", "effort", "thinking_text", "diff_events", "images_path", "queue", "commands")

RPC_TIMEOUT = 60
BACKOFF_START = 1.0
BACKOFF_MAX = 30.0
_IMAGE_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp"}


def codex_home():
    return os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")


def socket_path():
    return os.path.join(codex_home(), "app-server-control", "app-server-control.sock")


def dispatch_dir():
    return os.environ.get("DISPATCH_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".dispatch")


def _is_win():
    return bool(_P.IS_WIN) if _P is not None else os.name == "nt"


def _search_path():
    """PATH plus where npm-installed CLIs live: the app (Dispatch IDE from the Dock) is not a login
    shell, its PATH has neither ~/.local/bin nor npm's global bin. Same list as `dispatch engines`."""
    import engines
    return engines.search_path()


def _which_codex():
    return shutil.which("codex", path=_search_path())


def _codex_bin():
    return _which_codex() or "codex"


def _run(args, timeout):
    kw = {}
    if _P is not None and hasattr(_P, "no_window_flags"):
        try:
            kw["creationflags"] = _P.no_window_flags()
        except Exception:
            pass
    import net
    # this Mac's proxy (net.py): the shared app-server daemon this starts talks to OpenAI with it
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=net.apply(cp.child_env()), **kw)


def restart_daemon():
    """Stop Codex's shared app-server daemon (after an account switch). A connected hub reconnects, which starts it
    again with the new sign-in and resumes every open thread; without a connection the next session starts it."""
    r = _run([_codex_bin(), "app-server", "daemon", "stop"], 30)
    return r.returncode == 0


# ---------------------------------------------------------------- probe
def probe():
    """{available, version, supported, reason} for `hello`."""
    if _is_win():
        return {"available": bool(_which_codex()), "version": "", "supported": False, "reason": "Windows 版暂不支持应用内聊天"}
    if not _which_codex():
        return {"available": False, "version": "", "supported": False, "reason": "codex not found on PATH"}
    try:
        out = _run([_codex_bin(), "--version"], 15)
        text = (out.stdout or out.stderr or "").strip()
    except Exception as e:
        return {"available": True, "version": "", "supported": False, "reason": f"codex --version failed: {e}"[:200]}
    v = cp.parse_version(text)
    version = ".".join(map(str, v)) if v else text[:40]
    import engines
    minimum = engines.get("codex").chat_min_version
    if not cp.version_ok(v, minimum):
        need = ".".join(map(str, minimum))
        return {"available": True, "version": version, "supported": False, "reason": f"codex {version or '?'} is older than {need}"}
    return {"available": True, "version": version, "supported": True, "reason": ""}


def mode_params(mode):
    """cp permission mode → (approvalPolicy, sandbox mode); unknown → ChatError invalid_model."""
    if mode not in MODE_MAP:
        raise cp.ChatError("invalid_model", f"unknown permission mode {mode!r}")
    return MODE_MAP[mode]


def mode_of(approval_policy, sandbox):
    """The reverse, for `opened.permission_mode`: what the thread actually runs with."""
    if isinstance(sandbox, dict):
        sandbox = _POLICY_TYPE_MODE.get(sandbox.get("type"), "")
    if approval_policy == "never" and sandbox == "danger-full-access":
        return "bypassPermissions"
    if sandbox == "read-only" and approval_policy in ("untrusted", "on-request"):
        return "plan"
    return "default"


# ---------------------------------------------------------------- WebSocket over a unix socket (client side)
class _WS:
    """Minimal RFC 6455 client: masked text frames out, ping answered, fragments joined."""

    def __init__(self, path, timeout=5.0):
        family = getattr(socket, "AF_UNIX", None)
        if family is None:
            raise OSError("unix sockets are not available on this platform")
        self.sock = socket.socket(family, socket.SOCK_STREAM)
        try:
            self._open(path, timeout)
        except BaseException:
            self.sock.close()
            raise
        self.lock = threading.Lock()
        self.closed = False

    def _open(self, path, timeout):
        self.sock.settimeout(timeout)
        self.sock.connect(path)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            d = self.sock.recv(4096)
            if not d:
                raise OSError("daemon closed the connection during the handshake")
            buf += d
            if len(buf) > 65536:
                raise OSError("handshake response too long")
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        status = head.split(b"\r\n", 1)[0]
        if b" 101" not in status:
            raise OSError(f"websocket handshake refused: {status[:80].decode(errors='replace')}")
        self.sock.settimeout(None)

    def send(self, op, payload):
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            hdr = bytes([0x80 | op, 0x80 | n])
        elif n < 65536:
            hdr = bytes([0x80 | op, 0x80 | 126]) + struct.pack(">H", n)
        else:
            hdr = bytes([0x80 | op, 0x80 | 127]) + struct.pack(">Q", n)
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        with self.lock:
            self.sock.sendall(hdr + mask + masked)

    def send_text(self, text):
        self.send(1, text.encode("utf-8"))

    def _need(self, n):
        while len(self.buf) < n:
            d = self.sock.recv(1 << 16)
            if not d:
                raise EOFError
            self.buf += d

    def recv(self):
        """One complete text message, or None once the peer closed."""
        frag = b""
        try:
            while True:
                self._need(2)
                b0, b1 = self.buf[0], self.buf[1]
                n, off = b1 & 0x7F, 2
                if n == 126:
                    self._need(4)
                    n, off = struct.unpack(">H", self.buf[2:4])[0], 4
                elif n == 127:
                    self._need(10)
                    n, off = struct.unpack(">Q", self.buf[2:10])[0], 10
                if b1 & 0x80:  # servers do not mask, but tolerate it
                    self._need(off + 4)
                    mask, off = self.buf[off:off + 4], off + 4
                else:
                    mask = None
                self._need(off + n)
                payload, self.buf = self.buf[off:off + n], self.buf[off + n:]
                if mask:
                    payload = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
                op = b0 & 0x0F
                if op == 9:
                    self.send(10, payload)
                    continue
                if op == 10:
                    continue
                if op == 8:
                    return None
                frag += payload
                if b0 & 0x80:
                    return frag.decode("utf-8", errors="replace")
        except (EOFError, OSError):
            return None

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self.send(8, b"")
        except Exception:
            pass
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


# ---------------------------------------------------------------- the hub
class CodexHub:
    """One connection to the daemon shared by every Codex session in chatd."""

    def __init__(self, path=None, client_version=None, daemon_start=None, rpc_timeout=RPC_TIMEOUT,
                 backoff_start=BACKOFF_START, backoff_max=BACKOFF_MAX):
        self.path = path or socket_path()
        self.client_version = client_version
        self.daemon_start = daemon_start or self._daemon_start
        self.rpc_timeout = rpc_timeout
        self.backoff_start = backoff_start
        self.backoff_max = backoff_max
        self.lock = threading.RLock()      # short sections only: the reader thread takes it too
        self.connect_lock = threading.Lock()
        self.ws = None
        self.gen = 0               # connection generation; permission ids and stale readers use it
        self.user_agent = ""
        self.next_id = 0
        self.waiting = {}          # rpc id → [threading.Event, response, callback or None]
        self.adapters = {}         # thread id → adapter
        self.reconnecting = False
        self.closed = False
        self.connect_retry = 10.0  # seconds of retries after `daemon start`

    # -- connection
    @staticmethod
    def _daemon_start():
        try:
            r = _run([_codex_bin(), "app-server", "daemon", "start"], 30)
            return r.returncode == 0
        except Exception:
            return False

    def connected(self):
        return self.ws is not None and not self.ws.closed

    def ensure(self):
        """Connect if needed (the chatd thread; blocks up to a few seconds). ChatError daemon_down."""
        if self.connected():
            return
        if self.reconnecting:
            raise cp.ChatError("daemon_down", "reconnecting to the codex app-server daemon")
        with self.connect_lock:  # never self.lock here: initialize waits on the reader, which needs it
            if self.connected():
                return
            self._connect_with_start()

    def _connect_with_start(self):
        try:
            self._connect_once()
            return
        except (OSError, cp.ChatError) as e:
            first = e
        self.daemon_start()
        deadline = time.time() + self.connect_retry
        while time.time() < deadline:
            try:
                self._connect_once()
                return
            except (OSError, cp.ChatError):
                time.sleep(0.3)
        raise cp.ChatError("daemon_down", f"codex app-server daemon not reachable at {self.path}: {first}")

    def _connect_once(self):
        ws = _WS(self.path)
        with self.lock:
            self.gen += 1
            gen = self.gen
            self.ws = ws
        threading.Thread(target=self._reader, args=(ws, gen), name="codex-hub-reader", daemon=True).start()
        try:
            version = self.client_version
            if version is None:
                try:
                    import chatd
                    version = chatd.CHATD_VERSION
                except Exception:
                    version = "0"
            r = self.request("initialize", {"clientInfo": {"name": "dispatch", "version": str(version)}}, timeout=15)
            self.user_agent = (r or {}).get("userAgent", "")
            self.notify("initialized")
        except Exception:
            ws.close()
            with self.lock:
                if self.ws is ws:
                    self.ws = None
            raise

    def _reader(self, ws, gen):
        while True:
            text = ws.recv()
            if text is None:
                break
            try:
                msg = json.loads(text)
            except ValueError:
                continue
            if isinstance(msg, dict):
                self._dispatch(msg)
        ws.close()
        self._lost(gen)

    def _lost(self, gen):
        with self.lock:
            if gen != self.gen:
                return
            self.ws = None
            waiting, self.waiting = self.waiting, {}
            adapters = list(self.adapters.values())
            start = bool(adapters) and not self.closed and not self.reconnecting
            if start:
                self.reconnecting = True
        for slot in waiting.values():
            slot[1] = {"error": {"code": -32000, "message": "connection to the codex daemon closed"}, "_lost": True}
            slot[0].set()
            if slot[2]:
                try:
                    slot[2](slot[1])
                except Exception:
                    pass
        for a in adapters:
            a.inbox.put({"method": "_disconnected"})
        if start:
            threading.Thread(target=self._reconnect_loop, name="codex-hub-reconnect", daemon=True).start()

    def _reconnect_loop(self):
        delay = self.backoff_start
        started = False
        try:
            while not self.closed:
                try:
                    self._connect_once()
                    break
                except (OSError, cp.ChatError):
                    if not started:
                        started = True
                        self.daemon_start()
                        continue
                time.sleep(delay)
                delay = min(delay * 2, self.backoff_max)
        finally:
            with self.lock:
                self.reconnecting = False
        if self.closed:
            return
        for tid, a in list(self.adapters.items()):
            params = {"threadId": tid, "excludeTurns": True, "approvalsReviewer": APPROVALS_REVIEWER}
            model = (getattr(a, "options", None) or {}).get("model")
            if model:  # a model changed mid-conversation (`dispatch agent model`) outlives a daemon restart
                params["model"] = model
            if codex_window.thread_config(model):
                params["config"] = codex_window.thread_config(model)
            try:
                r = self.request("thread/resume", params)
                a.inbox.put({"method": "_resumed", "params": r or {}})
            except cp.ChatError as e:
                a.inbox.put({"method": "_resume_failed", "params": {"message": str(e)}})

    def shutdown(self):
        self.closed = True
        ws = self.ws
        if ws:
            ws.close()

    # -- JSON-RPC
    def _send(self, obj):
        ws = self.ws
        if ws is None or ws.closed:
            raise cp.ChatError("daemon_down", "not connected to the codex app-server daemon")
        try:
            ws.send_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
        except OSError as e:
            raise cp.ChatError("daemon_down", f"codex daemon write failed: {e}")

    def request(self, method, params=None, timeout=None):
        """Send a request and wait for its response. Returns `result`; ChatError on error / timeout."""
        with self.lock:
            self.next_id += 1
            rid = self.next_id
            slot = [threading.Event(), None, None]
            self.waiting[rid] = slot
        try:
            self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params if params is not None else {}})
            if not slot[0].wait(timeout or self.rpc_timeout):
                raise cp.ChatError("daemon_down", f"codex daemon did not answer {method} in time")
        finally:
            with self.lock:
                self.waiting.pop(rid, None)
        resp = slot[1] or {}
        if "error" in resp:
            err = resp["error"] or {}
            e = cp.ChatError("daemon_down" if resp.get("_lost") else "bad_request", f"{method}: {err.get('message') or err}")
            e.rpc_error = err
            raise e
        return resp.get("result")

    def request_async(self, method, params=None, callback=None):
        """Send a request without waiting: `callback(response)` runs on the reader thread when the
        answer (or the loss of the connection) comes. ChatError daemon_down when not connected."""
        with self.lock:
            self.next_id += 1
            rid = self.next_id
            self.waiting[rid] = [threading.Event(), None, callback]
        try:
            self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params if params is not None else {}})
        except cp.ChatError:
            with self.lock:
                self.waiting.pop(rid, None)
            raise
        return rid

    def notify(self, method, params=None):
        obj = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            obj["params"] = params
        self._send(obj)

    def respond(self, rid, result=None, error=None):
        obj = {"jsonrpc": "2.0", "id": rid}
        if error is not None:
            obj["error"] = error
        else:
            obj["result"] = result if result is not None else {}
        self._send(obj)

    # -- routing
    def register(self, thread_id, adapter):
        with self.lock:
            self.adapters[thread_id] = adapter

    def unregister(self, thread_id):
        with self.lock:
            self.adapters.pop(thread_id, None)

    def _dispatch(self, msg):
        method = msg.get("method")
        if not method:  # a response
            with self.lock:
                slot = self.waiting.get(msg.get("id"))
                if slot and slot[2]:
                    self.waiting.pop(msg.get("id"), None)
            if slot:
                slot[1] = msg
                slot[0].set()
                if slot[2]:
                    try:
                        slot[2](msg)
                    except Exception:
                        pass
            return
        params = msg.get("params") or {}
        tid = params.get("threadId") or (params.get("thread") or {}).get("id")
        with self.lock:
            target = self.adapters.get(tid) if tid else None
            adapters = list(self.adapters.values())
        if target is not None:
            if "id" in msg:
                msg = dict(msg, _gen=self.gen)
            target.inbox.put(msg)
            return
        if "id" in msg:  # a server request nobody here owns: answer so the daemon never waits on us
            try:
                self.respond(msg["id"], error={"code": -32601, "message": f"dispatch does not handle {method}"})
            except cp.ChatError:
                pass
            return
        if not tid and method == "account/rateLimits/updated" and adapters:
            busy = [a for a in adapters if a.turn_id]
            for a in (busy or adapters[:1]):
                a.inbox.put(msg)
        # everything else (other threads, account/*, remoteControl/*) is not ours


_HUB = None
_HUB_LOCK = threading.Lock()


def hub():
    global _HUB
    with _HUB_LOCK:
        if _HUB is None:
            _HUB = CodexHub()
        return _HUB


# ---------------------------------------------------------------- the adapter
def _summary(item):
    t = item.get("type")
    if t == "commandExecution":
        acts = item.get("commandActions") or []
        cmd = (acts[0].get("command") if acts and isinstance(acts[0], dict) else None) or item.get("command") or ""
        return str(cmd).split("\n")[0][:180]
    if t == "fileChange":
        return ", ".join(c.get("path", "") for c in item.get("changes") or [])[:180]
    if t == "webSearch":
        return str(item.get("query") or "")[:180]
    if t == "mcpToolCall":
        return f"{item.get('server', '')}.{item.get('tool', '')}"
    if t in ("dynamicToolCall", "collabAgentToolCall"):
        return str(item.get("prompt") or item.get("tool") or t)[:180]
    return t or ""


def _tool_name(item):
    t = item.get("type")
    if t == "mcpToolCall":
        return f"{item.get('server', '')}.{item.get('tool', '')}"
    if t == "dynamicToolCall":
        return str(item.get("tool") or t)
    if t == "collabAgentToolCall":
        return "subAgent"
    return t


def _tool_kind(item):
    t = item.get("type")
    if t == "mcpToolCall":
        k = cp.tool_kind(str(item.get("tool") or ""))
        return k
    if t == "dynamicToolCall":
        return cp.tool_kind(str(item.get("tool") or ""))
    return cp.tool_kind(_tool_name(item))


def _tool_input(item):
    t = item.get("type")
    if t == "commandExecution":
        return {"command": item.get("command") or "", "cwd": item.get("cwd") or ""}
    if t == "fileChange":
        return {"changes": [{"path": c.get("path", ""), "kind": (c.get("kind") or {}).get("type", "")} for c in item.get("changes") or []]}
    if t == "webSearch":
        return {"query": item.get("query") or ""}
    if t in ("mcpToolCall", "dynamicToolCall"):
        a = item.get("arguments")
        return a if isinstance(a, dict) else {"arguments": a}
    if t == "collabAgentToolCall":
        return {"prompt": item.get("prompt") or "", "model": item.get("model") or ""}
    return {}


def _file_diff(changes):
    """First change of a fileChange item as a ChatDiff (kind "patch": `new` holds the unified diff)."""
    for c in changes or []:
        return {"path": c.get("path", ""), "kind": "patch", "old": "", "new": c.get("diff", "")}
    return None


def _tool_output(item):
    t = item.get("type")
    if t == "commandExecution":
        return item.get("aggregatedOutput") or ""
    if t == "fileChange":
        return "\n".join(c.get("diff", "") for c in item.get("changes") or [])
    if t == "mcpToolCall":
        if item.get("error"):
            e = item["error"]
            return e.get("message", "") if isinstance(e, dict) else str(e)
        res = item.get("result") or {}
        parts = [c.get("text", "") for c in res.get("content") or [] if isinstance(c, dict) and c.get("type") == "text"]
        return "\n".join(parts) if parts else (json.dumps(res.get("structuredContent"), ensure_ascii=False) if res.get("structuredContent") is not None else "")
    if t == "webSearch":
        res = item.get("results")
        return json.dumps(res, ensure_ascii=False)[:4000] if res else ""
    if t == "dynamicToolCall":
        parts = [c.get("text", "") for c in item.get("contentItems") or [] if isinstance(c, dict)]
        return "\n".join(p for p in parts if p)
    return ""


def _tool_ok(item):
    status = item.get("status")
    if item.get("type") == "commandExecution":
        return status == "completed" and item.get("exitCode") in (0, None)
    if item.get("type") == "dynamicToolCall" and item.get("success") is False:
        return False
    return status not in ("failed", "declined", "error")


def diff_files(patch):
    """Unified diff → [{path, add, del}] in order of appearance."""
    files, cur = [], None
    for line in (patch or "").splitlines():
        if line.startswith("diff --git "):
            parts = line.split(" b/", 1)
            cur = {"path": parts[1] if len(parts) == 2 else line[11:], "add": 0, "del": 0}
            files.append(cur)
        elif line.startswith("+++ "):
            p = line[4:].strip()
            if p != "/dev/null":
                p = p[2:] if p.startswith("b/") else p
                if cur is None or cur["add"] or cur["del"]:
                    cur = {"path": p, "add": 0, "del": 0}
                    files.append(cur)
                else:
                    cur["path"] = p
        elif line.startswith("--- "):
            if cur is None:
                p = line[4:].strip()
                cur = {"path": p[2:] if p.startswith("a/") else p, "add": 0, "del": 0}
                files.append(cur)
        elif cur is not None and line.startswith("+"):
            cur["add"] += 1
        elif cur is not None and line.startswith("-"):
            cur["del"] += 1
    return files


def _window_label(w):
    mins = w.get("windowDurationMins")
    if not mins:
        return ""
    return f"{mins // 1440}d" if mins % 1440 == 0 else f"{mins // 60}h" if mins % 60 == 0 else f"{mins}m"


class CodexAdapter(cp.Adapter):
    agent = "codex"
    capabilities = CAPABILITIES
    state_on_set = False       # set_model / set_permission_mode apply on the next turn; chatd emits the state

    def __init__(self, emit, session, cwd, options, hub=None):
        super().__init__(emit, session, cwd, options)
        self.hub = hub
        self.thread_id = None
        self.inbox = queue.Queue()
        self.queue = []            # chatd's queue view, echoed in `state`
        self.rebind = None         # chatd: emitter.bound, used once the thread id is known
        self.closed = False
        self.pending = {}          # permission id → {rpc, method, gen, kind, turn_id}
        self.items = {}            # item id → last seen item (for approval diffs and tool timing)
        self.turns = {}            # turn id → {started, tools, message_id, usage}
        self.done_turns = set()    # finished turns: their late events are dropped
        self.lost_turns = {}       # turn id → its turns entry, for turns cut off by a lost connection (may reopen after the resume)
        self.overrides = {}        # turn/start fields to send with the next turn (model, effort, policy)
        self.transcript_path = ""
        self.commands_cache = None
        # Everything that talks to the daemon runs off chatd's loop: a daemon that is slow to start
        # or to answer must never stall the other sessions. Answers come back through the inbox.
        self._rpcs = {}            # token → {tag, method, deadline, ...}
        self._starting = False     # thread/start|resume is on its way
        self._turn_req = None      # {message_id, text, images_n, overrides}: turn/start sent, no answer yet
        self._interrupt_wanted = False

    # -- helpers
    def _hub(self):
        if self.hub is None:
            self.hub = hub()
        return self.hub

    def _emit_state(self):
        body = self.state()
        body["queue"] = list(self.queue or [])
        self.emit("state", **body)

    def state(self):
        s = super().state()
        s["pending"] = list(self.pending)
        return s

    def _set_session(self, thread_id):
        self.thread_id = thread_id
        key = cp.session_key("codex", thread_id)
        if key != self.session:
            self.session = key
            if callable(self.rebind):
                self.emit = self.rebind(key)

    # -- lifecycle
    def start(self, resume=None):
        """Returns at once: connecting (maybe starting the daemon) and thread/start|resume run on a
        thread; drain() then emits `opened` + `state`, or a fatal `error`."""
        if _is_win():
            raise cp.ChatError("unsupported", "Windows 版暂不支持应用内聊天", fatal=True)
        h = self._hub()
        mode = self.options.get("permission_mode") or ""
        params = {"cwd": self.cwd, "approvalsReviewer": APPROVALS_REVIEWER}
        if self.options.get("model"):
            params["model"] = self.options["model"]
        if mode:
            policy, sandbox = mode_params(mode)
            params.update(approvalPolicy=policy, sandbox=sandbox)
        if self.options.get("effort"):
            self.overrides["effort"] = self.options["effort"]
        config = codex_window.thread_config(self.options.get("model"))
        if config:  # the model's largest window, unless the user's config.toml sets one
            params["config"] = config
        self._starting = True
        self.lifecycle = "starting"
        self.since = time.time()

        def work():
            try:
                h.ensure()
                if resume:
                    r = h.request("thread/resume", dict(params, threadId=resume, excludeTurns=True))
                else:
                    r = h.request("thread/start", params)
                self.inbox.put({"method": "_started", "params": r or {}, "resume": resume, "mode": mode})
            except cp.ChatError as e:
                code = e.code if e.code == "daemon_down" else ("invalid_model" if "model" in str(e).lower() else "spawn_failed")
                self.inbox.put({"method": "_start_failed", "params": {"code": code, "message": str(e)}})
            except Exception as e:  # never leave the session in `starting` forever
                self.inbox.put({"method": "_start_failed", "params": {"code": "spawn_failed", "message": f"{type(e).__name__}: {e}"}})

        threading.Thread(target=work, name="codex-start", daemon=True).start()

    def _started(self, r, resume, mode):
        self._starting = False
        h = self._hub()
        thread = r.get("thread") or {}
        tid = thread.get("id") or resume
        if not tid:
            self._start_failed("spawn_failed", "thread/start returned no thread id")
            return
        if self.closed:  # closed while it started: let the daemon go of it again
            try:
                h.request_async("thread/unsubscribe", {"threadId": tid})
            except cp.ChatError:
                pass
            return
        self._set_session(tid)
        h.register(tid, self)
        self.transcript_path = thread.get("path") or ""
        self.options["model"] = r.get("model") or self.options.get("model") or ""
        if r.get("reasoningEffort") and not self.options.get("effort"):
            self.options["effort"] = r["reasoningEffort"]
        self.options["permission_mode"] = mode or mode_of(r.get("approvalPolicy"), r.get("sandbox"))
        if r.get("cwd"):
            self.cwd = r["cwd"]
        status = (thread.get("status") or {}).get("type")
        self.lifecycle = "running" if status == "active" else "idle"
        self.since = time.time()
        self.emit("opened", agent=self.agent, cwd=self.cwd, resumed=bool(resume), model=self.options["model"],
                  permission_mode=self.options["permission_mode"], transcript_path=self.transcript_path, capabilities=list(self.capabilities))
        self._emit_state()
        self._fetch_commands()  # so the / menu has them before anyone asks

    def _start_failed(self, code, message):
        self._starting = False
        self.lifecycle = "error"
        self.since = time.time()
        self.emit("error", code=code, message=message, fatal=True)

    def alive(self):
        return not self.closed and (self.thread_id is not None or self._starting)

    # -- requests answered through the inbox
    def _call(self, tag, method, params, timeout=None, **extra):
        tok = uuid.uuid4().hex
        self._rpcs[tok] = dict(extra, tag=tag, method=method, deadline=time.time() + (timeout or getattr(self._hub(), "rpc_timeout", RPC_TIMEOUT)))
        try:
            self._hub().request_async(method, params, lambda resp, tok=tok: self.inbox.put({"method": "_rpc", "tok": tok, "resp": resp}))
        except cp.ChatError:
            self._rpcs.pop(tok, None)
            raise
        return tok

    def _rpc_answer(self, call, resp):
        tag = call["tag"]
        err = resp.get("error") if isinstance(resp, dict) else {"message": "no answer"}
        if tag == "turn":
            self._turn_answer(call, None if err else (resp.get("result") or {}), err, lost=bool(resp.get("_lost")) if isinstance(resp, dict) else False)
        elif tag == "interrupt":
            if err:
                self.emit("error", code="daemon_down" if resp.get("_lost") else "bad_request", message=f"turn/interrupt: {err.get('message') or err}", fatal=False)
        elif tag == "skills":
            self._commands_answer(None if err else (resp.get("result") or {}))

    def _expire_rpcs(self):
        now = time.time()
        for tok, call in list(self._rpcs.items()):
            if now > call["deadline"]:
                self._rpcs.pop(tok, None)
                self._rpc_answer(call, {"error": {"message": f"codex daemon did not answer {call['method']} in time"}})

    def close(self, reason="requested"):
        if self.closed:
            return
        self.closed = True
        h = self.hub
        if h is not None and self.thread_id:
            h.unregister(self.thread_id)
            for pid, p in list(self.pending.items()):  # leave nobody's approval hanging on us
                if p["gen"] == h.gen:
                    try:
                        h.respond(p["rpc"], error={"code": -32000, "message": "dispatch closed this session"})
                    except cp.ChatError:
                        pass
            try:
                if h.connected():
                    h.request_async("thread/unsubscribe", {"threadId": self.thread_id})
            except cp.ChatError:
                pass
        self.pending.clear()
        self._rpcs.clear()
        self._starting = False
        self.lifecycle = "stopped"
        self.since = time.time()
        if self.thread_id:
            self.emit("closed", reason=reason if reason in cp.CLOSE_REASONS else "requested")

    # -- turns
    def _image_inputs(self, images):
        out = []
        for img in images or []:
            if img.get("path"):
                if not os.path.isabs(img["path"]):
                    raise cp.ChatError("bad_request", "image path must be absolute")
                out.append({"type": "localImage", "path": img["path"]})
                continue
            data = img.get("data") or ""
            if data.startswith("data:"):
                data = data.split(",", 1)[1]
            try:
                raw = base64.b64decode(data, validate=False)
            except Exception:
                raise cp.ChatError("bad_request", "image is not valid base64")
            if len(raw) > cp.IMAGE_LIMIT:
                raise cp.ChatError("too_large", f"image over {cp.IMAGE_LIMIT // (1024 * 1024)} MB")
            ext = _IMAGE_EXT.get((img.get("media_type") or "").lower(), "png")
            folder = os.path.join(dispatch_dir(), "files")
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, f"chat-{uuid.uuid4()}.{ext}")
            with open(path, "wb") as f:
                f.write(raw)
            out.append({"type": "localImage", "path": path})
        return out

    def send(self, message):
        if self.closed or not self.thread_id:
            raise cp.ChatError("no_such_session", "session is closed")
        if self.turn_id or self._turn_req:
            raise cp.ChatError("session_busy", "a turn is running")
        h = self._hub()
        if not h.connected():  # never block the loop on a reconnect: the queue waits for `state` idle instead
            raise cp.ChatError("daemon_down", "reconnecting to the codex app-server daemon")
        text = message.get("text") or ""
        inputs = []
        if text:
            inputs.append({"type": "text", "text": text})
        inputs += self._image_inputs(message.get("images"))
        params = {"threadId": self.thread_id, "input": inputs, "approvalsReviewer": APPROVALS_REVIEWER}
        overrides = dict(self.overrides)
        params.update(overrides)
        req = {"message_id": message.get("message_id", ""), "text": text, "images_n": len(message.get("images") or []), "overrides": overrides}
        self._call("turn", "turn/start", params, req=req)
        self._turn_req = req
        self._interrupt_wanted = False
        self.lifecycle = "running"
        self.since = time.time()

    def _turn_answer(self, call, result, err, lost=False):
        req = call["req"]
        if self._turn_req is req:
            self._turn_req = None
        if err is not None:
            if self.turn_id:  # the turn showed up through notifications anyway
                return
            msg = f"turn/start: {err.get('message') or err}" if isinstance(err, dict) else str(err)
            code = "daemon_down" if lost or "did not answer" in msg else "invalid_model" if "model" in msg.lower() else "session_busy" if "active" in msg.lower() or "running" in msg.lower() else "bad_request"
            self._interrupt_wanted = False
            if self.lifecycle == "running":
                self.lifecycle = "idle"
                self.since = time.time()
            self.emit("error", code=code, message=msg, fatal=False)
            self._emit_state()
            return
        for k, v in req["overrides"].items():  # sent: drop them unless changed again meanwhile
            if self.overrides.get(k) == v:
                self.overrides.pop(k, None)
        tid = ((result or {}).get("turn") or {}).get("id") or f"turn-{uuid.uuid4()}"
        if tid != self.turn_id and tid not in self.done_turns:
            self._open_turn(tid, req)
        if self._interrupt_wanted and self.turn_id == tid:
            self._interrupt_wanted = False
            try:
                self.interrupt()
            except cp.ChatError as e:
                self.emit("error", code=e.code, message=str(e), fatal=False)

    def _open_turn(self, tid, req):
        if self.turn_id:  # a newer turn began while ours still looked open: close ours first
            self._turn_done(self.turn_id, "error", "superseded by another turn")
        self.turn_id = tid
        self.turns[tid] = {"started": time.time(), "tools": 0, "message_id": req["message_id"], "text": req["text"], "images_n": req["images_n"], "usage": None}
        self.done_turns.discard(tid)
        self.lifecycle = "running"
        self.since = time.time()
        self.emit("turn_started", turn_id=tid, message_id=req["message_id"], text=req["text"], images_n=req["images_n"])

    def interrupt(self):
        if self.turn_id:
            self._call("interrupt", "turn/interrupt", {"threadId": self.thread_id, "turnId": self.turn_id})
        elif self._turn_req:
            self._interrupt_wanted = True  # sent as soon as turn/start says which turn
        else:
            raise cp.ChatError("not_running", "nothing is running")

    def set_model(self, model, effort=None):
        if not model:
            raise cp.ChatError("invalid_model", "model is empty")
        self.options["model"] = model
        self.overrides["model"] = model
        if effort:
            self.options["effort"] = effort
            self.overrides["effort"] = effort

    def set_permission_mode(self, mode):
        policy, sandbox = mode_params(mode)
        self.options["permission_mode"] = mode
        self.overrides["approvalPolicy"] = policy
        self.overrides["sandboxPolicy"] = dict(SANDBOX_POLICY[sandbox])

    def commands(self):
        """What is known now; a first call starts skills/list and the answer arrives as `commands`."""
        if self.commands_cache is None:
            self._fetch_commands()
        return list(self.commands_cache or [])

    def _fetch_commands(self):
        if any(c["tag"] == "skills" for c in self._rpcs.values()):
            return
        try:
            self._call("skills", "skills/list", {"cwds": [self.cwd]} if self.cwd else {})
        except cp.ChatError:
            pass

    def _commands_answer(self, r):
        if r is None:
            return
        seen, out = set(), []
        for entry in r.get("data") or []:
            for s in entry.get("skills") or []:
                if not s.get("enabled", True) or s.get("name") in seen:
                    continue
                seen.add(s.get("name"))
                desc = s.get("shortDescription") or s.get("description") or ""
                out.append({"name": s.get("name", ""), "description": str(desc)[:200], "kind": "skill"})
        self.commands_cache = out
        self.emit("commands", commands=out)

    # -- permissions
    def permission(self, permission_id, decision, message=None, updated_input=None):
        p = self.pending.get(permission_id)
        if not p:
            raise cp.ChatError("bad_request", f"no pending permission {permission_id!r}")
        if decision not in p["options"]:
            raise cp.ChatError("unsupported", f"{decision} is not offered for this request")
        h = self._hub()
        if p["gen"] != h.gen:
            self.pending.pop(permission_id, None)
            raise cp.ChatError("daemon_down", "the daemon connection was reset; this request is gone")
        m = p["method"]
        if m == "item/permissions/requestApproval":
            result = {"permissions": p["grant"] if decision == "allow" else {}, "scope": GRANT_SCOPE}
        elif m == "item/tool/requestUserInput":
            result = {"answers": {}}
        else:
            result = {"decision": DECISION_MAP[decision]}
        h.respond(p["rpc"], result)
        self._resolved(permission_id, decision, "dispatch")

    def answer(self, permission_id, answers):
        p = self.pending.get(permission_id)
        if not p or p["method"] != "item/tool/requestUserInput":
            raise cp.ChatError("bad_request", f"no pending question {permission_id!r}")
        h = self._hub()
        if p["gen"] != h.gen:
            self.pending.pop(permission_id, None)
            raise cp.ChatError("daemon_down", "the daemon connection was reset; this question is gone")
        body = {str(q): {"answers": [str(a) for a in (v if isinstance(v, list) else [v])]} for q, v in (answers or {}).items()}
        h.respond(p["rpc"], {"answers": body})
        self._resolved(permission_id, "answered", "dispatch")

    def _resolved(self, permission_id, decision, by):
        self.pending.pop(permission_id, None)
        if self.lifecycle in ("waiting_permission", "waiting_input") and not self.pending:
            self.lifecycle = "running" if self.turn_id else "idle"
        self.emit("permission_resolved", permission_id=permission_id, decision=decision, by=by)

    # -- the reader's inbox → events (chatd's thread)
    def drain(self):
        did = False
        while True:
            try:
                msg = self.inbox.get_nowait()
            except queue.Empty:
                break
            if self.closed and msg.get("method") != "_started":
                continue
            did = True
            try:
                self._handle(msg)
            except cp.ChatError as e:
                self.emit("error", code=e.code, message=str(e), fatal=e.fatal)
        if self._rpcs and not self.closed:
            self._expire_rpcs()
        return did

    def _ensure_turn(self, turn_id, text="", message_id=""):
        """True when an event of `turn_id` should be shown. A turn this adapter did not start (the
        TUI on the same thread, or one that outlived a reconnect) opens on first sight so the page
        still gets a turn_started; late events of a finished turn are dropped."""
        if not turn_id:
            return bool(self.turn_id)
        if turn_id == self.turn_id:
            return True
        if turn_id in self.done_turns:
            return False
        lost = self.lost_turns.pop(turn_id, None)
        if lost is None and self._turn_req and turn_id not in self.turns:
            # our turn/start is still on its way and its events are already here
            self._open_turn(turn_id, self._turn_req)
            return True
        if self.turn_id:  # a newer turn began while ours still looked open: close ours first
            self._turn_done(self.turn_id, "error", "superseded by another turn")
        self.turn_id = turn_id
        t = self.turns.setdefault(turn_id, lost or {"started": time.time(), "tools": 0, "message_id": message_id, "usage": None})
        self.done_turns.discard(turn_id)
        self.lifecycle = "running"
        self.since = time.time()
        # a turn that outlived a reconnect keeps its message id and text, so the page keeps the bubble
        self.emit("turn_started", turn_id=turn_id, message_id=t.get("message_id") or message_id, text=text or t.get("text", ""), images_n=t.get("images_n", 0))
        return True

    def _turn_done(self, turn_id, status, error=None, turn=None):
        t = self.turns.get(turn_id) or {"started": time.time(), "tools": 0, "usage": None}
        duration = (turn or {}).get("durationMs")
        fields = {"turn_id": turn_id, "status": status, "duration_ms": int(duration if duration is not None else (time.time() - t["started"]) * 1000),
                  "num_tools": t["tools"]}
        if error:
            fields["error"] = error
        if t.get("usage"):
            fields["usage"] = t["usage"]
        for pid in [k for k, p in self.pending.items() if p["turn_id"] == turn_id]:
            self.pending.pop(pid, None)
        if turn_id == self.turn_id:
            self.turn_id = None
        self.done_turns.add(turn_id)
        self.turns.pop(turn_id, None)
        self.lifecycle = "idle"
        self.since = time.time()
        self.emit("turn_done", **fields)

    def _handle(self, msg):
        m = msg.get("method")
        p = msg.get("params") or {}
        if "id" in msg:
            return self._server_request(msg)
        if m == "_rpc":
            call = self._rpcs.pop(msg.get("tok"), None)
            if call is not None:
                self._rpc_answer(call, msg.get("resp") or {})
            return
        if m == "_started":
            self._started(p, msg.get("resume"), msg.get("mode") or "")
            return
        if m == "_start_failed":
            self._start_failed(p.get("code") or "spawn_failed", p.get("message") or "codex did not start")
            return
        if m == "_disconnected":
            # The daemon asks again after the resume (with a new request id): these cards are dead.
            for pid in list(self.pending):
                self._resolved(pid, "deny", "elsewhere")
            if self.turn_id:
                lost = self.turn_id
                info = dict(self.turns.get(lost) or {})
                self._turn_done(lost, "error", "lost the connection to the codex daemon")
                self.done_turns.discard(lost)
                self.lost_turns[lost] = info
            self.pending.clear()
            self.lifecycle = "starting"
            self.since = time.time()
            self.emit("error", code="daemon_down", message="lost the connection to the codex daemon; reconnecting", fatal=False)
            self._emit_state()
            return
        if m == "_resumed":
            status = ((p.get("thread") or {}).get("status") or {}).get("type")
            self.lifecycle = "running" if status == "active" else "idle"
            self.since = time.time()
            self._emit_state()
            return
        if m == "_resume_failed":
            self.lifecycle = "error"
            self.emit("error", code="daemon_down", message=p.get("message", "thread/resume failed"), fatal=True)
            self._emit_state()
            return
        turn_id = p.get("turnId") or (p.get("turn") or {}).get("id")
        if m == "turn/started":
            if turn_id and turn_id != self.turn_id and turn_id not in self.done_turns:
                if self._turn_req and turn_id not in self.turns and turn_id not in self.lost_turns:
                    self._open_turn(turn_id, self._turn_req)  # ours, ahead of the turn/start answer
                    return
                # a turn someone else started (the TUI on this thread): turn_started waits for the
                # user message item so it can carry the text
                self.turns.setdefault(turn_id, {"started": time.time(), "tools": 0, "message_id": "", "usage": None})
            return
        if m == "turn/completed":
            turn = p.get("turn") or {}
            tid = turn.get("id") or turn_id
            if tid in self.lost_turns:  # finished while we were away; the page already has its turn_done
                self.lost_turns.pop(tid, None)
                if not self.turn_id and self.lifecycle == "running":
                    self.lifecycle = "idle"
                    self._emit_state()
                return
            if tid in self.done_turns or (tid != self.turn_id and tid not in self.turns):
                return
            if not self._ensure_turn(tid):
                return
            status = TURN_STATUS.get(turn.get("status"), "error")
            err = (turn.get("error") or {}).get("message") if status == "error" else None
            self._turn_done(tid, status, err, turn)
            return
        if m == "item/started" or m == "item/completed":
            item = p.get("item") or {}
            it = item.get("type")
            if it == "userMessage":
                if turn_id and turn_id != self.turn_id and m == "item/started":
                    text = "\n".join(c.get("text", "") for c in item.get("content") or [] if isinstance(c, dict) and c.get("type") == "text")
                    self._ensure_turn(turn_id, text=text)
                return
            if it not in TOOL_ITEMS and it not in ("agentMessage", "reasoning"):
                return
            if not self._ensure_turn(turn_id):
                return
            if m == "item/started":
                self.items[item.get("id")] = dict(item, _t=time.time(), _started_ms=p.get("startedAtMs"))
                if it in TOOL_ITEMS:
                    t = self.turns.get(self.turn_id)
                    if t is not None:
                        t["tools"] += 1
                    self.emit("tool_start", turn_id=self.turn_id, tool_id=item.get("id", ""), name=_tool_name(item), kind=_tool_kind(item),
                              input=_tool_input(item), summary=_summary(item))
                return
            seen = self.items.pop(item.get("id"), None)
            if it == "agentMessage":
                self.emit("text_done", turn_id=self.turn_id, text=item.get("text") or "")
            elif it == "reasoning":
                text = "\n\n".join(x for x in (item.get("summary") or []) + (item.get("content") or []) if isinstance(x, str))
                started = (seen or {}).get("_started_ms")
                dur = int(p["completedAtMs"] - started) if started and p.get("completedAtMs") else int((time.time() - (seen or {}).get("_t", time.time())) * 1000)
                self.emit("thinking_done", turn_id=self.turn_id, text=text, duration_ms=max(dur, 0))
            else:
                if seen is None:  # completed without a start we saw (joined mid-item)
                    t = self.turns.get(self.turn_id)
                    if t is not None:
                        t["tools"] += 1
                    self.emit("tool_start", turn_id=self.turn_id, tool_id=item.get("id", ""), name=_tool_name(item), kind=_tool_kind(item),
                              input=_tool_input(item), summary=_summary(item))
                out, truncated = cp.truncate_output(_tool_output(item))
                dur = item.get("durationMs")
                if dur is None:
                    dur = int((time.time() - (seen or {}).get("_t", time.time())) * 1000)
                fields = {"turn_id": self.turn_id, "tool_id": item.get("id", ""), "ok": _tool_ok(item), "output": out, "truncated": truncated, "duration_ms": int(dur)}
                if it == "commandExecution":
                    fields["exit_code"] = item.get("exitCode")
                if it == "fileChange":
                    d = _file_diff(item.get("changes"))
                    if d:
                        fields["diff"] = d
                self.emit("tool_end", **fields)
            return
        if m == "item/agentMessage/delta":
            if not self._ensure_turn(turn_id):
                return
            self.emit("text_delta", turn_id=self.turn_id, text=p.get("delta") or "")
            return
        if m in ("item/reasoning/summaryTextDelta", "item/reasoning/textDelta"):
            if not self._ensure_turn(turn_id):
                return
            self.emit("thinking_delta", turn_id=self.turn_id, text=p.get("delta") or "")
            return
        if m == "turn/diff/updated":
            if turn_id and (turn_id == self.turn_id or turn_id in self.turns):
                patch = p.get("diff") or ""
                self.emit("diff_updated", turn_id=turn_id, files=diff_files(patch), patch=patch)
            return
        if m == "thread/tokenUsage/updated":
            u = p.get("tokenUsage") or {}
            last = u.get("last") or {}
            from session_life import codex_usage
            usage = codex_usage(last, camel=True)
            self.emit("life_usage", usage=usage, cumulative=codex_usage(u["total"], camel=True) if u.get("total") else None,
                      request_id=turn_id or self.turn_id or "", window=u.get("modelContextWindow"))
            win = u.get("modelContextWindow")
            if win:
                usage["context_pct"] = round(100.0 * (last.get("totalTokens") or 0) / win, 1)
            t = self.turns.get(turn_id or self.turn_id)
            if t is not None:
                t["usage"] = usage
            return
        if m == "account/rateLimits/updated":
            rl = p.get("rateLimits") or {}
            windows = []
            for key in ("primary", "secondary"):
                w = rl.get(key)
                if isinstance(w, dict):
                    windows.append({"label": _window_label(w) or key, "used_percent": w.get("usedPercent"), "resets_at": w.get("resetsAt")})
            if windows:
                self.emit("rate_limit", agent=self.agent, windows=windows)
            return
        if m == "serverRequest/resolved":
            rid = p.get("requestId")
            for pid, pend in list(self.pending.items()):
                if pend["rpc"] == rid:
                    self._resolved(pid, "deny" if pend["method"] != "item/tool/requestUserInput" else "answered", "elsewhere")
            return
        if m in ("hook/started", "hook/completed"):
            run = p.get("run") or {}
            if m == "hook/completed" and run.get("statusMessage"):
                self.emit("system", kind="hook", text=f"{run.get('eventName', 'hook')}: {run.get('statusMessage')}")
            return
        if m == "error":
            err = (p.get("error") or {}).get("message") or ""
            if err and not p.get("willRetry"):
                self.emit("system", kind="notice", text=err[:500])
            return
        if m == "thread/closed":
            self.closed = True
            self.lifecycle = "stopped"
            if self.hub is not None:
                self.hub.unregister(self.thread_id)
            self.emit("closed", reason="exited")
            return

    def _server_request(self, msg):
        m = msg.get("method")
        p = msg.get("params") or {}
        rid = msg.get("id")
        gen = msg.get("_gen", self.hub.gen if self.hub else 0)
        pid = f"c{gen}-{rid}"
        turn_id = p.get("turnId") or self.turn_id
        if not self._ensure_turn(turn_id):  # a request for a finished turn cannot be answered usefully
            try:
                self._hub().respond(rid, error={"code": -32000, "message": "dispatch sees no active turn for this request"})
            except cp.ChatError:
                pass
            return
        item = self.items.get(p.get("itemId")) or {}
        base = {"turn_id": self.turn_id, "tool_id": p.get("itemId") or None, "reason": p.get("reason") or "", "cwd": p.get("cwd") or self.cwd}
        entry = {"rpc": rid, "method": m, "gen": gen, "turn_id": self.turn_id}
        if m == "item/commandExecution/requestApproval":
            avail = p.get("availableDecisions")
            options = ["allow", "deny"]
            if avail is None or "acceptForSession" in avail:
                options = ["allow", "allow_session", "deny"]
            cmd = p.get("command") or item.get("command") or ""
            acts = p.get("commandActions") or item.get("commandActions") or []
            summary = (acts[0].get("command") if acts and isinstance(acts[0], dict) else None) or cmd
            fields = dict(base, kind="command", tool_name="commandExecution", input={"command": cmd, "cwd": p.get("cwd") or ""},
                          summary=str(summary).split("\n")[0][:180], options=options)
        elif m == "item/fileChange/requestApproval":
            changes = item.get("changes") or []
            options = ["allow", "allow_session", "deny"]
            fields = dict(base, kind="edit", tool_name="fileChange", input={"changes": [{"path": c.get("path", "")} for c in changes], "grantRoot": p.get("grantRoot")},
                          summary=", ".join(c.get("path", "") for c in changes)[:180] or (p.get("grantRoot") or ""), options=options)
            d = _file_diff(changes)
            if d:
                fields["diff"] = d
        elif m == "item/permissions/requestApproval":
            options = ["allow", "deny"]
            perms = p.get("permissions") or {}
            entry["grant"] = {k: perms[k] for k in ("fileSystem", "network") if perms.get(k) is not None}
            fields = dict(base, kind="permission", tool_name="permissions", input=perms, summary=json.dumps(perms, ensure_ascii=False)[:180], options=options)
        elif m == "item/tool/requestUserInput":
            options = ["deny"]
            qs = []
            for q in p.get("questions") or []:
                text = q.get("question") or ""
                if q.get("header") and q.get("header") != text:
                    text = f"{q['header']}: {text}"
                qs.append({"id": q.get("id", ""), "text": text, "options": [o.get("label", "") for o in q.get("options") or []], "multi": False})
            fields = dict(base, kind="question", tool_name="requestUserInput", input={"questions": p.get("questions") or []},
                          summary=(qs[0]["text"] if qs else "")[:180], options=options, questions=qs)
        else:
            try:
                self._hub().respond(rid, error={"code": -32601, "message": f"dispatch does not handle {m}"})
            except cp.ChatError:
                pass
            return
        entry["options"] = options
        self.pending[pid] = entry
        self.lifecycle = "waiting_input" if fields["kind"] == "question" else "waiting_permission"
        self.since = time.time()
        if fields.get("tool_id") is None:
            fields.pop("tool_id")
        self.emit("permission_request", permission_id=pid, **fields)
