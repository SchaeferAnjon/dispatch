# -*- coding: utf-8 -*-
"""machines.py: `dispatch machines`, one row per machine for Dispatch IDE's Devices and the hint row."""
import json
import os
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import machines as M  # noqa: E402

MINI = {"id": "mini", "name": "mini", "aliases": ["Apple", "Kiwi的Mac mini", "kiwi-mac-mini"], "ssh": "apple@100.64.0.11"}
STUDIO = {"id": "studio", "name": "阁楼", "ssh": "me@192.168.1.20"}


def fake_dispatch(remote_dir, hosts=(MINI, STUDIO), live=(), answers=None, calls=None):
    """The parts of dispatch that machines() uses; remote_dispatch answers from `answers` by command."""
    answers = answers or {}

    def remote_dispatch(h, args, ttl, timeout=12, background=False):
        if calls is not None:
            calls.append((h["id"], tuple(args), ttl, timeout, background))
        return answers.get((h["id"], tuple(args)))

    return types.SimpleNamespace(
        HOME="/Users/me", HOSTS_FILE="/x/hosts.json", REMOTE_DIR=remote_dir, DISPATCH_DIR=os.path.dirname(remote_dir),
        hosts=lambda: [dict(h) for h in hosts], live_sessions=lambda local_only=False: [dict(s) for s in live],
        local_host_name=lambda: "小蓝", local_host_aliases=lambda: ["MacBook"], debug=lambda where, e: None, _mod=__import__,
        tailscale_ip=lambda: "100.64.0.12", lan_ip=lambda: "192.168.0.125",
        port_open=lambda ip, port, timeout=1.0: ip == "100.64.0.11",
        reachable_over_ssh=lambda h, timeout=1.0: (h.get("ip") or h["ssh"].split("@")[-1]) == "100.64.0.11",
        remote_cache_path=lambda h, args: os.path.join(remote_dir, f"{h['id']}--" + "-".join(a.strip("-") for a in args) + ".json"),
        remote_dispatch=remote_dispatch)


