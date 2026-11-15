# -*- coding: utf-8 -*-
"""Dispatch's LaunchAgents: the plist and the launchctl calls behind `dispatch serve install` (the
phone service) and `dispatch chatd install` (the resident chat daemon). Labels come from
launchd_labels. Every job runs in the user's GUI domain (`gui/<uid>`), is written 0600 under
~/Library/LaunchAgents and logs to a 0600 file under ~/tasks/.dispatch.
"""
import os
import plistlib
import subprocess
import time

import launchd_labels

HOME = os.path.expanduser("~")
# named for what macOS shows: "“Dispatch IDE” is an item that can run in the background", as in Login Items
LAUNCHER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "launch", "Dispatch IDE")
STOP_WAIT = 20.0  # how long `install` waits for launchd to let a booted-out job go
# launchd starts jobs with a bare PATH: Homebrew (node, codex, bd), the system, ~/.local/bin (claude, dispatch)
PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + os.path.join(HOME, ".local", "bin")


def plist_path(label, launch_dir=None):
    return os.path.join(launch_dir or launchd_labels.LAUNCH_DIR, label + ".plist")


def job(label):
    return f"gui/{os.getuid()}/{label}"


def in_app(path):
    """A file inside a macOS app bundle (Dispatch IDE.app ships the CLI in Contents/Resources)."""
    return ".app/Contents/" in path


def plist_body(label, program, log, env=None, keep_alive=True, throttle=10):
    """The LaunchAgent: starts at login, `keep_alive` restarts it whenever it exits (no sooner than
    `throttle` seconds after the last start), stdout and stderr to `log`. From inside the app the program starts
    through LAUNCHER, so macOS shows the job as Dispatch IDE rather than python3 (task-7mmi3)."""
    program = list(program)
    if in_app(LAUNCHER) and not in_app(program[0]):
        program = [LAUNCHER] + program
    return {"Label": label, "ProgramArguments": program,
            "EnvironmentVariables": dict({"PATH": PATH}, **(env or {})),
            "RunAtLoad": True, "KeepAlive": bool(keep_alive), "ThrottleInterval": int(throttle),
            "StandardOutPath": log, "StandardErrorPath": log}


def private_log(path):
    """Create the log file 0600 (launchd would make it world-readable)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600))
    os.chmod(path, 0o600)


def install(body, launch_dir=None):
    """Write the plist (replacing a loaded one) and load it. Returns the plist's path."""
    label = body["Label"]
    d = launch_dir or launchd_labels.LAUNCH_DIR
    os.makedirs(d, exist_ok=True)
    path = plist_path(label, d)
    stop(label)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        plistlib.dump(body, f)
    load(path)
    return path


def stop(label, wait=STOP_WAIT):
    """Boot the job out and wait until launchd has let it go: `bootout` returns while the old process is still
    closing, and a `bootstrap` in that time fails ("Bootstrap failed: 5: Input/output error"), which left a
    reinstalled chatd not loaded at all (task-0mwh)."""
    subprocess.run(["launchctl", "bootout", job(label)], capture_output=True)
    end = time.time() + wait
    while loaded(label) and time.time() < end:
        time.sleep(0.2)


def load(path, tries=5):
    """Bootstrap the plist into the GUI domain, again a few times while launchd still has the old job; `load`
    when there is no GUI session (ssh)."""
    r = None
    for i in range(tries):
        r = subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", path], capture_output=True, text=True)
        if r.returncode == 0:
            return True
        time.sleep(0.5 * (i + 1))
    subprocess.run(["launchctl", "load", path], capture_output=True)
    return False


def uninstall(label, launch_dir=None):
    subprocess.run(["launchctl", "bootout", job(label)], capture_output=True)
    try:
        os.remove(plist_path(label, launch_dir))
    except FileNotFoundError:
        pass


def installed(label, launch_dir=None):
    return os.path.exists(plist_path(label, launch_dir))


def info(label):
    """{"loaded": bool, "pid": int | None} from `launchctl print`."""
    r = subprocess.run(["launchctl", "print", job(label)], capture_output=True, text=True)
    if r.returncode != 0:
        return {"loaded": False, "pid": None}
    pid = None
    for line in (r.stdout or "").splitlines():
        k, _, v = line.strip().partition(" = ")
        if k == "pid" and v.strip().isdigit():
            pid = int(v.strip())
            break
    return {"loaded": True, "pid": pid}


def loaded(label):
    return subprocess.run(["launchctl", "print", job(label)], capture_output=True).returncode == 0


def kickstart(label, restart=False):
    """Start the job now (`restart`: kill the running one first). True when launchctl took it."""
    return subprocess.run(["launchctl", "kickstart"] + (["-k"] if restart else []) + [job(label)], capture_output=True).returncode == 0
