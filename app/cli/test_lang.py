# -*- coding: utf-8 -*-
"""lang.py and the words Dispatch writes to the person and their agents (task-7lptn): an English speaker gets
English, a Chinese speaker gets Chinese, wherever the language comes from."""
import io
import json
import os
import re
import shutil
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lang as L  # noqa: E402

CJK = re.compile(r"[㐀-鿿]")


class Detect(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="dlang-")
        self.addCleanup(shutil.rmtree, self.home, True)
        env = {k: v for k, v in os.environ.items() if k not in ("DISPATCH_LANG", "DISPATCH_HOME", "LANG", "LC_ALL", "LC_MESSAGES")}
        env["HOME"] = self.home
        p = mock.patch.dict(os.environ, env, clear=True)
        p.start()
        self.addCleanup(p.stop)
        L._cache.clear()
        self.addCleanup(L._cache.clear)

    def write(self, rel, text):
        path = os.path.join(self.home, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    def test_a_new_person_with_nothing_set_gets_english(self):
        self.assertEqual(L.detect(), ("en", "default"))

    def test_the_setting_wins_over_everything_but_the_variable(self):
        self.write(".dispatch-ide/argv.json", '// comment\n{"locale": "zh-cn"}')
        self.write(".dispatch/config.json", json.dumps({"language": "en"}))
        self.assertEqual(L.detect(), ("en", "setting"))
        L._cache.clear()
        with mock.patch.dict(os.environ, {"DISPATCH_LANG": "zh"}):
            self.assertEqual(L.detect(), ("zh", "DISPATCH_LANG"))

    def test_the_ide_display_language_then_the_profile_then_the_mac(self):
        self.write(".dispatch-ide/argv.json", '{\n\t// VS Code writes comments\n\t"locale": "zh-cn"\n}')
        self.assertEqual(L.detect(), ("zh", "Dispatch IDE display language"))
        L._cache.clear()
        os.remove(os.path.join(self.home, ".dispatch-ide", "argv.json"))
        self.write(".dispatch/rules/PROFILE.md", "## Who I am\n- Usual language: 简体中文（2026-10-01 · dispatch init）\n")
        self.assertEqual(L.detect(), ("zh", "profile"))
        L._cache.clear()
        os.remove(os.path.join(self.home, ".dispatch", "rules", "PROFILE.md"))
        import plistlib
        os.makedirs(os.path.join(self.home, "Library", "Preferences"))
        with open(os.path.join(self.home, "Library", "Preferences", ".GlobalPreferences.plist"), "wb") as f:
            plistlib.dump({"AppleLanguages": ["zh-Hans-US", "en-US"]}, f)
        if sys.platform == "darwin":
            self.assertEqual(L.detect(), ("zh", "Mac language"))

    def test_other_languages_get_english_and_auto_clears_the_setting(self):
        self.write(".dispatch/config.json", json.dumps({"language": "de"}))
        self.assertEqual(L.lang(), "en")
        L.set_language("zh")
        self.assertEqual(L.detect(), ("zh", "setting"))
        L.set_language("auto")
        self.assertNotIn("language", json.load(open(os.path.join(self.home, ".dispatch", "config.json"))))
        with self.assertRaises(SystemExit):
            L.set_language("fr")

    def test_t_picks_by_language(self):
        with mock.patch.dict(os.environ, {"DISPATCH_LANG": "en"}):
            self.assertEqual(L.t("Done", "好了"), "Done")
        with mock.patch.dict(os.environ, {"DISPATCH_LANG": "zh"}):
            self.assertEqual(L.t("Done", "好了"), "好了")


class EnglishSurfaces(unittest.TestCase):
    """What an English speaker's agents read: the brief, command answers, skills. Nothing Chinese in them."""

    def setUp(self):
        p = mock.patch.dict(os.environ, {"DISPATCH_LANG": "en"})
        p.start()
        self.addCleanup(p.stop)

    def test_the_brief_is_english(self):
        import prime_brief as B
        tasks = [{"id": "task-1", "title": "Add a search box", "status": "in_progress", "labels": ["project:todo"], "assignee": "opencode"},
                 {"id": "task-2", "title": "Dark mode", "status": "open", "labels": ["project:todo"]}]
        lines = B.board(tasks, "todo", lambda t: {"in_progress": "in_progress", "open": "todo"}[t["status"]])
        text, _ = B.build("# Dispatch · project todo", [("board", lines), ("this folder", B.peers(["◐ opencode ses_1 · working"], "", []))])
        self.assertIn("## On the board (todo: in progress and waiting for you)", text)
        self.assertIn("1 more to do", text)
        self.assertIn("## Running in this folder (1)", text)
        self.assertTrue(text.rstrip().endswith("`dispatch profile show`."))
        self.assertIsNone(CJK.search(text.replace("ses_1", "")), text)

    def test_an_over_budget_brief_says_so_in_english(self):
        import prime_brief as B
        big = [("pitfalls", ["- " + "x" * 200] * 80)]
        text, cut = B.build("# Dispatch · project todo", big, save=lambda full: "/tmp/brief.md", budget=2000)
        self.assertEqual(cut, ["pitfalls"])
        self.assertIn("the brief was over its budget", text)
        self.assertIsNone(CJK.search(text))

    def test_browser_and_computer_answers(self):
        import browser
        import computer
        self.assertEqual(browser._text("click", {"title": "Todo", "url": "http://x"}), "Done: Todo  http://x")
        self.assertEqual(browser._text("close", {"closed": False}), "It was not open")
        self.assertIsNone(CJK.search(computer.ended_text({"app": "Notes", "reason": "person", "steps": 3, "page": "/p.html"})))

    def test_a_refused_handoff_explains_itself_in_english(self):
        import handoff_facts as F
        bad = F.problems({"goal": "x", "completed": ["looked around"], "next": ""})
        msg = F.rejection(bad)
        self.assertIn("The handoff was refused", msg)
        self.assertIsNone(CJK.search(msg), msg)

    def test_session_names_and_short_titles_keep_an_english_message_english(self):
        import summarize as S
        with mock.patch.object(S, "use_enabled", return_value=True), mock.patch.object(S, "provider", return_value={"id": "x", "model": "m"}), \
                mock.patch.object(S, "chat", return_value="笔记深色"):
            self.assertEqual(S.short_name("Add a dark mode to the notes page", timeout=2), "")
            self.assertEqual(S.short_title("Add a dark mode to the notes page because people read at night", timeout=2), "")
        with mock.patch.object(S, "use_enabled", return_value=True), mock.patch.object(S, "provider", return_value={"id": "x", "model": "m"}), \
                mock.patch.object(S, "chat", return_value="Notes dark mode") as chat:
            self.assertEqual(S.short_name("Add a dark mode to the notes page", timeout=2), "Notes dark mode")
            self.assertIn("in the language of the message", chat.call_args.args[1])

    def test_builtin_skills_and_agents_are_english(self):
        """Every skill, helper agent and Dispatch's own rules ship in English apart from names, words people type and
        the board's data markers; they tell the agent to answer in the person's language."""
        root = os.path.join(os.path.dirname(os.path.dirname(HERE)), "agent")
        bad = []
        for base, _, files in os.walk(root):
            for name in files:
                if not name.endswith((".md", ".sh", ".mjs", ".js", ".py")):
                    continue
                path = os.path.join(base, name)
                with open(path, encoding="utf-8") as fh:
                    lines = list(fh)
                for no, line in enumerate(lines, 1):
                    if re.search(r"[一-鿿]{6,}", line) and not re.search(r"数字生命卡兹克|Copyright", line):
                        bad.append(f"{os.path.relpath(path, root)}:{no}: {line.strip()[:80]}")
        self.assertEqual(bad, [], "\n".join(bad[:20]))


if __name__ == "__main__":
    unittest.main()
