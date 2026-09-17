import os
import sys
import types
import json
import shutil
import tempfile
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import init_wizard  # noqa: E402
W = init_wizard


class ReverseSsh(unittest.TestCase):
    """The hub can only merge this Mac's sessions if it can ssh back. The check has to
    tell 远程登录-not-on apart from a plain network problem, because only the first has a
    concrete thing the user can flip."""

    STATE = {"hub": {"ssh": "hub@100.1.1.1"}, "me": {"ssh": "me@100.1.1.2"}}

    def test_hub_machine_has_nothing_to_check(self):
        with patch.object(init_wizard, "load_state", return_value={}):
            r = init_wizard.check_reverse_ssh()
        self.assertFalse(r["checked"])
        self.assertIn("枢纽", r["note"])

    def test_remote_login_off_points_at_the_toggle(self):
        def fake_run(cmd, **kw):
            return types.SimpleNamespace(returncode=255, stdout="", stderr="ssh: connect to host 100.1.1.2 port 22: Connection refused")

        with patch.object(init_wizard, "load_state", return_value=dict(self.STATE)), \
             patch.object(init_wizard, "machine", return_value={"user": "me", "tailscale_ip": "100.1.1.2", "lan_ip": ""}), \
             patch.object(init_wizard, "remote_login_on", return_value=False), \
             patch.object(init_wizard, "ssh_target_ok", return_value=(True, "")), \
             patch.object(init_wizard, "save_state") as saved, \
             patch.object(init_wizard.subprocess, "run", side_effect=fake_run):
            r = init_wizard.check_reverse_ssh()
        self.assertFalse(r["ok"])
        self.assertEqual(r["ssh"], "me@100.1.1.2")
        self.assertIn("远程登录", r["hint"])
        self.assertEqual(saved.call_args.kwargs["reverse_ssh"], r)

    def test_listening_but_unreachable_blames_the_network(self):
        def fake_run(cmd, **kw):
            return types.SimpleNamespace(returncode=255, stdout="", stderr="ssh: connect to host 100.1.1.2 port 22: Operation timed out")

        with patch.object(init_wizard, "load_state", return_value=dict(self.STATE)), \
             patch.object(init_wizard, "machine", return_value={"user": "me", "tailscale_ip": "100.1.1.2", "lan_ip": ""}), \
             patch.object(init_wizard, "remote_login_on", return_value=True), \
             patch.object(init_wizard, "ssh_target_ok", return_value=(True, "")), \
             patch.object(init_wizard, "save_state"), \
             patch.object(init_wizard.subprocess, "run", side_effect=fake_run):
            r = init_wizard.check_reverse_ssh()
        self.assertFalse(r["ok"])
        self.assertIn("Tailscale", r["hint"])

    def test_hub_reaching_back_is_ok(self):
        def fake_run(cmd, **kw):
            return types.SimpleNamespace(returncode=0, stdout="ok\n", stderr="")

        with patch.object(init_wizard, "load_state", return_value=dict(self.STATE)), \
             patch.object(init_wizard, "machine", return_value={"user": "me", "tailscale_ip": "100.1.1.2", "lan_ip": ""}), \
             patch.object(init_wizard, "remote_login_on", return_value=True), \
             patch.object(init_wizard, "ssh_target_ok", return_value=(True, "")), \
             patch.object(init_wizard, "save_state"), \
             patch.object(init_wizard.subprocess, "run", side_effect=fake_run) as run:
            r = init_wizard.check_reverse_ssh()
        self.assertTrue(r["ok"])
        self.assertIn("me@100.1.1.2", run.call_args.args[0][-1])

    def test_hub_unreachable_is_reported_as_such(self):
        with patch.object(init_wizard, "load_state", return_value=dict(self.STATE)), \
             patch.object(init_wizard, "machine", return_value={"user": "me", "tailscale_ip": "100.1.1.2", "lan_ip": ""}), \
             patch.object(init_wizard, "remote_login_on", return_value=True), \
             patch.object(init_wizard, "ssh_target_ok", return_value=(False, "Connection timed out")), \
             patch.object(init_wizard, "save_state"), \
             patch.object(init_wizard.subprocess, "run", side_effect=AssertionError("must not ssh the hub twice")):
            r = init_wizard.check_reverse_ssh()
        self.assertFalse(r["ok"])
        self.assertIn("连不上枢纽", r["hint"])


if __name__ == "__main__":
    unittest.main()



