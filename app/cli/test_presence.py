# -*- coding: utf-8 -*-
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
    def test_claude_cli_wrapper_is_skipped_not_misread_as_vs_code(self):
        # "ClaudeCode.app/" literally contains the substring "Code.app/" — a bare (unanchored)
        # pattern used to match it and misreport the CLI's own updater wrapper as VS Code,
        # hiding the real host (e.g. Ghostty) one hop further up the chain.
        chain = [
            "/Users/x/.local/share/claude/versions/1.2.3",
            "/Users/x/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude",
            "/Users/x/.local/bin/claude",
            "claude",
            "-/opt/homebrew/bin/fish",
            "/usr/bin/login",
            "/Applications/Ghostty.app/Contents/MacOS/ghostty",
        ]
        self.assertEqual(classify(chain), ("terminal", "Ghostty"))
    def test_real_vs_code_is_still_recognised(self):
        self.assertEqual(classify(["/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper"]), ("editor", "VS Code"))
        self.assertEqual(classify(["/Applications/Code.app/Contents/MacOS/Electron"]), ("editor", "VS Code"))
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
        """The push runs as a detached `notify.py …` process (a network call must not hold up the
        agent's hook): collect the argv it would have been started with."""
        import presence
        sent = []
        with tempfile.TemporaryDirectory() as d, patch.object(presence, "DIR", d), \
                patch.object(presence, "spawn_detached", side_effect=lambda argv: sent.append(argv)), \
                patch.object(sys, "argv", ["presence.py", "claude-code", event]), \
                patch.object(sys, "stdin", io.StringIO(json.dumps(data))):
            presence.main()
        return sent

    def test_permission_request_notifies(self):
        sent = self.run_hook("PermissionRequest", {"session_id": "abc", "cwd": "/tmp/proj"})
        self.assertEqual(len(sent), 1)
        argv = sent[0]
        self.assertTrue(argv[1].endswith("notify.py"))
        self.assertEqual(argv[argv.index("--key") + 1], "presence:claude-code:abc")
        self.assertEqual(argv[argv.index("--level") + 1], "high")
        self.assertIn("proj", argv[3])

    def test_tool_use_does_not_notify(self):
        self.assertEqual(self.run_hook("UserPromptSubmit", {"session_id": "abc", "cwd": "/tmp/proj"}), [])
        self.assertEqual(self.run_hook("Stop", {"session_id": "abc", "cwd": "/tmp/proj"}), [])


class CheapPerEvent(unittest.TestCase):
    """Only the first event of a session walks the process table (review P1-4)."""

    def test_later_events_reuse_what_session_start_learned(self):
        import presence
        calls = []
        real = presence.ps_table
        with tempfile.TemporaryDirectory() as d, patch.object(presence, "DIR", d), patch.object(presence, "ps_table", side_effect=lambda: calls.append(1) or real()), \
                patch.object(presence, "spawn_detached"):
            for event in ("SessionStart", "PreToolUse", "PostToolUse", "PreToolUse"):
                with patch.object(sys, "argv", ["presence.py", "claude-code", event]), patch.object(sys, "stdin", io.StringIO(json.dumps({"session_id": "s1", "cwd": "/tmp/p"}))):
                    presence.main()
        # SessionStart: once for the host app, once for the sweep (first ever); later events: none within the minute.
        self.assertLessEqual(len(calls), 2)
