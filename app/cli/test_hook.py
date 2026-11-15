# -*- coding: utf-8 -*-
"""Dispatch's one hook entry (hook.py) and putting it into each agent (hooks_setup.py, engines/codex.py trust).
Scratch files and a temporary DISPATCH_HOME only; Codex itself is never started (its app server is faked)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engines
import hook
import hooks_setup
from engines import codex as CX

HERE = os.path.dirname(os.path.abspath(__file__))


class Scratch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dispatch-hook-")
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name
        self.config = os.path.join(self.root, "dispatch-home", "config.json")
        p = mock.patch.dict(os.environ, {"DISPATCH_HOME": os.path.dirname(self.config), "DISPATCH_DIR": os.path.join(self.root, "state")})
        p.start()
        self.addCleanup(p.stop)

    def set_switch(self, agent, feature, on):
        os.makedirs(os.path.dirname(self.config), exist_ok=True)
        cfg = {}
        if os.path.exists(self.config):
            with open(self.config) as f:
                cfg = json.load(f)
        cfg.setdefault("hooks", {}).setdefault(agent, {})[feature] = on
        with open(self.config, "w") as f:
            json.dump(cfg, f)


class Merge(unittest.TestCase):
    def test_contexts_and_messages_are_joined_and_a_deny_or_block_wins(self):
        out = hook.merge([None, {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "one"}, "systemMessage": "m1"},
                          {"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "held"}},
                          {"hookSpecificOutput": {"additionalContext": "two"}, "systemMessage": "m2", "continue": True}], "PreToolUse")
        self.assertEqual(out, {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "one\n\ntwo",
                                                      "permissionDecision": "deny", "permissionDecisionReason": "held"},
                               "systemMessage": "m1\nm2"})
        stop = hook.merge([{"decision": "block", "reason": "write the handoff"}, {"decision": "block", "reason": "a worker finished"}], "Stop")
        self.assertEqual(stop, {"decision": "block", "reason": "write the handoff\n\na worker finished"})
        self.assertEqual(hook.merge([None, {}, {"continue": True}], "Stop"), {})


class Routes(Scratch):
    def answer(self, agent, data, **kw):
        calls = []

        def fake(name, out=None):
            def run(a, event, d):
                calls.append(name)
                return out
            return run
        run = {f: fake(f) for f in hook.FEATURES}
        run.update(kw)
        with mock.patch.dict(hook.RUN, run):
            out = hook.answer(agent, data, config=self.config)
        return calls, out

    def test_each_engine_runs_its_features_in_order(self):
        calls, _ = self.answer("claude-code", {"hook_event_name": "SessionStart"})
        self.assertEqual(calls, ["presence", "prime"])
        calls, _ = self.answer("claude-code", {"hook_event_name": "PostToolUse", "tool_name": "Bash"})
        self.assertEqual(calls, ["presence", "plan", "life"])  # the edit guard is off until turned on
        calls, _ = self.answer("codex", {"hook_event_name": "SessionStart"})
        self.assertEqual(calls, ["prime"])
        calls, _ = self.answer("codex", {"hook_event_name": "PostToolUse"})
        self.assertEqual(calls, ["presence", "plan", "life"])
        calls, _ = self.answer("opencode", {"hook_event_name": "Stop"})
        self.assertEqual(calls, ["life"])
        self.assertEqual(self.answer("claude-code", {"hook_event_name": "SomethingNew"}), ([], {}))
        self.assertEqual(self.answer("gemini", {"hook_event_name": "SessionStart"}), ([], {}))

    def test_a_switch_turns_one_feature_off_and_the_edit_guard_on(self):
        self.set_switch("claude-code", "prime", False)
        self.set_switch("claude-code", "edit-guard", True)
        calls, _ = self.answer("claude-code", {"hook_event_name": "SessionStart"})
        self.assertEqual(calls, ["presence"])
        calls, _ = self.answer("claude-code", {"hook_event_name": "PreToolUse"})
        self.assertEqual(calls, ["presence", "edit-guard"])
        calls, _ = self.answer("codex", {"hook_event_name": "SessionStart"})
        self.assertEqual(calls, ["prime"], "a switch is per agent")

    def test_one_feature_failing_does_not_take_the_others_down(self):
        def boom(a, event, d):
            raise RuntimeError("no board")
        brief = {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "# brief"}}
        calls, out = self.answer("claude-code", {"hook_event_name": "SessionStart"}, presence=boom, prime=lambda a, e, d: brief)
        self.assertEqual(out, brief)

    def test_the_trace_says_what_ran_and_what_it_answered(self):
        log = os.path.join(self.root, "hook.log")
        brief = {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "# brief"}}

        def boom(a, event, d):
            raise RuntimeError("no board")
        with mock.patch.dict(os.environ, {"DISPATCH_HOOK_LOG": log}):
            self.answer("codex", {"hook_event_name": "SessionStart", "session_id": "t1"}, prime=lambda a, e, d: brief)
            self.answer("codex", {"hook_event_name": "PostToolUse", "thread_id": "t1", "tool_name": "Bash"}, life=boom)
        with open(log) as f:
            rows = [json.loads(line) for line in f]
        self.assertEqual([(r["event"], r["session"], r["ran"]) for r in rows],
                         [("SessionStart", "t1", ["prime"]), ("PostToolUse", "t1", ["presence", "plan", "life!"])])
        self.assertEqual(rows[0]["answer"], brief)

    def test_codex_presence_only_after_a_command_and_the_plan_only_after_the_to_do_list(self):
        with mock.patch("presence.record") as rec:
            hook.presence("codex", "PostToolUse", {"tool_name": "apply_patch"})
            rec.assert_not_called()
            hook.presence("codex", "PostToolUse", {"tool_name": "Bash"})
            rec.assert_called_once()
            hook.presence("claude-code", "PostToolUse", {"tool_name": "Edit"})
            self.assertEqual(rec.call_count, 2)
        with mock.patch.object(hook.subprocess, "Popen") as popen:
            hook.plan("claude-code", "PostToolUse", {"tool_name": "Bash"})
            popen.assert_not_called()
            for agent, tool in (("claude-code", "TodoWrite"), ("codex", "update_plan"), ("opencode", "todowrite")):
                hook.plan(agent, "PostToolUse", {"tool_name": tool, "tool_input": {}})
            self.assertEqual(popen.call_count, 3)
            argv = popen.call_args.args[0]
            self.assertEqual(argv[1:], [os.path.join(HERE, "dispatch.py"), "task", "plan", "--hook"])
            self.assertTrue(popen.call_args.kwargs["start_new_session"])

    def test_the_edit_guard_only_looks_at_edits(self):
        self.assertIsNone(hook.edit_guard("claude-code", "PreToolUse", {"tool_name": "Bash"}))
        self.assertIsNone(hook.edit_guard("codex", "PreToolUse", {"tool_name": "apply_patch"}))

    def test_prime_asks_the_cli_as_the_agent(self):
        brief = {"continue": True, "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "# brief"}}
        with mock.patch.object(hook.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "noise\n" + json.dumps(brief), "")) as run, \
                mock.patch.dict(os.environ, {"BEADS_ACTOR": "the-person"}):
            self.assertEqual(hook.prime("codex", "SessionStart", {"session_id": "t1", "cwd": self.root}), brief)
        argv, kw = run.call_args.args[0], run.call_args.kwargs
        self.assertEqual(argv[1:], [os.path.join(HERE, "dispatch.py"), "prime", "--hook-json"])
        self.assertEqual(json.loads(kw["input"])["session_id"], "t1")
        self.assertEqual((kw["env"]["BEADS_ACTOR"], kw["cwd"]), ("codex", self.root))
        with mock.patch.object(hook.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "# brief\n", "")) as run:
            out = hook.prime("opencode", "SessionStart", {"session_id": "ses_1", "cwd": self.root, "source": "compact"})
        self.assertEqual(out["hookSpecificOutput"]["additionalContext"], "# brief")
        argv, env = run.call_args.args[0], run.call_args.kwargs["env"]
        self.assertEqual(argv[2:], ["prime", "--opencode", "--cwd", self.root, "--source", "compact"])
        self.assertEqual((env["DISPATCH_SESSION_ID"], env["BEADS_ACTOR"], env["DISPATCH_ACTOR"]), ("ses_1", "opencode", "opencode"))
        with mock.patch.object(hook.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "boom")):
            self.assertIsNone(hook.prime("claude-code", "SessionStart", {}))

    def test_a_start_waits_for_the_brief_only_as_long_as_the_sdk_allows_but_a_handoff_waits_in_full(self):
        """Dispatch IDE's Claude sessions fail after 60 s of start, hooks included (2026-10-11: the brief took 45 s on
        a loaded Mac and the Assistant could not send). A start or a resume stops waiting at START_BUDGET; a /clear or
        a compaction carries the handoff and keeps PRIME_TIMEOUT."""
        late = subprocess.TimeoutExpired(["prime"], 1)
        for agent in ("claude-code", "codex", "opencode"):
            for source in ("startup", "resume", ""):
                with mock.patch.object(hook.subprocess, "run", side_effect=late) as run:
                    out = hook.prime(agent, "SessionStart", {"session_id": "t1", "cwd": self.root, "source": source})
                self.assertLessEqual(run.call_args.kwargs["timeout"], hook.START_BUDGET)
                note = out["hookSpecificOutput"]["additionalContext"]
                self.assertIn("dispatch prime", note)
                self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "SessionStart")
            for source in ("compact", "clear"):
                with mock.patch.object(hook.subprocess, "run", side_effect=late) as run:
                    hook.prime(agent, "SessionStart", {"session_id": "t1", "cwd": self.root, "source": source})
                self.assertEqual(run.call_args.kwargs["timeout"], hook.PRIME_TIMEOUT)
        self.assertLess(hook.START_BUDGET + 15, 60, "the SDK's 60 s must leave room for Claude Code's own start")
        self.assertLessEqual(hook.PRIME_TIMEOUT, engines.get("claude-code").hook_options["SessionStart"]["timeout"])

    def test_the_budget_counts_from_the_hook_s_own_start(self):
        with mock.patch.object(hook, "STARTED", hook.time.monotonic() - hook.START_BUDGET - 5), \
                mock.patch.object(hook.subprocess, "run", side_effect=subprocess.TimeoutExpired(["prime"], 1)) as run:
            hook.prime("claude-code", "SessionStart", {"session_id": "t1", "cwd": self.root, "source": "resume"})
        self.assertEqual(run.call_args.kwargs["timeout"], 1.0)

    def test_a_brief_that_hangs_is_stopped_and_the_start_goes_on(self):
        """A real child that does not answer: the hook answers with the note in about the budget, not 40 s."""
        slow = os.path.join(self.root, "slow_prime.py")
        with open(slow, "w") as f:
            f.write("import time\ntime.sleep(30)\nprint('{}')\n")
        with mock.patch.object(hook, "cli_path", lambda: slow), mock.patch.object(hook, "START_BUDGET", 2), \
                mock.patch.object(hook, "STARTED", hook.time.monotonic()):
            t0 = hook.time.monotonic()
            out = hook.answer("claude-code", {"hook_event_name": "SessionStart", "session_id": "t1", "cwd": self.root, "source": "resume"},
                              only=("prime",))
            took = hook.time.monotonic() - t0
        self.assertLess(took, 6)
        self.assertIn("dispatch prime", out["hookSpecificOutput"]["additionalContext"])

    def test_a_side_chat_gets_no_brief(self):
        """A side chat's forked conversation has the brief; reading the board again only delays its first answer."""
        with mock.patch.object(hook.subprocess, "run") as run, mock.patch.dict(os.environ, {"DISPATCH_SIDE_CHAT": "1"}):
            self.assertIsNone(hook.prime("claude-code", "SessionStart", {"session_id": "t1", "cwd": self.root, "source": "resume"}))
        run.assert_not_called()


