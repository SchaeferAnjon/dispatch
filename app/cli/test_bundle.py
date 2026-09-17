# -*- coding: utf-8 -*-
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


class Bundle(unittest.TestCase):
    def test_every_cli_module_ships_in_the_app(self):
        # The installed Dispatch.app runs the CLI from its bundle, which only contains the files
        # tauri.conf.json lists. A module missing there works from the repo and silently fails in the
        # app (rules_sync.py did: edits never synced from the installed app).
        conf = json.load(open(os.path.join(HERE, "..", "src-tauri", "tauri.conf.json")))
        resources = conf["bundle"]["resources"]
        listed = {os.path.basename(k) for k in (resources if isinstance(resources, dict) else {r: r for r in resources})}
        modules = {f for f in os.listdir(HERE) if f.endswith(".py") and not f.startswith("test_")}
        self.assertEqual(sorted(modules - listed), [])


if __name__ == "__main__":
    unittest.main()


class NoBytecodeInsideTheApp(unittest.TestCase):
    """`dispatch` typed in a terminal runs the copy inside Dispatch.app. A __pycache__ written there
    is an unsigned file in a sealed bundle: `codesign --verify --strict` fails and macOS asks for
    the privacy permissions again."""

    def test_entry_points_switch_bytecode_off_before_importing_siblings(self):
        import re
        here = os.path.dirname(os.path.abspath(__file__))
        siblings = {f[:-3] for f in os.listdir(here) if f.endswith(".py")}
        for name in ("dispatch.py", "serve.py", "presence.py", "notify.py", "notify_watch.py", "updater.py", "init_wizard.py", "insights_report.py", "session_control.py", "edit-guard.py"):
            lines = open(os.path.join(here, name), encoding="utf-8").read().split("\n")
            off = next((i for i, l in enumerate(lines) if l.startswith("sys.dont_write_bytecode = True")), None)
            self.assertIsNotNone(off, name)
            first = next((i for i, l in enumerate(lines) if re.match(r"^\s*(import|from)\s+(%s)\b" % "|".join(sorted(siblings)), l)), len(lines))
            self.assertLess(off, first, name)

    def test_running_the_cli_leaves_no_pycache(self):
        import shutil, subprocess, sys, tempfile
        here = os.path.dirname(os.path.abspath(__file__))
        with tempfile.TemporaryDirectory() as d:
            cli = os.path.join(d, "cli")
            shutil.copytree(here, cli, ignore=shutil.ignore_patterns("__pycache__", "test_*"))
            env = {k: v for k, v in os.environ.items() if k != "PYTHONDONTWRITEBYTECODE"}
            env.update(BEADS_DIR=os.path.join(d, ".beads"), DISPATCH_DIR=os.path.join(d, ".dispatch"), HOME=d)
            for argv in (["dispatch.py", "--help"], ["dispatch.py", "notify", "--help"], ["notify.py", "--help"], ["updater.py", "--help"]):
                subprocess.run([sys.executable, os.path.join(cli, argv[0])] + argv[1:], capture_output=True, env=env, timeout=60)
            self.assertFalse(os.path.exists(os.path.join(cli, "__pycache__")), os.listdir(cli))
