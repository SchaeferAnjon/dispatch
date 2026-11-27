import json, os, re, struct, sys, tempfile, threading, time, unittest, zlib
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import deliver
import docs_view
import ide_show
import tasks_view as T
from test_dispatch import dispatch
from test_flows import Board
from test_tasks_view import issue


def png(path, w, h):
    """A real (tiny, grey) PNG of that size: enough for image_size and for a browser."""
    raw = b"".join(b"\x00" + b"\x80" * w for _ in range(h))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


IMPL_NOTES = """# 账号额度页和机器菜单

Usage 整页和机器菜单都做好了，在隔离实例里真点过。

## 在哪

1. Usage · 账号面板最下面一行 · 点开是中间整页
2. 机器菜单 · 账号按钮左边 · 点开是每台 Mac 一行

## 改了什么

- Usage 是一整页（task-ab12 那条需求）。

## 这一刻各做什么

### Agent：交付

跑 `dispatch deliver`。

### CLI：生成页面

写 index.html。

### 窗口：右栏打开

Docs 页签闪一下。

### 用户：看

点编号。

## 场景

### 机器菜单

- 平时: ![平时](01-wide.png) 标题栏一个图标
- 出现时: ![出现时](02-wide.png#crop=10,10,200,50) 另一台有事
- 点开后: ![点开后](03-narrow.png) 面板

## 改前改后

- 改前: ![改前](01-wide.png) 天线
- 改后: ![改后](02-wide.png) 机器按钮

## 证据

```
Ran 12 tests in 0.3s

OK
```

- 提交 abc1234（usage）

## 没做的

- mini 上的 Agents 窗口。
"""

PROPOSAL_NOTES = """# Docs 页签怎么改

推荐 B：最近交付放最上面。

## 诊断

![现在](01-wide.png)

1. 看不出哪篇是这一轮交付的。
2. 筛选是胶囊。

## 方向 A: 列表加就地打开

- 平时: ![A 平时](01-wide.png) 列表
- 点开后: ![A 点开](02-wide.png) 就地打开

## 方向 B: 最近交付置顶

![B](03-narrow.png) 卡片在顶上。

## 推荐

推荐 B，一眼看到这一轮交了什么。

| | A | B |
|---|---|---|
| 改动 | 小 | 中 |
"""


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.src = os.path.join(self.tmp, "design", "thing", "impl")
        os.makedirs(self.src)
        png(os.path.join(self.src, "01-wide.png"), 288, 176)
        png(os.path.join(self.src, "02-wide.png"), 288, 176)
        png(os.path.join(self.src, "03-narrow.png"), 84, 176)
        png(os.path.join(self.src, "00-where-is-what.png"), 160, 220)
        png(os.path.join(self.src, "04-window.png"), 1440, 900)  # a whole window: a wide picture
        self.board = Board([issue("task-pm9j", "交付页", "2026-09-28T01:00:00Z", status="in_progress", project="kanban")])
        self.docs = {}
        fake_d = SimpleNamespace(docs_register=lambda proj, path, title="", kind="": {"id": "d1", "path": path, "kind": kind},
                                 POOL=os.path.join(self.tmp, "pool"))
        self.patches = [patch.object(T, "_sh", self.board), patch.object(T, "D", fake_d),
                        patch.object(deliver, "D", dispatch), patch.object(docs_view, "D", dispatch),
                        patch.object(dispatch, "docs_registered", side_effect=lambda p: dispatch.docs_entries_parse(json.dumps(self.docs.get(p, [])))),
                        patch.object(dispatch, "docs_save", side_effect=lambda p, e, keep="": self.docs.__setitem__(p, json.loads(json.dumps(e)))),
                        patch.dict(os.environ, {"DISPATCH_DIR": os.path.join(self.tmp, "state")})]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()

    def write(self, name, text):
        with open(os.path.join(self.src, name), "w", encoding="utf-8") as f:
            f.write(text)

    def page(self):
        with open(os.path.join(self.src, "index.html"), encoding="utf-8") as f:
            return f.read()


class MissingInput(Base):
    def test_folder_notes_model_title_pictures(self):
        with self.assertRaisesRegex(ValueError, "没有这个目录"):
            deliver.build(os.path.join(self.tmp, "nope"), "impl", model="Opus 5.5 · high")
        with self.assertRaisesRegex(ValueError, "没有 notes.md"):
            deliver.build(self.src, "impl", model="Opus 5.5 · high")
        self.write("notes.md", "没有标题的一段话。\n")
        with self.assertRaisesRegex(ValueError, "--model"):
            deliver.build(self.src, "impl")
        with self.assertRaisesRegex(ValueError, "缺标题"):
            deliver.build(self.src, "impl", model="Opus 5.5 · high")
        with self.assertRaisesRegex(ValueError, "impl 或 proposal"):
            deliver.build(self.src, "report", model="Opus 5.5 · high")

    def test_pictures_missing_or_unreferenced(self):
        self.write("notes.md", "# 标题\n\n结论。\n\n## 场景\n\n![不在](09-gone.png)\n")
        with self.assertRaisesRegex(ValueError, "09-gone.png"):
            deliver.build(self.src, "impl", model="m · high")
        for n in os.listdir(self.src):
            if n.endswith(".png"):
                os.remove(os.path.join(self.src, n))
        self.write("notes.md", "# 标题\n\n结论。\n")
        with self.assertRaisesRegex(ValueError, "没有截图"):
            deliver.build(self.src, "impl", model="m · high")

    def test_proposal_needs_two_directions(self):
        self.write("notes.md", "# 标题\n\n推荐 A。\n\n## 方向 A: 只有一个\n\n…\n")
        with self.assertRaisesRegex(ValueError, "两个方向"):
            deliver.build(self.src, "proposal", model="Fable 5.1 · high")

    def test_does_not_overwrite_a_prototype(self):
        self.write("notes.md", IMPL_NOTES)
        self.write("index.html", "<!doctype html><title>原型</title>")
        with self.assertRaisesRegex(ValueError, "不是 dispatch deliver 写的"):
            deliver.deliver("task-pm9j", self.src, "impl", model="Opus 5.5 · high")
        r = deliver.deliver("task-pm9j", self.src, "impl", model="Opus 5.5 · high", out="delivery.html")
        self.assertTrue(r["page"].endswith("delivery.html"))


