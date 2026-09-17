import json
import os
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import dispatch as D
import serve


class RemoteEntry(unittest.TestCase):
    def test_installed_bundle_wins_over_old_source_cli_and_preserves_arguments(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle = Path(tmp) / 'Dispatch app' / 'dispatch.py'
            bundle.parent.mkdir()
            bundle.write_text('import sys,json;print(json.dumps(sys.argv[1:]))')
            values = ['project', "quoted ' project $(false)", '--json']
            with patch.object(D, 'REMOTE_BUNDLED_CLI', str(bundle)):
                cmd = D.remote_cli({'dispatch': '$HOME/.local/bin/dispatch'}) + ' ' + shlex.join(values)
            result = subprocess.run(['/bin/bash', '-c', cmd], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout), values)

    def test_cli_only_machine_uses_existing_entry(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = Path(tmp) / '.local/bin/dispatch'
            cli.parent.mkdir(parents=True)
            cli.write_text('#!/bin/sh\nprintf "%s" "$1"\n')
            cli.chmod(0o755)
            with patch.object(D, 'REMOTE_BUNDLED_CLI', tmp + '/missing'):
                cmd = D.remote_cli({'dispatch': '$HOME/.local/bin/dispatch'}) + ' fallback'
            result = subprocess.run(['/bin/bash', '-c', cmd], env={**os.environ, 'HOME': tmp}, capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout, 'fallback')

    def test_explicit_custom_command_is_preserved(self):
        self.assertEqual(D.remote_cli({'dispatch': '/opt/custom/dispatch --dev'}), '/opt/custom/dispatch --dev')

    def test_proxy_does_not_cut_off_migration_after_sixty_seconds(self):
        host = {'id': 'hub', 'name': '书房的 Mac', 'ssh': 'user@host'}
        result = subprocess.CompletedProcess([], 0, stderr='')
        with patch.object(D, 'local_host_name', return_value='Apple'), patch.object(D, 'hosts', return_value=[host]), patch.object(D.subprocess, 'run', return_value=result) as run:
            with self.assertRaises(SystemExit) as ex:
                D.proxy_to_host(['--host', 'hub', 'project', 'demo', '--move-to', 'Apple'])
            self.assertEqual(ex.exception.code, 0)
            self.assertIsNone(run.call_args.kwargs['timeout'])
            self.assertIn('ServerAliveInterval=15', run.call_args.args[0])
            self.assertIn(D.REMOTE_BUNDLED_CLI, run.call_args.args[0][-1])

    def test_preflight_and_normal_commands_remain_bounded(self):
        self.assertEqual(D.command_timeout(['project', 'demo', '--move-to', 'Apple', '--dry-run']), 180)
        self.assertEqual(D.command_timeout(['hosts']), 60)
        self.assertEqual(D.command_timeout(['project', 'demo', '--owner', 'Apple']), 60)
        self.assertIsNone(D.command_timeout(['move', 'session', '--to', 'Apple']))

    def test_web_entry_uses_same_migration_timeout(self):
        handler = serve.commands()['dispatch_on']
        with patch.object(serve, 'sh', return_value='{}') as run:
            handler({'host': 'hub', 'args': ['project', 'demo', '--move-to', 'Apple']}, 'user')
            self.assertIsNone(run.call_args.kwargs['timeout'])
            handler({'args': ['hosts']}, 'user')
            self.assertEqual(run.call_args.kwargs['timeout'], 300)


if __name__ == '__main__':
    unittest.main()
