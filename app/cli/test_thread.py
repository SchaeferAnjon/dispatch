# -*- coding: utf-8 -*-
import contextlib
import io
import json
import os
import sys
import time
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import dispatch  # noqa: E402
import thread  # noqa: E402

_settings = patch.object(dispatch, "settings_load", return_value={})  # workspace_roots come from a bd memory: no board here


def setUpModule():
    _settings.start()


def tearDownModule():
    _settings.stop()

WINDOWS_READY = True

# The last local noon, not the wall clock: the fixtures put records up to two hours apart on one
# day, and near midnight they would spill into the next one.
_lt = time.localtime()
NOW = time.mktime((_lt.tm_year, _lt.tm_mon, _lt.tm_mday, 12, 0, 0, 0, 0, -1))
if NOW > time.time():
    NOW -= 86400


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def at(days_ago, minutes=0):
    return iso(NOW - days_ago * 86400 + minutes * 60)


def c(ts, author, text):
    return {"created_at": ts, "author": author, "text": text}


def ctx_of(issues, live=None, commits=None):
    ctx = thread.Ctx(issues, live=live or {}, index={})
    ctx._names = {"kanban": "kanban", "harbor": "harbor"}
    for p in ("kanban", "harbor"):
        ctx._commits[p] = commits or {}
    return ctx


def discussion_board():
    """A discussion that closed the same afternoon and split off three tasks, one still open."""
    d = 20
    return [
        {"id": "task-root", "title": "【讨论】Dispatch 的讨论怎么优化。现状：太慢", "status": "closed", "assignee": "claude-code",
         "description": "Dispatch 的讨论怎么优化。\n\n用户反馈的问题：一个个启 Agent 太慢；要像真同事。\n\n参加：claude, codex, pi。",
         "labels": ["project:kanban", "dispatch:discussion"], "created_at": at(d), "updated_at": at(d, 50), "closed_at": at(d, 47),
         "close_reason": "5 步全部完成并重装验证，提交 9156854、b7a14cf、c4f0215，已 push。计时 167s → 57s。",
         "comments": [
             c(at(d), "claude-code", "【讨论】发起：claude-code 邀请 claude, codex, pi 讨论"),
             c(at(d, 1), "codex", "【讨论】codex（GPT-6）：别做流水线。第一轮后只叫被 @ 的人。"),
             c(at(d, 2), "claude-code", "【讨论】claude（Fable 5.1）：成本在起 TUI。改成 headless。"),
             c(at(d, 3), "pi", "【讨论】pi（GLM）：加个便宜裁判。"),
             c(at(d, 4), "dispatch", "【结论】三点都同意做；分歧只在主瓶颈。下一步先验证 headless。"),
             c(at(d, 6), "claude-code", "claude-code 通过 dispatch agent 派给 claude-code（Herdr w1:p2G @ 小蓝，目录 /x）"),
             c(at(d, 7), "claude-code", "接手：计划先量基线，再 headless。"),
             c(at(d, 19), "claude-code", "第 1 步已提交：一轮 167s → 88s。"),
             c(at(d, 23), "claude-code", "第 2 步已提交：一轮 60s → 38s。"),
             c(at(d, 26), "claude-code", "第 3 步已提交：人设进设置。"),
             c(at(d, 47), "claude-code", "提交：\n2573fbb docs: x (task-root)\n2d04938 fix: y (task-root)"),
         ]},
        {"id": "task-ehd", "title": "便宜裁判", "status": "closed", "assignee": "claude-code", "labels": ["project:kanban"],
         "dependencies": [{"issue_id": "task-ehd", "depends_on_id": "task-root", "type": "discovered-from"}],
         "created_at": at(d, 48), "updated_at": at(d, 200), "closed_at": at(d, 195), "close_reason": "裁判调用接上（c982b1c）。",
         "comments": []},
        {"id": "task-993z", "title": "@ 自动补全", "status": "open", "labels": ["project:kanban"],
         "dependencies": [{"issue_id": "task-993z", "depends_on_id": "task-ehd", "type": "discovered-from"}],
         "created_at": at(d, 195), "updated_at": at(d, 195), "comments": []},
        {"id": "task-88p", "title": "讨论要有个主持人", "status": "closed", "assignee": "claude-code", "labels": ["project:kanban", "discussed-in:task-root"],
         "created_at": at(d, 60), "updated_at": at(d, 71), "closed_at": at(d, 71), "close_reason": "主持人进讨论设置。", "comments": []},
        {"id": "task-lone", "title": "一个没分出过任务的", "status": "closed", "labels": ["project:kanban"], "created_at": at(30), "updated_at": at(30), "closed_at": at(30), "comments": []},
        {"id": "task-out", "title": "成果", "status": "closed", "labels": ["project:kanban", "dispatch:outcome"], "created_at": at(1), "updated_at": at(1), "comments": []},
    ]


