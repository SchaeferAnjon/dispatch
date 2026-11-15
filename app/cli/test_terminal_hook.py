# -*- coding: utf-8 -*-
"""An agent in Dispatch's terminal tells the bell its turn ended (terminal_hook.py). Temporary DISPATCH_DIR only."""
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import inbox
import terminal_hook as H
from engines import claude as C, opencode as O


class Hook(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = {"DISPATCH_TERMINAL_SESSION": "abc12345", "DISPATCH_DIR": self.tmp, "PWD": "/Users/x/proj"}
        p = mock.patch.dict(os.environ, {"DISPATCH_DIR": self.tmp})
        p.start()
        self.addCleanup(p.stop)

    def run_hook(self, agent, event, payload, daemon=None):
        with mock.patch.object(H, "tell_daemon", return_value=daemon or {}):
            return H.handle(agent, event, payload, env=self.env, base=self.tmp)

    def events(self):
        return inbox.listing(base=self.tmp)["events"]

    def test_outside_a_dispatch_terminal_it_does_nothing(self):
        r = H.handle("claude", "Stop", {}, env={}, base=self.tmp)
        self.assertIsNone(r["state"])
        self.assertEqual(self.events(), [])

    def test_claude_finishing_is_filed_as_finished_with_its_last_words(self):
        r = self.run_hook("claude", "Stop", {"last_assistant_message": "Done.\nAll tests pass."},
                          daemon={"title": "Claude Code (terminal)", "cwd": "/Users/x/proj"})
        self.assertEqual(r["state"], "finished")
        e = self.events()[0]
        self.assertEqual((e["kind"], e["source"], e["session"], e["agent"]),
                         ("finished", "terminal", "dispatch-terminal:/abc12345", "claude-code"))
        self.assertEqual((e["title"], e["project"], e["text"]), ("Claude Code (terminal)", "proj", "All tests pass."))
        self.assertTrue(e["ring"])

    def test_claude_s_last_words_come_from_its_transcript_when_the_hook_does_not_say(self):
        t = os.path.join(self.tmp, "t.jsonl")
        with open(t, "w") as f:
            f.write(json.dumps({"message": {"role": "user", "content": "hi"}}) + "\n")
            f.write(json.dumps({"message": {"role": "assistant", "content": [{"type": "text", "text": "Fixed the bug."}]}}) + "\n")
        self.run_hook("claude", "Stop", {"transcript_path": t})
        self.assertEqual(self.events()[0]["text"], "Fixed the bug.")

    def test_a_permission_question_is_needs_you_and_an_idle_reminder_is_nothing(self):
        self.assertIsNone(self.run_hook("claude", "Notification", {"notification_type": "idle_prompt"})["state"])
        self.run_hook("claude", "Notification", {"notification_type": "permission_prompt", "message": "Claude needs your permission to use Bash"})
        e = self.events()[0]
        self.assertEqual((e["kind"], e["text"]), ("needs_you", "Claude needs your permission to use Bash"))

    def test_a_failed_turn_is_stopped_with_the_reason_and_does_not_ring(self):
        self.run_hook("claude", "StopFailure", {"error": "rate_limit"})
        e = self.events()[0]
        self.assertEqual((e["kind"], e["why"], e["ring"]), ("stopped", "rate_limit", False))

    def test_a_new_prompt_means_what_it_had_was_seen(self):
        self.run_hook("claude", "Stop", {"last_assistant_message": "ok"})
        self.assertEqual(inbox.listing(base=self.tmp)["unread"], 1)
        self.assertEqual(self.run_hook("claude", "UserPromptSubmit", {"prompt": "next"})["state"], "working")
        self.assertEqual(inbox.listing(base=self.tmp)["unread"], 0)

    def test_codex_notify_and_a_bell(self):
        self.run_hook("codex", "notify", {"type": "agent-turn-complete", "last-assistant-message": "Applied the patch."})
        self.assertIsNone(self.run_hook("codex", "notify", {"type": "something-else"})["state"])
        self.run_hook("codex", "bell", {})
        kinds = [e["kind"] for e in self.events()]
        self.assertEqual(kinds, ["needs_you", "finished"])
        self.assertEqual(self.events()[1]["text"], "Applied the patch.")

    def test_main_reads_claude_from_stdin_and_codex_from_its_argument(self):
        with mock.patch.dict(os.environ, self.env), mock.patch.object(H, "tell_daemon", return_value={}):
            H.main(["claude", "Stop"], io.StringIO(json.dumps({"last_assistant_message": "a"})))
        with mock.patch.dict(os.environ, dict(self.env, DISPATCH_TERMINAL_SESSION="other123")), mock.patch.object(H, "tell_daemon", return_value={}):
            H.main(["codex", "notify", json.dumps({"type": "agent-turn-complete", "last-assistant-message": "b"})], io.StringIO(""))
        self.assertEqual([e["text"] for e in self.events()], ["b", "a"])

    def test_the_entry_with_terminal_takes_claude_s_event_from_the_hook_json_and_codex_s_notify(self):
        import hook
        with mock.patch.dict(os.environ, self.env), mock.patch.object(H, "tell_daemon", return_value={}):
            hook.main(["claude-code", "--terminal"], io.StringIO(json.dumps({"hook_event_name": "Stop", "last_assistant_message": "a"})))
        with mock.patch.dict(os.environ, dict(self.env, DISPATCH_TERMINAL_SESSION="other123")), mock.patch.object(H, "tell_daemon", return_value={}):
            hook.main(["codex", "--terminal", "notify", json.dumps({"type": "agent-turn-complete", "last-assistant-message": "b"})], io.StringIO(""))
        with mock.patch.dict(os.environ, dict(self.env, DISPATCH_TERMINAL_SESSION="third123")), mock.patch.object(H, "tell_daemon", return_value={}):
            hook.main(["opencode", "--terminal", "idle"], io.StringIO(json.dumps({"text": "c"})))
        self.assertEqual([e["text"] for e in self.events()], ["c", "b", "a"])
        self.assertEqual({e["agent"] for e in self.events()}, {"claude-code", "codex", "opencode"})

    def test_the_daemon_is_told_with_its_token(self):
        os.makedirs(os.path.join(self.tmp, "termd"))
        with open(os.path.join(self.tmp, "termd", "daemon.json"), "w") as f:
            json.dump({"port": 1, "token": "tok"}, f)
        seen = {}

        class Answer(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def urlopen(req, timeout=0):
            seen["url"], seen["method"] = req.full_url, req.get_method()
            return Answer(json.dumps({"ok": True, "info": {"title": "T"}}).encode())
        with mock.patch.object(H.urllib.request, "urlopen", urlopen):
            self.assertEqual(H.tell_daemon("abc12345", "finished"), {"title": "T"})
        self.assertEqual(seen["method"], "POST")
        self.assertIn("/turn?token=tok&session=abc12345&state=finished", seen["url"])

    def test_claude_settings_hold_the_four_hooks(self):
        p = C.write_terminal_settings(python="/usr/bin/python3", script="/a b/hook.py", base=self.tmp)
        with open(p) as f:
            hooks = json.load(f)["hooks"]
        self.assertEqual(set(hooks), {"UserPromptSubmit", "Stop", "StopFailure", "Notification"})
        self.assertEqual({g["hooks"][0]["command"] for gs in hooks.values() for g in gs}, {"/usr/bin/python3 '/a b/hook.py' claude-code --terminal"})
        self.assertTrue(C.write_terminal_settings().endswith("claude-settings.json"))
        # by default through the stable shim, which runs this hook.py
        import hooks_setup
        with open(C.write_terminal_settings()) as f:
            self.assertIn(hooks_setup.shim_path() + " claude-code --terminal", f.read())
        with open(hooks_setup.shim_path()) as f:
            self.assertIn(os.path.join(os.path.dirname(os.path.abspath(H.__file__)), "hook.py"), f.read())
        self.assertEqual(hooks["Notification"][0]["matcher"], "elicitation_dialog|permission_prompt")


    def test_opencode_turns_from_its_plugin(self):
        self.assertEqual(self.run_hook("opencode", "busy", {})["state"], "working")
        self.run_hook("opencode", "idle", {"text": "Looked at it.\nThe build passes."})
        self.run_hook("opencode", "asks", {"text": "Run npm test?"})
        self.run_hook("opencode", "error", {"error": "rate limited"})
        kinds = {e["kind"]: e for e in self.events()}
        self.assertEqual(kinds["finished"]["text"], "The build passes.")
        self.assertEqual(kinds["finished"]["agent"], "opencode")
        self.assertEqual(kinds["needs_you"]["text"], "Run npm test?")
        self.assertEqual(kinds["stopped"]["why"], "rate limited")
        self.assertIsNone(self.run_hook("opencode", "something-else", {})["state"])

    def test_opencode_plugin_is_a_file_next_to_the_daemon_not_a_config_folder(self):
        p = O.write_terminal_plugin(python="/usr/bin/python3", script="/a b/hook.py", base=self.tmp)
        self.assertEqual(p, os.path.join(self.tmp, "termd", "opencode-turns.js"))
        with open(p) as f:
            src = f.read()
        self.assertIn('const PYTHON = "/usr/bin/python3";', src)
        self.assertIn('const SCRIPT = "/a b/hook.py";', src)
        self.assertIn('[SCRIPT, "opencode", "--terminal", event]', src)
        self.assertNotIn("__PYTHON__", src)

    def test_opencode_inline_config_keeps_the_person_s_own(self):
        cfg = json.loads(O.config_content("/x/opencode-turns.js", ""))
        self.assertEqual(cfg, {"plugin": ["file:///x/opencode-turns.js"]})
        cfg = json.loads(O.config_content("/x/opencode-turns.js", '{"model": "a/b", "plugin": ["theirs", "file:///x/opencode-turns.js"]}'))
        self.assertEqual(cfg, {"model": "a/b", "plugin": ["theirs", "file:///x/opencode-turns.js"]})
        self.assertEqual(json.loads(O.config_content("/x/p.js", "not json")), {"plugin": ["file:///x/p.js"]})

if __name__ == "__main__":
    unittest.main()
