# -*- coding: utf-8 -*-
"""What Dispatch knows about the user, the same on every Mac: `dispatch knowledge status|sync|commit`.

The knowledge lives where it always did, in ~/.dispatch (dispatch_dir.root(); DISPATCH_HOME for tests
and test instances):

  preferences.jsonl, preferences/evidence/   the user's preferences and what they were said about
  wiki/<key>.md                              pits, wins, retros, howtos (one entry a file)
  rules/GLOBAL.md FACTS.md PROFILE.md artifact.md
  skills/                                    the skill pool
  agents/                                    sub-agent definitions

Tasks, sessions and progress are not here and are not copied: every Mac keeps its own board and reads
the other one over the machine connection.

How it stays the same on two Macs, without the user ever seeing git:
  - A git repository whose git dir is ~/.dispatch/.knowledge.git and whose work tree is ~/.dispatch. It
    is not called `.git`, so no tool that looks for a repository finds it: a session started without a
    project folder runs in ~/.dispatch/chats/<name>, and must not see this history as its own.
  - What is tracked is a whitelist, written by this file into the git dir's info/exclude (not a
    .gitignore in ~/.dispatch, so the folder stays free of git files). state/, chats/, backups/, ssh/,
    machine-id, dispatch.md (ships with Dispatch), locks and caches stay out.
  - Links and nested repositories in the skill pool (task-board is a link into the Dispatch checkout)
    mean nothing on another Mac: they are kept out of git and listed in skills/.dispatch-links.json;
    the other Mac makes the same link when the target exists there, and clones a nested repository
    that has a network remote.
  - Every Dispatch command that writes one of these files schedules a commit (`dispatch knowledge
    commit --settle 5`, detached): writes within a few seconds of each other become one commit whose
    message says which commands and which Mac. The resident chatd also commits what was written by
    hand before each sync.
  - Every 5 minutes the resident chatd fetches the other Macs' repositories over the SSH connection
    Dispatch already has (hosts.json). Only fetch, never push, so nobody writes into a repository
    another Mac is using. The fetched branch is merged here: Markdown and JSON Lines merge by union
    (both sides' lines kept); preferences.jsonl merges entry by entry (usage counters add up). When
    both Macs changed the same lines, or a file that cannot be merged line by line, both versions are
    kept (the other one as `<file>.conflict-<mac>`) and a notification goes out (wake.py's channel).
  - A Mac that is offline is skipped; the last good sync with each one is kept for `dispatch doctor`.
  - Two repositories that never shared history (the first contact) are merged once by union.
"""
import json, os, re, shlex, subprocess, sys, tempfile, time, types
import urllib.parse

import dispatch_dir

GIT_DIR_NAME = ".knowledge.git"
BRANCH = "main"
SYNC_EVERY = 300            # the resident chatd's rhythm
SETTLE = 5                  # seconds of quiet before a scheduled commit is made
STALE_AFTER = 24 * 3600     # doctor warns when a Mac has not synced for this long
FETCH_TIMEOUT = 120
LINKS_FILE = ".dispatch-links.json"
CONFLICT_MARK = ".conflict-"
CONFLICTS_LOG = "dispatch-merge-conflicts.jsonl"   # in the git dir; the merge driver appends, sync reads
PREFS = "preferences.jsonl"
SHARED_RULES = ("GLOBAL.md", "FACTS.md", "PROFILE.md", "artifact.md")
LINK_DIRS = ("skills", "agents")

# Commands whose run may have written knowledge: {command: ops that only read}. None = every op reads.
WRITERS = {
    "prefs": {"list", "show", "stale", "thumbs", "prime"},
    "wiki": {"list", "search", "show", "related"},
    "pit": {"list", "show"},
    "facts": {"show", "path", "open", "sections", "docs", "vaults", "topics", "get", "search", "list"},
    "profile": {"show", "path", "inventory"},
    "rules": {"show", "path", "open", "status", "sync", "targets", "inspect", "optimize", "check"},
    "skills": {"list", "show", "path", "open", "find", "roots"},
    "agents": {"list", "show"},
    "done": set(),     # --retro writes a wiki entry
    "aside": set(),    # --save writes a wiki entry
}

