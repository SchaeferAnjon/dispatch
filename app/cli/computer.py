# -*- coding: utf-8 -*-
"""`dispatch computer`: an agent uses another Mac app (Notes, Finder, Simulator…) the safe way.

  computer check                          may agents use other apps here? (macOS Accessibility, in plain words)
  computer apps                           the apps that are open, and the ones agents may not use
  computer start <app> --why "<what for>" [--as claude|codex|opencode]
                                          ask the person first: a window names the agent, the app and why;
                                          waits for Allow / Don't Allow (5 minutes at most)
  computer look [--shot] [--frames]       the app's window as a numbered list (a picture with --shot; where
                                          each part is, in points from the window's corner, with --frames)
  computer click <n | name | x,y> [--double] [--right]
                                          press a button, link, row … by its number or its name, or click a point
  computer drag <from> <to>               drag (each end a number, a name or x,y), e.g. a file onto a folder
  computer menu [Menu [Item …]]           the app's menu bar; a menu's items; choose an item ("File" "New Folder")
  computer fill <n | name> <text>         put text into a field
  computer type <text>                    type into the app (it does not have to be in front)
  computer press <key>                    Return, Tab, Up, cmd+a … (not Esc: that is the person's stop key)
  computer scroll up|down [n]
  computer stop | status
  computer allowed [--forget <app> | --forget-all] [--all on|off]
                                          the apps the person chose Always Allow for (no question for them any more);
                                          --all on: every app without asking (Settings > Agents), except the refused ones
  [--json]

Only after Allow (or Always Allow, which skips the question for that app from then on), and only in that one app: a click or drag at a point that is not on that app is
refused, and so are the Apple menu and Services. While the screen is locked nothing can be seen or
answered, so start and every command say "unlock, then try again" instead of waiting. While the agent works, a bar at the top of the screen says
what it is doing; its Stop button or Esc anywhere ends the session, and so do `stop`, ten minutes
without a command and the app quitting. Terminals, code editors, Dispatch itself, System Settings and
password apps are refused. The work is done by a small native helper (app/computer/DispatchComputer.swift):
the one inside Dispatch IDE (Resources/app/tools/dispatch-computer), else one compiled from the source
with Apple's swiftc on first use. State: <DISPATCH_DIR>/computer/session.json.
"""
import sys

sys.dont_write_bytecode = True

import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
from lang import t as _t
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import engines as E  # noqa: E402

HELPER = "dispatch-computer"
APP_TOOLS = "/Applications/Dispatch IDE.app/Contents/Resources/app/tools"
ASK_WAIT_S = 310.0
REQUEST_TIMEOUT = 60.0
SOCK_MAX = 100
FINAL = ("running", "denied", "needs-permission", "refused", "not-found", "error", "stopped", "screen-locked")
# the commands the native helper must know (its `version`); an older one is rebuilt from the source
PROTOCOL = 2
LOCKED = _t("The screen is locked: try again once it is unlocked. While it is locked other apps show no windows and nobody can click Allow; ask the person to unlock this Mac, then come back",
            "屏幕锁着：解锁后再试。锁屏时其他 App 不显示窗口，也没人能点 Allow；请用户解锁这台 Mac，然后再来")
_POINT = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")

# the agent's own mark in the question window and the bar: its adapter's glyph (engines/; DESIGN.md: codicon has
# Claude and OpenAI, Dispatch's icon font has OpenCode)


class ComputerError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code