class ImplPage(Base):
    def test_components_registration_and_deliverable(self):
        self.write("notes.md", IMPL_NOTES)
        with open(os.path.join(self.src, "00-where.json"), "w") as f:
            json.dump({"image": "00-where-is-what.png", "size": [160, 220], "items": [
                {"n": 1, "box": [10, 20, 30, 40], "what": "Usage", "where": "账号面板", "how": "点开"},
                {"n": 2, "box": [50, 60, 20, 20], "what": "机器菜单", "where": "标题栏", "how": "点开"}]}, f)
        r = deliver.deliver("task-pm9j", self.src, "impl", model="Opus 5.5 · high")
        html = self.page()
        # the byline, the title in the user's words, the conclusion first
        self.assertIn("实现：Opus 5.5 · high", html)
        self.assertIn("<h1>账号额度页和机器菜单</h1>", html)
        self.assertLess(html.index("Usage 整页和机器菜单都做好了"), html.index('id="where"'))
        # 在哪: the whole picture with the boxes drawn, numbered lines that zoom, Enlarge, from 00-where.json
        self.assertIn('class="vw where split"', html)
        self.assertIn('data-t="0:0:10,20,30,40"', html)
        self.assertIn('<i class="k">2</i>', html)
        self.assertIn("Whole picture", html)
        self.assertIn("Enlarge", html)
        # four columns, a strip of states (the crop too), before / after, evidence, what is left
        self.assertEqual(html.count('class="step"'), 4)
        self.assertRegex(html, r'class="scene-wrap"><h3[^>]*>机器菜单</h3><div class="vw scene')
        self.assertIn('<span class="lab">出现时</span>', html)  # tall pictures: side by side, each with its label
        self.assertIn('data-crop="10,10,200,50"', html)
        self.assertIn('class="vw pair', html)
        self.assertIn('<pre class="term">', html)
        self.assertLess(html.index('id="evidence"'), html.index('id="left"'))
        # no task ids, no Choose on an implementation page, light and dark
        self.assertIsNone(re.search(r"task-[a-z0-9]{3,}", html.split('<script id="dp-data"')[0].split("<main")[1]))
        self.assertNotIn('class="pick"', html)
        self.assertIn("prefers-color-scheme:dark", html)
        self.assertIn('<meta name="generator" content="dispatch deliver">', html)
        # registered in Docs as a document, hung on the task
        entries = dispatch.docs_entries_parse(json.dumps(self.docs.get("kanban", [])))
        self.assertEqual([(e["path"], e["title"], e["kind"]) for e in entries], [(r["page"], "账号额度页和机器菜单", "交付")])
        meta = T.meta(self.board.issues["task-pm9j"])
        self.assertEqual(meta["deliverables"][-1]["ref"], r["page"])
        self.assertEqual(meta["delivery"]["kind"], "impl")
        # a second run replaces its own page, the deliverable is not doubled
        deliver.deliver("task-pm9j", self.src, "impl", model="Opus 5.5 · high")
        self.assertEqual([d["ref"] for d in T.meta(self.board.issues["task-pm9j"])["deliverables"]].count(r["page"]), 1)

    def test_annotate_where_json_feeds_the_viewfinder(self):
        import annotate as A
        try:
            import PIL  # noqa: F401
        except ImportError:
            self.skipTest("Pillow")
        self.write("notes.md", IMPL_NOTES)
        a = SimpleNamespace(src=os.path.join(self.src, "01-wide.png"), out=os.path.join(self.src, "00-where-is-what.png"),
                            box=["10,10,100,40", "150,90,60,30"], note=["Usage · 账号面板 · 点开", "机器菜单 · 标题栏"], title="", where=True, json=True)
        got = []
        A.cmd(a, lambda r, as_json, text: got.append(r))
        with open(os.path.join(self.src, "00-where.json")) as f:
            where = json.load(f)
        # the json points at the real screenshot: the page draws the boxes, nothing burnt in
        self.assertEqual(where["image"], "01-wide.png")
        self.assertEqual(where["items"][0], {"n": 1, "box": [10, 10, 100, 40], "what": "Usage", "where": "账号面板", "how": "点开"})
        self.assertEqual(where["size"], [288, 176])
        html, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('data-t="0:0:150,90,60,30"', html)
        self.assertIn('<b class="rb" data-i="1" style="left:150px;top:90px;width:60px;height:30px"><i class="k">2</i></b>', html)

    def test_where_on_a_picture_with_boxes_already_drawn(self):
        self.write("notes.md", IMPL_NOTES)
        with open(os.path.join(self.src, "00-where.json"), "w") as f:
            json.dump({"image": "00-where-is-what.png", "drawn": True, "items": [{"n": 1, "box": [10, 20, 30, 40], "what": "Usage"}]}, f)
        html, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('data-t="0:0:10,20,30,40"', html)
        self.assertNotIn('class="rb"', html)

    def test_where_without_boxes_is_the_whole_picture(self):
        self.write("notes.md", IMPL_NOTES)
        html, info = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('class="vw where still split"', html)
        self.assertIn("<em>Usage</em> · 账号面板最下面一行", html)
        self.assertNotIn("Enlarge</button>", html)
        self.assertIn('<img src="00-where-is-what.png"', html)

    def test_where_from_e2e_marks(self):
        self.write("notes.md", "# 右栏 Tasks 页签\n\n做好了。\n")
        png(os.path.join(self.src, "tasks-tab.png"), 2880, 1800)
        with open(os.path.join(self.src, "steps.json"), "w") as f:
            json.dump({"scenario": "/x/scenarios/tasks-tab.mjs", "ok": True, "viewport": {"w": 1440, "h": 900, "dpr": 2},
                       "instance": {"build": {"name": "dd09c4b5ad3f-b7cec3720cd0", "version": "1.139.1-dispatch"}},
                       "steps": [{"i": 1}, {"i": 2}], "shots": ["tasks-tab.png"], "frames": ["tasks-tab.png"],
                       "marks": [{"n": 1, "frame": "tasks-tab.png", "box": {"x": 100, "y": 40, "w": 56, "h": 24}, "what": "Tasks 页签", "where": "右栏顶部", "how": "点它"}]}, f)
        r = deliver.deliver("task-pm9j", self.src, "impl", model="m · x")
        with open(os.path.join(self.src, "00-where.json")) as f:
            made = json.load(f)
        # on the real frame, in its pixels: 2880 / 1440 = 2 per point, 4 points around the element
        self.assertEqual(made["items"][0], {"n": 1, "image": "tasks-tab.png", "size": [2880, 1800], "box": [192, 72, 128, 64],
                                            "what": "Tasks 页签", "where": "右栏顶部", "how": "点它"})
        self.assertEqual(made["scale"], 0.5)
        html = self.page()
        self.assertIn('data-t="0:0:192,72,128,64"', html)
        self.assertIn('<img src="tasks-tab.png"', html)
        self.assertIn("dd09c4b5ad3f-b7cec3720cd0", html)
        self.assertIn("dispatch ide e2e run tasks-tab", html)
        self.assertTrue(r["where"])


