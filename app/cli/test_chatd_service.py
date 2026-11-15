# -*- coding: utf-8 -*-
"""`dispatch chatd install|uninstall|status|run` (chatd as a LaunchAgent), the shared plist code in
launchd.py, and chat_client starting the resident chatd when there is no door. launchctl is mocked."""
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest import mock

import chatd
import chat_client
import chatd_service as S
import launchd
from test_chatd import FakeAdapter, SUPPORTED

HERE = os.path.dirname(os.path.abspath(__file__))


def wait_until(cond, timeout=60):
    """True as soon as cond() is; False only after `timeout` seconds. The tests wait for what they need to
    see instead of a fixed pause, which a busy Mac outlasts."""
    end = time.time() + timeout
    while not cond():
        if time.time() > end:
            return False
        time.sleep(0.02)
    return True


class Calls:
    """A side_effect that counts its calls: `seen(n)` waits until the code under test asked n times."""

    def __init__(self, answer):
        self.answer, self.n = answer, 0

    def __call__(self, *a, **k):
        self.n += 1
        return self.answer(*a, **k)

    def seen(self, n):
        return wait_until(lambda: self.n >= n)


class Launchctl:
    """A fake `launchctl` (and `ps`) for launchd.py and chatd_service: records calls, answers print."""

    def __init__(self, loaded=False, pid=None):
        self.calls = []
        self.loaded = loaded
        self.pid = pid

    def __call__(self, args, **kw):
        self.calls.append(list(args))
        if args[0] == "ps":
            return mock.Mock(returncode=0, stdout="", stderr="")
        op = args[1]
        if op == "print":
            if not self.loaded:
                return mock.Mock(returncode=113, stdout="", stderr="Could not find service")
            return mock.Mock(returncode=0, stdout="gui/501/x = {\n\tstate = running\n\tpid = %s\n}\n" % (self.pid or "0"), stderr="")
        if op in ("bootstrap", "load"):
            self.loaded = True
        if op == "bootout":
            self.loaded = False
        return mock.Mock(returncode=0, stdout="", stderr="")

    def ops(self):
        return [c[1] for c in self.calls if c[0] == "launchctl"]


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        self.agents = os.path.join(self.tmp, "LaunchAgents")
        for p in (mock.patch.dict(os.environ, {"DISPATCH_DIR": os.path.join(self.tmp, "d")}),
                  mock.patch.object(launchd.launchd_labels, "LAUNCH_DIR", self.agents)):
            p.start(); self.addCleanup(p.stop)
        self.lc = Launchctl()
        p = mock.patch.object(launchd.subprocess, "run", side_effect=self.lc)
        p.start(); self.addCleanup(p.stop)


class Plist(Base):
    def test_chatd_plist_runs_chatd_run_with_keepalive(self):
        body = S.plist()
        self.assertEqual(body["Label"], S.LABEL)
        self.assertTrue(S.LABEL.endswith(".chatd"))
        self.assertEqual(body["ProgramArguments"], [sys.executable, os.path.join(HERE, "dispatch.py"), "chatd", "run"])
        self.assertIs(body["KeepAlive"], True)
        self.assertIs(body["RunAtLoad"], True)
        self.assertLessEqual(body["ThrottleInterval"], 5)  # back within 5 s after a kill
        self.assertEqual(body["StandardOutPath"], os.path.join(self.tmp, "d", "chatd.log"))
        env = body["EnvironmentVariables"]
        self.assertIn(os.path.join(os.path.expanduser("~"), ".local", "bin"), env["PATH"].split(":"))  # claude
        self.assertIn("/opt/homebrew/bin", env["PATH"].split(":"))  # node, codex
        self.assertEqual(env["DISPATCH_DIR"], os.path.join(self.tmp, "d"))
        plistlib.loads(plistlib.dumps(body))  # serializable
        self.assertNotIn("DISPATCH_LAUNCHD_PREFIX", env)
        with mock.patch.dict(os.environ, {"DISPATCH_LAUNCHD_PREFIX": "dev.dispatch-e2e-x", "DISPATCH_E2E_INSTANCE": "x"}):
            env = S.plist()["EnvironmentVariables"]
        # the job works out its own label from these, so it knows which launchd process is itself
        self.assertEqual((env["DISPATCH_LAUNCHD_PREFIX"], env["DISPATCH_E2E_INSTANCE"]), ("dev.dispatch-e2e-x", "x"))

    def test_serve_plist_keeps_its_shape(self):
        import serve
        body = serve.service_plist()
        self.assertEqual(body["ProgramArguments"], [sys.executable, os.path.join(HERE, "serve.py")])
        self.assertEqual((body["KeepAlive"], body["RunAtLoad"], body["ThrottleInterval"]), (True, True, 10))
        self.assertEqual(set(body["EnvironmentVariables"]), {"PATH", "BEADS_DIR", "PYTHONDONTWRITEBYTECODE"})
        self.assertEqual(body["Label"], serve.LAUNCHD_LABEL)


