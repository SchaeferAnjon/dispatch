import io, json, os, sys, tempfile, unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dispatch as D
import now_line as N
import tasks_view as T


def issue(tid, title, created, status="in_progress", session="sess-abc123", meta=None, closed=None):
    t = {"id": tid, "title": title, "status": status, "created_at": created, "updated_at": created,
         "labels": ["project:demo", f"session-origin:{session}"], "assignee": "claude-code"}
    if meta:
        t["metadata"] = meta
    if closed:
        t["closed_at"] = closed
    return t


def args(*text, **kw):
    base = dict(text=list(text), session="", clear=False, json=True)
    base.update(kw)
    return SimpleNamespace(**base)


class NowLine(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        p = patch.object(D, "DISPATCH_DIR", self.tmp.name)
        p.start()
        self.addCleanup(p.stop)
        N.D = D
        live = patch.object(N, "live_of", lambda session, now=None: None)
        live.start()
        self.addCleanup(live.stop)
        env = patch.dict(os.environ, {k: "" for k in N.SESSION_ENV})
        env.start()
        self.addCleanup(env.stop)
        # a task row reads its handoffs with handoff.task_records (one read of the index for the whole list)
        h = patch("handoff.task_records", lambda target, base=None: [{"created_at": 1700000100.5, "session": "claude-code:sess-old"}] if target == "task-a1" else [])
        h.start()
        self.addCleanup(h.stop)

    def run_cmd(self, a):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = N.run(a, D)
        return code, buf.getvalue()

    def test_clean_one_plain_line(self):
        self.assertEqual(N.clean("  - Building `app`\n on mini  "), "Building app on mini")
        long = "word " * 60
        out = N.clean(long)
        self.assertLessEqual(len(out), N.MAX)
        self.assertTrue(out.endswith("…"))

    def test_write_from_agent_environment_then_read(self):
        os.environ["CLAUDE_CODE_SESSION_ID"] = "sess-abc123"
        code, out = self.run_cmd(args("Finding", "every agent CLI on this Mac"))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["text"], "Finding every agent CLI on this Mac")
        board = [issue("task-a1", "Detect all agents", "2026-10-01T10:00:00Z",
                       meta={"plan": [{"text": "Detect", "state": "active"}, {"text": "Persist", "state": "done"}],
                             "deliverables": [{"kind": "url", "ref": "https://example.com/p", "label": "Delivery page"}]}),
                 issue("task-a0", "Older done one", "2026-09-30T10:00:00Z", status="closed", closed="2026-09-30T12:00:00Z")]
        with patch.object(T, "session_issues", lambda keys: board):
            code, out = self.run_cmd(args())
        r = json.loads(out)
        self.assertEqual(r["now"]["text"], "Finding every agent CLI on this Mac")
        self.assertEqual(r["task"]["id"], "task-a1")
        self.assertEqual([p["state"] for p in r["task"]["plan"]], ["active", "done"])
        self.assertEqual(len(r["task"]["deliverables"]), 1)
        self.assertEqual(len(r["handoffs"]), 1)
        self.assertEqual(r["tasks"], 2)

    def test_a_handoff_says_when_it_was_written(self):
        # the record handoff.py writes keeps its time in created_at: the Now tab's Handed over row says how long ago
        os.environ["CLAUDE_CODE_SESSION_ID"] = "sess-abc123"
        board = [issue("task-a1", "Detect all agents", "2026-10-01T10:00:00Z")]
        with patch.object(T, "session_issues", lambda keys: board):
            code, out = self.run_cmd(args())
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["handoffs"], [{"at": 1700000100, "session": "claude-code:sess-old", "native_session": ""}])

    def test_every_task_of_the_session_in_progress_first(self):
        # task-qa6rr: four requests in one session, Now showed the newest alone
        board = [issue("task-a1", "First request", "2026-10-01T10:00:00Z", status="in_progress",
                       meta={"plan": [{"text": "Look", "state": "done"}, {"text": "Fix", "state": "active"}]}),
                 issue("task-a2", "Second request", "2026-10-01T11:00:00Z", status="in_progress"),
                 issue("task-a0", "Done earlier", "2026-09-30T10:00:00Z", status="closed", closed="2026-09-30T12:00:00Z"),
                 issue("task-a3", "Third, newest", "2026-10-01T12:00:00Z", status="in_progress")]
        r = N.read("sess-abc123", issues=board)
        self.assertEqual(r["task"]["id"], "task-a3")
        self.assertEqual([t["id"] for t in r["session_tasks"]], ["task-a3", "task-a2", "task-a1", "task-a0"])
        first = next(t for t in r["session_tasks"] if t["id"] == "task-a1")
        self.assertEqual((first["status"], [p["state"] for p in first["plan"]]), ("in_progress", ["done", "active"]))
        self.assertEqual(r["session_tasks"][-1]["status"], "done")

    def test_a_thing_waiting_in_line_is_not_what_it_is_on(self):
        lined = issue("task-n1", "Add the CONTRIBUTING file", "2026-10-02T10:00:00Z", status="open")
        lined["labels"] += ["from-chat", "nextup"]
        later = issue("task-n2", "Add a SECURITY file", "2026-10-02T11:00:00Z", status="open")
        later["labels"] += ["from-chat", "later"]
        board = [issue("task-a0", "Older done one", "2026-09-30T10:00:00Z", status="closed", closed="2026-09-30T12:00:00Z"), lined, later]
        r = N.read("sess-abc123", issues=board)
        self.assertEqual(r["task"]["id"], "task-a0")
        self.assertIsNone(N.read("sess-abc123", issues=[lined, later])["task"])
        self.assertEqual([t["id"] for t in r["session_tasks"]], ["task-a0"])

    def test_window_resource_and_clear(self):
        code, _ = self.run_cmd(args("Running the tests", session="agent-host-claude:/sess-abc123"))
        self.assertEqual(code, 0)
        self.assertTrue(os.path.isfile(os.path.join(self.tmp.name, "now", "sess-abc123.json")))
        self.assertEqual(N.line_of("claude:/sess-abc123")["text"], "Running the tests")
        code, out = self.run_cmd(args(session="sess-abc123", clear=True))
        self.assertTrue(json.loads(out)["cleared"])
        self.assertIsNone(N.line_of("sess-abc123"))

    def test_no_session_and_bad_ids_refused(self):
        code, out = self.run_cmd(args("hello"))
        self.assertEqual(code, 1)
        self.assertIn("No session here", json.loads(out)["error"])
        with self.assertRaises(ValueError):
            N.write("../../etc", "x")
        with self.assertRaises(ValueError):
            N.write("sess-abc123", "   ")

    def test_no_task_yet(self):
        with patch.object(T, "session_issues", lambda keys: []):
            code, out = self.run_cmd(args(session="sess-zzz999"))
        r = json.loads(out)
        self.assertIsNone(r["now"])
        self.assertIsNone(r["task"])
        self.assertEqual(r["handoffs"], [])




