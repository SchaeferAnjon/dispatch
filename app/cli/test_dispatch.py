# -*- coding: utf-8 -*-
import importlib
import importlib.util
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import types
import unittest
from unittest import mock
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("dispatch", os.path.join(HERE, "dispatch.py"))
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)
import memories  # noqa: E402  (HERE is on sys.path under unittest discover; shares the sys.modules dispatch that summarize uses)


class RetiredAgentCache(unittest.TestCase):
    def test_old_local_and_remote_entries_do_not_reappear(self):
        rows = {"old": {"agent": "qoder"}, "ide": {"agent": "qoder-ide"}, "keep": {"agent": "codex"}}
        with tempfile.NamedTemporaryFile("w", suffix=".json") as f:
            json.dump(rows, f); f.flush()
            with patch.object(dispatch, "INDEX_FILE", f.name):
                self.assertEqual(dispatch.load_index(), {"keep": rows["keep"]})
            # Migration changes Dispatch's view, not another application's source data.
            with open(f.name) as saved:
                self.assertEqual(json.load(saved), rows)
        self.assertEqual(dispatch._only_theirs(list(rows.values())), [rows["keep"]])


class ResumeCommand(unittest.TestCase):
    def test_claude(self):
        self.assertEqual(dispatch.resume_command("claude-code", "abc", "/Users/x/p"), "cd '/Users/x/p' && claude --resume abc")

    def test_codex(self):
        self.assertEqual(dispatch.resume_command("codex", "abc", ""), "codex resume abc")

    def test_quotes_in_cwd_are_escaped(self):
        cmd = dispatch.resume_command("claude-code", "abc", "/Users/x/it's")
        self.assertIn("'/Users/x/it'\\''s'", cmd)

    def test_zcode_has_no_cli(self):
        self.assertTrue(dispatch.resume_command("zcode", "sess_1", "/x").startswith("open -a ZCode"))


class HostApp(unittest.TestCase):
    def test_walks_to_app_bundle(self):
        table = {10: (5, "/opt/homebrew/bin/fish"), 5: (1, "/Applications/Ghostty.app/Contents/MacOS/ghostty"), 1: (0, "launchd")}
        self.assertEqual(dispatch.host_app_of(10, table), "Ghostty")

    def test_none_without_bundle(self):
        table = {10: (1, "fish"), 1: (0, "launchd")}
        self.assertIsNone(dispatch.host_app_of(10, table))

    def test_skips_the_claude_cli_own_updater_wrapper(self):
        # The `claude` CLI re-execs itself through its own updater's .app on the way up from any
        # terminal — that used to be mistaken for the hosting app; the real host (Ghostty here)
        # is one hop further up the chain.
        table = {
            20: (15, "/Users/x/.local/share/claude/versions/1.2.3"),
            15: (10, "/Users/x/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude"),
            10: (5, "/opt/homebrew/bin/fish"),
            5: (1, "/Applications/Ghostty.app/Contents/MacOS/ghostty"),
            1: (0, "launchd"),
        }
        self.assertEqual(dispatch.host_app_of(20, table), "Ghostty")


class SessionDetailClaude(unittest.TestCase):
    def test_timeline_and_file_changes(self):
        lines = [
            {"type": "user", "timestamp": "2026-09-02T10:00:00Z", "message": {"role": "user", "content": "修一下 task-1"}},
            {"type": "assistant", "timestamp": "2026-09-02T10:00:05Z", "message": {"role": "assistant", "content": [
                {"type": "text", "text": "好的"},
                {"type": "tool_use", "id": "t1", "name": "Edit", "input": {"file_path": "/x/a.ts", "old_string": "a", "new_string": "b"}},
                {"type": "tool_use", "id": "t2", "name": "Bash", "input": {"command": "npm test"}},
            ]}},
            {"type": "user", "timestamp": "2026-09-02T10:00:06Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}},
            {"type": "user", "isSidechain": True, "timestamp": "2026-09-02T10:00:07Z", "message": {"role": "user", "content": "subagent noise"}},
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
            for l in lines:
                f.write(json.dumps(l) + "\n")
        ref = {"agent": "claude-code", "path": f.name, "session_id": "s", "cwd": "/x", "title": "", "tasks": {}, "subagents": []}
        d = dispatch.read_session_detail(ref)
        self.assertEqual([m["role"] for m in d["messages"]], ["user", "assistant"])
        self.assertEqual([t["name"] for t in d["messages"][1]["tools"]], ["Edit", "Bash"])
        self.assertEqual(d["files"][0]["path"], "/x/a.ts")
        self.assertEqual(d["files"][0]["changes"][0]["new"], "b")
        self.assertEqual(d["tool_counts"], {"Edit": 1, "Bash": 1})
        os.unlink(f.name)


class CompactInputDiffCaps(unittest.TestCase):
    """The timeline's tool_call.input keeps enough of an edit's old/new text to diff (capped),
    while a non-edit tool (or a non-diff argument on an edit tool) still clips at INPUT_CHARS."""

    def test_edit_keeps_full_old_new_under_the_diff_cap(self):
        out = dispatch._compact_input({"file_path": "/x/a.ts", "old_string": "a" * 1000, "new_string": "b" * 1000}, "Edit")
        self.assertEqual(len(out["old_string"]), 1000)
        self.assertEqual(len(out["new_string"]), 1000)
        self.assertNotIn("truncated", out)

    def test_edit_old_new_are_capped_and_marked_truncated(self):
        out = dispatch._compact_input({"file_path": "/x/a.ts", "old_string": "x" * 100_000, "new_string": "y\n" * 1000}, "Edit")
        self.assertLessEqual(len(out["old_string"].encode("utf-8")), dispatch.DIFF_BYTE_CAP)
        self.assertLessEqual(out["new_string"].count("\n") + 1, dispatch.DIFF_LINE_CAP)
        self.assertTrue(out["truncated"])

    def test_non_edit_tool_still_uses_the_small_cap(self):
        out = dispatch._compact_input({"command": "x" * 1000}, "Bash")
        self.assertEqual(len(out["command"]), dispatch.INPUT_CHARS + 1)  # clipped text + the "…" marker
        self.assertNotIn("truncated", out)

    def test_multiedit_keeps_each_hunk_old_new(self):
        edits = [{"old_string": "a", "new_string": "b"}, {"old_string": "c" * 100_000, "new_string": "d", "replace_all": True}]
        out = dispatch._compact_input({"file_path": "/x/a.ts", "edits": edits}, "MultiEdit")
        self.assertEqual(len(out["edits"]), 2)
        self.assertEqual(out["edits"][0], {"old_string": "a", "new_string": "b"})
        self.assertEqual(out["edits"][1]["replace_all"], True)
        self.assertLessEqual(len(out["edits"][1]["old_string"].encode("utf-8")), dispatch.DIFF_BYTE_CAP)
        self.assertTrue(out["truncated"])

    def test_write_content_kept_for_diff(self):
        out = dispatch._compact_input({"file_path": "/x/a.ts", "content": "line\n" * 50}, "Write")
        self.assertEqual(out["content"], "line\n" * 50)

    def test_codex_apply_patch_input_kept_for_diff(self):
        patch = "*** Begin Patch\n*** Update File: x/y.py\n@@\n-old\n+new\n*** End Patch"
        out = dispatch._compact_input({"input": patch}, "apply_patch")
        self.assertEqual(out["input"], patch)


class SessionDetailBlocks(unittest.TestCase):
    """The block timeline: thinking, text and tool calls paired with their results, for every agent."""

    def _write(self, lines):
        f = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
        for l in lines:
            f.write(json.dumps(l, ensure_ascii=False) + "\n")
        f.close()
        self.addCleanup(os.unlink, f.name)
        return f.name

    def _ref(self, agent, path):
        return {"agent": agent, "path": path, "session_id": "s", "cwd": "/x", "title": "", "tasks": {}, "subagents": []}

    def test_codex_live_operation_summary_stays_on_the_original_call(self):
        raw = 'text(await tools.exec_command({cmd: "npm test", yield_time_ms: 1000}));'
        path = self._write([
            {"type": "response_item", "timestamp": "2026-09-02T10:00:00Z", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "开始检查。"}]}},
            {"type": "response_item", "timestamp": "2026-09-02T10:00:01Z", "payload": {"type": "custom_tool_call", "name": "functions.exec", "call_id": "live-call", "input": raw}},
        ])
        ref = self._ref("codex", path)
        first = dispatch.read_session_detail(ref)
        call = next(b for m in first['messages'] for b in m['blocks'] if b['type'] == 'tool_call')
        self.assertEqual(call['summary'], '运行命令 · npm test')
        self.assertEqual(call['input'], {'input': raw})
        self.assertEqual(call['status'], 'running')
        with open(path, 'a') as f:
            f.write(json.dumps({"type": "response_item", "timestamp": "2026-09-02T10:00:02Z", "payload": {"type": "custom_tool_call_output", "call_id": "live-call", "output": "42 passed"}}) + '\n')
        tail = dispatch.read_session_detail(ref, since=first['offset'])
        self.assertEqual(tail['messages'], [])
        self.assertEqual(tail['resolved'][0]['id'], 'live-call')
        full = dispatch.read_session_detail(ref)
        calls = [b for m in full['messages'] for b in m['blocks'] if b['type'] == 'tool_call']
        self.assertEqual(len(calls), 1)
        self.assertEqual((calls[0]['summary'], calls[0]['status'], calls[0]['result']), ('运行命令 · npm test', 'done', '42 passed'))

    def test_claude_blocks_merge_one_message_and_pair_results(self):
        # Claude writes each content block as its own line, all sharing message.id.
        lines = [
            {"type": "user", "timestamp": "2026-09-02T10:00:00Z", "message": {"role": "user", "content": "看一下"}},
            {"type": "assistant", "timestamp": "2026-09-02T10:00:01Z", "message": {"id": "m1", "role": "assistant", "content": [{"type": "thinking", "thinking": "先读文件", "signature": "x"}]}},
            {"type": "assistant", "timestamp": "2026-09-02T10:00:02Z", "message": {"id": "m1", "role": "assistant", "content": [{"type": "text", "text": "我先看看。"}]}},
            {"type": "assistant", "timestamp": "2026-09-02T10:00:03Z", "message": {"id": "m1", "role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls", "description": "list"}}]}},
            {"type": "user", "timestamp": "2026-09-02T10:00:04Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "a.ts\nb.ts"}]}},
            {"type": "assistant", "timestamp": "2026-09-02T10:00:05Z", "message": {"id": "m2", "role": "assistant", "content": [{"type": "thinking", "thinking": "", "signature": "x"}]}},
            {"type": "assistant", "timestamp": "2026-09-02T10:00:06Z", "message": {"id": "m2", "role": "assistant", "content": [{"type": "tool_use", "id": "t2", "name": "Read", "input": {"file_path": "/x/a.ts"}}]}},
            {"type": "user", "timestamp": "2026-09-02T10:00:07Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t2", "content": [{"type": "text", "text": "no such file"}], "is_error": True}]}},
            {"type": "assistant", "timestamp": "2026-09-02T10:00:08Z", "message": {"id": "m3", "role": "assistant", "content": [{"type": "tool_use", "id": "t3", "name": "Bash", "input": {"command": "sleep 99"}}]}},
        ]
        path = self._write(lines)
        d = dispatch.read_session_detail(self._ref("claude-code", path))
        self.assertEqual([m["role"] for m in d["messages"]], ["user", "assistant", "assistant", "assistant"])
        m1 = d["messages"][1]
        self.assertEqual([b["type"] for b in m1["blocks"]], ["thinking", "text", "tool_call"])
        self.assertEqual(m1["blocks"][0]["text"], "先读文件")
        self.assertEqual(m1["text"], "我先看看。")
        self.assertEqual([t["name"] for t in m1["tools"]], ["Bash"])
        t1 = m1["blocks"][2]
        self.assertEqual((t1["status"], t1["result"], t1["result_ts"]), ("done", "a.ts\nb.ts", "2026-09-02T10:00:04Z"))
        self.assertEqual(t1["input"], {"command": "ls", "description": "list"})
        m2 = d["messages"][2]
        self.assertIn("note", m2["blocks"][0])  # signature-only thinking is still shown as a step
        self.assertEqual((m2["blocks"][1]["status"], m2["blocks"][1]["result"]), ("error", "no such file"))
        # A call that never got its result in a file nobody writes to any more is not "running".
        self.assertEqual(d["messages"][3]["blocks"][0]["status"], "running")  # the file was just written to
        os.utime(path, (time.time() - 3600, time.time() - 3600))
        d = dispatch.read_session_detail(self._ref("claude-code", path))
        self.assertEqual(d["messages"][3]["blocks"][0]["status"], "incomplete")
        self.assertEqual(d["offset"], os.path.getsize(path))
        self.assertEqual(d["tool_counts"], {"Bash": 2, "Read": 1})

    def test_since_reads_only_new_records_and_reports_results_for_earlier_calls(self):
        first = [
            {"type": "user", "timestamp": "2026-09-02T10:00:00Z", "message": {"role": "user", "content": "跑测试"}},
            {"type": "assistant", "timestamp": "2026-09-02T10:00:01Z", "message": {"id": "m1", "role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "npm test"}}]}},
        ]
        path = self._write(first)
        d = dispatch.read_session_detail(self._ref("claude-code", path))
        self.assertEqual(d["messages"][1]["blocks"][0]["status"], "running")
        off = d["offset"]
        with open(path, "a") as f:
            f.write(json.dumps({"type": "user", "timestamp": "2026-09-02T10:00:09Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "42 passed"}]}}) + "\n")
            f.write(json.dumps({"type": "assistant", "timestamp": "2026-09-02T10:00:10Z", "message": {"id": "m2", "role": "assistant", "content": [{"type": "text", "text": "都过了。"}]}}) + "\n")
            f.write('{"type":"assistant","timestamp":"2026-09-02T10:00:11Z","message":{"id":"m3","role":"assistant","content":[{"type":"text","text":"half')  # still being written
        d2 = dispatch.read_session_detail(self._ref("claude-code", path), since=off)
        self.assertTrue(d2["partial"])
        self.assertEqual(d2["since"], off)
        self.assertEqual([m["text"] for m in d2["messages"]], ["都过了。"])
        self.assertEqual(d2["resolved"], [{"id": "t1", "status": "done", "result": "42 passed", "result_ts": "2026-09-02T10:00:09Z"}])
        self.assertLess(d2["offset"], os.path.getsize(path))  # the unfinished line is left for the next read
        d3 = dispatch.read_session_detail(self._ref("claude-code", path), since=d2["offset"])
        self.assertEqual((d3["messages"], d3["resolved"], d3["offset"]), ([], [], d2["offset"]))

    def test_codex_reasoning_and_tool_output(self):
        lines = [
            {"type": "response_item", "timestamp": "2026-09-02T10:00:00Z", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "看看目录"}]}},
            {"type": "response_item", "timestamp": "2026-09-02T10:00:01Z", "payload": {"type": "reasoning", "summary": [{"type": "summary_text", "text": "列出文件"}], "encrypted_content": "x"}},
            {"type": "response_item", "timestamp": "2026-09-02T10:00:02Z", "payload": {"type": "function_call", "name": "exec_command", "call_id": "c1", "arguments": json.dumps({"cmd": "ls"})}},
            {"type": "response_item", "timestamp": "2026-09-02T10:00:03Z", "payload": {"type": "function_call_output", "call_id": "c1", "output": "Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 1\nOutput:\nboom"}},
            {"type": "response_item", "timestamp": "2026-09-02T10:00:04Z", "payload": {"type": "reasoning", "summary": [], "encrypted_content": "x"}},
            {"type": "response_item", "timestamp": "2026-09-02T10:00:05Z", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "失败了。"}]}},
        ]
        d = dispatch.read_session_detail(self._ref("codex", self._write(lines)))
        self.assertEqual([m["role"] for m in d["messages"]], ["user", "assistant", "assistant"])
        a1 = d["messages"][1]["blocks"]
        self.assertEqual([b["type"] for b in a1], ["thinking", "tool_call"])
        self.assertEqual(a1[0]["text"], "列出文件")
        self.assertEqual((a1[1]["name"], a1[1]["summary"], a1[1]["status"], a1[1]["result"]), ("exec_command", "ls", "error", "boom"))
        a2 = d["messages"][2]["blocks"]
        self.assertEqual([b["type"] for b in a2], ["thinking", "text"])
        self.assertIn("model_reasoning_summary", a2[0]["note"])
        self.assertEqual(d["messages"][2]["text"], "失败了。")

    def test_pi_thinking_and_tool_result(self):
        lines = [
            {"type": "message", "timestamp": "2026-09-02T10:00:00Z", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}},
            {"type": "message", "timestamp": "2026-09-02T10:00:01Z", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "看一眼", "thinkingSignature": "s"}, {"type": "toolCall", "id": "p1", "name": "bash", "arguments": {"command": "pwd"}}]}},
            {"type": "message", "timestamp": "2026-09-02T10:00:02Z", "message": {"role": "toolResult", "toolCallId": "p1", "toolName": "bash", "isError": False, "content": [{"type": "text", "text": "/x"}]}},
        ]
        d = dispatch.read_session_detail(self._ref("pi", self._write(lines)))
        self.assertEqual([m["role"] for m in d["messages"]], ["user", "assistant"])
        b = d["messages"][1]["blocks"]
        self.assertEqual([x["type"] for x in b], ["thinking", "tool_call"])
        self.assertEqual((b[1]["status"], b[1]["result"], b[1]["summary"]), ("done", "/x", "pwd"))

    def test_hermes_resumes_with_hermes_chat(self):
        self.assertEqual(dispatch.resume_command("hermes", "20260907_220548_54ce4c", "/x"), "cd '/x' && hermes chat --resume 20260907_220548_54ce4c")

    def test_hermes_messages_pair_tool_results_by_call_id(self):
        call = json.dumps([{"id": "c1", "type": "function", "function": {"name": "write_file", "arguments": json.dumps({"path": "/x/a.md", "content": "hi"})}}])
        msgs = [
            {"id": 1, "role": "user", "content": "写个文件", "tool_calls": None, "tool_call_id": None, "tool_name": None, "timestamp": 1000.0, "reasoning": None, "reasoning_content": None, "display_kind": None},
            {"id": 2, "role": "assistant", "content": "", "tool_calls": call, "tool_call_id": None, "tool_name": None, "timestamp": 1001.0, "reasoning": "先写再说", "reasoning_content": None, "display_kind": None},
            {"id": 3, "role": "tool", "content": json.dumps({"success": True, "output": "written"}), "tool_calls": None, "tool_call_id": "c1", "tool_name": "write_file", "timestamp": 1002.0, "reasoning": None, "reasoning_content": None, "display_kind": None},
            {"id": 4, "role": "assistant", "content": "写好了", "tool_calls": None, "tool_call_id": None, "tool_name": None, "timestamp": 1003.0, "reasoning": None, "reasoning_content": None, "display_kind": None},
        ]
        orig = dispatch.hermes_query
        def fake(sql, params=()):
            if sql.startswith("select ended_at"):
                return [{"ended_at": 1003.0}]
            return [m for m in msgs if "id > ?" not in sql or m["id"] > params[1]]
        dispatch.hermes_query = fake
        try:
            d = dispatch.read_hermes_detail({"agent": "hermes", "session_id": "s", "cwd": "/x"}, 400)
            self.assertEqual([m["role"] for m in d["messages"]], ["user", "assistant", "assistant"])
            b = d["messages"][1]["blocks"]
            self.assertEqual([x["type"] for x in b], ["thinking", "tool_call"])
            self.assertEqual((b[1]["name"], b[1]["status"], b[1]["result"], b[1]["summary"]), ("write_file", "done", '{"success": true, "output": "written"}', "/x/a.md"))
            self.assertEqual([f["path"] for f in d["files"]], ["/x/a.md"])
            self.assertEqual(d["offset"], 4)
            d2 = dispatch.read_hermes_detail({"agent": "hermes", "session_id": "s", "cwd": "/x"}, 400, since=2)
            self.assertEqual(([m["role"] for m in d2["messages"]], [r["id"] for r in d2["resolved"]]), (["assistant"], ["c1"]))
        finally:
            dispatch.hermes_query = orig

    def test_zcode_parts_become_blocks_with_their_own_status(self):
        rows = [
            {"pdata": json.dumps({"type": "text", "text": "改一下", "messageID": "u1"}), "mdata": json.dumps({"role": "user", "id": "u1"}), "ts": 1000, "tu": 1000},
            {"pdata": json.dumps({"type": "reasoning", "text": "先读再改", "messageID": "a1"}), "mdata": json.dumps({"role": "assistant", "id": "a1"}), "ts": 2000, "tu": 2000},
            {"pdata": json.dumps({"type": "tool", "tool": "read", "callID": "z1", "state": {"status": "completed", "input": {"filePath": "/x/a.ts"}, "output": "const a"}, "messageID": "a1"}), "mdata": json.dumps({"role": "assistant", "id": "a1"}), "ts": 3000, "tu": 3500},
            {"pdata": json.dumps({"type": "tool", "tool": "bash", "callID": "z2", "state": {"status": "running", "input": {"command": "npm test"}}, "messageID": "a1"}), "mdata": json.dumps({"role": "assistant", "id": "a1"}), "ts": 4000, "tu": 4000},
        ]
        orig = dispatch.zcode_query
        dispatch.zcode_query = lambda sql, params=(), agent="zcode": [r for r in rows if "time_updated >" not in sql or r["tu"] > params[1]]
        try:
            d = dispatch.read_zcode_detail({"agent": "zcode", "session_id": "s", "cwd": "/x"}, 400)
            self.assertEqual([m["role"] for m in d["messages"]], ["user", "assistant"])
            b = d["messages"][1]["blocks"]
            self.assertEqual([x["type"] for x in b], ["thinking", "tool_call", "tool_call"])
            self.assertEqual((b[1]["status"], b[1]["result"]), ("done", "const a"))
            self.assertEqual(b[2]["status"], "incomplete")  # nobody wrote to this session for a long time
            self.assertEqual(d["offset"], 4000)
            d2 = dispatch.read_zcode_detail({"agent": "zcode", "session_id": "s", "cwd": "/x"}, 400, since=3000)
            self.assertEqual([x["id"] for m in d2["messages"] for x in m["blocks"]], ["z1", "z2"])
        finally:
            dispatch.zcode_query = orig


