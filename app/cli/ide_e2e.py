# -*- coding: utf-8 -*-
"""`dispatch ide instance …` and `dispatch ide e2e …`: end-to-end tests of Dispatch IDE's windows,
built in so every Agent developing in Dispatch uses the same safe way instead of its own CDP script.

  instance start [NAME] [--app APP] [--folder DIR] [--agents] [--no-seed] [--port N]
      A test instance nobody else uses: its own user data and extensions under /tmp/dide-e2e/NAME,
      a free CDP port, a scratch task board (BEADS_DIR) and Dispatch data (DISPATCH_DIR,
      DISPATCH_HOME) seeded with a demo project, and the dispatch CLI of the build's own kanban commit.
      APP defaults to the newest finished build in ~/dispatch-builds; a development build (ide/dev.sh
      build) is named by its source tree (ide/vscode), its ide/ or its checkout. Recorded in
      ~/.dispatch/state/instances/NAME.json (pid, port, folders, app, the build's commit pair).
  instance list
  instance stop [NAME]
      Ends that instance's processes only: the recorded pid (when it is still that app with that
      user data) and its process tree, plus its helpers that name its folder. Prints them first;
      SIGTERM, never -9, never by name or port, never the caller's own shell.
  e2e run SCENARIO [--instance NAME] [--out DIR (default /tmp/dide-e2e/_runs/…)] [--no-annotate]
      Runs a scenario (a JS module, app/scripts/ide-e2e/README.md) against the instance: only on the
      port in its record, only while that port is the instance's and the app on disk is the build it
      started with. Every step goes to DIR/steps.json. SCENARIO can be a file or the name of one in
      app/scripts/ide-e2e/scenarios.
  e2e annotate RUN_DIR
      The "where is what" picture from the run's marks: the real screenshot, numbered red boxes, one
      line per number (what · where · how to get there): RUN_DIR/00-where-is-what.png and README.md.
  e2e scenarios
      The scenarios that ship with Dispatch.
"""
import sys

sys.dont_write_bytecode = True

import argparse
import datetime
import hashlib
import json
import os
import plistlib
import re
import shutil
import signal
import socket
import subprocess
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import dispatch_dir  # noqa: E402

SCRIPTS = os.path.join(os.path.dirname(HERE), "scripts", "ide-e2e")
MARKER = ".dispatch-e2e-instance"  # in every instance folder we made (and may clear on the next start)
DEFAULT_NAME = "e2e"
FONTS = [  # macOS fonts with Chinese; the first that has every character of the legend is used
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
]


# A quiet, repeatable start: no update check (it times out offline and stalls the main process), no
# extension updates, no telemetry, no welcome page, no trust prompt.
INSTANCE_SETTINGS = {
    "update.mode": "none",
    "extensions.autoCheckUpdates": False,
    "extensions.autoUpdate": False,
    "telemetry.telemetryLevel": "off",
    "workbench.startupEditor": "none",
    "security.workspace.trust.enabled": False,
    "git.openRepositoryInParentFolders": "never",
}

# The shared settings that make the CLI push to the phone (dispatch.py phone_push, notify_watch.py).
NOTIFY_SETTINGS = ("notify_needs_you", "notify_done", "notify_attention", "notify_reply", "notify_watch")

# Every folder the app keeps outside its user data by default (~/.dispatch-ide-shared, ~/.dispatch-ide/…)
# gets one inside the instance: (record key, folder name, the app's flag).
PROFILE = (("user_data_dir", "user-data", "--user-data-dir"), ("extensions_dir", "extensions", "--extensions-dir"),
           ("shared_data_dir", "shared-data", "--shared-data-dir"), ("agents_user_data_dir", "agents-user-data", "--agents-user-data-dir"),
           ("agents_extensions_dir", "agents-extensions", "--agents-extensions-dir"), ("agent_plugins_dir", "agent-plugins", "--agent-plugins-dir"))
PROFILE_DIRS = tuple((k, d) for k, d, _ in PROFILE)


class E2EError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


# ---- places ---------------------------------------------------------------------------------

def root_dir():
    """Where instances keep their folders: /tmp/dide-e2e as its real path (DISPATCH_E2E_ROOT for tests). On macOS /tmp
    is a link to /private/tmp: an instance under the link's name had its window watch /tmp/… while its sessions worked
    in /private/tmp/…, so an edit on disk never reached an open diff (10-08, attribution)."""
    return os.environ.get("DISPATCH_E2E_ROOT") or os.path.join(os.path.realpath("/tmp"), "dide-e2e")


def runs_dir():
    """Where `e2e run` writes by default: /tmp/dide-e2e/_runs (no instance name starts with "_")."""
    return os.path.join(root_dir(), "_runs")


def instances_dir():
    return dispatch_dir.path("state", "instances")


def record_path(name):
    return os.path.join(instances_dir(), "%s.json" % name)


def builds_dir():
    return os.environ.get("DISPATCH_BUILDS") or os.path.join(os.path.expanduser("~"), "dispatch-builds")


def check_name(name):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,40}", name or ""):
        raise E2EError("usage", "实例名只能用字母、数字、点、横线和下划线：%r" % name)
    return name


def read_record(name):
    try:
        with open(record_path(check_name(name)), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise E2EError("no_instance", "没有叫 %s 的测试实例（dispatch ide instance start %s）" % (name, name))


def write_record(rec):
    os.makedirs(instances_dir(), exist_ok=True)
    p = record_path(rec["name"])
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)
    return p


# ---- the app ----------------------------------------------------------------------------------

def latest_build(base=None):
    """The newest finished build (status "ok ...") in ~/dispatch-builds: its Dispatch IDE.app, or None."""
    base = base or builds_dir()
    best = None
    try:
        names = os.listdir(base)
    except OSError:
        return None
    for n in names:
        d = os.path.join(base, n)
        app = os.path.join(d, "Dispatch IDE.app")
        try:
            with open(os.path.join(d, "status")) as f:
                if f.read().split()[:1] != ["ok"]:
                    continue
            t = os.path.getmtime(os.path.join(d, "status"))
        except OSError:
            continue
        if os.path.isdir(app) and (best is None or t > best[0]):
            best = (t, app)
    return best[1] if best else None


def default_app():
    return latest_build() or next((p for p in ("/Applications/Dispatch IDE.app", os.path.expanduser("~/Applications/Dispatch IDE.app")) if os.path.isdir(p)), None)


DEV_MANIFEST = os.path.join(".build", "dispatch-dev.json")


def dev_root(app):
    """The source tree of a development build (ide/dev.sh build: ide/vscode with .build/dispatch-dev.json) that
    `app` names: the tree itself, the repository's ide/ or the repository; None for a packaged app."""
    if not app:
        return None
    for cand in (app, os.path.join(app, "vscode"), os.path.join(app, "ide", "vscode")):
        if os.path.isfile(os.path.join(cand, DEV_MANIFEST)):
            return os.path.abspath(cand)
    return None


def dev_manifest(app):
    """The development build's launch line (binary, its arguments, environment, commit), or None."""
    root = dev_root(app)
    if not root:
        return None
    try:
        with open(os.path.join(root, DEV_MANIFEST), encoding="utf-8") as f:
            m = json.load(f)
    except (OSError, ValueError):
        return None
    return m if isinstance(m, dict) and m.get("binary") else None


def app_binary(app):
    m = dev_manifest(app)
    if m:
        return m["binary"]
    try:
        with open(os.path.join(app, "Contents", "Info.plist"), "rb") as f:
            exe = plistlib.load(f).get("CFBundleExecutable") or "Dispatch IDE"
    except (OSError, ValueError):
        exe = "Dispatch IDE"
    return os.path.join(app, "Contents", "MacOS", exe)


def app_resources(app, *parts):
    # a development build runs from its source tree: that is its Resources/app
    if os.path.isfile(os.path.join(app, DEV_MANIFEST)):
        return os.path.join(app, *parts)
    return os.path.join(app, "Contents", "Resources", "app", *parts)


def fingerprint(app):
    """What identifies the build on disk: product.json and the bridge's manifest byte for byte, the
    workbench and bridge code by size and mtime. Another build copied over the same path changes it."""
    h = hashlib.sha1()
    for rel in ("product.json", "extensions/dispatch-bridge/package.json"):
        try:
            with open(app_resources(app, *rel.split("/")), "rb") as f:
                h.update(f.read())
        except OSError:
            h.update(b"-")
    for rel in ("out/main.js", "extensions/dispatch-bridge/out/extension.js", "out/vs/sessions/sessions.desktop.main.js"):
        try:
            st = os.stat(app_resources(app, *rel.split("/")))
            h.update(("%s:%d:%d" % (rel, st.st_size, int(st.st_mtime))).encode())
        except OSError:
            h.update(rel.encode() + b":-")
    return h.hexdigest()


def build_info(app):
    """The commit pair the app was built from (info.json next to a ~/dispatch-builds build), else what
    product.json says."""
    out = {"name": "", "dispatch_ide": "", "kanban": "", "version": "", "commit": ""}
    m = dev_manifest(app)
    if m:
        # a development build: the commit its tree was at (its uncommitted changes are in it too)
        out.update(name="dev " + (m.get("commit") or "")[:12] + (" + changes" if m.get("dirty") else ""), kanban=m.get("commit") or "", dev=True)
    try:
        with open(os.path.join(os.path.dirname(app), "info.json"), encoding="utf-8") as f:
            info = json.load(f)
        out.update(name=os.path.basename(os.path.dirname(app)), dispatch_ide=info.get("dispatch_ide", ""), kanban=info.get("kanban", ""))
    except (OSError, ValueError):
        pass
    try:
        with open(app_resources(app, "product.json"), encoding="utf-8") as f:
            prod = json.load(f)
        out.update(version=prod.get("version", ""), commit=prod.get("commit", ""))
    except (OSError, ValueError):
        pass
    out["fingerprint"] = fingerprint(app)
    return out


# ---- processes ----------------------------------------------------------------------------------

def ps_rows():
    """[(pid, ppid, command line)] of every process."""
    r = subprocess.run(["ps", "-axww", "-o", "pid=,ppid=,command="], capture_output=True, text=True, errors="replace", timeout=20)
    rows = []
    for line in r.stdout.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            rows.append((int(parts[0]), int(parts[1]), parts[2] if len(parts) > 2 else ""))
    return rows


def children_map(rows):
    kids = {}
    for pid, ppid, _ in rows:
        kids.setdefault(ppid, []).append(pid)
    return kids


def descendants(rows, pid):
    kids = children_map(rows)
    out, todo = [], list(kids.get(pid, []))
    while todo:
        p = todo.pop()
        if p in out or p == pid:
            continue
        out.append(p)
        todo.extend(kids.get(p, []))
    return out


def ancestors(rows, pid):
    parent = {p: pp for p, pp, _ in rows}
    out = []
    while pid in parent and pid not in out and pid > 1:
        out.append(pid)
        pid = parent[pid]
    return out


def owns(rec, cmd):
    """Whether a command line is this instance's app: its binary, with its own user data folder."""
    ud = rec["user_data_dir"]
    return cmd.startswith(rec["binary"]) and (("--user-data-dir " + ud) in cmd or ("--user-data-dir=" + ud) in cmd)


def is_alive(rec, rows=None):
    rows = ps_rows() if rows is None else rows
    return any(pid == rec.get("pid") and owns(rec, cmd) for pid, _, cmd in rows)


