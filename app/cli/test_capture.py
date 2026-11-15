# -*- coding: utf-8 -*-
"""capture.py: what the person asks for in a chat goes on the board by itself and lines up (task-tix5).

The board is a small stand-in that understands the bd calls capture.py makes (create, update, comments add,
show); the model is a stand-in that returns what a model would. Real messages from the design's table are the
test questions: a new thing, the same thing again, a step on an open task, a question, a "let's not", chit-chat.
"""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import capture as C  # noqa: E402
import tasks_view as TV  # noqa: E402
import assistant_survey as AS  # noqa: E402


class Board:
    def __init__(self):
        self.issues = {}
        self.n = 0
        self.calls = []

    def add(self, title, status="open", labels=(), metadata=None, project=""):
        self.n += 1
        tid = f"task-{self.n}"
        ls = list(labels) + ([f"project:{project}"] if project else [])
        self.issues[tid] = {"id": tid, "title": title, "status": status, "labels": ls, "metadata": dict(metadata or {}),
                            "created_at": f"2026-10-0{min(self.n, 9)}T10:00:00Z", "updated_at": f"2026-10-0{min(self.n, 9)}T10:00:00Z", "comments": []}
        return tid

    def sh(self, args, timeout=20, env=None):
        assert args[0] == "bd", args
        a = args[1:]
        self.calls.append(a)
        op = a[0]
        if op == "create":
            title = a[1]
            ls = a[a.index("-l") + 1].split(",") if "-l" in a else []
            m = json.loads(a[a.index("--metadata") + 1]) if "--metadata" in a else {}
            tid = self.add(title, labels=ls, metadata=m)
            if "--description" in a:
                self.issues[tid]["description"] = a[a.index("--description") + 1]
            return 0, json.dumps(self.issues[tid]), ""
        if op == "update":
            t = self.issues[a[1]]
            i = 2
            while i < len(a):
                k = a[i]
                if k == "--claim":
                    t["status"] = "in_progress"
                    i += 1
                    continue
                if k == "--json":
                    i += 1
                    continue
                v = a[i + 1]
                if k == "--status":
                    t["status"] = v
                elif k == "--assignee":
                    t["assignee"] = v
                elif k == "--add-label":
                    if v not in t["labels"]:
                        t["labels"].append(v)
                elif k == "--remove-label":
                    t["labels"] = [x for x in t["labels"] if x != v]
                elif k == "--title":
                    t["title"] = v
                elif k == "--metadata":
                    t["metadata"] = json.loads(v)
                elif k == "--set-metadata":
                    kk, vv = v.split("=", 1)
                    t["metadata"][kk] = vv
                i += 2
            return 0, json.dumps(t), ""
        if op == "comments":
            self.issues[a[2]]["comments"].append({"text": a[3], "created_at": "2026-10-06T10:00:00Z"})
            return 0, "", ""
        if op == "show":
            return 0, json.dumps([self.issues[a[1]]]), ""
        if op == "list":  # filtered the way bd does (board_service answers these lists the same way)
            import board_service
            q = board_service.snapshot_query(a)
            assert q is not None, a
            return 0, json.dumps(board_service.snapshot_rows(list(self.issues.values()), q)), ""
        raise AssertionError(f"unexpected bd call {a}")

    def export(self):
        return [json.loads(json.dumps(t)) for t in self.issues.values()]


class Model:
    """A stand-in for summarize: provider, use switch and the answer a model would give."""
    def __init__(self, answer=None, on=True, provider=True):
        self.answer, self.on, self.has = answer, on, provider
        self.asked = []

    PROVIDERS = [("ZHIPU_API_KEY", "zhipu", "https://open.bigmodel.cn/api/coding/paas/v4", "glm-5.3-flash"),
                 ("DEEPSEEK_API_KEY", "deepseek", "https://api.deepseek.com/v1", "deepseek-chat")]

    def use_enabled(self, key):
        return self.on

    def retired_providers(self):
        return set()

    def provider(self, model=""):
        return {"id": "zhipu", "model": "glm-5.3-flash", "key": "x", "base": "b"} if self.has else None

    def chat(self, p, system, user, **kw):
        self.asked.append(json.loads(user))
        if isinstance(self.answer, Exception):
            raise self.answer
        return json.dumps(self.answer) if not isinstance(self.answer, str) else self.answer


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        p = patch.object(C, "MAP_WAIT", 0)  # a turn's end does not wait for the window here (one test turns it on)
        p.start()
        self.addCleanup(p.stop)
        self.board = Board()
        self.model = Model({"things": [], "left_out": []})
        self.proj_dir = os.path.join(self.tmp, "shop")
        os.makedirs(self.proj_dir)
        self.started = []
        mods = {"summarize": self.model, "tasks_view": TV, "assistant_survey": AS,
                "projects_view": types.SimpleNamespace(D=None, registry=lambda resolve_dirs=False: [{"name": "shop", "dir": self.proj_dir}])}
        self.D = types.SimpleNamespace(DISPATCH_DIR=self.tmp, sh=self.board.sh, debug=lambda w, e: None, _mod=lambda n: mods.get(n) or __import__(n),
                                       local_host_name=lambda: "mac", project_home=lambda p, *a, **k: self.proj_dir if p == "shop" else "",
                                       out=lambda r, j, f: None, settings_load=lambda: {}, env_read=lambda: [])
        for mod in (C, TV, AS):
            p = patch.object(mod, "D", self.D)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(TV, "board_export", self.board.export)
        p.start()
        self.addCleanup(p.stop)
        from engines import opencode as OC
        p = patch.object(OC, "AUTH", os.path.join(self.tmp, "no-opencode", "auth.json"))
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(C, "is_assistant", lambda cwd: cwd == "/assistant")
        p.start()
        self.addCleanup(p.stop)

    def say(self, text, answer=None, cwd=None, session="agent-host-claude:/x/sess-12345678", now=1_800_000_000):
        if answer is not None:
            self.model.answer = answer
        return C.note(session, text, cwd=self.proj_dir if cwd is None else cwd, now=now)


class Rules(unittest.TestCase):
    def test_chit_chat_questions_and_lets_not_need_no_model(self):
        for t in ("ok", "好的", "继续", "Thanks!", "go on", "嗯嗯", "LGTM."):
            self.assertEqual(C.quick(t), "chat", t)
        self.assertEqual(C.quick("我想知道这个软件是如何获取到我 GitHub 上的头像的？"), "question")
        self.assertEqual(C.quick("What is running right now?"), "question")
        self.assertEqual(C.quick("语音这个的话我们就不弄了"), "not_doing")
        self.assertIsNone(C.quick("Can you make the settings page remember the last tab?"))
        self.assertIsNone(C.quick("我们在对话框里面按了一下之后 键盘弹起来了 但是 内容没有跟着上去"))
        self.assertEqual(C.rule_title("Please make the export button bigger. It is hard to hit."), "make the export button bigger")


