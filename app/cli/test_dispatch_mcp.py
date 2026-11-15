# -*- coding: utf-8 -*-
"""Dispatch's MCP server (dispatch_mcp.py): what each tool runs, who a call is from, the protocol, registration."""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import dispatch_mcp as X
import mcp_config as M

HERE = os.path.dirname(os.path.abspath(__file__))


def build(name, **args):
    return X.BY_NAME[name].build(dict(args))


class Tools(unittest.TestCase):
    def test_every_tool_has_a_closed_schema_and_says_whether_it_writes(self):
        names = [t.name for t in X.TOOLS]
        self.assertEqual(len(names), len(set(names)))
        for t in X.TOOLS:
            listed = t.listing()
            self.assertEqual(listed["inputSchema"]["type"], "object")
            self.assertFalse(listed["inputSchema"]["additionalProperties"])
            self.assertTrue(set(listed["inputSchema"]["required"]) <= set(listed["inputSchema"]["properties"]), t.name)
            self.assertIn("readOnlyHint", listed["annotations"])
            self.assertNotIn(X.SESSION_ARG, listed["inputSchema"]["properties"])
        self.assertTrue({"task_begin", "task_log", "task_plan", "task_deliver", "task_done", "need_you", "handoff_write",
                         "prefs_add", "now", "delivery_page"} <= set(names))

    def test_begin_puts_every_value_in_one_argument(self):
        argv = build("task_begin", title="Square toggles: the user prefers them", project="demo",
                     description="Asked in the session; all toggles square", thing="toggles", acceptance=["toggles square", "- [ ] tested"],
                     owns="app/x.ts")
        self.assertEqual(argv, ["begin", "--project=demo", "--desc=Asked in the session; all toggles square", "--thing=toggles",
                                "--acceptance=- [ ] toggles square\n- [ ] tested", "--owns=app/x.ts", "--json",
                                "Square toggles: the user prefers them"])

    def test_begin_needs_no_project_in_a_chat(self):
        """task-p0za2: a session without a project folder has no project to name; task_begin asked for one anyway."""
        self.assertEqual(build("task_begin", title="Reschedule email: Monday no longer works", description="Asked for an email moving Monday"),
                         ["begin", "--desc=Asked for an email moving Monday", "--json", "Reschedule email: Monday no longer works"])
        tool = next(t for t in X.TOOLS if t.name == "task_begin")
        self.assertNotIn("project", tool.schema["required"])

    def test_text_that_starts_with_a_dash_never_reads_as_an_option(self):
        self.assertEqual(build("task_log", task="task-ab12", text="--host=mini rm -rf"), ["log", "task-ab12", " --host=mini rm -rf"])
        self.assertEqual(build("decide", task="task-ab12", text="-x"), ["decide", "task-ab12", " -x"])
        self.assertEqual(build("task_begin", title="T", project="--force", description="d")[1], "--project=--force")

    def test_task_ids_are_checked(self):
        for bad in ("--host=x", "-1", "a b", "x;rm", ""):
            with self.assertRaises(X.ToolError):
                build("task_log", task=bad, text="hi")

    def test_plan_marks_steps_by_number(self):
        self.assertEqual(build("task_plan", task="task-a1", steps=["One", "Two"], done=[1], active=2),
                         ["task", "plan", "task-a1", "--set=One", "--set=Two", "--done=1", "--active=2"])
        self.assertEqual(build("task_plan", task="task-a1", done="1,2"), ["task", "plan", "task-a1", "--done=1,2"])
        with self.assertRaises(X.ToolError):
            build("task_plan", task="task-a1")
        with self.assertRaises(X.ToolError):
            build("task_plan", task="task-a1", done=["one"])

    def test_deliver_takes_a_commit_hash_or_the_newest_commit(self):
        self.assertEqual(build("task_deliver", task="task-a1", commit=True), ["task", "deliver", "task-a1", "--commit"])
        self.assertEqual(build("task_deliver", task="task-a1", commit="abc1234", show=True),
                         ["task", "deliver", "task-a1", "--commit=abc1234", "--show"])
        self.assertEqual(build("task_deliver", task="task-a1", file="/x/page.html", label="Page"),
                         ["task", "deliver", "task-a1", "--file=/x/page.html", "--label=Page"])
        for bad in ({"commit": "HEAD; rm"}, {}, {"commit": "false"}):
            with self.assertRaises(X.ToolError):
                build("task_deliver", task="task-a1", **bad)
        # task-lj06.24: an agent that sends true as a string means the same (it was refused)
        for word in ("true", "True", " HEAD "):
            self.assertEqual(build("task_deliver", task="task-a1", commit=word), ["task", "deliver", "task-a1", "--commit"])

    def test_a_checklist_number_out_of_range_is_said_in_the_persons_language(self):
        """task-lj06.24: an English person's agent was told 「没有第 1 项（共 0 项）」."""
        import acceptance
        with patch.dict(os.environ, {"DISPATCH_LANG": "en"}):
            with self.assertRaises(ValueError) as e:
                acceptance.pick([], "1")
        self.assertEqual(str(e.exception), "There is no item 1: the checklist has 0 items")

    def test_preferences_are_like_or_avoid_in_the_persons_words(self):
        self.assertEqual(build("prefs_add", sentence="Toggles are square", kind="like", quote="square please", area="design",
                               replaces=["pill toggles"]),
                         ["prefs", "add", "--like", "--quote=square please", "--area=design", "--replaces=pill toggles", "--json",
                          "Toggles are square"])
        for bad in ({"kind": "love"}, {"kind": "like", "area": "food"}, {"kind": "like", "sentence": "-"}):
            with self.assertRaises(X.ToolError):
                build("prefs_add", **{"sentence": "S", "quote": "q", **bad})

    def test_waiting_for_you_handoff_profile_and_wiki(self):
        self.assertEqual(build("need_you", what="Sign in to the App Store", project="demo", how="Only you have the account", task="task-a1"),
                         ["need-you", "--project=demo", "--desc=Only you have the account", "--task=task-a1", "--json", "Sign in to the App Store"])
        self.assertEqual(build("handoff_write", task="task-a1", text="## 目标"), ["handoff", "write", "task-a1", "--stdin", "--json"])
        self.assertEqual(build("handoff_write", text="{}", session="codex:abc/subagent/kid", request="r-1"),
                         ["handoff", "write", "--session=codex:abc/subagent/kid", "--request=r-1", "--stdin", "--json"])
        with self.assertRaises(X.ToolError):
            build("handoff_write", text="{}", session="-x")
        self.assertEqual(build("profile_add", fact="Flies home", upcoming="2026-11-02|flight|todo"),
                         ["profile", "upcoming", "2026-11-02|flight|todo", "Flies home"])
        self.assertEqual(build("wiki_add", kind="pit", text="Trap", fix="Fix"), ["wiki", "add", "--kind=pit", "--fix=Fix", "Trap"])
        with self.assertRaises(X.ToolError):
            build("profile_add", fact="x", upcoming="soon")

    def test_done_refuses_next_titles_that_look_like_options(self):
        self.assertEqual(build("task_done", task="task-a1", reason="ok", next=["Polish it"]),
                         ["done", "task-a1", "--reason=ok", "--next", "Polish it"])
        with self.assertRaises(X.ToolError):
            build("task_done", task="task-a1", reason="ok", next=["--host=x"])


