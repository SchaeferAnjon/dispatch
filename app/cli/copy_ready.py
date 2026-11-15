# -*- coding: utf-8 -*-
"""`dispatch worktree`: a project's copy for parallel work gets ready on its own (task-am1t).

When an agent works in its own copy of a project (a git worktree, so it does not touch the person's files),
the copy has what git keeps and nothing else: no installed packages, no .env, none of the agent settings the
person keeps out of git. Orca asks people to write a setup script for that; Dispatch works it out itself and
nobody sees the steps:

  - copies the small files git ignores that a project needs to run or that hold the person's own agent settings:
    .env and .env.* (not the examples), .envrc, .dev.vars, CLAUDE.local.md, .claude/settings.local.json, an
    ignored .mcp.json, .codex/config.toml or opencode.json, and whatever the project's .worktreeinclude names
    (the same file Claude Code reads);
  - links the big folders of installed packages (node_modules, .venv, venv) to the main checkout's when the
    lockfile is the same, so the copy starts at once and takes no disk;
  - otherwise installs them in the background with the project's own package manager (pnpm, yarn, bun, npm,
    uv, poetry), when it is on this Mac.

  worktree prepare <copy> [--from <main checkout>] [--json]   do it (the agent host calls this after it makes a copy)
  worktree plan <folder> [--json]                             what it would do for this project, nothing changed
  worktree status <folder> [--json]                           the last copy made of this project and how it went

A project can turn this off in its Customize page (`dispatch project-custom copies <project> --auto off`).
Each run is recorded in the project's git data, <git common dir>/dispatch-copies/<id>.json (and the install's
output next to it, .log): the copy and the main checkout share that folder, so whoever asks finds it.
"""
import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

CONFIG_NAMES = re.compile(r"^(\.env(\..+)?|\.envrc|\.dev\.vars|CLAUDE\.local\.md|\.mcp\.json|opencode\.jsonc?|\.npmrc|\.tool-versions)$")
CONFIG_PATHS = (".claude/settings.local.json", ".codex/config.toml", ".vscode/settings.json")
EXAMPLE = re.compile(r"\.(example|sample|template|dist|defaults?)$", re.I)
FILE_MAX = 1024 * 1024
SHARED_DIRS = ("node_modules", ".venv", "venv")
# the lockfile that has to match for a folder of installed packages to be shared
LOCKS = {
    "node_modules": ("pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json"),
    ".venv": ("uv.lock", "poetry.lock", "Pipfile.lock", "requirements.txt"),
    "venv": ("uv.lock", "poetry.lock", "Pipfile.lock", "requirements.txt"),
}
SKIP = {"node_modules", ".git", ".venv", "venv", "dist", "build", "out", "target", ".next", "__pycache__", "Pods", "vendor"}


def _git(cwd, *args, timeout=30):
    try:
        r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout if r.returncode == 0 else None


def main_checkout(folder):
    """The project's main checkout (the folder its git data lives in), for a copy or for the main one itself."""
    common = (_git(folder, "rev-parse", "--path-format=absolute", "--git-common-dir") or "").strip()
    if not common:
        return ""
    root = os.path.dirname(common) if os.path.basename(common) == ".git" else ""
    return os.path.realpath(root) if root else ""


def state_dir(folder):
    """Where the copies of a project are recorded: inside its git data (<git common dir>/dispatch-copies), which the
    copy and the main checkout share. Every process finds it from the folder alone, whatever its environment (the
    agent host that makes the copy and the window that shows it need not agree on DISPATCH_HOME)."""
    common = (_git(folder, "rev-parse", "--path-format=absolute", "--git-common-dir") or "").strip()
    if common:
        return os.path.join(common, "dispatch-copies")
    import dispatch_dir
    return dispatch_dir.path("state", "copies")


def _id(folder):
    return hashlib.sha1(os.path.realpath(folder).encode("utf-8")).hexdigest()[:16]


