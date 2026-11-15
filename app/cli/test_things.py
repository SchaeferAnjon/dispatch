import io, json, os, sys, tempfile, unittest
from contextlib import redirect_stderr
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tasks_view as T
import things as TH
from test_tasks_view import FakeBoard, args, issue, run


def row(tid, title, created, session="s1", thing="", frm="", follows="", status="todo", done=None):
    return {"id": tid, "title": title, "created_at": created, "session": session, "thing": thing, "from": frm,
            "follows": follows, "status": status, "done_at": done}


class Names(unittest.TestCase):
    def test_short_name_takes_the_part_before_the_colon(self):
        self.assertEqual(TH.short_name("签名和上架：建 Developer ID"), "签名和上架")
        self.assertEqual(TH.short_name("Projects page: count is off"), "Projects page")
        self.assertEqual(TH.short_name("Mario"), "Mario")
        self.assertEqual(TH.short_name("修 Bug（task-2vcx）"), "修 Bug")
        self.assertEqual(TH.short_name("Minecraft web version with villagers"), "Minecraft web…")
        self.assertEqual(TH.short_name("Add a Knowledge page"), "Add a Knowledge page")
        self.assertEqual(TH.short_name("Fix the Projects page count"), "Fix the Projects…")
        self.assertEqual(TH.short_name(""), "Untitled")
        self.assertEqual(TH.short_name("一二三四五六七八九十一二三四五六七八九十"), "一二三四五六七八九十一二…")

    def test_thing_id_is_stable_for_the_name(self):
        self.assertEqual(TH.thing_id("Projects 页"), TH.thing_id("  projects   页 "))
        self.assertNotEqual(TH.thing_id("Projects 页"), TH.thing_id("右侧栏"))
        self.assertRegex(TH.thing_id("x"), TH.THING_ID)

    def test_stored_ignores_junk(self):
        self.assertEqual(TH.stored({"thing": "  手机端 ", "from": "task-ab1"}), ("手机端", "task-ab1"))
        self.assertEqual(TH.stored({"thing": 3, "from": "not a task"}), ("", ""))
        self.assertEqual(len(TH.stored({"thing": "x" * 90})[0]), TH.NAME_MAX)


