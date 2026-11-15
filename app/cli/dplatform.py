# -*- coding: utf-8 -*-
"""Platform layer for the dispatch CLI.

Every OS difference (macOS / Linux vs native Windows) lives here; dispatch.py and its sibling
modules call these helpers instead of checking os.name themselves. The module is named
dplatform so it does not shadow the standard library `platform`.

Each function reads the module global IS_WIN at call time, so tests can flip it with
`patch.object(dplatform, "IS_WIN", True)` and exercise the Windows branch on a Mac.
Standard library only; importable on every OS.
"""
import platform as _stdplatform
import getpass
import glob
import ntpath
import os
import posixpath
import re
import shlex
import shutil
import stat
import subprocess
import sys
import time

IS_WIN = os.name == "nt"

HOME = os.path.expanduser("~")


def _env(name, default=""):
    return os.environ.get(name) or default


# ---- stdio -------------------------------------------------------------------------------------

def utf8_stdio():
    """Switch stdin/stdout/stderr to UTF-8 (errors replaced). Windows consoles and pipes default to
    the ANSI code page, which turns every Chinese string into mojibake or a UnicodeEncodeError."""
    for name in ("stdout", "stderr", "stdin"):
        s = getattr(sys, name, None)
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


# ---- identity ----------------------------------------------------------------------------------

def host_name():
    """Human name of this machine. macOS: the ComputerName from scutil (what the user typed in
    System Settings); otherwise COMPUTERNAME or platform.node(). Never os.uname (absent on Windows)."""
    if not IS_WIN and sys.platform == "darwin":
        try:
            r = subprocess.run(["/usr/sbin/scutil", "--get", "ComputerName"], capture_output=True, text=True, timeout=3)
            name = r.stdout.strip()
            if r.returncode == 0 and name:
                return name
        except Exception:
            pass
    return os.environ.get("COMPUTERNAME") or _stdplatform.node() or "localhost"


def machine():
    """CPU architecture as the OS reports it (arm64, x86_64, AMD64)."""
    return _stdplatform.machine()


def user_name():
    """Login name: USER, USERNAME, then getpass."""
    name = os.environ.get("USER") or os.environ.get("USERNAME")
    if name:
        return name
    try:
        return getpass.getuser()
    except Exception:
        return ""


# ---- PATH and tools ----------------------------------------------------------------------------

def _win_dirs():
    local = _env("LOCALAPPDATA", os.path.join(HOME, "AppData", "Local"))
    roaming = _env("APPDATA", os.path.join(HOME, "AppData", "Roaming"))
    profile = _env("USERPROFILE", HOME)
    progs = _env("ProgramFiles", "C:\\Program Files")
    dirs = [
        ntpath.join(local, "Programs", "bd"),
        ntpath.join(profile, ".local", "bin"),
        ntpath.join(roaming, "npm"),
        ntpath.join(profile, "go", "bin"),
        ntpath.join(local, "Microsoft", "WinGet", "Links"),
        ntpath.join(profile, "scoop", "shims"),
        ntpath.join(progs, "Git", "cmd"),
        ntpath.join(progs, "Dolt", "bin"),
        ntpath.join(progs, "Tailscale"),
    ]
    try:
        dirs += sorted(glob.glob(ntpath.join(local, "Microsoft", "WinGet", "Packages", "GasTownHall.Beads_*")))
    except Exception:
        pass
    return dirs


def extra_bin_dirs():
    """Directories where the tools Dispatch drives (bd, dolt, git, agents) usually live but
    that a GUI-launched process may not have on PATH. Prepended by path_env()."""
    if IS_WIN:
        return _win_dirs()
    # Dispatch IDE's own bd and dolt (Resources/app/tools; dispatch-bridge sets DISPATCH_IDE_BIN) come first
    ide = os.environ.get("DISPATCH_IDE_BIN") or ""
    return ([ide] if ide and os.path.isdir(ide) else []) + ["/opt/homebrew/bin", "/usr/local/bin", os.path.join(HOME, ".local", "bin")] \
        + [d for d in app_tools_dirs() if d != ide]


