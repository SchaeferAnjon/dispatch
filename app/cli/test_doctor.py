# -*- coding: utf-8 -*-
"""`dispatch doctor`: each check against a state that is broken on purpose (a scratch HOME with a
missing hook, a chatd.json with another code version, a slow bd stub), --fix in that scratch HOME,
the JSON shape, and the daily run inside chatd."""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest import mock
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chatd
import doctor as K
import engines as E
import init_wizard as I
import wake
from test_chatd import Base as ChatBase


def write(path, text=""):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


class Kit(unittest.TestCase):
    """A scratch HOME with everything a healthy Mac has, and a Ctx whose outside calls are stubs."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="doctor-test-")
        self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name
        self.dd = os.path.join(self.home, "tasks", ".dispatch")
        for name in ("presence.py", "edit-guard.py", "statusline-tee.sh"):
            write(os.path.join(self.dd, name))
        write(os.path.join(self.home, ".local", "bin", "dispatch"))  # the plan hook runs it
        write(os.path.join(self.home, ".dispatch", "machine-id"), "0123456789abcdef\n")
        write(os.path.join(self.ctx_beads(), "config.yaml"))
        for sub, link in (("agents", (".claude", "agents")), ("rules", (".agents", "rules"))):
            os.makedirs(os.path.join(self.home, ".dispatch", sub))
            os.makedirs(os.path.join(self.home, link[0]), exist_ok=True)
            os.symlink(os.path.join(self.home, ".dispatch", sub), os.path.join(self.home, *link))
        self.ctx = self.make()
        self.trusted = True  # what Codex says about Dispatch's entry (it is never started here)
        self.ctx.hook_trusted = lambda eng, path: self.trusted
        p = patch("engines.codex.trust_hook", lambda path, command, before=None, env=None: self.trust_asked.append(path) or {"ok": True})
        self.trust_asked = []
        p.start()
        self.addCleanup(p.stop)
        # nor asked for its hook list: the fix looked at it first and started the machine's real `codex app-server`
        p = patch("engines.codex.app_server", lambda *a, **k: None)
        p.start()
        self.addCleanup(p.stop)

    def ctx_beads(self):
        return os.path.join(self.home, "tasks", ".beads")

    def make(self, **kw):
        c = K.Ctx(home=self.home, dispatch_dir=self.dd, beads_dir=os.path.join(self.home, "tasks", ".beads"), **kw)
        c.bd_read = lambda: (0, 0.2, "")
        c.dolt_up = lambda: True
        c.engine_rows = lambda: []
        c.chatd_status = lambda: {"installed": True, "loaded": True, "pid": 11, "door_pid": 11, "door": "launchd", "log": "chatd.log"}
        c.registry = lambda: {"pid": 11, "sessions": {}, "code": {"cli": self.home, "digest": "aaa", "head": "abc1234", "version": "1"}}
        c.stamp = lambda cli=None: {"cli": self.home, "digest": "aaa", "head": "abc1234", "version": "1"}
        c.restart_chatd = lambda: True
        c.processes = lambda: []  # never this Mac's real process table
        c.free_bytes = lambda: 100 * 1024 ** 3
        c.staging_dir = lambda: os.path.join(self.home, "staging")
        return c

    def select(self, *agents):
        write(os.path.join(self.dd, "init.json"), json.dumps({"agents": list(agents)}))

    def rows(self, group):
        return {r["name"]: r for r in K.run_group(self.ctx, group, dict(K.GROUPS)[group])}

    def install_claude(self):
        E.get("claude").install_hooks(path=self.ctx.hooks_file("claude-code"))

    def install_codex(self):
        os.makedirs(os.path.join(self.home, ".codex"), exist_ok=True)
        E.get("codex").install_hooks(path=self.ctx.hooks_file("codex"))

    def cut(self, path, event):
        """Take Dispatch's hook entry off one event of a hooks file."""
        import hooks_setup
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        for g in d["hooks"].get(event, []):
            g["hooks"] = [h for h in g["hooks"] if not hooks_setup.kind(h.get("command", ""))]
        d["hooks"][event] = [g for g in d["hooks"][event] if g["hooks"]]
        with open(path, "w", encoding="utf-8") as f:
            json.dump(d, f)


