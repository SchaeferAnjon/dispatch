# -*- coding: utf-8 -*-
"""The first time someone opens Dispatch IDE: what `dispatch onboard <op> --json` answers to the setup wizard
(kanban design/onboarding/redesign, direction A: four screens, two on a Mac with nothing to bring over).

The wizard (Dispatch IDE patches/505-onboarding.patch) draws; everything it knows or does goes through
here, so the same steps can be rerun from Customizations > Migrations and tested without a window:

  status                what is here: agents (installed, signed in, how many earlier sessions), the
                        other agents left alone, VS Code, whether the session history has been read
  scan                  start reading the session history in the background (minutes the first time)
  folders               the folders agents worked in, newest first, each with why it is not ticked
  register              make the chosen folders projects (git init where there is no repository)
  prefs                 the preferences found in CLAUDE.md, AGENTS.md and the agents' own memory
  prefs-apply           import the chosen ones
  rules                 what connecting the agents will write, per agent
  apply-dir | apply-rules | apply-skills | apply-command    the pieces of "Set up Dispatch"
  vscode                what VS Code has that can come along (vscode_import.py); log-add records the import
  log | available       what was done (each with Undo) and what is still open, for Migrations
  undo <id>             take one thing back
  finish | skip | reset

Every change is written to onboarding.json with what it needs to be undone (what was there before, what
was made), so an Undo only touches what Dispatch itself did.
"""
import concurrent.futures
import fcntl
import datetime
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import tempfile

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DAYS = 30
BLOCK_BEGIN = "<!-- BEGIN DISPATCH GLOBAL RULES"
BLOCK_END = "<!-- END DISPATCH GLOBAL RULES -->"

STARTER_RULES = """# Global rules for every agent on this Mac
# Edit this file, then run `dispatch rules sync`. Dispatch's own rules (tasks, waiting, preferences) come with it,
# and so does Soul, how every agent talks and works (Settings › Soul).

## Working
- Once the goal is clear, carry it through to done. Decide small things yourself and say so in the report.
- Ask before anything that leaves this Mac: email, chat messages, pull requests, comments, deploys.
- Do the simplest thing that works first, check it, then build on it.
- Run it the way the user would before calling it done.

## Code and git
- Commit each finished piece of work as `<type>: <what changed>` and leave no tool signature in the message.
- Keep secrets out of the repository, the task board and notes: name them, do not write them.
"""

D = None
W = None
E = None
PV = None


def _mods():
    global D, W, E, PV
    if W is None:
        if HERE not in sys.path:
            sys.path.insert(0, HERE)
        import dispatch as d
        import engines as e
        import init_wizard as w
        import projects_view as pv
        D, W, E, PV = D or d, w, e, pv
        pv.D = D
    return D


def supported():
    """The ids of the engines Dispatch runs, the ones first-run setup connects (claude, codex, opencode)."""
    import engines
    return tuple(e.id for e in engines.runnable())


def now():
    return time.time()


def short(path):
    """~/…"""
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path == home or path.startswith(home + os.sep) else path


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return ""


def _sha(text):
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:16]


def _lines(text):
    return len([l for l in (text or "").splitlines() if l.strip()])


# ---------------------------------------------------------------- state: what was done, for Undo

def state_path():
    _mods()
    return os.path.join(D.DISPATCH_DIR, "onboarding.json")


def load():
    try:
        with open(state_path(), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def update_state(change):
    """Bridge calls can overlap (progress, draft and setup). Keep each edit atomic."""
    os.makedirs(os.path.dirname(state_path()), exist_ok=True)
    with open(state_path() + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        s = load()
        change(s)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(state_path()), prefix="onboarding-")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(s, f, ensure_ascii=False, indent=1)
        os.replace(tmp, state_path())
        return s


def save(**kw):
    return update_state(lambda s: s.update(kw))


def log_add(kind, title, detail, data=None, key=None):
    """One thing Dispatch did, with what an Undo needs. The same `key` again replaces the entry (a rerun)."""
    entry = {"id": "ob-" + _sha(f"{kind}{time.time_ns()}")[:8], "key": key or kind, "kind": kind, "title": title, "detail": detail,
             "at": int(now()), "undone": False, "data": data or {}}
    update_state(lambda s: s.setdefault("items", []).append(entry))
    return entry


def log_public():
    """The log without the undo data, newest last."""
    return [{**{k: e[k] for k in ("id", "key", "kind", "title", "detail", "at", "undone")}, "projects": e.get("data", {}).get("projects", [])} for e in load().get("items", [])]


# ---------------------------------------------------------------- is the wizard due?

def registered_dirs():
    _mods()
    try:
        return [r["dir"] for r in PV.registry(resolve_dirs=False) if r.get("dir")]
    except Exception:
        return []


def unconnected():
    """The agents Dispatch runs that are on this Mac and turned on but have no Dispatch block in their rules file: one
    installed after setup, or setup ran with none (task-vgll). The wizard's last page said to "run Set up again from
    the title bar", and the title bar had no Set up: now it shows Set up while this is not empty. Cheap (a `which`
    and a file read per agent), so the window asks again when it gets focus back."""
    _mods()
    import agents_catalog as AC
    off = AC.load_choice()["off"]
    agents = [{"id": e.id, "name": e.name} for e in E.runnable()
              if e.id not in off and E.which(e.bin) and BLOCK_BEGIN not in _read(_rules_path(e.id))]
    return {"state": load().get("state") or "pending", "agents": agents}


def needed():
    """The wizard opens by itself once: on a Mac whose Dispatch has no board with projects, until it is
    finished or skipped. An older install that already has projects never sees it."""
    _mods()
    if os.environ.get("DISPATCH_ONBOARDING", "").lower() in ("0", "off", "no"):
        return False  # test instances and scripted runs that must not meet the wizard
    st = load()
    if st.get("state") in ("done", "skipped"):
        return False
    if st.get("state") == "pending":
        return True  # A partial setup resumes even after its first projects were registered.
    if W.board_status().get("exists") and registered_dirs():
        return False
    return True


# ---------------------------------------------------------------- agents

def _run(argv, timeout=10, env=None):
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env, stdin=subprocess.DEVNULL)
        return r.returncode, r.stdout, r.stderr
    except Exception:
        return 1, "", ""