def gap_board():
    """Three rounds in one day, then two weeks of nothing, then a close that ends both branches."""
    return [
        {"id": "task-p3vz", "title": "日记的推荐面板", "status": "closed", "assignee": "claude-code", "labels": ["project:harbor"],
         "description": "用户提出：底部抽屉分推荐和最近活动两栏。", "created_at": at(16), "updated_at": at(1), "closed_at": at(1), "close_reason": "收尾工作流一次合并。（未核验）",
         "comments": [c(at(16, 60), "claude-code", "第 2 轮：竖版富卡片。"), c(at(16, 120), "claude-code", "第 3 轮：按 Apple Journal 重做。")]},
        {"id": "task-th76", "title": "照片权限和地名", "status": "closed", "labels": ["project:harbor"],
         "dependencies": [{"depends_on_id": "task-p3vz", "type": "discovered-from"}], "created_at": at(16, 50), "updated_at": at(1), "closed_at": at(1), "close_reason": "一起关掉。", "comments": []},
        {"id": "task-qfju", "title": "手机上给心情权限", "status": "open", "labels": ["project:harbor"],
         "dependencies": [{"depends_on_id": "task-p3vz", "type": "parent-child"}], "created_at": at(16, 130), "updated_at": at(16, 130), "comments": []},
    ]


def running_board():
    return [
        {"id": "task-4gei", "title": "界面改成 Raycast 风格：用户嫌现在丑", "status": "in_progress", "assignee": "claude-code",
         "description": "原标题：界面改成 Raycast 风格：用户嫌现在布局和控件丑，想要 Raycast 那种", "labels": ["project:kanban", "session-origin:s1", "session:s1"],
         "created_at": at(0, -0.1), "updated_at": at(0, -0.01),
         "comments": [c(at(0, -0.08), "claude-code", "用户认可样稿（就这版）。默认：保留侧栏。"), c(at(0, -0.05), "claude-code", "【决定】默认走当前项目。")]},
        {"id": "task-wait", "title": "续费开发者账号", "status": "open", "labels": ["project:kanban", "dispatch:needs-you"], "created_at": at(2), "updated_at": at(2), "comments": []},
    ]


class Forest(unittest.TestCase):
    def test_roots_and_trees_follow_discovered_parent_and_discussed_in(self):
        ctx = ctx_of(discussion_board())
        self.assertEqual(thread.root_of("task-993z", ctx.parent), "task-root")
        self.assertEqual(thread.root_of("task-88p", ctx.parent), "task-root")
        self.assertEqual(set(thread.subtree("task-root", ctx.children)), {"task-root", "task-ehd", "task-993z", "task-88p"})
        self.assertNotIn("task-out", ctx.by)

    def test_a_dependency_cycle_does_not_hang(self):
        issues = [{"id": "a", "labels": [], "dependencies": [{"depends_on_id": "b", "type": "discovered-from"}]},
                  {"id": "b", "labels": [], "dependencies": [{"depends_on_id": "a", "type": "discovered-from"}]}]
        by, parent, children = thread.forest(issues)
        self.assertEqual(len(parent), 1)
        self.assertIn(thread.root_of("a", parent), ("a", "b"))


class DiscussionLine(unittest.TestCase):
    def setUp(self):
        self.r = thread.thread_report("task-993z", ctx_of(discussion_board()), now=NOW)

    def beats(self):
        return [b for d in self.r["days"] for b in d["beats"]]

    def test_walks_up_to_the_root_and_counts_the_line(self):
        r = self.r
        self.assertEqual((r["root"], r["selected"]), ("task-root", "task-993z"))
        self.assertEqual(r["title"], "Dispatch 的讨论怎么优化")
        self.assertEqual((r["task_count"], r["closed_count"], r["open_count"]), (4, 3, 1))
        self.assertEqual(r["line"]["decisions"], 1)
        self.assertEqual(r["line"]["commits"], 6)  # 3 in the reason, 2 in 提交：, c982b1c on the branch
        self.assertEqual(r["line"]["agents"], ["claude-code", "codex", "pi"])

    def test_the_users_words_come_from_the_description(self):
        self.assertTrue(self.r["ask"]["text"].startswith("一个个启 Agent 太慢"))
        first = self.beats()[0]
        self.assertEqual((first["kind"], first["discussion"], first["host"]), ("ask", True, "claude-code"))

    def test_beat_kinds_in_order(self):
        kinds = [b["kind"] for b in self.beats()]
        self.assertEqual(kinds, ["ask", "discuss", "decide", "claim", "did", "done", "fork", "fork"])

    def test_discussion_round_folds_with_each_member(self):
        disc = next(b for b in self.beats() if b["kind"] == "discuss")
        self.assertEqual([(m["who"], m["model"]) for m in disc["members"]], [("codex", "GPT-6"), ("claude", "Fable 5.1"), ("pi", "GLM")])

    def test_route_and_claim_merge_into_one_row(self):
        claim = next(b for b in self.beats() if b["kind"] == "claim")
        self.assertEqual((claim["routed"], claim["text"]), (True, "计划先量基线，再 headless。"))

    def test_three_steps_fold_with_their_numbers(self):
        did = next(b for b in self.beats() if b["kind"] == "did")
        self.assertTrue(did["fold"])
        self.assertEqual(did["count"], 3)
        self.assertEqual(did["summary"][:2], ["167s → 88s", "60s → 38s"])

    def test_close_drops_the_hashes_and_carries_the_commits(self):
        done = next(b for b in self.beats() if b["kind"] == "done")
        self.assertNotIn("9156854", done["full"])
        self.assertIn("167s → 57s", done["full"])
        self.assertEqual(done["commits"][:3], ["2d04938", "2573fbb", "9156854"])
        self.assertIsNone(done["verified"])

    def test_forks_fold_their_own_line_and_say_what_is_left(self):
        forks = [b for b in self.beats() if b["kind"] == "fork"]
        ehd = forks[0]
        self.assertEqual((ehd["task"], ehd["open_after"], ehd["commits"]), ("task-ehd", 1, ["c982b1c"]))
        self.assertEqual([b["kind"] for b in ehd["beats"]], ["done", "open"])
        self.assertEqual(forks[1]["task"], "task-88p")

    def test_open_tail_and_left_box(self):
        self.assertEqual([x["id"] for x in self.r["left"]], ["task-993z"])
        self.assertEqual(self.r["left"][0]["from"], "task-ehd")
        self.assertEqual(self.r["tail"][0]["state"], "open")
        self.assertEqual(self.r["now"]["branches"], {"total": 3, "closed": 2})


