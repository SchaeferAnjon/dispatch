"""Projects in the Dispatch IDE Agents window (design/task-model/DECISIONS.md「项目」).

- `dispatch projects --json` lists the registered projects (the shared `dispatch-projects` memory)
  with where each one lives: `registry()` adds the folder, the Mac, a display label and whether the
  folder is a git repository. The Agents window's sidebar groups its sessions by these.
- `dispatch projects-view --json` is the Projects page of this machine (one machine, one window:
  design/machines/redesign/README.md): its registered projects plus the folders agents worked in
  here that are not registered (the All filter, "Add as project"), each with its open tasks,
  sessions, documents, last activity, state (running / waiting / quiet), a one-line "now" (and
  `now_session`, the session that line is about), and the last 14 days as `events`: every session
  (its start and last activity, its title or else its first prompt) and every commit on the main
  branch (author time, hash, subject); the page's Timeline buckets them by hour / half day / day.
  `recent` is its three most recent projects (the Devices menu). `--host <id>` asks another Mac for
  its own page.
  While the transcript index is being built (a new Mac reads every session once: `dispatch index --status`) the answer
  carries `indexing: {state: "running", done, total}` and what has been read so far; the first `projects-view` on a
  Mac with no index starts that build in the background.
- `dispatch projects-view --project <name> --json` adds what the project page shows: the running
  sessions, the tasks, the latest documents and the sessions of the last 14 days.
- `dispatch projects-view add <dir> [--name N]` registers a folder (git init when it is not a
  repository); `new <dir>` creates it first. `new <name> [--parent DIR]` makes <parent>/<name> (default
  ~/Projects) with history and an empty first commit; `clone <web address> [--parent DIR] [--name N]
  [--progress-file F]` copies a project from the internet; `defaults` says where new projects go and
  whether git works (project_create.py). `open <session id>` opens another Mac's session over
  ssh in Terminal (the project lives there, so its sessions run there).

Everything is read from what Dispatch already keeps (transcript index, bd, live sessions, the
Waiting for you scan, the docs scan, git log); nothing here calls a model.
"""
import datetime
import json
import os
import re
import shlex
import subprocess
import sys
import time

D = None  # dispatch, set by command()

DAYS = 14
TEMP_PREFIXES = ("/private/tmp/", "/tmp/", "/private/var/folders/", "/var/folders/")
SESSIONS_LISTED = 40
DOCS_LISTED = 40
TASKS_LISTED = 100


def _dispatch():
    global D
    if D is None:
        here = os.path.dirname(os.path.abspath(__file__))
        if here not in sys.path:
            sys.path.insert(0, here)
        import dispatch as mod  # noqa: E402
        D = mod
    return D


# ---- machines --------------------------------------------------------------------------------

def machine_label(host):
    """What a row says about its Mac: "this Mac", or the name hosts.json gives the other one (one Mac,
    one name: no guessing from aliases)."""
    if not host:
        return "this Mac"
    return host.get("name") or host.get("id") or ""


def find_host(hosts, key):
    """The hosts.json entry an id, name or alias (any case), ssh target or address stands for."""
    import host_admin
    return host_admin.match(hosts, key)


def peer_homes(hosts):
    """/Users/<user> of every peer in hosts.json -> that host."""
    out = {}
    for h in hosts:
        ssh = h.get("ssh") or ""
        if "@" in ssh:
            out["/Users/" + ssh.split("@")[0]] = h
    return out


def peer_of_dir(path, homes, local_home):
    """The peer whose home holds `path`, or None (this Mac, or nobody's home)."""
    p = (path or "").rstrip("/")
    if not p or p == local_home or p.startswith(local_home.rstrip("/") + "/"):
        return None
    for home, h in homes.items():
        if p == home or p.startswith(home + "/"):
            return h
    return None


def is_temp(path):
    """A throw-away folder (/tmp, the system's temp folders, an agent's scratchpad): not a project. Except in a Dispatch IDE
    test instance, which keeps everything under its own folder in /tmp (DISPATCH_SESSION_ROOT): there its folders are
    what a person's folders are elsewhere."""
    p = (path or "") + "/"
    if not (any(p.startswith(t) for t in TEMP_PREFIXES) or "/scratchpad/" in p):
        return False
    scope = os.environ.get("DISPATCH_SESSION_ROOT") or ""
    if scope:
        from activity import in_session_root
        if in_session_root(path, scope):
            return False
    return True


def under(path, home):
    home = (home or "").rstrip("/")
    return bool(path and home) and (path == home or path.startswith(home + "/"))


def is_automation(e, in_app=None):
    """A session nobody typed in: a cron run (Hermes), one marked scheduled, or a headless `claude -p` /
    `codex exec` run (checks, summaries, scripts). Dispatch's own chat runs `claude -p` too; its
    conversations (`in_app`, chat_protocol.read_started) are a person's."""
    if e.get("subagent"):
        return True
    if e.get("interactive") or f"{e.get('agent')}:{e.get('session_id')}" in (in_app or {}):
        return False
    ep = e.get("entrypoint") or ""
    if ep == "cron" or e.get("scheduled"):
        return True
    return ep in ("sdk-cli", "exec", "subagent")


def interactive_sessions(index):
    """chatd history plus native IDE sessions, including their backing SDK ids."""
    import chat_protocol
    import ide_sessions
    registered = dict(chat_protocol.read_started(D.DISPATCH_DIR))
    for e in ide_sessions.sidebar_entries(index, registered).values():
        if e.get("interactive"):
            registered[f"{e.get('agent')}:{e.get('session_id')}"] = True
    return registered