def account_of(eng_id, path):
    """One phrase for the first screen; never an email or a key."""
    _mods()
    return E.get(eng_id).sign_in_status(path, E._child_env())


def engine_rows(index_counts=None):
    _mods()
    home = os.path.expanduser("~")

    def one(eng):
        path = E.which(eng.bin)
        row = {"id": eng.id, "name": eng.name, "installed": bool(path), "path": path or "", "version": "", "account": "",
               "install": " ".join(E.install_command(eng)), "sessions": (index_counts or {}).get(eng.id)}
        if path:
            row["version"] = E.installed_version(path)
            row["account"] = account_of(eng.id, path)
        elif not row["install"]:
            # no way to install it on this Mac (Codex needs Node.js): the wizard says why instead of a bare "Not installed";
            # the row has no Install button then, so not "click Install again" as the failed install says
            row["install_why"] = (f"{eng.name} installs with Node.js, which this Mac does not have yet. "
                                  "Install Node.js from nodejs.org, and Install shows up here.")
        return row

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        rows = list(pool.map(one, E.runnable()))
    return rows


def agent_rows(index_counts=None):
    """Every agent CLI the catalog knows (agents_catalog.py), found or not, with the person's choice. The ones
    Dispatch runs carry their sign-in and earlier session count (engine_rows); the others are looked up at once."""
    _mods()
    import agents_catalog as AC
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        mine = pool.submit(engine_rows, index_counts)
        rest = pool.submit(AC.detect, None, {a["id"] for a in AC.CATALOG if not a.get("runnable")})
        rows = [dict(r, runnable=True, about=AC.BY_ID[r["id"]]["about"]) for r in mine.result()] + rest.result()
    return AC.with_choice(rows)


def other_agents(found=()):
    """The agents Dispatch does not run whose folder is on this Mac (ZCode, pi, Gemini CLI, Hermes: named on the first
    screen, never touched) and that were not found as a command (those are listed with the catalog's)."""
    import engines
    home = os.path.expanduser("~")
    return [e.name for e in engines.known() if not e.runnable and e.config_home and e.name not in found
            and os.path.isdir(e.home_dir(home, env={}))]


# ---------------------------------------------------------------- reading the session history

def transcript_count():
    """How many transcript files the first read has to go through (a cheap walk, for the progress bar)."""
    home = os.path.expanduser("~")
    n = 0
    for root in (os.path.join(home, ".claude", "projects"), os.environ.get("CODEX_HOME") and os.path.join(os.environ["CODEX_HOME"], "sessions") or os.path.join(home, ".codex", "sessions")):
        for _dir, _dirs, files in os.walk(root):
            n += sum(1 for f in files if f.endswith(".jsonl"))
    return n


def _alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:  # a zombie of ours is done
        r = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, timeout=3)
        return bool(r.stdout.strip()) and not r.stdout.strip().startswith("Z")
    except Exception:
        return True


def scan_start():
    """The session index is built in a process of its own: the first read of a big history takes minutes."""
    _mods()
    save(state="pending")
    cur = D.index_progress()
    if cur["state"] != "running" and (not cur["indexed"] or cur["state"] == "interrupted"):
        D.index_start_background()
    return scan_status()


def scan_status():
    """{state: idle | running | done, done, total}. `done` is what the index builder reports when it can
    (the progress file), else unknown (null): the bar then only moves when the whole read ends."""
    _mods()
    p = D.index_progress()
    state = p["state"]
    if state == "none":
        state = "done" if p["indexed"] else "idle"
    return {"state": state, "done": p.get("done"), "total": p.get("total")}


def _progress_file():
    """The index builder's own progress, when this Dispatch writes one (see refresh_index)."""
    _mods()
    fn = getattr(D, "index_progress", None)
    if callable(fn):
        try:
            return fn()
        except Exception:
            return None
    return None


def history_counts():
    """{engine id: interactive sessions} and the folders they ran in, from the index built so far."""
    _mods()
    idx = D.load_index()
    in_app = PV.interactive_sessions(idx)
    per = {k: 0 for k in supported()}
    by_agent = {E.get(k).agent: k for k in supported()}
    for e in idx.values():
        eng = by_agent.get(e.get("agent"))
        if eng and not PV.is_automation(e, in_app):
            per[eng] += 1
    return per


# ---------------------------------------------------------------- folders

RANGE_DAYS = 30


def codex_chat_folder(d):
    """The folder the Codex app makes for each one-off chat (~/Documents/Codex/<date>/<named after the
    chat: new-chat, new-chat-2, hi, …>): a chat, not a project."""
    return bool(re.search(r"/Codex/\d{4}-\d\d-\d\d/[^/]+/?$", d))


