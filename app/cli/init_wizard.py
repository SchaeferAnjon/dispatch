# -*- coding: utf-8 -*-
"""First-run setup for Dispatch (`dispatch init`).

One machine at a time, in this order, each step idempotent so the wizard can be
re-run after fixing something by hand:

  deps    Homebrew, Dolt, Beads (bd); Tailscale optional
  cli     `dispatch` on PATH -> the CLI bundled inside Dispatch.app
  board   the task board: start a new one here (this Mac becomes the hub) or join
          the board of a Mac that already runs Dispatch; joining also asks the hub to
          ssh back, since 远程登录 (a GUI toggle) is what lets it merge this Mac's sessions
  agents  which agents live here; hooks for Claude Code
  rules   one GLOBAL.md for every agent + a shared skills pool (copied from the hub
          when joining), then `dispatch rules sync`
  review  optional: hand an agent the job of auditing rules and skills
  done    marks setup finished (or skipped) so the app stops showing the guide

`dispatch init status --json` describes every step for the desktop app; the app
calls `dispatch init run <step> ...` for each button. The terminal wizard
(`dispatch init`) walks the same steps with prompts.
"""
import glob, json, os, plistlib, re, secrets, shlex, shutil, socket, subprocess, sys, time
sys.dont_write_bytecode = True  # never write __pycache__ next to these files: inside Dispatch.app that breaks the code signature
from lang import t as _t

import dispatch as D
import dplatform as P
import engines as E
import launchd_labels as L

INIT_FILE = os.path.join(D.DISPATCH_DIR, "init.json")
HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = os.path.join(D.HOME, ".beads", "shared-server")
DOLT_CONFIG = os.path.join(SHARED, "dolt", "config.yaml")
REMOTESAPI_PORT = 3309
SYNC_USER = "sync"
LAUNCH_DIR = os.path.join(D.HOME, "Library", "LaunchAgents")
BREW = shutil.which("brew") or ("/opt/homebrew/bin/brew" if os.path.exists("/opt/homebrew/bin/brew") else "/usr/local/bin/brew")
# Each agent's own folder (its adapter's config_home, engines/), by session-key prefix: {agent: (name, folder)}
AGENT_HOMES = {e.agent: (e.name, e.home_dir(D.HOME)) for e in E.known() if e.config_home}
DEPS = [
    # name, binary, brew formula/cask, why, required
    ("brew", "brew", None, _t('the package manager for macOS; the others below are installed with it', 'macOS 的包管理器，下面几样都靠它装'), True),
    ("python", "python3", "python@3.12", _t("runs Dispatch's own command line (3.9 or newer)", '运行 Dispatch 自带的命令行（需要 3.9 或更新）'), True),
    ("git", "git", "git", _t("needed for a project's commit history, moving projects, and setting up screen viewing", '项目页的提交记录、项目迁移、看屏幕的安装都要它'), True),
    ("dolt", "dolt", "dolt", _t("the task board's database (with version history; syncs between two Macs)", '任务板的数据库（带版本历史，能在两台电脑之间同步）'), True),
    ("bd", "bd", "beads", _t('the task board itself (Beads); agents record tasks with it', '任务板本身（Beads），Agent 用它记任务'), True),
    ("tailscale", "tailscale", None, _t('lets two Macs reach each other when they are not on the same Wi‑Fi; not needed with one Mac', '两台电脑不在同一 Wi‑Fi 时互相访问；只有一台电脑可以不装'), False),
]
# Windows: winget package ids instead of brew formulas; Dolt optional (the board runs on bd's embedded database).
DEPS_WIN = [
    ("winget", "winget", None, _t('the package manager for Windows (App Installer); the others below are installed with it', 'Windows 的包管理器（「应用安装程序」），下面几样都靠它装'), True),
    ("python", "python", "Python.Python.3.12", _t("runs Dispatch's own command line (3.9 or newer)", '运行 Dispatch 自带的命令行（需要 3.9 或更新）'), True),
    ("git", "git", "Git.Git", _t("needed for a project's commit history; on Windows Claude Code runs hooks and the status line in its Git Bash", '项目页的提交记录要它；Claude Code 在 Windows 上用它带的 Git Bash 跑 hooks 和状态栏'), True),
    ("bd", "bd", "GasTownHall.Beads", _t('the task board itself (Beads); agents record tasks with it', '任务板本身（Beads），Agent 用它记任务'), True),
    ("dolt", "dolt", "DoltHub.Dolt", _t("optional: on Windows the board uses bd's built-in database, no separate Dolt needed", '可选：Windows 版任务板用 bd 内置的数据库，不需要单独的 Dolt'), False),
    ("tailscale", "tailscale", "Tailscale.Tailscale", _t('lets two computers reach each other when they are not on the same network; not needed with one computer', '两台电脑不在同一网络时互相访问；只有一台电脑可以不装'), False),
]


def deps_table():
    return DEPS_WIN if P.IS_WIN else DEPS


def winget_command(pkg):
    return f"winget install -e --id {pkg} --silent --accept-package-agreements --accept-source-agreements"


# ---------------------------------------------------------------- state

def load_state():
    try:
        return json.load(open(INIT_FILE))
    except Exception:
        return {}


def save_state(**kw):
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    s = load_state()
    s.update(kw)
    json.dump(s, open(INIT_FILE, "w"), ensure_ascii=False, indent=2)
    return s


def which(name):
    if P.IS_WIN:
        # PATHEXT, no Store stubs, and the WinGet / Beads / Git folders a fresh install has not put
        # on this process's PATH yet.
        return P.which(name) or ""
    p = shutil.which(name, path=D.PATH_EXTRA + ":" + os.environ.get("PATH", ""))
    if p:
        return p
    if name == "tailscale" and os.path.exists("/Applications/Tailscale.app/Contents/MacOS/Tailscale"):
        return "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    return ""


def run(args, timeout=600, env=None, input_text=None, cwd=None):
    if P.IS_WIN:
        e = P.path_env()
    else:
        e = dict(os.environ)
        e["PATH"] = D.PATH_EXTRA + ":" + e.get("PATH", "")
    e.setdefault("BEADS_DIR", D.BEADS_DIR)
    e["BD_NON_INTERACTIVE"] = "1"
    if env:
        e.update(env)
    kw = {"creationflags": P.no_window_flags()} if P.IS_WIN else {}
    r = subprocess.run(args, capture_output=True, timeout=timeout, env=e, input=input_text.encode() if input_text else None, cwd=cwd, **kw)
    return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return ""


def machine():
    ov = D.overlay_network() if hasattr(D, "overlay_network") else {}
    return {"name": D.local_host_name(), "user": P.user_name() or os.path.basename(D.HOME), "arch": P.machine(),
            "tailscale_ip": D.tailscale_ip() or "", "lan_ip": lan_ip(), "overlay": ov}


# ---------------------------------------------------------------- deps

def clt_installed():
    """Apple ships /usr/bin/python3 and /usr/bin/git as stubs that pop an installer dialog until
    the Command Line Tools (or Xcode) exist; a stub on PATH is not the tool. Windows has no such
    stubs (P.which already skips the Store's python.exe), so there it counts as ready."""
    if P.IS_WIN:
        return True
    return os.path.isdir("/Library/Developer/CommandLineTools/usr/bin") or os.path.isdir("/Applications/Xcode.app/Contents/Developer")


def dep_path(name, binary):
    if name == "python":
        return sys.executable  # this wizard is running on it, so it is there and new enough
    path = which(binary)
    if path and path.startswith("/usr/bin/") and name == "git" and not clt_installed():
        return None
    return path


def deps_status():
    rows = []
    for name, binary, formula, why, required in deps_table():
        path = dep_path(name, binary)
        if P.IS_WIN:
            row = {"name": name, "found": bool(path), "path": path, "formula": formula, "why": why, "required": required,
                   "installable": bool(formula) and bool(which("winget")),
                   "command": winget_command(formula) if formula else ""}
        else:
            row = {"name": name, "found": bool(path), "path": path, "formula": formula, "why": why, "required": required,
                   "installable": bool(formula) and bool(which("brew"))}
        if name == "python":
            row["version"] = "%d.%d.%d" % sys.version_info[:3]
        rows.append(row)
    return rows


def deps_install(names):
    """brew install what is missing. Homebrew itself needs an admin password, so that one
    is a command for the user to paste into Terminal."""
    if P.IS_WIN:
        return deps_install_win(names)
    done, failed = [], []
    for name in names:
        dep = next((d for d in DEPS if d[0] == name), None)
        if not dep:
            failed.append({"name": name, "error": "unknown"}); continue
        _, binary, formula, _, _ = dep
        if dep_path(name, binary):
            done.append(name); continue
        if name == "brew":
            import mirrors  # in China, Homebrew's installer and packages from Tsinghua's mirror (Settings > Network)
            cmd = mirrors.HOMEBREW_INSTALL_CHINA if mirrors.use_china() else '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
            failed.append({"name": name, "error": _t('Homebrew is installed in Terminal (it needs an administrator password)', 'Homebrew 要在终端里装（需要管理员密码）'), "command": cmd}); continue
        if name == "tailscale":
            failed.append({"name": name, "error": _t('Tailscale is an app with a system extension: install it from the App Store, or https://tailscale.com/download', 'Tailscale 是带系统扩展的图形应用，去 App Store 装，或 https://tailscale.com/download'), "command": "open https://tailscale.com/download/mac"}); continue
        if not which("brew"):
            failed.append({"name": name, "error": _t('Install Homebrew first', '先装 Homebrew')}); continue
        import mirrors  # Homebrew's servers, or Tsinghua's mirror when they do not answer (Settings > Network)
        code, o, e = mirrors.run_with_mirrors(lambda argv, env: run(argv, timeout=1800, env=env),
                                              lambda china: ([which("brew"), "install", "--quiet", formula], mirrors.install_env(china, {})))
        if code == 0 and dep_path(name, binary):
            done.append(name)
        else:
            failed.append({"name": name, "error": (e or o).strip()[-800:]})
    return {"installed": done, "failed": failed}


def deps_install_win(names):
    """winget install what is missing (per user, no admin for these packages). A tool winget put in place may not be on this process's PATH yet, so
    a clean winget exit counts as installed."""
    done, failed = [], []
    for name in names:
        dep = next((d for d in DEPS_WIN if d[0] == name), None)
        if not dep:
            failed.append({"name": name, "error": "unknown"}); continue
        _, binary, pkg, _, _ = dep
        if dep_path(name, binary):
            done.append(name); continue
        if name == "winget":
            failed.append({"name": name, "error": _t('Windows 10/11 come with winget; without it, install App Installer from the Microsoft Store', 'Windows 10/11 自带 winget；没有就在 Microsoft Store 里装「应用安装程序」（App Installer）'), "command": "start ms-windows-store://pdp/?ProductId=9NBLGGH4NNS1"}); continue
        if not which("winget"):
            failed.append({"name": name, "error": _t('Install winget (App Installer) first', '先装 winget（「应用安装程序」）'), "command": winget_command(pkg)}); continue
        code, o, e = run([which("winget"), "install", "-e", "--id", pkg, "--silent", "--accept-package-agreements", "--accept-source-agreements"], timeout=1800)
        if code == 0 or dep_path(name, binary):
            done.append(name)
        else:
            failed.append({"name": name, "error": (e or o).strip()[-800:], "command": winget_command(pkg)})
    return {"installed": done, "failed": failed}


# ---------------------------------------------------------------- cli on PATH

def bundled_cli():
    return os.path.join(HERE, "dispatch.py")


def cli_status():
    if P.IS_WIN:
        link = os.path.join(shim_dir(), "dispatch.cmd")
        exists = os.path.exists(link)
        return {"link": link, "exists": exists, "target": bundled_cli() if exists else "", "bundled": bundled_cli(),
                "in_app": P.is_under(HERE, win_install_dir()), "on_path": bool(P.which("dispatch"))}
    link = os.path.join(D.HOME, ".local", "bin", "dispatch")
    target = os.path.realpath(link) if os.path.islink(link) or os.path.exists(link) else ""
    on_path = bool(shutil.which("dispatch"))
    return {"link": link, "exists": os.path.exists(link), "target": target, "bundled": bundled_cli(), "in_app": "/Contents/Resources/" in HERE, "on_path": on_path}


def shell_finds_dispatch(shell):
    """Does a NEW terminal find `dispatch`? Asked the way a terminal window starts the shell
    (login + interactive, so ~/.zshrc counts), then as a plain login shell if that one balks
    at having no terminal."""
    name = os.path.basename(shell)
    ask = "which dispatch" if name in ("tcsh", "csh", "nu") else "command -v dispatch"
    for flags in (("-c",) if name in ("tcsh", "csh") else ("-lic", "-lc")):
        try:
            r = subprocess.run([shell, flags, ask], capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL)
            if r.returncode == 0 and "dispatch" in r.stdout:
                return True
        except Exception:
            continue
    return False


def shell_says(shell, script, flags="-lic"):
    """One line from the person's own shell, started the way a terminal window starts it."""
    try:
        r = subprocess.run([shell, flags, script], capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL)
        lines = [l for l in r.stdout.splitlines() if l.strip()]
        return lines[-1].strip() if r.returncode == 0 and lines else ""
    except Exception:
        return ""


def zsh_dotdir(shell):
    """Where zsh reads .zprofile / .zshrc from: $ZDOTDIR when ~/.zshenv sets one, else home."""
    if not shell.endswith("zsh"):
        return D.HOME
    d = shell_says(shell, 'print -r -- "${ZDOTDIR:-$HOME}"', flags="-c")
    return d if d and os.path.isdir(d) else D.HOME


def may_link_into(d):
    """A folder of the person's PATH we may put a link into (a seam for the tests, which must
    never reach the real /opt/homebrew/bin)."""
    return os.access(d, os.W_OK)


