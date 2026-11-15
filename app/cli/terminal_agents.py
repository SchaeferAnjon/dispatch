# -*- coding: utf-8 -*-
"""Which agents a person can run in a terminal, and the command that starts each one.

The Agents window has a terminal a person can open for a project, and "Run an agent in a terminal" starts the
agent's own text interface there. Any agent found on this Mac works (Dispatch's chat only drives Claude Code,
Codex and OpenCode, but every agent has a terminal interface). `rows()` is the list the picker shows:

    {id, name, about, command, enabled, runnable, is_default}

`command` is what gets typed into the terminal: the agent's own file (the full path, so it starts even when the
terminal's search path is shorter than the one the agent was installed into) plus the extra arguments some
agents need to open their terminal interface, and the permission mode the person chose for new sessions in Settings
(autonomy.py: Full auto is Claude Code's bypassPermissions and Codex's no-sandbox mode), so an agent in the terminal
asks as much as one in the chat does (task-lj06.33). An agent Dispatch does not chat with starts as typed by hand.

The extra arguments (each engine's terminal_args, engines/) follow the launch commands of Orca's agent catalog
(https://github.com/stablyai/orca, src/shared/tui-agent-config.ts), which is under the MIT License:

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
import concurrent.futures
import os
import re
import shlex
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import agents_catalog as AC
import engines as E


def recipe(agent_id, command):
    """{start, resume, fork}: the full lines to type, with `{session}` / `{new}` left for the caller to fill
    ('' where the agent has no such way). How an agent goes on after Dispatch's terminal restarts and how a copy of its
    conversation starts are its adapter's terminal_recipe (engines/); an agent without one starts again bare after a
    restart, and a copy of it gets the earlier conversation as text."""
    r = E.get(agent_id).terminal_recipe
    return {k: (f"{command} {r[k]}" if r.get(k) else "") for k in ("start", "resume", "fork")}


def turn_env(agent_id, env=None):
    """What goes in front of the agent's command for its turns to reach Dispatch (its adapter's terminal_turn_env:
    OpenCode's plugin in an inline config). '' for others, and when writing it failed."""
    env = os.environ if env is None else env
    try:
        return E.get(agent_id).terminal_turn_env(env)
    except Exception:
        return ""


def turn_args(agent_id, env=None):
    """What lets an agent tell Dispatch its turn ended (terminal_hook.py; its adapter's terminal_turn_args: Claude
    Code's hooks in a settings file of its own, Codex's `notify` program). '' for others, and when that failed."""
    env = os.environ if env is None else env
    try:
        return E.get(agent_id).terminal_turn_args(env)
    except Exception:
        return ""


def permission_args(agent_id, level=None):
    """The arguments that start the agent in the permission mode of the level chosen for new sessions; ''."""
    try:
        import autonomy
        agent = E.get(agent_id)
        return agent.terminal_permission_args(autonomy.chat_mode(level or autonomy.load()["level"], agent.agent))
    except Exception:
        return ""


def launch_command(agent_id, path, env=None, level=None):
    """The line to type for an agent whose file is `path`: the quoted full path plus its terminal-interface arguments,
    the permission mode chosen for new sessions, and what tells Dispatch when its turn ends."""
    parts = [turn_env(agent_id, env), shlex.quote(path), E.get(agent_id).terminal_args, permission_args(agent_id, level), turn_args(agent_id, env)]
    return " ".join(p for p in parts if p)


def _found(agent, env=None):
    """The agent's file when it is on this Mac and is the agent (a short name another tool also uses is checked with
    --version), else ''. No version or sign-in lookup: the picker has to open at once."""
    path = AC.find(agent, env)
    if not path:
        return ""
    if agent.get("reject_output") or agent.get("verify"):
        text = AC._version_text(path)
        if (agent.get("reject_output") and re.search(agent["reject_output"], text)) or (agent.get("verify") and not E.parse_version(text)):
            return ""
    return path


def rows(env=None, choice=None, workers=12):
    """The agents on this Mac that can run in a terminal, in the order the picker shows them: the ones the person
    uses with Dispatch first (the default among them first), then the others found."""
    choice = choice or AC.load_choice()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        paths = list(pool.map(lambda a: _found(a, env), AC.CATALOG))
    out = []
    for agent, path in zip(AC.CATALOG, paths):
        if not path:
            continue
        command = launch_command(agent["id"], path, env)
        out.append({"id": agent["id"], "name": agent["name"], "about": agent.get("about", ""), "path": path,
                    "command": command, **recipe(agent["id"], command),
                    "runnable": bool(agent.get("runnable")),
                    "enabled": AC.is_enabled(agent["id"], choice), "is_default": False})
    first = next((r for r in out if r["runnable"] and r["enabled"]), None)
    default = next((r for r in out if r["id"] == choice["default"] and r["enabled"]), None) or first
    if default:
        default["is_default"] = True
    order = {a["id"]: i for i, a in enumerate(AC.CATALOG)}
    return sorted(out, key=lambda r: (0 if r["enabled"] else 1, 0 if r["is_default"] else 1, 0 if r["runnable"] else 1, order[r["id"]]))
