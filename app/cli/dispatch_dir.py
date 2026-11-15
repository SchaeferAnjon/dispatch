#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""~/.dispatch: Dispatch's own data folder — `dispatch dir init|status|migrate [--dry-run]`.

Layout (design/task-model/DECISIONS.md「~/.dispatch 目录」):

  ~/.dispatch/
    skills/   the skill pool (was ~/.cc-switch/skills); Claude and Codex mount single skills from here
    agents/   sub-agent definitions (<name>.md); ~/.claude/agents is a link to this folder
    rules/    dispatch.md (ships with Dispatch) + SOUL.md (made from Dispatch's default, the user's to change) +
              the user's own GLOBAL.md, FACTS.md, PROFILE.md;
              ~/.agents/rules is a link to this folder
    chats/    working folders of sessions started without a project folder
    state/    runtime files; for now they stay in ~/tasks/.dispatch (see state/README.md)
    ssh/      config: `Include ~/.ssh/config` plus one Host per Mac in hosts.json (host_admin.py);
              Dispatch IDE's Remote-SSH reads it, so another Mac's window is ssh-remote+<its name>
    backups/  copies Dispatch keeps before it changes one of your files: backups/<date>/<path from home> (backups.py,
              30 days), and the undo data of a few commands (backups/agents, hosts, preferences); never inside
              agents/ or skills/, which Claude Code reads with their subfolders
    config.json   Dispatch's own settings that belong to this folder (agents.default_effort)

Migration copies, never moves the only copy: every old folder is copied in, the old folder is
renamed to `<name>.pre-dispatch` and the old path becomes a symlink into ~/.dispatch, so every tool
that still uses the old path (cc-switch, Claude Code, `dispatch rules sync`) keeps working.
Mount links in ~/.claude/skills, ~/.agents/skills, ~/.codex/skills that pointed into the old pool
are re-pointed at the same skill in the new pool.
"""
import datetime, filecmp, json, os, shutil, sys

SUBDIRS = ("skills", "agents", "rules", "chats", "state")
BACKUP_SUFFIX = ".pre-dispatch"
_CLI = os.path.dirname(os.path.abspath(__file__))
# the repo keeps it at agent/rules next to app/; the app bundle puts agent/ next to cli/
SHIPPED_RULES = next((p for p in (os.path.join(os.path.dirname(os.path.dirname(_CLI)), "agent", "rules", "dispatch.md"),
                                  os.path.join(os.path.dirname(_CLI), "agent", "rules", "dispatch.md")) if os.path.isfile(p)),
                     os.path.join(os.path.dirname(os.path.dirname(_CLI)), "agent", "rules", "dispatch.md"))


def home():
    return os.path.expanduser("~")


def root():
    """~/.dispatch, or DISPATCH_HOME (tests, a second profile)."""
    env = os.environ.get("DISPATCH_HOME", "").strip()
    return os.path.abspath(os.path.expanduser(env)) if env else os.path.join(home(), ".dispatch")


def path(*parts):
    return os.path.join(root(), *parts)


def chats_folder(cwd):
    """Whether a session works without a project folder (the Agents window's Chats): its folder is Dispatch's
    chats/<id>, the Agents window's ~/.copilot/chats/<id>, or the home folder itself (OpenCode's chats run there).
    No folder at all counts too. Such a session's tasks belong to no project."""
    if not cwd:
        return True
    p = os.path.realpath(os.path.expanduser(cwd)).rstrip("/")
    h = os.path.realpath(home()).rstrip("/")
    if p == h:
        return True
    for base in (path("chats"), os.path.join(home(), ".copilot", "chats")):
        b = os.path.realpath(base).rstrip("/")
        if p == b or p.startswith(b + "/"):
            return True
    return False


def legacy_pool():
    """The skill pool from before ~/.dispatch: cc-switch's folder, else the old ~/.agents/skill-pool."""
    for p in (os.path.join(home(), ".cc-switch", "skills"), os.path.join(home(), ".agents", "skill-pool")):
        if os.path.isdir(p) and not os.path.islink(p):
            return p
    return None


