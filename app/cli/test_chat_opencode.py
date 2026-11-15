# -*- coding: utf-8 -*-
"""chatd's OpenCode driver (chat_opencode.py) against a scripted `opencode acp`: sessions, a turn's
events, permissions, OpenCode's questions, stop, a process that dies, model changes, unattended runs."""
import json
import os
import queue
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chat_opencode as O  # noqa: E402
import chat_protocol as cp  # noqa: E402


class FakeAcp:
    """A scripted `opencode acp`: records what the client writes and answers through `handle`."""

    def __init__(self, handle):
        self.handle = handle
        self.out = queue.Queue()
        self.sent = []
        self.alive = True
        self.pid = 4242
        self.stderr = None
        self.stdin = self
        self.stdout = self

    # stdin
    def write(self, text):
        for line in text.splitlines():
            if line.strip():
                msg = json.loads(line)
                self.sent.append(msg)
                self.handle(self, msg)

    def flush(self):
        pass

    # stdout
    def __iter__(self):
        return self

    def __next__(self):
        line = self.out.get()
        if line is None:
            raise StopIteration
        return line

    def push(self, obj):
        self.out.put(json.dumps(obj) + "\n")

    def reply(self, msg, result):
        self.push({"jsonrpc": "2.0", "id": msg["id"], "result": result})

    def update(self, sid, update):
        self.push({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": update}})

    def die(self):
        self.alive = False
        self.out.put(None)

    def poll(self):
        return None if self.alive else 1

    def terminate(self):
        self.die()

    kill = terminate

    def wait(self, timeout=None):
        return 1

    def methods(self):
        return [m.get("method") for m in self.sent if "method" in m]


LISTED = ["deepseek/deepseek-chat", "zhipuai-coding-plan/glm-5.3-flash", "nope/none"]


def config(model="deepseek/deepseek-chat", effort=None):
    opts = [{"id": "model", "category": "model", "currentValue": model, "options": [{"value": m} for m in LISTED]}]
    if effort:
        opts.append({"id": "effort", "category": "thought_level", "currentValue": effort, "options": [{"value": "default"}, {"value": "high"}]})
    return opts


class FakeHttp:
    """The HTTP server inside `opencode acp` as the hub uses it: the test pushes question events, the
    answers are recorded (path, body, directory)."""

    def __init__(self, port, password):
        self.port, self.password = port, password
        self.posts = []
        self.listed = []
        self.q = queue.Queue()

    def get(self, path, directory=None, timeout=10):
        return list(self.listed)

    def post(self, path, body=None, directory=None, timeout=10):
        self.posts.append((path, body, directory))
        return True

    def events(self, on_event, alive, on_connect=None):
        if on_connect:
            on_connect()
        while alive():
            try:
                ev = self.q.get(timeout=0.05)
            except queue.Empty:
                continue
            on_event(ev)

    def push(self, kind, props, directory="/tmp/proj"):
        self.q.put({"directory": directory, "payload": {"type": kind, "properties": props}})

    def ask(self, sid, qid="que_1", questions=None, call="call_q"):
        self.push("question.asked", {"id": qid, "sessionID": sid, "questions": questions or COLOR, "tool": {"messageID": "msg_1", "callID": call}})

    def wait_post(self, timeout=3):
        end = time.time() + timeout
        while time.time() < end and not self.posts:
            time.sleep(0.01)
        return self.posts[-1] if self.posts else None


COLOR = [{"question": "Which color?", "header": "Color", "options": [{"label": "Red", "description": "warm"}, {"label": "Blue", "description": "cool"}]}]


class Server:
    """What a real OpenCode answers, turn scripts per prompt."""

    def __init__(self):
        self.procs = []
        self.envs = []
        self.argvs = []
        self.https = []
        self.turns = []          # callables (proc, msg) run on each session/prompt
        self.sessions = 0
        self.model = {}          # session id → its current model

    def spawn(self, argv, env):
        assert argv[1] == "acp", argv
        self.argvs.append(argv)
        self.envs.append(env)
        p = FakeAcp(self.handle)
        self.procs.append(p)
        return p

    def http(self, port, password):
        h = FakeHttp(port, password)
        self.https.append(h)
        return h

    def handle(self, p, msg):
        m = msg.get("method")
        if m == "initialize":
            p.reply(msg, {"protocolVersion": 1, "agentInfo": {"name": "OpenCode", "version": "1.18.32"}})
        elif m == "session/new":
            self.sessions += 1
            sid = f"ses_test{self.sessions:04d}xyz"
            p.reply(msg, {"sessionId": sid, "configOptions": config()})
            p.update(sid, {"sessionUpdate": "available_commands_update", "availableCommands": [{"name": "init", "description": "create AGENTS.md"}]})
        elif m in ("session/resume", "session/load"):
            p.reply(msg, {"configOptions": config()})
        elif m == "session/set_config_option":
            v, sid = msg["params"]["value"], msg["params"]["sessionId"]
            if msg["params"]["configId"] == "model" and v == "nope/none":
                p.push({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32602, "message": "model not found"}})
                return
            if msg["params"]["configId"] == "model":
                self.model[sid] = v
            p.reply(msg, {"configOptions": config(self.model.get(sid, "deepseek/deepseek-chat"))})
        elif m == "session/prompt":
            script = self.turns.pop(0) if self.turns else (lambda p, msg: p.reply(msg, {"stopReason": "end_turn"}))
            threading.Thread(target=script, args=(p, msg), daemon=True).start()
        elif m == "session/close":
            p.reply(msg, {})


class Base(unittest.TestCase):
    def setUp(self):
        self.server = Server()
        self.hub = O.OpenCodeHub(spawn=self.server.spawn, binary="opencode", rpc_timeout=5, http=self.server.http)
        self.events = []
        self.addCleanup(self.hub.shutdown)

    def adapter(self, **options):
        a = O.OpenCodeAdapter(None, None, "/tmp/proj", options, hub=self.hub)
        a.emit = lambda ev, **f: self.events.append(dict(f, ev=ev, session=a.session))
        return a

    def pump(self, a, until, timeout=5):
        end = time.time() + timeout
        while time.time() < end:
            a.drain()
            if until():
                return
            time.sleep(0.01)
        self.fail(f"timed out; events: {[e['ev'] for e in self.events]}")

    def evs(self, name):
        return [e for e in self.events if e["ev"] == name]

    def started(self, **options):
        a = self.adapter(**options)
        a.start()
        self.pump(a, lambda: self.evs("opened"))
        return a


class Sessions(Base):
    def test_new_session_is_named_by_opencode(self):
        a = self.started()
        opened = self.evs("opened")[0]
        self.assertEqual(a.session, "opencode:ses_test0001xyz")
        self.assertEqual(opened["session"], "opencode:ses_test0001xyz")
        self.assertEqual((opened["agent"], opened["model"], opened["resumed"], opened["permission_mode"]), ("opencode", "deepseek/deepseek-chat", False, ""))
        self.assertIn("set_model", opened["capabilities"])
        self.assertEqual(self.evs("state")[-1]["lifecycle"], "idle")
        self.pump(a, lambda: self.evs("commands"))
        self.assertEqual(a.commands(), [{"name": "init", "description": "create AGENTS.md", "kind": "command"}])
        self.assertEqual(cp.split_key(a.session), ("opencode", "ses_test0001xyz"))
        self.assertEqual(self.server.procs[0].methods()[:2], ["initialize", "session/new"])

    def test_resume_and_model(self):
        a = self.adapter(model="zhipuai-coding-plan/glm-5.3-flash")
        a.start(resume="ses_old123")
        self.pump(a, lambda: self.evs("opened"))
        self.assertTrue(self.evs("opened")[0]["resumed"])
        self.assertEqual(a.session, "opencode:ses_old123")
        sent = self.server.procs[0].sent
        resume = next(m for m in sent if m.get("method") == "session/resume")
        self.assertEqual(resume["params"], {"sessionId": "ses_old123", "cwd": "/tmp/proj", "mcpServers": []})
        model = next(m for m in sent if m.get("method") == "session/set_config_option")
        self.assertEqual(model["params"], {"sessionId": "ses_old123", "configId": "model", "value": "zhipuai-coding-plan/glm-5.3-flash"})
        self.assertEqual(self.evs("opened")[0]["model"], "zhipuai-coding-plan/glm-5.3-flash")

    def test_an_unknown_model_fails_the_start(self):
        a = self.adapter(model="nope/none")
        a.start()
        self.pump(a, lambda: self.evs("error"))
        self.assertEqual((self.evs("error")[0]["code"], self.evs("error")[0]["fatal"]), ("invalid_model", True))
        self.assertFalse(a.alive())

    def test_close_releases_the_session(self):
        a = self.started()
        a.close()
        self.assertEqual(self.evs("closed")[0]["reason"], "requested")
        time.sleep(0.05)
        self.assertIn("session/close", self.server.procs[0].methods())
        self.assertFalse(a.alive())


class Turns(Base):
    def test_a_turn_as_protocol_events(self):
        def script(p, msg):
            sid = msg["params"]["sessionId"]
            p.update(sid, {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "Let me look."}})
            p.update(sid, {"sessionUpdate": "tool_call", "toolCallId": "call_1", "title": "bash", "kind": "execute", "status": "pending", "rawInput": {}})
            p.update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "call_1", "status": "in_progress", "kind": "execute",
                           "title": "List files", "rawInput": {"command": "ls app", "description": "List files"}})
            p.update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "call_1", "status": "completed",
                           "content": [{"type": "content", "content": {"type": "text", "text": "cli\nsrc\n"}}],
                           "rawOutput": {"output": "cli\nsrc\n", "metadata": {"exit": 0}}})
            p.update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Two "}})
            p.update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "folders."}})
            time.sleep(0.05)
            p.reply(msg, {"stopReason": "end_turn", "usage": {"inputTokens": 1200, "outputTokens": 40, "cachedReadTokens": 800, "totalTokens": 2040}})
        self.server.turns.append(script)
        a = self.started()
        a.send({"message_id": "m1", "text": "What is in app?"})
        self.assertEqual(self.evs("turn_started")[0]["text"], "What is in app?")
        self.assertEqual(a.lifecycle, "running")
        self.pump(a, lambda: self.evs("turn_done"))
        names = [e["ev"] for e in self.events if e["ev"] not in ("opened", "state", "commands")]
        self.assertEqual(names, ["turn_started", "thinking_delta", "thinking_done", "tool_start", "tool_end", "text_delta", "text_delta", "life_usage", "text_done", "turn_done"])
        start = self.evs("tool_start")[0]
        self.assertEqual((start["name"], start["kind"], start["input"]["command"], start["summary"]), ("Bash", "shell", "ls app", "Running ls app"))
        end = self.evs("tool_end")[0]
        self.assertEqual((end["ok"], end["output"], end["exit_code"]), (True, "cli\nsrc\n", 0))
        self.assertEqual(self.evs("text_done")[0]["text"], "Two folders.")
        done = self.evs("turn_done")[0]
        self.assertEqual((done["status"], done["num_tools"], done["usage"]), ("success", 1, {"input": 1200, "output": 40, "cache_read": 800}))
        self.assertEqual(self.evs("state")[-1]["lifecycle"], "idle")
        prompt = next(m for m in self.server.procs[0].sent if m.get("method") == "session/prompt")
        self.assertEqual(prompt["params"]["prompt"], [{"type": "text", "text": "What is in app?"}])
        with self.assertRaises(cp.ChatError):
            a.interrupt()  # idle

    def test_one_turn_at_a_time(self):
        gate = threading.Event()
        self.server.turns.append(lambda p, msg: (gate.wait(5), p.reply(msg, {"stopReason": "end_turn"})))
        a = self.started()
        a.send({"message_id": "m1", "text": "one"})
        with self.assertRaises(cp.ChatError) as e:
            a.send({"message_id": "m2", "text": "two"})
        self.assertEqual(e.exception.code, "session_busy")
        gate.set()
        self.pump(a, lambda: self.evs("turn_done"))

    def test_stop_cancels_the_turn(self):
        def script(p, msg):
            sid = msg["params"]["sessionId"]
            p.update(sid, {"sessionUpdate": "tool_call", "toolCallId": "call_9", "title": "bash", "kind": "execute", "status": "pending",
                           "rawInput": {"command": "sleep 30"}})
            for _ in range(200):
                if "session/cancel" in p.methods():
                    break
                time.sleep(0.01)
            p.reply(msg, {"stopReason": "cancelled"})
        self.server.turns.append(script)
        a = self.started()
        a.send({"message_id": "m1", "text": "wait"})
        self.pump(a, lambda: self.evs("tool_start"))
        a.interrupt()
        self.pump(a, lambda: self.evs("turn_done"))
        self.assertEqual(self.evs("turn_done")[0]["status"], "interrupted")
        self.assertEqual(self.evs("tool_end")[0]["ok"], False)  # the command OpenCode never finished
        cancel = next(m for m in self.server.procs[0].sent if m.get("method") == "session/cancel")
        self.assertNotIn("id", cancel)  # a notification

    def test_images_go_as_image_blocks(self):
        a = self.started()
        a.send({"message_id": "m1", "text": "look", "images": [{"media_type": "image/png", "data": "iVBORw0KGgo="}]})
        self.pump(a, lambda: self.evs("turn_done"))
        prompt = next(m for m in self.server.procs[0].sent if m.get("method") == "session/prompt")
        self.assertEqual(prompt["params"]["prompt"][1], {"type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo="})


