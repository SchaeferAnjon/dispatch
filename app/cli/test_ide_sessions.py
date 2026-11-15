# -*- coding: utf-8 -*-
"""ide_sessions.py: the Agents window's sessions in `dispatch sessions`.

The fixture db is built from the real schema of VS Code 1.139.1's agent-host.db (sqlite3 .schema,
2026-09-27) and a payload shaped like its real sessions_v2 rows. A fake Agent Host speaks the local
endpoint's protocol (WebSocket over a Unix socket, JSON-RPC) so the live status and archiving run
through the same code as against the real editor.
"""
import base64
import hashlib
import json
import os
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ide_sessions as I  # noqa: E402

SCHEMA = """
CREATE TABLE sessions (
    session_uri TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, start_time INTEGER NOT NULL,
    external INTEGER, registration_source TEXT NOT NULL DEFAULT 'explicit', modified_time INTEGER NOT NULL DEFAULT 0);
CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE sessions_v2 (
    session_uri TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, start_time INTEGER NOT NULL, external INTEGER,
    registration_source TEXT NOT NULL, session_generation TEXT,
    source_revision INTEGER CHECK (source_revision >= 0), payload_version INTEGER CHECK (payload_version >= 0),
    payload_hash TEXT, verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)), payload TEXT,
    is_chat_backing INTEGER NOT NULL DEFAULT 0 CHECK (is_chat_backing IN (0, 1)), modified_time INTEGER NOT NULL DEFAULT 0);
CREATE TABLE session_chat_catalogs (session_uri TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    legacy_mirrored_revision INTEGER NOT NULL DEFAULT 0 CHECK (legacy_mirrored_revision >= 0));
CREATE TABLE session_chats (session_uri TEXT NOT NULL REFERENCES session_chat_catalogs(session_uri) ON DELETE CASCADE,
    chat_uri TEXT NOT NULL, chat_order INTEGER NOT NULL CHECK (chat_order >= 0), provider_data TEXT, origin TEXT,
    inherited_turn_id TEXT, PRIMARY KEY (session_uri, chat_uri), UNIQUE (session_uri, chat_order));
"""

CLAUDE_ID = "3f9a1c2e-5b6d-4e7f-8a9b-0c1d2e3f4a5b"
CODEX_ID = "019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b"
DRAFT_ID = "810cf838-85e6-423d-a63d-a1586b7884a5"
BACKING_ID = "aaaaaaaa-0000-4000-8000-000000000001"
BARE_ID = "bbbbbbbb-0000-4000-8000-000000000002"
EXT_ID = "dddddddd-0000-4000-8000-000000000004"  # a terminal `claude` conversation the Claude harness discovered in ~/.claude


def furi(path):
    return "file://" + quote(path)


def payload(title, dirs, project=None, archived=False, modified=0, branch="main"):
    data = {"_meta": {"git": {"baseBranchName": "main", "branchName": branch, "hasGitHubRemote": False, "uncommittedChanges": 2}},
            "chats": [{"kind": "default", "order": 0, "titleSource": "auto", "uri": "ahp-chat://default/x"}],
            "isArchived": archived, "isChatBacking": False, "isRead": False, "modifiedTime": modified,
            "titleSource": "agent", "workingDirectories": [furi(d) for d in dirs]}
    if title:
        data["summary"] = title
    if project:
        data["project"] = {"displayName": os.path.basename(project), "uri": furi(project)}
    return json.dumps({"data": data, "payloadVersion": 1})


