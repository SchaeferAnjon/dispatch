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
        self.assertEqual(saved['EnvironmentVariables'], {'BEADS_DIR': '/my/tasks/.beads'})
        self.assertTrue(saved['KeepAlive'])
        self.assertEqual(saved['StandardErrorPath'], '/my/log')
        label = f'gui/{os.getuid()}/{updater.SERVE_LABEL}'
        self.assertEqual(calls[1:], [['launchctl', 'bootout', label], ['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(self.plist.resolve())]])

    def test_service_already_using_bundle_only_needs_restart(self):
        config = dict(ProgramArguments=['python3', str(self.serve)])
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
