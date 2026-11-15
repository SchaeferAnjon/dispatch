# -*- coding: utf-8 -*-
"""project_create.py: start a project by name, copy one from a web address, and say what went wrong in words."""
import argparse
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import project_create as PC  # noqa: E402
import projects_view as PV  # noqa: E402
from test_projects_view import fake_dispatch  # noqa: E402

# a Mac where git has never been told who you are: no config files, and no guessing the name from the login
GIT_ENV = {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_COUNT": "1",
           "GIT_CONFIG_KEY_0": "user.useConfigOnly", "GIT_CONFIG_VALUE_0": "true"}
# the same Mac once the person gave git their name and email (the setup wizard asks, task-pog4t)
GIT_ENV_KNOWN = dict(GIT_ENV, GIT_CONFIG_COUNT="3", GIT_CONFIG_KEY_1="user.name", GIT_CONFIG_VALUE_1="Ada Lovelace",
                     GIT_CONFIG_KEY_2="user.email", GIT_CONFIG_VALUE_2="ada@example.org")


def git(*args, cwd=None):
    env = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1")
    return subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True, check=True).stdout


def make_source(root, name="Hello-World"):
    """A small repository to copy from: one commit, a README."""
    src = os.path.join(root, name)
    os.makedirs(src)
    git("init", "-q", "-b", "main", cwd=src)
    with open(os.path.join(src, "README"), "w") as f:
        f.write("hello\n")
    git("add", ".", cwd=src)
    git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "first", cwd=src)
    return src


def registered(rows):
    def reg(folder, name):
        rows.append((folder, name))
        return {"ok": True, "name": name, "label": name, "dir": folder, "git": True}
    return reg


class Names(unittest.TestCase):
    def test_a_name_cannot_leave_its_folder(self):
        for bad in ("", "   ", "a/b", "a\\b", "..", ".", ".hidden", "-x", "a:b", "x" * 101, "line\nbreak"):
            with self.assertRaises(PC.ProjectError, msg=repr(bad)) as cm:
                PC.check_name(bad)
            self.assertEqual(cm.exception.code, "bad_name")
        self.assertEqual(PC.check_name("  My   app "), "My app")
        self.assertEqual(PC.check_name("讲书 2"), "讲书 2")

    def test_the_parent_defaults_to_projects_in_home(self):
        self.assertEqual(PC.resolve_parent("", home="/Users/me"), "/Users/me/Projects")
        self.assertEqual(PC.resolve_parent("~/Code", home="/Users/me"), "/Users/me/Code")
        self.assertEqual(PC.resolve_parent("/x/y/", home="/Users/me"), "/x/y")
        with self.assertRaises(PC.ProjectError):
            PC.resolve_parent("relative/dir")


