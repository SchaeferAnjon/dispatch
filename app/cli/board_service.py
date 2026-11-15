# -*- coding: utf-8 -*-
"""The task board service: one owner of the board inside chatd, so many Agents and the window can
read and write the board at the same time without each one starting its own `bd`.

Why: every `bd` process opens the whole database (100 to 160 MB, a second or more on a big board).
Ten Agents plus the window's views meant dozens of bd processes at once fighting over one embedded
database (load 400+, `dispatch begin` timing out). chatd is resident already, so it runs bd for
everyone instead:

  reads    answered from memory. The whole board (`bd export`, `bd list --all`) is one copy kept up to
           date: after a write only the issues it touched are read again, and the lists the views ask
           for (by status, label, id) are cut from it (Snapshot). Every other answer is kept with the
           versions of what it depends on (the issue list, the ids it mentions, the key-value store); a
           write bumps only those, so `show task-a` stays cached while task-b changes. The same read
           asked by several callers at once runs bd once.
  writes   queued and run one at a time by one writer, in the order they arrived (reads and writes
           take turns: one bd at a time on an embedded board, four against a Dolt server, and the write
           goes ahead of the reads that wait, with a lane of its own on a server). A write is answered
           only after bd finished it, with bd's own output and exit code, so nothing is confirmed
           that is not on disk. On an embedded board (what new users get) no two bd processes ever
           run at the same time.
  changes  every write, and every change made outside the service (bd run by hand, a pull from the
           other Mac), seen in the database's own files, is pushed to subscribers (`board.watch`):
           the window refreshes when something changed instead of asking every few seconds.

The data stays bd's: the service only runs bd commands and never touches the tables, so the format
and bd's own rules (ids, events, Dolt commits) do not change. Without chatd every caller runs bd
itself as before (board_client.py falls back).

Protocol (one JSON object per line on chatd's door, after {"token": …, "board": 1}):
  {"cmd": "board.bd", "rid": r, "argv": [...], "env": {...}, "timeout": s}
      → for a write first {"rid": r, "state": "running"} when its bd starts, then
      → {"rid": r, "code": 0, "stdout": "…", "stderr": "…", "via": "memory" | "bd"}
  {"cmd": "board.watch", "rid": r}   → {"rid": r, "ok": true, "rev": n}, then {"ev": "board_changed", …}
  {"cmd": "board.stats", "rid": r}   → {"rid": r, "ok": true, "stats": {…}}
  {"cmd": "board.refresh", "rid": r} → forget everything read so far
"""
import collections
import hashlib
import json
import os
import queue
import re
import threading
import time

PROTOCOL = 1

# bd subcommands that only read the issues as a whole (lists, counts, exports)
ISSUE_READS = {"list", "export", "count", "ready", "blocked", "search", "query", "stale", "status", "graph",
               "children", "statuses", "types", "history", "diff", "orphans", "lint", "find-duplicates", "duplicates"}
# reads that are not worth keeping (cheap, rare, or about bd itself)
PLAIN_READS = {"version", "where", "info", "context", "ping", "help", "prime", "onboard", "quickstart", "human"}
KV_READ_OPS = {"get", "list", "ls"}
CONFIG_READ_OPS = {"get", "list", "show"}
# global flags that take a value (they may come before the subcommand)
VALUE_FLAGS = {"--actor", "--dolt-auto-commit"}
# flags that point bd at another database: the service does not answer those
OTHER_DB = {"--db", "-C", "--directory", "--global"}
WATCH_EVERY = 0.5       # how often the database's files are looked at for changes made outside
NOTIFY_EVERY = 0.25     # change events are gathered for this long before they go out
CACHE_MAX_BYTES = 256 * 1024 * 1024
SERVER_LANES = 4        # bd processes at once against a Dolt server (an embedded board gets 1)
WRITE_TIMEOUT = 180     # a write runs this long at least, whatever its caller's own limit
SLOW_MS = 2000          # a bd run that took longer is listed in `dispatch board --json` (slow)

ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*-[0-9a-z]{2,}(?:\.[0-9]+)*$")
ID_ANY = re.compile(r"(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9_]*-[0-9a-z]{2,}(?:\.[0-9]+)*)(?![A-Za-z0-9_-])")
SHOW_ONE = re.compile(r"^show\0[A-Za-z][A-Za-z0-9_]*-[0-9a-z]{2,}(?:\.[0-9]+)*\0--json$")


def said_comment(out, tid):
    """The comment `bd comments add --json` answered, as `bd export` / `bd comments` show it (their fields,
    the time rounded to the second the way the database stores it), or None."""
    import datetime
    try:
        c = json.loads(out[out.find("{"):])
        when = datetime.datetime.strptime(c["created_at"].rstrip("Z"), "%Y-%m-%dT%H:%M:%S.%f" if "." in c["created_at"] else "%Y-%m-%dT%H:%M:%S")
    except (ValueError, KeyError, TypeError, AttributeError):
        return None
    if c.get("issue_id") != tid or not isinstance(c.get("id"), str):
        return None
    when = (when + datetime.timedelta(microseconds=500000)).replace(microsecond=0)
    return {"id": c["id"], "issue_id": tid, "author": c.get("author") or "", "text": c.get("text") or "",
            "created_at": when.strftime("%Y-%m-%dT%H:%M:%SZ")}


def created_ids(out):
    """The ids a `bd create` / `bd q` answered: its JSON (one issue or a list), else the id it printed."""
    text = (out or "").strip()
    for start in (text.find("{"), text.find("[")):
        if start < 0:
            continue
        try:
            obj = json.loads(text[start:])
        except ValueError:
            continue
        objs = obj if isinstance(obj, list) else [obj]
        got = [o["id"] for o in objs if isinstance(o, dict) and isinstance(o.get("id"), str) and ID_RE.match(o["id"])]
        if got:
            return got
    words = text.split()
    return [words[0]] if len(words) == 1 and ID_RE.match(words[0]) else []


class Op:
    """What a bd command line does to the board, as far as the cache is concerned.

    kind   "read" or "write"
    scope  read: "issues" (lists), "ids" (one issue and what it mentions), "kv", "all", "none" (not kept)
           write: "issues" (with `ids`), "kv", "all" (anything may have changed)
    """
    __slots__ = ("kind", "scope", "ids", "sub")

    def __init__(self, kind, scope, ids=(), sub=""):
        self.kind, self.scope, self.ids, self.sub = kind, scope, tuple(ids), sub

    def __repr__(self):
        return f"Op({self.kind}, {self.scope}, {list(self.ids)})"


