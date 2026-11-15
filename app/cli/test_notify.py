# -*- coding: utf-8 -*-
import json
import os
import tempfile
import time
import unittest
from unittest.mock import patch

import dplatform as P
import notify

WINDOWS_READY = True


@patch.object(P, "IS_WIN", False)
class ChannelSelection(unittest.TestCase):
    def test_ntfy_wins_over_bark(self):
        with patch.object(notify, "setting", side_effect=lambda n: {"NTFY_URL": "https://ntfy.sh/x", "BARK_KEY": "k"}.get(n, "")):
            self.assertEqual(notify.channel(), ("ntfy", "https://ntfy.sh/x"))

    def test_bark_alone(self):
        with patch.object(notify, "setting", side_effect=lambda n: "mykey" if n == "BARK_KEY" else ""):
            self.assertEqual(notify.channel(), ("bark", "mykey"))

    def test_nothing_falls_back_to_macos(self):
        with patch.object(notify, "setting", return_value=""):
            self.assertEqual(notify.channel(), ("macos", ""))


class Ntfy(unittest.TestCase):
    def test_topic_is_the_last_segment(self):
        with patch.object(notify, "_post", return_value=200) as post:
            self.assertEqual(notify._ntfy("https://ntfy.sh/my-topic", "标题", "正文", "normal", ""), 200)
            url, payload = post.call_args.args
            self.assertEqual(url, "https://ntfy.sh")
            self.assertEqual(payload["topic"], "my-topic")
            self.assertEqual(payload["message"], "正文")
            self.assertEqual(payload["priority"], 3)

    def test_self_hosted_subpath_and_high_priority(self):
        with patch.object(notify, "_post", return_value=200) as post:
            notify._ntfy("https://example.com/ntfy/my-topic", "t", "b", "high", "http://link/")
            url, payload = post.call_args.args
            self.assertEqual(url, "https://example.com/ntfy")
            self.assertEqual(payload["topic"], "my-topic")
            self.assertEqual(payload["priority"], 5)
            self.assertEqual(payload["click"], "http://link/")


class Bark(unittest.TestCase):
    def test_key_becomes_api_day_app_url(self):
        with patch.object(notify, "_post", return_value=200) as post:
            notify._bark("abc123", "t", "b", "high", "http://link/")
            url, payload = post.call_args.args
            self.assertEqual(url, "https://api.day.app/abc123")
            self.assertEqual(payload["level"], "timeSensitive")
            self.assertEqual(payload["url"], "http://link/")

    def test_full_url_key_is_used_as_is(self):
        with patch.object(notify, "_post", return_value=200) as post:
            notify._bark("https://bark.example.com/k", "t", "b", "normal", "")
            self.assertEqual(post.call_args.args[0], "https://bark.example.com/k")


@patch.object(P, "IS_WIN", False)
class Send(unittest.TestCase):
    def test_no_channel_uses_macos(self):
        with patch.object(notify, "setting", return_value=""), patch.object(notify, "_macos") as mac:
            res = notify.send("标题", "正文")
        self.assertEqual(res, {"ok": True, "channel": "macos"})
        mac.assert_called_once_with("标题", "正文")

    def test_ntfy_success(self):
        with patch.object(notify, "setting", side_effect=lambda n: "https://ntfy.sh/x" if n == "NTFY_URL" else ""), \
             patch.object(notify, "_ntfy", return_value=200) as n:
            res = notify.send("t", "b", level="high")
        self.assertTrue(res["ok"]); self.assertEqual(res["channel"], "ntfy")
        self.assertEqual(n.call_args.args[:4], ("https://ntfy.sh/x", "t", "b", "high"))

    def test_remote_failure_still_banners_locally(self):
        with patch.object(notify, "setting", side_effect=lambda n: "https://ntfy.sh/x" if n == "NTFY_URL" else ""), \
             patch.object(notify, "_ntfy", side_effect=OSError("offline")), patch.object(notify, "_macos") as mac:
            res = notify.send("t", "b")
        self.assertFalse(res["ok"]); self.assertEqual(res["fallback"], "macos")
        mac.assert_called_once()

    def test_empty_title_defaults(self):
        with patch.object(notify, "setting", return_value=""), patch.object(notify, "_macos") as mac:
            notify.send("", "b")
        self.assertEqual(mac.call_args.args[0], "Dispatch")