class Hooks(Kit):
    def test_a_fresh_install_is_healthy_and_a_foreign_hook_is_not_our_business(self):
        self.select("claude-code", "codex")
        self.install_claude()
        self.install_codex()
        r = self.rows("hooks")
        self.assertEqual((r["hooks.claude-code"]["status"], r["hooks.codex"]["status"]), ("ok", "ok"), r)
        self.assertEqual(r["hooks.opencode"]["status"], "ok")
        self.assertIn("not among the chosen", r["hooks.opencode"]["message"])

    def test_a_missing_event_is_named_and_fix_puts_it_back_with_their_own_hook_kept(self):
        self.select("claude-code")
        self.install_claude()
        with open(self.ctx.hooks_file("claude-code"), encoding="utf-8") as f:
            d = json.load(f)
        d["hooks"]["Stop"].append({"hooks": [{"type": "command", "command": "their-own-hook"}]})
        with open(self.ctx.hooks_file("claude-code"), "w", encoding="utf-8") as f:
            json.dump(d, f)
        self.cut(self.ctx.hooks_file("claude-code"), "UserPromptSubmit")
        r = self.rows("hooks")["hooks.claude-code"]
        self.assertEqual(r["status"], "fail")
        self.assertTrue(r["fixable"])
        self.assertIn("UserPromptSubmit", r["message"])
        rows = K.run_checks(self.ctx, only={"hooks"})
        fixed, after = K.fix_all(self.ctx, rows)
        self.assertEqual([(f["name"], f["ok"]) for f in fixed], [("hooks.claude-code", True)])
        self.assertEqual({x["name"]: x["status"] for x in after}["hooks.claude-code"], "ok")
        with open(self.ctx.hooks_file("claude-code"), encoding="utf-8") as f:
            self.assertIn("their-own-hook", f.read())

    def test_a_settings_file_that_does_not_parse_is_not_overwritten(self):
        self.select("claude-code")
        write(self.ctx.hooks_file("claude-code"), "{ not json")
        r = self.rows("hooks")["hooks.claude-code"]
        self.assertEqual((r["status"], r["fixable"]), ("fail", False))
        with open(self.ctx.hooks_file("claude-code")) as f:
            self.assertEqual(f.read(), "{ not json")

    def test_an_entry_that_runs_a_program_that_is_gone_fails_and_fix_rewrites_it(self):
        self.select("claude-code")
        self.install_claude()
        path = self.ctx.hooks_file("claude-code")
        with open(path, encoding="utf-8") as f:
            text = f.read()
        import hooks_setup
        self.assertIn(json.dumps(hooks_setup.shim_path())[1:-1], text)
        write(path, text.replace(json.dumps(hooks_setup.shim_path())[1:-1], "/gone/bin/dispatch-hook"))
        r = self.rows("hooks")["hooks.claude-code"]
        self.assertEqual(r["status"], "fail")
        self.assertIn("/gone/bin/dispatch-hook", " ".join(r["detail"]["gone"]))
        self.assertIn("not the one this install writes", r["message"])
        fixed, after = K.fix_all(self.ctx, K.run_checks(self.ctx, only={"hooks"}))
        self.assertEqual({x["name"]: x["status"] for x in after}["hooks.claude-code"], "ok")

    def test_command_paths_are_read_the_way_the_shell_would(self):
        cmd = 'BEADS_ACTOR=x PYTHONDONTWRITEBYTECODE=1 %s "$HOME/tasks/.dispatch/presence.py" claude-code Stop # dispatch-presence' % sys.executable
        self.assertEqual(K.command_problems(cmd, self.home), [])
        os.unlink(os.path.join(self.dd, "presence.py"))
        self.assertEqual(K.command_problems(cmd, self.home), ["~/tasks/.dispatch/presence.py"])
        self.assertEqual(K.command_problems("/nope/python /nope/dispatch.py prime --hook-json", self.home), ["/nope/python", "/nope/dispatch.py"])

    def test_older_dispatch_hooks_beside_the_entry_fail_and_fix_replaces_them(self):
        self.select("codex")
        self.install_codex()
        path = self.ctx.hooks_file("codex")
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        d["hooks"]["SessionStart"].append({"hooks": [{"type": "command", "command": "dispatch prime --hook-json"}]})
        d["hooks"]["Stop"].append({"hooks": [{"type": "command", "command": "python3 /x/life_hook.py --agent codex # dispatch-life"}]})
        write(path, json.dumps(d))
        r = self.rows("hooks")["hooks.codex"]
        self.assertEqual((r["status"], r["fixable"]), ("fail", True))
        self.assertIn("older Dispatch hooks", r["message"])
        self.assertEqual(r["detail"]["old"], ["life", "prime"])
        fixed, after = K.fix_all(self.ctx, K.run_checks(self.ctx, only={"hooks"}))
        self.assertTrue(fixed[0]["ok"], fixed)
        self.assertEqual({x["name"]: x["status"] for x in after}["hooks.codex"], "ok")
        with open(path, encoding="utf-8") as f:
            text = f.read()
        self.assertNotIn("prime --hook-json", text)
        self.assertNotIn("dispatch-life", text)
        self.assertEqual(self.trust_asked, [path], "the fix has Codex trust the entry")

    def test_codex_that_does_not_trust_the_entry_fails_and_fix_asks_it_to(self):
        self.select("codex")
        self.install_codex()
        self.trusted = False
        r = self.rows("hooks")["hooks.codex"]
        self.assertEqual((r["status"], r["fixable"]), ("fail", True))
        self.assertIn("not trusted", r["message"])
        self.trust_asked.clear()
        fixed, _after = K.fix_all(self.ctx, K.run_checks(self.ctx, only={"hooks"}))
        self.assertTrue(fixed[0]["ok"], fixed)
        self.assertEqual(self.trust_asked, [self.ctx.hooks_file("codex")])

    def test_an_older_setup_without_the_entry_is_named(self):
        self.select("claude-code")
        write(self.ctx.hooks_file("claude-code"), json.dumps({"hooks": {"SessionStart": [
            {"matcher": "", "hooks": [{"type": "command", "command": '"$HOME/.local/bin/dispatch" prime --hook-json', "timeout": 20}]}]}}))
        r = self.rows("hooks")["hooks.claude-code"]
        self.assertEqual((r["status"], r["fixable"]), ("fail", True))
        self.assertIn("is not there", r["message"])
        self.assertIn("prime", r["message"])
        fixed, after = K.fix_all(self.ctx, K.run_checks(self.ctx, only={"hooks"}))
        self.assertEqual({x["name"]: x["status"] for x in after}["hooks.claude-code"], "ok")
        with open(self.ctx.hooks_file("claude-code"), encoding="utf-8") as f:
            self.assertNotIn("prime --hook-json", f.read())

    def test_a_copied_builtin_skill_is_relinked_by_fix(self):
        import shutil
        pool = os.path.join(self.home, ".dispatch", "skills")
        shutil.copytree(os.path.join(I.bundled_skill_dir(), "task-board"), os.path.join(pool, "task-board"))
        os.symlink(os.path.join(I.bundled_skill_dir(), "delivery-page"), os.path.join(pool, "delivery-page"))
        r = self.rows("links")
        self.assertEqual(r["links.skill-delivery-page"]["status"], "ok")
        self.assertEqual((r["links.skill-task-board"]["status"], r["links.skill-task-board"]["fixable"]), ("warn", True))
        fixed, after = K.fix_all(self.ctx, K.run_checks(self.ctx, only={"links"}))
        self.assertEqual({x["name"]: x["status"] for x in after}["links.skill-task-board"], "ok")
        self.assertTrue(os.path.islink(os.path.join(pool, "task-board")))
        self.assertTrue(os.listdir(os.path.join(self.dd, "backups", "skills")))

    def test_a_chosen_engine_that_is_not_installed_is_a_warning_not_a_crash(self):
        self.select("claude-code", "codex")
        shutil.rmtree(os.path.join(self.home, ".claude"))
        r = self.rows("hooks")
        self.assertEqual((r["hooks.claude-code"]["status"], r["hooks.codex"]["status"]), ("warn", "warn"))

    def test_nothing_recorded_by_the_wizard_means_nothing_to_compare_with(self):
        r = self.rows("hooks")
        self.assertEqual({x["status"] for x in r.values()}, {"ok"})
        self.assertIn("never recorded", r["hooks.codex"]["message"])

    def test_opencode_plugin_missing_then_linked_by_fix(self):
        self.select("opencode")
        os.makedirs(os.path.join(self.home, ".config", "opencode"))
        r = self.rows("hooks")["hooks.opencode"]
        self.assertEqual((r["status"], r["fixable"]), ("fail", True))
        fixed, after = K.fix_all(self.ctx, K.run_checks(self.ctx, only={"hooks"}))
        self.assertTrue(fixed[0]["ok"], fixed)
        self.assertEqual({x["name"]: x["status"] for x in after}["hooks.opencode"], "ok")
        self.assertTrue(os.path.islink(os.path.join(self.home, ".config", "opencode", "plugins", "dispatch.js")))

    def test_opencode_installed_but_not_chosen_without_the_plugin_is_a_warning(self):
        self.select("claude-code", "codex")
        os.makedirs(os.path.join(self.home, ".config", "opencode"))
        self.ctx.engine_rows = lambda: [{"id": "opencode", "name": "OpenCode", "installed": True, "version": "1.18.32"},
                                        {"id": "claude", "name": "Claude Code", "installed": True, "version": "2.1.284"},
                                        {"id": "codex", "name": "Codex", "installed": True, "version": "0.158.0"}]
        self.install_claude(); self.install_codex()
        r = self.rows("hooks")["hooks.opencode"]
        self.assertEqual(r["status"], "warn")
        self.assertIn("dispatch engines install-plugin opencode", r["fix"])
        fixed, after = K.fix_all(self.ctx, K.run_checks(self.ctx, only={"hooks"}))
        self.assertEqual({x["name"]: x["status"] for x in after}["hooks.opencode"], "ok")
        # not installed and not chosen: not our business
        del self.ctx._installed
        self.ctx.engine_rows = lambda: [{"id": "opencode", "name": "OpenCode", "installed": False}]
        self.assertEqual(self.rows("hooks")["hooks.opencode"]["status"], "ok")

    def test_opencode_plugin_link_to_a_file_that_is_gone_is_a_warning(self):
        self.select("opencode")
        plugins = os.path.join(self.home, ".config", "opencode", "plugins")
        os.makedirs(plugins)
        os.symlink(os.path.join(self.home, "gone.js"), os.path.join(plugins, "dispatch.js"))
        r = self.rows("hooks")["hooks.opencode"]
        self.assertEqual((r["status"], r["fixable"]), ("warn", True))


