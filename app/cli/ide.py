# -*- coding: utf-8 -*-
"""`dispatch ide`: what Dispatch IDE (our desktop build of Code - OSS, design/two-modes) and its
dispatch-bridge extension (app/ide-ext) ask the CLI for.

  status                     is Dispatch IDE.app on this Mac (`native`: its path)
  native-open --root DIR     open the folder in Dispatch IDE, note the conversation (sessions.json)
  agents [--root DIR] [--session KEY]
                             the Agents window (Dispatch Agent), on that folder or that session
  back [--root DIR]          the editor → the Agents window, that folder's conversation selected
  recommend --root DIR       language extensions this project wants (by file extension)
  edit                       ⌘K: rewrite a selection with the model from the ide_edit_model setting
  usage add|today            Tab completion spend (DeepSeek FIM), per day
  signal NAME                a one-line signal file (focus-chat, add-to-chat, …)
  folder-session --root DIR  the newest Agents-window session of that folder (the editor chat opens it)
  archive-session KEY        archive an Agents-window session through its editor's Agent Host (ide_sessions.py)
  instance start|list|stop   isolated test instances; e2e run|annotate|scenarios: UI end-to-end tests (ide_e2e.py)

Run-time state (sessions, usage, signal, open-request, agents-request) lives under ~/tasks/.dispatch/ide.
"""
import sys

sys.dont_write_bytecode = True
from lang import t as _t

import argparse
import datetime
import json
import os
import re
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import dplatform as P  # noqa: E402


# Language extensions from Open VSX (PLAN.md §3.3), in the order they are recommended.
LANGS = [
    ("python", "Python", (".py", ".pyi"), ["ms-python.python", "detachhead.basedpyright"]),
    ("swift", "Swift", (".swift",), ["swiftlang.swift-vscode"]),
    ("rust", "Rust", (".rs",), ["rust-lang.rust-analyzer", "vadimcn.vscode-lldb"]),
    ("bash", "Bash", (".sh", ".bash"), ["mads-hartmann.bash-ide-vscode"]),
]
WALK_SKIP = {".git", "node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__", ".next", ".build", "Pods", "DerivedData"}
WALK_LIMIT = 50000

# DeepSeek FIM prices per million tokens, 2026-09 list (off-peak, peak). Estimates use the peak
# price so the daily cap errs on the safe side.
TAB_PRICES = {"deepseek-flash": {"input_miss": (0.15, 0.30), "input_hit": (0.003, 0.006), "output": (0.60, 1.20)}}
TAB_PRICE_NOTE = "2026-09"
TAB_DEFAULT_MODEL = "deepseek-flash"
EDIT_DEFAULT_MODEL = "claude:sonnet"
EDIT_TIMEOUT = 90
# ⌘K rewrites a selection, not a file: past this the answer would not fit max_tokens (or take minutes)
EDIT_MAX_LINES = 500
EDIT_MAX_CHARS = 20000
EDIT_MAX_TOKENS = 8000            # DeepSeek and most OpenAI-style APIs refuse more

EDIT_SYSTEM = ("You rewrite a selection of source code as the instruction says. Output only the code that replaces "
               "the selection: no explanation, no markdown fences, no line numbers, nothing before or after it. "
               "Keep the file's indentation and style. If the instruction cannot be applied, output the selection unchanged. "
               "只输出替换后的代码，不要解释，不要 fence。")


class IdeError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code


# ---- paths ------------------------------------------------------------------------------------

def dispatch_dir():
    return os.environ.get("DISPATCH_DIR") or os.path.join(P.HOME, "tasks", ".dispatch")


def state_dir():
    """Run-time files the app and the extension share (server.json, usage, dirty, signal)."""
    return os.path.join(dispatch_dir(), "ide")


def state_path(*parts):
    return os.path.join(state_dir(), *parts)


# ---- small file helpers -----------------------------------------------------------------------

def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def write_json(path, data, private=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.%d.tmp" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600 if private else 0o644)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    if private:
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)


class Lock(object):
    """An exclusive lock on a file under state_dir (flock), so two `ide start` at once start one server."""

    def __init__(self, name):
        self.path = state_path(name + ".lock")
        self.f = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.f = open(self.path, "a")
        try:
            import fcntl
            fcntl.flock(self.f.fileno(), fcntl.LOCK_EX)
        except ImportError:
            pass
        return self

    def __exit__(self, *exc):
        try:
            import fcntl
            fcntl.flock(self.f.fileno(), fcntl.LOCK_UN)
        except ImportError:
            pass
        self.f.close()


def settings():
    try:
        import dispatch as D
        return D.settings_load()
    except Exception:
        return {}


def version_tuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", str(v or ""))[:4])


def extensions_dir():
    """Where Dispatch IDE keeps its extensions (product.json dataFolderName `.dispatch-ide`)."""
    return os.environ.get("DISPATCH_IDE_EXTENSIONS") or os.path.join(P.HOME, ".dispatch-ide", "extensions")


