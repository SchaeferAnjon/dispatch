# -*- coding: utf-8 -*-
"""`dispatch project-custom`: what a person sets for one project in the Agents window's Customize page.

  show <project> [--json]
      Everything the page shows: the project's look (its icon and colour in the sidebar), the pictures
      found in its folder that could be its icon, and the choices the page offers; the tools its agents get;
      its own agent settings (instructions, hooks) and what Dispatch adds next to them (agent_files.py).
  look <project> [--icon folder|symbol|emoji|picture] [--symbol NAME] [--emoji E] [--picture FILE] [--color NAME|none]
      Sets the look. A project starts as a plain folder with no colour (the user, 10-01: no letters, no colour
      picked for them, 「否则我们项目太乱了」); everything else is chosen here. --icon folder with --color none
      goes back to that. A picture is copied (96 px PNG) into ~/.dispatch/project-icons, so moving or deleting the
      original does not break the sidebar.
  tool <project> --server NAME --engine claude-code|codex|opencode --on|--off
      Lets the agents in this project use an MCP server, or keeps them from it, without touching other projects
      (each engine's own per-project setting: mcp_config.set_project_tool).
  copies <project> --auto on|off
      Whether a copy of the project for parallel work gets ready on its own (copy_ready.py: .env and the
      person's ignored agent settings copied, node_modules / .venv shared, the rest installed). On by default.

The settings live in one shared board memory, `dispatch-project-custom` ({name: {look: {...}}}), next to
`dispatch-projects` (star, archive, folder, label) but apart from it: an older dispatch on another Mac rewrites
`dispatch-projects` with only the fields it knows, and would drop these.
"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata

D = None  # dispatch, set by command()

CUSTOM_KEY = "dispatch-project-custom"

# The colour goes on the icon only (DESIGN.md: colour is for status, the app icon and the Sessions badge; the user
# chose a project colour as a fourth place, on the icon alone). The app icon's own colours, same values (Dispatch IDE's base/common/dispatchPalette.ts).
COLORS = [
    {"id": "green", "hex": "#2e8b57", "label": "Green"},
    {"id": "amber", "hex": "#c28a12", "label": "Amber"},
    {"id": "coral", "hex": "#c9683f", "label": "Coral"},
    {"id": "purple", "hex": "#6e56cf", "label": "Purple"},
    {"id": "blue", "hex": "#1d5fd1", "label": "Blue"},
    {"id": "teal", "hex": "#2f6f73", "label": "Teal"},
    {"id": "gray", "hex": "#8a857c", "label": "Gray"},
]
COLOR_IDS = {c["id"] for c in COLORS}
# codicons the window draws (all in VS Code 1.139's codicon set)
SYMBOLS = ["code", "terminal", "globe", "device-mobile", "server", "database", "cloud", "package", "rocket",
           "beaker", "bug", "tools", "book", "lightbulb", "paintcan", "music", "game", "heart"]
EMOJI = ["🚀", "🧪", "📚", "💼", "🐞", "💡", "🎨", "🎵", "🎮", "❤️", "🌱", "🔥", "⚡", "🏠", "🌍", "📱", "🛠️", "☕"]
ICONS = ("folder", "symbol", "emoji", "picture")

PICTURE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico", ".icns")
PICTURE_MAX = 4 * 1024 * 1024       # a file bigger than this is not an icon
DATA_MAX = 200 * 1024               # what the window gets inline
ICON_PX = 96
# where projects keep a picture of themselves, most likely first (a name match anywhere in these folders counts)
PICTURE_NAMES = re.compile(r"^(icon|logo|favicon|app-?icon|apple-touch-icon|mark|avatar)([-_.@][\w.@-]*)?\.(png|jpe?g|webp|gif|svg|ico|icns)$", re.I)
PICTURE_DIRS = ("", "icons", "assets", "public", "static", "images", "img", "media", "resources", "res", "app/icons",
                "src/assets", "src/icons", "docs", "docs/assets", ".github", "build", "design")
SKIP_DIRS = {"node_modules", ".git", ".venv", "venv", "dist", "out", "target", "__pycache__", ".next", "Pods", "DerivedData"}


def _dispatch():
    global D
    if D is None:
        here = os.path.dirname(os.path.abspath(__file__))
        if here not in sys.path:
            sys.path.insert(0, here)
        import dispatch as mod  # noqa: E402
        D = mod
    return D


class Problem(ValueError):
    pass


# ---- the shared memory --------------------------------------------------------------------------------------------

def parse(raw):
    """{name: {look: {...}, ...}} from the memory's text; anything unreadable is no settings."""
    try:
        d = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    return {k: v for k, v in d.items() if isinstance(k, str) and isinstance(v, dict)} if isinstance(d, dict) else {}


