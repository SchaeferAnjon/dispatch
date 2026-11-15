# -*- coding: utf-8 -*-
"""Claude Code plugins for Customizations › Plugins: every plugin on disk, not only the ones a running
session loaded, and the switch that turns one on or off.

    dispatch plugins list [--json]
    dispatch plugins on|off <name@marketplace> [--json]

Read from ~/.claude/plugins/installed_plugins.json (what is installed, where) and the `enabledPlugins`
map of ~/.claude/settings.json (what is on). A switch writes only that one key of settings.json, keeps
the file as it was in ~/.dispatch/backups/<date>/ and refuses when the file changed meanwhile. Nothing is
installed or removed here; that stays `claude plugin install / uninstall`.

A disposable IDE instance works on the same HOME Customizations uses (customizations.home()), never the
person's own.
"""
import json
import os
from pathlib import Path

import customizations as C


def paths():
    h = C.home()
    return {"installed": h / ".claude/plugins/installed_plugins.json", "settings": h / ".claude/settings.json"}


def _count(folder, pattern):
    try:
        return len(list(Path(folder).glob(pattern)))
    except OSError:
        return 0


def _manifest(root):
    for name in (".claude-plugin/plugin.json", "plugin.json"):
        try:
            data = json.loads((Path(root) / name).read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except (OSError, ValueError):
            continue
    return {}


def summary(root):
    """What a plugin brings into a session, from its folder."""
    m = _manifest(root)
    root = Path(root)
    return {
        "description": str(m.get("description") or "")[:300],
        "skills": _count(root / "skills", "*/SKILL.md"),
        "agents": _count(root / "agents", "*.md"),
        "commands": _count(root / "commands", "*.md"),
        "hooks": (root / "hooks/hooks.json").is_file() or bool(m.get("hooks")),
        "mcp": (root / ".mcp.json").is_file() or bool(m.get("mcpServers")),
        "lsp": (root / ".lsp.json").is_file() or bool(m.get("lspServers")),
    }


def listing():
    p = paths()
    installed = C.read_json(p["installed"], {})
    settings = C.read_json(p["settings"], {})
    enabled = settings.get("enabledPlugins") if isinstance(settings, dict) else {}
    enabled = enabled if isinstance(enabled, dict) else {}
    records = installed.get("plugins") if isinstance(installed, dict) else {}
    rows = []
    for name, entries in sorted((records or {}).items()):
        entry = next((e for e in (entries if isinstance(entries, list) else [entries]) if isinstance(e, dict)), {})
        plugin, _, market = name.partition("@")
        root = entry.get("installPath") or ""
        rows.append({"name": name, "plugin": plugin, "marketplace": market, "version": str(entry.get("version") or ""),
                     "scope": entry.get("scope") or "user", "path": root, "enabled": bool(enabled.get(name)),
                     **(summary(root) if root and os.path.isdir(root) else {"description": "", "skills": 0, "agents": 0,
                                                                           "commands": 0, "hooks": False, "mcp": False, "lsp": False, "missing": True})})
    # enabled first, then by name: what a session loads is on top
    rows.sort(key=lambda r: (not r["enabled"], r["name"].lower()))
    return {"agent": "claude-code", "settings": str(p["settings"]), "installed": str(p["installed"]), "plugins": rows}


def switch(name, enabled):
    known = {r["name"] for r in listing()["plugins"]}
    if name not in known:
        raise ValueError("This plugin is not installed in Claude Code. Refresh the list.")
    path = paths()["settings"]
    with C.locked():
        before = path.read_bytes() if path.exists() else b""
        data = json.loads(before.decode("utf-8")) if before.strip() else {}
        if not isinstance(data, dict):
            raise ValueError(f"Invalid settings in {path}; the file was left unchanged.")
        plugins = data.setdefault("enabledPlugins", {})
        if not isinstance(plugins, dict):
            raise ValueError(f"enabledPlugins in {path} is not a map; the file was left unchanged.")
        if bool(plugins.get(name)) == enabled:
            return {"ok": True, "name": name, "enabled": enabled, "unchanged": True}
        plugins[name] = enabled
        import backups
        kept = backups.save(str(path), home=str(C.home()))
        C.write_json(path, data, before)
    return {"ok": True, "name": name, "enabled": enabled, "path": str(path), "backup": kept}


def text(r):
    if not r["plugins"]:
        return "No Claude Code plugins are installed."
    lines = []
    for p in r["plugins"]:
        has = [f"{p[k]} {k}" for k in ("skills", "agents", "commands") if p.get(k)] + [k.upper() if k != "hooks" else k for k in ("mcp", "hooks", "lsp") if p.get(k)]
        lines.append(f"{'on ' if p['enabled'] else 'off'}  {p['name']}  {p['version']}  {', '.join(has) or 'settings only'}")
    return "\n".join(lines)


def command(a):
    try:
        if a.op == "list":
            r = listing()
            print(json.dumps(r, ensure_ascii=False, indent=1) if a.json else text(r))
            return 0
        if not a.name:
            raise ValueError(f"Usage: dispatch plugins {a.op} <name@marketplace>")
        r = switch(a.name, a.op == "on")
        print(json.dumps(r, ensure_ascii=False) if a.json else f"{r['name']}: {'on' if r['enabled'] else 'off'}" + (" (unchanged)" if r.get("unchanged") else ""))
        return 0
    except (ValueError, OSError) as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False) if a.json else str(e))
        raise SystemExit(1)


def add_parsers(sub):
    s = sub.add_parser("plugins", help="Claude Code plugins on disk: list, turn one on or off (Customizations › Plugins)")
    s.add_argument("op", nargs="?", default="list", choices=["list", "on", "off"])
    s.add_argument("name", nargs="?", default="")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=command)
