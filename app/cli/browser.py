# -*- coding: utf-8 -*-
"""`dispatch browser`: a Chromium window an Agent drives (Playwright), next to Dispatch.

  browser open <url> [--headless] [--new-tab]    open (starts the browser on first use)
  browser shot [--full] [--selector S] [--out F]  screenshot → ~/tasks/.dispatch/browser/shots/*.png
  browser click <selector | text>                 CSS / text= / role=… selector, or plain visible text
  browser type <selector> <text> [--submit]       fill a field (--slow types key by key)
  browser press <key> [--selector S]              Enter, Escape, Meta+A, ArrowDown …
  browser eval <js>                               run JavaScript in the page, return its value
  browser logs [--since 5m|<epoch>] [--clear]     console, uncaught errors, failed requests, HTTP >= 400
  browser snapshot [--selector S]                 accessibility tree (YAML) to find what to click
  browser status | close
  browser --ide open|read|click|type|press|shot|go|status …
                                                  the built-in browser in Dispatch IDE's right panel
                                                  instead (browser_ide.py); back here when the IDE is not open

Every command answers one JSON object with --json. The browser lives in a resident process
(browserd.py) in the Playwright venv ~/tasks/.dispatch/venv: the first `open` creates the venv
and installs Playwright when they are missing (and a Chromium when neither Playwright's own
build nor Google Chrome is there), then starts browserd; later commands talk to it over a
unix socket and take about 100 ms. browserd exits after 30 minutes without a command
(DISPATCH_BROWSER_IDLE seconds to change it), when the window is quit, or on `close`.
"""
import sys

sys.dont_write_bytecode = True

import argparse
import json
import os
import socket
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import dplatform as P  # noqa: E402
from lang import t as _t  # noqa: E402

DAEMON = os.path.join(HERE, "browserd.py")
IDLE_DEFAULT = 1800
START_TIMEOUT = 90.0
PIP_TIMEOUT = 900
REQUEST_TIMEOUT = 120.0
SOCK_MAX = 100  # sun_path is 104 bytes on macOS


class BrowserError(Exception):
    def __init__(self, code, message, **extra):
        Exception.__init__(self, message)
        self.code = code
        self.extra = extra


def dispatch_dir():
    return os.environ.get("DISPATCH_DIR") or os.path.join(P.HOME, "tasks", ".dispatch")


def state_dir():
    return os.path.join(dispatch_dir(), "browser")


def state_file():
    return os.path.join(state_dir(), "browserd.json")


def log_file():
    return os.path.join(state_dir(), "browserd.log")


def socket_path():
    p = os.path.join(state_dir(), "browserd.sock")
    if len(p.encode("utf-8")) <= SOCK_MAX:
        return p
    import hashlib
    import tempfile
    return os.path.join(tempfile.gettempdir(), "dispatch-browserd-%s.sock" % hashlib.sha1(p.encode("utf-8")).hexdigest()[:12])


def venv_dir():
    return os.environ.get("DISPATCH_BROWSER_VENV") or os.path.join(dispatch_dir(), "venv")


def venv_python():
    d = venv_dir()
    return os.path.join(d, "Scripts", "python.exe") if P.IS_WIN else os.path.join(d, "bin", "python")


def idle_seconds():
    try:
        return max(float(os.environ.get("DISPATCH_BROWSER_IDLE") or IDLE_DEFAULT), 1.0)
    except ValueError:
        return float(IDLE_DEFAULT)


def _say(msg):
    print(msg, file=sys.stderr, flush=True)


def _run(args, timeout, env=None):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, creationflags=P.no_window_flags(), env=env)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", _t("timed out", "超时")
    except OSError as e:
        return 127, "", str(e)


# ---- the venv ---------------------------------------------------------------------------------

def has_playwright():
    py = venv_python()
    if not os.path.exists(py):
        return False
    return _run([py, "-c", "import playwright.async_api"], 60)[0] == 0


