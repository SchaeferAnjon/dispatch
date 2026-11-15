# -*- coding: utf-8 -*-
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
import dplatform as P  # noqa: E402
W = init_wizard
from engines import claude as CL  # noqa: E402
from engines import codex as CX  # noqa: E402

# Strict on the Windows CI runner (app/scripts/ci-py-windows.py).
WINDOWS_READY = True
ON_WINDOWS = os.name == "nt"


@patch.object(P, "IS_WIN", False)
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
    """Installing Dispatch's hook entry keeps the person's own status line and a backup, uses absolute paths, and the
    edit guard is a switch of the entry that is off until asked for (review P1-4)."""

    def _install(self, before, tmp=None):
        if tmp is None:
            tmp = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, tmp, True)
        settings = os.path.join(tmp, "settings.json")
        if before is not None:
            json.dump(before, open(settings, "w"))
        with patch.object(CL, "STATUSLINE_ORIG", os.path.join(tmp, "statusline-orig")), patch.object(W.D, "DISPATCH_DIR", tmp):
            res = CL.ENGINE.install_hooks(path=settings)
        return tmp, json.load(open(settings)), res

    def test_existing_statusline_is_kept_and_forwarded(self):
        tmp, d, res = self._install({"statusLine": {"type": "command", "command": "my-status --fancy", "padding": 2}, "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "their-own-hook"}]}]}})
        self.assertEqual(open(os.path.join(tmp, "statusline-orig")).read().strip(), "my-status --fancy")
        self.assertIn("statusline-tee.sh", d["statusLine"]["command"]); self.assertEqual(d["statusLine"]["padding"], 2)
        self.assertTrue(os.path.exists(os.path.join(tmp, "settings.json.dispatch-bak")))
        self.assertEqual(d["hooks"]["Stop"][0]["hooks"], [{"type": "command", "command": "their-own-hook"}])
        self.assertTrue(res["kept_statusline"])

    def test_one_entry_with_absolute_paths_on_every_event(self):
        import hooks_setup
        _, d, _ = self._install({})
        cmds = {h["command"] for gs in d["hooks"].values() for g in gs for h in g["hooks"]}
        self.assertEqual(len(cmds), 1, cmds)
        cmd = cmds.pop()
        self.assertTrue(cmd.endswith(" claude-code # dispatch-hook"), cmd)
        # the stable shim outside the app, which runs this hook.py on this python (no bare python3)
        self.assertTrue(cmd.startswith(hooks_setup.shim_path() + " ") or cmd.startswith("'" + hooks_setup.shim_path()), cmd)
        self.assertNotIn(".local/bin/dispatch", cmd); self.assertNotIn("hook.py", cmd)
        shim = open(hooks_setup.shim_path(), encoding="utf-8").read()
        self.assertIn(hooks_setup.hook_script(), shim); self.assertIn(sys.executable, shim)
        self.assertTrue(os.access(hooks_setup.shim_path(), os.X_OK))
        self.assertEqual(set(d["hooks"]), set(CL.ENGINE.hook_routes))
        self.assertEqual(d["hooks"]["SessionStart"][0]["matcher"], "")

    def test_edit_guard_is_opt_in_and_sticky(self):
        import hook
        import hooks_setup
        import dispatch_dir as DD
        saved = DD.config_load()
        self.addCleanup(DD.config_save, saved)
        self.assertFalse(hook.switches("claude-code")["edit-guard"])
        with patch.object(W, "save_state"), patch.object(CL.ENGINE, "install_hooks", return_value={}), \
                patch("dispatch_mcp.register", return_value={}):
            W.agents_setup(["claude-code", "--edit-guard"])
            self.assertTrue(hook.switches("claude-code")["edit-guard"])
            W.agents_setup(["claude-code"])  # a re-run without saying: what was chosen stays
            self.assertTrue(hook.switches("claude-code")["edit-guard"])
            W.agents_setup(["claude-code", "--no-edit-guard"])
            self.assertFalse(hook.switches("claude-code")["edit-guard"])
        # an older install's guard hooks become the switch when the entry replaces them
        cfg = DD.config_load(); cfg.get("hooks", {}).pop("claude-code", None); DD.config_save(cfg)
        self.assertFalse(hooks_setup.switch("claude-code", "edit-guard"))
        _, d, res = self._install({"hooks": {"PreToolUse": [{"matcher": "Edit|Write", "hooks": [
            {"type": "command", "command": 'python3 "$HOME/tasks/.dispatch/edit-guard.py" claude-code pre # dispatch-edit-guard'}]}]}})
        self.assertEqual(res["migrated"], ["edit-guard"])
        self.assertTrue(hook.switches("claude-code")["edit-guard"])
        self.assertNotIn("edit-guard.py", json.dumps(d))

    def test_the_persons_own_file_is_kept_once_before_dispatch_first_adds_to_it(self):
        mine = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "their-own-hook"}]}]}}
        tmp, d, res = self._install(mine)
        keep = os.path.join(tmp, "settings.json.pre-dispatch")
        self.assertEqual(res["original"], keep)
        self.assertEqual(json.load(open(keep)), mine)
        with open(os.path.join(tmp, "settings.json")) as f:
            d = json.load(f)
        d["hooks"]["Stop"][0]["hooks"].append({"type": "command", "command": "python3 x.py # dispatch-life"})
        tmp, _d, res2 = self._install(d, tmp)  # a second install: .dispatch-bak now has Dispatch's hooks, the original stays
        self.assertTrue(res2["changed"])
        self.assertEqual(json.load(open(keep)), mine)
        self.assertIn("dispatch-hook", open(os.path.join(tmp, "settings.json.dispatch-bak")).read())

    def test_a_rerun_with_nothing_to_change_does_not_write(self):
        tmp, _d, _res = self._install({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "their-own-hook"}]}]}})
        settings = os.path.join(tmp, "settings.json")
        os.utime(settings, (1, 1))
        _tmp, _d, res = self._install(None, tmp)
        self.assertFalse(res["changed"])
        self.assertEqual(os.stat(settings).st_mtime, 1)

    def test_rerun_does_not_overwrite_the_saved_statusline_with_the_tee(self):
        tmp, d, _ = self._install({"statusLine": {"type": "command", "command": "orig"}})
        self._install(None, tmp)
        self.assertEqual(open(os.path.join(tmp, "statusline-orig")).read().strip(), "orig")

    def test_uninstall_takes_the_entry_out_and_gives_the_status_line_back(self):
        tmp, _d, _ = self._install({"statusLine": {"type": "command", "command": "orig"}, "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "their-own-hook"}]}]}})
        settings = os.path.join(tmp, "settings.json")
        with patch.object(CL, "STATUSLINE_ORIG", os.path.join(tmp, "statusline-orig")), patch.object(W.D, "DISPATCH_DIR", tmp):
            self.assertTrue(CL.ENGINE.uninstall_hooks(path=settings))
        d = json.load(open(settings))
        self.assertEqual(d, {"statusLine": {"type": "command", "command": "orig", "padding": 0}, "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "their-own-hook"}]}]}})


class SetupScreenArguments(unittest.TestCase):
    """What the first-run screen sends must get through the real argument parser. A flag the
    parser does not know stops every new user at that step (`unrecognized arguments`)."""

    def _run(self, argv):
        import contextlib, io
        import dispatch
        buf = io.StringIO()
        with patch.object(sys, "argv", ["dispatch"] + argv), contextlib.redirect_stdout(buf):
            dispatch.main()
        return buf.getvalue()

    def test_agent_step_with_the_edit_guard_checkbox_either_way(self):
        for flag, want in (("--no-edit-guard", False), ("--edit-guard", True), (None, None)):
            with patch.object(W, "agents_setup", return_value={"ok": True}) as step:
                self._run(["init", "run", "agents", "codex", "claude-code"] + ([flag] if flag else []) + ["--json"])
            self.assertEqual(step.call_args.args[0], ["codex", "claude-code"])
            self.assertIs(step.call_args.kwargs["edit_guard"], want)


@unittest.skipIf(ON_WINDOWS, "macOS: symlinks and POSIX shells (Windows: WindowsSetup below)")
@patch.object(P, "IS_WIN", False)
class TerminalCommand(unittest.TestCase):
    """Step 2: `dispatch` must be found in a NEW terminal of whatever kind, and the person is told
    that a window already open will not see it."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home, True)
        self.cli = os.path.join(self.home, "bundle-dispatch.py")
        open(self.cli, "w").write("#!/usr/bin/env python3\n")
        for p in (patch.object(W.D, "HOME", self.home), patch.object(W.D, "DISPATCH_DIR", os.path.join(self.home, "tasks", ".dispatch")),
                  patch.object(W, "bundled_cli", return_value=self.cli), patch.object(W, "which", return_value=None),
                  patch.object(W, "shell_finds_dispatch", return_value=True), patch.object(W, "zsh_dotdir", return_value=self.home),
                  patch.object(W, "INIT_FILE", os.path.join(self.home, "init.json")), patch.dict(os.environ, {"SHELL": "/bin/zsh"})):
            p.start(); self.addCleanup(p.stop)

    def test_path_goes_to_login_and_interactive_files_once(self):
        open(os.path.join(self.home, ".zshrc"), "w").write("# >>> conda initialize >>>\nexport PATH=/opt/conda/bin:$PATH")
        r = W.cli_link()
        self.assertTrue(os.path.islink(os.path.join(self.home, ".local", "bin", "dispatch")))
        W.cli_link()  # running the step again adds nothing
        for name in (".zprofile", ".zshrc"):
            text = open(os.path.join(self.home, name)).read()
            self.assertEqual(text.count("# dispatch"), 1, name)
        self.assertTrue(open(os.path.join(self.home, ".zshrc")).read().startswith("# >>> conda"))  # theirs is kept, ours comes after
        self.assertFalse(os.path.exists(os.path.join(self.home, ".bash_profile")))
        self.assertTrue(r["verified"]); self.assertIn("新开", r["reopen"])
        # the machine id exists from the first run on (doctor warned on a brand-new Mac before the first worker)
        self.assertTrue(open(os.path.join(self.home, ".dispatch", "machine-id")).read().strip())

    @unittest.skipUnless(os.path.exists("/bin/zsh"), "needs zsh")
    def test_a_real_new_zsh_finds_it_even_when_only_zshrc_is_read(self):
        W.cli_link()
        os.remove(os.path.join(self.home, ".zprofile"))  # an interactive non-login shell never reads it
        import subprocess
        env = {"HOME": self.home, "ZDOTDIR": self.home, "PATH": "/usr/bin:/bin", "TERM": "dumb"}
        r = subprocess.run(["/bin/zsh", "-ic", "command -v dispatch"], capture_output=True, text=True, env=env, timeout=20, stdin=subprocess.DEVNULL)
        self.assertIn(os.path.join(self.home, ".local", "bin", "dispatch"), r.stdout, r.stderr)


@unittest.skipUnless(os.path.exists("/bin/zsh"), "needs zsh")
class TerminalCommandInAwkwardShells(unittest.TestCase):
    """Real zsh, real config files, a throwaway home. These are the setups where the first
    version left people with `command not found` although the step said it was ready."""

    def setUp(self):
        self.home = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.home, True)
        self.cli = os.path.join(self.home, "bundle-dispatch.py")
        with open(self.cli, "w") as f:
            f.write("#!/usr/bin/env python3\n")
        self.env = {"HOME": self.home, "PATH": "/usr/bin:/bin", "TERM": "dumb", "SHELL": "/bin/zsh"}
        real_run = W.subprocess.run

        def run_in_that_home(argv, **kw):
            if argv and argv[0] in ("/bin/zsh", "/bin/bash", "/bin/tcsh", "/bin/sh"):
                kw["env"] = dict(self.env, SHELL=argv[0])
            return real_run(argv, **kw)
        for p in (patch.object(W.D, "HOME", self.home), patch.object(W.D, "DISPATCH_DIR", os.path.join(self.home, "tasks", ".dispatch")),
                  patch.object(W, "INIT_FILE", os.path.join(self.home, "init.json")), patch.object(W, "bundled_cli", return_value=self.cli),
                  patch.object(W, "which", return_value=None), patch.object(W.subprocess, "run", side_effect=run_in_that_home),
                  # never outside the throwaway home, whatever the system's own PATH folders allow
                  patch.object(W, "may_link_into", side_effect=lambda d: os.path.realpath(d).startswith(self.home) and os.access(d, os.W_OK)),
                  patch.dict(os.environ, {"SHELL": "/bin/zsh"})):
            p.start(); self.addCleanup(p.stop)

    def new_terminal(self, shell="/bin/zsh", flags="-lic", ask="command -v dispatch"):
        import subprocess
        r = subprocess.run([shell, flags, ask], capture_output=True, text=True, env=dict(self.env, SHELL=shell), timeout=20, stdin=subprocess.DEVNULL)
        return r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""

    def test_the_default_mac_zsh_in_terminal_app_with_no_config_files_at_all(self):
        # What most people have: a new Mac, Terminal.app, zsh, nothing in the home folder yet.
        r = W.cli_link()
        self.assertTrue(r["verified"], r)
        self.assertEqual(r["also_linked"], "")
        self.assertEqual(self.new_terminal(), os.path.join(self.home, ".local", "bin", "dispatch"))
        self.assertEqual(self.new_terminal(flags="-ic"), os.path.join(self.home, ".local", "bin", "dispatch"))  # a tmux pane, VS Code

    def test_bash_user_who_keeps_everything_in_profile(self):
        with open(os.path.join(self.home, ".profile"), "w") as f:
            f.write("export THEIRS=1\n")
        with patch.dict(os.environ, {"SHELL": "/bin/bash"}):
            r = W.cli_link()
        self.assertTrue(r["verified"], r)
        self.assertFalse(os.path.exists(os.path.join(self.home, ".bash_profile")))  # it would switch their ~/.profile off
        self.assertEqual(self.new_terminal("/bin/bash", "-lc"), os.path.join(self.home, ".local", "bin", "dispatch"))
        self.assertEqual(self.new_terminal("/bin/bash", "-lc", "echo $THEIRS"), "1")

    def test_bash_user_with_a_bash_profile(self):
        with open(os.path.join(self.home, ".bash_profile"), "w") as f:
            f.write("export THEIRS=1\n")
        with patch.dict(os.environ, {"SHELL": "/bin/bash"}):
            W.cli_link(); W.cli_link()
        self.assertEqual(open(os.path.join(self.home, ".bash_profile")).read().count("# dispatch"), 1)
        self.assertEqual(self.new_terminal("/bin/bash", "-lc"), os.path.join(self.home, ".local", "bin", "dispatch"))
        self.assertEqual(self.new_terminal("/bin/bash", "-ic"), os.path.join(self.home, ".local", "bin", "dispatch"))

    @unittest.skipUnless(os.path.exists("/bin/tcsh"), "needs tcsh")
    def test_tcsh_user(self):
        with patch.dict(os.environ, {"SHELL": "/bin/tcsh"}):
            r = W.cli_link()
        self.assertTrue(r["verified"], r)
        self.assertIn("setenv PATH", open(os.path.join(self.home, ".tcshrc")).read())
        self.assertEqual(self.new_terminal("/bin/tcsh", "-c", "which dispatch"), os.path.join(self.home, ".local", "bin", "dispatch"))

    def test_nothing_is_created_for_shells_this_person_does_not_use(self):
        W.cli_link()
        for name in (".bash_profile", ".bashrc", ".profile", ".tcshrc", ".cshrc"):
            self.assertFalse(os.path.exists(os.path.join(self.home, name)), name)

    def test_zshrc_that_rebuilds_path_from_scratch(self):
        mine = os.path.join(self.home, "bin"); os.makedirs(mine)
        # Their ~/.zshrc ends by throwing PATH away, after anything we append... so we append, and it
        # still loses when they add lines later. Simulate the worst case: the reset comes from ~/.zlogin.
        with open(os.path.join(self.home, ".zlogin"), "w") as f:
            f.write(f'export PATH="{mine}:/usr/bin:/bin"\n')
        r = W.cli_link()
        self.assertTrue(r["verified"], r)
        self.assertEqual(r["also_linked"], os.path.join(mine, "dispatch"))
        self.assertEqual(self.new_terminal(), os.path.join(mine, "dispatch"))

    def test_config_folder_moved_with_zdotdir(self):
        dot = os.path.join(self.home, ".config", "zsh"); os.makedirs(dot)
        with open(os.path.join(self.home, ".zshenv"), "w") as f:
            f.write(f'export ZDOTDIR="{dot}"\n')
        r = W.cli_link()
        self.assertTrue(r["verified"], r)
        self.assertIn("# dispatch", open(os.path.join(dot, ".zshrc")).read())
        self.assertEqual(self.new_terminal(), os.path.join(self.home, ".local", "bin", "dispatch"))

    def test_a_file_of_theirs_called_dispatch_is_left_alone(self):
        mine = os.path.join(self.home, "bin"); os.makedirs(mine)
        with open(os.path.join(mine, "dispatch"), "w") as f:
            f.write("theirs")
        with open(os.path.join(self.home, ".zshrc"), "w") as f:
            f.write(f'export PATH="{mine}:/usr/bin:/bin"\n')
        self.assertEqual(W.link_into_shell_path("/bin/zsh", os.path.join(self.home, ".local", "bin", "dispatch")), "")
        self.assertEqual(open(os.path.join(mine, "dispatch")).read(), "theirs")


@unittest.skipIf(ON_WINDOWS, "macOS: launchctl and the shared Dolt server")
@patch.object(P, "IS_WIN", False)
class BoardServerRepair(unittest.TestCase):
    """`dolt circuit breaker is open: server appears down`: the board exists, its database
    server does not answer. Bring it back, or say what the server itself says."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home, True)
        beads = os.path.join(self.home, "tasks", ".beads"); os.makedirs(beads)
        open(os.path.join(beads, "config.yaml"), "w").write("dolt:\n  mode: server\n")
        self.shared = os.path.join(self.home, ".beads", "shared-server"); os.makedirs(os.path.join(self.shared, "dolt"))
        self.launch = os.path.join(self.home, "Library", "LaunchAgents"); os.makedirs(self.launch)
        self.calls = []
        for p in (patch.object(W.D, "BEADS_DIR", beads), patch.object(W, "SHARED", self.shared), patch.object(W, "LAUNCH_DIR", self.launch),
                  patch.object(W, "DOLT_CONFIG", os.path.join(self.shared, "dolt", "config.yaml")), patch.object(W, "INIT_FILE", os.path.join(self.home, "init.json")),
                  patch.object(W.subprocess, "run", side_effect=lambda argv, **kw: self.calls.append(argv) or types.SimpleNamespace(returncode=0, stdout="", stderr="")),
                  patch.object(W, "run", side_effect=lambda argv, **kw: self.calls.append(argv) or (0, "", "")), patch.object(W, "which", side_effect=lambda n: "/x/" + n)):
            p.start(); self.addCleanup(p.stop)

    def test_running_server_is_left_alone(self):
        with patch.object(W, "dolt_server_up", return_value=True):
            self.assertEqual(W.ensure_board_server()["how"], "already up")
        self.assertEqual(self.calls, [])

    def test_the_hub_gets_its_keepalive_job_kicked(self):
        open(os.path.join(self.launch, W.L.label("dolt-server") + ".plist"), "w").write("x")
        with patch.object(W, "dolt_server_up", return_value=False), patch.object(W, "wait_server", return_value=True):
            r = W.ensure_board_server()
        self.assertTrue(r["started"]); self.assertEqual(r["how"], "kickstart")
        self.assertTrue(any(a[:2] == ["launchctl", "kickstart"] for a in self.calls))

    def test_a_joined_mac_asks_bd_to_start_it(self):
        with patch.object(W, "dolt_server_up", return_value=False), patch.object(W, "wait_server", return_value=True):
            self.assertEqual(W.ensure_board_server()["how"], "bd dolt start")
        self.assertIn(["/x/bd", "dolt", "start"], self.calls)

    def test_when_it_will_not_start_the_servers_own_words_come_back(self):
        open(os.path.join(self.shared, "dolt-server.log"), "w").write("starting\nerror: listen tcp 127.0.0.1:3308: bind: address already in use\n")
        with patch.object(W, "dolt_server_up", return_value=False), patch.object(W, "wait_server", return_value=False):
            r = W.ensure_board_server()
        self.assertFalse(r["ok"]); self.assertIn("address already in use", r["log"])

    def test_bd_saying_the_server_is_down_triggers_one_repair_and_a_retry(self):
        import dispatch as DD
        answers = [(1, "", "Error: failed to open database: dolt circuit breaker is open: server appears down, failing fast (cooldown 5s)"), (0, "[]", "")]
        fake = types.SimpleNamespace(ensure_board_server=lambda: {"ok": True, "started": True, "log": ""})
        with patch.object(DD, "_sh_once", side_effect=lambda *a, **k: answers.pop(0)) as once, patch.object(DD, "_mod", return_value=fake), \
             patch.object(DD.time, "sleep"), patch.dict(DD._board_revived, {"tried": False}):
            self.assertEqual(DD._sh(["bd", "list", "--json"])[0], 0)
            self.assertEqual(once.call_count, 2)
            # a second failure in the same process is reported, not looped on
            answers.append((1, "", "server appears down"))
            self.assertEqual(DD._sh(["bd", "list"])[0], 1)
            self.assertEqual(once.call_count, 3)


@patch.object(P, "IS_WIN", False)
class MacBoardEmbedded(unittest.TestCase):
    """A new Mac's board lives in bd's embedded database (bd and Dolt ship inside Dispatch IDE): no
    Dolt server, no launchd job. Only a hub (`board first hub`) gets the shared server."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home, True)
        self.beads = os.path.join(self.home, "tasks", ".beads")
        self.calls = []
        for p in (patch.object(W.D, "BEADS_DIR", self.beads), patch.object(W, "INIT_FILE", os.path.join(self.home, "init.json")),
                  patch.object(W, "which", side_effect=lambda n: "/App/bin/" + n if n in ("bd", "dolt") else ""),
                  patch.object(W, "board_works", return_value=(True, "")),
                  patch.object(W, "enable_remotesapi", side_effect=AssertionError("no remotesapi")),
                  patch.object(W, "ensure_sync_user", side_effect=AssertionError("no sync user"))):
            p.start(); self.addCleanup(p.stop)

    def fake_bd_init(self, args, **kw):
        self.calls.append(args)
        os.makedirs(self.beads, exist_ok=True)
        open(os.path.join(self.beads, "config.yaml"), "w").write("# bd\n")
        json.dump({"backend": "dolt", "dolt_mode": "embedded", "dolt_database": "task"}, open(os.path.join(self.beads, "metadata.json"), "w"))
        return 0, "", ""

    def test_first_board_is_embedded_and_leaves_tasks_folder_alone(self):
        with patch.object(W, "run", side_effect=self.fake_bd_init):
            r = W.board_first()
        self.assertTrue(r["embedded"])
        self.assertEqual(self.calls[0], ["/App/bin/bd", "init", "--prefix", "task", "--non-interactive", "--quiet", "--skip-agents", "--skip-hooks"])
        self.assertTrue(W.board_is_embedded())
        with patch.object(W.subprocess, "run", side_effect=AssertionError("no launchctl / dolt")):
            self.assertEqual(W.ensure_board_server()["how"], "embedded")
            b = W.board_status()
        self.assertTrue(b["embedded"] and b["server_up"])
        self.assertFalse(W.sync_project_id())

    def test_hub_keeps_the_shared_server(self):
        self.assertIn("--shared-server", W.board_init_args(embedded=False))
        self.assertNotIn("--skip-agents", W.board_init_args(embedded=False))

    def test_ensure_board_creates_once(self):
        with patch.object(W, "run", side_effect=self.fake_bd_init):
            first = W.ensure_board()
            again = W.ensure_board()
        self.assertTrue(first["created"]); self.assertFalse(again["created"]); self.assertTrue(again["embedded"])
        self.assertEqual(len([c for c in self.calls if "init" in c]), 1)
        # bd's usage reporting (an extra `bd send-metrics` process after its commands) is off on a board Dispatch makes
        self.assertEqual([c[1:] for c in self.calls if "metrics" in c], [["metrics", "off"]])

    def test_a_server_board_is_not_embedded(self):
        os.makedirs(self.beads)
        json.dump({"dolt_mode": "server"}, open(os.path.join(self.beads, "metadata.json"), "w"))
        self.assertFalse(W.board_is_embedded())


@patch.object(P, "IS_WIN", False)
class BoardProjectIdentity(unittest.TestCase):
    """bd 1.3 stores the project's id in the database and refuses to connect when
    ~/tasks/.beads/metadata.json names another one. Dispatch writes that file on a fresh Mac, so
    it has to carry the database's id. Found by running first-run setup in a clean macOS VM."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home, True)
        self.beads = os.path.join(self.home, "tasks", ".beads"); os.makedirs(self.beads)
        self.meta = os.path.join(self.beads, "metadata.json")
        with open(self.meta, "w") as f:
            json.dump({"database": "dolt", "dolt_database": "task", "project_id": "0a4baa20-e40c-4165-a42b-4e560f81608f"}, f)
        self.real = "356a74fe-86b2-4592-bdf2-d531461860eb"
        table = f"+-------+\n| value |\n+-------+\n| {self.real} |\n+-------+\n"
        self.sql = patch.object(W, "dolt_sql", return_value=(0, table, ""))
        for p in (patch.object(W.D, "BEADS_DIR", self.beads), self.sql, patch.object(W, "dolt_server_up", return_value=True), patch.object(W, "our_board_server_running", return_value=True)):
            p.start(); self.addCleanup(p.stop)

    def pid(self):
        return json.load(open(self.meta))["project_id"]

    def test_the_file_takes_the_databases_id_and_the_old_one_is_kept_aside(self):
        self.assertTrue(W.sync_project_id())
        self.assertEqual(self.pid(), self.real)
        self.assertIn("0a4baa20", open(self.meta + ".dispatch-bak").read())
        self.assertFalse(W.sync_project_id())  # already right: nothing to do

    def test_never_against_a_server_that_is_not_this_boards(self):
        with patch.object(W, "our_board_server_running", return_value=False):
            self.assertFalse(W.sync_project_id())
        self.assertTrue(self.pid().startswith("0a4baa20"))

    def test_an_older_bd_database_without_an_id_changes_nothing(self):
        with patch.object(W, "dolt_sql", return_value=(0, "Empty set\n", "")):
            self.assertFalse(W.sync_project_id())
        with patch.object(W, "dolt_sql", return_value=(1, "", "table not found: metadata")):
            self.assertFalse(W.sync_project_id())
        self.assertTrue(self.pid().startswith("0a4baa20"))

    def test_the_mismatch_error_counts_as_a_board_to_repair(self):
        import dispatch as DD
        err = "Error: failed to open database: PROJECT IDENTITY MISMATCH — refusing to connect"
        self.assertTrue(any(m in err.lower() for m in DD.BOARD_DOWN_MARKS))


class WindowsSetup(unittest.TestCase):
    """The Windows branch of first-run setup, exercised on any OS by flipping dplatform.IS_WIN."""

    PY = "C:\\Users\\me\\AppData\\Local\\Dispatch\\python\\python.exe"
    CLI = "C:\\Users\\me\\AppData\\Local\\Dispatch\\cli\\dispatch.py"

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home, True)
        for p in (patch.object(P, "IS_WIN", True), patch.object(W.D, "HOME", self.home),
                  patch.object(W, "INIT_FILE", os.path.join(self.home, "init.json")),
                  patch.object(W.D, "DISPATCH_DIR", os.path.join(self.home, "tasks", ".dispatch"))):
            p.start(); self.addCleanup(p.stop)

    def test_machine_does_not_need_os_uname(self):
        with patch.object(W.os, "uname", side_effect=AttributeError("no uname on Windows"), create=True), \
             patch.object(W.D, "local_host_name", return_value="DESKTOP-1"), patch.object(W.D, "tailscale_ip", return_value=""), \
             patch.object(W, "lan_ip", return_value="192.168.1.9"), patch.object(W.D, "overlay_network", return_value={}, create=True):
            m = W.machine()
        self.assertEqual((m["name"], m["arch"], m["lan_ip"]), ("DESKTOP-1", P.machine(), "192.168.1.9"))
        self.assertTrue(m["user"])

    def test_dependencies_come_from_winget_without_brew_or_tmux(self):
        with patch.object(W, "which", side_effect=lambda n: "C:/winget.exe" if n == "winget" else ""):
            rows = {r["name"]: r for r in W.deps_status()}
        self.assertNotIn("brew", rows); self.assertNotIn("tmux", rows)
        self.assertTrue(rows["winget"]["found"] and rows["python"]["found"])
        self.assertEqual(rows["bd"]["command"], "winget install -e --id GasTownHall.Beads --silent --accept-package-agreements --accept-source-agreements")
        self.assertIn("Git.Git", rows["git"]["command"]); self.assertTrue(rows["git"]["required"])
        self.assertFalse(rows["dolt"]["required"])
        self.assertTrue(rows["bd"]["installable"])
        self.assertTrue(W.clt_installed())

    def test_install_runs_winget_per_package(self):
        calls = []
        with patch.object(W, "which", side_effect=lambda n: "C:/winget.exe" if n == "winget" else ""), \
             patch.object(W, "run", side_effect=lambda args, **kw: calls.append(args) or (0, "ok", "")):
            r = W.deps_install(["bd", "winget"])
        self.assertEqual(r["installed"], ["bd", "winget"])  # winget itself is there already
        self.assertEqual(calls[0], ["C:/winget.exe", "install", "-e", "--id", "GasTownHall.Beads", "--silent", "--accept-package-agreements", "--accept-source-agreements"])
        with patch.object(W, "which", return_value=""), patch.object(W, "run", side_effect=AssertionError("nothing to run without winget")):
            r = W.deps_install(["winget", "git"])
        self.assertEqual([f["name"] for f in r["failed"]], ["winget", "git"])
        self.assertIn("ms-windows-store", r["failed"][0]["command"]); self.assertIn("Git.Git", r["failed"][1]["command"])

    def test_launchers_instead_of_a_symlink(self):
        cmd, sh = W.shim_texts(self.PY, self.CLI)
        self.assertEqual(cmd, "@echo off\r\nsetlocal\r\nset PYTHONUTF8=1\r\n\"%s\" \"%s\" %%*\r\n" % (self.PY, self.CLI))
        self.assertIn('exec "/c/Users/me/AppData/Local/Dispatch/python/python.exe" "/c/Users/me/AppData/Local/Dispatch/cli/dispatch.py" "$@"', sh)
        self.assertTrue(sh.startswith("#!/bin/sh\n")); self.assertNotIn("\r", sh); self.assertNotIn("\\", sh)
        with patch.object(W, "shim_python", return_value=self.PY), patch.object(W, "bundled_cli", return_value=self.CLI), \
             patch.object(P, "add_user_path", return_value=True) as add, patch.object(W, "win_finds_dispatch", return_value=True):
            r = W.cli_link()
        bindir = os.path.join(self.home, ".local", "bin")
        add.assert_called_once_with(bindir)
        self.assertTrue(r["verified"]); self.assertEqual(r["link"], os.path.join(bindir, "dispatch.cmd"))
        with open(os.path.join(bindir, "dispatch.cmd"), "rb") as f:
            self.assertEqual(f.read().decode("utf-8"), cmd)  # CRLF kept for cmd.exe
        with open(os.path.join(bindir, "dispatch"), "rb") as f:
            self.assertEqual(f.read().decode("utf-8"), sh)  # LF only for Git Bash
        self.assertFalse(os.path.islink(os.path.join(bindir, "dispatch")))
        with patch.object(W, "bundled_cli", return_value=self.CLI):
            st = W.cli_status()
        self.assertTrue(st["exists"]); self.assertEqual(st["target"], self.CLI)
        for rc in (".zshrc", ".zprofile", ".bash_profile", ".profile"):
            self.assertFalse(os.path.exists(os.path.join(self.home, rc)), rc)

    def test_launcher_python_is_never_pythonw(self):
        with patch.object(W.sys, "executable", "C:\\Py\\pythonw.exe"):
            self.assertEqual(W.shim_python(), "C:\\Py\\python.exe")

    def test_hooks_point_into_the_install_folder_with_forward_slashes(self):
        import hooks_setup
        settings = os.path.join(self.home, "settings.json")
        with patch.object(CL, "STATUSLINE_ORIG", os.path.join(self.home, "orig")), \
             patch.object(W, "shim_python", return_value="C:\\Py\\python.exe"), patch.object(W, "HERE", "C:\\App\\cli"), \
             patch.object(hooks_setup, "HERE", "C:\\App\\cli"):
            CL.ENGINE.install_hooks(path=settings)
        d = json.load(open(settings, encoding="utf-8"))
        cmds = {h["command"] for groups in d["hooks"].values() for g in groups for h in g["hooks"]}
        self.assertEqual(cmds, {"C:/Py/python.exe C:/App/cli/hook.py claude-code # dispatch-hook"})
        self.assertEqual(d["statusLine"]["command"], "bash C:/App/cli/statusline-tee.sh")
        self.assertNotIn("\\", json.dumps(d["hooks"]).replace("\\\\", ""))
        self.assertNotIn("$HOME/tasks/.dispatch/presence.py", json.dumps(d))

    def test_board_is_embedded_and_never_starts_a_server(self):
        beads = os.path.join(self.home, "tasks", ".beads"); os.makedirs(beads)
        with patch.object(W.D, "BEADS_DIR", beads), patch.object(W.subprocess, "run", side_effect=AssertionError("no launchctl / dolt on Windows")):
            self.assertEqual(W.ensure_board_server()["how"], "no board")
            open(os.path.join(beads, "config.yaml"), "w").write("x\n")
            r = W.ensure_board_server()
            self.assertEqual(r, {"ok": True, "started": False, "how": "embedded", "log": ""})
            b = W.board_status()
            self.assertTrue(b["server_up"] and b["embedded"]); self.assertFalse(b["launchd"] or b["remotesapi"])
            self.assertFalse(W.sync_project_id())

    def test_new_board_uses_bd_init_without_shared_server(self):
        beads = os.path.join(self.home, "tasks", ".beads")
        calls = []
        with patch.object(W.D, "BEADS_DIR", beads), patch.object(W, "which", side_effect=lambda n: "C:/bd/bd.exe" if n == "bd" else ""), \
             patch.object(W, "run", side_effect=lambda args, **kw: calls.append((args, kw)) or (0, "", "")), \
             patch.object(W, "board_works", return_value=(True, "")), \
             patch.object(W, "enable_remotesapi", side_effect=AssertionError("no remotesapi")), patch.object(W, "ensure_sync_user", side_effect=AssertionError("no sync user")):
            r = W.board_first()
        self.assertEqual(calls[0][0], ["C:/bd/bd.exe", "init", "--prefix", "task", "--non-interactive", "--quiet"])
        self.assertNotIn("--shared-server", calls[0][0])
        self.assertTrue(r["embedded"]); self.assertEqual(W.load_state()["board_mode"], "first")
        self.assertFalse(os.path.exists(os.path.join(beads, "config.yaml")))  # bd writes its own, not our shared-server one

    def test_multi_machine_steps_say_unsupported(self):
        for fn, args in ((W.board_join, ("me@mac",)), (W.ssh_key_setup, ("me@mac", "pw")), (W.check_reverse_ssh, ()), (W.hub_info, ()),
                         (W.board_retire, ()), (W.enable_remotesapi, ()), (W.install_dolt_launchd, ()), (W.kill_board_dolt, ()),
                         (W.rsync_from, ("me@mac", "a", "b", "x"))):
            with self.assertRaises(P.Unsupported, msg=fn.__name__):
                fn(*args)

    def test_join_through_the_command_is_a_plain_unsupported_answer(self):
        import contextlib, io
        buf = io.StringIO()
        a = types.SimpleNamespace(op="run", args=["board", "join", "me@mac"], json=True, edit_guard=None)
        with contextlib.redirect_stdout(buf):
            W.main(a)  # no SystemExit: exit code 0
        out = json.loads(buf.getvalue())
        self.assertTrue(out["unsupported"]); self.assertIn("Windows", out["message"])


    def test_no_getuid_outside_the_mac_branches(self):
        import re
        for name in ("init_wizard.py", "serve.py", "updater.py", "screen_setup.py"):
            src = open(os.path.join(HERE, name), encoding="utf-8").read()
            for fn in re.split(r"\n(?=def )", src):
                if "os.getuid()" in fn:
                    # the Windows guard (which returns or raises) comes before the first getuid of the function
                    self.assertIn("if P.IS_WIN:", fn, f"{name}: {fn.splitlines()[0]}")
                    self.assertLess(fn.index("if P.IS_WIN:"), fn.index("os.getuid()"), f"{name}: {fn.splitlines()[0]}")


if __name__ == "__main__":
    unittest.main()


class CodexHooks(unittest.TestCase):
    def install(self, path):
        with patch.object(P, "IS_WIN", False):
            return CX.ENGINE.install_hooks(path=path, trust=False)

    def test_the_entry_replaces_older_hooks_and_keeps_other_entries(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "hooks.json")
            other = {"type": "command", "command": "bd codex-hook PostCompact"}
            mine = {"type": "command", "command": "my-own-check"}
            with open(path, "w") as f:
                json.dump({"hooks": {"PostCompact": [{"matcher": "manual|auto", "hooks": [other]}],
                                     "PostToolUse": [{"hooks": [{"type": "command", "command": 'python3 "$HOME/tasks/.dispatch/presence.py" codex PostToolUse # dispatch-presence'}], "matcher": "Bash"},
                                                     {"matcher": "apply_patch", "hooks": [mine]},
                                                     {"matcher": "update_plan", "hooks": [{"type": "command", "command": '"$HOME/.local/bin/dispatch" task plan --hook # dispatch-plan'}]}],
                                     "SessionStart": [{"hooks": [{"type": "command", "command": "BEADS_ACTOR=codex python3 x/dispatch.py prime --hook-json # dispatch-prime", "timeout": 45}]}]}}, f)
            res = self.install(path)
            self.assertEqual(res["migrated"], ["plan", "presence", "prime"])
            self.assertFalse(self.install(path)["changed"])  # twice: still one entry, the file not even written
            d2 = json.load(open(path))
            cmds = {h["command"] for gs in d2["hooks"].values() for g in gs for h in g["hooks"]} - {other["command"], mine["command"]}
            self.assertEqual(len(cmds), 1)
            self.assertEqual(set(CX.ENGINE.hook_routes) - set(d2["hooks"]), set())
            post = d2["hooks"]["PostToolUse"]
            self.assertIn("# dispatch-hook", post[0]["hooks"][0]["command"])  # where the first older hook was
            self.assertNotIn("matcher", post[0])
            self.assertEqual(post[1], {"matcher": "apply_patch", "hooks": [mine]})
            self.assertEqual(d2["hooks"]["PostCompact"][0]["hooks"], [other])
            start = d2["hooks"]["SessionStart"][0]
            self.assertEqual((start["hooks"][0]["timeout"], start["hooks"][0]["additionalContextLimit"]), (45, 2500))
            self.assertNotIn("matcher", start)  # every start, after a compaction too

    def test_keeps_a_backup_and_the_persons_original(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "hooks.json")
            mine = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "notify-me"}]}]}}
            with open(path, "w") as f:
                json.dump(mine, f)
            res = self.install(path)
            self.install(path)
            with open(path + ".pre-dispatch") as f:
                self.assertEqual(json.load(f), mine)
            self.assertEqual(res["original"], path + ".pre-dispatch")
            with open(path) as f:
                d2 = json.load(f)
            self.assertEqual(d2["hooks"]["Stop"][0], mine["hooks"]["Stop"][0], "their hook keeps its place")

    def test_skips_without_codex(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIn("skipped", self.install(os.path.join(d, "nope", "hooks.json")))

    def test_a_file_of_another_shape_is_left_alone(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "hooks.json")
            for raw in ('{"hooks": []}', "{bad"):
                with open(path, "w") as f:
                    f.write(raw)
                self.assertIn("skipped", self.install(path))
                self.assertEqual(open(path).read(), raw)


class OpenCodeHooks(unittest.TestCase):
    def test_selected_opencode_installs_the_plugin_in_xdg_config(self):
        import opencode_engine as O
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {"XDG_CONFIG_HOME": d}), \
                patch.object(W, "save_state"):
            r = W.agents_setup(["opencode"])
            self.assertEqual(r["installed"]["opencode"]["path"], os.path.join(d, "opencode", "plugins", "dispatch.js"))
            self.assertTrue(O.plugin_state()["current"])
            self.assertTrue(W.agents_setup(["opencode"])["installed"]["opencode"]["unchanged"])
            # its config gets Dispatch's MCP server and nothing else (dispatch_mcp.py)
            with open(os.path.join(d, "opencode", "opencode.json")) as f:
                self.assertEqual(list(json.load(f)["mcp"]), ["dispatch"])
            self.assertEqual([c["engine"] for c in r["mcp"]["changed"]], ["opencode"])
            self.assertTrue(O.uninstall_plugin()["removed"])

    def test_no_names_reinstalls_the_saved_pick(self):
        with patch.object(W, "load_state", return_value={"agents": ["opencode"]}), patch.object(W, "save_state") as save, \
                patch.object(W.E.get("opencode"), "install_hooks", return_value={"ok": True}) as inst:
            r = W.agents_setup([])
        self.assertEqual(r["agents"], ["opencode"])
        save.assert_called_once_with(agents=["opencode"])
        inst.assert_called_once()

    def test_install_error_is_reported_without_breaking_setup(self):
        with patch.object(W, "save_state"), patch.object(W.E.get("opencode"), "install_hooks", side_effect=OSError("read only")):
            self.assertEqual(W.agents_setup(["opencode"])["installed"]["opencode"], {"error": "read only"})

