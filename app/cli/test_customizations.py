# -*- coding: utf-8 -*-
"""What the Agents window's Customizations in Dispatch IDE read and write: dispatch wiki edit / rm,
dispatch facts list / edit, dispatch profile edit (Knowledge) and dispatch ide editor-settings (Editor)."""
import contextlib
import importlib.util
import io
import json
import os
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("dispatch_knowledge", os.path.join(HERE, "dispatch.py"))
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)


def args(**kw):
    base = dict(op="list", text=None, body=None, kind=None, fix=None, why=None, tech=None, good=None, bad=None,
                project=None, task=None, key=None, all=False, json=True, semantic=False, limit=8)
    base.update(kw)
    return types.SimpleNamespace(**base)


class FakeBoard:
    """bd memories / remember / forget over a dict, and the wiki's own folder (~/.dispatch/wiki) in a temp
    DISPATCH_HOME: the first wiki write copies the board's entries there. `mem` shows both."""

    def __init__(self, entries):
        self.board = dict(entries)
        self.tmp = tempfile.TemporaryDirectory(prefix="dispatch-test-wiki-")
        self.env = {"DISPATCH_HOME": self.tmp.name}

    @property
    def mem(self):
        with patch.dict(os.environ, self.env):
            files = dispatch.wiki_file_entries() if dispatch.wiki_files_on() else None
        if files is None:
            return dict(self.board)
        return {**{k: v for k, v in self.board.items() if k.startswith(dispatch.INTERNAL_MEMORY_PREFIX)}, **files}

    def sh(self, cmd, *a, **k):
        if cmd[:2] == ["bd", "memories"]:
            return 0, json.dumps(self.board), ""
        if cmd[:2] == ["bd", "remember"]:
            self.board[cmd[cmd.index("--key") + 1]] = cmd[2]
            return 0, "", ""
        if cmd[:2] == ["bd", "forget"]:
            if cmd[2] not in self.board:
                return 1, "", f"no memory {cmd[2]}"
            del self.board[cmd[2]]
            return 0, "", ""
        if cmd[:2] == ["bd", "sql"]:
            return 0, "[]", ""
        raise AssertionError(cmd)

    def run(self, a):
        buf = io.StringIO()
        code = 0
        with patch.object(dispatch, "sh", side_effect=self.sh), patch.dict(os.environ, self.env), \
                patch.object(dispatch, "WIKI_DATES_FILE", os.path.join(self.tmp.name, "wiki-dates.json")), \
                contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            try:
                dispatch.cmd_wiki(a)
            except SystemExit as e:
                code = e.code
        return code, buf.getvalue()


