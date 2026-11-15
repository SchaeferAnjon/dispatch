#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Dispatch's own sub-agent definitions (`dispatch agents …`, `dispatch agent run <name> "…"`).

A definition is `<name>.md` in ~/.dispatch/agents (everyone's) or <project>/.dispatch/agents (one
project's): frontmatter name, description, model, effort, tools, engine (optional), then the role
prompt. Claude Code reads them as its own sub-agents (~/.claude/agents links to ~/.dispatch/agents;
`dispatch agents link --project P` links a project's into P/.claude/agents). Codex has no sub-agents:
`dispatch agent run <name> "<task>"` starts an in-app Codex session with the definition as its role,
waits for it, saves the answer under ~/.dispatch/state/agent-runs and prints「<name> 做完了：<path>」
for the session that asked.

The default effort (Customizations › Claude › Sub-agent effort) lives in ~/.dispatch/config.json
(`agents.default_effort`, high unless set). It is written into every definition that has no effort
of its own, and those files are remembered (`agents.defaulted`) so a later change of the default
moves them along; a definition that sets its own effort is never touched.
"""
import datetime, json, os, re, subprocess, sys, time

import dispatch_dir as DD

EFFORTS = ("low", "medium", "high", "max")
DEFAULT_EFFORT = "high"
# Codex calls the top level xhigh; the rest are the same words
TEMPLATE = """---
name: {name}
description: {description}
{extra}---

{body}
"""
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def yaml_scalar(v):
    """A frontmatter value Claude Code's YAML parser reads back as the same string."""
    if re.search(r"(:\s|\s#|^[\s'\"\[\]{}&*!|>%@`,?-])|:$", v):
        return json.dumps(v, ensure_ascii=False)
    return v


def user_dir():
    return DD.path("agents")


def project_dir(project):
    return os.path.join(os.path.abspath(os.path.expanduser(project)), ".dispatch", "agents")


def split(text):
    """(frontmatter dict, frontmatter lines, body). Only `key: value` lines; nothing fancier is used."""
    if not text.startswith("---"):
        return {}, [], text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, [], text
    lines = text[3:end].strip("\n").splitlines()
    fm = {}
    for line in lines:
        if ":" in line and line[:1] not in (" ", "\t", "#"):
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip().strip('"').strip("'")
    body = text[end + 4:].lstrip("\n")
    return fm, lines, body


def set_key(text, key, value):
    """Set one frontmatter key in place, keeping every other line as it is."""
    fm, lines, body = split(text)
    if not lines and not text.startswith("---"):
        return f"---\n{key}: {value}\n---\n\n{text}"
    out, done = [], False
    for line in lines:
        if re.match(rf"^{re.escape(key)}\s*:", line):
            if not done:
                out.append(f"{key}: {value}")
                done = True
            continue
        out.append(line)
    if not done:
        out.append(f"{key}: {value}")
    return "---\n" + "\n".join(out) + "\n---\n\n" + body


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def backup(path):
    """Copy a definition to ~/.dispatch/backups/agents/<time>/<file> before Dispatch changes it. Never
    next to it: Claude Code reads ~/.claude/agents (= ~/.dispatch/agents) with its subfolders, so any .md
    there, a backup included, becomes one more sub-agent. Only real definitions live in that folder."""
    real = os.path.realpath(path)
    if not os.path.isfile(real):
        return ""
    bak_dir = DD.path("backups", "agents", f"{datetime.datetime.now():%Y%m%d-%H%M%S-%f}")
    os.makedirs(bak_dir, exist_ok=True)
    dst = os.path.join(bak_dir, os.path.basename(real))
    import shutil
    shutil.copy2(real, dst)
    return dst


def write(path, text):
    """Write the file itself (a link stays a link: Claude reads its agents through them): a copy of the
    old one goes to .bak first, the new one replaces it in one step. Only `dispatch agents effort` and
    `new` write definitions; running one never does."""
    real = os.path.realpath(path)
    backup(real)
    tmp = f"{real}.dispatch-tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, real)


def defs(project=None):
    """Every definition, a project's first (it wins over a user one of the same name)."""
    cfg = config()
    defaulted = set(cfg["defaulted"])
    rows, seen = [], set()
    places = ([("project", project_dir(project))] if project else []) + [("user", user_dir())]
    for scope, d in places:
        if not os.path.isdir(d):
            continue
        for n in sorted(os.listdir(d)):
            p = os.path.join(d, n)
            if not n.endswith(".md") or n.startswith(".") or not os.path.isfile(p):
                continue
            try:
                fm, _, body = split(read(p))
            except OSError:
                continue
            name = fm.get("name") or n[:-3]
            effort = fm.get("effort", "")
            src = "default" if (scope == "user" and n in defaulted) else ("own" if effort else "none")
            rows.append({"name": name, "file": p, "scope": scope, "description": fm.get("description", ""),
                         "model": fm.get("model", ""), "effort": effort or (cfg["default_effort"] if scope == "project" else ""),
                         "effort_source": src if effort or scope == "user" else "default", "tools": fm.get("tools", ""),
                         "engine": fm.get("engine", ""), "shadowed": name in seen, "body_chars": len(body)})
            seen.add(name)
    return rows


def find_def(name, project=None):
    for r in defs(project):
        if r["name"] == name or os.path.basename(r["file"]) == f"{name}.md":
            return r
    return None


# ---------------------------------------------------------------- default effort

def config():
    c = DD.config_load().get("agents") or {}
    eff = c.get("default_effort") if c.get("default_effort") in EFFORTS else DEFAULT_EFFORT
    return {"default_effort": eff, "defaulted": [x for x in (c.get("defaulted") or []) if isinstance(x, str)]}


def save_config(eff, defaulted):
    d = DD.config_load()
    d["agents"] = dict(d.get("agents") or {}, default_effort=eff, defaulted=sorted(set(defaulted)))
    DD.config_save(d)


def apply_default(effort=None):
    """Write the default effort into the user definitions that have none (or had the old default).
    Returns what changed."""
    cfg = config()
    eff = effort or cfg["default_effort"]
    if eff not in EFFORTS:
        raise SystemExit(f"effort must be one of {', '.join(EFFORTS)}")
    defaulted = set(cfg["defaulted"])
    changed = []
    d = user_dir()
    if os.path.isdir(d):
        for n in sorted(os.listdir(d)):
            p = os.path.join(d, n)
            if not n.endswith(".md") or n.startswith(".") or not os.path.isfile(p):
                continue
            text = read(p)
            fm, _, _ = split(text)
            if fm.get("effort") and n not in defaulted:
                continue  # its own value: never touched
            if fm.get("effort") == eff:
                defaulted.add(n)
                continue
            write(p, set_key(text, "effort", eff))
            defaulted.add(n)
            changed.append({"name": fm.get("name") or n[:-3], "file": p, "from": fm.get("effort", ""), "to": eff})
    defaulted = {n for n in defaulted if os.path.isfile(os.path.join(d, n))}
    save_config(eff, defaulted)
    return {"default_effort": eff, "changed": changed}


# ---------------------------------------------------------------- new / remove / link

def new(name, description="", model="", effort="", tools="", engine="", body="", project=None):
    if not NAME_RE.match(name or ""):
        raise SystemExit("agent name: letters, digits, . _ - (no spaces, no slash)")
    d = project_dir(project) if project else user_dir()
    p = os.path.join(d, f"{name}.md")
    if os.path.exists(p):
        raise SystemExit(f"{name} already exists ({p})")
    cfg = config()
    extra = "".join(f"{k}: {v}\n" for k, v in (("tools", tools), ("model", model), ("effort", effort or (cfg["default_effort"] if not project else "")), ("engine", engine)) if v)
    os.makedirs(d, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(TEMPLATE.format(name=name, description=yaml_scalar((description or f"Use for {name} tasks.").replace("\n", " ")), extra=extra,
                                body=body or f"You are the {name} agent. Describe the role, how to work and what to hand back."))
    if not project and not effort:
        save_config(cfg["default_effort"], set(cfg["defaulted"]) | {f"{name}.md"})
    if project:
        link_project(project)
    return {"name": name, "file": p}


def remove(name, project=None):
    """Move the definition to ~/.dispatch/backups/agents/removed (recoverable) and drop its project link."""
    r = find_def(name, project)
    if not r:
        raise SystemExit(f"no agent named {name}")
    trash = DD.path("backups", "agents", "removed")
    os.makedirs(trash, exist_ok=True)
    dst = os.path.join(trash, f"{os.path.basename(r['file'])[:-3]}-{datetime.datetime.now():%Y%m%d-%H%M%S}.md")
    os.rename(r["file"], dst)
    if project:
        link = os.path.join(os.path.abspath(os.path.expanduser(project)), ".claude", "agents", os.path.basename(r["file"]))
        if os.path.islink(link) and not os.path.exists(link):
            os.unlink(link)  # a dangling link we made ourselves
    return {"name": name, "trashed": dst}


def link_project(project):
    """Link each of the project's definitions into <project>/.claude/agents (relative links, so the
    project folder can move). An existing real file of the same name is left alone."""
    root = os.path.abspath(os.path.expanduser(project))
    src_dir = project_dir(root)
    dst_dir = os.path.join(root, ".claude", "agents")
    made = []
    if not os.path.isdir(src_dir):
        return made
    for n in sorted(os.listdir(src_dir)):
        if not n.endswith(".md") or n.startswith("."):
            continue
        link = os.path.join(dst_dir, n)
        if os.path.lexists(link):
            continue
        os.makedirs(dst_dir, exist_ok=True)
        os.symlink(os.path.join("..", "..", ".dispatch", "agents", n), link)
        made.append(link)
    return made


# ---------------------------------------------------------------- run on Codex (or Claude)

def role_prompt(r, body, task):
    return (f"You are working as the \"{r['name']}\" agent. Its definition (from {r['file']}) is your role for this whole "
            f"conversation:\n\n<agent-definition>\n{body.strip()}\n</agent-definition>\n\n"
            f"Task from the session that called you:\n{task.strip()}\n\n"
            "When you are done, end with a short report: what you did, what you found or made (paths), what is left.")


def run(name, task, project=None, engine="", timeout_ms=1800000, auto=False, cli=None, runner=subprocess.run):
    r = find_def(name, project)
    if not r:
        raise SystemExit(f"no agent named {name} (dispatch agents list)")
    fm, _, body = split(read(r["file"]))
    import engines
    engine = (engine or r["engine"] or "codex").lower()
    eng = engines.find(engine)
    if not eng or not eng.runnable:
        raise SystemExit(f"engine must be {engines.join_words((e.id for e in engines.runnable()), 'or')}, not {engine}")
    engine = eng.id
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    cwd = os.path.abspath(os.path.expanduser(project)) if project else DD.path("chats", f"agent-{name}-{stamp}")
    os.makedirs(cwd, exist_ok=True)
    argv = [sys.executable, cli or os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), "agent", "start", engine,
            "--cwd", cwd, "--label", f"{name}: {task.strip().splitlines()[0][:48]}", "--prompt", role_prompt(r, body, task),
            "--timeout", str(timeout_ms), "--json"]
    model = r["model"]
    if model and eng.takes_model(model):
        argv += ["--model", model]  # a Claude alias means nothing to Codex: it keeps its own default
    effort = r["effort"] or config()["default_effort"]
    if effort:
        argv += ["--extra", f"--effort {eng.effort_name(effort)}"]
    if auto:
        argv.append("--auto")
    p = runner(argv, capture_output=True, text=True, timeout=timeout_ms / 1000 + 180)
    try:
        res = json.loads(p.stdout[p.stdout.find("{"):]) if "{" in (p.stdout or "") else {}
    except ValueError:
        res = {}
    if p.returncode != 0 or not res.get("session"):
        raise SystemExit(f"{name} did not start on {engine}: {(p.stderr or p.stdout or '').strip()[:400]}")
    out_dir = DD.path("state", "agent-runs")
    os.makedirs(out_dir, exist_ok=True)
    out_file = os.path.join(out_dir, f"{stamp}-{name}.md")
    output = (res.get("output") or "").strip()
    with open(out_file, "w", encoding="utf-8") as f:
        f.write(f"# {name}\n\n- engine: {engine}\n- session: {res['session']}\n- folder: {cwd}\n- status: {res.get('status', '')}\n"
                f"- started: {stamp}\n\n## Task\n\n{task.strip()}\n\n## Result\n\n{output or '(no reply yet: dispatch agent read ' + res['session'] + ')'}\n")
    return {"name": name, "engine": engine, "session": res["session"], "cwd": cwd, "status": res.get("status", ""),
            "warning": res.get("warning", ""), "output": output, "result_file": out_file}


# ---------------------------------------------------------------- commands

def cmd_agents(a, out):
    op = a.op or "list"
    project = getattr(a, "project", None) or None
    if op == "list":
        rows = defs(project)

        def text(rows):
            for r in rows:
                eff = r["effort"] + (" (default)" if r["effort_source"] == "default" else "")
                print(f"{r['name']:<20} {r['scope']:<8} {r['model'] or '-':<8} {eff or '-':<16} {r['description'][:60]}")
            print(f"\n{len(rows)} agent(s); default effort {config()['default_effort']}")
        return out(rows, a.json, text)
    if op == "show":
        r = find_def(a.name, project)
        if not r:
            raise SystemExit(f"no agent named {a.name}")
        if a.json:
            return out(dict(r, text=read(r["file"])), True, None)
        print(read(r["file"]))
        return
    if op == "new":
        return out(new(a.name, a.description or "", a.model or "", a.effort or "", a.tools or "", a.engine or "", sys.stdin.read() if a.stdin else "", project),
                   a.json, lambda r: print(f"created {r['file']}"))
    if op == "rm":
        return out(remove(a.name, project), a.json, lambda r: print(f"{r['name']} moved to {r['trashed']}"))
    if op == "link":
        made = link_project(project) if project else []
        return out({"linked": made}, a.json, lambda r: print("\n".join(r["linked"]) or "nothing to link"))
    if op == "effort":
        if a.name and a.name not in EFFORTS:
            raise SystemExit(f"effort must be one of {', '.join(EFFORTS)}")
        res = apply_default(a.name or None) if a.name else dict(config(), changed=[])
        res["agents"] = [{"name": r["name"], "effort": r["effort"], "source": r["effort_source"]} for r in defs()]
        res["choices"] = list(EFFORTS)
        return out(res, a.json, lambda r: print(f"default effort: {r['default_effort']}" + "".join(f"\n  {c['name']}: {c['from'] or '(none)'} -> {c['to']}" for c in r["changed"])))
    raise SystemExit(f"unknown op {op}")


def cmd_run(a, out):
    """`dispatch agent run <name> "<task>"`."""
    if not a.text:
        raise SystemExit('dispatch agent run <name> "<task>" [--project DIR] [--engine codex|claude]')
    res = run(a.target, a.text, getattr(a, "project", None) or (a.cwd if getattr(a, "cwd", None) else None),
              getattr(a, "engine", "") or "", a.timeout, bool(getattr(a, "auto", False)))

    def text(r):
        if r["output"]:
            print(r["output"].rstrip() + "\n")
        if r["warning"]:
            print(f"[!] {r['warning']}")
        print(f"{r['name']} 做完了：{r['result_file']}" if r["status"] in ("idle", "") else f"{r['name']} 还没做完（{r['status']}）：{r['result_file']}，会话 {r['session']}")
    return out(res, a.json, text)


def add_parser(sub):
    import engines
    s = sub.add_parser("agents", help="sub-agent definitions in ~/.dispatch/agents and <project>/.dispatch/agents: list | show | new | rm | link | effort [low|medium|high|max]")
    s.add_argument("op", nargs="?", default="list", choices=["list", "show", "new", "rm", "link", "effort"])
    s.add_argument("name", nargs="?", help="the agent; effort: the new default")
    s.add_argument("--project", help="a project folder: its .dispatch/agents (listed first, linked into its .claude/agents)")
    s.add_argument("--description"); s.add_argument("--model"); s.add_argument("--effort", choices=EFFORTS); s.add_argument("--tools"); s.add_argument("--engine", choices=[e.id for e in engines.runnable()])
    s.add_argument("--stdin", action="store_true", help="new: the role prompt from stdin")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=None)
    return s