def load(memories=None):
    _dispatch()
    if memories is None:
        code, o, _ = D.sh(["bd", "memories", "--json"])
        if code != 0:
            return {}
        try:
            memories = json.loads(o[o.find("{"):])
        except ValueError:
            return {}
    return parse((memories or {}).get(CUSTOM_KEY, ""))


def load_strict():
    """For a write: a board that cannot be read must never be saved back as "nothing set"."""
    _dispatch()
    code, o, err = D.sh(["bd", "memories", "--json"])
    if code != 0:
        raise Problem((err or o or "").strip() or "Dispatch could not read the task board. Try again in a moment.")
    try:
        return parse(json.loads(o[o.find("{"):]).get(CUSTOM_KEY, ""))
    except ValueError:
        raise Problem("Dispatch could not read the task board. Nothing was changed.")


def save(data):
    _dispatch()
    clean = {k: v for k, v in data.items() if v}
    D.wiki_store(CUSTOM_KEY, json.dumps(clean, ensure_ascii=False, sort_keys=True))


def update(name, section, value):
    """Set one section of a project's settings (None or {} removes it)."""
    data = load_strict()
    cur = dict(data.get(name) or {})
    if value:
        cur[section] = value
    else:
        cur.pop(section, None)
    data[name] = cur
    save(data)
    return cur


# ---- looks --------------------------------------------------------------------------------------------------------

def is_emoji(text):
    """One short pictograph, not words: at most 8 code points, none of them letters or digits of a script."""
    t = (text or "").strip()
    if not t or len(t) > 8:
        return False
    for ch in t:
        cat = unicodedata.category(ch)
        if cat[0] in ("L", "N", "Z", "C") and ch not in ("‍", "️", "⃣") and not ("\U0001F1E6" <= ch <= "\U0001F1FF"):
            return False
    return True


def look_of(raw):
    """A stored look made safe: {icon, color?, symbol?, emoji?, picture?}. Unknown values fall back to the folder."""
    raw = raw if isinstance(raw, dict) else {}
    icon = raw.get("icon") if raw.get("icon") in ICONS else "folder"
    out = {"icon": icon}
    if raw.get("color") in COLOR_IDS:
        out["color"] = raw["color"]
    if icon == "symbol":
        if raw.get("symbol") in SYMBOLS:
            out["symbol"] = raw["symbol"]
        else:
            out["icon"] = "folder"
    elif icon == "emoji":
        if is_emoji(raw.get("emoji")):
            out["emoji"] = raw["emoji"].strip()
        else:
            out["icon"] = "folder"
    elif icon == "picture":
        p = raw.get("picture")
        if isinstance(p, str) and p:
            out["picture"] = p
            if isinstance(raw.get("picture_from"), str):
                out["picture_from"] = raw["picture_from"]
        else:
            out["icon"] = "folder"
    return out


def is_default(look):
    return look.get("icon", "folder") == "folder" and not look.get("color")


def data_url(path):
    """The picture inline for the window (its CSP allows data: images), or '' when it is gone or too big."""
    try:
        if os.path.getsize(path) > DATA_MAX:
            return ""
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return ""
    ext = os.path.splitext(path)[1].lower()
    mime = {".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}.get(ext, "image/png")
    return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")


def look_public(raw):
    """What the window draws: the look plus the picture inline, without paths of this Mac. None for the plain folder."""
    look = look_of(raw)
    if is_default(look):
        return None
    out = {k: v for k, v in look.items() if k not in ("picture", "picture_from")}
    if look["icon"] == "picture":
        url = data_url(look["picture"])
        if url:
            out["picture_data"] = url
        else:
            out["icon"] = "folder"  # the copy is gone (another Mac, a cleared folder): the plain folder
            if not out.get("color"):
                return None
    return out


def icons_dir():
    import dispatch_dir
    return dispatch_dir.path("project-icons")


def _slug(name):
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-")[:40] or "project"
    return s + "-" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]