class ModelsStep(unittest.TestCase):
    """「模型与总结」: nothing automatic until the person picks (review P1-1)."""

    def _run(self, choice, uses=None, catalog=None):
        import summarize as S
        saved, state = {}, {}
        catalog = catalog or [{"id": "claude:haiku", "label": "Claude Haiku", "configured": True, "subscription": True, "env": ""},
                              {"id": "openai:gpt-4.1-mini", "label": "gpt", "configured": False, "subscription": False, "env": "OPENAI_API_KEY"}]
        with patch.object(W.D, "settings_load", return_value={"summary_auto": 0, "summary_uses": {}}), patch.object(W.D, "settings_save", side_effect=lambda cur: saved.update(cur)), \
             patch.object(W, "save_state", side_effect=lambda **k: state.update(k)), patch.object(S, "model_catalog", return_value=catalog):
            res = W.models_setup(choice, uses)
        return res, saved, state

    def test_off_switches_every_automatic_use_off(self):
        res, saved, state = self._run("off")
        self.assertEqual(state, {"models": "off"}); self.assertEqual(saved["summary_auto"], 0)
        self.assertTrue(all(v == 0 for k, v in saved["summary_uses"].items() if k != "discuss")); self.assertEqual(saved["summary_uses"]["discuss"], 1)

    def test_subscription_with_picked_uses(self):
        res, saved, state = self._run("claude:haiku", ["session", "project"])
        self.assertEqual(saved["summary_model"], "claude:haiku"); self.assertEqual(saved["summary_auto"], 1)
        self.assertEqual({k for k, v in saved["summary_uses"].items() if v}, {"session", "project", "discuss"})

    def test_a_model_without_its_key_is_refused(self):
        with self.assertRaises(RuntimeError):
            self._run("openai:gpt-4.1-mini")


class ClaudeHooks(unittest.TestCase):
    """Installing hooks keeps the person's own status line and a backup, uses absolute paths, and
    only adds the edit guard when asked (review P1-4)."""

    def _install(self, before, **kw):
        tmp = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, tmp, True)
        settings = os.path.join(tmp, "settings.json")
        if before is not None:
            json.dump(before, open(settings, "w"))
        with patch.object(W, "CLAUDE_SETTINGS", settings), patch.object(W, "STATUSLINE_ORIG", os.path.join(tmp, "statusline-orig")), patch.object(W.D, "DISPATCH_DIR", tmp):
            res = W.install_claude_hooks(**kw)
        return tmp, json.load(open(settings)), res

    def test_existing_statusline_is_kept_and_forwarded(self):
        tmp, d, res = self._install({"statusLine": {"type": "command", "command": "my-status --fancy", "padding": 2}, "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "their-own-hook"}]}]}})
        self.assertEqual(open(os.path.join(tmp, "statusline-orig")).read().strip(), "my-status --fancy")
        self.assertIn("statusline-tee.sh", d["statusLine"]["command"]); self.assertEqual(d["statusLine"]["padding"], 2)
        self.assertTrue(os.path.exists(os.path.join(tmp, "settings.json.dispatch-bak")))
        self.assertIn("their-own-hook", json.dumps(d["hooks"]["Stop"]))
        self.assertTrue(res["kept_statusline"])

    def test_prime_uses_absolute_paths_and_speaks_as_the_agent(self):
        _, d, _ = self._install({})
        prime = next(h["command"] for g in d["hooks"]["SessionStart"] for h in g["hooks"] if "prime" in h["command"])
        self.assertIn("BEADS_ACTOR=claude-code", prime); self.assertIn("dispatch.py", prime); self.assertNotIn(".local/bin/dispatch", prime)
        self.assertNotIn("python3 \"$HOME", json.dumps(d))  # no bare python3

    def test_edit_guard_is_opt_in_and_sticky(self):
        _, d, res = self._install({})
        self.assertNotIn("dispatch-edit-guard", json.dumps(d)); self.assertFalse(res["edit_guard"])
        _, d, res = self._install({}, edit_guard=True)
        self.assertIn("dispatch-edit-guard", json.dumps(d))
        tmp, d2, res2 = self._install(d)  # re-run without saying: what was chosen stays
        self.assertTrue(res2["edit_guard"])

    def test_rerun_does_not_overwrite_the_saved_statusline_with_the_tee(self):
        tmp, d, _ = self._install({"statusLine": {"type": "command", "command": "orig"}})
        with patch.object(W, "CLAUDE_SETTINGS", os.path.join(tmp, "settings.json")), patch.object(W, "STATUSLINE_ORIG", os.path.join(tmp, "statusline-orig")), patch.object(W.D, "DISPATCH_DIR", tmp):
            W.install_claude_hooks()
        self.assertEqual(open(os.path.join(tmp, "statusline-orig")).read().strip(), "orig")
