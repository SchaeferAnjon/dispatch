# -*- coding: utf-8 -*-
"""What a person's VS Code has that Dispatch IDE can take over (`dispatch onboard vscode`).

Read only. The setup wizard shows this as one optional row ("Choose what to import") and dispatch-bridge
does the writing, because Dispatch IDE's own user data folder is only known inside the app:

- settings.json: what is worth copying (editor, files, terminal, git ...) and what is not (VS Code's theme,
  its chat, updates and telemetry, the agent extensions Dispatch replaces). A setting an extension owns
  comes along with that extension, and is dropped when the extension cannot be had.
- keybindings.json and snippets: copied as they are, when there are any.
- extensions: Dispatch IDE uses Open VSX, not Microsoft's marketplace, so an extension is importable only
  when Open VSX has it. Claude Code, Codex and Remote SSH are Dispatch's own; themes are not brought over
  (Dispatch has one theme); a few extensions that patch VS Code's own UI are left out.

Design: kanban design/onboarding/redesign (C4). The numbers there came from this code on the author's Mac.
"""
import concurrent.futures
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request

sys.dont_write_bytecode = True

OPEN_VSX = "https://open-vsx.org/api/{publisher}/{name}"
CACHE_HOURS = 24

# settings that belong to VS Code's own chrome or to something Dispatch IDE does differently
SKIP_SETTINGS = [
    (re.compile(r"^workbench\.(colorTheme|preferred\w*ColorTheme|iconTheme|productIconTheme|colorCustomizations|tokenColorCustomizations)$|^editor\.tokenColorCustomizations$"), "Dispatch has one theme"),
    (re.compile(r"^(window\.|update\.|telemetry\.|settingsSync\.|extensions\.(autoUpdate|autoCheckUpdates|ignoreRecommendations)$|workbench\.(startupEditor|enableExperiments|welcomePage)|security\.workspace\.trust\.(startupPrompt|banner|enabled)$)"), "Dispatch IDE manages this itself"),
    (re.compile(r"^(chat\.|github\.copilot|inlineChat\.|mcp$|mcp\.)"), "a VS Code chat setting"),
    (re.compile(r"^(claudeCode\.|claude-code\.|chatgpt\.|codex\.|openai\.)"), "the agents run as CLIs in Dispatch"),
]
# a setting the editor itself owns, safe to copy
CORE_PREFIXES = ("editor.", "files.", "terminal.", "search.", "explorer.", "git.", "diffEditor.", "emmet.", "security.",
                 "breadcrumbs.", "scm.", "debug.", "problems.", "notebook.", "workbench.editor.", "workbench.tree.", "workbench.list.",
                 "workbench.tips.", "zenMode.", "markdown.", "html.", "css.", "json.", "typescript.", "javascript.", "npm.", "task.", "output.", "comments.", "diffEditor")
# Dispatch already brings these; the theme extensions are not brought over
BUILTIN_EXTENSIONS = [
    (re.compile(r"^(anthropic\.claude-code|openai\.(chatgpt|codex)|github\.copilot)"), "Dispatch runs the agents itself"),
    (re.compile(r"^ms-vscode-remote\.(remote-ssh|remote-ssh-edit)$|^ms-vscode\.remote-explorer$"), "Dispatch IDE has its own Remote SSH"),
]
# extensions that patch VS Code's own UI files: they do not belong in a fork
UI_PATCHERS = {"drcika.apc-extension", "be5invis.vscode-custom-css", "iocave.monkey-patch", "iocave.customize-ui", "brandonkirbyson.vscode-animations"}


def home():
    return os.path.expanduser("~")


def user_dir():
    """The VS Code User folder (settings.json, keybindings.json, snippets/)."""
    if sys.platform == "win32":
        return os.path.join(os.environ.get("APPDATA") or os.path.join(home(), "AppData", "Roaming"), "Code", "User")
    if sys.platform == "darwin":
        return os.path.join(home(), "Library", "Application Support", "Code", "User")
    return os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(home(), ".config"), "Code", "User")


def extensions_dir():
    return os.path.join(home(), ".vscode", "extensions")


