# -*- coding: utf-8 -*-
"""Every coding-agent CLI a Mac may have, which of them are here, and which ones the person uses with Dispatch.

Dispatch wraps the official agent CLIs; it does not run its own agent. `CATALOG` is the list it knows by name
(from the engine registry, engines/): the binary, how it is installed, and whether Dispatch can start sessions with it
(`runnable`: the engines with a chat driver have an agent host behind the session picker; the others are only detected). Detection
looks in the folders agents install into (engines.search_path: ~/.local/bin, Homebrew, npm / bun / pnpm /
cargo globals, ~/.amp/bin ...) because the app starts from the Dock with a bare PATH, then asks each one found
for its version, all at once with a short timeout.

The choice of agents lives in DISPATCH_DIR/agents.json (a file, not the task board: the first-run wizard asks
before there is a board):

    {"off": ["codex"], "on": ["gemini"], "default": "claude"}

`off` is for the agents Dispatch can run: all are on until named there, so one installed later shows up by
itself. `on` is for the others: they are off until named there. `default` is the agent a new session starts
with ("" = the first one that is on). `dispatch engines use --off … --on … --default …` writes it; the session
pickers of the Agents window read it (dispatch-bridge `dispatch.engines enabled`).

The list itself, and the Orca catalog it follows (MIT License), is in engines/catalog.py.
"""
import concurrent.futures
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import engines as E

# Every agent Dispatch knows, as detection rows: an engine with an adapter file (engines/<id>.py) carries its own row,
# the others are in engines/catalog.py. id, name, about (one plain sentence for the list: who makes it, what it costs or
# needs), bins, install (what a person would type), runnable, and for names other tools use too a check that the file
# is the agent (real_match, reject_real, reject_output, verify; see engines/catalog.py).
CATALOG = [e.catalog_row() for e in E.known()]
BY_ID = {a["id"]: a for a in CATALOG}
RUNNABLE = tuple(a["id"] for a in CATALOG if a.get("runnable"))
VERSION_TIMEOUT = 6


def home():
    return os.path.expanduser("~")


# ---------------------------------------------------------------- detection

def find(agent, env=None):
    """The first copy of the agent on the search path that is the agent (and not another tool of that name)."""
    for name in agent["bins"]:
        for path in E.candidates(name, env):
            real = os.path.realpath(path)
            if agent.get("real_match") and not re.search(agent["real_match"], real, re.I):
                continue
            if agent.get("reject_real") and re.search(agent["reject_real"], real):
                continue
            return path
    return ""


def _version_text(path):
    """`path --version`'s output, remembered per file (engines.version_output); '' for a CLI that hangs or cannot start."""
    return E.version_output(path, VERSION_TIMEOUT)


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def account_of(agent_id):
    """One phrase from the files the agent keeps locally; never an email, a login or a key. '' when unknown."""
    import engines
    return engines.get(agent_id).sign_in_local(home(), os.environ)


def detect_one(agent, env=None):
    """One catalog row without the person's choice: id, name, installed, path, version, account, install, runnable."""
    row = {"id": agent["id"], "name": agent["name"], "installed": False, "path": "", "version": "", "account": "",
           "about": agent.get("about", ""), "install": agent.get("install", ""), "runnable": bool(agent.get("runnable")), "sessions": None}
    path = find(agent, env)
    if not path:
        return row
    text = ""
    if agent.get("reject_output") or agent.get("verify"):
        text = _version_text(path)
        if (agent.get("reject_output") and re.search(agent["reject_output"], text)) or (agent.get("verify") and not E.parse_version(text)):
            return row
    row.update(installed=True, path=path)
    if not agent.get("runnable"):
        row["version"] = E.parse_version(text) or E.installed_version(path, VERSION_TIMEOUT)
        row["account"] = account_of(agent["id"])
    return row


def detect(env=None, only=None, workers=12):
    """Rows for the catalog (or the ids in `only`), looked up at once; the order of the catalog."""
    agents = [a for a in CATALOG if not only or a["id"] in only]
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(lambda a: detect_one(a, env), agents))


# ---------------------------------------------------------------- the choice

def choice_path():
    return os.path.join(os.environ.get("DISPATCH_DIR") or E.DISPATCH_DIR, "agents.json")


def load_choice():
    """{off, on, default, saved}: `off` the runnable agents turned off, `on` the others turned on, `default` the agent
    a new session starts with ('' = none chosen); saved False until set once."""
    d = _read_json(choice_path())
    ids = lambda key, runnable: [x for x in (d.get(key) or []) if isinstance(x, str) and x in BY_ID and bool(BY_ID[x].get("runnable")) == runnable]  # noqa: E731
    off = ids("off", True)
    default = d.get("default") if isinstance(d.get("default"), str) else ""
    if default not in RUNNABLE or default in off:
        default = ""
    return {"off": off, "on": ids("on", False), "default": default, "saved": os.path.exists(choice_path())}


def is_enabled(agent_id, choice=None):
    choice = choice or load_choice()
    if agent_id not in BY_ID:
        return False
    return agent_id not in choice["off"] if BY_ID[agent_id].get("runnable") else agent_id in choice["on"]


def _ids(value):
    """'a,b' or a list → known ids, in catalog order; an unknown id is an error."""
    items = [x.strip() for x in (value.split(",") if isinstance(value, str) else value or []) if str(x).strip()]
    bad = [x for x in items if x not in BY_ID]
    if bad:
        raise ValueError(f"unknown agent {bad[0]}: one of {', '.join(BY_ID)}")
    return [a["id"] for a in CATALOG if a["id"] in items]


def save_choice(off=None, on=None, default=None, reset=False):
    """Write the choice: `off`, `on` and `default` replace what was saved when given ('' clears the default). Turning
    off every agent Dispatch can run is refused (a session needs one); the default must be one of them, and turning
    it off clears it. Returns what load_choice then answers."""
    path = choice_path()
    if reset:
        try:
            os.unlink(path)
        except OSError:
            pass
        return load_choice()
    cur = load_choice()
    new_off = [x for x in _ids(off) if BY_ID[x].get("runnable")] if off is not None else cur["off"]
    new_on = [x for x in _ids(on) if not BY_ID[x].get("runnable")] if on is not None else cur["on"]
    if all(x in new_off for x in RUNNABLE):
        raise ValueError("Keep at least one agent on: Dispatch needs one to start a session.")
    new_default = cur["default"] if default is None else (default or "").strip()
    if new_default and new_default not in RUNNABLE:
        raise ValueError("Pick one of the agents Dispatch can start sessions with: " + ", ".join(BY_ID[x]["name"] for x in RUNNABLE) + ".")
    if new_default in new_off:
        new_default = ""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix="agents-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"off": new_off, "on": new_on, "default": new_default}, f, indent=1)
    os.replace(tmp, path)
    return load_choice()


def with_choice(rows, choice=None):
    """The rows plus `enabled` and `is_default` (the saved default, else the first agent Dispatch runs that is here
    and on), in the order a person reads them: what Dispatch runs, then the others found, then the others not found."""
    choice = choice or load_choice()
    out = [dict(r, enabled=is_enabled(r["id"], choice)) for r in rows]
    first = next((r["id"] for r in out if r["runnable"] and r["installed"] and r["enabled"]), "")
    default = choice["default"] if any(r["id"] == choice["default"] and r["installed"] for r in out) else first
    out = [dict(r, is_default=r["id"] == default) for r in out]
    rank = lambda r: 0 if r["runnable"] else 1 if r["installed"] else 2  # noqa: E731
    return sorted(out, key=lambda r: (rank(r), [a["id"] for a in CATALOG].index(r["id"])))
