import io, json, os, subprocess, sys, tempfile, time, unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tasks_view as T


def issue(tid, title, created, status="open", session="s1", project="game", labels=(), meta=None, deps=(), closed=None):
    t = {"id": tid, "title": title, "status": status, "created_at": created, "updated_at": created,
         "labels": [f"project:{project}", f"session-origin:{session}", *labels], "assignee": "claude-code"}
    if meta:
        t["metadata"] = meta
    if deps:
        t["dependencies"] = [{"issue_id": tid, "depends_on_id": d, "type": k} for d, k in deps]
    if closed:
        t["closed_at"] = closed
    return t


def args(op, task="", **kw):
    base = dict(op=op, task=task, prev="", project="", folder="", session="", status="all", limit=200, days=0, archived=False, brief=False,
                set=None, from_json=None, done="", active="", follows="", url=None, file=None, draft=None,
                commit=None, label="", rules="", dry_run=False, json=True)
    base.update(kw)
    return SimpleNamespace(**base)


class FakeBoard:
    """`bd export` / `show` / `update --metadata` against a dict, recording the updates."""
    def __init__(self, issues):
        self.issues = {t["id"]: t for t in issues}
        self.updates = []
        self.calls = []

    def __call__(self, argv, timeout=60):
        self.calls.append(argv[:2])
        if argv[:2] == ["bd", "list"] and "--label-any" in argv:
            # bd's list: the label query, without comments and dependencies
            want = set(argv[argv.index("--label-any") + 1].split(","))
            return 0, json.dumps([{k: v for k, v in t.items() if k not in ("comments", "dependencies")}
                                  for t in self.issues.values() if want & set(t.get("labels") or [])]), ""
        if argv[:2] == ["bd", "export"]:
            return 0, "\n".join(json.dumps(dict(t, _type="issue")) for t in self.issues.values()), ""
        if argv[:2] == ["bd", "show"]:
            t = self.issues.get(argv[2])
            return (0, json.dumps([t]), "") if t else (1, "", f"no issue found matching {argv[2]}")
        if argv[:2] == ["bd", "update"]:
            tid = argv[2]
            i = argv.index("--metadata")
            self.updates.append((tid, json.loads(argv[i + 1])))
            self.issues[tid]["metadata"] = json.loads(argv[i + 1])
            return 0, "[]", ""
        raise AssertionError(argv)


_STATE = tempfile.mkdtemp()  # task list / graph write the territory index (owns.json) here, not in ~/tasks


def run(board, a):
    buf = io.StringIO()
    with patch.object(T, "_sh", board), patch.object(T, "D", None), patch.dict(os.environ, {"DISPATCH_DIR": _STATE}), redirect_stdout(buf):
        code = T.command(a)
    return code, (json.loads(buf.getvalue()) if a.json else buf.getvalue())


class Status(unittest.TestCase):
    def test_words(self):
        self.assertEqual(T.status_of({"status": "closed"}), "done")
        self.assertEqual(T.status_of({"status": "in_progress"}), "in_progress")
        self.assertEqual(T.status_of({"status": "open"}), "todo")
        self.assertEqual(T.status_of({"status": "blocked"}), "waiting")
        self.assertEqual(T.status_of({"status": "open", "labels": ["dispatch:needs-you"]}), "waiting")
        self.assertEqual(T.status_of({"status": "in_progress", "labels": ["dispatch:waiting"]}), "waiting")

    def test_row_shape_is_fixed(self):
        r = T.task_row(issue("task-a1", "Minecraft", "2026-09-27T10:00:00Z", status="closed", closed="2026-09-27T11:00:00Z",
                             meta={"plan": [{"text": "World", "state": "done"}], "deliverables": [{"kind": "url", "ref": "http://x"}]}))
        self.assertEqual(sorted(r), sorted(["id", "title", "status", "bd_status", "project", "session", "sessions", "agent", "plan", "handoffs",
                                            "deliverables", "follows", "thing", "from", "only_you", "owns", "created_at", "updated_at", "done_at", "last"]))
        self.assertEqual(r["status"], "done")
        self.assertEqual(r["done_at"] - r["created_at"], 3600)
        self.assertEqual(r["deliverables"], [{"kind": "url", "ref": "http://x", "label": ""}])

    def test_old_follow_up_counts_as_follows(self):
        r = T.task_row(issue("task-b2", "Villagers", "2026-09-27T10:00:00Z", deps=[("task-a1", "discovered-from")]))
        self.assertEqual(r["follows"], "task-a1")
        r = T.task_row(issue("task-b2", "Villagers", "2026-09-27T10:00:00Z", deps=[("task-a1", "blocks")]))
        self.assertEqual(r["follows"], "")

    def test_session_key(self):
        self.assertEqual(T.session_key("agent-host-claude:/abc-123"), "abc-123")
        self.assertEqual(T.session_key("claude:/x/y/abcdef12?x=1"), "abcdef12")
        self.assertEqual(T.session_key("abcdef12"), "abcdef12")


