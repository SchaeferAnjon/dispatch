# -*- coding: utf-8 -*-
"""dispatch checkpoint: shadow-git snapshots per turn, list / diff / restore with conflicts,
rollback_from, editor baselines, notes and gc, in a git repository and in a plain folder."""
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import checkpoint as C  # noqa: E402

WINDOWS_READY = True


def write(root, rel, text, mode=None):
    full = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "wb") as f:
        f.write(text.encode("utf-8") if isinstance(text, str) else text)
    if mode:
        os.chmod(full, mode)


def read(root, rel):
    with open(os.path.join(root, *rel.split("/")), "rb") as f:
        return f.read().decode("utf-8")


class Base(unittest.TestCase):
    git = False

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = os.path.join(self.tmp.name, "dispatch")
        env = mock.patch.dict(os.environ, {"DISPATCH_DIR": self.base})
        env.start()
        self.addCleanup(env.stop)
        self.root = os.path.realpath(os.path.join(self.tmp.name, "proj"))
        os.mkdir(self.root)
        if self.git:
            subprocess.run(["git", "init", "-q", self.root], check=True)
        write(self.root, "a.txt", "one\n")
        write(self.root, "keep.txt", "keep\n")
        write(self.root, ".gitignore", "*.log\n")
        write(self.root, "debug.log", "noise\n")

    def cli(self, *args):
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertEqual(C.main(list(args) + ["--root", self.root, "--json"]), 0)
        return json.loads(buf.getvalue())

    def turn(self, text="turn", sid="claude-code:abc123", mid=""):
        r = C.begin(self.root, sid, mid or text, text)
        self.assertIn("turn_id", r, r)
        return r["turn_id"]