class Service(Base):
    def test_install_writes_a_private_plist_and_loads_it(self):
        self.lc.pid = 4242
        with mock.patch.object(S.sys, "platform", "darwin"), mock.patch.object(S, "door_owner", return_value=4242):
            st = S.install()
        path = os.path.join(self.agents, S.LABEL + ".plist")
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        with open(path, "rb") as f:
            self.assertEqual(plistlib.load(f)["ProgramArguments"][-2:], ["chatd", "run"])
        self.assertEqual([o for o in self.lc.ops() if o != "print"][:2], ["bootout", "bootstrap"])
        self.assertEqual((st["installed"], st["loaded"], st["pid"], st["door"]), (True, True, 4242, "launchd"))
        self.assertEqual(os.stat(S.log_path()).st_mode & 0o777, 0o600)

    def test_reinstall_waits_for_the_old_job_to_go_before_loading_the_new_one(self):
        # task-0mwh: bootout returns while the old chatd is still closing; a bootstrap then fails with
        # "5: Input/output error" and the reinstalled service was not loaded at all
        lc = self.lc
        lc.loaded, lc.pid = True, 4242
        state = {"closing": 3, "refuse": 1}
        def run(args, **kw):
            if args[:2] == ["launchctl", "bootout"]:
                lc.calls.append(list(args))
                return mock.Mock(returncode=0, stdout="", stderr="")
            if args[:2] == ["launchctl", "print"] and state["closing"]:
                state["closing"] -= 1
                lc.calls.append(list(args))
                if not state["closing"]:
                    lc.loaded = False
                return mock.Mock(returncode=0, stdout="pid = 4242\n", stderr="")
            if args[:2] == ["launchctl", "bootstrap"] and state["refuse"]:
                state["refuse"] -= 1
                lc.calls.append(list(args))
                return mock.Mock(returncode=5, stdout="", stderr="Bootstrap failed: 5: Input/output error")
            return lc(args, **kw)
        with mock.patch.object(launchd.subprocess, "run", side_effect=run), mock.patch.object(launchd.time, "sleep"):
            launchd.install(S.plist())
        ops = self.lc.ops()
        self.assertEqual(ops[0], "bootout")
        self.assertLess(ops.index("print"), ops.index("bootstrap"))  # waited for the old one first
        self.assertEqual(ops.count("bootstrap"), 2)  # and tried again when launchd still said no
        self.assertNotIn("load", ops)
        self.assertTrue(lc.loaded)

    def test_status_names_another_chatd_holding_the_door(self):
        self.lc.loaded, self.lc.pid = True, 10
        os.makedirs(self.agents); open(os.path.join(self.agents, S.LABEL + ".plist"), "w").close()
        with mock.patch.object(S, "door_owner", return_value=99):
            st = S.status()
        self.assertEqual((st["installed"], st["pid"], st["door_pid"], st["door"]), (True, 10, 99, "other"))
        self.assertIn("窗口自己的 chatd", S._text("status", st))

    def test_status_names_a_stray_chatd(self):
        # task-0mwh: an older CLI's `chatd run` started outside launchd holds the door
        self.lc.loaded, self.lc.pid = True, 10
        os.makedirs(self.agents); open(os.path.join(self.agents, S.LABEL + ".plist"), "w").close()
        reg = {"pid": 99, "sessions": {}, "code": {"cli": "/Applications/Dispatch IDE.app/x/cli"}}
        with mock.patch.object(S, "door_owner", return_value=99), mock.patch.object(S, "is_stray", return_value=True), \
                mock.patch.object(S, "_registry", return_value=reg):
            st = S.status()
        self.assertEqual((st["door_pid"], st["door"], st["door_cli"]), (99, "stray", "/Applications/Dispatch IDE.app/x/cli"))
        self.assertIn("没人管的 chatd", S._text("status", st))

    def test_uninstall_unloads_and_removes(self):
        os.makedirs(self.agents); path = os.path.join(self.agents, S.LABEL + ".plist"); open(path, "w").close()
        self.lc.loaded = True
        with mock.patch.object(S, "door_owner", return_value=None):
            st = S.uninstall()
        self.assertFalse(os.path.exists(path))
        self.assertEqual(self.lc.ops()[0], "bootout")
        self.assertFalse(st["installed"])

    def test_launchctl_print_pid(self):
        self.lc.loaded, self.lc.pid = True, 777
        self.assertEqual(launchd.info("x"), {"loaded": True, "pid": 777})
        self.lc.loaded = False
        self.assertEqual(launchd.info("x"), {"loaded": False, "pid": None})