def keep_picture(name, src):
    """A copy of `src` for the sidebar: a 96 px PNG made with sips on macOS, the file itself when it already is small
    (an SVG stays an SVG). Returns the copy's path."""
    src = os.path.abspath(os.path.expanduser(src))
    if not os.path.isfile(src):
        raise Problem("That picture is not there any more.")
    ext = os.path.splitext(src)[1].lower()
    if ext not in PICTURE_EXT:
        raise Problem("Pick a picture: PNG, JPEG, WebP, GIF, SVG, ICO or ICNS.")
    if os.path.getsize(src) > PICTURE_MAX:
        raise Problem("That picture is too big for an icon (over 4 MB).")
    folder = icons_dir()
    os.makedirs(folder, exist_ok=True)
    base = os.path.join(folder, _slug(name))
    for old in (base + ".png", base + ".svg"):
        if os.path.exists(old):
            os.remove(old)
    if ext == ".svg":
        if os.path.getsize(src) > DATA_MAX:
            raise Problem("That SVG is too big for an icon.")
        shutil.copyfile(src, base + ".svg")
        return base + ".svg"
    out = base + ".png"
    sips = shutil.which("sips") or ("/usr/bin/sips" if os.path.exists("/usr/bin/sips") else "")
    if sips:
        r = subprocess.run([sips, "-Z", str(ICON_PX), "-s", "format", "png", src, "--out", out],
                           capture_output=True, text=True, timeout=30)
        if r.returncode == 0 and os.path.isfile(out):
            return out
    if ext in (".png",) and os.path.getsize(src) <= DATA_MAX:
        shutil.copyfile(src, out)
        return out
    raise Problem("Dispatch could not read that picture. Try a PNG.")


def home_relative(p):
    h = os.path.expanduser("~")
    return "~" + p[len(h):] if p == h or p.startswith(h + "/") else p


def find_pictures(folder, limit=6):
    """Pictures in the project's folder that look like its icon or logo: by name, in the usual places, near the top."""
    if not folder or not os.path.isdir(folder):
        return []
    seen, found = set(), []
    for sub in PICTURE_DIRS:
        d = os.path.join(folder, sub) if sub else folder
        if not os.path.isdir(d):
            continue
        try:
            names = sorted(os.listdir(d))
        except OSError:
            continue
        for n in names:
            p = os.path.join(d, n)
            if not PICTURE_NAMES.match(n) or p in seen or not os.path.isfile(p):
                continue
            try:
                size = os.path.getsize(p)
            except OSError:
                continue
            if size > PICTURE_MAX or size == 0:
                continue
            seen.add(p)
            found.append(p)
    # a PNG or SVG first (they draw as they are), then the rest; the shortest path among equals
    found.sort(key=lambda p: (os.path.splitext(p)[1].lower() not in (".png", ".svg"), p.count("/"), len(p)))
    out = []
    for p in found[:limit]:
        preview = data_url(p) if os.path.splitext(p)[1].lower() in (".png", ".svg", ".jpg", ".jpeg", ".webp", ".gif") else ""
        out.append({"path": p, "rel": os.path.relpath(p, folder), "data": preview})
    return out


