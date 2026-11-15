# -*- coding: utf-8 -*-
"""`dispatch mcp list|add|remove`: the MCP servers of every engine Dispatch runs, in one place.

Each engine keeps its own file and its own shape; its adapter (engines/<id>.py, the mcp_* part of the
interface) reads them into one row format and writes each back in its own format, leaving everything
else in the file as it was. Every write keeps the previous file in ~/.dispatch/backups/<date>/ first. The "mcpServers"
JSON shape Claude Code shares with Cursor, Gemini CLI and others is here (json_*), for adapters to use.

`list --json` (the Customizations MCP page reads this):
  {"schema": 1,
   "configs": {"<engine>" (claude-code, codex, opencode): {"path", "exists", "writable"}},
   "servers": [{"name", "engine", "scope": "user" | "local" | "project", "transport": "stdio" | "http" | "sse",
                "command", "args", "url", "env": [names], "headers": [names], "enabled", "path"}],
   "names": [{"name", "engines": {"<engine>": {"scope", "enabled", "transport"}}}]}
Values of env and headers are never printed (they are often keys), only their names.
`add <name> --from <engine>` copies a server from that engine with its env and headers (values are read
from the source file and written to the others, never printed).
`add` / `remove` print {"name", "changed": [{"engine", "path", "backup", "action"}], "skipped": [{"engine", "reason"}]}.
`add <preset>` with no --url or command adds a known service (PRESETS: Higgsfield's hosted server) and
says how each engine signs in to it; `presets` lists them.
`serve`, `register`, `status`, `on` and `off` are Dispatch's own server (dispatch_mcp.py); its rows in `list` carry
"builtin": true, and `list` has {"builtin": {"name", "on", "engines", "about", "if_off"}} for Settings' switch.
"""
import json
import os
import re
import shutil

import engines as E



def mcp_engines():
    """The engines whose MCP servers Dispatch reads and writes (their adapters' mcp_* part), in the registry's order."""
    return [e for e in E.known() if e.supports("mcp_file")]


ENGINES = tuple(e.agent for e in mcp_engines())

# Services with an official hosted MCP server: `dispatch mcp add <name>` needs nothing else. Signing in
# happens in each engine the first time (OAuth in the browser), so no key ever passes through Dispatch.
PRESETS = {
    "higgsfield": {
        "url": "https://mcp.higgsfield.ai/mcp", "transport": "http",
        "about": "Higgsfield: make images and videos (Kling, Veo, Seedance, Soul…) with your Higgsfield account and its credits",
    },
}
BARE = re.compile(r"^[A-Za-z0-9_-]+$")


def home():
    return os.path.expanduser("~")


def instance_home():
    """In a test instance without its own fixture HOME: the scratch HOME Customizations edits there
    (customizations.home), so no instance ever writes the person's ~/.claude.json or opencode.json.
    None everywhere else, including an instance whose HOME already is its fixture."""
    if not os.environ.get("DISPATCH_SESSION_ROOT"):
        return None
    import customizations
    h = str(customizations.home())
    return None if os.path.realpath(h) == os.path.realpath(home()) else h


def paths(env=None):
    """{engine: the file it keeps its own MCP servers in}."""
    env = os.environ if env is None else env
    where = home()
    scratch = instance_home()
    if scratch:
        where, env = scratch, {"XDG_CONFIG_HOME": os.path.join(scratch, ".config")}
    return {e.agent: e.mcp_file(where, env) for e in mcp_engines()}


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def _write(path, text):
    """Keep the old file in ~/.dispatch/backups/<date>/, then replace atomically (mode kept)."""
    import backups
    backup = backups.save(path) if os.path.exists(path) else ""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".dispatch-tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    if os.path.exists(path):
        shutil.copymode(path, tmp)
    os.replace(tmp, path)
    return backup


def _names(d):
    return sorted(d) if isinstance(d, dict) else []


# ---------------------------------------------------------------- the "mcpServers" JSON shape (Claude Code, Cursor, Gemini CLI…)

def json_row(name, v, scope, path, engine):
    v = v if isinstance(v, dict) else {}
    kind = v.get("type") or ("http" if v.get("url") else "stdio")
    return {"name": name, "engine": engine, "scope": scope, "transport": "sse" if kind == "sse" else "http" if kind in ("http", "streamable-http") else "stdio",
            "command": str(v.get("command") or ""), "args": [str(x) for x in v.get("args") or []], "url": str(v.get("url") or ""),
            "env": _names(v.get("env")), "headers": _names(v.get("headers")), "enabled": v.get("disabled") is not True, "path": path}