class Permissions(Base):
    def ask(self, p, msg, answer):
        sid = msg["params"]["sessionId"]
        p.update(sid, {"sessionUpdate": "tool_call", "toolCallId": "call_w", "title": "write", "kind": "edit", "status": "pending",
                       "rawInput": {"filePath": "/tmp/proj/notes.txt", "content": "hi\n"}})
        p.push({"jsonrpc": "2.0", "id": 900, "method": "session/request_permission", "params": {
            "sessionId": sid, "toolCall": {"toolCallId": "call_w", "title": "notes.txt", "kind": "edit", "rawInput": {"filePath": "/tmp/proj/notes.txt"}},
            "options": [{"optionId": "once", "kind": "allow_once", "name": "Allow once"}, {"optionId": "always", "kind": "allow_always", "name": "Always allow"},
                        {"optionId": "reject", "kind": "reject_once", "name": "Reject"}]}})
        for _ in range(300):
            got = next((m for m in p.sent if m.get("id") == 900 and "result" in m), None)
            if got:
                answer.append(got["result"])
                break
            time.sleep(0.01)
        p.reply(msg, {"stopReason": "end_turn"})

    def test_asks_and_answers_with_the_option_picked(self):
        answer = []
        self.server.turns.append(lambda p, msg: self.ask(p, msg, answer))
        a = self.started()
        a.send({"message_id": "m1", "text": "write notes"})
        self.pump(a, lambda: self.evs("permission_request"))
        req = self.evs("permission_request")[0]
        self.assertEqual((req["kind"], req["tool_name"], req["tool_id"], req["options"]), ("edit", "Write", "call_w", ["allow", "allow_session", "deny"]))
        self.assertEqual(req["summary"], "Editing notes.txt")
        self.assertEqual(a.lifecycle, "waiting_permission")
        self.assertEqual(a.state()["pending"], [req["permission_id"]])
        a.permission(req["permission_id"], "allow_session")
        self.pump(a, lambda: self.evs("turn_done"))
        self.assertEqual(answer, [{"outcome": {"outcome": "selected", "optionId": "always"}}])
        self.assertEqual(self.evs("permission_resolved")[0]["decision"], "allow_session")

    def test_unattended_sessions_answer_yes_themselves(self):
        answer = []
        self.server.turns.append(lambda p, msg: self.ask(p, msg, answer))
        a = self.started(permission_mode="bypassPermissions")
        self.assertEqual(self.evs("opened")[0]["permission_mode"], "bypassPermissions")
        a.send({"message_id": "m1", "text": "write notes"})
        self.pump(a, lambda: self.evs("turn_done"))
        self.assertEqual(answer, [{"outcome": {"outcome": "selected", "optionId": "once"}}])
        self.assertEqual(self.evs("permission_request"), [])

    def test_stop_while_asking_cancels_the_question(self):
        answer = []
        self.server.turns.append(lambda p, msg: self.ask(p, msg, answer))
        a = self.started()
        a.send({"message_id": "m1", "text": "write notes"})
        self.pump(a, lambda: self.evs("permission_request"))
        a.interrupt()
        self.pump(a, lambda: self.evs("turn_done"))
        self.assertEqual(answer, [{"outcome": {"outcome": "cancelled"}}])
        self.assertEqual(self.evs("permission_resolved")[0]["by"], "interrupt")