class HeadlessSteps(unittest.TestCase):
    """The discussion's typing bubble learns what a member is on: 想：<thought> / 查：<tool> <what>."""

    def test_claude_stream_events_become_steps(self):
        events = [
            {"type": "system", "subtype": "init"},
            {"type": "stream_event", "event": {"type": "content_block_start", "content_block": {"type": "thinking"}}},
            {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "先看板"}}},
            {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "上的任务"}}},
            {"type": "stream_event", "event": {"type": "content_block_stop"}},
            {"type": "stream_event", "event": {"type": "content_block_start", "content_block": {"type": "tool_use", "name": "Bash"}}},
            {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": "{\"command\": \"bd list"}}},
            {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": " --json\"}"}}},
            {"type": "stream_event", "event": {"type": "content_block_stop"}},
            {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "[]"}]}},
            {"type": "stream_event", "event": {"type": "content_block_start", "content_block": {"type": "text"}}},
            {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "没有任务。"}}},
            {"type": "result", "result": "没有任务。", "session_id": "sess-1"},
        ]
        tmp = tempfile.mkdtemp()
        with open(os.path.join(tmp, "events.jsonl"), "w") as f:
            f.write("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events))
        fake = os.path.join(tmp, "claude")  # a stand-in `claude -p` that replays the stream
        with open(fake, "w") as f:
            f.write(f"#!/usr/bin/env python3\nimport sys\nsys.stdout.write(open({os.path.join(tmp, 'events.jsonl')!r}, encoding='utf-8').read())\n")
        os.chmod(fake, 0o755)
        seen = []
        orig = dispatch.child_env
        dispatch.child_env = lambda: {**orig(), "PATH": tmp + ":" + orig()["PATH"]}
        try:
            res = dispatch.headless_call("claude", "", "hi", tmp, 30000, on_event=lambda status, text, step="": seen.append((status, text, step)))
        finally:
            dispatch.child_env = orig
        self.assertEqual(res["text"], "没有任务。")
        self.assertIn(("thinking", "", "想：先看板上的任务"), seen)
        self.assertIn(("thinking", "", "查：Bash bd list --json"), seen)
        self.assertIn(("thinking", "", ""), seen[seen.index(("thinking", "", "查：Bash bd list --json")):])  # the tool answered
        self.assertEqual(seen[-2:], [("typing", "没有任务。", ""), ("done", "没有任务。", "")])

    def test_live_file_keeps_the_step(self):
        orig = dispatch.DISCUSSIONS_DIR
        dispatch.DISCUSSIONS_DIR = tempfile.mkdtemp()
        try:
            live = dispatch.DiscussionLive("task-1", 1, [("claude（opus）", "claude")])
            live.update("claude（opus）", "thinking", "", "想：先看板")
            m = json.load(open(live.path))["members"]["claude（opus）"]
            self.assertEqual((m["status"], m["step"]), ("thinking", "想：先看板"))
            live.update("claude（opus）", "typing", "好的")
            m = json.load(open(live.path))["members"]["claude（opus）"]
            self.assertEqual((m["status"], m["step"], m["text"]), ("typing", "", "好的"))
        finally:
            dispatch.DISCUSSIONS_DIR = orig


class RulesSync(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.rules = os.path.join(self.tmp, "GLOBAL.md")
        with open(self.rules, "w") as f:
            f.write("# rules\n- fish, not bash\n")
        self._orig = (dispatch.RULES_FILE, dict(dispatch.RULE_TARGETS))
        dispatch.RULES_FILE = self.rules
        dispatch.RULE_TARGETS = {
            "claude": {"path": os.path.join(self.tmp, "CLAUDE.md"), "mode": "import"},
            "codex": {"path": os.path.join(self.tmp, "AGENTS.md"), "mode": "inline"},
        }
        with open(dispatch.RULE_TARGETS["claude"]["path"], "w") as f:
            f.write("# claude only\n")

    def tearDown(self):
        dispatch.RULES_FILE, dispatch.RULE_TARGETS = self._orig

    def _sync(self, force=False):
        import io, contextlib
        a = type("A", (), {"op": "sync", "force": force, "json": True})()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            dispatch.cmd_rules(a)
        return json.loads(buf.getvalue())

    def test_sync_creates_appends_and_is_idempotent(self):
        r = self._sync()
        self.assertEqual({x["agent"]: x["action"] for x in r["results"]}, {"claude": "appended", "codex": "created"})
        claude = open(dispatch.RULE_TARGETS["claude"]["path"]).read()
        self.assertTrue(claude.startswith("# claude only\n"))
        self.assertIn("@" + self.rules, claude)  # import, not a copy
        codex = open(dispatch.RULE_TARGETS["codex"]["path"]).read()
        self.assertIn("- fish, not bash", codex)  # inlined
        r2 = self._sync()
        self.assertTrue(all(x["action"] == "unchanged" for x in r2["results"]))

    def test_edit_marks_stale_and_updates_in_place(self):
        self._sync()
        with open(self.rules, "a") as f:
            f.write("- new rule\n")
        h = dispatch.rules_hash(dispatch.rules_text())
        self.assertEqual(dispatch.target_state("codex", h)[0], "stale")
        r = self._sync()
        self.assertEqual({x["agent"]: x["action"] for x in r["results"]}, {"claude": "updated", "codex": "updated"})
        codex = open(dispatch.RULE_TARGETS["codex"]["path"]).read()
        self.assertEqual(codex.count(dispatch.RULES_BEGIN), 1)
        self.assertIn("- new rule", codex)


class Frontmatter(unittest.TestCase):
    def test_reads_name_and_description(self):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "SKILL.md"), "w") as f:
            f.write('---\nname: x\ndescription: "does things"\n---\n# x\n')
        fm = dispatch.read_frontmatter(d)
        self.assertEqual(fm["description"], "does things")


if __name__ == "__main__":
    unittest.main()


class EnvStore(unittest.TestCase):
    def test_roundtrip_mask_and_fish(self):
        with tempfile.TemporaryDirectory() as d:
            dispatch.ENV_DIR = d; dispatch.ENV_FILE = os.path.join(d, "env"); dispatch.ENV_FISH = os.path.join(d, "env.fish")
            dispatch.env_write([{"name": "ZHIPU_API_KEY", "value": "abc123def456", "note": "智谱 GLM"}, {"name": "X", "value": "has space #1", "note": ""}])
            items = dispatch.env_read()
            self.assertEqual([i["name"] for i in items], ["ZHIPU_API_KEY", "X"])
            self.assertEqual(items[0]["note"], "智谱 GLM"); self.assertEqual(items[1]["value"], "has space #1")
            self.assertEqual(oct(os.stat(dispatch.ENV_FILE).st_mode & 0o777), "0o600")
            self.assertEqual(dispatch.env_mask("abc123def456"), "abc…456")
            self.assertIn("set -gx X 'has space #1'", open(dispatch.ENV_FISH).read())
            self.assertIn("ZHIPU_API_KEY=智谱 GLM", dispatch.env_summary_line())

    def test_project_keys_stay_with_their_project(self):
        with tempfile.TemporaryDirectory() as d:
            dispatch.ENV_DIR = d; dispatch.ENV_FILE = os.path.join(d, "env"); dispatch.ENV_FISH = os.path.join(d, "env.fish")
            dispatch.env_write([{"name": "ZHIPU_API_KEY", "value": "abc123def456", "note": "智谱 GLM"},
                                {"name": "THBW_NETWAYS_API_KEY", "value": "nw-secret-1", "note": "Netways Managed AI", "project": "HIWI"},
                                {"name": "OTHER_KEY", "value": "o-1", "note": "", "project": "notesapp"}])
            items = dispatch.env_read()
            self.assertEqual([(i["name"], i["project"]) for i in items], [("ZHIPU_API_KEY", ""), ("THBW_NETWAYS_API_KEY", "HIWI"), ("OTHER_KEY", "notesapp")])
            self.assertEqual(items[1]["note"], "Netways Managed AI")
            self.assertIn("# project: HIWI\n# Netways Managed AI\nTHBW_NETWAYS_API_KEY=", open(dispatch.ENV_FILE).read())
            # prime: machine-wide keys everywhere, a project's keys only in that project
            self.assertNotIn("THBW_NETWAYS", dispatch.env_summary_line())
            self.assertNotIn("OTHER_KEY", dispatch.env_summary_line("hiwi"))
            self.assertIn("THBW_NETWAYS_API_KEY=Netways Manage［本项目］", dispatch.env_summary_line("hiwi"))
            self.assertIn("ZHIPU_API_KEY", dispatch.env_summary_line("hiwi"))
            # list -P filters; set -P assigns; set with -P "" clears
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                dispatch.cmd_env(types.SimpleNamespace(op="list", name=None, value=None, note=None, project="HIWI", stdin=False, fish=False, json=True))
            self.assertEqual([r["name"] for r in json.loads(buf.getvalue())], ["THBW_NETWAYS_API_KEY"])
            with contextlib.redirect_stdout(io.StringIO()):
                dispatch.cmd_env(types.SimpleNamespace(op="set", name="ZHIPU_API_KEY", value="abc123def456", note=None, project="kanban", stdin=False, fish=False, json=False))
                dispatch.cmd_env(types.SimpleNamespace(op="set", name="OTHER_KEY", value="o-1", note=None, project="", stdin=False, fish=False, json=False))
            by = {i["name"]: i["project"] for i in dispatch.env_read()}
            self.assertEqual(by, {"ZHIPU_API_KEY": "kanban", "THBW_NETWAYS_API_KEY": "HIWI", "OTHER_KEY": ""})


