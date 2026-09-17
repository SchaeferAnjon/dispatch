import base64
import subprocess
import unittest
from unittest.mock import patch

import move as M


class Ownership(unittest.TestCase):
    def test_records_owner_on_both_machines_without_waiting_for_board_sync(self):
        h = {"name": "Apple", "ssh": "apple@100.118.80.86"}
        with patch.object(M.D, "project_owner_set", return_value={"host": "Apple"}) as local, patch.object(M, "ssh") as remote:
            self.assertEqual(M.set_owner("my project", h), {"host": "Apple"})
            local.assert_called_once_with("my project", "Apple", "100.118.80.86")
            self.assertIn("project 'my project' --owner local --json", remote.call_args.args[1])

    def test_remote_failure_is_reported_after_local_success(self):
        with patch.object(M.D, "project_owner_set", return_value={"host": "Apple"}), patch.object(M, "ssh", side_effect=RuntimeError("offline")):
            result = M.set_owner("demo", {"name": "Apple", "ssh": "apple@host"})
            self.assertEqual(result["host"], "Apple")
            self.assertIn("目标机器归属记录失败", result["error"])

    def test_local_store_exit_does_not_skip_target_write(self):
        with patch.object(M.D, "project_owner_set", side_effect=SystemExit(1)), patch.object(M, "ssh") as remote:
            self.assertIn("来源机器归属记录失败", M.set_owner("demo", {"name": "Apple", "ssh": "apple@host"})["error"])
            remote.assert_called_once()


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
        self.assertIn("--exclude=/.git/", args); self.assertIn("--modify-window=2", args); self.assertNotIn("-c", args)

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


class HandOver(unittest.TestCase):
    def test_working_original_is_closed_with_its_pane(self):
        from unittest.mock import patch
        live = [{"agent": "claude-code", "session_id": "s1", "agent_pid": 4242, "state": "working", "herdr": {"pane_id": "w1:p3"}}]
        alive = {4242}
        herdr_calls = []
        with patch.object(M.D, "live_sessions", lambda local_only=False: live), patch.object(M, "own_ancestors", lambda: {1}), \
             patch.object(M.os, "kill", lambda pid, sig: alive.discard(pid)), patch.object(M.D, "ps_table", lambda: {p: (1, "claude") for p in alive}), \
             patch.object(M.D, "herdr", lambda host, args, **kw: herdr_calls.append(args) or {"result": {}}), patch.object(M.time, "sleep", lambda s: None):
            r = M.stop_original("claude-code", "s1")
            self.assertEqual((r["state"], r["was_working"], r["pane_closed"]), ("stopped", True, True))
            self.assertEqual(herdr_calls, [["pane", "close", "w1:p3"]])
            alive.add(4242)
            self.assertEqual(M.stop_original("claude-code", "s1", force=False)["state"], "working")
            self.assertEqual(M.stop_original("claude-code", "s1", keep=True)["state"], "kept")

    def test_history_is_the_projects_other_claude_and_codex_conversations(self):
        import os, tempfile
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as t:
            paths = {n: os.path.join(t, n) for n in ("a", "b", "c", "d", "e")}
            for p in paths.values():
                open(p, "w").close()
            idx = {paths["a"]: {"agent": "claude-code", "session_id": "a", "cwd": "/p/kanban/app"}, paths["b"]: {"agent": "codex", "session_id": "b", "cwd": "/p/kanban"},
                   paths["c"]: {"agent": "pi", "session_id": "c", "cwd": "/p/kanban"}, paths["d"]: {"agent": "claude-code", "session_id": "d", "cwd": "/p/kanban-wt/x"},
                   paths["e"]: {"agent": "claude-code", "session_id": "live", "cwd": "/p/kanban"}}
            with patch.object(M.D, "load_index", lambda: idx):
                self.assertEqual(sorted(r["session_id"] for r in M.project_history("/p/kanban", {"live"})), ["a", "b"])


if __name__ == "__main__":
    unittest.main()


class MoveJobs(unittest.TestCase):
    def test_job_file_lifecycle_and_listing(self):
        import json, os, tempfile, time
        with tempfile.TemporaryDirectory() as tmp, patch.object(M, "JOBS_DIR", tmp):
            job = M.Job.create("relecture", "大哥", "/x/relecture")
            job.update(pid=os.getpid())
            job.progress("files", "同步文件 3/10", 30)
            rows = M.list_jobs()
            self.assertEqual([(r["project"], r["state"], r["percent"], r["label"]) for r in rows], [("relecture", "running", 30, "同步文件 3/10")])
            job.finish({"to": "大哥", "remote_cwd": "/y", "git": {"verify": {"checked": True, "head_match": True, "dirty_match": True}}, "moved": [{"session_id": "a"}, {"session_id": "b", "error": "x"}], "history": {"copied": 5, "failed": []}, "owner": {}})
            done = M.list_jobs()[0]
            self.assertEqual((done["state"], done["percent"], done["result"]["sessions"], done["result"]["sessions_failed"], done["result"]["history"], done["result"]["git_ok"]), ("done", 100, 2, 1, 5, True))
            # A worker that vanished is reported, not shown as running for ever.
            dead = M.Job.create("atrium", "大哥", "/x/atrium"); dead.update(pid=999999)
            self.assertEqual(next(r for r in M.list_jobs() if r["id"] == dead.id)["state"], "failed")
            other = M.Job.create("k", "大哥", "/x/k"); other.fail(RuntimeError("boom"))
            self.assertEqual(next(r for r in M.list_jobs() if r["id"] == other.id)["error"], "boom")

    def test_nested_caches_and_worktrees_are_never_copied(self):
        args = M.rsync_args("/a", {"ssh": "u@h"}, "/b", [], False, dry=True)
        for pat in ("node_modules/", ".venv/", ".claude/worktrees/", "__pycache__/"):
            self.assertIn(pat, args)
        self.assertIn("ControlMaster=auto", args[args.index("-e") + 1])

    def test_progress_reports_every_stage_in_order(self):
        steps = []
        h = {"name": "大哥", "ssh": "u@h", "id": "hub"}
        with patch.object(M, "host_by", return_value=h), patch.object(M, "project_dir", return_value="/x/p"), patch.object(M, "ssh", return_value="/Users/u\n"), \
             patch.object(M, "git_preflight", return_value={"local": {"git": True}, "remote": {}, "conflicts": [], "protect": [], "skip": [], "history": False}), \
             patch.object(M, "plan_files", return_value={"send": 2, "delete": 0}), patch.object(M.D, "live_sessions", return_value=[]), patch.object(M, "project_history", return_value=[]), \
             patch.object(M, "sync_files", side_effect=lambda h, c, r, g, on_file=None: on_file and on_file(2)), patch.object(M, "verify_git", return_value={"checked": False}), \
             patch.object(M, "mark_moved"), patch.object(M, "set_owner", return_value={"host": "大哥"}), patch.object(M, "project_name", return_value="p"):
            res = M.move_project("p", "大哥", progress=lambda step, label, pct, detail="": steps.append((step, pct)))
        self.assertEqual([s for s, _ in steps], ["preflight", "plan", "files", "files", "verify", "history", "history", "owner", "done"])
        self.assertEqual([p for _, p in steps], sorted(p for _, p in steps))
        self.assertEqual(res["owner"], {"host": "大哥"})
