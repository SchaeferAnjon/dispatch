# -*- coding: utf-8 -*-
import os
import tempfile
import unittest

import launchd_labels as L


class Labels(unittest.TestCase):
    def test_new_installs_get_the_neutral_prefix_and_old_jobs_keep_theirs(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(L.label("dispatch-serve", d), "dev.dispatch.dispatch-serve")
            open(os.path.join(d, "dev.schaefer.dispatch-serve.plist"), "w").close()
            self.assertEqual(L.label("dispatch-serve", d), "dev.schaefer.dispatch-serve")
            self.assertEqual(L.label("novnc", d), "dev.dispatch.novnc")


if __name__ == "__main__":
    unittest.main()