class AsAgentsRunIt(Scratch):
    """The entry the way Claude Code and Codex run it: a fresh interpreter, the hook JSON on stdin."""

    def run_entry(self, agent, data, code_after=""):
        code = ("import sys, io, json; sys.path.insert(0, %r); import hook; sys.argv = ['hook.py', %r]; hook.main(); %s"
                % (HERE, agent, code_after))
        r = subprocess.run([sys.executable, "-c", code], input=json.dumps(data, ensure_ascii=False).encode("utf-8"),
                           capture_output=True, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"), timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr.decode("utf-8", "replace"))
        return r.stdout.decode("utf-8").splitlines()

    def test_a_tool_call_below_the_line_records_presence_and_never_loads_dispatch(self):
        import session_life as L
        cwd = os.path.join(self.root, "项目")
        os.makedirs(cwd)
        state = os.path.join(self.root, "state")
        L.cache_settings(dict(L.SETTINGS), state)
        transcript = os.path.join(self.root, "t.jsonl")
        with open(transcript, "w") as f:
            f.write(json.dumps({"type": "assistant", "uuid": "u0", "requestId": "r0", "timestamp": "2026-09-30T08:00:00Z",
                                "message": {"id": "m0", "model": "claude-opus-5-5", "role": "assistant", "content": [],
                                            "usage": {"input_tokens": 1000, "output_tokens": 1}}}) + "\n")
        lines = self.run_entry("claude-code", {"hook_event_name": "PostToolUse", "session_id": "s-1", "cwd": cwd, "tool_name": "Read",
                                               "tool_input": {}, "transcript_path": transcript},
                               "print('DISPATCH' if 'dispatch' in sys.modules else 'LEAN')")
        self.assertEqual(lines[-1], "LEAN")
        with open(os.path.join(self.root, "state", "sessions", "claude-code__s-1.json"), encoding="utf-8") as f:
            rec = json.load(f)
        self.assertEqual((rec["cwd"], rec["last_event"], rec["state"]), (cwd, "PostToolUse", "working"))

    def test_bad_input_is_an_empty_answer(self):
        r = subprocess.run([sys.executable, os.path.join(HERE, "hook.py"), "claude-code"], input=b"not json", capture_output=True, timeout=60)
        self.assertEqual((r.returncode, r.stdout.decode().strip()), (0, "{}"))
        r = subprocess.run([sys.executable, os.path.join(HERE, "hook.py")], input=b"", capture_output=True, timeout=60)
        self.assertEqual(r.returncode, 0)


# ---------------------------------------------------------------- putting it in
CLAUDE = engines.get("claude-code")
CODEX = engines.get("codex")


class Install(Scratch):
    def write(self, name, doc):
        path = os.path.join(self.root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(doc, f)
        return path

    def read(self, path):
        with open(path) as f:
            return json.load(f)

    def test_kind_tells_the_entry_older_dispatch_hooks_and_everyone_else_apart(self):
        self.assertEqual(hooks_setup.kind(hooks_setup.command(CLAUDE)), "entry")
        self.assertEqual(hooks_setup.kind('python3 "$HOME/tasks/.dispatch/presence.py" claude-code Stop # dispatch-presence'), "presence")
        self.assertEqual(hooks_setup.kind("python3 /x/life_hook.py --agent codex # dispatch-life"), "life")
        self.assertEqual(hooks_setup.kind('"$HOME/.local/bin/dispatch" prime --hook-json'), "prime")
        for theirs in ("bd codex-hook Stop", "my-hook # dispatch-hooks-of-mine", "echo '# dispatch-plan-b'", None, 3):
            self.assertIsNone(hooks_setup.kind(theirs), theirs)

    def test_their_hooks_keep_their_place_and_ours_take_the_first_older_place(self):
        theirs_a = {"type": "command", "command": "orca-hook"}
        theirs_b = {"type": "command", "command": "beads prime"}
        path = self.write("c/settings.json", {"model": "opus", "hooks": {
            "Notification": [{"hooks": [{"type": "command", "command": "py presence.py claude-code Notification # dispatch-presence"}]}],
            "Stop": [{"hooks": [theirs_a]}, {"hooks": [{"type": "command", "command": "py p.py # dispatch-presence"}]},
                     {"hooks": [{"type": "command", "command": "py l.py # dispatch-life"}]}],
            "SessionStart": [{"matcher": "startup", "hooks": [theirs_b, {"type": "command", "command": "dispatch prime --hook-json # dispatch-prime"}]}],
            "TeammateIdle": [{"hooks": [theirs_a]}]}})
        res = hooks_setup.install(CLAUDE, path, trust=False)
        self.assertEqual(res["migrated"], ["life", "presence", "prime"])
        d = self.read(path)
        cmd = hooks_setup.command(CLAUDE)
        self.assertEqual(list(d["hooks"])[:4], ["Notification", "Stop", "SessionStart", "TeammateIdle"], "events keep their order")
        self.assertEqual(d["hooks"]["Stop"][0], {"hooks": [theirs_a]})
        self.assertEqual(d["hooks"]["Stop"][1]["hooks"][0]["command"], cmd)
        self.assertEqual(len(d["hooks"]["Stop"]), 2)
        self.assertEqual(d["hooks"]["SessionStart"][0], {"matcher": "startup", "hooks": [theirs_b]}, "their group keeps its place")
        self.assertEqual(d["hooks"]["SessionStart"][1]["hooks"][0]["command"], cmd)
        self.assertEqual(d["hooks"]["TeammateIdle"], [{"hooks": [theirs_a]}])
        self.assertEqual(d["model"], "opus")
        self.assertEqual(hooks_setup.state(CLAUDE, path)["current"], True)
        self.assertTrue(os.path.exists(path + ".dispatch-bak"))

    def test_uninstall_takes_out_only_what_dispatch_wrote(self):
        theirs = {"type": "command", "command": "orca-hook"}
        path = self.write("x/hooks.json", {"hooks": {"Stop": [{"hooks": [theirs]}], "Other": [{"hooks": [{"type": "command", "command": "a # dispatch-life"}]}]}})
        hooks_setup.install(CODEX, path, trust=False)
        self.assertTrue(hooks_setup.uninstall(CODEX, path))
        self.assertEqual(self.read(path), {"hooks": {"Stop": [{"hooks": [theirs]}]}})
        self.assertFalse(hooks_setup.uninstall(CODEX, path))

    def test_state_names_what_is_missing_old_or_stale(self):
        path = self.write("x/hooks.json", {})
        st = hooks_setup.state(CODEX, path)
        self.assertEqual((st["installed"], st["events"], st["old"]), (False, [], []))
        hooks_setup.install(CODEX, path, trust=False)
        d = self.read(path)
        d["hooks"]["Stop"][0]["hooks"][0]["command"] = d["hooks"]["Stop"][0]["hooks"][0]["command"].replace(hooks_setup.shim_path(), "/old/dispatch-hook")
        del d["hooks"]["UserPromptSubmit"]
        d["hooks"]["PostToolUse"].append({"hooks": [{"type": "command", "command": "x # dispatch-plan"}]})
        with open(path, "w") as f:
            json.dump(d, f)
        st = hooks_setup.state(CODEX, path)
        self.assertEqual((st["installed"], st["current"], st["missing"], st["old"]), (False, False, ["UserPromptSubmit"], ["plan"]))
        with mock.patch.object(CODEX, "hook_trusted", return_value=False) as asked:
            self.assertFalse(hooks_setup.state(CODEX, path, deep=True)["trusted"])
        asked.assert_called_once()

    def test_customizations_choices_from_before_become_switches(self):
        import customizations
        state = os.path.join(self.root, "dispatch-home", "state", "customizations.json")
        os.makedirs(os.path.dirname(state), exist_ok=True)
        with open(state, "w") as f:
            json.dump({"disabled_hooks": {"codex:plan": [{"event": "PostToolUse"}], "claude:prime": []}, "other": 1}, f)
        path = self.write("x/hooks.json", {})
        with mock.patch.object(customizations, "state_path", return_value=__import__("pathlib").Path(state)):
            hooks_setup.install(CODEX, path, trust=False)
        self.assertFalse(hook.switches("codex", self.config)["plan"])
        self.assertTrue(hook.switches("codex", self.config)["prime"])
        with open(state) as f:
            self.assertEqual(json.load(f), {"disabled_hooks": {"claude:prime": []}, "other": 1})

    def test_sync_brings_up_to_date_only_where_dispatch_hooks_are(self):
        home = os.path.join(self.root, "home")
        os.makedirs(os.path.join(home, ".claude"))
        os.makedirs(os.path.join(home, ".codex"))
        with open(os.path.join(home, ".codex", "hooks.json"), "w") as f:
            json.dump({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "py life_hook.py --agent codex # dispatch-life"}]}]}}, f)
        trusted = []
        with mock.patch.object(CX, "trust_hook", lambda path, command, before=None, env=None: trusted.append(path) or {"ok": True}), \
                mock.patch.object(CX, "hook_listing", return_value=[]):
            out = hooks_setup.sync(h=home)
        self.assertIn("skipped", out["claude-code"])
        self.assertFalse(os.path.exists(os.path.join(home, ".claude", "settings.json")))
        self.assertEqual(out["codex"]["migrated"], ["life"])
        self.assertEqual(trusted, [os.path.join(home, ".codex", "hooks.json")])
        self.assertTrue(hooks_setup.state(CODEX, os.path.join(home, ".codex", "hooks.json"))["current"])