class Chatd(Kit):
    def row(self):
        return self.rows("chatd")["chatd"]

    def test_same_code_on_disk_is_ok(self):
        r = self.row()
        self.assertEqual(r["status"], "ok")
        self.assertIn("abc1234", r["message"])

    def test_code_changed_after_start_fails_and_fix_restarts(self):
        self.ctx.stamp = lambda cli=None: {"cli": self.home, "digest": "bbb", "head": "def5678", "version": "1"}
        called = []
        self.ctx.restart_chatd = lambda: called.append(1) or True
        r = self.row()
        self.assertEqual((r["status"], r["fixable"]), ("fail", True))
        self.assertIn("abc1234", r["message"])
        self.assertIn("def5678", r["message"])
        fixed, _ = K.fix_all(self.ctx, [r])
        self.assertEqual(called, [1])
        self.assertTrue(fixed[0]["ok"])

    def test_edited_files_under_the_same_commit_are_still_stale(self):
        self.ctx.stamp = lambda cli=None: {"cli": self.home, "digest": "bbb", "head": "abc1234", "version": "1"}
        self.assertIn("files edited, still abc1234", self.row()["message"])

    def test_a_chatd_that_never_recorded_its_version_is_the_old_one(self):
        self.ctx.registry = lambda: {"pid": 11, "sessions": {}}
        r = self.row()
        self.assertEqual((r["status"], r["fixable"]), ("fail", True))
        self.assertIn("before it recorded", r["message"])

    def test_no_restart_while_a_session_is_running(self):
        self.ctx.registry = lambda: {"pid": 11, "sessions": {"claude-code:a": {"lifecycle": "running"}, "codex:b": {"lifecycle": "idle"}}}
        called = []
        self.ctx.restart_chatd = lambda: called.append(1) or True
        r = self.row()
        fixed, after = K.fix_all(self.ctx, [r])
        self.assertEqual(called, [])
        self.assertFalse(fixed[0]["ok"])
        self.assertIn("1 session", fixed[0]["message"])

    def test_idle_sessions_do_not_stop_a_restart(self):
        self.ctx.registry = lambda: {"pid": 11, "sessions": {"codex:b": {"lifecycle": "idle"}}}
        called = []
        self.ctx.restart_chatd = lambda: called.append(1) or True
        fixed, _ = K.fix_all(self.ctx, [self.row()])
        self.assertEqual(called, [1])
        self.assertTrue(fixed[0]["ok"])

    def test_a_chatd_started_by_a_window_is_not_ours_to_restart(self):
        self.ctx.registry = lambda: {"pid": 11, "sessions": {}}
        self.ctx.chatd_status = lambda: {"installed": True, "loaded": True, "pid": 5, "door_pid": 11, "door": "other", "log": ""}
        r = self.row()
        self.assertEqual((r["status"], r["fixable"]), ("fail", False))
        self.assertIn("window", r["fix"])

    def test_a_stray_chatd_holding_the_door_is_stopped_and_the_resident_takes_over(self):
        # task-0mwh: an older CLI's `chatd run`, started outside launchd, held the door for four days
        self.ctx.chatd_status = lambda: {"installed": True, "loaded": True, "pid": 5, "door_pid": 11, "door": "stray",
                                         "door_cli": "/Applications/Dispatch IDE.app/Contents/Resources/app/dispatch-cli/dispatch/cli", "log": ""}
        stopped, started = [], []
        self.ctx.stop_stray = lambda pid: stopped.append(pid) or True
        self.ctx.restart_chatd = lambda: started.append(1) or True
        r = self.row()
        self.assertEqual((r["status"], r["fixable"]), ("fail", True))
        self.assertIn("nothing manages it", r["message"])
        self.assertIn("/Applications/Dispatch IDE.app", r["message"])
        fixed, _ = K.fix_all(self.ctx, [r])
        self.assertEqual((stopped, started), ([11], [1]))
        self.assertTrue(fixed[0]["ok"])

    def test_not_running_but_installed_fails_and_fix_starts_it(self):
        self.ctx.chatd_status = lambda: {"installed": True, "loaded": False, "pid": None, "door_pid": None, "door": "", "log": "chatd.log"}
        called = []
        self.ctx.restart_chatd = lambda: called.append(1) or True
        r = self.row()
        self.assertEqual((r["status"], r["fixable"]), ("fail", True))
        K.fix_all(self.ctx, [r])
        self.assertEqual(called, [1])

    def test_not_installed_and_not_running_is_a_warning(self):
        self.ctx.chatd_status = lambda: {"installed": False, "loaded": False, "pid": None, "door_pid": None, "door": "", "log": ""}
        r = self.row()
        self.assertEqual((r["status"], r["fixable"]), ("warn", False))
        self.assertIn("chatd install", r["fix"])

    def test_the_folder_chatd_loaded_from_is_gone(self):
        self.ctx.registry = lambda: {"pid": 11, "sessions": {}, "code": {"cli": "/nope/cli", "digest": "aaa", "head": "", "version": "1"}}
        self.assertEqual(self.row()["status"], "warn")

    def test_the_code_stamp_follows_the_source_files_and_ignores_tests(self):
        cli = os.path.join(self.home, "cli")
        write(os.path.join(cli, "a.py"), "x = 1\n")
        write(os.path.join(cli, "VERSION"), "1.2.3\n")
        write(os.path.join(cli, "test_a.py"), "y = 1\n")
        first = K.code_stamp(cli)
        self.assertEqual(first["version"], "1.2.3")
        write(os.path.join(cli, "test_a.py"), "y = 2\n")
        self.assertEqual(K.code_stamp(cli)["digest"], first["digest"])
        write(os.path.join(cli, "a.py"), "x = 2\n")
        self.assertNotEqual(K.code_stamp(cli)["digest"], first["digest"])


