# -*- coding: utf-8 -*-
import os
import subprocess
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dplatform as P  # noqa: E402

WINDOWS_READY = True

WIN = mock.patch.object(P, "IS_WIN", True)
POSIX = mock.patch.object(P, "IS_WIN", False)


class PathEnv(unittest.TestCase):
    def test_windows_joins_with_semicolon(self):
        with WIN, mock.patch.dict(os.environ, {"LOCALAPPDATA": "C:\\Users\\x\\AppData\\Local", "USERPROFILE": "C:\\Users\\x"}):
            e = P.path_env({"PATH": "C:\\Windows\\system32"})
        self.assertIn(";", e["PATH"])
        self.assertNotIn(":C:", e["PATH"])
        self.assertTrue(e["PATH"].endswith(";C:\\Windows\\system32"))
        self.assertIn("C:\\Users\\x\\AppData\\Local\\Microsoft\\WinGet\\Links", e["PATH"].split(";"))

    def test_windows_accepts_mixed_case_path_key(self):
        with WIN:
            e = P.path_env({"Path": "C:\\Tools"})
        self.assertTrue(e["PATH"].endswith(";C:\\Tools"))
        self.assertNotIn("Path", e)

    def test_posix_joins_with_colon(self):
        # DISPATCH_IDE_BIN (set inside Dispatch IDE and by the test guards) would come first
        with POSIX, mock.patch.dict(os.environ, {"DISPATCH_IDE_BIN": ""}):
            e = P.path_env({"PATH": "/usr/bin"})
        self.assertEqual(e["PATH"].split(":")[:2], ["/opt/homebrew/bin", "/usr/local/bin"])
        self.assertTrue(e["PATH"].endswith(":/usr/bin"))

    def test_does_not_mutate_the_input(self):
        src = {"PATH": "/usr/bin"}
        P.path_env(src)
        self.assertEqual(src, {"PATH": "/usr/bin"})


class Which(unittest.TestCase):
    def test_skips_store_stub(self):
        stub = "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps"
        real = "C:\\Python312"
        calls = []

        def fake_which(name, path=None):
            calls.append(path)
            if path == real:
                return real + "\\python.exe"
            if path == stub:
                return stub + "\\python.exe"
            return None

        with WIN, mock.patch.object(P, "extra_bin_dirs", lambda: []), mock.patch.object(P.shutil, "which", fake_which):
            hit = P.which("python", env={"PATH": stub + ";" + real})
        self.assertEqual(hit, real + "\\python.exe")
        self.assertNotIn(stub, calls)

    def test_store_stub_detection(self):
        self.assertTrue(P.is_store_stub("C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe"))
        self.assertTrue(P.is_store_stub("c:/users/x/appdata/local/microsoft/windowsapps/python3.exe"))
        self.assertFalse(P.is_store_stub("C:\\Python312\\python.exe"))
        self.assertFalse(P.is_store_stub(None))

    def test_posix_finds_a_real_tool(self):
        if os.name == "nt":
            self.skipTest("posix only")
        self.assertTrue(P.which("sh"))


class Quoting(unittest.TestCase):
    def test_powershell_doubles_single_quotes(self):
        with WIN:
            self.assertEqual(P.shell_quote("it's"), "'it''s'")
            self.assertEqual(P.cd_and("C:\\Users\\x\\it's", "claude --resume 1"),
                             "Set-Location -LiteralPath 'C:\\Users\\x\\it''s'; claude --resume 1")

    def test_posix_cd_and(self):
        with POSIX:
            self.assertEqual(P.cd_and("/Users/x/my proj", "claude"), "cd '/Users/x/my proj' && claude")
            self.assertEqual(P.cd_and("/Users/x/p", "claude"), "cd /Users/x/p && claude")

    def test_paste_hint(self):
        with WIN:
            self.assertIn("Get-Clipboard", P.paste_hint())
        with POSIX:
            self.assertIn("pbpaste", P.paste_hint())