def clear_folder(root, tries=5):
    """Remove an old instance's folder. It is moved aside first, so the new instance always gets an empty folder of its
    own: a program of the old one still closing its files (Codex's app-server writing its database for a moment after
    `instance stop`) makes rmtree fail with "Directory not empty", which used to leave the folder without its marker
    and every following start refused it (10-08). What cannot be removed now stays as <root>.old-<time>, cleared by
    the next start."""
    parent, base = os.path.dirname(root), os.path.basename(root)
    aside = "%s.old-%d-%d" % (root, int(time.time()), os.getpid())
    try:
        os.rename(root, aside)
    except OSError:
        aside = root
    # a program of the old instance that has not ended yet may make the folder again at once: aside with it too
    for i in range(5):
        time.sleep(0.3)
        if aside == root or not os.path.lexists(root):
            break
        try:
            os.rename(root, "%s.%d" % (aside, i))
        except OSError:
            break
    leftovers = [os.path.join(parent, n) for n in os.listdir(parent) if n.startswith(base + ".old-")] if os.path.isdir(parent) else []
    for d in sorted(set([aside] + leftovers)):
        for i in range(tries):
            try:
                shutil.rmtree(d)
                break
            except FileNotFoundError:
                break
            except OSError:
                if i == tries - 1:
                    if d == root:
                        raise
                    break
                time.sleep(1)


def plan_stop(rows, rec, me=None):
    """What `instance stop` ends: (main_is_ours, [(pid, command)]). The recorded pid counts only while
    it is still this app with this user data (a pid can be reused), then its whole tree; plus the
    app's own helpers that were re-parented but name this instance's folder (the crash handler);
    never this process or anything above it (the shell running the command)."""
    me = os.getpid() if me is None else me
    cmds = {pid: cmd for pid, _, cmd in rows}
    main = rec.get("pid")
    main_ok = main in cmds and owns(rec, cmds[main])
    pick = set()
    if main_ok:
        pick.add(main)
        pick.update(descendants(rows, main))
    app_prefix = rec["app"].rstrip("/") + "/"
    root = rec["root"].rstrip("/")
    # `--user-data-dir=<root>/…`, `--database=<root>/…`: a folder of this instance given to one of its
    # own processes. A folder merely opened (the user's own window on the demo project) does not count.
    as_option = re.compile(r"--[\w-]+(?:=|\s+)%s(?:/|\s|$)" % re.escape(root))
    for pid, ppid, cmd in rows:
        exe = os.path.basename(cmd.split(" --", 1)[0].split(" ", 1)[0])
        if cmd.startswith(app_prefix) and as_option.search(cmd):
            pick.add(pid)
        elif exe in ("dolt", "bd") and root + "/" in cmd:
            pick.add(pid)
        elif os.path.basename(cmd.split(" --", 1)[0]) in ("Google Chrome", "Chromium", "Microsoft Edge") and as_option.search(cmd):
            # a headless browser the instance's CLI started with a profile inside the instance (prefs page shots):
            # once its parent is gone nothing else ends it
            pick.add(pid)
        elif any(cmd.startswith(r + "/") for r in (root, "/private" + root)):
            # a program that lives in the instance's folder: Codex's app-server daemon, which Codex installs into the
            # instance's CODEX_HOME and starts in a process group of its own (10-07: two of them kept the folder busy)
            pick.add(pid)
        elif ppid == 1 and exe.startswith("sshd") and (" -f %s/" % root) in cmd:
            # the second Mac's sshd of the other-mac fixture (fixtures/other_mac.py), and the logins it serves
            pick.add(pid)
            pick.update(descendants(rows, pid))
        elif ppid == 1 and exe.lower().startswith("python") and len(cmd.split(" ")) > 1 and cmd.split(" ")[1].startswith(root + "/cli/"):
            # the instance's own CLI copy, detached from the app (re-parented): its window chatd (`dispatch.py chatd run`)
            pick.add(pid)
        elif ppid == 1 and exe.lower().startswith("python") and "turbo.py _exec " in cmd and any((" %s/" % r) in cmd for r in (root, "/private" + root)):
            # a Turbo part's runner and its agent (`turbo.py _exec <instance>/dispatch/turbo/…`): detached so a part
            # outlives the window, it would go on working for a stopped instance (10-07: an hour of a free model's work)
            pick.add(pid)
            pick.update(descendants(rows, pid))
        elif ppid == 1 and exe.lower().startswith("python") and " turbo run " in cmd and env_root(pid) == root:
            # the Turbo run's driver (`dispatch turbo run <id>`), detached too: it would start the parts again
            pick.add(pid)
            pick.update(descendants(rows, pid))
        elif ppid == 1 and exe.lower().startswith("python") and " chatd run" in cmd and env_root(pid) == root:
            # a window chatd started with another CLI (DISPATCH_BIN: the build service's checkout of the build's
            # kanban); only its environment says which instance it served (2026-10-02: 17 left behind on this Mac)
            pick.add(pid)
    safe = set(ancestors(rows, me)) | {me}
    return main_ok, [(p, cmds[p]) for p in sorted(pick - safe) if p in cmds]


