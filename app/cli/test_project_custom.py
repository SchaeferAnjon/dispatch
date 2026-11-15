# -*- coding: utf-8 -*-
"""project_custom.py: one project's own settings (its look in the sidebar, and later its tools, agent files, copies)."""
import json
import os
import shutil
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import project_custom as PC  # noqa: E402
import projects_view as PV  # noqa: E402

PNG_1PX = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201"
                        "a5d1f4d00000000049454e44ae426082")


def fake(home, flags, custom=None):
    mem = {"dispatch-projects": json.dumps(flags), "dispatch-project-owners": "{}"}
    if custom is not None:
        mem[PC.CUSTOM_KEY] = json.dumps(custom)

    def sh(args, timeout=20, env=None):
        if args[:2] == ["bd", "memories"]:
            return 0, json.dumps(mem), ""
        return 0, "", ""

    D = types.SimpleNamespace(
        HOME=home, PROJECT_FLAGS_KEY="dispatch-projects", PROJECT_OWNERS_KEY="dispatch-project-owners",
        project_flags_parse=lambda raw: json.loads(raw) if raw else {},
        project_owners_parse=lambda raw: json.loads(raw) if raw else {},
        project_owner_is_here=lambda rec: True, hosts=lambda: [], local_host_name=lambda: "here",
        project_names=lambda: {}, settings_load=lambda: {}, load_index=lambda: {},
        project_home=lambda name, *a: "", project_flags_load=lambda strict=False: json.loads(mem["dispatch-projects"]),
        wiki_store=lambda k, v: mem.__setitem__(k, v), project_dirs=lambda reload=False: {}, sh=sh,
    )
    return D, mem


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pc-")
        self.home = os.path.join(self.tmp, "home")
        self.proj = os.path.join(self.home, "Projects", "shop")
        os.makedirs(os.path.join(self.proj, "public"))
        self.env = mock.patch.dict(os.environ, {"DISPATCH_HOME": os.path.join(self.tmp, "dh")})
        self.env.start()
        self.D, self.mem = fake(self.home, {"shop": {"dir": self.proj, "alias": "Shop front"}})
        PC.D = self.D
        PV.D = self.D

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def stored(self):
        return json.loads(self.mem.get(PC.CUSTOM_KEY) or "{}")


