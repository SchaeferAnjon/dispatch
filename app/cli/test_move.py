import base64
import subprocess
import unittest

import move as M


class GitConflicts(unittest.TestCase):
    local = {"exists": True, "git": True, "head": "b" * 40, "remote": "git@github.com:me/atrium.git", "dirty": {"a.swift": "1"}}

    def remote(self, **kw):
        return {"exists": True, "git": True, "head": "a" * 40, "remote": "https://github.com/me/atrium", "dirty": {}, **kw}

    def test_target_behind_with_identical_uncommitted_edits_is_safe(self):
        # The atrium case: Mini two commits behind, its uncommitted files identical to the MacBook's.
        r = self.remote(dirty={"a.swift": "1", "new.swift": "9"})
        self.assertEqual(M.git_conflicts(self.local, r, lambda c: True, {"a.swift": "1", "new.swift": "9"}.get), [])

    def test_target_commits_or_differing_edits_stop_the_move(self):
        out = M.git_conflicts(self.local, self.remote(dirty={"x.py": "2"}), lambda c: False, lambda p: None)
        self.assertEqual(len(out), 2)
        self.assertIn("提交", out[0]); self.assertIn("x.py", out[1])

    def test_different_repository_or_non_git_target(self):
        self.assertIn("不是同一个仓库", M.git_conflicts(self.local, self.remote(remote="git@github.com:me/other.git"), lambda c: True, lambda p: None)[0])
        self.assertTrue(M.git_conflicts(self.local, {"exists": True, "git": False}, lambda c: True, lambda p: None))
        self.assertEqual(M.git_conflicts(self.local, {"exists": False}, lambda c: False, lambda p: None), [])

    def test_stash_only_on_target_is_kept_not_a_conflict(self):
        # History travels by git push and .git is never mirrored, so Mini's own stash survives.
        self.assertEqual(M.git_conflicts({**self.local, "stashes": ["s1"]}, self.remote(stashes=["s1", "s2"]), lambda c: True, lambda p: None), [])
        args = M.rsync_args("/a", {"ssh": "u@h"}, "/b", [".git/"], delete=True, dry=False, history=True)
        self.assertIn("--exclude=/.git/", args); self.assertIn("-c", args)

    def test_same_remote_spellings(self):
        for u in ("git@github.com:Me/Atrium.git", "https://github.com/me/atrium/", "ssh://git@github.com/me/atrium.git", "https://token@github.com/me/atrium"):
            self.assertTrue(M.same_remote(u, "git@github.com:me/atrium.git"), u)


class Rsync(unittest.TestCase):
    def test_delete_mirrors_but_protects_what_only_the_target_owns(self):
        protect = M.protected_paths({"git": True, "ignored": ["build/", "Sources/Private/"]})
        self.assertEqual(protect, [".git/", "Sources/Private/", "build/"])
        args = M.rsync_args("/Users/a/p", {"ssh": "u@h"}, "/Users/u/p", protect, delete=True, dry=True, skip=["build/"])
        self.assertIn("--delete", args); self.assertNotIn("--delete-excluded", args)
        self.assertIn("--filter=P /build/", args); self.assertIn("--filter=P /.git/", args); self.assertIn("--exclude=/build/", args); self.assertIn("-n", args)
        self.assertNotIn("--delete", M.rsync_args("/a", {"ssh": "u@h"}, "/b", [], delete=False, dry=False))

    def test_build_output_is_not_copied_but_private_sources_are(self):
        local = {"ignored": ["build/", "Sources/Private/", "server/mcp/node_modules/", ".env", "build-device/", "out.log"]}
        self.assertEqual(M.build_excludes(local), ["build-device/", "build/", "server/mcp/node_modules/"])

    def test_itemized_output(self):
        # Sending to another host is '<f'; openrsync repeats lines.
        out = M.parse_itemized("cd+++++++ keep/\n<f+++++++ keep/a\n<f+++++++ keep/a\n>f+++++++ local/b\n*deleting stale/y\n*deleting stale/y\n.d..t.... ./\n")
        self.assertEqual((out["send"], out["delete"]), (2, 1))
        self.assertEqual(out["send_sample"], ["keep/a", "local/b"])


class RemoteShell(unittest.TestCase):
    def test_bash_line_survives_fish_and_backslashes(self):
        script = 'for c in node; do echo "$c\\\\n"; done'
        line = M.bash_line(script)
        self.assertNotIn("\\", line); self.assertEqual(line.count("'"), 2)
        b64 = line.split("printf %s ")[1].split(" ")[0]
        self.assertEqual(base64.b64decode(b64).decode(), script)
        # And bash really runs it (the login shell over ssh only sees one quoted word).
        r = subprocess.run(["/bin/bash", "-c", line.split("-c ", 1)[1].strip("'")], capture_output=True, text=True)
        self.assertEqual(r.stdout, "node\\n\n")


if __name__ == "__main__":
    unittest.main()
