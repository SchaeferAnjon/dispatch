# -*- coding: utf-8 -*-
"""`dispatch editor <op> --root <dir> [--sid <session key>] … --json`: the agent hunks the
dispatch-bridge extension paints in Dispatch IDE, and opening a folder in VS Code / Cursor.

Always exits 0 and prints one JSON object: `{"ok": true, …}` or `{"ok": false, "error": <code>,
"message": …}`. Every path the caller sends is confined to the realpath of --root; every path
printed is root-relative with forward slashes ("" is the root itself).

Agent hunks: chatd calls capture_baseline() before an edit tool runs and repair_baseline() after
it, so each file an agent touches has a snapshot of how it looked before the agent's first edit
(DISPATCH_DIR/editor/<sid with ":" as "__">/baseline/<rel> plus index.json). `hunks` diffs that
snapshot against the disk; `accept` moves a hunk into the snapshot, `undo` writes the snapshot's
lines back to the disk, `fold` keeps the person's own saves out of the agent's hunks. Hunk `index`
is 1-based.
"""
import argparse
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
sys.dont_write_bytecode = True

IS_WIN = os.name == "nt"
TEXT_LIMIT = 2 * 1024 * 1024
SNIFF = 8192
FOLD_FUZZ = 20
FOLD_CONTEXT = 3
ERROR_CODES = ("outside_root", "not_found", "too_large", "binary", "conflict", "bad_hunk", "no_baseline", "io", "bad_request", "unsupported")

APPS = (("code", "VS Code", "Visual Studio Code.app"), ("cursor", "Cursor", "Cursor.app"))


class EdError(Exception):
    def __init__(self, code, message, **extra):
        super().__init__(message)
        self.code = code if code in ERROR_CODES else "io"
        self.message = message
        self.extra = extra

    def body(self):
        b = {"ok": False, "error": self.code, "message": self.message}
        b.update({k: v for k, v in self.extra.items() if v is not None})
        return b


# ---------------------------------------------------------------- paths
def _slash(p):
    return (p or "").replace("\\", "/")


def _norm(p):
    return os.path.normcase(os.path.normpath(p))


def _under(p, root):
    p, root = _norm(p), _norm(root)
    if p == root:
        return True
    return p.startswith(root.rstrip(os.sep) + os.sep)


def _rel(full, root):
    r = os.path.relpath(full, root)
    return "" if r == "." else _slash(r)


def open_root(root):
    if not root:
        raise EdError("bad_request", "--root is required")
    r = os.path.realpath(os.path.expanduser(root))
    if not os.path.isdir(r):
        raise EdError("outside_root", f"not a directory: {root}")
    return r


def resolve(root, p):
    """(full, rel) of `p` inside `root` (already a realpath). `full` keeps the last component as
    named (a symlink stays a symlink for rename / delete); both it and its realpath must lie in root."""
    p = p or ""
    if IS_WIN:
        p = p.replace("/", "\\")
    if p in ("", "."):
        return root, ""
    full = os.path.normpath(p if os.path.isabs(p) else os.path.join(root, p))
    head, tail = os.path.split(full)
    if head:
        full = os.path.join(os.path.realpath(head), tail) if tail else os.path.realpath(head)
    if not _under(full, root):
        raise EdError("outside_root", f"{p} is outside the project")
    if not _under(os.path.realpath(full), root):
        raise EdError("outside_root", f"{p} points outside the project")
    return full, _rel(full, root)


def sha1(b):
    return hashlib.sha1(b).hexdigest()


def is_binary(raw):
    if b"\0" in raw[:SNIFF]:
        return True
    try:
        raw.decode("utf-8")
        return False
    except UnicodeDecodeError:
        return True


def _read_bytes(full, limit):
    with open(full, "rb") as f:
        return f.read(limit + 1)


def atomic_write(full, data, like=None):
    """Temp file next to `full` + os.replace; keeps the mode bits of `like` (the file replaced)."""
    d = os.path.dirname(full) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix="." + os.path.basename(full) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        src = like or full
        if os.path.exists(src):
            try:
                shutil.copymode(src, tmp)
            except OSError:
                pass
        os.replace(tmp, full)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------- agent baselines