def legacy_places():
    """(kind, old path, new path) for the three folders another tool reads at a fixed place."""
    h = home()
    rows = []
    pool = legacy_pool()
    if pool:
        rows.append(("skills", pool, path("skills")))
    else:  # already migrated: the old pool path is a link now
        for p in (os.path.join(h, ".cc-switch", "skills"), os.path.join(h, ".agents", "skill-pool")):
            if os.path.islink(p):
                rows.append(("skills", p, path("skills")))
    rows.append(("agents", os.path.join(h, ".claude", "agents"), path("agents")))
    rows.append(("rules", os.path.join(h, ".agents", "rules"), path("rules")))
    return rows


def mount_dirs():
    h = home()
    return [os.path.join(h, ".claude", "skills"), os.path.join(h, ".agents", "skills"), os.path.join(h, ".codex", "skills")]


def points_to(link, target):
    try:
        return os.path.islink(link) and os.path.realpath(link) == os.path.realpath(target)
    except OSError:
        return False


def is_inside(p, folder):
    p, folder = os.path.realpath(p), os.path.realpath(folder)
    return p == folder or p.startswith(folder.rstrip(os.sep) + os.sep)


def backup_name(p):
    b = p + BACKUP_SUFFIX
    if not os.path.lexists(b):
        return b
    return f"{b}-{datetime.datetime.now():%Y%m%d-%H%M%S}"


# ---------------------------------------------------------------- plan

def plan():
    """Every step `migrate` would take, in order. Each step is a dict with op / src / dst / why."""
    steps = []
    for d in SUBDIRS:
        if not os.path.isdir(path(d)):
            steps.append({"op": "mkdir", "dst": path(d), "why": f"~/.dispatch/{d}"})
    for kind, old, new in legacy_places():
        if points_to(old, new):
            continue
        if os.path.islink(old):
            steps.append({"op": "skip", "src": old, "dst": os.path.realpath(old), "why": f"{kind}: already a link to somewhere else, left alone"})
            continue
        if os.path.isdir(old):
            for name in sorted(os.listdir(old)):
                if name in (".DS_Store",):
                    continue
                src, dst = os.path.join(old, name), os.path.join(new, name)
                if os.path.lexists(dst):
                    same = _same(src, dst)
                    steps.append({"op": "skip", "src": src, "dst": dst, "why": "already there" + ("" if same else " (different; the copy in ~/.dispatch wins, the old one stays in the backup)")})
                else:
                    steps.append({"op": "copy", "src": src, "dst": dst, "why": kind})
            if kind == "skills":
                steps += _relink_steps(old, new)
            steps.append({"op": "backup", "src": old, "dst": backup_name(old), "why": "kept as it was"})
        elif os.path.lexists(old):
            steps.append({"op": "skip", "src": old, "why": f"{kind}: not a folder, left alone"})
            continue
        elif kind in ("skills", "agents") and not os.path.isdir(os.path.dirname(old)):
            continue  # no cc-switch / no Claude Code here: nothing reads the old place
        steps.append({"op": "symlink", "src": new, "dst": old, "why": f"{kind}: the old path keeps working"})
    shipped = _shipped_rules_step()
    if shipped:
        steps.append(shipped)
    if not os.path.exists(path("README.md")):
        steps.append({"op": "write", "dst": path("README.md"), "why": "what each folder is"})
    if not os.path.exists(path("state", "README.md")):
        steps.append({"op": "write", "dst": path("state", "README.md"), "why": "runtime files are still in ~/tasks/.dispatch"})
    return steps


def _same(a, b):
    try:
        if os.path.isdir(a) and os.path.isdir(b):
            return not filecmp.dircmp(a, b).diff_files
        if os.path.isfile(a) and os.path.isfile(b):
            return filecmp.cmp(a, b, shallow=False)
    except OSError:
        pass
    return False