class BuiltinSkills(unittest.TestCase):
    def test_pool_gets_links_and_old_copies_are_relinked_with_a_backup(self):
        import shutil
        with tempfile.TemporaryDirectory() as t:
            pool, backups = os.path.join(t, "pool"), os.path.join(t, "backups")
            I = init_wizard
            src = I.bundled_skill_dir()
            shutil.copytree(os.path.join(src, "task-board"), os.path.join(pool, "task-board"))  # an earlier setup's copy
            os.makedirs(os.path.join(pool, "delivery-page"))
            with open(os.path.join(pool, "delivery-page", "SKILL.md"), "w") as f:
                f.write("---\nname: delivery-page\n---\nmy own way of delivering\n")  # the person's own skill
            done = I.link_builtin_skills(pool, backups)
            # the copy is relinked; the skills it did not have yet are linked fresh
            self.assertEqual([d["skill"] for d in done], ["task-board", "built-in-browser", "computer-use", "designer", "teaching-master", "animation-director", "leader", "neat-freak"])
            self.assertTrue(os.path.islink(os.path.join(pool, "task-board")))
            self.assertEqual(os.path.realpath(os.path.join(pool, "task-board")), os.path.realpath(os.path.join(src, "task-board")))
            self.assertTrue(os.path.isfile(os.path.join(done[0]["backup"], "SKILL.md")))
            self.assertFalse(os.path.islink(os.path.join(pool, "delivery-page")))
            self.assertEqual(I.link_builtin_skills(pool, backups), [])  # idempotent
            shutil.rmtree(os.path.join(pool, "delivery-page"))
            os.symlink(os.path.join(t, "gone"), os.path.join(pool, "delivery-page"))  # a broken link
            self.assertEqual([d["skill"] for d in I.link_builtin_skills(pool, backups)], ["delivery-page"])
            self.assertTrue(os.path.isdir(os.path.join(pool, "delivery-page")))



