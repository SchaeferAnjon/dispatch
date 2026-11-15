# -*- coding: utf-8 -*-
"""`dispatch accounts`: several Claude Code and Codex sign-ins on this Mac, one of each in use, switched in one step.

When one account runs out of its allowance, the person switches to another one without signing in again. Each engine
keeps its own login where it always does, and Dispatch only swaps what is in that one place:

- Claude Code keeps its login in the macOS keychain ("Claude Code-credentials"; ~/.claude/.credentials.json on other
  systems) and the account's name in ~/.claude.json (`oauthAccount`). A saved account's login waits in the keychain
  under "Dispatch Claude Code accounts" (one item per account), its name in accounts.json.
- Codex keeps its login in ~/.codex/auth.json. A saved account's copy waits in ~/.dispatch/accounts/codex/<id>/auth.json
  (owner-only permissions, like Codex's own file).

Switching first saves the login that is in use now (it is the freshest copy of that account: the engines rotate their
refresh tokens in place), then puts the chosen account's login in its place, reads it back, and bumps a counter in
switched.json. New sessions start on the new account. Sessions Dispatch runs (chatd, the Agents window) restart their
engine on the next message so it continues on the new account; a session run elsewhere keeps the account it started
with until it restarts.

Adding an account signs in inside a temporary folder (CLAUDE_CONFIG_DIR / CODEX_HOME), so the account in use stays
signed in; the new login is moved into Dispatch's store and the temporary one is removed.

Tokens never go to stdout, logs, the board or git: commands print names and numbers only, and keychain writes go
through `security -i` on stdin (never on a command line other processes can read).

How the logins are kept apart and swapped (the keychain service names, the per-folder suffix Claude Code 2.1 uses,
the keychain user name rule, signing in inside a temporary folder, the Codex usage endpoint and its headers) is
ported from Orca's account switcher (https://github.com/stablyai/orca, src/main/claude-accounts/,
src/main/codex-accounts/, src/main/rate-limits/), which is under the MIT License:

    MIT License

    Copyright (c) 2026 Lovecast Inc.

    Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
    associated documentation files (the "Software"), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
    following conditions:

    The above copyright notice and this permission notice shall be included in all copies or substantial
    portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
    LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
    EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
    IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
    USE OR OTHER DEALINGS IN THE SOFTWARE.
"""
import base64
import contextlib
import datetime
import getpass
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.parse
import urllib.request
import uuid

import dispatch_dir
import dplatform as P
import engines as E

WARN_AT = 80          # percent: the title bar turns to a warning
USAGE_TTL = 300       # seconds between usage calls per account (the window polls every minute)
LIMITS_LOOKBACK = 3600  # a limit older than this is not offered any more
LIMIT_SEEN_KEEP = 2 * 86400
CONTINUE_TEXT = "Continue where you left off."

CLAUDE_LIVE_SERVICE = "Claude Code-credentials"
CLAUDE_SAVED_SERVICE = "Dispatch Claude Code accounts"
CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"
CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
_KEYCHAIN_USER_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_SAFE_ID = re.compile(r"^[a-z]+-[0-9a-f]{8}$")


class UserError(Exception):
    """Something the person can act on; the message is shown as is."""


# ---------------------------------------------------------------- places

def root():
    return dispatch_dir.path("accounts")


def _p(*parts):
    return os.path.join(root(), *parts)


def home():
    return os.path.expanduser("~")


def claude_config_dir():
    """CLAUDE_CONFIG_DIR when the person set one (Claude Code then keeps everything there), else None."""
    v = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    return os.path.expanduser(v) if v else None


def claude_global_config():
    d = claude_config_dir()
    return os.path.join(d, ".claude.json") if d else os.path.join(home(), ".claude.json")


def claude_credentials_file(config_dir=None):
    return os.path.join(config_dir or claude_config_dir() or os.path.join(home(), ".claude"), ".credentials.json")


def codex_home():
    v = os.environ.get("CODEX_HOME", "").strip()
    return os.path.expanduser(v) if v else os.path.join(home(), ".codex")


def quota_dir():
    """dispatch.py's QUOTA_DIR (the account-agnostic caches `dispatch quota` keeps)."""
    return os.path.join(os.environ.get("DISPATCH_DIR") or os.path.join(home(), "tasks", ".dispatch"), "quota")


def claude_live_service(config_dir=None):
    """Claude Code 2.1+ keeps the login of a CLAUDE_CONFIG_DIR under its own item: the service name gets the first 8
    hex digits of sha256(NFC(dir)) (Orca keychain.ts getActiveClaudeService)."""
    if not config_dir:
        return CLAUDE_LIVE_SERVICE
    return "%s-%s" % (CLAUDE_LIVE_SERVICE, hashlib.sha256(unicodedata.normalize("NFC", config_dir).encode("utf-8")).hexdigest()[:8])


def keychain_user():
    """The keychain account Claude Code files its item under: $USER, or claude-code-user when the name has characters
    Claude Code 2.1 refuses (SSO names like first@example.com; Orca keychain.ts getKeychainUser)."""
    try:
        user = os.environ.get("USER") or os.environ.get("USERNAME") or getpass.getuser()
    except Exception:
        return "claude-code-user"
    return user if _KEYCHAIN_USER_RE.match(user or "") else "claude-code-user"


def _sha(text):
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def _write_private(path, text):
    """Owner-only file, written whole or not at all."""
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, 0o600)
        P.replace_retry(tmp, path)
    except Exception:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (FileNotFoundError, NotADirectoryError):
        return None


def _load_json(path, default):
    raw = _read(path)
    if raw is None:
        return default
    try:
        v = json.loads(raw)
    except ValueError:
        return default
    return v if isinstance(v, type(default)) else default


# ---------------------------------------------------------------- keychain

class KeychainError(UserError):
    pass


