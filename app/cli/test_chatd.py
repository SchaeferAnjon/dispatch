# -*- coding: utf-8 -*-
"""chatd's session table, queue, replies, replay, registry and reaper, driven with a scripted
adapter (no agent process runs here)."""
import json
import os
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import chat_protocol as cp
import chatd

WINDOWS_READY = True
SUPPORTED = {"available": True, "version": "9.9.9", "supported": True, "reason": ""}


class FakeAdapter(cp.Adapter):
    """Opens on the first drain; a turn runs until the test calls finish()."""
    agent = "claude-code"
    capabilities = ("queue", "set_model")
    made = []

    def __init__(self, emit, session, cwd, options):
        super().__init__(emit, session, cwd, options)
        self.sent, self.closed_with, self.interrupts = [], None, 0
        self.resumed = None
        self._open_pending = False
        self._finish_on_drain = None
        FakeAdapter.made.append(self)

    def start(self, resume=None):
        self.resumed = resume
        self.lifecycle = "starting"
        self._open_pending = True
        self.emit("state", **self.state())

    def drain(self):
        if self._open_pending:
            self._open_pending = False
            self.lifecycle = "idle"
            self.emit("opened", agent=self.agent, cwd=self.cwd, resumed=bool(self.resumed), model="m", permission_mode="default", transcript_path="/t.jsonl", capabilities=list(self.capabilities))
            self.emit("state", **self.state())
            return True
        if self._finish_on_drain:
            status, self._finish_on_drain = self._finish_on_drain, None
            self.finish(status)
            return True
        return False

    def send(self, message):
        assert self.lifecycle == "idle", self.lifecycle
        self.sent.append(message)
        self.turn_id = f"t{len(self.sent)}"
        self.lifecycle = "running"
        self.emit("turn_started", turn_id=self.turn_id, message_id=message["message_id"], text=message["text"], images_n=len(message.get("images") or []))
        self.emit("text_delta", turn_id=self.turn_id, text="hel")

    def finish(self, status="success"):
        t, self.turn_id = self.turn_id, None
        self.emit("text_done", turn_id=t, text="hello")
        self.lifecycle = "idle"
        self.emit("turn_done", turn_id=t, status=status, duration_ms=5, num_tools=0)
        self.emit("state", **self.state())

    def interrupt(self):
        if not self.turn_id:
            raise cp.ChatError("not_running", "idle")
        self.interrupts += 1
        self._finish_on_drain = "interrupted"

    def permission(self, permission_id, decision, message=None, updated_input=None):
        self.emit("permission_resolved", permission_id=permission_id, decision=decision, by="dispatch")

    def close(self, reason="requested"):
        self.closed_with = reason
        self.lifecycle = "stopped"
        self.emit("closed", reason=reason, exit_code=0)

    def alive(self):
        return self.lifecycle not in ("stopped", "error")

    def state(self):
        return dict(super().state(), pid=os.getpid() if self.alive() else None)


class FakeCheckpoints:
    """checkpoint.py as chatd sees it, without git: records the calls."""
    SLOW_SNAPSHOT = 3.0

    def __init__(self):
        self.calls, self.n, self.notes = [], 0, {}

    def begin(self, cwd, sid="", message_id="", text="", base=None):
        self.n += 1
        self.calls.append(("begin", message_id, text))
        return {"turn_id": f"cp-{self.n}", "ms": 5, "root": cwd}

    def finish(self, cwd, turn_id, agent_turn_id="", base=None):
        self.calls.append(("finish", turn_id, agent_turn_id))

    def discard(self, cwd, turn_id, base=None):
        self.calls.append(("discard", turn_id))

    def take_notes(self, sid, base=None):
        return self.notes.pop(sid, [])

    def gc_all(self, base=None, force=False):
        self.calls.append(("gc",))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.work = os.path.join(self.tmp.name, "work"); os.mkdir(self.work)
        self.sess_dir = os.path.join(self.tmp.name, "sessions"); os.mkdir(self.sess_dir)
        self.d = SimpleNamespace(HOME=self.tmp.name, DISPATCH_DIR=self.tmp.name, SESS_DIR=self.sess_dir, live_sessions=lambda local_only=False: [])
        self.lines = []
        self.now = [1000.0]
        FakeAdapter.made = []
        for p in (patch.object(chatd.Chatd, "adapter_class", lambda self, agent: FakeAdapter),
                  patch.object(chatd, "_probe", lambda agent: dict(SUPPORTED))):
            p.start(); self.addCleanup(p.stop)
        self.c = chatd.Chatd(self.lines.append, d=self.d, clock=lambda: self.now[0])
        self.cps = FakeCheckpoints()
        self.c.checkpoints = lambda: self.cps
        self.c.background = lambda fn: fn()

    @property
    def events(self):
        return [json.loads(l) for l in self.lines]

    def cmd(self, **o):
        self.c.handle_line(json.dumps(o))
        return self.events

    def reply(self, rid):
        hits = [e for e in self.events if e.get("request_id") == rid]
        self.assertEqual(len(hits), 1, f"{rid}: {hits}")
        return hits[0]

    def open(self, rid="r-open", **kw):
        self.cmd(cmd="open", request_id=rid, agent="claude-code", cwd=self.work, **kw)
        return self.reply(rid)

    def registry(self):
        with open(os.path.join(self.tmp.name, "chatd.json")) as f:
            return json.load(f)


class Naming(Base):
    def test_first_turn_asks_for_a_short_name_once_off_the_loop(self):
        asked, jobs = [], []
        self.d.name_session = lambda key, text, path: asked.append((key, text, path))
        self.c.spawn = jobs.append
        key = self.open()["session"]
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="帮我看一下 tmp")
        self.assertEqual(asked, [])          # nothing ran on the loop itself
        self.assertEqual(len(jobs), 1)
        jobs[0]()
        self.assertEqual(asked, [(key, "帮我看一下 tmp", "")])
        FakeAdapter.made[-1].finish()
        self.cmd(cmd="send", request_id="s2", session=key, message_id="m2", text="再来")
        self.assertEqual(len(jobs), 1)       # once per session and run

    def test_a_failing_namer_never_reaches_the_loop(self):
        self.d.name_session = lambda *a: 1 / 0
        self.c.spawn = lambda fn: fn()
        key = self.open()["session"]
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="hi")
        self.assertEqual(self.reply("s1")["ev"], "turn_started")