def dispatch_dir():
    return os.environ.get("DISPATCH_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".dispatch")


def _check_sid(sid):
    if not sid:
        raise EdError("bad_request", "--sid is required")
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        if here not in sys.path:
            sys.path.insert(0, here)
        import chat_protocol as cp
        cp.split_key(sid)
    except ImportError:
        pass
    except Exception as e:
        raise EdError("bad_request", str(getattr(e, "message", "") or e))
    if "/" in sid or "\\" in sid or ".." in sid:
        raise EdError("bad_request", f"invalid session key {sid!r}")
    return sid


def sid_dir(sid, base=None):
    return os.path.join(base or dispatch_dir(), "editor", sid.replace(":", "__"))


class _Lock:
    """Serialises index.json updates between chatd and the page's CLI calls (flock where it exists)."""

    def __init__(self, d):
        self.d, self.f = d, None

    def __enter__(self):
        os.makedirs(self.d, exist_ok=True)
        try:
            import fcntl
            self.f = open(os.path.join(self.d, ".lock"), "a")
            fcntl.flock(self.f.fileno(), fcntl.LOCK_EX)
        except (ImportError, OSError):
            self.f = None
        return self

    def __exit__(self, *exc):
        if self.f:
            try:
                import fcntl
                fcntl.flock(self.f.fileno(), fcntl.LOCK_UN)
            except (ImportError, OSError):
                pass
            self.f.close()


class Store:
    def __init__(self, sid, base=None):
        self.sid = sid
        self.dir = sid_dir(sid, base)
        self.index_path = os.path.join(self.dir, "index.json")

    def load(self):
        try:
            with open(self.index_path, encoding="utf-8") as f:
                idx = json.load(f)
            if isinstance(idx, dict) and isinstance(idx.get("files"), dict) and isinstance(idx.get("root"), str):
                return idx
        except (OSError, ValueError):
            pass
        return None

    def save(self, idx):
        atomic_write(self.index_path, json.dumps(idx, ensure_ascii=False, indent=1).encode("utf-8"))

    def key_of(self, idx, full):
        """The index key of an absolute path, or None when it lies outside this session's root."""
        iroot = idx["root"] if idx else None
        if not iroot:
            return None
        iroot = iroot.replace("/", os.sep) if IS_WIN else iroot
        if not _under(full, iroot):
            return None
        return _rel(full, iroot)

    def snap_path(self, key):
        return os.path.join(self.dir, "baseline", *key.split("/"))

    def base_text(self, idx, key):
        p = self.snap_path(key)
        if os.path.isfile(p):
            with open(p, "rb") as f:
                return f.read().decode("utf-8", "replace")
        return ""

    def set_base(self, idx, key, text):
        atomic_write(self.snap_path(key), text.encode("utf-8"))

    def drop_base(self, key):
        try:
            os.remove(self.snap_path(key))
        except OSError:
            pass


def _disk_text(full):
    """(text, raw) of the file on disk; ("", b"") when missing; None text for binary / too large."""
    if not os.path.isfile(full):
        return "", b""
    raw = _read_bytes(full, TEXT_LIMIT)
    if len(raw) > TEXT_LIMIT or is_binary(raw):
        return None, raw
    return raw.decode("utf-8"), raw


def capture(sid, root, full, base=None):
    """Snapshot `full` for `sid` unless it already has one. True when a snapshot was taken."""
    st = Store(sid, base)
    with _Lock(st.dir):
        idx = st.load() or {"root": _slash(root) if IS_WIN else root, "files": {}}
        key = st.key_of(idx, full)
        if key is None or not key or key in idx["files"]:
            return False
        if os.path.isdir(full):
            return False
        if os.path.isfile(full):
            text, raw = _disk_text(full)
            if text is None:
                return False
            st.set_base(idx, key, text)
            idx["files"][key] = {"captured_at": round(time.time(), 3), "existed": True, "sha1": sha1(raw), "fresh": True}
        else:
            idx["files"][key] = {"captured_at": round(time.time(), 3), "existed": False, "sha1": "", "fresh": True}
        st.save(idx)
        return True


def _log(msg, base=None):
    try:
        d = os.path.join(base or dispatch_dir(), "editor")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "errors.log"), "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def _abs_in(cwd, p):
    if not isinstance(p, str) or not p:
        return None
    full = os.path.normpath(p if os.path.isabs(p) else os.path.join(cwd, p))
    head, tail = os.path.split(full)
    full = os.path.join(os.path.realpath(head), tail) if tail else os.path.realpath(full)
    return full if _under(full, cwd) and _under(os.path.realpath(full), cwd) else None


