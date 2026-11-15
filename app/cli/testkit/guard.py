# -*- coding: utf-8 -*-
"""Decides whether a `bd` / `dolt` call made by the test suite may go through.

Tests never touch the real task board or the machine's shared Dolt server (~/.beads/shared-server, port
3308): a run of the whole suite from three workers at once once pushed real `bd` queries from 0 s to
20 to 100 s. bin/bd and bin/dolt call `verdict()` before they exec the real tool; a refused call is
appended to $TESTKIT_VIOLATIONS and test_zz_isolation.py fails the run on it.
"""
import json
import os
import re



def real_home():
    """The account's home from the password database: a test that points HOME at a temp folder must not move the real board."""
    try:
        import pwd
        return pwd.getpwuid(os.getuid()).pw_dir
    except (ImportError, KeyError):
        return os.path.expanduser("~")


SHARED_SERVER = os.path.join(real_home(), ".beads", "shared-server")


def _real(p):
    return os.path.realpath(os.path.expanduser(p)) if p else ""


def real_boards():
    """The folders that hold a real board: the default one and whatever BEADS_DIR was before the suite started."""
    out = {_real(os.path.join(real_home(), "tasks", ".beads"))}
    if os.environ.get("TESTKIT_REAL_BOARD"):
        out.add(_real(os.environ["TESTKIT_REAL_BOARD"]))
    return {p for p in out if p}


def shared_port():
    try:
        with open(os.path.join(SHARED_SERVER, "dolt-server.port")) as f:
            return f.read().strip() or "3308"
    except OSError:
        return "3308"


def board_problem(beads_dir):
    """Why `bd` with this BEADS_DIR would reach a real board or the shared server; "" when it is safe."""
    if not beads_dir:
        return "BEADS_DIR is empty, bd would look for a board upward from the working directory"
    real = _real(beads_dir)
    if real in real_boards():
        return "BEADS_DIR is the real task board (%s)" % real
    beads_home = _real(os.path.join(real_home(), ".beads"))
    if real == beads_home or real.startswith(beads_home + os.sep):
        return "BEADS_DIR is inside ~/.beads (%s)" % real
    try:
        meta = json.load(open(os.path.join(real, "metadata.json"), encoding="utf-8"))
        if isinstance(meta, dict) and meta.get("dolt_mode") == "server":
            return "the board at BEADS_DIR runs in dolt server mode (metadata.json dolt_mode=server)"
    except (OSError, ValueError):
        pass
    try:
        cfg = open(os.path.join(real, "config.yaml"), encoding="utf-8").read()
        if re.search(r"^\s*(dolt\.)?shared-server:\s*[\"']?true", cfg, re.M):
            return "the board at BEADS_DIR uses the shared Dolt server (config.yaml shared-server: true)"
    except OSError:
        pass
    return ""


def home_verdict(tool, env):
    """bd (Go) with no HOME writes its settings to ./~/.config/bd in the working folder (10-06: app/~ after a run)."""
    h = env.get("HOME", "")
    if not h or not os.path.isabs(h):
        return "`%s` started with HOME=%r: it would write its settings into ./~/.config in %s" % (tool, h, os.getcwd())
    return ""


def bd_verdict(args, env):
    why = home_verdict("bd", env)
    if why:
        return why
    if "--shared-server" in args:
        return "`bd %s --shared-server` would attach to the machine's shared Dolt server" % (args[0] if args else "")
    return board_problem(env.get("BEADS_DIR", ""))


def dolt_verdict(args, env):
    why = home_verdict("dolt", env)
    if why:
        return why
    for i, a in enumerate(args):
        if a == "sql-server":
            return "`dolt sql-server` would start or replace a Dolt server"
        m = re.match(r"^--port(?:=(.*))?$", a)
        if m:
            port = m.group(1) if m.group(1) is not None else (args[i + 1] if i + 1 < len(args) else "")
            if port == shared_port():
                return "the call connects to the shared Dolt server on port %s" % port
    return ""


def security_verdict(args, env):
    """Every keychain call: tests use a fake keychain folder (accounts.Keychain(fake_dir), DISPATCH_FAKE_KEYCHAIN)."""
    return "`security %s` would read or change the real macOS keychain" % (args[0] if args else "")


def agent_verdict(name):
    """Every agent command a test reaches without its own stand-in: a real Claude Code, Codex or OpenCode on the
    machine running the suite would start a real model run (and found or not, the answer depends on that machine:
    the mini's Codex in /opt/homebrew/bin, this Mac's OpenCode in ~/.bun/bin)."""
    return lambda args, env: "`%s` is a real agent on this machine; a test uses its own stand-in (DISPATCH_IDE_BIN or PATH)" % name
