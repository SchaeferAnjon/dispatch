import contextlib
import datetime
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import dispatch  # noqa: E402
import lineage  # noqa: E402  (the same `dispatch` instance the module calls into, so patches land)


class HereView(unittest.TestCase):
    def test_acceptance_progress_counts_both_cases(self):
        self.assertEqual(lineage.acceptance_progress({"acceptance_criteria": "- [x] a\n- [ ] b\n- [X] c"}), (2, 3))
        self.assertEqual(lineage.acceptance_progress({}), (0, 0))

    def test_open_tasks_in_progress_first_with_acceptance_and_last_note(self):
        issues = [
            {"id": "t1", "title": "A", "status": "open", "updated_at": "2026-09-01T00:00:00Z", "acceptance_criteria": "- [x] a\n- [ ] b"},
            {"id": "t2", "title": "B", "status": "in_progress", "updated_at": "2026-09-02T00:00:00Z", "acceptance_criteria": "- [ ] a\n- [ ] b"},
            {"id": "t3", "title": "C", "status": "closed", "updated_at": "2026-09-03T00:00:00Z"},
        ]
        comments = {"t1": [{"created_at": "2026-09-02T00:00:00Z", "text": "最新进展一句话"}]}
        rows = lineage.here_open_tasks(issues, comments)
        self.assertEqual([r["id"] for r in rows], ["t2", "t1"])
        self.assertEqual((rows[1]["acceptance_done"], rows[1]["acceptance_total"]), (1, 2))
        self.assertEqual(rows[1]["last_note"], "最新进展一句话")

    def test_timeline_groups_by_day_and_skips_discussion_chatter(self):
        now = time.time()
        iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
        issues = [{"id": "t1", "title": "标题", "status": "open", "updated_at": iso},
                  {"id": "t2", "title": "完成的", "status": "closed", "closed_at": iso, "close_reason": "做完了"}]
        comments = {"t1": [{"created_at": iso, "text": "进展一句话"}, {"created_at": iso, "text": "【讨论】不该进时间线"}]}
        with patch.object(dispatch, "git_root_of", return_value=""), \
             patch.object(dispatch, "project_names", return_value={}), \
             patch.object(dispatch, "settings_load", return_value={}), \
             patch.object(dispatch, "load_index", return_value={}):
            days = lineage.here_timeline("p", issues, comments, 14, "")
        entries = [e for d in days for e in d["entries"]]
        texts = " ".join(e["text"] for e in entries)
        self.assertIn("进展一句话", texts)
        self.assertIn("完成「完成的」", texts)
        self.assertNotIn("不该进时间线", texts)
        self.assertTrue(all(len(d["entries"]) >= 1 for d in days))
        self.assertEqual(entries[0]["task"], "t1")
        self.assertTrue(all("task" in e for e in entries))

    def test_here_comments_reads_off_the_export_instead_of_shelling_out(self):
        iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        issues = [
            {"id": "t1", "status": "open", "updated_at": iso,
             "comments": [{"created_at": iso, "text": "后写"}, {"created_at": iso, "text": "先写"}]},
            {"id": "t2", "status": "closed", "closed_at": "2000-01-01T00:00:00Z",
             "comments": [{"created_at": "2000-01-01T00:00:00Z", "text": "太久以前"}]},
        ]
        with patch.object(dispatch, "bd_comments") as m:
            got = lineage.here_comments(issues, time.time() - 14 * 86400)
        m.assert_not_called()
        self.assertNotIn("t2", got)
        self.assertEqual(sorted(c["text"] for c in got["t1"]), sorted(["先写", "后写"]))


class Lineage(unittest.TestCase):
    def test_tree_links_sessions_events_and_deps(self):
        issues = [{"id": "task-a", "title": "甲", "status": "in_progress", "acceptance_criteria": "- [x] a\n- [ ] b",
                   "assignee": "claude-code", "updated_at": "2026-09-02T00:00:00Z", "labels": ["session:s1", "project:p"],
                   "comments": [{"created_at": "2026-09-02T00:00:00Z", "text": "进展一"}],
                   "dependencies": [{"issue_id": "task-a", "depends_on_id": "task-b", "type": "blocks", "dependency_count": 1}]}]
        live = [{"session_id": "s1", "agent": "claude-code", "title": "会话一", "summary": "在做甲", "state": "idle",
                 "last_at": 1, "verdict": "可关", "reason": "", "files_count": 0,
                 "tasks": [{"id": "task-a", "title": "甲", "status": "in_progress"}]}]
        idx = {"p": {"agent": "claude-code", "session_id": "s1", "tasks": {"task-a": 2}, "claims": ["task-a"],
                     "cwd": "/x", "mtime": 1, "title": "会话一"}}
        with patch.object(lineage, "project_issues", return_value=issues), \
             patch.object(lineage, "here_comments", return_value={"task-a": [{"created_at": "2026-09-02T00:00:00Z", "text": "进展一"}]}), \
             patch.object(dispatch, "project_names", return_value={}), \
             patch.object(dispatch, "settings_load", return_value={}), \
             patch.object(lineage, "here_sessions", return_value=live), \
             patch.object(dispatch, "load_index", return_value=idx), \
             patch.object(dispatch, "git_root_of", return_value=""), \
             patch.object(lineage, "project_base", return_value="/x"):
            r = lineage.lineage_report("p", 14, "/x")
        t = r["tasks"][0]
        self.assertEqual((t["id"], t["acceptance_done"], t["acceptance_total"]), ("task-a", 1, 2))
        self.assertEqual([s["session_id"] for s in t["sessions"]], ["s1"])
        self.assertEqual(t["sessions"][0]["verdict"], "可关")
        self.assertEqual(t["events"][0]["kind"], "task")
        self.assertIn("进展一", t["events"][0]["text"])
        self.assertEqual(t["deps"], [{"type": "blocks", "label": "解锁", "id": "task-b"}])
        self.assertEqual(t["short"], "甲")
        self.assertEqual(t["events"][0]["short"][:2], "进展")
        self.assertEqual(t["sessions"][0]["short"], "会话一")
        self.assertEqual(r["counts"]["tasks"], 1)


if __name__ == "__main__":
    unittest.main()
