"""A temporary HOME for the terminal scenario (scenarios/terminal.mjs declares it: meta.instance.fixture
"terminal-home"). The HOME is <instance>/term-home. It has a sample Ghostty file (a font, a size, a theme file, a cursor) and the
real Claude Code linked into its ~/.local/bin, so the terminal shows Claude Code's own first-run screen without a
sign-in and without sending anything. The instance is otherwise the usual one: the demo project, a board of its own.
"""
import os
import shutil


GHOSTTY = '# a person\'s Ghostty settings\nfont-family = "Menlo"\nfont-size = 15\ntheme = Midnight\ncursor-style = bar\ncursor-style-blink = false\nkeybind = cmd+t=new_tab\nwindow-padding-x = 8\n'
THEME = "background = #0b1020\nforeground = #d6deeb\npalette = 1=#ef5350\npalette = 2=#22da6e\n"


def make_home(home):
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(os.path.join(home, ".config", "ghostty", "themes"))
    os.makedirs(os.path.join(home, ".local", "bin"))
    with open(os.path.join(home, ".config", "ghostty", "config"), "w", encoding="utf-8") as f:
        f.write(GHOSTTY)
    with open(os.path.join(home, ".config", "ghostty", "themes", "Midnight"), "w", encoding="utf-8") as f:
        f.write(THEME)
    real = next((p for p in (os.path.expanduser("~/.local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude") if os.path.exists(p)), "")
    if real:
        os.symlink(real, os.path.join(home, ".local", "bin", "claude"))


def prepare(rec):
    """`instance start --fixture terminal-home` (scenarios/terminal.mjs): the app and its terminals get this HOME."""
    home = os.path.join(rec["root"], "term-home")
    make_home(home)
    return {"env": {"HOME": home, "XDG_CONFIG_HOME": os.path.join(home, ".config"), "PATH_PREPEND": os.path.join(home, ".local", "bin")},
            "record": {"term_home": home}}
