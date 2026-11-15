# -*- coding: utf-8 -*-
"""Tidy up after work (`dispatch neat`): the built-in neat-freak skill run by itself, set in Settings › Agents.

    off     (the default) nothing runs by itself; anyone can still type /neat-freak in a session
    task    after each task that is finished (`dispatch done`), for that task's project
    daily   once a day, for every project a task was finished in since the last daily round

A run is an in-app session (`dispatch agent start`, labelled "Tidy up · <project>") with the neat-freak skill in
its read-only first phase (the skill only ever changes what the person picks after its report): it checks the project's docs, rules and Dispatch's knowledge (preferences, wiki, shared rules,
tasks) against the code and changes nothing. Its first line is a one-sentence result; the session's end puts that
line in the bell (chatd files every in-app session's finished turn there), the whole report goes to
~/.dispatch/state/neat/<time>-<project>.md.

Settings live in ~/.dispatch/config.json (`neat`: auto, engine, model); runs and the projects waiting for the daily
round in ~/.dispatch/state/neat.json. A project already being tidied, or tidied less than DEBOUNCE ago for the same
reason, is not started again (a burst of finished tasks makes one run, not ten).
"""
import datetime
import json
import os
import re
import subprocess
import sys
import time

import dispatch_dir as DD

MODES = ("off", "task", "daily")
DEBOUNCE = 30 * 60          # seconds between two runs for one project
RUN_TIMEOUT_MS = 30 * 60 * 1000
DAILY_HOUR = 9              # the daily round starts at or after this hour, local time
HERE = os.path.dirname(os.path.abspath(__file__))

PROMPT = """Use the neat-freak skill for an automatic tidy-up check of this project ({why}). It was switched on in Dispatch's settings and nobody is watching, so follow the skill's "Automatic runs" section:
- Read only (the skill's phase 1, no phase 2): change, delete or commit no file; write no agent memory; add, change or close no preference, wiki entry, rule or task; start no server or test instance; ask nothing.
- Do the light path's inventory and fact check, then Dispatch's knowledge: this project's preferences (dispatch prefs list --json), wiki and pits (dispatch wiki search "{name}"), the shared rules (dispatch rules status), its open tasks (dispatch task list -P "{name}"). Also look whether the project's rules are actually followed.
- The first line of your answer is one sentence with the result, for example "3 docs disagree with the code, 1 rule is not followed" or "Everything matches, nothing to change". It is shown in the bell. Then an empty line and the report in the skill's format: numbered findings, each with where, evidence and the proposed change, and as the last line how to get them fixed ("To fix some of these, open this session and say which numbers.").
- Write in the language the person uses with you (their rules and preferences show it)."""


# ---------------------------------------------------------------- settings

def settings():
    c = DD.config_load().get("neat") or {}
    auto = c.get("auto") if c.get("auto") in MODES else "off"
    return {"auto": auto, "engine": c.get("engine") or "", "model": c.get("model") or ""}


def save_settings(auto=None, engine=None, model=None):
    d = DD.config_load()
    cur = settings()
    if auto is not None:
        if auto not in MODES:
            raise SystemExit(f"auto must be one of {', '.join(MODES)}")
        cur["auto"] = auto
    if engine is not None:
        import engines
        ids = [e.id for e in engines.runnable()]
        if engine not in ("", "default", *ids):
            raise SystemExit("engine must be default, " + engines.join_words(ids, "or"))
        cur["engine"] = "" if engine == "default" else engine
    if model is not None:
        cur["model"] = model
    d["neat"] = cur
    DD.config_save(d)
    return cur


# ---------------------------------------------------------------- state

def state_path():
    return DD.path("state", "neat.json")


def load_state():
    try:
        with open(state_path(), encoding="utf-8") as f:
            s = json.load(f)
        if isinstance(s, dict):
            s.setdefault("runs", {})
            s.setdefault("waiting", [])
            return s
    except (OSError, ValueError):
        pass
    return {"runs": {}, "waiting": [], "last_daily": ""}


def save_state(s):
    os.makedirs(os.path.dirname(state_path()), exist_ok=True)
    tmp = state_path() + f".tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False, indent=1)
    os.replace(tmp, state_path())


def project_name(folder):
    return os.path.basename(os.path.normpath(folder)) or folder


# ---------------------------------------------------------------- triggers

def cli_argv():
    return [sys.executable, os.path.join(HERE, "dispatch.py")]


def spawn(argv):
    """Start a run that outlives the command that asked for it (`dispatch done` returns at once)."""
    log = DD.path("state", "neat.log")
    os.makedirs(os.path.dirname(log), exist_ok=True)
    with open(log, "a", encoding="utf-8") as out:
        subprocess.Popen(argv, stdout=out, stderr=out, stdin=subprocess.DEVNULL, start_new_session=True, close_fds=True)


def after_done(folder, now=None, starter=spawn):
    """`dispatch done` just finished a task in `folder`. Remember the project for the daily round; with "after each
    task" on, start a run for it now. Returns what happened, for the done message."""
    if not folder or not os.path.isdir(folder):
        return ""
    now = now if now is not None else time.time()
    folder = os.path.abspath(folder)
    s = load_state()
    if folder not in s["waiting"]:
        s["waiting"].append(folder)
        save_state(s)
    if settings()["auto"] != "task":
        return ""
    if busy(folder, now, s):
        return ""
    starter(cli_argv() + ["neat", "run", folder, "--why", "task"])
    return f"tidying up {project_name(folder)} in the background (Settings, Agents, Tidy up after work)"


def busy(folder, now, s=None):
    r = (s or load_state())["runs"].get(folder) or {}
    if not r:
        return False
    if r.get("status") == "running" and now - r.get("at", 0) < RUN_TIMEOUT_MS / 1000 + 300:
        return True
    return now - r.get("at", 0) < DEBOUNCE


