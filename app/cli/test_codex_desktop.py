# -*- coding: utf-8 -*-
import json, unittest
from contextlib import closing

import session_reply as R


SNAP = {"id": "t1", "threadRuntimeStatus": {"type": "active", "turnId": "turn-9"}, "title": "改一下", "cwd": "/x", "latestModel": "gpt-6", "hasUnreadTurn": False,
        "latestThreadSettings": {"approvalPolicy": "on-request"},
        "requests": [
            {"id": "r1", "method": "item/commandExecution/requestApproval", "params": {"threadId": "t1", "turnId": "turn-9", "command": ["rm", "-rf", "build"], "cwd": "/x", "reason": "清理构建产物"}},
            {"id": "r2", "method": "item/fileChange/requestApproval", "params": {"changes": [{"path": "/x/a.ts"}, {"path": "/x/b.ts"}]}},
            {"id": "r3", "method": "item/tool/requestUserInput", "params": {"questions": [{"id": "q1", "question": "用哪个端口？", "options": [{"label": "3000"}, {"label": "8080"}]}]}},
            {"id": "r4", "method": "item/permissions/requestApproval", "params": {"permissions": {"network": {}}, "reason": "要联网"}},
        ]}


class DesktopStateTest(unittest.TestCase):
    def test_snapshot_becomes_a_compact_state(self):
        st = R.desktop_state(SNAP)
        self.assertEqual((st["running"], st["status"], st["turn_id"], st["model"], st["approval_policy"]), (True, "active", "turn-9", "gpt-6", "on-request"))
        kinds = [(r["id"], r["kind"], r["summary"]) for r in st["requests"]]
        self.assertEqual(kinds, [("r1", "command", "rm -rf build"), ("r2", "file", "修改 /x/a.ts、/x/b.ts"), ("r3", "question", "用哪个端口？"), ("r4", "permission", "申请权限：network")])
        self.assertEqual(st["requests"][2]["questions"], [{"id": "q1", "text": "用哪个端口？", "options": ["3000", "8080"]}])
        self.assertEqual(st["requests"][0]["reason"], "清理构建产物")

    def test_idle_thread_without_requests(self):
        st = R.desktop_state({"threadRuntimeStatus": {"type": "idle"}, "requests": []})
        self.assertEqual((st["running"], st["requests"]), (False, []))


class FakeIPC(R.DesktopIPC):
    """No socket: answers owner discovery and records the follower calls."""
    def __init__(self, home, snap=SNAP):
        self.client = "me"; self.calls = []; self.snap = snap

    def close(self): pass
    def owner(self, sid): return "owner-1"
    def snapshot(self, sid, owner=None): return self.snap
    def request(self, method, params, owner=None, version=1):
        self.calls.append((method, params, owner, version))
        return {"resultType": "success", "result": {"ok": True}}


class DesktopDecisionsTest(unittest.TestCase):
    def test_command_and_file_approvals_route_to_their_methods(self):
        ipc = FakeIPC("~")
        self.assertEqual(ipc.decide("t1", "r1", "acceptForSession"), "本会话都批准")
        self.assertEqual(ipc.decide("t1", "r2", "decline"), "已拒绝")
        self.assertEqual([(c[0], c[1]["requestId"], c[1]["decision"], c[2]) for c in ipc.calls],
                         [("thread-follower-command-approval-decision", "r1", "acceptForSession", "owner-1"), ("thread-follower-file-approval-decision", "r2", "decline", "owner-1")])

    def test_permission_and_question_payloads(self):
        ipc = FakeIPC("~")
        ipc.decide("t1", "r4", "accept")
        ipc.decide("t1", "r3", "", {"q1": {"answers": ["8080"]}})
        self.assertEqual(ipc.calls[0][0], "thread-follower-permissions-request-approval-response")
        self.assertEqual(ipc.calls[0][1]["response"], {"permissions": {"network": {}}, "scope": "turn"})
        self.assertEqual((ipc.calls[1][0], ipc.calls[1][1]["response"]), ("thread-follower-submit-user-input", {"answers": {"q1": {"answers": ["8080"]}}}))

    def test_bad_decisions_and_stale_requests_are_rejected(self):
        ipc = FakeIPC("~")
        with self.assertRaises(R.Rejected): ipc.decide("t1", "r1", "maybe")
        with self.assertRaises(R.Rejected): ipc.decide("t1", "gone", "accept")
        with self.assertRaises(R.Rejected): ipc.decide("t1", "r3", "", {})

    def test_interrupt_only_while_running(self):
        ipc = FakeIPC("~")
        self.assertEqual(ipc.interrupt("t1"), "已打断当前这轮")
        self.assertEqual(ipc.calls[-1], ("thread-follower-interrupt-turn", {"conversationId": "t1", "mode": "user-stop", "expectedTurnId": "turn-9"}, "owner-1", 4))
        idle = FakeIPC("~", {"threadRuntimeStatus": {"type": "idle"}, "requests": []})
        with self.assertRaises(R.Rejected): idle.interrupt("t1")


if __name__ == "__main__":
    unittest.main()
