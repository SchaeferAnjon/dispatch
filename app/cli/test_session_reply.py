import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
import uuid
from datetime import datetime, timezone

import session_reply as reply


class Replies(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = SimpleNamespace(HOME=self.tmp.name, DISPATCH_DIR=self.tmp.name, SESS_DIR=self.tmp.name)
        self.ref = dict(agent='claude-code', session_id='session-exact', cwd='/project')

    def test_exact_identity_does_not_accept_prefix_or_another_agent(self):
        self.d.load_index = lambda: {'/transcript': dict(self.ref, mtime=1)}
        self.assertEqual(reply.exact_ref(self.d, 'session-exact', 'claude-code')['path'], '/transcript')
        for sid, agent in [('session', 'claude-code'), ('session-exact', 'codex')]:
            with self.assertRaises(reply.Rejected): reply.exact_ref(self.d, sid, agent)

    def test_target_uses_pid_not_shared_directory(self):
        with open(os.path.join(self.tmp.name, 'session.json'), 'w') as f:
            json.dump(dict(self.ref, agent_pid=42, last_at=2), f)
        self.d.herdr_agents = lambda: [dict(agent='claude', pane_id='wrong', cwd='/project', agent_status='idle'), dict(agent='claude', pane_id='right', cwd='/project', agent_status='idle')]
        self.d.herdr = lambda _, args: {'result': {'process_info': {'foreground_processes': [{'pid': 42 if args[-1] == 'right' else 99}]}}}
        self.assertEqual(reply.herdr_target(self.d, self.ref)['pane_id'], 'right')
        with open(os.path.join(self.tmp.name, 'newer.json'), 'w') as f:
            json.dump(dict(self.ref, session_id='new-session', agent_pid=42, last_at=3), f)
        with self.assertRaises(reply.Rejected): reply.herdr_target(self.d, self.ref)

    def test_repeat_delivery_id_is_sent_only_once_and_rejects_changed_content(self):
        ipc = Mock(); ipc.send.return_value = '已送达'
        rid = str(uuid.uuid4())
        with patch.object(reply, 'target', return_value={'kind': 'codex-desktop'}), patch.object(reply, 'DesktopIPC', return_value=ipc):
            first = reply.submit(self.d, self.ref, '多行\n`echo` $(whoami)', rid)
            second = reply.submit(self.d, self.ref, '多行\n`echo` $(whoami)', rid)
            self.assertEqual(first['state'], 'accepted')
            self.assertEqual(second['state'], 'accepted')
            ipc.send.assert_called_once()
            with self.assertRaises(reply.Rejected): reply.submit(self.d, self.ref, 'changed', rid)

    def test_timeout_is_unknown_and_never_automatically_replayed(self):
        ipc = Mock(); ipc.send.side_effect = TimeoutError()
        rid = str(uuid.uuid4())
        with patch.object(reply, 'target', return_value={'kind': 'codex-desktop'}), patch.object(reply, 'DesktopIPC', return_value=ipc):
            self.assertEqual(reply.submit(self.d, self.ref, 'hello', rid)['state'], 'unknown')
            self.assertEqual(reply.submit(self.d, self.ref, 'hello', rid)['state'], 'unknown')
            ipc.send.assert_called_once()

    def test_blocked_target_cannot_create_a_submission(self):
        with patch.object(reply, 'target', side_effect=reply.Rejected('blocked')):
            with self.assertRaises(reply.Rejected): reply.submit(self.d, self.ref, 'hello', str(uuid.uuid4()))
        with reply.connect(self.d) as db: self.assertEqual(db.execute('SELECT count(*) FROM replies').fetchone()[0], 0)

    def test_uncertain_receipt_reconciles_only_a_new_user_message(self):
        ipc=Mock();ipc.send.side_effect=TimeoutError();rid=str(uuid.uuid4())
        with patch.object(reply,'target',return_value={'kind':'codex-desktop','label':'ready'}), patch.object(reply,'DesktopIPC',return_value=ipc):
            receipt=reply.submit(self.d,self.ref,'hello',rid)
            self.ref['path']='/transcript';self.d.ref_of=lambda *args:self.ref
            messages=[{'role':'user','text':'hello','ts':'2020-01-01T00:00:00Z'}]
            self.d.read_session_detail=lambda _: {'messages':messages}
            self.assertEqual(reply.status(self.d,self.ref)['receipts'][0]['state'],'unknown')
            messages.append({'role':'user','text':'hello','ts':datetime.fromtimestamp(receipt['created']+1,timezone.utc).isoformat()})
            self.assertEqual(reply.status(self.d,self.ref)['receipts'][0]['state'],'accepted')
            ipc.send.assert_called_once()

    def test_desktop_inactive_turn_starts_original_thread_without_setting_override(self):
        ipc = object.__new__(reply.DesktopIPC)
        ipc.owner = Mock(return_value='owner-exact')
        ipc.request = Mock(side_effect=[{'resultType':'error','error':'no active turn to steer'}, {'resultType':'success','result':{}}])
        ipc.send(self.ref, '继续', 'client-message')
        self.assertEqual(ipc.request.call_count, 2)
        method, params, owner = ipc.request.call_args.args
        self.assertEqual((method, owner), ('thread-follower-start-turn', 'owner-exact'))
        self.assertEqual(params['turnStart']['request']['threadId'], 'session-exact')
        self.assertNotIn('permissions', params['turnStart']['request'])
        self.assertNotIn('model', params['turnStart']['request'])

    def test_desktop_ambiguous_failure_never_falls_back_to_new_turn(self):
        ipc = object.__new__(reply.DesktopIPC)
        ipc.owner = Mock(return_value='owner-exact')
        ipc.request = Mock(return_value={'resultType':'error', 'error':'timeout'})
        with self.assertRaises(RuntimeError): ipc.send(self.ref, '继续', 'client-message')
        ipc.request.assert_called_once()


if __name__ == '__main__': unittest.main()