class Dedup(unittest.TestCase):
    def test_same_key_inside_window_is_sent_once(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "dedup.json")
            self.assertFalse(notify.dedup_hit("presence:claude:abc", 300, p))
            self.assertTrue(notify.dedup_hit("presence:claude:abc", 300, p))
            self.assertFalse(notify.dedup_hit("presence:claude:abc", 0, p))

    def test_different_keys_are_independent(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "dedup.json")
            self.assertFalse(notify.dedup_hit("a", 300, p))
            self.assertFalse(notify.dedup_hit("b", 300, p))

    def test_send_skips_duplicate(self):
        with patch.object(notify, "dedup_hit", return_value=True) as hit, patch.object(notify, "_macos") as mac:
            res = notify.send("t", "b", key="presence:claude:abc")
        self.assertTrue(res["skipped"]); mac.assert_not_called(); hit.assert_called_once()


class ServeLink(unittest.TestCase):
    def test_reads_conf_and_links_with_a_login_code_not_the_token(self):
        import serve
        with tempfile.TemporaryDirectory() as d:
            json.dump({"token": "tok", "port": 7799, "bind": "100.1.2.3"}, open(os.path.join(d, "serve.json"), "w"))
            with patch.object(notify.D, "DISPATCH_DIR", d), patch.multiple(serve, DISPATCH_DIR=d, LOGINS=os.path.join(d, "serve-logins.json")):
                link = notify.serve_link("/insights/2026-09-09_1200.html")
            self.assertTrue(link.startswith("http://100.1.2.3:7799/?login="))
            self.assertIn("to=%2Finsights%2F2026-09-09_1200.html", link)
            self.assertNotIn("token=", link)

    def test_ntfy_link_expires_in_minutes_bark_in_a_day(self):
        import serve, time
        for chan, lo, hi in (("ntfy", 60, 15 * 60 + 5), ("bark", 3600, 24 * 3600 + 5)):
            with tempfile.TemporaryDirectory() as d:
                json.dump({"token": "tok", "port": 7799, "bind": "100.1.2.3"}, open(os.path.join(d, "serve.json"), "w"))
                logins = os.path.join(d, "serve-logins.json")
                with patch.object(notify.D, "DISPATCH_DIR", d), patch.multiple(serve, DISPATCH_DIR=d, LOGINS=logins), \
                     patch.object(notify, "channel", return_value=(chan, "x")):
                    notify.serve_link("/x")
                left = list(json.load(open(logins)).values())[0] - time.time()
                self.assertTrue(lo < left <= hi, (chan, left))

    def test_when_the_phone_lives_on_another_mac_the_link_opens_there(self):
        import serve
        with tempfile.TemporaryDirectory() as d:
            json.dump({"token": "tok", "port": 7799, "bind": "100.1.2.3", "phone_host": "mini"}, open(os.path.join(d, "serve.json"), "w"))
            home = {"id": "mini", "name": "Mac mini", "ssh": "me@mini"}
            with patch.object(notify.D, "DISPATCH_DIR", d), patch.object(serve, "phone_home", return_value=home), \
                 patch.object(serve, "remote_login_link", return_value="http://100.9.9.9:7799/?login=abc&to=%23%2Fsessions%2Fs1") as far:
                link = notify.serve_link("/#/sessions/s1")
            self.assertTrue(link.startswith("http://100.9.9.9:7799/"))
            self.assertEqual(far.call_args.kwargs["to"], "#/sessions/s1")
            # that Mac does not answer: fall back to this one rather than sending a dead link
            with patch.object(notify.D, "DISPATCH_DIR", d), patch.object(serve, "phone_home", return_value=home), \
                 patch.object(serve, "remote_login_link", return_value=""), patch.multiple(serve, DISPATCH_DIR=d, LOGINS=os.path.join(d, "serve-logins.json")):
                self.assertTrue(notify.serve_link("/#/sessions/s1").startswith("http://100.1.2.3:7799/?login="))

    def test_no_conf_is_empty(self):
        with tempfile.TemporaryDirectory() as d, patch.object(notify.D, "DISPATCH_DIR", d):
            self.assertEqual(notify.serve_link("/x"), "")