class BoardInitLock(unittest.TestCase):
    """A second `bd init` that meets the first one's database lock waits and tries again (bugs3, 10-07)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.beads = os.path.join(self.tmp, "tasks", ".beads")
        p = patch.object(init_wizard.D, "BEADS_DIR", self.beads)
        p.start()
        self.addCleanup(p.stop)
        for name, value in (("which", lambda n: "/x/bd"), ("board_works", lambda: (True, "")), ("save_state", lambda **k: None)):
            q = patch.object(init_wizard, name, value)
            q.start()
            self.addCleanup(q.stop)
        q = patch.object(init_wizard.time, "sleep", lambda s: None)
        q.start()
        self.addCleanup(q.stop)

    def test_a_locked_database_is_tried_again(self):
        calls = []

        def run(argv, **kw):
            calls.append(argv)
            if len(calls) == 1:
                return 1, "", "Error 1105: the database is locked by another dolt process. Try again."
            open(os.path.join(self.beads, "config.yaml"), "w").close()
            return 0, "", ""
        with patch.object(init_wizard, "run", run):
            got = init_wizard.board_first_embedded()
        self.assertEqual(len([c for c in calls if "init" in c]), 2)
        self.assertTrue(got["embedded"])

    def test_another_failure_is_said_at_once(self):
        with patch.object(init_wizard, "run", lambda argv, **kw: (1, "", "disk is full")):
            with self.assertRaises(RuntimeError) as e:
                init_wizard.board_first_embedded()
        self.assertIn("disk is full", str(e.exception))

    def test_a_board_made_meanwhile_is_taken_as_it_is(self):
        os.makedirs(self.beads)
        open(os.path.join(self.beads, "config.yaml"), "w").close()
        with patch.object(init_wizard, "run", lambda argv, **kw: self.fail("no second bd init")):
            self.assertTrue(init_wizard.board_first_embedded()["embedded"])