def folder_rows(now_ts=None):
    """The folders agents worked in (Dispatch's own agents only), newest first: [{dir, name, git, sessions,
    last_at, reason}]. `reason` says why a folder is not ticked by default: it holds other folders, it is a
    scratch folder, or it sits in iCloud Drive without git (adding it would put a synced .git there)."""
    _mods()
    now_ts = now_ts or now()
    idx = D.load_index()
    in_app = PV.interactive_sessions(idx)
    roots = D.settings_load().get("workspace_roots") or []
    registered = {os.path.normpath(d) for d in registered_dirs()}
    cache = {}
    rows = {}
    # An explicitly isolated first-run fixture lives in /tmp, where real projects are excluded.
    fixture = bool(os.environ.get("DISPATCH_E2E_INSTANCE") and os.environ.get("DISPATCH_ONBOARDING") == "1")
    ours = {E.get(k).agent for k in supported()}
    for path, e in idx.items():
        if e.get("agent") not in ours or PV.is_automation(e, in_app):
            continue
        cwd = (e.get("cwd") or "").rstrip("/")
        isolated = fixture and cwd.startswith(D.HOME.rstrip("/") + "/")
        if not cwd or (PV.is_temp(cwd) and not isolated) or cwd == D.HOME:
            continue
        if cwd not in cache:
            root = PV.git_main_root(cwd) if os.path.isdir(cwd) else ""
            cache[cwd] = root or cwd
        folder = cache[cwd]
        filter_folder = folder.replace(D.HOME, "/fixture-home", 1) if isolated else folder
        filter_home = "/fixture-home" if isolated else D.HOME
        if not os.path.isdir(folder) or PV.not_a_project(filter_folder, filter_home, roots) or os.path.normpath(folder) in registered:
            continue
        r = rows.get(folder)
        if r is None:
            r = rows[folder] = {"dir": folder, "name": os.path.basename(folder.rstrip("/")) or folder, "git": os.path.isdir(os.path.join(folder, ".git")),
                                "sessions": 0, "last_at": 0.0}
        r["sessions"] += 1
        r["last_at"] = max(r["last_at"], float(e.get("mtime") or 0))
    out = sorted(rows.values(), key=lambda r: -r["last_at"])
    dirs = [r["dir"] for r in out]
    icloud = os.path.join(D.HOME, "Library", "Mobile Documents")
    for r in out:
        kids = [os.path.basename(d) for d in dirs if d != r["dir"] and d.startswith(r["dir"].rstrip("/") + "/")]
        r["display"] = short(r["dir"])
        r["days"] = round(max(0.0, now_ts - r["last_at"]) / 86400, 1)
        r["icloud"] = r["dir"].startswith(icloud)
        if kids:
            r["reason"] = "Holds " + ", ".join(kids[:2]) + (f" and {len(kids) - 2} more" if len(kids) > 2 else "") + ". Add the folders inside."
        elif codex_chat_folder(r["dir"]):
            r["reason"] = "Scratch folder the Codex app makes for one-off chats."
        elif r["icloud"] and not r["git"]:
            r["reason"] = "iCloud folder with no git. Adding it puts a synced .git folder there."
        else:
            r["reason"] = ""
    names = {}
    for r in out:
        names[r["name"]] = names.get(r["name"], 0) + 1
    for r in out:  # two folders with one name: the parent tells them apart (and a registered name stays unique)
        if names[r["name"]] > 1:
            r["name"] = f"{r['name']} · {os.path.basename(os.path.dirname(r['dir']))}"
    return out


def register(items):
    """Make folders projects. items: [{dir, name?}]. Returns what was added, and what failed with a sentence."""
    _mods()
    added, failed, changed = [], [], []
    existing = {os.path.realpath(d) for d in registered_dirs()}
    for it in items:
        d = os.path.normpath(os.path.expanduser(it.get("dir") or ""))
        had_git = os.path.exists(os.path.join(d, ".git"))
        try:
            res = PV.register(d, it.get("name") or "")
            row = {"name": res["name"], "dir": d, "git_init": (not had_git) and bool(res.get("git"))}
            added.append(row)
            if os.path.realpath(d) not in existing:
                changed.append(row)
                existing.add(os.path.realpath(d))
        except Exception as e:  # noqa: BLE001
            failed.append({"dir": d, "message": str(e)[:200]})
    if changed:
        n = len(changed)
        log_add("projects", "Projects", f"{n} project{'s' if n != 1 else ''} from the folders your agents worked in", {"projects": changed}, key="projects")
    return {"added": added, "failed": failed}


def _unregister(name):
    _mods()
    flags = D.project_flags_load(strict=True)
    if name in flags:
        flags = {k: v for k, v in flags.items() if k != name}
        D.wiki_store(D.PROJECT_FLAGS_KEY, json.dumps(flags, ensure_ascii=False, sort_keys=True))
        D.project_dirs(reload=True)


# ---------------------------------------------------------------- preferences

PREF_SOURCES = ("memory", "codex", "claude_md", "agents_md")
PLAN_FILE = "onboarding-prefs-plan.json"


def _source_label(item):
    src = (item.get("sources") or [{}])[0]
    label = (src.get("label") or "").split(" · ")[0]
    return {"Claude Code memory": "Claude memory"}.get(label, label)


