# -*- coding: utf-8 -*-
"""`dispatch worktree busy | mark | land`: a session works in the project folder, and gets a copy of its own only
while another agent is working there; that copy goes back into the folder by itself when the session is done
(task-lj06.16, the person's choice of 2026-10-07: "default: change the project folder directly").

  worktree busy <folder> [--not-under PID] [--json]   agents working in this folder right now (and git: whether a copy
                                                      can be made, branch: the branch it starts from): agent processes
                                                      (claude, codex, opencode, …, the engines' own names) whose
                                                      working folder is it or one inside it, leaving out the
                                                      processes under PID (the Agents window's agent host counts
                                                      its own sessions itself)
  worktree mark <copy> --into <branch> [--json]       this copy goes back into <branch> of the project folder on
                                                      its own (recorded in git: branch.<copy branch>.dispatchLandInto)
  worktree land <copy> [--message M] [--json]         bring a marked copy back: what the agent left uncommitted is
                                                      committed first, then the copy's branch is merged into the
                                                      project folder. A copy that is not marked is only looked at
                                                      (state "manual": how many commits and whether files changed)

`land` never leaves the project folder half merged: overlapping changes are found before anything is written
(`git merge-tree`), and a merge git refuses (the folder has unsaved changes in the same files, or something is
staged there) changes nothing. Its answer, `state`:

  landed          the changes are in the project folder now (files: what changed there)
  nothing         nothing to bring back
  conflict        the copy and the project folder changed the same lines (files: which); nothing was written
  folder_changes  the project folder has unsaved changes in files the copy changed too (files); nothing was written
  folder_busy     the project folder is in the middle of something (a merge, a commit, staged files); try later
  other_branch    the project folder is on another branch than the one the copy came from
  manual          a copy the person picked themselves: it waits for Merge Changes (ahead, dirty)
  not_copy        the folder is the project folder (or a folder inside it), not a copy: nothing to do
  error           anything else (message)
"""
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

MARK = "dispatchLandInto"
GIT_ENV = {"GIT_MERGE_AUTOEDIT": "no", "GIT_EDITOR": ":", "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"}


def git(cwd, *args, timeout=60):
    """(returncode, stdout, stderr); (127, '', why) when git cannot run."""
    try:
        r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=timeout,
                           env={**os.environ, **GIT_ENV})
    except (OSError, subprocess.TimeoutExpired) as e:
        return 127, "", str(e)
    return r.returncode, r.stdout, r.stderr


def out(cwd, *args):
    code, so, _ = git(cwd, *args)
    return so.strip() if code == 0 else ""


def main_checkout(folder):
    import copy_ready
    return copy_ready.main_checkout(folder)


def branch_of(folder):
    return out(folder, "symbolic-ref", "--quiet", "--short", "HEAD")


def landing_branch(copy):
    b = branch_of(copy)
    return out(copy, "config", "--get", f"branch.{b}.{MARK}") if b else ""


# ---- busy ---------------------------------------------------------------------------------------------

def _inside(path, folder):
    path, folder = os.path.realpath(path), os.path.realpath(folder)
    return path == folder or path.startswith(folder.rstrip(os.sep) + os.sep)


def processes(run=subprocess.run):
    """[(pid, ppid, name)] of every process, name being the executable's own name (`ps -c`)."""
    try:
        text = run(["ps", "-ax", "-c", "-o", "pid=,ppid=,comm="], capture_output=True, text=True, timeout=10).stdout or ""
    except (OSError, subprocess.TimeoutExpired):
        return []
    rows = []
    for line in text.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            rows.append((int(parts[0]), int(parts[1]), parts[2].strip()))
    return rows


