# -*- coding: utf-8 -*-
import importlib
import importlib.util
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import re
import tempfile
import time
import types
import unittest
from unittest import mock
from unittest.mock import MagicMock, patch

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("dispatch", os.path.join(HERE, "dispatch.py"))
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)
import memories  # noqa: E402  (HERE is on sys.path under unittest discover; shares the sys.modules dispatch that summarize uses)


# Hermetic: the suite usually runs inside an Agent session. Nothing here may find that session
# (environment or presence registry) and link it to a task, or start a background checker.
for _k in (*dispatch.SESSION_ENV, "CLAUDECODE", "CODEX_SANDBOX", "CODEX_MANAGED_BY_NPM"):
    os.environ.pop(_k, None)
dispatch.SESS_DIR = tempfile.mkdtemp(prefix="dispatch-test-sessions-")


WINDOWS_READY = True
P = dispatch.P  # dplatform: tests flip P.IS_WIN to run the macOS or the Windows branch on either OS


def mac(test):
    """Run a test on the macOS branch (IS_WIN False) whatever OS runs the suite."""
    return patch.object(P, "IS_WIN", False)(test)


def win(test):
    """Run a test on the Windows branch (IS_WIN True) whatever OS runs the suite."""
    return patch.object(P, "IS_WIN", True)(test)


class RetiredAgentCache(unittest.TestCase):
    def test_old_local_and_remote_entries_do_not_reappear(self):
        rows = {"old": {"agent": "qoder"}, "ide": {"agent": "qoder-ide"}, "keep": {"agent": "codex"}}
        with tempfile.TemporaryDirectory() as d:
            name = os.path.join(d, "index.json")
            with open(name, "w", encoding="utf-8") as f:
                json.dump(rows, f)
            with patch.object(dispatch, "INDEX_FILE", name):
                self.assertEqual(dispatch.load_index(), {"keep": rows["keep"]})
            # Migration changes Dispatch's view, not another application's source data.
            with open(name, encoding="utf-8") as saved:
                self.assertEqual(json.load(saved), rows)
        self.assertEqual(dispatch._only_theirs(list(rows.values())), [rows["keep"]])


class ResumeCommand(unittest.TestCase):
    def setUp(self):
        p = patch.object(P, "IS_WIN", False)
        p.start()
        self.addCleanup(p.stop)

    def test_claude(self):
        self.assertEqual(dispatch.resume_command("claude-code", "abc", "/Users/x/p"), "cd '/Users/x/p' && claude --resume abc")

    def test_codex(self):
        self.assertEqual(dispatch.resume_command("codex", "abc", ""), "codex resume abc")

    def test_quotes_in_cwd_are_escaped(self):
        cmd = dispatch.resume_command("claude-code", "abc", "/Users/x/it's")
        self.assertIn("'/Users/x/it'\\''s'", cmd)

    def test_zcode_has_no_cli(self):
        self.assertTrue(dispatch.resume_command("zcode", "sess_1", "/x").startswith("open -a ZCode"))


class ResumeCommandWindows(unittest.TestCase):
    """Windows: the resume line is PowerShell (Set-Location -LiteralPath '…'; claude --resume …)."""

    @win
    def test_powershell_form(self):
        self.assertEqual(dispatch.resume_command("claude-code", "abc", "C:\\Users\\x\\p"),
                         "Set-Location -LiteralPath 'C:\\Users\\x\\p'; claude --resume abc")
        self.assertEqual(dispatch.resume_command("codex", "abc", ""), "codex resume abc")

    @win
    def test_single_quote_doubled(self):
        self.assertIn("'C:\\it''s'", dispatch.resume_command("codex", "abc", "C:\\it's"))

    @win
    def test_zcode_is_not_a_command(self):
        self.assertTrue(dispatch.resume_command("zcode", "s", "C:\\x").startswith("#"))

    @win
    def test_copy_uses_the_windows_clipboard(self):
        from types import SimpleNamespace
        ref = {"agent": "claude-code", "session_id": "abc", "resume_cmd": "claude --resume abc"}
        with patch.object(dispatch, "refs_everywhere", return_value=[("local", "PC", ref)]), \
             patch.object(P, "copy_to_clipboard", return_value=True) as clip, patch.object(dispatch.subprocess, "run") as run:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                dispatch.cmd_resume(SimpleNamespace(key="abc", copy=True, on=""))
        clip.assert_called_once_with("claude --resume abc")
        run.assert_not_called()
        self.assertIn("已复制到剪贴板", buf.getvalue())