EXCLUDE_HEAD = """# Written by Dispatch (knowledge_sync.py): only what the user knows travels between Macs.
/*
!/preferences.jsonl
!/preferences/
/preferences/*
!/preferences/evidence/
!/rules/
/rules/*
!/rules/GLOBAL.md
!/rules/FACTS.md
!/rules/PROFILE.md
!/rules/artifact.md
!/skills/
!/agents/
!/wiki/
.DS_Store
__pycache__/
*.pyc
node_modules/
*.tmp
*.lock
.lock
*.bak
*.bak-*
*.conflict-*
"""
ATTRIBUTES = "*.md merge=dispatch\n*.jsonl merge=dispatch\n"


# ---------------------------------------------------------------- paths and git

def root():
    return dispatch_dir.root()


def git_dir():
    return os.path.join(root(), GIT_DIR_NAME)


def state_dir():
    """Dispatch's runtime folder (~/tasks/.dispatch, DISPATCH_DIR): sync state, pending commits."""
    return os.environ.get("DISPATCH_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".dispatch")


def state_path():
    return os.path.join(state_dir(), "knowledge-sync.json")


def pending_path():
    return os.path.join(state_dir(), "knowledge-pending.json")


def host_name():
    try:
        import dispatch as D
        return D.local_host_name()
    except Exception:
        import socket
        return socket.gethostname()


def _email():
    slug = re.sub(r"[^A-Za-z0-9.-]+", "-", host_name()).strip("-") or "mac"
    return f"dispatch@{slug}.local"


def _env():
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0", LC_ALL="C", GIT_SSH_COMMAND=SSH_COMMAND)
    return env


SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=8" + ("" if os.name == "nt" else " -o ControlMaster=auto -o ControlPath=/tmp/dispatch-ssh-%C -o ControlPersist=180")


def git(*args, timeout=60, input=None, check=False):
    cmd = ["git", "--git-dir", git_dir(), "--work-tree", root(), "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
           "-c", "core.quotepath=false", "-c", "core.autocrlf=false", "-c", "user.name=Dispatch", "-c", f"user.email={_email()}",
           "-c", "merge.renames=false", "-c", "core.fsmonitor=false", *args]
    r = subprocess.run(cmd, cwd=root(), capture_output=True, text=True, errors="replace", timeout=timeout, input=input, env=_env())
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args[:2])}: {(r.stderr or r.stdout).strip()[-300:]}")
    return r


def has_repo():
    return os.path.isfile(os.path.join(git_dir(), "HEAD"))


def head():
    r = git("rev-parse", "--verify", "-q", "HEAD")
    return r.stdout.strip() if r.returncode == 0 else ""


class Locked:
    """One writer of the repository at a time (a scheduled commit and chatd's sync may meet)."""

    def __init__(self, wait=120):
        self.wait, self.fh = wait, None

    def __enter__(self):
        os.makedirs(git_dir(), exist_ok=True)
        try:
            import fcntl
        except ImportError:
            return self
        self.fh = open(os.path.join(git_dir(), "dispatch-sync.lock"), "a")
        deadline = time.time() + self.wait
        while True:
            try:
                fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except OSError:
                if time.time() > deadline:
                    raise RuntimeError("the knowledge repository is busy")
                time.sleep(0.2)

    def __exit__(self, *exc):
        if self.fh:
            self.fh.close()


def driver_command():
    here = os.path.abspath(__file__)
    return f"{shlex.quote(sys.executable)} {shlex.quote(here)} merge-driver %O %A %B %P {shlex.quote(git_dir())}"


def write_setup():
    """The whitelist, the merge rules and the driver, rewritten from this code every time so an update
    of Dispatch updates them too."""
    info = os.path.join(git_dir(), "info")
    os.makedirs(info, exist_ok=True)
    ex = EXCLUDE_HEAD + "".join(f"/{p}\n" for p in local_only_paths())
    for name, text in (("exclude", ex), ("attributes", ATTRIBUTES)):
        p = os.path.join(info, name)
        try:
            with open(p, encoding="utf-8") as f:
                if f.read() == text:
                    continue
        except OSError:
            pass
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
    want = {"merge.dispatch.name": "Dispatch knowledge merge", "merge.dispatch.driver": driver_command(), "core.bare": "false",
            "core.worktree": root(), "gc.auto": "256", "core.precomposeunicode": "true"}
    have = git("config", "--local", "--list").stdout
    cur = dict(l.split("=", 1) for l in have.splitlines() if "=" in l)
    for k, v in want.items():
        if cur.get(k) != v:
            git("config", "--local", k, v)


