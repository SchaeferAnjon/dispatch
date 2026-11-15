# -*- coding: utf-8 -*-
"""Phone notifications (mobile_push.py): the notice a bell event becomes, each phone's choices, the
watcher of the bell's file, chatd's events while there is no bell, the remote push through the relay,
and the event stream that only carries what a phone asked for."""
import argparse
import hashlib
import hmac
import http.client
import io
import json
import os
import sys
import tempfile
import time
import unittest
import urllib.error
from contextlib import redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import mobile  # noqa: E402
import mobile_push  # noqa: E402


class Hub:
    def __init__(self):
        self.out = []

    def publish(self, kind, data):
        self.out.append((kind, data))


class FakeService:
    def __init__(self, d):
        self.d = d
        self.store = mobile.Store(d)
        self.hub = Hub()


def paired(store, notify=None, relay=""):
    p, _ = store.new_pair()
    store.bind(p["id"], "dev-1", "iPhone")
    s = store.load()
    if notify is not None:
        s["pairs"][p["id"]]["notify"] = notify
    if relay:
        s["settings"]["relay_url"] = relay
    store.save(s)
    return store.get(p["id"])


def bell(d, events):
    with open(os.path.join(d, "inbox.json"), "w", encoding="utf-8") as f:
        json.dump({"v": 1, "events": events}, f)


def ev(i, kind="finished", **kw):
    return {"id": i, "at": time.time(), "kind": kind, "session": kw.pop("session", f"chat:claude-code:{i}"), "title": "Fix the login page",
            "project": "kanban", "text": "Done. The page loads again.", "why": "", "read": False, **kw}


class Notice(unittest.TestCase):
    def test_each_kind(self):
        n = mobile_push.notice(ev("a1"), "mac-1")
        self.assertEqual(n["title"], "Finished: Fix the login page")
        self.assertEqual(n["body"], "Done. The page loads again.")
        self.assertEqual((n["id"], n["kind"], n["mac"], n["sound"]), ("n-a1", "finished", "mac-1", True))
        s = mobile_push.notice(ev("a2", "stopped", why="Hit a usage limit"))
        self.assertEqual((s["title"], s["body"], s["sound"]), ("Stopped: Fix the login page", "Hit a usage limit", False))
        for why in ("opencode acp exited; the next message starts it again", "codex app-server crashed", "写不进 Claude 进程：broken pipe"):
            self.assertEqual(mobile_push.notice(ev("a4", "stopped", why=why))["body"], mobile_push.LOST_WORDS)
        self.assertEqual(mobile_push.plain_why("You've hit your usage limit · resets 3pm"), "You've hit your usage limit · resets 3pm")
        w = mobile_push.notice(ev("a3", "needs_you", text="Run npm test?"))
        self.assertEqual((w["title"], w["body"]), ("Waiting for you: Fix the login page", "Run npm test?"))

    def test_short_and_safe(self):
        n = mobile_push.notice(ev("x/../y z" * 20, title="t" * 300, text="w " * 400))
        self.assertLessEqual(len(n["title"]), mobile_push.TITLE_MAX)
        self.assertLessEqual(len(n["body"]), mobile_push.BODY_MAX)
        self.assertRegex(n["id"], r"^n-[A-Za-z0-9_-]{1,40}$")

    def test_no_text_says_the_project(self):
        n = mobile_push.notice(ev("b", text="", title=""))
        self.assertEqual((n["title"], n["body"]), ("Finished: kanban", "In kanban"))


