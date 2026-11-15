# -*- coding: utf-8 -*-
"""Sessions opened in the Agents window (Dispatch IDE, or VS Code 1.139+), for `dispatch sessions`.

Two read paths, both owned by the editor's local Agent Host, neither a public contract:

1. The catalog, read only: `<userData>/User/globalStorage/agent-host.db` (the host puts it next to
   agent-host-config.json, `agentServiceComposition.ts:88`; `<userData>/agent-host/agent-host.db`
   is tried too). sqlite3 from the standard library, `mode=ro` URI, never written. Real schema
   (VS Code 1.139.1 and the Dispatch IDE fork, 2026-09-27):

     sessions_v2(session_uri TEXT PK      "claude:/<sdk session id>", "codex:/<thread id>", "copilotcli:/<id>"
                 provider TEXT            claude | codex | copilotcli
                 start_time INTEGER       ms
                 external INTEGER         1 = found in the provider's own history, not created here
                 registration_source TEXT
                 session_generation TEXT, source_revision INTEGER, payload_version INTEGER,
                 payload_hash TEXT, verified INTEGER
                 payload TEXT             {"payloadVersion":1,"data":{...}}, see below
                 is_chat_backing INTEGER  1 = the hidden backing session of a peer chat
                 modified_time INTEGER)   ms
     payload.data: modifiedTime (ms), summary (the title), titleSource (user|agent|auto), isRead,
                   isArchived, project {uri, displayName}, isChatBacking, workingDirectories [uri],
                   changes {additions, deletions, files}, _meta {git {branchName, baseBranchName, …}, …},
                   chats [{uri, order, kind, summary, titleSource}]
                   (validator: platform/agentHost/node/agentHostCatalogProjection.ts)
     metadata(key, value): "sessionProvisional:<session_uri>" = "true" while a new session has no
                   message yet (the Agents window does not list it either).

   For a worktree session `project.uri` is already the repository root and workingDirectories[0]
   the worktree checkout (AGENT_HOST_SESSIONS_PROVIDER.md, "Host session catalog").
   Any missing table or column: the catalog is skipped and reads as empty.

2. The live status. The catalog has no running status: "needs input" lives only in the host's
   memory. The host publishes a local endpoint for other processes of the same user
   (`platform/agentHost/LOCAL_ENDPOINT.md`): `<userData>/agent-host/local-endpoint/entries/*.json`
   name a Unix socket and a bearer token; the socket speaks the Agent Host Protocol (JSON-RPC over a
   WebSocket). `initialize` then `listSessions` gives each session's `status` bitset
   (Idle 1, Error 2, InProgress 8, InputNeeded 8|16, IsRead 32, IsArchived 64).
   The same connection archives a session: `dispatchAction` with `session/isArchivedChanged`.

A session only counts as live while its editor's Agent Host runs (an endpoint whose pid is alive).
"""
import sys
from lang import t as _t

sys.dont_write_bytecode = True

import base64
import glob
import json
import os
import re
import socket
import sqlite3
import struct
import time
from urllib.parse import unquote, urlparse

import engines as E

HOME = os.path.expanduser("~")
SUPPORT = os.path.join(HOME, "Library", "Application Support")
# (label shown as the session's source app, user data directory). DISPATCH_IDE_USER_DATA_DIRS
# (os.pathsep-separated user data dirs, label = the folder name) replaces the list: tests and a
# scratch `--user-data-dir` build use it.
APPS = (("Dispatch IDE", os.path.join(SUPPORT, "Dispatch IDE")), ("VS Code", os.path.join(SUPPORT, "Code")))
DB_RELATIVE = (os.path.join("User", "globalStorage", "agent-host.db"), os.path.join("agent-host", "agent-host.db"))
ENTRIES_RELATIVE = os.path.join("agent-host", "local-endpoint", "entries")

# An agent and its window provider id are each other's through the engine registry (engines.agent_of / provider_of).
# providerData keys that carry the agent's own id of a window session (claude, codex, opencode)
NATIVE_ID_KEYS = ("sdkSessionId", "threadId", "opencodeSessionId")
NEEDED_COLUMNS = {"session_uri", "provider", "start_time", "payload", "is_chat_backing", "modified_time"}

