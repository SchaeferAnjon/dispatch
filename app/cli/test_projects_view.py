# -*- coding: utf-8 -*-
"""projects_view.py: the registry behind the Agents window's project groups and the Projects page."""
import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import projects_view as PV  # noqa: E402

# hosts.json after the 2026-09-27 rename: one name, the old id and names kept as aliases
MINI = {"id": "mini", "name": "mini", "ssh": "apple@100.64.0.11", "aliases": ["Apple", "Kiwi的Mac mini", "kiwi-mac-mini"]}


def fake_dispatch(home, flags, owners=None, hosts=(MINI,), homes_of=None, here="小蓝"):
    """Just the parts of dispatch that registry() / register() use."""
    mem = {"dispatch-projects": json.dumps(flags, ensure_ascii=False),
           "dispatch-project-owners": json.dumps(owners or {}, ensure_ascii=False)}
    stored = {}

    def parse_flags(raw):
        return json.loads(raw) if raw else {}

    def parse_owners(raw):
        return json.loads(raw) if raw else {}

    D = types.SimpleNamespace(
        HOME=home,
        PROJECT_FLAGS_KEY="dispatch-projects",
        PROJECT_OWNERS_KEY="dispatch-project-owners",
        project_flags_parse=parse_flags,
        project_owners_parse=parse_owners,
        project_owner_is_here=lambda rec: rec.get("host") == here,
        hosts=lambda: list(hosts),
        local_host_name=lambda: here,
        project_names=lambda: {},
        settings_load=lambda: {"workspace_roots": ["~/Projects"]},
        load_index=lambda: {},
        project_home=lambda name, *a: (homes_of or {}).get(name, ""),
        project_flags_load=lambda strict=False: parse_flags(mem["dispatch-projects"]),
        wiki_store=lambda k, v: stored.__setitem__(k, v),
        project_dirs=lambda reload=False: {},
        sh=lambda args, timeout=20: (0, "", ""),
    )
    return D, mem, stored


class Machines(unittest.TestCase):
    def test_label(self):
        self.assertEqual(PV.machine_label(None), "this Mac")
        self.assertEqual(PV.machine_label(MINI), "mini")
        self.assertEqual(PV.machine_label({"id": "x", "name": "Studio"}), "Studio")
        # one Mac, one name: hosts.json's, no guessing "mini" from an alias
        self.assertEqual(PV.machine_label({"id": "kiwi-mac-mini", "name": "Apple", "aliases": ["Kiwi的Mac mini"]}), "Apple")

    def test_find_host_by_old_id_and_names(self):
        for key in ("mini", "kiwi-mac-mini", "Apple", "APPLE", "Kiwi的Mac mini", "apple@100.64.0.11", "100.64.0.11"):
            self.assertIs(PV.find_host([MINI], key), MINI, key)
        self.assertIsNone(PV.find_host([MINI], "studio"))

    def test_peer_of_dir(self):
        homes = PV.peer_homes([MINI])
        self.assertEqual(PV.peer_of_dir("/Users/apple/Projects/后台", homes, "/Users/me"), MINI)
        self.assertIsNone(PV.peer_of_dir("/Users/me/Projects/kanban", homes, "/Users/me"))
        self.assertIsNone(PV.peer_of_dir("/opt/x", homes, "/Users/me"))


class TempFolders(unittest.TestCase):
    def test_temp_folders_are_not_projects(self):
        with patch.dict(os.environ, {"DISPATCH_SESSION_ROOT": ""}):
            for p in ("/tmp/x", "/private/tmp/x", "/private/var/folders/ab/T/x", "/Users/me/scratchpad/x"):
                self.assertTrue(PV.is_temp(p), p)
            self.assertFalse(PV.is_temp("/Users/me/Projects/x"))

    def test_a_test_instance_keeps_its_own_folders(self):
        # a Dispatch IDE test instance lives in /tmp/dide-e2e/<name>: its folders are its projects (10-07, bugs3)
        with patch.dict(os.environ, {"DISPATCH_SESSION_ROOT": "/tmp/dide-e2e/suite"}):
            self.assertFalse(PV.is_temp("/tmp/dide-e2e/suite/projects/demo"))
            self.assertFalse(PV.is_temp("/private/tmp/dide-e2e/suite/alpha/demo"))
            self.assertTrue(PV.is_temp("/tmp/elsewhere"))


class Folders(unittest.TestCase):
    def test_not_a_project(self):
        home = "/Users/me"
        roots = ["~/Projects"]
        self.assertTrue(PV.not_a_project("/private/tmp/x", home, roots))
        self.assertTrue(PV.not_a_project("/private/tmp/claude-501/a/scratchpad/w", home, roots))
        self.assertTrue(PV.not_a_project("/Users/me/.codex/memories", home, roots))
        self.assertTrue(PV.not_a_project("/Users/me/Downloads", home, roots))
        self.assertFalse(PV.not_a_project("/Users/me/Projects/bookmark", home, roots))
        self.assertFalse(PV.not_a_project("/Users/me/Documents/github_projects/typefree", home, roots))

    def test_git_main_root_and_worktree(self):
        with tempfile.TemporaryDirectory() as t:
            repo = os.path.join(t, "kanban")
            os.makedirs(os.path.join(repo, ".git", "worktrees", "wt1"))
            os.makedirs(os.path.join(repo, "app", "cli"))
            self.assertEqual(PV.git_main_root(os.path.join(repo, "app", "cli")), repo)
            wt = os.path.join(t, "kanban.worktrees", "wt1")
            os.makedirs(wt)
            with open(os.path.join(wt, ".git"), "w") as f:
                f.write(f"gitdir: {repo}/.git/worktrees/wt1\n")
            self.assertEqual(PV.git_main_root(wt), repo)
            self.assertEqual(PV.git_main_root(os.path.join(t, "elsewhere")), "")
            self.assertIn(repo + ".worktrees", PV.worktree_dirs(repo))