def ensure_playwright():
    """Create the venv and pip-install Playwright when missing. Returns the steps taken."""
    steps = []
    py = venv_python()
    if not os.path.exists(py):
        _say(_t("First use of the browser: making a Python environment in %s…", "首次使用浏览器：在 %s 建 Python 虚拟环境…") % venv_dir())
        code, _, err = _run([sys.executable, "-m", "venv", venv_dir()], 300)
        if code != 0 or not os.path.exists(py):
            raise BrowserError("install_failed", _t("Making the Python environment failed: %s", "建虚拟环境失败：%s") % (err.strip()[-400:] or code))
        steps.append("venv")
    if not has_playwright():
        _say(_t("First use of the browser: installing Playwright into %s (about 40 MB, a minute or two)…", "首次使用浏览器：往 %s 装 Playwright（约 40 MB，要一两分钟）…") % venv_dir())
        import mirrors  # PyPI, or the mirror in China when it does not answer (Settings > Network)
        code, _, err = mirrors.run_with_mirrors(lambda argv, env: _run(argv, PIP_TIMEOUT, env), lambda china: (
            [py, "-m", "pip", "install", "-q", "--disable-pip-version-check", *mirrors.pip_args(china), "playwright"], mirrors.install_env(china)))
        if code != 0 or not has_playwright():
            raise BrowserError("install_failed", _t("Installing Playwright failed: %s", "装 Playwright 失败：%s") % (err.strip()[-600:] or code))
        steps.append("playwright")
    return steps


def install_chromium():
    _say(_t("No usable Chromium found: downloading Playwright's Chromium (about 170 MB, into ~/Library/Caches/ms-playwright)…", "没找到可用的 Chromium：下载 Playwright 的 Chromium（约 170 MB，放在 ~/Library/Caches/ms-playwright）…"))
    import mirrors  # Playwright's own server, or npmmirror's copy when it does not answer (Settings > Network)
    code, _, err = mirrors.run_with_mirrors(lambda argv, env: _run(argv, PIP_TIMEOUT, env), lambda china: (
        [venv_python(), "-m", "playwright", "install", "chromium"], mirrors.install_env(china)))
    if code != 0:
        raise BrowserError("install_failed", _t("Downloading Chromium failed: %s", "下载 Chromium 失败：%s") % (err.strip()[-600:] or code))


# ---- talking to browserd ----------------------------------------------------------------------

