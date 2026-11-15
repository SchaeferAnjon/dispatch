# -*- coding: utf-8 -*-
"""project_rename.py: a project's real rename on a board in a temp folder (task-ysxde). Nothing touches a real board:
every command gets its own HOME, BEADS_DIR, DISPATCH_DIR and DISPATCH_HOME."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BD = shutil.which("bd")


@unittest.skipUnless(BD and os.name == "posix", "needs bd")
class RenameKey(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="dren-")
        board = os.path.join(cls.root, "board")
        home = os.path.join(cls.root, "home")
        cls.folder = os.path.join(home, "Projects", "Quillbench")
        os.makedirs(board)
        os.makedirs(cls.folder)
        os.makedirs(os.path.join(home, "Projects", "other"))
        cls.env = {"HOME": home, "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "DISPATCH_DIR": os.path.join(cls.root, "dd"),
                   "DISPATCH_HOME": os.path.join(cls.root, "dh"), "BEADS_DIR": os.path.join(board, ".beads"),
                   "DISPATCH_BOARD_SERVICE": "0", "PYTHONDONTWRITEBYTECODE": "1", "DISPATCH_LANG": "en"}
        r = subprocess.run([BD, "init", "--prefix", "task", "--non-interactive", "--skip-hooks", "--quiet"], cwd=board, env=cls.env,
                           capture_output=True, text=True, timeout=120)
        assert r.returncode == 0, r.stderr
        subprocess.run(["git", "init", "-q"], cwd=cls.folder, env=cls.env, check=True, timeout=30)
        # the case of the person's screenshot: the folder ~/Projects/Quillbench is the project "ALG"
        cls.cli("projects-view", "add", cls.folder, "--name", "ALG", "--json")
        cls.cli("projects-view", "add", os.path.join(home, "Projects", "other"), "--json")
        cls.tasks = [cls.cli("begin", f"Lecture {n} for the course", "--force", "-P", "ALG", "-d", "a task of ALG before the rename", "--json")["id"]
                     for n in (1, 2, 3)]
        cls.bd("close", cls.tasks[1])
        cls.cli("task", "trash", cls.tasks[2], "--json")
        cls.cli("begin", "Something of the other project", "--force", "-P", "other", "-d", "stays where it is when ALG moves", "--json")
        cls.cli("prefs", "add", "Keep the lecture pages short", "--like", "--area", "writing", "--scope", "ALG:lectures", "--quote", "short pages", "--json")
        cls.cli("prefs", "add", "Square toggles everywhere", "--like", "--area", "design", "--quote", "square", "--json")
        cls.cli("wiki", "add", "Slides break on long formulas", "--kind", "pit", "--fix", "split them", "--project", "ALG", "--json")
        cls.cli("env", "set", "COURSE_KEY", "abc", "--project", "ALG", "--json")
        note = os.path.join(cls.folder, "notes.md")
        with open(note, "w") as f:
            f.write("# notes\n")
        cls.cli("docs", "add", "ALG", note, "--json")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, True)

    @classmethod
    def run_cli(cls, *args):
        return subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), *args], env=cls.env, cwd=cls.root,
                              capture_output=True, text=True, timeout=300)

    @classmethod
    def cli(cls, *args):
        r = cls.run_cli(*args)
        assert r.returncode == 0, (args, r.stdout, r.stderr)
        out = r.stdout.strip()
        return json.loads(out[out.find("{") if out.find("{") >= 0 and (out.find("[") < 0 or out.find("{") < out.find("[")) else out.find("["):]) if out else {}

    @classmethod
    def bd(cls, *args):
        r = subprocess.run([BD, *args], env=cls.env, cwd=cls.root, capture_output=True, text=True, timeout=120)
        assert r.returncode == 0, r.stderr
        return r.stdout

    def labels(self):
        rows = json.loads(self.bd("list", "--all", "-n", "0", "--json"))
        return {t["id"]: [l for l in t.get("labels") or [] if l.startswith("project:")] for t in rows}

    def rename(self, old, new, *more):
        r = self.run_cli("projects-view", "rename", old, f"--name={new}", "--key", *more, "--json")
        return json.loads(r.stdout)

    def test_1_dry_run_counts_and_changes_nothing(self):
        r = self.rename("ALG", "Quillbench", "--dry-run")
        self.assertTrue(r["ok"], r)
        self.assertEqual({k: r["counts"][k] for k in ("flags", "tasks", "prefs", "wiki", "env", "docs")},
                         {"flags": 1, "tasks": 3, "prefs": 1, "wiki": 1, "env": 1, "docs": 1})
        self.assertTrue(all(l == ["project:ALG"] for t, l in self.labels().items() if t in self.tasks))

    def test_2_a_taken_name_is_refused(self):
        r = self.rename("ALG", "OTHER")
        self.assertFalse(r["ok"])
        self.assertIn("already a project called OTHER", r["message"])

    def test_3_everything_moves_and_back(self):
        r = self.rename("ALG", "Quillbench")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["done"], ["flags", "owners", "custom", "docs", "summary", "tasks", "wiki", "prefs", "capture", "env"])
        labels = self.labels()
        self.assertEqual([labels[t] for t in self.tasks], [["project:Quillbench"]] * 3, "open, done and binned tasks all move")
        self.assertIn(["project:other"], labels.values(), "another project's task stays")
        projects = {p["name"]: p for p in self.cli("projects", "--json")}
        self.assertNotIn("ALG", projects)
        self.assertEqual(os.path.realpath(projects["Quillbench"]["dir"]), os.path.realpath(self.folder))
        with open(os.path.join(self.env["DISPATCH_HOME"], "preferences.jsonl")) as f:
            scopes = sorted(json.loads(line).get("scope") for line in f if line.strip())
        self.assertEqual(scopes, ["Quillbench:lectures", "everywhere"])
        wiki = self.run_cli("wiki", "list", "--project", "Quillbench", "--json").stdout
        self.assertIn("Slides break on long formulas", wiki)
        self.assertNotIn("Slides break", self.run_cli("wiki", "list", "--project", "ALG", "--json").stdout)
        env = self.run_cli("env", "list", "--project", "Quillbench", "--json").stdout
        self.assertIn("COURSE_KEY", env)
        self.assertIn("notes.md", self.run_cli("docs", "Quillbench", "--json").stdout)
        self.assertNotIn("notes.md", self.run_cli("docs", "ALG", "--json").stdout)
        # again: nothing is left under the old name, nothing moves twice
        again = self.rename("ALG", "Quillbench")
        self.assertTrue(again["ok"], again)
        self.assertEqual(sum(again["counts"].values()), 0)
        # and back
        back = self.rename("Quillbench", "ALG")
        self.assertTrue(back["ok"], back)
        labels = self.labels()
        self.assertEqual([labels[t] for t in self.tasks], [["project:ALG"]] * 3)
        self.assertIn("ALG", {p["name"] for p in self.cli("projects", "--json")})


if __name__ == "__main__":
    unittest.main()
