# -*- coding: utf-8 -*-
"""dispatch ide instance / e2e (ide_e2e.py): the instance record, stop ending only the instance's own
processes, and the focus rule type() checks before it types (app/scripts/ide-e2e/focus.mjs)."""
import sys

sys.dont_write_bytecode = True

import json
import os
import plistlib
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import ide_e2e as E  # noqa: E402
import types
from unittest.mock import patch

# A stand-in for Dispatch IDE: its command line starts with the app's binary (exec -a) and carries
# the arguments, and a child answers the CDP port's /json/list like the real app.
FAKE_BIN = r"""#!/bin/bash
port=""; ud=""; prev=""
for a in "$@"; do
  case "$a" in --remote-debugging-port=*) port="${a#*=}" ;; esac
  [ "$prev" = "--user-data-dir" ] && ud="$a"
  prev="$a"
done
mkdir -p "$ud/json"
printf '%s\n' "$@" > "$ud/argv.txt"
env > "$ud/env.txt"
echo '[{"type":"page","title":"Dispatch Agent","url":"vscode-file://vscode-app/x/out/vs/sessions/electron-browser/sessions.html"}]' > "$ud/json/list"
if [ -n "$port" ]; then
  python3 -m http.server "$port" --bind 127.0.0.1 --directory "$ud" >/dev/null 2>&1 &
fi
exec -a "$0" /usr/bin/perl -e 'sleep 120' -- "$@"
"""


def make_fake_app(base, name="Fake IDE.app"):
    app = os.path.join(base, name)
    os.makedirs(os.path.join(app, "Contents", "MacOS"))
    with open(os.path.join(app, "Contents", "Info.plist"), "wb") as f:
        plistlib.dump({"CFBundleExecutable": "Fake IDE"}, f)
    exe = os.path.join(app, "Contents", "MacOS", "Fake IDE")
    with open(exe, "w") as f:
        f.write(FAKE_BIN)
    os.chmod(exe, 0o755)
    res = os.path.join(app, "Contents", "Resources", "app")
    os.makedirs(os.path.join(res, "extensions", "dispatch-bridge"))
    with open(os.path.join(res, "product.json"), "w") as f:
        json.dump({"version": "1.0.0-test", "commit": "abc"}, f)
    # the app's own Codex, found first by everything the instance runs: a start has the instance's Codex trust the
    # build's hook entry, and without one of its own it started this machine's real `codex app-server`
    tools = os.path.join(res, "tools")
    os.makedirs(tools)
    with open(os.path.join(tools, "codex"), "w") as f:
        f.write("#!/bin/sh\nexit 1\n")
    os.chmod(os.path.join(tools, "codex"), 0o755)
    return app


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


class Env(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ide-e2e-test-")
        p = patch.dict(os.environ, {"DISPATCH_E2E_SHOW": "1"})  # the fake app has no inspector to hide windows through
        p.start()
        self.addCleanup(p.stop)
        self.old = {k: os.environ.get(k) for k in ("DISPATCH_HOME", "DISPATCH_E2E_ROOT", "DISPATCH_BUILDS", "CODEX_HOME")}
        os.environ["DISPATCH_HOME"] = os.path.join(self.tmp, "home")
        os.environ["CODEX_HOME"] = os.path.join(self.tmp, "codex")  # the "real" Codex login a start links in
        os.makedirs(os.environ["CODEX_HOME"])
        with open(os.path.join(os.environ["CODEX_HOME"], "auth.json"), "w") as f:
            f.write("{}")
        os.environ["DISPATCH_E2E_ROOT"] = os.path.join(self.tmp, "e2e")
        os.environ["DISPATCH_BUILDS"] = os.path.join(self.tmp, "builds")

    def tearDown(self):
        for k, v in self.old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)


