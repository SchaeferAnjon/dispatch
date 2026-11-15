# -*- coding: utf-8 -*-
"""Phone notifications (docs/mobile-protocol.md, "Notifications"): a session on this Mac finished,
stopped, or waits for you, told to the paired phones.

The three kinds are the bell's (inbox.py, task-gfhy), decided by each agent's own end-of-turn signal:

  finished   the turn ended on its own
  stopped    it ended without finishing (an error, a usage limit, the process died); stopping it
             yourself is not news and is never sent
  needs_you  a permission or a question waits for the person

Where they come from: the bell's file (<DISPATCH_DIR>/inbox.json, written by chatd, the Agents window
and the terminal hooks) is the one source. A test from `dispatch mobile notify test` comes through
<DISPATCH_DIR>/mobile/notify-test.json instead, so it does not ring the Mac's own bell.

How they reach the phone, nothing to set up first:

  1. the open event stream (`GET /v1/events`, event `notice`): over the same Wi-Fi, Tailscale or the
     relay, whichever the phone is connected by; the app shows it as a local notification;
  2. when the phone says it is not in front (or has not said so for FOREGROUND_TTL seconds, or has no
     event stream open) and it registered for remote notifications with the relay:
     `POST <relay>/v1/push`, signed with the
     pair's relay key like everything else the Mac says to the relay. The relay holds the phone's
     device token and the Apple key; this Mac never sees either.

Each phone picks the kinds it wants (`POST /v1/notify`), stored with its pair in mobile/state.json:
pair["notify"] = {finished, stopped, needs_you, away_only, remote, foreground_until, last_push}.
`away_only`: only while nobody has touched this Mac's keyboard or mouse for AWAY_SECONDS.
"""
import hashlib
import hmac
import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request

import mobile

KINDS = ("finished", "stopped", "needs_you")
DEFAULTS = {"finished": True, "stopped": True, "needs_you": True, "away_only": False}
FOREGROUND_TTL = 120     # a phone that said "in front" and went quiet this long counts as away
DEDUP_SECONDS = 15       # the same session and kind again this soon is the same news (two sources, a flicker)
AWAY_SECONDS = 120       # away_only: idle this long at the Mac
TITLE_MAX = 80
BODY_MAX = 180
PUSH_TIMEOUT = 10
WORD = {"finished": "Finished", "stopped": "Stopped", "needs_you": "Waiting for you"}

TEST_MAX_AGE = 60        # a test request older than this (the service was down) is dropped
REGISTER_RETRY = 30      # seconds before asking the relay again to know a pair


def one_line(text, limit):
    t = " ".join(str(text or "").split())
    return t if len(t) <= limit else t[:limit - 1].rstrip() + "…"


def bell_path(d):
    return os.path.join(d, "inbox.json")


def test_path(d):
    return os.path.join(d, "mobile", "notify-test.json")


def read_bell(d):
    try:
        with open(bell_path(d), encoding="utf-8") as f:
            data = json.load(f)
        ev = data.get("events") if isinstance(data, dict) else None
        return [e for e in ev if isinstance(e, dict) and e.get("kind") in KINDS] if isinstance(ev, list) else []
    except (OSError, ValueError):
        return []


# ---- what the phone is told -------------------------------------------------------------------------

# How an engine says its program went away mid-turn (chatd's process_exited and friends): words for a
# program, not for a person reading a lock screen.
LOST = re.compile(r"\b(exited|crashed|killed|terminated|not running|did not answer|broken pipe)\b|\bacp\b|app-server|写不进", re.I)
LOST_WORDS = "It quit before it finished. Send a message to pick it up again."


def plain_why(why):
    """Why a session stopped, the way the lock screen says it."""
    w = " ".join(str(why or "").split())
    return LOST_WORDS if w and LOST.search(w) else w