class Noting(Base):
    def test_two_new_things_go_on_the_board_in_line_with_the_persons_words(self):
        r = self.say("The settings page should remember the last tab. Also the about page needs a dark mode toggle.", {"things": [
            {"kind": "new", "title": "Settings page remembers the last tab", "quote": "The settings page should remember the last tab."},
            {"kind": "new", "title": "Dark mode toggle on the about page", "quote": "the about page needs a dark mode toggle"}], "left_out": []})
        self.assertEqual(r["count"], 2)
        self.assertEqual([i["state"] for i in r["items"]], ["next", "next"])
        self.assertEqual([i["pos"] for i in r["items"]], [1, 2])
        self.assertEqual(r["next_pos"], 1)
        t1 = self.board.issues[r["items"][0]["task"]]
        self.assertIn("from-chat", t1["labels"])
        self.assertIn("nextup", t1["labels"])
        self.assertIn("project:shop", t1["labels"])
        self.assertIn("session-origin:sess-12345678", t1["labels"])
        self.assertEqual(t1["status"], "open")  # nobody claims it: it waits in line
        self.assertIn("「The settings page should remember the last tab.」", t1["description"])
        self.assertEqual(t1["metadata"]["chat"]["quote"], "The settings page should remember the last tab.")
        self.assertEqual(self.model.asked[0]["CONVERSATION"], "project session")
        self.assertTrue(r["first"])  # the first time, one sentence says what this is
        C.seen()
        self.assertFalse(C.receipts()["receipts"][0]["first"])

    def test_the_same_work_again_only_adds_their_words_there(self):
        old = self.board.add("动效和符号", project="shop")
        r = self.say("多一点图标 让 Designer 也设计一版 我看一下", {"things": [{"kind": "same", "task": old, "quote": "多一点图标", "title": ""}], "left_out": []})
        self.assertEqual([(i["kind"], i["task"]) for i in r["items"]], [("same", old)])
        self.assertEqual(len(self.board.issues), 1)
        self.assertIn("多一点图标", self.board.issues[old]["comments"][0]["text"])

    def test_the_board_catches_a_duplicate_the_model_called_new(self):
        old = self.board.add("Fix the RSS feed dates for old posts", project="shop")
        r = self.say("fix the RSS feed dates please", {"things": [{"kind": "new", "title": "Fix the RSS feed dates", "quote": "fix the RSS feed dates"}], "left_out": []})
        self.assertEqual(r["items"][0]["kind"], "same")
        self.assertEqual(r["items"][0]["task"], old)
        self.assertEqual(len(self.board.issues), 1)

    def test_without_a_model_a_request_for_work_already_open_is_the_same(self):
        # the Assistant's way of asking (assistant-live on a Mac without a capture model): the rules take the whole
        # sentence as the title, so half its words in an open task is enough, three words at least
        self.model.has = False
        old = self.board.add("notes-site follow up the open items in NOTES.md: Fix the RSS feed dates for posts before 2020 and add a dark mode toggle", project="shop")
        r = self.say("Put fixing the RSS feed dates in notes-site on my board.")
        self.assertEqual([(i["kind"], i["task"]) for i in r["items"]], [("same", old)])
        r = self.say("Oh and the RSS dates in notes-site need fixing, add that.", now=1_800_000_200)
        self.assertEqual([(i["kind"], i["task"]) for i in r["items"]], [("same", old)])
        self.assertEqual(len(self.board.issues), 1)
        # two shared words are not enough, and a model's own "new" keeps the stricter bar
        r = self.say("Make the RSS icon orange.", cwd="/assistant", now=1_800_000_400)
        self.assertEqual(r["items"][0]["kind"], "new")
        self.model.has = True
        r = self.say("the feed dates in notes-site", {"things": [{"kind": "new", "title": "Feed dates on the archive page of notes-site", "quote": "the feed dates"}], "left_out": []}, now=1_800_000_600)
        self.assertEqual(r["items"][0]["kind"], "new")

    def test_a_follow_up_is_a_step_on_the_open_task(self):
        old = self.board.add("手机 App 改用 Orca 的技术栈", project="shop", status="in_progress")
        r = self.say("那手机上的这些功能 也可以都加上", {"things": [{"kind": "part", "task": old, "title": "一键处理等你处理", "quote": "那手机上的这些功能 也可以都加上"}], "left_out": []})
        self.assertEqual(r["items"][0]["kind"], "part")
        self.assertEqual(self.board.issues[old]["metadata"]["plan"], [{"text": "一键处理等你处理", "state": "todo"}])

    def test_questions_and_chit_chat_are_left_out_without_a_task(self):
        r = self.say("我想知道这个软件是如何获取到我 GitHub 上的头像的？")
        self.assertEqual(r["items"], [])
        self.assertEqual(r["left_out"][0]["kind"], "question")
        self.assertEqual(self.model.asked, [])
        r = self.say("好的", now=1_800_000_100)
        self.assertEqual((r["items"], r["left_out"]), ([], []))
        self.assertEqual(self.board.issues, {})
        self.assertEqual(C.receipts()["receipts"], [r for r in C.receipts()["receipts"] if r["left_out"]])  # chit-chat leaves no receipt to show

    def test_not_now_is_not_left_out_as_not_doing(self):
        r = self.say("Two things for later: a CSV export and a print button. Do not do them now. And forget the voice input.", {"things": [
            {"kind": "new", "title": "CSV export", "quote": "a CSV export"}, {"kind": "new", "title": "Print button", "quote": "a print button"}],
            "left_out": [{"kind": "not_doing", "quote": "Do not do them now"}, {"kind": "not_doing", "quote": "forget the voice input"}]})
        self.assertEqual([x["quote"] for x in r["left_out"]], ["forget the voice input"])

    def test_the_same_message_twice_is_one_receipt(self):
        a = self.say("Make the export button bigger", {"things": [{"kind": "new", "title": "Bigger export button", "quote": "Make the export button bigger"}], "left_out": []})
        b = self.say("Make the export button bigger", now=1_800_000_030)
        self.assertEqual(a["id"], b["id"])
        self.assertEqual(len(self.board.issues), 1)

    def test_without_a_model_the_message_is_one_thing(self):
        self.model.has = False
        r = self.say("Please make the export button bigger. It is hard to hit on the phone.", cwd="/assistant")
        self.assertEqual([(i["kind"], i["title"]) for i in r["items"]], [("new", "make the export button bigger")])

    def test_without_a_model_a_message_to_the_session_is_left_to_its_agent(self):
        """task-dctuo:「还是不懂干嘛的 讲的简单点」 sent to a working session stood on hold in Next up; claimed for the agent
        instead it stayed in progress with nothing to settle it (review 10-22). Without a model nothing tells a request
        from a question: the conversation's agent files its own task."""
        self.model.has = False
        r = self.say("还是不懂干嘛的 讲的简单点")
        self.assertEqual(r["items"], [])
        self.assertEqual(len(self.board.issues), 0)
        self.assertEqual(C.queue_view()["next"], [])
        self.assertIn("files its own task", r["left_out"][0]["why"])
        self.assertEqual(r["left_out"][0]["kind"], "for_agent")
        # the text receipt prints it (second review 10-22: it raised KeyError: 'kind')
        with contextlib.redirect_stdout(io.StringIO()) as out:
            C._note_text(r)
        self.assertIn("Left out (for_agent)", out.getvalue())

    def test_the_model_is_asked_for_every_thing_this_conversation_should_do(self):
        self.assertIn("now: true for each thing the person asks this conversation's agent to do", C.PROMPT)

    def test_a_broken_answer_falls_back_to_the_rules(self):
        r = self.say("Rename the orders table to purchases", "not json at all", cwd="/assistant")
        self.assertEqual(r["by"], "rules")
        self.assertEqual(r["count"], 1)

    def test_turned_off_notes_nothing(self):
        self.model.on = False
        r = self.say("Rename the orders table to purchases")
        self.assertEqual((r["items"], len(self.board.issues)), ([], 0))

    def test_what_this_session_does_now_is_claimed_not_lined_up(self):
        r = self.say("Fix the login bug, and later we should add a CSV export.", {"things": [
            {"kind": "new", "title": "Fix the login bug", "quote": "Fix the login bug", "now": True},
            {"kind": "new", "title": "CSV export", "quote": "later we should add a CSV export"}], "left_out": []})
        # "later" says it is for another time: Later, not lined up to start by itself (task-9rxf)
        self.assertEqual([i["state"] for i in r["items"]], ["working", "later"])
        now = self.board.issues[r["items"][0]["task"]]
        self.assertIn("session:sess-12345678", now["labels"])
        self.assertNotIn("nextup", now["labels"])
        self.assertTrue(now["metadata"]["chat"]["now"])
        # claimed under the conversation's agent, not the person: its claim and close are never refused as someone
        # else's (task-lz5wc: task-pghfa sat under schaefer and the agent could neither take nor close it)
        self.assertEqual((now["assignee"], now["status"]), ("claude-code", "in_progress"))
        self.assertNotIn(["update", now["id"], "--claim", "--json"], self.board.calls)

    def test_some_day_not_now_goes_to_later_and_never_starts(self):
        """task-9rxf:「some day (not now) I would like a dark mode」 was lined up and started while the session ran."""
        r = self.say("Change the h1 color to navy. Separately, some day (not now) I would like a dark mode, and later a footer. Also fix the RSS feed", {"things": [
            {"kind": "new", "title": "Change the h1 color to navy", "quote": "Change the h1 color to navy", "now": True},
            {"kind": "new", "title": "Add dark mode", "quote": "some day (not now) I would like a dark mode"},
            {"kind": "new", "title": "Add a footer", "quote": "and later a footer"},
            {"kind": "new", "title": "Fix the RSS feed", "quote": "also fix the RSS feed"}], "left_out": []})
        self.assertEqual([i["state"] for i in r["items"]], ["working", "later", "later", "next"])
        v = C.queue_view()
        self.assertEqual([x["title"] for x in v["next"]], ["Fix the RSS feed"])
        self.assertEqual(sorted(x["title"] for x in v["later"]), ["Add a footer", "Add dark mode"])
        # the model said so too, with no telling word in the quote
        r = self.say("A changelog page would be nice", {"things": [{"kind": "new", "title": "Changelog page", "quote": "A changelog page would be nice", "later": True}], "left_out": []}, now=1_800_000_900)
        self.assertEqual(r["items"][0]["state"], "later")
        # without a model the rules read the words
        self.model.has = False
        r = self.say("Some day add a print stylesheet to the shop", now=1_800_001_900)
        self.assertEqual((r["by"], r["items"][0]["state"]), ("rules", "later"))

    def test_start_by_itself_is_off_for_a_new_person(self):
        """task-9rxf: a new person's Next up waits; nothing starts until they turn Start by itself on."""
        self.say("Also fix the RSS feed dates", {"things": [{"kind": "new", "title": "Fix the RSS feed dates", "quote": "Also fix the RSS feed dates"}], "left_out": []})
        self.assertTrue(C.queue_state()["paused"])
        self.assertTrue(C.settings_view()["paused"])
        self.assertEqual(C.tick(now=100, start=lambda t, q: self.fail("started by itself"), working=lambda: [])["reason"], "paused")
        C.set_paused(False)
        self.assertFalse(C.queue_state()["paused"])
        self.assertTrue(C.tick(now=200, start=lambda t, q: None, working=lambda: [])["started"])

    def test_the_assistant_lines_everything_up_and_the_model_picks_the_project(self):
        r = self.say("shop 的结账页优惠码输入框太小了", {"things": [{"kind": "new", "title": "放大结账页优惠码输入框", "quote": "结账页优惠码输入框太小了", "project": "shop", "now": True}], "left_out": []},
                     cwd="/assistant")
        it = r["items"][0]
        self.assertEqual((it["state"], it["project"]), ("next", "shop"))
        self.assertEqual(self.model.asked[0]["CONVERSATION"], "assistant")

    def test_the_assistant_files_a_project_the_model_chose_only_when_the_person_named_it(self):
        """2026-10-11: "找手机设计稿" said in the Assistant was filed under the model's guess 手机ai摄影."""
        said = {"things": [{"kind": "new", "title": "找手机设计稿", "quote": "找手机设计稿", "project": "shop"}], "left_out": []}
        r = self.say("找手机设计稿", said, cwd="/assistant")
        self.assertEqual(r["items"][0]["project"], "")
        # named in the words (any case): kept
        said = {"things": [{"kind": "new", "title": "Check the Shop footer", "quote": "check the Shop footer", "project": "shop"}], "left_out": []}
        r = self.say("check the Shop footer", said, cwd="/assistant", now=1_800_000_500)
        self.assertEqual(r["items"][0]["project"], "shop")