def capture_baseline(sid, cwd, paths, dispatch_dir=None):
    """chatd, before emitting tool_start of an edit tool: snapshot each path under cwd that has no
    snapshot yet. Never raises."""
    n = 0
    try:
        root = os.path.realpath(cwd)
        for p in paths or []:
            try:
                full = _abs_in(root, p)
                if full and capture(sid, root, full, dispatch_dir):
                    n += 1
            except Exception as e:
                _log("capture %s %s: %s" % (sid, p, e), dispatch_dir)
    except Exception as e:
        _log("capture %s: %s" % (sid, e), dispatch_dir)
    return n


def repair_baseline(sid, cwd, diff, dispatch_dir=None):
    """chatd, after tool_end carrying a diff: fix a snapshot taken after the agent already wrote.
    Edit: the snapshot lacks `old` but holds `new` exactly once → put `old` back. Write: the fresh
    snapshot equals what the agent wrote → the file did not exist before. Once per snapshot; never raises."""
    try:
        if not isinstance(diff, dict):
            return False
        root = os.path.realpath(cwd)
        full = _abs_in(root, diff.get("path"))
        if not full:
            return False
        st = Store(sid, dispatch_dir)
        with _Lock(st.dir):
            idx = st.load()
            key = st.key_of(idx, full) if idx else None
            ent = idx["files"].get(key) if key else None
            if not ent or not ent.get("fresh"):
                return False
            ent["fresh"] = False
            changed = False
            kind, old, new = diff.get("kind"), diff.get("old") or "", diff.get("new") or ""
            if kind == "edit" and ent.get("existed") and old and new and old != new:
                text = st.base_text(idx, key)
                if old not in text and text.count(new) == 1:
                    st.set_base(idx, key, text.replace(new, old, 1))
                    changed = True
            elif kind == "write" and ent.get("existed") and new and st.base_text(idx, key) == new and _written_before(full, ent):
                st.drop_base(key)
                ent.update(existed=False, sha1="")
                changed = True
            st.save(idx)
            return changed
    except Exception as e:
        _log("repair %s: %s" % (sid, e), dispatch_dir)
        return False


def _written_before(full, ent):
    """The file on disk was last written before its snapshot was taken (the snapshot came too
    late). A Write that happened after the snapshot moves mtime past captured_at even when the
    content did not change, so an identical rewrite of an existing file is not mistaken for a new file."""
    try:
        return os.stat(full).st_mtime <= float(ent.get("captured_at") or 0) + 0.001
    except OSError:
        return False


# Lines the way the editor (Monaco) counts them: only \r\n, \r and \n end a line. str.splitlines()
# would also break on form feed, \v, \x1c-\x1e, \x85, U+2028 and U+2029, and every hunk after one of
# those would land on the wrong line.
_LINE_RE = re.compile(r"[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+\Z")


def _lines(text):
    return _LINE_RE.findall(text)


# difflib with autojunk=False is exact but goes quadratic on repetitive text (a generated JSON file of
# `},` / `{` lines: 39 s for 30k lines). Past this many line pairs the changed middle goes through
# Myers' O((N+M)·D) diff instead, which is linear when few lines changed.
EXACT_DIFF_CELLS = 4_000_000
MYERS_MAX_D = 3000


