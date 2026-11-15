# -*- coding: utf-8 -*-
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
import dplatform as P  # noqa: E402

WINDOWS_READY = True


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
        self.addCleanup(setattr, profile, "PROFILE_FILE", self._orig)
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # no other Macs in these tests
        self._orig_hosts_file = dispatch.HOSTS_FILE
        dispatch.HOSTS_FILE = os.path.join(self.tmp, "no-hosts.json")
        self.addCleanup(setattr, dispatch, "HOSTS_FILE", self._orig_hosts_file)

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

    def test_pipe_dates_include_two_and_three_fields_and_months(self):
        entries = ["2026-02-12 · 今天", "2026-02-13|待办 · 两段",
                   "2026-02-14|预约|延签 · 三段", "2026-02|事项|标签 · 月底",
                   "下次回国|待办 · 无日期", "2026-02-30|待办 · 错误日期"]
        doc = "## 将来会发生的事\n" + "\n".join("- " + x + "（2026-01-01 · codex）" for x in entries)
        rows = profile.profile_upcoming_due(doc, days=16, now=datetime.date(2026, 2, 12))
        self.assertEqual([(r["when"], r["text"], r["days_left"]) for r in rows],
                         [("2026-02-12", "今天", 0), ("2026-02-13", "两段", 1),
                          ("2026-02-14", "三段", 2), ("2026-02", "月底", 16)])

    def test_pipe_dates_sort_and_done_preserves_original_fields(self):
        self.run_op("upcoming", ["2026-02-11|预约|延签", "递交材料"], actor="codex")
        entries = profile.profile_entries(self.text(), "将来会发生的事")
        self.assertEqual(profile.profile_entry_parts(entries[1])[:2], ("2026-02-11", "递交材料"))
        self.run_op("done", ["预约|延签"])
        text = self.text()
        past = "## Past events" if "## Past events" in text else "## 已发生"  # new files write English headings
        self.assertIn("2026-02-11|预约|延签 · 递交材料", text.split(past)[1])

    def test_prime_overdue_once_upcoming_repeated_and_new_deadline_reminded(self):
        with patch.object(dispatch, "DISPATCH_DIR", self.tmp):
            first = "\n".join(profile.profile_prime_lines(self.DOC, now=datetime.date(2026, 2, 12)))
            self.assertIn("这几条过期了，做完了吗", first)
            self.assertIn("早的事（已过期 2 天）", first)
            self.assertIn("晚的事（8 天后）", first)
            second = "\n".join(profile.profile_prime_lines(self.DOC, now=datetime.date(2026, 2, 13)))
            self.assertNotIn("早的事", second)
            self.assertNotIn("过期", second)
            self.assertIn("晚的事（7 天后）", second)
            # Rewriting attribution does not repeat a reminder, a changed deadline does.
            self.assertNotIn("早的事", "\n".join(profile.profile_prime_lines(
                self.DOC.replace("claude-code", "codex"), now=datetime.date(2026, 2, 13))))
            self.assertIn("早的事", "\n".join(profile.profile_prime_lines(
                self.DOC.replace("2026-02-10 ·", "2026-02-11 ·"), now=datetime.date(2026, 2, 13))))

    def test_concurrent_prime_claims_overdue_only_once(self):
        from concurrent.futures import ThreadPoolExecutor
        with patch.object(dispatch, "DISPATCH_DIR", self.tmp), ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: profile.profile_prime_lines(self.DOC, now=datetime.date(2026, 2, 12)), range(8)))
        self.assertEqual(sum("这几条过期了，做完了吗：" in lines for lines in results), 1)

    def test_invalid_receipts_recover_and_completed_items_stay_out(self):
        with open(os.path.join(self.tmp, "profile-overdue.json"), "w") as f:
            f.write("broken")
        with patch.object(dispatch, "DISPATCH_DIR", self.tmp):
            lines = profile.profile_prime_lines(self.DOC, now=datetime.date(2026, 2, 12))
            self.assertIn("这几条过期了，做完了吗：", lines)
            self.assertNotIn("以前的事", "\n".join(lines))

    def test_ssh_aliases_intersect_named_aliases_with_config_hosts(self):
        facts = "`~/.ssh/config` 别名 `hetzner`（root@1.2.3.4）；`ssh nas` 走 ProxyJump；`ssh me@5.6.7.8` 本机。"
        with patch.object(profile, "profile_ssh_config_hosts", return_value=["hetzner", "nas", "mini"]):
            self.assertEqual(profile.profile_ssh_aliases(facts), ["hetzner", "nas"])

    def test_ssh_config_reading_skips_wildcards(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "config")
            with open(p, "w") as f:
                f.write("Host a b\n  HostName x\nHost zitigate-* headnode-*\nHost c\n")
            with patch.object(profile, "PROFILE_SSH_CONFIG", p):
                self.assertEqual(profile.profile_ssh_config_hosts(), ["a", "b", "c"])

    def test_due_skips_without_model_and_backs_off_after_a_failed_try(self):
        state = os.path.join(self.tmp, "inventory.json")
        summarize = dispatch._mod("summarize")
        with patch.object(profile, "PROFILE_INVENTORY_STATE", state), patch.object(profile, "profile_inventory_spawn") as spawn:
            with patch.object(summarize, "use_enabled", return_value=True), patch.object(summarize, "provider", return_value=None):
                r = profile.profile_inventory_due(now=1000)
                self.assertFalse(r["due"]); self.assertIn("模型", r["reason"]); spawn.assert_not_called()
                self.assertFalse(os.path.exists(state))
            with patch.object(summarize, "use_enabled", return_value=True), patch.object(summarize, "provider", return_value={"id": "zhipu", "model": "glm"}):
                r = profile.profile_inventory_due(now=1000)
                self.assertTrue(r["due"]); spawn.assert_called_once()
                self.assertEqual(json.load(open(state))["tried"], 1000)
                r = profile.profile_inventory_due(now=1000 + 3600)      # the spawned run failed: no `at` yet
                self.assertFalse(r["due"]); self.assertIn("不重试", r["reason"]); spawn.assert_called_once()
                r = profile.profile_inventory_due(now=1000 + 7 * 3600)
                self.assertTrue(r["due"]); self.assertEqual(spawn.call_count, 2)
                json.dump({"at": 5000}, open(state, "w"))
                self.assertFalse(profile.profile_inventory_due(now=5000 + 3600)["due"])
            with patch.object(summarize, "use_enabled", return_value=False):
                r = profile.profile_inventory_due(now=99999999)
                self.assertFalse(r["due"]); self.assertIn("disabled", r["reason"]); self.assertEqual(spawn.call_count, 2)

    def test_inventory_requires_refresh_or_due(self):
        with self.assertRaises(SystemExit) as e:
            self.run_op("inventory")
        self.assertEqual(e.exception.code, 2)

    def test_show_json_shape_and_inventory_at(self):
        r = self.run_op("show")
        self.assertEqual(set(r), {"path", "exists", "content", "sections", "inventory_at"})
        self.assertEqual(r["inventory_at"], "2026-01-01 10:00")
        self.assertEqual([s["key"] for s in r["sections"]], ["who", "devices", "upcoming", "past"])


