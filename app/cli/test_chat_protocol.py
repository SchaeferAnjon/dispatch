# -*- coding: utf-8 -*-
import json
import os
import re
import unittest

import chat_protocol as cp

WINDOWS_READY = True
HERE = os.path.dirname(os.path.abspath(__file__))


class Keys(unittest.TestCase):
    def test_key_matches_activity_key_shape(self):
        self.assertEqual(cp.session_key("claude-code", "5f1c0d4e-1"), "claude-code:5f1c0d4e-1")
        self.assertEqual(cp.split_key("codex:019a-thread"), ("codex", "019a-thread"))
        for bad in ("pi:abc", "claude-code:", "claude-code:a b", ""):
            with self.assertRaises(cp.ChatError):
                cp.split_key(bad)

    def test_versions(self):
        self.assertEqual(cp.parse_version("2.1.282 (Claude Code)"), (2, 1, 282))
        self.assertEqual(cp.parse_version("codex-cli 0.157.0"), (0, 157, 0))
        self.assertEqual(cp.parse_version("nope"), ())
        import engines
        self.assertTrue(cp.version_ok((2, 1, 282), engines.get("claude").chat_min_version))
        self.assertFalse(cp.version_ok((), engines.get("claude").chat_min_version))
        self.assertFalse(cp.version_ok((0, 150, 9), engines.get("codex").chat_min_version))


class Commands(unittest.TestCase):
    def test_valid_commands(self):
        self.assertEqual(cp.validate_command({"cmd": "hello"}), "hello")
        self.assertEqual(cp.validate_command({"cmd": "open", "request_id": "r1", "agent": "codex", "cwd": "/x"}), "open")
        self.assertEqual(cp.validate_command({"cmd": "send", "session": "claude-code:abc", "message_id": "m1", "text": "hi", "mode": "interrupt"}), "send")
        self.assertEqual(cp.validate_command({"cmd": "permission", "session": "codex:abc", "permission_id": "p1", "decision": "allow_session"}), "permission")

    def test_rejections_name_the_field(self):
        for obj, code, hint in (
            ({"cmd": "nope"}, "bad_request", "unknown command"),
            ({"cmd": "send", "session": "claude-code:abc"}, "bad_request", "missing"),
            ({"cmd": "send", "session": "claude-code:abc", "message_id": "m", "text": "x", "extra": 1}, "bad_request", "unknown field"),
            ({"cmd": "send", "session": "claude-code:abc", "message_id": "m", "text": "x" * (cp.TEXT_LIMIT + 1)}, "too_large", "over"),
            ({"cmd": "send", "session": "claude-code:abc", "message_id": "m", "text": "  "}, "bad_request", "empty"),
            ({"cmd": "permission", "session": "codex:abc", "permission_id": "p", "decision": "maybe"}, "bad_request", "decision"),
            ({"cmd": "set_permission_mode", "session": "codex:abc", "mode": "yolo"}, "invalid_model", "mode"),
            ({"cmd": "open", "request_id": "r", "agent": "pi", "cwd": "/x"}, "bad_request", "agent"),
            ("not an object", "bad_request", "object"),
        ):
            with self.assertRaises(cp.ChatError) as cm:
                cp.validate_command(obj)
            self.assertEqual(cm.exception.code, code, obj)
            self.assertIn(hint, str(cm.exception))

    def test_note_needs_a_session_and_non_empty_text(self):
        self.assertEqual(cp.validate_command({"cmd": "note", "session": "claude-code:abc", "text": "你撤销了 a.py 第 1 处"}), "note")
        self.assertEqual(cp.COMMANDS["note"]["reply"], "system")
        for obj, code, hint in (
            ({"cmd": "note", "session": "claude-code:abc", "text": " \n "}, "bad_request", "empty"),
            ({"cmd": "note", "session": "claude-code:abc", "text": "x" * (cp.TEXT_LIMIT + 1)}, "too_large", "over"),
            ({"cmd": "note", "session": "claude-code:abc"}, "bad_request", "missing"),
            ({"cmd": "note", "session": "claude-code:abc", "text": "x", "kind": "undo"}, "bad_request", "unknown field"),
        ):
            with self.assertRaises(cp.ChatError) as cm:
                cp.validate_command(obj)
            self.assertEqual(cm.exception.code, code, obj)
            self.assertIn(hint, str(cm.exception))

    def test_every_command_names_its_reply_event(self):
        for name, spec in cp.COMMANDS.items():
            for reply in spec["reply"].split("|"):
                self.assertIn(reply, cp.EVENTS, name)


