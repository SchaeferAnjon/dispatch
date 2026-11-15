# -*- coding: utf-8 -*-
"""Test isolation for the CLI suite (cli/test_00_isolation.py switches it on before any test module is imported).

Every `bd` and `dolt` the suite starts, from a test or from a child process a test launches, goes through
the guards in bin/ first. A call whose BEADS_DIR is the real board, or a board that uses the shared Dolt
server, is refused and recorded; test_zz_isolation.py fails the run when anything was recorded.
HOME and every variable that moves Dispatch, Claude, Codex or Hermes data are pointed at a temp folder
for the whole run, and fsguard.py fails a write to the account's real ~/.dispatch, ~/.agents, ~/.claude,
~/.codex, ~/.config, ~/tasks, also through a link elsewhere that points into one of them (also in child Pythons,
through testkit/site/sitecustomize.py).
Every test must leave the environment as it found it: a variable a test (or the code it runs) sets and does not
put back reaches every test after it, so a run of the whole suite does what no single module does (10-06: a whole
run made app/~/.config/bd). The run wrapper below compares os.environ before and after each test, records a
change as a violation naming the test, and puts the environment back; test_zz_isolation.py also compares the
end of the run with its start, for what a module or a class set outside a test.
Tests that need a board make their own embedded one in a temp folder (`bd init --prefix task
--non-interactive --skip-hooks`, no --shared-server) or mock dispatch.sh / dispatch.bd_json.
"""
import atexit
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

# The suite also runs on the Command Line Tools' Python 3.9 (what a new Mac has): two newer test helpers, backfilled.
if not hasattr(unittest.TestCase, "enterContext"):  # 3.11
    def _enter_context(self, cm):
        result = cm.__enter__()
        self.addCleanup(cm.__exit__, None, None, None)
        return result
    unittest.TestCase.enterContext = _enter_context
try:
    tempfile.TemporaryDirectory(ignore_cleanup_errors=True).cleanup()
except TypeError:  # 3.10
    class _TemporaryDirectory(tempfile.TemporaryDirectory):
        def __init__(self, suffix=None, prefix=None, dir=None, ignore_cleanup_errors=False):
            super().__init__(suffix, prefix, dir)
            self._ignore = ignore_cleanup_errors

        def cleanup(self):
            try:
                super().cleanup()
            except OSError:
                if not self._ignore:
                    raise
    tempfile.TemporaryDirectory = _TemporaryDirectory

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "bin")
SITE = os.path.join(HERE, "site")
# Variables that move a tool's data folder away from ~: the suite must not inherit the real ones.
MOVES_DATA = ("DISPATCH_HOME", "DISPATCH_DIR", "DISPATCH_SKILL_POOL", "DISPATCH_SESSION_ROOT", "DISPATCH_IDE_USER_DATA_DIR",
              "DISPATCH_IDE_USER_DATA_DIRS", "CODEX_HOME", "HERMES_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME")
# The Agent session the suite usually runs inside: nothing in it may find that session and link it to a task.
# Every engine's env_markers are here (test_00 checks): one left in made `is_agent_caller` say yes inside Claude Code
# (CLAUDE_CODE_ENTRYPOINT) and no in a plain terminal, so the suite did not run the same for everyone.
SESSION_VARS = ("DISPATCH_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDECODE",
                "CLAUDE_CODE_ENTRYPOINT", "CODEX_SANDBOX", "CODEX_MANAGED_BY_NPM")


# Set by the run wrapper itself, not by a test.
_OWN_VARS = ("TESTKIT_TEST",)
_START_ENV = {}


def env_changes(before, after):
    """[(name, before, after)] of the variables that differ, the wrapper's own left out; None stands for unset."""
    out = []
    for k in sorted(set(before) | set(after)):
        if k in _OWN_VARS:
            continue
        a, b = before.get(k), after.get(k)
        if a != b:
            out.append((k, a, b))
    return out


def describe_changes(changes):
    def show(v):
        return "unset" if v is None else repr(v if len(v) <= 80 else v[:77] + "...")
    return ", ".join("%s %s -> %s" % (k, show(a), show(b)) for k, a, b in changes)


