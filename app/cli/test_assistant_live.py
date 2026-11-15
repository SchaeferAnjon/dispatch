# -*- coding: utf-8 -*-
"""assistant_live.py: the Assistant's picture of running sessions, reading a session and messaging it."""
import json
import os
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import assistant_live as L  # noqa: E402
import tasks_view as TV  # noqa: E402


def row(sid, agent="claude-code", state="idle", project="kanban", **kw):
    r = {"agent": agent, "session_id": sid, "cwd": f"/Users/me/Projects/{project}", "project": project, "state": state, "attention": None,
         "alive": True, "last_at": 1000.0, "source_kind": "terminal", "source_app": "Ghostty", "host": "local", "host_name": "小蓝"}
    r.update(kw)
    return r


def ide_row(sid, **kw):
    return row(sid, source="ide", ide_key=f"claude:/{sid}", source_app="Dispatch IDE Agents", source_kind="editor", **kw)


def fake_d(live=(), hosts=(), peers=None, index=None):
    peers = peers or {}
    return types.SimpleNamespace(
        HOME="/Users/me", DISPATCH_DIR="/nowhere", live_sessions=lambda local_only=False: [dict(s) for s in live],
        hosts=lambda: [dict(h) for h in hosts], local_host_name=lambda: "小蓝", debug=lambda where, e: None,
        load_index=lambda: index or {}, _mod=__import__,
        remote_dispatch=lambda h, args, ttl, timeout=12, background=False: peers.get((h["id"], tuple(args))))


class Words(unittest.TestCase):
    def test_a_scratch_folder_is_left_out_unless_it_is_a_project(self):
        self.assertTrue(L._temp("/tmp/scratch"))
        self.assertTrue(L._temp("/private/var/folders/x/y"))
        self.assertFalse(L._temp("/Users/a/Projects/shop"))
        self.assertFalse(L._temp("/tmp/lab/home/Projects/shop/sub", ["/tmp/lab/home/Projects/shop"]))
        self.assertTrue(L._temp("/tmp/lab/home/Projects/shopping", ["/tmp/lab/home/Projects/shop"]))

    def test_tool_phrases_are_plain(self):
        self.assertEqual(L.tool_phrase("Edit", {"file_path": "/a/b/report.py"}), "Editing report.py")
        self.assertEqual(L.tool_phrase("Read", {"file_path": "/a/b/notes.md"}), "Reading notes.md")
        self.assertEqual(L.tool_phrase("Grep", {"pattern": "x"}), "Searching the code")
        self.assertEqual(L.tool_phrase("Bash", {"command": "cd app && npm test"}), "Running the tests")
        self.assertEqual(L.tool_phrase("Bash", {"command": "git commit -m x"}), "Saving work with git")
        self.assertEqual(L.tool_phrase("Bash", {"command": "ls", "description": "List the files"}), "List the files")
        self.assertEqual(L.tool_phrase("Bash", {"command": "echo hi"}), "Running echo hi")
        self.assertEqual(L.tool_phrase("Task", {}), "Handing work to a helper agent")
        self.assertEqual(L.tool_phrase("Mystery", {}), "Using Mystery")
        self.assertEqual(L.tool_phrase("SendMessage", {}), "Following a helper agent")
        self.assertEqual(L.tool_phrase("mcp__plugin_playwright__browser_click", {}), "Using browser click")
        self.assertEqual(L.tool_phrase("exec_command", {"cmd": ["pytest", "-q"]}), "Running the tests")

    def test_tail_facts_claude_and_codex(self):
        with tempfile.TemporaryDirectory() as d:
            c = os.path.join(d, "c.jsonl")
            lines = [{"type": "user", "message": {"content": "go"}},
                     {"type": "assistant", "message": {"content": [{"type": "text", "text": "I will **fix** `it`"}, {"type": "tool_use", "name": "Edit", "input": {"file_path": "/x/app.py"}}]}}]
            open(c, "w").write("\n".join(json.dumps(x) for x in lines))
            self.assertEqual(L.tail_facts(c, "claude-code"), ("Editing app.py", "I will fix it"))
            x = os.path.join(d, "x.jsonl")
            lines = [{"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Done."}]}},
                     {"type": "response_item", "payload": {"type": "function_call", "name": "shell", "arguments": json.dumps({"command": ["npm", "test"]})}}]
            open(x, "w").write("\n".join(json.dumps(y) for y in lines))
            self.assertEqual(L.tail_facts(x, "codex"), ("Running the tests", "Done."))
            self.assertEqual(L.tail_facts(os.path.join(d, "none.jsonl"), "codex"), ("", ""))

    def test_status_key_link_and_sendability(self):
        self.assertEqual(L.status_of(row("a", state="working")), "working")
        self.assertEqual(L.status_of(row("a", state="idle", attention="input")), "waiting")
        self.assertEqual(L.status_of(row("a", state="unknown")), "idle")
        self.assertEqual(L.session_key(ide_row("abc")), "claude:/abc")
        self.assertEqual(L.session_key(row("abc")), "claude-code:abc")
        self.assertEqual(L.session_key(row("pid-9", probable_session_id="real-1")), "claude-code:real-1")
        self.assertEqual(L.session_link(ide_row("abc")), "agent-host-session://claude/abc")
        self.assertIsNone(L.session_link(row("abc")))
        self.assertEqual(L.can_send(ide_row("a")), (True, ""))
        ok, why = L.can_send(row("a"))
        self.assertFalse(ok)
        self.assertIn("terminal", why)
        self.assertEqual(L.can_send(row("a", source_kind="app")), (True, ""))
        self.assertFalse(L.can_send(row("a", agent="gemini", source_kind="app"))[0])