def _relink_steps(old_pool, new_pool):
    steps = []
    for d in mount_dirs():
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            link = os.path.join(d, name)
            if not os.path.islink(link):
                continue
            # the link as written, not resolved: a pool entry can itself be a link (task-board → a repo)
            target = os.path.normpath(os.path.join(os.path.dirname(link), os.readlink(link)))
            pool = os.path.normpath(old_pool)
            if target.startswith(pool + os.sep):
                rel = os.path.relpath(target, pool)
                steps.append({"op": "relink", "src": os.path.join(new_pool, rel), "dst": link, "why": f"mount of {name}"})
    return steps


def _shipped_rules_step():
    dst = path("rules", "dispatch.md")
    if not os.path.isfile(SHIPPED_RULES):
        return None
    if os.path.isfile(dst) and filecmp.cmp(SHIPPED_RULES, dst, shallow=False):
        return None
    return {"op": "install", "src": SHIPPED_RULES, "dst": dst, "why": "Dispatch's own agent rules (ships with Dispatch, replaced on update)"}


# ---------------------------------------------------------------- apply

README = """# ~/.dispatch

Dispatch's own folder. Everything Dispatch keeps for you is here.

- skills/   the skill pool. Claude Code and Codex see a skill once it is mounted
            (`dispatch skills enable <name>`): a link in ~/.claude/skills or ~/.agents/skills.
- agents/   sub-agent definitions, one <name>.md each (name, description, model, effort, tools,
            engine). ~/.claude/agents links here, so Claude Code sees them as its sub-agents;
            `dispatch agent run <name> "..."` runs one on Codex.
- rules/    dispatch.md ships with Dispatch and is replaced on update. SOUL.md, how every agent talks
            and works, starts as Dispatch's default and is yours to change (Settings › Soul). GLOBAL.md,
            FACTS.md and PROFILE.md are yours. ~/.agents/rules links here.
- chats/    working folders of sessions started without a project folder.
- state/    runtime files (see state/README.md).
- backups/  copies Dispatch keeps before it changes one of your files, by day (<date>/<path from home>),
            kept 30 days. Nothing but real definitions goes in agents/: Claude Code reads it with its
            subfolders.
- config.json   settings of this folder (agents.default_effort).

Old folders that were moved in are kept next to where they were, named *.pre-dispatch.
"""

STATE_README = """# state

Dispatch's runtime files (session registry, activity, chatd, docs registry, IDE state) still live in
~/tasks/.dispatch (or $DISPATCH_DIR). They move here in a later release; nothing to do until then.
"""


def _copy(src, dst):
    """Copy a file, a folder (links inside kept as links) or a link. A relative link is rewritten to
    an absolute one, since its new home sits at a different place in the tree."""
    if os.path.islink(src):
        target = os.readlink(src)
        if not os.path.isabs(target):
            target = os.path.normpath(os.path.join(os.path.dirname(src), target))
        os.symlink(target, dst)
    elif os.path.isdir(src):
        shutil.copytree(src, dst, symlinks=True)
        for dp, dns, fns in os.walk(dst):
            for n in dns + fns:
                p = os.path.join(dp, n)
                if os.path.islink(p) and not os.path.isabs(os.readlink(p)):
                    orig = os.path.join(src, os.path.relpath(p, dst))
                    target = os.path.normpath(os.path.join(os.path.dirname(orig), os.readlink(p)))
                    _replace_link(p, target)
    else:
        shutil.copy2(src, dst)


def _replace_link(link, target):
    """Point `link` at `target` in one step (a new link renamed over the old one)."""
    tmp = f"{link}.dispatch-tmp-{os.getpid()}"
    os.symlink(target, tmp)
    os.replace(tmp, link)


