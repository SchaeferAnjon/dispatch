# -*- coding: utf-8 -*-
"""`dispatch attribution …`: who wrote each line of a changed file: an agent, you, or something else (task-6qpx).

Dispatch keeps a light record per project (the git top level of a session's folder):
    DISPATCH_DIR/attribution/<name>-<sha1(root)[:10]>/
        marks.jsonl   one line per mark, oldest first
        edits.jsonl   the editor's record of your typing: one line each time you save a file you changed by hand in
                      Dispatch's editor, with what it had when you began and what you saved (task-m6hek)
        blobs/ab/…    the content of a changed file at a mark or an edit, zlib, by sha1 of the raw bytes
        lock
A mark is taken when an agent's turn starts (the prompt goes out) and when it ends:
    {"v": 1, "ts", "event": "start"|"end", "session": "<agent>:<its own id>", "agent", "turn", "text",
     "head": <commit at that moment>, "files": {path: blob sha | null (deleted)}}
`files` holds every path `git status` lists then; a path it does not list has HEAD's content at that
moment. Claude Code's and Codex's hooks (life_hook.py), OpenCode's plugin and the Agents window
(when a session's status changes) all take marks; the same turn marked twice is harmless.

Who wrote a line: walk the file's content from mark to mark (and the editor's records) and on to the file on
disk, carrying each line's author through a line diff. A change between two marks happened while the turns
open then were running: one agent's turn (or several turns of one agent) → that agent; turns of different
agents at once → unsure; none open → "other": a tool, a script, git or another app, nobody Dispatch saw. Only
a change the editor vouches for is yours: from the text a file had when you began typing in it to the text you
saved ("you"). A line that existed at the first mark predates the record ("before"). When you change a
line an agent wrote, the line becomes "mix" and keeps the agent's text (`was`). Lines the agent writes over
yours are the agent's again. Everything is worked out from the record each time it is asked, so a record
kept before the editor's (when every change outside a turn counted as yours) reads the new way at once.

  mark --event start|end --agent A --session ID --cwd DIR [--text PROMPT] [--host-session URI]
      take a mark (the hooks and the Agents window call this); --host-session is an Agents-window
      session (claude:/<id>), resolved to the agent's own id when the window's records have it.
  edit --file FILE --since T0 --at T1   (stdin: {"before": text, "saved": text})
      the editor's record of a save: the text the file had when you began typing at T0 and the text you saved at T1.
  show FILE [--json]
      runs of lines: {from, to, who: ai|you|mix|unsure|other|before, agent, session, turn, ts, text, was}
  files FILE… [--json]
      per file: counts of lines by who, and which agents wrote in it.
  note --session ID --cwd DIR
      what you changed since that session's last turn ended (the text its next turn starts with).
  steps (--session ID | --host-session URI) --cwd DIR
      the session's turns (each changed file as two read-only versions, the commits it made and how
      many of their lines were yours) and the lines you changed after each turn, for the chat and the
      All / Turn 1 / You filter of Changes.
  config [--co-author on|off]
      Settings › Agents: whether a turn also asks the agent to end its commits with a Co-authored-by
      line (off: Dispatch adds nothing to commit messages).

Always exit 0 with one JSON object on stdout: {"ok": true, …} or {"ok": false, "error", "message"}.
"""
import argparse
import difflib
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import zlib

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import checkpoint as CP  # noqa: E402
import engines as E  # noqa: E402

VERSION = 1
BIG_FILE = 2 * 1024 * 1024     # bytes; a larger changed file is not kept (its lines stay "before")
MAX_STATUS = 3000              # paths per mark; a folder with more changed files is marked without content
MAX_LINES = 30000              # a longer file is not attributed
STALE_TURN = 3 * 3600          # seconds; a turn that never said it ended counts as ended after this
TAIL_GRACE = 6.0               # seconds; a file written this soon after a turn ended is that turn's (a plugin
                               # or a formatter finishing up), not yours
DEDUP = 5.0                    # seconds; the same session's same event again this soon only refreshes
KEEP_DAYS = 14
PRUNE_EVERY = 400              # marks appended between two prunes
TEXT_KEEP = 200
NOTE_FILES = 6
GIT_TIMEOUT = 20
STATUS_TIMEOUT = 6             # seconds; a hook waits for this, so a huge folder is skipped rather than slow
WHO = ("ai", "you", "mix", "unsure", "other", "before")
EDIT_GAP = 6 * 3600            # seconds; a save this long after its begin is not tied to it
TOLD_BY = ("hook", "plugin")  # the marks whose turn started with the note about your changes (note())


class AttrError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code

    def body(self):
        return {"ok": False, "error": self.code, "message": str(self)}


# ---------------------------------------------------------------- where things live
def store_dir(root, base=None):
    return os.path.join(CP.dispatch_dir(base), "attribution", CP.project_key(root))


