# -*- coding: utf-8 -*-
"""`dispatch doctor [--fix] [--json]`: one line per check, ok / warn / fail, what is wrong in a
sentence and how to fix it. Whatever can be fixed without judgement (a missing hook, a chatd running
old code, a lost machine id, a broken link) `--fix` fixes; the rest only says the command to run.

The checks (names are stable, they are what `--json` and the notifications carry):

  hooks.claude-code | hooks.codex | hooks.opencode
                    the Dispatch hooks / plugin each chosen engine has, against what the installer
                    in init_wizard.py would write now (it is run into a scratch file to get the
                    expected set, so this list never drifts from the installer); every hook command
                    must point at files that exist
  chatd             running, and running the code that is on disk (chatd.json carries the code stamp
                    chatd took at start)
  board.dolt        the board's database server answers
  board.read        one small `bd list` takes < 3 s (warn above, fail above 15 s)
  engines.claude | engines.codex | engines.opencode
                    installed version against the oldest one Dispatch can drive (chat_protocol.py,
                    chat_opencode.py)
  machine-id        ~/.dispatch/machine-id exists (workers.machine_id)
  disk.free         free space on the home volume
  disk.staging      built Dispatch IDE copies in staging (each is ~1.8 GB), warn above 5
  links.claude-agents | links.agents-rules
                    ~/.claude/agents and ~/.agents/rules are links into ~/.dispatch
  links.skill-task-board | links.skill-delivery-page | links.skill-built-in-browser | links.skill-computer-use
                    the built-in skills in the pool link to the copy that ships with Dispatch
  processes.bonjour | processes.engine-runs
                    nothing left behind that nobody will end: Bonjour records of a phone service that is
                    gone, `opencode run` without a terminal running for over an hour

`--json` prints {"schema": 1, "at", "host", "ok", "counts": {ok, warn, fail}, "checks": [{name,
status, message, fix, fixable, detail}], "fixed": [{name, ok, message}] (with --fix)}. The exit
status is 1 when a check fails, 0 otherwise.

chatd runs this once a day (`daily`): a failing check is written into the dispatcher's notifications
(wake.py), once per check and day, and the whole result into DISPATCH_DIR/doctor-last.json.
"""
import datetime
import hashlib
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import engines as E  # noqa: E402

SCHEMA = 1
LAST_FILE = "doctor-last.json"
DAILY_SECONDS = 24 * 3600
BD_WARN, BD_FAIL, BD_TIMEOUT = 3.0, 15.0, 60
FREE_WARN_GB, FREE_FAIL_GB = 15, 5
STAGING_KEEP = 5
BUSY = ("running", "starting", "waiting_input", "waiting_permission")  # chatd sessions a restart would cut off


# ---------------------------------------------------------------- what chatd loaded

