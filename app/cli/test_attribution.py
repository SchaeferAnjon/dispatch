# -*- coding: utf-8 -*-
"""dispatch attribution: marks at the start and end of agent turns, the editor's record of your typing, who wrote
each line (the agent, you, the agent then you, unsure, something else, before the record), the note for the agent's
next turn, the hooks."""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import attribution as A  # noqa: E402

WINDOWS_READY = False  # flock and git paths; the hooks it serves are POSIX shells


def git(root, *args):
    subprocess.run(["git", "-C", root] + list(args), check=True, capture_output=True,
                   env=dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t"))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = os.path.join(self.tmp.name, "dispatch")
        env = mock.patch.dict(os.environ, {"DISPATCH_DIR": self.base})
        env.start()
        self.addCleanup(env.stop)
        self.root = os.path.realpath(os.path.join(self.tmp.name, "proj"))
        os.mkdir(self.root)
        git(self.root, "init", "-q")
        self.write("app.py", "import os\n\nRED = 1\n")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "init")
        self.t = 1000.0

    def write(self, rel, text):
        full = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(text)
        return full

    def tick(self, s=10):
        self.t += s
        return self.t

    def mark(self, event, session="s1", agent="claude-code", text="do it"):
        return A.mark(self.root, event, agent, session, text=text, now=self.tick())

    def who(self, rel="app.py", now=None):
        b = A.blame(os.path.join(self.root, rel), now=now if now is not None else self.tick())
        return [i["who"] for i in b["lines"]], b

    def agent_turn(self, text, session="s1", agent="claude-code", rel="app.py"):
        self.mark("start", session, agent)
        self.write(rel, text)
        self.mark("end", session, agent)

    def edit(self, rel, text, root=None, gap=10):
        """You change the file in Dispatch's editor and save it: the editor records what it had when you began
        typing and what you saved."""
        full = os.path.join(root or self.root, rel)
        try:
            with open(full, encoding="utf-8") as f:
                before = f.read()
        except OSError:
            before = ""
        since = self.tick()
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(text)
        A.edit(full, before, text, since, self.tick(gap), now=self.t)
        return full


class Marks(Base):
    def test_a_mark_keeps_the_changed_files_and_the_head(self):
        self.write("app.py", "import os\n\nRED = 2\n")
        self.write("new/dir/x.txt", "hi\n")
        r = self.mark("start")
        self.assertTrue(r["marked"])
        self.assertEqual(r["turn"], 1)
        m = A.load_marks(A.store_dir(self.root))[-1]
        self.assertEqual(set(m["files"]), {"app.py", "new/dir/x.txt"})
        self.assertEqual(A.get_blob(A.store_dir(self.root), m["files"]["app.py"]), b"import os\n\nRED = 2\n")
        self.assertEqual(len(m["head"]), 40)
        self.assertEqual(m["session"], "claude-code:s1")
        self.assertEqual(m["text"], "do it")

    def test_a_long_message_is_cut_with_an_ellipsis(self):
        # Changes names a turn by its message and shows it whole on hover, so a cut one says so (task-92l8p)
        self.mark("start", text="  " + "x" * 300)
        kept = A.load_marks(A.store_dir(self.root))[-1]["text"]
        self.assertEqual(len(kept), A.TEXT_KEEP)
        self.assertTrue(kept.endswith("x…"))

    def test_turns_are_counted_per_session_and_a_repeat_is_skipped(self):
        self.mark("start")
        self.mark("end")
        r = self.mark("start")
        self.assertEqual(r["turn"], 2)
        again = A.mark(self.root, "start", "claude-code", "s1", now=self.t + 1)
        self.assertFalse(again["marked"])
        self.assertEqual(again["reason"], "duplicate")
        other = A.mark(self.root, "start", "codex", "t9", now=self.t + 1)
        self.assertTrue(other["marked"])
        self.assertEqual(other["turn"], 1)

    def test_a_deleted_file_is_none_and_a_binary_one_is_left_out(self):
        os.remove(os.path.join(self.root, "app.py"))
        with open(os.path.join(self.root, "img.bin"), "wb") as f:
            f.write(b"\0\1\2")
        self.mark("start")
        m = A.load_marks(A.store_dir(self.root))[-1]
        self.assertIsNone(m["files"]["app.py"])
        self.assertNotIn("img.bin", m["files"])

    def test_outside_git_and_the_home_folder_are_refused(self):
        plain = os.path.join(self.tmp.name, "plain")
        os.mkdir(plain)
        with self.assertRaises(A.AttrError) as e:
            A.mark(plain, "start", "claude-code", "s1")
        self.assertEqual(e.exception.code, "not_git")

    def test_an_agents_window_session_maps_to_the_agents_own_id(self):
        with mock.patch("ide_sessions.transcript_key", return_value="claude-code:sdk-1"):
            self.assertEqual(A.host_session_key("claude:/host-1"), ("claude-code", "sdk-1"))
        with mock.patch("ide_sessions.transcript_key", return_value=None) as tk:
            self.assertEqual(A.host_session_key("opencode:/ses_9"), ("opencode", "ses_9"))
            self.assertEqual(A.host_session_key("agent-host-claude:/h2"), ("claude-code", "h2"))
            tk.assert_called_with("claude:/h2")
        self.assertEqual(A.canonical_session("", "codex:abc"), ("codex", "abc"))

    def test_prune_drops_old_marks_and_their_blobs(self):
        self.write("app.py", "old\n")
        self.mark("start")
        d = A.store_dir(self.root)
        old_blob = A.load_marks(d)[-1]["files"]["app.py"]
        self.write("app.py", "new\n")
        A.mark(self.root, "end", "claude-code", "s1", now=self.t + A.KEEP_DAYS * 86400)
        r = A.prune(d, now=self.t + A.KEEP_DAYS * 86400 + 5)
        self.assertEqual(r["kept"], 1)
        self.assertIsNone(A.get_blob(d, old_blob))