class Fixture:
    """A user data dir with agent-host.db, a repository `我的 repo` and its worktree."""

    def __init__(self, now_ms):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        self.ud = os.path.join(root, "Dispatch IDE")
        os.makedirs(os.path.join(self.ud, "User", "globalStorage"))
        self.repo = os.path.join(root, "我的 repo")
        os.makedirs(os.path.join(self.repo, ".git", "worktrees", "fix-login"))
        self.wt = os.path.join(root, "我的 repo.worktrees", "fix-login")
        os.makedirs(self.wt)
        with open(os.path.join(self.wt, ".git"), "w") as f:
            f.write(f"gitdir: {self.repo}/.git/worktrees/fix-login\n")
        self.other = os.path.join(root, "notes")
        os.makedirs(self.other)
        self.db = os.path.join(self.ud, "User", "globalStorage", "agent-host.db")
        con = sqlite3.connect(self.db)
        con.executescript(SCHEMA)
        rows = [
            (f"claude:/{CLAUDE_ID}", "claude", now_ms - 3600e3, 0, payload("修登录页的跳转", [self.wt], self.repo, modified=now_ms - 60e3, branch="agents/fix-login"), 0, now_ms - 60e3),
            (f"codex:/{CODEX_ID}", "codex", now_ms - 7200e3, 0, payload("旧的归档会话", [self.other], self.other, archived=True, modified=now_ms - 3000e3), 0, now_ms - 3000e3),
            (f"copilotcli:/{DRAFT_ID}", "copilotcli", now_ms - 100e3, 0, payload("", [self.other], self.other, modified=now_ms - 100e3), 0, now_ms - 100e3),
            (f"claude:/{BACKING_ID}", "claude", now_ms - 100e3, 0, payload("backing", [self.other]), 1, now_ms - 100e3),
            (f"claude:/{BARE_ID}", "claude", now_ms - 5 * 86400e3, 0, None, 0, now_ms - 5 * 86400e3),
            (f"claude:/{EXT_ID}", "claude", now_ms - 600e3, 1, payload("终端里的会话", [self.other], modified=now_ms - 30e3), 0, now_ms - 30e3),
        ]
        for uri, prov, start, ext, pl, backing, mod in rows:
            con.execute("INSERT INTO sessions_v2 (session_uri, provider, start_time, external, registration_source, payload, is_chat_backing, modified_time, verified) VALUES (?,?,?,?,?,?,?,?,1)",
                        (uri, prov, int(start), ext, "explicit", pl, backing, int(mod)))
        con.execute("INSERT INTO metadata VALUES (?, 'true')", (f"sessionProvisional:copilotcli:/{DRAFT_ID}",))
        con.commit()
        con.close()

    def close(self):
        self.tmp.cleanup()


class FakeHost:
    """The Agent Host's local endpoint: accepts the WebSocket upgrade with the token, answers
    initialize and listSessions, records dispatchAction."""

    def __init__(self, ud, items):
        self.items = items
        self.actions = []
        self.token = "tok_" + os.urandom(6).hex()
        self.sockdir = tempfile.mkdtemp(prefix="ah", dir="/tmp")
        self.path = os.path.join(self.sockdir, "h.sock")
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(self.path)
        self.srv.listen(4)
        self.done = False
        threading.Thread(target=self._serve, daemon=True).start()
        entries = os.path.join(ud, "agent-host", "local-endpoint", "entries")
        os.makedirs(entries, exist_ok=True)
        self.entry = {"schemaVersion": 2, "type": "editor", "pid": os.getpid(), "instanceId": "i1", "protocolVersion": "0.9.0",
                      "connectionToken": self.token, "endpoint": {"type": "socket", "path": self.path}}
        with open(os.path.join(entries, hashlib.sha256(b"editor\0x\0i1").hexdigest() + ".json"), "w") as f:
            json.dump(self.entry, f)

    def _serve(self):
        while not self.done:
            try:
                c, _ = self.srv.accept()
            except OSError:
                return
            threading.Thread(target=self._client, args=(c,), daemon=True).start()

    def _client(self, c):
        buf = b""
        try:
            while b"\r\n\r\n" not in buf:
                buf += c.recv(4096)
            head, buf = buf.split(b"\r\n\r\n", 1)
            if f"tkn={self.token}".encode() not in head:
                c.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n"); c.close(); return
            key = [l.split(b":", 1)[1].strip() for l in head.split(b"\r\n") if l.lower().startswith(b"sec-websocket-key")][0]
            acc = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
            c.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acc + b"\r\n\r\n")
            while True:
                while len(buf) < 2:
                    d = c.recv(65536)
                    if not d:
                        return
                    buf += d
                b1, b2 = buf[0], buf[1]
                n, off = b2 & 127, 2
                if n == 126:
                    n, off = struct.unpack(">H", buf[2:4])[0], 4
                assert b2 & 0x80, "client frames must be masked"
                while len(buf) < off + 4 + n:
                    buf += c.recv(65536)
                mask = buf[off:off + 4]
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(buf[off + 4:off + 4 + n]))
                buf = buf[off + 4 + n:]
                if b1 & 0x0F == 0x8:
                    return
                msg = json.loads(data)
                res = None
                if msg["method"] == "initialize":
                    assert msg["params"]["channel"] == "ahp-root://"
                    res = {"protocolVersion": "0.9.0", "serverSeq": 1, "snapshots": []}
                elif msg["method"] == "listSessions":
                    res = {"items": self.items}
                elif msg["method"] == "dispatchAction":
                    self.actions.append(msg["params"])
                    continue
                out = json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": res}).encode()
                h = bytes([0x81]) + (bytes([len(out)]) if len(out) < 126 else bytes([126]) + struct.pack(">H", len(out)))
                c.sendall(h + out)
        except (OSError, AssertionError, ValueError, IndexError):
            return
        finally:
            c.close()

    def close(self):
        self.done = True
        self.srv.close()
        try:
            os.unlink(self.path)
            os.rmdir(self.sockdir)
        except OSError:
            pass