def git_env():
    env = dict(os.environ, LC_ALL="C", GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0")
    for k in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        env.pop(k, None)
    return env


def git(root, *args, input=None, timeout=GIT_TIMEOUT):
    try:
        r = subprocess.run(["git", "-C", root] + list(args), input=input, capture_output=True, env=git_env(), timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r if r.returncode == 0 else None


def project_root(path):
    """The git top level of a file or folder; AttrError when it is not in a repository, or is the home folder."""
    path = os.path.realpath(os.path.expanduser(path or ""))
    d = path if os.path.isdir(path) else os.path.dirname(path)
    if not os.path.isdir(d):
        raise AttrError("no_root", "no such folder: %s" % d)
    r = git(d, "rev-parse", "--show-toplevel")
    top = r.stdout.decode("utf-8", "replace").strip() if r else ""
    if not top:
        raise AttrError("not_git", "not in a git repository: %s" % d)
    top = os.path.realpath(top)
    if CP.forbidden_root(top):
        raise AttrError("root_too_broad", "the home folder is not tracked: %s" % top)
    return top


def as_asked(path):
    """A path as the caller spelled it, made absolute, its symbolic links kept: the answers name files so, since the
    window looks them up under the name it asked with (a project opened as /tmp/x is /private/tmp/x on disk)."""
    return os.path.abspath(os.path.expanduser(path or ""))


def root_as_asked(root, cwd):
    """The project's top level (resolved) as `cwd` spells it: the nearest folder of `cwd` that is it."""
    p = as_asked(cwd)
    while os.path.realpath(p) != root:
        up = os.path.dirname(p)
        if up == p:
            return root
        p = up
    return p


def linked_worktree(root):
    """A checkout made with `git worktree add` (Dispatch makes one per session): its .git is a file."""
    r = git(root, "rev-parse", "--git-dir", "--git-common-dir")
    if not r:
        return False
    parts = r.stdout.decode("utf-8", "replace").split("\n")
    if len(parts) < 2:
        return False
    full = [os.path.realpath(os.path.join(root, p)) for p in parts[:2]]
    return full[0] != full[1]


def head_of(root):
    r = git(root, "rev-parse", "--verify", "-q", "HEAD")
    return r.stdout.decode().strip() if r else None


class _Lock(object):
    def __init__(self, d):
        self.d, self.f = d, None

    def __enter__(self):
        os.makedirs(self.d, exist_ok=True)
        self.f = open(os.path.join(self.d, "lock"), "a+")
        try:
            import fcntl
            fcntl.flock(self.f.fileno(), fcntl.LOCK_EX)
        except (ImportError, OSError):
            pass
        return self

    def __exit__(self, *exc):
        try:
            self.f.close()
        except OSError:
            pass


# ---------------------------------------------------------------- blobs
def blob_path(d, sha):
    return os.path.join(d, "blobs", sha[:2], sha[2:])


def put_blob(d, data):
    sha = hashlib.sha1(data).hexdigest()
    p = blob_path(d, sha)
    if not os.path.exists(p):
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".%d.tmp" % os.getpid()
        with open(tmp, "wb") as f:
            f.write(zlib.compress(data, 6))
        os.replace(tmp, p)
    return sha


def get_blob(d, sha):
    try:
        with open(blob_path(d, sha), "rb") as f:
            return zlib.decompress(f.read())
    except (OSError, zlib.error):
        return None


def is_binary(data):
    return b"\0" in data[:8192]


# ---------------------------------------------------------------- marks
def status_paths(root):
    """{path: 'D' or ''} for every path `git status` lists (renames as delete + add); None when git fails."""
    r = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", timeout=STATUS_TIMEOUT)
    if r is None:
        return None
    out = {}
    for item in r.stdout.decode("utf-8", "surrogateescape").split("\0"):
        if len(item) < 4:
            continue
        xy, path = item[:2], item[3:]
        out[path] = "D" if "D" in xy else ""
        if len(out) > MAX_STATUS:
            return None
    return out


def snapshot_files(root, d):
    """{path: sha | None} for the changed paths now; files too big or binary are left out (their lines
    stay "before")."""
    listed = status_paths(root)
    if listed is None:
        return None
    files = {}
    for path, kind in listed.items():
        full = os.path.join(root, path)
        if kind == "D" or not os.path.lexists(full):
            files[path] = None
            continue
        try:
            if not os.path.isfile(full) or os.path.getsize(full) > BIG_FILE:
                continue
            with open(full, "rb") as f:
                data = f.read()
        except OSError:
            continue
        if is_binary(data):
            continue
        files[path] = put_blob(d, data)
    return files


def file_mtimes(root, files):
    """{path: when it was last written} for the changed files a mark keeps: a change right after a turn
    ended is told from yours by it (TAIL_GRACE)."""
    out = {}
    for path, sha in (files or {}).items():
        if not sha:
            continue
        try:
            out[path] = round(os.path.getmtime(os.path.join(root, path)), 3)
        except OSError:
            continue
    return out


def load_marks(d):
    out = []
    try:
        with open(os.path.join(d, "marks.jsonl"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    m = json.loads(line)
                except ValueError:
                    continue
                if isinstance(m, dict) and m.get("event") in ("start", "end") and isinstance(m.get("files"), dict):
                    out.append(m)
    except OSError:
        pass
    out.sort(key=lambda m: m.get("ts") or 0)
    return out


def canonical_session(agent, session):
    agent = E.agent_of(agent) or "agent"
    session = str(session or "").strip()
    head, sep, rest = session.partition(":")
    if sep and E.find(head):
        return E.agent_of(head), rest.lstrip("/")
    return agent, session


def host_session_uri(uri):
    """The Agents-window session as the window's records name it (claude:/<host id>), and the key it goes
    by while the agent's own id is not known yet (the host id under the agent's name)."""
    scheme, _, rest = (uri or "").partition(":")
    scheme = re.sub(r"^(?:vscode-)?agent-host-", "", scheme)
    hid = rest.lstrip("/")
    return "%s:/%s" % (scheme, hid), "%s:%s" % (E.agent_of(scheme) or "agent", hid)


def host_session_key(uri):
    """An Agents-window session (claude:/<host id>) as the agent's own key, when the window's records have
    it; else the host id under the agent's name. The window's resources read agent-host-claude:/<id>
    (vscode-agent-host-… on a remote) as well."""
    uri, fallback = host_session_uri(uri)
    try:
        import ide_sessions
        key = ide_sessions.transcript_key(uri)
    except Exception:  # noqa: BLE001 - the window's catalog is not a contract; fall back to its id
        key = None
    if key and ":" in key and key.split(":", 1)[1]:
        a, sid = key.split(":", 1)
        return E.agent_of(a), sid
    return tuple(fallback.split(":", 1))


def with_aliases(marks, resolve=False):
    """One key per session. A new session's first turn starts before the window's records know the agent's
    own id (OpenCode makes its ses_ id as the turn starts), so the window marks that start under the host
    id and the turn's end, from the window or OpenCode's plugin, under the agent's id: unjoined, the start
    stays open for STALE_TURN and every line you change meanwhile counts as the agent's. A window mark keeps
    the key it would have had without its agent's id (`host`); a later mark that has both joins them, and
    with `resolve` a start still under its host id asks the window's records again (`host_uri`)."""
    alias = {}
    for m in marks:
        h, s = m.get("host"), m.get("session")
        if h and s and h != s:
            alias[h] = s
    if resolve:
        open_host = {}
        for m in marks:
            s = m.get("session")
            if m.get("host") and s == m.get("host") and s not in alias:
                open_host[s] = m if m["event"] == "start" else None
        for s, m in open_host.items():
            if m is None or not m.get("host_uri"):
                continue
            agent, sid = host_session_key(m["host_uri"])
            key = "%s:%s" % (agent, sid)
            if key != s:
                alias[s] = key
    if not alias:
        return marks
    out = []
    for m in marks:
        s = m.get("session")
        out.append(dict(m, session=alias[s], alias_of=s) if s in alias else m)
    return out


def kept_text(text):
    """The message as kept with a mark: its first TEXT_KEEP characters, "…" at the end when it was longer."""
    t = (text or "").strip()
    return t if len(t) <= TEXT_KEEP else t[:TEXT_KEEP - 1] + "…"


def mark(cwd, event, agent, session, text="", now=None, base=None, source="", host="", host_uri=""):
    if event not in ("start", "end"):
        raise AttrError("bad_request", "event is start or end")
    root = project_root(cwd)
    agent, sid = canonical_session(agent, session)
    if not sid:
        raise AttrError("bad_request", "no session id")
    key = "%s:%s" % (agent, sid)
    d = store_dir(root, base)
    now = time.time() if now is None else now
    with _Lock(d):
        files = snapshot_files(root, d)
        if files is None:
            return {"ok": True, "marked": False, "reason": "git_status_failed", "root": root}
        raw = load_marks(d)
        # this window mark knows the agent's own id for a session whose earlier marks only had the window's: it
        # is kept even when it repeats the hook's or plugin's mark, since it is what joins the two (task-dy6c)
        joins = bool(host) and host != key and any(m.get("session") == host for m in raw)
        marks = with_aliases(raw + ([{"host": host, "session": key, "event": event}] if host else []))
        mine = [m for m in marks if m.get("session") == key and "files" in m]
        last = mine[-1] if mine else None
        turn = sum(1 for m in mine if m["event"] == "start" and not m.get("dup"))
        dup = False
        if event == "start":
            if last and last["event"] == "start" and now - (last.get("ts") or 0) < DEDUP:
                if (source not in TOLD_BY or last.get("source") in TOLD_BY) and not joins:
                    return {"ok": True, "marked": False, "reason": "duplicate", "root": root, "turn": turn}
                # the window marked this turn first; the hook or plugin that passes the note on marks it
                # too, so told() can say the agent heard about your lines (same turn, not a new one)
                dup = True
            else:
                turn += 1
        else:
            if last and last["event"] == "end" and now - (last.get("ts") or 0) < DEDUP:
                if not joins:
                    return {"ok": True, "marked": False, "reason": "duplicate", "root": root, "turn": turn}
                dup = True
            turn = max(turn, 1)
        rec = {"v": VERSION, "ts": round(now, 3), "event": event, "session": key, "agent": agent, "turn": turn,
               "text": kept_text(text), "head": head_of(root), "files": files, "source": source or ""}
        if dup:
            rec["dup"] = True
        if host:
            rec["host"] = host
            if host_uri:
                rec["host_uri"] = host_uri
        if linked_worktree(root):
            rec["worktree"] = True
        mtimes = file_mtimes(root, files)
        if mtimes:
            rec["mtimes"] = mtimes
        with open(os.path.join(d, "marks.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")
        if (len(marks) + 1) % PRUNE_EVERY == 0:
            prune(d, now)
    return {"ok": True, "marked": True, "root": root, "session": key, "turn": turn, "event": event}


def prune(d, now=None):
    """Drop marks older than KEEP_DAYS and the blobs no mark refers to any more."""
    now = time.time() if now is None else now
    keep = [m for m in load_marks(d) if now - (m.get("ts") or 0) < KEEP_DAYS * 86400]
    tmp = os.path.join(d, "marks.jsonl.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        for m in keep:
            f.write(json.dumps(m, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(tmp, os.path.join(d, "marks.jsonl"))
    edits = [e for e in load_edits(d) if now - e["ts"] < KEEP_DAYS * 86400]
    tmp = os.path.join(d, "edits.jsonl.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        for e in edits:
            f.write(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(tmp, os.path.join(d, "edits.jsonl"))
    used = set(v for m in keep for v in m["files"].values() if v) | set(e[k] for e in edits for k in ("base", "sha"))
    removed = 0
    for top, _dirs, names in os.walk(os.path.join(d, "blobs")):
        for n in names:
            sha = os.path.basename(top) + n
            if sha not in used and not n.endswith(".tmp"):
                try:
                    os.remove(os.path.join(top, n))
                    removed += 1
                except OSError:
                    pass
    return {"kept": len(keep), "removed_blobs": removed}


# ---------------------------------------------------------------- the editor's record of your typing
def edit(path, before, saved, since, at, now=None, base=None):
    """Dispatch's editor saw you change `path` by hand and save it: `before` is the text it had when you began typing
    (its last saved or loaded state), `saved` the text you saved; `since` and `at` (seconds) when you began and when you
    saved, by the editor's clock, so a slow answer here does not reorder them. Only the lines that differ between the
    two are yours; a change no editor saw and no agent's turn covers is "other" (task-m6hek). The editor sends no record
    for a save that also holds an agent's edits made through it."""
    full = os.path.realpath(os.path.expanduser(path or ""))
    root = project_root(full)
    rel = os.path.relpath(full, root).replace(os.sep, "/")
    if rel.startswith("../") or rel == ".git" or rel.startswith(".git/"):
        raise AttrError("bad_request", "not a file of the project: %s" % path)
    now = time.time() if now is None else now
    if not isinstance(at, (int, float)) or not isinstance(since, (int, float)) or not (0 < since <= at <= now + 60):
        raise AttrError("bad_request", "since and at are the times you began and saved, since <= at <= now")
    if not isinstance(before, str) or not isinstance(saved, str):
        raise AttrError("bad_request", "before and saved are the texts")
    data = [t.encode("utf-8", "surrogatepass") for t in (before, saved)]
    if any(len(x) > BIG_FILE or is_binary(x) for x in data):
        return {"ok": True, "recorded": False, "reason": "not_text", "root": root}
    d = store_dir(root, base)
    with _Lock(d):
        rec = {"v": VERSION, "ts": round(at, 3), "since": round(since, 3), "event": "save", "path": rel,
               "base": put_blob(d, data[0]), "sha": put_blob(d, data[1])}
        with open(os.path.join(d, "edits.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")
    return {"ok": True, "recorded": True, "root": root, "path": rel}


def load_edits(d):
    out = []
    try:
        with open(os.path.join(d, "edits.jsonl"), encoding="utf-8") as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if (isinstance(e, dict) and e.get("event") == "save" and isinstance(e.get("path"), str)
                        and isinstance(e.get("sha"), str) and isinstance(e.get("base"), str)
                        and isinstance(e.get("ts"), (int, float)) and isinstance(e.get("since"), (int, float))):
                    out.append(e)
    except OSError:
        pass
    out.sort(key=lambda e: e["ts"])
    return out


def edits_of(edits, rel):
    """A path's editor records as two steps each, oldest first: where you began (`before`, whoever's it was) and what
    you saved (yours, unless you began too long before)."""
    out = []
    for e in edits:
        if e["path"] != rel:
            continue
        since = min(e["since"], e["ts"])
        out.append({"ts": since, "sha": e["base"], "yours": False})
        out.append({"ts": e["ts"], "sha": e["sha"], "yours": e["ts"] - since <= EDIT_GAP})
    out.sort(key=lambda x: x["ts"])
    return out


# ---------------------------------------------------------------- who wrote what
class Contents(object):
    """A path's content at each mark: its blob, or HEAD's copy at that moment (one `git cat-file --batch`)."""

    def __init__(self, root, d):
        self.root, self.d, self.heads = root, d, {}

    def at_heads(self, rel, heads):
        want = [h for h in heads if h and (h, rel) not in self.heads]
        if want:
            spec = "".join("%s:%s\n" % (h, rel) for h in want).encode("utf-8", "surrogateescape")
            r = git(self.root, "cat-file", "--batch", input=spec)
            data = r.stdout if r else b""
            pos = 0
            for h in want:
                nl = data.find(b"\n", pos)
                header = data[pos:nl].decode("utf-8", "replace") if nl >= 0 else ""
                parts = header.split()
                if len(parts) == 3 and parts[1] == "blob":
                    size = int(parts[2])
                    self.heads[(h, rel)] = data[nl + 1:nl + 1 + size]
                    pos = nl + 1 + size + 1
                else:
                    self.heads[(h, rel)] = None
                    pos = nl + 1 if nl >= 0 else len(data)

    def of(self, m, rel):
        if rel in m["files"]:
            sha = m["files"][rel]
            return get_blob(self.d, sha) if sha else None
        h = m.get("head")
        return self.heads.get((h, rel)) if h else None


def split_lines(data):
    if data is None:
        return []
    text = data.decode("utf-8", "replace")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


BEFORE = {"who": "before"}


def author_for(open_turns, ts):
    """Who made a change while `open_turns` ({session: mark}) were running. None running: not an agent of Dispatch's,
    and not you either unless the editor says so (a tool, a script, git, another app: "other")."""
    if not open_turns:
        return {"who": "other", "ts": ts}
    agents = sorted(set(m["agent"] for m in open_turns.values()))
    if len(agents) > 1:
        return {"who": "unsure", "ts": ts, "why": "agents", "agents": [E.get(a).short_name for a in agents]}
    m = max(open_turns.values(), key=lambda x: x.get("ts") or 0)
    return {"who": "ai", "ts": ts, "agent": m["agent"], "session": m["session"], "turn": m.get("turn"),
            "text": m.get("text") or "", "several": len(open_turns) > 1}


def tail_author(author, last_end, written):
    """A change nobody's turn was open for, written within TAIL_GRACE of the last turn's end: that turn's
    agent finishing up (OpenCode's plugins write their state as the session goes idle)."""
    if author["who"] != "other" or not last_end or written is None:
        return author
    if 0 <= written - (last_end.get("ts") or 0) <= TAIL_GRACE:
        return {"who": "ai", "ts": round(written, 3), "agent": last_end["agent"], "session": last_end["session"],
                "turn": last_end.get("turn"), "text": last_end.get("text") or "", "several": False, "tail": True}
    return author


def apply_change(old_lines, old_info, new_lines, author):
    """Carry each line's author from one version to the next."""
    if len(new_lines) > MAX_LINES or len(old_lines) > MAX_LINES:
        return [BEFORE] * len(new_lines)
    sm = difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False)
    info = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            info.extend(old_info[i1:i2])
            continue
        for j in range(j1, j2):
            i = i1 + (j - j1)
            prev = old_info[i] if tag == "replace" and i < i2 else None
            if author["who"] == "you" and prev is not None and prev["who"] in ("ai", "mix"):
                ai = prev if prev["who"] == "ai" else prev["ai"]
                was = old_lines[i] if prev["who"] == "ai" else prev["was"]
                info.append({"who": "mix", "ts": author["ts"], "ai": ai, "was": was})
            else:
                info.append(author)
    return info


def open_after(open_turns, m):
    if m["event"] == "start":
        prev = open_turns.get(m["session"])  # the same turn marked twice keeps your message from either mark
        open_turns[m["session"]] = dict(m, text=prev["text"]) if prev and prev.get("text") and not m.get("text") else m
    else:
        open_turns.pop(m["session"], None)


def drop_stale(open_turns, now):
    for k in [k for k, m in open_turns.items() if now - (m.get("ts") or 0) > STALE_TURN]:
        open_turns.pop(k)


def blame(path, now=None, base=None, current=None, until=None, marks=None, edits=None):
    """{root, rel, tracked, since, lines: [info per current line], agents}. `until`: only the marks taken
    up to then (with `current`, the file as it was at that moment); `marks`, `edits`: already loaded."""
    full = os.path.realpath(os.path.expanduser(path))
    root = project_root(full)
    rel = os.path.relpath(full, root).replace(os.sep, "/")
    d = store_dir(root, base)
    marks = with_aliases(load_marks(d), resolve=True) if marks is None else marks
    edits = edits_of(load_edits(d) if edits is None else edits, rel)
    if until is not None:
        marks = [m for m in marks if (m.get("ts") or 0) <= until]
        edits = [e for e in edits if e["ts"] <= until]
    if current is None:
        try:
            with open(full, "rb") as f:
                current = f.read()
        except OSError:
            current = None
    cur_lines = split_lines(current)
    if not marks or current is None or is_binary(current or b""):
        return {"root": root, "rel": rel, "tracked": False, "since": None, "lines": [BEFORE] * len(cur_lines), "agents": [], "marks": marks}
    if marks[0].get("worktree"):
        # A session's own worktree starts as its HEAD, before the first turn the record could see: the
        # session of the first mark had it from the start (its first turn's start may have come late).
        first = marks[0]
        marks = [dict(first, event="start", ts=(first.get("ts") or 0) - 0.001, files={}, virtual=True)] + marks
    contents = Contents(root, d)
    contents.at_heads(rel, sorted(set(m.get("head") for m in marks if rel not in m["files"] and m.get("head"))))
    lines = split_lines(contents.of(marks[0], rel))
    info = [BEFORE] * len(lines)
    raw_prev = contents.of(marks[0], rel)
    open_turns = {}
    open_after(open_turns, marks[0])
    last_end = marks[0] if marks[0]["event"] == "end" else None
    prev_ts = marks[0].get("ts") or 0
    # the marks and the editor's records of this file, in the order they happened (a mark first on a tie)
    steps = sorted([((m.get("ts") or 0), 0, n, m) for n, m in enumerate(marks[1:])]
                   + [(e["ts"], 1, n, e) for n, e in enumerate(edits) if e["ts"] >= prev_ts], key=lambda x: x[:3])
    for ts, kind, _n, m in steps:
        if kind == 1:
            raw = get_blob(d, m["sha"])
            if raw is not None and raw != raw_prev:
                drop_stale(open_turns, ts)
                # what you saved after typing is yours; what the file had become before you began is whoever's
                # change it was (an agent's turn, or something Dispatch did not see)
                author = {"who": "you", "ts": ts} if m.get("yours") else tail_author(author_for(open_turns, ts), last_end, ts)
                new_lines = split_lines(raw)
                info = apply_change(lines, info, new_lines, author)
                lines, raw_prev = new_lines, raw
            prev_ts = ts
            continue
        raw = contents.of(m, rel)
        if raw != raw_prev:
            drop_stale(open_turns, m["ts"])
            new_lines = split_lines(raw)
            written = (m.get("mtimes") or {}).get(rel)
            author = tail_author(author_for(open_turns, m["ts"]), last_end, written)
            if author["who"] == "other" and written and prev_ts < written <= m["ts"]:
                author = dict(author, ts=written)  # when it was written, not when the next mark saw it
            info = apply_change(lines, info, new_lines, author)
            lines, raw_prev = new_lines, raw
        open_after(open_turns, m)
        if m["event"] == "end":
            last_end = m
        prev_ts = m.get("ts") or prev_ts
    if current != raw_prev:
        now = time.time() if now is None else now
        drop_stale(open_turns, now)
        try:
            ts = os.path.getmtime(full) if until is None else until
        except OSError:
            ts = now
        info = apply_change(lines, info, cur_lines, tail_author(author_for(open_turns, round(ts, 3)), last_end, ts))
    agents = sorted(set(E.get(i["agent"]).short_name for i in info if i["who"] == "ai")
                    | set(E.get(i["ai"]["agent"]).short_name for i in info if i["who"] == "mix"))
    return {"root": root, "rel": rel, "tracked": True, "since": marks[0]["ts"], "lines": info, "agents": agents, "marks": marks}


def told(marks, ts):
    """The agent that heard about a change of yours made at `ts`: a session whose turn had ended before it
    and whose next turn started (through a hook or OpenCode's plugin, which pass the note on) after it."""
    if not ts:
        return ""
    ended = set(m["session"] for m in marks if m["event"] == "end" and (m.get("ts") or 0) < ts)
    for m in marks:
        if m["event"] == "start" and (m.get("ts") or 0) >= ts and m["session"] in ended and m.get("source") in TOLD_BY:
            return E.get(m["agent"]).short_name
    return ""


def _run_key(i):
    if i["who"] == "ai":
        return ("ai", i.get("session"), i.get("turn"))
    if i["who"] == "you":
        return ("you", i.get("ts"))
    if i["who"] == "other":
        return ("other",)
    if i["who"] == "unsure":
        return ("unsure", i.get("ts"))
    return (i["who"],)


def runs(info, marks=()):
    """Consecutive lines with the same author as {from, to, who, …} (1-based, inclusive)."""
    out = []
    for n, i in enumerate(info, 1):
        if out and out[-1]["_k"] == _run_key(i) and i["who"] != "mix":
            out[-1]["to"] = n
            continue
        r = {"_k": _run_key(i), "from": n, "to": n, "who": i["who"]}
        if i["who"] in ("ai", "you", "unsure", "mix"):
            r["ts"] = i.get("ts")  # "other" carries none: a file's time says when, not who
        if i["who"] == "ai":
            r.update(agent=E.get(i["agent"]).short_name, engine=i["agent"], session=i["session"], turn=i.get("turn"), text=i.get("text") or "")
        elif i["who"] == "mix":
            ai = i["ai"]
            r.update(agent=E.get(ai["agent"]).short_name, engine=ai["agent"], session=ai["session"], turn=ai.get("turn"),
                     text=ai.get("text") or "", ai_ts=ai.get("ts"), was=i["was"])
        elif i["who"] == "unsure":
            r.update(why=i.get("why", ""), agents=i.get("agents", []))
        if i["who"] in ("you", "mix"):
            r["told"] = told(marks, i.get("ts"))
        out.append(r)
    for r in out:
        r.pop("_k")
    return out


def counts(info):
    c = dict((w, 0) for w in WHO)
    for i in info:
        c[i["who"]] += 1
    return c


def show(path, now=None, base=None):
    b = blame(path, now=now, base=base)
    return {"ok": True, "file": as_asked(path), "root": b["root"], "rel": b["rel"], "tracked": b["tracked"],
            "since": b["since"], "agents": b["agents"], "counts": counts(b["lines"]), "runs": runs(b["lines"], b["marks"])}


def files(paths, now=None, base=None):
    out = {}
    for p in paths:
        try:
            b = blame(p, now=now, base=base)
            out[as_asked(p)] = {"tracked": b["tracked"], "agents": b["agents"], "counts": counts(b["lines"])}
        except AttrError as e:
            out[as_asked(p)] = {"tracked": False, "error": e.code}
    return {"ok": True, "files": out}


# ---------------------------------------------------------------- the note for the agent's next turn
def ranges(nums):
    out, start, prev = [], None, None
    for n in nums:
        if start is None:
            start = prev = n
        elif n == prev + 1:
            prev = n
        else:
            out.append((start, prev))
            start = prev = n
    if start is not None:
        out.append((start, prev))
    return ", ".join(str(a) if a == b else "%d-%d" % (a, b) for a, b in out)


def note(cwd, agent, session, now=None, base=None):
    """The paths you changed since this session's last turn ended (no agent turn open meanwhile), with
    their line numbers now; "" when there is nothing to say."""
    root = project_root(cwd)
    agent, sid = canonical_session(agent, session)
    key = "%s:%s" % (agent, sid)
    d = store_dir(root, base)
    marks = with_aliases(load_marks(d), resolve=True)
    ends = [i for i, m in enumerate(marks) if m["session"] == key and m["event"] == "end"]
    if not ends:
        return {"ok": True, "text": "", "files": []}
    since = marks[ends[-1]]
    later = marks[ends[-1] + 1:]
    paths = set(since["files"]) | set(p for m in later for p in m["files"])
    listed = status_paths(root) or {}
    paths |= set(listed)
    contents = Contents(root, d)
    found = []
    for rel in sorted(paths)[:MAX_STATUS]:
        full = os.path.join(root, rel)
        try:
            with open(full, "rb") as f:
                now_data = f.read()
        except OSError:
            continue
        if rel not in since["files"]:
            contents.at_heads(rel, [since.get("head")])
        if contents.of(since, rel) == now_data:
            continue  # the same as when the turn ended
        try:
            b = blame(full, now=now, base=base)
        except AttrError:
            continue
        nums = [n for n, i in enumerate(b["lines"], 1)
                if i["who"] in ("you", "mix") and (i.get("ts") or 0) > since["ts"]]
        if nums:
            found.append({"path": rel, "lines": ranges(nums), "count": len(nums)})
    if not found:
        return {"ok": True, "text": "", "files": []}
    shown = found[:NOTE_FILES]
    parts = ["%s (line%s %s)" % (f["path"], "" if f["count"] == 1 else "s", f["lines"]) for f in shown]
    more = len(found) - len(shown)
    text = ("Dispatch: since your last turn the person changed these lines themselves: %s%s. "
            "Keep their changes unless they ask you to change them." % ("; ".join(parts), "; and %d more file%s" % (more, "" if more == 1 else "s") if more else ""))
    return {"ok": True, "text": text, "files": found}


# ---------------------------------------------------------------- the commit line (Settings › Agents)
# Who wrote which line stays in Dispatch on this Mac; commit messages get nothing unless you turn this on.
# Then every turn starts with one sentence asking the agent to end its commits with this line.
# Each engine's line is its adapter's commit_trailer (engines/).


def config_path(base=None):
    return os.path.join(CP.dispatch_dir(base), "attribution", "config.json")


def load_config(base=None):
    try:
        with open(config_path(base), encoding="utf-8") as f:
            c = json.load(f)
        c = c if isinstance(c, dict) else {}
    except (OSError, ValueError):
        c = {}
    return {"co_author": bool(c.get("co_author", False))}


def save_config(changes, base=None):
    c = load_config(base)
    c.update({k: bool(v) for k, v in changes.items() if k in c})
    p = config_path(base)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".%d.tmp" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(c, f)
    os.replace(tmp, p)
    return c


def trailer(agent):
    eng = E.get(agent)
    return "Co-authored-by: " + (eng.commit_trailer or "%s <noreply@dispatch.invalid>" % (eng.short_name or "Agent"))


def commit_line(agent, base=None):
    """The sentence the turn starts with when Settings asks for the co-author line; "" when it is off."""
    if not load_config(base)["co_author"]:
        return ""
    return "Dispatch: when you make a git commit, end its message with this line: %s" % trailer(agent)


def turn_note(cwd, agent, session, now=None, base=None):
    """What a turn starts with: your changed lines since the last turn, and the commit line if asked for."""
    parts = []
    try:
        parts.append(note(cwd, agent, session, now=now, base=base).get("text") or "")
    except AttrError:
        pass
    parts.append(commit_line(agent, base))
    return "\n\n".join(p for p in parts if p)


# ---------------------------------------------------------------- a session's steps (the chat and Changes)
VIEW_KEEP = 7 * 86400
MAX_COMMITS = 5


def session_turns(marks, key):
    """This session's turns from its marks, oldest first: {start, end, last} (marks; start None when only
    the end was seen; end None while it runs). A start while one is open, or a second end right after the
    first, is the same turn marked twice (the window and a hook); `text` is your message from whichever start has
    it (the window marks first and without it, OpenCode's plugin then with it)."""
    turns, cur = [], None
    for m in marks:
        if m.get("session") != key:
            continue
        if m["event"] == "start":
            if cur and cur["end"] is None:
                cur["text"] = cur["text"] or m.get("text") or ""
                continue
            cur = {"start": m, "end": None, "last": None, "text": m.get("text") or ""}
            turns.append(cur)
        elif cur and cur["end"] is None:
            cur["end"] = cur["last"] = m
        elif cur and (m.get("ts") or 0) - (cur["end"].get("ts") or 0) <= 2 * TAIL_GRACE:
            cur["last"] = m  # the later end saw what the agent wrote as it finished
        else:
            cur = {"start": None, "end": m, "last": m, "text": ""}
            turns.append(cur)
    return turns


def view_file(d, rel, data, now=None):
    """A read-only copy of one version of a file for a diff: views/<sha>/<name>, so the editor knows the
    language and the same version is written once."""
    if data is None:
        return None
    sha = hashlib.sha1(data).hexdigest()
    folder = os.path.join(d, "views", sha[:2], sha[2:])
    p = os.path.join(folder, os.path.basename(rel) or "file")
    if not os.path.exists(p):
        os.makedirs(folder, exist_ok=True)
        tmp = p + ".%d.tmp" % os.getpid()
        with open(tmp, "wb") as f:
            f.write(data)
        try:
            os.chmod(tmp, 0o444)
        except OSError:
            pass
        os.replace(tmp, p)
    return p


def prune_views(d, now=None):
    now = time.time() if now is None else now
    top = os.path.join(d, "views")
    for folder, _dirs, names in os.walk(top):
        for n in names:
            p = os.path.join(folder, n)
            try:
                if now - os.path.getmtime(p) > VIEW_KEEP:
                    os.chmod(p, 0o644)
                    os.remove(p)
            except OSError:
                pass


def line_counts(a, b):
    added = removed = 0
    sm = difflib.SequenceMatcher(None, split_lines(a), split_lines(b), autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag != "equal":
            removed += i2 - i1
            added += j2 - j1
    return added, removed


def heads_diff(root, a, b):
    """Paths that differ between two commits."""
    if not a or not b or a == b:
        return set()
    r = git(root, "diff", "--name-only", "-z", "--no-renames", a, b)
    return set(p for p in (r.stdout.decode("utf-8", "surrogateescape").split("\0") if r else []) if p)


def commits_between(root, a, b, limit=MAX_COMMITS):
    if not a or not b or a == b:
        return []
    r = git(root, "log", "--reverse", "-n", str(limit), "--format=%H%x00%ct%x00%B%x01", "%s..%s" % (a, b))
    out = []
    for item in (r.stdout.decode("utf-8", "replace").split("\x01") if r else []):
        item = item.strip("\n")
        if not item:
            continue
        parts = item.split("\0", 2)
        if len(parts) < 3:
            continue
        body = parts[2].strip()
        out.append({"hash": parts[0], "short": parts[0][:7], "ts": int(parts[1] or 0),
                    "subject": body.split("\n", 1)[0][:200], "message": body[:2000]})
    return out


def added_lines(root, sha, first_parent=False):
    """{path: [text of each line the commit added]}; first_parent: a merge's, against the branch it was merged into
    (what it brought in), which `git show` alone leaves out."""
    r = (git(root, "diff", "--no-color", "--no-renames", "-U0", sha + "^1", sha) if first_parent else
         git(root, "show", "--format=", "--no-color", "--no-renames", "-U0", sha))
    out, path = {}, None
    for raw in (r.stdout.decode("utf-8", "replace").split("\n") if r else []):
        if raw.startswith("+++ "):
            t = raw[4:]
            path = t[2:] if t.startswith("b/") else None
            continue
        if path and raw.startswith("+") and not raw.startswith("+++"):
            out.setdefault(path, []).append(raw[1:])
    return out


def turn_open_at(marks, ts):
    """The agent whose turn was running at `ts` (any session of the project), or "" when none was: a commit made
    then is that agent's, one made when none was is yours."""
    open_turns = {}
    for m in marks:
        if (m.get("ts") or 0) > ts:
            break
        open_after(open_turns, m)
    drop_stale(open_turns, ts)
    if not open_turns:
        return ""
    return max(open_turns.values(), key=lambda x: x.get("ts") or 0)["agent"]


def commit_authors(root, sha, ts, marks, base=None, where=None):
    """Who wrote the lines a commit added, as it was committed: ({agent name: lines}, lines you wrote or changed).
    `where`: the checkout whose record to read (a worktree the commit was made in), else `root`."""
    by, yours = {}, 0
    for rel, lines in added_lines(root, sha).items():
        r = git(root, "show", "%s:%s" % (sha, rel))
        data = r.stdout if r else None
        if data is None or is_binary(data):
            continue
        try:
            b = blame(os.path.join(where or root, rel), base=base, current=data, until=ts, marks=marks)
        except AttrError:
            continue
        pool = {}
        for text, info in zip(split_lines(data), b["lines"]):
            pool.setdefault(text, []).append(info)
        for text in lines:
            have = pool.get(text)
            if not have:
                continue
            info = have.pop(0)
            if info["who"] in ("you", "mix"):
                yours += 1
            elif info["who"] == "ai":
                name = E.get(info.get("agent") or "").short_name
                by[name] = by.get(name, 0) + 1
    return by, yours


def worktrees(root):
    r = git(root, "worktree", "list", "--porcelain")
    out = []
    for line in (r.stdout.decode("utf-8", "replace").split("\n") if r else []):
        if line.startswith("worktree "):
            p = os.path.realpath(line[9:].strip())
            if p != root and os.path.isdir(p):
                out.append(p)
    return out


def delivery_line(commits, base=None):
    """Who wrote what a delivery committed, for the delivery page's header ("Claude wrote it · you changed 2 lines"):
    [(repo, sha)] → {"agents": [{agent, lines}], "yours": n, "commits": k}; None when Dispatch kept no record for
    any of them (the record is per checkout: the repository's and each worktree's, where the commit was made)."""
    agents, yours, seen, done = {}, 0, 0, set()
    for repo, sha in commits:
        try:
            root = project_root(repo)
        except AttrError:
            continue
        r = git(root, "show", "-s", "--format=%H %ct", sha)
        if not r:
            continue
        full, _, ct = r.stdout.decode().strip().partition(" ")
        if full in done:
            continue
        done.add(full)
        ts = int(ct or 0)
        for where in [root] + worktrees(root):
            marks = with_aliases(load_marks(store_dir(where, base)), resolve=True)
            if not any(ts - STALE_TURN <= (m.get("ts") or 0) <= ts + 60 for m in marks):
                continue
            by, y = commit_authors(root, full, ts, marks, base, where=where)
            if by or y:
                seen += 1
                yours += y
                for k, v in by.items():
                    agents[k] = agents.get(k, 0) + v
                break
    if not seen:
        return None
    return {"agents": [{"agent": k, "lines": v} for k, v in sorted(agents.items(), key=lambda x: -x[1])], "yours": yours, "commits": seen}


WRITTEN_KEEP = 200     # commit messages remembered (the Commit button's writer)
WRITTEN_WINDOW = 3600  # seconds: a commit this long after its message was written still counts as that message's


def note_written(folder, text, by, now=None, base=None):
    """The Commit button's message (`dispatch write commit-message`, fixit.py): who wrote it, so your commit's card
    can say "Message by OpenCode" rather than calling it yours."""
    if not (text or "").strip():
        return
    try:
        d = store_dir(project_root(folder), base)
    except AttrError:
        return
    rows = load_written(d)[-(WRITTEN_KEEP - 1):] + [{"ts": time.time() if now is None else now, "text": text.strip(), "by": by or ""}]
    with _Lock(d):
        with open(os.path.join(d, "written.jsonl"), "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")


def load_written(d):
    out = []
    try:
        with open(os.path.join(d, "written.jsonl"), encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get("text"):
                    out.append(r)
    except OSError:
        pass
    return out


def written_by(rows, message, ts):
    """Who wrote this commit message for the Commit button ("" when nobody did: the person's own words)."""
    msg = (message or "").strip()
    for r in reversed(rows):
        if r["text"].strip() == msg and -60 <= ts - (r.get("ts") or 0) <= WRITTEN_WINDOW:
            return r.get("by") or "dispatch"
    return ""


MADE_KEEP = 2000  # commits remembered as made by an agent outside any session (Turbo)


def note_made(folder, rows, base=None):
    """Commits an agent made outside every session's turns, that Dispatch knows of: a Turbo run's parts, the merges
    combining them and the merge that brought the result in (turbo.land). rows: [{sha, by: engine id, how, run}], kept in
    made.jsonl so the card under your session says Turbo's agent made them, not you (task-v6glz)."""
    rows = [r for r in rows or () if r.get("sha")]
    if not rows:
        return
    try:
        d = store_dir(project_root(folder), base)
    except AttrError:
        return
    with _Lock(d):
        keep = list(load_made(d).values())
        new = {r["sha"] for r in rows}
        keep = [r for r in keep if r["sha"] not in new][-(MADE_KEEP - len(rows)):] + rows
        with open(os.path.join(d, "made.jsonl"), "w", encoding="utf-8") as f:
            for r in keep:
                f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")


def load_made(d):
    """{sha: {sha, by, how, run}} of note_made."""
    out = {}
    try:
        with open(os.path.join(d, "made.jsonl"), encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get("sha"):
                    out[r["sha"]] = r
    except OSError:
        pass
    return out


def own_commits(root, marks, a, b, base=None):
    """The commits between two heads that no agent's turn made: yours (the Changes or Source Control commit button,
    a terminal), each with who wrote its lines; and the ones a Turbo run made and brought in meanwhile, as its
    agent's (by "turbo": they are not yours, task-v6glz)."""
    out = []
    written = None
    made = load_made(store_dir(root, base))
    # a Turbo run brings many commits at once (each part's, the merges, the final steps): one card for the run, its
    # merge into your branch; the rest are not looked at, so they do not push your own commits out of the last few
    for c in commits_between(root, a, b, limit=MAX_COMMITS + (200 if made else 0)):
        row = made.get(c["hash"])
        if row and not row.get("landed"):
            continue
        if row:
            name = E.get(row.get("by") or "").short_name
            lines = sum(len(v) for v in added_lines(root, c["hash"], first_parent=True).values())
            c.update(by=row.get("how") or "turbo", engine=row.get("by") or "", maker=name, yours=0, message_by=name,
                     agents=[{"agent": name, "lines": lines}] if lines else [], run=row.get("run") or "")
            out.append(c)
            continue
        if turn_open_at(marks, c["ts"]):
            continue
        by, yours = commit_authors(root, c["hash"], c["ts"], marks, base)
        written = load_written(store_dir(root, base)) if written is None else written
        writer = written_by(written, c["message"], c["ts"])
        c.update(by="you", agents=[{"agent": k, "lines": v} for k, v in sorted(by.items(), key=lambda x: -x[1])], yours=yours,
                 message_by=E.find(writer).short_name if E.find(writer) else ("Dispatch" if writer else ""))
        out.append(c)
    return out[-MAX_COMMITS:]


def your_lines_at(root, d, marks, contents, m, paths, base=None):
    """{path: [text of each line that was yours (you, mix) at mark m]}."""
    out = {}
    for rel in paths:
        if rel not in m["files"]:
            contents.at_heads(rel, [m.get("head")])
        data = contents.of(m, rel)
        if data is None or is_binary(data):
            continue
        try:
            b = blame(os.path.join(root, rel), base=base, current=data, until=m.get("ts"), marks=marks)
        except AttrError:
            continue
        lines = split_lines(data)
        mine = [lines[i] for i, info in enumerate(b["lines"]) if info["who"] in ("you", "mix")]
        if mine:
            out[rel] = mine
    return out


def steps(cwd, agent, session, now=None, base=None):
    """The session's turns (what each changed, as two versions per file, and the commits it made) and the
    lines you changed between them, for the chat's "You changed 2 lines" row, its commit card and the
    All / Turn 1 / You filter of Changes."""
    root = project_root(cwd)
    shown = root_as_asked(root, cwd)  # the files are named under the folder the window asked with
    agent, sid = canonical_session(agent, session)
    key = "%s:%s" % (agent, sid)
    d = store_dir(root, base)
    now = time.time() if now is None else now
    marks = with_aliases(load_marks(d), resolve=True)
    turns = session_turns(marks, key)
    contents = Contents(root, d)
    listed = status_paths(root) or {}
    with _Lock(d):
        prune_views(d, now)
    out_turns, yours = [], []
    for n, t in enumerate(turns, 1):
        start, last = t["start"], t["last"]
        ref = last or start
        name = E.get(ref["agent"]).short_name
        row = {"n": n, "agent": name, "engine": ref["agent"], "start": start and start.get("ts"),
               "end": t["end"] and t["end"].get("ts"), "text": t["text"],
               "files": [], "added": 0, "removed": 0, "commits": [], "own_commits": []}
        out_turns.append(row)
        if not last:
            continue  # still running
        before = start or {"files": {}, "head": last.get("head"), "ts": None}
        paths = set(before["files"]) | set(last["files"]) | heads_diff(root, before.get("head"), last.get("head"))
        heads = [h for h in (before.get("head"), last.get("head")) if h]
        for rel in sorted(paths)[:MAX_STATUS]:
            contents.at_heads(rel, heads)
            a, b = contents.of(before, rel), contents.of(last, rel)
            if a == b or (a and is_binary(a)) or (b and is_binary(b)):
                continue
            added, removed = line_counts(a, b)
            row["files"].append({"rel": rel, "path": os.path.join(shown, rel), "before": view_file(d, rel, a),
                                 "after": view_file(d, rel, b), "added": added, "removed": removed})
            row["added"] += added
            row["removed"] += removed
        commits = commits_between(root, before.get("head"), last.get("head"))
        if commits:
            mine = your_lines_at(root, d, marks, contents, start, set(start["files"]), base) if start else {}
            for c in commits:
                pool = dict((p, list(v)) for p, v in mine.items())
                count = 0
                for p, lines in added_lines(root, c["hash"]).items():
                    have = pool.get(p) or []
                    for line in lines:
                        if line in have:
                            have.remove(line)
                            count += 1
                c.update(yours=count, agent=name)
                row["commits"].append(c)
        # what you changed after this turn, until the session's next turn started (or until now)
        nxt = turns[n]["start"] if n < len(turns) else None
        if nxt is None and n < len(turns):
            continue  # the next turn's start was not seen: nothing to measure against
        # the commits you made yourself after it (the commit button, a terminal), until the next turn
        row["own_commits"] = own_commits(root, marks, last.get("head"), (nxt or {}).get("head") or head_of(root), base)
        lo, hi = last.get("ts") or 0, (nxt.get("ts") if nxt else None)
        cand = set(last["files"]) | (set(nxt["files"]) if nxt else set(listed)) | heads_diff(root, last.get("head"), (nxt or {}).get("head") or head_of(root))
        files = []
        for rel in sorted(cand)[:MAX_STATUS]:
            full = os.path.join(root, rel)
            if rel not in last["files"]:
                contents.at_heads(rel, [last.get("head")])
            a = contents.of(last, rel)
            if nxt:
                if rel not in nxt["files"]:
                    contents.at_heads(rel, [nxt.get("head")])
                b = contents.of(nxt, rel)
            else:
                try:
                    with open(full, "rb") as f:
                        b = f.read()
                except OSError:
                    b = None
            if a == b or b is None or is_binary(b):
                continue
            try:
                bl = blame(full, now=now, base=base, current=b, until=hi, marks=marks)
            except AttrError:
                continue
            nums, times = [], []
            for i, info in enumerate(bl["lines"], 1):
                ts = info.get("ts") or 0
                if info["who"] in ("you", "mix") and lo < ts and (hi is None or ts <= hi):
                    nums.append(i)
                    times.append(ts)
            if not nums:
                continue
            added, removed = line_counts(a, b)
            named = os.path.join(shown, rel)
            files.append({"rel": rel, "path": named, "before": view_file(d, rel, a), "added": added, "removed": removed,
                          "after": view_file(d, rel, b) if nxt else named, "lines": ranges(nums), "count": len(nums),
                          "first": nums[0], "nums": nums[:200], "ts": min(times), "last": max(times)})
        if files:
            told_to = ""
            if nxt:
                told_to = E.get(nxt["agent"]).short_name if any(
                    m.get("session") == key and m["event"] == "start" and m.get("source") in TOLD_BY
                    and abs((m.get("ts") or 0) - (nxt.get("ts") or 0)) <= DEDUP * 4 for m in marks) else ""
            yours.append({"after_turn": n, "anchor": lo, "until": hi, "ts": min(f["ts"] for f in files),
                          "last": max(f["last"] for f in files), "count": sum(f["count"] for f in files),
                          "agent": name, "told": told_to, "next_turn": n + 1 if nxt else None, "files": files})
    return {"ok": True, "root": shown, "session": key, "turns": out_turns, "yours": yours}


# ---------------------------------------------------------------- hooks
def hook_mark(data, agent, now=None, source="hook"):
    """From a hook's JSON (Claude Code, Codex; OpenCode's plugin sends the same shape): a start mark on
    UserPromptSubmit (and the note about your changes for the agent), an end mark on Stop. Never raises."""
    try:
        event = data.get("hook_event_name") or ""
        if data.get("agent_id") or event not in ("UserPromptSubmit", "Stop"):
            return {}
        sid = str(data.get("session_id") or data.get("thread_id") or data.get("conversation_id") or "")
        cwd = data.get("cwd") or os.getcwd()
        if not sid or E.foreign_session(agent, sid):
            return {}
        if event == "UserPromptSubmit":
            said = turn_note(cwd, agent, sid, now=now)
            mark(cwd, "start", agent, sid, text=str(data.get("prompt") or ""), now=now, source=source)
            return {"note": said}
        mark(cwd, "end", agent, sid, now=now, source=source)
    except Exception:  # noqa: BLE001 - a hook must never fail the agent's turn
        return {}
    return {}


# ---------------------------------------------------------------- command line
def parser():
    p = argparse.ArgumentParser(prog="dispatch attribution")
    p.add_argument("op", choices=["mark", "edit", "show", "files", "note", "prune", "steps", "config"])
    p.add_argument("paths", nargs="*")
    p.add_argument("--event", default="")
    p.add_argument("--agent", default="")
    p.add_argument("--session", default="")
    p.add_argument("--host-session", dest="host_session", default="")
    p.add_argument("--cwd", default="")
    p.add_argument("--text", default="")
    p.add_argument("--source", default="", help="mark: who takes it (hook, plugin, window)")
    p.add_argument("--with-note", dest="with_note", action="store_true", help="mark --event start: also answer the note about your changes")
    p.add_argument("--file", default="", help="edit: the file you changed in the editor")
    p.add_argument("--since", type=float, default=None, help="edit: when you began typing (seconds)")
    p.add_argument("--at", type=float, default=None, help="edit: when you saved (seconds)")
    p.add_argument("--co-author", dest="co_author", choices=["on", "off"], default=None, help="config: end agents' commits with a Co-authored-by line")
    p.add_argument("--json", action="store_true")
    return p


def run(argv):
    a = parser().parse_args(argv)
    if a.op == "mark":
        agent, session = a.agent, a.session
        host = host_uri = ""
        if a.host_session:
            agent, session = host_session_key(a.host_session)
            host_uri, host = host_session_uri(a.host_session)
        said = ""
        if a.with_note and a.event == "start":
            said = turn_note(a.cwd or os.getcwd(), agent, session)
        out = mark(a.cwd or os.getcwd(), a.event, agent, session, text=a.text,
                   source=a.source or ("window" if a.host_session else ""), host=host, host_uri=host_uri)
        if said:
            out["note"] = said
        return out
    if a.op == "edit":
        try:
            texts = json.loads(sys.stdin.read() or "{}")
        except ValueError:
            raise AttrError("bad_request", "stdin is {\"before\": text, \"saved\": text}")
        texts = texts if isinstance(texts, dict) else {}
        return edit(a.file or (a.paths[0] if a.paths else ""), texts.get("before"), texts.get("saved"), a.since, a.at)
    if a.op == "show":
        if len(a.paths) != 1:
            raise AttrError("bad_request", "show takes one file")
        return show(a.paths[0])
    if a.op == "files":
        return files(a.paths)
    if a.op in ("note", "steps"):
        agent, session = a.agent, a.session
        if a.host_session:
            agent, session = host_session_key(a.host_session)
        if a.op == "steps":
            return steps(a.cwd or os.getcwd(), agent, session)
        return note(a.cwd or os.getcwd(), agent, session)
    if a.op == "config":
        if a.co_author is not None:
            return dict(save_config({"co_author": a.co_author == "on"}), ok=True)
        return dict(load_config(), ok=True)
    root = project_root(a.cwd or os.getcwd())
    d = store_dir(root)
    with _Lock(d):
        return dict(prune(d), ok=True)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        out = run(argv)
    except AttrError as e:
        out = e.body()
    except SystemExit as e:
        out = {"ok": False, "error": "bad_request", "message": "usage: dispatch attribution mark|edit|show|files|note|steps|config|prune (%s)" % e}
    except Exception as e:  # noqa: BLE001
        out = {"ok": False, "error": "io", "message": "%s: %s" % (type(e).__name__, str(e)[:400])}
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