class Guards(unittest.TestCase):
    def test_quota_modes(self):
        self.assertEqual(dispatch.quota_mode(None)[0], None)
        self.assertEqual(dispatch.quota_mode(30)[0], "normal")
        self.assertEqual(dispatch.quota_mode(80)[0], "saving")
        self.assertIn("省 token", dispatch.quota_mode(85)[1])
        self.assertEqual(dispatch.quota_mode(97)[0], "critical")
    def test_similar_titles(self):
        self.assertGreaterEqual(dispatch.similar("Dispatch 技能视图：使用频次", "Dispatch 技能视图 使用频次 + 按钮"), 0.5)
        self.assertLess(dispatch.similar("Mac mini 安装 Dolt", "雅思刷题网站"), 0.5)
    def test_neighbours_matches_same_or_nested_dir(self):
        rows = [
            {"session_id": "me", "cwd": "/a/b", "alive": True}, {"session_id": "x", "cwd": "/a/b", "alive": True},
            {"session_id": "y", "cwd": "/a/b/sub", "alive": True}, {"session_id": "z", "cwd": "/other", "alive": True}, {"session_id": "d", "cwd": "/a/b", "alive": False}]
        seen = {}
        with patch.object(dispatch, "live_sessions", side_effect=lambda local_only=False: seen.update(local_only=local_only) or rows):
            self.assertEqual([s["session_id"] for s in dispatch.neighbours("/a/b", "me")], ["x", "y"])
            self.assertFalse(seen["local_only"])
            dispatch.neighbours("/a/b", "me", local_only=True)   # what the SessionStart hook asks for
            self.assertTrue(seen["local_only"])


class EditGuard(unittest.TestCase):
    def test_paths_from_tool_inputs(self):
        spec = importlib.util.spec_from_file_location("edit_guard", os.path.join(HERE, "edit-guard.py"))
        g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
        self.assertEqual(g.files_of("Edit", {"file_path": "/a/b.ts"}), ["/a/b.ts"])
        self.assertEqual(g.files_of("apply_patch", {"input": "*** Begin Patch\n*** Update File: x/y.py\n@@\n*** Add File: z.md\n*** End Patch"}), ["x/y.py", "z.md"])
        self.assertEqual(g.files_of("Bash", {"command": "ls"}), [])