class Addresses(unittest.TestCase):
    def test_what_is_accepted(self):
        self.assertEqual(PC.parse_address(" https://github.com/octocat/Hello-World "), "https://github.com/octocat/Hello-World")
        self.assertEqual(PC.parse_address("git@github.com:octocat/Hello-World.git"), "git@github.com:octocat/Hello-World.git")
        self.assertEqual(PC.parse_address("github.com/octocat/Hello-World"), "https://github.com/octocat/Hello-World")
        self.assertEqual(PC.parse_address("/Users/me/Projects/x"), "/Users/me/Projects/x")

    def test_what_is_not(self):
        for bad in ("", "hello", "octocat/Hello-World", "--upload-pack=touch /tmp/x", "ext::sh -c touch% /tmp/x", "https://a b"):
            with self.assertRaises(PC.ProjectError, msg=repr(bad)) as cm:
                PC.parse_address(bad)
            self.assertEqual(cm.exception.code, "bad_url")

    def test_the_name_an_address_suggests(self):
        for url, name in (("https://github.com/octocat/Hello-World", "Hello-World"), ("https://github.com/octocat/Hello-World.git", "Hello-World"),
                          ("git@github.com:octocat/Hello-World.git", "Hello-World"), ("https://gitlab.com/a/b/c/", "c"),
                          ("https://github.com/o/r?tab=readme#x", "r"), ("", "")):
            self.assertEqual(PC.address_name(url), name, url)

    def test_git_errors_become_what_to_do(self):
        cases = {
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled": "no_access",
            "remote: Repository not found.\nfatal: repository 'https://x/y/' not found": "not_found",
            "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.": "no_access",
            "fatal: unable to access 'https://x/': Could not resolve host: x": "offline",
            "fatal: repository '/tmp/nope' does not exist": "not_found",
            "fatal: 'https://example.com/' does not appear to be a git repository": "not_git",
            "fatal: write error: No space left on device": "disk_full",
        }
        for text, key in cases.items():
            self.assertEqual(PC.explain_clone_error(text), PC.MESSAGES[key], text)
        other = PC.explain_clone_error("fatal: something odd")
        self.assertIn("something odd", other)
        for msg in list(PC.MESSAGES.values()) + [other]:
            self.assertNotIn("fatal:", msg)
            self.assertNotRegex(msg, r"\bclon")  # nothing in the person's words needs the word

    def test_the_first_percent_is_written_at_once(self):
        """A percent right after the start was held back by the 0.15 s pause and never written while git waited
        (the window stayed on "Connecting"; the stop test then sent its signal only after the copy ended)."""
        with tempfile.TemporaryDirectory() as t:
            path = os.path.join(t, "p.json")
            p = PC.Progress(path)
            p.line("Receiving objects:  10% (1/10)")
            self.assertEqual(json.load(open(path))["percent"], 13)
            p.line("Receiving objects:  10% (1/10), 1.00 MiB | 9.00 MiB/s")  # only the speed: may wait
            self.assertEqual(json.load(open(path))["detail"], "")

    def test_progress_lines_become_steps(self):
        with tempfile.TemporaryDirectory() as t:
            path = os.path.join(t, "p.json")
            p = PC.Progress(path)
            p.line("Receiving objects:  50% (150/300), 1.20 MiB | 2.30 MiB/s")
            p.write(force=True)
            got = json.load(open(path))
            self.assertEqual((got["state"], got["phase"], got["percent"]), ("running", "Downloading files", 45))
            self.assertIn("MiB/s", got["detail"])
            p.line("Resolving deltas: 100% (20/20), done.")
            p.write(force=True)
            self.assertEqual(json.load(open(path))["percent"], 95)
            p.line("remote: Compressing objects:  10% (3/30)")
            p.line("garbage that is not progress")


