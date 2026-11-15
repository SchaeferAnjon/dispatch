# -*- coding: utf-8 -*-
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

WINDOWS_READY = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ide  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ide-test-")
        self.env = mock.patch.dict(os.environ, {"DISPATCH_DIR": os.path.join(self.tmp, "dispatch")})
        self.env.start()
        self.settings = {"ide_tab_daily_cap_usd": 0.5, "ide_tab_completion": 0}
        self.patch = mock.patch.object(ide, "settings", lambda: self.settings)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)


class Settings(unittest.TestCase):
    def test_ide_settings_have_defaults_and_parse(self):
        import dispatch
        d = dispatch.SETTING_DEFAULTS
        self.assertEqual((d["ide_tab_completion"], d["ide_tab_daily_cap_usd"], d["ide_tab_model"], d["ide_edit_model"]),
                         (1, 0.5, "deepseek-flash", "claude:sonnet"))
        self.assertNotIn("ide_default", d)
        got = dispatch.settings_parse(json.dumps({"ide_tab_daily_cap_usd": 1.25, "ide_tab_completion": 1, "ide_edit_model": "codex:default"}))
        self.assertEqual(got["ide_tab_daily_cap_usd"], 1.25)
        self.assertEqual(got["ide_edit_model"], "codex:default")


