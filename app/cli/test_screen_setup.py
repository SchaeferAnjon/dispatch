# -*- coding: utf-8 -*-
import os
import sys
import unittest
from unittest.mock import Mock, patch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import screen_setup  # noqa: E402
import dplatform as P  # noqa: E402

WINDOWS_READY = True


def serve_config(proxy="http://127.0.0.1:6080", port=443):
    return {"TCP": {str(port): {"HTTPS": True}},
            "Web": {f"mac.example.ts.net:{port}": {"Handlers": {"/": {"Proxy": proxy}}}}}


def probes(**over):
    """The five machine probes, so tests never touch the real ports, launchd or files."""
    values = {"screen_sharing_on": False, "local_up": False, "websockify_ready": False,
              "novnc_ready": False, "launchd_loaded": False, **over}
    return [patch.object(screen_setup, name, return_value=value) for name, value in values.items()]


def probe_mocks(**over):
    values = {"screen_sharing_on": False, "local_up": False, "websockify_ready": False,
              "novnc_ready": False, "launchd_loaded": False, **over}
    return patch.multiple(screen_setup, **{name: Mock(return_value=value) for name, value in values.items()})


def in_status(config, **over):
    patches = probes(**over) + [patch.object(screen_setup, "tailscale_cli", return_value=(config and "/ts" or "", config or {})),
                                patch.object(screen_setup.D, "tailscale_ip", return_value="100.64.0.1"),
                                patch.object(screen_setup.D, "lan_ip", return_value="192.168.1.5")]
    for p in patches:
        p.start()
    try:
        return screen_setup.status()
    finally:
        for p in patches:
            p.stop()


@patch.object(P, "IS_WIN", False)
class Status(unittest.TestCase):
    def test_ready_needs_url_service_and_screen_sharing(self):
        s = in_status(serve_config(), screen_sharing_on=True, local_up=True, websockify_ready=True, novnc_ready=True, launchd_loaded=True)
        self.assertTrue(s["ready"])
        self.assertTrue(s["url"].startswith("https://mac.example.ts.net/vnc.html"))
        self.assertEqual(s["issue"], "")
        self.assertTrue(all(st["ok"] for st in s["steps"]))

    def test_screen_sharing_off_is_reported_as_the_manual_step(self):
        s = in_status(serve_config(), local_up=True, websockify_ready=True, novnc_ready=True, launchd_loaded=True)
        self.assertFalse(s["ready"])
        self.assertIn("屏幕共享", s["issue"])
        self.assertEqual([m["id"] for m in s["manual"]], ["screen_sharing"])
        self.assertFalse(next(st for st in s["steps"] if st["id"] == "screen_sharing")["ok"])

    def test_no_tailscale_means_no_https_url(self):
        s = in_status({}, screen_sharing_on=True)
        self.assertFalse(s["ready"])
        self.assertEqual(s["url"], "")
        self.assertEqual([m["id"] for m in s["manual"]], ["tailscale"])


class ServePort(unittest.TestCase):
    def test_our_own_proxy_is_not_a_conflict(self):
        self.assertFalse(screen_setup.serve_conflict(serve_config()))
        self.assertFalse(screen_setup.serve_conflict(serve_config(port=8443), "8443"))

    def test_another_service_on_the_same_port_blocks_setup(self):
        self.assertTrue(screen_setup.serve_conflict(serve_config("http://127.0.0.1:7799")))
        self.assertFalse(screen_setup.serve_conflict(serve_config("http://127.0.0.1:7799"), "8443"))


@patch.object(P, "IS_WIN", False)
class Setup(unittest.TestCase):
    def test_no_tailscale_stops_before_installing_anything(self):
        with probe_mocks(), \
                patch.object(screen_setup, "tailscale_cli", return_value=("", {})), \
                patch.object(screen_setup, "_run") as run:
            r = screen_setup.setup()
        run.assert_not_called()
        self.assertFalse(r["ok"])
        self.assertEqual([st["id"] for st in r["steps"]], ["tailscale"])
        self.assertEqual([m["id"] for m in r["manual"]], ["tailscale", "screen_sharing"])

    def test_busy_https_port_stops_before_installing(self):
        with probe_mocks(), \
                patch.object(screen_setup, "tailscale_cli", return_value=("/ts", serve_config("http://127.0.0.1:7799"))), \
                patch.object(screen_setup, "_run") as run:
            r = screen_setup.setup()
        run.assert_not_called()
        self.assertFalse(r["ok"])
        self.assertEqual([st["id"] for st in r["steps"]], ["tailscale", "serve"])
        self.assertIn("DISPATCH_SCREEN_PORT", r["steps"][1]["detail"])


def run_cli(*args):
    """The real CLI in a child process, the way the app calls it: (exit code, stdout, stderr)."""
    import subprocess, sys
    cli = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py")
    r = subprocess.run([sys.executable, cli] + list(args), capture_output=True, timeout=120, env=dict(os.environ, PYTHONUTF8="1"))
    return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")


class Windows(unittest.TestCase):
    def test_status_is_unsupported_without_probing(self):
        with patch.object(P, "IS_WIN", True), probe_mocks(screen_sharing_on=Mock(side_effect=AssertionError)), \
             patch.object(screen_setup, "tailscale_cli", side_effect=AssertionError("nothing to probe")):
            s = screen_setup.status()
        self.assertEqual((s["supported"], s["ready"], s["steps"]), (False, False, []))
        self.assertIn("Windows", s["reason"])

    def test_setup_raises_unsupported(self):
        with patch.object(P, "IS_WIN", True), patch.object(screen_setup, "_run", side_effect=AssertionError):
            with self.assertRaises(P.Unsupported):
                screen_setup.setup()
            with self.assertRaises(P.Unsupported):
                screen_setup.bootstrap()

    def test_command_answers_in_json(self):
        import contextlib, io, json, types
        for op, key in (("status", "reason"), ("setup", "message")):
            buf = io.StringIO()
            with patch.object(P, "IS_WIN", True), contextlib.redirect_stdout(buf):
                screen_setup.main(types.SimpleNamespace(op=op, json=True))
            r = json.loads(buf.getvalue())
            self.assertFalse(r["supported"]); self.assertIn("Windows", r[key])

    @unittest.skipUnless(os.name == "nt", "real Windows only")
    def test_screen_status_json_on_windows(self):
        import json
        code, out, err = run_cli("screen", "status", "--json")
        self.assertNotIn("Traceback", out + err)
        self.assertEqual(code, 0)
        self.assertFalse(json.loads(out)["supported"])


if __name__ == "__main__":
    unittest.main()