class OpenAndSend(Base):
    def test_open_replies_opened_then_state_and_writes_the_registry(self):
        o = self.open()
        self.assertEqual(o["ev"], "opened")
        agent, sid = cp.split_key(o["session"])
        self.assertEqual(agent, "claude-code")
        self.assertEqual(len(sid), 36)  # chatd made the uuid for --session-id
        evs = [e["ev"] for e in self.events if e.get("session") == o["session"]]
        self.assertEqual(evs[-2:], ["opened", "state"])
        self.assertEqual(self.events[-1]["lifecycle"], "idle")
        self.assertEqual(self.events[-1]["queue"], [])
        reg = self.registry()
        self.assertEqual(reg["pid"], os.getpid())
        self.assertEqual(reg["sessions"][o["session"]]["lifecycle"], "idle")
        self.assertEqual(reg["sessions"][o["session"]]["cwd"], os.path.realpath(self.work))
        self.assertEqual(chatd.read_registry(self.tmp.name)["sessions"].keys(), reg["sessions"].keys())

    def test_open_rejects_a_missing_folder_and_unsupported_agents(self):
        self.cmd(cmd="open", request_id="r1", agent="claude-code", cwd="/nonexistent-dispatch-dir")
        self.assertEqual(self.reply("r1")["code"], "bad_request")
        with patch.object(chatd, "_probe", lambda agent: {"available": True, "version": "1.0.0", "supported": False, "reason": "too old"}):
            self.c._probes.clear()
            self.cmd(cmd="open", request_id="r2", agent="claude-code", cwd=self.work)
        e = self.reply("r2")
        self.assertEqual((e["code"], e["message"], e["fatal"]), ("unsupported_version", "too old", True))
        self.assertEqual(self.c.sessions, {})

    def test_idle_send_starts_a_turn_and_busy_send_queues(self):
        key = self.open()["session"]
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="first")
        self.assertEqual(self.reply("s1")["ev"], "turn_started")
        self.cmd(cmd="send", request_id="s2", session=key, message_id="m2", text="second")
        q = self.reply("s2")
        self.assertEqual((q["ev"], q["message_id"], q["position"]), ("queued", "m2", 1))
        self.assertEqual(self.events[-1]["ev"], "queue")
        self.assertEqual([x["message_id"] for x in self.events[-1]["queue"]], ["m2"])
        a = FakeAdapter.made[-1]
        a.finish()
        self.c.tick()
        # turn_done, then the queue's head goes out by itself
        evs = [e["ev"] for e in self.events]
        self.assertLess(evs.index("turn_done"), len(evs) - 1 - evs[::-1].index("turn_started"))
        self.assertEqual([m["message_id"] for m in a.sent], ["m1", "m2"])
        self.assertEqual(next(e for e in reversed(self.events) if e["ev"] == "queue")["queue"], [])

    def test_note_replies_a_notice_and_prefixes_the_next_send_only(self):
        key = self.open()["session"]
        self.cmd(cmd="note", request_id="n1", session=key, text="你撤销了 a.py 第 1 处（第 3 行）")
        e = self.reply("n1")
        self.assertEqual((e["ev"], e["kind"], e["text"], e["session"]), ("system", "notice", "你撤销了 a.py 第 1 处（第 3 行）", key))
        self.cmd(cmd="note", request_id="n2", session=key, text="你撤销了 b.py 第 2 处")
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="继续")
        a = FakeAdapter.made[-1]
        self.assertEqual(a.sent[0]["text"], "[system] 你撤销了 a.py 第 1 处（第 3 行）\n[system] 你撤销了 b.py 第 2 处\n\n继续")
        # the bubble shows what the person typed
        started = self.reply("s1")
        self.assertEqual((started["ev"], started["text"]), ("turn_started", "继续"))
        self.assertEqual(self.c.sessions[key].notes, [])
        a.finish(); self.c.tick()
        self.cmd(cmd="send", request_id="s2", session=key, message_id="m2", text="再来")
        self.assertEqual(a.sent[1]["text"], "再来")

    def test_a_note_while_busy_rides_on_the_queued_message(self):
        key = self.open()["session"]
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="first")
        self.cmd(cmd="note", request_id="n1", session=key, text="你撤销了 a.py 第 1 处")
        self.cmd(cmd="send", request_id="s2", session=key, message_id="m2", text="second")
        a = FakeAdapter.made[-1]
        a.finish(); self.c.tick()
        self.assertEqual([m["text"] for m in a.sent], ["first", "[system] 你撤销了 a.py 第 1 处\n\nsecond"])
        started = [e for e in self.events if e["ev"] == "turn_started"]
        self.assertEqual([e["text"] for e in started], ["first", "second"])

    def test_a_failed_send_keeps_the_notes_for_the_next_one(self):
        key = self.open()["session"]
        self.cmd(cmd="note", request_id="n1", session=key, text="你撤销了 a.py 第 1 处")
        a = FakeAdapter.made[-1]
        with patch.object(a, "send", side_effect=cp.ChatError("agent_crashed", "gone")):
            self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="x")
        self.assertEqual(self.reply("s1")["ev"], "error")
        self.assertEqual(self.c.sessions[key].notes, ["你撤销了 a.py 第 1 处"])

    def test_note_for_an_unknown_session_is_no_such_session(self):
        self.cmd(cmd="note", request_id="n1", session="claude-code:nope", text="hi")
        e = self.reply("n1")
        self.assertEqual((e["ev"], e["code"]), ("error", "no_such_session"))

    def test_edit_tools_snapshot_the_file_before_tool_start_goes_out(self):
        key = self.open()["session"]
        path = os.path.join(self.work, "a.py")
        with open(path, "w") as f:
            f.write("one\ntwo\n")
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="edit it")
        a = FakeAdapter.made[-1]
        seen = []
        real = chatd.Chatd.editor_hook
        def spy(this, k, sess, ev, fields):
            seen.append((ev, len(self.lines)))
            return real(this, k, sess, ev, fields)
        with patch.object(chatd.Chatd, "editor_hook", spy):
            a.emit("tool_start", turn_id=a.turn_id, tool_id="t1", name="Edit", kind="edit", input={"file_path": path, "old_string": "two", "new_string": "TWO"}, summary="a.py")
        # the hook ran before the tool_start line was written
        self.assertEqual(seen[0][0], "tool_start")
        self.assertFalse(any(json.loads(l)["ev"] == "tool_start" for l in self.lines[:seen[0][1]]))
        import editor
        snap = os.path.join(editor.sid_dir(key, self.tmp.name), "baseline", "a.py")
        with open(snap) as f:
            self.assertEqual(f.read(), "one\ntwo\n")
        # a late snapshot (the agent already wrote) is put right on tool_end
        with open(path, "w") as f:
            f.write("one\nTWO\n")
        with open(snap, "w") as f:
            f.write("one\nTWO\n")
        a.emit("tool_end", turn_id=a.turn_id, tool_id="t1", ok=True, output="", truncated=False, duration_ms=1, diff={"path": path, "kind": "edit", "old": "two", "new": "TWO"})
        with open(snap) as f:
            self.assertEqual(f.read(), "one\ntwo\n")
        # Codex fileChange paths, and a path outside the session folder is ignored
        a.emit("tool_start", turn_id=a.turn_id, tool_id="t2", name="fileChange", kind="edit", input={"changes": [{"path": os.path.join(self.work, "b.py"), "kind": "add"}, {"path": "/etc/hosts", "kind": "update"}]}, summary="")
        with open(os.path.join(editor.sid_dir(key, self.tmp.name), "index.json")) as f:
            idx = json.load(f)
        self.assertEqual(sorted(idx["files"]), ["a.py", "b.py"])
        self.assertFalse(idx["files"]["b.py"]["existed"])

    def test_a_broken_editor_module_never_stops_the_event(self):
        key = self.open()["session"]
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="edit it")
        a = FakeAdapter.made[-1]
        with patch.object(chatd.Chatd, "editor", side_effect=RuntimeError("boom")):
            a.emit("tool_start", turn_id=a.turn_id, tool_id="t1", name="Edit", kind="edit", input={"file_path": "x.py"}, summary="x")
        self.assertEqual(self.events[-1]["ev"], "tool_start")

    def test_set_model_is_answered_for_adapters_that_apply_it_later(self):
        # Codex applies a model or mode change on the next turn/start and emits no state itself.
        key = self.open()["session"]
        a = FakeAdapter.made[-1]
        a.state_on_set = False
        a.set_model = lambda model, effort=None: a.options.update(model=model)
        a.set_permission_mode = lambda mode: a.options.update(permission_mode=mode)
        self.cmd(cmd="set_model", request_id="sm", session=key, model="gpt-x")
        st = self.reply("sm")
        self.assertEqual((st["ev"], st["session"], st["queue"]), ("state", key, []))
        self.cmd(cmd="set_permission_mode", request_id="sp", session=key, mode="plan")
        self.assertEqual(self.reply("sp")["ev"], "state")
        self.assertEqual([w for w in self.c.waiters if w["request_id"] in ("sm", "sp")], [])

    def test_an_adapter_state_carries_chatds_queue(self):
        key = self.open()["session"]
        a = FakeAdapter.made[-1]
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="first")
        self.cmd(cmd="send", request_id="s2", session=key, message_id="m2", text="second")
        a.emit("state", **dict(a.state(), queue=[]))  # what a reconnecting Codex adapter sends
        self.assertEqual([q["message_id"] for q in self.events[-1]["queue"]], ["m2"])

    def test_send_mode_interrupt_stops_the_turn_then_sends(self):
        key = self.open()["session"]
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="long job")
        self.cmd(cmd="send", request_id="s2", session=key, message_id="m2", text="change of plan", mode="interrupt")
        a = FakeAdapter.made[-1]
        self.assertEqual(a.interrupts, 1)
        self.c.tick()
        done = next(e for e in self.events if e["ev"] == "turn_done")
        self.assertEqual(done["status"], "interrupted")
        started = self.reply("s2")  # its reply is its own turn_started
        self.assertEqual((started["ev"], started["message_id"]), ("turn_started", "m2"))
        self.assertGreater(started["seq"], done["seq"])
        self.assertFalse(any(e["ev"] == "queued" for e in self.events))

    def test_withdraw_takes_a_queued_message_back(self):
        key = self.open()["session"]
        self.cmd(cmd="send", session=key, message_id="m1", text="first")
        self.cmd(cmd="send", session=key, message_id="m2", text="second")
        self.cmd(cmd="withdraw", request_id="w1", session=key, message_id="m2")
        self.assertEqual(self.reply("w1")["queue"], [])
        self.cmd(cmd="withdraw", request_id="w2", session=key, message_id="m2")
        self.assertEqual(self.reply("w2")["ev"], "error")
        FakeAdapter.made[-1].finish(); self.c.tick()
        self.assertEqual([m["message_id"] for m in FakeAdapter.made[-1].sent], ["m1"])

    def test_interrupt_replies_with_turn_done_and_idle_interrupt_is_an_error(self):
        key = self.open()["session"]
        self.cmd(cmd="interrupt", request_id="i0", session=key)
        self.assertEqual(self.reply("i0")["code"], "not_running")
        self.cmd(cmd="send", session=key, message_id="m1", text="go")
        self.cmd(cmd="interrupt", request_id="i1", session=key)
        self.assertEqual(self.reply("i1")["ev"], "turn_done")

    def test_permission_reply_and_unknown_session(self):
        key = self.open()["session"]
        self.cmd(cmd="permission", request_id="p1", session=key, permission_id="x", decision="deny")
        self.assertEqual(self.reply("p1")["ev"], "permission_resolved")
        self.cmd(cmd="send", request_id="s9", session="claude-code:nobody-here", message_id="m", text="hi")
        self.assertEqual(self.reply("s9")["code"], "no_such_session")


