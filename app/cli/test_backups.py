"""backups.py: copies go to ~/.dispatch/backups/<date>/<path from home>, never beside the file."""
import datetime
import os
import subprocess
import tempfile
import unittest
from unittest import mock

import backups


class Backups(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(self.home)
        env = mock.patch.dict(os.environ, {"HOME": self.home, "DISPATCH_HOME": os.path.join(self.home, ".dispatch")})
        env.start()
        self.addCleanup(env.stop)
        self.now = datetime.datetime(2026, 10, 8, 9, 30, 0)

    def write(self, rel, text):
        p = os.path.join(self.home, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(text)
        return p

    def read(self, p):
        with open(p) as f:
            return f.read()

    def test_a_copy_goes_under_the_day_at_its_path_from_home_and_nothing_beside_it(self):
        p = self.write(".codex/AGENTS.md", "mine\n")
        kept = backups.save(p, now=self.now)
        self.assertEqual(kept, os.path.join(self.home, ".dispatch", "backups", "2026-10-08", ".codex", "AGENTS.md"))
        self.assertEqual(self.read(kept), "mine\n")
        self.assertEqual(os.listdir(os.path.dirname(p)), ["AGENTS.md"])

    def test_same_content_is_kept_once_and_a_different_one_gets_its_own_time(self):
        p = self.write(".zshrc", "one\n")
        first = backups.save(p, now=self.now)
        self.assertEqual(backups.save(p, now=self.now), first)
        self.write(".zshrc", "two\n")
        second = backups.save(p, now=self.now.replace(hour=10))
        self.assertEqual(second, os.path.join(self.home, ".dispatch", "backups", "2026-10-08", "103000", ".zshrc"))
        self.assertEqual((self.read(first), self.read(second)), ("one\n", "two\n"))

    def test_daily_keeps_the_first_copy_of_the_day_only(self):
        p = self.write(".claude/CLAUDE.md", "before\n")
        first = backups.save(p, now=self.now, daily=True)
        self.write(".claude/CLAUDE.md", "after\n")
        self.assertEqual(backups.save(p, now=self.now.replace(hour=11), daily=True), first)
        self.assertEqual(self.read(first), "before\n")

    def test_a_missing_file_keeps_nothing(self):
        self.assertEqual(backups.save(os.path.join(self.home, "nope")), "")
        self.assertFalse(os.path.exists(backups.root()))

    def test_git_is_the_backup_for_a_committed_unchanged_file_but_not_for_a_changed_one(self):
        repo = os.path.join(self.home, "proj")
        p = self.write("proj/a.txt", "v1\n")
        git = ["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null"]
        subprocess.run(git[:3] + ["init", "-q"], check=True)
        subprocess.run(git + ["add", "a.txt"], check=True)
        subprocess.run(git + ["commit", "-q", "-m", "x"], check=True)
        self.assertEqual(backups.save(p, now=self.now), "")
        self.write("proj/a.txt", "v2\n")
        self.assertTrue(backups.save(p, now=self.now))
        self.assertEqual(backups.save(self.write("proj/new.txt", "n\n"), now=self.now)[-7:], "new.txt")

    def test_move_takes_a_folder_out_of_the_way(self):
        d = os.path.join(self.home, ".dispatch", "skills", "x")
        self.write(".dispatch/skills/x/SKILL.md", "old\n")
        kept = backups.save(d, move=True, now=self.now)
        self.assertFalse(os.path.exists(d))
        self.assertEqual(self.read(os.path.join(kept, "SKILL.md")), "old\n")
        self.assertTrue(kept.endswith(os.path.join("2026-10-08", ".dispatch", "skills", "x")))

    def test_a_link_is_kept_as_a_link_at_its_own_place(self):
        target = self.write("real.js", "// mine\n")
        link = os.path.join(self.home, ".config", "opencode", "plugins", "dispatch.js")
        os.makedirs(os.path.dirname(link))
        os.symlink(target, link)
        kept = backups.save(link, now=self.now)
        self.assertTrue(os.path.islink(kept))
        self.assertIn(os.path.join(".config", "opencode", "plugins"), kept)

    def test_a_file_outside_home_keeps_its_whole_path(self):
        outside = tempfile.mkdtemp()
        p = os.path.join(outside, "f.txt")
        with open(p, "w") as f:
            f.write("x")
        kept = backups.save(p, now=self.now)
        self.assertIn(os.path.join("2026-10-08", backups.OUTSIDE_HOME), kept)
        self.assertTrue(kept.endswith(os.path.realpath(p)))

    def test_prune_removes_old_days_only(self):
        root = backups.root()
        for name in ("2026-08-01", "2026-09-20", "2026-10-08", "legacy-2026-10-08", "agents", "preferences"):
            os.makedirs(os.path.join(root, name))
        gone = backups.prune(30, today=datetime.date(2026, 10, 8))
        self.assertEqual(gone, ["2026-08-01"])
        self.assertEqual(sorted(os.listdir(root)), ["2026-09-20", "2026-10-08", "agents", "legacy-2026-10-08", "preferences"])

    def test_saving_prunes_too(self):
        os.makedirs(os.path.join(backups.root(), "2020-01-01"))
        backups.save(self.write("f", "x"))
        self.assertNotIn("2020-01-01", os.listdir(backups.root()))


if __name__ == "__main__":
    unittest.main()
