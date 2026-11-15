# -*- coding: utf-8 -*-
import json
import os
import shutil
import tempfile
import unittest
import unittest.mock
from types import SimpleNamespace

import aside as AS

CWD = "/w/proj"


def detail(files=None, messages=None):
    return {"meta": {"cwd": CWD}, "files": files or [], "messages": messages or []}


def msg(ts, role, text="", blocks=None):
    return {"ts": ts, "role": role, "text": text, "blocks": blocks if blocks is not None else ([{"type": "text", "text": text}] if text else [])}


MESSAGES = [
    msg("2026-09-26T10:00:00Z", "user", "把 a.txt 里的 hello 改成 hi"),
    msg("2026-09-26T10:00:05Z", "assistant", "先改 a.txt。"),
    msg("2026-09-26T10:00:08Z", "assistant", "", [{"type": "tool_call", "id": "toolu_ls", "name": "Bash", "input": {"command": "ls"}, "status": "done", "result": "a.txt\nb.txt", "ts": "2026-09-26T10:00:08Z"}]),
    msg("2026-09-26T10:00:09Z", "assistant", "改好了，ls 里有两个文件。"),
    msg("2026-09-26T10:05:00Z", "user", "再把 b 也改了"),
    msg("2026-09-26T10:05:04Z", "assistant", "b.txt 的 world 改成 earth。"),
]
FILES = [
    {"path": f"{CWD}/a.txt", "changes": [{"kind": "edit", "old": "hello", "new": "hi", "ts": "2026-09-26T10:00:06Z"}]},
    {"path": f"{CWD}/b.txt", "changes": [{"kind": "edit", "old": "world", "new": "earth", "ts": "2026-09-26T10:05:05Z"},
                                         {"kind": "patch", "old": "", "new": "--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-x\n+y\n@@ -9 +9 @@\n-p\n+q", "ts": "2026-09-26T10:05:06Z"}]},
    {"path": "/Users/me/.claude/projects/x/memory/m.md", "changes": [{"kind": "write", "old": "", "new": "note", "ts": "2026-09-26T10:05:07Z"}]},
]


class Hunks(unittest.TestCase):
    def test_edit_is_one_hunk_patch_is_one_per_section(self):
        hs = AS.file_hunks(FILES[1]["changes"])
        self.assertEqual(len(hs), 3)
        self.assertEqual(hs[1]["text"], "@@ -1 +1 @@\n-x\n+y")
        self.assertEqual(hs[2]["text"], "@@ -9 +9 @@\n-p\n+q")
        self.assertEqual(AS.split_patch("no sections"), ["no sections"])

    def test_hunk_text_is_a_unified_diff(self):
        t = AS.hunk_text(AS.file_hunks(FILES[0]["changes"])[0])
        self.assertIn("-hello", t)
        self.assertIn("+hi", t)
        self.assertTrue(AS.hunk_text({"kind": "write", "old": "", "new": "x"}).startswith("（新写了整个文件）"))

    def test_find_file_by_relative_absolute_or_unique_name(self):
        self.assertEqual(AS.find_file(FILES, "a.txt", CWD)["path"], f"{CWD}/a.txt")
        self.assertEqual(AS.find_file(FILES, f"{CWD}/b.txt", CWD)["path"], f"{CWD}/b.txt")
        self.assertEqual(AS.find_file(FILES, "m.md", CWD)["path"], FILES[2]["path"])
        self.assertIsNone(AS.find_file(FILES, "zzz.txt", CWD))
        self.assertEqual(AS.parse_hunk_arg("app/a.ts:2"), ("app/a.ts", 2))
        self.assertEqual(AS.parse_hunk_arg("a.ts"), ("a.ts", 1))


class Targets(unittest.TestCase):
    def test_hunk_target_carries_its_round(self):
        t = AS.find_target(detail(FILES, MESSAGES), hunk="b.txt:2")
        self.assertEqual(t["key"], "hunk:b.txt:2")
        self.assertEqual(t["round"][1], "再把 b 也改了")
        self.assertEqual(t["round"][2], ["b.txt 的 world 改成 earth。"])
        first = AS.find_target(detail(FILES, MESSAGES), hunk="a.txt:1")
        self.assertEqual(first["round"][1], "把 a.txt 里的 hello 改成 hi")
        self.assertIn("改好了", "\n".join(first["round"][2]))

    def test_tool_target(self):
        t = AS.find_target(detail(FILES, MESSAGES), tool="toolu_ls")
        self.assertEqual((t["command"], t["output"]), ("ls", "a.txt\nb.txt"))

    def test_missing_pieces_say_why(self):
        with self.assertRaisesRegex(LookupError, "只有 1 处"):
            AS.find_target(detail(FILES, MESSAGES), hunk="a.txt:4")
        with self.assertRaisesRegex(LookupError, "没改过"):
            AS.find_target(detail(FILES, MESSAGES), hunk="c.txt:1")
        with self.assertRaisesRegex(LookupError, "找不到工具调用"):
            AS.find_target(detail(FILES, MESSAGES), tool="nope")


