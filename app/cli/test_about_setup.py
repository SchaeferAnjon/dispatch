# -*- coding: utf-8 -*-
"""First-run About you: three answers into PROFILE.md; prime carries Dispatch's own rules."""
import os, sys, tempfile, unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import init_wizard as W  # noqa: E402
import dispatch as D  # noqa: E402
import dispatch_dir as DD  # noqa: E402

WINDOWS_READY = True


class AboutSetup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.profile = os.path.join(self.tmp.name, "PROFILE.md")
        with open(self.profile, "w", encoding="utf-8") as f:
            f.write("# About me\n\n## 我是谁\n- Studies in Riverbend（2026-09-01 · claude-code）\n")
        prof = D._mod("profile")
        self.patches = [patch.object(prof, "PROFILE_FILE", self.profile), patch.object(W, "save_state", lambda **kw: None),
                        patch.object(D, "_mod", lambda name, _m=D._mod: _m(name))]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def read(self):
        with open(self.profile, encoding="utf-8") as f:
            return f.read()

    def test_three_answers_go_under_about_me(self):
        r = W.about_setup("Anjon", "简体中文", "MacBook，Mac mini、Windows")
        self.assertEqual(r["written"], ["Name: Anjon", "Usual language: 简体中文", "Machines: MacBook, Mac mini, Windows"])
        text = self.read()
        section = text.split("## Who I am", 1)[1]
        self.assertIn("- Name: Anjon（", section)
        self.assertIn("Studies in Riverbend", section)

    def test_empty_and_repeated_answers_are_skipped(self):
        W.about_setup("Anjon", "", "")
        r = W.about_setup("Anjon", "", "")
        self.assertEqual(r["written"], [])
        self.assertEqual(self.read().count("Name: Anjon"), 1)


class ShippedRules(unittest.TestCase):
    def test_rules_text_is_the_whole_file_and_install_replaces_the_copy(self):
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {"DISPATCH_HOME": d}):
            text = DD.dispatch_rules_text()
            self.assertTrue(text.startswith("# Dispatch rules for agents"))
            self.assertIn("## Waiting for you", text)
            dst = DD.install_shipped_rules()
            self.assertEqual(dst, os.path.join(d, "rules", "dispatch.md"))
            with open(dst, "w") as f:
                f.write("old copy\n")
            self.assertEqual(DD.install_shipped_rules(), dst)
            self.assertEqual(DD.dispatch_rules_text(), text)


if __name__ == "__main__":
    unittest.main()
