# -*- coding: utf-8 -*-
"""Add a project by starting a new one or by copying one from the internet (the Agents window's "Add a project"
dialog; `dispatch projects-view new <name>` / `clone <address>` / `defaults`).

- `new_project(name, parent)`: makes `<parent>/<name>` (the parent defaults to ~/Projects), starts version history in
  it (git init) with one empty first commit so branches work from the start, and registers it.
- `clone_project(address, parent, name)`: copies a project from a web address (git clone) into `<parent>/<name>`
  (the name defaults to the last part of the address), reports progress in a file the window polls, and registers it.
- Every failure is a `ProjectError` with words for the person: what happened and what to do, never git's own text.

The error mapping and the way the first commit is made follow Orca's repo-creation-handlers.ts
(https://github.com/stablyai/orca, MIT, Copyright (c) 2026 Lovecast Inc.): a name cannot leave its parent folder,
an existing folder is reused only when it is empty, a half-made folder is removed again, and a missing git author
identity is its own message.
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

DEFAULT_PARENT = "~/Projects"
CLONE_TIMEOUT = 1800  # seconds for the whole copy
FIRST_COMMIT = "Initial commit"


class ProjectError(ValueError):
    """A project that was not made, in words for the person. `retry` says that asking again may work."""

    def __init__(self, message, retry=False, code=""):
        super().__init__(message)
        self.retry = retry
        self.code = code


# ---- where, what -----------------------------------------------------------------------------

def default_parent(home=None):
    return os.path.join(home or os.path.expanduser("~"), DEFAULT_PARENT[2:])


def resolve_parent(parent, home=None):
    """The folder the new project goes into: absolute, `~` expanded, the default when empty."""
    p = (parent or "").strip()
    if not p:
        return default_parent(home)
    if p == "~" or p.startswith("~/"):
        p = os.path.join(home or os.path.expanduser("~"), p[2:])
    p = os.path.normpath(p)
    if not os.path.isabs(p):
        raise ProjectError("Give the full path of the folder to save it in.", code="bad_parent")
    return p


def check_name(name):
    """The project name as it will be used for the folder, or a ProjectError saying what is wrong."""
    if re.search(r"[\x00-\x1f]", name or ""):
        raise ProjectError("A project name cannot contain slashes, colons or line breaks.", code="bad_name")
    n = " ".join((name or "").split())
    if not n:
        raise ProjectError("Give the project a name.", code="bad_name")
    if len(n) > 100:
        raise ProjectError("That name is too long. Use 100 characters or fewer.", code="bad_name")
    if re.search(r"[\\/:\x00-\x1f]", n):
        raise ProjectError("A project name cannot contain slashes, colons or line breaks.", code="bad_name")
    if n in (".", "..") or n.startswith("."):
        raise ProjectError("A project name cannot start with a dot.", code="bad_name")
    if n.startswith("-"):
        raise ProjectError("A project name cannot start with a dash.", code="bad_name")
    return n


def git_state(which=shutil.which, run=subprocess.run):
    """{"ok": True, "version"} when git works here, else {"ok": False, "message"}. On a Mac that never installed
    the developer tools /usr/bin/git is a stub that pops up an install window: it is not run then."""
    exe = which("git")
    if not exe:
        return {"ok": False, "message": MESSAGES["no_git"]}
    if exe == "/usr/bin/git" and sys.platform == "darwin":
        try:
            if run(["xcode-select", "-p"], capture_output=True, timeout=5).returncode != 0:
                return {"ok": False, "message": MESSAGES["no_git"]}
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        r = run([exe, "--version"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return {"ok": False, "message": MESSAGES["no_git"]}
    if r.returncode != 0:
        return {"ok": False, "message": MESSAGES["no_git"]}
    return {"ok": True, "version": (r.stdout or "").strip()}


MESSAGES = {
    "no_git": "This Mac does not have Git yet, which Dispatch needs to keep a project's history. "
              "Open Terminal, run xcode-select --install, wait for it to finish, then try again.",
    "not_found": "There is no project at that web address. Check the spelling, or copy the address again "
                 "from the project's page (on GitHub it is under the green Code button).",
    "no_access": "Could not open that project. Check the address. If it is private, sign in to GitHub (or GitLab) on this Mac "
                 "first (GitHub Desktop is the easy way), or set up an SSH key, then try again.",
    "offline": "Could not reach that address. Check your internet connection, and that the address is right.",
    "not_git": "That address is a web page, not a project. Copy the address from the project's page "
               "(on GitHub it is under the green Code button).",
    "disk_full": "There is not enough free space on this Mac to copy that project.",
    "no_write": "Dispatch is not allowed to save into that folder. Pick a different folder.",
    "no_identity": "Git needs your name and email before the project's history can start: they go on every commit. "
                   "Add them in Settings › Agents › Commits, then try again.",
}


# ---- web addresses ---------------------------------------------------------------------------

_SCP = re.compile(r"^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$")
_URL = re.compile(r"^(https?|ssh|git)://[^\s]+$", re.I)
_BARE_HOST = re.compile(r"^(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)/[^\s]+$", re.I)


def parse_address(text):
    """The address git can use, or a ProjectError. Accepts https://, ssh://, git@host:owner/name, a bare
    github.com/owner/name, and an absolute folder or file:// address (a project on this Mac)."""
    a = (text or "").strip()
    if not a:
        raise ProjectError("Paste the web address of the project.", code="bad_url")
    if a.startswith("-") or "::" in a or any(ord(c) < 32 for c in a):
        raise ProjectError("That does not look like a project address. It should start with https:// or git@.", code="bad_url")
    if _BARE_HOST.match(a):
        a = "https://" + a
    if _URL.match(a) or _SCP.match(a) or a.startswith("file://"):
        return a
    if os.path.isabs(a):
        return a
    raise ProjectError("That does not look like a project address. It should start with https:// or git@.", code="bad_url")