def swap_in_link(old, target, backup):
    """Replace the folder `old` by a link to `target`, keeping the folder as `backup`, without a moment
    in which `old` is missing (Claude Code drops its sub-agent types when ~/.claude/agents is gone even
    briefly). macOS: renamex_np(RENAME_SWAP) swaps a ready link and the folder atomically; elsewhere
    two renames back to back."""
    tmp = f"{old}.dispatch-link-{os.getpid()}"
    os.symlink(target, tmp)
    if sys.platform == "darwin":
        import ctypes
        libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        RENAME_SWAP = 0x2
        if libc.renamex_np(os.fsencode(tmp), os.fsencode(old), RENAME_SWAP) == 0:
            os.rename(tmp, backup)  # tmp is the old folder now
            return
    os.rename(old, backup)
    os.rename(tmp, old)


def apply(steps, log=print):
    done = []
    steps = list(steps)
    i = 0
    while i < len(steps):
        s = steps[i]
        op = s["op"]
        i += 1
        if op == "skip":
            continue
        nxt = steps[i] if i < len(steps) else None
        if op == "backup" and nxt and nxt["op"] == "symlink" and nxt["dst"] == s["src"]:
            os.makedirs(nxt["src"], exist_ok=True)
            swap_in_link(s["src"], nxt["src"], s["dst"])
            done += [s, nxt]
            log(fmt_step(s))
            log(fmt_step(nxt))
            i += 1
            continue
        if op == "mkdir":
            os.makedirs(s["dst"], exist_ok=True)
        elif op == "copy":
            os.makedirs(os.path.dirname(s["dst"]), exist_ok=True)
            _copy(s["src"], s["dst"])
        elif op == "relink":
            _replace_link(s["dst"], s["src"])
        elif op == "backup":
            os.rename(s["src"], s["dst"])
        elif op == "symlink":
            os.makedirs(os.path.dirname(s["dst"]), exist_ok=True)
            os.makedirs(s["src"], exist_ok=True)
            os.symlink(s["src"], s["dst"])
        elif op == "install":
            os.makedirs(os.path.dirname(s["dst"]), exist_ok=True)
            shutil.copy2(s["src"], s["dst"])
        elif op == "write":
            os.makedirs(os.path.dirname(s["dst"]), exist_ok=True)
            with open(s["dst"], "w", encoding="utf-8") as f:
                f.write(STATE_README if s["dst"].endswith(os.path.join("state", "README.md")) else README)
        done.append(s)
        log(fmt_step(s))
    return done


def fmt_step(s):
    h = home()
    short = lambda p: (p or "").replace(h, "~", 1)
    arrow = {"copy": "→", "relink": "→", "backup": "→", "symlink": "←", "install": "→"}.get(s["op"], "")
    if s["op"] == "symlink":
        return f"{s['op']:<8} {short(s['dst'])} {arrow} {short(s['src'])}  ({s['why']})"
    if s.get("src") and s.get("dst"):
        return f"{s['op']:<8} {short(s['src'])} {arrow} {short(s['dst'])}  ({s['why']})"
    return f"{s['op']:<8} {short(s.get('dst') or s.get('src'))}  ({s['why']})"


# ---------------------------------------------------------------- init / status

def init(log=print):
    """Create the folders (and the shipped rules) without touching anything that exists elsewhere."""
    steps = [s for s in plan() if s["op"] in ("mkdir", "install", "write")]
    return apply(steps, log)


def status():
    rows = []
    for kind, old, new in legacy_places():
        state = "linked" if points_to(old, new) else ("folder" if os.path.isdir(old) and not os.path.islink(old) else ("missing" if not os.path.lexists(old) else "other"))
        rows.append({"kind": kind, "old": old, "new": new, "state": state, "backup": next((old + s for s in (BACKUP_SUFFIX,) if os.path.lexists(old + s)), "")})
    counts = {}
    for d in SUBDIRS:
        p = path(d)
        counts[d] = len([n for n in os.listdir(p) if not n.startswith(".")]) if os.path.isdir(p) else None
    pending = [s for s in plan() if s["op"] != "skip"]
    return {"root": root(), "exists": os.path.isdir(root()), "folders": counts, "places": rows,
            "rules": {"dispatch_md": os.path.isfile(path("rules", "dispatch.md"))}, "pending": len(pending)}


