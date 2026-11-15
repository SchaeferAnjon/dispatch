# -*- coding: utf-8 -*-
"""accounts.py: several Claude Code and Codex sign-ins, switched in one step. Every keychain item here is a file in a
temp folder (Keychain(fake_dir)); the real keychain is never asked."""
import argparse
import base64
import contextlib
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import accounts as A  # noqa: E402

WINDOWS_READY = False  # the store lock and file modes are POSIX

USER = "tester"
NOW = int(time.time())  # one clock for the fixtures: the same login is the same text


def write(path, text):
    with open(path, "w") as f:
        f.write(text)


def read_json(path):
    with open(path) as f:
        return json.load(f)


def b64(d):
    return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")


def jwt(payload):
    return "%s.%s.sig" % (b64({"alg": "none"}), b64(payload))


def claude_blob(rt, plan="max", expires_in=3600, access=None):
    return json.dumps({"claudeAiOauth": {"accessToken": access if access is not None else "at-" + rt, "refreshToken": rt,
                                         "expiresAt": (NOW + expires_in) * 1000, "scopes": ["user:inference"],
                                         "subscriptionType": plan}})


def oauth_account(uuid, email, org="org-1"):
    return {"accountUuid": uuid, "emailAddress": email, "organizationUuid": org, "organizationName": "Org"}


def codex_auth(email, user, ws="ws-1", plan="plus", exp_in=86400, access="cx-access"):
    idt = jwt({"email": email, "https://api.openai.com/auth": {"chatgpt_user_id": user, "chatgpt_account_id": ws, "chatgpt_plan_type": plan}})
    at = jwt({"exp": NOW + exp_in, "tag": access})
    return json.dumps({"auth_mode": "chatgpt", "OPENAI_API_KEY": None,
                       "tokens": {"id_token": idt, "access_token": at, "refresh_token": "rt-" + user, "account_id": ws},
                       "last_refresh": "2026-10-01T00:00:00Z"})


ENGINE_SIGN_IN = A.engine_sign_in


class Base(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="acct-")
        self.addCleanup(shutil.rmtree, self.home, True)
        env = {"HOME": self.home, "USER": USER, "DISPATCH_HOME": os.path.join(self.home, ".dispatch"),
               "DISPATCH_DIR": os.path.join(self.home, "tasks", ".dispatch")}
        p = mock.patch.dict(os.environ, env)
        p.start()
        self.addCleanup(p.stop)
        for k in ("CLAUDE_CONFIG_DIR", "CODEX_HOME", "DISPATCH_FAKE_KEYCHAIN", "CLAUDE_CODE_OAUTH_TOKEN"):
            os.environ.pop(k, None)
        self.kcdir = os.path.join(self.home, "fake-keychain")
        self.kc = A.Keychain(self.kcdir)
        self.vault = A.Vault(self.kc)
        self.profiles = {}  # access token -> profile answer
        self.usage = {}     # access token -> usage answer
        self.calls = []
        self.accts = A.Accounts(self.vault, profile=self.profile, claude_usage=self.claude_usage, codex_usage=self.codex_usage)
        # `dispatch accounts list / watch` ask the engines themselves (engine_sign_in runs `claude auth status`):
        # never a real engine in a test
        q = mock.patch.object(A, "engine_sign_in", lambda engine, clock=None: "")
        q.start()
        self.addCleanup(q.stop)

    # fake network
    def profile(self, tok):
        self.calls.append(("profile", tok))
        if tok not in self.profiles:
            raise OSError("offline")
        return self.profiles[tok]

    def claude_usage(self, tok):
        self.calls.append(("claude_usage", tok))
        if tok not in self.usage:
            raise OSError("offline")
        return self.usage[tok]

    def codex_usage(self, tok, ws):
        self.calls.append(("codex_usage", tok, ws))
        return self.usage[tok]

    # the engines' own places
    def claude_signed_in(self, blob, oa):
        self.kc.write(A.CLAUDE_LIVE_SERVICE, USER, blob)
        path = os.path.join(self.home, ".claude.json")
        cfg = read_json(path) if os.path.exists(path) else {"numStartups": 7, "projects": {"/x": {"allowedTools": []}}}
        cfg["oauthAccount"] = oa
        write(path, json.dumps(cfg))

    def claude_live(self):
        return self.kc.read(A.CLAUDE_LIVE_SERVICE, USER)

    def claude_cfg(self):
        return read_json(os.path.join(self.home, ".claude.json"))

    def codex_signed_in(self, blob):
        os.makedirs(os.path.join(self.home, ".codex"), exist_ok=True)
        with open(os.path.join(self.home, ".codex", "auth.json"), "w") as f:
            f.write(blob)

    def codex_live(self):
        with open(os.path.join(self.home, ".codex", "auth.json")) as f:
            return f.read()

    def save_claude(self, uuid, email, rt):
        """An account saved earlier: its login in Dispatch's keychain item, its name in accounts.json."""
        st = A.load()
        a = A._record(st, "claude", A.claude_identity_from_oauth_account(oauth_account(uuid, email)), claude_blob(rt))
        self.vault.saved_write("claude", a["id"], claude_blob(rt))
        A.save(st)
        return a["id"]