class EditingReport(unittest.TestCase):
    """`dispatch editing`: per-file aggregation of who changed what, conflicts included."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._orig = dispatch.EDITS_DIR
        dispatch.EDITS_DIR = os.path.join(self.tmp, "edits")
        os.makedirs(dispatch.EDITS_DIR)
        self._real_map = dispatch.session_edit_map

    def tearDown(self):
        dispatch.EDITS_DIR = self._orig

    def record(self, sid, agent, path, ts=None, name=None):
        with open(os.path.join(dispatch.EDITS_DIR, (name or sid) + ".json"), "w") as f:
            json.dump({"file": path, "agent": agent, "session_id": sid, "ts": time.time() if ts is None else ts, "host": "h"}, f)

    def report(self, dir=None, window=30):
        from types import SimpleNamespace
        a = SimpleNamespace(dir=dir, window=window, json=True)
        buf = io.StringIO()
        # Isolate from the real ~/tasks transcripts; the registry is what we are testing.
        with patch.object(dispatch, "session_cwd_map", lambda: {}), \
                patch.object(dispatch, "session_edit_map", lambda w=1800, with_activity=True: self._real_map(w, with_activity=False)):
            with contextlib.redirect_stdout(buf):
                dispatch.cmd_editing(a)
        return json.loads(buf.getvalue())

    def test_two_sessions_on_different_files_are_not_a_conflict(self):
        now = time.time()
        self.record("s1", "pi", "/p/a.py", ts=now)
        self.record("s2", "claude-code", "/p/b.tsx", ts=now - 10)
        r = self.report()
        self.assertEqual([f["file"] for f in r["files"]], ["/p/a.py", "/p/b.tsx"])
        self.assertFalse(any(f["conflict"] for f in r["files"]))
        self.assertEqual(len(r["sessions"]), 2)

    def test_same_file_from_two_sessions_is_flagged_and_sorted_first(self):
        self.record("s1", "pi", "/p/a.py", name="a1")
        self.record("s2", "claude-code", "/p/a.py", name="a2")
        self.record("s3", "pi", "/p/b.py", name="b1")
        r = self.report()
        self.assertEqual(r["files"][0]["file"], "/p/a.py")
        self.assertTrue(r["files"][0]["conflict"])
        self.assertEqual(len(r["files"][0]["editors"]), 2)
        self.assertFalse(r["files"][1]["conflict"])

    def test_stale_records_and_other_directories_are_dropped(self):
        self.record("s1", "pi", "/p/here/a.py")
        self.record("s2", "pi", "/other/b.py")
        self.record("s3", "pi", "/p/old.py", ts=time.time() - 3600, name="old")
        r = self.report(dir="/p")
        self.assertEqual([f["file"] for f in r["files"]], ["/p/here/a.py"])


class FrontmatterMultiline(unittest.TestCase):
    def test_folded_and_indented_descriptions(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "SKILL.md"), "w").write("---\nname: x\ndescription: >\n  first line\n  second line\nlicense: MIT\n---\nbody")
            self.assertEqual(dispatch.read_frontmatter(d)["description"], "first line second line")
            open(os.path.join(d, "SKILL.md"), "w").write("---\nname: y\ndescription:\n  只有缩进的一行\n---\n")
            self.assertEqual(dispatch.read_frontmatter(d)["description"], "只有缩进的一行")


class PeerReview(unittest.TestCase):
    def run_review(self, verdict="pass", actor="codex", assignee="claude-code", status="closed", labels=None):
        from types import SimpleNamespace
        from unittest.mock import patch
        issue = {"status": status, "assignee": assignee, "labels": labels or []}
        with patch.dict(os.environ, {"BEADS_ACTOR": actor}), patch.object(dispatch, "bd_json", return_value=issue) as bd, patch.object(dispatch, "sh", return_value=(0, "", "")) as shell:
            dispatch.cmd_review(SimpleNamespace(task="task-test", verdict=verdict, reason="tests passed"))
            return bd.call_args_list, shell.call_args_list
    def test_independent_review_records_author_and_evidence(self):
        bd, shell = self.run_review()
        self.assertIn("reviewed", bd[-1].args[0])
        self.assertIn("codex", shell[0].args[0][-1])
        self.assertIn("tests passed", shell[0].args[0][-1])
    def test_self_review_is_rejected(self):
        with self.assertRaises(SystemExit): self.run_review(actor="claude-code")
    def test_incomplete_task_cannot_pass(self):
        with self.assertRaises(SystemExit): self.run_review(status="open")
    def test_designated_reviewer_is_respected(self):
        with self.assertRaises(SystemExit): self.run_review(labels=["reviewer:pi"])
    def test_changes_reopen_task(self):
        bd, _ = self.run_review(verdict="changes")
        self.assertIn("open", bd[-1].args[0])
        self.assertIn("review-changes", bd[-1].args[0])
    def test_comment_failure_does_not_mark_reviewed(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        with patch.dict(os.environ, {"BEADS_ACTOR": "codex"}), patch.object(dispatch, "bd_json", return_value={"status": "closed", "assignee": "claude-code"}) as bd, patch.object(dispatch, "sh", return_value=(1, "", "write failed")):
            with self.assertRaises(SystemExit): dispatch.cmd_review(SimpleNamespace(task="task-test", verdict="pass", reason="checks"))
            self.assertEqual(bd.call_count, 1)


class CompletionReviewRequest(unittest.TestCase):
    def test_completion_does_not_require_review(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        with patch.object(dispatch, "bd_json", return_value={"labels": []}) as bd, patch.object(dispatch, "out"):
            dispatch.cmd_done(SimpleNamespace(task="task-test", reason="done", verified=True, review_by=None, next=[], retro=None, json=False))
            self.assertFalse(any("review-requested" in c.args[0] for c in bd.call_args_list))
    def test_explicit_request_keeps_completion_and_names_reviewer(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        with patch.object(dispatch, "bd_json", return_value={"labels": []}) as bd, patch.object(dispatch, "out"):
            dispatch.cmd_done(SimpleNamespace(task="task-test", reason="done", verified=True, review_by="pi", next=[], retro=None, json=False))
            ops = [c.args[0][0] for c in bd.call_args_list]
            self.assertIn("close", ops)  # --verified first reads the task to sign its acceptance items
            self.assertTrue(any("reviewer:pi" in c.args[0] for c in bd.call_args_list))

    def test_verified_done_signs_open_acceptance_items(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        issue = {"id": "task-test", "labels": [], "acceptance_criteria": "- [ ] a\n- [x] b\n- [ ] c"}
        with patch.object(dispatch, "bd_json", return_value=issue) as bd, patch.object(dispatch, "out"), patch.dict(dispatch.os.environ, {"BEADS_ACTOR": "pi"}):
            dispatch.cmd_done(SimpleNamespace(task="task-test", reason="done", verified=True, review_by=None, next=[], retro=None, json=False))
            upd = next(c.args[0] for c in bd.call_args_list if c.args[0][0] == "update" and "--acceptance" in c.args[0])
            self.assertEqual(upd[upd.index("--acceptance") + 1], "- [x] a @pi\n- [x] b\n- [x] c @pi")

class BeginSessionLink(unittest.TestCase):
    def test_records_explicit_session_for_delivery(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        a = SimpleNamespace(title='test', project='kanban', type='task', priority=2, desc=None, acceptance=None, deps=None, json=True, session='session-123456', force=True)
        with patch.object(dispatch, 'begin_warnings', return_value=[]), patch.object(dispatch, 'local_host_name', return_value='test'), patch.object(dispatch, 'out'), patch.object(dispatch, 'bd_json', side_effect=[{'id':'task-test'},{}]) as bd:
            dispatch.cmd_begin(a)
        self.assertIn('session:session-123456', bd.call_args_list[0].args[0][bd.call_args_list[0].args[0].index('-l')+1])
        self.assertIn('session-origin:session-123456', bd.call_args_list[0].args[0][bd.call_args_list[0].args[0].index('-l')+1])

    def test_invalid_session_cannot_inject_labels(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        a = SimpleNamespace(title='test', project='kanban', type='task', priority=2, desc=None, acceptance=None, deps=None, json=True, session='bad,reviewed', force=True)
        with patch.object(dispatch, 'begin_warnings', return_value=[]), patch.object(dispatch, 'local_host_name', return_value='test'), patch.object(dispatch, 'out'), patch.object(dispatch, 'bd_json', side_effect=[{'id':'task-test'},{}]) as bd:
            dispatch.cmd_begin(a)
        self.assertEqual(bd.call_args_list[0].args[0][bd.call_args_list[0].args[0].index('-l')+1], 'project:kanban,host:test')

class BeginTitleRule(unittest.TestCase):
    def test_long_title_is_cut_at_a_boundary_and_kept_whole_in_the_description(self):
        full = "Dispatch：复审并重构两个 DeepSeek agent 的交付（dispatch here/lineage/profile/memories）并装机点过"
        title, cut = dispatch.trim_title(full)
        self.assertTrue(cut)
        self.assertEqual(title, "Dispatch：复审并重构两个 DeepSeek agent 的交付")   # not "…的交付（disp"
        self.assertLessEqual(len(title), dispatch.TITLE_MAX)
        self.assertEqual(dispatch.trim_title("短标题"), ("短标题", False))
        self.assertEqual(dispatch.trim_title("无标点" * 20)[0], "无标点" * 13 + "无")   # nothing to break on: plain cut
        from types import SimpleNamespace
        from unittest.mock import patch
        a = SimpleNamespace(title=full, desc="用户要求复审。", type="task", priority=2, project="kanban", json=False, force=False, session=None, acceptance=None, deps=None)
        with patch.object(dispatch, "begin_warnings", return_value=[]), patch.object(dispatch, "local_host_name", return_value="t"), patch.object(dispatch, "out"), \
             patch.object(dispatch, "bd_json", side_effect=[{"id": "task-x"}, {}]) as bd, contextlib.redirect_stderr(io.StringIO()):
            dispatch.cmd_begin(a)
        argv = bd.call_args_list[0].args[0]
        self.assertEqual(argv[1], "Dispatch：复审并重构两个 DeepSeek agent 的交付")
        self.assertTrue(argv[argv.index("--description") + 1].startswith(f"原标题：{full}\n\n用户要求复审。"))

    def test_vague_title_or_thin_description_is_refused(self):
        self.assertTrue(dispatch.title_problems("修复", ""))
        self.assertTrue(dispatch.title_problems("会话页 diff 改成可横向滚动：手机上右半截被截掉", "短"))
        self.assertEqual(dispatch.title_problems("会话页 diff 改成可横向滚动：手机上右半截被截掉", "用户在手机上看任务页的 diff 时只能看到左半截，期望长行能横向滚动或换行"), [])

    def test_begin_exits_without_creating_when_refused(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        a = SimpleNamespace(title='修复', project='kanban', type='task', priority=2, desc=None, acceptance=None, deps=None, json=True, session=None, force=False)
        with patch.object(dispatch, 'bd_json') as bd, self.assertRaises(SystemExit):
            dispatch.cmd_begin(a)
        bd.assert_not_called()

class ServeSymlink(unittest.TestCase):
    def test_resolves_sibling_server_from_real_cli_path(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root,'cli')); os.makedirs(os.path.join(root,'bin'))
            real=os.path.join(root,'cli','dispatch.py'); link=os.path.join(root,'bin','dispatch')
            with open(real,'w') as f: f.write('')
            os.symlink(real,link)
            with patch.object(dispatch,'__file__',link), patch.object(sys,'argv',['dispatch']), patch('runpy.run_path') as run:
                dispatch.cmd_serve(SimpleNamespace(what='url'))
            run.assert_called_once_with(os.path.realpath(os.path.join(root,'cli','serve.py')),run_name='__main__')

    def test_qr_passes_the_svg_flag(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        with patch.object(sys,'argv',['dispatch']), patch('runpy.run_path'):
            dispatch.cmd_serve(SimpleNamespace(what='qr', svg=True))
            self.assertEqual(sys.argv, ['serve','qr','--svg'])

    def test_host_passes_target_and_json(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        with patch.object(sys,'argv',['dispatch']), patch('runpy.run_path'):
            dispatch.cmd_serve(SimpleNamespace(what='host', target='living-room-mini', json=True))
            self.assertEqual(sys.argv, ['serve','host','living-room-mini','--json'])
            dispatch.cmd_serve(SimpleNamespace(what='host', target=None, json=False))
            self.assertEqual(sys.argv, ['serve','host'])

    def test_qr_without_svg_prints_terminal_blocks(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        with patch.object(sys,'argv',['dispatch']), patch('runpy.run_path'):
            dispatch.cmd_serve(SimpleNamespace(what='qr', svg=False))
            self.assertEqual(sys.argv, ['serve','qr'])


class FactsSections(unittest.TestCase):
    DOC = "# 常用信息\n\n> 说明\n\n## 通用\n\n- 机器 A\n\n## readerapp（ReLecture · 重讲）\n\n- 域名 readerapp.app\n\n## ReadAloud\n\n- 手机阅读\n\n## 空节\n"

    def test_key_is_first_word_lowercased(self):
        self.assertEqual(dispatch.facts_key("readerapp（ReLecture · 重讲）"), "readerapp")
        self.assertEqual(dispatch.facts_key("ReadAloud"), "readaloud")
        self.assertEqual(dispatch.facts_key("通用"), "通用")

    def test_project_gets_general_plus_its_own_section_only(self):
        picked = dispatch.facts_for("Readerapp", self.DOC)
        self.assertEqual([h for h, _ in picked], ["通用", "readerapp（ReLecture · 重讲）"])
        self.assertIn("readerapp.app", picked[1][1])

    def test_no_project_gets_general_only_and_empty_sections_are_dropped(self):
        self.assertEqual([h for h, _ in dispatch.facts_for("", self.DOC)], ["通用"])
        self.assertEqual([h for h, _ in dispatch.facts_for("空节", self.DOC)], ["通用"])

    PROJECT_DOC = "# HIWI 常用信息\n\n## 服务器\n\n**Netways Managed AI**\n- 入口 https://ai.netways.example\n- 首次登录用「Passwort vergessen」\n\n## 联系人\n\n**学院 IT**\n- Rudroff\n"

    def test_project_file_sections_come_after_the_general_ones(self):
        picked = dispatch.facts_for("hiwi", self.DOC, self.PROJECT_DOC)
        self.assertEqual([h for h, _ in picked], ["通用", "服务器", "联系人"])
        hits = dispatch.facts_get("netways", "hiwi", self.DOC, self.PROJECT_DOC)
        self.assertEqual([(h, t) for h, t, _ in hits], [("服务器", "Netways Managed AI")])
        self.assertIn("Passwort vergessen", hits[0][2])
        # another project never sees it; giving only the global text reads no project file
        self.assertEqual([h for h, _ in dispatch.facts_for("readerapp", self.DOC, self.PROJECT_DOC)], ["通用", "readerapp（ReLecture · 重讲）", "服务器", "联系人"][:2] + ["服务器", "联系人"])
        self.assertEqual([h for h, _ in dispatch.facts_for("hiwi", self.DOC)], ["通用"])

    def test_project_facts_path_follows_project_home(self):
        with patch.object(dispatch, "project_home", return_value="/tmp/proj"):
            self.assertEqual(dispatch.facts_project_path("hiwi"), "/tmp/proj/FACTS.md")
        with patch.object(dispatch, "project_home", return_value=""):
            self.assertEqual(dispatch.facts_project_path("ghost"), "")
        self.assertEqual(dispatch.facts_project_path(""), "")


class ProjectFlags(unittest.TestCase):
    def test_parse_keeps_only_true_known_fields(self):
        raw = json.dumps({"a": {"starred": True, "archived": False, "x": 1}, "b": {"archived": True}, "c": {"starred": False}, "d": "bad"})
        self.assertEqual(dispatch.project_flags_parse(raw), {"a": {"starred": True}, "b": {"archived": True}})
        self.assertEqual(dispatch.project_flags_parse(""), {})
        self.assertEqual(dispatch.project_flags_parse("not json"), {})

    def test_apply_merges_and_drops_empty(self):
        flags = dispatch.project_flags_apply({}, "ReadAloud", {"starred": True})
        flags = dispatch.project_flags_apply(flags, "ReadAloud", {"archived": True})
        self.assertEqual(flags, {"ReadAloud": {"starred": True, "archived": True}})
        flags = dispatch.project_flags_apply(flags, "ReadAloud", {"starred": False, "archived": False})
        self.assertEqual(flags, {})

    def test_apply_rejects_bad_input(self):
        with self.assertRaises(ValueError): dispatch.project_flags_apply({}, "", {"starred": True})
        with self.assertRaises(ValueError): dispatch.project_flags_apply({}, "x", {"pinned": True})
        with self.assertRaises(ValueError): dispatch.project_flags_apply({}, "x", {"starred": "yes"})

    def test_internal_memory_hidden_from_wiki(self):
        with patch.object(dispatch, "sh", return_value=(0, json.dumps({"schema_version": 1, "pit-a": "【坑】x", "dispatch-projects": "{}"}), "")):
            self.assertEqual([it["key"] for it in dispatch.wiki_all()], ["pit-a"])


class PaneChrome(unittest.TestCase):
    RULE = "─" * 80
    CLAUDE = ("\n❯ 只回复两个字：收到。不要调用任何工具。\n\n⏺ 收到。\n\n✻ Brewed for 2s · done 7:07 PM\n"
              + "\n" * 6
              + f"{RULE}\n❯\n{RULE}\n"
              + "  [Fable 5.1] │ tmp" + " " * 60 + "/rc\n"
              + "  Context ░░░░░░░░░░ 4% │ Usage ██░░░░░░░░ 22% (resets in 2h 13m)\n"
              + "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent\n")
    PI = ("\n[Context]\n  ~/.pi/agent/AGENTS.md\n\n 只回复两个字：收到。不要调用任何工具。\n\n"
          + " The user asked me to reply with exactly two characters: 收到. No tool calls needed.\n\n 收到\n\n"
          + f"{RULE}\n\n{RULE}\n/private/tmp\n"
          + "↑4.9k ↓22 $0.000 0.5%/1.0M (auto)" + " " * 60 + "(zai-coding-cn) glm-5.3-flash • high\n")

    def test_keeps_the_reply_and_drops_the_tail_status_bar(self):
        claude = dispatch.strip_pane_chrome(self.CLAUDE)
        self.assertEqual(claude.splitlines()[-1], "⏺ 收到。")
        self.assertNotIn("bypass permissions", claude)
        self.assertNotIn("Context", claude)
        pi = dispatch.strip_pane_chrome(self.PI)
        self.assertEqual(pi.splitlines()[-1], " 收到")
        self.assertNotIn("1.0M (auto)", pi)
        self.assertIn("No tool calls needed", pi)

    def test_a_reply_without_chrome_is_untouched(self):
        self.assertEqual(dispatch.strip_pane_chrome("⏺ 好了。"), "⏺ 好了。")
        self.assertEqual(dispatch.strip_pane_chrome(""), "")
        # a markdown rule inside the reply is short, not the full-width TUI separator
        self.assertEqual(dispatch.strip_pane_chrome("方案：\n---\n照做"), "方案：\n---\n照做")

    def test_only_the_new_text_since_the_startup_screen(self):
        before = "pi v0.85.1\n[Context]\n  ~/.pi/agent/AGENTS.md"
        after = before + "\n\n 只回复两个字：收到。\n\n 收到"
        self.assertEqual(dispatch.new_pane_text(before, after), " 只回复两个字：收到。\n\n 收到")
        self.assertEqual(dispatch.new_pane_text("", after), after)

    def test_echoed_prompt_is_dropped_from_the_answer(self):
        self.assertEqual(dispatch.drop_echoed_prompt("❯ 只回复：收到\n\n⏺ 收到。", "只回复：收到"), "⏺ 收到。")
        self.assertEqual(dispatch.drop_echoed_prompt("⏺ 收到。", "只回复：收到"), "⏺ 收到。")
        self.assertEqual(dispatch.drop_echoed_prompt("", "x"), "")

    def test_settle_read_polls_until_the_text_stops_changing(self):
        reads = iter(["a", "a", "b", "b"])
        with patch.object(dispatch, "herdr", side_effect=lambda *a, **k: next(reads)), patch.object(dispatch.time, "sleep"):
            self.assertEqual(dispatch.read_pane(None, "w1:p1", 40, settle=True, cap=30), "a")
        reads = iter(["a", "b", "c", "c"])
        with patch.object(dispatch, "herdr", side_effect=lambda *a, **k: next(reads)), patch.object(dispatch.time, "sleep"):
            self.assertEqual(dispatch.read_pane(None, "w1:p1", 40, settle=True, cap=30), "c")


class HumanNote(unittest.TestCase):
    def test_only_the_users_latest_unanswered_note_is_injected(self):
        user = {"author": "alice", "text": "请补一下  手机截图", "created_at": "2"}
        agent = {"author": "claude-code", "text": "好的", "created_at": "3"}
        self.assertEqual(dispatch.human_note([agent, user], "claude-code"), "请补一下 手机截图")
        self.assertEqual(dispatch.human_note([user, agent], "claude-code"), "")
        self.assertEqual(dispatch.human_note([{"author": "codex", "text": "x", "created_at": "1"}], "claude-code"), "")
        self.assertEqual(dispatch.human_note([], "claude-code"), "")


class ReconcileWithTranscripts(unittest.TestCase):
    def test_hook_stuck_on_working_yields_to_a_finished_transcript(self):
        rows = [dict(session_id='a', registered=True, state='working', state_source='hook', last_at=1000.0),
                dict(session_id='b', registered=True, state='working', state_source='hook', last_at=1000.0),
                dict(session_id='c', registered=True, state='working', state_source='hook', last_at=1000.0),
                dict(session_id='d', registered=True, state='idle', state_source='hook', last_at=1000.0)]
        states = {'a': ('idle', 990.0), 'b': ('working', 2000.0), 'c': ('idle', 500.0)}
        with patch('activity.transcript_states', return_value=states):
            dispatch.reconcile_with_transcripts(rows)
        # a: transcript finished around the same time the hook last spoke → idle.
        self.assertEqual((rows[0]['state'], rows[0]['attention'], rows[0]['state_source']), ('idle', None, 'transcript'))
        # b: still working; c: transcript far older than the hook's last word (a long tool call) → unchanged.
        self.assertEqual([r['state'] for r in rows[1:]], ['working', 'working', 'idle'])


class SessionLifecycle(unittest.TestCase):
    def test_settings_parse_keeps_known_numeric_keys(self):
        self.assertEqual(dispatch.settings_parse(json.dumps({"session_archive_days": 45, "x": 1, "bad": "no"})), {"session_archive_days": 45})
        self.assertEqual(dispatch.settings_parse("nope"), {})

    def test_starred_sessions_of_project(self):
        idx = {"/a": {"agent": "claude-code", "session_id": "aaaa1111", "cwd": "/Users/x/Projects/kanban/app", "title": "长线", "mtime": 5},
               "/b": {"agent": "codex", "session_id": "bbbb2222", "cwd": "/Users/x/Projects/other", "title": "别的", "mtime": 9},
               "/c": {"agent": "codex", "session_id": "cccc3333", "cwd": "/Users/x/Projects/kanban", "title": "归档了", "mtime": 9}}
        prefs = {"claude-code:aaaa1111": {"starred": True}, "codex:bbbb2222": {"starred": True}, "codex:cccc3333": {"starred": True, "archived": True}}
        rows = dispatch.starred_sessions(prefs, idx, "kanban", {"kanban": "kanban"})
        self.assertEqual([r["session_id"] for r in rows], ["aaaa1111"])
        self.assertEqual([r["session_id"] for r in dispatch.starred_sessions(prefs, idx, "", {})], ["bbbb2222", "aaaa1111"])


class TaskArchive(unittest.TestCase):
    NOW = 1_800_000_000.0
    DAY = 86_400.0

    def _iso(self, days_ago):
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.NOW - days_ago * self.DAY))

    def _issue(self, tid, days_ago, status="closed", labels=None, field="closed_at"):
        it = {"id": tid, "status": status, "labels": labels or [], "updated_at": self._iso(days_ago)}
        if field:
            it[field] = self._iso(days_ago)
        return it

    def test_only_old_closed_tasks_without_skip_labels(self):
        issues = [
            self._issue("old", 40),
            self._issue("fresh", 5),
            self._issue("done-label", 40, labels=["dispatch:archived"]),
            self._issue("trashed", 40, labels=["dispatch:trashed"]),
            self._issue("outcome", 40, labels=["dispatch:outcome"]),
            self._issue("open", 40, status="open"),
            self._issue("no-closed-at", 40, field=None),
        ]
        self.assertEqual(dispatch.task_archive_candidates(issues, 30, now=self.NOW), ["old", "no-closed-at"])
        self.assertEqual(dispatch.task_archive_candidates(issues, 0, now=self.NOW), [])
        self.assertEqual(dispatch.task_archive_candidates(issues, 60, now=self.NOW), [])

    def test_settings_parse_keeps_task_archive_days(self):
        self.assertEqual(dispatch.settings_parse(json.dumps({"task_archive_days": 14})), {"task_archive_days": 14})
        self.assertEqual(dispatch.settings_parse(json.dumps({"task_archive_days": -1})), {})

    def test_command_labels_every_candidate_and_reports_the_count(self):
        issues = [
            {"id": "t1", "status": "closed", "labels": [], "closed_at": "2020-01-01T00:00:00Z", "updated_at": "2020-01-01T00:00:00Z"},
            {"id": "t2", "status": "closed", "labels": ["dispatch:archived"], "closed_at": "2020-01-01T00:00:00Z", "updated_at": "2020-01-01T00:00:00Z"},
        ]
        calls = []

        def fake_sh(args, timeout=20, env=None):
            calls.append(list(args))
            return (0, json.dumps(issues), "") if args[:3] == ["bd", "list", "--all"] else (0, "{}", "")

        buf = io.StringIO()
        with patch.object(dispatch, "sh", side_effect=fake_sh), contextlib.redirect_stdout(buf):
            dispatch.cmd_task_archive(types.SimpleNamespace(days=30, json=True))
        self.assertEqual(json.loads(buf.getvalue()), {"days": 30, "archived": ["t1"], "count": 1})
        self.assertIn(["bd", "update", "t1", "--add-label", "dispatch:archived", "--json"], calls)
        self.assertFalse(any("t2" in c for c in calls))

    def test_command_is_a_noop_when_the_setting_is_off(self):
        buf = io.StringIO()
        with patch.object(dispatch, "sh", side_effect=AssertionError("should not touch bd")), patch.object(dispatch, "settings_load", return_value={}), contextlib.redirect_stdout(buf):
            dispatch.cmd_task_archive(types.SimpleNamespace(days=None, json=True))
        self.assertEqual(json.loads(buf.getvalue()), {"days": 0, "archived": [], "count": 0})


class Facts(unittest.TestCase):
    TEXT = "# x\n\n## 通用\n\n**机器**\n- 本机 MacBook，Tailscale 100.64.0.1\n- mini 100.64.0.2\n\n**我常说的话**\n- 密钥只进 dispatch env\n\n## kanban\n- 板在 ~/tasks/.beads\n"

    def test_topics_and_get(self):
        secs = dict(dispatch.facts_sections(self.TEXT))
        self.assertEqual([t for t, _ in dispatch.facts_topics(secs["通用"])], ["机器", "我常说的话"])
        hits = dispatch.facts_get("机器", "", self.TEXT)
        self.assertEqual([(h, t) for h, t, _ in hits], [("通用", "机器")])
        self.assertIn("100.64.0.1", hits[0][2])
        self.assertEqual(dispatch.facts_get("常说", "kanban", self.TEXT)[0][1], "我常说的话")
        self.assertEqual(dispatch.facts_get("nothing", "", self.TEXT), [])

    def test_search_carries_topic(self):
        rows = dispatch.facts_search("mini 100", [("通用", self.TEXT)])
        self.assertEqual(rows, [("通用", "机器", "- mini 100.64.0.2")])

    def test_import_candidates_skip_known_and_irrelevant(self):
        src = [("/m/a.md", "---\nname: x\n---\n\n本机 MacBook，Tailscale 100.64.0.1 就是这台\n\n今天天气不错，写了很多代码，非常开心的一天。\n\nHetzner 别名 hetzner，root@203.0.113.7，裸 IP 会 Permission denied\n"), ("/m/b.md", "Hetzner 别名 hetzner，root@203.0.113.7，裸 IP 会 Permission denied")]
        cands = dispatch.facts_candidates(src, self.TEXT)
        self.assertEqual([p for p, _ in cands], ["/m/a.md", "/m/a.md"])
        self.assertTrue(any("Hetzner" in c for _, c in cands))
        self.assertFalse(any("天气" in c for _, c in cands))


class DynamicWorkflow(unittest.TestCase):
    def test_split_spec(self):
        self.assertEqual(dispatch.split_spec('codex:写测试|覆盖 diff'), ("codex", "写测试", "覆盖 diff"))
        self.assertEqual(dispatch.split_spec('claude:只有标题'), ("claude", "只有标题", ""))
        with self.assertRaises(ValueError): dispatch.split_spec("没有冒号")
        with self.assertRaises(ValueError): dispatch.split_spec("codex:")

    def test_discussion_filter_and_prompts(self):
        cs = [{"text": "普通进展"}, {"text": " 【讨论】codex：拆成两块"}]
        self.assertEqual(dispatch.discussion_of(cs), [cs[1]])
        p1 = dispatch.discuss_prompt("task-1", "标题", 1, "先做哪个")
        self.assertIn("bd show task-1", p1); self.assertIn("先做哪个", p1); self.assertIn("不改代码", p1)
        self.assertIn("第 2 轮", dispatch.discuss_prompt("task-1", "标题", 2))

    def test_discussion_judge(self):
        """The cheap referee: from the second round on, only who was @'d or named-and-questioned
        speaks; a person's line that names nobody, or @大家, calls everyone."""
        T = dispatch.DISCUSS_TAG
        parts = [("claude", "opus"), ("codex", ""), ("pi", "")]
        judge = lambda *cs: dispatch.discussion_judge(list(cs), parts)
        me = lambda t: {"author": "alice", "text": T + "alice：" + t}
        # @kind / @kind（model） / @model / @actor
        self.assertEqual(judge(me("@codex 你说的冷启动怎么量化？"))["picked"], [1])
        self.assertEqual(judge(me("@claude（opus） 先说"))["picked"], [0])
        self.assertEqual(judge(me("@claude:opus 先说"))["picked"], [0])
        self.assertEqual(judge(me("@opus 先说"))["picked"], [0])
        self.assertEqual(judge(me("@claude-code 呢"))["picked"], [0])
        self.assertEqual(judge(me("@pi @codex 你们俩"))["picked"], [2, 1])
        r = judge(me("@codex 你说"))
        self.assertFalse(r["everyone"]); self.assertIn("被 alice @", r["why"]); self.assertIn("codex", r["why"])
        # a person talking to the group, or @大家 → everyone
        for t in ("大家觉得呢", "@大家 觉得呢", "@all 看看", "@codex 你说，@各位 也看看"):
            self.assertTrue(judge(me(t))["everyone"], t)
        # a member named-and-questioned by someone else → it answers; the CLI just being mentioned does not count
        pi = lambda t: {"author": "pi", "text": T + "pi：" + t}
        r = judge(pi("我不同意 codex 说的并行不是关键。用 claude -p 直调就行。"))
        self.assertEqual(r["picked"], [1]); self.assertIn("被 pi 质疑", r["why"])
        self.assertTrue(judge(pi("用 claude -p 直调就行，codex exec 也一样。"))["everyone"])
        self.assertTrue(judge(pi("我自己 pi 的方案有问题？"))["everyone"])   # naming yourself is not a challenge
        # both sources add up; a member's statement alone never calls everyone unless nobody was named
        r = judge({"author": "codex", "text": T + "codex：pi 的方案把冷启动成本低估了"}, me("@claude 你怎么看"))
        self.assertEqual(sorted(r["picked"]), [0, 2])
        # the opener line: only the question after 邀请 … ： counts
        self.assertEqual(judge({"author": "alice", "text": T + "发起：alice 邀请 claude, codex, pi 讨论：@pi 先说"})["picked"], [2])
        self.assertTrue(judge({"author": "alice", "text": T + "发起：alice 邀请 claude, codex, pi 讨论"})["everyone"])
        self.assertTrue(judge()["everyone"])
        self.assertEqual(dispatch.member_names("claude", "opus"), {"claude", "claude-code", "opus", "claude（opus）", "claude(opus)", "claude:opus"})