class Keychain:
    """The login keychain through /usr/bin/security. With DISPATCH_FAKE_KEYCHAIN=<folder> (test instances, other
    systems) every item is a file in that folder instead, and the real keychain is never asked."""

    def __init__(self, fake_dir=None):
        self.fake = fake_dir if fake_dir is not None else (os.environ.get("DISPATCH_FAKE_KEYCHAIN") or None)

    @property
    def available(self):
        return bool(self.fake) or sys.platform == "darwin"

    def _file(self, service, account):
        q = lambda s: urllib.parse.quote(s, safe="")
        return os.path.join(self.fake, q(service), q(account))

    def _guard(self):
        if os.environ.get("TESTKIT_SESSION"):
            raise RuntimeError("the test suite must not touch the real keychain (set DISPATCH_FAKE_KEYCHAIN)")

    def read(self, service, account):
        if self.fake:
            return _read(self._file(service, account))
        self._guard()
        try:
            r = subprocess.run(["security", "find-generic-password", "-s", service, "-a", account, "-w"],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            raise KeychainError("The keychain did not answer. Unlock your Mac's keychain and try again.")
        if r.returncode == 0:
            return r.stdout.rstrip("\n") or None
        if r.returncode == 44:
            return None
        raise KeychainError("Dispatch could not read the sign-in from the keychain. If macOS asked for access, choose Allow and try again.")

    def write(self, service, account, secret):
        if '"' in service or '"' in account or "\n" in service or "\n" in account:
            raise ValueError("unsafe keychain name")
        if self.fake:
            _write_private(self._file(service, account), secret)
            return
        self._guard()
        line = 'add-generic-password -U -a "%s" -s "%s" -X "%s"\n' % (account, service, secret.encode("utf-8").hex())
        try:
            r = subprocess.run(["security", "-i"], input=line, capture_output=True, text=True, timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            raise KeychainError("The keychain did not answer. Unlock your Mac's keychain and try again.")
        if r.returncode != 0 or "error" in (r.stderr or "").lower():
            raise KeychainError("Dispatch could not save the sign-in in the keychain. If macOS asked for access, choose Allow and try again.")

    def delete(self, service, account):
        if self.fake:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(self._file(service, account))
            return
        self._guard()
        with contextlib.suppress(OSError, subprocess.TimeoutExpired):
            subprocess.run(["security", "delete-generic-password", "-s", service, "-a", account],
                           capture_output=True, text=True, timeout=15)


# ---------------------------------------------------------------- where each engine's login lives

class Vault:
    """Reads and writes the live login of each engine and the saved copies. Tests pass their own keychain."""

    def __init__(self, keychain=None):
        self.kc = keychain or Keychain()

    # Claude
    def claude_live_read(self, config_dir=None):
        if self.kc.available:
            v = self.kc.read(claude_live_service(config_dir or claude_config_dir()), keychain_user())
            if v or not os.path.exists(claude_credentials_file(config_dir)):
                return v
        return _read(claude_credentials_file(config_dir))

    def claude_live_write(self, blob, config_dir=None):
        if self.kc.available:
            self.kc.write(claude_live_service(config_dir or claude_config_dir()), keychain_user(), blob)
        else:
            _write_private(claude_credentials_file(config_dir), blob)

    def claude_live_delete(self, config_dir=None):
        if self.kc.available:
            self.kc.delete(claude_live_service(config_dir or claude_config_dir()), keychain_user())
        with contextlib.suppress(FileNotFoundError):
            os.unlink(claude_credentials_file(config_dir))

    # Codex
    def codex_live_path(self, home_dir=None):
        return os.path.join(home_dir or codex_home(), "auth.json")

    def codex_live_read(self, home_dir=None):
        return _read(self.codex_live_path(home_dir))

    def codex_live_write(self, blob, home_dir=None):
        _write_private(self.codex_live_path(home_dir), blob)

    # any engine Dispatch keeps accounts of (its Login says where)
    def live_read(self, engine):
        return login_of(engine, self).live_read()

    def live_write(self, engine, blob):
        return login_of(engine, self).live_write(blob)

    def live_restore(self, engine, blob):
        """Put back what was there before a failed switch (nothing, if nothing was)."""
        if blob is not None:
            self.live_write(engine, blob)
        else:
            login_of(engine, self).live_delete()

    def saved_read(self, engine, aid):
        lg = login_of(engine, self)
        if lg.saved_keychain():
            return self.kc.read(lg.saved_service, aid)
        return _read(_p(engine, aid, lg.saved_file))

    def saved_write(self, engine, aid, blob):
        lg = login_of(engine, self)
        if lg.saved_keychain():
            self.kc.write(lg.saved_service, aid, blob)
        else:
            _write_private(_p(engine, aid, lg.saved_file), blob)

    def saved_delete(self, engine, aid):
        lg = login_of(engine, self)
        if lg.saved_keychain():
            self.kc.delete(lg.saved_service, aid)
        shutil.rmtree(_p(engine, aid), ignore_errors=True)


# ---------------------------------------------------------------- what is inside a login

def _jwt_payload(token):
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        v = json.loads(base64.urlsafe_b64decode(part.encode("ascii")))
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def _json(blob):
    try:
        v = json.loads(blob or "")
        return v if isinstance(v, dict) else {}
    except ValueError:
        return {}


def claude_oauth(blob):
    return _json(blob).get("claudeAiOauth") or {}


def claude_blob_dead(blob):
    """Claude Code clears both tokens when the server refused the refresh token (invalid_grant)."""
    o = claude_oauth(blob)
    return not o.get("accessToken") and not o.get("refreshToken")


def claude_access_token(blob):
    o = claude_oauth(blob)
    tok, exp = o.get("accessToken"), (o.get("expiresAt") or 0) / 1000
    return tok if tok and exp > time.time() + 60 else None


def claude_identity_from_oauth_account(oa):
    """~/.claude.json's oauthAccount → who this is."""
    oa = oa if isinstance(oa, dict) else {}
    return {"uuid": oa.get("accountUuid") or "", "email": oa.get("emailAddress") or "", "org": oa.get("organizationUuid") or "",
            "org_name": oa.get("organizationName") or "", "oauth_account": oa or None}


def claude_identity_from_profile(p):
    """/api/oauth/profile → who this is (only the fields ~/.claude.json keeps too)."""
    acct, org = (p.get("account") or {}), (p.get("organization") or {})
    oa = {"accountUuid": acct.get("uuid") or "", "emailAddress": acct.get("email") or acct.get("email_address") or "",
          "organizationUuid": org.get("uuid") or "", "organizationName": org.get("name") or "",
          "displayName": acct.get("display_name") or acct.get("full_name") or ""}
    return claude_identity_from_oauth_account({k: v for k, v in oa.items() if v})


def claude_live_oauth_account(config_dir=None):
    path = os.path.join(config_dir, ".claude.json") if config_dir else claude_global_config()
    return _load_json(path, {}).get("oauthAccount") or None


def codex_identity(blob):
    """auth.json → who this is: the ChatGPT user, workspace and plan from the id token, or an API key's fingerprint."""
    d = _json(blob)
    toks = d.get("tokens") or {}
    if toks.get("id_token"):
        pl = _jwt_payload(toks["id_token"])
        auth = pl.get("https://api.openai.com/auth") or {}
        user = auth.get("chatgpt_user_id") or auth.get("user_id") or pl.get("sub") or pl.get("email") or ""
        ws = toks.get("account_id") or auth.get("chatgpt_account_id") or ""
        return {"uuid": user, "email": pl.get("email") or "", "org": ws, "org_name": "", "plan": auth.get("chatgpt_plan_type") or "", "kind": "chatgpt"}
    if d.get("OPENAI_API_KEY"):
        return {"uuid": "apikey-" + _sha(d["OPENAI_API_KEY"])[:12], "email": "", "org": "", "org_name": "", "plan": "", "kind": "apikey"}
    return None


def codex_access(blob):
    toks = _json(blob).get("tokens") or {}
    tok = toks.get("access_token")
    if not tok:
        return None, None
    exp = _jwt_payload(tok).get("exp") or 0
    if exp and exp < time.time() + 60:
        return None, None
    return tok, toks.get("account_id") or None


def identity_key(ident):
    return "%s|%s" % (ident.get("uuid") or ident.get("email") or "", ident.get("org") or "")


def codex_keeps_login_in_keyring():
    """Codex can be told to keep its login in the system keyring; then there is no auth.json to swap."""
    raw = _read(os.path.join(codex_home(), "config.toml")) or ""
    m = re.search(r'^\s*cli_auth_credentials_store\s*=\s*"([a-z]+)"', raw, re.M)
    return bool(m and m.group(1) == "keyring")


# ---------------------------------------------------------------- the store

def _empty():
    return {"version": 1, "accounts": [], "last_written": {}}


def load():
    st = _load_json(_p("accounts.json"), _empty())
    st.setdefault("accounts", [])
    st.setdefault("last_written", {})
    return st


def save(st):
    _write_private(_p("accounts.json"), json.dumps(st, ensure_ascii=False, indent=2))


@contextlib.contextmanager
def locked():
    """One change at a time (two windows, chatd and a terminal may all ask)."""
    os.makedirs(root(), exist_ok=True)
    path = _p(".lock")
    if P.IS_WIN:
        yield
        return
    import fcntl
    with open(path, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def accounts_of(st, engine):
    return [a for a in st["accounts"] if a.get("engine") == engine]


def by_id(st, aid):
    return next((a for a in st["accounts"] if a.get("id") == aid), None)


def find(st, engine, target):
    """An account by id, email or label (case does not matter)."""
    t = (target or "").strip().lower()
    for a in accounts_of(st, engine):
        if t in ((a.get("id") or "").lower(), (a.get("email") or "").lower(), (a.get("label") or "").lower()):
            return a
    return None


def display_name(a):
    return (a or {}).get("label") or (a or {}).get("email") or ("API key" if (a or {}).get("kind") == "apikey" else "this account")


def _new_id(engine):
    return "%s-%s" % (engine, uuid.uuid4().hex[:8])


def _record(st, engine, ident, blob):
    """The account `ident` names, created when it is new; its name and plan refreshed from the login."""
    key = identity_key(ident)
    a = next((x for x in accounts_of(st, engine) if x.get("key") == key), None)
    if a is None:
        a = {"id": _new_id(engine), "engine": engine, "key": key, "label": "", "added_at": time.time()}
        st["accounts"].append(a)
    a["email"] = ident.get("email") or a.get("email") or ""
    if ident.get("org_name"):
        a["org_name"] = ident["org_name"]
    login_of(engine).record(a, ident, blob)
    a["blob_sha"] = _sha(blob)
    a["needs_signin"] = False
    return a


# ---------------------------------------------------------------- who is signed in now

def _fetch_json(url, headers, timeout=10):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


def fetch_claude_profile(token):
    url = os.environ.get("DISPATCH_CLAUDE_PROFILE_URL") or CLAUDE_PROFILE_URL
    return _fetch_json(url, {"Authorization": "Bearer " + token, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "dispatch-cli"})


# ---------------------------------------------------------------- what differs per engine (its adapter's accounts_driver)

class Login:
    """One engine's sign-ins as Dispatch keeps them: where the live login is, what is inside it, how a new one is made,
    how its limits are read. The engines whose accounts Dispatch switches name their class in engines/<id>.py."""
    engine = ""
    saved_file = ""          # the saved copy's file name under accounts/<engine>/<id>/
    saved_service = ""       # the keychain service of the saved copies, when they live there (saved_keychain)

    def __init__(self, vault):
        self.vault = vault

    def live_read(self, where=None):
        raise NotImplementedError

    def live_write(self, blob):
        raise NotImplementedError

    def live_delete(self, where=None):
        raise NotImplementedError

    def saved_keychain(self):
        """Its saved copies live in the keychain (else in files)."""
        return False

    def identity(self, st, blob, profile):
        """(identity, saved account or None) of the login `blob`."""
        raise NotImplementedError

    def record(self, a, ident, blob):
        """Fill what the account row keeps of the login (its plan, ...)."""

    def dead(self, blob):
        """The engine itself gave this login up (signed out by its maker)."""
        return False

    def current(self, st):
        """(identity, saved account or None) of the login in use, without asking the keychain."""
        raise NotImplementedError

    def refuse_switch(self):
        """Raise UserError when this Mac's setup keeps Dispatch from switching it."""

    def before_switch(self):
        """What to put back when a switch fails (besides the login itself)."""
        return None

    def after_write(self, a):
        """The login of account `a` was just written: tell the engine whose it is."""

    def undo_switch(self, saved):
        """A switch failed: put back what before_switch kept."""

    def after_switch(self):
        """A switch went through."""

    def sign_in_new(self, tmp, env, run, profile):
        """Run its own sign-in into the temporary folder `tmp`: (exit code, login blob, identity)."""
        raise NotImplementedError

    def usage(self, blob, accts):
        """(windows, plan) of the login `blob` from its maker's usage service, (None, None) when not readable."""
        return None, None

    def keyring(self):
        """Its login sits in the system keyring where Dispatch cannot swap it."""
        return False

    def limits(self, since, now):
        """Its sessions that stopped on a usage limit since `since`."""
        return []


class ClaudeLogin(Login):
    engine = "claude"
    saved_file = ".credentials.json"
    saved_service = CLAUDE_SAVED_SERVICE

    def live_read(self, where=None):
        return self.vault.claude_live_read(where)

    def live_write(self, blob):
        self.vault.claude_live_write(blob)

    def live_delete(self, where=None):
        self.vault.claude_live_delete(where)

    def saved_keychain(self):
        return self.vault.kc.available

    def identity(self, st, blob, profile):
        # Claude's login carries no name, so the copy Dispatch itself wrote, then a saved copy with the same refresh
        # token, then Anthropic's profile, then ~/.claude.json say whose it is, in that order
        lw = (st.get("last_written") or {}).get(self.engine) or {}
        if lw.get("sha") and lw["sha"] == _sha(blob):
            a = by_id(st, lw.get("id"))
            if a:
                return claude_identity_from_oauth_account(a.get("oauth_account") or {"emailAddress": a.get("email")}), a
        rt = claude_oauth(blob).get("refreshToken")
        if rt:
            fp = _sha(rt)[:16]
            a = next((x for x in accounts_of(st, self.engine) if x.get("rt") == fp), None)
            if a:
                return claude_identity_from_oauth_account(a.get("oauth_account") or {"emailAddress": a.get("email")}), a
        ident = None
        tok = claude_access_token(blob)
        if tok:
            try:
                ident = claude_identity_from_profile(profile(tok))
            except Exception:
                ident = None
        if not ident or not (ident.get("uuid") or ident.get("email")):
            ident = claude_identity_from_oauth_account(claude_live_oauth_account())
        if not (ident.get("uuid") or ident.get("email")):
            return None, None
        key = identity_key(ident)
        return ident, next((a for a in accounts_of(st, self.engine) if a.get("key") == key), None)

    def record(self, a, ident, blob):
        o = claude_oauth(blob)
        a["plan"] = o.get("subscriptionType") or a.get("plan") or ""
        if ident.get("oauth_account"):
            a["oauth_account"] = ident["oauth_account"]
        a["rt"] = _sha(o.get("refreshToken") or "")[:16]

    def dead(self, blob):
        return claude_blob_dead(blob)

    def current(self, st):
        lw = (st.get("last_written") or {}).get(self.engine) or {}
        ident = claude_identity_from_oauth_account(claude_live_oauth_account())
        if not (ident.get("uuid") or ident.get("email")):
            return None, None
        if lw.get("id"):
            a = by_id(st, lw["id"])
            if a and a.get("key") == identity_key(ident):
                return ident, a
        key = identity_key(ident)
        return ident, next((a for a in accounts_of(st, self.engine) if a.get("key") == key), None)

    def before_switch(self):
        return _read(claude_global_config())

    def after_write(self, a):
        set_claude_oauth_account(a.get("oauth_account") or {"emailAddress": a.get("email") or ""})

    def undo_switch(self, saved):
        if saved is not None:
            with contextlib.suppress(Exception):
                _write_private(claude_global_config(), saved)

    def after_switch(self):
        # `dispatch quota` keeps one account-less cache: it belonged to the old account
        with contextlib.suppress(FileNotFoundError):
            os.unlink(os.path.join(quota_dir(), "claude-usage.json"))

    def sign_in_new(self, tmp, env, run, profile):
        env.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
        env["CLAUDE_CONFIG_DIR"] = tmp
        before = self.vault.claude_live_read()
        rc = run([claude_bin(), "auth", "login", "--claudeai"], env)
        blob = self.vault.claude_live_read(tmp)
        ident = claude_identity_from_oauth_account(claude_live_oauth_account(tmp))
        if blob and not (ident.get("uuid") or ident.get("email")):
            tok = claude_access_token(blob)
            with contextlib.suppress(Exception):
                ident = claude_identity_from_profile(profile(tok)) if tok else ident
        with contextlib.suppress(Exception):
            self.vault.claude_live_delete(tmp)
        # an older Claude Code writes the unscoped item too: the account in use must stay the one in use
        if self.vault.claude_live_read() != before:
            self.vault.live_restore(self.engine, before)
        return rc, blob, ident

    def usage(self, blob, accts):
        tok = claude_access_token(blob)
        return (claude_windows(accts.claude_usage_fetch(tok)), None) if tok else (None, None)

    def limits(self, since, now):
        return _claude_limits(since, now)


class CodexLogin(Login):
    engine = "codex"
    saved_file = "auth.json"

    def live_read(self, where=None):
        return self.vault.codex_live_read(where)

    def live_write(self, blob):
        self.vault.codex_live_write(blob)

    def live_delete(self, where=None):
        with contextlib.suppress(FileNotFoundError):
            os.unlink(self.vault.codex_live_path(where))

    def identity(self, st, blob, profile):
        ident = codex_identity(blob)
        if not ident:
            return None, None
        key = identity_key(ident)
        return ident, next((a for a in accounts_of(st, self.engine) if a.get("key") == key), None)

    def record(self, a, ident, blob):
        a["plan"] = ident.get("plan") or a.get("plan") or ""
        a["kind"] = ident.get("kind") or "chatgpt"

    def current(self, st):
        ident = codex_identity(self.vault.codex_live_read() or "")
        if not ident:
            return None, None
        key = identity_key(ident)
        return ident, next((a for a in accounts_of(st, self.engine) if a.get("key") == key), None)

    def refuse_switch(self):
        if codex_keeps_login_in_keyring():
            raise UserError("Codex keeps its sign-in in the system keychain on this Mac, so Dispatch cannot switch it. "
                            "Remove cli_auth_credentials_store = \"keyring\" from Codex's settings to switch accounts here.")

    def sign_in_new(self, tmp, env, run, profile):
        env["CODEX_HOME"] = tmp
        rc = run([codex_bin(), "login", "-c", 'cli_auth_credentials_store="file"'], env)
        blob = self.vault.codex_live_read(tmp)
        return rc, blob, codex_identity(blob or "")

    def usage(self, blob, accts):
        tok, ws = codex_access(blob)
        return codex_windows(accts.codex_usage_fetch(tok, ws)) if tok else (None, None)

    def keyring(self):
        return codex_keeps_login_in_keyring()

    def limits(self, since, now):
        return _codex_limits(since, now)


def login_of(engine, vault=None):
    """The Login of an engine whose sign-ins Dispatch keeps; UserError for any other."""
    eng = E.find(engine)
    if not eng or not eng.accounts_driver:
        raise UserError("Dispatch keeps no accounts of %s." % (eng.name if eng else engine))
    import importlib
    mod, cls = eng.accounts_driver
    return getattr(importlib.import_module(mod), cls)(vault or Vault())


def account_engines():
    """The ids of the engines whose sign-ins Dispatch keeps and switches (claude, codex)."""
    return tuple(e.id for e in E.known() if e.accounts_driver)



class Accounts:
    """Everything that reads or changes the saved accounts. `vault` and `net` are swapped out in tests."""

    def __init__(self, vault=None, profile=None, claude_usage=None, codex_usage=None, clock=time.time):
        self.vault = vault or Vault()
        self.profile = profile or fetch_claude_profile
        self.claude_usage_fetch = claude_usage or fetch_claude_usage
        self.codex_usage_fetch = codex_usage or fetch_codex_usage
        self.clock = clock

    # -- the live login
    def live_identity(self, engine, st, blob):
        """(identity, saved account or None) of the login in use (its Login knows how to tell whose it is)."""
        if not blob:
            return None, None
        return login_of(engine, self.vault).identity(st, blob, self.profile)

    def remember_live(self, engine, st):
        """Save the login in use as an account (or refresh its saved copy). Returns the account, or None when
        nobody is signed in. A login the engine itself gave up on is marked, not saved."""
        blob = self.vault.live_read(engine)
        if not blob:
            return None
        ident, a = self.live_identity(engine, st, blob)
        if not ident:
            return None
        if login_of(engine, self.vault).dead(blob):
            if a:
                a["needs_signin"] = True
            return a
        a = _record(st, engine, ident, blob)
        self.vault.saved_write(engine, a["id"], blob)
        st["last_written"][engine] = {"id": a["id"], "sha": _sha(blob), "at": self.clock()}
        return a

    def current(self, engine, st):
        """The saved account in use now, without touching the keychain (name only: ~/.claude.json, auth.json)."""
        return login_of(engine, self.vault).current(st)

    # -- switching
    def use(self, engine, target):
        lg = login_of(engine, self.vault)
        lg.refuse_switch()
        with locked():
            st = load()
            a = find(st, engine, target)
            if not a:
                raise UserError("No saved %s account called \"%s\"." % (E.get(engine).short_name, target))
            live = self.remember_live(engine, st)
            if live and live["id"] == a["id"]:
                save(st)
                return {"engine": engine, "changed": False, "account": public(a), "previous": None}
            blob = self.vault.saved_read(engine, a["id"])
            if not blob:
                a["needs_signin"] = True
                save(st)
                raise UserError("Dispatch no longer has the sign-in for %s. Sign in to it again." % display_name(a))
            if lg.dead(blob):
                a["needs_signin"] = True
                save(st)
                raise UserError("%s was signed out by %s. Sign in to it again." % (display_name(a), E.get(engine).maker or "its maker"))
            before = self.vault.live_read(engine)
            before_cfg = lg.before_switch()
            try:
                self.vault.live_write(engine, blob)
                lg.after_write(a)
                if self.vault.live_read(engine) != blob:
                    raise UserError("The new sign-in did not stick. Nothing was changed.")
            except Exception:
                with contextlib.suppress(Exception):
                    self.vault.live_restore(engine, before)
                lg.undo_switch(before_cfg)
                raise
            now = self.clock()
            st["last_written"][engine] = {"id": a["id"], "sha": _sha(blob), "at": now}
            a["used_at"] = now
            save(st)
            bump(engine, a["id"], now)
            lg.after_switch()
            return {"engine": engine, "changed": True, "account": public(a), "previous": public(live) if live else None}

    def remove(self, engine, target):
        with locked():
            st = load()
            a = find(st, engine, target)
            if not a:
                raise UserError("No saved %s account called \"%s\"." % (E.get(engine).short_name, target))
            _, cur = self.current(engine, st)
            if cur and cur["id"] == a["id"]:
                raise UserError("%s is in use. Switch to another account first." % display_name(a))
            self.vault.saved_delete(engine, a["id"])
            st["accounts"] = [x for x in st["accounts"] if x.get("id") != a["id"]]
            for k, lw in list(st["last_written"].items()):
                if lw.get("id") == a["id"]:
                    del st["last_written"][k]
            save(st)
            with contextlib.suppress(FileNotFoundError):
                os.unlink(_p("usage", a["id"] + ".json"))
            return {"engine": engine, "removed": public(a)}

    def rename(self, engine, target, label):
        with locked():
            st = load()
            a = find(st, engine, target)
            if not a:
                raise UserError("No saved %s account called \"%s\"." % (E.get(engine).short_name, target))
            a["label"] = (label or "").strip()[:40]
            save(st)
            return public(a)

    def remember(self, engine):
        """Save the account in use now, so it can be switched back to later."""
        with locked():
            st = load()
            a = self.remember_live(engine, st)
            save(st)
            return public(a) if a else None

    def continue_after_limit(self, engine, session, to=None, send=None):
        """"Switch to <other account> and continue?": switch, then, when Dispatch itself holds that session
        (chatd), send it "Continue." so it picks up on the new account. A session held elsewhere (a terminal,
        the Agents window) goes on with the next message the person sends there."""
        st = load()
        _, cur = self.current(engine, st)
        a = find(st, engine, to) if to else best_other(st, engine, cur)
        if not a:
            raise UserError("There is no other %s account to switch to. Add one first." % E.get(engine).short_name)
        r = self.use(engine, a["id"])
        res = {"engine": engine, "session": session, "account": r["account"], "changed": r["changed"], "continued": False}
        if "%s:%s" % (E.agent_of(engine), session) in held_sessions() and send is not None:
            note = send(engine, session)
            res["continued"] = note is None
            if note:
                res["note"] = note
        return res

    # -- adding
    def add(self, engine, label="", use=False, run=None):
        """Sign in to another account without signing out of the one in use: the engine's own login runs in a
        temporary folder, its result moves into Dispatch's store. `run(argv, env)` runs the login in the
        terminal (stdin and stdout are the person's) and returns its exit code."""
        run = run or _run_attached
        with locked():
            st = load()
            with contextlib.suppress(UserError):
                self.remember_live(engine, st)
            save(st)
        tmp = os.path.realpath(tempfile.mkdtemp(prefix="dispatch-%s-login-" % engine))
        env = dict(os.environ)
        try:
            rc, blob, ident = login_of(engine, self.vault).sign_in_new(tmp, env, run, self.profile)
            if not blob or not ident or not (ident.get("uuid") or ident.get("email")):
                raise UserError("The sign-in did not finish, so no account was added." + (" (exit code %s)" % rc if rc else ""))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        with locked():
            st = load()
            known = next((x for x in accounts_of(st, engine) if x.get("key") == identity_key(ident)), None)
            a = _record(st, engine, ident, blob)
            if label:
                a["label"] = label.strip()[:40]
            self.vault.saved_write(engine, a["id"], blob)
            save(st)
        res = {"engine": engine, "account": public(a), "again": bool(known), "used": False}
        if use:
            self.use(engine, a["id"])
            res["used"] = True
        return res

    # -- usage
    def usage_of(self, engine, a, blob_for, force=False):
        """The account's limit windows, from the per-account cache when it is younger than USAGE_TTL.
        `blob_for()` gives the login to ask with (only called when a fresh answer is needed)."""
        path = _p("usage", a["id"] + ".json")
        cached = _load_json(path, {})
        now = self.clock()
        if cached and not force and now - (cached.get("at") or 0) < USAGE_TTL:
            return cached
        try:
            blob = blob_for()
        except UserError:
            blob = None
        windows, plan = None, None
        if blob:
            try:
                windows, plan = login_of(engine, self.vault).usage(blob, self)
            except Exception:
                windows = None
        if windows is None:
            return cached or {}
        d = {"at": now, "windows": windows}
        if plan:
            d["plan"] = plan
        with contextlib.suppress(OSError):
            _write_private(path, json.dumps(d))
        return d

    def overview(self, engines=None, usage=True, fallback=None, sign_in=None):
        """Every engine: its accounts (the one in use first), each with its limit windows and a plain line.
        `sign_in(engine)` is the engine's own word on its sign-in (engine_sign_in): when it gives one, `signed_in`
        and `sign_in` follow it, so Settings says what the Agents page and the first-run wizard say (someone on an
        API key is signed in, with no saved account and no allowance to show)."""
        st = load()
        res = []
        for engine in engines or account_engines():
            ident, cur = self.current(engine, st)
            rows = []
            if cur is None and ident:
                # signed in, but Dispatch has not saved this account yet: it still shows as the one in use
                cur = {"id": "", "engine": engine, "email": ident.get("email") or "", "label": "", "plan": ident.get("plan") or "",
                       "kind": ident.get("kind") or "", "unsaved": True}
            for a in ([cur] if cur else []) + [x for x in accounts_of(st, engine) if not cur or x.get("id") != cur.get("id")]:
                active = a is cur
                u = {}
                if usage and a.get("id"):
                    blob_for = (lambda e=engine: self.vault.live_read(e)) if active else (lambda e=engine, i=a["id"]: self.vault.saved_read(e, i))
                    u = self.usage_of(engine, a, blob_for)
                elif usage and active and fallback:
                    u = fallback(engine) or {}
                windows = u.get("windows") or []
                if active and not windows and fallback and a.get("id"):
                    u = fallback(engine) or u
                    windows = u.get("windows") or []
                row = public(a)
                windows = [dict(w, resets=when(w.get("resets_at"), self.clock())) for w in windows]
                row.update({"active": active, "windows": windows, "usage_at": u.get("at")})
                if u.get("plan") and not row.get("plan"):
                    row["plan"] = u["plan"]
                row.update(summarize(engine, windows, self.clock()))
                rows.append(row)
            phrase = sign_in(engine) if sign_in else ""
            signed = sign_in_says(phrase)
            res.append({"engine": engine, "name": E.get(engine).short_name, "signed_in": bool(cur) if signed is None else signed,
                        "sign_in": phrase if signed is not None else ("Signed in" if cur else "Not signed in"), "accounts": rows,
                        "active": rows[0] if cur else None, "keyring": login_of(engine, self.vault).keyring()})
        return res


SIGN_IN_TTL = 60


def sign_in_says(phrase):
    """True / False from the engine's own phrase ("Signed in · Max plan", "Signed in with an API key", "Not signed
    in"), None when it says nothing either way ("Sign-in unknown", not installed)."""
    if phrase.startswith("Signed in"):
        return True
    if phrase == "Not signed in":
        return False
    return None


def engine_sign_in(engine, clock=time.time):
    """The engine's own word on its sign-in (`claude auth status`, `codex login status`): the same phrase the Agents
    page and the first-run wizard show (onboarding.account_of). Kept a minute, since the title bar asks every few
    seconds; "" when the engine is not on this Mac."""
    path = _p("sign-in.json")
    cache = _load_json(path, {})
    hit = cache.get(engine) or {}
    now = clock()
    if isinstance(hit, dict) and "phrase" in hit and 0 <= now - (hit.get("at") or 0) < SIGN_IN_TTL:
        return hit["phrase"]
    try:
        import onboarding
        eng = E.find(engine)
        exe = E.which(eng.bin) if eng else None
        phrase = onboarding.account_of(engine, exe) if exe else ""
    except Exception:
        return ""
    cache[engine] = {"at": now, "phrase": phrase}
    with contextlib.suppress(OSError):
        os.makedirs(root(), exist_ok=True)
        _write_private(path, json.dumps(cache))
    return phrase


def public(a):
    """An account as commands print it: names and numbers, never a token or a fingerprint."""
    if not a:
        return None
    keep = ("id", "engine", "email", "label", "plan", "org_name", "kind", "added_at", "used_at", "needs_signin", "unsaved")
    d = {k: a.get(k) for k in keep if a.get(k) not in (None, "")}
    d["name"] = display_name(a)
    d.setdefault("needs_signin", False)
    return d


def set_claude_oauth_account(oa):
    """Name the account in ~/.claude.json the way Claude Code's own /login does (every other key stays)."""
    path = claude_global_config()
    cfg = _load_json(path, {})
    cfg["oauthAccount"] = oa
    _write_private(path, json.dumps(cfg, ensure_ascii=False, indent=2))


def claude_bin():
    for c in (os.path.join(home(), ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"):
        if os.access(c, os.X_OK):
            return c
    return shutil.which("claude") or "claude"


def codex_bin():
    return shutil.which("codex") or next((c for c in ("/opt/homebrew/bin/codex", "/usr/local/bin/codex") if os.access(c, os.X_OK)), "codex")


def _run_attached(argv, env):
    try:
        return subprocess.call(argv, env=env)
    except FileNotFoundError:
        eng = E.by_bin(os.path.basename(argv[0]))
        raise UserError("%s is not installed on this Mac." % (eng.name if eng else os.path.basename(argv[0])))


# ---------------------------------------------------------------- switched.json: what sessions watch

def switched():
    return _load_json(_p("switched.json"), {})


_GEN_CACHE = {}


def generation(engine):
    """A number that changes every time `engine`'s account is switched (0 before the first switch). chatd and the
    Agents window compare it with the number their engine started under. chatd asks on every tick: the file is
    read again only when it changed."""
    path = _p("switched.json")
    try:
        st = os.stat(path)
        stamp = (path, st.st_mtime_ns, st.st_size)
    except OSError:
        return 0
    if _GEN_CACHE.get("stamp") != stamp:
        _GEN_CACHE.update(stamp=stamp, data=switched())
    return int((_GEN_CACHE["data"].get(engine) or {}).get("gen") or 0)


def bump(engine, aid, now=None):
    d = switched()
    e = d.get(engine) or {}
    d[engine] = {"gen": int(e.get("gen") or 0) + 1, "at": now or time.time(), "to": aid}
    _write_private(_p("switched.json"), json.dumps(d))


# ---------------------------------------------------------------- usage

def fetch_claude_usage(token):
    url = os.environ.get("DISPATCH_CLAUDE_USAGE_URL") or CLAUDE_USAGE_URL
    return _fetch_json(url, {"Authorization": "Bearer " + token, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "dispatch-cli"})


def fetch_codex_usage(token, workspace):
    url = os.environ.get("DISPATCH_CODEX_USAGE_URL") or CODEX_USAGE_URL
    h = {"Authorization": "Bearer " + token, "User-Agent": "codex-cli", "OpenAI-Beta": "codex-1", "originator": "Codex Desktop"}
    if workspace:
        h["ChatGPT-Account-Id"] = workspace
    return _fetch_json(url, h)


def _iso_epoch(s):
    if not s:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    try:
        return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def claude_windows(d):
    """Anthropic's usage answer → windows (the same mapping as `dispatch quota`)."""
    wins = []
    for lim in (d or {}).get("limits") or []:
        if lim.get("percent") is None:
            continue
        kind = lim.get("kind")
        model = ((lim.get("scope") or {}).get("model") or {}).get("display_name")
        k = {"session": "session", "weekly_all": "weekly", "weekly_scoped": "weekly_model"}.get(kind)
        if not k:
            continue
        w = {"kind": k, "used_percent": float(lim["percent"]), "resets_at": _iso_epoch(lim.get("resets_at"))}
        if k == "weekly_model" and model:
            w["model"] = model
        wins.append(w)
    if not wins:  # the older answer shape: five_hour / seven_day utilization
        for key, k in (("five_hour", "session"), ("seven_day", "weekly")):
            w = (d or {}).get(key) or {}
            if w.get("utilization") is not None:
                wins.append({"kind": k, "used_percent": float(w["utilization"]), "resets_at": _iso_epoch(w.get("resets_at"))})
    return wins


def codex_windows(d):
    """ChatGPT's usage answer → (windows, plan)."""
    rl = (d or {}).get("rate_limit") or {}
    wins = []
    for key in ("primary_window", "secondary_window"):
        w = rl.get(key) or {}
        if w.get("used_percent") is None:
            continue
        secs = w.get("limit_window_seconds") or 0
        kind = "session" if secs and secs <= 6 * 3600 else "weekly" if secs >= 6 * 86400 else ("session" if key == "primary_window" else "weekly")
        wins.append({"kind": kind, "used_percent": float(w["used_percent"]), "resets_at": _iso_epoch(w.get("reset_at"))})
    return wins, (d or {}).get("plan_type") or ""


QUOTA_LABEL = {"session": "5h", "weekly": "Weekly"}


def quota_row(engine, accts=None):
    """The usage of the saved account in use, in `dispatch quota`'s row shape (the phone's Home and the title
    bar then show the same numbers), or None when no saved account is in use or it has no numbers."""
    accts = accts or Accounts()
    try:
        act = accts.overview([engine])[0]["active"]
    except Exception:
        return None
    if not act or not act.get("id") or not act.get("windows"):
        return None
    wins = []
    for w in act["windows"]:
        label = QUOTA_LABEL.get(w["kind"]) or "Weekly · %s" % (w.get("model") or "Model")
        wins.append({"label": label, "kind": w["kind"], "used_percent": w["used_percent"], "resets_at": w.get("resets_at")})
    return {"agent": E.agent_of(engine), "plan": act.get("plan") or "", "windows": wins, "updated_at": act.get("usage_at"),
            "source": "account", "account": act.get("name") or "", "note": ""}


def switched_at(engine):
    """When `engine`'s account was last switched (0 if never): readings older than this are the old account's."""
    return float((switched().get(engine) or {}).get("at") or 0)


def quota_windows(row):
    """A `dispatch quota` row's windows in this module's shape (the fallback when no account usage could be read)."""
    wins = []
    for w in (row or {}).get("windows") or []:
        if w.get("used_percent") is None:
            continue
        k = w.get("kind") or {"5h": "session", "Weekly": "weekly"}.get(w.get("label"), "weekly_model")
        x = {"kind": k, "used_percent": float(w["used_percent"]), "resets_at": w.get("resets_at")}
        if k == "weekly_model" and "·" in (w.get("label") or ""):
            x["model"] = w["label"].split("·")[-1].strip()
        wins.append(x)
    return wins


def when(epoch, now=None):
    """A reset time the way people say it: 18:00 today, Mon 08:00 this week, Oct 6 later."""
    if not epoch:
        return ""
    now = now or time.time()
    t, n = datetime.datetime.fromtimestamp(epoch), datetime.datetime.fromtimestamp(now)
    if t.date() == n.date():
        return t.strftime("%H:%M")
    if 0 < (t.date() - n.date()).days < 7:
        return t.strftime("%a %H:%M")
    return "%s %d" % (t.strftime("%b"), t.day)


def window_words(w):
    k = w.get("kind")
    if k == "session":
        return "this 5-hour allowance"
    if k == "weekly":
        return "this week's allowance"
    return "this week's %s allowance" % w["model"] if w.get("model") else "this week's model allowance"


def summarize(engine, windows, now=None):
    """The tightest window of an account, its level (ok / warn / out) and the line the title bar shows."""
    now = now or time.time()
    live = [w for w in windows if w.get("used_percent") is not None and not (w.get("resets_at") and w["resets_at"] < now)]
    if not live:
        return {"top": None, "level": "unknown", "line": "", "short": "", "resets": ""}
    top = max(live, key=lambda w: (w["used_percent"], w.get("kind") == "session"))
    pct = max(0, min(100, int(round(top["used_percent"]))))
    resets = when(top.get("resets_at"), now)
    tail = ", resets %s" % resets if resets else ""
    if pct >= 100:
        line = "%s: %s is used up%s" % (E.get(engine).short_name, window_words(top), tail)
        level = "out"
    else:
        line = "%s: %d%% of %s used%s" % (E.get(engine).short_name, pct, window_words(top), tail)
        level = "warn" if pct >= WARN_AT else "ok"
    return {"top": dict(top, used_percent=pct), "level": level, "line": line, "short": "%d%%" % pct, "resets": resets}


# ---------------------------------------------------------------- limits a session ran into

_CLAUDE_LIMIT_KIND = (("session limit", "session"), ("5-hour limit", "session"), ("weekly limit", "weekly"), ("opus limit", "weekly_model"))
_CLAUDE_MODEL_LIMIT = re.compile(r"(?:reached|hit) your (\w+) limit", re.I)  # "You've reached your Fable limit."


def _tail_lines(path, size=262144):
    try:
        with open(path, "rb") as f:
            f.seek(max(0, os.path.getsize(path) - size))
            return f.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return []


def _claude_limits(since, now):
    base = os.path.join(claude_config_dir() or os.path.join(home(), ".claude"), "projects")
    out = []
    for path in glob.glob(os.path.join(base, "*", "*.jsonl")):
        try:
            if os.path.getmtime(path) < since:
                continue
        except OSError:
            continue
        last = None
        for line in _tail_lines(path):
            if '"rate_limit"' not in line and '"type":"user"' not in line and '"type": "user"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            at = _iso_epoch(d.get("timestamp")) or 0
            if d.get("type") == "user" and not d.get("isMeta"):
                if last and at >= last["at"]:
                    last = None  # the person went on after the limit: nothing to offer any more
                continue
            if d.get("error") == "rate_limit" and d.get("isApiErrorMessage"):
                text = "".join(c.get("text") or "" for c in ((d.get("message") or {}).get("content") or []) if isinstance(c, dict))
                low = text.lower()
                kind = next((k for words, k in _CLAUDE_LIMIT_KIND if words in low), "usage")
                mm = _CLAUDE_MODEL_LIMIT.search(text)
                model = ""
                if kind == "usage" and mm and mm.group(1).lower() not in ("usage", "session", "weekly", "rate"):
                    kind, model = "weekly_model", mm.group(1)
                m = re.search(r"resets\s+(.+?)\s*$", text)
                last = {"engine": "claude", "session": d.get("sessionId") or os.path.splitext(os.path.basename(path))[0],
                        "cwd": d.get("cwd") or "", "at": at, "kind": kind, "text": text.strip(), "resets_text": m.group(1) if m else ""}
                if model:
                    last["model"] = model
        if last and since <= last["at"] and now - last["at"] < LIMITS_LOOKBACK:
            out.append(last)
    return out


def _codex_limits(since, now):
    out = []
    for path in glob.glob(os.path.join(codex_home(), "sessions", "*", "*", "*", "rollout-*.jsonl")):
        try:
            if os.path.getmtime(path) < since:
                continue
        except OSError:
            continue
        sid, cwd, last = "", "", None
        m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$", path)
        sid = m.group(1) if m else ""
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                meta = json.loads(f.readline() or "{}")
            p = meta.get("payload") or {}
            sid, cwd = p.get("id") or sid, p.get("cwd") or ""
        except (OSError, ValueError):
            pass
        for line in _tail_lines(path):
            if "usage_limit_exceeded" not in line and '"user_message"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            p = d.get("payload") or {}
            at = _iso_epoch(d.get("timestamp")) or 0
            if p.get("type") == "user_message":
                if last and at >= last["at"]:
                    last = None
                continue
            err = p.get("error") if isinstance(p.get("error"), dict) else {}
            if err.get("codex_error_info") == "usage_limit_exceeded" or p.get("codex_error_info") == "usage_limit_exceeded":
                text = err.get("message") or p.get("message") or "You've hit your usage limit."
                mm = re.search(r"try again at\s+(.+?)\.?\s*$", text)
                last = {"engine": "codex", "session": sid, "cwd": cwd, "at": at, "kind": "usage", "text": text.strip(),
                        "resets_text": mm.group(1) if mm else ""}
        if last and since <= last["at"] and now - last["at"] < LIMITS_LOOKBACK:
            out.append(last)
    return out


def limits(since=None, claim=False, now=None, st=None, accts=None):
    """Sessions that stopped on a usage limit since `since`, newest first, each with the account it ran on and the
    best other account to switch to. `claim`: each one is returned once across every caller (both windows ask)."""
    now = now or time.time()
    since = max(since or 0, now - LIMITS_LOOKBACK)
    events = sorted((e for engine in account_engines() for e in login_of(engine).limits(since, now)), key=lambda e: -e["at"])
    if not events:
        return []
    accts = accts or Accounts()
    st = st or load()
    if claim:
        with locked():
            seen = {k: v for k, v in _load_json(_p("limits-seen.json"), {}).items() if now - v < LIMIT_SEEN_KEEP}
            fresh = []
            for e in events:
                k = "%s:%s:%d" % (e["engine"], e["session"], int(e["at"]))
                if k not in seen:
                    seen[k] = now
                    fresh.append(e)
            _write_private(_p("limits-seen.json"), json.dumps(seen))
        events = fresh
    held = held_sessions()
    for e in events:
        _, cur = accts.current(e["engine"], st)
        e["account"] = public(cur) if cur else None
        e["switch_to"] = public(best_other(st, e["engine"], cur, now))
        e["held"] = "%s:%s" % (E.agent_of(e["engine"]), e["session"]) in held
        e["message"] = limit_message(e)
    return events


def held_sessions():
    """Session keys the running chatd holds (`claude-code:<id>`): those Dispatch can continue by itself."""
    try:
        import chatd
        reg = chatd.read_registry(os.environ.get("DISPATCH_DIR") or os.path.join(home(), "tasks", ".dispatch"))
    except Exception:
        return set()
    return set((reg or {}).get("sessions") or {})


def best_other(st, engine, cur, now=None):
    """The saved account to switch to: not the one in use, still signed in, with the most allowance left."""
    now = now or time.time()
    best, best_used = None, None
    for a in accounts_of(st, engine):
        if (cur and a.get("id") == cur.get("id")) or a.get("needs_signin"):
            continue
        u = _load_json(_p("usage", a["id"] + ".json"), {})
        top = summarize(engine, u.get("windows") or [], now).get("top")
        used = top["used_percent"] if top else 50  # unknown: after accounts known to have room, before full ones
        if used >= 100:
            continue
        if best is None or used < best_used:
            best, best_used = a, used
    return best


_MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split()


def plain_reset(text):
    """The engines' own reset words → the way the title bar says times: "9:10pm (Europe/Berlin)" → 21:10,
    "Oct 5th, 2026 11:10 PM" → Oct 5 23:10. Unknown shapes stay as they are, without a time zone in brackets."""
    t = (text or "").strip()
    if not t:
        return ""
    m = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b", t, re.I)
    hm = ""
    if m:
        h = int(m.group(1)) % 12 + (12 if m.group(3).lower() == "p" else 0)
        hm = "%02d:%s" % (h, m.group(2) or "00")
    d = re.search(r"\b(%s)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b" % "|".join(_MONTHS), t, re.I)
    if hm and d:
        return "%s %d %s" % (d.group(1).capitalize(), int(d.group(2)), hm)
    if hm:
        return hm
    return re.sub(r"\s*\([^)]*\)", "", t)


def limit_message(e):
    """One sentence: who stopped, which allowance, until when. The notification's button offers the switch."""
    name = E.get(e["engine"]).short_name
    who = (e.get("account") or {}).get("name") or "this account"
    what = {"session": "5-hour allowance", "weekly": "weekly allowance",
            "weekly_model": "weekly %s allowance" % e["model"] if e.get("model") else "weekly model allowance"}.get(e.get("kind"), "allowance")
    until = plain_reset(e.get("resets_text"))
    return "%s stopped: %s used up its %s%s." % (name, who, what, " until %s" % until if until else "")


# ---------------------------------------------------------------- command line

def _text_overview(rows):
    for e in rows:
        if not e["accounts"]:
            print("%s: %s" % (e["name"], (e.get("sign_in") or ("Signed in" if e["signed_in"] else "Not signed in")).lower()))
            continue
        for a in e["accounts"]:
            mark = "*" if a["active"] else " "
            extra = " (needs sign-in)" if a.get("needs_signin") else " (not saved yet)" if a.get("unsaved") else ""
            print("%s %-6s %-30s %-8s %s%s" % (mark, e["name"], a["name"], a.get("plan") or "", a.get("line") or "", extra))


def status_rows(rows):
    """overview() → one row per engine: the account in use, its windows and plain line, the others in short."""
    out = []
    for e in rows:
        act_row = e["active"] or {}
        out.append({"engine": e["engine"], "name": e["name"], "signed_in": e["signed_in"], "sign_in": e.get("sign_in") or "",
                    "account": {k: act_row.get(k) for k in ("id", "name", "email", "plan", "needs_signin", "unsaved")} if act_row else None,
                    "windows": act_row.get("windows") or [], "usage_at": act_row.get("usage_at"), "top": act_row.get("top"),
                    "level": act_row.get("level") or "unknown", "line": act_row.get("line") or "", "short": act_row.get("short") or "",
                    "resets": act_row.get("resets") or "",
                    "others": [{k: x.get(k) for k in ("id", "name", "short", "level", "needs_signin", "top")} for x in e["accounts"][1:]]})
    return out


def command(a, d=None):
    """`dispatch accounts …`. Returns the exit code."""
    act = a.accounts_cmd or "list"
    as_json = getattr(a, "json", False)
    accts = Accounts()

    def fallback(engine):
        """The numbers `dispatch quota` reads itself (Claude Code's status line, Codex's own logs), when the
        account's usage could not be asked; never ones from before the last switch."""
        if d is None:
            return {}
        try:
            row = E.get(engine).own_quota()
        except Exception:
            return {}
        return {"windows": quota_windows(row), "at": row.get("updated_at")}

    def emit(obj, text):
        if as_json:
            print(json.dumps(obj, ensure_ascii=False, indent=2))
        else:
            text(obj)

    engines = [a.engine] if getattr(a, "engine", None) in account_engines() else list(account_engines())
    try:
        if act in ("use", "add", "remove", "rename") and getattr(a, "engine", None) not in account_engines():
            raise UserError("Say which engine: claude or codex.")
        if act == "continue" and (getattr(a, "engine", None) not in account_engines() or not getattr(a, "target", None)):
            raise UserError("Say which engine and which session: dispatch accounts continue claude <session id>.")
        if act in ("use", "remove", "rename") and not getattr(a, "target", None):
            raise UserError("Say which account: its email, its name or its id (dispatch accounts list shows them).")
        if act == "list":
            emit(accts.overview(engines, usage=not getattr(a, "no_usage", False), fallback=fallback, sign_in=engine_sign_in), _text_overview)
        elif act == "status":
            emit(status_rows(accts.overview(engines, fallback=fallback, sign_in=engine_sign_in)),
                 lambda o: [print(x["line"] or "%s: %s" % (x["name"], "no usage numbers yet" if x["signed_in"] else "not signed in")) for x in o])
        elif act == "watch":
            # what the title bar asks every few seconds: the usage of the accounts in use and the sessions that
            # stopped on a limit since the last ask (each one once)
            res = {"engines": status_rows(accts.overview(engines, fallback=fallback, sign_in=engine_sign_in)),
                   "limits": limits(since=getattr(a, "since", None), claim=True, accts=accts)}
            emit(res, lambda r: [print(x["line"] or x["name"]) for x in r["engines"]] + [print(x["message"]) for x in r["limits"]])
        elif act == "use":
            r = accts.use(a.engine, a.target)
            emit(r, lambda r: print(("Now using %s for %s. New sessions use it; running ones switch on their next message."
                                     if r["changed"] else "%s is already in use for %s.") % (r["account"]["name"], E.get(r["engine"]).short_name)))
        elif act == "add":
            r = accts.add(a.engine, label=getattr(a, "label", "") or "", use=getattr(a, "use", False))
            emit(r, lambda r: print("%s %s for %s.%s" % ("Signed in again to" if r["again"] else "Added", r["account"]["name"], E.get(r["engine"]).short_name,
                                                           " It is in use now." if r["used"] else " Switch to it any time from the account menu.")))
        elif act == "remove":
            r = accts.remove(a.engine, a.target)
            emit(r, lambda r: print("Removed %s. Its sign-in is gone from this Mac." % r["removed"]["name"]))
        elif act == "rename":
            r = accts.rename(a.engine, a.target, a.label)
            emit(r, lambda r: print("Renamed to %s." % r["name"]))
        elif act == "remember":
            r = {"engine": a.engine, "account": None}
            for e in engines:
                r = {"engine": e, "account": accts.remember(e)}
            emit(r, lambda r: print("Saved %s." % r["account"]["name"] if r["account"] else "Nobody is signed in."))
        elif act == "limits":
            ev = limits(since=getattr(a, "since", None), claim=getattr(a, "claim", False), accts=accts)
            emit(ev, lambda ev: [print(x["message"]) for x in ev] or (None if ev else print("No session has stopped on a limit lately.")))
        elif act == "continue":
            def send(engine, session):
                """None once chatd took "Continue.", else why not."""
                if d is None:
                    return "Dispatch is not running."
                import session_reply
                try:
                    ref = session_reply.exact_ref(d, session, E.agent_of(engine))
                    r = session_reply.submit(d, ref, CONTINUE_TEXT, str(uuid.uuid4()))
                except Exception:  # noqa: BLE001 - the switch itself went through
                    return "The session did not take the message. Send one there to go on."
                return None if (r or {}).get("state") == "accepted" else "The session did not take the message. Send one there to go on."
            r = accts.continue_after_limit(a.engine, a.target, to=getattr(a, "to", None) or None, send=send)
            emit(r, lambda r: print("Now using %s for %s.%s" % (r["account"]["name"], E.get(r["engine"]).short_name,
                                                                  " The session goes on." if r["continued"] else " Send a message in that session to go on.")))
        elif act == "generation":
            emit({e: generation(e) for e in engines}, lambda g: [print("%s %d" % kv) for kv in g.items()])
        else:
            raise UserError("Unknown action: %s" % act)
    except UserError as e:
        if as_json:
            print(json.dumps({"ok": False, "error": "account", "message": str(e)}, ensure_ascii=False))
        else:
            print(str(e), file=sys.stderr)
        return 1
    return 0

