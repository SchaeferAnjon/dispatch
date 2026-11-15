# -*- coding: utf-8 -*-
"""copy_ready.py: a project's copy for parallel work gets ready on its own (task-am1t)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import copy_ready as C  # noqa: E402

GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]


def run(cwd, *args):
    subprocess.run(list(args), cwd=cwd, check=True, capture_output=True)


class Copies(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="cr-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        p = mock.patch.dict(os.environ, {"DISPATCH_HOME": os.path.join(self.tmp, "dh")})
        p.start(); self.addCleanup(p.stop)
        self.main = os.path.join(self.tmp, "shop")
        os.makedirs(os.path.join(self.main, "node_modules", "left-pad"))
        os.makedirs(os.path.join(self.main, ".claude"))
        files = {
            ".gitignore": "node_modules/\n.env\n.env.*\n!.env.example\nCLAUDE.local.md\n.claude/settings.local.json\ndist/\nsecrets/\n",
            "package.json": '{"name": "shop"}', "package-lock.json": '{"lockfileVersion": 3}',
            ".env": "API_KEY=abc\n", ".env.local": "X=1\n", ".env.example": "API_KEY=\n",
            "CLAUDE.local.md": "my notes\n", ".claude/settings.local.json": '{"permissions": {}}',
            "node_modules/left-pad/index.js": "module.exports = 1\n",
        }
        for rel, text in files.items():
            with open(os.path.join(self.main, rel), "w") as f:
                f.write(text)
        os.makedirs(os.path.join(self.main, "dist"))
        with open(os.path.join(self.main, "dist", "app.js"), "w") as f:
            f.write("built")
        run(self.main, "git", "init", "-q")
        run(self.main, *GIT, "add", ".")
        run(self.main, *GIT, "commit", "-qm", "init")
        self.copy = os.path.join(self.tmp, "shop.worktrees", "try-1")
        run(self.main, *GIT, "worktree", "add", "-q", self.copy, "-b", "try-1")

    def test_plan_names_the_files_the_folders_and_no_install_when_shared(self):
        p = C.plan(self.main)
        self.assertEqual(p["copy"], [".claude/settings.local.json", ".env", ".env.local", "CLAUDE.local.md"])
        self.assertEqual(p["link"], ["node_modules"])
        self.assertEqual(p["install"], "")

    def test_prepare_copies_links_and_records_without_asking(self):
        r = C.prepare(self.copy, check_switch=False)
        self.assertEqual(r["main"], self.main)
        self.assertEqual(sorted(r["copied"]), [".claude/settings.local.json", ".env", ".env.local", "CLAUDE.local.md"])
        self.assertEqual(r["linked"], ["node_modules"])
        self.assertEqual(os.path.realpath(os.path.join(self.copy, "node_modules")), os.path.join(self.main, "node_modules"))
        with open(os.path.join(self.copy, ".env")) as f:
            self.assertEqual(f.read(), "API_KEY=abc\n")
        self.assertFalse(os.path.exists(os.path.join(self.copy, "dist")))  # build output is not the person's setup
        # the link is not something git would offer to commit
        st = subprocess.run(["git", "-C", self.copy, "status", "--porcelain"], capture_output=True, text=True).stdout
        self.assertEqual(st.strip(), "")
        self.assertEqual(C.last_for(self.main)["copy"], self.copy)
        # found from the folder alone: the window asking need not share the agent host's DISPATCH_HOME
        with mock.patch.dict(os.environ, {"DISPATCH_HOME": os.path.join(self.tmp, "elsewhere")}):
            self.assertEqual(C.last_for(self.main)["copy"], self.copy)
        # a second run leaves what is there
        with open(os.path.join(self.copy, ".env"), "w") as f:
            f.write("CHANGED=1\n")
        self.assertEqual(C.prepare(self.copy, check_switch=False)["copied"], [])
        with open(os.path.join(self.copy, ".env")) as f:
            self.assertEqual(f.read(), "CHANGED=1\n")

    def test_a_different_lockfile_installs_instead_of_sharing(self):
        with open(os.path.join(self.copy, "package-lock.json"), "w") as f:
            f.write('{"lockfileVersion": 3, "x": 1}')
        ran = []
        with mock.patch.object(C, "installer", lambda folder: (["true"], "npm ci")), \
             mock.patch.object(C, "run_install", lambda argv, cwd: ran.append((argv, cwd)) or 0):
            r = C.prepare(self.copy, background=False, check_switch=False)
        self.assertEqual(r["linked"], [])
        self.assertIn("package-lock.json differs", r["why"]["node_modules"])
        self.assertEqual(r["install"]["state"], "done")
        self.assertIn((["true"], self.copy), ran)

    def test_worktreeinclude_adds_files(self):
        os.makedirs(os.path.join(self.main, "secrets"))
        with open(os.path.join(self.main, "secrets", "dev.pem"), "w") as f:
            f.write("k")
        with open(os.path.join(self.main, ".worktreeinclude"), "w") as f:
            f.write("# what a copy needs\nsecrets/\n")
        self.assertIn("secrets/dev.pem", C.plan(self.main)["copy"])

    def test_the_project_switch_and_the_main_checkout_itself(self):
        self.assertIn("skipped", C.prepare(self.main, check_switch=False))
        with mock.patch.object(C, "auto_on", lambda main: False):
            r = C.prepare(self.copy)
        self.assertEqual(r["skipped"], "turned off for this project")
        self.assertFalse(os.path.exists(os.path.join(self.copy, ".env")))


if __name__ == "__main__":
    unittest.main()