def prefs_plan(sources=PREF_SOURCES):
    """What could be brought over as preferences: the clear ones ticked, the unsure ones apart."""
    _mods()
    import prefs
    prefs.D = D
    plan = prefs.plan_import(sources=sources, cwd=D.HOME)
    items = [it for it in plan["items"] if not it.get("already")]
    groups = {a: {"id": a, "name": prefs.AREA_LABEL[a], "n": 0, "like": 0, "avoid": 0, "items": []} for a in prefs.AREAS}
    look = []
    for it in items:
        row = {"n": it["n"], "polarity": it["polarity"], "area": it["area"], "text": it["text"], "name": it["name"], "source": _source_label(it)}
        if it.get("sure", True):
            g = groups[it["area"]]
            g["n"] += 1
            g[it["polarity"]] += 1
            g["items"].append(row)
        else:
            row["why"] = it.get("why") or ""
            look.append(row)
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    with open(os.path.join(D.DISPATCH_DIR, PLAN_FILE), "w", encoding="utf-8") as f:
        json.dump(plan, f, ensure_ascii=False)
    clear = sum(g["n"] for g in groups.values())
    return {"total": len(items), "clear": clear, "look": len(look), "left": len(plan.get("skipped") or []), "already": len(plan["items"]) - len(items),
            "groups": [g for g in groups.values() if g["n"]], "look_items": look,
            "sources": ", ".join(plan["sources"].values()) if isinstance(plan.get("sources"), dict) else ""}


def prefs_apply(picks):
    """Import the plan's numbers (`picks`: "1,2,5-9"). What was written is remembered for Undo."""
    _mods()
    import prefs
    prefs.D = D
    try:
        with open(os.path.join(D.DISPATCH_DIR, PLAN_FILE), encoding="utf-8") as f:
            plan = json.load(f)
    except (OSError, ValueError):
        return {"ok": False, "message": "The list of preferences is gone: open this step again."}
    if not (picks or "").strip():
        return {"ok": True, "imported": 0}
    res = prefs.apply_import(plan, picks=picks)
    ids = [e["id"] for e in res["imported"]]
    if ids:
        log_add("prefs", "Preferences", f"{len(ids)} preference{'s' if len(ids) != 1 else ''} from your rules files and the agents' memory", {"ids": ids, "pref_record_at": res.get("record", {}).get("at")}, key="prefs")
    return {"ok": True, "imported": len(ids), "merged": len(res["merged"])}


# ---------------------------------------------------------------- rules, hooks, skills, the command

def _engine_home(agent):
    _mods()
    return D.RULE_TARGETS[agent]["home"]


def _rules_path(agent):
    _mods()
    return D.RULE_TARGETS[agent]["path"]


def snapshot(path):
    if os.path.islink(path):
        return {"type": "link", "target": os.readlink(path), "text": _read(path)}
    return {"type": "file", "text": _read(path)} if os.path.exists(path) else {"type": "absent"}


def restore_changes(changes):
    """Restore only files still matching what setup wrote. Later edits are never overwritten."""
    kept = []
    for path, pair in changes.items():
        if snapshot(path) != pair["after"]:
            kept.append(short(path))
            continue
        before = pair["before"]
        if before["type"] == "link" and pair["after"]["type"] == "link" and before["target"] == pair["after"]["target"]:
            with open(path, "w", encoding="utf-8") as f:
                f.write(before["text"])
            continue
        if os.path.islink(path):
            os.unlink(path)
        if before["type"] == "absent":
            if os.path.isfile(path):
                os.remove(path)
        elif before["type"] == "link":
            if os.path.isfile(path):
                os.remove(path)
            os.symlink(before["target"], path)
        else:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(before["text"])
    return kept


def changed_files(before):
    return {p: {"before": b, "after": snapshot(p)} for p, b in before.items() if b != snapshot(p)}


def _own_lines(path):
    text = _read(path)
    while BLOCK_BEGIN in text:
        i = text.find(BLOCK_BEGIN)
        j = text.find(BLOCK_END, i)
        text = text[:i] + (text[j + len(BLOCK_END):] if j >= 0 else "")
    return _lines(text)


def shipped_rules_path():
    import dispatch_dir
    return dispatch_dir.SHIPPED_RULES


def rules_plan(engs=None):
    """What "Set up" will write, for the last screen."""
    _mods()
    engs = engs if engs is not None else engine_rows()
    installed = {e["id"] for e in engs if e["installed"]}
    import soul
    text = _read(D.RULES_FILE) or STARTER_RULES
    agents = []
    for a in supported():
        if a not in installed:
            continue
        dfile, dtext = D.dispatch_rules()
        sfile, stext = D.soul_rules()
        block = D.render_block(a, text, D.rules_hash(text, dtext, stext), dtext, dfile, stext, sfile)
        name = next((e["name"] for e in engs if e["id"] == a), a)
        agents.append({"id": a, "name": name, "path": short(_rules_path(a)), "own_lines": _own_lines(_rules_path(a)),
                       "block_lines": len(block.splitlines()), "hooks": E.get(a).hooks_text,
                       "hooks_note": E.get(a).hooks_note})
    return {"agents": agents,
            "files": [{"id": "dispatch.md", "lines": _lines(_read(shipped_rules_path())),
                       "note": "Built in, updated with Dispatch" if os.path.isfile(shipped_rules_path()) else "Missing from this copy of Dispatch: install it again"},
                      {"id": "SOUL.md", "lines": _lines(_read(soul.path()) or soul.default_text()),
                       "note": ("Yours, already here" if os.path.exists(soul.path()) else "How every agent talks and works, yours to change in Settings")
                       if soul.default_text() else "Missing from this copy of Dispatch: install it again"},
                      {"id": "GLOBAL.md", "lines": _lines(_read(D.RULES_FILE)) or _lines(STARTER_RULES), "note": "Short starter, yours to edit" if not os.path.exists(D.RULES_FILE) else "Yours, already here"},
                      {"id": "dispatch", "lines": 0, "note": "command in ~/.local/bin, so agents can run it in a terminal"}],
            "left_alone": other_agents()}