class Answerable(unittest.TestCase):
    """Allow and Deny on a needs_you notice: which request it answers."""

    def bell_ev(self, source="chat", session="opencode:ses_1", **kw):
        return {"id": "w1", "kind": "needs_you", "source": source, "session": session, **kw}

    def test_a_chatd_permission(self):
        chat = lambda d, e: ("chat:opencode:ses_1", "per_9")
        self.assertEqual(mobile_push.answerable("/d", self.bell_ev(), chat=chat, wait=lambda s: None),
                         {"item": "chat:opencode:ses_1", "permission": "per_9"})

    def test_chat_request_reads_chatd_and_skips_questions_and_old_ones(self):
        import waiting
        pending = {"permission_id": "per_9", "summary": "bash ls"}
        with mock.patch.object(waiting, "chat_pending", lambda d, key: pending):
            self.assertEqual(mobile_push.chat_request("/d", self.bell_ev(turn="per_9")), ("chat:opencode:ses_1", "per_9"))
            self.assertEqual(mobile_push.chat_request("/d", self.bell_ev()), ("chat:opencode:ses_1", "per_9"))
            self.assertIsNone(mobile_push.chat_request("/d", self.bell_ev(turn="per_8")))  # answered since; a newer one waits
            pending.update(kind="question", questions=[{"question": "Which one?"}])
            self.assertIsNone(mobile_push.chat_request("/d", self.bell_ev()))
        with mock.patch.object(waiting, "chat_pending", lambda d, key: None):
            self.assertIsNone(mobile_push.chat_request("/d", self.bell_ev()))

    def test_an_agents_window_permission_found_by_its_session_id(self):
        rows = {"items": [
            {"id": "ide:claude:/other", "source": "ide", "kind": "approve", "resource": "claude:/other", "actions": ["allow", "deny", "open"], "request": {"tool_call_id": "t0"}},
            {"id": "ide:claude:/6236", "source": "ide", "kind": "approve", "resource": "claude:/6236", "actions": ["allow", "deny", "open"], "request": {"tool_call_id": "toolu_1"}},
        ]}
        with mock.patch.object(mobile.Cli, "json", lambda argv, default=None: rows):
            self.assertEqual(mobile_push.ide_request("/d", self.bell_ev("ide", "agent-host-claude:/6236")), ("ide:claude:/6236", "toolu_1"))
            rows["items"][1]["kind"] = "decide"  # a question in the window: open it instead
            self.assertIsNone(mobile_push.ide_request("/d", self.bell_ev("ide", "agent-host-claude:/6236")))

    def test_nothing_to_answer(self):
        never = lambda d, e: self.fail("not asked")
        for e in (self.bell_ev("terminal", "claude-code:1"), {**self.bell_ev(), "kind": "finished"}, self.bell_ev(session="")):
            self.assertEqual(mobile_push.answerable("/d", e, chat=never, ide=never, wait=lambda s: None), {})

    def test_looks_once_more_when_the_request_is_not_readable_yet(self):
        tries, waits = [], []

        def chat(d, e):
            tries.append(1)
            return ("chat:opencode:ses_1", "per_1") if len(tries) > 1 else None
        self.assertEqual(mobile_push.answerable("/d", self.bell_ev(), chat=chat, wait=waits.append)["permission"], "per_1")
        self.assertEqual(waits, [mobile_push.ANSWER_RETRY])
        boom = lambda d, e: (_ for _ in ()).throw(OSError("chatd is down"))
        self.assertEqual(mobile_push.answerable("/d", self.bell_ev(), chat=boom, wait=lambda s: None), {})

    def test_the_relay_gets_them_only_when_there_is_something_to_answer(self):
        pair = {"id": "p-abc", "secret": Relay.SECRET}
        n = mobile_push.notice(ev("w", "needs_you", text="Run npm test?"))
        self.assertNotIn("item", json.loads(mobile_push.push_request("https://r", pair, n)[1])["notice"])
        n.update(item="chat:opencode:ses_1", permission="per_9")
        b = json.loads(mobile_push.push_request("https://r", pair, n)[1])["notice"]
        self.assertEqual((b["item"], b["permission"]), ("chat:opencode:ses_1", "per_9"))

    def test_the_mac_answers_only_the_request_on_the_notice(self):
        import mobile_api
        sent = []

        class C:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def request(self, op, **kw):
                sent.append((op, kw["permission_id"], kw["decision"]))

        api = mock.Mock(svc=mock.Mock(d="/d"))
        api._pending = lambda key: {"permission_id": "per_9"}
        import chat_client
        with mock.patch.object(chat_client.ChatClient, "connect", lambda *a, **k: C()):
            r = mobile_api.Api.permission(api, {"item": "chat:opencode:ses_1", "decision": "deny", "permission": "per_8"}, {})
            self.assertEqual((r["ok"], r["code"]), (False, "not_waiting"))
            self.assertEqual(sent, [])
            self.assertTrue(mobile_api.Api.permission(api, {"item": "chat:opencode:ses_1", "decision": "deny", "permission": "per_9"}, {})["ok"])
            self.assertTrue(mobile_api.Api.permission(api, {"item": "chat:opencode:ses_1", "decision": "allow"}, {})["ok"])  # the Waiting list's buttons
        self.assertEqual(sent, [("permission", "per_9", "deny"), ("permission", "per_9", "allow")])