class Live(unittest.TestCase):
    """What the running session shows this moment comes from the same live rows as the Assistant's overview."""

    def setUp(self):
        N.D = D

    def rows(self, *rows):
        import assistant_live as L
        return patch.object(L, "own_rows", lambda now=None: list(rows))

    def test_matches_the_window_resource(self):
        row = {"key": "claude-code:sess-abc123", "id": "sess-abc123", "status": "working", "doing": "Running the tests", "said": "", "last_at": 1700000200}
        with self.rows({"key": "x", "id": "other", "status": "idle"}, row):
            got = N.live_of("agent-host-claude:/sess-abc123")
        self.assertEqual(got, {"status": "working", "doing": "Running the tests", "said": "", "at": 1700000200})

    def test_only_asked_for(self):
        calls = []
        with patch.object(N, "live_of", lambda session, now=None: calls.append(session) or {"status": "working"}), \
                patch.object(N, "_tv", lambda: type("T", (), {"session_issues": staticmethod(lambda keys: []), "list_tasks": staticmethod(lambda *a, **k: []), "session_keys": staticmethod(lambda s: [s])})):
            self.assertIsNone(N.read("sess-abc123", issues=[])["live"])
            self.assertEqual(N.read("sess-abc123", issues=[], live=True)["live"], {"status": "working"})
        self.assertEqual(calls, ["sess-abc123"])

    def test_not_running_or_unreadable(self):
        with self.rows({"key": "x", "id": "other", "status": "idle"}):
            self.assertIsNone(N.live_of("sess-abc123"))
        import assistant_live as L
        def boom(now=None):
            raise RuntimeError("no sessions")
        with patch.object(L, "own_rows", boom):
            self.assertIsNone(N.live_of("sess-abc123"))


if __name__ == "__main__":
    unittest.main()