class Delegation(unittest.TestCase):
    def run_cli(self, *args):
        with tempfile.TemporaryDirectory() as d:
            env = dict(os.environ, DISPATCH_DIR=os.path.join(d, "dispatch"), BEADS_DIR=os.path.join(d, ".beads"))
            r = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py")] + list(args), capture_output=True, text=True, env=env, timeout=60)
        return r

    def test_checkpoint_reaches_its_module(self):
        # real since P4: a folder without snapshots lists no turns
        with tempfile.TemporaryDirectory() as root:
            r = self.run_cli("checkpoint", "list", "--root", root, "--json")
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual((out["ok"], out["turns"]), (True, []))

    def test_agent_tools_reach_their_modules(self):
        # code-search and browser are real now (P5); status calls touch no network and no venv
        with tempfile.TemporaryDirectory() as root:
            r = self.run_cli("code-search", "status", "--root", root, "--json")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertFalse(json.loads(r.stdout)["exists"])
        r = self.run_cli("browser", "status", "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout), {"ok": True, "running": False})

    def test_ide_status_through_dispatch(self):
        r = self.run_cli("ide", "status", "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(set(json.loads(r.stdout)), {"supported", "native"})

    def test_help_lists_the_new_commands(self):
        r = self.run_cli("--help")
        for name in ("ide", "checkpoint", "code-search", "browser"):
            self.assertIn(name, r.stdout)



class Recommend(unittest.TestCase):
    def test_counts_languages_and_skips_dependency_folders(self):
        with tempfile.TemporaryDirectory() as d:
            for f in ("a.py", "b.py", "src/main.rs", "run.sh", "node_modules/x/y.swift", "README.md"):
                os.makedirs(os.path.dirname(os.path.join(d, f)) or d, exist_ok=True)
                open(os.path.join(d, f), "w").close()
            with mock.patch.dict(os.environ, {"DISPATCH_IDE_EXTENSIONS": os.path.join(d, "none")}):
                r = ide.recommend(d)
        langs = [l["lang"] for l in r["languages"]]
        self.assertEqual(langs, ["python", "rust", "bash"])
        self.assertIn("detachhead.basedpyright", r["missing"])
        self.assertIn("rust-lang.rust-analyzer", r["missing"])
        self.assertNotIn("swiftlang.swift-vscode", r["missing"])

    def test_this_repo_app_folder(self):
        r = ide.recommend(os.path.join(HERE, ".."))
        self.assertTrue({"python", "bash"} <= {l["lang"] for l in r["languages"]})

    def test_installed_extension_folders_are_read(self):
        with tempfile.TemporaryDirectory() as d:
            for n in ("rust-lang.rust-analyzer-0.4.3061-darwin-arm64", "ms-python.python-2026.4.0", "ms-python.python-2025.1.0", "extensions.json"):
                os.makedirs(os.path.join(d, n))
            with mock.patch.dict(os.environ, {"DISPATCH_IDE_EXTENSIONS": d}):
                self.assertEqual(ide.installed_extensions(), {"rust-lang.rust-analyzer": "0.4.3061", "ms-python.python": "2026.4.0"})
                # VS Code's registry wins: an uninstalled folder not yet removed, and an entry without a folder, do not count
                json.dump([{"identifier": {"id": "ms-python.python"}, "version": "2026.4.0", "relativeLocation": "ms-python.python-2026.4.0"},
                           {"identifier": {"id": "vadimcn.vscode-lldb"}, "version": "1.12.3", "relativeLocation": "vadimcn.vscode-lldb-1.12.3-universal"}],
                          open(os.path.join(d, "extensions.json.tmp"), "w"))
                os.rmdir(os.path.join(d, "extensions.json"))
                os.replace(os.path.join(d, "extensions.json.tmp"), os.path.join(d, "extensions.json"))
                self.assertEqual(ide.installed_extensions(), {"ms-python.python": "2026.4.0"})



class Edit(unittest.TestCase):
    def test_fences_and_indentation(self):
        sel = "    x = 1\n    y = 2\n"
        self.assertEqual(ide.clean_edit("```python\nx = 10\ny = 20\n```", sel), "    x = 10\n    y = 20\n")
        self.assertEqual(ide.clean_edit("    a()", "    b()"), "    a()")
        self.assertEqual(ide.clean_edit("a()\n\n", "b()"), "a()")
        self.assertEqual(ide.clean_edit("if x:\n    y()", "\tif z:\n\t    w()"), "\tif x:\n\t    y()")

    def test_edit_reads_the_selection_from_the_file_and_calls_the_model(self):
        import summarize as S
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "m.py")
            open(f, "w").write("def f():\n    return 1\n\nprint(f())\n")
            seen = {}

            def chat(p, system, user, **kw):
                seen.update(system=system, user=user, kw=kw)
                return "```\nreturn 2\n```"
            with mock.patch.object(S, "provider", return_value={"id": "claude", "model": "sonnet", "base": "", "key": ""}) as prov, \
                    mock.patch.object(S, "chat", side_effect=chat), mock.patch.object(S, "usage_load", return_value={"ide_edit": {"tokens": 0}}), \
                    mock.patch.object(ide, "settings", return_value={"ide_edit_model": "claude:sonnet"}):
                r = ide.edit(d, "m.py", 2, 2, {"instruction": "return 2 instead"})
        prov.assert_called_with("claude:sonnet")
        self.assertEqual(r["text"], "    return 2")
        self.assertEqual(r["model"], "claude:sonnet")
        self.assertIn("<selection>\n    return 1\n</selection>", seen["user"])
        self.assertIn("<before>\ndef f():\n</before>", seen["user"])
        self.assertIn("File: m.py", seen["user"])
        self.assertEqual(seen["kw"]["use"], "ide_edit")
        self.assertIn("no markdown fences", seen["system"])

    def test_a_cut_off_answer_or_a_huge_selection_changes_nothing(self):
        import summarize as S
        p = {"id": "deepseek", "model": "deepseek-chat", "base": "https://api.deepseek.com", "key": "k"}

        class Reply:
            def __init__(self, body): self.body = body
            def read(self): return json.dumps(self.body).encode()
            def __enter__(self): return self
            def __exit__(self, *a): return False
        sent = {}

        def urlopen(req, timeout=0):
            sent.update(json.loads(req.data))
            return Reply({"choices": [{"message": {"content": "def a():\n    pass\ndef b("}, "finish_reason": "length"}], "usage": {"total_tokens": 9}})
        sel = "\n".join("def f%d(): return %d" % (i, i) for i in range(300))
        with mock.patch.object(S, "provider", return_value=p), mock.patch.object(S.urllib.request, "urlopen", urlopen), \
                mock.patch.object(S, "record_use", lambda *a, **k: None), mock.patch.object(ide, "settings", return_value={}):
            with self.assertRaises(ide.IdeError) as cm:
                ide.edit(".", "", 1, 300, {"instruction": "add type hints", "selection": sel})
            self.assertEqual(cm.exception.code, "truncated")
            self.assertGreater(sent["max_tokens"], 4000)   # room for the whole selection
            self.assertLessEqual(sent["max_tokens"], ide.EDIT_MAX_TOKENS)
            with self.assertRaises(ide.IdeError) as cm:
                ide.edit(".", "", 1, 900, {"instruction": "x", "selection": "a = 1\n" * 900})
            self.assertEqual(cm.exception.code, "too_large")
        # a finished answer is still fine; other callers (summaries) keep a cut-off answer as before
        with mock.patch.object(S.urllib.request, "urlopen", lambda req, timeout=0: Reply({"choices": [{"message": {"content": "short"}, "finish_reason": "length"}]})), \
                mock.patch.object(S, "record_use", lambda *a, **k: None):
            self.assertEqual(S.chat(dict(p), "s", "u"), "short")

    def test_the_extension_checks_the_same_selection_limits(self):
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ide-ext", "src", "core", "proposal.ts"), encoding="utf-8").read()
        import re
        self.assertEqual(int(re.search(r"EDIT_MAX_LINES = (\d+)", src).group(1)), ide.EDIT_MAX_LINES)
        self.assertEqual(int(re.search(r"EDIT_MAX_CHARS = (\d+)", src).group(1)), ide.EDIT_MAX_CHARS)

    def test_no_instruction_is_an_error(self):
        with self.assertRaises(ide.IdeError):
            ide.edit(".", "", 0, 0, {"selection": "x"})


class Usage(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.env = mock.patch.dict(os.environ, {"DISPATCH_DIR": self.d})
        self.env.start()
        self.s = mock.patch.object(ide, "settings", return_value={"ide_tab_daily_cap_usd": 0.001, "ide_tab_completion": 1, "ide_tab_model": "deepseek-flash"})
        self.s.start()

    def tearDown(self):
        self.s.stop()
        self.env.stop()
        shutil.rmtree(self.d, ignore_errors=True)

    def test_price_estimate(self):
        # 1500 input (500 of it cached) + 50 output at peak prices
        self.assertAlmostEqual(ide.tab_usd(1500, 500, 50), (1000 * 0.30 + 500 * 0.006 + 50 * 1.20) / 1e6)

    def test_jsonl_is_folded_into_the_day_and_counted_before_that(self):
        os.makedirs(os.path.join(self.d, "ide"))
        now = time.time()
        with open(os.path.join(self.d, "ide", "tab-usage.jsonl"), "w") as f:
            f.write(json.dumps({"ts": now * 1000, "prompt_tokens": 1500, "cached_tokens": 0, "completion_tokens": 50, "usd": 0.0004}) + "\n")
            f.write("not json\n")
            f.write(json.dumps({"ts": now, "prompt_tokens": 1000, "cached_tokens": 1000, "completion_tokens": 10}) + "\n")
            f.write(json.dumps({"ts": now - 40 * 86400, "prompt_tokens": 10, "completion_tokens": 1, "usd": 5}) + "\n")
        t = ide.usage_today()
        self.assertEqual(t["count"], 2)
        want = 0.0004 + ide.tab_usd(1000, 1000, 10)
        self.assertAlmostEqual(t["usd"], want, places=6)
        import summarize as S
        with mock.patch.object(S, "record_use") as rec:
            a = ide.usage_add([{"prompt_tokens": 100, "completion_tokens": 5, "usd": 0.001}])
        rec.assert_called_once()
        self.assertEqual(rec.call_args[0][0], "ide_tab")
        self.assertEqual(a["added"], 4)
        self.assertEqual(a["count"], 3)
        self.assertAlmostEqual(a["usd"], want + 0.001, places=6)
        self.assertTrue(a["over_cap"])
        self.assertFalse(os.path.exists(os.path.join(self.d, "ide", "tab-usage.jsonl")))
        again = ide.usage_add()
        self.assertEqual((again["added"], again["count"]), (0, 3))
        self.assertEqual(again["prices_as_of"], "2026-09")



class TabKey(unittest.TestCase):
    """task-iyt73: Tab completion takes the DeepSeek key OpenCode already has, as Settings › Network does."""

    def setUp(self):
        self.d = tempfile.mkdtemp()
        data = os.path.join(self.d, "data")
        os.makedirs(os.path.join(data, "opencode"))
        self.auth = os.path.join(data, "opencode", "auth.json")
        self.env = mock.patch.dict(os.environ, {"DISPATCH_DIR": os.path.join(self.d, "dispatch"), "XDG_DATA_HOME": data,
                                                "XDG_CACHE_HOME": os.path.join(self.d, "cache"), "XDG_CONFIG_HOME": os.path.join(self.d, "config"),
                                                "DEEPSEEK_API_KEY": ""})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(shutil.rmtree, self.d, True)

    def test_dispatch_env_first_then_opencode(self):
        self.assertEqual(ide.tab_key({}), "")
        with open(self.auth, "w") as f:
            json.dump({"deepseek": {"type": "api", "key": "sk-from-opencode"}}, f)
        self.assertEqual(ide.tab_key({}), "sk-from-opencode")
        self.assertEqual(ide.tab_key({"DEEPSEEK_API_KEY": "sk-dispatch"}), "sk-dispatch")

    def test_editor_settings_says_there_is_a_key(self):
        import dispatch
        with open(self.auth, "w") as f:
            json.dump({"deepseek": {"type": "api", "key": "sk-from-opencode"}}, f)
        with mock.patch.object(dispatch, "env_read", return_value=[]), mock.patch.object(ide, "settings", return_value={}), \
                mock.patch.object(ide, "subscription_models", return_value=[]):
            self.assertTrue(ide.editor_settings()["tab"]["has_key"])
            os.remove(self.auth)
            self.assertFalse(ide.editor_settings()["tab"]["has_key"])


class SignalAndOpenRequest(unittest.TestCase):
    def test_signal_file(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"DISPATCH_DIR": d}):
            a = ide.signal("focus-chat")
            b = ide.signal("add-to-chat", {"path": "a.py", "line": 3})
            self.assertEqual(b["seq"], a["seq"] + 1)
            self.assertEqual(json.load(open(os.path.join(d, "ide", "signal")))["data"], {"path": "a.py", "line": 3})
            with self.assertRaises(ide.IdeError):
                ide.signal("Bad Name")

    def test_open_request_is_absolute_and_counts_up(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"DISPATCH_DIR": d}):
            a = ide.open_request(os.path.join(d, "x.py"), 7)
            b = ide.open_request(os.path.join(d, "y.py"))
            self.assertEqual(b["seq"], a["seq"] + 1)
            rec = json.load(open(os.path.join(d, "ide", "open-request")))
            self.assertEqual((rec["path"], rec["line"]), (os.path.join(d, "y.py"), 0))
            with self.assertRaises(ide.IdeError):
                ide.open_request("")