class Snapshots(Base):
    def test_two_snapshots_diff_and_the_list(self):
        tid = self.turn("edit a", mid="m1")
        write(self.root, "a.txt", "two\n")
        write(self.root, "sub/new.txt", "new\n")
        os.remove(os.path.join(self.root, "keep.txt"))
        rec = C.finish(self.root, tid, agent_turn_id="t-9")
        self.assertEqual(sorted((f["path"], f["status"]) for f in rec["files_changed"]), [("a.txt", "M"), ("keep.txt", "D"), ("sub/new.txt", "A")])
        d = self.cli("diff", "--turn", "m1", "--patch")
        self.assertEqual({f["path"]: (f["add"], f["del"]) for f in d["files"]}, {"a.txt": (1, 1), "keep.txt": (0, 1), "sub/new.txt": (1, 0)})
        self.assertIn("+two", d["patch"])
        lst = self.cli("list")
        self.assertEqual([t["turn_id"] for t in lst["turns"]], [tid])
        self.assertEqual((lst["turns"][0]["message_id"], lst["turns"][0]["agent_turn_id"], lst["turns"][0]["text"]), ("m1", "t-9", "edit a"))
        self.assertEqual(self.cli("list", "--sid", "codex:other1")["turns"], [])
        # the turn id, the message id and the agent's turn id all find it
        self.assertEqual(self.cli("diff", "--turn", "t-9")["to"], rec["after_tree"])

    def test_ignored_and_big_files_are_left_out(self):
        write(self.root, "node_modules/x/index.js", "x")
        write(self.root, "big.bin", b"\0" * (C.BIG_FILE + 1))
        tid = self.turn()
        sh = C.Shadow(self.root)
        paths = set(sh.tree_map(sh.load()["turns"][0]["before_tree"]))
        self.assertEqual(paths, {".gitignore", "a.txt", "keep.txt"})
        # a file that grows past the limit leaves the snapshot instead of keeping a stale copy
        write(self.root, "a.txt", b"a" * (C.BIG_FILE + 1))
        rec = C.finish(self.root, tid)
        self.assertNotIn("a.txt", sh.tree_map(rec["after_tree"]))

    def test_home_and_root_are_refused(self):
        r = C.begin(os.path.expanduser("~"), "", "m", "x")
        self.assertEqual(r["error"], "root_too_broad")
        r = C.begin(os.path.join(self.tmp.name, "missing"), "", "m", "x")
        self.assertEqual(r["error"], "no_root")

    def test_too_many_new_files_is_refused_and_not_rescanned_for_a_while(self):
        for i in range(6):
            write(self.root, "many/f%d.txt" % i, str(i))
        with mock.patch.object(C, "MAX_NEW_FILES", 5):
            r = C.begin(self.root, "", "m", "x")
            self.assertEqual(r["error"], "too_many_files")
            with mock.patch.object(C.Shadow, "snapshot", side_effect=AssertionError("scanned again")):
                self.assertEqual(C.begin(self.root, "", "m2", "x")["error"], "too_many_files")

    def test_a_stale_index_lock_does_not_break_every_later_snapshot(self):
        self.turn("first", mid="m1")
        sh = C.Shadow(self.root)
        lock = os.path.join(sh.dir, "index.lock")
        open(lock, "w").close()  # left over from a git killed mid-write (chatd killed)
        ref_lock = os.path.join(sh.git_dir, "refs", "cp", "x.lock")
        os.makedirs(os.path.dirname(ref_lock), exist_ok=True)
        open(ref_lock, "w").close()
        write(self.root, "a.txt", "two\n")
        r = C.begin(self.root, "", "m2", "second")
        self.assertIn("turn_id", r, r)
        self.assertFalse(os.path.exists(lock) or os.path.exists(ref_lock))

    def test_a_git_timeout_cleans_its_lock_and_skips_the_folder_for_a_while(self):
        self.turn("first", mid="m1")
        sh = C.Shadow(self.root)
        write(self.root, "a.txt", "two\n")
        real = C.subprocess.run

        def slow(args, **kw):
            if "update-index" in args:
                open(os.path.join(sh.dir, "index.lock"), "w").close()  # git got this far before the kill
                raise C.subprocess.TimeoutExpired(args, kw.get("timeout"))
            return real(args, **kw)
        with mock.patch.object(C.subprocess, "run", side_effect=slow):
            r = C.begin(self.root, "", "m2", "x")
        self.assertEqual(r["error"], "git_failed")
        self.assertIn("update-index took longer", r["message"])
        self.assertFalse(os.path.exists(os.path.join(sh.dir, "index.lock")))
        with mock.patch.object(C.Shadow, "snapshot", side_effect=AssertionError("scanned again")):
            self.assertEqual(C.begin(self.root, "", "m3", "x")["message"], "skipped")
        # once the skip runs out, snapshots work again
        C._refused.clear()
        data = sh.load(); data["skip_until"] = 0; sh.save(data)
        self.assertIn("turn_id", C.begin(self.root, "", "m4", "x"))

    def test_too_many_bytes_is_refused_quickly_and_not_rescanned(self):
        write(self.root, "big/a.bin", os.urandom(3000))
        write(self.root, "big/b.bin", os.urandom(3000))
        with mock.patch.object(C, "MAX_NEW_BYTES", 4000):
            r = C.begin(self.root, "", "m", "x")
            self.assertEqual(r["error"], "too_many_files")
            self.assertIn("MB", r["message"])
            with mock.patch.object(C.Shadow, "snapshot", side_effect=AssertionError("scanned again")):
                self.assertEqual(C.begin(self.root, "", "m2", "x")["error"], "too_many_files")
        # nothing was copied into the shadow repository
        sh = C.Shadow(self.root)
        objects = sum(len(f) for _t, _d, f in os.walk(os.path.join(sh.git_dir, "objects")) if "pack" not in _t and "info" not in _t)
        self.assertEqual(objects, 0)

    def test_discard_forgets_a_turn(self):
        tid = self.turn()
        self.assertTrue(C.discard(self.root, tid))
        self.assertEqual(self.cli("list")["turns"], [])

    def test_bad_arguments_answer_json(self):
        self.assertEqual(self.cli("restore")["error"], "bad_request")
        self.assertEqual(self.cli("restore", "--turn", "nope")["error"], "no_such_turn")
        buf = io.StringIO()
        with redirect_stdout(buf):
            C.main(["frobnicate", "--json"])
        self.assertEqual(json.loads(buf.getvalue())["error"], "bad_request")