def set_look(name, icon=None, symbol=None, emoji=None, picture=None, color=None):
    _dispatch()
    row = find_project(name)
    key = row["name"]
    cur = look_of((load_strict().get(key) or {}).get("look"))
    if icon is not None and icon not in ICONS:
        raise Problem("The icon is one of: folder, symbol, emoji, picture.")
    new = dict(cur)
    if icon:
        new = {k: v for k, v in new.items() if k == "color"}
        new["icon"] = icon
    if symbol is not None:
        if symbol not in SYMBOLS:
            raise Problem("That symbol is not one Dispatch offers.")
        new.update(icon="symbol", symbol=symbol)
    if emoji is not None:
        if not is_emoji(emoji):
            raise Problem("Pick one emoji.")
        new.update(icon="emoji", emoji=emoji.strip())
    if picture is not None:
        kept = keep_picture(key, picture)
        new.update(icon="picture", picture=kept, picture_from=home_relative(os.path.abspath(os.path.expanduser(picture))))
    if new.get("icon") == "symbol" and not new.get("symbol"):
        new["symbol"] = SYMBOLS[0]
    if new.get("icon") == "emoji" and not new.get("emoji"):
        new["emoji"] = EMOJI[0]
    if new.get("icon") == "picture" and not new.get("picture"):
        raise Problem("Choose a picture first.")
    if new.get("icon") != "picture":
        new.pop("picture", None)
        new.pop("picture_from", None)
    if color is not None:
        if color in ("", "none"):
            new.pop("color", None)
        elif color in COLOR_IDS:
            new["color"] = color
        else:
            raise Problem("The colour is one of: " + ", ".join(sorted(COLOR_IDS)) + ", or none.")
    look = look_of(new)
    if look.get("icon") != "picture":
        _drop_picture(key)
    update(key, "look", None if is_default(look) else look)
    return {"ok": True, "name": key, "look": look_public(look)}


def _drop_picture(name):
    base = os.path.join(icons_dir(), _slug(name))
    for p in (base + ".png", base + ".svg"):
        try:
            os.remove(p)
        except OSError:
            pass


# ---- the project -----------------------------------------------------------------------------------------------

def find_project(name):
    """The registered project by its name or label (any case); a Problem when there is none."""
    import projects_view as PV
    PV.D = _dispatch()
    want = (name or "").strip().casefold()
    if not want:
        raise Problem("Which project? Give its name.")
    rows = PV.registry()
    row = next((r for r in rows if r["name"].casefold() == want), None) or next((r for r in rows if (r.get("label") or "").casefold() == want), None)
    if not row:
        raise Problem(f"No project called {name}.")
    return row


def show(name):
    row = find_project(name)
    custom = load().get(row["name"]) or {}
    local = row.get("host") == "local" and row.get("dir") and os.path.isdir(row["dir"])
    return {
        "ok": True,
        "name": row["name"], "label": row.get("label") or row["name"], "dir": row.get("dir") or "",
        "host": row.get("host") or "local", "machine": row.get("machine") or "", "git": bool(row.get("git")),
        "local": bool(local),
        "look": look_public(custom.get("look")) or {"icon": "folder"},
        "picture_from": look_of(custom.get("look")).get("picture_from", ""),
        "pictures": find_pictures(row["dir"]) if local else [],
        "choices": {"symbols": SYMBOLS, "emoji": EMOJI, "colors": COLORS},
        "tools": tools_of(row["dir"]) if local else None,
        "agent_files": agent_files_of(row["dir"]) if local else None,
        "copies": copies_of(row["dir"], custom) if local and row.get("git") else None,
    }


# ---- copies for parallel work -------------------------------------------------------------------------------------

def copies_of(folder, custom):
    """Whether a copy of this project gets ready on its own, what that does here, and how the last one went."""
    import copy_ready
    auto = ((custom or {}).get("copies") or {}).get("auto") is not False
    try:
        p = copy_ready.plan(folder)
        last = copy_ready.last_for(folder)
    except (OSError, ValueError) as e:
        return {"auto": auto, "error": str(e)[:300]}
    return {"auto": auto, "copy": p["copy"], "link": p["link"], "install": p["install"], "last": last}


def set_copies(name, auto):
    row = find_project(name)
    update(row["name"], "copies", None if auto else {"auto": False})
    local = row.get("host") == "local" and row.get("dir") and os.path.isdir(row["dir"])
    return {"ok": True, "name": row["name"], "copies": copies_of(row["dir"], {"copies": {"auto": auto}}) if local and row.get("git") else None}


def agent_files_of(folder):
    """The project's own instructions and hooks, and what Dispatch adds next to them (agent_files.report)."""
    import agent_files
    try:
        return agent_files.report(folder)
    except OSError as e:
        return {"error": str(e)[:300], "own": [], "dispatch": [], "in_folder": [], "notes": []}


# ---- tools (MCP servers) ----------------------------------------------------------------------------------------

