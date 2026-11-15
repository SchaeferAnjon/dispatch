# -*- coding: utf-8 -*-
"""assistant_survey.py: what looks unfinished in each project, and what the Assistant offers to put on the board."""
import os
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import assistant_survey as S  # noqa: E402
import tasks_view as TV  # noqa: E402


def git(root, *args):
    subprocess.run(["git", "-C", root, "-c", "user.email=t@t", "-c", "user.name=t", *args], check=True, capture_output=True)


def repo(parent, name, files=None):
    root = os.path.join(parent, name)
    os.makedirs(root)
    git(root, "init", "-q")
    with open(os.path.join(root, "app.py"), "w") as fh:
        fh.write("print(1)\n")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "first")
    for rel, text in (files or {}).items():
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as fh:
            fh.write(text)
    return root


class Findings(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def test_changes_count_real_files_and_skip_tool_leftovers(self):
        root = repo(self.tmp, "shop", {"app.py": "print(2)\n", "new.py": "x\n", ".DS_Store": "", "__pycache__/a.pyc": "", ".playwright-mcp/x.png": ""})
        ch = S.changes(root)
        self.assertEqual(ch["files"], 2)
        self.assertEqual(sorted(ch["names"]), ["app.py", "new.py"])
        self.assertEqual(ch["ahead"], 0)
        fresh = os.path.join(self.tmp, "fresh")
        os.makedirs(fresh)
        git(fresh, "init", "-q")
        with open(os.path.join(fresh, "README.md"), "w") as fh:
            fh.write("# fresh\n")
        self.assertEqual(S.changes(fresh)["files"], 0)  # made a repository when it became a project: nothing half done
        clean = repo(self.tmp, "clean")
        self.assertEqual(S.changes(clean)["files"], 0)
        self.assertIsNone(S.changes(os.path.join(self.tmp, "nowhere")))

    def test_notes_take_open_items_from_the_newest_handoff(self):
        root = repo(self.tmp, "p", {"design/handoff/2026-10-01.md": "# Handoff\n\n## Done\n- shipped login\n\n## Next steps\n- fix the export bug\n- write the docs\n\n- [ ] ask Ana about the invoice\nTODO: rename the table\n"})
        n = S.notes(root)
        self.assertEqual(n["file"], os.path.join("design", "handoff", "2026-10-01.md"))
        self.assertEqual(n["lines"], ["fix the export bug", "write the docs", "ask Ana about the invoice", "rename the table"])
        self.assertIsNone(S.notes(repo(self.tmp, "q", {"README.md": "- [ ] not a note"})))

    def test_a_session_that_stopped_mid_work_is_found_but_a_running_one_is_not(self):
        now = 100000.0
        idx = {"/t/a.jsonl": {"session_id": "s1", "agent": "claude-code", "cwd": "/w/p", "mtime": now - 7200, "title": "Add the login page"},
               "/t/b.jsonl": {"session_id": "s2", "agent": "claude-code", "cwd": "/w/p", "mtime": now - 7200, "title": "Running now"},
               "/t/c.jsonl": {"session_id": "s3", "agent": "claude-code", "cwd": "/w/p", "mtime": now - 7200, "title": "Finished fine"},
               "/t/d.jsonl": {"session_id": "s4", "agent": "claude-code", "cwd": "/w/other", "mtime": now - 7200, "title": "Other project"},
               "/t/e.jsonl": {"session_id": "s5", "agent": "claude-code", "cwd": "/w/p-wt/feat", "mtime": now - 7200, "title": "In a worktree"}}
        states = {"s1": ("working", now - 7200), "s2": ("working", now - 7200), "s3": ("idle", now - 7200), "s4": ("working", now - 7200), "s5": ("working", now - 7200)}
        out = S.stopped_sessions("/w/p", idx, {"s2"}, now, states, ["/w/p-wt"])
        self.assertEqual({s["id"] for s in out}, {"s1", "s5"})


class Survey(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.orig = S.D
        self.shop = repo(self.tmp, "shop", {"app.py": "print(2)\n", "design/handoff/h.md": "## Next\n- email the client\n"})
        self.clean = repo(self.tmp, "clean")
        reg = [{"name": "shop", "label": "Shop", "dir": self.shop, "host": "local", "archived": False},
               {"name": "clean", "label": "clean", "dir": self.clean, "host": "local", "archived": False},
               {"name": "gone", "label": "gone", "dir": os.path.join(self.tmp, "gone"), "host": "local", "archived": False}]
        self.pv = types.SimpleNamespace(registry=lambda index=None: reg, D=None)
        mods = {"projects_view": self.pv, "tasks_view": TV}
        S.D = types.SimpleNamespace(load_index=lambda: {}, live_sessions=lambda local_only=False: [], DISPATCH_DIR=self.tmp, debug=lambda w, e: None,
                                    local_host_name=lambda: "小蓝", hosts=lambda: [], _mod=lambda n: mods.get(n) or __import__(n), remote_dispatch=lambda *a, **k: None)

    def tearDown(self):
        S.D = self.orig

    def test_each_project_says_what_is_unfinished_in_plain_words(self):
        issue = {"id": "task-9", "title": "Polish the checkout", "status": "open", "created_at": "2026-10-01T10:00:00Z", "updated_at": "2026-10-01T10:00:00Z", "labels": ["project:shop"]}
        with patch.object(TV, "board_export", lambda: [issue]):
            res = S.survey(local_only=True, now=2000.0)
        projects = {p["name"]: p for m in res["machines"] for p in m["projects"]}
        self.assertEqual(set(projects), {"shop", "clean"})  # a folder that is gone is skipped
        shop, clean = projects["shop"], projects["clean"]
        self.assertTrue(shop["unfinished"])
        self.assertEqual(shop["open_tasks"], 1)
        self.assertEqual(shop["changed_files"], 2)
        self.assertIn("1 task not done on the board", shop["lines"][0])
        self.assertTrue(any("changed but not saved" in l for l in shop["lines"]))
        self.assertTrue(any("design/handoff/h.md" in l and "email the client" in l for l in shop["lines"]))
        self.assertFalse(clean["unfinished"])
        self.assertEqual(clean["summary"], "Nothing looks unfinished.")
        self.assertEqual(res["summary"], "1 of 2 projects have something unfinished.")

    def test_candidates_are_ready_for_dispatch_begin(self):
        with patch.object(TV, "board_export", lambda: []):
            res = S.survey(local_only=True, now=2000.0)
        cands = res["candidates"]
        self.assertEqual({c["source"] for c in cands}, {"changes", "note"})
        for c in cands:
            self.assertTrue(8 <= len(c["title"]) <= 80, c["title"])
            self.assertGreaterEqual(len(c["description"]), 20)
            self.assertEqual((c["project"], c["machine"]), ("Shop", "小蓝"))
            self.assertIn("survey", c["description"])

    def test_a_candidate_the_board_already_has_is_not_offered_again(self):
        with patch.object(TV, "board_export", lambda: []):
            first = S.survey(local_only=True, now=2000.0)["candidates"]
        title = first[0]["title"]
        issue = {"id": "task-1", "title": title, "status": "open", "created_at": "2026-10-01T10:00:00Z", "updated_at": "2026-10-01T10:00:00Z", "labels": ["project:shop"]}
        with patch.object(TV, "board_export", lambda: [issue]):
            again = S.survey(local_only=True, now=2000.0)["candidates"]
        self.assertNotIn(title, [c["title"] for c in again])

    def test_one_project_by_name_and_another_mac(self):
        S.D.hosts = lambda: [{"id": "mini", "name": "mini"}]
        asked = []

        def remote(h, args, ttl, timeout=12, background=False):
            asked.append(args)
            return {"machines": [{"id": "local", "name": "mini", "local": True, "online": True, "projects": [
                {"name": "poker", "label": "poker", "unfinished": True, "lines": ["2 files changed"], "candidates": [{"project": "poker", "source": "changes", "title": "poker finish two files", "description": "x" * 30}]}]}]}

        S.D.remote_dispatch = remote
        with patch.object(TV, "board_export", lambda: []):
            res = S.survey(project="shop", now=2000.0)
        self.assertEqual(asked, [["assistant", "survey", "--local", "--project", "shop"]])
        self.assertEqual([m["name"] for m in res["machines"]], ["小蓝", "mini"])
        self.assertEqual({p["name"] for m in res["machines"] for p in m["projects"]}, {"shop", "poker"})
        self.assertIn("mini", {c["machine"] for c in res["candidates"]})

    def test_no_projects_yet(self):
        self.pv.registry = lambda index=None: []
        with patch.object(TV, "board_export", lambda: []):
            self.assertEqual(S.survey(local_only=True)["summary"], "No projects are registered yet.")


class Similar(unittest.TestCase):
    def setUp(self):
        self.orig = S.D
        S.D = types.SimpleNamespace(debug=lambda w, e: None, _mod=lambda n: TV if n == "tasks_view" else __import__(n))

    def tearDown(self):
        S.D = self.orig

    def issue(self, tid, title, status="open", project="shop", thing=None):
        t = {"id": tid, "title": title, "status": status, "created_at": "2026-10-01T10:00:00Z", "updated_at": "2026-10-01T10:00:00Z", "labels": [f"project:{project}"]}
        if thing:
            t["metadata"] = {"thing": thing}
        return t

    def test_same_work_in_other_words_is_found_and_unrelated_is_not(self):
        board = [self.issue("task-1", "Checkout page: fix the broken discount code field"),
                 self.issue("task-2", "Write the release notes"),
                 self.issue("task-3", "Checkout discount code field fix", status="closed"),
                 self.issue("task-4", "Checkout page discount code field", project="other")]
        with patch.object(TV, "board_export", lambda: board):
            r = S.similar("Fix the discount code field on the checkout page", "shop")
            none = S.similar("Plan the summer holiday", "shop")
        self.assertEqual([m["id"] for m in r["matches"]], ["task-1"])  # done and other-project tasks are not offered
        self.assertTrue(r["duplicate"])
        self.assertEqual(none["matches"], [])
        self.assertFalse(none["duplicate"])

    def test_chinese_titles_compare_too(self):
        board = [self.issue("task-1", "任务页 开关改成方角")]
        with patch.object(TV, "board_export", lambda: board):
            self.assertEqual([m["id"] for m in S.similar("把开关改成方角", "shop")["matches"]], ["task-1"])

    def test_a_follow_up_is_a_partial_match_not_a_duplicate(self):
        board = [self.issue("task-1", "Checkout page redesign with new cart layout and coupon box")]
        with patch.object(TV, "board_export", lambda: board):
            r = S.similar("Checkout page coupon box wording", "shop")
        self.assertEqual(len(r["matches"]), 1)


    def fake_board(self, board):
        made = []
        fake_tv = types.SimpleNamespace(board_export=lambda: board, select=TV.select, task_row=TV.task_row,
                                        begin_thing=lambda tid, thing, sid, project, d: {"thing": thing or "Notes site"})
        S.D = types.SimpleNamespace(debug=lambda w, e: None, local_host_name=lambda: "mac", session_from_env=lambda: "sess-12345678",
                                    bd_json=lambda argv: made.append(argv) or {"id": "task-new"},
                                    _mod=lambda n: fake_tv if n == "tasks_view" else __import__(n))
        return made

    def test_add_files_a_to_do_nobody_claims(self):
        made = self.fake_board([self.issue("task-1", "Write the release notes")])
        r = S.add("Fix the RSS feed dates for old posts", "shop", "NOTES.md lists it")
        self.assertTrue(r["added"])
        self.assertEqual((r["id"], r["status"], r["thing"]), ("task-new", "todo", "Notes site"))
        self.assertEqual(len(made), 1)
        argv = made[0]
        self.assertEqual(argv[:2], ["create", "Fix the RSS feed dates for old posts"])
        self.assertIn("project:shop", argv[argv.index("-l") + 1])
        self.assertIn("session-origin:sess-12345678", argv[argv.index("-l") + 1])
        self.assertEqual(argv[argv.index("--description") + 1], "NOTES.md lists it")
        self.assertNotIn("--claim", argv)

    def test_add_the_same_work_twice_adds_nothing(self):
        made = self.fake_board([self.issue("task-1", "Fix the RSS feed dates for posts before 2020")])
        r = S.add("Fix the RSS feed dates", "shop")
        self.assertFalse(r["added"])
        self.assertEqual(r["existing"]["id"], "task-1")
        self.assertEqual(made, [])
        self.assertTrue(S.add("Fix the RSS feed dates", "shop", force=True)["added"])

    def test_add_what_dispatch_already_noted_from_the_chat_adds_nothing(self):
        """task-b83p: Dispatch noted two things from the Assistant chat (no project), the Assistant added both again."""
        noted = self.issue("task-7", "Fix the RSS feed dates", project="")
        noted["labels"] = ["from-chat", "later"]
        later = self.issue("task-8", "Add a dark mode", project="")
        later["labels"] = ["from-chat", "nextup"]
        board = [noted, later]
        made = self.fake_board(board)
        fake_tv = S.D._mod("tasks_view")
        for name in ("status_of", "project_of", "meta", "epoch", "labels_of"):
            if hasattr(TV, name):
                setattr(fake_tv, name, getattr(TV, name))
        calls = []
        import capture as C
        with patch.object(C, "bd", lambda argv: calls.append(argv) or {}):
            r = S.add("Fix the RSS feed dates for old posts", "shop")
        self.assertFalse(r["added"])
        self.assertTrue(r["noted"])
        self.assertEqual(r["existing"]["id"], "task-7")
        self.assertIn("Dispatch already noted", r["note"])
        self.assertEqual(made, [])
        # the noted thing had no project: it gets the one the Assistant named
        self.assertEqual(calls, [["update", "task-7", "--add-label", "project:shop", "--json"]])
        self.assertEqual(S.add("Add a dark mode", "")["existing"]["state"], "next")


class Look(unittest.TestCase):
    def test_looking_at_a_folder_does_not_register_it(self):
        tmp = tempfile.mkdtemp()
        folder = repo(tmp, "notes", {"x.py": "1\n"})
        registered = []
        pv = types.SimpleNamespace(registry=lambda index=None, resolve_dirs=True: [], D=None,
                                   register=lambda *a, **k: registered.append(a), add=lambda *a, **k: registered.append(a))
        calls = []
        d = types.SimpleNamespace(debug=lambda w, e: None, _mod=lambda n: pv if n == "projects_view" else __import__(n),
                                  sh=lambda *a, **k: calls.append(a) or (0, "", ""), project_flags_parse=lambda s: calls.append("flags"))
        orig, S.D = S.D, d
        try:
            r = S.look(folder)
        finally:
            S.D = orig
        self.assertTrue(r["exists"] and r["git"])
        self.assertFalse(r["is_project"])
        self.assertEqual(r["ask"], "Add notes as a project?")
        self.assertIn("1 unsaved file", r["summary"])
        self.assertEqual(registered, [])
        self.assertEqual(calls, [])  # nothing written to the board or the project list

    def test_a_registered_folder_is_said_to_be_one(self):
        tmp = tempfile.mkdtemp()
        folder = repo(tmp, "shop")
        pv = types.SimpleNamespace(registry=lambda index=None, resolve_dirs=True: [{"name": "shop", "dir": folder}], D=None)
        orig, S.D = S.D, types.SimpleNamespace(debug=lambda w, e: None, _mod=lambda n: pv if n == "projects_view" else __import__(n))
        try:
            r = S.look(folder)
            gone = S.look(os.path.join(tmp, "nope"))
        finally:
            S.D = orig
        self.assertEqual((r["is_project"], r["project"], r["ask"]), (True, "shop", None))
        self.assertFalse(gone["exists"])


if __name__ == "__main__":
    unittest.main()
