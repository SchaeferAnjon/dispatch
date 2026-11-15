# -*- coding: utf-8 -*-
"""own_copy.py: a session's own copy goes back into the project folder by itself (task-lj06.16)."""
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import own_copy as O  # noqa: E402

ID = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
      "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}


def git(cwd, *args):
    return subprocess.run(["git", "-C", cwd, "-c", "commit.gpgsign=false", *args], check=True, capture_output=True, text=True).stdout


def read(folder, rel):
    with open(os.path.join(folder, rel)) as f:
        return f.read()


def write(folder, rel, text):
    with open(os.path.join(folder, rel), "w") as f:
        f.write(text)


class Land(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="oc-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        p = mock.patch.dict(os.environ, ID)
        p.start()
        self.addCleanup(p.stop)
        self.main = os.path.join(self.tmp, "todo")
        os.makedirs(self.main)
        git(self.main, "init", "-q", "-b", "main")
        write(self.main, "index.html", "<h1>Todo</h1>\n<p>one</p>\n<p>two</p>\n<p>three</p>\n")
        write(self.main, "app.js", "let a = 1\n")
        git(self.main, "add", ".")
        git(self.main, "commit", "-qm", "Initial commit")
        self.copy = os.path.join(self.tmp, "todo.worktrees", "agents-blue")
        git(self.main, "worktree", "add", "-q", self.copy, "-b", "agents/blue")

    def mark(self):
        r = O.mark(self.copy, "main")
        self.assertTrue(r["ok"], r)

    def test_a_marked_copy_with_uncommitted_work_lands_in_the_folder(self):
        self.mark()
        write(self.copy, "style.css", "button { color: blue }\n")
        r = O.land(self.copy, "Make the button blue")
        self.assertEqual(r["state"], "landed", r)
        self.assertEqual(r["files"], ["style.css"])
        self.assertTrue(os.path.exists(os.path.join(self.main, "style.css")))
        self.assertIn("Make the button blue", git(self.main, "log", "--format=%s", "-1"))
        self.assertEqual(git(self.main, "status", "--porcelain").strip(), "")

    def test_landing_twice_says_nothing_the_second_time(self):
        self.mark()
        write(self.copy, "a.txt", "x\n")
        self.assertEqual(O.land(self.copy)["state"], "landed")
        self.assertEqual(O.land(self.copy)["state"], "nothing")

    def test_the_folder_moved_on_in_other_files_still_lands(self):
        self.mark()
        write(self.copy, "style.css", "x\n")
        write(self.main, "app.js", "let a = 2\n")
        git(self.main, "commit", "-qam", "other agent")
        r = O.land(self.copy)
        self.assertEqual(r["state"], "landed", r)
        self.assertEqual(read(self.main, "app.js"), "let a = 2\n")
        self.assertTrue(os.path.exists(os.path.join(self.main, "style.css")))

    def test_same_lines_changed_on_both_sides_is_a_conflict_and_the_folder_is_untouched(self):
        self.mark()
        write(self.copy, "index.html", "<h1>Mine</h1>\n<p>one</p>\n<p>two</p>\n<p>three</p>\n")
        write(self.main, "index.html", "<h1>Theirs</h1>\n<p>one</p>\n<p>two</p>\n<p>three</p>\n")
        git(self.main, "commit", "-qam", "other agent")
        head = git(self.main, "rev-parse", "HEAD")
        r = O.land(self.copy)
        self.assertEqual(r["state"], "conflict", r)
        self.assertEqual(r["files"], ["index.html"])
        self.assertEqual(git(self.main, "rev-parse", "HEAD"), head)
        self.assertEqual(git(self.main, "status", "--porcelain").strip(), "")
        self.assertIn("Theirs", read(self.main, "index.html"))

    def test_conflict_found_by_merging_when_this_git_cannot_say_beforehand(self):
        self.mark()
        write(self.copy, "index.html", "<h1>Mine</h1>\n")
        write(self.main, "index.html", "<h1>Theirs</h1>\n")
        git(self.main, "commit", "-qam", "other agent")
        with mock.patch.object(O, "merge_tree_conflicts", return_value="unknown"):
            r = O.land(self.copy)
        self.assertEqual(r["state"], "conflict", r)
        self.assertEqual(r["files"], ["index.html"])
        self.assertFalse(os.path.exists(os.path.join(self.main, ".git", "MERGE_HEAD")))
        self.assertEqual(git(self.main, "status", "--porcelain").strip(), "")

    def test_unsaved_changes_in_the_same_file_in_the_folder_stop_it_without_writing(self):
        self.mark()
        write(self.copy, "app.js", "let a = 3\n")
        write(self.main, "app.js", "let a = 9 // someone is typing\n")
        r = O.land(self.copy)
        self.assertEqual(r["state"], "folder_changes", r)
        self.assertEqual(r["files"], ["app.js"])
        self.assertIn("someone is typing", read(self.main, "app.js"))

    def test_unsaved_changes_in_other_files_do_not_stop_it(self):
        self.mark()
        write(self.copy, "style.css", "x\n")
        write(self.main, "app.js", "let a = 9 // typing\n")
        r = O.land(self.copy)
        self.assertEqual(r["state"], "landed", r)
        self.assertIn("typing", read(self.main, "app.js"))

    def test_staged_files_in_the_folder_mean_try_later(self):
        self.mark()
        write(self.copy, "style.css", "x\n")
        write(self.main, "notes.md", "n\n")
        git(self.main, "add", "notes.md")
        self.assertEqual(O.land(self.copy)["state"], "folder_busy")

    def test_the_folder_on_another_branch_is_said(self):
        self.mark()
        write(self.copy, "style.css", "x\n")
        git(self.main, "switch", "-q", "-c", "experiment")
        r = O.land(self.copy)
        self.assertEqual(r["state"], "other_branch")
        self.assertEqual(r["folder_branch"], "experiment")

    def test_a_copy_the_person_picked_is_only_looked_at(self):
        write(self.copy, "style.css", "x\n")
        r = O.land(self.copy)
        self.assertEqual(r["state"], "manual")
        self.assertTrue(r["dirty"])
        self.assertEqual(r["ahead"], 0)
        self.assertFalse(os.path.exists(os.path.join(self.main, "style.css")))

    def test_the_project_folder_itself_is_not_a_copy(self):
        self.assertEqual(O.land(self.main)["state"], "not_copy")
        os.makedirs(os.path.join(self.main, "src"))
        write(self.main, "src/x.js", "1\n")
        self.assertEqual(O.land(os.path.join(self.main, "src"))["state"], "not_copy", "a folder inside the project is not a copy")

    def test_a_folder_inside_the_copy_lands_the_copy(self):
        self.mark()
        os.makedirs(os.path.join(self.copy, "web"))
        write(self.copy, "web/page.html", "x\n")
        r = O.land(os.path.join(self.copy, "web"))
        self.assertEqual(r["state"], "landed", r)
        self.assertEqual(r["copy"], self.copy)

    def test_busy_says_whether_a_copy_can_be_made_and_from_which_branch(self):
        r = O.busy(self.main, run=lambda argv, **kw: types.SimpleNamespace(stdout="", returncode=0), names=set())
        self.assertEqual((r["busy"], r["git"], r["branch"]), (False, True, "main"))
        empty = os.path.join(self.tmp, "empty")
        os.makedirs(empty)
        git(empty, "init", "-q")
        r = O.busy(empty, run=lambda argv, **kw: types.SimpleNamespace(stdout="", returncode=0), names=set())
        self.assertEqual((r["git"], r["branch"]), (False, ""))

    def test_the_command_prints_json(self):
        self.mark()
        write(self.copy, "b.txt", "x\n")
        a = types.SimpleNamespace(op="land", folder=self.copy, message="", force=False, json=True)
        with mock.patch("sys.stdout") as so:
            self.assertEqual(O.command(a), 0)
        self.assertIn('"landed"', "".join(c.args[0] for c in so.write.call_args_list))


class Busy(unittest.TestCase):
    def fake(self, ps, lsof):
        def run(argv, **kw):
            text = ps if argv[0] == "ps" else lsof
            return types.SimpleNamespace(stdout=text, returncode=0)
        return run

    def test_an_agent_in_the_folder_or_below_counts_and_ours_do_not(self):
        folder = os.path.realpath(tempfile.mkdtemp(prefix="ob-"))
        self.addCleanup(shutil.rmtree, folder, True)
        os.makedirs(os.path.join(folder, "src"))
        ps = "\n".join([
            "  100     1 node",            # the agent host
            "  101   100 claude",          # its own session: left out
            "  200     1 zsh",
            "  201   200 codex",           # a terminal agent in the folder
            "  202   200 opencode",        # a terminal agent in a subfolder
            "  300     1 claude",          # an agent elsewhere
            "  400     1 Claude",          # the desktop app is not an agent
        ])
        lsof = f"p101\nn{folder}\np201\nn{folder}\np202\nn{folder}/src\np300\nn/tmp\np400\nn{folder}\n"
        r = O.busy(folder, not_under=100, run=self.fake(ps, lsof), names={"claude", "codex", "opencode"})
        self.assertTrue(r["busy"])
        self.assertEqual(sorted(a["pid"] for a in r["agents"]), [201, 202])

    def test_nothing_there_is_not_busy(self):
        r = O.busy("/nowhere", run=self.fake("  5 1 claude\n", "p5\nn/elsewhere\n"), names={"claude"})
        self.assertFalse(r["busy"])

    def test_a_folder_whose_name_starts_the_same_does_not_count(self):
        r = O.busy("/p/todo", run=self.fake("  5 1 claude\n", "p5\nn/p/todo-web\n"), names={"claude"})
        self.assertFalse(r["busy"])


if __name__ == "__main__":
    unittest.main()
