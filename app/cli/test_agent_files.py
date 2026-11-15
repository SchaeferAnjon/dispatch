# -*- coding: utf-8 -*-
"""agent_files.py: a project's own agent settings next to what Dispatch adds (task-6yrk). Read only."""
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import agent_files as A  # noqa: E402


class Report(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="af-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, "home")
        self.proj = os.path.join(self.tmp, "shop")
        for d in (".claude", ".codex", ".opencode/plugin"):
            os.makedirs(os.path.join(self.proj, d))
        for d in (".claude", ".codex"):
            os.makedirs(os.path.join(self.home, d))
        p = mock.patch.dict(os.environ, {"CODEX_HOME": os.path.join(self.home, ".codex")})
        p.start(); self.addCleanup(p.stop)

    def put(self, base, rel, content):
        path = os.path.join(base, rel)
        with open(path, "w") as f:
            f.write(content if isinstance(content, str) else json.dumps(content))
        return path

    def test_the_projects_own_files_and_dispatchs_additions(self):
        self.put(self.proj, "CLAUDE.md", "# Shop\n\nUse pnpm.\n")
        self.put(self.proj, "AGENTS.md", "Use pnpm.\n")
        self.put(self.proj, ".claude/settings.json", {"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "./guard.sh"}]}],
                                                                "Stop": [{"hooks": [{"type": "command", "command": "say done"}]}]}})
        self.put(self.proj, ".opencode/plugin/notify.ts", "export default {}")
        self.put(self.home, ".claude/settings.json", {"hooks": {"Stop": [{"hooks": [
            {"type": "command", "command": "python3 presence.py claude-code Stop # dispatch-presence"},
            {"type": "command", "command": "my-own-stop"}]}]}})
        self.put(self.home, ".claude/CLAUDE.md", "mine\n<!-- BEGIN DISPATCH GLOBAL RULES -->\nx\n<!-- END DISPATCH GLOBAL RULES -->\n")
        r = A.report(self.proj, home=self.home)
        rels = {o["rel"]: o for o in r["own"]}
        self.assertEqual(set(rels), {"CLAUDE.md", "AGENTS.md", ".claude/settings.json", ".opencode/plugin/"})
        self.assertEqual((rels[".claude/settings.json"]["count"], rels[".claude/settings.json"]["events"]), (2, ["PreToolUse", "Stop"]))
        self.assertEqual(rels["AGENTS.md"]["agents"], ["codex", "opencode"])
        self.assertEqual({(d["what"], d["count"]) for d in r["dispatch"]}, {("Hooks for Claude Code", 1), ("Shared rules for Claude Code", 1)})
        self.assertEqual(r["in_folder"], [])  # Dispatch writes nothing into the project
        self.assertEqual(r["notes"], [])

    def test_says_what_the_persons_settings_change_for_dispatch(self):
        self.put(self.proj, ".claude/settings.local.json", {"disableAllHooks": True, "statusLine": {"type": "command", "command": "mine"}})
        self.put(self.proj, "AGENTS.md", "a")
        self.put(self.proj, "AGENTS.override.md", "b")
        self.put(self.home, ".codex/AGENTS.md", "<!-- BEGIN DISPATCH GLOBAL RULES -->")
        self.put(self.home, ".codex/AGENTS.override.md", "mine")
        ids = [n["id"] for n in A.report(self.proj, home=self.home)["notes"]]
        self.assertEqual(ids, ["hooks-off", "statusline", "agents-override", "codex-override"])

    def test_a_marked_entry_in_the_folder_is_named(self):
        self.put(self.proj, ".codex/hooks.json", {"hooks": {"PostToolUse": [{"hooks": [{"command": "x # dispatch-presence"}]}]}})
        self.put(self.proj, ".claude/settings.json", "{not json")
        r = A.report(self.proj, home=self.home)
        self.assertEqual(r["in_folder"], [".codex/hooks.json"])
        self.assertTrue(next(o for o in r["own"] if o["rel"] == ".claude/settings.json")["invalid"])


if __name__ == "__main__":
    unittest.main()