class Restore(Base):
    def agent_turn(self):
        tid = self.turn("change things", mid="m1")
        write(self.root, "a.txt", "two\n")
        write(self.root, "sub/deep/new.txt", "new\n")
        os.remove(os.path.join(self.root, "keep.txt"))
        C.finish(self.root, tid)
        return tid

    def test_restore_brings_back_content_deletes_new_files_and_can_be_undone(self):
        self.agent_turn()
        dry = self.cli("restore", "--turn", "m1", "--dry-run")
        self.assertEqual(dry["files"], [{"path": "a.txt", "action": "restore"}, {"path": "keep.txt", "action": "create"}, {"path": "sub/deep/new.txt", "action": "delete"}])
        self.assertEqual(dry["conflicts"], [])
        self.assertEqual(read(self.root, "a.txt"), "two\n")  # a dry run changes nothing
        r = self.cli("restore", "--turn", "m1", "--sid", "claude-code:abc123")
        self.assertTrue(r["ok"], r)
        self.assertEqual((sorted(r["restored"]), r["deleted"]), (["a.txt", "keep.txt"], ["sub/deep/new.txt"]))
        self.assertEqual((read(self.root, "a.txt"), read(self.root, "keep.txt")), ("one\n", "keep\n"))
        self.assertFalse(os.path.exists(os.path.join(self.root, "sub")))  # emptied folders go too
        self.assertEqual(read(self.root, "debug.log"), "noise\n")  # ignored files are never touched
        self.assertIn("a.txt", r["note"])
        # the restore is a record of its own (rollback_from): restoring it undoes the restore
        lst = self.cli("list")["turns"]
        self.assertEqual((lst[0]["kind"], lst[0]["turn_id"], lst[0]["restored_turn"]), ("restore", r["rollback_from"], lst[1]["turn_id"]))
        back = self.cli("restore", "--turn", r["rollback_from"], "--no-note")
        self.assertTrue(back["ok"], back)
        self.assertEqual((read(self.root, "a.txt"), read(self.root, "sub/deep/new.txt")), ("two\n", "new\n"))
        self.assertFalse(os.path.exists(os.path.join(self.root, "keep.txt")))

    def test_later_edits_are_a_conflict_until_forced(self):
        self.agent_turn()
        write(self.root, "a.txt", "two, then yours\n")   # you edited after the agent finished
        write(self.root, "yours.txt", "brand new\n")      # and created a file
        r = self.cli("restore", "--turn", "m1")
        self.assertEqual((r["ok"], r["error"]), (False, "conflict"))
        self.assertEqual(r["files"], ["a.txt", "yours.txt"])
        self.assertEqual(read(self.root, "a.txt"), "two, then yours\n")
        self.assertTrue(os.path.exists(os.path.join(self.root, "sub/deep/new.txt")))  # nothing happened
        dry = self.cli("restore", "--turn", "m1", "--dry-run")
        self.assertEqual(dry["conflicts"], ["a.txt", "yours.txt"])
        # only the clean ones
        r = self.cli("restore", "--turn", "m1", "--only-clean")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["skipped"], ["a.txt", "yours.txt"])
        self.assertEqual((read(self.root, "a.txt"), read(self.root, "keep.txt")), ("two, then yours\n", "keep\n"))
        self.assertFalse(os.path.exists(os.path.join(self.root, "sub/deep/new.txt")))
        # everything
        r = self.cli("restore", "--turn", "m1", "--force")
        self.assertTrue(r["ok"], r)
        self.assertEqual(read(self.root, "a.txt"), "one\n")
        self.assertFalse(os.path.exists(os.path.join(self.root, "yours.txt")))

    def test_a_later_turn_counts_as_the_agents_state(self):
        self.agent_turn()
        t2 = self.turn("second", mid="m2")
        write(self.root, "a.txt", "three\n")
        C.finish(self.root, t2)
        r = self.cli("restore", "--turn", "m1")
        self.assertTrue(r["ok"], r)
        self.assertEqual(read(self.root, "a.txt"), "one\n")

    def test_a_turn_without_an_after_snapshot_is_all_conflicts(self):
        self.turn("running", mid="m1")
        write(self.root, "a.txt", "mid-turn\n")
        r = self.cli("restore", "--turn", "m1")
        self.assertEqual((r["error"], r["files"]), ("conflict", ["a.txt"]))

    def registry(self, lifecycle, cwd=None):
        with open(os.path.join(self.base, "chatd.json"), "w") as f:
            json.dump({"pid": os.getpid(), "sessions": {"claude-code:abc123": {"agent": "claude-code", "cwd": cwd or self.root, "lifecycle": lifecycle}}}, f)

    def test_no_restore_while_an_agent_works_in_the_project(self):
        self.agent_turn()
        t2 = self.turn("second", mid="m2")        # the agent is on its second turn
        write(self.root, "half.py", "half\n")
        os.makedirs(self.base, exist_ok=True)
        self.registry("running", cwd=os.path.join(self.root))
        r = self.cli("restore", "--turn", "m1", "--only-clean")
        self.assertEqual((r["ok"], r["error"], r["sessions"]), (False, "running", ["claude-code:abc123"]))
        self.assertEqual(read(self.root, "a.txt"), "two\n")  # nothing changed under the agent
        dry = self.cli("restore", "--turn", "m1", "--dry-run")
        self.assertEqual(dry["running"], ["claude-code:abc123"])
        # its turn's after snapshot is its own work only
        rec = C.finish(self.root, t2)
        self.assertEqual([f["path"] for f in rec["files_changed"]], ["half.py"])
        # a session elsewhere, or one that is idle, does not block
        self.registry("running", cwd=self.tmp.name)
        self.assertEqual(self.cli("restore", "--turn", "m2", "--dry-run")["running"], [])
        self.registry("idle")
        self.assertTrue(self.cli("restore", "--turn", "m2", "--force")["ok"])

    def test_a_file_no_agent_edit_tool_wrote_is_not_deleted_unasked(self):
        self.agent_turn()
        t2 = self.turn("second", mid="m2")
        write(self.root, "user_notes.md", "mine\n")   # you, while the agent ran
        write(self.root, "agent2.txt", "agent\n")     # the agent's Write tool
        C.finish(self.root, t2, agent_paths=[os.path.join(self.root, "agent2.txt"), "/elsewhere/x.txt"])
        dry = self.cli("restore", "--turn", "m2", "--dry-run")
        self.assertEqual(dry["files"], [{"path": "agent2.txt", "action": "delete"}, {"path": "user_notes.md", "action": "delete"}])
        self.assertEqual((dry["conflicts"], dry["unsure"]), (["user_notes.md"], ["user_notes.md"]))
        r = self.cli("restore", "--turn", "m2")
        self.assertEqual((r["error"], r["files"], r["unsure"]), ("conflict", ["user_notes.md"], ["user_notes.md"]))
        r = self.cli("restore", "--turn", "m2", "--only-clean")
        self.assertEqual((r["deleted"], r["skipped"]), (["agent2.txt"], ["user_notes.md"]))
        self.assertEqual(read(self.root, "user_notes.md"), "mine\n")

    def test_bytes_line_endings_and_modes_come_back_exactly(self):
        write(self.root, "crlf.txt", b"x\r\ny\r\n")
        write(self.root, "run.sh", "#!/bin/sh\necho hi\n", mode=0o755)
        write(self.root, "blob.bin", bytes(range(256)))
        tid = self.turn(mid="m1")
        write(self.root, "crlf.txt", b"changed\n")
        write(self.root, "run.sh", "echo changed\n", mode=0o644)
        write(self.root, "blob.bin", b"\0\0")
        C.finish(self.root, tid)
        r = self.cli("restore", "--turn", "m1")
        self.assertTrue(r["ok"], r)
        with open(os.path.join(self.root, "crlf.txt"), "rb") as f:
            self.assertEqual(f.read(), b"x\r\ny\r\n")
        with open(os.path.join(self.root, "blob.bin"), "rb") as f:
            self.assertEqual(f.read(), bytes(range(256)))
        if os.name != "nt":
            self.assertTrue(os.stat(os.path.join(self.root, "run.sh")).st_mode & 0o100)

    def test_notes_wait_for_the_session_and_expire(self):
        self.agent_turn()
        r = self.cli("restore", "--turn", "m1")
        self.assertTrue(r["ok"])
        self.assertEqual(C.take_notes("claude-code:abc123"), [r["note"]])
        self.assertEqual(C.take_notes("claude-code:abc123"), [])
        C.add_note("claude-code:abc123", "old")
        with mock.patch.object(C.time, "time", return_value=time.time() + C.NOTE_TTL + 5):
            self.assertEqual(C.take_notes("claude-code:abc123"), [])
        # --no-note leaves nothing behind
        self.agent_turn()
        r = self.cli("restore", "--turn", "m1", "--no-note")
        self.assertEqual(C.take_notes("claude-code:abc123"), [])

    def test_editor_baselines_taken_after_the_turn_are_reset(self):
        import editor
        sid = "claude-code:abc123"
        write(self.root, "b.txt", "b0\n")
        # a baseline from before the turn (the agent changed b.txt earlier) stays
        editor.capture_baseline(sid, self.root, [os.path.join(self.root, "b.txt")], dispatch_dir=self.base)
        write(self.root, "b.txt", "b1\n")
        time.sleep(0.01)
        tid = self.turn(mid="m1")
        time.sleep(0.01)
        editor.capture_baseline(sid, self.root, [os.path.join(self.root, "a.txt"), os.path.join(self.root, "n.txt")], dispatch_dir=self.base)
        write(self.root, "a.txt", "two\n")
        write(self.root, "b.txt", "b2\n")
        write(self.root, "n.txt", "new\n")
        C.finish(self.root, tid)
        r = self.cli("restore", "--turn", "m1")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["baselines_reset"], ["a.txt", "n.txt"])
        st = editor.Store(sid, self.base)
        idx = st.load()
        self.assertEqual(sorted(idx["files"]), ["a.txt", "b.txt"])
        self.assertEqual(st.base_text(idx, "a.txt"), "one\n")
        self.assertEqual(st.base_text(idx, "b.txt"), "b0\n")  # the change before the turn is still there to review
        self.assertEqual(read(self.root, "b.txt"), "b1\n")


