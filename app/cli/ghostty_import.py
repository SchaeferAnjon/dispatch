# -*- coding: utf-8 -*-
"""Read a person's Ghostty settings and say what Dispatch's terminal would take from them.

Ghostty keeps its settings in a small text file (`key = value` lines). When one is on this Mac, Dispatch offers
to bring over the look: the font, the font size, the colors and the cursor. Nothing else is touched (no keyboard
shortcuts, no window settings), and nothing is written here: `preview()` only reads and answers what the
terminal's settings would become, as VS Code setting names. The window applies them.

Where Ghostty keeps the file, which lines count, and how a `theme =` line is followed to the colors in the theme
file are ported from Orca's Ghostty import (https://github.com/stablyai/orca, src/main/ghostty/*.ts), which is
under the MIT License:

    MIT License

    Copyright (c) 2026 Lovecast Inc.

    Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
    associated documentation files (the "Software"), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
    following conditions:

    The above copyright notice and this permission notice shall be included in all copies or substantial
    portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
    LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
    EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
    IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
    USE OR OTHER DEALINGS IN THE SOFTWARE.
"""
import os
import re
import sys

MAX_CONFIG_BYTES = 1000000  # a real file is a few KB; anything bigger is not one
MAX_THEME_BYTES = 262144
HEX = re.compile(r"^#?([0-9a-fA-F]{3}){1,2}$")

# Ghostty's 16 palette entries -> VS Code's terminal colors
ANSI = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White",
        "BrightBlack", "BrightRed", "BrightGreen", "BrightYellow", "BrightBlue", "BrightMagenta", "BrightCyan", "BrightWhite"]
# a theme file may only bring colors, never fonts or window settings
THEME_COLOR_KEYS = {"palette", "background", "foreground", "cursor-color", "cursor-text", "selection-background", "selection-foreground"}


def home():
    return os.path.expanduser("~")


def config_paths():
    """Where Ghostty looks, in the order it reads: a later file overrides an earlier one. The modern file name comes
    before the old `config`; the XDG folder before the macOS one."""
    xdg = os.environ.get("XDG_CONFIG_HOME")
    dirs = [os.path.join(xdg, "ghostty") if xdg else os.path.join(home(), ".config", "ghostty")]
    if sys.platform == "darwin":
        dirs.append(os.path.join(home(), "Library", "Application Support", "com.mitchellh.ghostty"))
    return [os.path.join(d, name) for d in dirs for name in ("config.ghostty", "config")]


def theme_dirs():
    """Ghostty's own themes folder shadows the ones inside the app."""
    xdg = os.environ.get("XDG_CONFIG_HOME")
    out = [os.path.join(xdg, "ghostty", "themes") if xdg else os.path.join(home(), ".config", "ghostty", "themes")]
    if os.environ.get("GHOSTTY_RESOURCES_DIR"):
        out.append(os.path.join(os.environ["GHOSTTY_RESOURCES_DIR"], "themes"))
    elif sys.platform == "darwin":
        out.append("/Applications/Ghostty.app/Contents/Resources/ghostty/themes")
    else:
        out += ["/usr/share/ghostty/themes", "/usr/local/share/ghostty/themes"]
    return out


def _strip_inline_comment(value):
    in_single = in_double = False
    for i, ch in enumerate(value):
        prev = value[i - 1] if i else ""
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif ch == "#" and not in_single and not in_double and prev in (" ", "\t"):
            return value[:i].strip()
    return value.strip()


def parse(text):
    """`key = value` lines into {key: value}, a key given more than once into a list. A `#` starts a comment only after
    a space, so a color like #1a1a1a survives; quotes around a value are dropped."""
    out = {}
    for raw in text.split("\n"):
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = _strip_inline_comment(value.strip())
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if not key:
            continue
        if key not in out:
            out[key] = value
        elif isinstance(out[key], list):
            out[key].append(value)
        else:
            out[key] = [out[key], value]
    return out


def _as_list(value):
    return [] if value is None else value if isinstance(value, list) else [value]


def _last(value):
    items = _as_list(value)
    return items[-1] if items else ""


def _read(path, limit):
    try:
        if os.path.getsize(path) > limit:
            return None
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def theme_colors(name):
    """The colors in the Ghostty theme called `name` (or at the full path `name`): {} keys limited to THEME_COLOR_KEYS;
    None when there is no such theme."""
    if os.path.isabs(name):
        paths = [name]
    elif "/" in name or "\\" in name or name in (".", ".."):
        return None  # only a plain name is looked up in the themes folders
    else:
        paths = [os.path.join(d, name) for d in theme_dirs()]
    for path in paths:
        text = _read(path, MAX_THEME_BYTES)
        if text is not None:
            return {k: v for k, v in parse(text).items() if k in THEME_COLOR_KEYS}
    return None


def _merge(base, extra):
    for key, value in extra.items():
        if key == "palette":
            base[key] = _as_list(base.get(key)) + _as_list(value)
        else:
            base[key] = value


