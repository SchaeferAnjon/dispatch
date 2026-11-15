# -*- coding: utf-8 -*-
"""`dispatch chatd`: the resident in-app chat sidecar. Rust starts it once per app run; it reads
commands on stdin and writes events on stdout, one JSON line each (app/cli/chat_protocol.py).

One thread runs everything that touches a session: stdin lines arrive through a queue (a small
reader thread), and every 50 ms (and after every command) each adapter's `drain()` hands over what
its own reader thread collected. chatd owns the session table, the per-session message queue, the
replay buffer of the current turn, the idle reaper and the registry file activity.py reads.

Replies: a command with `request_id` gets exactly one reply. Synchronous ones (hello, list, queued,
queue, commands, replay's state, errors) are stamped directly; the rest are "waiters": the next
matching event of that session (opened, turn_started with the same message_id, turn_done,
permission_resolved with the same permission_id, state, closed) carries the request_id, and so does
an `error` the adapter emits while the waiter is open.

Adapters for agents whose id is only known after start (Codex: thread/start) are created with
`session=None` and must set `self.session` in `start()` before emitting anything. An adapter keeps
`lifecycle` current (chatd reads it to queue, pump and reap), puts its process id in `state()["pid"]`
(the registry and the writer check use it) and may set `transcript` (re-sent when `open` finds the
session already running).

Queue: an idle session sends at once; a busy one queues (`queued`, then `queue`) or, with
mode=interrupt, interrupts and sends first after turn_done. A message sent while the session starts
or resumes waits hidden and gets its turn_started as the reply. Claude and Codex sessions idle for
the settings' chat_idle_close_minutes (30 by default, 0 = never) are closed (`closed {reason: idle}`)
and stay in the table as stopped; the next send resumes the same transcript.
"""
import collections
from lang import t as _t
import hmac
import importlib
import json
import os
import queue
import secrets
import socket
import subprocess
import sys
import threading
import time
import uuid
sys.dont_write_bytecode = True  # never write __pycache__ next to these files: inside Dispatch.app that breaks the code signature

import chat_protocol as cp
import engines as E

CHATD_VERSION = "0.3"
TICK = 0.05
REGISTRY_CHECK = 5.0  # seconds between a door holder's looks at chatd.json (is it still named there?)
REAP_EVERY = 60
DOCTOR_CHECK_EVERY = 300     # how often the resident chatd looks whether the daily `dispatch doctor` is due
KNOWLEDGE_EVERY = 300       # the resident chatd commits and pulls what the user knows from the other Macs (knowledge_sync.py)
WAKE_EVERY = 15              # how often worker state changes are written down and handed to the dispatcher session
PROBE_TTL = 300
MOBILE_CHECK = 5.0           # how often the door holder looks whether a phone is paired (mobile.py serves it then)
BOARD_CHECK = 5.0            # until there is a board, how often the door holder looks for one to serve (board_service.py)
NEXTUP_EVERY = 20          # the first thing noted from a chat starts by itself when there is room (capture.py)
GC_CHECK_EVERY = 3600       # how often the loop asks checkpoint.gc_all (which runs at most once a day)
STOPPED_KEEP = 6 * 3600      # a session whose process ended stays resumable this long, then leaves the table
SHUTDOWN_TURN_WAIT = 3.0     # shutdown: how long interrupted turns get to finish (all sessions at once)
SHUTDOWN_EXIT_WAIT = 3.0     # then how long the processes get to exit after stdin closes
DOOR_BACKLOG = 2000          # events a local client may fall behind by before it is dropped


def _probe(agent):
    # a missing or broken driver is "unsupported", never a crash of the sidecar
    return E.get(agent).chat_probe()


def _caps(agent):
    """What an adapter can do, before any session of it is open: `set_model` tells a client it may
    change the model mid-conversation (`dispatch agent model`)."""
    try:
        return list(getattr(E.get(agent).chat_class(), "capabilities", ()))
    except Exception:
        return []


def hello():
    return {"protocol": cp.PROTOCOL_VERSION, "chatd_version": CHATD_VERSION, "platform": sys.platform,
            "agents": {agent: {**_probe(agent), "capabilities": _caps(agent)} for agent in cp.AGENTS}}


def _pid_alive(pid):
    try:
        import dplatform as P
        return P.pid_alive(pid)
    except Exception:
        return False


def account_generation(agent):
    """How many times this engine's account has been switched (`dispatch accounts use`); 0 when never or unknown.
    An engine started under an older number is still signed in with the previous account."""
    try:
        import accounts
        return accounts.generation(E.id_of(agent))
    except Exception:
        return 0


def read_registry(dispatch_dir):
    """chatd.json when the chatd that wrote it is still running, else None (activity.py and
    session_control.py use it to tell a Dispatch-held session from a terminal one)."""
    try:
        with open(cp.registry_path(dispatch_dir), encoding="utf-8") as f:
            reg = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(reg, dict) or not isinstance(reg.get("sessions"), dict) or not _pid_alive(reg.get("pid")):
        return None
    return reg