def live_item(sid, status, title="", modified="2026-09-27T10:00:00.000Z"):
    return {"resource": sid, "provider": sid.split(":")[0], "title": title, "status": status, "createdAt": "2026-09-27T09:00:00.000Z", "modifiedAt": modified}


class Base(unittest.TestCase):
    def setUp(self):
        import time
        self.now = time.time()
        self.fx = Fixture(self.now * 1000)
        self.env = os.environ.get("DISPATCH_IDE_USER_DATA_DIRS")
        os.environ["DISPATCH_IDE_USER_DATA_DIRS"] = self.fx.ud
        self.host = None

    def tearDown(self):
        if self.host:
            self.host.close()
        self.fx.close()
        if self.env is None:
            os.environ.pop("DISPATCH_IDE_USER_DATA_DIRS", None)
        else:
            os.environ["DISPATCH_IDE_USER_DATA_DIRS"] = self.env

    def start_host(self, items):
        self.host = FakeHost(self.fx.ud, items)
        return self.host


class Catalog(Base):
    def test_remote_server_catalog_is_discovered_without_extra_configuration(self):
        import shutil
        home = os.path.join(self.fx.tmp.name, "home")
        remote_data = os.path.join(home, ".dispatch-ide-server", "data")
        db = os.path.join(remote_data, "User", "globalStorage", "agent-host.db")
        os.makedirs(os.path.dirname(db))
        shutil.copyfile(self.fx.db, db)
        with patch.dict(os.environ), patch.object(I, "HOME", home), patch.object(I, "APPS", ()):
            os.environ.pop("DISPATCH_IDE_USER_DATA_DIRS", None)
            rows = I.scan(include_all=True)
        self.assertIn(CLAUDE_ID, {r["session_id"] for r in rows})
        self.assertTrue(all(r["ide_app"] == "Dispatch IDE Remote" for r in rows))

    def test_test_instance_override_does_not_scan_the_default_remote_server(self):
        self.assertEqual(I.apps(), [(os.path.basename(self.fx.ud), self.fx.ud)])

    def test_reads_the_real_schema_read_only(self):
        rows = {r["id"]: r for r in I.read_catalog(self.fx.db)}
        # the draft (sessionProvisional) and the peer chat's backing session are not sessions of their own
        self.assertEqual(set(rows), {CLAUDE_ID, CODEX_ID, BARE_ID, EXT_ID})
        self.assertTrue(rows[EXT_ID]["external"])
        self.assertFalse(rows[CLAUDE_ID]["external"])
        c = rows[CLAUDE_ID]
        self.assertEqual((c["provider"], c["title"], c["branch"]), ("claude", "修登录页的跳转", "agents/fix-login"))
        self.assertEqual(c["dirs"], [self.fx.wt])  # percent-encoded file URI decoded, non-ASCII kept
        self.assertEqual(c["project_path"], self.fx.repo)
        self.assertTrue(rows[CODEX_ID]["archived"])
        self.assertEqual(rows[BARE_ID]["title"], "")  # a row not backfilled yet (payload NULL) still reads
        with self.assertRaises(sqlite3.OperationalError):  # the connection really is read-only
            con = sqlite3.connect(f"file:{self.fx.db}?mode=ro", uri=True)
            con.execute("DELETE FROM sessions_v2")

    def test_schema_it_does_not_know_reads_as_empty(self):
        bad = os.path.join(self.fx.tmp.name, "bad.db")
        con = sqlite3.connect(bad)
        con.execute("CREATE TABLE sessions_v2 (session_uri TEXT, provider TEXT)")
        con.commit(); con.close()
        self.assertEqual(I.read_catalog(bad), [])
        junk = os.path.join(self.fx.tmp.name, "junk.db")
        with open(junk, "w") as f:
            f.write("not a database")
        self.assertEqual(I.read_catalog(junk), [])
        self.assertEqual(I.read_catalog(os.path.join(self.fx.tmp.name, "missing.db")), [])

    def test_db_path_falls_back_to_agent_host_dir(self):
        other = os.path.join(self.fx.tmp.name, "Code")
        os.makedirs(os.path.join(other, "agent-host"))
        open(os.path.join(other, "agent-host", "agent-host.db"), "w").close()
        self.assertEqual(I.db_path(other), os.path.join(other, "agent-host", "agent-host.db"))
        self.assertEqual(I.db_path(self.fx.ud), self.fx.db)

    def test_folder_session_for_the_editor_chat(self):
        # the repository and its worktree both find the worktree session; the link is the one VS Code opens
        for root in (self.fx.repo, self.fx.wt, self.fx.repo + "/"):
            s = I.folder_session(root)
            self.assertEqual((s["id"], s["title"]), (CLAUDE_ID, "修登录页的跳转"), root)
            self.assertEqual(s["link"], f"agent-host-session://claude/{CLAUDE_ID}")
        # the folder reached through a symlink (/tmp → /private/tmp on macOS) is the same folder
        link = os.path.join(self.fx.tmp.name, "link-to-repo")
        os.symlink(self.fx.repo, link)
        self.assertEqual(I.folder_session(link)["id"], CLAUDE_ID)
        # `notes` only has an archived, an external and a draft session: none of them
        self.assertIsNone(I.folder_session(self.fx.other))
        self.assertIsNone(I.folder_session(os.path.join(self.fx.tmp.name, "nowhere")))

    def test_editor_not_running_lists_nothing(self):
        self.assertEqual(I.scan(), [])
        self.assertEqual({r["session_id"] for r in I.scan(include_all=True)}, {CLAUDE_ID, CODEX_ID, BARE_ID, EXT_ID})