class NewProject(unittest.TestCase):
    def setUp(self):
        self.t = self.enterContext(tempfile.TemporaryDirectory())
        self.rows = []
        self.reg = registered(self.rows)
        self.enterContext(patch.dict(os.environ, GIT_ENV_KNOWN))

    def test_makes_the_folder_with_an_empty_first_commit(self):
        parent = os.path.join(self.t, "Projects")  # does not exist yet: a new Mac
        row = PC.new_project("Notes app", parent, self.reg)
        folder = os.path.join(parent, "Notes app")
        self.assertEqual(self.rows, [(folder, "Notes app")])
        self.assertEqual(row["folder"], folder)
        self.assertTrue(row["created"])
        self.assertEqual(git("rev-list", "--count", "HEAD", cwd=folder).strip(), "1")
        self.assertEqual(git("log", "-1", "--format=%s", cwd=folder).strip(), "Initial commit")
        self.assertEqual(os.listdir(folder), [".git"])
        self.assertEqual(git("branch", "--show-current", cwd=folder).strip(), "main")

    def test_the_first_commit_carries_the_persons_name(self):
        PC.new_project("a", self.t, self.reg)
        self.assertEqual(git("log", "-1", "--format=%an <%ae>", cwd=os.path.join(self.t, "a")).strip(), "Ada Lovelace <ada@example.org>")

    def test_a_mac_with_no_git_identity_gets_no_made_up_one(self):
        # task-pog4t: the first commit was "Dispatch <dispatch@localhost>", and agents copied it
        with patch.dict(os.environ, GIT_ENV):
            with self.assertRaises(PC.ProjectError) as cm:
                PC.new_project("a", self.t, self.reg)
        self.assertEqual(cm.exception.code, "no_identity")
        self.assertIn("Settings › Agents › Commits", str(cm.exception))
        self.assertFalse(os.path.exists(os.path.join(self.t, "a")))  # nothing half made is left
        self.assertEqual(self.rows, [])

    def test_a_folder_with_files_is_not_touched(self):
        os.makedirs(os.path.join(self.t, "taken"))
        open(os.path.join(self.t, "taken", "mine.txt"), "w").write("x")
        with self.assertRaises(PC.ProjectError) as cm:
            PC.new_project("taken", self.t, self.reg)
        self.assertEqual(cm.exception.code, "exists")
        self.assertIn("has files in it", str(cm.exception))
        self.assertEqual(os.listdir(os.path.join(self.t, "taken")), ["mine.txt"])
        self.assertEqual(self.rows, [])

    def test_an_empty_folder_is_used_and_kept_if_it_fails(self):
        os.makedirs(os.path.join(self.t, "empty"))
        PC.new_project("empty", self.t, self.reg)
        self.assertTrue(os.path.isdir(os.path.join(self.t, "empty", ".git")))
        os.makedirs(os.path.join(self.t, "empty2"))

        def boom(folder, name):
            raise ValueError("board down")
        with self.assertRaises(ValueError):
            PC.new_project("empty2", self.t, boom)
        self.assertEqual(os.listdir(os.path.join(self.t, "empty2")), [])  # the folder was there before: it stays, empty

    def test_a_failed_registration_takes_the_new_folder_away(self):
        def boom(folder, name):
            raise ValueError("board down")
        with self.assertRaises(ValueError):
            PC.new_project("fresh", self.t, boom)
        self.assertFalse(os.path.exists(os.path.join(self.t, "fresh")))

    def test_the_board_is_made_before_anything_is_written(self):
        def no_board():
            raise PV.RegisterError("Could not set up the task board. Try again.", retry=True)
        with self.assertRaises(PV.RegisterError):
            PC.new_project("early", self.t, self.reg, ensure_board=no_board)
        self.assertFalse(os.path.exists(os.path.join(self.t, "early")))

    def test_no_git_says_what_to_install(self):
        with patch.object(PC, "git_state", return_value={"ok": False, "message": PC.MESSAGES["no_git"]}):
            with self.assertRaises(PC.ProjectError) as cm:
                PC.new_project("x", self.t, self.reg)
        self.assertEqual(cm.exception.code, "no_git")
        self.assertIn("xcode-select --install", str(cm.exception))

    def test_a_parent_that_cannot_be_written(self):
        ro = os.path.join(self.t, "ro")
        os.makedirs(ro)
        os.chmod(ro, 0o500)
        try:
            with self.assertRaises(PC.ProjectError) as cm:
                PC.new_project("x", ro, self.reg)
            self.assertEqual(cm.exception.code, "no_write")
        finally:
            os.chmod(ro, 0o700)


class GitState(unittest.TestCase):
    def test_git_stub_on_a_mac_without_developer_tools_is_not_run(self):
        ran = []

        def run(cmd, **kw):
            ran.append(cmd[0])
            return subprocess.CompletedProcess(cmd, 1 if cmd[0] == "xcode-select" else 0, "git version 2", "")
        with patch.object(sys, "platform", "darwin"):
            got = PC.git_state(which=lambda n: "/usr/bin/git", run=run)
        self.assertFalse(got["ok"])
        self.assertEqual(ran, ["xcode-select"])
        self.assertTrue(PC.git_state(which=lambda n: "/opt/homebrew/bin/git", run=run)["ok"])
        self.assertFalse(PC.git_state(which=lambda n: None)["ok"])


