# -*- coding: utf-8 -*-
"""host_admin.py: `dispatch hosts discover | add | set | remove` and ~/.dispatch/ssh/config."""
import json
import os
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import host_admin as H  # noqa: E402

MINI = {"id": "mini", "name": "mini", "ssh": "apple@100.64.0.11", "dispatch": "$HOME/.local/bin/dispatch",
        "aliases": ["Apple", "Kiwi的Mac mini", "kiwi-mac-mini"]}


class Fixture(unittest.TestCase):
    """A DISPATCH_DIR and a DISPATCH_HOME (~/.dispatch) in a temp folder, and a dispatch stand-in."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = os.path.join(self.tmp.name, "state")
        os.makedirs(os.path.join(self.dir, "remote"))
        self.hosts_file = os.path.join(self.dir, "hosts.json")
        self.env = patch.dict(os.environ, {"DISPATCH_HOME": os.path.join(self.tmp.name, "dot-dispatch")})
        self.env.start()
        self.orig = H.D
        H.D = types.SimpleNamespace(
            DISPATCH_DIR=self.dir, HOSTS_FILE=self.hosts_file, REMOTE_DIR=os.path.join(self.dir, "remote"),
            hosts=self.read, local_host_name=lambda: "小蓝", local_host_aliases=lambda: ["MacBook"], debug=lambda *a: None,
            _mod=lambda n: (_ for _ in ()).throw(ImportError(n)))

    def tearDown(self):
        H.D = self.orig
        self.env.stop()
        self.tmp.cleanup()

    def read(self):
        try:
            with open(self.hosts_file, encoding="utf-8") as f:
                return json.load(f)
        except OSError:
            return []

    def write(self, hs):
        with open(self.hosts_file, "w", encoding="utf-8") as f:
            json.dump(hs, f, ensure_ascii=False)

    def config(self):
        with open(H.config_path(), encoding="utf-8") as f:
            return f.read()

    def backups(self):
        folder = os.path.join(self.dir, "backups", "hosts")
        return sorted(os.listdir(folder)) if os.path.isdir(folder) else []


class Names(unittest.TestCase):
    def test_match_ids_names_aliases_any_case_then_addresses(self):
        other = {"id": "studio", "name": "阁楼", "ssh": "me@100.64.0.11"}  # same address as the mini's: names win
        hs = [other, MINI]
        for key in ("mini", "MINI", "kiwi-mac-mini", "Apple", "kiwi的mac mini"):
            self.assertIs(H.match(hs, key), MINI, key)
        self.assertIs(H.match(hs, "apple@100.64.0.11"), MINI)
        self.assertIs(H.match(hs, "100.64.0.11"), other)
        self.assertIs(H.match(hs, "阁楼"), other)
        self.assertIsNone(H.match(hs, ""))
        self.assertIsNone(H.match(hs, "nope"))

    def test_ssh_alias_is_the_name_when_it_is_one_word(self):
        self.assertEqual(H.ssh_alias(MINI), "mini")
        self.assertEqual(H.ssh_alias({"id": "hub", "name": "小蓝"}), "hub")
        self.assertEqual(H.ssh_alias({"id": "x", "name": "Kiwi的Mac mini"}), "x")
        self.assertEqual(H.ssh_alias({"id": "local", "name": "local"}), "")

    def test_via(self):
        for addr, via in (("100.64.0.11", "tailscale"), ("100.64.0.1", "tailscale"), ("100.128.0.1", None), ("kiwimac-mini.tailnet-example.ts.net", "tailscale"),
                          ("fd7a:115c:a1e0::1:2", "tailscale"), ("192.168.0.140", "lan"), ("10.0.0.2", "lan"), ("KiwideMac-mini.local", "lan"),
                          ("8.8.8.8", None), ("mini", None), ("", None)):
            self.assertEqual(H.via_of(addr), via, addr)

    def test_short_name(self):
        self.assertEqual(H.short_name("Kiwi的Mac mini"), "mini")
        self.assertEqual(H.short_name("阁楼的 Mac mini"), "mini")
        self.assertEqual(H.short_name("Anna的MacBook Air"), "air")
        self.assertEqual(H.short_name("Anna’s MacBook Pro"), "macbook")
        self.assertEqual(H.short_name("John's iMac"), "imac")
        self.assertEqual(H.short_name("Mac Studio"), "studio")
        self.assertEqual(H.short_name("小蓝"), "小蓝")
        self.assertEqual(H.short_name("PC_Demo"), "pc-demo")
        self.assertEqual(H.short_name(""), "mac")
        self.assertEqual(H.short_name("Kiwi的Mac mini", taken=["Mini", "mini-2"]), "mini-3")


class SshConfig(Fixture):
    def test_include_first_their_lines_kept_our_blocks_rewritten(self):
        mine = "Host nas\n  HostName 10.77.0.2\n\n"
        text = H.render_config(mine, [MINI])
        self.assertEqual(text, "Include ~/.ssh/config\n\nHost nas\n  HostName 10.77.0.2\n\n# dispatch: mini\nHost mini\n  HostName 100.64.0.11\n  User apple\n")
        self.assertEqual(H.render_config(text, [MINI]), text)  # stable
        renamed = dict(MINI, name="studio")
        again = H.render_config(text, [renamed])
        self.assertIn("Host studio\n", again)
        self.assertNotIn("Host mini\n", again)
        self.assertIn("Host nas\n  HostName 10.77.0.2", again)
        self.assertEqual(H.render_config(again, []), "Include ~/.ssh/config\n\nHost nas\n  HostName 10.77.0.2\n")

    def test_their_block_right_after_ours_survives(self):
        text = "Include ~/.ssh/config\n\n# dispatch: mini\nHost mini\n  HostName 1.2.3.4\nHost other\n  User x\n"
        out = H.render_config(text, [MINI])
        self.assertIn("Host other\n  User x", out)
        self.assertEqual(out.count("Host mini"), 1)

    def test_sync_writes_only_that_file_private(self):
        self.assertEqual(H.sync_config([]), "")  # no other Mac: nothing to write
        self.assertFalse(os.path.exists(H.config_path()))
        path = H.sync_config([MINI])
        self.assertEqual(path, os.path.join(self.tmp.name, "dot-dispatch", "ssh", "config"))
        self.assertEqual(os.listdir(os.path.join(self.tmp.name, "dot-dispatch")), ["ssh"])
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertTrue(self.config().startswith("Include ~/.ssh/config\n"))
        if subprocess.run(["which", "ssh"], capture_output=True).returncode == 0:
            g = subprocess.run(["ssh", "-G", "-F", path, "mini"], capture_output=True, text=True, env={**os.environ, "HOME": self.tmp.name})
            self.assertIn("user apple", g.stdout)
            self.assertIn("hostname 100.64.0.11", g.stdout)


class SetRemove(Fixture):
    def test_new_id_and_name_keep_the_old_ones_as_aliases(self):
        self.write([{"id": "kiwi-mac-mini", "name": "Apple", "ssh": "apple@100.64.0.11", "dispatch": "$HOME/.local/bin/dispatch",
                     "herdr_session": "main", "aliases": ["Kiwi的Mac mini"]}])
        res = H.set_host("kiwi-mac-mini", name="mini", new_id="mini")
        self.assertEqual(res["changed"], ["id", "name"])
        h = self.read()[0]
        self.assertEqual((h["id"], h["name"], h["aliases"], h["herdr_session"]), ("mini", "mini", ["Apple", "Kiwi的Mac mini", "kiwi-mac-mini"], "main"))
        self.assertEqual(len(self.backups()), 1)
        self.assertIn("Host mini\n  HostName 100.64.0.11\n  User apple", self.config())
        # the old names still find it
        self.assertEqual(H.match(self.read(), "kiwi-mac-mini")["id"], "mini")
        # nothing to change: nothing written
        self.assertEqual(H.set_host("Apple", name="mini")["changed"], [])
        self.assertEqual(len(self.backups()), 1)

    def test_address_and_user(self):
        self.write([MINI])
        open(os.path.join(self.dir, "remote", "mini.down"), "w").close()
        res = H.set_host("mini", address="kiwimac-mini.local", user="anna")
        self.assertEqual((res["host"]["ssh"], res["host"]["via"]), ("anna@kiwimac-mini.local", "lan"))
        self.assertFalse(os.path.exists(os.path.join(self.dir, "remote", "mini.down")))  # the new address gets probed at once
        self.assertIn("HostName kiwimac-mini.local\n  User anna", self.config())

    def test_refusals(self):
        self.write([MINI, {"id": "studio", "name": "阁楼", "ssh": "me@10.0.0.2"}])
        for kw, msg in (({"name": "阁楼"}, "already called"), ({"name": "小蓝"}, "own name"), ({"name": "macbook"}, "own name"),
                        ({"new_id": "studio"}, "already goes by"), ({"new_id": "has space"}, "one word"), ({"new_id": "local"}, "one word"),
                        ({"address": "-oProxyCommand=x"}, "not an address"), ({"user": "-x"}, "account name"), ({"name": ""}, "Give")):
            with self.assertRaises(ValueError) as e:
                H.set_host("mini", **kw)
            self.assertIn(msg, str(e.exception), kw)
        with self.assertRaises(ValueError):
            H.set_host("nope", name="x")
        self.assertEqual(self.backups(), [])

    def test_remove(self):
        self.write([MINI, {"id": "studio", "name": "studio", "ssh": "me@10.0.0.2"}])
        H.sync_config(self.read())
        res = H.remove_host("kiwi-mac-mini")
        self.assertEqual((res["removed"], res["name"]), ("mini", "mini"))
        self.assertEqual([h["id"] for h in self.read()], ["studio"])
        self.assertNotIn("Host mini", self.config())
        self.assertIn("Host studio", self.config())
        self.assertEqual(len(self.backups()), 1)

    def test_remember_aliases_only_adds_new_names(self):
        self.write([dict(MINI), {"id": "studio", "name": "studio", "ssh": "me@10.0.0.2"}])
        self.assertFalse(H.remember_aliases("mini", ["Apple", "mini"]))
        self.assertTrue(H.remember_aliases("mini", ["Apple 2", "studio"]))  # studio is another Mac's name: not taken over
        self.assertEqual(self.read()[0]["aliases"], ["Apple", "Apple 2", "Kiwi的Mac mini", "kiwi-mac-mini"])
        self.assertEqual(self.read()[0]["name"], "mini")


class Add(Fixture):
    def run_add(self, *args, **kw):
        lines = []
        res = H.add(*args, emit=lines.append, **kw)
        return res, lines

    def test_every_step_reported_as_it_goes_then_written(self):
        with patch.object(H, "check_reach", return_value={"state": "ok", "detail": "38 ms over Tailscale", "ms": 38, "via": "tailscale"}), \
                patch.object(H, "check_login", return_value={"state": "ok", "detail": "Signed in"}), \
                patch.object(H, "probe_remote", return_value={"computer": "Kiwi的Mac mini", "dispatch": "/Users/apple/.local/bin/dispatch",
                                                             "version": "0.7.47", "claude": "/x/claude", "codex": ""}):
            res, lines = self.run_add("100.64.0.11", "apple", name="mini", check=True)
        self.assertEqual([(d.get("step"), d.get("state")) for d in lines[:-1]],
                         [("reach", "running"), ("reach", "ok"), ("login", "running"), ("login", "ok"),
                          ("dispatch", "running"), ("dispatch", "ok"), ("engines", "running"), ("engines", "ok")])
        self.assertEqual(lines[2 * 3 + 1]["detail"], "Claude Code")
        self.assertIs(lines[-1], res)
        self.assertEqual((res["done"], res["ok"], res["written"], res["id"], res["name"], res["ssh_alias"], res["suggested_name"], res["computer_name"]),
                         (True, True, True, "mini", "mini", "mini", "mini", "Kiwi的Mac mini"))
        self.assertEqual(self.read(), [{"id": "mini", "name": "mini", "ssh": "apple@100.64.0.11", "dispatch": "$HOME/.local/bin/dispatch"}])
        self.assertIn("Host mini\n  HostName 100.64.0.11\n  User apple", self.config())

    def test_no_key_yet_stops_at_login(self):
        with patch.object(H, "check_reach", return_value={"state": "ok", "detail": "1 ms"}), \
                patch.object(H, "check_login", return_value={"state": "need_password", "detail": "no key", "fix": "Enter the password once."}), \
                patch.object(H, "tailscale_name", return_value="Kiwi的Mac mini"), patch.object(H, "probe_remote") as probe:
            res, lines = self.run_add("100.64.0.11", "apple", name="mini", check=True)
        probe.assert_not_called()
        self.assertEqual(lines[-2]["state"], "need_password")
        self.assertEqual((res["ok"], res["need_password"], res["failed"], res["suggested_name"]), (False, True, "login", "mini"))
        self.assertEqual(self.read(), [])

    def test_password_installs_the_key_once(self):
        login = [{"state": "need_password", "detail": "no key"}, {"state": "ok", "detail": "Signed in"}]
        with patch.object(H, "check_reach", return_value={"state": "ok", "detail": "1 ms"}), \
                patch.object(H, "check_login", side_effect=login), \
                patch.object(H, "install_key", return_value={"state": "ok", "detail": "Installed"}) as install, \
                patch.object(H, "probe_remote", return_value={"computer": "Kiwi的Mac mini", "dispatch": "/d", "version": "", "claude": "", "codex": "/c"}):
            res, lines = self.run_add("apple@100.64.0.11", "", check=True, password="pw")
        install.assert_called_once_with("apple", "100.64.0.11", "pw")
        self.assertIn({"step": "login", "state": "running", "detail": "Installing this Mac's SSH key there"}, lines)
        self.assertEqual((res["ok"], res["written"], res["suggested_name"]), (True, False, "mini"))  # no name given: checked, not added
        self.assertEqual(self.read(), [])

    def test_failures_say_what_to_do(self):
        with patch.object(H, "check_reach", return_value={"state": "fail", "detail": "refused", "fix": "Turn on Remote Login"}), \
                patch.object(H, "tailscale_name", return_value=""):
            res, lines = self.run_add("100.64.0.11", "apple", name="mini", check=True)
        self.assertEqual([d.get("step") for d in lines[:-1]], ["reach", "reach"])
        self.assertEqual((res["ok"], res["failed"]), (False, "reach"))
        with patch.object(H, "check_reach", return_value={"state": "ok", "detail": "1 ms"}), \
                patch.object(H, "check_login", return_value={"state": "ok", "detail": "Signed in"}), \
                patch.object(H, "probe_remote", return_value={"computer": "", "dispatch": "", "version": "", "claude": "", "codex": ""}):
            res, lines = self.run_add("100.64.0.11", "apple", name="mini", check=True)
        steps = {d["step"]: d for d in lines if d.get("step") and d["state"] != "running"}
        self.assertEqual((steps["dispatch"]["state"], steps["engines"]["state"], res["ok"], res["failed"]), ("fail", "fail", False, "dispatch"))
        self.assertIn("Install", steps["dispatch"]["fix"])
        self.assertEqual(self.read(), [])

    def test_without_check_it_just_writes_and_refuses_duplicates(self):
        res, _ = self.run_add("100.64.0.11", "apple", name="Kiwi的Mac mini")
        self.assertEqual((res["ok"], res["id"], res["ssh_alias"]), (True, "kiwi-mac-mini", "kiwi-mac-mini"))
        res, _ = self.run_add("100.64.0.11", "apple", name="mini")
        self.assertEqual((res["ok"], res["known"], res["id"]), (False, True, "kiwi-mac-mini"))
        res, _ = self.run_add("10.0.0.9", "apple")
        self.assertIn("name", res["message"])
        res, _ = self.run_add("bad address;", "apple", name="x")
        self.assertIn("not an address", res["message"])
        self.assertEqual(len(self.read()), 1)


class KeyInstall(unittest.TestCase):
    def test_password_goes_through_askpass_and_is_never_written(self):
        with tempfile.TemporaryDirectory() as d:
            bin_dir = os.path.join(d, "bin")
            os.makedirs(bin_dir)
            seen = os.path.join(d, "seen")
            fake = os.path.join(bin_dir, "ssh-copy-id")
            with open(fake, "w") as f:  # stands in for ssh-copy-id: asks SSH_ASKPASS the way ssh does
                f.write(f'#!/bin/sh\n[ "$SSH_ASKPASS_REQUIRE" = force ] || exit 3\npw="$("$SSH_ASKPASS" "Password:")"\n'
                        f'ls "$(dirname "$SSH_ASKPASS")" > {seen}\n'
                        f'[ "$pw" = "s3cret pass" ] && exit 0\necho "Permission denied, please try again." >&2\nexit 1\n')
            os.chmod(fake, 0o755)
            pub = os.path.join(d, "id_ed25519.pub")
            open(pub, "w").close()
            with patch.dict(os.environ, {"PATH": bin_dir + os.pathsep + os.environ.get("PATH", ""), "TMPDIR": d}), patch.object(H, "public_key", return_value=pub):
                ok = H.install_key("apple", "100.64.0.11", "s3cret pass")
                bad = H.install_key("apple", "100.64.0.11", "wrong")
            self.assertEqual(ok["state"], "ok")
            self.assertEqual((bad["state"], bad["detail"]), ("need_password", "That password did not work"))
            with open(seen) as f:
                self.assertEqual(f.read().split(), ["askpass"])  # the helper only; the password lives in its environment
            left = [n for n in os.listdir(d) if n.startswith("dispatch-askpass-")]
            self.assertEqual(left, [])  # the helper folder is gone
            for root, _dirs, files in os.walk(d):
                if root == bin_dir:
                    continue  # the stand-in above knows the password to compare with
                for n in files:
                    with open(os.path.join(root, n), errors="replace") as f:
                        self.assertNotIn("s3cret", f.read(), n)


STATUS = {"Self": {"HostName": "小蓝", "TailscaleIPs": ["100.64.0.12"]},
          "Peer": {"a": {"HostName": "Kiwi的Mac mini", "DNSName": "kiwimac-mini.tailnet-example.ts.net.", "OS": "macOS", "TailscaleIPs": ["100.64.0.11", "fd7a::1"], "Online": True,
                         "LastSeen": "2026-09-25T17:28:10.1Z"},
                   "b": {"HostName": "Anna的MacBook Air", "DNSName": "macbook-air.tailnet-example.ts.net.", "OS": "macOS", "TailscaleIPs": ["100.64.0.13"], "Online": False,
                         "LastSeen": "0001-01-01T00:00:00Z"},
                   "c": {"HostName": "PC_Demo", "DNSName": "pc-demo.tailnet-example.ts.net.", "OS": "windows", "TailscaleIPs": ["100.64.0.14"], "Online": True},
                   "d": {"HostName": "localhost", "DNSName": "iphone.tailnet-example.ts.net.", "OS": "iOS", "TailscaleIPs": ["100.64.0.15"], "Online": True}}}


class Discover(Fixture):
    def test_tailscale_and_the_local_network(self):
        self.write([MINI])
        bonjour = [{"name": "小蓝", "address": "xiaolan.local"}, {"name": "Kiwi的Mac mini", "address": "KiwideMac-mini.local"},
                   {"name": "nas", "address": "nas.local"}]
        rows = H.discover(status=STATUS, bonjour=bonjour, me=["小蓝", "local"])
        by = {r["name"]: r for r in rows}
        self.assertNotIn("小蓝", by)  # this Mac
        self.assertNotIn("localhost", by)  # an iPhone
        mini = by["Kiwi的Mac mini"]
        self.assertEqual((mini["known"], mini["id"], mini["address"], mini["via"], mini["lan_address"], mini["suggested_name"]),
                         (True, "mini", "100.64.0.11", "tailscale", "KiwideMac-mini.local", "mini"))
        air = by["Anna的MacBook Air"]
        self.assertEqual((air["known"], air["online"], air["supported"], air["suggested_name"], air["last_seen"]), (False, False, True, "air", None))
        pc = by["PC_Demo"]
        self.assertEqual((pc["supported"], pc["os"]), (False, "windows"))
        nas = by["nas"]
        self.assertEqual((nas["via"], nas["address"], nas["known"], nas["suggested_name"]), ("lan", "nas.local", False, "nas"))
        self.assertEqual(rows[-1]["name"], "Kiwi的Mac mini")  # known ones last
        self.assertEqual(rows[0]["name"], "nas")  # the ones to add, online first

    def test_no_tailscale_no_dns_sd(self):
        self.assertEqual(H.discover(status={}, bonjour=[], me=["x"]), [])

    def test_bonjour_parsing(self):
        browse = ("Browsing for _ssh._tcp.local.\nDATE: ---Sun 27 Sep 2026---\n23:55:17.246  ...STARTING...\n"
                  "Timestamp     A/R    Flags  if Domain               Service Type         Instance Name\n"
                  "23:55:17.489  Add        3   1 local.               _ssh._tcp.           小蓝\n"
                  "23:55:17.489  Add        2  15 local.               _ssh._tcp.           小蓝\n"
                  "23:55:17.589  Add        2  15 local.               _ssh._tcp.           Kiwi的Mac mini\n")
        lookups = {"小蓝": "xiaolan.local.:22", "Kiwi的Mac mini": "KiwideMac-mini.local.:22"}

        class Proc:
            def __init__(self, argv, **kw):
                self.out = browse if argv[1] == "-B" else f"23:55:24.967  x._ssh._tcp.local. can be reached at {lookups[argv[2]]} (interface 15)\n"

            def terminate(self):
                pass

            def communicate(self, timeout=None):
                return self.out.encode("utf-8"), b""

        with patch.object(H.shutil, "which", return_value="/usr/bin/dns-sd"), patch.object(H.subprocess, "Popen", Proc), patch.object(H.time, "sleep"):
            rows = H.bonjour_ssh()
        self.assertEqual(rows, [{"name": "小蓝", "address": "xiaolan.local", "port": 22}, {"name": "Kiwi的Mac mini", "address": "KiwideMac-mini.local", "port": 22}])


class Cli(unittest.TestCase):
    def test_wired_into_dispatch(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
            env = dict(os.environ, DISPATCH_DIR=d, DISPATCH_HOME=os.path.join(d, "home-dispatch"), BEADS_DIR=os.path.join(d, "none"), HOME=d)
            run = lambda *a, **kw: subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "hosts", *a], capture_output=True, text=True, env=env, timeout=60, **kw)  # noqa: E731
            p = run("add", "100.64.0.11", "--user", "apple", "--name", "mini", "--json")
            self.assertEqual(p.returncode, 0, p.stderr)
            done = json.loads(p.stdout.strip().splitlines()[-1])
            self.assertEqual((done["done"], done["ok"], done["id"]), (True, True, "mini"))
            p = run("set", "mini", "--name", "studio", "--json")
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(json.loads(p.stdout)["host"]["aliases"], [])  # the old name is its id: still found, no alias needed
            with open(os.path.join(d, "home-dispatch", "ssh", "config")) as f:
                self.assertIn("Host studio\n", f.read())
            p = run("add", "not an address", "--user", "apple", "--check", "--json")
            self.assertEqual((p.returncode, json.loads(p.stdout.strip().splitlines()[-1])["ok"]), (1, False))
            p = run("remove", "mini", "--json")  # the old name still finds it
            self.assertEqual((p.returncode, json.loads(p.stdout)["removed"]), (0, "mini"))
            with open(os.path.join(d, "hosts.json")) as f:
                self.assertEqual(json.load(f), [])
            self.assertEqual(len(os.listdir(os.path.join(d, "backups", "hosts"))), 2)


if __name__ == "__main__":
    unittest.main()