class ProposalPage(Base):
    def test_diagnosis_directions_and_choose(self):
        self.write("notes.md", PROPOSAL_NOTES)
        with open(os.path.join(self.src, "01-wide.boxes.json"), "w") as f:
            json.dump({"size": [288, 176], "items": [{"n": 1, "box": [10, 10, 50, 20]}, {"n": 2, "box": [100, 100, 40, 20], "color": "green"}]}, f)
        r = deliver.deliver("task-pm9j", self.src, "proposal", model="Fable 5.1 · high")
        html = self.page()
        self.assertIn("出稿：Fable 5.1 · high", html)
        self.assertIn('class="diag', html)
        self.assertEqual(html.count('class="rb'), 2)
        self.assertIn('class="rb g"', html)
        self.assertIn('id="dir-a"', html)
        self.assertIn('id="dir-b"', html)
        self.assertIn('data-key="A">Choose A</button>', html)
        self.assertIn('class="btn choose solid" type="button" data-key="B"', html)  # the recommended one
        self.assertIn('<table class="cmp">', html)
        self.assertIn('class="remembered" hidden', html)
        data = json.loads(re.search(r'<script id="dp-data" type="application/json">(.*?)</script>', html).group(1))
        self.assertEqual([o["key"] for o in data["options"]], ["A", "B"])
        # registered as a design, and waiting for the person to pick, like dispatch flow finish
        self.assertEqual(dispatch.docs_entries_parse(json.dumps(self.docs["kanban"]))[-1]["kind"], "设计")
        t = self.board.issues["task-pm9j"]
        self.assertEqual(T.meta(t)["flow"]["state"], "deciding")
        self.assertEqual([o["title"] for o in T.meta(t)["flow"]["options"]], ["列表加就地打开", "最近交付置顶"])
        self.assertIn("dispatch:decide", t["labels"])
        self.assertIn("dispatch:waiting", t["labels"])