class RecordTest(Env):
    def test_record_round_trip_under_dispatch_home(self):
        rec = {"name": "e2e", "pid": 123, "port": 5555, "app": "/x.app"}
        p = E.write_record(rec)
        self.assertEqual(p, os.path.join(self.tmp, "home", "state", "instances", "e2e.json"))
        self.assertEqual(E.read_record("e2e"), rec)

    def test_instance_env_keeps_picks_out_of_the_users_facts(self):
        rec = {"name": "e2e", "root": "/tmp/dide-e2e/e2e", "beads_dir": "/tmp/dide-e2e/e2e/board/.beads", "dispatch_dir": "/tmp/dide-e2e/e2e/dispatch",
               "dispatch_home": "/tmp/dide-e2e/e2e/dispatch-home", "cli": "/tmp/dide-e2e/e2e/cli/app/cli/dispatch.py", "app": "/nope/Dispatch IDE.app"}
        env = E.instance_env(rec, {"PATH": "/usr/bin", "DISPATCH_FACTS_FILE": "/Users/me/.agents/rules/FACTS.md", "BEADS_DIR": "/Users/me/tasks/.beads"})
        self.assertEqual(env["DISPATCH_FACTS_FILE"], "/tmp/dide-e2e/e2e/rules/FACTS.md")
        self.assertEqual(env["BEADS_DIR"], "/tmp/dide-e2e/e2e/board/.beads")
        # the instance's terminal keeps its own Codex, OpenCode and config folders over a ~/.zshrc that sets them
        # (task-o5j7f); BEADS_DIR and DISPATCH_* it keeps anyway
        self.assertEqual(env["DISPATCH_TERMINAL_KEEP"].split(), ["CODEX_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"])

    def test_a_claude_test_token_runs_claude_code_in_the_instance_on_haiku(self):
        root = os.path.join(self.tmp, "dide", "e2e")
        rec = {"name": "e2e", "root": root, "beads_dir": root + "/board/.beads", "dispatch_dir": root + "/dispatch",
               "dispatch_home": root + "/dispatch-home", "cli": root + "/cli/app/cli/dispatch.py", "app": "/nope/Dispatch IDE.app"}
        base = {"PATH": "/usr/bin", E.CLAUDE_TOKEN: "tok-123", "CLAUDE_CODE_OAUTH_TOKEN": "the-persons", "CLAUDE_CONFIG_DIR": "/Users/me/.claude"}
        env = E.instance_env(rec, base)
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], os.path.join(root, "claude-home"))
        self.assertEqual(env["CLAUDE_CODE_OAUTH_TOKEN"], "tok-123")
        self.assertEqual(env["ANTHROPIC_MODEL"], "haiku")
        self.assertNotIn(E.CLAUDE_TOKEN, env)  # only under Claude Code's own name
        home = E.prepare_claude_home(rec, base)
        with open(os.path.join(home, ".claude.json")) as f:
            self.assertTrue(json.load(f)["hasCompletedOnboarding"])
        with open(os.path.join(home, "settings.json")) as f:
            self.assertEqual(json.load(f), {"model": "haiku"})
        self.assertNotIn("tok-123", open(os.path.join(home, ".claude.json")).read() + open(os.path.join(home, "settings.json")).read())
        # without one, Claude Code is the person's own and nothing is made
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", E.instance_env(rec, {"PATH": "/usr/bin"}))
        self.assertEqual(E.prepare_claude_home(dict(rec, root=root + "2"), {"PATH": "/usr/bin"}), "")

    def test_codex_runs_on_the_cheap_test_model(self):
        text = 'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n\n[projects."/x"]\nmodel = "keep"\n'
        out = E.codex_test_config(text, "gpt-6-luna", "low")
        self.assertEqual(out, 'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n\n[projects."/x"]\nmodel = "keep"\n')
        self.assertEqual(E.codex_test_config('[a]\nx = 1\n', "m", "low"), 'model = "m"\nmodel_reasoning_effort = "low"\n[a]\nx = 1\n')

    def test_an_old_folder_that_cannot_be_removed_yet_is_moved_aside(self):
        root = os.path.join(self.tmp, "dide", "suite")
        os.makedirs(os.path.join(root, "codex-home"))
        open(os.path.join(root, "codex-home", "state.sqlite"), "w").close()
        real = shutil.rmtree
        with patch.object(E.shutil, "rmtree", side_effect=OSError(66, "Directory not empty")), patch.object(E.time, "sleep"):
            E.clear_folder(root)
        self.assertFalse(os.path.exists(root))  # the new instance gets its folder
        aside = [n for n in os.listdir(os.path.dirname(root)) if n.startswith("suite.old-")]
        self.assertEqual(len(aside), 1)
        os.makedirs(root)
        E.clear_folder(root)  # the next start clears what was left
        self.assertEqual(os.listdir(os.path.dirname(root)), [])
        self.assertIs(E.shutil.rmtree, real)

    def test_stop_also_ends_what_runs_with_the_instances_environment(self):
        rec = {"name": "suite", "root": "/tmp/dide-e2e/suite"}
        me = os.getpid()
        rows = [(101, 1, "python3 /Users/me/kanban/app/cli/dispatch.py chatd run"), (102, 1, "python3 other.py"),
                (103, 1, "bd list"), (me, 1, "python3 ide_e2e.py instance stop suite")]
        ps = "\n".join([
            "101 python3 /Users/me/kanban/app/cli/dispatch.py chatd run HOME=/Users/me DISPATCH_E2E_INSTANCE=suite DISPATCH_DIR=/tmp/dide-e2e/suite/dispatch",
            "102 python3 other.py DISPATCH_E2E_INSTANCE=suite2 DISPATCH_DIR=/tmp/dide-e2e/suite2/dispatch",
            "103 bd list DISPATCH_E2E_INSTANCE=suite HOME=/Users/me",
            "%d python3 ide_e2e.py instance stop suite DISPATCH_E2E_INSTANCE=suite DISPATCH_DIR=/tmp/dide-e2e/suite/dispatch" % me])
        done = subprocess.CompletedProcess([], 0, stdout=ps, stderr="")
        with patch.object(E.subprocess, "run", return_value=done):
            got = E.env_victims(rec, rows, me=me)
        self.assertEqual([p for p, _ in got], [101])  # another instance, no folder of this one, and the caller are left

    def test_a_fixture_can_take_folders_off_the_instances_path(self):
        rec = {"name": "e2e", "root": "/tmp/dide-e2e/e2e", "beads_dir": "/tmp/dide-e2e/e2e/board/.beads", "dispatch_dir": "/tmp/dide-e2e/e2e/dispatch",
               "dispatch_home": "/tmp/dide-e2e/e2e/dispatch-home", "cli": "/tmp/dide-e2e/e2e/cli/app/cli/dispatch.py", "app": "/nope/Dispatch IDE.app",
               "fixture_env": {"HOME": "/tmp/dide-e2e/e2e/ocv-home", "PATH_DROP": "/Users/me/.opencode/bin:/Users/me/.local/bin/", "PATH_PREPEND": "/tmp/x"}}
        env = E.instance_env(rec, {"PATH": "/Users/me/.opencode/bin:/usr/bin:/Users/me/.local/bin:/bin"})
        self.assertEqual(env["PATH"].split(":")[0], "/tmp/x")
        self.assertNotIn("/Users/me/.opencode/bin", env["PATH"].split(":"))
        self.assertNotIn("/Users/me/.local/bin", env["PATH"].split(":"))
        self.assertIn("/usr/bin", env["PATH"].split(":"))
        self.assertEqual(env["HOME"], "/tmp/dide-e2e/e2e/ocv-home")
        self.assertNotIn("PATH_DROP", env)

    def test_opencode_loads_the_builds_plugin_and_runs_the_builds_cli(self):
        root = os.path.join(self.tmp, "inst")
        cli = os.path.join(root, "cli", "app", "cli", "dispatch.py")
        rec = dict(instance_rec(root), cli=cli, bin_dir=os.path.join(root, "bin"))
        self.assertNotIn("OPENCODE_CONFIG_CONTENT", E.instance_env(rec, {"PATH": "/usr/bin"}))  # no plugin in this build
        plugin = os.path.join(root, "cli", "agent", "opencode", "dispatch.js")
        for f in (cli, plugin):
            os.makedirs(os.path.dirname(f), exist_ok=True)
            open(f, "w").close()
        env = E.instance_env(rec, {"PATH": "/usr/bin", "DISPATCH_CLI": "/Users/me/.local/bin/dispatch",
                                   "OPENCODE_CONFIG_CONTENT": '{"model": "a/b", "plugin": ["x"]}'})
        cfg = json.loads(env["OPENCODE_CONFIG_CONTENT"])
        server = cfg.pop("mcp")["dispatch"]
        self.assertEqual(cfg, {"model": "a/b", "plugin": ["x", "file://" + plugin]})
        self.assertEqual(server["command"][1:], [cli, "mcp", "serve", "--agent", "opencode"])
        self.assertEqual(env["DISPATCH_CLI"], os.path.join(root, "bin", "dispatch"))
        self.assertEqual(json.loads(E.opencode_config_content(plugin, "not json")), {"plugin": ["file://" + plugin]})

    def test_missing_record_and_bad_names(self):
        with self.assertRaises(E.E2EError) as c:
            E.read_record("nope")
        self.assertEqual(c.exception.code, "no_instance")
        for bad in ("../x", "a/b", "", "-x"):
            with self.assertRaises(E.E2EError):
                E.check_name(bad)

    def test_latest_build_takes_the_newest_ok(self):
        base = os.environ["DISPATCH_BUILDS"]
        for name, status, t in (("old", "ok 200", 1000), ("new", "ok 210", 2000), ("broken", "failed 1 20", 3000)):
            d = os.path.join(base, name)
            os.makedirs(os.path.join(d, "Dispatch IDE.app"))
            with open(os.path.join(d, "status"), "w") as f:
                f.write(status)
            os.utime(os.path.join(d, "status"), (t, t))
        self.assertEqual(E.latest_build(), os.path.join(base, "new", "Dispatch IDE.app"))


def instance_rec(root, folder=""):
    return {"name": "e2e", "root": root, "beads_dir": root + "/board/.beads", "dispatch_dir": root + "/dispatch",
            "dispatch_home": root + "/dispatch-home", "cli": root + "/cli/app/cli/dispatch.py", "app": "/nope/Dispatch IDE.app",
            "user_data_dir": root + "/user-data", "agents_user_data_dir": root + "/agents-user-data", "folder": folder}


# What the caller's shell may carry: the variables point at the real user's data.
REAL = {"PATH": "/usr/bin:/bin", "HOME": "/Users/me", "CODEX_HOME": "/Users/me/.codex",
        "DISPATCH_IDE_USER_DATA_DIRS": "/Users/me/Library/Application Support/Dispatch IDE", "DISPATCH_SESSION_ROOT": "/Users/me"}


def claude_record(cwd, text, stamp):
    return {"type": "user", "cwd": cwd, "timestamp": stamp, "message": {"role": "user", "content": text}}