def address_name(address):
    """The folder name an address suggests: its last part without .git (https://github.com/octocat/Hello-World.git
    gives Hello-World)."""
    a = re.split(r"[?#]", (address or "").strip())[0].rstrip("/")
    last = re.split(r"[/:]", a)[-1] if a else ""
    if last.endswith(".git"):
        last = last[:-4]
    return last


def explain_clone_error(text):
    """git's error text turned into what happened and what to do."""
    t = (text or "").lower()
    pairs = (
        ("disk_full", ("no space left", "disk quota")),
        ("no_identity", ("please tell me who you are", "unable to auto-detect email")),
        ("no_access", ("authentication failed", "could not read username", "could not read password", "terminal prompts disabled",
                       "permission denied", "access denied", "http basic: access denied", "returned error: 403", "error: 403", "requested url returned error: 401")),
        ("offline", ("could not resolve host", "failed to connect", "network is unreachable", "timed out", "connection refused",
                     "connection reset", "operation too slow", "temporary failure in name resolution", "ssl certificate", "early eof", "remote end hung up")),
        ("not_found", ("repository not found", "not found", "does not exist", "returned error: 404", "error: 404", "could not read from remote repository")),
        ("not_git", ("does not appear to be a git repository", "not a git repository", "invalid gitfile")),
    )
    for key, needles in pairs:
        if any(n in t for n in needles):
            return MESSAGES[key]
    last = next((ln.strip() for ln in reversed((text or "").strip().splitlines()) if ln.strip()), "")
    last = re.sub(r"^(fatal|error): ", "", last)
    return "Copying the project did not work" + (f" ({last[:160]})" if last else "") + ". Check the address and try again."


# ---- the folder ------------------------------------------------------------------------------

