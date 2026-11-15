import json, os, sys, tempfile, threading, time, unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import flows
import ide_show
import tasks_view as T
import waiting as W
from test_tasks_view import issue


class Board:
    """bd show / update / create / close against a dict, enough for flows.py."""

    def __init__(self, issues):
        self.issues = {t["id"]: t for t in issues}
        self.created = []
        self.n = 0

    def __call__(self, argv, timeout=60):
        op = argv[1]
        if op == "show":
            t = self.issues.get(argv[2])
            return (0, json.dumps([t]), "") if t else (1, "", "no issue")
        if op == "update":
            t = self.issues[argv[2]]
            if "--metadata" in argv:
                t["metadata"] = json.loads(argv[argv.index("--metadata") + 1])
            for i, a in enumerate(argv):
                if a == "--add-label" and argv[i + 1] not in t["labels"]:
                    t["labels"].append(argv[i + 1])
                if a == "--remove-label" and argv[i + 1] in t["labels"]:
                    t["labels"].remove(argv[i + 1])
            return 0, "[]", ""
        if op == "create":
            self.n += 1
            tid = f"task-new{self.n}"
            labels = argv[argv.index("-l") + 1].split(",") if "-l" in argv else []
            self.issues[tid] = {"id": tid, "title": argv[2], "status": "open", "labels": labels,
                                "description": argv[argv.index("--description") + 1], "created_at": "2026-09-27T12:00:00Z"}
            self.created.append(tid)
            return 0, json.dumps({"id": tid}), ""
        if op == "close":
            self.issues[argv[2]]["status"] = "closed"
            return 0, "[]", ""
        raise AssertionError(argv)