class Registry(unittest.TestCase):
    def test_where_each_project_lives(self):
        with tempfile.TemporaryDirectory() as home:
            kanban = os.path.join(home, "Projects", "kanban")
            os.makedirs(os.path.join(kanban, ".git"))
            flags = {
                "kanban": {},
                "后台": {"dir": "/Users/apple/Projects/后台", "starred": True},
                "harbor": {},
                "内在知识提升": {"alias": "讲书"},
                "old": {"archived": True},
            }
            D, mem, _ = fake_dispatch(home, flags, owners={"harbor": {"host": "Apple", "ip": "100.64.0.11"}},
                                       homes_of={"kanban": kanban})
            PV.D = D
            rows = {r["name"]: r for r in PV.registry(mem)}
        self.assertEqual(rows["kanban"]["dir"], kanban)
        self.assertEqual(rows["kanban"]["machine"], "this Mac")
        self.assertTrue(rows["kanban"]["git"])
        self.assertEqual(rows["后台"]["host"], "mini")
        self.assertEqual(rows["后台"]["machine"], "mini")
        # handed to the mini with `dispatch project --owner` back when it was "Apple": the alias finds it
        self.assertEqual(rows["harbor"]["host"], "mini")
        self.assertEqual(rows["harbor"]["dir"], "/Users/apple/Projects/harbor")
        self.assertEqual(rows["内在知识提升"]["label"], "讲书")
        self.assertEqual(rows["内在知识提升"]["dir"], "")
        self.assertTrue(rows["old"]["archived"])
        # placed: a folder under some Mac's home, or an owner record; else every Mac counts it as its own
        self.assertEqual({n: r["placed"] for n, r in rows.items()},
                         {"kanban": False, "后台": True, "harbor": True, "内在知识提升": False, "old": False})

    def test_missing_folder_is_named(self):
        # Settings › Projects said nothing for a project whose folder is gone (Probe, a /tmp folder) or is another Mac's
        # path this Mac has no host for: the registered folder comes along as missing_dir
        with tempfile.TemporaryDirectory() as home:
            here = os.path.join(home, "Projects", "here")
            os.makedirs(os.path.join(here, ".git"))
            flags = {"Probe": {"dir": "/tmp/dbg/h/Probe-gone"}, "后台": {"dir": "/Users/apple/Projects/后台"},
                     "here": {"dir": here}, "nothing": {}}
            D, mem, _ = fake_dispatch(home, flags, hosts=())
            PV.D = D
            rows = {r["name"]: r for r in PV.registry(mem)}
        self.assertEqual((rows["Probe"]["dir"], rows["Probe"]["missing_dir"]), ("", "/tmp/dbg/h/Probe-gone"))
        self.assertEqual((rows["后台"]["dir"], rows["后台"]["missing_dir"]), ("", "/Users/apple/Projects/后台"))
        self.assertNotIn("missing_dir", rows["here"])
        self.assertNotIn("missing_dir", rows["nothing"])

    def test_registered_on_the_mini_by_folder_and_owner(self):
        # 讲书 after the move of its registration: its folder on the mini, the mini as its owner
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, "Projects", "kanban", ".git"))
            flags = {"内在知识提升": {"alias": "讲书", "dir": "/Users/apple/Projects/内在知识提升"}, "kanban": {"dir": os.path.join(home, "Projects", "kanban")}}
            owners = {"内在知识提升": {"host": "mini", "ip": "100.64.0.11"}, "kanban": {"host": "小蓝", "ip": "100.64.0.12"}}
            D, mem, _ = fake_dispatch(home, flags, owners=owners)
            PV.D = D
            rows = {r["name"]: r for r in PV.registry(mem)}
            self.assertEqual((rows["内在知识提升"]["host"], rows["内在知识提升"]["dir"], rows["内在知识提升"]["placed"]),
                             ("mini", "/Users/apple/Projects/内在知识提升", True))
            self.assertEqual((rows["kanban"]["host"], rows["kanban"]["placed"]), ("local", True))
            D.home_relative = lambda cwd, host=None: cwd.replace("/Users/apple", "~", 1) if host else cwd.replace(home, "~", 1)
            where = PV.placements(list(rows.values()))
            self.assertEqual(where["names"], {"内在知识提升": "mini", "讲书": "mini", "kanban": "local"})
            self.assertEqual(sorted(where["dirs"]), [("~/Projects/kanban", "local"), ("~/Projects/内在知识提升", "mini")])

    def test_register_git_inits_and_stars(self):
        with tempfile.TemporaryDirectory() as home:
            folder = os.path.join(home, "Projects", "new-thing")
            D, _mem, stored = fake_dispatch(home, {})
            calls = []
            D.sh = lambda args, timeout=20: calls.append(args) or (0, "", "")
            PV.D = D
            self.enterContext(patch.object(PV, "ensure_board", return_value={"created": False}))
            with self.assertRaises(ValueError):
                PV.register(folder)  # does not exist, not asked to create it
            r = PV.register(folder, create=True)
            self.assertTrue(os.path.isdir(folder))
            self.assertEqual(r["name"], "new-thing")
            self.assertEqual(calls, [["git", "-C", folder, "init", "-q"]])
            saved = json.loads(stored["dispatch-projects"])
            self.assertEqual(saved["new-thing"], {"dir": folder, "starred": True})
            with self.assertRaises(ValueError):
                PV.register("relative/path")