def codex_records(sid, cwd, text, stamp):
    return [{"timestamp": stamp, "type": "session_meta", "payload": {"id": sid, "cwd": cwd}},
            {"timestamp": stamp, "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}}]


def write_jsonl(path, records):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        for r in records:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")  # compact, as Claude Code and Codex write it


# Runs in a child process with the instance's environment: what the instance's CLI would list.
LIST_SESSIONS = r"""
import json, os, sys, time
sys.path.insert(0, sys.argv[1])
from contextlib import closing
import dispatch, ide_sessions
from activity import activity_list, connect
with closing(connect(dispatch.DISPATCH_DIR)) as db, db:
    db.execute("UPDATE settings SET value=? WHERE key='started_at'", (time.time() - 100,))
dispatch.refresh_index()
print(json.dumps({
    "apps": [p for _, p in ide_sessions.apps()],
    "rows": sorted(r["cwd"] for r in activity_list(dispatch.HOME, dispatch.DISPATCH_DIR, dispatch.load_index())),
    "index": sorted(e["cwd"] for e in dispatch.load_index().values()),
}))
"""


class InstanceIsolationTest(unittest.TestCase):
    """The instance never lists the real user's sessions: the Agents window catalog is the instance's
    own, and only sessions working under the instance folder count. Claude Code keeps its real config
    folder (and login); Codex gets its own CODEX_HOME with the real login linked in."""

    ROOT = "/tmp/dide-e2e/e2e"

    def env(self, base=REAL, folder=""):
        return E.instance_env(instance_rec(self.ROOT, folder), dict(base))

    def test_ide_user_data_dirs_are_the_instances_two_windows(self):
        for base in (REAL, {"PATH": "/usr/bin", "HOME": "/Users/me"}):
            env = self.env(base)
            self.assertEqual(env["DISPATCH_IDE_USER_DATA_DIRS"].split(os.pathsep), [self.ROOT + "/user-data", self.ROOT + "/agents-user-data"])

    def test_session_root_is_the_instance(self):
        self.assertEqual(self.env()["DISPATCH_SESSION_ROOT"], self.ROOT)
        self.assertEqual(self.env(folder=self.ROOT + "/projects/demo")["DISPATCH_SESSION_ROOT"], self.ROOT)
        # a --folder outside the instance is the tester's choice: its sessions are listed too
        self.assertEqual(self.env(folder="/Users/me/Projects/x")["DISPATCH_SESSION_ROOT"].split(os.pathsep), [self.ROOT, "/Users/me/Projects/x"])

    def test_claude_keeps_its_login_codex_and_opencode_get_their_own_folders(self):
        env = self.env({"PATH": "/usr/bin", "HOME": "/Users/me", "CLAUDE_CONFIG_DIR": "/Users/me/.claude-work", "XDG_DATA_HOME": "/Users/me/.local/share"})
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], "/Users/me/.claude-work")  # the caller's own, untouched
        self.assertEqual(env["HOME"], "/Users/me")
        self.assertNotIn("CLAUDE_CONFIG_DIR", self.env())
        self.assertEqual(self.env()["CODEX_HOME"], self.ROOT + "/codex-home")
        # task-ug3f: OpenCode's sessions (opencode.db) went to the person's own ~/.local/share/opencode
        self.assertEqual(env["XDG_DATA_HOME"], self.ROOT + "/xdg-data")
        self.assertEqual(self.env()["XDG_DATA_HOME"], self.ROOT + "/xdg-data")
        import opencode_engine
        self.assertEqual(opencode_engine.paths(env)["data"], self.ROOT + "/xdg-data/opencode")

    def test_the_key_store_is_never_linked_into_an_instance(self):
        # 10-08: the person's whole ~/.config/dispatch (keys, signing identity) was gone; every instance's xdg-config
        # held a link to it, so anything cleaning that folder could reach the keys. Dispatch reads it through HOME.
        tmp = tempfile.mkdtemp(prefix="ide-e2e-xdgk-")
        self.addCleanup(shutil.rmtree, tmp, True)
        real = os.path.join(tmp, "config")
        for d in ("dispatch", "git", "opencode"):
            os.makedirs(os.path.join(real, d))
        rec = instance_rec(os.path.join(tmp, "e2e"))
        E.link_xdg_config(rec, real, data_dir=os.path.join(tmp, "data"))
        home = E.session_env(rec)["XDG_CONFIG_HOME"]
        self.assertFalse(os.path.lexists(os.path.join(home, "dispatch")))
        self.assertEqual(os.readlink(os.path.join(home, "git")), os.path.join(real, "git"))

    def test_opencode_config_without_third_party_plugins(self):
        # 10-06: the person's oh-my-openagent plugin ran in the instance and wrote every test session into the
        # real ~/.claude/transcripts. The instance's OpenCode reads their config without any plugin.
        tmp = tempfile.mkdtemp(prefix="ide-e2e-xdgc-")
        self.addCleanup(shutil.rmtree, tmp, True)
        real = os.path.join(tmp, "config")
        oc = os.path.join(real, "opencode")
        for d in ("plugins", "node_modules", "skills/theirs", os.path.join("..", "git"), os.path.join("..", "gh")):
            os.makedirs(os.path.join(oc, d), exist_ok=True)
        # a mount an earlier test instance left in their folder: it points into the e2e root
        e2e_root = os.path.join(tmp, "e2e-root")
        p = patch.dict(os.environ, {"DISPATCH_E2E_ROOT": e2e_root})
        p.start()
        self.addCleanup(p.stop)
        os.makedirs(os.path.join(e2e_root, "old", "skills", "x"))
        os.symlink(os.path.join(e2e_root, "old", "skills", "x"), os.path.join(oc, "skills", "left-by-a-test"))
        with open(os.path.join(oc, "opencode.json"), "w") as f:
            f.write('{\n  // their own\n  "plugin": ["oh-my-openagent@latest", "/x/claude-mem.js"],\n  "model": "deepseek/flash",\n  "provider": {"deepseek": {}},\n}\n')
        for fn in ("AGENTS.md", "package.json", "tui.json"):
            with open(os.path.join(oc, fn), "w") as f:
                f.write("{}")
        rec = instance_rec(os.path.join(tmp, "e2e"))
        E.link_xdg_config(rec, real, data_dir=os.path.join(tmp, "data"))
        home = E.session_env(rec)["XDG_CONFIG_HOME"]
        self.assertEqual(home, rec["root"] + "/xdg-config")
        for tool in ("git", "gh"):
            self.assertEqual(os.readlink(os.path.join(home, tool)), os.path.join(real, tool))
        mine = os.path.join(home, "opencode")
        self.assertFalse(os.path.islink(mine))
        # installed packages stay linked (a package loads only when listed); the plugin folder does not come along
        self.assertEqual(sorted(os.listdir(mine)), ["AGENTS.md", "node_modules", "opencode.json", "package.json", "skills", "tui.json"])
        # the skills folder is the instance's own, with a link to each of theirs: a skill mounted in the instance stays there
        self.assertFalse(os.path.islink(os.path.join(mine, "skills")))
        self.assertEqual(os.readlink(os.path.join(mine, "skills", "theirs")), os.path.join(oc, "skills", "theirs"))
        self.assertNotIn("left-by-a-test", os.listdir(os.path.join(mine, "skills")))
        os.symlink("/tmp/pool/new-skill", os.path.join(mine, "skills", "new-skill"))
        self.assertEqual(sorted(os.listdir(os.path.join(oc, "skills"))), ["left-by-a-test", "theirs"])
        with open(os.path.join(mine, "opencode.json")) as f:
            cfg = json.load(f)
        # their providers stay; the test sessions start on a free model (no login in this data folder)
        free = "opencode/mimo-v2.6-flash-free"
        self.assertEqual(cfg, {"model": free, "small_model": free, "provider": {"deepseek": {}}})
        with open(os.path.join(oc, "opencode.json")) as f:
            self.assertIn("oh-my-openagent", f.read())  # the person's own stays as it was
        import opencode_engine
        env = E.instance_env(rec, {"PATH": "/usr/bin", "HOME": "/Users/me"})
        self.assertEqual(opencode_engine.paths(env)["config"], mine)

    def test_cheap_opencode_model_follows_the_logins(self):
        tmp = tempfile.mkdtemp(prefix="ide-e2e-cheap-")
        self.addCleanup(shutil.rmtree, tmp, True)
        os.makedirs(os.path.join(tmp, "opencode"))
        auth = os.path.join(tmp, "opencode", "auth.json")
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DISPATCH_E2E_OPENCODE_MODEL", None)
            self.assertEqual(E.cheap_opencode_model(tmp), "opencode/mimo-v2.6-flash-free")
            with open(auth, "w") as f:
                json.dump({"deepseek": {"type": "api"}, "anthropic": {}}, f)
            self.assertEqual(E.cheap_opencode_model(tmp), "deepseek/deepseek-flash")
            with open(auth, "w") as f:
                json.dump({"deepseek": {}, "zhipuai-coding-plan": {}}, f)
            self.assertEqual(E.cheap_opencode_model(tmp), "zhipuai-coding-plan/glm-5.3-flash")
            os.environ["DISPATCH_E2E_OPENCODE_MODEL"] = "opencode/big-pickle"
            self.assertEqual(E.cheap_opencode_model(tmp), "opencode/big-pickle")

    def test_no_opencode_config_still_gets_the_cheap_model(self):
        tmp = tempfile.mkdtemp(prefix="ide-e2e-xdgn-")
        self.addCleanup(shutil.rmtree, tmp, True)
        rec = instance_rec(os.path.join(tmp, "e2e"))
        os.makedirs(os.path.join(tmp, "config"))
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DISPATCH_E2E_OPENCODE_MODEL", None)
            E.link_xdg_config(rec, os.path.join(tmp, "config"), data_dir=os.path.join(tmp, "data"))
        with open(os.path.join(E.session_env(rec)["XDG_CONFIG_HOME"], "opencode", "opencode.json")) as f:
            self.assertEqual(json.load(f)["model"], "opencode/mimo-v2.6-flash-free")

    def test_opencode_login_is_linked_from_the_real_data_folder(self):
        tmp = tempfile.mkdtemp(prefix="ide-e2e-xdg-")
        self.addCleanup(shutil.rmtree, tmp, True)
        real = os.path.join(tmp, "share")
        os.makedirs(os.path.join(real, "opencode", "storage"))
        os.makedirs(os.path.join(real, "opencode", "bin"))
        os.makedirs(os.path.join(real, "claude", "versions"))
        os.makedirs(os.path.join(real, "mise", "installs"))
        for fn in ("auth.json", "opencode.db"):
            with open(os.path.join(real, "opencode", fn), "w") as f:
                f.write(fn)
        rec = instance_rec(os.path.join(tmp, "e2e"))
        made = E.link_xdg_data(rec, real)
        data = E.session_env(rec)["XDG_DATA_HOME"]
        self.assertEqual(sorted(made), [os.path.join(data, "claude"), os.path.join(data, "mise"),
                                        os.path.join(data, "opencode", "auth.json"), os.path.join(data, "opencode", "bin")])
        self.assertEqual(os.readlink(os.path.join(data, "opencode", "auth.json")), os.path.join(real, "opencode", "auth.json"))
        self.assertFalse(os.path.islink(os.path.join(data, "opencode")))
        for own in ("opencode.db", "storage"):  # the sessions stay out of the person's store
            self.assertFalse(os.path.exists(os.path.join(data, "opencode", own)))
        self.assertEqual(E.link_xdg_data(rec, real), [])

    def test_codex_login_is_linked_from_the_real_codex_home(self):
        tmp = tempfile.mkdtemp(prefix="ide-e2e-codex-")
        self.addCleanup(shutil.rmtree, tmp, True)
        real = os.path.join(tmp, "real-codex")
        os.makedirs(real)
        for fn in ("auth.json", "config.toml"):
            with open(os.path.join(real, fn), "w") as f:
                f.write(fn)
        rec = instance_rec(os.path.join(tmp, "e2e"))
        made = E.link_codex_login(rec, real)
        home = E.session_env(rec)["CODEX_HOME"]
        self.assertEqual(sorted(made), [os.path.join(home, "auth.json"), os.path.join(home, "config.toml")])
        self.assertTrue(os.path.islink(os.path.join(home, "auth.json")))
        self.assertEqual(os.readlink(os.path.join(home, "auth.json")), os.path.join(real, "auth.json"))
        # config.toml is a copy: what Codex writes into it stays in the instance
        self.assertFalse(os.path.islink(os.path.join(home, "config.toml")))
        # a copy, on the cheap test model
        self.assertEqual(open(os.path.join(home, "config.toml")).read(), 'config.toml\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n')
        self.assertEqual(E.link_codex_login(rec, real), [])  # a second start leaves the links alone
        # nothing to link: nothing made, no dangling link
        rec2 = instance_rec(os.path.join(tmp, "e2e2"))
        self.assertEqual(E.link_codex_login(rec2, os.path.join(tmp, "no-codex")), [])
        self.assertEqual(os.listdir(E.session_env(rec2)["CODEX_HOME"]), [])

    def test_cli_shim_restores_instance_scope_after_login_shell_overrides(self):
        with tempfile.TemporaryDirectory(prefix="ide-e2e-shim-") as root:
            rec = instance_rec(root)
            cli = os.path.join(root, "read-env.py")
            with open(cli, "w") as f:
                f.write("import os,json; print(json.dumps(dict(os.environ)))")
            shim = os.path.join(E.write_cli_shim(root, cli, rec), "dispatch")
            env = dict(os.environ, BEADS_DIR="/wrong/board", DISPATCH_HOME="/wrong/home",
                       CODEX_HOME="/wrong/codex", DISPATCH_SESSION_ID="engine-native-current")
            got = json.loads(subprocess.check_output([shim], env=env, text=True))
            self.assertEqual(got["BEADS_DIR"], rec["beads_dir"])
            self.assertEqual(got["DISPATCH_HOME"], rec["dispatch_home"])
            self.assertEqual(got["CODEX_HOME"], root + "/codex-home")
            self.assertEqual(got["DISPATCH_SESSION_ID"], "engine-native-current")

    def test_agents_window_external_sessions_outside_the_root_are_left_out(self):
        import ide_sessions
        from unittest import mock
        with mock.patch.dict(os.environ, {"DISPATCH_SESSION_ROOT": self.ROOT}):
            self.assertTrue(ide_sessions.outside_session_root({"external": True, "cwd": "/Users/me/Projects/real"}))
            self.assertFalse(ide_sessions.outside_session_root({"external": True, "cwd": self.ROOT + "/projects/demo"}))
            self.assertFalse(ide_sessions.outside_session_root({"external": False, "cwd": "/Users/me/Projects/real"}))
        with mock.patch.dict(os.environ, {"DISPATCH_SESSION_ROOT": ""}):
            self.assertFalse(ide_sessions.outside_session_root({"external": True, "cwd": "/Users/me/Projects/real"}))

    def test_cli_in_the_instance_lists_only_sessions_under_the_instance(self):
        """A fake real home with a Claude and a Codex session working elsewhere and a Claude session
        working in the instance's demo project, plus a Codex session in the instance's CODEX_HOME: the
        CLI with the instance's environment lists and indexes only the two under the instance; without
        the session root (the control) it lists the real ones too."""
        tmp = tempfile.mkdtemp(prefix="ide-e2e-iso-")
        self.addCleanup(shutil.rmtree, tmp, True)
        home, root = os.path.join(tmp, "home"), os.path.join(tmp, "e2e")
        elsewhere, demo = os.path.join(home, "Projects", "real"), os.path.join(root, "projects", "demo")
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        flat = lambda p: "".join(c if c.isalnum() else "-" for c in p)
        write_jsonl(os.path.join(home, ".claude", "projects", flat(elsewhere), "real-claude.jsonl"), [claude_record(elsewhere, "a real session", stamp)])
        write_jsonl(os.path.join(home, ".claude", "projects", flat(demo), "inst-claude.jsonl"), [claude_record(demo, "an instance session", stamp)])
        write_jsonl(os.path.join(home, ".codex", "sessions", "2026", "09", "28", "rollout-real.jsonl"), codex_records("real-codex", elsewhere, "real codex", stamp))
        rec = instance_rec(root)
        codex_home = E.session_env(rec)["CODEX_HOME"]
        write_jsonl(os.path.join(codex_home, "sessions", "2026", "09", "28", "rollout-inst.jsonl"), codex_records("inst-codex", demo, "instance codex", stamp))
        base = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home}

        def listed(env):
            r = subprocess.run([sys.executable, "-c", LIST_SESSIONS, HERE], env=env, capture_output=True, text=True, timeout=120)
            self.assertEqual(r.returncode, 0, r.stderr)
            return json.loads(r.stdout.strip().splitlines()[-1])

        out = listed(E.instance_env(rec, base))
        self.assertEqual(out["apps"], [root + "/user-data", root + "/agents-user-data"])
        self.assertEqual(out["rows"], [demo, demo])
        self.assertEqual(out["index"], [demo, demo])
        # control: the same home without the session root lists the real sessions (the fixtures are valid ones)
        control = E.instance_env(rec, base)
        control.pop("DISPATCH_SESSION_ROOT")
        control["DISPATCH_DIR"] = os.path.join(tmp, "control-dispatch")
        control.pop("CODEX_HOME")
        self.assertEqual(listed(control)["rows"], sorted([elsewhere, elsewhere, demo]))


