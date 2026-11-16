# -*- coding: utf-8 -*-
"""Point and talk's Soniox calls against a fake Soniox on 127.0.0.1: the temporary key, the async transcription (upload,
create, poll, read, delete), what a refused key says, the language hints. Nothing goes to the network."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(__file__))
import point_talk as PT


class FakeSoniox(BaseHTTPRequestHandler):
    calls = []
    status_of_key = 201
    polls = 0

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def do_POST(self):
        body = self._body()
        FakeSoniox.calls.append(("POST", self.path, self.headers.get("Authorization"), body[:200]))
        if self.headers.get("Authorization") != "Bearer test-key":
            return self._send(401, {"message": "Invalid API key"})
        if self.path == "/v1/auth/temporary-api-key":
            return self._send(FakeSoniox.status_of_key, {"api_key": "temp:abc", "expires_at": "2026-11-16T00:00:00Z"}
                              if FakeSoniox.status_of_key < 400 else {"message": "no permission"})
        if self.path == "/v1/files":
            return self._send(201, {"id": "file-1"})
        if self.path == "/v1/transcriptions":
            return self._send(201, {"id": "tr-1", "status": "queued"})
        self._send(404, {})

    def do_GET(self):
        FakeSoniox.calls.append(("GET", self.path, self.headers.get("Authorization"), b""))
        if self.path == "/v1/transcriptions/tr-1":
            FakeSoniox.polls += 1
            return self._send(200, {"status": "completed" if FakeSoniox.polls > 1 else "processing"})
        if self.path == "/v1/transcriptions/tr-1/transcript":
            return self._send(200, {"tokens": [
                {"text": "运费", "start_ms": 100, "end_ms": 300, "language": "zh"},
                {"text": "fee", "translation_status": "translation"},
                {"text": "。", "start_ms": 900, "end_ms": 960, "language": "zh"}]})
        self._send(404, {})

    def do_DELETE(self):
        FakeSoniox.calls.append(("DELETE", self.path, self.headers.get("Authorization"), b""))
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()


class Calls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeSoniox)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        FakeSoniox.calls = []
        FakeSoniox.polls = 0
        FakeSoniox.status_of_key = 201
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_temporary_key_is_single_use_and_short_lived(self):
        got = PT.Soniox("test-key", base=self.base).temporary_key()
        self.assertEqual(got["api_key"], "temp:abc")
        method, path, auth, body = FakeSoniox.calls[0]
        self.assertEqual((method, path, auth), ("POST", "/v1/auth/temporary-api-key", "Bearer test-key"))
        sent = json.loads(body)
        self.assertEqual(sent["usage_type"], "transcribe_websocket")
        self.assertTrue(sent["single_use"])
        self.assertLessEqual(sent["expires_in_seconds"], 60)

    def test_a_key_without_the_permission_says_so(self):
        FakeSoniox.status_of_key = 403
        with self.assertRaises(PT.TalkError) as e:
            PT.Soniox("test-key", base=self.base).temporary_key()
        self.assertEqual(e.exception.code, "forbidden")
        self.assertIn("not allowed", str(e.exception))

    def test_a_wrong_key_is_named_not_shown(self):
        with self.assertRaises(PT.TalkError) as e:
            PT.Soniox("wrong-key", base=self.base).temporary_key()
        self.assertEqual(e.exception.code, "bad_key")
        self.assertNotIn("wrong-key", str(e.exception))

    def test_no_key_at_all(self):
        with self.assertRaises(PT.TalkError) as e:
            PT.Soniox("", base=self.base)
        self.assertEqual(e.exception.code, "no_key")
        self.assertIn("Settings", str(e.exception))

    def test_a_whole_recording_goes_up_and_both_copies_are_deleted(self):
        path = os.path.join(self.tmp.name, "audio.webm")
        with open(path, "wb") as f:
            f.write(b"\x1aE\xdf\xa3" + b"0" * 64)
        tokens = PT.keep_tokens(PT.Soniox("test-key", base=self.base).transcribe(path, ["zh", "en"]))
        self.assertEqual(tokens, [{"text": "运费", "start_ms": 100, "end_ms": 300, "language": "zh"},
                                  {"text": "。", "start_ms": 900, "end_ms": 960, "language": "zh"}])
        paths = [(m, p) for m, p, _a, _b in FakeSoniox.calls]
        self.assertIn(("POST", "/v1/files"), paths)
        created = next(b for m, p, _a, b in FakeSoniox.calls if p == "/v1/transcriptions")
        self.assertEqual(json.loads(created)["model"], PT.ASYNC_MODEL)
        self.assertEqual(json.loads(created)["language_hints"], ["zh", "en"])
        self.assertIn(("DELETE", "/v1/transcriptions/tr-1"), paths)
        self.assertIn(("DELETE", "/v1/files/file-1"), paths)


class Languages(unittest.TestCase):
    def test_macos_languages_become_two_letter_hints(self):
        real = subprocess.run
        subprocess.run = lambda *a, **k: subprocess.CompletedProcess(a, 0, '(\n    "en-CN",\n    "zh-Hans-CN",\n    "de-DE",\n    "en-US"\n)\n', "")
        try:
            self.assertEqual(PT.languages(), ["en", "zh", "de"])
        finally:
            subprocess.run = real

    def test_nothing_readable_is_english(self):
        real = subprocess.run
        subprocess.run = lambda *a, **k: subprocess.CompletedProcess(a, 1, "", "no such key")
        try:
            self.assertEqual(PT.languages(), ["en"])
        finally:
            subprocess.run = real


if __name__ == "__main__":
    unittest.main()