def env_root(pid):
    """DISPATCH_SESSION_ROOT in a process's environment (ps -E shows it for our own processes), or None."""
    try:
        out = subprocess.run(["ps", "-E", "-ww", "-o", "command=", "-p", str(pid)], capture_output=True, text=True, errors="replace", timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.search(r"(?:^|\s)DISPATCH_SESSION_ROOT=(\S+)", out)
    if m:
        return m.group(1).rstrip("/")
    # a new-user instance (`env -i HOME=<root>/h …`) carries no DISPATCH_SESSION_ROOT, only its HOME inside the root
    m = re.search(r"(?:^|\s)HOME=(/tmp/dide-[^/\s]+)(?:/\S*)?(?:\s|$)", out)
    return m.group(1).rstrip("/") if m else None


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def wait_gone(pids, seconds):
    until = time.time() + seconds
    left = [p for p in pids if pid_alive(p)]
    while left and time.time() < until:
        time.sleep(0.25)
        left = [p for p in left if pid_alive(p)]
    return left


def port_listeners(port):
    """Pids listening on 127.0.0.1:port (lsof), or None when lsof cannot tell."""
    lsof = shutil.which("lsof") or "/usr/sbin/lsof"
    try:
        r = subprocess.run([lsof, "-nP", "-iTCP:%d" % port, "-sTCP:LISTEN", "-t"], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return None
    return [int(x) for x in r.stdout.split() if x.isdigit()]


def port_is_ours(rec, rows=None):
    rows = ps_rows() if rows is None else rows
    pids = port_listeners(rec["port"])
    if pids is None:
        return False  # cannot tell who listens: do not connect
    tree = {rec["pid"]} | set(descendants(rows, rec["pid"]))
    return bool(pids) and all(p in tree for p in pids)


def free_port(taken=()):
    for _ in range(50):
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        finally:
            s.close()
        if port not in taken:
            return port
    raise E2EError("no_port", "找不到空闲端口")


def port_free(port):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def cdp_pages(port, timeout=2):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/json/list" % port, timeout=timeout) as r:
            return [t for t in json.loads(r.read().decode("utf-8")) if t.get("type") == "page"]
    except (OSError, ValueError):
        return None


# ---- environment -------------------------------------------------------------------------------------

# Codex's files the instance links from the real CODEX_HOME, so Codex stays signed in and configured.
CODEX_LOGIN_FILES = ("auth.json", "config.toml")
# The instance's XDG data folder (XDG_DATA_HOME) links everything of the real one (~/.local/share: mise, uv,
# Claude Code's versions…) except OpenCode's folder, where its sessions live (opencode.db, storage, snapshots):
# of that only the logins and its downloaded tools, so OpenCode stays signed in and its sessions stay here.
XDG_DATA_OWN = "opencode"
OPENCODE_DATA_LINKS = ("auth.json", "mcp-auth.json", "bin")
# The same for the XDG config folder (~/.config: git, gh, fish… linked as they are), except OpenCode's: the
# instance's OpenCode reads a copy of the person's opencode.json without its "plugin" list and none of their
# plugins/ folder, so third-party plugins do not run in tests (oh-my-openagent writes a copy of every session
# into ~/.claude/transcripts, 10-06). Dispatch's own plugin comes in through OPENCODE_CONFIG_CONTENT. The
# person's own OpenCode keeps its plugins: nothing in ~/.config changes. Its installed packages (node_modules,
# package.json) are linked: without them OpenCode installs its plugin SDK into the folder at start, which on a
# slow network kept the model list from arriving (the build Mac, 10-06); a package loads only when listed.
OPENCODE_CONFIG_SKIP = ("plugin", "plugins")
# folders Dispatch writes into (a skill mounted for OpenCode, a helper agent installed): the instance gets a folder of its
# own holding a link to each of the person's entries, so they are read as before and what the instance adds stays in it
# (10-07: a skill enabled in a test instance landed in the person's ~/.config/opencode/skills through the linked folder)
OPENCODE_CONFIG_SHADOW = ("skills", "skill", "agents", "agent", "command", "commands")
OPENCODE_CONFIG_FILES = ("opencode.json", "opencode.jsonc", "config.json")
# never linked into an instance: Dispatch's key store (it reads ~/.config/dispatch through HOME, not XDG_CONFIG_HOME),
# so nothing that cleans or rewrites the instance's config folder can reach the person's keys
XDG_CONFIG_NOT_LINKED = ("opencode", "dispatch")


def session_env(rec):
    """What keeps the real sessions on this Mac out of the instance's session lists (`dispatch sessions`,
    the index, Waiting for you), while Claude Code and Codex stay signed in:
    - DISPATCH_IDE_USER_DATA_DIRS: the Agents window catalog is read from the instance's own user data;
    - DISPATCH_SESSION_ROOT: only sessions working in a folder under the instance (or the --folder it
      was started on) are listed (Claude Code, pi, OpenCode … keep their real folders and logins);
    - CODEX_HOME: Codex keeps its sessions in the instance, with the login linked in (link_codex_login);
    - XDG_DATA_HOME: so does OpenCode (opencode.db), with its login linked in (link_xdg_data). Before 10-06 it
      wrote to the real one and the person's own OpenCode list and History had hundreds of test sessions;
    - XDG_CONFIG_HOME: the person's config, but OpenCode's without third-party plugins (link_xdg_config)."""
    root = rec["root"]
    user_data = [rec.get("user_data_dir") or os.path.join(root, "user-data"),
                 rec.get("agents_user_data_dir") or os.path.join(root, "agents-user-data")]
    roots = [root]
    folder = rec.get("folder") or ""
    if folder and not (folder + "/").startswith(root.rstrip("/") + "/"):
        roots.append(folder)  # `--folder` elsewhere: the tester chose it, its sessions are listed too
    return {
        "DISPATCH_IDE_USER_DATA_DIRS": os.pathsep.join(user_data),
        "DISPATCH_SESSION_ROOT": os.pathsep.join(roots),
        "CODEX_HOME": os.path.join(rec["fixture_home"], ".codex") if rec.get("fixture_home") else os.path.join(root, "codex-home"),
        "XDG_DATA_HOME": os.path.join(rec["fixture_home"], ".local", "share") if rec.get("fixture_home") else os.path.join(root, "xdg-data"),
        "XDG_CONFIG_HOME": os.path.join(rec["fixture_home"], ".config") if rec.get("fixture_home") else os.path.join(root, "xdg-config"),
    }


def link_xdg_data(rec, real=None):
    """Links the real XDG data folder's entries into the instance's, OpenCode's folder only for its logins and
    tools (OPENCODE_DATA_LINKS); what the real one does not have is skipped. Returns the links made."""
    real = real or os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    home = session_env(rec)["XDG_DATA_HOME"]
    os.makedirs(home, exist_ok=True)
    rels = [n for n in (sorted(os.listdir(real)) if os.path.isdir(real) else []) if n != XDG_DATA_OWN]
    rels += [os.path.join(XDG_DATA_OWN, n) for n in OPENCODE_DATA_LINKS]
    made = []
    for rel in rels:
        src, dst = os.path.join(real, rel), os.path.join(home, rel)
        if os.path.exists(src) and not os.path.lexists(dst):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.symlink(src, dst)
            made.append(dst)
    return made


# OpenCode's cheap test models (CLAUDE.md: GLM 5.3 Flash, else DeepSeek's Flash, else a free OpenCode Zen one), with the
# login each needs in OpenCode's auth.json ("" for a free one). A test instance's OpenCode starts on the first one this
# Mac has: the person's own default may be a big paid model (the mini's is GLM 5.2 on a paid provider) or Claude.
CHEAP_OPENCODE_MODELS = (("zhipuai-coding-plan/glm-5.3-flash", "zhipuai-coding-plan"), ("deepseek/deepseek-flash", "deepseek"),
                         ("opencode/mimo-v2.6-flash-free", ""))


def cheap_opencode_model(data_dir=None):
    """The test model for this Mac: DISPATCH_E2E_OPENCODE_MODEL, else the first of CHEAP_OPENCODE_MODELS whose login
    the real OpenCode has (data_dir: the real XDG data folder)."""
    if os.environ.get("DISPATCH_E2E_OPENCODE_MODEL"):
        return os.environ["DISPATCH_E2E_OPENCODE_MODEL"]
    data_dir = data_dir or os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    try:
        with open(os.path.join(data_dir, "opencode", "auth.json"), encoding="utf-8") as f:
            logins = json.load(f)
    except (OSError, ValueError):
        logins = {}
    return next(m for m, login in CHEAP_OPENCODE_MODELS if not login or login in (logins or {}))


def link_xdg_config(rec, real=None, data_dir=None):
    """The instance's XDG config folder: every entry of the real one linked, OpenCode's folder rebuilt without
    third-party plugins (OPENCODE_CONFIG_SKIP; opencode.json copied without "plugin") and on a cheap test model
    (cheap_opencode_model). Returns what it made."""
    real = real or os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    home = session_env(rec)["XDG_CONFIG_HOME"]
    os.makedirs(home, exist_ok=True)
    made = []
    for n in sorted(os.listdir(real)) if os.path.isdir(real) else []:
        dst = os.path.join(home, n)
        if n not in XDG_CONFIG_NOT_LINKED and not os.path.lexists(dst):
            os.symlink(os.path.join(real, n), dst)
            made.append(dst)
    src = os.path.join(real, "opencode")
    own = os.path.join(home, "opencode")
    os.makedirs(own, exist_ok=True)
    import opencode_engine
    model = cheap_opencode_model(data_dir)
    wrote = False
    for n in sorted(os.listdir(src)) if os.path.isdir(src) else []:
        dst = os.path.join(own, n)
        if n in OPENCODE_CONFIG_SKIP or os.path.lexists(dst):
            continue
        if n in OPENCODE_CONFIG_SHADOW and os.path.isdir(os.path.join(src, n)):
            os.makedirs(dst)
            tests = os.path.realpath(root_dir()) + os.sep
            for entry in sorted(os.listdir(os.path.join(src, n))):
                # an entry an earlier test instance left there (it points into /tmp/dide-e2e) is not the person's
                if os.path.realpath(os.path.join(src, n, entry)).startswith(tests):
                    continue
                os.symlink(os.path.join(src, n, entry), os.path.join(dst, entry))
            made.append(dst)
            continue
        if n in OPENCODE_CONFIG_FILES:
            cfg = opencode_engine.read_json(os.path.join(src, n), jsonc=True)
            if cfg is None:
                continue  # unreadable: OpenCode would refuse it too
            cfg.pop("plugin", None)
            # test sessions start on a cheap model, whatever the person's own default is (their providers stay listed)
            cfg.update(model=model, small_model=model)
            with open(dst, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2)
            wrote = True
        else:
            os.symlink(os.path.join(src, n), dst)
        made.append(dst)
    if not wrote:
        dst = os.path.join(own, "opencode.json")
        if not os.path.lexists(dst):
            with open(dst, "w", encoding="utf-8") as f:
                json.dump({"$schema": "https://opencode.ai/config.json", "model": model, "small_model": model}, f, indent=2)
            made.append(dst)
    return made


# Codex's cheap test model (10-08, "Fast and affordable model for easier tasks"), on low effort;
# DISPATCH_E2E_CODEX_MODEL picks another
CODEX_TEST_MODEL = ("gpt-6-luna", "low")


def codex_test_config(text, model=None, effort=None):
    """config.toml's text with its top-level model and reasoning effort set to the test ones (added when missing)."""
    model = model or os.environ.get("DISPATCH_E2E_CODEX_MODEL") or CODEX_TEST_MODEL[0]
    effort = effort or CODEX_TEST_MODEL[1]
    lines = text.splitlines()
    top = next((i for i, l in enumerate(lines) if l.lstrip().startswith("[")), len(lines))
    want = {"model": json.dumps(model), "model_reasoning_effort": json.dumps(effort)}
    for i in range(top):
        key = lines[i].split("=", 1)[0].strip()
        if "=" in lines[i] and key in want:
            lines[i] = "%s = %s" % (key, want.pop(key))
    lines[top:top] = ["%s = %s" % kv for kv in want.items()]
    return "\n".join(lines) + "\n"


def link_codex_login(rec, real=None):
    """Links auth.json (and copies config.toml) of the real CODEX_HOME (~/.codex) into the instance's; a file the
    real one does not have is skipped. Returns the links made."""
    real = real or os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")
    home = session_env(rec)["CODEX_HOME"]
    os.makedirs(home, exist_ok=True)
    made = []
    for fn in CODEX_LOGIN_FILES:
        src, dst = os.path.join(real, fn), os.path.join(home, fn)
        if os.path.exists(src) and not os.path.lexists(dst):
            if fn == "config.toml":
                # a copy: Codex writes into its config (trusted folders), and those writes must not reach
                # the real one; auth.json stays a link so a refreshed login is the real login too. The copy runs on
                # the cheap test model, not the person's (the mini's is GPT 6 Astra on high)
                shutil.copy2(src, dst)
                with open(dst, encoding="utf-8") as f:
                    text = f.read()
                with open(dst, "w", encoding="utf-8") as f:
                    f.write(codex_test_config(text))
            else:
                os.symlink(src, dst)
            made.append(dst)
    return made


# Claude Code in a test instance (10-08): with this variable set (`claude setup-token`'s token, kept in `dispatch env`),
# Claude Code runs on that token in the instance's own config folder, never the person's ~/.claude, and on Haiku.
# The token goes only into the instance's environment (as CLAUDE_CODE_OAUTH_TOKEN), never into a file or a log.
CLAUDE_TOKEN = "DISPATCH_E2E_CLAUDE_TOKEN"
CLAUDE_TEST_MODEL = "haiku"


def claude_home(rec):
    """The instance's own Claude Code config folder (CLAUDE_CONFIG_DIR)."""
    return os.path.join(rec["fixture_home"], ".claude") if rec.get("fixture_home") else os.path.join(rec["root"], "claude-home")


def prepare_claude_home(rec, base=None):
    """With a test token: the instance's Claude Code config folder, past the first-run questions and on Haiku.
    Returns the folder, or "" without a token (Claude Code then is the person's own, signed in as they are)."""
    if not (os.environ if base is None else base).get(CLAUDE_TOKEN):
        return ""
    home = claude_home(rec)
    os.makedirs(home, exist_ok=True)
    state = os.path.join(home, ".claude.json")
    if not os.path.exists(state):
        with open(state, "w", encoding="utf-8") as f:
            json.dump({"hasCompletedOnboarding": True, "theme": "dark", "bypassPermissionsModeAccepted": True}, f)
    settings = os.path.join(home, "settings.json")
    if not os.path.exists(settings):
        with open(settings, "w", encoding="utf-8") as f:
            json.dump({"model": CLAUDE_TEST_MODEL}, f)
    return home


def instance_env(rec, base=None):
    """The environment of everything the instance runs: its own board and Dispatch data, the CLI of its
    build, the app's bd / dolt first on PATH; no variables that would tie it to the caller's session,
    editor or board."""
    base = dict(os.environ if base is None else base)
    drop = ("VSCODE_", "ELECTRON_", "CLAUDE_CODE_", "DISPATCH_", "BEADS_", "CODEX_THREAD", "CODEX_SESSION")
    env = {k: v for k, v in base.items() if not k.startswith(drop) and k != "CLAUDECODE"}
    tools = app_resources(rec["app"], "tools")
    # the agents' shell commands (`dispatch prefs add`, `dispatch begin`) reach the build's CLI too: its
    # `dispatch` shim comes before ~/.local/bin on PATH
    shims = [rec["bin_dir"]] if rec.get("bin_dir") else []
    env.update(session_env(rec))
    env.update(
        BEADS_DIR=rec["beads_dir"],
        DISPATCH_DIR=rec["dispatch_dir"],
        DISPATCH_HOME=rec["dispatch_home"],
        DISPATCH_BIN=rec["cli"],
        DISPATCH_E2E_INSTANCE=rec["name"],
        # the instance's own FACTS.md: nothing it runs writes (or an import reads) the user's, which is also
        # pushed to the other Macs; a pick's preference (dispatch flow pick, a delivery page's Choose A / B)
        # goes to DISPATCH_HOME's preferences.jsonl, the instance's too
        DISPATCH_FACTS_FILE=os.path.join(rec["root"], "rules", "FACTS.md"),
        # every agent hook the instance's sessions run, one line each (what ran, what it answered): a scenario
        # reads it when a turn's end did not do what it should
        DISPATCH_HOOK_LOG=os.path.join(rec["root"], "hook.log"),
        PATH=os.pathsep.join([tools] + shims + [env.get("PATH", "/usr/bin:/bin")]),
    )
    if os.path.isdir(tools):
        env["DISPATCH_IDE_BIN"] = tools
    plugin = opencode_plugin(rec)
    if plugin:
        # OpenCode loads this build's Dispatch plugin (it replaces the one this Mac installed, by name), and
        # the plugin runs this build's CLI: turn marks and the note about your lines come from the build
        env["OPENCODE_CONFIG_CONTENT"] = opencode_config_content(plugin, env.get("OPENCODE_CONFIG_CONTENT", ""), rec.get("cli") or "")
        if rec.get("bin_dir"):
            env["DISPATCH_CLI"] = os.path.join(rec["bin_dir"], "dispatch")
    if rec.get("fixture_home"):
        fixture = rec["fixture_home"]
        env.update(HOME=fixture, USER="fixture", XDG_CONFIG_HOME=os.path.join(fixture, ".config"),
                   XDG_DATA_HOME=os.path.join(fixture, ".local", "share"), XDG_CACHE_HOME=os.path.join(fixture, ".cache"),
                   CLAUDE_CONFIG_DIR=os.path.join(fixture, ".claude"), DISPATCH_ONBOARDING="1")
        env.pop("ZDOTDIR", None)
        env["PATH"] = os.pathsep.join([os.path.join(fixture, ".local", "bin"), env["PATH"]])
    else:
        env["DISPATCH_ONBOARDING"] = "0"
    token = base.get(CLAUDE_TOKEN, "")
    if token:
        env.update(CLAUDE_CONFIG_DIR=claude_home(rec), CLAUDE_CODE_OAUTH_TOKEN=token, ANTHROPIC_MODEL=CLAUDE_TEST_MODEL)
    fx = dict(rec.get("fixture_env") or {})
    if fx:
        front = fx.pop("PATH_PREPEND", "")
        # PATH_DROP: folders the instance must not find programs in (the real OpenCode, for a Mac that has only an old one)
        drop = {os.path.normpath(d) for d in fx.pop("PATH_DROP", "").split(os.pathsep) if d}
        env.update(fx)
        if drop:
            env["PATH"] = os.pathsep.join(d for d in env["PATH"].split(os.pathsep) if d and os.path.normpath(d) not in drop)
        if front:
            env["PATH"] = os.pathsep.join([front, env["PATH"]])
    # Dispatch's terminal puts BEADS_DIR and every DISPATCH_* back after the person's shell startup files
    # (app/termd/shell-init.cjs); these the instance moved too, so a ~/.zshrc that sets them does not undo that
    env["DISPATCH_TERMINAL_KEEP"] = " ".join(k for k in TERMINAL_KEEP if k in env)
    return env


# the instance's own data folders that are not Dispatch's variables (see instance_env)
TERMINAL_KEEP = ("CODEX_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT",
                 "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_MODEL")


def opencode_plugin(rec):
    """The build's own OpenCode plugin (agent/opencode/dispatch.js next to its CLI); "" when it has none."""
    cli = rec.get("cli") or ""
    plugin = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(cli))), "agent", "opencode", "dispatch.js") if cli else ""
    return plugin if plugin and os.path.isfile(plugin) else ""


