# -*- coding: utf-8 -*-
"""The helper agents that come with Dispatch (`dispatch builtin-agents`): engineer, tester, researcher,
designer, teaching-master, animation-director, one `<name>.md` each in the repo's agent/agents (agent/agents next to cli/ in the package).

They are installed as copies, never links (an edit through a link would change the app itself), in the
place each engine reads its own sub-agents:

    Claude Code  ~/.dispatch/agents/<name>.md          (~/.claude/agents links there), the file as shipped
    Codex        ~/.codex/agents/<name>.toml           name, description, developer_instructions
    OpenCode     ~/.config/opencode/agents/<name>.md   description, mode: subagent, the role

A file of the same name that is already there is the person's and is never replaced. What Dispatch wrote
is remembered by its hash in ~/.dispatch/config.json (`builtin_agents`): while a file still has that hash it
is Dispatch's and an update replaces it with the new version; once the person edits it, it is theirs. A
file Dispatch wrote that is gone was deleted on purpose and is not put back. Turning one off removes
Dispatch's copies and keeps it off through updates; turning it on installs it again.

First-run setup installs them (onboarding's Skills step, the terminal wizard); the Agents window runs
`builtin-agents sync --if-set-up` each time it opens, so an update reaches people who set up before.
"""
import hashlib
import json
import os
import re

import dispatch_dir as DD
import engines as E

HERE = os.path.dirname(os.path.abspath(__file__))


def shipped_dir():
    for c in (os.path.join(HERE, "..", "agent", "agents"), os.path.join(HERE, "agent", "agents"), os.path.join(HERE, "..", "..", "agent", "agents")):
        if os.path.isdir(c):
            return os.path.abspath(c)
    return ""


def split(text):
    """(frontmatter dict, body): `key: value` lines only, quotes taken off."""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    fm = {}
    for line in text[3:end].strip("\n").splitlines():
        if ":" in line and line[:1] not in (" ", "\t", "#"):
            k, v = line.split(":", 1)
            v = v.strip()
            if len(v) > 1 and v[0] == v[-1] and v[0] in "\"'":
                v = json.loads(v) if v[0] == '"' else v[1:-1]
            fm[k.strip()] = v
    return fm, text[end + 4:].lstrip("\n")


def shipped():
    """{name: {file, text, fm, body}} for every definition that ships, by name."""
    d = shipped_dir()
    out = {}
    if not d:
        return out
    for n in sorted(os.listdir(d)):
        p = os.path.join(d, n)
        if not n.endswith(".md") or n.startswith(".") or n.lower() == "readme.md" or not os.path.isfile(p):
            continue
        with open(p, encoding="utf-8") as f:
            text = f.read()
        fm, body = split(text)
        name = fm.get("name") or n[:-3]
        out[name] = {"file": p, "text": text, "fm": fm, "body": body}
    return out


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def yaml_scalar(v):
    if re.search(r"(:\s|\s#|^[\s'\"\[\]{}&*!|>%@`,?-])|:$", v):
        return json.dumps(v, ensure_ascii=False)
    return v


def toml_string(s):
    """A multi-line TOML string holding `s` exactly."""
    if "'''" not in s:
        return "'''\n" + s + "'''"
    esc = s.replace("\\", "\\\\").replace('"""', '\\"\\"\\"')
    return '"""\n' + esc + '"""'


def render(engine, d):
    """The definition in the engine's own format (its adapter's subagent_text, engines/)."""
    return E.get(engine).subagent_text(d)


# ---------------------------------------------------------------- where each engine reads them

def _home():
    return DD.home()


def engine_dirs():
    """{engine: (folder Dispatch writes to, file extension, other folders where a same-named file is the person's)}
    for the engines on this Mac that read agent definitions (each adapter's subagent_folder, engines/)."""
    h, env = _home(), os.environ
    return {e.id: e.subagent_folder(h, env) for e in E.runnable() if e.subagent_folder(h, env)}


def _read(p):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def _write(p, text):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = f"{p}.dispatch-tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, p)


# ---------------------------------------------------------------- remembered state

def state():
    c = DD.config_load().get("builtin_agents") or {}
    return {"off": sorted({x for x in (c.get("off") or []) if isinstance(x, str)}),
            "files": {k: v for k, v in (c.get("files") or {}).items() if isinstance(v, dict)}}