class EnglishFormat(ProfileDoc):
    def test_read_translates_headings_without_writing(self):
        shown = self.run_op("show")
        self.assertEqual(shown["sections"][0]["heading"], "Who I am")
        self.assertIn("## Upcoming", shown["content"])
        self.assertEqual(self.text(), self.DOC)

    def test_migrate_backs_up_both_files_and_is_idempotent(self):
        facts = os.path.join(self.tmp, "FACTS.md")
        old = "# 常用信息（跨项目通用 · 两台 Mac 各一份）\n\n## 通用\n\n**我的设计偏好**\n- 用户的事实保持中文\n"
        with open(facts, "w", encoding="utf-8") as f:
            f.write(old)
        with patch.object(dispatch, "FACTS_FILE", facts):
            first = self.run_op("migrate")
            self.assertEqual(len(first["changed"]), 2)
            for item, expected in zip(first["changed"], (self.DOC, old)):
                self.assertIn(os.sep + "backups" + os.sep, item["backup"])
                with open(item["backup"], encoding="utf-8") as f:
                    self.assertEqual(f.read(), expected)
            self.assertEqual(self.run_op("migrate")["changed"], [])
        with open(facts, encoding="utf-8") as f:
            self.assertEqual(f.read(), "# Facts\n\n## General\n\n**Design preferences**\n- 用户的事实保持中文\n")
        self.assertEqual(profile.profile_entries(self.text(), "Upcoming"), profile.profile_entries(self.DOC, "将来会发生的事"))

    def test_edit_using_the_new_heading_accepts_an_old_file(self):
        text = profile.profile_set_section_body(self.DOC, "Who I am", "- New fact")
        self.assertIn("- New fact", text)
        profile.profile_write_content(text)
        self.assertIn("## Who I am", self.text())
        self.assertNotIn("## 我是谁", self.text())
        self.run_op("add", "Another fact")
        self.assertEqual(self.text().count("## Who I am"), 1)

    def test_migration_preserves_symlink_and_custom_sections(self):
        real = os.path.join(self.tmp, "real.md")
        custom = "\n## 自定义标题\n- 将来会发生的事只是内容\n"
        os.rename(self.path, real)
        with open(real, "a", encoding="utf-8") as f:
            f.write(custom)
        os.symlink(real, self.path)
        with patch.object(dispatch, "FACTS_FILE", os.path.join(self.tmp, "missing.md")):
            self.run_op("migrate")
        self.assertTrue(os.path.islink(self.path))
        self.assertTrue(self.text().endswith(custom))


class WindowsInventory(unittest.TestCase):
    def test_this_machine_is_left_out_but_remote_ones_stay(self):
        with patch.object(P, "IS_WIN", True), patch.object(dispatch, "local_host_name", side_effect=AssertionError("not asked")), \
             patch.object(dispatch, "hosts", return_value=[{"id": "mini", "name": "Mini", "ssh": "me@mini"}]), patch.object(dispatch, "facts_text", return_value=""):
            rows = profile.profile_inventory_targets()
        self.assertEqual([(r["kind"], r["ssh"]) for r in rows], [("mac", "me@mini")])

    def test_the_mac_still_surveys_itself(self):
        with patch.object(P, "IS_WIN", False), patch.object(dispatch, "local_host_name", return_value="Book"), \
             patch.object(dispatch, "hosts", return_value=[]), patch.object(dispatch, "facts_text", return_value=""):
            self.assertEqual(profile.profile_inventory_targets()[0]["kind"], "local")

    def test_background_run_goes_through_the_platform_layer(self):
        with tempfile.TemporaryDirectory() as d, patch.object(dispatch, "DISPATCH_DIR", d), patch.object(P, "spawn_detached") as sp:
            profile.profile_inventory_spawn()
        self.assertEqual(sp.call_args.args[0][0], sys.executable); self.assertEqual(sp.call_args.args[0][2:], ["profile", "inventory", "--refresh"])


if __name__ == "__main__":
    unittest.main()