class DispatchsOwnWords(Base):
    """task-6degw: what Dispatch sends in the person's place ("Let the agent fix it", a handoff) is not their request."""

    def setUp(self):
        super().setUp()
        p = patch.dict(os.environ, {"DISPATCH_DIR": self.tmp})
        p.start()
        self.addCleanup(p.stop)

    def test_the_fix_it_prompt_is_not_noted(self):
        import fixit
        import own_prompts
        problem = fixit.explain_commit(self.proj_dir, "Author identity unknown\n*** Please tell me who you are.\nfatal: unable to auto-detect email address", "Add notes")
        self.assertTrue(problem["fixable"])
        self.assertTrue(own_prompts.is_own(problem["prompt"]))
        answer = {"things": [{"kind": "new", "title": "Set the git name and email", "quote": "Fix the failed commit", "now": True}], "left_out": []}
        r = self.say(problem["prompt"], answer, now=time.time())
        self.assertEqual(r["items"], [])
        self.assertEqual(self.board.issues, {})
        self.assertEqual(self.model.asked, [])  # not even read
        # the same words typed again a minute later by the person are still Dispatch's: nothing
        r = self.say("  " + problem["prompt"].replace("\n", "\n "), answer, now=time.time() + 60)
        self.assertEqual(r["items"], [])

    def test_the_answer_to_what_the_fix_made_the_agent_ask_comes_with_that_prompt(self):
        import own_prompts
        prompt = "Fix the failed commit in \"/x\" so I can commit again.\n\nGit does not know my name and email yet."
        own_prompts.remember(prompt)
        now = time.time()
        self.say(prompt, now=now)
        self.say("Anjon Schaefer, anjon@example.com", {"things": [], "left_out": []}, now=now + 90)
        self.assertIn("Git does not know my name and email yet.", self.model.asked[-1]["AGENT'S LAST REPLY"])

    def test_an_english_message_gets_an_english_title(self):
        """task-7lptn: 3 of 4 titles noted from English messages came out Chinese."""
        r = self.say("Add a dark mode to the notes page please", {"things": [{"kind": "new", "title": "笔记页加深色模式", "quote": "Add a dark mode to the notes page"}], "left_out": []}, now=time.time())
        self.assertEqual(r["items"][0]["title"], "Add a dark mode to the notes page")
        r = self.say("笔记页要有深色模式", {"things": [{"kind": "new", "title": "笔记页深色模式", "quote": "笔记页要有深色模式"}], "left_out": []}, now=time.time() + 5)
        self.assertEqual(r["items"][0]["title"], "笔记页深色模式")

    def test_the_persons_own_message_is_still_noted(self):
        import own_prompts
        own_prompts.remember("Fix the failed commit in /tmp/x so I can commit again.")
        r = self.say("Add a dark mode to the notes page", {"things": [{"kind": "new", "title": "Dark mode for the notes page", "quote": "Add a dark mode"}], "left_out": []}, now=time.time())
        self.assertEqual(len(r["items"]), 1)

    def test_a_handoff_reads_only_what_the_person_typed_into_it(self):
        import own_prompts
        msg = "This conversation moved from Claude Code to OpenCode. Earlier context: …\n\nGo on with: add a search box to the list"
        own_prompts.remember(msg, user="add a search box to the list")
        r = self.say(msg, {"things": [{"kind": "new", "title": "Search box on the list", "quote": "add a search box to the list"}], "left_out": []}, now=time.time())
        self.assertEqual(len(r["items"]), 1)
        self.assertEqual(self.model.asked[0]["MESSAGE"], "add a search box to the list")

    def test_remembered_words_expire_after_a_week(self):
        import own_prompts
        own_prompts.remember("Do the automatic tidy-up check.", now=1_000)
        self.assertTrue(own_prompts.is_own("Do the  automatic tidy-up check.", now=1_000 + 3600))
        self.assertFalse(own_prompts.is_own("Do the automatic tidy-up check.", now=1_000 + own_prompts.KEEP_S + 1))


class Where(Base):
    def test_a_sessions_worktree_belongs_to_its_project(self):
        import subprocess
        run = lambda *a: subprocess.run(["git", "-C", self.proj_dir, "-c", "user.email=t@t", "-c", "user.name=t", *a], check=True, capture_output=True)
        run("init", "-q")
        run("commit", "-q", "--allow-empty", "-m", "first")
        wt = os.path.join(self.tmp, "wt-shop")
        run("worktree", "add", "-q", wt)
        self.assertEqual(C.project_for(wt), "shop")
        self.assertEqual(C.project_for(os.path.join(self.proj_dir)), "shop")
        self.assertEqual(C.project_for(self.tmp), "")


