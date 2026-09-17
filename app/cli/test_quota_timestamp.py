# -*- coding: utf-8 -*-
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import dispatch


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
            try:
                os.environ['TZ'] = 'Europe/Berlin'
                time.tzset()
                with patch.object(dispatch, 'HOME', home):
                    result = dispatch.quota_codex()
                self.assertEqual(result['updated_at'], 1789432623.5)
                self.assertEqual(result['windows'][0]['used_percent'], 29)
            finally:
                if previous is None:
                    os.environ.pop('TZ', None)
                else:
                    os.environ['TZ'] = previous
                time.tzset()
