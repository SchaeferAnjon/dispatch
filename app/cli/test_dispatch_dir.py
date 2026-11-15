"""dispatch dir: ~/.dispatch layout and the copy-then-link migration."""
import os, sys, tempfile, unittest
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dispatch_dir as DD


def write(p, text="x"):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)


class MigrateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = os.path.realpath(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {"HOME": self.home, "DISPATCH_HOME": ""})
        self.env.start()
        h = self.home
        # an old cc-switch pool: two skills, one of them a relative link to a repo
        write(f"{h}/.cc-switch/skills/pdf/SKILL.md", "---\nname: pdf\n---\n")
        write(f"{h}/repo/skills/board/SKILL.md", "---\nname: board\n---\n")
        os.symlink("../../repo/skills/board", f"{h}/.cc-switch/skills/board")
        # mounts: a relative link into the pool, an absolute one, and a skill that lives elsewhere
        os.makedirs(f"{h}/.claude/skills")
        os.symlink("../../.cc-switch/skills/pdf", f"{h}/.claude/skills/pdf")
        os.symlink(f"{h}/.cc-switch/skills/board", f"{h}/.claude/skills/board")
        write(f"{h}/.agents/skills/own/SKILL.md")
        os.symlink("../../.agents/skills/own", f"{h}/.claude/skills/own")
        write(f"{h}/.claude/agents/designer.md", "---\nname: designer\neffort: max\n---\nbody\n")
        write(f"{h}/.agents/rules/GLOBAL.md", "# mine\n")
        write(f"{h}/.agents/rules/PROFILE.md", "# me\n")

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_dry_run_changes_nothing(self):
        steps = DD.plan()
        ops = [s["op"] for s in steps]
        self.assertIn("copy", ops)
        self.assertIn("relink", ops)
        self.assertEqual(ops.count("symlink"), 3)
        self.assertFalse(os.path.exists(os.path.join(self.home, ".dispatch")))
        self.assertFalse(os.path.islink(os.path.join(self.home, ".claude", "agents")))

    def test_migrate_copies_links_and_keeps_backups(self):
        h = self.home
        DD.apply(DD.plan(), log=lambda s: None)
        # new folders hold the copies
        self.assertTrue(os.path.isfile(f"{h}/.dispatch/skills/pdf/SKILL.md"))
        self.assertTrue(os.path.isfile(f"{h}/.dispatch/agents/designer.md"))
        self.assertTrue(os.path.isfile(f"{h}/.dispatch/rules/GLOBAL.md"))
        # a relative link inside the pool now points at the same place, absolutely
        self.assertEqual(os.readlink(f"{h}/.dispatch/skills/board"), f"{h}/repo/skills/board")
        # old places are links into ~/.dispatch, the originals kept beside them
        for old, new in ((".cc-switch/skills", "skills"), (".claude/agents", "agents"), (".agents/rules", "rules")):
            self.assertEqual(os.path.realpath(f"{h}/{old}"), os.path.realpath(f"{h}/.dispatch/{new}"))
            self.assertTrue(os.path.isdir(f"{h}/{old}.pre-dispatch"))
        self.assertTrue(os.path.isfile(f"{h}/.claude/agents.pre-dispatch/designer.md"))
        # mounts into the old pool point into the new one; others are untouched
        self.assertEqual(os.readlink(f"{h}/.claude/skills/pdf"), f"{h}/.dispatch/skills/pdf")
        self.assertEqual(os.readlink(f"{h}/.claude/skills/board"), f"{h}/.dispatch/skills/board")
        self.assertEqual(os.readlink(f"{h}/.claude/skills/own"), "../../.agents/skills/own")
        self.assertTrue(os.path.isfile(f"{h}/.claude/skills/board/SKILL.md"))
        # Claude reads its agents through the link
        with open(f"{h}/.claude/agents/designer.md") as f:
            self.assertIn("effort: max", f.read())
        # a second run has nothing to do
        self.assertEqual([s for s in DD.plan() if s["op"] != "skip"], [])
        st = DD.status()
        self.assertEqual({r["kind"]: r["state"] for r in st["places"]}, {"skills": "linked", "agents": "linked", "rules": "linked"})

    def test_swap_never_leaves_the_path_missing(self):
        h = self.home
        target = f"{h}/.dispatch/agents"
        os.makedirs(target)
        DD.swap_in_link(f"{h}/.claude/agents", target, f"{h}/.claude/agents.pre-dispatch")
        self.assertTrue(os.path.islink(f"{h}/.claude/agents"))
        self.assertEqual(os.readlink(f"{h}/.claude/agents"), target)
        self.assertTrue(os.path.isfile(f"{h}/.claude/agents.pre-dispatch/designer.md"))
        self.assertFalse([n for n in os.listdir(f"{h}/.claude") if "dispatch-link" in n])

    def test_existing_copy_wins(self):
        h = self.home
        write(f"{h}/.dispatch/rules/GLOBAL.md", "# newer\n")
        steps = DD.plan()
        skip = [s for s in steps if s["op"] == "skip" and s.get("dst", "").endswith("GLOBAL.md")]
        self.assertTrue(skip and "different" in skip[0]["why"])
        DD.apply(steps, log=lambda s: None)
        with open(f"{h}/.dispatch/rules/GLOBAL.md") as f:
            self.assertEqual(f.read(), "# newer\n")
        with open(f"{h}/.agents/rules.pre-dispatch/GLOBAL.md") as f:
            self.assertEqual(f.read(), "# mine\n")

    def test_new_user_without_cc_switch(self):
        import shutil
        h = self.home
        shutil.rmtree(f"{h}/.cc-switch")
        shutil.rmtree(f"{h}/.claude")
        DD.init(log=lambda s: None)
        for d in DD.SUBDIRS:
            self.assertTrue(os.path.isdir(f"{h}/.dispatch/{d}"))
        steps = DD.plan()
        # no cc-switch and no Claude Code: nothing gets created there
        self.assertFalse(any(s["dst"].startswith(f"{h}/.cc-switch") or s["dst"].startswith(f"{h}/.claude") for s in steps if s.get("dst")))

    def test_config_roundtrip(self):
        DD.config_save({"agents": {"default_effort": "high"}})
        self.assertEqual(DD.config_load()["agents"]["default_effort"], "high")


if __name__ == "__main__":
    unittest.main()
