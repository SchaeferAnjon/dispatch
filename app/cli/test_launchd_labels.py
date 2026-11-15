# -*- coding: utf-8 -*-
import os
import tempfile
import unittest

import launchd_labels as L

WINDOWS_READY = True


class Labels(unittest.TestCase):
    def test_new_installs_get_the_neutral_prefix_and_old_jobs_keep_theirs(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(L.label("dispatch-serve", d), "dev.dispatch.dispatch-serve")
            open(os.path.join(d, "dev.schaefer.dispatch-serve.plist"), "w").close()
            self.assertEqual(L.label("dispatch-serve", d), "dev.schaefer.dispatch-serve")
            self.assertEqual(L.label("novnc", d), "dev.dispatch.novnc")


class TestInstances(unittest.TestCase):
    def test_a_prefix_from_the_environment_keeps_a_test_instance_off_the_real_jobs(self):
        import importlib
        from unittest import mock
        try:
            with mock.patch.dict(os.environ, {"DISPATCH_LAUNCHD_PREFIX": "dev.dispatch-test"}):
                importlib.reload(L)
                self.assertEqual(L.label("chatd", "/nonexistent"), "dev.dispatch-test.chatd")
            with mock.patch.dict(os.environ, {"DISPATCH_E2E_INSTANCE": "mob/ile"}):
                importlib.reload(L)
                self.assertEqual(L.label("chatd", "/nonexistent"), "dev.dispatch-e2e-mobile.chatd")
        finally:
            importlib.reload(L)
        self.assertEqual(L.label("chatd", "/nonexistent"), "dev.dispatch.chatd")


class NoLaunchAgentsOnWindows(unittest.TestCase):
    def test_a_home_without_library_gets_the_default_name(self):
        # Windows has no ~/Library/LaunchAgents: the name is still computed (callers may log it), never an error.
        with tempfile.TemporaryDirectory() as home:
            self.assertEqual(L.label("dispatch-serve", os.path.join(home, "Library", "LaunchAgents")), "dev.dispatch.dispatch-serve")


if __name__ == "__main__":
    unittest.main()
