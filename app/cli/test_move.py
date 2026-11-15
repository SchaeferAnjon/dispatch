# -*- coding: utf-8 -*-
import base64
import os
import subprocess
import unittest
from unittest.mock import patch

import dplatform as P
import move as M

WINDOWS_READY = True


class Ownership(unittest.TestCase):
    def test_records_owner_on_both_machines_without_waiting_for_board_sync(self):
        h = {"name": "Apple", "ssh": "me@100.64.0.2"}
        with patch.object(M.D, "project_owner_set", return_value={"host": "Apple"}) as local, patch.object(M, "ssh") as remote:
            self.assertEqual(M.set_owner("my project", h), {"host": "Apple"})
            local.assert_called_once_with("my project", "Apple", "100.64.0.2")
            self.assertIn("project 'my project' --owner local --json", remote.call_args.args[1])

    def test_remote_failure_is_reported_after_local_success(self):
        with patch.object(M.D, "project_owner_set", return_value={"host": "Apple"}), patch.object(M, "ssh", side_effect=RuntimeError("offline")):
            result = M.set_owner("demo", {"name": "Apple", "ssh": "me@host"})
            self.assertEqual(result["host"], "Apple")
            self.assertIn("目标机器归属记录失败", result["error"])

    def test_local_store_exit_does_not_skip_target_write(self):
        with patch.object(M.D, "project_owner_set", side_effect=SystemExit(1)), patch.object(M, "ssh") as remote:
            self.assertIn("来源机器归属记录失败", M.set_owner("demo", {"name": "Apple", "ssh": "me@host"})["error"])
            remote.assert_called_once()


class GitConflicts(unittest.TestCase):
    local = {"exists": True, "git": True, "head": "b" * 40, "remote": "git@github.com:me/notesapp.git", "dirty": {"a.swift": "1"}}

    def remote(self, **kw):
        return {"exists": True, "git": True, "head": "a" * 40, "remote": "https://github.com/me/notesapp", "dirty": {}, **kw}

    def test_target_behind_with_identical_uncommitted_edits_is_safe(self):
        # The notesapp case: Mini two commits behind, its uncommitted files identical to the MacBook's.
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
        for u in ("git@github.com:Me/Notesapp.git", "https://github.com/me/notesapp/", "ssh://git@github.com/me/notesapp.git", "https://token@github.com/me/notesapp"):
            self.assertTrue(M.same_remote(u, "git@github.com:me/notesapp.git"), u)


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
    @unittest.skipIf(os.name == "nt", "runs /bin/bash")
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
    def test_working_original_is_closed(self):
        from unittest.mock import patch
        live = [{"agent": "claude-code", "session_id": "s1", "agent_pid": 4242, "state": "working"}]
        alive = {4242}
        with patch.object(M.D, "live_sessions", lambda local_only=False: live), patch.object(M, "own_ancestors", lambda: {1}), patch.object(M, "local_chat", lambda a, s: None), \
             patch.object(M.os, "kill", lambda pid, sig: alive.discard(pid)), patch.object(M.D, "ps_table", lambda: {p: (1, "claude") for p in alive}), \
             patch.object(M.time, "sleep", lambda s: None):
            r = M.stop_original("claude-code", "s1")
            self.assertEqual((r["state"], r["was_working"]), ("stopped", True))
            alive.add(4242)
            self.assertEqual(M.stop_original("claude-code", "s1", force=False)["state"], "working")
            self.assertEqual(M.stop_original("claude-code", "s1", keep=True)["state"], "kept")

    def test_in_app_chat_is_closed_through_chatd_not_killed(self):
        live = [{"agent": "claude-code", "session_id": "s1", "agent_pid": 4242, "state": "idle"}]
        chat = {"session": "claude-code:s1", "lifecycle": "idle", "model": "haiku"}
        with patch.object(M.D, "live_sessions", lambda local_only=False: live), patch.object(M, "own_ancestors", lambda: {1}), \
             patch.object(M, "local_chat", lambda a, s: chat), patch.object(M, "close_chat") as closed, patch.object(M.os, "kill") as kill:
            self.assertEqual(M.stop_original("claude-code", "s1")["state"], "stopped")
            closed.assert_called_once_with("claude-code:s1")
            kill.assert_not_called()
            chat["lifecycle"] = "running"
            self.assertEqual(M.stop_original("claude-code", "s1", force=False)["state"], "working")

    def test_moved_chat_keeps_its_title(self):
        with patch("activity.session_preferences", return_value={"claude-code:s1": {"title_override": "movetest"}}):
            self.assertEqual(M.chat_title("claude-code", "s1", {"title": "own"}), "movetest")
        with patch("activity.session_preferences", return_value={}):
            self.assertEqual(M.chat_title("claude-code", "s1", {"title": "own"}), "own")

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
                self.assertEqual(sorted(r["session_id"] for r in M.project_history("/p/kanban", {"live"})), ["a", "b"])  # pi does not move


