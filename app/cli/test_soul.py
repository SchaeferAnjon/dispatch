"""Soul (soul.py): Dispatch's default, the person's own copy, and what `rules sync` gives every agent."""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import types
import unittest
from unittest import mock

import dispatch
import soul


class SoulTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.home = os.path.join(self.tmp, "home")
        self.dhome = os.path.join(self.home, ".dispatch")
        os.makedirs(self.home)
        env = mock.patch.dict(os.environ, {"HOME": self.home, "DISPATCH_HOME": self.dhome})
        env.start()
        self.addCleanup(env.stop)
        self.rules = os.path.join(self.tmp, "GLOBAL.md")
        with open(self.rules, "w") as f:
            f.write("# rules\n- fish, not bash\n")
        self.paths = {ag: os.path.join(self.tmp, ag, "RULES.md") for ag in ("claude", "codex", "opencode")}
        targets = {
            "claude": {"path": self.paths["claude"], "mode": "import", "home": os.path.join(self.tmp, "claude")},
            "codex": {"path": self.paths["codex"], "mode": "inline", "home": os.path.join(self.tmp, "codex")},
            "opencode": {"path": self.paths["opencode"], "mode": "inline", "home": os.path.join(self.tmp, "opencode")},
        }
        for t in targets.values():
            os.makedirs(t["home"])
        for name, value in (("RULES_FILE", self.rules), ("RULE_TARGETS", targets), ("RULE_TARGETS_FILE", os.path.join(self.tmp, "targets.json"))):
            p = mock.patch.object(dispatch, name, value)
            p.start()
            self.addCleanup(p.stop)
        # a default of our own, so a newer one can be shipped in a test
        self.shipped = os.path.join(self.tmp, "SOUL.md")
        shutil.copy(soul.SHIPPED, self.shipped)
        p = mock.patch.object(soul, "SHIPPED", self.shipped)
        p.start()
        self.addCleanup(p.stop)

    def run_soul(self, op, stdin=None):
        a = types.SimpleNamespace(op=op, json=True)
        buf = io.StringIO()
        stream = io.StringIO(stdin) if stdin is not None else io.StringIO("")
        stream.isatty = lambda: stdin is None
        with contextlib.redirect_stdout(buf), mock.patch.object(sys, "stdin", stream):
            try:
                dispatch.cmd_soul(a)
            except SystemExit:
                pass
        return json.loads(buf.getvalue())

    def sync(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            dispatch.cmd_rules(types.SimpleNamespace(op="sync", force=False, json=True))
        return json.loads(buf.getvalue())

    def read(self, p):
        with open(p, encoding="utf-8") as f:
            return f.read()

    def mine(self):
        return os.path.join(self.dhome, "rules", "SOUL.md")


class Defaults(SoulTest):
    def test_the_shipped_default_is_the_tested_voice_rules(self):
        text = self.read(self.shipped)
        self.assertTrue(text.startswith("# Soul\nQuick, exact, plain."))
        for line in ("Cut hedge words, not doubt", "as of", "Never drop or soften", "A file tracked by git needs no backup copy",
                     "Review at most once"):
            self.assertIn(line, text)

    def test_a_new_person_gets_the_default_in_every_agent(self):
        self.sync()
        self.assertEqual(self.read(self.mine()), self.read(self.shipped))
        for ag in ("codex", "opencode"):
            block = self.read(self.paths[ag])
            self.assertIn("Quick, exact, plain.", block)
            # the person's rules, then Soul, then Dispatch's own
            self.assertLess(block.index("- fish, not bash"), block.index("# Soul"))
            self.assertLess(block.index("# Soul"), block.index("# Dispatch rules for agents"))
        claude = self.read(self.paths["claude"])
        self.assertIn("@" + self.mine() + "\n", claude)
        self.assertIn(" soul:" + self.mine() + " dispatch:", claude)

    def test_show_says_on_and_default(self):
        st = self.run_soul("show")
        self.assertEqual((st["on"], st["customized"]), (True, False))
        self.assertEqual(st["content"], st["default"])


class Changing(SoulTest):
    def test_edit_saves_syncs_and_keeps_the_old_one_in_backups(self):
        self.sync()
        r = self.run_soul("edit", "# Soul\n- Answer in one line.\n")
        self.assertTrue(r["ok"] and r["changed"] and r["customized"])
        self.assertEqual({x["agent"] for x in r["synced"]}, {"claude", "codex", "opencode"})
        for ag in ("codex", "opencode"):
            self.assertIn("- Answer in one line.", self.read(self.paths[ag]))
            self.assertNotIn("Quick, exact, plain.", self.read(self.paths[ag]))
        self.assertEqual(sorted(os.listdir(os.path.dirname(self.mine()))), ["SOUL.md", "dispatch.md"])  # no .bak beside it
        kept = [os.path.join(dp, f) for dp, _, fs in os.walk(os.path.join(self.dhome, "backups")) for f in fs if f == "SOUL.md"]
        self.assertTrue(any("Quick, exact, plain." in self.read(p) for p in kept))

    def test_a_mac_never_set_up_keeps_the_text_but_writes_nothing_into_its_agents(self):
        r = self.run_soul("edit", "# Soul\n- mine\n")
        self.assertTrue(r["changed"])
        self.assertEqual(r["synced"], [])
        self.assertEqual(self.read(self.mine()), "# Soul\n- mine\n")
        self.assertFalse(any(os.path.exists(p) for p in self.paths.values()))

    def test_an_empty_soul_is_refused(self):
        r = self.run_soul("edit", "  \n")
        self.assertFalse(r["ok"])
        self.assertIn("turn it off", r["error"])

    def test_off_takes_it_out_of_every_agent_and_on_puts_it_back(self):
        self.sync()
        r = self.run_soul("off")
        self.assertFalse(r["on"])
        for ag in ("codex", "opencode"):
            self.assertNotIn("# Soul", self.read(self.paths[ag]))
            self.assertIn("# Dispatch rules for agents", self.read(self.paths[ag]))
        self.assertNotIn("SOUL.md", self.read(self.paths["claude"]))
        self.assertTrue(os.path.isfile(self.mine()))  # the person's text is kept for when it is on again
        self.run_soul("on")
        self.assertIn("# Soul", self.read(self.paths["codex"]))
        self.assertIn("SOUL.md", self.read(self.paths["claude"]))

    def test_turning_it_off_makes_the_blocks_stale(self):
        self.sync()
        before = dispatch.rules_digest()
        soul.set_on(False)
        self.assertNotEqual(dispatch.rules_digest(), before)

    def test_reset_goes_back_to_the_default(self):
        self.sync()
        self.run_soul("edit", "# Soul\n- mine\n")
        r = self.run_soul("reset")
        self.assertFalse(r["customized"])
        self.assertEqual(self.read(self.mine()), self.read(self.shipped))
        self.assertIn("Quick, exact, plain.", self.read(self.paths["codex"]))


class AtStart(SoulTest):
    def sync_if_set_up(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            dispatch.cmd_rules(types.SimpleNamespace(op="sync", force=False, json=True, if_set_up=True))
        return json.loads(buf.getvalue())

    def test_a_mac_whose_agents_never_got_the_block_is_left_alone(self):
        r = self.sync_if_set_up()
        self.assertEqual(r["skipped"], "not set up")
        self.assertFalse(any(os.path.exists(p) for p in self.paths.values()))
        self.assertFalse(os.path.exists(self.mine()))

    def test_after_an_update_the_newer_default_arrives(self):
        self.sync()
        with open(self.shipped, "w") as f:
            f.write("# Soul\n- newer default\n")
        r = self.sync_if_set_up()
        self.assertEqual({x["action"] for x in r["results"]}, {"updated"})
        self.assertIn("- newer default", self.read(self.paths["opencode"]))


class Wizard(SoulTest):
    def test_the_rules_screen_lists_soul(self):
        import onboarding
        with mock.patch.object(onboarding, "engine_rows", return_value=[{"id": "codex", "name": "Codex", "installed": True}]), \
             mock.patch.object(onboarding, "supported", return_value=["codex"]), \
             mock.patch.object(onboarding, "_rules_path", return_value=self.paths["codex"]):
            plan = onboarding.rules_plan()
        files = {f["id"]: f for f in plan["files"]}
        self.assertIn("SOUL.md", files)
        self.assertGreater(files["SOUL.md"]["lines"], 20)
        self.assertGreater(plan["agents"][0]["block_lines"], files["SOUL.md"]["lines"])


class Updates(SoulTest):
    def ship(self, text):
        with open(self.shipped, "w") as f:
            f.write(text)

    def test_an_unchanged_copy_follows_a_newer_default(self):
        self.sync()
        self.ship("# Soul\n- newer default\n")
        self.sync()
        self.assertEqual(self.read(self.mine()), "# Soul\n- newer default\n")
        self.assertIn("- newer default", self.read(self.paths["codex"]))

    def test_a_changed_copy_stays_the_persons(self):
        self.sync()
        self.run_soul("edit", "# Soul\n- mine\n")
        self.ship("# Soul\n- newer default\n")
        self.sync()
        self.assertEqual(self.read(self.mine()), "# Soul\n- mine\n")
        st = self.run_soul("show")
        self.assertEqual(st["default"], "# Soul\n- newer default\n")
        self.assertTrue(st["customized"])

    def test_after_reset_it_follows_again(self):
        self.run_soul("edit", "# Soul\n- mine\n")
        self.run_soul("reset")
        self.ship("# Soul\n- newer default\n")
        self.sync()
        self.assertEqual(self.read(self.mine()), "# Soul\n- newer default\n")

    def test_looking_changes_nothing(self):
        self.sync()
        self.ship("# Soul\n- newer default\n")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            dispatch.cmd_rules(types.SimpleNamespace(op="status", force=False, json=True))
        self.assertNotIn("newer default", self.read(self.mine()))


if __name__ == "__main__":
    unittest.main()