class GapLine(unittest.TestCase):
    def test_two_weeks_without_a_move_is_a_gap(self):
        r = thread.thread_report("task-p3vz", ctx_of(gap_board()), now=NOW)
        beats = [b for d in r["days"] for b in d["beats"]]
        gaps = [b for b in beats if b["kind"] == "gap"]
        self.assertEqual(len(gaps), 1)
        self.assertGreaterEqual(gaps[0]["days"], 14)
        self.assertEqual(len(r["days"]), 2)
        done = next(b for b in beats if b["kind"] == "done" and b["task"] == "task-p3vz")
        self.assertFalse(done["verified"])
        self.assertEqual(r["ask"]["text"], "底部抽屉分推荐和最近活动两栏。")
        # a parent-child child without records of its own is an 开着 row where it was split off
        self.assertIn("open", [b["kind"] for b in beats])


class RunningToday(unittest.TestCase):
    def test_running_line_with_a_decision_and_a_waiting_single(self):
        ctx = ctx_of(running_board(), live={"s1": "working"})
        r = thread.thread_report("task-4gei", ctx, now=NOW)
        self.assertEqual(r["state"], "run")
        self.assertEqual(r["short"], "界面改成 Raycast 风格")
        self.assertIn("布局和控件丑", r["ask"]["text"])
        beats = [b for d in r["days"] for b in d["beats"]]
        self.assertEqual([b.get("tag") for b in beats if b["kind"] == "decide"], ["拍板", "决定"])
        self.assertEqual(r["line"]["decisions"], 2)
        self.assertTrue(r["days"][-1]["today"])
        self.assertEqual(r["tail"][0]["state"], "run")

        lst = thread.threads_list(ctx, "kanban")
        self.assertEqual([x["root"] for x in lst["threads"]], ["task-4gei", "task-wait"])
        self.assertEqual([x["state"] for x in lst["threads"]], ["run", "wait"])
        self.assertEqual(lst["counts"]["moving"], 2)
        self.assertNotIn("singles", lst)


class ListAndCommands(unittest.TestCase):
    def test_list_folds_single_tasks_and_lists_them_with_all(self):
        ctx = ctx_of(discussion_board())
        lst = thread.threads_list(ctx, "kanban", with_singles=True)
        self.assertEqual([x["root"] for x in lst["threads"]], ["task-root"])
        self.assertEqual(lst["threads"][0]["open_count"], 1)
        self.assertEqual(lst["threads"][0]["state"], "open")
        self.assertEqual([x["root"] for x in lst["singles"]], ["task-lone"])
        self.assertEqual(thread.threads_list(ctx, "", everywhere=True)["counts"]["singles"], 1)

    def test_cmd_thread_json_for_a_task_and_for_a_project(self):
        board = discussion_board()
        with patch.object(thread, "board_issues", return_value=board), patch.object(thread.Ctx, "live", return_value={}), \
             patch.object(thread.Ctx, "index", return_value={}), patch.object(thread.Ctx, "commits", return_value={}), \
             patch.object(dispatch, "settings_load", return_value={}):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                thread.cmd_thread(types.SimpleNamespace(target="task-88p", json=True, dir="", all=False, all_projects=False))
            self.assertEqual(json.loads(buf.getvalue())["root"], "task-root")
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                thread.cmd_thread(types.SimpleNamespace(target="kanban", json=True, dir="", all=True, all_projects=False))
            got = json.loads(buf.getvalue())
            self.assertEqual(got["project"], "kanban")
            self.assertEqual(len(got["singles"]), 1)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                thread.cmd_thread(types.SimpleNamespace(target="task-root", json=False, dir="", all=False, all_projects=False))
            self.assertIn("走到哪", buf.getvalue())

    def test_decide_writes_a_prefixed_comment(self):
        calls = []
        with patch.object(dispatch, "sh", side_effect=lambda args, **k: calls.append(args) or (0, "", "")):
            with contextlib.redirect_stdout(io.StringIO()):
                thread.cmd_decide(types.SimpleNamespace(task="task-x", text="就这版", json=False))
        self.assertEqual(calls, [["bd", "comments", "add", "task-x", "【决定】就这版"]])

    def test_decide_needs_a_sentence(self):
        with self.assertRaises(SystemExit):
            thread.cmd_decide(types.SimpleNamespace(task="task-x", text="  ", json=False))

    def test_strip_hashes_keeps_numbers(self):
        self.assertEqual(thread.strip_hashes("一轮 167s → 57s，提交 9156854、b7a14cf，已 push。（未核验）"), "一轮 167s → 57s，已 push。")
        self.assertEqual(thread.hashes_in("提交 9156854、b7a14cf"), ["9156854", "b7a14cf"])
        self.assertEqual(thread.hashes_in("共 1234567 条"), [])