class RestoreInGit(Restore):
    git = True

    def test_the_projects_own_git_is_untouched(self):
        self.agent_turn()
        self.cli("restore", "--turn", "m1")
        out = subprocess.run(["git", "-C", self.root, "status", "--porcelain"], capture_output=True, text=True).stdout
        self.assertIn("?? a.txt", out)  # nothing was added to the project's own index
        self.assertEqual(subprocess.run(["git", "-C", self.root, "ls-files"], capture_output=True, text=True).stdout, "")

    def test_a_subfolder_cwd_uses_the_repository_top(self):
        os.mkdir(os.path.join(self.root, "pkg"))
        r = C.begin(os.path.join(self.root, "pkg"), "", "m", "x")
        self.assertEqual(r["root"], self.root)


class Gc(Base):
    def test_old_and_surplus_turns_go_and_their_objects_with_them(self):
        ids = [self.turn("t%d" % i, mid="m%d" % i) for i in range(4)]
        sh = C.Shadow(self.root)
        with mock.patch.object(C, "KEEP_TURNS", 2):
            r = C.gc_all(force=True)
        self.assertEqual(list(r["projects"].values())[0], {"kept": 2, "dropped": 2, "removed": False})
        self.assertEqual([t["turn_id"] for t in sh.load()["turns"]], ids[2:])
        refs = sh.git(["for-each-ref", "--format=%(refname)"]).decode()
        self.assertNotIn(ids[0], refs)
        self.assertIn(ids[3], refs)
        # the stamp keeps it to once a day
        self.assertTrue(C.gc_all()["skipped"])

    def test_a_project_with_only_old_turns_is_removed(self):
        self.turn()
        sh = C.Shadow(self.root)
        with mock.patch.object(C.time, "time", return_value=time.time() + (C.KEEP_DAYS + 1) * 86400):
            C.gc_all(force=True)
        self.assertFalse(os.path.exists(sh.dir))


if __name__ == "__main__":
    unittest.main()
