# -*- coding: utf-8 -*-
import json
import os
import unittest

WINDOWS_READY = True

HERE = os.path.dirname(os.path.abspath(__file__))


class Bundle(unittest.TestCase):
    def test_every_cli_module_is_in_the_package_list(self):
        # A packaged CLI (release.sh packs dispatch-cli-<version>.tar.gz from bundle.json) contains only
        # the files listed there. A module missing there works from the repo and silently fails in the
        # package (rules_sync.py did, back when the list was Dispatch.app's tauri.conf.json).
        listed = {os.path.basename(f) for f in json.load(open(os.path.join(HERE, "bundle.json")))["files"]}
        modules = {f for f in os.listdir(HERE) if f.endswith(".py") and not f.startswith("test_")}
        self.assertEqual(sorted(modules - listed), [])

    def test_every_e2e_script_is_in_the_package_list(self):
        # task-vcg2w: hide-windows.mjs was missing, so a test instance started by the packaged CLI showed its windows
        # on the person's screen. Every script the e2e runner starts from scripts/ide-e2e/ has to be packed.
        folder = os.path.join(os.path.dirname(HERE), "scripts", "ide-e2e")
        listed = set(json.load(open(os.path.join(HERE, "bundle.json")))["files"])
        scripts = {"scripts/ide-e2e/" + f for f in os.listdir(folder) if f.endswith(".mjs") and not f.endswith(".test.mjs")}
        self.assertEqual(sorted(scripts - listed), [])

    def test_the_engine_adapters_go_in_as_a_folder(self):
        # engines/ is a package: one file per agent engine, packed as a whole so a new engine is one new file
        conf = json.load(open(os.path.join(HERE, "bundle.json")))
        self.assertEqual(conf["dirs"].get("cli/engines/"), "cli/engines/")
        self.assertTrue(os.path.isfile(os.path.join(HERE, "engines", "__init__.py")))

    def test_listed_files_exist(self):
        app = os.path.dirname(HERE)
        conf = json.load(open(os.path.join(HERE, "bundle.json")))
        self.assertEqual([f for f in conf["files"] if not os.path.isfile(os.path.join(app, f))], [])
        self.assertTrue(os.path.isdir(os.path.join(app, "..", "agent", "skills", "task-board")))


    def test_the_package_carries_dispatch_md_and_finds_it(self):
        # task-nb3v: dispatch.md was not in the package, so a new Mac's ~/.dispatch/rules had only GLOBAL.md and the
        # agents never learned how the task board works. Pack the way release.sh and update-bridge.sh do, then ask the
        # packed CLI where its shipped rules are.
        import shutil, subprocess, sys, tempfile
        app = os.path.dirname(HERE)
        conf = json.load(open(os.path.join(HERE, "bundle.json")))
        with tempfile.TemporaryDirectory() as d:
            dst = os.path.join(d, "dispatch")
            for f in conf["files"]:
                os.makedirs(os.path.dirname(os.path.join(dst, f)), exist_ok=True)
                shutil.copy2(os.path.join(app, f), os.path.join(dst, f))
            for s, t in conf["dirs"].items():
                if os.path.isdir(os.path.join(app, s)):
                    shutil.copytree(os.path.join(app, s), os.path.join(dst, t), dirs_exist_ok=True,
                                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules"))
            self.assertTrue(os.path.isfile(os.path.join(dst, "agent", "rules", "dispatch.md")))
            out = subprocess.run([sys.executable, "-B", "-c", "import dispatch_dir, os; print(os.path.isfile(dispatch_dir.SHIPPED_RULES), dispatch_dir.SHIPPED_RULES)"],
                                 cwd=os.path.join(dst, "cli"), capture_output=True, text=True, timeout=60,
                                 env=dict(os.environ, HOME=d, DISPATCH_HOME=os.path.join(d, ".dispatch"))).stdout.split()
            self.assertEqual(out[0], "True")
            self.assertTrue(os.path.realpath(out[1]).startswith(os.path.realpath(dst)), out[1])


if __name__ == "__main__":
    unittest.main()


class NoBytecodeInsideTheApp(unittest.TestCase):
    """A packaged CLI can sit inside a signed app bundle. A __pycache__ written there is an unsigned
    file in a sealed bundle: `codesign --verify --strict` fails and macOS asks for the privacy
    permissions again."""

    def test_entry_points_switch_bytecode_off_before_importing_siblings(self):
        import re
        here = os.path.dirname(os.path.abspath(__file__))
        siblings = {f[:-3] for f in os.listdir(here) if f.endswith(".py")}
        siblings |= {d for d in os.listdir(here) if os.path.isfile(os.path.join(here, d, "__init__.py"))}  # engines/
        for name in ("dispatch.py", "serve.py", "presence.py", "notify.py", "notify_watch.py", "updater.py", "init_wizard.py", "insights_report.py", "session_control.py", "edit-guard.py", "ide.py", "terminal_hook.py", "life_hook.py"):
            lines = open(os.path.join(here, name), encoding="utf-8").read().split("\n")
            off = next((i for i, l in enumerate(lines) if l.startswith("sys.dont_write_bytecode = True")), None)
            self.assertIsNotNone(off, name)
            first = next((i for i, l in enumerate(lines) if re.match(r"^\s*(import|from)\s+(%s)\b" % "|".join(sorted(siblings)), l)), len(lines))
            self.assertLess(off, first, name)

    def test_running_the_cli_leaves_no_pycache(self):
        import shutil, subprocess, sys, tempfile
        here = os.path.dirname(os.path.abspath(__file__))
        with tempfile.TemporaryDirectory() as d:
            cli = os.path.join(d, "cli")
            shutil.copytree(here, cli, ignore=shutil.ignore_patterns("__pycache__", "test_*"))
            env = {k: v for k, v in os.environ.items() if k != "PYTHONDONTWRITEBYTECODE"}
            env.update(BEADS_DIR=os.path.join(d, ".beads"), DISPATCH_DIR=os.path.join(d, ".dispatch"), HOME=d)
            for argv in (["dispatch.py", "--help"], ["dispatch.py", "notify", "--help"], ["notify.py", "--help"], ["updater.py", "--help"]):
                subprocess.run([sys.executable, os.path.join(cli, argv[0])] + argv[1:], capture_output=True, env=env, timeout=60)
            self.assertFalse(os.path.exists(os.path.join(cli, "__pycache__")), os.listdir(cli))
            self.assertFalse(os.path.exists(os.path.join(cli, "engines", "__pycache__")))
