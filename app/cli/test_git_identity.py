# -*- coding: utf-8 -*-
"""dispatch git-identity: the name and email on commits are asked of the person, never made up (task-pog4t)."""
import io
import json
import os
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import git_identity as G  # noqa: E402


class GitIdentity(unittest.TestCase):
    def setUp(self):
        self.t = self.enterContext(tempfile.TemporaryDirectory())
        self.cfg = os.path.join(self.t, "gitconfig")
        self.enterContext(mock.patch.dict(os.environ, {"HOME": self.t, "GIT_CONFIG_GLOBAL": self.cfg, "GIT_CONFIG_NOSYSTEM": "1",
                                                       "CODEX_HOME": os.path.join(self.t, ".codex"), "XDG_CONFIG_HOME": os.path.join(self.t, ".config")}))
        self.enterContext(mock.patch.object(G, "_full_name", return_value="Ada Lovelace"))

    def run_cmd(self, **kw):
        a = types.SimpleNamespace(**dict({"op": "show", "name": "", "email": "", "json": True}, **kw))
        out = io.StringIO()
        with redirect_stdout(out), self.assertRaises(SystemExit) as cm:
            G.command(a)
        return cm.exception.code, json.loads(out.getvalue())

    def test_a_new_mac_has_none_and_a_suggestion_from_what_the_mac_knows(self):
        with open(os.path.join(self.t, ".claude.json"), "w") as f:
            json.dump({"oauthAccount": {"emailAddress": "ada@lovelace.dev", "displayName": "Ada"}}, f)
        with mock.patch("accounts.claude_global_config", return_value=os.path.join(self.t, ".claude.json")):
            code, res = self.run_cmd()
        self.assertEqual(code, 0)
        self.assertFalse(res["known"])
        self.assertEqual(res["suggest"], {"name": "Ada", "email": "ada@lovelace.dev", "from": "your Claude account"})

    def test_nothing_known_suggests_no_email_rather_than_a_made_up_one(self):
        code, res = self.run_cmd()
        self.assertEqual(res["suggest"]["email"], "")
        self.assertEqual(res["suggest"]["name"], "Ada Lovelace")  # the Mac's own name for the person
        # an address an agent made up earlier is not offered back, nor a placeholder
        G._git("config", "--global", "user.email", "you@example.com")
        self.assertEqual(G.suggest()["email"], "")
        G._git("config", "--global", "user.name", "opencode")
        G._git("config", "--global", "user.email", "opencode@localhost")
        self.assertEqual(G.suggest(), {"name": "Ada Lovelace", "email": "", "from": ""})

    def test_set_writes_git_global_settings_after_checking_them(self):
        code, res = self.run_cmd(op="set", name="  Ada   Lovelace ", email="ada@lovelace.dev")
        self.assertEqual(code, 0)
        self.assertEqual((res["name"], res["email"], res["known"]), ("Ada Lovelace", "ada@lovelace.dev", True))
        self.assertTrue(G.known())
        with open(self.cfg) as f:
            self.assertIn("ada@lovelace.dev", f.read())
        code, res = self.run_cmd(op="set", name="Ada", email="not an email")
        self.assertEqual((code, res["ok"]), (1, False))
        self.assertIn("email", res["message"])
        code, res = self.run_cmd(op="set", name="", email="a@b.co")
        self.assertEqual(code, 1)
        self.assertEqual(G.configured(), ("Ada Lovelace", "ada@lovelace.dev"))  # a bad answer changes nothing


    def test_the_session_brief_asks_agents_to_ask_until_git_knows(self):
        import lang
        from unittest import mock
        with mock.patch.dict(os.environ, {"DISPATCH_LANG": "en"}):
            lang._cache.clear()
            line = G.brief_line(self.t)
        lang._cache.clear()
        self.assertIn("ask the person", line)
        self.assertIn("Never make one up", line)
        self.assertIn("绝不自己编", G.brief_line(self.t))  # the suite's person speaks Chinese (task-7lptn)
        G.set_identity("Ada Lovelace", "ada@lovelace.dev")
        self.assertEqual(G.brief_line(self.t), "")

if __name__ == "__main__":
    unittest.main()
