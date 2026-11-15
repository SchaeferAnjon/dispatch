# -*- coding: utf-8 -*-
"""`dispatch computer`: finding the helper, asking before starting, finding things by name, and the
answers an agent gets. DISPATCH_COMPUTER_E2E=1 also builds the real helper and drives its practice app
(needs Apple's swiftc and the Accessibility permission for the app the tests run in)."""
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import computer as C  # noqa: E402

TREE = "\n".join([
    '[1] window "Practice Notes"',
    '  [2] text field "Note" (focused)',
    '  [3] button "Save"',
    '  [4] text "Nothing saved yet"',
    '  [5] text "Note taking"',
    '  [6] button "Save as"',
    '  [7] row',
])


class FakeHelper(threading.Thread):
    """Answers on the session socket like the native helper does."""

    def __init__(self, path, reply):
        threading.Thread.__init__(self, daemon=True)
        self.path, self.reply, self.seen = path, reply, []
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(path)
        self.srv.listen(4)
        self.srv.settimeout(0.2)
        self.stop = False

    def run(self):
        while not self.stop:
            try:
                c, _ = self.srv.accept()
            except OSError:
                continue
            data = b""
            while not data.endswith(b"\n"):
                chunk = c.recv(65536)
                if not chunk:
                    break
                data += chunk
            req = json.loads(data)
            self.seen.append(req)
            c.sendall((json.dumps(self.reply(req)) + "\n").encode())
            c.close()
        self.srv.close()


class ComputerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="cu-", dir="/tmp")  # short: the socket path must fit 104 bytes
        self.env = mock.patch.dict(os.environ, {"DISPATCH_DIR": self.tmp, "DISPATCH_IDE_BIN": "", "DISPATCH_COMPUTER_BIN": ""})
        self.env.start()
        self.apptools = mock.patch.object(C, "APP_TOOLS", os.path.join(self.tmp, "no-app"))
        self.apptools.start()
        os.makedirs(C.state_dir(), exist_ok=True)

    def tearDown(self):
        self.apptools.stop()
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def cli(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), mock.patch.object(C.sys, "platform", "darwin"):
            rc = C.main(argv)
        return rc, out.getvalue(), err.getvalue()

    def write_state(self, **st):
        st.setdefault("pid", os.getpid())
        with open(C.state_file(), "w") as f:
            json.dump(st, f)

    # -- names ---------------------------------------------------------------------------------

    def test_a_name_finds_the_kind_of_thing_the_action_is_for(self):
        self.assertEqual(C.index_for("Note", TREE, "fill"), 2)
        self.assertEqual(C.index_for("save", TREE), 3)       # exact name before "Save as"
        self.assertEqual(C.index_for("Save a", TREE), 6)     # a name that starts with it
        self.assertEqual(C.index_for("practice", TREE), 1)
        self.assertEqual(C.index_for("12", TREE), 12)        # a number is taken as is
        self.assertIsNone(C.index_for("Delete", TREE))
        self.assertIsNone(C.index_for("Save", ""))

    # -- the helper ----------------------------------------------------------------------------

    def fake_helper(self, folder, protocol):
        """A helper that answers `version` like the real one (protocol None: an old one that can't)."""
        os.makedirs(folder, exist_ok=True)
        h = os.path.join(folder, "dispatch-computer")
        with open(h, "w") as f:
            f.write("#!/bin/sh\n" + ('echo \'{"ok":true,"protocol":%d}\'\n' % protocol if protocol else "echo usage; exit 2\n"))
        os.chmod(h, 0o755)
        return h

    def test_the_helper_inside_dispatch_ide_comes_first(self):
        tools = os.path.join(self.tmp, "tools")
        h = self.fake_helper(tools, C.PROTOCOL)
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_BIN": tools}):
            self.assertEqual(C.helper_path(compile_missing=False), h)
        with mock.patch.dict(os.environ, {"DISPATCH_COMPUTER_BIN": "/x/helper", "DISPATCH_IDE_BIN": tools}):
            self.assertEqual(C.helper_path(), "/x/helper")

    def test_without_one_it_is_compiled_once_from_the_source(self):
        calls = []

        def run(argv, **kw):
            calls.append(argv)
            open(argv[argv.index("-o") + 1], "w").close()
            return subprocess.CompletedProcess(argv, 0, "", "")

        with mock.patch.object(C.shutil, "which", return_value="/usr/bin/swiftc"), redirect_stderr(io.StringIO()):
            p1 = C.helper_path(run=run)
            p2 = C.helper_path(run=run)
        self.assertEqual(p1, p2)
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0][-1].endswith("DispatchComputer.swift"))
        self.assertTrue(p1.startswith(os.path.join(C.state_dir(), "bin", "dispatch-computer-")))

    def test_an_older_helper_inside_dispatch_ide_gives_way_to_the_source(self):
        # a Dispatch IDE built before drag and menus: the CLI next to the source compiles a new one
        tools = os.path.join(self.tmp, "tools")
        old = self.fake_helper(tools, None)
        self.assertEqual(C.helper_protocol(old), 1)
        calls = []

        def run(argv, **kw):
            if argv[-1] == "version":
                return subprocess.run(argv, **kw)
            calls.append(argv)
            open(argv[argv.index("-o") + 1], "w").close()
            return subprocess.CompletedProcess(argv, 0, "", "")
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_BIN": tools}), mock.patch.object(C.shutil, "which", return_value="/usr/bin/swiftc"), \
                redirect_stderr(io.StringIO()):
            got = C.helper_path(run=run)
        self.assertNotEqual(got, old)
        self.assertEqual(len(calls), 1)
        # no compiler: the older one still beats none
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_BIN": tools}), mock.patch.object(C.shutil, "which", return_value=None):
            shutil.rmtree(os.path.join(C.state_dir(), "bin"))
            self.assertEqual(C.helper_path(), old)

    def test_no_compiler_says_what_to_install(self):
        with mock.patch.object(C.shutil, "which", return_value=None):
            with self.assertRaises(C.ComputerError) as e:
                C.helper_path()
        self.assertIn("xcode-select --install", str(e.exception))

    def test_the_agents_own_icon(self):
        media = os.path.join(self.tmp, "app", "out", "media")
        tools = os.path.join(self.tmp, "app", "tools")
        os.makedirs(media)
        os.makedirs(tools)
        for f in ("codicon.ttf", "dispatch-icons.ttf"):
            open(os.path.join(media, f), "w").close()
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_BIN": tools}):
            self.assertEqual(C.icon_args("claude"), ["--icon-font", os.path.join(media, "codicon.ttf"), "--icon-char", ""])
            self.assertEqual(C.icon_args("opencode")[1], os.path.join(media, "dispatch-icons.ttf"))
            self.assertEqual(C.icon_args("agent"), [])

    # -- start ---------------------------------------------------------------------------------

    def fake_popen(self, status, **extra):
        seen = []

        def popen(argv, **kw):
            seen.append(argv)
            self.write_state(status=status, app="Notes", agent=argv[argv.index("--agent") + 1], **extra)
            return mock.Mock(poll=lambda: None)
        return popen, seen

    def test_start_asks_and_reports_the_answer(self):
        popen, seen = self.fake_popen("running")
        with mock.patch.dict(os.environ, {"DISPATCH_COMPUTER_BIN": "/x/helper"}):
            st = C.start("Notes", "paste the minutes", "claude", popen=popen, sleep=lambda s: None)
        self.assertTrue(st["ok"])
        argv = seen[0]
        self.assertEqual(argv[:2], ["/x/helper", "serve"])
        self.assertEqual(argv[argv.index("--why") + 1], "paste the minutes")
        self.assertEqual(argv[argv.index("--app") + 1], "Notes")

    def test_a_no_is_not_ok_and_says_not_to_ask_again(self):
        popen, _ = self.fake_popen("denied", message="The person said no. Do not ask again for this.")
        with mock.patch.dict(os.environ, {"DISPATCH_COMPUTER_BIN": "/x/helper"}):
            st = C.start("Notes", "x", "codex", popen=popen, sleep=lambda s: None)
        self.assertFalse(st["ok"])
        self.assertIn("Do not ask again", st["message"])

    def test_always_allow_skips_the_question_next_time_until_forgotten(self):
        # the person pressed Always Allow once: the next start for that app asks nothing (kanban memo 2026-10-19)
        popen, seen = self.fake_popen("running", always=True)
        with mock.patch.dict(os.environ, {"DISPATCH_COMPUTER_BIN": "/x/helper"}):
            C.start("notes", "x", "claude", popen=popen, sleep=lambda s: None)
            self.assertNotIn("--preapproved", seen[0])
            self.assertEqual(C.allowed_apps(), ["notes"])
            self.write_state(status="stopped", app="Notes")
            C.start("Notes", "x", "claude", popen=popen, sleep=lambda s: None)
            self.assertIn("--preapproved", seen[1])
            rc, out, _ = self.cli(["allowed", "--forget", "notes", "--json"])
            self.assertEqual(json.loads(out)["apps"], [])
            self.write_state(status="stopped", app="Notes")
            C.start("Notes", "x", "claude", popen=popen, sleep=lambda s: None)
            self.assertNotIn("--preapproved", seen[2])

    def test_forgetting_the_name_the_person_saw_also_forgets_the_name_asked_for(self):
        # asked for "notes app", the window said "Notes": the started-without-asking line names "Notes", so
        # --forget "Notes" must ask again for "notes app" too (code review 2026-10-22)
        popen, seen = self.fake_popen("running", always=True)
        with mock.patch.dict(os.environ, {"DISPATCH_COMPUTER_BIN": "/x/helper"}):
            C.start("notes app", "x", "claude", popen=popen, sleep=lambda s: None)
            self.assertEqual(C.allowed_apps(), ["Notes", "notes app"])
            rc, out, _ = self.cli(["allowed", "--forget", "Notes", "--json"])
            self.assertEqual(json.loads(out)["apps"], [])
            self.write_state(status="stopped", app="Notes")
            C.start("notes app", "x", "claude", popen=popen, sleep=lambda s: None)
            self.assertNotIn("--preapproved", seen[1])

    def test_forgetting_follows_names_linked_through_several_saves(self):
        # second review 10-22: "com.apple.Notes" and "Note" were each saved with "Notes"; --forget Note drops all three
        C.save_allowed(["com.apple.Notes", "Notes", "Note"], same=[["com.apple.Notes", "Notes"], ["Note", "Notes"]])
        C.forget_allowed("Note")
        self.assertEqual(C.allowed_apps(), [])
        self.assertFalse(C.is_allowed("com.apple.Notes"))

    def test_the_master_switch_lets_every_app_through_without_asking(self):
        # Settings > Agents: "agree once and it can work on its own" (kanban memo 2026-10-19, item 18)
        popen, seen = self.fake_popen("running")
        with mock.patch.dict(os.environ, {"DISPATCH_COMPUTER_BIN": "/x/helper"}):
            rc, out, _ = self.cli(["allowed", "--all", "on", "--json"])
            self.assertEqual(json.loads(out)["all"], True)
            C.start("Finder", "x", "claude", popen=popen, sleep=lambda s: None)
            self.assertIn("--preapproved", seen[0])
            self.cli(["allowed", "--all", "off", "--json"])
            self.write_state(status="stopped", app="Finder")
            C.start("Finder", "x", "claude", popen=popen, sleep=lambda s: None)
            self.assertNotIn("--preapproved", seen[1])

    def test_start_needs_an_app_and_a_reason(self):
        rc, _, err = self.cli(["start", "Notes"])
        self.assertEqual(rc, 1)
        self.assertIn("--why", err)

    def test_no_second_window_while_the_person_is_being_asked(self):
        self.write_state(status="asking", app="Notes")
        popen = mock.Mock()
        st = C.start("Notes", "x", "claude", popen=popen, sleep=lambda s: None)
        popen.assert_not_called()
        self.assertFalse(st["ok"])
        self.assertIn("wait for their answer", st["message"])

    def test_the_same_app_again_is_not_asked_twice(self):
        self.write_state(status="running", app="Notes", query="notes")
        popen = mock.Mock()
        st = C.start("Notes", "x", "claude", popen=popen, sleep=lambda s: None)
        popen.assert_not_called()
        self.assertTrue(st["ok"] and st["already"])

    # -- acting ----------------------------------------------------------------------------------

    def test_click_by_name_looks_first_then_clicks_the_number(self):
        h = FakeHelper(C.socket_path(), lambda r: {"ok": True, "text": TREE} if r["cmd"] == "look" else {"ok": True, "did": "pressed Save"})
        h.start()
        try:
            rc, out, err = self.cli(["click", "Save"])
            rc2, _, _ = self.cli(["fill", "Note", "hello"])
        finally:
            h.stop = True
        self.assertEqual((rc, rc2), (0, 0), err)
        self.assertEqual(out.strip(), "好了：pressed Save")
        self.assertEqual([r["cmd"] for r in h.seen], ["look", "click", "look", "fill"])
        self.assertEqual(h.seen[1]["index"], 3)
        self.assertEqual(h.seen[3], {"cmd": "fill", "index": 2, "value": "hello"})

    def test_points_names_and_menu_paths(self):
        self.assertEqual(C.point("120,340"), (120.0, 340.0))
        self.assertEqual(C.point(" 12.5 , -3 "), (12.5, -3.0))
        self.assertIsNone(C.point("12"))
        self.assertIsNone(C.point("Save"))
        self.assertEqual(C.menu_path(["File", "New Folder"]), ["File", "New Folder"])
        self.assertEqual(C.menu_path(["File > New Folder"]), ["File", "New Folder"])
        self.assertEqual(C.menu_path(["文件 › 新建文件夹"]), ["文件", "新建文件夹"])
        self.assertEqual(C.menu_path([]), [])

    def test_click_at_a_point_double_and_right(self):
        h = FakeHelper(C.socket_path(), lambda r: {"ok": True, "text": TREE} if r["cmd"] == "look" else {"ok": True, "did": "clicked", "note": "looked greyed"})
        h.start()
        try:
            rc, out, err = self.cli(["click", "120,340", "--double"])
            self.cli(["click", "Save", "--right"])
        finally:
            h.stop = True
        self.assertEqual(rc, 0, err)
        self.assertIn("looked greyed", out)  # a note from the helper reaches the agent
        self.assertEqual(h.seen[0], {"cmd": "click", "x": 120.0, "y": 340.0, "button": "left", "count": 2})
        self.assertEqual(h.seen[1], {"cmd": "look", "quiet": True})  # a name: looked up without a step of its own
        self.assertEqual(h.seen[2], {"cmd": "click", "index": 3, "button": "right", "count": 1})

    def test_drag_looks_once_for_both_ends(self):
        tree = TREE + '\n  [8] text field = "notes.txt"\n  [9] text field = "Archive"'
        h = FakeHelper(C.socket_path(), lambda r: {"ok": True, "text": tree} if r["cmd"] == "look" else {"ok": True, "did": "dragged"})
        h.start()
        try:
            rc, _, err = self.cli(["drag", "notes.txt", "Archive"])
            rc2, _, _ = self.cli(["drag", "10,20", "300,40"])
        finally:
            h.stop = True
        self.assertEqual((rc, rc2), (0, 0), err)
        self.assertEqual([r["cmd"] for r in h.seen], ["look", "drag", "drag"])
        self.assertEqual(h.seen[1], {"cmd": "drag", "from": {"index": 8}, "to": {"index": 9}})
        self.assertEqual(h.seen[2], {"cmd": "drag", "from": {"x": 10.0, "y": 20.0}, "to": {"x": 300.0, "y": 40.0}})

    def test_menu_lists_or_chooses(self):
        h = FakeHelper(C.socket_path(), lambda r: {"ok": True, "text": "文件:\n  新建文件夹  (shift+cmd+n)"} if len(r["path"]) < 2 else {"ok": True, "did": "chose 文件 › 新建文件夹"})
        h.start()
        try:
            rc, out, _ = self.cli(["menu", "文件"])
            rc2, out2, _ = self.cli(["menu", "文件 > 新建文件夹"])
        finally:
            h.stop = True
        self.assertEqual((rc, rc2), (0, 0))
        self.assertIn("新建文件夹  (shift+cmd+n)", out)
        self.assertEqual(out2.strip(), "好了：chose 文件 › 新建文件夹")
        self.assertEqual(h.seen[1]["path"], ["文件", "新建文件夹"])

    def test_a_locked_screen_is_said_plainly(self):
        popen, _ = self.fake_popen("screen-locked", message="The screen is locked")
        with mock.patch.dict(os.environ, {"DISPATCH_COMPUTER_BIN": "/x/helper"}):
            st = C.start("Notes", "x", "claude", popen=popen, sleep=lambda s: None)
        self.assertFalse(st["ok"])
        self.assertEqual(st["status"], "screen-locked")
        h = FakeHelper(C.socket_path(), lambda r: {"ok": False, "code": "screen-locked", "error": "The screen is locked"})
        h.start()
        try:
            rc, out, err = self.cli(["click", "3"])
            rc2, _, err2 = self.cli(["look"])
        finally:
            h.stop = True
        self.assertEqual((rc, rc2), (1, 1))
        self.assertIn("屏幕锁着：解锁后再试", err)
        self.assertIn("屏幕锁着", err2)

    def test_after_the_person_stops_the_agent_hears_it_and_where_to_look_back(self):
        self.write_state(status="stopped", reason="person", app="访达", steps=7, page="/r/index.html", pid=999999)
        rc, _, err = self.cli(["look"])
        self.assertEqual(rc, 1)
        self.assertIn("用户按了 Stop 或 Esc", err)
        self.assertIn("做了 7 步，回看：/r/index.html", err)
        rc, out, _ = self.cli(["status"])
        self.assertIn("回看：/r/index.html", out)

    def test_stop_says_how_many_steps_and_where_to_look_back(self):
        h = FakeHelper(C.socket_path(), lambda r: (self.write_state(status="stopped", reason="agent", app="Notes", steps=4, page="/r/i.html"), {"ok": True})[1])
        h.start()
        try:
            rc, out, _ = self.cli(["stop"])
        finally:
            h.stop = True
        self.assertEqual(rc, 0)
        self.assertIn("这次做了 4 步", out)
        self.assertIn("/r/i.html", out)

    def test_each_session_has_a_folder_and_is_filed_with_the_conversation(self):
        with mock.patch.dict(os.environ, {"CLAUDE_CODE_SESSION_ID": "s-1"}):
            now = time.time()
            run = C.new_run("Notes", "write a note", "claude", now=now)
        with open(os.path.join(run, "run.json")) as f:
            meta = json.load(f)
        self.assertEqual((meta["app"], meta["session"], meta["folder"]), ("Notes", "s-1", os.getcwd()))
        # the helper wrote the steps (the start, three steps, the end) and the page
        with open(os.path.join(run, "steps.json"), "w") as f:
            json.dump({"app": "备忘录", "agent": "claude", "ended": "Claude finished", "steps": [{}] * 5}, f)
        open(os.path.join(run, "index.html"), "w").close()
        seen = []
        r = C.record(run, run_cmd=lambda argv, **kw: (seen.append(argv), subprocess.CompletedProcess(argv, 0, "{}", ""))[1])
        self.assertTrue(r["filed"])
        self.assertEqual(r["title"], "Claude used 备忘录: 3 steps")
        argv = seen[0]
        self.assertEqual(argv[2:5], ["docs", "add", os.path.join(run, "index.html")])
        self.assertEqual(argv[argv.index("--session") + 1], "s-1")
        self.assertEqual(argv[argv.index("--folder") + 1], os.getcwd())
        # a second session in the same second gets its own folder; folders older than 30 days go
        self.assertNotEqual(C.new_run("Notes", "x", "claude", now=now), run)
        os.utime(run, (1, 1))
        C.new_run("Notes", "x", "claude", now=now + 1)
        self.assertFalse(os.path.exists(run))

    def test_nothing_running_says_how_to_start(self):
        rc, out, err = self.cli(["look", "--json"])
        self.assertEqual(rc, 1)
        self.assertEqual(json.loads(out)["code"], "not-running")

    def test_the_helpers_refusal_reaches_the_agent(self):
        h = FakeHelper(C.socket_path(), lambda r: {"ok": False, "error": "Esc is the person's stop key, so agents don't press it."})
        h.start()
        try:
            rc, _, err = self.cli(["press", "Esc"])
        finally:
            h.stop = True
        self.assertEqual(rc, 1)
        self.assertIn("stop key", err)

    def test_only_on_macos(self):
        out = io.StringIO()
        with redirect_stdout(out), mock.patch.object(C.sys, "platform", "linux"):
            rc = C.main(["check", "--json"])
        self.assertEqual(rc, 1)
        self.assertTrue(json.loads(out.getvalue())["unsupported"])