class Board(Kit):
    def test_speed_thresholds(self):
        for secs, status in ((0.4, "ok"), (4.0, "warn"), (20.0, "fail")):
            self.ctx.bd_read = lambda s=secs: (0, s, "")
            self.assertEqual(self.rows("board")["board.read"]["status"], status, secs)

    def test_a_bd_that_never_answers_or_errors_fails(self):
        self.ctx.bd_read = lambda: (None, 60.0, "no answer after 60 s")
        r = self.rows("board")["board.read"]
        self.assertEqual(r["status"], "fail")
        self.assertIn("no answer", r["message"])
        self.ctx.bd_read = lambda: (1, 0.1, "connection refused")
        self.assertEqual(self.rows("board")["board.read"]["status"], "fail")

    def test_the_bd_probe_measures_a_real_command(self):
        fake = os.path.join(self.home, "bin")
        write(os.path.join(fake, "bd"), "#!/bin/sh\nsleep 0.3\necho '[]'\n")
        os.chmod(os.path.join(fake, "bd"), 0o755)
        with patch.dict(os.environ, {"DISPATCH_IDE_BIN": fake}):
            code, secs, err = K.Ctx(home=self.home, beads_dir=self.ctx.beads_dir)._bd_read()
        self.assertEqual(code, 0)
        self.assertGreaterEqual(secs, 0.3)

    def test_dolt_down_fails_and_fix_asks_the_wizard_to_start_it(self):
        self.ctx.dolt_up = lambda: False
        r = self.rows("board")["board.dolt"]
        self.assertEqual((r["status"], r["fixable"]), ("fail", True))
        with patch.object(I, "ensure_board_server", return_value={"ok": True, "how": "kickstart", "log": ""}) as ensure:
            fixed, _ = K.fix_all(self.ctx, [r])
        ensure.assert_called_once()
        self.assertTrue(fixed[0]["ok"])

    def test_embedded_board_has_no_server_to_check(self):
        write(os.path.join(self.ctx.beads_dir, "metadata.json"), json.dumps({"dolt_mode": "embedded"}))
        self.ctx.dolt_up = lambda: False
        self.assertEqual(self.rows("board")["board.dolt"]["status"], "ok")

    def test_no_board_at_all(self):
        os.unlink(os.path.join(self.ctx.beads_dir, "config.yaml"))
        self.assertEqual({r["status"] for r in self.rows("board").values()}, {"warn"})