class Questions(Base):
    """OpenCode's question tool: its server's question.asked is a question card; the answer (or a no)
    goes back to /question/<id>/reply (/reject)."""

    def asking(self, p, msg, questions=None, finish=True):
        sid = msg["params"]["sessionId"]
        p.update(sid, {"sessionUpdate": "tool_call", "toolCallId": "call_q", "title": "question", "kind": "other", "status": "pending", "rawInput": {}})
        p.update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "call_q", "status": "in_progress", "rawInput": {"questions": questions or COLOR}})
        http = self.server.https[-1]
        http.ask(sid, questions=questions)
        http.wait_post(5)
        if finish:
            p.reply(msg, {"stopReason": "end_turn"})

    def test_the_process_starts_with_the_question_tool_and_a_server_of_ours(self):
        a = self.started()
        argv, env = self.server.argvs[0], self.server.envs[0]
        self.assertEqual(argv[1:4], ["acp", "--hostname", "127.0.0.1"])
        port = int(argv[argv.index("--port") + 1])
        self.assertEqual(env["OPENCODE_ENABLE_QUESTION_TOOL"], "1")
        http = self.server.https[0]
        self.assertEqual((http.port, http.password), (port, env["OPENCODE_SERVER_PASSWORD"]))
        self.assertGreaterEqual(len(env["OPENCODE_SERVER_PASSWORD"]), 32)
        a.close()

    def test_a_question_is_a_question_card_and_the_answer_goes_back(self):
        self.server.turns.append(lambda p, msg: self.asking(p, msg))
        a = self.started()
        a.send({"message_id": "m1", "text": "ask me"})
        self.pump(a, lambda: self.evs("permission_request"))
        req = self.evs("permission_request")[0]
        self.assertEqual((req["kind"], req["tool_name"], req["tool_id"], req["options"], req["summary"]), ("question", "AskUserQuestion", "call_q", ["deny"], "Which color?"))
        self.assertEqual(req["questions"], [{"id": "Which color?", "text": "Which color?", "options": ["Red", "Blue"], "multi": False}])
        self.assertEqual(req["input"]["questions"][0], {"question": "Which color?", "header": "Color", "options": [{"label": "Red", "description": "warm"}, {"label": "Blue", "description": "cool"}], "multiSelect": False})
        self.assertEqual(a.lifecycle, "waiting_input")
        # the tool row reads as Claude Code's AskUserQuestion: a question, "Waiting for your answer"
        start = next(e for e in self.evs("tool_start") if e["tool_id"] == "call_q")
        self.assertEqual((start["name"], start["kind"], start["summary"]), ("AskUserQuestion", "question", "Waiting for your answer"))
        with self.assertRaises(cp.ChatError):
            a.permission(req["permission_id"], "allow")  # an allow without answers means nothing
        a.answer(req["permission_id"], {"Which color?": ["Blue"]})
        self.assertEqual(self.server.https[0].posts[-1], ("/question/que_1/reply", {"answers": [["Blue"]]}, "/tmp/proj"))
        self.assertEqual(self.evs("permission_resolved")[-1]["decision"], "answered")
        self.pump(a, lambda: self.evs("turn_done"))
        self.assertEqual(self.evs("turn_done")[0]["status"], "success")

    def test_answers_by_position_or_header_several_questions_several_labels(self):
        qs = COLOR + [{"question": "Which sizes?", "header": "Sizes", "multiple": True, "options": [{"label": "S", "description": ""}, {"label": "M", "description": ""}]},
                      {"question": "Anything else?", "header": "More", "options": []}]
        self.server.turns.append(lambda p, msg: self.asking(p, msg, qs))
        a = self.started()
        a.send({"message_id": "m1", "text": "ask me"})
        self.pump(a, lambda: self.evs("permission_request"))
        req = self.evs("permission_request")[0]
        self.assertEqual([q["multi"] for q in req["questions"]], [False, True, False])
        a.answer(req["permission_id"], {"0": "Red", "Sizes": ["S", "M"]})
        self.assertEqual(self.server.https[0].posts[-1][1], {"answers": [["Red"], ["S", "M"], []]})

    def test_deny_refuses_the_question(self):
        self.server.turns.append(lambda p, msg: self.asking(p, msg))
        a = self.started()
        a.send({"message_id": "m1", "text": "ask me"})
        self.pump(a, lambda: self.evs("permission_request"))
        a.permission(self.evs("permission_request")[0]["permission_id"], "deny")
        self.assertEqual(self.server.https[0].posts[-1], ("/question/que_1/reject", None, "/tmp/proj"))
        self.assertEqual(self.evs("permission_resolved")[-1]["decision"], "deny")

    def test_stop_while_asking_refuses_the_question(self):
        self.server.turns.append(lambda p, msg: self.asking(p, msg, finish=False))
        a = self.started()
        a.send({"message_id": "m1", "text": "ask me"})
        self.pump(a, lambda: self.evs("permission_request"))
        a.interrupt()
        self.assertEqual(self.server.https[0].posts[-1][0], "/question/que_1/reject")
        self.assertEqual(self.evs("permission_resolved")[-1]["by"], "interrupt")
        self.assertIn("session/cancel", self.server.procs[0].methods())

    def test_answered_elsewhere_resolves_the_card(self):
        self.server.turns.append(lambda p, msg: self.asking(p, msg, finish=False))
        a = self.started()
        a.send({"message_id": "m1", "text": "ask me"})
        self.pump(a, lambda: self.evs("permission_request"))
        sid = a.session_id
        self.server.https[0].push("question.rejected", {"sessionID": sid, "requestID": "que_1"})
        self.pump(a, lambda: self.evs("permission_resolved"))
        self.assertEqual((self.evs("permission_resolved")[0]["decision"], self.evs("permission_resolved")[0]["by"]), ("deny", "elsewhere"))
        self.assertEqual(a.lifecycle, "running")

    def test_unattended_sessions_and_strangers_questions_are_refused(self):
        self.server.turns.append(lambda p, msg: self.asking(p, msg))
        a = self.started(permission_mode="bypassPermissions")
        a.send({"message_id": "m1", "text": "ask me"})
        self.pump(a, lambda: self.evs("turn_done"))
        self.assertEqual(self.evs("permission_request"), [])
        self.assertEqual(self.server.https[0].posts[-1][0], "/question/que_1/reject")
        # a session no adapter of ours has: OpenCode must not wait on it
        self.server.https[0].ask("ses_someoneelse", qid="que_9")
        end = time.time() + 3
        while time.time() < end and self.server.https[0].posts[-1][0] != "/question/que_9/reject":
            time.sleep(0.01)
        self.assertEqual(self.server.https[0].posts[-1][0], "/question/que_9/reject")


