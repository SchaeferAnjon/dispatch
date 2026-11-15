# -*- coding: utf-8 -*-
"""The session brief (`dispatch prime`, prime_brief.py): it carries only what is going on now, in the order that
matters, and it stays inside what Claude Code (10,000 characters) and Codex (about 2,500 tokens, bytes / 4) deliver
whole. A brief the size of the kanban project's real board must fit: if it does not, these tests fail."""
import contextlib
import datetime
import glob
import io
import json
import os
import random
import shutil
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import dispatch  # noqa: E402
import prime_brief as B  # noqa: E402
import prefs  # noqa: E402
import tasks_view  # noqa: E402


def task(i, status, project="kanban", assignee="", extra=()):
    return {"id": f"task-{i:04x}", "title": f"第 {i} 条任务：把某个界面的某一块按用户选的方向重做，并且带上前后对比截图和验证记录，不留下次再补",
            "status": status, "priority": 2, "assignee": assignee, "labels": [f"project:{project}", *extra]}


def kanban_sized_tasks():
    """What the kanban board looks like: 70 open ones, 11 in progress, 3 waiting for the person."""
    tasks = [task(i, "in_progress", assignee="claude-code" if i % 2 else "codex") for i in range(11)]
    tasks += [task(20 + i, "open", extra=["dispatch:needs-you"]) for i in range(3)]
    tasks += [task(40 + i, "open") for i in range(56)]
    tasks += [task(200 + i, "closed") for i in range(300)]
    tasks += [task(500 + i, "in_progress", project="harbor") for i in range(6)]  # another project's
    return tasks


def wiki_items(n=585):
    words = "把界面里的选择器改成用户点名的那一种颜色再去看真机截图对比前后差别不要只看代码就下结论"
    items = []
    for i in range(n):
        kind = "pit" if i % 2 == 0 else ("win" if i % 4 == 1 else "retro")
        items.append({"kind": kind, "key": f"{kind}-item-{i}", "project": "kanban" if i % 3 == 0 else "", "text": f"第 {i} 条：{words * 6}",
                      "fields": {"【解法】": words * 3}})
    return items


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.home = os.path.join(self.tmp, "home")
        self.proj = os.path.join(self.tmp, "kanban")
        os.makedirs(self.proj)
        os.makedirs(os.path.join(self.home, "rules"))
        self.profile = os.path.join(self.tmp, "PROFILE.md")
        self.pm = dispatch._mod("profile")
        self._orig = (self.pm.PROFILE_FILE,)
        self.pm.PROFILE_FILE = self.profile
        prefs.D = dispatch
        self._prefs = prefs.pref_dir if hasattr(prefs, "pref_dir") else None

    def tearDown(self):
        (self.pm.PROFILE_FILE,) = self._orig
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_prime(self, tasks=(), wiki=(), neighbours=(), edits=None, pref_lines=None, hook=None, opencode=False, tracked=(), env=None):
        out = io.StringIO()
        a = types.SimpleNamespace(cwd=self.proj, hook_json=hook is not None, opencode=opencode)
        stdin = io.StringIO(json.dumps(hook or {}))
        stdin.isatty = lambda: False
        sh = lambda args, timeout=20, env=None: (0, json.dumps(list(tasks)), "") if args[:2] == ["bd", "list"] else (0, "{}", "")
        pm = dispatch._mod("prefs")
        with contextlib.ExitStack() as st:
            st.enter_context(contextlib.redirect_stdout(out))
            st.enter_context(patch("sys.stdin", stdin))
            # git knows the person (the brief has a line when it does not, task-pog4t)
            known = {"GIT_CONFIG_COUNT": "2", "GIT_CONFIG_KEY_0": "user.name", "GIT_CONFIG_VALUE_0": "Ada",
                     "GIT_CONFIG_KEY_1": "user.email", "GIT_CONFIG_VALUE_1": "ada@lovelace.dev"}
            st.enter_context(patch.dict(os.environ, {"CODEX_THREAD_ID": "", "BEADS_ACTOR": "claude-code", "DISPATCH_ACTOR": "", **known, **(env or {})}))
            st.enter_context(patch.object(dispatch, "sh", sh))
            st.enter_context(patch.object(dispatch, "DISPATCH_DIR", self.home))
            st.enter_context(patch.object(dispatch, "HOME", self.tmp))
            keys = os.path.join(self.tmp, ".config", "dispatch")  # the key store and its record of names: the test's own
            st.enter_context(patch.multiple(dispatch, ENV_DIR=keys, ENV_FILE=os.path.join(keys, "env"), ENV_FISH=os.path.join(keys, "env.fish"),
                                            ENV_SH=os.path.join(keys, "env.sh"), ENV_KNOWN=os.path.join(self.tmp, ".dispatch", "state", "env-names.json")))
            st.enter_context(patch.object(dispatch, "neighbours", lambda *a, **k: list(neighbours)))
            st.enter_context(patch.object(dispatch, "session_edit_map", lambda *a, **k: edits or {}))
            st.enter_context(patch.object(dispatch, "starred_sessions", lambda *a, **k: list(tracked)))
            st.enter_context(patch.object(dispatch, "load_index", lambda: {}))
            st.enter_context(patch.object(dispatch, "wiki_all", lambda: list(wiki)))
            st.enter_context(patch.object(dispatch, "wiki_dates", lambda keys: {it["key"]: it.get("created", "") for it in wiki}))
            st.enter_context(patch.object(dispatch, "bd_comments", lambda tid: []))
            st.enter_context(patch.object(dispatch, "project_of_cwd", lambda cwd, names, roots=None: "kanban"))
            st.enter_context(patch.object(pm, "prime_section", lambda *a, **k: list(pref_lines or [])))
            dispatch.cmd_prime(a)
        return out.getvalue()