class WikiEdit(unittest.TestCase):
    def setUp(self):
        self.board = FakeBoard({
            "pit-a": "【坑】旧的坑 【解法】旧解法 #project:kanban #task:task-1",
            "retro-b": "【复盘】一次复盘 【技术】tsc 【做对】先测 【做错】没截图",
            "plain": "普通记忆",
        })
        self.addCleanup(self.board.tmp.cleanup)

    def test_body_replaced_fields_and_tags_kept(self):
        code, out = self.board.run(args(op="edit", text="pit-a", body="新的坑"))
        self.assertEqual(code, 0)
        self.assertEqual(self.board.mem["pit-a"], "【坑】新的坑 【解法】旧解法 #project:kanban #task:task-1")
        ans = json.loads(out)
        self.assertTrue(ans["ok"])
        self.assertEqual(ans["item"]["text"], "新的坑")

    def test_one_field_changed_key_without_prefix(self):
        code, _ = self.board.run(args(op="edit", text="b", bad="漏了一张截图"))
        self.assertEqual(code, 0)
        it = dispatch.wiki_parse("retro-b", self.board.mem["retro-b"])
        self.assertEqual(it["fields"], {"【技术】": "tsc", "【做对】": "先测", "【做错】": "漏了一张截图"})

    def test_field_cleared(self):
        self.board.run(args(op="edit", text="pit-a", fix=""))
        self.assertNotIn("【解法】", self.board.mem["pit-a"])

    def test_body_with_head_marker_not_doubled(self):
        self.board.run(args(op="edit", text="pit-a", body="【坑】带标记"))
        self.assertTrue(self.board.mem["pit-a"].startswith("【坑】带标记 【解法】"))

    def test_body_from_stdin(self):
        with patch("sys.stdin", io.StringIO("多行\n正文\n")):
            self.board.run(args(op="edit", text="pit-a", body="-"))
        self.assertTrue(self.board.mem["pit-a"].startswith("【坑】多行\n正文 【解法】旧解法"))

    def test_nothing_to_change_or_empty_body(self):
        self.assertEqual(self.board.run(args(op="edit", text="pit-a"))[0], 2)
        self.assertEqual(self.board.run(args(op="edit", text="pit-a", body="  "))[0], 2)
        self.assertIn("旧的坑", self.board.mem["pit-a"])

    def test_missing_entry_answers_json_error(self):
        code, out = self.board.run(args(op="edit", text="pit-none", body="x"))
        self.assertEqual(code, 1)
        self.assertFalse(json.loads(out)["ok"])

    def test_plain_memory_edit(self):
        self.board.run(args(op="edit", text="plain", body="改过的记忆", all=True))
        self.assertEqual(self.board.mem["plain"], "改过的记忆")

    def test_rm(self):
        code, out = self.board.run(args(op="rm", text="retro-b"))
        self.assertEqual(code, 0)
        self.assertNotIn("retro-b", self.board.mem)
        self.assertEqual(json.loads(out), {"ok": True, "key": "retro-b", "removed": True})
        self.assertEqual(self.board.run(args(op="rm", text="retro-b"))[0], 1)

    def test_add_json_and_no_silent_overwrite(self):
        code, out = self.board.run(args(op="add", kind="win", text="用 tsc 查类型", why="快"))
        self.assertEqual(code, 0)
        first = json.loads(out)["key"]
        self.assertEqual(first, "win-tsc")
        code, out = self.board.run(args(op="add", kind="win", text="tsc 另一条"))
        second = json.loads(out)["key"]
        self.assertEqual(second, "win-tsc-2")
        self.assertIn("用 tsc 查类型", self.board.mem[first])
        # an explicit --key still replaces on purpose
        self.board.run(args(op="add", kind="win", text="替换", key="win-tsc"))
        self.assertIn("替换", self.board.mem["win-tsc"])

    def test_add_body_from_stdin_may_start_with_dash(self):
        with patch("sys.stdin", io.StringIO("- first\n- second\n")):
            code, out = self.board.run(args(op="add", kind="pit", body="-", fix="-f"))
        self.assertEqual(code, 0)
        key = json.loads(out)["key"]
        self.assertEqual(self.board.mem[key], "【坑】- first\n- second 【解法】-f")

    def test_search_query_is_stripped(self):
        code, out = self.board.run(args(op="list", text=" 旧的坑"))
        self.assertEqual([it["key"] for it in json.loads(out)], ["pit-a"])


FACTS = """# 常用信息

> 前言

## 通用

**机器**
- 小蓝：dev
- mini：apple

**AI 供应商与用途**（名字见 `dispatch env list`）
- 智谱

**我常说的话**
- 别问

## kanban

**机器**
- 只属于 kanban
"""