def read_state():
    try:
        with open(state_file(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _connect(st, timeout):
    if st.get("transport") == "tcp":
        s = socket.create_connection(("127.0.0.1", int(st["port"])), timeout=timeout)
    else:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(st.get("socket") or socket_path())
    return s


def request(req, timeout=REQUEST_TIMEOUT, st=None):
    """One command to browserd; raises BrowserError("not_running") when nobody answers."""
    st = st if st is not None else read_state()
    if not st.get("pid") or st.get("error") or not P.pid_alive(int(st["pid"])):
        raise BrowserError("not_running", _t("The browser is not open; dispatch browser open <url> first", "浏览器没开，先 dispatch browser open <url>"))
    body = dict(req)
    if st.get("token"):
        body["token"] = st["token"]
    try:
        s = _connect(st, timeout)
    except (OSError, ValueError) as e:
        raise BrowserError("not_running", _t("The browser is not open (browserd cannot be reached: %s); dispatch browser open <url> first", "浏览器没开（连不上 browserd：%s），先 dispatch browser open <url>") % e)
    try:
        s.sendall((json.dumps(body, ensure_ascii=False) + "\n").encode("utf-8"))
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    except socket.timeout:
        raise BrowserError("timeout", _t("browserd did not answer within %d s", "browserd %d 秒没回话") % timeout)
    finally:
        s.close()
    try:
        return json.loads(buf.decode("utf-8"))
    except ValueError:
        raise BrowserError("failed", _t("browserd did not answer with JSON: %r", "browserd 回的不是 JSON：%r") % buf[:200])


def running():
    """browserd's state when it is up and answering, else None."""
    st = read_state()
    if not st.get("pid") or st.get("error") or not P.pid_alive(int(st["pid"])):
        return None
    try:
        r = request({"cmd": "status"}, timeout=5, st=st)
    except BrowserError:
        return None
    return dict(st, status=r) if r.get("ok") else None


def _log_tail(n=15):
    try:
        with open(log_file(), encoding="utf-8", errors="replace") as f:
            return "".join(f.readlines()[-n:]).strip()
    except OSError:
        return ""


def spawn(headless):
    """Start browserd and wait until it answers. Returns its state."""
    os.makedirs(state_dir(), exist_ok=True)
    try:
        os.chmod(state_dir(), 0o700)
    except OSError:
        pass
    try:
        os.unlink(state_file())
    except OSError:
        pass
    args = [venv_python(), DAEMON, "--dir", state_dir(), "--socket", socket_path(), "--idle", str(idle_seconds())]
    if headless:
        args.append("--headless")
    log = open(log_file(), "a", encoding="utf-8")
    log.write("\n== %s start %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), " ".join(args[2:])))
    log.flush()
    proc = P.spawn_detached(args, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    log.close()
    deadline = time.time() + START_TIMEOUT
    while time.time() < deadline:
        st = read_state()
        if st.get("error") and st.get("pid") == proc.pid:
            raise BrowserError("missing_browser" if st["error"].startswith("missing_browser") else "start_failed", st["error"])
        if st.get("pid") == proc.pid and (st.get("port") or st.get("socket")):
            try:
                r = request({"cmd": "status"}, timeout=5, st=st)
                if r.get("ok"):
                    return st
            except BrowserError:
                pass
        if proc.poll() is not None:
            raise BrowserError("start_failed", _t("browserd quit (%s): %s", "browserd 退出了（%s）：%s") % (proc.returncode, _log_tail()))
        time.sleep(0.15)
    try:
        P.terminate(proc.pid, force=True)
    except Exception:
        pass
    raise BrowserError("start_failed", _t("browserd did not start within %d s: %s", "browserd %d 秒没起来：%s") % (START_TIMEOUT, _log_tail()))


class _StartLock(object):
    """Two `open`s at once must not start two browsers: the second waits for the first."""

    def __init__(self):
        self.path = os.path.join(state_dir(), "start.lock")

    def __enter__(self):
        os.makedirs(state_dir(), exist_ok=True)
        deadline = time.time() + START_TIMEOUT + PIP_TIMEOUT
        while time.time() < deadline:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                return self
            except FileExistsError:
                try:
                    pid = int(open(self.path).read().strip() or 0)
                except (OSError, ValueError):
                    pid = 0
                if not pid or not P.pid_alive(pid):
                    try:
                        os.unlink(self.path)
                    except OSError:
                        pass
                    continue
                time.sleep(0.2)
        raise BrowserError("busy", _t("Another dispatch browser open is starting the browser", "另一个 dispatch browser open 正在启动浏览器"))

    def __exit__(self, *exc):
        try:
            os.unlink(self.path)
        except OSError:
            pass
        return False


def ensure_running(headless=None):
    """(state, info): reuse the running browserd, or install what is missing and start one.
    headless=None keeps whatever is running; True / False restarts one in the other mode."""
    info = {"started": False, "installed": []}
    cur = running()
    if cur and (headless is None or bool(cur.get("headless")) == bool(headless)):
        return cur, info
    with _StartLock():
        cur = running()
        if cur and (headless is None or bool(cur.get("headless")) == bool(headless)):
            return cur, info
        if cur:
            stop()
        want = bool(headless) if headless is not None else os.environ.get("DISPATCH_BROWSER_HEADLESS") == "1"
        info["installed"] = ensure_playwright()
        t0 = time.time()
        try:
            st = spawn(want)
        except BrowserError as e:
            if e.code != "missing_browser":
                raise
            install_chromium()
            info["installed"].append("chromium")
            st = spawn(want)
        info["started"] = True
        info["start_ms"] = int((time.time() - t0) * 1000)
        return st, info


def is_daemon(pid):
    """True while `pid` is our browserd: after a crash browserd.json keeps a pid that the system
    may since have handed to any other process."""
    cmd = P.process_cmdlines().get(int(pid), "")
    return os.path.basename(DAEMON) in cmd and state_dir() in cmd


def _forget_state():
    try:
        os.unlink(state_file())
    except OSError:
        pass


def stop():
    st = read_state()
    if not st.get("pid") or not P.pid_alive(int(st["pid"])):
        return {"closed": False}
    pid = int(st["pid"])
    if not is_daemon(pid):
        _forget_state()
        return {"closed": False, "stale": True}
    try:
        request({"cmd": "close"}, timeout=15, st=st)
    except BrowserError:
        pass
    for _ in range(100):
        if not P.pid_alive(pid):
            return {"closed": True, "pid": pid}
        time.sleep(0.1)
    if not is_daemon(pid):
        return {"closed": True, "pid": pid}
    P.terminate(pid, force=True)
    return {"closed": True, "pid": pid, "killed": True}


# ---- command line -----------------------------------------------------------------------------

def parser():
    p = argparse.ArgumentParser(prog="dispatch browser", description="the browser agents use (Playwright Chromium, kept running by browserd)")
    sub = p.add_subparsers(dest="op", required=True)

    def add(name, help_):
        s = sub.add_parser(name, help=help_)
        s.add_argument("--json", action="store_true")
        return s

    s = add("open", "open a URL (the first time installs Playwright and starts the browser)")
    s.add_argument("url")
    s.add_argument("--headless", action="store_true", help="no window")
    s.add_argument("--headed", action="store_true", help="show the window (a headless one that runs is restarted)")
    s.add_argument("--new-tab", action="store_true")
    s.add_argument("--wait", choices=["load", "domcontentloaded", "networkidle", "commit"], default="load")
    s.add_argument("--timeout", type=float, default=30, help="seconds")
    s = add("shot", "take a screenshot; answers with the file path")
    s.add_argument("--full", action="store_true", help="the whole page (not only what is visible)")
    s.add_argument("--selector", default="", help="only this element")
    s.add_argument("--out", default="", help="save it here (default ~/tasks/.dispatch/browser/shots/)")
    s = add("click", "click an element: CSS / text=… / role=button[name=\"…\"], or just the visible text")
    s.add_argument("target")
    s.add_argument("--timeout", type=float, default=10, help="seconds")
    s = add("type", "type into an input")
    s.add_argument("selector")
    s.add_argument("text")
    s.add_argument("--submit", action="store_true", help="press Enter afterwards")
    s.add_argument("--slow", action="store_true", help="type key by key (for pages that listen to keydown)")
    s.add_argument("--timeout", type=float, default=10, help="seconds")
    s = add("press", "press a key: Enter, Escape, Meta+A …")
    s.add_argument("key")
    s.add_argument("--selector", default="", help="focus this element first")
    s = add("eval", "run JavaScript in the page and answer with its value")
    s.add_argument("js")
    s = add("logs", "console, uncaught errors, failed requests, HTTP >= 400")
    s.add_argument("--since", default="", help="epoch seconds, or 30s / 5m / 2h")
    s.add_argument("--types", default="", help="only these: console,pageerror,requestfailed,http")
    s.add_argument("--limit", type=int, default=200)
    s.add_argument("--clear", action="store_true", help="clear them after reading")
    s = add("snapshot", "the accessibility tree (YAML), to find what to click")
    s.add_argument("--selector", default="")
    add("status", "whether the browser runs, and the current page")
    add("close", "close the browser (browserd quits)")
    return p


def _text(op, r):
    if op == "open":
        s = "%s  %s" % (r.get("title") or _t("(untitled)", "(无标题)"), r.get("url"))
        if r.get("status"):
            s += "  [%s]" % r["status"]
        if r.get("warning"):
            s += "\n" + r["warning"]
        return s
    if op == "shot":
        return _t("%s (%dx%d)", "%s（%dx%d）") % (r["path"], r.get("width", 0), r.get("height", 0))
    if op in ("click", "press"):
        return _t("Done: %s  %s", "好了：%s  %s") % (r.get("title") or "", r.get("url"))
    if op == "type":
        return _t("Typed", "填好了") + (_t(": %s", "：%s") % r["value"] if "value" in r else "")
    if op == "eval":
        v = r.get("value")
        return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, indent=1)
    if op == "logs":
        if not r["entries"]:
            return _t("No logs", "没有日志")
        return "\n".join("%s %-13s %s" % (time.strftime("%H:%M:%S", time.localtime(e["ts"])), e["type"] + ("/" + e["level"] if e.get("level") else ""), e["text"]) for e in r["entries"])
    if op == "snapshot":
        return r.get("snapshot", "")
    if op == "status":
        if not r.get("running"):
            return _t("The browser is not open", "浏览器没开")
        return _t("Running (pid %s, %s%s, idle %ss): %s  %s", "在跑（pid %s，%s%s，空闲 %ss）：%s  %s") % (r["pid"], r.get("browser", ""), _t(", headless", "，无头") if r.get("headless") else "", r.get("idle_s"), r.get("title") or "", r.get("url") or "")
    if op == "close":
        return _t("Closed", "已关掉") if r.get("closed") else _t("It was not open", "本来就没开")
    return json.dumps(r, ensure_ascii=False)


def run(a):
    op = a.op
    if op == "status":
        cur = running()
        if not cur:
            return {"ok": True, "running": False}
        return dict(cur["status"], running=True)
    if op == "close":
        return dict(stop(), ok=True)
    extra = {}
    if op == "open":
        headless = True if a.headless else (False if a.headed else None)
        _, info = ensure_running(headless)
        extra = {"daemon": dict(info)}
        req = {"cmd": "open", "url": a.url, "new_tab": a.new_tab, "wait": a.wait, "timeout_ms": int(a.timeout * 1000)}
    elif op == "shot":
        req = {"cmd": "shot", "full": a.full, "selector": a.selector, "out": os.path.abspath(os.path.expanduser(a.out)) if a.out else ""}
    elif op == "click":
        req = {"cmd": "click", "target": a.target, "timeout_ms": int(a.timeout * 1000)}
    elif op == "type":
        req = {"cmd": "type", "selector": a.selector, "text": a.text, "submit": a.submit, "slow": a.slow, "timeout_ms": int(a.timeout * 1000)}
    elif op == "press":
        req = {"cmd": "press", "key": a.key, "selector": a.selector}
    elif op == "eval":
        req = {"cmd": "eval", "js": a.js}
    elif op == "logs":
        req = {"cmd": "logs", "since": a.since, "types": a.types, "limit": a.limit, "clear": a.clear}
    elif op == "snapshot":
        req = {"cmd": "snapshot", "selector": a.selector}
    else:
        raise BrowserError("usage", _t("Unknown command: %s", "不认识的命令：%s") % op)
    t0 = time.time()
    res = request(req)
    res["ms"] = int((time.time() - t0) * 1000)
    if extra:
        res.update(extra)
        st = read_state()
        res["daemon"]["pid"] = st.get("pid")
    return res


def main(argv=None):
    """Entry from `dispatch browser …` and `python3 browser.py …`."""
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--ide" in argv:
        # the built-in browser in Dispatch IDE's right panel (browser_ide.py); it falls back here
        argv.remove("--ide")
        import browser_ide
        return browser_ide.main(argv)
    a = parser().parse_args(argv)
    try:
        res = run(a)
    except BrowserError as e:
        out = dict({"ok": False, "error": e.code, "message": str(e)}, **e.extra)
        if a.json:
            print(json.dumps(out, ensure_ascii=False), flush=True)
        else:
            print(str(e), file=sys.stderr)
        return 1
    if a.json:
        print(json.dumps(res, ensure_ascii=False), flush=True)
    elif res.get("ok") is False:
        print(res.get("message") or res.get("error"), file=sys.stderr)
    else:
        print(_text(a.op, res))
    return 0 if res.get("ok", True) else 1


if __name__ == "__main__":
    P.utf8_stdio()
    sys.exit(main(sys.argv[1:]))