class Paths(unittest.TestCase):
    def test_from_msys(self):
        self.assertEqual(P.from_msys("/c/Users/x/proj"), "C:\\Users\\x\\proj")
        self.assertEqual(P.from_msys("/d"), "D:\\")
        self.assertEqual(P.from_msys("/Users/x"), "/Users/x")
        self.assertEqual(P.from_msys("C:\\x"), "C:\\x")

    def test_is_abs_both_forms(self):
        for p in ("/Users/x/p", "C:\\Users\\x", "C:/Users/x", "\\\\server\\share"):
            self.assertTrue(P.is_abs(p), p)
        for p in ("", None, "proj", "./x", "C:rel", "~/x"):
            self.assertFalse(P.is_abs(p), p)

    def test_to_slash(self):
        self.assertEqual(P.to_slash("C:\\Users\\x\\p"), "C:/Users/x/p")

    def test_windows_norm_path_is_case_insensitive(self):
        with WIN:
            self.assertTrue(P.same_path("C:\\Users\\X\\Proj", "c:/users/x/proj/"))
            self.assertTrue(P.is_under("C:/Users/x/proj/sub", "c:\\users\\x\\PROJ"))
            self.assertFalse(P.is_under("C:/Users/x/project2", "C:/Users/x/proj"))
            self.assertFalse(P.is_under("D:/x", "C:/x"))

    def test_posix_is_under(self):
        with POSIX:
            self.assertTrue(P.is_under("/Users/x/proj/a", "/Users/x/proj"))
            self.assertTrue(P.is_under("/Users/x/proj", "/Users/x/proj"))
            self.assertFalse(P.is_under("/Users/x/project2", "/Users/x/proj"))

    def test_home_relative(self):
        self.assertEqual(P.home_relative(os.path.join(P.HOME, "Projects", "k")), "~/Projects/k")
        self.assertEqual(P.home_relative(P.HOME), "~")
        other = "C:\\elsewhere" if os.name == "nt" else "/elsewhere/x"
        self.assertEqual(P.home_relative(other), other)

    def test_exe_base(self):
        self.assertEqual(P.exe_base("C:\\Program Files\\nodejs\\node.exe"), "node")
        self.assertEqual(P.exe_base("/Applications/Claude.app/Contents/MacOS/Claude"), "claude")
        self.assertEqual(P.exe_base("codex"), "codex")


class InstallHint(unittest.TestCase):
    def test_windows_uses_winget(self):
        with WIN:
            self.assertEqual(P.install_hint("bd"), "winget install GasTownHall.Beads")
            self.assertEqual(P.install_hint("git"), "winget install Git.Git")
            self.assertIsNone(P.install_hint("rsync"))

    def test_mac_uses_brew(self):
        with POSIX:
            self.assertEqual(P.install_hint("git"), "brew install git")
            self.assertEqual(P.install_hint("tmux"), "brew install tmux")