def not_a_project(folder, home, roots):
    """Folders agents worked in that are not projects: temporary ones, hidden ones (~/.codex/…),
    the home folder's own Desktop / Documents / Downloads, and the workspace roots themselves."""
    if is_temp(folder):
        return True
    rel = folder[len(home):] if folder.startswith(home + "/") else ""
    if any(part.startswith(".") for part in rel.split("/") if part):
        return True
    if folder in (home, *(os.path.join(home, x) for x in ("Desktop", "Documents", "Downloads", "Library"))):
        return True
    return any(os.path.normpath(os.path.expanduser(r)) == folder for r in roots)


# ---- git -------------------------------------------------------------------------------------

def git_main_root(path):
    """The repository folder for `path`: the folder holding .git walking up; a linked worktree
    (.git is a file) counts as its main repository. '' when there is none."""
    from ownership import repo_of
    return repo_of(path)[0] if path else ""


def worktree_dirs(root):
    """Where this repository's worktrees are (Agents window: <repo>.worktrees/, Claude Code:
    <repo>/.claude/worktrees/, the -wt convention: <repo>-wt/)."""
    root = (root or "").rstrip("/")
    return [root + ".worktrees", os.path.join(root, ".claude", "worktrees"), root + "-wt"] if root else []


def git_branch(root):
    try:
        head = open(os.path.join(root, ".git", "HEAD"), encoding="utf-8").read().strip()
    except Exception:
        return ""
    return head.split("refs/heads/", 1)[1] if head.startswith("ref:") and "refs/heads/" in head else head[:8]


def main_branch(root):
    for b in ("main", "master"):
        if os.path.exists(os.path.join(root, ".git", "refs", "heads", b)):
            return b
    try:
        packed = open(os.path.join(root, ".git", "packed-refs"), encoding="utf-8").read()
        for b in ("main", "master"):
            if f"refs/heads/{b}\n" in packed:
                return b
    except Exception:
        pass
    return git_branch(root)