class ReplayCloseConflict(Base):
    def test_replay_repeats_the_turn_verbatim_without_new_seqs(self):
        key = self.open()["session"]
        self.cmd(cmd="send", session=key, message_id="m1", text="first")
        before = list(self.lines)
        turn = [json.loads(l) for l in before if json.loads(l).get("ev") in ("turn_started", "text_delta")]
        self.cmd(cmd="replay", request_id="rp", session=key)
        new = [json.loads(l) for l in self.lines[len(before):]]
        replayed, state = new[:-1], new[-1]
        self.assertEqual([e["seq"] for e in replayed], [e["seq"] for e in turn])
        self.assertEqual(replayed, [{k: v for k, v in e.items() if k != "request_id"} for e in turn])
        self.assertEqual((state["ev"], state["request_id"]), ("state", "rp"))
        self.assertGreater(state["seq"], max(e["seq"] for e in self.events[:-1]))
        seqs = [e["seq"] for e in self.events if "seq" in e]
        fresh = [s for i, s in enumerate(seqs) if s not in seqs[:i]]
        self.assertEqual(fresh, sorted(fresh))  # every seq chatd handed out is new and increasing

    def test_close_replies_closed_and_forgets_the_session(self):
        key = self.open()["session"]
        self.cmd(cmd="close", request_id="c1", session=key, reason="requested")
        closed = self.reply("c1")
        self.assertEqual((closed["ev"], closed["reason"]), ("closed", "requested"))
        self.assertEqual(FakeAdapter.made[-1].closed_with, "requested")
        self.assertEqual(self.c.sessions, {})
        self.assertEqual(self.registry()["sessions"], {})
        self.cmd(cmd="close", request_id="c2", session=key)
        self.assertEqual(self.reply("c2")["code"], "no_such_session")

    def test_resume_refuses_while_a_terminal_holds_the_transcript(self):
        sid = "abcdef12-0000-4000-8000-000000000001"
        with open(os.path.join(self.sess_dir, f"claude-code__{sid}.json"), "w") as f:
            json.dump({"agent": "claude-code", "session_id": sid, "agent_pid": os.getppid(), "source_app": "Ghostty"}, f)
        self.cmd(cmd="open", request_id="o1", agent="claude-code", cwd=self.work, resume=sid)
        e = self.reply("o1")
        self.assertEqual(e["code"], "writer_conflict")
        self.assertIn(str(os.getppid()), e["message"]); self.assertIn("Ghostty", e["message"])
        self.assertEqual(FakeAdapter.made, [])
        # a dead pid is no conflict
        with open(os.path.join(self.sess_dir, f"claude-code__{sid}.json"), "w") as f:
            json.dump({"agent": "claude-code", "session_id": sid, "agent_pid": 999999}, f)
        self.cmd(cmd="open", request_id="o2", agent="claude-code", cwd=self.work, resume=sid)
        o = self.reply("o2")
        self.assertEqual((o["ev"], o["session"], o["resumed"]), ("opened", f"claude-code:{sid}", True))
        self.assertEqual(FakeAdapter.made[-1].resumed, sid)

    def test_resume_refuses_the_original_of_a_moved_conversation(self):
        # handoverToDispatch and ChatPage reopen go through `open {resume}`: it must not fork a moved conversation.
        sid = "abcdef12-0000-4000-8000-000000000002"
        self.d.load_moves = lambda: {f"claude-code:{sid}": {"moved_to": "hub", "at": 1}}
        self.d.host_label = lambda h: "小蓝"
        self.cmd(cmd="open", request_id="o1", agent="claude-code", cwd=self.work, resume=sid)
        e = self.reply("o1")
        self.assertEqual(e["code"], "moved_away"); self.assertIn("已迁到 小蓝", e["message"])
        self.assertEqual(FakeAdapter.made, [])
        self.d.load_moves = lambda: {f"claude-code:{sid}": {"moved_from": "mini", "at": 1}}  # the copy that took over resumes fine
        self.assertEqual(self.open(rid="o2", resume=sid)["ev"], "opened")

    def test_a_project_of_another_mac_neither_opens_nor_resumes_here(self):
        # dispatch-project-owners: a project's Agents start only on its own Mac, new or resumed.
        sid = "abcdef12-0000-4000-8000-000000000003"
        seen = []
        def elsewhere(cwd):
            seen.append(cwd)
            return {"project": "harbor", "host": "小蓝", "peer": {"id": "hub"}, "here": False}
        self.d.owner_elsewhere = elsewhere
        self.d.owner_refusal = lambda o, resume=False: f"项目 {o['project']} 归「{o['host']}」" + ("，先迁过去" if resume else "")
        e = self.open(rid="o1")
        self.assertEqual((e["ev"], e["code"]), ("error", "owner_elsewhere")); self.assertEqual(e["message"], "项目 harbor 归「小蓝」")
        e = self.open(rid="o2", resume=sid)
        self.assertEqual(e["code"], "owner_elsewhere"); self.assertIn("先迁过去", e["message"])
        self.assertEqual(FakeAdapter.made, [])
        self.assertEqual(os.path.realpath(seen[0]), os.path.realpath(self.work))
        self.d.owner_elsewhere = lambda cwd: None  # the project's own Mac
        self.assertEqual(self.open(rid="o3", resume=sid)["ev"], "opened")

    def test_a_reaped_session_is_not_restarted_once_its_project_belongs_elsewhere(self):
        key = self.open()["session"]
        self.cmd(cmd="send", session=key, message_id="m1", text="first")
        FakeAdapter.made[-1].finish(); self.c.tick()
        self.now[0] += cp.IDLE_REAP_SECONDS + chatd.REAP_EVERY + 1
        self.c.tick()
        self.d.owner_elsewhere = lambda cwd: {"project": "harbor", "host": "小蓝", "peer": None, "here": False}
        self.d.owner_refusal = lambda o, resume=False: "归小蓝" + ("，先迁过去" if resume else "")
        self.cmd(cmd="send", request_id="s2", session=key, message_id="m2", text="back again")
        e = self.reply("s2")
        self.assertEqual((e["code"], e["message"]), ("owner_elsewhere", "归小蓝，先迁过去"))
        self.assertEqual(len(FakeAdapter.made), 1)

    def test_live_sessions_scan_counts_too_but_not_our_own_child(self):
        sid = "abcdef12-0000-4000-8000-000000000002"
        rows = [{"agent": "claude-code", "session_id": sid, "agent_pid": os.getpid(), "source_app": "Dispatch"}]
        self.d.live_sessions = lambda local_only=False: rows
        self.cmd(cmd="open", request_id="o1", agent="claude-code", cwd=self.work, resume=sid)
        self.assertEqual(self.reply("o1")["ev"], "opened")  # chatd's own pid (the fake child) is not a conflict
        rows[0]["agent_pid"] = os.getppid()
        self.c.sessions.clear()
        self.cmd(cmd="open", request_id="o2", agent="claude-code", cwd=self.work, resume=sid)
        self.assertEqual(self.reply("o2")["code"], "writer_conflict")

    def test_idle_sessions_are_reaped_and_resumed_on_the_next_send(self):
        key = self.open()["session"]
        self.cmd(cmd="send", session=key, message_id="m1", text="first")
        FakeAdapter.made[-1].finish(); self.c.tick()
        self.now[0] += cp.IDLE_REAP_SECONDS + chatd.REAP_EVERY + 1
        self.c.tick()
        first = FakeAdapter.made[0]
        self.assertEqual(first.closed_with, "idle")
        closed = [e for e in self.events if e["ev"] == "closed"]
        self.assertEqual(closed[-1]["reason"], "idle")
        self.assertEqual(self.registry()["sessions"][key]["lifecycle"], "stopped")  # still Dispatch's
        self.cmd(cmd="send", request_id="s2", session=key, message_id="m2", text="back again")
        second = FakeAdapter.made[-1]
        self.assertIsNot(second, first)
        self.assertEqual(second.resumed, cp.split_key(key)[1])
        self.assertEqual([m["message_id"] for m in second.sent], ["m2"])
        self.assertEqual(self.reply("s2")["ev"], "turn_started")
        self.assertFalse(any(e["ev"] == "queue" and e["queue"] for e in self.events))  # a hidden wait, not a visible queue

    def test_open_then_close_leaves_nothing_in_the_registry(self):
        a = self.open("o1")["session"]
        b = self.open("o2")["session"]
        self.assertEqual(set(self.registry()["sessions"]), {a, b})
        self.cmd(cmd="close", request_id="c1", session=a)
        self.assertEqual(self.reply("c1")["ev"], "closed")
        self.assertEqual(set(self.registry()["sessions"]), {b})
        self.assertEqual(set(chatd.read_registry(self.tmp.name)["sessions"]), {b})
        self.assertNotIn(a, self.c.sessions)
        self.c.tick()  # the next tick does not bring it back
        self.assertNotIn(a, self.registry()["sessions"])
        self.cmd(cmd="list", request_id="l1")
        self.assertEqual([r["session"] for r in self.reply("l1")["sessions"]], [b])

    def test_closing_a_reaped_session_takes_it_out_of_the_registry(self):
        key = self.open()["session"]
        self.now[0] += cp.IDLE_REAP_SECONDS + chatd.REAP_EVERY + 1
        self.c.tick()
        self.assertEqual(self.registry()["sessions"][key]["lifecycle"], "stopped")
        self.cmd(cmd="close", request_id="c1", session=key)
        self.assertEqual(self.reply("c1")["ev"], "closed")
        self.assertEqual(self.registry()["sessions"], {})

    def test_idle_close_follows_the_setting(self):
        self.d.settings_load = lambda: {"chat_idle_close_minutes": 5}
        key = self.open()["session"]
        self.now[0] += 5 * 60 + chatd.REAP_EVERY + 1
        self.c.tick()
        self.assertEqual(FakeAdapter.made[-1].closed_with, "idle")
        self.assertEqual(self.registry()["sessions"][key]["lifecycle"], "stopped")

    def test_idle_close_zero_never_closes(self):
        self.d.settings_load = lambda: {"chat_idle_close_minutes": 0}
        self.open()
        self.now[0] += 10 * cp.IDLE_REAP_SECONDS
        self.c.tick()
        self.assertIsNone(FakeAdapter.made[-1].closed_with)

    def test_idle_codex_sessions_are_closed_too(self):
        LateKeyAdapter.fail = False
        with patch.object(chatd.Chatd, "adapter_class", lambda self, agent: LateKeyAdapter):
            self.cmd(cmd="open", request_id="o1", agent="codex", cwd=self.work)
            for _ in range(4):
                self.c.tick()
        self.assertEqual(self.reply("o1")["session"], "codex:thr-late-1")
        self.now[0] += cp.IDLE_REAP_SECONDS + chatd.REAP_EVERY + 1
        self.c.tick()
        self.assertEqual(FakeAdapter.made[-1].closed_with, "idle")

    def test_sleep_now_puts_idle_sessions_to_sleep_whatever_the_minutes(self):
        # the bottom bar's Let idle agents sleep (`dispatch sleep now`): quiet since before it asked is enough
        import sleep
        self.d.settings_load = lambda: {"agent_sleep_minutes": 0}
        key = self.open()["session"]
        self.now[0] += chatd.REAP_EVERY + 1
        self.c.tick()
        self.assertIsNone(FakeAdapter.made[-1].closed_with)
        sleep.ask_now(self.tmp.name, now=self.now[0])
        self.now[0] += chatd.REAP_EVERY + 1
        self.c.tick()
        self.assertEqual(FakeAdapter.made[-1].closed_with, "idle")
        self.assertEqual(self.registry()["sessions"][key]["lifecycle"], "stopped")

    def test_sleep_now_leaves_a_session_used_after_it_asked(self):
        import sleep
        self.d.settings_load = lambda: {"agent_sleep_minutes": 0}
        sleep.ask_now(self.tmp.name, now=self.now[0] - 5)
        self.open()
        self.now[0] += chatd.REAP_EVERY + 1
        self.c.tick()
        self.assertIsNone(FakeAdapter.made[-1].closed_with)

    def test_busy_sessions_are_not_reaped(self):
        key = self.open()["session"]
        self.cmd(cmd="send", session=key, message_id="m1", text="first")
        self.now[0] += cp.IDLE_REAP_SECONDS + chatd.REAP_EVERY + 1
        self.c.tick()
        self.assertIsNone(FakeAdapter.made[0].closed_with)


