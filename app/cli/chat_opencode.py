# -*- coding: utf-8 -*-
"""OpenCode driver for chatd: one resident `opencode acp` process (the Agent Client Protocol: JSON-RPC
2.0 over stdio, one JSON object per line) serves every OpenCode session chatd has open. Each is an ACP
session whose id is OpenCode's own (`ses_…`, what its database and `opencode --session` use), so the
key is "opencode:ses_…" and history comes from OpenCode's store like any other OpenCode conversation.

Threads
    OpenCodeHub (module singleton, `hub()`) owns the process. Its reader thread decodes lines:
    responses wake the caller waiting in `request()` or run the callback of `request_async()`;
    `session/update` notifications and `session/request_permission` requests go into the inbox of
    the adapter whose sessionId they carry. Nothing is emitted from the reader: chatd's loop calls
    `OpenCodeAdapter.drain()`. When the process exits, every open adapter gets `_exited` (a running
    turn ends with process_exited); the next message starts a new process and picks the session up
    again with `session/resume` (no replay).

What chatd has to know
    * A new session has no key until `session/new` answers (as with Codex): chatd constructs the
      adapter with session=None and files it once `start()`'s worker has named it.
    * OpenCode keeps no per-session permission mode: its own `permission` config decides what asks.
      `set_permission_mode` is unsupported; `opened.permission_mode` is "", or "bypassPermissions"
      for an unattended session (opened with it), whose questions the adapter answers yes itself.
    * set_model / effort apply to the next prompt (`session/set_config_option`); chatd emits the state.
    * Slash commands come from OpenCode's `available_commands_update` and go out as `commands`.
    * Questions: ACP has no request for OpenCode's `question` tool (OpenCode leaves it out of ACP
      sessions unless OPENCODE_ENABLE_QUESTION_TOOL is set, and then the ACP side never asks the
      client). So the hub starts `opencode acp` with the tool on and its own HTTP server (which the
      ACP agent talks to as well) on a port and password of ours, reads `question.asked` from that
      server's /global/event, and answers with POST /question/<id>/reply or /reject. To chatd the
      question is a permission_request of kind "question", tool AskUserQuestion, answered with
      `answer` ({question text: [labels]}) or refused with `permission` deny, as with Claude Code.
"""
import base64
import json
import os
import queue
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
sys.dont_write_bytecode = True

import chat_protocol as cp
import engines as _engines

try:
    import dplatform as _P
except Exception:  # the adapter must import even where dplatform is missing (tests, odd bundles)
    _P = None

AGENT = "opencode"
CAPABILITIES = ("allow_session", "set_model", "effort", "thinking_text", "images_base64", "images_path", "queue", "commands")
RPC_TIMEOUT = 60           # seconds for everything but a prompt (a turn takes as long as it takes)
INIT_TIMEOUT = 60          # the first start of `opencode acp` loads its plugins and providers
# What the ACP client was verified against (2026-09-27: session/resume, set_config_option, usage in the prompt result).
# One number for chatd, `dispatch engines` and Dispatch IDE: min_version in engines/opencode.py (the IDE's copy is
# OPENCODE_MIN_VERSION in dispatch-ide patches/225-opencode-version.patch).
MIN_VERSION = _engines.get("opencode").min_version
# cp decisions → ACP permission option kinds, in order of preference
DECISION_KINDS = {"allow": ("allow_once",), "allow_session": ("allow_always",), "deny": ("reject_once", "reject_always")}
# ACP stopReason → cp turn status
STOP_STATUS = {"end_turn": "success", "max_tokens": "success", "max_turn_requests": "success", "cancelled": "interrupted", "refusal": "error"}
# ACP tool kinds → cp permission kinds
PERMISSION_KIND = {"execute": "command", "edit": "edit", "delete": "edit", "move": "edit", "read": "read", "fetch": "fetch", "search": "read"}
_IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
# OpenCode gives the model its `question` tool in an ACP session only with this set (1.18: RuntimeFlags)
QUESTION_TOOL_ENV = "OPENCODE_ENABLE_QUESTION_TOOL"
QUESTION_EVENTS = ("question.asked", "question.replied", "question.rejected")


def _search_path():
    import engines
    return engines.search_path()


def _which():
    """The `opencode` Dispatch runs: the first copy on the search path that is new enough (1.14 in
    ~/.opencode/bin can sit in front of 1.18 in ~/.bun/bin); when all are older, the newest, and probe() says why not."""
    return _engines.pick(_engines.get("opencode"))["path"] or None


def _bin():
    return _which() or "opencode"


def _is_win():
    return bool(_P.IS_WIN) if _P is not None else os.name == "nt"


def _env():
    env = cp.child_env()
    env["PATH"] = _search_path()
    import net
    return net.apply(env)  # this Mac's proxy (net.py); a PAC that sends Chinese model servers direct puts them in NO_PROXY


def probe():
    """{available, version, supported, reason} for `hello`."""
    if _is_win():
        return {"available": bool(_which()), "version": "", "supported": False, "reason": "Windows 版暂不支持应用内聊天"}
    if not _which():
        return {"available": False, "version": "", "supported": False, "reason": "opencode not found on PATH"}
    try:
        text = _engines.pick(_engines.get("opencode"))["version"]
    except Exception as e:
        return {"available": True, "version": "", "supported": False, "reason": f"opencode --version failed: {e}"[:200]}
    v = cp.parse_version(text)
    version = ".".join(map(str, v)) if v else text[:40]
    if not cp.version_ok(v, MIN_VERSION):
        need = ".".join(map(str, MIN_VERSION))
        return {"available": True, "version": version, "supported": False, "reason": f"opencode {version or '?'} is older than {need}"}
    return {"available": True, "version": version, "supported": True, "reason": ""}


# ---------------------------------------------------------------- tool calls as Claude-style tools
def _str(v):
    return v if isinstance(v, str) else ""


