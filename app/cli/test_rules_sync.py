# -*- coding: utf-8 -*-
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import dispatch  # noqa: E402
import rules_sync as RS  # noqa: E402  (the same `dispatch` instance rules_sync calls into)


def state(exists=True, content="", mtime=0.0):
    return {"exists": exists, "content": content, "hash": RS._hash(content) if exists else "", "mtime": mtime}


class Resolve(unittest.TestCase):
    """`_resolve` is the whole conflict/newer-wins decision, and it is pure — no I/O."""

    def test_both_missing_is_noop(self):
        self.assertEqual(RS._resolve(state(False), state(False), None, "auto", True)[0], "noop")

    def test_identical_content_is_noop_even_without_prior_state(self):
        a, b = state(True, "same"), state(True, "same")
        self.assertEqual(RS._resolve(a, b, None, "auto", True)[0], "noop")

    def test_only_local_has_the_file(self):
        self.assertEqual(RS._resolve(state(True, "x"), state(False), None, "auto", True)[0], "to_remote")

    def test_only_remote_has_the_file(self):
        self.assertEqual(RS._resolve(state(False), state(True, "x"), None, "auto", True)[0], "to_local")

    def test_fast_forward_local_changed_alone(self):
        last = RS._hash("old")
        loc, rem = state(True, "new"), state(True, "old")
        self.assertEqual(RS._resolve(loc, rem, last, "auto", True)[0], "to_remote")

    def test_fast_forward_remote_changed_alone(self):
        last = RS._hash("old")
        loc, rem = state(True, "old"), state(True, "new")
        self.assertEqual(RS._resolve(loc, rem, last, "auto", True)[0], "to_local")

    def test_conflict_explicit_push_always_wins_regardless_of_mtime(self):
        last = RS._hash("base")
        loc = state(True, "mine", mtime=1)
        rem = state(True, "theirs", mtime=999)  # remote is "newer" but push means local wins anyway
        action, detail = RS._resolve(loc, rem, last, "push", True)
        self.assertEqual(action, "conflict_to_remote")
        self.assertIn(".bak", detail)

    def test_conflict_explicit_pull_always_wins_regardless_of_mtime(self):
        last = RS._hash("base")
        loc = state(True, "mine", mtime=999)
        rem = state(True, "theirs", mtime=1)
        self.assertEqual(RS._resolve(loc, rem, last, "pull", True)[0], "conflict_to_local")

    def test_conflict_first_ever_sync_no_baseline_is_still_a_conflict(self):
        # Both files already differ and nothing was ever recorded as "last synced" -> not a
        # fast-forward in either direction, so it must go through the conflict/backup path.
        loc, rem = state(True, "a", mtime=100), state(True, "b", mtime=1)
        action, _ = RS._resolve(loc, rem, None, "auto", True)
        self.assertEqual(action, "conflict_to_remote")  # local is clearly newer here

    def test_auto_newer_mtime_wins_local(self):
        last = RS._hash("base")
        loc, rem = state(True, "mine", mtime=1000), state(True, "theirs", mtime=1)
        self.assertEqual(RS._resolve(loc, rem, last, "auto", True)[0], "conflict_to_remote")

    def test_auto_newer_mtime_wins_remote(self):
        last = RS._hash("base")
        loc, rem = state(True, "mine", mtime=1), state(True, "theirs", mtime=1000)
        self.assertEqual(RS._resolve(loc, rem, last, "auto", True)[0], "conflict_to_local")

    def test_auto_tie_within_tolerance_hub_wins(self):
        last = RS._hash("base")
        loc = state(True, "mine", mtime=1000)
        rem = state(True, "theirs", mtime=1000 + RS.TIE_TOLERANCE - 1)
        self.assertEqual(RS._resolve(loc, rem, last, "auto", True)[0], "conflict_to_remote")   # local is the hub
        self.assertEqual(RS._resolve(loc, rem, last, "auto", False)[0], "conflict_to_local")   # remote is the hub


class WriteLocalBackup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self._orig = RS.RULES_DIR
        RS.RULES_DIR = self.tmp

    def tearDown(self):
        RS.RULES_DIR = self._orig

    def test_backup_preserves_old_content_before_overwrite(self):
        p = RS.local_path("PROFILE.md")
        open(p, "w", encoding="utf-8").write("old mine")
        RS._write_local("PROFILE.md", "new theirs", backup_suffix="living-room-mini")
        self.assertEqual(open(p, encoding="utf-8").read(), "new theirs")
        self.assertEqual(open(p + ".living-room-mini.bak", encoding="utf-8").read(), "old mine")

    def test_no_backup_file_without_a_conflict(self):
        p = RS.local_path("FACTS.md")
        RS._write_local("FACTS.md", "content")
        self.assertFalse(os.path.exists(p + ".x.bak"))


