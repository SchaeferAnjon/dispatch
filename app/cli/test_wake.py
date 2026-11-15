"""Worker wake-ups: notifications on disk, terminal hooks, `worker wait`, prime, chatd delivery."""
import contextlib
import io
import json
import os
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dispatch as D
import handoff as H
import wake as K
import workers as W
from test_chatd import Base as ChatBase, FakeAdapter
from test_workers import Base


def me():
    """A dispatcher row for this very process, so it counts as alive."""
    return dict(session="disp-1", engine="claude-code", host=W.host(), pid=os.getpid(), birth=W.process(os.getpid())["birth"],
                presence="", cwd="/", started_at=W.now(), claimed_at=time.time())


class Kit:
    def make(self, name, **changes):
        row = self.row(name)
        row.update({"run_id": name + "-run", **changes})
        return row

    def live(self, name="one", **changes):
        return self.make(name, pid=os.getpid(), birth=W.process(os.getpid())["birth"], **changes)

    def done(self, name="one", **changes):
        """A worker whose process is gone and whose report exists."""
        row = self.make(name, **changes)
        with open(row["report"], "w") as f:
            f.write("# Done\n")
        return row

    def failed(self, name="one", **changes):
        return self.make(name, **changes)

    def first_sweep(self):
        self.save()
        self.assertEqual(K.scan(self.store), [])


class Notes(Kit, Base):

    def test_the_first_sweep_only_records_what_already_ended(self):
        self.save([self.done("old"), self.failed("older")])
        self.assertEqual(K.scan(self.store), [])
        self.assertEqual(K.unread(self.d), [])
        self.assertEqual({n["worker"] for n in K.recent_read(self.d)}, {"old", "older"})
        self.assertEqual({n["read_by"] for n in K.recent_read(self.d)}, {"baseline"})

    def test_a_report_and_an_exit_without_one_are_written_once_with_everything_needed(self):
        self.first_sweep()
        self.save([self.done("one"), self.failed("two", launch_error="engine not installed")])
        got = {n["worker"]: n for n in K.scan(self.store)}
        self.assertEqual(got["one"]["event"], "reported")
        self.assertEqual(got["two"]["event"], "failed")
        for n in got.values():
            for field in ("worker", "task", "task_title", "report", "at", "text", "log"):
                self.assertTrue(n[field], field)
            self.assertIsNone(n["read_at"])
        self.assertIn("worker one 已交回，报告 " + got["one"]["report"], got["one"]["text"])
        self.assertIn("engine not installed", got["two"]["text"])
        self.assertEqual(K.scan(self.store), [])  # same facts, nothing new
        self.assertEqual(len(K.unread(self.d)), 2)

    def test_the_reason_is_cut_down_to_the_message(self):
        raw = 'ed","error":{"message":"You\u2019ve hit your usage limit. Try again at Oct 6th."}}'
        self.assertEqual(K.tidy(raw), "You\u2019ve hit your usage limit. Try again at Oct 6th.")
        self.assertEqual(K.tidy("plain failure\nsecond line"), "plain failure second line")
        self.assertEqual(len(K.tidy("x" * 500)), 160)
        self.assertEqual(K.tidy(None), "")

    def test_running_and_starting_and_remote_workers_are_quiet(self):
        self.first_sweep()
        remote = self.done("far", host="another-mac", host_id="another-mac-id")
        starting = self.make("new", pid=0, launch_at=time.time())
        running = self.live("live")
        self.save([remote, starting, running])
        self.assertEqual(K.scan(self.store), [])

    def test_a_live_worker_with_a_settled_report_counts_a_fresh_one_does_not(self):
        self.first_sweep()
        row = self.done("hung", pid=os.getpid(), birth=W.process(os.getpid())["birth"])
        self.save([row])
        self.assertEqual(K.scan(self.store), [])
        old = time.time() - 60
        os.utime(row["report"], (old, old))
        self.assertEqual([n["event"] for n in K.scan(self.store)], ["reported"])

    def test_reading_moves_a_notification_and_never_brings_it_back(self):
        self.first_sweep()
        self.save([self.done("one")])
        n = K.scan(self.store)[0]
        moved = K.mark_read(self.d, [n["id"]], "test", via="chatd")
        self.assertEqual(moved[0]["read_by"], "test")
        self.assertEqual(K.unread(self.d), [])
        self.assertEqual(K.recent_read(self.d)[-1]["delivered"][0]["via"], "chatd")
        self.assertEqual(K.scan(self.store), [])  # read facts are remembered too

    def test_restart_and_need_you_are_written_by_the_recovery_and_dedupe_across_runs(self):
        self.first_sweep()
        self.save([self.failed("one", run_id="original")])
        with patch.object(W.engines, "which", return_value=None), patch("handoff.latest", return_value=None), \
             patch.object(W, "recovery_need_you", return_value="task-human"):
            W.recover_failed(self.store)  # launch fails: failed is written, nothing restarted
            W.recover_failed(self.store)
            W.recover_failed(self.store)
        events = [(n["event"], n["attempt"]) for n in K.unread(self.d)]
        self.assertIn(("need-you", 0), events)
        self.assertEqual(sum(e == "failed" for e, _ in events), 3)  # each run exited without a report
        need = next(n for n in K.unread(self.d) if n["event"] == "need-you")
        self.assertIn("task-human", need["text"])

    def test_a_successful_restart_is_written_with_its_attempt_and_new_report_path(self):
        self.first_sweep()
        self.save([self.failed("one", run_id="original")])
        with patch.object(W.engines, "which", return_value="/bin/false"), \
             patch.object(W.P, "spawn_detached", return_value=SimpleNamespace(pid=os.getpid())), \
             patch.object(W, "process", return_value={"birth": "stamp"}), patch("handoff.latest", return_value=None):
            self.assertEqual(W.recover_failed(self.store)[0]["action"], "restarted")
        by = {n["event"]: n for n in K.unread(self.d)}
        self.assertEqual(by["failed"]["run_id"], "original")
        self.assertEqual(by["restarted"]["attempt"], 1)
        self.assertIn("第 1/2 次", by["restarted"]["text"])
        self.assertEqual(by["restarted"]["report"], self.store.load()["workers"]["one"]["report"])

    def test_a_notification_that_cannot_be_written_never_stops_a_recovery(self):
        self.save([self.failed("one", run_id="original")])
        with patch.object(K, "add", side_effect=OSError("disk full")), patch.object(W.engines, "which", return_value=None), \
             patch("handoff.latest", return_value=None):
            self.assertEqual(W.recover_failed(self.store)[0]["action"], "launch-failed")


