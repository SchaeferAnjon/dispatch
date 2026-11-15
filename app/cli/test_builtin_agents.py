"""dispatch builtin-agents: the helper agents that ship with Dispatch, installed for Claude Code, Codex and
OpenCode as copies; a person's file of the same name is never replaced."""
import json, os, re, sys, tempfile, unittest
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import builtin_agents as B
import dispatch as D

FIRST = ("engineer", "tester", "researcher", "designer", "teaching-master", "animation-director")


def write(p, text):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


class ShippedTest(unittest.TestCase):
    def test_the_first_four_ship_with_complete_frontmatter(self):
        defs = B.shipped()
        for name in FIRST:
            self.assertIn(name, defs)
            fm = defs[name]["fm"]
            self.assertEqual(fm["name"], name)
            for key in ("description", "model", "effort"):
                self.assertTrue(fm.get(key), f"{name}: {key}")
            self.assertIn(fm["effort"], ("low", "medium", "high", "xhigh", "max"))
            # Claude Code reads the frontmatter as YAML: a bare ': ' or ' #' would break the line
            self.assertNotRegex(fm["description"], r": | #", name)
            self.assertGreater(len(defs[name]["body"]), 400, name)

    def test_nothing_private_goes_to_every_user(self):
        private = re.compile(r"/Users/|~/Projects|macbook|Mac mini|\bmini\b|cc-switch|qvenv|tailscale|100\.\d+\.\d+\.\d+|@gmail|task-[a-z0-9]{4}", re.I)
        root = os.path.dirname(B.shipped_dir())
        files = [os.path.join(B.shipped_dir(), n) for n in os.listdir(B.shipped_dir())]
        for skill in ("designer", "teaching-master", "animation-director"):
            files += [os.path.join(root, "skills", skill, n) for n in os.listdir(os.path.join(root, "skills", skill))]
        for p in files:
            self.assertIsNone(private.search(read(p)), p)

    def test_each_engine_gets_a_file_it_can_read(self):
        d = B.shipped()["designer"]
        try:
            import tomllib
        except ImportError:  # Python 3.9 and 3.10
            tomllib = None
        toml = B.render("codex", d)
        if tomllib:
            t = tomllib.loads(toml)
            self.assertEqual((t["name"], t["model_reasoning_effort"]), ("designer", "high"))
            self.assertEqual(t["developer_instructions"].strip(), d["body"].strip())
        self.assertNotIn("\nmodel =", toml)  # a Claude alias means nothing to Codex
        oc = B.render("opencode", d)
        fm, body = B.split(oc)
        self.assertEqual(fm, {"description": d["fm"]["description"], "mode": "subagent"})
        self.assertEqual(body, d["body"])
        self.assertEqual(B.render("claude", d), d["text"])

    def test_a_body_with_triple_quotes_still_makes_valid_toml(self):
        s = B.toml_string("a ''' b \\ \"\"\" c\n")
        try:
            import tomllib
        except ImportError:
            return
        self.assertEqual(tomllib.loads("x = " + s)["x"], "a ''' b \\ \"\"\" c\n")


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = h = os.path.realpath(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {"HOME": h, "DISPATCH_HOME": "", "CODEX_HOME": "", "XDG_CONFIG_HOME": "", "CLAUDE_CONFIG_DIR": ""})
        self.env.start()
        for k in ("DISPATCH_HOME", "CODEX_HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR"):
            os.environ.pop(k, None)
        os.makedirs(f"{h}/.codex")
        os.makedirs(f"{h}/.config/opencode")
        os.makedirs(f"{h}/.dispatch/agents")
        os.makedirs(f"{h}/.claude")
        os.symlink(f"{h}/.dispatch/agents", f"{h}/.claude/agents")
        self.dd = mock.patch.object(D, "DISPATCH_DIR", f"{h}/tasks/.dispatch")
        self.dd.start()

    def tearDown(self):
        self.dd.stop()
        self.env.stop()
        self.tmp.cleanup()

    def p(self, engine, name):
        return {"claude": f"{self.home}/.dispatch/agents/{name}.md", "codex": f"{self.home}/.codex/agents/{name}.toml",
                "opencode": f"{self.home}/.config/opencode/agents/{name}.md"}[engine]

    def actions(self, rows):
        return {(r["engine"], r["name"]): r["action"] for r in rows}

    def test_a_new_mac_gets_every_agent_for_every_engine_and_a_second_sync_changes_nothing(self):
        first = self.actions(B.sync())
        for name in FIRST:
            for engine in ("claude", "codex", "opencode"):
                self.assertEqual(first[(engine, name)], "installed")
                self.assertTrue(os.path.isfile(self.p(engine, name)))
                self.assertFalse(os.path.islink(self.p(engine, name)))  # a copy: an edit never reaches the app
        self.assertEqual(set(self.actions(B.sync()).values()), {"current"})
        rows = {r["name"]: r for r in B.rows()}
        self.assertTrue(all(r["builtin"] and r["enabled"] for r in rows.values()))
        self.assertTrue(B.is_builtin(f"{self.home}/.claude/agents/designer.md"))

    def test_claude_code_installed_after_setup_gets_the_link(self):
        os.unlink(f"{self.home}/.claude/agents")
        B.sync()
        self.assertEqual(os.path.realpath(f"{self.home}/.claude/agents"), f"{self.home}/.dispatch/agents")
        self.assertTrue(os.path.isfile(f"{self.home}/.claude/agents/engineer.md"))

    def test_an_engine_that_is_not_here_gets_nothing(self):
        os.rmdir(f"{self.home}/.codex")
        B.sync()
        self.assertFalse(os.path.exists(f"{self.home}/.codex"))

    def test_a_file_of_yours_with_the_same_name_is_never_replaced(self):
        mine = "---\nname: designer\ndescription: my own designer\nmodel: opus\neffort: max\n---\n\nmy way of working\n"
        write(self.p("claude", "designer"), mine)
        write(f"{self.home}/.config/opencode/agent/tester.md", "---\ndescription: mine\n---\nmine\n")  # OpenCode's other folder
        rows = self.actions(B.sync())
        self.assertEqual(rows[("claude", "designer")], "kept yours")
        self.assertEqual(read(self.p("claude", "designer")), mine)
        self.assertEqual(rows[("opencode", "tester")], "kept yours")
        self.assertFalse(os.path.exists(self.p("opencode", "tester")))
        self.assertEqual(rows[("codex", "designer")], "installed")  # only the engine where it is yours is skipped
        row = next(r for r in B.rows() if r["name"] == "designer")
        self.assertFalse(row["builtin"])
        self.assertEqual(row["yours"], ["Claude Code"])
        self.assertFalse(B.is_builtin(self.p("claude", "designer")))
        # and it stays that way through the next update
        B.sync()
        self.assertEqual(read(self.p("claude", "designer")), mine)

    def test_an_update_replaces_what_dispatch_wrote_but_not_what_you_edited(self):
        B.sync()
        st = B.state()
        for engine in ("claude", "codex"):
            old = "an older version\n"
            write(self.p(engine, "engineer"), old)
            st["files"][f"{engine}:engineer"]["sha"] = B.sha(old)
        B.save_state(st)
        edited = read(self.p("opencode", "engineer")) + "\nmy own rule\n"
        write(self.p("opencode", "engineer"), edited)
        rows = self.actions(B.sync())
        self.assertEqual(rows[("claude", "engineer")], "updated")
        self.assertEqual(read(self.p("claude", "engineer")), B.shipped()["engineer"]["text"])
        self.assertEqual(rows[("codex", "engineer")], "updated")
        self.assertEqual(rows[("opencode", "engineer")], "kept yours")
        self.assertEqual(read(self.p("opencode", "engineer")), edited)

    def test_one_you_deleted_is_not_put_back(self):
        B.sync()
        os.unlink(self.p("claude", "tester"))
        rows = self.actions(B.sync())
        self.assertEqual(rows[("claude", "tester")], "removed by you")
        self.assertFalse(os.path.exists(self.p("claude", "tester")))
        self.assertEqual(rows[("codex", "tester")], "current")

    def test_off_removes_dispatchs_copies_and_stays_off_until_on(self):
        B.sync()
        write(self.p("codex", "researcher"), "edited by hand\n")
        res = B.turn("researcher", False)
        self.assertEqual(sorted(res["removed"]), sorted([self.p("claude", "researcher"), self.p("opencode", "researcher")]))
        self.assertEqual(read(self.p("codex", "researcher")), "edited by hand\n")  # yours: left
        self.assertNotIn("installed", self.actions(B.sync()).values())
        self.assertFalse(os.path.exists(self.p("claude", "researcher")))
        self.assertFalse(next(r for r in B.rows() if r["name"] == "researcher")["enabled"])
        os.unlink(self.p("claude", "engineer"))  # deleted by hand earlier
        B.turn("researcher", True)
        self.assertEqual(read(self.p("claude", "researcher")), B.shipped()["researcher"]["text"])
        B.turn("engineer", True)  # on puts back one deleted by hand
        self.assertTrue(os.path.isfile(self.p("claude", "engineer")))
        with self.assertRaises(SystemExit):
            B.turn("nobody", False)

    def test_the_agents_window_sync_waits_for_setup(self):
        self.assertFalse(B.set_up())
        write(f"{self.home}/tasks/.dispatch/onboarding.json", json.dumps({"state": "done"}))
        self.assertTrue(B.set_up())

    def test_the_command_skips_a_mac_that_was_not_set_up(self):
        import argparse, io, contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            B.command(argparse.Namespace(op="sync", name="", if_set_up=True, dry_run=False, json=True))
        self.assertEqual(json.loads(buf.getvalue())["skipped"], "not set up yet")
        self.assertFalse(os.listdir(f"{self.home}/.dispatch/agents"))


