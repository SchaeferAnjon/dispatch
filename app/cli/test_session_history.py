"""`dispatch sessions history`: every session on the Mac, searchable, grouped by project, nothing imported."""
import contextlib
import io
import json
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import dispatch as D
import session_history as H


def line(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"


def claude_user(text, cwd, ts="2026-09-29T00:00:00Z"):
    return line({"type": "user", "cwd": cwd, "timestamp": ts, "message": {"role": "user", "content": text}})


def claude_reply(text, ts="2026-09-29T00:01:00Z", model="claude-opus-5-5"):
    return line({"type": "assistant", "timestamp": ts, "message": {"model": model, "content": [{"type": "text", "text": text}]}})


def claude_tool_result(text):
    return line({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": text}]}})


class History(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.home = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.state = self.home / "state"
        self.state.mkdir()
        values = dict(HOME=str(self.home), DISPATCH_DIR=str(self.state), BEADS_DIR=str(self.home / "board"),
                      INDEX_FILE=str(self.state / "index.json"), INDEX_PROGRESS_FILE=str(self.state / "index-progress.json"),
                      INDEX_LOCK_FILE=str(self.state / "index.lock"), INDEX_START_LOCK_FILE=str(self.state / "index-start.lock"),
                      HOSTS_FILE=str(self.state / "hosts.json"))
        for key, value in values.items():
            self.stack.enter_context(patch.object(D, key, value))
        self.stack.enter_context(patch.dict(os.environ, {"CODEX_HOME": str(self.home / ".codex"), "DISPATCH_SESSION_ROOT": ""}))
        self.stack.enter_context(patch.object(D, "zcode_query", return_value=[]))
        self.stack.enter_context(patch.object(__import__("engines.hermes", fromlist=["x"]), "query", return_value=[]))
        self.stack.enter_context(patch.object(__import__("engines.gemini", fromlist=["x"]), "index"))
        self.stack.enter_context(patch.object(H, "D", D))
        self.stack.enter_context(patch.object(H, "_ROOTS", {}))
        self.stack.enter_context(patch.object(H, "_PROGRAMS", {"claude-code": "/opt/bin/claude", "codex": "/opt/bin/codex"}))
        # the background run is the test's to start
        self.spawned = self.stack.enter_context(patch.object(H, "start_refresh", return_value=False))
        # a project with a worktree, and a second project
        self.repo = self.home / "Projects" / "shop"
        (self.repo / ".git" / "worktrees" / "try").mkdir(parents=True)
        self.wt = self.home / "Projects" / "shop-wt" / "try"
        self.wt.mkdir(parents=True)
        (self.wt / ".git").write_text(f"gitdir: {self.repo}/.git/worktrees/try\n")
        self.other = self.home / "Projects" / "notes"
        (self.other / ".git").mkdir(parents=True)

    def claude(self, sid, cwd, lines, project_dir=None):
        d = self.home / ".claude" / "projects" / (project_dir or str(cwd).replace("/", "-"))
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"{sid}.jsonl"
        p.write_text("".join(lines))
        return p

    def codex(self, sid, cwd, lines, parent=""):
        d = self.home / ".codex" / "sessions" / "2026" / "09" / "29"
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"rollout-2026-09-29T00-00-00-{sid}.jsonl"
        meta = {"id": sid, "cwd": str(cwd), "originator": "codex_cli_rs", "source": "cli"}
        if parent:
            meta.update(parent_thread_id=parent, source={"subagent": {"thread_spawn": {"parent_thread_id": parent}}})
        p.write_text(line({"timestamp": "2026-09-29T00:00:00Z", "type": "session_meta", "payload": meta}) + "".join(lines))
        return p

    def history(self, **kw):
        D.refresh_index()
        return H.history(**kw)

    def rows(self, res):
        return [r for g in res["groups"] for r in g["sessions"]]

    # ---- reading ------------------------------------------------------------------------------

    def test_claude_session_row(self):
        sid = "11111111-1111-4111-8111-111111111111"
        p = self.claude(sid, self.repo, [
            claude_user("Make the checkout button bigger", str(self.repo)),
            claude_reply("Looking at the button."),
            claude_tool_result("big tool output that is not a message"),
            claude_user("<system-reminder>x</system-reminder>Also the colour", str(self.repo), "2026-09-29T00:02:00Z"),
            claude_reply("Done: the button is 48 px high now.", "2026-09-29T00:03:00Z", "claude-sonnet-5-5"),
        ])
        sub = p.parent / sid / "subagents"
        sub.mkdir(parents=True)
        (sub / "agent-a1.jsonl").write_text(claude_user("look around", str(self.repo)))
        (sub / "agent-a2.jsonl").write_text(claude_user("look again", str(self.repo)))
        res = self.history()
        (r,) = self.rows(res)
        self.assertEqual(r["agent"], "claude-code")
        self.assertEqual(r["agent_name"], "Claude Code")
        self.assertEqual(r["icon"], "claude")
        self.assertEqual(r["title"], "Make the checkout button bigger")
        self.assertEqual(r["preview"], {"role": "agent", "text": "Done: the button is 48 px high now."})
        self.assertEqual(r["model"], "claude-sonnet-5-5")
        self.assertEqual(r["subagents"], 2)
        self.assertEqual(r["typed"], 2)
        self.assertEqual(r["project"], "shop")
        self.assertEqual(r["project_root"], str(self.repo))
        self.assertEqual(r["resume"], {"ok": True, "command": f"/opt/bin/claude --resume {sid}", "cwd": str(self.repo)})
        self.assertIsNone(r["window"])
        self.assertEqual(res["groups"][0]["count"], 1)

    def test_incremental_read_only_reads_what_was_added(self):
        p = self.claude("22222222-2222-4222-8222-222222222222", self.repo, [claude_user("first ask", str(self.repo)), claude_reply("first answer")])
        self.history()
        con = H.connect()
        off = con.execute("SELECT off FROM sess").fetchone()[0]
        con.close()
        self.assertEqual(off, p.stat().st_size)
        with p.open("a") as f:
            f.write(claude_user("second ask about invoices", str(self.repo), "2026-09-29T01:00:00Z"))
            f.write(claude_reply("second answer", "2026-09-29T01:01:00Z"))
        seen = []
        real_fold = H.fold_piece

        def fold(agent, row, buf):
            seen.append(buf)
            return real_fold(agent, row, buf)
        with patch.object(H, "fold_piece", side_effect=fold):
            res = self.history(query="invoices")
        self.assertEqual(len(seen), 1)
        self.assertNotIn(b"first ask", seen[0])
        (r,) = self.rows(res)
        self.assertEqual(r["preview"]["text"], "second answer")
        self.assertEqual(r["matches"], "text")
        self.assertIn("second ask about invoices", r["snippet"])
        # nothing new: nothing read
        with patch.object(H, "fold_piece", side_effect=AssertionError("read again")):
            self.history()

    def test_a_record_still_being_written_waits(self):
        p = self.claude("33333333-3333-4333-8333-333333333333", self.repo, [claude_user("hello", str(self.repo))])
        half = claude_reply("half written").encode()
        with p.open("ab") as f:
            f.write(half[:-10])
        self.history()
        con = H.connect()
        row = dict(con.execute("SELECT off, last_text FROM sess").fetchone())
        con.close()
        self.assertEqual(row["off"], p.stat().st_size - len(half) + 10)
        with p.open("ab") as f:
            f.write(half[-10:])
        (r,) = self.rows(self.history())
        self.assertEqual(r["preview"]["text"], "half written")

    def test_codex_session_helpers_and_codex_home(self):
        sid, kid = "019e0000-0000-7000-8000-000000000001", "019e0000-0000-7000-8000-000000000002"
        self.codex(sid, self.other, [
            line({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "# AGENTS.md instructions for x"}]}}),
            line({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "整理一下笔记目录"}]}}),
            line({"type": "turn_context", "payload": {"model": "gpt-6-astra"}}),
            line({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "整理好了，分成三类。"}]}}),
        ])
        self.codex(kid, self.other, [line({"type": "turn_context", "payload": {"model": "gpt-6-mini"}})], parent=sid)
        (r,) = self.rows(self.history())
        self.assertEqual(r["agent"], "codex")
        self.assertEqual(r["icon"], "openai")
        self.assertEqual(r["title"], "整理一下笔记目录")
        self.assertEqual(r["preview"], {"role": "agent", "text": "整理好了，分成三类。"})
        self.assertEqual(r["model"], "gpt-6-astra")
        self.assertEqual(r["subagents"], 1)
        self.assertEqual(r["resume"]["command"], f"/opt/bin/codex resume {sid}")
        # a session in another Codex home is resumed with that home
        with patch.dict(os.environ, {"CODEX_HOME": str(self.home / "elsewhere")}):
            row = H.resume_of(r["key"], {"agent": "codex", "session_id": sid, "cwd": str(self.other)}, True)
        self.assertTrue(row["command"].startswith(f"CODEX_HOME={self.home / '.codex'} /opt/bin/codex resume"))

    def test_cannot_continue_says_why(self):
        gone = self.home / "Projects" / "gone"
        self.claude("44444444-4444-4444-8444-444444444444", gone, [claude_user("old work", str(gone))])
        (r,) = self.rows(self.history())
        self.assertFalse(r["folder_exists"])
        self.assertEqual(r["resume"], {"ok": False, "why": "The folder this session worked in is gone, so it can't be continued here."})
        with patch.object(H, "_PROGRAMS", {}), patch("agents_catalog.find", return_value=""):
            why = H.resume_of("k", {"agent": "claude-code", "session_id": "x", "cwd": str(self.repo)}, True)
        self.assertEqual(why, {"ok": False, "why": "Claude Code is not installed on this Mac."})
        self.assertFalse(H.resume_of("zcode:1", {"agent": "zcode", "session_id": "1", "cwd": str(self.repo)}, True)["ok"])

    # ---- scope, search, sort ----------------------------------------------------------------------

    def three(self):
        o = self.claude("55555555-5555-4555-8555-555555555555", self.repo, [claude_user("Fix the cart total", str(self.repo), "2026-09-20T00:00:00Z"), claude_reply("Fixed the rounding", "2026-09-20T00:01:00Z")])
        p = self.claude("66666666-6666-4666-8666-666666666666", self.wt, [claude_user("Try a new checkout page", str(self.wt), "2026-09-21T00:00:00Z"), claude_reply("Prototype ready", "2026-09-21T00:01:00Z")])
        q = self.claude("77777777-7777-4777-8777-777777777777", self.other, [claude_user("Summarise my reading notes", str(self.other), "2026-09-22T00:00:00Z"), claude_reply("Three themes", "2026-09-22T00:01:00Z")])
        now = time.time()
        os.utime(o, (now - 200, now - 200))
        os.utime(p, (now - 100, now - 100))
        os.utime(q, (now - 50, now - 50))

    def test_scopes(self):
        self.three()
        every = self.history()
        self.assertEqual(every["scope"], "all")
        self.assertEqual(every["total"], 3)
        self.assertEqual([g["project"] for g in every["groups"]], ["notes", "shop"])
        self.assertEqual(every["groups"][1]["count"], 2)
        proj = H.history(scope="project", folder=str(self.wt))
        self.assertEqual(proj["project"], {"root": str(self.repo), "name": "shop"})
        self.assertEqual(sorted(r["title"] for r in self.rows(proj)), ["Fix the cart total", "Try a new checkout page"])
        ws = H.history(scope="workspace", folder=str(self.wt))
        self.assertEqual([r["title"] for r in self.rows(ws)], ["Try a new checkout page"])
        # no folder: the whole Mac
        self.assertEqual(H.history(scope="project")["scope"], "all")

    def test_project_scope_through_a_symlink(self):
        # task-ez3yp: the window names the project by a path through a symlink (/tmp → /private/tmp), the agent
        # recorded the real one (or the other way round): both are the same project
        self.three()
        link = self.home / "linked-notes"
        link.symlink_to(self.other)
        by_link = self.history(scope="project", folder=str(link))
        self.assertEqual([r["title"] for r in self.rows(by_link)], ["Summarise my reading notes"])
        self.assertEqual(by_link["total"], 1)
        # sessions recorded under the link, asked for by the real path
        self.claude("88888888-8888-4888-8888-888888888888", link, [claude_user("Tag the notes by month", str(link), "2026-09-23T00:00:00Z"), claude_reply("Tagged", "2026-09-23T00:01:00Z")])
        by_real = self.history(scope="project", folder=str(self.other))
        self.assertEqual(sorted(r["title"] for r in self.rows(by_real)), ["Summarise my reading notes", "Tag the notes by month"])

    def test_search_and_sort(self):
        self.three()
        self.history()
        self.assertEqual([r["title"] for r in self.rows(H.history(query="CART"))], ["Fix the cart total"])
        self.assertEqual(self.rows(H.history(query="cart"))[0]["matches"], "title")
        self.assertEqual([r["title"] for r in self.rows(H.history(query="rounding"))], ["Fix the cart total"])
        self.assertEqual(self.rows(H.history(query="themes notes"))[0]["title"], "Summarise my reading notes")
        self.assertEqual(self.rows(H.history(query="shop-wt"))[0]["matches"], "details")
        self.assertEqual(H.history(query="cart nothing-like-this")["matched"], 0)
        by_created = H.history(sort="created")
        self.assertEqual([r["title"] for r in self.rows(by_created)][0], "Summarise my reading notes")
        limited = H.history(limit=1)
        self.assertEqual((limited["shown"], limited["matched"]), (1, 3))
        self.assertEqual(limited["groups"][0]["count"], 1)
        only = H.history(agents={"codex"})
        self.assertEqual(only["matched"], 0)
        self.assertEqual(only["agents"], [{"id": "claude-code", "name": "Claude Code", "icon": "claude", "count": 3}])

    def test_empty_sessions_are_hidden_unless_asked(self):
        self.claude("88888888-8888-4888-8888-888888888888", self.repo, [line({"type": "summary", "cwd": str(self.repo)})])
        # a session that only ran /login: nothing typed, nothing answered
        self.claude("88888888-8888-4888-8888-888888888889", self.repo, [claude_user("<command-name>/login</command-name>", str(self.repo)),
                                                                       claude_user("<local-command-stdout>Login successful</local-command-stdout>", str(self.repo))])
        self.assertEqual(self.history()["matched"], 0)
        self.assertEqual(H.history(show_empty=True)["matched"], 2)

    def test_same_folder_name_in_two_places(self):
        a, b = self.home / "work" / "demo", self.home / "tmp" / "demo"
        for d in (a, b):
            (d / ".git").mkdir(parents=True)
        self.claude("99999999-9999-4999-8999-999999999991", a, [claude_user("one", str(a))])
        self.claude("99999999-9999-4999-8999-999999999992", b, [claude_user("two", str(b))])
        self.assertEqual(sorted(g["project"] for g in self.history()["groups"]), ["demo · tmp", "demo · work"])
        c, d = self.home / "e2e" / "r1" / "projects" / "demo", self.home / "e2e" / "r2" / "projects" / "demo"
        for x in (c, d):
            (x / ".git").mkdir(parents=True)
        self.claude("99999999-9999-4999-8999-999999999993", c, [claude_user("three", str(c))])
        self.claude("99999999-9999-4999-8999-999999999994", d, [claude_user("four", str(d))])
        names = sorted(g["project"] for g in self.history()["groups"])
        self.assertIn("demo · r1", names)
        self.assertIn("demo · r2", names)

    # ---- the Agents window, other Macs, not importing ---------------------------------------------

    def test_marks_sessions_the_agents_window_already_has(self):
        sid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        self.claude(sid, self.repo, [claude_user("in the window", str(self.repo))])
        ud = self.home / "ud"
        (ud / "User" / "globalStorage").mkdir(parents=True)
        con = sqlite3.connect(ud / "User" / "globalStorage" / "agent-host.db")
        con.execute("CREATE TABLE sessions_v2(session_uri TEXT, provider TEXT, start_time INTEGER, payload TEXT, is_chat_backing INTEGER, modified_time INTEGER, external INTEGER)")
        con.execute("CREATE TABLE metadata(key TEXT, value TEXT)")
        con.execute("INSERT INTO sessions_v2 VALUES('claude:/host-1','claude',0,?,0,0,0)", (json.dumps({"data": {"summary": "Window title"}}),))
        # the window found this one in ~/.claude by itself (external): a hint, the window checks its list
        other = "abababab-abab-4bab-8bab-abababababab"
        self.claude(other, self.other, [claude_user("found by the window on its own", str(self.other))])
        con.execute("INSERT INTO sessions_v2 VALUES(?, 'claude',0,'{}',0,0,1)", (f"claude:/{other}",))
        con.commit()
        con.close()
        sdb = ud / "agentSessionData" / "host-1"
        sdb.mkdir(parents=True)
        con = sqlite3.connect(sdb / "session.db")
        con.execute("CREATE TABLE session_metadata(key TEXT, value TEXT)")
        con.execute("INSERT INTO session_metadata VALUES('defaultChatProviderData', ?)", (json.dumps({"sdkSessionId": sid}),))
        con.commit()
        con.close()
        rows = {r["session_id"]: r for r in self.rows(self.history(user_data=str(ud)))}
        r = rows[sid]
        self.assertEqual(r["window"], {"provider": "claude", "id": "host-1"})
        self.assertEqual(r["title"], "Window title")
        self.assertEqual(rows[other]["window"], {"provider": "claude", "id": other})
        with patch.dict(os.environ, {"DISPATCH_IDE_USER_DATA_DIRS": str(self.home / "none")}):
            self.assertIsNone({r["session_id"]: r for r in self.rows(H.history())}[sid]["window"])
        # the window's own profile is not the only one read: Dispatch IDE's other profiles count too
        with patch.dict(os.environ, {"DISPATCH_IDE_USER_DATA_DIRS": str(ud)}):
            r = {r["session_id"]: r for r in self.rows(H.history(user_data=str(self.home / "agents-ud")))}[sid]
        self.assertEqual(r["window"], {"provider": "claude", "id": "host-1"})

    def test_looking_registers_and_imports_nothing(self):
        self.three()
        D.refresh_index()
        before = sorted(os.listdir(self.state))
        with patch.object(D, "sh", side_effect=AssertionError("no commands")):
            H.history(scope="project", folder=str(self.repo), query="cart")
        added = sorted(set(os.listdir(self.state)) - set(before))
        self.assertTrue(set(added) <= {"session-history.db", "session-history.db-wal", "session-history.db-shm"}, added)
        self.assertFalse((self.home / ".dispatch").exists())

    def test_background_refresh_when_the_index_is_old(self):
        self.three()
        D.refresh_index()
        old = time.time() - 600
        os.utime(D.INDEX_FILE, (old, old))
        self.spawned.reset_mock()
        self.spawned.return_value = True
        self.assertTrue(H.history()["refreshing"])
        self.spawned.assert_called_once()
        self.spawned.reset_mock()
        H.history(refresh=False)
        self.spawned.assert_not_called()

    def test_no_index_yet_starts_one_and_answers_empty(self):
        with patch.object(D, "index_ensure", return_value={"state": "running", "done": 3, "total": 10}) as ensure:
            res = H.history()
        ensure.assert_called_once()
        self.assertEqual(res["groups"], [])
        self.assertEqual(res["indexing"], {"state": "running", "done": 3, "total": 10})

    def test_another_mac(self):
        Path(D.HOSTS_FILE).write_text(json.dumps([{"id": "mini", "name": "Mac mini"}]))
        ans = {"ok": True, "groups": [{"project": "x", "root": "/x", "count": 1, "sessions": [{"key": "k", "host": "local", "window": {"id": "1"}}]}]}
        args = type("A", (), dict(refresh=False, machine="mini", agents="", query="cart", sort="updated", limit=80, show_empty=False))()
        with patch.object(D, "remote_dispatch", return_value=ans) as rd:
            res = H.command(args)
        self.assertEqual(rd.call_args[0][1], ["sessions", "history", "--scope", "all", "--sort", "updated", "--limit", "80", "--query", "cart"])
        r = res["groups"][0]["sessions"][0]
        self.assertEqual((r["host"], r["window"], res["machine"]), ("mini", None, "mini"))
        self.assertEqual([m["id"] for m in res["machines"]], ["local", "mini"])
        with patch.object(D, "remote_dispatch", return_value=None), patch.object(D, "remote_pending", return_value=False):
            res = H.command(args)
        self.assertFalse(res["ok"])
        self.assertIn("Mac mini did not answer", res["error"])
        self.assertNotIn("pending", res)
        # slower than the page's first wait but still on its way: the page is told to ask again
        with patch.object(D, "remote_dispatch", return_value=None) as rd, patch.object(D, "remote_pending", return_value=True):
            res = H.command(args)
        self.assertEqual((res["ok"], res["pending"]), (False, True))
        self.assertEqual((rd.call_args.kwargs["timeout"], rd.call_args.kwargs["wait"]), (45, 8))

    def test_many_sessions_answer_fast(self):
        for i in range(350):
            cwd = self.repo if i % 2 else self.other
            self.claude(f"{i:08d}-0000-4000-8000-000000000000", cwd, [claude_user(f"ask number {i}", str(cwd)), claude_reply(f"answer {i}"),
                                                                     claude_tool_result("x" * 2000)])
        self.history()  # the first read of everything
        t = time.time()
        res = H.history(query="number 34")
        self.assertLess(time.time() - t, 1.5)
        self.assertEqual(sorted(r["title"] for r in self.rows(res)), sorted(f"ask number {i}" for i in range(350) if "34" in str(i)))
        self.assertEqual(H.history()["total"], 350)

    def test_cli(self):
        self.three()
        D.refresh_index()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), patch("sys.argv", ["dispatch", "sessions", "history", "--json", "--query", "cart", "--no-refresh"]):
            D.main()
        res = json.loads(buf.getvalue())
        self.assertTrue(res["ok"])
        self.assertEqual(res["matched"], 1)
        self.assertEqual(res["machine"], "local")


    # ---- the bell's last words ----------------------------------------------------------------

    def test_last_words_of_a_claude_session_is_its_last_line(self):
        sid = "33333333-3333-4333-8333-333333333333"
        self.claude(sid, self.repo, [
            claude_user("Fix the cart", str(self.repo)),
            claude_reply("Fixed it.\n\n```\ncode\n```\n\nAll 12 tests pass now."),
        ])
        self.assertEqual(H.last_words(f"claude-code:{sid}"), "All 12 tests pass now.")
        self.assertEqual(H.last_words(f"claude:/{sid}"), "All 12 tests pass now.")

    def test_last_words_is_empty_while_the_person_spoke_last(self):
        sid = "44444444-4444-4444-8444-444444444444"
        self.claude(sid, self.repo, [claude_reply("Done."), claude_user("one more thing", str(self.repo))])
        self.assertEqual(H.last_words(f"claude-code:{sid}"), "")

    def test_last_words_of_a_codex_thread(self):
        sid = "019a0000-0000-7000-8000-000000000001"
        self.codex(sid, self.repo, [line({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Pushed the branch."}]}})])
        self.assertEqual(H.last_words(f"codex:{sid}"), "Pushed the branch.")

    def test_last_words_of_a_window_session_through_its_own_id(self):
        sid = "55555555-5555-4555-8555-555555555555"
        self.claude(sid, self.repo, [claude_reply("Ready for review.")])
        ud = self.home / "ud"
        db = ud / "agentSessionData" / "host-1" / "session.db"
        db.parent.mkdir(parents=True)
        con = sqlite3.connect(db)
        con.execute("CREATE TABLE session_metadata(key TEXT PRIMARY KEY, value TEXT)")
        con.execute("INSERT INTO session_metadata VALUES('defaultChatProviderData', ?)", (json.dumps({"sdkSessionId": sid}),))
        con.commit()
        con.close()
        with patch("ide_sessions.apps", return_value=[]), patch("ide_sessions.NATIVE_ID_KEYS", ("sdkSessionId",)):
            self.assertEqual(H.last_words("agent-host-claude:/host-1", str(ud)), "Ready for review.")
            self.assertEqual(H.last_words("agent-host-claude:/nobody", str(ud)), "")

    def test_last_words_never_reads_outside_the_agent_folders(self):
        self.assertEqual(H.last_words("claude-code:../../etc/passwd"), "")
        self.assertEqual(H.last_words("bogus"), "")


class Clean(unittest.TestCase):
    def test_clean(self):
        self.assertEqual(H.clean("<command-name>/x</command-name>  hello\n  world "), "hello world")
        self.assertEqual(H.clean("<local-command-stdout>Login ok</local-command-stdout>"), "")
        self.assertEqual(H.clean("[Image #1]"), "")
        self.assertEqual(H.clean(None), "")

    def test_big_user_record_keeps_its_text(self):
        rec = json.dumps({"type": "user", "message": {"content": [{"type": "text", "text": "看这张图"}, {"type": "image", "source": {"data": "A" * (H.BIG_LINE + 10)}}]}}).encode()
        self.assertEqual(H.typed_in("claude-code", rec), "看这张图")


if __name__ == "__main__":
    unittest.main()
