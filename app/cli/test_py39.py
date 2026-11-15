# -*- coding: utf-8 -*-
"""A new Mac has only the Command Line Tools' Python (3.9.6), and `dispatch` runs on it (#!/usr/bin/env python3).
These run the CLI with /usr/bin/python3 when this Mac has one: every module compiles and imports, and the
command forms the agent rules teach parse the same as on a newer Python."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SYSTEM_PY = "/usr/bin/python3"
WINDOWS_READY = True


def system_python():
    if not os.path.exists(SYSTEM_PY):
        return ""
    try:
        v = subprocess.run([SYSTEM_PY, "-c", "import sys;print(sys.version_info[:2] < (3, 12))"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return ""
    return SYSTEM_PY if v.returncode == 0 else ""


@unittest.skipUnless(system_python(), "no /usr/bin/python3 here")
class SystemPython(unittest.TestCase):
    def env(self, home):
        e = {k: v for k, v in os.environ.items() if not k.startswith(("DISPATCH_", "BEADS_"))}
        e.update(HOME=home, DISPATCH_HOME=os.path.join(home, ".dispatch"), DISPATCH_DIR=os.path.join(home, "tasks", ".dispatch"),
                 BEADS_DIR=os.path.join(home, "tasks", ".beads"), DISPATCH_KNOWLEDGE_AUTOCOMMIT="0", PYTHONDONTWRITEBYTECODE="1")
        return e

    def test_every_module_compiles_and_imports(self):
        mods = sorted(f[:-3] for f in os.listdir(HERE) if f.endswith(".py") and not f.startswith("test_"))
        code = ("import importlib, sys, traceback\nbad = []\n"
                f"for m in {mods!r}:\n"
                "    try:\n        importlib.import_module(m)\n"
                "    except SystemExit:\n        pass\n"
                "    except Exception:\n        bad.append(m + ': ' + traceback.format_exc().splitlines()[-1])\n"
                "print('\\n'.join(bad))\n")
        with tempfile.TemporaryDirectory() as home:
            r = subprocess.run([SYSTEM_PY, "-c", code], cwd=HERE, env=dict(self.env(home), PYTHONPATH=HERE), capture_output=True, text=True, timeout=300)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        self.assertEqual(r.stdout.strip(), "", "modules that do not import on the system Python:\n" + r.stdout)

    def test_options_before_the_text_parse_like_on_a_newer_python(self):
        # dispatch.md teaches `wiki add --kind pit "…" --fix "…"`; argparse before 3.12 left the text unassigned
        with tempfile.TemporaryDirectory() as home:
            r = subprocess.run([SYSTEM_PY, os.path.join(HERE, "dispatch.py"), "wiki", "add", "--kind", "pit", "the symptom", "--fix", "the fix", "--json"],
                               env=self.env(home), capture_output=True, text=True, timeout=120)
            self.assertEqual(r.returncode, 0, r.stderr[-1500:])
            out = json.loads(r.stdout[r.stdout.find("{"):])
            self.assertEqual(out["item"]["text"], "the symptom")
            with open(os.path.join(home, ".dispatch", "wiki", out["key"] + ".md"), encoding="utf-8") as f:
                self.assertEqual(f.read(), "【坑】the symptom 【解法】the fix\n")
            r = subprocess.run([SYSTEM_PY, os.path.join(HERE, "dispatch.py"), "wiki", "add", "--kind", "pit", "a", "b"],
                               env=self.env(home), capture_output=True, text=True, timeout=120)
            self.assertEqual(r.returncode, 2)
            self.assertIn("unrecognized arguments: b", r.stderr)


class ParseCompat(unittest.TestCase):
    """The same filling on whatever Python runs the suite."""

    def parser(self):
        import argparse
        import dispatch
        p = argparse.ArgumentParser(prog="dispatch")
        sub = p.add_subparsers(dest="cmd", required=True)
        s = sub.add_parser("wiki")
        s.add_argument("op", choices=["add", "list"])
        s.add_argument("text", nargs="?")
        s.add_argument("--kind")
        s = sub.add_parser("agents")
        s.add_argument("op", nargs="?", default="list", choices=["list", "show"])
        s.add_argument("name", nargs="?")
        s.add_argument("--project")
        return dispatch, p, sub

    def test_words_after_options_fill_the_empty_positionals(self):
        dispatch, p, sub = self.parser()
        a = dispatch.parse_args_compat(p, sub, ["wiki", "add", "--kind", "pit", "text here"])
        self.assertEqual((a.op, a.text, a.kind), ("add", "text here", "pit"))
        a = dispatch.parse_args_compat(p, sub, ["agents", "--project", "x", "show", "designer"])
        self.assertEqual((a.op, a.name, a.project), ("show", "designer", "x"))


if __name__ == "__main__":
    unittest.main()