class Chats(Base):
    """task-p0za2: a session without a project folder (the Agents window's Chats; OpenCode's chats run in the home
    folder) is a one-off conversation: nothing of it goes into a project or lines up to start by itself."""
    EMAIL = ("Guten Tag Herr Weber,\ndie Kollegen haben Ihr Auto geprüft: der Wählhebel hat einen Defekt, dieser sollte repariert werden.\n"
             "Aus- und Einbau des Wählhebels 300,00 €. Bitte geben Sie uns Bescheid wie Sie weiterverfahren möchten.\n\nMfG Anna Becker\nTel: 0049 30 1234567")

    def chat_cwd(self):
        return os.path.join(os.path.expanduser("~"), ".copilot", "chats", "72d72eb2-ee03-4e87-9d97-c9962b9860f9")

    def test_nothing_of_a_chat_goes_on_the_board(self):
        """The receipt is the session's own record; no task, no project, nothing lined up, no model asked."""
        old = self.board.add("Reply to the garage", project="shop")
        r = self.say("Write the reschedule email for Monday 8 am. Also some day sort my photos. And add a step to the garage reply", {"things": [
            {"kind": "new", "title": "Reschedule email for Monday", "quote": "Write the reschedule email for Monday 8 am", "now": True, "project": "shop"},
            {"kind": "new", "title": "Sort my photos", "quote": "some day sort my photos", "later": True},
            {"kind": "part", "task": old, "title": "One more step", "quote": "add a step to the garage reply"}],
            "left_out": [{"kind": "question", "quote": "Write the reschedule email for Monday 8 am"}]}, cwd=self.chat_cwd())
        self.assertEqual((r["items"], r["left_out"], r["by"]), ([], [], "chat"))
        self.assertEqual(list(self.board.issues), [old])
        self.assertEqual(self.board.issues[old]["comments"], [])
        self.assertEqual(self.model.asked, [])
        self.assertEqual(C.queue_view()["next"], [])
        saved = C.load_receipts(0, 1_800_000_000)[-1]
        self.assertTrue(saved["chat"])
        self.assertIn("reschedule email", saved["text"])

    def test_the_home_folder_and_the_windows_flag_are_chats_too(self):
        answer = {"things": [{"kind": "new", "title": "Sort my photos", "quote": "Sort my photos"}], "left_out": []}
        r = self.say("Sort my photos", answer, cwd=os.path.expanduser("~"))
        self.assertEqual(r["items"], [])
        r = C.note("agent-host-opencode:/x/sess-87654321", "Sort my music", cwd="", now=1_800_000_100)
        self.assertEqual(r["items"], [])
        self.model.answer = {"things": [{"kind": "new", "title": "Sort the music", "quote": "Sort the music"}], "left_out": []}
        r = C.note("agent-host-opencode:/x/sess-87654321", "Sort the music", cwd="/somewhere/else", now=1_800_000_200, chat=True)
        self.assertEqual(r["items"], [])
        self.assertEqual(self.board.issues, {})

    def test_a_pasted_email_alone_is_not_read_at_all(self):
        r = self.say(self.EMAIL, {"things": [{"kind": "new", "title": "Wählhebel-Reparatur beauftragen", "quote": "der Wählhebel hat einen Defekt"}], "left_out": []},
                     cwd=self.chat_cwd())
        self.assertEqual((r["items"], r["left_out"]), ([], []))
        self.assertEqual(self.model.asked, [])
        self.assertEqual(self.board.issues, {})

    def test_in_a_project_the_pasted_email_and_the_agents_draft_are_not_requests(self):
        msg = "帮我回复这封邮件，问一下什么时候能取车：\n\n" + self.EMAIL
        r = self.say(msg, {"things": [
            {"kind": "new", "title": "Wählhebel-Reparatur beauftragen", "quote": "der Wählhebel hat einen Defekt, dieser sollte repariert werden"},
            {"kind": "new", "title": "Nur die Reparatur des Wählhebels", "quote": "Ich möchte zunächst nur die Reparatur des Wählhebels durchführen lassen"},
            {"kind": "new", "title": "回复修车厂邮件", "quote": "帮我回复这封邮件，问一下什么时候能取车", "now": True}],
            "left_out": [{"kind": "question", "quote": "Bitte geben Sie uns Bescheid wie Sie weiterverfahren möchten"}]})
        self.assertEqual([i["title"] for i in r["items"]], ["回复修车厂邮件"])
        self.assertEqual(r["left_out"], [])
        asked = self.model.asked[-1]
        self.assertEqual(asked["MESSAGE"], "帮我回复这封邮件，问一下什么时候能取车：")
        self.assertIn("Wählhebel", asked["PASTED TEXT"])

    def test_wording_the_agents_draft_adds_no_step(self):
        old = self.board.add("回复修车厂邮件", project="shop")
        r = self.say("你这样说吧 你就说：先选择拆装再维修变速箱", {"things": [
            {"kind": "part", "task": old, "title": "给 Muster 传话", "quote": "先选择拆装再维修变速箱"}], "left_out": []}, cwd=self.chat_cwd())
        self.assertEqual(r["items"], [])
        self.assertEqual(self.board.issues[old]["comments"], [])


class Pasted(unittest.TestCase):
    def test_what_was_pasted_in_is_told_apart(self):
        own, pasted = C.split_pasted("Please reply to this:\n\nDear Anna,\nthe invoice is attached. Please pay by Friday.\n\nKind regards\nBob")
        self.assertEqual(own, "Please reply to this:")
        self.assertIn("pay by Friday", pasted)
        own, pasted = C.split_pasted("看下这个报错\n```\nValueError: export failed\n```\n然后修好它")
        self.assertEqual((own.split(), "ValueError" in pasted), (["看下这个报错", "然后修好它"], True))
        own, pasted = C.split_pasted("Fix it like this\n> We should drop the old API next week\nthanks")
        self.assertNotIn("drop the old API", own)
        own, pasted = C.split_pasted("From: garage@example.com\nSubject: Your car\nThe lever is broken.\n\nMake a note to call them")
        self.assertEqual(own, "Make a note to call them")
        # a German paragraph under Chinese words
        own, pasted = C.split_pasted("翻译一下\n\n" + "Die Kollegen haben Ihr Auto geprüft und folgendes festgestellt: der Wählhebel hat einen Defekt, dieser sollte repariert werden. Sowie eine Getriebeölwechsel mit Spülung durchgeführt werden.")
        self.assertEqual(own, "翻译一下")
        # the person's own words stay whole
        for t in ("Hi, can you make the export button bigger?", "Make the export button bigger. Then commit it.", "我们在对话框里面按了一下之后 键盘弹起来了"):
            self.assertEqual(C.split_pasted(t), (t, ""))

    def test_a_quote_counts_only_when_it_is_the_persons_own(self):
        self.assertTrue(C.in_own_words("「make the export button bigger」", "Please make the export button  bigger."))
        self.assertTrue(C.in_own_words("先选择拆装再维修", "你就说：先选择拆装再维修变速箱"))
        self.assertFalse(C.in_own_words("Ich möchte zunächst nur die Reparatur", "帮我回复这封邮件"))
        self.assertFalse(C.in_own_words("", "anything"))

    def test_chats_folders(self):
        import dispatch_dir
        home = os.path.expanduser("~")
        for p in ("", home, os.path.join(home, ".copilot", "chats", "abc"), dispatch_dir.path("chats", "abc")):
            self.assertTrue(dispatch_dir.chats_folder(p), p)
        for p in (os.path.join(home, "Projects", "shop"), os.path.join(home, ".copilot"), "/tmp/x"):
            self.assertFalse(dispatch_dir.chats_folder(p), p)


