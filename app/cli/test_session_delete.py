# -*- coding: utf-8 -*-
"""`dispatch session-delete`: transcript to the Trash, then forgotten everywhere; refused while busy."""
import json
import os
import tempfile
import unittest
from contextlib import closing
from types import SimpleNamespace
from unittest.mock import patch

import activity
import session_delete as S

SID = 'abcdef12-0000-4000-8000-00000000000d'
KEY = f'claude-code:{SID}'


class FakeChat:
    def __init__(self, sessions): self.sessions, self.requests = sessions, []
    def __enter__(self): return self
    def __exit__(self, *exc): pass
    def request(self, cmd, timeout=60.0, **f):
        self.requests.append(cmd)
        return {'sessions': self.sessions} if cmd == 'list' else {}


class SessionDeleteTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        home = tmp.name
        proj = os.path.join(home, '.claude', 'projects', '-p')
        os.makedirs(os.path.join(proj, SID, 'subagents'))
        self.path = os.path.join(proj, f'{SID}.jsonl')
        self.sub = os.path.join(proj, SID, 'subagents', 'agent-1.jsonl')
        for p in (self.path, self.sub): open(p, 'w').write('{}\n')
        other = os.path.join(proj, 'other.jsonl'); open(other, 'w').write('{}\n')
        self.idx = {self.path: {'agent': 'claude-code', 'session_id': SID},
                    self.sub: {'agent': 'claude-code', 'session_id': SID, 'subagent': True},
                    other: {'agent': 'claude-code', 'session_id': 'other'}}
        ddir = os.path.join(home, '.dispatch')
        self.saved = None
        self.d = SimpleNamespace(HOME=home, DISPATCH_DIR=ddir, load_index=lambda: dict(self.idx),
                                 save_index=lambda i: setattr(self, 'saved', i), live_sessions=lambda local_only=False: [])
        activity.set_preferences(ddir, KEY, {'title_override': 'x', 'starred': True})
        activity.set_preferences(ddir, 'claude-code:other', {'starred': True})
        activity.acknowledge(ddir, KEY, '1.0:1')
        self.trashed = []
        self.held = patch('activity.chat_held', return_value={}); self.held.start(); self.addCleanup(self.held.stop)

    def run_delete(self, key=KEY):
        return S.delete(self.d, key, move_to_trash=self.trashed.extend)

    def test_trashes_transcript_and_folder_and_forgets_it(self):
        r = self.run_delete()
        self.assertEqual(self.trashed, [self.path, self.path[:-6]])
        self.assertEqual(r['trashed'], self.trashed)
        self.assertEqual(list(self.saved), [p for p in self.idx if 'other' in p])
        prefs = activity.session_preferences(self.d.DISPATCH_DIR)
        self.assertNotIn(KEY, prefs); self.assertIn('claude-code:other', prefs)
        with closing(activity.connect(self.d.DISPATCH_DIR)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM read_replies WHERE key=?', (KEY,)).fetchone()[0], 0)

    def test_finds_an_unindexed_transcript(self):
        self.idx.clear()
        self.run_delete()
        self.assertIn(self.path, self.trashed)

    def test_refuses_a_terminal_held_session(self):
        self.d.live_sessions = lambda local_only=False: [{'agent': 'claude-code', 'session_id': SID, 'agent_pid': 42}]
        with patch('session_control.chat_held_pids', return_value=set()), self.assertRaisesRegex(S.Rejected, '终端'):
            self.run_delete()
        self.assertEqual(self.trashed, [])

    def test_closes_idle_chat_session_first_and_refuses_a_working_one(self):
        self.held.stop()
        with patch('activity.chat_held', return_value={KEY: {'pid': 7}}):
            chat = FakeChat([{'session': KEY, 'lifecycle': 'running'}])
            with patch('chat_client.ChatClient.connect', return_value=chat), self.assertRaisesRegex(S.Rejected, '正在执行'):
                self.run_delete()
            self.assertEqual(self.trashed, [])
            chat = FakeChat([{'session': KEY, 'lifecycle': 'idle'}])
            with patch('chat_client.ChatClient.connect', return_value=chat):
                self.run_delete()
            self.assertEqual(chat.requests, ['list', 'close'])
            self.assertTrue(self.trashed)
        self.held.start()

    def test_refuses_other_agents_and_unknown_sessions(self):
        with self.assertRaisesRegex(S.Rejected, 'Claude 和 Codex'):
            self.run_delete(f'zcode:{SID}')
        with self.assertRaisesRegex(S.Rejected, '找不到'):
            self.run_delete('claude-code:nope')
        with self.assertRaisesRegex(S.Rejected, '无效'):
            self.run_delete('claude-code:../x')

    def test_codex_rollout(self):
        sid = '0199aaaa-0000-7000-8000-000000000001'
        day = os.path.join(self.d.HOME, '.codex', 'sessions', '2026', '09', '26'); os.makedirs(day)
        roll = os.path.join(day, f'rollout-2026-09-26T10-00-00-{sid}.jsonl'); open(roll, 'w').write('{}\n')
        self.run_delete(f'codex:{sid}')
        self.assertEqual(self.trashed, [roll])


if __name__ == '__main__':
    unittest.main()