# Protocol SessionStatus bits (common/state/protocol/channels-session/state.ts).
ST_IDLE, ST_ERROR, ST_IN_PROGRESS, ST_INPUT_NEEDED, ST_READ, ST_ARCHIVED = 1, 2, 8, 8 | 16, 32, 64
PROTOCOL_VERSIONS = ["0.9.0", "0.8.0", "0.7.0", "1.0.0"]
RECENT = 24 * 3600  # an idle, unarchived session touched within this long is still listed
TIMEOUT = 1.5


def apps():
    env = os.environ.get("DISPATCH_IDE_USER_DATA_DIRS")
    if env is not None:
        return [(os.path.basename(p.rstrip("/")) or p, p) for p in env.split(os.pathsep) if p]
    # The REH's Agent Host uses its server data directory, not the native app's profile.
    # Include it on the source machine so SSH waiting watch sees remote-window sessions too.
    return [*APPS, ("Dispatch IDE Remote", os.path.join(HOME, ".dispatch-ide-server", "data"))]


def db_path(user_data):
    for rel in DB_RELATIVE:
        p = os.path.join(user_data, rel)
        if os.path.isfile(p):
            return p
    return ""


def uri_path(uri):
    """file:///a%20b → /a b; '' for anything that is not a local file URI."""
    if not isinstance(uri, str) or not uri.startswith("file://"):
        return ""
    return unquote(urlparse(uri).path) or ""


def split_uri(session_uri):
    """'claude:/abc' → ('claude', 'abc')."""
    scheme, _, rest = (session_uri or "").partition(":")
    return scheme, rest.lstrip("/")


def repo_root(path):
    """The main repository of a git worktree checkout (its .git is a file pointing into
    <repo>/.git/worktrees/<name>); '' when `path` is not a linked worktree."""
    from ownership import repo_of
    main, checkout = repo_of(path) if path else ("", "")
    return main if main != checkout else ""


def external_entrypoint(provider, sid, cwd):
    """Read a new external session's source before the transcript index catches up."""
    if not sid or not re.fullmatch(r"[\w-]+", sid):
        return ""
    import engines
    eng = engines.find(provider)
    paths = eng.entrypoint_files(sid, cwd) if eng else []
    budget = 4 * 1024 * 1024  # the first 4 MB at most, but line by line: the answer is in the first records, and with no
    for path in paths:        # index yet (a first start) this runs for every session on the Mac
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                seen = 0
                while seen < budget:
                    line = f.readline(budget - seen)
                    if not line:
                        break
                    seen += len(line)
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(row, dict):
                        continue
                    found = eng.entrypoint_in(row)
                    if found is not None:
                        return found
        except OSError:
            continue
    return ""


def sidebar_entries(index, in_app, catalogs=None):
    """Provider ids and transcript metadata for sidebar policy, without altering search history.

    A native window session has its own host id and can also have an SDK transcript id. Both
    are interactive, even when the SDK's transcript says sdk-cli and chatd never owned it.
    """
    if catalogs is None:
        catalogs = [(user_data, c) for _, user_data in apps() for c in read_catalog(db_path(user_data))]
    entries = {}
    for e in index.values():
        sid, agent = e.get("session_id"), e.get("agent")
        if sid and agent:
            provider = E.provider_of(agent)
            entries[f"{provider}:{sid}"] = dict(e)
    for user_data, c in catalogs:
        provider, sid = c["provider"], c["id"]
        key = f"{provider}:{sid}"
        agent = E.agent_of(provider)
        native = native_id(user_data, sid) if not c.get("external") else None
        native_key = f"{provider}:{native}" if native else key
        e = dict(entries.get(native_key) or entries.get(key) or {})
        e.update(agent=agent, session_id=sid, cwd=(c.get("dirs") or [c.get("project_path") or e.get("cwd") or ""])[0])
        if c.get("external") and not e.get("entrypoint"):
            e["entrypoint"] = external_entrypoint(provider, sid, e["cwd"])
        if not c.get("external") or f"{agent}:{sid}" in in_app or f"{agent}:{native}" in in_app:
            e["interactive"] = True
            if native_key in entries:
                entries[native_key]["interactive"] = True
        entries[key] = e
    return entries


# ---- 1. the catalog --------------------------------------------------------------------------