class StatsMerge(unittest.TestCase):
    """`dispatch stats` adds the other Macs' day buckets and hour grid instead of replacing them."""

    @staticmethod
    def _day(date, msgs, tokens, by):
        return {"date": date, "msgs": msgs, "tokens": tokens, "in": tokens, "out": 0, "cr": 0, "cw": 0, "by": by}

    @staticmethod
    def _agent(name, sessions, msgs, tokens, days):
        return {"agent": name, "sessions": sessions, "msgs": msgs, "tokens": {"in": tokens, "out": 0, "cr": 0, "cw": 0, "think": 0}, "total": tokens, "days": days}

    @staticmethod
    def _stats(days, hours, agents, tools=(), projects=(), sub=0, ts=1, range_days=0):
        return {
            "range_days": range_days, "agent": "",
            "total": {"tokens": {"in": 0, "out": 0, "cr": 0, "cw": 0, "think": 0}, "total": 0, "sub_tokens": sub,
                      "msgs": 0, "sessions": 0, "active_days": 0, "streak_cur": 0, "streak_max": 0,
                      "tools_distinct": 0, "active_hours": 0, "first_day": "", "last_day": ""},
            "agents": list(agents), "days": list(days), "hours": hours,
            "models": [], "tools": list(tools), "skills": [], "subagents": [],
            "projects": list(projects), "generated_at": ts,
        }

    def setUp(self):
        grid = [[0] * 24 for _ in range(7)]
        grid[0][9] = 2
        self.base = self._stats(
            [self._day("2026-09-08", 2, 100, {"claude-code": 100})], grid,
            [self._agent("claude-code", 1, 2, 100, 1)],
            tools=[{"name": "Bash", "count": 2, "by": {"claude-code": 2}}],
            projects=[{"name": "kanban", "cwd": "/k", "tokens": 100, "msgs": 2, "sessions": 1, "by": {"claude-code": 100}}],
            sub=10, ts=100)
        grid2 = [[0] * 24 for _ in range(7)]
        grid2[0][9] = 1
        grid2[3][14] = 5
        self.extra = self._stats(
            [self._day("2026-09-08", 3, 200, {"pi": 200}), self._day("2026-09-07", 1, 50, {"pi": 50})], grid2,
            [self._agent("pi", 2, 4, 250, 2)],
            tools=[{"name": "Bash", "count": 3, "by": {"pi": 3}}, {"name": "Read", "count": 1, "by": {"pi": 1}}],
            projects=[{"name": "kanban", "cwd": "/k", "tokens": 200, "msgs": 3, "sessions": 1, "by": {"pi": 200}}],
            sub=5, ts=200)

    def test_none_is_ignored(self):
        self.assertIs(dispatch.merge_stats(self.base, None), self.base)

    def test_days_and_hours_are_summed(self):
        m = dispatch.merge_stats(self.base, self.extra)
        self.assertEqual([d["date"] for d in m["days"]], ["2026-09-07", "2026-09-08"])
        d = m["days"][1]
        self.assertEqual((d["msgs"], d["tokens"]), (5, 300))
        self.assertEqual(d["by"], {"claude-code": 100, "pi": 200})
        self.assertEqual(m["hours"][0][9], 3)
        self.assertEqual(m["hours"][3][14], 5)

    def test_totals_are_recomputed_not_added_twice(self):
        m = dispatch.merge_stats(self.base, self.extra)
        t = m["total"]
        self.assertEqual(t["total"], 350)
        self.assertEqual(t["msgs"], 6)
        self.assertEqual(t["sessions"], 3)
        self.assertEqual(t["sub_tokens"], 15)
        self.assertEqual(t["active_days"], 2)
        self.assertEqual(t["active_hours"], 2)
        self.assertEqual(t["tools_distinct"], 2)
        self.assertEqual((t["first_day"], t["last_day"]), ("2026-09-07", "2026-09-08"))
        self.assertEqual(t["streak_max"], 2)
        self.assertEqual(m["generated_at"], 200)

    def test_agents_and_ranks_merge_by_name(self):
        m = dispatch.merge_stats(self.base, self.extra)
        by = {A["agent"]: A for A in m["agents"]}
        self.assertEqual((by["claude-code"]["total"], by["claude-code"]["days"]), (100, 1))
        self.assertEqual((by["pi"]["total"], by["pi"]["days"]), (250, 2))
        self.assertEqual({x["name"]: x["count"] for x in m["tools"]}, {"Bash": 5, "Read": 1})
        self.assertEqual(m["tools"][0]["by"], {"claude-code": 2, "pi": 3})
        p = m["projects"][0]
        self.assertEqual((p["tokens"], p["msgs"], p["sessions"]), (300, 5, 2))

    def test_range_keeps_hour_grid_unknown(self):
        base = dict(self.base, range_days=7)
        extra = dict(self.extra, range_days=7)
        self.assertIsNone(dispatch.merge_stats(base, extra)["total"]["active_hours"])

    def test_cmd_stats_asks_remotes_for_local_only(self):
        idx = {"s": {"agent": "claude-code", "session_id": "s", "cwd": "/tmp/p", "subagent": False,
                     "days": {"2026-09-08": [1, 100, 100, 0, 0, 0]},
                     "tokens": {"in": 100, "out": 0, "cr": 0, "cw": 0, "think": 0}, "mtime": 4e9,
                     "hours": {"0-9": 1}, "models": {}, "tools": {}, "skills": {}, "subs": {},
                     "user_msgs": 1, "assistant_msgs": 0}}
        seen = {}

        def remote(host, args, ttl):
            seen["args"] = args
            return self.extra

        def run(local):
            buf = io.StringIO()
            a = types.SimpleNamespace(agent="", days=0, cached=True, json=True, local=local)
            with patch.object(dispatch, "load_index", return_value=idx), \
                 patch.object(dispatch, "hosts", return_value=[{"id": "mini", "name": "mini", "ssh": "x"}]), \
                 patch.object(dispatch, "remote_dispatch", side_effect=remote), \
                 contextlib.redirect_stdout(buf):
                dispatch.cmd_stats(a)
            return json.loads(buf.getvalue())

        merged = run(False)
        self.assertEqual(seen["args"], ["stats", "--cached", "--local", "--days", "0"])
        self.assertEqual(merged["hosts"], [dispatch.local_host_name(), "mini"])
        self.assertEqual(merged["hours"][0][9], 2)
        seen.clear()
        only = run(True)
        self.assertNotIn("hosts", only)
        self.assertEqual(seen, {})