def ensure_repo():
    """Make ~/.dispatch a knowledge repository if it is not one yet (first commit included). Returns
    True when it was just created."""
    made = False
    if not has_repo():
        os.makedirs(root(), exist_ok=True)
        r = subprocess.run(["git", "--git-dir", git_dir(), "init", "-q"], capture_output=True, text=True, env=_env(), timeout=30)
        if r.returncode != 0:
            raise RuntimeError(f"git init: {(r.stderr or r.stdout).strip()[-200:]}")
        git("symbolic-ref", "HEAD", f"refs/heads/{BRANCH}")
        made = True
    write_setup()
    if not head():
        write_links_manifest()
        git("add", "-A")
        git("commit", "-q", "--allow-empty", "-m", f"start on {host_name()}")
    return made


# ---------------------------------------------------------------- links and nested repositories

def _home_rel(p):
    h = os.path.expanduser("~")
    return "~" + p[len(h):] if p == h or p.startswith(h + os.sep) else p


def _scan_links():
    """[(relative path, entry)] for every link that points outside the pool and every nested git
    repository under skills/ and agents/. entry: {"link": target} or {"repo": url}."""
    out = []
    base = root()
    for top in LINK_DIRS:
        start = os.path.join(base, top)
        if not os.path.isdir(start):
            continue
        real = os.path.realpath(start)
        for dirpath, dirnames, filenames in os.walk(start):
            keep = []
            for n in sorted(dirnames):
                p = os.path.join(dirpath, n)
                rel = os.path.relpath(p, base)
                if os.path.islink(p):
                    t = os.path.realpath(p)
                    if not t.startswith(real + os.sep):
                        out.append((rel, {"link": _home_rel(os.path.abspath(os.path.join(dirpath, os.readlink(p))))}))
                    continue
                if n in ("node_modules", "__pycache__"):
                    continue
                if os.path.exists(os.path.join(p, ".git")):
                    url = subprocess.run(["git", "-C", p, "config", "--get", "remote.origin.url"], capture_output=True, text=True,
                                         env=_env(), timeout=10).stdout.strip()
                    out.append((rel, {"repo": url}))
                    continue
                keep.append(n)
            dirnames[:] = keep
            for n in filenames:
                p = os.path.join(dirpath, n)
                if os.path.islink(p):
                    t = os.path.realpath(p)
                    if not t.startswith(real + os.sep):
                        out.append((os.path.relpath(p, base), {"link": _home_rel(os.path.abspath(os.path.join(dirpath, os.readlink(p))))}))
    return out


def local_only_paths():
    return [rel for rel, _ in _scan_links()]


