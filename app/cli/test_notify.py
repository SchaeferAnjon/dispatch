import json
import os
import tempfile
import unittest
from unittest.mock import patch

import notify


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

    def test_no_conf_is_empty(self):
        with tempfile.TemporaryDirectory() as d, patch.object(notify.D, "DISPATCH_DIR", d):
            self.assertEqual(notify.serve_link("/x"), "")


if __name__ == "__main__":
    unittest.main()


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
