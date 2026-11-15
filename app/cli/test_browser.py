# -*- coding: utf-8 -*-
import asyncio
import io
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zlib
from contextlib import redirect_stdout, redirect_stderr
from http.server import HTTPServer, SimpleHTTPRequestHandler
from types import SimpleNamespace
from unittest import mock

WINDOWS_READY = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import browser as B  # noqa: E402
import browserd as BD  # noqa: E402


def tiny_png(path, w=3, h=2):
    raw = b"".join(b"\0" + b"\0\0\0" * w for _ in range(h))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


class HelperTest(unittest.TestCase):
    def test_normalize_url(self):
        self.assertEqual(BD.normalize_url("localhost:3000"), "http://localhost:3000")
        self.assertEqual(BD.normalize_url("127.0.0.1:8080/x"), "http://127.0.0.1:8080/x")
        self.assertEqual(BD.normalize_url("example.com"), "http://example.com")
        self.assertEqual(BD.normalize_url("https://a.b/c"), "https://a.b/c")
        self.assertEqual(BD.normalize_url("about:blank"), "about:blank")
        self.assertTrue(BD.normalize_url("/tmp/x.html").startswith("file://"))
        self.assertEqual(BD.normalize_url(""), "about:blank")

    def test_selector_kind(self):
        for css in ("#go", ".btn", "button", "input[name=q]", "text=Sign in", "role=button[name=\"OK\"]", "form > input", "//div"):
            self.assertEqual(BD.selector_kind(css), "css", css)
        for text in ("Say hi", "Sign in", "Weiter"):
            self.assertEqual(BD.selector_kind(text), "text", text)

    def test_parse_since(self):
        self.assertEqual(BD.parse_since(""), 0.0)
        self.assertEqual(BD.parse_since("0"), 0.0)
        self.assertAlmostEqual(BD.parse_since("5m", now=1000.0), 700.0)
        self.assertAlmostEqual(BD.parse_since("30s", now=1000.0), 970.0)
        self.assertAlmostEqual(BD.parse_since("1h", now=4000.0), 400.0)
        self.assertEqual(BD.parse_since("123.5"), 123.5)
        with self.assertRaises(ValueError):
            BD.parse_since("yesterday")

    def test_logs_ring(self):
        logs = BD.Logs(size=3)
        for i in range(5):
            logs.add("console", "m%d" % i, level="log")
        self.assertEqual([r["text"] for r in logs.since()], ["m2", "m3", "m4"])
        self.assertEqual(logs.since()[-1]["seq"], 5)
        cut = logs.items[-1]["ts"]
        logs.add("pageerror", "boom")
        self.assertEqual([r["text"] for r in logs.since(cut - 0.0001, kinds=["pageerror"])], ["boom"])
        self.assertEqual(len(logs.since(limit=1)), 1)
        logs.clear()
        self.assertEqual(logs.since(), [])

    def test_clip(self):
        self.assertEqual(BD.clip({"a": 1}), {"value": {"a": 1}})
        big = BD.clip("x" * 200, limit=50)
        self.assertTrue(big["truncated"])
        self.assertEqual(len(big["value"]), 50)

    def test_png_size(self):
        d = tempfile.mkdtemp()
        try:
            p = os.path.join(d, "a.png")
            tiny_png(p, 7, 5)
            self.assertEqual(BD.png_size(p), (7, 5))
            self.assertEqual(BD.png_size(os.path.join(d, "missing.png")), (0, 0))
        finally:
            shutil.rmtree(d)

    def test_cached_chromiums_newest_first(self):
        d = tempfile.mkdtemp()
        try:
            for rev in ("1100", "1234"):
                p = os.path.join(d, "chromium-" + rev, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS")
                os.makedirs(p)
                open(os.path.join(p, "Google Chrome for Testing"), "w").close()
            os.makedirs(os.path.join(d, "chromium_headless_shell-1300"))
            found = BD.cached_chromiums(d)
            self.assertEqual(len(found), 2)
            self.assertIn("chromium-1234", found[0])
            self.assertEqual(BD.cached_chromiums(os.path.join(d, "none")), [])
        finally:
            shutil.rmtree(d)


class DaemonDispatchTest(unittest.TestCase):
    """The command router without a browser: errors map to codes, logs work, unknown commands fail."""

    def run_async(self, coro):
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()

    def daemon(self):
        d = BD.Daemon(tempfile.gettempdir(), 60, True)

        async def setup():
            d.lock = asyncio.Lock()
            d.stop = asyncio.Event()
        self.run_async(setup())
        return d

    def test_router(self):
        d = self.daemon()

        async def go():
            d.lock = asyncio.Lock()
            d.stop = asyncio.Event()
            out = {}
            out["unknown"] = await d.dispatch({"cmd": "nope"})
            out["bad"] = await d.dispatch({"cmd": "__init__"})
            out["no_page"] = await d.dispatch({"cmd": "shot"})
            d.logs.add("console", "hello", level="log")
            out["logs"] = await d.dispatch({"cmd": "logs", "since": "", "clear": True})
            out["logs2"] = await d.dispatch({"cmd": "logs"})

            class TimeoutError_(Exception):
                pass
            TimeoutError_.__name__ = "TimeoutError"

            async def slow(r):
                raise TimeoutError_("Timeout 10ms exceeded")
            d.cmd_slow = slow
            out["timeout"] = await d.dispatch({"cmd": "slow"})
            out["close"] = await d.dispatch({"cmd": "close"})
            out["stopped"] = d.stop.is_set()
            return out
        out = self.run_async(go())
        self.assertEqual(out["unknown"]["error"], "usage")
        self.assertEqual(out["bad"]["error"], "usage")
        self.assertEqual(out["no_page"]["error"], "no_page")
        self.assertEqual(out["logs"]["count"], 1)
        self.assertEqual(out["logs"]["entries"][0]["text"], "hello")
        self.assertEqual(out["logs2"]["count"], 0)
        self.assertEqual(out["timeout"]["error"], "timeout")
        self.assertTrue(out["close"]["closed"])
        self.assertTrue(out["stopped"])

    def test_token_required_on_tcp(self):
        d = self.daemon()
        d.token = "secret"

        async def go():
            d.lock = asyncio.Lock()
            d.stop = asyncio.Event()
            server = await asyncio.start_server(d.handle, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            res = []
            for body in ({"cmd": "logs"}, {"cmd": "logs", "token": "secret"}):
                r, w = await asyncio.open_connection("127.0.0.1", port)
                w.write((json.dumps(body) + "\n").encode())
                await w.drain()
                res.append(json.loads((await r.readline()).decode()))
                w.close()
            server.close()
            return res
        bad, good = self.run_async(go())
        self.assertEqual(bad["error"], "forbidden")
        self.assertTrue(good["ok"])


class FakeDaemon(object):
    """A TCP stand-in for browserd speaking the same one-line protocol."""

    def __init__(self, token="tok"):
        self.token = token
        self.requests = []
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.port = self.sock.getsockname()[1]
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        while True:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            buf = b""
            while not buf.endswith(b"\n"):
                chunk = c.recv(4096)
                if not chunk:
                    break
                buf += chunk
            req = json.loads(buf.decode())
            self.requests.append(req)
            if req.get("token") != self.token:
                resp = {"ok": False, "error": "forbidden"}
            elif req["cmd"] == "status":
                resp = {"ok": True, "url": "http://x/", "title": "X", "pid": os.getpid(), "headless": True, "idle_s": 1}
            elif req["cmd"] == "shot":
                resp = {"ok": True, "path": "/tmp/a.png", "width": 1, "height": 1}
            elif req["cmd"] == "close":
                resp = {"ok": True, "closed": True}
            else:
                resp = {"ok": True, "echo": req}
            c.sendall((json.dumps(resp) + "\n").encode())
            c.close()

    def close(self):
        self.sock.close()


class ClientTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = mock.patch.dict(os.environ, {"DISPATCH_DIR": self.tmp, "DISPATCH_BROWSER_VENV": os.path.join(self.tmp, "venv")})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = B.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def write_state(self, st):
        os.makedirs(B.state_dir(), exist_ok=True)
        with open(B.state_file(), "w") as f:
            json.dump(st, f)

    def test_not_running(self):
        code, out, _ = self.main("status", "--json")
        self.assertEqual(json.loads(out), {"ok": True, "running": False})
        code, out, _ = self.main("shot", "--json")
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out)["error"], "not_running")
        code, out, _ = self.main("close", "--json")
        self.assertFalse(json.loads(out)["closed"])
        # a state file left by a dead daemon counts as not running
        self.write_state({"pid": 999999, "transport": "tcp", "port": 1, "token": "x"})
        self.assertIsNone(B.running())
        code, out, err = self.main("click", "Go")
        self.assertEqual(code, 1)
        self.assertIn("browser open", err)

    def test_close_leaves_a_reused_pid_alone(self):
        victim = subprocess.Popen(["sleep", "300"])
        try:
            self.write_state({"pid": victim.pid, "transport": "unix", "socket": os.path.join(self.tmp, "gone.sock"), "token": "x"})
            # no request to it and no wait for it to quit: it is not ours. Said with the calls, not a stopwatch
            # (`ps` alone took more than the 5 s the test allowed on a busy Mac)
            def no_wait(_s):
                raise AssertionError("waited for a process that is not ours")
            # browser.py's own time, not the time module every thread shares
            with mock.patch.object(B, "request", side_effect=AssertionError("asked a process that is not ours")), \
                    mock.patch.object(B, "time", SimpleNamespace(sleep=no_wait, time=time.time, monotonic=time.monotonic)):
                code, out, _ = self.main("close", "--json")
            r = json.loads(out)
            self.assertFalse(r["closed"])
            self.assertTrue(r.get("stale"))
            self.assertIsNone(victim.poll())
            self.assertFalse(os.path.exists(B.state_file()))
        finally:
            victim.kill()
            victim.wait()

    def test_is_daemon_reads_the_command_line(self):
        p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", B.DAEMON, "--dir", B.state_dir()])
        try:
            deadline = time.time() + 5
            while time.time() < deadline and not B.is_daemon(p.pid):
                time.sleep(0.1)
            self.assertTrue(B.is_daemon(p.pid))
            self.assertFalse(B.is_daemon(os.getpid()))
        finally:
            p.kill()
            p.wait()

    def test_requests_carry_token_and_arguments(self):
        fake = FakeDaemon()
        try:
            self.write_state({"pid": os.getpid(), "transport": "tcp", "port": fake.port, "token": "tok", "headless": True})
            code, out, _ = self.main("status", "--json")
            st = json.loads(out)
            self.assertTrue(st["running"])
            self.assertEqual(st["title"], "X")
            code, out, _ = self.main("type", "#q", "hello world", "--submit", "--json")
            echo = json.loads(out)["echo"]
            self.assertEqual((echo["cmd"], echo["selector"], echo["text"], echo["submit"]), ("type", "#q", "hello world", True))
            self.assertEqual(echo["token"], "tok")
            code, out, _ = self.main("eval", "document.title", "--json")
            self.assertEqual(json.loads(out)["echo"]["js"], "document.title")
            code, out, _ = self.main("logs", "--since", "5m", "--types", "console,pageerror", "--json")
            self.assertEqual(json.loads(out)["echo"]["since"], "5m")
            code, out, _ = self.main("shot", "--out", "rel.png", "--json")
            self.assertTrue(os.path.isabs(fake.requests[-1]["out"]))
            code, out, _ = self.main("shot")
            self.assertIn("/tmp/a.png", out)
            # open reuses the running daemon: no install, no start
            with mock.patch.object(B, "ensure_playwright", side_effect=AssertionError("must not install")):
                code, out, _ = self.main("open", "localhost:3000", "--json")
            r = json.loads(out)
            self.assertFalse(r["daemon"]["started"])
            self.assertEqual(r["echo"]["url"], "localhost:3000")
        finally:
            fake.close()

    def test_ensure_playwright_creates_venv_and_installs(self):
        calls = []
        state = {"venv": False, "pw": False}

        def fake_run(args, timeout, env=None):
            calls.append(args)
            if args[1:3] == ["-m", "venv"]:
                os.makedirs(os.path.dirname(B.venv_python()), exist_ok=True)
                open(B.venv_python(), "w").close()
                state["venv"] = True
                return 0, "", ""
            if "pip" in args:
                state["pw"] = True
                return 0, "", ""
            if args[1] == "-c":
                return (0 if state["pw"] else 1), "", ""
            return 1, "", "?"
        err = io.StringIO()
        with mock.patch.object(B, "_run", fake_run), redirect_stderr(err), mock.patch("mirrors.use_china", return_value=False):
            steps = B.ensure_playwright()
        self.assertEqual(steps, ["venv", "playwright"])
        self.assertIn("Playwright", err.getvalue())
        self.assertTrue(any("pip" in c and "playwright" in c for c in calls))
        with mock.patch.object(B, "_run", fake_run):
            self.assertEqual(B.ensure_playwright(), [])

    def test_ensure_playwright_failure(self):
        def fake_run(args, timeout, env=None):
            if args[1:3] == ["-m", "venv"]:
                os.makedirs(os.path.dirname(B.venv_python()), exist_ok=True)
                open(B.venv_python(), "w").close()
                return 0, "", ""
            return 1, "", "no network"
        with mock.patch.object(B, "_run", fake_run), redirect_stderr(io.StringIO()), mock.patch("mirrors.use_china", return_value=False):
            with self.assertRaises(B.BrowserError) as cm:
                B.ensure_playwright()
        self.assertEqual(cm.exception.code, "install_failed")
        self.assertIn("no network", str(cm.exception))

    def test_missing_browser_installs_chromium_then_retries(self):
        spawned = []

        def fake_spawn(headless):
            spawned.append(headless)
            if len(spawned) == 1:
                raise B.BrowserError("missing_browser", "missing_browser: no executable")
            return {"pid": 1}
        with mock.patch.object(B, "ensure_playwright", return_value=[]), \
                mock.patch.object(B, "spawn", fake_spawn), \
                mock.patch.object(B, "install_chromium") as inst:
            st, info = B.ensure_running(True)
        inst.assert_called_once()
        self.assertEqual(spawned, [True, True])
        self.assertEqual(info["installed"], ["chromium"])
        self.assertTrue(info["started"])
        self.assertFalse(os.path.exists(os.path.join(B.state_dir(), "start.lock")))

    def test_socket_path_stays_short(self):
        with mock.patch.dict(os.environ, {"DISPATCH_DIR": os.path.join(self.tmp, "x" * 120)}):
            self.assertLessEqual(len(B.socket_path().encode()), B.SOCK_MAX)
        self.assertTrue(B.socket_path().startswith(self.tmp))

    def test_dispatch_hands_over(self):
        env = dict(os.environ)
        r = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "browser", "status", "--json"],
                           capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["running"], False)


