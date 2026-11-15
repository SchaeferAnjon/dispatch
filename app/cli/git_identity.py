# -*- coding: utf-8 -*-
"""`dispatch git-identity [show | set --name N --email E] [--json]`: the name and email git puts on every commit made
on this Mac, asked of the person once instead of made up (task-pog4t).

On a new Mac git has neither. Agents then hit "unable to auto-detect email address" on their first commit and set one
themselves (`opencode <opencode@localhost>`, or the `Dispatch <dispatch@localhost>` Dispatch's own first commit of a new
project used): every commit after that carries a name nobody chose. So:

  show   what git has (global user.name / user.email), whether that is enough to commit, and a suggestion to offer the
         person: the name and email this Mac already knows them by (git's own if half set; the Claude Code or Codex
         account; the Mac's full user name; the GitHub account's no-reply address). A suggestion is never written by
         itself: the setup wizard and Settings › Agents › Commits show it and the person confirms or changes it.
  set    writes both into git's global settings (~/.gitconfig), the way `git config --global` would.

The session brief (`dispatch prime`) tells agents when git has no name yet: ask the person, never invent one.
"""
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

EMAIL = re.compile(r"^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$")
# what an agent or a tool makes up when it has nothing: never offered back as the person's
MADE_UP = re.compile(r"@localhost$|@(?:example|invalid|local)(?:\.|$)|\(none\)$|^(?:root|opencode|claude|codex|dispatch)@", re.I)


def _git(*args, cwd=None):
    try:
        r = subprocess.run(["git", *args], capture_output=True, text=True, timeout=10, cwd=cwd,
                           env=dict(os.environ, GIT_TERMINAL_PROMPT="0"))
        return r.returncode, (r.stdout or "").strip()
    except (OSError, subprocess.SubprocessError):
        return 1, ""


def configured(cwd=None):
    """(name, email) git uses for a commit made here: the folder's own settings, else the global ones ('' when none)."""
    args = (["config"] if cwd else ["config", "--global"])
    return _git(*args, "user.name", cwd=cwd)[1], _git(*args, "user.email", cwd=cwd)[1]


def known(cwd=None):
    name, email = configured(cwd)
    return bool(name.strip()) and bool(email.strip())


def _full_name():
    """The Mac's full name for the person using it (System Settings › Users & Groups)."""
    if sys.platform != "darwin":
        return ""
    try:
        r = subprocess.run(["id", "-F"], capture_output=True, text=True, timeout=5)
        return (r.stdout or "").strip() if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _accounts():
    """[(name, email, where)] of the accounts this Mac is signed in with, read from their files (no keychain, no network)."""
    out = []
    try:
        import accounts as A
        oa = A.claude_live_oauth_account() or {}
        if oa.get("emailAddress"):
            out.append((oa.get("displayName") or "", oa["emailAddress"], "your Claude account"))
        path = os.path.join(os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex"), "auth.json")
        if os.path.isfile(path):
            with open(path, "rb") as f:
                ident = A.codex_identity(f.read()) or {}
            if ident.get("email"):
                out.append(("", ident["email"], "your ChatGPT account"))
    except Exception:  # noqa: BLE001 - a suggestion is a nicety
        pass
    try:
        import me
        with open(me.gh_hosts_file(), encoding="utf-8") as f:
            login = me.login_from_hosts(f.read())
        if login:
            out.append((login, "%s@users.noreply.github.com" % login, "your GitHub account"))
    except (OSError, ImportError, AttributeError):
        pass
    return out


def suggest():
    """{name, email, from}: what to offer the person; '' for what nothing on this Mac says."""
    name, email = configured()
    if email and MADE_UP.search(email):
        name, email = (name if name.lower() not in ("opencode", "claude", "codex", "dispatch") else ""), ""  # an agent's
    where = "git" if (name or email) else ""
    accts = [a for a in _accounts() if EMAIL.match(a[1]) and not MADE_UP.search(a[1])]
    if not email and accts:
        email, where = accts[0][1], accts[0][2]
    if not name:
        name = next((a[0] for a in accts if a[0]), "") or _full_name()
    return {"name": name.strip(), "email": email.strip(), "from": where}


def brief_line(cwd=None):
    """The session brief's line when git cannot sign a commit in `cwd` yet ('' when it can): the agent asks the person,
    never makes a name up (task-pog4t: it wrote `opencode <opencode@localhost>` and committed)."""
    if known(cwd if cwd and os.path.isdir(cwd) else None):
        return ""
    s = suggest()
    from lang import t as _t
    offer = (_t(" This Mac knows them as %s <%s> (%s): offer that.", "这台 Mac 上记的是 %s <%s>（%s）：可以建议用这个。")
             % (s["name"] or "?", s["email"], s["from"] or _t("here", "这里"))) if s["email"] else ""
    return _t("Git on this Mac has no name and email for commits yet. Before the first commit, ask the person in plain words which "
              "name and email their commits should carry, then save them with `dispatch git-identity set --name \"…\" --email …` "
              "(or they add them in Settings › Agents › Commits)." + offer + " Never make one up, use an agent's name, or copy one from "
              "an earlier commit.",
              "这台 Mac 上的 git 还没有提交用的名字和邮箱。第一次提交前，用大白话问用户提交要署什么名字和邮箱，再用 "
              "`dispatch git-identity set --name \"…\" --email …` 存下（或者让用户在 Settings › Agents › Commits 里填）。" + offer +
              "绝不自己编一个、不用 Agent 的名字、不照抄以前提交里的名字。")


def show():
    name, email = configured()
    return {"ok": True, "name": name, "email": email, "known": bool(name and email), "suggest": suggest()}


def check(name, email):
    """The name and email as they will be written, or ValueError in words for the person."""
    name = " ".join((name or "").split())
    email = (email or "").strip()
    if not name:
        raise ValueError("Type the name your commits should carry.")
    if len(name) > 100 or re.search(r"[<>\n\r\x00]", name):
        raise ValueError("That name cannot be used: keep it under 100 characters, without < or >.")
    if not EMAIL.match(email) or len(email) > 200:
        raise ValueError("That does not look like an email address.")
    return name, email


def set_identity(name, email):
    name, email = check(name, email)
    for key, value in (("user.name", name), ("user.email", email)):
        code, _ = _git("config", "--global", key, value)
        if code:
            raise ValueError("Git could not save it. Check that your home folder can be written to.")
    return show()


def command(a):
    try:
        out = set_identity(a.name, a.email) if a.op == "set" else show()
    except ValueError as e:
        out = {"ok": False, "message": str(e)}
    if a.json:
        print(json.dumps(out, ensure_ascii=False))
    elif not out["ok"]:
        print(out["message"], file=sys.stderr)
    elif out["known"]:
        print("%s <%s>" % (out["name"], out["email"]))
    else:
        s = out["suggest"]
        print("Git has no name and email for commits yet." + (" Suggested: %s <%s>" % (s["name"], s["email"]) if s["email"] else ""))
    sys.exit(0 if out["ok"] else 1)


def add_parser(sub):
    s = sub.add_parser("git-identity", help="the name and email on commits made on this Mac: show (with a suggestion) / set --name --email")
    s.add_argument("op", nargs="?", default="show", choices=["show", "set"])
    s.add_argument("--name", default="")
    s.add_argument("--email", default="")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=command)