@patch.object(P, "IS_WIN", False)
class MoveJobs(unittest.TestCase):
    def test_job_file_lifecycle_and_listing(self):
        import json, os, tempfile, time
        with tempfile.TemporaryDirectory() as tmp, patch.object(M, "JOBS_DIR", tmp):
            job = M.Job.create("readerapp", "阁楼的 Mac", "/x/readerapp")
            job.update(pid=os.getpid())
            job.progress("files", "同步文件 3/10", 30)
            rows = M.list_jobs()
            self.assertEqual([(r["project"], r["state"], r["percent"], r["label"]) for r in rows], [("readerapp", "running", 30, "同步文件 3/10")])
            job.finish({"to": "阁楼的 Mac", "remote_cwd": "/y", "git": {"verify": {"checked": True, "head_match": True, "dirty_match": True}}, "moved": [{"session_id": "a"}, {"session_id": "b", "error": "x"}], "history": {"copied": 5, "failed": []}, "owner": {}})
            done = M.list_jobs()[0]
            self.assertEqual((done["state"], done["percent"], done["result"]["sessions"], done["result"]["sessions_failed"], done["result"]["history"], done["result"]["git_ok"]), ("done", 100, 2, 1, 5, True))
            # A worker that vanished is reported, not shown as running for ever.
            dead = M.Job.create("notesapp", "阁楼的 Mac", "/x/notesapp"); dead.update(pid=999999)
            self.assertEqual(next(r for r in M.list_jobs() if r["id"] == dead.id)["state"], "failed")
            other = M.Job.create("k", "阁楼的 Mac", "/x/k"); other.fail(RuntimeError("boom"))
            self.assertEqual(next(r for r in M.list_jobs() if r["id"] == other.id)["error"], "boom")

    def test_nested_caches_and_worktrees_are_never_copied(self):
        args = M.rsync_args("/a", {"ssh": "u@h"}, "/b", [], False, dry=True)
        for pat in ("node_modules/", ".venv/", ".claude/worktrees/", "__pycache__/"):
            self.assertIn(pat, args)
        if os.name != "nt":  # Windows' OpenSSH has no ControlMaster
            self.assertIn("ControlMaster=auto", args[args.index("-e") + 1])

    def test_progress_reports_every_stage_in_order(self):
        steps = []
        h = {"name": "阁楼的 Mac", "ssh": "u@h", "id": "hub"}
        with patch.object(M, "host_by", return_value=h), patch.object(M, "project_dir", return_value="/x/p"), patch.object(M, "ssh", return_value="/Users/u\n"), \
             patch.object(M, "git_preflight", return_value={"local": {"git": True}, "remote": {}, "conflicts": [], "protect": [], "skip": [], "history": False}), \
             patch.object(M, "plan_files", return_value={"send": 2, "delete": 0}), patch.object(M.D, "live_sessions", return_value=[]), patch.object(M, "project_history", return_value=[]), \
             patch.object(M, "sync_files", side_effect=lambda h, c, r, g, on_file=None, planned=None, on_push=None: on_file and on_file(2)), patch.object(M, "verify_git", return_value={"checked": False}), \
             patch.object(M, "mark_moved"), patch.object(M, "set_owner", return_value={"host": "阁楼的 Mac"}), patch.object(M, "project_name", return_value="p"), \
             patch.object(M, "open_session", return_value={"kind": "claude", "pane_id": "p1"}) as opened:
            res = M.move_project("p", "阁楼的 Mac", progress=lambda step, label, pct, detail="": steps.append((step, pct)))
        self.assertEqual([s for s, _ in steps], ["preflight", "plan", "files", "files", "verify", "sessions", "history", "history", "owner", "done"])
        self.assertEqual([p for _, p in steps], sorted(p for _, p in steps))
        self.assertEqual(res["owner"], {"host": "阁楼的 Mac"})
        # Nothing was running here: the project still carries on over there, in a new session.
        self.assertEqual(opened.call_args.args[:2], (h, "claude")); self.assertEqual(opened.call_args.args[3], "p")
        self.assertEqual(res["opened"]["kind"], "claude")

    @unittest.skipIf(os.name == "nt", "moving a project runs on the Mac side only (Windows says unsupported)")
    def test_running_sessions_move_instead_of_a_new_one_opening(self):
        h = {"name": "Mini", "ssh": "u@h", "id": "hub"}
        live = [{"agent": "codex", "session_id": "s1", "cwd": "/x/p", "state": "idle"}]
        with patch.object(M, "host_by", return_value=h), patch.object(M, "project_dir", return_value="/x/p"), patch.object(M, "ssh", return_value="/Users/u\n"), \
             patch.object(M, "git_preflight", return_value={"local": {"git": True}, "remote": {}, "conflicts": [], "protect": [], "skip": [], "history": False}), \
             patch.object(M, "plan_files", return_value={"send": 0, "delete": 0}), patch.object(M.D, "live_sessions", return_value=live), patch.object(M, "project_history", return_value=[]), \
             patch.object(M, "sync_files"), patch.object(M, "verify_git", return_value={"checked": False}), patch.object(M, "move", return_value={"started": {"pane_id": "p"}}) as moved, \
             patch.object(M, "mark_moved"), patch.object(M, "set_owner", return_value={}), patch.object(M, "project_name", return_value="p"), patch.object(M, "open_session") as opened:
            dry = M.move_project("p", "Mini", dry=True)
            res = M.move_project("p", "Mini")
        self.assertIsNone(dry["new_session"])
        self.assertEqual(moved.call_args.args[0], "s1")
        opened.assert_not_called()
        self.assertNotIn("opened", res)


