# -*- coding: utf-8 -*-
import base64
import hashlib
import json
import os
import shutil
import socket
import struct
import tempfile
import threading
import time
import unittest
from unittest import mock

import chat_codex as cx
import chat_protocol as cp

WINDOWS_READY = True
HAS_UNIX = hasattr(socket, "AF_UNIX") and os.name != "nt"
T = "thr-1"


# ---------------------------------------------------------------- a fake codex app-server daemon
class FakeConn:
    def __init__(self, sock, daemon):
        self.sock, self.daemon, self.buf, self.lock = sock, daemon, b"", threading.Lock()
        self.alive = True

    def handshake(self):
        while b"\r\n\r\n" not in self.buf:
            d = self.sock.recv(4096)
            if not d:
                return False
            self.buf += d
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        key = [l.split(b":", 1)[1].strip() for l in head.split(b"\r\n") if l.lower().startswith(b"sec-websocket-key")][0]
        acc = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
        self.sock.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acc + b"\r\n\r\n")
        return True

    def _need(self, n):
        while len(self.buf) < n:
            d = self.sock.recv(65536)
            if not d:
                raise EOFError
            self.buf += d

    def read(self):
        self._need(2)
        b0, b1 = self.buf[0], self.buf[1]
        n, off = b1 & 0x7F, 2
        if n == 126:
            self._need(4); n, off = struct.unpack(">H", self.buf[2:4])[0], 4
        elif n == 127:
            self._need(10); n, off = struct.unpack(">Q", self.buf[2:10])[0], 10
        assert b1 & 0x80, "client frames must be masked"
        self._need(off + 4 + n)
        mask = self.buf[off:off + 4]
        payload = bytes(b ^ mask[i & 3] for i, b in enumerate(self.buf[off + 4:off + 4 + n]))
        self.buf = self.buf[off + 4 + n:]
        return b0 & 0x0F, payload

    def frame(self, op, payload):
        n = len(payload)
        hdr = bytes([0x80 | op]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack(">H", n) if n < 65536 else bytes([127]) + struct.pack(">Q", n))
        with self.lock:
            self.sock.sendall(hdr + payload)

    def push(self, obj):
        self.frame(1, json.dumps(obj).encode())

    def reply(self, rid, result):
        self.push({"id": rid, "result": result})

    def close(self):
        self.alive = False
        try:
            self.frame(8, b"")
        except OSError:
            pass
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()


class FakeDaemon:
    """Answers initialize / thread/start / thread/resume / turn/start / turn/interrupt, records every
    message it got, and lets a test push notifications and server requests."""

    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="cx", dir="/tmp")
        self.path = os.path.join(self.dir, "s.sock")
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(self.path)
        self.srv.listen(4)
        self.got = []
        self.conns = []
        self.on = {}      # method → fn(conn, msg) replacing the default answer
        self.cond = threading.Condition()
        self.turn_n = 0
        threading.Thread(target=self._accept, daemon=True).start()

    @property
    def conn(self):
        return self.conns[-1]

    def _accept(self):
        while True:
            try:
                s, _ = self.srv.accept()
            except OSError:
                return
            c = FakeConn(s, self)
            if not c.handshake():
                continue
            self.conns.append(c)
            threading.Thread(target=self._serve, args=(c,), daemon=True).start()

    def _serve(self, c):
        try:
            while True:
                op, payload = c.read()
                if op == 8:
                    break
                if op == 9:
                    c.frame(10, payload); continue
                if op != 1:
                    continue
                msg = json.loads(payload)
                with self.cond:
                    self.got.append(msg)
                    self.cond.notify_all()
                m = msg.get("method")
                if m in self.on:
                    self.on[m](c, msg)
                elif m == "initialize":
                    c.reply(msg["id"], {"userAgent": "dispatch/0.157.0 (fake)", "codexHome": "/x"})
                elif m in ("thread/start", "thread/resume"):
                    c.reply(msg["id"], {"thread": {"id": msg["params"].get("threadId", T), "path": "/x/rollout-thr-1.jsonl", "status": {"type": "idle"}},
                                        "model": msg["params"].get("model") or "gpt-fake", "approvalPolicy": "on-request",
                                        "sandbox": {"type": "workspaceWrite"}, "cwd": msg["params"].get("cwd") or "/x", "reasoningEffort": "high"})
                elif m == "turn/start":
                    self.turn_n += 1
                    c.reply(msg["id"], {"turn": {"id": f"turn-{self.turn_n}", "items": [], "status": "inProgress"}})
                elif "id" in msg and m:
                    c.reply(msg["id"], {})
        except (EOFError, OSError):
            pass
        c.alive = False

    def wait_for(self, pred, timeout=5):
        end = time.time() + timeout
        with self.cond:
            while time.time() < end:
                hit = [m for m in self.got if pred(m)]
                if hit:
                    return hit[-1]
                self.cond.wait(0.05)
        raise AssertionError("fake daemon never got the expected message")

    def stop(self):
        try:
            self.srv.close()
        except OSError:
            pass
        for c in self.conns:
            c.close()
        shutil.rmtree(self.dir, ignore_errors=True)