class PlanStopTest(unittest.TestCase):
    """plan_stop on made-up process tables: what `instance stop` would end."""

    def setUp(self):
        p = patch.object(E, "env_root", return_value=None)  # made-up pids: never ask the real ps
        p.start()
        self.addCleanup(p.stop)
    APP = "/b/Dispatch IDE.app"
    BIN = APP + "/Contents/MacOS/Dispatch IDE"
    ROOT = "/tmp/dide-e2e/e2e"
    UD = ROOT + "/user-data"

    def rec(self, pid=10):
        return {"pid": pid, "app": self.APP, "binary": self.BIN, "root": self.ROOT, "user_data_dir": self.UD}

    def rows(self):
        return [
            (1, 0, "/sbin/launchd"),
            (10, 1, self.BIN + " --user-data-dir " + self.UD + " --remote-debugging-port=5555"),
            (11, 10, self.APP + "/Contents/Frameworks/Dispatch IDE Helper.app/Contents/MacOS/Dispatch IDE Helper --type=gpu-process --user-data-dir=" + self.UD),
            (12, 11, "/usr/bin/python3 /tmp/dide-e2e/e2e/cli/app/cli/dispatch.py sessions --json"),
            (13, 1, self.APP + "/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --database=" + self.ROOT + "/user-data/Crashpad"),
            # the user's own Dispatch IDE: same kind of binary, its own profile
            (20, 1, "/Applications/Dispatch IDE.app/Contents/MacOS/Dispatch IDE"),
            (21, 1, self.BIN + " --user-data-dir /tmp/dide-e2e/other/user-data"),
            # a shell whose command line names our folder (the `pkill -f user-data-dir …` trap)
            (30, 1, "/bin/zsh -c pkill -f 'user-data-dir " + self.UD + "'"),
            (31, 30, "/usr/bin/python3 dispatch.py ide instance stop e2e"),
            (40, 1, "tail -f " + self.ROOT + "/app.log"),
        ]

    def test_only_this_instance(self):
        ok, victims = E.plan_stop(self.rows(), self.rec(), me=31)
        self.assertTrue(ok)
        self.assertEqual([p for p, _ in victims], [10, 11, 12, 13])

    def test_never_the_caller_or_its_shell(self):
        # stop run from a terminal inside the instance: the shell, the command and the app above them stay
        rows = self.rows() + [(50, 10, "/bin/sh"), (51, 50, "python3 dispatch.py ide instance stop e2e")]
        ok, victims = E.plan_stop(rows, self.rec(), me=51)
        pids = [p for p, _ in victims]
        for p in (10, 50, 51):
            self.assertNotIn(p, pids)
        for p in (11, 12, 13):
            self.assertIn(p, pids)

    def test_a_window_merely_opened_on_our_folder_is_not_ours(self):
        # the user's own Dispatch IDE on the demo project, and a runner writing next to the instance
        rows = self.rows() + [
            (60, 1, self.BIN + " " + self.ROOT + "/projects/demo"),
            (61, 1, self.BIN + " /x/runner.mjs --record /h/.dispatch/state/instances/e2e.json --out /tmp/dide-e2e/_runs/knowledge-1"),
        ]
        ok, victims = E.plan_stop(rows, self.rec(), me=31)
        self.assertEqual([p for p, _ in victims], [10, 11, 12, 13])

    def test_the_instance_chatd_goes_too(self):
        # the window's chatd runs the instance's CLI copy and is re-parented to launchd; it used to outlive stop
        py = "/opt/homebrew/Cellar/python@3.14/3.14.4/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python"
        rows = self.rows() + [(70, 1, py + " " + self.ROOT + "/cli/app/cli/dispatch.py chatd run"),
                              (71, 1, py + " /tmp/dide-e2e/other/cli/app/cli/dispatch.py chatd run"),
                              (72, 1, "/bin/zsh -c python3 " + self.ROOT + "/cli/app/cli/dispatch.py chatd run")]
        ok, victims = E.plan_stop(rows, self.rec(), me=31)
        self.assertEqual([p for p, _ in victims], [10, 11, 12, 13, 70])

    def test_a_chatd_started_with_another_cli_goes_by_its_environment(self):
        # the build service's own checkout of the build's kanban started the window chatd (DISPATCH_BIN);
        # only DISPATCH_SESSION_ROOT in its environment ties it to this instance
        py = "/usr/bin/python3"
        rows = self.rows() + [(90, 1, py + " /b/requests/r1/kanban/app/cli/dispatch.py chatd run"),
                              (91, 1, py + " /b/requests/r2/kanban/app/cli/dispatch.py chatd run"),
                              (92, 1, py + " /b/requests/r1/kanban/app/cli/dispatch.py sessions")]
        roots = {90: self.ROOT, 91: "/tmp/dide-e2e/other", 92: self.ROOT}
        with patch.object(E, "env_root", side_effect=lambda pid: roots.get(pid)):
            ok, victims = E.plan_stop(rows, self.rec(), me=31)
        self.assertEqual([p for p, _ in victims], [10, 11, 12, 13, 90])

    def test_the_other_macs_sshd_and_its_logins_go_too(self):
        # sshd names itself in ps: "sshd: /usr/sbin/sshd -f … [listener]"
        sshd = "sshd: /usr/sbin/sshd -f %s/other-mac/sshd_config -E %s/other-mac/sshd.log [listener] 0 of 10-100 startups" % (self.ROOT, self.ROOT)
        rows = self.rows() + [(95, 1, sshd), (96, 95, "sshd-session: me@notty"), (97, 96, "/bin/zsh -c echo"),
                              (98, 1, "/usr/sbin/sshd -D"), (99, 98, "sshd-session: me@ttys001")]
        ok, victims = E.plan_stop(rows, self.rec(), me=31)
        self.assertEqual([p for p, _ in victims], [10, 11, 12, 13, 95, 96, 97])

    def test_a_daemon_installed_in_the_instance_goes_too(self):
        # 10-07: Codex installs its app-server daemon into the instance's CODEX_HOME and starts it in a group of its own
        daemon = "/private%s/codex-home/packages/app-server-daemon/releases/0.160.1/bin/codex app-server daemon pid-update-loop" % self.ROOT
        child = "%s/codex-home/packages/app-server-daemon/releases/0.160.1/bin/codex app-server --listen unix://" % self.ROOT
        rows = self.rows() + [(90, 1, daemon), (91, 90, child), (92, 1, "/opt/homebrew/bin/codex app-server --listen unix://")]
        ok, victims = E.plan_stop(rows, self.rec(), me=31)
        self.assertEqual([p for p, _ in victims], [10, 11, 12, 13, 90, 91])

    def test_a_turbo_part_of_the_instance_goes_too(self):
        # 10-07: a part's runner is detached so it outlives the window; for a stopped instance it worked on for an hour
        py = "/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python"
        part = py + " /checkout/app/cli/turbo.py _exec %s/dispatch/turbo/tb-1/parts/4/launch-1.json" % self.ROOT
        other = py + " /checkout/app/cli/turbo.py _exec /Users/me/.dispatch/turbo/tb-2/parts/1/launch-1.json"
        rows = self.rows() + [(70, 1, part), (71, 70, "/Users/me/.opencode/bin/opencode run --model opencode/big-pickle -- go on"),
                              (72, 1, other), (73, 72, "/Users/me/.opencode/bin/opencode run -- the person's own")]
        ok, victims = E.plan_stop(rows, self.rec(), me=31)
        self.assertEqual([p for p, _ in victims], [10, 11, 12, 13, 70, 71])
        # the run's driver, detached as well, starts the parts again; only its environment names the instance
        driver = py + " /checkout/app/cli/dispatch.py turbo run tb-1"
        with patch.object(E, "env_root", side_effect=lambda pid: self.ROOT if pid == 60 else "/tmp/dide-e2e/other"):
            ok, victims = E.plan_stop(rows + [(60, 1, driver), (61, 60, py + " /checkout/app/cli/turbo.py _exec x"), (62, 1, driver)], self.rec(), me=31)
        self.assertEqual([p for p, _ in victims], [10, 11, 12, 13, 60, 61, 70, 71])

    def test_a_headless_chrome_with_its_profile_in_the_instance_goes_too(self):
        chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        rows = self.rows() + [(80, 1, chrome + " --headless=new --user-data-dir=" + self.ROOT + "/dispatch-home/preferences/evidence/p/.chrome --screenshot=/x.png file:///x.html"),
                              (81, 1, chrome + " --headless=new --user-data-dir=/tmp/elsewhere/.chrome"),
                              (82, 1, chrome)]
        ok, victims = E.plan_stop(rows, self.rec(), me=31)
        self.assertEqual([p for p, _ in victims], [10, 11, 12, 13, 80])

    def test_port_check_refuses_when_lsof_cannot_tell(self):
        orig = E.port_listeners
        try:
            E.port_listeners = lambda port: None
            self.assertFalse(E.port_is_ours({"port": 1, "pid": 10}, rows=self.rows()))
            E.port_listeners = lambda port: [11]
            self.assertTrue(E.port_is_ours({"port": 1, "pid": 10}, rows=self.rows()))
            E.port_listeners = lambda port: [20]
            self.assertFalse(E.port_is_ours({"port": 1, "pid": 10}, rows=self.rows()))
        finally:
            E.port_listeners = orig

    def test_run_output_is_no_instance_folder(self):
        with self.assertRaises(E.E2EError):
            E.check_name(os.path.basename(E.runs_dir()))

    def test_reused_pid_is_not_ours(self):
        rows = [(r[0], r[1], "/usr/bin/some-daemon") if r[0] == 10 else r for r in self.rows()]
        ok, victims = E.plan_stop(rows, self.rec(), me=31)
        self.assertFalse(ok)
        self.assertNotIn(10, [p for p, _ in victims])
        self.assertNotIn(12, [p for p, _ in victims])  # the old tree hangs off a pid that is not ours now
        self.assertIn(13, [p for p, _ in victims])  # our crash handler still names our folder


