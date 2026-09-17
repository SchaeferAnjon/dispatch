# -*- coding: utf-8 -*-
import json
import subprocess
import unittest
from unittest.mock import patch

import dispatch as D


class RemoteHerdr(unittest.TestCase):
    def setUp(self):
        D._HERDR_REMOTE_SESSIONS.clear()
        self.addCleanup(D._HERDR_REMOTE_SESSIONS.clear)
        self.root = {'name': 'default', 'default': True, 'running': True}
        self.main = {'name': 'main', 'default': False, 'running': True}
        self.host = {'ssh': 'user@host', 'herdr_session': 'main'}

    def test_stale_main_config_uses_only_running_default(self):
        self.assertIsNone(D.choose_remote_herdr_session('main', [self.root]))

    def test_running_explicit_session_wins(self):
        self.assertEqual(D.choose_remote_herdr_session('main', [self.root, self.main]), 'main')
        self.assertIsNone(D.choose_remote_herdr_session('default', [self.root, self.main]))

    def test_stopped_sessions_are_not_targets(self):
        self.assertIsNone(D.choose_remote_herdr_session('main', [self.root, dict(self.main, running=False)]))
        with self.assertRaisesRegex(ValueError, '没有运行'):
            D.choose_remote_herdr_session('main', [dict(self.main, running=False)])

    def test_ambiguous_sessions_require_explicit_choice(self):
        with self.assertRaisesRegex(ValueError, '多个'):
            D.choose_remote_herdr_session('missing', [self.root, self.main])

    def test_probe_once_then_create_on_default_without_session_flag(self):
        probe = subprocess.CompletedProcess([], 0, json.dumps({'sessions': [self.root]}), '')
        created = subprocess.CompletedProcess([], 0, '{"result":{"tab_id":"w9"}}', '')
        with patch.object(D.subprocess, 'run', side_effect=[probe, created, created]) as run:
            self.assertEqual(D.herdr(self.host, ['tab', 'create', '--cwd', '/path with spaces'])['result']['tab_id'], 'w9')
            self.assertNotIn('--session', run.call_args.args[0][-1])
            self.assertIn("'/path with spaces'", run.call_args.args[0][-1])
            D.herdr(self.host, ['agent', 'list'])
            self.assertEqual(run.call_count, 3)

    def test_failed_probe_never_creates_a_tab(self):
        probe = subprocess.CompletedProcess([], 0, '{"sessions":[]}', '')
        with patch.object(D.subprocess, 'run', return_value=probe) as run:
            self.assertIn('error', D.herdr(self.host, ['tab', 'create']))
            self.assertEqual(run.call_count, 1)
