import importlib.util
import contextlib
import io
import json
import os
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("dispatch", os.path.join(HERE, "dispatch.py"))
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)


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

    def test_zcode_parts_become_blocks_with_their_own_status(self):
        rows = [
            {"pdata": json.dumps({"type": "text", "text": "改一下", "messageID": "u1"}), "mdata": json.dumps({"role": "user", "id": "u1"}), "ts": 1000, "tu": 1000},
            {"pdata": json.dumps({"type": "reasoning", "text": "先读再改", "messageID": "a1"}), "mdata": json.dumps({"role": "assistant", "id": "a1"}), "ts": 2000, "tu": 2000},
            {"pdata": json.dumps({"type": "tool", "tool": "read", "callID": "z1", "state": {"status": "completed", "input": {"filePath": "/x/a.ts"}, "output": "const a"}, "messageID": "a1"}), "mdata": json.dumps({"role": "assistant", "id": "a1"}), "ts": 3000, "tu": 3500},
            {"pdata": json.dumps({"type": "tool", "tool": "bash", "callID": "z2", "state": {"status": "running", "input": {"command": "npm test"}}, "messageID": "a1"}), "mdata": json.dumps({"role": "assistant", "id": "a1"}), "ts": 4000, "tu": 4000},
        ]
        orig = dispatch.zcode_query
        dispatch.zcode_query = lambda sql, params=(): [r for r in rows if "time_updated >" not in sql or r["tu"] > params[1]]
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
        dispatch.live_sessions = lambda: [
            {"session_id": "me", "cwd": "/a/b", "alive": True}, {"session_id": "x", "cwd": "/a/b", "alive": True},
            {"session_id": "y", "cwd": "/a/b/sub", "alive": True}, {"session_id": "z", "cwd": "/other", "alive": True}, {"session_id": "d", "cwd": "/a/b", "alive": False}]
        self.assertEqual([s["session_id"] for s in dispatch.neighbours("/a/b", "me")], ["x", "y"])


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

    def test_qr_without_svg_prints_terminal_blocks(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        with patch.object(sys,'argv',['dispatch']), patch('runpy.run_path'):
            dispatch.cmd_serve(SimpleNamespace(what='qr', svg=False))
            self.assertEqual(sys.argv, ['serve','qr'])


class FactsSections(unittest.TestCase):
    DOC = "# 常用信息\n\n> 说明\n\n## 通用\n\n- 机器 A\n\n## relecture（ReLecture · 重讲）\n\n- 域名 relecture.app\n\n## ReadOut\n\n- 手机阅读\n\n## 空节\n"

    def test_key_is_first_word_lowercased(self):
        self.assertEqual(dispatch.facts_key("relecture（ReLecture · 重讲）"), "relecture")
        self.assertEqual(dispatch.facts_key("ReadOut"), "readout")
        self.assertEqual(dispatch.facts_key("通用"), "通用")

    def test_project_gets_general_plus_its_own_section_only(self):
        picked = dispatch.facts_for("Relecture", self.DOC)
        self.assertEqual([h for h, _ in picked], ["通用", "relecture（ReLecture · 重讲）"])
        self.assertIn("relecture.app", picked[1][1])

    def test_no_project_gets_general_only_and_empty_sections_are_dropped(self):
        self.assertEqual([h for h, _ in dispatch.facts_for("", self.DOC)], ["通用"])
        self.assertEqual([h for h, _ in dispatch.facts_for("空节", self.DOC)], ["通用"])


class ProjectFlags(unittest.TestCase):
    def test_parse_keeps_only_true_known_fields(self):
        raw = json.dumps({"a": {"starred": True, "archived": False, "x": 1}, "b": {"archived": True}, "c": {"starred": False}, "d": "bad"})
        self.assertEqual(dispatch.project_flags_parse(raw), {"a": {"starred": True}, "b": {"archived": True}})
        self.assertEqual(dispatch.project_flags_parse(""), {})
        self.assertEqual(dispatch.project_flags_parse("not json"), {})

    def test_apply_merges_and_drops_empty(self):
        flags = dispatch.project_flags_apply({}, "ReadOut", {"starred": True})
        flags = dispatch.project_flags_apply(flags, "ReadOut", {"archived": True})
        self.assertEqual(flags, {"ReadOut": {"starred": True, "archived": True}})
        flags = dispatch.project_flags_apply(flags, "ReadOut", {"starred": False, "archived": False})
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
        user = {"author": "schaefer", "text": "请补一下  手机截图", "created_at": "2"}
        agent = {"author": "claude-code", "text": "好的", "created_at": "3"}
        self.assertEqual(dispatch.human_note([agent, user], "claude-code"), "请补一下 手机截图")
        self.assertEqual(dispatch.human_note([user, agent], "claude-code"), "")
        self.assertEqual(dispatch.human_note([{"author": "codex", "text": "x", "created_at": "1"}], "claude-code"), "")
        self.assertEqual(dispatch.human_note([], "claude-code"), "")


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
    TEXT = "# x\n\n## 通用\n\n**机器**\n- 本机 MacBook，Tailscale 100.85.245.72\n- mini 100.118.80.86\n\n**我常说的话**\n- 密钥只进 dispatch env\n\n## kanban\n- 板在 ~/tasks/.beads\n"

    def test_topics_and_get(self):
        secs = dict(dispatch.facts_sections(self.TEXT))
        self.assertEqual([t for t, _ in dispatch.facts_topics(secs["通用"])], ["机器", "我常说的话"])
        hits = dispatch.facts_get("机器", "", self.TEXT)
        self.assertEqual([(h, t) for h, t, _ in hits], [("通用", "机器")])
        self.assertIn("100.85.245.72", hits[0][2])
        self.assertEqual(dispatch.facts_get("常说", "kanban", self.TEXT)[0][1], "我常说的话")
        self.assertEqual(dispatch.facts_get("nothing", "", self.TEXT), [])

    def test_search_carries_topic(self):
        rows = dispatch.facts_search("mini 100", [("通用", self.TEXT)])
        self.assertEqual(rows, [("通用", "机器", "- mini 100.118.80.86")])

    def test_import_candidates_skip_known_and_irrelevant(self):
        src = [("/m/a.md", "---\nname: x\n---\n\n本机 MacBook，Tailscale 100.85.245.72 就是这台\n\n今天天气不错，写了很多代码，非常开心的一天。\n\nHetzner 别名 hetzner，root@178.104.140.55，裸 IP 会 Permission denied\n"), ("/m/b.md", "Hetzner 别名 hetzner，root@178.104.140.55，裸 IP 会 Permission denied")]
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
        def fake_query(sql, params=()):
            if "from part" in sql:
                return [{"sk": "video-to-notes"}, {"sk": "video-to-notes"}, {"sk": "getnote"}, {"sk": None}]
            return []
        e = dispatch.stats_fields()
        with patch.object(dispatch, "zcode_query", side_effect=fake_query):
            dispatch.parse_zcode_stats(e, "sess_1")
        self.assertEqual(e["skills"], {"video-to-notes": 2, "getnote": 1})