APP_BUNDLE = "Dispatch IDE.app"


def app_tools_dirs():
    """bd and dolt inside Dispatch IDE (Contents/Resources/app/tools) where no DISPATCH_IDE_BIN says so: the app this
    CLI ships in (~/.local/bin/dispatch links into it), else the app in /Applications or ~/Applications. Only
    dispatch-bridge sets DISPATCH_IDE_BIN, so without this a new Mac's Terminal, chatd and the agents it starts found
    no bd at all (task-oatt). Last, after Homebrew's: a bd someone installed themselves still wins."""
    if IS_WIN:
        return []
    here = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))
    roots = []
    i = here.find(".app/Contents/Resources/")
    if i >= 0:
        roots.append(here[:i + len(".app")])
    roots += [os.path.join("/Applications", APP_BUNDLE), os.path.join(os.path.expanduser("~"), "Applications", APP_BUNDLE)]
    out = []
    for r in roots:
        d = os.path.join(r, "Contents", "Resources", "app", "tools")
        if d not in out and os.path.isfile(os.path.join(d, "bd")):
            out.append(d)
    return out


def path_env(env=None):
    """Copy of `env` (default os.environ) whose PATH starts with extra_bin_dirs(), joined with the
    OS separator (';' on Windows, ':' elsewhere)."""
    e = dict(os.environ if env is None else env)
    sep = ";" if IS_WIN else ":"
    old = e.get("PATH") or e.get("Path") or ""
    parts = [d for d in extra_bin_dirs() if d]
    if old:
        parts.append(old)
    if IS_WIN and "Path" in e and "PATH" not in e:
        e.pop("Path", None)
    e["PATH"] = sep.join(parts)
    return e


def is_store_stub(path):
    """True for the Microsoft Store app-execution aliases under %LOCALAPPDATA%\\Microsoft\\WindowsApps
    (python.exe there opens the Store and exits 9009 instead of running Python)."""
    if not path:
        return False
    p = str(path).replace("/", "\\").lower()
    return "\\microsoft\\windowsapps\\" in p


def which(name, env=None):
    """Full path of `name` on path_env()'s PATH, or None. On Windows it honours PATHEXT (.exe/.cmd)
    and skips Store stubs, trying later PATH entries instead."""
    path = path_env(env)["PATH"]
    if not IS_WIN:
        return shutil.which(name, path=path)
    for d in path.split(";"):
        if not d or is_store_stub(d.rstrip("\\/") + "\\"):
            continue
        hit = shutil.which(name, path=d)
        if hit and not is_store_stub(hit):
            return hit
    return None


# ---- processes ---------------------------------------------------------------------------------

CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200


def no_window_flags():
    """creationflags that keep a console child from flashing a window on Windows; 0 elsewhere."""
    return getattr(subprocess, "CREATE_NO_WINDOW", CREATE_NO_WINDOW) if IS_WIN else 0


def detached_flags():
    """creationflags for a background process that outlives us and has no console (Windows)."""
    return (getattr(subprocess, "DETACHED_PROCESS", DETACHED_PROCESS)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", CREATE_NEW_PROCESS_GROUP)
            | getattr(subprocess, "CREATE_NO_WINDOW", CREATE_NO_WINDOW))


def quiet_python(exe=None):
    """The interpreter to use for background Python children: on Windows pythonw.exe next to
    python.exe (no console window) when it exists, otherwise `exe` (default sys.executable)."""
    exe = exe or sys.executable
    if IS_WIN and exe and ntpath.basename(exe).lower() == "python.exe":
        w = ntpath.join(ntpath.dirname(exe), "pythonw.exe")
        if os.path.exists(w):
            return w
    return exe


def spawn_detached(args, **kw):
    """Start `args` detached from us (own session / process group, no console) and return the Popen.
    Extra keyword arguments pass through to subprocess.Popen."""
    args = list(args)
    if IS_WIN:
        if args and args[0] == sys.executable:
            args[0] = quiet_python(args[0])
        kw.setdefault("creationflags", detached_flags())
        kw.setdefault("close_fds", True)
    else:
        kw.setdefault("start_new_session", True)
        kw.setdefault("close_fds", True)
    return subprocess.Popen(args, **kw)


