# -*- coding: utf-8 -*-
"""What the slash menu in Dispatch IDE's Agents window says about commands it cannot run (`dispatch slash`).

The menu (dispatch-ide patches, dispatchSlashMenu.ts) lists only what the session's engine really has.
When the person types a command this engine does not have, but another engine has it, or the engine
has it only in its own terminal (`claude`, `codex`, `opencode` running in a terminal), the menu shows a
grey row instead of nothing: why it is not here and where to do it. This module is that table; the IDE
reads `dispatch slash --engine <id> --json` through dispatch-bridge (`dispatch.slash`) and only renders it.

Each row: name (without the slash), why, where, and go: what Enter does on the grey row, one of
  sessions                 focus Sessions on the left
  changes                  Changes in the side pane
  permissions              the permission picker under the input
  accounts                 the accounts menu in the title bar
  new                      a new session
  customizations:<page>    a Customizations page (mcpServers, plugins, skills, agents, hooks,
                           instructions, harnessSettings)
  alias:<name>             the same thing under this engine's name (`/models` in OpenCode is `/model`)
or "" when there is nowhere to go (the row only explains)."""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engines as E  # noqa: E402


def _engines():
    """{id: Engine} of the engines whose sessions have this menu (the ones Dispatch runs)."""
    return {e.id: e for e in E.runnable()}

# What Dispatch runs in each engine's sessions (the menu's Commands group, Engine.slash_commands): used here only to
# say which engine a command belongs to when another engine's session asks for it. clear and rename are Dispatch's own
# and work everywhere. Engine.terminal_commands: what each engine has only in its terminal UI, with Dispatch's own way
# to the same thing when there is one: (where, go).
# The menu's group names: typing one shows that group, so they are never grey.
GROUP_NAMES = {"commands", "command", "skills", "skill", "mcp", "plugins", "plugin", "agents", "agent", "model", "models"}
DISPATCH_OWN = {"clear", "rename"}
# go targets that mean the same in every engine's session
PORTABLE_GO = {"sessions", "changes", "permissions", "accounts", "new"}


def _engine_list(ids, conj="and"):
    names = [E.get(i).name for i in ids]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " " + conj + " " + names[-1]


def rows(engine):
    """The grey rows for a session of `engine`: every command it cannot run here, with why and where."""
    engines = _engines()
    if engine not in engines:
        raise ValueError(engine)
    eng = engines[engine]
    runs = {i: set(e.slash_commands) for i, e in engines.items()}
    terminal = {i: e.terminal_commands for i, e in engines.items()}
    own = runs[engine] | DISPATCH_OWN
    out = {}
    for name, (where, go) in terminal[engine].items():
        if name in own or (name in GROUP_NAMES and not go.startswith("alias:")):
            continue
        out[name] = {
            "name": name,
            "why": "%s has /%s only in its terminal" % (eng.name, name),
            "where": where or "Run %s in a terminal to use it" % eng.bin,
            "go": go,
        }
    others = [e for e in engines if e != engine]
    names = set()
    for e in others:
        names |= runs[e] | set(terminal[e])
    for name in sorted(names):
        if name in own or name in out or name in GROUP_NAMES or name in terminal[engine]:
            continue
        runs_in = [e for e in others if name in runs[e]]
        if runs_in:
            out[name] = {
                "name": name,
                "why": "/%s is a %s command" % (name, _engine_list(runs_in)),
                "where": "Start a %s session to use it" % _engine_list(runs_in, "or"),
                "go": "",
            }
            continue
        term_in = [e for e in others if name in terminal[e]]
        # another engine's way to the same thing in Dispatch, when it is not tied to that engine
        where, go = next(((w, g) for e in term_in for (w, g) in [terminal[e][name]] if g in PORTABLE_GO), ("", ""))
        out[name] = {
            "name": name,
            "why": "/%s is in the %s terminal only" % (name, _engine_list(term_in)),
            "where": where or "Run %s in a terminal to use it" % " or ".join(engines[e].bin for e in term_in),
            "go": go,
        }
    return [out[k] for k in sorted(out)]


def table(engine):
    return {"engine": engine, "name": E.get(engine).name, "rows": rows(engine)}


def command(a):
    engines = [a.engine] if getattr(a, "engine", "") else list(_engines())
    data = [table(e) for e in engines]
    if getattr(a, "json", False):
        print(json.dumps(data[0] if getattr(a, "engine", "") else data, ensure_ascii=False, indent=2))
        return
    for t in data:
        print("%s (%d)" % (t["name"], len(t["rows"])))
        for r in t["rows"]:
            print("  /%-18s %s · %s%s" % (r["name"], r["why"], r["where"], ("  → " + r["go"]) if r["go"] else ""))
    sys.stdout.flush()
