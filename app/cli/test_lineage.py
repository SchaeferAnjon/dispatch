# -*- coding: utf-8 -*-
import contextlib
import datetime
import hashlib
import io
import json
import os
import shutil
import sys

# Inside every 14-day window the reports use, however long this file sits in the repo.
RECENT = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
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
            {"id": "t2", "title": "B", "status": "in_progress", "updated_at": RECENT, "acceptance_criteria": "- [ ] a\n- [ ] b"},
            {"id": "t3", "title": "C", "status": "closed", "updated_at": "2026-09-03T00:00:00Z"},
        ]
        comments = {"t1": [{"created_at": RECENT, "text": "最新进展一句话"}]}
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

    def test_timeline_session_belongs_by_claim_or_label_never_by_mention(self):
        now = time.time()
        iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
        issues = [{"id": "task-a", "title": "甲", "status": "open", "updated_at": iso, "labels": ["session-origin:s2", "session:s2"]},
                  {"id": "task-b", "title": "乙", "status": "open", "updated_at": iso, "labels": ["session:s2"]}]
        idx = {"1": {"session_id": "s1", "agent": "claude-code", "user_msgs": 3, "mtime": now, "cwd": "/p", "title": "只是提到", "tasks": {"task-a": 5}, "claims": []},
               "2": {"session_id": "s2", "agent": "claude-code", "user_msgs": 3, "mtime": now, "cwd": "/p", "title": "发起甲", "tasks": {"task-b": 1}, "claims": []},
               "3": {"session_id": "s3", "agent": "claude-code", "user_msgs": 3, "mtime": now, "cwd": "/p", "title": "认领乙", "tasks": {}, "claims": ["task-b"]}}
        prefs = {f"claude-code:{k}": {"summary": "总结"} for k in ("s1", "s2", "s3")}
        import activity
        with patch.object(dispatch, "git_root_of", return_value=""), patch.object(dispatch, "project_names", return_value={}), \
             patch.object(dispatch, "settings_load", return_value={}), patch.object(dispatch, "load_index", return_value=idx), \
             patch.object(dispatch, "project_of_cwd", return_value="p"), patch.object(activity, "session_preferences", return_value=prefs):
            days = lineage.here_timeline("p", issues, {}, 14, "/p")
        by = {e["ref"]: e["task"] for d in days for e in d["entries"] if e["kind"] == "session"}
        self.assertEqual(by, {"s1": "", "s2": "task-a", "s3": "task-b"})

    def test_timeline_session_entry_lists_every_linked_task_not_just_the_claimed_one(self):
        """A session on several tasks' session:/session-origin: labels belongs under each of
        them on the 项目回顾 timeline (`tasks`), not only the one it claimed (`task`)."""
        now = time.time()
        iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
        issues = [{"id": "task-a", "title": "甲", "status": "open", "updated_at": iso, "labels": ["session-origin:s2", "session:s2"]},
                  {"id": "task-b", "title": "乙", "status": "open", "updated_at": iso, "labels": ["session:s2"]}]
        idx = {"1": {"session_id": "s1", "agent": "claude-code", "user_msgs": 3, "mtime": now, "cwd": "/p", "title": "只是提到", "tasks": {"task-a": 5}, "claims": []},
               "2": {"session_id": "s2", "agent": "claude-code", "user_msgs": 3, "mtime": now, "cwd": "/p", "title": "发起甲也做乙", "tasks": {"task-b": 1}, "claims": []},
               "3": {"session_id": "s3", "agent": "claude-code", "user_msgs": 3, "mtime": now, "cwd": "/p", "title": "认领乙", "tasks": {}, "claims": ["task-b"]}}
        prefs = {f"claude-code:{k}": {"summary": "总结"} for k in ("s1", "s2", "s3")}
        import activity
        with patch.object(dispatch, "git_root_of", return_value=""), patch.object(dispatch, "project_names", return_value={}), \
             patch.object(dispatch, "settings_load", return_value={}), patch.object(dispatch, "load_index", return_value=idx), \
             patch.object(dispatch, "project_of_cwd", return_value="p"), patch.object(activity, "session_preferences", return_value=prefs):
            days = lineage.here_timeline("p", issues, {}, 14, "/p")
        by = {e["ref"]: sorted(t["id"] for t in e["tasks"]) for d in days for e in d["entries"] if e["kind"] == "session"}
        self.assertEqual(by, {"s1": [], "s2": ["task-a", "task-b"], "s3": ["task-b"]})

    def test_session_task_links_collects_origin_and_participant_labels_per_task(self):
        issues = [{"id": "task-a", "labels": ["session-origin:s1", "session:s1"]},
                  {"id": "task-b", "labels": ["session:s1", "session:s2"]}]
        links = lineage.session_task_links(issues)
        self.assertEqual(links, {"s1": {"task-a", "task-b"}, "s2": {"task-b"}})

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
                   "assignee": "claude-code", "updated_at": RECENT, "labels": ["session:s1", "project:p"],
                   "comments": [{"created_at": RECENT, "text": "进展一"}],
                   "dependencies": [{"issue_id": "task-a", "depends_on_id": "task-b", "type": "blocks", "dependency_count": 1}]}]
        live = [{"session_id": "s1", "agent": "claude-code", "title": "会话一", "summary": "在做甲", "state": "idle",
                 "last_at": 1, "verdict": "可关", "reason": "", "files_count": 0,
                 "tasks": [{"id": "task-a", "title": "甲", "status": "in_progress"}]}]
        idx = {"p": {"agent": "claude-code", "session_id": "s1", "tasks": {"task-a": 2}, "claims": ["task-a"],
                     "cwd": "/x", "mtime": 1, "title": "会话一"}}
        with patch.object(lineage, "project_issues", return_value=issues), \
             patch.object(lineage, "here_comments", return_value={"task-a": [{"created_at": RECENT, "text": "进展一"}]}), \
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
        self.assertNotIn("short", t)                       # nodes carry the board title, never a short name
        self.assertEqual(t["events"][0]["sentence"], "进展一")
        self.assertEqual(t["sessions"][0]["title"], "会话一")
        self.assertEqual(t["sessions"][0]["relation"], "在做")
        self.assertEqual(r["counts"]["tasks"], 1)

    def test_origin_session_is_the_main_line_and_others_thin(self):
        """「继续 task-b」in the session that created task-a: 发起 for a, 在做 for b, 提到 for c."""
        issues = [{"id": "task-a", "title": "甲", "status": "in_progress", "labels": ["session-origin:s1", "session:s1"], "updated_at": RECENT},
                  {"id": "task-b", "title": "乙", "status": "open", "labels": ["session:s1"], "updated_at": "2026-09-01T00:00:00Z"},
                  {"id": "task-c", "title": "丙", "status": "open", "labels": [], "updated_at": "2026-09-01T00:00:00Z"}]
        idx = {"p": {"agent": "claude-code", "session_id": "s1", "tasks": {"task-a": 2, "task-b": 1, "task-c": 1}, "claims": ["task-a"],
                     "cwd": "/x", "mtime": 1, "title": "会话一"}}
        with patch.object(lineage, "project_issues", return_value=issues), \
             patch.object(lineage, "here_comments", return_value={}), \
             patch.object(dispatch, "project_names", return_value={}), \
             patch.object(dispatch, "settings_load", return_value={}), \
             patch.object(lineage, "here_sessions", return_value=[]), \
             patch.object(dispatch, "load_index", return_value=idx), \
             patch.object(dispatch, "git_root_of", return_value=""), \
             patch.object(lineage, "project_base", return_value="/x"):
            r = lineage.lineage_report("p", 14, "/x")
        rel = {t["id"]: [(s["session_id"], s["relation"]) for s in t["sessions"]] for t in r["tasks"]}
        self.assertEqual(rel, {"task-a": [("s1", "发起")], "task-b": [("s1", "在做")], "task-c": [("s1", "提到")]})
        a = next(t for t in r["tasks"] if t["id"] == "task-a")
        self.assertEqual(a["sessions"][0]["also"], ["乙"])   # the other task it worked on, by title

    def test_first_sentence_keeps_the_whole_sentence(self):
        self.assertEqual(lineage.first_sentence("修好了会话线程的红条。然后装机验证"), "修好了会话线程的红条。")
        self.assertEqual(lineage.first_sentence("第一行\n第二行"), "第一行")
        self.assertEqual(lineage.first_sentence("没有句号的长句子" * 3), "没有句号的长句子" * 3)

    def test_git_commits_parses_window_and_task_ids(self):
        out = "abc1234\x1f2026-09-02T10:00:00+02:00\x1ffeat: 甲 (task-a)\nzzz9999\x1f2000-01-01T00:00:00+00:00\x1fold\n"
        with patch.object(dispatch, "sh", return_value=(0, out, "")):
            rows = lineage.git_commits("/repo", 14, 0)
            self.assertEqual([(r[1], r[2]) for r in rows], [("abc1234", "feat: 甲 (task-a)"), ("zzz9999", "old")])
            self.assertEqual([r[1] for r in lineage.git_commits("/repo", 14, time.time() - 10 * 365 * 86400)], ["abc1234"])
        self.assertEqual(lineage.task_of_commit("feat: 甲 (task-ab)", {"task-ab"}), "task-ab")
        self.assertEqual(lineage.task_of_commit("fix: 乙 (task-le3)", {"task-le3"}), "task-le3")   # 3-char ids exist on the board
        self.assertEqual(lineage.task_of_commit("feat: 甲 (task-zz)", {"task-a"}), "")
        self.assertEqual(lineage.git_commits("", 14, 0), [])


