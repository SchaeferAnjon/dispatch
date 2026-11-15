# -*- coding: utf-8 -*-
"""Audit hook: a write, rename or delete under the account's real ~/.dispatch, ~/.agents, ~/.claude, ~/.codex
(and the other places Dispatch keeps state) fails the call and is recorded.

The suite runs with HOME in a temp folder, so code that builds these paths from ~ ends up there. What
this catches is a path that still points at the real one: a hard-coded absolute path, a HOME a test
passes on without the temp one, a child process started with a bare env. Reads stay allowed.
Installed in the test process by testkit.activate() and in every child Python by testkit/site/sitecustomize.py.

~/.config is protected whole: Dispatch's key store (~/.config/dispatch: env, signing-identity) lives there, and
so do the person's OpenCode, fish, gh and git settings. A path anywhere (a test instance's xdg-config in /tmp, say)
that reaches one of these through a link is judged by where it really goes (10-08: the whole ~/.config/dispatch
was gone, and test instances hold a link to it).

Two more mistakes it catches (10-07, a whole-suite run had left app/~/.config/bd in the working folder):
- a write to a path with a literal `~` folder in it (`~/.config/x` that nobody expanded): refused;
- a process started with an environment that has no absolute HOME, or the account's real one: recorded. Go tools
  such as bd then make `./~/.config/bd` in the working folder, and anything reading ~ reaches the real account.

And one database outside HOME (10-09): the system's lsregister may not change LaunchServices from a test (it decides
which Dispatch IDE.app the Dock opens); a stand-in lsregister of the test's own is fine.
"""
import os
import sys
import time

PROTECTED = (".dispatch", ".agents", ".claude", ".codex", ".cc-switch", ".zcode", ".hermes", ".gemini", ".beads", "tasks", ".config")
# the events that act on the entry itself, not on what a link there points at (removing a link leaves its target;
# shutil.rmtree is not one: given `link/` it empties the folder the link points at)
_ON_ENTRY = ("os.remove", "os.rmdir", "os.rename", "shutil.move", "os.symlink", "os.link")
_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
_installed = []
# the events that make a path (for the literal ~ check; removing one is fine)
_CREATES = ("open", "os.mkdir", "os.symlink", "os.link", "shutil.copyfile", "shutil.copy", "shutil.copy2", "shutil.copytree")


LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"


def _real_home():
    try:
        import pwd
        return pwd.getpwuid(os.getuid()).pw_dir
    except (ImportError, KeyError):
        return os.path.expanduser("~")


def _cmd(cmd):
    if isinstance(cmd, (list, tuple)):
        return " ".join(os.fsdecode(c) if isinstance(c, bytes) else str(c) for c in cmd)
    return os.fsdecode(cmd) if isinstance(cmd, bytes) else str(cmd)


def tilde_folder(p):
    """True for a path with a `~` folder in it (`~`, `~/x`, `a/~/x`): a ~ that nobody expanded."""
    if isinstance(p, bytes):
        p = os.fsdecode(p)
    if not isinstance(p, str):
        return False
    return "~" in p.split(os.sep)


def home_problem(val, real_homes):
    """Why HOME in a child's environment is wrong for a test; "" when it is a folder of the test's own."""
    if not val:
        return "with no HOME in its environment (bd and other Go tools then write ./~/.config/... into the working folder)"
    if not os.path.isabs(val):
        return "with HOME=%r, not an absolute path (it ends up as a folder named %r in the working folder)" % (val, val)
    if os.path.realpath(val) in {os.path.realpath(h) for h in real_homes}:
        return "with HOME set to the account's real home (%s), not the test's temp one" % val
    return ""