def _myers_ops(a, b, max_d=MYERS_MAX_D):
    """Opcodes (difflib's shape) from Myers' greedy diff, or None when more than `max_d` lines differ."""
    n, m = len(a), len(b)
    off = max_d + 1
    v = [0] * (2 * max_d + 3)
    trace = []
    found = False
    for d in range(max_d + 1):
        trace.append(v[off - d - 1:off + d + 2])
        for k in range(-d, d + 1, 2):
            if k == -d or (k != d and v[off + k - 1] < v[off + k + 1]):
                x = v[off + k + 1]
            else:
                x = v[off + k - 1] + 1
            y = x - k
            while x < n and y < m and a[x] == b[y]:
                x += 1
                y += 1
            v[off + k] = x
            if x >= n and y >= m:
                found = True
                break
        if found:
            break
    if not found:
        return None
    # Walk back through the saved frontiers (trace[d] is v as step d found it, k from -d-1 .. d+1).
    x, y = n, m
    moves = []
    for d in range(len(trace) - 1, 0, -1):
        vd = trace[d]
        k = x - y
        if k == -d or (k != d and vd[k - 1 + d + 1] < vd[k + 1 + d + 1]):
            pk = k + 1
        else:
            pk = k - 1
        px = vd[pk + d + 1]
        py = px - pk
        while x > px and y > py:
            moves.append("=")
            x -= 1
            y -= 1
        moves.append("+" if pk == k + 1 else "-")
        x, y = px, py
    moves.extend("=" * min(x, y))
    moves.reverse()
    ops = []
    i = j = 0
    for kind in moves:
        if kind == "=":
            if ops and ops[-1][0] == "equal":
                ops[-1][2] += 1
                ops[-1][4] += 1
            else:
                ops.append(["equal", i, i + 1, j, j + 1])
            i += 1
            j += 1
        else:
            if not ops or ops[-1][0] == "equal":
                ops.append(["replace", i, i, j, j])
            if kind == "-":
                ops[-1][2] += 1
                i += 1
            else:
                ops[-1][4] += 1
                j += 1
    out = []
    for tag, i1, i2, j1, j2 in ops:
        if tag != "equal":
            tag = "delete" if j1 == j2 else "insert" if i1 == i2 else "replace"
        out.append((tag, i1, i2, j1, j2))
    return out


def _opcodes(a, b):
    """difflib-style opcodes (with the equal runs) between two lists of lines, bounded in time."""
    lo, n = 0, min(len(a), len(b))
    while lo < n and a[lo] == b[lo]:
        lo += 1
    hi = 0
    while hi < n - lo and a[len(a) - 1 - hi] == b[len(b) - 1 - hi]:
        hi += 1
    ma, mb = a[lo:len(a) - hi], b[lo:len(b) - hi]
    if len(ma) * len(mb) <= EXACT_DIFF_CELLS:
        mid = difflib.SequenceMatcher(None, ma, mb, autojunk=False).get_opcodes()
    else:
        mid = _myers_ops(ma, mb, MYERS_MAX_D)
        if mid is None:  # most of a huge file changed: difflib's junk heuristic keeps it bounded
            mid = difflib.SequenceMatcher(None, ma, mb, autojunk=True).get_opcodes()
    ops = []
    if lo:
        ops.append(("equal", 0, lo, 0, lo))
    for tag, i1, i2, j1, j2 in mid:
        if i1 == i2 and j1 == j2:
            continue
        ops.append((tag, i1 + lo, i2 + lo, j1 + lo, j2 + lo))
    if hi:
        ops.append(("equal", len(a) - hi, len(a), len(b) - hi, len(b)))
    return ops


def compute_hunks(base, disk):
    a, b = _lines(base), _lines(disk)
    ops = [op for op in _opcodes(a, b) if op[0] != "equal"]
    groups = []
    for tag, i1, i2, j1, j2 in ops:
        if groups and groups[-1][2] >= i1 and groups[-1][4] >= j1:
            g = groups[-1]
            groups[-1] = (g[0], g[1], i2, g[3], j2)
        else:
            groups.append((tag, i1, i2, j1, j2))
    out = []
    for n, (_, i1, i2, j1, j2) in enumerate(groups):
        old_text, new_text = "".join(a[i1:i2]), "".join(b[j1:j2])
        hid = sha1((old_text + "\0" + new_text + "\0" + str(j1 + 1)).encode("utf-8"))[:12]
        out.append({"id": hid, "index": n + 1, "kind": "add" if i1 == i2 else "del" if j1 == j2 else "mod",
                    "old_start": i1 + 1, "old_lines": i2 - i1, "new_start": j1 + 1, "new_lines": j2 - j1,
                    "old_text": old_text, "new_text": new_text, "_span": (i1, i2, j1, j2)})
    return a, b, out


