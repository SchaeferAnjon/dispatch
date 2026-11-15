# -*- coding: utf-8 -*-
"""After a Mac gets a new id or name (hosts.json keeps the old ones as aliases), everything that names it
the old way still finds it: --host, --on, move records, serve.json's phone_host, owner records. And a
peer that calls itself something else no longer renames it here: hosts.json's name is the one name."""
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dispatch  # noqa: E402

MINI = {"id": "mini", "name": "mini", "ssh": "apple@100.64.0.11", "dispatch": "$HOME/.local/bin/dispatch",
        "aliases": ["Apple", "Kiwi的Mac mini", "kiwi-mac-mini"]}


class Lookups(unittest.TestCase):
    def setUp(self):
        p = patch.object(dispatch, "hosts", return_value=[dict(MINI)])
        p.start()
        self.addCleanup(p.stop)

    def test_every_old_name_resolves(self):
        for key in ("mini", "kiwi-mac-mini", "Apple", "Kiwi的Mac mini", "APPLE", "apple@100.64.0.11", "100.64.0.11"):
            self.assertEqual(dispatch.resolve_host_id(key), "mini", key)
            self.assertEqual(dispatch.target_host(key)["id"], "mini", key)
        self.assertEqual(dispatch.resolve_host_id("studio"), "")
        self.assertEqual(dispatch.host_label("kiwi-mac-mini"), "mini")
        self.assertEqual(dispatch.host_label("local"), dispatch.local_host_name())
        self.assertEqual(dispatch.host_label("gone"), "gone")
        with self.assertRaises(SystemExit):
            dispatch.target_host("studio")

    def test_move_records_under_the_old_id_show_the_mac_as_it_is_now(self):
        rows = [{"agent": "codex", "session_id": "s1", "host": "local"}, {"agent": "codex", "session_id": "s2"}]
        moves = {"codex:s1": {"moved_to": "kiwi-mac-mini", "at": 5}, "codex:s2": {"moved_from": "gone", "at": 6}}
        with patch.object(dispatch, "load_moves", return_value=moves):
            dispatch.annotate_moves(rows)
        self.assertEqual((rows[0]["moved_to"], rows[0]["moved_to_name"], rows[0]["moved_at"]), ("mini", "mini", 5))
        self.assertEqual((rows[1]["moved_from"], rows[1]["moved_from_name"]), ("gone", "gone"))

    def test_host_flag_with_the_old_id_reaches_the_mac(self):
        result = subprocess.CompletedProcess([], 0, stderr="")
        with patch.object(dispatch.subprocess, "run", return_value=result) as run:
            with self.assertRaises(SystemExit) as ex:
                dispatch.proxy_to_host(["--host", "kiwi-mac-mini", "sessions", "--json"])
        self.assertEqual(ex.exception.code, 0)
        self.assertIn("apple@100.64.0.11", run.call_args.args[0])

    def test_on_with_the_old_id_picks_that_mac(self):
        refs = [{"session_id": "abc123", "agent": "codex", "host": "mini", "host_name": "mini"}]
        with patch.object(dispatch, "remote_refs", return_value=refs):
            found = dispatch.refs_everywhere("abc123", "kiwi-mac-mini")
        self.assertEqual([(h, n) for h, n, _r in found], [("mini", "mini")])

    def test_phone_host_under_the_old_id(self):
        import serve
        self.assertEqual(serve.phone_home({"phone_host": "kiwi-mac-mini"})["id"], "mini")
        self.assertIsNone(serve.phone_home({"phone_host": "studio"}))


class OneName(unittest.TestCase):
    def test_a_peer_calling_itself_something_else_only_adds_an_alias(self):
        with tempfile.TemporaryDirectory() as d:
            hosts_file = os.path.join(d, "hosts.json")
            with open(hosts_file, "w", encoding="utf-8") as f:
                json.dump([{"id": "mini", "name": "mini", "ssh": "apple@100.64.0.11", "aliases": ["kiwi-mac-mini"]}], f)
            backends = {"overlay": {"kind": "", "ip": ""}, "lan_ip": "", "screen_sharing": False, "novnc_up": False, "novnc": "", "novnc_issue": "",
                        "vnc": "", "rustdesk": False, "rustdesk_id": "", "sunshine": False, "sunshine_ui": "", "uu": False, "recommend": "", "why": ""}
            answer = [{"id": "local", "name": "Apple", "aliases": ["Kiwi的Mac mini"], "overlay": {"kind": "tailscale", "ip": "100.64.0.11"}}]
            with patch.object(dispatch, "HOSTS_FILE", hosts_file), patch.object(dispatch, "REMOTE_DIR", d), \
                    patch.object(dispatch, "detect_remote_backends", return_value=backends), patch.object(dispatch, "port_open", return_value=True), \
                    patch.object(dispatch, "remote_dispatch", return_value=answer):
                rows = dispatch.host_rows()
                again = dispatch.host_rows()
            with open(hosts_file, encoding="utf-8") as f:
                saved = json.load(f)
        self.assertEqual((saved[0]["name"], saved[0]["aliases"]), ("mini", ["Apple", "Kiwi的Mac mini", "kiwi-mac-mini"]))
        self.assertEqual((rows[1]["name"], again[1]["name"]), ("mini", "mini"))
        self.assertIn("Apple", rows[1]["aliases"])
        self.assertEqual(rows[0]["dispatch_version"], dispatch._mod("machines").version())  # peers read it from `hosts --local`


class ParserOptions(unittest.TestCase):
    def test_parsers_take_the_new_options(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
            env = dict(os.environ, DISPATCH_DIR=d, BEADS_DIR=os.path.join(d, "none"), HOME=d)
            for argv in (["hosts", "--help"], ["waiting", "--help"]):
                p = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py")] + argv, capture_output=True, text=True, env=env, timeout=60)
                self.assertEqual(p.returncode, 0, p.stderr)
                for flag in (["--password-stdin", "--check", "--address", "discover"] if argv[0] == "hosts" else ["--host", "--local"]):
                    self.assertIn(flag, p.stdout)


if __name__ == "__main__":
    unittest.main()