class BellAndSleep(Base):
    """The bell's events and who is asleep, as chatd files them (inbox.py, sleep.py)."""

    def events_in_inbox(self):
        import inbox
        return inbox.listing(self.tmp.name)["events"]

    def test_a_finished_turn_rings_with_what_was_asked_and_said(self):
        key = self.open()["session"]
        self.cmd(cmd="send", session=key, message_id="m1", text="make the bell")
        FakeAdapter.made[-1].finish(); self.c.tick()
        ev = self.events_in_inbox()[0]
        self.assertEqual((ev["kind"], ev["source"], ev["session"], ev["ring"]), ("finished", "chat", key, True))
        self.assertEqual((ev["title"], ev["text"], ev["project"]), ("make the bell", "hello", "work"))

    def test_an_error_is_a_quiet_stop_and_pressing_stop_is_already_read(self):
        key = self.open()["session"]
        self.cmd(cmd="send", session=key, message_id="m1", text="go")
        FakeAdapter.made[-1].finish("error"); self.c.tick()
        ev = self.events_in_inbox()[0]
        self.assertEqual((ev["kind"], ev["ring"], ev["read"]), ("stopped", False, False))
        self.cmd(cmd="send", session=key, message_id="m2", text="again")
        FakeAdapter.made[-1].finish("interrupted"); self.c.tick()
        ev = self.events_in_inbox()[0]
        self.assertEqual((ev["kind"], ev["read"], ev["why"]), ("stopped", True, "You stopped it"))

    def test_a_question_is_needs_you(self):
        key = self.open()["session"]
        self.cmd(cmd="send", session=key, message_id="m1", text="go")
        a = FakeAdapter.made[-1]
        a.lifecycle = "waiting_permission"
        a.emit("permission_request", turn_id=a.turn_id, permission_id="p1", kind="tool", tool_name="Bash", input={}, summary="Run npm test", reason="", options=[])
        ev = self.events_in_inbox()[0]
        self.assertEqual((ev["kind"], ev["text"]), ("needs_you", "Run npm test"))

    def test_asleep_after_the_setting_awake_on_the_next_send(self):
        import sleep
        self.d.settings_load = lambda: {"agent_sleep_minutes": 5}
        key = self.open()["session"]
        self.now[0] += 5 * 60 + chatd.REAP_EVERY + 1
        self.c.tick()
        self.assertEqual([x["session"] for x in sleep.asleep(self.tmp.name)], [key])
        self.cmd(cmd="send", request_id="s2", session=key, message_id="m2", text="back")
        self.assertEqual(sleep.asleep(self.tmp.name), [])

    def test_never_asleep_while_waiting_for_the_person(self):
        self.d.settings_load = lambda: {"agent_sleep_minutes": 5}
        key = self.open()["session"]
        self.cmd(cmd="send", session=key, message_id="m1", text="go")
        FakeAdapter.made[-1].lifecycle = "waiting_input"
        self.now[0] += 60 * 60
        self.c.tick()
        self.assertIsNone(FakeAdapter.made[-1].closed_with)