class Plan(unittest.TestCase):
    def test_claude_todos_and_codex_plan_become_one_shape(self):
        claude = [{"content": "Build the world", "status": "completed", "activeForm": "Building"},
                  {"content": "Add villagers", "status": "in_progress"}, {"content": "Ship", "status": "pending"}]
        codex = {"explanation": "", "plan": [{"step": "Build the world", "status": "completed"},
                                             {"step": "Add villagers", "status": "in_progress"}, {"step": "Ship", "status": "pending"}]}
        want = [{"text": "Build the world", "state": "done"}, {"text": "Add villagers", "state": "active"}, {"text": "Ship", "state": "todo"}]
        self.assertEqual(T.plan_from_json(claude), want)
        self.assertEqual(T.plan_from_json(codex), want)

    def test_short_and_few(self):
        p = T.clean_plan(["x" * 200] + [f"s{i}" for i in range(20)])
        self.assertEqual(len(p), T.PLAN_MAX)
        self.assertEqual(len(p[0]["text"]), T.PLAN_TEXT_MAX)

    def test_plan_set_done_active_keeps_other_metadata(self):
        board = FakeBoard([issue("task-a1", "Minecraft", "2026-09-27T10:00:00Z", meta={"deliverables": [{"kind": "url", "ref": "http://x"}]}),
                           issue("task-z9", "Earlier", "2026-09-27T09:00:00Z")])
        _, r = run(board, args("plan", "task-a1", set=["World", "Blocks", "Save"], done="1", active="2", follows="task-z9"))
        self.assertEqual([p["state"] for p in r["plan"]], ["done", "active", "todo"])
        self.assertEqual(r["follows"], "task-z9")
        self.assertEqual(board.updates[-1][1]["deliverables"], [{"kind": "url", "ref": "http://x"}])
        _, r = run(board, args("plan", "task-a1", active="3"))
        self.assertEqual([p["state"] for p in r["plan"]], ["done", "todo", "active"])

    def test_finished_plan_ticks_the_open_steps_and_keeps_the_rest(self):
        t = {"metadata": json.dumps({"deliverables": [{"kind": "url", "ref": "http://x"}],
                                     "plan": [{"text": "A", "state": "done"}, {"text": "B", "state": "active"}, {"text": "C", "state": "todo"}]})}
        m, n = T.finished_plan(t)
        self.assertEqual(n, 2)
        self.assertEqual([p["state"] for p in m["plan"]], ["done", "done", "done"])
        self.assertEqual(m["deliverables"], [{"kind": "url", "ref": "http://x"}])
        self.assertEqual(T.finished_plan({"metadata": {"plan": [{"text": "A", "state": "done"}]}}), (None, 0))
        self.assertEqual(T.finished_plan({"metadata": {}}), (None, 0))
        self.assertEqual(T.finished_plan({}), (None, 0))

    def test_todowrite_hook_plans_the_sessions_current_task(self):
        board = FakeBoard([issue("task-a1", "Minecraft", "2026-09-27T10:00:00Z", session="abc12345-1111"),
                           issue("task-b2", "Older", "2026-09-27T09:00:00Z", session="abc12345-1111"),
                           issue("task-c3", "Elsewhere", "2026-09-27T11:00:00Z", session="other")])
        hook = {"session_id": "abc12345-1111", "tool_name": "TodoWrite", "tool_input": {"todos": [
            {"content": "Build the world", "status": "completed"}, {"content": "Add villagers", "status": "in_progress"}]}}
        with patch.object(T, "_sh", board), patch.object(T, "D", None), patch.object(T.sys, "stdin", io.StringIO(json.dumps(hook))):
            self.assertEqual(T.command(args("plan", hook=True)), 0)
        self.assertEqual(board.updates[-1][0], "task-a1")  # the session's most recent open task
        self.assertEqual(board.updates[-1][1]["plan"], [{"text": "Build the world", "state": "done"}, {"text": "Add villagers", "state": "active"}])
        n = len(board.updates)
        for payload in ("", json.dumps({"session_id": "nobody", "tool_name": "TodoWrite", "tool_input": {"todos": [{"content": "x", "status": "pending"}]}}),
                        json.dumps({"session_id": "abc12345-1111", "tool_name": "Edit", "tool_input": {}})):
            with patch.object(T, "_sh", board), patch.object(T, "D", None), patch.object(T.sys, "stdin", io.StringIO(payload)):
                self.assertEqual(T.command(args("plan", hook=True)), 0)
        self.assertEqual(len(board.updates), n)  # nothing to do is never an error

    def test_codex_update_plan_hook_plans_the_threads_current_task(self):
        board = FakeBoard([issue("task-a1", "Minecraft", "2026-09-27T10:00:00Z", session="019a-thread-7777"),
                           issue("task-c3", "Elsewhere", "2026-09-27T11:00:00Z", session="other")])
        plan = [{"step": "Build the world", "status": "completed"}, {"step": "Add villagers", "status": "in_progress"},
                {"step": "Ship", "status": "pending"}]
        want = [{"text": "Build the world", "state": "done"}, {"text": "Add villagers", "state": "active"}, {"text": "Ship", "state": "todo"}]
        payloads = [
            {"hook_event_name": "PostToolUse", "thread_id": "019a-thread-7777", "tool_name": "update_plan",
             "tool_input": {"explanation": "", "plan": plan}},
            # session_id instead of thread_id, the arguments as a JSON string
            {"session_id": "019a-thread-7777", "tool_name": "update_plan", "tool_input": json.dumps({"plan": plan[:1]})},
        ]
        for hook, expect in zip(payloads, (want, want[:1])):
            with patch.object(T, "_sh", board), patch.object(T, "D", None), patch.object(T.sys, "stdin", io.StringIO(json.dumps(hook))):
                self.assertEqual(T.command(args("plan", hook=True)), 0)
            self.assertEqual(board.updates[-1], ("task-a1", {"plan": expect}))
        n = len(board.updates)
        # a Codex tool that is not update_plan, or an update_plan without a plan: nothing
        for hook in ({"thread_id": "019a-thread-7777", "tool_name": "shell", "tool_input": {"command": ["ls"]}},
                     {"thread_id": "019a-thread-7777", "tool_name": "update_plan", "tool_input": {}}):
            with patch.object(T, "_sh", board), patch.object(T, "D", None), patch.object(T.sys, "stdin", io.StringIO(json.dumps(hook))):
                self.assertEqual(T.command(args("plan", hook=True)), 0)
        self.assertEqual(len(board.updates), n)

    def test_opencode_todowrite_from_the_plugin_plans_the_sessions_task(self):
        # Dispatch's OpenCode plugin (agent/opencode/dispatch.js) pipes this after every todowrite
        board = FakeBoard([issue("task-a1", "Minecraft", "2026-09-27T10:00:00Z", session="ses_2c4f9a1b3effe"),
                           issue("task-c3", "Elsewhere", "2026-09-27T11:00:00Z", session="other")])
        hook = {"tool_name": "todowrite", "session_id": "ses_2c4f9a1b3effe", "tool_input": {"todos": [
            {"content": "Build the world", "status": "completed", "priority": "high", "id": "1"},
            {"content": "Drop the mod loader", "status": "cancelled", "priority": "low", "id": "2"},
            {"content": "Add villagers", "status": "in_progress", "priority": "medium", "id": "3"},
            {"content": "Ship", "status": "pending", "priority": "medium", "id": "4"}]}}
        with patch.object(T, "_sh", board), patch.object(T, "D", None), patch.object(T.sys, "stdin", io.StringIO(json.dumps(hook))):
            self.assertEqual(T.command(args("plan", hook=True)), 0)
        self.assertEqual(board.updates[-1], ("task-a1", {"plan": [
            {"text": "Build the world", "state": "done"}, {"text": "Add villagers", "state": "active"}, {"text": "Ship", "state": "todo"}]}))

    def test_an_opencode_window_session_also_lists_the_tasks_filed_under_opencodes_own_id(self):
        # the window's id is the agent host's; `dispatch begin` in OpenCode's shell files tasks under ses_…
        board = FakeBoard([issue("task-a1", "From the shell", "2026-09-27T10:00:00Z", session="ses_2c4f9a1b3effe"),
                           issue("task-b2", "From the window", "2026-09-27T09:00:00Z", session="5e0f7a2c-aaaa-bbbb"),
                           issue("task-c3", "Elsewhere", "2026-09-27T11:00:00Z", session="other")])
        with patch("ide_sessions.transcript_key", return_value="opencode:ses_2c4f9a1b3effe") as tk:
            self.assertEqual(T.session_keys("agent-host-opencode:/5e0f7a2c-aaaa-bbbb"), ["5e0f7a2c-aaaa-bbbb", "ses_2c4f9a1b3effe"])
            tk.assert_called_with("opencode:5e0f7a2c-aaaa-bbbb")
            _, r = run(board, args("list", session="agent-host-opencode:/5e0f7a2c-aaaa-bbbb"))
        self.assertEqual(sorted(t["id"] for t in r["tasks"]), ["task-a1", "task-b2"])
        # other harnesses and OpenCode's own ids need no lookup
        with patch("ide_sessions.transcript_key") as tk:
            self.assertEqual(T.session_keys("agent-host-claude:/abc12345"), ["abc12345"])
            self.assertEqual(T.session_keys("opencode:/ses_2c4f9a1b3effe"), ["ses_2c4f9a1b3effe"])
            tk.assert_not_called()
        self.assertTrue(T.in_session(board.issues["task-a1"], ["nope", "ses_2c4f9a1b3effe"]))
        self.assertFalse(T.in_session(board.issues["task-a1"], ["nope"]))

    def test_a_sessions_list_asks_bd_by_label_and_never_exports_the_board(self):
        # task-nu516: the whole board's export took 10 s and timed out the This session list while agents wrote
        board = FakeBoard([issue("task-a1", "Asked here", "2026-09-27T10:00:00Z", session="6769f937-2933-44f6-88a7-8688d66eefec",
                                 deps=[("task-z9", "discovered-from")]),
                           issue("task-b2", "Claimed here", "2026-09-27T11:00:00Z", session="other",
                                 labels=["session:6769f937-2933-44f6-88a7-8688d66eefec"]),
                           issue("task-c3", "Elsewhere", "2026-09-27T12:00:00Z", session="other")])
        board.issues["task-a1"]["comments"] = [{"text": "Halfway", "created_at": "2026-09-27T10:30:00Z"}]
        last_export = [dict(board.issues["task-a1"])]
        with patch("board_export.cached_issues", return_value=last_export):
            _, r = run(board, args("list", session="6769f937-2933-44f6-88a7-8688d66eefec"))
        self.assertNotIn(["bd", "export"], board.calls)
        self.assertEqual(sorted(t["id"] for t in r["tasks"]), ["task-a1", "task-b2"])
        a1 = next(t for t in r["tasks"] if t["id"] == "task-a1")
        # what bd's list leaves out comes from the last export on disk
        self.assertEqual((a1["follows"], a1["last"]["text"]), ("task-z9", "Halfway"))

    def test_a_tasks_session_carries_the_windows_id_of_it(self):
        # task-wwi8s: MCP task_begin files the agent's own id (Claude's session, Codex's thread, OpenCode's ses_…);
        # the window files its own id for it before each turn (`dispatch handoff assess --register`)
        import session_life as L
        base = tempfile.mkdtemp()
        pairs = {"claude-code:6769f937-2933-44f6-88a7-8688d66eefec": "claude-code:c3bebb99-fd7d-42e2-a559-9cb2f3fd3d59",
                 "codex:019a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8": "codex:7b0c1d2e-3f40-4152-8637-48495a6b7c8d",
                 "opencode:ses_2c4f9a1b3effe": "opencode:5e0f7a2c-aaaa-bbbb-cccc-dddddddddddd"}
        board = FakeBoard([issue("task-a1", "Claude", "2026-09-27T10:00:00Z", session="6769f937-2933-44f6-88a7-8688d66eefec"),
                           issue("task-b2", "Codex", "2026-09-27T11:00:00Z", session="019a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8"),
                           issue("task-c3", "OpenCode", "2026-09-27T12:00:00Z", session="ses_2c4f9a1b3effe"),
                           issue("task-d4", "The window's own", "2026-09-27T13:00:00Z", session="9f8e7d6c-0000-1111-2222-333344445555")])
        with patch.object(L, "directory", lambda b=None: os.path.join(base, "life") if b is None else os.path.join(b, "life")):
            for native in pairs:
                L.save(L.path_for("managed", native), {"session": pairs[native]})
            _, listed = run(board, args("list", project="game"))
            _, shown = run(board, args("show", "task-a1", brief=True))
        got = {t["id"]: t["session_window"] for t in listed["tasks"]}
        self.assertEqual(got, {"task-a1": "c3bebb99-fd7d-42e2-a559-9cb2f3fd3d59", "task-b2": "7b0c1d2e-3f40-4152-8637-48495a6b7c8d",
                               "task-c3": "5e0f7a2c-aaaa-bbbb-cccc-dddddddddddd", "task-d4": ""})
        self.assertEqual(shown["session_window"], "c3bebb99-fd7d-42e2-a559-9cb2f3fd3d59")

    def test_follows_must_be_a_task(self):
        board = FakeBoard([issue("task-a1", "Minecraft", "2026-09-27T10:00:00Z")])
        with patch.object(T, "_sh", board), self.assertRaises(ValueError):
            T.command(args("follow", "task-a1", prev="task-nope"))
        with patch.object(T, "_sh", board), self.assertRaises(ValueError):
            T.command(args("follow", "task-a1", prev="task-a1"))