def apply_dir():
    """~/.dispatch and the shipped rules, then GLOBAL.md from the starter when there is none."""
    _mods()
    ensure_board()
    W.dispatch_dir_setup()
    created = False
    if not os.path.exists(D.RULES_FILE):
        os.makedirs(os.path.dirname(D.RULES_FILE), exist_ok=True)
        with open(D.RULES_FILE, "w", encoding="utf-8") as f:
            f.write(STARTER_RULES)
        created = True
    import dispatch_dir
    shipped = os.path.isfile(dispatch_dir.path("rules", "dispatch.md"))
    if created:
        # say what is really there: a copy of Dispatch without its dispatch.md once claimed it here (task-nb3v)
        log_add("rules", "Rules", ("dispatch.md (built in) and a short GLOBAL.md starter" if shipped else "A short GLOBAL.md starter") + " in ~/.dispatch/rules",
                {"global_created": created, "global_sha": _sha(_read(D.RULES_FILE))}, key="rules")
    return {"created_global": created, "dispatch_md": shipped}


def _sync_rules(agents):
    """`dispatch rules sync` (rules_sync's owner decides what a block holds), narrowed to the chosen agents."""
    _mods()
    import io
    import argparse
    saved = D.rule_sync_agents
    D.rule_sync_agents = lambda: list(agents)
    buf = io.StringIO()
    old = sys.stdout
    try:
        sys.stdout = buf
        a = argparse.Namespace(op="sync", force=True, json=True, path="", profile="auto", model="", backup="", project="", host="", file="", refresh=False, due=False)
        try:
            D.cmd_rules(a)
        except SystemExit as e:
            raise RuntimeError("Could not synchronize the rules") from e
    finally:
        sys.stdout = old
        D.rule_sync_agents = saved
    try:
        return json.loads(buf.getvalue()[buf.getvalue().find("{"):])
    except ValueError as e:
        raise RuntimeError("Could not read the rules sync result") from e


def _mcp_files(agent):
    """The files Dispatch's MCP server is added to for this agent: its MCP file, and Claude Code's settings (the allow list)."""
    import dispatch_mcp
    import mcp_config
    # setup names Claude Code "claude", the MCP side "claude-code": Claude Code's row in What Dispatch changed never
    # said it got Dispatch's tools (task-lj06.23)
    agent = E.get(agent).agent
    if agent not in {e.agent for e in dispatch_mcp.engines()}:
        return []
    return [f for f in (mcp_config.paths()[agent], E.get(agent).mcp_allow_file(mcp_config.instance_home() or mcp_config.home())) if f]


def apply_rules(agents):
    """One managed block per chosen agent, and its hooks. Returns what each did."""
    _mods()
    agents = [a for a in agents if a in supported()]
    before = {}
    for a in agents:
        p = _rules_path(a)
        hooks = E.get(a).hooks_file(D.HOME)
        mcp = _mcp_files(a)  # Dispatch's MCP server goes in there too (agents_setup)
        before[a] = {"existed": os.path.exists(p), "own_lines": _own_lines(p), "files": {path: snapshot(path) for path in (p, hooks, *mcp) if path}}
    if not os.path.exists(D.RULES_FILE):
        apply_dir()
    _sync_rules(agents)
    hooks = W.agents_setup([E.get(a).agent for a in agents])["installed"]
    out = []
    for a in agents:
        p = _rules_path(a)
        name = E.get(a).name
        detail = f"One block in {short(p)}" + (f", after your {before[a]['own_lines']} lines" if before[a]["own_lines"] else "") + f". Hooks: {E.get(a).hooks_text}." + (" Dispatch's tools: the dispatch MCP server." if _mcp_files(a) else "")
        trust = (hooks.get(E.get(a).agent) or {}).get("trust") or {}
        if trust and not trust.get("ok"):
            # not a failure of setup: the Agents window asks again at each start (`dispatch hooks sync`)
            detail += f" {name} has not trusted Dispatch's hook yet ({trust.get('why') or 'no answer'}); Dispatch asks it again each time the Agents window starts."
        changes = changed_files(before[a]["files"])
        if changes:
            log_add("agent", name, detail, {"agent": a, "path": p, "changes": changes}, key="agent:" + a)
        out.append({"agent": a, "path": p, "block": BLOCK_BEGIN in _read(p)})
    errors = [str(v.get("error") or v.get("skipped")) for v in hooks.values() if v.get("error") or v.get("skipped")]
    return {"ok": not errors, "agents": out, "message": "; ".join(errors)}


def apply_skills(agents):
    _mods()
    mounted = []
    # Links to the copy that ships with Dispatch, so they update with it (not copies).
    W.link_builtin_skills(D.POOL)
    for name in W.BUILTIN_SKILLS:
        for agent in agents:
            paths = D.AGENT_SKILL_DIRS.get(agent, [])
            if any(os.path.lexists(os.path.join(p, name)) for p in paths):
                continue
            code, out, err = _run([sys.executable, W.bundled_cli(), "skills", "enable", name, "--agent", agent], 60, os.environ.copy())
            why = ((err or out or "").strip().splitlines() or [""])[-1].strip()[:200]
            mounted.append({"skill": name, "agent": agent, "ok": code == 0, **({} if code == 0 else {"error": why or f"exited with {code}"})})
    # the helper agents that come with Dispatch: copies for each engine, a file of the same name stays (builtin_agents.py)
    agents_error = ""
    try:
        import builtin_agents
        builtin_agents.log_install(builtin_agents.sync())
    except Exception as e:  # noqa: BLE001
        agents_error = f"Could not add the helper agents: {e}"
    ok = [m for m in mounted if m["ok"]]
    if ok:
        log_add("skills", "Skills", ", ".join(W.BUILTIN_SKILLS[:-1]) + " and " + W.BUILTIN_SKILLS[-1] + ", mounted for " + ", ".join(sorted({m["agent"] for m in ok})), {"mounts": ok}, key="skills")
    # which skill, for which agent, and why: the wizard shows this under the step (task-4xxj)
    names = {e.id: e.name for e in E.runnable()}
    groups = {}
    for m in mounted:
        if not m["ok"]:
            groups.setdefault((m["agent"], m["error"]), []).append(m["skill"])
    and_list = lambda xs: xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1]  # noqa: E731
    bad = [f"{and_list(skills)} for {names.get(agent, agent)}: {why}" for (agent, why), skills in groups.items()]
    message = "; ".join(x for x in (("Could not add " + "; ".join(bad)) if bad else "", agents_error) if x)
    return {"ok": not bad and not agents_error, "mounted": mounted, "message": message}