class StagedAdapter(FakeAdapter):
    """A Claude-like adapter: an interrupted turn takes `turn_secs`, the process `exit_secs` after stdin closes."""
    turn_secs, exit_secs = 0.8, 0.8

    def __init__(self, *a):
        super().__init__(*a)
        self.stop_at = self.exit_at = None

    def close_begin(self, reason="requested"):
        if self.turn_id:
            self.stop_at = time.time() + self.turn_secs

    def close_busy(self):
        return bool(self.turn_id)

    def drain(self):
        if self.turn_id and self.stop_at and time.time() >= self.stop_at:
            self.finish("interrupted")
            return True
        return super().drain()

    def close_release(self):
        self.exit_at = time.time() + self.exit_secs

    def alive(self):
        if self.exit_at and time.time() >= self.exit_at:
            return False
        return super().alive()

    def close(self, reason="requested", wait=10):
        self.closed_with = reason
        self.lifecycle = "stopped"
        self.emit("closed", reason=reason, exit_code=0)


class LateKeyAdapter(FakeAdapter):
    """Like a new Codex thread: start() returns before the agent names the session."""
    agent = "codex"
    fail = False

    def start(self, resume=None):
        self.resumed = resume
        self.lifecycle = "starting"
        self._ticks = 0

    def drain(self):
        if self.lifecycle != "starting":
            return super().drain()
        self._ticks += 1
        if self._ticks < 3:
            return False
        if LateKeyAdapter.fail:
            self.lifecycle = "error"
            self.emit("error", code="daemon_down", message="no daemon", fatal=True)
            return True
        self.session = "codex:thr-late-1"
        self._open_pending = True
        return super().drain()


class AccountSwitch(Base):
    """`dispatch accounts use` bumps a number per engine; chatd's engines started under an older one go on with the
    new account on their next message (Claude) or once no turn runs (Codex's shared app-server)."""

    def setUp(self):
        super().setUp()
        self.gen = {"claude-code": 0, "codex": 0}
        p = patch.object(chatd, "account_generation", lambda agent: self.gen.get(agent, 0))
        p.start(); self.addCleanup(p.stop)

    def test_claude_restarts_on_the_conversation_after_a_switch(self):
        key = self.open()["session"]
        self.cmd(cmd="send", session=key, message_id="m1", text="first")
        first = FakeAdapter.made[-1]
        first.finish(); self.c.tick()
        self.gen["claude-code"] = 1
        self.cmd(cmd="send", request_id="s2", session=key, message_id="m2", text="continue")
        self.assertEqual(first.closed_with, "account_switched")
        second = FakeAdapter.made[-1]
        self.assertIsNot(second, first)
        self.assertEqual(second.resumed, cp.split_key(key)[1])
        self.assertEqual([m["message_id"] for m in second.sent], ["m2"])
        self.assertEqual(self.reply("s2")["ev"], "turn_started")
        second.finish(); self.c.tick()
        self.cmd(cmd="send", session=key, message_id="m3", text="again")
        self.assertIs(FakeAdapter.made[-1], second, "one restart per switch")

    def test_no_switch_no_restart(self):
        key = self.open()["session"]
        self.cmd(cmd="send", session=key, message_id="m1", text="first")
        FakeAdapter.made[-1].finish(); self.c.tick()
        self.cmd(cmd="send", session=key, message_id="m2", text="second")
        self.assertEqual(len(FakeAdapter.made), 1)
        self.assertIsNone(FakeAdapter.made[0].closed_with)

    def test_codex_app_server_restarts_once_no_turn_runs(self):
        import chat_codex
        restarts = []
        p = patch.object(chat_codex, "restart_daemon", lambda: restarts.append(1))
        p.start(); self.addCleanup(p.stop)
        self.cmd(cmd="open", request_id="oc", agent="codex", cwd=self.work, resume="thread-1")
        key = self.reply("oc")["session"]
        self.cmd(cmd="send", session=key, message_id="m1", text="work")
        self.gen["codex"] = 1
        self.c.tick()
        self.assertEqual(restarts, [], "waits for the running turn")
        FakeAdapter.made[-1].finish()
        self.c.tick()
        self.assertEqual(restarts, [1])
        self.c.tick()
        self.assertEqual(restarts, [1])