class HiddenWindowsTest(Env):
    """Test windows stay off the person's screen (task-t8s1): the app starts with its main process' inspector,
    hide-windows.mjs goes in before the first window, the on-screen check reads the window list, and
    DISPATCH_E2E_SHOW=1 leaves the windows alone."""

    def start(self, show):
        app = make_fake_app(self.tmp)
        calls = []
        def hide(rec, wait=30):
            calls.append(rec["inspect_port"])
            return {"ok": True, "windows": 0}
        with patch.dict(os.environ, {"DISPATCH_E2E_SHOW": "1" if show else "0"}), patch.object(E.sys, "platform", "darwin"), \
                patch.object(E, "hide_windows", side_effect=hide), patch.object(E, "onscreen_windows", return_value=[]):
            rec = E.start("h1", app=app, do_seed=False, wait=30, log=lambda *_: None)
        try:
            with open(os.path.join(rec["user_data_dir"], "argv.txt")) as f:
                argv = f.read().split("\n")
        finally:
            E.stop("h1", log=lambda *_: None)
        return rec, argv, calls

    def test_hidden_from_the_start(self):
        rec, argv, calls = self.start(show=False)
        self.assertIn("--inspect=%d" % rec["inspect_port"], argv)
        self.assertNotEqual(rec["inspect_port"], rec["port"])
        self.assertEqual(calls, [rec["inspect_port"]])
        self.assertEqual((rec["hidden"], rec["on_screen"]), ({"ok": True, "windows": 0}, []))

    def start_left_on_screen(self, hidden, on_screen):
        """A start whose hiding answers `hidden` (one answer per call) and whose window list reads `on_screen`
        (one list per read). Returns (the error or None, the hide calls, the record)."""
        app = make_fake_app(self.tmp)
        hides, screens = list(hidden), list(on_screen)
        calls = []
        def hide(rec, wait=60):
            calls.append(wait)
            return hides.pop(0) if len(hides) > 1 else hides[0]
        def shown(pid):
            return screens.pop(0) if len(screens) > 1 else screens[0]
        err = None
        with patch.dict(os.environ, {"DISPATCH_E2E_SHOW": "0"}), patch.object(E.sys, "platform", "darwin"), \
                patch.object(E, "hide_windows", side_effect=hide), patch.object(E, "onscreen_windows", side_effect=shown), \
                patch.object(E.time, "sleep"):
            try:
                E.start("h2", app=app, do_seed=False, wait=30, log=lambda *_: None)
            except E.E2EError as e:
                err = e
        rec = E.read_record("h2")
        if err is None:
            E.stop("h2", log=lambda *_: None)
        return err, calls, rec

    def test_a_start_that_cannot_hide_stops_the_instance(self):
        err, calls, rec = self.start_left_on_screen([{"ok": False, "error": "hide-windows.mjs is missing"}], [[]])
        self.assertIsNotNone(err)
        self.assertEqual(err.code, "not_hidden")
        self.assertIn("hide-windows.mjs is missing", str(err))
        self.assertFalse(E.is_alive(rec))

    def test_a_cli_without_the_helper_starts_nothing(self):
        app = make_fake_app(self.tmp)
        with self.helper(None), patch.dict(os.environ, {"DISPATCH_E2E_SHOW": "0"}), patch.object(E.sys, "platform", "darwin"):
            with self.assertRaises(E.E2EError) as c:
                E.start("h3", app=app, do_seed=False, wait=5, log=lambda *_: None)
        self.assertEqual(c.exception.code, "not_hidden")
        self.assertIn("hide-windows.mjs", str(c.exception))
        self.assertFalse(os.path.exists(os.path.join(E.root_dir(), "h3")))  # nothing made, nothing started

    def test_a_window_seen_after_the_start_is_hidden_again(self):
        err, calls, rec = self.start_left_on_screen([{"ok": True, "windows": 0}], [[[36, 38, 1440, 884]]] * 10 + [[]])
        self.assertIsNone(err)
        self.assertEqual(len(calls), 2)  # before the first window, and again once it was seen
        self.assertEqual(rec["on_screen"], [])

    def test_a_window_that_stays_on_screen_stops_the_instance(self):
        err, calls, rec = self.start_left_on_screen([{"ok": True, "windows": 0}], [[[36, 38, 1440, 884]]])
        self.assertIsNotNone(err)
        self.assertEqual(err.code, "not_hidden")
        self.assertEqual(len(calls), 2)
        self.assertFalse(E.is_alive(rec))

    def test_show_leaves_the_windows_alone(self):
        rec, argv, calls = self.start(show=True)
        self.assertFalse([a for a in argv if a.startswith("--inspect")])
        self.assertEqual(calls, [])
        self.assertNotIn("inspect_port", rec)

    @unittest.skipUnless(sys.platform == "darwin" and shutil.which("osascript"), "macOS only")
    def test_on_screen_reads_the_window_list(self):
        self.assertEqual(E.onscreen_windows(os.getpid()), [])  # this test process has no windows

    def test_hide_windows_says_when_there_is_no_inspector(self):
        rec = {"binary": shutil.which("node") or sys.executable, "inspect_port": E.free_port()}
        if not shutil.which("node"):
            self.skipTest("needs node")
        got = E.hide_windows(rec, wait=1)
        self.assertFalse(got["ok"])
        self.assertIn("no inspector", got["error"])

    def helper(self, body):
        """A stand-in hide-windows.mjs in its own scripts folder, run by this Python (the binary runs it as a script)."""
        scripts = os.path.join(self.tmp, "scripts")
        os.makedirs(scripts, exist_ok=True)
        if body is not None:
            with open(os.path.join(scripts, "hide-windows.mjs"), "w") as f:
                f.write(body)
        return patch.object(E, "SCRIPTS", scripts)

    def test_hide_windows_names_a_missing_helper(self):
        # the 0.9.7 app's own CLI had no hide-windows.mjs (bundle.json): Electron printed "Cannot find module" on
        # stderr, stdout was empty and the start said only "list index out of range" (task-4cpnb)
        with self.helper(None):
            got = E.hide_windows({"binary": sys.executable, "inspect_port": 1}, wait=1)
        self.assertFalse(got["ok"])
        self.assertIn("hide-windows.mjs", got["error"])
        self.assertNotIn("list index", got["error"])

    def test_hide_windows_says_what_a_silent_helper_said_on_stderr(self):
        with self.helper("import sys\nsys.stderr.write('Error: Cannot find module cdp.mjs\\n')\nsys.exit(3)\n"):
            got = E.hide_windows({"binary": sys.executable, "inspect_port": 1}, wait=1)
        self.assertFalse(got["ok"])
        self.assertNotIn("list index", got["error"])
        self.assertIn("3", got["error"])
        self.assertIn("Cannot find module cdp.mjs", got["error"])

    def test_hide_windows_reads_the_answer_after_other_lines(self):
        with self.helper("print('(node) a warning')\nprint('{\"ok\": true, \"windows\": 2}')\n"):
            got = E.hide_windows({"binary": sys.executable, "inspect_port": 1}, wait=1)
        self.assertEqual(got, {"ok": True, "windows": 2})

    def test_check_hidden_reports_a_window_left_on_screen(self):
        said = []
        hides = []
        with patch.object(E, "onscreen_windows", return_value=[[36, 38, 1440, 884]]), patch.object(E.time, "sleep"), \
                patch.object(E, "hide_windows", side_effect=lambda rec, wait=60: hides.append(wait) or {"ok": True, "windows": 1}):
            shown = E.check_hidden({"name": "t", "pid": 1, "inspect_port": 2}, tries=2, log=said.append)
        self.assertEqual(shown, [[36, 38, 1440, 884]])
        self.assertEqual(hides, [15])  # hidden once more before giving up
        self.assertTrue(said and "没能藏起来" in said[-1], said)
        self.assertIsNone(E.check_hidden({"name": "t", "pid": 1}, log=said.append))


