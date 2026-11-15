"""dispatch skills find: pool first, then skills.sh (gh search when skills.sh is down)."""
import json, os, sys, unittest

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import skills_find as F

ROWS = [
    {"name": "pdf", "description": "Create or merge PDF files", "in_pool": True, "agents": {"claude": False, "codex": True}, "path": "/p/pdf"},
    {"name": "pdf-ingestion", "description": "Extract text from PDF", "in_pool": True, "agents": {"claude": True, "codex": True}, "path": "/p/pdf-ingestion"},
    {"name": "humanizer", "description": "Make text sound human", "in_pool": False, "agents": {"claude": True, "codex": False}, "path": "/a/humanizer"},
]


def fake_fetch(url, timeout=12):
    assert "q=pdf" in url
    return {"skills": [
        {"source": "anthropics/skills", "skillId": "pdf", "name": "pdf", "installs": 200000},
        {"source": "someone/tools", "skillId": "pdf-to-docx", "name": "pdf-to-docx", "installs": 50},
        {"source": "someone/tools", "skillId": "pdf-to-docx", "name": "pdf-to-docx", "installs": 40},
        {"source": "not a repo", "skillId": "bad", "name": "bad"},
    ]}


class FindTest(unittest.TestCase):
    def test_local_matches_every_word_and_ranks_prefix_first(self):
        hits = F.local(ROWS, "pdf")
        self.assertEqual([h["name"] for h in hits], ["pdf", "pdf-ingestion"])
        self.assertEqual(F.local(ROWS, "extract pdf")[0]["name"], "pdf-ingestion")
        self.assertEqual(F.local(ROWS, "human")[0]["source"], "local")

    def test_online_marks_what_the_pool_has(self):
        res = F.find("pdf", ROWS, fetch=fake_fetch)
        self.assertEqual(res["online_source"], "skills.sh")
        self.assertEqual([(r["name"], r["installed"]) for r in res["online"]], [("pdf", True), ("pdf-to-docx", False)])
        self.assertEqual(res["online"][1]["repo"], "someone/tools")

    def test_falls_back_to_gh_when_skills_sh_is_down(self):
        def down(url, timeout=12):
            raise OSError("offline")

        class R:
            returncode = 0
            stdout = json.dumps([{"repository": {"nameWithOwner": "me/skills"}, "path": "skills/pdf-tool/SKILL.md"}])

        res = F.find("pdf", ROWS, fetch=down, run=lambda *a, **k: R())
        if F.shutil.which("gh"):
            self.assertEqual(res["online_source"], "github")
            self.assertEqual(res["online"][0]["subpath"], "skills/pdf-tool")
        self.assertIn("offline", res["error"])

    def test_local_only(self):
        res = F.find("pdf", ROWS, online=False, fetch=fake_fetch)
        self.assertEqual(res["online"], [])


if __name__ == "__main__":
    unittest.main()