def pid_alive(pid):
    """True while process `pid` exists. On Windows this goes through winproc (os.kill(pid, 0) there
    sends CTRL_C_EVENT instead of probing)."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if IS_WIN:
        import winproc
        return winproc.pid_alive(pid)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def terminate(pid, force=False):
    """Stop process `pid`. POSIX: SIGTERM, or SIGKILL with force. Windows: TerminateProcess, or
    `taskkill /T /F` (whole tree) with force. Returns True when the signal was delivered."""
    try:
        pid = int(pid)
        if IS_WIN:
            if force:
                r = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True,
                                   creationflags=no_window_flags())
                return r.returncode == 0
            os.kill(pid, 15)
            return True
        import signal
        os.kill(pid, signal.SIGKILL if force else signal.SIGTERM)
        return True
    except Exception:
        return False


def ps_table():
    """{pid: (ppid, command)} for every process. macOS/Linux: `ps -axo pid=,ppid=,comm=` (comm is a
    full path on macOS). Windows: Toolhelp snapshot plus the full image path where readable."""
    out = {}
    if IS_WIN:
        import winproc
        for pid, ppid, name in winproc.snapshot():
            out[pid] = (ppid, winproc.image_path(pid) or name)
        return out
    try:
        text = subprocess.run(["ps", "-axo", "pid=,ppid=,comm="], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return out
    for line in text.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) < 2:
            continue
        try:
            out[int(parts[0])] = (int(parts[1]), parts[2] if len(parts) > 2 else "")
        except ValueError:
            continue
    return out


def process_cmdlines():
    """{pid: full command line string}. macOS/Linux: `ps -axo pid=,args=`; Windows: winproc.cmdlines()."""
    if IS_WIN:
        import winproc
        return {pid: row.get("cmdline") or "" for pid, row in winproc.cmdlines().items()}
    out = {}
    try:
        text = subprocess.run(["ps", "-axo", "pid=,args="], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return out
    for line in text.splitlines():
        parts = line.strip().split(None, 1)
        if not parts:
            continue
        try:
            out[int(parts[0])] = parts[1] if len(parts) > 1 else ""
        except ValueError:
            continue
    return out


def pid_cwd(pid):
    """Working directory of a process (lsof, ~50 ms); '' where it cannot be read (Windows)."""
    if IS_WIN:
        return ""
    try:
        r = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=3)
        return next((l[1:] for l in r.stdout.splitlines() if l.startswith("n/")), "")
    except Exception:
        return ""


def exe_base(comm):
    """Bare lower-case program name of a command/path: '/opt/x/Claude' -> 'claude',
    'C:\\x\\node.exe' -> 'node'."""
    base = re.split(r"[\\/]", (comm or "").strip())[-1].lower()
    return base[:-4] if base.endswith(".exe") else base


# ---- paths -------------------------------------------------------------------------------------

def norm_path(p):
    """Canonical form for comparing paths: ~ expanded, normalized, case-folded where the OS is
    case-insensitive (Windows)."""
    p = os.path.expanduser(str(p))
    if IS_WIN:
        return ntpath.normcase(ntpath.normpath(p))
    return os.path.normcase(os.path.normpath(p))


def same_path(a, b):
    """True when `a` and `b` name the same path after norm_path."""
    if not a or not b:
        return False
    return norm_path(a) == norm_path(b)


def is_under(child, root):
    """True when `child` is `root` or lies inside it (by path components, not string prefix)."""
    if not child or not root:
        return False
    c, r = norm_path(child), norm_path(root)
    mod = ntpath if IS_WIN else os.path
    try:
        return mod.commonpath([c, r]) == r
    except ValueError:
        return False


def from_msys(p):
    """Git Bash / MSYS form '/c/Users/x' -> 'C:\\Users\\x'; anything else unchanged."""
    m = re.match(r"^/([a-zA-Z])(/|$)(.*)$", p or "")
    if not m:
        return p
    return m.group(1).upper() + ":\\" + m.group(3).replace("/", "\\")


def to_slash(p):
    """Backslashes to forward slashes (the form the UI receives: C:/Users/x/proj)."""
    return (p or "").replace("\\", "/")


def is_abs(p):
    """Absolute on either OS: '/Users/x', 'C:\\x', 'C:/x', '\\\\server\\share'. A board shared
    between a Mac and a PC holds both kinds."""
    if not p:
        return False
    return bool(re.match(r"^([A-Za-z]:[\\/]|[\\/]{2})", p)) or posixpath.isabs(p)


def home_relative(p):
    """'~/…' when `p` is inside the home directory, else `p` unchanged."""
    if not p:
        return p
    if same_path(p, HOME):
        return "~"
    if is_under(p, HOME):
        rest = str(p)[len(HOME):].lstrip("\\/")
        return "~/" + to_slash(rest)
    return p


# ---- desktop integration -----------------------------------------------------------------------

def open_path(path, reveal=False):
    """Open a file, folder or URL with the default app; `reveal` selects it in Finder / Explorer
    instead. Returns True when the launch was started."""
    try:
        if IS_WIN:
            if reveal and not re.match(r"^[a-z][a-z0-9+.-]*://", path or "", re.I):
                subprocess.Popen(["explorer", "/select,", path], creationflags=no_window_flags())
            else:
                os.startfile(path)  # noqa: available on Windows only
            return True
        if sys.platform == "darwin":
            subprocess.Popen(["open", "-R", path] if reveal else ["open", path])
        else:
            subprocess.Popen(["xdg-open", os.path.dirname(path) if reveal else path])
        return True
    except Exception:
        return False


def copy_to_clipboard(text):
    """Put `text` on the system clipboard (pbcopy / clip.exe). False when that failed."""
    try:
        if IS_WIN:
            r = subprocess.run(["clip.exe"], input=text.encode("utf-16-le"), creationflags=no_window_flags(), timeout=10)
        else:
            r = subprocess.run(["pbcopy"], input=text.encode("utf-8"), timeout=10)
        return r.returncode == 0
    except Exception:
        return False


def paste_hint():
    """The shell snippet that reads the clipboard, for help texts."""
    return "Get-Clipboard | " if IS_WIN else "pbpaste | "


def shell_quote(s):
    """Quote one argument for the user's shell: POSIX sh, or PowerShell single quotes on Windows."""
    s = str(s)
    if IS_WIN:
        return "'" + s.replace("'", "''") + "'"
    return shlex.quote(s)