def code_stamp(cli_dir=None):
    """What a chatd started from `cli_dir` is running: the folder, VERSION, the git HEAD (when it is a
    checkout) and a digest of every CLI source file (tests left out). chatd writes it into chatd.json
    at start; `dispatch doctor` computes it again to see whether the code changed underneath."""
    cli = os.path.abspath(cli_dir or HERE)
    h = hashlib.sha1()
    try:
        names = sorted(os.listdir(cli))
    except OSError:
        names = []
    for name in names:
        if name == "VERSION" or (name.endswith((".py", ".sh", ".json")) and not name.startswith("test_")):
            try:
                with open(os.path.join(cli, name), "rb") as f:
                    h.update(name.encode() + b"\0" + f.read() + b"\0")
            except OSError:
                pass
    try:
        version = open(os.path.join(cli, "VERSION"), encoding="utf-8").read().strip()
    except OSError:
        version = ""
    head = ""
    try:
        r = subprocess.run(["git", "-C", cli, "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=3)
        head = r.stdout.strip() if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        pass
    return {"cli": cli, "version": version, "head": head, "digest": h.hexdigest()[:12]}


def stamp_name(stamp):
    return (stamp or {}).get("head") or (stamp or {}).get("version") or (stamp or {}).get("digest") or "?"


# ---------------------------------------------------------------- context (every outside thing a check touches)

class Ctx:
    """Paths and the few outside calls the checks make. A test builds one on a scratch HOME and
    replaces the calls (bd, the engines, launchd) with stubs."""

    def __init__(self, d=None, home=None, dispatch_dir=None, beads_dir=None, clock=time.time):
        self.home = home or getattr(d, "HOME", "") or os.path.expanduser("~")
        self.dispatch_dir = dispatch_dir or getattr(d, "DISPATCH_DIR", "") or os.environ.get("DISPATCH_DIR") or os.path.join(self.home, "tasks", ".dispatch")
        self.beads_dir = beads_dir or getattr(d, "BEADS_DIR", "") or os.environ.get("BEADS_DIR") or os.path.join(self.home, "tasks", ".beads")
        self.clock = clock
        self.fixers = {}     # check name -> () -> (ok, message)
        self.groups = {}     # check name -> group id, so a fix re-runs only its own group
        self.cli_dir = HERE
        self.bd_read = self._bd_read
        self.dolt_up = self._dolt_up
        self.engine_rows = self._engine_rows
        self.chatd_status = self._chatd_status
        self.registry = self._registry
        self.stamp = code_stamp
        self.restart_chatd = self._restart_chatd
        self.stop_stray = self._stop_stray
        self.processes = _processes
        self.free_bytes = lambda: shutil.disk_usage(self.home).free
        self.staging_dir = self._staging_dir
        self.hosts = self._hosts

    # -- paths
    def hooks_file(self, agent):
        """Where Dispatch's hooks go in that engine under this home (its adapter says)."""
        return E.get(agent).hooks_file(self.home)

    def hook_trusted(self, eng, path):
        """Whether an engine that only runs trusted hooks (Codex) runs Dispatch's entry in `path`: it is asked."""
        import hooks_setup
        return eng.hook_trusted(path, hooks_setup.command(eng))

    @property
    def config_env(self):
        env = dict(os.environ)
        env["XDG_CONFIG_HOME"] = os.path.join(self.home, ".config")
        return env

    def selected_agents(self):
        """The engines the first-run wizard was told to set up (init.json), or None when it never ran."""
        try:
            with open(os.path.join(self.dispatch_dir, "init.json"), encoding="utf-8") as f:
                agents = json.load(f).get("agents")
        except (OSError, ValueError):
            return None
        return [a for a in agents if isinstance(a, str)] if isinstance(agents, list) else None

    # -- outside calls
    def _bd_read(self):
        """(exit code or None on a timeout, seconds, first line of the error)."""
        import engines
        env = dict(os.environ, BEADS_DIR=self.beads_dir)
        env["PATH"] = engines.search_path(env)
        started = time.time()
        try:
            r = subprocess.run([engines.which("bd") or "bd", "list", "--limit", "1", "--json"], capture_output=True, text=True, timeout=BD_TIMEOUT, env=env)
        except subprocess.TimeoutExpired:
            return None, time.time() - started, f"no answer after {BD_TIMEOUT} s"
        except OSError as e:
            return 127, time.time() - started, str(e)
        err = (r.stderr or r.stdout or "").strip().splitlines()
        return r.returncode, time.time() - started, err[0][:200] if err and r.returncode else ""

    def _dolt_up(self):
        import init_wizard
        return init_wizard.dolt_server_up()

    def _engine_rows(self):
        import engines
        return [engines.status(e, "") for e in engines.managed()]

    def installed_engines(self):
        """Engine ids that are installed here (engines.status, asked once per run)."""
        if not hasattr(self, "_installed"):
            try:
                rows = self.engine_rows()
                # engines.status answers for every engine it knows; no rows at all means we cannot tell
                self._installed = {e["id"] for e in rows if e.get("installed")} if rows else None
            except Exception:
                self._installed = None
        return self._installed

    def _chatd_status(self):
        import chatd_service
        return chatd_service.status()

    def _registry(self):
        import chatd
        return chatd.read_registry(self.dispatch_dir)

    def _restart_chatd(self):
        import chatd_service
        import launchd
        if not launchd.kickstart(chatd_service.LABEL, restart=True):
            return False
        return chatd_service.wait_door(chatd_service.START_WAIT, self.dispatch_dir)

    def _stop_stray(self, pid):
        import chatd_service
        return chatd_service.stop_stray(pid)

    def _hosts(self):
        try:
            with open(os.path.join(self.dispatch_dir, "hosts.json"), encoding="utf-8") as f:
                hs = json.load(f)
            return [h for h in hs if isinstance(h, dict)] if isinstance(hs, list) else []
        except (OSError, ValueError):
            return []

    def _staging_dir(self):
        import builds
        return builds.staging_dir()


def row(name, status, message, fix="", fixable=False, **detail):
    return {"name": name, "status": status, "message": message, "fix": fix, "fixable": bool(fixable), "detail": detail}


# ---------------------------------------------------------------- hooks

def entry_command(data):
    """The command of Dispatch's hook entry in a settings.json / hooks.json document, '' when it is not there."""
    import hooks_setup
    for groups in ((data.get("hooks") if isinstance(data, dict) else None) or {}).values():
        for g in groups if isinstance(groups, list) else []:
            for h in (g.get("hooks") if isinstance(g, dict) else None) or []:
                if isinstance(h, dict) and hooks_setup.kind(h.get("command")) == "entry":
                    return h["command"]
    return ""


def command_problems(command, home):
    """What a hook command runs that is not there: the program and every .py / .sh it is given."""
    import engines
    text = re.sub(r"\s#\s*dispatch-[\w-]+\s*$", "", command)
    try:
        parts = shlex.split(text)
    except ValueError:
        return ["the command line does not parse"]
    while parts and re.match(r"^[A-Za-z_]\w*=", parts[0]):
        parts.pop(0)
    if not parts:
        return ["the command line is empty"]
    missing = []
    for i, tok in enumerate(parts):
        if i and not tok.endswith((".py", ".sh")):
            continue
        path = tok.replace("${HOME}", home).replace("$HOME", home)
        if path.startswith("~"):
            path = home + path[1:]
        if os.sep in path:
            found = os.path.exists(path)
        else:
            found = bool(shutil.which(path, path=engines.search_path()))
        if not found:
            missing.append(path.replace(home, "~", 1))
    return missing


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f), ""
    except FileNotFoundError:
        return None, "missing"
    except (OSError, ValueError) as e:
        return None, f"unreadable: {e}"


def _check_json_hooks(ctx, agent, path, fix_cmd):
    """Dispatch's one hook entry (hooks_setup.py) in an engine's settings file: on every event it should be, as this
    install writes it, nothing older of Dispatch's beside it, its program there, and trusted where that is needed."""
    name = "hooks." + agent
    eng = E.get(agent)
    label = eng.name
    home_dir = os.path.dirname(path)
    if not os.path.isdir(home_dir):
        return row(name, "warn", f"{label} is chosen but {home_dir.replace(ctx.home, '~', 1)} does not exist", "install it, then `dispatch doctor --fix`")
    data, why = _read_json(path)
    rel = path.replace(ctx.home, "~", 1)
    if why.startswith("unreadable"):
        return row(name, "fail", f"{rel} does not parse as JSON, Dispatch left it alone", f"fix or move {rel} by hand, then `dispatch doctor --fix`")
    st = eng.hooks_state(path)
    cmd = entry_command(data or {})
    gone = command_problems(cmd, ctx.home) if cmd else []

    def fixer():
        res = eng.install_hooks(path=path, trust=True)
        return (not res.get("skipped")), (res.get("skipped") or f"Dispatch's hook brought up to date in {rel}")

    problems = []
    if not data and why == "missing":
        problems.append(f"{rel} does not exist")
    elif not st["events"]:
        problems.append("Dispatch's hook is not there" + (f" (older Dispatch hooks are: {', '.join(st['old'])})" if st["old"] else ""))
    else:
        if st["missing"]:
            problems.append(f"Dispatch's hook is missing on {len(st['missing'])} event(s): " + ", ".join(st["missing"][:6]) + (" ..." if len(st["missing"]) > 6 else ""))
        if st["old"]:
            problems.append("older Dispatch hooks are still there beside it (" + ", ".join(st["old"]) + ")")
        if not st["missing"] and not st["current"] and not st["old"]:
            problems.append("Dispatch's hook is not the one this install writes (a moved app or Python)")
    if gone:
        problems.append("its command points at files that are gone: " + ", ".join(gone[:4]))
    if not problems and eng.hook_trust:
        trusted = ctx.hook_trusted(eng, path)
        if trusted is False:
            problems.append(f"{label} does not run it yet: it is not trusted there")
    if not problems:
        return row(name, "ok", f"{label}: Dispatch's hook in place on {len(st['events'])} events, its program exists", entries=len(st["events"]))
    ctx.fixers[name] = fixer
    return row(name, "fail", f"{label} hooks: " + "; ".join(problems), fix_cmd, True, missing=st["missing"], old=st["old"], gone=gone)


def _check_plugin(ctx, eng):
    """An engine whose Dispatch hooks are a plugin it loads (OpenCode): in place and this install's own copy."""
    name = "hooks." + eng.agent
    st = eng.plugin_state(ctx.config_env)
    rel = st["path"].replace(ctx.home, "~", 1)
    if not st["config_exists"]:
        return row(name, "warn", f"{eng.name} is chosen but its config folder does not exist", f"install {eng.name}, then `dispatch doctor --fix`")
    if st["installed"] and st["current"]:
        return row(name, "ok", f"{eng.name}: Dispatch plugin in place ({rel})")
    if not st["shipped"]:
        return row(name, "warn", f"this install ships no {eng.name} plugin file to compare with")

    def fixer():
        res = eng.install_hooks(env=ctx.config_env)
        return (not res.get("skipped")), (res.get("skipped") or f"plugin linked at {rel}")

    ctx.fixers[name] = fixer
    if not st["installed"]:
        return row(name, "fail", f"{eng.name}: the Dispatch plugin is not installed ({rel})", "`dispatch doctor --fix`", True)
    return row(name, "warn", f"{eng.name}: {rel} is not this install's plugin (an old copy, or a link to a file that is gone)", "`dispatch doctor --fix`", True)


def check_hooks(ctx):
    selected = ctx.selected_agents()
    rows = []
    for eng in E.runnable():
        agent = eng.agent
        if eng.hooks_json:
            check = (lambda eng=eng: _check_json_hooks(ctx, eng.agent, ctx.hooks_file(eng.agent),
                                                      f"`dispatch doctor --fix` (reinstalls the {eng.name} hooks)"))
        elif eng.hooks_plugin:
            check = (lambda eng=eng: _check_plugin(ctx, eng))
        else:
            continue
        if selected is None:
            rows.append(row("hooks." + agent, "ok", "first-run setup never recorded the chosen engines, not checked", "dispatch init"))
        elif agent not in selected and eng.hooks_plugin and ctx.installed_engines() and eng.id in ctx.installed_engines():
            # installed but not chosen at first run (an older setup): without the plugin its sessions in the
            # Agents window get no session brief and no preferences
            r = check()
            if r["status"] != "ok":
                r.update(status="warn", fix=f"`dispatch engines install-plugin {eng.id}`",
                         message=r["message"] + f" ({eng.name} is installed but was not chosen in first-run setup: its sessions get no session brief)")
            rows.append(r)
        elif agent not in selected:
            rows.append(row("hooks." + agent, "ok", f"{E.get(agent).name} is not among the chosen engines, not checked"))
        elif ctx.installed_engines() is not None and E.id_of(agent) not in ctx.installed_engines():
            # chosen but not installed yet (a new Mac): engines.<id> already says so; the hooks go in once it is
            rows.append(row("hooks." + agent, "ok", f"{E.get(agent).name} is not installed yet, its hooks are checked once it is"))
        else:
            rows.append(check())
    return rows


# ---------------------------------------------------------------- chatd

def check_chatd(ctx):
    st = ctx.chatd_status()
    if not st.get("door_pid"):
        if not st.get("installed"):
            return [row("chatd", "warn", "chatd is not running and its resident service is not installed", "`dispatch chatd install`")]

        def start():
            ok = ctx.restart_chatd()
            return bool(ok), "chatd started" if ok else "chatd did not come up, see chatd.log"

        ctx.fixers["chatd"] = start
        return [row("chatd", "fail", "chatd is installed but not running (sessions cannot start, workers are not swept)", "`dispatch doctor --fix`", True, log=st.get("log", ""))]
    if st.get("door") == "stray":
        # a `chatd run` nothing manages holds the door (task-0mwh): the resident one waits behind it, or is
        # not installed. Stopping it lets the resident one (started again here when installed) take over.
        where = (st.get("door_cli") or "?").replace(ctx.home, "~", 1)

        def take_over():
            ok = ctx.stop_stray(st["door_pid"])
            if not ok:
                return False, f"chatd {st['door_pid']} did not quit"
            if not st.get("installed"):
                return True, "the old chatd stopped; `dispatch chatd install` starts the resident one"
            up = ctx.restart_chatd()
            return bool(up), "the resident chatd took over" if up else "the old chatd stopped but the resident one did not come up, see chatd.log"

        ctx.fixers["chatd"] = take_over
        return [row("chatd", "fail", f"chatd (pid {st['door_pid']}, code in {where}) runs on its own, nothing manages it: "
                    + ("the resident service waits behind it and sessions run its code" if st.get("installed") else "it keeps running after Dispatch quits"),
                    "`dispatch doctor --fix` (stops it; the resident chatd takes over)", True, pid=st["door_pid"])]
    reg = ctx.registry() or {}
    then = reg.get("code")
    by_launchd = st.get("door") == "launchd"
    sessions = reg.get("sessions") if isinstance(reg.get("sessions"), dict) else {}
    busy = [k for k, s in sessions.items() if isinstance(s, dict) and s.get("lifecycle") in BUSY]

    def restart():
        if busy:
            return False, f"{len(busy)} session(s) are running in chatd, not restarted (run `dispatch doctor --fix` when they are idle)"
        ok = ctx.restart_chatd()
        return bool(ok), "chatd restarted" if ok else "chatd did not come back, see chatd.log"

    fixable = by_launchd
    how = "`dispatch doctor --fix` (restarts chatd when no session is running)" if by_launchd else "quit the Dispatch window that started this chatd and open it again"
    if not isinstance(then, dict) or not then.get("digest"):
        if fixable:
            ctx.fixers["chatd"] = restart
        return [row("chatd", "fail", f"chatd (pid {st['door_pid']}) started before it recorded its code version: it runs code from before the last update", how, fixable, pid=st["door_pid"])]
    now = ctx.stamp(then.get("cli") or ctx.cli_dir) if os.path.isdir(then.get("cli") or "") else None
    if now is None:
        return [row("chatd", "warn", f"chatd loaded its code from {then.get('cli')}, which is gone", how, fixable, pid=st["door_pid"])]
    if now["digest"] != then["digest"]:
        if fixable:
            ctx.fixers["chatd"] = restart
        same = stamp_name(then) == stamp_name(now)
        msg = (f"chatd (pid {st['door_pid']}) started at {stamp_name(then)} and the code in {then['cli'].replace(ctx.home, '~', 1)} "
               + (f"has changed since (files edited, still {stamp_name(now)})" if same else f"is {stamp_name(now)} now") + ": new features are not loaded")
        return [row("chatd", "fail", msg, how, fixable, pid=st["door_pid"], running=then, disk=now, busy=len(busy))]
    return [row("chatd", "ok", f"chatd running (pid {st['door_pid']}), code {stamp_name(then)} is what is on disk", pid=st["door_pid"], running=then)]


# ---------------------------------------------------------------- board

def _embedded(ctx):
    try:
        with open(os.path.join(ctx.beads_dir, "metadata.json"), encoding="utf-8") as f:
            return json.load(f).get("dolt_mode") == "embedded"
    except (OSError, ValueError):
        return False


def check_board(ctx):
    if not os.path.exists(os.path.join(ctx.beads_dir, "config.yaml")):
        return [row("board.dolt", "warn", f"no task board at {ctx.beads_dir.replace(ctx.home, '~', 1)}", "`dispatch init`"),
                row("board.read", "warn", "no task board to read")]
    rows = []
    if _embedded(ctx):
        rows.append(row("board.dolt", "ok", "the board is bd's embedded database, no server to keep running"))
    elif ctx.dolt_up():
        rows.append(row("board.dolt", "ok", "the Dolt server answers"))
    else:
        def start():
            import init_wizard as I
            r = I.ensure_board_server()
            return bool(r.get("ok")), ("Dolt server started (" + str(r.get("how")) + ")") if r.get("ok") else ("Dolt server did not start: " + (r.get("log") or "").strip()[-200:])

        ctx.fixers["board.dolt"] = start
        rows.append(row("board.dolt", "fail", "the board's Dolt server does not answer: every `bd` call fails or hangs", "`dispatch doctor --fix`", True))
    code, secs, err = ctx.bd_read()
    if code is None or code != 0:
        rows.append(row("board.read", "fail", f"`bd list` failed after {secs:.1f} s: {err}", "check the Dolt server, then `bd list`", seconds=round(secs, 2)))
    elif secs > BD_FAIL:
        rows.append(row("board.read", "fail", f"a simple `bd list` took {secs:.1f} s (limit {BD_FAIL:.0f} s)", "many test runs share one Dolt; wait for them, or restart the server", seconds=round(secs, 2)))
    elif secs > BD_WARN:
        rows.append(row("board.read", "warn", f"a simple `bd list` took {secs:.1f} s (should be under {BD_WARN:.0f} s)", "many test runs share one Dolt; wait for them", seconds=round(secs, 2)))
    else:
        rows.append(row("board.read", "ok", f"a simple `bd list` took {secs:.2f} s", seconds=round(secs, 2)))
    return rows


# ---------------------------------------------------------------- engines

def minimums():
    """The oldest version of each engine Dispatch can drive (what its chat driver was verified against)."""
    return {e.id: e.chat_min_version or e.min_version for e in E.runnable() if e.chat_min_version or e.min_version}


def version_tuple(text):
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", text or "")
    return tuple(int(x) for x in m.groups()) if m else ()


def check_engines(ctx):
    mins = minimums()
    selected = ctx.selected_agents() or []
    rows = []
    for e in ctx.engine_rows():
        name, label = "engines." + e["id"], e["name"]
        need = ".".join(map(str, mins.get(e["id"], ())))
        if not e.get("installed"):
            chosen = any(E.id_of(a) == e["id"] for a in selected)
            rows.append(row(name, "warn" if chosen else "ok", f"{label} is not installed" + (" (chosen in first-run setup)" if chosen else ""), f"`{e.get('command')}`" if chosen and e.get("command") else ""))
            continue
        have = version_tuple(e.get("version"))
        if not have:
            rows.append(row(name, "warn", f"{label} is installed at {e.get('path')} but `--version` gave nothing readable"))
        elif mins.get(e["id"]) and have < tuple(mins[e["id"]]):
            why = f" ({E.get(e['id']).min_version_why})" if E.get(e["id"]).min_version_why else ""
            rows.append(row(name, "fail", f"{label} {e['version']} is older than the {need} Dispatch needs{why}", f"`{e.get('command')}`", version=e["version"], minimum=need))
        else:
            rows.append(row(name, "ok", f"{label} {e['version']} (needs {need} or newer)", version=e["version"], minimum=need))
        text = E.get(e["id"]).config_problems(ctx.home, ctx.config_env)
        if text:
            rows.append(row(f"engines.{e['id']}.folders", "warn", text))
    return rows


# ---------------------------------------------------------------- machine id

def check_machine(ctx):
    path = os.path.join(ctx.home, ".dispatch", "machine-id")
    rel = path.replace(ctx.home, "~", 1)
    try:
        with open(path, encoding="utf-8") as f:
            value = f.read().strip()
    except OSError:
        value = ""
    if value:
        return [row("machine-id", "ok", f"{rel} exists", id=value[:8])]

    def make():
        import workers
        workers._MACHINE_ID.pop(path, None)
        made = workers.machine_id(ctx.home)
        return bool(made) and os.path.exists(path), f"{rel} written"

    ctx.fixers["machine-id"] = make
    return [row("machine-id", "warn", f"{rel} is missing: workers tell this Mac by host name, and a network change makes its own rows look remote", "`dispatch doctor --fix`", True)]


# ---------------------------------------------------------------- disk

def check_disk(ctx):
    rows = []
    free = ctx.free_bytes() / 1024 ** 3
    if free < FREE_FAIL_GB:
        rows.append(row("disk.free", "fail", f"{free:.1f} GB free on the home volume", "clear old builds in staging or the trash", free_gb=round(free, 1)))
    elif free < FREE_WARN_GB:
        rows.append(row("disk.free", "warn", f"{free:.1f} GB free on the home volume (a build needs about 2 GB)", "clear old builds in staging or the trash", free_gb=round(free, 1)))
    else:
        rows.append(row("disk.free", "ok", f"{free:.0f} GB free on the home volume", free_gb=round(free, 1)))
    staging = ctx.staging_dir()
    builds = []
    try:
        for n in os.listdir(staging):
            p = os.path.join(staging, n)
            if os.path.isdir(os.path.join(p, "Dispatch IDE.app")):
                builds.append((os.path.getmtime(p), n))
    except OSError:
        pass
    builds.sort()
    if len(builds) > STAGING_KEEP:
        old = [n for _, n in builds[:len(builds) - STAGING_KEEP]]
        rows.append(row("disk.staging", "warn", f"{len(builds)} built copies in {staging.replace(ctx.home, '~', 1)}, about 1.8 GB each (keep {STAGING_KEEP})",
                        "move the oldest to the trash: " + ", ".join(old), count=len(builds), oldest=old))
    else:
        rows.append(row("disk.staging", "ok", f"{len(builds)} built copies in staging (keep at most {STAGING_KEEP})", count=len(builds)))
    return rows


# ---------------------------------------------------------------- links

def check_links(ctx):
    root = os.path.join(ctx.home, ".dispatch")
    rows = []
    for name, link, sub in (("links.claude-agents", os.path.join(ctx.home, ".claude", "agents"), "agents"),
                            ("links.agents-rules", os.path.join(ctx.home, ".agents", "rules"), "rules")):
        target = os.path.join(root, sub)
        rel, rt = link.replace(ctx.home, "~", 1), "~/.dispatch/" + sub
        if os.path.islink(link) and os.path.realpath(link) == os.path.realpath(target) and os.path.isdir(target):
            rows.append(row(name, "ok", f"{rel} is a link to {rt}"))
            continue
        if os.path.isdir(link) and not os.path.islink(link):
            rows.append(row(name, "warn", f"{rel} is a plain folder, not a link to {rt}: edits there are not what other agents read", "`dispatch dir migrate --dry-run`"))
            continue
        if not os.path.islink(link) and not os.path.exists(os.path.dirname(link)) and sub == "agents":
            rows.append(row(name, "ok", f"{os.path.dirname(rel)} does not exist (Claude Code not installed), no link needed"))
            continue
        if not os.path.lexists(link) and sub == "agents" and ctx.installed_engines() is not None and "claude" not in ctx.installed_engines():
            # ~/.claude made by something else (Dispatch IDE's bundled agent SDK) on a Mac without Claude Code
            rows.append(row(name, "ok", f"Claude Code is not installed, no {rel} link needed yet"))
            continue

        def relink(link=link, target=target, rel=rel, rt=rt):
            os.makedirs(target, exist_ok=True)
            os.makedirs(os.path.dirname(link), exist_ok=True)
            if os.path.islink(link):
                os.unlink(link)
            os.symlink(target, link)
            return True, f"{rel} now links to {rt}"

        if os.path.islink(link) and os.path.realpath(link) != os.path.realpath(target) and os.path.isdir(link):
            rows.append(row(name, "warn", f"{rel} links to {os.path.realpath(link).replace(ctx.home, '~', 1)}, not {rt}", "`dispatch doctor --fix` points it at ~/.dispatch", True))
        elif os.path.islink(link) or not os.path.lexists(link):
            state = "is a broken link" if os.path.islink(link) else "does not exist"
            rows.append(row(name, "fail", f"{rel} {state}: {'Claude Code loses the shared sub-agent definitions' if sub == 'agents' else 'agents lose the shared rules'}", "`dispatch doctor --fix`", True))
        else:
            rows.append(row(name, "fail", f"{rel} is not a folder or a link", f"look at {rel} by hand"))
            continue
        ctx.fixers[name] = relink
    rows.extend(builtin_skill_rows(ctx))
    return rows


def builtin_skill_rows(ctx):
    """links.skill-<name>: Dispatch's built-in skills in the pool link to the installed copy, so they
    update with Dispatch. A copied folder (an earlier setup) is moved to backups and relinked."""
    import init_wizard as I
    pool = D_pool(ctx)
    if not os.path.isdir(pool):
        return []
    rows = []
    for name in I.BUILTIN_SKILLS:
        path = os.path.join(pool, name)
        rel = path.replace(ctx.home, "~", 1)
        key = "links.skill-" + name
        if os.path.islink(path) and os.path.isdir(path):
            rows.append(row(key, "ok", f"{rel} links to {os.path.realpath(path).replace(ctx.home, '~', 1)}"))
            continue
        if os.path.isdir(path) and not I.builtin_skill_content(path, name):
            rows.append(row(key, "warn", f"{rel} is a skill of your own with the name of a Dispatch skill", f"rename {rel}"))
            continue
        state = "is a copy that does not update with Dispatch" if os.path.isdir(path) else "is missing"
        rows.append(row(key, "warn", f"{rel} {state}", "`dispatch doctor --fix` links it to the copy that ships with Dispatch", True))

        def relink(pool=pool, rel=rel):
            done = I.link_builtin_skills(pool, backups=os.path.join(ctx.dispatch_dir, "backups", "skills"))
            return True, (f"{rel} now links to the installed copy" + "".join(f"; old copy kept at {d['backup']}" for d in done if d["backup"])
                          if done else f"{rel} left alone")
        ctx.fixers[key] = relink
    return rows


def D_pool(ctx):
    import dispatch as D
    return D.POOL if os.path.realpath(ctx.home) == os.path.realpath(D.HOME) else os.path.join(ctx.home, ".dispatch", "skills")


# ---------------------------------------------------------------- knowledge sync

def check_knowledge(ctx):
    """When each other Mac last gave us its preferences, wiki, rules, skills and sub-agents (knowledge_sync.py)."""
    import knowledge_sync as K
    hosts = ctx.hosts()
    if not hosts:
        return [row("knowledge.sync", "ok", "only this Mac: nothing to sync")]
    try:
        with open(os.path.join(ctx.dispatch_dir, "knowledge-sync.json"), encoding="utf-8") as f:
            st = json.load(f).get("hosts") or {}
    except (OSError, ValueError, AttributeError):
        st = {}
    now, late, never, ok = ctx.clock(), [], [], []
    for h in hosts:
        rec = st.get(h.get("id")) or {}
        name = h.get("name") or h.get("id")
        last = rec.get("last_ok")
        if not last:
            never.append((name, rec.get("error") or ""))
        elif now - float(last) > K.STALE_AFTER:
            late.append((name, int((now - float(last)) // 3600), rec.get("error") or ""))
        else:
            ok.append((name, int((now - float(last)) // 60)))
    detail = {"hosts": {h.get("id"): (st.get(h.get("id")) or {}).get("last_ok") for h in hosts}}
    if late or never:
        parts = [f"{n}: last sync {hrs} h ago" + (f" ({e})" if e else "") for n, hrs, e in late]
        parts += [f"{n}: never synced" + (f" ({e})" if e else "") for n, e in never]
        return [row("knowledge.sync", "warn", "; ".join(parts), "make sure the other Mac is on and reachable, then `dispatch knowledge sync`", **detail)]
    return [row("knowledge.sync", "ok", "; ".join(f"{n}: synced {m} min ago" for n, m in ok), **detail)]


# ---------------------------------------------------------------- processes left behind

HUNG_RUN_SECONDS = 3600   # a one-shot `opencode run` older than this, with no terminal and nothing of Dispatch's above it


def _etime_seconds(v):
    """ps etime ([[dd-]hh:]mm:ss) → seconds."""
    days, _, rest = v.strip().rpartition("-")
    parts = [int(x) for x in rest.split(":") if x.isdigit()]
    while len(parts) < 3:
        parts.insert(0, 0)
    return (int(days) if days.isdigit() else 0) * 86400 + parts[-3] * 3600 + parts[-2] * 60 + parts[-1]


def _processes():
    """[(pid, ppid, seconds running, tty, command)] of this user's processes."""
    try:
        out = subprocess.run(["ps", "-U", str(os.getuid()), "-ww", "-o", "pid=,ppid=,etime=,tty=,command="],
                             capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) == 5 and parts[0].isdigit() and parts[1].isdigit():
            rows.append((int(parts[0]), int(parts[1]), _etime_seconds(parts[2]), parts[3], parts[4]))
    return rows


def hung_runs(rows, limit=HUNG_RUN_SECONDS):
    """`opencode run` processes nobody will collect (task-adpq: one an Agent started to probe a plugin sat there
    3 h 51 min): running longer than `limit`, no terminal (a person's own run in Terminal has one), and no
    Dispatch worker wrapper (`… _exec`) above it (those have their own time limits). [(pid, seconds, command)]."""
    by_pid = {r[0]: r for r in rows}
    out = []
    for pid, ppid, secs, tty, cmd in rows:
        argv = cmd.split()
        eng = E.by_bin(re.sub(r"\.exe$", "", os.path.basename(argv[0]))) if argv else None
        if len(argv) < 2 or not eng or not eng.stray_runs or argv[1] not in eng.stray_runs:
            continue
        if secs < limit or tty not in ("??", "-", ""):
            continue
        managed, p, seen = False, ppid, set()
        while p in by_pid and p not in seen and p > 1:
            seen.add(p)
            up = by_pid[p][4]
            if " _exec " in up + " " and "/cli/" in up:
                managed = True
                break
            p = by_pid[p][1]
        if not managed:
            out.append((pid, secs, cmd))
    return out


def _stop_pids(pids, wait=5.0):
    """SIGTERM, then SIGKILL what is still there after `wait` s (a hung `opencode run` waiting on its input
    does not always take SIGTERM). Returns the pids still running."""
    import signal
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    end = time.time() + wait
    left = list(pids)
    while left and time.time() < end:
        time.sleep(0.25)
        left = [p for p in left if _alive(p)]
    for pid in left:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    time.sleep(0.3)
    return [p for p in left if _alive(p)]


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return True


def check_processes(ctx):
    """Processes of Dispatch's (or started while working on it) that nothing will end: Bonjour records of a
    phone service that is gone (each one is the Mac once more in the phone's list), and `opencode run` probes
    that never finished. A stray chatd is the chatd check's."""
    rows = ctx.processes()
    out = []
    import mobile
    adverts = mobile.stale_adverts(None, [(p, pp, c) for p, pp, _, _, c in rows])
    if adverts:
        ctx.fixers["processes.bonjour"] = lambda: (not _stop_pids(adverts), f"stopped {len(adverts)} old record(s)")
        out.append(row("processes.bonjour", "warn", f"{len(adverts)} Bonjour record(s) of a Dispatch phone service that is gone are still announced "
                       "(a phone sees this Mac more than once)", "`dispatch doctor --fix` (stops them)", True, pids=adverts))
    else:
        out.append(row("processes.bonjour", "ok", "no Bonjour records left behind"))
    hung = hung_runs(rows)
    if hung:
        pids = [p for p, _, _ in hung]

        def stop():
            left = _stop_pids(pids)
            return not left, f"stopped {len(pids) - len(left)} of {len(pids)}" + (f", still running: {left}" if left else "")

        ctx.fixers["processes.engine-runs"] = stop
        oldest = max(s for _, s, _ in hung)
        out.append(row("processes.engine-runs", "warn", f"{len(hung)} `opencode run` without a terminal ha{'s' if len(hung) == 1 else 've'} run for over "
                       f"{HUNG_RUN_SECONDS // 3600} h (the oldest {oldest // 3600} h {oldest % 3600 // 60} min): nothing will collect them",
                       "`dispatch doctor --fix` (stops them)", True, pids=pids, commands=[c[:160] for _, _, c in hung]))
    else:
        out.append(row("processes.engine-runs", "ok", "no `opencode run` left hanging"))
    return out


# ---------------------------------------------------------------- running them

GROUPS = (("hooks", check_hooks), ("chatd", check_chatd), ("board", check_board), ("engines", check_engines),
          ("machine", check_machine), ("disk", check_disk), ("links", check_links), ("knowledge", check_knowledge),
          ("processes", check_processes))


def run_group(ctx, gid, fn):
    try:
        rows = fn(ctx)
    except Exception as e:  # noqa: BLE001  a check that breaks is a finding, not a crash
        rows = [row(gid, "fail", f"the {gid} check itself failed: {type(e).__name__}: {str(e)[:160]}")]
    for r in rows:
        ctx.groups[r["name"]] = gid
    return rows


def run_checks(ctx, only=None):
    out = []
    for gid, fn in GROUPS:
        if only is None or gid in only:
            out.extend(run_group(ctx, gid, fn))
    return out


def counts(rows):
    return {s: sum(1 for r in rows if r["status"] == s) for s in ("ok", "warn", "fail")}


def result(ctx, rows, fixed=None):
    c = counts(rows)
    res = {"schema": SCHEMA, "at": int(ctx.clock()), "host": socket.gethostname(), "ok": c["fail"] == 0, "counts": c, "checks": rows}
    if fixed is not None:
        res["fixed"] = fixed
    return res


def fix_all(ctx, rows):
    """Run the fixer of every failing check that has one, then look again at the groups it touched.
    Returns (fixed, rows after)."""
    fixed, groups = [], set()
    for r in rows:
        fn = ctx.fixers.get(r["name"])
        if r["status"] == "ok" or not r["fixable"] or not fn:
            continue
        try:
            ok, message = fn()
        except Exception as e:  # noqa: BLE001
            ok, message = False, f"{type(e).__name__}: {str(e)[:200]}"
        fixed.append({"name": r["name"], "ok": bool(ok), "message": message})
        groups.add(ctx.groups.get(r["name"]))
    if not groups:
        return fixed, rows
    again = {gid: run_group(ctx, gid, dict(GROUPS)[gid]) for gid in groups if gid in dict(GROUPS)}
    out, seen = [], set()
    for r in rows:
        gid = ctx.groups.get(r["name"])
        if gid in again:
            if gid not in seen:
                out.extend(again[gid])
                seen.add(gid)
        else:
            out.append(r)
    return fixed, out


def text(res):
    lines = []
    width = max((len(r["name"]) for r in res["checks"]), default=0)
    for r in res["checks"]:
        lines.append(f"{r['status']:<5} {r['name']:<{width}}  {r['message']}")
        if r["status"] != "ok" and r.get("fix"):
            lines.append(f"{'':<5} {'':<{width}}  fix: {r['fix']}")
    c = res["counts"]
    lines.append(f"{c['ok']} ok, {c['warn']} warn, {c['fail']} fail")
    for f in res.get("fixed") or []:
        lines.append(("fixed " if f["ok"] else "could not fix ") + f"{f['name']}: {f['message']}")
    return "\n".join(lines)


def command(a):
    ctx = Ctx(_dispatch())
    rows = run_checks(ctx)
    fixed = None
    if getattr(a, "fix", False):
        fixed, rows = fix_all(ctx, rows)
    res = result(ctx, rows, fixed)
    print(json.dumps(res, ensure_ascii=False, indent=2) if getattr(a, "json", False) else text(res))
    sys.exit(0 if res["ok"] else 1)


def _dispatch():
    import dispatch
    return dispatch


# ---------------------------------------------------------------- the daily run inside chatd

def last_path(dispatch_dir):
    return os.path.join(dispatch_dir, LAST_FILE)


def last_run(dispatch_dir):
    try:
        with open(last_path(dispatch_dir), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def due(dispatch_dir, now=None):
    now = time.time() if now is None else now
    return now - float(last_run(dispatch_dir).get("at") or 0) >= DAILY_SECONDS


def daily(d, ctx=None, now=None):
    """Run every check (no fixing), keep the result in doctor-last.json and write one notification
    per failing check and day. Returns the notifications written."""
    import wake
    ctx = ctx or Ctx(d)
    rows = run_checks(ctx)
    res = result(ctx, rows)
    os.makedirs(ctx.dispatch_dir, exist_ok=True)
    import workers
    workers.write_json(last_path(ctx.dispatch_dir), res)
    day = datetime.date.fromtimestamp(now if now is not None else ctx.clock()).isoformat()
    made = []
    for r in rows:
        if r["status"] != "fail":
            continue
        line = f"doctor: {r['name']} {r['message']}" + (f". Fix: {r['fix']}" if r.get("fix") else "")
        n = wake.add_note(d, f"doctor:{r['name']}:{day}", line, event="doctor", source="doctor")
        if n:
            made.append(n)
    return made
