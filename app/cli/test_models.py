# -*- coding: utf-8 -*-
import unittest

import models as M
from engines import claude as C, codex as X

WINDOWS_READY = True


class Models(unittest.TestCase):
    def test_claude_newest_of_each_family_first_then_older(self):
        rows = [
            {"id": "claude-opus-5", "display_name": "Claude Opus 5", "created_at": "2026-07-24T00:00:00Z"},
            {"id": "claude-haiku-4-5-20251001", "display_name": "Claude Haiku 4.5", "created_at": "2025-10-15T00:00:00Z"},
            {"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "created_at": "2026-09-21T16:24:00Z"},
            {"id": "claude-fable-5-1", "display_name": "Claude Fable 5.1", "created_at": "2026-08-28T00:00:00Z"},
            {"id": "claude-sonnet-5", "display_name": "Claude Sonnet 5", "created_at": "2026-06-29T00:00:00Z"},
        ]
        extra = [{"value": "claude-fable-5-1[1m]", "label": "Fable", "description": "Fable 5.1 · Most capable"}]
        opts = C.model_options(rows, extra)
        self.assertEqual([o["id"] for o in opts], ["", "claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-fable-5-1[1m]", "claude-opus-5"])
        self.assertEqual(opts[2]["label"], "Opus 5.5")
        self.assertEqual(opts[5]["label"], "Fable 5.1 · 1M")
        self.assertFalse(opts[-1]["latest"])

    def test_claude_without_login_falls_back_to_aliases(self):
        self.assertEqual([o["id"] for o in C.model_options(None)], ["", "fable", "opus", "sonnet", "haiku"])

    def test_codex_follows_its_own_cache(self):
        cache = {"models": [
            {"slug": "gpt-5.5", "display_name": "GPT-5.5", "visibility": "list", "priority": 12, "upgrade": {"migration_markdown": "GPT-5.5 retires on October 14, 2026."}},
            {"slug": "gpt-reserve", "display_name": "GPT-Reserve", "visibility": "hide", "priority": 3},
            {"slug": "gpt-6-sol", "display_name": "GPT-6-Sol", "visibility": "list", "priority": 2, "upgrade": None},
        ]}
        opts = X.model_options(cache, "gpt-6-sol")
        self.assertEqual([o["id"] for o in opts], ["", "gpt-6-sol", "gpt-5.5"])
        self.assertEqual(opts[0]["label"], "默认（GPT-6-Sol）")
        self.assertFalse(opts[2]["latest"])
        self.assertIn("retires", opts[2]["note"])
        self.assertEqual(X.model_options(None), [{"id": "", "label": "默认", "default": ""}])


if __name__ == "__main__":
    unittest.main()