def read_catalog(path):
    """Every top-level session row of one agent-host.db, normalised. [] when the file is missing,
    locked beyond reading, or its schema is not the one described above."""
    if not path or not os.path.isfile(path):
        return []
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=0.5)
    except sqlite3.Error:
        return []
    try:
        cols = {r[1] for r in con.execute("PRAGMA table_info(sessions_v2)")}
        if not NEEDED_COLUMNS <= cols:
            return []
        provisional = set()
        try:
            for (k,) in con.execute("SELECT key FROM metadata WHERE key LIKE 'sessionProvisional:%' AND value = 'true'"):
                provisional.add(k.split(":", 1)[1])
        except sqlite3.Error:
            pass
        rows = con.execute("SELECT session_uri, provider, start_time, payload, is_chat_backing, modified_time"
                           + (", external" if "external" in cols else ", NULL") + " FROM sessions_v2").fetchall()
    except sqlite3.Error:
        return []
    finally:
        con.close()
    out = []
    for uri, provider, start, payload, backing, modified, external in rows:
        if backing or uri in provisional:
            continue
        data = {}
        try:
            data = (json.loads(payload) or {}).get("data") or {} if payload else {}
        except (ValueError, AttributeError):
            data = {}
        if not isinstance(data, dict) or data.get("isChatBacking"):
            continue
        out.append(catalog_entry(uri, provider, start, modified, external, data))
    return out


def catalog_entry(uri, provider, start, modified, external, data):
    dirs = [uri_path(d) for d in data.get("workingDirectories") or [] if uri_path(d)]
    project = data.get("project") if isinstance(data.get("project"), dict) else {}
    chats = sorted((c for c in data.get("chats") or [] if isinstance(c, dict)), key=lambda c: c.get("order") or 0)
    title = (data.get("summary") or "").strip() or next(((c.get("summary") or "").strip() for c in chats if (c.get("summary") or "").strip()), "")
    git = ((data.get("_meta") or {}).get("git") or {}) if isinstance(data.get("_meta"), dict) else {}
    return {
        "uri": uri, "provider": provider or split_uri(uri)[0], "id": split_uri(uri)[1],
        "title": title, "title_source": data.get("titleSource") or "",
        "started_at": (start or 0) / 1000.0,
        "last_at": max(int(data.get("modifiedTime") or 0), int(modified or 0)) / 1000.0,
        "archived": bool(data.get("isArchived")), "read": bool(data.get("isRead")),
        "external": bool(external),
        "project_path": uri_path(project.get("uri")), "project_name": project.get("displayName") or "",
        "dirs": dirs, "branch": git.get("branchName") or "",
    }


def folder_session(root):
    """The newest session of `root` (its project or one of its working folders), for the editor
    window's chat to open: {"uri", "provider", "id", "title", "last_at", "link"} or None. Archived and
    external sessions (found in ~/.claude or ~/.codex, not started in Dispatch IDE) are skipped. `link`
    is the agent-host-session:// link VS Code's own opener shows in the chat view."""
    # real paths on both sides: the host records /private/tmp/x for a folder opened as /tmp/x
    root = os.path.realpath(os.path.expanduser(root or ""))
    best = None
    for _name, user_data in apps():
        for s in read_catalog(db_path(os.path.expanduser(user_data))):
            if s["archived"] or s["external"] or not s["provider"] or not s["id"]:
                continue
            paths = {os.path.realpath(p) for p in [s["project_path"]] + s["dirs"] if p}
            if root in paths and (best is None or s["last_at"] > best["last_at"]):
                best = s
    if best is None:
        return None
    return {"uri": best["uri"], "provider": best["provider"], "id": best["id"], "title": best["title"],
            "last_at": best["last_at"], "link": "agent-host-session://%s/%s" % (best["provider"], best["id"])}


# ---- 2. the live Agent Host ------------------------------------------------------------------