def many_singles_board(n=30):
    """A project with n finished one-task lines, one a day, and one running line from long ago."""
    rows = [{"id": f"task-s{i:02d}", "title": f"小事 {i}", "status": "closed", "labels": ["project:kanban"], "created_at": at(n - i + 40), "updated_at": at(n - i),
             "closed_at": at(n - i), "close_reason": f"小事 {i} 做完，提交 abc{i:04d}f。", "comments": []} for i in range(n)]
    rows.append({"id": "task-old", "title": "很久以前开的", "status": "in_progress", "assignee": "codex", "labels": ["project:kanban", "session:s9"],
                 "created_at": at(90), "updated_at": at(89), "comments": [c(at(89), "codex", "接手：还在做。")]})
    return rows


class ProjectThread(unittest.TestCase):
    def test_every_line_is_a_chapter_oldest_move_first(self):
        ctx = ctx_of(discussion_board())
        r = thread.project_report("kanban", ctx, now=NOW)
        self.assertEqual(r["kind"], "project")
        self.assertEqual(r["project"], "kanban")
        self.assertEqual([x["root"] for x in r["chapters"]], ["task-lone", "task-root"])
        self.assertEqual(r["stats"]["lines"], 2)
        self.assertEqual(r["stats"]["tasks"], 5)          # the outcome is not a task on the line
        self.assertEqual(r["stats"]["decisions"], 1)
        self.assertEqual(r["now"]["lines"], {"total": 2, "moving": 1, "closed": 1})
        root = r["chapters"][1]
        self.assertTrue(root["expanded"] and root["shown"])
        self.assertIn("days", root)
        self.assertEqual([b["kind"] for b in root["days"][0]["beats"]][:3], ["ask", "discuss", "decide"])
        lone = r["chapters"][0]
        self.assertFalse(lone["expanded"])
        self.assertNotIn("days", lone)

    def test_left_box_lists_open_tasks_with_their_line(self):
        ctx = ctx_of(discussion_board())
        r = thread.project_report("kanban", ctx, now=NOW)
        self.assertEqual([x["id"] for x in r["left"]], ["task-993z"])
        self.assertEqual(r["left"][0]["root"], "task-root")
        self.assertEqual(r["left"][0]["root_title"], "Dispatch 的讨论怎么优化")
        self.assertEqual(r["tail"][0]["kind"], "open")
        # 走到哪: the latest closes, newest first, without their commit hashes
        self.assertEqual([x["task"] for x in r["now"]["closes"]], ["task-ehd", "task-88p", "task-root"])
        self.assertNotIn("9156854", r["now"]["closes"][2]["text"])

    def test_old_chapters_wait_behind_earlier_and_a_focus_opens_its_own(self):
        ctx = ctx_of(many_singles_board(), live={"s9": "working"})
        r = thread.project_report("kanban", ctx, now=NOW)
        self.assertEqual(len(r["chapters"]), 31)
        shown = [x["root"] for x in r["chapters"] if x["shown"]]
        self.assertIn("task-old", shown)              # running: always there, however old
        self.assertEqual(len(shown), thread.SHOW_CHAPTERS + 1)
        self.assertEqual(r["hidden"], 31 - len(shown))
        self.assertEqual(r["chapters"][0]["root"], "task-old")
        self.assertEqual([x["root"] for x in r["chapters"] if x["expanded"]], ["task-old"])
        self.assertEqual(r["state"], "run")
        self.assertEqual(r["chapters"][-1]["gist"]["text"], "小事 29 做完。")
        f = thread.project_report("kanban", ctx, now=NOW, focus="task-s00")
        s00 = next(x for x in f["chapters"] if x["root"] == "task-s00")
        self.assertTrue(s00["shown"] and s00["expanded"] and s00["days"])
        self.assertEqual(f["focus_root"], "task-s00")

    def test_projects_list_one_row_per_project(self):
        ctx = ctx_of(discussion_board() + gap_board() + running_board(), live={"s1": "working"})
        lst = thread.projects_list(ctx, now=NOW)
        rows = {e["name"]: e for e in lst["projects"]}
        self.assertEqual(set(rows), {"kanban", "harbor"})
        self.assertEqual(rows["kanban"]["state"], "run")
        self.assertEqual(rows["kanban"]["lines"], 4)
        self.assertEqual(rows["kanban"]["wait"], 1)
        self.assertEqual(rows["harbor"]["state"], "open")
        self.assertEqual(rows["harbor"]["open"], 1)
        self.assertEqual(lst["projects"][0]["name"], "kanban")   # newest move first

    def test_cmd_thread_project_lines_and_projects(self):
        board = discussion_board()
        with patch.object(thread, "board_issues", return_value=board), patch.object(thread.Ctx, "live", return_value={}), \
             patch.object(thread.Ctx, "index", return_value={}), patch.object(thread.Ctx, "commits", return_value={}), \
             patch.object(dispatch, "settings_load", return_value={}):
            def run(**kw):
                ns = dict(target="kanban", json=True, dir="", all=False, all_projects=False, lines=False, projects=False, task="")
                ns.update(kw)
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    thread.cmd_thread(types.SimpleNamespace(**ns))
                return buf.getvalue()
            got = json.loads(run())
            self.assertEqual(got["kind"], "project")
            self.assertEqual(len(got["chapters"]), 2)
            self.assertEqual(json.loads(run(task="task-993z"))["focus_root"], "task-root")
            self.assertEqual([x["root"] for x in json.loads(run(lines=True))["threads"]], ["task-root"])
            self.assertEqual(json.loads(run(target="", projects=True))["projects"][0]["name"], "kanban")
            text = run(json=False)
            self.assertIn("这个项目：2 条线", text)
            self.assertIn("现在", text)
            self.assertIn("走到哪", run(target="task-root", json=False))