class Who(Base):
    def test_lines_the_agent_wrote_carry_no_mark_and_yours_do(self):
        self.agent_turn("import os\n\nRED = 1\nINK = 2\nGAP = 34\n")
        self.edit("app.py", "import os\n\nRED = 1\nINK = 3\nGAP = 34\nmine = True\n")
        who, b = self.who()
        self.assertEqual(who, ["before", "before", "before", "mix", "ai", "you"])
        self.assertTrue(b["tracked"])
        self.assertEqual(b["agents"], ["Claude"])
        mix = b["lines"][3]
        self.assertEqual(mix["was"], "INK = 2")
        self.assertEqual(mix["ai"]["agent"], "claude-code")
        self.assertEqual(mix["ai"]["turn"], 1)

    def test_a_file_written_just_after_the_turn_ended_is_the_turns(self):
        # OpenCode's plugins write their state as the session goes idle, a moment after the window's end mark
        self.agent_turn("import os\n\nRED = 1\nA = 1\n")
        end = self.t
        full = self.write("state.txt", "next: go on\nwhy: idle\n")
        os.utime(full, (end + 2, end + 2))
        who, b = self.who("state.txt")
        self.assertEqual(who, ["ai", "ai"])
        self.assertTrue(b["lines"][0]["tail"])
        os.utime(full, (end + 30, end + 30))
        who, _ = self.who("state.txt")
        self.assertEqual(who, ["other", "other"])  # no editor saw it: not yours

    def test_a_late_write_seen_by_the_next_mark_is_still_the_turns(self):
        self.agent_turn("import os\n\nRED = 1\nA = 1\n")
        end = self.t
        full = self.write("state.txt", "next: go on\n")
        os.utime(full, (end + 1, end + 1))
        self.mark("start", "s1")  # the next turn's start keeps the file and when it was written
        self.mark("end", "s1")
        who, _ = self.who("state.txt")
        self.assertEqual(who, ["ai"])
        self.tick(60)
        self.edit("app.py", "import os\n\nRED = 1\nA = 2\n")  # your edit, long after
        who, _ = self.who()
        self.assertEqual(who[3], "mix")

    def test_changing_a_mixed_line_again_keeps_the_agents_text(self):
        self.agent_turn("import os\n\nRED = 1\nINK = 2\n")
        self.mark("start", "s2")
        self.mark("end", "s2")
        self.edit("app.py", "import os\n\nRED = 1\nINK = 3\n")
        self.mark("start", "s2")
        self.mark("end", "s2")
        self.edit("app.py", "import os\n\nRED = 1\nINK = 4\n")
        who, b = self.who()
        self.assertEqual(who[3], "mix")
        self.assertEqual(b["lines"][3]["was"], "INK = 2")

    def test_the_agent_writing_over_your_line_makes_it_the_agents(self):
        self.write("app.py", "import os\n\nRED = 9\n")
        self.agent_turn("import os\n\nRED = 9\nX = 1\n")
        self.write("app.py", "import os\n\nRED = 9\nX = 2\n")
        self.agent_turn("import os\n\nRED = 9\nX = 5\n")
        who, _ = self.who()
        self.assertEqual(who, ["before", "before", "before", "ai"])

    def test_your_change_between_turns_and_the_next_turn(self):
        self.agent_turn("import os\n\nRED = 1\nA = 1\n")
        self.edit("app.py", "import os\n\nRED = 1\nA = 1\nB = 2\n")
        self.agent_turn("import os\n\nRED = 1\nA = 1\nB = 2\nC = 3\n")
        who, b = self.who()
        self.assertEqual(who, ["before", "before", "before", "ai", "you", "ai"])
        self.assertEqual(b["lines"][5]["turn"], 2)

    def test_two_agents_at_once_is_unsure_and_one_agent_twice_is_that_agent(self):
        self.mark("start", "s1", "claude-code")
        self.mark("start", "c1", "codex")
        self.write("app.py", "import os\n\nRED = 1\nBOTH = 1\n")
        self.mark("end", "c1", "codex")
        self.mark("end", "s1", "claude-code")
        who, b = self.who()
        self.assertEqual(who[3], "unsure")
        self.assertEqual(b["lines"][3]["agents"], ["Claude", "Codex"])
        self.mark("start", "s1")
        self.mark("start", "s2")
        self.write("app.py", "import os\n\nRED = 1\nBOTH = 1\nSAME = 1\n")
        self.mark("end", "s1")
        self.mark("end", "s2")
        who, b = self.who()
        self.assertEqual(who[4], "ai")
        self.assertTrue(b["lines"][4]["several"])

    def test_a_turn_still_running_owns_the_change_until_it_goes_stale(self):
        self.mark("start")
        self.write("app.py", "import os\n\nRED = 1\nLIVE = 1\n")
        who, _ = self.who(now=self.t + 60)
        self.assertEqual(who[3], "ai")
        who, _ = self.who(now=self.t + A.STALE_TURN + 60)
        self.assertEqual(who[3], "other")

    def test_a_commit_in_between_keeps_the_authors(self):
        self.agent_turn("import os\n\nRED = 1\nA = 1\n")
        git(self.root, "commit", "-qam", "agent work")
        self.mark("start", "s3")  # clean now: the content comes from HEAD
        self.mark("end", "s3")
        self.edit("app.py", "import os\n\nRED = 1\nA = 1\nB = 1\n")
        who, _ = self.who()
        self.assertEqual(who, ["before", "before", "before", "ai", "you"])

    def test_a_new_file_and_a_file_never_marked(self):
        self.agent_turn("made\nby agent\n", rel="new.txt")
        who, _ = self.who("new.txt")
        self.assertEqual(who, ["ai", "ai"])
        plain = tempfile.TemporaryDirectory()
        self.addCleanup(plain.cleanup)
        git(plain.name, "init", "-q")
        with open(os.path.join(plain.name, "f.txt"), "w") as f:
            f.write("x\n")
        b = A.blame(os.path.join(plain.name, "f.txt"))
        self.assertFalse(b["tracked"])
        self.assertEqual([i["who"] for i in b["lines"]], ["before"])

    def test_a_sessions_own_worktree_belongs_to_it_from_the_start(self):
        wt = os.path.join(self.tmp.name, "wt")
        git(self.root, "worktree", "add", "-q", "-b", "s-branch", wt)
        wt = os.path.realpath(wt)
        with open(os.path.join(wt, "app.py"), "a") as f:
            f.write("AGENT = 1\n")  # the agent wrote before the window could mark the start
        A.mark(wt, "end", "opencode", "w1", now=self.tick())
        self.edit("app.py", "import os\n\nRED = 1\nAGENT = 1\nMINE = 1\n", root=wt)
        b = A.blame(os.path.join(wt, "app.py"), now=self.tick())
        self.assertEqual([i["who"] for i in b["lines"]], ["before", "before", "before", "ai", "you"])
        self.assertTrue(A.load_marks(A.store_dir(wt))[0]["worktree"])
        # the main checkout gets no such start
        self.write("app.py", "import os\n\nRED = 1\nX = 1\n")
        self.mark("end", "m1")
        self.assertEqual(self.who()[0][3], "before")

    def test_runs_merge_lines_and_carry_the_details(self):
        self.agent_turn("import os\n\nRED = 1\nA = 1\nB = 1\nC = 1\n")
        self.edit("app.py", "import os\n\nRED = 1\nA = 1\nB = 2\nC = 1\nD = 1\nE = 1\n")
        out = A.show(os.path.join(self.root, "app.py"), now=self.tick())
        self.assertTrue(out["ok"])
        kinds = [(r["from"], r["to"], r["who"]) for r in out["runs"]]
        self.assertEqual(kinds, [(1, 3, "before"), (4, 4, "ai"), (5, 5, "mix"), (6, 6, "ai"), (7, 8, "you")])
        mix = out["runs"][2]
        self.assertEqual((mix["agent"], mix["was"], mix["turn"], mix["text"]), ("Claude", "B = 1", 1, "do it"))
        self.assertEqual(out["counts"], {"ai": 2, "you": 2, "mix": 1, "unsure": 0, "other": 0, "before": 3})