def link_into_shell_path(shell, link):
    """Last resort when a new terminal still cannot find `dispatch` (a ~/.zshrc that rebuilds PATH
    from scratch, a shell framework, anything): ask that shell which folders it searches and put
    a link into one of them that this user may write to. Returns the link made, or ''."""
    csh = os.path.basename(shell) in ("tcsh", "csh")
    path = shell_says(shell, 'print -r -- "$PATH"' if shell.endswith("zsh") else 'string join : $PATH' if shell.endswith("fish") else 'echo "$PATH"', flags="-c" if csh else "-lic")
    dirs = [d for d in path.split(":") if d.startswith("/") and os.path.isdir(d)]
    home_first = sorted(dirs, key=lambda d: (not d.startswith(D.HOME), d not in ("/opt/homebrew/bin", "/usr/local/bin")))
    for d in home_first:
        if os.path.realpath(d) == os.path.realpath(os.path.dirname(link)) or "/conda" in d or "/envs/" in d or not may_link_into(d):
            continue
        extra = os.path.join(d, "dispatch")
        if os.path.exists(extra) and not os.path.islink(extra):
            continue  # something else of theirs is called dispatch here: leave it
        try:
            if os.path.islink(extra):
                os.remove(extra)
            os.symlink(link, extra)
            return extra
        except OSError:
            continue
    return ""


def cli_link():
    if P.IS_WIN:
        write_cli_shims()
        ensure_machine_id()
        return cli_path_setup()
    make_cli_link()
    ensure_machine_id()
    return cli_path_setup()


def ensure_machine_id():
    """~/.dispatch/machine-id from the first run on: it used to appear with the first worker only, so a
    brand-new Mac's `dispatch doctor` warned about it (fresh-Mac run 2026-09-29)."""
    try:
        D._mod("workers").machine_id(D.HOME)
    except Exception as e:
        D.debug("machine_id", e)


# Windows: no symlinks (a plain user may not make them). Two small launchers in ~/.local/bin instead:
# dispatch.cmd for cmd and PowerShell, and an extensionless sh script for Git Bash, which is where
# Claude Code's Bash tool runs. Helper scripts are not copied: the install folder is fixed, so the
# hooks point straight into it.

def shim_dir():
    return os.path.join(D.HOME, ".local", "bin")


def win_install_dir():
    return os.path.join(os.environ.get("LOCALAPPDATA") or os.path.join(D.HOME, "AppData", "Local"), "Dispatch")


def shim_python():
    """python.exe for the launchers: the interpreter running this (the one bundled with Dispatch),
    never pythonw.exe, which has no console to print into."""
    exe = sys.executable or "python"
    base = re.split(r"[\\/]", exe)[-1]
    if base.lower() == "pythonw.exe":
        exe = exe[: -len(base)] + "python.exe"
    return exe


def to_msys(p):
    """'C:\\Users\\x' -> '/c/Users/x', the form Git Bash wants in a script."""
    p = P.to_slash(p)
    m = re.match(r"^([A-Za-z]):/?(.*)$", p)
    return "/" + m.group(1).lower() + "/" + m.group(2) if m else p


def shim_texts(py=None, cli=None):
    """(dispatch.cmd, dispatch) contents for launching `cli` on `py`."""
    py, cli = py or shim_python(), cli or bundled_cli()
    cmd = "@echo off\r\nsetlocal\r\nset PYTHONUTF8=1\r\n\"%s\" \"%s\" %%*\r\n" % (py.replace("/", "\\"), cli.replace("/", "\\"))
    sh = "#!/bin/sh\n# Dispatch CLI (Git Bash)\nexport PYTHONUTF8=1\nexec \"%s\" \"%s\" \"$@\"\n" % (to_msys(py), to_msys(cli))
    return cmd, sh


def write_cli_shims():
    d = shim_dir()
    os.makedirs(d, exist_ok=True)
    cmd, sh = shim_texts()
    paths = {"dispatch.cmd": cmd, "dispatch": sh}
    for name, text in paths.items():
        dst = os.path.join(d, name)
        if P.is_link(dst):
            P.unlink_link(dst)
        with open(dst, "w", encoding="utf-8", newline="") as f:
            f.write(text)
    return [os.path.join(d, n) for n in paths]


def user_path_registry():
    """The per-user PATH as stored in HKCU\\Environment (what a NEW terminal gets), '' elsewhere."""
    if not P.IS_WIN:
        return ""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
            return winreg.QueryValueEx(k, "Path")[0] or ""
    except Exception:
        return ""


def win_finds_dispatch():
    """Does a new cmd window find `dispatch`? `where` with this process's PATH plus the per-user
    PATH from the registry (a new window gets both; this process only saw the old one)."""
    env = P.path_env()
    env["PATH"] = os.path.expandvars(user_path_registry()) + ";" + os.environ.get("PATH", "")
    try:
        r = subprocess.run(["cmd", "/c", "where", "dispatch"], capture_output=True, text=True, timeout=15, env=env,
                           stdin=subprocess.DEVNULL, creationflags=P.no_window_flags())
    except Exception:
        return False
    return r.returncode == 0 and any(P.same_path(os.path.dirname(l.strip()), shim_dir()) for l in r.stdout.splitlines() if l.strip())


def win_cli_path_setup():
    d = shim_dir()
    added = []
    try:
        if P.add_user_path(d):
            added.append("HKCU\\Environment\\Path")
    except Exception as e:
        D.debug("add_user_path", e)
    verified = win_finds_dispatch()
    save_state(cli_verified=verified)
    link = os.path.join(d, "dispatch.cmd")
    return {"link": link, "also_linked": "", "target": bundled_cli(), "path_files": added, "shell": "powershell", "verified": verified,
            "reopen": _t('Terminal windows already open need to be closed and opened again to know dispatch', '已经开着的终端窗口要关掉重开才认得 dispatch'),
            "note": "" if verified else _t(f"A new terminal does not find dispatch yet: add {d} to your PATH, or use the full path {link}", f"新开的终端里还找不到 dispatch：把 {d} 加进用户的 PATH，或直接用完整路径 {link}")}


def make_cli_link():
    link = os.path.join(D.HOME, ".local", "bin", "dispatch")
    os.makedirs(os.path.dirname(link), exist_ok=True)
    if os.path.islink(link) or os.path.exists(link):
        os.remove(link)
    os.symlink(bundled_cli(), link)
    os.chmod(bundled_cli(), 0o755)
    # Helper scripts the hooks and LaunchAgents point at, kept as links so an app update carries them along.
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    for f in ("presence.py", "edit-guard.py", "statusline-tee.sh"):
        src, dst = os.path.join(HERE, f), os.path.join(D.DISPATCH_DIR, f)
        if os.path.exists(src):
            if os.path.islink(dst) or os.path.exists(dst):
                os.remove(dst)
            os.symlink(src, dst)
    old = os.path.join(D.DISPATCH_DIR, "board-sync.sh")  # the whole-board sync is gone (2026-09-29)
    if os.path.islink(old):
        os.remove(old)


POSIX_PATH_LINE = 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH" ;; esac # dispatch'
CSH_PATH_LINE = 'if ( ":${PATH}:" !~ *":${HOME}/.local/bin:"* ) setenv PATH "${HOME}/.local/bin:/opt/homebrew/bin:${PATH}" # dispatch'
NU_PATH_LINE = '$env.PATH = ($env.PATH | split row (char esep) | prepend [($env.HOME | path join ".local" "bin") "/opt/homebrew/bin"] | uniq) # dispatch'


def shell_rc_plan(shell):
    """[(file, line)] for every shell this person may open a terminal with. zsh always (macOS's
    default, what Terminal.app starts); the others when they are this person's login shell or
    already have a config file here. Nothing is created for a shell nobody uses."""
    home = D.HOME
    have = lambda *names: [os.path.join(home, n) for n in names if os.path.exists(os.path.join(home, n))]
    name = os.path.basename(shell)
    plan = []
    # zsh: ~/.zprofile for login shells (Terminal.app, iTerm2), ~/.zshrc for interactive non-login
    # ones (tmux and Herdr panes, VS Code's terminal); .zshrc also runs after conda and friends.
    zdot = zsh_dotdir(shell if name == "zsh" else "/bin/zsh")
    plan += [(os.path.join(zdot, ".zprofile"), POSIX_PATH_LINE), (os.path.join(zdot, ".zshrc"), POSIX_PATH_LINE)]
    # bash reads only the FIRST of these three at login. Creating ~/.bash_profile for someone who
    # keeps everything in ~/.profile would silently switch their ~/.profile off, so: use the one
    # they have, and create ~/.bash_profile only when bash is their shell and none exists.
    bash_login = have(".bash_profile", ".bash_login", ".profile")[:1]
    if name == "bash" or have(".bash_profile", ".bash_login", ".bashrc"):
        plan.append(((bash_login or [os.path.join(home, ".bash_profile")])[0], POSIX_PATH_LINE))
        if name == "bash" or have(".bashrc"):
            plan.append((os.path.join(home, ".bashrc"), POSIX_PATH_LINE))
    # sh / ksh / dash, and anything else that follows POSIX, read ~/.profile at login.
    if name in ("sh", "ksh", "dash", "mksh", "ash") or have(".profile"):
        plan.append((os.path.join(home, ".profile"), POSIX_PATH_LINE))
    if name in ("tcsh", "csh") or have(".tcshrc", ".cshrc"):
        plan.append(((have(".tcshrc", ".cshrc") or [os.path.join(home, ".tcshrc" if name != "csh" else ".cshrc")])[0], CSH_PATH_LINE))
    for nu_dir in (os.path.join(home, "Library", "Application Support", "nushell"), os.path.join(home, ".config", "nushell")):
        if os.path.exists(os.path.join(nu_dir, "env.nu")):
            plan.append((os.path.join(nu_dir, "env.nu"), NU_PATH_LINE))
    seen, out = set(), []
    for f, line in plan:
        if os.path.realpath(f) not in seen:
            seen.add(os.path.realpath(f)); out.append((f, line))
    return out


def cli_path_setup():
    """Everything about a terminal FINDING the link. Separate from making it, so the app can redo
    this part on its own without touching where the link points."""
    if P.IS_WIN:
        return win_cli_path_setup()
    link = os.path.join(D.HOME, ".local", "bin", "dispatch")
    added = []
    # fish only for people who have it (not a stray ~/.config/fish on every Mac).
    if which("fish") or os.path.isdir(os.path.join(D.HOME, ".config", "fish")):
        fish = os.path.join(D.HOME, ".config", "fish", "conf.d", "dispatch.fish")
        if not os.path.exists(fish):
            os.makedirs(os.path.dirname(fish), exist_ok=True)
            open(fish, "w").write("# Dispatch CLI\nfish_add_path -g $HOME/.local/bin /opt/homebrew/bin\n")
            added.append(fish)
    shell = os.environ.get("SHELL") or "/bin/zsh"
    for rc, line in shell_rc_plan(shell):
        try:
            cur = open(rc).read()
        except FileNotFoundError:
            cur = ""
        except OSError:
            continue  # a config file we may not read is not ours to edit
        if "# dispatch" not in cur:
            try:
                open(rc, "a").write(("\n" if cur and not cur.endswith("\n") else "") + line + "\n")
                added.append(rc)
            except OSError:
                continue
    # Does a fresh login shell really find it? Said plainly, so "command not found" is no surprise.
    verified = shell_finds_dispatch(shell)
    also = ""
    if not verified:
        also = link_into_shell_path(shell, link)
        verified = bool(also) and shell_finds_dispatch(shell)
    save_state(cli_verified=verified)
    return {"link": link, "also_linked": also, "target": bundled_cli(), "path_files": added, "shell": os.path.basename(shell), "verified": verified,
            # A terminal window that was already open keeps its old PATH: say so, or the first thing
            # a new user types is `dispatch` in that window and gets "command not found".
            "reopen": _t('Terminal windows already open know dispatch once you open a new one (or run `exec $SHELL -l` in them)', '已经开着的终端窗口要新开一个（或在里面跑 `exec $SHELL -l`）才认得 dispatch'),
            "note": "" if verified else _t(f"A new {os.path.basename(shell)} terminal does not find dispatch yet: add ~/.local/bin to your PATH, or use the full path {link}", f"新开的 {os.path.basename(shell)} 终端里还找不到 dispatch：把 ~/.local/bin 加进 PATH，或直接用完整路径 {link}")}


# ---------------------------------------------------------------- board

def dolt_port():
    try:
        return int(open(os.path.join(SHARED, "dolt-server.port")).read().strip())
    except Exception:
        return 3308


def dolt_sql(q, timeout=30):
    return run([which("dolt") or "dolt", "--host", "127.0.0.1", "--port", str(dolt_port()), "--user", "root", "--password", "", "--no-tls", "--use-db", "task", "sql", "-q", q], timeout=timeout)


def dolt_server_up():
    try:
        with socket.create_connection(("127.0.0.1", dolt_port()), timeout=1):
            return True
    except OSError:
        return False


def board_server_log(lines=12):
    """The last lines the board's database server wrote, for showing to the person: whatever
    keeps it from starting (a port in use, a lock, a broken config) is said there."""
    for name in ("dolt-server.log", "launchd.log"):
        try:
            text = open(os.path.join(SHARED, name), encoding="utf-8", errors="replace").read().strip()
        except OSError:
            continue
        if text:
            return "\n".join(text.splitlines()[-lines:])[-1500:]
    return ""


# Windows v1 is a single-machine board on bd's embedded database: no Dolt server, no background jobs.
MULTI_MACHINE = _t('A shared Dolt service / a board for several Macs', '共享 Dolt 服务 / 多机任务板')