def tool_view(update, previous=None):
    """(name, input) of an ACP tool call, named like Claude Code's tools (Bash, Read, Edit, Grep …) so
    cp.tool_kind and cp.step_phrase read it: the tool id when the first `tool_call` titles the call
    with it, else the ACP kind and the input's shape. A later update without input keeps `previous`."""
    raw = update.get("rawInput") if isinstance(update.get("rawInput"), dict) else {}
    title = _str(update.get("title")).strip()
    oc = previous[2] if previous and previous[2] else (title if update.get("sessionUpdate") == "tool_call" and title and title.replace("_", "").isalnum() and title.islower() else "")
    has_input = any(k != "cwd" for k in raw)
    if not has_input and previous and previous[0] != "tool":
        return previous if previous[2] or not oc else (previous[0], previous[1], oc)
    loc = (update.get("locations") or [{}])[0] if isinstance(update.get("locations"), list) and update.get("locations") else {}
    path = _str(raw.get("filePath")) or _str(raw.get("file_path")) or _str(raw.get("filepath")) or _str((loc or {}).get("path"))
    table = {
        "bash": ("Bash", {"command": _str(raw.get("command")), "description": _str(raw.get("description"))}),
        "read": ("Read", {"file_path": path}),
        "list": ("LS", {"path": _str(raw.get("path")) or _str((loc or {}).get("path"))}),
        "write": ("Write", {"file_path": path, "content": _str(raw.get("content"))}),
        "edit": ("Edit", {"file_path": path, "old_string": _str(raw.get("oldString")), "new_string": _str(raw.get("newString"))}),
        "multiedit": ("Edit", {"file_path": path}),
        "patch": ("Edit", {"file_path": path}),
        "apply_patch": ("Edit", {"file_path": path}),
        "glob": ("Glob", {"pattern": _str(raw.get("pattern")), "path": _str(raw.get("path"))}),
        "grep": ("Grep", {"pattern": _str(raw.get("pattern")), "path": _str(raw.get("path"))}),
        "webfetch": ("WebFetch", {"url": _str(raw.get("url"))}),
        "websearch": ("WebSearch", {"query": _str(raw.get("query"))}),
        "codesearch": ("WebSearch", {"query": _str(raw.get("query"))}),
        "todowrite": ("TodoWrite", {"todos": raw.get("todos")}),
        "todoread": ("TodoRead", {}),
        "task": ("Agent", {"description": _str(raw.get("description")), "prompt": _str(raw.get("prompt")), "subagent_type": _str(raw.get("subagent_type"))}),
        "skill": ("Skill", {"skill": _str(raw.get("name")) or _str(raw.get("skill"))}),
        "question": ("AskUserQuestion", {"questions": asked_questions(raw.get("questions"))}),
    }
    if oc in table:
        name, inp = table[oc]
        return name, inp, oc
    kind = update.get("kind")
    if kind == "execute":
        return "Bash", {"command": _str(raw.get("command")) or ("" if has_input else title), "description": _str(raw.get("description"))}, oc
    if kind == "read":
        return ("Read", {"file_path": path}, oc) if path or not raw.get("path") else ("LS", {"path": _str(raw.get("path"))}, oc)
    if kind == "edit":
        return ("Write" if "content" in raw and "oldString" not in raw else "Edit"), {"file_path": path}, oc
    if kind == "search":
        return ("Glob" if any(c in _str(raw.get("pattern")) for c in "*?{[") and "include" not in raw else "Grep"), {"pattern": _str(raw.get("pattern")), "path": _str(raw.get("path"))}, oc
    if kind == "fetch":
        return ("WebFetch", {"url": _str(raw.get("url"))}, oc) if "url" in raw else ("WebSearch", {"query": _str(raw.get("query"))}, oc)
    if isinstance(raw.get("todos"), list):
        return "TodoWrite", {"todos": raw["todos"]}, oc
    if previous and not has_input:
        return previous
    return oc or title or "tool", dict(raw), oc


def asked_questions(raw):
    """OpenCode's questions ({question, header, options: [{label, description}], multiple, custom}) in
    Claude Code's AskUserQuestion shape ({question, header, options, multiSelect}), what chatd's
    question cards read in `input.questions`."""
    out = []
    for q in raw if isinstance(raw, list) else []:
        if not isinstance(q, dict):
            continue
        opts = [{"label": _str(o.get("label")), "description": _str(o.get("description"))} for o in q.get("options") or [] if isinstance(o, dict)]
        out.append({"question": _str(q.get("question")), "header": _str(q.get("header")), "options": opts, "multiSelect": bool(q.get("multiple"))})
    return out


def question_cards(raw):
    """The permission_request's `questions`: {id, text, options: [labels], multi}; id and text are the
    question itself (the header when it has none), as Claude Code's cards have them."""
    out, seen = [], set()
    for i, q in enumerate(asked_questions(raw)):
        text = q["question"] or q["header"] or f"Question {i + 1}"
        qid = text if text not in seen else f"{text} ({i + 1})"
        seen.add(qid)
        out.append({"id": qid, "text": text, "options": [o["label"] for o in q["options"]], "multi": q["multiSelect"]})
    return out


def free_port():
    """A local port nothing listens on now (for `opencode acp --port`)."""
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