class Robustness(Base):
    def test_registry_keeps_live_and_idle_reaped_sessions_only(self):
        live = self.open("o1")["session"]
        dead = self.open("o2")["session"]
        FakeAdapter.made[1].lifecycle = "stopped"  # its process exited on its own
        self.c.tick()
        self.assertEqual(set(self.registry()["sessions"]), {live})
        self.assertEqual(len(self.cmd(cmd="list", request_id="l")[-1]["sessions"]), 2)  # still resumable from here
        self.now[0] += chatd.STOPPED_KEEP + chatd.REAP_EVERY + 1
        FakeAdapter.made[0].lifecycle = "idle"
        self.c.sessions[live].last_activity = self.now[0]
        self.c.tick()
        self.assertNotIn(dead, self.c.sessions)  # long dead: out of the table too
        self.assertIn(live, self.c.sessions)

    def test_opened_sessions_are_remembered_as_dispatch_conversations(self):
        key = self.open()["session"]
        self.assertIn(key, cp.read_started(self.tmp.name))
        with open(os.path.join(self.tmp.name, cp.STARTED_FILE)) as f:
            self.assertIn(key, json.load(f))

    def test_shutdown_closes_every_session_at_once(self):
        with patch.object(chatd.Chatd, "adapter_class", lambda self, agent: StagedAdapter):
            keys = [self.open(f"o{i}")["session"] for i in range(3)]
            for i, k in enumerate(keys):
                self.cmd(cmd="send", session=k, message_id=f"m{i}", text="go")
            t0 = time.time()
            self.c.shutdown()
            took = time.time() - t0
        # one after another this is 3 x (0.8 + 0.8) = 4.8 s; together about 1.6 s
        self.assertLess(took, 2.6)
        self.assertEqual([a.closed_with for a in FakeAdapter.made], ["shutdown"] * 3)
        self.assertEqual(len([e for e in self.events if e["ev"] == "turn_done" and e["status"] == "interrupted"]), 3)

    def test_a_session_named_late_is_filed_and_a_failed_one_answers_its_open(self):
        with patch.object(chatd.Chatd, "adapter_class", lambda self, agent: LateKeyAdapter):
            LateKeyAdapter.fail = False
            self.cmd(cmd="open", request_id="o1", agent="codex", cwd=self.work)
            for _ in range(4):
                self.c.tick()
            self.assertEqual(self.reply("o1")["session"], "codex:thr-late-1")
            self.assertIn("codex:thr-late-1", self.c.sessions)
            LateKeyAdapter.fail = True
            self.cmd(cmd="open", request_id="o2", agent="codex", cwd=self.work)
            for _ in range(4):
                self.c.tick()
            self.assertEqual(self.reply("o2")["code"], "daemon_down")
            self.assertEqual(self.c.starting, [])

    def test_a_message_waiting_on_a_restart_that_fails_is_answered(self):
        key = self.open()["session"]
        a = FakeAdapter.made[-1]
        a.lifecycle = "stopped"
        with patch.object(FakeAdapter, "start", lambda self, resume=None: setattr(self, "lifecycle", "starting")):
            self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="hello again")
        FakeAdapter.made[-1].lifecycle = "error"  # the resume died before it opened
        self.c.tick()
        self.assertEqual(self.reply("s1")["code"], "not_running")
        self.assertEqual(self.c.sessions[key].queue, [])

    @unittest.skipIf(os.name == "nt", "process groups")
    def test_orphans_of_a_killed_chatd_are_stopped_at_startup(self):
        import subprocess, sys
        sid = "0b1c2d3e-aaaa-4bbb-8ccc-123456789abc"
        # looks like `claude -p ... --session-id <sid> --input-format stream-json`
        orphan = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", "claude", "--session-id", sid, "stream-json"], start_new_session=True)
        other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
        self.addCleanup(lambda: [p.kill() for p in (orphan, other) if p.poll() is None])
        dead = subprocess.Popen([sys.executable, "-c", "pass"]); dead.wait()
        with open(os.path.join(self.tmp.name, "chatd.json"), "w") as f:
            json.dump({"pid": dead.pid, "sessions": {f"claude-code:{sid}": {"pid": orphan.pid}, "claude-code:0b1c2d3e-aaaa-4bbb-8ccc-000000000000": {"pid": other.pid}}}, f)
        self.assertEqual(self.c.reap_orphans(), [orphan.pid])
        orphan.wait(5)
        self.assertIsNone(other.poll())  # a pid that is not that session's claude is left alone


