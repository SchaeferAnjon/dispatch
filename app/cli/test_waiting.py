# -*- coding: utf-8 -*-
"""waiting.py: `dispatch waiting`, the rows behind the Agents window's Waiting for you.

The Agents-window part runs on test_ide_sessions' fixture db and a fake Agent Host client that
answers listSessions and subscribe the way the real host did (VS Code 1.139.1 / Dispatch IDE,
2026-09-27: a Claude session asking to write /tmp/wfy/outside2.txt, its snapshot copied below).
"""
import argparse
import hashlib
import io
import json
import os
import sys
import time
import types
import unittest
import unittest.mock
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ide_sessions as I  # noqa: E402
import waiting as W  # noqa: E402
from test_ide_sessions import CLAUDE_ID, EXT_ID, Fixture  # noqa: E402

CHAT = "ahp-chat://default/Y2xhdWRlOi82MjM2"
# the real inputNeeded entry (trimmed ids)
WRITE_REQUEST = {
    "id": "toolConfirmation:x", "kind": "toolConfirmation", "chat": CHAT, "turnId": "request_0ea8",
    "toolCall": {
        "status": "pending-confirmation", "toolCallId": "toolu_01Uh", "toolName": "Write", "displayName": "Write file",
        "invocationMessage": {"markdown": "Edit [outside2.txt](file:///tmp/wfy/outside2.txt)"},
        "toolInput": "{\n  \"file_path\": \"/tmp/wfy/outside2.txt\",\n  \"content\": \"hello2\"\n}",
        "confirmationTitle": "Edit file?",
        "options": [{"id": "allow-session", "label": "Allow in this Session", "kind": "approve", "group": 1},
                    {"id": "allow-once", "label": "Allow Once", "kind": "approve"},
                    {"id": "skip", "label": "Skip", "kind": "deny", "group": 2}],
    },
}
QUESTION_REQUEST = {"id": "chatInput:y", "kind": "chatInput", "chat": CHAT,
                    "request": {"id": "q1", "questions": [{"id": "a", "kind": "single-select", "title": "Drafts", "message": "Which of the two drafts should go out?"}]}}

SECOND = "5e1c0a55-0000-4000-8000-000000000005"


class FakeClient:
    """Stands in for ide_sessions.Ahp: listSessions from `items`, subscribe from `states`."""

    def __init__(self, items, states, log):
        self.items, self.states, self.log = items, states, log

    def request(self, method, params):
        self.log.append((method, params))
        if method == "listSessions":
            return {"items": self.items}
        if method == "subscribe":
            st = self.states.get(params["channel"])
            return {"snapshot": {"resource": params["channel"], "state": st, "fromSeq": 1}} if st is not None else {}
        return None

    def notify(self, method, params):
        self.log.append((method, params))

    def close(self):
        pass


def live(uri, status, title=""):
    return {"resource": uri, "provider": uri.split(":")[0], "title": title, "status": status,
            "createdAt": "2026-09-27T09:00:00.000Z", "modifiedAt": "2026-09-27T10:00:00.000Z"}