def _public(hunks):
    return [{k: v for k, v in h.items() if k != "_span"} for h in hunks]


def _agent_target(root, a):
    sid = _check_sid(a.sid)
    full, rel = resolve(root, _one(a))
    st = Store(sid)
    return sid, full, rel, st


def _hunks_answer(st, idx, key, full, rel):
    text, raw = _disk_text(full)
    disk_sha = sha1(raw) if os.path.isfile(full) else ""
    if not key or key not in idx["files"] or text is None:
        return {"ok": True, "path": rel, "baseline": bool(key and key in idx["files"]), "disk_sha1": disk_sha, "hunks": []}, None, None, []
    a, b, hunks = compute_hunks(st.base_text(idx, key), text)
    return {"ok": True, "path": rel, "baseline": True, "disk_sha1": disk_sha, "hunks": _public(hunks)}, a, b, hunks


def op_baseline(root, a):
    sid, full, rel, st = _agent_target(root, a)
    took = capture(sid, root, full)
    return {"ok": True, "path": rel, "captured": took}


def op_hunks(root, a):
    sid, full, rel, st = _agent_target(root, a)
    idx = st.load()
    key = st.key_of(idx, full) if idx else None
    return _hunks_answer(st, idx or {"files": {}}, key, full, rel)[0]


def _decide(root, a, undo):
    sid, full, rel, st = _agent_target(root, a)
    if not a.all and not a.hunk:
        raise EdError("bad_request", "--hunk <id> or --all")
    with _Lock(st.dir):
        idx = st.load()
        key = st.key_of(idx, full) if idx else None
        if not key or key not in idx["files"]:
            raise EdError("no_baseline", f"the agent has not edited {rel} in this session")
        ans, base_lines, disk_lines, hunks = _hunks_answer(st, idx, key, full, rel)
        if base_lines is None:
            raise EdError("binary", f"{rel} is not a text file any more")
        if a.all:
            chosen = hunks
        else:
            chosen = [h for h in hunks if h["id"] == a.hunk]
            if not chosen:
                raise EdError("bad_hunk", "that change is no longer on disk; refresh the hunks")
        ent = idx["files"][key]
        ent["fresh"] = False
        wrote = False
        new_text = None
        if undo:
            lines = list(disk_lines)
            for h in sorted(chosen, key=lambda h: h["_span"][2], reverse=True):
                i1, i2, j1, j2 = h["_span"]
                lines[j1:j2] = base_lines[i1:i2]
            new_text = "".join(lines)
            if a.all and not ent.get("existed") and not os.path.isfile(st.snap_path(key)):
                if os.path.isfile(full):
                    os.remove(full)
                wrote = True
            elif chosen:
                old_raw = _read_bytes(full, TEXT_LIMIT) if os.path.isfile(full) else b""
                if new_text.encode("utf-8") != old_raw:
                    atomic_write(os.path.realpath(full) if os.path.exists(full) else full, new_text.encode("utf-8"))
                    wrote = True
        else:
            lines = list(base_lines)
            for h in sorted(chosen, key=lambda h: h["_span"][0], reverse=True):
                i1, i2, j1, j2 = h["_span"]
                lines[i1:i2] = disk_lines[j1:j2]
            if chosen:
                if a.all and not os.path.isfile(full):
                    st.drop_base(key)
                    ent.update(existed=False, sha1="")
                else:
                    st.set_base(idx, key, "".join(lines))
                    ent["existed"] = True
        st.save(idx)
        out, _, _, _ = _hunks_answer(st, idx, key, full, rel)
    out.update(wrote=wrote, decided=len(chosen))
    if undo:
        t, _ = _disk_text(full)
        out["text"] = t if t is not None else ""
        out["exists"] = os.path.isfile(full)
    return out


def op_accept(root, a):
    return _decide(root, a, undo=False)


def op_undo(root, a):
    return _decide(root, a, undo=True)