class Processes(unittest.TestCase):
    def test_spawn_detached_windows_flags(self):
        with WIN, mock.patch.object(P.subprocess, "Popen") as popen:
            P.spawn_detached(["x.exe", "a"])
        kw = popen.call_args.kwargs
        self.assertEqual(kw["creationflags"], P.detached_flags())
        self.assertTrue(kw["creationflags"] & P.CREATE_NO_WINDOW)
        self.assertTrue(kw["creationflags"] & P.DETACHED_PROCESS)
        self.assertNotIn("start_new_session", kw)

    def test_spawn_detached_swaps_in_pythonw(self):
        exe = "C:\\Py\\python.exe"
        with WIN, mock.patch.object(P.sys, "executable", exe), mock.patch.object(P.os.path, "exists", lambda p: p == "C:\\Py\\pythonw.exe"), \
                mock.patch.object(P.subprocess, "Popen") as popen:
            P.spawn_detached([exe, "serve.py"])
        self.assertEqual(popen.call_args.args[0], ["C:\\Py\\pythonw.exe", "serve.py"])

    def test_spawn_detached_posix(self):
        with POSIX, mock.patch.object(P.subprocess, "Popen") as popen:
            P.spawn_detached(["x"])
        kw = popen.call_args.kwargs
        self.assertTrue(kw["start_new_session"])
        self.assertNotIn("creationflags", kw)

    def test_no_window_flags(self):
        with WIN:
            self.assertEqual(P.no_window_flags(), 0x08000000)
        with POSIX:
            self.assertEqual(P.no_window_flags(), 0)

    def test_pid_alive_on_windows_uses_winproc_not_kill(self):
        import winproc
        with WIN, mock.patch.object(winproc, "pid_alive", return_value=True) as wp, mock.patch.object(P.os, "kill") as kill:
            self.assertTrue(P.pid_alive(1234))
        wp.assert_called_once_with(1234)
        kill.assert_not_called()

    def test_pid_alive_posix(self):
        if os.name == "nt":
            self.skipTest("posix only")
        with POSIX:
            self.assertTrue(P.pid_alive(os.getpid()))
            self.assertFalse(P.pid_alive(0))
            self.assertFalse(P.pid_alive("x"))

    def test_pid_alive_real_on_this_os(self):
        self.assertTrue(P.pid_alive(os.getpid()))
        p = subprocess.Popen([sys.executable, "-c", "pass"])
        p.wait()
        self.assertFalse(P.pid_alive(p.pid))

    def test_ps_table_contains_self(self):
        t = P.ps_table()
        self.assertIn(os.getpid(), t)
        self.assertIn("python", P.exe_base(t[os.getpid()][1]))