class Order(Base):
    def test_clear_handoff_and_prime_wire_fit_both_engine_limits(self):
        import handoff
        body = '恢复证据\\"\n' * 4000 + 'HANDOFF-END'
        with patch.object(handoff, 'prime_section', return_value=['## 最新交接', body]):
            wire = self.run_prime(kanban_sized_tasks(), hook={'session_id': 's', 'source': 'clear', 'cwd': self.proj})
        self.assertLess(len(wire), B.CLAUDE_CHARS)
        self.assertLess(len(wire.encode('utf-8')), B.CODEX_BYTES)
        text = json.loads(wire)['hookSpecificOutput']['additionalContext']
        self.assertIn('全文在', text.splitlines()[0])
        self.assertIn('请先完整读取', text.splitlines()[0])
        spills = glob.glob(os.path.join(self.home, 'prime', '*.md'))
        self.assertTrue(any('HANDOFF-END' in open(p, encoding='utf-8').read() for p in spills))

    def test_unread_worker_notifications_come_right_after_the_handoff_and_a_dispatcher_reading_them_marks_them(self):
        import wake
        import workers
        d = types.SimpleNamespace(DISPATCH_DIR=self.home)
        row = {"name": "gx-wake", "run_id": "r1", "task": "task-arse", "task_title": "wake", "report": "/r/report.md", "log": "/r/log"}
        wake.add(d, row, "reported")
        listed = json.loads(self.run_prime([], hook={"session_id": "someone", "cwd": self.proj}))["hookSpecificOutput"]["additionalContext"]
        # Nobody registered: an ordinary session is not shown dispatch internals; the next claim reads them.
        self.assertNotIn("Worker 通知", listed)
        self.assertNotIn("调度与 workers", listed)
        self.assertEqual(len(wake.unread(d)), 1)
        me = {"session": "disp", "engine": "claude-code", "host": workers.host(), "pid": os.getpid(),
              "birth": workers.process(os.getpid())["birth"], "presence": "", "cwd": "/", "started_at": "", "claimed_at": 1}
        wake.save_dispatcher(d, me)
        text = json.loads(self.run_prime([], hook={"session_id": "disp", "cwd": self.proj, "source": "compact"}))["hookSpecificOutput"]["additionalContext"]
        self.assertTrue(text.splitlines()[1].startswith("## Worker 通知"), text)  # first part after the identity line
        self.assertEqual(wake.unread(d), [])
        wake.add(d, dict(row, run_id="r2"), "reported")
        other = json.loads(self.run_prime([], hook={"session_id": "someone", "cwd": self.proj}))["hookSpecificOutput"]["additionalContext"]
        self.assertNotIn("Worker 通知", other)
        worker = json.loads(self.run_prime([], hook={"session_id": "disp", "cwd": self.proj}, env={"DISPATCH_WORKER": "gx-wake"}))["hookSpecificOutput"]["additionalContext"]
        self.assertNotIn("Worker 通知", worker)
        self.assertEqual(len(wake.unread(d)), 1)

    def test_a_dispatcher_s_notifications_are_marked_read_only_after_the_brief_went_out(self):
        """The session-start hook stops a slow brief (hook.py START_BUDGET): one stopped before it printed must not
        have used up the notifications it would have shown."""
        import wake
        import workers
        d = types.SimpleNamespace(DISPATCH_DIR=self.home)
        wake.add(d, {"name": "gx-late", "run_id": "r1", "task": "task-arse", "task_title": "late", "report": "/r/report.md", "log": "/r/log"}, "reported")
        me = {"session": "disp", "engine": "claude-code", "host": workers.host(), "pid": os.getpid(),
              "birth": workers.process(os.getpid())["birth"], "presence": "", "cwd": "/", "started_at": "", "claimed_at": 1}
        wake.save_dispatcher(d, me)
        printed = []
        real_mark = wake.mark_read

        def mark(dd, ids, by, via=""):
            printed.append(sys.stdout.getvalue())
            return real_mark(dd, ids, by, via)
        with patch.object(wake, "mark_read", mark):
            text = json.loads(self.run_prime([], hook={"session_id": "disp", "cwd": self.proj, "source": "resume"}))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("## Worker 通知", text)
        self.assertEqual(len(printed), 1)
        self.assertIn("Worker 通知", printed[0], "marked read before the brief was printed")
        self.assertEqual(wake.unread(d), [])
        wake.add(d, {"name": "gx-later", "run_id": "r2", "task": "task-arse", "task_title": "later", "report": "/r/report.md", "log": "/r/log"}, "reported")
        with patch.object(B, "build", side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
            self.run_prime([], hook={"session_id": "disp", "cwd": self.proj, "source": "resume"})
        self.assertEqual(len(wake.unread(d)), 1, "a brief stopped before it printed keeps them unread")

    def test_the_parts_come_in_the_order_that_matters_and_end_with_the_pointer(self):
        nb = [{"agent": "codex", "session_id": "01a0ea21-aaaa", "state": "working", "last_at": 0, "cwd": self.proj, "host": "local"}]
        tomorrow = (datetime.date.today() + datetime.timedelta(days=1)).isoformat()
        with open(self.profile, "w", encoding="utf-8") as f:
            f.write(f"# 关于我\n\n## 将来会发生的事\n- {tomorrow} · 外管局预约 · 带护照（Claude Code）\n")
        tasks = [task(1, "in_progress", assignee="claude-code"), task(2, "open", extra=["dispatch:needs-you"]), task(3, "open")]
        wiki = [{"kind": "pit", "key": "pit-x", "project": "kanban", "text": "【坑】某个坑", "fields": {}}]
        text = self.run_prime(tasks, wiki, nb, pref_lines=["## 偏好（用户的；kanban + 全局，1 条；照做）", "设计", "- 方角开关：开关用方角。"])
        heads = [l for l in text.splitlines() if l.startswith("## ")]
        self.assertEqual([h.split("（")[0] for h in heads], ["## 板上", "## 同目录在跑", "## 快到期", "## 偏好", "## 最近的坑"])
        self.assertEqual(text.splitlines()[0], "# Dispatch · 当前项目 kanban · 你是 claude-code")
        self.assertIn("◐ 「第 1 条任务", text)
        self.assertIn("◇ 等你 「第 2 条任务", text)  # a task waiting for the person is shown
        self.assertIn("另有 1 条待办", text)
        self.assertIn("外管局预约", text)
        self.assertIn("codex 01a0ea21 · 在跑", text)
        self.assertTrue(text.splitlines()[-1].startswith("查阅"))
        for cmd in ("dispatch env list", "dispatch catalog", "dispatch facts get"):
            self.assertIn(cmd, text.splitlines()[-1])
        self.assertNotIn("dispatch begin", text)  # the rules are in the rules files

    def test_only_this_projects_tasks_and_only_pits(self):
        wiki = [{"kind": "win", "key": "win-a", "project": "kanban", "text": "【做对】做对了", "fields": {}},
                {"kind": "pit", "key": "pit-a", "project": "harbor", "text": "【坑】别的项目的坑", "fields": {}},
                {"kind": "pit", "key": "pit-b", "project": "", "text": "【坑】通用的坑", "fields": {}}]
        text = self.run_prime([task(1, "in_progress"), task(2, "in_progress", project="harbor")], wiki)
        self.assertIn("第 1 条任务", text)
        self.assertNotIn("第 2 条任务", text)
        self.assertIn("通用的坑", text)
        self.assertNotIn("做对了", text)
        self.assertNotIn("别的项目的坑", text)

    def test_an_empty_board_and_no_neighbours_is_a_short_brief(self):
        text = self.run_prime([], [], pref_lines=[])
        self.assertEqual(len(text.splitlines()), 2)
        self.assertLess(len(text.encode("utf-8")), 600)

    def test_a_mac_where_git_has_no_name_tells_the_agent_to_ask_not_invent(self):
        # task-pog4t: OpenCode set `opencode <opencode@localhost>` itself and committed
        nobody = {"GIT_CONFIG_COUNT": "0", "GIT_CONFIG_GLOBAL": os.path.join(self.tmp, "nogitconfig"), "GIT_CONFIG_NOSYSTEM": "1"}
        text = self.run_prime([], [], pref_lines=[], env=dict(nobody, DISPATCH_LANG="en"))
        line = next(l for l in text.splitlines() if "no name and email for commits" in l)
        self.assertIn("ask the person", line)
        self.assertIn("Never make one up", line)
        # a Chinese-speaking person's agent reads it in Chinese (task-7lptn)
        zh = self.run_prime([], [], pref_lines=[], env=dict(nobody, DISPATCH_LANG="zh"))
        self.assertIn("绝不自己编", next(l for l in zh.splitlines() if "提交用的名字和邮箱" in l))
        self.assertNotIn("no name and email for commits", self.run_prime([], [], pref_lines=[]))

    def test_a_key_store_that_lost_keys_is_said_before_the_board(self):
        # 10-08: ~/.config/dispatch was gone for a week and the next `env set` made a new store of 1 key
        keys = os.path.join(self.tmp, ".config", "dispatch")
        with patch.multiple(dispatch, ENV_DIR=keys, ENV_FILE=os.path.join(keys, "env"), ENV_FISH=os.path.join(keys, "env.fish"),
                            ENV_SH=os.path.join(keys, "env.sh"), ENV_KNOWN=os.path.join(self.tmp, ".dispatch", "state", "env-names.json")):
            dispatch.env_write([{"name": "ZHIPU_API_KEY", "value": "k-1", "note": ""}])
        self.assertNotIn("密钥库", self.run_prime([], [], pref_lines=[]))
        shutil.rmtree(keys)
        lines = self.run_prime([task(1, "in_progress")], [], pref_lines=[]).splitlines()
        warn = next(i for i, l in enumerate(lines) if "密钥库" in l)
        self.assertIn("ZHIPU_API_KEY", lines[warn])
        self.assertNotIn("k-1", "\n".join(lines))
        self.assertLess(warn, next(i for i, l in enumerate(lines) if "第 1 条任务" in l))

    def test_recent_pits_use_dates_not_the_alphabetical_memory_keys(self):
        wiki = [{"kind": "pit", "key": f"pit-{chr(122 - i)}", "project": "kanban" if i % 2 else "",
                 "text": f"第{i}条坑", "fields": {}, "created": f"2026-09-{i + 1:02d}T12:00:00Z"} for i in range(8)]
        # bd memories is a JSON object with sorted keys, not insertion order.
        text = self.run_prime(wiki=sorted(wiki, key=lambda it: it["key"]))
        lines = [line for line in text.splitlines() if line.startswith("[坑]")]
        self.assertEqual(len(lines), 5)
        for line, i in zip(lines, range(7, 2, -1)):
            self.assertIn(f"第{i}条坑", line)


class Overdue(Base):
    def test_capped_overdue_items_are_only_marked_when_delivered(self):
        with open(self.profile, "w", encoding="utf-8") as f:
            f.write("## 将来会发生的事\n" + "".join(
                f"- 2020-01-{i + 1:02d} · 过期事项{i}，很长的提醒内容需要逐条让用户看到\n" for i in range(15)))
        first = json.loads(self.run_prime(hook={"session_id": "first"}))["hookSpecificOutput"]["additionalContext"]
        with open(os.path.join(self.home, "profile-overdue.json"), encoding="utf-8") as f:
            receipts = json.load(f)
        delivered = [line for line in first.splitlines() if "已过期" in line]
        self.assertGreater(len(delivered), 0)
        self.assertLess(len(delivered), 15)
        self.assertEqual(len(receipts), len(delivered))
        second = json.loads(self.run_prime(hook={"session_id": "second"}))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("已过期", second)
        for line in delivered:
            self.assertNotIn(line, second)

    def test_a_section_removed_by_the_total_budget_does_not_consume_reminders(self):
        with open(self.profile, "w", encoding="utf-8") as f:
            f.write("## 将来会发生的事\n- 2020-01-02 · 留给下一次的提醒\n")
        build = B.build
        with patch.object(B, "build", lambda *a, **kw: build(*a, **kw, budget=650)):
            text = json.loads(self.run_prime(tasks=[task(1, "in_progress")], hook={"session_id": "tiny"}))["hookSpecificOutput"]["additionalContext"]
        self.assertNotIn("留给下一次的提醒", text)
        again = json.loads(self.run_prime(hook={"session_id": "normal"}))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("留给下一次的提醒", again)

    def test_an_overdue_item_is_told_once_to_a_session_and_not_used_up_by_reading_it(self):
        with open(self.profile, "w", encoding="utf-8") as f:
            f.write("# 关于我\n\n## 将来会发生的事\n- 2020-01-02 · 交电费\n")
        by_hand = self.run_prime()
        self.assertIn("交电费", by_hand)
        self.assertIn("交电费", self.run_prime())          # reading it in a terminal does not use it up
        started = self.run_prime(hook={"session_id": "s", "cwd": self.proj})
        self.assertIn("交电费", json.loads(started)["hookSpecificOutput"]["additionalContext"])
        again = self.run_prime(hook={"session_id": "s2", "cwd": self.proj})
        self.assertNotIn("交电费", json.loads(again)["hookSpecificOutput"]["additionalContext"])


class Budget(Base):
    """A brief as big as the real one must fit in both engines' limits."""

    def test_task_notes_and_headers_stay_inside_the_section_budget(self):
        rows = [task(i, "in_progress", assignee="codex") for i in range(8)]
        lines = B.board(rows, "kanban", tasks_view.status_of, "codex", lambda t: "用户留言" * 100)
        self.assertLessEqual(B.nbytes(lines), B.BOARD_BYTES)
        self.assertIn("用户留言", "\n".join(lines))
        self.assertIn("还有", "\n".join(lines))

    def test_peer_conflicts_and_headers_stay_inside_the_section_budget(self):
        lines = B.peers(["codex 正在运行" * 20] * 8, "改了这些文件" * 100)
        self.assertLessEqual(B.nbytes(lines), B.PEERS_BYTES)
        tracked = B.peers([], tracked=["跟进的会话" * 50] * 5)
        self.assertLessEqual(B.nbytes(tracked), B.TRACKED_BYTES)

    def test_due_overflow_counts_reminders_instead_of_headings(self):
        rows = ["## 快到期（3 天内）", "- " + "很长的到期事项" * 50, "这几条过期了，做完了吗：", "- 已过期事项"]
        lines = B.due(rows)
        self.assertLessEqual(B.nbytes(lines), B.DUE_BYTES)
        self.assertIn("还有 2 条", lines[-1])

    def test_two_spills_for_the_same_agent_keep_distinct_snapshots(self):
        first = dispatch.prime_file("codex", "kanban")
        second = dispatch.prime_file("codex", "kanban")
        self.assertNotEqual(first, second)

    def full_prefs(self):
        topics = "列表 输入框 弹层 侧栏 标题栏 按钮 图标 表格 卡片 菜单 页签 提示 进度条 空状态 搜索框 头像 徽标 分组头 时间线 看板".split()
        # Distinct bodies matter: near-identical prose is deduplicated before budgeting,
        # which used to turn this 73-item fixture into just five effective preferences.
        words = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔龙师火帝鸟官人皇"
        entries = [{"id": f"pref-{i}", "text": f"{topics[i % 20]}：" + "".join(random.Random(i).sample(list(words), 70)),
                    "polarity": "like" if i % 3 else "avoid", "area": prefs.AREAS[i % len(prefs.AREAS)], "scope": "kanban" if i % 2 else "everywhere",
                    "name": f"偏好{i}", "status": "active", "created": f"2026-09-{(i % 28) + 1:02d}T10:00:00+02:00"} for i in range(73)]
        lines = prefs.prime_section("kanban", entries=entries, limit=B.PREF_ITEMS, max_chars=B.PREF_CHARS, max_bytes=B.PREFS_BYTES)
        self.assertLessEqual(B.nbytes(lines), B.PREFS_BYTES)
        count = len([line for line in lines if line.startswith("- ")])
        self.assertIn(f"全局，{count} 条", lines[0])
        self.assertIn(f"还有 {len(entries) - count} 条", lines[0])
        return lines

    def fixture_run(self):
        nb = [{"agent": "claude-code" if i % 2 else "codex", "session_id": f"{i:08x}-aaaa", "state": "working" if i % 2 else "idle",
               "last_at": 0, "cwd": "/Users/dev/Projects/kanban-wt/" + "x" * 30, "host": "local"} for i in range(8)]
        edits = {n["session_id"]: {"files": {f"/Users/dev/Projects/kanban/app/cli/module_{j}.py": 1 for j in range(6)}} for n in nb}
        tracked = [{"agent": "claude-code", "title": "一个很长的会话标题" * 6, "session_id": f"{i:08x}-bbbb", "last_at": 0} for i in range(6)]
        today = datetime.date.today()
        lines = [f"- {(today + datetime.timedelta(days=i % 3)).isoformat()} · 第 {i} 件马上要做的事，写得比较长，带上地点和要带的东西 · 别忘了（Claude Code）" for i in range(12)]
        lines += [f"- 2020-01-{i + 1:02d} · 早就过期的第 {i} 件事，写得也不短，问过一次以后就不再问（Claude Code）" for i in range(8)]
        with open(self.profile, "w", encoding="utf-8") as f:
            f.write("# 关于我\n\n## 将来会发生的事\n" + "\n".join(lines) + "\n")
        tasks = kanban_sized_tasks()
        self.assertEqual(len([t for t in tasks if t["status"] == "in_progress" and "project:kanban" in t["labels"]]), 11)
        text = self.run_prime(tasks, wiki_items(), nb, edits, self.full_prefs(), hook={"session_id": "s", "cwd": self.proj}, tracked=tracked)
        return json.loads(text)["hookSpecificOutput"]["additionalContext"]

    def test_a_kanban_sized_brief_fits_claude_codes_10000_characters(self):
        text = self.fixture_run()
        chars, nbytes = B.size(text)
        self.assertLessEqual(chars, B.CLAUDE_CHARS, "Claude Code would save the brief to a file and show 2,000 characters")
        self.assertLessEqual(chars, B.BUDGET_BYTES)

    def test_a_kanban_sized_brief_fits_codexs_default_2500_tokens(self):
        text = self.fixture_run()
        chars, nbytes = B.size(text)
        # Codex counts about 4 bytes a token: 2,500 tokens are 10,000 bytes
        self.assertLessEqual(nbytes, B.CODEX_BYTES, "Codex would keep a head and a tail and drop the middle")
        self.assertLessEqual(nbytes, B.BUDGET_BYTES)

    def test_the_caps_of_all_the_parts_together_are_inside_the_budget(self):
        """So the cut of whole parts, which loses information, is only the last resort."""
        worst = (B.BOARD_BYTES + 80 + B.PEERS_BYTES + 200 + B.TRACKED_BYTES + 60 + B.DUE_BYTES + B.PREFS_BYTES + B.PITS_BYTES + 60
                 + B.nbytes([B.pointer()]) + 200)
        self.assertLessEqual(worst, B.BUDGET_BYTES)

    def test_every_part_is_there_and_says_what_is_left_out(self):
        text = self.fixture_run()
        for head in ("## 板上（kanban", "## 同目录在跑（8）", "## 追踪中的会话（6）", "## 快到期", "## 偏好", "## 最近的坑"):
            self.assertIn(head, text)
        self.assertRegex(text, r"还有 \d+ 条进行中或等你的，另有 56 条待办：`dispatch task list`")
        self.assertIn("…还有 4 个，`dispatch sessions`", text)
        self.assertIn("`dispatch prefs list`", text)
        self.assertIn("…还有", text.split("## 最近的坑")[1])
        self.assertFalse(os.path.exists(os.path.join(self.home, "prime")), "nothing was cut, so no file")

    def test_over_budget_the_end_goes_first_and_the_full_text_is_kept_in_a_file(self):
        sections = [("板上", ["## 板上", "◐ " + "任务" * 400]), ("偏好", ["## 偏好", "- " + "偏好" * 1500]), ("坑", ["## 最近的坑", "[坑] " + "坑" * 1500])]
        saved = {}

        def save(full):
            saved["text"] = full
            return "~/tasks/.dispatch/prime/x.md"

        text, cut = B.build("# Dispatch · 当前项目 kanban", sections, save=save)
        self.assertEqual(cut, ["坑", "偏好"][:len(cut)])
        self.assertIn("坑", cut)
        self.assertLessEqual(len(text.encode("utf-8")), B.BUDGET_BYTES)
        self.assertEqual(text.splitlines()[1], "# Dispatch · 当前项目 kanban")
        self.assertIn("全文在 ~/tasks/.dispatch/prime/x.md", text.splitlines()[0])
        self.assertIn("## 板上", text)           # what matters most stayed
        self.assertTrue(text.splitlines()[-1].startswith("查阅"))  # and the way to the rest
        self.assertIn("偏好" * 1500, saved["text"])  # the file has everything
        self.assertIn("坑" * 1500, saved["text"])

    def test_the_cap_keeps_whole_lines_and_counts_the_rest(self):
        lines = [f"line {i} " + "x" * 40 for i in range(30)]
        kept = B.cap(lines, 400, lambda n: f"…还有 {n} 条，`cmd`")
        self.assertLessEqual(B.nbytes(kept), 400)
        self.assertTrue(kept[-1].startswith("…还有 ") and kept[-1].endswith("条，`cmd`"))
        n = int(kept[-1].split(" ")[1])
        self.assertEqual(len(kept) - 1 + n, 30)
        self.assertEqual(B.cap(lines[:2], 400, lambda n: "more"), lines[:2])
        self.assertEqual(B.cap(lines[:2], 400, lambda n: f"还有 {n}", extra=5)[-1], "还有 5")

    def test_the_spill_notice_and_long_path_are_inside_the_budget(self):
        saved = []
        path = "/" + "目录" * 180 + "/brief.md"
        text, cut = B.build("# Dispatch", [("板上", ["x" * 8350]), ("坑", ["y" * 400])],
                            save=lambda full: saved.append(full) or path)
        self.assertLessEqual(B.nbytes(text.splitlines()), B.BUDGET_BYTES)
        self.assertIn(path, text.splitlines()[0])
        self.assertEqual(len(saved), 1)
        self.assertIn("y" * 400, saved[0])

    def test_snapshot_write_failure_still_returns_a_bounded_brief(self):
        def unavailable(full):
            raise OSError("read-only filesystem")
        text, cut = B.build("# Dispatch", [("板上", ["x" * 5000]), ("坑", ["y" * 5000])], save=unavailable)
        self.assertLessEqual(B.nbytes(text.splitlines()), B.BUDGET_BYTES)
        self.assertIn("未能保存", text)
        self.assertIn("dispatch task list", text)


if __name__ == "__main__":
    unittest.main()