class Overview(unittest.TestCase):
    def setUp(self):
        self.orig = L.D
        self.tmp = tempfile.mkdtemp()
        self._home = os.environ.get("HOME")
        os.environ["HOME"] = self.tmp  # the Assistant's own folder is under HOME

    def tearDown(self):
        L.D = self.orig
        os.environ["HOME"] = self._home

    def test_rows_counts_task_and_the_assistants_own_session_left_out(self):
        issue = {"id": "task-1", "title": "Fix the login", "status": "in_progress", "created_at": "2026-10-01T10:00:00Z", "updated_at": "2026-10-01T10:00:00Z",
                 "labels": ["project:kanban", "session-origin:ses-work"], "assignee": "claude-code"}
        live = [row("ses-work", state="working", activity="Editing login.py", source="ide", ide_key="claude:/ses-work", source_kind="editor"),
                row("ses-wait", attention="input", ide_key="claude:/ses-wait", source="ide"),
                row("ses-idle", project="redraft"),
                row("ses-me", cwd=os.path.join(self.tmp, ".dispatch", "assistant"), project="assistant"),
                row("ses-tmp", cwd="/private/tmp/x/y", project="y"),
                row("pid-5", state="unknown", probable_session_id="ses-idle")]
        L.D = fake_d(live)
        with patch.object(TV, "board_export", lambda: [issue]), patch("waiting.collect", lambda *a, **k: {"items": [
                {"resource": "claude:/ses-wait", "kind": "approve", "phrase": "Allow running npm install"}]}):
            res = L.overview(local_only=True, now=2000.0)
        self.assertEqual([m["id"] for m in res["machines"]], ["local"])
        rows = res["machines"][0]["sessions"]
        self.assertEqual([r["id"] for r in rows], ["ses-wait", "ses-work", "ses-idle"])  # waiting first, no assistant, no tmp, no duplicate pid row
        wait, work, idle = rows
        self.assertEqual((wait["status"], wait["doing"]), ("waiting", "Allow running npm install"))
        self.assertEqual((work["status"], work["doing"], work["task"]["title"]), ("working", "Editing login.py", "Fix the login"))
        self.assertEqual(work["link"], "agent-host-session://claude/ses-work")
        self.assertTrue(work["can_send"])
        self.assertFalse(idle["can_send"])
        self.assertEqual(res["machines"][0]["counts"], {"working": 1, "waiting": 1, "idle": 1})
        self.assertEqual(res["totals"], {"working": 1, "waiting": 1, "idle": 1, "sessions": 3, "machines": 1})

    def test_another_mac_is_asked_and_offline_is_said(self):
        mini = {"id": "mini", "name": "mini", "ssh": "a@1.2.3.4"}
        peer_rows = {"sessions": [{"key": "claude-code:r1", "id": "r1", "agent": "claude-code", "agent_name": "Claude Code", "title": "T", "project": "poker",
                                   "cwd": "/x", "host": "local", "host_name": "mini", "status": "working", "status_label": "Working", "doing": "Running the tests",
                                   "said": "", "last_at": 5.0, "source": "", "where": "terminal", "task": None, "link": None, "can_send": False, "cannot_send": "", "failed": False}]}
        mach = types.SimpleNamespace(_safe=lambda fn, *a, default=None: fn(*a), reachable=lambda h: h["id"] == "mini", last_seen=lambda h, on, now: now if on else 7.0)
        d = fake_d([], hosts=[mini, {"id": "studio", "name": "studio", "ssh": "b@1.2.3.5"}], peers={("mini", ("assistant", "overview", "--local")): peer_rows})
        real = d._mod
        d._mod = lambda name: mach if name == "machines" else real(name)
        L.D = d
        with patch.object(TV, "board_export", lambda: []):
            res = L.overview(now=10.0)
        names = {m["id"]: m for m in res["machines"]}
        self.assertEqual(list(names), ["local", "mini", "studio"])
        self.assertTrue(names["mini"]["online"])
        self.assertEqual(names["mini"]["sessions"][0]["host"], "mini")
        self.assertEqual(names["mini"]["counts"]["working"], 1)
        self.assertFalse(names["studio"]["online"])
        self.assertEqual(names["studio"]["sessions"], [])
        self.assertEqual(res["totals"]["machines"], 3)

    def test_feed_has_finished_waiting_and_failed_newest_first(self):
        base = {"host": "local", "host_name": "小蓝", "project": "p", "agent": "claude-code", "agent_name": "Claude Code", "link": None, "title": ""}
        sessions = [dict(base, key="a", status="idle", said="Tests pass", last_at=9000.0),
                    dict(base, key="b", status="waiting", doing="Allow editing x", last_at=9500.0),
                    dict(base, key="c", status="idle", said="Old news", last_at=10.0),
                    dict(base, key="d", status="idle", failed=True, said="", last_at=8000.0),
                    dict(base, key="e", status="working", doing="Editing", last_at=9900.0)]
        ev = L.feed([{"sessions": sessions}], now=30000.0)
        self.assertEqual([(e["key"], e["kind"]) for e in ev], [("b", "waiting"), ("a", "finished"), ("d", "failed")])


