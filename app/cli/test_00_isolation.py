# -*- coding: utf-8 -*-
"""Switches test isolation on. Sorts first, so unittest discovery imports it before any module that reads BEADS_DIR."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

import testkit

testkit.activate()

from testkit import guard  # noqa: E402

WINDOWS_READY = False  # the guards are POSIX scripts

BIN = testkit.BIN


class Env(unittest.TestCase):
    @unittest.skipUnless(os.name == "posix", "POSIX only")
    def test_default_board_is_not_the_real_one(self):
        self.assertTrue(testkit.active())
        self.assertEqual(guard.board_problem(os.environ["BEADS_DIR"]), "")
        self.assertNotIn(os.path.realpath(os.environ["BEADS_DIR"]), guard.real_boards())
        import dispatch
        self.assertEqual(dispatch.BEADS_DIR, os.environ["BEADS_DIR"])

    @unittest.skipUnless(os.name == "posix", "POSIX only")
    def test_every_agent_command_is_a_stand_in_that_refuses(self):
        """A test without its own stand-in never reaches the machine's real Claude Code, Codex or OpenCode (a real
        model run, and an answer that depends on what that machine has installed)."""
        import engines
        tools = os.path.realpath(os.environ["DISPATCH_IDE_BIN"])
        self.assertTrue(tools.startswith(os.path.realpath(os.environ["TESTKIT_SESSION"]) + os.sep))
        for name in ("claude", "codex", "opencode", "gemini"):
            self.assertEqual(os.path.dirname(os.path.realpath(engines.which(name))), tools, name)
        log = os.path.join(tempfile.mkdtemp(prefix="dtest-agent-"), "v.log")
        self.addCleanup(shutil.rmtree, os.path.dirname(log), True)
        r = subprocess.run([engines.which("opencode"), "run", "hello"], capture_output=True, text=True, timeout=30,
                           env=dict(os.environ, TESTKIT_VIOLATIONS=log, TESTKIT_TEST="fake.test"))
        self.assertEqual(r.returncode, 97)
        with open(log) as f:
            self.assertIn("test=fake.test: refused `opencode run hello`", f.read())

    @unittest.skipUnless(os.name == "posix", "POSIX only")
    def test_bd_and_dolt_on_the_path_are_the_guards(self):
        import dplatform
        for tool in ("bd", "dolt"):
            self.assertEqual(os.path.realpath(dplatform.which(tool) or ""), os.path.realpath(os.path.join(BIN, tool)), tool)  # through the run's tool folder
            self.assertEqual(os.path.realpath(shutil.which(tool) or ""), os.path.realpath(os.path.join(BIN, tool)), tool)


@unittest.skipUnless(os.name == "posix", "POSIX only")
class TempHome(unittest.TestCase):
    """HOME and the data-folder variables point into the run's temp folder; a write to the real ones fails."""

    def setUp(self):
        self.real = guard.real_home()
        self.log = os.path.join(tempfile.mkdtemp(prefix="dtest-fs-"), "v.log")
        self.addCleanup(shutil.rmtree, os.path.dirname(self.log), True)
        p = mock.patch.dict(os.environ, {"TESTKIT_VIOLATIONS": self.log})
        p.start()
        self.addCleanup(p.stop)

    def logged(self):
        if not os.path.exists(self.log):
            return ""
        with open(self.log) as f:
            return f.read()

    def test_home_and_data_folders_are_in_the_temp_session(self):
        import dispatch
        import dispatch_dir
        session = os.path.realpath(os.environ["TESTKIT_SESSION"])
        for name, path in (("~", os.path.expanduser("~")), ("DISPATCH_HOME root", dispatch_dir.root()),
                           ("DISPATCH_DIR", dispatch.DISPATCH_DIR), ("prefs file", dispatch_dir.path("preferences.jsonl"))):
            self.assertTrue(os.path.realpath(path).startswith(session + os.sep), (name, path))
        for k in testkit.MOVES_DATA:
            self.assertNotIn(k, os.environ, k)

    def test_writing_under_the_real_dispatch_agents_claude_codex_folders_fails(self):
        for d in (".dispatch", ".agents", ".claude", ".codex", os.path.join("tasks", ".dispatch")):
            target = os.path.join(self.real, d, "testkit-probe")
            with self.assertRaises(PermissionError, msg=d):
                open(target, "w")
            self.assertFalse(os.path.exists(target), d)
        with self.assertRaises(PermissionError):
            os.makedirs(os.path.join(self.real, ".dispatch", "testkit-probe-dir"))
        with self.assertRaises(PermissionError):
            os.rename(os.path.join(self.real, ".dispatch", "a"), os.path.join(self.real, ".dispatch", "b"))
        self.assertEqual(self.logged().count("refused"), 7)
        self.assertIn("test=", self.logged())

    def test_writes_to_the_real_config_folder_or_through_a_link_into_it_fail(self):
        """10-08: the whole ~/.config/dispatch (Dispatch's keys) was gone, and test instances in /tmp held a link to it."""
        target = os.path.join(self.real, ".config", "dispatch", "testkit-probe")
        with self.assertRaises(PermissionError):
            open(target, "w")
        with self.assertRaises(PermissionError):
            os.rename(os.path.join(self.real, ".config", "dispatch"), os.path.join(self.real, ".config", "dispatch-away"))
        tmp = tempfile.mkdtemp(prefix="dtest-link-")
        self.addCleanup(shutil.rmtree, tmp, True)
        link = os.path.join(tmp, "xdg-config-dispatch")
        os.symlink(os.path.join(self.real, ".config", "dispatch"), link)  # making a link in a temp folder is fine
        with self.assertRaises(PermissionError):
            open(os.path.join(link, "testkit-probe"), "w")  # writing through it is not
        with self.assertRaises(PermissionError):
            shutil.rmtree(link + os.sep)  # `link/` would empty the folder it points at
        self.assertFalse(os.path.exists(target))
        os.remove(link)  # removing the link leaves what it points at
        self.assertEqual(self.logged().count(": refused"), 4, self.logged())

    def test_reads_and_the_temp_home_stay_open(self):
        rules = os.path.join(self.real, ".agents", "rules", "GLOBAL.md")
        if os.path.exists(rules):
            open(rules).close()
        target = os.path.join(os.path.expanduser("~"), ".dispatch", "preferences.jsonl")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "a") as f:
            f.write("{}\n")
        self.assertEqual(self.logged(), "")

    def test_a_child_python_is_guarded_too(self):
        target = os.path.join(self.real, ".dispatch", "testkit-probe-child")
        r = subprocess.run([sys.executable, "-c", "open(%r, 'w')" % target], capture_output=True, text=True, env=dict(os.environ), timeout=30)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("PermissionError", r.stderr)
        self.assertFalse(os.path.exists(target))
        self.assertIn("refused", self.logged())

    def test_a_literal_tilde_folder_is_refused(self):
        """`~/.config/x` that nobody expanded lands in the working folder (10-06: app/~/.config/bd after a run)."""
        cwd = tempfile.mkdtemp(prefix="dtest-cwd-")
        self.addCleanup(shutil.rmtree, cwd, True)
        old = os.getcwd()
        os.chdir(cwd)
        self.addCleanup(os.chdir, old)
        with self.assertRaises(PermissionError):
            os.makedirs(os.path.join("~", ".config", "bd"))
        with self.assertRaises(PermissionError):
            open(os.path.join(cwd, "~", "x"), "w")
        self.assertEqual(os.listdir(cwd), [])
        self.assertIn("literal ~ folder", self.logged())

    def test_a_child_without_home_or_with_the_real_one_is_recorded(self):
        env = {k: v for k, v in os.environ.items() if k != "HOME"}
        subprocess.run([sys.executable, "-c", "pass"], env=env, timeout=30)
        self.assertIn("with no HOME", self.logged())
        subprocess.run([sys.executable, "-c", "pass"], env=dict(os.environ, HOME="~"), timeout=30)
        self.assertIn("not an absolute path", self.logged())
        subprocess.run([sys.executable, "-c", "pass"], env=dict(os.environ, HOME=self.real), timeout=30)
        self.assertIn("the account's real home", self.logged())
        with mock.patch.dict(os.environ, {"PATH": "/usr/bin:/bin", "TESTKIT_VIOLATIONS": self.log}, clear=True):  # inherited: a test that cleared HOME
            subprocess.run(["/usr/bin/true"], timeout=30)
        self.assertEqual(self.logged().count("started"), 4)

    def test_a_child_with_its_own_temp_home_is_fine(self):
        subprocess.run([sys.executable, "-c", "pass"], env=dict(os.environ, HOME=tempfile.gettempdir()), timeout=30)
        self.assertEqual(self.logged(), "")

    def test_the_real_lsregister_may_not_change_launchservices(self):
        """10-09: which Dispatch IDE.app the Dock opens is LaunchServices' to say; a test never changes it."""
        from testkit import fsguard
        for args in (["-u", "/nonexistent/Dispatch IDE.app"], ["-f", "/nonexistent/Dispatch IDE.app"]):
            with self.assertRaises(PermissionError):
                subprocess.run([fsguard.LSREGISTER, *args], timeout=30)
        self.assertEqual(self.logged().count("the real LaunchServices database"), 2)
        subprocess.run(["/bin/echo", "-u", "x"], capture_output=True, timeout=30)  # a stand-in (or anything else) is fine
        self.assertEqual(self.logged().count("refused"), 2)


