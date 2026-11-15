# -*- coding: utf-8 -*-
"""dispatch prefs: remembering, merging, replacing, forgetting and bringing back, what prime gives
agents, and the import from the old places (a dry run writes nothing)."""
import contextlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import prefs  # noqa: E402

WINDOWS_READY = True

SAID = {"at": "2026-09-28T01:00:00+02:00", "engine": "claude-code", "session": "8ebbcdf5-aaaa-bbbb", "project": "kanban", "cwd": "/x"}

FACTS = """# 常用信息

## 通用

**机器**
- MacBook 和 mini

**我常说的话**
- 数据结构字段名是跨端契约，两边逐字一致，不许「顺手改名」。
- 课件、真题是版权材料，不公开分发。

**我的设计偏好（2026-09-26 从全部 Claude Code 和 Codex 会话整理）**
- 做任何界面动手前先读全文：`~/x/我的设计偏好.md`。
- 要：列表先分组，组能收起；首屏先给重点
- 不要：同一功能多个入口；全屏弹层挡内容
- 2026-09-27 拍板：右栏 Tasks 页签用「紧凑卡」，因为 Task graph 已经是时间线。开关和分段控件用稍微圆的方角，不要整圆胶囊。
"""

TASTE = """# 设计偏好：给做界面的 Agent

> 2026-09-26 用户补充：个人网站那套强烈个性风格是失败作品，不算他的审美。

## 1. 喜欢的

- 「希望默认是收起来的。」（2026-09-14，Harbor）

## 4. 动手前对照的清单

### 要

1. **列表先分类。** 左栏或长列表按类分组，每组有名字和条数，能收起。
2. **一个功能一个入口。** 同名或同作用的只留一个。

### 不要

1. 不要把好几种来源排成一条长列，只靠灰色小字分组头区分（图 08）。

### 怎么拿给他看

- 改完给前后对比截图：「我没看到你改了哪里，你能截图对比吗？」（2026-09-06，Dispatch）
"""


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.home = os.path.join(self.tmp, "home")
        self.proj = os.path.join(self.tmp, "kanban")
        os.makedirs(os.path.join(self.proj, ".git"))
        self.facts = self.write("FACTS.md", FACTS)
        self.taste = self.write("taste/我的设计偏好.md", TASTE)
        os.makedirs(os.path.join(self.tmp, "taste", "我的设计偏好"))
        self.fig = self.png(os.path.join(self.tmp, "taste", "我的设计偏好", "08-不喜欢-文案页左栏一条长列.png"))
        env = {"DISPATCH_HOME": self.home, "DISPATCH_FACTS_FILE": self.facts, "DISPATCH_TASTE_FILE": self.taste,
               "DISPATCH_PROFILE_FILE": os.path.join(self.tmp, "none.md"), "DISPATCH_DESIGN_FILE": os.path.join(self.tmp, "none.md")}
        for p in (patch.dict(os.environ, env), patch.object(prefs, "caller_said", lambda cwd=None: dict(SAID, cwd=cwd or "/x")),
                  patch.object(prefs, "spawn_thumbs", lambda pid: None), patch.object(prefs, "page_shot", lambda t, d: False)):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def write(self, rel, text):
        p = os.path.join(self.tmp, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        return p

    def png(self, path):
        # the smallest valid PNG: 1×1, grey
        raw = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8ffff3f0005fe02fea7a6ad9d0000000049454e44ae426082")
        with open(path, "wb") as f:
            f.write(raw)
        return path

    def add(self, text, **kw):
        item = {"text": text, **kw}
        return prefs.add(item, cwd=self.proj)

    def cli(self, *argv, stdin=""):
        """Run `dispatch prefs …` through dispatch.py's own parser; (exit code, parsed JSON or text)."""
        import dispatch
        out = io.StringIO()
        with contextlib.redirect_stdout(out), patch.object(sys, "argv", ["dispatch", "prefs", *argv]), \
                patch("sys.stdin", io.StringIO(stdin)), patch("os.getcwd", lambda: self.proj), self.assertRaises(SystemExit) as e:
            dispatch._main()
        text = out.getvalue()
        try:
            return e.exception.code, json.loads(text)
        except ValueError:
            return e.exception.code, text


class Remember(Base):
    def test_add_keeps_the_sentence_the_words_and_who_said_it(self):
        res = self.add("开关和分段控件用稍微圆的方角，不要整圆胶囊。", polarity="avoid", name="方角开关", area="design",
                       scope="kanban:Tasks tab", quote="这个开关用方角，别用胶囊", part="design/x/index.html#toggle")
        (e,) = prefs.load()
        self.assertEqual(res["remembered"][0]["id"], e["id"])
        self.assertRegex(e["id"], r"^pref-[a-z0-9]{4}$")
        self.assertEqual((e["name"], e["polarity"], e["area"], e["scope"], e["quote"]), ("方角开关", "avoid", "design", "kanban:Tasks tab", "这个开关用方角，别用胶囊"))
        self.assertEqual(e["part"], "design/x/index.html#toggle")
        self.assertEqual((e["said"]["engine"], e["said"]["session"]), ("claude-code", "8ebbcdf5-aaaa-bbbb"))
        self.assertEqual((e["seen"], e["used"], e["last_used"], e["status"]), (False, 0, None, "active"))
        self.assertEqual(e["history"][0]["event"], "remembered")
        with self.assertRaises(prefs.PrefsError):
            self.add("   ")

    def test_the_same_thing_said_again_adds_the_words_to_the_entry(self):
        self.add("开关和分段控件用稍微圆的方角，和右栏页签一样，不要整圆胶囊。", polarity="avoid", area="design", scope="kanban", quote="第一次")
        res = self.add("开关和分段控件用稍微圆的方角，不要整圆胶囊。", polarity="avoid", area="design", scope="kanban", quote="第二次")
        (e,) = prefs.load()
        self.assertEqual(res["merged"], [e["id"]])
        self.assertEqual(e["quote"], "第一次")
        self.assertEqual([q["text"] for q in e["quotes"]], ["第二次"])
        # another project is another preference
        self.add("开关和分段控件用稍微圆的方角，不要整圆胶囊。", polarity="avoid", area="design", scope="harbor")
        self.assertEqual(len(prefs.load()), 2)

    def test_replaces_retires_the_old_one_and_prime_gives_only_the_new(self):
        old = self.add("所有的任务都设计成时间线。", polarity="like", name="时间线任务", area="design", scope="kanban")["remembered"][0]
        close = self.add("右栏 Tasks 页签用紧凑卡：状态点、标题、时间。", polarity="like", name="Tasks 紧凑卡", area="design", scope="kanban")
        self.assertEqual(close["similar"], {})
        new = self.add("右栏任务一律用紧凑卡，不用时间线。", polarity="like", name="紧凑卡", area="design", scope="kanban", replaces=["时间线任务"])
        entries = {e["id"]: e for e in prefs.load()}
        self.assertEqual(entries[old["id"]]["status"], "replaced")
        self.assertEqual(entries[old["id"]]["replaced_by"], new["remembered"][0]["id"])
        self.assertEqual(new["replaced"], [old["id"]])
        text = "\n".join(prefs.prime_section("kanban"))
        self.assertIn("紧凑卡", text)
        self.assertNotIn("时间线任务", text)
        with self.assertRaises(prefs.PrefsError):
            self.add("x 不重要。", replaces=["没有这个"])

    def test_scope_narrow_first_and_other_projects_left_out(self):
        self.add("汇报先说结论。", polarity="like", name="结论先行", area="writing")
        self.add("Waiting 页的卡就地批准。", polarity="like", name="就地批准", area="design", scope="kanban:Waiting for you")
        self.add("开关用方角。", polarity="like", name="方角", area="design", scope="kanban")
        self.add("剪视频用 FCP。", polarity="like", name="FCP", area="tools", scope="自媒体")
        lines = prefs.prime_section("kanban")
        text = "\n".join(lines)
        self.assertNotIn("FCP", text)
        design = lines[lines.index("设计") + 1:lines.index("写作")]
        self.assertEqual([l.split("：")[0] for l in design], ["- 就地批准（Waiting for you）", "- 方角"])
        self.assertIn("结论先行", text)
        self.assertEqual(prefs.prime_section("harbor")[1:3], ["写作", "- 结论先行：汇报先说结论。"])
        # how to record one is a rule (dispatch.md), not a line in every list
        self.assertNotIn("记新的", text)
        # Empty lists carry only state; recording instructions are in dispatch.md.
        empty = prefs.prime_section("kanban", entries=[])
        self.assertEqual(empty[0], "## 偏好（用户的；还没有记下的）")
        self.assertEqual(len(empty), 1)

    def test_prime_stays_short_and_skips_what_the_rules_say(self):
        os.makedirs(os.path.join(self.home, "rules"))
        with open(os.path.join(self.home, "rules", "GLOBAL.md"), "w", encoding="utf-8") as f:
            f.write("# rules\n- 调用智谱 GLM 一律走 Coding Plan 端点，不用按量付费端点。\n")
        self.add("调用智谱 GLM 一律走 Coding Plan 端点。", polarity="like", area="tools")
        words = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔龙师火帝鸟官人皇"
        items = [{"text": f"{words[i]}{words[i + 1]}{words[i + 2]}这一类界面{words[i + 3]}{words[i + 4]}要照{words[i + 5]}{words[i + 6]}的样子做，行高和间距跟着它。",
                  "polarity": "like", "area": "design", "name": f"第{i}条"} for i in range(80)]
        prefs.add(items, cwd=self.proj)
        lines = prefs.prime_section("kanban", cwd=self.proj)
        body = [l for l in lines if l.startswith("- ")]
        self.assertLessEqual(sum(len(l) + 1 for l in body), prefs.PRIME_CHARS)
        self.assertLessEqual(len(body), prefs.PRIME_LIMIT)
        self.assertIn("还有", lines[0])
        self.assertNotIn("Coding Plan", "\n".join(lines))
        (glm,) = [e for e in prefs.load() if "GLM" in e["text"]]
        self.assertEqual(glm["also_in"], ["GLOBAL.md"])


class ForgetAndUndo(Base):
    def test_forget_goes_to_the_backup_and_undo_brings_it_back(self):
        a = self.add("会话头像不用字母。", polarity="avoid", name="字母头像", area="design")["remembered"][0]
        self.add("汇报先说结论。", polarity="like", name="结论先行", area="writing")
        res = prefs.forget(["字母头像"])
        self.assertEqual([e["id"] for e in res["forgotten"]], [a["id"]])
        self.assertEqual([e["name"] for e in prefs.load()], ["结论先行"])
        self.assertTrue(res["backup"].startswith(os.path.join(self.home, "backups", "preferences")))
        with open(res["backup"], encoding="utf-8") as f:
            rec = json.loads(f.readline())
        self.assertEqual((rec["op"], rec["entry"]["id"]), ("forget", a["id"]))
        # the page's line under a reply still finds it, as forgotten
        self.assertEqual(list(prefs.forgotten({a["id"]})), [a["id"]])
        back = prefs.undo()
        self.assertEqual([e["id"] for e in back["restored"]], [a["id"]])
        self.assertEqual(sorted(e["name"] for e in prefs.load()), ["字母头像", "结论先行"])
        with self.assertRaises(prefs.PrefsError):
            prefs.undo()

    def test_undo_right_after_an_add_keeps_what_was_there_before(self):
        # the toast's Undo: a new entry is forgotten; one that was only said again loses those words and stays
        old = self.add("开关用方角，不要胶囊。", polarity="avoid", name="方角开关", area="design", quote="开关别用胶囊")["remembered"][0]
        prefs.seen(everything=True)
        before = prefs.load()[0]
        res = self.add("开关用方角，不要胶囊。", polarity="avoid", area="design", quote="这个开关用方角，别用胶囊",
                       part="proto.html#toggle")
        self.assertEqual(res["merged"], [old["id"]])
        new = self.add("汇报先说结论。", polarity="like", name="结论先行", area="writing")["remembered"][0]
        res = prefs.forget([old["id"], new["id"]], just_said=True)
        self.assertEqual([e["id"] for e in res["forgotten"]], [new["id"]])
        self.assertEqual([e["id"] for e in res["kept"]], [old["id"]])
        (e,) = prefs.load()
        self.assertEqual((e["id"], e["quote"], e.get("quotes"), e.get("part"), e["seen"]),
                         (old["id"], "开关别用胶囊", None, None, True))
        self.assertEqual(e.get("updated"), before.get("updated"))
        self.assertEqual([h["event"] for h in e["history"]][-2:], ["said-again", "unsaid"])
        # a plain forget still takes the whole entry out
        self.assertEqual([x["id"] for x in prefs.forget([old["id"]])["forgotten"]], [old["id"]])

    def test_the_agent_hears_once_that_a_preference_it_recorded_was_taken_back(self):
        from unittest import mock
        real = prefs.caller_said
        with mock.patch.object(prefs, "caller_said", lambda cwd=None: dict(real(cwd), session="ses_abcdef123")):
            a = self.add("开关用方角，不要胶囊。", polarity="avoid", name="方角开关", area="design")["remembered"][0]
        other = self.add("汇报先说结论。", polarity="like", name="结论先行", area="writing")["remembered"][0]
        self.assertEqual(prefs.undone_note("ses_abcdef123"), "")  # nothing taken back yet
        prefs.forget([a["id"], other["id"]])
        note = prefs.undone_note("ses_abcdef123")
        self.assertIn("方角开关", note)
        self.assertIn("prefs_add", note)
        self.assertNotIn("结论先行", note)  # another conversation's
        self.assertEqual(prefs.undone_note("ses_abcdef123"), "")  # told once
        self.assertEqual(prefs.undone_note(""), "")

    def test_forgetting_the_new_one_puts_the_old_one_back_in_use(self):
        old = self.add("任务用时间线。", polarity="like", name="时间线", area="design")["remembered"][0]
        new = self.add("任务用紧凑卡。", polarity="like", name="紧凑卡", area="design", replaces=["时间线"])["remembered"][0]
        res = prefs.forget([new["id"]])
        self.assertEqual(res["restored"], [old["id"]])
        (e,) = prefs.load()
        self.assertEqual((e["id"], e["status"]), (old["id"], "active"))
        prefs.undo(new["id"])
        entries = {e["id"]: e for e in prefs.load()}
        self.assertEqual(entries[old["id"]]["status"], "replaced")


class UseAndAge(Base):
    def test_cite_once_per_reply_keep_and_stale(self):
        e = self.add("汇报先说结论。", polarity="like", name="结论先行", area="writing")["remembered"][0]
        prefs.cite(["结论先行"], by="designer", for_="Knowledge", ref="resp-1")
        prefs.cite(["结论先行"], ref="resp-1")
        prefs.cite([e["id"]], ref="resp-2")
        (e,) = prefs.load()
        self.assertEqual(e["used"], 2)
        self.assertTrue(e["last_used"])
        old = dict(e, last_used="2026-08-01T10:00:00+02:00")
        self.assertTrue(prefs.is_stale(old))
        self.assertFalse(prefs.is_stale(dict(old, kept_at=prefs.iso())))
        imported = {"status": "active", "said": {"at": "2026-09-02"}, "created": prefs.iso()}
        self.assertTrue(prefs.is_stale(imported))
        prefs.keep([e["id"]])
        self.assertTrue(prefs.load()[0]["kept_at"])
        prefs.seen(everything=True)
        self.assertTrue(prefs.load()[0]["seen"])

    def test_edit_changes_fields_and_keeps_history(self):
        e = self.add("开关用方角。", polarity="like", area="design")["remembered"][0]
        prefs.edit(e["id"], {"text": "开关和分段控件用稍微圆的方角。", "polarity": "avoid", "scope": "kanban", "name": "方角开关"})
        (e,) = prefs.load()
        self.assertEqual((e["text"], e["polarity"], e["scope"], e["name"]), ("开关和分段控件用稍微圆的方角。", "avoid", "kanban", "方角开关"))
        self.assertEqual(e["history"][-1]["event"], "edited")
        with self.assertRaises(prefs.PrefsError):
            prefs.edit("方角开关", {"area": "colour"})


class Evidence(Base):
    def test_an_image_is_copied_and_thumbnailed(self):
        shot = self.png(os.path.join(self.tmp, "179.png"))
        e = self.add("开关用方角。", polarity="like", area="design", evidence=[shot])["remembered"][0]
        d = prefs.evidence_dir(e["id"])
        self.assertTrue(os.path.exists(os.path.join(d, "179.png")))
        tp = prefs.thumb_paths(e)
        self.assertEqual(sorted(tp), ["card", "chip"])
        v = prefs.view(prefs.load()[0], thumbs="chip")
        self.assertTrue(v["thumb"].startswith("data:image/"))
        os.remove(shot)  # the original moved away: the copy still shows
        self.assertTrue(prefs.view(prefs.load()[0], thumbs="card")["images"][0]["uri"].startswith("data:image/png"))

    def test_every_screenshot_is_copied(self):
        a = self.png(os.path.join(self.tmp, "new-session.png"))
        b = self.png(os.path.join(self.tmp, "app.png"))
        e = self.add("像 Copilot 桌面端。", polarity="like", area="design", evidence=[a, b])["remembered"][0]
        names = [os.path.basename(p) for p in prefs.evidence_images(prefs.load()[0])]
        self.assertEqual(sorted(names), ["app.png", "new-session.png"])
        self.assertEqual(sorted(prefs.thumb_paths(e)), ["card", "chip"])


class PageShot(unittest.TestCase):
    def test_headless_chrome_never_reaches_for_the_keychain(self):
        # a fresh profile under a test's HOME made macOS show "A keychain cannot be found" on the person's screen
        seen = []
        with patch.object(prefs.os.path, "exists", lambda p: p == prefs.CHROME_PATHS[0]), \
                patch.object(prefs, "_run", lambda argv, timeout=60: seen.append(argv) or False):
            self.assertFalse(prefs.page_shot("/tmp/x.html", "/tmp/out/x.png", 1440, 900))
        self.assertIn("--use-mock-keychain", seen[0])
        self.assertIn("--password-store=basic", seen[0])
        self.assertIn("--window-size=1440,900", seen[0])


class Import(Base):
    def test_dry_run_reads_the_three_places_and_writes_nothing(self):
        memory = [
            {"agent": "claude-code", "type": "feedback", "project": "kanban", "path": "/m/no-task-ids.md", "name": "no-task-ids-for-user",
             "description": "给用户的汇报和界面里都不出现 task-xxxx 编号，用任务标题", "body": "2026-09-27 用户：「我希望以后对于用户来说，他看不到 task-9bgm 类似的东西」", "mtime": 0},
            {"agent": "claude-code", "type": "project", "project": "kanban", "path": "/m/multi-mac.md", "name": "multi-mac", "description": "两台 Mac", "body": "", "mtime": 0},
            {"agent": "claude-code", "type": "feedback", "project": "harbor", "path": "/m/other.md", "name": "other", "description": "别的项目", "body": "", "mtime": 0},
        ]
        with patch.object(prefs, "from_memory", lambda project="", agents=("claude-code",), entries=None, _m=prefs.from_memory: _m(project, agents, memory)):
            plan = prefs.plan_import(["facts", "memory", "taste"], project="kanban", cwd=self.proj)
        self.assertFalse(os.path.exists(self.home))
        texts = [it["text"] for it in plan["items"]]
        # 要 / 不要 split into one preference each; the pointer to the full document is left out
        # FACTS's 要 / 不要 pieces joined the fuller design/taste items they sum up
        grouped = next(it for it in plan["items"] if it["text"].startswith("列表先分类"))
        self.assertEqual(sorted({s["kind"] for s in grouped["sources"]}), ["facts", "taste"])
        self.assertNotIn("列表先分组，组能收起。", texts)
        self.assertIn("首屏先给重点。", texts)
        self.assertTrue(any("先读全文" in s["text"] for s in plan["skipped"]))
        # a dated decision splits into its sentences, the Dispatch one scoped to the project
        toggle = next(it for it in plan["items"] if "方角" in it["text"])
        self.assertEqual((toggle["polarity"], toggle["area"]), ("avoid", "design"))
        tasks = next(it for it in plan["items"] if "紧凑卡" in it["text"])
        self.assertEqual(tasks["scope"], "kanban")
        self.assertEqual(tasks["said_at"], "2026-09-27")
        # taste: the bold lead is the short name, figures are evidence, quotes are kept
        cat = next(it for it in plan["items"] if it["name"] == "列表先分类")
        self.assertEqual(cat["area"], "design")
        mixed = next(it for it in plan["items"] if "来源" in it["text"])
        self.assertEqual(mixed["polarity"], "avoid")
        self.assertEqual(mixed["evidence"], [self.fig])
        shots = next(it for it in plan["items"] if "对比截图" in it["text"])
        self.assertEqual(shots["quote"], "我没看到你改了哪里，你能截图对比吗？")
        # memory: feedback only, this project only, with the words
        ids = next(it for it in plan["items"] if "task-xxxx" in it["text"])
        self.assertEqual(ids["quote"], "我希望以后对于用户来说，他看不到 task-9bgm 类似的东西")
        self.assertTrue(any("type project" in s["why"] for s in plan["skipped"]))
        self.assertFalse(any("别的项目" in t for t in texts))
        # two places saying the same thing become one item with both sources
        first = next(it for it in plan["items"] if it["text"].startswith("首屏") or "一个功能一个入口" in it["text"])
        self.assertTrue(first)
        # the sayings that are facts about work stay out of Design
        self.assertEqual(next(it for it in plan["items"] if "字段名" in it["text"])["area"], "workflow")
        # clear ones first; a direction picked for one of Dispatch's screens waits for the person
        self.assertFalse(tasks["sure"])
        self.assertIn("Dispatch's screens", tasks["why"])
        self.assertTrue(toggle["sure"])
        self.assertTrue(ids["sure"])
        self.assertEqual([it["n"] for it in plan["items"]], list(range(1, len(plan["items"]) + 1)))
        self.assertTrue(all(it["sure"] for it in plan["items"][:sum(1 for x in plan["items"] if x["sure"])]))
        # FACTS's 要 / 不要 pieces joined the design/taste items they sum up
        first = next(it for it in plan["items"] if it["name"] == "一个功能一个入口")
        self.assertEqual(sorted({s["kind"] for s in first["sources"]}), ["facts", "taste"])

    def test_sure_only_leaves_the_rest_for_a_pick(self):
        plan = prefs.plan_import(["facts", "taste"], cwd=self.proj)
        unsure = [it["n"] for it in plan["items"] if not it["sure"]]
        self.assertTrue(unsure)
        res = prefs.apply_import(plan, cwd=self.proj, sure_only=True)
        self.assertEqual(len(prefs.load()), len(plan["items"]) - len(unsure))
        self.assertEqual([it["n"] for it in res["held"]], unsure)
        pending = json.load(open(prefs.pending_path(), encoding="utf-8"))
        self.assertEqual([it["n"] for it in pending["items"]], unsure)
        # the topic an item still waits in stays a fact for prime until it is decided
        self.assertEqual(prefs.imported_topics(), {"我常说的话"})
        # the morning: the person picks one of them by its number
        res = prefs.apply_import(pending, cwd=self.proj, picks=str(unsure[0]))
        self.assertEqual(len(res["imported"]), 1)
        self.assertEqual(len(prefs.load()), len(plan["items"]) - len(unsure) + 1)
        with self.assertRaises(prefs.PrefsError):
            prefs.pick_items(pending, "three")
        rest = json.load(open(prefs.pending_path(), encoding="utf-8"))
        self.assertEqual([it["n"] for it in rest["items"]], unsure[1:])

    def test_apply_writes_marked_imported_and_leaves_the_sources_alone(self):
        before = open(self.facts, encoding="utf-8").read()
        plan = prefs.plan_import(["facts", "taste"], cwd=self.proj)
        res = prefs.apply_import(plan, cwd=self.proj)
        entries = prefs.load()
        self.assertEqual(len(entries), len(plan["items"]))
        self.assertTrue(all(e.get("imported") and e["seen"] and e["sources"] for e in entries))
        self.assertEqual(open(self.facts, encoding="utf-8").read(), before)
        log = json.load(open(prefs.imports_path(), encoding="utf-8"))
        self.assertEqual(log[-1]["items"], len(entries))
        self.assertTrue(log[-1]["sources_may_change_after"] > log[-1]["at"])
        self.assertEqual(res["merged"], [])
        # the topics that moved stop being given as facts by prime, under either name of the design one
        self.assertEqual(prefs.imported_topics(entries), {"我的设计偏好", "Design preferences", "我常说的话"})
        # importing again adds nothing new and marks nothing as new
        again = prefs.apply_import(prefs.plan_import(["facts", "taste"], cwd=self.proj), cwd=self.proj)
        self.assertEqual(len(prefs.load()), len(entries))
        self.assertEqual((again["imported"], again["merged"]), ([], []))
        self.assertTrue(all(e["seen"] and len(e["history"]) == 1 for e in prefs.load()))


    def test_english_headings_read_the_same(self):
        # FACTS.md and PROFILE.md after Dispatch rewrote their headings in English
        zh, _ = prefs.from_facts(self.facts)
        en_path = os.path.join(self.tmp, "FACTS-en.md")
        with open(en_path, "w", encoding="utf-8") as fh:
            fh.write(FACTS.replace("# 常用信息", "# Facts").replace("## 通用", "## General").replace("**我的设计偏好", "**Design preferences"))
        en, _ = prefs.from_facts(en_path)
        self.assertEqual([c["text"] for c in en], [c["text"] for c in zh])
        self.assertIn("FACTS.md · Design preferences", {s["label"] for c in en for s in c["sources"]})
        profile = os.path.join(self.tmp, "PROFILE-en.md")
        with open(profile, "w", encoding="utf-8") as fh:
            fh.write("# Profile\n\n## Who I am\n- 喜欢方角开关（2026-09-27 · claude-code）\n\n## Upcoming\n- 2026-10-18|剪映续费前 · 决定续不续\n")
        (c,), _ = prefs.from_profile(profile)
        self.assertEqual((c["text"], c["sources"][0]["label"]), ("喜欢方角开关。", "PROFILE.md · Who I am"))


class Command(Base):
    def test_add_list_forget_undo_through_the_cli(self):
        code, out = self.cli("add", "会话头像不用字母，用 Claude、Codex 的图标。", "--avoid", "--name", "字母头像", "--area", "design", "--scope", "kanban", "--quote", "那个X，换成 Codex 的图标", "--json")
        self.assertEqual(code, 0)
        pid = out["remembered"][0]["id"]
        self.assertTrue(out["toast"].startswith("Preference remembered · 会话头像"))
        code, text = self.cli("add", "汇报先说结论。", "--like", "--area", "writing")
        self.assertIn("Preference remembered · 汇报先说结论", text)
        self.assertRegex(text, r"\(pref-[a-z0-9]{4}\)")
        # the id is for commands; the reply names it by its short name
        self.assertIn("in your reply call it 「汇报先说结论」, not by the id", text.splitlines()[-1])
        # the window reads the id from the output (sessions-preferences.patch, ADDED_ONE); an agent that keeps
        # only the last three lines still leaves it
        added_one = re.compile(r"^(?:Preference remembered|Already remembered) · .* \((pref-[a-z0-9]{4,10})\)\s*$")
        ids = [m.group(1) for m in map(added_one.match, text.rstrip().splitlines()[-3:]) if m]
        self.assertEqual(len(ids), 1)
        self.assertEqual(prefs.find(prefs.load(), ids[0])["text"], "汇报先说结论。")
        code, out = self.cli("list", "--json")
        self.assertEqual(out["counts"]["active"], 2)
        self.assertEqual(out["counts"]["new"], 2)
        code, out = self.cli("forget", pid, "--json")
        self.assertEqual(out["forgotten"][0]["name"], "字母头像")
        code, out = self.cli("list", "--ids", pid, "--json")
        self.assertEqual(out["items"][0]["status"], "forgotten")
        code, out = self.cli("undo", "--json")
        self.assertEqual(out["restored"][0]["id"], pid)
        # the window takes an undo that brings one back as remembered again (sessions-preferences.patch, BACK)
        self.cli("forget", pid)
        code, text = self.cli("undo", pid)
        back = [l for l in text.splitlines() if l.startswith("Back · ")]
        self.assertEqual(re.findall(r"\((pref-[a-z0-9]{4,10})\)", back[0]), [pid])
        code, out = self.cli("show", "字母头像", "--json")
        self.assertEqual(out["pref"]["quote"], "那个X，换成 Codex 的图标")
        code, out = self.cli("show", "没有", "--json")
        self.assertEqual((code, out["ok"]), (1, False))

    def test_batch_add(self):
        lines = "\n".join(json.dumps(x, ensure_ascii=False) for x in (
            {"text": "Tasks 页签用紧凑卡。", "polarity": "like", "name": "Tasks 紧凑卡", "area": "design", "scope": "kanban"},
            {"text": "Only you 能点开看前因后果。", "polarity": "like", "name": "点开看前因后果", "area": "design"},
            {"text": "会话头像不用字母。", "polarity": "avoid", "name": "字母头像", "area": "design"}))
        code, text = self.cli("add", "--batch", stdin=lines)
        self.assertEqual(code, 0)
        self.assertTrue(text.startswith("3 preferences remembered · Tasks 紧凑卡, 点开看前因后果 and 1 more"))
        self.assertIn("in your reply call them 「Tasks 紧凑卡」、「点开看前因后果」、「字母头像」", text.splitlines()[0])
        self.assertEqual(len(prefs.load()), 3)


    def test_batch_takes_kind_and_refuses_a_row_without_like_or_avoid(self):
        lines = "\n".join(json.dumps(x, ensure_ascii=False) for x in (
            {"text": "手机 App 不做语音输入。", "kind": "avoid", "name": "手机不做语音", "area": "workflow"},
            {"text": "多用动效和符号表达状态。", "kind": "like", "name": "多用动效", "area": "design"}))
        code, _ = self.cli("add", "--batch", stdin=lines)
        self.assertEqual(code, 0)
        got = {p["name"]: p["polarity"] for p in prefs.load()}
        self.assertEqual(got, {"手机不做语音": "avoid", "多用动效": "like"})
        code, _ = self.cli("add", "--batch", stdin=json.dumps({"text": "没说好坏。", "name": "x"}))
        self.assertNotEqual(code, 0)
        self.assertEqual(len(prefs.load()), 2)

class Prime(Base):
    def run_prime(self, hook=None, opencode=False, actor=""):
        import dispatch

        def sh(args, timeout=20, env=None):
            return (0, "[]", "") if args[:2] == ["bd", "list"] else (0, "{}", "")

        out = io.StringIO()
        a = types.SimpleNamespace(cwd=self.proj, hook_json=hook is not None, opencode=opencode)
        stdin = io.StringIO(json.dumps(hook or {}))
        stdin.isatty = lambda: False
        with contextlib.redirect_stdout(out), patch("sys.stdin", stdin), patch.dict(os.environ, {"CODEX_THREAD_ID": "", "BEADS_ACTOR": actor, "DISPATCH_ACTOR": ""}), \
                patch.object(dispatch, "sh", sh), patch.object(dispatch, "FACTS_FILE", self.facts), patch.object(dispatch, "DISPATCH_DIR", self.home), \
                patch.object(dispatch, "neighbours", lambda *a, **k: []), patch.object(dispatch, "starred_sessions", lambda *a, **k: []), \
                patch.object(dispatch, "wiki_all", lambda: []), patch.object(dispatch, "project_of_cwd", lambda cwd, names, roots=None: "kanban"):
            dispatch.cmd_prime(a)
        return out.getvalue()

    def test_prime_gives_the_preferences_and_none_of_the_rules(self):
        self.add("会话头像不用字母，用 Claude、Codex 的图标。", polarity="avoid", name="字母头像", area="design", scope="kanban")
        text = self.run_prime()
        self.assertEqual(text.split("\n")[0], "# Dispatch · 当前项目 kanban")
        self.assertIn("## 偏好（用户的；kanban + 全局，1 条", text)
        self.assertIn("- 字母头像：会话头像不用字母，用 Claude、Codex 的图标。", text)
        # the rules ride in the rules files; the facts and the sayings are one command away
        self.assertNotIn("dispatch begin", text)
        self.assertNotIn("记新的", text)
        self.assertNotIn("## 常用信息", text)
        self.assertNotIn("课件、真题是版权材料", text)
        self.assertIn("`dispatch facts get <主题词>`", text.splitlines()[-1])
        # the same brief for every engine, as JSON for a hook and as text for OpenCode
        ctx = json.loads(self.run_prime({"session_id": "s", "cwd": self.proj, "transcript_path": "/Users/x/.codex/sessions/2026/09/28/rollout-1.jsonl"}))
        self.assertEqual(ctx["hookSpecificOutput"]["additionalContext"] + "\n", text)
        self.assertTrue(self.run_prime(opencode=True, actor="opencode").startswith("# Dispatch · 当前项目 kanban · 你是 opencode"))
        # 40 long preferences: the section keeps to its share, and says how many are left
        words = "列表 输入框 弹层 侧栏 标题栏 按钮 图标 表格 卡片 菜单 页签 提示 进度条 空状态 搜索框 头像 徽标 分组头 时间线 看板".split()
        for i in range(40):
            self.add(f"{words[i % 20]}和{words[(i * 7 + 3) % 20]}要照第{i * 13 % 97}号样子做，行高间距跟着它，不要用别的样子，说清楚在哪一页。", polarity="like", area="design", name=f"长偏好{i}")
        text = self.run_prime()
        self.assertIn("还有", text.split("## 偏好")[1].splitlines()[0])
        self.assertLessEqual(len(text.encode("utf-8")), 9000)


class Words(unittest.TestCase):
    def test_similarity_names_and_scopes(self):
        self.assertGreater(prefs.similarity("开关和分段控件用稍微圆的方角，不要整圆胶囊", "开关和分段控件用稍微圆的方角，和右栏页签一样，不要整圆胶囊"), prefs.SAME)
        self.assertLess(prefs.similarity("开关用方角", "汇报先说结论"), prefs.CLOSE)
        self.assertLess(prefs.same_thing("喜欢的点：场景铺得全。", "不喜欢的点：小标题混淆。"), prefs.SAME)
        self.assertEqual(prefs.derive_name("开关和分段控件用稍微圆的方角，不要整圆胶囊"), "开关和分段控件用稍微圆")
        self.assertEqual(prefs.derive_name("Waiting for you 用「按紧急度分段」"), "Waiting for you")
        self.assertEqual(prefs.scope_parse(""), "everywhere")
        self.assertEqual(prefs.scope_parse("kanban : Tasks tab"), "kanban:Tasks tab")
        self.assertEqual(prefs.scope_label("kanban:Tasks tab"), "kanban · Tasks tab")
        self.assertEqual([prefs.scope_rank(s) for s in ("everywhere", "kanban", "kanban:x")], [0, 1, 2])
        self.assertEqual(prefs.guess_polarity("会话头像不用字母"), "avoid")
        self.assertEqual(prefs.guess_polarity("汇报先说结论，结尾不挂菜单"), "like")
        self.assertEqual(prefs.guess_area("派子 Agent 用 Opus 5.5"), "tools")


if __name__ == "__main__":
    unittest.main()