class SkillStats(unittest.TestCase):
    """Codex reads a skill's SKILL.md with exec; ZCode has a Skill tool. Both must land in the index."""

    def test_codex_counts_skill_file_reads_only(self):
        lines = [
            # The system prompt lists every skill path — that is not a use.
            json.dumps({"timestamp": "2026-09-09T10:00:00Z", "type": "response_item", "payload": {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "- task-board: (file: r0/task-board/SKILL.md)\n- pdf: /Users/x/.agents/skills/pdf/SKILL.md"}]}}),
            json.dumps({"timestamp": "2026-09-09T10:00:01Z", "type": "response_item", "payload": {"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "sed -n '1,180p' /Users/x/.agents/skills/task-board/SKILL.md"})}}),
            json.dumps({"timestamp": "2026-09-09T10:00:02Z", "type": "response_item", "payload": {"type": "custom_tool_call", "name": "exec", "input": 'tools.exec_command({cmd:"cat /Users/x/.codex/plugins/cache/vendor/plugin/1.0/skills/pdf/SKILL.md"})'}}),
            # Tool output quoting the path back is not a second use.
            json.dumps({"timestamp": "2026-09-09T10:00:03Z", "type": "response_item", "payload": {"type": "function_call_output", "output": "read /Users/x/.agents/skills/other/SKILL.md"}}),
        ]
        e = dispatch.stats_fields()
        dispatch.parse_codex_stats(e, "\n".join(lines), dispatch.re.compile(r'"timestamp":"([^"]+)"'))
        self.assertEqual(e["skills"], {"task-board": 1, "pdf": 1})

    def test_zcode_counts_skill_tool_calls(self):
        def fake_query(sql, params=(), agent="zcode"):
            if "from part" in sql:
                return [{"sk": "video-to-notes"}, {"sk": "video-to-notes"}, {"sk": "getnote"}, {"sk": None}]
            return []
        e = dispatch.stats_fields()
        with patch.object(dispatch, "zcode_query", side_effect=fake_query):
            dispatch.parse_zcode_stats(e, "sess_1")
        self.assertEqual(e["skills"], {"video-to-notes": 2, "getnote": 1})


class SkillNames(unittest.TestCase):
    def test_keeps_cjk_and_dots(self):
        self.assertEqual(dispatch.safe_skill_name("Get笔记"), "Get笔记")
        self.assertEqual(dispatch.safe_skill_name("web-artifacts.builder"), "web-artifacts.builder")

    def test_rejects_paths_and_leading_dot(self):
        for bad in ("../evil", "a/b", ".hidden", "", "   ", "a b"):
            self.assertEqual(dispatch.safe_skill_name(bad), "", bad)

    def test_github_refs(self):
        self.assertEqual(dispatch.parse_github_ref("anthropics/skills"), ("anthropics", "skills", "", ""))
        self.assertEqual(dispatch.parse_github_ref("https://github.com/anthropics/skills/tree/main/skills/pdf"),
                         ("anthropics", "skills", "main", "skills/pdf"))
        self.assertEqual(dispatch.parse_github_ref("https://github.com/owner/repo.git"), ("owner", "repo", "", ""))
        self.assertEqual(dispatch.parse_github_ref("https://raw.githubusercontent.com/o/r/main/x/SKILL.md"),
                         ("o", "r", "main", "x"))
        self.assertIsNone(dispatch.parse_github_ref("not a repo"))


class SkillPoolBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dispatch-skill-test-")
        self.pool = os.path.join(self.tmp, "pool")
        self.dirs = {"claude": [os.path.join(self.tmp, "claude")], "codex": [os.path.join(self.tmp, "codex")]}
        for p in (patch.object(dispatch, "POOL", self.pool), patch.object(dispatch, "AGENT_SKILL_DIRS", self.dirs),
                  patch.object(dispatch, "cc_switch_flag", lambda *a: None)):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def call(self, **kw):
        a = types.SimpleNamespace(op=kw.pop("op"), json=True, **kw)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            dispatch.cmd_skills(a)
        return json.loads(buf.getvalue())


class SkillsNew(SkillPoolBase):
    def test_template_and_mount(self):
        res = self.call(op="new", name="demo-skill", description="用户要 demo 时用。", trigger=None,
                        constraint=None, agent=["claude"])
        md = open(os.path.join(res["path"], "SKILL.md"), encoding="utf-8").read()
        self.assertIn('name: demo-skill', md)
        self.assertIn('description: "用户要 demo 时用。"', md)
        self.assertIn("## 触发条件", md)
        self.assertIn("## 关键约束", md)
        self.assertTrue(os.path.islink(os.path.join(self.dirs["claude"][0], "demo-skill")))
        self.assertFalse(os.path.exists(os.path.join(self.dirs["codex"][0], "demo-skill")))

    def test_all_mounts_both_agents(self):
        res = self.call(op="new", name="both", description="", trigger=None, constraint=None, agent=["all"])
        self.assertEqual(sorted(res["agents"]), ["claude", "codex"])
        self.assertTrue(os.path.islink(os.path.join(self.dirs["codex"][0], "both")))

    def test_existing_name_refused(self):
        self.call(op="new", name="dup", description="", trigger=None, constraint=None, agent=[])
        with self.assertRaises(SystemExit):
            self.call(op="new", name="dup", description="", trigger=None, constraint=None, agent=[])


class SkillsImport(SkillPoolBase):
    def repo(self, *files):
        root = os.path.join(self.tmp, "repo")
        for rel, body in files:
            p = os.path.join(root, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "w", encoding="utf-8").write(body)
        return root

    def test_copies_skill_records_source_and_license(self):
        root = self.repo(("skills/thing/SKILL.md", "---\nname: thing\ndescription: d\n---\nbody\n"), ("LICENSE", "MIT"))
        with patch.object(dispatch, "download_repo", return_value=(root, "main", os.path.join(self.tmp, "dl"))):
            res = self.call(op="import", name="owner/repo", path="skills/thing", as_name="imported-thing",
                            force=False, agent=["codex"], description=None)
        md = open(os.path.join(res["path"], "SKILL.md"), encoding="utf-8").read()
        self.assertIn("source: https://github.com/owner/repo", md)
        self.assertIn("body", md)
        self.assertTrue(os.path.exists(os.path.join(res["path"], "LICENSE")))
        self.assertIn("LICENSE", open(os.path.join(res["path"], "SOURCE.md"), encoding="utf-8").read())
        self.assertTrue(os.path.islink(os.path.join(self.dirs["codex"][0], "imported-thing")))
        self.assertFalse(res["generated"])

    def test_repo_without_skill_gets_a_generated_entry(self):
        root = self.repo(("README.md", "hi"))
        with patch.object(dispatch, "download_repo", return_value=(root, "main", os.path.join(self.tmp, "dl"))):
            res = self.call(op="import", name="owner/tool", path="", as_name="tool", force=False,
                            agent=[], description=None)
        md = open(os.path.join(res["path"], "SKILL.md"), encoding="utf-8").read()
        self.assertTrue(res["generated"])
        self.assertIn("## 来源与提炼", md)
        self.assertIn("https://github.com/owner/tool", md)

    def test_multiple_skills_need_a_path(self):
        root = self.repo(("a/SKILL.md", "---\nname: a\n---\n"), ("b/SKILL.md", "---\nname: b\n---\n"))
        with patch.object(dispatch, "download_repo", return_value=(root, "main", os.path.join(self.tmp, "dl"))):
            with self.assertRaises(SystemExit):
                self.call(op="import", name="owner/repo", path="", as_name=None, force=False, agent=[], description=None)


def load_sibling(name):
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    return importlib.import_module(name)


class ReplySlashCommands(unittest.TestCase):
    """`dispatch reply commands`: built-ins first, then the skills and custom commands
    the agent sees from its working directory, deduplicated by name."""

    def test_claude_code_lists_builtins_project_skills_and_commands(self):
        session_reply = load_sibling("session_reply")
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as cwd:
            os.makedirs(os.path.join(cwd, ".claude", "skills", "deploy"))
            with open(os.path.join(cwd, ".claude", "skills", "deploy", "SKILL.md"), "w") as f:
                f.write("---\nname: deploy\ndescription: 发布到生产\n---\n")
            os.makedirs(os.path.join(home, ".claude", "skills", "compact"))  # shadowed by the built-in
            with open(os.path.join(home, ".claude", "skills", "compact", "SKILL.md"), "w") as f:
                f.write("---\ndescription: 不应出现\n---\n")
            os.makedirs(os.path.join(home, ".claude", "commands"))
            with open(os.path.join(home, ".claude", "commands", "save-session.md"), "w") as f:
                f.write("---\ndescription: 保存会话\n---\n")
            with open(os.path.join(home, ".claude", "commands", "notes.md"), "w") as f:
                f.write("# 记笔记\n正文\n")
            d = types.SimpleNamespace(HOME=home, AGENT_SKILL_DIRS={"claude": [os.path.join(home, ".claude", "skills")]}, read_frontmatter=dispatch.read_frontmatter)
            rows = session_reply.commands(d, {"agent": "claude-code", "cwd": cwd})
            names = [r["name"] for r in rows]
            self.assertEqual(names[0], "compact")
            self.assertEqual(names.count("compact"), 1)
            self.assertEqual(next(r for r in rows if r["name"] == "compact")["kind"], "builtin")
            self.assertIn({"name": "deploy", "description": "发布到生产", "kind": "skill"}, rows)
            self.assertIn({"name": "save-session", "description": "保存会话", "kind": "command"}, rows)
            self.assertIn({"name": "notes", "description": "记笔记", "kind": "command"}, rows)

    def test_pi_skills_use_the_skill_prefix_and_unknown_agents_get_nothing(self):
        session_reply = load_sibling("session_reply")
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, ".pi", "agent", "skills", "brain"))
            with open(os.path.join(home, ".pi", "agent", "skills", "brain", "SKILL.md"), "w") as f:
                f.write("---\ndescription: 知识库\n---\n")
            d = types.SimpleNamespace(HOME=home, AGENT_SKILL_DIRS={"claude": []}, read_frontmatter=dispatch.read_frontmatter)
            rows = session_reply.commands(d, {"agent": "pi", "cwd": "/nonexistent"})
            self.assertIn({"name": "skill:brain", "description": "知识库", "kind": "skill"}, rows)
            self.assertEqual(rows[0]["name"], "compact")
            self.assertEqual(session_reply.commands(d, {"agent": "zcode", "cwd": ""}), [])


class SummaryUses(unittest.TestCase):
    """One use table + one model picker: the gate, the settings round-trip and the CLI surface."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.ddir = os.path.join(self.tmp, "dispatch")
        os.makedirs(self.ddir, exist_ok=True)
        sys.path.insert(0, HERE)
        import summarize
        self.summarize = summarize
        self.sd = summarize.D          # the dispatch instance the summarize module calls into
        self._ddir = self.sd.DISPATCH_DIR
        self._env = (self.sd.ENV_DIR, self.sd.ENV_FILE, self.sd.ENV_FISH)
        self.sd.DISPATCH_DIR = self.ddir
        # The person switched the summaries on (first-run 「模型与总结」); out of the box they are off.
        self.ALL_ON = {"summary_auto": 1, "summary_uses": {k: 1 for k, _, _, _ in summarize.SUMMARY_USES}}
        self.patch_settings = patch.object(self.sd, "settings_load", return_value=dict(self.ALL_ON))
        self.patch_settings.start()

    def tearDown(self):
        self.patch_settings.stop()
        self.sd.DISPATCH_DIR = self._ddir
        self.sd.ENV_DIR, self.sd.ENV_FILE, self.sd.ENV_FISH = self._env
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_use_enabled_uses_explicit_flags_defaults_and_summary_auto(self):
        with patch.object(self.sd, "settings_load", return_value={"summary_uses": {"session": 0, "project": 1}}):
            self.assertFalse(self.summarize.use_enabled("session"))
            self.assertTrue(self.summarize.use_enabled("project"))
            self.assertFalse(self.summarize.use_enabled("here"))      # never chosen: off, nothing leaves the Mac
        with patch.object(self.sd, "settings_load", return_value={"summary_auto": 1}):
            self.assertTrue(self.summarize.use_enabled("session"))   # the old single switch still counts for sessions
            self.assertFalse(self.summarize.use_enabled("memories"))
        with patch.object(self.sd, "settings_load", return_value={"summary_uses": {"session": 1}, "summary_auto": 0}):
            self.assertTrue(self.summarize.use_enabled("session"))
        with patch.object(self.sd, "settings_load", return_value={}):
            self.assertFalse(self.summarize.use_enabled("session"))
            self.assertTrue(self.summarize.use_enabled("discuss"))   # a discussion only exists because the person started it

    def test_settings_parse_keeps_known_use_keys_as_zero_or_one(self):
        parsed = dispatch.settings_parse(json.dumps({"summary_uses": {"session": 0, "project": 2, "bogus": 1, "here": "x"}}))
        self.assertEqual(parsed.get("summary_uses"), {"session": 0, "project": 1})

    def test_cmd_settings_round_trips_summary_uses(self):
        saved = {}
        with patch.object(dispatch, "settings_load", return_value=dict(dispatch.SETTING_DEFAULTS)), \
             patch.object(dispatch, "wiki_store", side_effect=lambda k, v: saved.update({k: v})), \
             contextlib.redirect_stdout(io.StringIO()):
            dispatch.cmd_settings(types.SimpleNamespace(key="summary_uses", value='{"session": 0}', json=False))
        self.assertEqual(json.loads(saved[dispatch.SETTINGS_KEY])["summary_uses"], {"session": 0})

    def test_gated_memory_summary_skips_the_model(self):
        with patch.object(self.sd, "settings_load", return_value={"summary_uses": {"memories": 0}}), \
             patch.object(self.summarize, "provider") as prov, patch.object(self.summarize, "chat") as chat:
            with self.assertRaises(RuntimeError) as cm:
                memories.memory_summary()
        self.assertIn("没开", str(cm.exception))
        prov.assert_not_called()
        chat.assert_not_called()

    def test_gated_project_summary_reports_skipped(self):
        with patch.object(self.sd, "settings_load", return_value={"summary_uses": {"project": 0}}):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                dispatch.cmd_project_summary(types.SimpleNamespace(name="x", force=False, if_stale=False, json=True))
        res = json.loads(buf.getvalue())
        self.assertTrue(res["skipped"])
        self.assertIn("没开", res["reason"])

    def test_providers_catalog_has_env_and_configured(self):
        with patch.object(self.sd, "settings_load", return_value={}), \
             patch.object(self.sd, "env_read", return_value=[{"name": "ZHIPU_API_KEY", "value": "k", "note": "", "project": ""}]):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                dispatch.cmd_summarize(types.SimpleNamespace(op="providers", provider=None, json=True))
        res = json.loads(buf.getvalue())
        self.assertEqual(res["current"], "")
        by = {p["id"]: p for p in res["providers"]}
        self.assertTrue(all("env" in p and "configured" in p for p in res["providers"]))
        self.assertTrue(by["zhipu:glm-5.3-flash"]["configured"])
        self.assertEqual(by["zhipu:glm-5.3-flash"]["env"], "ZHIPU_API_KEY")
        self.assertFalse(by["deepseek:deepseek-chat"]["configured"])

    def test_set_key_writes_env_without_echoing(self):
        with tempfile.TemporaryDirectory() as d:
            self.sd.ENV_DIR = d
            self.sd.ENV_FILE = os.path.join(d, "env")
            self.sd.ENV_FISH = os.path.join(d, "env.fish")
            with patch.object(self.sd, "settings_load", return_value={}), \
                 patch.object(sys, "stdin", io.StringIO("secret-key-123\n")):
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    dispatch.cmd_summarize(types.SimpleNamespace(op="set-key", provider="zhipu", json=True))
            printed = buf.getvalue()
            self.assertNotIn("secret-key-123", printed)
            self.assertEqual(json.loads(printed), {"ok": True, "provider": "zhipu", "env": "ZHIPU_API_KEY", "configured": True})
            self.assertEqual({i["name"]: i["value"] for i in self.sd.env_read()}["ZHIPU_API_KEY"], "secret-key-123")

    def test_set_key_rejects_subscription_and_unknown_providers(self):
        for provider in ("claude", "nope"):
            with patch.object(self.sd, "settings_load", return_value={}), \
                 patch.object(sys, "stdin", io.StringIO("k")), \
                 self.assertRaises(SystemExit) as cm:
                dispatch.cmd_summarize(types.SimpleNamespace(op="set-key", provider=provider, json=False))
            self.assertEqual(cm.exception.code, 2)

    def test_uses_json_reflects_the_usage_log(self):
        with open(os.path.join(self.ddir, "summary-usage.json"), "w", encoding="utf-8") as f:
            json.dump({"session": {"at": 1700000000, "tokens": 42, "model": "zhipu:glm-5.3-flash"}}, f)
        with patch.object(self.sd, "settings_load", return_value=dict(self.ALL_ON)):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                dispatch.cmd_summarize(types.SimpleNamespace(op="uses", provider=None, json=True))
        rows = json.loads(buf.getvalue())
        by = {r["key"]: r for r in rows}
        self.assertEqual(len(rows), 8)
        self.assertEqual(by["session"]["last"], {"at": 1700000000, "tokens": 42, "model": "zhipu:glm-5.3-flash"})
        self.assertTrue(by["session"]["enabled"])
        self.assertIsNone(by["project"]["last"])

    def test_project_summary_untrusted_local_cache_is_replaced_by_a_trusted_remote_answer(self):
        """The mini scenario, verified on device: `bd memories` is NOT shared between the two
        Macs, so a bad summary the mini generated blind (no directory, no sessions) sits under
        its own copy of the key forever unless something replaces it. With no local material and
        no trust marker on its own cached copy, ask the other Mac for ITS summary and adopt (and
        store) that one instead — never keep serving the blind guess."""
        bad_local = {"summary": "Codex 是一个桌面端和手机端的会话与项目管理应用……", "at": int(time.time()) - 3600, "by": "claude:haiku", "sessions": 0, "open": 3, "closed": 1}
        good_remote = {"summary": "kanban 是任务管理与项目追踪系统……", "at": int(time.time()) - 90000, "by": "claude:haiku", "sessions": 68, "open": 32, "closed": 138, "trusted": True, "material_sessions": 68, "cached": True}
        key = dispatch.INTERNAL_MEMORY_PREFIX + "project-summary-kanban"
        host = {"id": "hub", "name": "书房的 Mac", "ssh": "hub"}
        stored = {}
        with patch.object(self.sd, "sh", return_value=(0, json.dumps({key: json.dumps(bad_local)}), "")), \
             patch.object(self.summarize, "provider", return_value={"id": "claude", "base": "", "model": "haiku", "key": ""}), \
             patch.object(self.summarize, "project_material", return_value={"sessions": 0, "open": 32, "closed": 138, "text": ""}), \
             patch.object(self.sd, "project_home", return_value=""), \
             patch.object(self.sd, "hosts", return_value=[host]), \
             patch.object(self.sd, "remote_dispatch", return_value=good_remote) as rd, \
             patch.object(self.summarize, "chat") as chat_mock, \
             patch.object(self.sd, "wiki_store", side_effect=lambda k, v: stored.update({k: v})):
            r = self.summarize.project_summary("kanban", if_stale=True)
        self.assertEqual(r["summary"], good_remote["summary"])
        self.assertTrue(r["trusted"])
        self.assertEqual(r["from_host"], "hub")
        self.assertFalse(r["cached"])
        chat_mock.assert_not_called()   # never generates locally once a trusted remote answer exists
        self.assertEqual(json.loads(stored[key])["summary"], good_remote["summary"])   # bad local copy overwritten
        rargs = rd.call_args[0][1]
        self.assertEqual(rargs[:2], ["project-summary", "kanban"])
        self.assertIn("--local", rargs)   # the peer answers only for itself — no recursive hop

    def test_project_summary_ignores_an_untrusted_remote_answer(self):
        host = {"id": "hub", "name": "书房的 Mac", "ssh": "hub"}
        blind_remote = {"summary": "瞎猜的", "at": int(time.time()), "by": "claude:haiku", "sessions": 0, "open": 3, "closed": 1}   # no "trusted"
        with patch.object(self.sd, "sh", return_value=(0, "{}", "")), \
             patch.object(self.summarize, "provider", return_value={"id": "claude", "base": "", "model": "haiku", "key": ""}), \
             patch.object(self.summarize, "project_material", return_value={"sessions": 0, "open": 3, "closed": 1, "text": ""}), \
             patch.object(self.sd, "project_home", return_value=""), \
             patch.object(self.sd, "hosts", return_value=[host]), \
             patch.object(self.sd, "remote_dispatch", return_value=blind_remote), \
             patch.object(self.summarize, "chat") as chat_mock, \
             self.assertRaises(RuntimeError) as cm:
            self.summarize.project_summary("kanban")
        self.assertIn("连不上有记录的机器", str(cm.exception))
        chat_mock.assert_not_called()

    def test_project_summary_without_material_or_reachable_peers_raises_instead_of_guessing(self):
        with patch.object(self.sd, "sh", return_value=(0, "{}", "")), \
             patch.object(self.summarize, "provider", return_value={"id": "claude", "base": "", "model": "haiku", "key": ""}), \
             patch.object(self.summarize, "project_material", return_value={"sessions": 0, "open": 3, "closed": 1, "text": ""}), \
             patch.object(self.sd, "project_home", return_value=""), \
             patch.object(self.sd, "hosts", return_value=[]), \
             patch.object(self.summarize, "chat") as chat_mock, \
             self.assertRaises(RuntimeError) as cm:
            self.summarize.project_summary("kanban")
        self.assertIn("没有这个项目的目录和会话记录", str(cm.exception))
        chat_mock.assert_not_called()

    def test_project_summary_falls_back_to_a_trusted_local_cache_when_no_peer_answers(self):
        """A record this host itself explicitly marked trusted (fetched from a peer earlier, or
        generated while it still had the directory) stays good even once the directory is gone
        and peers are unreachable right now — unlike an unmarked legacy entry, which would not."""
        trusted_local = {"summary": "之前记的总结", "at": int(time.time()) - 90000, "by": "claude:haiku", "sessions": 40, "open": 3, "closed": 1, "trusted": True, "material_sessions": 40}
        key = dispatch.INTERNAL_MEMORY_PREFIX + "project-summary-kanban"
        with patch.object(self.sd, "sh", return_value=(0, json.dumps({key: json.dumps(trusted_local)}), "")), \
             patch.object(self.summarize, "provider", return_value={"id": "claude", "base": "", "model": "haiku", "key": ""}), \
             patch.object(self.summarize, "project_material", return_value={"sessions": 0, "open": 3, "closed": 1, "text": ""}), \
             patch.object(self.sd, "project_home", return_value=""), \
             patch.object(self.sd, "hosts", return_value=[]), \
             patch.object(self.summarize, "chat") as chat_mock:
            r = self.summarize.project_summary("kanban", if_stale=True)
        self.assertEqual(r, {**trusted_local, "trusted": True, "cached": True})
        chat_mock.assert_not_called()

    def test_project_summary_local_only_never_consults_other_hosts(self):
        """`--local` is what a peer is asked with — it must answer for itself only, or two Macs
        with no material could bounce a request between each other forever."""
        with patch.object(self.sd, "sh", return_value=(0, "{}", "")), \
             patch.object(self.summarize, "provider", return_value={"id": "claude", "base": "", "model": "haiku", "key": ""}), \
             patch.object(self.summarize, "project_material", return_value={"sessions": 0, "open": 3, "closed": 1, "text": ""}), \
             patch.object(self.sd, "project_home", return_value=""), \
             patch.object(self.sd, "hosts") as hosts_mock, \
             patch.object(self.summarize, "chat") as chat_mock, \
             self.assertRaises(RuntimeError) as cm:
            self.summarize.project_summary("kanban", local_only=True)
        hosts_mock.assert_not_called()
        self.assertNotIn("连不上有记录的机器", str(cm.exception))
        chat_mock.assert_not_called()

    def test_fetch_remote_summary_picks_the_newest_trusted_answer_and_skips_untrusted_ones(self):
        older = {"summary": "旧一点", "at": 1000, "trusted": True, "by": "claude:haiku"}
        newer = {"summary": "新一点", "at": 2000, "trusted": True, "by": "claude:haiku"}
        blind = {"summary": "瞎猜的", "at": 5000, "by": "claude:haiku"}   # no "trusted": newest by time, must still lose
        hub = {"id": "hub", "name": "书房的 Mac", "ssh": "hub"}
        third = {"id": "third", "name": "third", "ssh": "third"}
        answers = {"hub": older, "third": newer}
        with patch.object(self.sd, "hosts", return_value=[hub, third]), \
             patch.object(self.sd, "remote_dispatch", side_effect=lambda h, *a, **kw: answers[h["id"]]):
            r = self.summarize.fetch_remote_summary("kanban")
        self.assertEqual(r["summary"], "新一点")
        self.assertEqual(r["from_host"], "third")
        # an untrusted-but-newer answer never wins even if it happened to come back
        with patch.object(self.sd, "hosts", return_value=[hub]), \
             patch.object(self.sd, "remote_dispatch", return_value=blind):
            self.assertIsNone(self.summarize.fetch_remote_summary("kanban"))

    def test_fetch_remote_summary_none_when_no_host_answers(self):
        with patch.object(self.sd, "hosts", return_value=[{"id": "hub", "name": "书房的 Mac", "ssh": "hub"}]), \
             patch.object(self.sd, "remote_dispatch", return_value=None):
            self.assertIsNone(self.summarize.fetch_remote_summary("kanban"))

    def test_project_summary_generates_when_this_host_has_the_project_dir(self):
        with patch.object(self.sd, "sh", return_value=(0, "{}", "")), \
             patch.object(self.summarize, "provider", return_value={"id": "zhipu", "base": "x", "model": "glm-5.3-flash", "key": "k"}), \
             patch.object(self.summarize, "project_material", return_value={"sessions": 0, "open": 3, "closed": 1, "text": "材料"}), \
             patch.object(self.sd, "project_home", return_value="/Users/x/Projects/kanban"), \
             patch.object(self.sd, "hosts") as hosts_mock, \
             patch.object(self.summarize, "chat", return_value="新的总结") as chat_mock, \
             patch.object(self.sd, "wiki_store") as store_mock:
            r = self.summarize.project_summary("kanban")
        self.assertFalse(r["cached"])
        self.assertEqual(r["summary"], "新的总结")
        self.assertTrue(r["trusted"])
        self.assertEqual(r["material_sessions"], 0)
        chat_mock.assert_called_once()
        store_mock.assert_called_once()
        hosts_mock.assert_not_called()   # has its own directory: never asks another Mac

    def test_project_summary_never_adopts_a_remote_answer_when_this_host_has_material(self):
        """The reverse of the mini bug: the MacBook (has the directory) must never fetch or
        adopt a peer's summary, blind or not — its own trusted cache always wins."""
        good_local = {"summary": "kanban 是任务管理与项目追踪系统……", "at": int(time.time()) - 1000, "by": "claude:haiku", "sessions": 68, "open": 32, "closed": 138, "trusted": True, "material_sessions": 68}
        key = dispatch.INTERNAL_MEMORY_PREFIX + "project-summary-kanban"
        with patch.object(self.sd, "sh", return_value=(0, json.dumps({key: json.dumps(good_local)}), "")), \
             patch.object(self.summarize, "provider", return_value={"id": "claude", "base": "", "model": "haiku", "key": ""}), \
             patch.object(self.sd, "project_home", return_value="/Users/alice/Projects/kanban"), \
             patch.object(self.sd, "hosts") as hosts_mock, \
             patch.object(self.summarize, "chat") as chat_mock:
            r = self.summarize.project_summary("kanban", if_stale=True)
        self.assertEqual(r, {**good_local, "trusted": True, "cached": True})
        chat_mock.assert_not_called()
        hosts_mock.assert_not_called()


