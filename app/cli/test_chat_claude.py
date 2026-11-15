# -*- coding: utf-8 -*-
"""ClaudeAdapter against a fake `claude -p` that speaks the stream-json shapes recorded in
design/in-app-chat/spike/logs/cc_*.jsonl. No real Claude runs here."""
import json
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import chat_claude as cc
import chat_protocol as cp

WINDOWS_READY = True

FAKE = r'''
import json, os, signal, sys, time
LOG = os.environ["FAKECLAUDE_LOG"]
def log(kind, obj):
    with open(LOG, "a") as f: f.write(json.dumps({"kind": kind, "obj": obj}) + "\n")
signal.signal(signal.SIGINT, lambda *a: (log("signal", "SIGINT"), sys.exit(130)))
log("env", sorted(os.environ))
log("argv", sys.argv[1:])
sid = sys.argv[sys.argv.index("--session-id") + 1] if "--session-id" in sys.argv else sys.argv[sys.argv.index("--resume") + 1]
def out(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
def se(event): out({"type": "stream_event", "event": event, "session_id": sid, "parent_tool_use_id": None})
def assistant(*blocks): out({"type": "assistant", "message": {"role": "assistant", "content": list(blocks)}, "parent_tool_use_id": None, "session_id": sid})
def tool_result(tid, content, is_error=False): out({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": content, "is_error": is_error, "tool_use_id": tid}]}, "parent_tool_use_id": None, "session_id": sid})
def result(sub="success", **kw): out(dict({"type": "result", "subtype": sub, "is_error": sub != "success", "duration_ms": 12, "total_cost_usd": 0.001, "usage": {"input_tokens": 5, "output_tokens": 7, "cache_read_input_tokens": 3}, "session_id": sid}, **kw))
pending = {}
def read():
    line = sys.stdin.readline()
    if not line: sys.exit(0)
    m = json.loads(line); log("in", m); return m
def ask(rid, tool, inp, tid, suggestions=None):
    out({"type": "control_request", "request_id": rid, "request": {"subtype": "can_use_tool", "tool_name": tool, "input": inp, "description": "Write a file", "tool_use_id": tid,
         "permission_suggestions": suggestions or [{"type": "addRules", "rules": [{"toolName": tool, "ruleContent": "echo *"}], "behavior": "allow", "destination": "localSettings"}]}})
    while True:
        m = read()
        if m.get("type") == "control_response" and m["response"]["request_id"] == rid: return m["response"]["response"]
while True:
    m = read()
    if m["type"] == "control_request":
        sub = m["request"]["subtype"]
        if sub == "initialize":
            time.sleep(float(os.environ.get("FAKECLAUDE_INIT_DELAY") or 0))
            out({"type": "system", "subtype": "hook_started", "hook_name": "SessionStart:startup", "session_id": sid})
            out({"type": "system", "subtype": "hook_response", "hook_name": "SessionStart:startup", "exit_code": 0, "outcome": "success", "session_id": sid})
            out({"type": "control_response", "response": {"subtype": "success", "request_id": m["request_id"], "response": {"commands": [{"name": "review", "description": "Review a PR", "builtin": True}, {"name": "concept-svg", "description": "SVG (user)"}], "pid": os.getpid(), "current_permission_mode": "default"}}})
        elif sub == "set_model" and m["request"]["model"] == "retired-model":
            out({"type": "control_response", "response": {"subtype": "error", "request_id": m["request_id"], "error": "model not available"}})
        elif sub == "set_model":
            out({"type": "control_response", "response": {"subtype": "success", "request_id": m["request_id"], "response": {}}})
        elif sub == "set_permission_mode":
            out({"type": "control_response", "response": {"subtype": "success", "request_id": m["request_id"], "response": {"mode": m["request"]["mode"]}}})
        elif sub == "interrupt":
            out({"type": "control_response", "response": {"subtype": "success", "request_id": m["request_id"], "response": {"still_queued": []}}})
        continue
    if m["type"] != "user": continue
    text = " ".join(c.get("text", "") for c in m["message"]["content"] if c["type"] == "text")
    out({"type": "system", "subtype": "init", "session_id": sid, "model": "claude-haiku-4-5", "permissionMode": "default", "claude_code_version": "2.1.282"})
    if "pong" in text:
        se({"type": "message_start", "message": {}})
        se({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}})
        out({"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 50, "session_id": sid})
        se({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "", "estimated_tokens": 50}})
        assistant({"type": "thinking", "thinking": "", "signature": "x"})
        se({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}})
        se({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "po"}})
        se({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "ng"}})
        assistant({"type": "text", "text": "pong"})
        se({"type": "content_block_stop", "index": 1})
        out({"type": "rate_limit_event", "rate_limit_info": {"unifiedWindows": {"five_hour": {"utilization": 0.08, "resetsAt": 1790339400}}}})
        result()
    elif "edit" in text:
        assistant({"type": "tool_use", "id": "toolu_e", "name": "Edit", "input": {"file_path": "/x/a.txt", "old_string": "old line", "new_string": "new line"}})
        tool_result("toolu_e", "The file /x/a.txt has been updated.")
        assistant({"type": "tool_use", "id": "toolu_b", "name": "Bash", "input": {"command": "false", "description": "Fail on purpose"}})
        tool_result("toolu_b", "Exit code 1", True)
        assistant({"type": "text", "text": "done"})
        result()
    elif "perm" in text:
        assistant({"type": "tool_use", "id": "toolu_p1", "name": "Bash", "input": {"command": "echo hi > f.txt"}})
        r = ask("perm-1", "Bash", {"command": "echo hi > f.txt"}, "toolu_p1")
        log("decision", r)
        tool_result("toolu_p1", r.get("message", ""), True)
        assistant({"type": "tool_use", "id": "toolu_p2", "name": "Bash", "input": {"command": "echo hi > f.txt"}})
        r = ask("perm-2", "Bash", {"command": "echo hi > f.txt"}, "toolu_p2")
        log("decision", r)
        tool_result("toolu_p2", "")
        result()
    elif "notebook" in text:
        # what the real CLI suggests for an edit tool in default mode (captured from 2.1.x)
        assistant({"type": "tool_use", "id": "toolu_n", "name": "NotebookEdit", "input": {"notebook_path": "/x/n.ipynb", "new_source": "print(1)"}})
        r = ask("perm-n", "NotebookEdit", {"notebook_path": "/x/n.ipynb", "new_source": "print(1)"}, "toolu_n", [{"type": "setMode", "mode": "acceptEdits", "destination": "session"}])
        log("decision", r)
        tool_result("toolu_n", "ok")
        result()
    elif "question" in text:
        inp = {"questions": [{"question": "Which color?", "header": "Color", "options": [{"label": "red"}, {"label": "blue"}], "multiSelect": False}]}
        assistant({"type": "tool_use", "id": "toolu_q", "name": "AskUserQuestion", "input": inp})
        r = ask("perm-q", "AskUserQuestion", inp, "toolu_q")
        log("decision", r)
        tool_result("toolu_q", "answered")
        result()
    elif "slow" in text:
        se({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "1\n2\n"}})
        while True:
            m = read()
            if m.get("type") == "control_request" and m["request"]["subtype"] == "interrupt":
                out({"type": "control_response", "response": {"subtype": "success", "request_id": m["request_id"], "response": {"still_queued": []}}})
                assistant({"type": "text", "text": "1\n2"})
                out({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "[Request interrupted by user]"}]}, "session_id": sid})
                result("error_during_execution", terminal_reason="aborted_streaming", errors=["aborted"])
                break
    elif "die" in text:
        se({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "about to"}})
        sys.stderr.write("fatal: boom\n"); sys.stderr.flush()
        os._exit(3)
'''