def crossing_board():
    """A kanban line with an TUTOR task split off it, a deferred kanban task, and a line with no project."""
    return [
        {"id": "task-kroot", "title": "Dispatch 大改", "status": "open", "labels": ["project:kanban"], "created_at": at(5), "updated_at": at(5), "comments": []},
        {"id": "task-kkid", "title": "看板子任务", "status": "open", "labels": ["project:kanban"], "created_at": at(4), "updated_at": at(4), "comments": [],
         "dependencies": [{"type": "discovered-from", "depends_on_id": "task-kroot"}]},
        {"id": "task-tutor", "title": "Lakenet 接入", "status": "open", "labels": ["project:TUTOR"], "created_at": at(3), "updated_at": at(3), "comments": [],
         "dependencies": [{"type": "discovered-from", "depends_on_id": "task-kroot"}]},
        {"id": "task-hkid", "title": "Lakenet 子任务", "status": "open", "labels": [], "created_at": at(2), "updated_at": at(2), "comments": [],
         "dependencies": [{"type": "discovered-from", "depends_on_id": "task-tutor"}]},
        {"id": "task-kdef", "title": "搁置的事", "status": "deferred", "labels": ["project:kanban"], "created_at": at(6), "updated_at": at(6), "comments": []},
        {"id": "task-none", "title": "没项目的事", "status": "in_progress", "labels": [], "created_at": at(1), "updated_at": at(1), "comments": []},
    ]


class ProjectMembership(unittest.TestCase):
    def test_a_task_counts_under_its_own_project_not_its_roots(self):
        ctx = ctx_of(crossing_board())
        h = thread.project_report("TUTOR", ctx, now=NOW)
        self.assertEqual([x["root"] for x in h["chapters"]], ["task-tutor"])
        self.assertEqual(sorted(x["id"] for x in h["left"]), ["task-hkid", "task-tutor"])   # the unlabelled child stays with its line
        k = thread.project_report("kanban", ctx, now=NOW)
        self.assertNotIn("task-tutor", [x["id"] for x in k["left"]])
        self.assertEqual(k["task_count"], 3)
        # 搁置 is not open, as in 项目回顾's 还没做完
        self.assertEqual(sorted(x["id"] for x in k["left"]), ["task-kkid", "task-kroot"])
        self.assertEqual(k["open_count"], 2)
        self.assertEqual(k["closed_count"], 0)
        # the line read as TUTOR's chapter starts at the TUTOR task and holds only TUTOR's tasks
        line = thread.thread_report("task-tutor", thread.project_view(ctx, "TUTOR"), NOW)
        self.assertEqual((line["root"], line["task_count"]), ("task-tutor", 2))
        whole = thread.thread_report("task-hkid", ctx, NOW)
        self.assertEqual((whole["root"], whole["home_project"], whole["home_root"]), ("task-kroot", "TUTOR", "task-tutor"))

    def test_focus_on_a_task_of_another_project_opens_nothing(self):
        ctx = ctx_of(crossing_board())
        self.assertEqual(thread.project_report("kanban", ctx, now=NOW, focus="task-hkid")["focus_root"], "")
        self.assertEqual(thread.project_report("kanban", ctx, now=NOW, focus="task-kkid")["focus_root"], "task-kroot")

    def test_lines_without_a_project_have_their_own_board(self):
        ctx = ctx_of(crossing_board())
        rows = {e["name"]: e for e in thread.projects_list(ctx, now=NOW)["projects"]}
        self.assertEqual(rows[thread.NO_PROJECT]["open"], 1)
        self.assertEqual((rows["TUTOR"]["lines"], rows["TUTOR"]["open"]), (1, 2))
        self.assertEqual(rows["kanban"]["open"], 2)
        r = thread.project_report(thread.NO_PROJECT, ctx, now=NOW)
        self.assertEqual([x["root"] for x in r["chapters"]], ["task-none"])
        self.assertEqual(r["project"], thread.NO_PROJECT)

    def test_cmd_thread_hyphenated_project_and_missing_task(self):
        board = crossing_board()
        with patch.object(thread, "board_issues", return_value=board), patch.object(thread.Ctx, "live", return_value={}), \
             patch.object(thread.Ctx, "index", return_value={}), patch.object(thread.Ctx, "commits", return_value={}), \
             patch.object(dispatch, "settings_load", return_value={}):
            def run(**kw):
                ns = dict(target="beads-ui", json=True, dir="", all=False, all_projects=False, lines=False, projects=False, task="", inside="")
                ns.update(kw)
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
                    thread.cmd_thread(types.SimpleNamespace(**ns))
                return buf.getvalue()
            # a project shaped like a task id with only sessions: an empty 脉络, not an error
            got = json.loads(run())
            self.assertEqual((got["kind"], got["project"], got["chapters"]), ("project", "beads-ui", []))
            with self.assertRaises(SystemExit):
                run(target="task-zzzz")
            self.assertEqual(json.loads(run(target="task-tutor", inside="TUTOR"))["task_count"], 2)
            self.assertEqual(json.loads(run(target="task-tutor"))["root"], "task-kroot")