def classify(argv):
    """Op for `bd <argv…>`, or None when the service should not answer it (another database)."""
    argv = [str(x) for x in argv]
    if any(a in OTHER_DB or a.startswith(("--db=", "--directory=")) for a in argv):
        return None
    words = []
    skip = False
    for a in argv:
        if skip:
            skip = False
            continue
        if a in VALUE_FLAGS:
            skip = True
            continue
        if a.startswith("-"):
            continue
        words.append(a)
    if not words or "-h" in argv or "--help" in argv:
        return Op("read", "none")
    sub, rest = words[0], words[1:]
    ids = [w for w in rest if ID_RE.match(w)]
    if sub in PLAIN_READS:
        return Op("read", "none", sub=sub)
    if sub in ISSUE_READS:
        if sub == "export" and any(a in ("-o", "--output") or a.startswith("--output=") for a in argv):
            return Op("read", "none", sub=sub)  # writes a file: run it, keep nothing
        return Op("read", "issues", sub=sub)
    if sub == "show":
        return Op("read", "ids", ids, sub=sub) if ids else Op("read", "issues", sub=sub)
    if sub == "comments":
        if rest and rest[0] in ("add", "delete", "rm", "edit"):
            return Op("write", "issues", ids, sub=sub)
        return Op("read", "ids", ids, sub=sub) if ids else Op("read", "issues", sub=sub)
    if sub == "kv":
        return Op("read" if rest and rest[0] in KV_READ_OPS else "write", "kv", sub=sub)
    if sub in ("memories", "recall"):
        return Op("read", "kv", sub=sub)
    if sub in ("remember", "forget"):
        return Op("write", "kv", sub=sub)
    if sub == "config":
        return Op("read" if rest and rest[0] in CONFIG_READ_OPS else "write", "kv" if rest and rest[0] in CONFIG_READ_OPS else "all", sub=sub)
    if sub == "sql":
        q = (rest[0] if rest else "").lstrip().lower()
        return Op("read", "all", sub=sub) if q.startswith(("select", "show", "describe", "explain", "with")) else Op("write", "all", sub=sub)
    if sub == "vc" and rest and rest[0] in ("status", "log"):
        return Op("read", "all", sub=sub)
    if sub == "dep" and rest and rest[0] in ("list", "tree", "cycles"):
        return Op("read", "issues", sub=sub)
    if sub == "label" and rest and rest[0] in ("list", "list-all"):
        return Op("read", "issues", sub=sub)
    if sub in ("update", "close", "reopen", "comment", "label", "dep", "create", "q", "assign", "priority", "tag",
               "note", "set-state", "defer", "undefer", "supersede", "duplicate", "promote", "link", "delete", "todo",
               "batch", "epic", "gate", "children"):
        return Op("write", "issues", ids, sub=sub)
    return Op("write", "all", ids, sub=sub)  # anything else may change anything


def noms_dirs(beads_dir, home=None):
    """Where this board's Dolt files are, most likely first (embedded, the shared server, a server of its own)."""
    home = home or os.path.expanduser("~")
    db = "task"
    mode = ""
    try:
        with open(os.path.join(beads_dir, "metadata.json"), encoding="utf-8") as f:
            meta = json.load(f)
        db = meta.get("dolt_database") or db
        mode = meta.get("dolt_mode") or ""
    except (OSError, ValueError):
        pass
    cands = [os.path.join(beads_dir, "embeddeddolt", db, ".dolt", "noms")]
    server = [os.path.join(home, ".beads", "shared-server", "dolt", db, ".dolt", "noms"),
              os.path.join(beads_dir, "dolt", db, ".dolt", "noms"),
              os.path.join(beads_dir, "dolt", ".dolt", "noms")]
    return (server + cands) if mode == "server" else (cands + server)


def board_mode(beads_dir):
    try:
        with open(os.path.join(beads_dir, "metadata.json"), encoding="utf-8") as f:
            return json.load(f).get("dolt_mode") or "embedded"
    except (OSError, ValueError):
        return "embedded"


TABLE_FILE = re.compile(r"^[0-9a-v]{32}(\.darc)?$")  # Dolt's table files and its journal (32 v's)


def signature(noms):
    """A fingerprint of the database's files that changes when data is written and not when it is read:
    the manifest's bytes and the sizes of the table files and the journal (both only ever grow or get
    replaced). Reads touch the files' times and write the manifest again through a temp file
    (nbs_manifest_<n>), so times and other names are left out. None when the folder is not there."""
    if not noms:
        return None
    try:
        h = hashlib.sha1()
        for name in sorted(os.listdir(noms)):
            p = os.path.join(noms, name)
            if name == "manifest":
                with open(p, "rb") as f:
                    h.update(b"m" + f.read())
            elif TABLE_FILE.match(name):
                h.update(("%s:%d;" % (name, os.stat(p).st_size)).encode())
        return h.hexdigest()
    except OSError:
        return None


# ---- the whole board in memory ------------------------------------------------------------------
#
# The views and the hooks read the whole board again and again (`bd export` for the Tasks tab, the
# Assistant's home, Now and Next up; `bd list --all` for prime; `bd list --status …` for Waiting), and
# every write made those answers stale, so one comment from any Agent cost the next reader a 5-6 MB
# bd run (418 whole-board lists in 2 h on 10-10, each 6-14 s at load 190). The service keeps one copy of
# each instead and, after a write, reads again only the issues it touched (`bd list --id a,b --all`,
# plus `bd comments <id>` where the comments changed): the old data stays, the changes are applied.
# `list` with only the flags below is answered from the copy; anything else still goes to bd.

SNAP_STATUSES = {"open", "in_progress", "blocked", "deferred", "closed"}
SNAP_VALUE_FLAGS = {"-n": "limit", "--limit": "limit", "-s": "status", "--status": "status", "-l": "label",
                    "--label": "label", "--label-any": "any", "--id": "id"}
# writes after which re-reading the issues named in them (and their parents and what they depend on) is enough
SNAP_ID_WRITES = {"update", "close", "reopen", "comments", "comment", "label", "dep", "create", "q", "assign",
                  "priority", "tag", "note", "set-state", "defer", "undefer", "duplicate", "supersede", "promote", "link"}
SNAP_FULL = ["list", "--all", "-n", "0", "--json"]
SNAP_COMMENT_READS = 3  # issues whose comments are read one by one; more, and the export is read again whole


