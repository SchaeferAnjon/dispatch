# -*- coding: utf-8 -*-
"""The phone's service (mobile.py, mobile_api.py): keys and signatures, pairing, authentication,
the in-process CLI runner, the shaping for the phone, and the two listeners end to end."""
import hashlib
import http.client
import io
import json
import os
import ssl
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import mobile  # noqa: E402
import mobile_api  # noqa: E402


class Keys(unittest.TestCase):
    def test_hkdf_rfc5869_case_1(self):
        ikm = bytes([0x0B] * 22)
        salt = bytes(range(0x00, 0x0D))
        info = bytes(range(0xF0, 0xFA))
        okm = mobile.hkdf(ikm, info, 42, salt=salt)
        self.assertEqual(okm.hex(), "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865")

    def test_purpose_keys_differ(self):
        s = b"\x01" * 32
        keys = {mobile.hkdf(s, k) for k in (mobile.KEY_LAN, mobile.KEY_RELAY, mobile.KEY_BOX)}
        self.assertEqual(len(keys), 3)

    def test_sign_and_verify(self):
        k = mobile.hkdf(b"\x02" * 32, mobile.KEY_LAN)
        sig = mobile.sign(k, "post", "/v1/session/send?x=1", 1000, b'{"a":1}')
        self.assertTrue(mobile.verify(k, "POST", "/v1/session/send?x=1", 1000, b'{"a":1}', sig))
        self.assertFalse(mobile.verify(k, "POST", "/v1/session/send?x=2", 1000, b'{"a":1}', sig))
        self.assertFalse(mobile.verify(k, "POST", "/v1/session/send?x=1", 1001, b'{"a":1}', sig))
        self.assertFalse(mobile.verify(k, "POST", "/v1/session/send?x=1", 1000, b'{"a":2}', sig))

    def test_canonical_form_is_documented(self):
        # docs/mobile-protocol.md: METHOD \n path?query \n unix seconds \n nonce \n sha256 hex of the body
        c = mobile.canonical("get", "/v1/hello", 12, b"", "n1")
        self.assertEqual(c, b"GET\n/v1/hello\n12\nn1\n" + hashlib.sha256(b"").hexdigest().encode())

    def test_nonce_changes_the_signature(self):
        k = b"\x03" * 32
        self.assertNotEqual(mobile.sign(k, "GET", "/v1/sessions", 5, b"", "a"), mobile.sign(k, "GET", "/v1/sessions", 5, b"", "b"))

    def test_b64url_round_trip(self):
        for n in (0, 1, 2, 3, 31, 32, 33):
            b = os.urandom(n)
            self.assertEqual(mobile.unb64url(mobile.b64url(b)), b)
            self.assertNotIn("=", mobile.b64url(b))


