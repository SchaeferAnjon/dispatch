# -*- coding: utf-8 -*-
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import serve
import notify


class LoginCodes(unittest.TestCase):
    """Notification links carry a single-use code, never the permanent token (review P1-7)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        p = patch.multiple(serve, DISPATCH_DIR=self.tmp.name, LOGINS=os.path.join(self.tmp.name, "serve-logins.json")); p.start(); self.addCleanup(p.stop)

    def test_single_use_and_expiry(self):
        code = serve.login_issue(now=1000)
        self.assertEqual(os.stat(serve.LOGINS).st_mode & 0o777, 0o600)
        self.assertTrue(serve.login_redeem(code, now=1001))
        self.assertFalse(serve.login_redeem(code, now=1002))  # used
        old = serve.login_issue(now=1000)
        self.assertFalse(serve.login_redeem(old, now=1000 + serve.LOGIN_TTL + 1))  # expired
        self.assertFalse(serve.login_redeem("nope", now=1000))

    def test_notification_link_has_no_token(self):
        conf = {"token": "PERMANENT-TOKEN", "port": 7799}
        open(os.path.join(self.tmp.name, "serve.json"), "w").write(json.dumps(conf))
        with patch.object(notify.D, "DISPATCH_DIR", self.tmp.name), patch.object(notify.D, "tailscale_ip", return_value="100.64.0.2"):
            link = notify.serve_link("/#/sessions/abc")
        self.assertNotIn("PERMANENT-TOKEN", link)
        self.assertIn("login=", link); self.assertIn("to=%23%2Fsessions%2Fabc", link); self.assertTrue(link.startswith("http://100.64.0.2:7799/?"))

    def test_no_link_when_the_phone_cannot_reach_this_mac(self):
        open(os.path.join(self.tmp.name, "serve.json"), "w").write(json.dumps({"token": "t"}))
        with patch.object(notify.D, "DISPATCH_DIR", self.tmp.name), patch.object(notify.D, "tailscale_ip", return_value=""), patch.object(notify.D, "lan_ip", return_value="192.168.1.5"):
            self.assertEqual(notify.serve_link("/#/home"), "")  # LAN not allowed → nothing to link to


class PhoneEntryOnAnotherMac(unittest.TestCase):
    """`serve host <id>` says the phone should use the always-on Mac. A phone paired with this
    Mac before that must be taken there, or it loses access whenever this Mac is closed."""

    def test_a_mac_that_points_elsewhere_hands_out_no_links(self):
        with self.assertRaises(SystemExit):
            serve.login_link({"token": "t", "phone_host": "mini"})

    def test_own_link_carries_a_short_lived_code_and_the_page(self):
        with tempfile.TemporaryDirectory() as d, patch.multiple(serve, DISPATCH_DIR=d, LOGINS=os.path.join(d, "l.json")), \
             patch.object(serve, "bind_address", return_value="100.9.9.9"):
            link = serve.login_link({"token": "t", "port": 7799}, to="#/sessions/s1", ttl=300)
            self.assertTrue(link.startswith("http://100.9.9.9:7799/?login="))
            self.assertIn("to=%23%2Fsessions%2Fs1", link)
            self.assertNotIn("token", link)
            import time
            self.assertLessEqual(list(json.load(open(os.path.join(d, "l.json"))).values())[0] - time.time(), 305)

    def test_only_listening_to_itself_is_refused(self):
        with patch.object(serve, "bind_address", return_value="127.0.0.1"), self.assertRaises(SystemExit):
            serve.login_link({"token": "t"})

    def test_forward_page_goes_to_the_link_and_keeps_the_hash(self):
        page = serve.moved_page("http://100.9.9.9:7799/?login=abc", "Mac <mini>")
        self.assertIn("http://100.9.9.9:7799/?login=abc", page)
        self.assertIn("Mac &lt;mini&gt;", page)
        self.assertIn("location.hash", page)

    def test_a_mac_that_is_off_is_asked_once_in_a_while_not_on_every_request(self):
        import subprocess, sys, types
        fake = types.SimpleNamespace(remote_beads=lambda h: "BEADS_DIR=x", remote_cli=lambda h: "dispatch", hosts=lambda: [])
        serve._HOME_DOWN["at"] = 0.0
        with patch.dict(sys.modules, {"dispatch": fake}), patch.object(serve.subprocess, "run", side_effect=subprocess.TimeoutExpired("ssh", 15)) as run:
            self.assertEqual(serve.remote_login_link({"id": "mini", "ssh": "me@mini"}), "")
            self.assertEqual(serve.remote_login_link({"id": "mini", "ssh": "me@mini"}), "")
            self.assertEqual(run.call_count, 1)
        serve._HOME_DOWN["at"] = 0.0

    def test_answering_mac_gives_its_link(self):
        import sys, types
        fake = types.SimpleNamespace(remote_beads=lambda h: "BEADS_DIR=x", remote_cli=lambda h: "dispatch", hosts=lambda: [])
        done = types.SimpleNamespace(returncode=0, stdout="noise\nhttp://100.9.9.9:7799/?login=abc\n", stderr="")
        serve._HOME_DOWN["at"] = 0.0
        with patch.dict(sys.modules, {"dispatch": fake}), patch.object(serve.subprocess, "run", return_value=done) as run:
            self.assertEqual(serve.remote_login_link({"id": "mini", "ssh": "me@mini"}, to="#/x y"), "http://100.9.9.9:7799/?login=abc")
            self.assertIn("--to '#/x y'", run.call_args.args[0][-1])


class Binding(unittest.TestCase):
    def test_lan_only_when_allowed(self):
        import dispatch as d
        with patch.object(d, "tailscale_ip", return_value=""), patch.object(d, "lan_ip", return_value="192.168.1.5"):
            self.assertEqual(serve.detect_address({}), "")
            self.assertEqual(serve.detect_address({"allow_lan": True}), "192.168.1.5")
        with patch.object(d, "tailscale_ip", return_value="100.64.0.2"), patch.object(d, "lan_ip", return_value="192.168.1.5"):
            self.assertEqual(serve.detect_address({}), "100.64.0.2")


if __name__ == "__main__":
    unittest.main()