class Context(unittest.TestCase):
    def test_small_context_is_whole(self):
        t = AS.find_target(detail(FILES, MESSAGES), hunk="a.txt:1")
        text, cut = AS.build_context(t)
        self.assertEqual(cut, [])
        for part in ("把 a.txt 里的 hello 改成 hi", "先改 a.txt。", "-hello", "+hi", "a.txt 第 1 处（共 1 处）"):
            self.assertIn(part, text)
        self.assertNotIn("截掉", text)

    def test_long_context_is_cut_to_8000_and_says_so(self):
        big = "\n".join(f"line {i} " + "x" * 60 for i in range(400))
        files = [{"path": f"{CWD}/big.py", "changes": [{"kind": "write", "old": "", "new": big, "ts": "2026-09-26T10:00:06Z"}]}]
        msgs = [msg("2026-09-26T10:00:00Z", "user", "写个大文件" * 300), msg("2026-09-26T10:00:05Z", "assistant", "说明" * 3000)]
        t = AS.find_target(detail(files, msgs), hunk="big.py:1")
        text, cut = AS.build_context(t)
        self.assertLessEqual(len(text), AS.CONTEXT_MAX)
        self.assertGreater(len(text), AS.CONTEXT_MAX - 400)  # the room is used, not wasted
        self.assertIn("上下文超过 8000 字，已截掉一部分", text)
        self.assertEqual(cut, ["你这一轮说的话", "Agent 这一轮的说明（留了最后一段）", "这段改动的中间部分"])
        self.assertIn("line 0 ", text)      # head of the file kept
        self.assertIn("line 399 ", text)    # and its tail
        self.assertIn("中间省略", text)

    def test_long_command_output(self):
        out = "ok\n" * 6000
        msgs = [msg("2026-09-26T10:00:00Z", "user", "跑测试"), msg("2026-09-26T10:00:01Z", "assistant", "", [{"type": "tool_call", "id": "t1", "name": "Bash", "input": {"command": "npm test"}, "status": "done", "result": out}])]
        text, cut = AS.build_context(AS.find_target(detail([], msgs), tool="t1"))
        self.assertLessEqual(len(text), AS.CONTEXT_MAX)
        self.assertEqual(cut, ["命令输出的中间部分"])
        self.assertIn("$ npm test", text)

    def test_follow_up_carries_earlier_questions(self):
        t = AS.find_target(detail(FILES, MESSAGES), hunk="a.txt:1")
        text, _ = AS.build_context(t, [{"q": "为什么这么改", "answer": "用户要求的。"}])
        self.assertIn("## 之前在这里问过\n问：为什么这么改\n答：用户要求的。", text)


class Ask(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="aside-test-")
        self.calls = []

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def fake_run(self, answer="因为用户要求把 hello 改成 hi。", code=0):
        def run(argv, **kw):
            self.calls.append((argv, kw))
            return SimpleNamespace(returncode=code, stdout=answer, stderr="boom" if code else "")
        return run

    def test_ask_runs_one_throwaway_haiku_and_keeps_the_answer(self):
        os.environ["CLAUDECODE"] = "1"
        try:
            with unittest.mock.patch.object(AS, "claude_bin", return_value="/bin/claude"):
                item = AS.ask(detail(FILES, MESSAGES), self.dir, "claude-code:s1", "为什么这么改", hunk="a.txt:1", run=self.fake_run(), now=100)
        finally:
            os.environ.pop("CLAUDECODE", None)
        argv, kw = self.calls[0]
        self.assertEqual(argv[:2], ["/bin/claude", "-p"])
        for flag in ("--no-session-persistence", "--tools", "claude-haiku-4-5-20251001"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--tools") + 1], "")
        self.assertNotIn("CLAUDECODE", kw["env"])
        self.assertIn("## 用户的问题\n为什么这么改", kw["input"])
        self.assertIn("-hello", kw["input"])
        self.assertEqual((item["answer"], item["target"], item["truncated"]), ("因为用户要求把 hello 改成 hi。", "hunk:a.txt:1", False))
        # kept: the panel shows it again after a reopen
        with open(AS.cache_path(self.dir, "claude-code:s1"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["items"][0]["id"], item["id"])
        self.assertTrue(AS.cache_path(self.dir, "claude-code:s1").endswith("aside/claude-code_s1.json"))

    def test_follow_ups_stop_after_three(self):
        with unittest.mock.patch.object(AS, "claude_bin", return_value="/bin/claude"):
            for i in range(AS.FOLLOW_UPS):
                AS.ask(detail(FILES, MESSAGES), self.dir, "s", f"问 {i}", hunk="a.txt:1", run=self.fake_run())
            self.assertIn("问：问 0", self.calls[-1][1]["input"])
            with self.assertRaisesRegex(LookupError, "主对话"):
                AS.ask(detail(FILES, MESSAGES), self.dir, "s", "再问", hunk="a.txt:1", run=self.fake_run())

    def test_failed_model_run_is_an_error_not_an_answer(self):
        with unittest.mock.patch.object(AS, "claude_bin", return_value="/bin/claude"):
            with self.assertRaisesRegex(RuntimeError, "boom"):
                AS.ask(detail(FILES, MESSAGES), self.dir, "s", "q", hunk="a.txt:1", run=self.fake_run("", 1))
        self.assertEqual(AS.load(self.dir, "s"), {"items": []})

    def test_empty_question(self):
        with self.assertRaises(LookupError):
            AS.ask(detail(FILES, MESSAGES), self.dir, "s", "  ", hunk="a.txt:1", run=self.fake_run())


if __name__ == "__main__":
    unittest.main()
