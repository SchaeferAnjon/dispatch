# -*- coding: utf-8 -*-
"""Claude Code driver for chatd: one long-lived `claude -p --input-format stream-json
--output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio`
child per session (design/in-app-chat/spike/README.md section A).

The child's stdout is read on a thread into a queue; chatd's loop calls `drain()`, which turns
Claude's own events into the normalized ones of chat_protocol.py. Nothing here writes stdout.

What Claude sends, in order, for one session:
    control_response(initialize)  commands, models, pid; answers our `initialize` (hooks run first)
    system/init                   once per turn, after our user message; model and permission mode
    stream_event                  raw Messages API deltas (text_delta / thinking_delta)
    assistant                     one complete block (text, thinking, tool_use)
    user                          tool_result blocks
    control_request can_use_tool  a permission question (we answer with control_response)
    result                        end of turn (success / error_during_execution after interrupt)
The child is never sent SIGINT (it exits); interrupt is a control_request.
"""
import base64
from lang import t as _t
import collections
import glob
import json
import os
import queue
import re
import subprocess
import threading
import time
import uuid
import sys
sys.dont_write_bytecode = True

import chat_protocol as cp
import dplatform as P
import net

AGENT = "claude-code"
WINDOWS_REASON = _t("In-app chat is not supported on Windows yet", "Windows 版暂不支持应用内聊天")
# `initialize` waits for the user's SessionStart hooks (2 to 3 s here, over 10 s on a busy machine).
# The version check in probe() is what rules out a CLI without this protocol, so a quiet start is
# slow, not unsupported: it gets INIT_TIMEOUT, and every hook that starts pushes the deadline out.
INIT_TIMEOUT = 45.0
INIT_TIMEOUT_BUSY = 45.0
CLOSE_WAIT = 10.0
SHUTDOWN_TURN_WAIT = 3.0
MODEL_RE = re.compile(r"(?!-)[A-Za-z0-9._:/\[\]-]{1,80}")
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
# An MCP server that cannot be reached (a remote HTTP one behind a VPN) must not hold a session at
# startup for a minute: Claude Code waits MCP_TIMEOUT ms per server, then goes on without it. The same
# 20 s the Agents window gives (dispatch-ide patches/260-session-liveness.patch); a value the person set wins.
MCP_STARTUP_TIMEOUT_MS = 20000


def spawn_env(env=None):
    e = cp.child_env(env)
    net.apply(e)  # this Mac's proxy (net.py): Claude Code reads HTTPS_PROXY
    e.setdefault("MCP_TIMEOUT", str(MCP_STARTUP_TIMEOUT_MS))
    e["DISPATCH_LIFE_MANAGED"] = str(os.getpid())
    return e


PERMISSION_KIND = {"Bash": "command", "PowerShell": "command", "Read": "read", "WebFetch": "fetch", "WebSearch": "fetch", "AskUserQuestion": "question"}


def claude_command():
    """argv[0..] of the Claude CLI; tests replace it with a fake."""
    return [P.which("claude") or "claude"]