def working_folders(pids, run=subprocess.run):
    """{pid: its working folder}, from lsof (macOS has no /proc)."""
    if not pids:
        return {}
    try:
        text = run(["lsof", "-a", "-d", "cwd", "-p", ",".join(str(p) for p in pids), "-Fpn"],
                   capture_output=True, text=True, timeout=10).stdout or ""
    except (OSError, subprocess.TimeoutExpired):
        return {}
    res, pid = {}, None
    for line in text.splitlines():
        if line.startswith("p") and line[1:].isdigit():
            pid = int(line[1:])
        elif line.startswith("n") and pid is not None:
            res[pid] = line[1:]
    return res


def under(pid, root, parents):
    seen = set()
    while pid and pid not in seen:
        if pid == root:
            return True
        seen.add(pid)
        pid = parents.get(pid)
    return False


def agent_names():
    try:
        import busy
        return busy.agent_names()
    except Exception:
        return {"claude", "codex", "opencode", "gemini", "aider", "goose", "amp", "cursor-agent", "qwen", "crush"}


def busy(folder, not_under=0, run=subprocess.run, names=None):
    """The agent processes working in `folder` now, not counting those under `not_under`."""
    names = names if names is not None else agent_names()
    rows = processes(run)
    parents = {pid: ppid for pid, ppid, _ in rows}
    me = os.getpid()
    agents = [(pid, name) for pid, _, name in rows if name in names and pid != me
              and not (not_under and under(pid, not_under, parents))]
    cwd = working_folders([p for p, _ in agents], run)
    hits = [{"pid": pid, "name": name, "cwd": cwd[pid]} for pid, name in agents if pid in cwd and _inside(cwd[pid], folder)]
    has_commit = bool(out(folder, "rev-parse", "--verify", "-q", "HEAD")) if os.path.isdir(folder) else False
    return {"ok": True, "folder": os.path.realpath(folder), "busy": bool(hits), "agents": hits,
            "git": has_commit, "branch": branch_of(folder) if has_commit else ""}


# ---- mark and land ------------------------------------------------------------------------------------

def mark(copy, into):
    b = branch_of(copy)
    if not b:
        return {"ok": False, "state": "error", "message": "This copy is not on a branch."}
    if not into:
        return {"ok": False, "state": "error", "message": "Say which branch it goes back into (--into)."}
    code, _, err = git(copy, "config", f"branch.{b}.{MARK}", into)
    if code:
        return {"ok": False, "state": "error", "message": err.strip() or "git config failed"}
    return {"ok": True, "copy": os.path.realpath(copy), "branch": b, "into": into}


def dirty(folder):
    code, so, _ = git(folder, "status", "--porcelain", "--untracked-files=normal")
    return code == 0 and bool(so.strip())


def commit_leftovers(copy, message):
    """What the agent left uncommitted in the copy, committed. (ok, why)."""
    if not dirty(copy):
        return True, ""
    code, _, err = git(copy, "add", "-A")
    if code:
        return False, err.strip()
    code, so, err = git(copy, "commit", "-q", "-m", message or "Changes from the agent")
    if code:
        return False, (err or so).strip()
    return True, ""


def overwritten_files(text):
    """The files git lists under "would be overwritten by merge" / "untracked working tree files would be …"."""
    files, inside = [], False
    for line in (text or "").splitlines():
        if "would be overwritten" in line or "would be removed" in line:
            inside = True
            continue
        if inside:
            if line.startswith(("\t", "    ")) and line.strip():
                files.append(line.strip())
            else:
                inside = False
    return files


def merge_tree_conflicts(main, branch):
    """None: the merge is clean; [files]: they conflict; 'unknown' when this git cannot say (older than 2.38)."""
    code, so, _ = git(main, "merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", branch)
    if code == 0:
        return None
    if code == 1:
        lines = [x.strip() for x in so.splitlines()[1:] if x.strip()]
        return sorted(set(lines)) or ["(unknown)"]
    return "unknown"


def in_progress(main):
    gitdir = out(main, "rev-parse", "--path-format=absolute", "--git-dir")
    return any(os.path.exists(os.path.join(gitdir, n)) for n in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "index.lock")) if gitdir else False