@unittest.skipUnless(os.environ.get("DISPATCH_COMPUTER_E2E") == "1" and sys.platform == "darwin" and shutil.which("swiftc"), "DISPATCH_COMPUTER_E2E=1 on a Mac with swiftc")
class RealHelperTest(unittest.TestCase):
    """The real helper against its practice app, every window off screen."""

    def test_allow_fill_save_stop(self):
        tmp = tempfile.mkdtemp(prefix="cue-", dir="/tmp")
        try:
            helper = os.path.join(tmp, "dispatch-computer")
            subprocess.run(["swiftc", "-O", "-swift-version", "5", "-o", helper, C.source_file()], check=True, capture_output=True, timeout=600)
            locked = os.path.join(tmp, "locked")
            env = {"DISPATCH_DIR": tmp, "DISPATCH_COMPUTER_BIN": helper, "DISPATCH_COMPUTER_SELFTEST": "1", "DISPATCH_COMPUTER_OFFSCREEN": "1",
                   "DISPATCH_IDE_BIN": "", "DISPATCH_COMPUTER_PRETEND_LOCKED": locked, "CLAUDE_CODE_SESSION_ID": "", "DISPATCH_SESSION_ID": ""}
            here = os.getcwd()
            os.chdir(tmp)  # not a project: the session's page is not filed anywhere
            self.addCleanup(os.chdir, here)
            with mock.patch.dict(os.environ, env):
                self.assertGreaterEqual(C.helper_protocol(helper), C.PROTOCOL)
                if not json.loads(subprocess.run([helper, "check"], capture_output=True, text=True).stdout)["accessibility"]:
                    self.skipTest("no Accessibility permission for the app these tests run in")
                notes = subprocess.Popen([helper, "practice", "--out", os.path.join(tmp, "practice.json")])
                try:
                    time.sleep(1)
                    # the screen is locked: no question nobody can see, a plain answer at once
                    open(locked, "w").close()
                    st = C.start("pid:%d" % notes.pid, "write a test note", "claude", wait=20)
                    self.assertEqual(st["status"], "screen-locked")
                    os.remove(locked)
                    answer = threading.Timer(1.5, lambda: C.request({"cmd": "ui", "button": "Allow"}))
                    answer.start()
                    st = C.start("pid:%d" % notes.pid, "write a test note", "claude", wait=20)
                    self.assertEqual(st["status"], "running")
                    self.assertGreaterEqual(C.helper_protocol(helper), 2)
                    framed = C.request({"cmd": "look", "frames": True})["text"]
                    self.assertRegex(framed, r'\[1\] window "Practice Notes" @0,0 \d+x\d+')
                    self.assertRegex(framed, r'button "Save" @\d+,\d+ \d+x\d+')
                    self.assertTrue(C.request({"cmd": "fill", "index": C.resolve("Note", "fill"), "value": "hi"})["ok"])
                    self.assertTrue(C.request({"cmd": "click", "index": C.resolve("Save", "click")})["ok"])
                    time.sleep(0.3)
                    with open(os.path.join(tmp, "practice.json")) as f:
                        self.assertEqual(json.load(f)["saved"], "Saved: hi")
                    # a point that is not on the app is refused
                    far = C.request({"cmd": "click", "x": 5000, "y": 5000})
                    self.assertFalse(far["ok"])
                    # the screen locks in the middle: the next command says so
                    open(locked, "w").close()
                    self.assertEqual(C.request({"cmd": "look"})["code"], "screen-locked")
                    os.remove(locked)
                    # the steps, in plain words, newest first; name lookups are not steps
                    run = C.read_state().get("socket") and sorted(os.listdir(C.runs_dir()))[-1]
                    with open(os.path.join(C.runs_dir(), run, "steps.json")) as f:
                        texts = [x["text"] for x in json.load(f)["steps"]]
                    self.assertEqual(texts[:4], ["Tried to look at the window: The screen is locked, so apps show no windows and nobody can answer",
                                                 "Tried to click the point 5000, 5000: Nothing of Practice Notes is at " + far["error"].split(" is at ")[1].rstrip("."),
                                                 "Clicked “Save”", "Filled “Note” with “hi”"])
                    self.assertEqual(texts[-1], "You allowed Claude to use Practice Notes")
                    # a click on the bar keeps the list open
                    self.assertTrue(C.request({"cmd": "ui", "button": "Pin steps"})["pinned"])
                    self.assertTrue(C.request({"cmd": "ping"})["expanded"])
                    C.request({"cmd": "ui", "button": "Stop"})
                    time.sleep(0.3)
                    self.assertEqual(C.read_state()["reason"], "person")
                    self.assertTrue(C.read_state()["page"].endswith("index.html"))
                    with self.assertRaises(C.ComputerError):
                        time.sleep(1.5)
                        C.request({"cmd": "look"})
                finally:
                    notes.terminate()
                    notes.wait()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