def apply_command():
    """`dispatch` on the PATH of a new terminal."""
    _mods()
    link = os.path.join(D.HOME, ".local", "bin", "dispatch")
    paths = [link] + [os.path.join(D.HOME, f) for f in (".zprofile", ".zshrc", ".bash_profile", ".bashrc", ".profile")]
    before = {p: snapshot(p) for p in paths}
    res = W.cli_link()
    # chatd, the resident service: in-app chats keep running, wake notices arrive and the phone connects
    # through it (mobile.py lives in its process); a new Mac has nothing else that installs it
    service = ""
    # Never from a test instance or a temporary HOME: the job would land in the person's real launchd
    # domain, outlive the instance and make macOS ask for a keychain that is not there (2026-10-01).
    real_home = os.path.realpath(__import__("pwd").getpwuid(os.getuid()).pw_dir)
    if sys.platform == "darwin" and not os.environ.get("DISPATCH_E2E_INSTANCE") and os.path.realpath(D.HOME) == real_home:
        try:
            import chatd_service
            if not chatd_service.launchd.installed(chatd_service.LABEL):
                chatd_service.install()
                service = chatd_service.LABEL
        except Exception:  # the terminal command still counts; `dispatch chatd install` can do it later
            service = ""
    changes = changed_files(before)
    if changes or service:
        log_add("command", "Terminal command", "dispatch in ~/.local/bin, available in a new terminal."
                + (" Dispatch's background service runs." if service else ""), {"changes": changes, "service": service}, key="command")
    return {"ok": bool(res.get("verified")), "link": link, "verified": res.get("verified"), "service": service,
            "message": "Open a new terminal to use dispatch."}


# ---------------------------------------------------------------- undo

def _remove_block(path, created):
    text = _read(path)
    if BLOCK_BEGIN not in text:
        return False
    while BLOCK_BEGIN in text:
        i = text.find(BLOCK_BEGIN)
        j = text.find(BLOCK_END, i)
        end = j + len(BLOCK_END) if j >= 0 else len(text)
        if text[end:end + 1] == "\n":
            end += 1
        text = text[:i].rstrip("\n") + ("\n" if text[:i].strip() else "") + text[end:].lstrip("\n")
    if created and not text.strip():
        os.remove(path)
    else:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    return True


def undo(entry_id, also_git=False):
    """Take one logged thing back. Returns {ok, message}."""
    _mods()
    s = load()
    entry = next((e for e in s.get("items", []) if e["id"] == entry_id), None)
    if not entry or entry.get("undone"):
        return {"ok": False, "message": "That one is already undone."}
    kind, data = entry["kind"], entry.get("data") or {}
    note = ""
    if data.get("changes"):
        kept = restore_changes(data["changes"])
        note = "Setup changes restored." + (" Kept later edits in " + ", ".join(kept) + "." if kept else "")
    elif kind == "projects":
        removed = 0
        for p in data.get("projects", []):
            current = D.project_flags_load(strict=True).get(p["name"], {})
            if not PV.same_folder(current.get("dir"), p["dir"]):
                continue
            _unregister(p["name"])
            removed += 1
            if also_git and p.get("git_init"):
                gd = os.path.join(p["dir"], ".git")
                refs = subprocess.run(["git", "-C", p["dir"], "rev-list", "-n", "1", "--all"], capture_output=True, text=True)
                tracked = subprocess.run(["git", "-C", p["dir"], "ls-files"], capture_output=True, text=True)
                empty = refs.returncode == 0 and tracked.returncode == 0 and not refs.stdout.strip() and not tracked.stdout.strip()
                if empty and os.path.isdir(gd):
                    shutil.rmtree(gd, ignore_errors=True)
        note = f"{removed} projects removed. Your folders are untouched."
    elif kind == "prefs":
        import prefs
        prefs.D = D
        prefs.forget([i for i in data.get("ids", [])])
        note = "Those preferences are forgotten."
    elif kind == "rules":
        if data.get("global_created") and _sha(_read(D.RULES_FILE)) == data.get("global_sha") and os.path.isfile(D.RULES_FILE):
            os.remove(D.RULES_FILE)
            note = "GLOBAL.md removed (it was still the starter)."
        else:
            note = "GLOBAL.md stays: you changed it."
    elif kind == "agent":
        a = data.get("agent")
        _remove_block(data.get("path") or _rules_path(a), not data.get("file_existed", True))
        E.get(a).uninstall_hooks()
        note = f"The block and the hooks are gone from {short(data.get('path') or '')}."
    elif kind == "skills":
        for m in data.get("mounts", []):
            _run([sys.executable, W.bundled_cli(), "skills", "disable", m["skill"], "--agent", m["agent"]], 60, os.environ.copy())
        note = "The skills are unmounted."
    elif kind == "helper-agents":
        import builtin_agents
        for name in data.get("names", []):
            try:
                builtin_agents.turn(name, False)
            except SystemExit:
                pass
        note = "The helper agents are off. Turn one back on in Settings, Sub-agents."
    elif kind == "command":
        if data.get("service") and sys.platform == "darwin":
            try:
                import chatd_service
                chatd_service.uninstall()
            except Exception:
                pass
        link = data.get("link") or ""
        if link and not data.get("existed") and os.path.islink(link) and os.path.realpath(link) == os.path.realpath(W.bundled_cli()):
            os.remove(link)
        for rc in data.get("path_files", []):
            text = _read(rc)
            new = "\n".join(l for l in text.split("\n") if "# dispatch" not in l)
            if new != text and os.path.isfile(rc):
                with open(rc, "w", encoding="utf-8") as f:
                    f.write(new)
        note = "The dispatch command is removed."
    elif kind == "vscode":
        import vscode_import
        vscode_import.undo(data)
        note = "Your Dispatch IDE settings are back as they were." + (" The extensions come out with the window." if data.get("extensions") else "")
    else:
        return {"ok": False, "message": "Nothing to undo for this one."}
    for e in s["items"]:
        if e["id"] == entry_id:
            e["undone"] = True
            e["undone_at"] = int(now())
    save(items=s["items"])
    return {"ok": True, "message": note}


