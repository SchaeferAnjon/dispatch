# -*- coding: utf-8 -*-
"""Reading a person's Ghostty settings. Everything lives in a temporary HOME."""
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import ghostty_import as G


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


class Parse(unittest.TestCase):
    def test_lines_comments_quotes_and_repeated_keys(self):
        p = G.parse('# top\nfont-family = "JetBrains Mono"\nfont-family = Menlo\nbackground = #1a1a1a # dark\ntheme = \'Nord\'\nno equals\n=\n')
        self.assertEqual(p["font-family"], ["JetBrains Mono", "Menlo"])
        self.assertEqual(p["background"], "#1a1a1a")  # a # right after the value's start stays, one after a space is a comment
        self.assertEqual(p["theme"], "Nord")
        self.assertNotIn("no equals", p)

    def test_a_hash_inside_quotes_is_not_a_comment(self):
        self.assertEqual(G.parse('font-family = "A # B"')["font-family"], "A # B")


class Preview(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.home = self.tmp
        for p in (mock.patch.object(G, "home", lambda: self.tmp),
                  mock.patch.dict(os.environ, {"HOME": self.tmp, "XDG_CONFIG_HOME": "", "GHOSTTY_RESOURCES_DIR": os.path.join(self.tmp, "res")})):
            p.start()
            self.addCleanup(p.stop)
        self.config = os.path.join(self.tmp, ".config", "ghostty", "config")

    def test_no_file_means_nothing_to_offer(self):
        self.assertEqual(G.preview(), {"found": False, "paths": [], "error": ""})

    def test_font_size_cursor_and_colors_become_vs_code_settings(self):
        write(self.config, 'font-family = "JetBrains Mono"\nfont-family = Symbols Nerd Font\nfont-size = 13.5\ncursor-style = bar\n'
                           'cursor-style-blink = false\nbackground = 101010\nforeground = #eeeeee\npalette = 1=#ff0000\npalette = 9=#ff8888\n'
                           'keybind = cmd+t=new_tab\nwindow-padding-x = 8\n')
        r = G.preview()
        self.assertTrue(r["found"])
        self.assertEqual(r["settings"], {"terminal.integrated.fontFamily": '"JetBrains Mono", "Symbols Nerd Font"',
                                         "terminal.integrated.fontSize": 13.5, "terminal.integrated.cursorStyle": "line",
                                         "terminal.integrated.cursorBlinking": False})
        self.assertEqual(r["colors"], {"terminal.background": "#101010", "terminal.foreground": "#eeeeee",
                                       "terminal.ansiRed": "#ff0000", "terminal.ansiBrightRed": "#ff8888"})
        self.assertEqual(r["summary"], {"font": "JetBrains Mono", "size": 13.5, "theme": "", "cursor": "bar"})
        self.assertIn("keybind", r["left_out"])  # shortcuts are not taken
        self.assertIn("window-padding-x", r["left_out"])

    def test_a_whole_number_size_is_a_number_and_a_silly_one_is_dropped(self):
        write(self.config, "font-size = 14\ncursor-style = block\n")
        self.assertEqual(G.preview()["settings"]["terminal.integrated.fontSize"], 14)
        write(self.config, "font-size = 0\nfont-family = Menlo\n")
        self.assertNotIn("terminal.integrated.fontSize", G.preview()["settings"])

    def test_a_theme_name_brings_its_colors_and_the_persons_own_lines_win(self):
        write(os.path.join(self.tmp, "res", "themes", "Midnight"), "background = #000011\nforeground = #ffffff\npalette = 0=#111111\nfont-family = Evil\n")
        write(self.config, "theme = Midnight\nforeground = #cccccc\npalette = 0=#222222\n")
        r = G.preview()
        self.assertEqual(r["colors"]["terminal.background"], "#000011")
        self.assertEqual(r["colors"]["terminal.foreground"], "#cccccc")
        self.assertEqual(r["colors"]["terminal.ansiBlack"], "#222222")
        self.assertNotIn("terminal.integrated.fontFamily", r["settings"])  # a theme only brings colors
        self.assertEqual(r["summary"]["theme"], "Midnight")

    def test_the_persons_own_themes_folder_comes_before_the_one_in_the_app(self):
        write(os.path.join(self.tmp, "res", "themes", "Mine"), "background = #111111\n")
        write(os.path.join(self.tmp, ".config", "ghostty", "themes", "Mine"), "background = #222222\n")
        write(self.config, "theme = Mine\n")
        self.assertEqual(G.preview()["colors"]["terminal.background"], "#222222")

    def test_a_theme_that_is_not_there_is_left_out_and_the_rest_still_comes(self):
        write(self.config, "theme = Nowhere\nfont-size = 12\nbackground = #123456\n")
        r = G.preview()
        self.assertIn("theme", r["left_out"])
        self.assertEqual(r["colors"], {"terminal.background": "#123456"})

    def test_a_theme_name_cannot_walk_out_of_the_themes_folder(self):
        write(os.path.join(self.tmp, "secret"), "background = #abcdef\n")
        write(self.config, "theme = ../../secret\nfont-size = 12\n")
        self.assertNotIn("terminal.background", G.preview()["colors"])

    def test_a_light_dark_pair_gives_colors_for_each_appearance(self):
        write(os.path.join(self.tmp, "res", "themes", "Day"), "background = #ffffff\n")
        write(os.path.join(self.tmp, "res", "themes", "Night"), "background = #000000\n")
        write(self.config, "theme = light:Day,dark:Night\nfont-size = 12\n")
        r = G.preview()
        self.assertEqual(r["colors"], {})
        self.assertEqual(r["colors_by_scheme"], {"light": {"terminal.background": "#ffffff"}, "dark": {"terminal.background": "#000000"}})

    def test_the_macos_folder_overrides_the_xdg_one(self):
        if sys.platform != "darwin":
            self.skipTest("macOS only")
        write(self.config, "font-size = 12\n")
        write(os.path.join(self.tmp, "Library", "Application Support", "com.mitchellh.ghostty", "config"), "font-size = 15\n")
        r = G.preview()
        self.assertEqual(r["settings"]["terminal.integrated.fontSize"], 15)
        self.assertEqual(len(r["paths"]), 2)

    def test_a_file_with_only_things_dispatch_does_not_take_offers_nothing(self):
        write(self.config, "keybind = cmd+t=new_tab\nwindow-padding-x = 8\n")
        r = G.preview()
        self.assertFalse(r["found"])
        self.assertTrue(r.get("empty"))

    def test_a_huge_file_is_not_read(self):
        write(self.config, "font-size = 12\n" + "# x\n" * 300000)
        r = G.preview()
        self.assertFalse(r["found"])
        self.assertTrue(r["error"])


if __name__ == "__main__":
    unittest.main()