def board_is_embedded():
    """The board lives in bd's embedded database (no Dolt server to keep running): always on Windows;
    on the Mac a board made for this Mac alone (`dispatch init`, the default since bd and Dolt ship
    inside Dispatch IDE). bd records the mode in .beads/metadata.json."""
    if P.IS_WIN:
        return True
    try:
        return json.load(open(os.path.join(D.BEADS_DIR, "metadata.json"))).get("dolt_mode") == "embedded"
    except Exception:
        return False


def ensure_board_server(wait=25):
    """The board exists but its database server is not answering: bring it back. On the Mac that
    created the board the server is a keep-alive LaunchAgent (`dolt sql-server --config`); on a
    Mac that joined, `bd dolt start` on a timer. Returns {ok, started, how, log}."""
    if not os.path.exists(os.path.join(D.BEADS_DIR, "config.yaml")):
        return {"ok": False, "started": False, "how": "no board", "log": ""}
    if P.IS_WIN:
        return {"ok": True, "started": False, "how": "embedded", "log": ""}
    if board_is_embedded():
        return {"ok": True, "started": False, "how": "embedded", "log": ""}
    if dolt_server_up():
        fixed = sync_project_id()
        return {"ok": True, "started": fixed, "how": "project id repaired" if fixed else "already up", "log": ""}
    uid = os.getuid()
    own = L.label("dolt-server")
    own_plist = os.path.join(LAUNCH_DIR, own + ".plist")
    how = ""
    if os.path.exists(own_plist) or (load_state().get("board_mode") == "first" and os.path.exists(DOLT_CONFIG)):
        loaded = subprocess.run(["launchctl", "print", f"gui/{uid}/{own}"], capture_output=True).returncode == 0
        if loaded and os.path.exists(own_plist):
            subprocess.run(["launchctl", "kickstart", "-k", f"gui/{uid}/{own}"], capture_output=True)
            how = "kickstart"
        else:
            # Not loaded (or the file is gone): register it again, exactly as the board step did.
            write_plist(own, [which("dolt") or "dolt", "sql-server", "--config", DOLT_CONFIG], keep_alive=True, log=os.path.join(SHARED, "dolt-server.log"), cwd=os.path.dirname(DOLT_CONFIG))
            how = "bootstrap"
    else:
        run([which("bd") or "bd", "dolt", "start"], timeout=90, env={"BEADS_DIR": D.BEADS_DIR})
        how = "bd dolt start"
    up = wait_server(wait)
    if up:
        sync_project_id()
    return {"ok": up, "started": up, "how": how, "log": "" if up else board_server_log()}


def board_status():
    cfg = os.path.join(D.BEADS_DIR, "config.yaml")
    exists = os.path.exists(cfg)
    if exists:
        try:
            sync_project_id()  # a board set up by an older Dispatch under bd 1.3: repaired when the app opens
        except Exception as e:
            D.debug("sync_project_id", e)
    remote = ""
    if exists:
        m = re.search(r'remote:\s*"?([^"\n]+)"?', open(cfg).read())
        remote = m.group(1).strip() if m else ""
    st = load_state()
    if board_is_embedded():
        return {"dir": D.BEADS_DIR, "exists": exists, "remote": remote, "mode": st.get("board_mode", ""), "hub": st.get("hub"), "reverse_ssh": st.get("reverse_ssh"),
                "server_up": exists, "embedded": True, "server_log": "", "launchd": False, "sync_launchd": False, "remotesapi": False}
    return {"dir": D.BEADS_DIR, "exists": exists, "remote": remote, "mode": st.get("board_mode", ""), "hub": st.get("hub"), "reverse_ssh": st.get("reverse_ssh"),
            "server_up": dolt_server_up() if exists else False, "server_log": "" if not exists or dolt_server_up() else board_server_log(), "launchd": os.path.exists(os.path.join(LAUNCH_DIR, L.label("beads-dolt") + ".plist")),
            "sync_launchd": os.path.exists(os.path.join(LAUNCH_DIR, L.label("beads-sync") + ".plist")), "remotesapi": remotesapi_enabled()}


