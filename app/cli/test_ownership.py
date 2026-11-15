import importlib.util, io, json, os, sys, tempfile, time, unittest
from contextlib import redirect_stdout
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ownership as O
import tasks_view as T
from test_tasks_view import FakeBoard, args, issue

HERE = os.path.dirname(os.path.abspath(__file__))


def repo(tmp, name="proj"):
    r = os.path.join(tmp, name)
    os.makedirs(os.path.join(r, ".git"))
    os.makedirs(os.path.join(r, "app", "cli"))
    return r


def worktree(tmp, main, name="wt"):
    w = os.path.join(tmp, name)
    os.makedirs(os.path.join(w, "app"))
    with open(os.path.join(w, ".git"), "w") as f:
        f.write(f"gitdir: {main}/.git/worktrees/{name}\n")
    return w


class Paths(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.main = repo(self.tmp)

    def test_relative_to_the_main_checkout_even_from_a_worktree(self):
        wt = worktree(self.tmp, self.main)
        self.assertEqual(O.normalize("app/cli/x.py", self.main), {"path": "app/cli/x.py", "repo": self.main})
        self.assertEqual(O.normalize("app/cli/x.py", wt), {"path": "app/cli/x.py", "repo": self.main})
        self.assertEqual(O.normalize(os.path.join(wt, "app", "*.ts")), {"path": "app/*.ts", "repo": self.main})

    def test_outside_a_repository_stays_absolute(self):
        out = os.path.join(self.tmp, "loose")
        os.makedirs(out)
        self.assertEqual(O.normalize("notes.md", out), {"path": os.path.join(out, "notes.md"), "repo": ""})

    def test_globs_and_folders(self):
        self.assertTrue(O.matches("app/cli", "app/cli/x.py"))
        self.assertTrue(O.matches("app/cli/*.py", "app/cli/x.py"))
        self.assertFalse(O.matches("app/cli/*.py", "app/cli/sub/x.py"))
        self.assertTrue(O.matches("app/**/x.py", "app/cli/sub/x.py"))
        self.assertTrue(O.matches("app/**", "app/cli/sub/x.py"))
        self.assertFalse(O.matches("app/cli", "app/client.py"))
        self.assertTrue(O.matches(".", "anything/at/all"))

    def test_overlap(self):
        r = self.main
        self.assertTrue(O.overlap({"path": "patches/*.patch", "repo": r}, {"path": "patches/sessions-docs-tab.patch", "repo": r}))
        self.assertTrue(O.overlap({"path": "patches/*.patch", "repo": r}, {"path": "patches/sessions-*.patch", "repo": r}))
        self.assertTrue(O.overlap({"path": "app", "repo": r}, {"path": "app/cli/x.py", "repo": r}))
        self.assertFalse(O.overlap({"path": "app/cli", "repo": r}, {"path": "app/ide-ext", "repo": r}))
        self.assertFalse(O.overlap({"path": "app", "repo": r}, {"path": "app", "repo": "/other"}))

    def test_label(self):
        self.assertEqual(O.label({"path": "app/x.py", "repo": "/Users/me/Projects/kanban"}), "kanban/app/x.py")
        self.assertEqual(O.label({"path": "/tmp/a.md", "repo": ""}), "/tmp/a.md")


class Conflicts(unittest.TestCase):
    def row(self, tid, status, owns, sessions=("s",)):
        return {"id": tid, "title": tid.upper(), "agent": "claude-code", "status": status, "project": "p", "sessions": list(sessions),
                "owns": [dict(o, label=O.label(o)) for o in owns]}

    def test_only_live_tasks_conflict(self):
        a = self.row("t-a", "in_progress", [{"path": "app/cli", "repo": "/r"}])
        b = self.row("t-b", "waiting", [{"path": "app/cli/x.py", "repo": "/r"}])
        c = self.row("t-c", "done", [{"path": "app/cli/x.py", "repo": "/r"}])
        d = self.row("t-d", "todo", [{"path": "app", "repo": "/r"}])
        got = O.conflicts([a, b, c, d])
        self.assertEqual(sorted(got), ["t-a", "t-b"])
        self.assertEqual(got["t-a"][0]["task"], "t-b")
        self.assertEqual(O.pairs([a, b, c, d])[0]["tasks"], ["t-a", "t-b"])
        self.assertEqual(O.pairs([a, b], project="elsewhere"), [])


class Index(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.env = patch.dict(os.environ, {"DISPATCH_DIR": os.path.join(self.tmp, "state")})
        self.env.start()
        self.main = repo(self.tmp)

    def tearDown(self):
        self.env.stop()

    def test_owners_of_skips_the_own_session_and_dead_tasks(self):
        rows = [{"id": "t-a", "title": "A", "agent": "codex", "status": "in_progress", "sessions": ["abcdef123456"],
                 "owns": [{"path": "app/cli/*.py", "repo": self.main, "label": ""}]},
                {"id": "t-b", "title": "B", "agent": "codex", "status": "done", "sessions": ["zzz"],
                 "owns": [{"path": "app", "repo": self.main, "label": ""}]}]
        O.write_index(rows)
        f = os.path.join(self.main, "app", "cli", "x.py")
        self.assertEqual([t["id"] for t, _ in O.owners_of(f, "someone-else")], ["t-a"])
        self.assertEqual(O.owners_of(f, "abcdef123456"), [])
        self.assertEqual(O.owners_of(os.path.join(self.main, "README.md"), "x"), [])
        O.forget("t-a")
        self.assertEqual(O.owners_of(f, "someone-else"), [])


class Commands(unittest.TestCase):
    """`dispatch task own / conflicts / list` on a fake board."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.env = patch.dict(os.environ, {"DISPATCH_DIR": os.path.join(self.tmp, "state")})
        self.env.start()
        self.main = repo(self.tmp)
        self.board = FakeBoard([
            issue("task-a1", "Docs tab", "2026-09-27T10:00:00Z", status="in_progress", session="s1", project="kanban"),
            issue("task-b2", "Docs search", "2026-09-27T10:05:00Z", status="in_progress", session="s2", project="kanban",
                  meta={"owns": [{"path": "app/cli/*.py", "repo": self.main}]}),
        ])

    def tearDown(self):
        self.env.stop()

    def run_cmd(self, a):
        buf = io.StringIO()
        with patch.object(T, "_sh", self.board), patch.object(T, "D", None), redirect_stdout(buf), patch("os.getcwd", return_value=self.main):
            code = T.command(a)
        return code, json.loads(buf.getvalue())

    def test_own_add_reports_the_overlap_and_writes_the_index(self):
        _, r = self.run_cmd(args("own", "task-a1", add="app/cli/docs.py, app/ide-ext/src/docs.ts", rm=""))
        self.assertEqual([o["label"] for o in r["owns"]], ["proj/app/cli/docs.py", "proj/app/ide-ext/src/docs.ts"])
        self.assertEqual([c["task"] for c in r["conflicts"]], ["task-b2"])
        idx = O.read_index()
        self.assertEqual(sorted(t["id"] for t in idx["tasks"]), ["task-a1", "task-b2"])
        _, r = self.run_cmd(args("own", "task-a1", add="", rm="proj/app/cli/docs.py"))
        self.assertEqual([o["label"] for o in r["owns"]], ["proj/app/ide-ext/src/docs.ts"])
        self.assertEqual(r["conflicts"], [])

    def test_list_and_conflicts_carry_it(self):
        self.run_cmd(args("own", "task-a1", add="app/cli", rm=""))
        _, r = self.run_cmd(args("list", project="kanban"))
        by = {t["id"]: t for t in r["tasks"]}
        self.assertEqual(by["task-a1"]["conflicts"][0]["task"], "task-b2")
        self.assertIn("owns", by["task-b2"])
        _, r = self.run_cmd(args("conflicts", project="kanban"))
        self.assertEqual(r["conflicts"][0]["tasks"], ["task-a1", "task-b2"])
        self.assertEqual(r["owns"]["task-b2"], ["proj/app/cli/*.py"])


class EditGuardTerritory(unittest.TestCase):
    """edit-guard.py before an edit: the permission mode decides between a note and holding it back once."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.state = os.path.join(self.tmp, "state")
        self.env = patch.dict(os.environ, {"DISPATCH_DIR": self.state})
        self.env.start()
        self.main = repo(self.tmp)
        O.write_index([{"id": "task-a1", "title": "Docs tab", "agent": "codex", "status": "in_progress", "sessions": ["owner-session"],
                        "owns": [{"path": "app/cli", "repo": self.main, "label": ""}]}])
        spec = importlib.util.spec_from_file_location("edit_guard_t", os.path.join(HERE, "edit-guard.py"))
        self.g = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.g)
        self.g.DIR = os.path.join(self.state, "edits")

    def tearDown(self):
        self.env.stop()

    def pre(self, sid, mode, path=None):
        hook = {"session_id": sid, "tool_name": "Edit", "permission_mode": mode,
                "tool_input": {"file_path": path or os.path.join(self.main, "app", "cli", "x.py")}}
        buf = io.StringIO()
        with patch.object(sys, "argv", ["edit-guard.py", "claude-code", "pre"]), patch.object(sys, "stdin", io.StringIO(json.dumps(hook))), redirect_stdout(buf):
            self.g.main()
        return json.loads(buf.getvalue()) if buf.getvalue().strip() else None

    def log(self):
        with open(os.path.join(self.state, "owns-log.jsonl")) as f:
            return [json.loads(l)["action"] for l in f]

    def test_ask_mode_holds_it_back_once(self):
        r = self.pre("intruder-1", "default")
        self.assertEqual(r["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("task-a1", r["hookSpecificOutput"]["permissionDecisionReason"])
        self.assertIsNone(self.pre("intruder-1", "default"))  # the retry goes through
        self.assertEqual(self.log(), ["held", "allowed-after-warning"])

    def test_bypass_only_notes_it(self):
        r = self.pre("intruder-2", "bypassPermissions")
        self.assertNotIn("permissionDecision", r["hookSpecificOutput"])
        self.assertIn("bypass", r["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(r["systemMessage"], r["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.log(), ["passed"])

    def test_owner_and_other_files_pass_quietly(self):
        self.assertIsNone(self.pre("owner-session", "default"))
        self.assertIsNone(self.pre("intruder-3", "default", os.path.join(self.main, "README.md")))


if __name__ == "__main__":
    unittest.main()