class Pairing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = mobile.Store(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_new_pair_is_pending_with_code_and_secret(self):
        p, s = self.store.new_pair(now=1000)
        self.assertEqual(p["status"], "pending")
        self.assertEqual(len(p["code"]), 6)
        self.assertEqual(len(mobile.unb64url(p["secret"])), 32)
        self.assertEqual(p["expires"], 1000 + mobile.PAIR_TTL)
        self.assertTrue(s["mac"].startswith("mac-"))
        mode = os.stat(self.store.path).st_mode & 0o777
        self.assertEqual(mode, 0o600)

    def test_expired_pending_pairs_go_away(self):
        self.store.new_pair(now=1000)
        p2, s = self.store.new_pair(now=1000 + mobile.PAIR_TTL + 1)
        self.assertEqual(list(s["pairs"]), [p2["id"]])

    def test_bind_makes_it_paired_and_drops_the_code(self):
        p, _ = self.store.new_pair(now=1000)
        b = self.store.bind(p["id"], "dev-1", "Karl's iPhone", now=1001)
        self.assertEqual(b["status"], "paired")
        self.assertEqual(b["device"], "dev-1")
        self.assertNotIn("code", b)
        self.assertNotIn("expires", b)

    def test_code_is_one_use_and_limited(self):
        p, _ = self.store.new_pair()
        hit, _ = self.store.by_code("000000" if p["code"] != "000000" else "111111")
        self.assertIsNone(hit)
        hit, _ = self.store.by_code(p["code"][:3] + " " + p["code"][3:])
        self.assertEqual(hit["id"], p["id"])
        again, _ = self.store.by_code(p["code"])
        self.assertIsNone(again)

    def test_code_stops_after_wrong_tries(self):
        p, _ = self.store.new_pair()
        wrong = "999999" if p["code"] != "999999" else "888888"
        for _ in range(mobile.CODE_TRIES):
            self.store.by_code(wrong)
        hit, _ = self.store.by_code(p["code"])
        self.assertIsNone(hit)

    def test_replace_drops_only_a_pending_pair(self):
        old, _ = self.store.new_pair(now=1000)
        new, s = self.store.new_pair(now=1001, replace=old["id"])
        self.assertEqual(list(s["pairs"]), [new["id"]])
        self.store.bind(new["id"], "dev-2", "Phone", now=1002)
        again, s = self.store.new_pair(now=1003, replace=new["id"])
        self.assertEqual(set(s["pairs"]), {new["id"], again["id"]})
        self.assertEqual(s["pairs"][new["id"]]["status"], "paired")

    def test_revoke_by_pair_or_device(self):
        p, _ = self.store.new_pair()
        self.store.bind(p["id"], "dev-9", "x")
        self.assertEqual(self.store.revoke("dev-9"), [p["id"]])
        self.assertIsNone(self.store.get(p["id"]))

    def test_payload_round_trip_and_contents(self):
        p, s = self.store.new_pair()
        s["settings"]["relay_url"] = "https://relay.example"
        with mock.patch.object(mobile, "mac_name", return_value="MacBook"), mock.patch.object(mobile, "mac_model", return_value="MacBook"):
            payload = mobile.pairing_payload(s, p, "ab" * 32, lan=["192.168.1.5"], direct=["100.1.2.3"])
        url = mobile.pairing_url(payload)
        self.assertTrue(url.startswith("dispatch://pair?d="))
        back = mobile.parse_pairing_url(url)
        self.assertEqual(back, payload)
        for k in ("v", "mac", "name", "pair", "secret", "port", "lan", "fp", "relay"):
            self.assertIn(k, back)
        self.assertEqual(back["direct"], ["100.1.2.3"])
        self.assertNotIn("cloud", back)  # only when configured


class PopoverOps(unittest.TestCase):
    """What the title bar's phone popover asks of the CLI (`pair --inline --json`, `status --json`, `revoke`)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {"DISPATCH_DIR": self.tmp.name})
        self.env.start()
        no_vpn = mock.patch.object(mobile, "lan_capture", return_value="")  # this Mac's own VPN must not decide
        no_vpn.start()
        self.addCleanup(no_vpn.stop)

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def run_cli(self, *argv):
        import argparse
        import contextlib
        p = argparse.ArgumentParser()
        mobile.add_parser(p.add_subparsers())
        a = p.parse_args(["mobile", *argv])
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(mobile, "ensure_service", return_value="running"):
            code = mobile.command(a)
        return code, out.getvalue()

    def test_pair_inline_returns_a_scannable_svg_and_the_time_left(self):
        code, out = self.run_cli("pair", "--json", "--inline")
        r = json.loads(out)
        self.assertEqual(code, 0)
        self.assertTrue(r["svg_text"].startswith("<svg"))
        self.assertEqual(len(r["code"]), 6)
        self.assertTrue(0 < r["expires_in"] <= mobile.PAIR_TTL)
        import qr
        self.assertIn(qr.render_svg(qr.matrix(r["url"].encode("utf-8"))), r["svg_text"])
        self.assertEqual(mobile.parse_pairing_url(r["url"])["pair"], r["pair"])

    def test_pair_without_inline_has_no_svg(self):
        _, out = self.run_cli("pair", "--json")
        self.assertNotIn("svg_text", json.loads(out))

    def test_new_code_replaces_the_pending_pair(self):
        first = json.loads(self.run_cli("pair", "--json")[1])
        second = json.loads(self.run_cli("pair", "--json", "--replace", first["pair"])[1])
        ids = [d["id"] for d in json.loads(self.run_cli("devices", "--json")[1])]
        self.assertEqual(ids, [second["pair"]])

    def test_status_says_whether_chatd_is_up_and_lists_the_pairs(self):
        p, _ = mobile.Store(self.tmp.name).new_pair()
        mobile.Store(self.tmp.name).bind(p["id"], "dev-1", "Karl's iPhone")
        with mock.patch.object(mobile, "chatd_running", return_value=False), mock.patch.object(mobile, "service_up", return_value=False):
            r = json.loads(self.run_cli("status", "--json")[1])
        self.assertFalse(r["chatd"])
        self.assertFalse(r["running"])
        self.assertEqual([(d["status"], d["device_name"]) for d in r["devices"]], [("paired", "Karl's iPhone")])
        self.assertNotIn("secret", json.dumps(r))
        self.assertNotIn("code", r["devices"][0])


class Authenticate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        with mock.patch.object(mobile_api, "EventHub"):
            self.svc = mobile.Service(self.tmp.name, bonjour=False)
        self.pair, _ = self.svc.store.new_pair(now=time.time())
        self.key = mobile.hkdf(mobile.unb64url(self.pair["secret"]), mobile.KEY_LAN)

    def tearDown(self):
        self.tmp.cleanup()

    def headers(self, method, path, body=b"", ts=None, device="dev-1", key=None, pair=None):
        ts = int(ts if ts is not None else time.time())
        nonce = os.urandom(6).hex()
        return {"X-Dispatch-Pair": pair or self.pair["id"], "X-Dispatch-Device": device, "X-Dispatch-Device-Name": "Karl%27s%20iPhone",
                "X-Dispatch-Time": str(ts), "X-Dispatch-Nonce": nonce, "X-Dispatch-Sig": mobile.sign(key or self.key, method, path, ts, body, nonce)}

    def test_good_request_binds_the_phone(self):
        p, err = self.svc.authenticate("GET", "/v1/hello", self.headers("GET", "/v1/hello"), b"")
        self.assertIsNone(err)
        self.assertEqual(p["status"], "paired")
        self.assertEqual(p["device_name"], "Karl's iPhone")

    def test_unknown_pair(self):
        _, err = self.svc.authenticate("GET", "/v1/hello", self.headers("GET", "/v1/hello", pair="p-nope"), b"")
        self.assertEqual(err[:2], (401, "unknown_pair"))

    def test_wrong_key(self):
        _, err = self.svc.authenticate("GET", "/v1/hello", self.headers("GET", "/v1/hello", key=b"\x00" * 32), b"")
        self.assertEqual(err[:2], (401, "bad_signature"))

    def test_clock_skew(self):
        _, err = self.svc.authenticate("GET", "/v1/hello", self.headers("GET", "/v1/hello", ts=time.time() - 3600), b"")
        self.assertEqual(err[:2], (401, "clock_skew"))

    def test_same_request_twice_in_a_second_is_fine(self):
        a, b = self.headers("GET", "/v1/sessions"), self.headers("GET", "/v1/sessions")
        self.assertIsNone(self.svc.authenticate("GET", "/v1/sessions", a, b"")[1])
        self.assertIsNone(self.svc.authenticate("GET", "/v1/sessions", b, b"")[1])

    def test_replay(self):
        h = self.headers("GET", "/v1/hello")
        self.assertIsNone(self.svc.authenticate("GET", "/v1/hello", h, b"")[1])
        self.assertEqual(self.svc.authenticate("GET", "/v1/hello", h, b"")[1][:2], (401, "replayed"))

    def test_body_is_signed(self):
        h = self.headers("POST", "/v1/session/send", b'{"text":"hi"}')
        self.assertEqual(self.svc.authenticate("POST", "/v1/session/send", h, b'{"text":"rm -rf"}')[1][:2], (401, "bad_signature"))

    def test_other_device_is_refused_after_binding(self):
        self.svc.authenticate("GET", "/v1/hello", self.headers("GET", "/v1/hello"), b"")
        _, err = self.svc.authenticate("GET", "/v1/a", self.headers("GET", "/v1/a", device="dev-2"), b"")
        self.assertEqual(err[:2], (403, "other_device"))

    def test_expired_pending_pair(self):
        s = self.svc.store.load()
        s["pairs"][self.pair["id"]]["expires"] = time.time() - 1
        self.svc.store.save(s)
        _, err = self.svc.authenticate("GET", "/v1/hello", self.headers("GET", "/v1/hello"), b"")
        self.assertEqual(err[:2], (401, "pair_expired"))


class CliInProcess(unittest.TestCase):
    def test_capture_is_per_thread(self):
        mobile.Cli.install()
        other = io.StringIO()
        real = sys.stdout.real
        sys.stdout.real = other
        try:
            done = threading.Event()

            def chatter():
                print("event line")
                done.set()

            with mock.patch.object(mobile.Cli, "module") as m:
                def fake_main():
                    threading.Thread(target=chatter).start()
                    done.wait(2)
                    print('{"ok": true}')
                m.return_value = mock.Mock(_main=fake_main)
                code, out, _ = mobile.Cli.run(["x"])
            self.assertEqual(code, 0)
            self.assertEqual(out.strip(), '{"ok": true}')
            self.assertIn("event line", other.getvalue())
        finally:
            sys.stdout.real = real

    def test_exit_codes_and_json(self):
        with mock.patch.object(mobile.Cli, "module") as m:
            def fail():
                print("[1, 2]")
                raise SystemExit(3)
            m.return_value = mock.Mock(_main=fail)
            code, out, _ = mobile.Cli.run(["y"])
            self.assertEqual(code, 3)
            self.assertEqual(mobile.Cli.json(["y"]), [1, 2])

    def test_a_crash_is_an_error_not_an_exception(self):
        with mock.patch.object(mobile.Cli, "module") as m:
            m.return_value = mock.Mock(_main=mock.Mock(side_effect=KeyError("boom")))
            code, _, err = mobile.Cli.run(["z"])
            self.assertEqual(code, 1)
            self.assertIn("boom", err)
            self.assertEqual(mobile.Cli.json(["z"], default={"d": 1}), {"d": 1})


class Shaping(unittest.TestCase):
    def test_session_state(self):
        self.assertEqual(mobile_api.session_state(None, "approve"), "wait")
        self.assertEqual(mobile_api.session_state({"state": "working"}), "run")
        self.assertEqual(mobile_api.session_state(None, None, "waiting_input"), "wait")
        self.assertEqual(mobile_api.session_state(None, None, "running"), "run")
        self.assertEqual(mobile_api.session_state(None), "idle")
        # chatd's lifecycle beats a process heuristic
        self.assertEqual(mobile_api.session_state({"state": "working"}, None, "idle"), "idle")

    def test_keep_row(self):
        now = 10_000_000
        base = {"agent": "claude-code", "session_id": "a", "cwd": "/p", "last_at": now - 60, "entrypoint": "cli"}
        self.assertTrue(mobile_api.keep_row(base, {}, "/home/.dispatch/assistant", now))
        self.assertFalse(mobile_api.keep_row({**base, "agent": "pi"}, {}, "", now))
        self.assertFalse(mobile_api.keep_row({**base, "entrypoint": "sdk-cli"}, {}, "", now))
        self.assertTrue(mobile_api.keep_row({**base, "entrypoint": "sdk-cli"}, {"claude-code:a": 1}, "", now))
        self.assertFalse(mobile_api.keep_row({**base, "cwd": "/home/.dispatch/assistant"}, {}, "/home/.dispatch/assistant", now))
        self.assertFalse(mobile_api.keep_row({**base, "last_at": now - 30 * 86400}, {}, "", now))

    def test_phone_session(self):
        s = mobile_api.phone_session({"agent": "opencode", "session_id": "ses_1", "title": "Fix it", "project": "kanban", "cwd": "/k", "last_at": 5},
                                     None, "unread", {"lifecycle": "idle", "model": "glm-5.3-flash", "permission_mode": "acceptEdits"})
        self.assertEqual(s["id"], "opencode:ses_1")
        self.assertTrue(s["unread"])
        self.assertEqual(s["mode"], "Ask for risky actions")  # the name Settings gives it (task-o2r5g)
        full = mobile_api.phone_session({"agent": "claude-code", "session_id": "f", "cwd": "/k"}, None, "", {"permission_mode": "bypassPermissions"})
        self.assertEqual(full["mode"], "Full auto")
        self.assertEqual(s["model"], "glm-5.3-flash")
        chat = mobile_api.phone_session({"agent": "claude-code", "session_id": "c", "cwd": "/h/.dispatch/chats/x", "project": "x"}, chats_dir="/h/.dispatch/chats")
        self.assertEqual(chat["project"], "")

    def test_phone_items_folds_a_turns_tools(self):
        detail = {"messages": [
            {"ts": "2026-09-30T10:00:00Z", "role": "user", "text": "fix the tests"},
            {"ts": "2026-09-30T10:00:05Z", "role": "assistant", "blocks": [
                {"type": "thinking", "text": "hmm"},
                {"type": "tool_call", "id": "t1", "name": "Read", "summary": "app/cli/engines.py", "status": "done", "ts": "2026-09-30T10:00:05Z",
                 "result_ts": "2026-09-30T10:00:06Z"},
                {"type": "tool_call", "id": "t2", "name": "Edit", "summary": "app/cli/engines.py", "status": "done", "ts": "2026-09-30T10:01:00Z",
                 "result_ts": "2026-09-30T10:03:45Z", "input": {"old_string": "a\nb", "new_string": "a\nc\nd"}},
                {"type": "text", "text": "Done: two lines."}]},
            {"ts": "2026-09-30T10:05:00Z", "role": "user", "text": "now run them"},
            {"ts": "2026-09-30T10:05:01Z", "role": "assistant", "blocks": [
                {"type": "tool_call", "id": "t3", "name": "Bash", "summary": "npm run test:py", "status": "running", "ts": "2026-09-30T10:05:01Z"}]},
        ]}
        items = mobile_api.phone_items(detail, running=True)
        kinds = [i["kind"] for i in items]
        self.assertEqual(kinds, ["user", "steps", "assistant", "user", "working"])
        steps = items[1]
        self.assertEqual(steps["count"], 2)
        self.assertEqual(steps["summary"], "Worked for 3m 40s")
        self.assertEqual([s["verb"] for s in steps["items"]], ["Read", "Edited"])
        self.assertEqual((steps["items"][1]["added"], steps["items"][1]["deleted"]), (2, 1))
        self.assertEqual(items[-1]["verb"], "Ran")
        idle = mobile_api.phone_items(detail, running=False)
        self.assertNotIn("working", [i["kind"] for i in idle])

    def test_phone_items_thinking_while_nothing_runs_yet(self):
        items = mobile_api.phone_items({"messages": [{"ts": 1, "role": "user", "text": "hi"}]}, running=True)
        self.assertEqual([i["kind"] for i in items], ["user", "thinking"])

    def test_phone_changes(self):
        d = {"files": [{"path": "/k/notes.md", "changes": [{"kind": "edit", "old": "a\nb\nc", "new": "a\nB\nc\nd"}]}]}
        ch = mobile_api.phone_changes(d)
        f = ch["rounds"][0]["files"][0]
        self.assertEqual((f["added"], f["deleted"]), (2, 1))
        kinds = [l["k"] for l in f["hunks"][0]["lines"]]
        self.assertIn("add", kinds)
        self.assertIn("del", kinds)
        self.assertEqual(mobile_api.phone_changes({"files": []})["rounds"], [])

    def test_phone_waiting(self):
        data = {"items": [
            {"id": "chat:claude-code:x", "kind": "approve", "session": "claude-code:x", "title": "换供应商收尾", "project": "kanban",
             "phrase": "Run rm -rf app/src-tauri/target", "arg": "rm -rf app/src-tauri/target", "actions": ["allow", "deny", "open"], "stopped_at": 5},
            {"id": "task:task-1", "kind": "decide", "task": "task-1", "title": "带不带图", "project": "kanban", "question": "原标题\n\n要不要带图",
             "options": [{"key": "A", "title": "Text only"}, {"key": "B", "title": "With picture"}], "open": "/d/index.html", "at": 3},
            {"id": "ide:claude:/y", "kind": "decide", "session": "claude-code:y", "question": "按会话还是按引擎？", "options": [{"id": "1", "label": "按会话"}], "at": 2},
            {"id": "chat:codex:z", "kind": "unread", "session": "codex:z", "phrase": "Finished", "summary": "All green", "at": 1},
            {"id": "task:task-2", "kind": "only_you", "task": "task-2", "title": "Store notary credentials", "phrase": "keeps disappearing", "at": 0},
        ], "counts": {"approve": 1}}
        out = mobile_api.phone_waiting(data)["items"]
        self.assertEqual([o["kind"] for o in out], ["approve", "decide", "question", "unread", "only_you"])
        self.assertEqual(out[0]["command"], "rm -rf app/src-tauri/target")
        self.assertTrue(out[0]["can_act"])
        self.assertEqual([d["key"] for d in out[1]["directions"]], ["A", "B"])
        self.assertEqual(out[1]["proposal"], "要不要带图")
        self.assertEqual(out[2]["options"], ["按会话"])

    def test_phone_tasks(self):
        data = {"tasks": [{"id": "task-1", "title": "手机版", "status": "in_progress", "plan": [{"text": "读规范", "state": "done"}, {"text": "画", "state": "active"}],
                           "deliverables": [{"kind": "commit", "value": "3f1a2c9e"}, {"kind": "doc", "label": "Design", "doc": "d1"}], "handoffs": [],
                           "session": "s1", "agent": "codex", "updated_at": 9},
                          {"id": "task-2", "title": "公证", "status": "waiting", "only_you": True}]}
        out = mobile_api.phone_tasks(data)["tasks"]
        self.assertEqual(out[0]["state"], "active")
        self.assertEqual([p["state"] for p in out[0]["plan"]], ["done", "active"])
        self.assertEqual(out[0]["commit"], "3f1a2c9")
        self.assertEqual(out[0]["session"], "codex:s1")
        self.assertEqual(out[1]["note"], "Only you can do this")

    def test_phone_home(self):
        q = mobile_api.phone_quota([
            {"agent": "claude-code", "plan": "Max", "windows": [{"label": "5h", "kind": "session", "used_percent": 28.04, "resets_at": 5},
                                                              {"label": "Weekly", "kind": "weekly", "used_percent": 8},
                                                              {"label": "Weekly · Fable", "kind": "weekly_model", "used_percent": 90}], "updated_at": 7},
            {"agent": "codex", "plan": "plus", "windows": [{"label": "Weekly", "kind": "weekly", "used_percent": 1}], "note": ""},
            {"agent": "zcode", "windows": []}])
        self.assertEqual([r["agent"] for r in q], ["claude-code", "codex"])
        self.assertEqual(q[0]["five_hour"], {"used_percent": 28.0, "resets_at": 5})
        self.assertEqual(q[0]["weekly"]["used_percent"], 8)
        self.assertIsNone(q[1]["five_hour"])
        now_ = time.mktime((2026, 10, 1, 15, 0, 0, 0, 0, -1))
        task = lambda i, st, done=None, dels=None: {"id": i, "title": i, "status": st, "done_at": done, "deliverables": dels or [], "updated_at": now_}
        h = mobile_api.phone_home_tasks([{"project": "kanban", "tasks": [
            task("a", "in_progress"), task("b", "done", now_ - 3600, [{"kind": "doc", "label": "Report", "doc": "d9"}]),
            task("c", "done", now_ - 2 * 86400), task("d", "waiting")]}], now_)
        self.assertEqual([x["id"] for x in h["active"]], ["a", "d"])
        self.assertEqual([x["id"] for x in h["done_today"]], ["b"])
        self.assertEqual(h["done_today"][0]["deliverables"][0]["doc"], "d9")
        self.assertEqual(h["done_today"][0]["project"], "kanban")
        self.assertEqual(h["done_count"], 1)
        grid = [[0] * 24 for _ in range(7)]
        grid[time.localtime().tm_wday][9] = 4
        grid[time.localtime().tm_wday][10] = 1
        self.assertEqual(mobile_api.active_hours_today({"hours": grid}), 2)

    def test_inline_images(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "a.png"), "wb") as f:
                f.write(b"\x89PNG" + b"x" * 100)
            with open(os.path.join(d, "big.png"), "wb") as f:
                f.write(b"y" * 5000)
            html = '<h1>Hi</h1><img src="a.png"><img class="s" src=\'big.png\'><img src="https://x/y.png"><img src="gone.png">'
            out, skipped = mobile_api.inline_images(html, d, 2000)
            self.assertIn('src="data:image/png;base64,iVBOR', out)
            self.assertIn("too large to send right now", out)  # did not fit in the budget
            self.assertIn('src="https://x/y.png"', out)
            self.assertIn('src="gone.png"', out)
            self.assertEqual(skipped, 1)

    def test_file_preview(self):
        with tempfile.TemporaryDirectory() as d:
            pdf, png = os.path.join(d, "r.pdf"), os.path.join(d, "s.png")
            for p_, b in ((pdf, b"%PDF-1.4 x"), (png, b"\x89PNG xx")):
                with open(p_, "wb") as f:
                    f.write(b)
            r = mobile_api.file_preview(pdf, "Report", "Delivered", 10_000)
            self.assertTrue(r["file"]["data"].startswith("data:application/pdf;base64,"))
            r = mobile_api.file_preview(png, "Shot", "Delivered", 10_000)
            self.assertIn("data:image/png;base64,", r["html"])
            r = mobile_api.file_preview(png, "Shot", "Delivered", 5)
            self.assertIn("too large", r["parts"][0]["t"])

    def test_markdown_pictures(self):
        title, parts = mobile_api.markdown_parts("# Report\n\nBefore and after:\n\n![The new page](shot.png)\n\n![Missing](gone.png)\n\n![A prototype](proto.html#x)\n")
        self.assertEqual([p["k"] for p in parts], ["p", "img", "img", "p"])  # a page is not a picture: stays text
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "shot.png"), "wb") as f:
                f.write(b"\x89PNG" + b"z" * 50)
            skipped = mobile_api.inline_part_images(parts, d, 10_000)
            self.assertEqual(skipped, 1)
            self.assertTrue(parts[1]["src"].startswith("data:image/png;base64,"))
            self.assertEqual(parts[1]["alt"], "The new page")
            self.assertEqual([p["k"] for p in parts], ["p", "img", "p"])

    def test_sessions_of_one_project(self):
        now_ = time.time()
        rows = [{"agent": "claude-code", "session_id": "old", "project": "kanban", "cwd": "/p", "last_at": now_ - 90 * 86400, "title": "Old one"},
                {"agent": "codex", "session_id": "new", "project": "kanban", "cwd": "/p", "last_at": now_ - 60, "title": "New one"},
                {"agent": "codex", "session_id": "else", "project": "other", "cwd": "/q", "last_at": now_ - 60, "title": "Else"}]
        calls = []

        def cli(argv, default=None):
            calls.append(argv)
            if argv[0] == "list":
                return rows
            return default

        api = mobile_api.Api(mock.Mock(d=tempfile.mkdtemp()))
        with mock.patch.object(mobile.Cli, "json", side_effect=cli), mock.patch("chat_protocol.read_started", return_value={}):
            r = api.sessions({"project": "kanban"}, None)
            recent = api.sessions({}, None)
        self.assertIn(["list", "--local", "--cached", "--project", "kanban", "--limit", "200", "--json"], calls)
        self.assertEqual([s["id"] for s in r["sessions"]], ["codex:new", "claude-code:old"])  # history, newest first
        self.assertEqual(r["project"], "kanban")
        self.assertNotIn("claude-code:old", [s["id"] for s in recent["sessions"]])  # the default list stays two weeks

    def test_markdown_parts(self):
        title, parts = mobile_api.markdown_parts("# Title\n\nFirst para\nsame para.\n\n- a\n- b\n\n## Head\n\n1. one\n2. two\n\n```\ncode\n```\n")
        self.assertEqual(title, "Title")
        self.assertEqual([p["k"] for p in parts], ["p", "ul", "h", "ol", "code"])
        self.assertEqual(parts[0]["t"], "First para same para.")

    def test_phone_knowledge(self):
        k = mobile_api.phone_knowledge({"items": [{"name": "方角开关", "polarity": "avoid", "area": "design", "scope_label": "everywhere", "status": "active"}],
                                        "counts": {"active": 1, "areas": {"design": 1}}}, [{"kind": "pit", "text": "IPC 路径太长", "project": "kanban"}])
        self.assertEqual(k["preferences"][0]["icon"], "ban")
        self.assertEqual(k["preferences"][0]["sub"], "Avoid · Design · everywhere")
        self.assertEqual(k["wiki"][0]["sub"], "Pitfall · kanban")


class Listeners(unittest.TestCase):
    """The HTTPS (LAN) and loopback listeners with a signed request, a refused one, the event stream."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        st = mobile.Store(cls.tmp.name)
        s = st.load()
        s["port"] = 0  # the service takes a free pair itself: a port looked up first could be gone by then
        st.save(s)
        cls.svc = mobile.Service(cls.tmp.name, host="127.0.0.1", bonjour=False)
        cls.svc.hub.start = lambda: None
        cls.svc.api.waiting_raw = lambda: {"items": [], "counts": {"approve": 2, "decide": 1, "unread": 0, "only_you": 3}}
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

    def tls(self):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE  # the phone pins the fingerprint instead
        return http.client.HTTPSConnection("127.0.0.1", self.port, context=ctx, timeout=10)

    def test_port_zero_takes_a_free_pair_and_the_pairing_code_shows_it(self):
        """Settings port 0: the service binds a free port and the one after it itself, and keeps the port, so a
        pairing code made now carries the port that listens."""
        self.assertGreater(self.port, 0)
        state = mobile.Store(self.tmp.name).load()
        self.assertEqual(state["port"], self.port)
        self.assertEqual(mobile.pairing_payload(state, self.pair, self.svc.fingerprint, lan=[])["port"], self.port)
        self.assertEqual([s.server_address[1] for s in self.svc.servers], [self.port, self.port + 1])

    def test_https_fingerprint_matches_the_pairing_code(self):
        c = self.tls()
        c.connect()
        der = c.sock.getpeercert(binary_form=True)
        self.assertEqual(hashlib.sha256(der).hexdigest(), self.svc.fingerprint)
        c.close()

    def test_health_is_open_hello_is_signed(self):
        c = self.tls()
        c.request("GET", "/v1/health")
        r = c.getresponse()
        self.assertEqual(r.status, 200)
        r.read()
        c.request("GET", "/v1/hello")
        r = c.getresponse()
        self.assertEqual(r.status, 401)
        self.assertEqual(json.loads(r.read())["code"], "unknown_pair")
        with mock.patch.object(mobile, "mac_name", return_value="MacBook"):
            c.request("GET", "/v1/hello", headers=self.signed("GET", "/v1/hello"))
            r = c.getresponse()
            body = json.loads(r.read())
        self.assertEqual(r.status, 200)
        self.assertEqual(body["waiting"], 3)
        self.assertEqual(body["only_you"], 3)
        self.assertEqual(body["protocol"], 1)
        c.close()

    def test_loopback_is_plain_http_and_signed_too(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port + 1, timeout=10)
        c.request("GET", "/v1/nothing", headers=self.signed("GET", "/v1/nothing"))
        r = c.getresponse()
        self.assertEqual(r.status, 404)
        r.read()
        c.request("GET", "/v1/hello")
        self.assertEqual(c.getresponse().status, 401)
        c.close()

    def test_event_stream(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port + 1, timeout=10)
        c.request("GET", "/v1/events", headers=self.signed("GET", "/v1/events"))
        r = c.getresponse()
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("Content-Type"), "text/event-stream")
        first = r.fp.readline() + r.fp.readline()
        self.assertIn(b"event: hello", first)
        time.sleep(0.2)
        self.svc.hub.publish("chat", {"ev": "text_delta", "session": "claude-code:x", "text": "hi"})
        got = b""
        deadline = time.time() + 5
        while b"text_delta" not in got and time.time() < deadline:
            got += r.fp.readline()
        self.assertIn(b"event: chat", got)
        c.close()

    def test_pair_by_code(self):
        st = mobile.Store(self.tmp.name)
        p, _ = st.new_pair()
        c = self.tls()
        c.request("POST", "/v1/pair/code", body=json.dumps({"code": "12"}), headers={"Content-Type": "application/json"})
        r = c.getresponse()
        self.assertEqual(r.status, 403)
        r.read()
        c.request("POST", "/v1/pair/code", body=json.dumps({"code": p["code"]}), headers={"Content-Type": "application/json"})
        r = c.getresponse()
        body = json.loads(r.read())
        self.assertEqual(r.status, 200)
        self.assertEqual(mobile.parse_pairing_url(body["url"])["pair"], p["id"])
        c.close()