class NativeIde(Base):
    """Dispatch IDE (the Code - OSS desktop build): open a folder in it, come back to Agent mode."""
    def app(self):
        app = os.path.join(self.tmp, "Dispatch IDE.app")
        os.makedirs(os.path.join(app, "Contents", "MacOS"))
        return app

    def test_open_notes_the_conversation_and_opens_the_folder(self):
        app = self.app(); root = os.path.join(self.tmp, "proj"); os.makedirs(root)
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_APP": app}), mock.patch.object(ide.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="", stderr="")) as run:
            r = ide.native_open(root, "claude-code:s1")
        self.assertEqual(run.call_args[0][0], ["open", "-a", app, root])
        self.assertEqual(r["app"], app)
        self.assertEqual(ide.read_json(ide.state_path("sessions.json"), {})[root]["sid"], "claude-code:s1")
        # the editor window on that folder focuses its chat on the folder's session (the bridge watches chat-request)
        rec = ide.read_json(ide.state_path("chat-request"), {})
        self.assertEqual((rec["root"], rec["seq"]), (root, 1))
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_APP": app}), mock.patch.object(ide.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="", stderr="")):
            ide.native_open(root)
        self.assertEqual(ide.read_json(ide.state_path("chat-request"), {})["seq"], 2)

    def test_open_with_a_file_opens_it_and_asks_for_the_line(self):
        app = self.app(); root = os.path.join(self.tmp, "proj"); os.makedirs(root)
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_APP": app}), mock.patch.object(ide.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="", stderr="")) as run:
            ide.native_open(root, "", "src/a.py", 12)
        full = os.path.join(root, "src", "a.py")
        self.assertEqual(run.call_args[0][0], ["open", "-a", app, root, full])
        rec = ide.read_json(ide.state_path("open-request"), {})
        self.assertEqual((rec["path"], rec["line"]), (full, 12))

    def test_open_without_the_app_says_not_installed(self):
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_APP": ""}), mock.patch.object(ide, "NATIVE_APPS", ()):
            with self.assertRaises(ide.IdeError) as e:
                ide.native_open(self.tmp)
        self.assertEqual(e.exception.code, "not_installed")

    def test_back_selects_the_folders_conversation_else_the_folder(self):
        app = self.app(); root = os.path.join(self.tmp, "proj"); os.makedirs(root)
        ide.note_session(root, "claude-code:s1")
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_APP": app}), mock.patch.object(ide.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="", stderr="")) as run:
            r = ide.back(root)
            self.assertEqual(run.call_args[0][0], [ide.ide_cli(app), "--open-url", "--", "dispatch-ide://agents/agent-host-session/claude/s1"])
            self.assertEqual(r["target"], "claude-code:s1")
            other = os.path.join(self.tmp, "other"); os.makedirs(other)
            r = ide.back(other)
            self.assertEqual(run.call_args[0][0], [ide.ide_cli(app), "--agents"])
            self.assertEqual(ide.read_json(ide.state_path("agents-request"))["root"], other)
            # a conversation the Agents window cannot show (a terminal) falls back to the folder
            ide.note_session(other, "gemini:g1")
            self.assertEqual(ide.back(other)["url"], "")