class Checkpoints(Base):
    def test_send_snapshots_first_and_turn_started_carries_the_id(self):
        key = self.open()["session"]
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="改一下")
        self.assertEqual(self.cps.calls, [("begin", "m1", "改一下")])
        started = self.reply("s1")
        self.assertEqual((started["ev"], started["checkpoint"]), ("turn_started", "cp-1"))
        import code_search
        with patch.object(code_search, "refresh") as refresh:
            FakeAdapter.made[-1].finish(); self.c.tick()
        self.assertEqual(self.cps.calls[-1], ("finish", "cp-1", "t1"))
        refresh.assert_called_once_with(os.path.realpath(self.work))

    def test_queued_messages_snapshot_when_they_go_out(self):
        key = self.open()["session"]
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="first")
        self.cmd(cmd="send", request_id="s2", session=key, message_id="m2", text="second")
        self.assertEqual([c[1] for c in self.cps.calls if c[0] == "begin"], ["m1"])
        FakeAdapter.made[-1].finish(); self.c.tick()
        self.assertEqual([c for c in self.cps.calls if c[0] != "gc"], [("begin", "m1", "first"), ("finish", "cp-1", "t1"), ("begin", "m2", "second")])
        started = [e for e in self.events if e["ev"] == "turn_started"]
        self.assertEqual([e["checkpoint"] for e in started], ["cp-1", "cp-2"])

    def test_a_failed_send_drops_its_snapshot(self):
        key = self.open()["session"]
        a = FakeAdapter.made[-1]
        with patch.object(a, "send", side_effect=cp.ChatError("process_exited", "gone")):
            self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="x")
        self.assertEqual(self.cps.calls, [("begin", "m1", "x"), ("discard", "cp-1")])
        self.assertEqual(self.c.sessions[key].cp_by_msg, {})

    def test_display_is_what_the_bubble_and_the_queue_show(self):
        key = self.open()["session"]
        full = "where is x?\n\n[codebase] a.py:1-3\ndef x(): pass"
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text=full, display="where is x?")
        a = FakeAdapter.made[-1]
        self.assertEqual(a.sent[0]["text"], full)
        self.assertEqual(self.reply("s1")["text"], "where is x?")
        self.assertEqual(self.cps.calls[0], ("begin", "m1", "where is x?"))
        self.cmd(cmd="send", request_id="s2", session=key, message_id="m2", text="more\n\n[codebase] b", display="more")
        self.assertEqual(self.reply("s2")["position"], 1)
        self.assertEqual([q["text"] for q in self.c.queue_view(self.c.sessions[key])], ["more"])
        # a note in front still leaves the bubble at the display text
        self.cmd(cmd="note", request_id="n1", session=key, text="restored")
        a.finish(); self.c.tick()
        self.assertEqual(a.sent[1]["text"], "[system] restored\n\nmore\n\n[codebase] b")
        self.assertEqual([e["text"] for e in self.events if e["ev"] == "turn_started"], ["where is x?", "more"])

    def test_display_is_checked(self):
        key = self.open()["session"]
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="x", display=3)
        self.assertEqual(self.reply("s1")["code"], "bad_request")

    def test_notes_a_restore_left_on_disk_ride_on_the_next_message(self):
        key = self.open()["session"]
        self.cps.notes[key] = ["用户把项目文件回到了这一轮之前"]
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="go on")
        self.assertEqual(FakeAdapter.made[-1].sent[0]["text"], "[system] 用户把项目文件回到了这一轮之前\n\ngo on")
        self.assertEqual(self.reply("s1")["text"], "go on")

    def test_a_slow_snapshot_is_told_once(self):
        key = self.open()["session"]
        self.cps.begin = lambda cwd, sid="", message_id="", text="", base=None: {"turn_id": "cp-slow", "ms": 4200}
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="a")
        FakeAdapter.made[-1].finish(); self.c.tick()
        self.cmd(cmd="send", request_id="s2", session=key, message_id="m2", text="b")
        notices = [e for e in self.events if e["ev"] == "system" and "4.2" in e["text"]]
        self.assertEqual(len(notices), 1)

    def test_the_snapshot_runs_off_the_loop_and_other_sessions_keep_going(self):
        jobs = []
        self.c.background = jobs.append
        k1 = self.open("o1")["session"]
        a1 = FakeAdapter.made[-1]
        k2 = self.open("o2")["session"]
        a2 = FakeAdapter.made[-1]
        self.cmd(cmd="send", request_id="s1", session=k1, message_id="m1", text="big folder")
        self.assertEqual((a1.sent, len(jobs)), ([], 1))           # waits for its snapshot
        self.cmd(cmd="send", request_id="s1b", session=k1, message_id="m1b", text="then this")
        self.assertEqual(self.reply("s1b")["ev"], "queued")        # behind it, in order
        self.cmd(cmd="send", request_id="s2", session=k2, message_id="m2", text="elsewhere")
        self.assertEqual(len(jobs), 2)
        jobs.pop()()                                                # the other session's snapshot is quick
        self.c.tick()
        self.assertEqual([m["message_id"] for m in a2.sent], ["m2"])
        self.assertEqual(a1.sent, [])
        jobs.pop()()
        self.c.tick()
        self.assertEqual([m["message_id"] for m in a1.sent], ["m1"])
        self.assertEqual(self.reply("s1")["checkpoint"], "cp-2")  # the fake numbers snapshots as they finish
        a1.finish(); self.c.tick()
        jobs.pop()(); self.c.tick()
        self.assertEqual([m["message_id"] for m in a1.sent], ["m1", "m1b"])

    def test_closing_while_the_snapshot_runs_answers_the_message(self):
        jobs = []
        self.c.background = jobs.append
        key = self.open()["session"]
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="x")
        self.cmd(cmd="close", request_id="c1", session=key, reason="requested")
        self.assertEqual(self.reply("s1")["code"], "not_running")
        jobs.pop()()
        self.assertIn(("discard", "cp-1"), self.cps.calls)

    def test_a_failed_snapshot_is_told_once(self):
        key = self.open()["session"]
        self.cps.begin = lambda cwd, sid="", message_id="", text="", base=None: {"error": "git_failed", "message": "Unable to create index.lock"}
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="a")
        FakeAdapter.made[-1].finish(); self.c.tick()
        self.cmd(cmd="send", request_id="s2", session=key, message_id="m2", text="b")
        notices = [e for e in self.events if e["ev"] == "system" and "index.lock" in e["text"]]
        self.assertEqual(len(notices), 1)
        self.assertEqual(len(FakeAdapter.made[-1].sent), 2)   # the messages went out all the same

    def test_a_broken_checkpoint_module_never_stops_a_message(self):
        key = self.open()["session"]
        def boom():
            raise RuntimeError("no module")
        self.c.checkpoints = boom
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="hi")
        started = self.reply("s1")
        self.assertEqual(started["ev"], "turn_started")
        self.assertNotIn("checkpoint", started)
        FakeAdapter.made[-1].finish(); self.c.tick()
        self.assertEqual(self.events[-1]["ev"], "state")

    def test_gc_is_asked_about_once_an_hour(self):
        self.now[0] += chatd.GC_CHECK_EVERY + 1
        self.c.tick()
        self.c.tick()
        self.assertEqual([c for c in self.cps.calls if c[0] == "gc"], [("gc",)])


class RealCheckpoints(Base):
    """chatd with the real checkpoint module: turns.json gets a record per message, the after
    snapshot lists what the turn changed, in a git repository and in a plain folder."""

    def setUp(self):
        super().setUp()
        import checkpoint
        self.c.checkpoints = lambda: checkpoint
        self.mod = checkpoint

    def run_turn(self, folder):
        with open(os.path.join(folder, "a.txt"), "w") as f:
            f.write("old\n")
        self.cmd(cmd="open", request_id="o", agent="claude-code", cwd=folder)
        key = self.reply("o")["session"]
        self.cmd(cmd="send", request_id="s1", session=key, message_id="m1", text="edit a, add b")
        started = self.reply("s1")
        self.assertTrue(started["checkpoint"].startswith("cp-"))
        with open(os.path.join(folder, "a.txt"), "w") as f:
            f.write("new\n")
        # the agent's Write tool creates b.txt (chatd sees the tool call: the restore may delete it unasked)
        FakeAdapter.made[-1].emit("tool_start", turn_id="t1", tool_id="w1", name="Write", kind="edit", input={"file_path": os.path.join(folder, "b.txt")})
        with open(os.path.join(folder, "b.txt"), "w") as f:
            f.write("b\n")
        FakeAdapter.made[-1].finish(); self.c.tick()
        sh = self.mod.Shadow(self.mod.project_root(folder), self.tmp.name)
        data = sh.load()
        self.assertEqual(len(data["turns"]), 1)
        rec = data["turns"][0]
        self.assertEqual((rec["turn_id"], rec["message_id"], rec["sid"], rec["agent_turn_id"], rec["text"]), (started["checkpoint"], "m1", key, "t1", "edit a, add b"))
        self.assertEqual(sorted((f["path"], f["status"]) for f in rec["files_changed"]), [("a.txt", "M"), ("b.txt", "A")])
        self.assertEqual(rec["agent_paths"], ["b.txt"])
        r = self.mod.restore(sh.root, "m1", base=self.tmp.name, sid=key)
        self.assertTrue(r["ok"], r)
        with open(os.path.join(folder, "a.txt")) as f:
            self.assertEqual(f.read(), "old\n")
        self.assertFalse(os.path.exists(os.path.join(folder, "b.txt")))
        # the restore left a note: the next message carries it
        self.cmd(cmd="send", request_id="s2", session=key, message_id="m2", text="ok")
        self.assertTrue(FakeAdapter.made[-1].sent[-1]["text"].startswith("[system] 用户把项目文件回到了这一轮之前"))

    def test_plain_folder(self):
        folder = os.path.join(self.tmp.name, "plain"); os.mkdir(folder)
        self.run_turn(folder)

    def test_git_repository(self):
        import subprocess
        folder = os.path.join(self.tmp.name, "repo"); os.mkdir(folder)
        subprocess.run(["git", "init", "-q", folder], check=True)
        self.run_turn(folder)
        self.assertFalse(os.path.exists(os.path.join(folder, ".git", "index")) and subprocess.run(["git", "-C", folder, "ls-files"], capture_output=True, text=True).stdout.strip())


