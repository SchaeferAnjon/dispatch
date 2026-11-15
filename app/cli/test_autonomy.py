# -*- coding: utf-8 -*-
"""How much agents may do on their own: the three choices, the safe default, and what each one means for a session."""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import autonomy as A
import chat_codex
import chat_protocol as cp


class Levels(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        p = mock.patch.dict(os.environ, {"DISPATCH_DIR": self.tmp})
        p.start()
        self.addCleanup(p.stop)

    def test_the_default_is_full_auto_and_nothing_is_saved(self):
        # the user's call (2026-10-01): agents work on their own unless the person picks a stricter level
        self.assertEqual(A.load(), {"level": "auto", "saved": False})
        self.assertEqual(A.LEVELS[-1]["id"], A.DEFAULT)

    def test_three_plain_choices_with_a_consequence_each(self):
        self.assertEqual([l["title"] for l in A.LEVELS], ["Always ask", "Ask for risky actions", "Full auto"])
        for l in A.LEVELS:
            self.assertGreater(len(l["detail"]), 40, l["id"])
            self.assertLessEqual(len(l["title"]), 24, l["id"])
            for word in ("YOLO", "CLI", "sandbox", "flag", "approval"):
                self.assertNotIn(word, l["title"] + l["detail"], l["id"])

    def test_saved_and_read_back(self):
        self.assertEqual(A.save("auto"), {"level": "auto", "saved": True})
        self.assertEqual(A.load()["level"], "auto")
        with open(os.path.join(self.tmp, "autonomy.json")) as f:
            self.assertEqual(json.load(f), {"level": "auto"})
        with self.assertRaises(ValueError):
            A.save("yolo")
        with open(os.path.join(self.tmp, "autonomy.json"), "w") as f:
            f.write("{damaged")
        self.assertEqual(A.load()["level"], "auto")

    def test_what_a_dispatch_session_opens_with(self):
        self.assertEqual([A.chat_mode(l, "claude-code") for l in A.IDS], ["", "acceptEdits", "bypassPermissions"])
        self.assertEqual([A.chat_mode(l, "codex") for l in A.IDS], ["", "acceptEdits", "bypassPermissions"])
        # OpenCode only knows "no questions"
        self.assertEqual([A.chat_mode(l, "opencode") for l in A.IDS], ["", "", "bypassPermissions"])
        for l in A.IDS:
            for agent in ("claude-code", "codex", "opencode"):
                m = A.chat_mode(l, agent)
                self.assertTrue(m == "" or m in cp.PERMISSION_MODES)
                if agent == "codex" and m:
                    self.assertIn(m, chat_codex.MODE_MAP)

    def test_what_the_agents_window_starts_with(self):
        self.assertEqual([A.ide_approvals(l) for l in A.IDS], ["manual", "assisted", "allowAll"])
        self.assertEqual(A.ide_approvals("nonsense"), "manual")

    def test_snapshot_for_the_wizard(self):
        s = A.snapshot()
        self.assertEqual((s["ok"], s["level"], s["ide_approvals"]), (True, "auto", "allowAll"))
        self.assertEqual(len(s["levels"]), 3)

    def test_command(self):
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf), self.assertRaises(SystemExit) as ex:
            A.command(mock.Mock(op="set", level="ask-risky", json=True))
        self.assertEqual(ex.exception.code, 0)
        self.assertEqual(json.loads(buf.getvalue())["level"], "ask-risky")
        buf = io.StringIO()
        with redirect_stdout(buf), self.assertRaises(SystemExit) as ex:
            A.command(mock.Mock(op="set", level="yolo", json=True))
        self.assertEqual(ex.exception.code, 1)
        self.assertFalse(json.loads(buf.getvalue())["ok"])


if __name__ == "__main__":
    unittest.main()
