import unittest
from types import SimpleNamespace
from unittest.mock import patch

import dispatch as D
import serve


class AgentLaunch(unittest.TestCase):
    def launch(self, prompt_error=False, ready=True, working=False, wait=False):
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
        args = SimpleNamespace(op='start', kind='codex', host=None, cwd='/project', task=None,
            label='', name='launch-test', extra='', model='', auto=False, prompt='read only',
            wait=wait, timeout=600000, lines=80, json=True)
        with patch.object(D, 'herdr', side_effect=herdr), patch.object(D, 'local_host_name', return_value='Apple'), \
             patch.object(D, 'wait_interactive', return_value=(ready, [])), \
             patch.object(D, 'dismiss_startup_dialogs', return_value=[]), \
             patch.object(D, 'read_pane', side_effect=(lambda *a, **kw: '') if wait else AssertionError('non-wait launch must not wait for output')), \
             patch.object(D, 'out', side_effect=lambda result, *unused: result):
            result = D.cmd_agent(args)
        return result, calls

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