def _test_venv():
    v = os.environ.get("DISPATCH_TEST_BROWSER_VENV", "")
    py = os.path.join(v, "Scripts", "python.exe") if os.name == "nt" else os.path.join(v, "bin", "python")
    return v if v and os.path.exists(py) else ""


@unittest.skipUnless(_test_venv(), "DISPATCH_TEST_BROWSER_VENV (a venv with playwright) not set")
class RealBrowserTest(unittest.TestCase):
    """End to end with a real Chromium: DISPATCH_TEST_BROWSER_VENV=<venv with playwright>."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        site = os.path.join(cls.tmp, "site")
        os.makedirs(site)
        with open(os.path.join(site, "index.html"), "w") as f:
            f.write("<!doctype html><title>T</title><input id=q><button id=b onclick=\"document.title='clicked '+q.value;"
                    "console.log('clicked');fetch('/nope')\">Go</button><script>console.warn('hi')</script>")
        handler = lambda *a, **k: SimpleHTTPRequestHandler(*a, directory=site, **k)
        SimpleHTTPRequestHandler.log_message = lambda *a: None
        cls.httpd = HTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.url = "http://127.0.0.1:%d/" % cls.httpd.server_address[1]
        cls.env = mock.patch.dict(os.environ, {"DISPATCH_DIR": cls.tmp, "DISPATCH_BROWSER_VENV": _test_venv(), "DISPATCH_BROWSER_IDLE": "4"})
        cls.env.start()

    @classmethod
    def tearDownClass(cls):
        B.stop()
        cls.env.stop()
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def main(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            B.main(list(argv) + ["--json"])
        return json.loads(out.getvalue())

    def test_flow(self):
        r = self.main("open", self.url, "--headless")
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["daemon"]["started"])
        pid = r["daemon"]["pid"]
        r = self.main("open", self.url)
        self.assertFalse(r["daemon"]["started"])
        self.assertEqual(r["daemon"]["pid"], pid)
        self.assertTrue(self.main("type", "#q", "abc")["ok"])
        self.assertTrue(self.main("click", "Go")["ok"])
        time.sleep(0.3)
        self.assertEqual(self.main("eval", "document.title")["value"], "clicked abc")
        # a statement list that throws a runtime SyntaxError runs once, not again as a function body
        r = self.main("eval", "window.n=(window.n||0)+1; JSON.parse('{bad')")
        self.assertFalse(r["ok"], r)
        self.assertEqual(self.main("eval", "window.n")["value"], 1)
        self.assertEqual(self.main("eval", "const a = 2; return a * 21")["value"], 42)
        self.assertEqual(self.main("eval", "window.m=(window.m||0)+1; return window.m")["value"], 1)
        self.assertEqual(self.main("eval", "const v = await Promise.resolve(7); return v")["value"], 7)
        shot = self.main("shot")
        self.assertTrue(os.path.getsize(shot["path"]) > 0)
        kinds = {e["type"] for e in self.main("logs")["entries"]}
        self.assertTrue({"console", "http"} <= kinds, kinds)
        self.assertIn("button", self.main("snapshot")["snapshot"])
        # idle exit
        deadline = time.time() + 20
        while time.time() < deadline and B.P.pid_alive(pid):
            time.sleep(0.5)
            if os.name != "nt":
                try:  # browserd is our own child here: reap it or it stays a zombie
                    os.waitpid(pid, os.WNOHANG)
                except OSError:
                    pass
        self.assertFalse(B.P.pid_alive(pid))
        self.assertEqual(self.main("status"), {"ok": True, "running": False})


if __name__ == "__main__":
    unittest.main()