@unittest.skipUnless(os.name == "posix", "POSIX only")
class EnvironmentPutBack(unittest.TestCase):
    """A test that changes os.environ and does not put it back is recorded by name, and the change is undone."""

    def test_a_leaked_variable_is_recorded_and_undone(self):
        log = os.path.join(tempfile.mkdtemp(prefix="dtest-env-"), "v.log")
        self.addCleanup(shutil.rmtree, os.path.dirname(log), True)

        class Leaky(unittest.TestCase):
            def test_sets_and_forgets(self):
                os.environ["TESTKIT_PROBE_LEAK"] = "1"
                os.environ.pop("TESTKIT_PROBE_GONE", None)

            def test_tidy(self):
                with mock.patch.dict(os.environ, {"TESTKIT_PROBE_LEAK": "2"}):
                    pass

        with mock.patch.dict(os.environ, {"TESTKIT_VIOLATIONS": log, "TESTKIT_PROBE_GONE": "x"}):
            unittest.TestSuite([Leaky("test_sets_and_forgets"), Leaky("test_tidy")]).run(unittest.TestResult())
            self.assertNotIn("TESTKIT_PROBE_LEAK", os.environ)
            self.assertEqual(os.environ.get("TESTKIT_PROBE_GONE"), "x")
        with open(log) as f:
            lines = f.read().splitlines()
        self.assertEqual(len(lines), 1, lines)
        self.assertIn("test_sets_and_forgets: left the environment changed", lines[0])
        self.assertIn("TESTKIT_PROBE_LEAK unset -> '1'", lines[0])
        self.assertIn("TESTKIT_PROBE_GONE 'x' -> unset", lines[0])

    def test_a_tilde_folder_left_in_the_working_folder_names_the_test(self):
        log = os.path.join(tempfile.mkdtemp(prefix="dtest-env-"), "v.log")
        cwd = tempfile.mkdtemp(prefix="dtest-cwd-")
        self.addCleanup(shutil.rmtree, os.path.dirname(log), True)
        self.addCleanup(shutil.rmtree, cwd, True)

        class GoTool(unittest.TestCase):
            def test_runs_bd_without_home(self):
                subprocess.run(["/bin/mkdir", "-p", os.path.join(cwd, "~", ".config", "bd")], timeout=30)  # what bd does

        old = os.getcwd()
        os.chdir(cwd)
        self.addCleanup(os.chdir, old)
        with mock.patch.dict(os.environ, {"TESTKIT_VIOLATIONS": log}):
            GoTool("test_runs_bd_without_home").run(unittest.TestResult())
        with open(log) as f:
            self.assertIn("GoTool.test_runs_bd_without_home: a literal ~ folder appeared", f.read())

    def test_no_agent_marker_of_the_caller_reaches_the_suite(self):
        """The suite runs the same in a terminal and inside an agent's session: every variable an engine sets for
        the commands it runs is gone."""
        import engines
        markers = {m for e in engines.known() for m in e.env_markers}
        self.assertLessEqual(markers, set(testkit.SESSION_VARS))
        self.assertEqual([k for k in testkit.start_env() if k in markers], [])

    def test_a_thread_of_dispatch_code_left_running_names_the_test(self):
        """A loop of the CLI a test started and did not stop goes on inside the tests after it (10-07: chatd's
        keep-awake and banner loops); one that ends within the grace, or a test's own helper thread, is fine."""
        import awake
        import notify_watch
        log = os.path.join(tempfile.mkdtemp(prefix="dtest-thr-"), "v.log")
        self.addCleanup(shutil.rmtree, os.path.dirname(log), True)
        stop = threading.Event()
        self.addCleanup(stop.set)

        class Threads(unittest.TestCase):
            def test_leaves_a_loop(self):
                threading.Thread(target=notify_watch.loop, kwargs={"delay": 3600, "stop": stop}, name="banners-probe", daemon=True).start()

            def test_stops_its_loop(self):
                done = threading.Event(); done.set()
                threading.Thread(target=awake.loop, kwargs={"stop": done, "holder": mock.Mock()}, daemon=True).start()

            def test_own_helper(self):
                threading.Thread(target=stop.wait, daemon=True).start()

        with mock.patch.dict(os.environ, {"TESTKIT_VIOLATIONS": log}):
            for name in ("test_leaves_a_loop", "test_stops_its_loop", "test_own_helper"):
                Threads(name).run(unittest.TestResult())
        with open(log) as f:
            lines = f.read().splitlines()
        self.assertEqual(len(lines), 1, lines)
        self.assertIn("Threads.test_leaves_a_loop: left a thread running: banners-probe (notify_watch.py loop)", lines[0])

    def test_a_signal_handler_left_behind_names_the_test_and_is_put_back(self):
        """A SIGTERM handler a test installs in the test process and leaves there swallows SIGTERM and Ctrl-C for
        the rest of the run (10-07: the suite went on after a SIGTERM)."""
        import signal
        log = os.path.join(tempfile.mkdtemp(prefix="dtest-sig-"), "v.log")
        self.addCleanup(shutil.rmtree, os.path.dirname(log), True)
        before = signal.getsignal(signal.SIGTERM)

        class Signals(unittest.TestCase):
            def test_takes_sigterm(self):
                signal.signal(signal.SIGTERM, lambda *a: None)

            def test_puts_it_back(self):
                old = signal.signal(signal.SIGTERM, lambda *a: None)
                signal.signal(signal.SIGTERM, old)

        with mock.patch.dict(os.environ, {"TESTKIT_VIOLATIONS": log}):
            for name in ("test_takes_sigterm", "test_puts_it_back"):
                Signals(name).run(unittest.TestResult())
        self.assertIs(signal.getsignal(signal.SIGTERM), before)
        with open(log) as f:
            lines = f.read().splitlines()
        self.assertEqual(len(lines), 1, lines)
        self.assertIn("Signals.test_takes_sigterm: left the signal handlers changed: SIGTERM (put back)", lines[0])

    def test_the_callers_dispatch_settings_do_not_reach_the_suite(self):
        """DISPATCH_LOCAL_BUILD_MIN_FREE=10 in front of `npm run test:py` (10-06) sent the build tests down another path."""
        inherited = [k for k in testkit.start_env() if k.startswith(("DISPATCH_", "BEADS_"))]
        self.assertEqual(sorted(inherited), ["BEADS_DIR", "DISPATCH_IDE_BIN", "DISPATCH_KNOWLEDGE_AUTOCOMMIT", "DISPATCH_LANG"])


