# -*- coding: utf-8 -*-
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import dispatch

WINDOWS_READY = True


class QuotaTimestamp(unittest.TestCase):
    def test_codex_event_time_is_utc_even_during_berlin_summer_time(self):
        with tempfile.TemporaryDirectory() as home:
            sessions = Path(home) / '.codex/sessions'
            sessions.mkdir(parents=True)
            event = {'timestamp': '2026-09-15T00:37:03.500Z', 'payload': {
                'type': 'token_count', 'rate_limits': {'plan_type': 'prolite',
                    'secondary': {'used_percent': 29, 'resets_at': 1789805541}}}}
            (sessions / 'test.jsonl').write_text(json.dumps(event) + '\n')
            previous = os.environ.get('TZ')
            tzset = getattr(time, 'tzset', lambda: None)  # Windows has no tzset: the runner's own zone (UTC) stands in
            try:
                os.environ['TZ'] = 'Europe/Berlin'
                tzset()
                with patch.object(dispatch, 'HOME', home):
                    result = dispatch.quota_of("codex")
                self.assertEqual(result['updated_at'], 1789432623.5)
                self.assertEqual(result['windows'][0]['used_percent'], 29)
            finally:
                if previous is None:
                    os.environ.pop('TZ', None)
                else:
                    os.environ['TZ'] = previous
                tzset()


class QuotaKinds(unittest.TestCase):
    """Dispatch IDE's account panel shows a session row and a weekly row per engine: it reads `kind`,
    never the (Chinese) label."""

    def codex(self, rate_limits):
        with tempfile.TemporaryDirectory() as home:
            sessions = Path(home) / '.codex/sessions'
            sessions.mkdir(parents=True)
            event = {'timestamp': '2026-09-27T20:00:00.000Z', 'payload': {'type': 'token_count', 'rate_limits': rate_limits}}
            (sessions / 'r.jsonl').write_text(json.dumps(event) + '\n')
            with patch.object(dispatch, 'HOME', home):
                return dispatch.quota_of("codex")

    def test_codex_windows_carry_session_and_weekly(self):
        r = self.codex({'plan_type': 'pro', 'primary': {'used_percent': 12, 'window_minutes': 300, 'resets_at': 1},
                        'secondary': {'used_percent': 40, 'window_minutes': 10080, 'resets_at': 2}})
        self.assertEqual([(w['kind'], w['label'], w['used_percent']) for w in r['windows']], [('session', '5h', 12), ('weekly', 'Weekly', 40)])

    def test_codex_without_window_lengths_goes_by_the_slot(self):
        r = self.codex({'primary': {'used_percent': 1}, 'secondary': {'used_percent': 2}})
        self.assertEqual([w['kind'] for w in r['windows']], ['session', 'weekly'])
        # a plan whose only window is weekly, sent in the primary slot
        r = self.codex({'primary': {'used_percent': 3, 'window_minutes': 10080}})
        self.assertEqual([w['kind'] for w in r['windows']], ['weekly'])

    def test_claude_windows_carry_kinds(self):
        usage = {'limits': [{'kind': 'session', 'percent': 5, 'resets_at': '2026-09-28T01:00:00Z'},
                            {'kind': 'weekly_all', 'percent': 20, 'resets_at': '2026-10-01T00:00:00Z'},
                            {'kind': 'weekly_scoped', 'percent': 30, 'scope': {'model': {'display_name': 'Fable'}}}]}
        with patch.object(__import__('engines.claude', fromlist=['x']), 'usage', return_value=(usage, 1.0)):
            r = dispatch.quota_of("claude")
        self.assertEqual([w['kind'] for w in r['windows']], ['session', 'weekly', 'weekly_model'])
