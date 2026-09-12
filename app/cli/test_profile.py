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
import profile  # noqa: E402  (the same `dispatch` instance the module calls into, so patches land)


class ProfileDoc(unittest.TestCase):
    DOC = ("# 关于我（Agent 自动维护的档案）\n\n"
           "## 我是谁\n\n"
           "- 甲（2026-01-01 · claude-code）\n\n"
           "## 设备与服务现状（快照 · 2026-01-01 10:00 · claude-code 实测）\n\n"
           "- 旧的一台\n\n"
           "## 将来会发生的事\n\n"
           "- 2026-02-20 · 晚的事（2026-01-01 · claude-code）\n"
           "- 2026-02-10 · 早的事（2026-01-01 · claude-code）\n"
           "- 2026-12-01 · 太远的事（2026-01-01 · claude-code）\n"
           "- 待办 · 没有日期的事（2026-01-01 · claude-code）\n\n"
           "## 已发生\n\n"
           "- 2026-01-01 · 以前的事（claude-code）\n")

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "PROFILE.md")
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(self.DOC)
        self._orig = profile.PROFILE_FILE
        profile.PROFILE_FILE = self.path
        self.addCleanup(setattr, dispatch, "PROFILE_FILE", self._orig)
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def text(self):
        with open(self.path, encoding="utf-8") as f:
            return f.read()

    def run_op(self, op, args=(), actor="", task="", **kw):
        a = types.SimpleNamespace(op=op, args=list(args), actor=actor, task=task,
                                  refresh=kw.get("refresh", False), due=kw.get("due", False), json=True)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            profile.cmd_profile(a)
        return json.loads(buf.getvalue()) if buf.getvalue().strip() else {}

    def test_add_appends_to_who_i_am_with_today_and_actor(self):
        r = self.run_op("add", ["喜欢结论先行"], actor="claude-code", task="task-1")
        self.assertEqual(r["entry"], f"- 喜欢结论先行（{profile.profile_today()} · claude-code · task-1）")
        self.assertIn(r["entry"], profile.profile_entries(self.text(), "我是谁"))
        self.assertIn("- 甲（2026-01-01 · claude-code）", self.text())

    def test_add_actor_falls_back_to_env(self):
        with patch.dict(os.environ, {"DISPATCH_ACTOR": "zcode"}):
            r = self.run_op("add", ["一条"])
        self.assertTrue(r["entry"].endswith("· zcode）"))

    def test_add_empty_fact_exits_2(self):
        with self.assertRaises(SystemExit) as e:
            self.run_op("add", [])
        self.assertEqual(e.exception.code, 2)

    def test_upcoming_inserts_and_sorts_dated_before_undated(self):
        self.run_op("upcoming", ["2026-02-15", "中间的事"], actor="pi", task="task-9")
        entries = profile.profile_entries(self.text(), "将来会发生的事")
        self.assertEqual([profile.profile_entry_parts(e)[0] for e in entries],
                         ["2026-02-10", "2026-02-15", "2026-02-20", "2026-12-01", "待办"])
        self.assertIn(f"- 2026-02-15 · 中间的事（{profile.profile_today()} · pi · task-9）", entries)

    def test_upcoming_missing_args_exits_2(self):
        with self.assertRaises(SystemExit) as e:
            self.run_op("upcoming", ["2026-02-15"])
        self.assertEqual(e.exception.code, 2)

    def test_done_moves_exactly_one_entry(self):
        self.run_op("done", ["早的事"])
        t = self.text()
        self.assertNotIn("早的事", profile.profile_entries(t, "将来会发生的事"))
        moved = profile.profile_entries(t, "已发生")
        self.assertIn(f"- {profile.profile_today()} · 2026-02-10 · 早的事（2026-01-01 · claude-code）", moved)
        self.assertIn("- 甲（2026-01-01 · claude-code）", t)
        self.assertIn("- 旧的一台", t)

    def test_done_missing_keyword_exits_nonzero(self):
        with self.assertRaises(SystemExit) as e:
            self.run_op("done", ["没有这条"])
        self.assertEqual(e.exception.code, 1)

    def test_done_ambiguous_keyword_exits_2(self):
        with self.assertRaises(SystemExit) as e:
            self.run_op("done", ["的事"])
        self.assertEqual(e.exception.code, 2)

    def test_replace_section_swaps_only_inventory(self):
        new = "## 设备与服务现状（快照 · 2026-02-02 09:00 · pi 实测）\n\n- 新的一台\n"
        t = profile.profile_replace_section(self.DOC, "设备与服务现状", new)
        self.assertIn("- 新的一台", t)
        self.assertNotIn("- 旧的一台", t)
        self.assertIn("- 甲（2026-01-01 · claude-code）", t)
        self.assertIn("- 2026-02-10 · 早的事", t)
        self.assertIn("- 2026-01-01 · 以前的事", t)
        self.assertEqual([h.split("（")[0] for h, _ in profile.profile_sections(t)],
                         ["我是谁", "设备与服务现状", "将来会发生的事", "已发生"])

    def test_replace_missing_section_lands_after_who_i_am(self):
        doc = "# x\n\n## 我是谁\n\n- 甲\n\n## 已发生\n\n- 乙\n"
        t = profile.profile_replace_section(doc, "设备与服务现状", "## 设备与服务现状（快照 · 2026-02-02 09:00 · pi 实测）\n\n- 新\n")
        self.assertEqual([h for h, _ in profile.profile_sections(t)],
                         ["我是谁", "设备与服务现状（快照 · 2026-02-02 09:00 · pi 实测）", "已发生"])

    def test_upcoming_due_windows_and_skips_undated(self):
        rows = profile.profile_upcoming_due(self.DOC, days=14, now=datetime.date(2026, 2, 12))
        self.assertEqual([r["when"] for r in rows], ["2026-02-10", "2026-02-20"])
        by = {r["when"]: r for r in rows}
        self.assertTrue(by["2026-02-10"]["overdue"])
        self.assertEqual(by["2026-02-10"]["days_left"], -2)
        self.assertEqual(by["2026-02-20"]["days_left"], 8)
        self.assertEqual(by["2026-02-20"]["text"], "晚的事")

    def test_month_deadline_is_the_last_day(self):
        doc = "## 将来会发生的事\n\n- 2026-02 · 整月的事（2026-01-01 · x）\n"
        rows = profile.profile_upcoming_due(doc, days=20, now=datetime.date(2026, 2, 12))
        self.assertEqual(rows[0]["date"], datetime.date(2026, 2, 28))
        self.assertEqual(rows[0]["days_left"], 16)
        self.assertFalse(rows[0]["overdue"])

    def test_ssh_aliases_intersect_named_aliases_with_config_hosts(self):
        facts = "`~/.ssh/config` 别名 `hetzner`（root@1.2.3.4）；`ssh nas` 走 ProxyJump；`ssh apple@5.6.7.8` 本机。"
        with patch.object(profile, "profile_ssh_config_hosts", return_value=["hetzner", "nas", "mini"]):
            self.assertEqual(profile.profile_ssh_aliases(facts), ["hetzner", "nas"])

    def test_ssh_config_reading_skips_wildcards(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "config")
            with open(p, "w") as f:
                f.write("Host a b\n  HostName x\nHost zitigate-* headnode-*\nHost c\n")
            with patch.object(profile, "PROFILE_SSH_CONFIG", p):
                self.assertEqual(profile.profile_ssh_config_hosts(), ["a", "b", "c"])

    def test_inventory_requires_refresh_or_due(self):
        with self.assertRaises(SystemExit) as e:
            self.run_op("inventory")
        self.assertEqual(e.exception.code, 2)

    def test_show_json_shape_and_inventory_at(self):
        r = self.run_op("show")
        self.assertEqual(set(r), {"path", "exists", "content", "sections", "inventory_at"})
        self.assertEqual(r["inventory_at"], "2026-01-01 10:00")
        self.assertEqual([s["key"] for s in r["sections"]], ["我是谁", "设备与服务现状", "将来会发生的事", "已发生"])


if __name__ == "__main__":
    unittest.main()
