# -*- coding: utf-8 -*-
"""`dispatch checkpoint <op> --root <project> … --json`: one snapshot of the project's files per
agent turn, and going back to before a turn (design/full-ide/PLAN.md §3.5).

A shadow git repository per project, outside it: DISPATCH_DIR/checkpoints/<name>-<sha1(root)[:10]>/
    repo/        a bare repository; its work tree is the project folder (GIT_WORK_TREE)
    index        the shadow index (GIT_INDEX_FILE), so snapshots after the first only hash what changed
    turns.json   {"root", "version", "turns": [record, …] oldest first}
    lock         flock between chatd's threads, chatd and a CLI call
The project's own .git is never touched and the folder does not have to be a git repository. The
project's .gitignore files apply, plus DEFAULT_EXCLUDES; files over BIG_FILE bytes are left out.
A snapshot that would hash more than MAX_NEW_BYTES (or add more than MAX_NEW_FILES files), or whose
git timed out, is refused and the folder is skipped for SKIP_AFTER_REFUSAL. A killed git leaves its
index.lock behind; whoever takes the project lock removes such leftovers first.
`info/attributes` turns every filter and line-ending conversion off, so a snapshot holds the bytes
on disk and a restore writes them back unchanged (no LFS, no autocrlf).

A record (one agent turn, or one restore):
    {turn_id, kind: "turn"|"restore", sid, message_id, agent_turn_id, text, ts, before_tree,
     after_tree, after_ts, files_changed: [{path, status}], restored_turn?}
chatd calls begin() before it sends a message (before_tree) and finish() after the turn is done
(after_tree, files_changed). A restore first snapshots the present (its record's before_tree, the
`rollback_from`), so restoring that record undoes the restore.

Restore to before turn T: the files that differ between now and T's before_tree are written back
(or deleted when T's before_tree does not have them). A file whose content now differs from the
latest after_tree at or after T (you, or something else, changed it after the agents finished) is
a conflict: without --force nothing happens and the answer lists the conflicts; --only-clean
restores the others. So is a file created during those turns that no agent edit tool wrote (chatd
records the paths in `agent_paths`; the answer lists them as `unsure`): you may have made it while
the agent ran. While a chat session's agent works in the project (chatd.json says running) a
restore is refused with `running`; a dry run lists those sessions. Afterwards editor baselines (editor.py) captured at or after T are reset to
the restored content, and a note for the agent waits in checkpoints/notes/<sid>.json until chatd
sends that session's next message (--no-note when the caller tells chatd itself).

Always exit 0 with one JSON object on stdout: {"ok": true, …} or {"ok": false, "error", "message"}.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from lang import t as _t
import uuid
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

IS_WIN = os.name == "nt"
VERSION = 1
GIT_TIMEOUT = 60
BIG_FILE = 5 * 1024 * 1024       # bytes; larger files are not snapshotted (nor restored, nor deleted)
MAX_NEW_FILES = 20000            # one snapshot adding more than this many files is refused (a folder that is not a project)
MAX_NEW_BYTES = 300 * 1024 * 1024  # nor one that has to hash more than this (about 10 s); the folder is skipped for a while
SKIP_AFTER_REFUSAL = 3600        # seconds a refused folder (too many files, too many bytes, git timed out) is not scanned again
STALE_LOCK = 2 * GIT_TIMEOUT     # seconds; a git lock file this old is left over from a killed git even without our lock
RUNNING_STATES = ("running", "waiting_permission", "waiting_input", "stopping")
KEEP_TURNS = 200                 # per project
KEEP_DAYS = 14
GC_EVERY = 24 * 3600
NOTE_TTL = 24 * 3600             # a pending note older than this is dropped
TEXT_KEEP = 300                  # characters of the message kept per record
SLOW_SNAPSHOT = 3.0              # seconds; chatd says so once
DEFAULT_EXCLUDES = ("node_modules/", "target/", ".venv/", "venv/", "dist/", "__pycache__/", "*.pyc", ".DS_Store",
                    ".mypy_cache/", ".pytest_cache/", ".tox/", ".next/", ".gradle/", "DerivedData/", ".build/", ".git/")
ERROR_CODES = ("bad_request", "no_root", "root_too_broad", "too_many_files", "no_such_turn", "running", "conflict", "git_failed", "io")


class CpError(Exception):
    def __init__(self, code, message, **extra):
        Exception.__init__(self, message)
        self.code = code if code in ERROR_CODES else "bad_request"
        self.extra = extra

    def body(self):
        b = {"ok": False, "error": self.code, "message": str(self)}
        b.update(self.extra)
        return b


# ---------------------------------------------------------------- where things live
def dispatch_dir(base=None):
    return base or os.environ.get("DISPATCH_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".dispatch")


def checkpoints_dir(base=None):
    return os.path.join(dispatch_dir(base), "checkpoints")


def _inside(path, root):
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def forbidden_root(path):
    """The home folder, anything above it and a file system root: never snapshotted as a whole."""
    home = os.path.realpath(os.path.expanduser("~"))
    return path == os.path.dirname(path) or _inside(home, path)


def _run(args, cwd=None, env=None, input=None, timeout=GIT_TIMEOUT):
    kw = {}
    if IS_WIN:
        kw["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        return subprocess.run(args, cwd=cwd, env=env, input=input, capture_output=True, timeout=timeout, **kw)
    except FileNotFoundError:
        raise CpError("git_failed", "git is not installed")
    except subprocess.TimeoutExpired:
        what = next((x for i, x in enumerate(args[1:], 1) if not x.startswith("-") and args[i - 1] != "-c"), "")
        raise CpError("git_failed", "git %s took longer than %g s" % (what, timeout), timeout=True)


def project_root(cwd):
    """The folder a session's checkpoints cover: the git top level of `cwd`, else `cwd` itself.
    CpError when it does not exist or is the home folder (or above it)."""
    if not cwd or not isinstance(cwd, str):
        raise CpError("no_root", "no project folder")
    path = os.path.realpath(os.path.expanduser(cwd))
    if not os.path.isdir(path):
        raise CpError("no_root", _t("No such folder: %s", "没有这个目录：%s") % path)
    env = dict(os.environ, LC_ALL="C", GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0")
    for k in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        env.pop(k, None)
    try:
        r = _run(["git", "-C", path, "rev-parse", "--show-toplevel"], env=env, timeout=15)
        top = r.stdout.decode("utf-8", "replace").strip() if r.returncode == 0 else ""
    except CpError:
        top = ""
    if top:
        top = os.path.realpath(top)
        if os.path.isdir(top) and not forbidden_root(top):
            path = top
    if forbidden_root(path):
        raise CpError("root_too_broad", _t("No snapshots of the home folder or the folders above it: %s", "不给家目录或它上面的目录打快照：%s") % path)
    return path


def project_key(root):
    name = re.sub(r"[^\w.-]+", "_", os.path.basename(root.rstrip("/\\")) or "root")[:40]
    norm = os.path.normcase(os.path.normpath(root))
    return "%s-%s" % (name, hashlib.sha1(norm.encode("utf-8")).hexdigest()[:10])


class _Lock:
    """One writer per project: a thread lock (chatd's threads) and a file lock (other processes)."""
    _threads = {}
    _guard = threading.Lock()

    def __init__(self, d):
        self.d, self.f, self.held = d, None, False
        with _Lock._guard:
            self.tl = _Lock._threads.setdefault(d, threading.RLock())

    def __enter__(self):
        self.tl.acquire()
        os.makedirs(self.d, exist_ok=True)
        try:
            self.f = open(os.path.join(self.d, "lock"), "a+")
            if IS_WIN:
                import msvcrt
                self.f.seek(0)
                for _ in range(600):
                    try:
                        msvcrt.locking(self.f.fileno(), msvcrt.LK_NBLCK, 1)
                        self.held = True
                        break
                    except OSError:
                        time.sleep(0.1)
            else:
                import fcntl
                fcntl.flock(self.f.fileno(), fcntl.LOCK_EX)
                self.held = True
        except (ImportError, OSError):
            pass
        clear_stale_locks(self.d, self.held)
        return self

    def __exit__(self, *exc):
        try:
            if self.f:
                if IS_WIN:
                    import msvcrt
                    self.f.seek(0)
                    try:
                        msvcrt.locking(self.f.fileno(), msvcrt.LK_UNLCK, 1)
                    except OSError:
                        pass
                else:
                    import fcntl
                    fcntl.flock(self.f.fileno(), fcntl.LOCK_UN)
                self.f.close()
        except (ImportError, OSError):
            pass
        finally:
            self.tl.release()


def _git_locks(d):
    """The lock files git leaves in a shadow directory when it is killed mid-write."""
    out = [os.path.join(d, "index.lock"), os.path.join(d, "index.restore.lock")]
    repo = os.path.join(d, "repo")
    for name in ("HEAD.lock", "config.lock", "packed-refs.lock", "shallow.lock"):
        out.append(os.path.join(repo, name))
    for top, _dirs, files in os.walk(os.path.join(repo, "refs")):
        out += [os.path.join(top, f) for f in files if f.endswith(".lock")]
    return out


def clear_stale_locks(d, held=True):
    """Remove git lock files a killed git left behind (a timeout, chatd killed mid-snapshot);
    otherwise every later snapshot of the project fails with "index.lock: File exists". Only our
    own writers run git in `d` and they all hold the project lock, so while we hold it any lock
    file is stale; without it (the Windows lock timed out) only an old one is removed."""
    removed = []
    for p in _git_locks(d):
        try:
            if not held and time.time() - os.path.getmtime(p) < STALE_LOCK:
                continue
            os.remove(p)
            removed.append(p)
        except OSError:
            pass
    return removed


def _rmtree(path):
    """Remove a shadow repo. git writes its objects read-only, which Windows refuses to delete
    until the read-only bit is cleared."""
    import stat

    def clear(func, p, _exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass
    shutil.rmtree(path, onerror=clear)


def _atomic_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.%d.%d.tmp" % (path, os.getpid(), threading.get_ident())
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


class Shadow:
    """The shadow repository of one project folder."""

    def __init__(self, root, base=None):
        self.root = root
        self.dir = os.path.join(checkpoints_dir(base), project_key(root))
        self.git_dir = os.path.join(self.dir, "repo")
        self.index = os.path.join(self.dir, "index")
        self.turns_path = os.path.join(self.dir, "turns.json")

    def lock(self):
        return _Lock(self.dir)

    # -- git
    def env(self, index=None):
        env = dict(os.environ, LC_ALL="C", GIT_TERMINAL_PROMPT="0", GIT_DIR=self.git_dir, GIT_WORK_TREE=self.root,
                   GIT_INDEX_FILE=index or self.index)
        for k in ("GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES"):
            env.pop(k, None)
        return env

    def git(self, args, input=None, index=None, timeout=GIT_TIMEOUT, ok=(0,)):
        try:
            r = _run(["git", "-c", "core.quotepath=off"] + list(args), cwd=self.root, env=self.env(index), input=input, timeout=timeout)
        except CpError as e:
            if e.extra.get("timeout"):
                clear_stale_locks(self.dir)  # the killed git's index.lock would block every later snapshot
            raise
        if r.returncode not in ok:
            raise CpError("git_failed", (r.stderr or r.stdout).decode("utf-8", "replace").strip()[:600] or "git %s failed" % args[0])
        return r.stdout

    def ensure(self):
        if os.path.isfile(os.path.join(self.git_dir, "HEAD")):
            return
        os.makedirs(self.dir, exist_ok=True)
        r = _run(["git", "init", "--bare", "--quiet", self.git_dir], env=dict(os.environ, LC_ALL="C"))
        if r.returncode != 0:
            raise CpError("git_failed", r.stderr.decode("utf-8", "replace").strip()[:600])
        conf = {"core.autocrlf": "false", "core.safecrlf": "false", "core.fsmonitor": "false", "core.untrackedCache": "true",
                "core.bare": "false", "core.logAllRefUpdates": "false", "gc.auto": "0", "core.symlinks": "true" if not IS_WIN else "false",
                "core.ignorecase": "true" if sys.platform in ("darwin", "win32") else "false",
                "core.precomposeunicode": "true" if sys.platform == "darwin" else "false"}
        for k, v in conf.items():
            _run(["git", "--git-dir", self.git_dir, "config", k, v], env=dict(os.environ, LC_ALL="C"))
        info = os.path.join(self.git_dir, "info")
        os.makedirs(info, exist_ok=True)
        with open(os.path.join(info, "exclude"), "w", encoding="utf-8") as f:
            f.write("# Dispatch checkpoints: never snapshotted\n" + "\n".join(DEFAULT_EXCLUDES) + "\n")
        with open(os.path.join(info, "attributes"), "w", encoding="utf-8") as f:
            f.write("* -text -filter -ident -working-tree-encoding -eol\n")
        with open(os.path.join(self.dir, "ROOT"), "w", encoding="utf-8") as f:
            f.write(self.root + "\n")

    # -- turns.json
    def load(self):
        try:
            with open(self.turns_path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("turns"), list):
                return data
        except (OSError, ValueError):
            pass
        return {"root": self.root, "version": VERSION, "turns": []}

    def save(self, data):
        data["root"] = self.root
        data["version"] = VERSION
        _atomic_json(self.turns_path, data)

    # -- snapshots
    def _size(self, rel):
        """Bytes git would hash for this path (0 for a symlink or a path that is gone)."""
        try:
            st = os.lstat(os.path.join(self.root, *rel.split("/")))
        except OSError:
            return 0
        import stat
        return st.st_size if stat.S_ISREG(st.st_mode) else 0

    def snapshot(self):
        """Bring the shadow index up to the disk and write it as a tree: the tree id."""
        self.ensure()
        out = self.git(["ls-files", "-z", "--others", "--modified", "--deleted", "--exclude-standard"])
        paths = sorted({p for p in out.decode("utf-8", "surrogateescape").split("\0") if p and not p.endswith("/")})
        if paths:
            if len(paths) > MAX_NEW_FILES:
                tracked = set(self.git(["ls-files", "-z"]).decode("utf-8", "surrogateescape").split("\0"))
                if sum(1 for p in paths if p not in tracked) > MAX_NEW_FILES:
                    raise CpError("too_many_files", _t("This folder has more than %d files to keep, so no snapshot: %s", "这个目录里要记下的文件超过 %d 个，不打快照：%s") % (MAX_NEW_FILES, self.root))
            sizes = {p: self._size(p) for p in paths}
            big = [p for p in paths if sizes[p] > BIG_FILE]
            keep = [p for p in paths if sizes[p] <= BIG_FILE]
            total = sum(sizes[p] for p in keep)
            if total > MAX_NEW_BYTES:
                # hashing this much blocks the message for tens of seconds and copies it all into the shadow repo
                raise CpError("too_many_files", _t("This folder has %d MB of files to keep, more than %d MB, so no snapshot: %s", "这个目录里要记下的文件有 %d MB，超过 %d MB，不打快照：%s") % (total >> 20, MAX_NEW_BYTES >> 20, self.root))
            if keep:
                self.git(["update-index", "-z", "--add", "--remove", "--stdin"], input="\0".join(keep).encode("utf-8", "surrogateescape") + b"\0")
            if big:
                self.git(["update-index", "-z", "--force-remove", "--stdin"], input="\0".join(big).encode("utf-8", "surrogateescape") + b"\0")
        return self.git(["write-tree"]).decode().strip()

    def pin(self, tree, name):
        """Keep `tree` (and its blobs) alive through gc."""
        self.git(["update-ref", "refs/cp/" + name, tree])

    def tree_map(self, tree):
        """{path: (mode, oid)} of a tree."""
        out = self.git(["ls-tree", "-r", "-z", "--full-tree", tree])
        m = {}
        for ent in out.decode("utf-8", "surrogateescape").split("\0"):
            if not ent:
                continue
            head, _, path = ent.partition("\t")
            parts = head.split()
            if len(parts) >= 3:
                m[path] = (parts[0], parts[2])
        return m

    def changes(self, a, b):
        """[{path, status: A|M|D}] from tree a to tree b."""
        if not a or not b or a == b:
            return []
        out = self.git(["diff-tree", "-r", "-z", "--no-renames", "--name-status", a, b]).decode("utf-8", "surrogateescape").split("\0")
        res = []
        for i in range(0, len(out) - 1, 2):
            st, path = out[i], out[i + 1]
            if st and path:
                res.append({"path": path, "status": st[0]})
        return res


def _snapshot_timed(sh):
    t0 = time.time()
    tree = sh.snapshot()
    return tree, int((time.time() - t0) * 1000)


def _new_id():
    return "cp-%s-%s" % (time.strftime("%Y%m%d%H%M%S"), uuid.uuid4().hex[:6])


def _find(data, turn):
    for r in data["turns"]:
        if turn and turn in (r.get("turn_id"), r.get("message_id"), r.get("agent_turn_id")):
            return r
    return None


# ---------------------------------------------------------------- what chatd calls (never raise)
_refused = {}


def begin(cwd, sid="", message_id="", text="", base=None):
    """Snapshot before a message goes to the agent. {"turn_id", "ms", "root"} or {"error", "message"}."""
    try:
        root = project_root(cwd)
        sh = Shadow(root, base)
        if _refused.get(sh.dir, 0) > time.time():
            return {"error": "too_many_files", "message": "skipped", "root": root}
        with sh.lock():
            data = sh.load()
            if float(data.get("skip_until") or 0) > time.time():
                return {"error": "too_many_files", "message": "skipped", "root": root}
            try:
                tree, ms = _snapshot_timed(sh)
            except CpError as e:
                if e.code == "too_many_files" or e.extra.get("timeout"):
                    data["skip_until"] = time.time() + SKIP_AFTER_REFUSAL
                    _refused[sh.dir] = data["skip_until"]
                    sh.save(data)
                raise
            tid = _new_id()
            sh.pin(tree, tid + "/before")
            data["turns"].append({"turn_id": tid, "kind": "turn", "sid": sid or "", "message_id": message_id or "", "agent_turn_id": "",
                                  "text": (text or "")[:TEXT_KEEP], "ts": round(time.time(), 3), "before_tree": tree, "after_tree": "",
                                  "after_ts": 0, "files_changed": [], "snapshot_ms": ms})
            sh.save(data)
            return {"turn_id": tid, "ms": ms, "root": root}
    except CpError as e:
        return {"error": e.code, "message": str(e)}
    except Exception as e:  # a checkpoint never stops a message
        return {"error": "io", "message": "%s: %s" % (type(e).__name__, str(e)[:300])}


def _rel_paths(root, cwd, paths):
    """Root-relative forward-slash paths of the files the agent's edit tools named (absolute, or
    relative to the session's folder); the ones outside the project are dropped."""
    out = set()
    for p in paths or []:
        if not isinstance(p, str) or not p:
            continue
        full = os.path.realpath(os.path.join(os.path.realpath(cwd or root), os.path.expanduser(p)))
        if _inside(full, root) and full != root:
            out.add(os.path.relpath(full, root).replace(os.sep, "/"))
    return sorted(out)


def finish(cwd, turn_id, agent_turn_id="", base=None, agent_paths=None):
    """Snapshot after the turn: after_tree and files_changed of `turn_id`. The record or None.
    `agent_paths`: the files the agent's edit tools wrote in this turn (chatd knows them); a restore
    deletes a file created during the turn without asking only when an edit tool wrote it."""
    try:
        root = project_root(cwd)
        sh = Shadow(root, base)
        with sh.lock():
            data = sh.load()
            rec = _find(data, turn_id)
            if rec is None:
                return None
            tree, ms = _snapshot_timed(sh)
            sh.pin(tree, rec["turn_id"] + "/after")
            rec.update(after_tree=tree, after_ts=round(time.time(), 3), files_changed=sh.changes(rec["before_tree"], tree))
            if agent_turn_id:
                rec["agent_turn_id"] = agent_turn_id
            if agent_paths is not None:
                rec["agent_paths"] = sorted(set(rec.get("agent_paths") or []) | set(_rel_paths(root, cwd, agent_paths)))
            sh.save(data)
            return rec
    except Exception:
        return None


def discard(cwd, turn_id, base=None):
    """Drop the record of a message that never reached the agent."""
    try:
        sh = Shadow(project_root(cwd), base)
        with sh.lock():
            data = sh.load()
            rec = _find(data, turn_id)
            if rec is None:
                return False
            data["turns"].remove(rec)
            sh.git(["update-ref", "-d", "refs/cp/%s/before" % rec["turn_id"]], ok=(0, 1))
            sh.save(data)
            return True
    except Exception:
        return False


def _notes_path(sid, base=None):
    return os.path.join(checkpoints_dir(base), "notes", re.sub(r"[^\w.-]", "_", sid.replace(":", "__")) + ".json")


def add_note(sid, text, base=None):
    if not sid or not text:
        return
    path = _notes_path(sid, base)
    try:
        with open(path, encoding="utf-8") as f:
            notes = json.load(f)
    except (OSError, ValueError):
        notes = []
    notes = [n for n in notes if isinstance(n, dict)] + [{"text": text, "ts": time.time()}]
    _atomic_json(path, notes)


def take_notes(sid, base=None):
    """Notes a restore left for this session (and forget them); [] when none. Never raises."""
    try:
        path = _notes_path(sid, base)
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as f:
            notes = json.load(f)
        os.remove(path)
        now = time.time()
        return [n["text"] for n in notes if isinstance(n, dict) and isinstance(n.get("text"), str) and now - float(n.get("ts") or 0) < NOTE_TTL]
    except Exception:
        return []


# ---------------------------------------------------------------- list / diff / restore
def _public(rec):
    return {k: rec.get(k) for k in ("turn_id", "kind", "sid", "message_id", "agent_turn_id", "text", "ts", "before_tree", "after_tree",
                                    "after_ts", "files_changed", "restored_turn", "agent_paths") if k in rec}


def op_list(root, a):
    sh = Shadow(root)
    data = sh.load()
    turns = [r for r in data["turns"] if not a.sid or r.get("sid") == a.sid]
    turns = sorted(turns, key=lambda r: r.get("ts") or 0, reverse=True)[: max(1, a.n)]
    return {"ok": True, "root": root, "turns": [_public(r) for r in turns], "count": len(data["turns"])}


def op_snapshot(root, a):
    sh = Shadow(root)
    if a.after:
        with sh.lock():
            data = sh.load()
            rec = _find(data, a.after)
            if rec is None:
                raise CpError("no_such_turn", _t("No such round: %s", "没有这一轮：%s") % a.after)
        rec = finish(root, rec["turn_id"])
        if rec is None:
            raise CpError("io", _t("The snapshot was not taken", "快照没打成"))
        return {"ok": True, "turn": _public(rec)}
    r = begin(root, a.sid or "", a.message_id or "", a.text or "")
    if r.get("error"):
        raise CpError(r["error"], r.get("message") or r["error"])
    with sh.lock():
        rec = _find(sh.load(), r["turn_id"])
    return {"ok": True, "turn": _public(rec), "ms": r["ms"]}


def _numstat(sh, a, b, paths=None):
    out = sh.git(["diff-tree", "-r", "-z", "--no-renames", "--numstat", a, b] + (["--"] + paths if paths else []))
    stats = {}
    parts = out.decode("utf-8", "surrogateescape").split("\0")
    for p in parts:
        bits = p.split("\t")
        if len(bits) == 3:
            stats[bits[2]] = (bits[0], bits[1])
    return stats


def op_diff(root, a):
    sh = Shadow(root)
    data = sh.load()
    if a.turn:
        rec = _find(data, a.turn)
        if rec is None:
            raise CpError("no_such_turn", _t("No such round: %s", "没有这一轮：%s") % a.turn)
        frm = rec["before_tree"]
        with sh.lock():
            to = rec.get("after_tree") or sh.snapshot()
    else:
        if not a.frm:
            raise CpError("bad_request", _t("diff needs --turn, or --from <tree> [--to <tree>]", "diff 要 --turn，或 --from <tree> [--to <tree>]"))
        frm = a.frm
        with sh.lock():
            to = a.to or sh.snapshot()
    files = sh.changes(frm, to)
    stats = _numstat(sh, frm, to) if files else {}
    for f in files:
        add, dele = stats.get(f["path"], ("0", "0"))
        f["add"] = int(add) if add.isdigit() else 0
        f["del"] = int(dele) if dele.isdigit() else 0
        f["binary"] = add == "-"
    out = {"ok": True, "root": root, "from": frm, "to": to, "files": files}
    if a.patch and files:
        out["patch"] = sh.git(["diff-tree", "-r", "-p", "--no-renames", "--no-color", frm, to]).decode("utf-8", "replace")[:400000]
    return out


def _latest_after(data, rec):
    """The newest after_tree of a turn at or after `rec` (the last state agents left the files in)."""
    best = None
    for r in data["turns"]:
        if (r.get("ts") or 0) >= (rec.get("ts") or 0) and r.get("after_tree"):
            if best is None or (r.get("after_ts") or 0) > (best.get("after_ts") or 0):
                best = r
    return best["after_tree"] if best else ""


def _agent_written(data, rec):
    """The files agents' edit tools wrote, or a restore wrote back, in the records at or after `rec`;
    None when one of those turns did not record them (an older record, a command-line snapshot)."""
    out = set()
    for r in data["turns"]:
        if (r.get("ts") or 0) < (rec.get("ts") or 0) or not r.get("after_tree"):
            continue
        if r.get("kind") == "restore":
            out.update(f.get("path") for f in r.get("files_changed") or [] if isinstance(f, dict))
            continue
        if not isinstance(r.get("agent_paths"), list):
            return None
        out.update(r["agent_paths"])
    return out


def plan_restore(sh, data, rec, now_tree):
    """(changes, conflicts, unsure): changes [{path, action: restore|delete|create}] turning now into
    rec's before_tree; conflicts the paths whose present content no agent turn left there, plus
    `unsure`: files created during those turns that no agent edit tool wrote (you may have made them
    while the agent ran, or a shell command did), which a restore would otherwise delete unasked."""
    before = sh.tree_map(rec["before_tree"])
    now = sh.tree_map(now_tree)
    after_tree = _latest_after(data, rec)
    after = sh.tree_map(after_tree) if after_tree else None
    written = _agent_written(data, rec)
    changes, conflicts, unsure = [], [], []
    for path in sorted(set(before) | set(now)):
        b, n = before.get(path), now.get(path)
        if b == n:
            continue
        if b is None:
            action = "delete"
        elif n is None:
            action = "create"
        else:
            action = "restore"
        changes.append({"path": path, "action": action})
        if after is None or after.get(path) != n:
            conflicts.append(path)
        elif action == "delete" and written is not None and path not in written:
            conflicts.append(path)
            unsure.append(path)
    return changes, conflicts, unsure


def _write_back(sh, tree, paths):
    """Write `paths` of `tree` into the work tree (content and mode)."""
    if not paths:
        return
    tmp = os.path.join(sh.dir, "index.restore")
    try:
        sh.git(["read-tree", tree], index=tmp)
        sh.git(["checkout-index", "-f", "-z", "--stdin"], index=tmp, input="\0".join(paths).encode("utf-8", "surrogateescape") + b"\0")
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def _delete(root, rel):
    full = os.path.join(root, *rel.split("/"))
    if not _inside(os.path.realpath(os.path.dirname(full)), root):
        return False
    try:
        if os.path.isdir(full) and not os.path.islink(full):
            return False
        os.remove(full)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    d = os.path.dirname(full)
    while d != root and _inside(d, root):
        try:
            os.rmdir(d)  # only when empty
        except OSError:
            break
        d = os.path.dirname(d)
    return True


def reset_baselines(root, paths, since, base=None):
    """Agent-hunk baselines (editor.py) of these files taken at or after `since` describe a state
    that no longer exists: the restored content becomes the baseline, a deleted file loses its entry.
    Older baselines stay (the agent changes before the restored turn are still there to review)."""
    try:
        import editor
    except Exception:
        return []
    reset = []
    ed = os.path.join(dispatch_dir(base), "editor")
    try:
        names = os.listdir(ed)
    except OSError:
        return []
    want = set(paths)
    for name in names:
        st = editor.Store(name.replace("__", ":", 1), base)
        st.dir = os.path.join(ed, name)
        st.index_path = os.path.join(st.dir, "index.json")
        try:
            with editor._Lock(st.dir):
                idx = st.load()
                if not idx:
                    continue
                iroot = os.path.realpath(idx["root"])
                if not (_inside(iroot, root) or _inside(root, iroot)):
                    continue
                changed = False
                for rel in want:
                    full = os.path.join(root, *rel.split("/"))
                    key = st.key_of(idx, full)
                    ent = idx["files"].get(key) if key else None
                    if not ent or float(ent.get("captured_at") or 0) < since:
                        continue
                    text, raw = editor._disk_text(full)
                    if os.path.isfile(full) and text is not None:
                        st.set_base(idx, key, text)
                        ent.update(existed=True, sha1=editor.sha1(raw), captured_at=round(time.time(), 3), fresh=False)
                    else:
                        st.drop_base(key)
                        del idx["files"][key]
                    changed = True
                    reset.append(rel)
                if changed:
                    st.save(idx)
        except Exception:
            continue
    return sorted(set(reset))


def note_text(rec, restored, deleted):
    what = (rec.get("text") or "").strip().split("\n")[0][:60]
    parts = []
    if restored:
        parts.append(_t("restored ", "恢复了 ") + _t(", ", "、").join(restored[:8]) + (_t(" and others, %d files", " 等 %d 个文件") % len(restored) if len(restored) > 8 else ""))
    if deleted:
        parts.append(_t("deleted what was made after it: ", "删掉了这之后新建的 ") + _t(", ", "、").join(deleted[:8]) + (_t(" and others, %d files", " 等 %d 个文件") % len(deleted) if len(deleted) > 8 else ""))
    if _t("en", "zh") == "en":
        head = "The person took the project's files back to before this round" + (" (\"%s\")" % what if what else "")
        return head + (": " + "; ".join(parts) + "." if parts else ".") + " Go on from what is on disk now; do not redo the changes that were taken back unless the person asks again."
    head = "用户把项目文件回到了这一轮之前" + ("（「%s」）" % what if what else "")
    return head + ("：" + "；".join(parts) + "。" if parts else "。") + "按现在磁盘上的内容继续，不要重做被撤回的改动，除非用户再要求。"


def running_sessions(root, base=None):
    """Keys of the chat sessions (chatd.json) whose agent is working in this project right now."""
    try:
        import chat_protocol as cp
        with open(cp.registry_path(dispatch_dir(base)), encoding="utf-8") as f:
            reg = json.load(f)
        import dplatform as P
        if not isinstance(reg, dict) or not isinstance(reg.get("sessions"), dict) or not P.pid_alive(reg.get("pid")):
            return []
    except Exception:
        return []
    out = []
    for key, info in reg["sessions"].items():
        if not isinstance(info, dict) or info.get("lifecycle") not in RUNNING_STATES:
            continue
        try:
            if project_root(info.get("cwd")) == root:
                out.append(key)
        except CpError:
            continue
    return sorted(out)


def restore(root, turn, force=False, only_clean=False, dry_run=False, note=True, sid="", base=None):
    sh = Shadow(root, base)
    busy = running_sessions(root, base)
    if busy and not dry_run:
        # the agent would keep working on files that changed under it, and its turn's after
        # snapshot would count the restore as its own changes
        raise CpError("running", _t("An agent is working in this project: wait until this round is done (or stop it) before going back", "Agent 正在这个项目里干活，等这一轮做完（或先打断）再回去"), sessions=busy)
    with sh.lock():
        data = sh.load()
        rec = _find(data, turn)
        if rec is None:
            raise CpError("no_such_turn", _t("No snapshot of this round: %s", "没有这一轮的快照：%s") % turn)
        now_tree = sh.snapshot()
        changes, conflicts, unsure = plan_restore(sh, data, rec, now_tree)
        if dry_run:
            return {"ok": True, "dry_run": True, "turn_id": rec["turn_id"], "files": changes, "conflicts": conflicts, "unsure": unsure, "running": busy}
        if conflicts and not force and not only_clean:
            return {"ok": False, "error": "conflict", "message": _t("These files changed again after this round, or it is not certain the agent made them: going back would overwrite or delete them", "这些文件在这一轮之后又被改过，或不确定是 Agent 建的，回去会盖掉或删掉它们"),
                    "turn_id": rec["turn_id"], "files": conflicts, "unsure": unsure, "changes": changes}
        skip = set(conflicts) if only_clean and not force else set()
        todo = [c for c in changes if c["path"] not in skip]
        # rollback_from: the present, so this restore can itself be undone
        rid = _new_id()
        sh.pin(now_tree, rid + "/before")
        write = [c["path"] for c in todo if c["action"] != "delete"]
        _write_back(sh, rec["before_tree"], write)
        deleted = [c["path"] for c in todo if c["action"] == "delete" and _delete(root, c["path"])]
        after = sh.snapshot()
        sh.pin(after, rid + "/after")
        restored = write
        data["turns"].append({"turn_id": rid, "kind": "restore", "sid": sid or rec.get("sid") or "", "message_id": "", "agent_turn_id": "",
                              "text": (_t("Back to before this round: ", "回到这一轮之前：") + (rec.get("text") or "").split("\n")[0])[:TEXT_KEEP], "ts": round(time.time(), 3),
                              "before_tree": now_tree, "after_tree": after, "after_ts": round(time.time(), 3),
                              "files_changed": sh.changes(now_tree, after), "restored_turn": rec["turn_id"]})
        sh.save(data)
    baselines = reset_baselines(root, restored + deleted, float(rec.get("ts") or 0), base)
    text = note_text(rec, restored, deleted)
    who = sid or rec.get("sid") or ""
    if note and who:
        try:
            add_note(who, text, base)
        except OSError:
            pass
    return {"ok": True, "turn_id": rec["turn_id"], "restored": restored, "deleted": deleted, "skipped": sorted(skip),
            "files": restored + deleted, "rollback_from": rid, "baselines_reset": baselines, "note": text, "sid": who}


def op_restore(root, a):
    if not a.turn:
        raise CpError("bad_request", _t("restore needs --turn <id>", "restore 要 --turn <id>"))
    return restore(root, a.turn, force=a.force, only_clean=a.only_clean, dry_run=a.dry_run, note=not a.no_note, sid=a.sid or "")


# ---------------------------------------------------------------- gc
def gc_project(d, now=None):
    """Keep the newest KEEP_TURNS records younger than KEEP_DAYS; drop the rest and their objects.
    A project with nothing left goes entirely. {"kept", "dropped", "removed"}."""
    now = now or time.time()
    try:
        with open(os.path.join(d, "ROOT"), encoding="utf-8") as f:
            root = f.read().strip()
    except OSError:
        root = ""
    turns_path = os.path.join(d, "turns.json")
    with _Lock(d):
        try:
            with open(turns_path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = {"turns": []}
        turns = [r for r in data.get("turns") or [] if isinstance(r, dict)]
        turns.sort(key=lambda r: r.get("ts") or 0)
        fresh = [r for r in turns if now - (r.get("ts") or 0) < KEEP_DAYS * 86400][-KEEP_TURNS:]
        dropped = [r for r in turns if r not in fresh]
        remove = not fresh or not root or not os.path.isdir(root)
        if not remove:
            return _gc_keep(d, root, turns_path, data, fresh, dropped)
    # removed after the lock is let go: Windows cannot delete the lock file while it is open
    _rmtree(d)
    return {"kept": 0, "dropped": len(turns), "removed": True}


def _gc_keep(d, root, turns_path, data, fresh, dropped):
    if not dropped:
        return {"kept": len(fresh), "dropped": 0, "removed": False}
    sh = Shadow(root)
    sh.dir, sh.git_dir, sh.index, sh.turns_path = d, os.path.join(d, "repo"), os.path.join(d, "index"), turns_path
    for r in dropped:
        for side in ("before", "after"):
            try:
                sh.git(["update-ref", "-d", "refs/cp/%s/%s" % (r.get("turn_id"), side)], ok=(0, 1))
            except CpError:
                pass
    data["turns"] = fresh
    _atomic_json(turns_path, data)
    try:
        sh.git(["prune", "--expire=now"], timeout=300)
    except CpError:
        pass
    return {"kept": len(fresh), "dropped": len(dropped), "removed": False}


def gc_all(base=None, force=False):
    """Every project, at most once per GC_EVERY (a stamp file); never raises."""
    top = checkpoints_dir(base)
    stamp = os.path.join(top, ".gc")
    try:
        if not force and time.time() - os.path.getmtime(stamp) < GC_EVERY:
            return {"ok": True, "skipped": True}
    except OSError:
        pass
    out = {"ok": True, "projects": {}}
    try:
        os.makedirs(top, exist_ok=True)
        with open(stamp, "w") as f:
            f.write(str(time.time()))
        for name in os.listdir(top):
            d = os.path.join(top, name)
            if name in ("notes",) or name.startswith(".") or not os.path.isdir(d):
                continue
            try:
                out["projects"][name] = gc_project(d)
            except Exception as e:
                out["projects"][name] = {"error": str(e)[:200]}
        nd = os.path.join(top, "notes")
        for name in os.listdir(nd) if os.path.isdir(nd) else []:
            p = os.path.join(nd, name)
            if time.time() - os.path.getmtime(p) > NOTE_TTL:
                os.remove(p)
    except OSError:
        pass
    return out


# ---------------------------------------------------------------- command line
class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise CpError("bad_request", message)


def parser():
    p = _Parser(prog="dispatch checkpoint", description="one snapshot per round (a shadow git that never touches the project's own .git), and going back to before a round")
    p.add_argument("op", choices=["list", "snapshot", "diff", "restore", "gc"])
    p.add_argument("--root", default=None, help="the project folder (default the current folder; the top of the repository inside a git repository)")
    p.add_argument("--sid", default="", help="chat session key claude-code:<id> / codex:<id>")
    p.add_argument("--turn", default="", help="a round's turn_id (a message_id or the agent's own turn id work too)")
    p.add_argument("--message-id", dest="message_id", default="")
    p.add_argument("--text", default="", help="snapshot: this round's message (shown in the list)")
    p.add_argument("--after", default="", help="snapshot: add the after snapshot of this round")
    p.add_argument("--from", dest="frm", default="")
    p.add_argument("--to", default="")
    p.add_argument("--patch", action="store_true", help="diff: include the patch itself")
    p.add_argument("--force", action="store_true", help="restore: go back for every file, conflicts included")
    p.add_argument("--only-clean", dest="only_clean", action="store_true", help="restore: only the files without conflicts")
    p.add_argument("--dry-run", dest="dry_run", action="store_true", help="restore: only list the files that would change and the conflicts")
    p.add_argument("--no-note", dest="no_note", action="store_true", help="restore: leave no note for the agent (the caller tells chatd itself)")
    p.add_argument("-n", type=int, default=KEEP_TURNS)
    p.add_argument("--json", action="store_true")
    return p


def run(argv):
    a = parser().parse_args(argv)
    if a.op == "gc":
        return gc_all(force=True)
    root = project_root(a.root or os.getcwd())
    return {"list": op_list, "snapshot": op_snapshot, "diff": op_diff, "restore": op_restore}[a.op](root, a)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        out = run(argv)
    except CpError as e:
        out = e.body()
    except Exception as e:
        out = {"ok": False, "error": "io", "message": "%s: %s" % (type(e).__name__, str(e)[:400])}
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