class OpenCodeHttp:
    """The HTTP server inside `opencode acp` (OpenCode's ACP agent is its client too), on 127.0.0.1 with
    a password of ours: the question tool's events and answers go through it."""

    def __init__(self, port, password):
        self.base = f"http://127.0.0.1:{port}"
        self.auth = "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode()

    def _url(self, path, directory=None):
        return self.base + path + (f"?directory={urllib.parse.quote(directory)}" if directory else "")

    def get(self, path, directory=None, timeout=10):
        req = urllib.request.Request(self._url(path, directory), headers={"Authorization": self.auth})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"null")

    def post(self, path, body=None, directory=None, timeout=10):
        data = json.dumps(body if body is not None else {}).encode()
        req = urllib.request.Request(self._url(path, directory), data=data, method="POST",
                                     headers={"Authorization": self.auth, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"null")

    def events(self, on_event, alive, on_connect=None):
        """Read /global/event until `alive()` is false; `on_event(event)` for the question events. A
        dropped stream is opened again; `on_connect()` runs on each (re)connect, to pick up questions
        asked while nobody listened."""
        delay = 0.5
        while alive():
            try:
                req = urllib.request.Request(self.base + "/global/event", headers={"Authorization": self.auth, "Accept": "text/event-stream"})
                with urllib.request.urlopen(req) as r:
                    delay = 0.5
                    if on_connect:
                        on_connect()
                    for raw in r:
                        if not alive():
                            return
                        line = raw.decode("utf-8", "replace")
                        if not line.startswith("data:") or '"question.' not in line:
                            continue
                        try:
                            ev = json.loads(line[5:])
                        except ValueError:
                            continue
                        if isinstance(ev, dict):
                            on_event(ev)
            except Exception:
                pass
            if not alive():
                return
            time.sleep(delay)
            delay = min(delay * 2, 5)


def tool_output(update):
    """What a finished tool call printed: its text content, else rawOutput's output or error."""
    parts = []
    for c in update.get("content") or []:
        if isinstance(c, dict):
            inner = c.get("content") if c.get("type") == "content" else c
            if isinstance(inner, dict) and inner.get("type") == "text" and inner.get("text"):
                parts.append(inner["text"])
    if parts:
        return "\n".join(parts)
    raw = update.get("rawOutput")
    if isinstance(raw, dict):
        return _str(raw.get("output")) or _str(raw.get("error"))
    return _str(raw)


def exit_code_of(update):
    raw = update.get("rawOutput")
    meta = raw.get("metadata") if isinstance(raw, dict) else None
    code = meta.get("exit") if isinstance(meta, dict) else None
    return code if isinstance(code, int) else None


def prompt_blocks(text, images):
    """The ACP prompt: the text, then each image as an image block (base64 with its media type)."""
    blocks = [{"type": "text", "text": text}] if text else []
    for img in images or []:
        if img.get("path"):
            p = img["path"]
            if not os.path.isabs(p):
                raise cp.ChatError("bad_request", "image path must be absolute")
            try:
                with open(p, "rb") as f:
                    raw = f.read()
            except OSError as e:
                raise cp.ChatError("bad_request", f"cannot read {p}: {e}")
            media = _IMAGE_TYPES.get(os.path.splitext(p)[1].lower(), "image/png")
        else:
            data = img.get("data") or ""
            if data.startswith("data:"):
                data = data.split(",", 1)[1]
            try:
                raw = base64.b64decode(data, validate=False)
            except Exception:
                raise cp.ChatError("bad_request", "image is not valid base64")
            media = (img.get("media_type") or "image/png").lower()
        if len(raw) > cp.IMAGE_LIMIT:
            raise cp.ChatError("too_large", f"image over {cp.IMAGE_LIMIT // (1024 * 1024)} MB")
        blocks.append({"type": "image", "mimeType": media, "data": base64.b64encode(raw).decode("ascii")})
    return blocks


def config_value(options, which):
    """The current value of a session's config option (`model`, `effort`) from ACP configOptions."""
    for o in options or []:
        if isinstance(o, dict) and (o.get("id") == which or (which == "effort" and o.get("category") == "thought_level")):
            v = o.get("currentValue")
            return v if isinstance(v, str) else None
    return None


# ---------------------------------------------------------------- the resident process
def _spawn(argv, env):
    kw = {}
    if _P is not None and hasattr(_P, "no_window_flags"):
        try:
            kw["creationflags"] = _P.no_window_flags()
        except Exception:
            pass
    return subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                            bufsize=1, cwd=os.path.expanduser("~"), env=env, **kw)