# ---------------------------------------------------------------- VS Code

def vscode_apply(plan):
    """Copy the ticked settings, shortcuts and snippets into Dispatch IDE's User folder (the extensions are the
    window's to install: vscode_extensions records which ones went in)."""
    import vscode_import
    res = vscode_import.apply(plan)
    if not res.get("ok"):
        return res
    n = len(res["settings"])
    bits = ([f"{n} setting{'s' if n != 1 else ''}"] if n else []) + (["your keyboard shortcuts"] if res.get("keybindings") else []) + ([f"{len(res['snippets'])} snippet file{'s' if len(res['snippets']) != 1 else ''}"] if res.get("snippets") else [])
    if n or res.get("files"):
        log_add("vscode", "VS Code", "Copied " + ", ".join(bits) + " from VS Code.", {k: res[k] for k in ("target", "settings", "keybindings", "snippets", "files")}, key="vscode")
    return {"ok": True, "settings": n}


def vscode_extensions(ids):
    """Which extensions the window installed for the VS Code import (an Undo uninstalls them)."""
    s = load()
    items = s.get("items", [])
    e = next((x for x in reversed(items) if x.get("key") == "vscode" and not x.get("undone")), None)
    if e is None:
        e = log_add("vscode", "VS Code", "Installed extensions from VS Code.", {"settings": {}, "keybindings": False, "snippets": []}, key="vscode")
        s = load()
        items = s["items"]
        e = next(x for x in items if x["id"] == e["id"])
    e["data"]["extensions"] = sorted(set(e["data"].get("extensions", [])) | set(ids))
    if ids:
        e["detail"] = (e["detail"].rstrip(".") + f"; {len(ids)} extension{'s' if len(ids) != 1 else ''} installed.") if "extension" not in e["detail"] else e["detail"]
    save(items=items)
    return {"ok": True, "extensions": len(ids)}


def log_entry(entry_id):
    e = next((x for x in load().get("items", []) if x["id"] == entry_id), None)
    return {"ok": bool(e), "entry": e}


# ---------------------------------------------------------------- what is still open (Migrations)

def available(days=DEFAULT_DAYS):
    _mods()
    st = load()
    done_keys = {e["key"] for e in st.get("items", []) if not e.get("undone")}
    rows = []
    if st.get("state") != "done":
        rows.append({"id": "setup", "title": "Finish setting up Dispatch", "detail": "Continue with your saved choices.", "step": st.get("step", "agents")})
    if not ({"agent:" + a for a in supported()} & done_keys):
        rows.append({"id": "connect", "title": "Connect Dispatch to your agents", "detail": "Adds a rules block and a few hooks to Claude Code, Codex and OpenCode.", "step": "rules"})
    try:
        folders = folder_rows()
    except Exception:  # noqa: BLE001
        folders = []
    inr = [f for f in folders if f["days"] <= days]
    old = [f for f in folders if f["days"] > days]
    if inr:
        rows.append({"id": "projects", "title": "Projects", "detail": f"{len(inr)} folder{'s' if len(inr) != 1 else ''} your agents worked in during the last {days} days.", "step": "projects"})
    if old:
        rows.append({"id": "projects-older", "title": f"Folders older than {days} days", "detail": f"{len(old)} folder{'s' if len(old) != 1 else ''}, {sum(f['sessions'] for f in old)} sessions. Add any of them as projects.", "step": "projects"})
    if "prefs" not in done_keys:
        try:
            p = prefs_plan()
            if p["clear"]:
                rows.append({"id": "prefs", "title": "Preferences", "detail": f"{p['clear']} clear ones and {p['look']} to look at, found in your rules files and the agents' memory.", "step": "prefs"})
        except Exception:  # noqa: BLE001
            pass
    if "vscode" not in done_keys:
        import vscode_import
        s = vscode_import.summary(vscode_import.scan(check_online=False))
        if s:
            rows.append({"id": "vscode", "title": "VS Code", "detail": f"{s['settings']} settings and {s['extensions_total']} extensions found.", "step": "agents"})
    return rows


# ---------------------------------------------------------------- the first screen

