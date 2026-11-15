# -*- coding: utf-8 -*-
"""Ask once, politely, for a star on GitHub (the way Orca's star-nag does, src/main/star-nag, MIT; nothing copied).

Only after Dispatch has been in use for a while: at least DAYS days since this Mac first ran it and SESSIONS agent
sessions with a reply since then. Only once the repository is public (open source): until then GitHub answers 404
and nothing is asked; that check runs at most once a day. Someone who already starred it (the `gh` command, when it
is signed in, says so) is never asked. Only once: the first window to claim the question shows it, whatever the
answer, it is never shown again.

  dispatch star [--json]            where it stands: asked, due, why not yet
  dispatch star check [--json]      the same, after looking at GitHub when it is time to (the app calls this)
  dispatch star claim [--json]      this window shows the question now: ok only for the first one ever
  dispatch star answer open|later   what the person did (kept for the record; it is not asked again either way)

State: <DISPATCH_DIR>/star.json {first_seen, asked_at, answer, public, public_checked_at, starred}.
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = "SchaeferAnjon/dispatch"
URL = f"https://github.com/{REPO}"
DAYS = 7           # in use at least this long
SESSIONS = 10      # and this many sessions with a reply since then
RECHECK = 24 * 3600


def _dispatch():
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import dispatch as D
    return D


def path(D=None):
    D = D or _dispatch()
    return os.path.join(D.DISPATCH_DIR, "star.json")


def load(p):
    try:
        with open(p, encoding="utf-8") as f:
            s = json.load(f)
        return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def save(p, s):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = f"{p}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f)
    os.replace(tmp, p)


def sessions_since(index, since):
    """Agent sessions (not sub-agents) that got at least one reply after `since`."""
    n = 0
    for r in (index or {}).values():
        if not isinstance(r, dict) or r.get("subagent") or not r.get("assistant_msgs"):
            continue
        if float(r.get("mtime") or 0) >= since:
            n += 1
    return n


def public_repo(timeout=5):
    """True when the repository is public, False when GitHub says it is not there (private), None when it could not
    be asked (offline)."""
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}", headers={"Accept": "application/vnd.github+json", "User-Agent": "dispatch-star"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8") or "{}")
        return data.get("private") is False
    except urllib.error.HTTPError as e:
        return False if e.code in (403, 404) else None
    except (OSError, ValueError):
        return None


def starred_already():
    """The person starred it already, as far as a signed-in `gh` can tell (None when it cannot)."""
    gh = shutil.which("gh")
    if not gh:
        return None
    try:
        r = subprocess.run([gh, "api", f"user/starred/{REPO}", "--silent"], capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode == 0:
        return True
    return False if b"404" in (r.stderr or b"") else None


def state(s, sessions, now):
    """{asked, due, why, days, sessions, url}: whether the question is due, from the stored state alone."""
    first = float(s.get("first_seen") or now)
    days = (now - first) / 86400
    out = {"asked": bool(s.get("asked_at")), "answer": s.get("answer", ""), "days": round(days, 1), "sessions": sessions, "url": URL}
    if s.get("asked_at"):
        why = "asked already"
    elif s.get("starred"):
        why = "starred already"
    elif days < DAYS:
        why = f"in use {days:.0f} of {DAYS} days"
    elif sessions < SESSIONS:
        why = f"{sessions} of {SESSIONS} sessions"
    elif s.get("public") is not True:
        why = "not open source yet"
    else:
        why = ""
    out.update(due=not why, why=why or "due")
    return out


def check(p, index_fn, now=None, public_fn=public_repo, starred_fn=starred_already):
    """Look at GitHub when everything else says it is time (at most once a day), then answer like `state`."""
    now = now or time.time()
    s = load(p)
    changed = False
    if not s.get("first_seen"):
        s["first_seen"] = now
        changed = True
    n = sessions_since(index_fn(), float(s["first_seen"]))
    pre = state({**s, "public": True}, n, now)
    if pre["due"] and now - float(s.get("public_checked_at") or 0) >= RECHECK:
        pub = public_fn()
        if pub is not None:
            s["public"], s["public_checked_at"] = pub, now
            changed = True
            if pub and starred_fn() is True:
                s["starred"] = True
    if changed:
        save(p, s)
    return state(s, n, now)


def claim(p, now=None):
    """The one window that shows the question: ok once, ever (an exclusive lock file decides between windows)."""
    lock = p + ".claim"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return False
    except OSError:
        return False
    os.close(fd)
    s = load(p)
    if s.get("asked_at"):
        return False
    s["asked_at"] = now or time.time()
    s.setdefault("answer", "shown")
    save(p, s)
    return True


def answer(p, what):
    s = load(p)
    s.setdefault("asked_at", time.time())
    s["answer"] = what
    save(p, s)
    return s


def command(a):
    D = _dispatch()
    p = path(D)
    op = getattr(a, "op", "status") or "status"
    if op == "check":
        res = check(p, D.load_index)
    elif op == "claim":
        res = {"ok": claim(p), "url": URL}
    elif op == "answer":
        what = getattr(a, "what", "") or ""
        if what not in ("open", "later"):
            print("dispatch star answer open|later", file=sys.stderr)
            return 2
        res = {"ok": True, **answer(p, what)}
    else:
        s = load(p)
        try:
            n = sessions_since(D.load_index(), float(s.get("first_seen") or time.time()))
        except Exception:  # noqa: BLE001
            n = 0
        res = state(s, n, time.time())
    if getattr(a, "json", False):
        print(json.dumps(res, ensure_ascii=False))
    elif op == "claim":
        print("show it now" if res["ok"] else "already asked")
    elif op == "answer":
        print(f"noted: {res['answer']}")
    else:
        print(("due: ask for a star on " + URL) if res.get("due") else f"not now: {res.get('why')}")
    return 0
