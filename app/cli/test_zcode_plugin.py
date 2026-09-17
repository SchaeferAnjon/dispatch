# -*- coding: utf-8 -*-
import json, os, tempfile, unittest

import zcode_plugin as Z


class ZCodePluginTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.home = self.tmp.name
        self.state = os.path.join(self.home, "tasks", ".dispatch")
        self.skill = os.path.join(self.home, "pool", "task-board"); os.makedirs(self.skill)
        open(os.path.join(self.skill, "SKILL.md"), "w").write("# task-board\n")
        os.makedirs(os.path.join(self.home, ".zcode", "cli"))
        json.dump({"plugins": {"enabledPlugins": {"x@y": True}}}, open(Z.config_path(self.home), "w"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_install_writes_plugin_and_registers_it_once(self):
        r = Z.install(self.home, self.state, self.skill, "/x/dispatch.py")
        root = os.path.join(self.state, "zcode-plugin")
        self.assertEqual((r["installed"], r["registered"], r["dir"], r["skill"]), (True, True, root, os.path.realpath(self.skill)))
        hooks = json.load(open(os.path.join(root, "hooks", "hooks.json")))
        self.assertIn('"${CLAUDE_PLUGIN_ROOT}/hooks/prime.sh"', hooks["hooks"]["SessionStart"][0]["hooks"][0]["command"])
        sh = open(os.path.join(root, "hooks", "prime.sh")).read()
        self.assertIn('export BEADS_ACTOR=zcode', sh); self.assertIn('prime --hook-json', sh); self.assertIn('"/x/dispatch.py"', sh)
        self.assertTrue(os.access(os.path.join(root, "hooks", "prime.sh"), os.X_OK))
        self.assertEqual(json.load(open(os.path.join(root, ".zcode-plugin", "plugin.json")))["name"], "dispatch")
        self.assertTrue(os.path.isfile(os.path.join(root, "skills", "task-board", "SKILL.md")))
        cfg = json.load(open(Z.config_path(self.home)))
        self.assertEqual(cfg["plugins"]["dirs"], [root])
        self.assertEqual(cfg["plugins"]["enabledPlugins"], {"x@y": True})  # untouched
        Z.install(self.home, self.state, self.skill, "/x/dispatch.py")
        self.assertEqual(json.load(open(Z.config_path(self.home)))["plugins"]["dirs"], [root])

    def test_install_without_zcode_config_creates_it(self):
        os.remove(Z.config_path(self.home))
        r = Z.install(self.home, self.state, self.skill, "/x/dispatch.py")
        self.assertTrue(r["installed"])
        self.assertEqual(json.load(open(Z.config_path(self.home)))["plugins"]["dirs"], [r["dir"]])

    def test_remove_deletes_files_and_unregisters(self):
        Z.install(self.home, self.state, self.skill, "/x/dispatch.py")
        r = Z.remove(self.home, self.state)
        self.assertEqual((r["installed"], r["registered"], r["files"]), (False, False, False))
        self.assertFalse(os.path.exists(r["dir"]))
        self.assertEqual(json.load(open(Z.config_path(self.home)))["plugins"]["dirs"], [])


if __name__ == "__main__":
    unittest.main()
