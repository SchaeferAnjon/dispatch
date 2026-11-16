# -*- coding: utf-8 -*-
"""`dispatch point-talk`: Point and talk's speech recognition (Soniox), for the Agents window's camera button
(Dispatch IDE contrib/dispatchPointTalk, through dispatch-bridge's `dispatch.pointTalk`, app/ide-ext/src/pointTalk.ts).

  status [--json]                 is a Soniox key in Dispatch's key store (`dispatch env`, SONIOX_API_KEY)
  key [--json]                    a temporary key for one real-time WebSocket (the words while you talk): made with
                                  your key, single use, a minute to connect, an hour at most; your own key never
                                  leaves this process
  transcribe FILE [--json]        the whole recording through the async API (when the live words broke off), tokens
                                  with their times

The key is read from Dispatch's own store (~/.config/dispatch/env, the same file `dispatch env` keeps), never printed and
never put on a command line. The words go to Soniox (soniox.com); nothing else does. Models: stt-rt-v6 and stt-async-v6
(v5 is retired on 2026-12-15, docs.soniox.com/stt/models read 2026-11-16).

The async call is Blurt's (github.com/AGIHunt/blurt, MIT, see NOTICE; skills/blurt/scripts/transcribe.py, class Soniox): upload,
create, poll, read, delete, over one kept-alive connection (a new TLS connection costs ~0.3 s from Europe).
"""
import sys

sys.dont_write_bytecode = True

import argparse
import http.client
import json
import os
import subprocess
import threading
import time
import urllib.parse
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

KEY_NAME = "SONIOX_API_KEY"
API = "https://api.soniox.com"
RT_MODEL = "stt-rt-v6"
ASYNC_MODEL = "stt-async-v6"
# a temporary key only has to open the socket: a minute to connect, once; the socket itself may run an hour
TEMP_KEY_SECONDS = 60
SESSION_SECONDS = 3600
TIMEOUT = 30
UPLOAD_LIMIT = 200 * 1024 * 1024


class TalkError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def soniox_key():
    """The key from Dispatch's store; the process environment only when the store has none (tests, a terminal)."""
    import dispatch as D
    for item in D.env_read():
        if item["name"] == KEY_NAME and item["value"].strip():
            return item["value"].strip()
    return os.environ.get(KEY_NAME, "").strip()


def languages():
    """Two-letter language hints from macOS's preferred languages (zh-Hans-CN → zh), at most four, in order."""
    try:
        r = subprocess.run(["defaults", "read", "-g", "AppleLanguages"], capture_output=True, text=True, timeout=5)
        raw = r.stdout if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        raw = ""
    out = []
    for part in raw.replace("(", " ").replace(")", " ").replace(",", " ").split():
        code = part.strip().strip('"').split("-")[0].lower()
        if len(code) == 2 and code.isalpha() and code not in out:
            out.append(code)
    return out[:4] or ["en"]