class FetchParsing(unittest.TestCase):
    def test_round_trip_through_the_remote_script_format(self):
        # What the bash one-liner in _fetch_script would print for a mix of present/missing files.
        content = "hello\nworld\n"
        import base64
        b64 = base64.b64encode(content.encode()).decode()
        output = f"===GLOBAL.md===\n1234.0\n{b64}\n===FACTS.md===\nMISSING\n"
        parsed = RS._parse_fetch(output)
        self.assertEqual(parsed["GLOBAL.md"], {"exists": True, "content": content, "hash": RS._hash(content), "mtime": 1234.0})
        self.assertEqual(parsed["FACTS.md"]["exists"], False)


class Reconcile(unittest.TestCase):
    """reconcile() end to end, with the ssh layer mocked out entirely — no real network calls."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self._orig_dir, self._orig_state = RS.RULES_DIR, RS.STATE_FILE
        RS.RULES_DIR = os.path.join(self.tmp, "rules")
        RS.STATE_FILE = os.path.join(self.tmp, "state.json")
        os.makedirs(RS.RULES_DIR, exist_ok=True)
        self.host = {"id": "living-room-mini", "name": "Apple", "ssh": "me@1.2.3.4"}
        self.pushed = []
        self.refreshed = []
        patch.object(dispatch, "local_host_name", lambda: "hub-mac").start()
        # Never let a test rewrite the real ~/.codex/AGENTS.md & co.
        patch.object(RS, "refresh_local_blocks", lambda: self.refreshed.append(True) or True).start()
        self.addCleanup(patch.stopall)

    def tearDown(self):
        RS.RULES_DIR, RS.STATE_FILE = self._orig_dir, self._orig_state

    def _run(self, remote, prefer="auto", is_hub=True, dry_run=False, files=None):
        with patch.object(RS, "remote_fetch", lambda h, timeout=20: remote), \
             patch.object(RS, "remote_push", lambda h, updates, timeout=20: self.pushed.append(updates)), \
             patch.object(RS, "local_is_hub", lambda: is_hub):
            return RS.reconcile(self.host, prefer=prefer, files=files, dry_run=dry_run)

    def test_remote_only_file_is_pulled_and_created_locally(self):
        remote = {"PROFILE.md": state(True, "from mini", mtime=1)}
        report = self._run(remote, files=["PROFILE.md"])
        self.assertEqual(report[0]["action"], "to_local")
        self.assertEqual(open(RS.local_path("PROFILE.md"), encoding="utf-8").read(), "from mini")
        self.assertEqual(self.pushed, [])  # nothing needed to go the other way

    def test_local_only_file_is_pushed_without_touching_local(self):
        open(RS.local_path("GLOBAL.md"), "w", encoding="utf-8").write("hub rules")
        remote = {"GLOBAL.md": state(False)}
        report = self._run(remote, files=["GLOBAL.md"])
        self.assertEqual(report[0]["action"], "to_remote")
        self.assertEqual(self.pushed, [{"GLOBAL.md": {"content": "hub rules", "backup_suffix": None}}])

    def test_dry_run_never_writes_anywhere(self):
        remote = {"PROFILE.md": state(True, "from mini", mtime=1)}
        self._run(remote, files=["PROFILE.md"], dry_run=True)
        self.assertFalse(os.path.exists(RS.local_path("PROFILE.md")))
        self.assertEqual(self.pushed, [])
        self.assertEqual(RS.load_state(), {})

    def test_conflict_backs_up_the_losing_side_and_records_state(self):
        open(RS.local_path("PROFILE.md"), "w", encoding="utf-8").write("hub version")
        remote = {"PROFILE.md": state(True, "mini version", mtime=1)}
        # Never synced before + both differ -> conflict; explicit push means local (hub) wins.
        report = self._run(remote, prefer="push", files=["PROFILE.md"])
        self.assertEqual(report[0]["action"], "conflict_to_remote")
        self.assertEqual(self.pushed, [{"PROFILE.md": {"content": "hub version", "backup_suffix": "living-room-mini"}}])
        st = RS.load_state()
        self.assertEqual(st["living-room-mini"]["PROFILE.md"]["hash"], RS._hash("hub version"))

    def test_pull_conflict_backs_up_local_before_overwrite(self):
        open(RS.local_path("PROFILE.md"), "w", encoding="utf-8").write("hub version")
        remote = {"PROFILE.md": state(True, "mini version", mtime=1)}
        report = self._run(remote, prefer="pull", files=["PROFILE.md"])
        self.assertEqual(report[0]["action"], "conflict_to_local")
        self.assertEqual(open(RS.local_path("PROFILE.md"), encoding="utf-8").read(), "mini version")
        self.assertEqual(open(RS.local_path("PROFILE.md") + ".hub-mac.bak", encoding="utf-8").read(), "hub version")

    def test_second_run_after_a_successful_sync_is_a_noop(self):
        open(RS.local_path("PROFILE.md"), "w", encoding="utf-8").write("agreed")
        remote = {"PROFILE.md": state(True, "agreed", mtime=1)}
        self._run(remote, files=["PROFILE.md"])
        report2 = self._run(remote, files=["PROFILE.md"])
        self.assertEqual(report2[0]["action"], "noop")
        self.assertEqual(self.pushed, [])  # nothing to send either time -- already in sync from the start

    def test_pulled_global_rules_refresh_this_macs_agent_copies_once(self):
        remote = {"GLOBAL.md": state(True, "new rules", mtime=1), "PROFILE.md": state(True, "me", mtime=1)}
        report = self._run(remote, files=["GLOBAL.md", "PROFILE.md"])
        self.assertEqual([r["action"] for r in report], ["to_local", "to_local"])
        self.assertEqual(self.refreshed, [True])
        self.assertIn("规则副本已刷新", report[0]["detail"])

    def test_other_files_or_a_dry_run_never_refresh(self):
        self._run({"PROFILE.md": state(True, "me", mtime=1)}, files=["PROFILE.md"])
        self._run({"GLOBAL.md": state(True, "new rules", mtime=1)}, files=["GLOBAL.md"], dry_run=True)
        self.assertEqual(self.refreshed, [])

    def test_state_prevents_a_stale_fast_forward_from_reverting_a_later_local_edit(self):
        # sync once so both sides agree on "v1"; then local moves on to "v2" while remote stays put.
        open(RS.local_path("FACTS.md"), "w", encoding="utf-8").write("v1")
        remote = {"FACTS.md": state(True, "v1", mtime=1)}
        self._run(remote, files=["FACTS.md"])
        open(RS.local_path("FACTS.md"), "w", encoding="utf-8").write("v2")
        report = self._run(remote, files=["FACTS.md"])  # remote unchanged since last sync
        self.assertEqual(report[0]["action"], "to_remote")  # fast-forward, not a conflict


class RemotePush(unittest.TestCase):
    def script(self, updates):
        sent = []
        fake_move = types.SimpleNamespace(run_remote=lambda h, script, timeout=20: sent.append(script) or types.SimpleNamespace(returncode=0, stdout="", stderr=""))
        with patch.object(dispatch, "_mod", lambda name: fake_move):
            RS.remote_push({"id": "living-room-mini", "name": "Apple", "ssh": "me@1.2.3.4", "dispatch": "$HOME/.local/bin/dispatch"}, updates)
        return sent[0]

    def test_pushing_global_rules_refreshes_the_other_macs_agent_copies_in_the_same_trip(self):
        s = self.script({"GLOBAL.md": {"content": "rules", "backup_suffix": None}})
        self.assertIn("$HOME/.local/bin/dispatch rules sync", s)
        self.assertLess(s.index("GLOBAL.md\""), s.index("rules sync"))  # after the file is written

    def test_pushing_other_files_does_not_touch_agent_instructions(self):
        self.assertNotIn("rules sync", self.script({"PROFILE.md": {"content": "me", "backup_suffix": None}}))


class LocalIsHub(unittest.TestCase):
    def test_hub_when_init_state_has_no_hub_key(self):
        fake = types.SimpleNamespace(load_state=lambda: {"board_mode": "first", "hub": None})
        with patch.object(dispatch, "_mod", lambda name: fake):
            self.assertTrue(RS.local_is_hub())

    def test_not_hub_when_init_state_names_one(self):
        fake = types.SimpleNamespace(load_state=lambda: {"board_mode": "join", "hub": {"name": "书房的 Mac"}})
        with patch.object(dispatch, "_mod", lambda name: fake):
            self.assertFalse(RS.local_is_hub())

    def test_defaults_to_hub_when_state_is_unreadable(self):
        def boom(name):
            raise OSError("no init.json")
        with patch.object(dispatch, "_mod", boom):
            self.assertTrue(RS.local_is_hub())


class PushAfterEdit(unittest.TestCase):
    def setUp(self):
        self.calls = []
        patch.object(RS, "_spawn", lambda args: self.calls.append(args)).start()
        self.addCleanup(patch.stopall)

    def test_no_peers_configured_does_nothing(self):
        with patch.object(dispatch, "hosts", lambda: []):
            RS.push_after_edit("PROFILE.md")
        self.assertEqual(self.calls, [])

    def test_unrelated_filename_does_nothing(self):
        with patch.object(dispatch, "hosts", lambda: [{"id": "x"}]):
            RS.push_after_edit("random.md")
        self.assertEqual(self.calls, [])

    def test_known_file_with_a_peer_spawns_a_scoped_push(self):
        with patch.object(dispatch, "hosts", lambda: [{"id": "living-room-mini"}]):
            RS.push_after_edit("PROFILE.md")
        self.assertEqual(self.calls, [["rules", "push", "--file", "PROFILE.md"]])


class AutoDue(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self._orig = RS.AUTO_STATE_FILE
        RS.AUTO_STATE_FILE = os.path.join(self.tmp, "auto.json")
        self.spawned = []
        patch.object(RS, "_spawn", lambda args: self.spawned.append(args)).start()
        self.addCleanup(patch.stopall)

    def tearDown(self):
        RS.AUTO_STATE_FILE = self._orig

    def test_no_peers_is_never_due(self):
        with patch.object(dispatch, "hosts", lambda: []):
            r = RS.auto_sync_due()
        self.assertFalse(r["due"])
        self.assertEqual(self.spawned, [])

    def test_due_when_never_run_before(self):
        with patch.object(dispatch, "hosts", lambda: [{"id": "living-room-mini"}]):
            r = RS.auto_sync_due(now=1_000_000)
        self.assertTrue(r["due"])
        self.assertEqual(self.spawned, [["rules", "auto", "--refresh"]])

    def test_not_due_again_within_the_interval(self):
        with patch.object(dispatch, "hosts", lambda: [{"id": "living-room-mini"}]):
            RS.auto_sync_due(now=1_000_000)
            r = RS.auto_sync_due(now=1_000_000 + RS.AUTO_INTERVAL - 1)
        self.assertFalse(r["due"])
        self.assertEqual(len(self.spawned), 1)

    def test_due_again_once_the_interval_passes(self):
        with patch.object(dispatch, "hosts", lambda: [{"id": "living-room-mini"}]):
            RS.auto_sync_due(now=1_000_000)
            r = RS.auto_sync_due(now=1_000_000 + RS.AUTO_INTERVAL + 1)
        self.assertTrue(r["due"])
        self.assertEqual(len(self.spawned), 2)


class CmdRulesPeerCLI(unittest.TestCase):
    def setUp(self):
        self._orig_hosts_file = dispatch.HOSTS_FILE
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        dispatch.HOSTS_FILE = os.path.join(self.tmp, "hosts.json")
        self.addCleanup(setattr, dispatch, "HOSTS_FILE", self._orig_hosts_file)

    def _call(self, **kw):
        a = types.SimpleNamespace(op=kw.pop("op"), json=True, host=kw.pop("host", ""), file=kw.pop("file", ""),
                                   refresh=kw.pop("refresh", False), due=kw.pop("due", False))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            RS.cmd_rules_peer(a)
        return json.loads(buf.getvalue()) if buf.getvalue().strip() else None

    def test_a_single_mac_has_nothing_to_sync_and_that_is_not_a_failure(self):
        res = self._call(op="peers")   # no SystemExit: scripts and the app read this as success
        self.assertTrue(res["skipped"]); self.assertEqual(res["peers"], [])

    def test_asking_for_an_unknown_mac_is_still_an_error(self):
        with self.assertRaises(SystemExit) as cm:
            self._call(op="peers", host="no-such-mac")
        self.assertEqual(cm.exception.code, 1)

    def test_push_reports_per_peer(self):
        json.dump([{"id": "living-room-mini", "name": "Apple", "ssh": "me@1.2.3.4"}], open(dispatch.HOSTS_FILE, "w"))
        with patch.object(RS, "reconcile", lambda h, prefer, files, dry_run: [{"file": "PROFILE.md", "action": "noop", "detail": "已一致"}]):
            rows = self._call(op="push")
        self.assertEqual(rows[0]["host"], "living-room-mini")
        self.assertEqual(rows[0]["report"][0]["action"], "noop")

    def test_auto_without_flags_prints_usage_and_exits(self):
        with self.assertRaises(SystemExit) as cm:
            self._call(op="auto")
        self.assertEqual(cm.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