class EnvStrip(unittest.TestCase):
    def test_multiplexer_and_agent_variables_do_not_reach_agents(self):
        env = cp.child_env({"PATH": "/bin", "HERDR_PANE_ID": "wA:p9", "HERDR_SOCKET_PATH": "/s", "TMUX": "/t", "TMUX_PANE": "%1", "ZELLIJ_SESSION_NAME": "z",
                            "CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "DISPATCH_SESSION_ID": "x", "HOME": "/h"})
        self.assertEqual(env, {"PATH": "/bin", "HOME": "/h"})


class Serve(unittest.TestCase):
    def test_serve_survives_bad_lines_and_stops_on_shutdown(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        d = SimpleNamespace(HOME=tmp.name, DISPATCH_DIR=tmp.name, SESS_DIR=tmp.name, live_sessions=lambda local_only=False: [])
        out = []
        lines = ["{not json\n", json.dumps({"cmd": "nope"}), json.dumps({"cmd": "send", "session": "claude-code:abc"}),
                 json.dumps({"cmd": "hello", "request_id": "h"}),
                 json.dumps({"cmd": "open", "request_id": "o", "agent": "claude-code", "cwd": tmp.name}),
                 json.dumps({"cmd": "list", "request_id": "l"}),
                 json.dumps({"cmd": "shutdown", "request_id": "x"}),
                 json.dumps({"cmd": "hello", "request_id": "after"})]
        with patch.object(chatd.Chatd, "adapter_class", lambda self, agent: FakeAdapter), patch.object(chatd, "_probe", lambda agent: dict(SUPPORTED)):
            self.assertEqual(chatd.serve(read=iter(lines), write=out.append, d=d), 0)
        evs = [json.loads(l) for l in out]
        self.assertEqual((evs[0]["ev"], evs[0]["state"]), ("chatd", "up"))
        self.assertEqual([e["code"] for e in evs if e["ev"] == "error"], ["bad_request"] * 3)
        by = {e["request_id"]: e for e in evs if e.get("request_id")}
        self.assertEqual(by["h"]["agents"]["claude-code"]["supported"], True)
        self.assertEqual(by["o"]["ev"], "opened")
        self.assertEqual(len(by["l"]["sessions"]), 1)
        self.assertEqual((by["x"]["ev"], by["x"]["state"]), ("chatd", "down"))
        self.assertNotIn("after", by)
        self.assertEqual(FakeAdapter.made[-1].closed_with, "shutdown")
        seqs = [e["seq"] for e in evs]
        self.assertEqual(seqs, sorted(seqs))

    def test_stdin_closing_closes_every_session(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        d = SimpleNamespace(HOME=tmp.name, DISPATCH_DIR=tmp.name, SESS_DIR=tmp.name, live_sessions=lambda local_only=False: [])
        out = []
        with patch.object(chatd.Chatd, "adapter_class", lambda self, agent: FakeAdapter), patch.object(chatd, "_probe", lambda agent: dict(SUPPORTED)):
            chatd.serve(read=iter([json.dumps({"cmd": "open", "request_id": "o", "agent": "claude-code", "cwd": tmp.name})]), write=out.append, d=d)
        last = json.loads(out[-1])
        self.assertEqual((last["ev"], last["state"]), ("chatd", "down"))
        self.assertEqual(FakeAdapter.made[-1].closed_with, "shutdown")
        with open(os.path.join(tmp.name, "chatd.json")) as f:
            self.assertEqual(json.load(f)["sessions"], {})

    @unittest.skipIf(os.name == "nt", "the helper loops run on a Mac only (notify_watch needs fcntl)")
    def test_its_helper_loops_end_with_it(self):
        """Keep awake and the desktop banners stop when serve returns, by shutdown or by stdin closing. They
        ran on before, woke ten seconds later inside other tests and read their patched board and folders."""
        import awake
        import notify_watch
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        d = SimpleNamespace(HOME=tmp.name, DISPATCH_DIR=tmp.name, SESS_DIR=tmp.name, live_sessions=lambda local_only=False: [])
        for tail in ([json.dumps({"cmd": "shutdown", "request_id": "x"})], []):
            handed = []
            with patch.object(chatd.Chatd, "adapter_class", lambda self, agent: FakeAdapter), patch.object(chatd, "_probe", lambda agent: dict(SUPPORTED)), \
                    patch.object(chatd.sys, "platform", "darwin"), \
                    patch.object(awake, "start_thread", side_effect=lambda log=None: handed.append(threading.Event()) or handed[-1]), \
                    patch.object(notify_watch, "start_thread", side_effect=lambda log=None: handed.append(threading.Event()) or handed[-1]):
                self.assertEqual(chatd.serve(read=iter([json.dumps({"cmd": "hello", "request_id": "h"})] + tail), write=lambda l: None, d=d), 0)
            self.assertEqual(len(handed), 2)
            self.assertTrue(all(ev.is_set() for ev in handed), tail)

    @unittest.skipIf(os.name == "nt", "the helper loops run on a Mac only (notify_watch needs fcntl)")
    def test_the_banner_loop_ends_when_told(self):
        import notify_watch
        stop = threading.Event()
        runs = []
        with patch.object(notify_watch, "run_once", side_effect=lambda: runs.append(1) or stop.set() or {}):
            t = threading.Thread(target=notify_watch.loop, kwargs={"interval": 3600, "stop": stop})
            t.start()
            t.join(30)
        self.assertFalse(t.is_alive())
        self.assertEqual(runs, [1])
        stop2 = threading.Event(); stop2.set()
        with patch.object(notify_watch, "run_once", side_effect=AssertionError("ran after stop")):
            notify_watch.loop(interval=3600, delay=3600, stop=stop2)  # returns at once

if __name__ == "__main__":
    unittest.main()


class NextUp(Base):
    """The line of things noted from chats (capture.py): chatd asks `dispatch nextup tick` every 20 s, only once
    something was lined up on this Mac and while the line is not paused."""

    def runs(self, queue):
        if queue is not None:
            os.makedirs(os.path.join(self.tmp.name, "capture"), exist_ok=True)
            with open(os.path.join(self.tmp.name, "capture", "queue.json"), "w") as f:
                json.dump(queue, f)
        seen = []
        with patch.object(chatd.subprocess, "run", lambda argv, **k: seen.append(argv[2:])):
            self.c.nextup_sweep()
        return seen

    def test_ticks_only_when_something_is_lined_up_and_not_paused(self):
        self.assertEqual(self.runs(None), [])
        self.assertEqual(self.runs({"lined": True, "paused": True}), [])
        self.assertEqual(self.runs({"lined": True, "paused": False}), [["nextup", "tick", "--json"]])
        # Start by itself is off until the person turns it on (task-9rxf): no saved switch, no tick
        self.assertEqual(self.runs({"lined": True}), [])

    def test_a_failed_start_waits_and_stops_after_the_third(self):
        """task-9qas: not every 20 s for ever; 1 minute, then 5, then nothing until the person says Try again."""
        import time as _t
        later = {"task": "task-1", "tries": 1, "retry_at": _t.time() + 60}
        self.assertEqual(self.runs({"lined": True, "paused": False, "failed": later}), [])
        due = {"task": "task-1", "tries": 2, "retry_at": _t.time() - 1}
        self.assertEqual(self.runs({"lined": True, "paused": False, "failed": due}), [["nextup", "tick", "--json"]])
        stuck = {"task": "task-1", "tries": 3, "retry_at": 0}
        self.assertEqual(self.runs({"lined": True, "paused": False, "failed": stuck}), [])

    def test_the_loop_asks_every_twenty_seconds(self):
        calls = []
        self.c.nextup_sweep = lambda: calls.append(self.now[0])
        self.c.tick()
        self.now[0] += chatd.NEXTUP_EVERY
        self.c.tick()
        self.c.tick()
        self.assertEqual(calls, [1000.0 + chatd.NEXTUP_EVERY])