class Deliver(unittest.TestCase):
    def test_url_file_and_commit(self):
        board = FakeBoard([issue("task-a1", "Minecraft", "2026-09-27T10:00:00Z", meta={"plan": ["a"]})])
        with tempfile.TemporaryDirectory() as d:
            env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
            subprocess.run(["git", "init", "-q", d], check=True)
            with open(os.path.join(d, "index.html"), "w") as f:
                f.write("<p>hi</p>")
            subprocess.run(["git", "-C", d, "add", "."], check=True)
            subprocess.run(["git", "-C", d, "commit", "-qm", "Minecraft (task-a1)"], check=True, env=env)
            cwd = os.getcwd()
            os.chdir(d)
            try:
                _, r = run(board, args("deliver", "task-a1", url="http://localhost:5173", file="index.html", commit=""))
            finally:
                os.chdir(cwd)
        kinds = {x["kind"]: x for x in r["deliverables"]}
        self.assertEqual(set(kinds), {"url", "file", "commit"})
        self.assertTrue(kinds["file"]["ref"].endswith("/index.html") and os.path.isabs(kinds["file"]["ref"]))
        self.assertEqual(kinds["commit"]["label"], "Minecraft (task-a1)")
        self.assertTrue(kinds["commit"]["repo"])
        self.assertEqual(r["plan"], [{"text": "a", "state": "todo"}])
        # the same deliverable twice is kept once
        _, r = run(board, args("deliver", "task-a1", url="http://localhost:5173"))
        self.assertEqual(sum(1 for x in r["deliverables"] if x["kind"] == "url"), 1)

    def test_file_with_where_to_look(self):
        with tempfile.TemporaryDirectory() as d:
            impl = os.path.join(d, "impl")
            os.makedirs(impl)
            for n in ("index.html", "notes.md", "01-list.png"):
                with open(os.path.join(impl, n), "w") as f:
                    f.write("# Notes\n" if n == "notes.md" else "x")
            with open(os.path.join(impl, "00-where.json"), "w") as f:
                json.dump({"image": "01-list.png", "size": [10, 10], "items": [
                    {"n": 1, "box": [1, 1, 2, 2], "what": "a"}, {"n": 2, "box": [3, 3, 2, 2], "what": "b"}]}, f)
            plain = os.path.join(d, "plain.md")
            with open(plain, "w") as f:
                f.write("# Plain\n")
            meta = {"deliverables": [
                {"kind": "file", "ref": os.path.join(impl, "index.html"), "label": "Page"},
                {"kind": "file", "ref": impl, "label": "Folder"},
                {"kind": "file", "ref": plain, "label": "Plain"},
                {"kind": "commit", "ref": "abc1234", "label": "c"}]}
            r = T.task_row(issue("task-a1", "Minecraft", "2026-09-27T10:00:00Z", meta=meta))
            page, folder, bare, commit = r["deliverables"]
            self.assertEqual(page["where"]["count"], 2)
            self.assertEqual(page["where"]["image"], os.path.join(impl, "01-list.png"))
            self.assertEqual([i["n"] for i in page["where"]["items"]], [1, 2])
            self.assertEqual(folder["where"]["count"], 2)  # a folder: its notes.md
            self.assertNotIn("where", bare)
            self.assertNotIn("where", commit)
            # never stored: the metadata stays as it was
            self.assertNotIn("where", meta["deliverables"][0])

    def test_needs_something(self):
        board = FakeBoard([issue("task-a1", "Minecraft", "2026-09-27T10:00:00Z")])
        with patch.object(T, "_sh", board), self.assertRaises(ValueError):
            T.command(args("deliver", "task-a1"))


