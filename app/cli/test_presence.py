# -*- coding: utf-8 -*-
import json
import io
import os
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import subprocess
import presence
from presence import event_status, classify

WINDOWS_READY = True

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
        with patch.object(presence, "IS_WIN", False):
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
        with patch.object(presence, "IS_WIN", False):
            self.assertEqual(classify(chain), ("terminal", "Ghostty"))
    def test_claudian_in_obsidian_is_not_a_terminal(self):
        chain = ["/Users/x/.local/bin/claude", "/Applications/Obsidian.app/Contents/Frameworks/Obsidian Helper (Plugin).app/Contents/MacOS/Obsidian Helper (Plugin)", "/Applications/Obsidian.app/Contents/MacOS/Obsidian"]
        win = ["C:\\Users\\x\\.local\\bin\\claude.exe", "C:\\Users\\x\\AppData\\Local\\Programs\\Obsidian\\Obsidian.exe"]
        with patch.object(presence, "IS_WIN", False):
            self.assertEqual(classify(chain, "claude-code", "sdk-ts"), ("editor", "Obsidian · Claudian"))
            # Obsidian alone is not Claudian: Codex or an interactive `claude` in a terminal plugin
            self.assertEqual(classify(chain), ("editor", "Obsidian"))
            self.assertEqual(classify(chain, "claude-code", "cli"), ("editor", "Obsidian"))
            self.assertEqual(classify(chain, "claude-code", "sdk-cli"), ("editor", "Obsidian"))  # a `claude -p` script
            self.assertEqual(classify(chain, "codex", "sdk-ts"), ("editor", "Obsidian"))
        with patch.object(presence, "IS_WIN", True):
            self.assertEqual(classify(win, "claude-code", "sdk-ts"), ("editor", "Obsidian · Claudian"))
            self.assertEqual(classify(win, "codex"), ("editor", "Obsidian"))
    def test_real_vs_code_is_still_recognised(self):
        with patch.object(presence, "IS_WIN", False):
            self.assertEqual(classify(["/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper"]), ("editor", "VS Code"))
            self.assertEqual(classify(["/Applications/Code.app/Contents/MacOS/Electron"]), ("editor", "VS Code"))


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
        # A process table of its own: the real one depends on how the suite was started. Run in the
        # background (its parent shell gone, reparented to pid 1) no ancestor is an agent, nothing can be
        # learned, and every event walked the table again: the suite failed only then.
        table = {os.getppid(): (1, "/usr/local/bin/claude")}
        with tempfile.TemporaryDirectory() as d, patch.object(presence, "DIR", d), patch.object(presence, "ps_table", side_effect=lambda: calls.append(1) or table), \
                patch.object(presence, "_alive", return_value=True), patch.object(presence, "spawn_detached"):
            for event in ("SessionStart", "PreToolUse", "PostToolUse", "PreToolUse"):
                with patch.object(sys, "argv", ["presence.py", "claude-code", event]), patch.object(sys, "stdin", io.StringIO(json.dumps({"session_id": "s1", "cwd": "/tmp/p"}))):
                    presence.main()
        # SessionStart: once for the host app, once for the sweep (first ever); later events: none within the minute.
        self.assertLessEqual(len(calls), 2)