class ThreeKinds(Base):
    """Who changed a line when no agent's turn was open: you only when Dispatch's editor saw you type and save it;
    a tool, a script, git or another app ("other") gets no person and is not passed on to the agent (task-m6hek)."""

    def test_the_agent_your_editor_and_a_script_in_one_project(self):
        self.agent_turn("import os\n\nRED = 1\nAGENT = 1\n")
        # a tool writes its own file and appends to the agent's file, nobody typing
        self.tick(30)
        self.write(".beads/hooks/post-commit", "#!/bin/sh\n# bd\nexec bd hook post-commit\n")
        with open(os.path.join(self.root, "app.py"), "a") as f:
            f.write("TOOL = 1\n")
        # you type a line in the editor and save
        self.edit("app.py", "import os\n\nRED = 1\nAGENT = 1\nTOOL = 1\nMINE = 1\n")
        who, b = self.who()
        self.assertEqual(who, ["before", "before", "before", "ai", "other", "you"])
        self.assertEqual(self.who(".beads/hooks/post-commit")[0], ["other", "other", "other"])
        # the agent's next turn hears about your line only
        n = A.note(self.root, "claude-code", "s1", now=self.tick())
        self.assertEqual(n["files"], [{"path": "app.py", "lines": "6", "count": 1}])
        out = A.show(os.path.join(self.root, ".beads/hooks/post-commit"), now=self.tick())
        self.assertEqual([(r["from"], r["to"], r["who"]) for r in out["runs"]], [(1, 3, "other")])
        self.assertNotIn("ts", out["runs"][0])  # a file's time says when, not who
        self.assertNotIn("told", out["runs"][0])
        self.assertEqual(out["counts"]["you"], 0)
        self.assertEqual(A.files([os.path.join(self.root, ".beads/hooks/post-commit")])["files"][os.path.join(self.root, ".beads/hooks/post-commit")]["counts"]["other"], 3)

    def test_a_record_kept_before_the_editors_reads_the_new_way(self):
        # what 0.9.2 kept for the hook scripts bd wrote: marks only, the files new between two turns
        self.agent_turn("import os\n\nRED = 1\nA = 1\n")
        self.write(".beads/hooks/pre-push", "#!/bin/sh\nexec bd hook pre-push\n")
        self.write("app.py", "import os\n\nRED = 1\nA = 2\n")
        self.mark("start")  # the next turn: the old CLI told Claude to keep these
        self.mark("end")
        self.assertFalse(os.path.exists(os.path.join(A.store_dir(self.root), "edits.jsonl")))
        self.assertEqual(self.who(".beads/hooks/pre-push")[0], ["other", "other"])
        self.assertEqual(self.who()[0][3], "other")
        steps = A.steps(self.root, "claude-code", "s1", now=self.tick())
        self.assertEqual(steps["yours"], [])
        self.mark("end")
        self.assertEqual(A.note(self.root, "claude-code", "s1", now=self.tick())["text"], "")

    def test_a_save_begun_long_before_is_not_yours(self):
        self.agent_turn("import os\n\nRED = 1\nA = 1\n")
        self.edit("app.py", "import os\n\nRED = 1\nA = 1\nD = 1\n", gap=A.EDIT_GAP + 10)
        self.assertEqual(self.who()[0][4], "other")

    def test_the_editors_clock_orders_a_save_that_arrives_late(self):
        # the window's answer can take seconds on a busy Mac: the record is placed by when you began and saved
        self.agent_turn("import os\n\nRED = 1\nA = 1\n")
        full = os.path.join(self.root, "app.py")
        began, saved = self.tick(), self.tick()
        self.write("app.py", "import os\n\nRED = 1\nA = 1\nMINE = 1\n")
        self.agent_turn("import os\n\nRED = 1\nA = 1\nMINE = 1\nNEXT = 1\n")  # the next turn, before the record lands
        A.edit(full, "import os\n\nRED = 1\nA = 1\n", "import os\n\nRED = 1\nA = 1\nMINE = 1\n", began, saved, now=self.tick())
        self.assertEqual(self.who()[0][3:], ["ai", "you", "ai"])

    def test_what_changed_before_you_began_is_not_yours(self):
        self.agent_turn("import os\n\nRED = 1\nA = 1\n")
        self.write("app.py", "import os\n\nRED = 1\nA = 1\nGEN = 1\n")  # a script, before you start typing
        self.edit("app.py", "import os\n\nRED = 1\nA = 1\nGEN = 1\nMINE = 1\n")
        self.assertEqual(self.who()[0][3:], ["ai", "other", "you"])

    def test_your_save_while_an_agents_turn_runs_is_yours(self):
        self.mark("start")
        self.write("app.py", "import os\n\nRED = 1\nAGENT = 1\n")
        self.edit("app.py", "import os\n\nRED = 1\nAGENT = 1\nMINE = 1\n")
        self.mark("end")
        self.assertEqual(self.who()[0][3:], ["ai", "you"])

    def test_the_editor_record_checks_what_it_is_given(self):
        full = os.path.join(self.root, "app.py")
        now = time.time()
        for args in ((None, "x", now - 5, now), ("x", "y", now, now - 5), ("x", "y", now, now + 3600), ("x", "y", 0, now)):
            with self.assertRaises(A.AttrError) as e:
                A.edit(full, *args)
            self.assertEqual(e.exception.code, "bad_request")
        self.assertEqual(A.edit(full, "a\n", "a\0b", now - 5, now)["reason"], "not_text")
        with self.assertRaises(A.AttrError):
            A.edit(os.path.join(self.root, ".git", "config"), "a", "b", now - 5, now)
        plain = tempfile.TemporaryDirectory()
        self.addCleanup(plain.cleanup)
        with open(os.path.join(plain.name, "f.txt"), "w") as f:
            f.write("x\n")
        with self.assertRaises(A.AttrError) as e:
            A.edit(os.path.join(plain.name, "f.txt"), "x\n", "y\n", now - 5, now)
        self.assertEqual(e.exception.code, "not_git")

    def test_prune_keeps_the_editors_record_and_its_blobs(self):
        self.agent_turn("import os\n\nRED = 1\nA = 1\n")
        d = A.store_dir(self.root)
        old = self.edit("app.py", "old edit\n")
        old_sha = A.load_edits(d)[0]["base"]  # what you began from: the agent's version, kept by nothing newer
        self.tick(A.KEEP_DAYS * 86400)
        self.mark("start")
        self.edit("app.py", "new edit\n")
        new_sha = A.load_edits(d)[-1]["sha"]
        A.prune(d, now=self.tick())
        self.assertEqual(len(A.load_edits(d)), 1)
        self.assertIsNone(A.get_blob(d, old_sha))
        self.assertEqual(A.get_blob(d, new_sha), b"new edit\n")
        self.assertTrue(os.path.exists(old))