def ignored(main):
    """Files and folders git ignores in the main checkout (folders end in /), not looking inside big folders."""
    out = _git(main, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", timeout=60) or ""
    return [line for line in out.splitlines() if line and not any(part in SKIP for part in line.rstrip("/").split("/")[:-1])]


def include_patterns(main):
    """.worktreeinclude: gitignore-like patterns of ignored files to copy into a copy (Claude Code's convention)."""
    try:
        with open(os.path.join(main, ".worktreeinclude"), encoding="utf-8") as f:
            return [l.strip() for l in f if l.strip() and not l.lstrip().startswith("#")]
    except OSError:
        return []


def _matches(rel, patterns):
    for p in patterns:
        p = p.lstrip("/")
        if p.endswith("/") and (rel + "/").startswith(p):
            return True
        if fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(os.path.basename(rel), p):
            return True
    return False


def config_files(main, entries=None):
    """The ignored small files a copy needs (relative paths)."""
    entries = ignored(main) if entries is None else entries
    patterns = include_patterns(main)
    out = []
    for rel in entries:
        if rel.endswith("/"):
            # a folder git ignores whole: only what .worktreeinclude or a known path names inside it
            folder = rel.rstrip("/")
            if folder in SHARED_DIRS or folder.split("/")[-1] in SKIP:
                continue
            for root, dirs, files in os.walk(os.path.join(main, folder)):
                dirs[:] = [d for d in dirs if d not in SKIP]
                for f in files:
                    r = os.path.relpath(os.path.join(root, f), main)
                    if r in CONFIG_PATHS or _matches(r, patterns):
                        out.append(r)
                if root.count(os.sep) - main.count(os.sep) > 3:
                    dirs[:] = []
            continue
        name = os.path.basename(rel)
        wanted = rel in CONFIG_PATHS or (CONFIG_NAMES.match(name) and not EXAMPLE.search(name) and rel.count("/") <= 2) or _matches(rel, patterns)
        if wanted:
            out.append(rel)
    keep = []
    for rel in sorted(set(out)):
        p = os.path.join(main, rel)
        try:
            if os.path.isfile(p) and not os.path.islink(p) and os.path.getsize(p) <= FILE_MAX:
                keep.append(rel)
        except OSError:
            pass
    return keep


def _same(a, b):
    try:
        with open(a, "rb") as fa, open(b, "rb") as fb:
            return fa.read() == fb.read()
    except OSError:
        return False


def _lock_of(folder, kind):
    return next((n for n in LOCKS[kind] if os.path.isfile(os.path.join(folder, n))), "")


def installer(folder):
    """The install command for this folder's packages ([argv], label), or None."""
    def has(tool):
        return shutil.which(tool, path=_path())
    if os.path.isfile(os.path.join(folder, "package.json")):
        if os.path.isfile(os.path.join(folder, "pnpm-lock.yaml")) and has("pnpm"):
            return ["pnpm", "install", "--frozen-lockfile"], "pnpm install"
        if os.path.isfile(os.path.join(folder, "yarn.lock")) and has("yarn"):
            return ["yarn", "install"], "yarn install"
        if (os.path.isfile(os.path.join(folder, "bun.lock")) or os.path.isfile(os.path.join(folder, "bun.lockb"))) and has("bun"):
            return ["bun", "install"], "bun install"
        if has("npm"):
            return (["npm", "ci"], "npm ci") if os.path.isfile(os.path.join(folder, "package-lock.json")) else (["npm", "install"], "npm install")
    if os.path.isfile(os.path.join(folder, "uv.lock")) and has("uv"):
        return ["uv", "sync"], "uv sync"
    if os.path.isfile(os.path.join(folder, "poetry.lock")) and has("poetry"):
        return ["poetry", "install"], "poetry install"
    return None


def _path():
    parts = (os.environ.get("PATH") or "/usr/bin:/bin").split(os.pathsep)
    home = os.path.expanduser("~")
    for d in (os.path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", os.path.join(home, ".bun", "bin")):
        if d not in parts:
            parts.append(d)
    return os.pathsep.join(parts)


def plan(main, copy=None):
    """What a copy of `main` gets: {"copy": [rel], "link": [rel], "install": label or "", "why": {...}}.
    With `copy`, the lockfiles are compared with that copy's; without, a copy is taken to match main."""
    entries = ignored(main)
    files = config_files(main, entries)
    links, install, why = [], "", {}
    ignored_dirs = {e.rstrip("/") for e in entries if e.endswith("/")}
    for d in SHARED_DIRS:
        if d not in ignored_dirs or not os.path.isdir(os.path.join(main, d)):
            continue
        lock = _lock_of(main, d)
        if copy is not None and lock and not _same(os.path.join(main, lock), os.path.join(copy, lock)):
            why[d] = f"{lock} differs from the main checkout's"
            continue
        links.append(d)
    target = copy if copy is not None else main
    inst = installer(target)
    if inst:
        needs = "node_modules" if inst[1].split()[0] in ("pnpm", "yarn", "bun", "npm") else ".venv"
        if needs not in links:
            install = inst[1]
    return {"copy": files, "link": links, "install": install, "why": why}


def _exclude_links(copy, links):
    """A link git does not ignore (a `node_modules/` pattern only matches folders) goes into the shared
    info/exclude, so nobody commits it by accident."""
    common = (_git(copy, "rev-parse", "--path-format=absolute", "--git-common-dir") or "").strip()
    if not common:
        return
    missing = []
    for rel in links:
        r = subprocess.run(["git", "-C", copy, "check-ignore", "-q", rel], capture_output=True)
        if r.returncode != 0:
            missing.append("/" + rel)
    if not missing:
        return
    path = os.path.join(common, "info", "exclude")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        with open(path, encoding="utf-8") as f:
            have = f.read()
    except OSError:
        have = ""
    add = [m for m in missing if m not in have.splitlines()]
    if add:
        with open(path, "a", encoding="utf-8") as f:
            f.write(("" if not have or have.endswith("\n") else "\n") + "# Dispatch: folders a copy shares with the main checkout\n" + "\n".join(add) + "\n")


def record(copy, data):
    folder = state_dir(copy)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, _id(copy) + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)
    return path


def auto_on(main):
    """The project's switch (project-custom copies --auto); on unless someone turned it off."""
    try:
        import project_custom
        import projects_view
        projects_view.D = project_custom._dispatch()
        rows = projects_view.registry()
        real = os.path.realpath(main)
        row = next((r for r in rows if r.get("dir") and os.path.realpath(r["dir"]) == real), None)
        if not row:
            return True
        return (project_custom.load().get(row["name"]) or {}).get("copies", {}).get("auto") is not False
    except Exception:  # noqa: BLE001  the board being down must not stop a copy from getting ready
        return True


def prepare(copy, main="", background=True, check_switch=True):
    copy = os.path.realpath(copy)
    if not os.path.isdir(copy):
        raise ValueError("That copy is not there.")
    main = os.path.realpath(main) if main else main_checkout(copy)
    if not main or main == copy:
        return {"ok": True, "copy": copy, "skipped": "not a copy of another checkout"}
    if check_switch and not auto_on(main):
        return {"ok": True, "copy": copy, "main": main, "skipped": "turned off for this project"}
    p = plan(main, copy)
    copied, linked = [], []
    for rel in p["copy"]:
        dst = os.path.join(copy, rel)
        if os.path.lexists(dst):
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        try:
            shutil.copy2(os.path.join(main, rel), dst)
            copied.append(rel)
        except OSError:
            pass
    for rel in p["link"]:
        dst = os.path.join(copy, rel)
        if os.path.lexists(dst):
            continue
        try:
            os.symlink(os.path.join(main, rel), dst)
            linked.append(rel)
        except OSError:
            pass
    if linked:
        _exclude_links(copy, linked)
    rec = {"copy": copy, "main": main, "at": int(time.time()), "copied": copied, "linked": linked,
           "install": {"label": p["install"], "state": "running" if p["install"] else "none"}, "why": p["why"]}
    log = os.path.join(state_dir(copy), _id(copy) + ".log")
    path = record(copy, rec)
    if p["install"]:
        rec["install"]["log"] = log
        record(copy, rec)
        if background:
            argv = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), "worktree", "install", copy]
            with open(log, "w", encoding="utf-8") as out:
                subprocess.Popen(argv, cwd=copy, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                 start_new_session=True, env=dict(os.environ, PATH=_path()))
        else:
            install(copy)
            rec = status_of(copy) or rec
    return {"ok": True, **rec, "record": path}


