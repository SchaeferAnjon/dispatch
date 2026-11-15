# -*- coding: utf-8 -*-
"""mirrors.py and the engine installs that use it: the official servers first, the public mirrors in China when the
setting says so or the official server failed."""
import os
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

import engines as E
import mirrors as M
import net

WINDOWS_READY = False


def _exe(path, body):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
    return path


class Choice(unittest.TestCase):
    def test_effective(self):
        self.assertEqual(M.effective("china")["use"], "china")
        self.assertEqual(M.effective("official", {"npm": {"ok": False}})["use"], "official")
        self.assertEqual(M.effective("auto", {"npm": {"ok": False}})["use"], "china")
        self.assertEqual(M.effective("auto", {"npm": {"ok": True}})["use"], "official")
        self.assertEqual(M.effective("auto", {})["use"], "official")

    def test_auto_asks_npm_once_when_nothing_is_known(self):
        asked = []
        china = M.use_china("auto", ask=lambda only: asked.append(only) or {"results": {"npm": {"ok": False}}})
        self.assertTrue(china)
        self.assertEqual(asked, [["npm"]])
        self.assertFalse(M.use_china("official", ask=lambda only: self.fail("asked")))

    def test_commands_and_variables(self):
        self.assertEqual(M.with_registry(["/usr/local/bin/npm", "i", "-g", "opencode-ai@latest"], True),
                         ["/usr/local/bin/npm", "i", "-g", "opencode-ai@latest", "--registry", M.NPM_CHINA])
        self.assertEqual(M.with_registry(["bun", "add", "-g", "x"], True)[-1], M.NPM_CHINA)
        self.assertEqual(M.with_registry(["brew", "upgrade", "opencode"], True), ["brew", "upgrade", "opencode"])
        self.assertEqual(M.with_registry(["npm", "i", "x"], False), ["npm", "i", "x"])
        env = M.env(True)
        self.assertEqual(env["npm_config_registry"], M.NPM_CHINA)
        self.assertEqual(env["PIP_INDEX_URL"], M.PYPI_CHINA)
        self.assertIn("HOMEBREW_BOTTLE_DOMAIN", env)
        self.assertEqual(M.env(False), {})
        self.assertEqual(M.pip_args(True), ["-i", M.PYPI_CHINA])
        for url in [M.NPM_CHINA, M.PYPI_CHINA, *M.HOMEBREW_CHINA.values()]:
            self.assertTrue(url.startswith("https://"), url)


class EngineInstall(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        p = mock.patch.dict(os.environ, {"DISPATCH_DIR": self.tmp, "PATH": os.path.join(self.tmp, "bin"), "DISPATCH_IDE_BIN": ""})
        p.start()
        self.addCleanup(p.stop)
        # only the test's own bin folder: a real npm in /opt/homebrew/bin must never run here
        only = os.path.join(self.tmp, "bin")
        for q in (mock.patch.object(E, "HOME", self.tmp), mock.patch.object(net, "apply", lambda env, resolved=None: env),
                  mock.patch.object(E, "search_path", lambda env=None: only)):
            q.start()
            self.addCleanup(q.stop)
        os.makedirs(os.path.join(self.tmp, "bin"))

    def test_opencode_updater_becomes_npm_from_the_mirror(self):
        _exe(os.path.join(self.tmp, "bin", "npm"), "#!/bin/sh\nexit 0\n")
        cmd = E.mirrored_command(E.get("opencode"), [os.path.join(self.tmp, ".opencode/bin/opencode"), "upgrade"], True)
        self.assertEqual(os.path.basename(cmd[0]), "npm")
        self.assertEqual(cmd[-2:], ["--registry", M.NPM_CHINA])
        claude = E.mirrored_command(E.get("claude"), ["/x/claude", "update"], True)
        self.assertEqual(claude, ["/x/claude", "update"])

    def test_auto_tries_the_mirror_after_the_official_server_failed(self):
        log = os.path.join(self.tmp, "npm.log")
        state = os.path.join(self.tmp, "v")
        with open(state, "w") as fh:
            fh.write("1.18.0")
        # npm fails without the mirror's registry and installs with it
        _exe(os.path.join(self.tmp, "bin", "npm"),
             f"#!/bin/sh\necho \"$@\" >> {log}\ncase \"$*\" in *registry.npmmirror.com*) echo 1.19.0 > {state}; exit 0;; *) exit 1;; esac\n")
        _exe(os.path.join(self.tmp, "bin", "codex"), f"#!/bin/sh\n/bin/cat {state}\n")
        os.makedirs(os.path.join(self.tmp, "lib", "node_modules"))
        with mock.patch.object(E, "method", lambda eng, path: ("npm", "")), mock.patch.object(M, "use_china", lambda setting=None, results=None, ask=None: False):
            r = E.upgrade("codex", stream=subprocess.DEVNULL)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["mirror"], "china")
        with open(log) as fh:
            lines = fh.read().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertNotIn("npmmirror", lines[0])
        self.assertIn("--registry https://registry.npmmirror.com", lines[1])

    def test_official_setting_never_uses_the_mirror(self):
        net.save(mirror="official", d=self.tmp)
        _exe(os.path.join(self.tmp, "bin", "npm"), "#!/bin/sh\nexit 1\n")
        _exe(os.path.join(self.tmp, "bin", "codex"), "#!/bin/sh\necho 0.1.0\n")
        with mock.patch.object(E, "method", lambda eng, path: ("npm", "")):
            r = E.upgrade("codex", stream=subprocess.DEVNULL)
        self.assertFalse(r["ok"])
        self.assertEqual(r["mirror"], "official")


if __name__ == "__main__":
    unittest.main()