class HostApp(unittest.TestCase):
    def setUp(self):
        p = patch.object(P, "IS_WIN", False)
        p.start()
        self.addCleanup(p.stop)

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

    def test_a_queued_message_with_a_picture_is_text_and_a_picture_not_its_repr(self):
        # Claude Code logs a message queued while it works as an attachment whose prompt is content blocks.
        png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
        lines = [
            {"type": "user", "timestamp": "2026-09-02T10:00:00Z", "message": {"role": "user", "content": "go"}},
            {"type": "assistant", "timestamp": "2026-09-02T10:00:01Z", "message": {"role": "assistant", "model": "claude-opus-5-5", "content": [{"type": "text", "text": "ok"}]}},
            {"type": "attachment", "timestamp": "2026-09-02T10:00:02Z", "attachment": {"type": "queued_command", "prompt": [
                {"type": "text", "text": "[Image #5] 看这张"}, {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": png}}]}},
            {"type": "assistant", "timestamp": "2026-09-02T10:00:03Z", "message": {"role": "assistant", "model": "<synthetic>", "content": [{"type": "text", "text": "No response requested."}]}},
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
            for l in lines:
                f.write(json.dumps(l) + "\n")
        ref = {"agent": "claude-code", "path": f.name, "session_id": "s", "cwd": "/x", "title": "", "tasks": {}, "subagents": []}
        d = dispatch.read_session_detail(ref)
        q = d["messages"][2]
        self.assertEqual((q["role"], q["text"], q["queued"]), ("user", "[Image #5] 看这张", True))
        self.assertEqual(len(q["images"]), 1)
        self.assertNotIn("base64", q["text"])
        # the thumbnail resolves: the attachment scan finds the same picture
        import attachments
        self.assertIn(q["images"][0], [a["id"] for a in attachments.catalog(ref)])
        # the model it answered with, not Claude Code's own <synthetic> notices
        self.assertEqual(d["meta"]["model"], "claude-opus-5-5")
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
        with patch.object(P, "IS_WIN", False):
            self.assertEqual(dispatch.resume_command("hermes", "20260907_220548_54ce4c", "/x"), "cd '/x' && hermes chat --resume 20260907_220548_54ce4c")

    def test_hermes_messages_pair_tool_results_by_call_id(self):
        call = json.dumps([{"id": "c1", "type": "function", "function": {"name": "write_file", "arguments": json.dumps({"path": "/x/a.md", "content": "hi"})}}])
        msgs = [
            {"id": 1, "role": "user", "content": "写个文件", "tool_calls": None, "tool_call_id": None, "tool_name": None, "timestamp": 1000.0, "reasoning": None, "reasoning_content": None, "display_kind": None},
            {"id": 2, "role": "assistant", "content": "", "tool_calls": call, "tool_call_id": None, "tool_name": None, "timestamp": 1001.0, "reasoning": "先写再说", "reasoning_content": None, "display_kind": None},
            {"id": 3, "role": "tool", "content": json.dumps({"success": True, "output": "written"}), "tool_calls": None, "tool_call_id": "c1", "tool_name": "write_file", "timestamp": 1002.0, "reasoning": None, "reasoning_content": None, "display_kind": None},
            {"id": 4, "role": "assistant", "content": "写好了", "tool_calls": None, "tool_call_id": None, "tool_name": None, "timestamp": 1003.0, "reasoning": None, "reasoning_content": None, "display_kind": None},
        ]
        from engines import hermes as H
        orig = H.query
        def fake(sql, params=()):
            if sql.startswith("select ended_at"):
                return [{"ended_at": 1003.0}]
            return [m for m in msgs if "id > ?" not in sql or m["id"] > params[1]]
        H.query = fake
        try:
            d = H.detail({"agent": "hermes", "session_id": "s", "cwd": "/x"}, 400)
            self.assertEqual([m["role"] for m in d["messages"]], ["user", "assistant", "assistant"])
            b = d["messages"][1]["blocks"]
            self.assertEqual([x["type"] for x in b], ["thinking", "tool_call"])
            self.assertEqual((b[1]["name"], b[1]["status"], b[1]["result"], b[1]["summary"]), ("write_file", "done", '{"success": true, "output": "written"}', "/x/a.md"))
            self.assertEqual([f["path"] for f in d["files"]], ["/x/a.md"])
            self.assertEqual(d["offset"], 4)
            d2 = H.detail({"agent": "hermes", "session_id": "s", "cwd": "/x"}, 400, since=2)
            self.assertEqual(([m["role"] for m in d2["messages"]], [r["id"] for r in d2["resolved"]]), (["assistant"], ["c1"]))
        finally:
            H.query = orig

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
        replay = f"import sys\nsys.stdin.read() if not sys.stdin.isatty() else None\nsys.stdout.write(open({os.path.join(tmp, 'events.jsonl')!r}, encoding='utf-8').read())\n"
        if os.name == "nt":
            # Windows runs no shebang scripts: a claude.cmd shim calls this Python on a .py file.
            with open(os.path.join(tmp, "fake_claude.py"), "w", encoding="utf-8") as f:
                f.write(replay)
            with open(os.path.join(tmp, "claude.cmd"), "w", encoding="utf-8") as f:
                f.write(f'@"{sys.executable}" "{os.path.join(tmp, "fake_claude.py")}" %*\r\n')
        else:
            fake = os.path.join(tmp, "claude")  # a stand-in `claude -p` that replays the stream
            with open(fake, "w") as f:
                f.write("#!/usr/bin/env python3\n" + replay)
            os.chmod(fake, 0o755)
        seen = []
        orig = dispatch.child_env
        dispatch.child_env = lambda: {**orig(), "PATH": tmp + os.pathsep + orig()["PATH"]}
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
        # Dispatch's own rules live in a temp DISPATCH_HOME: a test must never touch the real ~/.dispatch/rules
        self.home = os.path.join(self.tmp, "dispatch-home")
        self._env = os.environ.get("DISPATCH_HOME")
        os.environ["DISPATCH_HOME"] = self.home
        self._orig = (dispatch.RULES_FILE, dict(dispatch.RULE_TARGETS), dispatch.RULE_TARGETS_FILE)
        dispatch.RULES_FILE = self.rules
        dispatch.RULE_TARGETS_FILE = os.path.join(self.tmp, "rules-targets.json")
        self.paths = {ag: os.path.join(self.tmp, ag, "RULES.md") for ag in ("claude", "codex", "opencode", "zcode", "pi")}
        self.homes = {ag: os.path.join(self.tmp, ag) for ag in self.paths}
        dispatch.RULE_TARGETS = {
            "claude": {"path": self.paths["claude"], "mode": "import", "home": self.homes["claude"]},
            "codex": {"path": self.paths["codex"], "mode": "inline", "home": self.homes["codex"]},
            "opencode": {"path": self.paths["opencode"], "mode": "inline", "home": self.homes["opencode"]},
            "zcode": {"path": self.paths["zcode"], "mode": "inline", "home": self.homes["zcode"]},
            "pi": {"path": self.paths["pi"], "mode": "inline", "home": self.homes["pi"]},
        }

    def tearDown(self):
        dispatch.RULES_FILE, dispatch.RULE_TARGETS, dispatch.RULE_TARGETS_FILE = self._orig
        if self._env is None:
            os.environ.pop("DISPATCH_HOME", None)
        else:
            os.environ["DISPATCH_HOME"] = self._env

    def install(self, *agents):
        for ag in agents:
            os.makedirs(self.homes[ag], exist_ok=True)

    def _sync(self, force=False, op="sync"):
        import io, contextlib
        a = type("A", (), {"op": op, "force": force, "json": True})()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            dispatch.cmd_rules(a)
        return json.loads(buf.getvalue())

    def _targets(self, **kw):
        import io, contextlib
        a = type("A", (), dict({"op": "targets", "json": True, "set": None, "reset": False}, **kw))()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            dispatch.cmd_rules(a)
        return json.loads(buf.getvalue())

    def test_a_new_install_syncs_the_three_supported_engines_that_are_installed(self):
        self.install("claude", "codex", "zcode", "pi")  # opencode is not installed; zcode and pi are not supported by default
        r = self._sync()
        self.assertEqual({x["agent"]: x["action"] for x in r["results"]}, {"claude": "created", "codex": "created"})
        self.assertFalse(os.path.exists(self.paths["zcode"]))
        rows = {x["agent"]: x for x in self._targets()["targets"]}
        self.assertEqual(rows["opencode"]["why"], "not installed")
        self.assertEqual(rows["zcode"]["why"], "not supported")

    def test_a_machine_that_synced_before_keeps_its_targets_and_gains_the_supported_ones(self):
        self.install("claude", "codex", "opencode", "zcode", "pi")
        os.makedirs(os.path.dirname(self.paths["zcode"]), exist_ok=True)
        with open(self.paths["zcode"], "w") as f:  # ZCode was synced by an older Dispatch
            f.write("# zcode\n" + dispatch.RULES_BEGIN + " hash:0 source:x -->\nold\n" + dispatch.RULES_END + "\n")
        r = self._sync()
        self.assertEqual({x["agent"] for x in r["results"]}, {"claude", "codex", "opencode", "zcode"})
        self.assertEqual({x["agent"]: x["why"] for x in self._targets()["targets"] if x["syncing"]},
                         {"claude": "supported", "codex": "supported", "opencode": "supported", "zcode": "already synced"})
        self.assertFalse(os.path.exists(self.paths["pi"]))

    def test_the_persons_own_choice_wins_and_can_be_reset(self):
        self.install("claude", "codex", "opencode")
        rows = self._targets(set="claude")["targets"]
        self.assertEqual([x["agent"] for x in rows if x["syncing"]], ["claude"])
        self.assertEqual({x["agent"] for x in self._sync()["results"]}, {"claude"})
        self.assertEqual({x["agent"] for x in self._targets(reset=True)["targets"] if x["syncing"]}, {"claude", "codex", "opencode"})
        with self.assertRaises(SystemExit):
            self._targets(set="nobody")

    def test_sync_writes_globals_and_dispatch_rules_into_every_block(self):
        self.install("claude", "codex")
        with open(self.paths["claude"], "w") as f:
            f.write("# claude only\n")
        r = self._sync()
        self.assertEqual({x["agent"]: x["action"] for x in r["results"]}, {"claude": "appended", "codex": "created"})
        installed = os.path.join(self.home, "rules", "dispatch.md")
        self.assertTrue(os.path.isfile(installed))
        claude = open(self.paths["claude"]).read()
        self.assertTrue(claude.startswith("# claude only\n"))
        soul = os.path.join(self.home, "rules", "SOUL.md")
        self.assertIn("@" + self.rules + "\n@" + soul + "\n@" + installed + "\n", claude)  # three imports, no copy
        self.assertIn("dispatch:" + installed + " source:" + self.rules, claude.splitlines()[2])
        codex = open(self.paths["codex"]).read()
        self.assertIn("- fish, not bash", codex)  # both inlined
        self.assertIn("# Dispatch rules for agents", codex)
        self.assertLess(codex.index("- fish, not bash"), codex.index("# Dispatch rules for agents"))
        r2 = self._sync()
        self.assertTrue(all(x["action"] == "unchanged" for x in r2["results"]))

    def test_edit_marks_stale_and_updates_in_place(self):
        self.install("claude", "codex")
        self._sync()
        with open(self.rules, "a") as f:
            f.write("- new rule\n")
        h = dispatch.rules_digest()
        self.assertEqual(dispatch.target_state("codex", h)[0], "stale")
        r = self._sync()
        self.assertEqual({x["agent"]: x["action"] for x in r["results"]}, {"claude": "updated", "codex": "updated"})
        codex = open(self.paths["codex"]).read()
        self.assertEqual(codex.count(dispatch.RULES_BEGIN), 1)
        self.assertIn("- new rule", codex)

    def test_a_new_dispatch_md_makes_the_blocks_stale(self):
        self.install("claude", "codex")
        self._sync()
        installed = os.path.join(self.home, "rules", "dispatch.md")
        with open(installed, "a") as f:
            f.write("\n## Added\n- a new rule\n")
        # looking (status) does not replace the file; the installed copy is what agents got, so it is still in sync
        self.assertEqual([x["state"] for x in self._sync(op="status")["targets"]], ["stale", "stale"])
        self._sync()  # sync makes the copy current again (it is replaced on update), so the block follows the shipped text
        self.assertNotIn("a new rule", open(installed).read())


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
    def setUp(self):
        # Every env file points into a temp dir, env.sh included: a test must never rewrite the
        # person's real ~/.config/dispatch/env.sh.
        self._env = (dispatch.ENV_DIR, dispatch.ENV_FILE, dispatch.ENV_FISH, dispatch.ENV_SH, dispatch.ENV_KNOWN)
        self.addCleanup(self._restore)
        known = tempfile.mkdtemp(prefix="dtest-envknown-")
        self.addCleanup(shutil.rmtree, known, True)
        dispatch.ENV_KNOWN = os.path.join(known, "env-names.json")

    def _restore(self):
        dispatch.ENV_DIR, dispatch.ENV_FILE, dispatch.ENV_FISH, dispatch.ENV_SH, dispatch.ENV_KNOWN = self._env

    def test_roundtrip_mask_and_fish(self):
        with tempfile.TemporaryDirectory() as d:
            dispatch.ENV_DIR = d; dispatch.ENV_FILE = os.path.join(d, "env"); dispatch.ENV_FISH = os.path.join(d, "env.fish"); dispatch.ENV_SH = os.path.join(d, "env.sh")
            dispatch.env_write([{"name": "ZHIPU_API_KEY", "value": "abc123def456", "note": "智谱 GLM"}, {"name": "X", "value": "has space #1", "note": ""}])
            items = dispatch.env_read()
            self.assertEqual([i["name"] for i in items], ["ZHIPU_API_KEY", "X"])
            self.assertEqual(items[0]["note"], "智谱 GLM"); self.assertEqual(items[1]["value"], "has space #1")
            if os.name != "nt":  # Windows has no POSIX modes; the file lives in the private profile
                self.assertEqual(oct(os.stat(dispatch.ENV_FILE).st_mode & 0o777), "0o600")
            self.assertEqual(dispatch.env_mask("abc123def456"), "abc…456")
            self.assertIn("set -gx X 'has space #1'", open(dispatch.ENV_FISH).read())
            self.assertIn("ZHIPU_API_KEY=智谱 GLM", dispatch.env_summary_line())

    def test_sign_in_tokens_stay_out_of_shells(self):
        # exported, CLAUDE_CODE_OAUTH_TOKEN overrides the account `/login` picked in every terminal claude
        with tempfile.TemporaryDirectory() as d:
            dispatch.ENV_DIR = d; dispatch.ENV_FILE = os.path.join(d, "env"); dispatch.ENV_FISH = os.path.join(d, "env.fish"); dispatch.ENV_SH = os.path.join(d, "env.sh")
            dispatch.env_write([{"name": "CLAUDE_CODE_OAUTH_TOKEN", "value": "sk-ant-oat01-xyz", "note": ""}, {"name": "X", "value": "1", "note": ""}])
            self.assertEqual([i["name"] for i in dispatch.env_read()], ["CLAUDE_CODE_OAUTH_TOKEN", "X"])
            for f in (dispatch.ENV_FISH, dispatch.ENV_SH):
                text = open(f).read()
                self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", text)
                self.assertIn("X", text)

    def test_project_keys_stay_with_their_project(self):
        with tempfile.TemporaryDirectory() as d:
            dispatch.ENV_DIR = d; dispatch.ENV_FILE = os.path.join(d, "env"); dispatch.ENV_FISH = os.path.join(d, "env.fish"); dispatch.ENV_SH = os.path.join(d, "env.sh")
            dispatch.env_write([{"name": "ZHIPU_API_KEY", "value": "abc123def456", "note": "智谱 GLM"},
                                {"name": "LAB_LAKENET_API_KEY", "value": "nw-secret-1", "note": "Lakenet Managed AI", "project": "TUTOR"},
                                {"name": "OTHER_KEY", "value": "o-1", "note": "", "project": "notesapp"}])
            items = dispatch.env_read()
            self.assertEqual([(i["name"], i["project"]) for i in items], [("ZHIPU_API_KEY", ""), ("LAB_LAKENET_API_KEY", "TUTOR"), ("OTHER_KEY", "notesapp")])
            self.assertEqual(items[1]["note"], "Lakenet Managed AI")
            self.assertIn("# project: TUTOR\n# Lakenet Managed AI\nLAB_LAKENET_API_KEY=", open(dispatch.ENV_FILE).read())
            # prime: machine-wide keys everywhere, a project's keys only in that project
            self.assertNotIn("LAB_LAKENET", dispatch.env_summary_line())
            self.assertNotIn("OTHER_KEY", dispatch.env_summary_line("tutor"))
            self.assertIn("LAB_LAKENET_API_KEY=Lakenet Manage［本项目］", dispatch.env_summary_line("tutor"))
            self.assertIn("ZHIPU_API_KEY", dispatch.env_summary_line("tutor"))
            # list -P filters; set -P assigns; set with -P "" clears
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                dispatch.cmd_env(types.SimpleNamespace(op="list", name=None, value=None, note=None, project="TUTOR", stdin=False, fish=False, json=True))
            self.assertEqual([r["name"] for r in json.loads(buf.getvalue())], ["LAB_LAKENET_API_KEY"])
            with contextlib.redirect_stdout(io.StringIO()):
                dispatch.cmd_env(types.SimpleNamespace(op="set", name="ZHIPU_API_KEY", value="abc123def456", note=None, project="kanban", stdin=False, fish=False, json=False))
                dispatch.cmd_env(types.SimpleNamespace(op="set", name="OTHER_KEY", value="o-1", note=None, project="", stdin=False, fish=False, json=False))
            by = {i["name"]: i["project"] for i in dispatch.env_read()}
            self.assertEqual(by, {"ZHIPU_API_KEY": "kanban", "LAB_LAKENET_API_KEY": "TUTOR", "OTHER_KEY": ""})


class Guards(unittest.TestCase):
    def test_claude_quota_windows_carry_a_kind(self):
        # readers such as the IDE's account menu pick the weekly window by kind, not by the Chinese label
        usage = {"limits": [
            {"kind": "session", "percent": 6, "resets_at": "2026-09-27T12:00:00Z"},
            {"kind": "weekly_all", "percent": 97, "resets_at": "2026-10-01T08:00:00Z"},
            {"kind": "weekly_scoped", "percent": 21, "scope": {"model": {"display_name": "Fable"}}, "resets_at": "2026-10-01T08:00:00Z"},
        ]}
        from engines import claude as C
        with patch.object(C, "usage", return_value=(usage, 1.0)):
            q = dispatch.quota_of("claude")
        self.assertEqual([(w["kind"], w["used_percent"]) for w in q["windows"]], [("session", 6), ("weekly", 97), ("weekly_model", 21)])
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


def F(p):
    """A recorded absolute path as the JSON shows it: the path itself on macOS; on Windows the
    drive-qualified form with forward slashes (/p/a.py -> D:/p/a.py)."""
    return dispatch.ui_path(os.path.abspath(p))


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
        self.assertEqual([f["file"] for f in r["files"]], [F("/p/a.py"), F("/p/b.tsx")])
        self.assertFalse(any(f["conflict"] for f in r["files"]))
        self.assertEqual(len(r["sessions"]), 2)

    def test_same_file_from_two_sessions_is_flagged_and_sorted_first(self):
        self.record("s1", "pi", "/p/a.py", name="a1")
        self.record("s2", "claude-code", "/p/a.py", name="a2")
        self.record("s3", "pi", "/p/b.py", name="b1")
        r = self.report()
        self.assertEqual(r["files"][0]["file"], F("/p/a.py"))
        self.assertTrue(r["files"][0]["conflict"])
        self.assertEqual(len(r["files"][0]["editors"]), 2)
        self.assertFalse(r["files"][1]["conflict"])

    def test_stale_records_and_other_directories_are_dropped(self):
        self.record("s1", "pi", "/p/here/a.py")
        self.record("s2", "pi", "/other/b.py")
        self.record("s3", "pi", "/p/old.py", ts=time.time() - 3600, name="old")
        r = self.report(dir="/p")
        self.assertEqual([f["file"] for f in r["files"]], [F("/p/here/a.py")])


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

    def test_verified_completion_does_not_require_checklist_ticks(self):
        issue = {"id": "task-test", "labels": [], "acceptance_criteria": "- [ ] a\n- [x] b\n- [ ] c"}
        with patch.object(dispatch, "bd_json", return_value=issue) as bd, patch.object(dispatch, "out"), patch.object(dispatch, "sh", return_value=(0, "[]", "")), \
             patch.object(dispatch, "link_session"), patch.object(dispatch, "phone_push"), patch.dict(dispatch.os.environ, {"BEADS_ACTOR": "pi"}):
            dispatch.cmd_done(types.SimpleNamespace(task="task-test", reason="npm test passed", verified=True, review_by=None, next=[], retro=None, json=False))
        self.assertTrue(any(c.args[0][0] == "close" for c in bd.call_args_list))
        self.assertFalse(any("--acceptance" in c.args[0] for c in bd.call_args_list))

class DoneTicksPlan(unittest.TestCase):
    def done(self, issue):
        with patch.object(dispatch, "bd_json", return_value=issue) as bd, patch.object(dispatch, "out") as out, patch.object(dispatch, "sh", return_value=(0, "[]", "")), \
             patch.object(dispatch, "link_session"), patch.object(dispatch, "phone_push"):
            dispatch.cmd_done(types.SimpleNamespace(task="task-test", reason="merged", verified=True, review_by=None, next=[], retro=None, json=True))
        return [c.args[0] for c in bd.call_args_list], out.call_args.args[0]

    def test_done_ticks_the_steps_still_open_before_closing(self):
        issue = {"id": "task-test", "labels": [], "metadata": {"other": 1, "plan": [
            {"text": "Find it", "state": "done"}, {"text": "Fix it", "state": "active"}, {"text": "Ship it", "state": "todo"}]}}
        calls, res = self.done(issue)
        ops = [c[0] for c in calls]
        self.assertLess(ops.index("update"), ops.index("close"))
        m = json.loads(calls[ops.index("update")][calls[ops.index("update")].index("--metadata") + 1])
        self.assertEqual([p["state"] for p in m["plan"]], ["done", "done", "done"])
        self.assertEqual(m["other"], 1)
        self.assertEqual(res["plan_ticked"], 2)

    def test_done_leaves_a_ticked_or_missing_plan_alone(self):
        for meta in ({"plan": [{"text": "A", "state": "done"}]}, {}):
            calls, res = self.done({"id": "task-test", "labels": [], "metadata": meta})
            self.assertNotIn("update", [c[0] for c in calls if "--metadata" in c])
            self.assertEqual(res["plan_ticked"], 0)

    def test_a_failed_tick_still_closes(self):
        issue = {"id": "task-test", "labels": [], "metadata": {"plan": [{"text": "A", "state": "todo"}]}}
        def bd(args, *a, **k):
            if args[0] == "update" and "--metadata" in args:
                raise SystemExit("bd down")
            return issue
        with patch.object(dispatch, "bd_json", side_effect=bd) as m, patch.object(dispatch, "out") as out, patch.object(dispatch, "sh", return_value=(0, "[]", "")), \
             patch.object(dispatch, "link_session"), patch.object(dispatch, "phone_push"):
            dispatch.cmd_done(types.SimpleNamespace(task="task-test", reason="merged", verified=True, review_by=None, next=[], retro=None, json=True))
        self.assertIn("close", [c.args[0][0] for c in m.call_args_list])
        self.assertEqual(out.call_args.args[0]["plan_ticked"], 0)


class TerminalWordsAreEnglish(unittest.TestCase):
    """task-ztry: a person types dispatch begin / claim / log / done / list in a Terminal on a new Mac; what comes back
    is in English like the rest of the app (the task's own title stays as written)."""
    CJK = re.compile(r"[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]")

    def run_cmd(self, fn, *a, **k):
        o, e = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(o), contextlib.redirect_stderr(e):
            try:
                fn(*a, **k)
            except SystemExit:
                pass
        return o.getvalue() + e.getvalue()

    def test_begin_claim_log_done(self):
        a = types.SimpleNamespace(title='Board check: first task on a new Mac', project='demo', type='task', priority=2,
                                  desc='A new person types this in Terminal to see the board work from start to end.', acceptance=None, deps=None,
                                  json=False, session=None, force=False, thing='', owns='')
        tv = types.SimpleNamespace(begin_thing=lambda *x, **k: {"thing": "Board", "from": ""}, begin_owns=lambda *x, **k: None)
        mod = lambda name: tv if name == "tasks_view" else (_ for _ in ()).throw(ImportError(name))
        with patch.object(dispatch, 'begin_warnings', return_value=[]), patch.object(dispatch, 'local_host_name', return_value='mac'), \
                patch.object(dispatch, '_mod', mod), patch.object(dispatch, 'bd_json', side_effect=[{'id': 'task-abc'}, {}]), patch.object(dispatch, 'sh', return_value=(0, '[]', '')):
            text = self.run_cmd(dispatch.cmd_begin, a)
        self.assertIn('created and claimed', text)
        self.assertFalse(self.CJK.search(text), text)
        with patch.object(dispatch, 'neighbours', return_value=[{'agent': 'opencode', 'session_id': 'ses_12345678', 'last_at': 0}]), \
                patch.object(dispatch, 'sh', return_value=(0, '[]', '')), patch.object(dispatch, 'session_self', return_value=''), patch.object(dispatch, 'ancestor_pids', return_value=[]):
            warns = dispatch.begin_warnings('Try the task board', 'demo', '/tmp')
        self.assertTrue(warns and not any(self.CJK.search(w) for w in warns), warns)
        a = types.SimpleNamespace(title='短', project='demo', type='task', priority=2, desc='', acceptance=None, deps=None, json=False, session=None, force=False)
        with patch.object(dispatch, '_begin_noted', return_value=False):
            text = self.run_cmd(dispatch.cmd_begin, a)
        self.assertIn('Task not created', text)
        self.assertFalse(self.CJK.search(text.replace('短', '')), text)
        issue = {'id': 'task-abc', 'title': 'Board check', 'labels': []}
        with patch.object(dispatch, 'bd_json', side_effect=[issue, {}]), patch.object(dispatch, 'session_self', return_value=''), patch.object(dispatch, 'link_session'):
            text = self.run_cmd(dispatch.cmd_claim, types.SimpleNamespace(task='task-abc', force=False))
        self.assertEqual(text.strip(), '"Board check" (task-abc) claimed')
        with patch.object(dispatch, "bd_json", return_value=issue), patch.object(dispatch, "sh", return_value=(0, "[]", "")), \
                patch.object(dispatch, "link_session"), patch.object(dispatch, "phone_push"):
            text = self.run_cmd(dispatch.cmd_done, types.SimpleNamespace(task="task-abc", reason="checked", verified=False, review_by=None, next=[], retro=None, json=False))
        self.assertIn('"Board check" (task-abc) done', text)
        self.assertFalse(self.CJK.search(text), text)


class BeginSessionLink(unittest.TestCase):
    def test_records_explicit_session_for_delivery(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        a = SimpleNamespace(title='test', project='kanban', type='task', priority=2, desc=None, acceptance=None, deps=None, json=True, session='session-123456', force=True)
        with patch.object(dispatch, 'begin_warnings', return_value=[]), patch.object(dispatch, 'local_host_name', return_value='test'), patch.object(dispatch, 'out'), patch.object(dispatch, 'bd_json', side_effect=[{'id':'task-test'},{}]) as bd, patch.object(dispatch, 'sh', return_value=(0, '[]', '')):
            dispatch.cmd_begin(a)
        self.assertIn('session:session-123456', bd.call_args_list[0].args[0][bd.call_args_list[0].args[0].index('-l')+1])
        self.assertIn('session-origin:session-123456', bd.call_args_list[0].args[0][bd.call_args_list[0].args[0].index('-l')+1])
        # the session is stored by the create itself (one write fewer, task-p03j); the second write only claims
        create = bd.call_args_list[0].args[0]
        self.assertEqual(json.loads(create[create.index('--metadata') + 1])['claim_session'], 'session-123456')
        self.assertEqual(bd.call_args_list[1].args[0], ['update', 'task-test', '--claim', '--json'])

    def test_an_opencode_shell_ties_the_task_to_its_session(self):
        # Dispatch's OpenCode plugin exports DISPATCH_SESSION_ID (OpenCode's ses_…) to every shell command
        from types import SimpleNamespace
        from unittest.mock import patch
        a = SimpleNamespace(title='test', project='kanban', type='task', priority=2, desc=None, acceptance=None, deps=None, json=True, session=None, force=True)
        env = {k: v for k, v in os.environ.items() if k not in dispatch.SESSION_ENV}
        env['DISPATCH_SESSION_ID'] = 'ses_2c4f9a1b3effeEFbh'
        with patch.dict(dispatch.os.environ, env, clear=True), patch.object(dispatch, 'begin_warnings', return_value=[]), patch.object(dispatch, 'local_host_name', return_value='test'), \
             patch.object(dispatch, 'out'), patch.object(dispatch, 'phone_push'), patch.object(dispatch, 'bd_json', side_effect=[{'id': 'task-test'}, {}]) as bd, patch.object(dispatch, 'sh', return_value=(0, '[]', '')):
            dispatch.cmd_begin(a)
        labels = bd.call_args_list[0].args[0][bd.call_args_list[0].args[0].index('-l') + 1]
        self.assertIn('session:ses_2c4f9a1b3effeEFbh', labels)
        self.assertIn('session-origin:ses_2c4f9a1b3effeEFbh', labels)

    def test_invalid_session_cannot_inject_labels(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        a = SimpleNamespace(title='test', project='kanban', type='task', priority=2, desc=None, acceptance=None, deps=None, json=True, session='bad,reviewed', force=True)
        with patch.object(dispatch, 'begin_warnings', return_value=[]), patch.object(dispatch, 'local_host_name', return_value='test'), patch.object(dispatch, 'out'), patch.object(dispatch, 'bd_json', side_effect=[{'id':'task-test'},{}]) as bd:
            dispatch.cmd_begin(a)
        self.assertEqual(bd.call_args_list[0].args[0][bd.call_args_list[0].args[0].index('-l')+1], 'project:kanban,host:test')
        create = bd.call_args_list[0].args[0]
        self.assertEqual(json.loads(create[create.index('--metadata') + 1])['claim_session'], '')

    def test_claim_updates_owner_and_session_together_without_replacing_metadata(self):
        issue = {'id': 'task-test', 'title': 'Claim task', 'labels': [], 'metadata': {'plan': ['keep']}}
        with patch.object(dispatch, 'bd_json', side_effect=[issue, {}]) as bd, \
             patch.object(dispatch, 'session_self', return_value='session-123456'), \
             patch.object(dispatch, 'link_session'), contextlib.redirect_stdout(io.StringIO()):
            dispatch.cmd_claim(types.SimpleNamespace(task='task-test', force=False))
        args = bd.call_args_list[1].args[0]
        self.assertIn('--claim', args)
        self.assertIn('--set-metadata', args)
        self.assertIn('claim_session=session-123456', args)
        self.assertNotIn('--metadata', args)

class NotedFromChat(unittest.TestCase):
    """task-b83p: what Dispatch noted from the person's message is the agent's own; it is not made twice, not refused,
    and the agent is not its own neighbour."""

    def noted(self, state="in_progress", now=True, taken=False, labels=("from-chat",)):
        return {'id': 'task-n1', 'title': 'Fix the login bug', 'status': state, 'assignee': 'fixture', 'labels': list(labels),
                'metadata': {'chat': {'now': now, 'taken': taken, 'quote': 'Fix the login bug'}}}

    def test_the_agent_in_the_chat_claims_what_dispatch_claimed_for_it(self):
        with patch.dict(os.environ, {"BEADS_ACTOR": ""}), \
             patch.object(dispatch, 'bd_json', side_effect=[self.noted(), {}]) as bd, \
             patch.object(dispatch, 'session_self', return_value='ses_abcdef123456'), \
             patch.object(dispatch, 'link_session'), patch.object(dispatch, '_mod', return_value=types.SimpleNamespace(D=None, taken=lambda tid: None, whose=lambda t, sid: "mine")), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
            dispatch.cmd_claim(types.SimpleNamespace(task='task-n1', force=False))
        self.assertEqual(err.getvalue(), "")
        args = bd.call_args_list[1].args[0]
        self.assertIn('--assignee', args)
        self.assertNotIn('--claim', args)

    def test_what_dispatch_claimed_for_another_chat_is_refused(self):
        """task-lj06.17: an agent in another conversation took it ("it is yours")."""
        with patch.dict(os.environ, {"BEADS_ACTOR": "codex"}), patch.object(dispatch, 'bd_json', side_effect=[self.noted()]), \
             patch.object(dispatch, 'session_self', return_value='bbbbbbbb-2222'), \
             patch.object(dispatch, '_mod', return_value=types.SimpleNamespace(D=None, whose=lambda t, sid: "other", chat_of=lambda t: t["metadata"]["chat"])), \
             contextlib.redirect_stderr(io.StringIO()) as err, self.assertRaises(SystemExit):
            dispatch.cmd_claim(types.SimpleNamespace(task='task-n1', force=False))
        self.assertRegex(err.getvalue(), "another conversation|另一个会话")

    def test_the_same_engine_in_another_conversation_is_refused(self):
        """Review 10-22: capture claims under the agent's board name (claude-code), which every Claude conversation signs
        with; conversation B must not take what the person asked conversation A for (the real capture.whose)."""
        held = {'id': 'task-n1', 'title': 'Fix the login bug', 'status': 'in_progress', 'assignee': 'claude-code', 'labels': ['from-chat'],
                'metadata': {'chat': {'now': True, 'taken': True, 'session': 'claude-code:aaaaaaaa-1111-4111-8111-111111111111'}}}
        with patch.dict(os.environ, {"BEADS_ACTOR": "claude-code"}), patch.object(dispatch, 'bd_json', side_effect=[held]), \
             patch.object(dispatch, 'session_self', return_value='bbbbbbbb-2222-4222-8222-222222222222'), \
             contextlib.redirect_stderr(io.StringIO()) as err, self.assertRaises(SystemExit):
            dispatch.cmd_claim(types.SimpleNamespace(task='task-n1', force=False))
        self.assertRegex(err.getvalue(), "another conversation|另一个会话")

    def test_a_task_noted_for_later_goes_to_the_session_started_for_it(self):
        """Second review 10-22: Next up starts a session of its own for a task noted in conversation A (no chat.now); the
        agent there, holding it under the same name, claims it."""
        held = {'id': 'task-n2', 'title': 'Fix the feed dates', 'status': 'in_progress', 'assignee': 'claude-code', 'labels': ['from-chat'],
                'metadata': {'chat': {'session': 'claude-code:aaaaaaaa-1111-4111-8111-111111111111'}}}
        with patch.dict(os.environ, {"BEADS_ACTOR": "claude-code"}), patch.object(dispatch, 'bd_json', side_effect=[held, {}]) as bd, \
             patch.object(dispatch, 'session_self', return_value='bbbbbbbb-2222-4222-8222-222222222222'), patch.object(dispatch, 'link_session'), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            dispatch.cmd_claim(types.SimpleNamespace(task='task-n2', force=False))
        self.assertIn('--claim', bd.call_args_list[1].args[0])

    def test_a_forced_take_over_assigns_instead_of_claiming(self):
        """10-22: --force on a task someone else holds failed in bd ("already claimed by schaefer"): bd's --claim never
        takes a task over, so the forced take-over sets the assignee."""
        held = {'id': 'task-n1', 'title': 'Fix the login bug', 'status': 'in_progress', 'assignee': 'schaefer', 'labels': ['from-chat'],
                'metadata': {'chat': {'now': True, 'taken': True}}}
        with patch.dict(os.environ, {"BEADS_ACTOR": "claude-code"}), patch.object(dispatch, 'bd_json', side_effect=[held, {}]) as bd, \
             patch.object(dispatch, 'session_self', return_value='ses_abcdef123456'), patch.object(dispatch, 'link_session'), \
             patch.object(dispatch, '_mod', return_value=types.SimpleNamespace(D=None, whose=lambda t, sid: "other")), \
             contextlib.redirect_stdout(io.StringIO()) as out:
            dispatch.cmd_claim(types.SimpleNamespace(task='task-n1', force=True))
        args = bd.call_args_list[1].args[0]
        self.assertEqual(args[args.index('--assignee') + 1], 'claude-code')
        self.assertNotIn('--claim', args)
        self.assertIn('taken over from schaefer', out.getvalue())

    def test_taking_noted_work_keeps_the_agents_checklist_and_description(self):
        """task-lj06.24: task_begin with five checklist items took the noted task and dropped them; task_log then said
        there is no item 1."""
        a = types.SimpleNamespace(title='Create to-do list page', project='todo', json=True, session='ses_abcdef123456', force=False,
                                  acceptance='- [ ] index.html and app.js exist\n- [ ] Adding an item shows it', desc='The person wants a to-do page with add and delete.')
        fake = types.SimpleNamespace(D=None, NEXT='nextup', LATER='later', taken=lambda tid: None,
                                     claim_noted=lambda *x: {'id': 'task-hl3', 'title': 'Create to-do list page', 'state': 'working', 'for_this_chat': True})
        noted = {'id': 'task-hl3', 'description': 'From chat (15:10): 「Create a simple to-do list page」', 'acceptance_criteria': ''}
        seen = []
        with patch.object(dispatch, '_mod', return_value=fake), patch.object(dispatch, 'bd_json', side_effect=lambda argv: seen.append(argv) or (noted if argv[0] == 'show' else {})), \
             patch.object(dispatch, 'out'):
            self.assertTrue(dispatch._begin_noted(a, a.title))
        upd = next(x for x in seen if x[0] == 'update')
        self.assertEqual(upd[upd.index('--acceptance') + 1], a.acceptance)
        desc = upd[upd.index('--description') + 1]
        self.assertTrue(desc.startswith('From chat (15:10)'))
        self.assertTrue(desc.endswith(a.desc))

    def test_someone_elses_task_is_still_refused(self):
        other = self.noted(taken=True)
        with patch.dict(os.environ, {"BEADS_ACTOR": "codex"}), patch.object(dispatch, 'bd_json', side_effect=[other]), \
             contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            dispatch.cmd_claim(types.SimpleNamespace(task='task-n1', force=False))

    def begin(self, got):
        a = types.SimpleNamespace(title='Fix the login bug', project='shop', json=True, session='ses_abcdef123456', force=False)
        fake = types.SimpleNamespace(D=None, NEXT='nextup', LATER='later', claim_noted=lambda *x: got, taken=lambda tid: seen.append(('taken', tid)))
        seen = []
        with patch.object(dispatch, '_mod', return_value=fake), patch.object(dispatch, 'bd_json', side_effect=lambda argv: seen.append(argv) or {}), \
             patch.object(dispatch, 'out', side_effect=lambda o, j, f: seen.append(('out', o))):
            took = dispatch._begin_noted(a, a.title)
        return took, seen

    def test_begin_takes_the_task_dispatch_claimed_for_this_chat(self):
        took, seen = self.begin({'id': 'task-n1', 'title': 'Fix the login bug', 'state': 'working', 'for_this_chat': True})
        self.assertTrue(took)
        upd = next(x for x in seen if isinstance(x, list))
        self.assertIn('--assignee', upd)
        self.assertNotIn('--claim', upd)
        self.assertIn(('taken', 'task-n1'), seen)
        self.assertNotIn('already', next(x for x in seen if isinstance(x, tuple) and x[0] == 'out')[1])

    def test_begin_leaves_a_later_thing_alone(self):
        took, seen = self.begin({'id': 'task-n2', 'title': 'Add a README', 'state': 'later', 'for_this_chat': False})
        self.assertTrue(took)
        self.assertFalse([x for x in seen if isinstance(x, list)])  # not claimed, not created
        self.assertTrue(next(x for x in seen if isinstance(x, tuple) and x[0] == 'out')[1]['later'])

    def test_begin_checks_noted_work_before_warning_about_neighbours(self):
        a = types.SimpleNamespace(title='Fix the login bug: users cannot sign in', project='shop', type='task', priority=2,
                                  desc='用户原话：登录坏了，用户进不去，要修好让大家能登录。', acceptance=None, deps=None, json=True, session=None, force=False)
        with patch.object(dispatch, '_begin_noted', return_value=True), patch.object(dispatch, 'begin_warnings', side_effect=AssertionError("warned")), \
             patch.object(dispatch, 'title_problems', return_value=[]):
            dispatch.cmd_begin(a)

    def test_an_agent_in_a_chat_without_a_project_folder_files_its_task_in_no_project(self):
        """task-p0za2: an agent in a Chats session named a project (task_begin asked for one) and its task landed there."""
        import dispatch_dir
        home = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, home, True)
        p = patch.object(dispatch_dir, "home", lambda: home)
        p.start()
        self.addCleanup(p.stop)
        chat = os.path.join(home, ".copilot", "chats", "72d72eb2-ee03-4e87-9d97-c9962b9860f9")
        os.makedirs(chat)
        made = []

        def run(cwd, session):
            a = types.SimpleNamespace(title='Write the reschedule email: Monday 8 am no longer works', project='kanban', type='task', priority=2,
                                      desc='The person asked for an email moving the Monday appointment.', acceptance=None, deps=None, json=True,
                                      session=session, force=False, thing='', owns='')
            seen = []
            fake = types.SimpleNamespace(begin_thing=lambda *x: {}, begin_owns=lambda *x: None)
            old = os.getcwd()
            os.chdir(cwd)
            try:
                with patch.object(dispatch, '_begin_noted', return_value=False), patch.object(dispatch, 'begin_warnings', return_value=[]), \
                     patch.object(dispatch, 'title_problems', return_value=[]), patch.object(dispatch, '_mod', return_value=fake), \
                     patch.object(dispatch, 'bd_json', side_effect=lambda argv: seen.append(argv) or {'id': 'task-c1'}), \
                     patch.object(dispatch, 'out'), contextlib.redirect_stderr(io.StringIO()) as err:
                    dispatch.cmd_begin(a)
            finally:
                os.chdir(old)
            made.append(err.getvalue())
            return seen[0][seen[0].index('-l') + 1].split(',')

        self.assertFalse([x for x in run(chat, 'ses_abcdef123456') if x.startswith('project:')])
        self.assertRegex(made[-1], "kept in Chats|记在 Chats")
        # a person at a terminal who names a project gets it; so does an agent in a project's folder
        with patch.dict(os.environ, {k: "" for k in dispatch.SESSION_ENV}):
            self.assertIn('project:kanban', run(chat, None))
        proj = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, proj, True)
        self.assertIn('project:kanban', run(proj, 'ses_abcdef123456'))

    def test_the_agent_running_the_command_is_not_its_own_neighbour(self):
        rows = [{"session_id": "window-id-1", "native_session_id": "ses_own", "cwd": "/a/b", "alive": True, "agent_pid": 4242},
                {"session_id": "x", "cwd": "/a/b", "alive": True, "agent_pid": 5000}]
        with patch.object(dispatch, "live_sessions", return_value=rows):
            self.assertEqual([s["session_id"] for s in dispatch.neighbours("/a/b", "", skip_pids={4242, 1})], ["x"])
            self.assertEqual([s["session_id"] for s in dispatch.neighbours("/a/b", "ses_own")], ["x"])
        table = {300: (200, "zsh"), 200: (100, "opencode"), 100: (1, "launchd")}
        self.assertEqual(dispatch.ancestor_pids(300, table), {300, 200, 100})


class BeginTitleRule(unittest.TestCase):
    def _begin(self, title, short):
        from types import SimpleNamespace
        a = SimpleNamespace(title=title, project='kanban', type='task', priority=2, desc='用户原话：为什么要做这件事，期望什么结果，越写越清楚越好。',
                            acceptance=None, deps=None, json=True, session=None, force=False)
        fake = types.SimpleNamespace(short_title=lambda full, limit, **k: short, use_enabled=lambda use: True, provider=lambda: {'id': 'zhipu'})
        self.spawned = []
        with patch.object(dispatch, '_mod', side_effect=lambda n: fake if n == 'summarize' else MagicMock()), \
             patch.object(dispatch, 'begin_warnings', return_value=[]), patch.object(dispatch, 'local_host_name', return_value='test'), \
             patch.object(dispatch, 'out'), patch.object(dispatch, 'phone_push') as push, \
             patch.object(dispatch.P, 'spawn_detached', side_effect=lambda argv, **k: self.spawned.append(argv)), \
             patch.object(dispatch, 'bd_json', side_effect=[{'id': 'task-test'}, {}]) as bd, contextlib.redirect_stderr(io.StringIO()):
            dispatch.cmd_begin(a)
        return bd.call_args_list[0].args[0][1], a.desc, push

    def test_long_title_makes_the_task_at_once_and_is_summarized_in_the_background(self):
        # the model never holds the command up (over 20 s on the build Mac, 10-02): the task is made with the plain
        # cut, and `dispatch title-summary` starts on its own to put the model's few words in
        full = "Assistant 一眼看全所有电脑上的会话和任务，并能在会话之间转话：不用再截图转述给别的会话"
        title, desc, push = self._begin(full, "Assistant 看全会话并转话：不用截图")
        self.assertEqual(title, dispatch.trim_title(full)[0])
        self.assertIn(full, desc)
        push.assert_not_called()  # a plain task is not "only you can do"
        self.assertEqual(len(self.spawned), 1)
        argv = self.spawned[0]
        self.assertEqual(argv[2:5], ["title-summary", "task-test", "--was"])
        self.assertEqual(argv[5], title)
        self.assertEqual(argv[-1], full)

    def test_title_summary_renames_only_a_task_still_on_the_cut(self):
        from types import SimpleNamespace
        fake = types.SimpleNamespace(short_title=lambda full, limit, **k: "看全会话并转话")
        a = SimpleNamespace(id="task-test", was="Assistant 一眼看全所有电脑上的会话", full=["Assistant", "一眼看全…"], timeout=1)
        with patch.object(dispatch, '_mod', return_value=fake), patch.object(dispatch, 'bd_json', side_effect=[{"title": a.was}, {}]) as bd:
            dispatch.cmd_title_summary(a)
        self.assertEqual(bd.call_args_list[1].args[0][:4], ["update", "task-test", "--title", "看全会话并转话"])
        # renamed in the meantime: left as it is
        with patch.object(dispatch, '_mod', return_value=fake), patch.object(dispatch, 'bd_json', side_effect=[{"title": "我自己起的名"}]) as bd:
            dispatch.cmd_title_summary(a)
        self.assertEqual(len(bd.call_args_list), 1)

    def test_a_cut_that_loses_the_why_still_creates_the_task(self):
        full = "Agents 窗口内置终端，TUI 的 Agent 和图形会话并列，导入 Ghostty 配置：GUI 和 TUI 用户都能用"
        title, desc, _ = self._begin(full, "")  # no model: plain cut, which drops the part after the colon
        self.assertLessEqual(len(title), dispatch.TITLE_MAX)
        self.assertIn(full, desc)

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
        with patch.object(dispatch, "_retitle_later", return_value=False), patch.object(dispatch, "begin_warnings", return_value=[]), patch.object(dispatch, "local_host_name", return_value="t"), patch.object(dispatch, "out"), \
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
    DOC = "# 常用信息\n\n> 说明\n\n## 通用\n\n- 机器 A\n\n## readerapp（ReDraft · 重写）\n\n- 域名 readerapp.app\n\n## ReadAloud\n\n- 手机阅读\n\n## 空节\n"

    def test_key_is_first_word_lowercased(self):
        self.assertEqual(dispatch.facts_key("readerapp（ReDraft · 重写）"), "readerapp")
        self.assertEqual(dispatch.facts_key("ReadAloud"), "readaloud")
        self.assertEqual(dispatch.facts_key("通用"), "通用")

    def test_project_gets_general_plus_its_own_section_only(self):
        picked = dispatch.facts_for("Readerapp", self.DOC)
        self.assertEqual([h for h, _ in picked], ["通用", "readerapp（ReDraft · 重写）"])
        self.assertIn("readerapp.app", picked[1][1])

    def test_no_project_gets_general_only_and_empty_sections_are_dropped(self):
        self.assertEqual([h for h, _ in dispatch.facts_for("", self.DOC)], ["通用"])
        self.assertEqual([h for h, _ in dispatch.facts_for("空节", self.DOC)], ["通用"])

    PROJECT_DOC = "# TUTOR 常用信息\n\n## 服务器\n\n**Lakenet Managed AI**\n- 入口 https://ai.lakenet.example\n- 首次登录用「Passwort vergessen」\n\n## 联系人\n\n**学院 IT**\n- Meyer\n"

    def test_project_file_sections_come_after_the_general_ones(self):
        picked = dispatch.facts_for("tutor", self.DOC, self.PROJECT_DOC)
        self.assertEqual([h for h, _ in picked], ["通用", "服务器", "联系人"])
        hits = dispatch.facts_get("lakenet", "tutor", self.DOC, self.PROJECT_DOC)
        self.assertEqual([(h, t) for h, t, _ in hits], [("服务器", "Lakenet Managed AI")])
        self.assertIn("Passwort vergessen", hits[0][2])
        # another project never sees it; giving only the global text reads no project file
        self.assertEqual([h for h, _ in dispatch.facts_for("readerapp", self.DOC, self.PROJECT_DOC)], ["通用", "readerapp（ReDraft · 重写）", "服务器", "联系人"][:2] + ["服务器", "联系人"])
        self.assertEqual([h for h, _ in dispatch.facts_for("tutor", self.DOC)], ["通用"])

    def test_project_facts_path_follows_project_home(self):
        with patch.object(dispatch, "project_home", return_value="/tmp/proj"):
            self.assertEqual(dispatch.facts_project_path("tutor"), os.path.join("/tmp/proj", "FACTS.md"))
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

    def test_settings_parse_keeps_list_density(self):
        self.assertEqual(dispatch.settings_parse(json.dumps({"list_density": " compact "})), {"list_density": "compact"})
        self.assertEqual(dispatch.SETTING_DEFAULTS["list_density"], "comfortable")

    def test_starred_sessions_of_project(self):
        idx = {"/a": {"agent": "claude-code", "session_id": "aaaa1111", "cwd": "/Users/x/Projects/kanban/app", "title": "长线", "mtime": 5},
               "/b": {"agent": "codex", "session_id": "bbbb2222", "cwd": "/Users/x/Projects/other", "title": "别的", "mtime": 9},
               "/c": {"agent": "codex", "session_id": "cccc3333", "cwd": "/Users/x/Projects/kanban", "title": "归档了", "mtime": 9}}
        prefs = {"claude-code:aaaa1111": {"starred": True}, "codex:bbbb2222": {"starred": True}, "codex:cccc3333": {"starred": True, "archived": True}}
        # No board round-trips: project folders and workspace roots come from bd otherwise.
        with patch.object(dispatch, "_PROJECT_DIRS", {}), patch.object(dispatch, "workspace_project", lambda cwd, roots=None: ""):
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

    def test_discuss_members_from_repeated_with(self):
        self.assertEqual(dispatch.discuss_parts(["claude:haiku", "codex"]), [("claude", "haiku"), ("codex", "")])
        self.assertEqual(dispatch.discuss_parts("claude:opus,codex"), [("claude", "opus"), ("codex", "")])

    def test_discuss_on_another_mac_does_not_call_a_member_silent_before_board_sync(self):
        """--host: members write on that Mac's board; their statements reach this board with the next sync."""
        a = types.SimpleNamespace(task="t-1", with_=["codex"], leader="", topic="", project="", question="q", cwd="/p", host="mini", tui=False,
                                  rounds=1, timeout=60000, fresh=False, everyone=True, close=False, conclude=False, json=True, image=None, create_only=False)
        calls = []

        def sh(argv, **kw):
            calls.append(argv)
            return (0, '{"pane_id": "codex:x", "status": "idle"}', "") if "agent" in argv else (0, "", "")
        with patch.object(dispatch, "bd_json", return_value={"id": "t-1", "title": "T", "labels": []}), patch.object(dispatch, "bd_comments", return_value=[]), \
             patch.object(dispatch, "sh", side_effect=sh), patch.object(dispatch, "whoami", return_value="me"), patch.object(dispatch, "discussion_state_load", return_value={}), \
             patch.object(dispatch, "discussion_leader", return_value=("", "")), patch.object(dispatch.time, "sleep"), patch("notify.send"), contextlib.redirect_stdout(io.StringIO()) as o:
            dispatch.cmd_discuss(a)
        self.assertEqual(json.loads(o.getvalue())["missing"], [])
        self.assertFalse(any("【系统】" in " ".join(c) for c in calls))

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
        __import__('engines.codex', fromlist=['x']).parse_stats(e, "\n".join(lines), dispatch.re.compile(r'"timestamp":"([^"]+)"'))
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
        self.assertTrue(P.is_link(os.path.join(self.dirs["claude"][0], "demo-skill")))  # a junction on Windows
        self.assertFalse(os.path.exists(os.path.join(self.dirs["codex"][0], "demo-skill")))

    def test_all_mounts_both_agents(self):
        res = self.call(op="new", name="both", description="", trigger=None, constraint=None, agent=["all"])
        self.assertEqual(sorted(res["agents"]), ["claude", "codex"])
        self.assertTrue(P.is_link(os.path.join(self.dirs["codex"][0], "both")))

    def test_existing_name_refused(self):
        self.call(op="new", name="dup", description="", trigger=None, constraint=None, agent=[])
        with self.assertRaises(SystemExit):
            self.call(op="new", name="dup", description="", trigger=None, constraint=None, agent=[])


class SkillsOpenCode(SkillPoolBase):
    """OpenCode reads its own skills folder, Claude Code's and the shared ~/.agents one."""

    def setUp(self):
        super().setUp()
        self.dirs["opencode"] = [os.path.join(self.tmp, "opencode"), self.dirs["claude"][0], os.path.join(self.tmp, "agents")]

    def text(self, **kw):
        a = types.SimpleNamespace(op=kw.pop("op"), json=False, **kw)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            dispatch.cmd_skills(a)
        return buf.getvalue()

    def test_a_skill_claude_code_has_is_already_there_for_opencode(self):
        res = self.call(op="new", name="shared", description="", trigger=None, constraint=None, agent=["claude", "opencode"])
        claude_link = os.path.join(self.dirs["claude"][0], "shared")
        self.assertTrue(P.is_link(claude_link))
        self.assertFalse(os.path.lexists(os.path.join(self.dirs["opencode"][0], "shared")))  # no second link
        self.assertEqual(sorted(res["agents"]), ["claude", "opencode"])
        self.assertIn("opencode: already enabled", self.text(op="enable", name="shared", agent=["opencode"]))

    def test_opencode_alone_gets_its_own_link_and_can_drop_it(self):
        self.call(op="new", name="mine", description="", trigger=None, constraint=None, agent=[])
        self.text(op="enable", name="mine", agent=["opencode"])
        own = os.path.join(self.dirs["opencode"][0], "mine")
        self.assertTrue(P.is_link(own))
        self.assertFalse(os.path.lexists(os.path.join(self.dirs["claude"][0], "mine")))
        self.assertIn("disabled", self.text(op="disable", name="mine", agent=["opencode"]))
        self.assertFalse(os.path.lexists(own))

    def test_parser_reaches_enable_and_install_for_every_registered_engine(self):
        import engines
        future = engines.Engine(id="future", package="future-cli", skills=("{home}/future/skills",))
        with patch.object(engines, "managed", lambda real=engines.managed: real() + [future]):
            dirs = engines.skill_dirs(self.tmp, {})
        with patch.object(dispatch, "AGENT_SKILL_DIRS", dirs), patch.object(dispatch, "cmd_skills") as command:
            for agent in dirs:
                for op, name in (("enable", "demo"), ("install", "owner/repo")):
                    with self.subTest(agent=agent, op=op), patch.object(sys, "argv", ["dispatch", "skills", op, name, "--agent", agent]):
                        dispatch._main()
                    self.assertEqual(command.call_args.args[0].agent, [agent])

    def test_install_through_parser_mounts_into_opencode_only(self):
        root = os.path.join(self.tmp, "repo")
        os.makedirs(root)
        with open(os.path.join(root, "SKILL.md"), "w") as f:
            f.write("---\nname: demo\ndescription: test\n---\nTest skill\n")
        argv = ["dispatch", "skills", "install", "owner/repo", "--as", "demo", "--agent", "opencode", "--json"]
        with patch.object(sys, "argv", argv), patch.object(dispatch, "download_repo", return_value=(root, "main", os.path.join(self.tmp, "dl"))), contextlib.redirect_stdout(io.StringIO()):
            dispatch._main()
        own = os.path.join(self.dirs["opencode"][0], "demo")
        self.assertTrue(P.is_link(own))
        self.assertTrue(os.path.isfile(os.path.join(own, "SKILL.md")))
        self.assertFalse(os.path.lexists(os.path.join(self.dirs["claude"][0], "demo")))

    def test_disabling_for_opencode_leaves_claude_codes_link(self):
        self.call(op="new", name="shared", description="", trigger=None, constraint=None, agent=["claude"])
        out = self.text(op="disable", name="shared", agent=["opencode"])
        self.assertIn("unchanged", out)
        self.assertTrue(P.is_link(os.path.join(self.dirs["claude"][0], "shared")))


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
        self.assertTrue(P.is_link(os.path.join(self.dirs["codex"][0], "imported-thing")))
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
        self._env = (self.sd.ENV_DIR, self.sd.ENV_FILE, self.sd.ENV_FISH, self.sd.ENV_SH, self.sd.ENV_KNOWN)
        self.sd.ENV_KNOWN = os.path.join(self.tmp, "env-names.json")
        self.sd.DISPATCH_DIR = self.ddir
        # The person switched the summaries on (first-run 「模型与总结」); out of the box they are off.
        self.ALL_ON = {"summary_auto": 1, "summary_uses": {k: 1 for k, _, _, _ in summarize.SUMMARY_USES}}
        self.patch_settings = patch.object(self.sd, "settings_load", return_value=dict(self.ALL_ON))
        self.patch_settings.start()

    def tearDown(self):
        self.patch_settings.stop()
        self.sd.DISPATCH_DIR = self._ddir
        self.sd.ENV_DIR, self.sd.ENV_FILE, self.sd.ENV_FISH, self.sd.ENV_SH, self.sd.ENV_KNOWN = self._env
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
        with patch.object(dispatch, "settings_load", return_value=dict(dispatch.SETTING_DEFAULTS)), patch.object(dispatch, "settings_raw", return_value={}), \
             patch.object(dispatch, "wiki_store", side_effect=lambda k, v: saved.update({k: v})), \
             contextlib.redirect_stdout(io.StringIO()):
            dispatch.cmd_settings(types.SimpleNamespace(key="summary_uses", value='{"session": 0}', json=False))
        self.assertEqual(json.loads(saved[dispatch.SETTINGS_KEY])["summary_uses"], {"session": 0})

    def test_gated_memory_summary_skips_the_model(self):
        with patch.object(self.sd, "settings_load", return_value={"summary_uses": {"memories": 0}}), \
             patch.object(self.summarize, "provider") as prov, patch.object(self.summarize, "chat") as chat:
            with self.assertRaises(RuntimeError) as cm:
                memories.memory_summary()
        self.assertIn("disabled", str(cm.exception))
        prov.assert_not_called()
        chat.assert_not_called()

    def test_gated_project_summary_reports_skipped(self):
        with patch.object(self.sd, "settings_load", return_value={"summary_uses": {"project": 0}}):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                dispatch.cmd_project_summary(types.SimpleNamespace(name="x", force=False, if_stale=False, json=True))
        res = json.loads(buf.getvalue())
        self.assertTrue(res["skipped"])
        self.assertIn("disabled", res["reason"])

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
            self.sd.ENV_SH = os.path.join(d, "env.sh")
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
        self.assertEqual(len(rows), 10)
        self.assertIn("session_name", by)
        self.assertNotIn("check", by)
        self.assertEqual(by["session"]["last"], {"at": 1700000000, "tokens": 42, "model": "zhipu:glm-5.3-flash"})
        self.assertTrue(by["session"]["enabled"])
        self.assertIsNone(by["project"]["last"])

    def test_project_material_for_unassigned_reads_sessions_and_tasks_outside_every_project(self):
        """未分项目 (the 脉络 board for work nobody gave a project) has material: sessions in folders
        that are no project (not headless probes), tasks without a project label."""
        import activity
        idx = {
            "a": {"agent": "claude", "session_id": "a", "cwd": "/tmp/x", "user_msgs": 3, "title": "查 tmp", "entrypoint": "cli", "mtime": 100},
            "b": {"agent": "claude", "session_id": "b", "cwd": "/tmp/x", "user_msgs": 1, "title": "", "entrypoint": "sdk-cli", "mtime": 101},
            "c": {"agent": "claude", "session_id": "c", "cwd": "/p/kanban", "user_msgs": 3, "title": "kanban 的事", "entrypoint": "cli", "mtime": 102},
        }
        tasks = [{"title": "无主任务", "status": "open", "labels": []}, {"title": "kanban 任务", "status": "open", "labels": ["project:kanban"]}]
        with patch.object(self.sd, "load_index", return_value=idx), patch.object(self.sd, "project_names", return_value=["kanban"]), \
             patch.object(self.sd, "settings_load", return_value={}), \
             patch.object(self.sd, "project_of_cwd", side_effect=lambda cwd, *a: "kanban" if cwd.startswith("/p/kanban") else ""), \
             patch.object(self.sd, "sh", return_value=(0, json.dumps(tasks), "")), \
             patch.object(activity, "session_preferences", return_value={}):
            m = self.summarize.project_material("未分项目")
            k = self.summarize.project_material("kanban")
        self.assertEqual((m["sessions"], m["open"]), (1, 1))
        self.assertIn("查 tmp", m["text"])
        self.assertIn("无主任务", m["text"])
        self.assertNotIn("kanban 任务", m["text"])
        self.assertEqual((k["sessions"], k["open"]), (1, 1))

    def test_project_summary_untrusted_local_cache_is_replaced_by_a_trusted_remote_answer(self):
        """The mini scenario, verified on device: `bd memories` is NOT shared between the two
        Macs, so a bad summary the mini generated blind (no directory, no sessions) sits under
        its own copy of the key forever unless something replaces it. With no local material and
        no trust marker on its own cached copy, ask the other Mac for ITS summary and adopt (and
        store) that one instead — never keep serving the blind guess."""
        bad_local = {"summary": "Codex 是一个桌面端和手机端的会话与项目管理应用……", "at": int(time.time()) - 3600, "by": "claude:haiku", "sessions": 0, "open": 3, "closed": 1}
        good_remote = {"summary": "kanban 是任务管理与项目追踪系统……", "at": int(time.time()) - 90000, "by": "claude:haiku", "sessions": 68, "open": 32, "closed": 138, "trusted": True, "material_sessions": 68, "cached": True}
        key = dispatch.INTERNAL_MEMORY_PREFIX + "project-summary-kanban"
        host = {"id": "hub", "name": "阁楼的 Mac", "ssh": "hub"}
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
        host = {"id": "hub", "name": "阁楼的 Mac", "ssh": "hub"}
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
        hub = {"id": "hub", "name": "阁楼的 Mac", "ssh": "hub"}
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
        with patch.object(self.sd, "hosts", return_value=[{"id": "hub", "name": "阁楼的 Mac", "ssh": "hub"}]), \
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

    def test_a_short_wait_answers_before_a_long_refresh_ends_and_says_it_is_pending(self):
        # History of another Mac: the page waits `wait`, the refresh goes on for `timeout` (it is told so)
        clock = _StepClock()
        with patch("subprocess.Popen") as pop, \
             patch("subprocess.run", side_effect=AssertionError("ssh 不该在前台跑")), \
             patch("time.time", side_effect=clock), patch("time.sleep", return_value=None):
            self.assertIsNone(dispatch.remote_dispatch(self.h, self.args, 30, timeout=45, background=True, wait=2))
            waited = clock() - 1000.0
        self.assertLess(waited, 30)  # well before the 45 s the refresh may take
        self.assertIn("45", pop.call_args[0][0])  # the detached refresh keeps its own longer limit
        self.assertTrue(dispatch.remote_pending(self.h, self.args))

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
            self.assertEqual(__import__('engines.codex', fromlist=['x']).meta_origin(f.name), "vscode")
        finally:
            os.unlink(f.name)
        self.assertEqual(__import__('engines.codex', fromlist=['x']).meta_origin("/nonexistent/rollout.jsonl"), "")

    @mac
    def test_bare_process_under_vscode_is_an_editor_session(self):
        # presence.py keeps its own IS_WIN, read once at import: flip it too, or Windows runs its classifier.
        with patch.object(dispatch._mod("presence"), "IS_WIN", False):
            self._bare_process_under_vscode()

    def _bare_process_under_vscode(self):
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

    def test_a_registered_folder_wins_over_the_workspace_folder_name(self):
        # ~/Projects/Quillbench registered as "ALG" (or renamed with `projects-view rename --key`): ALG, as in the sidebar
        with patch.object(dispatch, "_PROJECT_DIRS", {"alg": "/Users/x/Projects/Quillbench", "outer": "/Users/x/Projects/outer"}), \
             patch.object(dispatch, "project_dir_names", lambda: {"alg": "ALG", "outer": "outer"}):
            roots = ["/Users/x/Projects"]
            self.assertEqual(dispatch.project_of_cwd("/Users/x/Projects/Quillbench/units", {}, roots), "ALG")
            self.assertEqual(dispatch.project_of_cwd("/Users/x/Projects/other/src", {}, roots), "other")
            self.assertEqual(dispatch.project_of_cwd("/Users/x/Projects/Quillbench-wt/b", {}, roots), "ALG")


class MissingToolsAndBoard(unittest.TestCase):
    """A Mac without bd / herdr / a board gets one readable line, never a traceback (review P0-3, P0-4)."""

    def test_sh_turns_a_missing_command_into_a_hint(self):
        with patch.object(dispatch.subprocess, "run", side_effect=FileNotFoundError(2, "No such file", "bd")), \
             patch.object(P, "IS_WIN", False):
            code, out_, err = dispatch.sh(["bd", "list"])
        self.assertEqual(code, 127); self.assertEqual(out_, "")
        self.assertIn("Command bd not found", err); self.assertIn("brew install beads", err)

    @win
    def test_windows_hint_is_winget(self):
        with patch.object(dispatch.subprocess, "run", side_effect=FileNotFoundError(2, "No such file", "bd")), \
             patch.object(P, "which", return_value=None):
            code, _, err = dispatch.sh(["bd", "list"])
        self.assertEqual(code, 127)
        self.assertIn("Command bd not found", err); self.assertIn("winget install GasTownHall.Beads", err)
        self.assertNotIn("brew", dispatch.missing_tool_hint("C:\\x\\git.exe"))

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
        for is_win in (False, True):
            seen, fed = {}, []

            class Proc:
                stdout = iter(()); returncode = 0
                class stderr:
                    @staticmethod
                    def read(): return b""
                class stdin:
                    @staticmethod
                    def write(b): fed.append(b)
                    @staticmethod
                    def close(): pass
                def wait(self, timeout=None): return 0
                def kill(self): pass
            with self.subTest(is_win=is_win), tempfile.TemporaryDirectory() as tmp, patch.object(dispatch, "DISPATCH_DIR", tmp), \
                 patch.object(P, "IS_WIN", is_win), patch.object(P, "which", return_value=None), \
                 patch.object(dispatch.subprocess, "Popen", side_effect=lambda argv, **k: seen.update(argv=argv, **k) or Proc()):
                dispatch.headless_call("codex", "gpt-x", "PROMPT TEXT", tmp, 60000, images=("/a.png", "/b.png"))
                argv = seen["argv"]
                # Windows: the prompt goes in on stdin ("-"), a .cmd shim would mangle it as an argument
                word = "-" if is_win else "PROMPT TEXT"
                self.assertLess(argv.index(word), argv.index("-i"))
                self.assertEqual(argv[-4:], ["-i", "/a.png", "-i", "/b.png"])
                if is_win:
                    time.sleep(0.05)
                    self.assertEqual(seen["stdin"], subprocess.PIPE)
                    self.assertEqual(fed, ["PROMPT TEXT".encode("utf-8")])
                    self.assertNotIn("PROMPT TEXT", argv)


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
            self.assertEqual(dispatch.beads_dir_portable(), os.path.abspath("/Volumes/Data/.beads"))


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


class WindowsBranches(unittest.TestCase):
    """The native-Windows branches of dispatch.py, run on any OS by flipping dplatform.IS_WIN."""

    def test_local_host_name_falls_back_without_os_uname(self):
        with tempfile.TemporaryDirectory() as d, \
             patch.object(dispatch, "SELF_NAME_FILE", os.path.join(d, "none.json")), \
             patch.object(dispatch, "_LOCAL_NAME", None), \
             patch.object(P, "IS_WIN", True), \
             patch.dict(os.environ, {"COMPUTERNAME": "DESKTOP-42"}), \
             patch.object(P.subprocess, "run", side_effect=AssertionError("no scutil on Windows")), \
             patch.object(dispatch.os, "uname", side_effect=AssertionError("no os.uname on Windows"), create=True):
            self.assertEqual(dispatch.local_host_name(), "DESKTOP-42")
            self.assertEqual(dispatch.local_host_aliases(), [])

    def test_child_env_joins_path_with_the_os_separator(self):
        path = dispatch.child_env()["PATH"]
        self.assertTrue(path.startswith(dispatch.PATH_EXTRA + os.pathsep))
        self.assertEqual(dispatch.PATH_EXTRA, os.pathsep.join(P.extra_bin_dirs()))

    @win
    def test_windows_sh_resolves_the_program_and_hides_the_console(self):
        seen = {}

        def run(args, **kw):
            seen.update(args=args, **kw)
            return subprocess.CompletedProcess(args, 0, b"ok", b"")
        with patch.object(P, "which", return_value="C:\\npm\\codex.cmd"), patch.object(dispatch.subprocess, "run", side_effect=run):
            self.assertEqual(dispatch._sh_once(["codex", "--version"])[1], "ok")
        self.assertEqual(seen["args"], ["C:\\npm\\codex.cmd", "--version"])
        self.assertEqual(seen["creationflags"], P.no_window_flags())
        self.assertTrue(seen["env"]["PATH"].startswith(P.extra_bin_dirs()[0] + ";"))  # Windows PATH, ';'-joined

    @win
    def test_skills_enable_mounts_a_junction_and_disable_removes_it(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as d:
            pool, mount = os.path.join(d, "pool"), os.path.join(d, "claude-skills")
            os.makedirs(os.path.join(pool, "demo"))
            with open(os.path.join(pool, "demo", "SKILL.md"), "w", encoding="utf-8") as f:
                f.write("---\nname: demo\ndescription: 演示\n---\n")
            links = []
            with patch.object(dispatch, "POOL", pool), patch.object(dispatch, "AGENT_SKILL_DIRS", {"claude": [mount]}), \
                 patch.object(dispatch, "skill_usage", return_value=({}, {})), \
                 patch.object(dispatch, "cc_switch_flag"), \
                 patch.object(P, "mount_link", side_effect=lambda src, link: (links.append((src, link)), os.makedirs(link))) as ml, \
                 patch.object(P, "is_link", side_effect=lambda p: any(l == p for _, l in links)), \
                 patch.object(P, "unlink_link", side_effect=lambda p: os.rmdir(p)) as ul:
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    dispatch.cmd_skills(SimpleNamespace(op="enable", name="demo", agent=["claude"], file=None, json=False, query=None))
                ml.assert_called_once_with(os.path.join(pool, "demo"), os.path.join(mount, "demo"))
                with contextlib.redirect_stdout(buf):
                    dispatch.cmd_skills(SimpleNamespace(op="disable", name="demo", agent=["claude"], file=None, json=False, query=None))
                ul.assert_called_once_with(os.path.join(mount, "demo"))
                self.assertTrue(os.path.isdir(os.path.join(pool, "demo")))  # the skill itself stays

    @win
    def test_host_app_of_uses_the_windows_exe_table(self):
        local = "C:\\Users\\x\\AppData\\Local"
        table = {40: (30, "C:\\Users\\x\\.local\\bin\\claude.exe"), 30: (20, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
                 20: (10, "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.21\\WindowsTerminal.exe"), 10: (4, "C:\\Windows\\explorer.exe")}
        self.assertEqual(dispatch.host_app_of(40, table), "Windows Terminal")
        self.assertEqual(dispatch.host_of(40, table), ("terminal", "Windows Terminal"))
        vs = {50: (51, "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.exe"), 51: (52, "C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"), 52: (0, "explorer.exe")}
        self.assertEqual(dispatch.host_of(50, vs), ("editor", "VS Code"))
        desk = {60: (61, "C:\\x\\claude.exe"), 61: (0, local + "\\AnthropicClaude\\app-1.0\\claude.exe")}
        self.assertEqual(dispatch.host_of(60, desk), ("desktop", "Claude 桌面端"))
        # the CLI's own claude.exe is not the desktop app, and a bare console has no host
        self.assertIsNone(dispatch.win_host_label("C:\\Users\\x\\.local\\bin\\claude.exe"))
        self.assertIsNone(dispatch.win_host_label("C:\\Users\\x\\AppData\\Roaming\\npm\\codex.exe"))
        self.assertEqual(dispatch.host_of(1, {1: (2, "claude.exe"), 2: (0, "cmd.exe")}), ("unknown", "未登记"))


    @win
    def test_npm_shim_runs_through_cmd(self):
        with patch.object(P, "which", return_value="C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd"):
            self.assertEqual(dispatch.win_console_argv(["codex", "--model", "m"]), ["cmd", "/c", "C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd", "--model", "m"])

    @win
    def test_bare_node_agent_is_discovered_from_its_command_line(self):
        table = {70: (71, "C:\\Program Files\\nodejs\\node.exe"), 71: (72, "C:\\Windows\\System32\\cmd.exe"), 72: (0, "C:\\wt\\WindowsTerminal.exe")}
        cmd = {70: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'}
        with tempfile.TemporaryDirectory() as d, patch.object(dispatch, "SESS_DIR", d), patch.object(dispatch, "ps_table", return_value=table), \
             patch.object(P, "process_cmdlines", return_value=cmd), patch.object(dispatch, "store_live", return_value=[]), \
             patch.object(__import__("engines.hermes", fromlist=["x"]), "live", return_value=[]), patch.object(dispatch, "merge_ide_sessions", lambda s: None), \
             patch.object(dispatch, "load_index", return_value={}), patch.object(dispatch, "local_host_name", return_value="PC"):
            rows = dispatch.live_sessions(local_only=True)
        self.assertEqual([(r["agent"], r["agent_pid"], r["source_app"], r["cwd"]) for r in rows], [("claude-code", 70, "Windows Terminal", "")])

    def test_project_flags_accept_windows_folders_and_keep_mac_ones(self):
        flags = dispatch.project_flags_parse(json.dumps({"pc": {"dir": "C:\\Users\\x\\proj\\"}, "mac": {"dir": "/Users/x/p/"}, "rel": {"dir": "p"}}))
        self.assertEqual(flags["pc"], {"dir": "C:\\Users\\x\\proj"})
        self.assertEqual(flags["mac"], {"dir": "/Users/x/p"})
        self.assertNotIn("rel", flags)

    def test_image_paths_on_a_drive_are_found(self):
        self.assertEqual(dispatch.IMG_RE.findall("看这张 C:/Users/x/shot.png 和 D:\\a\\b.JPG 还有 /tmp/c.gif"), ["C:/Users/x/shot.png", "D:\\a\\b.JPG", "/tmp/c.gif"])

    @win
    def test_json_paths_use_forward_slashes(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            dispatch.out([{"cwd": "C:\\Users\\x\\proj", "transcript_path": "C:\\t\\a.jsonl", "title": "a\\b", "n": 1}], True, None)
        self.assertEqual(json.loads(buf.getvalue()), [{"cwd": "C:/Users/x/proj", "transcript_path": "C:/t/a.jsonl", "title": "a\\b", "n": 1}])

    @mac
    def test_json_paths_unchanged_on_macos(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            dispatch.out({"cwd": "/Users/x/a\\b"}, True, None)
        self.assertEqual(json.loads(buf.getvalue()), {"cwd": "/Users/x/a\\b"})

    def test_chinese_json_round_trips_as_utf8(self):
        with tempfile.TemporaryDirectory() as d, patch.object(dispatch, "DISPATCH_DIR", d), \
             patch.object(dispatch, "INDEX_FILE", os.path.join(d, "transcript-index.json")):
            dispatch.save_index({"p": {"agent": "codex", "title": "修复任务板：中文标题"}})
            with open(dispatch.INDEX_FILE, "rb") as f:
                self.assertIn("中文标题".encode("utf-8"), f.read())
            self.assertEqual(dispatch.load_index()["p"]["title"], "修复任务板：中文标题")

    @win
    def test_windows_prime_cwd_from_git_bash_and_beads_dir(self):
        self.assertEqual(P.from_msys("/c/Users/x/proj"), "C:\\Users\\x\\proj")
        with patch.object(dispatch, "HOME", "C:\\Users\\me"), patch.object(dispatch, "BEADS_DIR", "C:\\Users\\me\\tasks\\.beads"), \
             patch.object(dispatch.os.path, "abspath", side_effect=lambda p: p):
            self.assertEqual(dispatch.beads_dir_portable(), "~/tasks/.beads")

    @win
    def test_windows_cwd_keys_ignore_case_and_separators(self):
        self.assertEqual(dispatch.cwd_key("C:\\Users\\X\\Proj\\"), dispatch.cwd_key("c:/users/x/proj"))

    @win
    def test_unsupported_command_json_and_text(self):
        for argv, code in ((["dispatch", "moves", "mark", "claude-code:s", "--to", "mini", "--json"], 0), (["dispatch", "notify-watch"], 2)):
            out_, err_ = io.StringIO(), io.StringIO()
            with patch.object(sys, "argv", argv), contextlib.redirect_stdout(out_), contextlib.redirect_stderr(err_), \
                 self.assertRaises(SystemExit) as ex:
                dispatch.main()
            self.assertEqual(ex.exception.code, code)
            if code == 0:
                self.assertEqual(json.loads(out_.getvalue()), {"ok": False, "unsupported": True, "message": "Windows 版暂不支持多机会话迁移记录，这一功能目前只在 Mac 上可用"})
            else:
                self.assertIn("Windows 版暂不支持", err_.getvalue())
                self.assertEqual(out_.getvalue(), "")

    @win
    def test_move_listings_are_empty_lists_on_windows(self):
        # The app polls `project-moves --json` and calls .some() on the answer: an object blanked the page.
        for argv in (["dispatch", "project-moves", "--json"], ["dispatch", "moves", "--json"], ["dispatch", "moves", "list", "--json"]):
            out_ = io.StringIO()
            with patch.object(sys, "argv", argv), contextlib.redirect_stdout(out_):
                dispatch.main()
            self.assertEqual(json.loads(out_.getvalue()), [], argv)
        out_ = io.StringIO()
        with patch.object(sys, "argv", ["dispatch", "project-moves"]), contextlib.redirect_stdout(out_):
            dispatch.main()
        self.assertIn("Windows 版暂不支持项目迁移", out_.getvalue())

    @win
    def test_zcode_resume_is_unsupported(self):
        from types import SimpleNamespace
        ref = {"agent": "zcode", "session_id": "s", "resume_cmd": "#"}
        with patch.object(dispatch, "refs_everywhere", return_value=[("local", "PC", ref)]), self.assertRaises(P.Unsupported):
            dispatch.cmd_resume(SimpleNamespace(key="s", copy=False, on=""))

    @win
    def test_claude_token_comes_from_the_credentials_file(self):
        from engines import claude as C
        with tempfile.TemporaryDirectory() as d:
            cred = os.path.join(d, ".credentials.json")
            with open(cred, "w", encoding="utf-8") as f:
                json.dump({"claudeAiOauth": {"accessToken": "tok", "expiresAt": (time.time() + 3600) * 1000}}, f)
            with patch.object(P, "CLAUDE_CREDENTIALS", cred):
                self.assertEqual(C.oauth_token(), "tok")
            with patch.object(P, "CLAUDE_CREDENTIALS", os.path.join(d, "missing.json")):
                self.assertIsNone(C.oauth_token())


# ---------------------------------------------------------------- acceptance: claim / verify / waive / done gate


class FakeBoard:
    """A task and its comments in memory, answering the bd calls dispatch and checker make."""

    def __init__(self, ac, labels=None, comments=None, tid="task-t1", mode=""):
        self.settings = {"check_mode": mode} if mode else {}
        self.issue = {"id": tid, "title": "冒烟", "status": "in_progress", "labels": list(labels or ["project:kanban"]), "acceptance_criteria": ac}
        self.comments = list(comments or [])
        self.calls = []

    def bd_json(self, argv):
        self.calls.append(("bd_json", list(argv)))
        if argv[0] == "show":
            return json.loads(json.dumps(self.issue))
        if argv[0] == "update":
            if "--acceptance" in argv:
                self.issue["acceptance_criteria"] = argv[argv.index("--acceptance") + 1]
            if "--add-label" in argv:
                self.issue["labels"].append(argv[argv.index("--add-label") + 1])
            return self.issue
        if argv[0] == "close":
            self.issue["status"] = "closed"
            return self.issue
        return {}

    def sh(self, args, timeout=20, env=None):
        self.calls.append(("sh", list(args), dict(env or {})))
        if args[:3] == ["bd", "comments", "add"]:
            self.comments.append({"id": len(self.comments) + 1, "text": args[4], "author": (env or {}).get("BEADS_ACTOR") or os.environ.get("BEADS_ACTOR", "u"), "created_at": f"2026-09-25T10:{len(self.comments):02d}:00Z"})
            return 0, "", ""
        if args[:2] == ["bd", "show"]:
            return 0, json.dumps([self.issue]), ""
        if args[:2] == ["bd", "memories"]:
            return 0, json.dumps({"dispatch-settings": json.dumps(self.settings)}), ""
        if args[:2] == ["bd", "remember"] and args[3:5] == ["--key", "dispatch-settings"]:
            self.settings = json.loads(args[2])
            return 0, "", ""
        if args[:2] == ["bd", "update"] and "--add-label" in args:
            self.issue["labels"].append(args[args.index("--add-label") + 1])
            return 0, "[]", ""
        return 0, "", ""

    def bd_comments(self, tid):
        return list(self.comments)

    def patches(self, env=None):
        stack = contextlib.ExitStack()
        # this file loads its own copy of dispatch.py; summarize imports the sys.modules one
        # so both answer from this board, never from a real bd
        for mod in {id(dispatch): dispatch, id(sys.modules.get("dispatch")): sys.modules.get("dispatch")}.values():
            if mod is None:
                continue
            stack.enter_context(patch.object(mod, "bd_json", side_effect=self.bd_json))
            stack.enter_context(patch.object(mod, "sh", side_effect=self.sh))
            stack.enter_context(patch.object(mod, "bd_comments", side_effect=self.bd_comments))
            stack.enter_context(patch.object(mod, "phone_push"))
        stack.enter_context(patch.dict(os.environ, env or {}))
        return stack


def check_args(**kw):
    base = dict(task="task-t1", items="", claim=None, waive=None, tick=False, untick=False, status=None, dry_run=False, auto=False, model="", days=30, limit=0, json=False, project="")
    base.update(kw)
    return types.SimpleNamespace(**base)


def as_person():
    return patch.object(dispatch, "caller_origin", return_value="person")


class AgentActor(unittest.TestCase):
    def test_nearest_agent_in_the_process_tree_signs(self):
        ppid = os.getppid()
        cases = ((("/usr/local/bin/opencode",), "opencode"), (("/Users/x/.local/bin/pi",), "pi"), (("/Users/x/.local/share/claude/versions/2.1.0",), "claude-code"),
                 (("/opt/homebrew/bin/gemini",), "gemini"), (("/opt/homebrew/bin/codex",), "codex"))
        for (comm,), want in cases:
            table = {ppid: (4242, "/bin/zsh"), 4242: (1, comm)}
            with patch.dict(os.environ, {"BEADS_ACTOR": "", "DISPATCH_ACTOR": "", "CLAUDECODE": "1"}):
                self.assertEqual(dispatch.agent_actor(table=table, records=[]), want, comm)

    def test_env_then_generic(self):
        with patch.object(dispatch, "agent_runtime", return_value=""):
            with patch.dict(os.environ, {"BEADS_ACTOR": "zcode"}):
                self.assertEqual(dispatch.agent_actor(), "zcode")
            with patch.dict(os.environ, {"BEADS_ACTOR": "", "DISPATCH_ACTOR": "", "CLAUDECODE": "", "CLAUDE_CODE_SESSION_ID": "", "CLAUDE_CODE_ENTRYPOINT": "", "CODEX_THREAD_ID": "", "CODEX_SANDBOX": "", "CODEX_MANAGED_BY_NPM": ""}):
                self.assertEqual(dispatch.agent_actor(), "agent")


class BeginWithTicks(unittest.TestCase):
    def begin_args(self, acceptance):
        return types.SimpleNamespace(title="验收门禁 加测试：防止绕过", project="kanban", type="task", priority=2, desc="触发原因和期望结果写在这里", acceptance=acceptance, deps=None, json=True, session=None, force=True)

    def test_agent_checklist_keeps_recorded_ticks(self):
        with patch.dict(os.environ, {"BEADS_ACTOR": "claude-code"}), patch.object(dispatch, "begin_warnings", return_value=[]), patch.object(dispatch, "local_host_name", return_value="m"), \
             patch.object(dispatch, "out"), patch.object(dispatch, "phone_push"), patch.object(dispatch, "bd_json", side_effect=[{"id": "task-b1"}, {}]) as bd, contextlib.redirect_stderr(io.StringIO()) as err:
            dispatch.cmd_begin(self.begin_args("- [x] item one\n  * [X] item two @dispatch-checker\n- [ ] three"))
        argv = bd.call_args_list[0].args[0]
        self.assertEqual(argv[argv.index("--acceptance") + 1], "- [x] item one\n  * [X] item two @dispatch-checker\n- [ ] three")
        self.assertNotIn("不能带已勾的验收项", err.getvalue())


class SessionLinking(unittest.TestCase):
    def test_env_order(self):
        with patch.dict(os.environ, {"CLAUDE_CODE_SESSION_ID": "claude-sess-1", "CODEX_THREAD_ID": "codex-thread-1"}):
            self.assertEqual(dispatch.session_self(), "codex-thread-1")
        with patch.dict(os.environ, {"DISPATCH_SESSION_ID": "bad id!"}), patch.object(dispatch, "presence_session", return_value=("", "")):
            self.assertEqual(dispatch.session_self(), "")

    def test_link_is_idempotent(self):
        b = FakeBoard("- [ ] a", labels=["project:kanban", "session:sess-abcdefgh"])
        with b.patches():
            self.assertEqual(dispatch.link_session("task-t1", sid="sess-abcdefgh"), "sess-abcdefgh")
            self.assertFalse(any(c[0] == "sh" and "--add-label" in c[1] for c in b.calls))
            dispatch.link_session("task-t1", sid="sess-new12345")
            dispatch.link_session("task-t1", sid="sess-new12345")
        self.assertEqual(b.issue["labels"].count("session:sess-new12345"), 1)

    def test_link_refuses_bad_ids(self):
        with patch.object(dispatch, "sh") as sh:
            self.assertEqual(dispatch.link_session("task-t1", sid="x,reviewed"), "")
        sh.assert_not_called()

    def test_hook_task_ids(self):
        self.assertEqual(dispatch.hook_task_ids('cd app && dispatch log task-ab1 "x"; bd update task-q12 --claim; bd update task-zz9 --status open'), ["task-ab1", "task-q12"])
        self.assertEqual(dispatch.hook_task_ids(["bash", "-lc", "dispatch check task-c3 2 --claim 'x'"]), ["task-c3"])
        self.assertEqual(dispatch.hook_task_ids("echo task-ab1"), [])
        # the verb inside a quoted argument is not a command on the task
        self.assertEqual(dispatch.hook_task_ids('grep -rn "dispatch log task-7nn" ~/.claude/projects'), [])
        self.assertEqual(dispatch.hook_task_ids('git commit -m "docs: explain bd update task-xyz --claim usage"'), [])
        self.assertEqual(dispatch.hook_task_ids("for s in a3cd2272 bf2fc6d6; do dispatch session $s; done"), [])
        self.assertEqual(dispatch.hook_task_ids('env -i HOME=/h python3 app/cli/dispatch.py check task-rz6 1 --claim "x"'), ["task-rz6"])
        self.assertEqual(dispatch.hook_task_ids("timeout 600 dispatch done task-dd4 --reason x"), ["task-dd4"])

    def test_hook_json_links_only_task_commands(self):
        with patch.object(dispatch, "link_session") as link, patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(json.dumps({"session_id": "sess-abcdefgh", "tool_input": {"command": "dispatch log task-ab1 'x'"}}).encode()))):
            dispatch.cmd_link(types.SimpleNamespace(task="", hook_json=True, session="", json=False))
        link.assert_called_once_with("task-ab1", sid="sess-abcdefgh")
        with patch.object(dispatch, "link_session") as link, patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(json.dumps({"session_id": "s", "tool_input": {"command": "ls"}}).encode()))):
            dispatch.cmd_link(types.SimpleNamespace(task="", hook_json=True, session="", json=False))
        link.assert_not_called()

    def test_index_claims_come_from_tool_calls_only(self):
        import re as _re
        rx = _re.compile(r"^task-[a-z0-9]{2,8}$")
        lines = [
            # this session read another one's transcript: the commands are in the tool's output
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": "for s in a3cd2272; do dispatch session $s; done"}}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "content": "bd update task-7nn --claim; dispatch log task-7nn x"}]}, "toolUseResult": {"stdout": "dispatch log task-7nn x"}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": "dispatch log task-ab1 'x'"}}]}},
            {"type": "response_item", "payload": {"type": "function_call", "name": "shell", "arguments": json.dumps({"command": ["bash", "-lc", "dispatch done task-cd2 --reason x"]})}},
            {"type": "response_item", "payload": {"type": "function_call_output", "output": "dispatch log task-zz9 x"}},
            {"type": "response_item", "payload": {"type": "custom_tool_call", "name": "exec", "input": 'await tools.exec_command({cmd:"dispatch check task-ef3 1 --claim \\"x\\""})'}},
            {"type": "message", "message": {"role": "assistant", "content": [{"type": "toolCall", "name": "bash", "arguments": {"command": "bd update task-gh4 --claim"}}]}},
        ]
        self.assertEqual(dispatch.claims_of("\n".join(json.dumps(l) for l in lines), rx), ["task-ab1", "task-cd2", "task-ef3", "task-gh4"])
        self.assertEqual(dispatch.STATS_V, 4)  # bumped: every index row re-reads its claims once


class LinkBackfill(unittest.TestCase):
    def test_plan_links_claimers_and_project_workers_only(self):
        import links
        idx = {
            "/a.jsonl": {"session_id": "aaaaaaaa-1", "agent": "claude-code", "cwd": "/p/redraft", "tasks": {"task-x1": 5}, "claims": [], "mtime": 3},
            "/b.jsonl": {"session_id": "bbbbbbbb-1", "agent": "codex", "cwd": "/p/other", "tasks": {"task-x1": 1}, "claims": ["task-x1"], "mtime": 2},
            "/c.jsonl": {"session_id": "cccccccc-1", "agent": "claude-code", "cwd": "/p/kanban", "tasks": {"task-x1": 9}, "claims": [], "mtime": 1},
            "/d.jsonl": {"session_id": "dddddddd-1", "agent": "claude-code", "cwd": "/p/redraft", "tasks": {"task-x1": 1}, "claims": [], "mtime": 1},
            "/e.jsonl": {"session_id": "agent-sub", "agent": "claude-code", "cwd": "/p/redraft", "tasks": {"task-x1": 9}, "claims": ["task-x1"], "mtime": 1, "subagent": True},
        }
        tasks = [{"id": "task-x1", "title": "t", "status": "in_progress", "labels": ["project:redraft", "session:eeeeeeee-1"]}]
        with patch.object(dispatch, "project_of_cwd", side_effect=lambda cwd, names, roots=None: os.path.basename(cwd)):
            rows = links.plan(dispatch._THIS, tasks, idx, names=[], roots=[])
        r = rows[0]
        # only a command on the task links; mentions in the project are "maybe" (prime lists tasks too)
        self.assertEqual({x["sid"] for x in r["add"]}, {"bbbbbbbb-1"})
        self.assertEqual({x["sid"] for x in r["skip"]}, {"aaaaaaaa-1", "cccccccc-1", "dddddddd-1"})
        self.assertTrue(next(x for x in r["skip"] if x["sid"] == "aaaaaaaa-1").get("maybe"))

    def test_dry_run_writes_nothing(self):
        import links
        tasks = [{"id": "task-x1", "title": "t", "status": "in_progress", "labels": [], "updated_at": "2099-01-01T00:00:00Z"}]
        idx = {"/b.jsonl": {"session_id": "bbbbbbbb-1", "agent": "codex", "cwd": "/p", "tasks": {"task-x1": 1}, "claims": ["task-x1"], "mtime": 2}}
        with patch.object(dispatch, "sh", return_value=(0, json.dumps(tasks), "")) as sh, patch.object(dispatch, "refresh_index", return_value=idx), \
             patch.object(dispatch, "project_names", return_value=[]), patch.object(dispatch, "settings_load", return_value={}), patch.object(dispatch, "project_of_cwd", return_value=""), \
             patch.object(dispatch, "link_session") as link, contextlib.redirect_stdout(io.StringIO()) as out:
            links.backfill(dispatch._THIS, types.SimpleNamespace(status="in_progress", days=30, only="", dry_run=True, json=False, verbose=False))
        link.assert_not_called()
        self.assertFalse(any("update" in c.args[0] for c in sh.call_args_list))
        self.assertIn("将新增", out.getvalue())


class CodexFirstPrompt(unittest.TestCase):
    """Codex injects its AGENTS.md preamble and <environment_context> as the first user message:
    the conversation's first prompt is what the person typed after that."""
    def rollout(self, *msgs):
        lines = [json.dumps({"type": "session_meta", "payload": {"id": "c1", "cwd": "/x", "originator": "codex_exec"}})]
        for blocks in msgs:
            lines.append(json.dumps({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": b} for b in blocks]}}))
        return "\n".join(lines) + "\n"

    PREAMBLE = "# AGENTS.md instructions for /Users/x/p\n\n<INSTRUCTIONS>\n# Rules\n<!-- BEGIN X -->\n- a\n<!-- END X -->\n</INSTRUCTIONS>"
    ENV = "<environment_context>\n  <cwd>/x</cwd>\n  <shell>zsh</shell>\n</environment_context>"

    def test_skips_the_preamble_in_one_message_or_its_own(self):
        self.assertEqual(dispatch.first_prompt_of("codex", self.rollout([self.PREAMBLE, self.ENV], ["修一下登录"])), "修一下登录")
        self.assertEqual(dispatch.first_prompt_of("codex", self.rollout([self.PREAMBLE], [self.ENV], ["修一下登录"])), "修一下登录")
        self.assertEqual(dispatch.first_prompt_of("codex", self.rollout([self.PREAMBLE, self.ENV])), "")

    def test_cached_rows_holding_the_preamble_are_re_derived(self):
        with tempfile.TemporaryDirectory() as home:
            folder = os.path.join(home, ".codex", "sessions", "2026", "09", "25")
            os.makedirs(folder)
            path = os.path.join(folder, "rollout-c1.jsonl")
            with open(path, "w") as f:
                f.write(self.rollout([self.PREAMBLE, self.ENV], ["修一下登录"]))
            st = os.stat(path)
            old = {"agent": "codex", "session_id": "c1", "cwd": "/x", "title": "", "mtime": st.st_mtime, "size": st.st_size, "off": st.st_size, "tasks": {}, "claims": [],
                   "subagent": False, "entrypoint": "exec", "origin_v": dispatch.ORIGIN_V, "stats_v": dispatch.STATS_V, "first_prompt": "# AGENTS.md instructions\n\n</environment_contex", **dispatch.stats_fields()}
            with patch.object(dispatch, "HOME", home), patch.object(dispatch, "load_index", return_value={path: old}), \
                    patch.object(dispatch, "save_index"), patch.object(dispatch, "zcode_query", return_value=[]), patch.object(dispatch, "task_prefix", return_value="task"):
                idx = dispatch.refresh_index()
            self.assertEqual(idx[path]["first_prompt"], "修一下登录")


class AsideCommand(unittest.TestCase):
    """`dispatch aside`: ask, list, and keep an answer in the wiki; errors reach the app on stderr."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="dispatch-aside-")
        self.stored = []
        self.ref = {"agent": "claude-code", "session_id": "s1", "project": "demo", "cwd": "/w", "path": ""}
        self.detail = {"meta": {"cwd": "/w"}, "messages": [{"ts": "2026-09-26T10:00:00Z", "role": "user", "text": "改一下", "blocks": []}],
                       "files": [{"path": "/w/a.txt", "changes": [{"kind": "edit", "old": "hello", "new": "hi", "ts": "2026-09-26T10:00:01Z"}]}]}

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_cmd(self, **kw):
        import aside
        a = types.SimpleNamespace(**{"key": "s1", "hunk": None, "tool": None, "q": None, "list": False, "save": None, "json": True, **kw})
        out_, err_ = io.StringIO(), io.StringIO()
        code = 0
        with patch.object(dispatch, "DISPATCH_DIR", self.dir), patch.object(dispatch, "load_index", return_value={}), \
                patch.object(dispatch, "resolve", return_value=[self.ref]), patch.object(dispatch, "read_session_detail", return_value=self.detail), \
                patch.object(aside, "ask_model", return_value="因为你让改的。"), patch.object(dispatch, "wiki_store", side_effect=lambda k, c: self.stored.append((k, c)) or k), \
                contextlib.redirect_stdout(out_), contextlib.redirect_stderr(err_):
            try:
                dispatch.cmd_aside(a)
            except SystemExit as e:
                code = e.code
        return code, out_.getvalue(), err_.getvalue()

    def test_ask_list_save(self):
        code, out_, _ = self.run_cmd(hunk="a.txt:1", q="为什么这么改")
        item = json.loads(out_)
        self.assertEqual((code, item["answer"], item["target"]), (0, "因为你让改的。", "hunk:a.txt:1"))
        code, out_, _ = self.run_cmd(list=True)
        self.assertEqual([i["q"] for i in json.loads(out_)["items"]], ["为什么这么改"])
        code, out_, _ = self.run_cmd(save=item["id"])
        self.assertEqual(json.loads(out_)["saved"], f"win-aside-{item['id']}")
        key, content = self.stored[0]
        self.assertEqual(key, f"win-aside-{item['id']}")
        self.assertEqual(content, "【做对】a.txt 第 1 处：为什么这么改 【为什么】因为你让改的。 #project:demo")
        _, out_, _ = self.run_cmd(list=True)
        self.assertEqual(json.loads(out_)["items"][0]["saved"], key)

    def test_errors_go_to_stderr_with_exit_1(self):
        code, out_, err_ = self.run_cmd(hunk="zzz.txt:1", q="?")
        self.assertEqual(code, 1)
        self.assertIn("这个会话没改过 zzz.txt", err_)
        self.assertEqual(json.loads(out_), {"error": "这个会话没改过 zzz.txt"})
        code, _, err_ = self.run_cmd()
        self.assertEqual(code, 1)
        self.assertIn("用法", err_)


class EnvStoreKeepsItsKeys(unittest.TestCase):
    """10-08: the whole ~/.config/dispatch was gone and the next `env set` made a new store holding 1 key of 68.
    A write that would leave out keys the store had at its last write is refused; the names (never the values)
    are recorded in another folder, so a store whose folder is gone is noticed too."""

    def setUp(self):
        self._env = (dispatch.ENV_DIR, dispatch.ENV_FILE, dispatch.ENV_FISH, dispatch.ENV_SH, dispatch.ENV_KNOWN)
        self.addCleanup(self._restore)
        self.tmp = tempfile.mkdtemp(prefix="dtest-envkeep-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        d = os.path.join(self.tmp, ".config", "dispatch")
        dispatch.ENV_DIR = d; dispatch.ENV_FILE = os.path.join(d, "env"); dispatch.ENV_FISH = os.path.join(d, "env.fish"); dispatch.ENV_SH = os.path.join(d, "env.sh")
        dispatch.ENV_KNOWN = os.path.join(self.tmp, ".dispatch", "state", "env-names.json")
        dispatch.env_write([{"name": "A_KEY", "value": "secret-a-123", "note": ""}, {"name": "B_KEY", "value": "secret-b-456", "note": ""}])

    def _restore(self):
        dispatch.ENV_DIR, dispatch.ENV_FILE, dispatch.ENV_FISH, dispatch.ENV_SH, dispatch.ENV_KNOWN = self._env

    def env(self, op, name=None, value=None, stdin=""):
        a = types.SimpleNamespace(op=op, name=name, value=value, note=None, project=None, stdin=bool(stdin), fish=False, json=False)
        out, err = io.StringIO(), io.StringIO()
        code = 0
        with patch.object(sys, "stdin", io.StringIO(stdin)), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                dispatch.cmd_env(a)
            except SystemExit as e:
                code = e.code or 0
        return code, out.getvalue(), err.getvalue()

    def test_a_store_whose_folder_is_gone_is_not_started_over(self):
        shutil.rmtree(dispatch.ENV_DIR)
        code, out, err = self.env("set", "NEW_KEY", stdin="new-value-789\n")
        self.assertEqual(code, 1)
        self.assertIn("A_KEY, B_KEY", err)
        self.assertIn("forget-missing", err)
        self.assertNotIn("secret-", err + out)
        self.assertFalse(os.path.exists(dispatch.ENV_DIR))  # nothing written, not even the folder
        # list says so too, and so does the session brief, before anyone writes over it
        code, out, err = self.env("list")
        self.assertIn("A_KEY, B_KEY", err)
        self.assertIn("A_KEY, B_KEY", dispatch.env_brief_line())

    def test_a_file_that_lost_a_key_refuses_every_write_but_unset_of_that_key_is_not_needed(self):
        with open(dispatch.ENV_FILE, "w") as f:
            f.write("A_KEY=secret-a-123\n")  # B_KEY gone behind the store's back
        with self.assertRaises(dispatch.EnvKeysWouldBeLost):
            dispatch.env_write([{"name": "A_KEY", "value": "x", "note": ""}])
        code, _, err = self.env("unset", "A_KEY")
        self.assertEqual(code, 1)  # removing A_KEY would still leave B_KEY lost
        self.assertIn("B_KEY", err)
        self.assertEqual(open(dispatch.ENV_FILE).read(), "A_KEY=secret-a-123\n")

    def test_unset_and_replacing_values_still_work(self):
        self.assertEqual(self.env("set", "A_KEY", stdin="changed-a\n")[0], 0)
        self.assertEqual(self.env("unset", "B_KEY")[0], 0)
        self.assertEqual([(i["name"], i["value"]) for i in dispatch.env_read()], [("A_KEY", "changed-a")])
        self.assertEqual(dispatch.env_known(), ["A_KEY"])
        self.assertEqual(self.env("set", "C_KEY", stdin="c\n")[0], 0)  # B_KEY was removed on purpose: no complaint
        self.assertEqual(dispatch.env_known(), ["A_KEY", "C_KEY"])

    def test_forget_missing_accepts_the_loss(self):
        shutil.rmtree(dispatch.ENV_DIR)
        code, out, _ = self.env("forget-missing")
        self.assertEqual(code, 0)
        self.assertIn("A_KEY, B_KEY", out)
        self.assertEqual(self.env("set", "NEW_KEY", stdin="v\n")[0], 0)
        self.assertEqual([i["name"] for i in dispatch.env_read()], ["NEW_KEY"])
        self.assertEqual(dispatch.env_brief_line(), "")

    def test_a_store_from_before_the_record_is_recorded_when_read(self):
        os.remove(dispatch.ENV_KNOWN)
        self.assertEqual(dispatch.env_known(), [])
        self.assertEqual(dispatch.env_brief_line(), "")  # the session brief reads it and records the names
        self.assertEqual(dispatch.env_known(), ["A_KEY", "B_KEY"])
        os.remove(dispatch.ENV_FILE)
        self.assertEqual(self.env("set", "NEW_KEY", stdin="v\n")[0], 1)

    def test_the_record_holds_names_only_and_keeps_stores_apart(self):
        with open(dispatch.ENV_KNOWN) as f:
            text = f.read()
        self.assertNotIn("secret-", text)
        other = os.path.join(self.tmp, "other")
        dispatch.ENV_DIR = other; dispatch.ENV_FILE = os.path.join(other, "env"); dispatch.ENV_FISH = os.path.join(other, "env.fish"); dispatch.ENV_SH = os.path.join(other, "env.sh")
        dispatch.env_write([{"name": "Z_KEY", "value": "z", "note": ""}])  # a store of its own: the first one's keys are not asked for
        self.assertEqual(sorted(json.load(open(dispatch.ENV_KNOWN))), sorted([os.path.join(self.tmp, ".config", "dispatch", "env"), os.path.join(other, "env")]))
