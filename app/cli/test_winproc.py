# -*- coding: utf-8 -*-
import json
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import winproc  # noqa: E402

WINDOWS_READY = True

ON_WIN = os.name == "nt"


class ParseCim(unittest.TestCase):
    def test_list(self):
        text = json.dumps([
            {"ProcessId": 4, "ParentProcessId": 0, "ExecutablePath": None, "CommandLine": None},
            {"ProcessId": 1200, "ParentProcessId": 900, "ExecutablePath": "C:\\Program Files\\nodejs\\node.exe",
             "CommandLine": "\"C:\\Program Files\\nodejs\\node.exe\" C:\\npm\\claude.js --resume 中文"},
        ])
        rows = winproc.parse_cim_json(text)
        self.assertEqual(rows[4], {"ppid": 0, "exe": "", "cmdline": ""})
        self.assertEqual(rows[1200]["ppid"], 900)
        self.assertTrue(rows[1200]["cmdline"].endswith("中文"))

    def test_single_object_and_bom(self):
        rows = winproc.parse_cim_json("\ufeff" + json.dumps({"ProcessId": 7, "ParentProcessId": 1, "ExecutablePath": "x.exe", "CommandLine": "x"}))
        self.assertEqual(list(rows), [7])

    def test_empty_and_junk_rows(self):
        self.assertEqual(winproc.parse_cim_json(""), {})
        self.assertEqual(winproc.parse_cim_json("[1, {\"ProcessId\": null}]"), {})


@unittest.skipIf(ON_WIN, "off-Windows behaviour")
class OffWindows(unittest.TestCase):
    def test_raises_runtime_error(self):
        for fn, args in ((winproc.snapshot, ()), (winproc.image_path, (1,)), (winproc.pid_alive, (1,)),
                         (winproc.cmdlines, ()), (winproc.bring_to_front, (1,))):
            with self.assertRaises(RuntimeError):
                fn(*args)


@unittest.skipUnless(ON_WIN, "needs Windows")
class OnWindows(unittest.TestCase):
    def test_snapshot_has_self_and_parent(self):
        rows = {pid: (ppid, name) for pid, ppid, name in winproc.snapshot()}
        self.assertIn(os.getpid(), rows)
        self.assertEqual(rows[os.getpid()][0], os.getppid())
        self.assertTrue(rows[os.getpid()][1].lower().startswith("python"))

    def test_image_path(self):
        self.assertEqual(os.path.basename(winproc.image_path(os.getpid()) or "").lower(), os.path.basename(sys.executable).lower())

    def test_pid_alive(self):
        self.assertTrue(winproc.pid_alive(os.getpid()))
        p = subprocess.Popen([sys.executable, "-c", "pass"])
        p.wait()
        self.assertFalse(winproc.pid_alive(p.pid))

    def test_cmdlines(self):
        rows = winproc.cmdlines()
        self.assertIn(os.getpid(), rows)
        self.assertIn("python", rows[os.getpid()]["cmdline"].lower())


if __name__ == "__main__":
    unittest.main()