class Note(Base):
    def test_the_next_turn_hears_about_your_lines(self):
        self.agent_turn("import os\n\nRED = 1\nA = 1\nB = 1\n")
        self.edit("app.py", "import os\n\nRED = 1\nA = 7\nB = 1\nC = 1\nD = 1\n")
        n = A.note(self.root, "claude-code", "s1", now=self.tick())
        self.assertEqual(n["files"], [{"path": "app.py", "lines": "4, 6-7", "count": 3}])
        self.assertIn("app.py (lines 4, 6-7)", n["text"])
        self.assertIn("Keep their changes", n["text"])

    def test_nothing_to_say_without_a_change_or_a_turn(self):
        self.assertEqual(A.note(self.root, "claude-code", "s1")["text"], "")
        self.agent_turn("import os\n\nRED = 1\nA = 1\n")
        self.assertEqual(A.note(self.root, "claude-code", "s1", now=self.tick())["text"], "")
        # another agent's turn changing the file is not yours
        self.agent_turn("import os\n\nRED = 1\nA = 1\nZ = 1\n", session="c1", agent="codex")
        self.assertEqual(A.note(self.root, "claude-code", "s1", now=self.tick())["text"], "")


class Steps(Base):
    """The session's turns and your changes between them: the chat's rows and its commit card."""

    def setUp(self):
        super().setUp()
        self.t = time.time() - 3600  # marks and file times on one clock: your edits are told by when you saved

    def saved(self, rel, text, at):
        full = self.write(rel, text)
        os.utime(full, (at, at))
        return full

    def hand(self, rel, text, at):
        """You change the file in Dispatch's editor and save it at `at`."""
        full = os.path.join(self.root, rel)
        with open(full, encoding="utf-8") as f:
            before = f.read()
        self.saved(rel, text, at)
        A.edit(full, before, text, at - 5, at, now=at)
        return full

    def start(self, source="hook", session="s1", agent="claude-code", gap=10):
        return A.mark(self.root, "start", agent, session, text="go", now=self.tick(gap), source=source)

    def end(self, source="hook", session="s1", agent="claude-code"):
        return A.mark(self.root, "end", agent, session, now=self.tick(), source=source)

    def read(self, p):
        with open(p, encoding="utf-8") as f:
            return f.read()

    def test_a_turn_marked_first_by_the_window_keeps_your_message_from_the_plugin(self):
        # the window marks the start without your message, OpenCode's plugin then with it (task-92l8p)
        A.mark(self.root, "start", "opencode", "s1", text="", now=self.tick(10), source="window")
        A.mark(self.root, "start", "opencode", "s1", text="Fix the login button", now=self.tick(10), source="plugin")
        self.saved("app.py", "import os\n\nRED = 1\nA = 1\n", self.tick(2))
        self.end(agent="opencode")
        s = A.steps(self.root, "opencode", "s1", now=self.tick())
        self.assertEqual([t["text"] for t in s["turns"]], ["Fix the login button"])
        b = A.blame(os.path.join(self.root, "app.py"), now=self.tick())
        self.assertEqual(b["lines"][-1]["text"], "Fix the login button")

    def test_a_turn_shows_as_two_versions_and_your_lines_after_it(self):
        self.start()
        self.saved("app.py", "import os\n\nRED = 1\nA = 1\nB = 1\n", self.tick(2))
        self.end()
        edited = self.tick(30)
        self.hand("app.py", "import os\n\nRED = 1\nA = 7\nB = 1\nMINE = 1\n", edited)
        s = A.steps(self.root, "claude-code", "s1", now=self.tick())
        self.assertEqual(len(s["turns"]), 1)
        t = s["turns"][0]
        self.assertEqual((t["n"], t["agent"], t["added"], t["removed"]), (1, "Claude", 2, 0))
        f = t["files"][0]
        self.assertEqual(f["rel"], "app.py")
        self.assertEqual(self.read(f["before"]), "import os\n\nRED = 1\n")
        self.assertEqual(self.read(f["after"]), "import os\n\nRED = 1\nA = 1\nB = 1\n")
        self.assertTrue(f["after"].endswith("/app.py"))
        y = s["yours"][0]
        self.assertEqual((y["after_turn"], y["count"], y["told"], y["until"]), (1, 2, "", None))
        self.assertEqual(y["anchor"], t["end"])
        self.assertAlmostEqual(y["ts"], edited, places=2)
        yf = y["files"][0]
        self.assertEqual((yf["lines"], yf["first"], yf["after"]), ("4, 6", 4, os.path.join(self.root, "app.py")))
        self.assertEqual(self.read(yf["before"]), "import os\n\nRED = 1\nA = 1\nB = 1\n")

    def test_the_next_turn_closes_your_changes_and_says_who_was_told(self):
        self.start()
        self.saved("app.py", "import os\n\nRED = 1\nA = 1\n", self.tick(2))
        self.end()
        self.hand("app.py", "import os\n\nRED = 1\nA = 2\n", self.tick(30))
        self.start(source="window")
        self.start(source="hook", gap=1)  # the hook that passes the note on marks the same turn
        marks = A.load_marks(A.store_dir(self.root))
        self.assertEqual([(m["event"], m["turn"], m.get("dup", False)) for m in marks][-2:], [("start", 2, False), ("start", 2, True)])
        self.saved("app.py", "import os\n\nRED = 1\nA = 2\nB = 1\n", self.tick(2))
        self.end()
        s = A.steps(self.root, "claude-code", "s1", now=self.tick())
        self.assertEqual([t["n"] for t in s["turns"]], [1, 2])
        y = s["yours"]
        self.assertEqual(len(y), 1)
        self.assertEqual((y[0]["after_turn"], y[0]["count"], y[0]["told"], y[0]["next_turn"]), (1, 1, "Claude", 2))
        f = y[0]["files"][0]
        self.assertNotEqual(f["after"], os.path.join(self.root, "app.py"))  # the version the next turn started from
        self.assertEqual(self.read(f["after"]), "import os\n\nRED = 1\nA = 2\n")
        self.assertEqual(f["lines"], "4")

    def test_a_commit_in_a_turn_counts_the_lines_you_had_changed(self):
        self.start()
        self.saved("app.py", "import os\n\nRED = 1\nA = 1\nB = 1\n", self.tick(2))
        self.end()
        self.hand("app.py", "import os\n\nRED = 1\nA = 9\nB = 1\nMINE = 1\n", self.tick(30))
        self.start()
        self.saved("app.py", "import os\n\nRED = 1\nA = 9\nB = 1\nMINE = 1\nC = 1\n", self.tick(2))
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "Add letters")
        self.end()
        s = A.steps(self.root, "claude-code", "s1", now=self.tick())
        c = s["turns"][1]["commits"]
        self.assertEqual(len(c), 1)
        self.assertEqual((c[0]["subject"], c[0]["yours"], c[0]["agent"]), ("Add letters", 2, "Claude"))
        self.assertEqual(len(c[0]["short"]), 7)
        self.assertEqual(s["turns"][0]["commits"], [])
        # the turn's own diff still shows across the commit
        self.assertEqual(s["turns"][1]["files"][0]["added"], 1)

    def commit_at(self, at, message):
        env = dict(os.environ, GIT_COMMITTER_DATE="@%d +0000" % int(at), GIT_AUTHOR_DATE="@%d +0000" % int(at),
                   GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        subprocess.run(["git", "-C", self.root, "add", "-A"], check=True, env=env)
        subprocess.run(["git", "-C", self.root, "commit", "-q", "-m", message], check=True, env=env)

    def test_a_commit_you_made_yourself_gets_its_card_with_who_wrote_its_lines(self):
        self.start()
        self.saved("app.py", "import os\n\nRED = 1\nA = 1\nB = 1\nC = 1\n", self.tick(2))
        self.end()
        self.hand("app.py", "import os\n\nRED = 1\nA = 1\nB = 7\nC = 1\n", self.tick(30))
        self.commit_at(self.tick(20), "Letters, by hand")  # the Changes or Source Control commit button
        s = A.steps(self.root, "claude-code", "s1", now=self.tick())
        t = s["turns"][0]
        self.assertEqual(t["commits"], [])  # not the agent's
        own = t["own_commits"]
        self.assertEqual(len(own), 1)
        c = own[0]
        self.assertEqual((c["subject"], c["by"], c["yours"]), ("Letters, by hand", "you", 1))
        self.assertEqual(c["agents"], [{"agent": "Claude", "lines": 2}])
        self.assertEqual(c["message_by"], "")  # your own words
        # the Commit button: the default agent writes the message, you press the button
        self.hand("app.py", "import os\n\nRED = 1\nA = 1\nB = 7\nC = 2\n", self.tick(30))
        A.note_written(self.root, "Raise C to two", "opencode", now=self.tick(5))
        self.commit_at(self.tick(5), "Raise C to two")
        s = A.steps(self.root, "claude-code", "s1", now=self.tick())
        own = s["turns"][0]["own_commits"]
        self.assertEqual([(c["subject"], c["message_by"]) for c in own], [("Letters, by hand", ""), ("Raise C to two", "OpenCode")])
        # a commit made while an agent's turn ran (another session's) is that agent's, not yours
        self.start(session="c1", agent="codex")
        self.saved("app.py", "import os\n\nRED = 1\nA = 1\nB = 7\nC = 2\nD = 1\n", self.tick(2))
        self.commit_at(self.tick(2), "Codex adds D")
        self.end(session="c1", agent="codex")
        s = A.steps(self.root, "claude-code", "s1", now=self.tick())
        self.assertEqual([c["subject"] for c in s["turns"][0]["own_commits"]], ["Letters, by hand", "Raise C to two"])

    def test_the_delivery_page_line_counts_the_tasks_commits(self):
        self.start()
        self.saved("app.py", "import os\n\nRED = 1\nA = 1\nB = 1\nC = 1\n", self.tick(2))
        self.end()
        self.hand("app.py", "import os\n\nRED = 1\nA = 1\nB = 7\nC = 1\n", self.tick(30))
        self.commit_at(self.tick(20), "feat: letters (task-ab12)")
        import deliver
        pairs = deliver.task_commits("task-ab12", {"metadata": {}}, self.root)
        self.assertEqual(len(pairs), 1)
        self.assertEqual(A.delivery_line(pairs), {"agents": [{"agent": "Claude", "lines": 2}], "yours": 1, "commits": 1})
        self.assertIsNone(A.delivery_line([(self.root, "0" * 40)]))

    def test_a_turn_without_its_start_and_a_turn_still_running(self):
        self.saved("app.py", "import os\n\nRED = 1\nA = 1\n", self.tick(2))
        self.end(source="window")  # the window saw only the end
        self.start()
        s = A.steps(self.root, "claude-code", "s1", now=self.tick())
        self.assertEqual([(t["n"], t["start"] is None, t["end"] is None) for t in s["turns"]], [(1, True, False), (2, False, True)])
        self.assertEqual(s["turns"][0]["files"][0]["added"], 1)
        self.assertEqual(s["turns"][1]["files"], [])

    def test_other_sessions_and_the_agents_lines_are_not_yours(self):
        self.start()
        self.saved("app.py", "import os\n\nRED = 1\nA = 1\n", self.tick(2))
        self.end()
        self.start(session="c1", agent="codex")
        self.saved("app.py", "import os\n\nRED = 1\nA = 1\nZ = 1\n", self.tick(2))
        self.end(session="c1", agent="codex")
        s = A.steps(self.root, "claude-code", "s1", now=self.tick())
        self.assertEqual(s["yours"], [])
        self.assertEqual(len(s["turns"]), 1)

    def test_the_commit_line_is_asked_for_only_when_switched_on(self):
        self.assertEqual(A.load_config(), {"co_author": False})
        self.assertEqual(A.commit_line("claude-code"), "")
        self.assertEqual(A.turn_note(self.root, "opencode", "s9"), "")
        A.save_config({"co_author": True})
        self.assertIn("Co-authored-by: OpenCode <noreply@opencode.ai>", A.turn_note(self.root, "opencode", "s9"))
        self.assertIn("Co-authored-by: Claude <noreply@anthropic.com>", A.commit_line("claude"))
        out = A.hook_mark({"session_id": "s1", "cwd": self.root, "hook_event_name": "UserPromptSubmit", "prompt": "go"}, "codex", now=self.tick())
        self.assertIn("Co-authored-by: Codex", out["note"])
        A.save_config({"co_author": False, "bogus": True})
        self.assertEqual(A.load_config(), {"co_author": False})


class Hooks(Base):
    def test_prompt_marks_the_start_and_answers_the_note_stop_marks_the_end(self):
        base = {"session_id": "s1", "cwd": self.root}
        self.assertEqual(A.hook_mark(dict(base, hook_event_name="UserPromptSubmit", prompt="add a line"), "claude-code"), {"note": ""})
        self.write("app.py", "import os\n\nRED = 1\nNEW = 1\n")
        self.assertEqual(A.hook_mark(dict(base, hook_event_name="Stop"), "claude-code"), {})
        later = self.write("app.py", "import os\n\nRED = 1\nNEW = 2\n")
        os.utime(later, (time.time() + 30, time.time() + 30))  # you edit a while after the turn ended
        A.edit(later, "import os\n\nRED = 1\nNEW = 1\n", "import os\n\nRED = 1\nNEW = 2\n", time.time() + 25, time.time() + 30, now=time.time() + 30)
        out = A.hook_mark(dict(base, hook_event_name="UserPromptSubmit", prompt="next"), "claude-code")
        self.assertIn("app.py (line 4)", out["note"])
        marks = A.load_marks(A.store_dir(self.root))
        self.assertEqual([(m["event"], m["turn"], m["text"]) for m in marks], [("start", 1, "add a line"), ("end", 1, ""), ("start", 2, "next")])

    def test_your_line_says_which_agent_was_told(self):
        base = {"session_id": "s1", "cwd": self.root}
        A.hook_mark(dict(base, hook_event_name="UserPromptSubmit", prompt="go"), "claude-code", now=self.tick())
        self.write("app.py", "import os\n\nRED = 1\nNEW = 1\n")
        A.hook_mark(dict(base, hook_event_name="Stop"), "claude-code", now=self.tick())
        full = self.edit("app.py", "import os\n\nRED = 1\nNEW = 1\nMINE = 1\n")
        mine = [r for r in A.show(full, now=self.tick())["runs"] if r["who"] == "you"][0]
        self.assertEqual(mine["told"], "")
        A.hook_mark(dict(base, hook_event_name="UserPromptSubmit", prompt="next"), "claude-code", now=self.tick())
        mine = [r for r in A.show(full, now=self.tick())["runs"] if r["who"] == "you"][0]
        self.assertEqual(mine["told"], "Claude")
        self.assertEqual(A.load_marks(A.store_dir(self.root))[-1]["source"], "hook")

    def test_subagents_other_events_and_bad_folders_are_ignored(self):
        self.assertEqual(A.hook_mark({"session_id": "s1", "cwd": self.root, "hook_event_name": "PostToolUse"}, "claude-code"), {})
        self.assertEqual(A.hook_mark({"session_id": "s1", "cwd": self.root, "hook_event_name": "Stop", "agent_id": "x"}, "claude-code"), {})
        self.assertEqual(A.hook_mark({"session_id": "ses_1", "cwd": self.root, "hook_event_name": "Stop"}, "claude-code"), {})
        self.assertEqual(A.hook_mark({"session_id": "s1", "cwd": "/nope/nowhere", "hook_event_name": "Stop"}, "claude-code"), {})
        self.assertEqual(A.load_marks(A.store_dir(self.root)), [])

    def test_life_hook_puts_the_note_into_the_prompts_context(self):
        import life_hook
        out = life_hook.with_note({}, "NOTE", "UserPromptSubmit")
        self.assertEqual(out, {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "NOTE"}})
        merged = life_hook.with_note({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "life"}}, "NOTE", "UserPromptSubmit")
        self.assertEqual(merged["hookSpecificOutput"]["additionalContext"], "life\n\nNOTE")
        self.assertEqual(life_hook.with_note({"decision": "block"}, "NOTE", "Stop"), {"decision": "block"})
        with mock.patch.object(life_hook, "fast", return_value={}):
            stdin = io.StringIO(json.dumps({"session_id": "s1", "cwd": self.root, "hook_event_name": "UserPromptSubmit", "prompt": "go"}))
            buf = io.StringIO()
            with mock.patch("sys.stdin", stdin), redirect_stdout(buf):
                life_hook.main(["--agent", "claude-code"])
        self.assertEqual(json.loads(buf.getvalue()), {})
        self.assertEqual(A.load_marks(A.store_dir(self.root))[-1]["event"], "start")