def _alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def endpoints(user_data):
    """Live local endpoints of this editor's Agent Host(s), newest file first."""
    out = []
    files = glob.glob(os.path.join(user_data, ENTRIES_RELATIVE, "*.json"))
    for f in sorted(files, key=lambda p: -os.path.getmtime(p) if os.path.exists(p) else 0):
        try:
            with open(f, encoding="utf-8") as fh:
                e = json.load(fh)
        except (OSError, ValueError):
            continue
        ep = e.get("endpoint") if isinstance(e, dict) else None
        if not isinstance(ep, dict) or e.get("schemaVersion") != 2 or ep.get("type") != "socket" or not ep.get("path") or not e.get("connectionToken"):
            continue
        if not _alive(e.get("pid")):
            continue
        out.append(e)
    return out


class Ahp:
    """A minimal Agent Host Protocol client: WebSocket (RFC 6455, client frames masked) over the
    host's Unix socket, JSON-RPC 2.0 text frames."""

    def __init__(self, entry, timeout=TIMEOUT):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(timeout)
        self.buf = b""
        self.seq = 0
        try:
            self._open(entry)
        except BaseException:
            self.sock.close()
            raise

    def _open(self, entry):
        self.sock.connect(entry["endpoint"]["path"])
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET /?tkn={entry['connectionToken']} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        while b"\r\n\r\n" not in self.buf:
            self._fill()
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise OSError("agent host refused the connection: " + head.split(b"\r\n", 1)[0].decode("latin-1"))
        self.request("initialize", {"channel": "ahp-root://", "protocolVersions": PROTOCOL_VERSIONS, "clientId": f"dispatch-cli-{os.getpid()}",
                                    "clientInfo": {"name": "dispatch", "title": "Dispatch CLI"}})

    def _fill(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise OSError("agent host closed the connection")
        self.buf += chunk

    def _need(self, n):
        while len(self.buf) < n:
            self._fill()

    def send(self, obj):
        data = json.dumps(obj).encode()
        n, mask = len(data), os.urandom(4)
        head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536 else bytes([0x80 | 127]) + struct.pack(">Q", n))
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self):
        parts = []
        while True:
            self._need(2)
            b1, b2 = self.buf[0], self.buf[1]
            n, off = b2 & 127, 2
            if n == 126:
                self._need(4); n = struct.unpack(">H", self.buf[2:4])[0]; off = 4
            elif n == 127:
                self._need(10); n = struct.unpack(">Q", self.buf[2:10])[0]; off = 10
            if b2 & 0x80:
                off += 4  # servers do not mask; tolerate it anyway
            self._need(off + n)
            payload = self.buf[off:off + n]
            if b2 & 0x80:
                m = self.buf[off - 4:off]
                payload = bytes(b ^ m[i % 4] for i, b in enumerate(payload))
            self.buf = self.buf[off + n:]
            op = b1 & 0x0F
            if op == 0x8:
                raise OSError("agent host closed the connection")
            if op == 0x9:  # ping → pong
                self.sock.sendall(bytes([0x8A, 0x80 | len(payload)]) + b"\0\0\0\0" + payload)
                continue
            if op in (0x1, 0x2, 0x0):
                parts.append(payload)
                if b1 & 0x80:
                    return b"".join(parts)

    def request(self, method, params):
        self.seq += 1
        rid = self.seq
        self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        deadline = time.time() + (self.sock.gettimeout() or TIMEOUT) * 2
        while time.time() < deadline:
            try:
                msg = json.loads(self.recv())
            except ValueError:
                continue
            for m in msg if isinstance(msg, list) else [msg]:
                if isinstance(m, dict) and m.get("id") == rid and "method" not in m:
                    if "error" in m:
                        raise OSError(f"{method}: {(m['error'] or {}).get('message', m['error'])}")
                    return m.get("result")
        raise OSError(f"{method}: no answer")

    def notify(self, method, params):
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def close(self):
        try:
            self.sock.sendall(bytes([0x88, 0x80]) + b"\0\0\0\0")
        except OSError:
            pass
        self.sock.close()


def list_live(entry, timeout=TIMEOUT, limit=200):
    """{session uri: summary} from one running Agent Host (listSessions, all pages up to `limit`)."""
    c = Ahp(entry, timeout)
    try:
        out, cursor = {}, None
        while len(out) < limit:
            params = {"channel": "ahp-root://", "limit": 100}
            if cursor:
                params["cursor"] = cursor
            res = c.request("listSessions", params) or {}
            for s in res.get("items") or []:
                if isinstance(s, dict) and s.get("resource"):
                    out[s["resource"]] = s
            cursor = res.get("nextCursor")
            if not cursor:
                break
        return out
    finally:
        c.close()


