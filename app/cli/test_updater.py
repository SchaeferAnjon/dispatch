# -*- coding: utf-8 -*-
import os
import plistlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import dplatform as P
import updater

WINDOWS_READY = True
ON_WINDOWS = os.name == "nt"


@unittest.skipIf(ON_WINDOWS, "macOS: launchctl, os.getuid, POSIX modes")
@patch.object(P, "IS_WIN", False)
class PhoneServiceUpdate(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = Path(self.temp.name) / 'Dispatch.app'
        self.serve = self.app / 'Contents/Resources/cli/serve.py'
        self.serve.parent.mkdir(parents=True)
        self.serve.touch()
        self.plist = Path(self.temp.name) / 'service.plist'

    def run_restart(self, config, loaded=True):
        self.plist.write_bytes(plistlib.dumps(config))
        with patch.object(updater, 'APP', str(self.app)), \
             patch.object(updater.os.path, 'expanduser', return_value=str(self.plist)), \
             patch.object(updater.subprocess, 'run', return_value=SimpleNamespace(returncode=0 if loaded else 1)) as run:
            result = updater.restart_serve()
        return result, plistlib.loads(self.plist.read_bytes()), [c.args[0] for c in run.call_args_list]

    def test_update_moves_old_checkout_service_to_installed_bundle(self):
        config = dict(ProgramArguments=['/opt/homebrew/bin/python3', '/old/checkout/cli/serve.py'],
                      EnvironmentVariables={'DISPATCH_DIST': '/old/checkout/dist', 'BEADS_DIR': '/my/tasks/.beads'},
                      KeepAlive=True, StandardErrorPath='/my/log')
        result, saved, calls = self.run_restart(config)
        self.assertTrue(result)
        self.assertEqual(saved['ProgramArguments'], ['/opt/homebrew/bin/python3', str(self.serve)])
        self.assertEqual(saved['EnvironmentVariables'], {'BEADS_DIR': '/my/tasks/.beads', 'PYTHONDONTWRITEBYTECODE': '1'})
        self.assertTrue(saved['KeepAlive'])
        self.assertEqual(saved['StandardErrorPath'], '/my/log')
        label = f'gui/{os.getuid()}/{updater.SERVE_LABEL}'
        self.assertEqual(calls[1:], [['launchctl', 'bootout', label], ['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(self.plist.resolve())]])

    def test_service_already_using_bundle_only_needs_restart(self):
        config = dict(ProgramArguments=['python3', str(self.serve)], EnvironmentVariables={'PYTHONDONTWRITEBYTECODE': '1'})
        result, saved, calls = self.run_restart(config)
        self.assertTrue(result)
        self.assertEqual(saved, config)
        self.assertEqual(calls[1][1:3], ['kickstart', '-k'])
        self.assertEqual(len(calls), 2)

    def test_does_not_enable_an_uninstalled_phone_service(self):
        config = dict(ProgramArguments=['python3', '/old/checkout/cli/serve.py'])
        result, saved, calls = self.run_restart(config, loaded=False)
        self.assertFalse(result)
        self.assertEqual(saved, config)
        self.assertEqual(len(calls), 1)


class ServeLogMigration(PhoneServiceUpdate):
    def test_a_tmp_log_moves_next_to_dispatch_data(self):
        config = dict(ProgramArguments=['python3', str(self.serve)], EnvironmentVariables={'PYTHONDONTWRITEBYTECODE': '1'},
                      StandardOutPath='/tmp/dispatch-serve.log', StandardErrorPath='/tmp/dispatch-serve.log')
        with patch.object(updater.os.path, 'expanduser', side_effect=lambda p: str(self.plist) if 'LaunchAgents' in p else self.temp.name if p == '~' else p):
            self.plist.write_bytes(plistlib.dumps(config))
            with patch.object(updater, 'APP', str(self.app)), patch.object(updater.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
                self.assertTrue(updater.restart_serve())
        saved = plistlib.loads(self.plist.read_bytes())
        self.assertEqual(saved['StandardOutPath'], os.path.join(self.temp.name, 'tasks', '.dispatch', 'serve.log'))
        self.assertEqual(os.stat(saved['StandardOutPath']).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(self.plist).st_mode & 0o777, 0o600)


@patch.object(P, "IS_WIN", False)
class AssetForThisMachine(unittest.TestCase):
    """The updater never hands an Intel Mac the Apple-silicon zip (task-46xj)."""

    def _check(self, machine, assets):
        import io, json
        body = json.dumps({"tag_name": "v9.9.9", "html_url": "https://example.test/rel", "assets": assets, "body": ""}).encode()

        class R(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False
        with patch.object(updater, 'token', return_value=''), patch.object(updater, 'current_version', return_value='0.7.30'), \
             patch.object(updater.platform, 'machine', return_value=machine), patch.object(updater, 'api', return_value=R(body)):
            return updater.check()

    def test_intel_mac_gets_a_clear_error_not_the_arm_zip(self):
        assets = [{"name": "Dispatch-9.9.9-macos-apple-silicon.zip", "url": "u", "size": 1}]
        r = self._check('x86_64', assets)
        self.assertIsNone(r['asset']); self.assertIn('Intel', r['error']); self.assertFalse(r['newer'])

    def test_apple_silicon_picks_its_own_zip(self):
        assets = [{"name": "Dispatch-9.9.9-macos-intel.zip", "url": "i", "size": 1}, {"name": "Dispatch-9.9.9-macos-apple-silicon.zip", "url": "u", "size": 1}]
        r = self._check('arm64', assets)
        self.assertEqual(r['asset']['name'], 'Dispatch-9.9.9-macos-apple-silicon.zip'); self.assertTrue(r['newer'])


@patch.object(P, "IS_WIN", False)
class RateLimitFallbackAndChecksum(unittest.TestCase):
    """`update check` without the API, a bundle outside /Applications, and the checksum gate (review P1-8)."""

    def test_bundle_path_comes_from_where_the_cli_runs(self):
        with patch.object(updater, 'HERE', '/Users/x/Applications/Dispatch.app/Contents/Resources/cli'):
            self.assertEqual(updater.installed_app(), '/Users/x/Applications/Dispatch.app')
        with patch.object(updater, 'HERE', '/Users/x/Projects/dispatch/app/cli'):
            self.assertEqual(updater.installed_app(), '/Applications/Dispatch.app')

    def test_api_failure_falls_back_to_the_public_redirect(self):
        rel = {"tag_name": "v9.9.9", "html_url": "https://example.test/tag/v9.9.9", "body": "",
               "assets": [{"name": "Dispatch-9.9.9-macos-apple-silicon.zip", "url": "https://dl/zip", "size": 5, "browser_download_url": "https://dl/zip"}]}
        with patch.object(updater, 'token', return_value=''), patch.object(updater, 'current_version', return_value='0.7.30'), \
             patch.object(updater.platform, 'machine', return_value='arm64'), patch.object(updater, 'api', side_effect=OSError('HTTP Error 403: rate limit exceeded')), \
             patch.object(updater, 'latest_without_api', return_value=rel):
            r = updater.check()
        self.assertEqual(r['latest'], '9.9.9'); self.assertTrue(r['newer']); self.assertEqual(r['asset']['download'], 'https://dl/zip'); self.assertEqual(r['tag'], 'v9.9.9')

    def test_when_nothing_answers_the_message_does_not_blame_a_private_repo(self):
        with patch.object(updater, 'token', return_value=''), patch.object(updater, 'current_version', return_value='0.7.30'), \
             patch.object(updater, 'api', side_effect=OSError('offline')), patch.object(updater, 'latest_without_api', return_value=None):
            r = updater.check()
        self.assertNotIn('私有', r['error']); self.assertIn('稍后再试', r['error'])

    @unittest.skipIf(ON_WINDOWS, "codesign is a macOS tool")
    def test_a_broken_or_unsigned_bundle_is_reported(self):
        with tempfile.TemporaryDirectory() as d:
            app = os.path.join(d, "Dispatch.app"); os.makedirs(os.path.join(app, "Contents"))
            self.assertTrue(updater.signature_problem(app))

    def test_no_codesign_tool_means_nothing_to_check(self):
        with patch.object(updater.subprocess, "run", side_effect=FileNotFoundError):
            self.assertEqual(updater.signature_problem("/x/Dispatch.app"), "")

    def test_checksum_lookup(self):
        import io
        class R(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False
        body = b"abc123  Dispatch-9.9.9-macos-apple-silicon.zip\n"
        with patch.object(updater.urllib.request, 'urlopen', return_value=R(body)):
            self.assertEqual(updater.expected_sha256('v9.9.9', 'Dispatch-9.9.9-macos-apple-silicon.zip'), 'abc123')
            self.assertEqual(updater.expected_sha256('v9.9.9', 'other.zip'), '')

class WindowsUpdate(unittest.TestCase):
    """Windows: the NSIS setup.exe is the package; no in-place update, no phone service to restart."""

    def _check(self, assets):
        import io, json
        body = json.dumps({"tag_name": "v9.9.9", "html_url": "https://example.test/rel", "assets": assets, "body": ""}).encode()

        class R(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False
        with patch.object(P, "IS_WIN", True), patch.object(updater, 'token', return_value=''), patch.object(updater, 'current_version', return_value='0.7.30'), \
             patch.object(updater.platform, 'machine', return_value='AMD64'), patch.object(updater, 'api', return_value=R(body)):
            return updater.check()

    def test_amd64_is_windows_x64(self):
        with patch.object(P, "IS_WIN", True), patch.object(updater.platform, 'machine', return_value='AMD64'):
            self.assertEqual(updater.machine_arch(), "windows-x64")

    def test_picks_the_setup_exe(self):
        assets = [{"name": "Dispatch-9.9.9-macos-apple-silicon.zip", "url": "z", "size": 1},
                  {"name": "Dispatch-9.9.9-windows-x64-setup.exe", "url": "e", "size": 2, "browser_download_url": "https://dl/e"}]
        r = self._check(assets)
        self.assertEqual(r['asset']['name'], 'Dispatch-9.9.9-windows-x64-setup.exe'); self.assertTrue(r['newer'])

    def test_a_release_without_a_windows_package_says_so(self):
        r = self._check([{"name": "Dispatch-9.9.9-macos-apple-silicon.zip", "url": "z", "size": 1}])
        self.assertIsNone(r['asset']); self.assertIn('windows-x64-setup.exe', r['error']); self.assertFalse(r['newer'])

    def test_apply_hands_back_the_download_page(self):
        info = {"current": "0.7.30", "latest": "9.9.9", "newer": True, "url": "https://example.test/rel", "tag": "v9.9.9",
                "asset": {"name": "Dispatch-9.9.9-windows-x64-setup.exe", "url": "e", "size": 2, "download": "https://dl/e"}}
        with patch.object(P, "IS_WIN", True), patch.object(updater, "check", return_value=info), \
             patch.object(updater, "api", side_effect=AssertionError("no download")), patch.object(updater.subprocess, "run", side_effect=AssertionError("no ditto / rsync")):
            r = updater.apply()
        self.assertTrue(r["manual"]); self.assertEqual(r["url"], "https://example.test/rel"); self.assertEqual(r["download"], "https://dl/e")
        self.assertIn("setup.exe", r["message"]); self.assertFalse(r["relaunching"])

    def test_no_phone_service_to_restart(self):
        with patch.object(P, "IS_WIN", True), patch.object(updater.os, "getuid", side_effect=AttributeError("no getuid"), create=True), \
             patch.object(updater.subprocess, "run", side_effect=AssertionError("no launchctl")):
            self.assertFalse(updater.restart_serve())

    def test_install_folder(self):
        with patch.object(P, "IS_WIN", True):
            self.assertEqual(updater.installed_app("C:\\Users\\me\\AppData\\Local\\Dispatch\\cli"), "C:\\Users\\me\\AppData\\Local\\Dispatch")

    @unittest.skipUnless(ON_WINDOWS, "real Windows only")
    def test_update_check_runs_on_windows(self):
        import json, subprocess, sys
        cli = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py")
        r = subprocess.run([sys.executable, cli, "update", "check", "--json"], capture_output=True, timeout=120,
                           env=dict(os.environ, PYTHONUTF8="1"))
        out, err = r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")
        self.assertNotIn("Traceback", err + out)
        res = json.loads(out)
        if res.get("asset"):
            self.assertTrue(res["asset"]["name"].endswith("-windows-x64-setup.exe"), res)
        else:
            self.assertTrue(res.get("error"), res)

if __name__ == "__main__":
    unittest.main()