class Process(Base):
    def test_a_dead_process_ends_the_turn_and_the_next_message_resumes(self):
        self.server.turns.append(lambda p, msg: p.die())
        a = self.started()
        a.send({"message_id": "m1", "text": "hi"})
        self.pump(a, lambda: self.evs("turn_done"))
        self.assertEqual(self.evs("turn_done")[0]["status"], "error")
        self.assertEqual(self.evs("error")[-1]["code"], "process_exited")
        a.send({"message_id": "m2", "text": "again"})
        self.pump(a, lambda: len(self.evs("turn_done")) == 2)
        self.assertEqual(self.evs("turn_done")[1]["status"], "success")
        self.assertEqual(len(self.server.procs), 2)
        # a new process has forgotten the session's model: it is set again before the prompt
        self.assertEqual(self.server.procs[1].methods()[:4], ["initialize", "session/resume", "session/set_config_option", "session/prompt"])

    def test_a_new_model_is_set_before_the_next_prompt(self):
        a = self.started()
        a.set_model("zhipuai-coding-plan/glm-5.3-flash", effort="high")
        with self.assertRaises(cp.ChatError):
            a.set_model("sonnet")  # not provider/model
        with self.assertRaises(cp.ChatError) as e:
            a.set_model("deepseek/not-listed")  # OpenCode does not list it
        self.assertEqual(e.exception.code, "invalid_model")
        a.send({"message_id": "m1", "text": "hi"})
        self.pump(a, lambda: self.evs("turn_done"))
        sent = [m for m in self.server.procs[0].sent if m.get("method") in ("session/set_config_option", "session/prompt")]
        self.assertEqual([(m["method"], m["params"].get("configId"), m["params"].get("value")) for m in sent],
                         [("session/set_config_option", "model", "zhipuai-coding-plan/glm-5.3-flash"), ("session/set_config_option", "effort", "high"), ("session/prompt", None, None)])
        self.assertEqual(a.state()["model"], "zhipuai-coding-plan/glm-5.3-flash")