def write_links_manifest():
    """skills/.dispatch-links.json (and agents/): what the other Mac should link or clone itself."""
    found = {}
    for rel, entry in _scan_links():
        top, _, rest = rel.partition(os.sep)
        found.setdefault(top, {})[rest.replace(os.sep, "/")] = entry
    for top in LINK_DIRS:
        d = os.path.join(root(), top)
        p = os.path.join(d, LINKS_FILE)
        want = found.get(top) or {}
        old = _read_json(p, None)
        # Entries this Mac cannot see (links another Mac listed whose target is not here) stay listed.
        if isinstance(old, dict):
            for k, v in old.items():
                if k not in want and not os.path.lexists(os.path.join(d, k)):
                    want[k] = v
        if not want and old is None:
            continue
        text = json.dumps(want, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        try:
            with open(p, encoding="utf-8") as f:
                if f.read() == text:
                    continue
        except OSError:
            pass
        os.makedirs(d, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)


def apply_links_manifest(clone=True):
    """Make the links (and clones) another Mac listed, where the target exists here. Returns what was made."""
    made = []
    for top in LINK_DIRS:
        d = os.path.join(root(), top)
        m = _read_json(os.path.join(d, LINKS_FILE), {})
        if not isinstance(m, dict):
            continue
        for rel, entry in sorted(m.items()):
            if not isinstance(entry, dict) or ".." in rel.split("/"):
                continue
            p = os.path.join(d, *rel.split("/"))
            if os.path.lexists(p):
                continue
            if entry.get("link"):
                target = os.path.expanduser(entry["link"])
                if os.path.exists(target):
                    os.makedirs(os.path.dirname(p), exist_ok=True)
                    os.symlink(target, p)
                    made.append(f"{top}/{rel}")
            elif clone and re.match(r"^(https://|ssh://|git@)", entry.get("repo") or ""):
                r = subprocess.run(["git", "clone", "-q", entry["repo"], p], capture_output=True, text=True, env=_env(), timeout=FETCH_TIMEOUT)
                if r.returncode == 0:
                    made.append(f"{top}/{rel}")
    return made


def _read_json(p, default):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write_json(p, obj):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = f"{p}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


# ---------------------------------------------------------------- commits

def commit_now(why="dispatch", lock=True):
    """Commit whatever changed in the whitelist. Returns the new commit, or "" when nothing changed."""
    def run():
        ensure_repo()
        write_links_manifest()
        write_setup()
        git("add", "-A", check=True)
        if git("diff", "--cached", "--quiet").returncode == 0:
            return ""
        whys = [w for w in dict.fromkeys(x.strip() for x in why.split("\n")) if w]
        subject = "; ".join(whys)[:200] or "dispatch"
        git("commit", "-q", "-m", f"{subject} (on {host_name()})", "-m", f"Mac: {host_name()}", check=True)
        return head()
    if not lock:
        return run()
    with Locked():
        return run()


def autocommit_on():
    return os.environ.get("DISPATCH_KNOWLEDGE_AUTOCOMMIT", "1") != "0"


def _alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def _spawn(args):
    import dplatform as P
    full = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), *args]
    return P.spawn_detached(full, cwd=os.path.expanduser("~"), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def schedule_commit(why, spawn=None, now=None):
    """A command just wrote knowledge: note why, and start the one committer that waits for SETTLE
    seconds of quiet (writes close together become one commit). Returns True when a committer started."""
    now = time.time() if now is None else now
    p = pending_path()
    os.makedirs(state_dir(), exist_ok=True)
    with _pending_lock():
        d = _read_json(p, {}) or {}
        whys = [w for w in d.get("why", []) if isinstance(w, str)]
        if why not in whys:
            whys.append(why)
        d.update(why=whys[-20:], at=now)
        if d.get("pid") and _alive(d["pid"]):
            _write_json(p, d)
            return False
        proc = (spawn or _spawn)(["knowledge", "commit", "--settle", str(SETTLE)])
        d["pid"] = getattr(proc, "pid", 0) or 0
        _write_json(p, d)
        return True


class _pending_lock:
    def __enter__(self):
        os.makedirs(state_dir(), exist_ok=True)
        self.fh = open(pending_path() + ".lock", "a")
        try:
            import fcntl
            fcntl.flock(self.fh, fcntl.LOCK_EX)
        except (ImportError, OSError):
            pass
        return self

    def __exit__(self, *exc):
        self.fh.close()


def settle_and_commit(settle=SETTLE, sleep=time.sleep, clock=time.time):
    """The detached committer: wait until nothing was written for `settle` seconds, then commit once
    with every noted command in the message."""
    p = pending_path()
    while True:
        with _pending_lock():
            d = _read_json(p, {}) or {}
            quiet = clock() - float(d.get("at") or 0)
            if quiet >= settle:
                whys = d.get("why") or ["dispatch"]
                try:
                    os.remove(p)
                except OSError:
                    pass
                break
        sleep(max(0.2, settle - quiet))
    return commit_now("\n".join(whys))


def after_command(argv, a=None):
    """Called by dispatch.py once a command finished: schedule a commit when it may have written knowledge."""
    if not autocommit_on() or not argv:
        return False
    cmd = getattr(a, "cmd", None) or argv[0]
    if cmd not in WRITERS:
        return False
    op = getattr(a, "op", None)
    if op in WRITERS[cmd]:
        return False
    if cmd == "done" and not getattr(a, "retro", None):
        return False
    if cmd == "aside" and not getattr(a, "save", None):
        return False
    words = ["dispatch", cmd] + ([op] if isinstance(op, str) else [])
    try:
        return schedule_commit(" ".join(words))
    except Exception:
        return False


# ---------------------------------------------------------------- merging

def _conflicts_log():
    return os.path.join(git_dir(), CONFLICTS_LOG)


def _note_conflict(path, detail, gitdir=None):
    p = os.path.join(gitdir or git_dir(), CONFLICTS_LOG)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps({"path": path, "detail": detail}, ensure_ascii=False) + "\n")