def install(copy):
    """Runs the install the plan named (the background half of prepare) and records how it went."""
    copy = os.path.realpath(copy)
    rec = status_of(copy) or {"copy": copy, "install": {}}
    inst = installer(copy)
    if not inst:
        rec["install"] = {"label": "", "state": "none"}
        record(copy, rec)
        return rec
    started = time.time()
    state = "done" if run_install(inst[0], copy) == 0 else "failed"
    rec["install"] = {**(rec.get("install") or {}), "label": inst[1], "state": state, "seconds": int(time.time() - started)}
    record(copy, rec)
    return rec


def run_install(argv, cwd):
    """The install itself: its exit code (-1 when it could not start or took over 20 minutes)."""
    try:
        return subprocess.run(argv, cwd=cwd, env=dict(os.environ, PATH=_path(), CI="1"), timeout=20 * 60, stdin=subprocess.DEVNULL).returncode
    except (OSError, subprocess.TimeoutExpired):
        return -1


def status_of(copy):
    try:
        with open(os.path.join(state_dir(copy), _id(copy) + ".json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def last_for(main):
    """The most recent copy prepared from this main checkout."""
    real = os.path.realpath(main)
    best = None
    try:
        folder = state_dir(main)
        names = os.listdir(folder)
    except OSError:
        return None
    for n in names:
        if not n.endswith(".json"):
            continue
        try:
            with open(os.path.join(folder, n), encoding="utf-8") as f:
                rec = json.load(f)
        except (OSError, ValueError):
            continue
        if rec.get("main") == real and (best is None or rec.get("at", 0) > best.get("at", 0)):
            best = rec
    if best and best.get("install", {}).get("state") == "running" and time.time() - best.get("at", 0) > 30 * 60:
        best["install"]["state"] = "failed"
    if best:
        best["exists"] = os.path.isdir(best.get("copy") or "")
    return best


def command(a):
    op = a.op
    if op in ("busy", "mark", "land"):
        import own_copy
        return own_copy.command(a)
    try:
        if op == "prepare":
            res = prepare(a.folder, a.from_ or "", background=not a.wait)
        elif op == "install":
            res = {"ok": True, **install(a.folder)}
        elif op == "plan":
            main = main_checkout(a.folder) or os.path.realpath(a.folder)
            res = {"ok": True, "main": main, **plan(main)}
        elif op == "status":
            main = main_checkout(a.folder) or os.path.realpath(a.folder)
            res = {"ok": True, "main": main, "last": last_for(main) if main == os.path.realpath(a.folder) else status_of(a.folder)}
        else:
            raise ValueError(f"Unknown op {op}")
    except ValueError as e:
        print(json.dumps({"ok": False, "message": str(e)}) if a.json else str(e))
        return 1
    if a.json:
        print(json.dumps(res, ensure_ascii=False))
    elif op == "plan":
        print("Copies:", ", ".join(res["copy"]) or "nothing")
        print("Shares:", ", ".join(res["link"]) or "nothing")
        print("Installs:", res["install"] or "nothing")
    else:
        print(json.dumps(res, ensure_ascii=False, indent=1))
    return 0


def add_parser(sub):
    s = sub.add_parser("worktree", help="a project's copy for parallel work gets ready on its own: prepare <copy> [--from <main>] copies .env and the person's ignored agent settings, links node_modules / .venv when the lockfile matches, installs the rest in the background; plan <folder> says what it would do; status <folder> how the last copy went; busy <folder> which agents work in a folder now; mark <copy> --into <branch> and land <copy>: a copy that goes back into the project folder by itself (own_copy.py)")
    s.add_argument("op", choices=["prepare", "install", "plan", "status", "busy", "mark", "land"])
    s.add_argument("folder")
    s.add_argument("--from", dest="from_", default="", help="prepare: the main checkout (default: the copy's own repository)")
    s.add_argument("--wait", action="store_true", help="prepare: install in the foreground")
    s.add_argument("--not-under", dest="not_under", type=int, default=0, help="busy: leave out the processes under this one (the agent host)")
    s.add_argument("--into", default="", help="mark: the branch of the project folder the copy goes back into")
    s.add_argument("--message", default="", help="land: the commit message for what the agent left uncommitted")
    s.add_argument("--force", action="store_true", help="land: also a copy that is not marked")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=lambda a: sys.exit(command(a)))