class Prefs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = mobile.Store(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_defaults_and_updates(self):
        p = paired(self.store)
        self.assertEqual(mobile_push.prefs_of(p), {"finished": True, "stopped": True, "needs_you": True, "away_only": False})
        mobile_push.update_prefs(self.store, p["id"], {"finished": False, "away_only": True, "remote": True, "junk": 1, "stopped": "no"})
        p = self.store.get(p["id"])
        self.assertEqual(mobile_push.prefs_of(p), {"finished": False, "stopped": True, "needs_you": True, "away_only": True})
        self.assertNotIn("junk", p["notify"])
        d = mobile_push.describe(p, {})
        self.assertFalse(d["relay"])
        self.assertFalse(d["remote"])  # registered with a relay this Mac does not use: not remote
        self.assertTrue(mobile_push.describe(p, {"relay_url": "https://r"})["remote"])

    def test_foreground_lasts_a_while(self):
        p = paired(self.store)
        mobile_push.update_prefs(self.store, p["id"], {"foreground": True}, now=1000)
        p = self.store.get(p["id"])
        self.assertTrue(mobile_push.in_front(p, 1000 + mobile_push.FOREGROUND_TTL - 1))
        self.assertFalse(mobile_push.in_front(p, 1000 + mobile_push.FOREGROUND_TTL + 1))
        mobile_push.update_prefs(self.store, p["id"], {"foreground": False}, now=1001)
        self.assertFalse(mobile_push.in_front(self.store.get(p["id"]), 1001))

    def test_unknown_pair(self):
        self.assertIsNone(mobile_push.update_prefs(self.store, "p-nope", {"finished": False}))


class Relay(unittest.TestCase):
    SECRET = mobile.b64url(bytes(range(32)))

    def test_signature_matches_the_relay(self):
        # the relay's own test vector (dispatch-mobile relay/test/core.test.ts): register|p-abc|mac|1790000000
        self.assertEqual(mobile_push.relay_signature(self.SECRET, "register", "p-abc", "mac", 1790000000), "aCewRd9K7fb42XfXYAbXJ-CJYH20fH411xMO2TU-0Iw")
        key = mobile.hkdf(bytes(range(32)), mobile.KEY_RELAY)
        want = mobile.b64url(hmac.new(key, b"push|p-abc|mac|1790000000", hashlib.sha256).digest())
        self.assertEqual(mobile_push.relay_signature(self.SECRET, "push", "p-abc", "mac", 1790000000), want)

    def test_push_request(self):
        n = mobile_push.notice(ev("q"), "mac-1")
        url, body = mobile_push.push_request("https://relay.example/", {"id": "p-abc", "secret": self.SECRET}, n, now=1790000000)
        self.assertEqual(url, "https://relay.example/v1/push")
        b = json.loads(body)
        self.assertEqual((b["pair"], b["ts"]), ("p-abc", 1790000000))
        self.assertEqual(b["sig"], mobile_push.relay_signature(self.SECRET, "push", "p-abc", "mac", 1790000000))
        self.assertEqual(sorted(b["notice"]), ["body", "id", "kind", "mac", "session", "sound", "title"])
        self.assertNotIn("secret", body.decode())

    def test_send_push_reads_the_relays_answer(self):
        pair = {"id": "p-abc", "secret": self.SECRET}
        n = mobile_push.notice(ev("q"))

        class Ok:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        self.assertEqual(mobile_push.send_push("https://r", pair, n, opener=lambda req, timeout: Ok()), {"status": 200, "code": "ok"})

        def refuse(req, timeout):
            raise urllib.error.HTTPError(req.full_url, 503, "x", {}, io.BytesIO(b'{"ok": false, "code": "push_not_set_up"}'))
        self.assertEqual(mobile_push.send_push("https://r", pair, n, opener=refuse), {"status": 503, "code": "push_not_set_up"})

        def down(req, timeout):
            raise urllib.error.URLError("no route")
        self.assertEqual(mobile_push.send_push("https://r", pair, n, opener=down)["code"], "unreachable")

    def test_a_pair_the_relay_does_not_know_is_registered_then_sent(self):
        pair = {"id": "p-abc", "secret": self.SECRET}
        url, body = mobile_push.register_request("https://r/", pair, now=1790000000)
        b = json.loads(body)
        self.assertEqual(url, "https://r/v1/register")
        self.assertEqual(b["sig"], "aCewRd9K7fb42XfXYAbXJ-CJYH20fH411xMO2TU-0Iw")  # the relay's vector
        self.assertEqual(b["key"], mobile.b64url(mobile.hkdf(bytes(range(32)), mobile.KEY_RELAY)))
        known, calls = [], []

        class Ok:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def relay(req, timeout):
            path = req.full_url.split("/r", 1)[1]
            calls.append(path)
            if path == "/v1/register":
                known.append(1)
                return Ok()
            if not known:
                raise urllib.error.HTTPError(req.full_url, 401, "x", {}, io.BytesIO(b'{"ok": false, "code": "not_paired"}'))
            return Ok()
        self.assertEqual(mobile_push.send_push("https://r", pair, mobile_push.notice(ev("q")), opener=relay)["code"], "ok")
        self.assertEqual(calls, ["/v1/push", "/v1/register", "/v1/push"])


class Watch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name
        self.svc = FakeService(self.d)
        self.sent = []
        self.idle = 0.0
        self.n = mobile_push.Notifier(self.svc, idle=lambda: self.idle, sender=self.send)

    def tearDown(self):
        self.n.stop()
        self.n.join()
        self.tmp.cleanup()

    def send(self, relay, pair, n):
        self.sent.append((relay, pair["id"], n["id"]))
        return {"status": 200, "code": "ok"}

    def notices(self):
        return [d for k, d in self.svc.hub.out if k == "notice"]

    def wait_pushes(self, count):
        self.n.join()

    def test_new_bell_events_become_notices(self):
        bell(self.d, [ev("old")])
        self.n.start()
        self.n.check_bell()
        self.assertEqual(self.notices(), [])  # what was there before is not news
        time.sleep(0.01)
        bell(self.d, [ev("old"), ev("new1", "stopped", why="Something went wrong"), ev("seen", read=True), ev("stale", at=time.time() - 3600)])
        os.utime(os.path.join(self.d, "inbox.json"), ns=(time.time_ns(), time.time_ns() + 10_000_000))
        self.n.check_bell()
        self.assertEqual([x["id"] for x in self.notices()], ["n-new1"])
        self.n.check_bell()
        self.assertEqual(len(self.notices()), 1)  # file unchanged: nothing again

    def test_a_test_request_is_sent_once_and_not_through_the_bell(self):
        self.n.start()
        mobile_push.file_test_request(self.d, "needs_you")
        self.n.check_test()
        got = self.notices()
        self.assertEqual([(x["kind"], x["title"], x.get("test")) for x in got], [("needs_you", "Waiting for you: Test from your Mac", True)])
        self.assertFalse(os.path.exists(mobile_push.test_path(self.d)))
        self.assertFalse(os.path.exists(os.path.join(self.d, "inbox.json")))
        self.n.check_test()
        self.assertEqual(len(self.notices()), 1)
        mobile_push.file_test_request(self.d, "stopped", now=time.time() - 3600)  # the service was down then
        self.n.check_test()
        self.assertEqual(len(self.notices()), 1)

    def test_what_chatd_files_in_the_bell_reaches_the_phone(self):
        import inbox
        self.n.start()
        time.sleep(0.01)
        inbox.add("finished", "opencode:ses_1", "chat", "opencode", "Make the cart button blue", "shop", "/p/shop",
                  "The cart button is blue now.", base=self.d)
        inbox.add("stopped", "claude-code:2", "chat", "claude-code", "Go", "shop", "/p/shop", "", "", True, base=self.d)
        os.utime(os.path.join(self.d, "inbox.json"), ns=(time.time_ns(), time.time_ns() + 10_000_000))
        self.n.check_bell()
        [n] = self.notices()  # stopping it yourself is filed read: not news
        self.assertEqual((n["kind"], n["title"], n["body"], n["project"], n["session"]),
                         ("finished", "Finished: Make the cart button blue", "The cart button is blue now.", "shop", "opencode:ses_1"))

    def test_a_permission_notice_carries_what_allow_and_deny_answer(self):
        asked = []
        self.n.asker = lambda e: asked.append(e["id"]) or {"item": "chat:opencode:ses_1", "permission": "per_9"}
        w = self.n.emit(ev("w1", "needs_you", session="opencode:ses_1"))
        self.assertEqual((w["item"], w["permission"]), ("chat:opencode:ses_1", "per_9"))
        f = self.n.emit(ev("f1", session="opencode:ses_1"))
        self.assertEqual((f["item"], f["permission"]), ("", ""))
        self.assertEqual(asked, ["w1"])  # only a needs_you is looked up
        t = self.n.emit(mobile_push.test_event("needs_you"), test=True)
        self.assertEqual(t["item"], "")

    def test_same_session_and_kind_once(self):
        self.assertIsNotNone(self.n.emit(ev("a", session="s1")))
        self.assertIsNone(self.n.emit(ev("b", session="s1")))
        self.assertIsNotNone(self.n.emit(ev("c", "needs_you", session="s1")))
        self.assertIsNotNone(self.n.emit(ev("d", session="s1"), test=True))

    def test_remote_only_when_the_phone_is_not_in_front(self):
        p = paired(self.svc.store, {"remote": True}, relay="https://relay.example")
        self.n.emit(ev("r1", session="s1"))
        self.wait_pushes(1)
        self.assertEqual(self.sent, [("https://relay.example", p["id"], "n-r1")])
        last = self.svc.store.get(p["id"])["notify"]["last_push"]
        deadline = time.time() + 2
        while not last and time.time() < deadline:
            time.sleep(0.02)
            last = self.svc.store.get(p["id"])["notify"].get("last_push")
        self.assertEqual((last["code"], last["kind"]), ("ok", "finished"))
        mobile_push.update_prefs(self.svc.store, p["id"], {"foreground": True})
        self.n.emit(ev("r2", session="s2"))
        time.sleep(0.1)
        self.assertEqual(len(self.sent), 1)

    def test_in_front_without_an_open_stream_goes_through_apple(self):
        # the app said it is in front, then iOS suspended it before it could say otherwise: its stream is gone
        p = paired(self.svc.store, {"remote": True}, relay="https://r")
        mobile_push.update_prefs(self.svc.store, p["id"], {"foreground": True})
        open_ = {p["id"]: True}
        self.svc.api = type("Api", (), {"streaming": lambda _s, pid: open_.get(pid, False)})()
        self.n.emit(ev("f1", session="s1"))
        self.wait_pushes(1)
        self.assertEqual(self.sent, [])
        open_[p["id"]] = False
        self.n.emit(ev("f2", session="s2"))
        self.wait_pushes(1)
        self.assertEqual([x[2] for x in self.sent], ["n-f2"])

    def test_each_pair_is_made_known_to_the_relay_once(self):
        asked = []
        answer = {"status": 0, "code": "unreachable"}
        self.n.registrar = lambda relay, p: (asked.append((relay, p["id"])), answer)[1]
        now = [1000.0]
        self.n.clock = lambda: now[0]
        self.n.check_relay()  # no relay: nothing
        self.assertEqual(asked, [])
        p = paired(self.svc.store, relay="https://r")
        pending, _ = self.svc.store.new_pair()
        self.n.check_relay()
        self.assertEqual(sorted(asked), sorted([("https://r", p["id"]), ("https://r", pending["id"])]))
        self.n.check_relay()  # unreachable: not again at once
        self.assertEqual(len(asked), 2)
        answer = {"status": 200, "code": "ok"}
        now[0] += mobile_push.REGISTER_RETRY + 1
        self.n.check_relay()
        self.assertEqual(len(asked), 4)
        now[0] += mobile_push.REGISTER_RETRY + 1
        self.n.check_relay()  # known now: never again for this relay
        self.assertEqual(len(asked), 4)
        self.assertEqual(self.svc.store.get(p["id"])["relay_known"], "https://r")

    def test_remote_respects_the_kinds_and_away_only(self):
        paired(self.svc.store, {"remote": True, "finished": False, "away_only": True}, relay="https://r")
        self.n.emit(ev("k1", session="s1"))           # finished is off
        self.idle = 10
        self.n.emit(ev("k2", "stopped", session="s2"))  # someone is at the Mac
        time.sleep(0.1)
        self.assertEqual(self.sent, [])
        self.idle = mobile_push.AWAY_SECONDS + 1
        self.n.emit(ev("k3", "stopped", session="s3"))
        self.wait_pushes(1)
        self.assertEqual([x[2] for x in self.sent], ["n-k3"])

    def test_no_relay_or_not_registered_means_no_remote(self):
        p = paired(self.svc.store, {"remote": True})
        self.n.emit(ev("z1", session="s1"))            # this Mac has no relay
        time.sleep(0.1)
        self.assertEqual(self.sent, [])
        mobile_push.update_prefs(self.svc.store, p["id"], {"remote": False})
        s = self.svc.store.load()
        s["settings"]["relay_url"] = "https://r"
        self.svc.store.save(s)
        self.n.emit(ev("z2", session="s2"))            # the phone has not registered with it
        time.sleep(0.1)
        self.assertEqual(self.sent, [])

    def test_a_phone_that_is_gone_stops_getting_remote(self):
        p = paired(self.svc.store, {"remote": True}, relay="https://r")
        self.n.sender = lambda relay, pair, n: {"status": 410, "code": "gone"}
        self.n.emit(ev("g", session="s"))
        deadline = time.time() + 2
        while self.svc.store.get(p["id"])["notify"].get("remote") and time.time() < deadline:
            time.sleep(0.02)
        self.assertFalse(self.svc.store.get(p["id"])["notify"]["remote"])

    def test_stream_asks_per_phone(self):
        p = paired(self.svc.store, {"finished": False, "away_only": True})
        self.idle = 0
        self.assertFalse(self.n.stream_wants(p["id"], {"kind": "finished"}))
        self.assertFalse(self.n.stream_wants(p["id"], {"kind": "stopped"}))   # someone is at the Mac
        self.assertTrue(self.n.stream_wants(p["id"], {"kind": "stopped", "test": True}))
        self.idle = mobile_push.AWAY_SECONDS
        self.assertTrue(self.n.stream_wants(p["id"], {"kind": "stopped"}))
        self.assertFalse(self.n.stream_wants("p-gone", {"kind": "stopped"}))

    def test_the_stream_leaves_it_to_apple_when_the_phone_is_away(self):
        # a suspended app keeps its connection; what the Mac wrote into it would show again when it wakes
        p = paired(self.svc.store, {"remote": True}, relay="https://r")
        self.assertFalse(self.n.stream_wants(p["id"], {"kind": "finished"}))
        self.assertFalse(self.n.stream_wants(p["id"], {"kind": "finished", "test": True}))
        mobile_push.update_prefs(self.svc.store, p["id"], {"foreground": True})
        self.assertTrue(self.n.stream_wants(p["id"], {"kind": "finished"}))
        mobile_push.update_prefs(self.svc.store, p["id"], {"foreground": False, "remote": False})
        self.assertTrue(self.n.stream_wants(p["id"], {"kind": "finished"}))  # not registered with Apple: the stream is all it has


class Command(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = mobile.Store(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def run_cmd(self, *argv, up=False):
        a = argparse.Namespace(op="notify", arg=argv[0] if argv else "", value=None, kind=None, json="--json" in argv)
        if "--kind" in argv:
            a.kind = argv[argv.index("--kind") + 1]
        buf = io.StringIO()
        with redirect_stdout(buf), mock.patch.object(mobile, "service_up", return_value=up):
            code = mobile.notify_command(a, self.tmp.name, self.store)
        return code, buf.getvalue()

    def test_lists_each_phone(self):
        self.assertIn("No phone paired", self.run_cmd()[1])
        paired(self.store, {"stopped": False, "remote": True}, relay="https://r")
        code, out = self.run_cmd()
        self.assertEqual(code, 0)
        self.assertIn("iPhone: Finished, Waiting for you; also with the app closed", out)
        rows = json.loads(self.run_cmd("", "--json")[1])
        self.assertEqual(rows[0]["kinds"], {"finished": True, "stopped": False, "needs_you": True})

    def test_test_asks_the_running_service(self):
        code, out = self.run_cmd("test", "--kind", "stopped")
        self.assertEqual(code, 1)
        self.assertIn("no test was sent", out)
        self.assertFalse(os.path.exists(mobile_push.test_path(self.tmp.name)))
        code, out = self.run_cmd("test", "--kind", "stopped", up=True)
        self.assertEqual(code, 0)
        self.assertIn("Sent a test (Stopped)", out)
        with open(mobile_push.test_path(self.tmp.name), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["kind"], "stopped")
        self.assertEqual(mobile_push.read_bell(self.tmp.name), [])

class Listeners(unittest.TestCase):
    """The real service: POST /v1/notify, /v1/notify/test, and a stream that only carries what this phone asked for."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        st = mobile.Store(cls.tmp.name)
        s = st.load()
        s["port"] = 0  # the service takes a free pair itself: a port looked up first could be gone by then
        st.save(s)
        cls.svc = mobile.Service(cls.tmp.name, host="127.0.0.1", bonjour=False)
        cls.svc.hub.start = lambda: None
        cls.svc.notifier.idle = lambda: 0.0
        cls.svc.start()
        cls.pair, _ = st.new_pair()
        cls.key = mobile.hkdf(mobile.unb64url(cls.pair["secret"]), mobile.KEY_LAN)
        cls.port = cls.svc.port

    @classmethod
    def tearDownClass(cls):
        cls.svc.stop()
        cls.tmp.cleanup()

    def signed(self, method, path, body=b""):
        ts = int(time.time())
        nonce = os.urandom(6).hex()
        return {"X-Dispatch-Pair": self.pair["id"], "X-Dispatch-Device": "dev-1", "X-Dispatch-Time": str(ts), "X-Dispatch-Nonce": nonce,
                "X-Dispatch-Sig": mobile.sign(self.key, method, path, ts, body, nonce), "Content-Type": "application/json"}

    def call(self, method, path, obj=None):
        body = json.dumps(obj).encode() if obj is not None else b""
        c = http.client.HTTPConnection("127.0.0.1", self.port + 1, timeout=10)
        c.request(method, path, body=body or None, headers=self.signed(method, path, body))
        r = c.getresponse()
        out = json.loads(r.read())
        c.close()
        return r.status, out

    def test_prefs_and_stream(self):
        status, got = self.call("POST", "/v1/notify", {"finished": False, "foreground": True})
        self.assertEqual(status, 200)
        self.assertEqual(got["kinds"], {"finished": False, "stopped": True, "needs_you": True})
        self.assertTrue(got["foreground"])
        self.assertFalse(got["relay"])
        self.assertEqual(self.call("GET", "/v1/notify")[1]["kinds"]["finished"], False)

        c = http.client.HTTPConnection("127.0.0.1", self.port + 1, timeout=10)
        c.request("GET", "/v1/events", headers=self.signed("GET", "/v1/events"))
        r = c.getresponse()
        r.fp.readline()
        r.fp.readline()
        time.sleep(0.2)
        self.svc.notifier.emit(ev("s1", session="x1"))              # finished: this phone turned it off
        self.svc.notifier.emit(ev("s2", "stopped", session="x2"))
        self.assertEqual(self.call("POST", "/v1/notify/test", {"kind": "needs_you"})[1], {"ok": True, "kind": "needs_you", "delay": 0.0})
        got = b""
        deadline = time.time() + 5
        while b"Test from your Mac" not in got and time.time() < deadline:
            got += r.fp.readline()
        self.assertTrue(self.svc.api.streaming(self.pair["id"]))
        c.close()
        text = got.decode()
        self.assertNotIn("n-s1", text)
        self.assertIn("n-s2", text)
        self.assertIn("Waiting for you: Test from your Mac", text)


if __name__ == "__main__":
    unittest.main()
