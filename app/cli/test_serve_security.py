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
