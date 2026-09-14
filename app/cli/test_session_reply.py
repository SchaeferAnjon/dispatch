import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
import uuid
from datetime import datetime, timezone

import session_control
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

    def test_claude_pictures_are_pasted_one_by_one_before_the_words(self):
        """Claude Code turns a pasted image path into an attachment and drops any text pasted with it:
        each picture goes in its own paste, then the words with Enter; the receipt keeps the words."""
        import tempfile
        calls = []
        def herdr(host, args, timeout=30, raw=False):
            calls.append(args)
            if args[:2] == ['tab', 'focus']: return {'result': {}}
            if args[:2] == ['agent', 'prompt']: return {'result': {'agent': {}}}
            return '' if raw else {'result': {}}
        self.d.herdr = herdr
        pics = [tempfile.NamedTemporaryFile(suffix='.png', delete=False).name for _ in range(2)]
        pane = {'pane_id': 'p1', 'tab_id': 't1', 'busy': False}
        with patch.object(reply, 'target', return_value={'kind': 'herdr', 'pane': pane, 'label': 'x'}), patch.object(reply, 'herdr_target', return_value=pane), patch.object(reply.time, 'sleep'):
            r = reply.submit(self.d, self.ref, '看看颜色', str(uuid.uuid4()), images=pics)
        self.assertEqual((r['state'], r['text']), ('accepted', '看看颜色'))
        self.assertEqual([a for a in calls if a[0] == 'pane'], [['pane', 'send-text', 'p1', pics[0]], ['pane', 'send-text', 'p1', pics[1]]])
        self.assertEqual([a for a in calls if a[:2] == ['agent', 'prompt']], [['agent', 'prompt', 'p1', ' 看看颜色']])

    def test_other_agents_get_picture_paths_in_the_text(self):
        import tempfile
        calls = []
        self.d.herdr = lambda host, args, timeout=30, raw=False: (calls.append(args) or ({'result': {'agent': {}}} if args[:2] == ['agent', 'prompt'] else {'result': {}}))
        pic = tempfile.NamedTemporaryFile(suffix='.jpg', delete=False).name
        pane = {'pane_id': 'p1', 'tab_id': 't1', 'busy': False}
        ref = dict(self.ref, agent='codex')
        with patch.object(reply, 'target', return_value={'kind': 'herdr', 'pane': pane, 'label': 'x'}), patch.object(reply, 'herdr_target', return_value=pane):
            r = reply.submit(self.d, ref, '', str(uuid.uuid4()), images=[pic])
        self.assertEqual(r['text'], f'看一下这几张图 附图（用 Read 看）：{pic}')
        self.assertEqual([a for a in calls if a[:2] == ['agent', 'prompt']], [['agent', 'prompt', 'p1', f'看一下这几张图 附图（用 Read 看）：{pic}']])
        self.assertEqual(reply.plain_text(f'[Image: source: {pic}]\n看一下这几张图 附图（用 Read 看）：{pic}'), '看一下这几张图')

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


