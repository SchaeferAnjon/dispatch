# -*- coding: utf-8 -*-
"""`dispatch editor …` (app/cli/editor.py) against a scratch Git repository: agent baselines and
hunks, the user's own saves folded into the baseline, chatd's two hooks, and VS Code / Cursor."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import editor

WINDOWS_READY = True
HERE = os.path.dirname(os.path.abspath(__file__))
DISPATCH = os.path.join(HERE, "dispatch.py")
SID = "claude-code:0b5f6c1e-1111-2222-3333-444455556666"
HAS_GIT = shutil.which("git") is not None

# 30 lines: two hunks far apart when line 3 and line 25 change
LINES = ["line %02d\n" % i for i in range(1, 31)]


def git(root, *args, input=None):
    env = dict(os.environ, GIT_AUTHOR_NAME="T", GIT_AUTHOR_EMAIL="t@example.com", GIT_COMMITTER_NAME="T", GIT_COMMITTER_EMAIL="t@example.com", LC_ALL="C")
    r = subprocess.run(["git", "-C", root] + list(args), input=input, capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise AssertionError("git %s: %s" % (" ".join(args), r.stderr))
    return r.stdout


def write(root, rel, data, mode="w"):
    p = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, mode + ("b" if isinstance(data, bytes) else ""), **({} if isinstance(data, bytes) else {"encoding": "utf-8", "newline": ""})) as f:
        f.write(data)
    return p


def read(root, rel):
    with open(os.path.join(root, *rel.split("/")), "rb") as f:
        return f.read().decode("utf-8")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = os.path.realpath(os.path.join(self.tmp.name, "proj"))
        os.mkdir(self.root)
        self.ddir = os.path.join(self.tmp.name, "dispatch")
        p = patch.dict(os.environ, {"DISPATCH_DIR": self.ddir})
        p.start()
        self.addCleanup(p.stop)

    def run_op(self, op, *args, stdin=None, root=None):
        return editor.run(op, ["--root", root or self.root] + list(args) + ["--json"], stdin)

    def ok(self, op, *args, **kw):
        out = self.run_op(op, *args, **kw)
        self.assertTrue(out.get("ok"), out)
        return out

    def bad(self, code, op, *args, **kw):
        out = self.run_op(op, *args, **kw)
        self.assertEqual((out.get("ok"), out.get("error")), (False, code), out)
        self.assertTrue(out.get("message"))
        return out


@unittest.skipUnless(HAS_GIT, "git is not installed")
class Repo(Base):
    """committed, staged, unstaged, untracked and binary files, one of each"""

    def setUp(self):
        super().setUp()
        git(self.root, "init", "-q", "-b", "main")
        git(self.root, "config", "core.autocrlf", "false")
        # the CLI's own commits run without the test env: CI runners have no global identity
        git(self.root, "config", "user.name", "T")
        git(self.root, "config", "user.email", "t@example.com")
        write(self.root, "two.txt", "".join(LINES))
        write(self.root, "src/app.py", "print('hi')\n")
        write(self.root, "staged.txt", "old\n")
        write(self.root, "logo.bin", b"\x89PNG\x00\x01\x02")
        write(self.root, ".gitignore", "build/\n*.log\n")
        write(self.root, "CLAUDE.md", "# rules\n- commit messages are `<type>: <desc>`\n- tests first\n")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "init")
        write(self.root, "staged.txt", "new\n")
        git(self.root, "add", "staged.txt")
        write(self.root, "src/app.py", "print('hello')\n")
        write(self.root, "notes/untracked.md", "# hi\n")
        write(self.root, "logo.bin", b"\x89PNG\x00\x09\x09\x09")
        write(self.root, "build/out.js", "x\n")
        write(self.root, "debug.log", "x\n")


class AgentHunks(Repo):
    def sid(self, *args):
        return ["--sid", SID] + list(args)

    def agent_writes(self, rel, text):
        write(self.root, rel, text)

    def test_baseline_lifecycle(self):
        # chatd snapshots before the agent edits
        self.assertEqual(editor.capture_baseline(SID, self.root, [os.path.join(self.root, "two.txt"), "src/app.py", "/etc/hosts", os.path.join(self.tmp.name, "x")]), 2)
        self.assertEqual(editor.capture_baseline(SID, self.root, ["two.txt"]), 0)  # idempotent
        self.assertFalse(self.ok("baseline", *self.sid("two.txt"))["captured"])
        with open(os.path.join(editor.sid_dir(SID), "index.json"), encoding="utf-8") as f:
            idx = json.load(f)
        self.assertEqual(editor._slash(idx["root"]), editor._slash(self.root))
        self.assertEqual(sorted(idx["files"]), ["src/app.py", "two.txt"])
        ent = idx["files"]["two.txt"]
        self.assertEqual((ent["existed"], ent["sha1"]), (True, editor.sha1("".join(LINES).encode())))
        self.assertTrue(os.path.isfile(os.path.join(editor.sid_dir(SID), "baseline", "src", "app.py")))
        # no agent edit yet: a baseline, no hunks
        h = self.ok("hunks", *self.sid("two.txt"))
        self.assertEqual((h["baseline"], h["hunks"]), (True, []))
        # the agent edits two places, adds a line and deletes one
        lines = list(LINES)
        lines[2] = "AGENT 03\n"
        lines[20:21] = []
        lines.insert(26, "added by agent\n")
        self.agent_writes("two.txt", "".join(lines))
        h = self.ok("hunks", *self.sid("two.txt"))
        self.assertEqual([(x["index"], x["kind"], x["old_start"], x["old_lines"], x["new_start"], x["new_lines"]) for x in h["hunks"]],
                         [(1, "mod", 3, 1, 3, 1), (2, "del", 21, 1, 21, 0), (3, "add", 28, 0, 27, 1)])
        first = h["hunks"][0]
        self.assertEqual((first["old_text"], first["new_text"]), ("line 03\n", "AGENT 03\n"))
        self.assertEqual(first["id"], editor.sha1(("line 03\n" + "\0" + "AGENT 03\n" + "\0" + "3").encode())[:12])
        self.assertEqual(h["disk_sha1"], editor.sha1("".join(lines).encode()))
        self.assertEqual(set(first), {"id", "index", "kind", "old_start", "old_lines", "new_start", "new_lines", "old_text", "new_text"})
        # accept the first: the baseline moves, the disk does not
        acc = self.ok("accept", *self.sid("two.txt", "--hunk", first["id"]))
        self.assertEqual((acc["wrote"], acc["decided"], len(acc["hunks"])), (False, 1, 2))
        self.assertEqual(read(self.root, "two.txt"), "".join(lines))
        self.assertNotIn(first["id"], [x["id"] for x in acc["hunks"]])
        # undo the deletion: line 21 comes back on disk
        dele = acc["hunks"][0]
        und = self.ok("undo", *self.sid("two.txt", "--hunk", dele["id"]))
        self.assertEqual((und["wrote"], und["decided"], len(und["hunks"])), (True, 1, 1))
        self.assertIn("line 21\n", read(self.root, "two.txt"))
        self.assertEqual(und["text"], read(self.root, "two.txt"))
        # a foreign edit in the add hunk's region: its id is gone → bad_hunk
        add = und["hunks"][0]
        disk = read(self.root, "two.txt").replace("added by agent\n", "added by agent, then by you\n")
        write(self.root, "two.txt", disk)
        self.bad("bad_hunk", "undo", *self.sid("two.txt", "--hunk", add["id"]))
        self.bad("bad_hunk", "accept", *self.sid("two.txt", "--hunk", "000000000000"))
        # --all puts the disk back to the baseline (which holds the accepted hunk)
        allu = self.ok("undo", *self.sid("two.txt", "--all"))
        expect = list(LINES)
        expect[2] = "AGENT 03\n"
        self.assertEqual(read(self.root, "two.txt"), "".join(expect))
        self.assertEqual((allu["hunks"], allu["wrote"]), ([], True))
        # files and clear
        self.agent_writes("src/app.py", "print('agent')\n")
        f = self.ok("files", *self.sid())
        self.assertEqual(f["sid"], SID)
        self.assertEqual([(x["path"], x["hunks_n"], x["existed"]) for x in f["files"]], [("src/app.py", 1, True), ("two.txt", 0, True)])
        acc_all = self.ok("accept", *self.sid("src/app.py", "--all"))
        self.assertEqual((acc_all["hunks"], acc_all["decided"]), ([], 1))
        self.ok("clear", *self.sid())
        self.assertFalse(os.path.exists(editor.sid_dir(SID)))
        self.assertEqual(self.ok("files", *self.sid())["files"], [])
        self.bad("no_baseline", "undo", *self.sid("two.txt", "--all"))

    def test_hunk_lines_are_editor_lines_even_with_form_feeds(self):
        text = 'print("a")\n\x0c\ndef f():\n    return 1\n\ndef g():\n    return 2\n'
        write(self.root, "src/ff.py", text)
        self.ok("baseline", *self.sid("src/ff.py"))
        write(self.root, "src/ff.py", text.replace("return 2", "return 22"))
        h = self.ok("hunks", *self.sid("src/ff.py"))["hunks"]
        self.assertEqual([(x["old_start"], x["new_start"], x["new_text"]) for x in h], [(7, 7, "    return 22\n")])
        # the other separators str.splitlines() knows are not line ends either; \r alone is (Monaco agrees)
        self.assertEqual(editor._lines("a\x0bb\x1cc\x85d\u2028e\u2029f\n"), ["a\x0bb\x1cc\x85d\u2028e\u2029f\n"])
        self.assertEqual(editor._lines("a\r\nb\rc\nd"), ["a\r\n", "b\r", "c\n", "d"])
        und = self.ok("undo", *self.sid("src/ff.py", "--all"))
        self.assertEqual((und["wrote"], read(self.root, "src/ff.py")), (True, text))

    def test_hunks_need_a_valid_sid_and_report_no_baseline(self):
        self.bad("bad_request", "hunks", "two.txt")
        self.bad("bad_request", "hunks", "two.txt", "--sid", "nope")
        self.bad("bad_request", "hunks", "two.txt", "--sid", "claude-code:../../x")
        h = self.ok("hunks", *self.sid("two.txt"))
        self.assertEqual((h["baseline"], h["hunks"]), (False, []))
        self.bad("no_baseline", "accept", *self.sid("two.txt", "--all"))
        editor.capture_baseline(SID, self.root, ["two.txt"])
        self.bad("bad_request", "accept", *self.sid("two.txt"))

    def test_a_file_the_agent_created(self):
        editor.capture_baseline(SID, self.root, ["gen/new.py"])
        self.agent_writes("gen/new.py", "a = 1\nb = 2\n")
        h = self.ok("hunks", *self.sid("gen/new.py"))
        self.assertEqual([(x["kind"], x["new_start"], x["new_lines"], x["old_lines"]) for x in h["hunks"]], [("add", 1, 2, 0)])
        self.assertFalse(self.ok("files", *self.sid())["files"][0]["existed"])
        u = self.ok("undo", *self.sid("gen/new.py", "--all"))
        self.assertEqual((u["wrote"], u["exists"]), (True, False))
        self.assertFalse(os.path.exists(os.path.join(self.root, "gen", "new.py")))

    def test_fold_a_save_made_outside_write(self):
        # the full IDE saves the file itself, then reports what the file was before the save
        editor.capture_baseline(SID, self.root, ["two.txt"])
        lines = list(LINES)
        lines[4] = "AGENT 05\n"
        self.agent_writes("two.txt", "".join(lines))
        before = "".join(lines)
        mine = list(lines)
        mine[19] = "MINE 20\n"
        write(self.root, "two.txt", "".join(mine))
        self.assertTrue(self.ok("fold", "two.txt", *self.sid(), stdin=before)["baseline_folded"])
        self.assertEqual([x["new_text"] for x in self.ok("hunks", *self.sid("two.txt"))["hunks"]], ["AGENT 05\n"])
        # nothing changed since: no fold; a file without a baseline: no fold either
        self.assertFalse(self.ok("fold", "two.txt", *self.sid(), stdin="".join(mine))["baseline_folded"])
        self.assertFalse(self.ok("fold", "src/app.py", *self.sid(), stdin="print('hi')\n")["baseline_folded"])
        self.bad("bad_request", "fold", "two.txt", stdin=before)

    def test_fold_patch_shifts_and_gives_up(self):
        base = ["a\n", "b\n", "c\n", "d\n", "e\n"]
        src = ["X\n", "Y\n", "a\n", "b\n", "c\n", "d\n", "e\n"]  # the agent added two lines on top
        dst = ["X\n", "Y\n", "a\n", "b\n", "C\n", "d\n", "e\n"]
        self.assertEqual(editor.fold_patch(base, src, dst), ["a\n", "b\n", "C\n", "d\n", "e\n"])
        self.assertEqual(editor.fold_patch(base, src, src), base)
        self.assertIsNone(editor.fold_patch(["q\n"] * 3, ["a\n", "b\n", "c\n"], ["a\n", "B\n", "c\n"]))
        self.assertEqual(editor.fold_patch([], [], ["new\n"]), ["new\n"])

    def test_repair_a_late_snapshot(self):
        # Edit: the agent already wrote when the snapshot was taken
        write(self.root, "late.py", "x = 1\ny = 20\n")
        editor.capture_baseline(SID, self.root, ["late.py"])
        self.assertTrue(editor.repair_baseline(SID, self.root, {"path": os.path.join(self.root, "late.py"), "kind": "edit", "old": "y = 2\n", "new": "y = 20\n"}))
        self.assertEqual([(x["old_text"], x["new_text"]) for x in self.ok("hunks", *self.sid("late.py"))["hunks"]], [("y = 2\n", "y = 20\n")])
        # only once per snapshot
        self.assertFalse(editor.repair_baseline(SID, self.root, {"path": "late.py", "kind": "edit", "old": "x = 1", "new": "y = 2"}))
        # a snapshot on time is left alone
        write(self.root, "ontime.py", "v = 1\n")
        editor.capture_baseline(SID, self.root, ["ontime.py"])
        write(self.root, "ontime.py", "v = 2\n")
        self.assertFalse(editor.repair_baseline(SID, self.root, {"path": "ontime.py", "kind": "edit", "old": "v = 1", "new": "v = 2"}))
        # Write of a new file whose snapshot came after the write: it did not exist before
        write(self.root, "made.py", "made\n")
        time.sleep(0.01)
        editor.capture_baseline(SID, self.root, ["made.py"])
        self.assertTrue(editor.repair_baseline(SID, self.root, {"path": "made.py", "kind": "write", "old": "", "new": "made\n"}))
        f = {x["path"]: x for x in self.ok("files", *self.sid())["files"]}
        self.assertEqual((f["made.py"]["existed"], f["made.py"]["hunks_n"]), (False, 1))
        # Write that rewrote an existing file with the same bytes after the snapshot: still existed
        write(self.root, "same.py", "same\n")
        editor.capture_baseline(SID, self.root, ["same.py"])
        time.sleep(0.01)
        write(self.root, "same.py", "same\n")
        self.assertFalse(editor.repair_baseline(SID, self.root, {"path": "same.py", "kind": "write", "old": "", "new": "same\n"}))
        # garbage never raises
        self.assertFalse(editor.repair_baseline(SID, self.root, None))
        self.assertFalse(editor.repair_baseline(SID, "/definitely/not/here", {"path": "x", "kind": "edit"}))
        self.assertEqual(editor.capture_baseline(SID, "/definitely/not/here", ["x"]), 0)
        self.assertEqual(editor.capture_baseline(SID, self.root, [None, 3, ""]), 0)

    def test_binary_files_get_no_baseline(self):
        self.assertEqual(editor.capture_baseline(SID, self.root, ["logo.bin"]), 0)


class Elsewhere(Base):
    def test_apps_and_open_in(self):
        with patch.object(editor, "_which", lambda n: "/usr/local/bin/code" if n == "code" else None), \
                patch.object(editor, "_app_bundle", lambda b: None), patch.object(editor.subprocess, "Popen") as popen:
            apps = editor.run("apps", ["--json"])
            self.assertEqual(apps["apps"], [{"id": "code", "label": "VS Code", "installed": True}, {"id": "cursor", "label": "Cursor", "installed": False}])
            write(self.root, "a.py", "x\n")
            self.ok("open-in", "--app", "code", "a.py", "--line", "3")
            self.assertEqual(popen.call_args[0][0], ["/usr/local/bin/code", self.root, "--goto", os.path.join(self.root, "a.py") + ":3"])
            self.ok("open-in", "--app", "code")
            self.assertEqual(popen.call_args[0][0], ["/usr/local/bin/code", self.root])
            self.bad("unsupported", "open-in", "--app", "cursor")
            self.bad("bad_request", "open-in", "--app", "vim")
            self.bad("not_found", "open-in", "--app", "code", "nope.py")
            self.bad("outside_root", "open-in", "--app", "code", "../x")


@unittest.skipUnless(HAS_GIT, "git is not installed")
class ThroughDispatch(Repo):
    """The real entry point: `python3 dispatch.py editor <op> … --json` prints one JSON object and exits 0."""

    def cli(self, *args, stdin=None):
        r = subprocess.run([sys.executable, DISPATCH, "editor"] + list(args) + ["--root", self.root, "--json"],
                           input=(stdin or "").encode("utf-8"), capture_output=True, env=dict(os.environ, DISPATCH_DIR=self.ddir), timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = [l for l in r.stdout.decode("utf-8").splitlines() if l.strip()]
        self.assertEqual(len(lines), 1, r.stdout)
        return json.loads(lines[0])

    def test_every_op_answers_one_json_object(self):
        self.assertTrue(self.cli("baseline", "two.txt", "--sid", SID)["captured"])
        write(self.root, "two.txt", "changed\n")
        h = self.cli("hunks", "two.txt", "--sid", SID)
        self.assertEqual(len(h["hunks"]), 1)
        self.assertEqual(self.cli("accept", "two.txt", "--sid", SID, "--hunk", h["hunks"][0]["id"])["hunks"], [])
        write(self.root, "two.txt", "changed again\n")
        self.assertTrue(self.cli("undo", "two.txt", "--sid", SID, "--all")["wrote"])
        self.assertEqual(read(self.root, "two.txt"), "changed\n")
        self.assertEqual(self.cli("files", "--sid", SID)["files"][0]["path"], "two.txt")
        self.assertTrue(self.cli("clear", "--sid", SID)["ok"])
        self.assertEqual(len(self.cli("apps")["apps"]), 2)
        self.assertEqual(self.cli("hunks", "../x", "--sid", SID)["error"], "outside_root")
        self.assertEqual(self.cli("read", "two.txt")["error"], "bad_request")
        self.assertEqual(self.cli("hunks", "--bogus-flag")["error"], "bad_request")

    def test_root_must_be_a_folder(self):
        out = editor.run("files", ["--root", os.path.join(self.root, "two.txt"), "--sid", SID, "--json"])
        self.assertEqual(out["error"], "outside_root")
        self.assertEqual(editor.run("files", ["--json"])["error"], "bad_request")


class BoundedDiff(unittest.TestCase):
    """compute_hunks and fold_patch stay fast on repetitive text and agree with difflib elsewhere."""

    def test_repetitive_generated_file_is_fast(self):
        pat = ["  },\n", "  {\n", '    "a": 1\n']
        base = [pat[i % 3] for i in range(30000)]
        new = list(base)
        new.insert(100, '    "b": 2\n')
        new[29000] = '    "a": 2\n'
        t = time.time()
        _, _, hunks = editor.compute_hunks("".join(base), "".join(new))
        self.assertLess(time.time() - t, 3)
        self.assertEqual([(h["kind"], h["new_start"], h["old_lines"], h["new_lines"]) for h in hunks], [("add", 101, 0, 1), ("mod", 29001, 1, 1)])
        t = time.time()
        folded = editor.fold_patch(base, base, new)
        self.assertLess(time.time() - t, 3)
        self.assertEqual(folded, new)

    def test_myers_opcodes_rebuild_the_new_text_and_are_minimal(self):
        import difflib
        import random
        rnd = random.Random(7)
        for _ in range(400):
            a = [rnd.choice("abcd") for _ in range(rnd.randint(0, 25))]
            b = list(a)
            for _ in range(rnd.randint(0, 6)):
                r = rnd.random()
                if r < .33 and b:
                    del b[rnd.randrange(len(b))]
                elif r < .66:
                    b.insert(rnd.randint(0, len(b)), rnd.choice("abcde"))
                elif b:
                    b[rnd.randrange(len(b))] = rnd.choice("abcde")
            ops = editor._myers_ops(a, b, 100)
            out, i, j = [], 0, 0
            for tag, i1, i2, j1, j2 in ops:
                self.assertEqual((i1, j1), (i, j))
                if tag == "equal":
                    self.assertEqual(a[i1:i2], b[j1:j2])
                out += b[j1:j2]
                i, j = i2, j2
            self.assertEqual((out, i, j), (b, len(a), len(b)))
            cost = lambda o: sum((i2 - i1) + (j2 - j1) for t, i1, i2, j1, j2 in o if t != "equal")
            self.assertLessEqual(cost(ops), cost(difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()))
        self.assertIsNone(editor._myers_ops(list("abc"), list("xyz"), 2))

    def test_large_rewrites_fall_back_and_still_cover_the_file(self):
        a = ["a%d\n" % i for i in range(5000)]
        b = ["b%d\n" % i for i in range(5000)]
        with patch.object(editor, "MYERS_MAX_D", 10):
            t = time.time()
            ops = editor._opcodes(a, b)
            self.assertLess(time.time() - t, 5)
        self.assertEqual(sum(j2 - j1 for _, _, _, j1, j2 in ops), 5000)


if __name__ == "__main__":
    unittest.main()
