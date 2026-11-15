#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Run the CLI unit tests on Windows CI, one module at a time.

A test module that sets `WINDOWS_READY = True` at module level is strict: any failure fails the job.
Every other module still runs, but its result is only logged ("not yet windows-ready: ..."), so the
port can land package by package without a shared on/off switch file. STRICT_ALWAYS lists modules
that are strict without carrying the marker themselves.

Usage: python app/scripts/ci-py-windows.py [module ...]
"""
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.normpath(os.path.join(HERE, "..", "cli"))
STRICT_ALWAYS = {"test_bundle"}
READY_RE = re.compile(r"^WINDOWS_READY\s*=\s*True\b", re.M)
TIMEOUT = 900


def ready(mod):
    if mod in STRICT_ALWAYS:
        return True
    try:
        with open(os.path.join(CLI, mod + ".py"), encoding="utf-8") as f:
            return bool(READY_RE.search(f.read()))
    except OSError:
        return False


def counts(output):
    m = re.search(r"^FAILED \((.*)\)\s*$", output, re.M)
    if not m:
        return 0
    n = 0
    for part in m.group(1).split(","):
        k, _, v = part.strip().partition("=")
        if k in ("failures", "errors") and v.isdigit():
            n += int(v)
    return n or 1


def main(argv):
    mods = argv or sorted(f[:-3] for f in os.listdir(CLI) if f.startswith("test_") and f.endswith(".py"))
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1")
    strict_failed, lenient = [], []
    for mod in mods:
        strict = ready(mod)
        t0 = time.time()
        try:
            r = subprocess.run([sys.executable, "-m", "unittest", "-v", mod], cwd=CLI, env=env,
                               capture_output=True, timeout=TIMEOUT)
            out = (r.stdout + r.stderr).decode("utf-8", "replace")
            code = r.returncode
        except subprocess.TimeoutExpired as e:
            out = ((e.stdout or b"") + (e.stderr or b"")).decode("utf-8", "replace") + "\nTIMEOUT after %ss" % TIMEOUT
            code = -1
        dt = time.time() - t0
        ok = code == 0
        tag = "strict" if strict else "lenient"
        print("::group::%s %s [%s] %.1fs" % ("PASS" if ok else "FAIL", mod, tag, dt))
        print(out)
        print("::endgroup::")
        if ok:
            continue
        if strict:
            strict_failed.append(mod)
            print("::error::windows-ready test module failed: %s" % mod)
        else:
            n = counts(out)
            lenient.append((mod, n))
            print("not yet windows-ready: %s %d failures" % (mod, n))
    print("")
    for mod, n in lenient:
        print("not yet windows-ready: %s %d failures" % (mod, n))
    if strict_failed:
        print("strict failures: %s" % ", ".join(strict_failed))
        return 1
    print("all windows-ready modules passed (%d modules run)" % len(mods))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
