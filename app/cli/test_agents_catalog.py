# -*- coding: utf-8 -*-
"""Agent detection and the choice of which agents Dispatch uses. Everything lives in a temporary HOME."""
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import agents_catalog as AC
import engines as E


def exe(path, body):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write("#!/bin/sh\n" + body + "\n")
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
    return path


class Detect(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.bin = os.path.join(self.tmp, ".local", "bin")
        self.env = {"PATH": "/usr/bin:/bin"}
        dirs = os.pathsep.join(os.path.join(self.tmp, d) for d in (".local/bin", ".bun/bin", ".cargo/bin", ".amp/bin", "usr/bin"))
        for p in (mock.patch.object(E, "HOME", self.tmp), mock.patch.object(AC, "home", lambda: self.tmp),
                  mock.patch.object(E, "search_path", lambda env=None: dirs),
                  mock.patch.dict(os.environ, {"HOME": self.tmp, "DISPATCH_DIR": os.path.join(self.tmp, "state")})):
            p.start()
            self.addCleanup(p.stop)

    def row(self, agent_id):
        return AC.detect_one(AC.BY_ID[agent_id], self.env)

    def test_orca_catalog_is_covered(self):
        # the agents of Orca's catalog (tui-agent-config.ts), by their command names
        for cmd in ("openclaude", "mimo", "ante", "traecli", "muse", "dsh-tui", "qodercli", "zcode", "omp", "prime-agent", "agy",
                    "autohand", "codebuff", "freebuff", "command-code", "cn", "rovo", "devin", "openclaw", "codebuddy", "kimi-code", "cbc"):
            self.assertTrue(any(cmd in a["bins"] for a in AC.CATALOG), cmd)
        self.assertGreaterEqual(len(AC.CATALOG), 40)

    def test_a_common_command_name_only_counts_when_it_answers_with_a_version(self):
        exe(os.path.join(self.bin, "muse"), "echo 'Muse is a music notation program'")
        self.assertFalse(self.row("muse")["installed"])
        exe(os.path.join(self.bin, "muse"), "echo 'muse 0.4.2'")
        self.assertTrue(self.row("muse")["installed"])
        exe(os.path.join(self.bin, "agy"), "echo 'agy 1.0.0'")
        self.assertEqual(self.row("antigravity")["version"], "1.0.0")

    def test_aliases_are_found(self):
        exe(os.path.join(self.bin, "cbc"), "echo '2.161.0'")
        exe(os.path.join(self.bin, "kimi-code"), "echo 'kimi 1.2.0'")
        self.assertTrue(self.row("codebuddy")["installed"])
        self.assertTrue(self.row("kimi")["installed"])

    def test_catalog_covers_the_common_agents(self):
        names = {a["name"] for a in AC.CATALOG}
        for want in ("Claude Code", "Codex", "OpenCode", "Gemini CLI", "GitHub Copilot CLI", "Cursor Agent", "Aider", "Amp",
                     "Goose", "Qwen Code", "Kiro CLI", "Crush", "Droid", "Cline"):
            self.assertIn(want, names)
        self.assertEqual(AC.RUNNABLE, ("claude", "codex", "opencode"))
        self.assertEqual(len({a["id"] for a in AC.CATALOG}), len(AC.CATALOG))
        for a in AC.CATALOG:
            self.assertTrue(a.get("runnable") or a.get("install") or a.get("url"), a["id"])
            # the list is for everyone: one plain sentence, no developer words
            self.assertTrue(a["about"].endswith("."), a["id"])
            for word in ("CLI", "PATH", "npm", "terminal", "binary", "command"):
                self.assertNotIn(word, a["about"], a["id"])

    def test_found_in_the_install_folders_with_a_bare_path(self):
        exe(os.path.join(self.bin, "gemini"), "echo 'gemini 0.36.0'")
        exe(os.path.join(self.tmp, ".bun", "bin", "crush"), "echo 'crush version v0.97.1'")
        exe(os.path.join(self.tmp, ".cargo", "bin", "droid"), "echo 'droid 0.231.0'")
        exe(os.path.join(self.tmp, ".amp", "bin", "amp"), "echo '0.0.1790856055-g589fab'")
        g = self.row("gemini")
        self.assertTrue(g["installed"])
        self.assertEqual((g["version"], g["path"], g["runnable"]), ("0.36.0", os.path.join(self.bin, "gemini"), False))
        self.assertEqual(self.row("crush")["version"], "0.97.1")
        self.assertTrue(self.row("droid")["installed"])
        self.assertTrue(self.row("amp")["installed"])
        self.assertFalse(self.row("aider")["installed"])
        self.assertEqual(self.row("aider")["install"], "brew install aider")

    def test_a_tool_with_the_same_name_is_not_the_agent(self):
        # `goose` is also a database migration tool; `amp` a text editor; `pi` and `cn` are short names
        exe(os.path.join(self.bin, "goose"), "echo 'goose version: v3.24.1'")
        self.assertFalse(self.row("goose")["installed"])
        exe(os.path.join(self.bin, "goose"), "echo '1.9.0'")
        self.assertTrue(self.row("goose")["installed"])
        cellar = exe(os.path.join(self.tmp, "Cellar", "amp", "0.7", "bin", "amp"), "echo 'amp 0.7.1'")
        os.makedirs(os.path.join(self.tmp, "bin"), exist_ok=True)
        os.symlink(cellar, os.path.join(self.bin, "amp"))
        self.assertFalse(self.row("amp")["installed"])
        exe(os.path.join(self.bin, "pi"), "echo 'pi 3.14.0'")
        self.assertFalse(self.row("pi")["installed"])
        pkg = exe(os.path.join(self.tmp, "lib", "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js"), "echo '0.73.1'")
        os.remove(os.path.join(self.bin, "pi"))
        os.symlink(pkg, os.path.join(self.bin, "pi"))
        self.assertEqual(self.row("pi")["version"], "0.73.1")

    def test_a_hanging_agent_does_not_hold_detection(self):
        exe(os.path.join(self.bin, "qwen"), "sleep 30")
        with mock.patch.object(AC, "VERSION_TIMEOUT", 1):
            t = time.time()
            q = self.row("qwen")
        self.assertLess(time.time() - t, 8)
        self.assertTrue(q["installed"])
        self.assertEqual(q["version"], "")

    def test_detect_all_at_once(self):
        for name in ("gemini", "aider", "kiro-cli", "cline"):
            exe(os.path.join(self.bin, name), "echo '1.2.3'")
        rows = AC.detect(self.env)
        self.assertEqual([r["id"] for r in rows], [a["id"] for a in AC.CATALOG])
        self.assertEqual({r["id"] for r in rows if r["installed"]}, {"gemini", "aider", "kiro", "cline"})

    def test_account_comes_from_local_files_never_an_email(self):
        def put(rel, data):
            path = os.path.join(self.tmp, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(data)
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "", "COPILOT_GITHUB_TOKEN": "", "GH_TOKEN": "", "GITHUB_TOKEN": ""}):
            self.assertEqual(AC.account_of("gemini"), "Not signed in")
            put(".gemini/settings.json", json.dumps({"security": {"auth": {"selectedType": "oauth-personal"}}}))
            self.assertEqual(AC.account_of("gemini"), "Signed in with Google")
            put(".copilot/config.json", json.dumps({"logged_in_users": [{"host": "https://github.com", "login": "someone"}]}))
            self.assertEqual(AC.account_of("copilot"), "Signed in with GitHub")
            put(".config/goose/config.yaml", "GOOSE_PROVIDER: anthropic\nGOOSE_MODEL: x\n")
            self.assertEqual(AC.account_of("goose"), "Uses anthropic")
            self.assertEqual(AC.account_of("aider"), "")