class Engines(Kit):
    def engine(self, eid, version, installed=True):
        return {"id": eid, "name": {"claude": "Claude Code", "codex": "Codex", "opencode": "OpenCode"}[eid], "installed": installed,
                "version": version, "path": "/bin/" + eid, "command": "npm i -g x@latest"}

    def test_a_version_below_the_minimum_fails_with_the_upgrade_command(self):
        self.ctx.engine_rows = lambda: [self.engine("opencode", "1.17.2"), self.engine("claude", "2.1.284"), self.engine("codex", "0.158.0")]
        r = self.rows("engines")
        self.assertEqual(r["engines.opencode"]["status"], "fail")
        self.assertIn("1.18.0", r["engines.opencode"]["message"])
        self.assertIn("401", r["engines.opencode"]["message"])
        self.assertIn("npm i -g", r["engines.opencode"]["fix"])
        self.assertEqual((r["engines.claude"]["status"], r["engines.codex"]["status"]), ("ok", "ok"))

    def test_the_minimum_itself_passes_and_one_patch_below_fails(self):
        mins = K.minimums()
        self.assertEqual(mins["opencode"], (1, 18, 0))
        self.ctx.engine_rows = lambda: [self.engine("opencode", "1.18.0"), self.engine("codex", "0.156.9")]
        r = self.rows("engines")
        self.assertEqual((r["engines.opencode"]["status"], r["engines.codex"]["status"]), ("ok", "fail"))

    def test_not_installed_is_only_a_warning_when_the_wizard_chose_it(self):
        self.ctx.engine_rows = lambda: [self.engine("codex", "", installed=False)]
        self.assertEqual(self.rows("engines")["engines.codex"]["status"], "ok")
        self.select("codex")
        self.assertEqual(self.rows("engines")["engines.codex"]["status"], "warn")

    def test_an_unreadable_version_is_a_warning(self):
        self.ctx.engine_rows = lambda: [self.engine("claude", "")]
        self.assertEqual(self.rows("engines")["engines.claude"]["status"], "warn")


class Machine(Kit):
    def test_missing_id_is_a_warning_and_fix_creates_it(self):
        os.unlink(os.path.join(self.home, ".dispatch", "machine-id"))
        r = self.rows("machine")["machine-id"]
        self.assertEqual((r["status"], r["fixable"]), ("warn", True))
        fixed, after = K.fix_all(self.ctx, [r])
        self.assertTrue(fixed[0]["ok"], fixed)
        self.assertEqual(self.rows("machine")["machine-id"]["status"], "ok")
        with open(os.path.join(self.home, ".dispatch", "machine-id")) as f:
            self.assertTrue(f.read().strip())

    def test_an_empty_file_counts_as_missing(self):
        write(os.path.join(self.home, ".dispatch", "machine-id"), "\n")
        self.assertEqual(self.rows("machine")["machine-id"]["status"], "warn")


class Disk(Kit):
    def staging(self, n):
        for i in range(n):
            p = os.path.join(self.home, "staging", f"build-{i}", "Dispatch IDE.app")
            os.makedirs(p)
            os.utime(os.path.dirname(p), (1000 + i, 1000 + i))
        os.makedirs(os.path.join(self.home, "staging", "empty"))  # a build without its app is not counted

    def test_free_space_thresholds(self):
        for gb, status in ((100, "ok"), (10, "warn"), (2, "fail")):
            self.ctx.free_bytes = lambda g=gb: g * 1024 ** 3
            self.assertEqual(self.rows("disk")["disk.free"]["status"], status, gb)

    def test_more_than_five_builds_warns_and_names_the_oldest(self):
        self.staging(7)
        r = self.rows("disk")["disk.staging"]
        self.assertEqual(r["status"], "warn")
        self.assertEqual(r["detail"]["count"], 7)
        self.assertEqual(r["detail"]["oldest"], ["build-0", "build-1"])
        self.assertIn("build-0", r["fix"])

    def test_five_builds_are_fine(self):
        self.staging(5)
        self.assertEqual(self.rows("disk")["disk.staging"]["status"], "ok")

    def test_no_staging_folder(self):
        self.assertEqual(self.rows("disk")["disk.staging"]["status"], "ok")


class NotInstalledYet(Kit):
    """A new Mac: an engine chosen in first-run setup but not installed yet is engines.<id>'s warning only,
    not a hooks failure; ~/.claude made by Dispatch IDE's own agent SDK is no missing agents link."""

    def test_chosen_codex_not_installed_is_no_hook_failure(self):
        self.select("codex")
        os.makedirs(os.path.join(self.home, ".codex"), exist_ok=True)
        self.ctx.engine_rows = lambda: [{"id": "codex", "name": "Codex", "installed": False}, {"id": "claude", "name": "Claude Code", "installed": False}]
        rows = {r["name"]: r for r in K.check_hooks(self.ctx)}
        self.assertEqual(rows["hooks.codex"]["status"], "ok")
        self.assertIn("not installed yet", rows["hooks.codex"]["message"])
        del self.ctx._installed
        self.ctx.engine_rows = lambda: [{"id": "codex", "name": "Codex", "installed": True, "version": "0.158.0"}]
        rows = {r["name"]: r for r in K.check_hooks(self.ctx)}
        self.assertEqual(rows["hooks.codex"]["status"], "fail")

    def test_claude_folder_without_claude_code_needs_no_agents_link(self):
        os.unlink(os.path.join(self.home, ".claude", "agents"))  # ~/.claude stays: made by something else
        self.ctx.engine_rows = lambda: [{"id": "claude", "name": "Claude Code", "installed": False}]
        rows = {r["name"]: r for r in K.check_links(self.ctx)}
        self.assertEqual(rows["links.claude-agents"]["status"], "ok")