def kill_board_dolt():
    """Stop leftover Dolt servers of *this board* only (its config file, or started inside its
    data folder). A blanket `pkill -f "dolt sql-server"` would take down any Dolt the person
    runs for their own work."""
    if P.IS_WIN:
        P.unsupported(MULTI_MACHINE)
    r = subprocess.run(["pgrep", "-f", "dolt sql-server"], capture_output=True, text=True)
    for pid in [x for x in r.stdout.split() if x.isdigit()]:
        cmd = subprocess.run(["ps", "-o", "command=", "-p", pid], capture_output=True, text=True).stdout
        cwd = subprocess.run(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"], capture_output=True, text=True).stdout
        cwd = next((l[1:] for l in cwd.splitlines() if l.startswith("n")), "")
        ours = DOLT_CONFIG in cmd or SHARED in cmd or os.path.realpath(cwd or "/").startswith(os.path.realpath(SHARED))
        if ours:
            try:
                os.kill(int(pid), 15)
            except OSError:
                pass


def write_plist(label, args, env=None, interval=None, keep_alive=False, log=None, cwd=None):
    if P.IS_WIN:
        P.unsupported(MULTI_MACHINE)
    os.makedirs(LAUNCH_DIR, exist_ok=True)
    p = os.path.join(LAUNCH_DIR, f"{label}.plist")
    d = {"Label": label, "ProgramArguments": args, "RunAtLoad": True,
         "EnvironmentVariables": {"PATH": D.PATH_EXTRA + ":/usr/bin:/bin", "BEADS_DIR": D.BEADS_DIR, "BD_NON_INTERACTIVE": "1", **(env or {})}}
    if interval:
        d["StartInterval"] = interval
    if keep_alive:
        d["KeepAlive"] = True
    if log:
        d["StandardOutPath"] = d["StandardErrorPath"] = log
    if cwd:
        d["WorkingDirectory"] = cwd
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{label}"], capture_output=True)
    # Some of these carry the board's sync password in EnvironmentVariables: owner-only, from creation.
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        plistlib.dump(d, f)
    os.chmod(p, 0o600)
    r = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", p], capture_output=True, text=True)
    if r.returncode != 0:  # not in a GUI session (ssh): fall back to load
        subprocess.run(["launchctl", "load", p], capture_output=True)
    return p


def install_dolt_launchd(env=None):
    if P.IS_WIN:
        P.unsupported(MULTI_MACHINE)
    os.makedirs(SHARED, exist_ok=True)
    return write_plist(L.label("beads-dolt"), [which("bd") or "bd", "dolt", "start"], env=env, interval=120, log=os.path.join(SHARED, "launchd.log"))


def wait_server(seconds=40):
    for _ in range(seconds):
        if dolt_server_up():
            return True
        time.sleep(1)
    return False


def remotesapi_enabled():
    try:
        return bool(re.search(r"^remotesapi:\s*\n\s+port:\s*\d+", open(DOLT_CONFIG).read(), re.M))
    except FileNotFoundError:
        return False


def remotesapi_up():
    try:
        with socket.create_connection(("127.0.0.1", REMOTESAPI_PORT), timeout=1):
            return True
    except OSError:
        return False


def enable_remotesapi(force=False):
    """Let other Macs pull/push this board over HTTP on :3309. `bd dolt start` launches
    dolt with flags only and ignores config.yaml, so the hub runs dolt itself from a
    LaunchAgent that reads the config; bd just connects to the port."""
    if P.IS_WIN:
        P.unsupported(MULTI_MACHINE)
    if remotesapi_enabled() and remotesapi_up() and not force:
        return False
    try:
        cfg = open(DOLT_CONFIG).read()
    except FileNotFoundError:
        cfg = "log_level: warning\n"
    if not remotesapi_enabled():
        if not re.search(r"^listener:", cfg, re.M):
            cfg = cfg.rstrip("\n") + f"\nlistener:\n  host: 127.0.0.1\n  port: {dolt_port()}\n"
        cfg = cfg.rstrip("\n") + f"\nremotesapi:\n  port: {REMOTESAPI_PORT}\n"
        os.makedirs(os.path.dirname(DOLT_CONFIG), exist_ok=True)
        open(DOLT_CONFIG, "w").write(cfg)
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/" + L.label("beads-dolt")], capture_output=True)
    try:
        os.remove(os.path.join(LAUNCH_DIR, L.label("beads-dolt") + ".plist"))
    except FileNotFoundError:
        pass
    run([which("bd") or "bd", "dolt", "stop"], timeout=60)
    for _ in range(20):
        if not dolt_server_up():
            break
        time.sleep(0.5)
    kill_board_dolt()
    time.sleep(1)
    write_plist(L.label("dolt-server"), [which("dolt") or "dolt", "sql-server", "--config", DOLT_CONFIG], keep_alive=True, log=os.path.join(SHARED, "dolt-server.log"), cwd=os.path.dirname(DOLT_CONFIG))
    if not wait_server():
        raise RuntimeError(_t('The Dolt service did not start; see ~/.beads/shared-server/dolt-server.log', 'Dolt 服务没起来，看 ~/.beads/shared-server/dolt-server.log'))
    for _ in range(20):
        if remotesapi_up():
            break
        time.sleep(0.5)
    return True


def ensure_sync_user():
    """A MySQL user other Macs authenticate with; the password lives in `dispatch env`."""
    items = D.env_read()
    pw = next((i["value"] for i in items if i["name"] == "DOLT_REMOTE_PASSWORD"), "")
    if not pw:
        pw = secrets.token_urlsafe(18)
        items = [i for i in items if i["name"] not in ("DOLT_REMOTE_USER", "DOLT_REMOTE_PASSWORD")]
        items += [{"name": "DOLT_REMOTE_USER", "value": SYNC_USER, "note": _t("the board's sync user (for other Macs joining)", '任务板同步用户（其他电脑接入时用）')},
                  {"name": "DOLT_REMOTE_PASSWORD", "value": pw, "note": _t("the board's sync password (made by dispatch init)", '任务板同步密码（dispatch init 生成）')}]
        D.env_write(items)
    code, o, e = dolt_sql(f"CREATE USER IF NOT EXISTS '{SYNC_USER}'@'%' IDENTIFIED BY '{pw}'; GRANT ALL PRIVILEGES ON *.* TO '{SYNC_USER}'@'%';")
    if code != 0:
        raise RuntimeError(_t(f"Making the sync user failed: {(e or o).strip()[-400:]}", f"建同步用户失败：{(e or o).strip()[-400:]}"))
    return SYNC_USER, pw


BOARD_CONFIG = """# Dispatch global board — Beads shared-server mode (one Dolt server for the machine)
dolt:
    mode: server
    shared-server: true
    host: 127.0.0.1
    port: {port}
    user: root
    database: task
    auto-commit: "on"
no-git-ops: true
"""


def write_board_config(remote=""):
    """`bd init --shared-server` creates the database but, on a fresh Mac, leaves no
    config.yaml behind (it treats the workspace as embedded). Write the workspace files
    ourselves; they are what makes bd see the shared server."""
    import uuid
    os.makedirs(D.BEADS_DIR, exist_ok=True)
    cfg = BOARD_CONFIG.format(port=dolt_port())
    if remote:
        cfg += f'sync:\n    remote: "{remote}"\n'
    open(os.path.join(D.BEADS_DIR, "config.yaml"), "w").write(cfg)
    meta = os.path.join(D.BEADS_DIR, "metadata.json")
    if not os.path.exists(meta):
        json.dump({"database": "dolt", "backend": "dolt", "dolt_mode": "server", "dolt_database": "task", "project_id": str(uuid.uuid4())}, open(meta, "w"), indent=2)
    code, o, _ = run([which("bd") or "bd", "version"], timeout=20)
    m = re.search(r"(\d+\.\d+\.\d+)", o)
    if m:
        open(os.path.join(D.BEADS_DIR, ".local_version"), "w").write(m.group(1) + "\n")
    os.chmod(D.BEADS_DIR, 0o700)


def our_board_server_running():
    """True when a Dolt server of THIS board (its config file, or started in its data folder) is
    running: the only server whose answers we may trust about the board's identity."""
    if P.IS_WIN:
        P.unsupported(MULTI_MACHINE)
    r = subprocess.run(["pgrep", "-f", "dolt sql-server"], capture_output=True, text=True)
    for pid in [x for x in r.stdout.split() if x.isdigit()]:
        cmd = subprocess.run(["ps", "-o", "command=", "-p", pid], capture_output=True, text=True).stdout
        cwd = subprocess.run(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"], capture_output=True, text=True).stdout
        cwd = next((l[1:] for l in cwd.splitlines() if l.startswith("n")), "")
        if DOLT_CONFIG in cmd or SHARED in cmd or os.path.realpath(cwd or "/").startswith(os.path.realpath(SHARED)):
            return True
    return False


def db_project_id():
    """The identity the board's database carries (`metadata._project_id`, bd 1.3+); '' when the
    database has none (older bd) or cannot be asked."""
    code, o, _ = dolt_sql("SELECT value FROM metadata WHERE `key` = '_project_id'", timeout=20)
    m = re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", o) if code == 0 else None
    return m.group(0) if m else ""


def sync_project_id():
    """bd 1.3 refuses to connect when ~/tasks/.beads/metadata.json names another project than the
    database does (PROJECT IDENTITY MISMATCH). Dispatch writes that file itself on a fresh Mac, so
    it must carry the database's id, not an invented one. Also repairs boards set up by a version
    that invented one. Only ever against this board's own server. Returns True when it changed the file."""
    if board_is_embedded():
        return False  # embedded database: bd writes metadata.json itself
    meta = os.path.join(D.BEADS_DIR, "metadata.json")
    if not os.path.exists(meta) or not dolt_server_up() or not our_board_server_running():
        return False
    real = db_project_id()
    if not real:
        return False
    try:
        cur = json.load(open(meta))
    except Exception:
        return False
    if cur.get("project_id") == real:
        return False
    try:
        shutil.copy2(meta, meta + ".dispatch-bak")
    except OSError:
        pass
    cur["project_id"] = real
    tmp = meta + ".tmp"
    json.dump(cur, open(tmp, "w"), indent=2)
    os.replace(tmp, meta)
    return True


def board_works():
    sync_project_id()
    code, o, e = run([which("bd") or "bd", "list", "--json"], timeout=60, env={"BEADS_DIR": D.BEADS_DIR})
    return code == 0 and "[" in o, (e or o).strip()[-300:]


def board_first(hub=False):
    """This Mac starts the board. By default it is for this Mac alone, in bd's embedded database
    (board_first_embedded); `hub` makes it the hub other Macs join: a shared Dolt server kept
    running by launchd, remotesapi and a sync user."""
    if P.IS_WIN or not hub:
        return board_first_embedded()
    if not (which("bd") and which("dolt")):
        raise RuntimeError(_t('Install Beads and Dolt first (the step before)', '先装 Beads 和 Dolt（上一步）'))
    os.makedirs(D.BEADS_DIR, exist_ok=True)
    root = os.path.dirname(D.BEADS_DIR)
    if not os.path.exists(os.path.join(SHARED, "dolt", "task")):
        # Let bd create the shared server layout and the `task` database (it starts its own server for that).
        code, o, e = run([which("bd")] + board_init_args(), timeout=300, env={"BEADS_DIR": D.BEADS_DIR}, cwd=root)
        if code != 0 or not os.path.exists(os.path.join(SHARED, "dolt", "task")):
            raise RuntimeError(_t(f"bd init made no database: {(e or o).strip()[-600:]}", f"bd init 没建出数据库：{(e or o).strip()[-600:]}"))
    write_board_config()
    # From here on dolt runs from config.yaml (so remotesapi works); bd only connects to the port.
    enable_remotesapi(force=True)
    ok, why = board_works()
    if not ok:
        raise RuntimeError(_t(f"The board is made but bd cannot reach it: {why}", f"任务板建好了但 bd 连不上：{why}"))
    user, pw = ensure_sync_user()
    bd_metrics_off()
    save_state(board_mode="first", hub=None)
    return {"dir": D.BEADS_DIR, "root": root, "remote_for_others": f"http://{D.tailscale_ip() or lan_ip()}:{REMOTESAPI_PORT}/task", "sync_user": user}


def bd_metrics_off():
    """bd's anonymous usage reporting starts an extra `bd send-metrics` process after its commands, and
    Dispatch runs bd for every view and every Agent (one in every few bd runs on 10-10, at load 190).
    A board Dispatch makes has it off; `bd metrics on` turns it back on. Never fails the setup."""
    try:
        run([which("bd") or "bd", "metrics", "off"], timeout=30)
    except Exception as e:  # noqa: BLE001
        D.debug("bd metrics off", e)


def board_init_args(embedded=None):
    """`bd init` for a new board: bd's embedded database (Windows, and a Mac's own board), or one shared
    Dolt server (a Mac that is the hub). On the Mac bd leaves ~/tasks alone: no AGENTS.md, CLAUDE.md,
    agent hooks or git hooks of its own (Dispatch's task-board skill and hooks cover that)."""
    embedded = P.IS_WIN if embedded is None else embedded
    args = ["init"] + ([] if embedded else ["--shared-server"]) + ["--prefix", "task", "--non-interactive", "--quiet"]
    if embedded and not P.IS_WIN:
        args += ["--skip-agents", "--skip-hooks"]
    return args


BOARD_LOCKED = re.compile(r"locked by another dolt process|database is locked", re.I)


def board_first_embedded():
    """A board for this machine alone, in bd's embedded database. No server, no sync user, no
    config.yaml of ours (bd writes its own). bd comes from Dispatch IDE when nothing else has it."""
    if not which("bd"):
        raise RuntimeError("bd (Beads) is not installed")
    os.makedirs(D.BEADS_DIR, exist_ok=True)
    root = os.path.dirname(D.BEADS_DIR)
    # one maker at a time: a new user's first start and Add as project can both find no board at once, and the second
    # `bd init` then fails on the first one's database lock ("locked by another dolt process")
    lock = None
    try:
        import fcntl
        lock = open(os.path.join(root, ".dispatch-board-init.lock"), "a")
        fcntl.flock(lock, fcntl.LOCK_EX)
    except (ImportError, OSError):
        lock = None
    try:
        for attempt in range(3):
            if os.path.exists(os.path.join(D.BEADS_DIR, "config.yaml")):
                break
            code, o, e = run([which("bd")] + board_init_args(embedded=True), timeout=300, env={"BEADS_DIR": D.BEADS_DIR}, cwd=root)
            if code == 0:
                break
            if attempt == 2 or not BOARD_LOCKED.search(e or o or ""):
                raise RuntimeError(f"bd init did not create the board: {(e or o).strip()[-600:]}")
            time.sleep(3 * (attempt + 1))  # another process (bd, dolt) still holds the new database
    finally:
        if lock:
            lock.close()
    ok, why = board_works()
    if not ok:
        raise RuntimeError(f"the board was created but bd cannot open it: {why}")
    bd_metrics_off()
    save_state(board_mode="first", hub=None)
    return {"dir": D.BEADS_DIR, "root": root, "remote_for_others": "", "embedded": True}


def ensure_board():
    """A board, now: the existing one, or a new one for this Mac alone (embedded, no server). What a
    new user's first start runs, so the task board works without a setup step."""
    if os.path.exists(os.path.join(D.BEADS_DIR, "config.yaml")):
        return {"dir": D.BEADS_DIR, "created": False, "embedded": board_is_embedded()}
    return dict(board_first_embedded(), created=True)


def peers():
    """Other machines on this Tailscale network, so joining is a pick instead of typing an IP."""
    ts = which("tailscale")
    if not ts:
        return {"available": False, "peers": []}
    code, o, e = run([ts, "status", "--json"], timeout=15)
    if code != 0:
        return {"available": True, "peers": [], "error": (e or o).strip()[-200:]}
    try:
        st = json.loads(o)
    except ValueError:
        return {"available": True, "peers": []}
    rows = []
    for p in (st.get("Peer") or {}).values():
        ips = [ip for ip in (p.get("TailscaleIPs") or []) if "." in ip]
        if not ips:
            continue
        rows.append({"name": p.get("HostName") or p.get("DNSName", "").split(".")[0], "ip": ips[0], "online": bool(p.get("Online")), "os": p.get("OS", "")})
    rows.sort(key=lambda r: (not r["online"], r["name"]))
    return {"available": True, "self": {"name": (st.get("Self") or {}).get("HostName", ""), "ip": next((ip for ip in (st.get("Self") or {}).get("TailscaleIPs", []) if "." in ip), "")}, "peers": rows}


PAIRING = _t('Pairing two Macs', '两台机器的配对')


def ssh_key_setup(target, password):
    """Passwordless ssh to `target` without the user touching a terminal: make a key if
    there is none, run ssh-copy-id on a pty and type the password for it, then verify.
    The password is used once and never written anywhere."""
    if P.IS_WIN:
        P.unsupported(PAIRING)
    import pty, select
    key = os.path.join(D.HOME, ".ssh", "id_ed25519")
    if not os.path.exists(key + ".pub"):
        os.makedirs(os.path.dirname(key), mode=0o700, exist_ok=True)
        run(["ssh-keygen", "-t", "ed25519", "-N", "", "-f", key, "-q"], timeout=30)
    ok, _ = ssh_target_ok(target)
    if ok:
        return {"ok": True, "note": _t('it already works without a password', '本来就能免密')}
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp("ssh-copy-id", ["ssh-copy-id", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", "-i", key + ".pub", target])
    out, sent = b"", 0
    deadline = time.time() + 60
    try:
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 1.0)
            if not r:
                continue
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
            low = out.lower()
            if b"(yes/no" in low and b"yes\n" not in out:
                os.write(fd, b"yes\n")
            elif (b"password:" in low or b"passphrase" in low) and sent < 2 and low.rstrip().endswith(b":"):
                os.write(fd, password.encode() + b"\n"); sent += 1; out = b""
    finally:
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        os.close(fd)
    ok, why = ssh_target_ok(target)
    if not ok:
        text = out.decode("utf-8", "replace")
        hint = _t('Wrong password', '密码不对') if "permission denied" in text.lower() or sent >= 2 else _t('Cannot connect: make sure Remote Login is on on that Mac (System Settings → General → Sharing) and the address is user@IP', '连不上：确认那台电脑打开了「远程登录」（系统设置 → 通用 → 共享），地址是 用户名@IP')
        raise RuntimeError(f"{hint}（{text.strip()[-200:] or why}）")
    return {"ok": True, "note": _t("added to the other Mac's authorized_keys", '已加入对方的 authorized_keys')}


def ssh_target_ok(target):
    # ConnectTimeout covers the TCP connect only; a host that accepts and then stalls during key
    # exchange or authentication would hang the wizard for ever without the outer timeout.
    try:
        r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "StrictHostKeyChecking=accept-new", target, "echo ok"], capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return False, _t('No answer within 15 seconds: is that Mac on? Is Remote Login on? Is the address right?', '15 秒内没有回应：对方开着吗？「远程登录」打开了吗？地址对吗？')
    return r.returncode == 0 and "ok" in r.stdout, (r.stderr or r.stdout).strip()[-300:]


def rsync_from(target, src, dst, what, timeout=600):
    """Copy a folder from the hub; a stalled link ends with a readable error, not a spinner for ever."""
    if P.IS_WIN:
        P.unsupported(PAIRING)
    try:
        r = subprocess.run(["rsync", "-a", "--timeout=60", "-e", "ssh -o BatchMode=yes -o ConnectTimeout=8", f"{target}:{src}/", dst + "/"], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError(_t(f"Copying {what} from the hub did not finish within {timeout // 60} minutes: the network is too slow or down; try this step again later", f"从枢纽复制{what}超过 {timeout // 60} 分钟没完成：网络太慢或断了，稍后重试这一步"))
    if r.returncode != 0:
        raise RuntimeError(_t(f"Copying {what} from the hub failed: {r.stderr.strip()[-300:]}", f"从枢纽复制{what}失败：{r.stderr.strip()[-300:]}"))


REMOTE_LOGIN_STEP = _t('System Settings → General → Sharing → turn on Remote Login', '系统设置 → 通用 → 共享 → 打开「远程登录」')


def remote_login_on():
    """Is this Mac listening for ssh? 远程登录 opens port 22. The toggle itself is a GUI
    one (`systemsetup -setremotelogin` wants sudo), so all we can check is the port."""
    try:
        with socket.create_connection(("127.0.0.1", 22), timeout=1):
            return True
    except OSError:
        return False


def check_reverse_ssh(target="", addr=""):
    """Ask the hub to ssh back to this Mac. board_join puts the hub's key into our
    authorized_keys, but this Mac also has to listen: 远程登录 is off by default and the
    toggle needs the GUI, so when it is off we can only point at where to turn it on."""
    if P.IS_WIN:
        P.unsupported(PAIRING)
    st = load_state()
    target = target or (st.get("hub") or {}).get("ssh", "")
    if not target:
        return {"checked": False, "ok": False, "note": _t('This Mac is the hub (it joined no other Mac), so there is nothing to check back', '这台是枢纽（没有接入别的电脑），不用反向检查')}
    me = machine()
    addr = addr or (st.get("me") or {}).get("ssh") or f"{me['user']}@{me['tailscale_ip'] or me['lan_ip']}"
    local = remote_login_on()
    reachable, why = ssh_target_ok(target)
    res = {"checked": True, "ok": False, "ssh": addr, "hub": target, "local_remote_login": local}
    if not reachable:
        res["detail"] = why
        last = (why or "").strip().splitlines()[-1] if why else ""
        res["hint"] = _t(f"Cannot reach the hub {target}: {last or 'make sure that Mac is on and has Remote Login on too'}", f"连不上枢纽 {target}：{last or '确认那台电脑开着，并在那边也打开「远程登录」'}")
    else:
        cmd = f"ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new {shlex.quote(addr)} echo ok"
        try:
            r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", target, cmd], capture_output=True, text=True, timeout=30)
            res["ok"] = r.returncode == 0 and "ok" in r.stdout
            res["detail"] = (r.stderr or r.stdout).strip()[-300:]
        except Exception as e:
            res["detail"] = str(e)
        if not res["ok"]:
            res["hint"] = (_t(f"This Mac does not accept ssh: Remote Login is off. {REMOTE_LOGIN_STEP}, then click Check again.", f"本机没在监听 ssh：「远程登录」没开。{REMOTE_LOGIN_STEP}，打开后点「检查一次」。")
                           if not local else
                           _t(f"The hub {target} cannot reach {addr}: both Macs have to be on the same Tailscale network and this Mac’s firewall must not block ssh; if it still fails, turn Remote Login off and on again ({REMOTE_LOGIN_STEP}).", f"枢纽 {target} 连不回 {addr}：两台电脑要在同一个 Tailscale 网络，本机防火墙也别挡 ssh；还是不行就在 {REMOTE_LOGIN_STEP} 关掉再打开一次。"))
    save_state(reverse_ssh=res)
    return res


def remote_dispatch_json(target, args, timeout=90):
    cmd = "env " + D.remote_beads(None) + " $HOME/.local/bin/dispatch " + " ".join(args) + " --json"
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", target, cmd], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(_t(f"It failed on the other Mac: {(r.stderr or r.stdout).strip()[-400:]}", f"对方执行失败：{(r.stderr or r.stdout).strip()[-400:]}"))
    i = r.stdout.find("{")
    return json.loads(r.stdout[i:])


def hub_info():
    """Runs ON the hub, called over ssh by a Mac that wants to join: make sure the board is
    reachable from outside and hand back what the joiner needs."""
    if P.IS_WIN:
        P.unsupported(MULTI_MACHINE)
    if not os.path.exists(os.path.join(D.BEADS_DIR, "config.yaml")):
        raise RuntimeError(_t('This Mac has no task board yet: run dispatch init here first', '这台电脑还没有任务板，先在这里跑 dispatch init'))
    if not dolt_server_up():
        install_dolt_launchd()
        wait_server()
    enable_remotesapi()
    user, pw = ensure_sync_user()
    m = machine()
    ip = m["tailscale_ip"] or m["lan_ip"]
    pub = ""
    for k in ("id_ed25519.pub", "id_rsa.pub"):
        p = os.path.join(D.HOME, ".ssh", k)
        if os.path.exists(p):
            pub = open(p).read().strip(); break
    return {"name": m["name"], "user": m["user"], "ip": ip, "tailscale_ip": m["tailscale_ip"], "lan_ip": m["lan_ip"],
            "remote": f"http://{ip}:{REMOTESAPI_PORT}/task", "sync_user": user, "sync_password": pw, "pubkey": pub,
            "rules_dir": os.path.dirname(D.RULES_FILE), "pool": D.POOL, "dispatch": "$HOME/.local/bin/dispatch", "beads_dir": D.beads_dir_portable()}


def board_retire():
    """Put the local board aside (never deleted) so this Mac can join another one instead:
    stop the servers, move ~/tasks/.beads and the dolt data to timestamped backups."""
    if P.IS_WIN:
        P.unsupported(MULTI_MACHINE)
    import shutil
    stamp = time.strftime("%Y%m%d-%H%M")
    uid = os.getuid()
    for label in (L.label("dolt-server"), L.label("beads-dolt"), L.label("beads-sync")):
        subprocess.run(["launchctl", "bootout", f"gui/{uid}/{label}"], capture_output=True)
        try:
            os.remove(os.path.join(LAUNCH_DIR, f"{label}.plist"))
        except FileNotFoundError:
            pass
    run([which("bd") or "bd", "dolt", "stop"], timeout=60)
    kill_board_dolt()
    time.sleep(1)
    moved = []
    if os.path.exists(D.BEADS_DIR):
        dst = D.BEADS_DIR + f".retired-{stamp}"
        shutil.move(D.BEADS_DIR, dst); moved.append(dst)
    data = os.path.join(SHARED, "dolt", "task")
    if os.path.exists(data):
        dst = data + f".retired-{stamp}"
        shutil.move(data, dst); moved.append(dst)
    for f in ("dolt-server.lock", "dolt-server.pid", "dolt-server.port"):
        try:
            os.remove(os.path.join(SHARED, f))
        except FileNotFoundError:
            pass
    save_state(board_mode="", hub=None)
    return moved


def board_join(target, replace=False):
    """Join the board of `target` (user@host that already runs Dispatch). With replace, a
    board this Mac already has is retired first (kept as a backup, never deleted)."""
    if P.IS_WIN:
        P.unsupported(_t("Joining another Mac's board", '加入另一台机器的任务板'))
    if not (which("bd") and which("dolt")):
        raise RuntimeError(_t('Install Beads and Dolt first (the step before)', '先装 Beads 和 Dolt（上一步）'))
    retired = []
    if os.path.exists(os.path.join(D.BEADS_DIR, "config.yaml")):
        if not replace:
            raise RuntimeError(_t("This Mac has a board already; to join another one instead, tick Replace this Mac's board and try again (a backup of this board is kept)", '这台已经有任务板了；要改为接入另一台，勾选「替换本机任务板」再试（本机的板会留备份）'))
        retired = board_retire()
    ok, why = ssh_target_ok(target)
    if not ok:
        raise RuntimeError(_t(f"ssh cannot reach {target}: {why or 'turn on Remote Login on that Mac first and add the public key of this Mac there (ssh-copy-id)'}", f"ssh 连不上 {target}：{why or '要先在那台电脑打开「远程登录」，并把这台的公钥加过去（ssh-copy-id）'}"))
    hub = remote_dispatch_json(target, ["init", "hub-info"])
    env = {"DOLT_REMOTE_USER": hub["sync_user"], "DOLT_REMOTE_PASSWORD": hub["sync_password"], "BEADS_DIR": D.BEADS_DIR}
    os.makedirs(D.BEADS_DIR, exist_ok=True)
    if not os.path.exists(os.path.join(D.BEADS_DIR, "config.yaml")):
        install_dolt_launchd(env={"DOLT_REMOTE_USER": hub["sync_user"], "DOLT_REMOTE_PASSWORD": hub["sync_password"]})
        wait_server()
        code, o, e = run([which("bd"), "init", "--shared-server", "--prefix", "task", "--remote", hub["remote"], "--non-interactive", "--quiet"], timeout=600, env=env, cwd=os.path.dirname(D.BEADS_DIR))
        if code != 0 or not os.path.exists(os.path.join(SHARED, "dolt", "task")):
            raise RuntimeError(_t(f"Cloning the board from {hub['name']} failed: {(e or o).strip()[-600:]}", f"从 {hub['name']} 克隆任务板失败：{(e or o).strip()[-600:]}"))
        if not os.path.exists(os.path.join(D.BEADS_DIR, "config.yaml")):
            write_board_config(remote=hub["remote"])
        ok, why = board_works()
        if not ok:
            raise RuntimeError(_t(f"The board is cloned but bd cannot reach it: {why}", f"任务板克隆了但 bd 连不上：{why}"))
    else:
        install_dolt_launchd(env={"DOLT_REMOTE_USER": hub["sync_user"], "DOLT_REMOTE_PASSWORD": hub["sync_password"]})
        wait_server()
    # Same credentials here, so `dispatch env` agrees with the LaunchAgent.
    items = [i for i in D.env_read() if i["name"] not in ("DOLT_REMOTE_USER", "DOLT_REMOTE_PASSWORD")]
    items += [{"name": "DOLT_REMOTE_USER", "value": hub["sync_user"], "note": _t(f"the board's sync user (hub: {hub['name']})", f"任务板同步用户（枢纽：{hub['name']}）")},
              {"name": "DOLT_REMOTE_PASSWORD", "value": hub["sync_password"], "note": _t("the board's sync password", '任务板同步密码')}]
    D.env_write(items)
    # No task sync from here on (2026-09-29): every Mac keeps its own board and reads the other one over the
    # machine connection; what Dispatch knows about the user travels by itself (knowledge_sync.py).
    # Both Macs know each other.
    hub_entry = {"id": re.sub(r"[^a-z0-9]+", "-", hub["name"].lower()).strip("-") or "hub", "name": hub["name"], "ssh": f"{hub['user']}@{hub['ip']}", "dispatch": hub["dispatch"], **({"beads_dir": hub["beads_dir"]} if hub.get("beads_dir") and hub["beads_dir"] != "~/tasks/.beads" else {})}
    hs = [h for h in D.hosts() if h.get("ssh") != hub_entry["ssh"]] + [hub_entry]
    json.dump(hs, open(D.HOSTS_FILE, "w"), ensure_ascii=False, indent=2)
    ssh_config_follows(hs)
    me = machine()
    my_entry = {"id": re.sub(r"[^a-z0-9]+", "-", me["name"].lower()).strip("-") or "mac", "name": me["name"], "ssh": f"{me['user']}@{me['tailscale_ip'] or me['lan_ip']}", "dispatch": "$HOME/.local/bin/dispatch", **({"beads_dir": D.beads_dir_portable()} if D.beads_dir_portable() != "~/tasks/.beads" else {})}
    try:
        remote_dispatch_json(target, ["init", "add-host", "'" + json.dumps(my_entry, ensure_ascii=False) + "'"])
    except Exception as e:
        my_entry["registered_error"] = str(e)
    # Keys both ways: ours onto the hub (we can ssh there), theirs into ours.
    if hub.get("pubkey"):
        ak = os.path.join(D.HOME, ".ssh", "authorized_keys")
        os.makedirs(os.path.dirname(ak), mode=0o700, exist_ok=True)
        cur = open(ak).read() if os.path.exists(ak) else ""
        if hub["pubkey"] not in cur:
            open(ak, "a").write(("\n" if cur and not cur.endswith("\n") else "") + hub["pubkey"] + "\n")
            os.chmod(ak, 0o600)
    save_state(board_mode="join", hub={"name": hub["name"], "ssh": hub_entry["ssh"], "remote": hub["remote"],
                                       "rules_dir": hub.get("rules_dir", ""), "pool": hub.get("pool", "")}, me=my_entry)
    # The hub can only merge this Mac's sessions if it can ssh back here.
    reverse = check_reverse_ssh(target=hub_entry["ssh"], addr=my_entry["ssh"])
    return {"hub": hub_entry, "me": my_entry, "remote": hub["remote"], "retired": retired, "reverse_ssh": reverse}


def add_host(entry):
    hs = [h for h in D.hosts() if h.get("ssh") != entry.get("ssh") and h.get("id") != entry.get("id")] + [entry]
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    json.dump(hs, open(D.HOSTS_FILE, "w"), ensure_ascii=False, indent=2)
    ssh_config_follows(hs)
    return {"hosts": hs}


def ssh_config_follows(hs):
    """~/.dispatch/ssh/config (the SSH aliases Dispatch IDE opens other Macs' windows with) follows hosts.json."""
    import host_admin
    host_admin.D = D
    host_admin.sync_config_quietly(hs)


def set_self_name(name):
    """Rename this Mac's display name (Settings 页「机器」), independent of macOS's own
    ComputerName — kept in SELF_NAME_FILE so it isn't lost on a reinstall of Dispatch."""
    name = (name or "").strip()[:60]
    if not name:
        return {"error": _t('The name cannot be empty', '名字不能为空')}
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    try:
        aliases = set(json.load(open(D.SELF_NAME_FILE)).get("aliases") or [])
    except Exception:
        aliases = set()
    aliases.add(D.local_host_name())  # the old name: host:<old> task labels still map to this Mac
    json.dump({"name": name, "aliases": sorted(aliases - {name, ""})}, open(D.SELF_NAME_FILE, "w"), ensure_ascii=False)
    D._LOCAL_NAME = name  # bust dispatch.py's process-local cache
    return {"name": name}


def rename_peer(match, name):
    """Update the hosts.json entry identified by ssh address or id — either a peer telling
    us it renamed itself (matched by ssh, which stays put across a rename), or us fixing
    our own record of one after a `rename-self` push failed silently."""
    name = (name or "").strip()[:60]
    if not match or not name:
        return {"error": _t('ssh/id or the new name is missing', '缺 ssh/id 或新名字'), "updated": False}
    hs = D.hosts()
    hit = False
    for h in hs:
        if h.get("ssh") == match or h.get("id") == match:
            if h.get("name") and h["name"] != name:
                h["aliases"] = sorted((set(h.get("aliases") or []) | {h["name"]}) - {name})
            h["name"] = name
            hit = True
    if hit:
        os.makedirs(D.DISPATCH_DIR, exist_ok=True)
        json.dump(hs, open(D.HOSTS_FILE, "w"), ensure_ascii=False, indent=2)
        ssh_config_follows(hs)
    return {"updated": hit, "hosts": hs}


def remove_host(hid):
    """Drop a Mac from hosts.json: host_rows()/remote_dispatch() stop listing and ssh'ing
    it right away, since both read the file fresh each call."""
    if not hid:
        return {"error": _t('The id is missing', '缺 id'), "hosts": D.hosts()}
    hs = [h for h in D.hosts() if h.get("id") != hid]
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    json.dump(hs, open(D.HOSTS_FILE, "w"), ensure_ascii=False, indent=2)
    ssh_config_follows(hs)
    for p in glob.glob(os.path.join(D.REMOTE_DIR, f"{hid}.down")) + glob.glob(os.path.join(D.REMOTE_DIR, f"{hid}--*.json")):
        try:
            os.remove(p)
        except OSError:
            pass
    return {"hosts": hs}


def rename_self(name):
    """Rename this Mac, then best-effort tell every Mac in our hosts.json so their copy of
    us stays in sync — matched by our ssh address (stable across the rename, unlike name-
    derived ids)."""
    r = set_self_name(name)
    if r.get("error"):
        return r
    name = r["name"]
    me_ip = D.tailscale_ip() or lan_ip()
    me_user = os.environ.get("USER") or os.path.basename(D.HOME)
    me_ssh = f"{me_user}@{me_ip}" if me_ip else ""
    pushed, failed = [], []
    if me_ssh:
        for h in D.hosts():
            try:
                remote_dispatch_json(h["ssh"], ["init", "rename-peer", me_ssh, name])
                pushed.append(h["name"])
            except Exception:
                failed.append(h["name"])
    return {"name": name, "pushed": pushed, "failed": failed}


# ---------------------------------------------------------------- agents

def agents_status():
    rows = []
    for aid, (label, home) in AGENT_HOMES.items():
        found = os.path.isdir(home)
        eng = E.get(aid)
        hooks = eng.hooks_state() if found and eng.hooks_json else None
        rows.append({"id": aid, "name": label, "found": found, "home": home, "hooks": bool(hooks["installed"]) if hooks else None,
                     "edit_guard": _edit_guard_on(eng) if found and eng.edit_tools else None,
                     "rules": bool(E.get(aid).rules_file)})
    return rows


def hook_path(p):
    """A path as a hook command line carries it: shell-quoted, and on Windows absolute with forward slashes."""
    if P.IS_WIN:
        p = P.to_slash(p if P.is_abs(p) else os.path.abspath(p))
    return shlex.quote(p)


def hook_python():
    """The interpreter hooks run on: the one running this wizard (the app probed it for ≥ 3.9).
    A bare `python3` in a hook is whatever the agent's shell finds first, or nothing."""
    if P.IS_WIN:
        return shim_python()  # python.exe, not pythonw.exe: hooks print to stdout
    return sys.executable or "python3"


def keep_original(path, raw):
    """The person's settings as they were before Dispatch first added to them, kept once as <file>.pre-dispatch
    (<file>.dispatch-bak is only the version before the latest install, so a second install would lose it).
    Returns its path, or "" when there was nothing of theirs to keep."""
    import agent_files
    keep = path + ".pre-dispatch"
    if os.path.exists(keep):
        return keep
    if not raw or agent_files.MARK.search(raw):
        return ""
    with open(keep, "w", encoding="utf-8") as f:
        f.write(raw)
    return keep


def _edit_guard_on(eng):
    import hooks_setup
    return hooks_setup.switch(eng.agent, "edit-guard")


def agents_setup(selected, edit_guard=None):
    """Dispatch's one hook entry into each chosen agent (hooks_setup.py, through its adapter; Codex is made to trust
    it) and Dispatch's MCP server. `selected` may carry the flags `--edit-guard` / `--no-edit-guard` (from the
    app's checkbox): the guard refuses an edit when another session touched the same file in the last half hour,
    which protects people running several agents in one repository and only gets in the way of everyone else, so
    it is opt-in; it is a switch of the entry (on where the agent has edit tools to guard)."""
    if "--edit-guard" in selected:
        edit_guard = True
    elif "--no-edit-guard" in selected:
        edit_guard = False
    selected = [x for x in selected if not x.startswith("--")]
    if not selected:
        # `init run agents` with no names re-installs what was picked before; it never clears the pick
        selected = [x for x in load_state().get("agents") or [] if isinstance(x, str)]
    save_state(agents=selected)
    done = {}
    for agent in selected:
        eng = E.get(agent)
        if not (eng.hooks_json or eng.hooks_plugin):
            continue
        try:
            if edit_guard is not None and eng.edit_tools:
                import hooks_setup
                hooks_setup.switch(eng.agent, "edit-guard", bool(edit_guard))
            done[agent] = eng.install_hooks()
        except Exception as e:  # noqa: BLE001
            done[agent] = {"error": str(e)}
    # Dispatch's MCP server: the board's tools for every agent picked (dispatch_mcp.py); the Agents window adds it
    # again at each start for agents installed later
    try:
        import dispatch_mcp
        picked = [a for a in (E.get(x).agent for x in selected) if a in {e.agent for e in dispatch_mcp.engines()}]
        mcp = dispatch_mcp.register(picked, by_hand=False) if picked else {"changed": [], "same": [], "skipped": []}
    except Exception as e:  # noqa: BLE001
        mcp = {"error": str(e)}
    return {"agents": selected, "installed": done, "mcp": mcp}


# ---------------------------------------------------------------- rules and skills

STARTER_RULES_EN = """# Rules for every agent on this Mac (the one source is `~/.agents/rules/GLOBAL.md`; run `dispatch rules sync` after changing it)

How to use Dispatch itself (the task board, Waiting for you, preferences, the wiki) is in `~/.dispatch/rules/dispatch.md`, and how agents talk and work is in Soul (`~/.dispatch/rules/SOUL.md`); both come with Dispatch and are not repeated here; write your own rules here, and where they differ, these win.

## 0. Working on your own
- Once the goal is clear, carry it through to done; decide small things yourself and say so in one line of the report.
- The only actions that wait for my yes: anything sent out (email, messages, pull requests, comments). Nothing else needs asking.

## 1. How to build
- Do the simplest thing that works first; check the foundation before adding features.
- Check as much as the change calls for; remove temporary files at the end.
- Git: commit and push right after checking; the message is `<type>: <desc>`, with `(task-id)` at the end when there is a task.

## 2. Talking to me
- Pictures for me (screenshots, candidates, comparisons) go into a .md under the project's `design/` or `docs/` (pictures in the same folder, relative paths), registered with `dispatch docs add <project> <path> --kind design|research|review`; give the path in the conversation.
- Changes to how things look (layout, type, colour, spacing, components): read DESIGN.md in the project root first; when the look is not decided, show a draft first; afterwards show before and after screenshots.
- Answer in the language I write in.
"""

STARTER_RULES = """# 全局规则（这台电脑上所有 Agent · 唯一来源 `~/.agents/rules/GLOBAL.md` · 改完跑 `dispatch rules sync`）

Dispatch 自己的用法（任务板、Waiting for you、偏好、知识库）在 `~/.dispatch/rules/dispatch.md`，Agent 怎么说话做事在 Soul（`~/.dispatch/rules/SOUL.md`），都随 Dispatch 来，不在这里重复；这里写你自己的规矩，和它不一致时以这里为准。

## 0. 自主性
- 目标清楚就一直推进到完成，中途的小判断自己定，汇报里写一句即可。
- 唯一需要等我点头的动作：对外发送（邮件、消息、PR、评论）。其余不用问。

## 1. 实现纪律
- 先做最简单能跑的方案，先验证地基再堆功能。
- 与改动相称的验证就够；收尾删掉临时文件。
- Git：验证后立即 commit + push；commit 信息 `<type>: <desc>`，有任务时末尾加 `(task-id)`。

## 2. 沟通
- 给我看的图片（截图、候选图、对比图）写进项目 `design/` 或 `docs/` 下的一份 .md（图片放同目录、相对路径引用），用 `dispatch docs add <项目> <路径> --kind design|research|review` 登记，对话里给路径。
- 界面外观的改动（布局、字体、颜色、间距、组件）：先读项目根目录的 DESIGN.md；样子没定先出稿；改完给前后对比截图。
"""


SEED_LABEL = _t({"existing": "the ~/.agents/rules/GLOBAL.md you had", "starter": "a short starter", "imported": "imported from an agent's rules file you had", "copied": "copied from the hub"}, {"existing": "已有的 ~/.agents/rules/GLOBAL.md", "starter": "精简模板", "imported": "从已有的 Agent 规则文件导入", "copied": "从枢纽复制"})


def rules_status():
    st = load_state()
    have_rules = os.path.exists(D.RULES_FILE)
    have_pool = os.path.isdir(D.POOL)
    targets = []
    if have_rules:
        h = D.rules_digest()
        for ag in D.rule_sync_agents():
            state, p, _ = D.target_state(ag, h)
            targets.append({"agent": ag, "state": state, "path": p})
    task_board = os.path.join(D.POOL, "task-board")
    return {"rules": D.RULES_FILE, "have_rules": have_rules, "pool": D.POOL, "have_pool": have_pool, "task_board_skill": os.path.exists(task_board),
            "targets": targets, "seeded_from": st.get("rules_seed", "")}


BUILTIN_SKILLS = ("task-board", "delivery-page", "built-in-browser", "computer-use", "designer", "teaching-master", "animation-director", "leader", "neat-freak")
# Skills an earlier Dispatch copied into the pool as folders: a folder of that name written for the dispatch CLI
# is taken for an old copy and replaced by the link. A later built-in (designer) is only Dispatch's own when its
# SKILL.md is the shipped one word for word: many people have a designer skill of their own.
LEGACY_COPIED_SKILLS = ("task-board", "delivery-page", "built-in-browser", "computer-use")


def bundled_skill_dir():
    for c in (os.path.join(HERE, "..", "agent", "skills"), os.path.join(HERE, "agent", "skills"), os.path.join(HERE, "..", "..", "agent", "skills")):
        if os.path.isdir(c):
            return os.path.abspath(c)
    return ""


def builtin_skill_content(path, name):
    """Is the skill folder at `path` Dispatch's own `name` by its content: the same SKILL.md as the one
    shipped, or an older version of it (same frontmatter name, written for the dispatch CLI)."""
    if name not in BUILTIN_SKILLS:
        return False
    try:
        with open(os.path.join(path, "SKILL.md"), encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return False
    src = bundled_skill_dir()
    try:
        if src:
            with open(os.path.join(src, name, "SKILL.md"), encoding="utf-8") as f:
                if f.read() == text:
                    return True
    except OSError:
        pass
    if name not in LEGACY_COPIED_SKILLS:
        return False
    m = re.search(r"^name:\s*['\"]?([\w-]+)", text[:2000], re.M)
    return bool(m and m.group(1) == name and "dispatch " in text)


def link_builtin_skills(pool=None, backups=None):
    """The built-in skills in the pool are links to the copy that ships with this CLI, so they update
    with Dispatch. An earlier setup copied them into real folders: such a copy (recognised by name and
    content) is moved to `backups` and replaced by the link. A link to another checkout that exists (a
    developer's source tree) and a person's own skill of the same name are left alone."""
    pool = pool or D.POOL
    src = bundled_skill_dir()
    done = []
    if not src:
        return done
    os.makedirs(pool, exist_ok=True)
    for name in BUILTIN_SKILLS:
        target, dest, backup = os.path.join(src, name), os.path.join(pool, name), ""
        if not os.path.isfile(os.path.join(target, "SKILL.md")):
            continue
        if os.path.islink(dest):
            if os.path.isdir(dest):
                continue
            os.unlink(dest)  # a broken link
        elif os.path.exists(dest):
            if not os.path.isdir(dest) or not builtin_skill_content(dest, name):
                continue
            backup = os.path.join(backups or os.path.join(D.DISPATCH_DIR, "backups", "skills"),
                                  f"{name}-{time.strftime('%Y%m%d-%H%M%S')}")
            os.makedirs(os.path.dirname(backup), exist_ok=True)
            shutil.move(dest, backup)
        os.symlink(target, dest)
        done.append({"skill": name, "link": dest, "target": target, "backup": backup})
    return done


def rules_setup(mode=None, target=None):
    """First machine: keep whatever rules the user already has (or seed a starter).
    Joining: copy the hub's GLOBAL.md, FACTS.md and skills pool. Then sync to every agent."""
    st = load_state()
    mode = mode or st.get("board_mode") or "first"
    seed = ""
    os.makedirs(os.path.dirname(D.RULES_FILE), exist_ok=True)
    if mode == "join":
        target = target or (st.get("hub") or {}).get("ssh")
        if not target:
            raise RuntimeError(_t('It is not known which Mac is the hub: do the task board step first', '不知道枢纽是哪台电脑，先做「任务板」那一步'))
        # Source paths are the HUB's (it told us in hub-info), destination paths are ours: the two
        # Macs can have different account names, and their skill pools can live in different places.
        hub = st.get("hub") or {}
        rdir = os.path.dirname(D.RULES_FILE)
        rsync_from(target, hub.get("rules_dir") or "~/.agents/rules", rdir, _t('the rules', '规则'))
        os.makedirs(D.POOL, exist_ok=True)
        rsync_from(target, hub.get("pool") or "~/.cc-switch/skills", D.POOL, _t('the skill pool', '技能池'))
        seed = f"copied:{target}"
    elif os.path.exists(D.RULES_FILE):
        seed = "existing"
    else:
        # Import what the user already wrote for one agent, else the starter.
        for cand in (e.rules_target(D.HOME)["path"] for e in E.known() if e.rules_file):
            if os.path.exists(cand) and os.path.getsize(cand) > 200 and D.RULES_BEGIN not in open(cand).read():
                text = open(cand).read()
                open(D.RULES_FILE, "w").write(_t(f"# Rules for every agent (imported from {cand.replace(D.HOME, '~')} · the one source is `~/.agents/rules/GLOBAL.md` · run `dispatch rules sync` after changing it)\n\n", f"# 全局规则（从 {cand.replace(D.HOME, '~')} 导入 · 唯一来源 `~/.agents/rules/GLOBAL.md` · 改完跑 `dispatch rules sync`）\n\n") + text)
                seed = f"imported:{cand}"
                break
        else:
            open(D.RULES_FILE, "w").write(_t(STARTER_RULES_EN, STARTER_RULES))
            seed = "starter"
    os.makedirs(D.POOL, exist_ok=True)
    # The skills that ship with the app: task-board teaches agents the board, delivery-page the
    # delivery page every hand-over is (`dispatch deliver`).
    link_builtin_skills()
    # The helper agents that come with Dispatch (engineer, tester, researcher, designer…), for every engine here;
    # a file of the same name that is already there stays.
    try:
        import builtin_agents
        builtin_agents.sync()
    except Exception as e:  # noqa: BLE001
        D.debug("builtin agents", e)
    # Sync rules into every installed agent, mount the skill for those with a skills dir.
    code, o, e = run([sys.executable, bundled_cli(), "rules", "sync", "--json"], timeout=60)
    synced = json.loads(o[o.find("{"):]) if code == 0 and "{" in o else {"error": (e or o).strip()[-300:]}
    mounted = []
    for ag in D.AGENT_SKILL_DIRS:
        if os.path.isdir(os.path.dirname(D.AGENT_SKILL_DIRS[ag][0])):
            for name in BUILTIN_SKILLS:
                c, oo, ee = run([sys.executable, bundled_cli(), "skills", "enable", name, "--agent", ag], timeout=60)
                mounted.append({"agent": ag, "skill": name, "ok": c == 0, "msg": (oo or ee).strip().splitlines()[:1]})
    # an engine Dispatch reaches through a plugin of its own gets it (its adapter's setup_args)
    for eng in E.known():
        if eng.setup_args and eng.agent in AGENT_HOMES and os.path.isdir(AGENT_HOMES[eng.agent][1]):
            c, oo, ee = run([sys.executable, bundled_cli(), *eng.setup_args], timeout=60)
            mounted.append({"agent": eng.setup_label or eng.agent, "ok": c == 0, "msg": (oo or ee).strip().splitlines()[:1]})
    save_state(rules_seed=seed)
    return {"seed": seed, "seed_label": SEED_LABEL.get(seed.split(":")[0], seed) + ((" " + seed.split(":", 1)[1].replace(D.HOME, "~")) if ":" in seed else ""), "rules": D.RULES_FILE, "pool": D.POOL, "sync": synced, "mounted": mounted}


# ---------------------------------------------------------------- review

# Which agents can be handed the review: the ones Dispatch's in-app chat runs (E.runnable()).


def chosen_engine():
    """The engine a setup chore goes to: the first one picked at first run that Dispatch runs, else the first it runs."""
    picked = [x for x in load_state().get("agents") or [] if isinstance(x, str)]
    eng = next((e for e in E.runnable() if e.agent in picked), None) or E.runnable()[0]
    return eng.id


def review_agents():
    picked = load_state().get("agents") or []
    return [{"id": a, "kind": E.id_of(a), "name": AGENT_HOMES[a][0]} for a in AGENT_HOMES
            if E.get(a).runnable and (a in picked or os.path.isdir(AGENT_HOMES[a][1]))]


def review_prompt():
    agents = [AGENT_HOMES[a][0] for a in (load_state().get("agents") or []) if a in AGENT_HOMES]
    if _t("en", "zh") == "en":
        return (f"Dispatch was just installed on this Mac ({D.local_host_name()}). Review and trim the instructions all agents here share, then change them.\n\n"
                f"Scope: the global rules {D.RULES_FILE} (synced into each agent's entry file: `dispatch rules status`), the skill pool {D.POOL} (`dispatch skills list --json`), and what is outside the managed block in each agent's entry file. Agents in use: {', '.join(agents) or 'none picked'}.\n\n"
                "How to judge:\n"
                "- Remove first. Rules that make up for older models' judgement, planning or \"do not stop\" go or get weaker; current models need no hand-holding.\n"
                "- Give goals and boundaries, not step-by-step recipes. Keep architecture constraints, compatibility requirements, safety boundaries, product behaviour and meaningful acceptance criteria; drop \"first you must… then you must…\" unless the order itself is a business or safety constraint.\n"
                "- Context per task. Do not ask to read the whole repository, every document or every skill first.\n"
                "- Global and project do not repeat each other: project files keep only what this project alone needs (why architecture choices were made, code that must not change lightly, special folders and interfaces, the project's own build, test and release).\n"
                "- Safe, reversible actions go ahead on their own (reading and changing code, local builds, running tests, fixing failures you caused, authorized commits and pushes); stop only for what is irreversible, sent out, or where missing information would change a product decision.\n"
                "- Carry tasks to real completion, but do not turn that into a fixed procedure.\n"
                "- Test scope matches the risk of the change; drop \"always run the whole suite\".\n"
                "- Few, precise skills: merge those covering one task, narrow descriptions that are too wide, remove skills that only help older models; the root SKILL.md says only when and how to pick it, details go into sub-files.\n"
                "- Every rule has at least one reason to stay: models really get it wrong, the project behaves unlike common practice, breaking it costs a lot, a lasting preference of the person, or an important design decision. Ordinary engineering sense is not a rule.\n"
                "- When rules conflict, find the real intent and keep one; do not add rules to patch rules.\n\n"
                "How: list the audit first (entries to remove, change or keep and why, duplicates between global and project, skills to merge, cut or shorten, what most limits the agents), then change the files accordingly, run `dispatch rules sync`, and finish with one paragraph on what changed and why. Do not ask \"shall I\", and do not add a long set of special rules.")
    return (f"这台电脑（{D.local_host_name()}）刚装好 Dispatch。请审查并精简这里所有 Agent 共用的指令体系，然后直接改好。\n\n"
            f"范围：全局规则 {D.RULES_FILE}（它被同步到每个 Agent 的入口文件：`dispatch rules status`），技能池 {D.POOL}（`dispatch skills list --json`），以及各 Agent 入口文件里托管块之外的内容。用到的 Agent：{'、'.join(agents) or '未选择'}。\n\n"
            "判断原则：\n"
            "- 先做减法。为老模型补判断、补规划、补「别停下来」写的规则，删掉或弱化；当前模型不需要被手把手。\n"
            "- 给目标和边界，不写逐步菜谱。保留架构约束、兼容要求、安全边界、产品行为和有意义的验收标准；删掉「第一步必须…第二步必须…」，除非顺序本身是业务或安全约束。\n"
            "- 上下文按任务取。不要要求每次先通读仓库、全部文档或加载所有技能。\n"
            "- 全局与项目不重复：项目级文件只留「只有这个项目才需要知道」的内容（架构取舍的原因、不能随意改的实现、特殊目录和接口、项目特有的构建/测试/发布方式）。\n"
            "- 安全可逆的操作自主推进（读代码、改代码、本地构建、跑测试、修自己引入的失败、已授权的 commit/push）；只在不可逆、外发、或缺信息会改变产品决策时停下。\n"
            "- 任务推进到真正完成，但不要把这条扩写成一套固定流程。\n"
            "- 测试范围和改动风险匹配，删掉「一律跑完整套件」。\n"
            "- 技能少而准：合并覆盖同一任务的，收窄过宽的 description，删掉老模型辅助型技能；根 SKILL.md 只说何时用、怎么选，细节按需展开到子文件。\n"
            "- 每条规则至少有一个保留理由：模型确实常做错、项目行为和行业常规不同、违反代价明显、用户稳定偏好、或体现重要设计决策。普通工程常识不写成规则。\n"
            "- 规则冲突时先弄清真实意图，只留一条，不要再加规则去修补规则。\n\n"
            "做法：先列审计结果（建议删除/修改/保留的条目和理由、全局与项目的重复、技能的删并缩短建议、最可能限制发挥的地方），然后按结果直接改文件，改完跑 `dispatch rules sync`，最后用一段话说清改了什么、为什么。不要问「要不要」，也不要新增一套冗长的专用规则。")


HELPER_PROMPTS_EN = {
    "ssh": lambda target: (f"Set up password-free ssh from this Mac to {target}, then join its Dispatch task board. Steps:\n"
                           f"1) without ~/.ssh/id_ed25519 on this Mac, make one with ssh-keygen -t ed25519 -N '';\n"
                           f"2) ssh-copy-id {target} (it asks for the other Mac's login password: tell me to type it; if it cannot connect, tell me to turn on Remote Login on that Mac in System Settings → General → Sharing);\n"
                           f"3) check with ssh -o BatchMode=yes {target} echo ok;\n"
                           f"4) once it works, run `dispatch init run board join {target} --json` and tell me the result in one sentence."),
    "brew": lambda _: "Install Homebrew on this Mac (the official script; tell me when it needs my administrator password), then run `dispatch init run deps --json` to install dolt and beads, and tell me the result in one sentence.",
}
HELPER_PROMPTS = {
    "ssh": lambda target: (f"帮我把这台电脑到 {target} 的免密 ssh 打通，然后接入它的 Dispatch 任务板。步骤：\n"
                           f"1) 本机没有 ~/.ssh/id_ed25519 就 ssh-keygen -t ed25519 -N '' 生成；\n"
                           f"2) ssh-copy-id {target}（会要对方的登录密码，提示我来输；如果连不上，告诉我去那台电脑 系统设置→通用→共享 打开「远程登录」）；\n"
                           f"3) 验证 ssh -o BatchMode=yes {target} echo ok；\n"
                           f"4) 通了就跑 `dispatch init run board join {target} --json`，把结果用一句话告诉我。"),
    "brew": lambda _: "帮我在这台 Mac 上装 Homebrew（官方脚本，需要我输管理员密码时提醒我），装完跑 `dispatch init run deps --json` 把 dolt、beads 装上，最后用一句话告诉我结果。",
}


def helper_start(topic, arg="", agent="claude"):
    """Hand a setup chore to the agent on this Mac; it can type, wait for passwords and retry."""
    make = _t(HELPER_PROMPTS_EN, HELPER_PROMPTS).get(topic)
    if not make:
        raise RuntimeError(_t(f"No such helper: {topic}", f"没有这种帮手：{topic}"))
    prompt = make(arg)
    return start_agent(agent, D.HOME, _t(f"First-run setup: {topic}", f"首次设置：{topic}"), prompt)


def start_agent(agent, cwd, label, prompt):
    """An in-app chat in this Mac's Dispatch with the first message sent (`dispatch agent start`)."""
    try:
        code, o, e = run([sys.executable, bundled_cli(), "agent", "start", agent, "--cwd", cwd, "--label", label, "--prompt", prompt, "--no-wait", "--json"], timeout=180)
    except Exception as ex:
        return {"started": False, "error": str(ex), "prompt": prompt}
    if code == 0 and "{" in o:
        return {"started": True, "result": json.loads(o[o.find("{"):]), "prompt": prompt}
    return {"started": False, "error": (e or o).strip()[-400:], "prompt": prompt}


def review_start(agent="claude"):
    prompt = review_prompt()
    cwd = os.path.dirname(D.RULES_FILE)
    return start_agent(agent, cwd, _t('First-run setup: review rules and skills', '首次设置：审查规则与技能'), prompt)


# ---------------------------------------------------------------- about you (PROFILE.md)

def about_setup(name="", language="", machines=""):
    """The three first-run questions, written into PROFILE.md's 我是谁 (About me) like `dispatch
    profile add` does. Empty answers are skipped; the same answer twice is not written twice."""
    prof = D._mod("profile")
    answers = [("name", name.strip(), "Name: {}"), ("language", language.strip(), "Usual language: {}"),
               ("machines", ", ".join(m.strip() for m in re.split(r"[,，、\n]", machines or "") if m.strip()), "Machines: {}")]
    text = prof.profile_text()
    written = []
    for key, value, fmt in answers:
        if not value:
            continue
        fact = fmt.format(value)
        if fact in text:
            continue
        text = prof.profile_add_entry(text, "Who I am", prof.profile_entry_line(fact, "dispatch init"))
        written.append(fact)
    if written:
        prof.profile_write_content(text)
    save_state(about={k: v for k, v, _ in answers if v})
    return {"written": written, "path": prof.PROFILE_FILE}


def dispatch_dir_setup():
    """~/.dispatch with the shipped rules; an older skill pool, ~/.claude/agents and ~/.agents/rules
    are copied in and left as links (the originals stay as *.pre-dispatch)."""
    import dispatch_dir as DD
    done = DD.apply(DD.plan(), log=lambda s: None)
    return {"root": DD.root(), "steps": len(done)}


# ---------------------------------------------------------------- status / finish

def status():
    st = load_state()
    deps = deps_status()
    cli = cli_status()
    if cli["exists"] and cli["target"] and not st.get("cli_verified") and cli["in_app"]:
        # The person already asked for the terminal command; make sure a new terminal really finds
        # it (an update may know a better way than the version that first set it up). Once it is
        # confirmed this costs nothing any more.
        try:
            cli_path_setup()
            st = load_state()
        except Exception as e:
            D.debug("cli self-heal", e)
    board = board_status()
    agents = agents_status()
    rules = rules_status()
    missing_required = [d["name"] for d in deps if d["required"] and not d["found"]]
    steps = [
        {"id": "deps", "title": _t('What it needs', '装依赖'), "ok": not missing_required, "detail": (_t("missing ", "缺 ") + _t(", ", "、").join(missing_required)) if missing_required else _t('all there', '都在'), "deps": deps},
        {"id": "cli", "title": _t('Terminal command', '终端命令'), "ok": cli["exists"] and bool(cli["target"]), "detail": cli["link"].replace(D.HOME, "~") + (_t(' ready', ' 已就绪') if cli["exists"] else _t(' not yet', ' 还没有')), "cli": cli},
        {"id": "board", "title": _t("Task board", "任务板"), "ok": board["exists"] and board["server_up"], "detail": (_t("joined ", "已接入 ") + board["hub"]["name"]) if board.get("hub") else (_t("made; this Mac is the hub", "已建立，这台是枢纽") if board["exists"] else _t("no task board yet", "还没有任务板")), "board": board},
        {"id": "agents", "title": "Agent", "ok": bool(st.get("agents")), "detail": _t(", ", "、").join(AGENT_HOMES[a][0] for a in st.get("agents", []) if a in AGENT_HOMES) or _t("not picked yet", "还没选"), "agents": agents},
        {"id": "rules", "title": _t("Rules and skills", "规则与技能"), "ok": rules["have_rules"] and all(t["state"] == "synced" for t in rules["targets"] if os.path.isdir(os.path.dirname(t["path"]))), "detail": (_t("synced", "已同步") if rules["have_rules"] else _t("no shared rules yet", "还没有共同规则")), "rules": rules},
        {"id": "about", "title": _t("About you", "关于你"), "ok": bool(st.get("about")), "detail": " · ".join(v for v in (st.get("about") or {}).values()) or _t("your name, usual language, your Macs", "称呼、常用语言、有哪几台电脑"), "optional": True},
        {"id": "models", "title": _t("Models and summaries", "模型与总结"), "ok": bool(st.get("models")), "detail": models_detail(st.get("models", "")), "optional": True, "models": models_status()},
        {"id": "phone", "title": _t("Phone and notifications", "手机与通知"), "ok": bool(st.get("phone")), "detail": _t("seen", "已看过") if st.get("phone") else _t("optional: phone access, notifications to the phone", "可选：手机访问、推送到手机"), "optional": True},
        {"id": "review", "title": _t("Review", "审查优化"), "ok": bool(st.get("reviewed")), "detail": _t("an agent was sent to review", "已派 Agent 审查") if st.get("reviewed") else _t("optional: send an agent to review the rules and skills", "可选：派一个 Agent 审查规则和技能"), "optional": True, "agents": review_agents()},
    ]
    return {"done": bool(st.get("done")), "skipped": bool(st.get("skipped")), "machine": machine(), "steps": steps, "state": st,
            "all_ok": all(s["ok"] or s.get("optional") for s in steps)}


def finish(skipped=False):
    save_state(done=True, skipped=skipped, finished_at=int(time.time()))
    return status()


def reset():
    try:
        os.remove(INIT_FILE)
    except FileNotFoundError:
        pass
    return status()


# ---------------------------------------------------------------- terminal wizard

def ask(q, default=""):
    try:
        v = input(f"{q}{f' [{default}]' if default else ''}: ").strip()
    except EOFError:
        v = ""
    return v or default


def wizard():
    m = machine()
    print(_t(f"Dispatch first-run setup · this Mac: {m['name']} ({m['tailscale_ip'] or m['lan_ip'] or 'offline'})\n", f"Dispatch 首次设置 · 这台电脑：{m['name']}（{m['tailscale_ip'] or m['lan_ip'] or '没连网'}）\n"))
    st = status()
    # deps
    miss = [d for d in st["steps"][0]["deps"] if not d["found"]]
    print(_t("1/7 What it needs", "1/7 依赖"))
    for d in st["steps"][0]["deps"]:
        print(f"  {'✓' if d['found'] else ('·' if not d['required'] else '✗')} {d['name']:<10} {d['why']}")
    need = [d["name"] for d in miss if d["required"]]
    if need:
        if ask(_t(f"  Install {', '.join(need)}? (y/n)", f"  装上 {'、'.join(need)}？(y/n)"), "y").lower().startswith("y"):
            r = deps_install(need)
            for f in r["failed"]:
                print(f"  ✗ {f['name']}" + _t(": ", "：") + f"{f['error']}" + (_t("\n    In Terminal run: ", "\n    在终端跑：") + f"{f['command']}" if f.get("command") else ""))
            if r["failed"]:
                print(_t("  Run dispatch init again once what is missing is installed", "  装好缺的东西后再跑一次 dispatch init")); return
    print(_t("2/7 Terminal command", "2/7 终端命令")); r = cli_link(); print(f"  ✓ {r['link'].replace(D.HOME, '~')} → " + _t("the command line inside the app", "应用内置 CLI"))
    print(_t("3/7 Task board", "3/7 任务板"))
    b = board_status()
    if b["exists"]:
        print(_t("  ✓ Have one: ", "  ✓ 已有：") + b['dir'].replace(D.HOME, '~') + (_t(f" (joined {b['hub']['name']})", f"（接入 {b['hub']['name']}）") if b.get("hub") else ""))
    else:
        first = ask(_t("  Has another Mac got Dispatch already? no = make a board on this one, yes = join it (n/y)", "  有没有别的电脑已经装了 Dispatch？没有=在这台新建任务板，有=接入它 (n/y)"), "n").lower().startswith("n")
        if first:
            hub = ask(_t("  Will other Macs join this board later? yes = this Mac is the hub (it keeps a Dolt database service running), no = this Mac only (n/y)", "  以后要让别的电脑接入这块板吗？要=这台做枢纽（常驻一个 Dolt 数据库服务），不要=只这台用 (n/y)"), "n").lower().startswith("y")
            r = board_first(hub=hub)
            print(_t(f"  ✓ The board is made; other Macs join with {m['user']}@{m['tailscale_ip'] or m['lan_ip']}", f"  ✓ 任务板已建立；其他电脑接入时填 {m['user']}@{m['tailscale_ip'] or m['lan_ip']}") if hub
                  else _t("  ✓ The board is made (this Mac only, no database service)", "  ✓ 任务板已建立（只这台用，不起数据库服务）"))
        else:
            t = ask(_t("  That Mac's ssh address (user@Tailscale or local IP)", "  那台电脑的 ssh 地址（用户名@Tailscale 或局域网 IP）"))
            r = board_join(t); print(_t(f"  ✓ Copied the board from {r['hub']['name']}; from now on each Mac keeps its own board, and what Dispatch knows about you stays the same on both", f"  ✓ 已从 {r['hub']['name']} 复制任务板；以后每台只管自己的板，关于你的知识两台自动一致"))
            rev = r.get("reverse_ssh") or {}
            if rev.get("ok"):
                print(_t(f"  ✓ The hub {r['hub']['name']} can reach this Mac ({rev['ssh']})", f"  ✓ 枢纽 {r['hub']['name']} 能连回本机（{rev['ssh']}）"))
            elif rev.get("checked"):
                print(_t("  ✗ The hub cannot reach this Mac: ", "  ✗ 枢纽连不回本机：") + rev.get('hint', ''))
    print("4/7 Agent")
    found = [a for a in agents_status() if a["found"]]
    print(_t("  Found: ", "  检测到：") + (_t(", ", "、").join(a["name"] for a in found) or _t("none", "没有")))
    chosen = ask(_t("  Which ones? ids separated by commas", "  用哪些？逗号分隔 id"), ",".join(a["id"] for a in found))
    r = agents_setup([x.strip() for x in chosen.split(",") if x.strip()])
    done = [E.get(a).name for a, v in r["installed"].items() if not (v or {}).get("error")]
    print("  ✓ " + (_t(", ".join(done) + ": hooks installed", "、".join(done) + " 的 hooks 已装") if done else _t("recorded", "已记录")))
    print(_t("5/7 Rules and skills", "5/7 规则与技能")); d = dispatch_dir_setup(); r = rules_setup()
    print(_t(f"  ✓ {d['root'].replace(D.HOME, '~')} is ready; rules from: {SEED_LABEL.get(r['seed'].split(':')[0], r['seed'])}; synced to each agent", f"  ✓ {d['root'].replace(D.HOME, '~')} 已就绪；规则来源：{SEED_LABEL.get(r['seed'].split(':')[0], r['seed'])}；已同步到各 Agent"))
    print(_t("6/7 About you (agents remember it; change it any time with dispatch profile)", "6/7 关于你（Agent 会记住，随时可在 dispatch profile 里改）"))
    r = about_setup(ask(_t("  What should agents call you", "  怎么称呼你")), ask(_t("  Usual language", "  常用语言"), _t("English", "简体中文")), ask(_t("  Your computers (separated by commas, such as MacBook, Mac mini)", "  有哪几台电脑（逗号分隔，比如 MacBook, Mac mini）"), m["name"]))
    print(_t(f"  ✓ Written to {r['path'].replace(D.HOME, '~')}", f"  ✓ 已写进 {r['path'].replace(D.HOME, '~')}") if r["written"] else _t("  · skipped", "  · 跳过"))
    print(_t("7/7 Review (optional)", "7/7 审查优化（可选）"))
    if ask(_t("  Send an agent to review the rules and skills now? (y/n)", "  现在派一个 Agent 审查规则和技能？(y/n)"), "n").lower().startswith("y"):
        r = review_start(chosen_engine())
        print(_t("  ✓ Sent", "  ✓ 已派出") if r["started"] else _t(f"  It did not start ({r.get('error','')}). Give this to any agent:\n\n{r['prompt']}\n", f"  没起成（{r.get('error','')}）。把下面这段发给任意 Agent：\n\n{r['prompt']}\n"))
        save_state(reviewed=True)
    finish(); print(_t("\nDone. Open Dispatch IDE, or run `dispatch prime` in Terminal to see what agents will read.", "\n完成。打开 Dispatch IDE，或在终端 `dispatch prime` 看看 Agent 会读到什么。"))


# ---------------------------------------------------------------- models (opt-in)

def models_detail(choice):
    return _t('Not picked yet: until you pick, Dispatch sends nothing to a model', '还没选：在你选之前，Dispatch 不会把任何内容发给模型') if not choice else _t('Off: nothing is sent to any model', '已关闭：不向任何模型发送内容') if choice == "off" else _t(f"Summaries written by {choice}", f"用 {choice} 写总结")


def models_status():
    """What the 「模型与总结」 step shows: every model that could write summaries (subscription or
    API key, configured or not) and the uses that would run on their own once switched on."""
    import summarize as S
    try:
        uses = [{"key": k, "name": n, "desc": d, "enabled": S.use_enabled(k)} for k, n, d, _ in S.SUMMARY_USES]
    except Exception:
        uses = []
    return {"catalog": S.model_catalog(), "uses": uses, "subscription_clis": [e.id for e in S.subscription_engines()], "current": (D.settings_load().get("summary_model") or "")}


def models_setup(choice, uses=None):
    """Record the person's answer. `off` switches every automatic use off; a model id
    (`claude:haiku`, `zhipu:glm-5.3-flash`…) makes it the summary model and switches on the uses
    they ticked (all of them when none are named). API keys are stored separately, through
    `dispatch summarize set-key <provider>` with the key on stdin."""
    import summarize as S
    keys = [k for k, _, _, _ in S.SUMMARY_USES]
    cur = D.settings_load()
    if choice in ("", "off"):
        choice = "off"
        cur["summary_auto"] = 0
        cur["summary_uses"] = {k: (1 if k == "discuss" else 0) for k in keys}
    else:
        row = next((r for r in S.model_catalog() if r["id"] == choice), None)
        if row is None:
            raise RuntimeError(_t(f"No such model: {choice}", f"没有这个模型：{choice}"))
        if not row["configured"]:
            raise RuntimeError(_t(f"{row['label']} cannot be used yet: " + (f"no {row['provider']} command found" if row["subscription"] else f"fill in {row['env']} first"), f"{row['label']} 还不能用：" + (f"没找到 {row['provider']} 命令" if row["subscription"] else f"先填 {row['env']}")))
        wanted = set(uses or keys) | {"discuss"}
        cur["summary_model"] = choice
        cur["summary_auto"] = 1 if "session" in wanted else 0
        cur["summary_uses"] = {k: int(k in wanted) for k in keys}
    D.settings_save(cur)
    save_state(models=choice)
    return {"choice": choice, "uses": cur["summary_uses"]}


# ---------------------------------------------------------------- CLI entry

def main(a):
    op = a.op or "wizard"
    try:
        if op == "wizard":
            wizard(); return
        if op == "status":
            res = status()
        elif op == "peers":
            res = peers()
        elif op == "hub-info":
            res = hub_info()
        elif op == "add-host":
            res = add_host(json.loads(a.args[0]))
        elif op == "rename-self":
            res = rename_self(a.args[0] if a.args else "")
        elif op == "rename-peer":
            res = rename_peer(a.args[0] if a.args else "", a.args[1] if len(a.args) > 1 else "")
        elif op == "remove-host":
            res = remove_host(a.args[0] if a.args else "")
        elif op == "skip":
            res = finish(skipped=True)
        elif op == "finish":
            res = finish()
        elif op == "reset":
            res = reset()
        elif op == "ensure-board":
            res = ensure_board()
        elif op == "run":
            step, args = (a.args[0] if a.args else ""), a.args[1:]
            if step == "deps":
                res = deps_install(args or [d["name"] for d in deps_status() if d["required"] and not d["found"]])
            elif step == "cli":
                res = cli_link()
            elif step == "board-server":
                res = ensure_board_server()
                if not res["ok"]:
                    raise RuntimeError(_t("The board's database service does not start. The last it said:\n", "任务板的数据库服务起不来。它最后说的是：\n") + (res["log"] or _t("(the log is empty: ~/.beads/shared-server/dolt-server.log)", "（日志是空的：~/.beads/shared-server/dolt-server.log）")))
            elif step == "board":
                res = board_first(hub="hub" in args[1:]) if (args[:1] or ["first"])[0] == "first" else board_join(args[1], replace="replace" in args[2:])
            elif step == "agents":
                # The app's checkbox arrives as a real flag (`--edit-guard` / `--no-edit-guard`).
                res = agents_setup(args, edit_guard=getattr(a, "edit_guard", None))
            elif step == "rules":
                res = dict(rules_setup(), dispatch_dir=dispatch_dir_setup())
            elif step == "about":
                res = about_setup(*(list(args) + ["", "", ""])[:3])
            elif step == "models":
                res = models_setup(args[0] if args else "off", args[1:])
            elif step == "phone":
                save_state(phone=True); res = {"phone": True}
            elif step == "review":
                res = review_start(args[0] if args else (review_agents() or [{"kind": "claude"}])[0]["kind"]); save_state(reviewed=True)
            elif step == "reverse-ssh":
                res = check_reverse_ssh(args[0] if args else "")
            elif step == "ssh-key":
                pw = sys.stdin.read().rstrip("\n") if not sys.stdin.isatty() else ""
                if not pw:
                    raise RuntimeError(_t('Pass the password on standard input', '密码从标准输入传入'))
                res = ssh_key_setup(args[0], pw)
            elif step == "helper":
                res = helper_start(args[0] if args else "", args[1] if len(args) > 1 else "", chosen_engine())
            else:
                raise RuntimeError(_t(f"Unknown step {step}", f"未知步骤 {step}"))
        else:
            raise RuntimeError(_t(f"Unknown operation {op}", f"未知操作 {op}"))
    except P.Unsupported as e:
        # Convention for features that only exist on the Mac: said plainly, not an error exit.
        if a.json:
            print(json.dumps({"ok": False, "unsupported": True, "message": str(e), "error": str(e)}, ensure_ascii=False)); return
        print(str(e)); sys.exit(2)
    except subprocess.TimeoutExpired as e:
        msg = _t(f"This step did not finish within {int(e.timeout)} s ({os.path.basename(str(e.cmd[0] if isinstance(e.cmd, (list, tuple)) else e.cmd))}): the other Mac or the network does not answer; try again later", f"这一步超过 {int(e.timeout)} 秒没完成（{os.path.basename(str(e.cmd[0] if isinstance(e.cmd, (list, tuple)) else e.cmd))}）：对方电脑或网络没有回应，稍后重试")
        if a.json:
            print(json.dumps({"error": msg}, ensure_ascii=False)); sys.exit(1)
        print(f"✗ {msg}"); sys.exit(1)
    except Exception as e:
        if a.json:
            print(json.dumps({"error": str(e)}, ensure_ascii=False)); sys.exit(1)
        print(f"✗ {e}"); sys.exit(1)
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(res, ensure_ascii=False, indent=2))
