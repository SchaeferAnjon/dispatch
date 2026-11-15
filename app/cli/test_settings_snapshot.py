# -*- coding: utf-8 -*-
"""`dispatch settings-page`: several commands in one process, each answered as if run on its own (settings_snapshot.py)."""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import settings_snapshot as S  # noqa: E402


class FakeDispatch:
    """`_main` the way dispatch.py has it: reads sys.argv, prints, may exit."""

    def __init__(self):
        self.seen = []

    def _main(self):
        argv = sys.argv[1:]
        self.seen.append(argv)
        if argv[0] == "ok":
            print(json.dumps({"ok": True, "argv": argv}))
        elif argv[0] == "note-first":
            print("a note")
            print(json.dumps({"n": 1}))
        elif argv[0] == "exit":
            print(json.dumps({"partial": True}))
            sys.exit(3)
        elif argv[0] == "boom":
            raise RuntimeError("it broke")
        elif argv[0] == "messy":
            os.environ["SNAPSHOT_TEST_LEFTOVER"] = "1"
            os.chdir(tempfile.gettempdir())
            print(json.dumps([1, 2]))
        elif argv[0] == "stdin":
            print(json.dumps({"stdin": sys.stdin.read()}))


class SnapshotTest(unittest.TestCase):

    def test_each_part_is_its_command_answer(self):
        d = FakeDispatch()
        out = S.snapshot(d, {"a": ["ok", "--json"], "b": ["note-first"]})
        self.assertTrue(out["ok"])
        self.assertEqual(out["parts"]["a"]["value"], {"ok": True, "argv": ["ok", "--json"]})
        self.assertEqual(out["parts"]["b"]["value"], {"n": 1}, "a note printed before the JSON is skipped")
        self.assertEqual(d.seen, [["ok", "--json"], ["note-first"]])
        self.assertIsInstance(out["parts"]["a"]["ms"], int)

    def test_a_failing_part_costs_only_itself(self):
        out = S.snapshot(FakeDispatch(), {"bad": ["exit"], "worse": ["boom"], "good": ["ok"]})
        self.assertEqual((out["parts"]["bad"]["ok"], out["parts"]["bad"]["code"]), (False, 3))
        self.assertFalse(out["parts"]["worse"]["ok"])
        self.assertIn("it broke", out["parts"]["worse"]["error"])
        self.assertTrue(out["parts"]["good"]["ok"])

    def test_a_part_leaves_the_process_as_it_found_it(self):
        argv, cwd = list(sys.argv), os.getcwd()
        self.assertNotIn("SNAPSHOT_TEST_LEFTOVER", os.environ)
        out = S.snapshot(FakeDispatch(), {"m": ["messy"], "s": ["stdin"]})
        self.assertEqual(out["parts"]["m"]["value"], [1, 2])
        self.assertEqual(out["parts"]["s"]["value"], {"stdin": ""}, "a part never waits on the caller's stdin")
        self.assertEqual((sys.argv, os.getcwd()), (argv, cwd))
        self.assertNotIn("SNAPSHOT_TEST_LEFTOVER", os.environ)

    def test_last_json(self):
        self.assertEqual(S.last_json('{"a": 1}'), {"a": 1})
        self.assertEqual(S.last_json('hello\n[1]\n'), [1])
        self.assertIsNone(S.last_json(""))
        self.assertIsNone(S.last_json("no json here"))

    def test_the_parts_are_reads_of_this_mac(self):
        # what asks a server or another program is read on its own, in the background, never in here
        joined = [" ".join(a) for a in S.PARTS.values()]
        for slow in ("accounts", "engines detect", "net status", "machines", "projects"):
            self.assertFalse(any(j.startswith(slow) for j in joined), slow)
        self.assertTrue(all(a[-1] == "--json" for a in S.PARTS.values()))


if __name__ == "__main__":
    unittest.main()
