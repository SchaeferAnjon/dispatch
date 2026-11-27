# -*- coding: utf-8 -*-
"""docs_view.py: the Docs tab's list (groups, one row per document, tasks, where) and the
registrations `docs add --task`, `docs seen`, "Remove from Docs" and `task deliver` write."""
import copy
import io, json, os, shutil, subprocess, sys, tempfile, time, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import docs_view as V
import tasks_view as T
from test_dispatch import dispatch


def issue(tid, title, deliverables=(), status="open", session="s1"):
    return {"id": tid, "title": title, "status": status, "labels": ["project:kanban", f"session-origin:{session}"],
            "metadata": {"deliverables": list(deliverables)}}


class Titles(unittest.TestCase):
    def test_bookkeeping_brackets_go(self):
        self.assertEqual(V.display_title("任务模块真机截图（task-ha7k，2026-09-27）"), "任务模块真机截图")
        self.assertEqual(V.display_title("Projects · Timeline v2 样稿（task-aenb）"), "Projects · Timeline v2 样稿")
        self.assertEqual(V.display_title("~/.dispatch 目录（A 组，2026-09-27）"), "~/.dispatch 目录")
        self.assertEqual(V.display_title("编辑器（2026-09-27）"), "编辑器")
        # inline Markdown reads as its words
        self.assertEqual(V.display_title("OpenCode 接进 Agents 窗口：用 `opencode acp`"), "OpenCode 接进 Agents 窗口：用 opencode acp")
        self.assertEqual(V.display_title("**Docs** 和 [Tasks](x.md) 的 *说明*（task-ab12）"), "Docs 和 Tasks 的 说明")
        self.assertEqual(V.display_title("a*b*c 2 * 3"), "a*b*c 2 * 3")

    def test_brackets_that_say_something_stay(self):
        self.assertEqual(V.display_title("任务模型定稿（2026-09-27，和用户讨论后）"), "任务模型定稿（2026-09-27，和用户讨论后）")
        self.assertEqual(V.display_title("一期 D：换供应商（CLI 部分）"), "一期 D：换供应商（CLI 部分）")
        self.assertEqual(V.display_title("（task-ab12）"), "（task-ab12）")  # nothing would be left

    def test_groups(self):
        g = lambda **r: V.group_of(r)
        self.assertEqual(g(kind="交付", path="/p/design/x/README.md", title="X"), "delivered")
        self.assertEqual(g(kind="设计", path="/p/design/engines/impl/README.md", title="引擎"), "delivered")
        self.assertEqual(g(kind="设计", path="/p/design/x/README.md", title="Projects 真机截图"), "delivered")
        self.assertEqual(g(kind="调研", path="/p/design/x/README.md", title="X"), "research")
        self.assertEqual(g(kind="设计", path="/p/design/x/README.md", title="上手审读"), "research")
        self.assertEqual(g(kind="设计", path="/p/design/task-model/DECISIONS.md", title="定稿"), "notes")
        self.assertEqual(g(kind="设计", path="/p/design/x/README.md", title="Tasks 页签重设计"), "design")
        self.assertEqual(g(kind="文档", path="/p/docs/index.html", title="首页"), "notes")


