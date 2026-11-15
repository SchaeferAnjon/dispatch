# -*- coding: utf-8 -*-
"""Snippets: kept in ~/.dispatch/snippets.json, starters until the first change. Temporary HOME."""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import snippets as S


class Snippets(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        p = mock.patch.dict(os.environ, {"HOME": self.tmp, "DISPATCH_HOME": os.path.join(self.tmp, ".dispatch")})
        p.start()
        self.addCleanup(p.stop)

    def test_starters_until_the_first_change_and_no_file_written_by_reading(self):
        self.assertEqual([s["id"] for s in S.load()], [s["id"] for s in S.STARTERS])
        self.assertFalse(os.path.exists(S.store_path()))

    def test_add_keeps_the_starters_and_writes_the_file(self):
        out = S.add("Review", "Review the diff and point out risky changes.")
        self.assertTrue(out["ok"])
        saved = json.load(open(S.store_path()))["snippets"]
        self.assertEqual(len(saved), len(S.STARTERS) + 1)
        self.assertEqual(saved[-1]["name"], "Review")

    def test_a_snippet_without_a_name_is_named_by_its_first_line(self):
        out = S.add("", "Summarize the last hour of work\nwith links")
        self.assertEqual(out["snippet"]["name"], "Summarize the last hour of work")

    def test_empty_text_is_refused(self):
        self.assertFalse(S.add("x", "   ")["ok"])

    def test_update_and_remove(self):
        sid = S.add("A", "one")["snippet"]["id"]
        self.assertEqual(S.update(sid, text="two")["snippet"]["text"], "two")
        self.assertTrue(S.remove(sid)["ok"])
        self.assertNotIn(sid, [s["id"] for s in S.load()])
        self.assertFalse(S.remove("nope")["ok"])

    def test_removing_a_starter_sticks(self):
        S.remove("starter-commit")
        self.assertNotIn("starter-commit", [s["id"] for s in S.load()])

    def test_chinese_text_round_trips(self):
        S.add("中文", "把改动用大白话讲一遍")
        self.assertEqual(S.load()[-1]["text"], "把改动用大白话讲一遍")


if __name__ == "__main__":
    unittest.main()
