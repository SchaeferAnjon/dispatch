import json
import io
import os
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from presence import event_status, install_claude_hooks, classify

class PresenceSignals(unittest.TestCase):
    def test_idle_is_not_a_request(self):
        self.assertEqual(event_status("Stop", {}, {"attention": "input"}), ("idle", None))
        self.assertEqual(event_status("Notification", {"notification_type": "idle_prompt"}, {"state": "idle"}), ("idle", None))
        # An interrupted turn sends no Stop; the later idle_prompt is the sign it is over.
        self.assertEqual(event_status("Notification", {"notification_type": "idle_prompt"}, {"state": "working"}), ("idle", None))
        self.assertEqual(event_status("Notification", {"notification_type": "auth_success"}, {"state": "working"}), ("working", None))
    def test_request_and_recovery(self):
        self.assertEqual(event_status("PermissionRequest", {}, {}), ("idle", "input"))
        self.assertEqual(event_status("PostToolUseFailure", {}, {}), ("working", None))
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


class AttentionNotification(unittest.TestCase):
    """A session that starts waiting for the user pushes one notification (dedup key per session)."""

    def run_hook(self, event, data):
        import presence
        sent = []
        fake = types.ModuleType("notify")
        fake.send = lambda *a, **k: (sent.append((a, k)), {"ok": True})[1]
        with tempfile.TemporaryDirectory() as d, patch.object(presence, "DIR", d), \
                patch.dict(sys.modules, {"notify": fake}), \
                patch.object(sys, "argv", ["presence.py", "claude-code", event]), \
                patch.object(sys, "stdin", io.StringIO(json.dumps(data))):
            presence.main()
        return sent

    def test_permission_request_notifies(self):
        sent = self.run_hook("PermissionRequest", {"session_id": "abc", "cwd": "/tmp/proj"})
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][1]["key"], "presence:claude-code:abc")
        self.assertEqual(sent[0][1]["level"], "high")
        self.assertIn("proj", sent[0][0][1])

    def test_tool_use_does_not_notify(self):
        self.assertEqual(self.run_hook("UserPromptSubmit", {"session_id": "abc", "cwd": "/tmp/proj"}), [])
        self.assertEqual(self.run_hook("Stop", {"session_id": "abc", "cwd": "/tmp/proj"}), [])
