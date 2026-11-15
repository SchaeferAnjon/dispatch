# -*- coding: utf-8 -*-
"""OpenCode's plugin kit from inside Dispatch IDE (opencode_kit.py, task-lj06.13): unpacked into the config folders
OpenCode would install it into from npm, never over packages that are already there."""
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

import engines
import opencode_engine
import opencode_kit as K


def make_kit(path, version="1.18.34", link=True):
    """A small kit shaped like the real one: package.json, package-lock.json and node_modules with a .bin link."""
    files = {
        "package.json": json.dumps({"dependencies": {"@opencode-ai/plugin": version}}),
        "package-lock.json": json.dumps({"lockfileVersion": 3, "packages": {"": {"dependencies": {"@opencode-ai/plugin": version}},
                                                                            "node_modules/@opencode-ai/plugin": {"version": version}}}),
        "node_modules/@opencode-ai/plugin/package.json": json.dumps({"name": "@opencode-ai/plugin", "version": version}),
        "node_modules/yaml/bin.mjs": "#!/usr/bin/env node\n",
    }
    with tarfile.open(path, "w:gz") as t:
        for name, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
        if link:
            info = tarfile.TarInfo("node_modules/.bin/yaml")
            info.type = tarfile.SYMTYPE
            info.linkname = "../yaml/bin.mjs"
            t.addfile(info)
    return path


class Kit(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, "home")
        self.cfg = os.path.join(self.home, ".config", "opencode")
        os.makedirs(os.path.join(self.cfg, "plugins"))
        self.kit = make_kit(os.path.join(self.tmp, K.KIT_NAME))
        self.env = {"DISPATCH_IDE_BIN": self.tmp}

    def seed(self, **kw):
        return K.seed(env=kw.pop("env", self.env), home=self.home, **kw)

    def lock(self, d):
        with open(os.path.join(d, "package-lock.json"), encoding="utf-8") as f:
            return json.load(f)

    def test_a_new_mac_gets_the_kit_in_its_config_folder_and_in_the_installers_folder(self):
        os.makedirs(os.path.join(self.home, ".opencode", "bin"))
        r = self.seed()
        self.assertEqual(r["kit"], self.kit)
        self.assertEqual(r["seeded"], [self.cfg, os.path.join(self.home, ".opencode")])
        for d in r["seeded"]:
            # what OpenCode's own install looks for before it goes to npm: node_modules, and the plugin in the lock file
            self.assertIn("@opencode-ai/plugin", self.lock(d)["packages"][""]["dependencies"])
            self.assertTrue(os.path.isfile(os.path.join(d, "node_modules", "@opencode-ai", "plugin", "package.json")))
            self.assertEqual(os.readlink(os.path.join(d, "node_modules", ".bin", "yaml")), "../yaml/bin.mjs")
            self.assertEqual([n for n in os.listdir(d) if n.startswith(".dispatch-kit-")], [])
        self.assertTrue(os.path.isdir(os.path.join(self.cfg, "plugins")))
        # a second time: nothing to do
        again = self.seed()
        self.assertEqual(again["seeded"], [])
        self.assertEqual(set(again["skipped"].values()), {"has its own packages"})

    def test_packages_already_there_are_left_alone(self):
        for own in ("package.json", "package-lock.json", "node_modules"):
            with self.subTest(own=own):
                shutil.rmtree(self.cfg)
                os.makedirs(self.cfg)
                p = os.path.join(self.cfg, own)
                if own == "node_modules":
                    os.makedirs(p)
                else:
                    with open(p, "w", encoding="utf-8") as f:
                        f.write('{"dependencies": {"oh-my-plugin": "1.0.0"}}')
                r = self.seed()
                self.assertEqual(r["seeded"], [])
                self.assertEqual(r["skipped"][self.cfg], "has its own packages")
                self.assertEqual(sorted(os.listdir(self.cfg)), [own])

    def test_no_kit_in_this_install_says_so_and_changes_nothing(self):
        os.unlink(self.kit)
        r = self.seed()
        self.assertEqual(r["kit"], "")
        self.assertEqual(r["skipped"], {self.cfg: "no plugin kit in this install"})
        self.assertEqual(os.listdir(self.cfg), ["plugins"])

    def test_the_kit_is_looked_for_where_the_app_says(self):
        self.assertEqual(K.kit_path(env=self.env), self.kit)
        self.assertEqual(K.kit_path(self.kit, env={}), self.kit)
        self.assertEqual(K.kit_path(os.path.join(self.tmp, "nope.tgz"), env=self.env), "")
        # DISPATCH_IDE_BIN is the running app's tools folder: no looking elsewhere when it has none
        with mock.patch("dplatform.app_tools_dirs", return_value=[self.tmp]):
            self.assertEqual(K.kit_path(env={"DISPATCH_IDE_BIN": os.path.join(self.tmp, "home")}), "")
            self.assertEqual(K.kit_path(env={}), self.kit)

    def test_a_projects_own_opencode_folders_up_to_its_git_root(self):
        repo = os.path.join(self.tmp, "work", "app")
        os.makedirs(os.path.join(repo, ".git"))
        os.makedirs(os.path.join(repo, ".opencode"))
        os.makedirs(os.path.join(repo, "web", ".opencode"))
        os.makedirs(os.path.join(self.tmp, "work", ".opencode"))  # above the git root: OpenCode does not read it
        dirs = K.config_dirs(os.path.join(repo, "web"), env={}, home=self.home)
        self.assertEqual(dirs, [self.cfg, os.path.join(repo, "web", ".opencode"), os.path.join(repo, ".opencode")])
        r = self.seed(cwd=os.path.join(repo, "web"))
        self.assertEqual(r["seeded"], dirs)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "work", ".opencode", "node_modules")))
        self.assertEqual(K.config_dirs(os.path.join(repo, "web"), env={"OPENCODE_DISABLE_PROJECT_CONFIG": "1"}, home=self.home), [self.cfg])

    def test_xdg_config_home_and_opencode_config_dir(self):
        xdg = os.path.join(self.tmp, "xdg")
        extra = os.path.join(self.tmp, "extra")
        os.makedirs(os.path.join(xdg, "opencode"))
        os.makedirs(extra)
        env = dict(self.env, XDG_CONFIG_HOME=xdg, OPENCODE_CONFIG_DIR=extra)
        self.assertEqual(K.config_dirs("", env=env, home=self.home), [os.path.join(xdg, "opencode"), extra])

    def test_without_tar_python_unpacks_it_and_refuses_paths_outside(self):
        with mock.patch("shutil.which", return_value=None), mock.patch("os.path.exists", side_effect=lambda p: False if p == "/usr/bin/tar" else os.path.lexists(p)):
            r = self.seed()
        self.assertEqual(r["seeded"], [self.cfg])
        self.assertEqual(os.readlink(os.path.join(self.cfg, "node_modules", ".bin", "yaml")), "../yaml/bin.mjs")
        bad = os.path.join(self.tmp, "bad.tgz")
        with tarfile.open(bad, "w:gz") as t:
            info = tarfile.TarInfo("../escape.txt")
            info.size = 1
            t.addfile(info, io.BytesIO(b"x"))
        into = os.path.join(self.tmp, "into")
        os.makedirs(into)
        with mock.patch("shutil.which", return_value=None), mock.patch("os.path.exists", return_value=False):
            with self.assertRaises(tarfile.TarError):
                K._unpack(bad, into)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "escape.txt")))

    def test_a_broken_kit_leaves_the_folder_as_it_was(self):
        with open(self.kit, "wb") as f:
            f.write(b"not a tarball")
        r = self.seed()
        self.assertEqual(r["seeded"], [])
        self.assertTrue(r["skipped"][self.cfg].startswith("could not unpack"))
        self.assertEqual(os.listdir(self.cfg), ["plugins"])

    def test_command_answers_json(self):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"HOME": self.home, "DISPATCH_IDE_BIN": self.tmp}), mock.patch("sys.stdout", out), \
                mock.patch.object(K.os.path, "expanduser", side_effect=lambda p: p.replace("~", self.home, 1)):
            K.command(SimpleNamespace(cwd="", kit="", json=True))
        r = json.loads(out.getvalue())
        self.assertEqual(r["seeded"], [self.cfg])