class Calls(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dmcp-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.ran = []

    def runner(self, code=0, out="ok", err=""):
        def run(argv, env, cwd, stdin):
            self.ran.append((argv, env, cwd, stdin))
            return code, out, err
        return run

    def ctx(self, agent="codex", **env):
        return X.Context(agent=agent, env={"HOME": self.tmp, "PATH": "/bin", **env}, cwd=self.tmp)

    def test_codex_names_its_thread_and_folders_in_meta(self):
        ws = os.path.join(self.tmp, "ws")
        os.makedirs(ws)
        meta = {"threadId": "01a1144a-c653-7e91-b073-77f995d43bcc", "x-codex-turn-metadata": {"workspaces": {ws: {}}}}
        text, failed = X.call("now", {"text": "Testing"}, self.ctx(), meta, self.runner())
        self.assertEqual((text, failed), ("ok", False))
        argv, env, cwd, _ = self.ran[0]
        self.assertEqual(argv, ["now", "Testing"])
        self.assertEqual(env["CODEX_THREAD_ID"], "01a1144a-c653-7e91-b073-77f995d43bcc")
        self.assertEqual((env["BEADS_ACTOR"], env["DISPATCH_ACTOR"], env["DISPATCH_CALLER"]), ("codex", "codex", "agent"))
        self.assertEqual(cwd, ws)

    def test_the_opencode_plugin_adds_the_session_to_the_arguments(self):
        X.call("task_list", {"dispatch_session": "ses_abcdefgh1234"}, self.ctx("opencode"), None, self.runner())
        argv, env, _, _ = self.ran[0]
        self.assertEqual(env["DISPATCH_SESSION_ID"], "ses_abcdefgh1234")
        self.assertIn("--session=ses_abcdefgh1234", argv)

    def test_claude_codes_own_session_variable_is_kept(self):
        X.call("task_list", {}, self.ctx("claude-code", CLAUDE_CODE_SESSION_ID="928d34f5-6a0b-4cff-bc5b-5356030500f4"), {}, self.runner())
        self.assertIn("--session=928d34f5-6a0b-4cff-bc5b-5356030500f4", self.ran[0][0])

    def test_task_list_without_a_session_asks_for_a_project(self):
        text, failed = X.call("task_list", {}, self.ctx(), {}, self.runner())
        self.assertTrue(failed)
        self.assertIn("project", text)
        self.assertEqual(self.ran, [])

    def test_in_a_test_instance_the_instance_board_wins_over_an_agents_own(self):
        import ide_e2e
        root = os.path.join(self.tmp, "e2e-root")
        rec = {"name": "mcpx", "root": os.path.join(root, "mcpx"), "beads_dir": os.path.join(root, "mcpx", "board", ".beads"),
               "dispatch_dir": os.path.join(root, "mcpx", "dispatch"), "dispatch_home": os.path.join(root, "mcpx", "home")}
        with patch.dict(os.environ, {"DISPATCH_E2E_ROOT": root}):
            ide_e2e.write_record(rec)
            # Claude Code's settings.json "env" hands every child the person's own BEADS_DIR
            ctx = self.ctx("claude-code", DISPATCH_E2E_INSTANCE="mcpx", BEADS_DIR="/Users/me/tasks/.beads")
            X.call("now", {"text": "x"}, ctx, {}, self.runner())
        env = self.ran[0][1]
        self.assertEqual((env["BEADS_DIR"], env["DISPATCH_DIR"], env["DISPATCH_HOME"]), (rec["beads_dir"], rec["dispatch_dir"], rec["dispatch_home"]))
        # no record, or the record of another instance by that name: what the agent passed stays
        self.assertEqual(X.instance_scoped({"DISPATCH_E2E_INSTANCE": "gone", "BEADS_DIR": "/b"})["BEADS_DIR"], "/b")
        with patch.dict(os.environ, {"DISPATCH_E2E_ROOT": root}):
            self.assertEqual(X.instance_scoped({"DISPATCH_E2E_INSTANCE": "mcpx", "DISPATCH_SESSION_ROOT": "/tmp/other", "BEADS_DIR": "/b"})["BEADS_DIR"], "/b")
            self.assertEqual(X.instance_scoped({"DISPATCH_E2E_INSTANCE": "mcpx", "DISPATCH_SESSION_ROOT": rec["root"], "BEADS_DIR": "/b"})["BEADS_DIR"], rec["beads_dir"])

    def test_unknown_arguments_and_tools_are_refused_before_anything_runs(self):
        self.assertTrue(X.call("task_log", {"task": "task-a1", "text": "x", "command": "rm"}, self.ctx(), {}, self.runner())[1])
        self.assertTrue(X.call("shell", {"command": "ls"}, self.ctx(), {}, self.runner())[1])
        self.assertEqual(self.ran, [])

    def test_a_delivery_page_only_from_inside_the_working_folder(self):
        inside = os.path.join(self.tmp, "design", "x")
        os.makedirs(inside)
        text, failed = X.call("delivery_page", {"task": "task-a1", "folder": "/etc"}, self.ctx(), {}, self.runner())
        self.assertTrue(failed)
        self.assertIn("inside", text)
        _, failed = X.call("delivery_page", {"task": "task-a1", "folder": "design/x"}, self.ctx(), {}, self.runner())
        self.assertFalse(failed)
        self.assertIn("--from=" + inside, self.ran[0][0])
        os.symlink("/etc", os.path.join(self.tmp, "design", "out"))
        self.assertTrue(X.call("delivery_page", {"task": "task-a1", "folder": "design/out"}, self.ctx(), {}, self.runner())[1])

    def test_a_handoff_goes_in_on_stdin(self):
        X.call("handoff_write", {"task": "task-a1", "text": "## 目标\nx"}, self.ctx(), {}, self.runner())
        self.assertEqual(self.ran[0][3], "## 目标\nx")

    def test_a_failed_command_says_why_and_long_answers_are_cut(self):
        text, failed = X.call("task_claim", {"task": "task-a1"}, self.ctx(), {}, self.runner(1, "", "no such task"))
        self.assertEqual((text, failed), ("no such task", True))
        text, _ = X.call("task_show", {"task": "task-a1"}, self.ctx(), {}, self.runner(0, "x" * (X.MAX_OUTPUT + 50)))
        self.assertTrue(text.endswith("(cut here)"))


class Protocol(unittest.TestCase):
    def talk(self, *msgs, agent=""):
        out = io.StringIO()
        ran = []
        server = X.Server(X.Context(agent=agent, env={"PATH": "/bin"}, cwd=tempfile.gettempdir()), out=out,
                          runner=lambda argv, env, cwd, stdin: (ran.append((argv, env)) or (0, "done", "")))
        server.serve([json.dumps(m) for m in msgs] + ["not json"])
        return [json.loads(line) for line in out.getvalue().splitlines()], ran, server

    def test_initialize_list_call_and_errors(self):
        replies, ran, server = self.talk(
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "clientInfo": {"name": "claude-code"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "now", "arguments": {"text": "Working"}}},
            {"jsonrpc": "2.0", "id": 4, "method": "ping"},
            {"jsonrpc": "2.0", "id": 5, "method": "sampling/createMessage"})
        by = {r.get("id"): r for r in replies}
        self.assertEqual(by[1]["result"]["protocolVersion"], "2025-06-18")
        self.assertEqual(by[1]["result"]["serverInfo"]["name"], "dispatch")
        self.assertEqual(server.ctx.agent, "claude-code")
        self.assertEqual(len(by[2]["result"]["tools"]), len(X.TOOLS))
        self.assertEqual(by[3]["result"], {"content": [{"type": "text", "text": "done"}], "isError": False})
        self.assertEqual(by[4]["result"], {})
        self.assertEqual(by[5]["error"]["code"], -32601)
        self.assertEqual(by[None]["error"]["code"], -32700)
        self.assertEqual(ran[0][1]["BEADS_ACTOR"], "claude-code")

    def test_an_unknown_protocol_version_gets_the_newest(self):
        replies, _, _ = self.talk({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}})
        self.assertEqual(replies[0]["result"]["protocolVersion"], X.PROTOCOLS[0])

    def test_the_agent_from_the_command_line_wins_over_the_client_name(self):
        _, _, server = self.talk({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": {"name": "codex-mcp-client"}}},
                                 agent="opencode")
        self.assertEqual(server.ctx.agent, "opencode")
        self.assertEqual([X.agent_of_client(n) for n in ("codex-mcp-client", "claude-code", "opencode", "x")],
                         ["codex", "claude-code", "opencode", ""])


class Register(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name
        env = {"HOME": self.home, "CODEX_HOME": os.path.join(self.home, ".codex"), "XDG_CONFIG_HOME": os.path.join(self.home, ".config")}
        p = patch.dict(os.environ, env)
        p.start(); self.addCleanup(p.stop)
        for k in ("CLAUDE_CONFIG_DIR", "DISPATCH_SESSION_ROOT"):
            os.environ.pop(k, None)
        p = patch.object(M, "home", return_value=self.home)
        p.start(); self.addCleanup(p.stop)
        self.state = {"agents": ["claude-code", "codex", "opencode"]}
        p = patch.object(X, "_state", side_effect=lambda: dict(self.state))
        p.start(); self.addCleanup(p.stop)
        p = patch.object(X, "remember", side_effect=lambda on: self.state.update(mcp_server="on" if on else "off"))
        p.start(); self.addCleanup(p.stop)
        os.makedirs(os.path.join(self.home, ".codex"))
        with open(os.path.join(self.home, ".codex", "config.toml"), "w") as f:
            f.write('model = "gpt"\n[mcp_servers.mine]\ncommand = "mine"\nargs = []\n')
        self.claude = os.path.join(self.home, ".claude.json")
        with open(self.claude, "w") as f:
            json.dump({"numStartups": 3, "mcpServers": {"harbor": {"type": "stdio", "command": "node", "args": ["a.mjs"]}}}, f)
        self.settings = os.path.join(self.home, ".claude", "settings.json")
        os.makedirs(os.path.dirname(self.settings))
        with open(self.settings, "w") as f:
            json.dump({"permissions": {"allow": ["Bash"]}, "theme": "dark"}, f)
        self.codex = os.path.join(self.home, ".codex", "config.toml")
        self.opencode = os.path.join(self.home, ".config", "opencode", "opencode.json")

    def read(self, path):
        with open(path) as f:
            return f.read()

    def test_register_adds_it_to_each_engine_once_and_keeps_the_rest(self):
        r = X.register()
        self.assertEqual(sorted(c["engine"] for c in r["changed"] if c["action"] == "added"), ["claude-code", "codex", "opencode"])
        claude = json.loads(self.read(self.claude))
        self.assertEqual(claude["numStartups"], 3)
        self.assertIn("harbor", claude["mcpServers"])
        entry = claude["mcpServers"]["dispatch"]
        self.assertEqual(entry["args"][1:], ["mcp", "serve", "--agent", "claude-code"])
        self.assertTrue(entry["args"][0].endswith(os.path.join("cli", "dispatch.py")))
        settings = json.loads(self.read(self.settings))
        self.assertEqual(settings["permissions"]["allow"], ["Bash", "mcp__dispatch"])
        self.assertEqual(settings["theme"], "dark")
        toml = self.read(self.codex)
        self.assertIn("[mcp_servers.mine]", toml)
        self.assertIn('default_tools_approval_mode = "approve"', toml)
        self.assertIn('"DISPATCH_DIR"', toml)
        self.assertIn('"BEADS_DIR"', toml)
        self.assertIn("tool_timeout_sec = 120", toml)
        oc = json.loads(self.read(self.opencode))["mcp"]["dispatch"]
        self.assertEqual(oc["command"][-2:], ["--agent", "opencode"])
        again = X.register()
        self.assertEqual(again["changed"], [])
        self.assertEqual(sorted(again["same"]), ["claude-code", "codex", "opencode"])
        rows = {(s["engine"], s["name"]): s for s in M.listing()["servers"]}
        self.assertTrue(rows[("codex", "dispatch")]["builtin"])
        self.assertFalse(rows[("codex", "mine")]["builtin"])
        st = X.status()
        self.assertTrue(all(e["present"] and e["ours"] and e["current"] for e in st["engines"]))

    def test_an_older_copy_is_brought_up_to_date(self):
        with open(self.codex, "a") as f:
            f.write('\n[mcp_servers.dispatch]\ncommand = "python3"\nargs = ["/old/cli/dispatch.py", "mcp", "serve"]\n')
        r = X.register(["codex"])
        self.assertEqual([c["action"] for c in r["changed"]], ["added"])
        toml = self.read(self.codex)
        self.assertNotIn("/old/cli", toml)
        self.assertEqual(toml.count("[mcp_servers.dispatch]"), 1)

    def test_a_server_of_the_persons_own_called_dispatch_is_left_alone(self):
        with open(self.codex, "a") as f:
            f.write('\n[mcp_servers.dispatch]\ncommand = "node"\nargs = ["/my/dispatch-bot.js"]\n')
        r = X.register(["codex"])
        self.assertEqual(r["changed"], [])
        self.assertIn("your own", r["skipped"][0]["reason"])
        self.assertIn("/my/dispatch-bot.js", self.read(self.codex))

    def test_a_denied_server_stays_denied_in_claude(self):
        with open(self.settings, "w") as f:
            json.dump({"permissions": {"deny": ["mcp__dispatch"]}}, f)
        X.register(["claude-code"])
        self.assertNotIn("allow", json.loads(self.read(self.settings))["permissions"])

    def test_the_agents_window_start_respects_setup_and_a_removal(self):
        with patch.object(X, "set_up", return_value=False):
            self.assertEqual(X.register(if_set_up=True)["changed"], [])
        with patch.object(X, "set_up", return_value=True):
            self.assertTrue(X.register(if_set_up=True)["changed"])
            a = type("A", (), dict(op="remove", name="dispatch", engine="", json=True, replace=False, url="", command=[], from_engine=""))()
            with patch("sys.stdout", new=io.StringIO()):
                M.command(a)
            self.assertEqual(self.state["mcp_server"], "off")
            self.assertNotIn("dispatch", json.loads(self.read(self.claude))["mcpServers"])
            r = X.register(if_set_up=True)
            self.assertEqual(r["changed"], [])
            self.assertIn("turned off", r["skipped"][0]["reason"])
            X.register()  # `dispatch mcp register` turns it back on
            self.assertEqual(self.state["mcp_server"], "on")
            self.assertIn("dispatch", json.loads(self.read(self.claude))["mcpServers"])

    def test_settings_switch_takes_it_out_everywhere_and_puts_it_back(self):
        # Settings › MCP servers lists Dispatch's server as Built-in with a switch (task-lj06.23)
        X.register()
        listed = M.listing()
        self.assertEqual(listed["builtin"]["engines"], ["claude-code", "codex", "opencode"])
        self.assertTrue(listed["builtin"]["on"])
        self.assertIn("task board", listed["builtin"]["about"])
        with open(self.codex, "a") as f:  # another engine's file keeps the person's own servers
            f.write("")
        r = X.turn_off()
        self.assertFalse(r["on"])
        self.assertEqual(sorted(c["engine"] for c in r["changed"]), ["claude-code", "codex", "opencode"])
        self.assertEqual(self.state["mcp_server"], "off")
        self.assertNotIn("dispatch", json.loads(self.read(self.claude))["mcpServers"])
        self.assertIn("harbor", json.loads(self.read(self.claude))["mcpServers"])
        self.assertIn("[mcp_servers.mine]", self.read(self.codex))
        self.assertNotIn("[mcp_servers.dispatch]", self.read(self.codex))
        self.assertFalse(M.listing()["builtin"]["on"])
        # the Agents window's start does not put it back
        with patch.object(X, "set_up", return_value=True):
            self.assertEqual(X.register(if_set_up=True)["changed"], [])
        r = X.turn_on()
        self.assertTrue(r["on"])
        self.assertEqual(self.state["mcp_server"], "on")
        self.assertTrue(M.listing()["builtin"]["on"])

    def test_the_switch_leaves_a_server_of_the_persons_own_called_dispatch(self):
        with open(self.codex, "a") as f:
            f.write('\n[mcp_servers.dispatch]\ncommand = "node"\nargs = ["/my/dispatch-bot.js"]\n')
        self.assertFalse(M.listing()["builtin"]["on"])
        X.turn_off()
        self.assertIn("/my/dispatch-bot.js", self.read(self.codex))

    def test_the_command_line_on_and_off(self):
        X.register()
        for op, on in (("off", False), ("on", True)):
            a = type("A", (), dict(op=op, json=True))()
            out = io.StringIO()
            with patch("sys.stdout", new=out):
                self.assertEqual(X.command(a), 0)
            self.assertEqual(json.loads(out.getvalue())["on"], on)
            self.assertEqual(M.listing()["builtin"]["on"], on)

    def test_engines_not_picked_and_not_on_this_mac_get_nothing(self):
        self.state = {"agents": ["codex"]}
        shutil.rmtree(os.path.join(self.home, ".claude"))
        os.unlink(self.claude)
        r = X.register()
        self.assertEqual([c["engine"] for c in r["changed"]], ["codex"])
        self.assertFalse(os.path.exists(self.claude))
        self.assertFalse(os.path.exists(self.opencode))


class Transcripts(unittest.TestCase):
    """A session that worked on a task through these tools is linked to it, as one that ran `dispatch log X` is."""

    def test_the_three_engines_ways_of_writing_a_call_down(self):
        import presence
        claude = {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "mcp__dispatch__task_log",
                                                                "input": {"task": "task-ab12", "text": "x"}}]}}
        codex = {"type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "McpToolCall", "server": "dispatch",
                                                                                     "tool": "task_done", "arguments": {"task": "task-cd34", "reason": "ok"}}}}
        opencode = {"type": "tool", "tool": "dispatch_task_claim", "state": {"input": {"task": "task-ef56"}}}
        codex_fn = {"type": "response_item", "payload": {"type": "function_call", "name": "mcp__dispatch__decide",
                                                         "arguments": json.dumps({"task": "task-gh78", "text": "go"})}}
        self.assertEqual([presence.mcp_task_ids(x) for x in (claude, codex, opencode, codex_fn)],
                         [["task-ab12"], ["task-cd34"], ["task-ef56"], ["task-gh78"]])
        others = [{"type": "tool_use", "name": "mcp__dispatch__task_show", "input": {"task": "task-ab12"}},
                  {"type": "McpToolCall", "server": "probe", "tool": "task_log", "arguments": {"task": "task-ab12"}},
                  {"type": "tool_use", "name": "mcp__other__task_log", "input": {"task": "task-ab12"}},
                  {"type": "tool_result", "content": "mcp__dispatch__task_log task-ab12"}]
        self.assertEqual([presence.mcp_task_ids(x) for x in others], [[], [], [], []])
        self.assertEqual(presence.task_ids({"tool_name": "mcp__dispatch__task_log", "tool_input": {"task": "task-ab12"}}), ["task-ab12"])

    def test_the_transcript_index_counts_them_as_claims(self):
        import re
        import dispatch as D
        lines = [json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "mcp__dispatch__task_claim",
                                                                           "input": {"task": "task-ab12"}}]}})]
        self.assertEqual(D.claims_of_events(lines, re.compile(r"^task-[a-z0-9]+$")), ["task-ab12"])


