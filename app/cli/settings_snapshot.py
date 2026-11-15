# -*- coding: utf-8 -*-
"""`dispatch settings-page --json`: everything the Agents window's Settings shows that is kept on this Mac, read in
one process (design/settings-fast, task-90441).

Every page of Settings used to ask the CLI on its own when it was opened: a new Python each time, half a second
before the first byte on a busy Mac, more for the ones that read the task board. The window now keeps what the
pages show and reads it all here once, when Settings opens (and a while after the window opened); the pages draw
what was read last at once and follow when this answer differs.

Each part is the same command a page used to run, run in this process (`dispatch <argv>` with its output caught),
so the answer is exactly what that command prints. Only reads of this Mac's own files go here: what asks a server or
another program (the allowances, the agents' versions, the network check) stays a call of its own, run in the
background while the page shows the last answer.

  {"ok": true, "ms": 812, "parts": {"<part>": {"ok": true, "value": <the command's JSON>, "ms": 31}, …}}
  A part whose command failed: {"ok": false, "code": 1, "error": "<its last line>", "ms": …}.
"""
import contextlib
import io
import json
import os
import sys
import time

# what each part runs: the commands the Settings pages ran one by one
PARTS = {
    "notify": ["settings", "--json"],
    "awake": ["awake", "--json"],
    "mobile": ["mobile", "status", "--json"],
    "soul": ["soul", "show", "--json"],
    "keys": ["env", "list", "--json"],
    "autonomy": ["autonomy", "--json"],
    "attribution": ["attribution", "config", "--json"],
    "nextup": ["nextup", "settings", "--json"],
    "neat": ["neat", "status", "--json"],
    "gitIdentity": ["git-identity", "show", "--json"],
    # Settings > Agents: other apps without asking (computer.py allowed.json)
    "computer": ["computer", "allowed", "--json"],
    # Settings › Soul: what Dispatch puts into every agent (agent_builtins.py), with the switches of its hooks, tools and helpers
    "builtins": ["builtins", "--json"],
    "mcp": ["mcp", "list", "--json"],
    # Abilities: the lists its pages draw (skills, rules, hooks; Claude Code's plugins)
    "inventory": ["customizations", "list", "--json"],
    "plugins": ["plugins", "list", "--json"],
}


def last_json(text):
    """The command's answer: the whole output as JSON, else its last line that is one (a command may print a note first)."""
    text = (text or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        pass
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line[:1] in "{[":
            try:
                return json.loads(line)
            except ValueError:
                continue
    return None


def run_part(D, argv):
    """`dispatch <argv>` in this process: (exit code, its stdout, its stderr). Its working folder, environment and
    standard streams are put back afterwards, whatever it did."""
    out, err = io.StringIO(), io.StringIO()
    saved_argv, saved_cwd, saved_env, saved_stdin = sys.argv, os.getcwd(), dict(os.environ), sys.stdin
    code = 0
    try:
        sys.argv = [saved_argv[0]] + list(argv)
        sys.stdin = io.StringIO("")
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            D._main()
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
        if not isinstance(e.code, (int, type(None))):
            err.write(str(e.code))
    except Exception as e:  # noqa: BLE001 - one part failing must not cost the others; it is reported with its part
        code = 1
        err.write(f"{type(e).__name__}: {e}")
    finally:
        sys.argv, sys.stdin = saved_argv, saved_stdin
        with contextlib.suppress(OSError):
            os.chdir(saved_cwd)
        if dict(os.environ) != saved_env:
            os.environ.clear()
            os.environ.update(saved_env)
    return code, out.getvalue(), err.getvalue()


def snapshot(D, parts=None):
    t0 = time.time()
    res = {}
    keep = getattr(D, "keep_parser", None)
    if keep:
        keep(True)  # the command line built once for all the parts, not a dozen times
    try:
        for name, argv in (parts or PARTS).items():
            res[name] = _part(D, argv)
    finally:
        if keep:
            keep(False)
    return {"ok": True, "ms": int((time.time() - t0) * 1000), "parts": res}


def _part(D, argv):
    t = time.time()
    code, out, err = run_part(D, argv)
    value = last_json(out)
    ms = int((time.time() - t) * 1000)
    if value is None or code not in (0, None):
        why = (err or out).strip().splitlines()
        return {"ok": False, "code": code, "error": why[-1][:300] if why else f"exit {code}", "ms": ms}
    return {"ok": True, "value": value, "ms": ms}


def run(a, D):
    out = snapshot(D)
    if getattr(a, "json", False):
        print(json.dumps(out, ensure_ascii=False))
    else:
        for name, p in out["parts"].items():
            print(f"{name:12} {'ok' if p['ok'] else 'failed: ' + p['error']}  {p['ms']} ms")
        print(f"{out['ms']} ms in all")
    return 0