class VersionGate(unittest.TestCase):
    """chatd runs the first opencode that is new enough, not the first one on the path."""

    def setUp(self):
        import stat
        import tempfile
        self.tmp = tempfile.mkdtemp()
        self.dirs = []
        for name, version in (("old", "1.14.31"), ("new", "1.18.32")):
            d = os.path.join(self.tmp, name)
            os.makedirs(d)
            f = os.path.join(d, "opencode")
            with open(f, "w") as fh:
                fh.write(f"#!/bin/sh\necho {version}\n")
            os.chmod(f, os.stat(f).st_mode | stat.S_IXUSR)
            self.dirs.append(d)
        self.env = {"PATH": os.pathsep.join(self.dirs), "DISPATCH_IDE_BIN": ""}

    def probe(self, dirs):
        from unittest import mock
        import engines
        env_path = os.pathsep.join(dirs)
        env = {"PATH": env_path, "DISPATCH_IDE_BIN": ""}
        with mock.patch.dict(os.environ, env), mock.patch.object(engines, "HOME", self.tmp), mock.patch.object(engines, "search_path", lambda env=None: env_path), mock.patch.object(O, "_is_win", return_value=False):
            return O.probe(), O._which()

    def test_minimum_comes_from_the_engine_table(self):
        import engines
        self.assertEqual(O.MIN_VERSION, engines.get("opencode").min_version)

    def test_older_copy_in_front_does_not_shadow_the_new_one(self):
        probe, path = self.probe(self.dirs)
        self.assertEqual(path, os.path.join(self.dirs[1], "opencode"))
        self.assertEqual((probe["version"], probe["supported"]), ("1.18.32", True))

    def test_only_an_old_copy_is_reported_unsupported(self):
        probe, path = self.probe(self.dirs[:1])
        self.assertEqual(path, os.path.join(self.dirs[0], "opencode"))
        self.assertFalse(probe["supported"])
        self.assertEqual(probe["reason"], "opencode 1.14.31 is older than 1.18.0")


