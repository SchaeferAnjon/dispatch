# -*- coding: utf-8 -*-
"""Idle agents asleep (sleep.py): the setting and its mirror for the Agents window's host, who is asleep,
and the command."""
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace

import sleep


class Setting(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = self.tmp.name

    def test_on_by_default_thirty_minutes(self):
        self.assertEqual(sleep.minutes_of({}), 30)
        self.assertEqual(sleep.mirrored_minutes(self.base), 30)  # no mirror yet: the default

    def test_bad_values_fall_back(self):
        for bad in (True, "10", -5, None):
            self.assertEqual(sleep.minutes_of({"agent_sleep_minutes": bad}), 30)
        self.assertEqual(sleep.minutes_of({"agent_sleep_minutes": 0}), 0)
        self.assertEqual(sleep.minutes_of({"agent_sleep_minutes": 99999}), sleep.MAX_MINUTES)

    def test_mirror_is_written_only_on_change(self):
        self.assertTrue(sleep.write_mirror(self.base, 45))
        self.assertFalse(sleep.write_mirror(self.base, 45))
        self.assertEqual(sleep.mirrored_minutes(self.base), 45)
        self.assertTrue(sleep.write_mirror(self.base, 0))
        self.assertEqual(sleep.mirrored_minutes(self.base), 0)


class WhoIsAsleep(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = self.tmp.name

    def test_each_runner_keeps_its_own_list_and_status_merges_them(self):
        sleep.note(self.base, "chat", "claude-code:a", True, {"agent": "claude-code", "title": "Fix it", "cwd": "/p"}, now=100)
        with open(sleep.runner_path(self.base, "ide"), "w") as f:  # what the Agents window's host writes
            json.dump({"asleep": {"claude:/b": {"at": 200, "agent": "claude", "title": "Bell"}}}, f)
        st = sleep.status(self.base, {})
        self.assertEqual((st["on"], st["minutes"], st["count"]), (True, 30, 2))
        self.assertEqual([x["session"] for x in st["asleep"]], ["claude:/b", "claude-code:a"])  # newest first
        sleep.note(self.base, "chat", "claude-code:a", False)
        self.assertEqual(sleep.status(self.base, {})["count"], 1)
        sleep.note(self.base, "chat", "claude-code:never", False)  # waking one that never slept: nothing
        self.assertEqual(sleep.status(self.base, {"agent_sleep_minutes": 0})["on"], False)

    def test_a_broken_list_reads_as_nobody(self):
        with open(sleep.runner_path(self.base, "ide"), "w") as f:
            f.write("[]")
        self.assertEqual(sleep.asleep(self.base), [])


class Command(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        import dispatch
        self.stored = {}
        self.D = SimpleNamespace(DISPATCH_DIR=self.tmp.name, out=dispatch.out,
                                 settings_load=lambda: dict(self.stored), settings_write=self.stored.update)

    def run_cmd(self, op, minutes=""):
        buf = io.StringIO()
        with redirect_stdout(buf):
            sleep.command(SimpleNamespace(op=op, minutes=minutes, json=True), self.D)
        return json.loads(buf.getvalue())

    def test_off_after_on(self):
        self.assertEqual(self.run_cmd("status")["minutes"], 30)
        r = self.run_cmd("off")
        self.assertEqual((r["on"], self.stored["agent_sleep_minutes"], self.stored["chat_idle_close_minutes"]), (False, 0, 0))
        self.assertEqual(sleep.mirrored_minutes(self.tmp.name), 0)
        r = self.run_cmd("after", "45")
        self.assertEqual((r["on"], r["minutes"]), (True, 45))
        self.assertEqual(sleep.mirrored_minutes(self.tmp.name), 45)
        self.stored["agent_sleep_minutes"] = 0
        self.assertEqual(self.run_cmd("on")["minutes"], 30)

    def test_status_reads_the_mirror_not_the_board(self):
        self.D.settings_load = lambda: self.fail("status must not wait for the board")
        sleep.write_mirror(self.tmp.name, 12)
        self.assertEqual(self.run_cmd("status")["minutes"], 12)

    def test_after_needs_a_sane_number(self):
        for bad in ("", "0", "abc", "100000"):
            with redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
                sleep.command(SimpleNamespace(op="after", minutes=bad, json=True), self.D)

    def test_now_asks_every_runner_without_the_board(self):
        # the bottom bar's Let idle agents sleep: a time every runner reads, the setting untouched
        self.D.settings_load = lambda: self.fail("now must not wait for the board")
        self.assertEqual(sleep.asked_at(self.tmp.name), 0)
        r = self.run_cmd("now")
        self.assertTrue(r["asked"])
        self.assertGreater(sleep.asked_at(self.tmp.name), 0)
        self.assertEqual(self.stored, {})


if __name__ == "__main__":
    unittest.main()