# ---------------------------------------------------------------- JSON with comments

def strip_jsonc(text):
    """JSON with // and /* */ comments and trailing commas (what VS Code writes) -> plain JSON text."""
    out, i, n = [], 0, len(text)
    in_str = False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
        elif c == "/" and text[i:i + 2] == "//":
            while i < n and text[i] != "\n":
                i += 1
        elif c == "/" and text[i:i + 2] == "/*":
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
        elif c == "," and text[i + 1:].lstrip().startswith(("}", "]")):
            i += 1
        else:
            out.append(c)
            i += 1
    clean = "".join(out)
    # A comment may have separated a comma from its closing bracket.
    return strip_jsonc(clean) if clean != text else clean


def read_jsonc(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.loads(strip_jsonc(f.read()))
    except (OSError, ValueError):
        return default


# ---------------------------------------------------------------- extensions

def installed_extensions():
    """[{id, version, dir}] of ~/.vscode/extensions/extensions.json, one row per extension (the newest version)."""
    rows = read_jsonc(os.path.join(extensions_dir(), "extensions.json"), []) or []
    best = {}
    for r in rows:
        ident = ((r.get("identifier") or {}).get("id") or "").strip()
        if not ident or "." not in ident:
            continue
        loc = (r.get("location") or {}).get("path") or (r.get("location") or {}).get("fsPath") or ""
        row = {"id": ident, "version": r.get("version") or "", "dir": loc}
        key = ident.lower()
        if key not in best or _vkey(row["version"]) > _vkey(best[key]["version"]):
            best[key] = row
    return sorted(best.values(), key=lambda r: r["id"].lower())


def _vkey(v):
    return tuple(int(x) if x.isdigit() else 0 for x in re.split(r"[.\-+]", v or "0"))


def extension_manifest(ext):
    d = ext.get("dir") or ""
    if not d or not os.path.isdir(d):
        return {}
    return read_jsonc(os.path.join(d, "package.json"), {}) or {}


def contributed_keys(manifest):
    conf = ((manifest.get("contributes") or {}).get("configuration"))
    confs = conf if isinstance(conf, list) else ([conf] if isinstance(conf, dict) else [])
    keys = set()
    for c in confs:
        keys |= set((c.get("properties") or {}).keys())
    return keys


def is_theme(manifest):
    cats = [str(c).lower() for c in manifest.get("categories") or []]
    contributes = manifest.get("contributes") or {}
    only_theme = bool(contributes.get("themes") or contributes.get("iconThemes")) and not (contributes.get("commands") or contributes.get("languages") or contributes.get("grammars"))
    return "themes" in cats or only_theme


def display_name(ext, manifest):
    name = manifest.get("displayName") or ""
    if not name or name.startswith("%"):
        name = manifest.get("name") or ext["id"].split(".", 1)[1]
    return name


def cache_path():
    import dispatch_dir
    return dispatch_dir.path("state", "open-vsx-cache.json") if hasattr(dispatch_dir, "path") else os.path.join(home(), ".dispatch", "state", "open-vsx-cache.json")


def _cache_load():
    try:
        with open(cache_path(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _cache_save(c):
    try:
        os.makedirs(os.path.dirname(cache_path()), exist_ok=True)
        with open(cache_path(), "w", encoding="utf-8") as f:
            json.dump(c, f)
    except OSError:
        pass


def open_vsx_has(ext_id, fetch=None, timeout=8):
    """True / False from Open VSX, None when it could not be asked."""
    publisher, _, name = ext_id.partition(".")
    url = OPEN_VSX.format(publisher=publisher, name=name)
    try:
        if fetch:
            return bool(fetch(url))
        req = urllib.request.Request(url, headers={"User-Agent": "dispatch-ide-onboarding"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.load(r)
        return bool(data.get("version")) and not data.get("error")
    except urllib.error.HTTPError as e:
        return False if e.code == 404 else None
    except Exception:
        return None


def availability(ids, fetch=None):
    """{id: True | False | None}. Answers are kept a day so a second look (the wizard, then Migrations) is free."""
    cache = _cache_load()
    now = time.time()
    out, ask = {}, []
    for i in ids:
        hit = cache.get(i.lower())
        if hit and now - hit.get("at", 0) < CACHE_HOURS * 3600 and hit.get("has") is not None:
            out[i] = hit["has"]
        else:
            ask.append(i)
    if ask:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            for i, has in zip(ask, pool.map(lambda x: open_vsx_has(x, fetch), ask)):
                out[i] = has
                if has is not None:
                    cache[i.lower()] = {"has": has, "at": now}
        _cache_save(cache)
    return out


# ---------------------------------------------------------------- the scan

def classify_setting(key):
    """("core" | "skip", reason)."""
    for rx, why in SKIP_SETTINGS:
        if rx.search(key):
            return "skip", why
    if key.startswith(CORE_PREFIXES) or key in ("workbench.editor.enablePreview", "workbench.list.smoothScrolling"):
        return "core", ""
    return "other", ""


def scan(fetch=None, check_online=True):
    """Everything importable, as the wizard shows it. None when there is no VS Code here."""
    udir = user_dir()
    settings_path = os.path.join(udir, "settings.json")
    exts = installed_extensions()
    if not os.path.isfile(settings_path) and not exts and not os.path.isdir(os.path.join(udir, "snippets")):
        return None
    settings = read_jsonc(settings_path, {}) or {}
    manifests = {e["id"]: extension_manifest(e) for e in exts}

    # extensions first: which ones come, so a setting can follow its extension
    ids = [e["id"] for e in exts]
    have = availability([i for i in ids if not any(rx.search(i.lower()) for rx, _ in BUILTIN_EXTENSIONS) and i not in UI_PATCHERS], fetch) if check_online else {i: c.get("has") for i, c in _cache_load().items()}
    install, builtin, theme, tweak, missing = [], [], [], [], []
    for e in exts:
        i, m = e["id"], manifests.get(e["id"]) or {}
        row = {"id": i, "name": display_name(e, m)}
        why = next((w for rx, w in BUILTIN_EXTENSIONS if rx.search(i.lower())), "")
        if why:
            builtin.append(dict(row, why=why))
        elif i in UI_PATCHERS:
            tweak.append(dict(row, why="it patches VS Code's own files"))
        elif is_theme(m):
            theme.append(dict(row, why="Dispatch has one theme"))
        elif have.get(i) is True:
            install.append(row)
        else:
            missing.append(dict(row, why="not on Open VSX" if have.get(i) is False else "could not reach Open VSX"))
    installing = {r["id"] for r in install}
    owner = {}
    for e in exts:
        for k in contributed_keys(manifests.get(e["id"]) or {}):
            owner.setdefault(k, e["id"])

    core, with_ext, skip = [], [], []
    for key, value in settings.items():
        kind, why = classify_setting(key)
        if kind == "skip":
            skip.append({"key": key, "why": why})
            continue
        ext_id = owner.get(key)
        if ext_id and kind != "core":
            row = next((r for r in install if r["id"] == ext_id), None)
            if row:
                with_ext.append({"key": key, "value": value, "with": row["name"], "ext": ext_id})
            else:
                skip.append({"key": key, "why": "needs an extension that cannot be installed here"})
        elif kind == "core":
            core.append({"key": key, "value": value})
        elif ext_id and ext_id in installing:
            with_ext.append({"key": key, "value": value, "with": ext_id, "ext": ext_id})
        else:
            # `python.analysis.x` when the extension left no manifest, or a key nobody in this VS Code owns
            skip.append({"key": key, "why": "not a setting Dispatch IDE knows"})

    keybindings = read_jsonc(os.path.join(udir, "keybindings.json"), None)
    snippets = []
    sdir = os.path.join(udir, "snippets")
    if os.path.isdir(sdir):
        snippets = sorted(f for f in os.listdir(sdir) if f.endswith((".json", ".code-snippets")))
    return {
        "user_dir": udir,
        "settings": {"total": len(settings), "core": core, "with_extension": with_ext, "skip": skip},
        "keybindings": {"found": isinstance(keybindings, list) and len(keybindings) > 0, "count": len(keybindings) if isinstance(keybindings, list) else 0, "path": os.path.join(udir, "keybindings.json")},
        "snippets": {"files": snippets, "dir": sdir},
        "extensions": {"total": len(exts), "on_open_vsx": len(install) + len(builtin) + len(theme) + len(tweak) if check_online else None,
                       "install": install, "builtin": builtin, "theme": theme, "tweak": tweak, "missing": missing, "online": check_online},
    }


def summary(found):
    """The one line the discovery screen shows for VS Code."""
    if not found:
        return None
    s = found["settings"]
    n = len(s["core"]) + len(s["with_extension"])
    return {"settings": n, "settings_total": s["total"], "extensions": len(found["extensions"]["install"]), "extensions_total": found["extensions"]["total"],
            "keybindings": found["keybindings"]["count"], "snippets": len(found["snippets"]["files"])}


# ---------------------------------------------------------------- writing (settings, shortcuts, snippets)

def ide_user_dir():
    """Dispatch IDE's own User folder: the first user data dir ide_sessions knows (a test instance sets its own)."""
    import ide_sessions
    return os.path.join(ide_sessions.apps()[0][1], "User")


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".dispatch-tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)
        f.write("\n")
    os.replace(tmp, path)


def apply(plan, found=None, target=None):
    """Copy what the wizard ticked into Dispatch IDE's User folder. `plan`: {settings: [keys], keybindings: bool,
    snippets: bool}. Returns what an Undo needs: the settings that were there before, the files that were made."""
    found = found or scan(check_online=False)
    if not found:
        return {"ok": False, "message": "There is no VS Code here to import from."}
    target = target or ide_user_dir()
    os.makedirs(target, exist_ok=True)
    spath = os.path.join(target, "settings.json")
    current = read_jsonc(spath, {}) or {}
    if os.path.isfile(spath) and read_jsonc(spath, None) is None:
        return {"ok": False, "message": "Your Dispatch IDE settings file could not be read, so nothing was changed."}
    want = set(plan.get("settings") or [])
    values = {r["key"]: r["value"] for r in found["settings"]["core"] + found["settings"]["with_extension"]}
    wrote = {}
    for key in sorted(want & set(values)):
        if key in current and current[key] == values[key]:
            continue
        wrote[key] = {"existed": key in current, "prev": current.get(key), "written": values[key]}
        current[key] = values[key]
    if wrote:
        if os.path.isfile(spath):
            shutil.copy2(spath, spath + ".before-import")
        _write_json(spath, current)
    made = {"keybindings": False, "snippets": [], "files": {}}
    if plan.get("keybindings") and found["keybindings"]["found"]:
        kpath = os.path.join(target, "keybindings.json")
        if not os.path.exists(kpath):
            shutil.copy2(found["keybindings"]["path"], kpath)
            made["keybindings"] = True
            made["files"]["keybindings.json"] = open(kpath, encoding="utf-8").read()
    if plan.get("snippets"):
        sdst = os.path.join(target, "snippets")
        for name in found["snippets"]["files"]:
            dst = os.path.join(sdst, name)
            if not os.path.exists(dst):
                os.makedirs(sdst, exist_ok=True)
                shutil.copy2(os.path.join(found["snippets"]["dir"], name), dst)
                made["snippets"].append(name)
                made["files"]["snippets/" + name] = open(dst, encoding="utf-8").read()
    return {"ok": True, "target": target, "settings": wrote, **made}


def undo(data):
    """Put the User folder back: the settings as they were, the shortcut and snippet files gone."""
    target = data.get("target") or ide_user_dir()
    spath = os.path.join(target, "settings.json")
    if data.get("settings") and os.path.isfile(spath):
        cur = read_jsonc(spath, {}) or {}
        for key, was in data["settings"].items():
            if cur.get(key) != was.get("written"):
                continue  # Keep an edit made after the import.
            if was.get("existed"):
                cur[key] = was.get("prev")
            else:
                cur.pop(key, None)
        _write_json(spath, cur)
    for name, written in data.get("files", {}).items():
        try:
            p = os.path.join(target, name)
            if open(p, encoding="utf-8").read() == written:
                os.remove(p)
        except OSError:
            pass
    return True