class Events(unittest.TestCase):
    def test_emitter_stamps_seq_ts_session(self):
        lines = []
        em = cp.Emitter(lines.append)
        em.emit("hello", protocol=1)
        em.bound("claude-code:abc")("text_delta", turn_id="t1", text="hi")
        a, b = (json.loads(x) for x in lines)
        self.assertEqual((a["ev"], a["seq"]), ("hello", 1))
        self.assertNotIn("session", a)
        self.assertEqual((b["ev"], b["seq"], b["session"], b["text"]), ("text_delta", 2, "claude-code:abc", "hi"))
        self.assertNotIn("\n", lines[1])
        with self.assertRaises(ValueError):
            em.emit("not_an_event")

    def test_error_event_carries_code_and_request(self):
        e = cp.ChatError("writer_conflict", "TUI holds it", fatal=True).event(session="claude-code:abc", request_id="r9")
        self.assertEqual(e, {"ev": "error", "code": "writer_conflict", "message": "TUI holds it", "fatal": True, "session": "claude-code:abc", "request_id": "r9"})
        self.assertEqual(cp.ChatError("made_up", "x").code, "bad_request")

    def test_truncate_keeps_head_and_tail(self):
        text, cut = cp.truncate_output("a" * 100 + "b" * 100, limit=120)
        self.assertTrue(cut)
        self.assertTrue(text.startswith("a") and text.endswith("b"))
        self.assertIn("characters cut", text)
        self.assertEqual(cp.truncate_output("short"), ("short", False))

    def test_tool_kinds(self):
        self.assertEqual([cp.tool_kind(n) for n in ("Bash", "Edit", "Read", "Grep", "Task", "WebFetch", "AskUserQuestion", "mcp__x")],
                         ["shell", "edit", "read", "search", "agent", "web", "question", "other"])

    def test_step_phrase_cases(self):
        # The same cases chatProtocol.test.ts reads: both sides say the same sentence.
        with open(os.path.join(HERE, "..", "src", "stepPhrase.cases.json"), encoding="utf-8") as f:
            cases = json.load(f)
        self.assertGreater(len(cases), 15)
        for c in cases:
            self.assertEqual(cp.step_phrase(c["name"], c["input"]), c["want"], c)
        self.assertEqual(cp.step_phrase("Edit", None), "Editing a file")
        self.assertEqual(cp.command_brief("cd 'my dir' ; make"), "make")

    def test_child_env_drops_agent_markers(self):
        env = cp.child_env({"PATH": "/bin", "CLAUDECODE": "1", "CLAUDE_CODE_CHILD_SESSION": "1", "CODEX_THREAD_ID": "t", "DISPATCH_CALLER": "x", "HOME": "/h"})
        self.assertEqual(env, {"PATH": "/bin", "HOME": "/h"})


class MirrorsTypeScript(unittest.TestCase):
    """The TS file must carry the same vocabularies; a rename on one side shows up here."""

    def setUp(self):
        self.ts = open(os.path.join(HERE, "..", "src", "chatProtocol.ts"), encoding="utf-8").read()

    def ts_list(self, name):
        m = re.search(r"export const %s = \[(.*?)\] as const;" % name, self.ts, re.S)
        self.assertIsNotNone(m, name)
        return tuple(re.findall(r'"([^"]+)"', m.group(1)))

    def test_vocabularies_agree(self):
        self.assertEqual(self.ts_list("LIFECYCLES"), cp.LIFECYCLES)
        self.assertEqual(self.ts_list("DECISIONS"), cp.DECISIONS)
        self.assertEqual(self.ts_list("PERMISSION_KINDS"), cp.PERMISSION_KINDS)
        self.assertEqual(self.ts_list("TOOL_KINDS"), cp.TOOL_KINDS)
        self.assertEqual(self.ts_list("ERROR_CODES"), cp.ERROR_CODES)
        self.assertEqual(self.ts_list("CAPABILITIES"), cp.CAPABILITIES)
        self.assertEqual(self.ts_list("CLOSE_REASONS"), cp.CLOSE_REASONS)
        self.assertEqual(self.ts_list("PERMISSION_MODES"), cp.PERMISSION_MODES)
        self.assertEqual(self.ts_list("COMMAND_NAMES"), tuple(cp.COMMANDS))
        self.assertEqual(self.ts_list("EVENT_NAMES"), cp.EVENTS)
        self.assertIn('EVENT_ALL = "%s"' % cp.EVENT_ALL, self.ts)


if __name__ == "__main__":
    unittest.main()