class Standard(Base):
    """The one page every delivery is: header, contents, sections in the standard order, layout by the page's width."""

    def test_header_credit_under_the_title_and_the_conclusion_first(self):
        self.write("notes.md", IMPL_NOTES)
        html, _ = deliver.build(self.src, "impl", model="Sonnet 5.5 · xhigh", today="2026-09-29")
        self.assertRegex(html, r'<h1>账号额度页和机器菜单</h1><div class="credit"><span>实现：Sonnet 5.5 · xhigh</span><span>2026-09-29</span></div>')
        self.assertIn('class="seg theme"', html)
        self.assertLess(html.index('class="credit"'), html.index('class="lead"'))

    def test_the_header_says_who_wrote_it_and_how_many_lines_you_changed(self):
        self.write("notes.md", IMPL_NOTES)
        att = {"agents": [{"agent": "Claude", "lines": 6}], "yours": 2, "commits": 1}
        html, _ = deliver.build(self.src, "impl", model="Opus 5.5 · high", today="2026-10-06", attribution=att)
        line = html[html.index('data-part="delivery-attribution"'):]
        line = line[:line.index("</div>")]
        self.assertIn("Claude 写的", line)
        self.assertIn("你改了 2 行", line)
        self.assertLess(html.index('class="credit"'), html.index('class="att"'))
        self.assertEqual(deliver.attribution_html({"agents": [{"agent": "Claude", "lines": 3}], "yours": 0}).count("pair"), 1)
        self.assertIn("你写的", deliver.attribution_html({"agents": [], "yours": 4}))
        self.assertEqual(deliver.attribution_html(None), "")
        html, _ = deliver.build(self.src, "impl", model="Opus 5.5 · high", today="2026-10-06")
        self.assertNotIn('class="att"', html)  # no record of the commits: no line

    def test_contents_lists_the_sections_in_the_standard_order(self):
        # the notes put 没做的 and 证据 first and the recommendation before a plain section: the page does not follow that
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 没做的\n\n- 一件事\n\n## 证据\n\n- 提交 abc1234\n\n## 在哪：某个功能\n\n1. 入口 · 位置 · 点开\n\n## 改了什么\n\n- 一行\n")
        html, _ = deliver.build(self.src, "impl", model="m · x")
        toc = re.search(r'<ol class="toc-list">(.*?)</ol></nav>', html, re.S).group(1)
        ids = re.findall(r'data-t="([^"]+)"', toc)
        self.assertEqual(ids, ["top", "where", "s4", "evidence", "left"])
        self.assertIn('<nav class="toc"', html)
        self.assertIn('class="toc-btn"', html)
        body = html.split("<main")[1]
        self.assertEqual([body.index(f'id="{i}"') for i in ("where", "s4", "evidence", "left")], sorted(body.index(f'id="{i}"') for i in ("where", "s4", "evidence", "left")))
        # the page is one column of text next to the contents, and its layout answers to the page width
        self.assertIn("@media (min-width:1000px)", html)
        self.assertIn("@media (min-width:1080px)", html)

    def test_proposal_ends_with_left_then_the_recommendation_and_marks_the_recommended_direction(self):
        # the notes put the recommendation first and 没做的 in the middle: the page ends with 没做的, then the recommendation
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 推荐\n\n推荐 B，一眼看到这一轮交了什么。\n\n| | A | B |\n|---|---|---|\n| 改动 | 小 | 中 |\n\n"
                   "## 没做的\n\n- 没画深色\n\n## 方向 A: 列表加就地打开\n\n甲。\n\n## 方向 B: 最近交付置顶\n\n乙。\n")
        html, _ = deliver.build(self.src, "proposal", model="m · x")
        toc = re.search(r'<ol class="toc-list">(.*?)</ol></nav>', html, re.S).group(1)
        ids = re.findall(r'data-t="([^"]+)"', toc)
        self.assertEqual(ids, ["top", "dir-a", "dir-b", "left", "recommend"])
        self.assertRegex(html, r'<h2 class="dir-h"><span class="key">B</span>最近交付置顶<span class="badge">推荐</span></h2>')
        self.assertNotRegex(html, r'<h2 class="dir-h"><span class="key">A</span>[^<]*<span class="badge">')
        self.assertIn('<div class="card rec"><p>推荐 B，一眼看到这一轮交了什么。</p></div>', html)
        self.assertLess(html.index('class="card rec"'), html.index('<table class="cmp">'))

    def test_sub_headings_with_a_key_and_their_place_in_the_contents(self):
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 改前改后：从 Tasks\n\n### 1. 悬停前\n\n- 改前: ![改前](01-wide.png) 旧的\n- 改后: ![改后](02-wide.png) 新的\n\n### 2. 悬停中\n\n- 改前: ![改前](01-wide.png) 旧的\n- 改后: ![改后](02-wide.png) 新的\n\n### A1 Agents 找到了\n\n一句话。\n")
        html, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('<h3 id="s1-1" class="sh"><span class="key">1</span>悬停前</h3>', html)
        self.assertIn('<h3 id="s1-3" class="sh"><span class="key">A1</span>Agents 找到了</h3>', html)
        self.assertIn('<ol class="toc-sub"><li><a class="s" href="#s1-1" data-t="s1-1">1. 悬停前</a></li>', html)
        self.assertEqual(html.count('class="vw pair'), 2)

    def test_pairs_are_recognised_however_the_notes_write_them(self):
        # a pair under any heading, by its labels
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 改了什么\n\n- 设计稿 1A: ![稿](01-wide.png) 稿的样子\n- 实机 1B: ![机](03-narrow.png) 做出来的\n")
        html, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('class="vw pair', html)
        self.assertNotIn('class="vw scene', html)
        # labels on their own line, the picture under it (indented, or after a blank line)
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 改了什么\n\n- 设计稿 1A:\n  ![稿](01-wide.png) 稿的样子\n- 实机 1B:\n\n  ![机](03-narrow.png) 做出来的\n")
        html, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('class="vw pair', html)
        self.assertEqual(html.count('<span class="lab">'), 2)
        # bare labels in a list and the pictures as paragraphs under it
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 改了什么\n\n- 改前:\n- 改后:\n\n![前](01-wide.png) 旧的\n\n![后](02-wide.png) 新的\n")
        html, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('class="vw pair', html)
        self.assertNotIn("<li>改前", html)
        # bold label paragraphs each followed by its picture
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 改了什么\n\n**设计稿 1A**\n\n![稿](01-wide.png)\n\n**实机 1B**\n\n![机](03-narrow.png)\n")
        html, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('class="vw pair', html)
        # states of one thing stay a strip (tabs), they are not a pair
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 场景\n\n- 平时: ![平时](04-window.png) 一\n- 点开后: ![点开](04-window.png) 二\n")
        html, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('class="vw scene', html)
        self.assertIn('class="seg vtabs"', html)
        self.assertNotIn('class="vw pair', html)

    def test_tall_pictures_beside_their_words_narrowed_alone_and_galleries_by_the_column(self):
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 改了什么\n\n![窄图](03-narrow.png) 图旁边的字。\n\n![单独的窄图](03-narrow.png)\n\n![宽图](04-window.png) 宽图下面的字。\n\n- ![一](03-narrow.png) 甲\n- ![二](03-narrow.png) 乙\n- ![三](03-narrow.png) 丙\n- ![四](03-narrow.png) 丁\n")
        html, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('<figure class="fig-side"><span class="pic"', html)
        self.assertIn('<figure class="solo">', html)
        self.assertEqual(html.count('<figure class="fig-side">'), 1)
        self.assertIn('class="gal narrow" style="--cols:3"', html)
        # the wide picture keeps its words underneath
        self.assertRegex(html, r'<figure><span class="pic"[^>]*>.*?</span></span><figcaption>宽图下面的字。</figcaption></figure>')
        # a crop is judged by its own shape, not by the whole screenshot's
        png(os.path.join(self.src, "big.png"), 1664, 1160)
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 改了什么\n\n![](big.png#crop=0,0,832,1160) 一列右栏。\n")
        html, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('<figure class="fig-side">', html)
        self.assertIn("--real:832px", html)

    def test_label_lists_with_separate_pictures_still_form_one_pair(self):
        self.write("notes.md", "# 对照\n\n- 完成。\n\n## 改了什么\n\n- 设计稿:\n\n![稿](01-wide.png) 原型\n\n"
                   "- 实机:\n\n![机](02-wide.png) 当前构建\n")
        page, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertEqual(page.count('class="vw pair'), 1)
        self.assertNotIn('class="vw scene', page)
        self.assertEqual(page.count('<span class="lab">'), 2)

    def test_tall_picture_uses_the_following_paragraph_as_its_caption(self):
        self.write("notes.md", "# 竖图说明\n\n- 完成。\n\n## 改了什么\n\n![竖图](03-narrow.png)\n\n"
                   "点任务卡就能看到交付物。\n\n下一段保持正文。\n")
        page, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('<figure class="fig-side">', page)
        self.assertIn('<figcaption>点任务卡就能看到交付物。</figcaption>', page)
        self.assertIn('<p>下一段保持正文。</p>', page)

    def test_all_standard_sections_are_ordered_even_when_notes_are_scrambled(self):
        self.write("notes.md", "# 标准顺序\n\n- 结论。\n\n## 场景\n\n状态。\n\n## 背景\n\n上下文。\n\n"
                   "## 改了什么\n\n完成。\n\n## 诊断\n\n![现在](01-wide.png)\n\n"
                   "## 改前改后\n\n对比。\n\n## 这一刻各做什么\n\n### Agent：生成\n\n写交付。\n")
        page, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertEqual(re.findall(r'<section class="sec" id="[^"]+"><h2>([^<]+)</h2>', page),
                         ["标准顺序", "诊断", "改了什么", "这一刻各做什么", "场景", "改前改后", "背景"])

    def test_diagnosis_numbers_take_the_colour_of_their_box(self):
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 诊断\n\n![现在](01-wide.png)\n\n1. 问题一。\n2. 已有的零件。\n")
        with open(os.path.join(self.src, "01-wide.boxes.json"), "w") as f:
            json.dump({"size": [288, 176], "items": [{"n": 1, "box": [10, 10, 50, 20]}, {"n": 2, "box": [100, 100, 40, 20], "color": "green"}]}, f)
        html, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('<li data-n="1"><span class="n">1</span>', html)
        self.assertIn('<li data-n="2" class="g"><span class="n">2</span>', html)


class Prototypes(Base):
    def test_a_prototype_file_runs_in_a_frame_next_to_the_words(self):
        self.write("proto-a.html", "<!doctype html><title>a</title><button>go</button>")
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 方向 A: 甲\n\n![甲的原型](proto-a.html#size=1440x887&scene=a1) 点得动。\n\n## 方向 B: 乙\n\n乙。\n\n## 推荐\n\n推荐 A。\n")
        html, info = deliver.build(self.src, "proposal", model="m · x")
        self.assertIn('<div class="proto" data-w="1440" data-h="887" data-src="proto-a.html#size=1440x887&amp;scene=a1">', html)
        self.assertIn('<span class="pt">甲的原型</span>', html)
        self.assertIn('sandbox="allow-scripts allow-forms"', html)
        self.assertIn("<figcaption>点得动。</figcaption>", html)
        self.assertIn("Enlarge", html)
        self.assertIn(">1:1</button>", html)
        self.assertIn("proto-a.html", info["pictures"])
        self.assertNotIn("proto-a.html", info["unused"])

    def test_a_missing_prototype_file_is_an_error(self):
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 方向 A: 甲\n\n![原型](nope.html)\n\n## 方向 B: 乙\n\n乙。\n")
        with self.assertRaisesRegex(ValueError, "nope.html"):
            deliver.build(self.src, "proposal", model="m · x")

    def test_a_prototype_inside_a_strip_is_a_state_tab(self):
        self.write("a.html", "<p>a</p>")
        self.write("b.html", "<p>b</p>")
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 方向 A: 甲\n\n### A1 首页\n\n- 平时: ![](a.html#size=800x600) 一\n- 点开后: ![](b.html#size=800x600) 二\n\n## 方向 B: 乙\n\n乙。\n")
        html, _ = deliver.build(self.src, "proposal", model="m · x")
        self.assertRegex(html, r'class="scene"[^>]*>\s*<h3 id="dir-a-1" class="sh"><span class="key">A1</span>首页</h3>')
        self.assertEqual(html.count('class="proto"'), 2)
        self.assertIn(">点开后</button>", html)

    def test_an_inline_prototype_gets_the_tokens_and_the_theme_listener(self):
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 方向 A: 甲\n\n```prototype 640x360 小卡片\n<button style=\"color:var(--text)\">go</button>\n```\n\n## 方向 B: 乙\n\n乙。\n")
        html, _ = deliver.build(self.src, "proposal", model="m · x")
        m = re.search(r'<div class="proto" data-w="640" data-h="360" data-doc="([^"]*)">', html)
        self.assertTrue(m)
        import html as H
        doc = H.unescape(m.group(1))
        self.assertIn("dispatch-theme", doc)
        self.assertIn("--text-2", doc)
        self.assertIn('<button style="color:var(--text)">go</button>', doc)
        self.assertIn('<span class="pt">小卡片</span>', html)
        # a whole document only gets the listener
        whole = "<!doctype html><html><head><title>x</title></head><body>hi</body></html>"
        self.assertTrue(deliver.proto_doc(whole).startswith("<!doctype html><html><head>" + deliver.PROTO_LISTEN))
        self.assertNotIn("--text-2", deliver.proto_doc(whole))

    def test_a_proposal_page_is_the_one_index_html_with_prototypes_named_otherwise(self):
        self.write("proto.html", "<p>p</p>")
        self.write("notes.md", PROPOSAL_NOTES.replace("推荐 B，", "推荐 B，![原型](proto.html#size=900x600) "))
        r = deliver.deliver("task-pm9j", self.src, "proposal", model="Fable 5.1 · high")
        self.assertTrue(r["page"].endswith("index.html"))
        self.assertIn('class="proto"', self.page())


class Show(Base):
    def test_show_asks_the_window_to_serve_the_page(self):
        self.write("notes.md", PROPOSAL_NOTES)
        os.makedirs(ide_show.ide_dir(), exist_ok=True)
        with open(ide_show.alive_path(), "w") as f:
            json.dump({"pid": os.getpid(), "at": time.time()}, f)
        seen = {}

        def window():
            d = ide_show.requests_dir()
            for _ in range(200):
                names = [n for n in os.listdir(d) if n.endswith(".json")] if os.path.isdir(d) else []
                if names:
                    with open(os.path.join(d, names[0])) as fh:
                        seen.update(json.load(fh))
                    os.remove(os.path.join(d, names[0]))
                    with open(os.path.join(d, seen["id"] + ".done"), "w") as f:
                        json.dump({"ok": True}, f)
                    return
                time.sleep(0.02)
        th = threading.Thread(target=window)
        th.start()
        r = deliver.deliver("task-pm9j", self.src, "proposal", model="Fable 5.1 · high", show=True)
        th.join()
        self.assertTrue(r["shown"]["shown"])
        self.assertEqual(seen["target"], r["page"])
        self.assertEqual((seen["delivery"], seen["task"]), ("proposal", "task-pm9j"))

    def test_show_without_the_window_prints_the_path(self):
        self.write("notes.md", IMPL_NOTES)
        r = deliver.deliver("task-pm9j", self.src, "impl", model="m · x", show=True)
        self.assertFalse(r["shown"]["shown"])
        self.assertIn(r["page"], deliver.text_of(r))


class Viewfinder(Base):
    """Direction A「就地看图」: every section reads like 在哪. A line that names a place zooms the section's own
    picture to that numbered box; a pair moves both pictures to the same number; a state's lines go with its tab;
    a record line opens the record in place; a line of words stays words."""

    def test_changed_lines_point_at_a_box_a_record_or_nothing(self):
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 改了什么\n\n- [读取进度](01-wide.png#mark=2)：显示数量\n"
                   "- [性能记录](bench.json)\n- 只解析含任务前缀的行。\n")
        self.write("01-wide.boxes.json", json.dumps({"items": [{"n": 2, "box": [10, 20, 30, 40]}, {"n": 5, "box": [1, 1, 5, 5]}]}))
        self.write("bench.json", json.dumps({"seconds": 1.861, "files": 2535, "build": {"name": "862ce05735e6"}, "runs": [1, 2]}))
        html, info = deliver.build(self.src, "impl", model="m · x")
        sec = html.split('id="s1"')[1].split("</section>")[0]
        self.assertIn('class="vw rows split"', sec)
        # numbered in order on the page; the box drawn is the line's, with the line's number
        self.assertIn('<li tabindex="0" data-i="0" data-t="0:0:10,20,30,40"><span class="n">1</span><span><em>读取进度</em>：显示数量</span></li>', sec)
        self.assertIn('<b class="rb" data-i="0" style="left:10px;top:20px;width:30px;height:40px"><i class="k">1</i></b>', sec)
        self.assertEqual(sec.count('class="rb'), 1)
        # the record opens in place: its top-level facts and the whole file
        self.assertIn('<li class="r" tabindex="0" data-i="1" data-rec="1">', sec)
        self.assertIn('<div class="rec" data-rec="1" hidden>', sec)
        self.assertIn("<dt>seconds</dt><dd>1.861</dd>", sec)
        self.assertIn("<dt>build.name</dt><dd>862ce05735e6</dd>", sec)
        self.assertIn("bench.json · ", sec)
        # words only: no number, said so
        self.assertIn('<li class="x" data-i="2"><span class="n ic"></span><span>只解析含任务前缀的行。</span><small>No picture</small></li>', sec)
        self.assertEqual(info["warnings"], [])
        self.assertNotIn("bench.json", info["unused"])

    def test_a_missing_number_keeps_the_line_whole_and_tells_the_author(self):
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 改了什么\n\n- [读取进度](01-wide.png#mark=9) 显示数量\n")
        html, info = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('data-t="0:0:"', html)
        self.assertEqual(len(info["warnings"]), 1)
        self.assertIn("notes.md 第 7 行", info["warnings"][0])
        self.assertIn("编号 9", info["warnings"][0])

    def test_a_missing_file_is_an_error_as_for_any_picture(self):
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 改了什么\n\n- [读取进度](09-gone.png#mark=1)\n- [记录](gone.json)\n\n![a](01-wide.png)\n")
        with self.assertRaisesRegex(ValueError, "09-gone.png、gone.json"):
            deliver.build(self.src, "impl", model="m · x")

    def test_boxes_come_from_where_json_and_frames_from_steps_json(self):
        png(os.path.join(self.src, "05-step.png"), 2880, 1800)
        with open(os.path.join(self.src, "00-where.json"), "w") as f:
            json.dump({"image": "01-wide.png", "items": [{"n": 1, "box": [5, 5, 10, 10], "what": "a"},
                                                         {"n": 3, "image": "02-wide.png", "size": [576, 352], "box": [20, 40, 60, 80], "what": "b"}]}, f)
        with open(os.path.join(self.src, "steps.json"), "w") as f:
            json.dump({"viewport": {"w": 1440, "h": 900, "dpr": 2}, "steps": [{"i": 5, "action": "mark", "shot": "05-step.png",
                       "box": {"x": 100, "y": 40, "w": 56, "h": 24}}], "shots": ["05-step.png"]}, f)
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 证据\n\n- [在哪的第 3 个](02-wide.png#mark=3)\n- [第 5 步的验收帧](steps.json#step=5)\n"
                   "- [整个记录](steps.json)\n")
        html, info = deliver.build(self.src, "impl", model="m · x")
        sec = html.split('id="evidence"')[1].split("</section>")[0]
        # 00-where.json in its own pixels (576 x 352) scaled to the file (288 x 176)
        self.assertIn('data-t="0:0:10,20,30,40"', sec)
        # steps.json in the window's points: 2880 / 1440 = 2 a point, 4 points around the element
        self.assertIn('data-t="0:1:192,72,128,64"', sec)
        self.assertIn('data-rec="2"', sec)
        self.assertEqual(info["warnings"], [])

    def test_a_pair_line_moves_both_pictures_to_the_same_number(self):
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 改前改后\n\n### 首次读取\n\n- 改前: ![](01-wide.png) 只有 Looking…\n"
                   "- 改后: ![](02-wide.png) 有数量\n- [从 Looking… 到已读数量](01-wide.png#mark=2)\n\n- [另一处](02-wide.png#mark=7)\n")
        self.write("01-wide.boxes.json", json.dumps({"items": [{"n": 2, "box": [10, 20, 30, 40]}]}))
        self.write("02-wide.boxes.json", json.dumps({"items": [{"n": 2, "box": [50, 60, 70, 80], "color": "green"}]}))
        html, info = deliver.build(self.src, "impl", model="m · x")
        pair = html.split('class="vw pair')[1].split("</section>")[0]
        self.assertIn('data-t="0:0:10,20,30,40|1:0:50,60,70,80"><span class="n">2</span><span><em>从 Looking… 到已读数量</em></span>', pair)
        self.assertIn('<b class="rb g" data-i="0"', pair)
        # a number neither picture has: both shown whole, the author is told
        self.assertIn('data-t="0:0:|1:0:"', pair)
        self.assertEqual(len(info["warnings"]), 1)
        self.assertIn("编号 7", info["warnings"][0])
        # without lines of its own, a pair gets one line a number, named after its heading
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 改前改后\n\n### 2. 首次读取\n\n- 改前: ![](01-wide.png) 旧\n- 改后: ![](02-wide.png) 新\n")
        html, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('<span class="n">2</span><span>Box 2 on both pictures</span>', html)

    def test_a_states_lines_go_with_its_tab(self):
        png(os.path.join(self.src, "05-window.png"), 1440, 900)
        self.write("05-window.boxes.json", json.dumps({"items": [{"n": 1, "box": [100, 100, 200, 50], "what": "面板"}]}))
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 场景\n\n### 面板\n\n- 平时: ![](04-window.png) 关着\n- 点开后: ![](05-window.png) 打开\n"
                   "- [标题栏](04-window.png)\n")
        html, info = deliver.build(self.src, "impl", model="m · x")
        sc = html.split('class="vw scene')[1].split("</section>")[0]
        self.assertIn('data-f="1">点开后</button>', sc)
        # the first state's line shows, the second state's line waits for its tab
        self.assertIn('data-t="0:0:" data-f="0"><span class="n">1</span><span><em>标题栏</em></span>', sc)
        self.assertIn('data-t="0:1:100,100,200,50" data-f="1" hidden><span class="n">1</span><span>面板</span>', sc)
        self.assertIn('<figcaption data-f="1" hidden>打开</figcaption>', sc)
        self.assertEqual(info["warnings"], [])

    def test_a_record_that_is_not_text_stays_words(self):
        with open(os.path.join(self.src, "blob.json"), "wb") as f:
            f.write(b"\x00\x01\x02binary")
        self.write("notes.md", "# 标题\n\n- 结论。\n\n## 改了什么\n\n- [记录](blob.json)\n\n![a](01-wide.png)\n")
        html, info = deliver.build(self.src, "impl", model="m · x")
        self.assertIn("<small>Record unavailable</small>", html)
        self.assertIn("blob.json", info["warnings"][0])

    def test_lines_without_places_stay_a_plain_list(self):
        self.write("notes.md", "# 标题\n\n- [结论](01-wide.png#mark=1)。\n\n## 改了什么\n\n- 一件事。\n- 见 [文档](https://example.com)。\n\n## 没做的\n\n- [没做](01-wide.png)\n")
        html, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertNotIn('class="vw rows', html)
        self.assertIn("<li>一件事。</li>", html)


class Cli(Base):
    def test_run_reports_errors_as_json(self):
        a = SimpleNamespace(task="task-pm9j", src=self.src, kind="impl", title="", model="", show=False, out="index.html", force=False,
                            test_log=None, session="", project="", json=True)
        self.write("notes.md", IMPL_NOTES)
        with patch("builtins.print") as pr:
            self.assertEqual(deliver.run(a), 1)
        self.assertIn("--model", json.loads(pr.call_args[0][0])["error"])
        a.model = "Opus 5.5 · high"
        with patch("builtins.print") as pr:
            self.assertEqual(deliver.run(a), 0)
        self.assertTrue(json.loads(pr.call_args[0][0])["ok"])

    def test_one_labelled_picture_is_a_labelled_figure(self):
        self.write("notes.md", "# 标题\n\n结论。\n\n## 场景\n\n- 平时: ![平时](01-wide.png) 一个图标\n")
        html, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('class="vw scene', html)
        self.assertIn('<span class="lab">平时</span>', html)
        self.assertNotIn("<li>平时", html)

    def test_prototype_and_real_side_by_side(self):
        # a design against the built screen is a pair too, not only before / after
        self.write("notes.md", "# 标题\n\n结论。\n\n## 稿和真机逐屏对照\n\n- 原型: ![原型](01-wide.png) 稿\n- 真机: ![真机](01-wide.png) 做出来的\n")
        html, _ = deliver.build(self.src, "impl", model="m · x")
        self.assertIn('class="vw pair', html)
        self.assertIn('<span class="lab">真机</span>', html)

    def test_before_and_after_draw_their_boxes(self):
        # each picture of a pair carries its own numbered boxes; one without boxes is shown plain
        self.write("notes.md", "# 标题\n\n结论。\n\n## 改前改后\n\n- 改前: ![改前](01-wide.png) 旧\n- 改后: ![改后](02-wide.png) 新\n")
        self.write("01-wide.boxes.json", json.dumps({"items": [{"n": 1, "box": [10, 20, 30, 40]}]}))
        html, _ = deliver.build(self.src, "impl", model="m · x")
        pair = html.split('class="vw pair')[1].split("</section>")[0]
        self.assertEqual(pair.count('class="rb"'), 1)
        self.assertIn('<b class="rb" data-i="0" style="left:10px;top:20px;width:30px;height:40px"><i class="k">1</i></b>', pair)
        # one line for number 1 moves both: the old picture to its box, the new one shown whole and said so
        self.assertIn('data-t="0:0:10,20,30,40|1:0:"', pair)
        self.assertIn("Not marked on this picture", pair)

    def test_markdown_is_escaped(self):
        self.write("notes.md", "# <script>x</script> 标题\n\n结论 <img src=x onerror=alert(1)>。\n\n## 场景\n\n![a](01-wide.png) [点我](javascript:alert(1))\n")
        html, _ = deliver.build(self.src, "impl", model="m · x")
        body = html.split("<main")[1].split('<script id="dp-data"')[0]
        self.assertNotIn("<script>x", body)
        self.assertNotIn("<img src=x", body)
        self.assertNotIn("javascript:", body)

    def test_a_column_of_short_words_stays_on_one_line(self):
        rows = [["短名", "一句话", "好 / 不好", "范围"], ["方角开关", "开关和分段控件用稍微圆的方角，不要整圆胶囊。" * 3, "Avoid", "全局"]]
        out = deliver.table_html(rows, None)
        self.assertIn('<th class="nw">好 / 不好</th>', out)
        self.assertIn('<td class="nw" data-h="范围">全局</td>', out)
        self.assertIn('<td data-h="一句话">开关和分段控件', out)

    def test_task_ids_are_scrubbed_but_names_that_contain_task_stay(self):
        self.assertEqual(deliver.scrub("做完了 task-eidb，见上一条（task-qszv）。"), "做完了 任务，见上一条。")
        self.assertEqual(deliver.scrub("子任务 task-in7q.2 做完了."), "子任务 任务 做完了.")
        for keep in ("Claude 记忆 · no-task-ids-for-user", "Claude 记忆 · agent-driven-task-workflow",
                     "design/task-model/DECISIONS.md", "task-board/SKILL.md", "用 task-board 技能",
                     "都不出现 task-xxxx 编号", "看 task-graph", "task-eidb.md"):
            self.assertEqual(deliver.scrub(keep), keep)


if __name__ == "__main__":
    unittest.main()