def _with_theme(parsed, theme):
    """`parsed` plus the colors of `theme` as defaults: a line in the person's own file wins, their palette lines come after
    the theme's so a single entry still overrides. False when the theme file is missing."""
    colors = theme_colors(theme) if theme else {}
    if colors is None:
        return None
    out = dict(parsed)
    for key, value in colors.items():
        if key == "palette":
            out[key] = _as_list(value) + _as_list(parsed.get(key))
        elif key not in out:
            out[key] = value
    return out


def _hex(value):
    return value if value.startswith("#") else "#" + value


def colors_of(parsed):
    """Ghostty color lines -> VS Code `workbench.colorCustomizations` entries for the terminal."""
    out = {}
    one = {"background": "terminal.background", "foreground": "terminal.foreground", "cursor-color": "terminalCursor.foreground",
           "cursor-text": "terminalCursor.background", "selection-background": "terminal.selectionBackground",
           "selection-foreground": "terminal.selectionForeground"}
    for key, target in one.items():
        value = _last(parsed.get(key)).strip()
        if value and HEX.match(value):
            out[target] = _hex(value)
    for entry in _as_list(parsed.get("palette")):
        idx, _, color = entry.partition("=")
        idx, color = idx.strip(), color.strip()
        if idx.isdigit() and int(idx) < 16 and HEX.match(color):
            out["terminal.ansi" + ANSI[int(idx)]] = _hex(color)
    return out


def _font_family(value):
    """Ghostty lists the font first and its fallbacks after; VS Code takes one list. A name with a space is quoted."""
    names = [v.strip() for v in _as_list(value) if v.strip()]
    return ", ".join('"%s"' % n if re.search(r"[\s,]", n) and not n.startswith('"') else n for n in names)


def settings_of(parsed):
    """Font, font size and cursor -> VS Code terminal settings."""
    out = {}
    family = _font_family(parsed.get("font-family"))
    if family:
        out["terminal.integrated.fontFamily"] = family
    size = _last(parsed.get("font-size")).strip()
    try:
        number = float(size)
        if 0 < number <= 100:
            out["terminal.integrated.fontSize"] = int(number) if number == int(number) else number
    except ValueError:
        pass
    style = _last(parsed.get("cursor-style")).strip()
    if style in ("bar", "block", "underline"):
        out["terminal.integrated.cursorStyle"] = "line" if style == "bar" else style
    blink = _last(parsed.get("cursor-style-blink")).strip()
    if blink in ("true", "false"):
        out["terminal.integrated.cursorBlinking"] = blink == "true"
    return out


def _theme_pair(name):
    """`light:A,dark:B` -> {light: A, dark: B}; a plain name -> {}."""
    parts = [p.strip() for p in name.split(",")]
    pair = {}
    for part in parts:
        for scheme in ("light", "dark"):
            if part.startswith(scheme + ":"):
                pair[scheme] = part[len(scheme) + 1:].strip()
    return pair


def preview(env=None):
    """What Dispatch would take from the Ghostty settings on this Mac:
    {found, paths, summary{font, size, theme, cursor}, settings, colors, colors_by_scheme, left_out, error}.
    `settings` and `colors` are VS Code setting names; `colors_by_scheme` is {light, dark} when the person's theme
    differs by appearance (then `colors` is empty). `left_out` lists the Ghostty lines Dispatch does not take.
    A file that cannot be read answers found False with `error`."""
    paths, parsed, error = [], {}, ""
    for path in config_paths():
        if not os.path.isfile(path):
            continue
        text = _read(path, MAX_CONFIG_BYTES)
        if text is None:
            error = error or "Ghostty's settings file could not be read."
            continue
        _merge(parsed, parse(text))
        paths.append(path)
    if not paths:
        return {"found": False, "paths": [], "error": error}
    theme = _last(parsed.pop("theme", None)).strip()
    pair = _theme_pair(theme) if theme else {}
    settings = settings_of(parsed)
    colors, by_scheme, theme_missing = {}, None, False
    if pair:
        by_scheme = {}
        for scheme, name in pair.items():
            merged = _with_theme(parsed, name)
            if merged is None:
                theme_missing = True
                continue
            by_scheme[scheme] = colors_of(merged)
        by_scheme = {k: v for k, v in by_scheme.items() if v} or None
    else:
        merged = _with_theme(parsed, theme)
        if merged is None:
            theme_missing = True
            merged = parsed
        colors = colors_of(merged)
    taken = {"font-family", "font-size", "cursor-style", "cursor-style-blink", "background", "foreground", "cursor-color",
             "cursor-text", "selection-background", "selection-foreground", "palette"}
    left_out = sorted(k for k in parsed if k not in taken)
    if theme_missing:
        left_out.append("theme")
    summary = {"font": next((v.strip() for v in _as_list(parsed.get("font-family")) if v.strip()), ""), "size": settings.get("terminal.integrated.fontSize"),
               "theme": theme, "cursor": _last(parsed.get("cursor-style")).strip()}
    if not settings and not colors and not by_scheme:
        return {"found": False, "paths": paths, "error": error, "empty": True}
    return {"found": True, "paths": paths, "summary": summary, "settings": settings, "colors": colors,
            "colors_by_scheme": by_scheme, "left_out": left_out, "error": error}
