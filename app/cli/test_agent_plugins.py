"""Customizations › Plugins: Claude Code plugins on disk and their switch."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import agent_plugins as P
import customizations as C


class ClaudePlugins(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.home = root / "home"
        self.addCleanup(patch.stopall)
        patch.object(C, "home", return_value=self.home).start()
        patch.object(C.DD, "root", return_value=str(root / "dispatch")).start()
        cache = self.home / ".claude/plugins/cache"
        self.on = cache / "official/playwright/1.0.0"
        (self.on / ".claude-plugin").mkdir(parents=True)
        (self.on / ".claude-plugin/plugin.json").write_text(json.dumps({"name": "playwright", "description": "Browser automation"}))
        (self.on / ".mcp.json").write_text("{}")
        self.off = cache / "official/design/2.0.0"
        (self.off / "skills/frontend").mkdir(parents=True)
        (self.off / "skills/frontend/SKILL.md").write_text("---\nname: frontend\n---\n")
        (self.off / "hooks").mkdir()
        (self.off / "hooks/hooks.json").write_text("{}")
        installed = {"version": 2, "plugins": {
            "playwright@official": [{"scope": "user", "installPath": str(self.on), "version": "1.0.0"}],
            "design@official": [{"scope": "user", "installPath": str(self.off), "version": "2.0.0"}],
            "gone@official": [{"scope": "user", "installPath": str(cache / "official/gone/0.1"), "version": "0.1"}],
        }}
        C.write_json(self.home / ".claude/plugins/installed_plugins.json", installed)
        self.settings = self.home / ".claude/settings.json"
        self.original = {"permissions": {"allow": ["Read"]}, "enabledPlugins": {"playwright@official": True, "design@official": False}}
        C.write_json(self.settings, self.original)

    def test_lists_every_installed_plugin_on_first(self):
        rows = P.listing()["plugins"]
        self.assertEqual([r["name"] for r in rows], ["playwright@official", "design@official", "gone@official"])
        on, off, gone = rows
        self.assertTrue(on["enabled"])
        self.assertEqual((on["mcp"], on["skills"], on["description"]), (True, 0, "Browser automation"))
        self.assertEqual((off["enabled"], off["skills"], off["hooks"]), (False, 1, True))
        self.assertTrue(gone.get("missing"))

    def test_switch_writes_one_key_and_keeps_the_rest(self):
        r = P.switch("design@official", True)
        self.assertTrue(r["enabled"])
        now = json.loads(self.settings.read_text())
        self.assertEqual(now["permissions"], self.original["permissions"])
        self.assertEqual(now["enabledPlugins"], {"playwright@official": True, "design@official": True})
        self.assertEqual(json.loads(Path(r["backup"]).read_text()), self.original)
        self.assertTrue(P.switch("design@official", True).get("unchanged"))
        P.switch("playwright@official", False)
        self.assertFalse(json.loads(self.settings.read_text())["enabledPlugins"]["playwright@official"])

    def test_unknown_plugin_and_bad_settings_leave_the_file(self):
        with self.assertRaises(ValueError):
            P.switch("nothing@here", True)
        self.settings.write_text("[]")
        with self.assertRaises(ValueError):
            P.switch("design@official", True)
        self.assertEqual(self.settings.read_text(), "[]")

    def test_no_settings_file_yet(self):
        self.settings.unlink()
        P.switch("design@official", True)
        self.assertEqual(json.loads(self.settings.read_text()), {"enabledPlugins": {"design@official": True}})


if __name__ == "__main__":
    unittest.main()