def _pref_time(e):
    ts = [e.get("created") or "", e.get("last_used") or "", e.get("kept_at") or "", (e.get("said") or {}).get("at", "") if isinstance(e.get("said"), dict) else ""]
    ts += [h.get("at", "") for h in e.get("history") or [] if isinstance(h, dict)]
    return max(t for t in ts if isinstance(t, str)) if ts else ""


def _pref_lines(text):
    out, order = {}, []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        try:
            e = json.loads(s)
        except ValueError:
            continue
        if isinstance(e, dict) and e.get("id"):
            if e["id"] not in out:
                order.append(e["id"])
            out[e["id"]] = e
    return out, order


def _merge_list(base, a, b, key=lambda x: json.dumps(x, sort_keys=True, ensure_ascii=False)):
    seen, out = set(), []
    for x in (a or []) + (b or []):
        k = key(x)
        if k not in seen:
            seen.add(k)
            out.append(x)
    return out


def merge_pref(base, ours, theirs):
    """One preference changed on both Macs. -> (merged, conflict fields). Usage adds up, history and
    references join, `seen` is either; any other field changed differently on both sides is a conflict,
    and the side touched last wins it."""
    base = base or {}
    out, bad = dict(ours), []
    later = theirs if _pref_time(theirs) > _pref_time(ours) else ours
    for k in sorted(set(ours) | set(theirs)):
        o, t, b = ours.get(k), theirs.get(k), base.get(k)
        if o == t:
            continue
        if o == b and k in theirs:
            out[k] = t
            continue
        if t == b:
            continue
        if k == "used":
            out[k] = int(b or 0) + (int(o or 0) - int(b or 0)) + (int(t or 0) - int(b or 0))
        elif k in ("last_used", "kept_at"):
            out[k] = max(x for x in (o, t) if x) if (o or t) else o
        elif k == "seen":
            out[k] = bool(o) or bool(t)
        elif k == "history":
            merged = _merge_list(b, o, t)
            merged.sort(key=lambda h: h.get("at", "") if isinstance(h, dict) else "")
            out[k] = merged
        elif k in ("cited_refs", "evidence", "sources", "also_in", "replaces"):
            out[k] = _merge_list(b, o, t)
        else:
            out[k] = later.get(k)
            bad.append(k)
    return out, bad


def merge_prefs_text(base, ours, theirs):
    """preferences.jsonl, entry by entry. -> (text, [(id, fields)] real conflicts)."""
    b, _ = _pref_lines(base)
    o, o_order = _pref_lines(ours)
    t, t_order = _pref_lines(theirs)
    order = o_order + [i for i in t_order if i not in o]
    out, bad = [], []
    for i in order:
        if i in o and i in t:
            if o[i] == t[i]:
                e = o[i]
            else:
                e, fields = merge_pref(b.get(i), o[i], t[i])
                if fields:
                    bad.append((i, fields))
        elif i in o:
            if i in b and b[i] != o[i]:
                e = o[i]            # changed here, deleted there: keep it
            elif i in b:
                continue           # deleted there
            else:
                e = o[i]
        else:
            if i in b and b[i] != t[i]:
                e = t[i]
            elif i in b:
                continue           # deleted here
            else:
                e = t[i]
        out.append(json.dumps(e, ensure_ascii=False, separators=(",", ":")))
    return ("\n".join(out) + "\n") if out else "", bad