class Listing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.home = Path(os.path.realpath(self.tmp.name)) / "Users" / "me"
        self.root = self.home / "Projects" / "kanban"
        V.D = dispatch

    def write(self, rel, text="# Title\n"):
        p = self.root / rel; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(text); return p

    def rows(self, registered=(), issues=(), session=""):
        scanned = dispatch.docs_scan([str(self.root)])
        reg = dispatch.docs_registered_rows(dispatch.docs_entries_parse(json.dumps(list(registered))))
        with patch.dict(os.environ, {"HOME": str(self.home)}), patch.object(os.path, "expanduser", lambda p: p.replace("~", str(self.home), 1)):
            rows = V.fold(dispatch.docs_merge(scanned, reg))
            V.link_tasks(rows, list(issues), T)
            return V.decorate(rows, session)

    def test_readme_and_its_page_are_one_row(self):
        readme = self.write("design/tabs/README.md", "# Tabs redesign\n")
        page = self.write("design/tabs/index.html", "<title>Tabs</title>")
        self.write("design/solo/index.html", "<title>Solo page</title>")
        rows, counts = self.rows()
        by = {Path(r["path"]).parent.name: r for r in rows}
        self.assertEqual(sorted(by), ["solo", "tabs"])
        self.assertEqual(by["tabs"]["path"], str(readme))
        self.assertEqual(by["tabs"]["attachments"], [{"path": str(page), "title": "Tabs", "kind": "prototype"}])
        self.assertEqual(by["solo"]["attachments"], [])
        self.assertEqual(sum(counts.values()), 2)

    def test_delivery_page_and_its_sources_are_one_row(self):
        page = self.write("design/deliv/impl/index.html", '<meta name="generator" content="dispatch deliver">\n<title>交付页</title>')
        notes = self.write("design/deliv/impl/notes.md", "# 交付页\n")
        self.write("design/deliv/impl/review.md", "# 独立复审\n")
        rows, counts = self.rows()
        by = {Path(r["path"]).name: r for r in rows}
        self.assertEqual(sorted(by), ["index.html", "review.md"])
        self.assertEqual(by["index.html"]["path"], str(page))
        self.assertEqual(by["index.html"]["sources"], [str(notes)])
        self.assertEqual(by["index.html"]["group"], "delivered")
        self.assertEqual(by["review.md"]["path"], str(self.root / "design/deliv/impl/review.md"))
        self.assertEqual(by["review.md"]["group"], "research")
        self.assertEqual(counts["delivered"], 1)

    def test_every_row_sits_on_one_shelf_of_the_picker(self):
        # the filter of the build the mini still runs (2026-10-01): reports, briefs and handoffs are back,
        # under Notes; reviews under Reviews; test scenarios and a page's side files are no rows
        self.write("design/deliv/impl/index.html", '<meta name="generator" content="dispatch deliver">\n<title>交付页</title>')
        self.write("design/deliv/impl/review.md", "# 独立复审\n")
        self.write("design/tabs/redesign/proposal.html", "<title>Tabs 方案</title>")
        self.write("design/tabs/redesign/qa.md", "# 验证记录\n")
        self.write("design/tabs/redesign/proto-b.html", "<title>B</title>")
        self.write("design/waiting/redesign/README.md", "# Waiting for you 重设计\n")
        self.write("design/handoff/reports/x-report.md", "# x 组报告\n")
        self.write("design/handoff/briefs/x.md", "# 任务书：x\n")
        self.write("design/handoff/briefs/x-fix.md", "# x-fix：按 designer 复审改三处\n")
        self.write("design/task-model/DECISIONS.md", "# 定稿\n")
        self.write("design/e2e/projects/README.md", "# Projects 页\n")
        self.write("docs/index.html", "<title>Docs home</title>")
        self.write("docs/protocol.md", "# Protocol\n")
        rows, _ = self.rows([{"id": "h", "path": str(self.write("h/1.md", "# Context handoff\n")), "kind": "handoff"}])
        shelves = {r["path"].replace(str(self.root) + "/", ""): V.shelf(r) for r in rows}
        self.assertEqual(shelves, {
            "design/deliv/impl/index.html": "delivered",
            "design/deliv/impl/review.md": "research",
            "design/tabs/redesign/proposal.html": "design",
            "design/tabs/redesign/qa.md": None,
            "design/tabs/redesign/proto-b.html": "design",
            "design/waiting/redesign/README.md": "design",
            "design/handoff/reports/x-report.md": "notes",
            "design/handoff/briefs/x.md": "notes",
            "design/handoff/briefs/x-fix.md": "notes",
            "docs/index.html": "notes",
            "docs/protocol.md": "notes",
            "design/task-model/DECISIONS.md": "notes",
            "design/e2e/projects/README.md": None,
            "h/1.md": "notes",
        })

    def test_design_pages_are_listed_and_an_impl_page_is_a_delivery(self):
        # user 2026-10-09: the prototypes next to a proposal (proto-a.html, graphs.html) were nowhere in Docs;
        # a page `dispatch deliver` made for what was built is a delivery wherever it sits
        self.write("design/frenzy/index.html", '<meta name="generator" content="dispatch deliver">\n<meta name="dispatch-delivery" content="proposal">\n<title>Turbo</title>')
        self.write("design/frenzy/notes.md", "# Turbo\n")
        self.write("design/frenzy/proto-a.html", "<title>Turbo · A</title>")
        self.write("design/frenzy/graphs.html", "<title>Graphs</title>")
        self.write("design/frenzy/impl2/index.html", '<meta name="generator" content="dispatch deliver">\n<meta name="dispatch-delivery" content="impl">\n<title>Turbo built</title>')
        rows, counts = self.list_view()
        by = {r["path"].replace(str(self.root) + "/", ""): r["group"] for r in rows}
        self.assertEqual(by, {"design/frenzy/index.html": "design", "design/frenzy/proto-a.html": "design",
                              "design/frenzy/graphs.html": "design", "design/frenzy/impl2/index.html": "delivered"})
        self.assertEqual(counts["design"], 3)

    def test_rows_carry_their_sessions_for_a_cached_this_session(self):
        page = self.write("design/deliv/impl/index.html", '<meta name="generator" content="dispatch deliver">\n<title>交付页</title>')
        other = self.write("design/x/README.md", "# X 设计\n")
        reg = [{"id": "p", "path": str(page), "kind": "交付", "session": "claude-code:/abc12345-1111", "tasks": ["task-a"]}]
        rows, _ = self.list_view(reg, [issue("task-a", "A", session="def67890-2222")], session="abc12345-1111")
        by = {r["path"]: r for r in rows}
        self.assertEqual(sorted(by[str(page)]["sessions"]), ["abc12345-1111", "def67890-2222"])
        self.assertTrue(by[str(page)]["in_session"])
        self.assertEqual(by[str(other)]["sessions"], [])
        self.assertFalse(by[str(other)]["in_session"])

    def list_view(self, registered=(), issues=(), **kw):
        scanned = dispatch.docs_scan([str(self.root)])
        reg = dispatch.docs_registered_rows(dispatch.docs_entries_parse(json.dumps(list(registered))))
        with patch.dict(os.environ, {"HOME": str(self.home)}), patch.object(os.path, "expanduser", lambda p: p.replace("~", str(self.home), 1)), \
                patch.object(V.D, "docs_list", side_effect=lambda *a, **k: copy.deepcopy(dispatch.docs_merge(scanned, reg))):
            return V.list_view("kanban", [str(self.root)], issues=list(issues), **kw)

    def test_rows_left_out_of_the_list_still_reach_the_reader_with_their_task(self):
        # a test scenario is no row of the list, but opened from elsewhere the reader still says which task it is for
        self.write("design/deliv/impl/index.html", '<meta name="generator" content="dispatch deliver">\n<title>交付页</title>')
        e2e = str(self.write("design/e2e/x/README.md", "# Scenario\n"))
        h = str(self.write("h/1.md", "# Context handoff\n"))
        reg = [{"id": "h", "path": h, "kind": "handoff", "tasks": ["task-h1"]}, {"id": "e", "path": e2e, "tasks": ["task-h1"]}]
        issues = [{"id": "task-h1", "title": "Hand the context over", "status": "in_progress"}]
        rows, counts, reader = self.list_view(reg, issues, with_reader=True)
        plain = self.list_view(reg, issues)
        self.assertEqual(sorted(Path(r["path"]).name for r in rows), ["1.md", "index.html"])
        self.assertEqual({r["group"] for r in rows}, {"delivered", "notes"})
        self.assertEqual(len(plain), 2)
        self.assertEqual(counts["delivered"] + counts["notes"], 2)
        self.assertEqual([r["path"] for r in reader], [e2e])
        self.assertEqual([t["id"] for t in reader[0]["tasks"]], ["task-h1"])

    def test_picker_today_and_one_shelf(self):
        old = self.write("design/old/impl/index.html", '<meta name="generator" content="dispatch deliver">\n<title>Old delivery</title>')
        self.write("design/new/impl/index.html", '<meta name="generator" content="dispatch deliver">\n<title>New delivery</title>')
        self.write("design/task-model/DECISIONS.md", "# 定稿\n")
        self.write("design/x/review.md", "# 复审\n")
        now = time.time()
        os.utime(old, (now - 3 * 86400, now - 3 * 86400))
        rows, counts = self.list_view()
        self.assertEqual(counts, {"delivered": 2, "design": 0, "research": 1, "notes": 1})
        self.assertEqual(sum(r["today"] for r in rows), 3)
        names = lambda rows: sorted(r["display_title"] for r in rows)
        today, _ = self.list_view(which="today")
        self.assertEqual(names(today), sorted(["New delivery", "定稿", "复审"]))
        self.assertTrue(all(r["today"] for r in today))
        self.assertEqual(names(self.list_view(which="delivered")[0]), ["New delivery", "Old delivery"])
        self.assertEqual(names(self.list_view(which="research")[0]), ["复审"])
        self.assertEqual(names(self.list_view(which="notes")[0]), ["定稿"])
        self.assertEqual(len(self.list_view(which="all")[0]), 4)
        with self.assertRaises(ValueError):
            self.list_view(which="yesterday")

    def test_today_starts_at_local_midnight(self):
        lt = time.localtime()
        midnight = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
        self.assertTrue(V.is_today({"mtime": midnight + 1}))
        self.assertFalse(V.is_today({"mtime": midnight - 1}))
        self.assertTrue(V.is_today({"mtime": midnight - 3600, "delivered_at": midnight + 60}))

    def test_delivery_page_folds_a_readme_with_another_title(self):
        self.write("design/deliv2/impl/index.html", '<meta name="generator" content="dispatch deliver">\n<title>交付页</title>')
        readme = self.write("design/deliv2/impl/README.md", "# 源数据\n")
        rows, _ = self.rows()
        self.assertEqual([Path(r["path"]).name for r in rows], ["index.html"])
        self.assertEqual(rows[0]["sources"], [str(readme)])

    def test_copies_gone_files_and_hidden_are_not_listed(self):
        a = self.write("design/a/README.md", "# A\n")
        other = f"/Users/someone/Projects/kanban/design/a/README.md"
        wt = self.write(".claude/worktrees/agent-x/design/a/README.md", "# A copy\n")
        gone = str(self.root / "design/gone/README.md")
        b = self.write("design/b/README.md", "# B\n")
        reg = [{"id": "o", "path": other, "title": "A (登记)", "kind": "交付", "tasks": ["task-a1"]},
               {"id": "w", "path": str(wt), "title": "", "kind": "设计"},
               {"id": "g", "path": gone, "title": "Gone", "kind": "设计"},
               {"id": dispatch.docs_id(str(b)), "path": str(b), "hidden": True}]
        rows, _ = self.rows(reg, [issue("task-a1", "Build A")])
        self.assertEqual([r["path"] for r in rows], [str(a)])
        # the copy's registration carries over to the local file
        self.assertEqual(rows[0]["kind"], "交付"); self.assertEqual(rows[0]["group"], "delivered")
        self.assertEqual([t["id"] for t in rows[0]["tasks"]], ["task-a1"])

    def test_tasks_where_session_and_unseen(self):
        readme = self.write("design/eng/impl/README.md", "# 引擎和更新：真机截图（task-aa11）\n")
        (self.root / "design/eng/impl/00-where-is-what.png").write_bytes(b"\x89PNG\r\n")
        (self.root / "design/eng/impl/00-where-is-what.json").write_text(json.dumps(
            {"image": "00-where-is-what.png", "size": [100, 200], "items": [{"n": 1, "box": [1, 2, 3, 4], "what": "版本", "where": "卡片", "how": "点"}, {"n": 2, "box": "bad"}]}))
        now = int(time.time())
        issues = [issue("task-aa11", "引擎版本检查", [{"kind": "file", "ref": str(readme), "at": now - 60}], session="sess-1"),
                  issue("task-bb22", "OpenCode", [{"kind": "file", "ref": str(readme.parent), "at": now - 3600}], status="closed")]
        rows, counts = self.rows(issues=issues, session="claude:/sess-1")
        r = rows[0]
        self.assertEqual(counts["delivered"], 1)
        self.assertEqual(r["display_title"], "引擎和更新：真机截图")
        self.assertEqual([t["id"] for t in r["tasks"]], ["task-aa11", "task-bb22"])  # newest first
        self.assertEqual(r["tasks"][1]["status"], "done")
        self.assertEqual(r["delivered_at"], now - 60)
        self.assertTrue(r["unseen"]); self.assertTrue(r["in_session"])
        self.assertEqual(r["where"]["image"], str(self.root / "design/eng/impl/00-where-is-what.png"))
        self.assertTrue(r["where"]["drawn"])  # dispatch annotate's figure: the boxes are in the picture
        self.assertEqual(r["where"]["items"], [{"n": 1, "box": [1, 2, 3, 4], "what": "版本", "where": "卡片", "how": "点"}])
        rows, _ = self.rows(issues=issues, session="other")
        self.assertFalse(rows[0]["in_session"])

    def test_delivery_page_where_on_plain_screenshots(self):
        d = self.root / "design/deliv/impl"
        self.write("design/deliv/impl/README.md", "# 交付页\n")
        (d / "01-list.png").write_bytes(b"\x89PNG\r\n"); (d / "02-open.png").write_bytes(b"\x89PNG\r\n")
        (d / "00-where.json").write_text(json.dumps({"image": "01-list.png", "size": [10, 10], "items": [
            {"n": 1, "box": [1, 1, 2, 2], "what": "a"}, {"n": 2, "box": [3, 3, 2, 2], "what": "b", "image": "02-open.png"}]}))
        w = V.where_of(str(d / "README.md"))
        self.assertFalse(w["drawn"])
        self.assertNotIn("image", w["items"][0])
        self.assertEqual(w["items"][1]["image"], str(d / "02-open.png"))
        # made from e2e marks: no picture of its own, every item on its frame
        (d / "00-where.json").write_text(json.dumps({"from": "steps.json", "items": [
            {"n": 1, "image": "02-open.png", "size": [20, 30], "box": [1, 1, 2, 2], "what": "a"},
            {"n": 2, "image": "01-list.png", "size": [10, 10], "box": [3, 3, 2, 2], "what": "b"}]}))
        w = V.where_of(str(d / "README.md"))
        self.assertEqual((w["image"], w["size"]), (str(d / "02-open.png"), [20, 30]))
        self.assertNotIn("image", w["items"][0]); self.assertEqual(w["items"][1]["image"], str(d / "01-list.png"))
        # the marks JSON's own spelling: marks instead of items
        (d / "00-where.json").write_text(json.dumps({"v": 1, "image": "01-list.png", "size": [10, 10], "scale": 2, "marks": [
            {"n": 1, "box": [1, 1, 2, 2], "color": "red", "what": "a"}]}))
        w = V.where_of(str(d / "README.md"))
        self.assertEqual([(i["n"], i["what"]) for i in w["items"]], [(1, "a")])


