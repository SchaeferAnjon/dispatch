"""dispatch agents: definitions in ~/.dispatch/agents, the default effort, project links, agent run."""
import json, os, sys, tempfile, unittest
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agents_defs as A


def write(p, text):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


class AgentsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = os.path.realpath(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {"HOME": self.home, "DISPATCH_HOME": ""})
        self.env.start()
        d = f"{self.home}/.dispatch/agents"
        write(f"{d}/designer.md", "---\nname: designer\ndescription: looks\ntools: Read, Grep\nmodel: fable\neffort: max\n---\n\nReview screenshots.\n")
        write(f"{d}/opus-high.md", "---\nname: opus-high\nmodel: opus\neffort: high\n---\n\nDo the work.\n")
        write(f"{d}/writer.md", "---\nname: writer\ndescription: writes\nmodel: sonnet\n---\n\nWrite.\n")

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_set_key_keeps_other_lines(self):
        t = "---\nname: x\n# note\ntools: Read\n---\n\nbody\n"
        self.assertEqual(A.set_key(t, "effort", "low"), "---\nname: x\n# note\ntools: Read\neffort: low\n---\n\nbody\n")
        self.assertIn("effort: max", A.set_key(A.set_key(t, "effort", "low"), "effort", "max"))
        self.assertEqual(A.split(A.set_key(t, "effort", "low"))[0]["effort"], "low")

    def test_default_effort_only_touches_definitions_without_one(self):
        d = f"{self.home}/.dispatch/agents"
        res = A.apply_default("high")
        self.assertEqual([c["name"] for c in res["changed"]], ["writer"])
        self.assertIn("effort: high", read(f"{d}/writer.md"))
        self.assertIn("effort: max", read(f"{d}/designer.md"))
        # a new default moves the defaulted one along, never the explicit ones
        res = A.apply_default("low")
        self.assertEqual([(c["name"], c["from"], c["to"]) for c in res["changed"]], [("writer", "high", "low")])
        self.assertIn("effort: max", read(f"{d}/designer.md"))
        self.assertIn("effort: high", read(f"{d}/opus-high.md"))
        self.assertEqual(A.config()["default_effort"], "low")
        rows = {r["name"]: r for r in A.defs()}
        self.assertEqual((rows["writer"]["effort"], rows["writer"]["effort_source"]), ("low", "default"))
        self.assertEqual((rows["designer"]["effort"], rows["designer"]["effort_source"]), ("max", "own"))

    def test_every_write_keeps_a_backup(self):
        d = f"{self.home}/.dispatch/agents"
        before = read(f"{d}/writer.md")
        A.apply_default("low")
        bak = f"{self.home}/.dispatch/backups/agents"
        stamps = os.listdir(bak)
        self.assertEqual(len(stamps), 1)
        self.assertEqual(os.listdir(f"{bak}/{stamps[0]}"), ["writer.md"])
        self.assertEqual(read(f"{bak}/{stamps[0]}/writer.md"), before)
        self.assertEqual(sorted(os.listdir(d)), ["designer.md", "opus-high.md", "writer.md"])  # nothing extra where Claude looks
        self.assertEqual([r["name"] for r in A.defs()], ["designer", "opus-high", "writer"])

    def test_writes_through_a_claude_link(self):
        os.makedirs(f"{self.home}/.claude")
        os.symlink(f"{self.home}/.dispatch/agents", f"{self.home}/.claude/agents")
        A.apply_default("medium")
        self.assertIn("effort: medium", read(f"{self.home}/.claude/agents/writer.md"))

    def test_new_takes_the_default_and_rm_trashes(self):
        A.apply_default("low")
        r = A.new("reviewer", description="reviews diffs")
        self.assertIn("effort: low", read(r["file"]))
        A.apply_default("high")
        self.assertIn("effort: high", read(r["file"]))
        gone = A.remove("reviewer")
        self.assertFalse(os.path.exists(r["file"]))
        self.assertTrue(os.path.isfile(gone["trashed"]))
        with self.assertRaises(SystemExit):
            A.new("bad name")
        r = A.new("colon", description="Temporary: checks things")
        self.assertIn('description: "Temporary: checks things"', read(r["file"]))
        self.assertEqual(A.find_def("colon")["description"], "Temporary: checks things")

    def test_project_definitions_win_and_get_linked(self):
        proj = f"{self.home}/proj"
        A.new("designer", description="project designer", project=proj)
        link = f"{proj}/.claude/agents/designer.md"
        self.assertTrue(os.path.islink(link))
        self.assertEqual(os.readlink(link), "../../.dispatch/agents/designer.md")
        self.assertIn("project designer", read(link))
        r = A.find_def("designer", proj)
        self.assertEqual(r["scope"], "project")
        self.assertTrue([x for x in A.defs(proj) if x["name"] == "designer" and x["scope"] == "user"][0]["shadowed"])

    def test_run_starts_a_codex_session_with_the_role(self):
        seen = {}

        def runner(argv, **kw):
            seen["argv"] = argv

            class P:
                returncode = 0
                stdout = json.dumps({"session": "codex:abc", "status": "idle", "output": "Done. See /tmp/x.png"})
                stderr = ""
            return P()

        before = open(f"{self.home}/.dispatch/agents/designer.md", "rb").read()
        res = A.run("designer", "Review the Agents page", runner=runner)
        # running a definition never rewrites it
        self.assertEqual(open(f"{self.home}/.dispatch/agents/designer.md", "rb").read(), before)
        self.assertFalse(os.path.exists(f"{self.home}/.dispatch/backups"))
        argv = seen["argv"]
        self.assertEqual(argv[2:5], ["agent", "start", "codex"])
        prompt = argv[argv.index("--prompt") + 1]
        self.assertIn("Review screenshots.", prompt)
        self.assertIn("Review the Agents page", prompt)
        self.assertNotIn("--model", argv)  # fable is a Claude alias: Codex keeps its own
        self.assertEqual(argv[argv.index("--extra") + 1], "--effort xhigh")
        self.assertTrue(res["cwd"].startswith(f"{self.home}/.dispatch/chats/agent-designer-"))
        self.assertIn("Done. See /tmp/x.png", read(res["result_file"]))
        self.assertEqual(res["session"], "codex:abc")


if __name__ == "__main__":
    unittest.main()
