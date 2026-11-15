"""dispatch me: the GitHub account for the title bar's picture."""
import os, sys, tempfile, unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import me


class Me(unittest.TestCase):
    def test_hosts_file(self):
        text = "github.com:\n    git_protocol: ssh\n    users:\n        Other:\n    user: SchaeferAnjon\nghe.example.com:\n    user: someone-else\n"
        self.assertEqual(me.login_from_hosts(text), "SchaeferAnjon")
        self.assertIsNone(me.login_from_hosts("ghe.example.com:\n    user: x\n"))
        self.assertIsNone(me.login_from_hosts("github.com:\n    user: not a login\n"))
        self.assertIsNone(me.login_from_hosts(""))

    def test_who_reads_gh_then_git(self):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "gh"))
        with open(os.path.join(d, "gh", "hosts.yml"), "w") as f:
            f.write("github.com:\n    user: octo-cat\n")
        with patch.dict(os.environ, {"GH_CONFIG_DIR": os.path.join(d, "gh")}), patch.object(me, "_git", return_value=""):
            r = me.who()
        self.assertEqual(r["github"], "octo-cat")
        self.assertEqual(r["avatar"], "https://github.com/octo-cat.png?size=64")
        with patch.dict(os.environ, {"GH_CONFIG_DIR": os.path.join(d, "none")}), patch.object(me, "_git", side_effect=lambda *a: "from-git" if a == ("github.user",) else "Ann"):
            r = me.who()
        self.assertEqual((r["github"], r["name"]), ("from-git", "Ann"))
        with patch.dict(os.environ, {"GH_CONFIG_DIR": os.path.join(d, "none")}), patch.object(me, "_git", return_value=""):
            self.assertEqual(me.who(), {"github": "", "name": "", "avatar": ""})


if __name__ == "__main__":
    unittest.main()
