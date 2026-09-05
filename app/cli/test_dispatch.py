import importlib.util
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("dispatch", os.path.join(HERE, "dispatch.py"))
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)


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
            self.assertIn("ZHIPU_API_KEY（智谱 GLM）", dispatch.env_summary_line())