class Door:
    """The local way in for everything that is not the app window: `dispatch agent`, the phone
    service, another Mac through `dispatch --host` over ssh. It listens on 127.0.0.1 only; a
    client's first line is {"token": …} from chatd.json (readable by this user only). After that
    it speaks the app's protocol: its commands join the same queue as the app's lines, and every
    event goes to every client (each one keeps what carries its request_id or its session).
    `shutdown` stays the app's: quitting Dispatch ends chatd, a client cannot."""

    def __init__(self, lines):
        self.lines = lines
        self.board = None      # the task board service (board_service.py): its clients say {"board": 1} after the token
        self.board_conns = []
        self.token = secrets.token_hex(16)
        self.clients = []
        self.lock = threading.Lock()
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(16)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._accept, daemon=True).start()

    def info(self):
        return {"port": self.port, "token": self.token}

    def _accept(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._client, args=(conn,), daemon=True).start()

    def _client(self, conn):
        out = queue.Queue(maxsize=DOOR_BACKLOG)
        try:
            f = conn.makefile("r", encoding="utf-8", newline="\n")
            conn.settimeout(5)
            first = json.loads(f.readline() or "{}")
            if not isinstance(first, dict) or not hmac.compare_digest(str(first.get("token", "")), self.token):
                conn.close()
                return
            conn.settimeout(None)
        except (OSError, ValueError):
            conn.close()
            return
        if first.get("board") and self.board is not None:
            self._board_client(conn, f)
            return
        client = {"out": out, "conn": conn}
        with self.lock:
            self.clients.append(client)

        def writer():
            while True:
                line = out.get()
                if line is None:
                    break
                try:
                    conn.sendall((line + "\n").encode("utf-8"))
                except OSError:
                    break
            self._drop(client)

        threading.Thread(target=writer, daemon=True).start()
        try:
            for raw in f:
                try:
                    obj = json.loads(raw)
                except ValueError:
                    obj = None
                if isinstance(obj, dict) and obj.get("cmd") == "shutdown":
                    e = cp.ChatError("bad_request", _t("Only the Dispatch window can close chatd", "只有 Dispatch 窗口能关掉 chatd")).event(request_id=obj.get("request_id"))
                    e.update(seq=0, ts=round(time.time(), 3))
                    self._put(client, json.dumps(e, ensure_ascii=False))
                    continue
                self.lines.put(raw)
        except (OSError, ValueError):
            pass
        self._drop(client)

    def _board_client(self, conn, f):
        """A board client: it gets the answers to its own board commands and, after `board.watch`, the
        board's change events, never the chat events every other client gets."""
        import board_service
        lock = threading.Lock()

        def send(obj):
            data = (json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
            with lock:
                conn.sendall(data)

        with self.lock:
            self.board_conns.append(conn)
        try:
            board_service.serve_client(self.board, f, send)
        finally:
            with self.lock:
                if conn in self.board_conns:
                    self.board_conns.remove(conn)
            try:
                conn.close()
            except OSError:
                pass

    def _put(self, client, line):
        try:
            client["out"].put_nowait(line)
        except queue.Full:  # a client that stopped reading must not hold up the loop
            self._drop(client)

    def _drop(self, client):
        with self.lock:
            if client not in self.clients:
                return
            self.clients.remove(client)
        try:
            client["out"].put_nowait(None)
        except queue.Full:
            pass
        try:
            client["conn"].close()
        except OSError:
            pass

    def broadcast(self, line):
        with self.lock:
            clients = list(self.clients)
        for c in clients:
            self._put(c, line)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass
        with self.lock:
            clients = list(self.clients)
            board_conns = list(self.board_conns)
        for c in clients:
            self._drop(c)
        for conn in board_conns:
            try:
                conn.shutdown(socket.SHUT_RDWR)
                conn.close()
            except OSError:
                pass


class Session:
    def __init__(self, adapter, agent, cwd, options):
        self.adapter = adapter
        self.agent = agent
        self.cwd = cwd
        self.options = options
        self.queue = []   # {message_id, text, images, images_n, at, hidden, request_id}
        self.replay = collections.deque(maxlen=cp.REPLAY_LIMIT)
        self.opened_at = time.time()
        self.last_activity = time.time()
        self.hold = False  # an interrupt-then-send is waiting for its turn_done
        self.reaped = False  # stopped by the idle reaper: still Dispatch's, the next send resumes it
        self.notes = []    # `note` lines for the agent, prepended as "[system] …" to the next message it gets
        self.sent_text = {}  # message_id → the text the bubble shows, while the adapter got more (notes in front, `display`)
        self.cp_by_msg = {}   # message_id → checkpoint turn_id taken before it went out (turn_started carries it)
        self.cp_by_turn = {}  # the agent's turn_id → checkpoint turn_id (turn_done takes the after snapshot)
        self.cp_current = None
        self.cp_slow_told = False
        self.cp_fail_told = False
        self.cp_paths = set()  # files the agent's edit tools named in the current turn (checkpoint.finish records them)
        self.snap = None       # {item, result, done}: the message whose checkpoint is being taken off the loop
        self.net_retry = None  # the message whose turn is out, sent again when the connection drops (chat_retry.py)


class Chatd:
    def __init__(self, write, d=None, clock=time.time):
        self.write = write
        self.em = cp.Emitter(write)
        self._d = d
        self.clock = clock
        self.sessions = {}
        self.waiters = []   # {adapter, evs, request_id, match}
        self.started = clock()
        self._last_reap = clock()
        self._registry_written = None
        self._registry_checked = float('-inf')
        self._probes = {}
        self._closed = set()   # id(adapter) of adapters that emitted `closed`
        self.starting = []     # sessions whose key the agent has not named yet (a new Codex thread)
        self._named = set()    # sessions whose short name was asked for this run
        self.spawn = lambda fn: threading.Thread(target=fn, daemon=True).start()
        self.background = lambda fn: threading.Thread(target=fn, daemon=True).start()  # checkpoints and the code index
        self._notes_taken = None  # (session, notes, message_id) of the send in flight
        self._last_gc = clock()
        self._last_nextup = clock()
        self._nextup_busy = False
        self._last_wake = clock()
        self._wake_out = []    # what a wake sweep decided to send into the dispatcher's session (sent on the loop)
        self._wake_busy = False
        self.code = None           # doctor.code_stamp() of the code this chatd started with (serve() sets it); chatd.json carries it
        self.doctor_daily = False  # the resident chatd (chatd_service.run) runs `dispatch doctor` once a day
        self._doctor_busy = False
        self._last_doctor = clock()
        self._knowledge_busy = False
        self._last_knowledge = clock() - KNOWLEDGE_EVERY + 30   # first round half a minute after start
        self.door = None       # Door: its port and token go into chatd.json
        self.idle_close = cp.IDLE_REAP_SECONDS  # settings chat_idle_close_minutes (0 = never), re-read every reap
        self.life_settings = {}
        self.idle_setting()
        # per engine with one shared server (Codex's app-server): the account generation it signed in with
        self._daemon_account_gen = {e.agent: account_generation(e.agent) for e in E.runnable() if e.chat_account_restart == "daemon"}
        self._daemon_account_busy = set()

    # ------------------------------------------------------------ plumbing
    @property
    def d(self):
        if self._d is None:
            here = os.path.dirname(os.path.abspath(__file__))
            if here not in sys.path:
                sys.path.insert(0, here)
            import dispatch
            self._d = dispatch
        return self._d

    def reply(self, ev, request_id=None, session=None, **fields):
        if request_id:
            fields["request_id"] = request_id
        return self.em.emit(ev, session=session, **fields)

    def error(self, e, request_id=None, session=None):
        body = e.event(session=session, request_id=request_id)
        body.pop("ev")
        return self.em.emit("error", **body)

    def wait_for(self, adapter, evs, request_id, match=None):
        if request_id:
            self.waiters.append({"adapter": adapter, "evs": set(evs), "request_id": request_id, "match": match})

    def _session_of(self, adapter):
        return next((s for s in self.sessions.values() if s.adapter is adapter), None)

    def emitter(self, adapter):
        return lambda ev, **fields: self._emit(adapter, ev, fields)

    def _emit(self, adapter, ev, fields):
        key = next((k for k, s in self.sessions.items() if s.adapter is adapter), adapter.session)
        sess = self.sessions.get(key) if key else None
        if sess is not None and sess.adapter is not adapter:
            sess = None
        if sess is not None:
            import chat_life
            chat_life.event(self, key, sess, ev, fields)
        if ev == "life_usage":
            return fields
        if sess is not None and ev in ("tool_start", "tool_end"):
            self.editor_hook(key, sess, ev, fields)
        if ev == "turn_started" and sess is not None and fields.get("message_id") in sess.sent_text:
            fields["text"] = sess.sent_text.pop(fields["message_id"])
        if ev == "turn_started" and sess is not None and fields.get("message_id") in sess.cp_by_msg:
            fields["checkpoint"] = sess.cp_by_msg.pop(fields["message_id"])
            if fields.get("turn_id"):
                sess.cp_by_turn[fields["turn_id"]] = fields["checkpoint"]
        if ev == "turn_done" and sess is not None:
            self.checkpoint_after(key, sess, fields.get("turn_id"))
        if ev == "state":
            # The queue is chatd's: an adapter's own `state` (Codex after a reconnect) knows nothing of it.
            fields["queue"] = self.queue_view(sess) if sess else []
            fields.setdefault("lifecycle", adapter.lifecycle)
        for w in list(self.waiters):
            if w["adapter"] is not adapter:
                continue
            if ev in w["evs"] and (w["match"] is None or w["match"](fields)) or (ev == "error" and "request_id" not in fields):
                self.waiters.remove(w)
                fields["request_id"] = w["request_id"]
                break
        e = self.em.emit(ev, session=key, **fields)
        if sess is not None:
            sess.last_activity = self.clock()
            if ev == "turn_started":
                sess.replay.clear()
            if ev not in ("state", "sessions", "commands"):
                sess.replay.append({k: v for k, v in e.items() if k != "request_id"})
            if ev == "turn_done":
                sess.hold = False
        if ev == "turn_started" and key and key not in self._named:
            self._named.add(key)
            self.name_later(key, fields.get("text") or "", getattr(adapter, "transcript", "") or getattr(adapter, "transcript_path", "") or "")
        retrying = False
        if sess is not None and ev == "turn_done":
            import chat_retry
            chat_retry.turn_done(self, key, sess, fields)
            retrying = chat_retry.waiting(sess)  # the bell waits: the message is about to go out again
        if sess is not None and ev in ("turn_done", "permission_request") and not retrying:
            self.inbox_hook(key, sess, ev, fields)
        if ev == "closed":
            self._closed.add(id(adapter))
        if ev == "opened" and key:
            try:
                cp.mark_started(self.d.DISPATCH_DIR, key)
            except Exception:
                pass
        return e

    def inbox_hook(self, key, sess, ev, fields):
        """The bell (inbox.py): a turn that ended, or a question for the person. Decided by the agent's own
        signal (turn_done's status, permission_request), filed off the loop."""
        if not key or not hasattr(self.d, "DISPATCH_DIR"):
            return
        turn = [e for e in sess.replay if e.get("ev") in ("turn_started", "text_done")]
        asked = next((e.get("text") for e in turn if e.get("ev") == "turn_started"), "") or ""
        said = next((e.get("text") for e in reversed(turn) if e.get("ev") == "text_done"), "") or ""
        if str(fields.get("message_id") or asked).startswith("life-"):
            return  # the context-lifetime handoff talks to the agent on its own; nothing for the person
        import inbox
        if ev == "permission_request":
            kind, why, by_you = "needs_you", "", False
            said = fields.get("summary") or fields.get("reason") or said
        else:
            kind, why, by_you = inbox.classify(fields.get("status"), fields.get("error") or "")
        title = sess.options.get("label") or asked
        base = self.d.DISPATCH_DIR

        def run():
            try:
                inbox.add(kind, key, "chat", sess.agent, title, os.path.basename(sess.cwd or ""), sess.cwd or "", said, why, by_you, base,
                          turn=str(fields.get("permission_id") or fields.get("turn_id") or ""))
            except Exception:
                pass
        self.background(run)

    def sleep_note(self, key, sess, asleep):
        """Who is asleep, for `dispatch sleep` (sleep.py)."""
        if not key or not hasattr(self.d, "DISPATCH_DIR"):
            return
        try:
            import sleep
            sleep.note(self.d.DISPATCH_DIR, "chat", key, asleep, {"agent": sess.agent, "title": sess.options.get("label") or "", "cwd": sess.cwd})
        except Exception:
            pass

    def editor_hook(self, key, sess, ev, fields):
        """Agent hunks (editor.py, painted by Dispatch IDE's bridge extension): snapshot a file before the agent's first edit
        of it, and fix a snapshot that came too late once the edit is done. Never gets in the way."""
        try:
            if ev == "tool_start" and fields.get("kind") == "edit":
                inp = fields.get("input") if isinstance(fields.get("input"), dict) else {}
                paths = [inp.get(k) for k in ("file_path", "notebook_path") if isinstance(inp.get(k), str)]
                paths += [c.get("path") for c in inp.get("changes") or [] if isinstance(c, dict) and isinstance(c.get("path"), str)]
                sess.cp_paths.update(paths)
                if paths:
                    self.editor().capture_baseline(key, sess.cwd, paths, dispatch_dir=self.d.DISPATCH_DIR)
            elif ev == "tool_end" and isinstance(fields.get("diff"), dict) and fields["diff"].get("kind") in ("edit", "write"):
                self.editor().repair_baseline(key, sess.cwd, fields["diff"], dispatch_dir=self.d.DISPATCH_DIR)
        except Exception:
            pass

    def editor(self):
        return importlib.import_module("editor")

    def checkpoints(self):
        return importlib.import_module("checkpoint")

    # ------------------------------------------------------------ checkpoints (PLAN.md §3.5)
    def checkpoint_taken(self, key, sess, message_id, r):
        """The snapshot taken before a message goes out (send_item runs begin() off the loop), booked
        on the loop: turn_started will carry the id. Never gets in the way: no snapshot (home folder,
        too many files, git missing) sends all the same. A notice once when it was slow, or when it
        failed for a reason worth knowing (git broken or timed out, a folder too big to snapshot)."""
        sess.cp_paths = set()
        tid = r.get("turn_id") if isinstance(r, dict) else None
        if not tid:
            err = r.get("error") if isinstance(r, dict) else None
            if err in ("git_failed", "io", "too_many_files") and r.get("message") != "skipped" and not sess.cp_fail_told:
                sess.cp_fail_told = True
                self.em.emit("system", session=key, kind="notice", text=_t("Checkpoint: no snapshot was taken before this message, so going back to before this round is not possible (%s)", "检查点：这句话之前没打成快照，「回到这一轮之前」用不了（%s）") % str(r.get("message") or err)[:200])
            return None
        sess.cp_by_msg[message_id] = tid
        sess.cp_current = tid
        if (r.get("ms") or 0) >= self.checkpoints().SLOW_SNAPSHOT * 1000 and not sess.cp_slow_told:
            sess.cp_slow_told = True
            self.em.emit("system", session=key, kind="notice", text=_t("Checkpoint: the snapshot of this folder took %.1f s (that happens with many files)", "检查点：给这个目录打快照用了 %.1f 秒（文件很多时会这样）") % (r["ms"] / 1000.0))
        return tid

    def checkpoint_dropped(self, sess, message_id):
        tid = sess.cp_by_msg.pop(message_id, None)
        if tid:
            if sess.cp_current == tid:
                sess.cp_current = None
            try:
                self.checkpoints().discard(sess.cwd, tid, base=self.d.DISPATCH_DIR)
            except Exception:
                pass

    def checkpoint_after(self, key, sess, turn_id):
        """After turn_done: the after snapshot on the loop (a queued message goes out right after
        this and must not land in it), then the code-search index off the loop."""
        tid = sess.cp_by_turn.pop(turn_id, None) if turn_id else None
        if not tid and sess.cp_current and sess.cp_current not in sess.cp_by_msg.values():
            tid = sess.cp_current
        if tid == sess.cp_current:
            sess.cp_current = None
        cwd = sess.cwd
        paths, sess.cp_paths = sorted(p for p in sess.cp_paths if isinstance(p, str)), set()
        if tid:
            try:
                self.checkpoints().finish(cwd, tid, agent_turn_id=turn_id or "", base=self.d.DISPATCH_DIR, agent_paths=paths)
            except TypeError:  # an older checkpoint module
                try:
                    self.checkpoints().finish(cwd, tid, agent_turn_id=turn_id or "", base=self.d.DISPATCH_DIR)
                except Exception:
                    pass
            except Exception:
                pass

        def run():
            try:
                importlib.import_module("code_search").refresh(cwd)
            except Exception:
                pass
        self.background(run)

    def take_file_notes(self, key, sess):
        """Notes a `dispatch checkpoint restore` outside chatd left for this session."""
        try:
            sess.notes.extend(self.checkpoints().take_notes(key, base=self.d.DISPATCH_DIR))
        except Exception:
            pass

    def send_item(self, key, sess, item):
        """Snapshot the project off the loop (a big folder takes seconds and would stall every
        other session), then hand the message over: at once when the snapshot is already done,
        else on the tick that finds it done. The session sends nothing else meanwhile."""
        job = {"item": item, "result": None, "done": False, "cancelled": False}
        sess.snap = job
        cwd, mid, text, base = sess.cwd, item["message_id"], item.get("display") or item["text"], self.d.DISPATCH_DIR

        def run():
            try:
                mod = self.checkpoints()
                job["result"] = mod.begin(cwd, key, mid, text, base=base)
                if job["cancelled"] and isinstance(job["result"], dict) and job["result"].get("turn_id"):
                    mod.discard(cwd, job["result"]["turn_id"], base=base)
            except Exception:
                job["result"] = None
            finally:
                job["done"] = True
        self.background(run)
        self.flush_snap(key, sess)

    def flush_snap(self, key, sess):
        """The snapshot of the message waiting in `sess.snap` is done: send it (notes in front). A
        failed send puts the notes back, drops the snapshot and answers the request with the error."""
        job = sess.snap
        if not job or not job["done"]:
            return False
        sess.snap = None
        item, a, mid = job["item"], sess.adapter, job["item"]["message_id"]
        r = job["result"]
        if self.sessions.get(key) is not sess or a.lifecycle != "idle":
            tid = r.get("turn_id") if isinstance(r, dict) else None
            if tid:
                try:
                    self.checkpoints().discard(sess.cwd, tid, base=self.d.DISPATCH_DIR)
                except Exception:
                    pass
            if self.sessions.get(key) is sess:
                sess.queue.insert(0, item)  # sent when the session is idle again
            elif item.get("request_id"):
                self.error(cp.ChatError("not_running", _t("The session is closed; this message was not sent", "会话已关闭，这句话没发出去")), item["request_id"], key)
            return True
        self.checkpoint_taken(key, sess, mid, r)
        self.take_file_notes(key, sess)
        text = self.to_adapter(sess, mid, item["text"], item.get("display"))
        try:
            a.send({"message_id": mid, "text": text, "images": item["images"]})
            import chat_retry
            chat_retry.sent(sess, item)
        except cp.ChatError as e:
            self.restore_notes(sess, mid)
            sess.sent_text.pop(mid, None)
            self.checkpoint_dropped(sess, mid)
            if item.get("request_id"):
                self.waiters = [w for w in self.waiters if w["request_id"] != item["request_id"]]
            self.error(e, item.get("request_id"), key)
        return True

    def to_adapter(self, sess, message_id, text, display=None):
        """The text the agent gets: pending notes first. The notes leave the session; `restore`
        puts them back when the send fails. `display`: what the bubble shows instead of `text`."""
        if display is not None and display != text:
            sess.sent_text[message_id] = display
        if not sess.notes:
            return text
        notes, sess.notes = sess.notes, []
        sess.sent_text.setdefault(message_id, text)
        self._notes_taken = (sess, notes, message_id)
        return "".join("[system] " + n + "\n" for n in notes) + "\n" + text

    def restore_notes(self, sess, message_id):
        taken = getattr(self, "_notes_taken", None)
        if taken and taken[0] is sess and taken[2] == message_id:
            sess.notes = taken[1] + sess.notes
            sess.sent_text.pop(message_id, None)
        self._notes_taken = None

    def name_later(self, key, text, path):
        """Give the conversation a short name off the loop (the summary model can take seconds):
        `claude -p` writes no ai-title, so without this a chat started here stays 无标题."""
        namer = getattr(self.d, "name_session", None)
        if not callable(namer):
            return

        def run():
            try:
                namer(key, text, path)
            except Exception:
                pass
        self.spawn(run)

    def queue_view(self, sess):
        return [{"message_id": q["message_id"], "text": q.get("display") or q["text"], "images_n": q["images_n"], "at": q["at"]} for q in sess.queue if not q["hidden"]]

    def state_of(self, key, sess):
        body = dict(sess.adapter.state())
        body.update(session=key, queue=self.queue_view(sess), lifecycle=sess.adapter.lifecycle, cwd=sess.cwd)
        if hasattr(sess, "life"):
            body["life"] = sess.life.snapshot(self.life_settings, self.clock())
            body["native_session"] = sess.adapter.session
        for k in ("label", "task"):  # `dispatch agent ask <label|task>` finds the session by these
            if sess.options.get(k):
                body.setdefault(k, sess.options[k])
        return body

    def get(self, key):
        sess = self.sessions.get(key)
        if not sess:
            raise cp.ChatError("no_such_session", _t("This session is not open in Dispatch", "Dispatch 里没有开着这个会话"))
        return sess

    # ------------------------------------------------------------ registry
    def held(self, sess):
        """Dispatch runs this session: its process is up, or the idle reaper stopped it (the next
        send resumes it). A crashed or failed one is nobody's until it is opened again."""
        a = sess.adapter
        return a.alive() or (sess.reaped and a.lifecycle == "stopped")

    def registry(self):
        reg = {"pid": os.getpid(), "started": self.started}
        if self.code:
            reg["code"] = self.code
        if self.door is not None:
            reg["door"] = self.door.info()
            board = getattr(self.door, "board", None)
            if board is not None:
                reg["board"] = {"protocol": board.PROTOCOL, "ready": True,
                                "beads_dir": board.beads_dir, "mode": board.mode}
        return {**reg, "sessions": {
            k: {"agent": s.agent, "cwd": s.cwd, "pid": (s.adapter.state() or {}).get("pid"), "lifecycle": s.adapter.lifecycle, "since": s.adapter.since}
            for k, s in self.sessions.items() if self.held(s)}}

    def reap_orphans(self):
        """Agent processes of one session (Claude Code's `claude -p`) a killed chatd left behind (chatd.json names them, the dead chatd's pid
        says they are orphans). They keep the transcript open, and a resume would be refused as a
        writer conflict with a terminal that does not exist."""
        try:
            path = cp.registry_path(self.d.DISPATCH_DIR)
            with open(path, encoding="utf-8") as f:
                reg = json.load(f)
        except Exception:
            return []
        if not isinstance(reg, dict) or reg.get("pid") == os.getpid() or (_pid_alive(reg.get("pid")) and not _zombie(reg.get("pid"))):
            return []
        killed = []
        for key, info in (reg.get("sessions") or {}).items():
            pid = (info or {}).get("pid") if isinstance(info, dict) else None
            if not isinstance(pid, int) or pid <= 1 or ":" not in key or not _pid_alive(pid):
                continue
            agent, sid = key.split(":", 1)
            if not E.get(agent).chat_owns_process(pid, sid):
                continue
            try:
                import signal
                os.killpg(pid, signal.SIGTERM)  # started with start_new_session: the group is its tools too
                killed.append(pid)
            except (OSError, AttributeError):
                try:
                    os.kill(pid, 15)
                    killed.append(pid)
                except OSError:
                    pass
        # before anything is opened again: an orphan still alive counts as a terminal writer
        end = time.time() + 3
        while time.time() < end and any(_pid_alive(p) and not _zombie(p) for p in killed):
            time.sleep(0.05)
        for p in killed:
            if _pid_alive(p) and not _zombie(p):
                try:
                    import signal
                    os.killpg(p, signal.SIGKILL)
                except (OSError, AttributeError):
                    pass
        return killed

    def save_registry(self, force=False):
        """Write chatd.json (the door and the sessions) when the sessions changed or `force`. Never over
        another live chatd's file: a second chatd going down (an old Dispatch.app quitting) once left
        its dead door in there and every client lost the resident one. With a door of its own, this
        chatd also puts itself back every REGISTRY_CHECK seconds when the file names a dead chatd."""
        try:
            directory = self.d.DISPATCH_DIR
        except Exception:
            return
        path = cp.registry_path(directory)
        if self.door is not None and self.clock() - self._registry_checked >= REGISTRY_CHECK:
            self._registry_checked = self.clock()
            try:
                named = json.load(open(path, encoding="utf-8")).get("pid")
            except (OSError, ValueError, AttributeError):
                named = None
            if named != os.getpid() and not (isinstance(named, int) and _pid_alive(named)):
                force = True
        reg = self.registry()
        snapshot = json.dumps({k: {x: y for x, y in v.items() if x != "since"} for k, v in reg["sessions"].items()}, sort_keys=True)
        if snapshot == self._registry_written and not force:
            return
        try:
            other = json.load(open(path, encoding="utf-8")).get("pid")
        except (OSError, ValueError, AttributeError):
            other = None
        if isinstance(other, int) and other != os.getpid() and self._registry_written is not None and _pid_alive(other):
            return  # another chatd took the door after this one: it is the one clients should reach
        try:
            os.makedirs(directory, exist_ok=True)
            path = cp.registry_path(directory)
            tmp = f"{path}.{os.getpid()}.tmp"
            # the door's token is in it: this user only
            with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as f:
                json.dump(reg, f, ensure_ascii=False)
            os.replace(tmp, path)
            self._registry_written = snapshot
        except OSError:
            pass

    # ------------------------------------------------------------ the loop's two entry points
    def handle_line(self, raw):
        raw = raw.strip()
        if not raw:
            return True
        obj, request_id = None, None
        try:
            obj = json.loads(raw)
            request_id = obj.get("request_id") if isinstance(obj, dict) else None
            cmd = cp.validate_command(obj)
            return self.handle(cmd, obj, request_id)
        except cp.ChatError as e:
            self.error(e, request_id, obj.get("session") if isinstance(obj, dict) and isinstance(obj.get("session"), str) else None)
        except ValueError:
            self.error(cp.ChatError("bad_request", "not a JSON line"))
        except Exception as e:  # one bad command never takes the sidecar down
            self.error(cp.ChatError("bad_request", f"chatd: {type(e).__name__}: {str(e)[:300]}"), request_id,
                       obj.get("session") if isinstance(obj, dict) and isinstance(obj.get("session"), str) else None)
        finally:
            self.tick(reap=False)
        return True

    def tick(self, reap=True):
        import chat_retry
        chat_retry.poll(self)
        if self._wake_out:
            import wake
            wake.poll(self)
        for sess in list(self.starting):
            a = sess.adapter
            try:
                a.drain()
            except Exception as e:
                self.error(cp.ChatError("bad_request", f"chatd: {type(e).__name__}: {str(e)[:300]}"))
            if a.session:
                self.starting.remove(sess)
                sess.last_activity = self.clock()  # its `opened` went out before it had a key to be filed under
                if a.session not in self.sessions or not self.held(self.sessions[a.session]):
                    self.sessions[a.session] = sess
            elif a.lifecycle in ("error", "stopped"):
                self.starting.remove(sess)
                self.waiters = [w for w in self.waiters if w["adapter"] is not a]
        for key, sess in list(self.sessions.items()):
            try:
                sess.adapter.drain()
            except Exception as e:
                self.error(cp.ChatError("bad_request", f"chatd: {type(e).__name__}: {str(e)[:300]}"), session=key)
            self.fail_hidden(key, sess)
            if self.flush_snap(key, sess):
                sess.adapter.drain()
            import chat_life
            if not chat_life.advance(self, key, sess):
                self.pump(key, sess)
        if reap and self.clock() - self._last_reap >= REAP_EVERY:
            self._last_reap = self.clock()
            self.reap()
        if reap:
            self.daemon_account_check()
        if reap and self.clock() - self._last_wake >= WAKE_EVERY:
            self._last_wake = self.clock()
            self.wake_sweep()
        if reap and self.doctor_daily and self.clock() - self._last_doctor >= DOCTOR_CHECK_EVERY:
            self._last_doctor = self.clock()
            self.doctor_sweep()
        if reap and self.doctor_daily and self.clock() - getattr(self, "_last_neat", 0) >= DOCTOR_CHECK_EVERY:
            self._last_neat = self.clock()
            self.neat_sweep()
        if reap and self.doctor_daily and self.clock() - self._last_knowledge >= KNOWLEDGE_EVERY:
            self._last_knowledge = self.clock()
            self.knowledge_sweep()
        if reap and self.clock() - self._last_nextup >= NEXTUP_EVERY:
            self._last_nextup = self.clock()
            self.nextup_sweep()
        if reap and self.clock() - self._last_gc >= GC_CHECK_EVERY:
            self._last_gc = self.clock()
            self.gc_checkpoints()
        self.save_registry()

    def pump(self, key, sess):
        """Send the queue's head when the session is idle."""
        a = sess.adapter
        while sess.queue and a.lifecycle == "idle" and not sess.snap and self.sessions.get(key) is sess:
            item = sess.queue.pop(0)
            if not item["hidden"]:
                self.em.emit("queue", session=key, queue=self.queue_view(sess))
            self.wait_for(a, ("turn_started",), item["request_id"], lambda f, m=item["message_id"]: f.get("message_id") == m)
            try:
                self.send_item(key, sess, item)
            except cp.ChatError as e:
                self.waiters = [w for w in self.waiters if w["request_id"] != item["request_id"]]
                self.error(e, item["request_id"], key)
            a.drain()

    def fail_hidden(self, key, sess):
        """Messages waiting for a (re)start that failed: answer them instead of leaving them hanging."""
        a = sess.adapter
        if not sess.queue or a.lifecycle not in ("error", "stopped") or a.alive():
            return
        for q in [q for q in sess.queue if q["hidden"]]:
            sess.queue.remove(q)
            if q["request_id"]:
                self.error(cp.ChatError("not_running", _t("The session did not start; this message was not sent", "会话没起来，这句话没发出去")), q["request_id"], key)

    def idle_setting(self):
        """agent_sleep_minutes (`dispatch sleep`, sleep.py) from the shared settings (bd), read off the loop;
        the reaper uses the last value it got (30 minutes until then, and when the read fails)."""
        load = getattr(self.d, "settings_load", None)
        if load is None:
            return

        def run():
            try:
                settings = load()
                self.life_settings = settings
                m = settings.get("agent_sleep_minutes", settings.get("chat_idle_close_minutes"))
            except Exception:
                return
            if isinstance(m, (int, float)) and not isinstance(m, bool) and m >= 0:
                self.idle_close = m * 60
        self.background(run)

    def hosted_session(self, session):
        """chatd's key for a session id this daemon holds (running, or idle-closed and resumable), else None."""
        for key, sess in list(self.sessions.items()):
            if key.split(":", 1)[-1] == session and self.held(sess):
                return key
        return None

    def wake_sweep(self):
        """Worker state changes go to disk first (wake.py); when the dispatcher is one of our sessions the
        unread ones are then sent into it. Off the loop: it asks the board; the send happens in tick()."""
        if not hasattr(self.d, "BEADS_DIR") or self._wake_busy or self._wake_out:
            return
        self._wake_busy = True

        def sweep():
            try:
                import wake
                import workers
                batch = wake.sweep(workers.Store(self.d), self.hosted_session)
                if batch:
                    self._wake_out.append(batch)
            except Exception as e:
                self.error(cp.ChatError("bad_request", f"Worker wake: {e}"))
            finally:
                self._wake_busy = False
        self.background(sweep)

    def doctor_sweep(self):
        """Once a day, off the loop: `dispatch doctor` (no fixing); failing checks become notifications
        for the dispatcher, which wake_sweep hands over on its next round."""
        if not hasattr(self.d, "BEADS_DIR") or self._doctor_busy:
            return
        import doctor
        if not doctor.due(self.d.DISPATCH_DIR, self.clock()):
            return
        self._doctor_busy = True

        def run():
            try:
                doctor.daily(self.d, now=self.clock())
            except Exception as e:
                self.error(cp.ChatError("bad_request", f"Doctor: {e}"))
            finally:
                self._doctor_busy = False
        self.background(run)

    def neat_sweep(self):
        """Settings › Agents › Tidy up after work set to once a day (neat_auto.py): the resident chatd starts the
        day's round, one read-only run per project a task was finished in. Each run is a process of its own."""
        try:
            import neat_auto
            if neat_auto.daily_due():
                self.background(neat_auto.daily)
        except Exception as e:
            self.error(cp.ChatError("bad_request", f"Tidy up: {e}"))

    def knowledge_sweep(self):
        """Every 5 minutes, off the loop, resident chatd only: commit what was written in ~/.dispatch and pull
        the other Macs' knowledge (offline ones are skipped; conflicts become notifications)."""
        if self._knowledge_busy or not hasattr(self.d, "hosts"):  # a stand-in `dispatch` (tests) has no Macs to pull from
            return
        self._knowledge_busy = True

        def run():
            try:
                import knowledge_sync
                knowledge_sync.sync_all()
            except Exception as e:
                self.error(cp.ChatError("bad_request", f"Knowledge sync: {str(e)[:300]}"))
            finally:
                self._knowledge_busy = False
        self.background(run)

    def nextup_sweep(self):
        """Every 20 s, off the loop: the first thing noted from a chat starts by itself when fewer sessions work
        than the line allows and it is not paused (`dispatch nextup tick`, capture.py). Its own process: the start
        talks back to this chatd."""
        if self._nextup_busy or not hasattr(self.d, "DISPATCH_DIR"):
            return
        try:
            with open(os.path.join(self.d.DISPATCH_DIR, "capture", "queue.json"), encoding="utf-8") as f:
                q = json.load(f)
        except (OSError, ValueError):
            q = None
        if not isinstance(q, dict) or q.get("paused", True) or not q.get("lined"):
            return  # nothing was ever lined up here, or the line is paused (off until the person turns it on): no process at all
        f = q.get("failed") if isinstance(q.get("failed"), dict) else {}
        if f.get("task") and (int(f.get("tries") or 0) >= 3 or float(f.get("retry_at") or 0) > time.time()):
            return  # a start failed: wait for the next try (1 min, then 5), or for the person after the third
        self._nextup_busy = True
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py")

        def run():
            try:
                subprocess.run([sys.executable, script, "nextup", "tick", "--json"], capture_output=True, text=True, timeout=240)
            except Exception as e:
                self.error(cp.ChatError("bad_request", f"Next up: {str(e)[:300]}"))
            finally:
                self._nextup_busy = False
        self.background(run)

    def daemon_account_check(self):
        """After an account switch of an engine whose sessions share one server (Codex's app-server), restart that
        server once none of its turns runs here: the hub reconnects and resumes every open thread, and the new server
        reads the new account's sign-in."""
        for agent, was in list(self._daemon_account_gen.items()):
            gen = account_generation(agent)
            if gen == was or agent in self._daemon_account_busy:
                continue
            if any(s.agent == agent and s.adapter.lifecycle in ("running", "starting") for s in self.sessions.values()):
                continue  # a turn is running: it finishes on the old account, the restart waits for it
            self._daemon_account_gen[agent] = gen
            self._daemon_account_busy.add(agent)
            eng = E.get(agent)

            def run(eng=eng, agent=agent):
                try:
                    eng.chat_restart_daemon()
                except Exception as e:
                    self.error(cp.ChatError("bad_request", f"chatd: restarting {eng.name} after an account switch failed: {e}"))
                finally:
                    self._daemon_account_busy.discard(agent)
            self.background(run)

    def sleep_asked(self):
        """When `dispatch sleep now` last asked (sleep.py), 0 when never or unreadable."""
        try:
            import sleep
            return sleep.asked_at(self.d.DISPATCH_DIR) if hasattr(self.d, "DISPATCH_DIR") else 0
        except Exception:
            return 0

    def reap(self):
        self.idle_setting()
        if hasattr(self.d, "BEADS_DIR") and not getattr(self, "_worker_recovery_busy", False):
            self._worker_recovery_busy = True
            def recover_workers():
                try:
                    import workers
                    workers.recover_failed(workers.Store(self.d))
                except Exception as e:
                    self.error(cp.ChatError("bad_request", f"Worker recovery: {e}"))
                finally:
                    self._worker_recovery_busy = False
            self.background(recover_workers)
        now = self.clock()
        limit = self.idle_close
        asked = self.sleep_asked()
        for key, sess in list(self.sessions.items()):
            a = sess.adapter
            # Asleep only when its turn ended on its own: "idle" is neither running nor waiting for the person
            # (waiting_permission / waiting_input), and nothing is queued or being snapshotted. Quiet for the
            # setting's minutes, or quiet since before `dispatch sleep now` asked (the bottom bar's Let idle agents sleep).
            quiet = (limit > 0 and now - sess.last_activity >= limit) or (asked and sess.last_activity < asked)
            if quiet and E.get(sess.agent).chat_sleeps_when_idle and a.lifecycle == "idle" and not sess.queue and not sess.snap:
                try:
                    a.close("idle")
                except Exception as e:
                    self.error(cp.ChatError("bad_request", f"chatd: idle close failed: {e}"), session=key)
                a.lifecycle = "stopped"
                sess.reaped = True
                self.sleep_note(key, sess, True)
            elif a.lifecycle in ("stopped", "error") and not a.alive() and not sess.queue and now - sess.last_activity >= STOPPED_KEEP:
                del self.sessions[key]  # long dead: nothing to resume from here any more
                if sess.reaped:
                    self.sleep_note(key, sess, False)

    def gc_checkpoints(self):
        """Once a day (checkpoint.gc_all keeps its own stamp): old turns and their snapshots go."""
        base = self.d.DISPATCH_DIR

        def run():
            try:
                self.checkpoints().gc_all(base)
            except Exception:
                pass
        self.background(run)

    def shutdown(self, reason="shutdown"):
        """Close every session at once: interrupt all running turns, give them SHUTDOWN_TURN_WAIT
        together, close every stdin, give the processes SHUTDOWN_EXIT_WAIT together, then close()
        each (which only has stragglers left to terminate)."""
        live = [s.adapter for s in list(self.sessions.values()) + self.starting
                if s.adapter.lifecycle not in ("stopped", "error") or s.adapter.alive()]
        staged = [a for a in live if hasattr(a, "close_begin")]
        for a in staged:
            try:
                a.close_begin("shutdown")
            except Exception:
                pass
        end = time.time() + SHUTDOWN_TURN_WAIT
        while time.time() < end and any(a.close_busy() for a in staged):
            for a in staged:
                try:
                    a.drain()
                except Exception:
                    pass
            time.sleep(0.02)
        for a in staged:
            try:
                a.close_release()
            except Exception:
                pass
        end = time.time() + SHUTDOWN_EXIT_WAIT
        while time.time() < end and any(a.alive() for a in staged):
            time.sleep(0.02)
        for a in live:
            try:
                if a in staged:
                    a.close("shutdown", wait=0.5)
                else:
                    a.close("shutdown")
            except Exception:
                pass
        self.sessions.clear()
        self.starting = []
        self.save_registry(force=True)

    # ------------------------------------------------------------ commands
    def handle(self, cmd, o, rid):
        if cmd == "hello":
            self.reply("hello", rid, **hello())
        elif cmd == "list":
            self.reply("sessions", rid, sessions=[self.state_of(k, s) for k, s in self.sessions.items()])
        elif cmd == "shutdown":
            self.shutdown()
            self.reply("chatd", rid, state="down", reason="shutdown")
            return False
        elif cmd == "open":
            self.open(o, rid)
        elif cmd == "send":
            self.send(o, rid)
        elif cmd == "withdraw":
            sess = self.get(o["session"])
            hit = next((q for q in sess.queue if q["message_id"] == o["message_id"] and not q["hidden"]), None)
            if not hit:
                raise cp.ChatError("bad_request", _t("This message already went out and cannot be taken back", "这句话已经发出去了，撤不回来"))
            sess.queue.remove(hit)
            self.reply("queue", rid, session=o["session"], queue=self.queue_view(sess))
        elif cmd == "interrupt":
            sess = self.get(o["session"])
            import chat_retry
            if chat_retry.cancel(self, o["session"], sess) and sess.adapter.lifecycle in ("idle", "stopped", "error"):
                self.reply("turn_done", rid, session=o["session"], turn_id="", status="interrupted", duration_ms=0, num_tools=0)
                return True
            if getattr(sess, "life_phase", None) and sess.adapter.lifecycle == "idle":
                sess.life_phase = None
                self.reply("turn_done", rid, session=o["session"], turn_id="", status="interrupted", duration_ms=0, num_tools=0)
                return True
            self.wait_for(sess.adapter, ("turn_done",), rid)
            self.call(sess.adapter, rid, lambda: sess.adapter.interrupt())
        elif cmd == "permission":
            sess = self.get(o["session"])
            self.wait_for(sess.adapter, ("permission_resolved",), rid, lambda f: f.get("permission_id") == o["permission_id"])
            self.call(sess.adapter, rid, lambda: sess.adapter.permission(o["permission_id"], o["decision"], o.get("message"), o.get("updated_input")))
        elif cmd == "answer":
            sess = self.get(o["session"])
            if not isinstance(o["answers"], dict):
                raise cp.ChatError("bad_request", _t("answers is {question: [answers]}", "answers 是 {问题: [答案]}"))
            self.wait_for(sess.adapter, ("permission_resolved",), rid, lambda f: f.get("permission_id") == o["permission_id"])
            self.call(sess.adapter, rid, lambda: sess.adapter.answer(o["permission_id"], o["answers"]))
        elif cmd == "set_model":
            sess = self.get(o["session"])
            self.wait_for(sess.adapter, ("state",), rid)
            self.call(sess.adapter, rid, lambda: sess.adapter.set_model(o["model"], o.get("effort")))
            self.state_after_set(o["session"], sess, rid)
        elif cmd == "set_permission_mode":
            sess = self.get(o["session"])
            self.wait_for(sess.adapter, ("state",), rid)
            self.call(sess.adapter, rid, lambda: sess.adapter.set_permission_mode(o["mode"]))
            self.state_after_set(o["session"], sess, rid)
        elif cmd == "commands":
            sess = self.get(o["session"])
            self.reply("commands", rid, session=o["session"], commands=sess.adapter.commands())
        elif cmd == "replay":
            sess = self.get(o["session"])
            for e in list(sess.replay):  # verbatim, original seq: a view that has them ignores them
                self.write(json.dumps(e, ensure_ascii=False, separators=(",", ":")))
            self.reply("state", rid, **self.state_of(o["session"], sess))
        elif cmd == "note":
            sess = self.get(o["session"])
            sess.notes.append(o["text"])
            self.reply("system", rid, session=o["session"], kind="notice", text=o["text"])
        elif cmd == "close":
            self.close(o["session"], o.get("reason") or "requested", rid)
        return True

    def state_after_set(self, key, sess, rid):
        """Adapters that apply a model or mode change locally (Codex: on the next turn/start) emit no
        `state` of their own; chatd answers for them. Claude's answer comes from its control_response."""
        if getattr(sess.adapter, "state_on_set", True):
            return
        waiting = [w for w in self.waiters if w["adapter"] is sess.adapter and w["request_id"] == rid]
        if rid and not waiting:
            return  # the call failed and was already answered with an error
        self.waiters = [w for w in self.waiters if w not in waiting]
        import chat_life
        chat_life.persist(self, key, sess)
        self.reply("state", rid, **self.state_of(key, sess))

    def call(self, adapter, rid, fn):
        try:
            fn()
        except cp.ChatError as e:
            self.waiters = [w for w in self.waiters if w["request_id"] != rid]
            self.error(e, rid, adapter.session)

    def adapter_class(self, agent):
        return E.get(agent).chat_class()

    def probe(self, agent):
        hit = self._probes.get(agent)
        if not hit or self.clock() - hit[0] > PROBE_TTL:
            hit = self._probes[agent] = (self.clock(), _probe(agent))
        return hit[1]

    def check_cwd(self, cwd):
        try:
            import session_control
            from session_reply import Rejected
        except Exception:
            return os.path.realpath(cwd)
        try:
            return session_control.directory(self.d, cwd)
        except Rejected as e:
            raise cp.ChatError("bad_request", str(e))

    def own_pids(self):
        return {(s.adapter.state() or {}).get("pid") for s in self.sessions.values()} - {None}

    def writer_conflict(self, agent, sid):
        """A live terminal process that already writes this transcript (Claude has no lock)."""
        own = self.own_pids()
        seen = []
        sess_dir = getattr(self.d, "SESS_DIR", "")
        for name in (os.listdir(sess_dir) if sess_dir and os.path.isdir(sess_dir) else []):
            try:
                with open(os.path.join(sess_dir, name), encoding="utf-8") as f:
                    r = json.load(f)
            except (OSError, ValueError):
                continue
            if isinstance(r, dict) and r.get("session_id") == sid and r.get("agent", agent) == agent:
                seen.append(r)
        try:
            seen += [s for s in self.d.live_sessions(local_only=True) if s.get("session_id") == sid and s.get("agent", agent) == agent]
        except Exception:
            pass
        for r in seen:
            pid = r.get("agent_pid")
            if isinstance(pid, int) and pid > 0 and pid not in own and pid != os.getpid() and _pid_alive(pid):
                return r
        return None

    def moved_away(self, agent, sid):
        """Refuse to resume the original of a conversation handed to another Mac (`dispatch move`):
        a second writer here would fork it, both Macs writing their own ending."""
        try:
            rec = (getattr(self.d, "load_moves", dict)() or {}).get(f"{agent}:{sid}") or {}
        except Exception:
            return
        to = rec.get("moved_to") if isinstance(rec, dict) else None
        if not to:
            return
        try:
            name = self.d.host_label(to)
        except Exception:
            name = to
        raise cp.ChatError("moved_away", _t(f"This session moved to {name}; go on there. This is the copy from before the move and can only be read. If the records look wrong, run dispatch move repair first.", f"这个会话已迁到 {name}，请在 {name} 上接着做。这里是迁移前的副本，只能查看记录。记录不对的话，先跑 dispatch move repair。"))

    def owner_elsewhere(self, cwd, resume):
        """A project's Agents start only on the Mac it belongs to (dispatch-project-owners)."""
        fn = getattr(self.d, "owner_elsewhere", None)
        try:
            o = fn(cwd) if callable(fn) and cwd else None
        except Exception:
            o = None
        if o:
            raise cp.ChatError("owner_elsewhere", self.d.owner_refusal(o, resume=resume))

    def open(self, o, rid):
        agent = o["agent"]
        p = self.probe(agent)
        if not p.get("supported"):
            raise cp.ChatError("agent_missing" if not p.get("available") else "unsupported_version", p.get("reason") or _t(f"{agent} has no in-app chat", f"{agent} 不支持应用内聊天"), fatal=True)
        if o.get("permission_mode") and o["permission_mode"] not in cp.PERMISSION_MODES:
            raise cp.ChatError("invalid_model", f"unknown permission mode {o['permission_mode']!r}")
        cwd = self.check_cwd(o["cwd"])
        resume = o.get("resume")
        options = {k: o[k] for k in ("model", "permission_mode", "effort", "task", "label") if o.get(k)}
        key = None
        if resume:
            key = cp.session_key(agent, resume)
            sess = self.sessions.get(key)
            if sess and sess.adapter.alive() and sess.adapter.lifecycle not in ("stopped", "error"):
                a = sess.adapter
                self.reply("opened", rid, session=key, agent=agent, cwd=sess.cwd, resumed=True, model=a.options.get("model") or "",
                           permission_mode=a.options.get("permission_mode") or "", transcript_path=getattr(a, "transcript", "") or "",
                           capabilities=list(a.capabilities))
                self.reply("state", None, **self.state_of(key, sess))
                return
            self.moved_away(agent, resume)
            if not o.get("moving"):  # `dispatch move` resumes it over here before the owner record changes hands
                self.owner_elsewhere(cwd, True)
            if E.get(agent).chat_single_writer:
                hit = self.writer_conflict(agent, resume)
                if hit:
                    where = hit.get("source_app") or _t("a terminal", "终端")
                    raise cp.ChatError("writer_conflict", _t(f"This session is running in {where} (process {hit.get('agent_pid')}); stop it there before taking it into Dispatch", f"这个会话正在{where}里跑（进程 {hit.get('agent_pid')}），先让它停下来再接到 Dispatch"))
        else:
            self.owner_elsewhere(cwd, False)
            if E.get(agent).chat_picks_session_id:
                key = cp.session_key(agent, str(uuid.uuid4()))
        if resume:
            import session_life
            saved = session_life.load(session_life.path_for("runtime", key, self.d.DISPATCH_DIR))
            options = {**{k: v for k, v in (saved.get("options") or {}).items()
                          if k in ("model", "effort", "permission_mode") and v}, **options}
            native = saved.get("native_session") or key
            if native.startswith(agent + ":"):
                resume = native.split(":", 1)[1]
        if not options.get("permission_mode"):
            # the person's answer to "how much may agents do on their own" (autonomy.py, Full auto unless they picked another); Always ask sets nothing
            try:
                import autonomy
                mode = autonomy.chat_mode(autonomy.load()["level"], agent)
                if mode:
                    options["permission_mode"] = mode
            except Exception:  # noqa: BLE001 - never stops a session from opening
                pass
        was = self.sessions.get(key) if key else None
        if was is not None and was.reaped:
            self.sleep_note(key, was, False)  # opened again: it wakes
        self.start(agent, key, cwd, options, resume, rid)

    def start(self, agent, key, cwd, options, resume, rid, old=None):
        """Create and start an adapter. `old`: the stopped session this one resumes (its queue
        carries over, and a failure puts it back and raises instead of replying)."""
        cls = self.adapter_class(agent)
        native_key = cp.session_key(agent, resume) if resume else key
        adapter = cls(None, native_key, cwd, options)
        adapter.emit = self.emitter(adapter)
        adapter.account_gen = account_generation(agent)
        sess = Session(adapter, agent, cwd, options)
        if old is not None:
            sess.queue = old.queue
            sess.notes, sess.sent_text = old.notes, old.sent_text
            sess.cp_by_msg, sess.cp_by_turn, sess.cp_current, sess.cp_slow_told = old.cp_by_msg, old.cp_by_turn, old.cp_current, old.cp_slow_told
            sess.cp_fail_told, sess.cp_paths, sess.snap = old.cp_fail_told, old.cp_paths, old.snap
            sess.net_retry = old.net_retry
        if key:
            self.sessions[key] = sess
        self.wait_for(adapter, ("opened",), rid)
        try:
            adapter.start(resume=resume)
        except cp.ChatError as e:
            self.waiters = [w for w in self.waiters if w["adapter"] is not adapter]
            if key and self.sessions.get(key) is sess:
                if old is not None:
                    self.sessions[key] = old
                else:
                    del self.sessions[key]
            if old is not None:
                raise
            self.error(e, rid, key)
            return None
        if not key and adapter.session and adapter.session not in self.sessions:
            self.sessions[adapter.session] = sess
        elif not adapter.session:
            self.starting.append(sess)  # tick() files it under its key once the agent names it
        adapter.drain()
        return sess

    def send(self, o, rid):
        key = o["session"]
        sess = self.get(key)
        a = sess.adapter
        item = {"message_id": o["message_id"], "text": o["text"], "images": o.get("images") or [], "images_n": len(o.get("images") or []),
                "at": self.clock(), "hidden": False, "request_id": rid}
        if isinstance(o.get("display"), str) and o["display"].strip() and o["display"] != o["text"]:
            item["display"] = o["display"]
        if o.get("retry_of"):
            item["retry_of"] = o["retry_of"]  # chat_retry.py sends it again: same count of tries
        else:
            import chat_retry
            if chat_retry.waiting(sess):
                chat_retry.fire(self, key, sess)  # a new message: the one waiting to go again goes first
                sess = self.get(key)
                a = sess.adapter
        if len(sess.queue) >= cp.QUEUE_LIMIT:
            raise cp.ChatError("queue_full", _t(f"{cp.QUEUE_LIMIT} messages are queued already; wait a moment", f"已经排了 {cp.QUEUE_LIMIT} 句，先等等"))
        if (E.get(sess.agent).chat_account_restart == "process" and a.lifecycle == "idle" and a.alive() and not sess.queue
                and not sess.snap and getattr(a, "account_gen", 0) != account_generation(sess.agent)):
            # The account was switched since this process (Claude Code) started: it would go on with the old account.
            # Stop it the way the idle reaper does; the code below resumes the same conversation, signed in anew.
            try:
                a.close("account_switched")
            except Exception as e:
                self.error(cp.ChatError("bad_request", f"chatd: close after an account switch failed: {e}"), session=key)
            a.lifecycle = "stopped"
            sess.reaped = True
        if a.lifecycle == "stopped" and not a.alive():
            # Reaped for idleness (or the process ended): resume the same transcript, then send.
            _, sid = cp.split_key(a.session)
            self.moved_away(sess.agent, sid)
            self.owner_elsewhere(sess.cwd, True)
            if E.get(sess.agent).chat_single_writer:
                hit = self.writer_conflict(sess.agent, sid)
                if hit:
                    raise cp.ChatError("writer_conflict", _t(f"This session is running in {hit.get('source_app') or 'a terminal'} (process {hit.get('agent_pid')}); stop it there before taking it into Dispatch", f"这个会话正在{hit.get('source_app') or '终端'}里跑（进程 {hit.get('agent_pid')}），先让它停下来再接到 Dispatch"))
            item["hidden"] = True
            sess.queue.insert(0, item)
            options = dict(sess.options)
            options.update({k: a.options[k] for k in ("model", "effort", "permission_mode") if a.options.get(k)})
            try:
                new = self.start(sess.agent, key, sess.cwd, options, sid, None, old=sess)
            except cp.ChatError:
                sess.queue.remove(item)
                raise
            # the message waits for idle; its reply is its turn_started
            new.last_activity = self.clock()
            if sess.reaped:
                self.sleep_note(key, sess, False)
            self.pump(key, new)
            return
        if a.lifecycle in ("error", "stopping", "stopped"):
            raise cp.ChatError("not_running", _t("The session has stopped; open it again and send", "会话已经停了，重新打开再发"))
        if a.lifecycle == "idle" and not sess.queue and not sess.snap and not getattr(sess, "life_phase", None):
            self.wait_for(a, ("turn_started",), rid, lambda f: f.get("message_id") == o["message_id"])
            try:
                self.send_item(key, sess, item)
            except cp.ChatError as e:
                self.waiters = [w for w in self.waiters if w["request_id"] != rid]
                self.error(e, rid, a.session)
            return
        if a.lifecycle == "starting":
            item["hidden"] = True
            sess.queue.append(item)
            return
        if o.get("mode") == "interrupt":
            item["hidden"] = True
            sess.queue.insert(0, item)
            if not sess.hold:
                sess.hold = True
                try:
                    a.interrupt()
                except cp.ChatError:
                    pass
            return
        item["request_id"] = None
        sess.queue.append(item)
        self.reply("queued", rid, session=key, message_id=o["message_id"], position=len(self.queue_view(sess)))
        self.em.emit("queue", session=key, queue=self.queue_view(sess))

    def close(self, key, reason, rid):
        sess = self.get(key)
        a = sess.adapter
        if sess.reaped:
            self.sleep_note(key, sess, False)
        self.wait_for(a, ("closed",), rid)
        self._closed.discard(id(a))
        try:
            a.close(reason)
        except cp.ChatError as e:
            self.error(e, None, key)
        if id(a) not in self._closed:  # already dead: nothing emitted it
            self.waiters = [w for w in self.waiters if not (w["adapter"] is a and w["request_id"] == rid)]
            self.reply("closed", rid, session=key, reason=reason)
        self.waiters = [w for w in self.waiters if w["adapter"] is not a]
        for q in sess.queue:
            if q["hidden"] and q["request_id"]:
                self.error(cp.ChatError("not_running", _t("The session is closed; this message was not sent", "会话已关闭，这句话没发出去")), q["request_id"], key)
        if sess.snap:
            sess.snap["cancelled"] = True
            r = sess.snap["result"] if sess.snap["done"] else None
            if isinstance(r, dict) and r.get("turn_id"):
                try:
                    self.checkpoints().discard(sess.cwd, r["turn_id"], base=self.d.DISPATCH_DIR)
                except Exception:
                    pass
            if sess.snap["item"].get("request_id"):
                self.error(cp.ChatError("not_running", _t("The session is closed; this message was not sent", "会话已关闭，这句话没发出去")), sess.snap["item"]["request_id"], key)
            sess.snap = None
        if self.sessions.get(key) is sess:
            del self.sessions[key]
        self.save_registry()


def _zombie(pid):
    """A killed chatd its parent has not waited for yet still answers kill(pid, 0)."""
    try:
        import subprocess
        return subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout.strip().startswith("Z")
    except Exception:
        return False


def serve(read=None, write=None, d=None, door=True, doctor=False):
    """Run until stdin closes or `shutdown`. `read`: an iterable of lines (stdin by default);
    `write`: a function taking one line (stdout by default)."""
    read = sys.stdin if read is None else read
    app_write = write or (lambda line: (sys.stdout.write(line + "\n"), sys.stdout.flush()))
    lines = queue.Queue()
    try:
        door = Door(lines) if door else None
    except OSError:
        door = None  # no loopback socket: the app window still works, `dispatch agent` says Dispatch is not reachable

    def write(line):
        app_write(line)
        if door is not None:
            door.broadcast(line)

    c = Chatd(write, d=d)
    c.door = door
    board_box = {"svc": None, "next": 0.0}

    def board_check():
        """Start the board service once there is a board (a new user's appears with the setup wizard)."""
        if door is None or board_box["svc"] is not None or time.time() < board_box["next"]:
            return
        board_box["next"] = time.time() + BOARD_CHECK
        if os.environ.get("DISPATCH_BOARD_SERVICE", "1") in ("0", "off", "no"):
            return
        try:
            import board_service
            svc = board_service.start(getattr(c.d, "BEADS_DIR", None))
        except Exception as e:  # no board service is the old way (every caller runs bd), never a broken chatd
            sys.stderr.write("chatd: board service not started: %s\n" % e)
            svc = None
        if svc is not None:
            board_box["svc"] = svc
            door.board = svc
            c.save_registry(force=True)

    board_check()
    c.doctor_daily = doctor
    try:
        import doctor as doctor_mod
        c.code = doctor_mod.code_stamp()
    except Exception:
        c.code = None
    if sys.platform != "win32":
        c.reap_orphans()
    c.em.emit("chatd", state="up", pid=os.getpid())
    c.save_registry(force=True)

    from machines_watch import Watches
    watches = Watches(c.d, c.em.emit) if door is not None and hasattr(c.d, "hosts") else None

    def reader():
        try:
            for raw in read:
                lines.put(raw)
        except Exception:
            pass
        lines.put(None)

    threading.Thread(target=reader, daemon=True).start()
    mobile_next = [0.0]
    helpers = []  # the stop events of the loops below: they end with this chatd, not with the process
    if door is not None and sys.platform == "darwin":
        try:  # the Mac stays awake while an agent works or a phone is connected (awake.py; setting keep_awake)
            import awake
            helpers.append(awake.start_thread())
            import notify_watch
            helpers.append(notify_watch.start_thread())
        except Exception:  # noqa: BLE001
            pass

    def stop_helpers():
        for ev in helpers:
            ev.set()

    def mobile_check():
        # the phone's service lives in this process once something is paired (mobile.py; never raises)
        if door is None or time.time() < mobile_next[0]:
            return
        mobile_next[0] = time.time() + MOBILE_CHECK
        try:
            import mobile
            mobile.attach_to_chatd(getattr(c.d, "DISPATCH_DIR", None))
        except Exception:
            pass

    try:
        while True:
            if watches is not None:
                watches.tick()
            mobile_check()
            board_check()
            try:
                raw = lines.get(timeout=TICK)
            except queue.Empty:
                c.tick()
                continue
            if raw is None:
                break
            try:
                keep = c.handle_line(raw)
            except Exception as e:
                c.error(cp.ChatError("bad_request", f"chatd: {e}"))
                keep = True
            if keep is False:
                stop_helpers()
                _close_board(board_box["svc"])
                if door is not None:
                    door.close()
                c.save_registry(force=True)
                return 0
    except KeyboardInterrupt:
        pass
    finally:
        # a serve that returned left them running before: in tests they woke ten seconds later inside other
        # tests, scanned the Mac's processes and wrote into whatever DISPATCH_DIR that test had set
        stop_helpers()
        if watches is not None:
            watches.close()
        _stop_mobile()  # its Bonjour record goes with this chatd (a phone would see a Mac that is not there)
    c.shutdown()
    _close_board(board_box["svc"])
    c.em.emit("chatd", state="down", reason="stdin closed")
    if door is not None:
        door.close()
    return 0


def _stop_mobile():
    try:
        import mobile
        mobile.detach_from_chatd()
    except Exception:
        pass


def _close_board(board):
    """Finish the queued board writes before chatd goes: every write a caller was promised gets done."""
    if board is None:
        return
    try:
        import board_service
        board.close()
        board_service.set_local(None)
    except Exception:
        pass


def main(a=None):
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stdin.reconfigure(encoding="utf-8")
        except Exception:
            pass
    try:
        import chatd_service
        attached = chatd_service.attach()
        if attached is not None:
            return attached
    except KeyboardInterrupt:
        return 0
    try:
        return serve()
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