class _StepClock:
    """A fake `time.time` that jumps forward a couple of seconds on every call, so a
    deadline-polling loop exits after a handful of (real-instant) iterations instead of
    actually waiting on the wall clock."""
    def __init__(self, start=1000.0, step=2.0):
        self.t = start
        self.step = step

    def __call__(self):
        self.t += self.step
        return self.t


class RemoteBackground(unittest.TestCase):
    """`here` must not wait on the other Mac: it answers from the cache (even a stale one) and
    lets a detached `dispatch remote-refresh` write the next answer."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        p = patch.object(dispatch, "REMOTE_DIR", self.dir)
        p.start()
        self.addCleanup(p.stop)
        self.h = {"id": "mini", "name": "mini", "ssh": "x"}
        self.args = ["here", "p", "--no-summary", "--local"]

    def write_cache(self, data, age=0):
        path = dispatch.remote_cache_path(self.h, self.args)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        if age:
            os.utime(path, (time.time() - age, time.time() - age))
        return path

    def test_stale_cache_comes_back_now_and_one_refresh_is_spawned(self):
        self.write_cache({"timeline": []}, age=600)
        with patch("subprocess.Popen") as pop, \
             patch("subprocess.run", side_effect=AssertionError("ssh 不该在前台跑")):
            self.assertEqual(dispatch.remote_dispatch(self.h, self.args, 30, background=True), {"timeline": []})
            self.assertEqual(dispatch.remote_dispatch(self.h, self.args, 30, background=True), {"timeline": []})
        self.assertEqual(pop.call_count, 1)   # the .lock keeps a second open from piling up ssh
        self.assertIn("remote-refresh", pop.call_args[0][0])
        self.assertGreaterEqual(dispatch.remote_cache_age(self.h, self.args), 600)

    def test_cold_cache_blocks_once_and_returns_the_fresh_answer(self):
        """Root fix: a host+command that has never answered before must not hand back nothing on
        the first call (that left the mini's docs/commits/sessions empty forever, since nothing
        ever asked again) — it blocks once, bounded, reusing the same detached remote-refresh +
        lock the stale-cache path uses, and returns as soon as that refresh's cache lands."""
        def fake_popen(cmd, **kw):
            # stands in for the detached `dispatch remote-refresh …` process finishing and
            # writing the cache the way cmd_remote_refresh would.
            self.write_cache({"timeline": ["新的"]})
            return unittest.mock.MagicMock()
        with patch("subprocess.Popen", side_effect=fake_popen) as pop, \
             patch("subprocess.run", side_effect=AssertionError("ssh 不该直接在这里跑")):
            r = dispatch.remote_dispatch(self.h, self.args, 30, timeout=5, background=True)
        self.assertEqual(r, {"timeline": ["新的"]})
        self.assertEqual(pop.call_count, 1)

    def test_cold_cache_gives_up_and_answers_none_if_the_refresh_never_lands(self):
        # A refresh that neither produces a cache nor ever ends (lock and no .down stay in place
        # throughout — unlike the two regression tests below) still must not wait forever: the
        # timeout is the backstop. timeout=5 leaves comfortable margin over the couple of extra
        # `time.time()` calls the spawn/lock bookkeeping makes against the fake clock's fixed step.
        clock = _StepClock()
        with patch("subprocess.Popen") as pop, \
             patch("subprocess.run", side_effect=AssertionError("ssh 不该在前台跑")), \
             patch("time.time", side_effect=clock), patch("time.sleep", return_value=None) as sl:
            self.assertIsNone(dispatch.remote_dispatch(self.h, self.args, 30, timeout=5, background=True))
        self.assertEqual(pop.call_count, 1)      # exactly one refresh spawned, not one per poll
        self.assertTrue(sl.called)               # it waited for the refresh rather than answering instantly
        self.assertIsNone(dispatch.remote_cache_age(self.h, self.args))

    def test_cold_cache_stops_waiting_once_the_refresh_ends_without_a_cache(self):
        """Regression: a host that is simply unreachable (asleep, off Tailscale) must not make a
        cold caller sit out the full timeout (~48s for `here`) — once the detached refresh has
        actually ended (its lock gone, exactly what cmd_remote_refresh does on every exit path,
        cache or not) there is nothing left to wait for."""
        lock = dispatch.remote_cache_path(self.h, self.args)[:-5] + ".lock"

        def fake_popen(cmd, **kw):
            # stands in for the whole detached `dispatch remote-refresh …` run finishing near
            # instantly with nothing to show for it — e.g. ssh couldn't even connect — and
            # dropping its lock the way cmd_remote_refresh always does.
            os.remove(lock)
            return unittest.mock.MagicMock()

        with patch("subprocess.Popen", side_effect=fake_popen), \
             patch("subprocess.run", side_effect=AssertionError("ssh 不该直接在这里跑")):
            t0 = time.time()
            r = dispatch.remote_dispatch(self.h, self.args, 30, timeout=45, background=True)
            elapsed = time.time() - t0
        self.assertIsNone(r)
        self.assertLess(elapsed, 2)   # nowhere near the 48s worst case a stuck wait would cost

    def test_cold_cache_stops_waiting_once_a_fresh_down_marker_appears(self):
        """Same regression, the other exit a failed refresh takes: ConnectTimeout/ssh-unreachable
        writes `<host>.down` instead of removing the lock outright — that must also end the
        wait immediately rather than only once the timeout elapses."""
        down = os.path.join(self.dir, f"{self.h['id']}.down")

        def fake_popen(cmd, **kw):
            open(down, "w").close()   # what the blocking ssh path writes on ConnectionError/TimeoutExpired
            return unittest.mock.MagicMock()

        with patch("subprocess.Popen", side_effect=fake_popen), \
             patch("subprocess.run", side_effect=AssertionError("ssh 不该直接在这里跑")):
            t0 = time.time()
            r = dispatch.remote_dispatch(self.h, self.args, 30, timeout=45, background=True)
            elapsed = time.time() - t0
        self.assertIsNone(r)
        self.assertLess(elapsed, 2)

    def test_second_cold_caller_reuses_the_in_flight_refresh_instead_of_spawning_another(self):
        lock = dispatch.remote_cache_path(self.h, self.args)[:-5] + ".lock"
        open(lock, "w").close()   # another process's cold refresh is already in flight

        def fake_sleep(secs):
            self.write_cache({"timeline": ["来自另一个刷新"]})   # ...which finishes while we wait

        with patch("subprocess.Popen") as pop, \
             patch("subprocess.run", side_effect=AssertionError("不该再跑一次 ssh")), \
             patch("time.sleep", side_effect=fake_sleep):
            r = dispatch.remote_dispatch(self.h, self.args, 30, timeout=5, background=True)
        self.assertEqual(r, {"timeline": ["来自另一个刷新"]})
        pop.assert_not_called()   # the fresh lock stopped a second refresh from being spawned

    def test_fresh_cache_needs_no_refresh(self):
        self.write_cache({"ok": 1})
        with patch("subprocess.Popen") as pop:
            self.assertEqual(dispatch.remote_dispatch(self.h, self.args, 30, background=True), {"ok": 1})
        self.assertEqual(pop.call_count, 0)

    def test_blocking_callers_keep_their_semantics(self):
        """sessions / activity / stats still wait for the answer — only `here` opted out."""
        self.write_cache({"old": 1}, age=600)
        r = types.SimpleNamespace(returncode=0, stdout=json.dumps({"new": 1}), stderr="")
        with patch("subprocess.run", return_value=r) as run, \
             patch("subprocess.Popen", side_effect=AssertionError("前台调用不该派后台刷新")):
            self.assertEqual(dispatch.remote_dispatch(self.h, self.args, 30), {"new": 1})
        self.assertEqual(run.call_args[0][0][0], "ssh")

    def test_remote_refresh_writes_the_cache_and_drops_the_lock(self):
        lock = dispatch.remote_cache_path(self.h, self.args)[:-5] + ".lock"
        # Exercises the spawn helper directly (not the full remote_dispatch(background=True)
        # call): that path now polls for the refresh's own cache write on a cold cache, which
        # this test's mocked Popen never produces — the spawn + lock-file bookkeeping under test
        # here is unrelated to that wait.
        with patch("subprocess.Popen") as pop, patch("subprocess.run", side_effect=AssertionError("ssh 不该在前台跑")):
            dispatch._spawn_remote_refresh(self.h, self.args, 45)
        self.assertTrue(os.path.exists(lock))
        spawned = pop.call_args[0][0]
        args = spawned[spawned.index("--") + 1:]
        r = types.SimpleNamespace(returncode=0, stdout=json.dumps({"new": 1}), stderr="")
        with patch.object(dispatch, "hosts", return_value=[self.h]), patch("subprocess.run", return_value=r):
            dispatch.cmd_remote_refresh(types.SimpleNamespace(host="mini", timeout=45, args=args))
        self.assertFalse(os.path.exists(lock))
        self.assertEqual(json.load(open(dispatch.remote_cache_path(self.h, self.args))), {"new": 1})


