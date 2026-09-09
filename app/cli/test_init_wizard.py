import os
import sys
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import init_wizard  # noqa: E402


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