class Cli(Base):
    def cli(self, *args):
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertEqual(A.main(list(args)), 0)
        return json.loads(buf.getvalue())

    def cli_edit(self, path, before, saved, late=30):
        """The window's `attribution edit`: began typing `late - 2` s and saved `late` s from now (a while after the turn)."""
        now = time.time()
        stdin = io.StringIO(json.dumps({"before": before, "saved": saved}))
        with mock.patch("sys.stdin", stdin):
            return self.cli("edit", "--file", path, "--since", str(now + late - 2), "--at", str(now + late))

    def test_mark_show_files_note(self):
        r = self.cli("mark", "--event", "start", "--agent", "codex", "--session", "t1", "--cwd", self.root, "--text", "go")
        self.assertTrue(r["marked"])
        self.write("app.py", "import os\n\nRED = 1\nX = 1\n")
        self.cli("mark", "--event", "end", "--agent", "codex", "--session", "t1", "--cwd", self.root)
        full = os.path.join(self.root, "app.py")
        self.write("app.py", "import os\n\nRED = 1\nX = 1\nY = 1\n")
        os.utime(full, (time.time() + 30, time.time() + 30))  # you edit a while after the turn ended
        self.assertEqual(self.cli_edit(full, "import os\n\nRED = 1\nX = 1\n", "import os\n\nRED = 1\nX = 1\nY = 1\n", 28)["path"], "app.py")
        shown = self.cli("show", full, "--json")
        self.assertEqual([r["who"] for r in shown["runs"]], ["before", "ai", "you"])
        self.assertEqual(shown["runs"][1]["agent"], "Codex")
        listed = self.cli("files", full, "--json")
        self.assertEqual(listed["files"][full]["counts"]["you"], 1)
        n = self.cli("mark", "--event", "start", "--agent", "codex", "--session", "t1", "--cwd", self.root, "--with-note")
        self.assertIn("app.py (line 5)", n["note"])
        steps = self.cli("steps", "--agent", "codex", "--session", "t1", "--cwd", self.root, "--json")
        self.assertEqual([t["n"] for t in steps["turns"]], [1, 2])
        self.assertEqual(self.cli("config", "--json"), {"ok": True, "co_author": False})
        self.assertEqual(self.cli("config", "--co-author", "on", "--json"), {"ok": True, "co_author": True})
        n2 = self.cli("mark", "--event", "start", "--agent", "codex", "--session", "t2", "--cwd", self.root, "--with-note")
        self.assertIn("Co-authored-by: Codex", n2["note"])
        self.assertEqual(self.cli("show")["error"], "bad_request")
        with mock.patch("sys.stdin", io.StringIO(json.dumps({"before": "a", "saved": "b"}))):
            late = self.cli("edit", "--file", full, "--since", str(time.time()), "--at", str(time.time() - 30))
        self.assertEqual(late["error"], "bad_request")  # saved before it was begun
        with mock.patch("sys.stdin", io.StringIO("not json")):
            self.assertEqual(self.cli("edit", "--file", full, "--since", "1", "--at", "2")["error"], "bad_request")
        self.assertEqual(self.cli("bogus")["error"], "bad_request")

    def first_turn_of_a_new_window_session(self, window_end):
        """A new OpenCode session in the Agents window: its start is marked before the window's records know
        OpenCode's ses_ id, its end (the plugin's, and the window's when `window_end`) after (task-dy6c)."""
        with mock.patch("ide_sessions.transcript_key", return_value=None):
            self.cli("mark", "--event", "start", "--host-session", "agent-host-opencode:/ba95", "--cwd", self.root)
        self.write("app.py", "import os\n\nRED = 1\nDELETE = 1\n")
        with mock.patch("ide_sessions.transcript_key", return_value="opencode:ses_7"):
            self.cli("mark", "--event", "end", "--agent", "opencode", "--session", "ses_7", "--cwd", self.root, "--source", "plugin")
            if window_end:
                time.sleep(0.01)
                self.cli("mark", "--event", "end", "--host-session", "agent-host-opencode:/ba95", "--cwd", self.root)
        full = os.path.join(self.root, "app.py")
        self.write("app.py", "import os\n\nRED = 1\nREMOVE = 1\n")
        os.utime(full, (time.time() + 30, time.time() + 30))  # you change the agent's line a while later
        self.cli_edit(full, "import os\n\nRED = 1\nDELETE = 1\n", "import os\n\nRED = 1\nREMOVE = 1\n")
        return full

    def test_your_line_after_a_new_window_sessions_first_turn_is_yours(self):
        for window_end in (True, False):
            with self.subTest(window_end=window_end):
                shutil.rmtree(A.store_dir(self.root), ignore_errors=True)
                git(self.root, "checkout", "-q", "--", "app.py")
                full = self.first_turn_of_a_new_window_session(window_end)
                with mock.patch("ide_sessions.transcript_key", return_value="opencode:ses_7"):
                    shown = self.cli("show", full, "--json")
                    steps = self.cli("steps", "--host-session", "agent-host-opencode:/ba95", "--cwd", self.root, "--json")
                self.assertEqual([r["who"] for r in shown["runs"]], ["before", "mix"])
                self.assertEqual(shown["runs"][1]["was"], "DELETE = 1")
                self.assertEqual([(t["n"], bool(t["end"])) for t in steps["turns"]], [(1, True)])
                marks = A.load_marks(A.store_dir(self.root))
                self.assertEqual((marks[0]["session"], marks[0]["host"]), ("opencode:ba95", "opencode:ba95"))  # as the window knew it

    def test_the_windows_end_right_after_the_plugins_joins_the_two_ids(self):
        # the window's end resolves to ses_ a moment after the plugin's: it is kept, and it is what joins them,
        # so the answer is right even while the window's records cannot name the session yet
        t = time.time()
        with mock.patch("ide_sessions.transcript_key", return_value=None):
            A.mark(self.root, "start", "opencode", "ba95", now=t, source="window", host="opencode:ba95", host_uri="opencode:/ba95")
        self.write("app.py", "import os\n\nRED = 1\nDELETE = 1\n")
        A.mark(self.root, "end", "opencode", "ses_7", now=t + 10, source="plugin")
        r = A.mark(self.root, "end", "opencode", "ses_7", now=t + 11, source="window", host="opencode:ba95", host_uri="opencode:/ba95")
        self.assertTrue(r["marked"])
        full = os.path.join(self.root, "app.py")
        self.write("app.py", "import os\n\nRED = 1\nREMOVE = 1\n")
        os.utime(full, (t + 60, t + 60))
        A.edit(full, "import os\n\nRED = 1\nDELETE = 1\n", "import os\n\nRED = 1\nREMOVE = 1\n", t + 55, t + 60, now=t + 60)
        with mock.patch("ide_sessions.transcript_key", return_value=None):
            shown = self.cli("show", full, "--json")
            steps = self.cli("steps", "--agent", "opencode", "--session", "ses_7", "--cwd", self.root, "--json")
        self.assertEqual([r["who"] for r in shown["runs"]], ["before", "mix"])
        self.assertEqual([(t["n"], bool(t["end"])) for t in steps["turns"]], [(1, True)])
        # a plain repeat (no ids to join) is still dropped
        again = A.mark(self.root, "end", "opencode", "ses_7", now=t + 12, source="window", host="opencode:ses_7")
        self.assertFalse(again["marked"])

    def test_dispatch_hands_the_command_to_the_module(self):
        import dispatch
        self.assertEqual(dispatch.DELEGATED["attribution"], "attribution")
        with open(os.path.join(HERE, "bundle.json"), encoding="utf-8") as f:
            self.assertIn("cli/attribution.py", json.load(f)["files"])

    def test_handoff_hook_for_opencode_marks_the_end(self):
        import handoff
        a = mock.Mock(op="hook", agent="opencode")
        stdin = io.StringIO(json.dumps({"session_id": "ses_1", "cwd": self.root, "hook_event_name": "Stop"}))
        with mock.patch("sys.stdin", stdin), mock.patch.object(handoff, "hook", return_value={}), redirect_stdout(io.StringIO()):
            handoff.command(a)
        m = A.load_marks(A.store_dir(self.root))[-1]
        self.assertEqual((m["event"], m["session"]), ("end", "opencode:ses_1"))