class OpenCodeHub:
    def __init__(self, spawn=None, binary=None, rpc_timeout=RPC_TIMEOUT, http=None):
        self._spawn = spawn or _spawn
        self._http_factory = http or OpenCodeHttp
        self.binary = binary
        self.rpc_timeout = rpc_timeout
        self.proc = None
        self.http = None         # OpenCodeHttp of the running process
        self.gen = 0
        self.version = ""
        self._lock = threading.RLock()
        self._start_lock = threading.Lock()
        self._nid = 0
        self._pending = {}       # id → {"event", "resp"} | {"callback"}, plus "gen"
        self._adapters = {}      # ACP session id → adapter
        self.commands = {}       # ACP session id → the last available_commands_update's list

    # -- process
    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def ensure(self):
        """Start `opencode acp` when it is not running (blocking: call from a worker thread)."""
        with self._start_lock:
            if self.running():
                return
            with self._lock:
                self.gen += 1
                gen = self.gen
                port, password = free_port(), secrets.token_hex(16)
                env = _env()
                env[QUESTION_TOOL_ENV] = "1"
                env["OPENCODE_SERVER_PASSWORD"] = password
                try:
                    proc = self._spawn([self.binary or _bin(), "acp", "--hostname", "127.0.0.1", "--port", str(port)], env)
                except OSError as e:
                    raise cp.ChatError("spawn_failed", f"cannot start opencode acp: {e}")
                self.proc = proc
                self.http = self._http_factory(port, password)
            threading.Thread(target=self._reader, args=(proc, gen), name="opencode-acp", daemon=True).start()
            if getattr(proc, "stderr", None) is not None:
                threading.Thread(target=self._drain_stderr, args=(proc,), name="opencode-acp-err", daemon=True).start()
            r = self.request("initialize", {
                "protocolVersion": 1,
                "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False},
                "clientInfo": {"name": "dispatch-chatd", "title": "Dispatch", "version": "1"},
            }, timeout=INIT_TIMEOUT)
            self.version = ((r or {}).get("agentInfo") or {}).get("version") or ""
            http = self.http
            threading.Thread(target=http.events, name="opencode-events", daemon=True,
                             args=(lambda ev: self._on_event(ev, gen), lambda: self.gen == gen and self.running(),
                                   lambda: self._pending_questions(gen))).start()

    # -- OpenCode's questions (its own HTTP server; ACP has no request for them)
    def _on_event(self, ev, gen):
        payload = ev.get("payload") if isinstance(ev.get("payload"), dict) else ev
        kind = payload.get("type")
        if kind not in QUESTION_EVENTS:
            return
        props = payload.get("properties") if isinstance(payload.get("properties"), dict) else {}
        sid = props.get("sessionID")
        with self._lock:
            adapter = self._adapters.get(sid) if sid else None
        directory = ev.get("directory") or ""
        if adapter is None:
            if kind == "question.asked" and props.get("id"):
                # no session of ours is there to answer it: OpenCode goes on without an answer
                try:
                    self.question(gen, props["id"], directory, reject=True)
                except cp.ChatError:
                    pass
            return
        adapter.inbox.put({"method": "_question", "type": kind, "props": props, "directory": directory, "gen": gen})

    def _pending_questions(self, gen):
        """On (re)connecting to the events: the questions OpenCode is still waiting on in our sessions' folders."""
        http = self.http
        if http is None or gen != self.gen:
            return
        with self._lock:
            folders = {a.cwd for a in self._adapters.values() if getattr(a, "cwd", None)}
        for folder in folders:
            try:
                listed = http.get("/question", folder)
            except Exception:
                continue
            for q in listed if isinstance(listed, list) else []:
                if isinstance(q, dict):
                    self._on_event({"directory": folder, "payload": {"type": "question.asked", "properties": q}}, gen)

    def question(self, gen, request_id, directory, answers=None, reject=False):
        """Answer (or refuse) one of OpenCode's questions; ChatError when the process is not that one any more."""
        http = self.http
        if http is None or gen != self.gen or not self.running():
            raise cp.ChatError("process_exited", "opencode restarted; this question is gone")
        path = f"/question/{urllib.parse.quote(str(request_id))}/{'reject' if reject else 'reply'}"
        try:
            http.post(path, None if reject else {"answers": answers or []}, directory or None)
        except Exception as e:
            raise cp.ChatError("bad_request", f"OpenCode did not take the answer: {e}")

    def shutdown(self):
        with self._lock:
            proc, self.proc = self.proc, None
            self.http = None
        if proc is not None:
            try:
                proc.terminate()
                proc.wait(3)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    def _drain_stderr(self, proc):
        try:
            for _ in proc.stderr:
                pass  # OpenCode logs there; reading keeps the pipe from filling up
        except (OSError, ValueError):
            pass

    # -- JSON-RPC
    def _write(self, obj):
        with self._lock:
            proc = self.proc
            if proc is None or proc.poll() is not None:
                raise cp.ChatError("process_exited", "opencode acp is not running")
            try:
                proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
                proc.stdin.flush()
            except (OSError, ValueError) as e:
                raise cp.ChatError("process_exited", f"opencode acp: {e}")

    def _next(self, entry):
        with self._lock:
            self._nid += 1
            rid = self._nid
            entry["gen"] = self.gen
            self._pending[rid] = entry
            return rid

    def request(self, method, params=None, timeout=None):
        """The result; ChatError on an error answer, no answer in time (0: wait for ever) or an exit."""
        ev = threading.Event()
        entry = {"event": ev, "resp": None}
        rid = self._next(entry)
        try:
            self._write({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        except cp.ChatError:
            self._pending.pop(rid, None)
            raise
        t = self.rpc_timeout if timeout is None else timeout
        if not ev.wait(t if t else None):
            self._pending.pop(rid, None)
            raise cp.ChatError("process_exited", f"opencode did not answer {method} in {t} s")
        resp = entry["resp"] or {}
        if resp.get("_lost"):
            raise cp.ChatError("process_exited", "opencode acp exited")
        if resp.get("error"):
            err = resp["error"]
            raise cp.ChatError("bad_request", f"{method}: {err.get('message') if isinstance(err, dict) else err}")
        return resp.get("result")

    def request_async(self, method, params, callback):
        """Send; `callback(resp)` runs on the reader thread with the raw response ({"_lost": True} on an exit)."""
        rid = self._next({"callback": callback})
        try:
            self._write({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        except cp.ChatError:
            self._pending.pop(rid, None)
            raise
        return rid

    def notify(self, method, params=None):
        self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def respond(self, rid, result=None, error=None):
        msg = {"jsonrpc": "2.0", "id": rid}
        if error is not None:
            msg["error"] = error
        else:
            msg["result"] = result if result is not None else {}
        self._write(msg)

    def register(self, session_id, adapter):
        with self._lock:
            self._adapters[session_id] = adapter

    def unregister(self, session_id):
        with self._lock:
            self._adapters.pop(session_id, None)

    def _reader(self, proc, gen):
        try:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if isinstance(msg, dict):
                    self._dispatch(msg, gen)
        except (OSError, ValueError):
            pass
        self._lost(gen)

    def _dispatch(self, msg, gen):
        method = msg.get("method")
        if method is None and "id" in msg:
            with self._lock:
                entry = self._pending.pop(msg.get("id"), None)
            if entry is None:
                return
            if "callback" in entry:
                try:
                    entry["callback"](msg)
                except Exception:
                    pass
            else:
                entry["resp"] = msg
                entry["event"].set()
            return
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        sid = params.get("sessionId")
        if method == "session/update":
            update = params.get("update") if isinstance(params.get("update"), dict) else {}
            if update.get("sessionUpdate") == "available_commands_update" and sid:
                self.commands[sid] = update.get("availableCommands") or []
        with self._lock:
            adapter = self._adapters.get(sid) if sid else None
        if "id" in msg:  # the agent asks the client
            if method == "session/request_permission" and adapter is not None:
                adapter.inbox.put({"method": "_permission", "rpc": msg["id"], "gen": gen, "params": params})
                return
            try:
                if method == "session/request_permission":
                    self.respond(msg["id"], {"outcome": {"outcome": "cancelled"}})
                else:
                    self.respond(msg["id"], error={"code": -32601, "message": f"Dispatch does not handle {method}"})
            except cp.ChatError:
                pass
            return
        if adapter is not None and method == "session/update":
            adapter.inbox.put({"method": "session/update", "params": params})

    def _lost(self, gen):
        with self._lock:
            if gen != self.gen:
                return
            self.proc = None
            self.http = None
            lost = [(rid, e) for rid, e in self._pending.items() if e.get("gen") == gen]
            for rid, _ in lost:
                self._pending.pop(rid, None)
            adapters = list(self._adapters.values())
        for _, e in lost:
            if "callback" in e:
                try:
                    e["callback"]({"_lost": True})
                except Exception:
                    pass
            else:
                e["resp"] = {"_lost": True}
                e["event"].set()
        for a in adapters:
            a.inbox.put({"method": "_exited", "gen": gen})


_HUB = None
_HUB_LOCK = threading.Lock()


def hub():
    global _HUB
    with _HUB_LOCK:
        if _HUB is None:
            _HUB = OpenCodeHub()
        return _HUB


# ---------------------------------------------------------------- one session
class OpenCodeAdapter(cp.Adapter):
    agent = AGENT
    capabilities = CAPABILITIES
    state_on_set = False       # set_model applies on the next prompt; chatd emits the state

    def __init__(self, emit, session, cwd, options, hub=None):
        super().__init__(emit, session, cwd, options)
        self.hub = hub
        self.session_id = None
        self.attached = None       # the hub generation the session is loaded in
        self.inbox = queue.Queue()
        self.queue = []
        self.closed = False
        self.pending = {}          # permission id → {rpc, gen, options: {decision: optionId}, turn_id}, or a question: {question, directory, gen, turn_id, asked, ids}
        self.tools = {}            # tool call id → {"view": (name, input, oc), "started", "shown", "ended"}
        self.turn = None           # {id, started, message_id, tools, text, thinking, thinking_started, usage}
        self.commands_cache = []
        self._starting = False
        self._configured = {}      # what this session was last set to (model, effort)
        self._models = []          # every model OpenCode lists (the model option's values)
        self._effort_now = None    # the effort OpenCode runs the model with (its variant), shown in `state`
        self.transcript = ""

    # -- helpers
    def _hub(self):
        if self.hub is None:
            self.hub = hub()
        return self.hub

    def _mode(self):
        return "bypassPermissions" if self.options.get("permission_mode") == "bypassPermissions" else ""

    def state(self):
        s = super().state()
        s["pending"] = list(self.pending)
        s["permission_mode"] = self._mode()
        s["effort"] = self.options.get("effort") or self._effort_now
        return s

    def _read_options(self, options):
        """What the session's config options say now: its model, the models OpenCode lists, the effort."""
        if not isinstance(options, list):
            return
        model = config_value(options, "model")
        if model:
            self.options["model"] = model
        for o in options:
            if isinstance(o, dict) and o.get("id") == "model" and isinstance(o.get("options"), list):
                self._models = [x.get("value") for x in o["options"] if isinstance(x, dict) and isinstance(x.get("value"), str)]
        self._effort_now = config_value(options, "effort")

    def _emit_state(self):
        body = self.state()
        body["queue"] = list(self.queue or [])
        self.emit("state", **body)

    def alive(self):
        return not self.closed and (self.session_id is not None or self._starting)

    def _configure(self, h, sid):
        """Set the model and effort chatd was given (blocking; worker thread). An effort the model
        does not offer is left to OpenCode's default."""
        out = {}
        model = self.options.get("model")
        if model:
            r = h.request("session/set_config_option", {"sessionId": sid, "configId": "model", "value": model})
            out["options"] = (r or {}).get("configOptions")
        effort = self.options.get("effort")
        if effort:
            try:
                r = h.request("session/set_config_option", {"sessionId": sid, "configId": "effort", "value": effort})
                out["options"] = (r or {}).get("configOptions") or out.get("options")
            except cp.ChatError:
                self.options.pop("effort", None)
        self._configured = {"model": model, "effort": self.options.get("effort")}
        return out

    # -- lifecycle
    def start(self, resume=None):
        if _is_win():
            raise cp.ChatError("unsupported", "Windows 版暂不支持应用内聊天", fatal=True)
        h = self._hub()
        self._starting = True
        self.lifecycle = "starting"
        self.since = time.time()

        def work():
            try:
                h.ensure()
                gen = h.gen
                if resume:
                    try:
                        r = h.request("session/resume", {"sessionId": resume, "cwd": self.cwd, "mcpServers": []})
                    except cp.ChatError:
                        # an OpenCode without resume, or it refused: load it (it replays the history,
                        # which nobody is registered to hear)
                        r = h.request("session/load", {"sessionId": resume, "cwd": self.cwd, "mcpServers": []})
                    sid = resume
                else:
                    r = h.request("session/new", {"cwd": self.cwd, "mcpServers": []})
                    sid = (r or {}).get("sessionId")
                    if not sid:
                        raise cp.ChatError("spawn_failed", "session/new returned no session id")
                options = (r or {}).get("configOptions")
                set_ = self._configure(h, sid)
                self.inbox.put({"method": "_started", "sid": sid, "gen": gen, "resume": resume, "options": set_.get("options") or options})
            except cp.ChatError as e:
                code = "invalid_model" if "model" in str(e).lower() else ("agent_missing" if e.code == "spawn_failed" and "cannot start" in str(e) else "spawn_failed")
                self.inbox.put({"method": "_start_failed", "code": code, "message": str(e)})
            except Exception as e:  # never leave the session in `starting` forever
                self.inbox.put({"method": "_start_failed", "code": "spawn_failed", "message": f"{type(e).__name__}: {e}"})

        threading.Thread(target=work, name="opencode-start", daemon=True).start()

    def _started(self, msg):
        self._starting = False
        h = self._hub()
        sid = msg["sid"]
        if self.closed:
            try:
                h.request_async("session/close", {"sessionId": sid}, lambda r: None)
            except cp.ChatError:
                pass
            return
        self.session_id = sid
        self.attached = msg["gen"]
        self.session = cp.session_key(AGENT, sid)
        h.register(sid, self)
        self._read_options(msg.get("options"))
        self.options["model"] = self.options.get("model") or ""
        self._configured = {"model": self.options.get("model"), "effort": self.options.get("effort")}
        self.lifecycle = "idle"
        self.since = time.time()
        self.emit("opened", agent=AGENT, cwd=self.cwd, resumed=bool(msg.get("resume")), model=self.options["model"],
                  permission_mode=self._mode(), transcript_path=self.transcript, capabilities=list(self.capabilities))
        self._emit_state()
        cmds = h.commands.get(sid)
        if cmds:
            self._commands(cmds)

    def _start_failed(self, code, message):
        self._starting = False
        self.lifecycle = "error"
        self.since = time.time()
        self.emit("error", code=code, message=message, fatal=True)

    def close(self, reason="requested"):
        if self.closed:
            return
        self.closed = True
        h = self.hub
        if h is not None and self.session_id:
            for p in list(self.pending.values()):  # leave no question of ours hanging in OpenCode
                if p["gen"] == h.gen:
                    self._refuse(h, p)
            if self.turn and h.running():
                try:
                    h.notify("session/cancel", {"sessionId": self.session_id})
                except cp.ChatError:
                    pass
            h.unregister(self.session_id)
            if h.running():
                try:
                    h.request_async("session/close", {"sessionId": self.session_id}, lambda r: None)
                except cp.ChatError:
                    pass
        self.pending.clear()
        self._starting = False
        if self.turn:
            self._finish_turn("interrupted")
        self.lifecycle = "stopped"
        self.since = time.time()
        if self.session_id:
            self.emit("closed", reason=reason if reason in cp.CLOSE_REASONS else "requested")

    # -- turns
    def send(self, message):
        if self.closed or not self.session_id:
            raise cp.ChatError("no_such_session", "session is closed")
        if self.turn:
            raise cp.ChatError("session_busy", "a turn is running")
        text = message.get("text") or ""
        blocks = prompt_blocks(text, message.get("images"))
        turn_id = f"turn-{uuid.uuid4()}"
        self.turn = {"id": turn_id, "started": time.time(), "message_id": message.get("message_id", ""), "tools": 0, "text": "",
                     "thinking": "", "thinking_started": None, "usage": None, "cancelled": False}
        self.turn_id = turn_id
        self.tools = {}
        self.lifecycle = "running"
        self.since = time.time()
        self.emit("turn_started", turn_id=turn_id, message_id=message.get("message_id", ""), text=text, images_n=len(message.get("images") or []))
        h = self._hub()
        sid = self.session_id
        params = {"sessionId": sid, "prompt": blocks}
        done = lambda resp, tid=turn_id: self.inbox.put({"method": "_prompt_done", "turn_id": tid, "resp": resp})
        wanted = {"model": self.options.get("model"), "effort": self.options.get("effort")}
        if h.running() and self.attached == h.gen and wanted == self._configured:
            try:
                h.request_async("session/prompt", params, done)
                return
            except cp.ChatError:
                pass

        def work():
            # the process restarted (or the model changed): pick the session up again first, off chatd's loop
            try:
                h.ensure()
                if self.attached != h.gen:
                    try:
                        h.request("session/resume", {"sessionId": sid, "cwd": self.cwd, "mcpServers": []})
                    except cp.ChatError:
                        h.request("session/load", {"sessionId": sid, "cwd": self.cwd, "mcpServers": []})
                    self.attached = h.gen
                    self._configured = {}
                if wanted != self._configured:
                    self.inbox.put({"method": "_options", "options": self._configure(h, sid).get("options")})
                h.request_async("session/prompt", params, done)
            except cp.ChatError as e:
                done({"error": {"message": str(e)}, "_lost": e.code == "process_exited"})
            except Exception as e:
                done({"error": {"message": f"{type(e).__name__}: {e}"}})

        threading.Thread(target=work, name="opencode-prompt", daemon=True).start()

    def interrupt(self):
        if not self.turn:
            raise cp.ChatError("not_running", "nothing is running")
        self.turn["cancelled"] = True
        h = self._hub()
        for pid in list(self.pending):
            p = self.pending[pid]
            if p["gen"] == h.gen:
                self._refuse(h, p)
            self._resolved(pid, "deny", "interrupt")
        if h.running():
            try:
                h.notify("session/cancel", {"sessionId": self.session_id})
            except cp.ChatError:
                pass

    def set_model(self, model, effort=None):
        if not model:
            raise cp.ChatError("invalid_model", "model is empty")
        if "/" not in model:
            raise cp.ChatError("invalid_model", f"OpenCode models are provider/model (opencode models lists them), not {model!r}")
        if self._models and model not in self._models:
            raise cp.ChatError("invalid_model", f"OpenCode doesn't list {model} (its provider has no key, or the name is off): opencode models")
        self.options["model"] = model
        if effort:
            self.options["effort"] = effort
        # sent with the next prompt (send → _configure), so a running turn keeps its model

    def commands(self):
        return list(self.commands_cache)

    def _commands(self, available):
        out = []
        for c in available or []:
            if isinstance(c, dict) and c.get("name"):
                out.append({"name": str(c["name"]), "description": str(c.get("description") or "")[:200], "kind": "command"})
        self.commands_cache = out
        self.emit("commands", commands=out)

    # -- permissions
    def _refuse(self, h, p):
        """Best effort: cancel a permission OpenCode asked for, refuse one of its questions."""
        try:
            if "question" in p:
                h.question(p["gen"], p["question"], p["directory"], reject=True)
            else:
                h.respond(p["rpc"], {"outcome": {"outcome": "cancelled"}})
        except cp.ChatError:
            pass

    def permission(self, permission_id, decision, message=None, updated_input=None):
        p = self.pending.get(permission_id)
        if not p:
            raise cp.ChatError("bad_request", f"no pending permission {permission_id!r}")
        if "question" in p:
            if decision != "deny":
                raise cp.ChatError("bad_request", "this is a question: answer it (answer), or deny it")
            self._hub().question(p["gen"], p["question"], p["directory"], reject=True)
            self._resolved(permission_id, "deny", "dispatch")
            return
        option = p["options"].get(decision)
        if not option:
            raise cp.ChatError("unsupported", f"{decision} is not offered for this request")
        h = self._hub()
        if p["gen"] != h.gen:
            self.pending.pop(permission_id, None)
            raise cp.ChatError("process_exited", "opencode restarted; this request is gone")
        h.respond(p["rpc"], {"outcome": {"outcome": "selected", "optionId": option}})
        self._resolved(permission_id, decision, "dispatch")

    def answer(self, permission_id, answers):
        """Answer one of OpenCode's questions: {question id: [labels]} (a label alone, a question's index
        or its header also do); every question gets its labels, in order, unanswered ones none."""
        p = self.pending.get(permission_id)
        if not p or "question" not in p:
            raise cp.ChatError("bad_request", f"no pending question {permission_id!r}")
        if not isinstance(answers, dict):
            raise cp.ChatError("bad_request", "answers is {question: [answer, ...]}")
        out = []
        for i, (q, qid) in enumerate(zip(p["asked"], p["ids"])):
            v = answers.get(qid)
            if v is None:
                v = answers.get(str(i), answers.get(q.get("header")) if q.get("header") else None)
            values = v if isinstance(v, list) else ([] if v is None else [v])
            out.append([str(x) for x in values if str(x).strip()])
        self._hub().question(p["gen"], p["question"], p["directory"], answers=out)
        self._resolved(permission_id, "answered", "dispatch")

    def _on_question(self, msg):
        kind, props = msg["type"], msg["props"]
        rid = props.get("id") if kind == "question.asked" else props.get("requestID")
        if not rid:
            return
        known = next((k for k, p in self.pending.items() if p.get("question") == rid), None)
        if kind != "question.asked":
            if known:  # answered or dismissed elsewhere (OpenCode itself when the turn stops)
                self._resolved(known, "answered" if kind == "question.replied" else "deny", "elsewhere")
            return
        if known:
            return
        raw = [q for q in props.get("questions") or [] if isinstance(q, dict)]
        if not self.turn or not raw or self.options.get("permission_mode") == "bypassPermissions":
            # nobody is there to answer (an unattended session, or no turn of ours): OpenCode goes on without one
            try:
                self._hub().question(msg["gen"], rid, msg["directory"], reject=True)
            except cp.ChatError:
                pass
            return
        cards = question_cards(raw)
        pid = f"q-{uuid.uuid4().hex[:12]}"
        self.pending[pid] = {"question": rid, "directory": msg["directory"], "gen": msg["gen"], "turn_id": self.turn["id"],
                             "asked": asked_questions(raw), "ids": [c["id"] for c in cards]}
        fields = {"turn_id": self.turn["id"], "permission_id": pid, "kind": "question", "tool_name": "AskUserQuestion",
                  "input": {"questions": asked_questions(raw)}, "summary": cards[0]["text"][:180] if cards else "",
                  "reason": "", "cwd": self.cwd, "options": ["deny"], "questions": cards}
        tool = props.get("tool") if isinstance(props.get("tool"), dict) else {}
        if tool.get("callID"):
            fields["tool_id"] = tool["callID"]
        self.lifecycle = "waiting_input"
        self.since = time.time()
        self.emit("permission_request", **fields)

    def _resolved(self, permission_id, decision, by):
        self.pending.pop(permission_id, None)
        if self.lifecycle in ("waiting_permission", "waiting_input") and not self.pending:
            self.lifecycle = "running" if self.turn else "idle"
            self.since = time.time()
        self.emit("permission_resolved", permission_id=permission_id, decision=decision, by=by)

    def _on_permission(self, msg):
        params = msg["params"]
        call = params.get("toolCall") if isinstance(params.get("toolCall"), dict) else {}
        options = {}
        for decision, kinds in DECISION_KINDS.items():
            for kind in kinds:
                hit = next((o for o in params.get("options") or [] if isinstance(o, dict) and o.get("kind") == kind), None)
                if hit and decision not in options:
                    options[decision] = hit.get("optionId")
        if not self.turn or not options:
            try:
                self._hub().respond(msg["rpc"], {"outcome": {"outcome": "cancelled"}})
            except cp.ChatError:
                pass
            return
        if self.options.get("permission_mode") == "bypassPermissions" and options.get("allow"):
            # unattended (`dispatch agent start --auto`, a task's worker): OpenCode's questions are answered yes
            try:
                self._hub().respond(msg["rpc"], {"outcome": {"outcome": "selected", "optionId": options["allow"]}})
            except cp.ChatError:
                pass
            return
        tid = call.get("toolCallId") or ""
        known = self.tools.get(tid, {}).get("view")
        name, inp, _oc = tool_view(dict(call, sessionUpdate="tool_call"), known)
        pid = f"perm-{uuid.uuid4().hex[:12]}"
        self.pending[pid] = {"rpc": msg["rpc"], "gen": msg["gen"], "options": options, "turn_id": self.turn["id"]}
        fields = {"turn_id": self.turn["id"], "permission_id": pid, "kind": PERMISSION_KIND.get(call.get("kind"), "other"),
                  "tool_name": name, "input": inp, "summary": cp.step_phrase(name, inp), "reason": _str(call.get("title")),
                  "cwd": self.cwd, "options": [d for d in ("allow", "allow_session", "deny") if d in options]}
        if tid:
            fields["tool_id"] = tid
        self.lifecycle = "waiting_permission"
        self.since = time.time()
        self.emit("permission_request", **fields)

    # -- OpenCode's updates → events
    def _end_thinking(self):
        t = self.turn
        if t and t["thinking_started"] is not None:
            self.emit("thinking_done", turn_id=t["id"], text=t["thinking"], duration_ms=int((time.time() - t["thinking_started"]) * 1000))
            t["thinking"], t["thinking_started"] = "", None

    def _end_text(self):
        t = self.turn
        if t and t["text"]:
            self.emit("text_done", turn_id=t["id"], text=t["text"])
            t["text"] = ""

    def _show_tool(self, tid, rec):
        name, inp, _oc = rec["view"]
        rec["shown"] = True
        self.turn["tools"] += 1
        self.emit("tool_start", turn_id=self.turn["id"], tool_id=tid, name=name, kind=cp.tool_kind(name), input=inp, summary=cp.step_phrase(name, inp))

    def _on_update(self, update):
        kind = update.get("sessionUpdate")
        if kind == "available_commands_update":
            self._commands(update.get("availableCommands"))
            return
        if kind == "config_option_update":
            self._read_options(update.get("configOptions"))
            return
        t = self.turn
        if not t or t["cancelled"] and kind in ("agent_message_chunk", "agent_thought_chunk"):
            return
        content = update.get("content") if isinstance(update.get("content"), dict) else {}
        if kind == "agent_message_chunk" and content.get("type") == "text" and content.get("text"):
            self._end_thinking()
            t["text"] += content["text"]
            self.emit("text_delta", turn_id=t["id"], text=content["text"])
        elif kind == "agent_thought_chunk" and content.get("type") == "text" and content.get("text"):
            if t["thinking_started"] is None:
                t["thinking_started"] = time.time()
            t["thinking"] += content["text"]
            self.emit("thinking_delta", turn_id=t["id"], text=content["text"])
        elif kind in ("tool_call", "tool_call_update"):
            tid = update.get("toolCallId") or ""
            if not tid:
                return
            self._end_thinking()
            self._end_text()
            rec = self.tools.get(tid)
            if rec is None:
                rec = self.tools[tid] = {"view": tool_view(update), "started": time.time(), "shown": False, "ended": False}
            else:
                rec["view"] = tool_view(update, rec["view"])
            status = update.get("status")
            name, inp, _oc = rec["view"]
            has_input = any(v not in ("", None) for v in inp.values())
            if not rec["shown"] and (has_input or status in ("in_progress", "completed", "failed")):
                self._show_tool(tid, rec)
            if status in ("completed", "failed") and not rec["ended"]:
                rec["ended"] = True
                output, truncated = cp.truncate_output(tool_output(update))
                fields = {"turn_id": t["id"], "tool_id": tid, "ok": status == "completed", "output": output, "truncated": truncated,
                          "duration_ms": int((time.time() - rec["started"]) * 1000)}
                if cp.tool_kind(name) == "shell":
                    code = exit_code_of(update)
                    fields["exit_code"] = code if code is not None else (0 if status == "completed" else None)
                self.emit("tool_end", **fields)
        elif kind == "usage_update":
            t["context"] = {k: update[k] for k in ("used", "size") if isinstance(update.get(k), (int, float))}
            if isinstance(update.get("used"), (int, float)):
                self.emit("life_usage", usage={"input": update["used"]}, window=update.get("size"))

    def _finish_turn(self, status, error=None, usage=None):
        t = self.turn
        if not t:
            return
        self._end_thinking()
        self._end_text()
        for tid, rec in self.tools.items():  # tools OpenCode never finished (cancelled, crashed)
            if rec["shown"] and not rec["ended"]:
                rec["ended"] = True
                self.emit("tool_end", turn_id=t["id"], tool_id=tid, ok=False, output="", truncated=False, duration_ms=int((time.time() - rec["started"]) * 1000))
        for pid in [k for k, p in self.pending.items() if p["turn_id"] == t["id"]]:
            self.pending.pop(pid, None)
        fields = {"turn_id": t["id"], "status": status, "duration_ms": int((time.time() - t["started"]) * 1000), "num_tools": t["tools"]}
        if error:
            fields["error"] = error[:500]
        if usage:
            fields["usage"] = usage
        self.turn = None
        self.turn_id = None
        self.lifecycle = "idle" if not self.closed else "stopped"
        self.since = time.time()
        self.emit("turn_done", **fields)
        if not self.closed:
            self._emit_state()

    def _prompt_done(self, msg):
        t = self.turn
        if not t or t["id"] != msg["turn_id"]:
            return
        resp = msg.get("resp") or {}
        if resp.get("_lost"):
            return  # `_exited` ends it
        if resp.get("error"):
            err = resp["error"]
            text = err.get("message") if isinstance(err, dict) else str(err)
            self._finish_turn("interrupted" if t["cancelled"] else "error", None if t["cancelled"] else (text or "OpenCode failed"))
            return
        result = resp.get("result") or {}
        stop = result.get("stopReason") or "end_turn"
        status = "interrupted" if t["cancelled"] or stop == "cancelled" else STOP_STATUS.get(stop, "success")
        u = result.get("usage") if isinstance(result.get("usage"), dict) else {}
        usage = {k: u[src] for k, src in (("input", "inputTokens"), ("output", "outputTokens"), ("cache_read", "cachedReadTokens"), ("cache_write", "cachedWriteTokens")) if isinstance(u.get(src), (int, float))}
        if usage:
            self.emit("life_usage", usage=usage, request_id=t["id"])
        self._finish_turn(status, "OpenCode refused to answer" if stop == "refusal" else None, usage or None)

    def _exited(self, msg):
        if msg.get("gen") != self.attached:
            return
        self.attached = None
        self.pending.clear()
        if self.turn:
            self._finish_turn("error", "opencode acp exited")
            self.emit("error", code="process_exited", message="opencode acp exited; the next message starts it again", fatal=False)

    # -- the reader's inbox → events (chatd's thread)
    def drain(self):
        did = False
        while True:
            try:
                msg = self.inbox.get_nowait()
            except queue.Empty:
                break
            m = msg.get("method")
            if self.closed and m != "_started":
                continue
            did = True
            try:
                if m == "_started":
                    self._started(msg)
                elif m == "_start_failed":
                    self._start_failed(msg["code"], msg["message"])
                elif m == "session/update":
                    update = (msg.get("params") or {}).get("update")
                    if isinstance(update, dict):
                        self._on_update(update)
                elif m == "_permission":
                    self._on_permission(msg)
                elif m == "_question":
                    self._on_question(msg)
                elif m == "_prompt_done":
                    self._prompt_done(msg)
                elif m == "_exited":
                    self._exited(msg)
                elif m == "_options":
                    self._read_options(msg.get("options"))
            except cp.ChatError as e:
                self.emit("error", code=e.code, message=str(e), fatal=e.fatal)
        return did