class Wait(Kit, Base):
    def test_returns_at_once_with_unread_and_marks_them_read(self):
        self.first_sweep()
        self.save([self.done("one")])
        r = K.wait(self.store, sleep=lambda s: self.fail("should not sleep"))
        self.assertEqual(r["reason"], "notifications")
        self.assertIn("worker one 已交回", K.wait_text(r))
        self.assertEqual(K.unread(self.d), [])

    def test_blocks_until_a_running_worker_finishes(self):
        self.first_sweep()
        live = self.live("one", run_id="r1")
        self.save([live])
        polls = []

        def sleep(seconds):
            polls.append(seconds)
            self.assertTrue(K.waiting(self.d))  # the heartbeat a Stop hook looks for
            if len(polls) == 2:
                with open(live["report"], "w") as f:
                    f.write("# Done\n")
                self.save([dict(live, pid=99999999, birth="gone")])
        r = K.wait(self.store, interval=7, sleep=sleep)
        self.assertEqual(polls, [7, 7])
        self.assertEqual(r["reason"], "notifications")
        self.assertEqual(r["notifications"][0]["worker"], "one")
        self.assertFalse(K.waiting(self.d))  # gone once it returned

    def test_a_worker_that_exits_without_a_report_wakes_it_too(self):
        self.first_sweep()
        live = self.live("one", run_id="r1")
        self.save([live])
        r = K.wait(self.store, sleep=lambda s: self.save([dict(live, pid=99999999, birth="gone")]))
        self.assertEqual(r["notifications"][0]["event"], "failed")

    def test_a_board_hiccup_does_not_end_the_wait_but_five_in_a_row_do(self):
        self.first_sweep()
        live = self.live("one", run_id="r1")
        self.save([live])
        real, calls = self.store.load, []

        def flaky(timeout=20):
            calls.append(1)
            if len(calls) <= 2:
                raise ValueError("board busy")
            return real(timeout)
        self.store.load = flaky
        r = K.wait(self.store, timeout=10, sleep=lambda s: None, clock=iter([0, 1, 2, 3, 99]).__next__)
        self.assertEqual(r["reason"], "timeout")
        self.store.load = lambda timeout=20: (_ for _ in ()).throw(ValueError("still busy"))
        with self.assertRaises(ValueError):
            K.wait(self.store, sleep=lambda s: None)

    def test_idle_when_nothing_runs_and_timeout_when_something_does(self):
        self.first_sweep()
        self.assertEqual(K.wait(self.store)["reason"], "idle")
        live = self.live("one", run_id="r1")
        self.save([live])
        ticks = iter([0, 1, 2, 30, 31])
        r = K.wait(self.store, timeout=10, sleep=lambda s: None, clock=lambda: next(ticks))
        self.assertEqual((r["reason"], r["running"]), ("timeout", ["one"]))

    def test_cli_prints_json_and_text_and_lists_notifications(self):
        self.first_sweep()
        self.save([self.done("one")])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(W.run(SimpleNamespace(group="worker", op="wait", timeout=0, interval=5, json=True), self.d), 0)
        self.assertEqual(json.loads(out.getvalue())["notifications"][0]["worker"], "one")
        r, text = W.command(self.store, SimpleNamespace(group="worker", op="notifications", all=True, ack=False))
        self.assertIn("(read) worker one 已交回", text)
        self.assertEqual(W.command(self.store, SimpleNamespace(group="worker", op="notifications", all=False, ack=False))[1],
                         "No unread worker notifications")

    def test_ack_marks_everything_read(self):
        self.first_sweep()
        self.save([self.done("one")])
        K.scan(self.store)
        r, _ = W.command(self.store, SimpleNamespace(group="worker", op="notifications", all=False, ack=True))
        self.assertEqual(r["acknowledged"], 1)
        self.assertEqual(K.unread(self.d), [])