def install(log_path=None):
    if _installed:
        return
    home = os.path.realpath(_real_home())
    roots = tuple(os.path.join(home, p) for p in PROTECTED)
    prefixes = {home, _real_home()}

    def protected(p, entry=False):
        if isinstance(p, bytes):
            p = os.fsdecode(p)
        if not isinstance(p, str) or not p:
            return ""
        p = os.path.abspath(p)
        # a link inside a protected folder can point out of it and the other way round, and a link anywhere can point
        # into one: judge the resolved path (for a remove or a rename, of the folder it is in: that touches the link)
        real = os.path.join(os.path.realpath(os.path.dirname(p)), os.path.basename(p)) if entry else os.path.realpath(p)
        for r in roots:
            if real == r or real.startswith(r + os.sep):
                return real
        return ""

    def refuse(event, path, real):
        line = "%s test=%s: refused %s on %s (real path of the account, not the test's temp HOME)" % (
            time.strftime("%H:%M:%S"), os.environ.get("TESTKIT_TEST", "?"), event, real)
        log = os.environ.get("TESTKIT_VIOLATIONS") or log_path or ""
        if log:
            try:
                with open(log, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except OSError:
                pass
        raise PermissionError("test isolation: " + line)

    def record(line):
        log = os.environ.get("TESTKIT_VIOLATIONS") or log_path or ""
        if log:
            try:
                with open(log, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except OSError:
                pass

    def check_child(event, cmd, env):
        """A child started with an env of its own: it needs a HOME, and not the account's real one."""
        if env is None:
            env = os.environ  # the child inherits this process' environment: a test may have cleared HOME in it
        if not hasattr(env, "get"):
            return
        val = env.get("HOME", env.get(b"HOME") if isinstance(env, dict) else None)
        if isinstance(val, bytes):
            val = os.fsdecode(val)
        why = home_problem(val, prefixes)
        if why:
            record("%s test=%s: %s started `%s` %s" % (time.strftime("%H:%M:%S"), os.environ.get("TESTKIT_TEST", "?"), event, _cmd(cmd)[:160], why))

    def check_lsregister(event, cmd):
        argv = [os.fsdecode(c) if isinstance(c, bytes) else str(c) for c in cmd] if isinstance(cmd, (list, tuple)) else _cmd(cmd).split()
        if argv and os.path.realpath(argv[0]) == os.path.realpath(LSREGISTER) and any(a in ("-u", "-f", "-R", "-delete", "-kill") for a in argv[1:]):
            line = "%s test=%s: refused %s `%s` (the real LaunchServices database)" % (
                time.strftime("%H:%M:%S"), os.environ.get("TESTKIT_TEST", "?"), event, _cmd(cmd)[:160])
            record(line)
            raise PermissionError("test isolation: " + line)

    def hook(event, args):
        try:
            if event == "subprocess.Popen":
                check_lsregister(event, args[1])
                check_child(event, args[1], args[3])
                return
            if event in ("os.posix_spawn", "os.exec"):
                check_lsregister(event, args[1])
                check_child(event, args[1], args[2])
                return
            if event == "open":
                path, _mode, flags = args
                if isinstance(path, int) or not (flags & _WRITE_FLAGS):
                    return
                paths = (path,)
            elif event in ("os.mkdir", "os.remove", "os.rmdir", "os.truncate", "os.chmod", "os.chown", "shutil.rmtree"):
                paths = (args[0],)
            elif event in ("os.rename", "shutil.copyfile", "shutil.copy", "shutil.copy2", "shutil.copytree", "shutil.move", "os.symlink", "os.link"):
                paths = (args[0], args[1]) if event in ("os.rename", "shutil.move") else (args[1],)
            else:
                return
            for p in paths:
                if isinstance(p, int):
                    continue
                # removing a stray ~ is cleaning up, not making one; a rename's source is going away too
                makes = event in _CREATES or (event in ("os.rename", "shutil.move") and p is paths[-1])
                if makes and tilde_folder(p):
                    line = "%s test=%s: refused %s on %s (a literal ~ folder: nobody expanded the ~, it lands in the working folder)" % (
                        time.strftime("%H:%M:%S"), os.environ.get("TESTKIT_TEST", "?"), event, os.fsdecode(p) if isinstance(p, bytes) else p)
                    record(line)
                    raise PermissionError("test isolation: " + line)
                real = protected(p, entry=event in _ON_ENTRY)
                if real:
                    refuse(event, p, real)
        except PermissionError:
            raise
        except Exception:
            return

    sys.addaudithook(hook)
    _installed.append(True)
