# -*- coding: utf-8 -*-
"""`dispatch builtins`: what Dispatch puts into every agent's context, for Settings › Soul (agent_builtins.py)."""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import agent_builtins as B  # noqa: E402
import customizations as C  # noqa: E402
import dispatch_dir as DD  # noqa: E402
import dispatch_mcp  # noqa: E402
import settings_snapshot  # noqa: E402


class BuiltinsTest(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dispatch-test-builtins-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(self.home)
        env = mock.patch.dict(os.environ, {"DISPATCH_HOME": os.path.join(self.home, ".dispatch")})
        env.start()
        self.addCleanup(env.stop)
        p = mock.patch.object(C, "home", lambda: Path(self.home))
        p.start()
        self.addCleanup(p.stop)

    def run_json(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(B.run(types.SimpleNamespace(json=True)), 0)
        return json.loads(buf.getvalue())

    def test_every_part_is_there(self):
        out = self.run_json()
        self.assertEqual(list(out), ["soul", "rules", "brief", "hooks", "tools", "skills", "agents"])
        self.assertEqual(out["soul"]["path"], os.path.join(self.home, ".dispatch", "rules", "SOUL.md"))

    def test_rules_fall_back_to_the_shipped_copy_until_installed(self):
        out = self.run_json()
        self.assertFalse(out["rules"]["installed"])
        self.assertEqual(out["rules"]["path"], DD.SHIPPED_RULES)
        self.assertTrue(os.path.isfile(out["rules"]["path"]), "the page opens this file to show it")
        installed = DD.path("rules", "dispatch.md")
        os.makedirs(os.path.dirname(installed), exist_ok=True)
        with open(installed, "w", encoding="utf-8") as f:
            f.write("# Dispatch rules\n")
        out = self.run_json()
        self.assertTrue(out["rules"]["installed"])
        self.assertEqual(out["rules"]["path"], installed)

    def test_tools_are_the_servers_own_list(self):
        tools = self.run_json()["tools"]
        self.assertEqual([t["name"] for t in tools["tools"]], [t.name for t in dispatch_mcp.TOOLS])
        self.assertTrue(all(t["description"] for t in tools["tools"]))
        self.assertEqual(tools["instructions"], dispatch_mcp.INSTRUCTIONS)
        self.assertFalse(tools["on"], "nothing registered in an empty home")
        self.assertEqual(tools["engines"], [])

    def test_skills_are_the_shipped_ones_in_order_with_their_file(self):
        skills = self.run_json()["skills"]
        self.assertEqual([s["name"] for s in skills], [n for n in C.BUILTINS if C.shipped_skill(n)])
        for s in skills:
            self.assertTrue(s["path"].endswith("/SKILL.md"))
            self.assertTrue(os.path.isfile(s["path"]), s["path"])
            self.assertEqual(s["description"], C.BUILTIN_DESCRIPTIONS[s["name"]])

    def test_a_skill_of_the_persons_is_not_a_builtin(self):
        pool = os.path.join(self.home, ".dispatch", "skills", "mine")
        os.makedirs(pool)
        with open(os.path.join(pool, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write("---\nname: mine\ndescription: my own\n---\nbody\n")
        names = [s["name"] for s in self.run_json()["skills"]]
        self.assertNotIn("mine", names)

    def test_hooks_and_brief_follow_the_hook_features(self):
        out = self.run_json()
        self.assertEqual([g["id"] for g in out["hooks"]["groups"]], list(C.GROUPS))
        self.assertTrue(out["hooks"]["entry"].endswith("/.dispatch/bin/dispatch-hook"))
        prime = next(g for g in out["hooks"]["groups"] if g["id"] == "prime")
        self.assertEqual(sorted(b["agent"] for b in out["brief"]["agents"]), sorted(prime["agents"]))
        for b in out["brief"]["agents"]:
            self.assertEqual(b["on"], prime["agents"][b["agent"]]["enabled"])
            self.assertEqual(b["via"], "plugin" if b["agent"] == "opencode" else "hook")

    def test_helper_agents_point_at_the_copy_agents_read(self):
        copy = os.path.join(self.home, ".dispatch", "agents", "engineer.md")
        os.makedirs(os.path.dirname(copy))
        with open(copy, "w", encoding="utf-8") as f:
            f.write("---\nname: engineer\n---\n")
        rows = [{"name": "engineer", "description": "Builds", "enabled": True, "shipped": "/x/agent/agents/engineer.md", "path": copy,
                 "engines": {"claude": {"state": "current", "path": copy}}, "yours": [], "builtin": True},
                {"name": "tester", "description": "Tests", "enabled": False, "shipped": "/x/agent/agents/tester.md",
                 "path": os.path.join(self.home, ".dispatch", "agents", "tester.md"), "engines": {"claude": {"state": "missing", "path": ""}},
                 "yours": [], "builtin": False}]
        with mock.patch.object(C, "builtin_agents_list", lambda: rows):
            agents = self.run_json()["agents"]
        self.assertEqual(agents[0], {"name": "engineer", "description": "Builds", "enabled": True, "path": copy,
                                     "engines": {"claude": {"state": "current", "path": copy}}, "yours": []})
        self.assertEqual(agents[1]["path"], "/x/agent/agents/tester.md", "off: the definition that ships")

    def test_plain_output_names_each_part(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            B.run(types.SimpleNamespace(json=False))
        text = buf.getvalue()
        for word in ("Soul", "Rules", "Brief", "Hooks", "Tools", "Skills", "Sub-agents"):
            self.assertIn(word, text)

    def test_settings_reads_it_with_the_rest(self):
        self.assertEqual(settings_snapshot.PARTS["builtins"], ["builtins", "--json"])
        self.assertNotIn("builtinAgents", settings_snapshot.PARTS, "the helper agents come with the builtins now")


if __name__ == "__main__":
    unittest.main()