class EnsureRunning(Base):
    def test_not_installed_starts_nothing(self):
        with mock.patch.object(S.sys, "platform", "darwin"):
            self.assertFalse(S.ensure_running())
        self.assertEqual(self.lc.ops(), [])

    def test_installed_but_unloaded_is_loaded_then_kickstarted(self):
        os.makedirs(self.agents); open(os.path.join(self.agents, S.LABEL + ".plist"), "w").close()
        with mock.patch.object(S.sys, "platform", "darwin"), mock.patch.object(S, "wait_door", return_value=True) as w:
            self.assertTrue(S.ensure_running("/x"))
        self.assertEqual(self.lc.ops(), ["print", "bootstrap", "kickstart"])
        kick = [c for c in self.lc.calls if c[1:2] == ["kickstart"]][0]
        self.assertEqual(kick[2:], ["gui/%d/%s" % (os.getuid(), S.LABEL)])  # no -k: a running chatd keeps its sessions
        w.assert_called_once_with(S.START_WAIT, "/x")


class Client(unittest.TestCase):
    """chat_client: no door → kickstart the LaunchAgent once, then connect."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.stop = threading.Event()
        for p in (mock.patch.object(chatd.Chatd, "adapter_class", lambda self, agent: FakeAdapter), mock.patch.object(chatd, "_probe", lambda agent: dict(SUPPORTED)),
                  mock.patch.object(S, "_is_chatd", return_value=True), mock.patch.dict(os.environ, {"DISPATCH_DIR": self.dir}), mock.patch.object(S, "_log")):
            p.start(); self.addCleanup(p.stop)
        self.threads = []
        self.addCleanup(self.join)

    def join(self):
        self.stop.set()
        for t in self.threads:
            t.join(10)

    def start_chatd(self):
        d = SimpleNamespace(HOME=self.dir, DISPATCH_DIR=self.dir, SESS_DIR=self.dir, live_sessions=lambda local_only=False: [])
        t = threading.Thread(target=S.run, kwargs={"stop": self.stop, "d": d}, daemon=True)
        t.start()
        self.threads.append(t)

    def test_no_door_kickstarts_and_retries_once(self):
        calls = []

        def kick(dispatch_dir):  # what launchd does on kickstart: a chatd comes up and opens the door
            calls.append(dispatch_dir)
            self.start_chatd()
            return S.wait_door(5, dispatch_dir)

        with mock.patch.object(chat_client, "start_resident", side_effect=kick):
            with chat_client.ChatClient.connect(self.dir) as c:
                self.assertEqual(c.request("hello")["ev"], "hello")
        self.assertEqual(calls, [self.dir])

    def test_not_installed_says_how_to_install(self):
        with mock.patch.object(chat_client, "start_resident", return_value=False) as st:
            with self.assertRaises(chat_client.NotRunning) as cm:
                chat_client.ChatClient.connect(self.dir)
        st.assert_called_once_with(self.dir)
        self.assertIn("dispatch chatd install", str(cm.exception))

    def test_start_resident_goes_through_launchd(self):
        with mock.patch.object(S, "ensure_running", return_value=True) as er:
            self.assertTrue(chat_client.start_resident(self.dir))
        er.assert_called_once_with(self.dir)
        with mock.patch.object(S, "ensure_running", side_effect=OSError("no launchctl")):
            self.assertFalse(chat_client.start_resident(self.dir))


class Run(unittest.TestCase):
    """`dispatch chatd run`: chatd with no app on stdin."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.d = SimpleNamespace(HOME=self.dir, DISPATCH_DIR=self.dir, SESS_DIR=self.dir, live_sessions=lambda local_only=False: [])
        for p in (mock.patch.object(chatd.Chatd, "adapter_class", lambda self, agent: FakeAdapter), mock.patch.object(chatd, "_probe", lambda agent: dict(SUPPORTED)),
                  mock.patch.dict(os.environ, {"DISPATCH_DIR": self.dir}), mock.patch.object(S, "_log")):
            p.start(); self.addCleanup(p.stop)

    def test_waits_while_another_chatd_holds_the_door_then_serves_until_stopped(self):
        stop = threading.Event()
        owner = {"pid": 12345}  # Dispatch.app's chatd
        asked = Calls(lambda d=None: owner["pid"])
        with mock.patch.object(S, "door_owner", side_effect=asked):
            t = threading.Thread(target=S.run, kwargs={"stop": stop, "poll": 0.05, "d": self.d}, daemon=True)
            t.start()
            self.assertTrue(asked.seen(3))  # it looked, waited and looked again
            self.assertIsNone(chat_client.door(self.dir))  # standing by: no door of its own
            owner["pid"] = None  # the app quit
            self.assertTrue(wait_until(lambda: chat_client.door(self.dir)))
        with mock.patch.object(chat_client, "start_resident", return_value=False):
            with chat_client.ChatClient.connect(self.dir) as c:
                opened = c.request("open", agent="claude-code", cwd=self.dir)
                self.assertEqual(opened["ev"], "opened")
        stop.set()  # SIGTERM
        t.join(10)
        self.assertFalse(t.is_alive())
        with self.assertRaises(chat_client.NotRunning):  # the door closed with it
            chat_client.ChatClient.connect(self.dir, autostart=False)

    def test_the_resident_stops_a_stray_holding_the_door_and_serves(self):
        # task-0mwh: a `chatd run` nothing manages held the door for four days while the resident one waited
        stop = threading.Event()
        owner = {"pid": 12345}
        stopped = []
        def stop_stray(pid, wait=None, log=None):
            stopped.append(pid)
            owner["pid"] = None  # it closed its sessions and quit
            return True
        with mock.patch.object(S, "door_owner", side_effect=lambda d=None: owner["pid"]), \
                mock.patch.object(S.launchd, "info", return_value={"loaded": True, "pid": os.getpid()}), \
                mock.patch.object(S, "is_stray", side_effect=lambda pid, job=None: pid == 12345), \
                mock.patch.object(S, "stop_stray", side_effect=stop_stray):
            t = threading.Thread(target=S.run, kwargs={"stop": stop, "poll": 0.05, "d": self.d}, daemon=True)
            t.start()
            self.assertTrue(wait_until(lambda: chat_client.door(self.dir)))
        self.assertEqual(stopped, [12345])
        self.assertIsNotNone(chat_client.door(self.dir))
        stop.set()
        t.join(10)

    def test_a_chatd_outside_launchd_never_stops_another(self):
        stop = threading.Event()
        asked = Calls(lambda d=None: 12345)
        with mock.patch.object(S, "door_owner", side_effect=asked), \
                mock.patch.object(S.launchd, "info", return_value={"loaded": True, "pid": 777}), \
                mock.patch.object(S, "is_stray", return_value=True), mock.patch.object(S, "stop_stray") as st:
            t = threading.Thread(target=S.run, kwargs={"stop": stop, "poll": 0.05, "d": self.d}, daemon=True)
            t.start()
            self.assertTrue(asked.seen(3))  # it found the other chatd three times and left it alone each time
            stop.set()
            t.join(10)
        st.assert_not_called()

    def test_stopped_while_standing_by_exits_without_serving(self):
        import signal
        before = (signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT))
        stop = threading.Event(); stop.set()
        with mock.patch.object(S, "door_owner", return_value=1), mock.patch.object(chatd, "serve") as serve:
            self.assertEqual(S.run(stop=stop, poll=0.01), 0)
        serve.assert_not_called()
        # its SIGTERM and SIGINT handlers go with it (they swallowed both for the rest of the caller's life)
        self.assertEqual((signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT)), before)

    def test_event_log_keeps_lifecycle_lines_only(self):
        logged = []
        with mock.patch.object(S, "_log", side_effect=logged.append):
            S._event_log(json.dumps({"ev": "opened", "session": "claude-code:s1", "seq": 3}))
            S._event_log(json.dumps({"ev": "delta", "session": "claude-code:s1", "text": "x" * 50}))
            S._event_log("not json")
        self.assertEqual(logged, ["opened session=claude-code:s1"])