def state_of(status):
    """Protocol status bits → (state, attention) in `dispatch sessions` words."""
    try:
        status = int(status)
    except (TypeError, ValueError):
        return "unknown", None
    if status & ST_INPUT_NEEDED == ST_INPUT_NEEDED:
        return "idle", "input"  # like a Claude permission prompt: the turn waits for the person
    if status & ST_IN_PROGRESS:
        return "working", None
    if status & ST_ERROR:
        return "idle", "failure"
    return "idle", None


def _iso(ts):
    if not ts:
        return 0.0
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


# ---- rows for `dispatch sessions` --------------------------------------------------------------

def to_row(cat, live, app, alive):
    """One `dispatch sessions` row. `cat`: the catalog entry (or {}), `live`: the host's summary
    (or None). The catalog's title and flags win over the transcript and hook record; the host's
    live status (and its fresher title) wins over the catalog."""
    uri = cat.get("uri") or (live or {}).get("resource") or ""
    provider = cat.get("provider") or (live or {}).get("provider") or split_uri(uri)[0]
    live = live or {}
    dirs = cat.get("dirs") or [uri_path(d) for d in live.get("workingDirectories") or [] if uri_path(d)]
    lproj = live.get("project") if isinstance(live.get("project"), dict) else {}
    project_path = cat.get("project_path") or uri_path(lproj.get("uri"))
    cwd = dirs[0] if dirs else project_path
    root = repo_root(cwd)
    if not project_path or (root and project_path == cwd):
        project_path = root or project_path or cwd
    worktree = cwd if cwd and project_path and os.path.normpath(cwd) != os.path.normpath(project_path) else ""
    project = os.path.basename(project_path.rstrip("/")) if project_path else (cat.get("project_name") or lproj.get("displayName") or "")
    status = live.get("status")
    state, attention = state_of(status) if status is not None else ("idle", None)
    archived = bool(cat.get("archived")) or (isinstance(status, int) and bool(status & ST_ARCHIVED))
    meta = live.get("_meta") if isinstance(live.get("_meta"), dict) else {}
    return {
        "agent": E.agent_of(provider), "session_id": split_uri(uri)[1],
        "source": "ide", "ide_app": app, "ide_key": uri, "worktree": worktree or None,
        "cwd": cwd, "project": project, "project_dir": project_path,
        "title": (live.get("title") or "").strip() or cat.get("title") or "",
        "branch": cat.get("branch") or "",
        "agent_pid": None, "source_kind": "editor", "source_app": f"{app} Agents",
        "entrypoint": "", "prompts": 0,
        "started_at": cat.get("started_at") or _iso(live.get("createdAt")),
        "last_at": max(cat.get("last_at") or 0, _iso(live.get("modifiedAt"))),
        "state": state if alive else "unknown", "attention": attention, "state_source": "ide" if status is not None else "catalog",
        "activity": live.get("activity") or "",
        "archived": archived, "alive": alive, "registered": True,
        # found in the provider's own history (a terminal `claude`, chatd), not opened in the window
        "external": bool(cat.get("external")) or meta.get("vscode.external") is True,
        # the agent's own id when it differs from the window's (OpenCode's `ses_…`), set by scan
        "native_session_id": None,
    }


def outside_session_root(row):
    """An external session (found in ~/.claude or ~/.codex) working outside DISPATCH_SESSION_ROOT: a
    Dispatch IDE test instance's window still discovers the real ones, its lists leave them out."""
    from activity import in_session_root
    return bool(row.get("external")) and not in_session_root(row.get("cwd") or row.get("project_dir"))