def _prepare_target(parent, name):
    """`<parent>/<name>` ready to be filled: made when missing, reused when it is an empty folder. Returns
    (path, created)."""
    target = os.path.join(parent, name)
    try:
        os.makedirs(parent, exist_ok=True)
    except PermissionError:
        raise ProjectError(MESSAGES["no_write"], code="no_write")
    except OSError as e:
        raise ProjectError(f"Could not make the folder {parent}: {e.strerror or e}.", code="no_write")
    if os.path.exists(target):
        if not os.path.isdir(target):
            raise ProjectError(f"\"{name}\" already exists in {_tilde(parent)} and is a file, not a folder. Pick another name.", code="exists")
        if os.listdir(target):
            raise ProjectError(f"A folder called \"{name}\" already exists in {_tilde(parent)} and has files in it. "
                               "Pick another name, or use Choose a folder to add it as it is.", code="exists")
        return target, False
    try:
        os.mkdir(target)
    except PermissionError:
        raise ProjectError(MESSAGES["no_write"], code="no_write")
    except OSError as e:
        raise ProjectError(f"Could not make the folder: {e.strerror or e}.", code="no_write")
    return target, True


def _tilde(path):
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path == home or path.startswith(home + os.sep) else path


def _git_env():
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"  # a missing sign-in is an error, not a prompt nobody can see
    env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new")
    env["LC_ALL"] = "C"  # git's messages in English, so explain_clone_error can read them
    return env


def _git(args, cwd, timeout=30):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=timeout, env=_git_env())


def _first_commit(folder):
    """git init and one empty commit (a branch needs a commit to exist: worktrees and sessions start from it).
    A Mac where git has no name and email for the person yet gets no made-up one (it was "Dispatch
    <dispatch@localhost>", which agents then copied, task-pog4t): ProjectError no_identity, and the window asks the
    person for theirs (`dispatch git-identity set`) and tries again."""
    r = _git(["init", "-q", "-b", "main"], folder)
    if r.returncode != 0:  # git older than 2.28 has no -b
        r = _git(["init", "-q"], folder)
    if r.returncode != 0:
        why = ((r.stderr or r.stdout).strip().splitlines() or [""])[-1][:160]
        raise ProjectError("Could not start the project's history" + (f": {why}" if why else "") + ".", code="git_init")
    r = _git(["commit", "-q", "--allow-empty", "-m", FIRST_COMMIT], folder)
    if r.returncode != 0 and re.search(r"tell me who you are|user\.name|user\.email|empty ident|no email was given|auto-detection is disabled", r.stderr or "", re.I):
        raise ProjectError(MESSAGES["no_identity"], code="no_identity")
    if r.returncode != 0:
        raise ProjectError("Could not save the first step of the project: " + ((r.stderr or r.stdout).strip().splitlines() or [""])[-1][:160], code="git_commit")


def _discard(path, created):
    """Take a half-made folder away again: the whole folder when this call made it, else only what was put in it."""
    try:
        if created:
            shutil.rmtree(path, ignore_errors=True)
        else:
            shutil.rmtree(os.path.join(path, ".git"), ignore_errors=True)
    except OSError:
        pass


# ---- new, clone ------------------------------------------------------------------------------

def defaults(home=None):
    """What the dialog starts from: this Mac's home, the folder new projects go into, whether git works."""
    home = home or os.path.expanduser("~")
    parent = default_parent(home)
    return {"ok": True, "home": home, "parent": parent, "parent_exists": os.path.isdir(parent), "git": git_state()}


def new_project(name, parent, register, ensure_board=None):
    """Make `<parent>/<name>` with git history, register it, return the registry row. `register(folder, name)` is
    projects_view.register; `ensure_board()` makes the task board first, so a board that cannot be made leaves
    the disk alone."""
    n = check_name(name)
    g = git_state()
    if not g["ok"]:
        raise ProjectError(g["message"], code="no_git")
    p = resolve_parent(parent)
    if ensure_board:
        ensure_board()
    target, created = _prepare_target(p, n)
    try:
        _first_commit(target)
    except BaseException:
        _discard(target, created)
        raise
    try:
        row = register(target, n)
    except BaseException:
        _discard(target, created)
        raise
    return dict(row, created=True, folder=target)