class RemoteMerge(unittest.TestCase):
    """项目回顾 must paint from the local board plus whatever the other Mac's cache holds —
    never waiting for its ssh (it needs seconds to compute its own side)."""

    def merge(self, age):
        now = time.time()
        remote = {"timeline": [{"day": "x", "weekday": "周一", "entries": [{"ts": now, "kind": "commit", "ref": "zzz", "text": "他们那台的提交"}]}],
                  "sessions": [{"session_id": "s-remote", "state": "idle"}]}
        seen = {}

        def fake(h, args, ttl, timeout=12, background=False):
            seen.update(args=args, ttl=ttl, background=background)
            return remote

        with patch.object(dispatch, "hosts", return_value=[{"id": "mini", "name": "mini", "ssh": "x"}]), \
             patch.object(dispatch, "remote_dispatch", side_effect=fake), \
             patch.object(dispatch, "remote_cache_age", return_value=age):
            return seen, lineage.merge_remote_here("p", 14, [], [])

    def test_merges_the_cache_and_never_blocks_on_the_ssh(self):
        seen, (grouped, sessions, hosts_seen, unavailable, stale) = self.merge(2)
        self.assertTrue(seen["background"])
        self.assertEqual(seen["args"], ["here", "p", "--no-summary", "--local", "--days", "14", "--json"])
        self.assertEqual(hosts_seen, ["mini"])
        self.assertEqual(unavailable, [])
        self.assertEqual(stale, [])
        self.assertEqual([e["host"] for g in grouped for e in g["entries"]], ["mini"])
        self.assertEqual([s["session_id"] for s in sessions], ["s-remote"])

    def test_a_cache_older_than_the_ttl_is_merged_but_reported_as_stale(self):
        _, (_, _, hosts_seen, _, stale) = self.merge(300)
        self.assertEqual(hosts_seen, ["mini"])
        self.assertEqual(stale, [{"name": "mini", "age": 300}])

    def test_a_host_that_never_answered_is_unavailable_not_a_wait(self):
        with patch.object(dispatch, "hosts", return_value=[{"id": "mini", "name": "mini", "ssh": "x"}]), \
             patch.object(dispatch, "remote_dispatch", return_value=None):
            grouped, sessions, hosts_seen, unavailable, stale = lineage.merge_remote_here("p", 14, [], [])
        self.assertEqual((hosts_seen, unavailable, stale, grouped, sessions), ([], ["mini"], [], [], []))


if __name__ == "__main__":
    unittest.main()


class ProjectBase(unittest.TestCase):
    def test_label_only_project_has_no_directory_to_read(self):
        # A project that exists only as task labels must not borrow the caller's repo.
        with patch.object(dispatch, "project_of_cwd", return_value="kanban"), patch.object(dispatch, "project_home", return_value=""):
            self.assertEqual(lineage.project_base("memories", "/Users/x/Projects/kanban", {}, []), "")
            self.assertEqual(lineage.project_base("kanban", "/Users/x/Projects/kanban", {}, []), "/Users/x/Projects/kanban")
        self.assertEqual(dispatch.git_root_of(""), "")
