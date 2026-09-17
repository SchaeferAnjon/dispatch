import os
import plistlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import updater


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