def restore_env(before):
    for k in list(os.environ):
        if k not in before and k not in _OWN_VARS:
            del os.environ[k]
    for k, v in before.items():
        if k not in _OWN_VARS and os.environ.get(k) != v:
            os.environ[k] = v


_SEEN_TILDE = set()
_SEEN_THREADS = set()
CLI = os.path.dirname(HERE)
THREAD_GRACE = 1.0  # seconds a test's own threads get to finish after it


def dispatch_code(fn):
    """True for a function of Dispatch's CLI (not a test, not testkit, not the standard library)."""
    path = getattr(getattr(fn, "__code__", None), "co_filename", "") or ""
    return path.startswith(CLI + os.sep) and not os.path.basename(path).startswith("test_") and os.sep + "testkit" + os.sep not in path


GUARDED_SIGNALS = ("SIGTERM", "SIGINT", "SIGHUP")


def signal_handlers():
    import signal
    return {n: signal.getsignal(getattr(signal, n)) for n in GUARDED_SIGNALS if hasattr(signal, n)}


def put_back_signal_handlers(before):
    """The names of the signals whose handler a test changed, each put back. A SIGTERM or SIGINT handler a test
    leaves in the test process swallows the signal for the rest of the run: Ctrl-C and a SIGTERM no longer end it."""
    import signal
    changed = []
    for n, h in before.items():
        if signal.getsignal(getattr(signal, n)) is not h:
            changed.append(n)
            if h is not None:
                signal.signal(getattr(signal, n), h)
    return changed


def leftover_threads(before, test_id):
    """Lines for the threads running Dispatch code that a test started and left running: they go on inside the
    tests after it, read and write what those tests set up, and get caught in their doubles (10-07: chatd's
    keep-awake and banner loops woke in later tests, so a shared Popen double counted their `ps`)."""
    left = [t for t in threading.enumerate() if t not in before and t.is_alive() and t not in _SEEN_THREADS
            and dispatch_code(getattr(t, "_target", None))]
    end = time.monotonic() + THREAD_GRACE
    for t in left:
        t.join(max(0.0, end - time.monotonic()))
    out = []
    for t in left:
        if t.is_alive():
            _SEEN_THREADS.add(t)
            fn = t._target
            out.append("%s test=%s: left a thread running: %s (%s %s)" % (
                time.strftime("%H:%M:%S"), test_id, t.name, os.path.basename(fn.__code__.co_filename), fn.__qualname__))
    return out


def tilde_folder_in_cwd():
    """./~ in the working folder (bd started without HOME writes ./~/.config/bd there); "" when there is none."""
    p = os.path.join(os.getcwd(), "~")
    return p if os.path.lexists(p) else ""


