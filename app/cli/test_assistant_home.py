# -*- coding: utf-8 -*-
"""assistant_home.py: the Assistant's home cards and a session's Now card."""
import os
import sys
import time
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import assistant_home as H  # noqa: E402
import tasks_view as TV  # noqa: E402


def issue(tid, title, status="open", deliverables=None, closed_at=None):
    t = {"id": tid, "title": title, "status": status, "labels": ["project:shop"], "created_at": "2026-10-01T08:00:00Z", "updated_at": "2026-10-01T08:00:00Z",
         "metadata": {"deliverables": deliverables or [], "plan": [{"text": "Find the bug", "state": "done"}, {"text": "Fix it", "state": "active"}]}}
    if closed_at:
        t["closed_at"] = closed_at
    return t


def row(key, status, **kw):
    r = {"key": key, "id": key.split("/")[-1], "status": status, "status_label": status.title(), "project": "shop", "title": "A session", "doing": "",
         "said": "", "last_at": 0, "agent": "opencode", "agent_name": "OpenCode", "task": None, "link": None, "host": "local"}
    r.update(kw)
    return r


class Home(unittest.TestCase):
    def setUp(self):
        self.orig = H.D
        H.D = types.SimpleNamespace(debug=lambda w, e: None, _mod=lambda n: TV if n == "tasks_view" else __import__(n))

    def tearDown(self):
        H.D = self.orig

    def test_delivered_today_lists_today_newest_first(self):
        now = time.time()
        start = H._today_start(now)
        board = [issue("task-1", "Fix the login page", deliverables=[{"kind": "build", "ref": "b1", "label": "Build ok", "at": int(start + 3600)}]),
                 issue("task-2", "Old work", deliverables=[{"kind": "commit", "ref": "abc", "at": int(start - 3600)}]),
                 issue("task-3", "Write the docs", deliverables=[{"kind": "file", "ref": "/x/README.md", "at": int(start + 7200)}])]
        got = H.delivered_card(board, now)
        self.assertEqual(got["count"], 2)
        self.assertEqual([i["task"] for i in got["items"]], ["task-3", "task-1"])
        self.assertTrue(got["items"][1]["sub"].startswith("Build · "))

    def test_working_now_says_the_task_and_what_it_does(self):
        rows = [row("opencode:/a", "working", doing="Editing report.py", task={"id": "task-1", "title": "Fix the report", "status": "in_progress"}),
                row("opencode:/b", "idle"), row("opencode:/c", "working", doing="")]
        got = H.working_card(rows)
        self.assertEqual(got["count"], 2)
        self.assertEqual((got["items"][0]["title"], got["items"][0]["sub"]), ("Fix the report", "Editing report.py"))
        self.assertEqual(got["items"][1]["sub"], "Working")

    def test_next_up_lists_the_line_in_order_and_later_apart(self):
        import tempfile
        import capture as C
        tmp = tempfile.mkdtemp()

        def noted(tid, title, order, labels, at):
            t = issue(tid, title)
            t["labels"] += ["from-chat"] + labels
            t["metadata"] = {"chat": {"quote": title.lower(), "at": at, "session": "s"}, "nextup": order}
            return t
        now = time.time()
        board = [noted("task-1", "Bigger export button", 2, ["nextup"], now - 60), noted("task-2", "Dark mode toggle", 1, ["nextup"], now - 7200),
                 noted("task-3", "CSV export", 3, ["later"], now - 30), issue("task-4", "Not from chat")]
        d = types.SimpleNamespace(debug=lambda w, e: None, DISPATCH_DIR=tmp, _mod=lambda n: TV if n == "tasks_view" else C if n == "capture" else __import__(n))
        H.D = d
        orig = C.D
        try:
            got = H.next_card(board, now)
        finally:
            C.D = orig
        self.assertEqual([(i["task"], i["pos"], i["new"]) for i in got["items"]], [("task-2", 1, False), ("task-1", 2, True)])
        self.assertEqual(got["count"], 2)
        self.assertEqual([i["task"] for i in got["later"]], ["task-3"])
        # Start by itself is off until the person turns it on (task-9rxf); no failed start
        self.assertEqual((got["paused"], got["limit"], got["failed"]), (True, C.LIMIT, {}))
        self.assertEqual(got["items"][0]["sub"], "dark mode toggle")

    def test_waiting_takes_the_first_three_in_plain_words(self):
        fake = types.SimpleNamespace(collect=lambda: {"items": [{"kind": "decide", "title": "Pick a colour", "project": "shop", "task": "task-9", "id": "task:task-9"}] * 4,
                                     "counts": {"attention": 4}})
        H.D = types.SimpleNamespace(debug=lambda w, e: None, _mod=lambda n: fake)
        got = H.waiting_card()
        self.assertEqual(got["count"], 4)
        self.assertEqual(len(got["items"]), 4)
        self.assertEqual(got["items"][0]["sub"], "shop · Decide")
        self.assertEqual((got["items"][0]["project"], got["items"][0]["tag"]), ("shop", "Decide"))

    def test_now_finds_a_session_by_its_window_address_or_id(self):
        r = row("opencode:/abc-123", "working")
        self.assertTrue(H._match(r, "opencode:/abc-123"))
        self.assertTrue(H._match(r, "abc-123"))
        self.assertTrue(H._match(r, "agent-host-opencode:/abc-123"))
        self.assertFalse(H._match(r, "abc"))
        self.assertFalse(H._match(r, ""))


if __name__ == "__main__":
    unittest.main()
