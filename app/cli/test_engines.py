# -*- coding: utf-8 -*-
import json, os, stat, subprocess, sys, tempfile, time, unittest
from unittest import mock

import engines as E

WINDOWS_READY = False


def _exe(path, body="#!/bin/sh\necho 'x 1.2.3'\n"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
    return path


class Versions(unittest.TestCase):
    def test_skill_directories_follow_registry_and_environment(self):
        env = {"XDG_CONFIG_HOME": "/sandbox/config", "CODEX_HOME": "/sandbox/codex", "CLAUDE_CONFIG_DIR": "/sandbox/claude"}
        dirs = E.skill_dirs("/sandbox/home", env)
        self.assertEqual(set(dirs), {e.id for e in E.managed()})
        self.assertEqual(dirs["opencode"], ["/sandbox/config/opencode/skills", "/sandbox/home/.claude/skills", "/sandbox/home/.agents/skills"])
        self.assertEqual(dirs["claude"], ["/sandbox/claude/skills"])
        self.assertEqual(dirs["codex"], ["/sandbox/home/.agents/skills", "/sandbox/codex/skills"])
        future = E.Engine(id="future", package="future-cli", skills=("{config}/future/skills",))
        with mock.patch.object(E, "managed", lambda real=E.managed: real() + [future]):
            self.assertEqual(E.skill_dirs("/sandbox/home", env)["future"], ["/sandbox/config/future/skills"])

    def test_compare_numerically_and_prerelease_first(self):
        self.assertGreater(E.vtuple("2.1.290"), E.vtuple("2.1.283"))
        self.assertGreater(E.vtuple("0.160.0"), E.vtuple("0.157.1"))
        self.assertGreater(E.vtuple("1.0.0"), E.vtuple("1.0.0-beta.2"))
        self.assertEqual(E.vtuple(""), (0,))

    def test_parse_version_from_cli_output(self):
        self.assertEqual(E.parse_version("2.1.283 (Claude Code)"), "2.1.283")
        self.assertEqual(E.parse_version("codex-cli 0.157.1"), "0.157.1")
        self.assertEqual(E.parse_version("1.14.31\n"), "1.14.31")
        self.assertEqual(E.parse_version("no version"), "")


class ClaudeConfigDir(unittest.TestCase):
    def test_claude_config_dir_is_where_its_transcripts_are(self):
        from engines import claude as C
        home = os.path.expanduser("~")
        with mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": "/tmp/x/claude-home"}):
            self.assertEqual(C.config_dir(home), "/tmp/x/claude-home")
            self.assertEqual(C.Claude().transcript_root(home), "/tmp/x/claude-home/projects")
            self.assertEqual(C.Claude().rules_target(home)["path"], "/tmp/x/claude-home/CLAUDE.md")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
            self.assertEqual(C.config_dir(home), os.path.join(home, ".claude"))


class SearchPathOnly(unittest.TestCase):
    def test_an_explicit_engine_path_leaves_out_path_and_the_usual_places(self):
        env = {"DISPATCH_ENGINE_PATH": "/x/bin", "PATH": "/opt/homebrew/bin:/y/bin", "DISPATCH_IDE_BIN": "/app/tools"}
        self.assertEqual(E.search_path(env), "/app/tools:/x/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        self.assertIn("/opt/homebrew/bin", E.search_path({"PATH": "/x/bin"}).split(":") if os.path.isdir("/opt/homebrew/bin") else ["/opt/homebrew/bin"])


class Method(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def link(self, target, name):
        path = os.path.join(self.tmp, "bin", name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        os.symlink(target, path)
        return path

    def test_claude_native_installer(self):
        real = _exe(os.path.join(self.tmp, ".local", "share", "claude", "versions", "2.1.283"))
        path = self.link(real, "claude")
        m = E.method(E.get("claude"), path)
        self.assertEqual(m, ("native", ""))
        self.assertEqual(E.upgrade_command(E.get("claude"), *m, path), [path, "update"])

    def test_npm_global_prefix(self):
        prefix = os.path.join(self.tmp, "npm-global")
        real = _exe(os.path.join(prefix, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"))
        path = self.link(real, "codex")
        meth, detail = E.method(E.get("codex"), path)
        self.assertEqual((meth, os.path.realpath(detail)), ("npm", os.path.realpath(prefix)))
        cmd = E.upgrade_command(E.get("codex"), meth, detail, path)
        self.assertEqual(cmd[1:], ["i", "-g", "--prefix", detail, "@openai/codex@latest"])

    def test_homebrew_formula_and_cask(self):
        real = _exe(os.path.join(self.tmp, "Cellar", "opencode", "1.14.0", "bin", "opencode"))
        self.assertEqual(E.method(E.get("opencode"), self.link(real, "opencode")), ("brew", "opencode"))
        real = _exe(os.path.join(self.tmp, "Caskroom", "claude-code", "2.1.0", "claude"))
        m = E.method(E.get("claude"), self.link(real, "claude"))
        self.assertEqual(m, ("brew", "--cask claude-code"))
        self.assertEqual(E.upgrade_command(E.get("claude"), *m), ["brew", "upgrade", "--cask", "claude-code"])

    def test_bun_global_linked_from_home_node_modules(self):
        real = _exe(os.path.join(self.tmp, "node_modules", "opencode-ai", "bin", "opencode"))
        bunbin = os.path.join(self.tmp, ".bun", "bin")
        os.makedirs(bunbin)
        path = os.path.join(bunbin, "opencode")
        os.symlink(real, path)
        m = E.method(E.get("opencode"), path)
        self.assertEqual(m, ("bun", ""))
        self.assertEqual(E.upgrade_command(E.get("opencode"), *m, path)[1:], ["add", "-g", "opencode-ai@latest"])

    def test_opencode_own_installer(self):
        path = _exe(os.path.join(self.tmp, ".opencode", "bin", "opencode"))
        m = E.method(E.get("opencode"), path)
        self.assertEqual(m, ("native", ""))
        self.assertEqual(E.upgrade_command(E.get("opencode"), *m, path), [path, "upgrade"])


class Latest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.p = mock.patch.object(E, "CACHE", os.path.join(self.tmp, "engines-latest.json"))
        self.p.start()
        self.addCleanup(self.p.stop)

    def test_cached_for_an_hour(self):
        calls = []
        fetch = lambda pkg: calls.append(pkg) or {"@anthropic-ai/claude-code": "2.1.290", "@openai/codex": "0.160.0", "opencode-ai": "1.18.32"}[pkg]
        v, t = E.latest_versions(fetch=fetch, now=1000)
        self.assertEqual(v["@openai/codex"], "0.160.0")
        self.assertEqual(len(calls), 3)
        E.latest_versions(fetch=fetch, now=1000 + E.TTL - 1)
        self.assertEqual(len(calls), 3)
        E.latest_versions(fetch=fetch, now=1000 + E.TTL + 1)
        self.assertEqual(len(calls), 6)
        E.latest_versions(fetch=fetch, now=1000 + E.TTL + 2, refresh=True)
        self.assertEqual(len(calls), 9)

    def test_offline_keeps_the_last_answer(self):
        E.latest_versions(fetch=lambda pkg: "1.0.0", now=1000)

        def offline(pkg):
            raise OSError("offline")
        v, t = E.latest_versions(fetch=offline, now=1000 + 2 * E.TTL)
        self.assertEqual(v["opencode-ai"], "1.0.0")
        self.assertEqual(t, 1000)


class Status(unittest.TestCase):
    def test_update_available_and_missing_engine(self):
        tmp = tempfile.mkdtemp()
        prefix = os.path.join(tmp, "npm")
        real = _exe(os.path.join(prefix, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"), "#!/bin/sh\necho 'codex-cli 0.157.1'\n")
        os.makedirs(os.path.join(prefix, "bin"))
        os.symlink(real, os.path.join(prefix, "bin", "codex"))
        # exactly the made-up npm folder: Homebrew's and the other usual places would find this Mac's own codex
        env = {"PATH": os.path.join(prefix, "bin"), "DISPATCH_IDE_BIN": "", "DISPATCH_ENGINE_PATH": os.path.join(prefix, "bin")}
        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(E, "HOME", tmp):
            row = E.status(E.get("codex"), "0.160.0")
            self.assertTrue(row["installed"])
            self.assertEqual(row["version"], "0.157.1")
            self.assertTrue(row["update_available"])
            self.assertEqual(row["method"], "npm")
            self.assertIn("@openai/codex@latest", row["command"])
            self.assertFalse(E.status(E.get("codex"), "0.157.1")["update_available"])

    def test_upgrade_rejects_unknown_engine(self):
        self.assertFalse(E.upgrade("vim")["ok"])

    def test_upgrade_runs_the_command_and_reads_the_new_version(self):
        tmp = tempfile.mkdtemp()
        bindir = os.path.join(tmp, "bin")
        # a fake opencode whose `upgrade` bumps the version it reports
        state = os.path.join(tmp, "v")
        with open(state, "w") as fh:
            fh.write("1.14.31")
        _exe(os.path.join(tmp, ".opencode", "bin", "opencode"),
             f"#!/bin/sh\nif [ \"$1\" = upgrade ]; then echo 1.18.32 > {state}; exit 0; fi\n/bin/cat {state}\n")
        os.makedirs(bindir)
        only = os.pathsep.join([bindir, os.path.join(tmp, ".opencode", "bin")])
        with mock.patch.dict(os.environ, {"PATH": bindir, "DISPATCH_IDE_BIN": ""}), mock.patch.object(E, "HOME", tmp), \
                mock.patch.object(E, "search_path", lambda env=None: only):
            r = E.upgrade("opencode", stream=subprocess.DEVNULL, china=False)
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["before"], r["after"]), ("1.14.31", "1.18.32"))
        self.assertTrue(r["command"].endswith("opencode upgrade"))


class InstallOnANewMac(unittest.TestCase):
    """task-jvtg: a new Mac has neither npm nor Homebrew. Install used to stop at "Install failed. Run" with nothing after."""

    def _bare(self, tmp):
        os.makedirs(os.path.join(tmp, "bin"), exist_ok=True)
        return mock.patch.object(E, "search_path", lambda env=None: os.path.join(tmp, "bin"))

    def test_claude_code_and_opencode_use_their_own_installer_without_node(self):
        tmp = tempfile.mkdtemp()
        with self._bare(tmp):
            for eng in ("claude", "opencode"):
                cmd = E.install_command(E.get(eng))
                self.assertEqual(cmd[:2], ["/bin/bash", "-c"], eng)
                self.assertTrue(cmd[2].startswith("curl -fsSL https://") and cmd[2].endswith("| bash"), cmd)
                # what a person reads (the wizard, Customizations): the curl line itself
                self.assertEqual(E._short(cmd), [cmd[2]])
            self.assertEqual(E.install_command(E.get("codex")), [])

    def test_codex_without_node_says_what_to_do(self):
        tmp = tempfile.mkdtemp()
        with self._bare(tmp), mock.patch.object(E, "engine_path", lambda eng: None):
            r = E.upgrade("codex", stream=subprocess.DEVNULL, china=False)
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "no_installer")
        self.assertIn("Node.js", r["message"])
        self.assertIn("Install again", r["message"].replace("install again", "Install again"))

    def test_mirrors_in_china_use_npm_when_there_is_one(self):
        tmp = tempfile.mkdtemp()
        _exe(os.path.join(tmp, "bin", "npm"), "#!/bin/sh\n")
        with mock.patch.object(E, "search_path", lambda env=None: os.path.join(tmp, "bin")):
            cmd = E.install_command(E.get("claude"))
            china = E.mirrored_command(E.get("claude"), cmd, True)
        self.assertEqual(os.path.basename(china[0]), "npm")
        self.assertIn("@anthropic-ai/claude-code@latest", china)


class Pick(unittest.TestCase):
    """The copy Dispatch runs: 1.14 in ~/.opencode/bin used to shadow 1.18 in ~/.bun/bin (401 on every new session)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.dirs = [os.path.join(self.tmp, n) for n in ("a", "b", "c")]
        for d in self.dirs:
            os.makedirs(d)
        self.env = {"PATH": os.pathsep.join(self.dirs), "DISPATCH_IDE_BIN": ""}
        # only our three directories: a real /opt/homebrew/bin/opencode must not join in
        for patch in (mock.patch.object(E, "HOME", self.tmp), mock.patch.object(E, "search_path", lambda env=None: self.env["PATH"])):
            patch.start()
            self.addCleanup(patch.stop)

    def fake(self, dirname, version):
        return _exe(os.path.join(self.tmp, dirname, "opencode"), f"#!/bin/sh\necho {version}\n")

    def pick(self):
        return E.pick(E.get("opencode"), self.env)

    def test_minimum_is_shared_with_the_engine_table(self):
        self.assertEqual(E.get("opencode").min_version, (1, 18, 0))
        self.assertEqual(E.min_version_text("opencode"), "1.18.0")
        self.assertEqual(E.min_version_text("claude"), "")

    def test_first_new_enough_copy_wins_over_an_older_one_in_front(self):
        old, new = self.fake("a", "1.14.31"), self.fake("b", "1.18.32")
        r = self.pick()
        self.assertEqual((r["path"], r["version"], r["supported"]), (new, "1.18.32", True))
        self.assertEqual([c["path"] for c in r["candidates"]], [old, new])

    def test_first_of_several_new_enough_copies(self):
        first, _ = self.fake("a", "1.18.0"), self.fake("b", "1.19.4")
        self.assertEqual(self.pick()["path"], first)

    def test_all_older_gives_the_newest_and_says_unsupported(self):
        self.fake("a", "1.14.31")
        newest = self.fake("b", "1.17.9")
        self.fake("c", "1.2.0")
        r = self.pick()
        self.assertEqual((r["path"], r["version"], r["supported"]), (newest, "1.17.9", False))

    def test_a_copy_that_prints_no_version_is_never_picked_over_one_that_does(self):
        self.fake("a", "nonsense")
        good = self.fake("b", "1.18.1")
        self.assertEqual(self.pick()["path"], good)

    def test_not_installed(self):
        r = self.pick()
        self.assertEqual((r["path"], r["supported"], r["candidates"]), ("", False, []))

    def test_a_symlink_to_the_same_file_is_one_candidate(self):
        real = self.fake("a", "1.18.32")
        os.symlink(real, os.path.join(self.tmp, "b", "opencode"))
        self.assertEqual(len(self.pick()["candidates"]), 1)

    def test_engine_without_minimum_takes_the_first_copy(self):
        _exe(os.path.join(self.tmp, "a", "codex"), "#!/bin/sh\necho 0.1.0\n")
        _exe(os.path.join(self.tmp, "b", "codex"), "#!/bin/sh\necho 9.9.9\n")
        r = E.pick(E.get("codex"), self.env)
        self.assertEqual((r["path"], r["supported"]), (os.path.join(self.tmp, "a", "codex"), True))

    def test_status_reports_the_minimum_and_whether_it_is_met(self):
        self.fake("a", "1.14.31")
        with mock.patch.dict(os.environ, self.env):
            row = E.status(E.get("opencode"), "1.18.32")
            self.assertEqual((row["version"], row["min_version"], row["supported"]), ("1.14.31", "1.18.0", False))
            self.assertTrue(row["update_available"])
            self.fake("b", "1.18.32")
            row = E.status(E.get("opencode"), "1.18.32")
            self.assertEqual((row["version"], row["supported"]), ("1.18.32", True))
            self.assertEqual(E.status(E.get("claude"), "")["min_version"], "")

    def test_status_does_not_call_a_copy_too_old_when_its_version_does_not_answer(self):
        self.fake("a", "1.18.35")
        with mock.patch.dict(os.environ, self.env), mock.patch.object(E, "installed_version", return_value=""):
            row = E.status(E.get("opencode"), "")
        self.assertEqual((row["installed"], row["version"], row["supported"]), (True, "", True))

    def test_offline_list_never_asks_npm(self):
        with mock.patch.object(E, "_fetch_latest", side_effect=AssertionError("asked npm")), \
                mock.patch.object(E, "CACHE", os.path.join(self.tmp, "none.json")), mock.patch.dict(os.environ, self.env):
            rows = E.engines(only="opencode", offline=True)
        self.assertEqual(rows[0]["latest"], "")

    def test_version_is_asked_once_per_file_and_again_after_it_changes(self):
        path = self.fake("a", "1.14.31")
        self.assertEqual(E.installed_version(path), "1.14.31")
        with mock.patch.object(E.subprocess, "run", side_effect=AssertionError("ran twice")):
            self.assertEqual(E.installed_version(path), "1.14.31")
        self.fake("a", "1.18.32\n# newer file")
        self.assertEqual(E.installed_version(path), "1.18.32")

    def test_version_is_remembered_on_disk_for_the_next_process(self):
        path = self.fake("b", "1.18.40")
        with mock.patch.dict(os.environ, {"DISPATCH_DIR": self.tmp}):
            self.assertEqual(E.installed_version(path), "1.18.40")
            E._VERSION_CACHE.clear()  # what a new `dispatch` process starts with
            with mock.patch.object(E.subprocess, "run", side_effect=AssertionError("asked again")):
                self.assertEqual(E.installed_version(path), "1.18.40")
                self.assertIn("1.18.40", E.version_output(path))
            E._VERSION_CACHE.clear()
            with mock.patch.object(E.time, "time", return_value=time.time() + E.VERSION_TTL + 1):
                self.assertEqual(E.installed_version(path), "1.18.40")  # stale: asked again, the file answers
            E.forget_versions()
            self.assertFalse(os.path.exists(os.path.join(self.tmp, "engines-versions.json")))
            no_answer = _exe(os.path.join(self.tmp, "c", "opencode"), "#!/bin/sh\necho nothing\n")
            self.assertEqual(E.installed_version(no_answer), "")
            self.assertNotIn(no_answer, E._read_versions())  # an answer without a version is asked again next time


class SearchPath(unittest.TestCase):
    def test_ide_bin_comes_first(self):
        tmp = tempfile.mkdtemp()
        env = {"DISPATCH_IDE_BIN": tmp, "PATH": "/usr/bin:/bin"}
        dirs = E.search_path(env).split(os.pathsep)
        self.assertEqual(dirs[0], tmp)
        self.assertIn("/usr/bin", dirs)
        self.assertEqual(len(dirs), len(set(dirs)))

    def test_missing_ide_bin_is_skipped(self):
        dirs = E.search_path({"DISPATCH_IDE_BIN": "/nonexistent/bin", "PATH": "/usr/bin"}).split(os.pathsep)
        self.assertNotIn("/nonexistent/bin", dirs)


if __name__ == "__main__":
    unittest.main()


class EnabledSaysWhatIsHere(unittest.TestCase):
    """task-6vw2: the Agents window starts a new session on `effective` and offers only the agents in `installed`."""

    def test_only_opencode_here(self):
        tmp = tempfile.mkdtemp()
        _exe(os.path.join(tmp, "bin", "opencode"), "#!/bin/sh\necho 1.18.0\n")
        with mock.patch.object(E, "search_path", lambda env=None: os.path.join(tmp, "bin")):
            got = E.installed_and_default({"off": [], "on": [], "default": "", "saved": False})
            self.assertEqual(got, {"installed": ["opencode"], "effective": "opencode"})
            # a saved default that is not here gives way to one that is
            self.assertEqual(E.installed_and_default({"off": [], "on": [], "default": "claude"})["effective"], "opencode")
            self.assertEqual(E.installed_and_default({"off": ["opencode"], "on": [], "default": ""})["effective"], "")

    def test_nothing_here(self):
        tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(tmp, "bin"))
        with mock.patch.object(E, "search_path", lambda env=None: os.path.join(tmp, "bin")):
            self.assertEqual(E.installed_and_default({"off": [], "on": [], "default": ""}), {"installed": [], "effective": ""})


class ClaudeAnswer(unittest.TestCase):
    """`claude -p` that cannot answer prints why on stdout: that must not come back as the answer (a branch named
    agents/you-ve-hit-your-weekly-limit, task-970qq)."""

    def run_with(self, code, stdout):
        done = subprocess.CompletedProcess([], code, stdout=stdout, stderr="")
        with mock.patch("subprocess.run", return_value=done):
            return E.get("claude").answer("/bin/claude", "You name git branches.", "Add a greet function")

    def test_an_answer_comes_back(self):
        self.assertEqual(self.run_with(0, "add-greet-function\n"), "add-greet-function")

    def test_a_usage_limit_is_a_failure_not_an_answer(self):
        for code, text in ((1, "You've hit your weekly limit · resets Oct 11, 11pm (Europe/Berlin)"),
                           (0, "You’ve hit your session limit · resets 5pm"),
                           (1, "Claude AI usage limit reached|1791400000")):
            with self.assertRaises(RuntimeError) as e:
                self.run_with(code, text)
            self.assertIn("limit", str(e.exception))

    def test_a_failed_run_with_words_on_stdout_fails(self):
        with self.assertRaises(RuntimeError):
            self.run_with(1, "Error: something else went wrong")