def record(line):
    try:
        with open(os.environ["TESTKIT_VIOLATIONS"], "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except (KeyError, OSError):
        pass


def start_env():
    """os.environ as activate() left it: what the run must still have at its end."""
    return dict(_START_ENV)


def agent_commands():
    """The command of every agent Dispatch knows (engines/), what a real one would answer to on this machine."""
    import engines
    return sorted({e.bin for e in engines.known() if e.bin and "/" not in e.bin})


def bin_dir(session):
    """<session>/bin: links to the bd, dolt and security guards, and one stand-in per agent command."""
    d = os.path.join(session, "bin")
    os.makedirs(d, exist_ok=True)
    for name in os.listdir(BIN):
        os.symlink(os.path.join(BIN, name), os.path.join(d, name))
    agent = os.path.join(HERE, "agent.py")
    for name in agent_commands():
        p = os.path.join(d, name)
        if os.path.lexists(p):
            continue
        with open(p, "w") as f:
            f.write('#!/bin/sh\nexec "%s" "%s" %s "$@"\n' % (sys.executable, agent, name))
        os.chmod(p, 0o755)
    return d


def active():
    return bool(os.environ.get("TESTKIT_SESSION"))


def violations():
    try:
        return [l.rstrip("\n") for l in open(os.environ["TESTKIT_VIOLATIONS"], encoding="utf-8") if l.strip()]
    except (KeyError, OSError):
        return []


def activate():
    """Idempotent. Call before the first test module imports `dispatch` (it reads BEADS_DIR at import)."""
    if active() or os.name != "posix":
        return
    from testkit import guard
    home = guard.real_home()
    session = tempfile.mkdtemp(prefix="dtest-")
    atexit.register(shutil.rmtree, session, True)
    os.environ["TESTKIT_SESSION"] = session
    os.environ["TESTKIT_VIOLATIONS"] = os.path.join(session, "violations.log")
    os.environ["TESTKIT_REAL_BOARD"] = os.environ.get("BEADS_DIR") or os.path.join(home, "tasks", ".beads")
    # The account's home is a temp folder: ~/.dispatch (preferences, rules), ~/.agents, ~/.claude, ~/.codex and
    # ~/tasks/.dispatch are all built from it, so nothing a test writes lands in the real ones.
    fake_home = os.path.join(session, "home")
    os.makedirs(fake_home)
    os.environ["TESTKIT_REAL_HOME"] = home
    os.environ["HOME"] = fake_home
    # Nothing of the caller's Dispatch or board settings: a DISPATCH_LOCAL_BUILD_MIN_FREE=10 typed in front of
    # `npm run test:py` (10-06) made the build tests take another path than they do for everyone else.
    for k in list(os.environ):
        if k in MOVES_DATA or k in SESSION_VARS or k.startswith(("DISPATCH_", "BEADS_")):
            os.environ.pop(k, None)
    # A board that does not exist: a test that forgot to set its own BEADS_DIR gets "no beads database", not the real board.
    os.environ["BEADS_DIR"] = os.path.join(session, "no-board", ".beads")
    # a command that writes preferences or the wiki would start a detached committer (knowledge_sync.py)
    os.environ["DISPATCH_KNOWLEDGE_AUTOCOMMIT"] = "0"
    # The words Dispatch writes follow the person's language (lang.py); the tests read the Chinese ones unless they
    # set DISPATCH_LANG=en themselves, whatever language the Mac running them speaks.
    os.environ["DISPATCH_LANG"] = "zh"
    with open(os.path.join(fake_home, ".gitconfig"), "w") as f:
        f.write("[user]\n\tname = Test\n\temail = test@example.invalid\n")
    os.environ["PYTHONPATH"] = SITE + (os.pathsep + os.environ["PYTHONPATH"] if os.environ.get("PYTHONPATH") else "")
    from testkit import fsguard
    fsguard.install(os.environ["TESTKIT_VIOLATIONS"])
    # dplatform.extra_bin_dirs() puts DISPATCH_IDE_BIN in front of /opt/homebrew/bin, so the guards win there too.
    # The run's own tool folder: the bd, dolt and security guards, and a stand-in for every agent's command that
    # refuses (bin_dir). It is DISPATCH_IDE_BIN too, which engines.search_path() puts before Homebrew's folder.
    tools = bin_dir(session)
    os.environ["DISPATCH_IDE_BIN"] = tools
    os.environ["PATH"] = tools + os.pathsep + os.environ.get("PATH", "")
    _START_ENV.clear()
    _START_ENV.update(os.environ)
    # Name the running test in the violation log, and catch a test that does not put the environment back.
    orig = unittest.TestCase.run

    def run(self, result=None):
        os.environ["TESTKIT_TEST"] = self.id()
        before = dict(os.environ)
        threads_before = set(threading.enumerate())
        handlers_before = signal_handlers()
        try:
            return orig(self, result)
        finally:
            for line in leftover_threads(threads_before, self.id()):
                record(line)
            changed = put_back_signal_handlers(handlers_before)
            if changed:
                record("%s test=%s: left the signal handlers changed: %s (put back)" % (time.strftime("%H:%M:%S"), self.id(), ", ".join(changed)))
            stray = tilde_folder_in_cwd()
            if stray and stray not in _SEEN_TILDE:
                _SEEN_TILDE.add(stray)
                record("%s test=%s: a literal ~ folder appeared at %s (a child without HOME wrote ./~/...; this test or one just before it)" % (
                    time.strftime("%H:%M:%S"), self.id(), stray))
            changes = env_changes(before, dict(os.environ))
            if changes:
                record("%s test=%s: left the environment changed: %s" % (time.strftime("%H:%M:%S"), self.id(), describe_changes(changes)))
                restore_env(before)
    unittest.TestCase.run = run
