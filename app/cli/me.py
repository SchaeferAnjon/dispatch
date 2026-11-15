# -*- coding: utf-8 -*-
"""`dispatch me`: who uses this Mac, as the Agents window's title bar shows it (your picture at the top right).

The picture is your GitHub one, never letters: the GitHub account comes from the GitHub CLI's own login file
(~/.config/gh/hosts.yml, the `user:` of github.com; no network, no token read), else `git config github.user`.
Nothing found means no picture: the title bar keeps its plain account icon.
"""
import json
import os
import re
import subprocess

LOGIN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")


def gh_hosts_file(home=None):
    base = os.environ.get("GH_CONFIG_DIR") or os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(home or os.path.expanduser("~"), ".config"), "gh")
    return os.path.join(base, "hosts.yml")


def login_from_hosts(text):
    """The github.com account in gh's hosts.yml: its `user:` line (gh 2.40+ also lists `users:`, the active one is `user:`)."""
    host = None
    for line in (text or "").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            host = line.strip().rstrip(":")
            continue
        if host == "github.com" and indent <= 4:
            m = re.match(r"^\s*user:\s*['\"]?([^'\"\s]+)['\"]?\s*$", line)
            if m and LOGIN.match(m.group(1)):
                return m.group(1)
    return None


def _git(*args):
    try:
        p = subprocess.run(["git", "config", "--global", *args], capture_output=True, text=True, timeout=5)
        return p.stdout.strip() if p.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def who(home=None):
    login = None
    try:
        with open(gh_hosts_file(home), encoding="utf-8") as f:
            login = login_from_hosts(f.read())
    except OSError:
        pass
    if not login:
        g = _git("github.user")
        login = g if LOGIN.match(g or "") else None
    name = _git("user.name")
    return {"github": login or "", "name": name or login or "",
            "avatar": f"https://github.com/{login}.png?size=64" if login else ""}


def run(a, d=None):
    r = who()
    if getattr(a, "json", False):
        print(json.dumps(r, ensure_ascii=False))
    else:
        print(r["github"] or "No GitHub account found on this Mac (sign in with gh auth login).")
    return 0
