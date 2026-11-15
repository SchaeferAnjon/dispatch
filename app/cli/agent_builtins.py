# -*- coding: utf-8 -*-
"""`dispatch builtins [--json]`: what Dispatch itself puts into every agent's context, in one list (Settings › Soul).

Each part says what it is, when it reaches an agent and whether it can be changed; the page shows it next to Soul,
the one part the person writes. What is the person's own (GLOBAL.md, their skills, hooks and sub-agents) is not
here: it stays on its own page under Advanced.

  soul     ~/.dispatch/rules/SOUL.md: on or off (its text and editing are `dispatch soul`)
  rules    dispatch.md, Dispatch's own rules: read-only, replaced on update; synced into each agent's rules file
  brief    `dispatch prime`, the session brief: made at each session start by the hook (Claude Code, Codex) or
           Dispatch's OpenCode plugin; switched with the hook's Session brief feature
  hooks    the one hook entry (~/.dispatch/bin/dispatch-hook) and its features, each on or off per agent
  tools    Dispatch's MCP server: its instructions and tools, on or off for every agent
  skills   the skills that ship with Dispatch: read-only, the path of each SKILL.md
  agents   the helper agents that ship with Dispatch, each on or off

Only files on this Mac are read; nothing is started. Full texts are not in the answer: the page reads a file when
someone opens it (the paths are here), so the answer stays small enough to keep.
"""
import json
import os

import customizations as C
import dispatch_dir as DD


def _home_path(p):
    return p.replace(os.path.expanduser("~") + os.sep, "~/", 1) if p else p


def soul_part():
    import soul
    return {"path": soul.path(), "on": soul.is_on()}


def rules_part():
    status = C.rules_status()
    installed = status["dispatch"]
    path = installed if status["dispatch_installed"] else (DD.SHIPPED_RULES if os.path.isfile(DD.SHIPPED_RULES) else installed)
    return {"path": path, "installed": status["dispatch_installed"],
            "targets": [{"agent": t["agent"], "path": t["path"], "mode": t["mode"], "state": t["state"]} for t in status["targets"]]}


def hooks_part():
    import hooks_setup
    listed = C.hooks_list()
    return {"entry": hooks_setup.shim_path(str(C.home())), "groups": listed["groups"], "errors": listed["errors"]}


def brief_part(hooks):
    """Which agents get the brief and how: the Session brief feature of the hook entry, per agent."""
    prime = next((g for g in hooks["groups"] if g["id"] == "prime"), None)
    agents = []
    for agent, state in (prime or {}).get("agents", {}).items():
        agents.append({"agent": agent, "on": bool(state.get("enabled")), "events": state.get("events", []),
                       "via": "plugin" if agent == "opencode" else "hook"})
    return {"command": "dispatch prime", "agents": agents}


def tools_part():
    import dispatch_mcp
    import mcp_config
    try:
        builtin = mcp_config.listing()["builtin"]
        error = ""
    except (OSError, ValueError) as e:
        builtin = {"name": dispatch_mcp.NAME, "on": False, "engines": [], "about": dispatch_mcp.ABOUT, "if_off": dispatch_mcp.IF_OFF}
        error = str(e)[:300]
    return dict(builtin, instructions=dispatch_mcp.INSTRUCTIONS, error=error,
                tools=[{"name": t.name, "title": t.title, "description": t.description} for t in dispatch_mcp.TOOLS])


def skills_part():
    rows = [r for r in C.skills_list() if r.get("builtin")]
    order = {n: i for i, n in enumerate(C.BUILTINS)}
    rows.sort(key=lambda r: order.get(r["name"], len(order)))
    return [{"name": r["name"], "description": r["description"], "path": os.path.join(r["path"], "SKILL.md")} for r in rows]


def agents_part():
    """Each helper agent; `path` is Dispatch's copy that agents read (~/.dispatch/agents) while it is one, else the
    definition that ships."""
    return [{"name": a["name"], "description": a["description"], "enabled": a["enabled"],
             "path": a["path"] if a.get("builtin") and os.path.isfile(a["path"]) else a["shipped"],
             "engines": a["engines"], "yours": a["yours"]} for a in C.builtin_agents_list()]


def collect():
    hooks = hooks_part()
    return {"soul": soul_part(), "rules": rules_part(), "brief": brief_part(hooks), "hooks": hooks,
            "tools": tools_part(), "skills": skills_part(), "agents": agents_part()}


def run(a):
    out = collect()
    if getattr(a, "json", False):
        print(json.dumps(out, ensure_ascii=False))
        return 0
    print(f"Soul        {'on' if out['soul']['on'] else 'off'}  {_home_path(out['soul']['path'])}")
    print(f"Rules       {_home_path(out['rules']['path'])}")
    on = [b["agent"] for b in out["brief"]["agents"] if b["on"]]
    print(f"Brief       {', '.join(on) or 'off'}")
    print(f"Hooks       {_home_path(out['hooks']['entry'])}: " + ", ".join(g["id"] for g in out["hooks"]["groups"]))
    print(f"Tools       {'on in ' + ', '.join(out['tools']['engines']) if out['tools']['on'] else 'off'}: {len(out['tools']['tools'])} tools")
    print(f"Skills      " + ", ".join(s["name"] for s in out["skills"]))
    print(f"Sub-agents  " + ", ".join(a["name"] + ("" if a["enabled"] else " (off)") for a in out["agents"]))
    return 0


def add_parser(sub):
    s = sub.add_parser("builtins", help="what Dispatch puts into every agent's context: Soul, dispatch.md, the session brief, "
                                        "hooks, its tools, skills and helper agents (agent_builtins.py; Settings › Soul)")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=run)