class Live(Base):
    def test_needs_input_worktree_and_repo_project(self):
        self.start_host([live_item(f"claude:/{CLAUDE_ID}", I.ST_INPUT_NEEDED | I.ST_READ, title="修登录页的跳转（新）"),
                         live_item(f"codex:/{CODEX_ID}", I.ST_IDLE | I.ST_ARCHIVED)])
        rows = I.scan(now=self.now)
        self.assertEqual([r["session_id"] for r in rows], [CLAUDE_ID])  # archived and 5-day-old rows are not live
        r = rows[0]
        self.assertEqual((r["agent"], r["source"], r["ide_app"], r["ide_key"]), ("claude-code", "ide", "Dispatch IDE", f"claude:/{CLAUDE_ID}"))
        self.assertEqual((r["state"], r["attention"], r["state_source"]), ("idle", "input", "ide"))
        self.assertEqual(r["worktree"], self.fx.wt)
        self.assertEqual(r["cwd"], self.fx.wt)
        self.assertEqual(r["project"], "我的 repo")  # the repository, not "fix-login" / "我的 repo.worktrees"
        self.assertEqual(r["title"], "修登录页的跳转（新）")  # the host's live title is fresher than the catalog's
        self.assertTrue(r["alive"])

    def test_discovered_terminal_sessions_stay_out_unless_the_window_drives_them(self):
        ext = live_item(f"claude:/{EXT_ID}", I.ST_IDLE | I.ST_READ, title="终端里的会话")
        ext["_meta"] = {"vscode.external": True}
        self.start_host([ext, live_item(f"claude:/{CLAUDE_ID}", I.ST_IDLE)])
        self.assertEqual([r["session_id"] for r in I.scan(now=self.now)], [CLAUDE_ID])
        self.host.items[0] = dict(ext, status=I.ST_IN_PROGRESS)  # resumed in the Agents window
        self.assertEqual({r["session_id"] for r in I.scan(now=self.now)}, {CLAUDE_ID, EXT_ID})

    def test_status_bits(self):
        self.assertEqual(I.state_of(I.ST_IN_PROGRESS), ("working", None))
        self.assertEqual(I.state_of(I.ST_INPUT_NEEDED | I.ST_READ), ("idle", "input"))
        self.assertEqual(I.state_of(I.ST_ERROR), ("idle", "failure"))
        self.assertEqual(I.state_of(I.ST_IDLE | I.ST_READ), ("idle", None))
        self.assertEqual(I.state_of(None), ("unknown", None))

    def test_session_only_the_host_knows_yet(self):
        # sent its first message a moment ago: the catalog write may lag, the host already lists it
        new = "cccccccc-0000-4000-8000-000000000003"
        item = live_item(f"codex:/{new}", I.ST_IN_PROGRESS, title="新会话")
        item["workingDirectories"] = [furi(self.fx.other)]
        self.start_host([item])
        r = [x for x in I.scan(now=self.now) if x["session_id"] == new][0]
        self.assertEqual((r["agent"], r["state"], r["title"], r["cwd"], r["worktree"]), ("codex", "working", "新会话", self.fx.other, None))

    def test_host_that_does_not_answer_falls_back_to_the_catalog(self):
        self.start_host([])
        self.host.token = "other"  # every connection is refused (403)
        rows = I.scan(now=self.now)
        self.assertEqual([r["session_id"] for r in rows], [CLAUDE_ID])
        self.assertEqual((rows[0]["state"], rows[0]["state_source"], rows[0]["title"]), ("idle", "catalog", "修登录页的跳转"))

    def test_dead_endpoint_is_ignored(self):
        self.start_host([])
        entries = os.path.join(self.fx.ud, "agent-host", "local-endpoint", "entries")
        for f in os.listdir(entries):
            with open(os.path.join(entries, f)) as fh:
                e = json.load(fh)
            e["pid"] = 999999
            with open(os.path.join(entries, f), "w") as fh:
                json.dump(e, fh)
        self.assertEqual(I.endpoints(self.fx.ud), [])
        self.assertEqual(I.scan(), [])