class CloneProject(unittest.TestCase):
    def setUp(self):
        self.t = self.enterContext(tempfile.TemporaryDirectory())
        self.src = make_source(self.t)
        self.rows = []
        self.reg = registered(self.rows)
        self.enterContext(patch.dict(os.environ, GIT_ENV))

    def test_copies_into_the_parent_under_the_addresss_name(self):
        parent = os.path.join(self.t, "Projects")
        prog = os.path.join(self.t, "p.json")
        row = PC.clone_project(self.src, parent, "", self.reg, progress_file=prog)
        folder = os.path.join(parent, "Hello-World")
        self.assertEqual(self.rows, [(folder, "Hello-World")])
        self.assertEqual(open(os.path.join(folder, "README")).read(), "hello\n")
        self.assertEqual(row["source"], self.src)
        self.assertEqual(json.load(open(prog))["state"], "done")

    def test_a_name_of_your_own(self):
        PC.clone_project("file://" + self.src, self.t, "My copy", self.reg)
        self.assertTrue(os.path.isfile(os.path.join(self.t, "My copy", "README")))

    def test_a_missing_project_is_told_in_words_and_leaves_nothing(self):
        prog = os.path.join(self.t, "p.json")
        with self.assertRaises(PC.ProjectError) as cm:
            PC.clone_project(os.path.join(self.t, "nope"), self.t, "", self.reg, progress_file=prog)
        self.assertEqual(cm.exception.code, "clone_failed")
        self.assertTrue(cm.exception.retry)
        self.assertEqual(str(cm.exception), PC.MESSAGES["not_found"])
        self.assertFalse(os.path.exists(os.path.join(self.t, "nope-copy")))
        self.assertEqual(sorted(os.listdir(self.t)), ["Hello-World", "p.json"])
        self.assertEqual(json.load(open(prog))["state"], "failed")
        self.assertEqual(self.rows, [])

    def test_an_address_that_is_a_web_page(self):
        real = subprocess.Popen
        self.enterContext(patch.object(PC, "git_state", return_value={"ok": True}))
        with patch.object(PC.subprocess, "Popen", side_effect=lambda *a, **k: real(
                [sys.executable, "-c", "import sys; sys.stderr.write(\"fatal: repository 'https://example.com/' does not appear to be a git repository\\n\"); sys.exit(128)"],
                stdout=k["stdout"], stderr=k["stderr"])):
            with self.assertRaises(PC.ProjectError) as cm:
                PC.clone_project("https://example.com/", self.t, "", self.reg)
        self.assertEqual(str(cm.exception), PC.MESSAGES["not_git"])
        self.assertFalse(os.path.exists(os.path.join(self.t, "example.com")))

    def test_an_existing_folder_with_files_is_left_alone(self):
        os.makedirs(os.path.join(self.t, "Projects", "Hello-World"))
        open(os.path.join(self.t, "Projects", "Hello-World", "mine"), "w").write("x")
        with self.assertRaises(PC.ProjectError) as cm:
            PC.clone_project(self.src, os.path.join(self.t, "Projects"), "", self.reg)
        self.assertEqual(cm.exception.code, "exists")
        self.assertEqual(os.listdir(os.path.join(self.t, "Projects", "Hello-World")), ["mine"])

    def test_a_bad_address_is_refused_before_anything_is_made(self):
        with self.assertRaises(PC.ProjectError) as cm:
            PC.clone_project("hello", os.path.join(self.t, "P"), "", self.reg)
        self.assertEqual(cm.exception.code, "bad_url")
        self.assertFalse(os.path.exists(os.path.join(self.t, "P")))

    def test_stopping_it_removes_the_half_made_folder(self):
        # a git that reports progress and then waits, run in a child so SIGTERM reaches the CLI, not the tests
        bin_dir = os.path.join(self.t, "bin")
        os.makedirs(bin_dir)
        fake = os.path.join(bin_dir, "git")
        with open(fake, "w") as f:
            f.write("#!/bin/sh\nmkdir -p \"$(eval echo \\${$#})\"/.git\nprintf 'Receiving objects:  10%% (1/10)\\r' >&2\nexec sleep 30\n")
        os.chmod(fake, 0o755)
        parent = os.path.join(self.t, "Projects")
        prog = os.path.join(self.t, "p.json")
        code = ("import sys; sys.path.insert(0, %r); import project_create as PC; "
                "PC.git_state = lambda: {'ok': True}\n"
                "try:\n PC.clone_project('https://example.com/a/b', %r, '', lambda f, n: {}, progress_file=%r)\n"
                "except PC.ProjectError as e:\n print(e.code)\n" % (HERE, parent, prog))
        child = subprocess.Popen([sys.executable, "-c", code], env=dict(os.environ, PATH=bin_dir + ":" + os.environ["PATH"]), stdout=subprocess.PIPE, text=True)
        for _ in range(400):   # a busy Mac takes more than 10 s to start the child and its git
            if os.path.exists(prog) and json.load(open(prog)).get("percent", 0) > 0:
                break
            time.sleep(0.1)
        else:
            child.kill()
            self.fail("no progress")
        child.send_signal(signal.SIGTERM)
        out, _ = child.communicate(timeout=20)
        self.assertEqual(out.strip(), "cancelled")
        self.assertFalse(os.path.exists(os.path.join(parent, "b")))


