"""Worker board state, engine invocations and detached-process lifecycle, without model calls."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dispatch as D
import engines as E
import prime_brief as B
import tasks_view as T
import workers as W


class DiskBoard:
    """The bd boundary, persisted to disk so separate launcher processes exercise the real locks."""
    def __init__(self, root):
        self.DISPATCH_DIR = str(Path(root) / "state")
        self.BEADS_DIR = str(Path(root) / "board")
        self.path = Path(root) / "kv.json"
        self.comments = {}
        self.tasks = {f"task-{i:04d}": {"id": f"task-{i:04d}", "title": f"Work {i}", "status": "open"} for i in range(20)}

    def sh(self, argv, timeout=20):
        if argv[:3] == ["bd", "kv", "get"]:
            if not self.path.exists():
                return 1, json.dumps({"found": False, "value": ""}), ""
            return 0, json.dumps({"found": True, "value": self.path.read_text()}), ""
        if argv[:3] == ["bd", "kv", "set"]:
            self.path.write_text(argv[4])
            return 0, "{}", ""
        if argv[:3] == ["bd", "comments", "add"]:
            self.comments.setdefault(argv[3], []).append({"text": argv[4], "author": "test"})
            return 0, "{}", ""
        raise AssertionError(argv)

    def bd_json(self, args):
        return self.tasks.get(args[1], {})

    def bd_comments(self, task):
        return self.comments.get(task, [])

    def child_env(self):
        return dict(os.environ)

    def session_self(self):
        return "session-one"

    def _presence_by_pid(self):
        return {}


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="workers-test-")
        self.root = Path(self.temp.name)
        self.d = DiskBoard(self.root)
        self.store = W.Store(self.d)
        self.brief = self.root / "brief.md"
        self.brief.write_text("Make the requested file and write a report.")

    def tearDown(self):
        self.temp.cleanup()

    def args(self, name="one", **changes):
        data = dict(name=name, task="task-0001", engine="opencode", model="deepseek/deepseek-flash",
                    cwd=str(self.root), brief=str(self.brief), effort="", report="", log="", branch="", pid=99999999,
                    started_at="", group="worker", op="adopt", json=True)
        return SimpleNamespace(**dict(data, **changes))

    def row(self, name="one", **changes):
        return dict(name=name, task="task-0001", task_title="Work 1", engine="codex", model="m",
                    cwd=str(self.root), brief=str(self.brief), report=str(self.root / f"{name}-report.md"),
                    log=str(self.root / f"{name}.log"), pid=99999999, birth="old", host=W.host(),
                    branch="topic", start_head="base", launch_at=1, started_at=W.now(), **changes)

    def save(self, rows=(), **changes):
        state = {"version": 1, "limit": 4, "workers": {r["name"]: r for r in rows}, "queue": [], "dispatcher": None}
        state.update(changes)
        self.store.save(state)
        return state

    def queue(self, task="task-0002", after=(), **changes):
        return W.queue_add(self.store, SimpleNamespace(task=task, brief=str(self.brief), after=list(after), also_task=[], **changes))


class Registration(Base):
    def test_adopt_records_identity_paths_branch_and_does_not_spawn(self):
        with patch.object(W.P, "spawn_detached") as spawn, patch.object(W, "git_info", return_value={"branch": "gx/one", "start_head": "abc"}):
            row = W.start(self.store, self.args(), adopt=True)
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["branch"], "gx/one")
        self.assertIn("state/workers/one", row["report"])
        saved = self.store.load()["workers"]["one"]
        for key in ("engine", "model", "cwd", "report", "log", "started_at", "pid", "host"):
            self.assertIn(key, saved)
        spawn.assert_not_called()

    def test_names_and_existing_names_are_not_overwritten(self):
        for name in ("../escape", "a/b", "--foo", "", "x" * 81):
            with self.assertRaises(ValueError):
                W.start(self.store, self.args(name), adopt=True)
        W.start(self.store, self.args(), adopt=True)
        with self.assertRaisesRegex(ValueError, "already exists"):
            W.start(self.store, self.args(), adopt=True)

    def test_invalid_registry_and_board_errors_are_never_treated_as_empty(self):
        self.d.path.write_text("not json")
        with self.assertRaisesRegex(ValueError, "left untouched"):
            self.store.load()
        self.assertEqual(self.d.path.read_text(), "not json")
        with patch.object(self.d, "sh", return_value=(1, "", "database is locked")):
            with self.assertRaisesRegex(ValueError, "database is locked"):
                self.store.load()

    def test_parallel_registrations_keep_every_record(self):
        with ThreadPoolExecutor(max_workers=5) as pool:
            list(pool.map(lambda i: W.start(W.Store(self.d), self.args(f"worker-{i}"), adopt=True), range(10)))
        self.assertEqual(len(self.store.load()["workers"]), 10)

    def test_slot_limit_and_duplicate_task_prevent_spawning(self):
        state = self.save([self.row()], limit=1)
        with patch.object(W, "alive", return_value=True), patch.object(W.P, "spawn_detached") as spawn:
            with self.assertRaisesRegex(ValueError, "slots"):
                W.start(self.store, self.args("two"))
            spawn.assert_not_called()
        state["limit"] = 4
        self.store.save(state)
        with patch.object(W, "alive", return_value=True):
            with self.assertRaisesRegex(ValueError, "already has"):
                W.start(self.store, self.args("two"))

    def test_report_and_log_cannot_clobber_existing_files(self):
        for field in ("report", "log"):
            with self.assertRaisesRegex(ValueError, "must be new"):
                W.start(self.store, self.args(**{field: str(self.brief)}))
        self.assertEqual(self.brief.read_text(), "Make the requested file and write a report.")

    def test_closed_task_cannot_start_and_codex_adoption_defaults_high(self):
        self.d.tasks["task-0001"]["status"] = "closed"
        with self.assertRaisesRegex(ValueError, "already done"):
            W.start(self.store, self.args())
        self.assertEqual(W.start(self.store, self.args(engine="codex"), adopt=True)["effort"], "high")

    def test_start_failure_stays_on_board_with_reason(self):
        with patch.object(E, "which", return_value="opencode"), patch.object(W.P, "spawn_detached", side_effect=OSError("launch denied")):
            with self.assertRaisesRegex(OSError, "launch denied"):
                W.start(self.store, self.args())
        row = W.worker_status(self.store.load()["workers"]["one"])
        self.assertEqual(row["status"], "failed")
        self.assertIn("launch denied", row["reason"])


class Status(Base):
    def test_running_report_then_merged_and_empty_reports(self):
        r = self.row()
        Path(r["report"]).write_text("ready")
        with patch.object(W, "alive", return_value=True):
            self.assertEqual(W.worker_status(r)["status"], "running")
        with patch.object(W, "alive", return_value=False), patch.object(W, "merge_info", return_value={"merged": False}):
            self.assertEqual(W.worker_status(r)["status"], "reported")
        with patch.object(W, "alive", return_value=False), patch.object(W, "merge_info", return_value={"merged": True}):
            self.assertEqual(W.worker_status(r)["status"], "merged")
        Path(r["report"]).write_text("")
        self.assertEqual(W.worker_status(r)["status"], "failed")

    def test_pid_reuse_zombie_and_remote_are_not_running_local_workers(self):
        r = self.row()
        with patch.object(W, "process", return_value={"pid": r["pid"], "birth": "new"}):
            self.assertFalse(W.alive(r))
        r["host"] = "another-mac"
        self.assertEqual(W.worker_status(r)["status"], "remote")
        with patch.object(W.P, "pid_alive", return_value=True), patch.object(W.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="Tue Sep 29 06:00:00 2026 Z")):
            self.assertIsNone(W.process(99))

    def test_failure_reason_keeps_usage_limit_before_shutdown_lines(self):
        r = self.row()
        Path(r["log"]).write_text("work\nError: usage limit exceeded\ncleanup complete\n")
        self.assertIn("usage limit", W.worker_status(r)["reason"])
        Path(r["log"]).write_text("x" * 3000 + "usage limit exceeded" + "y" * 3000 + "\nerror during shutdown\n")
        self.assertIn("usage limit", W.worker_status(r)["reason"])

    def test_git_ancestry_against_origin_main_not_just_report_or_initial_head(self):
        def run(*args):
            subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True)
        run("init", "-b", "main")
        run("config", "user.name", "Test")
        run("config", "user.email", "test@example.invalid")
        run("add", "brief.md")
        run("commit", "-m", "base")
        base = W.git(str(self.root), "rev-parse", "HEAD")[1]
        run("update-ref", "refs/remotes/origin/main", base)
        run("checkout", "-b", "topic")
        r = self.row()
        r["start_head"] = base
        Path(r["report"]).write_text("report")
        self.assertFalse(W.merge_info(r)["merged"])
        (self.root / "change.txt").write_text("work")
        run("add", "change.txt")
        run("commit", "-m", "work")
        self.assertFalse(W.merge_info(r)["merged"])
        run("update-ref", "refs/remotes/origin/main", W.git(str(self.root), "rev-parse", "HEAD")[1])
        self.assertTrue(W.merge_info(r)["merged"])
        self.assertEqual(W.worker_status(r)["status"], "merged")

    def test_failed_fetch_never_claims_fresh_merge(self):
        r = self.row()
        Path(r["report"]).write_text("ready")
        with patch.object(W, "git", return_value=(1, "", "offline")):
            out = W.worker_status(r, refresh=True)
        self.assertEqual(out["status"], "reported")
        self.assertIn("offline", out["merge_note"])


class Recovery(Base):
    def test_restarts_twice_preserves_history_then_needs_user_once(self):
        row = self.row(run_id="original")
        self.save([row])
        event = W.progress_entry("one", "Finished parser", "abc123", "Run tests")
        self.d.comments[row["task"]] = [{"text": W.PROGRESS + json.dumps(event) + "\n-->"}]
        handoff = self.root / "handoff.md"
        handoff.write_text("Keep HANDOFF_CANARY and read peers.md")
        with patch.object(W.engines, "which", return_value="/bin/false"), \
             patch.object(W.P, "spawn_detached", return_value=SimpleNamespace(pid=777)), \
             patch.object(W, "process", return_value={"birth": "stamp"}), \
             patch.object(W, "alive", return_value=False), \
             patch("handoff.latest", return_value={"path": str(handoff), "created_at": 5}), \
             patch.object(W, "recovery_need_you", return_value="task-human") as need:
            for n in (1, 2):
                self.assertEqual(W.recover_failed(self.store)[0]["action"], "restarted")
                saved = self.store.load()["workers"]["one"]
                self.assertEqual(saved["restart_count"], n)
                self.assertEqual(len(saved["attempts"]), n)
                launch = json.loads((Path(saved["log"]).parent / "launch.json").read_text())
                prompt = " ".join(launch["argv"])
                self.assertIn("Finished parser", prompt)
                self.assertIn("HANDOFF_CANARY", prompt)
                self.assertIn(self.brief.read_text(), prompt)
            self.assertEqual(W.recover_failed(self.store)[0]["action"], "need-you")
            self.assertEqual(W.recover_failed(self.store), [])
            need.assert_called_once()
            self.assertEqual(self.store.load()["workers"]["one"]["attempts"][0]["run_id"], "original")

    def test_closed_reported_live_remote_and_duplicate_tasks_do_not_restart(self):
        failed = self.row()
        live = self.row("live")
        self.save([failed, live])
        with patch.object(W, "alive", side_effect=lambda r: r["name"] == "live"), patch.object(W, "launch") as launch:
            self.assertEqual(W.recover_failed(self.store), [])
            launch.assert_not_called()
        self.save([failed])
        self.d.tasks[failed["task"]]["status"] = "closed"
        with patch.object(W, "launch") as launch:
            self.assertEqual(W.recover_failed(self.store), [])
            launch.assert_not_called()

    def test_launch_failures_consume_bounded_attempts(self):
        self.save([self.row(run_id="original")])
        with patch.object(W.engines, "which", return_value=None), patch("handoff.latest", return_value=None), \
             patch.object(W, "recovery_need_you", return_value="task-human"):
            self.assertEqual(W.recover_failed(self.store)[0]["action"], "launch-failed")
            self.assertEqual(W.recover_failed(self.store)[0]["action"], "launch-failed")
            self.assertEqual(W.recover_failed(self.store)[0]["action"], "need-you")
            self.assertEqual(self.store.load()["workers"]["one"]["restart_count"], 2)

    def test_concurrent_sweeps_reserve_only_one_run(self):
        self.save([self.row()])
        def live(r):
            return r.get("pid") == 777
        with patch.object(W.engines, "which", return_value="/bin/false"), \
             patch.object(W.P, "spawn_detached", return_value=SimpleNamespace(pid=777)), \
             patch.object(W, "process", return_value={"birth": "stamp"}), \
             patch.object(W, "alive", side_effect=live), patch("handoff.latest", return_value=None):
            with ThreadPoolExecutor(max_workers=2) as pool:
                outcomes = list(pool.map(lambda _: W.recover_failed(self.store), range(2)))
        self.assertEqual(sum(len(x) for x in outcomes), 1)
        self.assertEqual(self.store.load()["workers"]["one"]["restart_count"], 1)

    def test_need_you_creation_is_linked_and_deduplicated_after_lost_receipt(self):
        row = self.row(original_run_id="original", restart_count=2)
        with patch.object(self.d, "sh", return_value=(0, "[]", "")), \
             patch.object(W.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout='{"id":"task-human"}', stderr="")) as run:
            self.assertEqual(W.recovery_need_you(self.store, row), "task-human")
            argv = run.call_args.args[0]
            self.assertIn("need-you", argv)
            self.assertEqual(argv[argv.index("--task") + 1], row["task"])
        with patch.object(self.d, "sh", return_value=(0, json.dumps([{"id": "task-other"}, {"id": "task-human", "description": "[worker-recovery:original]"}]), "")), \
             patch.object(W.subprocess, "run") as run:
            self.assertEqual(W.recovery_need_you(self.store, row), "task-human")
            run.assert_not_called()


class Queue(Base):
    def test_fifo_skips_blocked_dependencies_but_never_launches(self):
        one = self.queue(after=["upstream"])
        two = self.queue("task-0003")
        with patch.object(W.P, "spawn_detached") as spawn:
            r, text = W.command(self.store, self.args(op="next", refresh=False))
        self.assertEqual([q["id"] for q in r["queue"]], [one["id"], two["id"]])
        self.assertEqual(r["next"]["id"], two["id"])
        self.assertIn("unknown worker", r["queue"][0]["blocked"][0])
        spawn.assert_not_called()

    def test_dependencies_require_merge_not_report_and_latest_retry_counts(self):
        q = self.queue(after=["task-0001"])
        rows = [dict(self.row("first"), status="failed"), dict(self.row("retry"), status="reported", launch_at=2)]
        self.assertIn("Report ready", W.dependency_reasons(q, self.store.load(), rows, self.store.issue)[0])
        rows[-1]["status"] = "merged"
        self.assertEqual(W.dependency_reasons(q, self.store.load(), rows, self.store.issue), [])

    def test_task_dependency_requires_closed_task_when_no_worker(self):
        q = self.queue(after=["task-0001"])
        self.assertTrue(W.dependency_reasons(q, self.store.load(), [], self.store.issue))
        self.d.tasks["task-0001"]["status"] = "closed"
        self.assertEqual(W.dependency_reasons(q, self.store.load(), [], self.store.issue), [])

    def test_duplicate_self_dependency_and_cycles_rejected(self):
        self.queue(after=["task-0003"])
        with self.assertRaisesRegex(ValueError, "already queued"):
            self.queue()
        with self.assertRaisesRegex(ValueError, "itself"):
            self.queue("task-0003", ["task-0003"])
        with self.assertRaisesRegex(ValueError, "cycle"):
            self.queue("task-0003", ["task-0002"])

    def test_capacity_done_tasks_missing_briefs_and_remove(self):
        q = self.queue()
        self.d.tasks["task-0002"]["status"] = "closed"
        r, _ = W.command(self.store, self.args(op="next"))
        self.assertIsNone(r["next"])
        self.assertIn("already done", r["queue"][0]["blocked"][0])
        self.d.tasks["task-0002"]["status"] = "open"
        self.brief.unlink()
        r, _ = W.command(self.store, self.args(op="next"))
        self.assertIsNone(r["next"])
        W.command(self.store, self.args(op="queue", queue_op="remove", task=q["id"]))
        self.assertEqual(self.store.load()["queue"][0]["status"], "cancelled")

    def test_start_checks_dependencies_before_spawning(self):
        self.queue(task="task-0001", after=["upstream"])
        with patch.object(W.P, "spawn_detached") as spawn:
            with self.assertRaisesRegex(ValueError, "dependencies"):
                W.start(self.store, self.args())
        spawn.assert_not_called()

    def test_adopt_consumes_queued_entry(self):
        self.queue(task="task-0001")
        W.start(self.store, self.args(), adopt=True)
        q = self.store.load()["queue"][0]
        self.assertEqual((q["status"], q["worker"]), ("started", "one"))

    def test_grouped_tasks_keep_the_same_worker_for_dependencies_and_duplicate_checks(self):
        W.queue_add(self.store, SimpleNamespace(task="task-0001", brief=str(self.brief), after=[], also_task=["task-0002"]))
        row = W.start(self.store, self.args(), adopt=True)
        self.assertEqual(row["tasks"], ["task-0001", "task-0002"])
        # A secondary task can be closed when its worker has only handed back a report.
        self.d.tasks["task-0002"]["status"] = "closed"
        row["status"] = "reported"
        reasons = W.dependency_reasons({"after": ["task-0002"]}, self.store.load(), [row], self.store.issue)
        self.assertIn("Report ready", reasons[0])
        self.d.tasks["task-0002"]["status"] = "open"
        with patch.object(W, "alive", return_value=True), patch.object(W.P, "spawn_detached") as spawn:
            with self.assertRaisesRegex(ValueError, "already has"):
                W.start(self.store, self.args("two", task="task-0002"))
        spawn.assert_not_called()

    def test_worker_show_collects_progress_from_every_grouped_task(self):
        row = self.row()
        row["tasks"] = ["task-0001", "task-0002"]
        self.save([row])
        self.d.comments["task-0002"] = [{"text": W.progress_comment(W.progress_entry("one", "Second task verified"))}]
        result, text = W.command(self.store, self.args(op="show"))
        self.assertEqual(result["progress"][0]["step"], "Second task verified")
        self.assertIn("Second task verified", text)


class Progress(Base):
    def test_unicode_quotes_and_html_roundtrip_and_grouping(self):
        first = W.progress_entry("one", "测试完成\n下一段", 'abc "quote" -->', "合并", "running")
        done = W.progress_entry("one", "交回报告", state="done")
        second = W.progress_entry("two", "额度用完", state="blocked")
        comments = [{"text": W.progress_comment(e)} for e in (first, second, done)]
        comments += [{"text": "legacy free text"}, {"text": W.PROGRESS + "not json\n-->"}]
        groups = W.progress_groups(comments)
        self.assertEqual(list(groups), ["one", "two"])
        self.assertEqual(groups["one"][0]["evidence"], first["evidence"])
        self.assertEqual(groups["two"][0]["state"], "blocked")
        self.assertIn("Worker one:", W.progress_text(groups))

    def test_log_legacy_and_structured_both_write_comments(self):
        with patch.object(D, "bd_json", self.d.bd_json), patch.object(D, "sh", self.d.sh), patch.object(D, "link_session"), redirect_stdout(io.StringIO()):
            D.cmd_log(SimpleNamespace(task="task-0001", text="legacy"))
            D.cmd_log(SimpleNamespace(task="task-0001", text="", worker="one", step="Tests pass", evidence="42 passed", next="Report", state="done"))
        comments = self.d.bd_comments("task-0001")
        self.assertEqual(comments[0]["text"], "legacy")
        self.assertEqual(W.progress_groups(comments)["one"][0]["evidence"], "42 passed")
        with self.assertRaisesRegex(ValueError, "step"):
            W.progress_entry("one", "")
        last = T.last_activity({"comments": [{"text": comments[1]["text"], "created_at": W.now()}]})
        self.assertNotIn("dispatch-worker-progress", last["text"])
        self.assertIn("Tests pass", last["text"])

    def test_task_show_exposes_grouped_progress_and_worker_show_report(self):
        entry = W.progress_entry("one", "Verified", evidence="commit abc")
        self.d.comments["task-0001"] = [{"text": W.progress_comment(entry)}]
        self.save([self.row()])
        out = io.StringIO()
        a = SimpleNamespace(op="show", task="task-0001", json=True, brief=False)
        with patch.object(T, "D", self.d), patch.object(T, "show_issue", return_value=self.d.tasks[a.task]), \
             patch.object(T, "resolved_thing", return_value="workers"), redirect_stdout(out):
            self.assertEqual(T.command(a), 0)
        self.assertEqual(json.loads(out.getvalue())["progress"]["one"][0]["step"], "Verified")
        r, text = W.command(self.store, self.args(op="show"))
        self.assertIn("commit abc", text)
        self.assertEqual(len(r["progress"]), 1)


class Dispatcher(Base):
    def owner(self, session="session-one"):
        p = W.process(os.getpid())
        return dict(session=session, pid=os.getpid(), birth=p["birth"], host=W.host(), presence="",
                    cwd=str(self.root), started_at=W.now(), claimed_at=time.time() - 120)

    def test_claim_is_mutually_exclusive_idempotent_and_owner_released(self):
        a = self.args(group="dispatcher", op="claim", session="one", pid=os.getpid())
        first = W.dispatcher_claim(self.store, a)
        second = W.dispatcher_claim(self.store, a)
        self.assertEqual(first["claimed_at"], second["claimed_at"])
        with self.assertRaisesRegex(ValueError, "already active"):
            W.dispatcher_claim(self.store, self.args(session="two", pid=os.getpid()))
        with self.assertRaisesRegex(ValueError, "Only the registered"):
            W.release_session("two", self.d, if_owner=False)
        self.assertFalse(W.release_session("two", self.d)["released"])
        self.assertTrue(W.release_session("one", self.d)["released"])
        self.assertFalse(W.release_session("one", self.d)["released"])
        self.assertEqual(W.dispatcher_claim(self.store, self.args(session="two", pid=os.getpid()))["session"], "two")

    def test_parallel_claim_has_only_one_winner(self):
        def claim(i):
            try:
                return W.dispatcher_claim(self.store, self.args(session=f"session-{i}", pid=os.getpid()))
            except ValueError:
                return None
        with ThreadPoolExecutor(max_workers=5) as pool:
            results = list(pool.map(claim, range(5)))
        self.assertEqual(sum(r is not None for r in results), 1)

    def test_dead_pid_and_session_end_presence_allow_new_claim(self):
        owner = self.owner()
        owner["birth"] = "a different process"
        self.save(dispatcher=owner)
        self.assertFalse(W.dispatcher_status(owner)["active"])
        W.dispatcher_claim(self.store, self.args(session="new", pid=os.getpid()))
        owner = self.owner()
        owner["presence"] = str(self.root / "removed-presence.json")
        self.assertFalse(W.dispatcher_status(owner)["active"])

    def test_remote_claim_is_not_replaced_based_on_local_pid(self):
        owner = self.owner()
        owner["host"] = "another-mac"
        self.save(dispatcher=owner)
        with self.assertRaisesRegex(ValueError, "already active"):
            W.dispatcher_claim(self.store, self.args(session="new", pid=os.getpid()))

    def test_cannot_claim_short_lived_cli_parent_by_default(self):
        with self.assertRaisesRegex(ValueError, "--pid"):
            W.dispatcher_owner(self.d)

    def test_session_end_releases_owner_without_creating_a_missing_board(self):
        self.assertFalse(W.release_session("absent", self.d)["released"])
        self.assertFalse(Path(self.d.BEADS_DIR).exists())
        import presence
        record_dir = self.root / "sessions"
        record_dir.mkdir()
        record = record_dir / "codex__session-one.json"
        record.write_text("{}")
        with patch.object(presence, "DIR", str(record_dir)), patch.object(presence, "ps_table", return_value={}), \
             patch.object(sys, "argv", ["presence.py", "codex", "SessionEnd"]), \
             patch.object(sys, "stdin", io.StringIO('{"session_id":"session-one"}')), \
             patch.object(W, "release_session") as release:
            presence.main()
        release.assert_called_once_with("session-one")
        self.assertFalse(record.exists())


class Prime(Base):
    def test_worker_summary_has_its_own_byte_budget_and_no_fetch(self):
        row = self.row()
        owner = dict(session="session-x" * 100, host=W.host(), pid=os.getpid(), birth=W.process(os.getpid())["birth"],
                     claimed_at=time.time() - 3600)
        state = self.save([row], dispatcher=owner, queue=[dict(status="queued", title="长标题" * 1000)])
        import wake
        wake.save_dispatcher(self.d, owner)
        with patch.object(W, "git") as git:
            lines = W.prime_section(self.d, owner["session"])
        self.assertLessEqual(B.nbytes(lines), 650)
        self.assertIn("当前调度会话", "\n".join(lines))
        self.assertIn("dispatch worker list", "\n".join(lines))
        git.assert_not_called()

    def test_ordinary_sessions_get_no_worker_section(self):
        owner = dict(session="disp-9", host=W.host(), pid=os.getpid(), birth=W.process(os.getpid())["birth"], claimed_at=time.time())
        self.save([self.row()], dispatcher=owner, queue=[dict(status="queued", title="排队")])
        import wake
        with patch.object(W.Store, "load") as load:
            self.assertEqual(W.prime_section(self.d, "some-session"), [])
            self.assertEqual(W.prime_section(self.d, ""), [])
            load.assert_not_called()  # no board read for an ordinary session
        wake.save_dispatcher(self.d, owner)
        self.assertEqual(W.prime_section(self.d, "some-session"), [])
        self.assertIn("## 调度与 workers", W.prime_section(self.d, "disp-9"))

    def test_summary_fits_with_all_full_prime_sections(self):
        owner = dict(session="disp-9", host=W.host(), pid=os.getpid(), birth=W.process(os.getpid())["birth"], claimed_at=time.time())
        self.save([self.row()], dispatcher=owner, queue=[dict(status="queued", title="排队的工作" * 100)])
        import wake
        wake.save_dispatcher(self.d, owner)
        lines = W.prime_section(self.d, "disp-9")
        sections = [("board", ["x" * B.BOARD_BYTES]), ("workers", lines),
                    ("peers", ["x" * B.PEERS_BYTES]), ("due", ["x" * B.DUE_BYTES]),
                    ("prefs", ["x" * B.PREFS_BYTES]), ("pits", ["x" * B.PITS_BYTES])]
        text, _ = B.build("Dispatch", sections)
        self.assertLessEqual(len(text.encode("utf-8")), B.BUDGET_BYTES)
        self.assertIn("dispatch worker list", text)


class EngineArguments(unittest.TestCase):
    def test_codex_and_claude_keep_shared_flags_and_effort(self):
        codex = E.get("codex").headless_argv("gpt-6-astra", "prompt", "/tmp", images=["a.png"], effort="max", lastfile="final.txt")
        self.assertLess(codex.index("prompt"), codex.index("-i"))
        self.assertIn('model_reasoning_effort="max"', codex)
        self.assertIn("--dangerously-bypass-approvals-and-sandbox", codex)
        claude = E.get("claude").headless_argv("sonnet", "prompt", "/tmp", effort="high", resume=True, session="s")
        self.assertIn("--resume", claude)
        self.assertEqual(claude[claude.index("--effort") + 1], "high")

    def test_opencode_uses_provider_model_and_variant_without_shell(self):
        argv = E.get("opencode").headless_argv("deepseek/deepseek-flash", "$(touch nope)", "/tmp", effort="max")
        self.assertEqual(argv[:4], ["opencode", "run", "--format", "json"])
        self.assertEqual(argv[-2:], ["--", "$(touch nope)"])
        self.assertIn("--auto", argv)
        self.assertIn("--variant", argv)


@unittest.skipIf(W.P.IS_WIN, "Detached worker processes are currently POSIX only")
class DetachedLifecycle(Base):
    def test_resident_reaper_restarts_real_exited_processes_without_dispatcher(self):
        import chatd
        fake = self.root / "opencode"
        fake.write_text("#!/bin/sh\nexit 7\n")
        fake.chmod(0o755)
        c = chatd.Chatd(lambda line: None, d=self.d)
        c.background = lambda fn: fn()
        def wait_exit():
            row = self.store.load()["workers"]["smoke"]
            deadline = time.monotonic() + 5
            while W.alive(row) and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertFalse(W.alive(row))
        with patch.object(W.engines, "which", return_value=str(fake)), \
             patch.object(W, "recovery_need_you", return_value="task-human") as need:
            W.start(self.store, self.args(name="smoke"), adopt=False)
            wait_exit()
            for expected in (1, 2):
                c.reap()
                self.assertEqual(self.store.load()["workers"]["smoke"]["restart_count"], expected)
                wait_exit()
            c.reap()
            c.reap()
            need.assert_called_once()
            self.assertEqual(self.store.load()["workers"]["smoke"]["recovery_need_you"], "task-human")
            self.assertEqual(c.sessions, {})

    def test_worker_survives_launcher_exit_and_transitions_to_report_ready(self):
        fake = self.root / "opencode"
        fake.write_text("#!" + sys.executable + "\n" + '''import json, os, time
from pathlib import Path
report = Path(os.environ["DISPATCH_WORKER_REPORT"])
report.with_suffix(".started").write_text(json.dumps({"pid": os.getpid(), "sid": os.getsid(0), "parent": os.getppid(), "inherited": os.environ.get("CODEX_THREAD_ID")}))
deadline = time.monotonic() + 15
while not report.with_suffix(".finish").exists():
    if time.monotonic() > deadline:
        raise SystemExit("test timed out")
    time.sleep(.02)
report.write_text("# Ready\\n\\nWrote the fixture file and verified it.\\n")
print("report submitted", flush=True)
''')
        fake.chmod(0o755)
        parent = '''import json, sys
from unittest.mock import patch
from types import SimpleNamespace
import workers as W
from test_workers import DiskBoard
d = DiskBoard(sys.argv[1])
a = SimpleNamespace(name="smoke", task="task-0001", engine="opencode", model="deepseek/deepseek-flash", cwd=sys.argv[1], brief=sys.argv[1]+"/brief.md", effort="", report="", log="", branch="")
with patch.object(W.engines, "which", return_value=sys.argv[1]+"/opencode"):
    print(json.dumps(W.start(W.Store(d), a)))
'''
        env = dict(os.environ, PYTHONPATH=os.path.dirname(__file__), CODEX_THREAD_ID="dispatcher-id")
        r = subprocess.run([sys.executable, "-c", parent, str(self.root)], capture_output=True, text=True, env=env, timeout=10)
        self.assertEqual(r.returncode, 0, r.stderr)
        row = json.loads(r.stdout)
        try:
            self.assertEqual(W.worker_status(row)["status"], "running")
            marker = Path(row["report"]).with_suffix(".started")
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            observed = json.loads(marker.read_text())
            self.assertEqual(observed["pid"], row["pid"])
            self.assertEqual(observed["sid"], row["pid"])
            self.assertIsNone(observed["inherited"])
            Path(row["report"]).with_suffix(".finish").write_text("finish")
            deadline = time.monotonic() + 5
            while W.alive(row) and time.monotonic() < deadline:
                time.sleep(.02)
            final = W.worker_status(row)
            self.assertEqual(final["status"], "reported")
            self.assertIn("report submitted", Path(row["log"]).read_text())
            self.assertEqual(self.store.load()["workers"]["smoke"]["pid"], row["pid"])
        finally:
            if W.alive(row):
                print(f"Stopping test fixture PID {row['pid']}")
                os.kill(row["pid"], signal.SIGTERM)


if __name__ == "__main__":
    unittest.main()


class MachineIdentity(unittest.TestCase):
    """A worker row stays this Mac's after macOS changes the host name (network, rename)."""

    def test_id_is_made_once_and_rows_match_by_it(self):
        import workers as Wk
        with tempfile.TemporaryDirectory() as home, unittest.mock.patch.dict(os.environ, {"HOME": home}):
            Wk._MACHINE_ID.clear()
            first = Wk.machine_id()
            Wk._MACHINE_ID.clear()
            self.assertEqual(Wk.machine_id(), first)
            with unittest.mock.patch.object(Wk, "host", return_value="other.local"):
                self.assertTrue(Wk.is_local({"host": "MacBookPro", "host_id": first}))
                self.assertFalse(Wk.is_local({"host": "other.local", "host_id": "someone-else"}))
            Wk._MACHINE_ID.clear()

    def test_old_rows_are_local_when_their_files_are_here(self):
        import workers as Wk
        with tempfile.TemporaryDirectory() as d, unittest.mock.patch.object(Wk, "host", return_value="new.local"):
            log = os.path.join(d, "engine.log")
            open(log, "w").close()
            self.assertTrue(Wk.is_local({"host": "MacBookPro", "log": log}))
            self.assertFalse(Wk.is_local({"host": "MacBookPro", "log": os.path.join(d, "gone.log")}))
            self.assertTrue(Wk.is_local({"host": "new.local"}))
