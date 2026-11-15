import io
import os
import tempfile
import types
import unittest
from unittest.mock import patch

import dispatch as D


class _Stdin(io.StringIO):
    def __init__(self, text, tty=False):
        super().__init__(text)
        self._tty = tty

    def isatty(self):
        return self._tty


class WholeFileWriteGuard(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.target = os.path.join(self.d, "FACTS.md")
        with open(self.target, "w") as f:
            f.write("# Facts\n- one\n- two\n")

    def run_guard(self, stdin, text=None):
        a = types.SimpleNamespace(text=text)
        with patch.object(D.sys, "stdin", stdin):
            return D.guarded_whole_file_text(a, self.target)

    def test_text_flag_is_refused(self):
        with self.assertRaises(SystemExit):
            self.run_guard(_Stdin(""), text="- new fact")

    def test_empty_or_terminal_stdin_is_refused(self):
        for stdin in (_Stdin("", tty=True), _Stdin(""), _Stdin("  \n")):
            with self.assertRaises(SystemExit):
                self.run_guard(stdin)
        with open(self.target) as f:
            self.assertIn("- two", f.read())

    def test_real_content_passes_and_keeps_a_backup(self):
        import backups
        self.assertEqual(self.run_guard(_Stdin("# Facts\n- three\n")), "# Facts\n- three\n")
        self.assertEqual(os.listdir(self.d), ["FACTS.md"])  # nothing beside the file
        kept = [os.path.join(dp, f) for dp, _, fs in os.walk(backups.root()) for f in fs if f == "FACTS.md"]
        self.assertTrue(any("- one" in open(p).read() for p in kept), kept)


if __name__ == "__main__":
    unittest.main()