class Choice(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        p = mock.patch.dict(os.environ, {"DISPATCH_DIR": self.tmp})
        p.start()
        self.addCleanup(p.stop)

    def test_defaults_are_the_three_on_and_the_others_off(self):
        c = AC.load_choice()
        self.assertEqual((c["off"], c["on"], c["default"], c["saved"]), ([], [], "", False))
        self.assertTrue(all(AC.is_enabled(i) for i in AC.RUNNABLE))
        self.assertFalse(AC.is_enabled("gemini"))
        self.assertFalse(AC.is_enabled("nonsense"))

    def test_saved_and_read_back(self):
        saved = AC.save_choice(off="codex", on=["gemini", "aider"])
        self.assertEqual((saved["off"], saved["on"], saved["saved"]), (["codex"], ["gemini", "aider"], True))
        self.assertFalse(AC.is_enabled("codex"))
        self.assertTrue(AC.is_enabled("claude"))
        self.assertTrue(AC.is_enabled("gemini"))
        with open(os.path.join(self.tmp, "agents.json")) as f:
            self.assertEqual(json.load(f), {"off": ["codex"], "on": ["gemini", "aider"], "default": ""})
        # one list given keeps the other
        self.assertEqual(AC.save_choice(on="")["off"], ["codex"])
        self.assertEqual(AC.load_choice()["on"], [])

    def test_an_agent_installed_later_is_on_by_itself(self):
        AC.save_choice(off="codex")
        self.assertTrue(AC.is_enabled("opencode"))

    def test_default_agent(self):
        self.assertEqual(AC.save_choice(default="codex")["default"], "codex")
        # the other lists keep it; a list that turns it off clears it
        self.assertEqual(AC.save_choice(on="gemini")["default"], "codex")
        self.assertEqual(AC.save_choice(off="codex")["default"], "")
        self.assertEqual(AC.save_choice(default="opencode")["default"], "opencode")
        self.assertEqual(AC.save_choice(default="")["default"], "")
        # only an agent Dispatch can start sessions with can be the default
        with self.assertRaises(ValueError):
            AC.save_choice(default="gemini")
        with self.assertRaises(ValueError):
            AC.save_choice(default="nonsense")

    def test_the_last_agent_cannot_be_turned_off(self):
        AC.save_choice(off="claude,codex")
        with self.assertRaises(ValueError):
            AC.save_choice(off="claude,codex,opencode")
        self.assertEqual(AC.load_choice()["off"], ["claude", "codex"])

    def test_unknown_ids_are_refused_and_a_list_mixing_kinds_is_sorted_out(self):
        with self.assertRaises(ValueError):
            AC.save_choice(on="not-an-agent")
        saved = AC.save_choice(off="gemini,codex", on="claude,pi")
        self.assertEqual((saved["off"], saved["on"]), (["codex"], ["pi"]))

    def test_reset_and_a_damaged_file(self):
        AC.save_choice(off="codex")
        self.assertFalse(AC.save_choice(reset=True)["saved"])
        with open(os.path.join(self.tmp, "agents.json"), "w") as f:
            f.write("{not json")
        self.assertEqual(AC.load_choice()["off"], [])

    def test_rows_carry_the_choice_and_keep_dispatch_runnable_first(self):
        AC.save_choice(off="codex", on="pi")
        rows = [dict(AC.detect_one(a), installed=a["id"] in ("claude", "codex", "pi", "gemini")) for a in AC.CATALOG]
        out = AC.with_choice(rows)
        self.assertEqual([r["id"] for r in out[:3]], ["claude", "codex", "opencode"])
        self.assertEqual([r["id"] for r in out[3:5]], ["gemini", "pi"])
        by = {r["id"]: r for r in out}
        self.assertEqual((by["codex"]["enabled"], by["claude"]["enabled"], by["pi"]["enabled"], by["gemini"]["enabled"]), (False, True, True, False))
        # no default saved: the first agent Dispatch runs that is here and on; a saved one wins when it is here
        self.assertEqual([r["id"] for r in out if r["is_default"]], ["claude"])
        AC.save_choice(default="opencode")
        rows[2]["installed"] = True
        self.assertEqual([r["id"] for r in AC.with_choice(rows) if r["is_default"]], ["opencode"])


class Login(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.bin = os.path.join(self.tmp, "claude")
        exe(self.bin, "echo ok")
        p = mock.patch.object(E, "engine_path", lambda eng, env=None: self.bin if eng.id != "codex" else "")
        p.start()
        self.addCleanup(p.stop)

    def test_claude_runs_its_own_sign_in(self):
        seen = {}

        def run(argv, **kw):
            seen["argv"], seen["env"] = argv, kw["env"]
            return mock.Mock(returncode=0, stdout="Opening browser", stderr="")
        with mock.patch.dict(os.environ, {"CLAUDE_CODE_OAUTH_TOKEN": "x"}):
            out = E.login("claude", run=run)
        self.assertEqual(out, {"ok": True, "id": "claude", "message": "Signed in to Claude Code."})
        self.assertEqual(seen["argv"], [self.bin, "auth", "login"])
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", seen["env"])

    def test_failures_say_what_happened(self):
        out = E.login("claude", run=lambda argv, **kw: mock.Mock(returncode=1, stdout="", stderr="Login cancelled"))
        self.assertEqual((out["ok"], out["message"]), (False, "Login cancelled"))

        def slow(argv, **kw):
            raise subprocess.TimeoutExpired(argv, 1)
        self.assertIn("5 minutes", E.login("claude", run=slow)["message"])
        self.assertIn("not installed", E.login("codex")["message"])
        self.assertIn("Claude Code and Codex only", E.login("opencode")["message"])


class Command(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        p = mock.patch.dict(os.environ, {"DISPATCH_DIR": self.tmp})
        p.start()
        self.addCleanup(p.stop)

    def run_cmd(self, op, **kw):
        import io
        from contextlib import redirect_stdout
        a = mock.Mock(op=op, json=True, on=kw.get("on"), off=kw.get("off"), default=kw.get("default"), reset=kw.get("reset", False))
        buf = io.StringIO()
        with redirect_stdout(buf), self.assertRaises(SystemExit) as ex:
            E.command(a)
        return ex.exception.code, json.loads(buf.getvalue())

    def test_use_and_enabled(self):
        code, out = self.run_cmd("use", off="codex", on="gemini")
        self.assertEqual((code, out["ok"], out["off"], out["on"]), (0, True, ["codex"], ["gemini"]))
        self.assertEqual(self.run_cmd("enabled")[1]["off"], ["codex"])

    def test_default_is_saved_through_the_command(self):
        code, out = self.run_cmd("use", default="codex")
        self.assertEqual((code, out["default"]), (0, "codex"))
        code, out = self.run_cmd("use", default="gemini")
        self.assertEqual((code, out["ok"]), (1, False))
        self.assertIn("can start sessions with", out["message"])

    def test_a_refused_choice_says_why(self):
        code, out = self.run_cmd("use", off="claude,codex,opencode")
        self.assertEqual((code, out["ok"]), (1, False))
        self.assertIn("at least one", out["message"])


if __name__ == "__main__":
    unittest.main()
