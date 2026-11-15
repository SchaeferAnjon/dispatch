# -*- coding: utf-8 -*-
"""Gemini CLI conversations (~/.gemini/tmp/<project>/chats/session-*.json) in the index, the session
page, the workbench and the Agent page. The fixture follows the file Gemini CLI 0.36 writes
(ChatRecordingService), trimmed to what Dispatch reads."""
import datetime
import importlib.util
import sys
import json
import os
import re
import tempfile
import time
import unittest
from contextlib import closing
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dispatch  # noqa: E402 - the module the engine adapters call back into (engines/gemini.py)
from engines import gemini as GE  # noqa: E402
import activity  # noqa: E402

WINDOWS_READY = True
P = dispatch.P
SID = "5607b6f6-ffb1-440d-8de4-ec76a5a697aa"


def iso(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def conversation(t, sid=SID, kind="main", finished=True):
    """A Gemini CLI conversation: a question, a reply that runs a shell command and reads a picture
    (the picture comes back as a user-role functionResponse record), an edit, the answer."""
    msgs = [
        {"id": "u1", "timestamp": iso(t - 60), "type": "user", "content": [{"text": "看一下 task-ab1 的视频 @a.mp4"}, {"text": "\n--- Content from referenced files ---"}, {"inlineData": {"mimeType": "video/mp4", "data": "AAAA"}}]},
        {"id": "g1", "timestamp": iso(t - 50), "type": "gemini", "content": "我先看看文件。", "model": "gemini-3-flash-preview",
         "thoughts": [{"subject": "Checking the file", "description": "ls first.", "timestamp": iso(t - 55)}],
         "tokens": {"input": 1000, "output": 20, "cached": 400, "thoughts": 30, "tool": 0, "total": 1050},
         "toolCalls": [{"id": "run_shell_command_1", "name": "run_shell_command", "args": {"command": "dispatch claim task-ab1", "description": "认领任务"}, "status": "success", "timestamp": iso(t - 48),
                        "result": [{"functionResponse": {"id": "run_shell_command_1", "name": "run_shell_command", "response": {"output": "Output: 已认领"}}}], "resultDisplay": "已认领"},
                       {"id": "read_file_2", "name": "read_file", "args": {"file_path": "/p/frame.jpg"}, "status": "success", "timestamp": iso(t - 47),
                        "result": [{"functionResponse": {"id": "read_file_2", "name": "read_file", "response": {"output": "Binary content provided (1 item(s))."}}}], "resultDisplay": ""}]},
        {"id": "u2", "timestamp": iso(t - 46), "type": "user", "content": [{"functionResponse": {"id": "read_file_2", "name": "read_file", "response": {}}}, {"inlineData": {"mimeType": "image/jpeg", "data": "AAAA"}}]},
        {"id": "g2", "timestamp": iso(t - 40), "type": "gemini", "content": "", "model": "gemini-3-flash-preview",
         "tokens": {"input": 2000, "output": 10, "cached": 0, "thoughts": 0, "tool": 0, "total": 2010},
         "toolCalls": [{"id": "replace_3", "name": "replace", "args": {"file_path": "/p/notes.md", "old_string": "旧", "new_string": "新"}, "status": "error", "timestamp": iso(t - 39),
                        "result": [{"functionResponse": {"id": "replace_3", "name": "replace", "response": {"error": "old_string not found"}}}]}]},
        {"id": "i1", "timestamp": iso(t - 35), "type": "info", "content": "Request cancelled."},
    ]
    if finished:
        msgs.append({"id": "g3", "timestamp": iso(t - 30), "type": "gemini", "content": "**Done** checking.\n[Thought: true]视频讲的是卷积层。要我再截几帧吗？", "model": "gemini-3-flash-preview",
                     "tokens": {"input": 3000, "output": 40, "cached": 1000, "thoughts": 0, "tool": 0, "total": 3040}})
    return {"sessionId": sid, "projectHash": "938b", "startTime": iso(t - 61), "lastUpdated": msgs[-1]["timestamp"], "kind": kind, "summary": "Analyze video content.", "messages": msgs}


class GeminiFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name
        self.project = os.path.join(self.home, "work", "videos")
        os.makedirs(self.project)
        self.t = time.time()
        env = patch.dict(os.environ, {}, clear=False)
        env.start(); self.addCleanup(env.stop)
        os.environ.pop("GEMINI_CLI_HOME", None)

    def write(self, conv, slug="videos", name=None, marker=True):
        folder = os.path.join(self.home, ".gemini", "tmp", slug)
        os.makedirs(os.path.join(folder, "chats"), exist_ok=True)
        if marker:
            with open(os.path.join(folder, ".project_root"), "w") as f:
                f.write(self.project)
        path = os.path.join(folder, "chats", name or f"session-2026-03-22T16-00-{conv['sessionId'][:8]}.json")
        with open(path, "w") as f:
            json.dump(conv, f, ensure_ascii=False)
        return path


class Store(GeminiFixture):
    def test_project_root_from_marker_or_projects_json(self):
        p = self.write(conversation(self.t))
        self.assertEqual(GE.project_root(p, self.home), self.project)
        q = self.write(conversation(self.t, sid="99999999-0000"), slug="other", marker=False)
        self.assertEqual(GE.project_root(q, self.home), "")
        with open(os.path.join(self.home, ".gemini", "projects.json"), "w") as f:
            json.dump({"projects": {"/somewhere/else": "other"}}, f)
        self.assertEqual(GE.project_root(q, self.home), "/somewhere/else")

    def test_user_text_stops_before_referenced_file_contents(self):
        m = conversation(self.t)["messages"][0]
        self.assertEqual(GE.user_text(m), "看一下 task-ab1 的视频 @a.mp4")
        self.assertEqual(GE.user_text(dict(m, displayContent=[{"text": "看一下视频"}])), "看一下视频")


class Index(GeminiFixture):
    def index(self):
        idx, seen = {}, set()
        with patch.object(dispatch, "HOME", self.home), patch.object(dispatch, "known_task_ids", return_value=set()):
            GE.index(idx, seen, re.compile(r"\btask-[a-z0-9]{2,8}\b"), re.compile(r"^task-[a-z0-9]{2,8}$"))
        return idx

    def test_conversation_is_indexed_with_counts_tokens_tasks_and_resume(self):
        path = self.write(conversation(self.t))
        sub = self.write(conversation(self.t, sid="aaaaaaaa-sub", kind="subagent"))
        idx = self.index()
        e = idx[path]
        self.assertEqual((e["agent"], e["session_id"], e["cwd"], e["title"], e["entrypoint"], e["subagent"]), ("gemini", SID, self.project, "Analyze video content.", "cli", False))
        # The picture read_file returned is a user-role record, not something the person said.
        self.assertEqual((e["user_msgs"], e["assistant_msgs"]), (1, 3))
        self.assertEqual(e["first_prompt"], "看一下 task-ab1 的视频 @a.mp4")
        self.assertEqual(e["tools"], {"run_shell_command": 1, "read_file": 1, "replace": 1})
        self.assertEqual(e["tokens"], {"in": 600 + 2000 + 2000, "out": 70, "cr": 1400, "cw": 0, "think": 30})
        self.assertEqual(e["models"], {"gemini-3-flash-preview": 3})
        self.assertIn("task-ab1", e["tasks"])
        self.assertEqual(e["claims"], ["task-ab1"])
        self.assertTrue(idx[sub]["subagent"])
        with patch.object(P, "IS_WIN", False):
            self.assertEqual(dispatch.resume_command("gemini", SID, self.project), f"cd '{self.project}' && gemini --resume {SID}")
        # Unchanged file: the next scan keeps the row without reading the file.
        with patch.object(GE, "load", side_effect=AssertionError("re-read")):
            idx2, seen = dict(idx), set()
            with patch.object(dispatch, "HOME", self.home):
                GE.index(idx2, seen, re.compile(r"\btask-[a-z0-9]{2,8}\b"), re.compile(r"^task-[a-z0-9]{2,8}$"))
        self.assertEqual(seen, {path, sub})

    def test_detail_timeline_and_tail(self):
        path = self.write(conversation(self.t))
        ref = {"agent": "gemini", "session_id": SID, "cwd": self.project, "path": path}
        d = dispatch.read_session_detail(ref)
        self.assertEqual([m["role"] for m in d["messages"]], ["user", "assistant", "assistant", "user", "assistant"])
        self.assertEqual(d["messages"][0]["text"], "看一下 task-ab1 的视频 @a.mp4")
        b = d["messages"][1]["blocks"]
        self.assertEqual([x["type"] for x in b], ["thinking", "text", "tool_call", "tool_call"])
        self.assertEqual((b[2]["name"], b[2]["status"], b[2]["result"], b[2]["summary"]), ("run_shell_command", "done", "Output: 已认领", "dispatch claim task-ab1"))
        edit = d["messages"][2]["blocks"][0]
        self.assertEqual((edit["name"], edit["status"], edit["result"]), ("replace", "error", "old_string not found"))
        self.assertEqual([f["path"] for f in d["files"]], ["/p/notes.md"])
        self.assertTrue(d["messages"][3].get("synthetic"))
        last = d["messages"][4]["blocks"]
        self.assertEqual([x["type"] for x in last], ["thinking", "text"])
        self.assertEqual(last[1]["text"], "视频讲的是卷积层。要我再截几帧吗？")
        self.assertEqual(d["offset"], 6)
        self.assertEqual(d["tool_counts"], {"run_shell_command": 1, "read_file": 1, "replace": 1})

        # Mid-turn: the reply's tool call is still running; then Gemini rewrites the file with its result.
        conv = conversation(self.t, finished=False)
        conv["messages"] = conv["messages"][:2]
        conv["messages"][1]["toolCalls"][0].update(status="executing", result=None)
        self.write(conv)
        d1 = dispatch.read_session_detail(ref)
        self.assertEqual(d1["offset"], 2)
        self.assertEqual(d1["messages"][1]["blocks"][2]["status"], "running")
        self.write(conversation(self.t))
        tail = dispatch.read_session_detail(ref, since=d1["offset"])
        # The last reply is sent again (ids let the view replace it); no user message is repeated.
        self.assertTrue(tail["partial"])
        self.assertEqual([m["role"] for m in tail["messages"]], ["assistant", "assistant", "user", "assistant"])
        self.assertEqual(tail["messages"][0]["mid"], "g1")
        self.assertEqual(tail["messages"][0]["blocks"][2]["status"], "done")
        self.assertEqual(tail["offset"], 6)


class LiveBase(GeminiFixture):
    def table(self):
        # node running the gemini npm bin, inside a zsh in Ghostty; the relaunched child below it.
        return {500: (400, "/opt/homebrew/bin/node"), 501: (500, "/opt/homebrew/bin/node"), 400: (300, "/bin/zsh"), 300: (1, "/Applications/Ghostty.app/Contents/MacOS/ghostty"), 600: (1, "/opt/homebrew/bin/node")}

    def cmdlines(self):
        return {500: "node --no-warnings=DEP0040 /Users/x/npm-global/bin/gemini", 501: "/opt/homebrew/bin/node /Users/x/npm-global/lib/node_modules/@google/gemini-cli/bundle/gemini.js",
                600: "node /usr/local/bin/some-server.js gemini", 400: "-zsh"}

    def live(self, cwd_of):
        with patch.object(dispatch, "HOME", self.home), patch.object(P, "IS_WIN", False), patch.object(P, "process_cmdlines", return_value=self.cmdlines()), \
             patch.object(dispatch, "pid_cwd", side_effect=cwd_of), patch.object(dispatch, "host_of", return_value=("terminal", "Ghostty")):
            return GE.live(self.table())


class Live(LiveBase):
    def test_only_the_gemini_process_counts(self):
        with patch.object(P, "process_cmdlines", return_value=self.cmdlines()):
            self.assertEqual(GE.pids(self.table()), [500])

    def test_recent_write_is_working_then_idle(self):
        path = self.write(conversation(self.t))
        rows = self.live(lambda pid: self.project)
        self.assertEqual([(r["agent"], r["session_id"], r["state"], r["cwd"], r["agent_pid"], r["source_app"]) for r in rows], [("gemini", SID, "working", self.project, 500, "Ghostty")])
        os.utime(path, (self.t - 600, self.t - 600))
        self.assertEqual([r["state"] for r in self.live(lambda pid: self.project)], ["idle"])

    def test_old_conversation_is_only_a_guess_and_other_directories_do_not_count(self):
        path = self.write(conversation(self.t))
        os.utime(path, (self.t - 7200, self.t - 7200))
        rows = self.live(lambda pid: self.project)
        self.assertEqual([(r["session_id"], r["state"], r.get("probable_session_id")) for r in rows], [("pid-500", "idle", SID)])
        os.utime(path, None)
        rows = self.live(lambda pid: os.path.join(self.home, "elsewhere"))
        self.assertEqual([(r["session_id"], r["state"]) for r in rows], [("pid-500", "idle")])

    def test_live_sessions_include_gemini(self):
        self.write(conversation(self.t))
        with tempfile.TemporaryDirectory() as d, patch.object(dispatch, "SESS_DIR", d), patch.object(dispatch, "ps_table", return_value=self.table()), \
             patch.object(dispatch, "store_live", return_value=[]), patch.object(__import__("engines.hermes", fromlist=["x"]), "live", return_value=[]), \
             patch.object(dispatch, "HOME", self.home), patch.object(P, "IS_WIN", False), patch.object(P, "process_cmdlines", return_value=self.cmdlines()), \
             patch.object(dispatch, "pid_cwd", return_value=self.project), patch.object(dispatch, "host_of", return_value=("terminal", "Ghostty")), \
             patch.object(dispatch, "local_host_name", return_value="Mac"), patch.object(dispatch, "merge_ide_sessions", lambda s: None):
            rows = dispatch.live_sessions(local_only=True)
        self.assertEqual([(r["agent"], r["session_id"], r["state"]) for r in rows], [("gemini", SID, "working")])


class Workbench(GeminiFixture):
    def test_conversation_joins_the_activity_list(self):
        store = os.path.join(self.home, "state")
        with closing(activity.connect(store)) as db, db:
            db.execute("UPDATE settings SET value=? WHERE key='started_at'", (self.t - 100,))
        path = self.write(conversation(self.t))
        self.write(conversation(self.t, sid="bbbbbbbb-sub", kind="subagent"))
        with patch.object(GE, "activity_processes", return_value={}):
            # Just written: the answer may still be followed by the tool calls it asked for.
            r = next(x for x in activity.activity_list(self.home, store, {}) if x["agent"] == "gemini")
            self.assertEqual((r["state"], r["activity"], r["unread"], r.get("reply_preview")), ("working", "正在回复", False, None))
            os.utime(path, (self.t - 10, self.t - 10))
            rows = [r for r in activity.activity_list(self.home, store, {}) if r["agent"] == "gemini"]
        self.assertEqual([(r["key"], r["project"], r["title"], r["path"]) for r in rows], [(f"gemini:{SID}", "videos", "Analyze video content.", path)])
        r = rows[0]
        self.assertEqual((r["state"], r["activity"], r["unread"]), ("idle", "已回复", True))
        self.assertEqual(r["reply_preview"], "视频讲的是卷积层。要我再截几帧吗？")
        self.assertEqual(r["question"], "要我再截几帧吗？")
        self.assertEqual([e["kind"] for e in r["events"]], ["user", "tool", "result", "tool", "result", "message", "tool", "error", "reply"])
        # The person writes again: the rewritten file invalidates the cached parse.
        conv = conversation(self.t)
        conv["messages"].append({"id": "u9", "timestamp": iso(self.t), "type": "user", "content": [{"text": "再截几帧"}]})
        self.write(conv)
        os.utime(path, (self.t + 5, self.t + 5))
        r = next(x for x in activity.activity_list(self.home, store, {}) if x["agent"] == "gemini")
        self.assertEqual((r["state"], r["activity"]), ("working", "正在处理你的消息"))


def cut_mid_tool(t, text="我这就把刚才的经验写进 video-intel。"):
    """What Gemini CLI 0.36 has on disk while a tool call runs or waits for approval: the model's
    message is recorded, its toolCalls are attached only once they finish (recordCompletedToolCalls)."""
    conv = conversation(t, finished=False)
    conv["messages"] = conv["messages"][:1] + [{"id": "g9", "timestamp": iso(t - 20), "type": "gemini", "content": text, "model": "gemini-3-flash-preview",
                                                 "tokens": {"input": 10, "output": 5, "cached": 0, "thoughts": 0, "tool": 0, "total": 15}}]
    return conv


class OpenTurn(GeminiFixture):
    """The file cannot tell an answer from a tool call not yet recorded; the process can."""

    def setUp(self):
        super().setUp()
        self.store = os.path.join(self.home, "state")
        with closing(activity.connect(self.store)) as db, db:
            db.execute("UPDATE settings SET value=? WHERE key='started_at'", (self.t - 100,))

    def row(self, conv, procs, age=60):
        path = self.write(conv)
        os.utime(path, (self.t - age, self.t - age))
        with patch.object(GE, "activity_processes", return_value=procs):
            return next(x for x in activity.activity_list(self.home, self.store, {}) if x["agent"] == "gemini")

    def test_tail(self):
        self.assertEqual(GE.turn_tail(conversation(self.t)), "reply")
        self.assertEqual(GE.turn_tail(cut_mid_tool(self.t)), "reply")
        self.assertEqual(GE.turn_tail(cut_mid_tool(self.t, text="")), "tool")
        conv = conversation(self.t, finished=False)
        self.assertEqual(GE.turn_tail(conv), None)  # ends on "Request cancelled."
        conv["messages"] = conv["messages"][:2]
        self.assertEqual(GE.turn_tail(conv), "next")
        conv["messages"][1]["toolCalls"][0]["status"] = "executing"
        self.assertEqual(GE.turn_tail(conv), "running")
        conv["messages"] = conv["messages"][:1]
        self.assertEqual(GE.turn_tail(conv), "user")

    def test_a_running_shell_command_is_working_not_an_answer(self):
        r = self.row(cut_mid_tool(self.t), {os.path.realpath(self.project): True}, age=600)
        self.assertEqual((r["state"], r["activity"], r["unread"], r.get("reply_id"), r.get("reply_preview"), r["stale"]), ("working", "正在跑命令", False, None, None, False))
        self.assertNotIn("held", r)
        self.assertNotIn("reply", [e["kind"] for e in r["events"]])

    def test_a_pending_tool_call_without_text_is_working_until_gemini_is_gone(self):
        r = self.row(cut_mid_tool(self.t, text=""), {os.path.realpath(self.project): False})
        self.assertEqual((r["state"], r["activity"], r["unread"]), ("working", "正在调用工具，或在终端等你确认", False))
        r = self.row(cut_mid_tool(self.t, text=""), {})
        self.assertEqual((r["state"], r["activity"], r["unread"]), ("idle", "本轮已结束", False))

    def test_an_answer_counts_once_no_shell_runs(self):
        r = self.row(cut_mid_tool(self.t), {os.path.realpath(self.project): False})
        self.assertEqual((r["state"], r["activity"], r["unread"], r["reply_preview"]), ("idle", "已回复", True, "我这就把刚才的经验写进 video-intel。"))
        self.assertNotIn("held", r)
        self.assertEqual(r["events"][-1]["kind"], "reply")

    def test_processes_by_directory_with_their_shells(self):
        table = {500: (400, "/opt/homebrew/bin/node"), 501: (500, "/opt/homebrew/bin/node"), 700: (501, "/bin/bash"), 800: (1, "/opt/homebrew/bin/node")}
        cmd = {500: "node /Users/x/npm-global/bin/gemini", 501: "node /Users/x/npm-global/lib/node_modules/@google/gemini-cli/bundle/gemini.js", 800: "node /x/npm-global/bin/gemini"}
        cwd = {500: self.project, 800: self.home}
        with patch.object(P, "IS_WIN", False), patch.object(P, "process_cmdlines", return_value=cmd), patch.object(P, "pid_cwd", side_effect=cwd.get):
            self.assertEqual(GE.activity_processes(table), {os.path.realpath(self.project): True, os.path.realpath(self.home): False})
        with patch.object(P, "IS_WIN", True):
            self.assertIsNone(GE.activity_processes(table))

    def test_a_cancelled_turn_is_idle(self):
        r = self.row(conversation(self.t, finished=False), {})
        self.assertEqual((r["state"], r["activity"]), ("idle", "已取消"))


class LiveOpenTurn(LiveBase):
    """The Agent page follows the same rules as the Sessions page, not only the file's age."""

    def test_a_turn_open_in_the_file_is_working_however_old_the_write(self):
        conv = conversation(self.t, finished=False)
        conv["messages"] = conv["messages"][:2]
        conv["messages"][1]["toolCalls"][0].update(status="executing", result=None)
        path = self.write(conv)
        os.utime(path, (self.t - 300, self.t - 300))
        self.assertEqual([(r["session_id"], r["state"]) for r in self.live(lambda pid: self.project)], [(SID, "working")])
        os.utime(path, (self.t - 7200, self.t - 7200))
        self.assertEqual([(r["session_id"], r["state"]) for r in self.live(lambda pid: self.project)], [(SID, "working")])

    def test_a_shell_below_gemini_is_working_and_an_old_answer_is_idle(self):
        path = self.write(cut_mid_tool(self.t))
        os.utime(path, (self.t - 300, self.t - 300))
        self.assertEqual([r["state"] for r in self.live(lambda pid: self.project)], ["idle"])
        table = dict(self.table())
        self.table = lambda: {**table, 700: (501, "/bin/bash"), 701: (700, "/bin/sleep")}
        self.assertEqual([r["state"] for r in self.live(lambda pid: self.project)], ["working"])


if __name__ == "__main__":
    unittest.main()
