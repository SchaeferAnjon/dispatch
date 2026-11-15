# -*- coding: utf-8 -*-
import io, json, os, subprocess, sys, unittest
from contextlib import redirect_stdout
from types import SimpleNamespace

import slash as S

HERE = os.path.dirname(os.path.abspath(__file__))


def by_name(engine):
    return {r["name"]: r for r in S.rows(engine)}


class Rows(unittest.TestCase):
    def test_every_row_says_why_and_where(self):
        for engine in S._engines():
            for r in S.rows(engine):
                self.assertTrue(r["why"] and r["where"], r)
                self.assertIn("/" + r["name"], r["why"])

    def test_own_commands_and_group_names_are_never_grey(self):
        for engine, eng in S._engines().items():
            names = set(by_name(engine))
            self.assertFalse(names & set(eng.slash_commands), engine)
            self.assertNotIn("clear", names)
            self.assertNotIn("rename", names)
            for group in ("skills", "mcp", "plugins", "agents", "model", "commands"):
                self.assertNotIn(group, names)

    def test_other_engines_command_says_which_engine_and_how(self):
        r = by_name("codex")["context"]
        self.assertEqual(r["why"], "/context is a Claude Code command")
        self.assertEqual(r["where"], "Start a Claude Code session to use it")
        self.assertEqual(r["go"], "")
        r = by_name("claude")["review"]
        self.assertEqual(r["where"], "Start a Codex or OpenCode session to use it")

    def test_terminal_only_names_the_terminal_or_dispatch_way(self):
        r = by_name("claude")["resume"]
        self.assertEqual(r["why"], "Claude Code has /resume only in its terminal")
        self.assertEqual(r["go"], "sessions")
        r = by_name("claude")["doctor"]
        self.assertEqual(r["where"], "Run claude in a terminal to use it")
        r = by_name("opencode")["undo"]
        self.assertEqual(r["why"], "OpenCode has /undo only in its terminal")
        # OpenCode runs /compact over ACP too: not grey there
        self.assertNotIn("compact", by_name("opencode"))

    def test_alias_goes_to_this_engines_name(self):
        self.assertEqual(by_name("opencode")["models"]["go"], "alias:model")
        self.assertEqual(by_name("codex")["usage"]["go"], "alias:status")
        # Claude Code's /reset is its old name for /clear, which Dispatch has
        self.assertEqual(by_name("claude")["reset"]["go"], "alias:clear")

    def test_terminal_only_settings_of_claude_point_at_the_picker(self):
        r = by_name("claude")["effort"]
        self.assertEqual(r["why"], "Claude Code has /effort only in its terminal")
        self.assertIn("under the input", r["where"])
        # Codex has /goal in its terminal; Dispatch does not map it: not "a Claude Code command" there
        self.assertEqual(by_name("codex")["goal"]["why"], "Codex has /goal only in its terminal")

    def test_portable_way_is_reused_from_another_engine(self):
        # /diff is Codex's terminal command; in OpenCode the Changes pane is still the way
        r = by_name("opencode")["diff"]
        self.assertEqual(r["go"], "changes")
        # an engine-specific way is not borrowed: Claude's /config page is about Claude
        self.assertEqual(by_name("codex")["config"]["go"], "")

    def test_unknown_engine(self):
        with self.assertRaises(ValueError):
            S.rows("pi")


class Command(unittest.TestCase):
    def test_json_for_one_engine(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            S.command(SimpleNamespace(engine="opencode", json=True))
        data = json.loads(buf.getvalue())
        self.assertEqual(data["engine"], "opencode")
        self.assertEqual(data["name"], "OpenCode")
        self.assertTrue(any(r["name"] == "undo" for r in data["rows"]))

    def test_cli_entry(self):
        out = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "slash", "--engine", "claude", "--json"],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        data = json.loads(out.stdout)
        self.assertEqual(data["name"], "Claude Code")
        self.assertIn("resume", {r["name"] for r in data["rows"]})


if __name__ == "__main__":
    unittest.main()