def installed_extensions():
    """{id: version}: VS Code's own registry (ext/extensions.json) where its folder exists, else the
    folder names (publisher.name-1.2.3[-platform]). The registry drops uninstalled extensions whose
    folder is still waiting for removal."""
    out = {}
    d = extensions_dir()
    reg = read_json(os.path.join(d, "extensions.json"))
    if isinstance(reg, list):
        for e in reg:
            try:
                ext_id, ver, loc = e["identifier"]["id"].lower(), e.get("version", ""), e.get("relativeLocation") or ""
            except (KeyError, TypeError, AttributeError):
                continue
            if loc and os.path.isdir(os.path.join(d, loc)):
                out[ext_id] = ver
        return out
    try:
        names = os.listdir(d)
    except OSError:
        return out
    for n in names:
        m = re.match(r"^([A-Za-z0-9][\w-]*\.[\w-]+?)-(\d+\.\d+\.\d+[\w.+-]*)$", n)
        if m and os.path.isdir(os.path.join(d, n)):
            ext_id = m.group(1).lower()
            ver = re.sub(r"-(universal|(darwin|linux|win32|alpine|web)-.*)$", "", m.group(2))
            if version_tuple(ver) >= version_tuple(out.get(ext_id, "")):
                out[ext_id] = ver
    return out


def note_session(root, sid):
    """sessions.json: {root: {sid, at}}, the chat session the IDE was last opened for in each
    folder ("" when none). The extension prefers that session's agent baselines for hunks."""
    path = state_path("sessions.json")
    m = read_json(path, {}) or {}
    if not isinstance(m, dict):
        m = {}
    m[root] = {"sid": sid or "", "at": int(time.time())}
    if len(m) > 200:
        m = dict(sorted(m.items(), key=lambda kv: (kv[1] or {}).get("at") or 0)[-200:])
    write_json(path, m)


def status():
    ok = sys.platform == "darwin"
    return {"supported": ok, "native": native_app() if ok else ""}


# ---- Dispatch IDE: our own desktop app built from Code - OSS (design/two-modes). IDE mode opens it
# when it is there; ⌘E in it comes back to Dispatch's Agent mode.
NATIVE_APPS = ("/Applications/Dispatch IDE.app", "~/Applications/Dispatch IDE.app", "~/Projects/kanban/ide/VSCode-darwin-arm64/Dispatch IDE.app")


def native_app():
    """The Dispatch IDE bundle: $DISPATCH_IDE_APP, else the usual places; "" when none."""
    for c in [os.environ.get("DISPATCH_IDE_APP", "")] + list(NATIVE_APPS):
        c = os.path.expanduser(c)
        if c and os.path.isdir(os.path.join(c, "Contents", "MacOS")):
            return c
    return ""


