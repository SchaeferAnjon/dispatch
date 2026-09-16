import unittest
from types import SimpleNamespace
from unittest.mock import patch

import dispatch as D
import serve


class AgentLaunch(unittest.TestCase):
    def launch(self, prompt_error=False, ready=True, working=False, wait=False,
               focus=False, kind='codex', prompt='read only', window='Ghostty'):
        calls = []
        def herdr(host, args, **kwargs):
            calls.append(args)
            if args[:2] == ['tab', 'create']:
                return {'result': {'root_pane': {'pane_id': 'w1:p2', 'tab_id': 'w1:t2'}}}
            if args[:2] == ['agent', 'prompt'] and prompt_error:
                return {'error': {'code': 'agent_prompt_stalled', 'message': 'input unavailable'}}
            if args[:2] == ['agent', 'get']:
                return {'result': {'agent': {'agent_status': 'working' if working else 'idle'}}}
            return {'result': {'agent': {'agent_status': 'working'}}}
        args = SimpleNamespace(op='start', kind=kind, host=None, cwd='/project', task=None,
            label='', name='launch-test', extra='', model='', auto=False, prompt=prompt,
            wait=wait, timeout=600000, lines=80, json=True, focus=focus)
        with patch.object(D, 'herdr', side_effect=herdr), patch.object(D, 'local_host_name', return_value='Apple'), \
             patch.object(D, 'wait_interactive', return_value=(ready, [])), \
             patch.object(D, 'dismiss_startup_dialogs', return_value=[]), \
             patch.object(D.os.path, 'isdir', return_value=True), \
             patch.object(D, 'show_herdr_pane', return_value=(window, 'focused' if window else 'none')) as show, \
             patch.object(D, 'herdr_session_name', return_value='main'), \
             patch.object(D, 'read_pane', side_effect=(lambda *a, **kw: '') if wait else AssertionError('non-wait launch must not wait for output')), \
             patch.object(D, 'out', side_effect=lambda result, *unused: result):
            result = D.cmd_agent(args)
            if focus: show.assert_called_once_with('w1:p2')
            else: show.assert_not_called()
        return result, calls

    def test_project_terminal_opens_selected_agent_without_sending_a_prompt(self):
        for kind in ('claude', 'codex', 'pi', 'gemini', 'opencode', 'hermes'):
            with self.subTest(kind=kind):
                result, calls = self.launch(kind=kind, prompt='', focus=True)
                self.assertEqual((result['kind'], result['cwd'], result['app']), (kind, '/project', 'Ghostty'))
                tab = next(c for c in calls if c[:2] == ['tab', 'create'])
                self.assertEqual(tab[tab.index('--cwd') + 1], '/project')
                start = next(c for c in calls if c[:2] == ['agent', 'start'])
                self.assertEqual(start[start.index('--kind') + 1], kind)
                self.assertFalse(any(c[:2] == ['agent', 'prompt'] for c in calls))
                self.assertNotIn('--', start)  # no additional permission flags

    def test_missing_terminal_window_is_reported_with_attach_hint(self):
        result, _ = self.launch(prompt='', focus=True, window=None)
        self.assertEqual(result['app'], '')
        self.assertIn('herdr --session main', result['hint'])

    def test_focus_on_remote_host_runs_launch_and_window_focus_on_that_host(self):
        args = SimpleNamespace(op='start', kind='codex', host='peer', focus=True,
            cwd='~/Projects/test folder', wait=False, auto=False, json=True)
        with patch.object(D, 'herdr_target_host', return_value={'id': 'peer', 'name': '大哥'}), \
             patch.object(D, 'proxy_to_host') as proxy, patch.object(D, 'herdr') as herdr:
            D.cmd_agent(args)
        argv = proxy.call_args.args[0]
        self.assertEqual(argv[:5], ['--host', 'peer', 'agent', 'start', 'codex'])
        self.assertIn('--cwd=~/Projects/test folder', argv)
        self.assertIn('--focus', argv)
        herdr.assert_not_called()

    def test_missing_project_directory_never_creates_a_tab(self):
        args = SimpleNamespace(op='start', kind='codex', host=None, focus=True, cwd='/missing-project')
        with patch.object(D, 'local_host_name', return_value='Apple'), \
             patch.object(D.os.path, 'isdir', return_value=False), patch.object(D, 'herdr') as herdr:
            with self.assertRaisesRegex(SystemExit, '目录不存在'):
                D.cmd_agent(args)
        herdr.assert_not_called()

    def test_launch_returns_after_prompt_delivery_while_agent_still_working(self):
        result, calls = self.launch()
        self.assertTrue(result['prompt_sent'])
        self.assertEqual(result['status'], 'working')
        self.assertEqual(result['output'], '')
        prompt = next(c for c in calls if c[:2] == ['agent', 'prompt'])
        self.assertIn('--wait', prompt)
        self.assertIn('working', prompt)
        self.assertEqual(prompt[prompt.index('--timeout') + 1], '15000')

    def test_cli_wait_still_waits_for_completion(self):
        _, calls = self.launch(wait=True)
        prompt = next(c for c in calls if c[:2] == ['agent', 'prompt'])
        self.assertIn('--wait', prompt)
        self.assertNotIn('working', prompt)
        self.assertIn('600000', prompt)

    def test_failed_delivery_does_not_claim_prompt_was_sent(self):
        result, calls = self.launch(prompt_error=True)
        self.assertFalse(result['prompt_sent'])
        self.assertEqual(result['status'], 'stalled')
        self.assertIn('input unavailable', result['warning'])
        self.assertEqual(len([c for c in calls if c[:2] == ['agent', 'prompt']]), 1)

    def test_not_ready_never_receives_prompt(self):
        result, calls = self.launch(ready=False)
        self.assertFalse(result['prompt_sent'])
        self.assertFalse(any(c[:2] == ['agent', 'prompt'] for c in calls))

    def test_manual_input_during_startup_is_not_sent_twice(self):
        result, calls = self.launch(working=True)
        self.assertFalse(result['prompt_sent'])
        self.assertIn('避免重复', result['warning'])
        self.assertFalse(any(c[:2] == ['agent', 'prompt'] for c in calls))

    def test_web_launch_uses_non_waiting_cli(self):
        with patch.object(serve, 'sh', return_value='{}') as run:
            serve.commands()['agent_start']({'kind': 'codex', 'prompt': 'read only'}, 'user')
            self.assertIn('--no-wait', run.call_args.args[0])