class PhoneWatcher(unittest.TestCase):
    """notify_watch.tick: one push per unread reply / confirmation, none on the first pass."""

    def _tick(self, rows, live=(), st=None, first=False, settings=None):
        import notify_watch as W
        sent = []
        send = lambda title, body="", url="", level="normal", key="": sent.append((title, body, url, level, key)) or {"ok": True}
        st = st if st is not None else {}
        W.tick(rows, settings or {}, st, send, lambda p: "http://phone" + p, now=1000.0, first=first, live=live)
        return sent, st

    def test_unread_reply_pushed_once(self):
        row = {"key": "claude-code:s1", "agent": "claude-code", "session_id": "s1", "project": "sprout", "title": "预算提醒", "unread": True, "reply_id": "990:abc", "reply_at": 990, "reply_preview": "两档提醒做完了"}
        sent, st = self._tick([row])
        self.assertEqual(len(sent), 1)
        self.assertIn("Claude Code 回复了", sent[0][0]); self.assertIn("两档提醒做完了", sent[0][1]); self.assertEqual(sent[0][2], "http://phone/#/sessions/s1")
        sent2, _ = self._tick([row], st=st)
        self.assertEqual(sent2, [])  # remembered
        row2 = dict(row, reply_id="995:def", reply_at=995)
        sent3, _ = self._tick([row2], st=st)
        self.assertEqual(len(sent3), 1)  # a new answer rings again

    def test_first_pass_only_remembers(self):
        row = {"key": "codex:s2", "agent": "codex", "session_id": "s2", "project": "p", "title": "t", "unread": True, "reply_id": "1:x", "reply_at": 999}
        sent, st = self._tick([row], first=True)
        self.assertEqual(sent, []); self.assertEqual(st["replies"], ["codex:s2|1:x"])

    def test_read_scheduled_and_old_replies_are_quiet(self):
        base = {"key": "claude-code:s3", "agent": "claude-code", "session_id": "s3", "project": "p", "title": "t", "reply_id": "1:y", "reply_at": 999}
        self.assertEqual(self._tick([dict(base, unread=False)])[0], [])
        self.assertEqual(self._tick([dict(base, unread=True, scheduled=True)])[0], [])
        self.assertEqual(self._tick([dict(base, unread=True, reply_at=1000 - 7 * 3600)])[0], [])
        self.assertEqual(self._tick([dict(base, unread=True)], settings={"notify_reply": 0})[0], [])

    def test_confirmation_from_live_rows(self):
        live = [{"agent": "codex", "session_id": "s4", "state": "idle", "attention": "input", "project": "harbor-api", "title": "限流", "last_at": 900}]
        sent, st = self._tick([], live=live)
        self.assertEqual(len(sent), 1); self.assertEqual(sent[0][3], "high"); self.assertEqual(sent[0][4], "presence:codex:s4")
        self.assertEqual(self._tick([], live=live, st=st)[0], [])
        self.assertEqual(self._tick([], live=[dict(live[0], state="working")])[0], [])

