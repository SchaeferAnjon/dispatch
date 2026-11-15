# -*- coding: utf-8 -*-
"""What a Dispatch IDE end-to-end scenario declares and the whole set run in one go
(`dispatch ide e2e run --fresh`, `dispatch ide e2e suite`).

A scenario says in its `meta` what it needs, so nobody has to read its comments to run it:

  meta.instance  how its test instance starts: {agents, onboarding: "fresh" | "terminal", seed: false, tips: true
                 (Getting started tips, off otherwise), motion: true (animations, off otherwise), fixture: "<fixtures/name.py>", env: {VAR: value}} (env is for
                 `instance start`, e.g. the onboarding fixture's switches)
  meta.env       variables for the scenario itself (stages, models); a variable already set by the caller wins
  meta.needs     what this Mac must have: "opencode", "codex", "claude", "gh", "internet", "other-mac",
                 "accessibility", "app-bundle" (the packaged app, not a development build), or "env:NAME" (a variable a person sets up by hand; meta.setup says how). One that
                 is missing turns the run into "skipped" with the reason and what to do about it; it is never a pass.

`suite` runs every scenario (or the ones named), each in a new test instance started the way it asks and
stopped right after, writes summary.json, summary.md and suite.log, and with --repeat N goes round N times; --lanes N
runs N instances side by side, a scenario with meta.exclusive (the Mac's clipboard, screen or pointer) alone.
"""
import sys

sys.dont_write_bytecode = True

import datetime
import json
import os
import shutil
import subprocess
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import ide_e2e as E  # noqa: E402

CLAUDE_OK = "DISPATCH_E2E_CLAUDE"  # Claude allowance is the dispatcher's (user 2026-09-29): a run spends it only when asked
OTHER_MAC = "DISPATCH_E2E_OTHER_MAC"  # user@host of a second Mac this one reaches over ssh with its own key
SUITE_INSTANCE = "suite"


def host_path(path=None):
    """PATH with the places agents and Homebrew live: a command run over ssh or by launchd has a short one."""
    home = os.path.expanduser("~")
    extra = [os.path.join(home, ".local", "bin"), os.path.join(home, ".opencode", "bin"), "/opt/homebrew/bin", "/usr/local/bin",
             "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    parts = [p for p in (path if path is not None else os.environ.get("PATH", "")).split(":") if p]
    return ":".join(parts + [p for p in extra if p not in parts])


def _ok(argv, timeout=30, env=None):
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                              env=dict(env or os.environ, PATH=host_path())).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _which(name):
    return shutil.which(name, path=host_path())


# Each check returns "" when the Mac has it, else why not and what to do. Plain words: they go in the report.
def _need_opencode():
    return "" if _which("opencode") else "OpenCode is not installed on this Mac (curl -fsSL https://opencode.ai/install | bash)"


def _need_codex():
    if not _which("codex"):
        return "Codex is not installed on this Mac (npm i -g @openai/codex)"
    return "" if _ok(["codex", "login", "status"]) else "Codex is not signed in on this Mac (codex login)"


def _need_claude():
    if os.environ.get(CLAUDE_OK) != "1":
        return "it sends real Claude Code messages, and the Claude allowance is kept for the dispatcher; set %s=1 to spend it" % CLAUDE_OK
    if not _which("claude"):
        return "Claude Code is not installed on this Mac"
    if os.environ.get(E.CLAUDE_TOKEN):
        # the instance's Claude Code runs on this token in its own config folder (ide_e2e.prepare_claude_home)
        # (checked in an empty config folder: the person's own login must not make a bad token look good)
        with tempfile.TemporaryDirectory(prefix="e2e-claude-") as tmp:
            env = dict(os.environ, CLAUDE_CODE_OAUTH_TOKEN=os.environ[E.CLAUDE_TOKEN], CLAUDE_CONFIG_DIR=tmp)
            ok = _ok(["claude", "auth", "status"], env=env)
        return "" if ok else "the Claude Code token in %s is not accepted (claude setup-token)" % E.CLAUDE_TOKEN
    return "" if _ok(["claude", "auth", "status"]) else "Claude Code is not signed in on this Mac (claude, then /login)"


def _need_gh():
    if not _which("gh"):
        return "GitHub's gh is not installed on this Mac (brew install gh)"
    return "" if _ok(["gh", "auth", "status"]) else "gh is not signed in to GitHub on this Mac (gh auth login)"