class Tools(unittest.TestCase):
    def test_opencode_tools_read_as_claude_codes(self):
        cases = [
            ({"sessionUpdate": "tool_call", "title": "read", "kind": "read", "rawInput": {"filePath": "/r/DESIGN.md"}}, ("Read", {"file_path": "/r/DESIGN.md"})),
            ({"sessionUpdate": "tool_call", "title": "grep", "kind": "search", "rawInput": {"pattern": "TODO", "path": "src"}}, ("Grep", {"pattern": "TODO", "path": "src"})),
            ({"sessionUpdate": "tool_call", "title": "webfetch", "kind": "fetch", "rawInput": {"url": "https://x.dev"}}, ("WebFetch", {"url": "https://x.dev"})),
            ({"sessionUpdate": "tool_call_update", "title": "Search the web", "kind": "fetch", "rawInput": {"query": "acp"}}, ("WebSearch", {"query": "acp"})),
            ({"sessionUpdate": "tool_call_update", "title": "notes.txt", "kind": "edit", "rawInput": {"filePath": "/r/n.txt", "oldString": "a", "newString": "b"}}, ("Edit", {"file_path": "/r/n.txt"})),
        ]
        for update, (name, inp) in cases:
            got = O.tool_view(update)
            self.assertEqual(got[0], name, update)
            for k, v in inp.items():
                self.assertEqual(got[1][k], v)
        first = O.tool_view({"sessionUpdate": "tool_call", "title": "bash", "kind": "execute", "rawInput": {}})
        later = O.tool_view({"sessionUpdate": "tool_call_update", "title": "List files", "rawInput": {"command": "ls"}}, first)
        self.assertEqual((later[0], later[1]["command"], later[2]), ("Bash", "ls", "bash"))
        self.assertEqual(O.tool_view({"sessionUpdate": "tool_call_update", "status": "completed"}, later), later)

    def test_opencodes_question_tool_reads_as_ask_user_question(self):
        got = O.tool_view({"sessionUpdate": "tool_call_update", "title": "question", "kind": "other", "rawInput": {"questions": COLOR}},
                          O.tool_view({"sessionUpdate": "tool_call", "title": "question", "kind": "other", "rawInput": {}}))
        self.assertEqual((got[0], cp.tool_kind(got[0]), cp.step_phrase(got[0], got[1])), ("AskUserQuestion", "question", "Waiting for your answer"))
        self.assertEqual(got[1]["questions"][0]["multiSelect"], False)
        self.assertEqual(O.question_cards([{"question": "", "header": "Pick"}, {"question": "", "header": "Pick"}]),
                         [{"id": "Pick", "text": "Pick", "options": [], "multi": False}, {"id": "Pick (2)", "text": "Pick", "options": [], "multi": False}])

    def test_keys_allow_opencodes_ids(self):
        self.assertEqual(cp.session_key("opencode", "ses_2c4f9a1b3effeEFbhCpt"), "opencode:ses_2c4f9a1b3effeEFbhCpt")
        self.assertEqual(cp.validate_command({"cmd": "open", "agent": "opencode", "cwd": "/x"}), "open")


if __name__ == "__main__":
    unittest.main()