class WindowsBranch(unittest.TestCase):
    """The IS_WIN paths, exercised on any OS by flipping the flag."""

    def test_alive_probes_through_dplatform_never_signal_zero(self):
        # On Windows os.kill(pid, 0) is CTRL_C_EVENT: it would interrupt the agent's own console.
        with patch.object(presence.P, "IS_WIN", True), patch.object(presence.P, "pid_alive", return_value=False) as probe, \
                patch.object(presence.os, "kill", side_effect=AssertionError("os.kill must not be called")):
            self.assertFalse(presence._alive(4242))
        probe.assert_called_once_with(4242)
        with patch.object(presence.P, "pid_alive", return_value=True):
            self.assertTrue(presence._alive("77"))
        self.assertTrue(presence._alive(None))  # unknowable: keep what was learned

    def test_classify_by_exe_name(self):
        with patch.object(presence, "IS_WIN", True):
            wt = ["C:\\Users\\x\\.local\\bin\\claude.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
                  "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.21\\WindowsTerminal.exe"]
            self.assertEqual(classify(wt), ("terminal", "Windows Terminal"))
            code = ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                    "C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"]
            self.assertEqual(classify(code), ("editor", "VS Code"))
            # The claude CLI's own exe is not the Claude desktop app; the real desktop app is.
            self.assertEqual(classify(["C:\\Users\\x\\.local\\bin\\claude.exe"]), ("terminal", "终端"))
            self.assertEqual(classify(["C:\\Users\\x\\AppData\\Local\\AnthropicClaude\\app-1.0\\claude.exe"]), ("desktop", "Claude 桌面端"))
            self.assertEqual(classify(["herdr.exe"]), ("terminal", "Herdr"))

    def test_no_process_table_does_not_sweep_every_record(self):
        with tempfile.TemporaryDirectory() as d, patch.object(presence, "DIR", d), patch.object(presence, "ps_table", return_value={}), \
                patch.object(presence, "spawn_detached"):
            old = os.path.join(d, "claude-code__old.json")
            with open(old, "w") as f:
                json.dump({"agent_pid": 999999, "last_at": 0}, f)
            with patch.object(sys, "argv", ["presence.py", "claude-code", "SessionStart"]), patch.object(sys, "stdin", io.StringIO(json.dumps({"session_id": "s2", "cwd": d}))):
                presence.main()
            self.assertTrue(os.path.exists(old))
            self.assertTrue(os.path.exists(os.path.join(d, "claude-code__s2.json")))


class HookAsScript(unittest.TestCase):
    """The hook the way Claude Code runs it: a fresh interpreter, the JSON on stdin (UTF-8 bytes)."""

    def test_session_start_writes_a_record(self):
        here = os.path.dirname(os.path.abspath(__file__))
        with tempfile.TemporaryDirectory() as d:
            cwd = os.path.join(d, "项目 one")
            os.makedirs(cwd)
            env = {k: v for k, v in os.environ.items() if k not in ("PYTHONUTF8", "PYTHONIOENCODING")}
            env["DISPATCH_DIR"] = d
            r = subprocess.run([sys.executable, os.path.join(here, "presence.py"), "claude-code", "SessionStart"],
                               input=json.dumps({"session_id": "abc-1", "cwd": cwd}, ensure_ascii=False).encode("utf-8"),
                               capture_output=True, env=env, timeout=60)
            self.assertEqual(r.returncode, 0)
            self.assertEqual(r.stderr.decode("utf-8", "replace"), "")
            with open(os.path.join(d, "sessions", "claude-code__abc-1.json"), encoding="utf-8") as f:
                rec = json.load(f)
        self.assertEqual((rec["cwd"], rec["project"], rec["state"]), (cwd, "项目 one", "idle"))
        self.assertIsInstance(rec["agent_pid"], int)
        self.assertTrue(rec["source_app"])


class TaskLinking(unittest.TestCase):
    """PostToolUse: a Bash command that worked on a task links the session to it, in the background."""

    def test_task_ids_from_tool_input(self):
        self.assertEqual(presence.task_ids({"tool_input": {"command": "dispatch log task-ab1 'x' && bd update task-cd2 --claim"}}), ["task-ab1", "task-cd2"])
        self.assertEqual(presence.task_ids({"tool_input": {"command": ["bash", "-lc", "dispatch done task-ef3 --reason x"]}}), ["task-ef3"])
        self.assertEqual(presence.task_ids({"tool_input": {"command": "ls -la"}}), [])
        self.assertEqual(presence.task_ids({"tool_input": {"file_path": "/x"}}), [])

    def test_link_spawns_one_child_per_task_and_none_otherwise(self):
        with patch.object(presence, "spawn_detached") as spawn:
            presence.link_tasks("sess-abcdefgh", {"tool_input": {"command": "dispatch check task-ab1 2 --claim 'commit abc'"}})
            self.assertEqual(spawn.call_count, 1)
            argv = spawn.call_args.args[0]
            self.assertEqual(argv[-4:], ["link", "task-ab1", "--session", "sess-abcdefgh"])
            spawn.reset_mock()
            presence.link_tasks("sess-abcdefgh", {"tool_input": {"command": "git status"}})
            presence.link_tasks("pid-123", {"tool_input": {"command": "dispatch log task-ab1 x"}})
            spawn.assert_not_called()
