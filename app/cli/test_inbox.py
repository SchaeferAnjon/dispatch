# -*- coding: utf-8 -*-
"""The bell's events (inbox.py): finished / needs you / stopped from each agent's own end-of-turn signal,
one unread row per session, read and unread again, and the command."""
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace

import inbox


class Classify(unittest.TestCase):
    def test_engine_statuses(self):
        self.assertEqual(inbox.classify("success")[0], "finished")        # Claude's result
        self.assertEqual(inbox.classify("completed")[0], "finished")      # Codex turn/completed, the window
        self.assertEqual(inbox.classify("needs_input")[0], "needs_you")
        self.assertEqual(inbox.classify("waiting_permission")[0], "needs_you")
        kind, why, by_you = inbox.classify("interrupted")
        self.assertEqual((kind, why, by_you), ("stopped", "You stopped it", True))
        kind, why, by_you = inbox.classify("error", "Claude 进程退出了（退出码 1）")
        self.assertEqual((kind, by_you), ("stopped", False))
        self.assertIn("退出码 1", why)

    def test_unknown_status_is_a_stop_not_a_finish(self):
        kind, why, _ = inbox.classify("rate_limited")
        self.assertEqual(kind, "stopped")
        self.assertEqual(why, "Hit a usage limit")
        self.assertEqual(inbox.classify("")[0], "stopped")