def save_state(st):
    d = DD.config_load()
    d["builtin_agents"] = {"off": sorted(set(st["off"])), "files": st["files"]}
    DD.config_save(d)


def set_up():
    """Has this Mac been set up for Dispatch (or did Dispatch install these before)? The Agents window's sync on
    every start only runs then: a person who has not been through setup gets nothing written for other apps."""
    if state()["files"]:
        return True
    try:
        import dispatch as D
        for p in (os.path.join(D.DISPATCH_DIR, "onboarding.json"), os.path.join(D.DISPATCH_DIR, "init.json")):
            try:
                with open(p, encoding="utf-8") as f:
                    s = json.load(f)
            except (OSError, ValueError):
                continue
            if isinstance(s, dict) and (s.get("state") == "done" or s.get("done") is True):
                return True
    except Exception:
        pass
    return False


# ---------------------------------------------------------------- sync / on / off / list

def _file_state(engine, name, d, dirs, st):
    """(state, path): current | update | yours | removed | missing."""
    folder, ext, others = dirs[engine]
    p = os.path.join(folder, name + ext)
    want = render(engine, d)
    rec = st["files"].get(f"{engine}:{name}")
    cur = _read(p) if os.path.lexists(p) else None
    if cur is None and os.path.lexists(p):
        return "yours", p  # something there Dispatch cannot read: not its own
    if cur is None:
        if any(os.path.lexists(os.path.join(o, name + ext)) and os.path.realpath(o) != os.path.realpath(folder) for o in others):
            return "yours", p
        # Dispatch put it there and it is gone: deleted on purpose, not put back
        return ("removed" if rec else "missing"), p
    h = sha(cur)
    if h == sha(want):
        return "current", p
    if rec and h == rec.get("sha"):
        return "update", p
    return "yours", p


def link_claude():
    """Claude Code installed after setup has no ~/.claude/agents yet: make it the link to ~/.dispatch/agents that
    setup makes (dispatch_dir.py), so it sees these and the person's own. A folder or link already there stays."""
    claude = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(_home(), ".claude")
    link = os.path.join(claude, "agents")
    if os.path.isdir(claude) and not os.path.lexists(link):
        os.makedirs(DD.path("agents"), exist_ok=True)
        os.symlink(DD.path("agents"), link)
        return link
    return ""


def sync(names=None, dry_run=False):
    """Install or update the built-in agents for every engine on this Mac. Returns one row per file looked at."""
    if not dry_run:
        link_claude()
    defs = shipped()
    st = state()
    dirs = engine_dirs()
    rows = []
    changed = False
    for name, d in defs.items():
        if names and name not in names:
            continue
        for engine in dirs:
            key = f"{engine}:{name}"
            s, p = _file_state(engine, name, d, dirs, st)
            action = {"current": "current", "update": "updated", "missing": "installed", "yours": "kept yours", "removed": "removed by you"}[s]
            if name in st["off"]:
                action = "off" if s != "yours" else "kept yours"
            elif s in ("update", "missing") and not dry_run:
                text = render(engine, d)
                _write(p, text)
                st["files"][key] = {"path": p, "sha": sha(text)}
                changed = True
            elif s == "current" and st["files"].get(key, {}).get("sha") != sha(render(engine, d)) and not dry_run:
                st["files"][key] = {"path": p, "sha": sha(render(engine, d))}
                changed = True
            elif s == "removed" and not st["files"].get(key, {}).get("removed") and not dry_run:
                st["files"][key] = dict(st["files"].get(key) or {"path": p}, removed=True)
                changed = True
            rows.append({"name": name, "engine": engine, "path": p, "action": action})
    if changed:
        save_state(st)
    return rows


def turn(name, on):
    defs = shipped()
    if name not in defs:
        raise SystemExit(f"no built-in agent named {name} ({', '.join(defs) or 'none ship with this copy'})")
    st = state()
    dirs = engine_dirs()
    removed = []
    if on:
        st["off"] = [x for x in st["off"] if x != name]
        for k in list(st["files"]):
            if k.endswith(":" + name):
                del st["files"][k]  # deleted by hand earlier: on means put it back
        save_state(st)
        return {"name": name, "enabled": True, "files": sync([name])}
    for engine in dirs:
        s, p = _file_state(engine, name, defs[name], dirs, st)
        if s in ("current", "update"):
            os.unlink(p)
            removed.append(p)
        st["files"].pop(f"{engine}:{name}", None)
    st["off"] = sorted(set(st["off"]) | {name})
    save_state(st)
    return {"name": name, "enabled": False, "removed": removed}