def n(method, **params):
    return {"method": method, "params": params}


def item(kind, iid, **fields):
    return dict({"type": kind, "id": iid}, **fields)


@unittest.skipUnless(HAS_UNIX, "the fake daemon needs AF_UNIX")
class WithFakeDaemon(unittest.TestCase):
    def setUp(self):
        self.d = FakeDaemon()
        self.hub = cx.CodexHub(path=self.d.path, client_version="9.9", daemon_start=lambda: False, rpc_timeout=3, backoff_start=0.05, backoff_max=0.2)
        self.events = []
        self.em = cp.Emitter(lambda line: self.events.append(json.loads(line)))
        self.a = cx.CodexAdapter(self.em.bound(None), None, "/work", {"model": "gpt-fake", "permission_mode": "default"}, hub=self.hub)
        self.a.rebind = self.em.bound

    def tearDown(self):
        self.hub.shutdown()
        self.d.stop()

    def pump(self, pred, timeout=5):
        end = time.time() + timeout
        while time.time() < end:
            self.a.drain()
            hit = [e for e in self.events if pred(e)]
            if hit:
                return hit[-1]
            time.sleep(0.01)
        raise AssertionError(f"no such event; got {[e['ev'] for e in self.events]}")

    def evs(self, *names):
        return [e for e in self.events if e["ev"] in names]

    def open(self):
        """start() returns at once; opened + state come from drain(), then the skills prefetch."""
        self.a.start()
        ts = self.d.wait_for(lambda m: m.get("method") == "thread/start")
        self.pump(lambda e: e["ev"] == "state")
        self.pump(lambda e: e["ev"] == "commands")
        self.events[:] = [e for e in self.events if e["ev"] != "commands"]
        return ts

    def send(self, msg):
        self.a.send(msg)
        return self.pump(lambda e: e["ev"] == "turn_started" and e["message_id"] == msg["message_id"])

    def test_thread_start_carries_the_models_largest_window_unless_the_user_set_one(self):
        for cwd, config, expected in (("/w-default", "", {"model_context_window": 872000}), ("/w-user", "model_context_window = 500000\n", None)):
            home = tempfile.mkdtemp()
            with open(home + "/config.toml", "w") as f:
                f.write(config)
            with mock.patch.dict(os.environ, {"CODEX_HOME": home}):
                a = cx.CodexAdapter(self.em.bound(None), None, cwd, {"model": "gpt-6-astra", "permission_mode": "default"}, hub=self.hub)
                a.start()
                ts = self.d.wait_for(lambda m: m.get("method") == "thread/start" and m["params"].get("cwd") == cwd)
            self.assertEqual(ts["params"].get("config"), expected)

    def test_open_initializes_and_starts_a_user_reviewed_thread(self):
        ts = self.open()
        init = self.d.wait_for(lambda m: m.get("method") == "initialize")
        self.assertEqual(init["params"]["clientInfo"], {"name": "dispatch", "version": "9.9"})
        self.d.wait_for(lambda m: m.get("method") == "initialized")
        self.assertEqual(self.hub.user_agent, "dispatch/0.157.0 (fake)")
        p = ts["params"]
        self.assertEqual((p["approvalsReviewer"], p["approvalPolicy"], p["sandbox"], p["cwd"], p["model"]), ("user", "on-request", "workspace-write", "/work", "gpt-fake"))
        self.assertEqual([e["ev"] for e in self.events], ["opened", "state"])
        op, st = self.events
        self.assertEqual(op["session"], "codex:" + T)
        self.assertEqual((op["agent"], op["resumed"], op["transcript_path"], op["permission_mode"]), ("codex", False, "/x/rollout-thr-1.jsonl", "default"))
        self.assertEqual(set(op["capabilities"]), set(cx.CAPABILITIES))
        self.assertTrue(set(op["capabilities"]) <= set(cp.CAPABILITIES))
        self.assertEqual((st["session"], st["lifecycle"], st["queue"], st["pending"]), ("codex:" + T, "idle", [], []))

    def test_a_turn_streams_asks_for_approval_and_finishes(self):
        self.open()
        self.send({"message_id": "m1", "text": "hi"})
        ts = self.d.wait_for(lambda m: m.get("method") == "turn/start")
        self.assertEqual(ts["params"]["input"], [{"type": "text", "text": "hi"}])
        c = self.d.conn
        tu = "turn-1"
        c.push(n("turn/started", threadId=T, turn={"id": tu, "status": "inProgress", "items": []}))
        c.push(n("item/agentMessage/delta", threadId="title-thread", turnId="x", itemId="z", delta="NOISE"))
        c.push(n("item/started", threadId="title-thread", turnId="x", item=item("agentMessage", "z", text="")))
        c.push(n("item/started", threadId=T, turnId=tu, item=item("reasoning", "r1", summary=[], content=[]), startedAtMs=1000))
        c.push(n("item/reasoning/summaryTextDelta", threadId=T, turnId=tu, itemId="r1", delta="plan", summaryIndex=0))
        c.push(n("item/completed", threadId=T, turnId=tu, item=item("reasoning", "r1", summary=["plan"], content=[]), completedAtMs=2500))
        c.push(n("item/started", threadId=T, turnId=tu, item=item("agentMessage", "a1", text="")))
        c.push(n("item/agentMessage/delta", threadId=T, turnId=tu, itemId="a1", delta="po"))
        c.push(n("item/agentMessage/delta", threadId=T, turnId=tu, itemId="a1", delta="ng"))
        c.push(n("item/completed", threadId=T, turnId=tu, item=item("agentMessage", "a1", text="pong")))
        c.push(n("item/started", threadId=T, turnId=tu, item=item("commandExecution", "e1", command="/bin/zsh -lc 'echo hi > f'", cwd="/work",
                                                                     commandActions=[{"type": "unknown", "command": "echo hi > f"}], status="inProgress")))
        c.push({"id": 7, "method": "item/commandExecution/requestApproval",
                "params": {"threadId": T, "turnId": tu, "itemId": "e1", "command": "/bin/zsh -lc 'echo hi > f'", "cwd": "/work", "reason": "writes a file",
                           "commandActions": [{"type": "unknown", "command": "echo hi > f"}], "availableDecisions": ["accept", "acceptForSession", "decline", "cancel"]}})
        pr = self.pump(lambda e: e["ev"] == "permission_request")
        seq = [e["ev"] for e in self.events][2:]
        self.assertEqual(seq, ["turn_started", "thinking_delta", "thinking_done", "text_delta", "text_delta", "text_done", "tool_start", "permission_request"])
        self.assertNotIn("NOISE", json.dumps(self.events))
        td = self.evs("thinking_done")[0]
        self.assertEqual((td["text"], td["duration_ms"]), ("plan", 1500))
        self.assertEqual(self.evs("text_done")[0]["text"], "pong")
        st = self.evs("tool_start")[0]
        self.assertEqual((st["kind"], st["name"], st["summary"], st["tool_id"]), ("shell", "commandExecution", "echo hi > f", "e1"))
        self.assertEqual((pr["kind"], pr["tool_id"], pr["reason"], pr["summary"]), ("command", "e1", "writes a file", "echo hi > f"))
        self.assertEqual(pr["options"], ["allow", "allow_session", "deny"])
        self.assertEqual(self.a.lifecycle, "waiting_permission")
        self.assertEqual(self.a.state()["pending"], [pr["permission_id"]])

        self.a.permission(pr["permission_id"], "allow_session")
        resp = self.d.wait_for(lambda m: m.get("id") == 7 and "result" in m)
        self.assertEqual(resp["result"], {"decision": "acceptForSession"})
        self.assertEqual(self.a.lifecycle, "running")
        c.push(n("serverRequest/resolved", threadId=T, requestId=7))
        c.push(n("item/completed", threadId=T, turnId=tu, item=item("commandExecution", "e1", command="x", status="completed", aggregatedOutput="ok\n", exitCode=0, durationMs=12)))
        patch = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1,2 @@\n-old\n+hi\n+more\n"
        c.push(n("turn/diff/updated", threadId=T, turnId=tu, diff=patch))
        c.push(n("thread/tokenUsage/updated", threadId=T, turnId=tu, tokenUsage={"last": {"inputTokens": 100, "outputTokens": 5, "cachedInputTokens": 40, "totalTokens": 105, "reasoningOutputTokens": 0},
                                                                              "total": {}, "modelContextWindow": 1000}))
        c.push(n("account/rateLimits/updated", rateLimits={"primary": {"usedPercent": 11, "windowDurationMins": 10080, "resetsAt": 5}}))
        c.push(n("turn/completed", threadId=T, turn={"id": tu, "status": "completed", "items": [], "durationMs": 900}))
        done = self.pump(lambda e: e["ev"] == "turn_done")
        res = self.evs("permission_resolved")
        self.assertEqual([(r["decision"], r["by"]) for r in res], [("allow_session", "dispatch")])  # the daemon's resolved echo is not a second one
        end = self.evs("tool_end")[0]
        self.assertEqual((end["ok"], end["output"], end["exit_code"], end["duration_ms"]), (True, "ok\n", 0, 12))
        self.assertEqual(self.evs("diff_updated")[0]["files"], [{"path": "f", "add": 2, "del": 1}])
        self.assertEqual(self.evs("rate_limit")[0]["windows"], [{"label": "7d", "used_percent": 11, "resets_at": 5}])
        self.assertEqual((done["status"], done["turn_id"], done["duration_ms"], done["num_tools"]), ("success", tu, 900, 1))
        self.assertEqual(done["usage"], {"input": 60, "output": 5, "cache_read": 40, "cache_write": 0, "context_pct": 10.5})
        self.assertEqual((self.a.lifecycle, self.a.turn_id), ("idle", None))
        for e in self.events:
            self.assertIn(e["ev"], cp.EVENTS)
            self.assertEqual(e.get("session"), "codex:" + T)

    def test_deny_declines_and_interrupt_ends_the_turn(self):
        self.open()
        self.send({"message_id": "m1", "text": "run it"})
        c = self.d.conn
        c.push({"id": 3, "method": "item/commandExecution/requestApproval",
                "params": {"threadId": T, "turnId": "turn-1", "itemId": "e1", "command": "rm x", "availableDecisions": ["accept", "cancel"]}})
        pr = self.pump(lambda e: e["ev"] == "permission_request")
        self.assertEqual(pr["options"], ["allow", "deny"])  # the daemon did not offer acceptForSession
        with self.assertRaises(cp.ChatError) as cm:
            self.a.permission(pr["permission_id"], "allow_session")
        self.assertEqual(cm.exception.code, "unsupported")
        self.a.permission(pr["permission_id"], "deny")
        self.assertEqual(self.d.wait_for(lambda m: m.get("id") == 3 and "result" in m)["result"], {"decision": "decline"})
        self.a.interrupt()
        ti = self.d.wait_for(lambda m: m.get("method") == "turn/interrupt")
        self.assertEqual(ti["params"], {"threadId": T, "turnId": "turn-1"})
        c.push(n("turn/completed", threadId=T, turn={"id": "turn-1", "status": "interrupted", "items": []}))
        done = self.pump(lambda e: e["ev"] == "turn_done")
        self.assertEqual(done["status"], "interrupted")
        c.push(n("item/agentMessage/delta", threadId=T, turnId="turn-1", itemId="a", delta="late"))
        time.sleep(0.1); self.a.drain()
        self.assertNotIn("late", json.dumps(self.events))
        with self.assertRaises(cp.ChatError) as cm:
            self.a.interrupt()
        self.assertEqual(cm.exception.code, "not_running")

    def test_question_and_permissions_requests(self):
        self.open()
        self.send({"message_id": "m1", "text": "ask me"})
        c = self.d.conn
        c.push({"id": 4, "method": "item/tool/requestUserInput", "params": {"threadId": T, "turnId": "turn-1", "itemId": "q", "isBlocking": True,
                "questions": [{"id": "color", "header": "Color", "question": "Which color?", "options": [{"label": "red", "description": ""}, {"label": "blue", "description": ""}]}]}})
        pr = self.pump(lambda e: e["ev"] == "permission_request")
        self.assertEqual(pr["kind"], "question")
        self.assertEqual(pr["questions"], [{"id": "color", "text": "Color: Which color?", "options": ["red", "blue"], "multi": False}])
        self.assertEqual(self.a.lifecycle, "waiting_input")
        self.a.answer(pr["permission_id"], {"color": ["blue"]})
        self.assertEqual(self.d.wait_for(lambda m: m.get("id") == 4 and "result" in m)["result"], {"answers": {"color": {"answers": ["blue"]}}})
        self.assertEqual(self.evs("permission_resolved")[-1]["decision"], "answered")
        perms = {"network": {"enabled": True}, "fileSystem": None}
        c.push({"id": 5, "method": "item/permissions/requestApproval", "params": {"threadId": T, "turnId": "turn-1", "itemId": "p", "cwd": "/work", "permissions": perms, "startedAtMs": 1}})
        pr = self.pump(lambda e: e["ev"] == "permission_request" and e["kind"] == "permission")
        self.assertEqual(pr["options"], ["allow", "deny"])
        self.a.permission(pr["permission_id"], "allow")
        self.assertEqual(self.d.wait_for(lambda m: m.get("id") == 5 and "result" in m)["result"], {"permissions": {"network": {"enabled": True}}, "scope": "turn"})
        c.push({"id": 6, "method": "mcpServer/elicitation/request", "params": {"threadId": T, "turnId": "turn-1"}})
        time.sleep(0.1); self.a.drain()  # unhandled server requests are refused, never left waiting
        self.assertEqual(self.d.wait_for(lambda m: m.get("id") == 6 and "error" in m)["error"]["code"], -32601)

    def test_images_set_model_and_mode_ride_on_the_next_turn(self):
        self.open()
        with tempfile.TemporaryDirectory() as dd, mock.patch.dict(os.environ, {"DISPATCH_DIR": dd}):
            self.a.set_model("gpt-other", effort="low")
            self.a.set_permission_mode("plan")
            self.a.send({"message_id": "m1", "text": "look", "images": [{"media_type": "image/png", "data": base64.b64encode(b"\x89PNGxx").decode()}, {"path": "/abs/a.jpg"}]})
            p = self.d.wait_for(lambda m: m.get("method") == "turn/start")["params"]
            self.pump(lambda e: e["ev"] == "turn_started")
            self.assertEqual(p["model"], "gpt-other")
            self.assertEqual(p["effort"], "low")
            self.assertEqual((p["approvalPolicy"], p["sandboxPolicy"]), ("untrusted", {"type": "readOnly"}))
            img = p["input"][1]
            self.assertEqual(img["type"], "localImage")
            self.assertTrue(img["path"].startswith(os.path.join(dd, "files", "chat-")) and img["path"].endswith(".png"))
            with open(img["path"], "rb") as f:
                self.assertEqual(f.read(), b"\x89PNGxx")
            self.assertEqual(p["input"][2], {"type": "localImage", "path": "/abs/a.jpg"})
        self.assertEqual(self.evs("turn_started")[0]["images_n"], 2)
        self.assertEqual((self.a.state()["model"], self.a.state()["permission_mode"]), ("gpt-other", "plan"))

    def test_model_changed_mid_conversation_sticks_across_turns_and_a_daemon_restart(self):
        # `dispatch agent model` on a thread that already ran a turn: the next turn/start names the
        # new model, and when the daemon goes away the thread/resume asks for it too.
        self.open()
        self.send({"message_id": "m1", "text": "one"})
        self.d.conn.push(n("turn/completed", threadId=T, turn={"id": "turn-1", "status": "completed", "items": []}))
        self.pump(lambda e: e["ev"] == "turn_done")
        self.a.set_model("gpt-other")
        self.assertEqual(self.a.state()["model"], "gpt-other")
        self.send({"message_id": "m2", "text": "two"})
        p = self.d.wait_for(lambda m: m.get("method") == "turn/start" and m["params"]["input"][0]["text"] == "two")["params"]
        self.assertEqual(p["model"], "gpt-other")
        first = [m for m in self.d.got if m.get("method") == "turn/start"][0]["params"]
        self.assertNotIn("model", first)  # the thread's own model until someone changes it
        self.d.conn.close()
        rs = self.d.wait_for(lambda m: m.get("method") == "thread/resume")
        self.assertEqual(rs["params"]["model"], "gpt-other")
        self.assertIn("set_model", cx.CodexAdapter.capabilities)

    def test_turn_from_the_terminal_on_the_same_thread_shows_up(self):
        self.open()
        c = self.d.conn
        c.push(n("turn/started", threadId=T, turn={"id": "tui-1", "status": "inProgress", "items": []}))
        c.push(n("item/started", threadId=T, turnId="tui-1", item=item("userMessage", "u", content=[{"type": "text", "text": "from the TUI"}])))
        c.push(n("item/completed", threadId=T, turnId="tui-1", item=item("agentMessage", "a", text="ok")))
        c.push(n("turn/completed", threadId=T, turn={"id": "tui-1", "status": "completed", "items": []}))
        self.pump(lambda e: e["ev"] == "turn_done")
        self.assertEqual([e["ev"] for e in self.events if e["ev"] != "commands"][2:], ["turn_started", "text_done", "turn_done"])
        self.assertEqual(self.evs("turn_started")[0]["text"], "from the TUI")

    def test_reconnects_and_resumes_after_the_daemon_drops_us(self):
        self.open()
        self.send({"message_id": "m1", "text": "long"})
        first = self.d.conn
        first.close()
        done = self.pump(lambda e: e["ev"] == "turn_done")
        self.assertEqual(done["status"], "error")
        err = self.pump(lambda e: e["ev"] == "error")
        self.assertEqual((err["code"], err["fatal"]), ("daemon_down", False))
        rs = self.d.wait_for(lambda m: m.get("method") == "thread/resume")
        self.assertEqual(rs["params"], {"threadId": T, "excludeTurns": True, "approvalsReviewer": "user", "model": "gpt-fake"})
        self.assertEqual(len([m for m in self.d.got if m.get("method") == "initialize"]), 2)
        self.assertIsNot(self.d.conn, first)
        st = self.pump(lambda e: e["ev"] == "state" and e["lifecycle"] == "idle" and e["seq"] > err["seq"])
        self.assertEqual(st["session"], "codex:" + T)
        self.a.send({"message_id": "m2", "text": "again"})  # the new connection carries turns
        self.assertEqual(self.d.wait_for(lambda m: m.get("method") == "turn/start" and m["params"]["input"][0]["text"] == "again")["params"]["threadId"], T)

    def test_commands_and_close(self):
        self.d.on["skills/list"] = lambda c, m: c.reply(m["id"], {"data": [{"cwd": "/work", "errors": [], "skills": [
            {"name": "review", "description": "Review code", "enabled": True, "path": "/s", "scope": "user"},
            {"name": "off", "description": "", "enabled": False, "path": "/s", "scope": "user"}]}]})
        self.a.start()
        ev = self.pump(lambda e: e["ev"] == "commands")  # fetched right after opened, without blocking anyone
        self.assertEqual(ev["commands"], [{"name": "review", "description": "Review code", "kind": "skill"}])
        self.assertEqual(self.a.commands(), [{"name": "review", "description": "Review code", "kind": "skill"}])
        self.a.close("requested")
        self.d.wait_for(lambda m: m.get("method") == "thread/unsubscribe")
        self.assertEqual(self.events[-1]["ev"], "closed")
        self.assertEqual(self.events[-1]["reason"], "requested")
        self.assertFalse(self.a.alive())
        self.assertNotIn(T, self.hub.adapters)

    def test_resume_opens_the_existing_thread(self):
        self.a.start(resume="thr-old")
        rs = self.d.wait_for(lambda m: m.get("method") == "thread/resume")
        self.pump(lambda e: e["ev"] == "opened")
        self.assertEqual((rs["params"]["threadId"], rs["params"]["excludeTurns"], rs["params"]["approvalsReviewer"]), ("thr-old", True, "user"))
        self.assertEqual((self.events[0]["session"], self.events[0]["resumed"]), ("codex:thr-old", True))


    # Nothing Codex does may hold chatd's loop: the other sessions stream while it waits.
    def test_open_returns_at_once_while_the_daemon_is_slow_to_start(self):
        h = cx.CodexHub(path="/tmp/dispatch-no-such-codex-2.sock", daemon_start=lambda: time.sleep(1.0) or False, rpc_timeout=1)
        h.connect_retry = 0.3
        a = cx.CodexAdapter(self.em.bound(None), None, "/work", {}, hub=h)
        t0 = time.time()
        a.start()
        self.assertLess(time.time() - t0, 0.3)
        self.assertEqual(a.lifecycle, "starting")
        end = time.time() + 15
        while time.time() < end and a.lifecycle == "starting":
            a.drain(); time.sleep(0.02)
        err = [e for e in self.events if e["ev"] == "error"][-1]
        self.assertEqual((err["code"], err["fatal"], a.lifecycle), ("daemon_down", True, "error"))

    def test_send_returns_before_turn_start_answers_and_an_early_interrupt_waits_for_the_turn(self):
        self.open()
        slow = []
        self.d.on["turn/start"] = lambda c, m: slow.append((c, m))
        t0 = time.time()
        self.a.send({"message_id": "m1", "text": "hi"})
        self.assertLess(time.time() - t0, 0.3)
        self.assertEqual(self.a.lifecycle, "running")
        with self.assertRaises(cp.ChatError):
            self.a.send({"message_id": "m2", "text": "second"})
        self.a.interrupt()  # no turn id yet: held until turn/start says which turn
        self.d.wait_for(lambda m: m.get("method") == "turn/start")
        self.assertFalse([m for m in self.d.got if m.get("method") == "turn/interrupt"])
        c, m = slow[0]
        c.reply(m["id"], {"turn": {"id": "turn-9", "items": [], "status": "inProgress"}})
        st = self.pump(lambda e: e["ev"] == "turn_started")
        self.assertEqual((st["turn_id"], st["message_id"], st["text"]), ("turn-9", "m1", "hi"))
        self.assertEqual(self.d.wait_for(lambda m: m.get("method") == "turn/interrupt")["params"], {"threadId": T, "turnId": "turn-9"})

    def test_turn_start_errors_come_back_as_an_error_and_idle(self):
        self.open()
        self.d.on["turn/start"] = lambda c, m: c.push({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -1, "message": "unknown model x"}})
        self.a.send({"message_id": "m1", "text": "hi"})
        err = self.pump(lambda e: e["ev"] == "error")
        self.assertEqual((err["code"], err["fatal"]), ("invalid_model", False))
        self.assertEqual((self.a.lifecycle, self.a.turn_id), ("idle", None))

    def test_a_dropped_connection_retires_the_old_card_and_the_resumed_turn_keeps_its_message(self):
        self.open()
        self.send({"message_id": "m1", "text": "long job"})
        c = self.d.conn
        c.push({"id": 4, "method": "item/commandExecution/requestApproval", "params": {"threadId": T, "turnId": "turn-1", "itemId": "e1", "command": "sleep 8"}})
        pr = self.pump(lambda e: e["ev"] == "permission_request")
        c.close()
        res = self.pump(lambda e: e["ev"] == "permission_resolved")
        self.assertEqual((res["permission_id"], res["by"]), (pr["permission_id"], "elsewhere"))
        self.pump(lambda e: e["ev"] == "turn_done")
        self.d.wait_for(lambda m: m.get("method") == "thread/resume")
        self.pump(lambda e: e["ev"] == "state" and e["lifecycle"] == "idle")
        self.d.conn.push({"id": 4, "method": "item/commandExecution/requestApproval", "params": {"threadId": T, "turnId": "turn-1", "itemId": "e1", "command": "sleep 8"}})
        again = self.pump(lambda e: e["ev"] == "turn_started" and e["seq"] > res["seq"])
        self.assertEqual((again["turn_id"], again["message_id"], again["text"]), ("turn-1", "m1", "long job"))
        pr2 = self.pump(lambda e: e["ev"] == "permission_request" and e["permission_id"] != pr["permission_id"])
        self.assertEqual(self.a.state()["pending"], [pr2["permission_id"]])