class Store(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = self.tmp.name

    def add(self, kind, session="claude:/a", at=1000.0, **kw):
        return inbox.add(kind, session, base=self.base, now=at, **kw)

    def test_finished_and_needs_you_ring_stopped_does_not(self):
        self.assertTrue(self.add("finished")["event"]["ring"])
        self.assertTrue(self.add("needs_you", "claude:/b")["event"]["ring"])
        self.assertFalse(self.add("stopped", "claude:/c", why="Hit a usage limit")["event"]["ring"])

    def test_you_stopping_it_is_filed_read_and_quiet(self):
        ev = self.add("stopped", by_you=True, why="You stopped it")["event"]
        self.assertTrue(ev["read"])
        self.assertEqual(ev["read_by"], "you")
        self.assertFalse(ev["ring"])
        self.assertEqual(inbox.listing(self.base)["unread"], 0)

    def test_one_unread_row_per_session(self):
        self.add("needs_you", at=1000)
        self.add("finished", at=1100, text="Done: the bell works")
        self.add("finished", "codex:/x", at=1200)
        r = inbox.listing(self.base)
        self.assertEqual(r["unread"], 2)
        self.assertEqual([e["kind"] for e in r["events"]], ["finished", "finished", "needs_you"])  # newest first
        older = r["events"][-1]
        self.assertEqual((older["read"], older["read_by"]), (True, "newer"))

    def test_another_turn_is_another_event_even_when_quick(self):
        a = self.add("stopped", at=1000, turn="t1")
        b = self.add("stopped", at=1001, turn="t2")
        self.assertTrue(b["new"])
        self.assertNotEqual(a["event"]["id"], b["event"]["id"])

    def test_a_status_flicker_is_the_same_event(self):
        a = self.add("finished", at=1000, text="one")
        b = self.add("finished", at=1002, text="two")
        self.assertFalse(b["new"])
        self.assertEqual(a["event"]["id"], b["event"]["id"])
        self.assertEqual(len(inbox.listing(self.base)["events"]), 1)
        self.assertEqual(inbox.listing(self.base)["events"][0]["text"], "two")
        c = self.add("finished", at=1000 + inbox.DEDUP_SECONDS + 1)
        self.assertTrue(c["new"])

    def test_read_unread_by_id_session_and_all(self):
        e1 = self.add("finished", at=1000)["event"]
        self.add("needs_you", "claude:/b", at=1001)
        self.add("stopped", "claude:/c", at=1002, why="Something went wrong")
        self.assertEqual(inbox.set_read(True, [e1["id"]], base=self.base, now=1003)["unread"], 2)
        self.assertEqual(inbox.set_read(False, [e1["id"]], base=self.base, now=1004)["unread"], 3)  # mark unread again
        r = inbox.set_read(True, session="claude:/b", by="working", base=self.base, now=1005)
        self.assertEqual((r["changed"], r["unread"]), (1, 2))
        b = [e for e in inbox.listing(self.base)["events"] if e["session"] == "claude:/b"][0]
        self.assertEqual(b["read_by"], "working")
        self.assertEqual(inbox.set_read(True, all_=True, base=self.base, now=1006)["unread"], 0)
        self.assertEqual(inbox.set_read(True, all_=True, base=self.base, now=1007)["changed"], 0)

    def test_counts_and_unread_only(self):
        self.add("finished", at=1000)
        self.add("needs_you", "claude:/b", at=1001)
        self.add("stopped", "claude:/c", at=1002)
        r = inbox.listing(self.base, unread_only=True)
        self.assertEqual(r["counts"], {"finished": 1, "needs_you": 1, "stopped": 1})
        self.assertEqual(len(r["events"]), 3)

    def test_old_and_too_many_events_go(self):
        self.add("finished", "claude:/old", at=1000)
        later = 1000 + inbox.KEEP_DAYS * 86400 + 10
        for i in range(inbox.KEEP + 5):
            self.add("finished", f"claude:/{i}", at=later + i * 10)
        events = inbox.load(inbox.path(self.base))
        self.assertEqual(len(events), inbox.KEEP)
        self.assertFalse(any(e["session"] == "claude:/old" for e in events))

    def test_long_text_is_one_line(self):
        ev = self.add("finished", text="a\nb  c " + "x" * 400)["event"]
        self.assertNotIn("\n", ev["text"])
        self.assertLessEqual(len(ev["text"]), inbox.TEXT_MAX)

    def test_a_session_renamed_on_this_mac_is_filed_under_its_new_name(self):
        """chatd knows the title the session started with; the namer (or the person) renamed it since."""
        import activity
        self.assertEqual(self.add("finished", "opencode:ses_1", title="Write the changelog")["event"]["title"], "Write the changelog")
        activity.set_preferences(self.base, "opencode:ses_1", {"title_override": "Lighthouse keeper story"})
        ev = self.add("needs_you", "opencode:ses_1", at=1100, title="Write the changelog")["event"]
        self.assertEqual(ev["title"], "Lighthouse keeper story")
        activity.set_preferences(self.base, "opencode:ses_1", {"title_override": ""})  # the name taken back
        self.assertEqual(self.add("finished", "opencode:ses_1", at=1200, title="Write the changelog")["event"]["title"], "Write the changelog")
        self.assertEqual(inbox.current_name(self.base, "opencode:ses_2", "Other"), "Other")

    def test_bad_input(self):
        with self.assertRaises(ValueError):
            inbox.add("done", "claude:/a", base=self.base)
        with self.assertRaises(ValueError):
            inbox.add("finished", "", base=self.base)

    def test_a_broken_file_reads_as_empty(self):
        with open(inbox.path(self.base), "w") as f:
            f.write("{nope")
        self.assertEqual(inbox.listing(self.base)["events"], [])
        self.add("finished")
        self.assertEqual(inbox.listing(self.base)["unread"], 1)


class LastWords(unittest.TestCase):
    """A session that finished while the window did not have it loaded still says how it ended."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = self.tmp.name

    def test_words_fill_a_finished_row_without_text(self):
        ev = inbox.add("finished", "agent-host-claude:/h1", base=self.base, now=1000, words=lambda s: "All tests pass.")["event"]
        self.assertEqual(ev["text"], "All tests pass.")
        self.assertNotIn("text_pending", ev)

    def test_text_from_the_window_wins_and_other_kinds_are_not_looked_up(self):
        asked = []
        ev = inbox.add("finished", "claude:/a", base=self.base, now=1000, text="Done here", words=lambda s: asked.append(s) or "x")["event"]
        self.assertEqual(ev["text"], "Done here")
        inbox.add("stopped", "claude:/b", base=self.base, now=1000, why="Hit a usage limit", words=lambda s: asked.append(s) or "x")
        self.assertEqual(asked, [])

    def test_words_that_come_later_are_picked_up_by_the_list(self):
        ev = inbox.add("finished", "claude:/late", base=self.base, now=1000, words=lambda s: "")["event"]
        self.assertTrue(ev["text_pending"])
        r = inbox.listing(self.base, now=1030, words=lambda s: "Finished the migration.")
        row = r["events"][0]
        self.assertEqual(row["text"], "Finished the migration.")
        self.assertNotIn("text_pending", row)

    def test_a_row_stops_looking_after_a_while(self):
        inbox.add("finished", "claude:/never", base=self.base, now=1000, words=lambda s: "")
        asked = []
        r = inbox.listing(self.base, now=1000 + inbox.PENDING_SECONDS + 1, words=lambda s: asked.append(s) or "late")
        self.assertEqual(asked, [])
        self.assertEqual(r["events"][0]["text"], "")
        self.assertNotIn("text_pending", r["events"][0])

    def test_a_failing_lookup_never_breaks_the_bell(self):
        def boom(_s):
            raise RuntimeError("bad transcript")
        ev = inbox.add("finished", "claude:/x", base=self.base, now=1000, words=boom)["event"]
        self.assertEqual(ev["text"], "")


class Command(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        import dispatch
        self.D = SimpleNamespace(DISPATCH_DIR=self.tmp.name, out=dispatch.out)

    def run_cmd(self, **kw):
        a = SimpleNamespace(json=True, **kw)
        buf = io.StringIO()
        with redirect_stdout(buf):
            inbox.command(a, self.D)
        return json.loads(buf.getvalue())

    def test_add_from_a_status_then_list_and_read(self):
        r = self.run_cmd(op="add", status="interrupted", kind="", session="claude:/s", source="ide", agent="claude-code",
                         title="Fix the bell", project="kanban", cwd="", text="", why="", by_you=False)
        self.assertEqual((r["event"]["kind"], r["event"]["read"]), ("stopped", True))
        r = self.run_cmd(op="add", status="", kind="finished", session="claude:/t", source="ide", agent="claude-code",
                         title="Write tests", project="kanban", cwd="", text="All green", why="", by_you=False)
        self.assertTrue(r["event"]["ring"])
        r = self.run_cmd(op="list", limit=10, unread=False)
        self.assertEqual(r["unread"], 1)
        self.assertEqual(r["events"][0]["title"], "Write tests")
        r = self.run_cmd(op="read", ids=[], session="claude:/t", all=False, by="you")
        self.assertEqual(r["unread"], 0)
        r = self.run_cmd(op="unread", ids=[r0["id"] for r0 in self.run_cmd(op="list", limit=10, unread=False)["events"][:1]], session="", all=False, by="you")
        self.assertEqual(r["unread"], 1)

    def test_read_needs_a_target(self):
        a = SimpleNamespace(json=True, op="read", ids=[], session="", all=False)
        with redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
            inbox.command(a, self.D)


if __name__ == "__main__":
    unittest.main()