class Panel(Base):
    def three(self):
        r = self.say("Alpha report export, Bravo login fix, Charlie dark theme", {"things": [{"kind": "new", "title": t, "quote": t} for t in ("Alpha report export", "Bravo login fix", "Charlie dark theme")], "left_out": []})
        return [i["task"] for i in r["items"]]

    def order(self):
        return [x["id"] for x in C.queue_view()["next"]]

    def test_move_to_front_not_now_and_line_it_up(self):
        a, b, c = self.three()
        self.assertEqual(self.order(), [a, b, c])
        C.front(c)
        self.assertEqual(self.order(), [c, a, b])
        C.later(a)
        self.assertEqual(self.order(), [c, b])
        self.assertEqual([x["id"] for x in C.queue_view()["later"]], [a])
        C.lineup(a)
        self.assertEqual(self.order(), [c, b, a])
        r = C.receipts()["receipts"][0]
        self.assertEqual([i.get("pos") for i in r["items"]], [3, 2, 1])

    def test_not_a_task_and_undo(self):
        a, b, c = self.three()
        C.drop(b)
        self.assertEqual(self.order(), [a, c])
        r = C.receipts()["receipts"][0]
        self.assertEqual(r["items"][1]["state"], "gone")
        self.assertEqual(r["count"], 2)
        C.undo(b)
        self.assertEqual(sorted(self.order()), sorted([a, b, c]))
        self.assertNotIn("dispatch:trashed", self.board.issues[b]["labels"])

    def test_in_progress_with_nobody_on_it_goes_back_in_line_and_undo_puts_it_back(self):
        a, b, c = self.three()
        now = TV.epoch("2026-10-06T12:00:00Z")
        stale = self.board.add("Old export that stopped", status="in_progress", metadata={"claim_session": "claude-code:dead-1"}, project="shop")
        live = self.board.add("Being done now", status="in_progress", metadata={"claim_session": "claude-code:alive-1"}, project="shop")
        fresh = self.board.add("Touched a minute ago", status="in_progress", project="shop")
        self.board.issues[fresh]["updated_at"] = "2026-10-06T11:59:00Z"
        waits = self.board.add("Asks the person", status="in_progress", labels=["dispatch:waiting"], project="shop")
        other = self.board.add("On the mini", status="in_progress", labels=["host:mini"], project="shop")
        self.D.live_sessions = lambda local_only=False: [{"session_id": "alive-1", "agent": "claude-code"}]
        with patch.object(C.time, "time", lambda: now):
            self.assertEqual([t["id"] for t in C.idle()], [stale])
            v = C.queue_view()
        self.assertEqual([x["id"] for x in v["idle"]], [stale])
        self.assertEqual(v["idle"][0]["title"], "Old export that stopped")
        for t in (live, fresh, waits, other):
            self.assertEqual(self.board.issues[t]["status"], "in_progress")
        C.requeue(stale)
        t = self.board.issues[stale]
        self.assertEqual(t["status"], "open")
        self.assertIn("nextup", t["labels"])
        self.assertNotIn("claim_session", t["metadata"])
        self.assertEqual(self.order(), [a, b, c, stale])  # at the end of the line
        self.assertIn("nobody working on it", t["comments"][-1]["text"])
        C.undo(stale)
        t = self.board.issues[stale]
        self.assertEqual((t["status"], t["metadata"]["claim_session"]), ("in_progress", "claude-code:dead-1"))
        self.assertNotIn("nextup", t["labels"])
        with self.assertRaises(ValueError):
            C.requeue(a)  # only what is in progress
        # without a reading of the live sessions nothing is called idle
        self.D.live_sessions = lambda local_only=False: (_ for _ in ()).throw(OSError("ps"))
        with patch.object(C.time, "time", lambda: now):
            self.assertEqual(C.idle(), [])

    def test_edit_and_merge(self):
        a, b, c = self.three()
        C.edit(a, "Alpha report export as CSV")
        self.assertEqual(self.board.issues[a]["title"], "Alpha report export as CSV")
        other = self.board.add("Login page rework", project="shop")
        self.assertIn(other, [t["id"] for t in C.targets(b)["targets"]])
        C.merge(b, other)
        self.assertIn("Bravo login fix", self.board.issues[other]["comments"][0]["text"])
        r = C.receipts()["receipts"][0]
        self.assertEqual((r["items"][1]["state"], r["items"][1]["into"]), ("merged", other))
        C.undo(b)
        self.assertIn(b, self.order())

    def test_keep_a_same_as_apart(self):
        old = self.board.add("动效和符号", project="shop")
        r = self.say("多一点图标", {"things": [{"kind": "same", "task": old, "quote": "多一点图标"}], "left_out": []})
        got = C.keep(r["id"], 0)
        self.assertEqual(C.receipts()["receipts"][-1]["items"][0]["kind"], "new")
        self.assertIn(got["task"], self.order())

    def test_note_a_left_out_question_after_all(self):
        r = self.say("这个软件是如何获取到我 GitHub 上的头像的？")
        got = C.note_left_out(r["id"], 0)
        rr = C.receipts()["receipts"][-1]
        self.assertEqual(rr["left_out"], [])
        self.assertEqual(rr["items"][0]["task"], got["task"])


class Provider(Base):
    def test_a_fast_api_key_comes_before_the_summaries_model(self):
        self.assertEqual(C.provider()["id"], "zhipu")  # the stand-in summaries' model
        os.makedirs(os.path.join(self.tmp, "no-opencode"))
        with open(os.path.join(self.tmp, "no-opencode", "auth.json"), "w") as f:
            json.dump({"zhipuai-coding-plan": {"type": "api", "key": "k-oc"}, "anthropic": {"type": "api", "key": "nope"}}, f)
        p = C.provider()
        self.assertEqual((p["id"], p["key"], p["base"]), ("zhipu", "k-oc", "https://open.bigmodel.cn/api/coding/paas/v4"))
        self.D.env_read = lambda: [{"name": "DEEPSEEK_API_KEY", "value": "k-env"}]
        self.assertEqual(C.provider()["key"], "k-env")
        self.model.retired_providers = lambda: {"deepseek"}
        self.assertEqual(C.provider()["key"], "k-oc")