class Stray(unittest.TestCase):
    """Telling a stray chatd from the LaunchAgent's and from a window's, and stopping one (real processes)."""

    def spawn(self, *tail, ignore_term=False):
        # the child says when its signal handling is set: a fixed pause was too short on a busy Mac, and a
        # SIGTERM that came before SIG_IGN ended the "ignores SIGTERM" child (-15 where -9 was expected)
        code = ("import signal, sys, time\n" + ("signal.signal(signal.SIGTERM, signal.SIG_IGN)\n" if ignore_term else "")
                + "sys.stdout.write('ready\\n'); sys.stdout.flush()\ntime.sleep(60)")
        p = subprocess.Popen([sys.executable, "-c", code] + list(tail), stdout=subprocess.PIPE, text=True)
        self.addCleanup(lambda: (p.poll() is None and p.kill(), p.stdout.close()))
        self.assertEqual(p.stdout.readline(), "ready\n")
        return p

    def test_chatd_run_outside_launchd_is_a_stray(self):
        p = self.spawn("dispatch.py", "chatd", "run")
        self.assertTrue(S.is_stray(p.pid))
        self.assertFalse(S.is_stray(p.pid, job_pid=p.pid))  # the LaunchAgent's own process

    def test_a_windows_chatd_is_not(self):
        p = self.spawn("dispatch.py", "chatd")  # the window on its stdin, our child: it ends with the window
        self.assertFalse(S.is_stray(p.pid))
        self.assertFalse(S.is_stray(None))

    def test_stop_stray_terms_then_kills(self):
        p = self.spawn("dispatch.py", "chatd", "run")
        self.assertTrue(S.stop_stray(p.pid, wait=5))
        self.assertIsNotNone(p.wait(5))
        q = self.spawn("dispatch.py", "chatd", "run", ignore_term=True)
        said = []
        self.assertTrue(S.stop_stray(q.pid, wait=1, log=said.append))
        self.assertEqual(q.wait(5), -9)
        self.assertTrue(said and "killing it" in said[0])


