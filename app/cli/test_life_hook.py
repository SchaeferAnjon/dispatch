# -*- coding: utf-8 -*-
"""life_hook.py: the lifetime hook answers calls below the reminder line without dispatch.py."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import life_hook as F
import session_life as L

HERE = os.path.dirname(os.path.abspath(__file__))


def row(tokens, i=0):
    return json.dumps({"type": "assistant", "uuid": f"u{i}", "requestId": f"r{i}", "timestamp": "2026-09-30T08:00:00Z",
                       "message": {"id": f"m{i}", "model": "claude-opus-5-5", "role": "assistant", "content": [],
                                   "usage": {"input_tokens": tokens, "output_tokens": 1}}}) + "\n"


class Fast(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.base = self.tmp.name
        self.transcript = os.path.join(self.base, "t.jsonl")
        with open(self.transcript, "w") as f:
            f.write(row(100000))  # Opus 5.5: line 800K, 100K = 12.5 %
        L.cache_settings(dict(L.SETTINGS), self.base)
        env = patch.dict(os.environ, {"DISPATCH_DIR": self.base, "DISPATCH_LIFE_MANAGED": ""})
        env.start(); self.addCleanup(env.stop)
        mods = patch.dict(sys.modules)
        mods.start(); self.addCleanup(mods.stop)
        sys.modules.pop("dispatch", None)  # dispatch_dir() reads the environment, as in a fresh hook process

    def data(self, **extra):
        return {"session_id": "sess-1", "hook_event_name": "PostToolUse", "transcript_path": self.transcript, **extra}

    def test_below_the_line_is_answered_here(self):
        self.assertEqual(F.fast(self.data(), "claude-code"), {})

    def test_the_reminder_line_goes_to_the_full_hook(self):
        with open(self.transcript, "a") as f:
            f.write(row(700000, 1))
        self.assertIs(F.fast(self.data(), "claude-code"), F.FULL)

    def test_no_fresh_settings_copy_goes_to_the_full_hook(self):
        os.unlink(os.path.join(self.base, "life", "settings.json"))
        self.assertIs(F.fast(self.data(), "claude-code"), F.FULL)
        L.save(os.path.join(self.base, "life", "settings.json"), {"at": 1, "values": dict(L.SETTINGS)})
        self.assertIs(F.fast(self.data(), "claude-code"), F.FULL)

    def test_a_lower_configured_line_is_honoured(self):
        L.cache_settings({"session_life_tokens": 100000}, self.base, now=10 ** 10)
        self.assertIs(F.fast(self.data(), "claude-code", now=10 ** 10 + 1), F.FULL)

    def test_the_registered_dispatcher_goes_to_the_full_hook(self):
        L.save(os.path.join(self.base, "notifications", "dispatcher.json"), {"session": "sess-1"})
        self.assertIs(F.fast(self.data(), "claude-code"), F.FULL)

    def test_managed_foreign_and_opencode(self):
        with patch.dict(os.environ, {"DISPATCH_LIFE_MANAGED": str(os.getpid())}):
            self.assertEqual(F.fast(self.data(), "codex"), {})
        self.assertEqual(F.fast(self.data(session_id="ses_abc"), "claude-code"), {})
        self.assertIs(F.fast(self.data(), "opencode"), F.FULL)
        self.assertIs(F.fast(self.data(transcript_path=""), "claude-code"), F.FULL)

    def test_a_hook_process_below_the_line_never_imports_dispatch(self):
        code = ("import sys, io; sys.path.insert(0, %r); import life_hook; sys.argv=['h','--agent','claude-code']; "
                "life_hook.main(); print('DISPATCH' if 'dispatch' in sys.modules or 'handoff' in sys.modules else 'LEAN')") % HERE
        env = dict(os.environ, DISPATCH_DIR=self.base, PYTHONDONTWRITEBYTECODE="1")
        out = subprocess.run([sys.executable, "-c", code], input=json.dumps(self.data()), capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(out.stdout.split(), ["{}", "LEAN"], out.stderr)


class Install(unittest.TestCase):
    def test_the_entry_runs_the_lifetime_on_each_event_the_engine_follows(self):
        import engines
        for agent in ("claude-code", "codex"):
            eng = engines.get(agent)
            self.assertTrue(eng.life_hooks)
            for event in eng.life_hooks:
                self.assertIn("life", eng.hook_routes.get(event, ()), (agent, event))

    def test_the_older_entry_still_answers_until_it_is_replaced(self):
        env = dict(os.environ, DISPATCH_DIR=tempfile.mkdtemp(), PYTHONDONTWRITEBYTECODE="1")
        self.addCleanup(__import__("shutil").rmtree, env["DISPATCH_DIR"], True)
        out = subprocess.run([sys.executable, os.path.join(HERE, "life_hook.py"), "--agent", "claude-code"], input="{}",
                             capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(out.stdout.strip(), "{}", out.stderr)


if __name__ == "__main__":
    unittest.main()
