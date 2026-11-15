# -*- coding: utf-8 -*-
"""Asking for a GitHub star: only after a while, only when public, only once. Nothing goes to the network."""
import os
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import star as S

DAY = 86400


def index(n, at):
    return {f"/t/{i}.jsonl": {"assistant_msgs": 1, "mtime": at, "subagent": False} for i in range(n)}


class Due(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = os.path.join(self.tmp.name, "star.json")
        self.asked_github = 0

    def tearDown(self):
        self.tmp.cleanup()

    def public(self, answer=True):
        def f():
            self.asked_github += 1
            return answer
        return f

    def test_not_in_the_first_week_nor_before_ten_sessions(self):
        t0 = 1_000_000.0
        r = S.check(self.p, lambda: index(30, t0 + 1), now=t0, public_fn=self.public())
        self.assertFalse(r["due"])
        self.assertIn("days", r["why"])
        r = S.check(self.p, lambda: index(S.SESSIONS - 1, t0 + 1), now=t0 + 8 * DAY, public_fn=self.public())
        self.assertFalse(r["due"])
        self.assertIn("sessions", r["why"])
        self.assertEqual(self.asked_github, 0, "GitHub is only asked once everything else says it is time")
        r = S.check(self.p, lambda: index(S.SESSIONS, t0 + 1), now=t0 + 8 * DAY, public_fn=self.public(), starred_fn=lambda: False)
        self.assertTrue(r["due"])
        self.assertEqual(r["url"], "https://github.com/SchaeferAnjon/dispatch")

    def test_sessions_before_first_use_and_sub_agents_do_not_count(self):
        idx = index(20, 10.0)
        idx["/sub.jsonl"] = {"assistant_msgs": 3, "mtime": 500.0, "subagent": True}
        idx["/silent.jsonl"] = {"assistant_msgs": 0, "mtime": 500.0}
        idx["/real.jsonl"] = {"assistant_msgs": 2, "mtime": 500.0}
        self.assertEqual(S.sessions_since(idx, 100.0), 1)

    def test_private_repository_waits_and_asks_github_once_a_day(self):
        t0 = 1_000_000.0
        S.check(self.p, lambda: {}, now=t0, public_fn=self.public(False))
        later = t0 + 8 * DAY
        r = S.check(self.p, lambda: index(12, t0 + 1), now=later, public_fn=self.public(False))
        self.assertEqual((r["due"], r["why"]), (False, "not open source yet"))
        S.check(self.p, lambda: index(12, t0 + 1), now=later + 3600, public_fn=self.public(False))
        self.assertEqual(self.asked_github, 1)
        r = S.check(self.p, lambda: index(12, t0 + 1), now=later + S.RECHECK + 1, public_fn=self.public(True), starred_fn=lambda: None)
        self.assertTrue(r["due"], "made public: due the next day")
        r = S.check(self.p, lambda: index(12, t0 + 1), now=later + S.RECHECK + 2, public_fn=self.public(None))
        self.assertTrue(r["due"], "offline keeps what was learned")

    def test_someone_who_starred_already_is_never_asked(self):
        t0 = 1_000_000.0
        S.check(self.p, lambda: {}, now=t0)
        r = S.check(self.p, lambda: index(12, t0 + 1), now=t0 + 8 * DAY, public_fn=self.public(True), starred_fn=lambda: True)
        self.assertEqual((r["due"], r["why"]), (False, "starred already"))

    def test_asked_only_once_by_one_window(self):
        t0 = 1_000_000.0
        S.check(self.p, lambda: {}, now=t0)
        wins = []
        threads = [threading.Thread(target=lambda: wins.append(S.claim(self.p))) for _ in range(6)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(wins.count(True), 1)
        self.assertFalse(S.claim(self.p))
        S.answer(self.p, "later")
        r = S.check(self.p, lambda: index(50, t0 + 1), now=t0 + 30 * DAY, public_fn=self.public(True), starred_fn=lambda: False)
        self.assertEqual((r["due"], r["asked"], r["answer"]), (False, True, "later"))


if __name__ == "__main__":
    unittest.main()