class Registering(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = {}
        V.D = dispatch
        p1 = patch.object(dispatch, "docs_registered", side_effect=lambda p: dispatch.docs_entries_parse(json.dumps(self.store.get(p, []))))
        p2 = patch.object(dispatch, "docs_save", side_effect=lambda p, e, keep="": self.store.__setitem__(p, json.loads(json.dumps(e))))
        p1.start(); p2.start(); self.addCleanup(p1.stop); self.addCleanup(p2.stop)

    def write(self, rel, text="# Title\n"):
        p = self.root / rel; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(text); return p

    def test_add_with_tasks_keeps_kind_and_adds_tasks(self):
        p = self.write("design/x/README.md", "# X 说明\n")
        V.register("kanban", str(p), kind="设计", tasks=["task-a1"], session="s-1")
        V.register("kanban", str(p), tasks=["task-b2", "task-a1"], session="s-2")
        e = self.store["kanban"][0]
        self.assertEqual(e["kind"], "设计"); self.assertEqual(e["tasks"], ["task-a1", "task-b2"])
        self.assertEqual(e["session"], "s-1"); self.assertEqual(e["title"], "X 说明")

    def test_deliver_registers_as_delivered_once(self):
        p = self.write("design/y/impl/README.md", "# Y\n")
        V.on_deliver("kanban", "task-a1", str(p), session="s-9")
        e = self.store["kanban"][0]
        self.assertEqual((e["kind"], e["tasks"], e["session"]), ("交付", ["task-a1"], "s-9"))
        self.assertTrue(e["delivered_at"])
        self.assertIsNone(V.on_deliver("kanban", "task-a1", str(self.write("design/y/shot.png")), ""))

    def test_registering_a_source_folds_into_its_page(self):
        self.write("design/deliv/impl/notes.md", "# 交付页\n")
        page = self.write("design/deliv/impl/index.html", '<meta name="generator" content="dispatch deliver">\n<title>交付页</title>')
        notes = str(self.root / "design/deliv/impl/notes.md")
        V.register("kanban", notes, tasks=["task-a1"], session="s-1")
        entries = self.store["kanban"]
        self.assertEqual(len(entries), 1)
        self.assertEqual((entries[0]["path"], entries[0]["kind"]), (str(page), "交付"))
        self.assertEqual(entries[0]["sources"], [notes])
        self.assertEqual(entries[0]["tasks"], ["task-a1"])

    def test_registering_the_page_absorbs_a_registered_source(self):
        notes = self.write("design/deliv/impl/notes.md", "# 交付页\n")
        V.register("kanban", str(notes), tasks=["task-a1"], session="s-1")
        self.assertEqual(self.store["kanban"][0]["path"], str(notes))
        page = self.write("design/deliv/impl/index.html", '<meta name="generator" content="dispatch deliver">\n<title>交付页</title>')
        V.register("kanban", str(page), kind="交付", tasks=["task-b2"])
        entries = self.store["kanban"]
        self.assertEqual(len(entries), 1)
        self.assertEqual((entries[0]["path"], entries[0]["kind"]), (str(page), "交付"))
        self.assertEqual(sorted(entries[0]["tasks"]), ["task-a1", "task-b2"])
        self.assertEqual(entries[0]["sources"], [str(notes)])
        self.assertEqual(entries[0]["session"], "s-1")

    def test_registering_an_unrelated_md_stays_its_own(self):
        self.write("design/deliv/impl/index.html", '<meta name="generator" content="dispatch deliver">\n<title>交付页</title>')
        self.write("design/deliv/impl/notes.md", "# 交付页\n")
        plan = self.write("design/deliv/impl/plan.md", "# 别的东西\n")
        V.register("kanban", str(plan))
        entries = self.store["kanban"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["path"], str(plan))

    def test_remove_takes_the_delivery_page_and_its_sources(self):
        self.write("design/deliv/impl/notes.md", "# 交付页\n")
        page = self.write("design/deliv/impl/index.html", '<meta name="generator" content="dispatch deliver">\n<title>交付页</title>')
        notes = str(self.root / "design/deliv/impl/notes.md")
        row = V.register("kanban", notes)
        rows = [{"id": row["id"], "path": str(page), "sources": [notes]}]
        self.assertTrue(V.remove("kanban", row["id"], rows))
        hidden = {e["path"] for e in self.store["kanban"] if e.get("hidden")}
        self.assertEqual(hidden, {str(page), notes})

    def test_seen_and_remove(self):
        p = self.write("design/z/README.md", "# Z\n")
        row = V.register("kanban", str(p))
        self.assertTrue(V.mark_seen("kanban", row["id"], now=123))
        self.assertEqual(self.store["kanban"][0]["seen_at"], 123)
        self.assertFalse(V.mark_seen("kanban", "nope"))
        rows = [{"id": row["id"], "path": str(p)}]
        self.assertTrue(V.remove("kanban", row["id"], rows))
        self.assertEqual(self.store["kanban"], [{"id": row["id"], "path": str(p), "title": "", "kind": "", "added_at": self.store["kanban"][0]["added_at"], "hidden": True}])
        # added again, it is back
        V.register("kanban", str(p))
        self.assertNotIn("hidden", self.store["kanban"][0])
        self.assertFalse(V.remove("kanban", "missing", rows))

    def test_remove_takes_the_page_next_to_a_readme(self):
        p = self.write("design/w/README.md", "# W\n")
        page = self.write("design/w/index.html", "<title>W</title>")
        row = V.register("kanban", str(p))
        self.assertTrue(V.remove("kanban", row["id"], [{"id": row["id"], "path": str(p)}]))
        hidden = {e["path"] for e in self.store["kanban"] if e.get("hidden")}
        self.assertEqual(hidden, {str(p), str(page)})


class DeliverLabel(unittest.TestCase):
    def test_label_is_the_document_title(self):
        with tempfile.TemporaryDirectory() as d:
            md = Path(d) / "README.md"; md.write_text("# 引擎和更新：真机截图（task-ab12）\n")
            page = Path(d) / "index.html"; page.write_text("<title>原型</title>")
            png = Path(d) / "shot.png"; png.write_bytes(b"x")
            self.assertEqual(T.doc_label(str(md)), "引擎和更新：真机截图")
            self.assertEqual(T.doc_label(str(page)), "原型")
            self.assertEqual(T.doc_label(d), "引擎和更新：真机截图")
            self.assertEqual(T.doc_label(str(png)), "shot.png")


class Annotate(unittest.TestCase):
    def test_json_next_to_the_picture_and_boxes_only(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("no Pillow")
        import annotate
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "shot.png"); Image.new("RGB", (400, 300), "white").save(src)
            out = os.path.join(d, "00-where-is-what.png")
            try:
                r = annotate.annotate(src, out, [(10, 20, 100, 50)], ["引擎版本 · 卡片第一行 · 点 Codex"], boxes_only=True)
            except ValueError as e:  # no Chinese font on this machine
                self.skipTest(str(e))
            self.assertEqual(Image.open(out).size, (400, 300))  # no lines under it
            data = json.load(open(r["json"]))
            self.assertEqual(data, {"image": "00-where-is-what.png", "size": [400, 300],
                                    "items": [{"n": 1, "box": [10, 20, 100, 50], "what": "引擎版本", "where": "卡片第一行", "how": "点 Codex"}]})
            r = annotate.annotate(src, out, [(10, 20, 100, 50)], ["a · b · c"])
            self.assertGreater(Image.open(out).size[1], 300)
            self.assertEqual(json.load(open(r["json"]))["size"], [400, Image.open(out).size[1]])

    def test_no_font_is_an_error(self):
        import annotate
        with self.assertRaises(ValueError):
            annotate.font_path(("/nowhere/*.ttc",))


class DocsFit(unittest.TestCase):
    """dispatch.docs_fit: what goes when a project's Docs list would not fit in one bd memory (task-w97qw)."""

    def entry(self, n, kind="交付", hidden=False, path=None):
        e = {"id": "id%d" % n, "path": path or "/nowhere/%d.md" % n, "title": "x" * 200, "kind": kind, "added_at": float(n)}
        if hidden:
            e["hidden"] = True
        return e

    def test_order_of_what_goes(self):
        with tempfile.NamedTemporaryFile(suffix=".md") as live:
            rows = [self.entry(1, hidden=True, path=live.name), self.entry(2), self.entry(3, "handoff"), self.entry(4, hidden=True),
                    self.entry(5, "handoff"), self.entry(6)]
            size = lambda r: len(dispatch._docs_json(r).encode())
            self.assertIs(dispatch.docs_fit(rows, limit=size(rows)), rows)
            got = lambda limit, keep="": [e["id"] for e in dispatch.docs_fit(rows, keep, limit)]
            # a tombstone of a file that is gone, then the oldest handoff, then the newer one, then other documents
            self.assertEqual(got(size(rows) - 1), ["id1", "id2", "id3", "id5", "id6"])
            self.assertEqual(got(size(rows[:2] + rows[4:])), ["id1", "id2", "id5", "id6"])
            self.assertEqual(got(size(rows[:2] + rows[5:])), ["id1", "id2", "id6"])
            self.assertEqual(got(size(rows[:1] + rows[5:])), ["id1", "id6"])
            # the tombstone of a file still there goes last; the entry just registered never goes
            self.assertEqual(got(size(rows[:1])), ["id1"])
            self.assertEqual(got(1, keep="id3"), ["id3"])
            self.assertLessEqual(size(dispatch.docs_fit(rows, limit=size(rows) // 2)), size(rows) // 2)

    def test_a_board_entry_that_is_too_large_says_which_and_what_to_do(self):
        bd_says = "Error: storing memory: set config kv.memory.dispatch-x: Error 1105: string '" + "y" * 70000 + "' is too large for column 'value'"
        err = io.StringIO()
        with patch.object(dispatch, "sh", return_value=(1, "", bd_says)), patch("sys.stderr", err), patch.object(dispatch.L, "t", side_effect=lambda en, zh: en):
            with self.assertRaises(SystemExit):
                dispatch.wiki_store("dispatch-x", "y" * 70000)
        msg = err.getvalue()
        self.assertIn("dispatch-x", msg); self.assertIn("70,000 bytes", msg); self.assertIn("65,535", msg)
        self.assertLess(len(msg), 600)


BD = shutil.which("bd")


@unittest.skipUnless(BD and os.name == "posix", "needs bd")
class FullDocsListOnARealBoard(unittest.TestCase):
    """A project's Docs list is one bd memory, and bd keeps a memory in a Dolt column that takes 65,535 bytes. On the
    other Mac (2026-11-24/26) canvas-notes reached 65,535 bytes after 188 deliveries and handoffs, and from then on
    every `handoff write` and `task deliver` failed with "Error 1105: string '…' is too large for column 'value'"
    (task-w97qw). A real embedded board in a temp folder, so the limit is bd's own and not a copy of it."""

    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="ddocs-")
        board, home = os.path.join(cls.root, "board"), os.path.join(cls.root, "home")
        cls.folder = os.path.join(home, "Projects", "notes")
        os.makedirs(board); os.makedirs(cls.folder)
        cls.env = {"HOME": home, "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "DISPATCH_DIR": os.path.join(cls.root, "dd"),
                   "DISPATCH_HOME": os.path.join(cls.root, "dh"), "BEADS_DIR": os.path.join(board, ".beads"),
                   "DISPATCH_BOARD_SERVICE": "0", "PYTHONDONTWRITEBYTECODE": "1", "DISPATCH_LANG": "en"}
        r = subprocess.run([BD, "init", "--prefix", "task", "--non-interactive", "--skip-hooks", "--quiet"], cwd=board, env=cls.env,
                           capture_output=True, text=True, timeout=120)
        assert r.returncode == 0, r.stderr
        subprocess.run(["git", "init", "-q"], cwd=cls.folder, env=cls.env, check=True, timeout=30)
        cls.cli("projects-view", "add", cls.folder, "--name", "notes", "--json")
        cls.task = cls.cli("begin", "Ship the notes app", "--force", "-P", "notes", "-d", "a task with a long Docs list", "--json")["id"]

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, True)

    @classmethod
    def run_cli(cls, *args, stdin=None):
        return subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), *args],
                              env=cls.env, cwd=cls.folder, input=stdin, capture_output=True, text=True, timeout=300)

    @classmethod
    def cli(cls, *args):
        r = cls.run_cli(*args)
        assert r.returncode == 0, (args, r.stdout, r.stderr)
        out = r.stdout.strip()
        return json.loads(out[out.find("{"):])

    def stored(self):
        r = subprocess.run([BD, "memories", "--json"], env=self.env, cwd=self.root, capture_output=True, text=True, timeout=120)
        raw = json.loads(r.stdout[r.stdout.find("{"):])["dispatch-docs-notes"]
        return raw, json.loads(raw)

    def fill(self):
        """The list as the other Mac had it: just under the limit, mostly handoffs and deliveries of old tasks."""
        rows, n = [], 0
        while len(json.dumps(rows, ensure_ascii=False, sort_keys=True).encode()) < 65000:
            kind = "handoff" if n % 2 else "交付"
            path = os.path.join(self.root, "old", f"{n:04d}.md")
            rows.append({"id": "%016x" % n, "path": path, "title": "Context handoff: 第二轮：梦游、全局速记、搜索删除 %d" % n,
                         "kind": kind, "added_at": 1790000000 + n, "tasks": ["task-old%02d" % (n % 50)],
                         "session": "claude-code:f580257b-5baf-4082-9cda-93713adce2e3"})
            n += 1
        r = subprocess.run([BD, "remember", json.dumps(rows, ensure_ascii=False, sort_keys=True), "--key", "dispatch-docs-notes"],
                           env=self.env, cwd=self.root, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        return rows

    def test_a_handoff_and_a_delivery_still_save_when_the_list_is_full(self):
        old = self.fill()
        r = self.run_cli("handoff", "write", self.task, "--session", "claude-code:abc", "--stdin", "--json",
                         stdin=json.dumps({"goal": "Ship the notes app", "completed": ["wrote the list view, commit a1b2c3d"],
                                           "next": "run the tests", "pitfalls": "none"}))
        self.assertEqual(r.returncode, 0, r.stderr[-600:])
        self.assertNotIn("1105", r.stderr)
        raw, rows = self.stored()
        self.assertLessEqual(len(raw.encode()), dispatch.DOCS_MAX_BYTES)
        new = [e for e in rows if self.task in (e.get("tasks") or [])]
        self.assertEqual([e["kind"] for e in new], ["handoff"])
        # the oldest handoffs made room; every delivery and the newest handoffs stay
        kept = {e["id"] for e in rows}
        gone = [e for e in old if e["id"] not in kept]
        self.assertTrue(gone)
        self.assertEqual({e["kind"] for e in gone}, {"handoff"})
        self.assertEqual(max(e["added_at"] for e in gone) < min(e["added_at"] for e in rows if e["kind"] == "handoff"), True)
        note = os.path.join(self.folder, "README.md")
        open(note, "w").write("# Notes\n")
        self.cli("docs", "add", "notes", note, "--task", self.task, "--json")
        raw, rows = self.stored()
        self.assertLessEqual(len(raw.encode()), dispatch.DOCS_MAX_BYTES)
        self.assertIn(note, [e["path"] for e in rows])


class ShowRequest(unittest.TestCase):
    def test_task_goes_into_the_request(self):
        import ide_show
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {"DISPATCH_DIR": d}):
            f = os.path.join(d, "doc.md"); open(f, "w").write("# D\n")
            os.makedirs(os.path.join(d, "ide"))
            json.dump({"pid": os.getpid(), "at": time.time()}, open(os.path.join(d, "ide", "agents-window.json"), "w"))
            seen = {}

            def sleep(_):
                req = [n for n in os.listdir(os.path.join(d, "ide", "requests")) if n.endswith(".json")]
                if req and not seen:
                    seen.update(json.load(open(os.path.join(d, "ide", "requests", req[0]))))
                    open(os.path.join(d, "ide", "requests", seen["id"] + ".done"), "w").write('{"ok": true}')
            r = ide_show.show(f, task="task-ab12", sleep=sleep, wait=2)
            self.assertTrue(r["shown"]); self.assertEqual(seen["task"], "task-ab12"); self.assertEqual(seen["target"], f)


if __name__ == "__main__":
    unittest.main()