# ---------------------------------------------------------------- the stable entry (task-hhvf3: the app replaced, every agent stuck)
class Shim(Scratch):
    """The agents' settings name ~/.dispatch/bin/dispatch-hook, not hook.py inside the app: `python3 <gone>/hook.py`
    exits 2, which Claude Code and Codex read as "block this tool call"."""

    PRE = {"hook_event_name": "PreToolUse", "session_id": "s-1", "tool_name": "Bash", "tool_input": {"command": "ls"}}

    def setUp(self):
        super().setUp()
        p = mock.patch.object(hooks_setup, "APP_HOOK", os.path.join(self.root, "Applications", "gone", "hook.py"))
        p.start()
        self.addCleanup(p.stop)

    def run_shim(self, *args, data=None):
        r = subprocess.run([hooks_setup.shim_path(), *args], input=json.dumps(data or self.PRE).encode("utf-8"),
                           capture_output=True, timeout=60, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        return r.returncode, r.stdout.decode("utf-8"), r.stderr.decode("utf-8")

    def log(self):
        try:
            with open(os.path.join(os.environ["DISPATCH_HOME"], "state", "hook-errors.log"), encoding="utf-8") as f:
                return f.read()
        except FileNotFoundError:
            return ""

    def test_the_entry_is_the_shim_outside_the_app_and_it_runs_hook_py(self):
        cmd = hooks_setup.command(CLAUDE)
        self.assertEqual(cmd, f"{hooks_setup.shim_path()} claude-code # dispatch-hook")
        self.assertEqual(hooks_setup.shim_path(), os.path.join(os.environ["DISPATCH_HOME"], "bin", "dispatch-hook"))
        path = os.path.join(self.root, "c", "settings.json")
        os.makedirs(os.path.dirname(path))
        res = hooks_setup.install(CLAUDE, path, trust=False)
        self.assertEqual(res["shim"], hooks_setup.shim_path())
        self.assertTrue(hooks_setup.state(CLAUDE, path)["current"])
        code, out, _err = self.run_shim("claude-code", data={"hook_event_name": "NoSuchEvent"})
        self.assertEqual((code, json.loads(out)), (0, {}))
        # a shim that is gone or stale makes the entry out of date, and sync writes it again
        os.unlink(hooks_setup.shim_path())
        self.assertFalse(hooks_setup.state(CLAUDE, path)["current"])
        hooks_setup.install(CLAUDE, path, trust=False)
        self.assertTrue(os.access(hooks_setup.shim_path(), os.X_OK))

    def test_with_the_app_gone_the_hook_exits_0_and_says_nothing(self):
        gone = os.path.join(self.root, "Applications", "Dispatch IDE.app", "cli", "hook.py")
        hooks_setup.write_shim(script=gone)
        # what the agents ran before: Python exits 2 on a missing script, which blocks the tool call
        r = subprocess.run([sys.executable, gone, "claude-code"], input=b"{}", capture_output=True, timeout=60)
        self.assertEqual(r.returncode, 2)
        code, out, err = self.run_shim("claude-code")
        self.assertEqual((code, out, err), (0, "", ""))
        code, out, _err = self.run_shim("claude-code", "--terminal")
        self.assertEqual((code, out), (0, ""))

    def test_a_failing_hook_py_lets_the_tool_through_and_is_logged(self):
        broken = os.path.join(self.root, "half-copied", "hook.py")
        os.makedirs(os.path.dirname(broken))
        for body in ("import sys\nsys.stderr.write('boom\\n')\nsys.exit(2)\n", "def half(:\n", "raise SystemExit(1)\n"):
            with open(broken, "w") as f:
                f.write(body)
            hooks_setup.write_shim(script=broken)
            code, out, err = self.run_shim("claude-code")
            self.assertEqual((code, out, err), (0, "", ""), body)
        log = self.log()
        self.assertIn("boom", log)
        self.assertIn("SyntaxError", log)
        self.assertEqual(log.count("dispatch-hook claude-code: exit"), 3, log)

    def test_a_python_that_is_gone_falls_back_to_python3(self):
        hooks_setup.write_shim(python=os.path.join(self.root, "gone", "python3"))
        code, out, _err = self.run_shim("codex", data={"hook_event_name": "NoSuchEvent"})
        self.assertEqual((code, json.loads(out)), (0, {}))

    def test_sync_moves_an_entry_that_points_into_the_app_to_the_shim(self):
        home = os.path.join(self.root, "home")
        os.makedirs(os.path.join(home, ".claude"))
        old = "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3 '/Applications/Dispatch IDE.app/Contents/Resources/app/dispatch-cli/dispatch/cli/hook.py' claude-code # dispatch-hook"
        theirs = {"type": "command", "command": "orca-hook"}
        settings = os.path.join(home, ".claude", "settings.json")
        with open(settings, "w") as f:
            json.dump({"hooks": {e: [{"hooks": [theirs]}, {"hooks": [{"type": "command", "command": old}]}] for e in CLAUDE.hook_routes}}, f)
        out = hooks_setup.sync(agents=["claude-code"], h=home)
        self.assertTrue(out["claude-code"]["changed"], out)
        with open(settings) as f:
            d = json.load(f)
        cmds = {h["command"] for gs in d["hooks"].values() for g in gs for h in g["hooks"]}
        self.assertEqual(cmds, {"orca-hook", hooks_setup.command(CLAUDE)})
        self.assertTrue(os.access(hooks_setup.shim_path(), os.X_OK))
        self.assertFalse(hooks_setup.sync(agents=["claude-code"], h=home)["claude-code"]["changed"])


class CodexTrust(unittest.TestCase):
    CMD = "/py /cli/hook.py codex # dispatch-hook"

    def row(self, key, event, command, h, trust="untrusted", enabled=True):
        return {"key": key, "event": event, "command": command, "hash": h, "trust": trust, "enabled": enabled}

    def test_only_dispatch_s_entry_is_trusted_and_their_trust_follows_their_hook(self):
        before = [self.row("f:stop:0:0", "stop", "py old.py # dispatch-life", "h-old", "modified"),
                  self.row("f:stop:1:0", "stop", "orca", "h-orca", "trusted"),
                  self.row("f:stop:2:0", "stop", "beads", "h-beads", "trusted", enabled=False),
                  self.row("f:pre:0:0", "pre", "never-trusted", "h-x")]
        after = [self.row("f:stop:0:0", "stop", self.CMD, "h-ours"),
                 self.row("f:stop:1:0", "stop", "orca", "h-orca", "trusted"),  # same place: nothing to do
                 self.row("f:stop:2:0", "stop", "beads", "h-beads", "modified"),
                 self.row("f:pre:0:0", "pre", "never-trusted", "h-x"),
                 self.row("f:start:0:0", "start", self.CMD, "h-ours2", "trusted")]
        # beads moved into a key whose old trust was for another hook; it was turned off and stays off
        self.assertEqual(CX.trust_updates(after, self.CMD, before), {
            "f:stop:0:0": {"trusted_hash": "h-ours"},
            "f:stop:2:0": {"trusted_hash": "h-beads", "enabled": False}})
        self.assertEqual(CX.trust_updates(after, self.CMD), {"f:stop:0:0": {"trusted_hash": "h-ours"}})

    def test_trust_hook_asks_codex_and_reports(self):
        rows = [self.row("k1", "stop", self.CMD, "h1")]
        calls = []

        def app_server(c, env=None, codex_home="", timeout=0):
            calls.append((c, codex_home))
            if c[0][0] == "hooks/list":
                hooks = [{"key": r["key"], "eventName": r["event"], "command": r["command"], "currentHash": r["hash"],
                          "trustStatus": r["trust"], "enabled": True, "sourcePath": "/h/.codex/hooks.json", "handlerType": "command"}
                         for r in rows]
                hooks.append({"key": "other", "eventName": "stop", "command": self.CMD, "currentHash": "x", "trustStatus": "untrusted",
                              "sourcePath": "/project/.codex/hooks.json"})
                return [{"data": [{"cwd": "/h", "hooks": hooks}]}]
            rows[0]["trust"] = "trusted"
            return [{"status": "ok"}]
        with mock.patch.object(CX, "app_server", app_server), mock.patch.object(CX.os.path, "realpath", lambda p: p):
            res = CX.trust_hook("/h/.codex/hooks.json", self.CMD)
        self.assertEqual(res, {"ok": True, "trusted": 1, "kept": 0})
        write = [c for c, _ in calls if c[0][0] == "config/batchWrite"][0][0][1]
        self.assertEqual(write["edits"], [{"keyPath": "hooks.state", "value": {"k1": {"trusted_hash": "h1"}}, "mergeStrategy": "upsert"}])
        self.assertEqual({home for _, home in calls}, {"/h/.codex"})
        with mock.patch.object(CX, "app_server", return_value=None):
            self.assertFalse(CX.trust_hook("/h/.codex/hooks.json", self.CMD)["ok"])

    def test_codex_is_asked_in_its_own_spelling_of_its_folder(self):
        seen = []

        class Popen:
            def __init__(self, argv, env=None, **kw):
                seen.append(env.get("CODEX_HOME"))
                raise OSError("not started in a test")
        with tempfile.TemporaryDirectory() as home, mock.patch("engines.which", return_value="/x/codex"), \
                mock.patch("subprocess.Popen", Popen):
            os.makedirs(os.path.join(home, ".codex"))
            CX.app_server([("hooks/list", {})], {"HOME": home}, codex_home=os.path.realpath(os.path.join(home, ".codex")))
            CX.app_server([("hooks/list", {})], {"HOME": home}, codex_home=os.path.join(home, "elsewhere"))
            CX.app_server([("hooks/list", {})], {"HOME": home, "CODEX_HOME": "/instance/codex"}, codex_home="/instance/codex")
        # the default folder: Codex finds it itself, as it will when it runs the hook; another one: named
        self.assertEqual(seen, [None, os.path.join(home, "elsewhere"), "/instance/codex"])

    def test_without_codex_there_is_nothing_to_ask(self):
        with mock.patch("engines.which", return_value=None):
            self.assertIsNone(CX.app_server([("hooks/list", {})]))


if __name__ == "__main__":
    unittest.main()