class ProjectNamesFromRows(unittest.TestCase):
    def test_rows_in_hand_skip_the_board_round_trip(self):
        rows = [{"labels": ["project:Notesapp", "dispatch:outcome"]}, {"labels": []}, {}]
        with patch.object(dispatch, "sh", side_effect=AssertionError("已经有全板数据就别再查一次")):
            self.assertEqual(dispatch.project_names(rows), {"notesapp": "Notesapp"})


class CatalogWindow(unittest.TestCase):
    def test_routine_runs_do_not_crowd_out_projects(self):
        import dispatch as D
        refs = [dict(session_id=f"cron{i}", last_at=1000 - i, entrypoint="cron", project="hermes") for i in range(30)]
        refs += [dict(session_id=f"p{i}", last_at=500 - i, project="kanban") for i in range(10)]
        refs += [dict(session_id="old1", last_at=5, project="readerapp"), dict(session_id="old2", last_at=4, project="readerapp"), dict(session_id="old3", last_at=3, project="readerapp"), dict(session_id="old4", last_at=2, project="readerapp")]
        out = D.catalog_window(refs, 12, routine_cap=2, per_project=3)
        ids = [r["session_id"] for r in out]
        self.assertEqual(sum(1 for i in ids if i.startswith("cron")), 2)
        self.assertEqual([i for i in ids if i.startswith("p")], [f"p{i}" for i in range(10)])
        self.assertEqual([i for i in ids if i.startswith("old")], ["old1", "old2", "old3"])  # newest 3 of the pushed-out project
        self.assertEqual(ids, sorted(ids, key=lambda i: -next(r["last_at"] for r in refs if r["session_id"] == i)))
        self.assertIs(D.catalog_window(refs, 0), refs)
        self.assertEqual(D.catalog_window(refs[:5], 12), refs[:5])


class SaveFile(unittest.TestCase):
    def test_keeps_extension_and_sanitises_name(self):
        import base64, io, json, os, tempfile
        import dispatch as D
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp, patch.object(D, "DISPATCH_DIR", tmp), patch("sys.stdin", io.StringIO(json.dumps({"name": "../weird name.tar.gz", "data": "data:application/gzip;base64," + base64.b64encode(b"x" * 10).decode()}))):
            printed = []
            with patch("builtins.print", lambda *a, **k: printed.append(a[0])):
                D.cmd_save_file(type("A", (), {"json": False})())
            path = printed[-1]
            self.assertTrue(path.startswith(os.path.join(tmp, "files")))
            self.assertTrue(path.endswith("-weird_name.tar.gz"))
            self.assertEqual(os.path.getsize(path), 10)


class SessionOrigin(unittest.TestCase):
    """Where a conversation was started, in one vocabulary across agents (task-xhk8)."""

    def test_claude_entrypoints_map_to_shared_words(self):
        self.assertEqual(dispatch.origin_of("cli"), "cli")
        self.assertEqual(dispatch.origin_of("claude-desktop"), "desktop")
        self.assertEqual(dispatch.origin_of("claude-vscode"), "vscode")
        self.assertEqual(dispatch.origin_of("vscode-extension"), "vscode")
        self.assertEqual(dispatch.origin_of("sdk-cli"), "sdk-cli")  # scripts stay recognisable to the views
        self.assertEqual(dispatch.origin_of(""), "")

    def test_codex_source_wins_over_originator(self):
        self.assertEqual(dispatch.origin_of("vscode", "codex_vscode"), "vscode")
        self.assertEqual(dispatch.origin_of(None, "Codex Desktop"), "desktop")
        self.assertEqual(dispatch.origin_of("exec", "codex_exec"), "exec")
        self.assertEqual(dispatch.origin_of("cli", "codex-tui"), "cli")
        self.assertEqual(dispatch.origin_of({"subagent": {"thread_spawn": {"depth": 1}}}, "codex_cli_rs"), "subagent")

    def test_codex_rollout_first_record_names_the_front_end(self):
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
            f.write(json.dumps({"type": "session_meta", "payload": {"id": "s1", "cwd": "/p", "originator": "codex_vscode", "source": "vscode"}}) + "\n")
            f.write(json.dumps({"type": "event_msg", "payload": {"type": "task_started"}}) + "\n")
        try:
            self.assertEqual(dispatch.codex_meta_origin(f.name), "vscode")
        finally:
            os.unlink(f.name)
        self.assertEqual(dispatch.codex_meta_origin("/nonexistent/rollout.jsonl"), "")

    def test_bare_process_under_vscode_is_an_editor_session(self):
        table = {1: (0, "/sbin/launchd"), 10: (1, "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"),
                 11: (10, "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)"),
                 12: (11, "/Users/x/.vscode/extensions/anthropic.claude-code-2.1.263-darwin-arm64/resources/native-binary/claude")}
        self.assertEqual(dispatch.host_of(12, table), ("editor", "VS Code"))
        ghostty = {1: (0, "/sbin/launchd"), 20: (1, "/Applications/Ghostty.app/Contents/MacOS/ghostty"), 21: (20, "-fish"), 22: (21, "codex")}
        self.assertEqual(dispatch.host_of(22, ghostty), ("terminal", "Ghostty"))
        bare = {1: (0, "/sbin/launchd"), 30: (1, "/usr/bin/login"), 31: (30, "-zsh"), 32: (31, "claude")}
        self.assertEqual(dispatch.host_of(32, bare), ("unknown", "未登记"))


class ProjectDirFlag(unittest.TestCase):
    """A project created in the app carries its folder in the flags (task-459r)."""

    def test_parse_keeps_dir_and_apply_preserves_it(self):
        raw = json.dumps({"lumen": {"starred": True, "dir": "/Users/x/Projects/lumen/"}, "bad": {"dir": "relative"}, "old": {"starred": True}})
        flags = dispatch.project_flags_parse(raw)
        self.assertEqual(flags["lumen"], {"starred": True, "dir": "/Users/x/Projects/lumen"})
        self.assertNotIn("dir", flags.get("bad", {}))
        after = dispatch.project_flags_apply(flags, "lumen", {"starred": False})
        self.assertEqual(after["lumen"], {"dir": "/Users/x/Projects/lumen"})  # the folder survives an unstar

    def test_sessions_under_the_folder_belong_to_the_project(self):
        with patch.object(dispatch, "_PROJECT_DIRS", {"lumen": "/Users/x/Code/notes-plugin"}), \
             patch.object(dispatch, "project_dir_names", lambda: {"lumen": "Lumen"}), \
             patch.object(dispatch, "workspace_project", lambda cwd, roots=None: ""):
            self.assertEqual(dispatch.project_of_cwd("/Users/x/Code/notes-plugin/src", {}), "Lumen")
            self.assertEqual(dispatch.project_of_cwd("/Users/x/Code/notes-plugin", {}), "Lumen")
            self.assertNotEqual(dispatch.project_of_cwd("/Users/x/Code/notes-plugin-2", {}), "Lumen")


class MissingToolsAndBoard(unittest.TestCase):
    """A Mac without bd / herdr / a board gets one readable line, never a traceback (review P0-3, P0-4)."""

    def test_sh_turns_a_missing_command_into_a_hint(self):
        with patch.object(dispatch.subprocess, "run", side_effect=FileNotFoundError(2, "No such file", "bd")):
            code, out_, err = dispatch.sh(["bd", "list"])
        self.assertEqual(code, 127); self.assertEqual(out_, "")
        self.assertIn("没找到命令 bd", err); self.assertIn("brew install beads", err)

    def test_no_board_is_recognised(self):
        self.assertTrue(dispatch.no_board(1, "Error: no beads database found"))
        self.assertTrue(dispatch.no_board(127, ""))
        self.assertFalse(dispatch.no_board(1, "Error: connection refused"))

    def test_readers_degrade_and_the_writer_refuses(self):
        with patch.object(dispatch, "sh", return_value=(1, "", "Error: no beads database found")):
            self.assertEqual(dispatch.wiki_all(), [])
            self.assertEqual(dispatch.project_flags_load(), {})
            with self.assertRaises(SystemExit):
                dispatch.project_flags_load(strict=True)

    def test_herdr_missing_returns_an_error_object(self):
        with patch.object(dispatch, "HERDR", "/nonexistent/herdr"):
            r = dispatch.herdr(None, ["agent", "list"])
            self.assertEqual(r["error"]["code"], "herdr_missing")
            self.assertEqual(dispatch.herdr(None, ["agent", "read", "x"], raw=True), "")


class DiscussAside(unittest.TestCase):
    """顺便问: answered on the side, kept out of the task so the discussion is not affected."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.issue = {"id": "task-as01", "title": "【讨论】要不要做共享账本", "description": "室友一起记账"}
        self.comments = [{"author": "codex", "text": "【讨论】用 CKShare 把账本分享给另一个 Apple ID"}]
        self.prompts = []

        def chat(system, user):
            self.prompts.append((system, user))
            return "CKShare 就像把一个文件夹共享给朋友。"
        self.writes = []
        self.patches = [
            mock.patch.object(dispatch, "DISCUSSIONS_DIR", self.dir),
            mock.patch.object(dispatch, "bd_json", side_effect=lambda args: self.issue if args[0] == "show" else {}),
            mock.patch.object(dispatch, "bd_comments", return_value=self.comments),
            mock.patch.object(dispatch, "aside_chat", return_value=(chat, "zhipu:glm")),
            mock.patch.object(dispatch, "sh", side_effect=lambda *a, **k: self.writes.append(a) or ""),
        ]
        for p in self.patches:
            p.start(); self.addCleanup(p.stop)

    def ask(self, **kw):
        a = types.SimpleNamespace(task="task-as01", question=[], stdin=False, quote="", clear=False, json=True)
        a.__dict__.update(kw)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            dispatch.cmd_discuss_aside(a)
        return json.loads(buf.getvalue())

    def test_answer_is_stored_beside_the_discussion_and_nothing_is_written_to_the_task(self):
        r = self.ask(question=["CKShare", "是什么"], quote="用 CKShare 把账本分享")
        self.assertEqual(len(r["items"]), 1)
        self.assertIn("文件夹", r["items"][0]["a"])
        self.assertEqual(self.writes, [])  # no bd comment, no bd update
        self.assertTrue(os.path.exists(os.path.join(self.dir, "task-as01.aside.json")))
        system, user = self.prompts[0]
        self.assertIn("同学", system)
        self.assertIn("CKShare 把账本分享给另一个", user)   # the thread is the context
        self.assertIn("【ta 划出来的原话】", user)

    def test_follow_up_sees_the_earlier_answer_and_list_and_clear_work(self):
        self.ask(question=["CKShare 是什么"])
        self.ask(question=["那冲突怎么办"])
        self.assertIn("你答：CKShare 就像", self.prompts[1][1])
        self.assertEqual(len(self.ask()["items"]), 2)      # no question: just the list, no model call
        self.assertEqual(len(self.prompts), 2)
        self.assertEqual(self.ask(clear=True)["items"], [])
        self.assertEqual(self.ask()["items"], [])

    def test_a_model_failure_is_kept_as_an_error_not_a_crash(self):
        def boom(system, user):
            raise OSError("offline")
        with mock.patch.object(dispatch, "aside_chat", return_value=(boom, "x")):
            r = self.ask(question=["?"])
        self.assertEqual(r["items"][0]["a"], "")
        self.assertIn("offline", r["items"][0]["error"])


class DiscussMembersCanSpeak(unittest.TestCase):
    """Two ways a member ended up silent (task-xawo)."""

    def test_timeout_in_seconds_is_not_read_as_milliseconds(self):
        self.assertEqual(dispatch.timeout_to_ms(1200), 1200000)   # an agent wrote twenty minutes in seconds
        self.assertEqual(dispatch.timeout_to_ms(600000), 600000)
        self.assertEqual(dispatch.timeout_to_ms(5), 60000)        # never under a minute
        self.assertEqual(dispatch.timeout_to_ms(None), 600000)
        self.assertEqual(dispatch.timeout_to_ms(0), 600000)

    def test_codex_prompt_comes_before_the_images(self):
        seen = {}

        class P:
            stdout = iter(()); returncode = 0
            class stderr:
                @staticmethod
                def read(): return b""
            def wait(self, timeout=None): return 0
            def kill(self): pass
        with tempfile.TemporaryDirectory() as tmp, patch.object(dispatch, "DISPATCH_DIR", tmp), \
             patch.object(dispatch.subprocess, "Popen", side_effect=lambda argv, **k: seen.update(argv=argv) or P()):
            dispatch.headless_call("codex", "gpt-x", "PROMPT TEXT", tmp, 60000, images=("/a.png", "/b.png"))
        argv = seen["argv"]
        self.assertLess(argv.index("PROMPT TEXT"), argv.index("-i"))
        self.assertEqual(argv[-4:], ["-i", "/a.png", "-i", "/b.png"])


class RemoteBoardLocation(unittest.TestCase):
    """Commands sent to a peer use that peer's own board folder (review P2-4)."""

    def test_default_custom_and_home_relative(self):
        self.assertEqual(dispatch.remote_beads(None), "BEADS_DIR=$HOME/tasks/.beads")
        self.assertEqual(dispatch.remote_beads({"beads_dir": ""}), "BEADS_DIR=$HOME/tasks/.beads")
        self.assertEqual(dispatch.remote_beads({"beads_dir": "~/work/board/.beads"}), "BEADS_DIR=$HOME/work/board/.beads")
        self.assertEqual(dispatch.remote_beads({"beads_dir": "/Volumes/Data/my board/.beads"}), "BEADS_DIR='/Volumes/Data/my board/.beads'")

    def test_this_macs_folder_is_written_relative_to_home(self):
        with patch.object(dispatch, "HOME", "/Users/me"), patch.object(dispatch, "BEADS_DIR", "/Users/me/tasks/.beads"):
            self.assertEqual(dispatch.beads_dir_portable(), "~/tasks/.beads")
        with patch.object(dispatch, "HOME", "/Users/me"), patch.object(dispatch, "BEADS_DIR", "/Volumes/Data/.beads"):
            self.assertEqual(dispatch.beads_dir_portable(), "/Volumes/Data/.beads")


class BoardReadsAreRememberedUntilAWrite(unittest.TestCase):
    def test_second_read_is_free_and_a_write_forgets(self):
        calls = []
        def fake(args, timeout=20, env=None):
            calls.append(tuple(args)); return 0, "{}", ""
        dispatch._bd_read_cache.clear()
        with patch.object(dispatch, "_sh", side_effect=fake):
            dispatch.sh(["bd", "memories", "--json"]); dispatch.sh(["bd", "memories", "--json"])
            self.assertEqual(len(calls), 1)
            dispatch.sh(["bd", "remember", "x", "--key", "k"])      # a write
            dispatch.sh(["bd", "memories", "--json"])
            self.assertEqual(len(calls), 3)
            dispatch.sh(["git", "status"]); dispatch.sh(["bd", "memories", "--json"])  # other tools do not matter
            self.assertEqual(len(calls), 4)
            with patch.object(dispatch, "_BD_READ_TTL", 0):                           # a resident process re-reads
                dispatch.sh(["bd", "memories", "--json"])
            self.assertEqual(len(calls), 5)
        dispatch._bd_read_cache.clear()
