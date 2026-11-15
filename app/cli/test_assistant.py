# -*- coding: utf-8 -*-
"""assistant.py: the cross-project Assistant's folder, instructions and session."""
import json
import os
import sys
import tempfile
import time
import unittest
import unittest.mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import assistant as A  # noqa: E402


class Assistant(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self._home = os.environ.get("HOME")
        os.environ["HOME"] = self.home
        self._scan = A.from_catalog
        A.from_catalog = lambda path: None  # no Agents window in tests

    def tearDown(self):
        os.environ["HOME"] = self._home
        A.from_catalog = self._scan

    def test_ensure_creates_folder_instructions_and_links_once(self):
        r = A.ensure()
        f = os.path.join(self.home, ".dispatch", "assistant")
        self.assertEqual(r["folder"], f)
        self.assertEqual(set(r["created"]), {"folder", "ASSISTANT.md", "CLAUDE.md", "AGENTS.md"})
        self.assertEqual(os.readlink(os.path.join(f, "CLAUDE.md")), "ASSISTANT.md")
        self.assertIn("Do not edit project code", open(os.path.join(f, "AGENTS.md")).read())
        # the person's own edits are kept
        with open(r["instructions"], "w") as fh:
            fh.write("mine")
        self.assertEqual(A.ensure()["created"], [])
        self.assertEqual(open(r["instructions"]).read(), "mine")
        # nothing else under ~/.dispatch
        self.assertEqual(os.listdir(os.path.join(self.home, ".dispatch")), ["assistant"])

    def test_a_test_instance_has_its_own_assistant(self):
        """10-06: a test instance (its own DISPATCH_HOME, the person's HOME) opened the person's real Assistant
        conversations, because the folder was always ~/.dispatch/assistant. It follows DISPATCH_HOME now."""
        real = os.path.join(self.home, ".dispatch", "assistant")
        from engines import claude
        os.makedirs(claude.transcript_folder(A.home(), real))
        with open(os.path.join(claude.transcript_folder(A.home(), real), "theirs.jsonl"), "w") as fh:
            fh.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "what is left today"}]}}) + "\n")
        self.assertEqual(A.session_of(real)["id"], "theirs")
        inst = os.path.join(tempfile.mkdtemp(), "dispatch-home")
        with unittest.mock.patch.dict(os.environ, {"DISPATCH_HOME": inst}):
            self.assertEqual(A.folder(), os.path.join(inst, "assistant"))
            self.assertEqual(A.ensure()["folder"], os.path.join(inst, "assistant"))
            self.assertIsNone(A.session_of(A.folder()))
        self.assertFalse(os.path.exists(os.path.join(self.home, ".dispatch", "assistant", "ASSISTANT.md")))

    def test_quick_leaves_out_the_window_catalog(self):
        """A busy Mac took 20 s over the Agents window's catalog and the window timed out (10-11): its start asks without it."""
        f = A.ensure()["folder"]
        from engines import claude
        os.makedirs(claude.transcript_folder(A.home(), f))
        with open(os.path.join(claude.transcript_folder(A.home(), f), "mine.jsonl"), "w") as fh:
            fh.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "done"}]}}) + "\n")
        asked = []
        A.from_catalog = lambda path: asked.append(path)
        s = A.session_of(f, catalog=False)
        self.assertEqual(asked, [])
        self.assertEqual((s["id"], s["last"]), ("mine", "done"))
        A.session_of(f)
        self.assertEqual(asked, [f])

    def test_claude_transcripts_follow_claude_config_dir(self):
        with unittest.mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": "/x/claude"}):
            from engines import claude
            self.assertEqual(claude.transcript_folder("/home", "/a/b"), "/x/claude/projects/-a-b")

    def test_claude_project_dir(self):
        from engines import claude
        self.assertEqual(claude.folder_name("/Users/me/.dispatch/assistant"), "-Users-me--dispatch-assistant")

    def test_session_from_claude_transcript(self):
        f = A.ensure()["folder"]
        from engines import claude
        d = os.path.join(A.home(), ".claude", "projects", claude.folder_name(f))
        os.makedirs(d)
        lines = [
            {"type": "user", "message": {"role": "user", "content": "find the ReDraft doc"}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "Found it:\n/Users/me/Projects/redraft/docs/plan.md"}]}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {}}]}},
        ]
        with open(os.path.join(d, "abc-123.jsonl"), "w") as fh:
            fh.write("\n".join(json.dumps(x) for x in lines) + "\n")
        s = A.session_of(f)
        self.assertEqual((s["id"], s["agent"], s["resource"]), ("abc-123", "claude-code", "claude:/abc-123"))
        self.assertEqual(s["status"], "working")
        self.assertEqual(s["last"], "Found it: /Users/me/Projects/redraft/docs/plan.md")
        self.assertEqual(A.session_of(f, now=time.time() + 3600)["status"], "idle")

    def test_plain(self):
        self.assertEqual(A.plain("**Found** `DESIGN.md` in [kanban](/Users/me/k)"), "Found DESIGN.md in kanban")
        self.assertEqual(A.plain("## Title\n- item one\n1. two"), "Title\nitem one\ntwo")
        self.assertEqual(A.plain("snake_case_name stays"), "snake_case_name stays")

    def test_no_session(self):
        self.assertIsNone(A.session_of(A.ensure()["folder"]))