class RemoteCount(unittest.TestCase):
    def test_parses_wc_output_and_tolerates_garbage(self):
        class R: pass
        for out, want in (("   356\n", 356), ("0\n", 0), ("bash: x\n", 0), ("", 0)):
            r = R(); r.stdout = out
            with patch.object(M, "run_remote", return_value=r):
                self.assertEqual(M.remote_file_count({"ssh": "u@h", "name": "x"}, "/p"), want)
        with patch.object(M, "run_remote") as rr:
            rr.return_value = R(); rr.return_value.stdout = "3\n"
            M.remote_file_count({"ssh": "u@h", "name": "x"}, "/p", skip_git=False)
            self.assertNotIn(".git", rr.call_args.args[1])
            M.remote_file_count({"ssh": "u@h", "name": "x"}, "/p", skip_git=True)
            self.assertIn(".git", rr.call_args.args[1])


class WindowsMove(unittest.TestCase):
    """Moving a project needs ssh into a Mac and rsync: not on Windows v1, said plainly."""

    def test_move_and_move_project_are_unsupported(self):
        with patch.object(P, "IS_WIN", True), patch.object(M, "find_ref", side_effect=AssertionError("nothing is looked up")):
            with self.assertRaises(P.Unsupported):
                M.move("s1", "mini")
            with self.assertRaises(P.Unsupported):
                M.move_project("p", "mini")

    def test_commands_answer_without_an_error_exit(self):
        import contextlib, io, json, types
        for fn in (M.main, M.main_project):
            buf = io.StringIO()
            a = types.SimpleNamespace(json=True, session="s1", to="mini", name="p", move_to="mini", background=False, dry_run=False)
            with patch.object(P, "IS_WIN", True), contextlib.redirect_stdout(buf):
                fn(a)
            r = json.loads(buf.getvalue())
            self.assertTrue(r["unsupported"]); self.assertIn("项目搬家", r["message"])

    def test_a_vanished_worker_is_found_through_the_platform_layer(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp, patch.object(M, "JOBS_DIR", tmp), patch.object(P, "pid_alive", return_value=False) as alive:
            job = M.Job.create("p", "mini", "/x/p"); job.update(pid=4321)
            self.assertEqual(M.list_jobs()[0]["state"], "failed")
        alive.assert_called_with(4321)


if __name__ == "__main__":
    unittest.main()


class PiAndNewSession(unittest.TestCase):
    def test_pi_tool_calls_count_as_commands_used(self):
        import json, tempfile
        line = {"type": "message", "message": {"role": "assistant", "content": [{"type": "toolCall", "name": "bash", "arguments": {"command": "cd x && jq . a.json"}}]}}
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
            f.write(json.dumps(line) + "\n")
        try:
            self.assertEqual(M.commands_used(f.name, "pi"), ["jq"])
        finally:
            os.remove(f.name)

    def test_unsupported_agent_still_refused(self):
        with self.assertRaises(RuntimeError):
            M.transcript_target("gemini", "/x", "/a", "/b", "/b")

    def test_new_session_kind_follows_latest_conversation_or_flag(self):
        hist = [{"agent": "claude-code", "mtime": 1}, {"agent": "codex", "mtime": 5}]
        self.assertEqual(M.new_session_kind(hist), "codex")
        self.assertEqual(M.new_session_kind([]), "claude")
        self.assertEqual(M.new_session_kind(hist, "codex"), "codex")
        self.assertIsNone(M.new_session_kind(hist, "none"))
        self.assertEqual(M.new_session_kind(hist, "claude-code"), "claude")
        with self.assertRaises(RuntimeError):
            M.new_session_kind(hist, "bogus")

    @unittest.skipIf(os.name == "nt", "moving a project runs on the Mac side only (Windows says unsupported)")
    def test_bad_open_session_stops_before_anything_is_touched(self):
        with patch.object(M, "host_by") as host, patch.object(M, "sync_files") as synced:
            with self.assertRaises(RuntimeError):
                M.move_project("p", "Mini", open_kind="bogus")
        host.assert_not_called(); synced.assert_not_called()

    def test_open_session_cli_rejects_unknown_kind(self):
        import sys
        cli = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py")
        r = subprocess.run([sys.executable, cli, "project", "p", "--move-to", "Mini", "--dry-run", "--open-session", "bogus"], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 2)
        self.assertIn("--open-session", r.stderr)

    def test_open_session_trusts_codex_folder_and_starts_it_in_dispatch_there(self):
        h = {"name": "Mini", "ssh": "u@h"}
        class R: returncode, stdout, stderr = 0, '{"session": "codex:th-1", "pane_id": "codex:th-1"}', ""
        with patch.object(M, "trust_folder", return_value="set") as trust, \
             patch.object(M, "run_remote", return_value=R()) as ran, patch.object(M.D, "remote_beads", return_value=""), patch.object(M.D, "remote_cli", return_value="dispatch"):
            res = M.open_session(h, "codex", "/Users/u/p", "p")
        trust.assert_called_once_with(h, "codex", "/Users/u/p")
        self.assertIn("agent start codex", ran.call_args.args[1])
        self.assertEqual((res["trust"], res["session"]), ("set", "codex:th-1"))

    @unittest.skipIf(os.name == "nt", "moving a project runs on the Mac side only (Windows says unsupported)")
    def test_codex_trust_script_appends_entry_once(self):
        import sys, tempfile
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, ".codex"))
            cfg = os.path.join(home, ".codex", "config.toml")
            open(cfg, "w").write('model = "x"')
            run = lambda: subprocess.run([sys.executable, "-", "/Users/u/my p"], input=M.E.get("codex").move_trust_script, capture_output=True, text=True, env={**os.environ, "HOME": home}).stdout.strip()
            self.assertEqual(run(), "set")
            self.assertEqual(run(), "already")
            text = open(cfg).read()
            self.assertEqual(text, 'model = "x"\n[projects."/Users/u/my p"]\ntrust_level = "trusted"\n')
            self.assertTrue(os.path.exists(cfg + ".dispatch-bak"))


