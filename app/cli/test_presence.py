import json
import os
import tempfile
import unittest
from presence import event_status, install_claude_hooks, classify

class PresenceSignals(unittest.TestCase):
    def test_idle_is_not_a_request(self):
        self.assertEqual(event_status("Stop", {}, {"attention": "input"}), ("idle", None))
        self.assertEqual(event_status("Notification", {"notification_type": "idle_prompt"}, {"state": "idle"}), ("idle", None))
    def test_request_and_recovery(self):
        self.assertEqual(event_status("PermissionRequest", {}, {}), ("idle", "input"))
        self.assertEqual(event_status("PostToolUseFailure", {}, {}), ("idle", "failure"))
        self.assertEqual(event_status("PostToolUse", {}, {"attention": "failure"}), ("working", None))
    def test_unknown_event_does_not_invent_idle(self):
        self.assertEqual(event_status("Other", {}, {}), ("unknown", None))
    def test_user_interrupt_is_not_failure(self):
        self.assertEqual(event_status("PostToolUseFailure", {"is_interrupt": True}, {"state": "working"}), ("working", None))
    def test_codex_desktop_source(self):
        self.assertEqual(classify(["/Applications/Codex.app/Contents/MacOS/Codex"]), ("desktop", "Codex 桌面端"))
    def test_install_preserves_hooks_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "settings.json")
            original = {"type": "command", "command": "another-extension"}
            with open(path, "w") as f:
                json.dump({"hooks": {"PermissionRequest": [{"hooks": [original]}]}, "other": True}, f)
            install_claude_hooks(path)
            with open(path) as f: first = json.load(f)
            install_claude_hooks(path)
            with open(path) as f: second = json.load(f)
            self.assertEqual(first, second)
            self.assertTrue(second["other"])
            self.assertEqual(second["hooks"]["PermissionRequest"][0]["hooks"][0], original)
