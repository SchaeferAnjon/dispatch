# -*- coding: utf-8 -*-
import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

import activity
import agent_switch as AS
import lineage


def turns(n, size=50):
    out = []
    for i in range(n):
        out += [("用户", f"第{i}轮问题" + "问" * size), ("Agent", f"第{i}轮回答" + "答" * size)]
    return out


class TranscriptTurns(unittest.TestCase):
    """task-lj06.31: the window's note of shared browser pages came out as "Person: The following browser pages…"."""

    def test_only_what_the_person_wrote_is_a_users_turn(self):
        import json
        import summarize
        pages = ("The following browser pages are currently shared with you and can be interacted with using the browser tools:\n\n"
                 "[15e0dffc-dfb6-425b-b81f-f632e4d4e434] To-Do List (file:///tmp/todo/index.html) (not visible)")
        msgs = [{"role": "user", "text": "Make the Add button blue."}, {"role": "user", "text": pages},
                {"role": "assistant", "text": "It is blue already."},
                {"role": "user", "text": "Now add a footer.\n\n" + pages}, {"role": "user", "text": "<system-reminder>x</system-reminder>"},
                # Codex gets the note in the same message, as a bulleted list with what is open but not shared
                {"role": "user", "text": "And a header.\n\nThe following browser pages are currently shared with you and can be interacted with using the browser tools:\n"
                                         "- [c7d313e3-ab39-490c-8ca7-8ba5ae955419] To-Do List (file:///tmp/todo/index.html) (active)\n\n1 page is open but not shared.\n"
                                         "Use the 'open_browser_page' tool to open a new page."},
                {"role": "user", "text": "a hook said this", "synthetic": True}, {"role": "assistant", "text": "Footer added."}]
        out = SimpleNamespace(returncode=0, stdout=json.dumps({"messages": msgs, "meta": {}}), stderr="")
        with patch("subprocess.run", return_value=out):
            got, _, _ = summarize.transcript_turns("opencode:ses_x")
        self.assertEqual(got, [("User", "Make the Add button blue."), ("Agent", "It is blue already."), ("User", "Now add a footer."), ("User", "And a header."), ("Agent", "Footer added.")])
        msg, _ = AS.first_message(got, "opencode", "codex", model_call=lambda m: self.fail("nothing to summarize"))
        self.assertNotIn("browser pages", msg)


class FirstMessage(unittest.TestCase):
    def test_an_earlier_hand_over_is_quoted_as_its_context_without_its_go_on(self):
        first, _ = AS.first_message([("User", "Reply with exactly: READY"), ("Agent", "READY")], "codex", "opencode")
        msg, _ = AS.first_message([("User", first), ("Agent", "Nothing pending.")], "opencode", "codex")
        self.assertEqual(msg.count("Go on with:") + msg.count("接着做："), 1, msg)
        self.assertEqual(msg.count("This conversation moved from") + msg.count("这段对话从"), 1, msg)
        self.assertIn("Reply with exactly: READY", msg)
        self.assertIn("Nothing pending.", msg)
        # the person's own words that only mention a move stay theirs
        self.assertEqual(AS.unwrap_handovers([("User", "Why did this conversation move?")]), [("User", "Why did this conversation move?")])

    def test_short_conversation_is_verbatim_and_names_both_agents(self):
        msg, info = AS.first_message(turns(2), "claude-code", "codex", model_call=lambda m: self.fail("nothing to summarize"))
        self.assertTrue(msg.startswith("这段对话从 Claude Code 换到了 Codex。之前的上下文："))
        self.assertIn("第0轮问题", msg); self.assertIn("第1轮回答", msg)
        self.assertIn("\n\n接着做：", msg)
        self.assertIn("用户：第0轮问题", msg)
        for english in ("Continue", "Previous context", "User", "verbatim", "Summary"):
            self.assertNotIn(english, msg)  # one language throughout, the summary's
        self.assertEqual((info["recent_rounds"], info["summarized_rounds"]), (2, 0))

    def test_last_six_rounds_verbatim_and_earlier_ones_summarized(self):
        seen = {}

        def model(material):
            seen["m"] = material
            return "早先定了用 sqlite。", "fake:model"
        msg, info = AS.first_message(turns(10), "codex", "claude-code", model_call=model)
        self.assertIn("第3轮问题", seen["m"]); self.assertNotIn("第4轮问题", seen["m"])
        self.assertIn("更早 4 轮的摘要\n早先定了用 sqlite。", msg)
        self.assertIn("最近 6 轮原文", msg)
        self.assertIn("第4轮问题", msg); self.assertIn("第9轮回答", msg); self.assertNotIn("第3轮问题", msg)
        self.assertTrue(msg.startswith("这段对话从 Codex 换到了 Claude Code"))
        self.assertEqual((info["summary_by"], info["summarized_rounds"]), ("fake:model", 4))

    def test_never_longer_than_the_limit(self):
        for n, size in ((3, 5000), (30, 3000), (200, 400)):
            msg, info = AS.first_message(turns(n, size), "claude-code", "codex", model_call=lambda m: ("摘" * 5000, "x"))
            self.assertLessEqual(len(msg), AS.MAX_CHARS)
            self.assertEqual(info["chars"], len(msg))
            self.assertTrue(msg.rstrip().endswith(AS.DEFAULT_NEXT))
            self.assertIn(f"第{n - 1}轮问题", msg)  # the latest round survives any cut

    def test_summary_model_failure_falls_back_to_the_users_words(self):
        def broken(material):
            raise RuntimeError("quota")
        with patch("sys.stderr", io.StringIO()):
            msg, info = AS.first_message(turns(8), "claude-code", "codex", model_call=broken)
        self.assertEqual(info["summary_by"], "excerpt")
        self.assertIn("用户说：第0轮问题", msg)

    def test_custom_next_step(self):
        msg, _ = AS.first_message(turns(1), "claude-code", "codex", next_step="把测试补上")
        self.assertTrue(msg.endswith("接着做：把测试补上"))

    def test_model_change_line_is_english(self):
        import contextlib
        from types import SimpleNamespace

        class C:
            def request(self, *a, **k):
                return {"model": "sonnet", "effort": "high"}
        out = io.StringIO()
        with patch.object(AS.D, "chat_client", lambda: contextlib.nullcontext(C())), \
             patch.object(AS.D, "chat_target", lambda c, t: "claude-code:abc"), contextlib.redirect_stdout(out):
            AS.set_model(SimpleNamespace(text="sonnet", model="", extra="--effort high", target="abc", json=False))
        self.assertEqual(out.getvalue().strip(), "claude-code:abc: Next turn uses sonnet (effort high)")