class Progress:
    """The copy's progress as a small JSON file the window reads while the copy runs."""

    PHASES = (("Counting objects", "Getting ready", 0, 5), ("Compressing objects", "Getting ready", 0, 5),
              ("Receiving objects", "Downloading files", 5, 85), ("Resolving deltas", "Putting the files together", 85, 95),
              ("Updating files", "Setting up the folder", 95, 100), ("Checking out files", "Setting up the folder", 95, 100))

    def __init__(self, path):
        self.path = path
        self.last = 0.0
        self.state = {"state": "running", "phase": "Connecting", "percent": 0, "detail": ""}
        self.write(force=True)

    def write(self, force=False, **fields):
        # a new phase or percent is written at once (at most a hundred per phase); only the speed text in
        # between waits. Before 10-07 a percent that came within 0.15 s of the start was dropped, and the
        # window showed "Connecting" until git said more, or until the end when it was stuck
        moved = any(k in ("phase", "percent", "state") and self.state.get(k) != v for k, v in fields.items())
        self.state.update(fields)
        now = time.time()
        if not self.path or (not force and not moved and now - self.last < 0.15):
            return
        self.last = now
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.state, f)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def line(self, text):
        """One of git's progress lines: `Receiving objects:  43% (130/300), 1.2 MiB | 2.3 MiB/s`."""
        m = re.match(r"^(?:remote: )?([A-Za-z ]+?):\s+(\d+)%(?: \((\d+)/(\d+)\))?(?:, (.*?))?(?:, done\.)?$", text.strip())
        if not m:
            return
        for key, phrase, lo, hi in self.PHASES:
            if m.group(1) == key:
                pct = int(m.group(2))
                self.write(phase=phrase, percent=round(lo + (hi - lo) * pct / 100), detail=re.sub(r"(,\s*)?done\.$", "", m.group(5) or "").strip())
                return


def clone_project(address, parent, name, register, ensure_board=None, progress_file=None):
    """Copy the project at `address` into `<parent>/<name>` (name: the last part of the address), register it,
    return the registry row. SIGTERM stops the copy and removes what it made."""
    url = parse_address(address)
    n = check_name(name or address_name(url))
    g = git_state()
    if not g["ok"]:
        raise ProjectError(g["message"], code="no_git")
    p = resolve_parent(parent)
    if ensure_board:
        ensure_board()
    target, created = _prepare_target(p, n)
    progress = Progress(progress_file)
    proc = None
    stopped = threading.Event()
    old = None

    def stop(signum, frame):
        stopped.set()
        if proc and proc.poll() is None:
            proc.terminate()

    if threading.current_thread() is threading.main_thread():
        old = signal.signal(signal.SIGTERM, stop)
    tail = []
    try:
        proc = subprocess.Popen(
            ["git", "-c", "protocol.ext.allow=never", "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60",
             "clone", "--progress", "--", url, target],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=_git_env())
        deadline = time.time() + CLONE_TIMEOUT
        buf = b""
        while True:
            chunk = proc.stderr.read1(4096) if hasattr(proc.stderr, "read1") else proc.stderr.read(4096)
            if not chunk:
                break
            buf += chunk
            parts = re.split(rb"[\r\n]", buf)
            buf = parts.pop()
            for raw in parts:
                text = raw.decode("utf-8", "replace")
                if text.strip():
                    tail.append(text)
                    del tail[:-12]
                    progress.line(text)
            if time.time() > deadline:
                proc.terminate()
                stopped.set()
        if buf.strip():
            tail.append(buf.decode("utf-8", "replace"))
        code = proc.wait()
    except OSError as e:
        _discard(target, created)
        progress.write(force=True, state="failed")
        raise ProjectError(MESSAGES["no_git"] if e.errno == 2 else f"Could not start the copy: {e.strerror or e}.", code="no_git")
    finally:
        if old is not None:
            signal.signal(signal.SIGTERM, old)
    if stopped.is_set():
        _discard(target, created)
        progress.write(force=True, state="failed")
        raise ProjectError("The copy was stopped.", code="cancelled")
    if code != 0:
        _discard(target, created)
        progress.write(force=True, state="failed")
        raise ProjectError(explain_clone_error("\n".join(tail)), retry=True, code="clone_failed")
    progress.write(force=True, phase="Adding it to your projects", percent=99)
    try:
        row = register(target, n)
    except BaseException:
        _discard(target, created)
        progress.write(force=True, state="failed")
        raise
    progress.write(force=True, state="done", phase="Done", percent=100)
    return dict(row, created=True, folder=target, source=url)