def native_open(root, sid="", file="", line=0, frame=None):
    """Bring Dispatch IDE forward on this folder (a new window unless one has it open) and note the
    conversation, which the bridge extension shows and ⌘E goes back to. With `file` (relative to
    root) that file is opened too; the bridge moves to `line` (open-request). With `frame` (Dispatch's
    window, [x, y, w, h]) the IDE window takes the same place and size (5A.3)."""
    app = native_app()
    if not app:
        raise IdeError("not_installed", "Dispatch IDE.app was not found")
    root = os.path.abspath(os.path.expanduser(root))
    if not os.path.isdir(root):
        raise IdeError("no_root", "Folder does not exist: %s" % root)
    full = os.path.join(root, os.path.expanduser(file)) if file else ""
    note_session(root, sid)
    chat_request(root)
    r = subprocess.run(["open", "-a", app, root] + ([full] if full else []), capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise IdeError("open_failed", (r.stderr or r.stdout).strip() or "Could not open the app")
    if full and line:
        open_request(full, line)
    if frame:
        place_window(ide_process(app), frame, os.path.basename(root.rstrip(os.sep)) or root)
    return {"ok": True, "app": app, "root": root, "sid": sid, "file": full, "frame": frame or None}


# ---- window frames (5A.3): the two apps swap in the same place, at the same size ------------------
# A frame is [x, y, w, h] in points, origin at the top left of the main screen (what System Events
# and CGWindowList use; Dispatch converts its window's physical pixels before passing one in).
FRAME_MIN = 200

# Waits up to 5 s for the process's window whose title has the folder name (a new window takes a
# moment), then moves and sizes it. Needs Accessibility for the app that runs it (Dispatch).
_PLACE_SCRIPT = """on run argv
  set {pname, needle, x, y, w, h} to argv
  tell application "System Events"
    repeat 50 times
      if exists process pname then
        repeat with win in (windows of process pname)
          if name of win contains needle then
            set position of win to {x as integer, y as integer}
            set size of win to {w as integer, h as integer}
            return "ok"
          end if
        end repeat
      end if
      delay 0.1
    end repeat
  end tell
  return "no window"
end run"""


def parse_frame(s):
    """"x,y,w,h" → [x, y, w, h] (ints); IdeError when it is not four numbers or smaller than a window."""
    try:
        vals = [int(round(float(p))) for p in str(s or "").split(",")]
    except ValueError:
        vals = []
    if len(vals) != 4 or vals[2] < FRAME_MIN or vals[3] < FRAME_MIN:
        raise IdeError("usage", "--frame must be x,y,width,height in points, at least %d wide and tall: %s" % (FRAME_MIN, s))
    return vals


def ide_process(app):
    """The process name System Events and CGWindowList know Dispatch IDE by (the bundle's name)."""
    return os.path.splitext(os.path.basename(app.rstrip("/")))[0] if app else "Dispatch IDE"


def place_window(process, frame, needle):
    """Move the process's window with `needle` in its title to `frame`, in the background (it waits
    for the window to show up; `native-open` returns right away)."""
    if sys.platform != "darwin":
        return
    args = ["osascript", "-e", _PLACE_SCRIPT, process, needle] + [str(v) for v in frame]
    subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


# ---- the Agents window (design/copilot-app §8.5 B): Dispatch Agent is Dispatch IDE's own Agents
# window. `dispatch ide agents` opens it, on a folder or on a session; `back` (the editor's old ⌘E
# path, and what `dispatch --view desk --task …` meant) lands there too.

def window_provider(agent):
    """The agent host's provider id (CLAUDE_AGENT_PROVIDER_ID, CODEX_AGENT_PROVIDER_ID in
    src/vs/platform/agentHost/common/agent.ts, OPENCODE_AGENT_PROVIDER_ID in the opencode-harness patch) of an engine
    Dispatch runs, from any of its names; '' for any other."""
    import engines
    eng = engines.find(agent)
    return eng.provider if eng and eng.runnable else ""


def url_protocol(app):
    """The app's product.json urlProtocol (`dispatch-ide`)."""
    prod = read_json(os.path.join(app, "Contents", "Resources", "app", "product.json"), {}) or {}
    return prod.get("urlProtocol") or "dispatch-ide"


def session_link(key, protocol="dispatch-ide"):
    """The protocol URL that opens a session in the Agents window, in the shape
    buildExternalOpenSessionLinkUri makes (src/vs/platform/agentHost/common/openSessionLink.ts):
    `<protocol>://agents/agent-host-session/<provider>/<raw id>`. `key` is a Dispatch session key
    (`claude-code:<uuid>`, `codex:<thread id>`) or an agent-host session URI (`claude:/<uuid>`)."""
    from urllib.parse import quote
    agent, _, raw = (key or "").partition(":")
    raw = raw.lstrip("/")
    provider = window_provider(agent)
    if not provider or not raw:
        import engines
        keys = engines.join_words(("%s:<id>" % e.agent for e in engines.runnable() if e.provider), "or")
        raise IdeError("usage", "Use %s for the session: %s" % (keys, key))
    return "%s://agents/agent-host-session/%s/%s" % (protocol, provider, quote(raw, safe=""))


def ide_cli(app):
    """The app's own command line launcher (bin/code): it starts the app with these arguments, or
    hands them to the running one (`open -a … --args` drops them when the app already runs)."""
    return os.path.join(app, "Contents", "Resources", "app", "bin", "code")


def launch(app, args):
    """Run the app's launcher with `args`. $DISPATCH_IDE_USER_DATA_DIR and $DISPATCH_IDE_EXTENSIONS
    point it at another profile (a separate instance: tests, a scratch profile)."""
    extra = []
    if os.environ.get("DISPATCH_IDE_USER_DATA_DIR"):
        extra += ["--user-data-dir", os.environ["DISPATCH_IDE_USER_DATA_DIR"]]
    if os.environ.get("DISPATCH_IDE_EXTENSIONS"):
        extra += ["--extensions-dir", os.environ["DISPATCH_IDE_EXTENSIONS"]]
    # called from the extension host: its VSCODE_* / ELECTRON_* variables would make the launcher
    # talk to that window instead of the app
    env = dict((k, v) for k, v in os.environ.items() if not k.startswith(("VSCODE_", "ELECTRON_")))
    r = subprocess.run([ide_cli(app)] + extra + args, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60, env=env)
    if r.returncode != 0:
        raise IdeError("open_failed", (r.stderr or r.stdout).strip() or "Dispatch IDE could not be opened")


def agents(root="", session=""):
    """Bring the Agents window forward (open the app when needed). With `session` it shows that
    session (protocol URL). With `root`: ide/agents-request, which the bridge in an open editor
    window turns into openAgentsWindow(folder); the Agents window itself takes no folder from outside,
    so with no editor window open it just comes forward."""
    app = native_app()
    if not app:
        raise IdeError("not_installed", "Dispatch IDE.app was not found")
    root = os.path.abspath(os.path.expanduser(root)) if root else ""
    if root and not os.path.isdir(root):
        raise IdeError("no_root", "Folder does not exist: %s" % root)
    url = session_link(session, url_protocol(app)) if session else ""
    if root and not session:
        write_json(state_path("agents-request"), {"root": root, "at": time.time()})
    launch(app, ["--open-url", "--", url] if url else ["--agents"])
    return {"ok": True, "app": app, "root": root, "session": session, "url": url}


def back(root):
    """The editor → the Agents window, on the conversation the editor was opened for
    (sessions.json) when it is one of an engine Dispatch runs, else on the folder."""
    root = os.path.abspath(os.path.expanduser(root)) if root else ""
    sid = (((read_json(state_path("sessions.json"), {}) or {}).get(root) or {}).get("sid") or "") if root else ""
    agent, _, raw = sid.partition(":")
    if not window_provider(agent) or not raw:
        sid = ""
    r = agents(root if root and os.path.isdir(root) else "", sid)
    r["target"] = sid or root
    return r


# ---- extensions -------------------------------------------------------------------------------

def project_files(root):
    """Relative paths of the project's files: git's view (tracked + untracked not ignored) when it
    is a repository, otherwise a walk that skips build and dependency folders."""
    try:
        r = subprocess.run(["git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                           capture_output=True, timeout=20)
        if r.returncode == 0:
            return [x for x in r.stdout.decode("utf-8", "replace").split("\0") if x]
    except Exception:
        pass
    out = []
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in WALK_SKIP and not x.startswith(".")]
        for f in files:
            out.append(os.path.relpath(os.path.join(d, f), root))
            if len(out) >= WALK_LIMIT:
                return out
    return out


def recommend(root):
    root = os.path.abspath(os.path.expanduser(root or "."))
    counts = {}
    for f in project_files(root):
        ext = os.path.splitext(f)[1].lower()
        for lang, _, exts, _ in LANGS:
            if ext in exts:
                counts[lang] = counts.get(lang, 0) + 1
    have = installed_extensions()
    langs = []
    for lang, name, _, ids in LANGS:
        if counts.get(lang):
            langs.append({"lang": lang, "name": name, "files": counts[lang], "extensions": ids, "missing": [i for i in ids if i not in have]})
    langs.sort(key=lambda x: -x["files"])
    missing = [i for l in langs for i in l["missing"]]
    hints = []
    if counts.get("bash") and not P.which("shellcheck"):
        hints.append({"tool": "shellcheck", "hint": "brew install shellcheck"})
    return {"root": root, "languages": langs, "missing": missing, "hints": hints}


# ---- ⌘K edit ----------------------------------------------------------------------------------

def _strip_fence(text):
    t = text.strip("\n")
    m = re.match(r"^\s*```[\w.+-]*[ \t]*\n(.*?)\n?[ \t]*```\s*$", t, re.S)
    return m.group(1) if m else t


def _indent(line):
    return len(line) - len(line.lstrip(" \t"))


def fit_indent(text, selection):
    """Give the model's code back the selection's base indentation when it dropped it."""
    sel_lines = [l for l in selection.split("\n") if l.strip()]
    out_lines = text.split("\n")
    body = [l for l in out_lines if l.strip()]
    if not sel_lines or not body:
        return text
    want = min(_indent(l) for l in sel_lines)
    have = min(_indent(l) for l in body)
    if have < want:
        pad = sel_lines[0][:_indent(sel_lines[0])][:want - have] if _indent(sel_lines[0]) >= want - have else " " * (want - have)
        out_lines = [(pad + l) if l.strip() else l for l in out_lines]
    return "\n".join(out_lines)


def clean_edit(text, selection):
    t = fit_indent(_strip_fence(text or ""), selection)
    if selection.endswith("\n") and not t.endswith("\n"):
        t += "\n"
    elif not selection.endswith("\n"):
        t = t.rstrip("\n")
    return t


def _lines(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read().split("\n")


def edit(root, path, start, end, data, model=""):
    """data: {instruction, selection, before, after, context: [{path, start, end, text}]}. Missing
    selection / before / after are read from the file (lines start..end, 1-based, 80 around)."""
    root = os.path.abspath(os.path.expanduser(root or "."))
    instruction = (data.get("instruction") or "").strip()
    if not instruction:
        raise IdeError("usage", "Provide an edit instruction in stdin.instruction")
    full = path if not path or os.path.isabs(path) else os.path.join(root, path)
    if "selection" not in data:
        if not full or not os.path.isfile(full) or not start:
            raise IdeError("usage", "Provide selection, or --file with --start/--end")
        lines = _lines(full)
        s, e = max(1, start), max(start, end or start)
        data = dict(data, selection="\n".join(lines[s - 1:e]),
                    before=data.get("before", "\n".join(lines[max(0, s - 81):s - 1])), after=data.get("after", "\n".join(lines[e:e + 80])))
    selection = data.get("selection") or ""
    lines = selection.count("\n") + 1
    if lines > EDIT_MAX_LINES or len(selection) > EDIT_MAX_CHARS:
        raise IdeError("too_large", "Selected %d lines (%d characters). Inline edit supports at most %d lines and %d characters. Select less, or ask the agent in chat." % (lines, len(selection), EDIT_MAX_LINES, EDIT_MAX_CHARS))
    # room for the whole selection rewritten (about 3 characters a token) plus what the instruction adds
    max_tokens = min(EDIT_MAX_TOKENS, max(4000, len(selection) // 3 * 2 + 1000))
    rel = os.path.relpath(full, root) if full else ""
    parts = ["File: %s" % (rel or "(unsaved)")]
    if start:
        parts.append("Selected lines: %d-%d" % (start, end or start))
    for c in data.get("context") or []:
        if isinstance(c, dict) and c.get("text"):
            parts.append("<context path=\"%s\" lines=\"%s-%s\">\n%s\n</context>" % (c.get("path", ""), c.get("start", ""), c.get("end", ""), c["text"]))
    parts.append("<before>\n%s\n</before>" % (data.get("before") or ""))
    parts.append("<selection>\n%s\n</selection>" % selection)
    parts.append("<after>\n%s\n</after>" % (data.get("after") or ""))
    parts.append("Instruction: %s" % instruction)
    parts.append("Reply with the new code for <selection> only.")
    import summarize as S
    pick = (model or settings().get("ide_edit_model") or EDIT_DEFAULT_MODEL).strip()
    p = S.provider(pick)
    if not p:
        raise IdeError("no_model", "No model is available. Install Claude Code, or add an API key to dispatch env.")
    try:
        text = S.chat(p, EDIT_SYSTEM, "\n\n".join(parts), timeout=EDIT_TIMEOUT, max_tokens=max_tokens, use="ide_edit", whole=True)
    except S.Truncated as e:
        raise IdeError("truncated", "%s. No changes made. Select less and try again." % e)
    except subprocess.TimeoutExpired:
        raise IdeError("timeout", "The model did not respond within %d seconds" % EDIT_TIMEOUT)
    except Exception as e:
        raise IdeError("model_failed", str(e)[:300])
    tokens = ((S.usage_load().get("ide_edit") or {}).get("tokens")) or 0
    return {"ok": True, "text": clean_edit(text, selection), "model": "%s:%s" % (p["id"], p["model"]), "tokens": tokens}


# ---- Tab completion spend ---------------------------------------------------------------------

def tab_usd(prompt_tokens, cached_tokens, completion_tokens, model=TAB_DEFAULT_MODEL):
    """What a completion cost. Models without a price (Claude or Codex on the person's own
    subscription: claude:haiku, codex:…) cost nothing here."""
    pr = TAB_PRICES.get(model)
    if not pr:
        return 0.0
    miss = max(0, int(prompt_tokens or 0) - int(cached_tokens or 0))
    return (miss * pr["input_miss"][1] + int(cached_tokens or 0) * pr["input_hit"][1] + int(completion_tokens or 0) * pr["output"][1]) / 1e6


def _day(ts):
    ts = float(ts or time.time())
    if ts > 1e12:
        ts /= 1000.0
    return datetime.date.fromtimestamp(ts).isoformat()


def _norm_record(r, model):
    if not isinstance(r, dict):
        return None
    try:
        rec = {k: int(r.get(k) or 0) for k in ("prompt_tokens", "cached_tokens", "completion_tokens")}
        rec["usd"] = float(r["usd"]) if r.get("usd") is not None else tab_usd(rec["prompt_tokens"], rec["cached_tokens"], rec["completion_tokens"], model)
        rec["day"] = _day(r.get("ts"))
    except (TypeError, ValueError):
        return None
    return rec


def _fold(days, rec):
    d = days.setdefault(rec["day"], {"count": 0, "prompt_tokens": 0, "cached_tokens": 0, "completion_tokens": 0, "usd": 0.0})
    d["count"] += 1
    for k in ("prompt_tokens", "cached_tokens", "completion_tokens"):
        d[k] += rec[k]
    d["usd"] = round(d["usd"] + rec["usd"], 8)


def _pending(path, model):
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    rec = _norm_record(json.loads(line), model)
                except ValueError:
                    rec = None
                if rec:
                    out.append(rec)
    except OSError:
        pass
    return out


def usage_add(records=None):
    """Fold tab-usage.jsonl (written by the extension, one line per request) and `records` into
    the per-day ledger; the jsonl is renamed away first so appends during the fold are kept."""
    s = settings()
    model = s.get("ide_tab_model") or TAB_DEFAULT_MODEL
    ledger_path = state_path("tab-usage-days.json")
    jsonl = state_path("tab-usage.jsonl")
    with Lock("usage"):
        days = read_json(ledger_path, {}) or {}
        recs = []
        if os.path.exists(jsonl):
            draining = "%s.%d.draining" % (jsonl, os.getpid())
            os.replace(jsonl, draining)
            recs += _pending(draining, model)
            os.remove(draining)
        for r in records or []:
            rec = _norm_record(r, model)
            if rec:
                recs.append(rec)
        for rec in recs:
            _fold(days, rec)
        if recs:
            cutoff = (datetime.date.today() - datetime.timedelta(days=400)).isoformat()
            days = {k: v for k, v in days.items() if k >= cutoff}
            write_json(ledger_path, days)
            try:
                import summarize as S
                S.record_use("ide_tab", sum(r["prompt_tokens"] + r["completion_tokens"] for r in recs), "deepseek:" + model)
            except Exception:
                pass
    res = usage_today()
    res["added"] = len(recs)
    return res


def usage_today():
    s = settings()
    model = s.get("ide_tab_model") or TAB_DEFAULT_MODEL
    days = dict((k, dict(v)) for k, v in (read_json(state_path("tab-usage-days.json"), {}) or {}).items())
    for rec in _pending(state_path("tab-usage.jsonl"), model):
        _fold(days, rec)
    today = datetime.date.today().isoformat()
    t = days.get(today) or {"count": 0, "prompt_tokens": 0, "cached_tokens": 0, "completion_tokens": 0, "usd": 0.0}
    month = [v for k, v in days.items() if k[:7] == today[:7]]
    try:
        cap = float(s.get("ide_tab_daily_cap_usd", 0.5))
    except (TypeError, ValueError):
        cap = 0.5
    return {"date": today, "count": t["count"], "prompt_tokens": t["prompt_tokens"], "cached_tokens": t["cached_tokens"],
            "completion_tokens": t["completion_tokens"], "usd": round(t["usd"], 6), "cap_usd": cap,
            "over_cap": cap > 0 and t["usd"] >= cap, "enabled": bool(int(s.get("ide_tab_completion", 1) or 0)), "model": model,
            "month": {"count": sum(v["count"] for v in month), "usd": round(sum(v["usd"] for v in month), 6)},
            "prices": TAB_PRICES.get(model) or TAB_PRICES[TAB_DEFAULT_MODEL], "prices_as_of": TAB_PRICE_NOTE}


TAB_MODEL_LABELS = {"deepseek-flash": "DeepSeek V4.1 Flash"}
SUBSCRIPTION_HINT = "slower, uses your subscription quota"
COMPLETE_TIMEOUT = 40
COMPLETE_SYSTEM = ("You are a code completion engine. You get the file up to the cursor (<prefix>) and after it (<suffix>). "
                   "Reply with only the text to insert at the cursor: no explanation, no Markdown fences, nothing from the prefix or suffix repeated. "
                   "Keep it short: the rest of the line, or a few lines when a block obviously follows. Reply with nothing when no completion fits.")


def complete(data, model=""):
    """Tab completion on the person's subscription (Claude Code, Codex: the engines with subscription models), for when
    `ide_tab_model` is claude:… or codex:…; DeepSeek completions go straight from the bridge to DeepSeek's FIM API."""
    import engines
    import summarize as S
    pick = (model or settings().get("ide_tab_model") or "").strip()
    subs = [e.id for e in engines.runnable() if e.supports("answer_models")]
    if pick.split(":", 1)[0] not in subs or ":" not in pick:
        raise IdeError("usage", "complete supports %s; the extension requests DeepSeek completions directly"
                       % " and ".join(f"{i}:..." for i in subs))
    p = S.provider(pick)
    if not p or p["id"] not in subs:
        raise IdeError("no_model", "The %s CLI is not installed on this Mac" % pick.split(":", 1)[0])
    prefix, suffix = str(data.get("prefix") or ""), str(data.get("suffix") or "")
    user = "File: %s (%s)\n<prefix>\n%s</prefix>\n<suffix>\n%s</suffix>\n%s" % (
        data.get("path") or "", data.get("language") or "", prefix[-6000:], suffix[:2000],
        "Several lines are fine." if data.get("multiline") else "One line only.")
    try:
        text = S.chat(p, COMPLETE_SYSTEM, user, timeout=COMPLETE_TIMEOUT, max_tokens=256, use="ide_tab", grace=20)
    except subprocess.TimeoutExpired:
        raise IdeError("timeout", "The model did not respond within %d seconds" % COMPLETE_TIMEOUT)
    except Exception as e:
        raise IdeError("model_failed", str(e)[:300])
    text = re.sub(r"^```[\w-]*\n|\n?```\s*$", "", text or "")
    return {"ok": True, "text": text, "model": "%s:%s" % (p["id"], p["model"])}


def subscription_models():
    """The models of the engines that answer on the person's own subscription (their program must be on this Mac:
    Claude's four families, Codex's models): [{id: "claude:sonnet", label, hint}]."""
    import summarize as S
    return [{"id": f"{eng.id}:{m['id']}", "label": m["label"], "hint": SUBSCRIPTION_HINT}
            for eng in S.subscription_engines() for m in eng.answer_models("code")]


def edit_models(current="", env=None):
    """What ⌘K can run on (provider:model, as `ide_edit_model` takes it): Claude's four and Codex's
    models on the subscription, and DeepSeek with its key. The current value stays in the list
    even when it is none of these."""
    import dispatch as D
    if env is None:
        env = {i["name"]: i["value"] for i in D.env_read()}
    rows = subscription_models()
    if env.get("DEEPSEEK_API_KEY"):
        rows.append({"id": "deepseek:deepseek-chat", "label": "DeepSeek", "hint": ""})
    cur = (current or "").strip()
    if cur and not any(r["id"] == cur for r in rows):
        rows.append({"id": cur, "label": cur})
    return rows


def tab_models(current=""):
    """Tab completion: DeepSeek's FIM model first (the default, priced), then Claude and Codex on
    the subscription (slower, free here, through `dispatch ide complete`)."""
    rows = [{"id": m, "label": TAB_MODEL_LABELS.get(m, m), "hint": ""} for m in TAB_PRICES] + subscription_models()
    cur = (current or "").strip()
    if cur and not any(r["id"] == cur for r in rows):
        rows.append({"id": cur, "label": cur, "hint": ""})
    return rows


def tab_key(env=None):
    """DeepSeek's API key for Tab completion: Dispatch's own (`dispatch env` DEEPSEEK_API_KEY), else the one OpenCode
    already has for DeepSeek (signed in there, or Settings › Network's Chinese models: task-iyt73, where the editor
    said this Mac had no key while the Network page said DeepSeek Ready). Empty when neither has one."""
    import dispatch as D
    if env is None:
        env = {i["name"]: i["value"] for i in D.env_read()}
    if env.get("DEEPSEEK_API_KEY"):
        return env["DEEPSEEK_API_KEY"]
    try:
        import opencode_engine
        return opencode_engine._key(opencode_engine.DEEPSEEK, os.environ) or ""
    except Exception:  # noqa: BLE001
        return ""


def editor_settings():
    """The Editor page in the Agents window's Customizations: Tab completion (switch, model, day
    cap, today's spend from the ledger) and the ⌘K model, with the choices for both."""
    import dispatch as D
    s = settings()
    env = {i["name"]: i["value"] for i in D.env_read()}
    t = usage_today()
    return {"tab": {"enabled": t["enabled"], "model": t["model"], "cap_usd": t["cap_usd"], "today": {"count": t["count"], "usd": t["usd"]},
                    "month": t["month"], "has_key": bool(tab_key(env))},
            "tab_models": tab_models(s.get("ide_tab_model") or TAB_DEFAULT_MODEL),
            "edit_model": (s.get("ide_edit_model") or EDIT_DEFAULT_MODEL).strip(),
            "edit_models": edit_models(s.get("ide_edit_model") or EDIT_DEFAULT_MODEL, env)}


def signal(name, data=None):
    """One JSON object in ~/tasks/.dispatch/ide/signal (the bridge extension's signals)."""
    if not re.match(r"^[a-z][a-z0-9-]{0,40}$", name or ""):
        raise IdeError("usage", "Signal names may contain lowercase letters, digits and hyphens only")
    path = state_path("signal")
    prev = read_json(path, {}) or {}
    rec = {"name": name, "data": data, "at": time.time(), "seq": int(prev.get("seq") or 0) + 1}
    write_json(path, rec)
    return dict(rec, ok=True)


def chat_request(root):
    """Dispatch to the bridge extension: the editor window on `root` focuses its chat (VS Code's own chat
    view) on the folder's newest session (it watches chat-request, and reads it when it starts)."""
    fpath = state_path("chat-request")
    prev = read_json(fpath, {}) or {}
    rec = {"root": root, "at": time.time(), "seq": int(prev.get("seq") or 0) + 1}
    write_json(fpath, rec)
    return rec


def open_request(path, line=0):
    """Dispatch to the bridge extension: show this file at this line (it watches open-request)."""
    if not path:
        raise IdeError("usage", "Provide a file path")
    target = os.path.abspath(os.path.expanduser(path))
    fpath = state_path("open-request")
    prev = read_json(fpath, {}) or {}
    rec = {"path": target, "line": max(0, int(line or 0)), "at": time.time(), "seq": int(prev.get("seq") or 0) + 1}
    write_json(fpath, rec)
    return dict(rec, ok=True)


# ---- command line -----------------------------------------------------------------------------

def _print(obj, as_json, text):
    if as_json:
        print(json.dumps(obj, ensure_ascii=False), flush=True)
    else:
        print(text(obj) if callable(text) else text)


def _status_text(s):
    if not s.get("supported"):
        return _t("Dispatch IDE exists for macOS only", "Dispatch IDE 只有 macOS 版")
    return "Dispatch IDE" + _t(": %s", "：%s") % (s["native"] or _t("not installed", "没装"))


def parser():
    p = argparse.ArgumentParser(prog="dispatch ide", description="the back end of Dispatch IDE (the desktop app built from Code - OSS) and its dispatch-bridge extension: opening, the Agents window, ⌘K, Tab completion")
    sub = p.add_subparsers(dest="op", required=True)

    def add(name, help_):
        s = sub.add_parser(name, help=help_)
        s.add_argument("--json", action="store_true")
        return s

    add("status", "whether Dispatch IDE.app is on this Mac")
    s = add("recommend", "language extensions to recommend from the project's file types")
    s.add_argument("--root", default=".")
    s = add("edit", "⌘K: rewrite the selection as instructed, answering with code only (stdin: {instruction, selection, before, after, context})")
    s.add_argument("--root", default=".")
    s.add_argument("--file", default="")
    s.add_argument("--start", type=int, default=0)
    s.add_argument("--end", type=int, default=0)
    s.add_argument("--instruction", default="", help="the instruction when stdin is not used")
    s.add_argument("--model", default="", help="provider:model, default the ide_edit_model setting")
    s = add("usage", "Tab completion spending: add sums up tab-usage.jsonl (or records one), today shows today")
    s.add_argument("action", choices=["add", "today"])
    s.add_argument("--prompt-tokens", type=int)
    s.add_argument("--cached-tokens", type=int, default=0)
    s.add_argument("--completion-tokens", type=int, default=0)
    s.add_argument("--usd", type=float)
    s.add_argument("--ts", type=float)
    add("editor-settings", "the Agents window's Customizations → Editor: Tab completion and ⌘K settings, models to pick, today's spending")
    add("tab-key", "the DeepSeek key for Tab completion: the one in dispatch env, else the one OpenCode already has (the extension reads it; prints only the key)")
    s = add("complete", "Tab completion on a Claude / Codex subscription (when ide_tab_model is claude:… / codex:…; stdin: {prefix, suffix, language, path, multiline})")
    s.add_argument("--model", default="", help="default the ide_tab_model setting")
    s = add("signal", "the extension sends a signal (focus-chat, add-to-chat …)")
    s.add_argument("name")
    s.add_argument("--data", default="", help="JSON")
    s = add("native-open", "open this folder in Dispatch IDE (the desktop app built from Code - OSS) and note the conversation")
    s.add_argument("--root", required=True)
    s.add_argument("--sid", default="", help="the conversation's agent:id")
    s.add_argument("--file", default="", help="a file to open too (relative to --root)")
    s.add_argument("--line", type=int, default=0)
    s.add_argument("--frame", default="", help="x,y,width,height of the Dispatch window (points); the IDE window takes the same place and size")
    s = add("agents", "open Dispatch IDE's Agents window (Dispatch Agent), optionally at a folder or session")
    s.add_argument("--root", default="", help="select this folder")
    s.add_argument("--session", default="", help="open at this session: claude-code:<id> or codex:<id>")
    s = add("back", "go back from the editor to the Agents window with this folder's conversation selected")
    s.add_argument("--root", default="")
    s.add_argument("--frame", nargs="?", const="auto", default="", help=argparse.SUPPRESS)  # older bridges still pass it
    s = add("folder-session", "this folder's latest Agents window session (the editor window's chat opens it)")
    s.add_argument("--root", required=True)
    s = add("show", "open a deliverable in the side pane of Dispatch Agent (the Agents window): md and html in the Docs tab's reader, URLs in the built-in browser, pictures in the image preview; without the window it only prints the path")
    s.add_argument("target", help="a file path or http(s) URL")
    s.add_argument("--session", default="", help="switch to this session first (claude-code:<id>, codex:<id> or an Agents window session URI)")
    s.add_argument("--task", default="", help="the task this delivers: the reader's second line says \"Delivered … for <task>\"")
    # listed for --help only: main() hands these to ide_e2e before parsing
    sub.add_parser("instance", help="isolated test instances: start / list / stop (ide_e2e.py; dispatch ide instance -h)", add_help=False)
    sub.add_parser("e2e", help="end-to-end interface tests: run a scenario / annotate pictures / scenarios (ide_e2e.py)", add_help=False)
    s = add("archive-session", "move a session of the Agents window (Dispatch IDE / VS Code) to Archived; skipped when the editor is not open")
    s.add_argument("key", help="the session: claude:/<id>, claude-code:<id> or a session id")
    s.add_argument("--undo", action="store_true", help="unarchive")
    return p


def _stdin_json():
    raw = "" if sys.stdin is None or sys.stdin.isatty() else sys.stdin.read()
    try:
        return json.loads(raw) if raw.strip() else {}
    except ValueError:
        raise IdeError("usage", "stdin must be JSON")


def run(a):
    j = a.json
    if a.op == "status":
        return _print(status(), j, _status_text)
    if a.op == "recommend":
        return _print(recommend(a.root), j, lambda r: "\n".join(_t("%s (%d files): %s", "%s（%d 个文件）：%s") % (l["name"], l["files"], ", ".join(l["extensions"]) + (_t("; missing ", "；缺 ") + ", ".join(l["missing"]) if l["missing"] else _t("; all installed", "；都装了"))) for l in r["languages"]) or _t("No language found that needs an extension", "没认出要装扩展的语言"))
    if a.op == "edit":
        data = _stdin_json()
        if a.instruction:
            data["instruction"] = a.instruction
        return _print(edit(a.root, a.file, a.start, a.end, data, a.model), j, lambda r: r["text"])
    if a.op == "usage":
        if a.action == "add":
            recs = [{"prompt_tokens": a.prompt_tokens, "cached_tokens": a.cached_tokens, "completion_tokens": a.completion_tokens, "usd": a.usd, "ts": a.ts}] if a.prompt_tokens is not None else []
            res = usage_add(recs)
        else:
            res = usage_today()
        return _print(res, j, lambda r: _t("Tab completions today: %d, $%.4f (limit $%.2f)%s", "Tab 补全今天 %d 次，$%.4f（上限 $%.2f）%s") % (r["count"], r["usd"], r["cap_usd"], _t("; limit reached", "，已达上限") if r["over_cap"] else ""))
    if a.op == "complete":
        return _print(complete(_stdin_json(), a.model), j, lambda r: r["text"])
    if a.op == "tab-key":
        key = tab_key()
        return _print({"ok": True, "key": key}, j, key)
    if a.op == "editor-settings":
        return _print(editor_settings(), j, lambda r: _t("Tab completion %s, %s, limit $%.2f/day, today $%.4f; ⌘K %s", "Tab 补全 %s，%s，上限 $%.2f/天，今天 $%.4f；⌘K %s") % (_t("on", "开") if r["tab"]["enabled"] else _t("off", "关"), r["tab"]["model"], r["tab"]["cap_usd"], r["tab"]["today"]["usd"], r["edit_model"]))
    if a.op == "signal":
        try:
            data = json.loads(a.data) if a.data else None
        except ValueError:
            raise IdeError("usage", "--data must be JSON")
        return _print(signal(a.name, data), j, lambda r: _t("Sent %s", "已发 %s") % r["name"])
    if a.op == "native-open":
        frame = parse_frame(a.frame) if a.frame else None
        return _print(native_open(a.root, a.sid, a.file, a.line, frame), j, lambda r: _t("Opened %s in Dispatch IDE", "已在 Dispatch IDE 里打开 %s") % r["root"])
    if a.op == "agents":
        return _print(agents(a.root, a.session), j, lambda r: _t("Opened the Agents window", "已打开 Agents 窗口") + (_t(": %s", "：%s") % (r["session"] or r["root"]) if r["session"] or r["root"] else ""))
    if a.op == "back":
        return _print(back(a.root), j, lambda r: _t("Back in the Agents window", "已回到 Agents 窗口"))
    if a.op == "folder-session":
        import ide_sessions
        return _print({"ok": True, "session": ide_sessions.folder_session(a.root)}, j,
                      lambda r: "%s  %s" % (r["session"]["link"], r["session"]["title"]) if r["session"] else _t("This folder has no session yet", "这个目录还没有会话"))
    if a.op == "show":
        import ide_show
        try:
            r = ide_show.show(a.target, a.session, task=getattr(a, "task", "") or "")
        except ValueError as e:
            raise IdeError("usage", str(e))
        if not r["shown"] and not j:
            print(r["message"].replace(r["target"], "").strip(), file=sys.stderr)
        _print(r, j, lambda r: r["message"] if r["shown"] else r["target"])
        return 0
    if a.op == "archive-session":
        import ide_sessions
        r = ide_sessions.archive(a.key, archived=not a.undo)
        _print(r, j, lambda r: r["message"])
        return 0 if r.get("ok") else 1
    return 2


def main(argv=None):
    """Entry from `dispatch ide …` (dispatch.py hands over the arguments) and from `python3 ide.py …`."""
    if argv and argv[0] in ("instance", "e2e"):
        import ide_e2e
        return ide_e2e.main(argv)
    a = parser().parse_args(argv)
    try:
        return run(a) or 0
    except IdeError as e:
        if a.json:
            print(json.dumps({"ok": False, "error": e.code, "message": str(e)}, ensure_ascii=False), flush=True)
        else:
            print(str(e), file=sys.stderr)
        return 1
    except OSError as e:
        if a.json:
            print(json.dumps({"ok": False, "error": "io_error", "message": str(e)}, ensure_ascii=False), flush=True)
        else:
            print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    P.utf8_stdio()
    sys.exit(main(sys.argv[1:]))
