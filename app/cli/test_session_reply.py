import json
import os
import subprocess
import sys
import tempfile
import time
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

    def codex_pane(self, state='working'):
        self.ref['agent'] = 'codex'
        ipc_dir = os.path.join(self.tmp.name, '.codex', 'ipc')
        os.makedirs(ipc_dir, exist_ok=True)
        open(os.path.join(ipc_dir, 'ipc.sock'), 'w').close()
        pane = dict(agent='codex', pane_id='right', tab_id='tab-right', agent_status=state,
                    agent_session={'value': self.ref['session_id']})
        self.d.herdr_agents = lambda: [pane]
        self.d.herdr = Mock(return_value={'result': {}})
        return pane

    def test_working_codex_with_desktop_open_can_queue_into_exact_herdr_pane(self):
        self.codex_pane()
        with open(os.path.join(self.tmp.name, 'session.json'), 'w') as f:
            json.dump(dict(self.ref, agent_pid=42, state='working'), f)
        with patch.object(reply, 'DesktopIPC') as ipc:
            state = reply.status(self.d, self.ref)
            self.assertTrue(state['available'])
            self.assertTrue(state['working'])
            sent = reply.submit(self.d, self.ref, '继续', str(uuid.uuid4()))
            self.assertEqual(sent['state'], 'accepted')
            self.assertIn('已排队', sent['note'])
            ipc.assert_not_called()
        prompts = [call.args[1] for call in self.d.herdr.call_args_list if call.args[1][:2] == ['agent', 'prompt']]
        self.assertEqual(prompts, [['agent', 'prompt', 'right', '继续']])

    def test_live_herdr_identity_works_without_hooks_and_overrides_stale_pid(self):
        self.codex_pane()
        self.assertEqual(reply.target(self.d, self.ref)['pane']['pane_id'], 'right')
        for name, sid, ts in [('old', self.ref['session_id'], 1), ('new', 'another-session', 2)]:
            with open(os.path.join(self.tmp.name, name+'.json'), 'w') as f:
                json.dump(dict(self.ref, session_id=sid, agent_pid=42, last_at=ts), f)
        self.assertEqual(reply.target(self.d, self.ref)['pane']['pane_id'], 'right')

    def test_explicit_other_conversation_cannot_be_selected_by_pid(self):
        pane = self.codex_pane('idle')
        pane['agent_session']['value'] = 'another-session'
        with open(os.path.join(self.tmp.name, 'session.json'), 'w') as f:
            json.dump(dict(self.ref, agent_pid=42), f)
        self.d.herdr.return_value = {'result': {'process_info': {'foreground_processes': [{'pid': 42}]}}}
        with self.assertRaises(reply.Rejected): reply.herdr_target(self.d, self.ref)

    def test_blocked_herdr_is_not_rerouted_to_desktop_or_adoption(self):
        self.codex_pane('blocked')
        self.d.live_sessions = lambda **kw: [dict(self.ref, herdr={'pane_id': 'right'}),
            dict(self.ref, session_id='pid-99', probable_session_id=self.ref['session_id'], source_app='ChatGPT')]
        with patch.object(reply, 'DesktopIPC') as ipc:
            state = reply.status(self.d, self.ref)
            self.assertFalse(state['available'])
            self.assertIn('Herdr 等待确认', state['label'])
            self.assertNotIn('adoptable', state)
            with self.assertRaises(reply.Rejected): reply.submit(self.d, self.ref, '继续', str(uuid.uuid4()))
            ipc.assert_not_called()

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

    def test_registered_identity_wins_over_an_earlier_guessed_helper(self):
        known = dict(self.ref, state='working', source_app='Ghostty')
        self.d.live_sessions = lambda **kw: [dict(self.ref, session_id='pid-99', probable_session_id=self.ref['session_id'], source_app='ChatGPT'), known]
        self.assertIs(reply.adoptable(self.d, self.ref), known)
        known['herdr'] = {'pane_id': 'right'}
        self.assertIsNone(reply.adoptable(self.d, self.ref))

    def test_submit_never_auto_adopts_even_when_idle_and_adoptable(self):
        """The session prefers to stay where it is (Ghostty, VS Code, …): submit() must never
        take it into Herdr as a side effect of sending, even when it's idle and adoption would
        succeed. Only the explicit "接进 Herdr 再发" button (session_control.adopt, called
        straight from the UI) may do that."""
        live = dict(self.ref, agent='claude-code', state='idle', source_app='Ghostty', herdr=None)
        self.d.live_sessions = lambda local_only=True: [live]
        with patch.object(reply, 'target', side_effect=self.not_found), patch.object(session_control, 'adopt') as m_adopt:
            with self.assertRaises(reply.Rejected) as cm:
                reply.submit(self.d, self.ref, 'hello', str(uuid.uuid4()))
        self.assertIn('无法确认原会话所在的终端', str(cm.exception))
        m_adopt.assert_not_called()
        with reply.connect(self.d) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM replies').fetchone()[0], 0)

    def test_submit_never_interrupts_a_working_session_to_adopt_it(self):
        live = dict(self.ref, agent='claude-code', state='working', source_app='VS Code', herdr=None)
        self.d.live_sessions = lambda local_only=True: [live]
        with patch.object(reply, 'target', side_effect=self.not_found), patch.object(session_control, 'adopt') as m_adopt:
            with self.assertRaises(reply.Rejected):
                reply.submit(self.d, self.ref, 'hello', str(uuid.uuid4()))
        m_adopt.assert_not_called()
        with reply.connect(self.d) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM replies').fetchone()[0], 0)