class BonjourRecord(unittest.TestCase):
    """The `dns-sd -R` record goes with the service (task-9ca5: five records left behind, the phone saw the Mac
    five times): its process dies with the service however the service ends, and old records are cleared first."""

    def rows(self):
        dns = "dns-sd -R Dispatch on Mac _dispatch._tcp local %d mac=%s v=1 model=MacBook host=m.local port=%d name=Mac"
        return [
            (101, 1, dns % (17795, "mac-old", 17795)),         # left behind: its service is gone
            (102, 1, dns % (18603, "mac-other", 18603)),       # left behind by another data folder
            (103, 900, dns % (7788, "mac-me", 7788)),          # this Mac's id from a service still running
            (104, 901, dns % (7790, "mac-test", 7790)),        # a test instance's live record: not ours to end
            (105, 1, "dns-sd -B _dispatch._tcp"),              # browsing, not a record
            (106, 1, "dns-sd -R Printer _ipp._tcp local 631"), # some other service
            (107, 902, "/bin/sh -c trap ... dispatch-advert dns-sd -R Dispatch on Mac _dispatch._tcp local 7788 mac=mac-me"),
        ]

    def test_stale_records(self):
        self.assertEqual(mobile.stale_adverts("mac-me", self.rows()), [101, 102, 103])

    def test_clear_kills_only_those(self):
        killed = []
        self.assertEqual(mobile.clear_stale_adverts("mac-me", self.rows(), kill=lambda pid, sig: killed.append(pid)), [101, 102, 103])
        self.assertEqual(killed, [101, 102, 103])

    @staticmethod
    def tag(n):
        """`sleep <tag>` stands in for dns-sd, found again by its command line: a tag of this run only (two suites
        at once on one Mac each counted the other's `sleep 4101` and saw 2)."""
        return "%d.%d" % (4100 + n, os.getpid())

    def _start(self, tag):
        """The record's process the way advertise() starts it, with `sleep <tag>` standing in for dns-sd."""
        import subprocess
        return subprocess.Popen(["/bin/sh", "-c", mobile.ADVERT_SH, "dispatch-advert", "sleep", tag], stdin=subprocess.PIPE)

    def _running(self, tag):
        import subprocess
        out = subprocess.run(["ps", "-axo", "command="], capture_output=True, text=True).stdout.splitlines()
        return sum(1 for line in out if line.strip() == "sleep " + tag)

    def _until(self, cond, timeout=60):
        """Ask until cond() holds (a fixed 0.3 s or 4 s was too short on a busy Mac); False after `timeout`."""
        end = time.time() + timeout
        while not cond():
            if time.time() > end:
                return False
            time.sleep(0.1)
        return True

    def _up(self, tag):
        return self._until(lambda: self._running(tag) >= 1) and self._running(tag) == 1

    def _gone(self, tag):
        return self._until(lambda: not self._running(tag))

    def test_stop_ends_the_record(self):
        tag = self.tag(1)
        p = self._start(tag)
        self.assertTrue(self._up(tag))
        mobile.stop_advert(p)
        self.assertTrue(self._gone(tag))

    def test_a_killed_service_takes_its_record_along(self):
        import signal
        import subprocess
        tag = self.tag(2)
        code = ("import subprocess, sys, time; sys.path.insert(0, %r); import mobile; "
                "subprocess.Popen(['/bin/sh', '-c', mobile.ADVERT_SH, 'dispatch-advert', 'sleep', %r], stdin=subprocess.PIPE); "
                "print('up', flush=True); time.sleep(60)") % (HERE, tag)
        q = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
        self.assertEqual(q.stdout.readline().strip(), "up")
        self.assertTrue(self._up(tag))
        os.kill(q.pid, signal.SIGKILL)  # no stop(), no atexit: only the closed pipe tells the shell
        q.wait(10)
        q.stdout.close()
        self.assertTrue(self._gone(tag))

    def test_service_stop_and_chatd_detach_end_the_record(self):
        svc = mobile.Service.__new__(mobile.Service)
        svc.servers, svc.hub, svc.notifier = [], mock.Mock(), mock.Mock()
        tag = self.tag(3)
        svc.dns_sd = self._start(tag)
        self.assertTrue(self._up(tag))
        with mock.patch.object(mobile, "_running", svc):
            mobile.detach_from_chatd()
            self.assertIsNone(mobile._running)
        self.assertIsNone(svc.dns_sd)
        self.assertTrue(self._gone(tag))