class Links(Kit):
    def setUp(self):
        super().setUp()
        self.healthy = [os.path.join(self.home, ".claude", "agents"), os.path.join(self.home, ".agents", "rules")]

    def clear(self):
        for p in self.healthy:
            os.unlink(p)

    def test_healthy_links(self):
        self.assertEqual({r["status"] for r in self.rows("links").values()}, {"ok"})

    def test_a_missing_or_broken_link_fails_and_fix_recreates_it(self):
        self.clear()
        broken = os.path.join(self.home, ".agents", "rules")
        os.symlink(os.path.join(self.home, "gone"), broken)
        r = self.rows("links")
        self.assertEqual((r["links.claude-agents"]["status"], r["links.agents-rules"]["status"]), ("fail", "fail"))
        fixed, after = K.fix_all(self.ctx, K.run_checks(self.ctx, only={"links"}))
        self.assertEqual({f["name"] for f in fixed if f["ok"]}, {"links.claude-agents", "links.agents-rules"})
        self.assertEqual({x["status"] for x in after}, {"ok"})
        self.assertEqual(os.path.realpath(broken), os.path.realpath(os.path.join(self.home, ".dispatch", "rules")))

    def test_a_plain_folder_is_reported_and_left_alone(self):
        self.clear()
        os.makedirs(os.path.join(self.home, ".claude", "agents"))
        write(os.path.join(self.home, ".claude", "agents", "mine.md"), "x")
        r = self.rows("links")["links.claude-agents"]
        self.assertEqual((r["status"], r["fixable"]), ("warn", False))
        self.assertTrue(os.path.isfile(os.path.join(self.home, ".claude", "agents", "mine.md")))

    def test_a_link_to_somewhere_else_is_pointed_back(self):
        self.clear()
        elsewhere = os.path.join(self.home, "elsewhere")
        os.makedirs(elsewhere)
        path = os.path.join(self.home, ".agents", "rules")
        os.symlink(elsewhere, path)
        r = self.rows("links")["links.agents-rules"]
        self.assertEqual((r["status"], r["fixable"]), ("warn", True))
        K.fix_all(self.ctx, [r])
        self.assertEqual(os.path.realpath(path), os.path.realpath(os.path.join(self.home, ".dispatch", "rules")))

    def test_claude_not_installed_needs_no_agents_link(self):
        self.clear()
        os.rmdir(os.path.join(self.home, ".claude"))
        self.assertEqual(self.rows("links")["links.claude-agents"]["status"], "ok")


class Output(Kit):
    def test_json_shape_is_stable(self):
        res = K.result(self.ctx, K.run_checks(self.ctx))
        self.assertEqual(set(res), {"schema", "at", "host", "ok", "counts", "checks"})
        self.assertEqual(res["schema"], 1)
        for c in res["checks"]:
            self.assertEqual(set(c), {"name", "status", "message", "fix", "fixable", "detail"})
            self.assertIn(c["status"], ("ok", "warn", "fail"))
        self.assertEqual(sum(res["counts"].values()), len(res["checks"]))
        json.dumps(res)
        names = [c["name"] for c in res["checks"]]
        self.assertEqual(len(names), len(set(names)))
        for want in ("hooks.claude-code", "hooks.codex", "hooks.opencode", "chatd", "board.dolt", "board.read", "machine-id", "disk.free", "disk.staging", "links.claude-agents", "links.agents-rules"):
            self.assertIn(want, names)

    def test_text_has_one_line_per_check_and_a_fix_line_for_the_broken_ones(self):
        self.ctx.free_bytes = lambda: 1024 ** 3
        out = K.text(K.result(self.ctx, K.run_checks(self.ctx)))
        self.assertRegex(out, r"(?m)^fail  disk\.free +1\.0 GB free")
        self.assertIn("fix: clear old builds", out)
        self.assertRegex(out, r"\d+ ok, \d+ warn, 1 fail")

    def test_a_check_that_breaks_is_reported_not_raised(self):
        with patch.dict(dict(K.GROUPS), {}), patch.object(K, "GROUPS", (("disk", lambda ctx: 1 / 0),)):
            rows = K.run_checks(self.ctx)
        self.assertEqual((rows[0]["name"], rows[0]["status"]), ("disk", "fail"))
        self.assertIn("ZeroDivisionError", rows[0]["message"])

    def test_exit_status_is_1_only_for_a_fail(self):
        def run(free):
            self.ctx.free_bytes = lambda: free * 1024 ** 3
            args = SimpleNamespace(fix=False, json=True)
            out = io.StringIO()
            with patch.object(K, "Ctx", lambda d: self.ctx), patch.object(K, "_dispatch", lambda: None), contextlib.redirect_stdout(out):
                with self.assertRaises(SystemExit) as e:
                    K.command(args)
            return e.exception.code, json.loads(out.getvalue())
        self.assertEqual(run(100)[0], 0)
        code, res = run(1)
        self.assertEqual(code, 1)
        self.assertFalse(res["ok"])

    def test_fix_reports_what_it_did_in_the_json(self):
        self.select("claude-code")
        self.install_claude()
        self.cut(self.ctx.hooks_file("claude-code"), "Stop")
        args = SimpleNamespace(fix=True, json=True)
        out = io.StringIO()
        with patch.object(K, "Ctx", lambda d: self.ctx), patch.object(K, "_dispatch", lambda: None), contextlib.redirect_stdout(out):
            with self.assertRaises(SystemExit):
                K.command(args)
        res = json.loads(out.getvalue())
        self.assertEqual([(f["name"], f["ok"]) for f in res["fixed"]], [("hooks.claude-code", True)])
        self.assertEqual({c["name"]: c["status"] for c in res["checks"]}["hooks.claude-code"], "ok")