def notice(e, mac=""):
    """A bell event (inbox.py's shape) as the phone's notice: what the lock screen shows and where a tap goes."""
    kind = e.get("kind")
    name = one_line(e.get("title") or e.get("project") or "A session", TITLE_MAX - len(WORD[kind]) - 2)
    if kind == "stopped":
        body = plain_why(e.get("why")) or e.get("text") or ""
    else:
        body = e.get("text") or e.get("why") or ""
    body = one_line(body, BODY_MAX) or (f"In {e.get('project')}" if e.get("project") else "")
    nid = "n-" + re.sub(r"[^A-Za-z0-9_-]", "", str(e.get("id") or ""))[:40]
    return {"id": nid, "kind": kind, "title": f"{WORD[kind]}: {name}", "body": body, "session": e.get("session") or "",
            "project": e.get("project") or "", "at": float(e.get("at") or time.time()), "sound": kind != "stopped", "mac": mac,
            "item": "", "permission": ""}


# ---- Allow and Deny on the notice -------------------------------------------------------------------

ANSWER_RETRY = 1.0       # the bell can be filed a moment before the request is readable: look once more


def chat_request(d, e):
    """(item, request id) of the permission a chatd session waits on (not a question: that needs words)."""
    import waiting
    key = e.get("session") or ""
    ev = waiting.chat_pending(d, key)
    if not ev or not ev.get("permission_id") or ev.get("kind") == "question" or ev.get("questions"):
        return None
    turn = str(e.get("turn") or "")
    return (f"chat:{key}", ev["permission_id"]) if not turn or turn == ev["permission_id"] else None


def _tail(s):
    return [x for x in re.split(r"[:/]", str(s or "")) if x][-1:] or [""]


def ide_request(d, e):
    """(item, tool call id) of what an Agents-window session waits on, from the Waiting list (`dispatch waiting
    --json`). The window files the bell under its session's URI, the list keys the same session by the agent
    host's: they share the id at the end."""
    want = _tail(e.get("session"))
    data = mobile.Cli.json(["waiting", "--json"], default={"items": []})
    for it in (data or {}).get("items") or []:
        if (isinstance(it, dict) and it.get("source") == "ide" and it.get("kind") == "approve" and "allow" in (it.get("actions") or [])
                and _tail(it.get("resource") or str(it.get("id") or "")[len("ide:"):]) == want):
            rid = str((it.get("request") or {}).get("tool_call_id") or "")
            return (it["id"], rid) if rid else None
    return None


def answerable(d, e, chat=chat_request, ide=ide_request, wait=time.sleep):
    """{"item", "permission"} when a needs_you can be answered from the notice itself: a permission that a
    session in Dispatch (chatd) or in the Agents window waits on. The phone sends both back with Allow or
    Deny (POST /v1/session/permission), and the Mac answers only that request: one the person answered on
    the Mac already, or that a newer one replaced, is left alone. Questions, terminal sessions and
    anything not readable now: {} (the notice opens the session instead)."""
    source = e.get("source") or ""
    if e.get("kind") != "needs_you" or not e.get("session") or source not in ("chat", "ide"):
        return {}
    for attempt in range(2):
        try:
            hit = (chat if source == "chat" else ide)(d, e)
        except Exception:
            hit = None
        if hit:
            return {"item": hit[0], "permission": hit[1]}
        if attempt == 0:
            wait(ANSWER_RETRY)
    return {}
    item = f"{source}:{session}"
    for attempt in range(2):
        try:
            rid = chat(d, e) if source == "chat" else ide(item)
        except Exception:
            rid = ""
        if rid:
            return {"item": item, "permission": rid}
        if attempt == 0:
            wait(ANSWER_RETRY)
    return {}


def prefs_of(pair):
    n = (pair or {}).get("notify") or {}
    return {**DEFAULTS, **{k: bool(n[k]) for k in DEFAULTS if k in n}}


def wants(pair, n, away=True):
    """This phone asked for this kind (and, with away_only, nobody is at the Mac)."""
    p = prefs_of(pair)
    if not p.get(n.get("kind"), False):
        return False
    return away or not p["away_only"]


def in_front(pair, now=None):
    n = (pair or {}).get("notify") or {}
    return float(n.get("foreground_until") or 0) > (now or time.time())