class InteractiveReady(unittest.TestCase):
    def test_animated_idle_input_is_ready_without_waiting_for_still_screen(self):
        reads = iter(['› Ask Codex   ⠁   ⠂', '› Ask Codex ⠄    ⠈'])
        def herdr(host, args, **kwargs):
            if args[:2] == ['agent', 'get']:
                return {'result': {'agent': {'agent_status': 'idle', 'interactive_ready': True}}}
            self.assertIn('visible', args)
            return next(reads)
        with patch.object(D, 'herdr', side_effect=herdr), patch.object(D.time, 'sleep'):
            self.assertEqual(D.wait_interactive(None, 'p'), (True, []))

    def test_explicit_not_ready_does_not_fall_back_to_idle(self):
        info = {'result': {'agent': {'agent_status': 'idle', 'interactive_ready': False}}}
        with patch.object(D, 'herdr', return_value=info), \
             patch.object(D, 'dismiss_startup_dialogs', return_value=[]), \
             patch.object(D.time, 'monotonic', side_effect=[0, 0, 1, 2, 100]), \
             patch.object(D.time, 'sleep'):
            self.assertEqual(D.wait_interactive(None, 'p'), (False, []))

    def test_readiness_flag_and_legacy_idle_are_supported(self):
        for agent in ({'agent_status': 'unknown', 'interactive_ready': True}, {'agent_status': 'idle'}):
            with self.subTest(agent=agent), \
                 patch.object(D, 'herdr', return_value={'result': {'agent': agent}}), \
                 patch.object(D, 'dismiss_startup_dialogs', return_value=[]), \
                 patch.object(D.time, 'sleep'):
                self.assertEqual(D.wait_interactive(None, 'p'), (True, []))

    def test_working_agent_gets_no_startup_keys(self):
        info = {'result': {'agent': {'agent_status': 'working', 'interactive_ready': True}}}
        with patch.object(D, 'herdr', return_value=info), \
             patch.object(D, 'dismiss_startup_dialogs') as dismiss:
            self.assertEqual(D.wait_interactive(None, 'p'), (False, []))
            dismiss.assert_not_called()