def scan(now=None, recent=RECENT, include_all=False):
    """Rows for every Agents-window session worth listing now: its editor's Agent Host is running,
    the session is not archived, and it is busy or was touched within `recent` seconds.
    `include_all`: every catalog row of every editor, running or not (debugging, `--all`)."""
    now = now or time.time()
    rows = []
    for app, user_data in apps():
        eps = endpoints(user_data) if hasattr(socket, "AF_UNIX") else []
        if not eps and not include_all:
            continue
        cat = {c["uri"]: c for c in read_catalog(db_path(user_data))}
        live = {}
        for e in eps:
            try:
                live.update(list_live(e))
                break
            except (OSError, ValueError, KeyError):
                continue
        for uri in list(cat) + [u for u in live if u not in cat]:
            r = to_row(cat.get(uri, {}), live.get(uri), app, bool(eps))
            if E.get(r["agent"]).runnable:
                # Every engine can replace its backing context while the window keeps its id.
                r["native_session_id"] = native_id(user_data, r["session_id"])
            busy = r["state"] == "working" or r["attention"] == "input"
            # The Claude harness lists every ~/.claude conversation as an "external" session: those
            # stay the hooks' and transcripts' business unless the window is driving one right now.
            if not include_all and (r["archived"] or (r["external"] and not busy) or not (busy or now - (r["last_at"] or 0) < recent) or outside_session_root(r)):
                continue
            rows.append(r)
    rows.sort(key=lambda r: -(r["last_at"] or 0))
    return rows


IDE_FIELDS = ("source", "ide_app", "ide_key", "worktree", "project_dir", "branch", "activity", "archived", "native_session_id")


def merge(sessions, rows):
    """Fold `rows` (from scan) into `dispatch sessions`' list in place. The same conversation seen
    by the hooks (Claude Code under the Agent SDK runs the user's hooks) keeps its record but takes
    the catalog's title, project and live status; a bare `pid-…` process whose likely transcript is
    one of these sessions is dropped (it is the SDK's own child)."""
    by = {(s.get("agent"), s.get("session_id")): s for s in sessions}
    ids = set()
    for r in rows:
        ids.add(r["session_id"])
        native = r.get("native_session_id")
        if native and (r["agent"], native) in by:
            # the same OpenCode conversation as its database shows it (zcode_live): the window's row stands for both
            dup = by.pop((r["agent"], native))
            sessions[:] = [x for x in sessions if x is not dup]
        s = by.get((r["agent"], r["session_id"]))
        if s is None:
            sessions.append(r)
            continue
        for k in IDE_FIELDS:
            s[k] = r.get(k)
        for k in ("title", "project", "cwd"):
            if r.get(k):
                s[k] = r[k]
        if r["state_source"] == "ide":
            s["state"], s["attention"], s["state_source"] = r["state"], r["attention"], "ide"
        s["last_at"] = max(s.get("last_at") or 0, r["last_at"] or 0)
    sessions[:] = [s for s in sessions if not (str(s.get("session_id", "")).startswith("pid-") and s.get("probable_session_id") in ids)]
    return sessions


# ---- archive -----------------------------------------------------------------------------------

def find(key, include_external=True):
    """(app, user data dir, catalog entry) for a session key: the full uri, `agent:id`, or an id
    (prefix of 8+ characters). None when no editor's catalog has it. `include_external=False`
    skips conversations the host only discovered in ~/.claude or ~/.codex (not opened in the window)."""
    key = (key or "").strip()
    head, sep, rest = key.partition(":")
    eng = E.find(head) if sep else None
    if eng and eng.provider:                   # claude-code:<id>, codex:<id>, claude:/<id>, copilotcli:/<id>
        want_provider, sid = eng.provider, rest.lstrip("/")
    else:
        want_provider, sid = None, key
    if not sid:
        return None
    for app, user_data in apps():
        for c in read_catalog(db_path(user_data)):
            if c["external"] and not include_external:
                continue
            if c["uri"] == key or ((not want_provider or c["provider"] == want_provider) and (c["id"] == sid or (len(sid) >= 8 and c["id"].startswith(sid)))):
                return app, user_data, c
    return None


def native_id(user_data, host_id):
    """The agent's own id of an Agents-window session (Claude's SDK session, Codex's thread, OpenCode's
    `ses_…`), from `<userData>/agentSessionData/<host id>/session.db`, `session_metadata`: the
    `defaultChatProviderData` JSON, or `codex.threadId`. "" when there is no such record."""
    path = os.path.join(user_data, "agentSessionData", host_id, "session.db")
    if not host_id or not os.path.isfile(path):
        return ""
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=0.5)
        try:
            rows = dict(con.execute("SELECT key, value FROM session_metadata WHERE key IN ('defaultChatProviderData', 'codex.threadId')").fetchall())
        finally:
            con.close()
        data = json.loads(rows["defaultChatProviderData"]) if rows.get("defaultChatProviderData") else {}
    except (sqlite3.Error, ValueError, TypeError):
        return ""
    sid = rows.get("codex.threadId") or ""
    if not sid and isinstance(data, dict):
        sid = next((data[k] for k in NATIVE_ID_KEYS if isinstance(data.get(k), str) and data[k]), "")
    return sid