@unittest.skipUnless(os.name == "posix", "POSIX only")
class Guard(unittest.TestCase):
    """The guard scripts against a stub instead of the real bd, in their own violation log."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dtest-guard-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.stub = os.path.join(self.tmp, "stub")
        with open(self.stub, "w") as f:
            f.write("#!/bin/sh\necho \"real:$BEADS_DIR:$*\"\n")
        os.chmod(self.stub, 0o755)
        self.log = os.path.join(self.tmp, "v.log")
        self.home_board = os.path.join(self.tmp, "real", ".beads")

    def call(self, tool, *args, beads=None, **extra):
        env = dict(os.environ, TESTKIT_VIOLATIONS=self.log, TESTKIT_REAL_BOARD=self.home_board,
                   TESTKIT_REAL_BD=self.stub, TESTKIT_REAL_DOLT=self.stub, TESTKIT_TEST="fake.test", **extra)
        if beads is None:
            env.pop("BEADS_DIR", None)
        else:
            env["BEADS_DIR"] = beads
        return subprocess.run([os.path.join(BIN, tool)] + list(args), capture_output=True, text=True, env=env, timeout=30)

    def logged(self):
        if not os.path.exists(self.log):
            return ""
        with open(self.log) as f:
            return f.read()

    def board(self, name, meta=None, cfg=None):
        d = os.path.join(self.tmp, name, ".beads")
        os.makedirs(d)
        if meta is not None:
            with open(os.path.join(d, "metadata.json"), "w") as f:
                json.dump(meta, f)
        if cfg is not None:
            with open(os.path.join(d, "config.yaml"), "w") as f:
                f.write(cfg)
        return d

    def test_an_embedded_temp_board_goes_through(self):
        d = self.board("emb", {"backend": "dolt", "dolt_mode": "embedded", "dolt_database": "task"})
        r = self.call("bd", "list", "--json", beads=d)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "real:%s:list --json" % d))
        self.assertEqual(self.logged(), "")

    def test_a_board_that_does_not_exist_yet_goes_through(self):
        d = os.path.join(self.tmp, "fresh", ".beads")
        self.assertEqual(self.call("bd", "init", "--prefix", "task", beads=d).returncode, 0)

    def test_the_real_board_is_refused_and_logged_with_the_test_name(self):
        os.makedirs(self.home_board)
        r = self.call("bd", "memories", "--json", beads=self.home_board)
        self.assertEqual(r.returncode, 97)
        self.assertNotIn("real:", r.stdout)
        self.assertIn("test=fake.test", self.logged())
        self.assertIn("the real task board", self.logged())

    def test_the_default_board_under_home_is_refused_even_when_not_named(self):
        r = self.call("bd", "list", beads=os.path.join(guard.real_home(), "tasks", ".beads"))
        self.assertEqual(r.returncode, 97)

    def test_a_server_mode_board_is_refused(self):
        d = self.board("srv", {"dolt_mode": "server", "dolt_database": "task"})
        self.assertEqual(self.call("bd", "list", beads=d).returncode, 97)
        self.assertIn("server mode", self.logged())

    def test_a_shared_server_config_is_refused(self):
        d = self.board("shr", None, "dolt:\n    mode: server\n    shared-server: true\n")
        self.assertEqual(self.call("bd", "list", beads=d).returncode, 97)
        self.assertIn("shared Dolt server", self.logged())

    def test_bd_without_a_home_is_refused(self):
        d = self.board("nohome", {"backend": "dolt", "dolt_mode": "embedded", "dolt_database": "task"})
        with mock.patch.dict(os.environ, {"TESTKIT_VIOLATIONS": self.log}):  # the start itself is recorded too
            r = self.call("bd", "list", beads=d, HOME="")
        self.assertEqual(r.returncode, 97)
        self.assertIn("./~/.config", self.logged())

    def test_no_beads_dir_is_refused(self):
        self.assertEqual(self.call("bd", "list").returncode, 97)

    def test_init_with_shared_server_is_refused(self):
        d = os.path.join(self.tmp, "x", ".beads")
        self.assertEqual(self.call("bd", "init", "--shared-server", "--prefix", "task", beads=d).returncode, 97)

    def test_dolt_to_the_shared_port_is_refused_other_dolt_goes_through(self):
        port = guard.shared_port()
        self.assertEqual(self.call("dolt", "--host", "127.0.0.1", "--port", port, "sql", "-q", "select 1", beads="").returncode, 97)
        self.assertEqual(self.call("dolt", "--port=" + port, "sql", beads="").returncode, 97)
        self.assertEqual(self.call("dolt", "sql-server", beads="").returncode, 97)
        self.assertEqual(self.call("dolt", "version", beads="").returncode, 0)


if __name__ == "__main__":
    unittest.main()