class TempMoves(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        for k, v in (("DISPATCH_DIR", self.tmp.name), ("MOVES_FILE", os.path.join(self.tmp.name, "moves.json"))):
            p = patch.object(M.D, k, v); p.start(); self.addCleanup(p.stop)
        self.h = {"id": "mini", "name": "Apple", "ssh": "apple@100.64.0.9"}


class MoveRecords(TempMoves):
    """Both halves of a hand-over record: the original (moved_to) and the copy (moved_from)."""

    def test_original_is_recorded_first_and_confirmed_by_the_peer(self):
        with patch.object(M, "me_for_peer", return_value="100.64.0.1"), patch.object(M, "run_remote", return_value=subprocess.CompletedProcess([], 0, "ok claude-code:s1\n", "")) as rr:
            res = M.mark_moved(self.h, [("claude-code", "s1")], {"claude-code:s1": "/Users/apple/p"})
        self.assertEqual(res, {"marked": 1, "pending": []})
        rec = M.D.load_moves()["claude-code:s1"]
        self.assertEqual((rec["moved_to"], rec["cwd"]), ("mini", "/Users/apple/p"))
        self.assertNotIn("pending_peer", rec)
        self.assertIn("moves mark claude-code:s1 --from 100.64.0.1", rr.call_args.args[1])

    def test_unreachable_peer_leaves_the_original_pending_for_repair(self):
        with patch.object(M, "me_for_peer", return_value="100.64.0.1"), patch.object(M, "run_remote", side_effect=RuntimeError("ssh: timeout")):
            res = M.mark_moved(self.h, [("codex", "c1"), ("claude-code", "s2")])
        self.assertEqual(res["pending"], ["codex:c1", "claude-code:s2"])
        moves = M.D.load_moves()
        self.assertTrue(all(moves[k]["pending_peer"] and moves[k]["moved_to"] == "mini" for k in ("codex:c1", "claude-code:s2")))

    def test_record_keeps_other_keys(self):
        M.D.record_move("codex", "a", moved_from="mini")
        M.D.record_moves({"codex:b": M.D.move_record(moved_to="mini")})
        self.assertEqual(sorted(M.D.load_moves()), ["codex:a", "codex:b"])


class RepairPlan(unittest.TestCase):
    def side(self, name, **rows):
        return {"id": name, "name": name, "rows": {k.replace("_", ":", 1): {"last": 0, "live": False, "title": "", "rec": {}, **v} for k, v in rows.items()}}

    def plan(self, here, peer):
        return {c["key"]: c for c in M.repair_plan(here, peer)}

    def test_missing_records_are_written_on_both_sides_for_a_stale_and_a_continued_copy(self):
        here = self.side("小蓝", **{"claude-code_s1": {"last": 5000}})
        peer = self.side("Apple", **{"claude-code_s1": {"last": 1000}})
        c = self.plan(here, peer)["claude-code:s1"]
        self.assertEqual(c["state"], "fix")
        self.assertEqual(c["writes"], [{"side": "peer", "field": "moved_to"}, {"side": "here", "field": "moved_from"}])

    def test_half_written_move_gets_only_the_missing_half(self):
        here = self.side("小蓝", **{"codex_c1": {"last": 1000, "rec": {"moved_to": "mini", "pending_peer": True}}})
        peer = self.side("Apple", **{"codex_c1": {"last": 900}})  # the copy has said nothing since
        c = self.plan(here, peer)["codex:c1"]
        self.assertEqual((c["state"], c["writes"]), ("fix", [{"side": "peer", "field": "moved_from"}]))
        peer["rows"]["codex:c1"]["rec"] = {"moved_from": "hub"}
        self.assertEqual(self.plan(here, peer)["codex:c1"]["state"], "confirm")

    def test_nothing_is_written_while_a_stale_copy_still_runs(self):
        # 2b529323: moved Apple → 小蓝 (both halves recorded), then resumed on Apple again.
        rec_src, rec_dst = {"moved_to": "hub"}, {"moved_from": "kiwi-mac-mini"}
        here = self.side("小蓝", **{"claude-code_s1": {"last": 9000, "live": True, "rec": rec_dst}})
        peer = self.side("Apple", **{"claude-code_s1": {"last": 2000, "live": True, "rec": rec_src}})
        c = self.plan(here, peer)["claude-code:s1"]
        self.assertEqual((c["state"], c["writes"], c["stale"]), ("both_alive", [], "Apple"))
        here["rows"]["claude-code:s1"]["live"] = False
        self.assertEqual(self.plan(here, peer)["claude-code:s1"]["state"], "stale_alive")

    def test_unclear_forked_and_contradicting_records_are_left_alone(self):
        here = self.side("小蓝", a_1={"last": 1000}, b_2={"last": 9000, "rec": {"moved_to": "mini"}}, c_3={"rec": {"moved_to": "mini"}})
        peer = self.side("Apple", a_1={"last": 1030}, b_2={"last": 1000}, c_3={"rec": {"moved_to": "hub"}})
        p = self.plan(here, peer)
        self.assertEqual({k: v["state"] for k, v in p.items()}, {"a:1": "unclear", "b:2": "forked", "c:3": "conflict"})
        self.assertTrue(all(not v["writes"] for v in p.values()))

    def test_consistent_records_are_ok(self):
        here = self.side("小蓝", x_1={"last": 1000, "rec": {"moved_to": "mini"}})
        peer = self.side("Apple", x_1={"last": 1000, "rec": {"moved_from": "hub"}})
        self.assertEqual(self.plan(here, peer)["x:1"]["state"], "ok")

    def test_an_original_that_went_on_after_the_move_is_forked_once_both_are_closed(self):
        # 2b529323 after pid 82632 ends: moved 09-24 16:10, the Mini copy wrote until 09-25 02:55.
        at = 1790259026
        here = self.side("小蓝", **{"claude-code_s1": {"last": 1790328070, "rec": {"moved_from": "mini", "at": at}}})
        peer = self.side("Apple", **{"claude-code_s1": {"last": 1790297750, "rec": {"moved_to": "hub", "at": at}}})
        c = self.plan(here, peer)["claude-code:s1"]
        self.assertEqual((c["state"], c["writes"], c["stale"], c["moved_at"]), ("forked", [], "Apple", at))
        peer["rows"]["claude-code:s1"]["last"] = at - 30  # it stopped before the move: fine
        self.assertEqual(self.plan(here, peer)["claude-code:s1"]["state"], "ok")

    def test_two_moved_to_records_the_newer_one_wins_and_the_older_side_is_rewritten(self):
        # A to B, then back B to A with the peer half failing: A still says moved_to B.
        T = 1790000000
        here = self.side("小蓝", **{"claude-code_s1": {"last": T + 5000, "rec": {"moved_to": "mini", "at": T}}})
        peer = self.side("Apple", **{"claude-code_s1": {"last": T + 3000, "rec": {"moved_to": "hub", "at": T + 3600, "pending_peer": True}}})
        c = self.plan(here, peer)["claude-code:s1"]
        self.assertEqual((c["state"], c["stale"], c["writes"], c["confirm"]), ("fix", "Apple", [{"side": "here", "field": "moved_from"}], ["peer"]))

    def test_pending_on_the_peer_side_is_confirmed_too(self):
        here = self.side("小蓝", x_1={"last": 1000, "rec": {"moved_from": "mini", "at": 900}})
        peer = self.side("Apple", x_1={"last": 800, "rec": {"moved_to": "hub", "at": 900, "pending_peer": True}})
        c = self.plan(here, peer)["x:1"]
        self.assertEqual((c["state"], c["confirm"]), ("confirm", ["peer"]))

    def test_a_bare_process_counts_as_running_for_its_probable_transcript(self):
        rows = M.side_rows([{"agent": "claude-code", "session_id": "s1", "last_at": 1}], [{"agent": "claude-code", "session_id": "pid-77", "probable_session_id": "s1", "alive": True}], {})
        self.assertTrue(rows["claude-code:s1"]["live"])

    def test_side_rows_prefers_the_transcripts_own_time_and_skips_bare_processes(self):
        rows = M.side_rows([{"agent": "claude-code", "session_id": "s1", "last_at": 99999, "last_ts": "2026-09-25T00:55:50Z"},
                            {"agent": "claude-code", "session_id": "pid-9", "last_at": 1}, {"agent": "zcode", "session_id": "z", "last_at": 1}],
                           [{"agent": "claude-code", "session_id": "s1", "alive": True}], {"claude-code:s1": {"moved_to": "hub"}})
        self.assertEqual(list(rows), ["claude-code:s1"])
        self.assertEqual(rows["claude-code:s1"]["last"], 1790297750.0)
        self.assertTrue(rows["claude-code:s1"]["live"]); self.assertEqual(rows["claude-code:s1"]["rec"], {"moved_to": "hub"})


class Repair(TempMoves):
    def run_repair(self, here, peer, dry, key=""):
        with patch.object(M.D, "hosts", return_value=[self.h]), patch.object(M, "here_view", return_value=here), patch.object(M, "peer_view", return_value=peer), \
             patch.object(M, "mark_peer", side_effect=lambda h, marks: {k for k, _ in marks}) as peer_mark:
            return M.repair(dry=dry, key=key), peer_mark

    def test_dry_run_writes_nothing_and_a_key_limits_the_real_run(self):
        mk = lambda last: {"last": last, "live": False, "title": "", "rec": {}}
        here = {"id": "local", "name": "小蓝", "rows": {"claude-code:s1": mk(5000), "claude-code:s2": mk(5000)}}
        peer = {"id": "mini", "name": "Apple", "rows": {"claude-code:s1": mk(1000), "claude-code:s2": mk(1000)}}
        rows, peer_mark = self.run_repair(here, peer, dry=True)
        self.assertEqual([r["state"] for r in rows], ["fix", "fix"]); peer_mark.assert_not_called()
        self.assertEqual(M.D.load_moves(), {})
        rows, peer_mark = self.run_repair(here, peer, dry=False, key="s1")
        self.assertEqual([(r["key"], r["written"]) for r in rows], [("claude-code:s1", 2)])
        peer_mark.assert_called_once_with(self.h, [("claude-code:s1", "--to")])
        moves = M.D.load_moves()
        self.assertEqual(list(moves), ["claude-code:s1"])
        self.assertEqual((moves["claude-code:s1"]["moved_from"], moves["claude-code:s1"]["repaired"]), ("mini", True))

    def test_real_run_rewrites_a_superseded_record_and_confirms_the_peer(self):
        T = 1790000000
        M.D.record_move("claude-code", "s1", moved_to="mini", at=T, cwd="/x", pending_peer=True)
        here = {"id": "local", "name": "小蓝", "rows": {"claude-code:s1": {"last": T + 5000, "live": False, "title": "", "rec": M.D.load_moves()["claude-code:s1"]}}}
        peer = {"id": "mini", "name": "Apple", "rows": {"claude-code:s1": {"last": T + 3000, "live": False, "title": "", "rec": {"moved_to": "hub", "at": T + 3600, "pending_peer": True}}}}
        rows, peer_mark = self.run_repair(here, peer, dry=False)
        peer_mark.assert_called_once_with(self.h, [("claude-code:s1", "confirm")])
        rec = M.D.load_moves()["claude-code:s1"]
        self.assertEqual((rec.get("moved_from"), rec.get("moved_to"), rec.get("pending_peer"), rec.get("cwd")), ("mini", None, None, None))
        self.assertEqual((rows[0]["written"], rows[0]["failed"]), (2, 0))

    def test_output_lists_unclear_candidates_and_hides_only_ok(self):
        import contextlib, io
        from types import SimpleNamespace
        rows = [{"key": "a:1", "title": "t", "state": "unclear", "stale": "小蓝", "live": "Apple", "stale_at": 1, "live_at": 2, "writes": [], "host": "Apple"},
                {"key": "b:2", "title": "t", "state": "ok", "stale": "小蓝", "live": "Apple", "stale_at": 1, "live_at": 2, "writes": [], "host": "Apple"}]
        with patch.object(M, "repair", return_value=rows), contextlib.redirect_stdout(io.StringIO()) as out:
            M.main_repair(SimpleNamespace(dry_run=True, json=False, key="", to=""))
        self.assertIn("a:1", out.getvalue()); self.assertNotIn("b:2", out.getvalue())

    def test_peer_confirm_falls_back_to_rewriting_the_record_on_an_older_cli(self):
        with patch.object(M, "me_for_peer", return_value="100.64.0.1"), patch.object(M, "run_remote", return_value=subprocess.CompletedProcess([], 0, "ok x:1\n", "")) as rr:
            self.assertEqual(M.mark_peer(self.h, [("x:1", "confirm")]), {"x:1"})
        script = rr.call_args.args[1]
        self.assertIn("moves confirm x:1 ||", script); self.assertIn("moves mark x:1 --to 100.64.0.1", script)

    def test_moves_confirm_cli_drops_pending(self):
        from types import SimpleNamespace
        M.D.record_move("x", "1", moved_to="hub", pending_peer=True)
        import contextlib, io
        with contextlib.redirect_stdout(io.StringIO()):
            M.D.cmd_moves(SimpleNamespace(op="confirm", key="x:1", to="", from_="", json=True))
        self.assertNotIn("pending_peer", M.D.load_moves()["x:1"])

    @unittest.skipIf(os.name == "nt", "moving a project runs on the Mac side only (Windows says unsupported)")
    def test_move_without_target_explains_itself_and_repair_routes(self):
        from types import SimpleNamespace
        with patch.object(M, "main_repair") as rep:
            M.main(SimpleNamespace(session="repair", to="", dry_run=True, json=False, key=""))
            rep.assert_called_once()
        import contextlib, io
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(io.StringIO()) as out:
            M.main(SimpleNamespace(session="abc", to="", dry_run=False, json=False))
        self.assertIn("move repair", out.getvalue())
