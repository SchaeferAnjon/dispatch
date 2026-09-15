import unittest
from types import SimpleNamespace
from unittest.mock import patch

import dispatch as D
import serve


class AgentLaunch(unittest.TestCase):
    def launch(self, prompt_error=False):
        calls = []
        def herdr(host, args, **kwargs):
            calls.append(args)
            if args[:2] == ['tab', 'create']:
                return {'result': {'root_pane': {'pane_id': 'w1:p2', 'tab_id': 'w1:t2'}}}
            if args[:2] == ['agent', 'prompt'] and prompt_error:
                return {'error': {'message': 'input unavailable'}}
            return {'result': {'agent': {'agent_status': 'working'}}}
        args = SimpleNamespace(op='start', kind='codex', host=None, cwd='/project', task=None,
            label='', name='launch-test', extra='', model='', auto=False, prompt='read only',
            wait=False, timeout=600000, lines=80, json=True)
        with patch.object(D, 'herdr', side_effect=herdr), patch.object(D, 'local_host_name', return_value='Apple'), \
             patch.object(D, 'wait_interactive', return_value=(True, [])), \
             patch.object(D, 'dismiss_startup_dialogs', return_value=[]), \
             patch.object(D, 'read_pane', side_effect=AssertionError('non-wait launch must not wait for output')), \
             patch.object(D, 'out', side_effect=lambda result, *unused: result):
            result = D.cmd_agent(args)
        return result, calls

    def test_launch_returns_after_prompt_delivery_while_agent_still_working(self):
        result, calls = self.launch()
        self.assertTrue(result['prompt_sent'])
        self.assertEqual(result['status'], 'working')
        self.assertEqual(result['output'], '')
        prompt = next(c for c in calls if c[:2] == ['agent', 'prompt'])
        self.assertNotIn('--wait', prompt)

    def test_failed_delivery_does_not_claim_prompt_was_sent(self):
        result, _ = self.launch(prompt_error=True)
        self.assertFalse(result['prompt_sent'])
        self.assertEqual(result['status'], 'stalled')
        self.assertIn('input unavailable', result['warning'])

    def test_web_launch_uses_non_waiting_cli(self):
        with patch.object(serve, 'sh', return_value='{}') as run:
            serve.commands()['agent_start']({'kind': 'codex', 'prompt': 'read only'}, 'user')
            self.assertIn('--no-wait', run.call_args.args[0])