if __name__ == "__main__":
    unittest.main()


class OldDefaults(unittest.TestCase):
    def test_an_unedited_old_default_is_replaced_and_an_edited_one_kept(self):
        import hashlib, tempfile
        with tempfile.TemporaryDirectory() as d:
            md = os.path.join(d, "ASSISTANT.md")
            open(md, "w", encoding="utf-8").write("old default text")
            with unittest.mock.patch.object(A, "OLD_DEFAULTS", {hashlib.sha256(b"old default text").hexdigest()}):
                A.ensure(d)
                self.assertEqual(open(md, encoding="utf-8").read(), A.INSTRUCTIONS)
                open(md, "w", encoding="utf-8").write("the person's own text")
                A.ensure(d)
                self.assertEqual(open(md, encoding="utf-8").read(), "the person's own text")


class Instructions(unittest.TestCase):
    PREVIOUS_DEFAULT = "b6d5f3875cf9002efa010bea48ce8e3c7b4721a8bb1806b46d5ef6168f3267aa"  # the text before the board-dedupe and folder rules
    OLDER_DEFAULT = "2f55d4214614e70a4ca7216bd87e4a678e739693c9234157e32ce86337378b2c"

    def test_the_previous_default_is_upgraded_and_the_current_one_is_not_listed(self):
        import hashlib
        self.assertIn(self.PREVIOUS_DEFAULT, A.OLD_DEFAULTS)
        self.assertIn(self.OLDER_DEFAULT, A.OLD_DEFAULTS)
        self.assertNotIn(hashlib.sha256(A.INSTRUCTIONS.encode()).hexdigest(), A.OLD_DEFAULTS)

    def test_it_uses_the_relay_and_survey_commands_and_asks_before_adding(self):
        t = A.INSTRUCTIONS
        for cmd in ("dispatch assistant overview", "dispatch assistant turns", "dispatch assistant send", "dispatch assistant survey", "dispatch begin"):
            self.assertIn(cmd, t)
        self.assertIn("Never add before they say yes", t)
        self.assertIn("From Assistant", t)
        self.assertIn("terminal cannot be typed into", t)
        self.assertNotIn("—", t)  # no em dash anywhere

    def test_what_dispatch_noted_is_not_added_again(self):
        """task-b83p: the rules told the Assistant to add later things itself, so they were on the board twice."""
        t = A.INSTRUCTIONS
        self.assertIn("Dispatch's notes for you", t)
        self.assertIn("that you found yourself (not something they said)", t)
        self.assertIn("9c1a128e083f74d454551984687e0ec34694cc37dbfbad31556b83a7f62ca6a1", A.OLD_DEFAULTS)

    def test_suggestions_are_plain_and_one_needs_the_person(self):
        s = A.SUGGESTIONS
        self.assertEqual([x["id"] for x in s], ["unfinished", "running", "connect"])
        self.assertEqual([x["send"] for x in s], [True, True, False])
        for x in s:
            self.assertTrue(x["title"] and x["description"] and x["prompt"])
            self.assertFalse(any(w in (x["title"] + x["description"]).lower() for w in ("cli", "daemon", "chatd", "worktree", "path")))
        self.assertIn(s[2]["placeholder"], s[2]["prompt"])

    def test_status_carries_the_welcome(self):
        self.assertEqual(A.welcome(None), {"fresh": True, "suggestions": A.SUGGESTIONS})
        self.assertFalse(A.welcome({"id": "x"})["fresh"])


class CommandLine(unittest.TestCase):
    def test_the_ops_parse_and_look_only_reads(self):
        import subprocess
        d = tempfile.mkdtemp()
        env = dict(os.environ, HOME=d, DISPATCH_DIR=os.path.join(d, "state"))
        r = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "assistant", "look", d, "--json"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr[-400:])
        self.assertFalse(json.loads(r.stdout)["is_project"])
        # the window's start: the same answer without the catalog
        r = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "assistant", "--json", "--quick"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr[-400:])
        quick = json.loads(r.stdout)
        self.assertTrue(quick["fresh"])
        self.assertEqual(quick["folder"], os.path.join(d, ".dispatch", "assistant"))
        r = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "assistant", "send", "-h"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr[-400:])
        r = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "assistant", "add", "--project", "x", "--desc", "y", "--thing", "z"], capture_output=True, text=True, env=env, timeout=60)
        self.assertIn('dispatch assistant add "<task title>"', r.stderr)  # flags parse; no title, nothing filed