class Command(unittest.TestCase):
    """`dispatch projects-view new|clone|defaults`: the answer the Agents window reads."""

    def setUp(self):
        self.t = self.enterContext(tempfile.TemporaryDirectory())
        self.D, self.mem, self.stored = fake_dispatch(self.t, {})
        self.enterContext(patch.object(PV, "D", self.D))
        self.enterContext(patch.object(PV, "ensure_board", return_value={"created": False}))
        self.enterContext(patch.dict(os.environ, GIT_ENV_KNOWN))

    def run_cmd(self, **kw):
        a = argparse.Namespace(op="list", arg="", name="", parent="", progress_file="", on="", host="", json=True, project="", days=14, local=False)
        for k, v in kw.items():
            setattr(a, k, v)
        out = io.StringIO()
        with redirect_stdout(out):
            code = PV.command(a, self.D)
        return code, json.loads(out.getvalue())

    def test_new_on_a_mac_where_git_has_no_name_says_so_for_the_window(self):
        with patch.dict(os.environ, GIT_ENV):
            code, res = self.run_cmd(op="new", arg="Todo", parent=os.path.join(self.t, "P"))
        self.assertEqual(code, 1)
        self.assertEqual((res["ok"], res["code"]), (False, "no_identity"))

    def test_new_by_name_registers_the_project(self):
        code, res = self.run_cmd(op="new", arg="Todo", parent=os.path.join(self.t, "P"))
        self.assertEqual(code, 0, res)
        self.assertEqual(res["dir"], os.path.join(self.t, "P", "Todo"))
        self.assertTrue(res["git"])
        self.assertIn("Todo", json.loads(self.stored["dispatch-projects"]))

    def test_new_with_a_full_path_is_still_the_old_behaviour(self):
        folder = os.path.join(self.t, "x", "y")
        code, res = self.run_cmd(op="new", arg=folder)
        self.assertEqual(code, 0, res)
        self.assertEqual(res["dir"], folder)

    def test_clone_registers_the_copy(self):
        src = make_source(self.t, "Hello-World")
        code, res = self.run_cmd(op="clone", arg=src, parent=os.path.join(self.t, "P"))
        self.assertEqual(code, 0, res)
        self.assertEqual(res["name"], "Hello-World")
        self.assertTrue(os.path.isfile(os.path.join(self.t, "P", "Hello-World", "README")))

    def test_failures_come_back_as_a_message_with_a_code(self):
        code, res = self.run_cmd(op="clone", arg="hello")
        self.assertEqual((code, res["ok"], res["code"]), (1, False, "bad_url"))
        code, res = self.run_cmd(op="new", arg="a/b")
        self.assertEqual((code, res["code"]), (1, "bad_name"))
        code, res = self.run_cmd(op="clone", arg=os.path.join(self.t, "gone"), parent=self.t)
        self.assertEqual((res["code"], res.get("retry")), ("clone_failed", True))

    def test_another_mac_is_listed_but_not_supported_yet(self):
        code, res = self.run_cmd(op="new", arg="x", on="mini")
        self.assertEqual(code, 1)
        self.assertIn("mini", res["message"])
        self.assertIn("not supported yet", res["message"])
        self.assertFalse(os.path.exists(os.path.join(self.t, "Projects", "x")))

    def test_a_board_that_does_not_answer_is_a_busy_message_not_a_traceback(self):
        def slow(folder, name):
            raise subprocess.TimeoutExpired(["bd", "memories", "--json"], 20)
        with patch.object(PV, "register", side_effect=slow):
            code, res = self.run_cmd(op="new", arg="Todo", parent=os.path.join(self.t, "P"))
        self.assertEqual((code, res["code"], res["retry"]), (1, "busy", True))
        self.assertNotIn("Timeout", res["message"])
        self.assertFalse(os.path.exists(os.path.join(self.t, "P", "Todo")))

    def test_defaults(self):
        code, res = self.run_cmd(op="defaults")
        self.assertEqual(code, 0)
        self.assertTrue(res["parent"].endswith("/Projects"))
        self.assertIn("ok", res["git"])


if __name__ == "__main__":
    unittest.main()
