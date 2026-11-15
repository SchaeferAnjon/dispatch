# -*- coding: utf-8 -*-
"""Keep awake: when there is a reason, how the hold is renewed and let go. No real caffeinate is started."""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import awake as W


class FakeProc:
    def __init__(self):
        self.code = None
        self.terminated = False

    def poll(self):
        return self.code

    def terminate(self):
        self.terminated = True
        self.code = -15


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class Reason(unittest.TestCase):
    def test_working_session_or_phone(self):
        self.assertEqual(W.reason([{"state": "idle"}, {"state": "working"}], False), "working")
        self.assertEqual(W.reason([{"state": "idle"}], True), "phone")
        self.assertEqual(W.reason([{"state": "idle"}, {"state": "waiting"}], False), "")
        self.assertEqual(W.reason([], False), "")

    def test_phone_connected_only_when_paired_and_recent(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.json")
            self.assertFalse(W.phone_connected(path, 1000))
            with open(path, "w") as f:
                json.dump({"pairs": {"a": {"status": "paired", "last_seen": 950}, "b": {"status": "pending"}}}, f)
            self.assertTrue(W.phone_connected(path, 1000))
            self.assertFalse(W.phone_connected(path, 1000 + W.PHONE_SEEN))
            with open(path, "w") as f:
                f.write("{damaged")
            self.assertFalse(W.phone_connected(path, 1000))


class Hold(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.procs = []

        def spawn():
            p = FakeProc()
            self.procs.append(p)
            return p
        self.h = W.Holder(spawn=spawn, clock=self.clock)

    def test_holds_while_there_is_a_reason_and_renews_before_it_ends(self):
        self.assertEqual(self.h.tick("working"), {"holding": True, "reason": "working", "until": 1000 + W.HOLD})
        self.clock.t += 20
        self.h.tick("working")
        self.assertEqual(len(self.procs), 1, "one caffeinate covers the next ticks")
        self.clock.t += 30   # less than half of the hold is left
        self.h.tick("working")
        self.assertEqual(len(self.procs), 2)
        self.assertTrue(self.procs[0].terminated, "the old one is replaced, never two at once")

    def test_not_renewed_when_idle_and_over_by_itself(self):
        self.h.tick("phone")
        self.clock.t += 20
        self.assertTrue(self.h.tick("")["holding"], "still inside its last hold")
        self.clock.t += W.HOLD
        self.procs[0].code = 0   # caffeinate ended on its own
        self.assertEqual(self.h.tick(""), {"holding": False, "reason": "", "until": 0})
        self.assertEqual(len(self.procs), 1)

    def test_release_lets_go_at_once(self):
        self.h.tick("working")
        self.h.release()
        self.assertTrue(self.procs[0].terminated)
        self.assertFalse(self.h.holding())

    def test_a_missing_caffeinate_is_not_an_error(self):
        h = W.Holder(spawn=mock.Mock(side_effect=OSError), clock=self.clock)
        self.assertEqual(h.tick("working")["holding"], False)


class Setting(unittest.TestCase):
    def test_on_by_default_and_off_when_the_setting_says_so(self):
        D = mock.Mock()
        D.settings_load.return_value = {}
        self.assertTrue(W.enabled(D))
        D.settings_load.return_value = {"keep_awake": 0}
        self.assertFalse(W.enabled(D))
        D.settings_load.side_effect = RuntimeError("no board")
        self.assertTrue(W.enabled(D))

    def test_off_means_nothing_is_looked_at(self):
        D = mock.Mock(DISPATCH_DIR="/nonexistent")
        D.settings_load.return_value = {"keep_awake": 0}
        with mock.patch.object(W.sys, "platform", "darwin"):
            self.assertEqual(W.current(D), {"enabled": False, "mode": "off", "reason": "", "working": 0})
        D.live_sessions.assert_not_called()

    def test_default_setting_exists(self):
        import dispatch
        self.assertEqual(dispatch.SETTING_DEFAULTS["keep_awake"], 1)


class Modes(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.spawned = []

        def spawn(mode="system"):
            p = FakeProc()
            self.spawned.append((mode, p))
            return p
        self.h = W.Holder(spawn=spawn, clock=self.clock)

    def test_setting_values(self):
        self.assertEqual([W.mode_of(v) for v in (0, 1, 2, "2", None, "display", "off", 7)], ["off", "system", "display", "display", "system", "display", "off", "system"])

    def test_screen_on_takes_a_new_caffeinate_at_once_and_off_lets_go_at_once(self):
        self.h.tick("working", "system")
        self.clock.t += 5
        self.h.tick("working", "display")
        self.assertEqual([m for m, _ in self.spawned], ["system", "display"])
        self.assertTrue(self.spawned[0][1].terminated)
        self.assertEqual(self.h.tick("working", "off"), {"holding": False, "reason": "", "until": 0})
        self.assertTrue(self.spawned[1][1].terminated, "off does not wait for the hold to run out")

    def test_real_flags(self):
        with mock.patch.object(W.subprocess, "Popen") as popen:
            W.Holder._spawn("display")
            W.Holder._spawn()
        self.assertEqual([c.args[0][1] for c in popen.call_args_list], ["-dis", "-is"])


class Status(unittest.TestCase):
    def test_reads_the_last_pass_and_goes_stale_without_the_service(self):
        with tempfile.TemporaryDirectory() as tmp:
            D = mock.Mock(DISPATCH_DIR=tmp)
            D.settings_load.return_value = {"keep_awake": 1}
            self.assertEqual(W.status(D, now=1000), {"mode": "system", "holding": False, "reason": "", "working": 0, "running": False})
            W.write_state(W.state_path(D), {"mode": "system", "working": 2}, {"holding": True, "reason": "working", "until": 1090}, now=1000)
            self.assertEqual(W.status(D, now=1010), {"mode": "system", "holding": True, "reason": "working", "working": 2, "running": True})
            self.assertFalse(W.status(D, now=1095)["holding"], "the hold ran out")
            self.assertFalse(W.status(D, now=1000 + W.INTERVAL * 3 + 1)["running"], "no pass lately: the service is not running")
            D.settings_load.return_value = {"keep_awake": 0}
            self.assertEqual(W.status(D, now=1010)["holding"], False, "off shows as not holding at once")

    def test_set_writes_the_setting(self):
        with tempfile.TemporaryDirectory() as tmp:
            D = mock.Mock(DISPATCH_DIR=tmp)
            D.settings_load.return_value = {"keep_awake": 2}
            a = mock.Mock(op="set", mode="display", json=True)
            with mock.patch.object(W, "_dispatch", return_value=D), mock.patch("sys.stdout"):
                self.assertEqual(W.command(a), 0)
            D.settings_write.assert_called_once_with({"keep_awake": 2})
            a = mock.Mock(op="set", mode="sometimes", json=True)
            with mock.patch.object(W, "_dispatch", return_value=D), mock.patch("sys.stderr"):
                self.assertEqual(W.command(a), 2)


if __name__ == "__main__":
    unittest.main()