# One session (s1) asks: Minecraft (a), + villagers (b, follows a), Super Mario (c, a new thing),
# two days later Minecraft monsters (d, follows b); another session (s2) adds to Minecraft (e).
STORY = [
    issue("task-a1", "Minecraft web", "2026-09-27T10:00:00Z", status="closed", closed="2026-09-27T10:30:00Z", meta={"thing": "Minecraft"}),
    issue("task-b2", "Add villagers", "2026-09-27T11:00:00Z", status="closed", closed="2026-09-27T11:20:00Z", meta={"follows": "task-a1"}),
    issue("task-c3", "Super Mario", "2026-09-27T12:00:00Z", status="in_progress", meta={"thing": "Mario", "from": "task-b2"}),
    issue("task-d4", "Minecraft monsters", "2026-09-29T13:00:00Z", status="blocked", meta={"follows": "task-b2"}),
    issue("task-e5", "Other session's thing", "2026-09-27T12:30:00Z", session="s2", meta={"follows": "task-a1"}),
    issue("task-x0", "Another project", "2026-09-27T12:30:00Z", project="else"),
    issue("task-t0", "Trashed", "2026-09-27T12:30:00Z", status="deferred", labels=["dispatch:trashed"]),
]
STORY_NOW = 1790700000  # 2026-09-29 23:20 UTC


