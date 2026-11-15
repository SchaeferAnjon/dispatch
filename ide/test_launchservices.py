"""launchservices.sh with a stand-in lsregister: only the installed Dispatch IDE.app stays registered (10-09)."""
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ID = "dev.schaefer.dispatch.ide"

# what `lsregister -dump` prints, cut down: one record per bundle, "path:" before "identifier:"
DUMP = """--------------------------------------------------------------------------------
bundle id:                  Dispatch IDE (0x1)
path:                       {keep} (0x88048)
identifier:                 {id}
--------------------------------------------------------------------------------
bundle id:                  Dispatch IDE (0x2)
path:                       /Users/me/Dispatch-备份-1001/files/000-Dispatch IDE.app (0x7f0fc)
identifier:                 {id}
--------------------------------------------------------------------------------
bundle id:                  Dispatch IDE (0x3)
path:                       /Users/me/Projects/kanban/ide/staging/060c8c606de2/Dispatch IDE.app (0x8632c)
identifier:                 {id}
--------------------------------------------------------------------------------
bundle id:                  Other (0x4)
path:                       /Applications/Other.app (0x5)
identifier:                 com.example.other
--------------------------------------------------------------------------------
bundle id:                  Dispatch IDE (0x6)
path:                       /Users/me/Projects/kanban/ide/staging/060c8c606de2/Dispatch IDE.app (0x8632d)
identifier:                 {id}
"""

STUB = """#!/bin/sh
echo "$*" >> "$LS_TEST_CALLS"
[ "$1" = "-dump" ] && cat "$LS_TEST_DUMP"
[ "$1" = "-u" ] && exit 1
exit 0
"""


class LaunchServices(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.keep = root / "Applications" / "Dispatch IDE.app"
        (self.keep / "Contents").mkdir(parents=True)
        with open(self.keep / "Contents" / "Info.plist", "wb") as f:
            plistlib.dump({"CFBundleIdentifier": ID}, f)
        self.calls = root / "calls"
        dump = root / "dump"
        dump.write_text(DUMP.format(keep=self.keep, id=ID))
        ls = root / "lsregister"
        ls.write_text(STUB)
        ls.chmod(0o755)
        self.env = {"PATH": "/usr/bin:/bin", "HOME": str(root), "DISPATCH_LSREGISTER": str(ls),
                    "LS_TEST_CALLS": str(self.calls), "LS_TEST_DUMP": str(dump)}

    def tearDown(self):
        self.tmp.cleanup()

    def run_ls(self, *args):
        return subprocess.run(["bash", str(HERE / "launchservices.sh"), *args], env=self.env, capture_output=True, text=True, timeout=30)

    def test_tidy_unregisters_every_other_copy_once_and_registers_the_installed_one(self):
        p = self.run_ls("tidy", str(self.keep))
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.calls.read_text().splitlines(), [
            "-dump",
            "-u /Users/me/Dispatch-备份-1001/files/000-Dispatch IDE.app",
            "-u /Users/me/Projects/kanban/ide/staging/060c8c606de2/Dispatch IDE.app",
            f"-f {self.keep}",
        ])
        self.assertIn("2 other copies", p.stdout)

    def test_forget_takes_out_the_copies_named_and_a_failure_is_not_one(self):
        p = self.run_ls("forget", "/x/a.app", "/x/b.app")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.calls.read_text().splitlines(), ["-u /x/a.app", "-u /x/b.app"])

    def test_no_lsregister_does_nothing_and_a_missing_keep_is_an_error(self):
        self.env["DISPATCH_LSREGISTER"] = "/nonexistent/lsregister"
        p = self.run_ls("tidy")
        self.assertEqual((p.returncode, self.calls.exists()), (0, False))
        self.env["DISPATCH_LSREGISTER"] = str(Path(self.tmp.name) / "lsregister")
        p = self.run_ls("tidy", "/nonexistent/Dispatch IDE.app")
        self.assertEqual(p.returncode, 1)
        self.assertEqual(self.run_ls("nonsense").returncode, 2)

    def test_install_forgets_the_build_it_installed_only_for_the_real_place(self):
        src = Path(self.tmp.name) / "staging" / "b" / "Dispatch IDE.app"
        (src / "Contents").mkdir(parents=True)
        dst = Path(self.tmp.name) / "elsewhere" / "Dispatch IDE.app"
        dst.parent.mkdir()
        env = dict(self.env, DISPATCH_IDE_SRC=str(src), DISPATCH_IDE_DEST=str(dst))
        p = subprocess.run(["bash", str(HERE / "install.sh"), "--no-open"], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(dst.is_dir())
        self.assertFalse(self.calls.exists(), "a dry run into another folder leaves LaunchServices alone")
        text = (HERE / "install.sh").read_text()
        self.assertIn('bash launchservices.sh forget "$SRC"', text)
        self.assertIn('bash launchservices.sh register "$DST"', text)


if __name__ == "__main__":
    unittest.main()