def status():
    _mods()
    st = load()
    scan = scan_status()
    counts = history_counts() if scan["state"] == "done" or os.path.exists(D.INDEX_FILE) else None
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        net_job = pool.submit(network_snapshot)  # asks Anthropic's and OpenAI's servers (a few seconds when they do not answer)
        agents = agent_rows(counts)
        network = net_job.result()
    engs = [{k: v for k, v in r.items() if k not in ("runnable", "enabled")} for r in agents if r["runnable"]]
    import vscode_import
    vs = vscode_import.summary(vscode_import.scan(check_online=False))
    fresh = None
    if counts is not None and scan["state"] != "running":
        fresh = sum(counts.values()) == 0
    if counts is None and transcript_count() == 0 and not any(os.path.exists(s["db"]) for s in D.SQLITE_STORES.values()):
        fresh = True
    return {"needed": needed(), "state": st.get("state") or "pending", "step": st.get("step") or "agents", "draft": st.get("draft", {}),
            "board": {"exists": bool(W.board_status().get("exists"))}, "engines": engs, "agents": agents, "others": other_agents({r["name"] for r in agents if r["installed"]}),
            "index": scan, "history": {"sessions": sum(counts.values()) if counts else None}, "fresh": fresh, "vscode": vs,
            "autonomy": autonomy_snapshot(), "network": network, "git_identity": git_identity_snapshot(),
            "steps": ["agents", "projects", "prefs", "autonomy", "appearance", "notifications", "rules"] if fresh is not True
            else ["agents", "autonomy", "appearance", "notifications", "rules"]}


def network_snapshot():
    """Can Claude Code and Codex reach their servers from here, and the Chinese models OpenCode offers (net.py). The
    wizard recommends OpenCode when they cannot. None when the check itself failed."""
    try:
        import net
        s = net.status()
        return {k: s[k] for k in ("blocked", "recommend", "china_models", "proxy", "checked_at")}
    except Exception:  # noqa: BLE001 - the wizard works without it
        return None


def git_identity_snapshot():
    """The name and email on commits: what git has, and what to offer when it has nothing (git_identity.py, task-pog4t).
    The wizard asks once instead of letting the first agent that commits make one up."""
    try:
        import git_identity
        return git_identity.show()
    except Exception:  # noqa: BLE001 - the wizard works without it
        return None


def autonomy_snapshot():
    """The three answers to "how much may agents do on their own" and the saved one (autonomy.py)."""
    import autonomy
    return autonomy.snapshot()


def ensure_board():
    """A board, quietly (the first screen's last line: "It also sets up its task board here")."""
    _mods()
    fn = getattr(W, "ensure_board", None)
    return fn() if callable(fn) else {"created": False}


def finish(skipped=False):
    _mods()
    save(state="skipped" if skipped else "done", finished_at=int(now()))
    if skipped:
        W.save_state(skipped=True)
        # setup was skipped, the task board is still needed: without it every task tool of an agent fails and the
        # side pane shows bd's own error ("no beads database found")
        return {"state": "skipped", "board": ensure_board()}
    W.finish(skipped=False)
    return {"state": "done"}


def reset():
    _mods()
    save(state="pending", step="agents", draft={}, finished_at=None)
    W.reset()
    return {"state": "pending"}


# ---------------------------------------------------------------- the command

def _print(obj, as_json=True):
    print(json.dumps(obj, ensure_ascii=False))


def command(a, dispatch_module=None):
    global D
    if dispatch_module is not None:
        D = dispatch_module
    op = a.op
    args = list(a.args or [])
    payload = {}
    if not sys.stdin.isatty() and op in ("register", "log-add", "vscode-apply", "vscode-extensions", "draft"):
        try:
            payload = json.loads(sys.stdin.read() or "{}")
        except ValueError:
            payload = {}
    try:
        if op == "status":
            res = status()
        elif op == "unconnected":
            res = unconnected()
        elif op == "scan":
            res = scan_start()
        elif op == "draft":
            save(draft=payload)
            res = {"saved": True}
        elif op == "scan-status":
            res = scan_status()
        elif op == "folders":
            res = {"rows": folder_rows(), "days": DEFAULT_DAYS}
        elif op == "register":
            ensure_board()
            res = register(payload.get("dirs") or [])
        elif op == "prefs":
            res = prefs_plan()
        elif op == "prefs-apply":
            res = prefs_apply(a.pick)
        elif op == "rules":
            res = rules_plan()
        elif op == "apply-dir":
            res = apply_dir()
        elif op == "apply-rules":
            res = apply_rules([x for x in (a.agents or "").split(",") if x])
        elif op == "apply-skills":
            res = apply_skills([x for x in (a.agents or "").split(",") if x])
        elif op == "apply-command":
            res = apply_command()
        elif op == "vscode":
            import vscode_import
            res = {"found": vscode_import.scan()}
        elif op == "vscode-apply":
            res = vscode_apply(payload)
        elif op == "vscode-extensions":
            res = vscode_extensions(payload.get("ids") or [])
        elif op == "log-entry":
            res = log_entry(args[0] if args else "")
        elif op == "log-add":
            res = log_add(payload["kind"], payload["title"], payload.get("detail", ""), payload.get("data"), payload.get("key"))
        elif op == "log":
            res = {"items": log_public()}
        elif op == "available":
            res = {"items": available()}
        elif op == "undo":
            res = undo(args[0] if args else "", also_git=bool(a.also_git))
        elif op == "step":
            save(step=args[0] if args else "agents")
            res = {"step": args[0] if args else "agents"}
        elif op == "finish":
            res = finish(False)
        elif op == "skip":
            res = finish(True)
        elif op == "reset":
            res = reset()
        else:
            res = {"ok": False, "message": f"unknown op {op}"}
    except Exception as e:  # noqa: BLE001
        _print({"ok": False, "message": str(e)[:300]})
        return 1
    if isinstance(res, dict) and "ok" not in res:
        res = dict(res, ok=True)
    _print(res)
    return 0 if res.get("ok", True) else 1