class ClaudeSwitch(Base):
    def test_switch_puts_the_other_login_in_place_and_keeps_the_one_in_use(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        b = self.save_claude("u-b", "b@x.com", "rt-b")
        r = self.accts.use("claude", "b@x.com")
        self.assertTrue(r["changed"])
        self.assertEqual(r["previous"]["email"], "a@x.com")
        self.assertEqual(self.claude_live(), claude_blob("rt-b"))
        cfg = self.claude_cfg()
        self.assertEqual(cfg["oauthAccount"]["emailAddress"], "b@x.com")
        self.assertEqual(cfg["numStartups"], 7, "the rest of ~/.claude.json stays")
        self.assertIn("/x", cfg["projects"])
        st = A.load()
        a = A.find(st, "claude", "a@x.com")
        self.assertEqual(self.vault.saved_read("claude", a["id"]), claude_blob("rt-a"), "the login that was in use is saved")
        self.assertEqual(A.generation("claude"), 1)
        self.assertEqual(A.switched()["claude"]["to"], b)
        rows = self.accts.overview(["claude"], usage=False)[0]["accounts"]
        self.assertEqual([(x["email"], x["active"]) for x in rows], [("b@x.com", True), ("a@x.com", False)])

    def test_switch_back_carries_the_refreshed_login(self):
        """Claude Code rotates its refresh token in place; the copy saved on the way out is that newest one."""
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        self.save_claude("u-b", "b@x.com", "rt-b")
        self.accts.use("claude", "b@x.com")
        # Claude Code refreshed b's login while it was in use
        self.kc.write(A.CLAUDE_LIVE_SERVICE, USER, claude_blob("rt-b2"))
        self.profiles["at-rt-b2"] = {"account": {"uuid": "u-b", "email": "b@x.com"}, "organization": {"uuid": "org-1", "name": "Org"}}
        self.accts.use("claude", "a@x.com")
        st = A.load()
        b = A.find(st, "claude", "b@x.com")
        self.assertEqual(self.vault.saved_read("claude", b["id"]), claude_blob("rt-b2"))
        self.assertEqual(self.claude_live(), claude_blob("rt-a"))
        self.assertEqual(len(A.accounts_of(st, "claude")), 2)

    def test_a_login_made_in_a_terminal_becomes_its_own_account(self):
        """/login to a third account outside Dispatch: switching away saves it as a new account, never over b."""
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        self.save_claude("u-b", "b@x.com", "rt-b")
        self.accts.use("claude", "b@x.com")
        self.claude_signed_in(claude_blob("rt-c"), oauth_account("u-c", "c@x.com"))  # offline: ~/.claude.json names it
        self.accts.use("claude", "a@x.com")
        st = A.load()
        self.assertEqual(sorted(x["email"] for x in A.accounts_of(st, "claude")), ["a@x.com", "b@x.com", "c@x.com"])
        self.assertEqual(self.vault.saved_read("claude", A.find(st, "claude", "b@x.com")["id"]), claude_blob("rt-b"))
        self.assertEqual(self.vault.saved_read("claude", A.find(st, "claude", "c@x.com")["id"]), claude_blob("rt-c"))

    def test_same_account_is_a_no_op(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        self.accts.remember("claude")
        r = self.accts.use("claude", "a@x.com")
        self.assertFalse(r["changed"])
        self.assertEqual(A.generation("claude"), 0)

    def test_by_label_and_id(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        b = self.save_claude("u-b", "b@x.com", "rt-b")
        self.accts.rename("claude", b, "Work")
        self.assertEqual(self.accts.use("claude", "work")["account"]["name"], "Work")
        self.accts.use("claude", "a@x.com")
        self.assertEqual(self.accts.use("claude", b)["account"]["id"], b)

    def test_unknown_account(self):
        with self.assertRaises(A.UserError):
            self.accts.use("claude", "nobody@x.com")

    def test_missing_saved_login_asks_to_sign_in_again(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        b = self.save_claude("u-b", "b@x.com", "rt-b")
        self.kc.delete(A.CLAUDE_SAVED_SERVICE, b)
        with self.assertRaises(A.UserError) as cm:
            self.accts.use("claude", "b@x.com")
        self.assertIn("Sign in to it again", str(cm.exception))
        self.assertTrue(A.find(A.load(), "claude", b)["needs_signin"])
        self.assertEqual(self.claude_live(), claude_blob("rt-a"), "nothing changed")

    def test_login_claude_gave_up_on_is_not_switched_to(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        b = self.save_claude("u-b", "b@x.com", "rt-b")
        self.vault.saved_write("claude", b, claude_blob("", access=""))
        with self.assertRaises(A.UserError):
            self.accts.use("claude", "b@x.com")
        self.assertEqual(self.claude_live(), claude_blob("rt-a"))

    def test_failed_write_puts_everything_back(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        self.save_claude("u-b", "b@x.com", "rt-b")
        before_cfg = self.claude_cfg()
        real_write = self.vault.claude_live_write
        calls = []

        def flaky(blob, config_dir=None):
            calls.append(blob)
            real_write(blob[:-2] if len(calls) == 1 else blob, config_dir)  # the first write does not stick
        with mock.patch.object(self.vault, "claude_live_write", flaky):
            with self.assertRaises(A.UserError):
                self.accts.use("claude", "b@x.com")
        self.assertEqual(self.claude_live(), claude_blob("rt-a"))
        self.assertEqual(self.claude_cfg(), before_cfg)
        self.assertEqual(A.generation("claude"), 0)

    def test_switch_drops_the_account_less_quota_cache(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        self.save_claude("u-b", "b@x.com", "rt-b")
        cache = os.path.join(A.quota_dir(), "claude-usage.json")
        os.makedirs(os.path.dirname(cache))
        write(cache, "{}")
        self.accts.use("claude", "b@x.com")
        self.assertFalse(os.path.exists(cache))

    def test_remove(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        b = self.save_claude("u-b", "b@x.com", "rt-b")
        self.accts.remember("claude")
        with self.assertRaises(A.UserError):
            self.accts.remove("claude", "a@x.com")  # in use
        self.accts.remove("claude", "b@x.com")
        self.assertIsNone(self.kc.read(A.CLAUDE_SAVED_SERVICE, b))
        self.assertIsNone(A.find(A.load(), "claude", "b@x.com"))

    def test_scoped_service_name(self):
        import hashlib
        self.assertEqual(A.claude_live_service(), "Claude Code-credentials")
        self.assertEqual(A.claude_live_service("/tmp/x"), "Claude Code-credentials-" + hashlib.sha256(b"/tmp/x").hexdigest()[:8])

    def test_keychain_user_rule(self):
        with mock.patch.dict(os.environ, {"USER": "first@example.com"}):
            self.assertEqual(A.keychain_user(), "claude-code-user")
        with mock.patch.dict(os.environ, {"USER": "anna.b"}):
            self.assertEqual(A.keychain_user(), "anna.b")


class ClaudeAdd(Base):
    def fake_login(self, blob, oa, overwrite_legacy=None):
        def run(argv, env):
            self.assertEqual(argv[1:], ["auth", "login", "--claudeai"])
            self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", env)
            d = env["CLAUDE_CONFIG_DIR"]
            self.kc.write(A.claude_live_service(d), USER, blob)
            write(os.path.join(d, ".claude.json"), json.dumps({"oauthAccount": oa}))
            if overwrite_legacy:
                self.kc.write(A.CLAUDE_LIVE_SERVICE, USER, overwrite_legacy)
            self.tmp = d
            return 0
        return run

    def test_add_signs_in_beside_the_account_in_use(self):
        os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = "env-token"
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        r = self.accts.add("claude", label="Work", run=self.fake_login(claude_blob("rt-b"), oauth_account("u-b", "b@x.com"), overwrite_legacy="junk"))
        self.assertEqual(r["account"]["name"], "Work")
        self.assertFalse(r["used"])
        self.assertEqual(self.claude_live(), claude_blob("rt-a"), "the account in use stays signed in")
        self.assertEqual(self.claude_cfg()["oauthAccount"]["emailAddress"], "a@x.com")
        self.assertFalse(os.path.exists(self.tmp), "the temporary sign-in folder is gone")
        self.assertIsNone(self.kc.read(A.claude_live_service(self.tmp), USER), "and its keychain item")
        st = A.load()
        self.assertEqual(sorted(x["email"] for x in A.accounts_of(st, "claude")), ["a@x.com", "b@x.com"])
        self.assertEqual(self.vault.saved_read("claude", r["account"]["id"]), claude_blob("rt-b"))

    def test_add_and_use(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        r = self.accts.add("claude", use=True, run=self.fake_login(claude_blob("rt-b"), oauth_account("u-b", "b@x.com")))
        self.assertTrue(r["used"])
        self.assertEqual(self.claude_live(), claude_blob("rt-b"))

    def test_signing_in_again_updates_the_same_account(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        b = self.save_claude("u-b", "b@x.com", "rt-b")
        r = self.accts.add("claude", run=self.fake_login(claude_blob("rt-b9"), oauth_account("u-b", "b@x.com")))
        self.assertTrue(r["again"])
        self.assertEqual(r["account"]["id"], b)
        self.assertEqual(self.vault.saved_read("claude", b), claude_blob("rt-b9"))

    def test_cancelled_login_adds_nothing(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        with self.assertRaises(A.UserError):
            self.accts.add("claude", run=lambda argv, env: 1)
        self.assertEqual([x["email"] for x in A.accounts_of(A.load(), "claude")], ["a@x.com"])


class Codex(Base):
    def test_switch_swaps_auth_json(self):
        self.codex_signed_in(codex_auth("a@x.com", "user-a"))
        st = A.load()
        bb = codex_auth("b@x.com", "user-b", ws="ws-2", plan="pro")
        b = A._record(st, "codex", A.codex_identity(bb), bb)
        self.vault.saved_write("codex", b["id"], bb)
        A.save(st)
        r = self.accts.use("codex", "b@x.com")
        self.assertTrue(r["changed"])
        self.assertEqual(self.codex_live(), bb)
        mode = stat.S_IMODE(os.stat(os.path.join(self.home, ".codex", "auth.json")).st_mode)
        self.assertEqual(mode, 0o600)
        saved = os.path.join(self.home, ".dispatch", "accounts", "codex", b["id"], "auth.json")
        self.assertEqual(stat.S_IMODE(os.stat(saved).st_mode), 0o600)
        a = A.find(A.load(), "codex", "a@x.com")
        self.assertEqual(self.vault.saved_read("codex", a["id"]), codex_auth("a@x.com", "user-a"))
        self.assertEqual(a["plan"], "plus")
        self.assertEqual(A.generation("codex"), 1)
        self.assertEqual(A.generation("claude"), 0)

    def test_same_person_two_workspaces_are_two_accounts(self):
        one, two = codex_auth("a@x.com", "user-a", ws="ws-1"), codex_auth("a@x.com", "user-a", ws="ws-2")
        self.assertNotEqual(A.identity_key(A.codex_identity(one)), A.identity_key(A.codex_identity(two)))

    def test_keyring_store_is_refused(self):
        os.makedirs(os.path.join(self.home, ".codex"))
        write(os.path.join(self.home, ".codex", "config.toml"), 'cli_auth_credentials_store = "keyring"\n')
        with self.assertRaises(A.UserError) as cm:
            self.accts.use("codex", "x")
        self.assertIn("keychain", str(cm.exception))

    def test_add_signs_in_in_a_temporary_codex_home(self):
        self.codex_signed_in(codex_auth("a@x.com", "user-a"))

        def run(argv, env):
            self.assertEqual(argv[1:], ["login", "-c", 'cli_auth_credentials_store="file"'])
            with open(os.path.join(env["CODEX_HOME"], "auth.json"), "w") as f:
                f.write(codex_auth("b@x.com", "user-b"))
            self.tmp = env["CODEX_HOME"]
            return 0
        r = self.accts.add("codex", run=run)
        self.assertEqual(r["account"]["email"], "b@x.com")
        self.assertEqual(self.codex_live(), codex_auth("a@x.com", "user-a"))
        self.assertFalse(os.path.exists(self.tmp))


class Usage(Base):
    def test_lines(self):
        now = time.mktime((2026, 10, 1, 15, 0, 0, 0, 0, -1))
        at18 = time.mktime((2026, 10, 1, 18, 0, 0, 0, 0, -1))
        mon = time.mktime((2026, 10, 5, 8, 0, 0, 0, 0, -1))
        s = A.summarize("claude", [{"kind": "session", "used_percent": 82.4, "resets_at": at18}, {"kind": "weekly", "used_percent": 40, "resets_at": mon}], now)
        self.assertEqual(s["line"], "Claude: 82% of this 5-hour allowance used, resets 18:00")
        self.assertEqual((s["level"], s["short"]), ("warn", "82%"))
        s = A.summarize("claude", [{"kind": "session", "used_percent": 10, "resets_at": at18}, {"kind": "weekly", "used_percent": 85, "resets_at": mon}], now)
        self.assertEqual(s["line"], "Claude: 85% of this week's allowance used, resets Mon 08:00")
        s = A.summarize("codex", [{"kind": "session", "used_percent": 100, "resets_at": at18}], now)
        self.assertEqual((s["line"], s["level"]), ("Codex: this 5-hour allowance is used up, resets 18:00", "out"))
        s = A.summarize("claude", [{"kind": "weekly_model", "model": "Fable", "used_percent": 30, "resets_at": None}], now)
        self.assertEqual((s["line"], s["level"]), ("Claude: 30% of this week's Fable allowance used", "ok"))
        self.assertEqual(A.summarize("claude", [], now)["level"], "unknown")
        # a window whose reset has passed says nothing any more
        self.assertEqual(A.summarize("claude", [{"kind": "session", "used_percent": 99, "resets_at": now - 5}], now)["level"], "unknown")

    def test_each_account_is_asked_with_its_own_login_and_cached(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        self.accts.remember("claude")
        self.save_claude("u-b", "b@x.com", "rt-b")
        reset = time.time() + 3600
        self.usage["at-rt-a"] = {"limits": [{"kind": "session", "percent": 82, "resets_at": reset}, {"kind": "weekly_all", "percent": 20}]}
        self.usage["at-rt-b"] = {"limits": [{"kind": "session", "percent": 5}]}
        rows = self.accts.overview(["claude"])[0]["accounts"]
        self.assertEqual([(x["email"], x["short"], x["level"]) for x in rows], [("a@x.com", "82%", "warn"), ("b@x.com", "5%", "ok")])
        n = len(self.calls)
        self.accts.overview(["claude"])
        self.assertEqual(len(self.calls), n, "the second look within five minutes is served from the cache")

    def test_expired_login_shows_the_last_numbers(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        self.accts.remember("claude")
        st = A.load()
        a = A.find(st, "claude", "a@x.com")
        A._write_private(A._p("usage", a["id"] + ".json"), json.dumps({"at": time.time() - 4000, "windows": [{"kind": "session", "used_percent": 50}]}))
        self.kc.write(A.CLAUDE_LIVE_SERVICE, USER, claude_blob("rt-a", expires_in=-10))
        rows = self.accts.overview(["claude"])[0]["accounts"]
        self.assertEqual(rows[0]["short"], "50%")
        self.assertNotIn("claude_usage", [c[0] for c in self.calls])

    def test_codex_usage(self):
        self.codex_signed_in(codex_auth("a@x.com", "user-a", ws="ws-9", access="tok-a"))
        tok = json.loads(codex_auth("a@x.com", "user-a", ws="ws-9", access="tok-a"))["tokens"]["access_token"]
        self.usage[tok] = {"plan_type": "pro", "rate_limit": {"primary_window": {"used_percent": 91, "limit_window_seconds": 18000, "reset_at": time.time() + 600},
                                                              "secondary_window": {"used_percent": 30, "limit_window_seconds": 604800}}}
        self.accts.remember("codex")
        row = self.accts.overview(["codex"])[0]["active"]
        self.assertEqual((row["short"], row["level"], row["windows"][1]["kind"]), ("91%", "warn", "weekly"))
        self.assertIn(("codex_usage", tok, "ws-9"), self.calls)

    def test_not_signed_in(self):
        o = self.accts.overview(usage=False)
        self.assertEqual([(e["engine"], e["signed_in"], e["accounts"]) for e in o], [("claude", False, []), ("codex", False, [])])

    def test_signed_in_but_not_saved_yet_shows_as_in_use(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        e = self.accts.overview(["claude"], usage=False)[0]
        self.assertTrue(e["signed_in"])
        self.assertEqual((e["active"]["email"], e["active"]["unsaved"]), ("a@x.com", True))
        self.assertEqual(self.calls, [])
        self.assertIsNone(self.kc.read(A.CLAUDE_SAVED_SERVICE, "x"))


class SignIn(Base):
    """Settings' Overview and Account pages say what the Agents page and the first-run wizard say: the engine's
    own word on its sign-in (task-pb21)."""

    def test_an_api_key_counts_as_signed_in_with_no_account_to_show(self):
        rows = self.accts.overview(["claude"], usage=False, sign_in=lambda e: "Signed in with an API key")
        self.assertEqual((rows[0]["signed_in"], rows[0]["sign_in"], rows[0]["accounts"], rows[0]["active"]),
                         (True, "Signed in with an API key", [], None))
        self.assertEqual(A.status_rows(rows)[0]["sign_in"], "Signed in with an API key")

    def test_the_engine_signed_out_wins_over_a_name_left_in_its_settings(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        self.assertTrue(self.accts.overview(["claude"], usage=False)[0]["signed_in"])
        rows = self.accts.overview(["claude"], usage=False, sign_in=lambda e: "Not signed in")
        self.assertEqual((rows[0]["signed_in"], rows[0]["sign_in"]), (False, "Not signed in"))

    def test_no_word_from_the_engine_keeps_what_the_settings_say(self):
        self.codex_signed_in(codex_auth("a@x.com", "user-a"))
        rows = self.accts.overview(["codex"], usage=False, sign_in=lambda e: "Sign-in unknown")
        self.assertEqual((rows[0]["signed_in"], rows[0]["sign_in"]), (True, "Signed in"))
        rows = self.accts.overview(["claude"], usage=False, sign_in=lambda e: "")
        self.assertEqual((rows[0]["signed_in"], rows[0]["sign_in"]), (False, "Not signed in"))

    def test_the_engine_is_asked_once_a_minute(self):
        engine_sign_in = ENGINE_SIGN_IN
        import onboarding
        import engines as E
        asked = []
        clock = [1000.0]
        with mock.patch.object(E, "which", lambda b: "/bin/" + b), \
                mock.patch.object(onboarding, "account_of", lambda e, p: asked.append((e, p)) or "Signed in · Max plan"):
            self.assertEqual(engine_sign_in("claude", clock=lambda: clock[0]), "Signed in · Max plan")
            clock[0] += 30
            self.assertEqual(engine_sign_in("claude", clock=lambda: clock[0]), "Signed in · Max plan")
            self.assertEqual(asked, [("claude", "/bin/claude")])
            clock[0] += 31
            engine_sign_in("claude", clock=lambda: clock[0])
            self.assertEqual(len(asked), 2)
        with mock.patch.object(E, "which", lambda b: None):
            self.assertEqual(engine_sign_in("codex"), "")


class Limits(Base):
    def claude_transcript(self, lines, sid="s-1"):
        d = os.path.join(self.home, ".claude", "projects", "-p")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, sid + ".jsonl"), "w") as f:
            for x in lines:
                f.write(json.dumps(x) + "\n")

    def iso(self, t):
        return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))

    def limit_line(self, t, text="You've hit your session limit · resets 7:40pm (Europe/Berlin)"):
        return {"type": "assistant", "isApiErrorMessage": True, "error": "rate_limit", "apiErrorStatus": 429, "sessionId": "s-1",
                "cwd": "/p", "timestamp": self.iso(t), "message": {"content": [{"type": "text", "text": text}]}}

    def test_claude_limit_is_found_with_the_account_to_switch_to(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        self.accts.remember("claude")
        full = self.save_claude("u-c", "c@x.com", "rt-c")
        b = self.save_claude("u-b", "b@x.com", "rt-b")
        A._write_private(A._p("usage", full + ".json"), json.dumps({"at": time.time(), "windows": [{"kind": "session", "used_percent": 100, "resets_at": time.time() + 900}]}))
        A._write_private(A._p("usage", b + ".json"), json.dumps({"at": time.time(), "windows": [{"kind": "session", "used_percent": 12}]}))
        now = time.time()
        self.claude_transcript([{"type": "user", "timestamp": self.iso(now - 60), "message": {"content": "go"}}, self.limit_line(now - 30)])
        ev = A.limits(since=now - 120, accts=self.accts)
        self.assertEqual(len(ev), 1)
        e = ev[0]
        self.assertEqual((e["engine"], e["session"], e["kind"], e["resets_text"]), ("claude", "s-1", "session", "7:40pm (Europe/Berlin)"))
        self.assertEqual(e["account"]["email"], "a@x.com")
        self.assertEqual(e["switch_to"]["email"], "b@x.com", "not the full one")
        self.assertEqual(e["message"], "Claude stopped: a@x.com used up its 5-hour allowance until 19:40.")

    def test_going_on_after_the_limit_clears_it(self):
        now = time.time()
        self.claude_transcript([self.limit_line(now - 50), {"type": "user", "timestamp": self.iso(now - 10), "message": {"content": "continue"}}])
        self.assertEqual(A.limits(since=now - 120, accts=self.accts), [])

    def test_claim_reports_each_stop_once(self):
        now = time.time()
        self.claude_transcript([self.limit_line(now - 30, "You've hit your weekly limit · resets 8am (Europe/Berlin)")])
        first = A.limits(since=now - 120, claim=True, accts=self.accts)
        self.assertEqual([e["kind"] for e in first], ["weekly"])
        self.assertEqual(first[0]["message"], "Claude stopped: this account used up its weekly allowance until 08:00.")
        self.assertIsNone(first[0]["switch_to"])
        self.assertEqual(A.limits(since=now - 120, claim=True, accts=self.accts), [])

    def test_old_stops_are_not_offered(self):
        now = time.time()
        self.claude_transcript([self.limit_line(now - 2 * A.LIMITS_LOOKBACK)])
        self.assertEqual(A.limits(since=0, accts=self.accts), [])

    def test_codex_limit(self):
        now = time.time()
        d = os.path.join(self.home, ".codex", "sessions", "2026", "10", "01")
        os.makedirs(d)
        sid = "01a0ea9c-2304-7241-bceb-4af162a0513d"
        with open(os.path.join(d, "rollout-2026-10-01T10-00-00-%s.jsonl" % sid), "w") as f:
            f.write(json.dumps({"type": "session_meta", "payload": {"id": sid, "cwd": "/w"}}) + "\n")
            f.write(json.dumps({"timestamp": self.iso(now - 20), "type": "event_msg", "payload": {"type": "task_complete", "error": {
                "message": "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 6th, 2026 3:21 AM.",
                "codex_error_info": "usage_limit_exceeded"}}}) + "\n")
        ev = A.limits(since=now - 120, accts=self.accts)
        self.assertEqual([(e["engine"], e["session"], e["cwd"], e["resets_text"]) for e in ev], [("codex", sid, "/w", "Oct 6th, 2026 3:21 AM")])


class LimitOffer(Base):
    """The offer after a stop: which account, whether Dispatch can let the session go on by itself."""
    claude_transcript, iso, limit_line = Limits.claude_transcript, Limits.iso, Limits.limit_line

    def setUp(self):
        super().setUp()
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        self.accts.remember("claude")
        self.b = self.save_claude("u-b", "b@x.com", "rt-b")

    def test_model_limit_names_the_model(self):
        now = time.time()
        self.claude_transcript([self.limit_line(now - 30, "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.")])
        e = A.limits(since=now - 120, accts=self.accts)[0]
        self.assertEqual((e["kind"], e["model"]), ("weekly_model", "Fable"))
        self.assertEqual(e["message"], "Claude stopped: a@x.com used up its weekly Fable allowance.")
        self.assertEqual(e["switch_to"]["email"], "b@x.com")

    def test_held_says_whether_chatd_has_the_session(self):
        now = time.time()
        self.claude_transcript([self.limit_line(now - 30)])
        with mock.patch.object(A, "held_sessions", lambda: {"claude-code:s-1"}):
            self.assertTrue(A.limits(since=now - 120, accts=self.accts)[0]["held"])
        with mock.patch.object(A, "held_sessions", lambda: set()):
            self.assertFalse(A.limits(since=now - 120, accts=self.accts)[0]["held"])

    def test_continue_switches_and_sends_when_chatd_holds_it(self):
        sent = []
        with mock.patch.object(A, "held_sessions", lambda: {"claude-code:s-1"}):
            r = self.accts.continue_after_limit("claude", "s-1", send=lambda e, sid: sent.append((e, sid)))
        self.assertEqual((r["account"]["email"], r["changed"], r["continued"]), ("b@x.com", True, True))
        self.assertEqual(sent, [("claude", "s-1")])
        self.assertEqual(self.claude_live(), claude_blob("rt-b"))
        self.assertEqual(A.generation("claude"), 1)

    def test_continue_only_switches_a_session_held_elsewhere(self):
        sent = []
        with mock.patch.object(A, "held_sessions", lambda: set()):
            r = self.accts.continue_after_limit("claude", "s-1", send=lambda e, sid: sent.append(1))
        self.assertEqual((r["changed"], r["continued"], sent), (True, False, []))

    def test_continue_without_another_account(self):
        self.accts.remove("claude", "b@x.com")
        with self.assertRaises(A.UserError) as cm:
            self.accts.continue_after_limit("claude", "s-1")
        self.assertIn("no other Claude account", str(cm.exception))

    def test_a_refused_message_is_said_plainly(self):
        with mock.patch.object(A, "held_sessions", lambda: {"claude-code:s-1"}):
            r = self.accts.continue_after_limit("claude", "s-1", send=lambda e, sid: "The session did not take the message. Send one there to go on.")
        self.assertEqual((r["changed"], r["continued"]), (True, False))
        self.assertIn("Send one there", r["note"])

    def test_watch_reports_usage_and_each_new_stop_once(self):
        now = time.time()
        A._write_private(A._p("usage", A.find(A.load(), "claude", "a@x.com")["id"] + ".json"),
                         json.dumps({"at": now, "windows": [{"kind": "session", "used_percent": 86, "resets_at": now + 3600}, {"kind": "weekly", "used_percent": 20}]}))
        self.claude_transcript([self.limit_line(now - 30)])
        ns = argparse.Namespace(accounts_cmd="watch", engine=None, target=None, json=True, since=None)
        outs = []
        for _ in range(2):
            out = io.StringIO()
            with contextlib.redirect_stdout(out), mock.patch.object(A, "Accounts", lambda: self.accts):
                self.assertEqual(A.command(ns), 0)
            outs.append(json.loads(out.getvalue()))
        claude = outs[0]["engines"][0]
        self.assertEqual((claude["level"], claude["short"], claude["account"]["email"]), ("warn", "86%", "a@x.com"))
        self.assertTrue(claude["resets"])
        self.assertEqual([w["kind"] for w in claude["windows"]], ["session", "weekly"])
        self.assertEqual(len(outs[0]["limits"]), 1)
        self.assertEqual(outs[1]["limits"], [])


class PlainReset(unittest.TestCase):
    def test_the_engines_words_become_the_title_bars(self):
        self.assertEqual(A.plain_reset("7:40pm (Europe/Berlin)"), "19:40")
        self.assertEqual(A.plain_reset("8am (Europe/Berlin)"), "08:00")
        self.assertEqual(A.plain_reset("12:05 AM"), "00:05")
        self.assertEqual(A.plain_reset("Oct 5th, 2026 11:10 PM"), "Oct 5 23:10")
        self.assertEqual(A.plain_reset("tomorrow (UTC)"), "tomorrow")
        self.assertEqual(A.plain_reset(""), "")


class QuotaAgrees(Base):
    """`dispatch quota` (the phone's Home) reads the account in use the way the title bar does."""

    def test_quota_row_is_the_account_in_use(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        self.usage["at-rt-a"] = {"five_hour": {"utilization": 41, "resets_at": "2026-10-01T18:00:00Z"}, "seven_day": {"utilization": 12}}
        self.assertIsNone(A.quota_row("claude", self.accts), "not saved yet: quota keeps reading on its own")
        self.accts.remember("claude")
        row = A.quota_row("claude", self.accts)
        self.assertEqual(row["agent"], "claude-code")
        self.assertEqual([(w["label"], w["kind"], w["used_percent"]) for w in row["windows"]], [("5h", "session", 41.0), ("Weekly", "weekly", 12.0)])
        status = A.status_rows(self.accts.overview(["claude"]))[0]
        self.assertEqual([w["used_percent"] for w in status["windows"]], [w["used_percent"] for w in row["windows"]])

    def test_numbers_from_before_a_switch_are_not_used(self):
        import dispatch as D
        self.codex_signed_in(codex_auth("c@x.com", "user-c"))
        d = os.path.join(self.home, ".codex", "sessions", "2026", "10", "01")
        os.makedirs(d)
        with open(os.path.join(d, "rollout-x.jsonl"), "w") as f:
            f.write(json.dumps({"timestamp": "2026-10-01T08:00:00.000Z", "type": "event_msg", "payload": {"type": "token_count", "rate_limits": {
                "primary": {"used_percent": 70, "window_minutes": 300}}}}) + "\n")
        with mock.patch.object(D, "HOME", self.home):
            self.assertEqual(D.E.get("codex").own_quota()["windows"][0]["used_percent"], 70)
            A.bump("codex", "codex-x", now=A._iso_epoch("2026-10-01T09:00:00Z"))
            self.assertEqual(D.E.get("codex").own_quota()["windows"], [])


class Safety(Base):
    def test_the_real_keychain_is_refused_in_tests(self):
        os.environ["TESTKIT_SESSION"] = os.environ.get("TESTKIT_SESSION") or "x"
        kc = A.Keychain("")
        with mock.patch.object(A.subprocess, "run") as run:
            with self.assertRaises(RuntimeError):
                kc.read("s", "a")
            with self.assertRaises(RuntimeError):
                kc.write("s", "a", "secret")
            run.assert_not_called()

    def test_secret_goes_over_stdin_not_the_command_line(self):
        kc = A.Keychain("")
        with mock.patch.object(kc, "_guard"), mock.patch.object(A.subprocess, "run") as run:
            run.return_value = mock.Mock(returncode=0, stderr="")
            kc.write("svc", "acct", "top-secret")
        argv, kw = run.call_args[0][0], run.call_args[1]
        self.assertEqual(argv, ["security", "-i"])
        self.assertNotIn("top-secret", " ".join(argv))
        self.assertIn("top-secret".encode().hex(), kw["input"])

    def test_commands_never_print_a_token(self):
        self.claude_signed_in(claude_blob("rt-a"), oauth_account("u-a", "a@x.com"))
        self.save_claude("u-b", "b@x.com", "rt-b")
        self.codex_signed_in(codex_auth("c@x.com", "user-c"))
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(A, "Accounts", lambda: self.accts):
            for cmd, engine, target in (("use", "claude", "b@x.com"), ("list", None, None), ("status", None, None), ("remember", "codex", None)):
                ns = argparse.Namespace(accounts_cmd=cmd, engine=engine, target=target, json=True, label="", use=False, since=None, claim=False, no_usage=False)
                self.assertEqual(A.command(ns), 0)
        text = out.getvalue()
        for secret in ("rt-a", "rt-b", "at-rt", "rt-user-c", json.loads(codex_auth("c@x.com", "user-c"))["tokens"]["access_token"]):
            self.assertNotIn(secret, text)
        self.assertNotIn('"rt"', text)
        self.assertNotIn("blob_sha", text)

    def test_errors_are_plain_json(self):
        out = io.StringIO()
        ns = argparse.Namespace(accounts_cmd="use", engine="claude", target="nobody", json=True, label="", use=False, since=None, claim=False, no_usage=False)
        with contextlib.redirect_stdout(out):
            self.assertEqual(A.command(ns), 1)
        self.assertEqual(json.loads(out.getvalue()), {"ok": False, "error": "account", "message": 'No saved Claude account called "nobody".'})


if __name__ == "__main__":
    unittest.main()