class Resolve(unittest.TestCase):
    def test_stored_then_follows_then_the_sessions_previous_task(self):
        rows = [
            row("task-a1", "Minecraft web", 100, thing="Minecraft"),
            row("task-b2", "Villagers", 200),                         # the session's previous task: Minecraft
            row("task-c3", "Super Mario", 300, thing="Mario"),        # named: a new thing
            row("task-d4", "Monsters", 400, follows="task-b2"),       # follows b2: Minecraft, although the session was on Mario
            row("task-e5", "Pipes", 500),                             # after d4 in the session: Minecraft
            row("task-f6", "QQ 飞车：赛道", 150, session="s2"),       # first in its session, nothing named: from its title
            row("task-g7", "Karts", 350, session="s2", frm="task-c3"),  # a stored from wins over the session's previous task
        ]
        thing_of, from_of, source_of = TH.resolve(rows)
        self.assertEqual(thing_of, {"task-a1": "Minecraft", "task-b2": "Minecraft", "task-c3": "Mario", "task-d4": "Minecraft",
                                    "task-e5": "Minecraft", "task-f6": "QQ 飞车", "task-g7": "Mario"})
        self.assertEqual(from_of, {"task-a1": "", "task-b2": "task-a1", "task-c3": "task-b2", "task-d4": "task-c3",
                                   "task-e5": "task-d4", "task-f6": "", "task-g7": "task-c3"})
        # written down by an agent (a stored from, a follow) or only the session's order
        self.assertEqual({t: source_of[t] for t in ("task-b2", "task-d4", "task-g7")}, {"task-b2": "inferred", "task-d4": "explicit", "task-g7": "explicit"})

    def test_links(self):
        day = TH.DAY
        rows = [
            row("task-a1", "A", 0, thing="A"),
            row("task-b2", "B", 3600, thing="B"),                     # new thing B from A: branch
            row("task-c3", "A again", 7200, thing="A"),               # back to A two hours later: hop
            row("task-d4", "B again", 3 * day, thing="B"),            # back to B three days later: merge
            row("task-e5", "B more", 3 * day + 60),                    # same thing: no link
            row("task-f6", "C", 4 * day, session="s2", thing="C"),    # first in its session: no from, no link
        ]
        thing_of, from_of, source_of = TH.resolve(rows)
        self.assertEqual(TH.links(rows, thing_of, from_of, source_of), [
            {"from": "task-a1", "to": "task-b2", "kind": "branch", "gap_days": 0, "source": "inferred"},
            {"from": "task-b2", "to": "task-c3", "kind": "hop", "gap_days": 0, "source": "inferred"},
            {"from": "task-c3", "to": "task-d4", "kind": "merge", "gap_days": 3, "source": "inferred"},
        ])

    def test_drawing_order_is_depth_first_by_branch(self):
        day = TH.DAY
        rows = [
            row("task-a1", "A", 0, thing="A"),
            row("task-z1", "Z", 10, session="s9", thing="Z"),         # a second root, started later than A
            row("task-b2", "B", 20, thing="B"),                        # branched off A
            row("task-c3", "C", 30, thing="C"),                        # branched off B
            row("task-d4", "D", 40, session="s9", thing="D"),         # branched off Z
            row("task-e5", "E", 50, frm="task-a1", thing="E"),        # branched off A again, after B
        ]
        thing_of, from_of, source_of = TH.resolve(rows)
        things = TH.summarize(rows, thing_of, TH.links(rows, thing_of, from_of, source_of), now=100 * day)
        self.assertEqual([t["name"] for t in things], ["A", "B", "C", "E", "Z", "D"])
        parent = {t["name"]: t["parent"] for t in things}
        self.assertEqual(parent["C"], TH.thing_id("B"))
        self.assertIsNone(parent["Z"])
        self.assertTrue(all(t["quiet"] for t in things))

    def test_plan_now(self):
        self.assertIsNone(TH.plan_now([]))
        plan = [{"text": "World", "state": "done"}, {"text": "Blocks", "state": "active"}, {"text": "Save", "state": "todo"}]
        self.assertEqual(TH.plan_now(plan), {"n": 2, "text": "Blocks"})
        self.assertEqual(TH.plan_now([dict(p, state="done" if i == 0 else "todo") for i, p in enumerate(plan)]), {"n": 2, "text": "Blocks"})
        self.assertEqual(TH.plan_now([dict(p, state="done") for p in plan]), {"n": 3, "text": "Save"})

    def test_now_task_and_state(self):
        ts = [row("task-a1", "one", 1, status="done", done=2), row("task-b2", "two", 3, status="todo"),
              row("task-c3", "three", 4, status="in_progress"), row("task-d4", "four", 5, status="in_progress")]
        self.assertEqual(TH.state_of([t["status"] for t in ts]), "in_progress")
        self.assertEqual(TH.now_task(ts)["id"], "task-d4")
        self.assertEqual(TH.now_task(ts[:1])["id"], "task-a1")
        self.assertEqual(TH.state_of([]), "done")


RULES = {"rules": [["签名和上架", "签名|公证"], ["手机端", "手机|iOS"], ["其他", "."]], "override": {"task-o1": "手机端"}}


