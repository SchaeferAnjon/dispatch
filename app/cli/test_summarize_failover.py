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
        self.env = [{"name": "ZHIPU_API_KEY", "value": "z"}, {"name": "DEEPSEEK_API_KEY", "value": "d"}, {"name": "KIMI_API_KEY", "value": "k"}]
        patcher = patch.object(S.D, "env_read", lambda: self.env); patcher.start(); self.addCleanup(patcher.stop)
        patcher = patch.object(S, "record_use", lambda *a, **k: None); patcher.start(); self.addCleanup(patcher.stop)

    def test_out_of_balance_provider_hands_over_to_the_next_key(self):
        p = {"id": "zhipu", "base": "https://open.bigmodel.cn/api/paas/v4", "model": "glm-5.3-flash", "key": "z"}
        seen = []
        def urlopen(req, timeout=0):
            seen.append(req.full_url)
            if "bigmodel" in req.full_url:
                raise http_error(429, {"error": {"code": "1113", "message": "余额不足或无可用资源包,请充值。"}})
            return Reply("总结好了")
        with patch.object(S.urllib.request, "urlopen", urlopen):
            self.assertEqual(S.chat(p, "sys", "user"), "总结好了")
        self.assertEqual(p["id"], "deepseek")  # the caller records who actually wrote it
        self.assertEqual(len(seen), 2)

    def test_all_keys_out_of_balance_raises_one_named_error(self):
        p = {"id": "zhipu", "base": "https://open.bigmodel.cn/api/paas/v4", "model": "glm-5.3-flash", "key": "z"}
        with patch.object(S.urllib.request, "urlopen", lambda req, timeout=0: (_ for _ in ()).throw(http_error(402, {"error": "insufficient balance"}))):
            with self.assertRaises(S.QuotaExhausted) as cm: S.chat(p, "sys", "user")
        self.assertIn("智谱", str(cm.exception)); self.assertIn("DeepSeek", str(cm.exception)); self.assertIn("Kimi", str(cm.exception))
        self.assertEqual(p["id"], "zhipu")

    def test_other_http_errors_are_not_failed_over(self):
        p = {"id": "zhipu", "base": "https://open.bigmodel.cn/api/paas/v4", "model": "glm-5.3-flash", "key": "z"}
        with patch.object(S.urllib.request, "urlopen", lambda req, timeout=0: (_ for _ in ()).throw(http_error(500, {"error": "boom"}))):
            with self.assertRaises(urllib.error.HTTPError): S.chat(p, "sys", "user")


if __name__ == "__main__":
    unittest.main()