def tools_of(folder):
    """The MCP servers the agents in this folder get, each with a switch per engine (mcp_config.project_tools)."""
    import mcp_config
    try:
        return mcp_config.project_tools(folder)
    except (OSError, ValueError) as e:
        return {"error": str(e)[:300], "tools": []}


def set_tool(name, server, engine, on):
    import mcp_config
    row = find_project(name)
    if row.get("host") != "local" or not row.get("dir") or not os.path.isdir(row["dir"]):
        raise Problem(f"{row.get('label') or name} is not on this Mac. Change its tools on {row.get('machine') or 'that Mac'}.")
    try:
        done = mcp_config.set_project_tool(row["dir"], server, engine, on)
    except (OSError, ValueError) as e:
        raise Problem(str(e))
    return {"ok": True, "name": row["name"], **done, "tools": tools_of(row["dir"])}


# ---- the command ------------------------------------------------------------------------------------------------

def show_text(r):
    look = r["look"]
    what = {"folder": "a folder", "symbol": f"the symbol {look.get('symbol', '')}", "emoji": f"the emoji {look.get('emoji', '')}",
            "picture": "a picture" + (f" ({r['picture_from']})" if r.get("picture_from") else "")}[look["icon"]]
    lines = [f"{r['label']}: {what}" + (f", {look['color']}" if look.get("color") else ", no colour")]
    if r.get("pictures"):
        lines.append("Pictures in its folder: " + ", ".join(p["rel"] for p in r["pictures"]))
    return "\n".join(lines)


def command(a, dispatch_module=None):
    global D
    if dispatch_module is not None:
        D = dispatch_module
    _dispatch()
    op = getattr(a, "op", "") or "show"
    try:
        if op == "show":
            res = show(a.project)
        elif op == "tool":
            if not a.server or not a.engine or a.on == a.off:
                raise Problem("Usage: dispatch project-custom tool <project> --server NAME --engine claude-code|codex|opencode --on|--off")
            res = set_tool(a.project, a.server, a.engine, bool(a.on))
        elif op == "copies":
            if a.auto not in ("on", "off"):
                raise Problem("Usage: dispatch project-custom copies <project> --auto on|off")
            res = set_copies(a.project, a.auto == "on")
        elif op == "look":
            res = set_look(a.project, icon=a.icon or None, symbol=a.symbol, emoji=a.emoji, picture=a.picture, color=a.color)
        else:
            raise Problem(f"Unknown op {op}")
    except Problem as e:
        res = {"ok": False, "message": str(e)}
        print(json.dumps(res, ensure_ascii=False) if a.json else str(e))
        return 1
    if a.json:
        print(json.dumps(res, ensure_ascii=False))
    elif op == "show":
        print(show_text(res))
    else:
        print(json.dumps(res, ensure_ascii=False))
    return 0


def add_parser(sub, this):
    s = sub.add_parser("project-custom", help="one project's own settings in the Agents window: show <project> (its icon, colour and the pictures in its folder, the tools its agents get), tool <project> --server S --engine E --on|--off (only in this project), copies <project> --auto on|off, look <project> --icon folder|symbol|emoji|picture [--symbol N] [--emoji E] [--picture FILE] [--color NAME|none]")
    s.add_argument("op", nargs="?", default="show", choices=["show", "look", "tool", "copies"])
    s.add_argument("project", nargs="?", default="")
    s.add_argument("--icon", default="", choices=["", *ICONS])
    s.add_argument("--symbol", default=None)
    s.add_argument("--emoji", default=None)
    s.add_argument("--picture", default=None, help="look: a picture file (copied, 96 px)")
    s.add_argument("--color", default=None, help="look: " + ", ".join(c["id"] for c in COLORS) + " or none")
    s.add_argument("--server", default="", help="tool: the MCP server's name")
    s.add_argument("--engine", default="", help="tool: claude-code, codex or opencode")
    s.add_argument("--on", action="store_true", help="tool: let the agents here use it")
    s.add_argument("--off", action="store_true", help="tool: keep the agents here from using it")
    s.add_argument("--auto", default="", help="copies: on (default) or off: a copy for parallel work gets ready on its own")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=lambda a: sys.exit(command(a, this)))