def probe():
    """{available, version, supported, reason} for `hello`."""
    exe = P.which("claude")
    if not exe:
        return {"available": False, "version": "", "supported": False, "reason": _t("No claude command found (Claude Code is not installed, or the Terminal cannot find it)", "没找到 claude 命令（Claude Code 没装，或不在 PATH 里）")}
    try:
        r = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=15, env=cp.child_env(), stdin=subprocess.DEVNULL)
        text = (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return {"available": True, "version": "", "supported": False, "reason": _t(f"claude --version did not run: {str(e)[:160]}", f"claude --version 没跑通：{str(e)[:160]}")}
    version = cp.parse_version(text)
    shown = ".".join(map(str, version)) if version else text.strip()[:40]
    if P.IS_WIN:
        return {"available": True, "version": shown, "supported": False, "reason": WINDOWS_REASON}
    import engines
    minimum = engines.get("claude").chat_min_version
    if not cp.version_ok(version, minimum):
        need = ".".join(map(str, minimum))
        return {"available": True, "version": shown, "supported": False, "reason": _t(f"Claude Code {shown or '(version unknown)'} is too old: in-app chat needs at least {need}; run it in a terminal for now, or update Claude Code", f"Claude Code {shown or '版本未知'} 太旧，应用内聊天至少要 {need}；先在终端里跑，或升级 Claude Code")}
    return {"available": True, "version": shown, "supported": True, "reason": ""}


def project_dir_name(cwd):
    """Claude Code's folder name for a working directory under ~/.claude/projects."""
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def transcript_path(cwd, session_id, home=None):
    home = home or os.path.expanduser("~")
    root = os.path.join(home, ".claude", "projects")
    want = os.path.join(root, project_dir_name(cwd), session_id + ".jsonl")
    if os.path.exists(want):
        return want
    # A resumed conversation keeps the folder it was started in (and very long paths get hashed).
    hits = glob.glob(os.path.join(root, "*", session_id + ".jsonl"))
    return hits[0] if hits else want


def summary_of(name, inp):
    if name == "AskUserQuestion" and isinstance(inp, dict):
        qs = [q for q in inp.get("questions") or [] if isinstance(q, dict)]
        if qs:
            return str(qs[0].get("question") or qs[0].get("header") or name)[:180]
    try:
        from activity import operation_summary
        return operation_summary(name, inp if isinstance(inp, dict) else {}, json.dumps(inp, ensure_ascii=False)[:2000])
    except Exception:
        return name


def diff_of(name, inp):
    """{path, kind, old, new} for an edit tool's input; None for anything else."""
    if not isinstance(inp, dict) or name not in EDIT_TOOLS:
        return None
    path = str(inp.get("file_path") or inp.get("notebook_path") or inp.get("path") or "")
    if name == "Edit":
        return {"path": path, "kind": "edit", "old": str(inp.get("old_string") or ""), "new": str(inp.get("new_string") or "")}
    if name == "MultiEdit":
        edits = [e for e in inp.get("edits") or [] if isinstance(e, dict)]
        return {"path": path, "kind": "edit", "old": "\n".join(str(e.get("old_string") or "") for e in edits), "new": "\n".join(str(e.get("new_string") or "") for e in edits)}
    if name == "Write":
        return {"path": path, "kind": "write", "old": "", "new": str(inp.get("content") or "")}
    return {"path": path, "kind": "edit", "old": "", "new": str(inp.get("new_source") or "")}


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(c.get("text") or "") if isinstance(c, dict) else str(c) for c in content if not isinstance(c, dict) or c.get("type") in ("text", None))
    return "" if content is None else str(content)


def questions_of(inp):
    out = []
    for i, q in enumerate((inp or {}).get("questions") or []):
        if not isinstance(q, dict):
            continue
        text = str(q.get("question") or q.get("header") or _t(f"Question {i + 1}", f"问题 {i + 1}"))
        opts = [str(o.get("label") if isinstance(o, dict) else o) for o in q.get("options") or []]
        out.append({"id": text, "text": text, "options": opts, "multi": bool(q.get("multiSelect"))})
    return out


def slash_commands(raw):
    out = []
    for c in raw or []:
        if not isinstance(c, dict) or not c.get("name"):
            continue
        desc = str(c.get("description") or "")
        kind = "builtin" if c.get("builtin") else "skill" if desc.endswith(("(user)", "(project)", "(plugin)")) or ":" in c["name"] else "command"
        out.append({"name": str(c["name"]), "description": desc[:300], "kind": kind})
    return out


