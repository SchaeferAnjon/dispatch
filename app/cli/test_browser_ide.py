# -*- coding: utf-8 -*-
"""`dispatch browser --ide`: the request the bridge gets, the answer the terminal prints, and the
fall back to the standalone browser when Dispatch IDE is not there."""
import base64
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import browser as B  # noqa: E402
import browser_ide as BI  # noqa: E402
import ide_show  # noqa: E402


class FakeBridge(threading.Thread):
    """Takes request files like dispatch-bridge does and answers with `reply(args)`."""

    def __init__(self, reply):
        threading.Thread.__init__(self, daemon=True)
        self.reply = reply
        self.seen = []
        self.stop = False

    def run(self):
        d = ide_show.requests_dir()
        while not self.stop:
            for n in sorted(os.listdir(d)) if os.path.isdir(d) else []:
                if not n.endswith(".json"):
                    continue
                p = os.path.join(d, n)
                try:
                    with open(p, encoding="utf-8") as f:
                        req = json.load(f)
                    os.remove(p)
                except (OSError, ValueError):
                    continue
                self.seen.append(req)
                with open(os.path.join(d, req["id"] + ".done"), "w", encoding="utf-8") as f:
                    json.dump({"ok": True, "result": self.reply(req["args"])}, f)
            time.sleep(0.02)


class BrowserIdeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bide-")
        self.env = mock.patch.dict(os.environ, {"DISPATCH_DIR": self.tmp}, clear=False)
        self.env.start()
        for k in [k for k in os.environ if k.startswith("CODEX_") or k in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")]:
            self.addCleanup(os.environ.__setitem__, k, os.environ[k])
            del os.environ[k]

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def heartbeat(self, features=("show", "browser")):
        os.makedirs(ide_show.ide_dir(), exist_ok=True)
        with open(ide_show.alive_path(), "w", encoding="utf-8") as f:
            json.dump({"pid": os.getpid(), "at": time.time(), "features": list(features)}, f)

    def run_cli(self, argv, bridge=None):
        out, err = io.StringIO(), io.StringIO()
        if bridge:
            bridge.start()
        try:
            with redirect_stdout(out), redirect_stderr(err):
                rc = B.main(argv)
        finally:
            if bridge:
                bridge.stop = True
        return rc, out.getvalue(), err.getvalue()

    def test_targets_are_text_or_refs(self):
        self.assertEqual(BI.target_args("e12"), {"ref": "e12", "element": "e12"})
        self.assertEqual(BI.target_args("Sign in"), {"selector": 'internal:text="Sign in"i >> nth=0', "element": "Sign in"})
        self.assertEqual(BI.target_args("x", css="#email"), {"selector": "#email", "element": "x"})
        self.assertEqual(BI.target_args(""), {})

    def test_engine_from_the_terminal(self):
        self.assertEqual(BI.engine_name(), "agent")
        with mock.patch.dict(os.environ, {"CLAUDECODE": "1"}):
            self.assertEqual(BI.engine_name(), "claude")
        with mock.patch.dict(os.environ, {"CODEX_SANDBOX": "seatbelt"}):
            self.assertEqual(BI.engine_name(), "codex")
        self.assertEqual(BI.engine_name("codex"), "codex")

    def test_open_goes_to_the_ide(self):
        self.heartbeat()
        bridge = FakeBridge(lambda args: {"ok": True, "page": "p1", "title": "Example Domain", "url": "https://example.com/", "text": "- heading \"Example Domain\" [ref=e3]"})
        with mock.patch.dict(os.environ, {"CLAUDECODE": "1"}):
            rc, out, err = self.run_cli(["--ide", "open", "https://example.com", "--json"], bridge)
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertEqual((res["where"], res["title"], res["page"]), ("ide", "Example Domain", "p1"))
        self.assertEqual(bridge.seen[0]["kind"], "browser")
        self.assertEqual(bridge.seen[0]["args"], {"action": "open", "engine": "claude", "url": "https://example.com"})

    def test_a_slow_page_is_open_and_still_loading(self):
        # Higgsfield keeps loading video: the IDE says it is open but loading, and the next commands use it
        self.heartbeat()
        bridge = FakeBridge(lambda args: {"ok": True, "loading": True, "page": "p2", "title": "Higgsfield", "url": "https://higgsfield.ai/"})
        rc, out, err = self.run_cli(["--ide", "open", "https://higgsfield.ai"], bridge)
        self.assertEqual(rc, 0, err)
        self.assertIn("还在加载", out)

    def test_an_open_that_timed_out_is_open_and_still_loading(self):
        self.heartbeat()
        bridge = FakeBridge(lambda args: {"ok": False, "error": "Navigation to https://higgsfield.ai timed out after 30000 ms. The page (ID: a87f4146-316e) is open and can be reused."})
        rc, out, err = self.run_cli(["--ide", "open", "https://higgsfield.ai", "--json"], bridge)
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertEqual((res["loading"], res["page"]), (True, "a87f4146-316e"))

    def test_size_lays_the_page_out_like_a_desktop_window(self):
        # an older bridge would drop the request: say so instead of waiting
        self.heartbeat()
        rc, _, err = self.run_cli(["--ide", "size", "1440x900"])
        self.assertEqual(rc, 1)
        self.assertIn("更新 Dispatch IDE", err)
        self.heartbeat(features=("show", "browser", "browser-size"))
        bridge = FakeBridge(lambda args: {"ok": True, "page": "p1", "title": "T", "url": "u", "text": "ok"})
        rc, out, _ = self.run_cli(["--ide", "size", "1440x900", "--as", "claude"], bridge)
        self.assertEqual(rc, 0)
        self.assertEqual(bridge.seen[0]["args"], {"action": "size", "engine": "claude", "width": 1440, "height": 900})
        self.assertIn("好了", out)
        again = FakeBridge(lambda args: {"ok": True, "page": "p1", "title": "T", "url": "u", "text": "back"})
        rc, _, _ = self.run_cli(["--ide", "size", "off"], again)
        self.assertEqual(rc, 0)
        self.assertEqual(again.seen[0]["args"], {"action": "size", "engine": "agent"})
        rc, _, err = self.run_cli(["--ide", "size", "wide"])
        self.assertEqual(rc, 2)
        self.assertIn("宽x高", err)

    def test_click_type_press_carry_their_target(self):
        self.heartbeat()
        bridge = FakeBridge(lambda args: {"ok": True, "page": "p1", "title": "T", "url": "u"})
        self.run_cli(["--ide", "click", "Sign in"], bridge)
        bridge2 = FakeBridge(lambda args: {"ok": True})
        self.run_cli(["--ide", "type", "e7", "me@example.com", "--submit"], bridge2)
        bridge3 = FakeBridge(lambda args: {"ok": True})
        self.run_cli(["--ide", "press", "Enter", "--on", "e7"], bridge3)
        # the page has no element named exactly "Sign in": the text selector finds it
        self.assertEqual([x["args"]["action"] for x in bridge.seen], ["read", "click"])
        self.assertEqual(bridge.seen[-1]["args"]["selector"], 'internal:text="Sign in"i >> nth=0')
        self.assertEqual(bridge2.seen[0]["args"], {"action": "type", "engine": "agent", "ref": "e7", "element": "e7", "text": "me@example.com", "submit": True})
        self.assertEqual(bridge3.seen[0]["args"], {"action": "press", "engine": "agent", "key": "Enter", "ref": "e7", "element": "e7"})

    SNAP = "\n".join([
        '- banner [ref=e2]:',
        '  - link "Pricing" [ref=e5] [cursor=pointer]:',
        '- heading "Sign in to Acme" [level=1] [ref=e8]',
        '- generic [ref=e9]: Email',
        '- textbox "Email" [ref=e10]',
        '- button "Sign in" [ref=e14] [cursor=pointer]',
        '- link "sign in" [ref=e20]',
    ])

    def test_a_name_finds_the_element_it_names(self):
        # the button, not the heading that starts with the same words, and a button before a link
        self.assertEqual(BI.ref_for("Sign in", self.SNAP), "e14")
        self.assertEqual(BI.ref_for("  email ", self.SNAP, "type"), "e10")
        self.assertEqual(BI.ref_for("Pricing", self.SNAP), "e5")
        self.assertIsNone(BI.ref_for("Sign", self.SNAP))
        self.assertIsNone(BI.ref_for("Sign in", ""))

    def test_click_by_name_reads_the_page_first_and_clicks_the_ref(self):
        self.heartbeat()
        bridge = FakeBridge(lambda args: {"ok": True, "page": "p1", "title": "T", "url": "u", "text": self.SNAP} if args["action"] == "read" else {"ok": True})
        rc, _, err = self.run_cli(["--ide", "click", "Sign in"], bridge)
        self.assertEqual(rc, 0, err)
        self.assertEqual(bridge.seen[-1]["args"], {"action": "click", "engine": "agent", "ref": "e14", "element": "Sign in"})

    def test_shot_writes_the_image_and_prints_the_path(self):
        self.heartbeat()
        img = base64.b64encode(b"\xff\xd8\xff fake jpeg").decode()
        bridge = FakeBridge(lambda args: {"ok": True, "page": "p1", "image": img, "mime": "image/jpeg"})
        out_file = os.path.join(self.tmp, "s.jpg")
        rc, out, _ = self.run_cli(["--ide", "shot", "--out", out_file], bridge)
        self.assertEqual((rc, out.strip()), (0, out_file))
        with open(out_file, "rb") as f:
            self.assertEqual(f.read(), b"\xff\xd8\xff fake jpeg")

    def test_an_error_from_the_ide_fails_the_command(self):
        self.heartbeat()
        bridge = FakeBridge(lambda args: {"ok": False, "error": "The user took control of the browser page"})
        rc, _, err = self.run_cli(["--ide", "click", "Buy"], bridge)
        self.assertEqual(rc, 1)
        self.assertIn("took control", err)

    def test_no_ide_falls_back_to_the_standalone_browser(self):
        with mock.patch.object(B, "run", return_value={"ok": True, "title": "Example Domain", "url": "https://example.com/"}) as run:
            rc, out, err = self.run_cli(["--ide", "open", "https://example.com"])
        self.assertEqual(rc, 0)
        self.assertIn("IDE 没开，改用独立浏览器", err)
        self.assertEqual((run.call_args[0][0].op, run.call_args[0][0].url), ("open", "https://example.com"))
        self.assertIn("Example Domain", out)

    def test_a_turbo_part_never_opens_pages_in_the_persons_window(self):
        # task-aqu6u: a Turbo part opened its copy's index.html in the right panel; the copy was deleted, the tabs stayed
        self.heartbeat()
        bridge = FakeBridge(lambda args: {"ok": True, "page": "p1"})
        page = os.path.join(self.tmp, "index.html")
        open(page, "w").close()
        with mock.patch.dict(os.environ, {"DISPATCH_TURBO_RUN": "tb-1007-0300-abcd"}), \
                mock.patch.object(B, "run", return_value={"ok": True, "title": "Todo List", "url": "file://" + page}) as run:
            rc, out, err = self.run_cli(["--ide", "open", "file://" + page], bridge)
            shown = ide_show.show(page, wait=0.5)
        self.assertEqual(rc, 0)
        self.assertEqual(bridge.seen, [])  # nothing reached the Agents window
        self.assertIn("Turbo", err)
        self.assertEqual(run.call_args[0][0].op, "open")  # it still checks its page, in the standalone browser
        self.assertFalse(shown["shown"])
        self.assertEqual(shown["reason"], "turbo")
        self.assertEqual(os.listdir(ide_show.requests_dir()) if os.path.isdir(ide_show.requests_dir()) else [], [])

    def test_an_older_bridge_falls_back_too(self):
        self.heartbeat(features=())
        with mock.patch.object(B, "run", return_value={"ok": True, "snapshot": "- heading"}) as run:
            rc, _, err = self.run_cli(["--ide", "read"])
        self.assertEqual(rc, 0)
        self.assertIn("改用独立浏览器", err)
        self.assertEqual(run.call_args[0][0].op, "snapshot")

    def test_open_with_a_login_identity(self):
        self.heartbeat(features=("show", "browser", "browser-profiles"))
        bridge = FakeBridge(lambda args: {"ok": True, "page": "p2", "title": "Inbox", "url": "https://mail.example.com/", "profile": "Work"})
        rc, out, err = self.run_cli(["--ide", "open", "https://mail.example.com", "--profile", "Work"], bridge)
        self.assertEqual(rc, 0, err)
        self.assertEqual(bridge.seen[0]["args"], {"action": "open", "engine": "agent", "url": "https://mail.example.com", "profile": "Work"})
        self.assertIn("[身份 Work]", out.splitlines()[0])

    def test_list_and_add_login_identities(self):
        self.heartbeat(features=("show", "browser", "browser-profiles"))
        rows = [{"id": "", "name": "Default", "current": False}, {"id": "work", "name": "Work", "current": True}]
        bridge = FakeBridge(lambda args: {"ok": True, "profiles": rows})
        rc, out, _ = self.run_cli(["--ide", "profiles"], bridge)
        self.assertEqual(rc, 0)
        self.assertEqual(bridge.seen[0]["args"], {"action": "profiles", "engine": "agent"})
        self.assertEqual(out.splitlines()[:2], ["  Default", "* Work"])
        bridge2 = FakeBridge(lambda args: {"ok": True, "profile": "Test user", "profiles": rows})
        rc, out, _ = self.run_cli(["--ide", "profiles", "--add", "Test user", "--json"], bridge2)
        self.assertEqual(rc, 0)
        self.assertEqual(bridge2.seen[0]["args"], {"action": "profile-add", "engine": "agent", "name": "Test user"})
        self.assertEqual(json.loads(out)["profile"], "Test user")

    def test_an_older_ide_is_not_sent_an_identity_it_would_drop(self):
        self.heartbeat()
        bridge = FakeBridge(lambda args: {"ok": True})
        rc, out, _ = self.run_cli(["--ide", "open", "https://example.com", "--profile", "Work", "--json"], bridge)
        self.assertEqual((rc, json.loads(out)["code"]), (1, "old-ide"))
        self.assertEqual(bridge.seen, [])

    def test_identities_need_the_ide_no_standalone_fallback(self):
        with mock.patch.object(B, "run") as run:
            rc, out, _ = self.run_cli(["--ide", "open", "https://example.com", "--profile", "Work", "--json"])
            rc2, _, err2 = self.run_cli(["--ide", "profiles"])
        run.assert_not_called()
        self.assertEqual((rc, json.loads(out)["code"]), (1, "ide-closed"))
        self.assertEqual(rc2, 1)
        self.assertIn("Dispatch IDE", err2)

    def test_a_request_nobody_takes_is_taken_back(self):
        self.heartbeat()
        with self.assertRaises(BI.IdeUnavailable):
            BI.send({"action": "status"}, take_wait=0.3, sleep=lambda s: time.sleep(0.05))
        self.assertEqual([n for n in os.listdir(ide_show.requests_dir()) if n.endswith(".json")], [])


if __name__ == "__main__":
    unittest.main()