class Access(unittest.TestCase):
    """Phone access is off on a new Mac, turns on when the person pairs, and says why when it cannot run
    (task-lj06.19: the port was taken and the window still said "Phone access is on" and gave a code)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {"DISPATCH_DIR": self.tmp.name})
        self.env.start()
        self.st = mobile.Store(self.tmp.name)
        mobile._running, mobile._last_error = None, None
        no_vpn = mock.patch.object(mobile, "lan_capture", return_value="")
        no_vpn.start()
        self.addCleanup(no_vpn.stop)

    def tearDown(self):
        if mobile._running is not None:
            mobile.detach_from_chatd()
        self.env.stop()
        self.tmp.cleanup()

    def run_cli(self, *argv, **patches):
        import argparse
        import contextlib
        p = argparse.ArgumentParser()
        mobile.add_parser(p.add_subparsers())
        a = p.parse_args(["mobile", *argv])
        out = io.StringIO()
        with contextlib.ExitStack() as stack:
            for name, value in patches.items():
                stack.enter_context(mock.patch.object(mobile, name, value))
            stack.enter_context(contextlib.redirect_stdout(out))
            code = mobile.command(a)
        return code, out.getvalue()

    def taken_port(self):
        import socket
        a = socket.socket()
        a.bind(("0.0.0.0", 0))  # as another Dispatch's service holds it: every interface
        a.listen(1)
        self.addCleanup(a.close)
        return a.getsockname()[1]

    def test_a_new_mac_starts_off_and_a_mac_with_a_paired_phone_keeps_it_on(self):
        self.assertFalse(mobile.access_on(self.st.load()))
        p, _ = self.st.new_pair()
        self.assertFalse(mobile.access_on(self.st.load()), "a code nobody used does not turn it on")
        self.st.bind(p["id"], "dev-1", "iPhone")
        self.assertTrue(mobile.access_on(self.st.load()), "an update keeps it on for a Mac that has a phone")
        mobile.set_access(self.st, False)
        self.assertFalse(mobile.access_on(self.st.load()))

    def test_on_without_a_phone_lasts_as_long_as_a_pairing(self):
        # 10-09: Pair a phone tried once (no app yet) left phone access on for good, with nothing paired
        mobile.set_access(self.st, True)
        since = self.st.load()["settings"]["access_since"]
        self.assertTrue(mobile.access_on(self.st.load(), since + 60), "a pairing that just started")
        self.assertFalse(mobile.access_on(self.st.load(), since + mobile.PAIR_TTL + 1), "nobody paired in ten minutes")
        p, _ = self.st.new_pair(now=since + mobile.PAIR_TTL - 30)
        self.assertTrue(mobile.access_on(self.st.load(), since + mobile.PAIR_TTL + 1), "a new code keeps it on while it lasts")
        self.assertFalse(mobile.access_on(self.st.load(), p["expires"] + 1))
        s = self.st.load()
        s["settings"].pop("access_since")
        self.assertFalse(mobile.access_on(s, p["expires"] + 1), "on from before this change, with no phone: off")
        self.st.bind(p["id"], "dev-1", "iPhone")
        self.assertTrue(mobile.access_on(self.st.load(), p["expires"] + 10_000), "a paired phone keeps it on")

    def test_chatd_starts_nothing_while_it_is_off(self):
        with mock.patch.object(mobile, "Service") as svc:
            self.assertIsNone(mobile.attach_to_chatd(self.tmp.name))
        svc.assert_not_called()
        self.assertEqual(mobile.read_service(self.tmp.name)["state"], "off")

    def test_chatd_starts_it_once_on_and_stops_it_when_turned_off(self):
        mobile.set_access(self.st, True)
        with mock.patch.object(mobile, "Service") as svc:
            svc.return_value.start.return_value = svc.return_value
            svc.return_value.port = 7788
            self.assertIs(mobile.attach_to_chatd(self.tmp.name), svc.return_value)
            self.assertEqual(mobile.read_service(self.tmp.name)["state"], "running")
            mobile.set_access(self.st, False)
            self.assertIsNone(mobile.attach_to_chatd(self.tmp.name))
        svc.return_value.stop.assert_called_once()
        self.assertIsNone(mobile._running)
        self.assertEqual(mobile.read_service(self.tmp.name)["state"], "off")

    def test_a_taken_port_is_written_down_in_words_and_logged_once(self):
        port = self.taken_port()
        mobile.set_access(self.st, True)
        s = self.st.load()
        s["port"] = port
        self.st.save(s)
        err = io.StringIO()
        with mock.patch.object(mobile_api, "EventHub"), mock.patch.object(sys, "__stderr__", err):
            self.assertIsNone(mobile.attach_to_chatd(self.tmp.name))
            self.assertIsNone(mobile.attach_to_chatd(self.tmp.name))
        rec = mobile.read_service(self.tmp.name)
        self.assertEqual((rec["state"], rec["reason"], rec["port"]), ("failed", "port_in_use", port))
        self.assertIn(f"port {port}", rec["message"])
        self.assertIn("another port", rec["fix"])
        self.assertEqual(err.getvalue().count("mobile: not started"), 1)

    def test_pair_gives_no_code_when_the_service_did_not_start_and_says_why(self):
        port = self.taken_port()
        s = self.st.load()
        s["port"] = port
        self.st.save(s)
        mobile.write_service(self.tmp.name, {"state": "failed", "reason": "port_in_use", "port": port,
                                             "message": f"Another program is already using port {port}.", "fix": "Quit it."})
        code, out = self.run_cli("pair", "--json", "--inline", chatd_running=lambda d=None: True, service_up=lambda *a, **k: False)
        r = json.loads(out)
        self.assertFalse(r["ok"])
        self.assertNotIn("code", r)
        self.assertNotIn("svg_text", r)
        self.assertEqual(r["service"], "failed")
        self.assertFalse(r["running"])
        self.assertEqual(r["access"], "on")
        self.assertEqual(r["problem"]["reason"], "port_in_use")
        self.assertEqual([p for p in self.st.load()["pairs"].values()], [], "no pending code is left behind")

    def test_status_is_not_fooled_by_another_dispatch_answering_on_the_port(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        class Other(BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps({"ok": True, "protocol": 1, "mac": "mac-someone-else"}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass
        srv = ThreadingHTTPServer(("127.0.0.1", 0), Other)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        loop = srv.server_address[1]
        self.assertTrue(mobile.service_up(loop - 1))
        self.assertFalse(mobile.service_up(loop - 1, "mac-mine"))
        self.assertTrue(mobile.service_up(loop - 1, "mac-someone-else"))
        mobile.set_access(self.st, True)
        s = self.st.load()
        s["port"] = loop - 1
        self.st.save(s)
        mobile.write_service(self.tmp.name, {"state": "failed", "reason": "port_in_use", "port": loop - 1, "message": "taken", "fix": "quit it"})
        code, out = self.run_cli("status", "--json", chatd_running=lambda d=None: True)
        r = json.loads(out)
        self.assertFalse(r["running"])
        self.assertEqual(r["problem"]["reason"], "port_in_use")
        _, text = self.run_cli("status", chatd_running=lambda d=None: True)
        self.assertTrue(text.startswith("Not running: taken"), text)

    def test_status_of_a_new_mac_says_off(self):
        code, out = self.run_cli("status", "--json", chatd_running=lambda d=None: True, service_up=lambda *a, **k: False)
        r = json.loads(out)
        self.assertEqual((r["access"], r["running"], r["problem"]), ("off", False, None))

    def test_off_turns_it_off_and_keeps_the_phones(self):
        p, _ = self.st.new_pair()
        self.st.bind(p["id"], "dev-1", "iPhone")
        answers = iter([True, True])  # still answering when asked, gone a moment later (chatd stops it)
        code, out = self.run_cli("off", "--json", chatd_running=lambda d=None: True, service_up=lambda *a, **k: next(answers, False))
        r = json.loads(out)
        self.assertEqual((r["access"], r["running"]), ("off", False))
        self.assertEqual(len(r["devices"]), 1)


if __name__ == "__main__":
    unittest.main()


IFCONFIG = """lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.0.125 netmask 0xffffff00 broadcast 192.168.0.255
en7: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 169.254.3.4 netmask 0xffff0000 broadcast 169.254.255.255
utun13: flags=80d1<UP,POINTOPOINT,RUNNING,NOARP,MULTICAST> mtu 1351
\tinet 147.142.8.34 --> 147.142.8.34 netmask 0xffffff00
utun6: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
\tinet 100.64.0.12 --> 100.64.0.12 netmask 0xffffffff
"""


class LocalNetwork(unittest.TestCase):
    """10-10: a phone on the same Wi-Fi could not pair. Cisco Secure Client (Tunnel All Traffic, Allow local (LAN) access
    off) routed 192.168.0/24 into utun13 and dropped the rest, and the pairing code also carried the VPN's address."""

    def run_ifconfig(self, *a, **k):
        return mock.Mock(stdout=IFCONFIG)

    def test_rows_and_lan_addresses_leave_out_loopback_link_local_tailscale_and_vpn_tunnels(self):
        rows = mobile.network_rows(run=self.run_ifconfig)
        self.assertEqual(rows, [("en0", "192.168.0.125", 24), ("utun13", "147.142.8.34", 24)])
        self.assertEqual(mobile.lan_addresses(rows), ["192.168.0.125"])

    def test_a_vpn_that_routes_the_wifi_into_its_tunnel_is_found(self):
        rows = mobile.network_rows(run=self.run_ifconfig)
        asked = []

        def route(ip):
            asked.append(ip)
            return "utun13"
        self.assertEqual(mobile.lan_capture(rows, route=route), "utun13")
        self.assertEqual(asked, ["192.168.0.254"], "a neighbour on the Wi-Fi, not the gateway, not the VPN's own network")
        self.assertEqual(mobile.lan_capture(rows, route=lambda ip: "en0"), "")
        self.assertEqual(mobile.lan_capture([("en0", "10.0.0.254", 24)], route=lambda ip: ip), "", "no answer is no claim")
        self.assertEqual(mobile.lan_capture([("utun13", "147.142.8.34", 24)], route=lambda ip: "utun13"), "", "no Wi-Fi, nothing to say")

    def test_the_neighbour_is_never_this_mac(self):
        asked = []
        mobile.lan_capture([("en0", "192.168.0.254", 24)], route=lambda ip: asked.append(ip) or "en0")
        self.assertEqual(asked, ["192.168.0.253"])

    def test_route_interface_reads_route_get(self):
        out = "   route to: 192.168.0.254\ndestination: 192.168.0.0\n  interface: utun13\n      flags: <UP,DONE,CLONING>\n"
        self.assertEqual(mobile.route_interface("192.168.0.254", run=lambda *a, **k: mock.Mock(stdout=out)), "utun13")

    def test_the_problem_names_cisco_and_its_switch(self):
        with mock.patch.object(mobile, "lan_capture", return_value="utun13"), mock.patch.object(mobile, "vpn_name", return_value="Cisco Secure Client"):
            p = mobile.reach_problem(7788)
        self.assertEqual((p["reason"], p["port"], p["tunnel"]), ("vpn_blocks_lan", 7788, "utun13"))
        self.assertIn("Cisco Secure Client routes this Mac's local network through the VPN", p["message"])
        self.assertIn("Allow local (LAN) access", p["fix"])
        with mock.patch.object(mobile, "lan_capture", return_value="utun3"), mock.patch.object(mobile, "vpn_name", return_value=""):
            p = mobile.reach_problem(7788)
        self.assertTrue(p["message"].startswith("A VPN routes"))
        self.assertIn("or disconnect it", p["fix"])
        with mock.patch.object(mobile, "lan_capture", return_value=""):
            self.assertIsNone(mobile.reach_problem(7788))

    def test_vpn_name_by_its_agent(self):
        ps = "/sbin/launchd\n/opt/cisco/secureclient/bin/vpnagentd\nzsh\n"
        self.assertEqual(mobile.vpn_name(run=lambda *a, **k: mock.Mock(stdout=ps)), "Cisco Secure Client")
        self.assertEqual(mobile.vpn_name(run=lambda *a, **k: mock.Mock(stdout="zsh\n")), "")