class DesktopBanners(unittest.TestCase):
    """No phone channel: this Mac's own banners, in English, when the person turned notify_desktop on."""

    def test_banner_texts_in_english_for_this_mac(self):
        import notify_watch as W
        sent = []
        send = lambda title, body="", url="", level="normal", key="": sent.append((title, body)) or {"ok": True}
        row = {"key": "claude-code:s1", "agent": "claude-code", "session_id": "s1", "project": "sprout", "title": "Budget", "unread": True, "reply_id": "990:abc", "reply_at": 990, "reply_preview": "Done"}
        live = [{"agent": "codex", "session_id": "s4", "state": "idle", "attention": "input", "project": "harbor-api", "title": "Limits", "last_at": 900}]
        W.tick([row], {}, {}, send, lambda p: "", now=1000.0, live=live, english=True)
        self.assertEqual([t for t, _ in sent], ["Codex needs you · harbor-api", "Claude Code replied · sprout"])
        self.assertNotIn("回复", " ".join(t + b for t, b in sent))

    def test_off_until_the_person_turns_it_on_and_the_phone_wins(self):
        import notify_watch as W
        self.assertFalse(W.desktop_wanted({}))
        self.assertTrue(W.desktop_wanted({"notify_desktop": 1}))
        with tempfile.TemporaryDirectory() as d, patch.object(W.D, "settings_load", return_value={}), patch.object(notify, "channel", return_value=("macos", "")):
            self.assertIn("skipped", W.run_once(os.path.join(d, "watch.json")))
        with tempfile.TemporaryDirectory() as d, patch.object(W.D, "settings_load", return_value={"notify_desktop": 1}), patch.object(notify, "channel", return_value=("macos", "")), \
                patch.object(W.D, "load_index", return_value={}), patch.object(W.D, "live_sessions", return_value=[]), patch("activity.activity_list", return_value=[]):
            r = W.run_once(os.path.join(d, "watch.json"))
            self.assertEqual((r["ok"], r["sent"], r["first"]), (True, 0, True))
            self.assertTrue(os.path.exists(os.path.join(d, "watch.json")))

    def test_default_setting_is_off(self):
        import dispatch
        self.assertEqual(dispatch.SETTING_DEFAULTS["notify_desktop"], 0)


class MacBannerPrefs(unittest.TestCase):
    """Settings › Notifications: which kinds show a banner on this Mac, and its sound (notify_prefs.py)."""

    def test_defaults_finished_and_needs_you_ring_a_stop_does_not(self):
        import notify_prefs as NP
        p = NP.prefs({}, known=["Glass", "Ping"])
        self.assertEqual((p["finished"], p["needs_you"], p["stopped"], p["sound"]), (True, True, False, "default"))
        self.assertEqual(p["sounds"], ["Glass", "Ping"])
        import dispatch
        for k, v in NP.DEFAULTS.items():
            self.assertEqual(dispatch.SETTING_DEFAULTS[k], v)

    def test_each_kind_turns_off_on_its_own(self):
        import notify_prefs as NP
        s = {"notify_mac_finished": 0, "notify_mac_stopped": 1}
        self.assertEqual([NP.wants(s, k) for k in NP.KINDS], [False, True, True])
        self.assertFalse(NP.wants(s, "bogus"))

    def test_a_sound_name_is_one_the_mac_has(self):
        import notify_prefs as NP
        known = ["Glass", "Ping"]
        self.assertEqual(NP.normal_sound("glass", known), "Glass")
        self.assertEqual(NP.normal_sound("NONE", known), "none")
        self.assertEqual(NP.normal_sound('Glass"; do shell script "rm', known), "default")

    def test_play_spawns_afplay_and_none_is_quiet(self):
        import notify_prefs as NP
        ran = []
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "Glass.aiff"), "wb").close()
            with patch.object(NP, "SOUNDS_DIR", d), patch.object(NP, "sound_file", lambda n, folder=d: os.path.join(d, n + ".aiff") if n == "Glass" else ""), \
                    patch.object(NP, "sounds", return_value=["Glass"]):
                r = NP.play("Glass", spawn=ran.append)
                self.assertEqual((r["ok"], r["sound"]), (True, "Glass"))
                self.assertEqual(ran, [["afplay", os.path.join(d, "Glass.aiff")]])
                self.assertEqual(NP.play("none", spawn=ran.append), {"ok": True, "sound": "none", "file": ""})
                self.assertEqual(len(ran), 1)

    def test_applescript_sound_part(self):
        import notify_prefs as NP
        with patch.object(NP, "sounds", return_value=["Glass"]), patch.object(NP, "alert_sound", return_value="/System/Library/Sounds/Funk.aiff"):
            self.assertEqual(NP.applescript_sound("Glass"), ' sound name "Glass"')
            self.assertEqual(NP.applescript_sound("default"), ' sound name "Funk"')
            self.assertEqual(NP.applescript_sound("none"), "")

    def test_background_banners_follow_the_kinds_and_the_sound(self):
        import notify_watch as W
        import notify_prefs as NP
        calls = []
        settings = {"notify_desktop": 1, "notify_mac_finished": 0, "notify_sound": "Glass"}
        row = {"key": "claude-code:s1", "agent": "claude-code", "session_id": "s1", "project": "p", "title": "t", "unread": True, "reply_id": "9:a", "reply_at": time.time()}
        live = [{"agent": "codex", "session_id": "s4", "state": "idle", "attention": "input", "project": "api", "title": "Limits", "last_at": 900}]
        with tempfile.TemporaryDirectory() as d, patch.object(W.D, "settings_load", return_value=settings), patch.object(notify, "channel", return_value=("macos", "")), \
                patch.object(W.D, "load_index", return_value={}), patch.object(W.D, "live_sessions", return_value=live), patch("activity.activity_list", return_value=[row]), \
                patch.object(NP, "sounds", return_value=["Glass"]), patch.object(notify, "send", side_effect=lambda *a, **k: calls.append((a, k)) or {"ok": True}):
            path = os.path.join(d, "watch.json")
            W.save_state({}, path)
            W.run_once(path)
        self.assertEqual(len(calls), 1, calls)  # needs you rang, the finished reply did not
        self.assertIn("needs you", calls[0][0][0])
        self.assertEqual(calls[0][1]["sound"], ' sound name "Glass"')


