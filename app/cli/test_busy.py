# -*- coding: utf-8 -*-
"""`dispatch busy` (busy.py): when the bottom bar says the Mac is busy, and with what."""
import subprocess
import unittest
from types import SimpleNamespace

import busy


def fake_run(memory="System-wide memory free percentage: 12%", names="claude\ncodex\nClaude\nGoogle Chrome\nopencode\n", lines="node /x/gulp vscode-darwin-arm64\n/bin/zsh\n"):
    def run(cmd, **kw):
        if cmd[0] == "memory_pressure":
            return SimpleNamespace(stdout=memory)
        if cmd[:3] == ["ps", "-ax", "-c"]:
            return SimpleNamespace(stdout=names)
        return SimpleNamespace(stdout=lines)
    return run


class Busy(unittest.TestCase):
    def test_low_memory_is_busy(self):
        self.assertEqual(busy.judge(12, 1.0, 10), "memory")
        self.assertEqual(busy.judge(45, 1.0, 10), None)

    def test_only_a_sustained_load_is_busy(self):
        self.assertEqual(busy.judge(45, 31.0, 10), "processors")
        self.assertEqual(busy.judge(45, 29.0, 10), None)
        self.assertEqual(busy.judge(None, None, 10), None)

    def test_counts_agents_not_the_desktop_app(self):
        names, lines = busy.processes(fake_run())
        self.assertEqual(busy.count_users(names, lines), (3, 1))

    def test_status_reads_memory_and_says_why(self):
        r = busy.status(run=fake_run(), cores=10)
        self.assertEqual((r["busy"], r["why"], r["memory_free"], r["agents"], r["builds"]), (True, "memory", 12, 3, 1))

    def test_nothing_readable_is_not_busy(self):
        def broken(cmd, **kw):
            raise OSError("no ps here")
        self.assertEqual(busy.memory_free(broken), None)
        self.assertEqual(busy.processes(broken), ([], []))


if __name__ == "__main__":
    unittest.main()