class Dispatcher(Kit, Base):
    def setUp(self):
        super().setUp()
        # The life hook is not under test here (and measures real transcripts): keep it out of the way.
        for p in (patch.object(H, "_hook", return_value={}), patch.object(D, "DISPATCH_DIR", self.d.DISPATCH_DIR),
                  patch.object(D, "BEADS_DIR", self.d.BEADS_DIR), patch.object(D, "sh", self.d.sh),
                  patch.object(D, "bd_json", self.d.bd_json), patch.object(D, "bd_comments", self.d.bd_comments)):
            p.start()
            self.addCleanup(p.stop)
        self.first_sweep()
        self.save([self.done("one")], dispatcher=me())
        K.save_dispatcher(self.d, me())
        K.scan(self.store)

    def test_claim_records_the_engine_and_returns_unread_notifications_as_read(self):
        self.save([self.done("one")])
        K.save_dispatcher(self.d, None)
        with patch.object(self.d, "session_self", return_value="ses_abc"):
            r, text = W.command(self.store, SimpleNamespace(group="dispatcher", op="claim", session="ses_abc", pid=os.getpid(), engine=""))
        self.assertEqual(r["engine"], "opencode")  # inferred from the ses_ id when no presence record says
        self.assertEqual([n["worker"] for n in r["notifications"]], ["one"])
        self.assertIn("worker one 已交回", text)
        self.assertEqual(K.unread(self.d), [])
        self.assertEqual(K.dispatcher(self.d)["session"], "ses_abc")

    def test_a_session_chatd_holds_can_claim_without_a_pid_of_its_own(self):
        self.save([self.done("one")])
        K.save_dispatcher(self.d, None)
        os.makedirs(self.d.DISPATCH_DIR, exist_ok=True)
        with open(os.path.join(self.d.DISPATCH_DIR, "chatd.json"), "w") as f:
            json.dump({"pid": os.getpid(), "sessions": {"opencode:ses_held": {"agent": "opencode", "pid": None}}}, f)
        r, _ = W.command(self.store, SimpleNamespace(group="dispatcher", op="claim", session="ses_held", pid=0, engine=""))
        self.assertEqual((r["session"], r["engine"], r["pid"], r["active"]), ("ses_held", "opencode", os.getpid(), True))
        with self.assertRaises(ValueError):
            W.dispatcher_owner(self.d, "ses_unknown", 0)

    def test_release_clears_the_local_copy(self):
        os.makedirs(self.d.BEADS_DIR, exist_ok=True)
        self.save(dispatcher=me())
        W.release_session("disp-1", self.d, "handoff")
        self.assertFalse(K.dispatcher(self.d)["active"])

    def test_only_the_registered_session_is_the_recipient(self):
        self.assertEqual(K.recipient(self.d, "disp-1"), "dispatcher")
        self.assertEqual(K.recipient(self.d, "claude-code:disp-1"), "dispatcher")
        self.assertEqual(K.recipient(self.d, "someone-else"), "other")
        with patch.dict(os.environ, {"DISPATCH_WORKER": "one"}):
            self.assertEqual(K.recipient(self.d, "disp-1"), "other")
        K.save_dispatcher(self.d, None)
        self.assertEqual(K.recipient(self.d, "anyone"), "unclaimed")

    def test_hook_output_carries_unread_once_per_event_kind(self):
        for event, inner in (("UserPromptSubmit", "additionalContext"), ("PostToolUse", "additionalContext")):
            K.mark_read(self.d, [], "x")
            self.save([self.done("w" + event)], dispatcher=me())
            K.scan(self.store)
            with patch.object(D, "DISPATCH_DIR", self.d.DISPATCH_DIR):
                out = H.hook({"session_id": "disp-1", "hook_event_name": event}, "claude-code")
            body = out["hookSpecificOutput"]
            self.assertEqual(body["hookEventName"], event)
            self.assertIn("worker w" + event + " 已交回", body[inner])
            self.assertEqual(K.unread(self.d), [])
            with patch.object(D, "DISPATCH_DIR", self.d.DISPATCH_DIR):
                self.assertEqual(H.hook({"session_id": "disp-1", "hook_event_name": event}, "claude-code"), {})

    def test_stop_with_an_unread_notification_blocks_and_carries_it(self):
        with patch.object(D, "DISPATCH_DIR", self.d.DISPATCH_DIR):
            out = H.hook({"session_id": "disp-1", "hook_event_name": "Stop"}, "codex")
        self.assertEqual(out["decision"], "block")
        self.assertIn("worker one 已交回", out["reason"])
        self.assertEqual(K.unread(self.d), [])

    def test_other_sessions_subagents_and_managed_sessions_get_nothing(self):
        with patch.object(D, "DISPATCH_DIR", self.d.DISPATCH_DIR):
            self.assertEqual(H.hook({"session_id": "someone-else", "hook_event_name": "PostToolUse"}, "codex"), {})
            self.assertEqual(H.hook({"session_id": "disp-1", "hook_event_name": "PostToolUse", "agent_id": "kid"}, "claude-code"), {})
            with patch.object(H, "managed", return_value=True):
                self.assertEqual(H.hook({"session_id": "disp-1", "hook_event_name": "PostToolUse"}, "claude-code"), {})
        self.assertEqual(len(K.unread(self.d)), 1)

    def test_it_merges_with_the_life_hook_output(self):
        life = {"decision": "block", "reason": "write the handoff"}
        with patch.object(D, "DISPATCH_DIR", self.d.DISPATCH_DIR), patch.object(H, "_hook", return_value=life):
            out = H.hook({"session_id": "disp-1", "hook_event_name": "Stop"}, "codex")
        self.assertTrue(out["reason"].startswith("write the handoff"))
        self.assertIn("worker one 已交回", out["reason"])
        with patch.object(D, "DISPATCH_DIR", self.d.DISPATCH_DIR), patch.object(H, "_hook", return_value={"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "80%"}}):
            self.save([self.done("two")], dispatcher=me())
            K.scan(self.store)
            out = H.hook({"session_id": "disp-1", "hook_event_name": "PostToolUse"}, "codex")
        self.assertTrue(out["hookSpecificOutput"]["additionalContext"].startswith("80%"))
        self.assertIn("worker two", out["hookSpecificOutput"]["additionalContext"])

    def test_stop_reminds_about_running_workers_once_and_not_while_waiting(self):
        K.mark_read(self.d, [n["id"] for n in K.unread(self.d)], "x")
        live = self.live("busy", run_id="b")
        self.save([live], dispatcher=me())
        with patch.object(D, "DISPATCH_DIR", self.d.DISPATCH_DIR), patch.object(D, "BEADS_DIR", self.d.BEADS_DIR), \
             patch.object(D, "sh", self.d.sh):
            stop = {"session_id": "disp-1", "hook_event_name": "Stop"}
            out = H.hook(stop, "claude-code")
            self.assertEqual(out["decision"], "block")
            self.assertIn("dispatch worker wait", out["reason"])
            self.assertIn("busy", out["reason"])
            self.assertEqual(H.hook(stop, "claude-code"), {})  # same set, reminded a moment ago
            os.unlink(os.path.join(self.d.DISPATCH_DIR, "notifications", "remind.json"))
            self.assertEqual(H.hook(dict(stop, stop_hook_active=True), "claude-code"), {})
            K.write_json(os.path.join(K.folder(self.d), "waiting", f"{os.getpid()}.json"),
                         {"pid": os.getpid(), "birth": W.process(os.getpid())["birth"], "at": time.time()})
            self.assertEqual(H.hook(stop, "claude-code"), {})  # a `worker wait` is already hanging

    def test_a_hook_sweeps_the_workers_itself_when_no_chatd_does_but_not_on_every_call(self):
        K.mark_read(self.d, [n["id"] for n in K.unread(self.d)], "x")
        live = self.live("busy")
        self.save([live], dispatcher=me())
        t = [1000.0]
        self.assertIsNone(K.hook_note(self.d, "disp-1", "PostToolUse", now=lambda: t[0]))
        with open(live["report"], "w") as f:
            f.write("# Done\n")
        self.save([dict(live, pid=99999999, birth="gone")], dispatcher=me())
        t[0] += 5
        self.assertIsNone(K.hook_note(self.d, "disp-1", "PostToolUse", now=lambda: t[0]))  # swept a moment ago
        t[0] += K.SCAN_SECONDS
        note = K.hook_note(self.d, "disp-1", "PostToolUse", now=lambda: t[0])
        self.assertIn("worker busy 已交回", note["text"])
        self.assertFalse(note["block"])

    def test_a_session_that_is_not_the_dispatcher_costs_a_hook_almost_nothing(self):
        with patch.object(K, "refresh") as refresh, patch.object(W, "dispatcher_status") as status:
            self.assertIsNone(K.hook_note(self.d, "someone-else", "PostToolUse"))
        refresh.assert_not_called()
        status.assert_not_called()

    def test_prime_lists_unread_and_a_dispatcher_reading_it_marks_them(self):
        lines = K.prime_lines(self.d, "disp-1")
        self.assertIn("未读 1", lines[0])
        self.assertIn("worker one 已交回", lines[1])
        self.assertEqual(len(K.unread(self.d)), 1)  # listing alone keeps them
        K.prime_lines(self.d, "disp-1", mark=True)
        self.assertEqual(K.unread(self.d), [])

    def test_prime_outside_the_registered_dispatcher_is_silent(self):
        self.assertEqual(K.prime_lines(self.d, "someone-else", mark=True), [])
        self.assertEqual(len(K.unread(self.d)), 1)
        K.save_dispatcher(self.d, None)
        # No dispatcher registered: an ordinary session is not shown dispatch internals either.
        self.assertEqual(K.prime_lines(self.d, "anyone", mark=True), [])
        self.assertEqual(len(K.unread(self.d)), 1)  # only a claim reads them
        with patch.dict(os.environ, {"DISPATCH_WORKER": "w"}):
            self.assertEqual(K.prime_lines(self.d, "anyone"), [])

    def test_prime_output_stays_within_its_budget_and_only_marks_what_it_shows(self):
        K.mark_read(self.d, [n["id"] for n in K.unread(self.d)], "x")
        rows = [self.done(f"worker-{i:02d}-" + "x" * 30, task_title="t") for i in range(9)]
        self.save(rows, dispatcher=me())
        K.scan(self.store)
        lines = K.prime_lines(self.d, "disp-1", mark=True)
        self.assertLessEqual(len("\n".join(lines).encode()), 1100)
        self.assertIn("还有", lines[-1])
        shown = sum(l.startswith("- worker") for l in lines)
        self.assertEqual(len(K.unread(self.d)), 9 - shown)


class ChatDelivery(Kit, Base):
    def hosted(self, session):
        return "claude-code:" + session if session == "disp-1" else None

    def test_a_sweep_decides_only_for_a_dispatcher_chatd_holds(self):
        self.first_sweep()
        self.save([self.done("one")], dispatcher=me())
        batch = K.sweep(self.store, self.hosted)
        self.assertEqual(batch["key"], "claude-code:disp-1")
        self.assertEqual(batch["text"], "worker one 已交回，报告 " + self.row("one")["report"])
        self.assertEqual(len(K.unread(self.d)), 1)  # nothing is read until it was sent
        self.assertIsNone(K.sweep(self.store, lambda s: None))  # a terminal dispatcher: hooks handle it
        self.save([self.done("one")])
        self.assertIsNone(K.sweep(self.store, self.hosted))  # nobody claimed it: stays for the next claim
        self.assertEqual(len(K.unread(self.d)), 1)

    def test_several_notifications_go_as_one_message_one_line_each(self):
        self.first_sweep()
        self.save([self.done("one"), self.failed("two")], dispatcher=me())
        batch = K.sweep(self.store, self.hosted)
        self.assertEqual(len(batch["text"].splitlines()), 2)
        self.assertEqual(len(batch["ids"]), 2)

    def test_poll_sends_and_marks_read_only_after_the_send_was_accepted(self):
        self.first_sweep()
        self.save([self.done("one")], dispatcher=me())
        batch = K.sweep(self.store, self.hosted)
        sent = []
        host = SimpleNamespace(d=self.d, _wake_out=[batch], send=lambda o, rid: sent.append(o))
        K.poll(host)
        self.assertEqual(sent[0]["session"], "claude-code:disp-1")
        self.assertEqual(sent[0]["text"], batch["text"])
        self.assertEqual(K.unread(self.d), [])
        self.assertEqual(K.recent_read(self.d)[-1]["delivered"][0]["via"], "chatd")
        self.first_sweep = None
        self.save([self.done("one"), self.done("two")], dispatcher=me())
        batch = K.sweep(self.store, self.hosted)

        def refuse(o, rid):
            raise RuntimeError("session gone")
        K.poll(SimpleNamespace(d=self.d, _wake_out=[batch], send=refuse))
        self.assertEqual(len(K.unread(self.d)), 1)  # retried by the next sweep


class ChatdWake(ChatBase):
    def test_the_dispatcher_session_receives_the_message_and_a_busy_one_queues_it(self):
        import wake
        key = self.open()["session"]
        self.assertEqual(self.c.hosted_session(key.split(":", 1)[1]), key)
        self.assertIsNone(self.c.hosted_session("nobody"))
        batch = {"key": key, "ids": [], "text": "worker gx-wake 已交回，报告 /r.md"}
        self.c._wake_out.append(batch)
        self.c.tick()
        self.assertEqual([m["text"] for m in FakeAdapter.made[-1].sent], ["worker gx-wake 已交回，报告 /r.md"])
        self.assertEqual(self.c._wake_out, [])
        self.c._wake_out.append(dict(batch, text="worker two 退出没交报告"))
        self.c.tick()
        queue = [e for e in self.events if e["ev"] == "queue" and e["queue"]]
        self.assertEqual(queue[-1]["queue"][0]["text"], "worker two 退出没交报告")  # behind the running turn
        FakeAdapter.made[-1].finish()
        self.c.tick()
        self.assertEqual(FakeAdapter.made[-1].sent[-1]["text"], "worker two 退出没交报告")

    def test_a_closed_session_is_not_hosted_and_the_sweep_is_skipped_without_a_board(self):
        key = self.open()["session"]
        self.cmd(cmd="close", request_id="c", session=key)
        self.assertIsNone(self.c.hosted_session(key.split(":", 1)[1]))
        self.c.wake_sweep()  # the test daemon has no board: nothing to do, nothing raised
        self.assertEqual(self.c._wake_out, [])

    def test_tick_runs_a_sweep_every_wake_interval(self):
        import chatd
        calls = []
        self.c.wake_sweep = lambda: calls.append(1)
        self.now[0] += chatd.WAKE_EVERY + 1
        self.c.tick()
        self.c.tick()
        self.assertEqual(calls, [1])


class Install(unittest.TestCase):
    def test_hooks_cover_prompt_tool_and_stop_for_both_engines(self):
        import engines
        import hooks_setup
        with tempfile.TemporaryDirectory() as tmp:
            for agent, expect in (("claude-code", {"UserPromptSubmit", "PostToolUse", "Stop", "SubagentStop"}),
                                  ("codex", {"UserPromptSubmit", "PostToolUse", "Stop"})):
                path = os.path.join(tmp, agent + ".json")
                eng = engines.get(agent)
                hooks_setup.install(eng, path, trust=False)
                hooks = H.L.load(path)["hooks"]
                self.assertTrue(expect <= set(hooks), agent)
                # Dispatch's one entry (hook.py) on each: its life feature reaches `dispatch handoff hook` at the line
                self.assertTrue(all(hooks[e][0]["hooks"][0]["command"] == hooks_setup.command(eng) for e in expect))
                self.assertTrue(all("life" in eng.hook_routes[e] for e in expect))


if __name__ == "__main__":
    unittest.main()