def rows():
    """What Settings › Abilities › Sub-agents shows: each built-in agent, on or off, and per engine whether
    Dispatch's copy is in place or the person has their own of that name."""
    defs = shipped()
    st = state()
    dirs = engine_dirs()
    out = []
    for name, d in defs.items():
        engines = {}
        for engine in dirs:
            s, p = _file_state(engine, name, d, dirs, st)
            engines[engine] = {"state": s, "path": p}
        fm = d["fm"]
        out.append({"name": name, "description": fm.get("description", ""), "model": fm.get("model", ""), "effort": fm.get("effort", ""),
                    "tools": fm.get("tools", ""), "enabled": name not in st["off"], "shipped": d["file"],
                    "path": engines["claude"]["path"], "builtin": engines["claude"]["state"] in ("current", "update"),
                    "yours": [E.get(e).name for e, v in engines.items() if v["state"] == "yours"], "engines": engines})
    return out


def is_builtin(path):
    """Is the definition at `path` one of Dispatch's own copies (unchanged)?"""
    real = os.path.realpath(path)
    for r in rows():
        for v in r["engines"].values():
            if v["state"] in ("current", "update") and os.path.realpath(v["path"]) == real:
                return True
    return False


def log_install(done):
    """Put what setup or an update newly installed in What Dispatch changed on this Mac (Undo turns them off)."""
    new = [r for r in done if r["action"] == "installed"]
    if not new:
        return
    try:
        import onboarding as O
        names = sorted({r["name"] for r in new})
        engines = sorted({E.get(r["engine"]).name for r in new})
        O.log_add("helper-agents", "Helper agents", f"{', '.join(names)} for {', '.join(engines)}. Yours of the same name were kept.",
                  {"names": names, "files": [r["path"] for r in new]}, key="helper-agents:" + ",".join(names))
    except Exception:
        pass


def command(a):
    op = a.op or "list"
    if op == "list":
        res = rows()
    elif op == "sync":
        if getattr(a, "if_set_up", False) and not set_up():
            res = {"skipped": "not set up yet", "files": []}
        else:
            files = sync(dry_run=getattr(a, "dry_run", False))
            if not getattr(a, "dry_run", False):
                log_install(files)
            res = {"files": files}
    elif op in ("on", "off"):
        if not a.name:
            raise SystemExit(f"dispatch builtin-agents {op} <name>")
        res = turn(a.name, op == "on")
    else:
        raise SystemExit(f"unknown op {op}")
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return
    if op == "list":
        for r in res:
            where = ", ".join(f"{E.get(e).name} {v['state']}" for e, v in r["engines"].items())
            print(f"{r['name']:<12} {'on ' if r['enabled'] else 'off'}  {where}")
    elif op == "sync":
        for f in res.get("files", []):
            if f["action"] != "current":
                print(f"{f['action']:<15} {f['engine']:<9} {f['path'].replace(_home(), '~', 1)}")
        if res.get("skipped"):
            print(f"skipped: {res['skipped']}")
    elif op == "on":
        print(f"{res['name']} is on")
    else:
        print(f"{res['name']} is off" + "".join(f"\n  removed {p.replace(_home(), '~', 1)}" for p in res["removed"]))


def add_parser(sub):
    s = sub.add_parser("builtin-agents", help="the helper agents that come with Dispatch (engineer, tester, researcher, designer…): list | sync [--if-set-up] [--dry-run] | on <name> | off <name>. Installed as copies for Claude Code (~/.dispatch/agents), Codex (~/.codex/agents) and OpenCode (~/.config/opencode/agents); a file of yours with the same name is never replaced")
    s.add_argument("op", nargs="?", default="list", choices=["list", "sync", "on", "off"])
    s.add_argument("name", nargs="?", default="")
    s.add_argument("--if-set-up", dest="if_set_up", action="store_true", help="sync: only on a Mac that went through setup (what the Agents window runs at start)")
    s.add_argument("--dry-run", dest="dry_run", action="store_true")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=command)
    return s