class DesignerSkillTest(unittest.TestCase):
    def test_your_own_designer_skill_is_not_taken_for_dispatchs(self):
        import init_wizard as W
        import customizations as C
        self.assertIn("designer", W.BUILTIN_SKILLS)
        with tempfile.TemporaryDirectory() as t:
            pool = os.path.join(t, "skills")
            # a designer skill of someone's own that mentions the dispatch CLI: theirs, not an old copy of ours
            write(os.path.join(pool, "designer", "SKILL.md"), "---\nname: designer\n---\nrun dispatch deliver at the end\n")
            write(os.path.join(pool, "task-board", "SKILL.md"), "---\nname: task-board\n---\nold dispatch board notes\n")
            self.assertFalse(W.builtin_skill_content(os.path.join(pool, "designer"), "designer"))
            self.assertFalse(C.is_builtin_skill("designer", os.path.join(pool, "designer")))
            done = W.link_builtin_skills(pool, backups=os.path.join(t, "bak"))
            self.assertFalse(os.path.islink(os.path.join(pool, "designer")))
            self.assertIn("run dispatch deliver", read(os.path.join(pool, "designer", "SKILL.md")))
            self.assertIn("task-board", [d["skill"] for d in done])  # an old copy of a first built-in is still relinked
        shipped = C.shipped_skill("designer")
        self.assertTrue(C.is_builtin_skill("designer", str(shipped)))


if __name__ == "__main__":
    unittest.main()