@unittest.skipUnless(shutil.which("node") and os.name != "nt", "requires Node and executable scripts")
class SymlinkedFolder(Base):
    """A project opened through a symbolic link (/tmp is /private/tmp on a Mac): the window asks with the path
    it has, so the answers carry that path, else Changes looks a file up under a name the answer does not have."""

    def setUp(self):
        super().setUp()
        self.link = os.path.join(self.tmp.name, "link")
        os.symlink(self.root, self.link)

    cli = Cli.cli
    cli_edit = Cli.cli_edit

    def turn_then_your_edit(self):
        self.cli("mark", "--event", "start", "--agent", "codex", "--session", "t1", "--cwd", self.link, "--text", "go")
        self.write("app.py", "import os\n\nRED = 1\nX = 1\n")
        self.cli("mark", "--event", "end", "--agent", "codex", "--session", "t1", "--cwd", self.link)
        asked = os.path.join(self.link, "app.py")
        full = self.write("app.py", "import os\n\nRED = 1\nX = 1\nY = 1\n")
        os.utime(full, (time.time() + 30, time.time() + 30))
        # the editor has the file under the link
        self.assertEqual(self.cli_edit(asked, "import os\n\nRED = 1\nX = 1\n", "import os\n\nRED = 1\nX = 1\nY = 1\n")["path"], "app.py")
        return asked

    def test_files_answers_under_the_path_asked(self):
        asked = self.turn_then_your_edit()
        listed = self.cli("files", asked, "--json")
        self.assertEqual(list(listed["files"]), [asked])
        self.assertEqual(listed["files"][asked]["counts"]["you"], 1)
        self.assertEqual(listed["files"][asked]["counts"]["ai"], 1)
        self.assertEqual(self.cli("show", asked, "--json")["file"], asked)

    def test_steps_name_files_under_the_folder_asked(self):
        asked = self.turn_then_your_edit()
        steps = self.cli("steps", "--agent", "codex", "--session", "t1", "--cwd", self.link, "--json")
        self.assertEqual(steps["root"], self.link)
        self.assertEqual([f["path"] for f in steps["turns"][0]["files"]], [asked])
        mine = steps["yours"][0]["files"][0]
        self.assertEqual((mine["path"], mine["after"]), (asked, asked))

    def test_the_record_is_one_for_both_paths(self):
        self.turn_then_your_edit()
        real = self.cli("files", os.path.join(self.root, "app.py"), "--json")["files"][os.path.join(self.root, "app.py")]
        self.assertEqual((real["counts"]["ai"], real["counts"]["you"]), (1, 1))