def update_prefs(store, pid, body, now=None):
    """POST /v1/notify: the kinds, away_only, remote (the phone registered with the relay) and
    foreground (the app is in front: true renews FOREGROUND_TTL, false ends it). Returns the stored record."""
    now = now or time.time()
    with store.lock:
        s = store.load()
        p = s["pairs"].get(pid)
        if not p:
            return None
        n = dict(p.get("notify") or {})
        for k in DEFAULTS:
            if isinstance(body.get(k), bool):
                n[k] = body[k]
        if isinstance(body.get("remote"), bool):
            n["remote"] = body["remote"]
        if isinstance(body.get("foreground"), bool):
            n["foreground_until"] = now + FOREGROUND_TTL if body["foreground"] else 0
        p["notify"] = n
        store.save(s)
        return n


def describe(pair, settings):
    """GET /v1/notify for one phone."""
    n = (pair or {}).get("notify") or {}
    relay = bool((settings or {}).get("relay_url"))
    return {"ok": True, "kinds": {k: prefs_of(pair)[k] for k in KINDS}, "away_only": prefs_of(pair)["away_only"],
            "relay": relay, "remote": bool(n.get("remote")) and relay, "last_push": n.get("last_push"),
            "foreground": in_front(pair)}


# ---- is anybody at this Mac -------------------------------------------------------------------------

_idle_cache = [0.0, 0.0]


def idle_seconds(now=None):
    """Seconds since the last keyboard or mouse input (IOHIDSystem's HIDIdleTime), cached for 10 s; 0 when unknown."""
    now = now or time.time()
    if now - _idle_cache[0] < 10:
        return _idle_cache[1]
    v = 0.0
    try:
        out = subprocess.run(["ioreg", "-c", "IOHIDSystem", "-d", "4"], capture_output=True, text=True, timeout=3).stdout
        m = re.search(r'"HIDIdleTime"\s*=\s*(\d+)', out)
        v = int(m.group(1)) / 1e9 if m else 0.0
    except (OSError, subprocess.SubprocessError):
        v = 0.0
    _idle_cache[:] = [now, v]
    return v


# ---- the relay ------------------------------------------------------------------------------------------

def relay_signature(secret_b64, purpose, pair, role, ts):
    """HMAC-SHA256(relay-auth key, "<purpose>|<pair>|<role>|<ts>"), the relay's proof of the pair."""
    key = mobile.hkdf(mobile.unb64url(secret_b64), mobile.KEY_RELAY)
    return mobile.b64url(hmac.new(key, f"{purpose}|{pair}|{role}|{ts}".encode(), hashlib.sha256).digest())


def push_request(relay_url, pair, n, now=None):
    """(url, body bytes) of POST <relay>/v1/push for one notice."""
    ts = int(now or time.time())
    notice_ = {k: n[k] for k in ("id", "kind", "title", "body", "session", "sound", "mac")}
    if n.get("item") and n.get("permission"):
        notice_.update(item=n["item"], permission=n["permission"])  # Allow and Deny on the lock screen
    body = {"pair": pair["id"], "ts": ts, "sig": relay_signature(pair["secret"], "push", pair["id"], "mac", ts), "notice": notice_}
    return relay_url.rstrip("/") + "/v1/push", json.dumps(body, ensure_ascii=False).encode("utf-8")


def register_request(relay_url, pair, now=None):
    """(url, body bytes) of POST <relay>/v1/register: the pair's relay key, so the relay accepts the phone's
    token and this Mac's pushes. The Mac helper sends the same when it carries a relay channel."""
    ts = int(now or time.time())
    key = mobile.hkdf(mobile.unb64url(pair["secret"]), mobile.KEY_RELAY)
    body = {"pair": pair["id"], "key": mobile.b64url(key), "ts": ts, "sig": relay_signature(pair["secret"], "register", pair["id"], "mac", ts)}
    return relay_url.rstrip("/") + "/v1/register", json.dumps(body).encode("utf-8")


def post(url, body, opener=None):
    """{"status", "code"} of a JSON POST to the relay; status 0 when it could not be reached."""
    req = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json"})
    try:
        with (opener or urllib.request.urlopen)(req, timeout=PUSH_TIMEOUT) as r:
            return {"status": r.status, "code": "ok"}
    except urllib.error.HTTPError as e:
        try:
            code = json.loads(e.read().decode("utf-8") or "{}").get("code") or str(e.code)
        except ValueError:
            code = str(e.code)
        return {"status": e.code, "code": code}
    except (OSError, ValueError) as e:
        return {"status": 0, "code": "unreachable", "message": str(e)[:200]}