class Merge(unittest.TestCase):
    def row(self, **kw):
        r = {"agent": "claude-code", "session_id": CLAUDE_ID, "source": "ide", "ide_app": "Dispatch IDE", "ide_key": f"claude:/{CLAUDE_ID}",
             "worktree": "/r.worktrees/x", "project_dir": "/r", "branch": "b", "activity": "", "archived": False,
             "title": "db 标题", "project": "r", "cwd": "/r.worktrees/x", "state": "idle", "attention": "input", "state_source": "ide", "last_at": 200}
        r.update(kw)
        return r

    def test_hook_record_takes_the_catalog_title_and_live_status(self):
        hook = {"agent": "claude-code", "session_id": CLAUDE_ID, "title": "", "project": "x", "cwd": "/r.worktrees/x", "state": "working", "attention": None, "state_source": "hook", "last_at": 100, "agent_pid": 42}
        pid_row = {"agent": "claude-code", "session_id": "pid-77", "probable_session_id": CLAUDE_ID}
        other = {"agent": "codex", "session_id": "keep-me", "state": "working"}
        sessions = [hook, pid_row, other]
        I.merge(sessions, [self.row()])
        self.assertEqual(len(sessions), 2)
        self.assertIs(sessions[0], hook)
        self.assertEqual((hook["title"], hook["project"], hook["state"], hook["attention"], hook["source"], hook["agent_pid"]), ("db 标题", "r", "idle", "input", "ide", 42))
        self.assertEqual(hook["last_at"], 200)
        self.assertIs(sessions[1], other)

    def test_catalog_only_status_does_not_override_the_hook(self):
        hook = {"agent": "claude-code", "session_id": CLAUDE_ID, "state": "working", "attention": None, "state_source": "hook", "last_at": 300}
        sessions = [hook]
        I.merge(sessions, [self.row(state="idle", attention=None, state_source="catalog")])
        self.assertEqual((hook["state"], hook["title"], hook["last_at"]), ("working", "db 标题", 300))

    def test_new_session_is_appended(self):
        sessions = []
        I.merge(sessions, [self.row()])
        self.assertEqual(sessions[0]["source"], "ide")