def merge_driver(argv):
    """git's merge driver for *.md and *.jsonl (`merge=dispatch` in info/attributes): O A B P. Always
    leaves a merged file in A and exits 0; what really collided is noted for the sync to report."""
    base_p, ours_p, theirs_p, path = argv[:4]
    gitdir = argv[4] if len(argv) > 4 else (os.environ.get("GIT_DIR") or git_dir())
    read = lambda p: open(p, encoding="utf-8", errors="replace").read() if os.path.exists(p) else ""
    if os.path.basename(path) == PREFS:
        text, bad = merge_prefs_text(read(base_p), read(ours_p), read(theirs_p))
        with open(ours_p, "w", encoding="utf-8") as f:
            f.write(text)
        if bad:
            _note_conflict(path, "; ".join(f"{i} ({', '.join(fs)})" for i, fs in bad), gitdir)
        return 0
    r = subprocess.run(["git", "merge-file", "-q", "-p", ours_p, base_p, theirs_p], capture_output=True)
    if r.returncode == 0:
        with open(ours_p, "wb") as f:
            f.write(r.stdout)
        return 0
    u = subprocess.run(["git", "merge-file", "-q", "-p", "--union", ours_p, base_p, theirs_p], capture_output=True)
    with open(ours_p, "wb") as f:
        f.write(u.stdout)
    empty_base = not read(base_p)
    _note_conflict(path, "no common history: both versions joined" if empty_base else "both Macs changed the same lines: both versions kept", gitdir)
    return 0


def _unmerged():
    r = git("diff", "--name-only", "--diff-filter=U", "-z")
    return [p for p in r.stdout.split("\0") if p]


def _slug(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", s or "").strip("-") or "mac"


def _resolve_conflicts(peer):
    """Files git could not merge (a script, an image, deleted on one side): ours stays, theirs goes
    next to it as <file>.conflict-<mac>. Returns [(path, detail)]."""
    out = []
    for path in _unmerged():
        full = os.path.join(root(), path)
        ours = git("cat-file", "-e", f":2:{path}").returncode == 0
        theirs = git("cat-file", "-e", f":3:{path}").returncode == 0
        if ours:
            git("checkout", "--ours", "--", path)
            if theirs:
                side = full + CONFLICT_MARK + _slug(peer)
                blob = subprocess.run(["git", "--git-dir", git_dir(), "cat-file", "-p", f":3:{path}"], capture_output=True, env=_env())
                with open(side, "wb") as f:
                    f.write(blob.stdout)
                out.append((path, f"kept this Mac's version; {peer}'s is next to it as {os.path.basename(side)}"))
            else:
                out.append((path, f"deleted on {peer}, changed here: kept"))
            git("add", "--", path)
        elif theirs:
            git("checkout", "--theirs", "--", path)
            git("add", "--", path)
            out.append((path, f"deleted here, changed on {peer}: kept {peer}'s version"))
        else:
            git("rm", "-q", "--cached", "--", path)
    return out


def _changed(a, b, path):
    if not a or not b:
        return bool(b)
    return git("diff", "--quiet", a, b, "--", path).returncode != 0


# ---------------------------------------------------------------- sync

def peers():
    try:
        import dispatch as D
        return D.hosts()
    except Exception:
        return []


def remote_url(h):
    if h.get("knowledge_url"):
        return h["knowledge_url"]
    return f"{h['ssh']}:.dispatch/{GIT_DIR_NAME}"


UPLOAD_PACK = "/bin/bash -c 'export PATH=$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:$PATH; exec git-upload-pack \"$0\"'"


def load_state():
    d = _read_json(state_path(), {})
    return d if isinstance(d, dict) else {}


def save_state(d):
    _write_json(state_path(), d)


BOTH_CHANGED = "Both changed:"


def report_conflicts(before, after):
    """Every merge commit between before and after that says both Macs changed something becomes one
    notification here (the Mac that merged and the one that later takes the merge both hear of it)."""
    r = git("log", "--merges", "--format=%H%x1f%s%x1f%b%x1e", f"{before}..{after}")
    sent = []
    for rec in r.stdout.split("\x1e"):
        parts = rec.strip("\n").split("\x1f")
        if len(parts) < 3:
            continue
        sha, subject, body = parts[0].strip(), parts[1], parts[2]
        items = []
        for line in body.splitlines():
            if line.startswith(BOTH_CHANGED):
                path, _, detail = line[len(BOTH_CHANGED):].strip().partition(": ")
                items.append((path, detail))
        if items:
            m = re.match(r"sync from (.+) \(on (.+)\)$", subject)
            peer = m.group(1) if m and m.group(2) == host_name() else (m.group(2) if m else "another Mac")
            if notify(peer, items, f"knowledge:{sha}"):
                sent.append(sha)
    return sent


def notify(peer, items, key):
    """One notification for the conflicts of one merge (wake.py: the dispatcher, the hooks, prime)."""
    if not items:
        return None
    try:
        import wake
        files = ", ".join(sorted({p for p, _ in items}))
        text = f"Knowledge sync with {peer}: {len(items)} file(s) changed on both Macs, both versions kept: {files}"
        return wake.add_note(types.SimpleNamespace(DISPATCH_DIR=state_dir()), key, text, event="knowledge", source="knowledge")
    except Exception:
        return None


def refresh_rules():
    """GLOBAL.md came from the other Mac: the pasted copies in Codex, OpenCode and the others follow."""
    try:
        subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), "rules", "sync"],
                       cwd=os.path.expanduser("~"), capture_output=True, text=True, timeout=60)
        return True
    except Exception:
        return False


