# -*- coding: utf-8 -*-
"""What a project's own agent settings are, and what Dispatch adds next to them (task-6yrk).

A project can carry its own instructions (CLAUDE.md, AGENTS.md, .claude/rules), hooks (.claude/settings.json,
.claude/settings.local.json, .codex/hooks.json) and plugins (.opencode/plugin): which of them each engine reads is its
adapter's project_files. Dispatch never writes these:
its own hook and rules go into the person's user settings (~/.claude/settings.json, ~/.codex/hooks.json: one entry,
`hook.py <agent> # dispatch-hook`, on each event it hooks, hooks_setup.py; the managed block of ~/.claude/CLAUDE.md
and ~/.codex/AGENTS.md), merged with what is there and never replacing it. The engines then run both: Claude Code and Codex run user hooks and project
hooks side by side, and read the user's instructions and the project's together.

`report(folder)` says all that for one folder, in words the Customize page shows:
  {"own": [{"kind": "instructions" | "hooks" | "plugins", "file", "rel", "agents": [...], "count"?, "events"?}],
   "dispatch": [{"what", "file", "count"}],
   "in_folder": [rel paths of files in the folder that carry a Dispatch marker],
   "notes": [{"id", "text"}]}
A note is something in the person's settings that changes what Dispatch can do, said as a consequence. Nothing
here changes a file.
"""
import json
import os
import re

MARK = re.compile(r"#\s*dispatch-[a-z-]+|dispatch(?:\.py)?\"?\s+prime\s+--hook-json")
RULES_BEGIN = "<!-- BEGIN DISPATCH GLOBAL RULES"



def project_files():
    """[(path in the project, kind, [agents that read it])]: what each engine's adapter says it reads (project_files),
    one row per path, in the registry's order."""
    import engines
    rows = {}
    for eng in engines.known():
        for rel, kind in eng.project_files:
            rows.setdefault(rel, (rel, kind, []))[2].append(eng.agent)
    return list(rows.values())


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def _json(path):
    text = _read(path)
    if text is None:
        return None
    try:
        d = json.loads(text)
    except ValueError:
        return {"_invalid": True}
    return d if isinstance(d, dict) else {"_invalid": True}


def hook_counts(data):
    """(own, dispatch, events of own) in a settings document's "hooks"."""
    own = mine = 0
    events = set()
    hooks = (data or {}).get("hooks")
    if not isinstance(hooks, dict):
        return 0, 0, []
    for event, groups in hooks.items():
        for g in groups if isinstance(groups, list) else []:
            for h in (g.get("hooks") if isinstance(g, dict) else None) or []:
                cmd = str(h.get("command", "")) if isinstance(h, dict) else ""
                if MARK.search(cmd):
                    mine += 1
                else:
                    own += 1
                    events.add(event)
    return own, mine, sorted(events)


def home_of(home=None):
    try:
        import customizations
        return str(customizations.home()) if home is None else home
    except Exception:  # noqa: BLE001
        return home or os.path.expanduser("~")


def report(folder, home=None):
    folder = os.path.realpath(folder)
    own, notes, in_folder = [], [], []
    files = project_files()
    for rel, kind, agents in files:
        p = os.path.join(folder, rel)
        if kind == "instructions":
            text = _read(p)
            if text is None:
                continue
            own.append({"kind": "instructions", "file": p, "rel": rel, "agents": agents, "lines": text.count("\n") + 1})
            if RULES_BEGIN in text:
                in_folder.append(rel)
        elif kind == "rules" and os.path.isdir(p):
            n = sum(1 for _, _, fs in os.walk(p) for f in fs if f.endswith(".md"))
            if n:
                own.append({"kind": "instructions", "file": p, "rel": rel + "/", "agents": agents, "count": n})
    for rel, kind, agents in files:
        if kind != "hooks":
            continue
        p = os.path.join(folder, rel)
        data = _json(p)
        if data is None:
            continue
        if data.get("_invalid"):
            own.append({"kind": "hooks", "file": p, "rel": rel, "agents": agents, "count": 0, "events": [], "invalid": True})
            continue
        n, mine, events = hook_counts(data)
        if mine:
            in_folder.append(rel)
        if n or "hooks" in data:
            own.append({"kind": "hooks", "file": p, "rel": rel, "agents": agents, "count": n, "events": events})
    for rel, kind, agents in files:
        p = os.path.join(folder, rel)
        if kind == "plugins" and os.path.isdir(p):
            n = sum(1 for f in os.listdir(p) if f.endswith((".js", ".ts", ".mjs")))
            if n:
                own.append({"kind": "plugins", "file": p, "rel": rel + "/", "agents": agents, "count": n})
    import engines
    for eng in engines.known():
        notes += eng.project_notes(folder, [o for o in own if eng.agent in o["agents"]])

    h = home_of(home)
    dispatch = []
    for eng in engines.runnable():
        path = eng.hooks_file(h) if eng.hooks_json else ""
        data = _json(path) if path else None
        if data and not data.get("_invalid"):
            n, mine, _ = hook_counts(data)
            if mine:
                dispatch.append({"what": f"Hooks for {eng.name}", "file": path, "count": mine, "yours": n})
    for eng in engines.runnable():
        rules = eng.rules_target(h)
        if rules and RULES_BEGIN in (_read(rules["path"]) or ""):
            dispatch.append({"what": f"Shared rules for {eng.name}", "file": rules["path"], "count": 1})
    for eng in engines.known():
        notes += eng.user_notes(h, dispatch)
    return {"folder": folder, "own": own, "dispatch": dispatch, "in_folder": in_folder, "notes": notes}