class FakeClient:
    def __init__(self, rows):
        self.rows, self.calls = rows, []

    def __enter__(self):
        return self

    def __exit__(self, *e):
        pass

    def new_id(self):
        return "m1"

    def request(self, cmd, timeout=60, **f):
        self.calls.append((cmd, f))
        if cmd == "list":
            return {"sessions": self.rows}
        if cmd == "open":
            return {"ev": "opened", "session": "codex:new-thread", "model": f.get("model", "gpt-x")}
        if cmd == "close":
            return {"ev": "closed"}
        if cmd == "send":
            return {"ev": "turn_started", "turn_id": "t1"}
        if cmd == "set_model":
            return {"ev": "state", "model": f["model"]}
        raise AssertionError(cmd)


class Switch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = os.path.join(self.tmp.name, "proj")
        os.mkdir(self.cwd)
        self.dd = os.path.join(self.tmp.name, "dd")
        os.mkdir(self.dd)
        self.patches = [patch.object(AS.D, "DISPATCH_DIR", self.dd),
                        patch("summarize.transcript_turns", return_value=(turns(3), {"cwd": self.cwd}, "v1")),
                        patch.object(AS.D, "chat_turn", return_value={"prompt_sent": True, "status": "idle", "output": "接着答了", "warning": ""})]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def args(self, **kw):
        return SimpleNamespace(**{"op": "switch", "target": "claude-code:abc", "to": "codex", "model": "", "prompt": "", "json": True, "wait": True, "timeout": 1000, **kw})

    def run_switch(self, client, **kw):
        buf = io.StringIO()
        with patch.object(AS, "chat_rows", return_value=client.rows), patch.object(AS.D, "chat_client", return_value=client), redirect_stdout(buf):
            AS.cmd(self.args(**kw))
        return buf.getvalue()

    def test_opens_codex_in_the_same_folder_records_lineage_and_closes_the_original(self):
        activity.set_preferences(self.dd, "claude-code:abc", {"title_override": "修登录"})
        c = FakeClient([{"session": "claude-code:abc", "cwd": self.cwd, "lifecycle": "idle", "task": "task-1", "permission_mode": "acceptEdits"}])
        out = self.run_switch(c, model="gpt-5.5")
        opened = next(f for cmd, f in c.calls if cmd == "open")
        self.assertEqual((opened["agent"], opened["cwd"], opened["model"], opened["task"], opened["permission_mode"]), ("codex", self.cwd, "gpt-5.5", "task-1", "acceptEdits"))
        self.assertIn(("close", {"session": "claude-code:abc"}), c.calls)
        sent = AS.D.chat_turn.call_args.args
        self.assertEqual(sent[1], "codex:new-thread")
        self.assertTrue(sent[2].startswith("这段对话从 Claude Code 换到了 Codex"))
        prefs = activity.session_preferences(self.dd)
        self.assertEqual(prefs["codex:new-thread"]["switched_from"], "claude-code:abc")
        self.assertEqual(prefs["codex:new-thread"]["title_override"], "修登录")
        self.assertEqual(prefs["claude-code:abc"]["switched_to"], "codex:new-thread")
        self.assertEqual(prefs["claude-code:abc"]["title_override"], "Switched to Codex: 修登录")
        self.assertIn('"closed_original": true', out)
        # lineage sees both directions
        self.assertEqual(lineage.switch_links.__module__, "lineage")
        with patch.object(lineage.D, "DISPATCH_DIR", self.dd):
            links = lineage.switch_links()
        self.assertEqual(links["new-thread"], ("abc", ""))
        self.assertEqual(links["abc"], ("", "new-thread"))

    def test_ide_session_only_returns_the_first_message(self):
        c = FakeClient([])
        live = [{"agent": "claude-code", "session_id": "abc", "cwd": self.cwd, "title": "IDE 里的", "source": "ide"}]
        with patch.object(AS.D, "live_sessions", return_value=live):
            out = self.run_switch(c, model="gpt-5.5")
        import json
        res = json.loads(out)
        self.assertEqual({k: res[k] for k in ("cwd", "agent", "model")}, {"cwd": self.cwd, "agent": "codex", "model": "gpt-5.5"})
        self.assertTrue(res["first_message"].startswith("这段对话从 Claude Code 换到了 Codex"))
        # task-6degw: the window sends it as the new session's first message; the board's note-taker leaves it alone
        import own_prompts
        self.assertTrue(own_prompts.is_own(res["first_message"]))
        self.assertEqual([cmd for cmd, _ in c.calls], [])  # no session opened, nothing closed
        self.assertEqual(activity.session_preferences(self.dd), {})
        AS.D.chat_turn.assert_not_called()

    def test_opencode_window_session_hands_over_its_own_transcript(self):
        # the window's id is the agent host's; OpenCode's transcript goes by its ses_… (ide_sessions.transcript_key)
        c = FakeClient([])
        live = [{"agent": "opencode", "session_id": "5e0f7a2c-1111", "cwd": self.cwd, "title": "OpenCode 里的", "source": "ide"}]
        import json
        with patch.object(AS.D, "live_sessions", return_value=live), patch("ide_sessions.transcript_key", return_value="opencode:ses_2c4f9a1b3effe") as tk:
            res = json.loads(self.run_switch(c, target="opencode:5e0f7a2c-1111", to="claude"))
        tk.assert_called_with("opencode:5e0f7a2c-1111")
        import summarize
        summarize.transcript_turns.assert_called_with("opencode:ses_2c4f9a1b3effe")
        self.assertEqual((res["agent"], res["from"]), ("claude-code", "opencode:5e0f7a2c-1111"))
        self.assertTrue(res["first_message"].startswith("这段对话从 OpenCode 换到了 Claude Code"))
        # and the other way: a Claude Code window session handed to OpenCode
        live = [{"agent": "claude-code", "session_id": "abc", "cwd": self.cwd, "title": "IDE 里的", "source": "ide"}]
        with patch.object(AS.D, "live_sessions", return_value=live), patch("ide_sessions.transcript_key", return_value=None):
            res = json.loads(self.run_switch(c, to="opencode"))
        self.assertEqual(res["agent"], "opencode")
        self.assertTrue(res["first_message"].startswith("这段对话从 Claude Code 换到了 OpenCode"))
        self.assertEqual([cmd for cmd, _ in c.calls], [])

    def test_refuses_a_running_original_and_the_same_agent(self):
        c = FakeClient([{"session": "claude-code:abc", "cwd": self.cwd, "lifecycle": "running"}])
        with self.assertRaises(SystemExit) as e:
            self.run_switch(c)
        self.assertIn("still running", str(e.exception))
        c = FakeClient([{"session": "claude-code:abc", "cwd": self.cwd, "lifecycle": "idle"}])
        with self.assertRaises(SystemExit) as e:
            self.run_switch(c, to="claude")
        self.assertIn("already uses", str(e.exception))

    def test_model_subcommand_sends_set_model(self):
        c = FakeClient([{"session": "claude-code:abc", "cwd": self.cwd, "lifecycle": "idle"}])
        buf = io.StringIO()
        with patch.object(AS.D, "chat_client", return_value=c), redirect_stdout(buf):
            AS.cmd(SimpleNamespace(op="model", target="abc", text="sonnet", model="", extra="", json=True))
        self.assertIn(("set_model", {"session": "claude-code:abc", "model": "sonnet"}), c.calls)
        self.assertIn('"model": "sonnet"', buf.getvalue())


class Caps(unittest.TestCase):
    def test_hello_says_every_agent_can_change_model(self):
        import chatd
        with patch.object(chatd, "_probe", lambda agent: {"available": True, "supported": True}):
            agents = chatd.hello()["agents"]
        self.assertEqual({a: "set_model" in v["capabilities"] for a, v in agents.items()}, {"claude-code": True, "codex": True, "opencode": True})


if __name__ == "__main__":
    unittest.main()
