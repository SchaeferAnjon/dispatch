# -*- coding: utf-8 -*-
import io
import json
import unittest
import urllib.error
from unittest.mock import patch

import summarize as S


def http_error(code, body):
    return urllib.error.HTTPError("https://x", code, "err", {}, io.BytesIO(json.dumps(body, ensure_ascii=False).encode()))


class Reply:
    def __init__(self, text): self.text = text
    def read(self): return json.dumps({"choices": [{"message": {"content": self.text}}], "usage": {"total_tokens": 7}}).encode()
    def __enter__(self): return self
    def __exit__(self, *a): return False


class FailoverTest(unittest.TestCase):
    def setUp(self):
        # The person retired DeepSeek in settings (the default is an empty list).
        p_ret = patch.object(S, "retired_providers", return_value={"deepseek"}); p_ret.start(); self.addCleanup(p_ret.stop)
        self.env = [{"name": "ZHIPU_API_KEY", "value": "z"}, {"name": "DEEPSEEK_API_KEY", "value": "d"}, {"name": "KIMI_API_KEY", "value": "k"}]
        patcher = patch.object(S.D, "env_read", lambda: self.env); patcher.start(); self.addCleanup(patcher.stop)
        patcher = patch.object(S, "record_use", lambda *a, **k: None); patcher.start(); self.addCleanup(patcher.stop)

    def test_out_of_balance_provider_hands_over_to_the_next_key(self):
        p = {"id": "zhipu", "base": "https://open.bigmodel.cn/api/coding/paas/v4", "model": "glm-5.3-flash", "key": "z"}
        seen = []
        def urlopen(req, timeout=0):
            seen.append(req.full_url)
            if "bigmodel" in req.full_url:
                raise http_error(429, {"error": {"code": "1113", "message": "余额不足或无可用资源包,请充值。"}})
            return Reply("总结好了")
        with patch.object(S.urllib.request, "urlopen", urlopen):
            self.assertEqual(S.chat(p, "sys", "user"), "总结好了")
        self.assertEqual(p["id"], "kimi")  # the caller records who actually wrote it; DeepSeek is retired
        self.assertEqual(len(seen), 2)

    def test_all_keys_out_of_balance_raises_one_named_error(self):
        p = {"id": "zhipu", "base": "https://open.bigmodel.cn/api/paas/v4", "model": "glm-5.3-flash", "key": "z"}
        with patch.object(S.urllib.request, "urlopen", lambda req, timeout=0: (_ for _ in ()).throw(http_error(402, {"error": "insufficient balance"}))):
            with self.assertRaises(S.QuotaExhausted) as cm: S.chat(p, "sys", "user")
        self.assertIn("智谱", str(cm.exception)); self.assertNotIn("DeepSeek", str(cm.exception)); self.assertIn("Kimi", str(cm.exception))
        self.assertEqual(p["id"], "zhipu")

    def test_other_http_errors_are_not_failed_over(self):
        p = {"id": "zhipu", "base": "https://open.bigmodel.cn/api/paas/v4", "model": "glm-5.3-flash", "key": "z"}
        with patch.object(S.urllib.request, "urlopen", lambda req, timeout=0: (_ for _ in ()).throw(http_error(500, {"error": "boom"}))):
            with self.assertRaises(urllib.error.HTTPError): S.chat(p, "sys", "user")


if __name__ == "__main__":
    unittest.main()


class CodingPlanTest(unittest.TestCase):
    def setUp(self):
        p_ret = patch.object(S, "retired_providers", return_value={"deepseek"}); p_ret.start(); self.addCleanup(p_ret.stop)

    def test_zhipu_uses_the_coding_plan_endpoint_and_deepseek_is_never_auto_picked(self):
        self.assertEqual(next(b for _, pid, b, _ in S.PROVIDERS if pid == "zhipu"), "https://open.bigmodel.cn/api/coding/paas/v4")
        env = [{"name": "DEEPSEEK_API_KEY", "value": "d"}, {"name": "KIMI_API_KEY", "value": "k"}]
        with patch.object(S.D, "env_read", lambda: env), patch.object(S.D, "settings_load", lambda: {}):
            self.assertEqual(S.provider()["id"], "kimi")
            self.assertEqual(S.provider("deepseek:deepseek-chat")["id"], "deepseek")  # explicit choice still honoured


class RetiredIsASetting(unittest.TestCase):
    def test_nothing_is_retired_until_the_person_says_so(self):
        with patch.object(S.D, "settings_load", return_value={}):
            self.assertEqual(S.retired_providers(), set())
        with patch.object(S.D, "settings_load", return_value={"retired_providers": "DeepSeek， kimi"}):
            self.assertEqual(S.retired_providers(), {"deepseek", "kimi"})

    def test_automatic_uses_default_to_off(self):
        with patch.object(S.D, "settings_load", return_value={"summary_auto": 0, "summary_uses": {}}):
            for key in ("session", "project", "here", "insights", "memories", "profile_inventory", "semantic"):
                self.assertFalse(S.use_enabled(key), key)
            self.assertTrue(S.use_enabled("discuss"))  # only exists when the person started a discussion
        with patch.object(S.D, "settings_load", return_value={"summary_uses": {"memories": 1}}):
            self.assertTrue(S.use_enabled("memories"))
