# -*- coding: utf-8 -*-
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import firstrun as F


class Banner(unittest.TestCase):
    def test_test_banner_says_what_it_is_for(self):
        sent = []
        with mock.patch.object(F.sys, "platform", "darwin"):
            out = F.notify_test(send=lambda title, body: sent.append((title, body)))
        self.assertTrue(out["ok"])
        self.assertEqual(sent, [("Dispatch", F.TEST_BODY)])
        self.assertNotIn("osascript", out["message"] + F.TEST_BODY)

    def test_a_failed_banner_is_reported_not_raised(self):
        def boom(title, body):
            raise RuntimeError("no permission")
        with mock.patch.object(F.sys, "platform", "darwin"):
            out = F.notify_test(send=boom)
        self.assertFalse(out["ok"])
        self.assertIn("no permission", out["message"])

    def test_muted_instances_show_nothing(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"DISPATCH_DIR": d}), mock.patch.object(F.sys, "platform", "darwin"):
            open(os.path.join(d, "no-banners"), "w").close()
            with mock.patch("notify._local") as shown:
                self.assertTrue(F.notify_test()["ok"])
            shown.assert_not_called()

    def test_only_on_a_mac(self):
        with mock.patch.object(F.sys, "platform", "win32"):
            self.assertFalse(F.notify_test(send=lambda t, b: None)["ok"])
            self.assertFalse(F.notify_settings()["ok"])

    def test_opens_notification_settings(self):
        run = mock.Mock(return_value=mock.Mock(returncode=0))
        with mock.patch.object(F.sys, "platform", "darwin"):
            out = F.notify_settings(run=run)
        self.assertTrue(out["ok"])
        self.assertEqual(run.call_args[0][0], ["open", "x-apple.systempreferences:com.apple.Notifications-Settings.extension"])


if __name__ == "__main__":
    unittest.main()