class Line(Base):
    def setUp(self):
        super().setUp()
        C.set_paused(False)  # the person turned Start by itself on

    def test_the_first_in_line_starts_when_there_is_room(self):
        r = self.say("Two more things for the shop, please: Alpha report export and Bravo login fix", {"things": [{"kind": "new", "title": t, "quote": t} for t in ("Alpha report export", "Bravo login fix")], "left_out": []})
        a, b = [i["task"] for i in r["items"]]
        C.set_limit(1)
        started = []

        def start(t, q):
            started.append(t["id"])
            self.board.issues[t["id"]]["status"] = "in_progress"
        busy = [{"key": "s1", "task": "task-99"}]
        self.assertEqual(C.tick(now=100, start=start, working=lambda: busy)["reason"], "full")
        busy = []
        got = C.tick(now=200, start=start, working=lambda: busy)
        self.assertEqual((got["started"], started), (a, [a]))
        # just started, not yet seen working: it still takes the one slot
        self.assertEqual(C.tick(now=210, start=start, working=lambda: busy)["reason"], "full")
        busy = [{"key": "s2", "task": a}]
        self.assertEqual(C.tick(now=230, start=start, working=lambda: busy)["reason"], "full")
        # it finished: the next one starts by itself
        busy = []
        self.board.issues[a]["status"] = "closed"
        got = C.tick(now=600, start=start, working=lambda: busy)
        self.assertEqual(got["started"], b)
        r = C.receipts()["receipts"][0]
        self.assertEqual([i["state"] for i in r["items"]], ["done", "working"])

    def test_chatd_asks_only_while_something_is_in_line(self):
        self.assertFalse(C.queue_state().get("lined"))
        self.say("Two more things for the shop, please", {"things": [{"kind": "new", "title": "Alpha report export", "quote": "a"}], "left_out": []})
        self.assertTrue(C.queue_state()["lined"])
        tid = C.queue_view()["next"][0]["id"]
        C.drop(tid)
        C.tick(now=100, start=lambda t, q: None, working=lambda: [])
        self.assertFalse(C.queue_state()["lined"])
        C.undo(tid)
        self.assertTrue(C.queue_state()["lined"])

    def test_pause_stops_new_starts(self):
        self.say("Two more things for the shop, please", {"things": [{"kind": "new", "title": "Alpha report export", "quote": "a"}], "left_out": []})
        C.set_paused(True)
        self.assertEqual(C.tick(now=100, start=lambda t, q: self.fail("started while paused"), working=lambda: [])["reason"], "paused")
        self.assertTrue(C.receipts()["receipts"][0]["paused"])
        C.set_paused(False)
        self.assertTrue(C.tick(now=200, start=lambda t, q: None, working=lambda: [])["started"])

    def test_a_start_that_fails_goes_back_to_the_front(self):
        self.say("Two more things for the shop, please", {"things": [{"kind": "new", "title": "Alpha report export", "quote": "a"}], "left_out": []})
        tid = C.queue_view()["next"][0]["id"]
        with patch.object(C, "folder_for", lambda t: self.tmp), patch("subprocess.run", lambda *a, **k: types.SimpleNamespace(returncode=1, stdout="", stderr="no engine")):
            got = C.tick(now=100, working=lambda: [])
        self.assertEqual(got["reason"], "failed")
        self.assertEqual([x["id"] for x in C.queue_view()["next"]], [tid])
        self.assertEqual(C.queue_state()["starting"], {})

    def test_a_start_that_keeps_failing_backs_off_says_why_and_stops(self):
        """task-9qas: it was tried every 20 s for ever and the line still said it starts by itself."""
        self.say("Two more things for the shop, please", {"things": [{"kind": "new", "title": "Alpha report export", "quote": "a"}], "left_out": []})
        tid = C.queue_view()["next"][0]["id"]
        tries = []

        def boom(t, q):
            tries.append(t["id"])
            raise ValueError("Could not start claude: spawn_failed: Claude Code 没起来：[Errno 2] No such file or directory: 'claude'")
        self.assertEqual(C.tick(now=1000, start=boom, working=lambda: [])["reason"], "failed")
        f = C.queue_view()["failed"]
        self.assertEqual((f["task"], f["tries"], f["stuck"]), (tid, 1, False))
        self.assertTrue(f["why"].startswith("Claude Code is not installed on this Mac."), f["why"])
        self.assertNotRegex(f["why"], r"[\u4e00-\u9fff]")
        # not again 20 s later: one minute
        self.assertEqual(C.tick(now=1020, start=boom, working=lambda: [])["reason"], "retry_later")
        self.assertEqual(C.tick(now=1061, start=boom, working=lambda: [])["reason"], "failed")
        # then five minutes
        self.assertEqual(C.tick(now=1200, start=boom, working=lambda: [])["reason"], "retry_later")
        self.assertEqual(C.tick(now=1362, start=boom, working=lambda: [])["reason"], "stuck")
        self.assertTrue(C.queue_view()["failed"]["stuck"])
        # stopped: no more tries until the person says so
        for at in (2000, 5000, 90000):
            self.assertEqual(C.tick(now=at, start=boom, working=lambda: [])["reason"], "stuck")
        self.assertEqual(len(tries), 3)
        self.assertEqual([x["id"] for x in C.queue_view()["next"]], [tid])
        # Try again
        C.retry()
        self.assertEqual(C.queue_view()["failed"], {})
        self.assertEqual(C.tick(now=90100, start=lambda t, q: None, working=lambda: [])["started"], tid)
        a = types.SimpleNamespace(op="retry", args=[], model="", json=True)
        self.assertEqual(C.nextup_command(a, self.D), 0)
        # and the command line takes it (the Try again button runs `dispatch nextup retry`)
        import dispatch
        seen = []
        with patch.object(sys, "argv", ["dispatch", "nextup", "retry", "--json"]), patch.object(C, "nextup_command", lambda a, d=None: seen.append(a.op) or 0), \
             patch.object(dispatch, "_mod", lambda n: C if n == "capture" else __import__(n)):
            with self.assertRaises(SystemExit) as e:
                dispatch._main()
        self.assertEqual((seen, e.exception.code), (["retry"], 0))

    def test_picking_another_agent_or_turning_on_again_clears_a_failure(self):
        self.say("Two more things for the shop, please", {"things": [{"kind": "new", "title": "Alpha report export", "quote": "a"}], "left_out": []})

        def boom(t, q):
            raise ValueError("Could not start codex: not logged in")
        C.tick(now=100, start=boom, working=lambda: [])
        self.assertEqual(C.queue_view()["failed"]["tries"], 1)
        C.set_engine("opencode")
        self.assertEqual(C.queue_view()["failed"], {})
        C.tick(now=200, start=boom, working=lambda: [])
        C.set_paused(True)
        C.set_paused(False)
        self.assertEqual(C.queue_view()["failed"], {})
        self.assertIn("not signed in", C.why_not_started("Could not start codex: not logged in", "codex"))

    def test_a_thing_waits_while_a_session_works_in_its_project(self):
        """task-9rxf: the session the person said it in was still working when the thing started beside it."""
        r = self.say("Also fix the RSS feed dates", {"things": [{"kind": "new", "title": "Fix the RSS feed dates", "quote": "Also fix the RSS feed dates"}], "left_out": []})
        tid = r["items"][0]["task"]
        busy = [{"key": "s1", "task": "", "cwd": self.proj_dir}]
        self.assertEqual(C.tick(now=100, start=lambda t, q: self.fail("started beside a working session"), working=lambda: busy)["reason"], "project_busy")
        # a session in another folder does not hold it
        other = os.path.join(self.tmp, "elsewhere")
        os.makedirs(other)
        self.assertEqual(C.tick(now=200, start=lambda t, q: None, working=lambda: [{"key": "s2", "task": "", "cwd": other}])["started"], tid)

    def test_the_start_runs_the_engine_in_the_projects_folder_with_the_task_claimed(self):
        self.say("Two more things for the shop, please: export the alpha report", {"things": [{"kind": "new", "title": "Alpha report export", "quote": "export the alpha report"}], "left_out": []})
        C.set_engine("opencode", "zhipuai/glm-5.3-flash")
        seen = []
        with patch("subprocess.run", lambda argv, **k: seen.append(argv) or types.SimpleNamespace(returncode=0, stdout="{}", stderr="")):
            C.tick(now=100, working=lambda: [])
        argv = seen[0]
        self.assertEqual(argv[2:5], ["agent", "start", "opencode"])
        self.assertEqual(argv[argv.index("--cwd") + 1], self.proj_dir)
        self.assertEqual(argv[argv.index("--task") + 1], "task-1")
        self.assertEqual(argv[argv.index("--model") + 1], "zhipuai/glm-5.3-flash")
        self.assertIn("export the alpha report", argv[argv.index("--prompt") + 1])
        self.assertNotIn("nextup", self.board.issues["task-1"]["labels"])

    def test_begin_takes_the_noted_task(self):
        self.say("Two more things for the shop, please", {"things": [{"kind": "new", "title": "Fix the RSS feed dates", "quote": "a"}], "left_out": []})
        got = C.claim_noted("Fix the RSS feed dates for old posts", "shop", "")
        self.assertEqual((got["id"], got["state"]), ("task-1", "next"))
        self.assertIsNone(C.claim_noted("Plan the summer holiday", "shop", ""))

    def test_what_dispatch_claimed_for_a_chat_is_that_agents_to_take_once(self):
        """task-b83p: the agent in the chat was refused its own task ("claimed by fixture")."""
        r = self.say("Fix the login bug please", {"things": [{"kind": "new", "title": "Fix the login bug", "quote": "Fix the login bug", "now": True}], "left_out": []})
        tid = r["items"][0]["task"]
        got = C.claim_noted("Fix the login bug", "shop", "sess-12345678")
        self.assertEqual((got["id"], got["state"], got["for_this_chat"]), (tid, "working", True))
        C.taken(tid)
        self.assertTrue(self.board.issues[tid]["metadata"]["chat"]["taken"])
        self.assertFalse(C.claim_noted("Fix the login bug", "shop", "sess-12345678")["for_this_chat"])

    def test_what_dispatch_claimed_for_one_chat_is_never_handed_to_another(self):
        """task-lj06.17: session B's agent got "it is yours" for what session A was asked to do now, and A's own agent
        was then told another agent is on it (2 of 2)."""
        r = self.say("Add a search box above the to-do list", {"things": [{"kind": "new", "title": "Add a search box above the to-do list", "quote": "Add a search box", "now": True}], "left_out": []})
        tid = r["items"][0]["task"]
        self.assertIsNone(C.claim_noted("Add a search box to the list", "shop", "bbbbbbbb-2222-4333-8444-955566667777"))
        self.assertIsNone(C.claim_noted("Add a search box to the list", "shop", ""))  # an agent that cannot say which chat
        got = C.claim_noted("Add a search box to the list", "shop", "sess-12345678")
        self.assertEqual((got["id"], got["for_this_chat"]), (tid, True))
        self.assertEqual(C.whose(self.board.issues[tid], "sess-12345678"), "mine")
        self.assertEqual(C.whose(self.board.issues[tid], "bbbbbbbb-2222"), "other")
        # what only waits in Next up is anybody's: the same work is not done twice
        r2 = self.say("Also fix the RSS feed dates", {"things": [{"kind": "new", "title": "Fix the RSS feed dates", "quote": "fix the RSS feed dates"}], "left_out": []})
        self.assertEqual(C.claim_noted("Fix the RSS feed dates", "shop", "bbbbbbbb-2222-4333-8444-955566667777")["id"], r2["items"][0]["task"])

    def test_a_commit_said_with_the_work_is_a_step_of_it_not_a_task(self):
        """task-lj06.18: "…Then commit it." became its own Next up and stayed there after the commit."""
        r = self.say("Create a simple to-do list page. Then commit it.", {"things": [
            {"kind": "new", "title": "Create a simple to-do list page", "quote": "Create a simple to-do list page", "now": True},
            {"kind": "new", "title": "Commit the new files", "quote": "Then commit it."}], "left_out": []})
        self.assertEqual([i["title"] for i in r["items"]], ["Create a simple to-do list page"])
        r = self.say("Commit the work please", {"things": [{"kind": "new", "title": "Commit the work", "quote": "Commit the work please"}], "left_out": []})
        self.assertEqual([i["title"] for i in r["items"]], ["Commit the work"])  # alone, a commit is the work asked for

    def test_opencode_s_reply_is_read_from_its_own_database(self):
        """task-lj06.18: OpenCode's turn end carries no text and its session was not in the index yet."""
        asked = []

        def query(sql, params=(), agent=""):
            asked.append((agent, params))
            return [{"id": "msg_2"}] if "from message" in sql else [{"text": "The Add button is already blue."}, {"text": "Nothing to commit."}]
        self.D.SQLITE_STORES = {"opencode": {"db": "x", "seq": "x"}}
        self.D.zcode_query = query
        self.assertEqual(C._last_reply("opencode", "ses_abc12345"), "The Add button is already blue.\nNothing to commit.")
        self.assertEqual(asked, [("opencode", ("ses_abc12345",)), ("opencode", ("msg_2",))])

    def test_the_turn_end_closes_what_the_reply_says_is_done_or_not_needed(self):
        """task-lj06.18: "Make the Add button blue" (it already was) stayed in progress for good."""
        r = self.say("Make the Add button blue", {"things": [{"kind": "new", "title": "Make the Add button blue", "quote": "Make the Add button blue", "now": True}], "left_out": []})
        tid = r["items"][0]["task"]
        self.assertEqual(C.untaken_ids(), [tid])
        spawned = []
        self.assertTrue(C.settle_from_hook({"hook_event_name": "Stop", "session_id": "sess-12345678", "last_assistant_message": "x"}, "claude-code",
                                           spawn=lambda *a: spawned.append(a))["started"])
        self.assertEqual(spawned, [("sess-12345678", "claude-code", "x")])
        # an agent's hook process has not loaded the dispatch module: it still finds the list (it did not, on the mini)
        with patch.object(C, "D", None), patch.dict(os.environ, {"DISPATCH_DIR": self.tmp}):
            self.assertTrue(C.settle_from_hook({"hook_event_name": "Stop", "session_id": "ses_abc12345"}, "opencode", spawn=lambda *a: spawned.append(a))["started"])
        closed = []
        asked = []
        # another conversation's turn closes nothing of this one's
        self.assertEqual(C.settle("bbbbbbbb-2222-4333-8444-955566667777", "Done.", model_call=lambda u: asked.append(u) or '{"state":"done"}', close=lambda *a: closed.append(a)), {"closed": []})
        self.assertEqual(asked, [])
        # still working on it: stays
        got = C.settle("sess-12345678", "I am changing style.css now.", model_call=lambda u: '{"state":"open","why":""}', close=lambda *a: closed.append(a))
        self.assertEqual((got, closed), ({"closed": []}, []))
        got = C.settle("agent-host-claude:/x/sess-12345678", "The Add button is already blue, nothing to change.",
                       model_call=lambda u: asked.append(json.loads(u)) or '{"state":"not_needed","why":"The button is already blue."}', close=lambda *a: closed.append(a))
        self.assertEqual(got["closed"][0]["task"], tid)
        self.assertEqual(asked[0]["TASK"], "Make the Add button blue")
        self.assertTrue(closed[0][1].startswith("Not needed: The button is already blue."))
        self.assertEqual(C.untaken_ids(), [])  # what was closed is off the list
        # an agent that took it closes it itself
        C.taken(tid)
        self.assertEqual(C.settle("sess-12345678", "Done.", model_call=lambda u: '{"state":"done"}', close=lambda *a: closed.append(a)), {"closed": []})
        self.assertEqual(C.untaken_ids(), [])
        self.assertFalse(C.settle_from_hook({"hook_event_name": "Stop", "session_id": "sess-12345678"}, "claude-code", spawn=lambda *a: spawned.append(a))["started"])

    def test_a_model_that_does_not_answer_is_asked_once_more_and_the_turn_s_end_is_logged(self):
        r = self.say("Make the Add button blue", {"things": [{"kind": "new", "title": "Make the Add button blue", "quote": "Make the Add button blue", "now": True}], "left_out": []})
        tid = r["items"][0]["task"]
        calls = []

        def slow_then_fine(user):
            calls.append(user)
            if len(calls) == 1:
                raise TimeoutError("timed out")
            return '{"state":"not_needed","why":"Already blue."}'
        closed = []
        got = C.settle("sess-12345678", "It is already blue.", model_call=slow_then_fine, close=lambda *a: closed.append(a))
        self.assertEqual(([c["task"] for c in got["closed"]], len(calls)), ([tid], 2))
        with open(os.path.join(C.folder(), "settle.jsonl"), encoding="utf-8") as f:
            row = json.loads(f.read().splitlines()[-1])
        self.assertEqual((row["session"], row["tasks"][0]["task"], row["tasks"][0]["state"]), ("sess-12345678", tid, "not_needed"))
        # never answering: open, and the log says why
        self.assertEqual(C.settle_judge({"title": "x"}, "y", model_call=lambda u: (_ for _ in ()).throw(TimeoutError("timed out")))["error"], "timed out")

    def test_codex_s_reply_is_read_from_its_rollout_file(self):
        """10-08: Codex's turn end carried no reply and the session index did not have the thread yet."""
        import engines as EN
        rollout = os.path.join(self.tmp, "rollout-x-01a1193a.jsonl")
        open(rollout, "w").close()
        seen = []
        self.D.read_session_detail = lambda ref: seen.append(ref) or {"messages": [
            {"role": "user", "text": "Round the corners. Then commit it."}, {"role": "assistant", "text": ""},
            {"role": "assistant", "text": "Set border-radius: 6px."}, {"role": "assistant", "text": "Committed as 3ac1e47."}]}
        with patch.object(EN.get("codex"), "transcript_of", lambda sid, home, cwd="": [rollout]):
            self.assertEqual(C._last_reply("codex", "01a1193a"), "Set border-radius: 6px.\nCommitted as 3ac1e47.")
        self.assertEqual((seen[0]["agent"], seen[0]["path"]), ("codex", rollout))

    def test_codex_s_turn_end_finds_the_conversation_by_its_thread(self):
        """task-lj06.18: Codex's Stop hook says its thread id; the board files the window's id (they differ)."""
        import session_life as L
        # the window's records in this test's folder (session_life reads DISPATCH_DIR when the dispatch module is not loaded)
        p = patch.object(L, "dispatch_dir", lambda: self.tmp)
        p.start()
        self.addCleanup(p.stop)
        window = "agent-host-codex:/0e2d6a90-1b7c-4c55-9b0e-2f1e1c9d0a11"
        r = self.say("Give the Add button rounded corners", {"things": [{"kind": "new", "title": "Round the Add button corners", "quote": "Give the Add button rounded corners", "now": True}], "left_out": []}, session=window)
        tid = r["items"][0]["task"]
        thread = "01a118d7-b1ca-7e10-9f9a-06683d2250a3"
        self.assertEqual(C.whose(self.board.issues[tid], thread), "other")
        filed = []
        p = patch.object(C, "MAP_WAIT", 5)
        p.start()
        self.addCleanup(p.stop)

        def window_files_it(_):  # the first turn: the window files the thread half a second after the Stop hook
            if not filed:
                filed.append(L.save(L.path_for("managed", L.key("codex:" + thread)), {"session": L.key("codex:/0e2d6a90-1b7c-4c55-9b0e-2f1e1c9d0a11"), "host_pid": 1}))
        closed = []
        got = C.settle(thread, "Set border-radius: 6px. Committed as 3ac1e47.", agent="codex", model_call=lambda u: '{"state":"done","why":"Committed."}',
                       close=lambda *a: closed.append(a), sleep=window_files_it)
        self.assertEqual([c["task"] for c in got["closed"]], [tid])
        self.assertEqual(C.whose(self.board.issues[tid], thread), "mine")

    def test_a_turn_that_ends_while_its_message_is_read_waits_for_the_board(self):
        """task-lj06.18: an agent that answers in seconds ends its turn before its message is on the board."""
        spawned = []
        lock = os.path.join(C.folder(), "note-abc.lock")
        os.makedirs(C.folder(), exist_ok=True)
        open(lock, "w").close()
        self.assertTrue(C.settle_from_hook({"hook_event_name": "Stop", "session_id": "sess-12345678"}, "claude-code",
                                           spawn=lambda *a: spawned.append(a))["started"])
        made = []

        def reading_ends(_):
            if not made:  # the reader puts the task on the board and lets go of its lock
                made.append(self.say("Make the Add button blue", {"things": [{"kind": "new", "title": "Make the Add button blue", "quote": "Make the Add button blue", "now": True}], "left_out": []}))
                os.unlink(lock)
        closed = []
        got = C.settle("sess-12345678", "The Add button is already blue.", model_call=lambda u: '{"state":"not_needed","why":"Already blue."}',
                       close=lambda *a: closed.append(a), sleep=reading_ends)
        self.assertEqual([c["task"] for c in got["closed"]], [made[0]["items"][0]["task"]])
        # a lock a dead reader left behind is not waited for
        open(lock, "w").close()
        old = time.time() - C.NOTE_LOCK_FRESH - 5
        os.utime(lock, (old, old))
        self.assertFalse(C.notes_in_flight())