class Unit(unittest.TestCase):
    def test_mode_maps_to_schema_names(self):
        for mode, (policy, sandbox) in cx.MODE_MAP.items():
            self.assertIn(mode, cp.PERMISSION_MODES)
            self.assertIn(policy, cx.APPROVAL_POLICIES)
            self.assertIn(sandbox, cx.SANDBOX_MODES)
        self.assertEqual(cx.mode_of("never", {"type": "dangerFullAccess"}), "bypassPermissions")
        self.assertEqual(cx.mode_of("untrusted", "read-only"), "plan")
        self.assertEqual(cx.mode_of("on-request", {"type": "workspaceWrite"}), "default")
        with self.assertRaises(cp.ChatError):
            cx.mode_params("yolo")

    def test_schema_enums_still_match(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "design", "in-app-chat", "spike", "codex_schema", "codex_app_server_protocol.v2.schemas.json")
        if not os.path.exists(path):
            self.skipTest("spike schema not in this checkout")
        with open(path) as f:
            d = json.load(f)["definitions"]
        self.assertEqual(tuple(d["AskForApproval"]["oneOf"][0]["enum"]), cx.APPROVAL_POLICIES)
        self.assertEqual(tuple(d["SandboxMode"]["enum"]), cx.SANDBOX_MODES)

    def test_diff_files(self):
        patch = "diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@\n+a\n+b\n-c\ndiff --git a/new b/new\n--- /dev/null\n+++ b/new\n@@\n+z\n"
        self.assertEqual(cx.diff_files(patch), [{"path": "x.py", "add": 2, "del": 1}, {"path": "new", "add": 1, "del": 0}])

    def test_probe(self):
        with mock.patch.object(cx, "_is_win", return_value=True), mock.patch.object(cx.shutil, "which", return_value="/bin/codex"):
            r = cx.probe()
            self.assertFalse(r["supported"])
            self.assertIn("Windows", r["reason"])
        with mock.patch.object(cx, "_is_win", return_value=False), mock.patch.object(cx.shutil, "which", return_value=None):
            self.assertEqual((cx.probe()["available"], cx.probe()["supported"]), (False, False))
        for out, ok in (("codex-cli 0.157.0", True), ("codex-cli 0.150.2", False)):
            with mock.patch.object(cx, "_is_win", return_value=False), mock.patch.object(cx.shutil, "which", return_value="/bin/codex"), \
                    mock.patch.object(cx, "_run", return_value=mock.Mock(stdout=out, stderr="", returncode=0)):
                r = cx.probe()
                self.assertEqual((r["available"], r["supported"]), (True, ok), out)

    @unittest.skipUnless(HAS_UNIX, "needs AF_UNIX")
    def test_daemon_down_after_one_start_attempt(self):
        starts = []
        h = cx.CodexHub(path="/tmp/dispatch-no-such-codex.sock", daemon_start=lambda: starts.append(1) or False, rpc_timeout=1)
        with mock.patch.object(cx.time, "time", side_effect=[0, 100, 100, 100]):
            with self.assertRaises(cp.ChatError) as cm:
                h.ensure()
        self.assertEqual(cm.exception.code, "daemon_down")
        self.assertEqual(starts, [1])


if __name__ == "__main__":
    unittest.main()