def opencode_config_content(plugin, current="", cli=""):
    """OPENCODE_CONFIG_CONTENT with the plugin added: an inline config, read after the folders, so this plugin
    replaces the one of the same name this Mac installed, and no config folder of its own to install packages into.
    With `cli`, Dispatch's MCP server is that build's too (it replaces one called dispatch in the person's config)."""
    try:
        cfg = json.loads(current) if current else {}
    except ValueError:
        cfg = {}
    cfg = cfg if isinstance(cfg, dict) else {}
    url = "file://" + plugin
    cfg["plugin"] = [p for p in (cfg.get("plugin") or []) if p != url] + [url]
    if cli:
        if not isinstance(cfg.get("mcp"), dict):
            cfg["mcp"] = {}
        cfg["mcp"]["dispatch"] = {"type": "local", "command": [sys.executable, cli, "mcp", "serve", "--agent", "opencode"], "enabled": True}
    return json.dumps(cfg)


def repo_of(path):
    r = subprocess.run(["git", "-C", path, "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=20)
    return r.stdout.strip() if r.returncode == 0 else ""


def scoped_env(rec, cli=""):
    """The variables that keep what runs in the instance on its own board and data, whatever the shell or the agent
    set on the way (~/.zshrc, Claude Code's settings.json "env"): the CLI shim exports them, and Dispatch's MCP server
    takes them from the record when it runs in the instance (dispatch_mcp.py)."""
    scoped = {"BEADS_DIR": rec["beads_dir"], "DISPATCH_DIR": rec["dispatch_dir"], "DISPATCH_HOME": rec["dispatch_home"],
              "DISPATCH_FACTS_FILE": os.path.join(rec["root"], "rules", "FACTS.md"), **session_env(rec)}
    if cli:
        scoped["DISPATCH_BIN"] = cli
    return scoped


def write_cli_shim(root, cli, rec=None):
    """<root>/bin/dispatch running the instance's CLI: the agents in the instance type `dispatch …` in their
    shell, and without it that would be ~/.local/bin's, not the build's."""
    d = os.path.join(root, "bin")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "dispatch")
    with open(p, "w", encoding="utf-8") as f:
        f.write("#!/bin/sh\n# made by `dispatch ide instance start`: the CLI of this instance's build\n")
        if rec:
            # A login shell may overwrite BEADS_DIR in .zshrc. Restore isolation at the
            # executable boundary, while preserving the engine's current session identity.
            for key, value in scoped_env(rec, cli).items():
                f.write("export %s=%s\n" % (key, shlex_quote(value)))
        f.write("exec %s %s \"$@\"\n" % (shlex_quote(sys.executable or "python3"), shlex_quote(cli)))
    os.chmod(p, 0o755)
    return d


def shlex_quote(s):
    import shlex
    return shlex.quote(s)


def extract_cli(sha, dest):
    """The dispatch CLI of kanban commit `sha` (app/cli, app/termd and agent/) into dest, so the bridge in the
    build talks to the CLI it was built with. Returns the path of its dispatch.py, or "" when this
    checkout does not have that commit."""
    repo = repo_of(HERE)
    if not sha or not repo:
        return ""
    if subprocess.run(["git", "-C", repo, "cat-file", "-e", sha + "^{commit}"], capture_output=True, timeout=20).returncode != 0:
        return ""
    os.makedirs(dest, exist_ok=True)
    arc = subprocess.run(["git", "-C", repo, "archive", sha, "app/cli", "app/termd", "agent"], capture_output=True, timeout=120)
    if arc.returncode != 0:
        return ""
    tar = subprocess.run(["tar", "-x", "-C", dest], input=arc.stdout, capture_output=True, timeout=120)
    p = os.path.join(dest, "app", "cli", "dispatch.py")
    return p if tar.returncode == 0 and os.path.isfile(p) else ""


# ---- seed ------------------------------------------------------------------------------------------

def seed(rec, log):
    """A small, known world for screenshots: a scratch board, one registered git project "demo" with a
    task in progress (with a plan), a finished one (with its commit), and one "only you" task."""
    env = instance_env(rec)
    cli = rec["cli"]
    py = sys.executable or "python3"
    demo = os.path.join(rec["root"], "projects", "demo")

    def run(args, cwd=None, check=True, input_=None):
        r = subprocess.run(args, cwd=cwd or demo, env=env, capture_output=True, text=True, timeout=180, input=input_)
        log.write("$ %s\n%s%s\n" % (" ".join(args), r.stdout[-2000:], r.stderr[-2000:]))
        if check and r.returncode != 0:
            raise E2EError("seed_failed", "演示数据没建好：%s\n%s" % (" ".join(args[1:4]), (r.stderr or r.stdout).strip()[-600:]))
        return r.stdout

    def d(*args, check=True):
        return run([py, cli] + list(args), check=check)

    os.makedirs(demo, exist_ok=True)
    git = ["git", "-c", "user.name=Dispatch e2e", "-c", "user.email=e2e@localhost"]
    run(["git", "init", "-q"])
    with open(os.path.join(demo, "README.md"), "w", encoding="utf-8") as f:
        f.write("# Demo\n\nA project the e2e instance made up, so its pages have something to show.\n")
    run(git + ["add", "README.md"])
    run(git + ["commit", "-qm", "docs: readme"])
    # a board of its own in bd's embedded database, made by the app's own bd (what `dispatch init
    # ensure-board` does; older CLIs do not have that command)
    bd = os.path.join(app_resources(rec["app"], "tools"), "bd")
    bd = bd if os.path.isfile(bd) else (shutil.which("bd", path=env.get("PATH")) or "bd")
    os.makedirs(rec["beads_dir"], exist_ok=True)
    run([bd, "init", "--prefix", "task", "--non-interactive", "--quiet", "--skip-agents", "--skip-hooks"], cwd=os.path.dirname(rec["beads_dir"]))
    # the CLI pushes need-you and done to the phone when ~/.config/dispatch/env has a channel: this
    # board is make-believe, so its push switches go off before anything is written to it
    run([py, cli, "settings", "--save", "--json"], input_=json.dumps({k: 0 for k in NOTIFY_SETTINGS}))
    d("projects-view", "add", demo, "--name", "demo", "--json")

    def task_id(out):
        m = re.search(r"\b(task-[a-z0-9]+)\b", out)
        if not m:
            raise E2EError("seed_failed", "没认出新任务的编号：%s" % out.strip()[-300:])
        return m.group(1)

    t1 = task_id(d("begin", "Add a Knowledge page", "-P", "demo", "-d",
                   "Seeded by the e2e instance: a task in progress with a plan, so the Tasks tab and the Projects page have a row to show.",
                   "-a", "- [ ] the page lists the wiki"))
    d("task", "plan", t1, "--set", "Read the wiki", "--set", "Draw the page", "--set", "Wire it to the CLI", "--done", "1", "--active", "2")
    with open(os.path.join(demo, "NOTES.md"), "w", encoding="utf-8") as f:
        f.write("# Notes\n\nThe Projects page counts open tasks per project.\n")
    run(git + ["add", "NOTES.md"])
    run(git + ["commit", "-qm", "docs: notes on the Projects page"])
    t2 = task_id(d("begin", "Fix the Projects page count", "-P", "demo", "-d",
                   "Seeded by the e2e instance: a finished task with its commit, so the Tasks tab shows a done row with a deliverable.",
                   "-a", "- [ ] the count matches"))
    d("task", "deliver", t2, "--commit")
    d("done", t2, "--reason", "seeded: done with its commit", check=False)
    t3 = task_id(d("need-you", "Approve the demo release", "-P", "demo", "-d",
                   "Seeded by the e2e instance: something only the user can do, so Waiting for you has a row."))
    return {"project": "demo", "folder": demo, "tasks": {"in_progress": t1, "done": t2, "only_you": t3}}


# ---- instance start / list / stop -----------------------------------------------------------------------

def load_fixture(fixture):
    """fixtures/<name>.py of a scenario that needs more than the demo project (meta.instance.fixture): its
    prepare(rec) runs after the seed and before the app starts, and returns {"env": {…}, "record": {…}}: variables for
    everything the instance runs (PATH_PREPEND puts folders in front of PATH, PATH_DROP takes folders out of it) and what
    the scenario reads from the record."""
    import importlib.util
    names = (fixture + ".py", fixture.replace("-", "_") + ".py")
    path = next((p for p in (os.path.join(SCRIPTS, "fixtures", n) for n in names) if os.path.isfile(p)), "")
    if not re.fullmatch(r"[a-z0-9_-]+", fixture or "") or not path:
        raise E2EError("no_fixture", "没有这个 fixture：%s（app/scripts/ide-e2e/fixtures/）" % fixture)
    spec = importlib.util.spec_from_file_location("e2e_fixture_" + fixture.replace("-", "_"), path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not hasattr(mod, "prepare"):
        raise E2EError("no_fixture", "%s 没有 prepare(rec)" % path)
    return mod


def start(name=DEFAULT_NAME, app=None, folder="", agents=False, do_seed=True, port=0, wait=240, log=print, onboarding="", scenario_fixture="", tips=False, motion=False):
    check_name(name)
    rows = ps_rows()
    try:
        old = read_record(name)
    except E2EError:
        old = None
    if old and is_alive(old, rows):
        raise E2EError("already_running", "测试实例 %s 已经在跑（pid %s，端口 %s）；先 dispatch ide instance stop %s" % (name, old["pid"], old["port"], name))
    app = os.path.abspath(os.path.expanduser(app)) if app else default_app()
    app = dev_root(app) or app
    if not app or not os.path.isdir(app):
        raise E2EError("no_app", "没找到 Dispatch IDE.app（--app 指定，或先在 ~/dispatch-builds 构建一份）")
    binary = app_binary(app)
    if not os.path.isfile(binary):
        raise E2EError("no_app", "App 里没有可执行文件：%s" % binary)
    hider = os.path.join(SCRIPTS, "hide-windows.mjs")
    if hiding_wanted() and not os.path.isfile(hider):
        # without it the windows would come up in front of the person: nothing is started (task-4cpnb)
        raise E2EError("not_hidden", "这份 dispatch CLI 缺 %s，藏不住测试窗口，没起实例；换带它的 CLI（仓库里的 app/cli/dispatch.py 或新版 App）" % hider)
    root = os.path.join(root_dir(), name)
    if os.path.lexists(root):
        if not os.path.isfile(os.path.join(root, MARKER)):
            raise E2EError("root_taken", "%s 已经存在，但不是 dispatch ide instance 建的；换个实例名或自己挪走它" % root)
        # never this process or the shells above it, whose command line may well name the folder
        mine = set(ancestors(rows, os.getpid())) | {os.getpid()}
        users = [pid for pid, _, cmd in rows if root + "/" in cmd and pid not in mine]
        if users:
            raise E2EError("root_busy", "%s 里还有进程在跑（%s）；先 dispatch ide instance stop %s" % (root, " ".join(map(str, users[:8])), name))
        clear_folder(root)
    try:
        os.makedirs(root)
    except FileExistsError:
        # a program of the instance just cleared (a scenario's runner that was stopped late) wrote into it again in
        # the moment between: still ours, cleared once more (10-08: every later start then refused the folder)
        clear_folder(root)
        os.makedirs(root)
    with open(os.path.join(root, MARKER), "w") as f:
        f.write("made by `dispatch ide instance start %s`; the next start clears this folder\n" % name)
    taken = set()
    for fn in os.listdir(instances_dir()) if os.path.isdir(instances_dir()) else []:
        try:
            with open(os.path.join(instances_dir(), fn), encoding="utf-8") as f:
                other = json.load(f)
            if other.get("name") != name and is_alive(other, rows):
                taken.add(other.get("port"))
        except (OSError, ValueError, KeyError):
            continue
    if port:
        if not port_free(port) or port in taken:
            raise E2EError("port_taken", "端口 %d 已被占用" % port)
    else:
        port = free_port(taken)
    build = build_info(app)
    dirs = {k: os.path.join(root, v) for k, v in PROFILE_DIRS + (("dispatch_dir", "dispatch"), ("dispatch_home", "dispatch-home"),
                                                                  ("beads_dir", "board/.beads"))}
    for k, v in dirs.items():
        if k != "beads_dir":
            os.makedirs(v, exist_ok=True)
    os.makedirs(os.path.dirname(dirs["beads_dir"]), exist_ok=True)
    for ud in (dirs["user_data_dir"], dirs["agents_user_data_dir"]):
        os.makedirs(os.path.join(ud, "User"), exist_ok=True)
        with open(os.path.join(ud, "User", "settings.json"), "w", encoding="utf-8") as f:
            # Getting started tips pop up over whatever a scenario clicks next, at times of their own; a scenario about
            # the tips asks for them (--tips, meta.instance.tips)
            # and motion off: a hidden window drawing Dispatch's animations keeps the GPU process at a third of a core,
            # which on a shared build Mac slows every other instance (a scenario about motion asks for it: --motion)
            extra = {} if tips else {"dispatch.tips.enabled": False}
            if not motion:
                extra["workbench.reduceMotion"] = "on"
            json.dump(dict(INSTANCE_SETTINGS, **extra), f, indent=2)
    dev = dev_manifest(app)
    if dev and os.path.isfile(dev.get("cli") or ""):
        # a development build: the CLI of the checkout it was built from, changes and all, like its bridge
        cli, cli_source = dev["cli"], "the development build's checkout (%s)" % dev.get("repo", "")
    else:
        cli = extract_cli(build.get("kanban"), os.path.join(root, "cli"))
        cli_source = "kanban %s" % build["kanban"][:12] if cli else "this checkout (%s)" % HERE
    if not cli:
        cli = os.path.join(HERE, "dispatch.py")
        log("注意：这台机器的 kanban 仓库里没有构建用的提交 %s，CLI 用的是当前这份 %s" % (build.get("kanban", "")[:12] or "?", HERE))
    rec = dict(name=name, app=app, binary=binary, root=root, port=port, pid=None, cli=cli, cli_source=cli_source,
               build=build, agents=bool(agents), folder="", seed=None, started_at=None, stopped_at=None, log=os.path.join(root, "app.log"), **dirs)
    rec["bin_dir"] = write_cli_shim(root, cli, rec)
    if onboarding:
        import importlib.util
        spec = importlib.util.spec_from_file_location("onboarding_fixture", os.path.join(SCRIPTS, "fixtures", "onboarding_home.py"))
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        rec["fixture_home"] = os.path.join(root, "home")
        rec["onboarding_kind"] = onboarding
        fixture.build(rec["fixture_home"], onboarding)
        do_seed = False
    else:
        link_codex_login(rec)
        link_xdg_data(rec)
        link_xdg_config(rec)
        prepare_claude_home(rec)
    if do_seed:
        log("建临时任务板和演示项目 …")
        with open(os.path.join(root, "seed.log"), "w", encoding="utf-8") as sl:
            rec["seed"] = seed(rec, sl)
    rec["folder"] = os.path.abspath(os.path.expanduser(folder)) if folder else (rec["seed"] or {}).get("folder", "")
    if scenario_fixture:
        log("准备 fixture %s …" % scenario_fixture)
        got = load_fixture(scenario_fixture).prepare(rec) or {}
        rec.update(got.get("record") or {})
        rec["fixture"] = scenario_fixture
        rec["fixture_env"] = {str(k): str(v) for k, v in (got.get("env") or {}).items()}
    rec["bin_dir"] = write_cli_shim(root, cli, rec)
    if not onboarding:
        # The real CODEX_HOME hooks cannot be linked: they point at the user's board and CLI. The build's own hook entry
        # goes into the instance's Codex, which is made to trust it (as first-run setup does), so its sessions get the
        # session brief and the rest
        hook_setup = ("import sys, json; sys.path.insert(0, sys.argv[1]); import engines; "
                      "print(json.dumps(engines.get('codex').install_hooks(path=sys.argv[2], trust=True)))")
        r = subprocess.run([sys.executable, "-c", hook_setup, os.path.dirname(cli),
                            os.path.join(session_env(rec)["CODEX_HOME"], "hooks.json")],
                           env=instance_env(rec), check=True, timeout=120, capture_output=True, text=True)
        log("Codex 钩子：" + (r.stdout.strip()[-300:] or "?"))
        # Dispatch's MCP server in the instance's Codex is the build's (the copied config.toml may carry this Mac's):
        # its calls write the instance's board, whose folders reach it through env_vars
        mcp_setup = ("import sys, json; sys.path.insert(0, sys.argv[1]); import dispatch_mcp; "
                     "print(json.dumps(dispatch_mcp.register(['codex'], by_hand=False, paths={'codex': sys.argv[2]}, allow=False)))")
        if os.path.isfile(os.path.join(os.path.dirname(cli), "dispatch_mcp.py")):
            subprocess.run([sys.executable, "-c", mcp_setup, os.path.dirname(cli),
                            os.path.join(session_env(rec)["CODEX_HOME"], "config.toml")],
                           env=instance_env(rec), check=True, timeout=30, capture_output=True)
    if not onboarding and prepare_claude_home(rec):
        # with a test token, Claude Code's folder is the instance's own (prepare_claude_home): what setup puts in a new
        # person's (the build's hooks, Dispatch's MCP server with its tools allowed) goes there, as for Codex above
        home = claude_home(rec)
        claude_setup = ("import sys, json; sys.path.insert(0, sys.argv[1]); import engines, dispatch_mcp; "
                        "h = engines.get('claude-code').install_hooks(path=sys.argv[2], trust=True); "
                        "m = dispatch_mcp.register(['claude-code'], by_hand=False, paths={'claude-code': sys.argv[3]}); "
                        # the machine-wide rules (`dispatch rules sync` in setup): the person's GLOBAL.md and the build's own
                        # dispatch.md, inlined, so nothing outside the instance is written or pointed at
                        "import dispatch as D, os; t = D.rules_text(); d = D.dispatch_rules()[1]; "
                        "r = os.path.join(os.path.dirname(sys.argv[2]), 'CLAUDE.md'); "
                        "open(r, 'w', encoding='utf-8').write(t.rstrip() + '\\n\\n' + d.rstrip() + '\\n') if not os.path.exists(r) else None; "
                        "print(json.dumps({'hooks': bool(h), 'rules': os.path.getsize(r), 'mcp': m.get('changed') or m.get('same') or m.get('skipped')}))")
        r = subprocess.run([sys.executable, "-c", claude_setup, os.path.dirname(cli), os.path.join(home, "settings.json"),
                            os.path.join(home, ".claude.json")], env=instance_env(rec), timeout=60, capture_output=True, text=True)
        log("Claude Code（测试令牌）：" + ((r.stdout or r.stderr).strip()[-300:] or "?"))
    if hiding_wanted():
        # the main process' inspector, for hide-windows.mjs (127.0.0.1 only, like the CDP port)
        rec["inspect_port"] = free_port(taken | {port})
    # a development build starts as Electron with the source tree and its own flags (scripts/code.sh)
    rec["launch_env"] = dict(dev.get("env") or {}) if dev else {}
    argv = [binary] + (list(dev.get("args") or []) if dev else []) + profile_args(rec) + ["--remote-debugging-port=%d" % port, "--skip-release-notes", "--skip-welcome", "--disable-workspace-trust",
                                           # macOS: VS Code reads the login shell's environment over ours (~/.zshrc sets BEADS_DIR to
                                           # the real board); this keeps the instance on its own board
                                           "--force-disable-user-env",
                                           # secrets in a file under the user data, not the keychain: an ad-hoc signed build
                                           # would otherwise make macOS ask the user for keychain access on every start
                                           "--password-store=basic",
                                           # on macOS --password-store is not read: the window's secret storage asks the main
                                           # process whether encryption is available, which reads the keychain on the main
                                           # thread; a new ad-hoc build is not in the item's access list, so macOS asks and the
                                           # whole app (its DevTools port too) waits for an answer. Secrets in memory skip that.
                                           "--use-inmemory-secretstorage",
                                           # and Chromium's own cookie key (OSCrypt) from a mock keychain: a fixture HOME has
                                           # no login keychain, and asking for one brings up macOS's "keychain not found" dialog
                                           "--use-mock-keychain"]
    if rec.get("inspect_port"):
        argv.append("--inspect=%d" % rec["inspect_port"])
    if rec["folder"]:
        argv.append(rec["folder"])  # an editor window on it; --agents below brings the Agents window to it
    elif agents:
        argv.append("--agents")
    rec["argv"] = argv
    rec["profile_args"] = profile_args(rec)
    with open(rec["log"], "ab") as out:
        p = subprocess.Popen(argv, cwd=root, env=dict(instance_env(rec), **rec["launch_env"]), stdin=subprocess.DEVNULL, stdout=out, stderr=out, start_new_session=True)
    rec.update(pid=p.pid, started_at=datetime.datetime.now().astimezone().isoformat(timespec="seconds"))
    write_record(rec)
    if rec.get("inspect_port"):
        rec["hidden"] = hide_windows(rec)  # before its first window: off the person's screen from the start
        if not rec["hidden"].get("ok"):
            # a start that went on here put both windows in front of the person (task-4cpnb): stop it instead
            not_hidden(rec, "没能把窗口藏起来：%s" % rec["hidden"].get("error"), log)
    pages = wait_ready(p, port, wait, log)
    if not pages:
        stop(name, log=log)
        raise E2EError("no_cdp", "%d 秒内 CDP 端口 %d 没有可用的窗口，已结束这个实例；看 %s" % (wait, port, rec["log"]))
    if agents and rec["folder"]:
        pages = open_agents(rec, rec["folder"], log=log) or pages
    rec["windows"] = [t.get("title", "") for t in pages]
    rec["on_screen"] = check_hidden(rec, log=log)
    if rec["on_screen"]:
        not_hidden(rec, "%d 个窗口在屏幕上看得见（%s），再藏一次也没藏住" % (len(rec["on_screen"]), rec["on_screen"]), log)
    write_record(rec)
    return rec


def not_hidden(rec, why, log=print):
    """A test window the person could see: the instance is stopped and the start fails (DISPATCH_E2E_SHOW=1 is
    for someone who wants to watch)."""
    write_record(rec)
    stop(rec["name"], log=log)
    raise E2EError("not_hidden", "测试实例 %s %s；已结束这个实例，免得它留在你屏幕上。想看着它跑就设 DISPATCH_E2E_SHOW=1" % (rec["name"], why))


def open_agents(rec, folder, wait=90, log=print):
    """The Agents window on `folder`: the bridge in an editor window takes ide/agents-request from the
    instance's DISPATCH_DIR and opens it (the Agents window takes no folder from outside). Everything
    stays inside the instance: the app's bin/code launcher would start a second app process that waits
    for the instance to answer."""
    req = os.path.join(rec["dispatch_dir"], "ide", "agents-request")
    os.makedirs(os.path.dirname(req), exist_ok=True)
    until = time.time() + wait
    written = 0.0
    while time.time() < until:
        # one request at a time: a new one only when the last was taken and no Agents window came of it in 30 s, or
        # it went stale untaken. Writing one every 2 s handed a slow window the same folder three times, and the
        # late copies took it away from a page the scenario had opened meanwhile (found-automations, 10-08)
        taken = not os.path.exists(req)
        if not written or (taken and time.time() - written > 30) or (not taken and time.time() - written > 25):
            with open(req + ".tmp", "w") as f:
                json.dump({"root": folder, "at": time.time()}, f)
            os.replace(req + ".tmp", req)
            written = time.time()
        pages = cdp_pages(rec["port"], timeout=5) or []
        if any(re.search(r"sessions(-dev)?\.html", t.get("url") or "") for t in pages):
            return pages
        time.sleep(1)
    log("%d 秒内 Agents 窗口还没出来（机器忙时 bridge 起得慢）；请求留着，场景里的 openAgents() 会接着开" % wait)
    return cdp_pages(rec["port"], timeout=10)


def wait_ready(proc, port, wait, log=print):
    """The page targets once the instance answers at once: a new instance lists its window, then its
    main process stalls for up to a minute (agent host, shared storage) and a CDP call in that time
    hangs. Ready = three quick answers in a row."""
    until = time.time() + wait
    quick, pages, said = 0, None, False
    while time.time() < until:
        if proc is not None and proc.poll() is not None:
            raise E2EError("exited", "Dispatch IDE 起来就退出了（%s）" % proc.returncode)
        t0 = time.time()
        got = cdp_pages(port, timeout=10)
        if got:
            pages = got
            quick = quick + 1 if time.time() - t0 < 1 else 0
            if quick >= 3:
                return pages
            if not quick and not said:
                log("窗口出来了，等它不卡 …")
                said = True
        time.sleep(1)
    return None


# ---- keep the test windows off the person's screen ----------------------------------------------------
# User 2026-10-01: a test window must never come up in front of the person. The app starts with its main
# process' inspector on (--inspect=<port>, 127.0.0.1); hide-windows.mjs connects before the first window and
# makes every window transparent and click-through, shown without activating the app, and takes the app out of
# the Dock. A transparent window still draws: CDP pictures, clicks and typing work as before. CDP's
# Browser.setWindowBounds is not in this Electron, window.moveTo stops at the screen's edge, and an app hidden
# with ⌘H never draws a window shown while it is hidden (screenshots wait for ever), so none of those.
# DISPATCH_E2E_SHOW=1 leaves the windows as they are, for someone watching.

ONSCREEN_JS = r"""ObjC.import('CoreGraphics');
function run(argv) {
  // the windows of process argv[0] a person can see now: on the screen, not fully transparent; [[x, y, w, h], …]
  var pid = parseInt(argv[0], 10), out = [];
  var all = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 /* on screen only */, 0));
  for (var i = 0; i < all.count; i++) {
    var w = all.objectAtIndex(i);
    if (w.objectForKey('kCGWindowOwnerPID').intValue !== pid || w.objectForKey('kCGWindowLayer').intValue !== 0) continue;
    if (w.objectForKey('kCGWindowAlpha').doubleValue < 0.01) continue;
    var b = w.objectForKey('kCGWindowBounds');
    out.push([b.objectForKey('X').intValue, b.objectForKey('Y').intValue, b.objectForKey('Width').intValue, b.objectForKey('Height').intValue]);
  }
  return JSON.stringify(out);
}
"""


def hiding_wanted():
    return sys.platform == "darwin" and os.environ.get("DISPATCH_E2E_SHOW") != "1"


def hide_windows(rec, wait=60):
    """Put the hiding into the instance's main process (hide-windows.mjs, run by the app's own Electron as
    Node). Returns its answer: {"ok": bool, "windows": n, "error": …}. When the helper gives no answer, the error
    says why in its own words (exit code, stderr): an empty stdout read as "list index out of range" hid that the
    app's CLI had no hide-windows.mjs (task-4cpnb)."""
    script = os.path.join(SCRIPTS, "hide-windows.mjs")
    if not os.path.isfile(script):
        return {"ok": False, "error": "%s is missing: this copy of the dispatch CLI cannot hide test windows" % script}
    env = {k: v for k, v in os.environ.items() if not k.startswith(("VSCODE_", "ELECTRON_"))}
    env["ELECTRON_RUN_AS_NODE"] = "1"
    try:
        r = subprocess.run([rec["binary"], script, str(rec["inspect_port"]), str(int(wait * 1000)), str(rec.get("port") or 0)],
                           env=env, capture_output=True, text=True, timeout=wait + 20, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"ok": False, "error": str(e)[:300]}
    for line in reversed(r.stdout.strip().splitlines()):
        try:
            got = json.loads(line)
        except ValueError:
            continue
        if isinstance(got, dict) and "ok" in got:
            return got
    said = (r.stderr.strip() or r.stdout.strip() or "nothing")[-300:]
    return {"ok": False, "error": "hide-windows.mjs gave no answer (exit %s): %s" % (r.returncode, said)}


def onscreen_windows(pid):
    """The app's windows a person can see now, [[x, y, w, h], …]; None when that cannot be read."""
    if sys.platform != "darwin":
        return None
    try:
        r = subprocess.run(["osascript", "-l", "JavaScript", "-e", ONSCREEN_JS, str(pid)], capture_output=True, text=True, timeout=15)
        return json.loads(r.stdout.strip()) if r.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def check_hidden(rec, tries=10, log=print):
    """After the start: the instance's windows a person can see now ([] none, None cannot be read). A window still
    seen after `tries` looks is hidden once more (the hook in the main process hides the windows it finds) and
    looked at again; what is still seen then is said loudly and returned."""
    if not rec.get("inspect_port"):
        return None
    shown = None
    for again in (False, True):
        if again:
            log("测试实例 %s 有 %d 个窗口在屏幕上看得见（%s），再藏一次" % (rec["name"], len(shown), shown))
            rec["hidden_again"] = hide_windows(rec, wait=15)
        for _ in range(tries):
            shown = onscreen_windows(rec["pid"])
            if not shown:
                return shown
            time.sleep(0.5)
    log("注意：测试实例 %s 有 %d 个窗口在屏幕上看得见（%s），没能藏起来" % (rec["name"], len(shown), shown))
    return shown


def profile_args(rec):
    out = []
    for key, _, flag in PROFILE:
        if rec.get(key):
            out += [flag, rec[key]]
    return out


def list_instances():
    rows = ps_rows()
    out = []
    d = instances_dir()
    for fn in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, fn), encoding="utf-8") as f:
                rec = json.load(f)
        except (OSError, ValueError):
            continue
        rec["running"] = is_alive(rec, rows) if rec.get("pid") else False
        out.append(rec)
    return out