class Soniox:
    """One kept-alive HTTPS connection to Soniox's REST API."""

    def __init__(self, key, base=None):
        if not key:
            raise TalkError("no_key", "No Soniox key: add SONIOX_API_KEY in Settings › Keys.")
        self.base = urllib.parse.urlsplit(base or API)
        self.auth = {"Authorization": "Bearer " + key}
        self.conn = self._connect()

    def _connect(self):
        cls = http.client.HTTPSConnection if self.base.scheme == "https" else http.client.HTTPConnection
        return cls(self.base.netloc, timeout=TIMEOUT)

    def call(self, method, path, body=None, ctype=None, conn=None):
        conn = conn or self.conn
        headers = dict(self.auth)
        if ctype:
            headers["Content-Type"] = ctype
        last = None
        for attempt in range(3):
            try:
                conn.request(method, self.base.path.rstrip("/") + path, body=body, headers=headers)
                r = conn.getresponse()
                raw = r.read()
            except (OSError, http.client.HTTPException) as e:
                conn.close()  # a kept-alive connection the server dropped: the next request opens a new one
                last = e
                if attempt == 2:
                    raise TalkError("network", "Soniox could not be reached: %s" % e)
                time.sleep(0.5 * (attempt + 1))
                continue
            if r.status in (429, 500, 502, 503) and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            if r.status >= 400:
                raise TalkError(_status_code(r.status), _status_text(r.status, raw))
            return json.loads(raw) if raw.strip() else {}
        raise TalkError("network", "Soniox could not be reached: %s" % last)

    def temporary_key(self):
        body = {"usage_type": "transcribe_websocket", "expires_in_seconds": TEMP_KEY_SECONDS, "single_use": True,
                "max_session_duration_seconds": SESSION_SECONDS, "client_reference_id": "dispatch-point-talk"}
        got = self.call("POST", "/v1/auth/temporary-api-key", json.dumps(body).encode(), "application/json")
        if not got.get("api_key"):
            raise TalkError("bad_answer", "Soniox did not hand out a temporary key.")
        return got

    def transcribe(self, path, hints):
        size = os.path.getsize(path)
        if size > UPLOAD_LIMIT:
            raise TalkError("too_big", "The recording is too long to transcribe in one go (%d MB)." % (size // (1024 * 1024)))
        with open(path, "rb") as f:
            data = f.read()
        boundary = uuid.uuid4().hex
        name = os.path.basename(path)
        body = (('--%s\r\nContent-Disposition: form-data; name="file"; filename="%s"\r\n'
                 'Content-Type: application/octet-stream\r\n\r\n') % (boundary, name)).encode() + data + ("\r\n--%s--\r\n" % boundary).encode()
        file_id = self.call("POST", "/v1/files", body, "multipart/form-data; boundary=" + boundary)["id"]
        tid = None
        try:
            config = {"model": ASYNC_MODEL, "file_id": file_id, "language_hints": hints, "enable_language_identification": True,
                      "client_reference_id": "dispatch-point-talk"}
            tid = self.call("POST", "/v1/transcriptions", json.dumps(config).encode(), "application/json")["id"]
            t0 = time.time()
            deadline = t0 + 120 + size / 20000.0
            while True:
                st = self.call("GET", "/v1/transcriptions/" + tid)
                if st.get("status") == "completed":
                    break
                if st.get("status") == "error":
                    raise TalkError("failed", "Soniox could not transcribe it: %s" % (st.get("error_message") or "no reason given"))
                if time.time() > deadline:
                    raise TalkError("timeout", "Soniox did not finish the transcript in time.")
                time.sleep(0.3 if time.time() - t0 < 10 else 1.5)
            tokens = self.call("GET", "/v1/transcriptions/%s/transcript" % tid).get("tokens") or []
        finally:
            # the words are here: the file and the transcription go on Soniox, off the way back
            done = threading.Thread(target=self._delete, args=((["/v1/transcriptions/" + tid] if tid else []) + ["/v1/files/" + file_id],))
            done.start()
            done.join(timeout=5)
        return tokens

    def _delete(self, paths):
        conn = self._connect()
        for path in paths:
            try:
                self.call("DELETE", path, conn=conn)
            except TalkError as e:
                print("Soniox cleanup %s: %s" % (path, e), file=sys.stderr)
        conn.close()


def _status_code(status):
    return {401: "bad_key", 403: "forbidden", 402: "no_credit", 429: "busy"}.get(status, "soniox_%d" % status)


def _status_text(status, raw):
    detail = ""
    try:
        j = json.loads(raw)
        detail = j.get("message") or j.get("error_message") or ""
    except ValueError:
        detail = raw.decode(errors="replace")[:200]
    plain = {401: "Soniox did not accept the key in SONIOX_API_KEY.",
             403: "The key in SONIOX_API_KEY is not allowed to do this.",
             402: "Your Soniox account is out of credit.",
             429: "Soniox is busy; try again in a moment."}.get(status, "Soniox answered %d." % status)
    return plain + (" (" + detail.strip() + ")" if detail and detail.strip() else "")


def keep_tokens(tokens):
    """What the window needs of each token: its words, times and language (translations are not asked for)."""
    out = []
    for t in tokens:
        if t.get("translation_status") == "translation" or "start_ms" not in t:
            continue
        out.append({"text": t.get("text", ""), "start_ms": t["start_ms"], "end_ms": t.get("end_ms", t["start_ms"]),
                    "language": t.get("language") or ""})
    return out


def parser():
    p = argparse.ArgumentParser(prog="dispatch point-talk", description="Point and talk's speech recognition (Soniox).")
    p.add_argument("op", choices=["status", "key", "transcribe"])
    p.add_argument("file", nargs="?")
    p.add_argument("--json", action="store_true")
    return p


def run(a):
    if a.op == "status":
        return {"ok": True, "key": bool(soniox_key()), "name": KEY_NAME}
    if a.op == "key":
        got = Soniox(soniox_key()).temporary_key()
        return {"ok": True, "key": got["api_key"], "expires_at": got.get("expires_at", ""), "model": RT_MODEL,
                "url": "wss://stt-rt.soniox.com/transcribe-websocket", "languages": languages()}
    if a.op == "transcribe":
        if not a.file or not os.path.isfile(a.file):
            raise TalkError("no_file", "No recording at %s." % (a.file or "(none given)"))
        tokens = Soniox(soniox_key()).transcribe(a.file, languages())
        return {"ok": True, "model": ASYNC_MODEL, "tokens": keep_tokens(tokens)}
    raise TalkError("usage", "Unknown operation %s." % a.op)


def main(argv=None):
    a = parser().parse_args(argv)
    try:
        res = run(a)
    except TalkError as e:
        if a.json:
            print(json.dumps({"ok": False, "error": e.code, "message": str(e)}, ensure_ascii=False), flush=True)
        else:
            print(str(e), file=sys.stderr)
        return 1
    if a.json:
        print(json.dumps(res, ensure_ascii=False), flush=True)
    elif a.op == "status":
        print("Soniox key: " + ("yes (%s)" % KEY_NAME if res["key"] else "none; add %s in Settings › Keys" % KEY_NAME))
    elif a.op == "key":
        print("A temporary key for one real-time socket, valid until %s." % res["expires_at"])
    else:
        print("".join(t["text"] for t in res["tokens"]).strip())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