class Graph(unittest.TestCase):
    def rows(self):
        return [T.task_row(t) for t in T.select(STORY, "game")]

    def test_one_row_per_thing_branch_and_merge(self):
        g = T.build_graph(self.rows(), now=STORY_NOW, titles={"s1": "Games"})
        thing = {n["id"]: n["thing"]["name"] for n in g["nodes"]}
        self.assertEqual(thing, {"task-a1": "Minecraft", "task-b2": "Minecraft", "task-c3": "Mario", "task-d4": "Minecraft", "task-e5": "Minecraft"})
        # the new thing sits right under the one it branched off
        self.assertEqual([(t["name"], t["state"], t["n"]) for t in g["things"]], [("Minecraft", "waiting", 4), ("Mario", "in_progress", 1)])
        mc, mario = g["things"]
        self.assertEqual(mario["parent"], mc["id"])
        self.assertIsNone(mc["parent"])
        self.assertEqual(mc["now_task"], {"id": "task-d4", "title": "Minecraft monsters", "status": "waiting"})
        self.assertEqual(mc["counts"], {"done": 2, "in_progress": 0, "waiting": 1, "todo": 1})
        self.assertEqual(mc["id"], T.TH.thing_id("minecraft"))
        links = {(l["from"], l["to"], l["kind"], l["gap_days"], l["source"]) for l in g["links"]}
        self.assertEqual(links, {("task-b2", "task-c3", "branch", 0, "explicit"),   # Mario branches off the task the session was on (begin wrote it)
                                 ("task-c3", "task-d4", "merge", 2, "explicit")})   # back to Minecraft two days later, from Mario (task follow)
        by = {n["id"]: n for n in g["nodes"]}
        self.assertEqual(by["task-d4"]["from"], {"id": "task-c3", "source": "explicit", "thing": "Mario", "title": "Super Mario"})   # the session's previous task; d4 follows b2
        self.assertEqual(by["task-b2"]["from"], {"id": "task-a1", "source": "explicit", "thing": "Minecraft", "title": "Minecraft web"})
        self.assertIsNone(by["task-e5"]["from"])                                            # the first in its session
        self.assertIsNone(by["task-a1"]["plan_now"])
        self.assertEqual(by["task-a1"]["session_title"], "Games")
        self.assertEqual(by["task-d4"]["status"], "waiting")
        self.assertNotIn("lane", by["task-a1"])
        self.assertEqual(g["counts"], {"tasks": 5, "things": 2, "waiting": 1})

    def test_a_day_back_is_a_merge_within_the_day_a_hop(self):
        rows = self.rows()
        for r in rows:
            if r["id"] == "task-d4":
                r["created_at"] = T.epoch("2026-09-27T13:00:00Z")
        g = T.build_graph(rows, now=STORY_NOW, titles={})
        self.assertIn(("task-c3", "task-d4", "hop"), {(l["from"], l["to"], l["kind"]) for l in g["links"]})

    def test_session_keeps_the_project_and_marks_its_own(self):
        g = T.build_graph(self.rows(), now=STORY_NOW, session="s2", titles={})
        self.assertEqual({n["id"] for n in g["nodes"] if n["mine"]}, {"task-e5"})
        self.assertEqual(len(g["nodes"]), 5)
        self.assertEqual({t["name"]: t["mine"] for t in g["things"]}, {"Minecraft": 1, "Mario": 0})
        self.assertEqual(g["counts"]["mine"], 1)

    def test_quiet_after_seven_days(self):
        g = T.build_graph(self.rows(), now=STORY_NOW, titles={})
        self.assertEqual({t["name"]: t["quiet"] for t in g["things"]}, {"Minecraft": False, "Mario": False})
        g = T.build_graph(self.rows(), now=STORY_NOW + 6 * 86400, titles={})
        self.assertEqual({t["name"]: t["quiet"] for t in g["things"]}, {"Minecraft": False, "Mario": True})
        g = T.build_graph(self.rows(), now=T.epoch("2026-09-29T13:00:00Z") + 8 * 86400, titles={})
        self.assertEqual({t["name"]: t["quiet"] for t in g["things"]}, {"Minecraft": True, "Mario": True})

    def test_window_draws_less_but_knows_the_first_task(self):
        rows = self.rows()
        shown = [r for r in rows if r["id"] in ("task-c3", "task-d4")]
        g = T.build_graph(rows, shown, now=STORY_NOW, titles={})
        self.assertEqual({n["id"] for n in g["nodes"]}, {"task-c3", "task-d4"})
        # b2 is not drawn, so its branch line is not either; Mario still knows it branched off Minecraft
        self.assertEqual([(l["from"], l["to"]) for l in g["links"]], [("task-c3", "task-d4")])
        self.assertEqual([t["name"] for t in g["things"]], ["Minecraft", "Mario"])
        self.assertEqual(g["things"][1]["parent"], g["things"][0]["id"])

    def test_list_and_graph_commands(self):
        board = FakeBoard(STORY)
        _, r = run(board, args("list", project="game"))
        self.assertEqual([t["id"] for t in r["tasks"]], ["task-d4", "task-c3", "task-e5", "task-b2", "task-a1"])
        self.assertEqual({t["id"]: t["thing"] for t in r["tasks"]}["task-c3"], "Mario")
        _, r = run(board, args("list", session="agent-host-claude:/s2"))
        self.assertEqual([t["id"] for t in r["tasks"]], ["task-e5"])
        _, r = run(board, args("list", project="game", status="done"))
        self.assertEqual([t["id"] for t in r["tasks"]], ["task-b2", "task-a1"])
        _, g = run(board, args("graph", session="s1"))
        self.assertEqual(g["project"], "game")
        self.assertEqual(g["session"], "s1")
        self.assertEqual({n["id"] for n in g["nodes"] if n["mine"]}, {"task-a1", "task-b2", "task-c3", "task-d4"})
        self.assertEqual(len(g["nodes"]), 5)
        _, g = run(board, args("graph", project="game"))
        self.assertEqual(len(g["nodes"]), 5)
        self.assertEqual(sorted(g), ["counts", "days", "links", "nodes", "now", "project", "session", "things"])
        self.assertTrue(all("conflicts" in n for n in g["nodes"]))
        code, text = run(board, args("graph", project="game", json=False))
        self.assertIn("Minecraft", text)

    def test_show_has_the_request(self):
        board = FakeBoard([dict(STORY[0], description="做一个我的世界网页版")])
        _, r = run(board, args("show", "task-a1"))
        self.assertEqual(r["description"], "做一个我的世界网页版")
        self.assertEqual(r["commits"], [])

    def test_show_brief_skips_the_commits(self):
        board = FakeBoard([dict(STORY[0], description="做一个我的世界网页版")])
        _, r = run(board, args("show", "task-a1", brief=True))
        self.assertEqual(r["title"], "Minecraft web")
        self.assertNotIn("commits", r)

    def test_errors_are_json(self):
        buf = io.StringIO()
        with patch.object(T, "_sh", FakeBoard([])), redirect_stdout(buf):
            self.assertEqual(T.run(args("show", "task-zz")), 1)
        self.assertFalse(json.loads(buf.getvalue())["ok"])