class Sending(unittest.TestCase):
    def test_message_is_labelled_once(self):
        self.assertEqual(L.labelled("Run the tests"), "[From Assistant]\nRun the tests")
        self.assertEqual(L.labelled("[From Assistant]\nAlready"), "[From Assistant]\nAlready")
        with self.assertRaises(ValueError):
            L.labelled("   ")

    def test_chat_uri_is_base64url_of_the_session(self):
        self.assertEqual(L._chat_uri("claude:/abc"), "ahp-chat://default/Y2xhdWRlOi9hYmM")

    def test_into_the_agents_window_starts_a_turn_or_queues_behind_a_running_one(self):
        sent = []

        class Ahp:
            def __init__(self, entry):
                pass

            def notify(self, method, params):
                sent.append((method, params))

            def request(self, method, params):
                return {}

            def close(self):
                pass

        hit = ("Dispatch IDE", "/ud", {"uri": "claude:/abc"})
        fake_i = types.SimpleNamespace(endpoints=lambda ud: [{"endpoint": {}}], Ahp=Ahp)
        with patch.dict(sys.modules, {"ide_sessions": fake_i}):
            ok = L.send_ide(hit, "[From Assistant]\nhi", False, "claude:/assistant-1")
            queued = L.send_ide(hit, "[From Assistant]\nhi", True)
        self.assertTrue(ok["ok"] and queued["ok"])
        self.assertEqual(ok["how"], "started")
        self.assertEqual(queued["how"], "queued")
        a1, a2 = sent[0][1], sent[1][1]
        self.assertEqual(a1["channel"], "ahp-chat://default/Y2xhdWRlOi9hYmM")
        self.assertEqual(a1["action"]["type"], "chat/turnStarted")
        self.assertEqual(a1["action"]["message"], {"text": "[From Assistant]\nhi", "origin": {"kind": "user"},
                                                   "_meta": {"dispatch.from": "assistant", "vscode.chat.delegation": {"sourceSession": "claude:/assistant-1"}}})
        self.assertEqual(a2["action"]["message"]["_meta"], {"dispatch.from": "assistant"})  # no source known: the label is the text line only
        self.assertEqual(a2["action"]["type"], "chat/pendingMessageSet")
        self.assertEqual(a2["action"]["kind"], "queued")

    def test_no_running_editor_is_said_in_words(self):
        fake_i = types.SimpleNamespace(endpoints=lambda ud: [])
        with patch.dict(sys.modules, {"ide_sessions": fake_i}):
            r = L.send_ide(("Dispatch IDE", "/ud", {"uri": "claude:/abc"}), "x", False)
        self.assertFalse(r["ok"])
        self.assertIn("not running", r["note"])

    def test_a_terminal_session_is_refused_with_a_reason(self):
        import session_reply as R
        L.D = fake_d()
        fake_i = types.SimpleNamespace(find=lambda key, include_external=True: None)
        with patch.dict(sys.modules, {"ide_sessions": fake_i}), patch.object(R, "exact_ref", lambda d, sid, agent: {"agent": agent, "session_id": sid}), \
                patch.object(R, "terminal_holds", lambda d, ref: True):
            r = L.send("claude-code:abc", "hello")
        self.assertFalse(r["ok"])
        self.assertIn("terminal", r["note"])

    def test_turns_label_what_the_assistant_sent(self):
        msgs = [{"role": "user", "text": "[From Assistant]\nRun the tests", "ts": "t1"}, {"role": "assistant", "text": "All 12 pass", "ts": "t2"},
                {"role": "tool", "text": "x", "ts": "t3"}]
        L.D = fake_d()
        with patch.object(L, "_ref_of", lambda key: {"agent": "claude-code"}), patch.object(L.D, "read_session_detail", lambda ref: {"messages": msgs, "meta": {"agent": "claude-code", "title": "T", "project": "p", "cwd": "/x"}}, create=True):
            res = L.turns("claude-code:abc", 3)
        self.assertEqual([(t["role"], t["from_assistant"], t["text"]) for t in res["turns"]], [("user", True, "Run the tests"), ("assistant", False, "All 12 pass")])
        self.assertEqual(res["session"]["agent_name"], "Claude Code")


if __name__ == "__main__":
    unittest.main()