def _need_internet():
    return "" if _ok(["curl", "-sfI", "--max-time", "10", "https://github.com"], timeout=20) else "this Mac cannot reach github.com"


def _need_other_mac():
    target = os.environ.get(OTHER_MAC, "")
    if not target:
        return "it needs a second Mac: set %s=user@host to one this Mac reaches over ssh with its own key" % OTHER_MAC
    ok = _ok(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", target, "true"], timeout=30)
    return "" if ok else "the second Mac %s does not answer over ssh" % target


def _need_accessibility():
    # the person grants it in System Settings › Privacy & Security › Accessibility; only they can
    helper = shutil.which("osascript")
    if not helper:
        return "osascript is missing"
    ok = _ok(["osascript", "-e", 'tell application "System Events" to get name of first process'], timeout=20)
    return "" if ok else ("the app the test runs in has no Accessibility permission (System Settings › Privacy & Security › "
                          "Accessibility); only the person at this Mac can turn it on")


def _need_app_bundle(app):
    # Run on copies the server packed inside the app (build-server.sh) to the other Mac; a development build has none
    server = os.path.join(app or "", "Contents", "Resources", "app", "server")
    if app and os.path.isdir(server) and any(f.endswith("-darwin-arm64.tar.gz") for f in os.listdir(server)):
        return ""
    return ("it needs the packaged app with Dispatch IDE's server inside (a development build has none): "
            "dispatch build start <commit> without --dev, then run it on that build")


NEEDS = {"opencode": _need_opencode, "codex": _need_codex, "claude": _need_claude, "gh": _need_gh,
         "internet": _need_internet, "other-mac": _need_other_mac, "accessibility": _need_accessibility,
         "app-bundle": _need_app_bundle}
NEEDS_APP = {"app-bundle"}  # checks that look at the build itself


def unmet(needs, setup="", app=None):
    """[(need, why)] for the needs this Mac does not meet; an unknown name counts as unmet (a typo must not pass).
    `env:NAME` needs that variable set (what a person prepares by hand for the scenario; `setup` says how)."""
    out = []
    for n in needs or []:
        if n.startswith("env:"):
            var = n[4:]
            why = "" if os.environ.get(var) else "%s is not set%s" % (var, (": " + setup) if setup else "")
            if why:
                out.append((n, why))
            continue
        check = NEEDS.get(n)
        why = (check(app) if n in NEEDS_APP else check()) if check else "unknown need %r (known: %s, env:NAME)" % (n, ", ".join(sorted(NEEDS)))
        if why:
            out.append((n, why))
    return out


def node_binary(app=None):
    """Something that runs the runner as Node: the app's own Electron (ELECTRON_RUN_AS_NODE), else node."""
    app = app or E.default_app()
    if app and os.path.isfile(E.app_binary(app)):
        return E.app_binary(app)
    return _which("node") or ""


def read_meta(spath, app=None):
    """The scenario's `meta`, as the runner imports it ({} when it cannot be read)."""
    binary = node_binary(app)
    if not binary:
        return {}
    env = {k: v for k, v in os.environ.items() if not k.startswith(("VSCODE_", "ELECTRON_"))}
    env["ELECTRON_RUN_AS_NODE"] = "1"
    try:
        p = subprocess.run([binary, os.path.join(E.SCRIPTS, "runner.mjs"), "--print-meta", "--scenario", spath],
                           capture_output=True, text=True, timeout=60, env=env)
    except (OSError, subprocess.SubprocessError):
        return {}
    for line in reversed(p.stdout.strip().splitlines()):
        try:
            v = json.loads(line)
            return v if isinstance(v, dict) else {}
        except ValueError:
            continue
    return {}


def scenario_env(meta, base=None):
    """The scenario's own variables under the caller's: a variable the caller set wins."""
    env = dict(os.environ if base is None else base)
    for k, v in ((meta or {}).get("env") or {}).items():
        env.setdefault(str(k), str(v))
    return env


def start_args(name, inst, app):
    """`ide_e2e.py instance start` arguments for meta.instance."""
    argv = ["instance", "start", name, "--json"]
    if app:
        argv += ["--app", app]
    if inst.get("agents", True):
        argv.append("--agents")
    if inst.get("onboarding"):
        argv += ["--onboarding", str(inst["onboarding"])]
    if inst.get("seed") is False:
        argv.append("--no-seed")
    if inst.get("tips"):
        argv.append("--tips")
    if inst.get("motion"):
        argv.append("--motion")
    if inst.get("fixture"):
        argv += ["--fixture", str(inst["fixture"])]
    if inst.get("folder"):
        argv += ["--folder", str(inst["folder"])]
    return argv


def _cli(argv, env=None, timeout=600, log=None):
    """Run ide_e2e.py with these arguments; (exit code, its last JSON line or {}, the whole output)."""
    p = subprocess.run([sys.executable, os.path.join(HERE, "ide_e2e.py")] + argv, capture_output=True, text=True,
                       timeout=timeout, env=env)
    res = {}
    for line in reversed(p.stdout.strip().splitlines()):
        try:
            res = json.loads(line)
            break
        except ValueError:
            continue
    if log:
        log("$ ide_e2e.py %s -> %d" % (" ".join(argv), p.returncode))
        if p.returncode != 0 and p.stderr.strip():
            log(p.stderr.strip()[-1500:])
    return p.returncode, res, p.stdout + p.stderr


def leftovers(name):
    """Processes still working in the instance's folder (a helper the app started, a terminal, an agent)."""
    root = os.path.join(E.root_dir(), name) + "/"
    me = os.getpid()
    return [(pid, cmd) for pid, _, cmd in E.ps_rows() if root in cmd and pid != me]


def stop_and_wait(name, log, wait=45):
    """`instance stop`, then wait until nothing works in its folder any more: the next start clears that folder and
    refuses while something still runs there. What is left after `wait` seconds is stopped again and named."""
    _cli(["instance", "stop", name, "--json"], timeout=180, log=log)
    until = time.time() + wait
    while time.time() < until and leftovers(name):
        time.sleep(1)
    left = leftovers(name)
    if left:
        log("still running in the instance's folder after stop: " + "; ".join("%d %s" % (p, c[:160]) for p, c in left))
        _cli(["instance", "stop", name, "--json"], timeout=180, log=log)
        until = time.time() + 20
        while time.time() < until and leftovers(name):
            time.sleep(1)
    return leftovers(name)


# OpenCode Zen's free models, in the order a test takes them when this Mac has neither GLM 5.3 Flash nor DeepSeek's
# Flash: each one does tool work (an edit, a command); which of them answers changes by the hour (10-07: MiMo and Big
# Pickle stopped answering for a while, the Nemotrons took seconds)
FREE_MODELS = ("opencode/mimo-v2.6-flash-free", "opencode/nemotron-3.5-lightning-free", "opencode/nemotron-3-ultra-free",
               "opencode/big-pickle")
FREE_MODEL_TTL = 15 * 60
PONG_TIMEOUT = 45


def pong(model, timeout=PONG_TIMEOUT):
    """Whether OpenCode's `model` answers a one-word prompt in time, run in a throwaway home (nothing of the person's)."""
    oc = _which("opencode") or os.path.expanduser("~/.opencode/bin/opencode")
    if not os.path.exists(oc):
        return False
    tmp = tempfile.mkdtemp(prefix="e2e-pong-")
    env = {"HOME": tmp, "XDG_DATA_HOME": tmp + "/d", "XDG_CONFIG_HOME": tmp + "/c", "XDG_STATE_HOME": tmp + "/s",
           "XDG_CACHE_HOME": tmp + "/k", "PATH": host_path()}
    try:
        r = subprocess.run([oc, "run", "--model", model, "Reply with the word PONG only."], cwd=tmp, env=env,
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
        return "PONG" in (r.stdout or "")
    except (OSError, subprocess.SubprocessError):
        return False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def free_model(cache=None, now=None, ask=pong):
    """The free OpenCode model that answers now (FREE_MODELS in order), remembered for FREE_MODEL_TTL; None when this
    Mac has a paid cheap model (E.cheap_opencode_model picks it) or none of them answers."""
    if os.environ.get("DISPATCH_E2E_OPENCODE_MODEL") or E.cheap_opencode_model() not in FREE_MODELS:
        return None
    now = now or time.time()
    cache = cache or os.path.join(E.root_dir(), "_tools", "free-model.json")
    got = _read(cache)
    if got.get("model") in FREE_MODELS and now - float(got.get("at") or 0) < FREE_MODEL_TTL:
        return got["model"]
    for m in FREE_MODELS:
        if ask(m):
            os.makedirs(os.path.dirname(cache), exist_ok=True)
            with open(cache, "w", encoding="utf-8") as f:
                json.dump({"model": m, "at": now}, f)
            return m
    return None


def run_fresh(scenario, app=None, out="", timeout=300, name=SUITE_INSTANCE, log=None):
    """A new instance started the way the scenario asks, the scenario, and the instance stopped again.
    Returns {status: passed | failed | skipped | partial, …}."""
    log = log or (lambda *_: None)
    spath = E.scenario_path(scenario)
    stem = os.path.splitext(os.path.basename(spath))[0]
    app = os.path.abspath(os.path.expanduser(app)) if app else E.default_app()
    out = os.path.abspath(os.path.expanduser(out)) if out else os.path.join(E.runs_dir(), "%s-%s" % (stem, time.strftime("%Y%m%d-%H%M%S")))
    os.makedirs(out, exist_ok=True)
    t0 = time.time()
    meta = read_meta(spath, app)
    base = {"scenario": stem, "title": meta.get("title", ""), "out": out}
    missing = unmet(meta.get("needs"), meta.get("setup", ""), app)
    if missing:
        why = "; ".join("%s: %s" % m for m in missing)
        log("skip %s: %s" % (stem, why))
        return dict(base, status="skipped", reason=why, seconds=0)
    inst = meta.get("instance") or {}
    # a scenario that talks to OpenCode gets the free model that answers now (the instance's config and the menu pick)
    free = free_model() if "opencode" in (meta.get("needs") or []) else None
    if free:
        log("free model for %s: %s" % (stem, free))
    extra = {"DISPATCH_E2E_OPENCODE_MODEL": free} if free else {}
    start_env = dict(os.environ, PATH=host_path(), **extra)
    start_env.update({str(k): str(v) for k, v in (inst.get("env") or {}).items()})
    if leftovers(name):
        stop_and_wait(name, log)
    rc, started, text = _cli(start_args(name, inst, app), env=start_env, timeout=420, log=log)
    if rc != 0 or not started.get("ok"):
        stop_and_wait(name, log)
        return dict(base, status="failed", stage="instance start", error=(started.get("message") or text.strip()[-800:]),
                    seconds=round(time.time() - t0))
    try:
        env = scenario_env(meta, dict(os.environ, PATH=host_path(), **extra))
        lim = max(timeout, int(meta.get("timeout") or 0)) * max(1.0, float(os.environ.get("DISPATCH_E2E_TIME_SCALE") or 1))
        rc, res, text = _cli(["e2e", "run", spath, "--instance", name, "--out", out, "--timeout", str(timeout), "--json"],
                             env=env, timeout=int(lim) + 600, log=log)
    except subprocess.TimeoutExpired:
        rc, res, text = 1, {"error": {"message": "the run did not end in time"}}, ""
    finally:
        stop_and_wait(name, log)
    return dict(base, **verdict(rc, res, text, out), seconds=round(time.time() - t0))


def verdict(rc, res, text, out):
    """passed / partial / skipped / failed from `e2e run --json`, with where it stopped."""
    if res.get("skipped"):
        return {"status": "skipped", "reason": res["skipped"]}
    if rc == 0 and res.get("ok"):
        if res.get("partial"):
            p = res["partial"]
            return {"status": "partial", "reason": p.get("reason") or ", ".join(p.get("checks") or [])}
        return {"status": "passed", "steps": res.get("steps", 0)}
    err = res.get("error") or {}
    if isinstance(err, str):
        err = {"code": err, "message": res.get("message", "")}
    steps = _read(os.path.join(out, "steps.json")).get("steps") or []
    failed = next((s for s in reversed(steps) if s.get("ok") is False), None)
    return {"status": "failed", "error": err.get("message") or res.get("message") or text.strip()[-800:],
            "step": failed and {"i": failed.get("i"), "action": failed.get("action"), "target": failed.get("target")},
            "steps": len(steps), "shot": err.get("shot") and os.path.join(out, err["shot"])}


def _read(p):
    try:
        with open(p, encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def summary_md(doc):
    rows = doc.get("results") or []
    count = {}
    for r in rows:
        count[r["status"]] = count.get(r["status"], 0) + 1
    lines = ["# End-to-end suite", "", "app: %s" % doc.get("app"), "build: %s" % json.dumps(doc.get("build") or {}),
             "started %s, %s" % (doc.get("started"), "finished %s" % doc["finished"] if doc.get("finished") else "running"), "",
             "  ".join("%s %d" % (k, v) for k, v in sorted(count.items())), "", "| scenario | pass | status | seconds | where / why |", "|---|---|---|---|---|"]
    for r in rows:
        why = r.get("reason") or r.get("error") or ""
        if r.get("step"):
            why = "step %s %s %s: %s" % (r["step"].get("i"), r["step"].get("action"), json.dumps(r["step"].get("target"), ensure_ascii=False)[:80], why)
        lines.append("| %s | %s | %s | %s | %s |" % (r["scenario"], r.get("pass", 1), r["status"], r.get("seconds", ""), why.replace("|", "/").replace("\n", " ")[:300]))
    return "\n".join(lines) + "\n"


def suite(names=None, app=None, out="", repeat=1, timeout=300, log=print, lanes=1):
    """Every scenario (or `names`), each in its own new instance; `repeat` rounds, one after the other. With `lanes`, that
    many instances run side by side (suite, suite-2, …); a scenario whose meta says `exclusive: true` (it uses the Mac's
    clipboard, screen or pointer) runs alone after the others of its round. summary.json is written after each
    scenario, so a run cut short still says how far it got."""
    import queue
    import threading
    app = os.path.abspath(os.path.expanduser(app)) if app else E.default_app()
    if not app:
        raise E.E2EError("no_app", "没找到 Dispatch IDE.app（--app 指定）")
    names = list(names or [s["name"] for s in E.list_scenarios()])
    out = os.path.abspath(os.path.expanduser(out)) if out else os.path.join(E.runs_dir(), "suite-%s" % time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(out, exist_ok=True)
    logf = open(os.path.join(out, "suite.log"), "a", encoding="utf-8")
    lock = threading.RLock()

    def say(m):
        with lock:
            line = "%s %s" % (time.strftime("%H:%M:%S"), m)
            logf.write(line + "\n")
            logf.flush()
            log(line)

    alone = {n for n in names if read_meta(E.scenario_path(n), app).get("exclusive")}
    doc = {"app": app, "build": E.build_info(app), "scenarios": names, "repeat": repeat, "lanes": lanes, "exclusive": sorted(alone),
           "started": datetime.datetime.now().astimezone().isoformat(timespec="seconds"), "finished": None, "results": []}

    def save():
        with lock:
            doc["results"].sort(key=lambda r: (r.get("pass", 0), r["scenario"]))
            with open(os.path.join(out, "summary.json"), "w", encoding="utf-8") as f:
                json.dump(doc, f, ensure_ascii=False, indent=2)
            with open(os.path.join(out, "summary.md"), "w", encoding="utf-8") as f:
                f.write(summary_md(doc))

    def one(rnd, n, lane):
        say("pass %d/%d · %s (%s)" % (rnd, repeat, n, lane))
        try:
            r = run_fresh(n, app, os.path.join(out, "pass-%d" % rnd, n), timeout=timeout, name=lane, log=say)
        except E.E2EError as e:
            r = {"scenario": n, "status": "failed", "error": str(e)}
        r["pass"] = rnd
        say("  -> %s %s %s" % (n, r["status"], (r.get("reason") or r.get("error") or "")[:300]))
        with lock:
            doc["results"].append(r)
        save()

    def lane_names(k):
        return [SUITE_INSTANCE] + ["%s-%d" % (SUITE_INSTANCE, i) for i in range(2, k + 1)]

    try:
        for rnd in range(1, repeat + 1):
            todo = queue.Queue()
            for n in names:
                if n not in alone:
                    todo.put(n)

            def work(lane):
                while True:
                    try:
                        n = todo.get_nowait()
                    except queue.Empty:
                        return
                    one(rnd, n, lane)
            threads = [threading.Thread(target=work, args=(lane,), daemon=True) for lane in lane_names(max(1, lanes))]
            for t in threads:
                t.start()
                time.sleep(20)  # instances do not all start at once
            for t in threads:
                t.join()
            for n in names:
                if n in alone:
                    one(rnd, n, SUITE_INSTANCE)
    finally:
        doc["finished"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
        save()
        logf.close()
    bad = [r for r in doc["results"] if r["status"] in ("failed",)]
    return dict(doc, ok=not bad, out=out)