class DesignFlow(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.proj = os.path.join(self.tmp, "proj")
        os.makedirs(os.path.join(self.proj, ".git"))
        self.facts = os.path.join(self.tmp, "FACTS.md")
        with open(self.facts, "w") as f:
            f.write("# facts\n\n**我的设计偏好（整理）**\n- 旧的\n\n**别的**\n- x\n")
        self.board = Board([issue("task-t26s", "Waiting 页重做：分不清轻重", "2026-09-27T10:00:00Z", status="in_progress", session="s1", project="kanban")])
        self.board.issues["task-t26s"]["description"] = "Waiting 的行太平"
        self.patches = [patch.object(T, "_sh", self.board), patch.object(flows, "_sh", self.board), patch.object(T, "D", None),
                        patch.object(flows, "D", None), patch.object(flows, "screenshot", lambda h, p: False),
                        patch.dict(os.environ, {"DISPATCH_FACTS_FILE": self.facts, "DISPATCH_DIR": os.path.join(self.tmp, "state"),
                                                "DISPATCH_HOME": os.path.join(self.tmp, "home")})]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()

    def fake_designer(self, readme="# Waiting\n\n推荐 A。\n\n## A: 按紧急度分段\n\n…\n\n## B: 一条时间线\n\n…\n\n## 诊断\n"):
        seen = {}

        def run(name, prompt, project=None, engine="", timeout_ms=0, auto=False):
            seen.update(name=name, prompt=prompt, project=project, engine=engine, auto=auto)
            out = os.path.join(project, "design", "waiting", "redesign")
            with open(os.path.join(out, "index.html"), "w") as f:
                f.write("<!doctype html><p>A | B</p>")
            with open(os.path.join(out, "README.md"), "w") as f:
                f.write(readme)
            return {"session": "claude-code:abc", "result_file": "/x/run.md"}
        return run, seen

    def test_design_delivers_and_waits_for_a_pick(self):
        run, seen = self.fake_designer()
        r = flows.design("task-t26s", name="waiting", project=self.proj, agent_run=run)
        self.assertEqual(seen["name"], "designer")
        self.assertTrue(seen["auto"])
        self.assertEqual(seen["engine"], "claude")
        self.assertIn("## 方向 A: <方向名>", seen["prompt"])
        self.assertIn(os.path.join(self.proj, "design", "waiting", "redesign"), seen["prompt"])
        self.assertEqual(r["options"], [{"key": "A", "title": "按紧急度分段"}, {"key": "B", "title": "一条时间线"}])
        t = self.board.issues["task-t26s"]
        self.assertIn("dispatch:decide", t["labels"])
        self.assertEqual(T.status_of(t), "waiting")
        self.assertEqual([d["label"] for d in T.meta(t)["deliverables"]], ["Prototype", "Design notes"])  # no preview.png here
        rows = W.decide_items([t])
        self.assertEqual(rows[0]["phrase"], "A: 按紧急度分段 / B: 一条时间线")
        self.assertEqual(W.decide_phrase([{"key": "A", "title": ""}, {"key": "B", "title": ""}]), "Pick a direction: A / B")
        self.assertEqual(rows[0]["actions"], ["pick", "open"])
        self.assertTrue(rows[0]["open"].endswith("redesign/index.html"))

    def test_the_delivery_pages_notes_stand_in_for_a_readme(self):
        # the designer now writes notes.md (delivery-page skill) and lets `dispatch deliver` make index.html
        def run(name, prompt, project=None, engine="", timeout_ms=0, auto=False):
            out = os.path.join(project, "design", "waiting", "redesign")
            with open(os.path.join(out, "index.html"), "w") as f:
                f.write('<!doctype html><meta name="generator" content="dispatch deliver"><p>page</p>')
            with open(os.path.join(out, "notes.md"), "w") as f:
                f.write("# Waiting\n\n- 推荐 B。\n\n## 方向 A: 按紧急度分段\n\n…\n\n## 方向 B: 一条时间线\n\n…\n")
            with open(os.path.join(out, "README.md"), "w") as f:
                f.write("# Old directions\n\n## A: 过时方向\n\n旧内容。\n\n## B: 另一旧稿\n")
            return {"session": "claude-code:abc", "result_file": "/x/run.md"}
        r = flows.design("task-t26s", name="waiting", project=self.proj, agent_run=run)
        self.assertEqual(r["options"], [{"key": "A", "title": "按紧急度分段"}, {"key": "B", "title": "一条时间线"}])
        t = self.board.issues["task-t26s"]
        self.assertTrue(T.meta(t)["flow"]["readme"].endswith("redesign/notes.md"))
        self.assertEqual([d["label"] for d in T.meta(t)["deliverables"]], ["Proposal"])
        registered = []
        with patch.object(flows, "D", SimpleNamespace(docs_register=lambda *args, **kw: registered.append(args),
                                                      phone_push=lambda *args, **kw: None)):
            flows.finish("task-t26s")
        self.assertTrue(registered[0][1].endswith("redesign/index.html"))

    def test_pick_records_the_preference_and_makes_the_implementation_task(self):
        run, _ = self.fake_designer()
        flows.design("task-t26s", name="waiting", project=self.proj, agent_run=run)
        with self.assertRaises(ValueError):
            flows.pick("task-t26s", "C")
        r = flows.pick("task-t26s", "a", "急的在上面")
        self.assertEqual(r["picked"], "A")
        impl = self.board.issues[r["impl"]["id"]]
        self.assertIn("方向 A「按紧急度分段」", impl["description"])
        self.assertIn("redesign/index.html", impl["description"])
        self.assertIn("project:kanban", impl["labels"])
        self.assertEqual(T.meta(impl)["follows"], "task-t26s")
        t = self.board.issues["task-t26s"]
        self.assertEqual(t["status"], "closed")
        self.assertNotIn("dispatch:decide", t["labels"])
        self.assertEqual(W.decide_items([t]), [])
        # the pick is a preference now: a Like of the picked direction with the reason as the words;
        # FACTS.md「我的设计偏好」is only where the old ones were imported from, never written
        import prefs
        (p,) = prefs.load()
        self.assertEqual((p["polarity"], p["area"], p["scope"], p["quote"], p["name"]), ("like", "design", "kanban", "急的在上面", "按紧急度分段"))
        self.assertIn("方向 A「按紧急度分段」", p["text"])
        self.assertTrue(p["part"].endswith("redesign/index.html#A"))
        self.assertEqual(r["preference"]["id"], p["id"])
        with open(self.facts) as f:
            self.assertEqual(f.read(), "# facts\n\n**我的设计偏好（整理）**\n- 旧的\n\n**别的**\n- x\n")
        with self.assertRaises(ValueError):
            flows.pick("task-t26s", "A")  # once only

    def test_designer_without_a_prototype_fails_the_flow(self):
        def run(*a, **k):
            return {"session": "", "result_file": ""}
        with self.assertRaises(ValueError):
            flows.design("task-t26s", name="waiting", project=self.proj, agent_run=run)
        self.assertEqual(T.meta(self.board.issues["task-t26s"])["flow"]["state"], "failed")

    def test_directions(self):
        self.assertEqual(flows.directions("## 方向 A：卡片\n### B. 列表\n## A: again\n## 诊断"), [{"key": "A", "title": "卡片"}, {"key": "B", "title": "列表"}])


class IdeShow(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.env = patch.dict(os.environ, {"DISPATCH_DIR": self.tmp})
        self.env.start()
        self.file = os.path.join(self.tmp, "index.html")
        with open(self.file, "w") as f:
            f.write("x")

    def tearDown(self):
        self.env.stop()

    def beat(self, at=None):
        os.makedirs(ide_show.ide_dir(), exist_ok=True)
        with open(ide_show.alive_path(), "w") as f:
            json.dump({"pid": os.getpid(), "at": at or time.time()}, f)

    def test_not_open_prints_the_path(self):
        r = ide_show.show(self.file)
        self.assertFalse(r["shown"])
        self.assertEqual(r["reason"], "not_running")
        self.beat(at=time.time() - 120)
        self.assertEqual(ide_show.show(self.file)["reason"], "not_running")

    def test_bad_targets(self):
        with self.assertRaises(ValueError):
            ide_show.show(os.path.join(self.tmp, "missing.md"))
        self.assertEqual(ide_show.resolve_target("https://x.dev/a"), ("url", "https://x.dev/a"))

    def test_the_window_answers(self):
        self.beat()

        def window():
            d = ide_show.requests_dir()
            for _ in range(100):
                names = [n for n in os.listdir(d) if n.endswith(".json")] if os.path.isdir(d) else []
                if names:
                    with open(os.path.join(d, names[0])) as fh:
                        req = json.load(fh)
                    os.remove(os.path.join(d, names[0]))
                    self.seen = req
                    with open(os.path.join(d, req["id"] + ".done"), "w") as f:
                        json.dump({"ok": True}, f)
                    return
                time.sleep(0.02)
        th = threading.Thread(target=window)
        th.start()
        r = ide_show.show(self.file, wait=3)
        th.join()
        self.assertTrue(r["shown"])
        self.assertEqual(self.seen["target"], self.file)
        self.assertEqual(os.listdir(ide_show.requests_dir()), [])

    def test_no_answer_takes_the_request_back(self):
        self.beat()
        r = ide_show.show(self.file, wait=0.2)
        self.assertEqual(r["reason"], "no_answer")
        self.assertEqual(os.listdir(ide_show.requests_dir()), [])


class DeliverShow(unittest.TestCase):
    def test_deliver_show_opens_the_file(self):
        tmp = tempfile.mkdtemp()
        f = os.path.join(tmp, "README.md")
        with open(f, "w") as fh:
            fh.write("# x")
        board = Board([issue("task-k1", "交付在右栏", "2026-09-27T10:00:00Z", status="in_progress")])
        calls = []
        a = SimpleNamespace(task="task-k1", url=None, file=f, draft=None, commit=None, label="", show=True, session="")
        with patch.object(T, "_sh", board), patch.object(T, "D", None), patch.object(ide_show, "show", lambda t, session="", task="": calls.append((t, task)) or {"shown": True, "message": "Opened"}):
            row = T.do_deliver(a)
        # the Docs reader names the task on its second line; the deliverable is labelled with the title
        self.assertEqual(calls, [(os.path.abspath(f), "task-k1")])
        self.assertEqual(row["deliverables"][0]["label"], "x")
        self.assertTrue(row["shown"]["shown"])


class Annotate(unittest.TestCase):
    @unittest.skipUnless(__import__("importlib").util.find_spec("PIL"), "needs Pillow (the system Python has none)")
    def test_boxes_and_notes(self):
        import annotate as A
        from PIL import Image
        tmp = tempfile.mkdtemp()
        src, out = os.path.join(tmp, "s.png"), os.path.join(tmp, "o.png")
        Image.new("RGB", (800, 500), "white").save(src)
        r = A.annotate(src, out, [A.parse_box("10,10,200,80"), A.parse_box("300, 200, 100, 50")], ["Docs · right panel · click a row"])
        self.assertEqual(r["boxes"], 2)
        with Image.open(out) as im:
            self.assertEqual(im.size[0], 800)
            self.assertGreater(im.size[1], 500)
            self.assertEqual(im.getpixel((110, 10))[:3], A.RED)  # the first box's top edge
        with self.assertRaises(ValueError):
            A.parse_box("1,2,3")


if __name__ == "__main__":
    unittest.main()