def check(ts, lines, head="claude:sonnet · 2026-09-25 17:15 · 耗时 40s"):
    return c(ts, "dispatch-checker", "【验收】" + head + "\n" + "\n".join(lines))


def timeline_board():
    """harbor's shape: checker runs one after another, four tasks closed by one merge, a close
    that takes in the day's steps and commits, and older work two weeks back."""
    same = "6677e98"
    return [
        {"id": "task-go", "title": "go 模式", "status": "in_progress", "assignee": "claude-code", "labels": ["project:harbor", "session:s-go"],
         "acceptance_criteria": "- [x] a\n- [ ] b", "created_at": at(20), "updated_at": at(0, 60),
         "comments": [c(at(0, -300), "claude-code", "第 1 步：一轮 167s → 88s"), c(at(0, -290), "claude-code", "第 2 步：88s → 60s"),
                      c(at(0, -280), "claude-code", "第 3 步：人设进设置"),
                      check(at(0, 10), ["1. ✓ 已验证 · 提交在。", "2. ? 需要你确认 · 只能你在真机上确认。"])]},
        {"id": "task-t3", "title": "长按加号录音", "status": "open", "labels": ["project:harbor"], "created_at": at(3), "updated_at": at(0, 20),
         "comments": [check(at(0, 20), ["1. ✓ 已验证 · 代码在。", "2. ✗ 未通过 · 没有测试。"])]},
        {"id": "task-kd", "title": "写长日记闪退", "status": "closed", "assignee": "claude-code", "labels": ["project:harbor"],
         "created_at": at(1), "updated_at": at(0, -600), "closed_at": at(0, -600),
         "close_reason": "workflow 收尾（2026-09-25，合并提交 4d1e2c0）：正文换成系统 UITextView，UI 测试连续输入 6 段不退出。（未核验）",
         "comments": [c(at(1, 100), "claude-code", "查到崩溃在 Runestone"), c(at(1, 700), "claude-code", "换 UITextView 试")]},
        {"id": "task-a", "title": "习惯打卡", "status": "closed", "labels": ["project:harbor"], "created_at": at(5), "updated_at": at(1, 340),
         "closed_at": at(1, 340), "close_reason": f"workflow 收尾（2026-09-24，合并提交 {same}）：习惯进日记契约。", "comments": []},
        {"id": "task-b", "title": "日记编辑器统一", "status": "closed", "labels": ["project:harbor"], "created_at": at(5), "updated_at": at(1, 341),
         "closed_at": at(1, 341), "close_reason": f"workflow 收尾（2026-09-24，合并提交 {same}）：编辑器统一。", "comments": []},
        {"id": "task-c", "title": "日记真机验收", "status": "closed", "labels": ["project:harbor"], "created_at": at(5), "updated_at": at(1, 342),
         "closed_at": at(1, 342), "close_reason": f"workflow 收尾（2026-09-24，合并提交 {same}）：相册授权。", "comments": []},
        {"id": "task-old", "title": "两周前的事", "status": "closed", "labels": ["project:harbor"], "created_at": at(16), "updated_at": at(15),
         "closed_at": at(15), "close_reason": "作废：用户决定不做了。", "comments": []},
        {"id": "task-older", "title": "更早的事", "status": "closed", "labels": ["project:harbor"], "created_at": at(40), "updated_at": at(30),
         "closed_at": at(30), "close_reason": "做完了。", "comments": [c(at(31), "claude-code", "进展")]},
        {"id": "task-need", "title": "Xcode 登录", "status": "open", "labels": ["project:harbor", "dispatch:needs-you"], "created_at": at(2), "updated_at": at(2), "comments": []},
        {"id": "task-p1", "title": "没人认领的 P1", "status": "open", "priority": 1, "labels": ["project:harbor"], "created_at": at(4), "updated_at": at(4), "comments": []},
        {"id": "task-p2", "title": "没人认领的 P2", "status": "open", "priority": 2, "labels": ["project:harbor"], "created_at": at(1), "updated_at": at(1), "comments": []},
    ]


def timeline_ctx(board):
    ctx = ctx_of(board)
    kd_commits = [(NOW - 700 * 60 + i * 60, h, f"fix: 闪退 {i} (task-kd)") for i, h in enumerate(("a1b2c3d", "b2c3d4e", "c3d4e5f"))]
    ctx._logs["harbor"] = sorted(kd_commits + [(NOW - 20 * 86400, "d4e5f6a", "feat: 很早的提交")], key=lambda r: -r[0])
    return ctx