class GhosttyReply(unittest.TestCase):
    """Delivery into a plain Ghostty window: no Herdr pane, matched by tty (never cwd — several
    sessions routinely share a working directory) via a one-off OSC 2 title marker."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = SimpleNamespace(HOME=self.tmp.name, DISPATCH_DIR=self.tmp.name, SESS_DIR=self.tmp.name, herdr_agents=lambda: [])
        self.ref = dict(agent='claude-code', session_id='session-exact', cwd='/project')
        with open(os.path.join(self.tmp.name, 'session.json'), 'w') as f:
            json.dump(dict(self.ref, agent_pid=500, last_at=2, state='idle'), f)
        # A process tree shaped like the real one: the agent sits on a *nested* pty of its own
        # (500, ttys010 — Claude Code's CLI re-execs itself through its updater wrapper), climbing
        # through the wrapper and the shell to `login`, whose tty (ttys007) is the one Ghostty
        # itself owns and actually renders.
        self.table = {
            500: (400, 'ttys010', '/Users/x/.local/share/claude/versions/1.2.3'),
            400: (300, '??', '/Users/x/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude'),
            300: (200, 'ttys007', '/usr/bin/login'),
            200: (1, '??', '/Applications/Ghostty.app/Contents/MacOS/ghostty'),
        }
        self.written = []

    def _write_title(self, tty, text):
        self.written.append((tty, text))

    def test_matches_by_tty_marker_not_cwd(self):
        """Two terminals share the session's cwd — cwd alone would be ambiguous — but only the
        one whose pty actually shows the marker gets picked, and the marker lands on the outer
        tty (Ghostty's own), not the agent's nested one."""
        def terminals():
            marker = self.written[-1][1] if self.written else ''
            return [{'id': 'OTHER', 'name': '', 'cwd': '/project'}, {'id': 'MINE', 'name': marker, 'cwd': '/project'}]
        with patch.object(reply, '_ps_table_tty', return_value=self.table), \
             patch.object(reply, '_write_tty_title', side_effect=self._write_title), \
             patch.object(reply, '_ghostty_terminals', side_effect=terminals):
            t = reply.ghostty_target(self.d, self.ref)
        self.assertEqual(t['kind'], 'ghostty')
        self.assertEqual(t['terminal_id'], 'MINE')
        self.assertEqual(self.written[0][0], 'ttys007')

    def test_ambiguous_terminal_refuses_rather_than_guess(self):
        def terminals():
            marker = self.written[-1][1] if self.written else ''
            return [{'id': 'A', 'name': marker, 'cwd': '/project'}, {'id': 'B', 'name': marker, 'cwd': '/project'}]
        with patch.object(reply, '_ps_table_tty', return_value=self.table), \
             patch.object(reply, '_write_tty_title', side_effect=self._write_title), \
             patch.object(reply, '_ghostty_terminals', side_effect=terminals):
            with self.assertRaises(reply.Rejected) as cm:
                reply.ghostty_target(self.d, self.ref)
        self.assertIn('没能唯一定位', str(cm.exception))

    def test_not_ghostty_falls_through_quietly(self):
        """A pid whose ancestry never reaches a Ghostty.app process isn't a Ghostty failure at
        all — ghostty_target() returns None so target() falls back to the plain Herdr message."""
        table = {500: (1, 'ttys099', '/usr/bin/something')}
        with patch.object(reply, '_ps_table_tty', return_value=table):
            self.assertIsNone(reply.ghostty_target(self.d, self.ref))
        with patch.object(reply, '_ps_table_tty', return_value=table):
            with self.assertRaises(reply.Rejected) as cm:
                reply.target(self.d, self.ref)
        self.assertIn('无法确认原会话所在的终端', str(cm.exception))

    def test_submit_pastes_images_then_text_then_enter(self):
        pics = [tempfile.NamedTemporaryFile(suffix='.png', delete=False).name for _ in range(2)]
        scripts = []
        def terminals():
            marker = self.written[-1][1] if self.written else ''
            return [{'id': 'MINE', 'name': marker, 'cwd': '/project'}]
        def osascript_file(body, timeout=8):
            scripts.append(body)
            return ''
        with patch.object(reply, '_ps_table_tty', return_value=self.table), \
             patch.object(reply, '_write_tty_title', side_effect=self._write_title), \
             patch.object(reply, '_ghostty_terminals', side_effect=terminals), \
             patch.object(reply, '_ghostty_terminal_exists', return_value=True), \
             patch.object(reply, '_osascript_file', side_effect=osascript_file), \
             patch.object(reply.time, 'sleep'):
            r = reply.submit(self.d, self.ref, '看看颜色', str(uuid.uuid4()), images=pics)
        self.assertEqual((r['state'], r['text']), ('accepted', '看看颜色'))
        send_script = scripts[-1]
        self.assertLess(send_script.index(pics[0]), send_script.index(pics[1]))
        self.assertLess(send_script.index(pics[1]), send_script.index('看看颜色'))
        self.assertLess(send_script.rindex('input text'), send_script.rindex('send key "enter"'))
        self.assertTrue(send_script.strip().endswith('end tell'))

    def test_submit_interrupt_sends_escape_before_pasting(self):
        with open(os.path.join(self.tmp.name, 'session.json'), 'w') as f:
            json.dump(dict(self.ref, agent_pid=500, last_at=2, state='working'), f)
        scripts = []
        def terminals():
            marker = self.written[-1][1] if self.written else ''
            return [{'id': 'MINE', 'name': marker, 'cwd': '/project'}]
        def osascript_file(body, timeout=8):
            scripts.append(body)
            return ''
        with patch.object(reply, '_ps_table_tty', return_value=self.table), \
             patch.object(reply, '_write_tty_title', side_effect=self._write_title), \
             patch.object(reply, '_ghostty_terminals', side_effect=terminals), \
             patch.object(reply, '_ghostty_terminal_exists', return_value=True), \
             patch.object(reply, '_osascript_file', side_effect=osascript_file), \
             patch.object(reply.time, 'sleep'):
            r = reply.submit(self.d, self.ref, '停一下', str(uuid.uuid4()), mode='interrupt')
        self.assertEqual(r['state'], 'accepted')
        self.assertIn('已打断并送达', r['note'])
        send_script = scripts[-1]
        self.assertLess(send_script.index('escape'), send_script.index('停一下'))

    def test_status_reports_permission_denied_clearly(self):
        with patch.object(reply, '_ps_table_tty', return_value=self.table), \
             patch.object(reply, '_ghostty_tty', return_value='ttys007'), \
             patch.object(reply, '_ghostty_terminal_id', side_effect=reply.Rejected(
                 '这台电脑还没给 Ghostty 自动化权限：系统设置 → 隐私与安全性 → 自动化，找到运行 dispatch 的程序（通常显示为 osascript）并勾选允许它控制 Ghostty，授权后重试。')):
            st = reply.status(self.d, self.ref)
        self.assertFalse(st['available'])
        self.assertIn('系统设置', st['label'])
        self.assertIn('自动化', st['label'])

    def test_status_available_reports_terminal_field(self):
        def terminals():
            marker = self.written[-1][1] if self.written else ''
            return [{'id': 'MINE', 'name': marker, 'cwd': '/project'}]
        with patch.object(reply, '_ps_table_tty', return_value=self.table), \
             patch.object(reply, '_write_tty_title', side_effect=self._write_title), \
             patch.object(reply, '_ghostty_terminals', side_effect=terminals):
            st = reply.status(self.d, self.ref)
        self.assertTrue(st['available'])
        self.assertEqual(st['terminal'], 'ghostty')
        self.assertIn('Ghostty', st['label'])


def _ghostty_probe_available():
    """True only when this machine can actually drive Ghostty via osascript right now (macOS,
    Ghostty installed, Apple Events already authorized) — this integration test runs only
    opportunistically on a real dev box, never in CI."""
    if sys.platform != 'darwin' or not os.path.isdir('/Applications/Ghostty.app'):
        return False
    try:
        r = subprocess.run(['osascript', '-e', 'tell application "Ghostty" to count windows'], capture_output=True, text=True, timeout=5)
        return r.returncode == 0
    except Exception:
        return False


@unittest.skipUnless(_ghostty_probe_available(), '需要本机装了 Ghostty 且已授权自动化，跳过（CI 里没有）')
class GhosttyLiveIntegration(unittest.TestCase):
    """Drives the real osascript path — never faked — against a scratch Ghostty window this test
    opens and closes itself, never the user's own terminals. This exists specifically to catch
    what the faked GhosttyReply tests structurally cannot: `tab`/`linefeed` written inside a
    `tell application "Ghostty"` block resolve to Ghostty's own terminology (its `tab` class),
    not the whitespace constants — the fakes return already-parsed dicts, so they never exercise
    real AppleScript output at all. Only a real osascript round trip catches that."""

    PROBE = '#!/bin/bash\nLOG=%s\n: > "$LOG"\nwhile IFS= read -r line; do echo "$line" >> "$LOG"; done\n'

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        script_path = os.path.join(self.tmp.name, 'probe.sh')
        with open(script_path, 'w') as f:
            f.write(self.PROBE % json.dumps(os.path.join(self.tmp.name, 'stdin.log')))
        os.chmod(script_path, 0o755)
        self.script_path = script_path
        open_script = (
            'tell application "Ghostty"\n'
            'set cfg to {command:%s, initial working directory:"/tmp"}\n'
            'set w to new window with configuration cfg\n'
            'delay 0.8\n'
            'set t to focused terminal of (selected tab of w)\n'
            'return (id of w) & "|" & (id of t)\n'
            'end tell\n'
        ) % reply._as_lit('/bin/bash ' + script_path)
        out = subprocess.run(['osascript', '-e', open_script], capture_output=True, text=True, timeout=10)
        if out.returncode != 0 or '|' not in out.stdout:
            self.skipTest('没能开出 scratch Ghostty 窗口：%s' % (out.stderr or out.stdout).strip())
        self.window_id, self.terminal_id = out.stdout.strip().split('|', 1)
        self.addCleanup(self._close_window)
        # The scratch shell's own tty (a direct child of Ghostty's `login`), matched by its
        # command line naming our own throwaway script path — never an existing shell of the
        # user's, and unique enough that nothing else on the box could match it.
        self.tty = None
        for _ in range(20):
            r = subprocess.run(['ps', '-axo', 'pid=,tty=,command='], capture_output=True, text=True, timeout=3)
            for line in r.stdout.splitlines():
                if script_path in line:
                    parts = line.strip().split(None, 2)
                    if len(parts) == 3 and parts[1] != '??':
                        self.tty = parts[1]
                        break
            if self.tty:
                break
            time.sleep(0.2)
        if not self.tty:
            self.skipTest('没能找到 scratch 窗口的 tty')

    def _close_window(self):
        try:
            subprocess.run(['pkill', '-9', '-f', self.script_path], capture_output=True, timeout=3)
        except Exception:
            pass
        try:
            subprocess.run(['osascript', '-e', 'tell application "Ghostty"\nset w to window id %s\nclose window w\nend tell' % reply._as_lit(self.window_id)], capture_output=True, timeout=5)
        except Exception:
            pass

    def test_real_ghostty_terminals_parses_id_name_cwd(self):
        rows = reply._ghostty_terminals()
        mine = [r for r in rows if r['id'] == self.terminal_id]
        self.assertEqual(len(mine), 1, 'real Ghostty output did not parse into exactly one row for the scratch terminal')
        # Ghostty doesn't populate `working directory` for a surface launched with a custom
        # `command:` override (unlike a plain shell) — that's a real quirk, not something this
        # fix touches, and matching never relies on cwd anyway; just confirm the field parsed
        # into a plain string rather than swallowing the rest of the row.
        self.assertIsInstance(mine[0]['cwd'], str)

    def test_real_marker_resolves_and_restores_title(self):
        d = SimpleNamespace(DISPATCH_DIR=self.tmp.name)
        before = next(t['name'] for t in reply._ghostty_terminals() if t['id'] == self.terminal_id)
        found = reply._ghostty_terminal_id(d, self.tty)
        self.assertEqual(found, self.terminal_id)
        after = next(t['name'] for t in reply._ghostty_terminals() if t['id'] == self.terminal_id)
        self.assertEqual(after, before)


if __name__ == '__main__': unittest.main()