class Agents(Base):
    """`dispatch ide agents`: Dispatch Agent is Dispatch IDE's Agents window (copilot-app §8.5 B)."""
    def app(self, protocol=None):
        app = os.path.join(self.tmp, "Dispatch IDE.app")
        os.makedirs(os.path.join(app, "Contents", "MacOS"), exist_ok=True)
        if protocol:
            ide.write_json(os.path.join(app, "Contents", "Resources", "app", "product.json"), {"urlProtocol": protocol})
        return app

    def run_ok(self):
        return mock.patch.object(ide.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="", stderr=""))

    def test_session_link_has_the_shape_the_app_parses(self):
        # parseExternalOpenSessionLinkUri: <protocol>://agents/agent-host-session/<provider>/<raw id>
        self.assertEqual(ide.session_link("claude-code:0f3a-11"), "dispatch-ide://agents/agent-host-session/claude/0f3a-11")
        self.assertEqual(ide.session_link("codex:019a-thread", "x-ide"), "x-ide://agents/agent-host-session/codex/019a-thread")
        self.assertEqual(ide.session_link("claude:/abc"), "dispatch-ide://agents/agent-host-session/claude/abc")
        self.assertEqual(ide.session_link("codex:a/b c"), "dispatch-ide://agents/agent-host-session/codex/a%2Fb%20c")
        for bad in ("", "claude-code:", "gemini:x", "s1"):
            with self.assertRaises(ide.IdeError, msg=bad):
                ide.session_link(bad)

    def test_plain_opens_the_agents_window_through_the_apps_launcher(self):
        app = self.app()
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_APP": app, "VSCODE_PID": "1", "ELECTRON_RUN_AS_NODE": "1"}), self.run_ok() as run:
            r = ide.agents()
        self.assertEqual(run.call_args[0][0], [os.path.join(app, "Contents", "Resources", "app", "bin", "code"), "--agents"])
        env = run.call_args[1]["env"]
        self.assertNotIn("VSCODE_PID", env)
        self.assertNotIn("ELECTRON_RUN_AS_NODE", env)
        self.assertEqual((r["root"], r["session"], r["url"]), ("", "", ""))
        self.assertIsNone(ide.read_json(ide.state_path("agents-request")))

    def test_session_uses_the_products_protocol(self):
        app = self.app("dispatch-ide")
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_APP": app}), self.run_ok() as run:
            r = ide.agents(session="codex:t1")
        self.assertEqual(run.call_args[0][0][1:], ["--open-url", "--", "dispatch-ide://agents/agent-host-session/codex/t1"])
        self.assertEqual(r["url"], "dispatch-ide://agents/agent-host-session/codex/t1")

    def test_root_leaves_a_request_for_the_window(self):
        app = self.app(); root = os.path.join(self.tmp, "proj"); os.makedirs(root)
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_APP": app}), self.run_ok():
            ide.agents(root)
        rec = ide.read_json(ide.state_path("agents-request"))
        self.assertEqual(rec["root"], root)
        self.assertLess(time.time() - rec["at"], 5)
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_APP": app}), self.run_ok(), self.assertRaises(ide.IdeError) as e:
            ide.agents(os.path.join(self.tmp, "missing"))
        self.assertEqual(e.exception.code, "no_root")

    def test_a_scratch_profile_is_passed_on(self):
        app = self.app()
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_APP": app, "DISPATCH_IDE_USER_DATA_DIR": "/u", "DISPATCH_IDE_EXTENSIONS": "/e"}), self.run_ok() as run:
            ide.agents()
        self.assertEqual(run.call_args[0][0][1:], ["--user-data-dir", "/u", "--extensions-dir", "/e", "--agents"])

    def test_failures(self):
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_APP": ""}), mock.patch.object(ide, "NATIVE_APPS", ()), self.assertRaises(ide.IdeError) as e:
            ide.agents()
        self.assertEqual(e.exception.code, "not_installed")
        app = self.app()
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_APP": app}), \
                mock.patch.object(ide.subprocess, "run", return_value=mock.Mock(returncode=1, stdout="", stderr="boom")), self.assertRaises(ide.IdeError) as e:
            ide.agents()
        self.assertEqual((e.exception.code, str(e.exception)), ("open_failed", "boom"))

    def test_command_line(self):
        p = ide.parser()
        a = p.parse_args(["agents", "--root", "/p", "--session", "codex:t", "--json"])
        self.assertEqual((a.root, a.session, a.json), ("/p", "codex:t", True))
        self.assertEqual(p.parse_args(["back", "--root", "/p", "--frame"]).root, "/p")  # older bridges pass --frame
        app = self.app()
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_APP": app}), self.run_ok(), mock.patch("sys.stdout", out):
            self.assertEqual(ide.main(["agents", "--session", "claude-code:s9", "--json"]), 0)
        self.assertEqual(json.loads(out.getvalue())["url"], "dispatch-ide://agents/agent-host-session/claude/s9")