class PairBehindAVpn(unittest.TestCase):
    """The service answers, but a VPN takes the local network: no code (it could not connect) and why; status says so."""
    setUp, tearDown, run_cli = Access.setUp, Access.tearDown, Access.run_cli

    def blocked(self):
        return mock.patch.object(mobile, "lan_capture", return_value="utun13")

    def test_pair_gives_no_code_and_says_why(self):
        with self.blocked():
            code, out = self.run_cli("pair", "--json", "--inline", ensure_service=lambda d=None: "started",
                                     service_up=lambda *a, **k: True, tailscale_address=lambda: "", vpn_name=lambda: "Cisco Secure Client")
        r = json.loads(out)
        self.assertFalse(r["ok"])
        self.assertNotIn("code", r)
        self.assertNotIn("svg_text", r)
        self.assertTrue(r["running"])
        self.assertEqual(r["problem"]["reason"], "vpn_blocks_lan")
        self.assertEqual(self.st.load()["pairs"], {}, "no pending code is left behind")
        with self.blocked():
            code, text = self.run_cli("pair", ensure_service=lambda d=None: "running", service_up=lambda *a, **k: True,
                                      tailscale_address=lambda: "", vpn_name=lambda: "")
        self.assertEqual(code, 1)
        self.assertIn("but your phone cannot reach it: A VPN routes", text)

    def test_another_way_in_still_gets_a_code(self):
        s = self.st.load()
        s["settings"]["relay_url"] = "https://relay.example"
        self.st.save(s)
        with self.blocked():
            code, out = self.run_cli("pair", "--json", ensure_service=lambda d=None: "running", service_up=lambda *a, **k: True,
                                     tailscale_address=lambda: "")
        self.assertTrue(json.loads(out)["ok"])

    def test_status_while_running_says_the_phone_cannot_reach_it(self):
        mobile.set_access(self.st, True)
        with self.blocked():
            code, out = self.run_cli("status", "--json", service_up=lambda *a, **k: True, chatd_running=lambda d=None: True)
        r = json.loads(out)
        self.assertTrue(r["running"])
        self.assertEqual(r["problem"]["reason"], "vpn_blocks_lan")
        code, out = self.run_cli("status", "--json", service_up=lambda *a, **k: True, chatd_running=lambda d=None: True)
        self.assertIsNone(json.loads(out)["problem"])