class Links(unittest.TestCase):
    def test_mount_link_windows_uses_junction(self):
        import types
        fake = types.SimpleNamespace(CreateJunction=mock.MagicMock())
        with WIN, mock.patch.dict(sys.modules, {"_winapi": fake}), mock.patch.object(P.os.path, "abspath", lambda p: "C:\\pool\\skill"), \
                mock.patch.object(P.os, "symlink") as sym:
            P.mount_link("pool/skill", "C:\\mount\\skill")
        fake.CreateJunction.assert_called_once_with("C:\\pool\\skill", "C:\\mount\\skill")
        sym.assert_not_called()

    def test_real_link_roundtrip(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src")
            os.mkdir(src)
            open(os.path.join(src, "f"), "w").close()
            link = os.path.join(d, "link")
            P.mount_link(src, link)
            self.assertTrue(P.is_link(link))
            self.assertFalse(P.is_link(src))
            self.assertTrue(os.path.exists(os.path.join(link, "f")))
            P.unlink_link(link)
            self.assertFalse(os.path.lexists(link))
            self.assertTrue(os.path.exists(os.path.join(src, "f")))

    def test_replace_retry(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            a, b = os.path.join(d, "a"), os.path.join(d, "b")
            open(a, "w").write("new")
            n = {"i": 0}
            real = os.replace

            def flaky(s, t):
                if (s, t) != (a, b):  # os.replace is shared: a write another thread makes meanwhile is not this one
                    return real(s, t)
                n["i"] += 1
                if n["i"] < 3:
                    raise PermissionError("busy")
                real(s, t)

            with mock.patch.object(P.os, "replace", flaky):
                P.replace_retry(a, b, delay=0)
            self.assertEqual(open(b).read(), "new")
            self.assertEqual(n["i"], 3)


class Misc(unittest.TestCase):
    def test_unsupported_message(self):
        with self.assertRaises(P.Unsupported) as cm:
            P.unsupported("远程屏幕")
        self.assertEqual(str(cm.exception), "Windows 版暂不支持远程屏幕，这一功能目前只在 Mac 上可用")

    def test_utf8_stdio_does_not_raise(self):
        P.utf8_stdio()

    def test_host_name_without_uname(self):
        with WIN, mock.patch.dict(os.environ, {"COMPUTERNAME": "DESKTOP-1"}), mock.patch.object(P.os, "uname", create=True, side_effect=AttributeError):
            self.assertEqual(P.host_name(), "DESKTOP-1")
        self.assertTrue(P.host_name())

    def test_user_name_and_machine(self):
        self.assertTrue(P.user_name())
        self.assertTrue(P.machine())

    def test_add_user_path_is_noop_off_windows(self):
        with POSIX:
            self.assertFalse(P.add_user_path("C:\\x"))

    def test_config_paths(self):
        self.assertTrue(P.CLAUDE_CREDENTIALS.endswith(".credentials.json"))
        self.assertTrue(P.OBSIDIAN_CONFIG.endswith("obsidian.json"))
        with WIN, mock.patch.dict(os.environ, {"APPDATA": "C:\\Users\\x\\AppData\\Roaming"}):
            self.assertIn("AppData", P.obsidian_config())

    def test_extra_bin_dirs_windows(self):
        with WIN, mock.patch.dict(os.environ, {"LOCALAPPDATA": "L", "APPDATA": "R", "USERPROFILE": "U", "ProgramFiles": "PF"}):
            dirs = P.extra_bin_dirs()
        self.assertIn("R\\npm", dirs)
        self.assertIn("PF\\Git\\cmd", dirs)


if __name__ == "__main__":
    unittest.main()


class AppToolsFolder(unittest.TestCase):
    """task-oatt: a new Mac has bd and dolt only inside Dispatch IDE. Only dispatch-bridge sets DISPATCH_IDE_BIN, so
    the CLI in a Terminal (and chatd, and the agents it starts) has to find the app's tools folder by itself."""

    def _app(self, root):
        tools = os.path.join(root, "Dispatch IDE.app", "Contents", "Resources", "app", "tools")
        cli = os.path.join(root, "Dispatch IDE.app", "Contents", "Resources", "app", "dispatch-cli", "dispatch", "cli")
        os.makedirs(tools)
        os.makedirs(cli)
        with open(os.path.join(tools, "bd"), "w") as f:
            f.write("#!/bin/sh\necho bd\n")
        os.chmod(os.path.join(tools, "bd"), 0o755)
        return tools, os.path.join(cli, "dplatform.py")

    def test_the_cli_inside_the_app_finds_the_apps_bd_without_dispatch_ide_bin(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d, POSIX:
            tools, module = self._app(d)
            env = {k: v for k, v in os.environ.items() if k != "DISPATCH_IDE_BIN"}
            env["HOME"] = d
            with mock.patch.object(P, "__file__", module), mock.patch.dict(os.environ, env, clear=True):
                self.assertEqual(P.app_tools_dirs()[0], os.path.realpath(tools))
                dirs = P.extra_bin_dirs()
                # after Homebrew's: a bd someone installed themselves still wins
                self.assertGreater(dirs.index(os.path.realpath(tools)), dirs.index("/opt/homebrew/bin"))
                self.assertIn(os.path.realpath(tools), P.path_env({"PATH": "/usr/bin:/bin"})["PATH"].split(":"))

    def test_the_app_in_applications_folders_counts_too(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d, POSIX:
            tools, _ = self._app(os.path.join(d, "Applications"))
            with mock.patch.object(P, "__file__", os.path.join(d, ".dispatch-cli", "dispatch", "cli", "dplatform.py")), \
                    mock.patch.object(P.os.path, "expanduser", lambda p: p.replace("~", d, 1)):
                self.assertIn(tools, P.app_tools_dirs())

    def test_engines_search_path_has_it_for_the_agents_chatd_starts(self):
        import tempfile
        import engines
        with tempfile.TemporaryDirectory() as d, POSIX:
            tools, module = self._app(d)
            with mock.patch.object(P, "__file__", module):
                self.assertIn(os.path.realpath(tools), engines.search_path({"PATH": "/usr/bin:/bin"}).split(os.pathsep))

    def test_windows_has_none(self):
        with WIN:
            self.assertEqual(P.app_tools_dirs(), [])
