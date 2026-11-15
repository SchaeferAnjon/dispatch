# -*- coding: utf-8 -*-
"""One place for the copies Dispatch keeps before it changes a file: ~/.dispatch/backups/<date>/<path from home>.

    dispatch backups [list] [--json]        what is kept, by day
    dispatch backups prune [--days N]       remove days older than N (default 30)

Never beside the file (no `.bak`, `.orig` or dated copies next to it). A file that git already holds, unchanged
since its last commit, gets no copy: git is the backup. A second, different copy of the same file on the same day
goes to <date>/<HHMMSS>/<path>, so restoring is always "copy it back to the same path under home".

Only the day folders (YYYY-MM-DD) are pruned. The older areas (backups/agents, backups/hosts, backups/preferences,
backups/skills) are undo data of their own commands, and backups/legacy-<date> holds stray copies moved in by hand;
neither is touched here.
"""
import datetime
import filecmp
import json
import os
import re
import shutil
import subprocess
import sys

import dispatch_dir as DD

KEEP_DAYS = 30
DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
OUTSIDE_HOME = "_outside-home"


def root():
    return DD.path("backups")


def _home():
    return DD.home()


def relative(path, home=None):
    """Where a path goes under a day folder: its path from home, or _outside-home/<absolute path>."""
    home = os.path.realpath(home or _home())
    p = os.path.abspath(os.path.expanduser(path))
    # the folder resolved, not the file: a link is kept as the link it is, at its own place
    p = os.path.join(os.path.realpath(os.path.dirname(p)), os.path.basename(p))
    if p == home or p.startswith(home.rstrip(os.sep) + os.sep):
        return os.path.relpath(p, home)
    return os.path.join(OUTSIDE_HOME, p.lstrip(os.sep))


def in_git_unchanged(path):
    """True when git tracks the file and it has no change since the last commit (git can give it back)."""
    p = os.path.realpath(path)
    if not os.path.isfile(p):
        return False
    d = os.path.dirname(p)
    try:
        r = subprocess.run(["git", "-C", d, "status", "--porcelain", "--ignored", "--", p],
                           capture_output=True, text=True, timeout=10)
        if r.returncode != 0 or r.stdout.strip():
            return False  # not a repository, or the file is new, changed or ignored
        r = subprocess.run(["git", "-C", d, "ls-files", "--error-unmatch", "--", p], capture_output=True, text=True, timeout=10)
        return r.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _same(a, b):
    try:
        if os.path.isdir(a) and os.path.isdir(b):
            c = filecmp.dircmp(a, b)
            return not (c.diff_files or c.left_only or c.right_only)
        return os.path.isfile(a) and os.path.isfile(b) and filecmp.cmp(a, b, shallow=False)
    except OSError:
        return False


def _destination(path, now, home):
    rel = relative(path, home)
    first = os.path.join(root(), f"{now:%Y-%m-%d}", rel)
    if not os.path.lexists(first) or _same(path, first):
        return first
    return os.path.join(root(), f"{now:%Y-%m-%d}", f"{now:%H%M%S}", rel)


def save(path, move=False, home=None, now=None, daily=False):
    """Keep a copy of `path` (a file, a folder or a link) before it is changed; with `move`, move it there instead
    (the caller is about to put something new in its place). `daily`: one copy a day is enough (a file Dispatch
    rewrites part of, like the managed block in each agent's rules file: the first copy of the day keeps what was
    there before). Returns where it went, or "" when nothing was kept: the path does not exist, or (copy only) git
    holds it unchanged."""
    if not os.path.lexists(path):
        return ""
    if not move and in_git_unchanged(path):
        return ""
    now = now or datetime.datetime.now()
    first = os.path.join(root(), f"{now:%Y-%m-%d}", relative(path, home))
    if daily and not move and os.path.lexists(first):
        return first
    dst = _destination(path, now, home)
    if os.path.lexists(dst):
        if not move and _same(path, dst):
            prune()
            return dst  # the same content is already kept today
        dst = os.path.join(root(), f"{now:%Y-%m-%d}", f"{now:%H%M%S-%f}", relative(path, home))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if move:
        shutil.move(path, dst)
    elif os.path.islink(path):
        os.symlink(os.readlink(path), dst)
    elif os.path.isdir(path):
        shutil.copytree(path, dst, symlinks=True)
    else:
        shutil.copy2(path, dst)
    prune()
    return dst


def days():
    """[(day, path)] of the day folders, oldest first."""
    try:
        names = sorted(n for n in os.listdir(root()) if DAY.match(n))
    except OSError:
        return []
    return [(n, os.path.join(root(), n)) for n in names]


def prune(keep_days=KEEP_DAYS, today=None):
    """Remove day folders older than `keep_days`. Returns the days removed."""
    today = today or datetime.date.today()
    cutoff = today - datetime.timedelta(days=keep_days)
    gone = []
    for name, p in days():
        try:
            day = datetime.date.fromisoformat(name)
        except ValueError:
            continue
        if day < cutoff:
            shutil.rmtree(p, ignore_errors=True)
            gone.append(name)
    return gone


def listing():
    out = []
    for name, p in days():
        files = [os.path.relpath(os.path.join(dp, f), p) for dp, _, fs in os.walk(p) for f in fs]
        out.append({"day": name, "path": p, "files": sorted(files)})
    others = []
    try:
        others = sorted(n for n in os.listdir(root()) if not DAY.match(n) and not n.startswith("."))
    except OSError:
        pass
    return {"root": root(), "keep_days": KEEP_DAYS, "days": out, "other": others}


def command(a):
    op = getattr(a, "op", None) or "list"
    if op == "prune":
        gone = prune(a.days if a.days is not None else KEEP_DAYS)
        if a.json:
            print(json.dumps({"ok": True, "removed": gone}))
        else:
            print(f"removed {len(gone)} day(s): {', '.join(gone)}" if gone else "nothing older than the limit")
        return
    d = listing()
    if a.json:
        print(json.dumps(d, ensure_ascii=False, indent=2))
        return
    h = _home()
    print(d["root"].replace(h, "~", 1) + f"  (day folders are kept {d['keep_days']} days)")
    for x in d["days"]:
        print(f"  {x['day']}  {len(x['files'])} file(s)")
    for n in d["other"]:
        print(f"  {n}/")
    if not d["days"] and not d["other"]:
        print("  (empty)")


def add_parser(sub):
    s = sub.add_parser("backups", help="copies Dispatch keeps before it changes one of your files (~/.dispatch/backups/<date>/): list | prune [--days N]")
    s.add_argument("op", nargs="?", default="list", choices=["list", "prune"])
    s.add_argument("--days", type=int, default=None, help=f"prune: keep this many days (default {KEEP_DAYS})")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=command)
    return s


if __name__ == "__main__":
    sys.exit("run through `dispatch backups`")