def cd_and(cwd, cmd):
    """A one-line shell command that changes into `cwd` and then runs `cmd`."""
    if IS_WIN:
        return "Set-Location -LiteralPath %s; %s" % (shell_quote(cwd), cmd)
    return "cd %s && %s" % (shell_quote(cwd), cmd)


# ---- links -------------------------------------------------------------------------------------

def mount_link(src, link):
    """Make `link` point at directory `src`: a symlink on POSIX, a junction on Windows (junctions need
    neither admin rights nor Developer Mode)."""
    if not IS_WIN:
        os.symlink(src, link)
        return
    target = os.path.abspath(src)
    try:
        import _winapi
        _winapi.CreateJunction(target, link)
        return
    except Exception:
        pass
    r = subprocess.run(["cmd", "/c", "mklink", "/J", link, target], capture_output=True,
                       creationflags=no_window_flags())
    if r.returncode != 0:
        raise OSError("mklink /J failed: %s" % (r.stderr or r.stdout or b"").decode("utf-8", "replace").strip())


def is_link(p):
    """True for a symlink or (Windows) a directory junction."""
    try:
        if os.path.islink(p):
            return True
    except Exception:
        pass
    if not IS_WIN:
        return False
    isj = getattr(os.path, "isjunction", None)
    if isj is not None:
        try:
            return bool(isj(p))
        except Exception:
            return False
    try:
        tag = getattr(os.lstat(p), "st_reparse_tag", 0)
        return tag == getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003)
    except Exception:
        return False