def op_files(root, a):
    sid = _check_sid(a.sid)
    st = Store(sid)
    idx = st.load()
    files = []
    if idx:
        iroot = idx["root"].replace("/", os.sep) if IS_WIN else idx["root"]
        for key, ent in sorted(idx["files"].items()):
            full = os.path.join(iroot, *key.split("/"))
            text, _ = _disk_text(full)
            n = 0
            if text is not None:
                n = len(compute_hunks(st.base_text(idx, key), text)[2])
            files.append({"path": _rel(full, root), "hunks_n": n, "baseline_at": ent.get("captured_at", 0), "existed": bool(ent.get("existed"))})
    return {"ok": True, "sid": sid, "files": files}


def op_clear(root, a):
    sid = _check_sid(a.sid)
    d = sid_dir(sid)
    if os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)
    return {"ok": True}


# ---------------------------------------------------------------- the user's own saves
def _find(lines, seq, exp, fuzz=FOLD_FUZZ):
    L = len(seq)
    best = None
    for k in range(max(0, exp - fuzz), min(len(lines) - L, exp + fuzz) + 1):
        if lines[k:k + L] == seq and (best is None or abs(k - exp) < abs(best - exp)):
            best = k
    return best


def fold_patch(base, src, dst):
    """Apply diff(src → dst) onto `base` (lists of lines) by context matching within ±FOLD_FUZZ
    lines of where the src line maps in base. The new base, or None when a hunk does not fit."""
    ops = [op for op in _opcodes(src, dst) if op[0] != "equal"]
    if not ops:
        return list(base)
    blocks = [(i1, j1, i2 - i1) for tag, i1, i2, j1, j2 in _opcodes(base, src) if tag == "equal"]

    def expected(i):
        best = 0
        for ba, bb, size in blocks:
            if size == 0:
                continue
            if bb <= i < bb + size:
                return ba + (i - bb)
            if bb + size <= i:
                best = ba + size + (i - bb - size)
        return best

    out = list(base)
    delta = 0
    for _, i1, i2, j1, j2 in ops:
        old, new = src[i1:i2], dst[j1:j2]
        exp = expected(i1) + delta
        placed = None
        for c in (FOLD_CONTEXT, 1, 0):
            before, after = src[max(0, i1 - c):i1], src[i2:i2 + c]
            seq = before + old + after
            if not seq:
                if not src:  # the file was empty: nothing to match against
                    placed = max(0, min(exp, len(out)))
                break
            k = _find(out, seq, exp - len(before))
            if k is not None:
                placed = k + len(before)
                break
        if placed is None:
            return None
        out[placed:placed + len(old)] = new
        delta += len(new) - len(old)
    return out


def fold_user_edit(sid, root, full, before, after, base=None):
    """`write --sid`: the user's own change (before → after) goes into the baseline so it never
    shows as an agent hunk. True when folded; False when there is no baseline or it did not fit."""
    _check_sid(sid)
    st = Store(sid, base)
    with _Lock(st.dir):
        idx = st.load()
        key = st.key_of(idx, os.path.realpath(full)) if idx else None
        if not key or key not in idx["files"] or before is None:
            return False
        new = fold_patch(_lines(st.base_text(idx, key)), _lines(before), _lines(after))
        if new is None:
            return False
        st.set_base(idx, key, "".join(new))
        idx["files"][key]["fresh"] = False
        st.save(idx)
        return True


def op_fold(root, a, stdin):
    """`fold <path> --sid S`, stdin = the file as it was before a save the page did not route
    through `write` (the full IDE saves on its own): fold that save (stdin → disk) into the
    baseline like `write --sid` does, so the person's own typing never shows as an agent hunk."""
    sid, full, rel, st = _agent_target(root, a)
    text, _ = _disk_text(full)
    if text is None:
        raise EdError("binary", f"{rel} is not a text file")
    folded = fold_user_edit(sid, root, full, stdin, text) if stdin != text else False
    return {"ok": True, "path": rel, "baseline_folded": folded}


# ---------------------------------------------------------------- elsewhere
def _which(name):
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        if here not in sys.path:
            sys.path.insert(0, here)
        import dplatform as P
        return P.which(name)
    except Exception:
        return shutil.which(name)


def _app_bundle(bundle):
    if sys.platform != "darwin":
        return None
    for d in ("/Applications", os.path.expanduser("~/Applications")):
        p = os.path.join(d, bundle)
        if os.path.isdir(p):
            return p
    return None