class FirstProject(unittest.TestCase):
    """Add as project on a Mac with no task board yet: the board is made silently, and only a board that cannot
    be made says anything (in words, with a way to try again). The old answer sent people to a Settings menu
    that no longer exists (task-had4)."""

    def setUp(self):
        # bd's embedded Dolt keeps writing event files for a moment after the CLI has exited: a late file is not a failure
        self.home = self.enterContext(tempfile.TemporaryDirectory(ignore_cleanup_errors=True))
        self.folder = os.path.join(self.home, "Projects", "first")
        os.makedirs(self.folder)
        self.D, self.mem, self.stored = fake_dispatch(self.home, {})
        self.calls = []
        self.D.sh = lambda args, timeout=20: self.calls.append(args) or (0, "", "")
        self.enterContext(patch.object(PV, "D", self.D))

    def test_the_board_is_made_before_the_project_is_saved(self):
        order = []
        self.D.wiki_store = lambda k, v: order.append("saved")
        with patch.object(PV, "ensure_board", side_effect=lambda: order.append("board") or {"created": True}):
            r = PV.register(self.folder)
        self.assertEqual(order, ["board", "saved"])
        self.assertTrue(r["ok"] and r["board_created"])
        self.assertEqual(r["name"], "first")

    def test_an_existing_board_is_not_reported_as_new(self):
        with patch.object(PV, "ensure_board", return_value={"created": False, "dir": "/x", "embedded": True}):
            self.assertFalse(PV.register(self.folder)["board_created"])

    def test_ensure_board_is_the_first_run_setup_function(self):
        fake = types.SimpleNamespace(ensure_board=lambda: {"dir": "/x/.beads", "created": True, "embedded": True})
        with patch.dict(sys.modules, {"init_wizard": fake}):
            self.assertEqual(PV.ensure_board(), {"dir": "/x/.beads", "created": True, "embedded": True})

    def test_a_board_that_cannot_be_made_is_one_plain_sentence_with_retry_and_touches_nothing(self):
        def broken():
            raise RuntimeError("bd init did not create the board: disk is full")
        fake = types.SimpleNamespace(ensure_board=broken)
        fresh = os.path.join(self.home, "Projects", "brand-new")
        with patch.dict(sys.modules, {"init_wizard": fake}):
            for create, target in ((False, self.folder), (True, fresh)):
                with self.assertRaises(PV.RegisterError) as cm:
                    PV.register(target, create=create)
                msg = str(cm.exception)
                self.assertTrue(cm.exception.retry)
                self.assertEqual(msg, "Could not set up the task board: bd init did not create the board: disk is full. Try again.")
                self.assertNotIn("First-run", msg)
        self.assertFalse(os.path.exists(fresh), "a folder for `new` is not made when the board cannot be")
        self.assertEqual(self.calls, [], "no git init either")
        self.assertEqual(self.stored, {})

    def test_the_command_answers_ok_false_and_retry_for_the_window(self):
        broken = types.SimpleNamespace(ensure_board=lambda: (_ for _ in ()).throw(RuntimeError("bd (Beads) is not installed")))
        args = types.SimpleNamespace(op="add", arg=self.folder, name="", json=True)
        out = []
        with patch.dict(sys.modules, {"init_wizard": broken}), patch("builtins.print", side_effect=lambda *a, **k: out.append(a[0])):
            self.assertEqual(PV.command(args, self.D), 1)
        self.assertEqual(json.loads(out[0]), {"ok": False, "message": "Could not set up the task board: bd (Beads) is not installed. Try again.", "retry": True})
        # a refusal that is not about the board carries no retry
        out.clear()
        args = types.SimpleNamespace(op="add", arg="relative", name="", json=True)
        with patch("builtins.print", side_effect=lambda *a, **k: out.append(a[0])):
            self.assertEqual(PV.command(args, self.D), 1)
        self.assertEqual(json.loads(out[0]), {"ok": False, "message": "Give the full path of the folder."})

    @unittest.skipUnless(shutil.which("bd"), "needs bd")
    def test_on_a_new_mac_the_real_cli_makes_the_board_and_registers(self):
        """The real thing, in a throw-away HOME and BEADS_DIR: no board, `projects-view add`, a board and a project."""
        beads = os.path.join(self.home, "tasks", ".beads")
        env = {**os.environ, "HOME": self.home, "BEADS_DIR": beads, "DISPATCH_DIR": os.path.join(self.home, "tasks", ".dispatch")}
        env.pop("DISPATCH_SESSION_ROOT", None)
        cli = os.path.join(HERE, "dispatch.py")
        r = subprocess.run([sys.executable, cli, "projects-view", "add", self.folder, "--json"], env=env, capture_output=True, text=True, timeout=180)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout), {"ok": True, "name": "first", "label": "first", "dir": self.folder, "git": True,
                                                "board_created": True, "renamed": False})
        self.assertNotIn("First-run", r.stdout + r.stderr)
        self.assertTrue(os.path.exists(os.path.join(beads, "config.yaml")))
        again = subprocess.run([sys.executable, cli, "projects", "--json"], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual([p["name"] for p in json.loads(again.stdout)], ["first"])


class FolderIdentity(unittest.TestCase):
    def test_same_name_guess_cannot_absorb_another_registered_folder(self):
        with tempfile.TemporaryDirectory() as home:
            one, two = (os.path.join(home, parent, "demo") for parent in ("a", "b"))
            os.makedirs(one)
            os.makedirs(two)
            fake = types.SimpleNamespace(HOME=home, project_of_cwd=lambda *args: "demo")
            with patch.object(PV, "D", fake):
                self.assertEqual(PV._session_project(two, [(one, "demo")], {"demo": "demo"}, {}, [], {}), ("", two, False))
                self.assertEqual(PV._session_project(two, [], {"demo": "demo"}, {}, [], {}), ("demo", "", False))

    def test_a_folder_reached_through_a_symlink_is_the_registered_project(self):
        # Claude Code records /private/tmp/…; the project was registered as /tmp/… (a session after an
        # IDE restart must stay in its project group)
        with tempfile.TemporaryDirectory() as home:
            real = os.path.join(home, "real", "demo")
            os.makedirs(real)
            link = os.path.join(home, "link")
            os.symlink(os.path.join(home, "real"), link)
            given = os.path.join(link, "demo")
            fake = types.SimpleNamespace(HOME=home, project_of_cwd=lambda *args: "")
            with patch.object(PV, "D", fake):
                self.assertEqual(PV._session_project(real, [(given, "demo")], {"demo": "demo"}, {}, [], {})[0], "demo")
                self.assertEqual(PV._session_project(given, [(real, "demo")], {"demo": "demo"}, {}, [], {})[0], "demo")


class SameNameFolders(unittest.TestCase):
    """The project registry knows a project by its folder. Two folders called demo are two projects: the second
    is not allowed to take the first one's place (task-brhv). Registries written before this, keyed by name alone,
    still read the same."""

    def setUp(self):
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(ignore_cleanup_errors=True))  # bd's Dolt writes late (see FirstProject)
        self.home = os.path.realpath(self.tmp)
        self.a = os.path.join(self.home, "Projects", "gx-hover-demo", "demo")
        self.b = os.path.join(self.home, "Projects", "gx-hover-demo", "current", "demo")
        for d in (self.a, self.b):
            os.makedirs(os.path.join(d, ".git"))
        self.flags = {}
        self.D, self.mem, self.stored = fake_dispatch(self.home, self.flags)
        self.D.project_flags_load = lambda strict=False: dict(self.flags)

        def store(k, v):
            self.stored[k] = v
            self.flags.clear()
            self.flags.update(json.loads(v))
        self.D.wiki_store = store
        self.enterContext(patch.object(PV, "D", self.D))
        self.enterContext(patch.object(PV, "ensure_board", return_value={"created": False}))

    def add(self, folder, name=""):
        return PV.register(folder, name)

    def memories(self):
        return {"dispatch-projects": json.dumps(self.flags, ensure_ascii=False), "dispatch-project-owners": "{}"}

    def test_the_second_folder_of_a_name_is_kept_apart_by_the_folder_above(self):
        first = self.add(self.a)
        second = self.add(self.b)
        self.assertEqual((first["name"], first["renamed"]), ("demo", False))
        self.assertEqual((second["name"], second["renamed"]), ("demo · current", True))
        self.assertEqual({n: f["dir"] for n, f in self.flags.items()}, {"demo": self.a, "demo · current": self.b})
        # and the other way round
        self.flags.clear()
        self.add(self.b)
        self.assertEqual(self.add(self.a)["name"], "demo · gx-hover-demo")
        self.assertEqual({n: f["dir"] for n, f in self.flags.items()}, {"demo": self.b, "demo · gx-hover-demo": self.a})

    def test_the_first_one_keeps_its_star_alias_and_archive(self):
        self.flags["demo"] = {"dir": self.a, "alias": "Demo A", "archived": True, "test_cmd": "make test"}
        self.add(self.b)
        self.assertEqual(self.flags["demo"], {"dir": self.a, "alias": "Demo A", "archived": True, "test_cmd": "make test"})
        self.assertEqual(self.flags["demo · current"], {"dir": self.b, "starred": True})

    def test_adding_a_folder_that_is_registered_gives_its_project_back(self):
        self.add(self.a)
        self.flags["demo"]["alias"] = "First"
        again = self.add(self.a, "something else")
        self.assertEqual((again["name"], again["label"], again["renamed"]), ("demo", "First", True))
        self.assertEqual(list(self.flags), ["demo"])
        # another spelling of the same folder, and a symlink to it
        self.add(os.path.join(self.a, "..", "demo"))
        link = os.path.join(self.home, "link-to-demo")
        os.symlink(self.a, link)
        self.assertEqual(self.add(link)["name"], "demo")
        self.assertEqual(list(self.flags), ["demo"])

    def test_the_name_the_window_asks_for_is_kept_unless_another_folder_has_it(self):
        self.assertEqual(self.add(self.a, "My demo")["name"], "My demo")
        self.assertEqual(self.add(self.b, "My demo")["name"], "My demo · current")
        # the window sends the name it showed for the row: already told apart, so it goes in as it is
        self.assertEqual(PV.free_name("demo · x", self.b, {"demo": {"dir": self.a}}), "demo · x")

    def test_names_differ_by_case_too_and_a_label_is_a_name(self):
        self.add(self.a, "Demo")
        self.assertEqual(self.add(self.b, "demo")["name"], "demo · current")
        self.flags.clear()
        self.flags["内在知识提升"] = {"dir": "/Users/apple/Projects/内在知识提升", "alias": "讲书"}
        other = os.path.join(self.home, "x", "讲书")
        os.makedirs(other)
        self.assertEqual(self.add(other)["name"], "讲书 · x")

    def test_when_the_folder_above_is_not_enough_two_up_then_a_number(self):
        one = os.path.join(self.home, "a", "same", "demo")
        two = os.path.join(self.home, "b", "same", "demo")
        three = os.path.join(self.home, "c", "same", "demo")
        for d in (one, two, three):
            os.makedirs(d)
        self.assertEqual(self.add(one)["name"], "demo")
        self.assertEqual(self.add(two)["name"], "demo · same")
        self.assertEqual(self.add(three)["name"], "demo · c/same")
        self.assertEqual(PV.free_name("demo", "/demo", {"demo": {"dir": "/x"}}), "demo (2)")  # nothing above it to tell it apart

    def test_registries_keyed_by_name_alone_still_read(self):
        # written by an older Dispatch: names with no folder, one with an alias
        self.flags.update({"personal": {"starred": True}, "agents-config": {"archived": True}, "内在知识提升": {"alias": "讲书", "starred": True}})
        rows = {r["name"]: r for r in PV.registry(self.memories(), index={}, resolve_dirs=False)}
        self.assertEqual({n: (r["label"], r["dir"]) for n, r in rows.items()},
                         {"personal": ("personal", ""), "agents-config": ("agents-config", ""), "内在知识提升": ("讲书", "")})
        # a folder called personal takes the placeholder over (nothing else claims the name) ...
        mine = os.path.join(self.home, "Projects", "personal")
        os.makedirs(mine)
        self.assertEqual(self.add(mine)["name"], "personal")
        self.assertEqual(self.flags["personal"], {"starred": True, "dir": mine})
        # ... unless Dispatch already knows that project by another folder
        self.D.project_home = lambda name, *a: self.a if name == "agents-config" else ""
        elsewhere = os.path.join(self.home, "Documents", "agents-config")
        os.makedirs(elsewhere)
        self.assertEqual(self.add(elsewhere)["name"], "agents-config · Documents")
        self.assertEqual(self.flags["agents-config"], {"archived": True})

    def test_rename_sets_the_label_only(self):
        self.add(self.a)
        self.add(self.b)
        r = PV.rename("demo · current", "Demo two")
        self.assertEqual(r, {"ok": True, "name": "demo · current", "label": "Demo two"})
        self.assertEqual(self.flags["demo · current"], {"dir": self.b, "starred": True, "alias": "Demo two"})
        self.assertEqual(sorted(self.flags), ["demo", "demo · current"], "the project keeps its name: tasks and sessions are keyed by it")
        rows = {r["name"]: r["label"] for r in PV.registry(self.memories(), index={}, resolve_dirs=False)}
        self.assertEqual(rows, {"demo": "demo", "demo · current": "Demo two"})
        with self.assertRaises(ValueError):
            PV.rename("demo", "demo two")          # another project's label, any case, is taken
        with self.assertRaises(ValueError):
            PV.rename("demo", "Demo · Current")     # ... and so is its name
        with self.assertRaises(ValueError):
            PV.rename("nothing", "x")
        with self.assertRaises(ValueError):
            PV.rename("demo", "x" * 81)
        # back to the name: the alias goes
        self.assertEqual(PV.rename("demo · current", "")["label"], "demo · current")
        self.assertEqual(PV.rename("demo · current", "Demo two")["label"], "Demo two")
        self.assertEqual(PV.rename("demo · current", "DEMO · CURRENT")["label"], "demo · current")
        self.assertNotIn("alias", self.flags["demo · current"])

    def test_the_unregistered_rows_are_told_apart_and_add_registers_them_under_the_same_name(self):
        loose = {self.a: {"name": "demo", "label": "demo"}, self.b: {"name": "demo", "label": "demo"},
                 os.path.join(self.home, "Projects", "solo"): {"name": "solo", "label": "solo"}}
        PV.name_loose(loose, [])
        self.assertEqual([loose[f]["name"] for f in (self.a, self.b, os.path.join(self.home, "Projects", "solo"))],
                         ["demo · gx-hover-demo", "demo · current", "solo"])
        self.assertEqual([loose[f]["label"] for f in (self.a, self.b)], ["demo · gx-hover-demo", "demo · current"])
        # what the window sends for a row is the name it shows
        self.assertEqual(self.add(self.a, loose[self.a]["name"])["name"], "demo · gx-hover-demo")
        self.assertEqual(self.add(self.b, loose[self.b]["name"])["name"], "demo · current")
        # one folder that shares its name with a registered project is told apart from it
        loose = {self.b: {"name": "demo", "label": "demo"}}
        PV.name_loose(loose, [{"name": "demo", "label": "demo", "dir": self.a}])
        self.assertEqual(loose[self.b]["name"], "demo · current")

    def test_the_command_takes_rename_and_answers_ok_false_for_a_taken_name(self):
        self.add(self.a)
        self.add(self.b)
        out = []
        with patch("builtins.print", side_effect=lambda *a, **k: out.append(a[0])):
            self.assertEqual(PV.command(types.SimpleNamespace(op="rename", arg="demo · current", name="Second", json=True), self.D), 0)
            self.assertEqual(PV.command(types.SimpleNamespace(op="rename", arg="demo", name="second", json=True), self.D), 1)
        self.assertEqual(json.loads(out[0]), {"ok": True, "name": "demo · current", "label": "Second"})
        self.assertEqual(json.loads(out[1]), {"ok": False, "message": "There is already a project called second."})

    @unittest.skipUnless(shutil.which("bd"), "needs bd")
    def test_with_the_real_cli_two_demo_folders_are_two_projects(self):
        beads = os.path.join(self.home, "tasks", ".beads")
        env = {**os.environ, "HOME": self.home, "BEADS_DIR": beads, "DISPATCH_DIR": os.path.join(self.home, "tasks", ".dispatch")}
        env.pop("DISPATCH_SESSION_ROOT", None)
        cli = os.path.join(HERE, "dispatch.py")
        run = lambda *args: subprocess.run([sys.executable, cli, *args], env=env, capture_output=True, text=True, timeout=180)  # noqa: E731
        first = run("projects-view", "add", self.a, "--name", "demo", "--json")
        second = run("projects-view", "add", self.b, "--name", "demo", "--json")
        self.assertEqual((first.returncode, second.returncode), (0, 0), first.stderr + second.stderr)
        self.assertEqual((json.loads(first.stdout)["name"], json.loads(second.stdout)["name"]), ("demo", "demo · current"))
        self.assertTrue(json.loads(second.stdout)["renamed"])
        named = run("projects-view", "rename", "demo · current", "--name", "Demo two", "--json")
        self.assertEqual(json.loads(named.stdout), {"ok": True, "name": "demo · current", "label": "Demo two"})
        rows = json.loads(run("projects", "--json").stdout)
        self.assertEqual({r["name"]: (r["label"], r["dir"]) for r in rows}, {"demo": ("demo", self.a), "demo · current": ("Demo two", self.b)})