def daily_due(now=None):
    now = now if now is not None else time.time()
    if settings()["auto"] != "daily":
        return False
    t = datetime.datetime.fromtimestamp(now)
    return t.hour >= DAILY_HOUR and load_state().get("last_daily") != t.date().isoformat()


def daily(now=None, starter=spawn):
    """chatd's sweep: once a day, one run per project a task was finished in since the last round."""
    now = now if now is not None else time.time()
    if not daily_due(now):
        return []
    s = load_state()
    s["last_daily"] = datetime.datetime.fromtimestamp(now).date().isoformat()
    folders = [f for f in s["waiting"] if os.path.isdir(f)]
    s["waiting"] = []
    save_state(s)
    started = []
    for f in folders:
        if not busy(f, now, s):
            starter(cli_argv() + ["neat", "run", f, "--why", "daily"])
            started.append(f)
    return started


# ---------------------------------------------------------------- one run

def default_engine():
    try:
        import engines as E
        import agents_catalog as AC
        return E.installed_and_default(AC.load_choice()).get("effective") or ""
    except Exception:
        return ""


def run(folder, why="by hand", runner=subprocess.run, now=None):
    """Start the session, wait for it, keep the report. Returns {project, session, status, line, report}."""
    folder = os.path.abspath(os.path.expanduser(folder))
    if not os.path.isdir(folder):
        raise SystemExit(f"Folder does not exist: {folder}")
    now = now if now is not None else time.time()
    cfg = settings()
    engine = cfg["engine"] or default_engine() or "claude"
    name = project_name(folder)
    s = load_state()
    s["runs"][folder] = {"at": now, "status": "running", "why": why, "engine": engine}
    save_state(s)
    prompt = PROMPT.format(why={"task": "a task was just finished", "daily": "the daily round"}.get(why, why), name=name)
    import own_prompts
    own_prompts.remember(prompt)  # Dispatch's words: the board's note-taker leaves them alone
    argv = cli_argv() + ["agent", "start", engine, "--cwd", folder, "--label", f"Tidy up · {name}",
                         "--prompt", prompt,
                         "--timeout", str(RUN_TIMEOUT_MS), "--auto", "--json"]
    if cfg["model"]:
        argv += ["--model", cfg["model"]]
    res, err = {}, ""
    try:
        p = runner(argv, capture_output=True, text=True, timeout=RUN_TIMEOUT_MS / 1000 + 180)
        out = p.stdout or ""
        res = json.loads(out[out.find("{"):]) if "{" in out else {}
        if p.returncode != 0 or not res.get("session"):
            err = (p.stderr or out or "").strip()[-300:] or f"exited with {p.returncode}"
    except (subprocess.TimeoutExpired, ValueError, OSError) as e:
        err = str(e)[:300]
    output = (res.get("output") or "").strip()
    line = next((l.strip() for l in output.splitlines() if l.strip()), "") if output else ""
    stamp = datetime.datetime.fromtimestamp(now).strftime("%Y%m%d-%H%M%S")
    report = DD.path("state", "neat", f"{stamp}-{re.sub(r'[^A-Za-z0-9._-]+', '-', name)}.md")
    os.makedirs(os.path.dirname(report), exist_ok=True)
    with open(report, "w", encoding="utf-8") as f:
        f.write(f"# Tidy up · {name}\n\n- folder: {folder}\n- why: {why}\n- engine: {engine}\n- session: {res.get('session', '')}\n"
                f"- status: {res.get('status', '') if not err else 'failed'}\n\n{output or err}\n")
    s = load_state()
    s["runs"][folder] = {"at": now, "status": "failed" if err else (res.get("status") or "done"), "why": why, "engine": engine,
                         "session": res.get("session", ""), "line": line or err, "report": report}
    save_state(s)
    return {"project": name, "folder": folder, "session": res.get("session", ""), "status": s["runs"][folder]["status"],
            "line": line or err, "report": report}


def last_run():
    runs = list(load_state()["runs"].items())
    if not runs:
        return None
    folder, r = max(runs, key=lambda kv: kv[1].get("at", 0))
    return dict(r, folder=folder, project=project_name(folder))


# ---------------------------------------------------------------- command

def command(a):
    op = a.op or "status"
    if op == "auto":
        res = dict(save_settings(a.mode or None, a.engine, a.model) if (a.mode or a.engine is not None or a.model is not None) else settings(),
                   last=last_run(), modes=list(MODES))
    elif op == "status":
        res = dict(settings(), last=last_run(), waiting=load_state()["waiting"], modes=list(MODES))
    elif op == "run":
        if not a.mode:
            raise SystemExit("dispatch neat run <project folder> [--why task|daily]")
        res = run(a.mode, a.why or "by hand")
    elif op == "daily":
        res = {"started": daily()}
    else:
        raise SystemExit(f"unknown op {op}")
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    elif op == "run":
        print(f"{res['project']}: {res['line']}\n{res['report']}")
    else:
        print(json.dumps(res, ensure_ascii=False, indent=2))


def add_parser(sub):
    s = sub.add_parser("neat", help="tidy up after work (the built-in neat-freak skill, read only): status | auto [off|task|daily] [--engine E] [--model M] | run <folder> | daily")
    s.add_argument("op", nargs="?", default="status", choices=["status", "auto", "run", "daily"])
    s.add_argument("mode", nargs="?", default="", help="auto: off, task (after each finished task) or daily; run: the project folder")
    s.add_argument("--engine", default=None, help="auto: default, claude, codex or opencode")
    s.add_argument("--model", default=None)
    s.add_argument("--why", default="", help="run: task, daily or a word of your own")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=command)
    return s