def land(copy, message="", force=False):
    copy = os.path.realpath(copy)
    main = main_checkout(copy)
    top = os.path.realpath(out(copy, "rev-parse", "--show-toplevel") or copy)
    if not main or top == main:
        return {"ok": True, "state": "not_copy", "message": "This is the project folder, not a separate copy of it."}
    copy = top
    branch = branch_of(copy)
    if not branch:
        return {"ok": False, "state": "error", "message": "The copy is not on a branch.", "main": main}
    into = landing_branch(copy)
    base = {"main": main, "copy": copy, "branch": branch, "into": into}
    if not into and not force:
        target = branch_of(main)
        ahead = int(out(main, "rev-list", "--count", f"{target or 'HEAD'}..{branch}") or 0)
        return {"ok": True, "state": "manual", **base, "into": target, "ahead": ahead, "dirty": dirty(copy)}
    into = into or branch_of(main)
    ok, why = commit_leftovers(copy, message)
    if not ok:
        return {"ok": False, "state": "error", **base, "message": f"Could not save the copy's changes: {why}"}
    current = branch_of(main)
    if current != into:
        return {"ok": False, "state": "other_branch", **base, "folder_branch": current}
    ahead = int(out(main, "rev-list", "--count", f"HEAD..{branch}") or 0)
    if not ahead:
        return {"ok": True, "state": "nothing", **base}
    if in_progress(main):
        return {"ok": False, "state": "folder_busy", **base, "message": "The project folder is in the middle of a merge or a commit."}
    clash = merge_tree_conflicts(main, branch)
    if isinstance(clash, list):
        return {"ok": False, "state": "conflict", **base, "files": clash, "ahead": ahead}
    if git(main, "diff", "--cached", "--quiet")[0] == 1:
        return {"ok": False, "state": "folder_busy", **base, "message": "Something is staged in the project folder."}
    before = out(main, "rev-parse", "HEAD")
    code, so, err = git(main, "merge", "--no-edit", branch, timeout=300)
    text = (so + "\n" + err).strip()
    if code == 0:
        after = out(main, "rev-parse", "HEAD")
        files = [x for x in out(main, "diff", "--name-only", before, after).splitlines() if x]
        return {"ok": True, "state": "landed", **base, "head": after, "files": files, "commits": ahead}
    if out(main, "rev-parse", "-q", "--verify", "MERGE_HEAD"):
        files = [x for x in out(main, "diff", "--name-only", "--diff-filter=U").splitlines() if x]
        git(main, "merge", "--abort")
        return {"ok": False, "state": "conflict", **base, "files": files, "ahead": ahead}
    over = overwritten_files(text)
    if over:
        return {"ok": False, "state": "folder_changes", **base, "files": over}
    if "index.lock" in text:
        return {"ok": False, "state": "folder_busy", **base, "message": "Another git command is running in the project folder."}
    return {"ok": False, "state": "error", **base, "message": text[-600:] or "git merge failed"}


# ---- the command --------------------------------------------------------------------------------------

def command(a):
    if a.op == "busy":
        res = busy(a.folder, int(getattr(a, "not_under", 0) or 0))
    elif a.op == "mark":
        res = mark(a.folder, getattr(a, "into", "") or "")
    else:
        res = land(a.folder, getattr(a, "message", "") or "", force=bool(getattr(a, "force", False)))
    if a.json:
        print(json.dumps(res, ensure_ascii=False))
    elif a.op == "busy":
        print("\n".join(f"{x['name']} (pid {x['pid']}) in {x['cwd']}" for x in res["agents"]) or "No other agent works in this folder.")
    else:
        print(res.get("message") or res["state"] + (": " + ", ".join(res.get("files", [])) if res.get("files") else ""))
    return 0 if res.get("ok") or res.get("state") in ("conflict", "folder_changes", "folder_busy", "other_branch") else 1