def snapshot_query(argv):
    """What a whole-board read asks of the copy in memory, or None when bd has to answer it: `export`
    alone, or `list --json` with nothing but --all, -n/--limit, --status, --label, --label-any and --id."""
    argv = [str(a) for a in argv]
    if argv == ["export"]:
        return {"kind": "export"}
    if not argv or argv[0] != "list":
        return None
    q = {"kind": "list", "all": False, "json": False, "limit": 0, "status": None, "label": [], "any": [], "id": None}
    i = 1
    while i < len(argv):
        a = argv[i]
        name, eq, val = a.partition("=") if a.startswith("--") else (a, "", "")
        if name in ("--json", "--all") and not eq:
            q[name[2:]] = True
            i += 1
            continue
        field = SNAP_VALUE_FLAGS.get(name)
        if field is None:
            return None
        if not eq:
            if i + 1 >= len(argv):
                return None
            val = argv[i + 1]
            i += 2
        else:
            i += 1
        parts = [p.strip() for p in val.split(",") if p.strip()]
        if field == "limit":
            if not val.isdigit():
                return None
            q["limit"] = int(val)
        elif field == "status":
            if not parts or any(p not in SNAP_STATUSES for p in parts):
                return None
            q["status"] = set(parts)  # bd: a second --status replaces the first
        elif field == "id":
            q["id"] = set(parts)
        else:
            q[field] += parts  # repeated --label / --label-any add up, like bd's
    return q if q["json"] else None


def snapshot_rows(rows, q):
    """The rows of `rows` (in bd's order) that `bd list` with the query `q` answers."""
    out = []
    want_all, status, labels, any_of, ids = q["all"], q["status"], q["label"], q["any"], q["id"]
    for r in rows:
        st = r.get("status")
        if status is not None:
            if st not in status:
                continue
        elif not want_all and st == "closed":
            continue
        if ids is not None and r.get("id") not in ids:
            continue
        if labels or any_of:
            have = set(r.get("labels") or ())
            if labels and not all(x in have for x in labels):
                continue
            if any_of and not any(x in have for x in any_of):
                continue
        out.append(r)
        if q["limit"] and len(out) >= q["limit"]:
            break
    return out


def bd_order(rows):
    """bd's own order for list and export: priority first, then the newest, then the id."""
    rows = sorted(rows, key=lambda r: str(r.get("id") or ""))
    rows.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
    rows.sort(key=lambda r: r.get("priority") if isinstance(r.get("priority"), int) else 99)
    return rows


def parse_rows(kind, out):
    """The issues in a `bd export` (JSON lines) or `bd list --json` answer; ValueError when it is not one."""
    if kind == "export":
        rows = []
        for line in out.splitlines():
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if isinstance(row, dict) and row.get("_type", "issue") == "issue" and row.get("id"):
                rows.append(row)
        return rows
    start = out.find("[")
    if start < 0:
        if out.strip() in ("", "null"):
            return []
        raise ValueError("bd list did not answer a list")
    rows = json.loads(out[start:])
    if not isinstance(rows, list):
        raise ValueError("bd list did not answer a list")
    return [r for r in rows if isinstance(r, dict) and r.get("id")]


def export_row(list_row, comments):
    """An issue as `bd export` writes it, from `bd list --json`'s row and its comments: the same fields,
    without `parent`, with `_type` and with `comments` when it has any (checked on the real board, 10-10)."""
    row = {"_type": "issue"}
    row.update((k, v) for k, v in list_row.items() if k != "parent")
    if comments:
        row["comments"] = comments
    return row


class Snapshot:
    """The whole board as one bd command answers it ("list": `bd list --all -n 0 --json`, "export":
    `bd export`), complete up to revision `rev`. `answers` keeps the text of each query asked since the
    last change."""

    def __init__(self, kind, rows, rev):
        self.kind = kind
        self.rev = rev
        self.by_id = {r["id"]: r for r in rows}
        self.types = {r.get("issue_type") for r in rows}
        self._order = None
        self.answers = {}

    def rows(self):
        if self._order is None:
            self._order = bd_order(self.by_id.values())
        return self._order

    def apply(self, ids, fresh, comments):
        """The issues `ids` read again: `fresh` {id: list row} (missing: deleted), `comments` {id: [...]}
        for those whose comments were read again. False when the copy cannot take it (export: an issue of
        a kind it does not hold, which bd export may leave out): read it whole next time."""
        for i in ids:
            row = fresh.get(i)
            if row is None:
                self.by_id.pop(i, None)
                continue
            if self.kind == "list":
                self.by_id[i] = row
                continue
            old = self.by_id.get(i)
            if old is None and row.get("issue_type") not in self.types:
                return False
            self.by_id[i] = export_row(row, comments[i] if i in comments else (old or {}).get("comments"))
        self._order = None
        self.answers = {}
        return True

    def answer(self, key, q):
        hit = self.answers.get(key)
        if hit is None:
            if self.kind == "export":
                out = "".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in self.rows())
            else:
                out = json.dumps(snapshot_rows(self.rows(), q), ensure_ascii=False, indent=2) + "\n"
            hit = self.answers[key] = (0, out, "")
        return hit


WRITE_JUMPS = 2  # writes in a row that may go ahead of a waiting read before one read gets its turn


class Slots:
    """`n` bd processes at a time. Reads are handed out first come, first served; the write (there is
    one writer) goes ahead of the reads that wait, up to WRITE_JUMPS in a row, and with more than one
    lane one lane is kept for it, so a change is never stuck behind a row of slow whole-board reads
    (10-10: `dispatch begin` waited 20 s and more behind them at load 190), and a steady stream of
    writes on a one-lane board does not starve the reads either. A waiter whose `give_up()` turns
    true (another show took its id along) leaves the line without running anything."""

    def __init__(self, n):
        self.n = n
        self.read_cap = n - 1 if n > 1 else n
        self.busy = 0
        self.reading = 0
        self.writer_waiting = 0
        self.readers_waiting = 0
        self.jumped = 0  # writes that went ahead of a waiting read since the last read started
        self.next_ticket = 0
        self.serving = 0
        self.skipped = set()
        self.cv = threading.Condition()

    def acquire_write(self):
        with self.cv:
            self.writer_waiting += 1
            try:
                while self.busy >= self.n or (self.readers_waiting and self.jumped >= WRITE_JUMPS and self.reading < self.read_cap):
                    self.cv.wait()
            finally:
                self.writer_waiting -= 1
            if self.readers_waiting:
                self.jumped += 1
            self.busy += 1

    def release_write(self):
        with self.cv:
            self.busy -= 1
            self.cv.notify_all()

    def acquire(self, give_up=None):
        with self.cv:
            me = self.next_ticket
            self.next_ticket += 1
            self.readers_waiting += 1
            try:
                while me != self.serving or self.busy >= self.n or self.reading >= self.read_cap or (
                        self.writer_waiting and self.jumped < WRITE_JUMPS):
                    if give_up is not None and give_up():
                        self.skipped.add(me)
                        self._advance()
                        self.cv.notify_all()
                        return False
                    self.cv.wait()
            finally:
                self.readers_waiting -= 1
            self.serving += 1
            self._advance()
            self.busy += 1
            self.reading += 1
            self.jumped = 0
            self.cv.notify_all()
            return True

    def _advance(self):
        while self.serving in self.skipped:
            self.skipped.discard(self.serving)
            self.serving += 1

    def poke(self):
        with self.cv:
            self.cv.notify_all()

    def release(self):
        with self.cv:
            self.busy -= 1
            self.reading -= 1
            self.cv.notify_all()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *exc):
        self.release()