def op_apps(root, a):
    return {"ok": True, "apps": [{"id": i, "label": label, "installed": bool(_which(i) or _app_bundle(b))} for i, label, b in APPS]}


def op_open_in(root, a):
    app = a.app
    spec = next((x for x in APPS if x[0] == app), None)
    if not spec:
        raise EdError("bad_request", "--app is code or cursor")
    target, rel = resolve(root, a.args[0]) if a.args else (root, "")
    if a.args and not os.path.exists(target):
        raise EdError("not_found", f"{rel} does not exist")
    exe = _which(app)
    bundle = _app_bundle(spec[2])
    if exe:
        cmd = [exe, root]
        if rel:
            cmd += ["--goto", "%s:%d" % (target, a.line or 1)] if a.line else [target]
    elif bundle:
        cmd = ["open", "-a", bundle, target]
    else:
        raise EdError("unsupported", f"{spec[1]} is not installed")
    kw = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "cwd": root}
    if IS_WIN:
        kw["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
    else:
        kw["start_new_session"] = True
    try:
        subprocess.Popen(cmd, **kw)
    except OSError as e:
        raise EdError("io", str(e))
    return {"ok": True, "app": app}


# ---------------------------------------------------------------- entry
def _one(a):
    if len(a.args) != 1:
        raise EdError("bad_request", "one path, please" if not a.args else "only one path")
    return a.args[0]


OPS = {
    "baseline": op_baseline, "hunks": op_hunks, "accept": op_accept, "undo": op_undo, "files": op_files, "clear": op_clear, "fold": op_fold,
    "apps": op_apps, "open-in": op_open_in,
}
STDIN_OPS = {"fold"}


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise EdError("bad_request", message)


def parser():
    p = _Parser(prog="dispatch editor", add_help=False)
    p.add_argument("args", nargs="*")
    p.add_argument("--root", default="")
    p.add_argument("--sid", default="")
    p.add_argument("--hunk", default="")
    p.add_argument("--all", action="store_true")
    p.add_argument("--app", default="")
    p.add_argument("--line", type=int, default=0)
    p.add_argument("--json", action="store_true")
    return p


def run(op, argv, stdin=None):
    """One op → the answer dict (never raises). `stdin`: the editor's text for fold."""
    try:
        fn = OPS.get(op)
        if not fn:
            raise EdError("bad_request", f"unknown op {op!r}; one of {', '.join(sorted(OPS))}")
        a = parser().parse_intermixed_args(list(argv))
        if op == "apps" and not a.root:
            root = None
        else:
            root = open_root(a.root)
        if a.sid:
            _check_sid(a.sid)
        if op in STDIN_OPS:
            return fn(root, a, stdin if stdin is not None else "")
        return fn(root, a)
    except EdError as e:
        return e.body()
    except PermissionError as e:
        return {"ok": False, "error": "io", "message": str(e)}
    except OSError as e:
        return {"ok": False, "error": "io", "message": str(e)}
    except Exception as e:  # never a traceback on stdout: the page reads one JSON object
        return {"ok": False, "error": "io", "message": "%s: %s" % (type(e).__name__, str(e)[:400])}


def _read_stdin():
    try:
        data = sys.stdin.buffer.read() if hasattr(sys.stdin, "buffer") else sys.stdin.read().encode("utf-8")
    except Exception:
        return ""
    return data.decode("utf-8", "replace")


def _print(obj):
    data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
    out = getattr(sys.stdout, "buffer", None)
    if out is not None:
        out.write(data)
        out.flush()
    else:
        sys.stdout.write(data.decode("utf-8"))
        sys.stdout.flush()


def main(a=None):
    """`dispatch editor <op> …` (dispatch.py hands over op and the rest), or `python editor.py <op> …`."""
    if a is None:
        argv = sys.argv[1:]
        op, rest = (argv[0], argv[1:]) if argv else ("", [])
    else:
        op, rest = a.op, list(a.rest or [])
    stdin = _read_stdin() if op in STDIN_OPS else None
    _print(run(op, rest, stdin))
    return 0


if __name__ == "__main__":
    sys.exit(main())