class Archive(Base):
    def test_archive_through_the_running_host(self):
        self.start_host([live_item(f"claude:/{CLAUDE_ID}", I.ST_IDLE)])
        for key in (f"claude-code:{CLAUDE_ID}", CLAUDE_ID[:8], f"claude:/{CLAUDE_ID}"):
            r = I.archive(key)
            self.assertTrue(r["ok"] and r["archived"], r)
        self.assertEqual(self.host.actions[0], {"channel": f"claude:/{CLAUDE_ID}", "clientSeq": 1, "action": {"type": "session/isArchivedChanged", "isArchived": True}})

    def test_editor_not_running_is_skipped_with_a_hint(self):
        r = I.archive(CLAUDE_ID)
        self.assertEqual((r["ok"], r["archived"], r["skipped"]), (True, False, "not_running"))
        self.assertIn("dispatch ide archive-session", r["message"])

    def test_unknown_and_already_archived(self):
        self.assertEqual(I.archive("claude-code:nothing-like-it")["skipped"], "not_found")
        self.assertEqual(I.archive("codex:" + CODEX_ID)["archived"], True)  # already archived: nothing sent, no host needed
        self.assertEqual(I.archive("codex:" + CLAUDE_ID)["skipped"], "not_found")  # right id, wrong agent

    def test_transcript_key_is_the_sdks_own_session_id(self):
        # the host's id is the window's; the Claude transcript goes by the SDK's (agentSessionData/<id>/session.db)
        d = os.path.join(self.fx.ud, "agentSessionData", CLAUDE_ID)
        os.makedirs(d)
        con = sqlite3.connect(os.path.join(d, "session.db"))
        con.execute("CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
        con.execute("INSERT INTO session_metadata VALUES ('defaultChatProviderData', ?)", (json.dumps({"sdkSessionId": "9da59783-sdk", "model": {"id": "sonnet"}}),))
        con.commit()
        con.close()
        for key in (f"claude-code:{CLAUDE_ID}", f"claude:/{CLAUDE_ID}", CLAUDE_ID[:8]):
            self.assertEqual(I.transcript_key(key), "claude-code:9da59783-sdk")
        self.assertIsNone(I.transcript_key(f"codex:{CODEX_ID}"))  # no record: the caller keeps its own key
        self.assertIsNone(I.transcript_key("claude-code:nothing-like-it"))

    def test_an_opencode_session_goes_by_opencodes_own_id(self):
        # the OpenCode harness keeps OpenCode's `ses_…` in the chat's providerData (opencodeSessionId)
        oc_id = "5e0f7a2c-1111-4222-8333-444455556666"
        con = sqlite3.connect(self.fx.db)
        con.execute("INSERT INTO sessions_v2 (session_uri, provider, start_time, external, registration_source, payload, is_chat_backing, modified_time, verified) VALUES (?,?,?,?,?,?,?,?,1)",
                    (f"opencode:/{oc_id}", "opencode", int(self.now * 1000 - 60e3), 0, "explicit",
                     payload("OpenCode 里的会话", [self.fx.other], self.fx.other, modified=self.now * 1000 - 30e3), 0, int(self.now * 1000 - 30e3)))
        con.commit()
        con.close()
        d = os.path.join(self.fx.ud, "agentSessionData", oc_id)
        os.makedirs(d)
        con = sqlite3.connect(os.path.join(d, "session.db"))
        con.execute("CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
        con.execute("INSERT INTO session_metadata VALUES ('defaultChatProviderData', ?)",
                    (json.dumps({"opencodeSessionId": "ses_2c4f9a1b3effe", "cwd": self.fx.other, "model": "deepseek/deepseek-chat"}),))
        con.commit()
        con.close()
        self.assertEqual(I.transcript_key(f"opencode:{oc_id}"), "opencode:ses_2c4f9a1b3effe")
        self.assertEqual(I.native_id(self.fx.ud, oc_id), "ses_2c4f9a1b3effe")
        self.assertEqual(I.native_id(self.fx.ud, "no-such-session"), "")
        row = next(r for r in I.scan(now=self.now, include_all=True) if r["agent"] == "opencode")
        self.assertEqual((row["session_id"], row["native_session_id"], row["title"]), (oc_id, "ses_2c4f9a1b3effe", "OpenCode 里的会话"))
        # OpenCode's own database lists the same conversation under ses_… (zcode_live): the window's row stands for both
        db_row = {"agent": "opencode", "session_id": "ses_2c4f9a1b3effe", "title": "", "state": "idle", "source": "zcode"}
        other = {"agent": "codex", "session_id": "keep-me"}
        sessions = [db_row, other]
        I.merge(sessions, [row])
        self.assertEqual([s["session_id"] for s in sessions], ["keep-me", oc_id])
        self.assertEqual(sessions[1]["native_session_id"], "ses_2c4f9a1b3effe")

    def test_transcript_key_of_a_codex_session_is_its_thread_id(self):
        # Codex keeps the thread id in codex.threadId; defaultChatProviderData.sessionId is the host's id
        d = os.path.join(self.fx.ud, "agentSessionData", CODEX_ID)
        os.makedirs(d)
        con = sqlite3.connect(os.path.join(d, "session.db"))
        con.execute("CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
        con.execute("INSERT INTO session_metadata VALUES ('defaultChatProviderData', ?)", (json.dumps({"sessionId": CODEX_ID}),))
        con.execute("INSERT INTO session_metadata VALUES ('codex.threadId', '01a0e03d-thread')")
        con.commit()
        con.close()
        self.assertEqual(I.transcript_key(f"codex:{CODEX_ID}"), "codex:01a0e03d-thread")
        row = next(r for r in I.scan(now=self.now, include_all=True) if r["agent"] == "codex")
        self.assertEqual(row["native_session_id"], "01a0e03d-thread")

    def test_done_archive_takes_the_tasks_linked_sessions(self):
        import dispatch as D
        self.start_host([])
        got = D.archive_ide_sessions({"labels": ["project:kanban", f"session:{CLAUDE_ID}", "session:0000000000-not-an-ide-session", f"session:{EXT_ID}"]})
        self.assertEqual([(r["key"], r["archived"]) for r in got], [(f"claude:/{CLAUDE_ID}", True)])  # terminal sessions (unknown, or only discovered) are not touched
        self.assertEqual(len(self.host.actions), 1)

    def test_cli(self):
        self.start_host([])
        env = dict(os.environ, DISPATCH_IDE_USER_DATA_DIRS=self.fx.ud)
        p = subprocess.run([sys.executable, os.path.join(HERE, "ide.py"), "archive-session", f"claude-code:{CLAUDE_ID}", "--json"], capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(json.loads(p.stdout)["archived"])
        self.assertEqual(self.host.actions[-1]["action"]["isArchived"], True)


class Notify(Base):
    def test_needs_input_rings_the_phone_once(self):
        import notify_watch as W
        self.start_host([live_item(f"claude:/{CLAUDE_ID}", I.ST_INPUT_NEEDED)])
        live = []
        I.merge(live, I.scan(now=self.now))
        sent = []
        send = lambda *a, **k: sent.append((a, k)) or {"ok": True}
        st = {}
        W.tick([], {}, st, send, lambda p: "http://x" + p, first=False, live=live)
        W.tick([], {}, st, send, lambda p: "http://x" + p, first=False, live=live)
        self.assertEqual(len(sent), 1)
        (title, body), kw = sent[0]
        self.assertIn("Claude Code 等你确认", title)
        self.assertIn("我的 repo", title)
        self.assertEqual(body, "修登录页的跳转")
        self.assertEqual(kw["url"], f"http://x/#/sessions/{CLAUDE_ID}")


class DispatchSessions(Base):
    def test_dispatch_sessions_json_has_the_ide_row(self):
        self.start_host([live_item(f"claude:/{CLAUDE_ID}", I.ST_INPUT_NEEDED)])
        with tempfile.TemporaryDirectory() as d:
            env = dict(os.environ, DISPATCH_IDE_USER_DATA_DIRS=self.fx.ud, DISPATCH_DIR=d)
            p = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "sessions", "--local", "--json"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        rows = [r for r in json.loads(p.stdout) if r.get("source") == "ide"]
        self.assertEqual([(r["session_id"], r["attention"], r["worktree"], r["host"]) for r in rows], [(CLAUDE_ID, "input", self.fx.wt, "local")])


class SidebarSearch(unittest.TestCase):
    def test_unindexed_codex_exec_and_broken_metadata(self):
        from unittest.mock import patch
        from pathlib import Path
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "sessions/2026/09/28/rollout-new-codex.jsonl"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({"type": "session_meta", "payload": {"source": "exec"}}) + "\n")
            with patch.dict(os.environ, {"CODEX_HOME": temp}):
                self.assertEqual(I.external_entrypoint("codex", "new-codex", "/repo"), "exec")
                path.write_bytes(b'{"type":"session_meta","payload":"broken"}\n\xff')
                self.assertEqual(I.external_entrypoint("codex", "new-codex", "/repo"), "")

    def test_unindexed_headless_run_is_classified_from_its_own_metadata(self):
        from unittest.mock import patch
        from pathlib import Path
        import projects_view as PV
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "projects/-repo/new-run.jsonl"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({"type": "user", "entrypoint": "sdk-cli", "sessionId": "new-run"}) + "\n")
            catalog = {"provider": "claude", "id": "new-run", "external": True, "dirs": ["/repo"]}
            with patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": temp}):
                e = I.sidebar_entries({}, {}, [(temp, catalog)])["claude:new-run"]
                self.assertTrue(PV.is_automation(e))
                e = I.sidebar_entries({}, {"claude-code:new-run": 1}, [(temp, catalog)])["claude:new-run"]
                self.assertFalse(PV.is_automation(e))

    def test_hidden_run_is_still_returned_by_search_with_a_marker(self):
        import contextlib
        import io
        from types import SimpleNamespace
        from unittest.mock import patch
        import dispatch as D
        import activity
        e = dict(agent="claude-code", session_id="oneshot-123", cwd="/demo", title="Sprite one-shot",
                 first_prompt="Sprite one-shot", entrypoint="sdk-cli", mtime=100, tasks={}, claims=[])
        a = SimpleNamespace(cached=True, local=True, agent=None, cwd=None, project=None,
                            query="Sprite", limit=200, json=True)
        output = io.StringIO()
        with patch.object(D, "load_index", return_value={"/not-read.jsonl": e}), \
             patch.object(D, "known_task_ids", return_value=set()), \
             patch.object(D, "subagents_of", return_value=[]), \
             patch.object(D, "git_root_name", return_value="demo"), \
             patch.object(D, "in_app_chats", return_value={}), \
             patch.object(D, "annotate_moves"), patch.object(I, "apps", return_value=[]), \
             patch.object(activity, "session_preferences", return_value={}), \
             contextlib.redirect_stdout(output):
            D.cmd_list(a)
        rows = json.loads(output.getvalue())
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["session_id"], "oneshot-123")
        self.assertTrue(rows[0]["one_shot"])


if __name__ == "__main__":
    unittest.main()