def json_entry(spec):
    if spec["url"]:
        e = {"type": spec["transport"] if spec["transport"] in ("http", "sse") else "http", "url": spec["url"]}
        headers = {**spec["headers"], **{k: spec.get("header_prefix", {}).get(k, "") + "${" + v + "}" for k, v in spec.get("header_env", {}).items()}}
        if headers:
            e["headers"] = headers
        return e
    e = {"type": "stdio", "command": spec["command"], "args": spec["args"]}
    if spec["env"]:
        e["env"] = spec["env"]
    return e


def json_edit(path, name, entry):
    """entry None removes. The backup path ('' with no file before), None when nothing changed."""
    text = _read(path)
    data = json.loads(text) if text else {}
    servers = data.setdefault("mcpServers", {})
    if entry is None:
        if name not in servers:
            return None
        del servers[name]
    else:
        servers[name] = entry
    return _write(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def json_spec(v):
    kind = v.get("type") or ("http" if v.get("url") else "stdio")
    spec = blank_spec()
    spec.update(url=str(v.get("url") or ""), transport="sse" if kind == "sse" else "http", command=str(v.get("command") or ""),
                args=[str(x) for x in v.get("args") or []], env={k: str(x) for k, x in (v.get("env") or {}).items()},
                headers={k: str(x) for k, x in (v.get("headers") or {}).items()})
    return spec


def blank_spec():
    """What `add` writes: a URL or a command, with env and headers (header_env: headers that name a variable).
    Dispatch's own server (dispatch_mcp.spec) also sets pass_env (variables an engine that does not hand its whole
    environment to a server passes on), trusted (its tools run without asking) and timeout (seconds a tool may take)."""
    return {"url": "", "transport": "http", "command": "", "args": [], "env": {}, "headers": {}, "header_env": {}, "header_prefix": {},
            "pass_env": [], "trusted": False, "timeout": 0}


# ---------------------------------------------------------------- one project's tools (task-gsmh)
#
# Which MCP servers the agents in one project folder get, and a switch per engine that only changes that
# project, in each engine's own per-project place (its adapter's mcp_project and mcp_project_set say where).
# Servers in .cursor/mcp.json are listed as Cursor's: no agent Dispatch runs reads that file.

PROJECT_ENGINES = tuple(e.agent for e in mcp_engines() if e.supports("mcp_project_set"))


def _json_file(path):
    try:
        d = json.loads(_read(path) or "{}")
    except ValueError:
        return {}
    return d if isinstance(d, dict) else {}


def _what(row):
    return row.get("url") or " ".join([row.get("command") or "", *(row.get("args") or [])]).strip()


def project_tools(folder, env=None):
    """{"folder", "codex_trusted", "files": {...}, "tools": [{"name", "what", "transport", "from": "everyone" | "project" | "cursor",
    "engines": {engine: {"has": bool, "on": bool, "state": "on" | "off" | "ask" | "none", "where": path}}}]}
    (anything else an engine says about the folder, such as Codex's trust, sits next to "folder")."""
    folder = os.path.realpath(folder)
    p = paths(env)
    tools, files, extra = {}, {}, {}

    def tool(name, row, origin):
        t = tools.setdefault(name, {"name": name, "what": _what(row), "transport": row.get("transport") or "stdio", "from": origin,
                                    "engines": {e: {"has": False, "on": False, "state": "none", "where": ""} for e in PROJECT_ENGINES}})
        if origin == "project" and t["from"] == "everyone":
            t["from"] = "project"
        if not t["what"]:
            t["what"] = _what(row)
        return t

    for eng in mcp_engines():
        if eng.agent not in PROJECT_ENGINES:
            continue
        here = eng.mcp_project(folder, p[eng.agent], env)
        for name, row, origin, state in here["servers"]:
            tool(name, row, origin)["engines"][eng.agent] = state
        files.update(here.get("files") or {})
        extra.update(here.get("extra") or {})
    cursor = os.path.join(folder, ".cursor", "mcp.json")
    for name, v in (_json_file(cursor).get("mcpServers") or {}).items():
        if name not in tools:
            tool(name, json_row(name, v, "project", cursor, "cursor"), "cursor")
    files["cursor"] = cursor if os.path.isfile(cursor) else ""
    order = {"project": 0, "everyone": 1, "cursor": 2}
    return {"folder": folder, **extra, "files": files,
            "tools": sorted(tools.values(), key=lambda t: (order[t["from"]], t["name"].lower()))}


def set_project_tool(folder, name, engine, on, env=None):
    """Turn one server on or off for one engine in one project folder. Returns {"engine", "path", "backup", "note"}."""
    engine = E.agent_of(engine)
    if engine not in PROJECT_ENGINES:
        raise ValueError("Unknown engine: " + engine)
    folder = os.path.realpath(folder)
    if not os.path.isdir(folder):
        raise ValueError("That project's folder is not on this Mac.")
    listing_ = project_tools(folder, env)
    t = next((x for x in listing_["tools"] if x["name"] == name), None)
    if not t or not t["engines"][engine]["has"]:
        raise ValueError(f"{name} is not set up for {engine} here. Add it in Settings › MCP servers first.")
    path, backup, note = E.get(engine).mcp_project_set(folder, name, on, t["engines"][engine], paths(env)[engine], listing_)
    return {"engine": engine, "path": path, "backup": backup, "note": note}


# ---------------------------------------------------------------- the command

def listing(cwd="", env=None):
    p = paths(env)
    servers, configs = [], {}
    for eng in mcp_engines():
        engine = eng.agent
        exists = os.path.isfile(p[engine])
        configs[engine] = {"path": p[engine], "exists": exists, "writable": os.path.isdir(os.path.dirname(p[engine]))}
        try:
            servers += eng.mcp_rows(p[engine], cwd) if exists or eng.mcp_in_home else []
        except (ValueError, OSError) as e:
            configs[engine]["error"] = str(e)[:200]
    import dispatch_mcp
    names = {}
    for s in servers:
        s["builtin"] = s["name"] == dispatch_mcp.NAME and dispatch_mcp.is_ours(s)  # Dispatch's own server (dispatch_mcp.py)
        names.setdefault(s["name"], {})[s["engine"]] = {"scope": s["scope"], "enabled": s["enabled"], "transport": s["transport"]}
    # Dispatch's own server, for Settings › Soul to list with its switch (task-lj06.23)
    ours = sorted({s["engine"] for s in servers if s["builtin"] and s["scope"] == "user"})
    builtin = {"name": dispatch_mcp.NAME, "on": bool(ours), "engines": ours, "about": dispatch_mcp.ABOUT, "if_off": dispatch_mcp.IF_OFF}
    return {"schema": 1, "configs": configs, "servers": servers,
            "names": [{"name": n, "engines": names[n]} for n in sorted(names)], "builtin": builtin}


def _pairs(items, what):
    out = {}
    for item in items or []:
        if "=" not in item:
            raise ValueError(f"--{what} takes KEY=VALUE, got {item!r}")
        k, v = item.split("=", 1)
        out[k.strip()] = v
    return out


def spec_of(a):
    command = [c for c in (a.command or []) if c != "--"]
    url = (a.url or "").strip()
    if bool(url) == bool(command):
        raise ValueError("Give either --url URL or the command after --, e.g. dispatch mcp add github -- npx -y @modelcontextprotocol/server-github")
    return {"url": url, "transport": a.transport or "http", "command": command[0] if command else "", "args": command[1:],
            "env": _pairs(a.env, "env"), "headers": _pairs(a.header, "header")}


def raw_server(engine, name, env=None):
    """The server `name` as the engine's own file has it, values included (never printed)."""
    return E.get(engine).mcp_raw(paths(env)[engine], name)


ENV_REF = re.compile(r"^(.*?)(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\})$")


def spec_from(engine, name, env=None):
    """`add --from <engine>`: the server copied with its env and headers, secrets included. A header
    that names an environment variable (Claude's ${VAR}, OpenCode's {env:VAR}, Codex's env_http_headers
    and bearer_token_env_var) stays a reference in each engine's own syntax."""
    v = raw_server(engine, name, env)
    if not isinstance(v, dict):
        raise ValueError(f"{name} is not configured in {engine}")
    spec = E.get(engine).mcp_spec(name, v)
    for k, value in list(spec["headers"].items()):
        m = ENV_REF.match(value)
        if m:
            del spec["headers"][k]
            spec["header_env"][k] = m.group(2) or m.group(3)
            if m.group(1):
                spec["header_prefix"][k] = m.group(1)
    if not spec["url"] and not spec["command"]:
        raise ValueError(f"{name} in {engine} has neither a command nor a URL")
    return spec


def engines_of(value):
    picked = [e.strip() for e in (value or "").split(",") if e.strip()]
    picked = [E.agent_of(e) for e in picked] or list(ENGINES)
    bad = [e for e in picked if e not in ENGINES]
    if bad:
        raise ValueError("Unknown engine: " + ", ".join(bad) + " (%s)" % ", ".join(ENGINES))
    return picked


def change(name, spec, engines, replace=False, env=None):
    if not name or not BARE.match(name):
        raise ValueError("Server names use letters, digits, - and _")
    p = paths(env)
    have = {(s["engine"], s["name"]) for s in listing(env=env)["servers"] if s["scope"] == "user"}
    changed, skipped = [], []
    for engine in engines:
        path = p[engine]
        folder = os.path.dirname(path)
        eng = E.get(engine)
        if not eng.mcp_in_home and not os.path.isdir(folder):
            skipped.append({"engine": engine, "reason": f"{folder} does not exist (not installed)"})
            continue
        if spec is not None and (engine, name) in have and not replace:
            skipped.append({"engine": engine, "reason": "already configured; add --replace to overwrite"})
            continue
        try:
            backup = eng.mcp_edit(path, name, spec)
        except (ValueError, OSError) as e:
            skipped.append({"engine": engine, "reason": str(e)[:300]})
            continue
        if backup is None:
            skipped.append({"engine": engine, "reason": "not configured there"})
            continue
        changed.append({"engine": engine, "path": path, "backup": backup, "action": "removed" if spec is None else "added"})
    return {"name": name, "changed": changed, "skipped": skipped}


def list_text(r):
    if not r["names"]:
        return "No MCP servers configured in " + E.join_words([e.name for e in mcp_engines()], "or") + "."
    lines = []
    for row in r["names"]:
        marks = "  ".join(f"{e} {'on' if row['engines'][e]['enabled'] else 'off'}" if e in row["engines"] else f"{e} -" for e in ENGINES)
        first = next(s for s in r["servers"] if s["name"] == row["name"])
        what = first["url"] or " ".join([first["command"], *first["args"]])
        lines.append(f"{row['name']}: {marks}  ({first['transport']}: {what[:80]})")
    return "\n".join(lines)


def signin_of(name):
    """How each engine signs in to a hosted server the first time (OAuth in the browser)."""
    return {e.agent: e.mcp_signin.format(name=name) for e in mcp_engines() if e.mcp_signin}


def preset_spec(name):
    p = PRESETS[name]
    return {"url": p["url"], "transport": p["transport"], "command": "", "args": [], "env": {}, "headers": {}}


def command(a):
    op = a.op or "list"
    if op in ("serve", "register", "status", "on", "off"):
        import dispatch_mcp
        return dispatch_mcp.command(a)
    try:
        if op == "presets":
            rows = [{"name": k, "url": v["url"], "about": v["about"], "signin": signin_of(k)} for k, v in PRESETS.items()]
            print(json.dumps(rows, ensure_ascii=False, indent=1) if a.json else "\n".join(f"{r['name']}: {r['about']} ({r['url']})" for r in rows))
            return 0
        if op == "list":
            r = listing(cwd=a.cwd or "")
            print(json.dumps(r, ensure_ascii=False, indent=1) if a.json else list_text(r))
            return 0
        if not a.name:
            raise ValueError(f"Usage: dispatch mcp {op} <name> ...")
        source = getattr(a, "from_engine", "") or ""
        if op == "add" and source:
            source = E.agent_of(source)
            targets = [e for e in engines_of(a.engine) if e != source]
            r = change(a.name, spec_from(source, a.name), targets, replace=a.replace)
        elif op == "add" and a.name in PRESETS and not (a.url or "").strip() and not [c for c in (a.command or []) if c != "--"]:
            r = change(a.name, preset_spec(a.name), engines_of(a.engine), replace=a.replace)
            how = signin_of(a.name)
            r["signin"] = {c["engine"]: how[c["engine"]] for c in r["changed"] if c["engine"] in how}
        else:
            r = change(a.name, spec_of(a) if op == "add" else None, engines_of(a.engine), replace=a.replace)
    except ValueError as e:
        print(json.dumps({"ok": False, "message": str(e)}) if a.json else str(e))
        raise SystemExit(2)
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=1))
    else:
        for c in r["changed"]:
            print(f"{c['engine']}: {c['action']} {r['name']} in {c['path']}" + (f" (previous file: {c['backup']})" if c["backup"] else ""))
        for s in r["skipped"]:
            print(f"{s['engine']}: skipped, {s['reason']}")
        for engine, how in (r.get("signin") or {}).items():
            print(f"{engine}: sign in once: {how}")
    if op == "remove" and a.name == "dispatch" and r["changed"]:
        import dispatch_mcp
        dispatch_mcp.remember(False)  # the Agents window does not put it back; `dispatch mcp register` does
    if not r["changed"]:
        raise SystemExit(1)
    return 0