def main_commits(root, since, limit=400):
    """Commits on the main branch (first parent) since `since`: [{"at", "hash", "subject"}], `at`
    the author time (when the work was done, not when it was rebased or merged)."""
    if not root or not os.path.isdir(os.path.join(root, ".git")):
        return []
    branch = main_branch(root)
    if not branch:
        return []
    try:
        r = subprocess.run(["git", "-C", root, "log", branch, "--first-parent", f"--since={int(since)}",
                            f"-n{limit}", "--format=%at%x09%h%x09%s"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=8)
    except Exception:
        return []
    out = []
    for line in (r.stdout or "").splitlines():
        parts = line.split("\t", 2)
        if len(parts) == 3 and parts[0].isdigit():
            if int(parts[0]) >= since:
                out.append({"at": int(parts[0]), "hash": parts[1], "subject": parts[2][:160]})
    return out


# ---- the registry (`dispatch projects --json`) ---------------------------------------------

def _memories():
    code, o, _ = D.sh(["bd", "memories", "--json"])
    if code != 0:
        return {}
    try:
        return json.loads(o[o.find("{"):])
    except ValueError:
        return {}


def owner_peer(owner, hosts):
    """The hosts.json entry an owner record names: by the name, id or an alias (a Mac renamed later, or
    recorded under the name it gives itself), else by its Tailscale IP; None when it is none of them."""
    name, ip = (owner or {}).get("host") or "", (owner or {}).get("ip") or ""
    low = name.casefold()
    for h in hosts:
        if name and any(isinstance(n, str) and n.casefold() == low for n in [h.get("id"), h.get("name")] + list(h.get("aliases") or [])):
            return h
    if ip:
        return next((h for h in hosts if ip in (h.get("ip"), (h.get("ssh") or "").split("@")[-1])), None)
    return None


def place(f, owner, hosts, homes):
    """(peer or None, placed) for a registered project. A folder under another Mac's home, or an owner
    record naming another Mac, puts it there; a folder under this Mac's home, or an owner record naming
    this Mac, puts it here. Anything else is placed nowhere (placed False): every Mac counts it as its own,
    since none of them can tell (a label-only project, a folder outside any home)."""
    d = (f or {}).get("dir") or ""
    peer = peer_of_dir(d, homes, D.HOME) if d else None
    placed = bool(peer) or under(d, D.HOME)
    if not peer and owner:
        if D.project_owner_is_here(owner):
            placed = True
        else:
            peer = owner_peer(owner, hosts)
            placed = placed or bool(peer)
    return peer, placed


def registry(memories=None, index=None, resolve_dirs=True):
    """The registered projects with where they live:
    [{name, label, starred, archived, dir, host ("local" | host id), host_name, machine, git, placed, look?, missing_dir?}].
    `dir` is '' when no folder is known; a project on another Mac keeps that Mac's path. `missing_dir` is the folder a
    project here was registered with when that folder is not on this Mac any more. resolve_dirs
    False skips guessing the folder of a project whose registration names none (Waiting for you only
    needs where projects are)."""
    _dispatch()
    mem = _memories() if memories is None else memories
    flags = D.project_flags_parse(mem.get(D.PROJECT_FLAGS_KEY, ""))
    owners = D.project_owners_parse(mem.get(D.PROJECT_OWNERS_KEY, ""))
    hosts = D.hosts()
    homes = peer_homes(hosts)
    names = None
    roots = None
    rows = []
    import project_custom
    custom = project_custom.parse(mem.get(project_custom.CUSTOM_KEY, ""))
    for name, f in sorted(flags.items(), key=lambda kv: kv[0].lower()):
        d = registered = f.get("dir") or ""
        peer, placed = place(f, owners.get(name), hosts, homes)
        if peer and not d:
            d = "/Users/" + peer["ssh"].split("@")[0] + "/Projects/" + name if "@" in (peer.get("ssh") or "") else ""
        if resolve_dirs and not peer and not (d and os.path.isdir(d)):
            if names is None:
                names = D.project_names()
                roots = D.settings_load().get("workspace_roots") or []
                index = D.load_index() if index is None else index
            d = D.project_home(name, names, index, roots) or ""
        root = git_main_root(d) if d and not peer else ""
        rows.append({
            "name": name,
            "label": f.get("alias") or name,
            "starred": bool(f.get("starred")),
            "archived": bool(f.get("archived")),
            "dir": root or d,
            "host": peer["id"] if peer else "local",
            "host_name": peer["name"] if peer else D.local_host_name(),
            "machine": machine_label(peer),
            "git": bool(root) if not peer else True,
            "placed": placed,
        })
        # the folder it was registered with, gone from this Mac (deleted, moved, or another Mac's path): Settings says
        # so instead of a blank line
        if not peer and registered and not rows[-1]["dir"]:
            rows[-1]["missing_dir"] = registered
        # the icon and colour set in the project's Customize page; none is the plain folder
        look = project_custom.look_public((custom.get(name) or {}).get("look"))
        if look:
            rows[-1]["look"] = look
    return rows


def sidebar_registry(index=None, reg=None, in_app=None, catalogs=None):
    """The sidebar's policy comes from the CLI; the native tree only renders these decisions.

    Test folders never become sidebar projects on the real board. An isolated IDE instance
    can still show its own explicitly registered demo inside DISPATCH_SESSION_ROOT.
    """
    _dispatch()
    import ide_sessions
    import chat_protocol
    from activity import in_session_root
    index = D.load_index() if index is None else index
    reg = registry(index=index) if reg is None else reg
    in_app = chat_protocol.read_started(D.DISPATCH_DIR) if in_app is None else in_app
    scope = os.environ.get("DISPATCH_SESSION_ROOT") or ""
    def test_folder(cwd):
        return is_temp(cwd) and not (scope and in_session_root(cwd, scope))
    projects = [dict(r, worktree_group={"id": "worktrees", "label": "Worktrees", "collapsed": True})
                for r in reg if not test_folder(r.get("dir") or "")]
    by_name = {r["name"].lower(): r["name"] for r in projects}
    by_dir = sorted(((r["dir"].rstrip("/"), r["name"]) for r in projects if r["dir"] and r["host"] == "local"),
                    key=lambda x: -len(x[0]))
    homes = peer_homes(D.hosts())
    roots = D.settings_load().get("workspace_roots") or []
    cache, policies = {}, {}
    for key, e in ide_sessions.sidebar_entries(index, in_app, catalogs).items():
        cwd = (e.get("cwd") or "").rstrip("/")
        if cwd not in cache:
            cache[cwd] = _session_project(cwd, by_dir, by_name, {}, roots, homes) if cwd else ("", "", False)
        project, _, worktree = cache[cwd]
        one_shot = is_automation(e, in_app)
        policies[key] = {"project": project, "worktree": bool(worktree), "one_shot": one_shot,
                         "hidden": one_shot or test_folder(cwd) or bool(scope and not in_session_root(cwd, scope))}
    return {"projects": projects, "sessions": policies}


def placements(rows=None):
    """Where the registry puts the projects it places (place()): {"names": {lowercase name or label: host},
    "dirs": [(home-relative folder, host)]}, host "local" (this machine) or a hosts.json id. Waiting for
    you leaves out what another machine's projects wait on, and names what every machine shows."""
    _dispatch()
    rows = registry(resolve_dirs=False) if rows is None else rows
    by_id = {h.get("id"): h for h in D.hosts()}
    names, dirs = {}, []
    for r in rows:
        if not r.get("placed"):
            continue
        for k in (r.get("name"), r.get("label")):
            if k:
                names.setdefault(k.lower(), r["host"])
        if r.get("dir"):
            peer = by_id.get(r["host"]) if r["host"] != "local" else None
            dirs.append((D.home_relative(r["dir"].rstrip("/"), peer), r["host"]))
    return {"names": names, "dirs": dirs}


def recent(limit=3, index=None, reg=None, live=None):
    """This machine's projects by the last time a person worked in them, newest first:
    [{name, label, dir, last_at, last_title}]. Sessions in temporary folders or the home folder,
    sessions that ran on another Mac (copied transcripts), sub-agents and automation (is_automation)
    do not count; archived projects and other machines' projects are left out. `live`: this machine's
    live sessions, fresher than the index."""
    _dispatch()
    index = D.load_index() if index is None else index
    reg = registry(index=index) if reg is None else reg
    homes = peer_homes(D.hosts())
    names = D.project_names()
    roots = D.settings_load().get("workspace_roots") or []
    reg_by_name = {r["name"].lower(): r["name"] for r in reg}
    reg_by_dir = sorted(((r["dir"].rstrip("/"), r["name"]) for r in reg if r["dir"]), key=lambda x: -len(x[0]))
    mine = {r["name"]: r for r in reg if r["host"] == "local" and not r.get("archived")}
    try:
        in_app = interactive_sessions(index)
    except Exception:
        in_app = {}
    best, cache, auto = {}, {}, set()

    def note(cwd, at, title):
        if not cwd or is_temp(cwd) or cwd == D.HOME or peer_of_dir(cwd, homes, D.HOME):
            return
        if cwd not in cache:
            cache[cwd] = _session_project(cwd, reg_by_dir, reg_by_name, names, roots, homes)
        name, folder, _wt = cache[cwd]
        if name:
            row = mine.get(name)
            if not row:
                return
            key = name
        elif folder and os.path.isdir(folder) and not not_a_project(folder, D.HOME, roots) and os.path.basename(folder).lower() not in reg_by_name:
            key, row = folder, {"name": os.path.basename(folder), "label": os.path.basename(folder), "dir": folder}
        else:
            return
        b = best.setdefault(key, {"row": row, "at": 0.0, "title": "", "title_at": -1.0})
        b["at"] = max(b["at"], at)
        if title and at >= b["title_at"]:
            b["title"], b["title_at"] = title, at

    for e in index.values():
        if e.get("subagent"):
            continue
        if is_automation(e, in_app):
            if e.get("session_id"):
                auto.add(e["session_id"])
            continue
        note((e.get("cwd") or "").rstrip("/"), float(e.get("mtime") or 0), e.get("title") or "")
    for s in live or []:
        if not s.get("alive") or (s.get("host") or "local") != "local" or {s.get("session_id"), s.get("probable_session_id")} & auto:
            continue
        note((s.get("cwd") or "").rstrip("/"), float(s.get("last_at") or 0), s.get("title") or "")
    top = sorted(best.values(), key=lambda b: -b["at"])[:limit]
    return [{"name": b["row"]["name"], "label": b["row"].get("label") or b["row"]["name"], "dir": b["row"].get("dir") or "",
             "last_at": b["at"], "last_title": b["title"]} for b in top if b["at"] > 0]


# ---- the page (`dispatch projects-view --json`) --------------------------------------------

def _epoch(ts):
    """An ISO time from the transcript index ("2026-09-27T21:37:42.356Z") as epoch seconds, or None."""
    try:
        return datetime.datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() if ts else None
    except ValueError:
        return None


def _first_line(text, limit=120):
    for line in (text or "").splitlines():
        line = line.strip()
        if line:
            return line[:limit]
    return ""


_REAL = {}


def _real(path):
    """os.path.realpath, remembered: the sidebar asks it for every project and every session folder."""
    if path not in _REAL:
        _REAL[path] = os.path.realpath(path).rstrip("/") if path else path
    return _REAL[path]


def _session_project(cwd, reg_by_dir, reg_by_name, names, roots, homes):
    """(registered project name or '', folder key for an unregistered one, is_worktree)."""
    peer = peer_of_dir(cwd, homes, D.HOME)
    if peer:
        rel = D.home_relative(cwd, peer)
        name = ""
        for r in roots:
            r = r.rstrip("/")
            if rel.startswith(r + "/"):
                name = re.sub(r"(-wt|\.worktrees)$", "", rel[len(r) + 1:].split("/")[0])
        wt = "/.claude/worktrees/" in cwd or ".worktrees/" in cwd or "-wt/" in cwd
        if name.lower() in reg_by_name:
            return reg_by_name[name.lower()], "", wt
        return "", "", wt
    root = git_main_root(cwd) if os.path.isdir(cwd) else ""
    from ownership import repo_of
    main, checkout = repo_of(cwd) if root else ("", "")
    wt = bool(main and main != checkout) or "/.claude/worktrees/" in cwd or ".worktrees/" in cwd
    # a folder reached through a symlink (/tmp is /private/tmp on macOS) is the same folder: engines
    # record the real path, the registry keeps the one the person gave
    cwds = dict.fromkeys([cwd, _real(cwd)])
    for d, name in reg_by_dir:
        for dd in dict.fromkeys([d, _real(d)]):
            if any(c == dd or c.startswith(dd + "/") for c in cwds) or (root and root in (d, dd)):
                return name, "", wt
            for w in worktree_dirs(dd):
                if any(c.startswith(w + "/") for c in cwds):
                    return name, "", True
    guess = D.project_of_cwd(cwd, names, roots) if os.path.isdir(cwd) else ""
    if guess and guess.lower() in reg_by_name:
        name = reg_by_name[guess.lower()]
        # A name-only legacy registration can still be inferred. A project with
        # a known folder cannot absorb a different folder just sharing its name.
        if not any(n == name for _, n in reg_by_dir):
            return name, "", wt
    return "", root or cwd, wt


def _now_line(p):
    if p["state"] == "waiting" and p.get("waiting_phrase"):
        return "Waiting for you: " + p["waiting_phrase"]
    if p["state"] == "running":
        working = [s for s in p.get("running", []) if s.get("state") == "working"]
        titles = [s["title"] for s in working if s.get("title")]
        n = len(working)
        if titles:
            return (f"{n} sessions running: " if n > 1 else "Running: ") + titles[0]
        return f"{n} session{'s' if n > 1 else ''} running."
    if p.get("last_at"):
        when = datetime.date.fromtimestamp(p["last_at"])
        last = p.get("last_title") or ""
        quiet = f"Quiet since {when.strftime('%b')} {when.day}."
        if (datetime.date.today() - when).days <= 1:
            return ("Last: " + last) if last else "Active today."
        return quiet + (f" Last: {last}" if last else "")
    return ""  # nothing to say: the row has no second line


def index_building():
    """The transcript index build under way, {state, done, total}: the page says how far it is instead of "No projects here.".
    On a Mac that has no index yet it is started in the background from here (nothing waits for it); None when there
    is no build to wait for, or when asking failed (the page is drawn as it was)."""
    ensure = getattr(D, "index_ensure", None)
    if ensure is None:
        return None
    try:
        cur = ensure()
    except Exception as e:
        D.debug("projects_view.index_building", e)
        return None
    return {k: cur.get(k) for k in ("state", "done", "total")} if cur else None


def collect(project=None, days=DAYS, now=None):
    """This machine's Projects page, or one of its projects' page when `project` is given. Projects the
    registry puts on another Mac, and sessions that ran on another Mac (transcripts copied here by a
    move), are that Mac's: its own `projects-view` lists them."""
    _dispatch()
    now = now or time.time()
    today = datetime.date.fromtimestamp(now)
    since = time.mktime((today - datetime.timedelta(days=days - 1)).timetuple())
    building = index_building()
    mem = _memories()
    index = D.load_index()
    reg = registry(mem, index)
    hosts = D.hosts()
    homes = peer_homes(hosts)
    names = D.project_names()
    roots = D.settings_load().get("workspace_roots") or []
    reg_by_name = {r["name"].lower(): r["name"] for r in reg}
    reg_by_dir = sorted(((r["dir"].rstrip("/"), r["name"]) for r in reg if r["dir"]), key=lambda x: -len(x[0]))

    projects = {r["name"]: dict(r, registered=True, sessions=[], all_sessions=0, last_at=0.0) for r in reg if r["host"] == "local"}
    loose = {}  # folder -> row, for folders nobody registered (the All filter)

    cache = {}
    titles = {e.get("session_id"): e.get("title") for e in index.values() if e.get("title")}
    in_app = interactive_sessions(index)
    automation = {e["session_id"] for e in index.values() if e.get("session_id") and is_automation(e, in_app)}
    for path, e in index.items():
        if e.get("session_id") in automation:
            continue
        cwd = (e.get("cwd") or "").rstrip("/")
        if not cwd or is_temp(cwd) or cwd == D.HOME or peer_of_dir(cwd, homes, D.HOME):
            continue
        if cwd not in cache:
            cache[cwd] = _session_project(cwd, reg_by_dir, reg_by_name, names, roots, homes)
        name, folder, wt = cache[cwd]
        mtime = float(e.get("mtime") or 0)
        if name:
            p = projects.get(name)
            if p is None:
                continue  # a folder of another Mac's project (an old copy here)
        elif folder and os.path.isdir(folder) and not not_a_project(folder, D.HOME, roots):
            p = loose.get(folder)
            if p is None:
                base = os.path.basename(folder)
                p = loose[folder] = {"name": base, "label": base, "starred": False, "archived": False, "dir": folder,
                                     "host": "local", "host_name": D.local_host_name(), "machine": "this Mac",
                                     "git": os.path.isdir(os.path.join(folder, ".git")), "registered": False,
                                     "sessions": [], "all_sessions": 0, "last_at": 0.0}
        else:
            continue
        p["all_sessions"] += 1
        if mtime > p["last_at"]:
            p["last_at"] = mtime
        if e.get("title") and mtime > p.get("last_title_at", 0):
            p["last_title"], p["last_title_at"], p["last_title_id"] = e["title"], mtime, e.get("session_id") or ""
        if mtime >= since:
            p["sessions"].append({"id": e.get("session_id") or "", "agent": e.get("agent") or "", "title": e.get("title") or "",
                                  "at": mtime, "first": e.get("first_ts") or "", "start": _epoch(e.get("first_ts")),
                                  "prompt": _first_line(e.get("first_prompt")), "cwd": cwd, "worktree": wt,
                                  "branch": e.get("branch") or "", "host": "local", "host_name": machine_label(None)})

    # a folder nobody registered is called what Add as project would call it: two of one name are told apart
    # by the folder above (demo · gx-hover-demo), and one that shares its name with a registered project too
    name_loose(loose, reg)
    rows = list(projects.values()) + list(loose.values())

    # live sessions on this machine: running / waiting
    try:
        live = D.live_sessions(local_only=True)
    except Exception:
        live = []
    for s in live:
        if (not s.get("alive") or (s.get("host") or "local") != "local"
                or {s.get("session_id"), s.get("probable_session_id")} & automation or is_automation(s, in_app)):
            continue
        cwd = (s.get("cwd") or "").rstrip("/")
        if not cwd or is_temp(cwd):
            continue
        if cwd not in cache:
            cache[cwd] = _session_project(cwd, reg_by_dir, reg_by_name, names, roots, homes)
        name, folder, wt = cache[cwd]
        p = projects.get(name) if name else loose.get(folder)
        if not p:
            continue
        p.setdefault("running", []).append({"id": s.get("session_id") or "", "agent": s.get("agent") or "",
                                            "title": s.get("title") or titles.get(s.get("session_id") or "", ""), "state": s.get("state") or "",
                                            "attention": s.get("attention"), "at": s.get("last_at") or 0,
                                            "cwd": cwd, "worktree": wt, "host": "local", "host_name": machine_label(None),
                                            "source": s.get("source_app") or s.get("source_kind") or ""})
        p["last_at"] = max(p["last_at"], float(s.get("last_at") or 0))

    # waiting for you, by project name
    waiting = {}
    try:
        w = D._mod("waiting")
        w.D = D
        for it in w.collect(now).get("items", []):
            if it.get("kind") in ("approve", "decide") and it.get("project"):
                waiting.setdefault(it["project"].lower(), it)
    except Exception:
        pass

    # open tasks per project label
    tasks_by = {}
    code, o, _ = D.sh(["bd", "list", "--json", "--limit", "0"], timeout=30)
    try:
        issues = json.loads(o[o.find("["):]) if code == 0 else []
    except ValueError:
        issues = []
    for it in issues:
        if it.get("status") in ("closed", "tombstone"):
            continue
        for l in it.get("labels") or []:
            if l.startswith("project:"):
                tasks_by.setdefault(l.split(":", 1)[1].lower(), []).append(it)

    summaries = {}
    for k, v in mem.items():
        if k.startswith(D.INTERNAL_MEMORY_PREFIX + "project-summary-"):
            try:
                summaries[k.split("project-summary-", 1)[1].lower()] = json.loads(v)
            except (ValueError, TypeError):
                pass

    want = (project or "").strip().lower()
    out = []
    for p in rows:
        key = p["name"].lower()
        if want and key != want and p["dir"].rstrip("/").lower() != want:
            continue
        running = p.get("running", [])
        p["running"] = running
        wit = waiting.get(key)
        if wit:
            p["state"] = "waiting"
            p["waiting_phrase"] = wit.get("phrase") or ""
            p["waiting_session"] = str(wit.get("session") or "").split(":", 1)[-1]
        elif any(s.get("state") == "working" for s in running):
            p["state"] = "running"
        else:
            p["state"] = "quiet"
        tasks = tasks_by.get(key, [])
        p["tasks_open"] = len(tasks)
        local_dir = p["dir"] if p["host"] == "local" and p["dir"] and os.path.isdir(p["dir"]) else ""
        docs = []
        if local_dir or p["registered"]:
            try:
                reg_docs = D.docs_registered_rows(D.docs_entries_parse(mem.get(D.docs_key(p["name"]), "")))
                docs = D.docs_merge(D.docs_scan([local_dir]) if local_dir else [], reg_docs)
            except Exception:
                docs = []
        p["docs"] = len(docs)
        sessions = sorted(p.pop("sessions"), key=lambda s: -s["at"])
        p["sessions_14d"] = len(sessions)
        p["branch"] = git_branch(local_dir) if local_dir and p["git"] else ""
        commits = main_commits(local_dir, since) if local_dir and p["git"] else []
        p["events"] = events(sessions, commits, running)
        summary = summaries.get(key) or {}
        p["summary"] = summary.get("summary") or ""
        p["now"] = _now_line(p)
        p["now_session"] = _now_session(p)
        if want:
            p["session_list"] = sessions[:SESSIONS_LISTED]
            p["tasks"] = [{"id": t.get("id"), "title": t.get("title") or "", "status": t.get("status") or "",
                           "priority": t.get("priority"), "updated_at": t.get("updated_at") or "",
                           "labels": t.get("labels") or []} for t in sorted(tasks, key=lambda t: t.get("updated_at") or "", reverse=True)[:TASKS_LISTED]]
            p["doc_list"] = [{k: d.get(k) for k in ("id", "title", "kind", "path", "mtime", "ext")} for d in docs[:DOCS_LISTED]]
        for k in ("last_title_at", "last_title_id", "waiting_session"):
            p.pop(k, None)
        out.append(p)
    out.sort(key=lambda p: (not p["registered"], p["archived"], -(p["last_at"] or 0)))
    try:
        latest = recent(index=index, reg=reg, live=live)
    except Exception as e:  # the Devices menu's three rows never cost the page
        D.debug("projects_view.recent", e)
        latest = []
    res = {"now": now, "days": days, "today": today.isoformat(), "local_host_name": D.local_host_name(),
           "host": "local", "host_name": D.local_host_name(), "projects": out, "recent": latest}
    if building:
        res["indexing"] = building  # what has been read so far is in `projects`; the page adds a progress line
    return res


def name_loose(loose, reg):
    """Give each unregistered folder's row (`loose`: folder -> row) the name Add as project would register it
    under. Folders that share a name (with each other, or with a registered project's name or label) all get the
    folders above them added, as few as tell them apart."""
    taken = {}
    for r in reg:
        for k in (r.get("name"), r.get("label")):
            if k:
                taken.setdefault(k.casefold(), r.get("dir") or "")
    groups = {}
    for folder in sorted(loose):
        groups.setdefault(os.path.basename(folder).casefold(), []).append(folder)
    for key, folders in groups.items():
        base = os.path.basename(folders[0])
        if len(folders) == 1 and key not in taken:
            continue
        chosen = None
        for depth in (1, 2, 3):
            names = [base + NAME_SEP + folder_suffix(f, depth) if folder_suffix(f, depth) else base for f in folders]
            if len({n.casefold() for n in names}) == len(names) and not any(n.casefold() in taken for n in names):
                chosen = names
                break
        if chosen is None:
            chosen = [f"{base} ({i})" if i else base for i in range(len(folders))]
        for folder, n in zip(folders, chosen):
            loose[folder]["name"] = loose[folder]["label"] = n


def events(sessions, commits, running=()):
    """What the Timeline draws for one project over the page's days: every session (above the line)
    and every commit on main (below it), each with its time; the page buckets them.
    sessions: [{id, at (last activity), start (first message, or None), title (its title, else the
    first line of its first prompt), named (it has a title of its own), agent, host}], oldest first;
    a running session the transcript index does not know yet comes in at its last activity.
    commits: [{at (author time), hash, subject}], oldest first."""
    seen = set()
    out = []
    for s in sessions:
        seen.add(s["id"])
        out.append({"id": s["id"], "at": s["at"], "start": s.get("start"), "title": s.get("title") or s.get("prompt") or "",
                    "named": bool(s.get("title")), "agent": s.get("agent") or "", "host": s.get("host") or "local"})
    for s in running:
        if s.get("id") and s["id"] not in seen and s.get("at"):
            seen.add(s["id"])
            out.append({"id": s["id"], "at": float(s["at"]), "start": None, "title": s.get("title") or "",
                        "named": bool(s.get("title")), "agent": s.get("agent") or "", "host": s.get("host") or "local"})
    out.sort(key=lambda e: e["at"])
    return {"sessions": out, "commits": sorted(({"at": c["at"], "hash": c["hash"], "subject": c["subject"]} for c in commits),
                                              key=lambda c: c["at"])}


def _now_session(p):
    """The session the row's one line is about (the page lights its mark while the line is pointed at):
    the one waiting, the running one the line names, or the last one with a title."""
    if p["state"] == "waiting":
        return p.get("waiting_session") or ""
    if p["state"] == "running":
        working = [s for s in p.get("running", []) if s.get("state") == "working"]
        named = [s for s in working if s.get("title")]
        return ((named or working or [{}])[0]).get("id") or ""
    return (p.get("last_title_id") or "") if p.get("last_title") else ""


# ---- actions ---------------------------------------------------------------------------------

class RegisterError(ValueError):
    """A registration that did not happen, in words for the person. `retry` says that asking again may work
    (the task board could not be made just now); the Agents window then offers Try Again."""

    def __init__(self, message, retry=False):
        super().__init__(message)
        self.retry = retry


def ensure_board():
    """The task board the registry lives on, made now when there is none: what the first Add as project on a
    new Mac needs, so nothing has to be set up before it. It is init_wizard.ensure_board (the same call the
    first-run setup makes): an existing board is left alone, a new one is this Mac's own embedded board.
    Returns {"dir", "created", "embedded"}; raises RegisterError(retry=True) when the board cannot be made."""
    _dispatch()
    try:
        import init_wizard
        return init_wizard.ensure_board()
    except (Exception, SystemExit) as e:
        why = " ".join(str(e).split())[-240:] if not isinstance(e, SystemExit) else ""
        raise RegisterError("Could not set up the task board" + (f": {why}" if why else "") + ". Try again.", retry=True)


NAME_SEP = " · "


def same_folder(a, b):
    """Two paths naming one folder (the file system decides: a symlink or another spelling of the same path counts)."""
    a, b = (a or "").rstrip("/"), (b or "").rstrip("/")
    if not a or not b:
        return False
    if a == b:
        return True
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def name_of_folder(flags, folder):
    """The registered project (its name in the shared registry) whose folder this is, or ''. A project is a
    folder: the name is only what it is called."""
    return next((n for n, f in sorted(flags.items()) if same_folder((f or {}).get("dir"), folder)), "")


def held_by_other(flags, name, folder):
    """True when `name` (any case) already belongs to a project that is not `folder`. A project registered by
    name alone, with no folder, has the folder Dispatch works out for it (its sessions' folder, ~/Projects/<name>):
    it is another folder's only when that exists and is not this one."""
    key = name.casefold()
    for n, f in flags.items():
        if key not in (n.casefold(), ((f or {}).get("alias") or "").casefold()):
            continue
        d = (f or {}).get("dir") or ""
        if not d:
            try:
                d = D.project_home(n) or ""
            except Exception:
                d = ""
        if d and not same_folder(d, folder):
            return True
    return False


def folder_suffix(folder, depth):
    """The parent folders that tell two folders of one name apart: depth 1 is the folder above, 2 the two above."""
    parents = [x for x in os.path.dirname(folder.rstrip("/")).split("/") if x]
    return "/".join(parents[-depth:]) if parents else ""


def free_name(preferred, folder, flags):
    """The name `folder` is registered under: `preferred` when no other folder has it, else the name with the
    folder above it (demo · gx-hover-demo), then two folders up, then a number. Two folders of one name are two
    projects, and neither takes the other's place."""
    base = preferred.strip()
    if not held_by_other(flags, base, folder):
        return base
    for depth in (1, 2, 3):
        suffix = folder_suffix(folder, depth)
        if suffix and not held_by_other(flags, base + NAME_SEP + suffix, folder):
            return base + NAME_SEP + suffix
    n = 2
    while held_by_other(flags, f"{base} ({n})", folder):
        n += 1
    return f"{base} ({n})"


def register(folder, name="", create=False):
    """Register `folder` as a project (git init when it is not a repository). Returns the row.
    The folder is what identifies the project: adding one that is already registered gives back its project
    (under the name it has), and a name another folder already has is kept apart with the folder above
    (demo · gx-hover-demo) instead of taking that project's place. `name` is what the caller would like it
    called; "renamed" says it was not."""
    _dispatch()
    folder = os.path.normpath(os.path.expanduser(folder or ""))
    if not os.path.isabs(folder):
        raise ValueError("Give the full path of the folder.")
    if not os.path.isdir(folder) and not create:
        raise ValueError(f"No such folder: {folder}")
    wanted = (name or os.path.basename(folder)).strip()
    if not wanted or len(wanted) > 120 or any(ord(c) < 32 for c in wanted):
        raise ValueError("That is not a usable project name.")
    board = ensure_board()  # before anything is made: a board that cannot be made leaves the folder alone
    os.makedirs(folder, exist_ok=True)
    if not os.path.exists(os.path.join(folder, ".git")):
        D.sh(["git", "-C", folder, "init", "-q"], timeout=20)
    flags = D.project_flags_load(strict=True)
    name = name_of_folder(flags, folder) or free_name(wanted, folder, flags)
    cur = dict(flags.get(name, {}))
    cur["dir"] = folder
    if not cur.get("archived"):
        cur["starred"] = True
    flags = {k: v for k, v in flags.items() if k != name}
    flags[name] = cur
    D.wiki_store(D.PROJECT_FLAGS_KEY, json.dumps(flags, ensure_ascii=False, sort_keys=True))
    D.project_dirs(reload=True)
    return {"ok": True, "name": name, "label": cur.get("alias") or name, "dir": folder,
            "git": os.path.exists(os.path.join(folder, ".git")), "board_created": bool(board.get("created")),
            "renamed": name.casefold() != wanted.casefold()}


def make_project(op, a):
    """`new <name>`, `clone <address>` and `defaults` (project_create.py): the dialog's three ways besides
    Choose a folder. The other Macs' own dialogs add projects there; from here that is not supported yet."""
    _dispatch()
    import project_create as PC
    on = (getattr(a, "on", "") or "").strip()
    if on and on != "local" and on.casefold() != D.local_host_name().casefold():
        h = find_host(D.hosts(), on)
        raise ValueError(f"Adding a project on {h['name'] if h else on} from here is not supported yet. Open Dispatch on that Mac and add it there.")
    if op == "defaults":
        return PC.defaults()
    if op == "new":
        return PC.new_project(a.arg or a.name, getattr(a, "parent", "") or "", lambda folder, name: register(folder, name), ensure_board)
    return PC.clone_project(a.arg, getattr(a, "parent", "") or "", getattr(a, "name", "") or "", lambda folder, name: register(folder, name), ensure_board,
                            progress_file=getattr(a, "progress_file", "") or None)


def rename(name, label):
    """What the window calls a project (the project keeps its name: tasks, sessions and the Macs' registry are
    keyed by it). An empty label, or the name itself, goes back to the name. Two projects are never called the
    same, so a label another project already has (as its name or its label) is refused."""
    _dispatch()
    name = (name or "").strip()
    label = " ".join((label or "").split())
    if len(label) > 80 or any(ord(c) < 32 for c in label):
        raise ValueError("That is not a usable project name.")
    flags = D.project_flags_load(strict=True)
    key = next((n for n in flags if n.casefold() == name.casefold()), None)
    if key is None:
        raise ValueError(f"No project called {name}.")
    if label.casefold() == key.casefold():
        label = ""
    if label:
        for n, f in flags.items():
            if n != key and label.casefold() in (n.casefold(), ((f or {}).get("alias") or "").casefold()):
                raise ValueError(f"There is already a project called {label}.")
    cur = {k: v for k, v in flags[key].items() if k != "alias"}
    if label:
        cur["alias"] = label
    flags = dict(flags, **{key: cur})
    D.wiki_store(D.PROJECT_FLAGS_KEY, json.dumps(flags, ensure_ascii=False, sort_keys=True))
    D.project_dirs(reload=True)
    return {"ok": True, "name": key, "label": label or key}


def theirs(res, h):
    """Another Mac's own page as it answered `projects-view --json --local`: only the projects it lists as
    its own (an older dispatch there lists every Mac's), tagged with that Mac, and its three recent
    projects (worked out from the rows when that dispatch is too old to send them)."""
    rows = [p for p in (res or {}).get("projects") or [] if isinstance(p, dict) and (p.get("host") or "local") == "local"]
    for p in rows:
        p.update(host=h["id"], host_name=h["name"], machine=machine_label(h))
    latest = (res or {}).get("recent")
    if not isinstance(latest, list):
        latest = [{"name": p["name"], "label": p.get("label") or p["name"], "dir": p.get("dir") or "", "last_at": p.get("last_at") or 0,
                   "last_title": p.get("last_title") or ""}
                  for p in sorted(rows, key=lambda p: -(p.get("last_at") or 0)) if p.get("last_at") and not p.get("archived")][:3]
    return dict(res or {}, projects=rows, recent=latest, host=h["id"], host_name=h["name"])


def open_remote(session_id, host_id):
    """Open another Mac's session in Terminal over ssh (`dispatch resume` knows the command)."""
    _dispatch()
    h = find_host(D.hosts(), host_id)
    if not h:
        raise ValueError(f"Unknown Mac: {host_id}")
    code, o, err = D.sh([sys.executable, os.path.realpath(D.__file__), "resume", session_id, "--on", h["id"]], timeout=40)
    cmd = (o or "").strip().splitlines()[-1] if code == 0 and (o or "").strip() else ""
    if not cmd:
        raise ValueError((err or "").strip() or f"Could not find {session_id} on {h['name']}.")
    # `resume` prints the other Mac's folder JSON-escaped (\u81ea…): the shell there needs the characters
    cmd = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), cmd)
    if "ssh " not in cmd:
        cmd = f"ssh -t {shlex.quote(h['ssh'])} {shlex.quote(cmd)}"
    if os.environ.get("DISPATCH_OPEN_DRY_RUN"):
        return {"ok": True, "command": cmd, "dry_run": True}
    script = f'tell application "Terminal" to do script {json.dumps(cmd, ensure_ascii=False)}\ntell application "Terminal" to activate'
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=20)
    if r.returncode != 0:
        raise ValueError((r.stderr or "").strip() or "Terminal did not open.")
    return {"ok": True, "command": cmd}