def env_victims(rec, rows, me=None):
    """[(pid, command)] of the programs that run with this instance's environment (instance_env: its
    DISPATCH_E2E_INSTANCE and its folders) but name nothing of it on their command line: a development build's chatd
    and board service run the checkout's CLI, and went on writing into the instance's folder after `stop`, which put
    a half folder back under the next instance's feet (10-08). Never this process or the shells above it."""
    me = os.getpid() if me is None else me
    safe = set(ancestors(rows, me)) | {me}
    tag, root = "DISPATCH_E2E_INSTANCE=%s" % rec["name"], rec["root"].rstrip("/") + "/"
    try:
        # another process's environment can hold bytes that are not UTF-8 (stop crashed on one, 2026-10-21)
        r = subprocess.run(["ps", "-axEww", "-o", "pid=,command="], capture_output=True, text=True, errors="replace", timeout=20)
    except (OSError, subprocess.SubprocessError):
        return []
    cmds = {pid: cmd for pid, _, cmd in rows}
    out = []
    for line in r.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) < 2 or not parts[0].isdigit() or int(parts[0]) in safe:
            continue
        pid, text = int(parts[0]), parts[1]
        if re.search(r"(^|\s)%s(\s|$)" % re.escape(tag), text) and ("=" + root) in text and pid in cmds:
            out.append((pid, cmds[pid]))
    return out