BD = shutil.which("bd")


@unittest.skipUnless(BD and os.name == "posix", "needs bd")
class RealServer(unittest.TestCase):
    """`dispatch mcp serve` as an engine starts it, on a real board in a temp folder: begin, log, a preference."""

    def test_codex_writes_the_board_through_the_server(self):
        root = tempfile.mkdtemp(prefix="dmcp-real-")
        self.addCleanup(shutil.rmtree, root, True)
        board = os.path.join(root, "board")
        os.makedirs(board)
        os.makedirs(os.path.join(root, "home"))
        # what Codex hands a server: a short environment plus the variables named in env_vars
        env = {"HOME": os.path.join(root, "home"), "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "DISPATCH_DIR": os.path.join(root, "dd"),
               "BEADS_DIR": os.path.join(board, ".beads"), "DISPATCH_BOARD_SERVICE": "0", "PYTHONDONTWRITEBYTECODE": "1"}
        r = subprocess.run([BD, "init", "--prefix", "task", "--non-interactive", "--skip-hooks", "--quiet"], cwd=board, env=env,
                           capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        thread = "01a1144a-c653-7e91-b073-77f995d43bcc"
        calls = [("task_begin", {"title": "Square toggles: the user prefers them", "project": "demo",
                                 "description": "Asked in a Codex session; expected: every toggle square"}),
                 ("prefs_add", {"sentence": "Toggles are square, not pills", "kind": "like", "quote": "square toggles please"})]
        lines = [{"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "clientInfo": {"name": "codex-mcp-client"}}}]
        lines += [{"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": n, "arguments": a, "_meta": {"threadId": thread}}}
                  for i, (n, a) in enumerate(calls, 1)]
        out = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "mcp", "serve", "--agent", "codex"],
                             input="\n".join(json.dumps(x) for x in lines) + "\n", env=env, cwd=board, capture_output=True, text=True, timeout=300)
        replies = {r["id"]: r for r in map(json.loads, out.stdout.splitlines())}
        begun = replies[1]["result"]
        self.assertFalse(begun["isError"], begun)
        tid = json.loads(begun["content"][0]["text"])["id"]
        self.assertFalse(replies[2]["result"]["isError"], replies[2])
        lines = [lines[0], {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                            "params": {"name": "task_log", "arguments": {"task": tid, "text": "-started from the sandbox"}, "_meta": {"threadId": thread}}},
                 {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "task_show", "arguments": {"task": tid}, "_meta": {"threadId": thread}}}]
        out = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "mcp", "serve", "--agent", "codex"],
                             input="\n".join(json.dumps(x) for x in lines) + "\n", env=env, cwd=board, capture_output=True, text=True, timeout=300)
        replies = {r["id"]: r for r in map(json.loads, out.stdout.splitlines())}
        self.assertFalse(replies[3]["result"]["isError"], replies[3])
        shown = json.loads(replies[4]["result"]["content"][0]["text"])
        self.assertEqual((shown["session"], shown["agent"]), (thread, "codex"))
        r = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "prefs", "list", "--json"], env=env, cwd=board,
                           capture_output=True, text=True, timeout=120)
        self.assertIn("Toggles are square, not pills", r.stdout)


if __name__ == "__main__":
    unittest.main()