class Page(unittest.TestCase):
    def test_events(self):
        at = lambda day, hour=12, minute=0: datetime.datetime(2026, 9, day, hour, minute).timestamp()  # noqa: E731
        sessions = [  # as collect() keeps them: newest first
            {"id": "a", "at": at(27, 17, 5), "start": at(27, 16), "title": "Projects page", "prompt": "make the page", "agent": "claude-code", "host": "local"},
            {"id": "b", "at": at(26, 9), "start": None, "title": "", "prompt": "Reply with exactly this", "agent": "codex", "host": "local"},
            {"id": "c", "at": at(20), "start": at(20, 11), "title": "", "prompt": "", "agent": "claude-code", "host": "local"},
        ]
        commits = [{"at": at(27, 9), "hash": "db9eeae", "subject": "feat: x"}, {"at": at(24), "hash": "54a5866", "subject": "fix: y"}]
        running = [{"id": "a", "at": at(27, 17, 30), "title": "Projects page"},
                   {"id": "live", "at": at(27, 17, 40), "title": "", "agent": "codex", "host": "local"}]
        ev = PV.events(sessions, commits, running)
        s = ev["sessions"]
        self.assertEqual([e["id"] for e in s], ["c", "b", "a", "live"])   # oldest first; a running one the index lacks comes in
        self.assertEqual(s[2]["start"], at(27, 16))
        self.assertEqual(s[2]["at"], at(27, 17, 5))                        # the index's time, not the live row's
        self.assertEqual((s[2]["title"], s[2]["named"]), ("Projects page", True))
        self.assertEqual((s[1]["title"], s[1]["named"]), ("Reply with exactly this", False))  # no title: the first prompt
        self.assertEqual((s[0]["title"], s[0]["named"]), ("", False))
        self.assertEqual(s[3]["at"], at(27, 17, 40))
        self.assertEqual([c["hash"] for c in ev["commits"]], ["54a5866", "db9eeae"])
        self.assertEqual(set(ev["commits"][0]), {"at", "hash", "subject"})
        self.assertEqual(PV.events([], []), {"sessions": [], "commits": []})

    def test_first_line_and_epoch(self):
        self.assertEqual(PV._first_line("\n  hello there \nsecond"), "hello there")
        self.assertEqual(PV._first_line("x" * 300), "x" * 120)
        self.assertEqual(PV._first_line(None), "")
        self.assertEqual(PV._epoch("2026-09-27T21:37:42.356Z"), datetime.datetime(2026, 9, 27, 21, 37, 42, 356000, tzinfo=datetime.timezone.utc).timestamp())
        self.assertIsNone(PV._epoch(""))
        self.assertIsNone(PV._epoch("yesterday"))

    def test_now_session(self):
        self.assertEqual(PV._now_session({"state": "waiting", "waiting_session": "abc"}), "abc")
        self.assertEqual(PV._now_session({"state": "running", "running": [
            {"id": "idle", "state": "idle", "title": "x"}, {"id": "w1", "state": "working", "title": ""},
            {"id": "w2", "state": "working", "title": "Build"}]}), "w2")
        self.assertEqual(PV._now_session({"state": "running", "running": [{"id": "w1", "state": "working", "title": ""}]}), "w1")
        self.assertEqual(PV._now_session({"state": "quiet", "last_title": "Docs tab", "last_title_id": "d"}), "d")
        self.assertEqual(PV._now_session({"state": "quiet", "last_title_id": "d"}), "")

    def test_main_commits_author_time(self):
        with tempfile.TemporaryDirectory() as repo:
            env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@x", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@x")
            run = lambda *a, **kw: subprocess.run(["git", "-C", repo, *a], check=True, capture_output=True, env=dict(env, **kw))  # noqa: E731
            run("init", "-q", "-b", "main")
            run("commit", "-q", "--allow-empty", "-m", "old: before the window",
                GIT_AUTHOR_DATE="2026-09-01T10:00:00", GIT_COMMITTER_DATE="2026-09-01T10:00:00")
            # written on Sep 20, rebased (committed) on Sep 27: the chart puts it where the work was done
            run("commit", "-q", "--allow-empty", "-m", "feat: rebased later",
                GIT_AUTHOR_DATE="2026-09-20T10:00:00", GIT_COMMITTER_DATE="2026-09-27T10:00:00")
            since = datetime.datetime(2026, 9, 14).timestamp()
            got = PV.main_commits(repo, since)
        self.assertEqual([c["subject"] for c in got], ["feat: rebased later"])
        self.assertEqual(got[0]["at"], int(datetime.datetime(2026, 9, 20, 10).timestamp()))
        self.assertEqual(len(got[0]["hash"]), 7)
        self.assertEqual(PV.main_commits("", since), [])

    def test_now_line(self):
        self.assertEqual(PV._now_line({"state": "waiting", "waiting_phrase": "Allow git push?"}), "Waiting for you: Allow git push?")
        self.assertEqual(PV._now_line({"state": "running", "running": [{"state": "working", "title": "Build"}, {"state": "idle", "title": "x"}]}), "Running: Build")
        self.assertEqual(PV._now_line({"state": "running", "running": [{"state": "working", "title": "A"}, {"state": "working", "title": ""}]}), "2 sessions running: A")
        old = datetime.datetime(2026, 9, 21, 10).timestamp()
        self.assertTrue(PV._now_line({"state": "quiet", "last_at": old, "last_title": "Docs tab"}).startswith("Quiet since Sep 21."))
        self.assertEqual(PV._now_line({"state": "quiet", "last_at": 0}), "")