def dispatch_dir():
    return os.environ.get("DISPATCH_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".dispatch")


def state_dir():
    return os.path.join(dispatch_dir(), "computer")


def state_file():
    return os.path.join(state_dir(), "session.json")


def socket_path():
    p = os.path.join(state_dir(), "session.sock")
    if len(p.encode("utf-8")) <= SOCK_MAX:
        return p
    return os.path.join(tempfile.gettempdir(), "dispatch-computer-%s.sock" % hashlib.sha1(p.encode("utf-8")).hexdigest()[:12])


def source_file():
    """DispatchComputer.swift next to the CLI: app/computer in the repo and in the packaged CLI."""
    for d in (os.path.join(HERE, "..", "computer"), os.path.join(HERE, "computer")):
        p = os.path.normpath(os.path.join(d, "DispatchComputer.swift"))
        if os.path.isfile(p):
            return p
    return ""


def tools_dirs():
    out = []
    for d in (os.environ.get("DISPATCH_IDE_BIN") or "", APP_TOOLS):
        if d and d not in out:
            out.append(d)
    return out


def media_dirs():
    """Dispatch IDE's own fonts (out/media), next to its tools folder."""
    return [os.path.normpath(os.path.join(d, "..", "out", "media")) for d in tools_dirs()]


def icon_args(engine):
    font, char = E.get(engine).glyph
    if not font:
        return []
    for d in media_dirs():
        p = os.path.join(d, font)
        if os.path.isfile(p):
            return ["--icon-font", p, "--icon-char", char]
    return []


def helper_protocol(path, run=subprocess.run):
    """What the helper says it knows; 1 for the first one, which had no `version`."""
    try:
        r = run([path, "version"], capture_output=True, text=True, timeout=10)
        return int(json.loads(r.stdout.strip().splitlines()[-1]).get("protocol") or 1)
    except (OSError, ValueError, IndexError, subprocess.SubprocessError, AttributeError):
        return 1


def helper_path(compile_missing=True, run=subprocess.run):
    """The native helper: DISPATCH_COMPUTER_BIN, the one inside Dispatch IDE, or one compiled from source.
    A Dispatch IDE older than this CLI has an older helper: then the source next to the CLI wins."""
    explicit = os.environ.get("DISPATCH_COMPUTER_BIN")
    if explicit:
        return explicit
    src = source_file()
    older = ""
    for d in tools_dirs():
        p = os.path.join(d, HELPER)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            if not src or helper_protocol(p, run) >= PROTOCOL:
                return p
            older = older or p
    if not src:
        raise ComputerError("no-helper", _t("This dispatch has neither the computer-use helper nor its source (app/computer/DispatchComputer.swift)", "这份 dispatch 里没有电脑操作的程序，也没有它的源码（app/computer/DispatchComputer.swift）"))
    if older and not compile_missing:
        return older
    with open(src, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()[:12]
    out = os.path.join(state_dir(), "bin", "%s-%s" % (HELPER, digest))
    if os.path.isfile(out):
        return out
    if not compile_missing:
        raise ComputerError("no-helper", _t("The computer-use helper is not built yet", "电脑操作的程序还没编译"))
    swiftc = shutil.which("swiftc")
    if not swiftc and older:
        return older  # an older helper beats none: the new commands say they are unknown
    if not swiftc:
        raise ComputerError("no-helper", _t("Using other apps needs Apple's command line tools on this Mac (usually installed with git): "
                                            "ask the person to run xcode-select --install in Terminal, then try again",
                                            "要用电脑操作，这台 Mac 需要 Apple 的命令行工具（装 git 时一般已经装了）："
                                            "请用户在终端里运行 xcode-select --install，装好后再试"))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    print(_t("First use: building the computer-use helper (about half a minute)…", "第一次用：编译电脑操作的小程序（约半分钟）…"), file=sys.stderr, flush=True)
    r = run([swiftc, "-O", "-swift-version", "5", "-o", out + ".part", src], capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise ComputerError("no-helper", _t("Building the computer-use helper failed: ", "编译电脑操作的程序失败：") + (r.stderr or r.stdout or "")[-600:])
    os.replace(out + ".part", out)
    return out


def engine_name(explicit=""):
    import browser_ide
    return browser_ide.engine_name(explicit)


# ---- the session ------------------------------------------------------------------------------

def read_state():
    try:
        with open(state_file(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def live_state():
    """The session's state when its helper still runs; an empty dict otherwise."""
    st = read_state()
    if st and pid_alive(st.get("pid")) and st.get("status") in ("asking", "running", "needs-permission"):
        return st
    return {}


def request(obj, timeout=REQUEST_TIMEOUT):
    path = socket_path()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(path)
        s.sendall((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        data = b""
        while not data.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
    except OSError:
        st = read_state()
        if st.get("status") == "stopped":
            raise ComputerError("stopped", ended_text(st))
        raise ComputerError("not-running", _t("No app is in use now: dispatch computer start <App> --why \"…\" first (it asks the person)", "现在没有在用的 App：先 dispatch computer start <App> --why \"…\"（会先问用户）"))
    finally:
        s.close()
    try:
        return json.loads(data.decode("utf-8"))
    except ValueError:
        raise ComputerError("error", _t("The computer-use helper did not answer properly", "电脑操作的程序没有正常回答"))


# ---- Always Allow: the apps the person said yes to for good --------------------------------------

def allowed_file():
    return os.path.join(state_dir(), "allowed.json")


def allowed():
    """{"apps": [names], "all": every app without asking, "same": [[names saved together for one app]]}."""
    try:
        with open(allowed_file(), encoding="utf-8") as f:
            return dict({"apps": [], "all": False, "same": []}, **json.load(f))
    except FileNotFoundError:
        return {"apps": [], "all": False, "same": []}


def allowed_apps():
    return allowed()["apps"]


def save_allowed(apps=None, all_apps=None, same=None):
    cur = allowed()
    apps = cur["apps"] if apps is None else apps
    same = cur["same"] if same is None else same
    os.makedirs(state_dir(), exist_ok=True)
    with open(allowed_file() + ".part", "w", encoding="utf-8") as f:
        json.dump({"apps": sorted({a.lower(): a for a in reversed(apps)}.values(), key=str.lower),
                   "all": cur["all"] if all_apps is None else all_apps,
                   "same": [g for g in same if len(g) > 1]}, f, ensure_ascii=False, indent=1)
    os.replace(allowed_file() + ".part", allowed_file())


def forget_allowed(app):
    """Ask again for `app`, and for the other names it was saved under (what the agent asked for, what the person saw)."""
    cur = allowed()
    gone = {app.strip().lower()}
    grew = True
    while grew:  # names linked through several saves ("Note" → "Notes" → "com.apple.Notes") all go
        grew = False
        for g in cur["same"]:
            names = {x.lower() for x in g}
            if gone & names and not names <= gone:
                gone |= names
                grew = True
    save_allowed([x for x in cur["apps"] if x.lower() not in gone],
                 same=[g for g in cur["same"] if not gone & {x.lower() for x in g}])


def is_allowed(app):
    a = allowed()
    return a["all"] or app.strip().lower() in {x.lower() for x in a["apps"]}


def start(app, why, engine, wait=ASK_WAIT_S, popen=subprocess.Popen, sleep=time.sleep):
    if not app.strip():
        raise ComputerError("usage", _t("Say which app: dispatch computer start Notes --why \"…\"", "要说用哪个 App：dispatch computer start Notes --why \"…\""))
    if not why.strip():
        raise ComputerError("usage", _t("Say why in one sentence (the person sees it in the question window): --why \"paste the meeting notes into Notes\"", "要用一句话说为什么（用户在询问窗口里看到）：--why \"把会议纪要贴进备忘录\""))
    cur = live_state()
    if cur.get("status") in ("asking", "needs-permission"):
        # the person already has the window in front of them: no second one
        return dict(cur, ok=False, message="The person already has a window from this about %s; wait for their answer." % cur.get("app"))
    if cur.get("status") == "running":
        if cur.get("app", "").lower() == app.lower() or cur.get("query", "").lower() == app.lower():
            return dict(cur, ok=True, already=True)
        try:
            request({"cmd": "stop"}, timeout=5)
        except ComputerError:
            pass
        sleep(1.5)
    os.makedirs(state_dir(), exist_ok=True)
    try:
        os.remove(state_file())
    except OSError:
        pass
    helper = helper_path()
    run = new_run(app, why, engine)
    argv = [helper, "serve", "--app", app, "--agent", engine, "--why", why.strip(), "--socket", socket_path(), "--state", state_file(),
            "--run-dir", run, "--on-end", json.dumps([sys.executable, os.path.join(HERE, "dispatch.py"), "computer", "record", run])]
    argv += icon_args(engine)
    if is_allowed(app):
        argv.append("--preapproved")
    with open(os.path.join(state_dir(), "helper.log"), "ab") as log:
        proc = popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    deadline = time.time() + wait
    while time.time() < deadline:
        st = read_state()
        if st.get("status") in FINAL:
            st["ok"] = st.get("status") == "running"
            if st.get("always"):  # both names: what the agent asked for and what the person saw (--forget either drops both)
                names = [app.strip()] + ([st["app"]] if st.get("app") and st["app"].lower() != app.strip().lower() else [])
                save_allowed(allowed_apps() + names, same=allowed()["same"] + [names])
            return st
        if proc.poll() is not None and not st:
            raise ComputerError("error", _t("The computer-use helper did not start; see %s", "电脑操作的程序没起来，看 %s") % os.path.join(state_dir(), "helper.log"))
        sleep(0.2)
    return {"ok": False, "status": "denied", "message": "Nobody answered in 5 minutes."}


# ---- what the agent did: each session's steps, kept to look back at --------------------------

RUNS_KEEP_DAYS = 30


def runs_dir():
    return os.path.join(state_dir(), "runs")


def session_id():
    import engines
    for k in engines.session_env_names():
        if os.environ.get(k):
            return os.environ[k]
    return ""


def new_run(app, why, engine, now=None):
    """A folder for this session's steps (the helper writes steps.json, a picture per step and
    index.html into it); who asked and from which conversation go in run.json. Old ones go after 30 days."""
    now = time.time() if now is None else now
    root = runs_dir()
    os.makedirs(root, exist_ok=True)
    for name in os.listdir(root):
        p = os.path.join(root, name)
        try:
            if now - os.path.getmtime(p) > RUNS_KEEP_DAYS * 86400:
                shutil.rmtree(p, ignore_errors=True)
        except OSError:
            pass
    slug = re.sub(r"[^\w.-]+", "-", app.strip(), flags=re.UNICODE).strip("-")[:40] or "app"
    base = os.path.join(root, "%s-%s" % (time.strftime("%Y%m%d-%H%M%S", time.localtime(now)), slug))
    run, n = base, 2
    while os.path.exists(run):
        run, n = "%s-%d" % (base, n), n + 1
    os.makedirs(run)
    with open(os.path.join(run, "run.json"), "w", encoding="utf-8") as f:
        json.dump({"app": app, "why": why, "agent": engine, "session": session_id(), "folder": os.getcwd(), "started": now}, f, ensure_ascii=False)
    return run


def run_summary(run):
    """{app, agent, steps (what the agent did, not counting the start and the end), page, session, folder}."""
    out = {}
    for name in ("run.json", "steps.json"):
        try:
            with open(os.path.join(run, name), encoding="utf-8") as f:
                out.update(json.load(f))
        except (OSError, ValueError):
            pass
    steps = out.get("steps") if isinstance(out.get("steps"), list) else []
    out["count"] = max(0, len(steps) - (1 if steps else 0) - (1 if out.get("ended") else 0))
    page = os.path.join(run, "index.html")
    out["page"] = page if os.path.isfile(page) else ""
    return out


def agent_label(engine):
    eng = E.find((engine or "").lower())
    return eng.short_name if eng else "The agent"


def record(run, run_cmd=subprocess.run):
    """When a session ends (the helper runs this): file its page with the conversation's Docs, titled
    with the app and how many steps, so the person can open the same list again from there."""
    s = run_summary(run)
    if not s.get("page"):
        return {"ok": False, "error": "no steps page in %s" % run}
    title = "%s used %s: %d step%s" % (agent_label(s.get("agent")), s.get("app") or "an app", s["count"], "" if s["count"] == 1 else "s")
    argv = [sys.executable, os.path.join(HERE, "dispatch.py"), "docs", "add", s["page"], "--title", title, "--kind", "截图", "--json"]
    if s.get("folder"):
        argv += ["--folder", s["folder"]]
    if s.get("session"):
        argv += ["--session", s["session"]]
    try:
        r = run_cmd(argv, capture_output=True, text=True, timeout=60)
        filed = r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        filed = False
    return {"ok": True, "page": s["page"], "title": title, "filed": filed, "count": s["count"]}


def ended_text(st):
    """What the agent hears once a session is over, with where to look back at it."""
    why = {"person": _t("the person pressed Stop or Esc: do not start again by yourself; tell them how far you got and ask what next", "用户按了 Stop 或 Esc：不要自己再开始，告诉用户做到哪了，问下一步"),
           "idle": _t("no command for ten minutes, so it ended by itself", "十分钟没有命令，自动结束了"), "app-quit": _t("that app quit", "那个 App 退出了"),
           "agent": _t("you ended it", "你结束的")}.get(st.get("reason"), "")
    text = _t("This run in %s has ended%s", "%s 的这次操作已经结束%s") % (st.get("app") or "App", _t(" (%s)", "（%s）") % why if why else "")
    if st.get("page"):
        text += _t(". %s steps; look back at them: %s", "。做了 %s 步，回看：%s") % (st.get("steps", "?"), st["page"])
    return text


# ---- finding things by name -------------------------------------------------------------------

_LINE = re.compile(r'^\s*\[(\d+)\]\s+([^"]*)(?:"((?:[^"\\]|\\.)*)")?')
CLICK_ROLES = ("button", "link", "menu item", "menu button", "checkbox", "radio button", "pop-up menu", "row", "cell", "disclosure", "segments")
FILL_ROLES = ("text field", "search field", "text area", "combo box", "password field", "date field")


def index_for(target, tree, op="click"):
    """The number of the element called `target` in a `look` list, the kind the action is for first;
    an exact name beats a name that starts with it. None when nothing is called that."""
    t = str(target).strip()
    if t.isdigit():
        return int(t)
    want = " ".join(t.split()).casefold()
    roles = FILL_ROLES if op == "fill" else CLICK_ROLES
    best = None
    for line in (tree or "").splitlines():
        m = _LINE.match(line)
        if not m or m.group(3) is None:
            continue
        name = " ".join(m.group(3).split()).casefold()
        if name == want:
            score = 0
        elif name.startswith(want):
            score = 1
        else:
            continue
        role = m.group(2).strip()
        rank = (score, roles.index(role) if role in roles else len(roles))
        if best is None or rank < best[0]:
            best = (rank, int(m.group(1)))
    return best[1] if best else None


def point(target):
    """x,y as numbers, or None when the target is a number or a name."""
    m = _POINT.match(str(target))
    return (float(m.group(1)), float(m.group(2))) if m else None


def where(target, op="click", tree=None):
    """One end of a click or a drag as the helper wants it: {index} or {x, y}."""
    p = point(target)
    if p:
        return {"x": p[0], "y": p[1]}
    return {"index": resolve(target, op, tree)}


def menu_path(parts):
    """["File", "New Folder"] or ["File > New Folder"] → ["File", "New Folder"]."""
    out = []
    for part in parts or []:
        out += [x.strip() for x in re.split(r"\s*(?:>|›)\s*", part) if x.strip()]
    return out


def look_tree():
    snap = request({"cmd": "look", "quiet": True})
    if not snap.get("ok"):
        if snap.get("code") == "screen-locked":
            raise ComputerError("screen-locked", LOCKED)
        raise ComputerError(snap.get("code") or "error", snap.get("error") or _t("No window to see", "看不到窗口"))
    return snap.get("text") or ""


def resolve(target, op, tree=None):
    if str(target).strip().isdigit():
        return int(target)
    n = index_for(target, look_tree() if tree is None else tree, op)
    if n is None:
        raise ComputerError("not-found", _t("Nothing called \"%s\" in the window; dispatch computer look shows what is there", "窗口里没有叫「%s」的东西；先 dispatch computer look 看看有什么") % target)
    return n


# ---- the command ------------------------------------------------------------------------------

def parser():
    p = argparse.ArgumentParser(prog="dispatch computer", description="let an agent use another app on this Mac: the person is asked first, the top of the screen says what it does, and one click stops it")
    sub = p.add_subparsers(dest="op", required=True)

    def add(name, help_):
        s = sub.add_parser(name, help=help_)
        s.add_argument("--json", action="store_true")
        return s

    add("check", "whether other apps can be used (macOS Accessibility permission), in plain words")
    add("apps", "the open apps, and those agents may not use")
    s = add("start", "ask the person first: which agent, which app, why; it starts only when they click Allow")
    s.add_argument("app", help="the app's name (Notes, Finder…) or bundle id")
    s.add_argument("--why", default="", help="one sentence on what you will do (the person sees it in the question window)")
    s.add_argument("--as", dest="engine", default="", help="claude / codex / opencode (default: guessed from the terminal)")
    s.add_argument("--wait", type=float, default=ASK_WAIT_S, help=argparse.SUPPRESS)
    s = add("look", "list the app's windows as a numbered list")
    s.add_argument("--shot", action="store_true", help="also take a picture of the window (needs Screen Recording permission)")
    s.add_argument("--frames", action="store_true", help="add each item's position and size (@x,y wxh, in points from the first window's top left)")
    s = add("click", "click a button, link, row… by its number or name, or a position x,y")
    s.add_argument("target", help="a number or name from look, or x,y (points from the window's top left, as in look --frames)")
    s.add_argument("--double", action="store_true", help="double-click (open a file, select a word)")
    s.add_argument("--right", action="store_true", help="right-click (open the shortcut menu)")
    s = add("drag", "drag from one place to another, such as a file into a folder")
    s.add_argument("source", metavar="from", help="number, name or x,y")
    s.add_argument("dest", metavar="to", help="number, name or x,y")
    s = add("menu", "the menu bar: without arguments it lists the menus; with a menu's name, its items; down to an item, it picks it")
    s.add_argument("path", nargs="*", help="such as File \"New Folder\", or one \"File > New Folder\"; names in the language the app shows")
    s = add("fill", "type into an input")
    s.add_argument("target")
    s.add_argument("text")
    s = add("type", "type into the app (without bringing it to the front)")
    s.add_argument("text")
    s = add("press", "press a key: Return, Tab, Up, cmd+a …")
    s.add_argument("key")
    s = add("scroll", "scroll")
    s.add_argument("direction", choices=["up", "down", "left", "right"])
    s.add_argument("amount", nargs="?", type=int, default=5)
    add("stop", "finish, and give the app back to the person")
    s = add("record", "(used by the computer-use helper when it ends) file this run's steps page in the conversation's Docs")
    s.add_argument("run")
    add("status", "whether an app is in use now")
    s = add("allowed", "the apps the person chose Always Allow for; --forget asks again for one, --forget-all for all; --all on|off: every app without asking")
    s.add_argument("--forget", default="", metavar="APP")
    s.add_argument("--forget-all", action="store_true")
    s.add_argument("--all", choices=["on", "off"], dest="all_apps")
    return p


def check_text(r):
    if r.get("accessibility"):
        line = _t("Yes: %s has Accessibility permission. The person is still asked before each app is used.", "可以：%s 已经打开了辅助功能权限。每次用一个 App 之前仍会先问用户。") % r.get("host")
    else:
        line = _t("Not yet: macOS does not let %s use other apps. At dispatch computer start the person sees a window; "
                  "they press Open Settings there and turn on %s in System Settings > Privacy & Security > Accessibility.",
                  "还不行：macOS 还没允许 %s 操作其他 App。dispatch computer start 时用户会看到一个窗口，"
                  "按里面的 Open Settings，在 系统设置 > 隐私与安全性 > 辅助功能 里打开 %s。") % (r.get("host"), r.get("host"))
    line += _t("\nScreenshots: ", "\n截图：") + (_t("yes", "可以") if r.get("screen") else _t("no Screen Recording permission, so look --shot takes no picture; the list still works", "没有屏幕录制权限，look --shot 拍不了图，清单照常能用"))
    return line


def run_helper(args_, run=subprocess.run):
    r = run([helper_path()] + args_, capture_output=True, text=True, timeout=60)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise ComputerError("error", (r.stderr or r.stdout or "no answer")[-400:])


def act(a):
    if a.op == "check":
        r = run_helper(["check"])
        r["helper"] = helper_path(compile_missing=False)
        return r, check_text(r)
    if a.op == "apps":
        r = run_helper(["apps"])
        rows = []
        for x in r.get("apps") or []:
            rows.append("%s%s%s" % (x.get("name"), "  (%s)" % x["bundle"] if x.get("bundle") else "",
                                    _t("  not allowed: ", "  不能用：") + x["refused"] if x.get("refused") else ""))
        return r, "\n".join(rows) or _t("No app is open", "没有开着的 App")
    if a.op == "record":
        r = record(a.run)
        return r, r.get("error") or "%s → %s" % (r["title"], r["page"])
    if a.op == "status":
        st = live_state()
        if not st:
            last = read_state()
            text = _t("No app is in use now", "现在没有在用的 App")
            if last.get("status") == "stopped":
                text += _t(". The last one: ", "。上一次：") + ended_text(last)
            elif last:
                text += _t(" (the last one: %s %s)", "（上一次：%s %s）") % (last.get("app"), last.get("status"))
            return dict(ok=True, status="none", last=last), text
        return dict(st, ok=True), "%s：%s（%s）" % (st.get("app"), st.get("status"), st.get("agent"))
    if a.op == "allowed":
        if a.forget_all:
            save_allowed([], same=[])
        elif a.forget:
            forget_allowed(a.forget)
        apps = allowed_apps()
        if a.all_apps:
            save_allowed(all_apps=a.all_apps == "on")
        everything = allowed()["all"]
        text = (_t("Every app is used without asking (except the ones agents may never use)", "所有 App 都不再询问（永远不让用的那些除外）") if everything
                else (_t("Used without asking: ", "不再询问就能用：") + ", ".join(apps)) if apps else _t("Every app is asked about first", "每个 App 都会先问"))
        return {"ok": True, "apps": apps, "all": everything}, text
    if a.op == "start":
        st = start(a.app, a.why, engine_name(a.engine), wait=a.wait)
        status = st.get("status")
        if st.get("already"):
            return st, _t("%s is already allowed; go on with dispatch computer look", "%s 已经允许了，接着用：dispatch computer look") % st.get("app")
        if status == "running":
            return st, _t("The person allowed it: %s can be used now. Next: dispatch computer look", "用户允许了：现在可以用 %s。下一步 dispatch computer look") % st.get("app")
        if status == "screen-locked":
            return st, LOCKED
        return st, st.get("message") or status
    if a.op == "stop":
        try:
            r = request({"cmd": "stop"}, timeout=5)
        except ComputerError:
            return {"ok": True, "status": "none"}, _t("No app was in use", "本来就没有在用的 App")
        st = read_state()
        text = _t("Stopped; %s is back with the person", "停了，%s 还给用户了") % (st.get("app") or "App")
        if st.get("page"):
            text += _t(". %s steps this time; look back at them (put this link in your reply to the person): %s", "。这次做了 %s 步，回看（给用户的回复里带上这个链接）：%s") % (st.get("steps", "?"), st["page"])
        return dict(r, steps=st.get("steps"), page=st.get("page")), text
    if a.op == "look":
        req = {"cmd": "look", "frames": bool(a.frames)}
        if a.shot:
            shots = os.path.join(state_dir(), "shots")
            os.makedirs(shots, exist_ok=True)
            req.update(screenshot=True, path=os.path.join(shots, "%s.png" % time.strftime("%Y%m%d-%H%M%S")))
        r = request(req)
        if r.get("code") == "screen-locked":
            return r, LOCKED
        if r.get("code") == "not-running" and read_state().get("status") == "stopped":
            return dict(r, code="stopped"), ended_text(read_state())
        text = r.get("text") or r.get("error") or ""
        if r.get("note"):
            text += "\n" + r["note"]
        if r.get("shot_path"):
            text += _t("\nScreenshot: ", "\n截图：") + r["shot_path"]
        elif r.get("shot_error"):
            text += _t("\n(screenshot: %s)", "\n（截图：%s）") % r["shot_error"]
        return r, text
    if a.op == "menu":
        r = request({"cmd": "menu", "path": menu_path(a.path)})
        if r.get("ok") and r.get("text"):
            return r, r["text"]
    elif a.op == "click":
        req = dict(where(a.target), cmd="click", button="right" if a.right else "left", count=2 if a.double else 1)
        r = request(req)
    elif a.op == "drag":
        names = [t for t in (a.source, a.dest) if not point(t) and not str(t).strip().isdigit()]
        tree = look_tree() if names else None  # one look for both ends
        r = request({"cmd": "drag", "from": where(a.source, tree=tree), "to": where(a.dest, tree=tree)})
    elif a.op == "fill":
        r = request({"cmd": "fill", "index": resolve(a.target, "fill"), "value": a.text})
    elif a.op == "type":
        r = request({"cmd": "type", "text": a.text})
    elif a.op == "press":
        r = request({"cmd": "press", "key": a.key})
    else:
        r = request({"cmd": "scroll", "direction": a.direction, "amount": a.amount})
    if r.get("code") == "screen-locked":
        return r, LOCKED
    if r.get("code") == "not-running" and read_state().get("status") == "stopped":
        return dict(r, code="stopped"), ended_text(read_state())
    if r.get("ok") and r.get("did"):
        return r, _t("Done: ", "好了：") + r["did"] + ("\n" + r["note"] if r.get("note") else "")
    return r, r.get("error") or ""


def main(argv=None):
    a = parser().parse_args(argv)
    if sys.platform != "darwin":
        msg = _t("Using other apps works only on macOS for now", "电脑操作目前只支持 macOS")
        r, text = {"ok": False, "unsupported": True, "message": msg}, msg
    else:
        try:
            r, text = act(a)
        except ComputerError as e:
            r, text = {"ok": False, "code": e.code, "error": str(e)}, str(e)
    if a.json:
        print(json.dumps(r, ensure_ascii=False), flush=True)
    elif r.get("ok") is False:
        print(text, file=sys.stderr, flush=True)
    else:
        print(text, flush=True)
    return 0 if r.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