class Daily(Kit):
    def setUp(self):
        super().setUp()
        self.d = SimpleNamespace(HOME=self.home, DISPATCH_DIR=self.dd, BEADS_DIR=self.ctx.beads_dir)
        self.day1 = time.mktime((2026, 9, 29, 10, 0, 0, 0, 0, -1))

    def daily(self, now):
        self.ctx.clock = lambda: now
        return K.daily(self.d, self.ctx, now=now)

    def test_a_failing_check_becomes_one_notification_per_day(self):
        self.ctx.free_bytes = lambda: 1024 ** 3
        made = self.daily(self.day1)
        self.assertEqual([n["key"] for n in made], ["doctor:disk.free:2026-09-29"])
        self.assertIn("doctor: disk.free", made[0]["text"])
        self.assertIn("Fix:", made[0]["text"])
        self.assertEqual(self.daily(self.day1 + 3600), [])  # same day: not again
        wake.mark_read(self.d, [n["id"] for n in wake.unread(self.d)], "test")
        self.assertEqual(self.daily(self.day1 + 7200), [])  # even once it was read
        self.assertEqual(len(self.daily(self.day1 + 86400)), 1)  # the next day it is still broken

    def test_warnings_and_ok_are_not_notified(self):
        self.ctx.free_bytes = lambda: 10 * 1024 ** 3
        self.assertEqual(self.daily(self.day1), [])
        self.assertEqual(wake.unread(self.d), [])

    def test_the_whole_result_is_kept_and_the_next_run_is_due_a_day_later(self):
        self.assertTrue(K.due(self.dd, self.day1))
        self.daily(self.day1)
        last = K.last_run(self.dd)
        self.assertEqual(last["schema"], 1)
        self.assertEqual(last["at"], int(self.day1))
        self.assertFalse(K.due(self.dd, self.day1 + 3600))
        self.assertTrue(K.due(self.dd, self.day1 + 86400))

    def test_the_prime_brief_shows_it_under_the_worker_notifications(self):
        self.ctx.free_bytes = lambda: 1024 ** 3
        self.daily(self.day1)
        import workers
        self.assertEqual(wake.prime_lines(self.d, "no-session"), [])  # only the registered dispatcher's brief has them
        wake.save_dispatcher(self.d, {"session": "disp", "host": workers.host(), "pid": os.getpid(),
                                      "birth": workers.process(os.getpid())["birth"], "claimed_at": time.time()})
        lines = wake.prime_lines(self.d, "disp")
        self.assertIn("doctor: disk.free", "\n".join(lines))
        self.assertNotIn("无任务", "\n".join(lines))

    def test_a_terminal_dispatcher_hook_carries_it(self):
        self.ctx.free_bytes = lambda: 1024 ** 3
        self.daily(self.day1)
        text, shown = wake.render(wake.unread(self.d))
        self.assertIn("doctor: disk.free", text)
        self.assertEqual(len(shown), 1)


class ChatdRegistry(ChatBase):
    def test_chatd_writes_its_code_stamp_into_chatd_json(self):
        self.c.code = {"cli": "/x", "digest": "d1", "head": "h", "version": "v"}
        self.c.save_registry(force=True)
        self.assertEqual(self.registry()["code"]["digest"], "d1")

    def test_a_chatd_without_a_stamp_writes_none(self):
        self.c.save_registry(force=True)
        self.assertNotIn("code", self.registry())


class ChatdLoop(ChatBase):
    """The resident chatd looks once in a while whether the daily run is due; other chatds never do."""

    def setUp(self):
        super().setUp()
        self.d.BEADS_DIR = self.tmp.name
        self.now[0] = 1_800_000_000.0  # a real date: "a day since the last run" is arithmetic on it
        self.c._last_doctor = self.c._last_reap = self.c._last_wake = self.c._last_gc = self.c._last_knowledge = self.now[0]
        self.ran = []
        self.c.doctor_daily = True
        patcher = patch.object(K, "daily", lambda d, ctx=None, now=None: self.ran.append(now))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_runs_when_due_and_only_once_a_day(self):
        self.now[0] += chatd.DOCTOR_CHECK_EVERY + 1
        self.c.tick()
        self.assertEqual(len(self.ran), 1)
        with open(K.last_path(self.tmp.name), "w") as f:
            json.dump({"at": self.now[0]}, f)
        self.now[0] += chatd.DOCTOR_CHECK_EVERY + 1
        self.c.tick()
        self.assertEqual(len(self.ran), 1)

    def test_not_before_the_first_look_and_not_in_a_chatd_that_is_not_resident(self):
        self.c.tick()
        self.assertEqual(self.ran, [])
        self.c.doctor_daily = False
        self.now[0] += chatd.DOCTOR_CHECK_EVERY * 3
        self.c.tick()
        self.assertEqual(self.ran, [])

    def test_knowledge_sync_every_five_minutes_in_the_resident_chatd_only(self):
        runs = []
        self.c.knowledge_sweep = lambda: runs.append(self.now[0])
        self.c.tick()
        self.assertEqual(runs, [])
        self.now[0] += chatd.KNOWLEDGE_EVERY + 1
        self.c.tick()
        self.assertEqual(len(runs), 1)
        self.c.doctor_daily = False
        self.now[0] += chatd.KNOWLEDGE_EVERY * 3
        self.c.tick()
        self.assertEqual(len(runs), 1)

    def test_knowledge_sweep_needs_the_real_dispatch(self):
        # the stand-in dispatch of these tests has no hosts(): nothing may touch a real ~/.dispatch from here
        import knowledge_sync
        with patch.object(knowledge_sync, "sync_all", side_effect=AssertionError("no sync from a test")):
            self.c.knowledge_sweep()
        self.assertFalse(self.c._knowledge_busy)

    def test_the_resident_service_switches_it_on(self):
        import chatd_service
        with patch.object(chatd_service, "door_owner", return_value=None), patch.object(chatd, "serve", return_value=0) as serve:
            import threading
            chatd_service.run(stop=threading.Event(), d=None)
        self.assertTrue(serve.call_args.kwargs["doctor"])