class Migrate(unittest.TestCase):
    def board(self):
        return FakeBoard([
            issue("task-s1", "给 Dispatch IDE 签名：建 Developer ID", "2026-09-20T10:00:00Z", meta={"plan": [{"text": "x", "state": "todo"}]}),
            issue("task-p1", "手机端推送", "2026-09-20T11:00:00Z"),
            issue("task-o1", "公证失败的时候手机上提醒", "2026-09-20T12:00:00Z"),   # the override beats the rule that matches first
            issue("task-k1", "Something else", "2026-09-20T13:00:00Z", meta={"thing": "已有的事"}),
            issue("task-x1", "别的项目的签名", "2026-09-20T13:00:00Z", project="else"),
        ])

    def rules_file(self):
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(RULES, f, ensure_ascii=False)
        f.close()
        self.addCleanup(os.unlink, f.name)
        return f.name

    def test_dry_run_writes_nothing(self):
        board = self.board()
        with patch.object(T, "bd_import") as imp:
            _, r = run(board, args("things", "migrate", project="game", rules=self.rules_file(), dry_run=True))
        imp.assert_not_called()
        self.assertEqual(board.updates, [])
        self.assertEqual((r["tasks"], r["changed"], r["kept"]), (4, 3, 1))
        self.assertEqual({t["name"]: t["n"] for t in r["things"]}, {"签名和上架": 1, "手机端": 2})

    def test_write_imports_the_rows_a_second_newer(self):
        board = self.board()
        with patch.object(T, "bd_import", return_value={"stale_skipped_ids": ["task-p1"]}) as imp:
            _, r = run(board, args("things", "migrate", project="game", rules=self.rules_file()))
        rows = [json.loads(line) for line in imp.call_args[0][0].splitlines()]
        self.assertEqual({x["id"]: x["metadata"]["thing"] for x in rows}, {"task-s1": "签名和上架", "task-p1": "手机端", "task-o1": "手机端"})
        s1 = next(x for x in rows if x["id"] == "task-s1")
        self.assertEqual(s1["metadata"]["plan"], [{"text": "x", "state": "todo"}])   # the rest of the metadata stays
        self.assertEqual(s1["updated_at"], "2026-09-20T10:00:01Z")
        self.assertEqual(s1["_type"], "issue")
        self.assertEqual((r["written"], r["skipped"]), (2, ["task-p1"]))

    def test_without_rules_the_session_rule(self):
        board = FakeBoard([
            issue("task-a1", "Minecraft：网页版", "2026-09-20T10:00:00Z"),
            issue("task-b2", "加村民", "2026-09-20T11:00:00Z"),
            issue("task-c3", "超级玛丽：第一关", "2026-09-20T12:00:00Z", session="s2"),
        ])
        with patch.object(T, "bd_import", return_value={}):
            _, r = run(board, args("things", "migrate", project="game"))
        self.assertEqual({t["name"]: t["n"] for t in r["things"]}, {"Minecraft": 2, "超级玛丽": 1})

    def test_rules_file_must_have_rules(self):
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump({"rules": []}, f)
        f.close()
        self.addCleanup(os.unlink, f.name)
        with self.assertRaises(ValueError):
            TH.load_rules(f.name)

    def test_bumped(self):
        self.assertEqual(TH.bumped("2026-09-27T19:25:59Z"), "2026-09-27T19:26:00Z")
        self.assertEqual(TH.bumped("2026-09-27T21:47:21.508871Z"), "2026-09-27T21:47:22.508871Z")
        self.assertEqual(TH.bumped("garbage"), "garbage")

    def test_things_lists_the_window(self):
        board = FakeBoard([issue("task-a1", "Minecraft：网页版", "2026-09-27T10:00:00Z", meta={"thing": "Minecraft"})])
        _, r = run(board, args("things", project="game", days=0))
        self.assertEqual([t["name"] for t in r["things"]], ["Minecraft"])
        self.assertEqual(r["counts"]["things"], 1)


class ListingBoard(FakeBoard):
    """FakeBoard plus `bd list --label session-origin:<id>`."""
    def __call__(self, argv, timeout=60):
        if argv[:2] == ["bd", "list"]:
            label = argv[argv.index("--label") + 1]
            return 0, json.dumps([t for t in self.issues.values() if label in t.get("labels", [])]), ""
        return super().__call__(argv, timeout)


class Begin(unittest.TestCase):
    def begin(self, board, tid, thing="", session="s1", project="game"):
        with patch.object(T, "_sh", board), patch.object(T, "D", None):
            return T.begin_thing(tid, thing, session, project)

    def test_named_thing_and_the_sessions_previous_task(self):
        board = ListingBoard([issue("task-a1", "Minecraft", "2026-09-27T10:00:00Z", meta={"thing": "Minecraft"}),
                              issue("task-b2", "Mario", "2026-09-27T11:00:00Z")])
        self.assertEqual(self.begin(board, "task-b2", thing="Mario"), {"thing": "Mario", "from": "task-a1"})
        self.assertEqual(board.issues["task-b2"]["metadata"], {"thing": "Mario", "from": "task-a1"})

    def test_without_thing_it_goes_with_the_previous_task(self):
        board = ListingBoard([issue("task-a1", "Minecraft", "2026-09-27T10:00:00Z", meta={"thing": "Minecraft"}),
                              issue("task-b2", "Villagers", "2026-09-27T11:00:00Z")])
        self.assertEqual(self.begin(board, "task-b2"), {"thing": "Minecraft", "from": "task-a1"})

    def test_a_thing_id_names_that_thing(self):
        board = ListingBoard([issue("task-a1", "Minecraft", "2026-09-27T10:00:00Z", session="s0", meta={"thing": "Minecraft"}),
                              issue("task-b2", "Villagers", "2026-09-27T11:00:00Z")])
        self.assertEqual(self.begin(board, "task-b2", thing=TH.thing_id("Minecraft")), {"thing": "Minecraft"})

    def test_first_in_a_new_session_writes_only_a_named_thing(self):
        board = ListingBoard([issue("task-b2", "Villagers", "2026-09-27T11:00:00Z")])
        self.assertEqual(self.begin(board, "task-b2"), {})
        self.assertEqual(board.updates, [])

    def test_never_fails_the_begin(self):
        board = ListingBoard([issue("task-b2", "Villagers", "2026-09-27T11:00:00Z")])
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(self.begin(board, "task-b2", thing="th-000000"), {})   # an unknown id: a warning, no raise
        self.assertIn("task thing task-b2", err.getvalue())