def transcript_key(key):
    """The agent's own key (`claude-code:<id>`, `codex:<id>`, `opencode:ses_…`) for an Agents-window
    session, the one its transcript in ~/.claude, ~/.codex or OpenCode's database goes by. The
    window's session id is the host's; the agent's own id sits in the host's session database
    (native_id). None when there is no such record (a session the host only discovered in ~/.claude
    already has the SDK's id), the schema is unknown, or no editor has it."""
    hit = find(key)
    if not hit:
        return None
    _app, user_data, c = hit
    sid = native_id(user_data, c["id"])
    return f"{E.agent_of(c['provider'])}:{sid}" if sid else None


def archive(key, archived=True, include_external=True):
    """Archive (or unarchive) an Agents-window session through its editor's running Agent Host.
    Returns {ok, archived, skipped?, message}; skipping (no such session, editor not running) is
    not an error: the caller says so and goes on."""
    hit = find(key, include_external)
    if not hit:
        return {"ok": True, "archived": False, "skipped": "not_found", "key": key, "message": _t(f"The Agents window has no session {key}; nothing archived", f"Agents 窗口的会话里没有 {key}，跳过归档")}
    app, user_data, c = hit
    if c["archived"] == archived:
        return {"ok": True, "archived": archived, "key": c["uri"], "app": app, "message": _t(f"In {app} this session is {'archived' if archived else 'in the list'} already", f"{app} 里这个会话已经{'归档' if archived else '在列表里'}了")}
    eps = endpoints(user_data) if hasattr(socket, "AF_UNIX") else []
    if not eps:
        return {"ok": True, "archived": False, "skipped": "not_running", "key": c["uri"], "app": app,
                "message": _t(f"{app} is not running; nothing archived (open it, then run `dispatch ide archive-session {c['uri']}`)", f"{app} 没在运行，跳过归档（打开后跑 `dispatch ide archive-session {c['uri']}`）")}
    err = ""
    for e in eps:
        try:
            cl = Ahp(e)
            try:
                cl.notify("dispatchAction", {"channel": c["uri"], "clientSeq": 1, "action": {"type": "session/isArchivedChanged", "isArchived": bool(archived)}})
                # dispatchAction has no reply: ask something afterwards so the action is read before we hang up
                cl.request("listSessions", {"channel": "ahp-root://", "limit": 1})
            finally:
                cl.close()
            return {"ok": True, "archived": bool(archived), "key": c["uri"], "app": app, "title": c["title"],
                    "message": _t(f"{'Archived' if archived else 'Unarchived'} \"{c['title'] or c['id'][:8]}\" in {app}'s Agents window", f"已在 {app} 的 Agents 窗口{'归档' if archived else '取消归档'}「{c['title'] or c['id'][:8]}」")}
        except (OSError, ValueError, KeyError) as ex:
            err = str(ex)
    return {"ok": False, "archived": False, "skipped": "error", "key": c["uri"], "app": app, "message": _t(f"Cannot reach {app}'s agent host: {err}", f"连不上 {app} 的 Agent Host：{err}")}


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(prog="ide_sessions.py", description="the Agents window's sessions (agent-host.db + this Mac's agent host)")
    p.add_argument("--all", action="store_true", help="every session in each editor's catalog, including those not running and archived ones")
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    rows = scan(include_all=a.all)
    if a.json:
        print(json.dumps(rows, ensure_ascii=False, indent=1))
    else:
        for r in rows:
            print(f"{r['ide_app']:<13} {r['agent']:<12} {r['state']:<8} {r['project'] or '?':<18} {r['title'] or r['session_id'][:8]}")
        if not rows:
            print(_t("The Agents window has no sessions (or the editor is not running)", "Agents 窗口没有会话（或编辑器没在运行）"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
