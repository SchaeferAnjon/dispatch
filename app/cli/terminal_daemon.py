# -*- coding: utf-8 -*-
"""The process that keeps the Agents window's terminals running when Dispatch is closed (app/termd/termd.cjs).

    dispatch terminal daemon start [--app-root DIR]   start it if it is not running; answers where it listens
    dispatch terminal daemon status                    whether it runs, and its terminals
    dispatch terminal daemon stop                      end it: its terminals stop and come back from disk next time

The daemon runs on the Electron that comes with Dispatch IDE (`ELECTRON_RUN_AS_NODE=1 "<app binary>"`), with that
app's node-pty and headless xterm, so nothing else needs installing. It is started in a process group of its own
(not a LaunchAgent): quitting Dispatch leaves it and its terminals running, as Orca's terminal daemon does, and a
Mac restart ends it (the terminals then come back from disk with their last screen and start again).

Its files are in <DISPATCH_DIR>/termd (daemon.json with port and token, readable only by this user; termd.log;
sessions/). dispatch-bridge passes `--app-root` (vscode.env.appRoot); the CLI packed inside the app finds it on its
own.
"""
import json
import os
import plistlib
import signal
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
START_WAIT_S = 10.0


def dispatch_dir():
    return os.environ.get("DISPATCH_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".dispatch")


def state_dir():
    return os.path.join(dispatch_dir(), "termd")


def script_path(root=""):
    """termd.cjs: app/termd next to app/cli in the repository, termd/ next to cli/ in the packed CLI; for a copy of
    the CLI without it (a test instance's), the one packed inside the app."""
    own = os.path.join(os.path.dirname(HERE), "termd", "termd.cjs")
    if os.path.isfile(own) or not root:
        return own
    packed = os.path.join(root, "dispatch-cli", "dispatch", "termd", "termd.cjs")
    return packed if os.path.isfile(packed) else own


def _app_root_from_here():
    marker = os.sep + os.path.join("Contents", "Resources", "app") + os.sep
    i = HERE.find(marker)
    return HERE[:i + len(marker) - 1] if i >= 0 else ""


def app_root(given=""):
    """Dispatch IDE's Resources/app: the one asked for, the one this CLI is packed in, or the installed app."""
    for cand in (given, os.environ.get("DISPATCH_IDE_APP_ROOT", ""), _app_root_from_here(),
                 "/Applications/Dispatch IDE.app/Contents/Resources/app"):
        if cand and os.path.isdir(cand):
            return os.path.abspath(cand)
    return ""


def app_binary(root):
    """The app's main executable (Contents/MacOS/<CFBundleExecutable>) for a Resources/app folder, or ''."""
    if not root:
        return ""
    # a development build (ide/dev.sh) runs from its source tree: its Electron is named in .build/dispatch-dev.json
    try:
        with open(os.path.join(root, ".build", "dispatch-dev.json")) as f:
            exe = json.load(f).get("binary") or ""
        return exe if os.access(exe, os.X_OK) else ""
    except (OSError, ValueError, AttributeError):
        pass
    contents = os.path.dirname(os.path.dirname(root))
    name = ""
    try:
        with open(os.path.join(contents, "Info.plist"), "rb") as f:
            name = plistlib.load(f).get("CFBundleExecutable", "")
    except Exception:
        pass
    macos = os.path.join(contents, "MacOS")
    if not name and os.path.isdir(macos):
        files = sorted(os.listdir(macos))
        name = files[0] if len(files) == 1 else ""
    exe = os.path.join(macos, name) if name else ""
    return exe if exe and os.access(exe, os.X_OK) else ""


def _read_info():
    try:
        with open(os.path.join(state_dir(), "daemon.json")) as f:
            return json.load(f)
    except Exception:
        return None


def _alive(pid):
    try:
        os.waitpid(int(pid), os.WNOHANG)  # reap it when it was started by this process and has ended
    except Exception:
        pass
    try:
        os.kill(int(pid), 0)
        return True
    except PermissionError:
        return True
    except Exception:
        return False


def _health(info, timeout=1.5):
    try:
        url = f"http://127.0.0.1:{int(info['port'])}/health?token={info['token']}"
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def _answer(info, health):
    return {"ok": True, "running": True, "pid": info["pid"], "port": info["port"], "token": info["token"],
            "version": info.get("version"), "url": f"ws://127.0.0.1:{info['port']}/ws?token={info['token']}",
            "sessions": (health or {}).get("sessions", [])}


def status():
    info = _read_info()
    if info and _alive(info.get("pid", 0)):
        health = _health(info)
        if health:
            return _answer(info, health)
    return {"ok": True, "running": False, "sessions": []}


def kept_sessions():
    """Terminals kept on disk from an earlier daemon (they come back when it starts)."""
    try:
        return [n for n in os.listdir(os.path.join(state_dir(), "sessions")) if not n.startswith(".")]
    except Exception:
        return []


def start(given_root="", if_kept=False):
    """Starts the daemon when it is not running. `if_kept`: only when there are terminals to bring back (a window
    opening asks this way, so a Mac where nobody opened a terminal runs no daemon)."""
    now = status()
    if now["running"]:
        return now
    if if_kept and not kept_sessions():
        return {"ok": True, "running": False, "sessions": []}
    root = app_root(given_root)
    exe = app_binary(root)
    script = script_path(root)
    if not exe:
        return {"ok": False, "running": False, "message": "Dispatch could not find Dispatch IDE to run its terminals. Open Dispatch IDE and try again."}
    if not os.path.isfile(script):
        return {"ok": False, "running": False, "message": f"The terminal service is missing from this copy of Dispatch ({script})."}
    d = state_dir()
    os.makedirs(d, mode=0o700, exist_ok=True)
    env = dict(os.environ, ELECTRON_RUN_AS_NODE="1")
    with open(os.path.join(d, "termd.log"), "ab") as log:
        hook = ["--hook-python", sys.executable or "python3", "--hook-script", os.path.join(HERE, "terminal_hook.py")]
        proc = subprocess.Popen([exe, script, "--state", d, "--app-root", root, *hook], env=env, cwd=os.path.expanduser("~"),
                                stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
    deadline = time.time() + START_WAIT_S
    while time.time() < deadline:
        code = proc.poll()
        info = _read_info()
        if info and (info.get("pid") == proc.pid or code is not None) and _alive(info.get("pid", 0)):
            health = _health(info)
            if health:
                return _answer(info, health)
        if code is not None and code != 3:
            break
        time.sleep(0.1)
    tail = ""
    try:
        with open(os.path.join(d, "termd.log"), "rb") as f:
            tail = f.read()[-600:].decode("utf-8", "replace").strip().splitlines()[-1:]
            tail = tail[0] if tail else ""
    except Exception:
        pass
    return {"ok": False, "running": False, "message": "The terminal service did not start." + (f" ({tail})" if tail else "")}


def stop():
    info = _read_info()
    if not info or not _alive(info.get("pid", 0)):
        return {"ok": True, "running": False, "stopped": False}
    try:
        os.kill(int(info["pid"]), signal.SIGTERM)
    except Exception as e:
        return {"ok": False, "running": True, "message": f"Could not stop the terminal service: {e}"}
    for _ in range(50):
        if not _alive(info["pid"]):
            break
        time.sleep(0.1)
    return {"ok": True, "running": _alive(info["pid"]), "stopped": True}


def command(op, given_root="", if_kept=False):
    if op == "start":
        return start(given_root, if_kept)
    if op == "status":
        return status()
    if op == "stop":
        return stop()
    return {"ok": False, "message": "dispatch terminal daemon start | status | stop"}


if __name__ == "__main__":
    print(json.dumps(command(sys.argv[1] if len(sys.argv) > 1 else "status")))
