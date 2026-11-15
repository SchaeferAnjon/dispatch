# -*- coding: utf-8 -*-
"""Sorts last: the run fails when a test (or a child process it started) tried to reach the real board or the shared Dolt server."""
import os
import unittest

import testkit

WINDOWS_READY = False


class NothingReachedTheRealBoard(unittest.TestCase):
    @unittest.skipUnless(testkit.active(), "test_00_isolation did not switch isolation on (single-module run)")
    def test_no_bd_or_dolt_call_was_refused(self):
        self.assertEqual(testkit.violations(), [])

    @unittest.skipUnless(testkit.active(), "test_00_isolation did not switch isolation on (single-module run)")
    def test_the_environment_is_as_the_run_started(self):
        """A module or a class that set a variable outside a test (at import, in setUpClass) and never put it back."""
        changes = testkit.env_changes(testkit.start_env(), dict(os.environ))
        self.assertEqual(changes, [], testkit.describe_changes(changes))

    def test_no_literal_tilde_folder_in_the_working_folders(self):
        """`~/.config/bd` and the like made by a child that had no HOME (bd writes its config to ./~ then)."""
        here = os.path.dirname(os.path.abspath(__file__))
        for d in (here, os.path.dirname(here), os.getcwd()):
            self.assertFalse(os.path.lexists(os.path.join(d, "~")), d)


if __name__ == "__main__":
    unittest.main()