def iso(days_ago):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(time.time() - days_ago * 86400, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# the last 30 days, and before: a task from before plans and deliverables existed still counts
OLD = [
    issue("task-n1", "Recent, no plan", iso(2), status="closed", closed=iso(1)),
    issue("task-n2", "Old but still running", iso(60), status="in_progress"),
    issue("task-o1", "Old and done", iso(70), status="closed", closed=iso(65)),
    issue("task-o2", "Old to do", iso(40)),
    issue("task-o3", "Oldest", iso(90), status="closed", closed=iso(89)),
]


class Window(unittest.TestCase):
    def test_list_takes_the_last_30_days_and_archived_the_rest(self):
        board = FakeBoard(OLD)
        _, r = run(board, args("list", project="game", days=None))
        self.assertEqual(r["days"], 30)
        self.assertEqual({t["id"] for t in r["tasks"]}, {"task-n1", "task-n2"})
        _, r = run(board, args("list", project="game", days=None, archived=True))
        self.assertTrue(r["archived"])
        self.assertEqual([t["id"] for t in r["tasks"]], ["task-o2", "task-o1", "task-o3"])  # newest first
        _, r = run(board, args("list", project="game", days=0))
        self.assertEqual(len(r["tasks"]), 5)
        _, r = run(board, args("list", project="game", days=45))
        self.assertEqual({t["id"] for t in r["tasks"]}, {"task-n1", "task-n2", "task-o2"})

    def test_graph_draws_the_window_without_plan_or_deliverables(self):
        board = FakeBoard(OLD)
        _, g = run(board, args("graph", project="game", days=None))
        self.assertEqual({n["id"] for n in g["nodes"]}, {"task-n1", "task-n2"})
        self.assertEqual({n["id"]: (n["plan_total"], n["deliverables"]) for n in g["nodes"]},
                         {"task-n1": (0, []), "task-n2": (0, [])})
        with patch.object(T, "_sh", board), patch.object(T, "D", None), self.assertRaises(ValueError):
            T.command(args("graph", project="game", archived=True))

    def test_a_folder_in_no_project_is_an_empty_graph_not_an_error(self):
        board = FakeBoard(OLD)

        class NoProject:
            @staticmethod
            def docs_project_of_folder(folder):
                raise ValueError("这个文件夹不属于任何项目：" + folder)

        buf = io.StringIO()
        with patch.object(T, "_sh", board), patch.object(T, "D", NoProject), patch.dict(os.environ, {"DISPATCH_DIR": _STATE}), redirect_stdout(buf):
            code = T.command(args("graph", folder="/tmp/somewhere", session="s-new", days=None))
        g = json.loads(buf.getvalue())
        self.assertEqual(code, 0)
        self.assertEqual((g["project"], g["nodes"], g["things"]), ("", [], []))
        self.assertEqual(T.resolve_project("game", "/tmp/somewhere"), "game")


class ChatGraph(unittest.TestCase):
    def test_a_chat_without_a_project_folder_draws_only_its_own_tasks(self):
        """task-p0za2: a Chats session's Task graph showed the whole kanban project (632 tasks)."""
        chat_task = issue("task-c1", "Reschedule email", iso(1), session="s-chat", project="")
        chat_task["labels"] = [x for x in chat_task["labels"] if x != "project:"]
        board = FakeBoard(OLD + [chat_task])

        class Everywhere:  # a folder lookup that finds a project for any folder (a home folder inside a git repo)
            @staticmethod
            def docs_project_of_folder(folder):
                return "game"

        for folder in (os.path.join(os.path.expanduser("~"), ".copilot", "chats", "s-chat"), os.path.expanduser("~")):
            buf = io.StringIO()
            with patch.object(T, "_sh", board), patch.object(T, "D", Everywhere), patch.dict(os.environ, {"DISPATCH_DIR": _STATE}), redirect_stdout(buf):
                self.assertEqual(T.command(args("graph", folder=folder, session="s-chat", days=None)), 0)
            g = json.loads(buf.getvalue())
            self.assertEqual((g["project"], [n["id"] for n in g["nodes"]]), ("", ["task-c1"]), folder)


class Cli(unittest.TestCase):
    def test_worktree_project_scope_with_real_git_and_registered_alias(self):
        import dispatch
        with tempfile.TemporaryDirectory() as root:
            repo = os.path.join(root, "repository")
            wt = os.path.join(root, "checkouts", "feature")
            os.makedirs(repo)
            def git(*argv):
                subprocess.run(["git", "-C", repo, *argv], check=True, capture_output=True)
            git("init", "-q")
            git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial")
            git("worktree", "add", "-qb", "feature", wt)
            nested = os.path.join(wt, "src")
            os.makedirs(nested)
            board = FakeBoard(STORY)
            # the real module carries the real board and state paths: point both at this test, or the shared
            # export cache reads the real board's rows (and writes these fake ones into its cache)
            with patch.object(dispatch, "project_names", return_value={"game": "game"}), \
                    patch.object(dispatch, "settings_load", return_value={}), \
                    patch.object(dispatch, "project_dirs", return_value={"game": repo}), \
                    patch.object(dispatch, "project_dir_names", return_value={"game": "game"}), \
                    patch.object(dispatch, "BEADS_DIR", os.path.join(root, "no-board")), \
                    patch.object(dispatch, "DISPATCH_DIR", _STATE), \
                    patch.object(T, "D", dispatch), patch.object(T, "_sh", board), \
                    patch.dict(os.environ, {"DISPATCH_DIR": _STATE}):
                for folder in (repo, wt, nested):
                    for op, key in (("list", "tasks"), ("graph", "nodes")):
                        with self.subTest(folder=folder, op=op), redirect_stdout(io.StringIO()) as buf:
                            self.assertEqual(T.command(args(op, folder=folder)), 0)
                        result = json.loads(buf.getvalue())
                        self.assertEqual(result["project"], "game")
                        self.assertEqual({t["id"] for t in result[key]}, {t["id"] for t in STORY if T.in_project(t, "game") and not T.hidden(t)})

    def test_unknown_folder_is_empty_for_list_and_graph_without_a_session(self):
        d = SimpleNamespace(docs_project_of_folder=lambda folder: "")
        with patch.object(T, "D", d), patch.object(T, "_sh", FakeBoard(STORY)), \
                patch.dict(os.environ, {"DISPATCH_DIR": _STATE}):
            for op, key in (("list", "tasks"), ("graph", "nodes")):
                with self.subTest(op=op), redirect_stdout(io.StringIO()) as buf:
                    self.assertEqual(T.command(args(op, folder="/missing")), 0)
                self.assertEqual(json.loads(buf.getvalue())[key], [])
            with self.assertRaisesRegex(ValueError, "give --project"):
                T.command(args("list"))

    def test_argparse_reaches_tasks_view(self):
        import dispatch
        seen = {}

        def fake_run(a, d):
            seen.update(op=a.op, task=a.task, set=a.set, commit=a.commit, session=a.session)
            return 0
        with patch.object(sys, "argv", ["dispatch", "task", "plan", "task-a1", "--set", "A", "--set", "B", "--json"]), \
                patch.object(T, "run", fake_run), self.assertRaises(SystemExit) as e:
            dispatch._main()
        self.assertEqual(e.exception.code, 0)
        self.assertEqual(seen["set"], ["A", "B"])
        with patch.object(sys, "argv", ["dispatch", "task", "deliver", "task-a1", "--commit"]), \
                patch.object(T, "run", fake_run), self.assertRaises(SystemExit):
            dispatch._main()
        self.assertEqual(seen["commit"], "")

    def test_days_default_and_archived_flag(self):
        import dispatch
        seen = {}

        def fake_run(a, d):
            seen.update(days=a.days, archived=a.archived)
            return 0
        for argv, want in ((["task", "list", "-P", "game"], {"days": None, "archived": False}),
                           (["task", "list", "-P", "game", "--archived"], {"days": None, "archived": True}),
                           (["task", "graph", "-P", "game", "--days", "7"], {"days": 7, "archived": False})):
            with patch.object(sys, "argv", ["dispatch", *argv, "--json"]), patch.object(T, "run", fake_run), self.assertRaises(SystemExit):
                dispatch._main()
            self.assertEqual(seen, want)


if __name__ == "__main__":
    unittest.main()