class Base(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture(time.time() * 1000)
        self.env = os.environ.get("DISPATCH_IDE_USER_DATA_DIRS")
        os.environ["DISPATCH_IDE_USER_DATA_DIRS"] = self.fx.ud
        entries = os.path.join(self.fx.ud, "agent-host", "local-endpoint", "entries")
        os.makedirs(entries)
        with open(os.path.join(entries, hashlib.sha256(b"e").hexdigest() + ".json"), "w") as f:
            json.dump({"schemaVersion": 2, "pid": os.getpid(), "connectionToken": "t", "endpoint": {"type": "socket", "path": "/nonexistent"}}, f)
        self.log = []

    def tearDown(self):
        self.fx.close()
        if self.env is None:
            os.environ.pop("DISPATCH_IDE_USER_DATA_DIRS", None)
        else:
            os.environ["DISPATCH_IDE_USER_DATA_DIRS"] = self.env

    def connect(self, items, states=None):
        return lambda _e: FakeClient(items, states or {}, self.log)


class Phrases(unittest.TestCase):
    def test_approve_says_the_action_with_its_path(self):
        self.assertEqual(W.approve_phrase(WRITE_REQUEST["toolCall"]), "Edit /tmp/wfy/outside2.txt")
        self.assertEqual(W.approve_phrase({"toolInput": json.dumps({"command": "rm -rf build"}), "displayName": "Bash"}), "Wants to run rm -rf build")
        # a command waiting for permission has not run: not the tool row's "Running …" (Claude Code, OpenCode)
        self.assertEqual(W.approve_phrase({"toolName": "Bash", "invocationMessage": {"markdown": "Running `touch a.txt && ls a.txt`"},
                                           "toolInput": json.dumps({"command": "touch a.txt && ls a.txt"})}), "Wants to run touch a.txt && ls a.txt")
        self.assertEqual(W.approve_phrase({"toolName": "exec_command", "toolInput": json.dumps({"command": ["npm", "test"]})}), "Wants to run npm test")
        self.assertEqual(W.approve_phrase({"invocationMessage": "Running `make`"}), "Wants to run make")
        self.assertEqual(W.approve_phrase({"displayName": "Fetch"}), "Fetch")

    def test_question(self):
        self.assertEqual(W.question_phrase(QUESTION_REQUEST["request"]), "Which of the two drafts should go out?")
        self.assertEqual(W.question_phrase({"message": "Pick **one**"}), "Pick one")

    def test_allow_picks_the_one_time_option(self):
        self.assertEqual(W.option_id(WRITE_REQUEST["toolCall"], "approve"), "allow-once")
        self.assertEqual(W.option_id(WRITE_REQUEST["toolCall"], "deny"), "skip")
        self.assertIsNone(W.option_id({}, "approve"))

    def test_sentences_do_not_split_paths_or_numbers(self):
        self.assertEqual(W.sentences("把 token 写进 ~/.config/env.sh。然后重启 3.5 版。"), ["把 token 写进 ~/.config/env.sh。", "然后重启 3.5 版。"])
        self.assertEqual(W.last_sentence("Done. Two files changed in app/cli/x.py."), "Two files changed in app/cli/x.py.")
        self.assertEqual(W.first_sentence("Fixed the login redirect. Tests pass."), "Fixed the login redirect.")

    def test_clean_keeps_snake_case_and_cuts(self):
        self.assertEqual(W.clean("use `ai_search_by_item`"), "use ai_search_by_item")
        long = W.clean("x" * 500)
        self.assertEqual(len(long), W.PHRASE_MAX)
        self.assertTrue(long.endswith("…"))

    def test_task_phrase_skips_what_the_title_says(self):
        self.assertEqual(W.task_phrase("换一个 Claude 长期 token：跑 claude", "换一个 Claude 长期 token：跑 claude setup-token，写进 env.sh\n\n为什么"), "setup-token，写进 env.sh")
        self.assertEqual(W.task_phrase("登录 Tailscale", "登录 Tailscale\n\n在 Windows 上加入 tailnet。然后发我 IP。"), "在 Windows 上加入 tailnet。")
        self.assertEqual(W.task_phrase("给 Lena 发邮件", "附上 PDF。"), "附上 PDF。")
        self.assertEqual(W.task_phrase("x", ""), "")


class LastReply(unittest.TestCase):
    def test_last_sentence_of_the_whole_reply_not_the_preview(self):
        import tempfile
        long = "One. " * 100 + "Finished counting."
        with tempfile.TemporaryDirectory() as d:
            claude = os.path.join(d, "c.jsonl")
            with open(claude, "w") as f:
                f.write(json.dumps({"type": "user", "message": {"content": "count"}}) + "\n")
                f.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": long}]}}) + "\n")
                f.write(json.dumps({"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "text", "text": "sub agent. Noise."}]}}) + "\n")
            codex = os.path.join(d, "x.jsonl")
            with open(codex, "w") as f:
                f.write(json.dumps({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Checked. Two files changed."}]}}) + "\n")
            self.assertEqual(W.unread_phrase({"path": claude, "reply_preview": long[:280]}), "Finished counting.")
            self.assertEqual(W.unread_phrase({"path": codex}), "Two files changed.")
            self.assertEqual(W.unread_phrase({"path": claude, "unread_summary": "数完了。共 40 个。"}), "数完了。")
            self.assertEqual(W.unread_summary({"path": claude}), long)
            self.assertEqual(W.unread_summary({"path": claude, "unread_summary": "数完了。共 40 个。"}), "数完了。共 40 个。")
            self.assertEqual(W.unread_summary({"path": codex}), "Checked. Two files changed.")
            huge = "Complete response. " * 18000
            with open(codex, "w") as f:
                f.write(json.dumps({"type": "response_item", "payload": {"role": "assistant", "content": [{"type": "output_text", "text": huge}]}}) + "\n")
            self.assertEqual(W.unread_summary({"path": codex}), huge)
            self.assertEqual(W.unread_phrase({"path": os.path.join(d, "missing"), "reply_preview": "Short reply."}), "Short reply.")


class Ide(Base):
    def test_waiting_and_unread_sessions(self):
        items = [live(f"claude:/{CLAUDE_ID}", I.ST_INPUT_NEEDED, "修登录页的跳转"),
                 live(f"claude:/{SECOND}", I.ST_IDLE, "写周报"),                 # finished, not read
                 live(f"claude:/{EXT_ID}", I.ST_IDLE),                         # a terminal conversation the host found: not ours
                 live(f"codex:/{SECOND[:-1]}6", I.ST_IDLE | I.ST_READ),        # read
                 live(f"codex:/{SECOND[:-1]}7", I.ST_IN_PROGRESS),              # running
                 live(f"codex:/{SECOND[:-1]}8", I.ST_IDLE | I.ST_ARCHIVED)]     # archived
        scanned = W.ide_scan(connect=self.connect(items, {f"claude:/{CLAUDE_ID}": {"inputNeeded": [WRITE_REQUEST]}}))
        self.assertEqual([(r["session_id"], req is None) for r, req, _e in scanned], [(CLAUDE_ID, False), (SECOND, True)])
        data = W.collect(ide=scanned, held={}, activity_rows={f"claude-code:{SECOND}": {"unread_summary": "周报写好了，放在 docs/weekly.md。还差数据。"}}, issues=[])
        a, u = data["items"]
        self.assertEqual((a["kind"], a["phrase"], a["actions"], a["project"]), ("approve", "Edit /tmp/wfy/outside2.txt", ["allow", "deny", "open"], "我的 repo"))
        self.assertEqual((a["id"], a["resource"], a["session"]), (f"ide:claude:/{CLAUDE_ID}", f"claude:/{CLAUDE_ID}", f"claude-code:{CLAUDE_ID}"))
        self.assertEqual((u["kind"], u["phrase"], u["title"]), ("unread", "周报写好了，放在 docs/weekly.md。", "写周报"))
        self.assertEqual(u["summary"], "周报写好了，放在 docs/weekly.md。还差数据。")
        self.assertEqual(data["counts"], {"approve": 1, "decide": 0, "unread": 1, "only_you": 0, "only_you_recent": 0, "only_you_older": 0,
                                          "only_you_new": 0, "attention": 2, "all": 2})
        # the card's parts: the tool, the path it writes (outside the session's folder), how long it has waited
        self.assertEqual((a["tool"], a["arg"], a["path"], a["scope"]), ("Write", "/tmp/wfy/outside2.txt", "/tmp/wfy/outside2.txt", "outside_workspace"))
        self.assertEqual(a["stopped_at"], a["at"])

    def test_question_is_decide_and_client_work_is_not_a_prompt(self):
        client_exec = {"id": "c", "kind": "toolClientExecution", "chat": CHAT, "turnId": "t", "clientId": "x", "toolCall": {}}
        items = [live(f"claude:/{CLAUDE_ID}", I.ST_INPUT_NEEDED)]
        scanned = W.ide_scan(connect=self.connect(items, {f"claude:/{CLAUDE_ID}": {"inputNeeded": [client_exec, QUESTION_REQUEST]}}))
        it = W.ide_item(scanned[0][0], scanned[0][1])
        self.assertEqual((it["kind"], it["phrase"], it["actions"]), ("decide", "Which of the two drafts should go out?", ["open"]))

    def test_host_without_input_list_still_counts(self):
        scanned = W.ide_scan(connect=self.connect([live(f"claude:/{CLAUDE_ID}", I.ST_INPUT_NEEDED)]))
        it = W.ide_item(scanned[0][0], scanned[0][1])
        self.assertEqual((it["kind"], it["actions"]), ("decide", ["open"]))

    def test_allow_and_deny_dispatch_tool_call_confirmed_to_the_chat(self):
        items = [live(f"claude:/{CLAUDE_ID}", I.ST_INPUT_NEEDED)]
        connect = self.connect(items, {f"claude:/{CLAUDE_ID}": {"inputNeeded": [WRITE_REQUEST]}})
        scanned = W.ide_scan(connect=connect)
        res = W.ide_confirm(f"ide:claude:/{CLAUDE_ID}", True, scanned, connect)
        self.assertTrue(res["ok"], res)
        sent = [p for m, p in self.log if m == "dispatchAction"]
        self.assertEqual(sent[-1], {"channel": CHAT, "clientSeq": 1, "action": {"type": "chat/toolCallConfirmed", "turnId": "request_0ea8", "toolCallId": "toolu_01Uh",
                                                                                "approved": True, "confirmed": "user-action", "selectedOptionId": "allow-once"}})
        W.ide_confirm(f"ide:claude:/{CLAUDE_ID}", False, scanned, connect)
        sent = [p for m, p in self.log if m == "dispatchAction"]
        self.assertEqual(sent[-1]["action"], {"type": "chat/toolCallConfirmed", "turnId": "request_0ea8", "toolCallId": "toolu_01Uh", "approved": False, "reason": "denied", "selectedOptionId": "skip"})

    def test_allow_from_a_notice_answers_only_the_request_it_showed(self):
        items = [live(f"claude:/{CLAUDE_ID}", I.ST_INPUT_NEEDED)]
        connect = self.connect(items, {f"claude:/{CLAUDE_ID}": {"inputNeeded": [WRITE_REQUEST]}})
        scanned = W.ide_scan(connect=connect)
        res = W.ide_confirm(f"ide:claude:/{CLAUDE_ID}", True, scanned, connect, request="toolu_older")
        self.assertEqual((res["ok"], res["code"]), (False, "not_waiting"))
        self.assertEqual([p for m, p in self.log if m == "dispatchAction"], [])
        self.assertTrue(W.ide_confirm(f"ide:claude:/{CLAUDE_ID}", True, scanned, connect, request="toolu_01Uh")["ok"])

    def test_allow_on_something_no_longer_waiting(self):
        res = W.ide_confirm(f"ide:claude:/{CLAUDE_ID}", True, [], None)
        self.assertEqual((res["ok"], res["code"]), (False, "not_waiting"))

    def test_mark_read_dispatches_is_read_changed(self):
        items = [live(f"claude:/{SECOND}", I.ST_IDLE), live(f"claude:/{CLAUDE_ID}", I.ST_INPUT_NEEDED)]
        connect = self.connect(items, {f"claude:/{CLAUDE_ID}": {"inputNeeded": [WRITE_REQUEST]}})
        done = W.ide_mark_read(None, W.ide_scan(connect=connect), connect)
        self.assertEqual(done, [f"ide:claude:/{SECOND}"])  # Mark all read leaves the approval alone
        sent = [p for m, p in self.log if m == "dispatchAction"]
        self.assertEqual(sent, [{"channel": f"claude:/{SECOND}", "clientSeq": 1, "action": {"type": "session/isReadChanged", "isRead": True}}])

    def test_mark_read_uses_the_action_connection_for_its_scan(self):
        connect = self.connect([live(f"claude:/{SECOND}", I.ST_IDLE)])
        done = W.ide_mark_read({f"ide:claude:/{SECOND}"}, connect=connect)
        self.assertEqual(done, [f"ide:claude:/{SECOND}"])
        self.assertTrue(any(m == "dispatchAction" for m, _ in self.log))

    def test_mark_read_does_not_report_success_after_a_scan_timeout(self):
        def failed_scan(*, connect, errors):
            errors.append("connectionToken=private-test-token: agent host timed out")
            return []
        with unittest.mock.patch.object(W, "ide_scan", side_effect=failed_scan):
            with self.assertRaisesRegex(OSError, "Try Mark read again") as raised:
                W.mark_read([f"ide:claude:/{SECOND}"])
            self.assertNotIn("private-test-token", str(raised.exception))

    def test_mark_all_read_marks_what_it_can_and_returns_what_it_could_not(self):
        connect = self.connect([live(f"claude:/{SECOND}", I.ST_IDLE)])
        real_scan = W.ide_scan

        def half_scan(*, connect, errors):
            errors.append("second window: timed out")
            return real_scan(connect=connect)
        failed = []
        with unittest.mock.patch.object(W, "ide_scan", side_effect=half_scan):
            done = W.ide_mark_read(None, connect=connect, failed=failed)
            self.assertEqual(done, [f"ide:claude:/{SECOND}"])
            self.assertEqual(failed[0]["windows"], 1)

        def partial(want, keep=None, failed=None):
            failed.append({"id": "", "windows": 1, "message": W.MARK_READ_RETRY})
            return [f"ide:claude:/{SECOND}"]
        failed = []
        with unittest.mock.patch.object(W, "ide_mark_read", side_effect=partial), \
             unittest.mock.patch.object(W, "D", unittest.mock.Mock(DISPATCH_DIR="/nowhere")), \
             unittest.mock.patch.object(W, "collect", return_value={"items": [
                 {"kind": "unread", "source": "chat", "id": "chat:codex:ccc", "session": "codex:ccc", "reply_id": "r1"}]}), \
             unittest.mock.patch("activity.acknowledge") as ack:
            done = W.mark_read(None, failed=failed)
        self.assertEqual(done, [f"ide:claude:/{SECOND}", "chat:codex:ccc"])  # the chat unread is marked too
        ack.assert_called_once()
        self.assertEqual(failed[0]["windows"], 1)

    def test_single_row_errors_only_when_its_window_is_unreadable(self):
        connect = self.connect([live(f"claude:/{SECOND}", I.ST_IDLE)])
        real_scan = W.ide_scan

        def half_scan(*, connect, errors):
            errors.append("second window: timed out")
            return real_scan(connect=connect)
        with unittest.mock.patch.object(W, "ide_scan", side_effect=half_scan):
            # found in the window that answered: marked, no error
            self.assertEqual(W.ide_mark_read({f"ide:claude:/{SECOND}"}, connect=connect), [f"ide:claude:/{SECOND}"])
            # not found anywhere that answered: it may be in the silent window
            with self.assertRaisesRegex(OSError, "Try Mark read again"):
                W.ide_mark_read({f"ide:claude:/{CLAUDE_ID}"}, connect=connect)


class Chat(unittest.TestCase):
    def test_chatd_permission_question_and_unread(self):
        held = {"claude-code:aaa": {"lifecycle": "waiting_permission", "cwd": "/p/kanban", "since": 100},
                "claude-code:bbb": {"lifecycle": "waiting_input", "cwd": "/p/TUTOR", "since": 90},
                "codex:ccc": {"lifecycle": "idle", "cwd": "/p/自媒体", "since": 80},
                "codex:ddd": {"lifecycle": "idle", "cwd": "/p/x", "since": 70}}
        rows = {"codex:ccc": {"title": "vlogger 数据接口", "unread": True, "reply_id": "123.0:ab", "reply_at": 123,
                              "reply_preview": "Checked the API. Finished, 2 files changed."},
                "codex:ddd": {"unread": False, "reply_id": "1:x"}}
        pending = {"claude-code:aaa": {"permission_id": "p1", "kind": "other", "summary": "Write ~/.gitconfig", "tool_name": "Write"},
                   "claude-code:bbb": {"permission_id": "p2", "kind": "question", "questions": [{"question": "Which draft goes out?"}]}}
        out = {it["session"]: it for it in W.chat_items(held, rows, pending.get)}
        self.assertEqual(set(out), {"claude-code:aaa", "claude-code:bbb", "codex:ccc"})
        self.assertEqual((out["claude-code:aaa"]["kind"], out["claude-code:aaa"]["phrase"], out["claude-code:aaa"]["actions"], out["claude-code:aaa"]["project"]),
                         ("approve", "Write ~/.gitconfig", ["allow", "deny", "open"], "kanban"))
        self.assertEqual((out["claude-code:bbb"]["kind"], out["claude-code:bbb"]["phrase"]), ("decide", "Which draft goes out?"))
        self.assertEqual((out["codex:ccc"]["kind"], out["codex:ccc"]["phrase"], out["codex:ccc"]["reply_id"]), ("unread", "Finished, 2 files changed.", "123.0:ab"))

    def test_chatd_waiting_without_its_replay_only_opens(self):
        out = W.chat_items({"claude-code:aaa": {"lifecycle": "waiting_permission", "cwd": "/p/k"}}, {}, lambda k: None)
        self.assertEqual((out[0]["kind"], out[0]["actions"]), ("approve", ["open"]))


class Board(unittest.TestCase):
    ISSUES = [
        {"id": "task-a", "title": "换 token", "status": "open", "labels": ["dispatch:needs-you", "project:kanban"], "description": "终端跑 claude setup-token。", "updated_at": "2026-09-27T08:00:00Z"},
        {"id": "task-b", "title": "给 Lena 发邮件", "status": "open", "assignee": "SchaeferAnjon", "labels": ["project:TUTOR"]},
        {"id": "task-c", "title": "Agent 在做", "status": "in_progress", "assignee": "SchaeferAnjon", "labels": []},
        {"id": "task-d", "title": "关掉了", "status": "closed", "labels": ["dispatch:needs-you"]},
        {"id": "task-e", "title": "别人的", "status": "open", "assignee": "claude-code", "labels": []},
        {"id": "task-f", "title": "扔掉的", "status": "open", "labels": ["dispatch:needs-you", "dispatch:trashed"]},
    ]

    def test_only_you(self):
        out = W.only_you_items(self.ISSUES)
        self.assertEqual([(i["task"], i["project"], i["actions"]) for i in out], [("task-a", "kanban", ["done", "snooze", "reply", "open"])])  # task-b is only assigned to the person
        self.assertEqual(out[0]["phrase"], "终端跑 claude setup-token。")
        self.assertEqual(out[0]["id"], "task:task-a")

    def test_collect_orders_kinds_and_counts(self):
        noon = I._iso("2026-09-27T12:00:00Z")
        data = W.collect(now=noon, ide=[], held={}, activity_rows={}, issues=self.ISSUES,
                         pending=lambda k: None, seen=0)
        self.assertEqual(data["counts"], {"approve": 0, "decide": 0, "unread": 0, "only_you": 1, "only_you_recent": 1, "only_you_older": 0,
                                          "only_you_new": 1, "attention": 1, "all": 1})
        # opened the page after it was filed: not new any more, the sidebar number drops it
        data = W.collect(now=noon, ide=[], held={}, activity_rows={}, issues=self.ISSUES, pending=lambda k: None, seen=noon - 60)
        self.assertEqual((data["counts"]["only_you_new"], data["counts"]["attention"], data["seen_at"]), (0, 0, noon - 60))

    def test_a_board_that_does_not_answer_makes_the_list_partial(self):
        # bd timing out on a busy Mac is not "nothing to decide": the window keeps its Decide and Only you rows
        noon = I._iso("2026-09-27T12:00:00Z")
        with unittest.mock.patch.object(W, "board_issues", side_effect=TimeoutError("bd did not answer within 20 seconds")):
            data = W.collect(now=noon, ide=[], held={}, activity_rows={}, pending=lambda k: None, seen=0)
        self.assertEqual(data["partial"], ["board"])
        self.assertEqual([i for i in data["items"] if i["source"] == "board"], [])

    def test_an_agents_window_that_does_not_answer_makes_the_list_partial(self):
        # a timeout talking to the Agents window is not "nothing waits": the page keeps its session rows
        noon = I._iso("2026-09-27T12:00:00Z")

        def scan(now=None, connect=None, errors=None):
            errors.append("/tmp/ahp.sock: timed out")
            return []
        orig = W.ide_scan
        W.ide_scan = scan
        try:
            data = W.collect(now=noon, held={}, activity_rows={}, issues=self.ISSUES, pending=lambda k: None, seen=0)
        finally:
            W.ide_scan = orig
        self.assertEqual(data["partial"], ["ide"])
        self.assertNotIn("partial", W.collect(now=noon, ide=[], held={}, activity_rows={}, issues=self.ISSUES, pending=lambda k: None, seen=0))

    def test_a_design_direction_to_pick_is_a_decide_row(self):
        # `dispatch flow design` leaves the task deciding (label dispatch:decide): the same board list gives
        # its Decide row, first after the approvals, and the sidebar counts it
        noon = I._iso("2026-09-27T12:00:00Z")
        design = {"id": "task-t26s", "title": "Waiting for you 重设计", "status": "in_progress",
                  "labels": ["dispatch:decide", "dispatch:waiting", "project:kanban"], "updated_at": "2026-09-27T11:00:00Z",
                  "metadata": {"flow": {"state": "deciding", "prototype": "/k/design/waiting/redesign/index.html",
                                        "options": [{"key": "A", "title": "按紧急度分段"}, {"key": "B", "title": "一条时间线"}]}}}
        data = W.collect(now=noon, ide=[], held={}, activity_rows={}, issues=self.ISSUES + [design], pending=lambda k: None, seen=noon - 60)
        self.assertEqual([i["kind"] for i in data["items"]], ["decide", "only_you"])
        row = data["items"][0]
        self.assertEqual((row["id"], row["options"][0], row["open"]), ("task:task-t26s", {"key": "A", "title": "按紧急度分段"}, "/k/design/waiting/redesign/index.html"))
        self.assertEqual((data["counts"]["decide"], data["counts"]["attention"]), (1, 1))


PICK_REQUEST = {"id": "chatInput:p", "kind": "chatInput", "chat": CHAT,
                "request": {"id": "req_7", "questions": [{"id": "drafts", "kind": "single-select", "title": "drafts", "message": "Which draft should go out?",
                                                          "options": [{"id": "Draft A", "label": "Draft A, short, asks for a meeting"},
                                                                      {"id": "Draft B", "label": "Draft B, full status update"},
                                                                      {"id": "Neither", "label": "Neither, I will write it"}]}]}}


class Cards(unittest.TestCase):
    """What the Approve and Decide cards on the page say (design/waiting/redesign, direction A)."""

    def test_tool_arg_path_and_scope(self):
        home = os.path.expanduser("~")
        write = {"toolName": "Write", "toolInput": json.dumps({"file_path": home + "/.config/dispatch/env.sh", "content": "x"})}
        self.assertEqual(W.tool_detail(write, ["/p/kanban"]), {"tool": "Write", "arg": "~/.config/dispatch/env.sh", "path": home + "/.config/dispatch/env.sh", "scope": "outside_workspace"})
        inside = {"toolName": "Edit", "toolInput": json.dumps({"file_path": "/p/kanban/app/x.py"})}
        self.assertIsNone(W.tool_detail(inside, ["/p/kanban"])["scope"])
        # a worktree of the project counts as the session's own folder
        self.assertIsNone(W.tool_detail({"toolName": "Write", "toolInput": json.dumps({"file_path": "/p/kanban.worktrees/a/x"})}, ["/p/kanban", "/p/kanban.worktrees/a"])["scope"])
        notary = {"toolName": "Bash", "toolInput": json.dumps({"command": "xcrun notarytool submit Harbor.zip --keychain-profile harbor --wait"})}
        self.assertEqual(W.tool_detail(notary, ["/p/harbor"]), {"tool": "Bash", "arg": "xcrun notarytool submit Harbor.zip --keychain-profile harbor --wait", "path": "", "scope": "uploads"})
        self.assertEqual(W.tool_detail({"toolName": "Bash", "toolInput": json.dumps({"command": "cd build && rm -rf out"})})["scope"], "destructive")
        self.assertEqual(W.tool_detail({"toolName": "Bash", "toolInput": json.dumps({"command": "g" + "it push --force origin main"})})["scope"], "destructive")
        self.assertEqual(W.tool_detail({"toolName": "Bash", "toolInput": json.dumps({"command": "g" + "it push origin main"})})["scope"], "uploads")
        self.assertIsNone(W.tool_detail({"toolName": "Bash", "toolInput": json.dumps({"command": "npm test"})})["scope"])
        # Codex: the shell tool reads as Bash, its command may come as a list
        self.assertEqual(W.tool_detail({"toolName": "shell", "toolInput": json.dumps({"command": ["bash", "-lc", "ls"]})})["tool"], "Bash")
        self.assertEqual(W.tool_detail({"toolName": "shell", "toolInput": json.dumps({"command": ["bash", "-lc", "ls"]})})["arg"], "bash -lc ls")
        # the real Bash request of the Agents window (Dispatch IDE, 2026-09-27): the input is the command line,
        # wrapped in `command` by the host
        bash = {"status": "pending-confirmation", "toolCallId": "toolu_018c", "toolName": "Bash", "displayName": "Run shell command",
                "_meta": {"toolKind": "terminal"}, "invocationMessage": {"markdown": "Running `command ls -la`"},
                "toolInput": "command ls -la", "confirmationTitle": "Run in terminal?"}
        self.assertEqual(W.tool_detail(bash, ["/p/demo-shop"]), {"tool": "Bash", "arg": "ls -la", "path": "", "scope": None})
        self.assertEqual(W.tool_detail(dict(bash, toolInput="command rm -rf dist"))["scope"], "destructive")
        # no input: the path from the invocation message, else the phrase
        self.assertEqual(W.tool_detail(dict(WRITE_REQUEST["toolCall"], toolInput=None), ["/p"])["path"], "/tmp/wfy/outside2.txt")
        self.assertEqual(W.tool_detail({"displayName": "Fetch"})["arg"], "Fetch")

    def test_decide_options(self):
        q, opts, qid, kind = W.decide_detail(PICK_REQUEST["request"])
        self.assertEqual((q, qid, kind), ("Which draft should go out?", "drafts", "single-select"))
        self.assertEqual([o["id"] for o in opts], ["Draft A", "Draft B", "Neither"])
        self.assertEqual(W.decide_detail({"id": "r", "questions": [{"id": "ok", "kind": "boolean", "message": "Ship it?"}]})[1],
                         [{"id": "yes", "label": "Yes"}, {"id": "no", "label": "No"}])
        # two questions, or a free text one: answered in the session
        two = {"id": "r", "questions": [PICK_REQUEST["request"]["questions"][0], {"id": "b", "kind": "text", "message": "Why?"}]}
        self.assertEqual(W.decide_detail(two)[1], [])
        self.assertEqual(W.decide_detail({"id": "r", "questions": [{"id": "b", "kind": "text", "message": "Why?"}]})[:2], ("Why?", []))


class Pick(Base):
    def test_decide_row_offers_its_options_and_pick_answers_it(self):
        items = [live(f"claude:/{CLAUDE_ID}", I.ST_INPUT_NEEDED, "回复导师邮件")]
        connect = self.connect(items, {f"claude:/{CLAUDE_ID}": {"inputNeeded": [PICK_REQUEST]}})
        scanned = W.ide_scan(connect=connect)
        it = W.ide_item(scanned[0][0], scanned[0][1])
        self.assertEqual((it["kind"], it["question"], it["actions"]), ("decide", "Which draft should go out?", ["pick", "open"]))
        self.assertEqual(it["request"], {"chat": CHAT, "request_id": "req_7", "question_id": "drafts", "question_kind": "single-select"})
        res = W.ide_pick(f"ide:claude:/{CLAUDE_ID}", "2", scanned, connect)  # the key 2 on the card
        self.assertTrue(res["ok"], res)
        self.assertEqual((res["option"], res["message"]), ("Draft B", "Answered: Draft B, full status update"))
        sent = [p for m, p in self.log if m == "dispatchAction"]
        self.assertEqual(sent[-1], {"channel": CHAT, "clientSeq": 1, "action": {
            "type": "chat/inputCompleted", "requestId": "req_7", "response": "accept",
            "answers": {"drafts": {"state": "submitted", "value": {"kind": "selected", "value": "Draft B"}}}}})
        W.ide_pick(f"ide:claude:/{CLAUDE_ID}", "Neither", scanned, connect)  # by id
        self.assertEqual([p for m, p in self.log if m == "dispatchAction"][-1]["action"]["answers"]["drafts"]["value"]["value"], "Neither")
        self.assertEqual(W.ide_pick(f"ide:claude:/{CLAUDE_ID}", "7", scanned, connect)["code"], "no_option")

    def test_yes_no_question_answers_a_boolean(self):
        req = {"id": "chatInput:b", "kind": "chatInput", "chat": CHAT, "request": {"id": "r1", "questions": [{"id": "ship", "kind": "boolean", "message": "Ship it?"}]}}
        items = [live(f"claude:/{CLAUDE_ID}", I.ST_INPUT_NEEDED)]
        connect = self.connect(items, {f"claude:/{CLAUDE_ID}": {"inputNeeded": [req]}})
        res = W.ide_pick(f"ide:claude:/{CLAUDE_ID}", "no", W.ide_scan(connect=connect), connect)
        self.assertTrue(res["ok"])
        self.assertEqual([p for m, p in self.log if m == "dispatchAction"][-1]["action"]["answers"], {"ship": {"state": "submitted", "value": {"kind": "boolean", "value": False}}})

    def test_pick_on_an_approval_is_refused(self):
        items = [live(f"claude:/{CLAUDE_ID}", I.ST_INPUT_NEEDED)]
        connect = self.connect(items, {f"claude:/{CLAUDE_ID}": {"inputNeeded": [WRITE_REQUEST]}})
        self.assertEqual(W.ide_pick(f"ide:claude:/{CLAUDE_ID}", "1", W.ide_scan(connect=connect), connect)["code"], "not_pickable")
        self.assertEqual(W.ide_pick(f"ide:claude:/{CLAUDE_ID}", "1", [], connect)["code"], "not_waiting")

    def test_undo_read_marks_the_session_unread(self):
        items = [live(f"claude:/{SECOND}", I.ST_IDLE | I.ST_READ, "写周报")]
        res = W.ide_mark_unread(f"ide:claude:/{SECOND}", self.connect(items))
        self.assertTrue(res["ok"], res)
        self.assertEqual([p for m, p in self.log if m == "dispatchAction"], [{"channel": f"claude:/{SECOND}", "clientSeq": 1, "action": {"type": "session/isReadChanged", "isRead": False}}])
        self.assertEqual(W.ide_mark_unread("ide:claude:/nope", self.connect(items))["code"], "not_found")


class OnlyYou(unittest.TestCase):
    NOW = I._iso("2026-09-27T12:00:00Z")

    def issue(self, tid, title, created, labels=(), desc="", status="open", meta=None):
        return {"id": tid, "title": title, "status": status, "labels": ["dispatch:needs-you", "project:kanban", *labels], "description": desc,
                "created_at": created, "updated_at": "2026-09-27T11:00:00Z", **({"metadata": meta} if meta is not None else {})}

    def test_this_week_newest_first_with_where_it_came_from(self):
        issues = [self.issue("task-old", "三周前的", "2026-09-06T10:00:00Z"),
                  self.issue("task-new", "昨天的", "2026-09-26T10:00:00Z", ["session-origin:5e1c0a55-aaaa"], "看完清单再定。\n\n来自任务 task-x1y2"),
                  self.issue("task-mid", "三天前的", "2026-09-24T10:00:00Z")]
        out = W.only_you_items(issues, self.NOW)
        self.assertEqual([(i["task"], i["recent"]) for i in out], [("task-new", True), ("task-mid", True), ("task-old", False)])
        new = out[0]
        # at is when it was filed: editing the task later does not make it new
        self.assertEqual((new["at"], new["created_at"]), (I._iso("2026-09-26T10:00:00Z"), I._iso("2026-09-26T10:00:00Z")))
        self.assertEqual((new["session"], new["from_task"], new["snooze_until"]), ("5e1c0a55-aaaa", "task-x1y2", None))
        c = W.counts(out, seen_at=I._iso("2026-09-25T00:00:00Z"))
        self.assertEqual((c["only_you"], c["only_you_recent"], c["only_you_older"], c["only_you_new"], c["attention"]), (3, 2, 1, 1, 1))

    def test_snoozed_until_its_time(self):
        later, earlier = self.NOW + 3600, self.NOW - 3600
        issues = [self.issue("task-a", "明天再说", "2026-09-20T10:00:00Z", meta={"snooze_until": later}),
                  self.issue("task-b", "放过一次的", "2026-09-20T10:00:00Z", meta=json.dumps({"snooze_until": earlier}))]
        out = W.only_you_items(issues, self.NOW)
        self.assertEqual([i["task"] for i in out], ["task-b"])
        self.assertEqual(out[0]["snooze_until"], earlier)
        # back from a snooze after the page was last opened: new again
        self.assertEqual(W.counts(out, seen_at=earlier - 60)["only_you_new"], 1)
        self.assertEqual(W.counts(out, seen_at=earlier + 60)["only_you_new"], 0)

    def test_story_survives_both_metadata_encodings(self):
        story = "The signed form is ready. Send it before Friday."
        for metadata in ({"story": story}, json.dumps({"story": story})):
            item = self.issue("task-a1", "Send the form", "2026-09-27T10:00:00Z", meta=metadata)
            self.assertEqual(W.only_you_items([item], self.NOW)[0]["story"], story)
        old = self.issue("task-a1", "Old task", "2026-09-27T10:00:00Z", desc="Context.")
        self.assertEqual(W.only_you_items([old], self.NOW)[0]["story"], "")

    def test_a_session_row_names_its_task(self):
        sid = "5e1c0a55-0000-4000-8000-000000000005"
        issues = [{"id": "task-t1", "title": "换一个 Claude 长期 token", "status": "in_progress", "labels": ["session-origin:" + sid], "updated_at": "2026-09-27T10:00:00Z"},
                  {"id": "task-t0", "title": "旧的那条", "status": "in_progress", "labels": ["session:" + sid], "updated_at": "2026-09-26T10:00:00Z"},
                  {"id": "task-t2", "title": "做完了", "status": "closed", "labels": ["session:" + sid], "updated_at": "2026-09-27T11:00:00Z"},
                  self.issue("task-n", "只能你做", "2026-09-27T09:00:00Z", ["session-origin:" + sid])]
        by = W.session_tasks(issues)
        self.assertEqual(by, {sid: ("task-t1", "换一个 Claude 长期 token")})
        row = W.with_task({"kind": "approve", "session": "claude-code:" + sid}, by)
        self.assertEqual((row["task"], row["task_title"]), ("task-t1", "换一个 Claude 长期 token"))
        self.assertNotIn("task", W.with_task({"kind": "unread", "session": "codex:zzz"}, by))

    def test_snooze_until_tomorrow_or_next_week(self):
        from datetime import datetime
        fri = datetime(2026, 9, 25, 15, 30).timestamp()  # a Friday afternoon
        self.assertEqual(datetime.fromtimestamp(W.snooze_until("tomorrow", fri)), datetime(2026, 9, 26, 8, 0))
        self.assertEqual(datetime.fromtimestamp(W.snooze_until("next-week", fri)), datetime(2026, 9, 28, 8, 0))
        self.assertEqual(W.snooze_until("1790600000", fri), 1790600000.0)


class Acting(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.orig = W.D

        def sh(argv, timeout=0):
            self.calls.append(argv)
            return 0, json.dumps({"id": argv[2] if len(argv) > 2 else "", "title": "定会议字幕的收费方案", "labels": ["project:会议记录"]}), ""
        W.D = types.SimpleNamespace(sh=sh, project_home=lambda p: "/p/" + p, DISPATCH_DIR="")

    def tearDown(self):
        W.D = self.orig

    def run_cli(self, **kw):
        ns = dict(op="list", id=None, option=None, until=None, reason="", all=False, json=True)
        ns.update(kw)
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = W.command(argparse.Namespace(**ns))
        return code, json.loads(buf.getvalue())

    def test_snooze_unsnooze_reopen(self):
        code, res = self.run_cli(op="snooze", id="task:task-a,task-b", until="1790600000")
        self.assertEqual((code, res["snoozed"], res["until"]), (0, ["task-a", "task-b"], 1790600000))
        self.assertEqual(self.calls[0], ["bd", "update", "task-a", "--set-metadata", "snooze_until=1790600000", "--json"])
        self.calls.clear()
        self.run_cli(op="unsnooze", id="task-a")
        self.assertEqual(self.calls, [["bd", "update", "task-a", "--unset-metadata", "snooze_until", "--json"]])
        self.calls.clear()
        code, res = self.run_cli(op="reopen", id="task-a")
        self.assertEqual((code, res["reopened"], self.calls), (0, ["task-a"], [["bd", "reopen", "task-a", "--json"]]))

    def test_pick_a_design_direction_goes_to_the_flow(self):
        import flows
        got = {}

        def pick(tid, option, reason=""):
            got.update(tid=tid, option=option, reason=reason)
            return {"ok": True, "picked": option.upper()}
        orig = flows.pick
        flows.pick = pick
        try:
            code, res = self.run_cli(op="pick", id="task:task-t26s", option="a", reason="急的在上面")
        finally:
            flows.pick = orig
        self.assertEqual((code, res["picked"], got), (0, "A", {"tid": "task-t26s", "option": "a", "reason": "急的在上面"}))
        # a row that is neither a session's question nor a design direction
        code, res = self.run_cli(op="pick", id="chat:claude-code:abc", option="1")
        self.assertEqual(res["code"], "bad_id")

    def test_reply_says_where_and_how_to_start(self):
        code, res = self.run_cli(op="reply", id="task-q9")
        self.assertEqual(code, 0)
        self.assertEqual((res["task"], res["project"], res["project_dir"], res["prompt"]),
                         ("task-q9", "会议记录", "/p/会议记录", "About “定会议字幕的收费方案” (task-q9): "))

    def test_seen_records_when_the_page_was_opened(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            W.D.DISPATCH_DIR = d
            self.assertEqual(W.seen_at(now=100.0), 100.0)  # first time: now, nothing old counts as new
            code, res = self.run_cli(op="seen")
            self.assertEqual(code, 0)
            self.assertAlmostEqual(W.seen_at(), res["seen_at"], places=3)
            with open(os.path.join(d, W.SEEN_FILE)) as f:
                self.assertIn("seen_at", json.load(f))


class Cli(unittest.TestCase):
    def test_list_json_and_text(self):
        orig = W.collect
        W.collect = lambda **k: {"items": W.only_you_items(Board.ISSUES), "counts": {}, "updated_at": 1}
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = W.command(argparse.Namespace(op="list", id=None, all=False, json=True))
            self.assertEqual(code, 0)
            self.assertEqual(len(json.loads(buf.getvalue())["items"]), 1)
            buf = io.StringIO()
            with redirect_stdout(buf):
                W.command(argparse.Namespace(op="list", id=None, all=False, json=False))
            self.assertIn("Only you  kanban", buf.getvalue())
        finally:
            W.collect = orig

    def test_done_closes_only_you_tasks(self):
        calls = []
        orig_issues, orig_d = W.board_issues, W.D
        W.board_issues = lambda: Board.ISSUES
        W.D = types.SimpleNamespace(sh=lambda argv, timeout=0: (calls.append(argv), (0, "{}", ""))[1])
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = W.command(argparse.Namespace(op="done", id=None, all=True, json=True))
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(buf.getvalue()), {"ok": True, "done": ["task-a"], "message": "Marked 1 done"})
            self.assertEqual(calls, [["bd", "close", "task-a", "--reason", "Done in Waiting for you", "--json"]])  # task-d is closed, task-f trashed, task-b only assigned
            calls.clear()
            with redirect_stdout(io.StringIO()):
                W.command(argparse.Namespace(op="done", id="task:task-a", all=False, json=True))
            self.assertEqual([c[2] for c in calls], ["task-a"])
            calls.clear()
            with redirect_stdout(io.StringIO()):
                W.command(argparse.Namespace(op="done", id="task-b", all=False, json=True))
            self.assertEqual(calls, [])  # not an Only-you row: nothing closes
        finally:
            W.board_issues, W.D = orig_issues, orig_d

    def test_allow_rejects_a_task_id(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = W.command(argparse.Namespace(op="allow", id="task:task-a", all=False, json=True))
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(buf.getvalue())["code"], "bad_id")

    def test_dispatch_waiting_is_wired(self):
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            env = dict(os.environ, DISPATCH_IDE_USER_DATA_DIRS=d, DISPATCH_DIR=d, BEADS_DIR=os.path.join(d, "none"))
            p = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "waiting", "--json"], capture_output=True, text=True, env=env, timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            data = json.loads(p.stdout)
            self.assertIn("counts", data)
            self.assertIn("attention", data["counts"])
            self.assertEqual(data["host"], "local")
            q = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "waiting", "seen", "--json"], capture_output=True, text=True, env=env, timeout=60)
            self.assertEqual(q.returncode, 0, q.stderr)
            self.assertTrue(os.path.exists(os.path.join(d, W.SEEN_FILE)))
            p = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "waiting", "--json", "--local"], capture_output=True, text=True, env=env, timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)  # what another Mac runs over ssh
            p = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "waiting", "--json", "--host", "nowhere"], capture_output=True, text=True, env=env, timeout=60)
            self.assertEqual((p.returncode, json.loads(p.stdout)), (1, {"ok": False, "message": "Unknown Mac: nowhere"}))


# where the registry puts projects (projects_view.placements): 后台 and 讲书 on the mini, kanban here
WHERE = {"names": {"后台": "mini", "讲书": "mini", "内在知识提升": "mini", "kanban": "local"},
         "dirs": [("~/Projects/后台", "mini"), ("~/Projects/内在知识提升", "mini"), ("~/Projects/kanban", "local")]}
MINI = {"id": "mini", "name": "mini", "ssh": "apple@100.64.0.11", "aliases": ["kiwi-mac-mini", "Apple"]}


def item(kind, source, project="", project_dir="", **kw):
    return {"id": f"{source}:{kind}:{project}:{project_dir}", "kind": kind, "source": source, "project": project, "project_dir": project_dir, **kw}


class ThisMachine(unittest.TestCase):
    """One machine, one window: the list is this machine's."""

    def setUp(self):
        self.orig = W.D
        W.D = types.SimpleNamespace(HOME="/Users/me")

    def tearDown(self):
        W.D = self.orig

    def test_other_macs_tasks_and_leftovers_are_left_out_live_prompts_stay(self):
        items = [
            item("only_you", "board", "后台", task="task-a"),       # the mini's project: the mini lists it
            item("only_you", "board", "讲书", task="task-b"),       # by its label (alias) too
            item("only_you", "board", "kanban", task="task-c"),     # placed here
            item("only_you", "board", "", task="task-d"),           # no project: every machine lists it
            item("decide", "board", "demo", task="task-e"),         # placed nowhere: every machine lists it
            item("unread", "chat", "内在知识提升", "/Users/me/Projects/内在知识提升"),   # a copy left here after the move
            item("unread", "ide", "x", "/Users/me/Projects/后台/sub"),               # by its folder
            item("approve", "chat", "后台", "/Users/me/Projects/后台"),              # asks here: no other window can answer
            item("decide", "ide", "讲书", "/Users/me/Projects/内在知识提升"),
            item("unread", "chat", "kanban", "/Users/me/Projects/kanban"),
        ]
        data = W.this_machine({"items": items, "updated_at": 9}, WHERE)
        kept = [(it["kind"], it["source"], it["project"]) for it in data["items"]]
        self.assertEqual(kept, [("only_you", "board", "kanban"), ("only_you", "board", ""), ("decide", "board", "demo"),
                                ("approve", "chat", "后台"), ("decide", "ide", "讲书"), ("unread", "chat", "kanban")])
        self.assertEqual({k: data["counts"][k] for k in ("approve", "decide", "unread", "only_you", "all", "shared")}, {"approve": 1, "decide": 2, "unread": 1, "only_you": 2, "all": 6, "shared": 2})
        self.assertEqual(W.attention(data), {"approve": 1, "decide": 2, "unread": 1, "only_you": 2, "total": 6, "shared": 2, "as_of": 9})

    def test_an_older_macs_whole_list_seen_from_that_mac(self):
        # the mini's own view, worked out here: kanban is this Mac's, 后台 the mini's (folders under /Users/apple)
        items = [item("only_you", "board", "kanban", task="t1"), item("only_you", "board", "后台", task="t2"),
                 item("unread", "chat", "x", "/Users/apple/Projects/后台"), item("unread", "chat", "y", "/Users/apple/Projects/kanban")]
        data = W.this_machine({"items": items}, WHERE, view="mini", home="/Users/apple")
        self.assertEqual([it["project"] for it in data["items"]], ["后台", "x"])

    def test_nothing_known_keeps_everything(self):
        items = [item("only_you", "board", "后台")]
        self.assertEqual(len(W.this_machine({"items": items}, {"names": {}, "dirs": []})["items"]), 1)
        W.D = types.SimpleNamespace()  # no registry to read: the list stays whole rather than empty
        self.assertEqual(W.places(), {"names": {}, "dirs": []})


class RemoteList(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.calls = []
        self.answers = {}
        path = lambda h, args: os.path.join(self.tmp.name, f"{h['id']}--" + "-".join(a.strip("-") for a in args) + ".json")  # noqa: E731

        def remote(h, args, ttl, timeout=12, background=False):
            self.calls.append(tuple(args))
            return self.answers.get(tuple(args))

        self.orig = W.D
        W.D = types.SimpleNamespace(HOME="/Users/me", remote_cache_path=path, remote_dispatch=remote, hosts=lambda: [MINI],
                                    local_host_name=lambda: "小蓝", local_host_aliases=lambda: [], _mod=lambda n: (_ for _ in ()).throw(ImportError(n)),
                                    debug=lambda *a: None)
        self.path = path

    def tearDown(self):
        W.D = self.orig
        self.tmp.cleanup()

    def test_a_current_mac_answers_its_own_list(self):
        self.answers[("waiting", "--local")] = {"items": [item("unread", "chat", "a")], "counts": {"unread": 1, "all": 1, "shared": 0}, "updated_at": 5}
        data = W.remote_list(MINI)
        self.assertEqual((data["host"], data["host_name"], len(data["items"])), ("mini", "mini", 1))
        self.assertEqual(self.calls, [("waiting", "--local")])

    def test_an_older_mac_is_asked_for_its_whole_list(self):
        with open(self.path(MINI, ["hosts", "--local"]), "w") as f:
            json.dump([{"id": "local", "name": "Apple"}], f)  # no dispatch_version: `waiting --local` does not exist there
        self.answers[("waiting",)] = {"items": [item("only_you", "board", "kanban"), item("unread", "chat", "x", "/Users/apple/Projects/a")], "updated_at": 6}
        with unittest.mock.patch.object(W, "places", return_value=WHERE):
            data = W.remote_list(MINI)
        self.assertEqual(self.calls, [("waiting",)])
        self.assertEqual([it["project"] for it in data["items"]], ["x"])  # kanban is this Mac's
        self.assertEqual(data["counts"]["all"], 1)

    def test_off_the_last_answer_without_ssh(self):
        with open(self.path(MINI, ["waiting", "--local"]), "w") as f:
            json.dump({"items": [], "counts": {"all": 0}, "updated_at": 7}, f)
        data = W.remote_list(MINI, cached_only=True)
        self.assertEqual((data["updated_at"], self.calls), (7, []))
        self.assertIsNone(W.remote_list({"id": "gone", "name": "gone", "ssh": "x@y"}, cached_only=True))

    def test_list_host_by_an_old_id(self):
        self.answers[("waiting", "--local")] = {"items": [], "counts": {"all": 0}, "updated_at": 8}
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = W.command(argparse.Namespace(op="list", id=None, all=False, json=True, host="kiwi-mac-mini"))
        self.assertEqual((code, json.loads(buf.getvalue())["host"]), (0, "mini"))
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = W.command(argparse.Namespace(op="list", id=None, all=False, json=True, host="mini"))
        self.assertEqual(code, 0)
        self.answers.clear()
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = W.command(argparse.Namespace(op="list", id=None, all=False, json=True, host="mini"))
        self.assertEqual((code, json.loads(buf.getvalue())), (1, {"ok": False, "message": "mini did not answer."}))


class AllActions(unittest.TestCase):
    """Mark all done / read act on what this machine lists: the board is shared with the other Mac."""

    def test_done_all_leaves_the_other_macs_tasks_open(self):
        issues = [{"id": "task-a", "title": "a", "status": "open", "labels": ["dispatch:needs-you", "project:kanban"]},
                  {"id": "task-b", "title": "b", "status": "open", "labels": ["dispatch:needs-you", "project:后台"]},
                  {"id": "task-c", "title": "c", "status": "open", "labels": ["dispatch:needs-you"]}]
        calls = []
        orig_issues, orig_d, orig_places = W.board_issues, W.D, W.places
        W.board_issues = lambda label=W.NEEDS_YOU: issues
        W.D = types.SimpleNamespace(HOME="/Users/me", sh=lambda argv, timeout=0: (calls.append(argv), (0, "{}", ""))[1])
        W.places = lambda: WHERE
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = W.command(argparse.Namespace(op="done", id=None, all=True, json=True))
            self.assertEqual((code, json.loads(buf.getvalue())["done"]), (0, ["task-a", "task-c"]))
            self.assertEqual([c[2] for c in calls], ["task-a", "task-c"])
        finally:
            W.board_issues, W.D, W.places = orig_issues, orig_d, orig_places

    def test_read_all_skips_other_macs_leftovers(self):
        held = {"claude-code:k": {"lifecycle": "idle", "cwd": "/Users/me/Projects/kanban"},
                "claude-code:h": {"lifecycle": "idle", "cwd": "/Users/me/Projects/后台"}}
        rows = {"claude-code:k": {"unread": True, "reply_id": "1:k", "reply_preview": "Done."},
                "claude-code:h": {"unread": True, "reply_id": "1:h", "reply_preview": "Done."}}
        acked = []
        orig = W.collect
        W.collect = lambda **kw: {"items": W.chat_items(held, rows, lambda k: None)}
        import activity
        orig_ack, orig_d = activity.acknowledge, W.D
        activity.acknowledge = lambda d, key, reply: acked.append(key)
        W.D = types.SimpleNamespace(HOME="/Users/me", DISPATCH_DIR="/nowhere")
        try:
            with unittest.mock.patch.object(W, "ide_mark_read", return_value=[]):
                done = W.mark_read(None, keep=lambda it: W.keeps(it, WHERE))
        finally:
            W.collect, activity.acknowledge, W.D = orig, orig_ack, orig_d
        self.assertEqual((done, acked), (["chat:claude-code:k"], ["claude-code:k"]))


class HoverDetails(unittest.TestCase):
    def test_long_commands_questions_and_options_are_complete(self):
        command = "printf '%s\\n' " + " ".join("part" + str(i) for i in range(180))
        detail = W.tool_detail({"toolName": "Bash", "toolInput": json.dumps({"command": command})})
        self.assertEqual(detail["arg"], command)
        question = "Choose the complete proposal. " * 30
        option = "Keep all the details. " * 12
        result = W.decide_detail({"questions": [{"id": "q", "kind": "single-select", "message": question,
                                                 "options": [{"id": "a", "label": option}]}]})
        self.assertEqual(result[0], question.strip())
        self.assertEqual(result[1], [{"id": "a", "label": option.strip()}])

    def test_chat_unread_keeps_summary(self):
        summary = "First sentence. " + "Complete summary. " * 40
        result = W.chat_items({"codex:demo": {"lifecycle": "idle", "cwd": "/demo"}}, {"codex:demo": {"unread": True, "reply_id": "r1", "unread_summary": summary}})
        self.assertEqual(result[0]["summary"], summary.strip())
        self.assertEqual(result[0]["phrase"], "First sentence.")

    def test_need_you_stores_story_without_replacing_metadata(self):
        import dispatch as D
        a = argparse.Namespace(title="Send the signed form", desc="docs/form.pdf", why="The form is ready. Send it today.",
                               task=None, project="demo", priority=1, json=True)
        with unittest.mock.patch.object(D, "bd_json", return_value={"id": "task-a1"}), \
             unittest.mock.patch.object(D, "sh", return_value=(0, "", "")) as sh, \
             unittest.mock.patch.object(D, "local_host_name", return_value="test"), \
             unittest.mock.patch.object(D, "session_from_env", return_value=""), redirect_stdout(io.StringIO()):
            D.cmd_need_you(a)
        sh.assert_called_once_with(["bd", "update", "task-a1", "--set-metadata", "story=" + a.why])


if __name__ == "__main__":
    unittest.main()