class Callers(unittest.TestCase):
    """First-run setup (install-plugin) and an OpenCode install from Dispatch put the kit in place too."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_install_plugin_puts_the_kit_next_to_the_plugin(self):
        env = {"XDG_CONFIG_HOME": os.path.join(self.tmp, "config")}
        os.makedirs(os.path.join(self.tmp, "config", "opencode"))
        source = os.path.join(self.tmp, "dispatch.js")
        with open(source, "w", encoding="utf-8") as f:
            f.write("// Dispatch integration for OpenCode\n")
        with mock.patch.object(K, "seed", return_value={"ok": True, "seeded": ["x"]}) as seed:
            r = opencode_engine.install_plugin(source=source, env=env)
            self.assertEqual(r["kit"], {"ok": True, "seeded": ["x"]})
            seed.assert_called_once_with(env=env)
            self.assertIn("kit", opencode_engine.install_plugin(source=source, env=env))  # unchanged: still looked at

    def test_installing_opencode_seeds_its_new_folder(self):
        with mock.patch.object(engines, "engine_path", side_effect=[None, "/x/opencode"]), \
                mock.patch.object(engines, "install_command", return_value=["curl", "-fsSL", "https://opencode.ai/install"]), \
                mock.patch.object(engines, "_run_install", return_value=0), \
                mock.patch.object(engines, "installed_version", return_value="1.18.34"), \
                mock.patch("mirrors.mode", return_value="official"), \
                mock.patch.object(K, "seed", return_value={"ok": True, "seeded": ["~/.opencode"]}) as seed:
            r = engines.upgrade("opencode", stream=open(os.devnull, "w"), china=False)
        self.assertTrue(r["ok"])
        self.assertEqual(r["kit"], {"ok": True, "seeded": ["~/.opencode"]})
        seed.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