class FactsListEdit(unittest.TestCase):
    def test_blocks(self):
        rows = dispatch.facts_blocks(FACTS)
        self.assertEqual([(r["section"], r["topic"]) for r in rows],
                         [("通用", "机器"), ("通用", "AI 供应商与用途"), ("通用", "我常说的话"), ("kanban", "机器")])
        self.assertEqual(rows[1]["note"], "（名字见 `dispatch env list`）")
        self.assertEqual(rows[0]["body"], "- 小蓝：dev\n- mini：apple")
        self.assertEqual(rows[2]["body"], "- 别问")

    def test_replace_keeps_title_and_spacing(self):
        new = dispatch.facts_replace_body(FACTS, "AI 供应商与用途", "- 智谱\n- 豆包\n")
        self.assertIn("**AI 供应商与用途**（名字见 `dispatch env list`）\n- 智谱\n- 豆包\n\n**我常说的话**", new)
        self.assertEqual(new.replace("- 豆包\n", ""), FACTS)

    def test_replace_last_topic(self):
        new = dispatch.facts_replace_body(FACTS, "机器", "- 换了", section="kanban")
        self.assertTrue(new.endswith("**机器**\n- 换了\n"))
        self.assertIn("- 小蓝：dev", new)

    def test_ambiguous_and_missing(self):
        with self.assertRaises(ValueError):
            dispatch.facts_replace_body(FACTS, "机器", "x")
        with self.assertRaises(KeyError):
            dispatch.facts_replace_body(FACTS, "没有的主题", "x")

    def run_cli(self, a, stdin=""):
        buf = io.StringIO()
        code = 0
        with patch("sys.stdin", io.StringIO(stdin)), contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            try:
                dispatch.cmd_facts(a)
            except SystemExit as e:
                code = e.code
        return code, buf.getvalue()

    def test_cli_list_and_edit(self):
        d = tempfile.TemporaryDirectory(prefix="dispatch-test-facts-")
        self.addCleanup(d.cleanup)
        path = os.path.join(d.name, "FACTS.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(FACTS)
        base = dict(query="", project="", path="", apply=False, out="", section="", json=True)
        with patch.object(dispatch, "FACTS_FILE", path), patch.object(dispatch, "_mod") as mod:
            code, out = self.run_cli(types.SimpleNamespace(**{**base, "op": "list"}))
            self.assertEqual(code, 0)
            rows = json.loads(out)
            self.assertEqual(len(rows), 4)
            self.assertEqual(rows[0]["path"], path)
            code, out = self.run_cli(types.SimpleNamespace(**{**base, "op": "edit", "query": "我常说的话"}), "- 别问\n- 直接做\n")
            self.assertEqual(code, 0)
            self.assertTrue(json.loads(out)["ok"])
            with open(path, encoding="utf-8") as f:
                self.assertIn("**我常说的话**\n- 别问\n- 直接做\n\n## kanban", f.read())
            code, out = self.run_cli(types.SimpleNamespace(**{**base, "op": "edit", "query": "机器"}), "x")
            self.assertEqual(code, 2)
            self.assertIn("--section", json.loads(out)["error"])
            code, out = self.run_cli(types.SimpleNamespace(**{**base, "op": "edit", "query": "机器", "section": "kanban"}), "- 新\n")
            self.assertEqual(code, 0)
            code, _ = self.run_cli(types.SimpleNamespace(**{**base, "op": "edit", "query": "没有"}), "x")
            self.assertEqual(code, 1)


PROFILE = ("# 关于我\n\n> 说明\n\n"
           "## 我是谁\n\n- 甲\n\n"
           "## 将来会发生的事\n\n- 2026-10-01 · 回国\n\n"
           "## 已发生\n\n- 2026-01-01 · 以前的事\n")


class ProfileEdit(unittest.TestCase):
    def test_show_has_items_and_drop(self):
        d = tempfile.TemporaryDirectory(prefix="dispatch-test-profile-")
        self.addCleanup(d.cleanup)
        path = os.path.join(d.name, "PROFILE.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(PROFILE)
        rows = self.prof.profile_section_rows(PROFILE)
        self.assertEqual([(r["heading"], r["line"], [i["line"] for i in r["items"]]) for r in rows],
                         [("Who I am", 5, [7]), ("Upcoming", 9, [11]), ("Past events", 13, [15])])
        a = types.SimpleNamespace(op="drop", args=["11"], text="2026-10-01 · 回国", actor="", task="", refresh=False, due=False, json=True)
        buf = io.StringIO()
        with patch.object(self.prof, "PROFILE_FILE", path), patch.object(self.prof.D, "_mod"), contextlib.redirect_stdout(buf):
            self.prof.cmd_profile(a)
        with open(path, encoding="utf-8") as f:
            self.assertNotIn("回国", f.read())

    """dispatch profile edit: the About me tab replaces one section and keeps the rest."""

    def setUp(self):
        import sys as _sys
        if HERE not in _sys.path:
            _sys.path.insert(0, HERE)
        import profile as prof  # the module calls into `import dispatch`
        self.prof = prof

    def test_replace_middle_and_last(self):
        new = self.prof.profile_set_section_body(PROFILE, "将来会发生的事", "- 2026-10-01 · 回国\n- 2026-11-01 · 考试\n")
        self.assertIn("## 将来会发生的事\n\n- 2026-10-01 · 回国\n- 2026-11-01 · 考试\n\n## 已发生", new)
        self.assertTrue(new.startswith("# 关于我\n\n> 说明\n\n## 我是谁\n\n- 甲\n\n"))
        last = self.prof.profile_set_section_body(PROFILE, "已发生", "- 新的")
        self.assertTrue(last.endswith("## 已发生\n\n- 新的\n"))
        self.assertEqual(self.prof.profile_set_section_body(PROFILE, "我是谁", "- 甲"), PROFILE)
        with self.assertRaises(KeyError):
            self.prof.profile_set_section_body(PROFILE, "没有", "x")

    def test_cli_edit(self):
        d = tempfile.TemporaryDirectory(prefix="dispatch-test-profile-")
        self.addCleanup(d.cleanup)
        path = os.path.join(d.name, "PROFILE.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(PROFILE)
        a = types.SimpleNamespace(op="edit", args=["已发生"], actor="", task="", refresh=False, due=False, json=True)
        buf = io.StringIO()
        with patch.object(self.prof, "PROFILE_FILE", path), patch.object(self.prof.D, "_mod"), \
                patch("sys.stdin", io.StringIO("- 改过\n")), contextlib.redirect_stdout(buf):
            self.prof.cmd_profile(a)
        self.assertTrue(json.loads(buf.getvalue())["ok"])
        with open(path, encoding="utf-8") as f:
            self.assertTrue(f.read().endswith("## Past events\n\n- 改过\n"))
        a.args = ["没有这节"]
        buf = io.StringIO()
        with patch.object(self.prof, "PROFILE_FILE", path), patch("sys.stdin", io.StringIO("x")), contextlib.redirect_stdout(buf), self.assertRaises(SystemExit):
            self.prof.cmd_profile(a)
        self.assertFalse(json.loads(buf.getvalue())["ok"])


class MarkdownItems(unittest.TestCase):
    TEXT = "## 通用\n\n**机器**\n- 甲：一\n  续行\n- 乙\n\n一段话\n第二行\n\n**下一个**\n- 丙"

    def test_items_with_lines(self):
        lines = self.TEXT.split("\n")
        self.assertEqual(dispatch.md_items(lines, 3, 10), [
            {"line": 4, "end": 6, "text": "甲：一\n续行"},
            {"line": 6, "end": 7, "text": "乙"},
            {"line": 8, "end": 10, "text": "一段话\n第二行"},
        ])

    def test_drop_checks_the_text(self):
        self.assertEqual(dispatch.md_drop_item(self.TEXT, 4, "甲：一\n续行"), self.TEXT.replace("- 甲：一\n  续行\n", ""))
        with self.assertRaises(ValueError):
            dispatch.md_drop_item(self.TEXT, 4, "别的")
        with self.assertRaises(ValueError):
            dispatch.md_drop_item(self.TEXT, 5, "续行")

    def test_facts_list_items_and_drop(self):
        d = tempfile.TemporaryDirectory(prefix="dispatch-test-facts-")
        self.addCleanup(d.cleanup)
        path = os.path.join(d.name, "FACTS.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(FACTS)
        base = dict(query="", project="", path="", apply=False, out="", section="", text="", json=True)
        run = FactsListEdit.run_cli
        with patch.object(dispatch, "FACTS_FILE", path), patch.object(dispatch, "_mod"):
            _, out = run(self, types.SimpleNamespace(**{**base, "op": "list"}))
            rows = json.loads(out)
            self.assertEqual(rows[0]["line"], 7)
            self.assertEqual([i["text"] for i in rows[0]["items"]], ["小蓝：dev", "mini：apple"])
            code, out = run(self, types.SimpleNamespace(**{**base, "op": "drop", "query": "9", "text": "mini：apple"}))
            self.assertEqual(code, 0)
            code, out = run(self, types.SimpleNamespace(**{**base, "op": "drop", "query": "9", "text": "mini：apple"}))
            self.assertEqual(code, 1)
            self.assertFalse(json.loads(out)["ok"])
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), dispatch.facts_normalize(FACTS.replace("- mini：apple\n", "")))


class WikiDates(unittest.TestCase):
    def test_dates_from_history_cached(self):
        d = tempfile.TemporaryDirectory(prefix="dispatch-test-wikidates-")
        self.addCleanup(d.cleanup)
        calls = []

        def sh(cmd, *a, **k):
            calls.append(cmd)
            return 0, json.dumps([{"key": "kv.memory.pit-a", "d": "2026-09-01T10:00:00Z"}]), ""
        with patch.object(dispatch, "WIKI_DATES_FILE", os.path.join(d.name, "w.json")), patch.object(dispatch, "DISPATCH_DIR", d.name), patch.object(dispatch, "sh", side_effect=sh):
            got = dispatch.wiki_dates(["pit-a", "win-new"])
            self.assertEqual(got["pit-a"], "2026-09-01T10:00:00Z")
            self.assertTrue(got["win-new"])  # not in the history yet: first seen now
            dispatch.wiki_dates(["pit-a", "win-new"])
        self.assertEqual(len(calls), 1)


class EditorSettings(unittest.TestCase):
    def setUp(self):
        import sys as _sys
        if HERE not in _sys.path:
            _sys.path.insert(0, HERE)
        import ide
        import summarize
        self.ide, self.S = ide, summarize

    def test_edit_models_follow_what_is_installed(self):
        env = {"DEEPSEEK_API_KEY": "k", "ZHIPU_API_KEY": "k"}
        from engines import codex as X
        with patch.object(self.S, "agent_bin", lambda e: "/x/" + e if e in ("claude", "codex") else ""), \
                patch.object(X, "latest_models", lambda: [("gpt-6-astra", "GPT-6-Astra")]):
            rows = self.ide.edit_models("claude:sonnet", env)
        self.assertEqual([r["id"] for r in rows], ["claude:fable", "claude:opus", "claude:sonnet", "claude:haiku", "codex:gpt-6-astra", "deepseek:deepseek-chat"])
        self.assertEqual(rows[0]["hint"], "slower, uses your subscription quota")
        self.assertEqual(rows[-1]["hint"], "")
        with patch.object(self.S, "agent_bin", lambda e: "/x/codex" if e == "codex" else ""), patch.object(X, "latest_models", lambda: []):
            rows = self.ide.edit_models("zhipu:glm-5.3-flash", {})
        self.assertEqual([r["id"] for r in rows], ["codex:default", "zhipu:glm-5.3-flash"])

    def test_tab_models_deepseek_first(self):
        with patch.object(self.S, "agent_bin", lambda e: "/x/claude" if e == "claude" else ""):
            rows = self.ide.tab_models("deepseek-flash")
        self.assertEqual([r["id"] for r in rows], ["deepseek-flash", "claude:fable", "claude:opus", "claude:sonnet", "claude:haiku"])

    def test_unpriced_models_cost_nothing(self):
        self.assertEqual(self.ide.tab_usd(1000, 0, 100, "claude:haiku"), 0.0)
        self.assertGreater(self.ide.tab_usd(1000, 0, 100, "deepseek-flash"), 0)

    def test_complete_only_for_subscription_models(self):
        with patch.object(self.ide, "settings", return_value={"ide_tab_model": "deepseek-flash"}):
            with self.assertRaises(self.ide.IdeError):
                self.ide.complete({"prefix": "x"})
        with patch.object(self.S, "provider", return_value={"id": "claude", "model": "haiku"}), \
                patch.object(self.S, "chat", return_value="```py\na + b\n```") as chat:
            r = self.ide.complete({"prefix": "return ", "suffix": "", "language": "python", "path": "x.py"}, "claude:haiku")
        self.assertEqual(r, {"ok": True, "text": "a + b", "model": "claude:haiku"})
        self.assertIn("<prefix>\nreturn </prefix>", chat.call_args[0][2])

    def test_editor_settings_shape(self):
        today = {"enabled": True, "model": "deepseek-flash", "cap_usd": 0.5, "count": 3, "usd": 0.0012, "month": {"count": 9, "usd": 0.01}}
        import dispatch as real  # the module ide.py imports (this file loads its own copy as dispatch_knowledge)
        with patch.object(self.ide, "usage_today", return_value=today), patch.object(self.ide, "settings", return_value={"ide_edit_model": "claude:opus"}), \
                patch.object(self.ide, "edit_models", return_value=[{"id": "claude:opus", "label": "x"}]), \
                patch.object(self.ide, "tab_models", return_value=[{"id": "deepseek-flash", "label": "DeepSeek V4.1 Flash", "hint": ""}]), \
                patch.object(real, "env_read", return_value=[{"name": "DEEPSEEK_API_KEY", "value": "k"}]):
            r = self.ide.editor_settings()
        self.assertEqual(r["tab"], {"enabled": True, "model": "deepseek-flash", "cap_usd": 0.5, "today": {"count": 3, "usd": 0.0012}, "month": {"count": 9, "usd": 0.01}, "has_key": True})
        self.assertEqual(r["tab_models"], [{"id": "deepseek-flash", "label": "DeepSeek V4.1 Flash", "hint": ""}])
        self.assertEqual(r["edit_model"], "claude:opus")

    def test_tab_completion_is_on_by_default(self):
        self.assertEqual(dispatch.SETTING_DEFAULTS["ide_tab_completion"], 1)


if __name__ == "__main__":
    unittest.main()