def dispatch_rules_text():
    """dispatch.md, whole: the installed copy (~/.dispatch/rules), else the one that ships with this CLI.
    `dispatch rules sync` puts it into every agent's rules file, next to the person's own GLOBAL.md."""
    for p in (path("rules", "dispatch.md"), SHIPPED_RULES):
        try:
            with open(p, encoding="utf-8") as f:
                text = f.read()
            if text.strip():
                return text.strip() + "\n"
        except OSError:
            continue
    return ""


def install_shipped_rules():
    """The installed copy of dispatch.md made current (it is replaced on update); its path, or "" when this CLI
    has none to give."""
    step = _shipped_rules_step()
    if step:
        apply([step], log=lambda *_: None)
    dst = path("rules", "dispatch.md")
    return dst if os.path.isfile(dst) else ""


# ---------------------------------------------------------------- config.json

def config_load():
    try:
        with open(path("config.json"), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def config_save(d):
    os.makedirs(root(), exist_ok=True)
    tmp = path("config.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path("config.json"))


# ---------------------------------------------------------------- command

def cmd(a):
    op = a.op or "status"
    as_json = getattr(a, "json", False)
    if op == "status":
        st = status()
        if as_json:
            print(json.dumps(st, ensure_ascii=False, indent=2))
            return
        h = home()
        print(f"{st['root'].replace(h, '~')}" + ("" if st["exists"] else "  (not created yet: dispatch dir init)"))
        for d, n in st["folders"].items():
            print(f"  {d + '/':<8} {'-' if n is None else n}")
        for r in st["places"]:
            print(f"  {r['old'].replace(h, '~'):<28} {r['state']}" + (f"  (backup {r['backup'].replace(h, '~')})" if r["backup"] else ""))
        print(f"  rules/dispatch.md {'yes' if st['rules']['dispatch_md'] else 'no'}")
        print(f"{st['pending']} step(s) left: dispatch dir migrate --dry-run" if st["pending"] else "nothing left to migrate")
        return
    if op == "init":
        done = init(log=(lambda s: None) if as_json else print)
        if as_json:
            print(json.dumps({"root": root(), "done": done}, ensure_ascii=False, indent=2))
        elif not done:
            print("~/.dispatch is already set up")
        return
    if op == "migrate":
        steps = [s for s in plan() if s["op"] != "skip" or getattr(a, "verbose", False)]
        if a.dry_run:
            if as_json:
                print(json.dumps({"root": root(), "steps": steps, "dry_run": True}, ensure_ascii=False, indent=2))
            else:
                for s in steps:
                    print(fmt_step(s))
                print(f"\n{len([s for s in steps if s['op'] != 'skip'])} step(s). Nothing is deleted: old folders are renamed *.pre-dispatch. Run without --dry-run to do it.")
            return
        done = apply(steps, log=(lambda s: None) if as_json else print)
        if as_json:
            print(json.dumps({"root": root(), "done": done}, ensure_ascii=False, indent=2))
        else:
            print(f"\n{len(done)} step(s) done." if done else "nothing to migrate")
        return
    raise SystemExit(f"unknown op {op}")


def add_parser(sub):
    s = sub.add_parser("dir", help="~/.dispatch, Dispatch's own folder (skills, agents, rules, chats, state): status | init | migrate [--dry-run]")
    s.add_argument("op", nargs="?", default="status", choices=["status", "init", "migrate"])
    s.add_argument("--dry-run", action="store_true", help="migrate: print the steps, change nothing")
    s.add_argument("--verbose", action="store_true", help="migrate: also list what is skipped")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd)
    return s