if __name__ == "__main__":
    unittest.main()


class Terminal(Base):
    """A prompt typed to an agent in Dispatch's own terminal (its prompt hook) is noted like a message in the window."""

    TERM = "3f0c2a8e-1111-4222-8333-944455556666"
    # sh (the hook) ← claude ← zsh (the terminal's shell) ← termd
    TABLE = {900: (800, "/bin/sh -c python3 life_hook.py --agent claude-code"), 800: (700, "claude --session-id abc"),
             700: (600, "-zsh"), 600: (1, "/Applications/Dispatch IDE.app/Contents/MacOS/Dispatch IDE termd.cjs")}

    def hook(self, prompt, env=None, data=None, table=None, agent="claude-code"):
        sent = []
        d = {"hook_event_name": "UserPromptSubmit", "session_id": "abc", "cwd": self.proj_dir, "prompt": prompt}
        d.update(data or {})
        e = {C.TERMINAL_ENV: self.TERM} if env is None else env
        with patch("os.getppid", lambda: 900):
            r = C.from_hook(d, agent, env=e, spawn=lambda *a: sent.append(a), table=self.TABLE if table is None else table)
        return r, sent

    def test_a_request_in_the_terminal_is_noted_under_that_terminal(self):
        r, sent = self.hook("Make the export button bigger on the shop page")
        self.assertTrue(r["noted"])
        session, text, cwd, title, env = sent[0]
        self.assertEqual(session, "dispatch-terminal:/" + self.TERM)
        self.assertEqual((text, cwd, title), ("Make the export button bigger on the shop page", self.proj_dir, "Claude Code in the terminal"))
        # noted under that session: the Tasks tab of the terminal session finds it
        self.say(text, {"things": [{"kind": "new", "title": "Bigger export button", "quote": text}], "left_out": []}, session=session)
        self.assertIn("session-origin:" + self.TERM, self.board.issues["task-1"]["labels"])
        self.assertEqual(TV.session_key(session), self.TERM)

    def test_only_the_persons_own_agent_in_a_dispatch_terminal(self):
        self.assertEqual(self.hook("Make the export button bigger", env={})[0]["why"], "not in a Dispatch terminal")
        self.assertFalse(self.hook("Make the export button bigger", data={"agent_id": "a1"})[0]["noted"])
        self.assertFalse(self.hook("Make the export button bigger", env={C.TERMINAL_ENV: self.TERM, "DISPATCH_WORKER": "w1"})[0]["noted"])
        self.assertFalse(self.hook("Make the export button bigger", env={C.TERMINAL_ENV: self.TERM, "CLAUDE_CODE_ENTRYPOINT": "sdk-cli"})[0]["noted"])
        self.assertFalse(self.hook("Make the export button bigger", data={"hook_event_name": "Stop"})[0]["noted"])
        self.assertFalse(self.hook("Make the export button bigger", data={"session_id": "ses_abc123"})[0]["noted"])
        self.assertTrue(self.hook("Make the export button bigger", data={"session_id": "ses_abc123"}, agent="opencode")[0]["noted"])
        for said in ("ok", "thanks!", "/clear", "  "):
            r, sent = self.hook(said)
            self.assertFalse(r["noted"], said)
            self.assertEqual(sent, [])

    def test_an_agent_started_by_another_agent_is_not_the_person(self):
        nested = {900: (800, "/bin/sh -c python3 life_hook.py"), 800: (750, "claude -p 'do the thing'"), 750: (700, "/bin/zsh -c claude -p"),
                  700: (650, "/Users/a/.local/share/claude/versions/2.1.9"), 650: (600, "-zsh"), 600: (1, "termd")}
        self.assertEqual(self.hook("Make the export button bigger", table=nested)[0]["why"], "an agent started by another agent")
        # Codex's npm wrapper and its binary are one agent
        codex = {900: (800, "/bin/sh -c life_hook"), 800: (790, "/opt/codex/codex-aarch64-apple-darwin"), 790: (700, "node /usr/local/bin/codex"),
                 700: (600, "-zsh"), 600: (1, "termd")}
        self.assertTrue(self.hook("Make the export button bigger", table=codex, agent="codex")[0]["noted"])

    def test_children_of_dispatch_do_not_carry_the_terminal(self):
        import chat_protocol
        self.assertNotIn(C.TERMINAL_ENV, chat_protocol.child_env({C.TERMINAL_ENV: self.TERM, "HOME": "/h"}))

    def test_the_life_hook_passes_a_terminal_prompt_on(self):
        import life_hook
        seen = []
        with patch.dict(os.environ, {C.TERMINAL_ENV: self.TERM}), patch.object(C, "from_hook", lambda d, a: seen.append((d["prompt"], a))):
            life_hook.capture_prompt({"hook_event_name": "UserPromptSubmit", "prompt": "Add a dark mode"}, "codex")
            life_hook.capture_prompt({"hook_event_name": "PostToolUse", "prompt": "x"}, "codex")
        self.assertEqual(seen, [("Add a dark mode", "codex")])