@unittest.skipIf(os.name == "nt", "the adapter refuses to start on Windows")
class ClaudeAdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fake = os.path.join(self.tmp.name, "fake_claude.py")
        with open(self.fake, "w") as f:
            f.write(FAKE)
        self.log = os.path.join(self.tmp.name, "log.jsonl")
        env = patch.dict(os.environ, {"FAKECLAUDE_LOG": self.log, "CLAUDECODE": "1", "CLAUDE_CODE_CHILD_SESSION": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "CODEX_THREAD_ID": "t", "DISPATCH_SESSION_ID": "x",
                                     "HERDR_PANE_ID": "wA:p9", "HERDR_SOCKET_PATH": "/tmp/h.sock", "TMUX_PANE": "%3"})
        env.start(); self.addCleanup(env.stop)
        cmd = patch.object(cc, "claude_command", return_value=[sys.executable, self.fake])
        cmd.start(); self.addCleanup(cmd.stop)
        self.events = []
        self.sid = "11111111-2222-4333-8444-555555555555"
        self.a = cc.ClaudeAdapter(lambda ev, **f: self.events.append(dict(f, ev=ev)), "claude-code:" + self.sid, self.tmp.name, {"model": "haiku"})
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        if self.a.alive():
            self.a.proc.kill(); self.a.proc.wait(5)
        if self.a.proc:
            for pipe in (self.a.proc.stdin, self.a.proc.stdout, self.a.proc.stderr):
                try: pipe.close()
                except Exception: pass

    def until(self, pred, timeout=10):
        end = time.time() + timeout
        while time.time() < end:
            self.a.drain()
            hit = next((e for e in self.events if pred(e)), None)
            if hit:
                return hit
            time.sleep(0.01)
        self.fail(f"timed out; events: {[e['ev'] for e in self.events]}")

    def logged(self, kind):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as f:
            return [r["obj"] for r in map(json.loads, f) if r["kind"] == kind]

    def opened(self):
        self.a.start()
        return self.until(lambda e: e["ev"] == "opened")

    def turn(self, text, mid="m1"):
        self.events.clear()
        self.a.send({"message_id": mid, "text": text, "images": []})
        return self.until(lambda e: e["ev"] == "turn_done")

    def test_spawn_strips_agent_env_and_passes_the_protocol_flags(self):
        o = self.opened()
        env = self.logged("env")[0]
        self.assertEqual([k for k in env if k.startswith("CLAUDE")], [])
        self.assertNotIn("CODEX_THREAD_ID", env); self.assertNotIn("DISPATCH_SESSION_ID", env)
        # launched from a Herdr pane, Dispatch must not tell its agents they live in that pane
        self.assertEqual([k for k in env if k.startswith("HERDR_") or k == "TMUX_PANE"], [])
        self.assertIn("FAKECLAUDE_LOG", env)
        # an MCP server that cannot be reached is given 20 s, not Claude Code's default
        self.assertIn("MCP_TIMEOUT", env)
        argv = self.logged("argv")[0]
        for flag in ("-p", "--input-format", "--output-format", "--verbose", "--include-partial-messages", "--permission-prompt-tool"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--session-id") + 1], self.sid)
        self.assertEqual(argv[argv.index("--model") + 1], "haiku")
        self.assertEqual(argv[argv.index("--permission-prompt-tool") + 1], "stdio")

    def test_mcp_timeout_the_person_set_wins(self):
        self.assertEqual(cc.spawn_env({"PATH": "/bin"})["MCP_TIMEOUT"], "20000")
        self.assertEqual(cc.spawn_env({"PATH": "/bin", "MCP_TIMEOUT": "90000"})["MCP_TIMEOUT"], "90000")

    def test_initialize_round_trip_opens_the_session(self):
        o = self.opened()
        first = self.logged("in")[0]
        self.assertEqual((first["type"], first["request"]["subtype"]), ("control_request", "initialize"))
        self.assertEqual(o["agent"], "claude-code")
        self.assertFalse(o["resumed"])
        self.assertEqual(o["permission_mode"], "default")
        self.assertTrue(o["transcript_path"].endswith(os.path.join(cc.project_dir_name(self.tmp.name), self.sid + ".jsonl")))
        self.assertIn("allow_session", o["capabilities"]); self.assertNotIn("thinking_text", o["capabilities"])
        evs = [e["ev"] for e in self.events]
        self.assertEqual(evs[evs.index("opened") + 1], "state")
        self.assertEqual(self.events[evs.index("opened") + 1]["lifecycle"], "idle")
        self.assertEqual([c["name"] for c in self.a.commands()], ["review", "concept-svg"])
        self.assertEqual([c["kind"] for c in self.a.commands()], ["builtin", "skill"])
        self.assertNotIn("system", evs)  # a successful hook is not news

    def test_text_streams_then_turn_done(self):
        self.opened()
        done = self.turn("Reply with exactly: pong")
        evs = [e["ev"] for e in self.events]
        self.assertEqual(evs[0], "turn_started")
        self.assertEqual([e["text"] for e in self.events if e["ev"] == "text_delta"], ["po", "ng"])
        i = evs.index("text_done")
        self.assertEqual(evs[i - 1], "text_delta")  # text_done right after its own deltas
        self.assertEqual(self.events[i]["text"], "pong")
        think = next(e for e in self.events if e["ev"] == "thinking_done")
        self.assertEqual(think["tokens"], 50)
        self.assertEqual(done["status"], "success")
        self.assertEqual(done["cost_usd"], 0.001)
        self.assertEqual(done["usage"], {"input": 5, "output": 7, "cache_read": 3})
        rl = next(e for e in self.events if e["ev"] == "rate_limit")
        self.assertEqual(rl["windows"][0], {"label": "five_hour", "used_percent": 8.0, "resets_at": 1790339400})
        self.assertEqual(self.a.lifecycle, "idle")
        sent = [m for m in self.logged("in") if m["type"] == "user"][0]
        self.assertEqual(sent["message"]["content"], [{"type": "text", "text": "Reply with exactly: pong"}])
        self.assertIsNone(sent["parent_tool_use_id"])

    def test_tools_start_and_end_with_a_diff(self):
        self.opened()
        done = self.turn("please edit")
        starts = [e for e in self.events if e["ev"] == "tool_start"]
        ends = {e["tool_id"]: e for e in self.events if e["ev"] == "tool_end"}
        self.assertEqual([(s["name"], s["kind"]) for s in starts], [("Edit", "edit"), ("Bash", "shell")])
        self.assertEqual(starts[1]["summary"], "Fail on purpose")
        self.assertEqual(ends["toolu_e"]["diff"], {"path": "/x/a.txt", "kind": "edit", "old": "old line", "new": "new line"})
        self.assertTrue(ends["toolu_e"]["ok"])
        self.assertFalse(ends["toolu_b"]["ok"]); self.assertEqual(ends["toolu_b"]["exit_code"], 1)
        self.assertEqual(done["num_tools"], 2)

    def test_permission_deny_then_allow_session_shapes(self):
        self.opened()
        self.events.clear()
        self.a.send({"message_id": "m1", "text": "perm test", "images": []})
        req = self.until(lambda e: e["ev"] == "permission_request")
        self.assertEqual((req["permission_id"], req["kind"], req["tool_id"]), ("perm-1", "command", "toolu_p1"))
        self.assertEqual(req["options"], ["allow", "allow_session", "deny"])
        self.assertEqual(self.a.lifecycle, "waiting_permission")
        self.a.permission("perm-1", "deny", "not now")
        self.until(lambda e: e["ev"] == "permission_request" and e["permission_id"] == "perm-2")
        self.a.permission("perm-2", "allow_session")
        self.until(lambda e: e["ev"] == "turn_done")
        responses = [m for m in self.logged("in") if m["type"] == "control_response"]
        self.assertEqual(responses[0], {"type": "control_response", "response": {"subtype": "success", "request_id": "perm-1", "response": {"behavior": "deny", "message": "not now"}}})
        allow = responses[1]["response"]["response"]
        self.assertEqual(allow["behavior"], "allow")
        self.assertEqual(allow["updatedInput"], {"command": "echo hi > f.txt"})
        self.assertEqual(allow["updatedPermissions"][0]["type"], "addRules")
        resolved = [e for e in self.events if e["ev"] == "permission_resolved"]
        self.assertEqual([(r["decision"], r["by"]) for r in resolved], [("deny", "dispatch"), ("allow_session", "dispatch")])
        with self.assertRaises(cp.ChatError):
            self.a.permission("perm-2", "allow")

    def test_allow_session_on_an_edit_switches_the_mode_and_says_so_at_once(self):
        self.opened()
        self.events.clear()
        self.a.send({"message_id": "m1", "text": "notebook change", "images": []})
        req = self.until(lambda e: e["ev"] == "permission_request")
        self.assertEqual(req["options"], ["allow", "allow_session", "deny"])
        self.a.permission(req["permission_id"], "allow_session")
        st = self.until(lambda e: e["ev"] == "state" and e["permission_mode"] == "acceptEdits")
        self.assertIn(st["lifecycle"], ("running", "idle"))
        self.assertEqual(self.a.state()["permission_mode"], "acceptEdits")
        self.until(lambda e: e["ev"] == "turn_done")
        self.assertEqual(self.logged("decision")[0]["updatedPermissions"], [{"type": "setMode", "mode": "acceptEdits", "destination": "session"}])

    def test_a_question_card_takes_an_answer_not_a_plain_allow(self):
        self.opened()
        self.events.clear()
        self.a.send({"message_id": "m1", "text": "question time", "images": []})
        req = self.until(lambda e: e["ev"] == "permission_request")
        self.assertEqual((req["kind"], req["options"]), ("question", ["allow", "deny"]))
        for d in ("allow", "allow_session"):
            with self.assertRaises(cp.ChatError) as cm:
                self.a.permission(req["permission_id"], d)
            self.assertEqual(cm.exception.code, "bad_request")
        self.assertFalse([m for m in self.logged("in") if m["type"] == "control_response"])  # nothing went to Claude
        self.a.answer(req["permission_id"], {"Which color?": ["blue"]})
        self.until(lambda e: e["ev"] == "turn_done")
        self.assertEqual(self.logged("decision")[0]["updatedInput"]["answers"], {"Which color?": "blue"})

    def test_declining_a_question_answers_claude_and_the_session_goes_on(self):
        # the stop key on a question card: Claude hears the person declined, the turn ends, the
        # same session takes the next message
        self.opened()
        self.events.clear()
        self.a.send({"message_id": "m1", "text": "question time", "images": []})
        req = self.until(lambda e: e["ev"] == "permission_request")
        self.a.permission(req["permission_id"], "deny")
        self.until(lambda e: e["ev"] == "turn_done")
        self.assertEqual(self.logged("decision")[0]["behavior"], "deny")
        with self.assertRaises(cp.ChatError):
            self.a.answer(req["permission_id"], {"Which color?": ["blue"]})  # gone once declined
        done = self.turn("Reply with exactly: pong", mid="m2")
        self.assertEqual(done["status"], "success")

    def test_a_slow_start_is_not_called_an_unsupported_version(self):
        self.assertGreaterEqual(cc.INIT_TIMEOUT, 30)  # a busy machine took 10 s before its first hook
        with patch.dict(os.environ, {"FAKECLAUDE_INIT_DELAY": "3"}), patch.object(cc, "INIT_TIMEOUT", 0.3):
            self.a.start()
            err = self.until(lambda e: e["ev"] == "error")
        self.assertEqual((err["code"], err["fatal"]), ("spawn_failed", True))
        self.assertNotIn("协议", err["message"])

    def test_interrupt_is_a_control_request_not_a_signal(self):
        self.opened()
        self.events.clear()
        self.a.send({"message_id": "m1", "text": "slow count", "images": []})
        self.until(lambda e: e["ev"] == "text_delta")
        self.a.interrupt()
        done = self.until(lambda e: e["ev"] == "turn_done")
        self.assertEqual(done["status"], "interrupted")
        self.assertTrue(self.a.alive())
        self.assertEqual(self.logged("signal"), [])
        ctrl = [m["request"]["subtype"] for m in self.logged("in") if m["type"] == "control_request"]
        self.assertEqual(ctrl, ["initialize", "interrupt"])
        with self.assertRaises(cp.ChatError) as cm:
            self.a.interrupt()
        self.assertEqual(cm.exception.code, "not_running")

    def test_process_death_mid_turn_ends_the_turn(self):
        self.opened()
        self.events.clear()
        self.a.send({"message_id": "m1", "text": "die now", "images": []})
        closed = self.until(lambda e: e["ev"] == "closed")
        evs = [e["ev"] for e in self.events]
        self.assertLess(evs.index("turn_done"), evs.index("closed"))
        done = next(e for e in self.events if e["ev"] == "turn_done")
        self.assertEqual(done["status"], "error")
        err = next(e for e in self.events if e["ev"] == "error")
        self.assertEqual((err["code"], err["fatal"]), ("process_exited", True))
        self.assertIn("boom", err["message"])
        self.assertEqual((closed["reason"], closed["exit_code"]), ("exited", 3))
        self.assertEqual(self.a.lifecycle, "stopped")

    def test_set_model_and_mode_answer_with_state(self):
        self.opened()
        self.events.clear()
        self.a.set_model("sonnet")
        st = self.until(lambda e: e["ev"] == "state")
        self.assertEqual(st["model"], "sonnet")
        self.events.clear()
        self.a.set_permission_mode("plan")
        st = self.until(lambda e: e["ev"] == "state")
        self.assertEqual(st["permission_mode"], "plan")
        with self.assertRaises(cp.ChatError):
            self.a.set_model("bad model; rm")

    def test_model_changes_mid_conversation_in_the_same_process(self):
        # `dispatch agent model`: after a turn, the next one runs on the new model without a restart;
        # during a turn it is refused; a model the CLI rejects leaves the old one in place.
        self.opened()
        self.turn("Reply with exactly: pong")
        pid = self.a.proc.pid
        self.events.clear()
        self.a.send({"message_id": "m2", "text": "slow count", "images": []})
        self.until(lambda e: e["ev"] == "text_delta")
        with self.assertRaises(cp.ChatError) as cm:
            self.a.set_model("opus")
        self.assertEqual(cm.exception.code, "session_busy")
        self.a.interrupt()
        self.until(lambda e: e["ev"] == "turn_done")
        self.events.clear()
        self.a.set_model("opus")
        self.assertEqual(self.until(lambda e: e["ev"] == "state")["model"], "opus")
        self.events.clear()
        self.a.set_model("retired-model")
        err = self.until(lambda e: e["ev"] == "error")
        self.assertEqual((err["code"], err["fatal"]), ("invalid_model", False))
        self.assertEqual(self.a.state()["model"], "opus")
        self.turn("Reply with exactly: pong", "m3")
        self.assertEqual(self.a.proc.pid, pid)  # same process: the conversation's context stays
        asked = [m["request"]["model"] for m in self.logged("in") if m["type"] == "control_request" and m["request"]["subtype"] == "set_model"]
        self.assertEqual(asked, ["opus", "retired-model"])

    def test_close_ends_the_process(self):
        self.opened()
        self.a.close("requested")
        closed = [e for e in self.events if e["ev"] == "closed"]
        self.assertEqual(len(closed), 1)
        self.assertEqual(closed[0]["reason"], "requested")
        self.assertFalse(self.a.alive())
        self.assertEqual(self.a.lifecycle, "stopped")

    def test_images_go_as_base64_blocks(self):
        self.opened()
        self.events.clear()
        self.a.send({"message_id": "m1", "text": "pong", "images": [{"media_type": "image/png", "data": "aGVsbG8="}]})
        self.until(lambda e: e["ev"] == "turn_done")
        sent = [m for m in self.logged("in") if m["type"] == "user"][0]
        self.assertEqual(sent["message"]["content"][1], {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aGVsbG8="}})
        self.assertEqual(self.events[0]["images_n"], 1)


class Probe(unittest.TestCase):
    def test_windows_is_not_supported(self):
        with patch.object(cc.P, "IS_WIN", True), patch.object(cc.P, "which", return_value="claude"), \
                patch.object(cc.subprocess, "run", return_value=type("R", (), {"stdout": "2.1.282 (Claude Code)", "stderr": ""})()):
            p = cc.probe()
        self.assertEqual((p["available"], p["supported"]), (True, False))
        self.assertIn("Windows", p["reason"])

    def test_old_version_is_refused_and_missing_binary_said(self):
        with patch.object(cc.P, "IS_WIN", False), patch.object(cc.P, "which", return_value="claude"), \
                patch.object(cc.subprocess, "run", return_value=type("R", (), {"stdout": "2.1.99 (Claude Code)", "stderr": ""})()):
            p = cc.probe()
        self.assertFalse(p["supported"]); self.assertEqual(p["version"], "2.1.99")
        with patch.object(cc.P, "IS_WIN", False), patch.object(cc.P, "which", return_value="claude"), \
                patch.object(cc.subprocess, "run", return_value=type("R", (), {"stdout": "2.1.282 (Claude Code)", "stderr": ""})()):
            self.assertTrue(cc.probe()["supported"])
        with patch.object(cc.P, "which", return_value=None):
            self.assertFalse(cc.probe()["available"])

    def test_diff_and_question_helpers(self):
        self.assertEqual(cc.diff_of("Write", {"file_path": "/a", "content": "x"}), {"path": "/a", "kind": "write", "old": "", "new": "x"})
        self.assertIsNone(cc.diff_of("Bash", {"command": "ls"}))
        qs = cc.questions_of({"questions": [{"question": "Which?", "options": [{"label": "A"}, {"label": "B"}], "multiSelect": True}]})
        self.assertEqual(qs, [{"id": "Which?", "text": "Which?", "options": ["A", "B"], "multi": True}])
        self.assertEqual(cc.project_dir_name("/private/tmp/dispatch-chat-scratch"), "-private-tmp-dispatch-chat-scratch")


if __name__ == "__main__":
    unittest.main()
