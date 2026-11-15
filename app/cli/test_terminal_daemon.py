# -*- coding: utf-8 -*-
"""`dispatch terminal daemon`: started once, found again, stopped; never a LaunchAgent. A fake app stands in for
Dispatch IDE (its "binary" is a small Python server that behaves like termd.cjs), all in a temporary HOME."""
import json
import os
import plistlib
import stat
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import terminal_daemon as D

FAKE_DAEMON = r'''#!/usr/bin/env python3
import http.server, json, os, sys, signal, threading
args = sys.argv[1:]
state = args[args.index("--state") + 1]
os.makedirs(state, exist_ok=True)
with open(os.path.join(state, "seen-env.json"), "w") as f:
    json.dump({"ELECTRON_RUN_AS_NODE": os.environ.get("ELECTRON_RUN_AS_NODE"), "argv": args, "sid": os.getsid(0) == os.getpid()}, f)
token = "t0ken"
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        ok = self.path.startswith("/health?token=" + token)
        self.send_response(200 if ok else 403); self.end_headers()
        if ok: self.wfile.write(json.dumps({"ok": True, "sessions": [{"id": "s1"}]}).encode())
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
info = {"pid": os.getpid(), "port": srv.server_address[1], "token": token, "version": 1}
tmp = os.path.join(state, "daemon.json.tmp")
with open(tmp, "w") as f: json.dump(info, f)
os.replace(tmp, os.path.join(state, "daemon.json"))
signal.signal(signal.SIGTERM, lambda *a: os._exit(0))
srv.serve_forever()
'''


class Daemon(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        p = mock.patch.dict(os.environ, {"HOME": self.tmp, "DISPATCH_DIR": os.path.join(self.tmp, "state"), "DISPATCH_IDE_APP_ROOT": ""})
        p.start()
        self.addCleanup(p.stop)
        contents = os.path.join(self.tmp, "Fake.app", "Contents")
        self.root = os.path.join(contents, "Resources", "app")
        os.makedirs(self.root)
        os.makedirs(os.path.join(contents, "MacOS"))
        with open(os.path.join(contents, "Info.plist"), "wb") as f:
            plistlib.dump({"CFBundleExecutable": "Fake App"}, f)
        exe = os.path.join(contents, "MacOS", "Fake App")
        fake = os.path.join(self.tmp, "fake_termd.py")
        with open(fake, "w") as f:
            f.write(FAKE_DAEMON)
        with open(exe, "w") as f:
            f.write(f'#!/bin/sh\necho "$1" > "$(dirname "$0")/script-arg"; shift\nexec "{sys.executable}" "{fake}" "$@"\n')
        os.chmod(exe, os.stat(exe).st_mode | stat.S_IXUSR)
        self.addCleanup(D.stop)

    def test_finds_the_apps_own_binary_from_its_resources_folder(self):
        self.assertEqual(D.app_binary(self.root), os.path.join(os.path.dirname(os.path.dirname(self.root)), "MacOS", "Fake App"))

    def test_a_development_build_names_its_electron_in_its_manifest(self):
        tree = os.path.join(self.tmp, "ide", "vscode")
        os.makedirs(os.path.join(tree, ".build"))
        exe = os.path.join(self.tmp, "Dispatch IDE Dev")
        with open(exe, "w") as f:
            f.write("#!/bin/sh\n")
        os.chmod(exe, 0o755)
        with open(os.path.join(tree, ".build", "dispatch-dev.json"), "w") as f:
            json.dump({"binary": exe}, f)
        self.assertEqual(D.app_binary(tree), exe)

    def test_start_runs_it_on_the_apps_electron_in_a_group_of_its_own(self):
        out = D.start(self.root)
        self.assertTrue(out["ok"], out)
        self.assertTrue(out["running"])
        self.assertTrue(out["url"].startswith(f"ws://127.0.0.1:{out['port']}/ws?token="))
        seen = json.load(open(os.path.join(D.state_dir(), "seen-env.json")))
        self.assertEqual(seen["ELECTRON_RUN_AS_NODE"], "1")
        self.assertTrue(seen["sid"], "the daemon must lead its own session so quitting the app does not end it")
        self.assertEqual(seen["argv"][seen["argv"].index("--app-root") + 1], self.root)
        script = open(os.path.join(os.path.dirname(os.path.dirname(self.root)), "MacOS", "script-arg")).read().strip()
        self.assertEqual(script, D.script_path())
        self.assertTrue(os.path.isfile(script), "termd.cjs ships next to the CLI")

    def test_a_second_start_finds_the_running_one(self):
        first = D.start(self.root)
        second = D.start(self.root)
        self.assertEqual(first["pid"], second["pid"])

    def test_a_window_opening_starts_it_only_for_kept_terminals(self):
        self.assertFalse(D.start(self.root, if_kept=True)["running"])
        os.makedirs(os.path.join(D.state_dir(), "sessions", "abc"))
        self.assertTrue(D.start(self.root, if_kept=True)["running"])

    def test_status_and_stop(self):
        self.assertFalse(D.status()["running"])
        pid = D.start(self.root)["pid"]
        self.assertEqual(D.status()["sessions"], [{"id": "s1"}])
        self.assertTrue(D.stop()["stopped"])
        for _ in range(30):
            if not D._alive(pid):
                break
            time.sleep(0.1)
        self.assertFalse(D.status()["running"])

    def test_a_cli_copy_without_termd_uses_the_one_packed_in_the_app(self):
        packed = os.path.join(self.root, "dispatch-cli", "dispatch", "termd", "termd.cjs")
        os.makedirs(os.path.dirname(packed))
        open(packed, "w").close()
        with mock.patch.object(D, "HERE", os.path.join(self.tmp, "copy", "cli")):
            self.assertEqual(D.script_path(self.root), packed)

    def test_without_the_app_it_says_what_to_do(self):
        with mock.patch.object(D, "app_root", lambda given="": ""):
            out = D.start("")
        self.assertFalse(out["ok"])
        self.assertIn("Open Dispatch IDE", out["message"])

    def test_it_is_never_a_launch_agent(self):
        D.start(self.root)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "Library", "LaunchAgents")))

    def test_state_lives_under_dispatch_dir(self):
        self.assertEqual(D.state_dir(), os.path.join(self.tmp, "state", "termd"))

    def test_the_cli_answers_json(self):
        import argparse
        import io
        import terminal_cmd
        buf = io.StringIO()
        with mock.patch("sys.stdout", buf), self.assertRaises(SystemExit) as done:
            terminal_cmd.command(argparse.Namespace(op="daemon", sub="status", app_root="", if_kept=False, json=True))
        self.assertEqual(done.exception.code, 0)
        self.assertEqual(json.loads(buf.getvalue())["running"], False)


if __name__ == "__main__":
    unittest.main()