class Timeline(unittest.TestCase):
    def report(self, **kw):
        with patch.object(dispatch, "project_flags_load", return_value={}):
            return thread.timeline_report("harbor", timeline_ctx(timeline_board()), now=NOW, **kw)

    def rows(self, r):
        return [e for d in r["days"] for e in d["events"]]

    def test_checker_comment_is_its_own_kind_and_runs_fold(self):
        t = timeline_board()[0]
        kinds = [b["kind"] for b in thread.task_beats(t, timeline_ctx(timeline_board()))]
        self.assertIn("verify", kinds)
        self.assertNotIn("ask", kinds)
        r = self.report()
        v = [e for e in self.rows(r) if e["kind"] == "verify"]
        self.assertEqual(len(v), 1)
        self.assertEqual(v[0]["fold"]["count"], 2)
        self.assertEqual((v[0]["verify"]["ok"], v[0]["verify"]["ask"], v[0]["verify"]["fail"]), (2, 1, 1))
        self.assertEqual({i["task"] for i in v[0]["verify"]["items"]}, {"task-go", "task-t3"})
        self.assertEqual(v[0]["tasks"], 2)

    def test_tasks_closed_by_one_merge_are_one_row(self):
        rows = self.rows(self.report())
        g = [e for e in rows if e.get("group")]
        self.assertEqual(len(g), 1)
        self.assertEqual([x["task"] for x in g[0]["closes"]], ["task-c", "task-b", "task-a"])
        self.assertEqual(g[0]["commits"], ["6677e98"])
        self.assertFalse(any(e["kind"] == "done" and e["task"] in ("task-a", "task-b") for e in rows))

    def test_a_close_takes_in_the_24_hours_before_it(self):
        r = self.report()
        rows = self.rows(r)
        kd = next(e for e in rows if e.get("task") == "task-kd" and e["kind"] == "done")
        self.assertEqual((kd["before"]["steps"], kd["before"]["commits"]), (2, 3))
        self.assertTrue(kd["text"].startswith("正文换成系统 UITextView"))
        self.assertTrue(kd["unchecked"])
        self.assertFalse(any(e["kind"] == "commit" for e in rows))
        self.assertFalse(any(e["kind"] == "did" and e.get("task") == "task-kd" for e in rows))
        # the three steps of task-go in a row fold into one
        go = [e for e in rows if e.get("task") == "task-go" and e["kind"] == "did"]
        self.assertEqual(len(go), 1)
        self.assertEqual(go[0]["fold"]["count"], 3)
        self.assertEqual(go[0]["fold"]["summary"][0], "167s → 88s")
        self.assertEqual(r["folded"], {"steps": 5, "commits": 3})
        # newest first, day by day
        ts = [e["ts"] for e in rows]
        self.assertEqual(ts, sorted(ts, reverse=True))
        self.assertTrue(r["days"][0]["today"])

    def test_earlier_pages_and_the_open_column(self):
        r = self.report(days=7)
        self.assertTrue(r["next_before"])
        self.assertGreater(r["older"], 0)
        page = self.report(before=r["next_before"])
        got = self.rows(page)
        self.assertEqual([(e["kind"], e.get("task", "")) for e in got], [("void", "task-old"), ("commit", "")])
        self.assertEqual(got[0]["text"], "用户决定不做了。")
        # A quiet stretch is skipped: the next page starts at the newest older record.
        last = self.report(before=page["next_before"])
        self.assertIn("task-older", {e.get("task") for e in self.rows(last)})
        only = self.report(days=14, only="done")
        self.assertTrue(all(e["kind"] in ("done", "void", "decide", "verify") for e in self.rows(only)))
        op = r["open"]
        self.assertEqual([(a["n"], a["item"]) for a in op["asks"]], [(2, "b")])
        self.assertEqual([x["id"] for x in op["wait"]], ["task-need"])
        self.assertEqual([x["id"] for x in op["doing"]], ["task-go"])
        self.assertEqual([x["id"] for x in op["unassigned"]], ["task-p1", "task-p2", "task-t3"])
        self.assertEqual(op["doing"][0]["acceptance_done"], 1)

    def test_reply_words_keep_what_was_done_and_what_is_left_to_you(self):
        said, needs = thread.reply_words("用户想要申请账号。Agent 指导完成了账号申请和激活，代码已合并。用户需要手动配置操作按钮绑定。")
        self.assertEqual(said, "指导完成了账号申请和激活，代码已合并")
        self.assertEqual(needs, "手动配置操作按钮绑定")

    def test_untitled_commits_fold_only_when_nothing_sits_between(self):
        board = [{"id": "task-x", "title": "别的事", "status": "open", "labels": ["project:harbor"], "created_at": at(2), "updated_at": at(0, 30),
                  "comments": [c(at(0, 30), "claude-code", "中间做了一步")]}]
        ctx = ctx_of(board)
        ctx._logs["harbor"] = sorted([(NOW + 10 * 60, "aaaaaa1", "fix: 一"), (NOW + 20 * 60, "aaaaaa2", "fix: 二"),
                                      (NOW + 40 * 60, "aaaaaa3", "fix: 三"), (NOW + 50 * 60, "aaaaaa4", "fix: 四")], key=lambda r: -r[0])
        with patch.object(dispatch, "project_flags_load", return_value={}):
            r = thread.timeline_report("harbor", ctx, now=NOW + 3600)
        commits = [e for e in self.rows(r) if e["kind"] == "commit"]
        self.assertEqual([(e["fold"]["count"], e["text"]) for e in commits], [(2, "fix: 四"), (2, "fix: 二")])

    def test_all_reads_the_whole_history(self):
        r = self.report(days=0)
        self.assertTrue(r["all"])
        self.assertIsNone(r["next_before"])
        self.assertEqual(r["older"], 0)
        tasks = {e.get("task") for e in self.rows(r)}
        self.assertTrue({"task-old", "task-older"} <= tasks)
        self.assertEqual(r["count"], len(self.rows(r)))

    def test_pages_never_show_a_row_twice(self):
        board = timeline_board()
        # A close today names a commit five days back: it sits inside the close, not again on page 2.
        board[2]["close_reason"] = "workflow 收尾（合并提交 4d1e2c0，e0e0e0e）：正文换成系统 UITextView。"
        ctx = timeline_ctx(board)
        ctx._logs["harbor"] = sorted(ctx._logs["harbor"] + [(NOW - 5 * 86400, "e0e0e0e", "fix: 早先的提交")], key=lambda r: -r[0])

        def ids(r):
            out = []
            for e in self.rows(r):
                out.append(e["id"])
                out += [x["id"] for x in (e.get("before") or {}).get("events") or []]
                out += [x["id"] for x in (e.get("fold") or {}).get("events") or [] if x["id"] != e["id"]]
            return out
        with patch.object(dispatch, "project_flags_load", return_value={}):
            p1 = thread.timeline_report("harbor", ctx, now=NOW, days=3)
            kd = next(e for e in self.rows(p1) if e.get("task") == "task-kd")
            self.assertIn("e0e0e0e", [h for x in kd["before"]["events"] for h in x.get("commits") or []])
            pages, before = [p1], p1["next_before"]
            while before:
                pages.append(thread.timeline_report("harbor", ctx, now=NOW, before=before, with_open=False))
                before = pages[-1]["next_before"]
        seen = [i for p in pages for i in ids(p)]
        self.assertEqual(len(seen), len(set(seen)))
        self.assertNotIn("open", pages[1])
        # Whole days: a page starts at midnight.
        self.assertEqual(time.localtime(pages[1]["since"])[3:6], (0, 0, 0))

    def test_one_checker_row_covers_at_most_an_hour(self):
        board = [{"id": f"task-v{i}", "title": f"v{i}", "status": "open", "labels": ["project:harbor"], "created_at": at(2), "updated_at": at(0, i * 20),
                  "comments": [check(at(0, -300 + i * 20), ["1. ✓ 已验证 · 好。"])]} for i in range(12)]
        with patch.object(dispatch, "project_flags_load", return_value={}):
            r = thread.timeline_report("harbor", ctx_of(board), now=NOW)
        v = [e for e in self.rows(r) if e["kind"] == "verify"]
        self.assertGreater(len(v), 2)
        for e in v:
            f = e.get("fold")
            if f:
                self.assertLessEqual(f["to_ts"] - f["from_ts"], thread.VERIFY_SPAN)
                self.assertLessEqual(f["count"], thread.VERIFY_MAX)

    def test_probe_and_unfinished_sessions_are_not_what_was_done(self):
        ok = {"entrypoint": "cli", "title": "修登录", "user_msgs": 5}
        self.assertTrue(thread.reply_counts(ok, "", "Agent 修好了登录。"))
        self.assertFalse(thread.reply_counts({"entrypoint": "sdk-cli", "title": "", "user_msgs": 1}, "", "Agent 按要求回复了 pong。"))
        self.assertFalse(thread.reply_counts({"entrypoint": "cli", "title": "", "user_msgs": 2}, "", "Agent 列出了 /tmp。"))
        self.assertFalse(thread.reply_counts({"entrypoint": "cli", "title": "Ok", "user_msgs": 1}, "", "Agent 回复了 ok。"))
        self.assertFalse(thread.reply_counts(ok, "task-a", "Agent 的请求被用户中断以进行工具使用，任务未完成。"))
        self.assertTrue(thread.reply_counts({"entrypoint": "sdk-cli", "title": "", "user_msgs": 1}, "task-a", "Agent 写完了第 2 段。"))
        said, _ = thread.reply_words("Agent 的方案被采纳，改完了。")
        self.assertTrue(said.startswith("Agent 的方案"))

    def test_a_focused_task_counts_its_own_older_rows(self):
        r = self.report(days=3, task="task-old")
        self.assertEqual(r["count"], 0)
        self.assertEqual(r["older"], 1)
        page = self.report(before=r["next_before"], task="task-old", with_open=False)
        self.assertEqual([e.get("task") for e in self.rows(page)], ["task-old"])

    def test_cmd_thread_timeline_json(self):
        board = timeline_board()
        with patch.object(thread, "board_issues", return_value=board), patch.object(thread.Ctx, "live", return_value={}), \
             patch.object(thread.Ctx, "live_rows", return_value=[]), patch.object(thread.Ctx, "index", return_value={}), \
             patch.object(thread.Ctx, "commits", return_value={}), patch.object(thread.Ctx, "log", return_value=[]), \
             patch.object(dispatch, "settings_load", return_value={}), patch.object(dispatch, "project_flags_load", return_value={}):
            ns = dict(target="harbor", json=True, dir="", all=False, all_projects=False, lines=False, projects=False, task="", inside="",
                      timeline=True, days=14, before=None, only="", no_sessions=True)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                thread.cmd_thread(types.SimpleNamespace(**ns))
            got = json.loads(buf.getvalue())
            self.assertEqual((got["kind"], got["project"]), ("timeline", "harbor"))
            self.assertIn("open", got)
            ns["json"] = False
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                thread.cmd_thread(types.SimpleNamespace(**ns))
            self.assertIn("还没做", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