class ClaudeAdapter(cp.Adapter):
    agent = AGENT
    # No thinking_text: this CLI streams empty thinking blocks (signature only), so the page shows
    # "thought for N s" from thinking_done instead.
    capabilities = ("allow_session", "set_model", "set_permission_mode", "images_base64", "queue", "commands")

    def __init__(self, emit, session, cwd, options):
        super().__init__(emit, session, cwd, options)
        _, self.session_id = cp.split_key(session)
        self.proc = None
        self.events = queue.Queue()
        self.stderr_tail = collections.deque(maxlen=20)
        self.resumed = False
        self._ctrl = {}           # request_id → (subtype, extra)
        self._init_deadline = None
        self._opened = False
        self._perms = {}          # permission_id → {tool_name, input, suggestions, kind}
        self._tools = {}          # tool_id → (name, input, started)
        self._turn = None         # {turn_id, started, tools, thinking_tokens, thinking_started}
        self._interrupting = False
        self._closing = None
        self._closed_sent = False
        self._eof = False
        self._commands = []
        self._saw_init = False
        self.transcript = ""
        self._err_thread = None
        self._cost_total = 0.0

    # ------------------------------------------------------------ process
    def argv(self, resume):
        a = claude_command() + ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                                "--include-partial-messages", "--permission-prompt-tool", "stdio"]
        a += ["--resume", resume] if resume else ["--session-id", self.session_id]
        model = self.options.get("model")
        if model:
            if not MODEL_RE.fullmatch(str(model)):
                raise cp.ChatError("invalid_model", _t(f"Not a valid model name: {model}", f"模型名无效：{model}"), fatal=True)
            a += ["--model", str(model)]
        mode = self.options.get("permission_mode")
        if mode in cp.PERMISSION_MODES:  # anything else came from the user's own settings: leave it to them
            a += ["--permission-mode", mode]
        return a

    def start(self, resume=None):
        if P.IS_WIN:
            raise cp.ChatError("unsupported", WINDOWS_REASON, fatal=True)
        self.resumed = bool(resume)
        if resume and resume != self.session_id:
            raise cp.ChatError("bad_request", "resume id and session key disagree", fatal=True)
        argv = self.argv(resume)
        kw = {"creationflags": P.no_window_flags()} if P.IS_WIN else {"start_new_session": True}
        try:
            self.proc = subprocess.Popen(argv, cwd=self.cwd, env=spawn_env(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", bufsize=1, **kw)
        except FileNotFoundError:
            raise cp.ChatError("agent_missing", _t("No claude command found", "没找到 claude 命令"), fatal=True)
        except OSError as e:
            raise cp.ChatError("spawn_failed", _t(f"Claude Code did not start: {e}", f"Claude Code 没起来：{e}"), fatal=True)
        threading.Thread(target=self._read, args=(self.proc.stdout,), daemon=True).start()
        self._err_thread = threading.Thread(target=self._read_err, args=(self.proc.stderr,), daemon=True)
        self._err_thread.start()
        self.lifecycle = "starting"
        self.since = time.time()
        self._init_deadline = time.time() + INIT_TIMEOUT
        self._control({"subtype": "initialize"})
        self.emit("state", **self.state())

    def _read(self, stream):
        try:
            for line in stream:
                line = line.strip()
                if not line:
                    continue
                try:
                    self.events.put(json.loads(line))
                except ValueError:
                    self.events.put({"type": "_text", "text": line[:500]})
        except Exception:
            pass
        self.events.put({"type": "_eof"})

    def _read_err(self, stream):
        try:
            for line in stream:
                if line.strip():
                    self.stderr_tail.append(line.rstrip()[:400])
        except Exception:
            pass

    def _write(self, obj):
        if not self.alive() or self._eof:
            raise cp.ChatError("not_running", _t("The Claude process has quit", "Claude 进程已经退出"))
        try:
            self.proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
            self.proc.stdin.flush()
        except (OSError, ValueError) as e:
            raise cp.ChatError("process_exited", _t(f"Cannot write to the Claude process: {e}", f"写不进 Claude 进程：{e}"))

    def _control(self, request, extra=None):
        rid = "dispatch-" + uuid.uuid4().hex[:12]
        self._ctrl[rid] = (request["subtype"], extra)
        self._write({"type": "control_request", "request_id": rid, "request": request})
        return rid

    def alive(self):
        return bool(self.proc) and self.proc.poll() is None

    def state(self):
        s = super().state()
        if self.proc:
            s["pid"] = self.proc.pid
        return s

    def _set(self, lifecycle):
        if lifecycle != self.lifecycle:
            self.lifecycle = lifecycle
            self.since = time.time()

    # ------------------------------------------------------------ commands
    def send(self, message):
        if self.lifecycle != "idle":
            raise cp.ChatError("session_busy", _t("Claude is still busy; this message has to wait in line", "Claude 还在忙，这句话要排队"))
        content = []
        text = message.get("text") or ""
        if text:
            content.append({"type": "text", "text": text})
        images = message.get("images") or []
        for img in images:
            data, media = img.get("data"), img.get("media_type") or "image/png"
            if not data and img.get("path"):
                try:
                    with open(img["path"], "rb") as f:
                        raw = f.read(cp.IMAGE_LIMIT + 1)
                except OSError as e:
                    raise cp.ChatError("bad_request", _t(f"Cannot read the image: {e}", f"读不了图片：{e}"))
                if len(raw) > cp.IMAGE_LIMIT:
                    raise cp.ChatError("too_large", _t("The image is over 8 MB", "图片超过 8 MB"))
                data = base64.b64encode(raw).decode()
                ext = os.path.splitext(img["path"])[1].lower().lstrip(".")
                media = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}.get(ext, "image/png")
            if not data:
                continue
            if len(data) * 3 // 4 > cp.IMAGE_LIMIT:
                raise cp.ChatError("too_large", _t("The image is over 8 MB", "图片超过 8 MB"))
            content.append({"type": "image", "source": {"type": "base64", "media_type": media, "data": data}})
        if not content:
            raise cp.ChatError("bad_request", "send: nothing to send")
        turn_id = "turn-" + uuid.uuid4().hex[:12]
        self._write({"type": "user", "message": {"role": "user", "content": content}, "parent_tool_use_id": None, "session_id": ""})
        self._turn = {"turn_id": turn_id, "started": time.time(), "tools": 0, "thinking_tokens": None, "thinking_started": None}
        self.turn_id = turn_id
        self._interrupting = False
        self._set("running")
        self.emit("turn_started", turn_id=turn_id, message_id=message.get("message_id", ""), text=text, images_n=len(images))

    def interrupt(self):
        if not self._turn:
            raise cp.ChatError("not_running", _t("Claude is not running now", "Claude 现在没在跑"))
        if not self._interrupting:
            self._interrupting = True
            self._control({"subtype": "interrupt"})

    def permission(self, permission_id, decision, message=None, updated_input=None):
        p = self._perms.get(permission_id)
        if not p:
            raise cp.ChatError("bad_request", _t("This permission request was handled already", "这个权限请求已经处理过了"))
        if p["kind"] == "question" and decision != "deny":
            # a plain allow would hand Claude the question back with no answers in it
            raise cp.ChatError("bad_request", _t("This asks you a question: pick the answers, then click Answer", "这是在问你问题：选好答案再点回答"))
        if decision == "deny":
            resp = {"behavior": "deny", "message": message or _t("The person denied it in Dispatch", "用户在 Dispatch 里拒绝了")}
        else:
            resp = {"behavior": "allow", "updatedInput": updated_input if isinstance(updated_input, dict) else p["input"]}
            if decision == "allow_session":
                if not p["suggestions"]:
                    raise cp.ChatError("unsupported", _t("This request has no rule to remember; it can only be allowed once", "这个请求没有可记住的规则，只能允许一次"))
                resp["updatedPermissions"] = p["suggestions"]
        self._respond(permission_id, resp)
        self._resolved(permission_id, decision)
        if decision == "allow_session":
            # A suggestion can switch the session's mode (edits: acceptEdits). Claude applies it at
            # once but only reports it in the next turn's system/init, so say it now.
            mode = next((x.get("mode") for x in p["suggestions"] if isinstance(x, dict) and x.get("type") == "setMode"
                         and x.get("destination") in ("session", None) and x.get("mode") in cp.PERMISSION_MODES), None)
            if mode and mode != self.options.get("permission_mode"):
                self.options["permission_mode"] = mode
                self.emit("state", **self.state())

    def answer(self, permission_id, answers):
        p = self._perms.get(permission_id)
        if not p:
            raise cp.ChatError("bad_request", _t("This question was answered already", "这个问题已经回答过了"))
        if p["kind"] != "question":
            raise cp.ChatError("bad_request", _t("This is not a question", "这不是一个问题"))
        if not isinstance(answers, dict):
            raise cp.ChatError("bad_request", _t("answers is {question: [answers]}", "answers 是 {问题: [答案]}"))
        flat = {str(q): ", ".join(str(x) for x in (v if isinstance(v, list) else [v])) for q, v in answers.items()}
        self._respond(permission_id, {"behavior": "allow", "updatedInput": {**p["input"], "answers": flat}})
        self._resolved(permission_id, "answered")

    def _respond(self, request_id, response):
        self._write({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": response}})

    def _resolved(self, permission_id, decision):
        self._perms.pop(permission_id, None)
        self.emit("permission_resolved", permission_id=permission_id, decision=decision, by="dispatch")
        if not self._perms and self.lifecycle in ("waiting_permission", "waiting_input"):
            self._set("running" if self._turn else "idle")

    def set_model(self, model, effort=None):
        if not MODEL_RE.fullmatch(str(model or "")):
            raise cp.ChatError("invalid_model", _t(f"Not a valid model name: {model}", f"模型名无效：{model}"))
        if self._turn:
            raise cp.ChatError("session_busy", _t("Change the model after this turn", "这一轮跑完再换模型"))
        self._control({"subtype": "set_model", "model": model}, {"model": model})

    def set_permission_mode(self, mode):
        if mode not in cp.PERMISSION_MODES:
            raise cp.ChatError("invalid_model", _t(f"Unknown permission mode: {mode}", f"不认识的权限模式：{mode}"))
        self._control({"subtype": "set_permission_mode", "mode": mode}, {"mode": mode})

    def commands(self):
        return list(self._commands)

    # close in three steps, so chatd's shutdown can run each one for every session at once
    def close_begin(self, reason="requested"):
        """Step 1: interrupt a running turn (the transcript then records the stop)."""
        self._closing = self._closing or reason
        if self.alive() and self._turn:
            try:
                self.interrupt()
            except cp.ChatError:
                pass

    def close_busy(self):
        """Still finishing the interrupted turn."""
        return bool(self._turn) and self.alive()

    def close_release(self):
        """Step 2: close stdin; the CLI then exits on its own."""
        if self.alive():
            self._set("stopping")
            try:
                self.proc.stdin.close()
            except Exception:
                pass

    def close(self, reason="requested", wait=CLOSE_WAIT):
        self._closing = self._closing or reason
        reason = self._closing
        if self.alive():
            if self._turn:
                self.close_begin(reason)
                end = time.time() + SHUTDOWN_TURN_WAIT
                while self._turn and time.time() < end and self.alive():
                    self.drain()
                    time.sleep(0.02)
            self.close_release()
            try:
                self.proc.wait(wait)
            except subprocess.TimeoutExpired:
                self.proc.terminate()
                try:
                    self.proc.wait(max(0.5, min(3, wait)))
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(3)
            end = time.time() + 2
            while not self._eof and time.time() < end:
                self.drain()
                time.sleep(0.02)
        self.drain()
        if not self._closed_sent:
            self._finish_turn_on_exit()
            self._closed_sent = True
            self._set("stopped")
            self.emit("closed", reason=reason, exit_code=self.proc.poll() if self.proc else None)

    # ------------------------------------------------------------ events
    def drain(self):
        did = False
        while True:
            try:
                obj = self.events.get_nowait()
            except queue.Empty:
                break
            did = True
            try:
                self._handle(obj)
            except cp.ChatError as e:
                self.emit("error", code=e.code, message=str(e), fatal=e.fatal)
        if self._init_deadline and not self._opened and time.time() > self._init_deadline and not self._eof:
            self._init_deadline = None
            self._fail_start("spawn_failed", _t(f"Claude Code was not ready within {int(INIT_TIMEOUT)} s (the Mac is too busy, or a start-up hook hangs); open it again, or run it in a terminal for now", f"Claude Code {int(INIT_TIMEOUT)} 秒内没准备好（机器太忙，或卡在启动钩子上）；再开一次，或先在终端里跑"))
            did = True
        return did

    def _fail_start(self, code, message):
        self._closed_sent = True
        self._set("error")
        self.emit("error", code=code, message=message, fatal=True)
        if self.alive():
            try:
                self.proc.stdin.close()
            except Exception:
                pass
            try:
                self.proc.terminate()
                self.proc.wait(3)
            except Exception:
                pass
        self.emit("closed", reason="error", exit_code=self.proc.poll() if self.proc else None)

    def _handle(self, m):
        t = m.get("type")
        if t == "_eof":
            self._on_exit()
        elif t == "_text":
            self.stderr_tail.append(m["text"])
        elif t == "control_response":
            self._on_control_response(m.get("response") or {})
        elif t == "control_request":
            self._on_control_request(m.get("request_id"), m.get("request") or {})
        elif t == "system":
            self._on_system(m)
        elif t == "stream_event":
            self._on_stream(m)
        elif t == "assistant":
            self._on_assistant(m)
        elif t == "user":
            self._on_user(m)
        elif t == "result":
            self._on_result(m)
        elif t == "rate_limit_event":
            info = m.get("rate_limit_info") or {}
            windows = [{"label": k, "used_percent": round(v["utilization"] * 100, 1) if isinstance(v.get("utilization"), (int, float)) else None,
                        "resets_at": v.get("resetsAt")} for k, v in (info.get("unifiedWindows") or {}).items() if isinstance(v, dict)]
            if windows:
                self.emit("rate_limit", agent=AGENT, windows=windows)
        elif t == "control_cancel_request":
            rid = m.get("request_id")
            if rid in self._perms:
                self._perms.pop(rid, None)
                self.emit("permission_resolved", permission_id=rid, decision="deny", by="elsewhere")

    def _on_control_response(self, r):
        rid = r.get("request_id")
        subtype, extra = self._ctrl.pop(rid, (None, None))
        ok = r.get("subtype") == "success"
        body = r.get("response") or {}
        if subtype == "initialize":
            self._init_deadline = None
            if not ok:
                self._fail_start("unsupported_version", _t(f"Claude Code refused to start: {r.get('error') or 'reason unknown'}", f"Claude Code 拒绝了初始化：{r.get('error') or '未知原因'}"))
                return
            self._commands = slash_commands(body.get("commands"))
            mode = body.get("current_permission_mode")
            if mode and not self.options.get("permission_mode"):
                self.options["permission_mode"] = mode
            self._opened = True
            self.transcript = transcript_path(self.cwd, self.session_id)
            self._set("idle")
            self.emit("opened", agent=AGENT, cwd=self.cwd, resumed=self.resumed, model=self.options.get("model") or "",
                      permission_mode=self.options.get("permission_mode") or "", transcript_path=self.transcript,
                      capabilities=list(self.capabilities))
            self.emit("state", **self.state())
        elif subtype == "set_model":
            if not ok:
                self.emit("error", code="invalid_model", message=_t(f"Cannot change the model: {r.get('error') or ''}".strip(": "), f"换不了模型：{r.get('error') or ''}".strip("：")), fatal=False)
                return
            self.options["model"] = extra["model"]
            self.emit("state", **self.state())
        elif subtype == "set_permission_mode":
            if not ok:
                self.emit("error", code="invalid_model", message=_t(f"Cannot change the permission mode: {r.get('error') or ''}".strip(": "), f"换不了权限模式：{r.get('error') or ''}".strip("：")), fatal=False)
                return
            self.options["permission_mode"] = body.get("mode") or extra["mode"]
            self.emit("state", **self.state())

    def _on_control_request(self, rid, req):
        sub = req.get("subtype")
        if sub != "can_use_tool":
            # hook_callback / mcp_message are only sent for things we never registered.
            try:
                self._write({"type": "control_response", "response": {"subtype": "error", "request_id": rid, "error": f"Dispatch does not handle {sub}"}})
            except cp.ChatError:
                pass
            return
        name = str(req.get("tool_name") or "")
        inp = req.get("input") if isinstance(req.get("input"), dict) else {}
        kind = "edit" if name in EDIT_TOOLS else PERMISSION_KIND.get(name, "other")
        suggestions = req.get("permission_suggestions") or []
        self._perms[rid] = {"tool_name": name, "input": inp, "suggestions": suggestions, "kind": kind}
        options = ["allow", "allow_session", "deny"] if suggestions and kind != "question" else ["allow", "deny"]
        fields = {"permission_id": rid, "kind": kind, "tool_name": name, "input": inp, "summary": summary_of(name, inp),
                  "reason": str(req.get("decision_reason") or req.get("description") or req.get("blocked_path") or ""),
                  "cwd": self.cwd, "options": options, "turn_id": self.turn_id or ""}
        if req.get("tool_use_id"):
            fields["tool_id"] = req["tool_use_id"]
        d = diff_of(name, inp)
        if d:
            fields["diff"] = d
        if kind == "question":
            fields["questions"] = questions_of(inp)
        self._set("waiting_input" if kind == "question" else "waiting_permission")
        self.emit("permission_request", **fields)

    def _on_system(self, m):
        sub = m.get("subtype")
        if sub == "init":
            self._saw_init = True
            if m.get("model"):
                self.options["model"] = m["model"]
            if m.get("permissionMode"):
                self.options["permission_mode"] = m["permissionMode"]
        elif sub == "thinking_tokens":
            if self._turn:
                self._turn["thinking_tokens"] = m.get("estimated_tokens")
        elif sub == "commands_changed":
            self._commands = slash_commands(m.get("commands"))
            self.emit("commands", commands=self._commands)
        elif sub == "hook_response":
            # Hooks that worked are routine (SessionStart, Stop run every turn); failures are news.
            if m.get("exit_code") not in (0, None) or m.get("outcome") not in ("success", None):
                detail = (m.get("stderr") or m.get("output") or "").strip().splitlines()
                self.emit("system", kind="hook", text=_t(f"Hook {m.get('hook_name') or m.get('hook_event') or ''} failed" + (f": {detail[-1][:300]}" if detail else ""), f"钩子 {m.get('hook_name') or m.get('hook_event') or ''} 失败" + (f"：{detail[-1][:300]}" if detail else "")))
        elif sub == "hook_started" and self._init_deadline:
            # hooks still running: initialize is on its way
            self._init_deadline = max(self._init_deadline, time.time() + INIT_TIMEOUT_BUSY)

    def _on_stream(self, m):
        if not self._turn or m.get("parent_tool_use_id"):
            return
        ev = m.get("event") or {}
        et = ev.get("type")
        if et == "content_block_start" and (ev.get("content_block") or {}).get("type") == "thinking":
            self._turn["thinking_started"] = time.time()
        elif et == "content_block_delta":
            d = ev.get("delta") or {}
            if d.get("type") == "text_delta" and d.get("text"):
                self.emit("text_delta", turn_id=self.turn_id, text=d["text"])
            elif d.get("type") == "thinking_delta":
                if self._turn["thinking_started"] is None:
                    self._turn["thinking_started"] = time.time()
                if d.get("estimated_tokens"):
                    self._turn["thinking_tokens"] = d["estimated_tokens"]
                if d.get("thinking"):
                    self.emit("thinking_delta", turn_id=self.turn_id, text=d["thinking"])

    def _on_assistant(self, m):
        if not self._turn:
            return
        parent = m.get("parent_tool_use_id")
        if not parent and (m.get("message") or {}).get("usage"):
            from session_life import claude_usage
            msg = m["message"]
            self.emit("life_usage", usage=claude_usage(msg["usage"]), request_id=m.get("requestId") or msg.get("id") or "", model=msg.get("model"))
        content = (m.get("message") or {}).get("content") or []
        for c in content if isinstance(content, list) else []:
            if not isinstance(c, dict):
                continue
            ct = c.get("type")
            if ct == "text" and not parent:
                self.emit("text_done", turn_id=self.turn_id, text=c.get("text") or "")
            elif ct == "thinking" and not parent:
                started = self._turn.get("thinking_started")
                fields = {"turn_id": self.turn_id, "text": c.get("thinking") or "", "duration_ms": int((time.time() - started) * 1000) if started else 0}
                if self._turn.get("thinking_tokens"):
                    fields["tokens"] = self._turn["thinking_tokens"]
                self.emit("thinking_done", **fields)
                self._turn["thinking_started"] = None
                self._turn["thinking_tokens"] = None
            elif ct == "tool_use":
                tid, name = c.get("id") or "", c.get("name") or ""
                inp = c.get("input") if isinstance(c.get("input"), dict) else {}
                self._tools[tid] = (name, inp, time.time())
                self._turn["tools"] += 1
                fields = {"turn_id": self.turn_id, "tool_id": tid, "name": name, "kind": cp.tool_kind(name), "input": inp, "summary": summary_of(name, inp)}
                if parent:
                    fields["parent_tool_id"] = parent
                self.emit("tool_start", **fields)

    def _on_user(self, m):
        if not self._turn:
            return
        content = (m.get("message") or {}).get("content")
        for c in content if isinstance(content, list) else []:
            if not isinstance(c, dict) or c.get("type") != "tool_result":
                continue
            tid = c.get("tool_use_id") or ""
            name, inp, started = self._tools.pop(tid, ("", {}, None))
            ok = not c.get("is_error")
            output, truncated = cp.truncate_output(text_of(c.get("content")))
            fields = {"turn_id": self.turn_id, "tool_id": tid, "ok": ok, "output": output, "truncated": truncated,
                      "duration_ms": int((time.time() - started) * 1000) if started else 0}
            if cp.tool_kind(name) == "shell":
                code = re.match(r"\s*Exit code (\d+)", output or "")
                fields["exit_code"] = int(code.group(1)) if code else (0 if ok else None)
            d = diff_of(name, inp) if ok else None
            if d:
                fields["diff"] = d
            self.emit("tool_end", **fields)

    def _on_result(self, m):
        if not self._turn:
            return
        sub = m.get("subtype")
        if sub == "success" and not m.get("is_error"):
            status, error = "success", None
        elif self._interrupting or str(m.get("terminal_reason") or "").startswith("aborted"):
            status, error = "interrupted", None
        else:
            errs = m.get("errors") or []
            status, error = "error", ("; ".join(str(e) for e in errs) or str(m.get("result") or sub or "error"))[:500]
        u = m.get("usage") or {}
        usage = {k: u[src] for k, src in (("input", "input_tokens"), ("output", "output_tokens"), ("cache_read", "cache_read_input_tokens"), ("cache_write", "cache_creation_input_tokens")) if isinstance(u.get(src), (int, float))}
        fields = {"turn_id": self.turn_id, "status": status, "duration_ms": int(m.get("duration_ms") or (time.time() - self._turn["started"]) * 1000), "num_tools": self._turn["tools"]}
        if error:
            fields["error"] = error
        if isinstance(m.get("total_cost_usd"), (int, float)):
            # the CLI reports the process's running total; a turn costs the difference
            fields["cost_usd"] = round(max(0.0, m["total_cost_usd"] - self._cost_total), 6)
            self._cost_total = max(self._cost_total, m["total_cost_usd"])
        if usage:
            fields["usage"] = usage
        self._end_turn()
        self.emit("turn_done", **fields)
        self.emit("state", **self.state())

    def _end_turn(self):
        self._turn = None
        self.turn_id = None
        self._interrupting = False
        self._perms.clear()
        self._tools.clear()
        self._set("idle")

    def _finish_turn_on_exit(self):
        if not self._turn:
            return False
        turn_id, started, tools = self.turn_id, self._turn["started"], self._turn["tools"]
        code = self.proc.poll() if self.proc else None
        tail = self.stderr_tail[-1] if self.stderr_tail else ""
        msg = _t(f"The Claude process quit (exit code {code})" + (f": {tail}" if tail else ""), f"Claude 进程退出了（退出码 {code}）" + (f"：{tail}" if tail else ""))
        self._end_turn()
        self.emit("turn_done", turn_id=turn_id, status="error", error=msg, duration_ms=int((time.time() - started) * 1000), num_tools=tools)
        self.emit("error", code="process_exited", message=msg, fatal=True)
        return True

    def _on_exit(self):
        self._eof = True
        if self.proc:
            try:
                self.proc.wait(2)
            except subprocess.TimeoutExpired:
                pass
        if self._err_thread:
            self._err_thread.join(1)  # the last stderr line is usually the reason
        if self._closed_sent:
            return
        if self._closing:
            return  # close() emits `closed` with its own reason
        code = self.proc.poll() if self.proc else None
        tail = " / ".join(list(self.stderr_tail)[-3:])
        if not self._opened:
            self._init_deadline = None
            unknown = "unknown option" in tail.lower() or "unknown argument" in tail.lower()
            self._closed_sent = True
            self._set("error")
            self.emit("error", code="unsupported_version" if unknown else "spawn_failed",
                      message=_t(f"Claude Code quit right at start (exit code {code})" + (f": {tail[:400]}" if tail else ""), f"Claude Code 启动就退出了（退出码 {code}）" + (f"：{tail[:400]}" if tail else "")), fatal=True)
            self.emit("closed", reason="error", exit_code=code)
            return
        self._finish_turn_on_exit()
        self._closed_sent = True
        self._set("stopped")
        self.emit("closed", reason="exited", exit_code=code)