class EnsureWithResident(unittest.TestCase):
    """`dispatch chatd ensure` (the window's board watch) never starts a second chatd beside the installed
    LaunchAgent: it starts that one."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.base = tmp.name

    # The doubles replace chatd_service's own subprocess, not the module every thread shares: a background
    # thread's `ps` or `bd` caught by a shared Popen double failed these tests (10-06, 10-07).
    def test_installed_resident_is_kickstarted_not_spawned(self):
        with mock.patch.object(S.launchd, "installed", return_value=True), mock.patch.object(S.sys, "platform", "darwin"), \
                mock.patch.object(S, "ensure_running", return_value=True) as er, mock.patch.object(S, "subprocess") as po:
            S.ensure(self.base)
        er.assert_called_once_with(self.base)
        po.Popen.assert_not_called()

    def test_resident_that_does_not_come_up_is_an_error_not_a_stray(self):
        with mock.patch.object(S.launchd, "installed", return_value=True), mock.patch.object(S.sys, "platform", "darwin"), \
                mock.patch.object(S, "ensure_running", return_value=False), mock.patch.object(S, "subprocess") as po:
            with self.assertRaises(RuntimeError):
                S.ensure(self.base)
        po.Popen.assert_not_called()

    def test_a_running_chatd_is_enough(self):
        import chatd
        with mock.patch.object(chatd, "read_registry", return_value={"pid": 1}), mock.patch.object(S, "ensure_running") as er, \
                mock.patch.object(S, "subprocess") as po:
            S.ensure(self.base)
        er.assert_not_called()
        po.Popen.assert_not_called()


class CommandLine(unittest.TestCase):
    def cli(self, *args):
        env = dict(os.environ, DISPATCH_DIR=tempfile.mkdtemp(), PYTHONUTF8="1")
        return subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py")] + list(args), capture_output=True, text=True, timeout=60, env=env)

    def test_status_json(self):
        r = self.cli("chatd", "status", "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        st = json.loads(r.stdout)
        self.assertEqual(st["label"], S.LABEL)
        self.assertIn("installed", st)

    def test_unknown_op_is_refused(self):
        self.assertNotEqual(self.cli("chatd", "restart").returncode, 0)


class Attach(unittest.TestCase):
    """`dispatch chatd` (a window on stdin/stdout) with the LaunchAgent installed: relay to the
    resident chatd instead of starting a second one."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.stop = threading.Event()
        for p in (mock.patch.object(chatd.Chatd, "adapter_class", lambda self, agent: FakeAdapter), mock.patch.object(chatd, "_probe", lambda agent: dict(SUPPORTED)),
                  mock.patch.object(S, "_is_chatd", return_value=True), mock.patch.dict(os.environ, {"DISPATCH_DIR": self.dir}), mock.patch.object(S, "_log")):
            p.start(); self.addCleanup(p.stop)
        d = SimpleNamespace(HOME=self.dir, DISPATCH_DIR=self.dir, SESS_DIR=self.dir, live_sessions=lambda local_only=False: [])
        self.resident = threading.Thread(target=S.run, kwargs={"stop": self.stop, "d": d}, daemon=True)
        self.addCleanup(self.halt)

    def halt(self):
        self.stop.set()
        if self.resident.is_alive():
            self.resident.join(10)

    def lines(self, got, *cmds, before_end=None, until_gone=False):
        """A window's stdin: each command once the answer to the one before it is in `got`, then EOF. With
        until_gone the window keeps saying hello after before_end, until the relay notices its chatd went away
        (a fixed 0.3 s pause for the answers was too short on a busy Mac: EOF came first and "opened" was missing)."""
        def answered(rid):
            return any(json.loads(g).get("request_id") == rid for g in list(got))
        for c in cmds:
            yield json.dumps(c) + "\n"
            if c.get("cmd") != "shutdown" and c.get("request_id"):
                self.assertTrue(wait_until(lambda: answered(c["request_id"])), "no answer to %s" % c)
        if before_end:
            before_end()
        end = time.time() + 60
        while until_gone and time.time() < end:
            yield json.dumps({"cmd": "hello"}) + "\n"
            time.sleep(0.05)

    def test_not_installed_leaves_serving_to_the_caller(self):
        with mock.patch.object(S.launchd, "installed", return_value=False):
            self.assertIsNone(S.attach(read=iter([]), write=lambda l: None, d=self.dir))

    def test_relays_to_the_resident_chatd_and_its_sessions_outlive_the_window(self):
        self.resident.start()
        self.assertTrue(S.wait_door(5, self.dir))
        resident_pid = chatd.read_registry(self.dir)["pid"]
        got = []
        with mock.patch.object(S.launchd, "installed", return_value=True):
            rc = S.attach(read=self.lines(got, {"cmd": "open", "agent": "claude-code", "cwd": self.dir, "request_id": "r1"},
                                          {"cmd": "shutdown", "request_id": "r2"}), write=got.append, d=self.dir)
        evs = [json.loads(g) for g in got]
        self.assertEqual(rc, 0)
        self.assertEqual((evs[0]["ev"], evs[0]["state"], evs[0]["attached"]), ("chatd", "up", True))
        opened = [e for e in evs if e.get("ev") == "opened" and e.get("request_id") == "r1"]
        self.assertEqual(len(opened), 1)
        # still the one chatd, and the window's session lives on in it (chatd.json is written on chatd's next tick)
        self.assertTrue(wait_until(lambda: opened[0]["session"] in (chatd.read_registry(self.dir) or {}).get("sessions", {})))
        self.assertEqual(chatd.read_registry(self.dir)["pid"], resident_pid)
        with chat_client.ChatClient.connect(self.dir, autostart=False) as c:  # the window's `shutdown` did not reach it
            self.assertEqual(c.request("hello")["ev"], "hello")

    def test_resident_going_away_ends_the_relay_with_1(self):
        # a real `dispatch chatd run` process, so that stopping it closes its sockets the way launchd's SIGTERM does
        env = dict(os.environ, DISPATCH_DIR=self.dir, HOME=self.dir, BEADS_DIR=os.path.join(self.dir, "no-board", ".beads"), PYTHONDONTWRITEBYTECODE="1")
        proc = subprocess.Popen([sys.executable, os.path.join(HERE, "dispatch.py"), "chatd", "run"], env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        self.assertTrue(S.wait_door(10, self.dir))

        def sigterm():
            proc.terminate()
            proc.wait(10)
        got = []
        with mock.patch.object(S.launchd, "installed", return_value=True):
            rc = S.attach(read=self.lines(got, {"cmd": "hello", "request_id": "h"}, before_end=sigterm, until_gone=True), write=got.append, d=self.dir)
        self.assertIn("hello", [json.loads(g).get("ev") for g in got])
        self.assertEqual(rc, 1)
        self.assertEqual(json.loads(got[-1])["state"], "down")


class Registry(unittest.TestCase):
    """chatd.json names the chatd clients should reach: a second chatd going down leaves it alone, and
    the door holder puts itself back when the file names a dead chatd."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.d = SimpleNamespace(HOME=self.dir, DISPATCH_DIR=self.dir, SESS_DIR=self.dir, live_sessions=lambda local_only=False: [])
        self.alive = {111: True, 222: True}
        p = mock.patch.object(chatd, "_pid_alive", side_effect=lambda pid: self.alive.get(pid, False)); p.start(); self.addCleanup(p.stop)

    def chatd_as(self, pid, now):
        c = chatd.Chatd(lambda line: None, d=self.d, clock=lambda: now[0])
        c.door = SimpleNamespace(info=lambda: {"port": pid, "token": "t%d" % pid})
        return c

    def named(self):
        return json.load(open(os.path.join(self.dir, "chatd.json")))["pid"]

    def test_a_second_chatd_going_down_does_not_take_the_file_back(self):
        now = [0.0]
        app, resident = self.chatd_as(222, now), self.chatd_as(111, now)
        with mock.patch.object(chatd.os, "getpid", return_value=222):
            app.save_registry(force=True)                 # the app's chatd started first
        with mock.patch.object(chatd.os, "getpid", return_value=111):
            resident.save_registry(force=True)            # the resident took the door after it
        with mock.patch.object(chatd.os, "getpid", return_value=222):
            app.save_registry(force=True)                 # the app quits: its last write
        self.assertEqual(self.named(), 111)

    def test_the_door_holder_puts_itself_back_over_a_dead_chatd(self):
        now = [0.0]
        resident, app = self.chatd_as(111, now), self.chatd_as(222, now)
        with mock.patch.object(chatd.os, "getpid", return_value=111):
            resident.save_registry(force=True)
        with mock.patch.object(chatd.os, "getpid", return_value=222):
            app.save_registry(force=True)                 # an older build's chatd wrote over it, then died
        self.alive[222] = False
        with mock.patch.object(chatd.os, "getpid", return_value=111):
            resident.save_registry()                      # within REGISTRY_CHECK of its last look: not yet
            self.assertEqual(self.named(), 222)
            now[0] += chatd.REGISTRY_CHECK
            resident.save_registry()
        self.assertEqual(self.named(), 111)

    def test_a_live_owner_is_left_alone(self):
        now = [0.0]
        resident, app = self.chatd_as(111, now), self.chatd_as(222, now)
        with mock.patch.object(chatd.os, "getpid", return_value=111):
            resident.save_registry(force=True)
        with mock.patch.object(chatd.os, "getpid", return_value=222):
            app.save_registry(force=True)                 # first write: it takes the door (as before)
        now[0] += chatd.REGISTRY_CHECK
        with mock.patch.object(chatd.os, "getpid", return_value=111):
            resident.save_registry()
        self.assertEqual(self.named(), 222)


if __name__ == "__main__":
    unittest.main()
