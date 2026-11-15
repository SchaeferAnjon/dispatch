# -*- coding: utf-8 -*-
"""launchd.plist_body: from inside Dispatch IDE.app a LaunchAgent starts through the app's own launcher (cli/launch/Dispatch IDE), so
macOS names it Dispatch IDE in Login Items and in its "Background Items Added" notice (not python3)."""
import os
import subprocess
import unittest
from unittest import mock

import launchd

APP_CLI = "/Applications/Dispatch IDE.app/Contents/Resources/app/dispatch-cli/dispatch/cli"


class PlistBody(unittest.TestCase):
    def test_from_the_app_the_launcher_comes_first(self):
        with mock.patch.object(launchd, "LAUNCHER", os.path.join(APP_CLI, "launch", "Dispatch IDE")):
            body = launchd.plist_body("dev.dispatch.chatd", ["/usr/bin/python3", os.path.join(APP_CLI, "dispatch.py"), "chatd", "run"], "/tmp/x.log")
        self.assertEqual(body["ProgramArguments"], [os.path.join(APP_CLI, "launch", "Dispatch IDE"), "/usr/bin/python3", os.path.join(APP_CLI, "dispatch.py"), "chatd", "run"])

    def test_from_a_checkout_the_program_is_unchanged(self):
        with mock.patch.object(launchd, "LAUNCHER", "/Users/me/Projects/kanban/app/cli/launch/Dispatch IDE"):
            body = launchd.plist_body("dev.dispatch.chatd", ["/usr/bin/python3", "/Users/me/Projects/kanban/app/cli/dispatch.py", "chatd", "run"], "/tmp/x.log")
        self.assertEqual(body["ProgramArguments"][0], "/usr/bin/python3")

    def test_a_program_already_in_the_app_is_not_wrapped(self):
        with mock.patch.object(launchd, "LAUNCHER", os.path.join(APP_CLI, "launch", "Dispatch IDE")):
            body = launchd.plist_body("x", [os.path.join(APP_CLI, "launch", "Dispatch IDE"), "true"], "/tmp/x.log")
        self.assertEqual(body["ProgramArguments"], [os.path.join(APP_CLI, "launch", "Dispatch IDE"), "true"])

    def test_the_launcher_runs_its_arguments(self):
        self.assertTrue(os.access(launchd.LAUNCHER, os.X_OK), "the launcher must be executable")
        out = subprocess.run([launchd.LAUNCHER, "/bin/echo", "chatd", "run"], capture_output=True, text=True, timeout=10)
        self.assertEqual((out.returncode, out.stdout), (0, "chatd run\n"))


if __name__ == "__main__":
    unittest.main()