def sync_host(h, now=None, after_rules=None):
    """Fetch one Mac's knowledge and merge it here. -> {host, name, ok, skipped?, error?, merged?, conflicts}"""
    now = time.time() if now is None else now
    hid, name = h.get("id") or h.get("name") or "mac", h.get("name") or h.get("id") or "mac"
    row = {"host": hid, "name": name, "ok": False, "conflicts": []}
    ref = f"refs/remotes/{_slug(hid)}/{BRANCH}"
    args = ["fetch", "-q", "--no-tags"]
    if not h.get("knowledge_url"):
        args += ["--upload-pack", UPLOAD_PACK]
    try:
        r = git(*args, remote_url(h), f"+refs/heads/{BRANCH}:{ref}", timeout=FETCH_TIMEOUT)
    except subprocess.TimeoutExpired:
        row.update(skipped=True, error="no answer (offline?)")
        return row
    if r.returncode != 0:
        msg = (r.stderr or r.stdout).strip().splitlines()
        row.update(skipped=True, error=(msg[-1] if msg else f"git fetch exited {r.returncode}")[:200])
        return row
    with Locked():
        commit_now("before sync", lock=False)
        before, theirs = head(), git("rev-parse", ref).stdout.strip()
        if git("merge-base", "--is-ancestor", theirs, before).returncode == 0:
            row.update(ok=True, merged=False)
            return row
        try:
            os.remove(_conflicts_log())
        except OSError:
            pass
        unrelated = git("merge-base", before, theirs).returncode != 0
        m = git("merge", "-q", "--no-commit", *(["--allow-unrelated-histories"] if unrelated else []), ref, timeout=120)
        items = []
        if m.returncode != 0 and not _unmerged():
            git("merge", "--abort")
            row.update(error=((m.stderr or m.stdout).strip().splitlines() or ["merge failed"])[-1][:200])
            return row
        items += _resolve_conflicts(name)
        for line in open(_conflicts_log(), encoding="utf-8").read().splitlines() if os.path.exists(_conflicts_log()) else []:
            try:
                x = json.loads(line)
                items.append((x["path"], x["detail"]))
            except (ValueError, KeyError):
                pass
        if os.path.exists(os.path.join(git_dir(), "MERGE_HEAD")):
            # what collided goes into the merge commit, so the other Mac reports it too when it takes this commit
            body = "\n".join(f"{BOTH_CHANGED} {p}: {d}" for p, d in items)
            c = git("commit", "-q", "-m", f"sync from {name} (on {host_name()})", *(["-m", body] if body else []))
            if c.returncode != 0:
                git("merge", "--abort")
                row.update(error=(c.stderr or c.stdout).strip()[-200:])
                return row
        after = head()
        row.update(ok=True, merged=True, commit=after, conflicts=[{"path": p, "detail": d} for p, d in items])
        report_conflicts(before, after)
    apply_links_manifest()
    if _changed(before, after, "rules/GLOBAL.md"):
        (after_rules or refresh_rules)()
    return row