class AdoptFromReply(unittest.TestCase):
    """A session running on this machine outside Herdr (plain Ghostty/VS Code terminal, no
    Herdr pane) has no `target`. status() should say so and offer adoption; submit() should
    adopt it itself when idle, and never touch it while it is working."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = SimpleNamespace(HOME=self.tmp.name, DISPATCH_DIR=self.tmp.name, SESS_DIR=self.tmp.name)
        self.ref = dict(agent='claude-code', session_id='session-exact', cwd='/project')
        self.not_found = reply.Rejected('无法确认原会话所在的终端。请在电脑上恢复原会话后重新连接。')

    def test_status_offers_adoption_for_an_idle_session_outside_herdr(self):
        self.d.live_sessions = lambda local_only=True: [dict(self.ref, agent='claude-code', state='idle', source_app='Ghostty', herdr=None)]
        with patch.object(reply, 'target', side_effect=self.not_found):
            st = reply.status(self.d, self.ref)
        self.assertFalse(st['available'])
        self.assertTrue(st['adoptable'])
        self.assertEqual(st['adopt_state'], 'idle')
        self.assertEqual(st['source_app'], 'Ghostty')
        self.assertIn('Ghostty', st['label'])

    def test_status_offers_adoption_for_a_working_session_but_says_so(self):
        self.d.live_sessions = lambda local_only=True: [dict(self.ref, agent='claude-code', state='working', source_app='VS Code', herdr=None)]
        with patch.object(reply, 'target', side_effect=self.not_found):
            st = reply.status(self.d, self.ref)
        self.assertTrue(st['adoptable'])
        self.assertEqual(st['adopt_state'], 'working')

    def test_status_stays_generic_when_the_session_is_not_live_here(self):
        self.d.live_sessions = lambda local_only=True: []
        with patch.object(reply, 'target', side_effect=self.not_found):
            st = reply.status(self.d, self.ref)
        self.assertFalse(st['available'])
        self.assertNotIn('adoptable', st)

    def test_status_skips_a_session_already_in_herdr(self):
        # herdr_target would have found it; something else is wrong — don't offer to re-adopt it.
        self.d.live_sessions = lambda local_only=True: [dict(self.ref, agent='claude-code', state='idle', source_app='Herdr', herdr={'pane_id': 'p1'})]
        with patch.object(reply, 'target', side_effect=self.not_found):
            st = reply.status(self.d, self.ref)
        self.assertNotIn('adoptable', st)

    def test_submit_auto_adopts_an_idle_session_then_sends(self):
        live = dict(self.ref, agent='claude-code', state='idle', source_app='Ghostty', herdr=None)
        self.d.live_sessions = lambda local_only=True: [live]
        self.d.refresh_index = lambda: None
        pane = {'pane_id': 'p1', 'tab_id': 't1', 'busy': False}
        calls = []
        def herdr(host, args, timeout=30, raw=False):
            calls.append(args)
            if args[:2] == ['agent', 'prompt']: return {'result': {'agent': {}}}
            return '' if raw else {'result': {}}
        self.d.herdr = herdr
        with patch.object(reply, 'target', side_effect=[self.not_found, {'kind': 'herdr', 'pane': pane, 'label': 'x'}]), \
             patch.object(reply, 'herdr_target', return_value=pane), \
             patch.object(session_control, 'adopt', return_value={'request_id': 'launch-1', 'state': 'starting'}) as m_adopt, \
             patch.object(session_control, 'status', return_value={'request_id': 'launch-1', 'state': 'ready'}), \
             patch.object(reply.time, 'sleep'):
            r = reply.submit(self.d, self.ref, 'hello', str(uuid.uuid4()))
        self.assertEqual(r['state'], 'accepted')
        m_adopt.assert_called_once()
        self.assertEqual(m_adopt.call_args.args[1]['session_id'], 'session-exact')
        self.assertTrue(any(a[:2] == ['agent', 'prompt'] for a in calls))

    def test_submit_gives_up_when_adoption_does_not_finish(self):
        live = dict(self.ref, agent='claude-code', state='idle', source_app='Ghostty', herdr=None)
        self.d.live_sessions = lambda local_only=True: [live]
        self.d.refresh_index = lambda: None
        with patch.object(reply, 'target', side_effect=self.not_found), \
             patch.object(session_control, 'adopt', return_value={'request_id': 'launch-1', 'state': 'starting'}), \
             patch.object(session_control, 'status', return_value={'request_id': 'launch-1', 'state': 'attention', 'message': '启动尚未确认，请查看电脑终端。'}), \
             patch.object(reply.time, 'sleep'):
            with self.assertRaises(reply.Rejected) as cm:
                reply.submit(self.d, self.ref, 'hello', str(uuid.uuid4()))
        self.assertIn('查看电脑终端', str(cm.exception))

    def test_submit_never_interrupts_a_working_session_to_adopt_it(self):
        live = dict(self.ref, agent='claude-code', state='working', source_app='VS Code', herdr=None)
        self.d.live_sessions = lambda local_only=True: [live]
        with patch.object(reply, 'target', side_effect=self.not_found), patch.object(session_control, 'adopt') as m_adopt:
            with self.assertRaises(reply.Rejected) as cm:
                reply.submit(self.d, self.ref, 'hello', str(uuid.uuid4()))
        self.assertIn('VS Code', str(cm.exception))
        m_adopt.assert_not_called()
        with reply.connect(self.d) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM replies').fetchone()[0], 0)


if __name__ == '__main__': unittest.main()
