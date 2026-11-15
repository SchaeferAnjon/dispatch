# -*- coding: utf-8 -*-
"""Body of the bin/bd and bin/dolt guards: refuse a call that would reach a real board, else hand over to the real tool."""
import os
import sys
import time


def _real_tool(name):
    explicit = os.environ.get("TESTKIT_REAL_" + name.upper())
    if explicit:
        return explicit
    mine = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin"))
    for d in (os.environ.get("PATH") or "").split(os.pathsep) + ["/opt/homebrew/bin", "/usr/local/bin"]:
        cand = os.path.join(d, name)
        # not a guard itself, also through the run's tool folder, whose bd and dolt link here
        if d and os.path.dirname(os.path.realpath(cand)) != mine and os.access(cand, os.X_OK) and not os.path.isdir(cand):
            return cand
    return ""


def run(name, verdict):
    args = sys.argv[1:]
    why = verdict(args, os.environ)
    if why:
        line = "%s test=%s: refused `%s %s`: %s" % (time.strftime("%H:%M:%S"), os.environ.get("TESTKIT_TEST", "?"), name, " ".join(args)[:160], why)
        try:
            with open(os.environ.get("TESTKIT_VIOLATIONS") or os.devnull, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass
        sys.stderr.write("test isolation: " + line + "\n")
        sys.exit(97)
    real = _real_tool(name)
    if not real:
        sys.stderr.write("%s: not installed\n" % name)
        sys.exit(127)
    os.execv(real, [real] + args)