class Looks(Base):
    def test_a_new_project_is_a_plain_folder_without_colour(self):
        r = PC.show("shop")
        self.assertEqual(r["look"], {"icon": "folder"})
        self.assertNotIn("look", PV.registry()[0])  # nothing for the sidebar to draw differently

    def test_symbol_and_colour_reach_the_sidebar(self):
        r = PC.set_look("Shop front", icon="symbol", symbol="rocket", color="teal")
        self.assertEqual(r["look"], {"icon": "symbol", "symbol": "rocket", "color": "teal"})
        self.assertEqual(self.stored()["shop"]["look"], {"icon": "symbol", "symbol": "rocket", "color": "teal"})
        self.assertEqual(PV.registry()[0]["look"], {"icon": "symbol", "symbol": "rocket", "color": "teal"})

    def test_changing_the_icon_keeps_the_colour_and_folder_none_goes_back_to_plain(self):
        PC.set_look("shop", emoji="🚀", color="amber")
        r = PC.set_look("shop", icon="folder")
        self.assertEqual(r["look"], {"icon": "folder", "color": "amber"})
        r = PC.set_look("shop", color="none")
        self.assertIsNone(r["look"])
        self.assertNotIn("shop", self.stored())

    def test_refuses_what_it_does_not_offer(self):
        for kw in ({"symbol": "not-a-codicon"}, {"emoji": "abc"}, {"color": "#ff0000"}, {"icon": "letters"}):
            with self.assertRaises(PC.Problem):
                PC.set_look("shop", **kw)
        with self.assertRaises(PC.Problem):
            PC.set_look("nobody", icon="folder")
        self.assertEqual(self.stored(), {})

    def test_emoji_check(self):
        for ok in ("🚀", "❤️", "🛠️", "👩‍💻", "🇨🇳"):
            self.assertTrue(PC.is_emoji(ok), ok)
        for bad in ("", "a", "中", "1", "rocket", "🚀🚀🚀🚀🚀🚀🚀🚀🚀"):
            self.assertFalse(PC.is_emoji(bad), bad)

    def test_a_picture_is_copied_and_drawn_inline(self):
        src = os.path.join(self.proj, "public", "logo.png")
        with open(src, "wb") as f:
            f.write(PNG_1PX)
        found = PC.show("shop")["pictures"]
        self.assertEqual([p["rel"] for p in found], ["public/logo.png"])
        self.assertTrue(found[0]["data"].startswith("data:image/png;base64,"))
        r = PC.set_look("shop", picture=src)
        self.assertEqual(r["look"]["icon"], "picture")
        self.assertTrue(r["look"]["picture_data"].startswith("data:image/"))
        kept = self.stored()["shop"]["look"]["picture"]
        self.assertTrue(kept.startswith(os.path.join(self.tmp, "dh", "project-icons")))
        os.remove(src)  # the original can go: the sidebar keeps its copy
        self.assertEqual(PV.registry()[0]["look"]["icon"], "picture")
        PC.set_look("shop", icon="symbol")
        self.assertFalse(os.path.exists(kept))

    def test_a_missing_copy_falls_back_to_the_folder(self):
        self.mem[PC.CUSTOM_KEY] = json.dumps({"shop": {"look": {"icon": "picture", "picture": "/nowhere/x.png", "color": "blue"}}})
        self.assertEqual(PV.registry()[0]["look"], {"icon": "folder", "color": "blue"})

    def test_pictures_skip_big_and_unrelated_files(self):
        for rel in ("README.png", "node_modules/icon.png", "icons/icon.svg", "favicon.ico"):
            p = os.path.join(self.proj, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(PNG_1PX if rel.endswith(".png") else b"<svg xmlns='http://www.w3.org/2000/svg'/>")
        rels = [p["rel"] for p in PC.find_pictures(self.proj)]
        self.assertEqual(rels, ["icons/icon.svg", "favicon.ico"])

    def test_an_unreadable_board_is_never_saved_back(self):
        self.D.sh = lambda args, timeout=20, env=None: (1, "", "circuit breaker is open")
        with self.assertRaises(PC.Problem):
            PC.update("shop", "look", {"icon": "emoji", "emoji": "🚀"})


class Tools(Base):
    def test_show_lists_the_tools_and_a_switch_reaches_the_engine_files(self):
        import mcp_config
        seen = []
        with mock.patch.object(mcp_config, "project_tools", lambda folder, env=None: {"folder": folder, "tools": [{"name": "github"}]}), \
             mock.patch.object(mcp_config, "set_project_tool", lambda folder, name, engine, on, env=None: seen.append((folder, name, engine, on)) or {"engine": engine, "path": "x", "backup": "", "note": ""}):
            self.assertEqual(PC.show("shop")["tools"]["tools"], [{"name": "github"}])
            r = PC.set_tool("Shop front", "github", "codex", False)
        self.assertTrue(r["ok"])
        self.assertEqual(seen, [(self.proj, "github", "codex", False)])

    def test_a_project_on_another_mac_has_no_switches_here(self):
        self.D, self.mem = fake(self.home, {"far": {"dir": "/Users/someone/Projects/far"}})
        PC.D = PV.D = self.D
        self.assertIsNone(PC.show("far")["tools"])
        with self.assertRaises(PC.Problem):
            PC.set_tool("far", "github", "codex", False)


class Copies(Base):
    def test_the_switch_is_on_until_turned_off(self):
        self.assertTrue(PC.copies_of(self.proj, {})["auto"])
        PC.set_copies("shop", False)
        self.assertEqual(self.stored()["shop"]["copies"], {"auto": False})
        self.assertFalse(PC.copies_of(self.proj, self.stored()["shop"])["auto"])
        PC.set_copies("shop", True)
        self.assertNotIn("shop", self.stored())


class Command(Base):
    def run_cmd(self, *argv):
        import argparse
        p = argparse.ArgumentParser()
        sub = p.add_subparsers()
        PC.add_parser(sub, self.D)
        a = p.parse_args(["project-custom", *argv])
        out = []
        with mock.patch("builtins.print", side_effect=lambda *x, **k: out.append(x[0])):
            code = PC.command(a, self.D)
        return code, out

    def test_json_show_and_errors(self):
        code, out = self.run_cmd("look", "shop", "--emoji", "🎨", "--json")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out[-1])["look"], {"icon": "emoji", "emoji": "🎨"})
        code, out = self.run_cmd("show", "shop", "--json")
        self.assertEqual(json.loads(out[-1])["look"]["emoji"], "🎨")
        code, out = self.run_cmd("look", "shop", "--color", "pink", "--json")
        self.assertEqual(code, 1)
        self.assertFalse(json.loads(out[-1])["ok"])


if __name__ == "__main__":
    unittest.main()