def entry(sid, cwd, mtime, title="", entrypoint="cli", agent="claude-code", **kw):
    return {"session_id": sid, "agent": agent, "cwd": cwd, "mtime": mtime, "title": title, "entrypoint": entrypoint, **kw}


class ThisMachine(unittest.TestCase):
    """One machine, one window: the page and its three recent projects are this machine's only."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # the test home sits in the system temp folder, which the page skips: only /private/tmp counts as temp here
        self.temp_prefixes, PV.TEMP_PREFIXES = PV.TEMP_PREFIXES, ("/private/tmp/", "/tmp/")
        self.addCleanup(setattr, PV, "TEMP_PREFIXES", self.temp_prefixes)
        home = self.home = self.tmp.name
        self.kanban = os.path.join(home, "Projects", "kanban")
        self.loose = os.path.join(home, "Projects", "bookmark")
        self.old = os.path.join(home, "Projects", "old")
        for d in (self.kanban, self.loose, self.old):
            os.makedirs(os.path.join(d, ".git"))
        self.flags = {"kanban": {"dir": self.kanban}, "后台": {"dir": "/Users/apple/Projects/后台", "starred": True},
                      "old": {"dir": self.old, "archived": True}}
        D, mem, _ = fake_dispatch(home, self.flags)
        D.DISPATCH_DIR = os.path.join(home, ".dispatch")
        D.project_of_cwd = lambda cwd, names, roots: ""
        D.home_relative = lambda cwd, host=None: cwd
        self.D, self.mem = D, mem
        PV.D = D

    def tearDown(self):
        self.tmp.cleanup()

    def index(self):
        return {
            "a": entry("a", self.kanban, 100, "Projects page"),
            "b": entry("b", self.kanban + "/app", 300, ""),                              # newer, no title: the time counts, the title stays
            "c": entry("c", self.kanban, 900, "checker run", entrypoint="sdk-cli"),     # headless claude -p: automation
            "d": entry("d", "/Users/apple/Projects/后台", 950, "on the mini"),           # ran on the mini (a copied transcript)
            "e": entry("e", self.loose, 200, "bookmarks"),                              # an unregistered folder here
            "f": entry("f", "/private/tmp/x", 990, "scratch"),
            "g": entry("g", self.home, 980, "home"),
            "h": entry("h", self.old, 970, "archived one"),
            "i": entry("i", self.loose, 150, "cron", entrypoint="cron"),
            "j": entry("j", self.kanban, 400, "in the app", entrypoint="sdk-cli"),      # Dispatch's own chat: a person
            "k": entry("k", self.kanban, 999, "sub", subagent=True),
        }

    def test_recent_leaves_out_automation_temp_home_other_macs_and_archived(self):
        import chat_protocol
        orig = chat_protocol.read_started
        chat_protocol.read_started = lambda d: {"claude-code:j": 1}
        try:
            reg = PV.registry(self.mem)
            rows = PV.recent(index=self.index(), reg=reg, live=[
                {"alive": True, "host": "local", "cwd": self.loose, "last_at": 500, "session_id": "live1", "title": ""},
                {"alive": True, "host": "local", "cwd": self.kanban, "last_at": 2000, "session_id": "c"},  # the checker, live: still automation
                {"alive": True, "host": "mini", "cwd": self.kanban, "last_at": 3000, "session_id": "z"}])
        finally:
            chat_protocol.read_started = orig
        self.assertEqual([(r["name"], r["last_at"], r["last_title"]) for r in rows],
                         [("bookmark", 500, "bookmarks"), ("kanban", 400, "in the app")])
        self.assertEqual(rows[1]["dir"], self.kanban)

    def test_the_page_lists_this_machine_only(self):
        D = self.D
        D.load_index = lambda: self.index()
        D.live_sessions = lambda local_only=False: [{"alive": True, "host": "local", "cwd": self.kanban, "state": "working", "session_id": "a", "last_at": 1000}]
        D.sh = lambda args, timeout=20: (0, json.dumps(self.mem, ensure_ascii=False), "") if args[:2] == ["bd", "memories"] else (0, "[]", "")
        D._mod = lambda name: (_ for _ in ()).throw(ImportError(name))  # no Waiting for you here
        D.INTERNAL_MEMORY_PREFIX = "dispatch-"
        D.docs_key = lambda n: "docs-" + n
        D.docs_entries_parse = D.docs_registered_rows = lambda x: []
        D.docs_scan = lambda dirs: []
        D.docs_merge = lambda a, b: list(a) + list(b)
        D.debug = lambda where, e: None
        res = PV.collect(now=time.time())
        names = [p["name"] for p in res["projects"]]
        self.assertIn("kanban", names)
        self.assertIn("bookmark", names)
        self.assertNotIn("后台", names)  # the mini's: its own projects-view lists it
        kanban = next(p for p in res["projects"] if p["name"] == "kanban")
        self.assertEqual({s["host"] for s in kanban["running"]}, {"local"})
        self.assertEqual((res["host"], res["host_name"]), ("local", "小蓝"))
        self.assertIsInstance(res["recent"], list)

    def test_two_unregistered_folders_of_one_name_are_two_rows_with_their_own_names(self):
        D = self.D
        one = os.path.join(self.home, "Projects", "gx-hover-demo", "demo")
        two = os.path.join(self.home, "Projects", "gx-hover-demo", "current", "demo")
        for d in (one, two):
            os.makedirs(os.path.join(d, ".git"))
        idx = self.index()
        idx["m"] = entry("m", one, 210, "first demo")
        idx["n"] = entry("n", two, 220, "second demo")
        D.load_index = lambda: idx
        D.live_sessions = lambda local_only=False: []
        D.sh = lambda args, timeout=20: (0, json.dumps(self.mem, ensure_ascii=False), "") if args[:2] == ["bd", "memories"] else (0, "[]", "")
        D._mod = lambda name: (_ for _ in ()).throw(ImportError(name))
        D.INTERNAL_MEMORY_PREFIX = "dispatch-"
        D.docs_key = lambda n: "docs-" + n
        D.docs_entries_parse = D.docs_registered_rows = lambda x: []
        D.docs_scan = lambda dirs: []
        D.docs_merge = lambda a, b: list(a) + list(b)
        D.debug = lambda where, e: None
        rows = {p["dir"]: p for p in PV.collect(now=time.time())["projects"]}
        self.assertEqual((rows[one]["name"], rows[two]["name"]), ("demo · gx-hover-demo", "demo · current"))
        self.assertEqual((rows[one]["label"], rows[two]["label"]), ("demo · gx-hover-demo", "demo · current"))
        self.assertEqual((rows[one]["all_sessions"], rows[two]["all_sessions"]), (1, 1))
        self.assertFalse(rows[one]["registered"] or rows[two]["registered"])
        # a folder that shares its name with a registered project is a row of its own, not that project's copy
        self.flags["demo"] = {"dir": one}
        self.mem["dispatch-projects"] = json.dumps(self.flags)
        rows = {p["dir"]: p for p in PV.collect(now=time.time())["projects"]}
        self.assertEqual((rows[one]["name"], rows[one]["registered"]), ("demo", True))
        self.assertEqual((rows[two]["name"], rows[two]["registered"]), ("demo · current", False))

    def test_theirs_keeps_another_macs_own_rows(self):
        old_answer = {"projects": [{"name": "会议记录", "host": "local", "last_at": 50, "last_title": "notes"},
                                   {"name": "kanban", "host": "hub", "last_at": 90},
                                   {"name": "archived", "host": "local", "last_at": 70, "archived": True},
                                   {"name": "后台", "host": "local", "last_at": 60}]}
        res = PV.theirs(old_answer, MINI)
        self.assertEqual([p["name"] for p in res["projects"]], ["会议记录", "archived", "后台"])
        self.assertEqual({(p["host"], p["machine"]) for p in res["projects"]}, {("mini", "mini")})
        self.assertEqual([r["name"] for r in res["recent"]], ["后台", "会议记录"])  # worked out here: an older dispatch sends none
        new_answer = {"projects": [], "recent": [{"name": "讲书"}]}
        self.assertEqual(PV.theirs(new_answer, MINI)["recent"], [{"name": "讲书"}])


class Automation(unittest.TestCase):
    def test_is_automation(self):
        self.assertTrue(PV.is_automation({"entrypoint": "cron"}))
        self.assertTrue(PV.is_automation({"entrypoint": "exec", "agent": "codex", "session_id": "x"}))
        self.assertTrue(PV.is_automation({"entrypoint": "cli", "scheduled": True}))
        self.assertFalse(PV.is_automation({"entrypoint": "sdk-cli", "agent": "claude-code", "session_id": "x"}, {"claude-code:x": 1}))
        self.assertFalse(PV.is_automation({"entrypoint": "vscode"}))


class Sidebar(unittest.TestCase):
    setUp = ThisMachine.setUp
    tearDown = ThisMachine.tearDown
    index = ThisMachine.index
    def test_headless_hidden_chatd_and_terminal_kept_and_worktrees_collapsed(self):
        index = self.index()
        # An actual linked worktree outside the usual naming convention, from a subfolder.
        wt = os.path.join(self.home, "feature")
        os.makedirs(os.path.join(wt, "src"))
        with open(os.path.join(wt, ".git"), "w") as f:
            f.write("gitdir: ../Projects/kanban/.git/worktrees/feature\n")
        index["work"] = entry("work", wt + "/src", 500, "Feature work")
        self.D.load_index = lambda: index
        result = PV.sidebar_registry(reg=PV.registry(self.mem), in_app={"claude-code:j": 1}, catalogs=[])
        policies = result["sessions"]
        self.assertTrue(policies["claude:c"]["one_shot"])
        self.assertTrue(policies["claude:c"]["hidden"])
        self.assertFalse(policies["claude:j"]["hidden"])
        self.assertFalse(policies["claude:a"]["hidden"])
        self.assertEqual((policies["claude:work"]["project"], policies["claude:work"]["worktree"]), ("kanban", True))
        kanban = next(p for p in result["projects"] if p["name"] == "kanban")
        self.assertEqual(kanban["worktree_group"], {"id": "worktrees", "label": "Worktrees", "collapsed": True})
        self.assertIn("c", index)  # search history is not pruned or archived

    def test_native_sdk_conversation_kept_without_chatd_registration(self):
        import ide_sessions as I
        index = {"sdk": entry("sdk", self.kanban, 500, "Actual user", entrypoint="sdk-cli")}
        catalog = {"provider": "claude", "id": "window", "external": False, "dirs": [self.kanban]}
        with patch.object(I, "native_id", return_value="sdk"):
            result = PV.sidebar_registry(index=index, reg=PV.registry(self.mem), in_app={}, catalogs=[("/test", catalog)])
        self.assertFalse(result["sessions"]["claude:sdk"]["hidden"])
        self.assertFalse(result["sessions"]["claude:window"]["hidden"])

    def test_demo_is_not_a_real_sidebar_project_but_works_in_its_isolated_instance(self):
        demo = "/private/tmp/dide-e2e/cli/demo"
        project = dict(PV.registry(self.mem)[0], name="demo", dir=demo, host="local")
        index = {"demo": entry("demo", demo, 500, "Demo")}
        with patch.dict(os.environ, {"DISPATCH_SESSION_ROOT": ""}):
            res = PV.sidebar_registry(index=index, reg=[project], in_app={}, catalogs=[])
        self.assertEqual(res["projects"], [])
        self.assertTrue(res["sessions"]["claude:demo"]["hidden"])
        with patch.dict(os.environ, {"DISPATCH_SESSION_ROOT": demo}):
            res = PV.sidebar_registry(index=index, reg=[project], in_app={}, catalogs=[])
        self.assertEqual(res["projects"][0]["name"], "demo")
        self.assertFalse(res["sessions"]["claude:demo"]["hidden"])


class SubAgentsAtWork(unittest.TestCase):
    """A sub-agent the Assistant sent out runs in the Assistant's folder: the sidebar learns its project from what it does."""

    def setUp(self):
        import dispatch as real
        self.tmp = tempfile.TemporaryDirectory()
        home = self.home = self.tmp.name
        self.kanban = os.path.join(home, "Projects", "kanban")
        self.eml = os.path.join(home, "Projects", "ALG")
        board = [{"id": "task-ab12", "title": "Show running sessions", "labels": ["project:kanban"]},
                 {"id": "task-cd34", "title": "Lecture two", "labels": ["project:ALG"]}]
        self.tv = types.SimpleNamespace(D=None, board_export=lambda: board)
        D = types.SimpleNamespace(HOME=home, DISPATCH_DIR=os.path.join(home, ".dispatch"), claims_of=real.claims_of,
                                  _index_rx=real._index_rx, task_prefix=lambda: "task", _mod=lambda name: self.tv)
        self.addCleanup(setattr, PV, "D", PV.D)
        PV.D = D
        self.by_dir = [(self.kanban, "kanban"), (self.eml, "ALG")]
        self.by_name = {"kanban": "kanban", "alg": "ALG"}
        self.parent = os.path.join(home, ".claude", "projects", "-x-dispatch-assistant", "p1.jsonl")
        os.makedirs(os.path.join(self.parent[:-6], "subagents"))
        with open(self.parent, "w") as f:
            f.write("{}\n")
        env = patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": os.path.join(home, ".claude")})
        env.start()
        self.addCleanup(env.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def sub(self, aid, tool_use, *lines, age=0):
        path = os.path.join(self.parent[:-6], "subagents", f"agent-{aid}.jsonl")
        with open(path[:-6] + ".meta.json", "w") as f:
            json.dump({"agentType": "opus-high", "description": aid, "toolUseId": tool_use}, f)
        with open(path, "a") as f:
            for line in lines:
                f.write(json.dumps(line, ensure_ascii=False) + "\n")
        if age:
            os.utime(path, (time.time() - age, time.time() - age))
        return path

    @staticmethod
    def brief(text):
        return {"type": "user", "message": {"role": "user", "content": text}}

    @staticmethod
    def call(name, **inp):
        return {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t", "name": name, "input": inp}]}}

    def test_the_claimed_task_names_the_project_and_its_title_comes_along(self):
        self.sub("a1", "toolu_A", self.brief(f"You are in {self.eml}."), self.call("mcp__dispatch__task_claim", task="task-ab12"))
        got = PV.subagents_at_work(self.by_dir, self.by_name)
        self.assertEqual(got, {"toolu_A": {"project": "kanban", "task": "task-ab12", "task_title": "Show running sessions"}})

    def test_without_a_claim_the_folder_its_own_calls_name_most_wins_over_its_brief(self):
        self.sub("a2", "toolu_B", self.brief(f"Repo: {self.eml}"),
                 self.call("Bash", command=f"cd {self.kanban} && git status"), self.call("Read", file_path=f"{self.kanban}/README.md"),
                 {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": f"{self.eml} {self.eml} {self.eml}"}]}})
        self.sub("a3", "toolu_C", self.brief(f"Read-only look at {self.eml}, report back."))
        got = PV.subagents_at_work(self.by_dir, self.by_name)
        self.assertEqual(got["toolu_B"]["project"], "kanban")
        self.assertEqual(got["toolu_C"]["project"], "ALG")

    def test_a_folder_that_only_starts_like_a_project_is_not_it_and_old_records_are_left_out(self):
        self.sub("a4", "toolu_D", self.brief("hello"), self.call("Bash", command=f"cd {self.kanban}-old && ls"))
        self.sub("a5", "toolu_E", self.brief(f"Repo {self.kanban}"), age=PV.SUBAGENT_WINDOW + 60)
        self.assertEqual(PV.subagents_at_work(self.by_dir, self.by_name), {})

    def test_a_record_is_read_on_from_where_it_stopped(self):
        path = self.sub("a6", "toolu_F", self.brief(f"Repo {self.kanban}"))
        self.assertEqual(PV.subagents_at_work(self.by_dir, self.by_name)["toolu_F"]["project"], "kanban")
        with open(os.path.join(PV.D.DISPATCH_DIR, "subagent-work.json")) as f:
            self.assertEqual(json.load(f)["records"][path]["off"], os.path.getsize(path))
        self.sub("a6", "toolu_F", self.call("mcp__dispatch__task_claim", task="task-cd34"))
        got = PV.subagents_at_work(self.by_dir, self.by_name)["toolu_F"]
        self.assertEqual((got["project"], got["task_title"]), ("ALG", "Lecture two"))
        # a half-written last line waits for the next read
        with open(path, "a") as f:
            f.write('{"type":"assistant","message":')
        PV.subagents_at_work(self.by_dir, self.by_name)
        with open(os.path.join(PV.D.DISPATCH_DIR, "subagent-work.json")) as f:
            self.assertEqual(json.load(f)["records"][path]["off"], os.path.getsize(path) - len('{"type":"assistant","message":'))

    def test_no_claude_folder_is_nothing_at_work(self):
        shutil.rmtree(os.path.join(self.home, ".claude"))
        self.assertEqual(PV.subagents_at_work(self.by_dir, self.by_name), {})

if __name__ == "__main__":
    unittest.main()
