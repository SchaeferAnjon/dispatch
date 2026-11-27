import contextlib
import io
import glob
import json
import re
import os
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import dispatch as D
import docs_view
import handoff as H
import session_life as L
import tasks_view as T
from test_chatd import Base, FakeAdapter
REGISTER_DOC = docs_view.register


class Fixture:
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name
        self.issue = {"id": "task-demo", "title": "Continue the demo", "labels": ["project:demo", "session:abc"],
                      "status": "in_progress", "metadata": {"plan": [{"text": "verify", "state": "active"}]}}
        self.docs, self.comments = [], []
        def register(*args, **kwargs):
            self.docs.append((args, kwargs)); return {"id": "doc-1"}
        def shell(args):
            self.comments.append(args); return 0, "", ""
        for p in (patch.object(D, "DISPATCH_DIR", self.root), patch.object(T, "show_issue", return_value=self.issue),
                  patch.object(docs_view, "register", side_effect=register), patch.object(D, "bd_comments", return_value=[]),
                  patch.object(D, "sh", side_effect=shell),
                  patch("workers.Store.load", return_value={"workers": {}})):
            p.start(); self.addCleanup(p.stop)


class Store(Fixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        p = patch("handoff_facts.repo_candidates", return_value=[])
        p.start(); self.addCleanup(p.stop)

    def write(self, **kwargs):
        return H.write("task-demo", "codex:abc", {"goal": "Keep CANARY-42", "completed": ["test passed"], "next": "Continue"},
                       boundary={"native_session": "codex:native", "messages": 12, "rounds": 6, "context_tokens": 100}, **kwargs)

    def test_file_task_docs_and_boundary_share_an_id(self):
        r = self.write(request="one")
        self.assertEqual((r["after_message"], r["after_turn"]), (12, 6))
        self.assertEqual(H.latest("task-demo"), H.latest("codex:abc"))
        self.assertIn("CANARY-42", open(r["path"]).read())
        self.assertEqual(self.docs[0][1]["kind"], "handoff")
        self.assertEqual(self.docs[0][1]["tasks"], ["task-demo"])
        # the comment that hangs the handoff on the task (other bd calls the shell sees, such as a show, are not it)
        added = [c for c in self.comments if c[:3] == ["bd", "comments", "add"]]
        self.assertEqual(len(added), 1, self.comments)
        self.assertIn("[handoff:one]", added[0][-1])
        self.write(request="one")
        self.assertEqual(len(self.docs), 1)
        self.assertEqual(T.task_row(self.issue)["handoffs"][0]["id"], "one")

    def test_a_task_list_reads_the_index_once_and_sees_a_new_handoff(self):
        self.write(request="one")
        with patch.object(H, "database", wraps=H.database) as opened:
            self.assertEqual([h["id"] for h in T.task_row(self.issue)["handoffs"]], ["one"])
            for _ in range(5):
                T.task_row(dict(self.issue, id="task-other"))
            self.assertEqual(opened.call_count, 1)
        self.write(request="two")
        self.assertEqual(sorted(h["id"] for h in T.task_row(self.issue)["handoffs"]), ["one", "two"])
        self.assertEqual(H.task_records("task-demo"), H.records("task-demo"))

    def test_record_carries_the_plan_step_it_was_written_in(self):
        self.issue["metadata"]["plan"] = [{"text": "read", "state": "done"}, {"text": "verify", "state": "active"}, {"text": "ship", "state": "todo"}]
        r = self.write()
        self.assertEqual(r["plan_step"], {"index": 1, "text": "verify", "state": "active"})
        self.assertEqual(H.latest("task-demo")["plan_step"]["index"], 1)
        self.assertEqual(H.life_fields("codex:abc")["handoffs"][0]["plan_step"]["text"], "verify")
        self.assertEqual(T.task_row(self.issue)["handoffs"][0]["plan_step"]["index"], 1)
        self.assertEqual(H.plan_step([{"text": "a", "state": "done"}, {"text": "b", "state": "todo"}])["index"], 0)
        self.assertIsNone(H.plan_step([]))
        self.assertIsNone(H.write("", "codex:lonely", {"goal": "g"}, boundary={"messages": 1})["plan_step"])

    def test_registration_uses_the_real_docs_function_in_a_fresh_cli(self):
        registered = []
        with patch.object(docs_view, "D", None), patch.object(docs_view, "register", REGISTER_DOC), \
             patch.object(D, "docs_registered", return_value=[]), \
             patch.object(D, "docs_save", side_effect=lambda project, entries, keep="": registered.extend(entries)), \
             patch.object(D, "docs_registered_rows", side_effect=lambda entries: entries):
            rec = self.write()
        self.assertTrue(rec["registered"])
        self.assertEqual(registered[0]["kind"], "handoff")
        self.assertEqual(registered[0]["tasks"], ["task-demo"])

    def test_docs_failure_does_not_authorize_clear(self):
        with patch.object(docs_view, "register", side_effect=ValueError("offline")):
            with self.assertRaises(ValueError): self.write(request="failure")
        self.assertIsNone(H.latest("failure"))
        self.assertEqual(len(H.records("failure", registered=False)), 1)

    def test_combined_prime_and_handoff_spill_whole_before_hook_limit(self):
        r = self.write()
        prime = "中文 prime\\\"\n" * 3000
        text = H.resume_text(r, prime)
        self.assertLess(len(text.encode()), 10000)
        self.assertIn("先完整读取", text.splitlines()[0])
        full = glob.glob(os.path.join(self.root, "handoffs", "resume-" + r["id"] + "-*.md"))[0]
        saved = open(full).read()
        self.assertIn(prime.strip(), saved)
        self.assertIn("CANARY-42", saved)
        H.resume_text(r, prime + "other snapshot")
        self.assertEqual(open(full).read(), saved)

    def test_show_accepts_bare_session_ids_and_rejects_ambiguous_prefixes(self):
        sid = "11111111-2222-3333-4444-555555555555"
        r = H.write("task-demo", "codex:" + sid, boundary={"messages": 1})
        self.assertEqual(H.latest(sid)["id"], r["id"])
        self.assertEqual(H.latest(sid[:8])["id"], r["id"])
        H.write("task-demo", "codex:" + sid[:-1] + "6", boundary={"messages": 1})
        with self.assertRaises(ValueError): H.latest(sid[:8])

    def test_tasks_stay_in_the_window_after_the_engine_id_changes(self):
        L.save(L.path_for("runtime", "codex:window-id"), {"native_contexts": {"codex:before-clear": {}, "codex:after-clear": {}}})
        self.assertEqual(T.session_keys("agent-host-codex:/window-id"), ["window-id", "before-clear", "after-clear"])

    def test_prime_after_clear_resolves_original_and_new_terminal_id(self):
        r = self.write()
        section = H.prime_section("codex:abc", {"source": "clear"}, [self.issue])
        self.assertIn("CANARY-42", "\n".join(section))
        ticket = os.path.join(self.root, "ticket.json")
        L.save(ticket, {"session": "codex:abc", "at": r["created_at"] - 1})
        with patch.object(H, "terminal_ticket", return_value=ticket):
            self.assertIn("CANARY-42", "\n".join(H.prime_section("new", {"source": "clear"}, [])))
        self.assertEqual(H.prime_section("codex:abc", {"source": "startup"}, [self.issue]), [])

    def test_hooks_warn_once_then_stop_requests_handoff_once(self):
        life = {"epoch": 0, "status": "warning", "percent": 80, "context_tokens": 80, "limit_tokens": 100}
        with patch.object(L, "measure", return_value=life), patch.object(H, "tasks_for", return_value=[self.issue]), patch.object(H, "terminal_ticket", return_value=os.path.join(self.root, "ticket")):
            data = {"session_id": "abc", "hook_event_name": "PostToolUse"}
            self.assertIn("80%", json.dumps(H.hook(data, "codex")))
            self.assertEqual(H.hook(data, "codex"), {})
            life.update(status="limit", percent=100, context_tokens=100)
            data["hook_event_name"] = "Stop"
            self.assertEqual(H.hook(data, "codex")["decision"], "block")
            self.assertEqual(H.hook(data, "codex"), {})

    def test_reminder_line_does_not_say_the_limit_was_reached(self):
        life = {"epoch": 0, "status": "warning", "percent": 81, "context_tokens": 81, "limit_tokens": 100}
        with patch.object(L, "measure", return_value=life), patch.object(H, "tasks_for", return_value=[]):
            text = json.dumps(H.hook({"session_id": "remind", "hook_event_name": "PostToolUse"}, "codex"), ensure_ascii=False)
        self.assertIn("handoff reminder", text)
        self.assertIn("has not been reached yet", text)
        self.assertNotIn("limit has been reached", text)
        self.assertIn("limit has been reached", H.write_instruction("", "codex:x", terminal=True))

    def reminder_then_write(self, session, cwd):
        life = {"epoch": 0, "status": "warning", "percent": 87.5, "context_tokens": 700, "limit_tokens": 800}
        with patch.object(L, "measure", return_value=life), patch.object(H, "tasks_for", return_value=[]):
            self.assertIn("handoff reminder", json.dumps(H.hook({"session_id": session.split(":")[1], "hook_event_name": "PostToolUse"}, "claude-code")))
        with patch.dict(os.environ, {"DISPATCH_LIFE_MANAGED": ""}):
            return H.write("", session, {"goal": "Keep CLEAR-CANARY", "next": "run the tests"}, boundary={"messages": 3}, cwd=cwd)

    def test_reminder_line_handoff_then_clear_reaches_the_new_context(self):
        """提醒线写交接，再 /clear：the new id has no task and no Stop ticket, the write left one."""
        cwd = os.path.realpath(self.root)
        with patch.object(H, "engine_process", return_value=(4242, "claude-code")):
            self.reminder_then_write("claude-code:aaaa-old", cwd)
            section = "\n".join(H.prime_section("bbbb-new", {"source": "clear", "cwd": cwd}, []))
        self.assertIn("CLEAR-CANARY", section)
        self.assertIn("没有挂到任务", section)

    def test_clear_without_ticket_takes_the_same_folder_handoff_once(self):
        cwd = os.path.realpath(self.root)
        with patch.object(H, "engine_process", return_value=(4242, "claude-code")):
            self.reminder_then_write("claude-code:aaaa-old", cwd)
        # Another engine process (the ticket is not found): same engine, same folder, last 24 hours.
        with patch.object(H, "engine_process", return_value=(5151, "claude-code")), \
             patch.object(D, "_presence_by_pid", return_value={}):
            self.assertIn("CLEAR-CANARY", "\n".join(H.prime_section("bbbb-new", {"source": "clear", "cwd": cwd}, [])))
            self.assertIn("CLEAR-CANARY", "\n".join(H.prime_section("bbbb-new", {"source": "clear", "cwd": cwd}, [])))
            # A second cleared context does not get the same handoff again.
            self.assertEqual(H.prime_section("cccc-later", {"source": "clear", "cwd": cwd}, []), [])
            # Another folder or another engine never borrows it.
            self.assertEqual(H.prime_section("dddd", {"source": "clear", "cwd": "/"}, []), [])
            with patch.dict(os.environ, {"BEADS_ACTOR": "codex"}):
                self.assertEqual(H.prime_section("eeee", {"source": "clear", "cwd": cwd}, []), [])

    def test_clear_never_borrows_a_live_neighbours_handoff(self):
        cwd = os.path.realpath(self.root)
        with patch.object(H, "engine_process", return_value=(4242, "claude-code")):
            self.reminder_then_write("claude-code:aaaa-neighbour", cwd)
        with patch.object(H, "engine_process", return_value=(5151, "claude-code")), \
             patch.object(D, "_presence_by_pid", return_value={os.getpid(): {"session_id": "aaaa-neighbour"}}):
            self.assertEqual(H.prime_section("bbbb-new", {"source": "clear", "cwd": cwd}, []), [])

    def test_agents_window_write_leaves_no_terminal_ticket(self):
        with patch.dict(os.environ, {"DISPATCH_LIFE_MANAGED": str(os.getpid())}), \
             patch.object(H, "terminal_ticket") as ticket:
            H.write("", "claude-code:window", {"goal": "x"}, boundary={"messages": 1})
            ticket.assert_not_called()

    def assess(self, life):
        out = io.StringIO()
        body = json.dumps({"session": "claude-code:win", "native_session": "claude-code:nat", "cwd": self.root})
        with patch.object(L, "measure", return_value=life), patch.object(H, "handoff_task", return_value=""), \
             patch("sys.stdin", io.StringIO(body)), contextlib.redirect_stdout(out):
            H.command(SimpleNamespace(op="assess"))
        return json.loads(out.getvalue())

    def test_session_life_reports_handoff_state_through_the_agents_window_flow(self):
        life = {"epoch": 0, "status": "limit", "percent": 100, "context_tokens": 100, "limit_tokens": 100,
                "auto_handoff": True, "messages": 4, "rounds": 2, "tool_steps": 1, "cumulative_read_tokens": 100}
        self.assertEqual(H.life_fields("claude-code:win")["handoff_state"], "")
        request = self.assess(life)["request"]
        self.assertEqual((H.life_fields("claude-code:win")["handoff_state"], H.life_fields("claude-code:win")["handoff_phase"]), ("saving", "writing"))
        with patch.dict(os.environ, {"DISPATCH_LIFE_MANAGED": str(os.getpid())}):
            rec = H.write("", "claude-code:win", {"goal": "g"}, request=request, boundary={"messages": 4, "rounds": 2})
        fields = H.life_fields("claude-code:win")
        self.assertEqual((fields["handoff_state"], fields["handoff_phase"]), ("complete", "saved"))
        self.assertEqual([h["id"] for h in fields["handoffs"]], [rec["id"]])
        self.assertEqual(fields["handoffs"][0]["after_message"], 4)
        self.assertNotIn("request", self.assess(life))  # the measurement before /clear asks for nothing new
        self.assertEqual(H.life_fields("claude-code:win")["handoff_phase"], "preparing")
        with patch.object(H, "prime_for", return_value="PROMPT"), contextlib.redirect_stdout(io.StringIO()):
            H.command(SimpleNamespace(op="resume", target=request, cwd=self.root))
        self.assertEqual(H.life_fields("claude-code:win")["handoff_phase"], "clearing")
        life.update(status="ok", percent=5, context_tokens=5)
        self.assess(life)
        self.assertEqual((H.life_fields("claude-code:win")["handoff_state"], H.life_fields("claude-code:win")["handoff_phase"]), ("complete", "resumed"))
        self.assertEqual(H.life_fields("claude-code:win", now=time.time() + 700)["handoff_state"], "")
        # session life --json carries both fields
        out = io.StringIO()
        with patch.object(L, "measure", return_value=dict(life, session="claude-code:win")), contextlib.redirect_stdout(out):
            L.command(SimpleNamespace(target="claude-code:win", json=True))
        shown = json.loads(out.getvalue())
        self.assertEqual(shown["handoff_state"], "complete")
        self.assertEqual(shown["handoffs"][0]["path"], rec["path"])

    def test_a_cancelled_handoff_turn_does_not_stay_saving(self):
        life = {"epoch": 0, "status": "limit", "percent": 100, "context_tokens": 100, "limit_tokens": 100,
                "auto_handoff": True, "messages": 4, "rounds": 2, "tool_steps": 1, "cumulative_read_tokens": 100}
        request = self.assess(life)["request"]
        self.assertEqual(H.life_fields("claude-code:win")["handoff_state"], "saving")
        # the Agents window reports the cancelled turn
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            H.command(SimpleNamespace(op="fail", session="claude-code:win", request="", reason="Turn cancelled", target=""))
        self.assertTrue(json.loads(out.getvalue())["ok"])
        fields = H.life_fields("claude-code:win")
        self.assertEqual((fields["handoff_state"], fields["handoff_error"]), ("failed", "Turn cancelled"))
        # without that call: the next measurement after the writing turn finds nothing saved
        request = self.assess(life)["request"]
        life.update(status="ok", percent=10)
        self.assess(life)
        self.assertEqual(H.life_fields("claude-code:win")["handoff_state"], "failed")
        # a saved handoff is never reported failed
        with patch.dict(os.environ, {"DISPATCH_LIFE_MANAGED": str(os.getpid())}):
            H.write("", "claude-code:win", {"goal": "g"}, request=request, boundary={"messages": 4})
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            H.command(SimpleNamespace(op="fail", session="claude-code:win", request=request, reason="", target=""))
        self.assertFalse(json.loads(out.getvalue())["ok"])
        self.assertEqual(H.life_fields("claude-code:win")["handoff_state"], "complete")

    def test_unregistered_handoff_is_a_failed_state(self):
        life = {"epoch": 0, "status": "limit", "percent": 100, "context_tokens": 100, "limit_tokens": 100,
                "auto_handoff": True, "messages": 4, "rounds": 2, "tool_steps": 1, "cumulative_read_tokens": 100}
        request = self.assess(life)["request"]
        with patch.object(docs_view, "register", side_effect=ValueError("offline")), self.assertRaises(ValueError):
            H.write("task-demo", "claude-code:win", {"goal": "g"}, request=request)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            H.command(SimpleNamespace(op="resume", target=request, cwd=self.root))
        fields = H.life_fields("claude-code:win")
        self.assertEqual(fields["handoff_state"], "failed")
        self.assertEqual(fields["handoffs"], [])

    def test_contacts_record_workers_waits_and_discussion_files(self):
        row = {"name": "peer", "task": "task-demo", "tasks": ["task-demo"], "brief": "/brief",
               "report": "/report", "log": "/log"}
        folder = os.path.join(self.root, "discussions")
        os.mkdir(folder)
        path = os.path.join(folder, "task-demo.json")
        with open(path, "w") as f: f.write("{}")
        with patch("workers.Store.load", return_value={"workers": {"peer": row}}), patch("workers.alive", return_value=True):
            contacts = H.agent_contacts("", self.root)
        self.assertEqual(contacts["waiting_for"][0]["worker"], "peer")
        self.assertEqual(contacts["discussion_files"], [path])

    def test_nobody_to_wait_for_is_one_sentence_not_a_form(self):
        # task-lz5wc: an empty Other agents section carried instructions to the author into the next session
        with patch("workers.Store.load", return_value={"workers": {}}):
            text = H.contacts_text(H.agent_contacts("task-demo", self.root))
        self.assertIsInstance(text, str)
        self.assertNotIn("write none", text)
        self.assertNotIn("写无", text)

    def test_the_conversations_other_handoffs_are_listed(self):
        # task-lz5wc: a conversation that handed over three tasks left three files; the next session found one
        now = time.time()
        with H.database(self.root) as db:
            # task-b handed off ten times: listed once (its latest), and task-d is not crowded out
            # and handoffs without a task are each listed (second review 10-22)
            older = [("task-b", 400 + k) for k in range(10)] + [("task-d", 900), ("", 950), ("", 960)]
            for i, (task, age) in enumerate((("task-a", 600), ("task-b", 300), ("task-c", 3 * 86400), *older)):
                rec = {"id": "r%d" % i, "task": task, "session": "claude-code:conv", "created_at": now - age,
                       "title": "Context handoff: work %s" % task, "path": "/h/%s.md" % task}
                db.execute("INSERT INTO handoffs VALUES (?,?,?,?,?,?,?)", (rec["id"], task, rec["session"], rec["session"], rec["created_at"], 1, json.dumps(rec)))
        got = H.earlier_handoffs("claude-code:conv", "task-a", self.root, now=now)
        self.assertEqual([r["task"] for r in got], ["task-b", "task-d", "", ""])  # not this task, not older than two days
        self.assertEqual(got[0]["id"], "r1")  # task-b's latest

    def test_parallel_stop_hooks_block_only_once_per_epoch(self):
        from concurrent.futures import ThreadPoolExecutor
        life = {"epoch": 0, "status": "limit", "percent": 100, "context_tokens": 100, "limit_tokens": 100}
        data = {"session_id": "parallel", "hook_event_name": "Stop"}
        with patch.object(L, "measure", return_value=life), patch.object(H, "tasks_for", return_value=[]), \
             patch.object(H, "terminal_ticket", return_value=os.path.join(self.root, "ticket")):
            with ThreadPoolExecutor(max_workers=3) as pool:
                results = list(pool.map(lambda _: H.hook(data, "codex"), range(3)))
            self.assertEqual(sum(r.get("decision") == "block" for r in results), 1)
            life["epoch"] = 1
            self.assertEqual(H.hook(data, "codex")["decision"], "block")

    def test_child_write_uses_its_compaction_epoch(self):
        session = "claude-code:parent/subagent/kid"
        path = os.path.join(self.root, "child.jsonl")
        with open(path, "w") as f:
            f.write(json.dumps({"type": "system", "subtype": "compact_boundary"}) + "\n")
            f.write(json.dumps({"type": "assistant", "isSidechain": True, "message": {"usage": {"input_tokens": 100}}}) + "\n")
        L.save(L.path_for("hooks", session), {"epoch": "1", "transcript": path})
        H.write("", session, {"goal": "Continue child"})
        receipt = L.load(L.path_for("hooks", session))
        self.assertEqual(receipt["written_epoch"], "1")
        self.assertIn("Continue child", "\n".join(H.prime_section("parent", {"source": "compact", "agent_id": "kid"}, [])))

    def test_terminal_handoff_keeps_working_and_compact_injects_record(self):
        text = H.write_instruction("task-demo", "codex:abc", terminal=True)
        self.assertIn("continue your task and worker scheduling in this same turn", text)
        self.assertNotIn("end this turn", text)
        self.assertNotIn("/clear", text)
        self.write()
        section = H.prime_section("codex:abc", {"source": "compact"}, [])
        self.assertIn("CANARY-42", "\n".join(section))
        self.assertIn("和其他 Agent 的往来", "\n".join(section))
        self.assertIn("whose reply is pending", text)
        self.assertIn("end this turn", H.write_instruction("task-demo", "codex:abc"))

    def test_child_never_borrows_parent_usage_or_receipt(self):
        path = os.path.join(self.root, "child.jsonl")
        with open(path, "w") as f: f.write("{}\n")
        life = {"epoch": 0, "status": "limit", "percent": 100, "context_tokens": 100, "limit_tokens": 100}
        data = {"session_id": "parent", "hook_event_name": "SubagentStop", "agent_id": "kid",
                "transcript_path": os.path.join(self.root, "parent.jsonl"), "agent_transcript_path": path}
        with patch.object(L, "measure", return_value=life) as measure, patch.object(H, "tasks_for", return_value=[]):
            result = H.hook(data, "claude-code")
            self.assertEqual(result["decision"], "block")
            self.assertIn("claude-code:parent/subagent/kid", result["reason"])
            self.assertTrue(measure.call_args.kwargs["subagent"])
            self.assertEqual(measure.call_args.kwargs["transcript"], path)
            self.assertEqual(H.hook(data, "claude-code"), {})
            self.assertFalse(L.load(L.path_for("hooks", "claude-code:parent")))
        del data["agent_transcript_path"]
        with patch.object(L, "measure") as measure:
            self.assertEqual(H.hook(data, "claude-code"), {})
            measure.assert_not_called()

    def test_child_compact_does_not_inject_parent_handoff(self):
        self.write()
        with patch.object(H, "terminal_ticket") as ticket:
            self.assertEqual(H.prime_section("codex:abc", {"source": "compact", "agent_id": "kid"}, [self.issue]), [])
            ticket.assert_not_called()

    def test_hook_install_keeps_foreign_entries_and_is_idempotent(self):
        import engines
        path = os.path.join(self.root, "hooks.json")
        L.save(path, {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "my-hook"}]}]}})
        for _ in range(2):
            engines.get("codex").install_hooks(path=path, trust=False)
        hooks = L.load(path)["hooks"]
        self.assertEqual(len(hooks["Stop"]), 2)
        self.assertEqual(hooks["Stop"][0]["hooks"][0]["command"], "my-hook")
        self.assertEqual(len(hooks["SessionStart"]), 1)
        raw = open(path).read()
        self.assertEqual(raw, json.dumps(json.loads(raw), ensure_ascii=False, indent=2) + "\n")

    def test_only_current_claims_are_handoff_tasks(self):
        def issue(ident, status, owner, touched="abc", updated="2026-09-29"):
            return {"id": ident, "status": status, "labels": ["session:" + touched],
                    "updated_at": updated, "metadata": {"claim_session": owner}}
        issues = [issue("task-closed", "closed", "abc"),
                  issue("task-touched", "in_progress", "other"),
                  issue("task-unclaimed", "in_progress", ""),
                  issue("task-active", "in_progress", "abc", updated="2026-09-20")]
        self.assertEqual([t["id"] for t in H.tasks_for("codex:abc", issues, claimed=True)], ["task-active"])
        self.assertEqual(H.tasks_for("codex:dispatcher", issues, claimed=True), [])

    def test_unclaimed_session_falls_back_to_the_task_it_logged_on(self):
        def issue(ident, status, owner="", touched="abc", updated="2026-09-29", labels=()):
            return {"id": ident, "status": status, "labels": ["session:" + touched, *labels],
                    "updated_at": updated, "metadata": {"claim_session": owner}}
        issues = [issue("task-old", "in_progress", updated="2026-09-20"),
                  issue("task-logged", "in_progress", updated="2026-09-29"),
                  issue("task-closed", "closed", updated="2026-09-30"),
                  issue("task-trashed", "in_progress", updated="2026-09-30", labels=("dispatch:trashed",)),
                  issue("task-other", "in_progress", touched="zzz", updated="2026-09-30")]
        self.assertEqual(H.handoff_task("codex:abc", issues=issues), "task-logged")
        issues.append(issue("task-claimed", "in_progress", owner="abc", updated="2026-09-01"))
        self.assertEqual(H.handoff_task("codex:abc", issues=issues), "task-claimed")
        self.assertEqual(H.handoff_task("codex:nobody", issues=issues), "")
        self.assertEqual(H.handoff_task("codex:nobody", "codex:abc", issues=issues), "task-claimed")

    def test_cli_write_without_a_task_attaches_to_the_logged_task(self):
        err, out = io.StringIO(), io.StringIO()
        args = SimpleNamespace(op="write", target="", session="codex:abc", request="", stdin=True, from_file="", json=False)
        body = json.dumps({"goal": "g", "completed": ["commit abc1234"], "next": "run python3 -m unittest"})
        with patch.object(H, "handoff_task", return_value="task-demo") as pick, patch("sys.stdin", io.StringIO(body)), \
             contextlib.redirect_stdout(out), patch("handoff_facts.problems", return_value=[]):
            H.command(args)
        pick.assert_called_once_with("codex:abc")
        self.assertEqual(H.latest("codex:abc")["task"], "task-demo")
        self.assertIn("任务和 Docs", out.getvalue())

    def test_unattached_handoff_says_so_in_file_prime_and_instruction(self):
        rec = H.write("", "codex:lonely", {"goal": "Keep LONELY"}, boundary={"messages": 1})
        text = open(rec["path"], encoding="utf-8").read()
        self.assertIn("## 没有挂到任务", text)
        self.assertIn("dispatch claim <任务>", text)
        section = "\n".join(H.prime_section("codex:lonely", {"source": "compact"}, []))
        self.assertIn("没有挂到任务", section)
        self.assertIn("dispatch claim <task>", H.write_instruction("", "codex:lonely", terminal=True))
        self.assertNotIn("dispatch claim <task>", H.write_instruction("task-demo", "codex:lonely", terminal=True))
        # Dispatch's MCP tool first, with every value it needs; the command stays as the fallback
        text = H.write_instruction("task-demo", "codex:lonely", request="req-1")
        self.assertIn('handoff_write tool with {"task": "task-demo", "session": "codex:lonely", "request": "req-1"', text)
        self.assertIn("dispatch handoff write task-demo --session codex:lonely --stdin --request req-1", text)
        self.assertNotIn("没有挂到任务", open(self.write()["path"], encoding="utf-8").read())

    def test_claim_from_previous_native_context_stays_with_the_window(self):
        L.save(L.path_for("runtime", "codex:window-id"), {"native_contexts": {"codex:before-clear": {}, "codex:after-clear": {}}})
        issue = {"id": "task-active", "status": "in_progress", "metadata": {"claim_session": "before-clear"}}
        self.assertEqual(H.tasks_for("codex:window-id", [issue], claimed=True), [issue])
        issue["metadata"]["claim_session"] = "another-window"
        self.assertEqual(H.tasks_for("codex:window-id", [issue], claimed=True), [])

    def test_claude_hook_install_preserves_settings_as_indented_json(self):
        import engines
        path = os.path.join(self.root, "claude-settings.json")
        L.save(path, {"permissions": {"allow": ["Read"]}, "model": "sonnet"})
        import hooks_setup
        hooks_setup.install(engines.get("claude-code"), path, trust=False)
        with open(path) as f:
            raw = f.read()
        saved = json.loads(raw)
        self.assertEqual(saved["model"], "sonnet")
        self.assertEqual(saved["permissions"], {"allow": ["Read"]})
        self.assertEqual(raw, json.dumps(saved, ensure_ascii=False, indent=2) + "\n")

    def test_session_only_handoff_does_not_read_or_modify_a_task(self):
        with patch.object(T, "show_issue") as show, patch.object(D, "bd_comments") as comments:
            rec = H.write("", "codex:dispatcher", {"goal": "Keep DISPATCHER_CANARY"}, boundary={"messages": 3})
        show.assert_not_called()
        comments.assert_not_called()
        self.assertEqual(self.docs, [])
        self.assertTrue(rec["registered"])
        self.assertEqual(rec["task"], "")
        self.assertEqual(H.latest("codex:dispatcher")["id"], rec["id"])
        self.assertIn("DISPATCHER_CANARY", H.resume_text(rec))

    def test_limit_without_a_claim_requests_session_only_handoff(self):
        life = {"epoch": 0, "status": "limit", "percent": 100, "context_tokens": 100, "limit_tokens": 100}
        with patch.object(L, "measure", return_value=life), patch.object(H, "tasks_for", return_value=[]), \
             patch.object(H, "terminal_ticket", return_value=os.path.join(self.root, "ticket")):
            result = H.hook({"session_id": "dispatcher", "hook_event_name": "Stop"}, "codex")
        self.assertEqual(result["decision"], "block")
        self.assertIn("handoff write --session codex:dispatcher --stdin", result["reason"])

    def test_missing_handoff_is_a_plain_cli_error(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as raised:
            H.command(SimpleNamespace(op='show', target='task-missing', json=True))
        self.assertEqual(raised.exception.code, 2)
        self.assertIn('还没有', err.getvalue())
        self.assertNotIn('Traceback', err.getvalue())

    def test_post_tool_handoff_is_not_requested_again_at_stop(self):
        stamp = L.path_for("hooks", "codex:abc")
        L.save(stamp, {"epoch": "0", "limit_warned": True})
        self.write()
        life = {"epoch": 0, "status": "limit", "percent": 105, "context_tokens": 105, "limit_tokens": 100}
        with patch.object(L, "measure", return_value=life):
            self.assertEqual(H.hook({"session_id": "abc", "hook_event_name": "Stop"}, "codex"), {})

    def test_stopped_host_does_not_disable_terminal_hooks_forever(self):
        L.save(L.path_for('managed', 'codex:abc'), {'session': 'codex:window', 'host_pid': 999999})
        life = {"epoch": 0, "status": "warning", "percent": 80, "context_tokens": 80, "limit_tokens": 100}
        with patch.dict(os.environ, {'DISPATCH_LIFE_MANAGED': ''}), patch.object(os, 'kill', side_effect=ProcessLookupError), patch.object(L, 'measure', return_value=life):
            self.assertIn('80%', json.dumps(H.hook({'session_id':'abc', 'hook_event_name':'PostToolUse'}, 'codex')))

    def test_live_host_owns_automatic_handoff(self):
        L.save(L.path_for('managed', 'codex:abc'), {'session': 'codex:window', 'host_pid': os.getpid()})
        with patch.dict(os.environ, {'DISPATCH_LIFE_MANAGED': ''}), patch.object(L, 'measure') as measure:
            self.assertEqual(H.hook({'session_id':'abc', 'hook_event_name':'PostToolUse'}, 'codex'), {})
            measure.assert_not_called()

    def test_native_host_environment_owns_fresh_thread_before_marker_exists(self):
        with patch.dict(os.environ, {"DISPATCH_LIFE_MANAGED": str(os.getpid())}), \
             patch.object(L, "measure") as measure:
            self.assertEqual(H.hook({"session_id": "fresh-native-thread", "hook_event_name": "Stop"}, "codex"), {})
            measure.assert_not_called()


class Automatic(Base):
    def setUp(self):
        super().setUp()
        # This is an adapter/state-machine test, not a live task-board integration.
        # A busy or offline user's board must not prevent the fixture's handoff.
        tasks = patch.object(H, "tasks_for", return_value=[{"id": "task-demo"}])
        tasks.start()
        self.addCleanup(tasks.stop)

    def start_limit(self):
        key = self.open(task="task-demo")["session"]
        self.c.life_settings = {"session_life_tokens": 100}
        self.cmd(cmd="send", session=key, message_id="user-1", text="do work")
        old = self.c.sessions[key].adapter
        old.emit("life_usage", request_id="r1", usage={"input": 100})
        old.finish()
        # Keep the handoff state-machine test independent of the user's live board.
        with patch.object(H, "tasks_for", return_value=[{"id": "task-demo"}]):
            self.c.tick(reap=False); self.c.tick(reap=False)
        return key, old

    def test_limit_writes_then_rebinds_same_conversation_and_preserves_queue(self):
        key, old = self.start_limit()
        sess = self.c.sessions[key]
        self.assertIn("dispatch handoff write", old.sent[-1]["text"])
        self.assertEqual(H.life_fields(key, base=self.c.d.DISPATCH_DIR)["handoff_phase"], "writing")
        self.cmd(cmd="send", session=key, message_id="user-2", text="next question")
        request = sess.life_phase["request"]
        old.finish()
        rec = {"id": request, "session": key, "path": "/handoff.md", "after_message": 4}
        with patch.object(H, "latest", return_value=rec), patch.object(H, "prime_for", return_value="FULL PRIME\nCANARY HANDOFF\n接着做"):
            for _ in range(4): self.c.tick(reap=False)
        new = sess.adapter
        self.assertIsNot(new, old)
        self.assertEqual(list(self.c.sessions), [key])
        self.assertIn("FULL PRIME\nCANARY HANDOFF", new.sent[0]["text"])
        self.assertEqual(sess.queue[0]["text"], "next question")
        self.assertEqual(H.life_fields(key, base=self.c.d.DISPATCH_DIR)["handoff_phase"], "resuming")
        new.finish(); self.c.tick(reap=False)
        self.assertEqual(H.life_fields(key, base=self.c.d.DISPATCH_DIR)["handoff_phase"], "resumed")
        self.assertEqual(new.sent[-1]["text"].splitlines()[-1], "next question")
        self.assertEqual(sess.life_contexts[0]["native_session"], key)
        self.assertNotIn("Context lifetime", new.sent[-1]["text"])
        self.assertTrue(any(e.get("handoff", {}).get("id") == request for e in self.events))
        self.assertFalse(any(e["ev"] == "closed" for e in self.events))

    def test_missing_handoff_or_failed_agent_retains_context(self):
        key, old = self.start_limit()
        old.finish()
        with patch.object(H, "latest", return_value=None):
            for _ in range(3): self.c.tick(reap=False)
        self.assertIs(self.c.sessions[key].adapter, old)
        self.assertIsNone(old.closed_with)
        self.assertTrue(any("retained" in e.get("text", "") for e in self.events))

    def test_stop_during_preparation_keeps_the_original_engine(self):
        key, old = self.start_limit()
        old.finish()
        jobs = []
        self.c.background = jobs.append
        self.c.tick(reap=False)
        self.cmd(cmd="interrupt", session=key, request_id="stop")
        self.assertEqual(self.reply("stop")["status"], "interrupted")
        self.c.tick(reap=False)
        self.assertIs(self.c.sessions[key].adapter, old)
        self.assertIsNone(old.closed_with)


class Quality(Fixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        p = patch("handoff_facts.KNOWN_REPOS", ())
        p.start(); self.addCleanup(p.stop)
        # write() measures the session when no boundary is given; that reaches for chatd
        p = patch.object(L, "measure", return_value={"native_session": "codex:native", "messages": 1})
        p.start(); self.addCleanup(p.stop)

    GOOD = {"goal": "Ship it", "completed": ["改了 app/cli/handoff.py，提交 a1b2c3d", "npm test 518 项通过"],
            "next": "cd app && npm run test:py", "pitfalls": "无"}

    def cli(self, content, **extra):
        args = SimpleNamespace(op="write", target="task-demo", session="codex:abc", stdin=True, from_file=None,
                               request="", json=True, **extra)
        err, out = io.StringIO(), io.StringIO()
        raw = content if isinstance(content, str) else json.dumps(content)
        with patch("sys.stdin", io.StringIO(raw)), contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            try:
                H.command(args)
                code = 0
            except SystemExit as e:
                code = e.code
        return code, out.getvalue(), err.getvalue()

    def assertRejected(self, content, *words):
        code, out, err = self.cli(content)
        self.assertEqual(code, 2, err)
        for w in words:
            self.assertIn(w, err)
        self.assertNotIn("Traceback", err)
        self.assertEqual(self.docs, [])
        self.assertEqual(H.records("task-demo", registered=False), [])   # nothing saved, context is kept
        self.assertEqual(glob.glob(os.path.join(self.root, "handoffs", "task-demo", "*.md")), [])
        return err

    # --- rejection
    def test_missing_or_empty_next_is_rejected(self):
        for value in (None, "", "  ", "无", [], ["无"]):
            body = {**self.GOOD, "next": value}
            if value is None:
                del body["next"]
            self.assertRejected(body, "下一步")
        self.assertRejected({}, "下一步")

    def test_completed_without_any_evidence_is_rejected_but_one_item_is_enough(self):
        self.assertRejected({**self.GOOD, "completed": ["测试过了", "都做完了"]}, "做完了什么", "提交号")
        for item in ("提交 a1b2c3d", "改了 app/cli/handoff.py", "改了 handoff.py", "1829 项通过", "看 ~/notes.md"):
            code, _, err = self.cli({**self.GOOD, "completed": ["测试过了", item], "request": ""})
            self.assertEqual(code, 0, (item, err))
            self.docs.clear()
        # an empty completed list is not "non-empty without evidence"
        self.assertEqual(self.cli({**self.GOOD, "completed": []})[0], 0)

    def test_free_markdown_needs_the_sections(self):
        self.assertRejected("随便写点东西", "目标", "做完了什么", "下一步")
        self.assertRejected("## 目标\n继续\n\n## 做完了什么\n改了 handoff.py\n", "下一步")
        self.assertRejected("## 目标\n继续\n\n## 做完了什么\n改了 handoff.py\n\n## 下一步\n无\n", "下一步")
        self.assertRejected("## 目标\n继续\n\n## 做完了什么\n全部完成\n\n## 下一步\n跑 npm test\n", "证据")
        ok = "## 目标\n继续\n\n## 做完了什么\n- 改了 app/cli/handoff.py\n\n## 下一步\n跑 npm test\n"
        self.assertEqual(self.cli(ok)[0], 0)

    def test_rejection_is_one_actionable_message_with_a_valid_example(self):
        err = self.assertRejected({"goal": "x"}, "拒收", "没有保存")
        example = json.loads(err[err.index("{"):])
        self.assertEqual(H.F.problems(example) if hasattr(H, "F") else __import__("handoff_facts").problems(example), [])
        code, out, err2 = self.cli(example)
        self.assertEqual(code, 0, err2)          # the agent can rewrite by copying it
        self.assertTrue(H.latest("task-demo")["registered"])

    def test_write_api_without_the_gate_keeps_plan_fallback(self):
        # chatd, tests and other callers of write() are not gated; only the CLI command is
        rec = H.write("task-demo", "codex:abc", {"goal": "x"}, boundary={})
        self.assertTrue(rec["registered"])

    # --- collection
    def repo(self, name="r"):
        import subprocess
        path = os.path.join(self.root, name)
        os.makedirs(path)
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        def git(*a, date=None):
            e = dict(env, **({"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date} if date else {}))
            subprocess.run(["git", "-C", path, *a], check=True, capture_output=True, env=e)
        git("init", "-q", "-b", "main")
        open(os.path.join(path, "a.txt"), "w").write("1")
        git("add", "."); git("commit", "-qm", "feat: first (task-demo)", date="2020-01-01T00:00:00")
        open(os.path.join(path, "a.txt"), "w").write("2")
        git("commit", "-qam", "fix: unrelated (task-other)")
        git("commit", "-qam", "fix: second (task-demo)", "--allow-empty", date="2026-09-29T00:00:00")
        open(os.path.join(path, "dirty.txt"), "w").write("x")
        return path, git

    def facts(self, **kwargs):
        import handoff_facts as F
        args = dict(task="task-demo", issue=self.issue, plan=[], base=self.root, cwd=self.root, comments=[])
        args.update(kwargs)
        return F.collect(**args)

    def test_commits_by_task_id_since_last_handoff_and_uncommitted_files(self):
        import handoff_facts as F
        path, git = self.repo()
        with patch.object(F, "KNOWN_REPOS", (path, os.path.join(self.root, "nope"))):
            text = self.facts(cwd=path)
            self.assertIn("first", text); self.assertIn("second", text)
            self.assertNotIn("unrelated", text)
            self.assertIn("?? dirty.txt", text)
            since = __import__("time").mktime((2021, 1, 1, 0, 0, 0, 0, 0, -1))
            text = self.facts(cwd=path, since=since)
            self.assertIn("自上次交接以来", text)
            self.assertIn("second", text); self.assertNotIn("first (task-demo)", text)
            self.assertEqual(self.facts(cwd=path).count("- r "), 2)   # repo listed once, named after its folder

    def test_worktree_of_a_known_repo_is_not_listed_twice(self):
        import handoff_facts as F
        import subprocess
        path, git = self.repo()
        wt = os.path.join(self.root, "wt")
        git("worktree", "add", "-q", "-b", "side", wt)
        with patch.object(F, "KNOWN_REPOS", (path,)):
            names = F.repo_candidates(wt)
        self.assertEqual(len(names), 1)

    def test_only_repositories_that_exist_are_listed(self):
        import handoff_facts as F
        with patch.object(F, "KNOWN_REPOS", (os.path.join(self.root, "a"), os.path.join(self.root, "b"))):
            self.assertEqual(F.repo_candidates(""), [])
            text = self.facts(cwd=self.root)
        self.assertIn("取不到：本机没有找到 git 仓库", text)

    def test_board_section_has_plan_status_and_recent_progress(self):
        comments = [{"text": f"step {i}", "created_at": f"2026-09-29T0{i}:00:00"} for i in range(7)]
        comments.append({"text": "[handoff:x] Context handed off"})
        text = self.facts(plan=T.clean_plan([{"text": "verify", "state": "active"}]), comments=comments)
        self.assertIn("verify（进行中）", text)
        self.assertIn("状态：in_progress", text)
        self.assertIn("step 6", text); self.assertIn("step 2", text)
        self.assertNotIn("step 1", text); self.assertNotIn("Context handed off", text)

    def test_workers_and_unread_notifications(self):
        import wake
        row = {"name": "peer", "task": "task-demo", "tasks": ["task-demo"], "report": "/r.md"}
        note = {"id": "1", "text": "worker peer 已交回，报告 /r.md", "tasks": ["task-demo"], "task": "task-demo"}
        other = {"id": "2", "text": "worker zzz 已交回", "tasks": ["task-other"], "task": "task-other"}
        with patch("workers.Store.load", return_value={"workers": {"peer": row}}), patch("workers.alive", return_value=False), \
             patch.object(wake, "report_state", return_value=("reported", "")), patch.object(wake, "unread", return_value=[note, other]):
            text = self.facts()
        self.assertIn("worker peer：已交回，报告 /r.md", text)
        self.assertIn("未读通知：1 条", text)
        self.assertIn("worker peer 已交回", text)
        self.assertNotIn("zzz", text)

    def test_test_log_tail_is_summarised_or_reported_missing(self):
        log = os.path.join(self.root, "t.log")
        with open(log, "w") as f:
            f.write("noise\n" * 500 + "Ran 12 tests in 1.0s\n\nOK\n")
        text = self.facts(test_log=log)
        self.assertIn("Ran 12 tests", text); self.assertNotIn("noise", text)
        self.assertIn("未提供", self.facts())
        self.assertIn("取不到：" + log + "x", self.facts(test_log=log + "x"))

    def test_test_log_path_comes_from_json_or_a_markdown_line(self):
        import handoff_facts as F
        self.assertEqual(F.test_log_of({"test_log": " /tmp/a.log "}), "/tmp/a.log")
        self.assertEqual(F.test_log_of("## 下一步\n测试日志: /tmp/b.log\n"), "/tmp/b.log")
        self.assertEqual(F.test_log_of("没有"), "")
        log = os.path.join(self.root, "t.log")
        open(log, "w").write("Ran 3 tests\nOK\n")
        code, _, err = self.cli({**self.GOOD, "test_log": log})
        self.assertEqual(code, 0, err)
        self.assertIn("Ran 3 tests", open(H.latest("task-demo")["path"]).read())

    # --- degradation and authorship
    def test_a_failing_collector_degrades_and_the_handoff_still_registers(self):
        import handoff_facts as F
        with patch.object(F, "commits", side_effect=OSError("git 坏了")), patch.object(F, "worktree", side_effect=ValueError("no repo")), \
             patch.object(F, "workers_and_notes", side_effect=RuntimeError("registry down")), patch.object(D, "bd_comments", side_effect=lambda t: (_ for _ in ()).throw(OSError("bd 超时")) if threading.current_thread() is not threading.main_thread() else []):
            code, _, err = self.cli(self.GOOD)
        self.assertEqual(code, 0, err)
        text = open(H.latest("task-demo")["path"]).read()
        for reason in ("git 坏了", "no repo", "registry down", "bd 超时"):
            self.assertIn("取不到：" + reason, text)
        self.assertIn("## 自动采集", text)
        self.assertIn("未提供", text)

    def test_collection_stops_waiting_after_the_budget(self):
        import handoff_facts as F
        # git answers only after the collection is back: one that waited for it would not return before the
        # 30 s safety stop (a stopwatch limit of 1.5 s failed on a busy Mac)
        late = threading.Event()
        self.addCleanup(late.set)  # then the git thread ends with this test, not in a later one
        with patch.object(F, "worktree", side_effect=lambda cwd: late.wait(30)):
            text = self.facts(budget=.3)
        self.assertFalse(late.is_set())
        self.assertIn("取不到：超过 0.3 秒没有返回", text)

    def test_the_author_cannot_write_or_replace_the_collected_section(self):
        md = "## 目标\n继续\n\n## 自动采集\nFORGED-FACT\n\n## 做完了什么\n改了 handoff.py\n\n## 下一步\n跑 npm test\n"
        self.assertEqual(self.cli(md)[0], 0)
        text = open(H.latest("task-demo")["path"]).read()
        self.assertNotIn("FORGED-FACT", text)
        self.assertEqual(text.count("## 自动采集"), 1)
        self.assertIn("跑 npm test", text)
        self.docs.clear()
        code, _, err = self.cli({**self.GOOD, "auto": "FORGED-JSON", "自动采集": "FORGED-JSON"})
        self.assertEqual(code, 0, err)
        self.assertNotIn("FORGED-JSON", open(H.latest("task-demo")["path"]).read())

    def test_instruction_states_the_requirements(self):
        for terminal in (True, False):
            text = H.write_instruction("task-demo", "codex:abc", terminal=terminal)
            for word in ("next is required", "evidence", "test_log", "Collected by Dispatch", "自动采集", "exits non-zero", "is rejected"):
                self.assertIn(word, text)
            # task-7lptn: the instruction to the agent is English throughout, apart from the section's Chinese name
            self.assertEqual(re.findall(r"[\u4e00-\u9fff]+", text), ["自动采集"])


if __name__ == "__main__": unittest.main()


class ForeignClaudeHooks(unittest.TestCase):
    """oh-my-openagent replays Claude Code's hooks in OpenCode sessions (ses_… ids): Dispatch ignores them."""

    def test_an_opencode_session_id_through_the_claude_hook_is_left_alone(self):
        import handoff as H
        with patch.object(H, "wake_merge", side_effect=AssertionError("must not read notifications")):
            self.assertEqual(H.hook({"session_id": "ses_f10d389abc", "hook_event_name": "Stop"}, "claude-code"), {})
        self.assertTrue(H.foreign({"session_id": "ses_1"}, "claude-code"))
        self.assertFalse(H.foreign({"session_id": "0b5c-uuid"}, "claude-code"))
        self.assertFalse(H.foreign({"session_id": "ses_1"}, "opencode"))


class ForeignPresence(unittest.TestCase):
    def test_presence_writes_nothing_for_an_opencode_id(self):
        import subprocess, sys
        with tempfile.TemporaryDirectory() as home:
            env = dict(os.environ, HOME=home)
            for sid, want in (("ses_f10d389abc", 0), ("7a1c9f00-aaaa-4000-8000-000000000000", 1)):
                subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "presence.py"), "claude-code", "UserPromptSubmit"],
                               input=json.dumps({"session_id": sid, "cwd": home}), text=True, env=env, capture_output=True, timeout=60)
                d = os.path.join(home, "tasks", ".dispatch", "sessions")
                names = [n for n in (os.listdir(d) if os.path.isdir(d) else []) if sid.replace("-", "") in n.replace("-", "") and n.endswith(".json")]
                self.assertEqual(len(names), want, sid)


class ForeignPrime(unittest.TestCase):
    def test_prime_hook_answers_nothing_for_an_opencode_id(self):
        import subprocess, sys
        with tempfile.TemporaryDirectory() as home:
            env = dict(os.environ, HOME=home, DISPATCH_HOME=os.path.join(home, ".dispatch"), DISPATCH_DIR=os.path.join(home, "tasks", ".dispatch"),
                       BEADS_DIR=os.path.join(home, "none", ".beads"), DISPATCH_KNOWLEDGE_AUTOCOMMIT="0")
            r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), "prime", "--hook-json"],
                               input=json.dumps({"session_id": "ses_abc", "cwd": home}), text=True, env=env, capture_output=True, timeout=120)
        self.assertEqual(r.stdout.strip(), "{}", r.stderr[-800:])


class ListItems(unittest.TestCase):
    def test_a_finished_piece_with_evidence_reads_as_words_not_a_dict(self):
        """2026-10-22: 「Completed, with evidence」 showed {'item': …, 'evidence': …} Python reprs."""
        text = H._value([{"item": "Splash runs on the compositor", "evidence": "608c2b51, 310 → 13 main frames"}, "plain line"])
        self.assertNotIn("{'item'", text)
        self.assertIn("- Splash runs on the compositor", text)
        self.assertIn("608c2b51, 310 → 13 main frames", text)
        self.assertIn("- plain line", text)
        other = H._value([{"name": "designer", "task": "task-1"}])
        self.assertIn('{"name": "designer", "task": "task-1"}', other)