class Job:
    """One queued write. `cancelled`: its caller went away before it started, so it never runs."""
    __slots__ = ("argv", "env", "timeout", "op", "result", "done", "on_start", "queued_at", "started", "cancelled", "said")

    def __init__(self, argv, env, timeout, op, on_start=None):
        self.argv, self.env, self.timeout, self.op = argv, env, timeout, op
        self.result = None
        self.done = threading.Event()
        self.on_start = on_start
        self.queued_at = time.monotonic()
        self.started = False
        self.cancelled = False
        self.said = None  # `comments add`: the comment as bd stored it (said_comment)


class Flight:
    """One bd run for a read that several callers asked for at once. `start`: the revision when its bd
    started (None while it waits for its turn: whoever joins then gets an answer newer than now).
    `preset`: the answer another show's bd run brought along (show batching)."""
    __slots__ = ("start", "done", "result", "ids", "preset")

    def __init__(self):
        self.start = None
        self.done = threading.Event()
        self.result = None
        self.ids = ()
        self.preset = None


class BoardService:
    """`bd(argv, env, timeout)` answers like running `bd argv` with that environment would."""
    PROTOCOL = PROTOCOL

    def __init__(self, beads_dir, run, lanes=None, noms=None, watch_every=WATCH_EVERY, clock=time.monotonic):
        self.beads_dir = os.path.realpath(beads_dir)
        self.mode = board_mode(self.beads_dir)
        self.run = run  # run(argv, env, timeout) -> (code, stdout, stderr); argv without the leading "bd"
        self.lanes = lanes or (SERVER_LANES if self.mode == "server" else 1)
        self.slots = Slots(self.lanes)
        self.clock = clock
        self.lock = threading.RLock()
        self.scope_rev = {"reset": 0, "issues": 0, "kv": 0}
        self.idrev = {}
        self.cache = collections.OrderedDict()  # key -> (start revision, result, size, ids it mentions)
        self.cache_bytes = 0
        self.flights = {}
        self.show_queue = {}  # id -> Flight: single shows waiting for their turn (show batching)
        self.rev = 0
        self.writes = queue.Queue()
        self.pending_writes = 0
        self.writing = False
        self.last_write = 0.0
        self.closing = False
        self.closed = threading.Event()
        self.watchers = []
        self.changes = {"ids": set(), "kv": False, "all": False, "issues": False}
        self.change_cv = threading.Condition(self.lock)
        self.stats = collections.Counter()
        self.max_queue = 0
        self.write_ms = []
        self.wait_ms = []
        self.slow = collections.deque(maxlen=30)
        self.failed = collections.deque(maxlen=20)
        self.snaps = {"list": None, "export": None}  # the whole board in memory (Snapshot), kept up to date
        self.snap_lock = threading.Lock()
        self.snap_dirty = {}  # id -> revision of its last change: what the snapshots read again
        self.snap_reset = 0   # revision after which the snapshots are read again whole
        self.snap_said = {}   # id -> [(revision, comment)]: comments the writes answered (`comments add`)
        self.find_noms = noms is None
        if noms is None:
            noms = next((d for d in noms_dirs(self.beads_dir) if os.path.isdir(d)), None)
        self.noms = noms
        self.known_sig = signature(self.noms)
        self.watch_every = watch_every
        self.started = time.time()
        self.snap_kick = threading.Event()
        self.threads = [threading.Thread(target=self._writer, name="board-writer", daemon=True),
                        threading.Thread(target=self._notifier, name="board-notify", daemon=True),
                        threading.Thread(target=self._background, name="board-watch", daemon=True),
                        threading.Thread(target=self._snap_keeper, name="board-snapshot", daemon=True)]
        for t in self.threads:
            t.start()

    # ---- what the cache depends on ---------------------------------------------------------------
    #
    # Every change gets the next revision number. A scope ("reset", "issues", "kv") and an id remember
    # the revision of their last change; an answer remembers the revision when its bd started. It is
    # still good while nothing it depends on changed after that.

    def _valid(self, start, op, ids):
        sr = self.scope_rev
        if sr["reset"] > start:
            return False
        if op.scope == "issues":
            return sr["issues"] <= start
        if op.scope == "kv":
            return sr["kv"] <= start
        if op.scope == "all":
            return sr["issues"] <= start and sr["kv"] <= start
        if op.scope == "ids":
            return all(self.idrev.get(i, 0) <= start for i in ids)
        return False

    def _mentioned(self, op, stdout):
        """The ids a `show` / `comments` answer depends on: the ones asked for and every one it mentions."""
        ids = set(op.ids)
        prefixes = {i.rsplit("-", 1)[0] for i in op.ids if "-" in i}
        if prefixes and stdout:
            pat = re.compile(r'"((?:%s)-[0-9a-z]{2,}(?:\.[0-9]+)*)"' % "|".join(re.escape(p) for p in prefixes))
            ids.update(pat.findall(stdout))
        return tuple(sorted(ids))

    def _bump(self, op):
        """A write of `op` finished: everything that depends on what it touched is out of date."""
        with self.lock:
            self.rev += 1
            if op.scope == "all":
                self.scope_rev["reset"] = self.rev
                self.snap_reset = self.rev
                self.changes["all"] = True
            elif op.scope == "kv":
                self.scope_rev["kv"] = self.rev
                self.changes["kv"] = True
            else:
                self.scope_rev["issues"] = self.rev
                self.changes["issues"] = True
                for i in op.ids:
                    self.idrev[i] = self.rev
                    self.changes["ids"].add(i)
            self.change_cv.notify_all()

    def forget(self, why="refresh"):
        """Something changed that the service did not do itself: nothing read so far can be trusted."""
        with self.lock:
            self.rev += 1
            self.scope_rev["reset"] = self.rev
            self.snap_reset = self.rev
            self.changes["all"] = True
            self.stats["reset_" + why] += 1
            self.change_cv.notify_all()

    # ---- the one entry point ---------------------------------------------------------------------

    def bd(self, argv, env=None, timeout=20, on_start=None, jobs=None):
        """(code, stdout, stderr, via) for `bd argv`. `env`: the caller's BEADS_* / BD_* variables.
        `jobs`: a list the queued write is added to, so a caller that goes away can cancel it."""
        argv = [str(a) for a in argv]
        op = classify(argv)
        if op is None:
            raise ValueError("this command names another database")
        env = dict(env or {})
        if op.kind == "write":
            return self._write(argv, env, timeout, op, on_start, jobs)
        return self._read(argv, env, timeout, op)

    def cancel(self, job):
        """Drop a queued write whose caller went away. False when it already started (it finishes)."""
        with self.lock:
            if job.started or job.done.is_set():
                return False
            job.cancelled = True
            return True

    def _read(self, argv, env, timeout, op):
        key = tuple(argv)
        q = snapshot_query(argv)
        if q is not None:
            return self._snap_read(key, q, env, timeout)
        if op.scope == "none":
            self.stats["reads_run"] += 1
            return self._run_slot(argv, env, timeout) + ("bd",)
        while True:
            with self.lock:
                hit = self.cache.get(key)
                if hit is not None and self._valid(hit[0], op, hit[3]):
                    self.cache.move_to_end(key)
                    self.stats["reads_memory"] += 1
                    return hit[1] + ("memory",)
                fl = self.flights.get(key)
                if fl is not None and (fl.start is None or self._valid(fl.start, op, op.ids)):
                    lead = False
                else:
                    fl = Flight()
                    self.flights[key] = fl
                    lead = True
            if not lead:
                fl.done.wait(timeout + 60)
                with self.lock:
                    ok = fl.result is not None and fl.result[0] == 0 and fl.start is not None and self._valid(fl.start, op, fl.ids)
                if ok:
                    self.stats["reads_shared"] += 1
                    return fl.result + ("memory",)
                continue  # the leader failed, or something it mentions changed meanwhile: ask again
            try:
                if SHOW_ONE.match("\0".join(argv)):
                    res = self._show_batched(argv[1], fl, env, timeout)
                else:
                    res = self._run_slot(argv, env, timeout, fl)
                    self.stats["reads_run"] += 1
                    self.stats["read:" + op.sub] += 1
            except Exception as e:
                res = (1, "", "board service: %s" % e)
            with self.lock:
                fl.ids = self._mentioned(op, res[1]) if op.scope == "ids" else ()
                if fl.start is None:
                    fl.start = -1  # never ran: nothing it says is kept
                # a failure is not kept (the next caller asks bd again), except a key that is not set:
                # any key-value write makes that stale anyway
                keep = res[0] == 0 or (op.scope == "kv" and ("(not set)" in res[1] or '"found": false' in res[1]))
                if keep and fl.start >= 0:
                    self._store(key, fl.start, res, fl.ids)
                fl.result = res
                if self.flights.get(key) is fl:
                    del self.flights[key]
            fl.done.set()
            return res + ("bd",)

    # ---- the whole board in memory (Snapshot) ------------------------------------------------------

    def _snap_read(self, key, q, env, timeout):
        ran = self.stats["reads_run"]
        with self.lock:
            want = self.rev  # every write answered before this read asked: it must see them
        with self.snap_lock:
            got = self._snap_sync(q["kind"], env, timeout, want)
            if isinstance(got, tuple):  # bd failed: its own answer, nothing kept
                return got + ("bd",)
            res = got.answer(key, q)
            ran = self.stats["reads_run"] != ran  # this call brought the copy up to date itself
        if not ran:
            self.stats["reads_memory"] += 1
        self.stats["reads_snapshot"] += 1
        return res + ("bd" if ran else "memory",)

    def _snap_sync(self, kind, env, timeout, want=None):
        """The snapshot `kind` brought up to `want` (default: now), snap_lock held: read whole the first time
        and after a change it cannot follow, else only the issues changed since (with one `bd list --id` for
        every snapshot that is behind). A reader that waited while another brought it up to date after it
        asked takes that (one re-read for everyone in line). (code, out, err) when bd failed."""
        with self.lock:
            start, reset = self.rev, self.snap_reset
            for k, v in self.snaps.items():
                if v is not None and v.rev < reset:
                    self.snaps[k] = None
            snap = self.snaps[kind]
            if snap is not None and snap.rev >= (start if want is None else want):
                return snap
            behind = [v for v in self.snaps.values() if v is not None and v.rev < start]
            since = min((v.rev for v in behind), default=start)
            dirty = {i: rc for i, rc in self.snap_dirty.items() if rc[0] > since}
            said = {i: [rc for rc in lst if rc[0] > since] for i, lst in self.snap_said.items()}
        if snap is None:
            return self._snap_load(kind, start, env, timeout)
        if dirty:
            got = self._snap_refresh(behind, sorted(dirty), dirty, said, env, timeout)
            if isinstance(got, tuple):
                return got
            behind = [v for v in behind if v.kind not in got]
            if kind in got:  # too many comments to read one by one, or a kind it does not hold: whole
                return self._snap_load(kind, start, env, timeout)
        for v in behind:
            v.rev = max(v.rev, start)
        self._snap_prune()
        return snap

    def _snap_load(self, kind, start, env, timeout):
        """The whole board read into a new snapshot complete up to `start`, or bd's failed answer."""
        res = self._run_slot(["export"] if kind == "export" else SNAP_FULL, env, timeout)
        self.stats["reads_run"] += 1
        self.stats["snap_loads"] += 1
        if res[0] != 0:
            return res
        try:
            snap = Snapshot(kind, parse_rows(kind, res[1]), start)
        except ValueError:
            return res  # not what bd usually says: hand it on as it is
        with self.lock:
            self.snaps[kind] = snap
        return snap

    def _snap_refresh(self, snaps, ids, dirty, said, env, timeout):
        """Read the issues `ids` again and apply them to `snaps`. `dirty` {id: (revision, comments changed
        untold)}, `said` {id: [(revision, comment the write answered)]}. (code, out, err) when bd failed,
        else the kinds dropped to be read whole: an export whose comments changed untold on more issues than
        SNAP_COMMENT_READS (one `bd export` is cheaper than a `bd comments` for each)."""
        res = self._run_slot(["list", "--all", "-n", "0", "--json", "--id", ",".join(ids)], env, timeout)
        self.stats["reads_run"] += 1
        self.stats["snap_refreshes"] += 1
        self.stats["snap_ids"] += len(ids)
        if res[0] != 0:
            return res
        try:
            fresh = {r["id"]: r for r in parse_rows("list", res[1])}
        except ValueError:
            return res
        dropped, comments_of = [], {}
        for v in snaps:
            if v.kind != "export":
                continue
            comments, need = {}, []
            for i in ids:
                row = fresh.get(i)
                if row is None:
                    continue
                count = row.get("comment_count") or 0
                old = (v.by_id.get(i) or {}).get("comments") or []
                untold = dirty.get(i, (0, False))[1] and dirty[i][0] > v.rev
                new = [c for r, c in said.get(i) or () if r > v.rev]
                if count == 0:
                    comments[i] = []
                elif not untold and new and count == len(old) + len(new):
                    # the comments the writes added, as bd answered them: nothing to read
                    comments[i] = old + sorted(new, key=lambda c: (str(c.get("created_at")), str(c.get("id"))))
                    self.stats["snap_comments_said"] += len(new)
                elif untold or count != len(old):
                    need.append(i)
            if len(need) > SNAP_COMMENT_READS:
                self.stats["snap_comment_reloads"] += 1
                dropped.append(v.kind)
                continue
            for i in need:
                got = self._run_slot(["comments", i, "--json"], env, timeout)
                self.stats["reads_run"] += 1
                self.stats["snap_comment_reads"] += 1
                if got[0] != 0:
                    return got
                try:
                    parsed = json.loads(got[1][got[1].find("["):]) if "[" in got[1] else []
                except ValueError:
                    return got
                comments[i] = parsed if isinstance(parsed, list) else []
            comments_of[v.kind] = comments
        with self.lock:
            for v in snaps:
                if v.kind in dropped:
                    self.snaps[v.kind] = None
                elif not v.apply(ids, fresh, comments_of.get(v.kind, {})):
                    self.snaps[v.kind] = None
                    dropped.append(v.kind)
                    self.stats["snap_dropped"] += 1
        return dropped

    def _snap_prune(self):
        with self.lock:
            live = [v.rev for v in self.snaps.values() if v is not None]
            floor = min(live) if live else self.rev
            for i in [i for i, (r, _c) in self.snap_dirty.items() if r <= floor]:
                del self.snap_dirty[i]
            for i in list(self.snap_said):
                self.snap_said[i] = [(r, c) for r, c in self.snap_said[i] if r > floor]
                if not self.snap_said[i]:
                    del self.snap_said[i]

    def _snap_mark(self, job, res):
        """After a write: the issues the snapshots read again (by id), or all of it when it cannot tell."""
        op = job.op
        if op.scope == "kv":
            return
        with self.lock:
            if op.scope == "all" or op.sub not in SNAP_ID_WRITES or (
                    op.sub in ("create", "q") and any(a in ("-f", "--file", "--graph") for a in job.argv)):
                self.snap_reset = self.rev
                self.stats["snap_resets"] += 1
                return
            ids = set(op.ids)
            for i in ID_ANY.findall("\0".join(job.argv)):
                ids.add(i)
            if op.sub in ("create", "q"):
                made = created_ids(res[1]) if res[0] == 0 else []
                if res[0] == 0 and not made:
                    self.snap_reset = self.rev
                    self.stats["snap_resets"] += 1
                    return
                ids.update(made)
            known = set()
            for v in self.snaps.values():
                if v is not None:
                    known.update(v.by_id)
            # an id named only in the text (a comment that mentions another task) is read again only when
            # the copy has it; the ones the command is about always are
            ids = {i for i in ids if i in known or i in op.ids or (op.sub in ("create", "q"))}
            for v in self.snaps.values():
                if v is None:
                    continue
                for i in list(ids):
                    row = v.by_id.get(i) or {}
                    if row.get("parent"):
                        ids.add(row["parent"])
                    for d in row.get("dependencies") or ():
                        if isinstance(d, dict) and d.get("depends_on_id"):
                            ids.add(d["depends_on_id"])
            said = getattr(job, "said", None)
            talk = op.sub in ("comments", "comment") and said is None  # comments changed, not told how
            if said is not None:
                self.snap_said.setdefault(said["issue_id"], []).append((self.rev, said))
            for i in ids:
                prev = self.snap_dirty.get(i)
                self.snap_dirty[i] = (self.rev, talk or bool(prev and prev[1]))
        self.snap_kick.set()

    def _snap_keeper(self):
        """Bring the snapshots up to date soon after a burst of writes, so the next reader finds them
        ready instead of waiting for the re-read."""
        while not self.closed.is_set():
            if not self.snap_kick.wait(1.0):
                continue
            self.snap_kick.clear()
            if self.closed.wait(NOTIFY_EVERY):
                return
            with self.lock:
                kinds = [k for k, v in self.snaps.items() if v is not None]
                busy = self.pending_writes > 0
            if busy:
                self.snap_kick.set()  # more writes waiting: after them
                continue
            for kind in kinds:
                try:
                    with self.snap_lock:
                        self._snap_sync(kind, {}, 60)
                except Exception:
                    self.stats["background_errors"] += 1

    def _note(self, argv, res, ms, wait_ms=0):
        """Slow and failed bd runs, kept for `dispatch board --json`."""
        # `bd kv get` of a key nobody set exits 1 with "(not set)" or {"found": false}: the answer, not a failure
        if res[0] != 0 and argv[:2] == ["kv", "get"] and ("(not set)" in res[1] or '"found": false' in res[1]):
            res = (0, res[1], res[2])
        if res[0] == 0 and ms < SLOW_MS:
            return
        row = {"at": round(time.time(), 1), "cmd": " ".join(str(a) for a in argv[:2]), "code": res[0], "ms": ms, "wait_ms": wait_ms}
        if res[0] != 0:
            row["error"] = (res[2] or res[1] or "").strip()[-200:]
            self.failed.append(row)
        else:
            self.slow.append(row)

    def _store(self, key, snap, res, ids):
        size = len(res[1]) + len(res[2]) + 64
        old = self.cache.pop(key, None)
        if old is not None:
            self.cache_bytes -= old[2]
        self.cache[key] = (snap, res, size, ids)
        self.cache_bytes += size
        while self.cache_bytes > CACHE_MAX_BYTES and self.cache:
            _, ev = self.cache.popitem(last=False)
            self.cache_bytes -= ev[2]

    def _show_batched(self, tid, fl, env, timeout):
        """`bd show <tid> --json`, run together with every other single show waiting for its turn at the
        same time: one `bd show a b c --json` instead of three processes (ten Agents each reading
        their own task after each write). bd answers the same object for an id either way."""
        with self.lock:
            self.show_queue.setdefault(tid, []).append(fl)
        if not self.slots.acquire(give_up=lambda: fl.preset is not None):
            self.stats["reads_batched"] += 1
            return fl.preset
        try:
            with self.lock:
                if fl.preset is not None:
                    self.stats["reads_batched"] += 1
                    return fl.preset
                batch = self.show_queue
                self.show_queue = {}
                batch.setdefault(tid, [])
                if fl not in batch[tid]:
                    batch[tid].append(fl)
                for flights in batch.values():
                    for f in flights:
                        if f.start is None:
                            f.start = self.rev
            ids = list(batch)
            results = {}
            if len(ids) > 1:
                self.stats["bd_started"] += 1
                self.stats["reads_run"] += 1
                self.stats["read:show"] += 1
                self.stats["show_batches"] += 1
                code, out, _err = self.run(["show"] + ids + ["--json"], env, timeout)
                if code == 0:
                    try:
                        objs = json.loads(out[out.find("["):]) if "[" in out else []
                    except ValueError:
                        objs = []
                    by_id = {o.get("id"): o for o in objs if isinstance(o, dict)}
                    for i in ids:
                        if i in by_id:
                            results[i] = (0, json.dumps([by_id[i]], ensure_ascii=False, indent=2) + "\n", "")
            for i in ids:
                if i not in results:  # alone, or not found / not answered in the batch: bd's own words
                    self.stats["bd_started"] += 1
                    self.stats["reads_run"] += 1
                    self.stats["read:show"] += 1
                    results[i] = self.run(["show", i, "--json"], env, timeout)
        finally:
            self.slots.release()
        with self.lock:
            for i, flights in batch.items():
                for other in flights:
                    if other is not fl:
                        other.preset = results[i]
        self.slots.poke()
        return results[tid]

    def _run_slot(self, argv, env, timeout, fl=None):
        with self.slots:
            if fl is not None:
                with self.lock:
                    fl.start = self.rev  # what it answers includes every change up to here
            self.stats["bd_started"] += 1
            t0 = time.monotonic()
            res = self.run(argv, env, timeout)
            self._note(argv, res, int((time.monotonic() - t0) * 1000))
            return res

    # ---- writes: one at a time, in order ---------------------------------------------------------

    def _write(self, argv, env, timeout, op, on_start, jobs=None):
        job = Job(argv, env, timeout, op, on_start)
        with self.lock:
            if self.closing:
                raise RuntimeError("the board service is stopping")
            self.pending_writes += 1
            self.max_queue = max(self.max_queue, self.pending_writes)
            if jobs is not None:
                jobs[:] = [j for j in jobs if not j.done.is_set()]
                jobs.append(job)
        self.writes.put(job)
        job.done.wait()
        return job.result

    def _writer(self):
        while True:
            job = self.writes.get()
            if job is None:
                return
            with self.lock:
                if job.cancelled:
                    self.pending_writes -= 1
                    self.stats["writes_cancelled"] += 1
                    job.result = (1, "", "cancelled: the caller went away", "bd")
                    job.done.set()
                    continue
                job.started = True
            # one slot: on an embedded board that is the only one, so no other bd runs beside it
            self.slots.acquire_write()
            try:
                self._check_outside()
                pre = self._show_before(job)
                with self.lock:
                    self.writing = True
                if job.on_start:
                    try:
                        job.on_start()
                    except Exception:
                        pass
                t0 = self.clock()
                self.wait_ms.append(int((t0 - job.queued_at) * 1000))
                del self.wait_ms[:-500]
                try:
                    self.stats["bd_started"] += 1
                    # a write is never cut off at the caller's 20 s: killed in the middle it may or may not
                    # be saved, and the caller is told it failed (10 of 92 on 10-10); it waits its turn instead
                    res = self._run_write(job)
                except Exception as e:
                    res = (1, "", "board service: %s" % e)
                ms = int((self.clock() - t0) * 1000)
                self.write_ms.append(ms)
                del self.write_ms[:-500]
                self._note(job.argv, res, ms, self.wait_ms[-1])
                with self.lock:
                    self.known_sig = signature(self.noms)
                    self.writing = False
                    self.last_write = self.clock()
            finally:
                self.slots.release_write()
            self.stats["writes"] += 1
            if res[0] != 0:
                self.stats["writes_failed"] += 1
            derived = self._derive_show(job, pre, res)
            self._bump(job.op)  # before the answer: whoever reads next sees this write
            self._snap_mark(job, res)
            if derived is not None:
                with self.lock:
                    self._store(derived[0], self.rev, derived[1], derived[2])
                    self.stats["shows_derived"] += 1
            with self.lock:
                self.pending_writes -= 1
            job.result = res + ("bd",)
            job.done.set()

    def _run_write(self, job):
        """bd for a write. `comments add` without --json runs with it, so the comment bd stored (its id and
        time) goes straight into the export in memory instead of a `bd comments` read per issue; the caller
        gets the line bd prints without --json."""
        a = job.argv
        timeout = max(job.timeout, WRITE_TIMEOUT)
        if not (len(a) >= 4 and a[0] == "comments" and a[1] == "add" and ID_RE.match(a[2])
                and not any(x == "--json" or x.startswith("--json=") for x in a)):
            return self.run(a, job.env, timeout)
        code, out, err = self.run(list(a) + ["--json"], job.env, timeout)
        if code != 0:
            return code, out, err
        job.said = said_comment(out, a[2])
        return code, "Comment added to %s\n" % a[2], err

    # ---- a task's own show after a write to it --------------------------------------------------
    #
    # An Agent writes to its task and reads it right back (`dispatch log` then `dispatch task plan`).
    # For the two commonest writes the new `bd show` is known without asking bd: a comment adds one to
    # comment_count and changes nothing else; `bd update <id> … --json` answers the issue's own fields,
    # which replace those in the show (the counts and the dependency lists stay as they were).

    def _show_target(self, job):
        """The one id a comment or an update writes to, when only that id is touched, else None."""
        a = job.argv
        if job.op.ids and len(set(job.op.ids)) != 1:
            return None
        if len(a) >= 4 and a[0] == "comments" and a[1] == "add" and ID_RE.match(a[2]) and set(job.op.ids) == {a[2]}:
            return a[2]
        if len(a) >= 3 and a[0] == "update" and ID_RE.match(a[1]) and "--json" in a and set(job.op.ids) == {a[1]} \
                and not any(x.startswith(("--parent", "--deps", "--dep")) for x in a):
            return a[1]
        return None

    def _show_before(self, job):
        """(key, cached show) of the write's target while it is still good, before the write runs."""
        tid = self._show_target(job)
        if tid is None:
            return None
        key = ("show", tid, "--json")
        with self.lock:
            hit = self.cache.get(key)
            if hit is not None and self._valid(hit[0], classify(list(key)), hit[3]):
                return key, hit
        return None

    def _derive_show(self, job, pre, res):
        if pre is None or res[0] != 0:
            return None
        key, hit = pre
        try:
            old = json.loads(hit[1][1][hit[1][1].find("["):])
            if not (isinstance(old, list) and len(old) == 1 and isinstance(old[0], dict)):
                return None
            obj = dict(old[0])
            if job.argv[0] == "comments":
                if not isinstance(obj.get("comment_count"), int):
                    return None
                obj["comment_count"] += 1
            else:
                out = res[1]
                new = json.loads(out[out.find("["):] if "[" in out and (out.find("{") < 0 or out.find("[") < out.find("{")) else out[out.find("{"):])
                new = new[0] if isinstance(new, list) and len(new) == 1 else new
                if not isinstance(new, dict) or new.get("id") != obj.get("id"):
                    return None
                obj.update(new)
        except (ValueError, TypeError, IndexError):
            return None
        return key, (0, json.dumps([obj], ensure_ascii=False, indent=2) + "\n", ""), hit[3]

    def _check_outside(self):
        """The files changed and not by us: forget what we read."""
        if self.noms is None:
            return
        sig = signature(self.noms)
        with self.lock:
            if sig is not None and sig != self.known_sig and not self.writing:
                self.known_sig = sig
                outside = True
            else:
                outside = False
        if outside:
            self.forget("outside")

    # ---- change events ---------------------------------------------------------------------------

    def watch(self, fn):
        """fn(event) for every change, until it raises or returns False."""
        with self.lock:
            self.watchers.append(fn)
            return self.rev

    def unwatch(self, fn):
        with self.lock:
            if fn in self.watchers:
                self.watchers.remove(fn)

    def _notifier(self):
        while not self.closed.is_set():
            with self.lock:
                while not (self.changes["all"] or self.changes["kv"] or self.changes["issues"]) and not self.closed.is_set():
                    self.change_cv.wait(1.0)
                if self.closed.is_set():
                    return
            time.sleep(NOTIFY_EVERY)  # gather a burst of writes into one event
            with self.lock:
                ch = self.changes
                self.changes = {"ids": set(), "kv": False, "all": False, "issues": False}
                ev = {"ev": "board_changed", "rev": self.rev, "ids": sorted(ch["ids"])[:200], "kv": ch["kv"],
                      "issues": ch["issues"] or ch["all"], "all": ch["all"], "ts": round(time.time(), 3)}
                watchers = list(self.watchers)
            self.stats["events"] += 1
            for fn in watchers:
                try:
                    keep = fn(ev)
                except Exception:
                    keep = False
                if keep is False:
                    self.unwatch(fn)

    # ---- changes made outside the service --------------------------------------------------------

    def _background(self):
        while not self.closed.wait(self.watch_every):
            try:
                if self.noms is None and self.find_noms:
                    # a new board has no database files until its first write: look again
                    self.noms = next((d for d in noms_dirs(self.beads_dir) if os.path.isdir(d)), None)
                    if self.noms is not None:
                        with self.lock:
                            self.known_sig = signature(self.noms)
                with self.lock:
                    busy = self.writing
                if not busy:
                    self._check_outside()
            except Exception:
                self.stats["background_errors"] += 1

    # ---- the rest ----------------------------------------------------------------------------------

    def snapshot_stats(self):
        with self.lock:
            ms = sorted(self.write_ms)
            return {
                "mode": self.mode, "lanes": self.lanes, "beads_dir": self.beads_dir, "watching": bool(self.noms),
                "uptime_s": int(time.time() - self.started), "rev": self.rev, "cached": len(self.cache),
                "cache_mb": round(self.cache_bytes / 1048576, 1), "queue": self.pending_writes, "max_queue": self.max_queue,
                "write_ms_median": ms[len(ms) // 2] if ms else None, "watchers": len(self.watchers), **dict(self.stats),
                "write_wait_ms_median": sorted(self.wait_ms)[len(self.wait_ms) // 2] if self.wait_ms else None,
                "snapshots": {k: (len(v.by_id) if v is not None else None) for k, v in self.snaps.items()},
                "slow": list(self.slow)[-10:], "failed": list(self.failed)[-10:],
            }

    def close(self, wait=60.0):
        """Stop taking writes, finish the queued ones, then stop."""
        with self.lock:
            self.closing = True
        self.writes.put(None)
        end = time.monotonic() + wait
        self.threads[0].join(max(0.0, end - time.monotonic()))
        self.closed.set()
        self.snap_kick.set()
        with self.lock:
            self.change_cv.notify_all()
        self.threads[3].join(5.0)  # the keeper: at most one re-read in flight


# ---- the one in this process (chatd), for callers inside chatd ------------------------------------

_local = {"svc": None}


def set_local(svc):
    _local["svc"] = svc


def local():
    return _local["svc"]


def make_runner():
    """Run bd the way dispatch.sh does without the service (its PATH, its board-down recovery)."""
    import dispatch as D
    last = {"revive": 0.0}

    def run(argv, env, timeout):
        if time.time() - last["revive"] > 300:
            D._board_revived["tried"] = False  # a resident process may bring the database back again later
            last["revive"] = time.time()
        return D._sh_direct(["bd"] + list(argv), timeout, env or None)
    return run


def start(beads_dir=None):
    """The service for this chatd, or None when there is no board to serve."""
    import dispatch as D
    beads_dir = beads_dir or D.BEADS_DIR
    if not os.path.isdir(beads_dir):
        return None
    svc = BoardService(beads_dir, make_runner())
    set_local(svc)
    return svc


# ---- chatd's door: one board client ----------------------------------------------------------------

def serve_client(svc, f, send):
    """Answer one door client's board lines until it goes away. `send(obj)` writes one line to it
    (it must be safe to call from several threads). Each request runs in a thread of its own, so the
    end of the connection is seen at once and its writes that did not start yet are dropped."""
    watching = []
    jobs = []

    def on_change(ev):
        try:
            send(ev)
            return True
        except OSError:
            return False

    def answer(obj):
        rid = obj.get("rid")
        cmd = obj.get("cmd")
        try:
            if cmd == "board.bd":
                argv = obj.get("argv") or []
                if not isinstance(argv, list):
                    raise ValueError("argv must be a list")
                env = {k: str(v) for k, v in (obj.get("env") or {}).items() if isinstance(k, str) and k.startswith(("BEADS_", "BD_"))}
                timeout = float(obj.get("timeout") or 20)
                code, out, err, via = svc.bd(argv, env, timeout, on_start=lambda: send({"rid": rid, "state": "running"}), jobs=jobs)
                send({"rid": rid, "code": code, "stdout": out, "stderr": err, "via": via})
            elif cmd == "board.watch":
                rev = svc.watch(on_change)
                watching.append(on_change)
                send({"rid": rid, "ok": True, "rev": rev})
            elif cmd == "board.stats":
                send({"rid": rid, "ok": True, "stats": svc.snapshot_stats()})
            elif cmd == "board.refresh":
                svc.forget("asked")
                send({"rid": rid, "ok": True})
            elif cmd == "board.hello":
                send({"rid": rid, "ok": True, "protocol": PROTOCOL, "beads_dir": svc.beads_dir, "mode": svc.mode})
            else:
                send({"rid": rid, "ok": False, "code": "bad_request", "message": "unknown board command %r" % cmd})
        except (ValueError, RuntimeError) as e:
            try:
                send({"rid": rid, "ok": False, "code": "refused", "message": str(e)})
            except OSError:
                pass
        except OSError:
            pass  # the client is gone

    try:
        for raw in f:
            try:
                obj = json.loads(raw)
            except ValueError:
                continue
            if isinstance(obj, dict):
                threading.Thread(target=answer, args=(obj,), name="board-req", daemon=True).start()
    except (OSError, ValueError):
        pass
    finally:
        for job in list(jobs):
            svc.cancel(job)
        for fn in watching:
            svc.unwatch(fn)