def sync_all(host_filter="", now=None, after_rules=None):
    """Every Mac in hosts.json (or the one named). An offline Mac is skipped; the last good sync with
    each is kept in knowledge-sync.json."""
    now = time.time() if now is None else now
    ensure_repo()
    commit_now("before sync")
    hs = [h for h in peers() if not host_filter or host_filter in (h.get("id"), h.get("name")) or host_filter in (h.get("aliases") or [])]
    st = load_state()
    rows = []
    for h in hs:
        try:
            row = sync_host(h, now=now, after_rules=after_rules)
        except Exception as e:  # noqa: BLE001  one broken Mac never stops the others
            row = {"host": h.get("id"), "name": h.get("name"), "ok": False, "error": f"{type(e).__name__}: {str(e)[:160]}", "conflicts": []}
        rec = dict((st.get("hosts") or {}).get(row["host"]) or {})
        rec.update(name=row["name"], last_try=now, error=row.get("error", ""))
        if row["ok"]:
            rec["last_ok"] = now
        (st.setdefault("hosts", {}))[row["host"]] = rec
        rows.append(row)
    st["last_run"] = now
    save_state(st)
    return rows


def due(now=None):
    now = time.time() if now is None else now
    return now - float(load_state().get("last_run") or 0) >= SYNC_EVERY


def status():
    st = load_state()
    hs = peers()
    rows = []
    for h in hs:
        rec = (st.get("hosts") or {}).get(h.get("id")) or {}
        rows.append({"host": h.get("id"), "name": h.get("name"), "last_ok": rec.get("last_ok"), "last_try": rec.get("last_try"), "error": rec.get("error", "")})
    last = git("log", "-1", "--format=%ct%x09%s").stdout.strip() if has_repo() else ""
    at, _, subject = last.partition("\t")
    return {"repo": has_repo(), "path": root(), "last_commit": {"at": int(at), "subject": subject} if at.isdigit() else None,
            "peers": rows, "last_run": st.get("last_run")}


# ---------------------------------------------------------------- CLI

def _ago(ts):
    if not ts:
        return "never"
    s = max(0, int(time.time() - float(ts)))
    return f"{s} s ago" if s < 120 else f"{s // 60} min ago" if s < 7200 else f"{s // 3600} h ago" if s < 172800 else f"{s // 86400} days ago"


def command(a, out):
    op = a.op or "status"
    if op == "commit":
        if getattr(a, "settle", None):
            sha = settle_and_commit(float(a.settle))
        else:
            sha = commit_now(getattr(a, "why", "") or "dispatch knowledge commit")
        return out({"commit": sha}, a.json, lambda d: print(f"committed {d['commit'][:10]}" if d["commit"] else "nothing changed"))
    if op == "sync":
        rows = sync_all(getattr(a, "host", "") or "")

        def text(rs):
            if not rs:
                print("Only this Mac: nothing to sync.")
            for r in rs:
                state = "skipped (" + r.get("error", "") + ")" if r.get("skipped") else ("merged" if r.get("merged") else "up to date") if r["ok"] else "failed: " + r.get("error", "")
                print(f"{r['name']:<20} {state}")
                for c in r.get("conflicts") or []:
                    print(f"  both changed: {c['path']} ({c['detail']})")
        return out(rows, a.json, text)
    st = status()

    def text(d):
        print(f"Knowledge in {d['path']} " + ("(tracked)" if d["repo"] else "(not set up yet: it starts with the next write)"))
        if d["last_commit"]:
            print(f"Last change: {d['last_commit']['subject']} ({_ago(d['last_commit']['at'])})")
        if not d["peers"]:
            print("Only this Mac: nothing to sync.")
        for p in d["peers"]:
            print(f"{p['name']:<20} last sync {_ago(p['last_ok'])}" + (f", last try failed: {p['error']}" if p.get("error") else ""))
    return out(st, a.json, text)


def add_parser(sub):
    s = sub.add_parser("knowledge", help="what Dispatch knows about you (preferences, wiki, rules, skills, sub-agents) stays the same on all your Macs by itself: status | sync | commit")
    s.add_argument("op", nargs="?", default="status", choices=["status", "sync", "commit"])
    s.add_argument("--host", default="", help="sync: only this Mac from hosts.json")
    s.add_argument("--why", default="", help="commit: what wrote the files")
    s.add_argument("--settle", default=None, help="commit: wait until nothing was written for this many seconds (used by Dispatch itself)")
    s.add_argument("--json", action="store_true")
    return s


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "merge-driver":
        sys.exit(merge_driver(sys.argv[2:]))
    print("usage: dispatch knowledge status|sync|commit", file=sys.stderr)
    sys.exit(2)