class Rows(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.remote = os.path.join(self.tmp.name, "remote")
        os.makedirs(self.remote)
        self.orig = M.D

    def tearDown(self):
        M.D = self.orig
        self.tmp.cleanup()

    def test_open_remote_writes_one_shot_landing_over_ssh_stdin(self):
        M.D = fake_dispatch(self.remote)
        with patch.object(M.subprocess, "run", return_value=types.SimpleNamespace(returncode=0)) as run:
            got = M.open_machine("mini", "waiting")
        self.assertTrue(got["ok"])
        args, kwargs = run.call_args
        self.assertIn(MINI["ssh"], args[0])
        self.assertIn("$HOME/.dispatch/state/land.json", args[0][-1])
        self.assertEqual(json.loads(kwargs["input"])["land"], "waiting")

    def test_open_local_is_atomic_and_invalid_landing_is_rejected(self):
        M.D = fake_dispatch(self.remote)
        with patch.dict(os.environ, {"DISPATCH_DIR": self.tmp.name}):
            M.open_machine("local", "waiting")
            with open(os.path.join(self.tmp.name, "land.json")) as f:
                self.assertEqual(json.load(f)["land"], "waiting")
        with self.assertRaises(ValueError):
            M.open_machine("mini", "waiting; touch /tmp/no")

    def test_failed_landing_is_reported_and_not_claimed_open(self):
        M.D = fake_dispatch(self.remote)
        with patch.object(M.subprocess, "run", side_effect=M.subprocess.TimeoutExpired("ssh", 15)):
            with self.assertRaisesRegex(ValueError, "Could not open mini"):
                M.open_machine("mini", "waiting")

    def machines(self, **kw):
        with patch.object(M, "local_attention", return_value={"approve": 1, "decide": 0, "unread": 2, "only_you": 3, "total": 6, "shared": 1, "as_of": 5.0}), \
                patch.object(M, "local_recent", return_value=[{"name": "kanban", "label": "kanban", "dir": "/Users/me/Projects/kanban", "last_at": 9.0, "last_title": "x"}]):
            return M.machines()

    def test_this_machine_first_then_hosts_json_order(self):
        live = [{"host": "local", "state": "working"}, {"host": "local", "state": "idle"}, {"host": "local", "alive": False, "state": "working"},
                {"host": "mini", "remote": True, "state": "working"}]  # a peer's row merged in: not this machine's
        answers = {("mini", ("sessions", "--local")): [{"host": "local", "state": "working"}, {"host": "local", "state": "idle"},
                                                     {"host": "hub", "remote": True, "state": "working"}],
                   ("mini", ("hosts", "--local")): [{"id": "local", "name": "Apple", "dispatch_version": "0.7.48"}]}
        M.D = fake_dispatch(self.remote, live=live, answers=answers)
        with patch.object(M, "peer_attention", return_value={"total": 2, "as_of": 7.0}), patch.object(M, "peer_recent", return_value=[]):
            rows = self.machines()
        self.assertEqual([r["id"] for r in rows], ["local", "mini", "studio"])
        me, mini, studio = rows
        self.assertEqual((me["name"], me["local"], me["online"], me["sessions"], me["running"], me["via"], me["address"]),
                         ("小蓝", True, True, 2, 1, "tailscale", "100.64.0.12"))
        self.assertEqual((me["hosts_file"], me["attention"]["total"], me["recent"][0]["name"], me["dispatch_version"]), ("/x/hosts.json", 6, "kanban", M.version()))
        self.assertEqual((mini["name"], mini["online"], mini["via"], mini["address"], mini["user"], mini["ssh"], mini["ssh_alias"], mini["home"]),
                         ("mini", True, "tailscale", "100.64.0.11", "apple", "apple@100.64.0.11", "mini", "/Users/apple"))
        self.assertEqual((mini["sessions"], mini["running"], mini["dispatch_version"], mini["attention"]["total"]), (2, 1, "0.7.48", 2))
        self.assertNotIn("hosts_file", mini)
        # a CJK name is no SSH alias: the id stands in; offline, nothing runs as far as this Mac knows
        self.assertEqual((studio["ssh_alias"], studio["via"], studio["online"], studio["sessions"], studio["running"]), ("studio", "lan", False, 0, 0))

    def test_peers_are_asked_through_the_cache_with_a_short_wait(self):
        calls = []
        M.D = fake_dispatch(self.remote, hosts=(MINI,), calls=calls)
        with patch.object(M, "peer_attention", return_value=None):
            self.machines()
        self.assertTrue(calls)
        for hid, args, ttl, timeout, background in calls:
            self.assertEqual((hid, timeout, background), ("mini", M.PEER_TIMEOUT, True))  # a cold cache waits PEER_TIMEOUT + 3 s at most
        self.assertEqual({c[1] for c in calls}, {tuple(M.ARGS[k]) for k in ("sessions", "projects", "hosts")})

    def test_an_offline_peer_keeps_its_last_counts_and_is_not_asked(self):
        calls = []
        M.D = fake_dispatch(self.remote, hosts=(STUDIO,), calls=calls)
        M.D.remote_cache_path = lambda h, args: os.path.join(self.remote, f"{h['id']}--" + "-".join(a.strip("-") for a in args) + ".json")
        with open(os.path.join(self.remote, "studio--waiting-local.json"), "w") as f:
            json.dump({"items": [{"kind": "approve"}, {"kind": "unread"}], "counts": {"approve": 1, "unread": 1, "all": 2, "shared": 0}, "updated_at": 1234.0}, f)
        with open(os.path.join(self.remote, "studio--projects-view-json-local.json"), "w") as f:
            json.dump({"projects": [{"name": "a", "host": "local", "last_at": 5, "last_title": "t"}], "recent": [{"name": "a", "label": "a", "dir": "/Users/me/a", "last_at": 5, "last_title": "t"}]}, f)
        import waiting as W
        with patch.object(W, "D", M.D, create=True):
            rows = self.machines()
        studio = rows[1]
        self.assertFalse(studio["online"])
        self.assertEqual((studio["attention"]["approve"], studio["attention"]["total"], studio["attention"]["as_of"]), (1, 2, 1234.0))
        self.assertEqual([p["name"] for p in studio["recent"]], ["a"])
        self.assertEqual(calls, [])  # nothing refreshes a Mac that does not answer
        self.assertIsNotNone(studio["last_seen"])  # the cached answers say when it last answered


class LastSeen(unittest.TestCase):
    def test_now_when_online_else_the_newest_answer_under_any_id_it_had(self):
        with tempfile.TemporaryDirectory() as d:
            M.D = types.SimpleNamespace(REMOTE_DIR=d)
            h = {"id": "mini", "aliases": ["kiwi-mac-mini", "Kiwi的Mac mini"]}
            self.assertEqual(M.last_seen(h, True, 100.0), 100.0)
            self.assertTrue(os.path.exists(os.path.join(d, "mini.seen")))
            old = os.path.join(d, "kiwi-mac-mini--sessions-local.json")
            open(old, "w").close()
            os.utime(old, (5000, 5000))
            os.utime(os.path.join(d, "mini.seen"), (4000, 4000))
            self.assertEqual(M.last_seen(h, False, 100.0), 5000)
            self.assertIsNone(M.last_seen({"id": "x"}, False, 1.0))


class Small(unittest.TestCase):
    def test_own_sessions_and_counts(self):
        rows = [{"host": "local", "state": "working"}, {"state": "idle"}, {"host": "local", "alive": False},
                {"host": "hub", "state": "working"}, {"host": "local", "remote": True, "state": "working"}, "junk"]
        self.assertEqual(M.live_counts(rows), (2, 1))

    def test_version_is_the_file_next_to_the_cli(self):
        with open(os.path.join(HERE, "VERSION"), encoding="utf-8") as f:
            self.assertEqual(M.version(), f.read().strip())

    def test_find_this_machine_and_old_ids(self):
        M.D = types.SimpleNamespace(hosts=lambda: [MINI], local_host_name=lambda: "小蓝", local_host_aliases=lambda: ["MacBook"], debug=lambda *a: None)
        for key in ("", "local", "小蓝", "macbook"):
            self.assertIsNone(M.find(key))
        for key in ("mini", "kiwi-mac-mini", "Apple", "kiwi的mac mini", "apple@100.64.0.11", "100.64.0.11"):
            self.assertIs(M.find(key)["id"], "mini")
        with self.assertRaises(ValueError):
            M.find("nope")

    def test_session_row(self):
        r = M.session_row({"session_id": "x1", "agent": "codex", "cwd": "/Users/apple/Projects/a", "state": "idle", "last_at": 3})
        self.assertEqual((r["id"], r["project"], r["title"]), ("x1", "a", ""))

    def test_wired_into_dispatch(self):
        import subprocess
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
            env = dict(os.environ, DISPATCH_DIR=d, BEADS_DIR=os.path.join(d, "none"), DISPATCH_IDE_USER_DATA_DIRS=d, HOME=d)
            t0 = time.time()
            p = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "machines", "--json"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        rows = json.loads(p.stdout)
        self.assertEqual([(r["id"], r["local"]) for r in rows], [("local", True)])  # one machine: one row, nothing to mark
        self.assertIn("attention", rows[0])
        self.assertLess(time.time() - t0, 30)


if __name__ == "__main__":
    unittest.main()


class SshEndpoint(unittest.TestCase):
    """Another Mac's address and port as ssh resolves them (dispatch.ssh_endpoint): an ssh config alias with its own
    port answers as online (10-07: a Mac at `Host mac / Port 2222` always showed as not reachable)."""

    def setUp(self):
        import dispatch
        self.D = dispatch
        dispatch._SSH_ENDPOINTS.clear()
        self.addCleanup(dispatch._SSH_ENDPOINTS.clear)

    def test_ssh_config_names_the_address_and_port(self):
        out = "user me\nhostname 127.0.0.1\nport 2222\nidentityfile ~/.ssh/k\n"
        with patch.object(self.D.subprocess, "run", return_value=types.SimpleNamespace(returncode=0, stdout=out)) as run:
            self.assertEqual(self.D.ssh_endpoint("me@mac"), ("127.0.0.1", 2222))
            self.assertEqual(self.D.ssh_endpoint("me@mac"), ("127.0.0.1", 2222))
        self.assertEqual(run.call_count, 1)  # once per target
        self.assertEqual(run.call_args[0][0], ["ssh", "-G", "me@mac"])

    def test_without_ssh_the_address_after_the_at_and_22(self):
        with patch.object(self.D.subprocess, "run", side_effect=FileNotFoundError("ssh")):
            self.assertEqual(self.D.ssh_endpoint("me@10.0.0.5"), ("10.0.0.5", 22))
        self.assertEqual(self.D.ssh_endpoint(""), ("", 22))

    def test_reachable_uses_the_resolved_port_and_an_ip_as_given(self):
        seen = []
        with patch.object(self.D, "ssh_endpoint", return_value=("127.0.0.1", 2222)), \
                patch.object(self.D, "port_open", side_effect=lambda ip, port, timeout=1.0: seen.append((ip, port)) or True):
            self.assertTrue(self.D.reachable_over_ssh({"ssh": "me@mac"}))
            self.assertTrue(self.D.reachable_over_ssh({"ssh": "me@mac", "ip": "100.1.2.3"}))
        self.assertEqual(seen, [("127.0.0.1", 2222), ("100.1.2.3", 22)])