class WindowsToast(unittest.TestCase):
    """No phone channel on Windows: a toast through PowerShell instead of osascript."""

    def test_channel_and_send_use_the_toast(self):
        with patch.object(P, "IS_WIN", True), patch.object(notify, "setting", return_value=""), \
             patch.object(notify, "_windows") as toast, patch.object(notify, "_macos", side_effect=AssertionError("no osascript")):
            self.assertEqual(notify.channel(), ("windows", ""))
            self.assertEqual(notify.send("标题", "正文"), {"ok": True, "channel": "windows"})
        toast.assert_called_once_with("标题", "正文")

    def test_remote_failure_falls_back_to_a_toast(self):
        with patch.object(P, "IS_WIN", True), patch.object(notify, "setting", side_effect=lambda n: "https://ntfy.sh/x" if n == "NTFY_URL" else ""), \
             patch.object(notify, "_ntfy", side_effect=OSError("offline")), patch.object(notify, "_windows") as toast:
            res = notify.send("t", "b")
        self.assertEqual(res["fallback"], "windows"); toast.assert_called_once()

    def test_command_line_keeps_the_text_out_of_the_script(self):
        from types import SimpleNamespace
        with patch.object(P, "IS_WIN", True), patch.object(notify.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=b"", stderr=b"")) as run:
            notify._windows("a 'quoted' $title", "<body> & more")
        args, kw = run.call_args.args[0], run.call_args.kwargs
        self.assertEqual(args[:2], ["powershell", "-NoProfile"]); self.assertEqual(args[-2:], ["-Command", notify.TOAST_PS])
        self.assertEqual(kw["env"]["DISPATCH_TOAST_TITLE"], "a 'quoted' $title"); self.assertEqual(kw["env"]["DISPATCH_TOAST_BODY"], "<body> & more")
        self.assertEqual(kw["creationflags"], P.CREATE_NO_WINDOW)
        self.assertNotIn("quoted", notify.TOAST_PS)
        self.assertIn("dev.schaefer.dispatch", notify.TOAST_PS); self.assertIn("SecurityElement]::Escape", notify.TOAST_PS)

    def test_a_failed_toast_is_an_error_not_a_crash(self):
        from types import SimpleNamespace
        with patch.object(P, "IS_WIN", True), patch.object(notify, "setting", return_value=""), \
             patch.object(notify.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout=b"", stderr=b"boom")):
            res = notify.send("t", "b")
        self.assertEqual((res["ok"], res["channel"]), (False, "windows")); self.assertIn("boom", res["error"])

    @unittest.skipUnless(os.name == "nt", "real Windows only")
    def test_the_toast_script_parses_in_windows_powershell(self):
        import subprocess
        check = "$null = [ScriptBlock]::Create($env:DISPATCH_TOAST_SCRIPT); 'parsed'"
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", check], capture_output=True, timeout=60,
                           env=dict(os.environ, DISPATCH_TOAST_SCRIPT=notify.TOAST_PS))
        self.assertEqual(r.returncode, 0, r.stderr); self.assertIn(b"parsed", r.stdout)

if __name__ == "__main__":
    unittest.main()