def register_pair(relay_url, pair, opener=None):
    return post(*register_request(relay_url, pair), opener=opener)


def send_push(relay_url, pair, n, opener=None):
    """{"status", "code"}: 200 queued at Apple; 404 no_token (the phone has not registered), 503
    push_not_set_up (the relay has no Apple key yet), 410 gone (the phone uninstalled the app), 0 unreachable."""
    r = post(*push_request(relay_url, pair, n), opener=opener)
    if r["code"] == "not_paired" and register_pair(relay_url, pair, opener)["status"] == 200:
        r = post(*push_request(relay_url, pair, n), opener=opener)  # the relay did not know the pair yet
    return r


# ---- the notifier ---------------------------------------------------------------------------------------

class Notifier:
    """Watches the bell's file, turns new events into notices, puts them on the phones' event streams
    and sends the remote ones."""

    def __init__(self, service, poll=1.0, clock=time.time, idle=idle_seconds, sender=send_push, registrar=register_pair, asker=None):
        self.svc = service
        self.asker = asker or (lambda e: answerable(self.svc.d, e))
        self.poll = poll
        self.clock = clock
        self.idle = idle
        self.sender = sender
        self.registrar = registrar
        self.asked = {}          # pair id -> when the relay was last asked to know it
        self.stop_ = threading.Event()
        self.lock = threading.Lock()
        self.seen = set()
        self.recent = {}
        self.mtime = None
        self.started = clock()
        self.pushing = []        # the remote pushes on their way (join() waits for them)

    def start(self):
        for e in read_bell(self.svc.d):
            self.seen.add(e.get("id"))
        try:
            self.mtime = os.stat(bell_path(self.svc.d)).st_mtime_ns
        except OSError:
            self.mtime = None
        threading.Thread(target=self._loop, daemon=True).start()
        return self

    def stop(self):
        self.stop_.set()

    def _loop(self):
        while not self.stop_.wait(self.poll):
            for check in (self.check_bell, self.check_test, self.check_relay):
                try:
                    check()
                except Exception:
                    pass

    def check_bell(self):
        try:
            m = os.stat(bell_path(self.svc.d)).st_mtime_ns
        except OSError:
            return
        if m == self.mtime:
            return
        self.mtime = m
        for e in read_bell(self.svc.d):
            if e.get("id") in self.seen:
                continue
            self.seen.add(e.get("id"))
            # read already (you stopped it yourself, or a newer one replaced it) or old: not news
            if e.get("read") or float(e.get("at") or 0) < self.started - 5:
                continue
            self.emit(e)

    def check_relay(self):
        """With a relay set, each pair (pending too: the phone registers its token right after pairing) is made
        known to it, so nothing else has to run first. Remembered per pair and relay; retried every
        REGISTER_RETRY seconds while the relay is unreachable."""
        state = self.svc.store.load()
        relay = (state.get("settings") or {}).get("relay_url") or ""
        if not relay:
            return
        now = self.clock()
        for pid, p in list(state["pairs"].items()):
            if p.get("relay_known") == relay or now - self.asked.get(pid, 0) < REGISTER_RETRY:
                continue
            self.asked[pid] = now
            r = self.registrar(relay, p)
            if r.get("status") in (200, 409):  # 409: the Mac helper registered it with another key; nothing to fix here
                with self.svc.store.lock:
                    s = self.svc.store.load()
                    if pid in s["pairs"]:
                        s["pairs"][pid]["relay_known"] = relay
                        self.svc.store.save(s)

    def check_test(self):
        """`dispatch mobile notify test` leaves a request here; it is sent once, as a test."""
        p = test_path(self.svc.d)
        try:
            with open(p, encoding="utf-8") as f:
                req = json.load(f)
        except (OSError, ValueError):
            req = None
        if req is None and not os.path.exists(p):
            return
        try:
            os.remove(p)
        except OSError:
            pass
        if isinstance(req, dict) and self.clock() - float(req.get("at") or 0) < TEST_MAX_AGE:
            kind = req.get("kind") if req.get("kind") in KINDS else "finished"
            self.emit(test_event(kind, self.clock()), test=True)

    def emit(self, e, test=False):
        """One event to every phone that wants it. Returns the notice (None when it was a repeat)."""
        now = self.clock()
        k = (e.get("session"), e.get("kind"))
        with self.lock:
            for key in [x for x, t in self.recent.items() if now - t > DEDUP_SECONDS]:
                del self.recent[key]
            if not test and k in self.recent:
                return None
            self.recent[k] = now
        state = self.svc.store.load()
        n = notice(e, state["mac"])
        if test:
            n["test"] = True
        elif n["kind"] == "needs_you":
            n.update(self.asker(e) or {})
        self.svc.hub.publish("notice", n)
        relay = (state.get("settings") or {}).get("relay_url") or ""
        if relay:
            away = None
            for p in state["pairs"].values():
                if p.get("status") != "paired" or not ((p.get("notify") or {}).get("remote")):
                    continue
                if in_front(p, now) and self._streaming(p["id"]):
                    continue  # the open stream shows it
                if away is None:
                    away = self.idle() >= AWAY_SECONDS
                if not test and not wants(p, n, away):
                    continue
                t = threading.Thread(target=self._push, args=(relay, p, n), daemon=True)
                self.pushing = [x for x in self.pushing if x.is_alive()] + [t]
                t.start()
        return n

    def _goes_remote(self, p):
        """This phone gets its notices through Apple right now (relay set, registered, not in front)."""
        relay = ((self.svc.store.load().get("settings") or {}).get("relay_url") or "")
        return bool(relay and (p.get("notify") or {}).get("remote") and not (in_front(p, self.clock()) and self._streaming(p["id"])))

    def _streaming(self, pair_id):
        """In front counts only while that phone's stream is open: an app iOS suspended before it said so
        has no stream, and the notice goes through Apple instead of nowhere."""
        api = getattr(self.svc, "api", None)
        return api.streaming(pair_id) if api is not None and hasattr(api, "streaming") else True

    def join(self, timeout=5.0):
        for t in list(self.pushing):
            t.join(timeout)

    def _push(self, relay, pair, n):
        r = self.sender(relay, pair, n)
        with self.svc.store.lock:
            s = self.svc.store.load()
            p = s["pairs"].get(pair["id"])
            if not p:
                return
            rec = dict(p.get("notify") or {})
            rec["last_push"] = {"at": self.clock(), "status": r.get("status"), "code": r.get("code"), "kind": n["kind"]}
            if r.get("code") in ("no_token", "gone"):
                rec["remote"] = False  # the phone registers again when it can
            p["notify"] = rec
            self.svc.store.save(s)

    def stream_wants(self, pair_id, n):
        """The event stream asks before it sends a notice to one phone."""
        p = self.svc.store.get(pair_id)
        if not p:
            return False
        if self._goes_remote(p):
            return False  # Apple brings it; a suspended app would otherwise show it again when it wakes
        if n.get("test"):
            return True
        away = True if not prefs_of(p)["away_only"] else self.idle() >= AWAY_SECONDS
        return wants(p, n, away)


def test_event(kind="finished", now=None):
    """`dispatch mobile notify test` and the phone's Send a test: an event shaped like the bell's."""
    now = now or time.time()
    text = {"finished": "This is how a finished session looks on your phone.",
            "stopped": "This is how a session that stopped looks on your phone.",
            "needs_you": "This is how a question from an agent looks on your phone."}[kind]
    return {"id": f"test-{int(now * 1000)}", "at": now, "kind": kind, "session": "", "title": "Test from your Mac",
            "project": "", "text": text, "why": text if kind == "stopped" else ""}


def file_test_request(d, kind, now=None):
    """`dispatch mobile notify test`: ask the running service for a test notice (it looks every second)."""
    p = test_path(d)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = f"{p}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"kind": kind, "at": now or time.time()}, f)
    os.replace(tmp, p)