class Frame(Base):
    """5A.3: Dispatch and Dispatch IDE swap in the same place at the same size."""
    def app(self):
        app = os.path.join(self.tmp, "Dispatch IDE.app")
        os.makedirs(os.path.join(app, "Contents", "MacOS"))
        return app

    def test_parse_frame(self):
        self.assertEqual(ide.parse_frame("66,39,1380,880"), [66, 39, 1380, 880])
        self.assertEqual(ide.parse_frame(" -1512.4, 25 ,1380.6,880 "), [-1512, 25, 1381, 880])
        for bad in ("", "1,2,3", "a,b,c,d", "0,0,100,880", "0,0,1380,880,1"):
            with self.assertRaises(ide.IdeError, msg=bad) as e:
                ide.parse_frame(bad)
            self.assertEqual(e.exception.code, "usage")

    def test_command_line_frames(self):
        p = ide.parser()
        self.assertEqual(p.parse_args(["native-open", "--root", "/p", "--frame", "1,2,800,600"]).frame, "1,2,800,600")
        self.assertEqual(p.parse_args(["native-open", "--root", "/p"]).frame, "")
        with mock.patch("sys.stdout"):
            self.assertEqual(ide.main(["native-open", "--root", self.tmp, "--frame", "1,2", "--json"]), 1)

    def test_open_with_a_frame_places_the_folders_window(self):
        app = self.app(); root = os.path.join(self.tmp, "proj"); os.makedirs(root)
        with mock.patch.dict(os.environ, {"DISPATCH_IDE_APP": app}), mock.patch.object(ide.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="", stderr="")), \
                mock.patch.object(ide, "place_window") as place:
            r = ide.native_open(root, "", frame=[66, 39, 1380, 880])
        place.assert_called_once_with("Dispatch IDE", [66, 39, 1380, 880], "proj")
        self.assertEqual(r["frame"], [66, 39, 1380, 880])

    def test_place_window_runs_system_events_in_the_background(self):
        with mock.patch.object(ide.sys, "platform", "darwin"), mock.patch.object(ide.subprocess, "Popen") as po:
            ide.place_window("Dispatch IDE", [1, 2, 800, 600], "proj")
        args = po.call_args[0][0]
        self.assertEqual((args[0], args[1]), ("osascript", "-e"))
        self.assertIn("System Events", args[2])
        self.assertEqual(args[3:], ["Dispatch IDE", "proj", "1", "2", "800", "600"])


if __name__ == "__main__":
    unittest.main()