def command(a, dispatch_module=None):
    global D
    if dispatch_module is not None:
        D = dispatch_module
    _dispatch()
    op = getattr(a, "op", "") or "list"
    try:
        if op == "list":
            key = getattr(a, "host", "") or ""
            if key and key != "local" and key.casefold() != D.local_host_name().casefold():
                h = find_host(D.hosts(), key)
                if not h:
                    raise ValueError(f"Unknown Mac: {key}")
                res = D.remote_dispatch(h, ["projects-view", "--json", "--local"], 120, timeout=20, background=True)
                if not isinstance(res, dict):
                    raise ValueError(f"{h['name']} did not answer (or runs an older dispatch without projects-view).")
                res = theirs(res, h)
            else:
                # this machine's page; --local (what another Mac sends over ssh) asks for the same
                res = collect(project=getattr(a, "project", "") or None, days=getattr(a, "days", DAYS) or DAYS)
        elif op == "add":
            res = register(a.arg, getattr(a, "name", "") or "")
        elif op == "new" and os.path.isabs(a.arg or ""):
            res = register(a.arg, getattr(a, "name", "") or "", create=True)
        elif op in ("new", "clone", "defaults"):
            res = make_project(op, a)
        elif op == "rename" and getattr(a, "key", False):
            R = D._mod("project_rename")
            R.D = D
            res = R.rename_key(a.arg, getattr(a, "name", "") or "", dry_run=getattr(a, "dry_run", False))
        elif op == "rename":
            res = rename(a.arg, getattr(a, "name", "") or "")
        elif op == "open":
            res = open_remote(a.arg, getattr(a, "on", "") or "")
        else:
            raise ValueError(f"Unknown op {op}")
    except subprocess.TimeoutExpired:
        # the task board (bd) did not answer in time: a busy Mac, not something the person did wrong
        res = {"ok": False, "retry": True, "code": "busy",
               "message": "Dispatch's task board did not answer in time. The Mac may be busy right now. Try again in a moment."}
        print(json.dumps(res, ensure_ascii=False) if a.json else res["message"])
        return 1
    except ValueError as e:
        res = {"ok": False, "message": str(e)}
        if getattr(e, "retry", False):
            res["retry"] = True
        if getattr(e, "code", ""):
            res["code"] = e.code
        print(json.dumps(res, ensure_ascii=False) if a.json else str(e))
        return 1
    if a.json:
        print(json.dumps(res, ensure_ascii=False))
    elif op == "list":
        for p in res.get("projects", []):
            print(f"{p['label']:<20} {p['machine']:<9} {p['tasks_open']:>3} tasks {p['sessions_14d']:>4} sessions {p['docs']:>4} docs  {p['now']}")
    else:
        print(json.dumps(res, ensure_ascii=False))
    return 0