def stop(name=DEFAULT_NAME, wait=20, log=print):
    rec = read_record(name)
    rows = ps_rows()
    main_ok, victims = plan_stop(rows, rec)
    have = {p for p, _ in victims}
    victims += [v for v in env_victims(rec, rows) if v[0] not in have]
    if not victims:
        log("测试实例 %s 没有在跑的进程" % name)
    else:
        log("结束测试实例 %s 的 %d 个进程：" % (name, len(victims)))
        for pid, cmd in victims:
            log("  %d  %s" % (pid, cmd[:200]))
    left = []
    if main_ok and rec["pid"] in [p for p, _ in victims]:  # not when the caller runs inside the instance
        os.kill(rec["pid"], signal.SIGTERM)
        wait_gone([rec["pid"]], wait)
    # the rest: helpers, and second app processes a launcher started to hand arguments over (they only
    # take SIGTERM once the instance they wait for is gone, so ask again a few times)
    for _ in range(3):
        rows2 = {pid: cmd for pid, _, cmd in ps_rows()}
        left = [pid for pid, cmd in victims if rows2.get(pid) == cmd]
        if not left:
            break
        for pid in left:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        left = wait_gone(left, 6)
        if not left:
            break
    if left:
        log("还有 %d 个没退出（没用 -9）：%s" % (len(left), " ".join(map(str, left))))
    termd = stop_instance_termd(rec)
    if termd:
        log("结束了测试实例 %s 的终端服务 %d" % (name, termd))
    booted = bootout_instance_jobs(name)
    if booted:
        log("注销了测试实例 %s 的后台服务：%s" % (name, " ".join(booted)))
    # a launch registers the app with LaunchServices; take a build's copy out again so the Dock and Spotlight only
    # know /Applications' one (task-7ve7v)
    bundle = re.match(r"(.+?\.app)/Contents/MacOS/", rec.get("binary") or "")
    if not left and bundle and not bundle.group(1).startswith("/Applications/"):
        import builds
        builds.forget_app(bundle.group(1))
    rec["stopped_at"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    write_record(rec)
    return {"ok": not left, "name": name, "stopped": [p for p, _ in victims if p not in left], "left": left, "main_was_ours": main_ok,
            "launchd": booted}


def stop_instance_termd(rec):
    """The terminal daemon an instance's window started (app/termd, `dispatch terminal daemon`) runs in a process
    group of its own so that it outlives the app: stop it with the instance. Only a process whose command line is
    termd.cjs with this instance's state folder. Returns its pid, or 0."""
    d = rec.get("dispatch_dir") or ""
    try:
        with open(os.path.join(d, "termd", "daemon.json")) as f:
            pid = int(json.load(f).get("pid") or 0)
    except (OSError, ValueError, TypeError):
        return 0
    cmd = {p: c for p, _, c in ps_rows()}.get(pid, "")
    if not pid or "termd.cjs" not in cmd or os.path.join(d, "termd") not in cmd:
        return 0
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return 0
    wait_gone([pid], 6)
    return pid


def bootout_instance_jobs(name):
    """LaunchAgents an instance registered (chatd from its first-run wizard, …) carry the label prefix
    dev.dispatch-e2e-<instance> and live in the person's real launchd domain: left behind they restart
    with the instance's temporary HOME and macOS asks for a keychain that is not there (2026-10-01)."""
    if sys.platform != "darwin":
        return []
    prefix = "dev.dispatch-e2e-%s." % "".join(c for c in name if c.isalnum() or c in "-_")
    try:
        out = subprocess.run(["launchctl", "list"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    done = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[2].startswith(prefix):
            subprocess.run(["launchctl", "bootout", "gui/%d/%s" % (os.getuid(), parts[2])], capture_output=True, timeout=10)
            done.append(parts[2])
    return done


# ---- e2e run ----------------------------------------------------------------------------------------

def scenario_path(s):
    if os.path.isfile(s):
        return os.path.abspath(s)
    for cand in (os.path.join(SCRIPTS, "scenarios", s), os.path.join(SCRIPTS, "scenarios", s + ".mjs")):
        if os.path.isfile(cand):
            return cand
    raise E2EError("no_scenario", "没有这个场景：%s（dispatch ide e2e scenarios 看自带的）" % s)


def list_scenarios():
    d = os.path.join(SCRIPTS, "scenarios")
    out = []
    for fn in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        if fn.endswith(".mjs"):
            title = ""
            with open(os.path.join(d, fn), encoding="utf-8") as f:
                m = re.search(r"title:\s*\"([^\"]+)\"", f.read(4000))
                title = m.group(1) if m else ""
            out.append({"name": fn[:-4], "path": os.path.join(d, fn), "title": title})
    return out


def guard(rec):
    """Refuse to drive anything but the instance as it was started."""
    rows = ps_rows()
    if not is_alive(rec, rows):
        raise E2EError("not_running", "测试实例 %s 没在跑（dispatch ide instance start %s）" % (rec["name"], rec["name"]))
    if not port_is_ours(rec, rows):
        raise E2EError("port_not_ours", "端口 %d 现在不是测试实例 %s 的进程在听（或 lsof 查不出来），不连" % (rec["port"], rec["name"]))
    now = fingerprint(rec["app"])
    if now != (rec.get("build") or {}).get("fingerprint"):
        raise E2EError("build_changed", "%s 在实例启动后被换过（别的构建覆盖了？），界面和 bridge 可能不是同一版；重新 instance start" % rec["app"])


def clear_previous_run(out):
    """An --out folder used before: remove what that run wrote (its steps.json names every picture),
    so no stale screenshot or error.png is left next to the new ones. Nothing else in the folder."""
    try:
        with open(os.path.join(out, "steps.json"), encoding="utf-8") as f:
            old = json.load(f)
    except (OSError, ValueError):
        return
    names = set(old.get("shots") or []) | set(old.get("frames") or []) | {"steps.json", "00-where-is-what.png", "README.md", "error.png", "error.txt", "refused-type.png"}
    for n in names:
        p = os.path.join(out, os.path.basename(n))
        if os.path.isfile(p):
            os.remove(p)


def meta_timeout(spath):
    """The seconds a scenario says it may take (`export const meta = { timeout: N, … }`): one that waits on a
    real agent needs more than the default. 0 when it says nothing. Only meta's own key counts, not one inside
    meta.instance or meta.env."""
    try:
        with open(spath, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return 0
    m = re.search(r"export\s+const\s+meta\s*=\s*\{", text)
    if not m:
        return 0
    depth, top, quote = 1, [], ""
    for ch in text[m.end():]:
        if quote:
            quote = "" if ch == quote else quote
        elif ch in "'\"`":
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if not depth:
                break
        if depth == 1 and not quote and ch not in "{}":
            top.append(ch)
    t = re.search(r"(?:^|[,\s])timeout:\s*(\d+)", "".join(top))
    return int(t.group(1)) if t else 0


def run(scenario, instance=DEFAULT_NAME, out="", annotate_after=True, timeout=300, stream=None):
    import e2e_suite  # what the scenario declares: its needs and its own variables
    rec = read_record(instance)
    guard(rec)
    spath = scenario_path(scenario)
    stem = os.path.splitext(os.path.basename(spath))[0]
    # outside the instance's folder, which the next `instance start` clears
    out = os.path.abspath(os.path.expanduser(out)) if out else os.path.join(runs_dir(), "%s-%s" % (stem, time.strftime("%Y%m%d-%H%M%S")))
    os.makedirs(out, exist_ok=True)
    clear_previous_run(out)
    runner = os.path.join(SCRIPTS, "runner.mjs")
    meta = e2e_suite.read_meta(spath, rec["app"])
    # what the scenario says it may take (meta.timeout; read from the file too when the runner could not import it)
    timeout = max(timeout, meta_timeout(spath), int(meta.get("timeout") or 0))
    missing = e2e_suite.unmet(meta.get("needs"), meta.get("setup", ""), rec["app"])
    if missing:
        return {"ok": None, "skipped": "; ".join("%s: %s" % m for m in missing), "out": out, "steps": 0, "shots": [], "marks": 0}
    env = {k: v for k, v in e2e_suite.scenario_env(meta).items() if not k.startswith(("VSCODE_", "ELECTRON_"))}
    # what a fixture put on the instance's PATH (the other Mac's ssh) is on the scenario's too, and its variables
    fx = dict(rec.get("fixture_env") or {})
    if fx.get("PATH_PREPEND"):
        env["PATH"] = os.pathsep.join([fx.pop("PATH_PREPEND"), env.get("PATH", "")])
    fx.pop("PATH_DROP", None)  # the instance's, not the scenario's
    for k, v in fx.items():
        env.setdefault(k, v)
    if env.get(CLAUDE_TOKEN):
        # a `claude` the scenario runs itself (`claude -p` for History) is the instance's: same config folder, token, Haiku
        env.update(CLAUDE_CONFIG_DIR=claude_home(rec), CLAUDE_CODE_OAUTH_TOKEN=env[CLAUDE_TOKEN], ANTHROPIC_MODEL=CLAUDE_TEST_MODEL)
    env["ELECTRON_RUN_AS_NODE"] = "1"
    argv = [rec["binary"], runner, "--record", record_path(instance), "--scenario", spath, "--out", out, "--timeout", str(timeout)]
    proc = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        scale = max(1.0, float(os.environ.get("DISPATCH_E2E_TIME_SCALE") or 1))  # runner.mjs TIME_SCALE
        stdout, stderr = proc.communicate(timeout=timeout * scale + 180)  # the runner's own limit, plus a stalled attach
    except subprocess.TimeoutExpired:
        proc.terminate()
        try:
            stdout, stderr = proc.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            stdout, stderr = "", ""
        raise E2EError("timeout", "场景 %d 秒还没结束，已停下 runner；已走的步骤在 %s" % (timeout * scale + 180, os.path.join(out, "steps.json")))
    p = subprocess.CompletedProcess(argv, proc.returncode, stdout, stderr)
    if stream and p.stderr.strip():
        stream(p.stderr.rstrip())
    res = None
    for line in reversed(p.stdout.strip().splitlines()):
        try:
            res = json.loads(line)
            break
        except ValueError:
            continue
    if res is None:
        raise E2EError("runner_failed", "场景没跑起来：%s" % (p.stderr or p.stdout).strip()[-800:])
    res["steps_json"] = os.path.join(out, "steps.json")
    if annotate_after and res.get("marks"):
        try:
            res["annotated"] = annotate(out)
        except E2EError as e:
            # the picture with every mark is extra: the run's own result (passed, or the scenario's error) stands
            res["annotate_skipped"] = str(e)
    return res


# ---- annotate ------------------------------------------------------------------------------------------

def _pil():
    try:
        from PIL import Image, ImageDraw, ImageFont  # noqa: F401
        return True
    except ImportError:
        return False


def _python_with_pil():
    for py in (shutil.which("python3"), "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"):
        if py and os.path.isfile(py) and os.path.realpath(py) != os.path.realpath(sys.executable or ""):
            if subprocess.run([py, "-c", "import PIL"], capture_output=True, timeout=30).returncode == 0:
                return py
    return ""


def _glyph(fnt, ch):
    from PIL import Image, ImageDraw
    im = Image.new("L", (64, 64), 0)
    ImageDraw.Draw(im).text((4, 4), ch, font=fnt, fill=255)
    return im.tobytes()


def covers(fnt, text):
    """Whether the font draws every character of text (a missing one draws like U+10FFFD)."""
    missing = _glyph(fnt, "\U0010FFFD")
    return all(ch.isspace() or _glyph(fnt, ch) != missing for ch in set(text))


def font(size, text=""):
    from PIL import ImageFont
    first = None
    for p in FONTS:
        if os.path.isfile(p):
            try:
                f = ImageFont.truetype(p, size)
            except OSError:
                continue
            if not text or covers(f, text):
                return f
            first = first or f
    if first:
        return first
    try:
        return ImageFont.load_default(size)
    except TypeError:
        return ImageFont.load_default()


def wrap(draw, text, fnt, width):
    """Lines of `text` that fit `width` pixels (CJK text has no spaces: break anywhere)."""
    lines, cur = [], ""
    for ch in text:
        if draw.textlength(cur + ch, font=fnt) > width and cur:
            lines.append(cur)
            cur = ch.lstrip()
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines or [""]


def legend_line(m):
    return " · ".join(x for x in (m.get("what"), m.get("where"), m.get("how")) if x)


RED = (220, 38, 38)


def badge_spot(x0, y0, x1, y1, r, w, h, avoid=()):
    """Where a mark's number goes: outside its box, left of it first, then right, above, below (level
    with the box it covers least of the neighbouring text); the first spot that stays on the picture
    and covers no other mark's box or number (`avoid`: boxes)."""
    cy = (y0 + y1) / 2
    spots = [(x0 - r - 6, cy), (x1 + r + 6, cy), (x0 + r, y0 - r - 6), (x0 + r, y1 + r + 6)]

    def fits(cx, cy):
        if cx - r < 0 or cy - r < 0 or cx + r > w or cy + r > h:
            return False
        return not any(cx + r > a[0] and cx - r < a[2] and cy + r > a[1] and cy - r < a[3] for a in avoid)

    for cx, cy2 in spots:
        if fits(cx, cy2):
            return cx, cy2
    cx, cy2 = spots[0]
    return min(max(cx, r + 2), w - r - 2), min(max(cy2, r + 2), h - r - 2)


def annotate(run_dir):
    """00-where-is-what.png and README.md in run_dir from its steps.json marks."""
    run_dir = os.path.abspath(os.path.expanduser(run_dir))
    try:
        with open(os.path.join(run_dir, "steps.json"), encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        raise E2EError("no_run", "%s 里没有 steps.json（先 dispatch ide e2e run）" % run_dir)
    marks = doc.get("marks") or []
    if not marks:
        raise E2EError("no_marks", "这次运行没有 mark()，没东西可标")
    if not _pil():
        py = _python_with_pil()
        if not py:
            raise E2EError("no_pillow", "画标注图要 Pillow：python3 -m pip install pillow")
        r = subprocess.run([py, os.path.abspath(__file__), "annotate", run_dir, "--json"], capture_output=True, text=True, timeout=300)
        try:
            return json.loads(r.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            raise E2EError("annotate_failed", (r.stderr or r.stdout).strip()[-600:])
    from PIL import Image, ImageDraw

    vp = doc.get("viewport") or {}
    frames = []
    for m in marks:
        if m["frame"] not in frames:
            frames.append(m["frame"])
    target_w = 1800
    pieces = []
    for fr in frames:
        im = Image.open(os.path.join(run_dir, fr)).convert("RGB")
        vw = next((m.get("vw") for m in marks if m["frame"] == fr and m.get("vw")), None) or vp.get("w") or im.width
        scale = im.width / float(vw)
        k = target_w / float(im.width)
        im = im.resize((target_w, int(im.height * k)), Image.LANCZOS)
        s = scale * k
        dr = ImageDraw.Draw(im)
        badge_f = font(26)
        here = [m for m in marks if m["frame"] == fr]
        boxes = [((m["box"]["x"]) * s - 4, m["box"]["y"] * s - 4, (m["box"]["x"] + m["box"]["w"]) * s + 4, (m["box"]["y"] + m["box"]["h"]) * s + 4) for m in here]
        for x0, y0, x1, y1 in boxes:
            dr.rounded_rectangle([x0, y0, x1, y1], radius=8, outline=RED, width=4)
        placed = []
        for m, (x0, y0, x1, y1) in zip(here, boxes):
            label = str(m["n"])
            r = 19
            cx, cy = badge_spot(x0, y0, x1, y1, r, im.width, im.height, [b for b in boxes if b != (x0, y0, x1, y1)] + placed)
            placed.append((cx - r, cy - r, cx + r, cy + r))
            dr.ellipse([cx - r, cy - r, cx + r, cy + r], fill=RED, outline=(255, 255, 255), width=3)
            tw = dr.textlength(label, font=badge_f)
            dr.text((cx - tw / 2, cy - 15), label, font=badge_f, fill=(255, 255, 255))
        pieces.append(im)
    line_f = font(30, "".join(legend_line(m) for m in marks))
    num_f = font(26)
    probe = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    pad = 40
    text_w = target_w - pad * 2 - 56
    rows = []
    for m in marks:
        rows.append((m["n"], wrap(probe, legend_line(m), line_f, text_w)))
    line_h = 44
    legend_h = pad + sum(len(ls) * line_h + 14 for _, ls in rows) + pad
    total_h = sum(p.height for p in pieces) + 16 * (len(pieces) - 1) + legend_h
    canvas = Image.new("RGB", (target_w, total_h), (255, 255, 255))
    y = 0
    for p in pieces:
        canvas.paste(p, (0, y))
        y += p.height + 16
    y += pad - 16
    dr = ImageDraw.Draw(canvas)
    for n, ls in rows:
        r = 18
        dr.ellipse([pad, y + 4, pad + 2 * r, y + 4 + 2 * r], fill=RED)
        tw = dr.textlength(str(n), font=num_f)
        dr.text((pad + r - tw / 2, y + 7), str(n), font=num_f, fill=(255, 255, 255))
        for i, l in enumerate(ls):
            dr.text((pad + 56, y + i * line_h), l, font=line_f, fill=(28, 25, 23))
        y += len(ls) * line_h + 14
    png = os.path.join(run_dir, "00-where-is-what.png")
    canvas.save(png, optimize=True)
    readme = os.path.join(run_dir, "README.md")
    with open(readme, "w", encoding="utf-8") as f:
        f.write(readme_text(doc, run_dir))
    return {"ok": True, "png": png, "readme": readme, "marks": len(marks), "frames": frames}


def readme_text(doc, run_dir):
    meta = doc.get("meta") or {}
    title = meta.get("title") or os.path.splitext(os.path.basename(doc.get("scenario") or run_dir))[0]
    inst = doc.get("instance") or {}
    b = inst.get("build") or {}
    out = ["# %s" % title, ""]
    if meta.get("description"):
        out += [meta["description"], ""]
    out += ["![在哪](00-where-is-what.png)", ""]
    for m in doc.get("marks") or []:
        out.append("%d. %s" % (m["n"], legend_line(m)))
    out += ["", "## 截图", ""]
    for s in doc.get("shots") or []:
        out.append("- [%s](%s)" % (s, s))
    out += ["", "## 怎么跑出来的", ""]
    pair = "%s-%s" % ((b.get("dispatch_ide") or "")[:12], (b.get("kanban") or "")[:12]) if b.get("dispatch_ide") else (b.get("commit") or "")[:12]
    out.append("- 测试实例 %s（端口 %s），Dispatch IDE 构建 %s %s" % (inst.get("name", ""), inst.get("port", ""), pair, b.get("version", "")))
    steps = doc.get("steps") or []
    status = "通过" if doc.get("ok") else "失败：%s" % ((doc.get("error") or {}).get("message", ""))
    scen = doc.get("scenario", "")
    builtin = os.path.join(SCRIPTS, "scenarios") + os.sep
    scen = os.path.splitext(os.path.basename(scen))[0] if scen.startswith(builtin) else scen.replace(os.path.expanduser("~"), "~", 1)
    when = doc.get("started", "")
    try:
        when = datetime.datetime.fromisoformat(when.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M")
    except ValueError:
        pass
    out.append("- 场景 `%s`，%d 步，%s，%s" % (scen, len(steps), status, when))
    out.append("- 每一步在 steps.json；重跑：`dispatch ide e2e run %s --instance %s`" % (scen, inst.get("name", "")))
    return "\n".join(out) + "\n"


# ---- command line ----------------------------------------------------------------------------------------

def parser():
    p = argparse.ArgumentParser(prog="dispatch ide", description="Dispatch IDE 的界面端到端测试：隔离的测试实例、跑场景、生成「在哪」标注图")
    sub = p.add_subparsers(dest="group", required=True)
    s = sub.add_parser("instance", help="测试实例：start / list / stop")
    s.add_argument("op", choices=["start", "list", "stop"])
    s.add_argument("name", nargs="?", default=DEFAULT_NAME)
    s.add_argument("--app", default="", help="Dispatch IDE.app（默认 ~/dispatch-builds 里最新构建好的）")
    s.add_argument("--folder", default="", help="打开这个目录（默认演示项目）")
    s.add_argument("--agents", action="store_true", help="直接开 Agents 窗口")
    s.add_argument("--no-seed", action="store_true", help="不建演示项目和任务（任务板仍是临时的空板）")
    s.add_argument("--onboarding", choices=["fresh", "terminal"], default="", help="全新 HOME 和假引擎，验证两屏或四屏首次向导")
    s.add_argument("--tips", action="store_true", help="Getting started 的提示照常弹（默认测试实例里关掉）")
    s.add_argument("--motion", action="store_true", help="动效照常（默认测试实例里关掉，省 CPU）")
    s.add_argument("--fixture", default="", help="启动前先跑 fixtures/<名>.py 的 prepare(rec)（场景的 meta.instance.fixture）")
    s.add_argument("--port", type=int, default=0, help="CDP 端口（默认自动挑空闲的）")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("e2e", help="run 场景 / annotate 标注图 / scenarios 自带场景")
    s.add_argument("op", choices=["run", "annotate", "scenarios", "suite"])
    s.add_argument("target", nargs="*", default=[], help="run：场景文件或自带场景名；annotate：run 目录；suite：场景名（默认全部）")
    s.add_argument("--instance", default=DEFAULT_NAME)
    s.add_argument("--fresh", action="store_true", help="run：照场景 meta.instance 新起一个实例，跑完就关")
    s.add_argument("--app", default="", help="run --fresh / suite：Dispatch IDE.app（默认最新构建）")
    s.add_argument("--repeat", type=int, default=1, help="suite：整套跑几遍")
    s.add_argument("--lanes", type=int, default=1, help="suite：同时跑几个实例（meta.exclusive 的场景单独跑）")
    s.add_argument("--out", default="")
    s.add_argument("--no-annotate", action="store_true")
    s.add_argument("--timeout", type=int, default=300, help="场景最多跑多久（秒）")
    s.add_argument("--json", action="store_true")
    return p


def _emit(obj, as_json, text):
    if as_json:
        print(json.dumps(obj, ensure_ascii=False), flush=True)
    else:
        print(text, flush=True)



def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else None
    except (OSError, ValueError):
        return None

def main(argv=None):
    a = parser().parse_args(argv)
    say = (lambda *_: None) if a.json else (lambda m: print(m, flush=True))
    try:
        if a.group == "instance":
            if a.op == "start":
                r = start(a.name, a.app or None, a.folder, a.agents, not a.no_seed, a.port, log=say, onboarding=a.onboarding, scenario_fixture=a.fixture, tips=a.tips, motion=a.motion)
                b = r["build"]
                _emit(dict(r, ok=True), a.json, "测试实例 %s 起来了：pid %d，CDP 端口 %d\n  App %s\n  构建 %s（dispatch-ide %s，kanban %s）\n  CLI %s\n  目录 %s\n  记录 %s"
                      % (r["name"], r["pid"], r["port"], r["app"], b.get("name") or b.get("version"), b.get("dispatch_ide", "")[:12] or "?",
                         b.get("kanban", "")[:12] or "?", r["cli_source"], r["root"], record_path(r["name"])))
            elif a.op == "list":
                rows = list_instances()
                _emit({"ok": True, "instances": rows}, a.json, "\n".join(
                    "%-10s %-8s pid %-7s 端口 %-6s %s" % (r["name"], "在跑" if r["running"] else "已停", r.get("pid"), r.get("port"),
                                                        (r.get("build") or {}).get("name") or r.get("app")) for r in rows) or "没有测试实例")
            else:
                r = stop(a.name, log=say)
                _emit(r, a.json, "已结束测试实例 %s" % a.name if r["ok"] else "测试实例 %s 还有进程没退出：%s" % (a.name, r["left"]))
                return 0 if r["ok"] else 1
            return 0
        if a.op == "scenarios":
            rows = list_scenarios()
            _emit({"ok": True, "scenarios": rows}, a.json, "\n".join("%-22s %s" % (r["name"], r["title"]) for r in rows))
            return 0
        if a.op == "suite":
            import e2e_suite
            r = e2e_suite.suite(a.target, a.app or None, a.out, max(1, a.repeat), a.timeout, log=say, lanes=max(1, a.lanes))
            counts = {}
            for x in r["results"]:
                counts[x["status"]] = counts.get(x["status"], 0) + 1
            _emit(r, a.json, "%s：%s\n  %s" % ("全部没挂" if r["ok"] else "有失败", "  ".join("%s %d" % kv for kv in sorted(counts.items())),
                                               os.path.join(r["out"], "summary.md")))
            return 0 if r["ok"] else 1
        if not a.target:
            raise E2EError("usage", "要给 %s" % ("场景文件" if a.op == "run" else "run 目录"))
        target = a.target[0]
        if a.op == "run" and a.fresh:
            import e2e_suite
            r = e2e_suite.run_fresh(target, a.app or None, a.out, a.timeout, name=a.instance, log=say)
            _emit(r, a.json, "%s %s %s" % (r["scenario"], r["status"], r.get("reason") or r.get("error") or ""))
            return 1 if r["status"] == "failed" else 0
        if a.op == "run":
            r = run(target, a.instance, a.out, not a.no_annotate, a.timeout, stream=None if a.json else say)
            if r.get("skipped"):
                _emit(r, a.json, "跳过：%s\n  目录 %s" % (r["skipped"], r.get("out")))
                return 0
            # a scenario that skipped part of its checks writes not-tested.json: that is a partial pass
            skipped = _read_json(os.path.join(r.get("out") or "", "not-tested.json")) if r.get("ok") and r.get("out") else None
            if skipped:
                r["partial"] = skipped
            verdict = ("部分通过（没测：%s）" % "、".join(skipped.get("checks") or [skipped.get("reason", "")])) if skipped else "通过" if r.get("ok") else "失败"
            text = "%s：%d 步，截图 %s\n  目录 %s" % (verdict, r.get("steps", 0), ", ".join(r.get("shots") or []) or "无", r.get("out"))
            if skipped and skipped.get("reason"):
                text += "\n  原因：%s" % skipped["reason"]
            if r.get("error"):
                text += "\n  出错：%s（%s）" % (r["error"].get("message"), r["error"].get("shot") or "")
            if r.get("annotated"):
                text += "\n  标注图 %s" % r["annotated"]["png"]
            elif r.get("annotate_skipped"):
                text += "\n  没画标注图：%s" % r["annotate_skipped"]
            _emit(r, a.json, text)
            return 0 if r.get("ok") else 1
        r = annotate(target)
        _emit(r, a.json, "标注图 %s\nREADME 草稿 %s" % (r["png"], r["readme"]))
        return 0
    except E2EError as e:
        if a.json:
            print(json.dumps({"ok": False, "error": e.code, "message": str(e)}, ensure_ascii=False), flush=True)
        else:
            print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "annotate":
        # re-run by a Python that has Pillow: `ide_e2e.py annotate DIR --json`
        try:
            print(json.dumps(annotate(sys.argv[2]), ensure_ascii=False))
            sys.exit(0)
        except E2EError as e:
            print(json.dumps({"ok": False, "error": e.code, "message": str(e)}, ensure_ascii=False))
            sys.exit(1)
    sys.exit(main(sys.argv[1:]))