class OpenCodePlugin(unittest.TestCase):
    """Dispatch's OpenCode plugin asks Dispatch's one hook entry (`hook opencode`, the hook JSON on stdin); here a fake
    `dispatch` answers as the entry would."""

    FAKE = '''#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let input = "";
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  const data = JSON.parse(input || "{}");
  const done = () => fs.appendFileSync(process.env.ATTR_CALLS, JSON.stringify({args, data, session: process.env.DISPATCH_SESSION_ID}) + "\\n");
  const say = (text) => process.stdout.write(JSON.stringify({hookSpecificOutput: {hookEventName: data.hook_event_name, additionalContext: text}}));
  if (data.hook_event_name === "UserPromptSubmit") {
    const late = Number(process.env.ATTR_LATE_MS || 0);
    setTimeout(() => { done(); say((late ? "LATE" : "YOU changed") + " app.py (line 4)"); }, late);
  } else { done(); if (data.hook_event_name === "SessionStart") say("# brief"); else process.stdout.write("{}"); }
});
'''

    def run_plugin(self, script, **extra):
        import opencode_engine
        folder = tempfile.mkdtemp(prefix="dispatch attr ")
        self.addCleanup(shutil.rmtree, folder, True)
        root = Path(folder).resolve()
        plugin = root / "dispatch.mjs"
        plugin.write_text(Path(opencode_engine.PLUGIN_SOURCE).read_text())
        fake = root / "fake dispatch"
        fake.write_text(self.FAKE)
        fake.chmod(0o755)
        env = {**os.environ, "DISPATCH_CLI": str(fake), "ATTR_CALLS": str(root / "calls.jsonl"),
               "ATTR_PLUGIN": str(plugin), "ATTR_CWD": str(root), **extra}
        result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script],
                                env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["ok"])

    def test_a_note_that_comes_late_still_reaches_the_turn(self):
        self.run_plugin(r'''
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { DispatchPlugin } = await import(pathToFileURL(process.env.ATTR_PLUGIN).href);
const hooks = await DispatchPlugin({directory: process.env.ATTR_CWD});
await hooks["chat.message"]({sessionID: "s1"}, {message: {}, parts: [{type: "text", text: "go"}]});
const first = {system: ["base"]};
await hooks["experimental.chat.system.transform"]({sessionID: "s1"}, first);
// the turn went on without the note, which comes 900 ms in: it did not wait past its 300 ms (a stopwatch said so
// before, and a busy Mac could outrun it)
assert.ok(!first.system.some((x) => x.startsWith("LATE")), "the turn waited for the late note");
await new Promise((r) => setTimeout(r, 1500));
const later = {system: ["base"]};
await hooks["experimental.chat.system.transform"]({sessionID: "s1"}, later);
assert.ok(later.system.includes("LATE app.py (line 4)"), JSON.stringify(later.system));
const calls = readFileSync(process.env.ATTR_CALLS, "utf8").trim().split("\n").map(JSON.parse);
assert.ok(calls.some((c) => c.data.hook_event_name === "UserPromptSubmit"), "the mark landed although the turn went on");
console.log(JSON.stringify({ok: true}));
''', DISPATCH_ATTRIBUTION_WAIT_MS="300", ATTR_LATE_MS="900")

    def test_every_call_goes_to_the_one_entry_with_the_hook_json(self):
        self.run_plugin(r'''
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { DispatchPlugin } = await import(pathToFileURL(process.env.ATTR_PLUGIN).href);
const hooks = await DispatchPlugin({directory: process.env.ATTR_CWD});
const calls = () => readFileSync(process.env.ATTR_CALLS, "utf8").trim().split("\n").map(JSON.parse);
await hooks["chat.message"]({sessionID: "s1"}, {message: {}, parts: [{type: "text", text: "add a line"}, {type: "text", text: "(file)", synthetic: true}]});
const start = calls().find((c) => c.data.hook_event_name === "UserPromptSubmit");
assert.deepEqual(start.args, ["hook", "opencode"]);
assert.deepEqual(start.data, {hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: process.env.ATTR_CWD, prompt: "add a line"});
assert.equal(start.session, "s1");
const o = {system: ["base"]};
await hooks["experimental.chat.system.transform"]({sessionID: "s1"}, o);
assert.deepEqual(o.system, ["base", "# brief", "YOU changed app.py (line 4)"]);
assert.deepEqual(calls().find((c) => c.data.hook_event_name === "SessionStart").data, {hook_event_name: "SessionStart", session_id: "s1", cwd: process.env.ATTR_CWD});
await hooks["tool.execute.after"]({tool: "todowrite", sessionID: "s1", args: {todos: [{content: "a"}]}});
await hooks["tool.execute.after"]({tool: "bash", sessionID: "s1", args: {}});
await hooks.event({event: {type: "session.idle", properties: {sessionID: "s1"}}});
// both calls go out without being waited for, each in its own process: on a busy Mac the to-do list's can land after
// the Stop (it failed so on the mini at load 19). Wait for both; bash starts no call at all, so one is the right count.
const seen = (name) => calls().some((c) => c.data.hook_event_name === name);
for (const end = Date.now() + 25000; Date.now() < end && !(seen("Stop") && seen("PostToolUse"));) await new Promise((r) => setTimeout(r, 30));
const plan = calls().filter((c) => c.data.hook_event_name === "PostToolUse");
assert.equal(plan.length, 1, "only the to-do list asks for the plan");
assert.deepEqual(plan[0].data.tool_input, {todos: [{content: "a"}]});
assert.equal(plan[0].data.tool_name, "todowrite");
assert.ok(calls().some((c) => c.data.hook_event_name === "Stop" && c.data.session_id === "s1"));
await hooks.event({event: {type: "session.compacted", properties: {sessionID: "s1"}}});
await hooks["experimental.chat.system.transform"]({sessionID: "s1"}, {system: []});
assert.equal(calls().filter((c) => c.data.hook_event_name === "SessionStart").pop().data.source, "compact");
console.log(JSON.stringify({ok: true}));
''')


if __name__ == "__main__":
    unittest.main()