def unlink_link(p):
    """Remove a link made by mount_link without touching its target."""
    if IS_WIN and os.path.isdir(p) and not os.path.islink(p):
        os.rmdir(p)  # a junction: rmdir removes the reparse point only
        return
    try:
        os.remove(p)
    except (IsADirectoryError, PermissionError):
        if IS_WIN:
            os.rmdir(p)
        else:
            raise


def replace_retry(src, dst, tries=5, delay=0.05):
    """os.replace, retried on PermissionError (Windows refuses while another process has dst open)."""
    for i in range(max(1, tries)):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == tries - 1:
                raise
            time.sleep(delay * (i + 1))


# ---- install help ------------------------------------------------------------------------------

_BREW = {"git": "git", "bd": "beads", "dolt": "dolt", "tailscale": "tailscale",
         "rsync": "rsync", "python": "python@3.12", "node": "node", "gh": "gh"}
_WINGET = {
    "git": "winget install Git.Git",
    "bd": "winget install GasTownHall.Beads",
    "dolt": "winget install DoltHub.Dolt",
    "tailscale": "winget install Tailscale.Tailscale",
    "python": "winget install Python.Python.3.12",
    "node": "winget install OpenJS.NodeJS.LTS",
    "gh": "winget install GitHub.cli",
}
_WIN_NONE = {"rsync"}


def install_hint(tool):
    """Command that installs `tool` on this OS (brew on macOS, winget on Windows), or None when the
    tool has no Windows build."""
    if IS_WIN:
        if tool in _WIN_NONE:
            return None
        return _WINGET.get(tool, "winget install %s" % tool)
    return "brew install %s" % _BREW.get(tool, tool)


def add_user_path(d):
    """Append directory `d` to the per-user PATH (HKCU\\Environment\\Path) and tell running programs.
    Windows only; returns True when the registry changed, False otherwise (always False on macOS)."""
    if not IS_WIN:
        return False
    import winreg
    d = str(d).rstrip("\\/")
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_READ | winreg.KEY_WRITE) as k:
        try:
            cur, kind = winreg.QueryValueEx(k, "Path")
        except FileNotFoundError:
            cur, kind = "", winreg.REG_EXPAND_SZ
        parts = [x for x in (cur or "").split(";") if x]
        if any(ntpath.normcase(x.rstrip("\\/")) == ntpath.normcase(d) for x in parts):
            return False
        parts.append(d)
        winreg.SetValueEx(k, "Path", 0, winreg.REG_EXPAND_SZ if kind not in (winreg.REG_SZ, winreg.REG_EXPAND_SZ) else kind, ";".join(parts))
    try:
        import ctypes
        HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG = 0xFFFF, 0x001A, 0x0002
        res = ctypes.c_ulong()
        ctypes.windll.user32.SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, "Environment",
                                                 SMTO_ABORTIFHUNG, 5000, ctypes.byref(res))
    except Exception:
        pass
    return True


# ---- unsupported features ----------------------------------------------------------------------

class Unsupported(Exception):
    """A feature that only exists on macOS was asked for on Windows.

    Convention: a --json command catches it and prints {"ok": false, "unsupported": true,
    "message": ...} with exit code 0; a plain command prints the message and exits 2."""


def unsupported(feature):
    """Raise Unsupported with the standard message for `feature` (its name in the person's language)."""
    from lang import t
    raise Unsupported(t("%s is not supported on Windows yet; for now it only works on a Mac", "Windows 版暂不支持%s，这一功能目前只在 Mac 上可用") % feature)


# ---- well-known files --------------------------------------------------------------------------

def _app_support(*parts):
    if IS_WIN:
        return os.path.join(_env("APPDATA", os.path.join(HOME, "AppData", "Roaming")), *parts)
    return os.path.join(HOME, "Library", "Application Support", *parts)


CLAUDE_CREDENTIALS = os.path.join(HOME, ".claude", ".credentials.json")


def obsidian_config():
    """Path of Obsidian's vault list (obsidian.json) on this OS."""
    return _app_support("obsidian", "obsidian.json")


OBSIDIAN_CONFIG = obsidian_config()
