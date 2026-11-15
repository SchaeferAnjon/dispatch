"""dispatch neat: Settings › Agents › Tidy up after work runs the built-in neat-freak skill by itself, read only,
after each finished task or once a day; off by default."""
import datetime, json, os, re, sys, tempfile, unittest
from types import SimpleNamespace
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import neat_auto as N


class NeatTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = os.path.realpath(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {"HOME": self.home, "DISPATCH_HOME": os.path.join(self.home, ".dispatch")})
        self.env.start()
        self.proj = os.path.join(self.home, "Projects", "site")
        os.makedirs(self.proj)
        self.started = []

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def starter(self, argv):
        self.started.append(argv)

    def test_off_by_default_and_a_finished_task_only_waits_for_the_daily_round(self):
        self.assertEqual(N.settings(), {"auto": "off", "engine": "", "model": ""})
        self.assertEqual(N.after_done(self.proj, now=1000, starter=self.starter), "")
        self.assertEqual(self.started, [])
        self.assertEqual(N.load_state()["waiting"], [self.proj])

    def test_after_each_task_starts_one_run_and_a_burst_makes_one(self):
        N.save_settings("task")
        msg = N.after_done(self.proj, now=1000, starter=self.starter)
        self.assertIn("tidying up site", msg)
        self.assertEqual(self.started[0][-4:], ["run", self.proj, "--why", "task"])
        # the run marks itself running; the next finished task a minute later does not start a second one
        s = N.load_state()
        s["runs"][self.proj] = {"at": 1000, "status": "running"}
        N.save_state(s)
        self.assertEqual(N.after_done(self.proj, now=1060, starter=self.starter), "")
        self.assertEqual(len(self.started), 1)
        s["runs"][self.proj] = {"at": 1000, "status": "done"}
        N.save_state(s)
        self.assertEqual(N.after_done(self.proj, now=1000 + N.DEBOUNCE + 1, starter=self.starter) != "", True)
        self.assertEqual(len(self.started), 2)

    def test_daily_runs_once_a_day_after_nine_for_the_projects_that_had_work(self):
        N.save_settings("daily")
        other = os.path.join(self.home, "Projects", "app")
        os.makedirs(other)
        N.after_done(self.proj, now=1, starter=self.starter)
        N.after_done(other, now=1, starter=self.starter)
        self.assertEqual(self.started, [], "daily does not run after a task")
        early = datetime.datetime(2026, 10, 7, 8, 30).timestamp()
        self.assertFalse(N.daily_due(early))
        nine = datetime.datetime(2026, 10, 7, 9, 5).timestamp()
        self.assertEqual(sorted(N.daily(nine, starter=self.starter)), sorted([self.proj, other]))
        self.assertEqual(N.daily(nine + 3600, starter=self.starter), [], "once a day")
        self.assertEqual(N.load_state()["waiting"], [])
        self.assertEqual(N.daily(datetime.datetime(2026, 10, 8, 10, 0).timestamp(), starter=self.starter), [], "a day with no finished task runs nothing")
        N.save_settings("off")
        self.assertFalse(N.daily_due(datetime.datetime(2026, 10, 9, 10, 0).timestamp()))

    def test_a_run_is_a_read_only_session_and_keeps_the_first_line_and_the_report(self):
        N.save_settings("task", engine="opencode")
        N.save_settings(model="zhipuai-coding-plan/glm-5.3-flash")
        seen = {}

        def runner(argv, **kw):
            seen["argv"] = argv
            out = {"session": "opencode:ses_1", "status": "idle", "output": "2 docs disagree with the code\n\n## Tidy-up check\n- README says port 3000, the server uses 8080"}
            return SimpleNamespace(returncode=0, stdout=json.dumps(out), stderr="")
        res = N.run(self.proj, "task", runner=runner, now=datetime.datetime(2026, 10, 7, 9, 0).timestamp())
        argv = seen["argv"]
        self.assertEqual(argv[argv.index("start") + 1], "opencode")
        self.assertEqual(argv[argv.index("--cwd") + 1], self.proj)
        self.assertEqual(argv[argv.index("--label") + 1], "Tidy up · site")
        self.assertEqual(argv[argv.index("--model") + 1], "zhipuai-coding-plan/glm-5.3-flash")
        prompt = argv[argv.index("--prompt") + 1]
        self.assertIn("neat-freak", prompt)
        self.assertIn("Read only", prompt)
        self.assertIn("first line", prompt)
        import own_prompts
        self.assertTrue(own_prompts.is_own(prompt))  # task-6degw: Dispatch's words, not a request to put on the board
        self.assertEqual(res["line"], "2 docs disagree with the code")
        self.assertTrue(res["report"].endswith("-site.md"))
        self.assertIn("port 3000", open(res["report"], encoding="utf-8").read())
        last = N.last_run()
        self.assertEqual((last["project"], last["status"], last["line"]), ("site", "idle", "2 docs disagree with the code"))

    def test_a_run_that_could_not_start_says_why(self):
        res = N.run(self.proj, "daily", runner=lambda argv, **kw: SimpleNamespace(returncode=1, stdout="", stderr="OpenCode is not signed in"), now=5)
        self.assertEqual(res["status"], "failed")
        self.assertIn("not signed in", res["line"])

    def test_settings_reject_what_the_window_cannot_mean(self):
        with self.assertRaises(SystemExit):
            N.save_settings("hourly")
        with self.assertRaises(SystemExit):
            N.save_settings(engine="gemini")
        self.assertEqual(N.save_settings(engine="default")["engine"], "")

    def test_the_skills_are_built_in_and_keep_the_authors_license(self):
        import customizations as C
        import init_wizard as W
        for name in ("leader", "neat-freak"):
            self.assertIn(name, W.BUILTIN_SKILLS)
            p = C.shipped_skill(name)
            self.assertTrue(p, name)
            lic = open(os.path.join(p, "LICENSE"), encoding="utf-8").read()
            self.assertIn("MIT License", lic)
            self.assertIn("数字生命卡兹克", lic)
            skill = open(os.path.join(p, "SKILL.md"), encoding="utf-8").read()
            self.assertIn("github.com/KKKKhazix/khazix-skills", skill)
            self.assertIn("dispatch", skill)
        neat = open(os.path.join(C.shipped_skill("neat-freak"), "SKILL.md"), encoding="utf-8").read()
        self.assertIn("## Automatic runs", neat)
        self.assertIn("dispatch prefs list", neat)

    def test_the_skill_reports_first_and_changes_only_what_the_person_picks(self):
        """task-8bhyl: /neat-freak in a session created AGENTS.md, committed it and added a preference. The skill now
        writes nothing before its report, then asks which findings to fix."""
        import customizations as C
        neat = open(os.path.join(C.shipped_skill("neat-freak"), "SKILL.md"), encoding="utf-8").read()
        head = neat[:neat.index("## Completion contract")]
        self.assertIn("## Report first, change only what the person picks", head)
        for words in ("Change, create, delete, move or commit no file", "no `dispatch prefs add`", "`dispatch begin`",
                      "AskUserQuestion", "Fix only the findings they picked"):
            self.assertIn(words, head)
        light = neat[neat.index("### Light path"):neat.index("### Full path")]
        self.assertIn("Do not create it in phase 1", light)
        self.assertNotIn("default create", light.lower())
        # English apart from the author's name and a few trigger words people type (task-7lptn)
        chinese = [ln for ln in neat.splitlines() if re.search(r"[\u4e00-\u9fff]{5,}", ln) and "数字生命卡兹克" not in ln]
        self.assertEqual(chinese, [])
        self.assertIn("/neat-freak", neat.split("---")[1])  # the description names the command the Agents window offers


if __name__ == "__main__":
    unittest.main()