class Processes(unittest.TestCase):
    """processes.bonjour and processes.engine-runs on made-up process tables (task-9ca5, task-adpq)."""

    DNS = "dns-sd -R Dispatch on Mac _dispatch._tcp local %d mac=%s v=1"

    def ctx(self, rows):
        c = K.Ctx(home=tempfile.mkdtemp(), dispatch_dir=tempfile.mkdtemp(), beads_dir="/nonexistent")
        c.processes = lambda: rows
        return c

    def run_group(self, c):
        return {r["name"]: r for r in K.run_group(c, "processes", K.check_processes)}

    def test_nothing_left_is_ok(self):
        rows = [(10, 1, 50000, "??", "/usr/sbin/mDNSResponder"), (11, 400, 9000, "ttys001", "opencode run hello")]
        got = self.run_group(self.ctx(rows))
        self.assertEqual((got["processes.bonjour"]["status"], got["processes.engine-runs"]["status"]), ("ok", "ok"))

    def test_records_whose_service_is_gone_are_found_and_stopped(self):
        rows = [(20, 1, 300000, "??", self.DNS % (17795, "mac-a")), (21, 1, 9000, "??", self.DNS % (18603, "mac-b")),
                (22, 500, 9000, "??", self.DNS % (7788, "mac-live")), (500, 1, 9000, "??", "/bin/sh -c trap ... dispatch-advert dns-sd")]
        c = self.ctx(rows)
        r = self.run_group(c)["processes.bonjour"]
        self.assertEqual((r["status"], r["fixable"], r["detail"]["pids"]), ("warn", True, [20, 21]))
        stopped = []
        with mock.patch.object(K, "_stop_pids", side_effect=lambda pids, wait=5.0: stopped.extend(pids) or []):
            fixed, _ = K.fix_all(c, [r])
        self.assertEqual(stopped, [20, 21])
        self.assertTrue(fixed[0]["ok"])

    def test_a_probe_left_hanging_is_found_and_a_terminals_or_workers_run_is_not(self):
        rows = [
            (30, 29, 4 * 3600, "??", "opencode run -m zhipuai-coding-plan/glm-5.3-flash Reply with just the word hi."),
            (29, 28, 4 * 3600, "??", "/bin/zsh -c source snapshot.sh && eval 'opencode run …'"),
            (31, 1, 4 * 3600, "ttys003", "opencode run explain this repo"),                    # the person's own, in a terminal
            (32, 33, 4 * 3600, "??", "/opt/homebrew/bin/opencode run --format json --auto -- part 2"),  # a worker
            (33, 1, 4 * 3600, "??", "/usr/bin/python3 /Users/me/.dispatch-cli/dispatch/cli/turbo.py _exec /x/launch-1.json"),
            (34, 1, 600, "??", "opencode run quick one"),                                     # ten minutes: not yet
            (35, 1, 4 * 3600, "??", "opencode serve --port 4096"),                            # a server, not a run
        ]
        c = self.ctx(rows)
        r = self.run_group(c)["processes.engine-runs"]
        self.assertEqual((r["status"], r["fixable"], r["detail"]["pids"]), ("warn", True, [30]))
        self.assertIn("4 h 0 min", r["message"])
        with mock.patch.object(K, "_stop_pids", return_value=[]) as sp:
            fixed, _ = K.fix_all(c, [r])
        sp.assert_called_once_with([30])
        self.assertTrue(fixed[0]["ok"])

    def test_etime(self):
        self.assertEqual(K._etime_seconds("03-22:30:43"), 3 * 86400 + 22 * 3600 + 30 * 60 + 43)
        self.assertEqual(K._etime_seconds("04:19:27"), 4 * 3600 + 19 * 60 + 27)
        self.assertEqual(K._etime_seconds("01:14"), 74)

    def test_stop_pids_kills_what_ignores_term(self):
        import subprocess
        # not our child (a left-behind probe never is): launchd reaps it, so a killed one is gone, not a zombie
        code = "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"
        pid = int(subprocess.check_output(["/bin/sh", "-c", '"$0" -c "$1" >/dev/null 2>&1 & echo $!', sys.executable, code], text=True).strip())
        self.addCleanup(lambda: K._alive(pid) and os.kill(pid, 9))
        time.sleep(0.3)
        self.assertTrue(K._alive(pid))
        self.assertEqual(K._stop_pids([pid], wait=0.5), [])
        self.assertFalse(K._alive(pid))


if __name__ == "__main__":
    unittest.main()
