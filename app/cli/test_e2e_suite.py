# -*- coding: utf-8 -*-
"""e2e_suite.py: what a scenario declares (needs, its instance, its variables), the verdict of one run, and the
suite running every scenario in its own instance."""
import sys

sys.dont_write_bytecode = True

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import e2e_suite as S  # noqa: E402


class Needs(unittest.TestCase):
    def test_unknown_need_is_unmet_not_ignored(self):
        got = S.unmet(["opencode-typo"])
        self.assertEqual(got[0][0], "opencode-typo")
        self.assertIn("unknown need", got[0][1])

    def test_nothing_needed_nothing_missing(self):
        self.assertEqual(S.unmet(None), [])
        self.assertEqual(S.unmet([]), [])

    def test_claude_is_spent_only_when_asked(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(S.CLAUDE_OK, None)
            why = S._need_claude()
        self.assertIn(S.CLAUDE_OK, why)
        self.assertIn("dispatcher", why)
        with patch.dict(os.environ, {S.CLAUDE_OK: "1"}), patch.object(S, "_which", lambda n: "/x/claude"), patch.object(S, "_ok", lambda *a, **k: True):
            self.assertEqual(S._need_claude(), "")

    def test_codex_says_how_to_sign_in(self):
        with patch.object(S, "_which", lambda n: "/x/codex"), patch.object(S, "_ok", lambda *a, **k: False):
            self.assertIn("codex login", S._need_codex())
        with patch.object(S, "_which", lambda n: None):
            self.assertIn("not installed", S._need_codex())

    def test_other_mac_needs_an_address(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(S.OTHER_MAC, None)
            self.assertIn(S.OTHER_MAC, S._need_other_mac())

    def test_an_env_need_says_how_to_set_it_up(self):
        with patch.dict(os.environ, {"E2E_DEMO_A": "x"}, clear=False):
            os.environ.pop("E2E_DEMO_B", None)
            self.assertEqual(S.unmet(["env:E2E_DEMO_A"]), [])
            got = S.unmet(["env:E2E_DEMO_B"], "run machines-remote.py first")
        self.assertEqual(got, [("env:E2E_DEMO_B", "E2E_DEMO_B is not set: run machines-remote.py first")])

    def test_each_missing_need_is_listed(self):
        fake = {"a": lambda: "", "b": lambda: "no b", "c": lambda: "no c"}
        with patch.dict(S.NEEDS, fake, clear=True):
            self.assertEqual(S.unmet(["a", "b", "c"]), [("b", "no b"), ("c", "no c")])

    def test_run_on_needs_the_packaged_app_with_its_server(self):
        with tempfile.TemporaryDirectory() as d:
            dev = os.path.join(d, "vscode")
            os.makedirs(os.path.join(dev, ".build"))
            self.assertIn("development build", S.unmet(["app-bundle"], app=dev)[0][1])
            app = os.path.join(d, "Dispatch IDE.app")
            server = os.path.join(app, "Contents", "Resources", "app", "server")
            os.makedirs(server)
            self.assertEqual(len(S.unmet(["app-bundle"], app=app)), 1)
            open(os.path.join(server, "dispatch-ide-server-darwin-arm64.tar.gz"), "w").close()
            self.assertEqual(S.unmet(["app-bundle"], app=app), [])

    def test_host_path_adds_the_agent_folders_once(self):
        p = S.host_path("/usr/bin:/opt/homebrew/bin")
        self.assertEqual(p.split(":").count("/opt/homebrew/bin"), 1)
        self.assertTrue(p.startswith("/usr/bin:/opt/homebrew/bin"))
        self.assertIn(os.path.join(os.path.expanduser("~"), ".opencode", "bin"), p.split(":"))


class Declarations(unittest.TestCase):
    def test_the_callers_variable_wins(self):
        env = S.scenario_env({"env": {"STAGES": "ui", "MODEL": "free"}}, {"STAGES": "real", "PATH": "/bin"})
        self.assertEqual(env["STAGES"], "real")
        self.assertEqual(env["MODEL"], "free")

    def test_start_args_follow_meta_instance(self):
        self.assertEqual(S.start_args("suite", {}, "/A.app"), ["instance", "start", "suite", "--json", "--app", "/A.app", "--agents"])
        self.assertEqual(S.start_args("suite", {"onboarding": "fresh", "seed": False, "folder": "/f"}, ""),
                         ["instance", "start", "suite", "--json", "--agents", "--onboarding", "fresh", "--no-seed", "--folder", "/f"])
        self.assertNotIn("--agents", S.start_args("suite", {"agents": False}, ""))

    def test_meta_is_read_by_importing_the_scenario(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("no node on this Mac")
        d = tempfile.mkdtemp()
        try:
            p = os.path.join(d, "x.mjs")
            with open(p, "w") as f:
                f.write("const t = 'X';\nexport const meta = { title: t, needs: ['codex'], instance: { onboarding: 'fresh' }, env: { A: '1' } };\n"
                        "export default async function () {}\n")
            with patch.object(S, "node_binary", lambda app=None: node):
                self.assertEqual(S.read_meta(p), {"title": "X", "needs": ["codex"], "instance": {"onboarding": "fresh"}, "env": {"A": "1"}})
                self.assertEqual(S.read_meta(os.path.join(d, "gone.mjs")), {})
        finally:
            shutil.rmtree(d, ignore_errors=True)


class Verdicts(unittest.TestCase):
    def setUp(self):
        self.out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.out, True)

    def test_passed_partial_skipped(self):
        self.assertEqual(S.verdict(0, {"ok": True, "steps": 9}, "", self.out), {"status": "passed", "steps": 9})
        self.assertEqual(S.verdict(0, {"ok": True, "partial": {"reason": "no key"}}, "", self.out)["status"], "partial")
        self.assertEqual(S.verdict(0, {"ok": None, "skipped": "no second Mac"}, "", self.out), {"status": "skipped", "reason": "no second Mac"})

    def test_failed_names_the_step(self):
        with open(os.path.join(self.out, "steps.json"), "w") as f:
            json.dump({"steps": [{"i": 1, "ok": True, "action": "click"}, {"i": 2, "ok": False, "action": "waitFor", "target": "Projects"}]}, f)
        v = S.verdict(1, {"ok": False, "error": {"message": "never appeared", "shot": "error.png"}}, "", self.out)
        self.assertEqual(v["status"], "failed")
        self.assertEqual(v["step"], {"i": 2, "action": "waitFor", "target": "Projects"})
        self.assertEqual(v["shot"], os.path.join(self.out, "error.png"))
        self.assertEqual(v["error"], "never appeared")

    def test_a_cli_error_is_a_failure_with_its_words(self):
        v = S.verdict(1, {"ok": False, "error": "not_running", "message": "测试实例没在跑"}, "", self.out)
        self.assertEqual((v["status"], v["error"]), ("failed", "测试实例没在跑"))

    def test_summary_lists_every_row(self):
        md = S.summary_md({"app": "/A.app", "results": [{"scenario": "a", "status": "passed", "seconds": 3},
                                                        {"scenario": "b", "status": "failed", "error": "x|y", "step": {"i": 4, "action": "click", "target": "Go"}}]})
        self.assertIn("failed 1  passed 1", md)
        self.assertIn("| b | 1 | failed |", md)
        self.assertIn("step 4 click", md)
        self.assertNotIn("x|y", md)


class FreshRun(unittest.TestCase):
    """run_fresh: needs first (no instance for a skip), the instance always stopped, the verdict from the run."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.scen = os.path.join(self.tmp, "s.mjs")
        open(self.scen, "w").close()
        self.calls = []
        p = patch.object(S, "leftovers", lambda name: [])
        p.start()
        self.addCleanup(p.stop)

    def fake_cli(self, results):
        def cli(argv, env=None, timeout=600, log=None):
            self.calls.append((argv, env))
            return results.get(tuple(argv[:2]), (0, {"ok": True}, ""))
        return cli

    def test_a_missing_need_skips_without_an_instance(self):
        with patch.object(S, "read_meta", lambda p, app=None: {"needs": ["gh"]}), patch.object(S, "unmet", lambda n, setup="", app=None: [("gh", "not signed in")]), \
                patch.object(S, "_cli", self.fake_cli({})):
            r = S.run_fresh(self.scen, app=self.tmp, out=os.path.join(self.tmp, "o"))
        self.assertEqual((r["status"], r["reason"]), ("skipped", "gh: not signed in"))
        self.assertEqual(self.calls, [])

    def test_instance_env_and_stop_after_a_failure(self):
        meta = {"instance": {"onboarding": "fresh", "env": {"FIXTURE": "1"}}, "env": {"STAGE": "ui"}}
        res = {("e2e", "run"): (1, {"ok": False, "error": {"message": "boom"}}, "")}
        with patch.object(S, "read_meta", lambda p, app=None: meta), patch.object(S, "_cli", self.fake_cli(res)):
            r = S.run_fresh(self.scen, app=self.tmp, out=os.path.join(self.tmp, "o"))
        self.assertEqual(r["status"], "failed")
        ops = [tuple(a[:2]) for a, _ in self.calls]
        self.assertEqual(ops, [("instance", "start"), ("e2e", "run"), ("instance", "stop")])
        self.assertEqual(self.calls[0][1]["FIXTURE"], "1")
        self.assertIn("--onboarding", self.calls[0][0])
        self.assertEqual(self.calls[1][1]["STAGE"], "ui")

    def test_a_start_that_fails_still_stops(self):
        res = {("instance", "start"): (1, {"ok": False, "message": "no cdp"}, "")}
        with patch.object(S, "read_meta", lambda p, app=None: {}), patch.object(S, "_cli", self.fake_cli(res)):
            r = S.run_fresh(self.scen, app=self.tmp, out=os.path.join(self.tmp, "o"))
        self.assertEqual((r["status"], r["stage"], r["error"]), ("failed", "instance start", "no cdp"))
        self.assertEqual([tuple(a[:2]) for a, _ in self.calls], [("instance", "start"), ("instance", "stop")])

    def test_suite_goes_round_and_writes_its_summary(self):
        seen = []

        def fresh(n, app, out, timeout=300, name=S.SUITE_INSTANCE, log=None):
            seen.append((n, out))
            return {"scenario": n, "status": "failed" if n == "b" and "pass-1" in out else "passed"}
        with patch.object(S, "run_fresh", fresh), patch.object(S.E, "build_info", lambda app: {"name": "x"}), \
                patch.object(S, "read_meta", lambda p, app=None: {}), patch.object(S.E, "scenario_path", lambda n: n), patch.object(S.time, "sleep", lambda s: None):
            r = S.suite(["a", "b"], app=self.tmp, out=os.path.join(self.tmp, "suite"), repeat=2, log=lambda m: None)
        self.assertEqual([n for n, _ in seen], ["a", "b", "a", "b"])
        self.assertFalse(r["ok"])
        doc = json.load(open(os.path.join(self.tmp, "suite", "summary.json")))
        self.assertEqual([(x["scenario"], x["pass"], x["status"]) for x in doc["results"]],
                         [("a", 1, "passed"), ("b", 1, "failed"), ("a", 2, "passed"), ("b", 2, "passed")])
        self.assertTrue(doc["finished"])
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "suite", "summary.md")))


class Lanes(unittest.TestCase):
    def test_lanes_share_the_round_and_exclusive_ones_run_alone_after(self):
        import threading
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        running, peak, order, lock = [0], [0], [], threading.Lock()

        def fresh(n, app, out, timeout=300, name=S.SUITE_INSTANCE, log=None):
            with lock:
                running[0] += 1
                peak[0] = max(peak[0], running[0])
                order.append((n, name, running[0]))
            threading.Event().wait(0.1)  # (time.sleep is stubbed out for the suite's own pauses)
            with lock:
                running[0] -= 1
            return {"scenario": n, "status": "passed"}
        metas = {"clip": {"exclusive": True}}
        with patch.object(S, "run_fresh", fresh), patch.object(S.E, "build_info", lambda app: {}), \
                patch.object(S, "read_meta", lambda p, app=None: metas.get(p, {})), patch.object(S.E, "scenario_path", lambda n: n), \
                patch.object(S.time, "sleep", lambda s: None):
            r = S.suite(["a", "b", "c", "clip"], app=tmp, out=os.path.join(tmp, "out"), lanes=2, log=lambda m: None)
        self.assertTrue(r["ok"])
        self.assertEqual(peak[0], 2)
        self.assertEqual(order[-1][:2], ("clip", "suite"))
        self.assertEqual(order[-1][2], 1, "the exclusive one runs alone")
        self.assertEqual({n for n, lane, _ in order[:-1]}, {"a", "b", "c"})
        self.assertEqual({lane for _, lane, _ in order}, {"suite", "suite-2"})


if __name__ == "__main__":
    unittest.main()


class FreeModel(unittest.TestCase):
    """The free OpenCode model a test takes is the first that answers now, remembered a while."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cache = os.path.join(self.tmp, "free-model.json")
        env = patch.dict(os.environ, {}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DISPATCH_E2E_OPENCODE_MODEL", None)

    def test_the_first_that_answers_and_it_is_remembered(self):
        asked = []
        up = {"opencode/nemotron-3.5-lightning-free"}
        ask = lambda m: asked.append(m) or m in up
        with patch.object(S.E, "cheap_opencode_model", lambda: "opencode/mimo-v2.6-flash-free"):
            self.assertEqual(S.free_model(self.cache, now=1000, ask=ask), "opencode/nemotron-3.5-lightning-free")
            self.assertEqual(asked, ["opencode/mimo-v2.6-flash-free", "opencode/nemotron-3.5-lightning-free"])
            self.assertEqual(S.free_model(self.cache, now=1000 + 60, ask=ask), "opencode/nemotron-3.5-lightning-free")
            self.assertEqual(len(asked), 2, "asked again within the quarter hour")
            up.clear(); up.add("opencode/mimo-v2.6-flash-free")
            self.assertEqual(S.free_model(self.cache, now=1000 + S.FREE_MODEL_TTL + 1, ask=ask), "opencode/mimo-v2.6-flash-free")

    def test_none_when_a_paid_cheap_model_or_a_chosen_one_is_there_or_nothing_answers(self):
        ask = lambda m: self.fail("no need to ask")
        with patch.object(S.E, "cheap_opencode_model", lambda: "zhipuai-coding-plan/glm-5.3-flash"):
            self.assertIsNone(S.free_model(self.cache, now=1, ask=ask))
        with patch.object(S.E, "cheap_opencode_model", lambda: "opencode/mimo-v2.6-flash-free"):
            with patch.dict(os.environ, {"DISPATCH_E2E_OPENCODE_MODEL": "opencode/big-pickle"}):
                self.assertIsNone(S.free_model(self.cache, now=1, ask=ask))
            self.assertIsNone(S.free_model(self.cache, now=1, ask=lambda m: False))
            self.assertFalse(os.path.exists(self.cache))