class Settings(Base):
    def test_the_settings_page_and_the_command_share_one_value(self):
        self.assertEqual(C.settings_view()["limit"], C.LIMIT)
        C.set_limit(3)
        C.set_engine("codex")
        v = C.settings_view()
        self.assertEqual((v["limit"], v["engine"], v["paused"]), (3, "codex", True))
        with open(os.path.join(self.tmp, "capture", "queue.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["limit"], 3)
        C.set_engine("")
        self.assertEqual(C.settings_view()["engine"], "")
        with self.assertRaises(ValueError):
            C.set_limit(0)
        with self.assertRaises(ValueError):
            C.set_engine("gemini")

    def test_picking_the_same_agent_again_keeps_its_model(self):
        C.set_engine("opencode", "zhipuai/glm-5.3-flash")
        C.set_engine("opencode")
        self.assertEqual(C.queue_state()["model"], "zhipuai/glm-5.3-flash")
        C.set_engine("codex")
        self.assertEqual(C.queue_state()["model"], "")

    def test_the_line_says_which_message_each_thing_came_from(self):
        self.say("Two more things for the shop: export the alpha report and fix the beta page", {"things": [
            {"kind": "new", "title": "Alpha report export", "quote": "export the alpha report"},
            {"kind": "new", "title": "Beta page fix", "quote": "fix the beta page"}], "left_out": []})
        rows = C.queue_view(now=1_800_000_100)["next"]
        self.assertEqual([r["pos"] for r in rows], [1, 2])
        self.assertEqual({r["receipt"] for r in rows}, {C.load_receipts(0)[0]["id"]})
        self.assertTrue(all(r["said"].startswith("Two more things for the shop") for r in rows))

    def test_engine_default_on_the_command_line(self):
        C.set_engine("codex")
        a = types.SimpleNamespace(op="engine", args=["default"], model="", json=True)
        self.assertEqual(C.nextup_command(a, self.D), 0)
        self.assertEqual(C.queue_state()["engine"], "")


class Twice(Base):
    def test_the_same_message_told_twice_at_once_is_read_once(self):
        import threading
        answer = {"things": [{"kind": "new", "title": "Security file", "quote": "add a SECURITY.md"}], "left_out": []}
        slow = self.model.chat

        def chat(*a, **k):
            time.sleep(0.3)  # the model takes a moment: the second hook call comes in meanwhile
            return slow(*a, **k)
        self.model.answer = answer
        self.model.chat = chat
        got = []
        ts = [threading.Thread(target=lambda: got.append(C.note("dispatch-terminal:/3f0c2a8e-1111-4222-8333-944455556666", "Please add a SECURITY.md to the shop", cwd=self.proj_dir, now=1_800_000_000)))
              for _ in range(2)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(len({r["id"] for r in got}), 1)
        self.assertEqual(len([t for t in self.board.issues.values() if "from-chat" in t["labels"]]), 1)
        self.assertEqual(len(C.load_receipts(0)), 1)

    def test_two_writers_of_the_switches_at_once(self):
        import threading
        errs = []

        def flip(i):
            try:
                for _ in range(20):
                    C.set_paused(bool(i % 2))
            except OSError as e:
                errs.append(e)
        ts = [threading.Thread(target=flip, args=(i,)) for i in range(4)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(errs, [])