class StartStopTest(Env):
    """A real start and stop with a fake app: the record, the flags, the environment, and stop leaving
    look-alike processes alone."""

    def test_start_records_and_stop_ends_only_its_own(self):
        app = make_fake_app(self.tmp)
        rec = E.start("t1", app=app, do_seed=False, wait=30, log=lambda *_: None)
        decoys = []
        try:
            self.assertTrue(os.path.isfile(E.record_path("t1")))
            saved = E.read_record("t1")
            self.assertEqual(saved["pid"], rec["pid"])
            self.assertTrue(saved["user_data_dir"].startswith(os.path.join(self.tmp, "e2e", "t1")))
            self.assertTrue(E.is_alive(saved))
            with open(os.path.join(saved["user_data_dir"], "argv.txt")) as f:
                argv = f.read().split("\n")
            for flag in ("--force-disable-user-env", "--password-store=basic", "--use-inmemory-secretstorage", "--shared-data-dir", "--agents-user-data-dir", "--agent-plugins-dir"):
                self.assertIn(flag, argv)
            self.assertIn("--remote-debugging-port=%d" % saved["port"], argv)
            with open(os.path.join(saved["user_data_dir"], "env.txt")) as f:
                env = dict(line.split("=", 1) for line in f.read().splitlines() if "=" in line)
            self.assertEqual(env["BEADS_DIR"], saved["beads_dir"])
            self.assertEqual(env["DISPATCH_DIR"], saved["dispatch_dir"])
            self.assertEqual(env["DISPATCH_IDE_USER_DATA_DIRS"].split(os.pathsep), [saved["user_data_dir"], saved["agents_user_data_dir"]])
            self.assertEqual(env["DISPATCH_SESSION_ROOT"], saved["root"])
            self.assertEqual(env["CODEX_HOME"], os.path.join(saved["root"], "codex-home"))
            self.assertEqual(env["XDG_DATA_HOME"], os.path.join(saved["root"], "xdg-data"))
            self.assertEqual(env["XDG_CONFIG_HOME"], os.path.join(saved["root"], "xdg-config"))
            self.assertEqual(os.readlink(os.path.join(env["CODEX_HOME"], "auth.json")), os.path.join(self.tmp, "codex", "auth.json"))
            self.assertNotIn("CLAUDECODE", env)
            # an agent in the instance typing `dispatch …` gets the instance's CLI, before ~/.local/bin
            shim = os.path.join(saved["bin_dir"], "dispatch")
            self.assertIn(saved["bin_dir"], env["PATH"].split(os.pathsep)[:3])
            with open(shim) as f:
                self.assertIn(saved["cli"], f.read())
            self.assertTrue(os.access(shim, os.X_OK))
            # a second instance of the same app, and a shell naming our user data: both must survive
            other_ud = os.path.join(self.tmp, "other-ud")
            decoys.append(subprocess.Popen([saved["binary"], "--user-data-dir", other_ud], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            decoys.append(subprocess.Popen(["/bin/sh", "-c", "sleep 60", "decoy", "--user-data-dir", saved["user_data_dir"]]))
            time.sleep(1)
            with self.assertRaises(E.E2EError) as c:
                E.start("t1", app=app, do_seed=False, wait=5, log=lambda *_: None)
            self.assertEqual(c.exception.code, "already_running")
            out = E.stop("t1", log=lambda *_: None)
            self.assertTrue(out["ok"], out)
            self.assertFalse(alive(rec["pid"]))

            self.assertFalse(E.is_alive(E.read_record("t1")))
            for d in decoys:
                self.assertIsNone(d.poll(), "stop ended a process that is not the instance's")
        finally:
            for d in decoys:
                if d.poll() is None:
                    d.send_signal(signal.SIGTERM)
                    d.wait(10)
            if alive(rec["pid"]):
                os.kill(rec["pid"], signal.SIGTERM)

    def test_root_not_made_by_us_is_left_alone(self):
        os.makedirs(os.path.join(self.tmp, "e2e", "t2", "keep"))
        with self.assertRaises(E.E2EError) as c:
            E.start("t2", app=make_fake_app(self.tmp), do_seed=False, wait=5, log=lambda *_: None)
        self.assertEqual(c.exception.code, "root_taken")
        self.assertTrue(os.path.isdir(os.path.join(self.tmp, "e2e", "t2", "keep")))


def make_fake_dev_tree(base, cli):
    """ide/vscode of a development build (ide/dev.sh build): the source tree with .build/dispatch-dev.json naming its
    Electron, the arguments before ours and the environment to run from source."""
    tree = os.path.join(base, "repo", "ide", "vscode")
    os.makedirs(os.path.join(tree, ".build"))
    exe = os.path.join(base, "electron", "Fake IDE Dev")
    os.makedirs(os.path.dirname(exe))
    with open(exe, "w") as f:
        f.write(FAKE_BIN)
    os.chmod(exe, 0o755)
    with open(os.path.join(tree, "product.json"), "w") as f:
        json.dump({"version": "1.0.0-test"}, f)
    os.makedirs(os.path.join(tree, "tools"))
    with open(os.path.join(tree, "tools", "codex"), "w") as f:
        f.write("#!/bin/sh\nexit 1\n")
    os.chmod(os.path.join(tree, "tools", "codex"), 0o755)
    with open(os.path.join(tree, ".build", "dispatch-dev.json"), "w") as f:
        json.dump({"binary": exe, "args": [tree, "--disable-extension=GitHub.copilot-chat"], "env": {"VSCODE_DEV": "1", "DISPATCH_DEV_KEEP_HIDDEN": "1"},
                   "commit": "c" * 40, "dirty": True, "cli": cli, "repo": os.path.join(base, "repo")}, f)
    return tree


class DevBuildStartTest(Env):
    """A test instance of a development build: named by its repository, it starts Electron with the source tree and
    the build's flags first, runs from source, and uses that checkout's CLI."""

    def test_start_from_the_repository_runs_the_tree_from_source(self):
        cli = os.path.join(HERE, "dispatch.py")
        tree = make_fake_dev_tree(self.tmp, cli)
        self.assertEqual(E.dev_root(os.path.join(self.tmp, "repo")), tree)
        self.assertEqual(E.app_resources(tree, "tools"), os.path.join(tree, "tools"))
        rec = E.start("d1", app=os.path.join(self.tmp, "repo"), do_seed=False, wait=30, log=lambda *_: None)
        try:
            saved = E.read_record("d1")
            self.assertEqual((saved["app"], saved["cli"]), (tree, cli))
            self.assertEqual(saved["build"]["name"], "dev " + "c" * 12 + " + changes")
            with open(os.path.join(saved["user_data_dir"], "argv.txt")) as f:
                argv = f.read().split("\n")
            self.assertEqual(argv[:2], [tree, "--disable-extension=GitHub.copilot-chat"])
            self.assertIn("--use-inmemory-secretstorage", argv)
            with open(os.path.join(saved["user_data_dir"], "env.txt")) as f:
                env = dict(line.split("=", 1) for line in f.read().splitlines() if "=" in line)
            self.assertEqual((env["VSCODE_DEV"], env["DISPATCH_DEV_KEEP_HIDDEN"]), ("1", "1"))
            self.assertTrue(env["PATH"].startswith(os.path.join(tree, "tools")))
            self.assertTrue(E.stop("d1", log=lambda *_: None)["ok"])
        finally:
            if alive(rec["pid"]):
                os.kill(rec["pid"], signal.SIGTERM)

    def test_a_packaged_app_is_not_a_development_build(self):
        app = make_fake_app(self.tmp)
        self.assertIsNone(E.dev_root(app))
        self.assertEqual(E.app_resources(app, "tools"), os.path.join(app, "Contents", "Resources", "app", "tools"))


def js_runtime():
    """node, else a Dispatch IDE Electron run as Node (what `e2e run` itself uses)."""
    node = shutil.which("node")
    if node:
        return [node], {}
    app = E.default_app()
    if app and os.path.isfile(E.app_binary(app)):
        return [E.app_binary(app)], {"ELECTRON_RUN_AS_NODE": "1"}
    return None, None


FOCUS = os.path.join(E.SCRIPTS, "focus.mjs")
CASES = [
    # (name, description of document.activeElement, may type, sends a chat message on Enter)
    ("nothing", None, False, False),
    ("body", {"tag": "BODY"}, False, False),
    ("text input", {"tag": "INPUT", "type": "text", "classes": [], "ancestors": ["dispatch-find-skills-input-row"]}, True, False),
    ("checkbox", {"tag": "INPUT", "type": "checkbox"}, False, False),
    ("read-only input", {"tag": "INPUT", "type": "text", "readOnly": True}, False, False),
    ("open file in the editor", {"tag": "TEXTAREA", "classes": ["inputarea"], "ancestors": ["view-lines", "monaco-editor", "editor-instance", "editor-group-container"]}, False, False),
    ("diff editor", {"tag": "TEXTAREA", "classes": ["inputarea"], "ancestors": ["monaco-editor", "monaco-diff-editor"]}, False, False),
    ("chat input", {"tag": "TEXTAREA", "classes": ["inputarea"], "ancestors": ["monaco-editor", "interactive-input-editor", "interactive-input-part"]}, True, True),
    ("quick pick", {"tag": "INPUT", "type": "text", "ancestors": ["monaco-inputbox", "quick-input-widget"]}, True, False),
    ("find in file", {"tag": "TEXTAREA", "classes": ["input"], "ancestors": ["monaco-editor", "find-widget", "editor-instance"]}, True, False),
    ("note on a diff", {"tag": "TEXTAREA", "ancestors": ["agent-feedback-input-widget", "overlayWidgets", "monaco-editor", "monaco-diff-editor", "editor-instance"]}, True, False),
    ("Settings › Soul text", {"tag": "DIV", "classes": ["native-edit-context"], "ancestors": ["overflow-guard", "monaco-editor", "dset-soul-host", "dset-soul-editor"]}, True, False),
    ("webview frame", {"tag": "IFRAME", "frame": True, "src": "index.html?id=1"}, False, False),
    ("button", {"tag": "BUTTON", "classes": ["monaco-button"]}, False, False),
    ("customize your agent", {"tag": "INPUT", "type": "text", "ancestors": ["welcome-prompts-input-row", "welcome-prompts-primary"]}, True, True),
    # newer Monaco (EditContext): the focused element is a div
    ("open file, EditContext", {"tag": "DIV", "classes": ["native-edit-context"], "ancestors": ["overflow-guard", "monaco-editor", "editor-instance"]}, False, False),
    ("Agents window chat, EditContext", {"tag": "DIV", "classes": ["native-edit-context"], "ancestors": ["overflow-guard", "monaco-editor", "sessions-chat-editor", "new-chat-input-area"]}, True, True),
    ("unknown Monaco editor", {"tag": "DIV", "classes": ["native-edit-context"], "ancestors": ["monaco-editor"]}, False, False),
]


class FocusRuleTest(unittest.TestCase):
    def test_focus_verdicts(self):
        cmd, extra = js_runtime()
        if not cmd:
            self.skipTest("no node and no Dispatch IDE to run focus.mjs")
        script = ("import { focusVerdict, sendsChat } from %s;\n"
                  "let raw = ''; process.stdin.on('data', (d) => raw += d); process.stdin.on('end', () => {\n"
                  "  const out = JSON.parse(raw).map((d) => [focusVerdict(d), sendsChat(d)]);\n"
                  "  process.stdout.write(JSON.stringify(out)); });\n") % json.dumps("file://" + FOCUS)
        with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False) as f:
            f.write(script)
        try:
            r = subprocess.run(cmd + [f.name], input=json.dumps([c[1] for c in CASES]), capture_output=True, text=True,
                               timeout=60, env=dict(os.environ, **extra))
        finally:
            os.remove(f.name)
        self.assertEqual(r.returncode, 0, r.stderr)
        got = json.loads(r.stdout)
        for (name, _, may_type, sends), (verdict, chat) in zip(CASES, got):
            self.assertEqual(verdict["ok"], may_type, "%s: %s" % (name, verdict))
            self.assertEqual(chat, sends, name)
        self.assertEqual(got[5][0]["kind"], "document")  # an open file is refused as a document


class AnnotateTest(Env):
    def test_badges_avoid_other_boxes(self):
        # two boxes side by side: the right one's number must not land on the left one
        left = (100, 100, 200, 130)
        cx, cy = E.badge_spot(205, 100, 300, 130, 19, 1000, 800, avoid=[left])
        self.assertFalse(left[0] < cx + 19 and cx - 19 < left[2] and left[1] < cy + 19 and cy - 19 < left[3])

    def test_annotate_writes_picture_and_readme(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("no Pillow")
        d = os.path.join(self.tmp, "run")
        os.makedirs(d)
        Image.new("RGB", (400, 300), (250, 250, 249)).save(os.path.join(d, "frame-1.png"))
        doc = {"scenario": "/x/waiting.mjs", "meta": {"title": "Waiting for you 页"}, "viewport": {"w": 200, "h": 150, "dpr": 2},
               "instance": {"name": "e2e", "port": 1, "build": {"dispatch_ide": "a" * 40, "kanban": "b" * 40}}, "ok": True,
               "steps": [], "shots": ["frame-1.png"],
               "marks": [{"n": 1, "frame": "frame-1.png", "box": {"x": 20, "y": 20, "w": 60, "h": 16}, "what": "Waiting for you 入口", "where": "左侧栏第一行", "how": "点它 › 看列表"}]}
        with open(os.path.join(d, "steps.json"), "w") as f:
            json.dump(doc, f)
        r = E.annotate(d)
        self.assertTrue(os.path.isfile(r["png"]))
        with open(r["readme"], encoding="utf-8") as f:
            text = f.read()
        self.assertIn("1. Waiting for you 入口 · 左侧栏第一行 · 点它 › 看列表", text)
        self.assertIn("aaaaaaaaaaaa-bbbbbbbbbbbb", text)



class InstanceLaunchAgents(unittest.TestCase):
    def test_stop_boots_out_only_this_instances_jobs(self):
        listing = "PID\tStatus\tLabel\n123\t0\tdev.dispatch-e2e-fr5.chatd\n-\t0\tdev.dispatch-e2e-fr50.chatd\n9\t0\tdev.dispatch.chatd\n"
        calls = []

        def run(args, **kw):
            calls.append(args)
            return types.SimpleNamespace(stdout=listing if args[:2] == ["launchctl", "list"] else "", returncode=0)
        with patch.object(E.subprocess, "run", side_effect=run), patch.object(E.sys, "platform", "darwin"):
            done = E.bootout_instance_jobs("fr5")
        self.assertEqual(done, ["dev.dispatch-e2e-fr5.chatd"])
        boots = [c for c in calls if c[:2] == ["launchctl", "bootout"]]
        self.assertEqual(len(boots), 1)
        self.assertTrue(boots[0][2].endswith("/dev.dispatch-e2e-fr5.chatd"))


class EnvRootTest(unittest.TestCase):
    def run_ps(self, env):
        return subprocess.CompletedProcess([], 0, stdout="python dispatch.py chatd run " + env + "\n")

    def test_session_root_wins(self):
        with patch.object(E.subprocess, "run", return_value=self.run_ps("HOME=/tmp/dide-x/h DISPATCH_SESSION_ROOT=/tmp/dide-e2e/y")):
            self.assertEqual(E.env_root(1), "/tmp/dide-e2e/y")

    def test_a_new_user_instance_goes_by_its_home(self):
        with patch.object(E.subprocess, "run", return_value=self.run_ps("HOME=/tmp/dide-r2b2/h DISPATCH_DIR=/tmp/dide-r2b2/h/tasks/.dispatch")):
            self.assertEqual(E.env_root(1), "/tmp/dide-r2b2")

    def test_the_users_own_chatd_is_never_matched(self):
        with patch.object(E.subprocess, "run", return_value=self.run_ps("HOME=/Users/someone DISPATCH_DIR=/Users/someone/tasks/.dispatch")):
            self.assertIsNone(E.env_root(1))


if __name__ == "__main__":
    unittest.main()


class ScenarioTimeout(unittest.TestCase):
    def test_a_scenario_can_ask_for_more_time(self):
        import tempfile as _t
        d = _t.mkdtemp()
        try:
            slow, plain = os.path.join(d, "slow.mjs"), os.path.join(d, "plain.mjs")
            with open(slow, "w") as f:
                f.write("export const meta = { timeout: 2400, title: 'x' };\nexport default async function () {}\n")
            with open(plain, "w") as f:
                f.write("export const meta = { title: 'timeout: 9' };\n")
            self.assertEqual(E.meta_timeout(slow), 2400)
            self.assertEqual(E.meta_timeout(plain), 0)
            self.assertEqual(E.meta_timeout(os.path.join(d, "gone.mjs")), 0)
            nested = os.path.join(d, "nested.mjs")
            with open(nested, "w") as f:
                f.write("export const meta = { instance: { onboarding: 'fresh', env: { A: '{x}' } }, needs: ['codex'], title: 'a } b', timeout: 900 };\n")
            self.assertEqual(E.meta_timeout(nested), 900)
            inner = os.path.join(d, "inner.mjs")
            with open(inner, "w") as f:
                f.write("export const meta = { instance: { timeout: 5 }, title: 'x' };\n")
            self.assertEqual(E.meta_timeout(inner), 0)
        finally:
            shutil.rmtree(d, ignore_errors=True)


class TermdStopTest(unittest.TestCase):
    """`ide instance stop` also ends the terminal daemon the instance's window started, and nothing else."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.d = os.path.join(self.tmp, "dispatch")
        os.makedirs(os.path.join(self.d, "termd"))
        with open(os.path.join(self.d, "termd", "daemon.json"), "w") as f:
            json.dump({"pid": 4242, "port": 1, "token": "t"}, f)

    def test_stops_the_instances_own_daemon(self):
        cmd = "/X.app/Contents/MacOS/X /k/termd/termd.cjs --state %s --app-root /X" % os.path.join(self.d, "termd")
        with patch.object(E, "ps_rows", lambda: [(4242, 1, cmd)]), patch.object(E.os, "kill") as kill, patch.object(E, "wait_gone", lambda pids, t: []):
            self.assertEqual(E.stop_instance_termd({"dispatch_dir": self.d}), 4242)
        kill.assert_called_once_with(4242, signal.SIGTERM)

    def test_leaves_a_process_that_is_not_its_daemon(self):
        with patch.object(E, "ps_rows", lambda: [(4242, 1, "/usr/bin/vim notes.txt")]), patch.object(E.os, "kill") as kill:
            self.assertEqual(E.stop_instance_termd({"dispatch_dir": self.d}), 0)
        kill.assert_not_called()

    def test_no_daemon_file_no_stop(self):
        self.assertEqual(E.stop_instance_termd({"dispatch_dir": os.path.join(self.tmp, "none")}), 0)