class SetAndShow(unittest.TestCase):
    def test_thing_op_sets_one_task(self):
        board = FakeBoard([issue("task-a1", "Minecraft", "2026-09-27T10:00:00Z")])
        _, r = run(board, args("thing", "task-a1", prev="  我的世界 "))
        self.assertEqual(r["thing"], "我的世界")
        with patch.object(T, "_sh", board), self.assertRaises(ValueError):
            T.command(args("thing", "task-a1", prev=""))

    def test_show_resolves_a_missing_thing(self):
        board = FakeBoard([issue("task-a1", "Minecraft", "2026-09-27T10:00:00Z", meta={"thing": "我的世界"}),
                           issue("task-b2", "Villagers", "2026-09-27T11:00:00Z")])
        _, r = run(board, args("show", "task-b2"))
        self.assertEqual(r["thing"], "我的世界")


class Cli(unittest.TestCase):
    def test_argparse(self):
        import dispatch
        seen = {}

        def fake_run(a, d):
            seen.update(op=a.op, task=a.task, prev=a.prev, rules=a.rules, dry_run=a.dry_run, project=a.project)
            return 0
        for argv, want in ((["task", "things", "migrate", "-P", "kanban", "--rules", "r.json", "--dry-run"],
                            {"op": "things", "task": "migrate", "prev": "", "rules": "r.json", "dry_run": True, "project": "kanban"}),
                           (["task", "thing", "task-a1", "手机端"],
                            {"op": "thing", "task": "task-a1", "prev": "手机端", "rules": "", "dry_run": False, "project": ""})):
            with patch.object(sys, "argv", ["dispatch", *argv]), patch.object(T, "run", fake_run), self.assertRaises(SystemExit):
                dispatch._main()
            self.assertEqual(seen, want)

    def test_begin_takes_thing(self):
        import dispatch
        seen = {}
        with patch.object(sys, "argv", ["dispatch", "begin", "Minecraft 网页版：做一个我的世界", "-P", "game", "-d", "x" * 30, "--thing", "我的世界"]), \
                patch.object(dispatch, "cmd_begin", lambda a: seen.update(thing=a.thing)):
            dispatch._main()
        self.assertEqual(seen, {"thing": "我的世界"})


class HoverGraphData(unittest.TestCase):
    def test_plan_origin_and_latest_activity_are_in_graph(self):
        plan = [{"text": "Prepare", "state": "done"}, {"text": "Verify", "state": "active"}]
        parent = issue("task-a1", "Prepare release", "2026-09-27T10:00:00Z", meta={"thing": "Release"})
        child = issue("task-b2", "Verify all platforms", "2026-09-27T11:00:00Z", meta={"thing": "Testing", "from": "task-a1", "plan": plan,
                      "deliverables": [{"kind": "file", "ref": "/tmp/result.md", "label": "Test report", "at": T.epoch("2026-09-27T12:00:00Z")} ]})
        child["comments"] = [{"created_at": "2026-09-27T13:00:00Z", "text": "All platforms checked."},
                             {"created_at": "2026-09-27T11:30:00Z", "text": "Started."}, {"created_at": "invalid", "text": "Ignored."}]
        rows = [T.task_row(t) for t in [parent, child]]
        node = T.build_graph(rows, titles={"s1": "Release work"})["nodes"][1]
        self.assertEqual(node["plan"], plan)
        self.assertEqual(node["plan_now"], {"n": 2, "text": "Verify"})
        self.assertEqual(node["from"], {"id": "task-a1", "source": "explicit", "thing": "Release", "title": "Prepare release"})
        self.assertEqual(node["last"], {"at": T.epoch("2026-09-27T13:00:00Z"), "text": "All platforms checked."})
        child["comments"] = []
        self.assertEqual(T.last_activity(child)["text"], "Delivered: Test report")
        child.update(status="closed", closed_at="2026-09-27T14:00:00Z", close_reason="Released.")
        self.assertEqual(T.last_activity(child), {"at": T.epoch(child["closed_at"]), "text": "Released."})
        self.assertIsNone(T.last_activity(parent))

    def test_inferred_origin_resolves_outside_visible_window(self):
        rows = [T.task_row(issue("task-a1", "Original request", "2026-09-25T10:00:00Z", meta={"thing": "Release"})),
                T.task_row(issue("task-b2", "Follow up", "2026-09-27T10:00:00Z"))]
        node = T.build_graph(rows, shown=rows[1:], titles={})["nodes"][0]
        self.assertEqual(node["from"], {"id": "task-a1", "source": "inferred", "thing": "Release", "title": "Original request"})


if __name__ == "__main__":
    unittest.main()
