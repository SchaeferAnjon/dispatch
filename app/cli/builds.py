# -*- coding: utf-8 -*-
"""`dispatch build start | list | show | log | get | sign | install`: building and checking Dispatch IDE
as a service.

An Agent commits, then asks for a build of that commit of this repository (Dispatch IDE's source is in ide/ since
2026-10-07, so one commit says everything). Dispatch queues it on the Mac mini (or this Mac), builds it with
ide/remote-build.sh in its own checkouts (never a shared build directory, never uncommitted changes), runs the
requested end-to-end scenarios against the result (`dispatch ide instance` / `dispatch ide e2e`), and hangs the
result on the Agent's task as a deliverable of kind `build`. This is maintainer tooling with no built-in machines or
paths: DISPATCH_REPO names the checkout builds come from; a second build Mac exists only when DISPATCH_MINI (user@host)
and DISPATCH_MINI_REPO (its checkout) are set, otherwise every build runs on this Mac. Every result is keyed by the commit: <sha12>, with
-min for the minified package and -dev for a development build.

Two kinds of build:

  the full package  (default) Dispatch IDE.app, minutes; `get`, `sign` and `install` take it to this Mac.
  a development build (--dev) ide/vscode compiled in place in a tree that stays on the build machine
              (~/dispatch-builds/work/dev), only what changed since its previous build: seconds. Its app is that
              tree; its scenarios run there, and the tree stays on its commit until they are done.

Two sides:

  the caller  (`dispatch build …`, usually on the MacBook): resolves the refs, pushes the commits to the
              mini (refs/builds/<sha>), asks the build host to start, keeps a record per request in
              ~/.dispatch/state/builds/<request>.json and, when a task is given, a small watcher that
              attaches the result to the task when it is in (list / show do the same if the watcher died).
  the host    (`python3 builds.py host …`, on the machine that builds; shipped to the mini's
              ~/dispatch-builds/.service/ with every start): ~/dispatch-builds/<name>/ holds what
              ide/remote-build.sh writes (Dispatch IDE.app, build.log, status, info.json, pid) plus
              requests/<request>/ (request.json, scenarios/, e2e/, e2e.log, result.json, result.md).

Queue: remote-build.sh builds one at a time, first come first built (.queue/<epoch>-<pid> tickets); a
commit pair that is already built (its app still there) is reused, one that is building is joined.

Signing: mini builds are ad-hoc signed (an ssh session cannot use the keychain); `sign` re-signs the
fetched copy with the Developer ID and notarizes it on the MacBook (dispatch-ide's sign.sh), `install`
puts it into /Applications with dispatch-ide's install.sh.
"""
import argparse, fcntl, glob, json, os, re, shlex, shutil, signal, socket, subprocess, sys, time

D = None  # the dispatch module, bound by run(); None when this file runs as the build host

HOME = os.path.expanduser("~")
TAIL_LINES = 60
APP_NAME = "Dispatch IDE.app"
FINAL = ("ok", "failed")


def env(name, default):
    return os.environ.get(name) or default


NO_MINI = ("no build Mac set: DISPATCH_MINI=user@host names the second Mac that builds (with DISPATCH_MINI_REPO, its "
           "checkout of this repository); without one, build here with --on local")


def has_mini():
    return bool(os.environ.get("DISPATCH_MINI"))


def mini_addr():
    """The second build Mac (user@host). Maintainer tooling: there is no default, it has to be set."""
    if not has_mini():
        raise ValueError(NO_MINI)
    return os.environ["DISPATCH_MINI"]


def kanban_repo():
    """The checkout of this repository that builds come from (DISPATCH_REPO; no default)."""
    repo = os.environ.get("DISPATCH_REPO")
    if not repo:
        raise ValueError("set DISPATCH_REPO to your checkout of this repository (e.g. DISPATCH_REPO=$PWD in its root)")
    return os.path.expanduser(repo)


def ide_dir():
    """Dispatch IDE's source and build scripts: ide/ of this repository."""
    return os.path.join(kanban_repo(), "ide")


def builds_dir():
    return os.path.expanduser(env("DISPATCH_BUILDS_DIR", os.path.join(HOME, "dispatch-builds")))


def staging_dir():
    return os.path.expanduser(env("DISPATCH_BUILD_STAGING", os.path.join(ide_dir(), "staging")))


def state_dir():
    return os.path.expanduser(env("DISPATCH_BUILD_STATE", os.path.join(HOME, ".dispatch", "state", "builds")))


def remote_dir():
    """The builds directory on the mini, relative to its home (every remote command starts with cd ~)."""
    return env("DISPATCH_MINI_BUILDS_DIR", "dispatch-builds")


def remote_repo():
    """The checkout on the build Mac (DISPATCH_MINI_REPO; no default)."""
    repo = os.environ.get("DISPATCH_MINI_REPO")
    if not repo:
        raise ValueError("set DISPATCH_MINI_REPO to the build Mac's checkout of this repository (e.g. ~/Projects/dispatch)")
    return repo


def ssh_base():
    return shlex.split(env("DISPATCH_BUILD_SSH", "ssh")) + ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=30"]


def build_name(sha, mini=False, dev=False):
    return f"{sha[:12]}" + ("-min" if mini else "") + ("-dev" if dev else "")


def is_dev(name):
    return name.endswith("-dev")


def now():
    return int(time.time())


def dur(secs):
    if secs is None:
        return ""
    secs = int(secs)
    return f"{secs // 60}m{secs % 60:02d}s" if secs >= 60 else f"{secs}s"


def read(path, default=""):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return default


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def alive(pid):
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


# Terminal colour codes in a build log: stored on a task (deliverables), an embedded Dolt board hands
# them back as raw control characters and bd then cannot read the board at all (2026-10-01)
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def tail(path, n=TAIL_LINES):
    lines = ANSI.sub("", read(path)).splitlines()
    return "\n".join(lines[-n:])


class Locked:
    """An flock on a file: one process at a time in the block."""
    def __init__(self, path):
        self.path = path

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.f = open(self.path, "a")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def spawn(argv, log, env_extra=None):
    """A detached process (its own session, no terminal): it outlives this command and an ssh session."""
    os.makedirs(os.path.dirname(log), exist_ok=True)
    e = dict(os.environ, **(env_extra or {}))
    with open(log, "ab") as out, open(os.devnull, "rb") as nul:
        p = subprocess.Popen(argv, stdin=nul, stdout=out, stderr=subprocess.STDOUT, start_new_session=True, env=e, close_fds=True)
    p.returncode = 0  # never waited for: it is meant to outlive this process (and Popen would warn about it)
    return p.pid


def host_path():
    """PATH for the build host's own processes: a command run over ssh or from a launcher has a short one."""
    extra = [os.path.join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    parts = (os.environ.get("PATH") or "").split(":")
    return ":".join(parts + [p for p in extra if p not in parts])


# ================================================================ the build host

def queue(bdir):
    """Pids of the builds waiting for the lock, first in line first (remote-build.sh's .queue/ tickets)."""
    out = []
    for t in sorted(os.listdir(os.path.join(bdir, ".queue")) if os.path.isdir(os.path.join(bdir, ".queue")) else []):
        m = re.match(r"^(\d+)-(\d+)$", t)
        if m and alive(m.group(2)):
            out.append((int(m.group(1)), int(m.group(2))))
    return [pid for _, pid in sorted(out)]


def parse_status(text):
    """remote-build.sh's status file: "ok <secs>" | "failed <rc> [<secs>]" | "failed ? (why)"."""
    w = text.split()
    if not w:
        return None, None, None
    if w[0] == "ok":
        return "ok", None, int(w[1]) if len(w) > 1 and w[1].isdigit() else None
    rc = int(w[1]) if len(w) > 1 and w[1].lstrip("-").isdigit() else None
    return "failed", rc, int(w[2]) if len(w) > 2 and w[2].isdigit() else None


def build_state(bdir, name, q=None):
    """Where one build is: queued (with its place), building, ok, failed or none (never started)."""
    d = os.path.join(bdir, name)
    st = {"name": name, "dir": d, "state": "none", "position": None, "seconds": None, "rc": None,
          "app": os.path.join(d, APP_NAME) if os.path.isdir(os.path.join(d, APP_NAME)) else None}
    info = read_json(os.path.join(d, "info.json"))
    if info:
        st["info"] = info
    status = read(os.path.join(d, "status")).strip()
    pid = read(os.path.join(d, "pid")).strip()
    started = os.path.getmtime(os.path.join(d, "pid")) if os.path.exists(os.path.join(d, "pid")) else None
    st["started"] = int(started) if started else None
    if status:
        st["state"], st["rc"], st["seconds"] = parse_status(status)
        if st["state"] == "ok" and info.get("build_seconds") is not None:
            st["build_seconds"] = info.get("build_seconds")
        return st
    if pid and alive(pid):
        # development builds wait for their tree (.dev.lock, held by the request's job), full packages for the lock
        lk = os.path.join(bdir, ".dev.lock.name" if is_dev(name) else ".lock.name")
        holder = read(lk).strip()
        if holder == name:
            st["state"] = "building"
            st["building_since"] = int(os.path.getmtime(lk)) if os.path.exists(lk) else st["started"]
        else:
            st["state"] = "queued"
            q = queue(bdir) if q is None else q
            if int(pid) in q:
                st["position"] = q.index(int(pid)) + 1
        return st
    if os.path.exists(os.path.join(d, "build.log")):
        st["state"], st["rc"] = "failed", None
        st["gone"] = True  # the build process ended without writing a status
    return st


# remote-build.sh's "== <step>" lines, in the words the bottom bar uses for where a build stopped
STEPS = (("checkout", "checkout"), ("node_modules", "dependencies"), ("ide/build.sh", "build"), ("ide/dev.sh", "build"))


def failure_of(log, limit=4 << 20):
    """Where a failed build stopped and the last thing its log said: {"step": checkout | dependencies | build |
    start, "why": "<last line>"}. Reads at most the last `limit` bytes of the log."""
    try:
        with open(log, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - limit))
            text = f.read().decode("utf-8", "replace")
    except OSError:
        return {"step": "start", "why": ""}
    step, why = "start", ""
    for line in ANSI.sub("", text).splitlines():
        line = line.strip()
        if line.startswith("== FAILED"):
            break
        if line.startswith("== "):
            step = next((w for k, w in STEPS if line[3:].startswith(k)), step)
        elif line:
            why = line
    return {"step": step, "why": why[:200]}


def request_state(bdir, name, rid, bst=None):
    """One request on a build: its record, and its result once the job wrote it."""
    rd = os.path.join(bdir, name, "requests", rid)
    req = read_json(os.path.join(rd, "request.json"))
    res = read_json(os.path.join(rd, "result.json"))
    r = {"rid": rid, "request": req, "result": res or None}
    if res:
        r["state"] = res.get("state")
    else:
        bst = bst or build_state(bdir, name)
        phase = read(os.path.join(rd, "phase")).strip()
        job = read(os.path.join(rd, "job.pid")).strip()
        if job and not alive(job):
            r["state"] = "failed"
            r["gone"] = True
        elif phase == "e2e":
            r["state"] = "testing"
        else:
            r["state"] = bst["state"] if bst["state"] != "ok" else "testing"
    return r


def requests_of(bdir, name):
    rdir = os.path.join(bdir, name, "requests")
    return sorted(os.listdir(rdir)) if os.path.isdir(rdir) else []


def host_list(bdir):
    q = queue(bdir)
    rows = []
    for d in sorted(glob.glob(os.path.join(bdir, "*", "build.log")) + glob.glob(os.path.join(bdir, "*", "requests")), key=os.path.getmtime):
        name = os.path.basename(os.path.dirname(d))
        if any(r["name"] == name for r in rows):
            continue
        st = build_state(bdir, name, q)
        st["requests"] = [request_state(bdir, name, rid, st) for rid in requests_of(bdir, name)]
        log = os.path.join(bdir, name, "build.log")
        if st["state"] == "failed" and os.path.exists(log) and time.time() - os.path.getmtime(log) < 24 * 3600:
            st["log"] = log
            st["failure"] = dict(failure_of(log), step="stopped") if st.get("gone") else failure_of(log)
            st["commits"] = log_commits(log)
        rows.append(st)
    return {"host": socket.gethostname(), "dir": bdir, "builds": rows, "building": read(os.path.join(bdir, ".lock.name")).strip() or None,
            "queue": len(q), "free_disk": free_disk(bdir)}


def free_disk(path):
    try:
        u = shutil.disk_usage(path if os.path.exists(path) else HOME)
        return f"{u.free / 1e9:.0f} GB"
    except OSError:
        return ""


def host_show(bdir, name, rid=""):
    st = build_state(bdir, name)
    st["requests"] = [request_state(bdir, name, r, st) for r in requests_of(bdir, name) if not rid or r == rid]
    st["log"] = os.path.join(bdir, name, "build.log")
    st["commits"] = log_commits(st["log"])
    if st["state"] == "failed":
        st["tail"] = tail(st["log"])
    return st


def log_commits(log):
    """The commit line remote-build.sh starts its log with (sha and subject), as {"commit": …}; a build from before
    the IDE moved into this repository has a "dispatch-ide" and a "kanban" line."""
    out = {}
    for line in read(log).splitlines()[:6]:
        m = re.match(r"^(commit|dispatch-ide|kanban)\s+([0-9a-f]{40})\s*(.*)$", line)
        if m:
            out[m.group(1)] = {"sha": m.group(2), "subject": m.group(3).strip()}
    return out


def host_start(bdir, sha, rid, req, rb, mini=False, rebuild=False, dev=False, repo=""):
    """Queue a build of the commit (or reuse / join the one there is) and start this request's job. A development
    build is the job's own work: it waits for the dev tree, builds there and runs its scenarios before letting go."""
    name = build_name(sha, mini, dev)
    d = os.path.join(bdir, name)
    rd = os.path.join(d, "requests", rid)
    os.makedirs(rd, exist_ok=True)
    rb = os.path.abspath(rb)
    if not os.path.exists(rb):
        raise ValueError(f"no remote-build.sh at {rb}")
    repo = os.path.expanduser(repo or os.environ.get("DISPATCH_BUILD_REPO") or "")  # remote-build.sh refuses without one
    with Locked(os.path.join(bdir, ".service.lock")):
        st = build_state(bdir, name)
        reused = not dev and st["state"] == "ok" and st["app"] and not rebuild
        joined = not dev and st["state"] in ("queued", "building")
        if dev:
            # the tree moves on with the next development build: every request builds (only what changed) and
            # tests while it holds the tree
            for f in ("status", "info.json"):
                if os.path.exists(os.path.join(d, f)):
                    os.remove(os.path.join(d, f))
        elif not reused and not joined:
            argv = ["bash", rb, "--here", sha] + (["--min"] if mini else []) + (["--rebuild"] if rebuild else [])
            p = subprocess.run(argv, capture_output=True, text=True, timeout=120, cwd=HOME,
                               env=dict(os.environ, DISPATCH_BUILDS_DIR=bdir, DISPATCH_BUILD_REPO=repo, PATH=host_path()))
            got = re.search(r"^name: (\S+)", p.stdout, re.M)
            if p.returncode != 0 or not got:
                raise ValueError(f"remote-build.sh did not start the build: {(p.stderr or p.stdout).strip()[-600:]}")
            if got.group(1) != name:
                raise ValueError(f"remote-build.sh built {got.group(1)}, expected {name}")
            st = build_state(bdir, name)
        req = dict(req, rid=rid, name=name, commit=sha, kanban=sha, min=bool(mini), dev=bool(dev), rb=rb, repo=repo, host=socket.gethostname(),
                   created=now(), reused=bool(reused), joined=bool(joined))
        scen = os.path.join(rd, "scenarios")
        req["e2e"] = sorted(os.listdir(scen)) if os.path.isdir(scen) else []
        write_json(os.path.join(rd, "request.json"), req)
        me = os.path.abspath(__file__)
        pid = spawn([sys.executable, me, "host", "job", "--dir", bdir, "--name", name, "--rid", rid], os.path.join(rd, "job.log"),
                    {"PATH": host_path()})
        with open(os.path.join(rd, "job.pid"), "w") as f:
            f.write(str(pid))
        if dev:
            with open(os.path.join(d, "pid"), "w") as f:
                f.write(str(pid))
    st = build_state(bdir, name)
    return {"name": name, "rid": rid, "state": st["state"], "position": st["position"], "reused": bool(reused),
            "joined": bool(joined), "host": socket.gethostname(), "dir": d}


def e2e_checkout(bdir, rd, sha):
    """The CLI and e2e runner at exactly the commit this build was made from, under the request (<rd>/kanban/app).
    work/dispatch is shared and moves on with the next build, so it is only the source."""
    src = os.path.join(bdir, "work", "dispatch")
    if not (sha and rd and os.path.exists(os.path.join(src, ".git"))):
        return None
    dst = os.path.join(rd, "kanban")
    cli = os.path.join(dst, "app", "cli", "dispatch.py")
    if not os.path.exists(cli):
        os.makedirs(dst, exist_ok=True)
        # agent/: the skills the CLI ships (task-board, delivery-page …): without them Customizations' Built-in
        # group has none of Dispatch's own (the instance's CLI runs from this copy)
        paths = ["app/cli", "app/scripts"] + (["agent"] if subprocess.run(["git", "-C", src, "cat-file", "-e", f"{sha}:agent"], capture_output=True).returncode == 0 else [])
        arch = subprocess.run(["git", "-C", src, "archive", sha, *paths], capture_output=True)
        if arch.returncode != 0:
            return None
        if subprocess.run(["tar", "-x", "-C", dst], input=arch.stdout, capture_output=True).returncode != 0:
            return None
        nm = os.path.join(src, "app", "node_modules")
        if os.path.isdir(nm) and not os.path.exists(os.path.join(dst, "app", "node_modules")):
            os.symlink(nm, os.path.join(dst, "app", "node_modules"))
    ok = os.path.exists(cli) and os.path.exists(os.path.join(dst, "app", "scripts", "ide-e2e", "runner.mjs"))
    return cli if ok else None


def dispatch_bin(bdir=None, rd=None, sha=None, dev=False):
    b = os.environ.get("DISPATCH_BIN")
    if b:
        return shlex.split(b)
    if dev and bdir:
        # a development build: its own checkout's CLI and runner, which stay on its commit while the job holds the tree
        cli = os.path.join(bdir, "work", "dev", "app", "cli", "dispatch.py")
        if os.path.exists(cli):
            return [sys.executable or "python3", cli]
    # The kanban commit this build was made from: it has the e2e runner and matches the app under test.
    # A host's installed dispatch is a packaged copy without app/scripts/ide-e2e (the mini, 2026-10-01),
    # and work/dispatch has moved on when another build ran in between (2026-10-02).
    cli = e2e_checkout(bdir, rd, sha) if bdir else None
    if cli:
        return [sys.executable or "python3", cli]
    if bdir:
        cli = os.path.join(bdir, "work", "dispatch", "app", "cli", "dispatch.py")
        if os.path.exists(cli) and os.path.exists(os.path.join(bdir, "work", "dispatch", "app", "scripts", "ide-e2e", "runner.mjs")):
            return [sys.executable or "python3", cli]
    found = shutil.which("dispatch", path=host_path())
    return [found] if found else []


def e2e_available(dbin):
    """G's `dispatch ide instance` / `dispatch ide e2e` on this machine, or why not."""
    if not dbin:
        return "no dispatch command on this machine"
    for sub in (["ide", "e2e", "--help"], ["ide", "instance", "--help"]):
        try:
            p = subprocess.run(dbin + sub, capture_output=True, text=True, timeout=60, env=dict(os.environ, PATH=host_path()))
        except (OSError, subprocess.TimeoutExpired) as e:
            return f"{' '.join(sub[:2])}: {e}"
        if p.returncode != 0:
            return f"`dispatch {' '.join(sub[:-1])}` is not in this machine's dispatch yet (G's e2e commands)"
    return ""


def run_logged(argv, log, timeout, keep=False):
    """Run `argv` with its output appended to `log`; its exit code, with `keep` (code, output) too."""
    with open(log, "a", encoding="utf-8") as f:
        f.write(f"\n$ {' '.join(shlex.quote(x) for x in argv)}\n")
        f.flush()
        try:
            p = subprocess.run(argv, stdout=subprocess.PIPE if keep else f, stderr=subprocess.STDOUT, timeout=timeout,
                               env=dict(os.environ, PATH=host_path()), text=keep)
            if keep:
                f.write(p.stdout)
            return (p.returncode, p.stdout) if keep else p.returncode
        except subprocess.TimeoutExpired:
            f.write(f"timed out after {timeout}s\n")
            return (124, "") if keep else 124
        except OSError as e:
            f.write(f"{e}\n")
            return (127, "") if keep else 127


def last_json(text):
    for line in reversed((text or "").strip().splitlines()):
        try:
            v = json.loads(line)
        except ValueError:
            continue
        if isinstance(v, dict):
            return v
    return {}


def run_e2e(bdir, name, rid, app):
    """Every scenario of the request against this build, each in a new test instance started the way its meta asks
    (motion, tips, onboarding, what it needs; `dispatch ide e2e run --fresh`), one at a time on this machine:
    screenshots, steps.json and the annotated "where is what" image per scenario."""
    rd = os.path.join(bdir, name, "requests", rid)
    scen_dir = os.path.join(rd, "scenarios")
    files = sorted(glob.glob(os.path.join(scen_dir, "*")))
    if not files:
        return None
    req = read_json(os.path.join(rd, "request.json")) or {}
    dbin = dispatch_bin(bdir, rd, req.get("kanban"), bool(req.get("dev")))
    why = e2e_available(dbin)
    if why:
        return {"state": "skipped", "reason": why, "runs": [{"scenario": os.path.basename(f), "status": "skipped"} for f in files]}
    log = os.path.join(rd, "e2e.log")
    inst = f"build-{rid[-6:]}"
    runs = []
    with Locked(os.path.join(bdir, ".e2e.lock")):
        for f in files:
            stem = re.sub(r"\.[a-z]+$", "", os.path.basename(f))
            out = os.path.join(rd, "e2e", stem)
            os.makedirs(out, exist_ok=True)
            # the runner keeps its own limit (meta.timeout); the instance stops when the scenario ends
            rc, text = run_logged(dbin + ["ide", "e2e", "run", f, "--fresh", "--app", app, "--instance", inst, "--out", out, "--json"], log, 3000, keep=True)
            res = last_json(text)
            # run annotates by itself when the scenario marked something; annotate is for a run that did not
            arc = 0 if res.get("status") == "skipped" or os.path.exists(os.path.join(out, "00-where-is-what.png")) else run_logged(dbin + ["ide", "e2e", "annotate", out], log, 300)
            runs.append(collect_run(os.path.basename(f), out, rc, arc, res))
    failed = [r for r in runs if r["status"] == "failed"]
    res = {"state": "failed" if failed else "ok", "runs": runs, "log": log}
    if failed:
        res["tail"] = tail(log)
    return res


def collect_run(scenario, out, rc, annotate_rc, res=None):
    """One scenario's result: ok (passed, or partial with what it did not test), skipped (with why) or failed."""
    shots = sorted(p for p in glob.glob(os.path.join(out, "**", "*.png"), recursive=True))
    annotated = next((p for p in shots if os.path.basename(p) == "00-where-is-what.png"), None)
    readme = os.path.join(out, "README.md")
    said = (res or {}).get("status")
    status = "skipped" if rc == 0 and said == "skipped" else "ok" if rc == 0 else "failed"
    extra = {"reason": res.get("reason") or res.get("error") or ""} if said in ("skipped", "partial", "failed") else {}
    return {"scenario": scenario, "status": status, "rc": rc, "dir": out, **extra,
            "shots": [p for p in shots if p != annotated], "annotated": annotated,
            "readme": readme if os.path.exists(readme) else None, "annotate_rc": annotate_rc}


def dev_build(bdir, name, req, log):
    """A development build in the dev tree, in the foreground (remote-build.sh --dev-run); the caller holds the tree."""
    rb = req.get("rb") or ""
    if not os.path.exists(rb):
        with open(os.path.join(bdir, name, "status"), "w") as f:
            f.write("failed 127 0\n")
        return
    with open(log, "a", encoding="utf-8") as out:
        subprocess.run(["bash", rb, "--dev-run", req.get("commit") or req.get("kanban") or "", name], stdout=out, stderr=subprocess.STDOUT,
                       stdin=subprocess.DEVNULL, cwd=HOME,
                       env=dict(os.environ, DISPATCH_BUILDS_DIR=bdir, DISPATCH_BUILD_REPO=req.get("repo") or os.environ.get("DISPATCH_BUILD_REPO", ""), PATH=host_path()))


def host_job(bdir, name, rid, poll=None):
    """Wait for the build (a development build: hold the dev tree and build it), run the request's scenarios,
    write result.json and result.md."""
    poll = poll or float(env("DISPATCH_BUILD_POLL", "5"))
    rd = os.path.join(bdir, name, "requests", rid)
    req = read_json(os.path.join(rd, "request.json"))
    t0 = req.get("created") or now()
    phase = os.path.join(rd, "phase")
    with open(phase, "w") as f:
        f.write("build")
    if req.get("dev"):
        held = os.path.join(bdir, ".dev.lock.name")
        with Locked(os.path.join(bdir, ".dev.lock")):
            with open(held, "w") as f:
                f.write(name + "\n")
            try:
                dev_build(bdir, name, req, os.path.join(rd, "job.log"))
                res = finish_job(bdir, name, rid, req, t0, phase)
            finally:
                if read(held).strip() == name:
                    os.remove(held)
        return res
    while True:
        st = build_state(bdir, name)
        if st["state"] in FINAL or st["state"] == "none":
            break
        time.sleep(poll)
    return finish_job(bdir, name, rid, req, t0, phase)


def finish_job(bdir, name, rid, req, t0, phase):
    rd = os.path.join(bdir, name, "requests", rid)
    st = build_state(bdir, name)
    log = os.path.join(bdir, name, "build.log")
    info = st.get("info") or {}
    res = {"rid": rid, "name": name, "commit": req.get("commit") or req.get("kanban"), "kanban": req.get("kanban"), "ide": req.get("ide"),
           "dev": bool(req.get("dev")), "host": socket.gethostname(), "dir": os.path.join(bdir, name), "log": log, "reused": req.get("reused", False),
           "build_seconds": info.get("build_seconds", st.get("seconds")), "commits": log_commits(log)}
    app = info.get("app") if req.get("dev") else st.get("app")
    if st["state"] != "ok":
        res.update(state="failed", stage="build", rc=st.get("rc"), tail=tail(log))
        if st.get("gone"):
            res["reason"] = "the build process ended without a status"
    elif not app or not os.path.isdir(app):
        res.update(state="failed", stage="build", reason="the build finished but its app is gone (pruned); build again with --rebuild")
    else:
        res.update(state="ok", app=app)
        with open(phase, "w") as f:
            f.write("e2e")
        e2e = run_e2e(bdir, name, rid, app)
        if e2e is not None:
            res["e2e"] = e2e
            if e2e["state"] == "failed":
                res.update(state="failed", stage="e2e", tail=e2e.get("tail", ""))
    res["seconds"] = now() - t0
    res["finished"] = now()
    write_json(os.path.join(rd, "result.json"), res)
    with open(os.path.join(rd, "result.md"), "w", encoding="utf-8") as f:
        f.write(result_md(res))
    with open(phase, "w") as f:
        f.write("done")
    return res


def result_md(res, app_hint=""):
    """The page a build deliverable opens: what was built, how it went, the log tail, the screenshots."""
    c = res.get("commits") or {}
    kind = "development build" if res.get("dev") else "build"
    lines = [f"# {kind.capitalize()} {res.get('name')}: {res.get('state')}", ""]
    if c.get("commit") or not res.get("ide"):
        lines.append(f"- commit `{(res.get('commit') or res.get('kanban') or '')[:12]}` {c.get('commit', {}).get('subject', '')}".rstrip())
    else:  # a build from before the IDE moved into this repository: a commit pair
        lines.append(f"- dispatch-ide `{(res.get('ide') or '')[:12]}` {c.get('dispatch-ide', {}).get('subject', '')}".rstrip())
        lines.append(f"- kanban `{(res.get('kanban') or '')[:12]}` {c.get('kanban', {}).get('subject', '')}".rstrip())
    lines.append(f"- on {res.get('host')}, {dur(res.get('seconds'))} in all" + (f", {kind} {dur(res.get('build_seconds'))}" if res.get("build_seconds") else "")
                 + (" (reused: this commit was built before)" if res.get("reused") else ""))
    if res.get("app"):
        lines.append(f"- app: `{res['app']}`" + (f" ({app_hint})" if app_hint else ""))
    lines.append(f"- log: `{res.get('log')}`")
    if res.get("reason"):
        lines.append(f"- {res['reason']}")
    e2e = res.get("e2e")
    if e2e:
        lines += ["", f"## End-to-end: {e2e.get('state')}"]
        if e2e.get("reason"):
            lines.append(e2e["reason"])
        for r in e2e.get("runs") or []:
            lines += ["", f"### {r['scenario']}: {r['status']}"]
            if r.get("annotated"):
                lines.append(f"![where is what]({r['annotated']})")
            for p in r.get("shots") or []:
                lines.append(f"![{os.path.basename(p)}]({p})")
    if res.get("tail"):
        lines += ["", f"## Last {TAIL_LINES} lines" + (" of the e2e log" if res.get("stage") == "e2e" else " of the build log"), "", "```", res["tail"], "```"]
    return "\n".join(lines) + "\n"


def host_log(bdir, name, follow=False, n=0):
    d = os.path.join(bdir, name)
    log = os.path.join(d, "build.log")
    if not os.path.exists(log):
        raise ValueError(f"no build {name} in {bdir}")
    if not follow:
        sys.stdout.write(tail(log, n) + "\n" if n else read(log))
        return 0
    pos = 0
    while True:
        with open(log, encoding="utf-8", errors="replace") as f:
            f.seek(pos)
            chunk = f.read()
            pos = f.tell()
        if chunk:
            sys.stdout.write(chunk)
            sys.stdout.flush()
        st = build_state(bdir, name)
        if st["state"] in FINAL or st["state"] == "none":
            with open(log, encoding="utf-8", errors="replace") as f:
                f.seek(pos)
                sys.stdout.write(f.read())
            print(f"status: {st['state']}" + (f" after {dur(st['seconds'])}" if st.get("seconds") else ""))
            return 0 if st["state"] == "ok" else 1
        time.sleep(2)


def host_main(argv):
    p = argparse.ArgumentParser(prog="builds.py host")
    p.add_argument("op", choices=["start", "list", "show", "log", "job"])
    p.add_argument("--dir", required=True)
    p.add_argument("--name", default="")
    p.add_argument("--rid", default="")
    p.add_argument("--commit", default="")
    p.add_argument("--rb", default="")
    p.add_argument("--repo", default="", help="start: the checkout on this machine to build from")
    p.add_argument("--req", default="{}")
    p.add_argument("--min", action="store_true")
    p.add_argument("--dev", action="store_true")
    p.add_argument("--rebuild", action="store_true")
    p.add_argument("--follow", action="store_true")
    p.add_argument("--tail", type=int, default=0)
    a = p.parse_args(argv)
    bdir = os.path.abspath(os.path.expanduser(a.dir))
    try:
        if a.op == "start":
            r = host_start(bdir, a.commit, a.rid, json.loads(a.req), os.path.expanduser(a.rb), a.min, a.rebuild, a.dev, a.repo)
        elif a.op == "list":
            r = host_list(bdir)
        elif a.op == "show":
            r = host_show(bdir, a.name, a.rid)
        elif a.op == "log":
            return host_log(bdir, a.name, a.follow, a.tail)
        else:
            host_job(bdir, a.name, a.rid)
            return 0
    except ValueError as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 1
    print(json.dumps(r, ensure_ascii=False))
    return 0


# ================================================================ the caller

def git(cwd, *args, timeout=30):
    try:
        p = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, "", str(e)


def common_dir(path):
    code, o, _ = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    return os.path.realpath(o) if code == 0 and o else ""


def resolve(repo, ref, cwd=None):
    """(sha, where it was resolved, note): in the folder the command runs in when that is a checkout of the
    same repository (an Agent's worktree: its HEAD, its branch), else in the repository itself."""
    cwd = cwd or os.getcwd()
    common = common_dir(repo)
    if not common:
        raise ValueError(f"no git repository at {repo}")
    where = cwd if common_dir(cwd) == common else repo
    code, sha, _ = git(where, "rev-parse", "--verify", "-q", f"{ref}^{{commit}}")
    if code != 0 or not sha:
        raise ValueError(f"no commit {ref} in {where}")
    note = ""
    if where == cwd and (ref in ("HEAD", "@") or git(where, "rev-parse", "--abbrev-ref", "HEAD")[1] == ref):
        code, dirty, _ = git(where, "status", "--porcelain", "--untracked-files=no")
        if code == 0 and dirty:
            note = f"uncommitted changes in {where} are not in this build (it builds commit {sha[:12]})"
    return sha, where, note


def self_is_mini():
    forced = os.environ.get("DISPATCH_BUILD_SELF")
    if forced:
        return forced == "mini"
    if not has_mini():
        return False
    ip = mini_addr().split("@")[-1]
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.bind((ip, 0))
            return True
        finally:
            s.close()
    except OSError:
        return False


def on_mini(cmd, timeout=60, check=True):
    """Run a shell command on the mini (in its home). (code, stdout, stderr)."""
    try:
        p = subprocess.run(ssh_base() + [mini_addr(), f"cd ~ && {cmd}"], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, "", f"ssh to {mini_addr()} timed out after {timeout}s"
    except OSError as e:
        return 127, "", str(e)
    return p.returncode, p.stdout, p.stderr


def mini_reachable():
    code, o, err = on_mini("echo ok", timeout=20)
    return (code == 0 and o.strip() == "ok"), (err.strip().splitlines() or ["no answer"])[-1]


def rsync(src, dst, *extra):
    argv = ["rsync", "-a", "-e", " ".join(shlex.quote(x) for x in ssh_base()), *extra, *src, dst]
    p = subprocess.run(argv, capture_output=True, text=True, timeout=1800)
    if p.returncode != 0:
        raise ValueError(f"rsync failed: {(p.stderr or p.stdout).strip()[-400:]}")


def service_py():
    return f"{remote_dir()}/.service/builds.py"


def ship_service():
    """This builds.py and this Mac's ide/remote-build.sh to the mini, so both sides speak the same version."""
    rb = os.path.join(ide_dir(), "remote-build.sh")
    code, _, err = on_mini(f"mkdir -p {shlex.quote(remote_dir() + '/.service')}", timeout=30)
    if code != 0:
        raise ValueError(f"the mini: {err.strip()}")
    rsync([os.path.abspath(__file__), rb], f"{mini_addr()}:{remote_dir()}/.service/")


def mini_host(op, *args, timeout=120):
    cmd = " ".join(["python3", shlex.quote(service_py()), "host", op, "--dir", shlex.quote(remote_dir())] + [shlex.quote(str(x)) for x in args])
    code, o, err = on_mini(cmd, timeout=timeout)
    if code != 0 and ("can't open file" in err or "No such file" in err):
        ship_service()
        code, o, err = on_mini(cmd, timeout=timeout)
    try:
        r = json.loads(o.strip().splitlines()[-1]) if o.strip() else None
    except ValueError:
        r = None
    if r is None:
        raise ValueError(f"the mini did not answer ({code}): {(err or o).strip()[-400:]}")
    if isinstance(r, dict) and r.get("ok") is False:
        raise ValueError(r.get("error") or "the mini refused")
    return r


def push_commits(sha):
    """The commit to the mini's repository as refs/builds/<sha> (never checked out there), and main to main when it
    fast-forwards (the mini's working copy follows; its `dispatch` runs from main)."""
    e = dict(os.environ, GIT_LFS_SKIP_PUSH="1", GIT_SSH_COMMAND=" ".join(shlex.quote(x) for x in ssh_base()))
    host = mini_addr()
    path = remote_repo()
    url = f"ssh://{host}/{path.lstrip('/')}" if not path.startswith("/") else f"ssh://{host}{path}"
    repo = kanban_repo()
    p = subprocess.run(["git", "-C", repo, "push", "-q", url, f"{sha}:refs/builds/{sha}"], capture_output=True, text=True, timeout=600, env=e)
    if p.returncode != 0:
        raise ValueError(f"could not push {sha[:12]} to the mini: {p.stderr.strip()[-400:]}")
    subprocess.run(["git", "-C", repo, "push", "-q", url, "main:main"], capture_output=True, text=True, timeout=600, env=e)


def new_rid():
    return time.strftime("%Y%m%d-%H%M%S") + f"-{os.getpid() % 100000:05d}"


def record_path(rid):
    return os.path.join(state_dir(), f"{rid}.json")


def records():
    out = []
    for p in sorted(glob.glob(os.path.join(state_dir(), "*.json"))):
        r = read_json(p)
        if r.get("rid") and r.get("name"):
            out.append(r)
    return out


def whoami():
    if D is not None and hasattr(D, "whoami"):
        return D.whoami()
    return os.environ.get("BEADS_ACTOR") or os.environ.get("DISPATCH_ACTOR") or os.path.basename(HOME.rstrip("/"))


def session_id():
    import engines
    for k in engines.session_env_names():
        if os.environ.get(k):
            return os.environ[k]
    return ""


LOCAL_MIN_FREE = int(os.environ.get("DISPATCH_LOCAL_BUILD_MIN_FREE", "45"))


def free_memory_percent():
    """macOS's own "memory free percentage" (memory_pressure -Q), or None where it cannot be read."""
    try:
        out = subprocess.run(["memory_pressure", "-Q"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.search(r"free percentage:\s*(\d+)%", out)
    return int(m.group(1)) if m else None


def this_host_label():
    return "mini" if self_is_mini() else "local"


def do_start(a):
    notes = []
    if getattr(a, "kanban", ""):
        raise ValueError("dispatch build start takes one commit now: Dispatch IDE's source is in this repository (ide/) "
                         "since 2026-10-07, so the commit names both. Drop --kanban.")
    if a.min and getattr(a, "dev", False):
        raise ValueError("--min is for the full package; a development build is never minified")
    sha, _, n1 = resolve(kanban_repo(), a.target or "main")
    if n1:
        notes.append(n1)
    dev = bool(getattr(a, "dev", False))
    scenarios = []
    for s in a.e2e or []:
        p = os.path.abspath(os.path.expanduser(s))
        if not os.path.isfile(p):
            raise ValueError(f"no scenario file {p}")
        scenarios.append(p)
    if a.task and D is not None:
        _tasks().show_issue(a.task)  # a typo fails now, not when the build is done
    target = a.on or ("mini" if has_mini() else "local")
    host = "local"
    if target == "mini" and not has_mini():
        raise ValueError(NO_MINI)
    if target == "mini" and not self_is_mini():
        ok, why = mini_reachable()
        if ok:
            host = "mini"
        else:
            notes.append(f"the mini is not reachable ({why}); building on this Mac instead")
    if host == "local" and not self_is_mini():
        free = free_memory_percent()
        if free is not None and free < LOCAL_MIN_FREE:
            raise ValueError(f"this Mac has {free}% memory free (needs {LOCAL_MIN_FREE}%): "
                             + ("build on the mini (--on mini). " if has_mini() else "close what you can and try again. ")
                             + 
                             "Several builds and type checks at once used up its memory and froze it on 2026-10-02.")
    rid = new_rid()
    name = build_name(sha, a.min, dev)
    req = {"ref": a.target or "main", "task": a.task or "", "by": whoami(), "session": session_id(), "from": socket.gethostname()}
    if host == "mini":
        push_commits(sha)
        ship_service()
        if scenarios:
            dst = f"{remote_dir()}/{name}/requests/{rid}/scenarios/"
            code, _, err = on_mini(f"mkdir -p {shlex.quote(dst)}", timeout=30)
            if code != 0:
                raise ValueError(err.strip())
            rsync(scenarios, f"{mini_addr()}:{dst}")
        r = mini_host("start", "--commit", sha, "--rid", rid, "--rb", f"{remote_dir()}/.service/remote-build.sh", "--repo", remote_repo(),
                      "--req", json.dumps(req, ensure_ascii=False), *(["--min"] if a.min else []), *(["--rebuild"] if a.rebuild else []),
                      *(["--dev"] if dev else []))
    else:
        bdir = builds_dir()
        if scenarios:
            dst = os.path.join(bdir, name, "requests", rid, "scenarios")
            os.makedirs(dst, exist_ok=True)
            for s in scenarios:
                shutil.copy2(s, dst)
        r = host_start(bdir, sha, rid, req, os.path.join(ide_dir(), "remote-build.sh"), a.min, a.rebuild, dev,
                       os.environ.get("DISPATCH_BUILD_REPO") or kanban_repo())
    rec = dict(req, rid=rid, name=name, host=host if host == "mini" else this_host_label(), commit=sha, kanban=sha, dev=dev,
               e2e=scenarios, created=now(), notes=notes, attached=False, dir=r.get("dir"))
    write_json(record_path(rid), rec)
    if a.task and D is not None:
        me = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py")
        spawn([sys.executable, me, "build", "_watch", rid], os.path.join(state_dir(), f"{rid}.watch.log"))
    out = dict(r, host=rec["host"], task=a.task or "", notes=notes, e2e=[os.path.basename(s) for s in scenarios])
    return out


def start_text(r):
    where = r["host"]
    st = r["state"]
    if r.get("reused"):
        st = "already built (reused)"
    elif st == "queued":
        st = f"queued, number {r['position']} in line" if r.get("position") else "queued"
    elif r.get("joined"):
        st += " (joined the build of the same commit)"
    lines = [f"{r['name']}", f"  {st} on {where}" + (f", request {r['rid']}" if r.get("rid") else "")]
    for n in r.get("notes") or []:
        lines.append(f"  note: {n}")
    if r.get("e2e"):
        lines.append(f"  then e2e: {', '.join(r['e2e'])}")
    if r.get("task"):
        lines.append(f"  the result goes on {r['task']} when it is in")
    lines.append(f"  follow: dispatch build log {r['name']} --follow    status: dispatch build show {r['name']}")
    return "\n".join(lines)


# ---------------------------------------------------------------- where a build is

def host_data(host, op, *args, timeout=120):
    if host == "mini" and not self_is_mini():
        return mini_host(op, *args, timeout=timeout)
    bdir = builds_dir()
    kw = dict(zip(args[::2], args[1::2]))
    if op == "list":
        return host_list(bdir)
    if op == "show":
        return host_show(bdir, kw["--name"], kw.get("--rid", ""))
    raise ValueError(op)


def all_builds(on=None):
    """{"rows": [build … with "host"], "notes": [...]} from this machine and (seen from elsewhere) the mini."""
    rows, notes = [], []
    here = this_host_label()
    if on in (None, "local", here) and (os.path.isdir(builds_dir())):
        for b in host_list(builds_dir())["builds"]:
            rows.append(dict(b, host=here))
    if here != "mini" and on in (None, "mini") and has_mini():
        try:
            for b in mini_host("list", timeout=60)["builds"]:
                rows.append(dict(b, host="mini"))
        except ValueError as e:
            notes.append(f"the mini: {e}")
    return {"rows": rows, "notes": notes}


def find(name, on=None):
    """(host, full name) of a build: the newest request made from here with that name (or prefix), else
    a build on this machine, else one on the mini."""
    if not name:
        raise ValueError("which build? (dispatch build list)")
    recs = [r for r in records() if r["name"].startswith(name) and (not on or r["host"] == on or (on == "local" and r["host"] == this_host_label()))]
    # the full package's own name wins over a development build of the same commit (<name>-dev), even a newer one
    recs = [r for r in recs if r["name"] == name] or recs
    if recs:
        r = max(recs, key=lambda r: r.get("created", 0))
        return r["host"], r["name"]
    here = this_host_label()
    if on in (None, "local", here):
        local = [os.path.basename(p) for p in glob.glob(os.path.join(builds_dir(), f"{name}*")) if os.path.isdir(p)]
        if len(local) == 1:
            return here, local[0]
        if len(local) > 1:
            raise ValueError(f"{name} matches {', '.join(sorted(local))}")
    if here != "mini" and on in (None, "mini") and has_mini():
        names = sorted({b["name"] for b in mini_host("list", timeout=60)["builds"] if b["name"].startswith(name)})
        if len(names) == 1:
            return "mini", names[0]
        if len(names) > 1:
            raise ValueError(f"{name} matches {', '.join(names)}")
    raise ValueError(f"no build {name}")


def state_word(b):
    st = b["state"]
    reqs = b.get("requests") or []
    if st == "ok" and any(r.get("state") == "testing" for r in reqs):
        st = "testing"
    if st == "ok" and reqs and reqs[-1].get("state") == "failed" and (reqs[-1].get("result") or {}).get("stage") == "e2e":
        st = "e2e failed"
    if st == "queued" and b.get("position"):
        return f"queued #{b['position']}"
    return st


def elapsed(b):
    if b["state"] == "building" and b.get("building_since"):
        return dur(now() - b["building_since"])
    if b["state"] == "queued" and b.get("started"):
        return f"waiting {dur(now() - b['started'])}"
    return dur(b.get("seconds"))


def list_text(r):
    lines = []
    if not r["rows"]:
        lines.append("No builds")
    for b in sorted(r["rows"], key=lambda b: b.get("started") or 0, reverse=True):
        reqs = b.get("requests") or []
        last = (reqs[-1].get("request") or {}) if reqs else {}
        refs = (last.get("ref") or (f"{last.get('ide_ref', '')} + {last.get('kanban_ref', '')}" if last.get("ide_ref") else "")) if last else ""
        who = last.get("by", "")
        tasks = ",".join(sorted({(x.get("request") or {}).get("task") for x in reqs if (x.get("request") or {}).get("task")}))
        lines.append(f"{b['name']:<30} {b['host']:<6} {state_word(b):<12} {elapsed(b):<14} {refs:<28} {who:<14} {tasks}".rstrip())
    for n in r.get("notes") or []:
        lines.append(f"note: {n}")
    return "\n".join(lines)


def show_text(b):
    c = b.get("commits") or {}
    lines = [f"{b['name']}  {state_word(b)} on {b['host']}" + (f"  {elapsed(b)}" if elapsed(b) else "")]
    for k in ("commit", "dispatch-ide", "kanban"):
        if k in c:
            lines.append(f"  {k:<12} {c[k]['sha'][:12]} {c[k]['subject']}")
    if b.get("app"):
        lines.append(f"  app: {b['app']}")
    lines.append(f"  log: {b.get('log')}")
    for rq in b.get("requests") or []:
        q = rq.get("request") or {}
        res = rq.get("result") or {}
        bits = [f"request {rq['rid']}: {rq.get('state')}", f"by {q.get('by') or '?'}"]
        if q.get("task"):
            bits.append(f"task {q['task']}")
        if q.get("e2e"):
            bits.append(f"e2e {', '.join(q['e2e'])}")
        lines.append("  " + ", ".join(bits))
        e2e = res.get("e2e") or {}
        if e2e.get("reason"):
            lines.append(f"    e2e {e2e.get('state')}: {e2e['reason']}")
        for run_ in e2e.get("runs") or []:
            lines.append(f"    {run_['scenario']}: {run_['status']}" + (f", where is what: {run_['annotated']}" if run_.get("annotated") else ""))
        if res.get("tail") and res.get("stage") == "e2e":
            lines += ["    last lines of the e2e log:"] + ["      " + l for l in res["tail"].splitlines()]
    if b.get("tail"):
        lines += [f"  last {TAIL_LINES} lines of the build log:"] + ["    " + l for l in b["tail"].splitlines()]
    for n in b.get("notes") or []:
        lines.append(f"note: {n}")
    return "\n".join(lines)


# ---------------------------------------------------------------- results onto the task

def _tasks():
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    import tasks_view
    if D is not None:
        tasks_view.D = D
    return tasks_view


def localize_result(res, host, name):
    """A result from the mini with its log and e2e files copied next to the fetched build (staging/<name>/)
    and its paths pointing there; the app stays on the mini until `dispatch build get`."""
    if host != "mini" or self_is_mini():
        return res, ""
    rid = res["rid"]
    local = os.path.join(staging_dir(), name)
    os.makedirs(os.path.join(local, "requests"), exist_ok=True)
    src = f"{mini_addr()}:{remote_dir()}/{name}/"
    rsync([src + "build.log", src + "status"], local + "/")
    try:
        rsync([src + "info.json"], local + "/")
    except ValueError:
        pass
    rsync([f"{src}requests/{rid}"], os.path.join(local, "requests") + "/")
    remote = res.get("dir") or ""
    text = json.dumps(res, ensure_ascii=False)
    if remote:
        text = text.replace(json.dumps(remote + "/")[1:-1], json.dumps(local + "/")[1:-1])
    out = json.loads(text)
    if res.get("app"):
        out["app"] = res["app"]  # still on the mini
        if not res.get("dev"):
            out["app_local"] = os.path.join(local, APP_NAME)
    out["dir"] = local
    if res.get("dev"):
        return out, "a development build stays on the mini, in its tree, until the next development build there"
    return out, f"on the mini; `dispatch build get {name}` copies it to {os.path.join(local, APP_NAME)}"


def deliverables_for(res, host):
    """The task's deliverables for one build result: the build itself (kind build) and each scenario's
    "where is what" image (kind file) so a click opens it."""
    c = res.get("commits") or {}
    ok = res.get("state") == "ok"
    what = (f"commit {(res.get('commit') or res.get('kanban') or '')[:7]}" if res.get("commit") or not res.get("ide")
            else f"dispatch-ide {(res.get('ide') or '')[:7]} + kanban {(res.get('kanban') or '')[:7]}")
    label = (f"{'Development build' if res.get('dev') else 'Build'} {'ok' if ok else 'failed' + (' in e2e' if res.get('stage') == 'e2e' else '')}: "
             f"{what} on {host}, {dur(res.get('seconds'))}")
    e2e = res.get("e2e") or {}
    if e2e:
        label += f", e2e {e2e.get('state')}"
    d = {"kind": "build", "ref": res["name"], "label": label, "status": res.get("state"), "host": host,
         "commit": res.get("commit") or res.get("kanban"), "kanban": res.get("kanban"), "dev": bool(res.get("dev")),
         "app": res.get("app") or "", "log": res.get("log") or "",
         "summary": res.get("summary") or "", "seconds": res.get("seconds")}
    if res.get("stage"):
        d["stage"] = res["stage"]
    if res.get("tail"):
        d["tail"] = res["tail"]
    if e2e:
        d["e2e"] = [{"scenario": r["scenario"], "status": r["status"], "shots": r.get("shots") or [], "annotated": r.get("annotated") or ""}
                    for r in e2e.get("runs") or []]
        if e2e.get("reason"):
            d["e2e_note"] = e2e["reason"]
    out = [d]
    for r in e2e.get("runs") or []:
        if r.get("annotated"):
            out.append({"kind": "file", "ref": r["annotated"], "label": f"Where is what: {r['scenario']} ({res['name'][:12]})"})
    return out


def attach(rec, res):
    """Put one finished request on its task (idempotent: the same build replaces its earlier entry)."""
    T = _tasks()
    host = rec["host"]
    res, hint = localize_result(res, host, rec["name"])
    summary_dir = os.path.join(res.get("dir") or "", "requests", res["rid"])
    os.makedirs(summary_dir, exist_ok=True)
    summary = os.path.join(summary_dir, "result.md")
    with open(summary, "w", encoding="utf-8") as f:
        f.write(result_md(res, hint))
    res["summary"] = summary
    issue = T.show_issue(rec["task"])
    items = T.clean_deliverables(T.meta(issue).get("deliverables"))
    t = now()
    for d in deliverables_for(res, host):
        d["at"] = t
        items = [x for x in items if not (x["kind"] == d["kind"] and x["ref"] == d["ref"])] + [d]
    T.set_meta(rec["task"], deliverables=items)
    rec.update(attached=True, attached_at=t, state=res.get("state"), summary=summary)
    write_json(record_path(rec["rid"]), rec)
    return res


def settle(rec, res=None):
    """Attach a finished request that has not been attached yet. True when it is (now) attached."""
    if rec.get("attached") or not rec.get("task"):
        return bool(rec.get("attached"))
    with Locked(record_path(rec["rid"]) + ".lock"):
        rec = read_json(record_path(rec["rid"])) or rec
        if rec.get("attached"):
            return True
        if res is None:
            b = host_data(rec["host"], "show", "--name", rec["name"], "--rid", rec["rid"])
            rq = next((x for x in b.get("requests") or [] if x["rid"] == rec["rid"]), None)
            res = (rq or {}).get("result")
        if not res:
            return False
        attach(rec, res)
        return True


def settle_all(rows):
    """list / show: attach what a watcher did not (it died, the Mac slept)."""
    done = {(b["host"], b["name"], rq["rid"]): rq.get("result") for b in rows for rq in b.get("requests") or [] if rq.get("result")}
    for rec in records():
        if rec.get("task") and not rec.get("attached"):
            res = done.get((rec["host"], rec["name"], rec["rid"]))
            if res:
                try:
                    settle(rec, res)
                except (ValueError, OSError) as e:
                    print(f"could not put {rec['name']} on {rec['task']}: {e}", file=sys.stderr)


def do_watch(rid, poll=15.0, limit=6 * 3600):
    rec = read_json(record_path(rid))
    if not rec:
        raise ValueError(f"no build request {rid}")
    t0 = time.time()
    while time.time() - t0 < limit:
        try:
            if settle(rec):
                print(f"{rec['name']} is on {rec['task']}")
                return 0
        except (ValueError, OSError) as e:
            print(f"{time.strftime('%H:%M:%S')} {e}", flush=True)  # the mini asleep, a dropped network: try again
        time.sleep(poll)
    print(f"gave up waiting for {rec['name']} after {limit}s")
    return 1


# ---------------------------------------------------------------- get, sign, install

def local_copy(host, name):
    return os.path.join(staging_dir() if host == "mini" and not self_is_mini() else builds_dir(), name)


LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"


def forget_app(app):
    """Take a build's copy of Dispatch IDE.app out of LaunchServices; the file stays and still starts by its path
    (test instances). Only the copy in /Applications stays registered, so the Dock and Spotlight never open an old
    build: on 10-09 a fresh install of 0.9.2 opened a backup from 10-01 (ide/launchservices.sh does the same)."""
    ls = env("DISPATCH_LSREGISTER", LSREGISTER)
    if not os.path.isdir(app) or not os.access(ls, os.X_OK):
        return False
    subprocess.run([ls, "-u", app], capture_output=True, timeout=60)  # not registered is fine as it is
    return True


def do_get(a):
    r = get_build(a)
    forget_app(r["app"])
    return r


def get_build(a):
    host, name = find(a.target, a.on)
    if is_dev(name):
        raise ValueError(f"{name} is a development build: it runs from its tree on the machine that built it (dispatch ide instance "
                         "start --app ~/dispatch-builds/work/dev/ide there). For an app to copy, sign and install, build the full package "
                         "(dispatch build start without --dev).")
    d = local_copy(host, name)
    app = os.path.join(d, APP_NAME)
    if host != "mini" or self_is_mini():
        if not os.path.isdir(app):
            raise ValueError(f"{name} has no app on this machine ({build_state(builds_dir(), name)['state']})")
        return {"name": name, "host": host, "app": app, "copied": False, "note": "built on this machine: nothing to copy"}
    # "fetched" is written once the whole copy is here: rsync brings `status` before the app's files, and a copy
    # cut off half way (the mini dropping off, 10-09) must not pass for a whole one
    if os.path.isdir(app) and os.path.exists(os.path.join(d, "fetched")) and read(os.path.join(d, "status")).startswith("ok"):
        return {"name": name, "host": host, "app": app, "copied": False, "note": "already here"}
    b = mini_host("show", "--name", name)
    if b["state"] != "ok" or not b.get("app"):
        raise ValueError(f"{name} on the mini is {b['state']}" + ("" if b["state"] != "ok" else " but its app was pruned: build it again with --rebuild"))
    os.makedirs(d, exist_ok=True)
    pruned = prune_staging(keep=name)
    rsync([f"{mini_addr()}:{remote_dir()}/{name}/"], d + "/", "--exclude", "requests/*/scenarios")
    write_json(os.path.join(d, "fetched"), {"at": int(time.time())})
    return {"name": name, "host": host, "app": app, "copied": True, "pruned": pruned}


STAGING_KEEP = int(os.environ.get("DISPATCH_BUILD_STAGING_KEEP", "6"))


def prune_staging(keep=None, limit=None):
    """Fetched copies of mini builds are about 3 GB each; keep the newest few with an app (and `keep`), drop
    the apps of older ones (their logs and e2e results stay). 2026-10-06: 80 GB of copies filled this Mac's disk."""
    limit = STAGING_KEEP if limit is None else limit
    root = staging_dir()
    try:
        names = [n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n, APP_NAME))]
    except OSError:
        return []
    names.sort(key=lambda n: os.path.getmtime(os.path.join(root, n)), reverse=True)
    old = [n for n in names[limit:] if n != keep and not os.path.exists(os.path.join(root, n, "signed.json"))]
    for n in old:
        shutil.rmtree(os.path.join(root, n, APP_NAME), ignore_errors=True)
    return old


def developer_id():
    try:
        o = subprocess.run(["security", "find-identity", "-v", "-p", "codesigning"], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""
    m = re.search(r'"(Developer ID Application: [^"]+)"', o)
    return m.group(1) if m else ""


def signature(app):
    try:
        o = subprocess.run(["codesign", "--display", "--verbose=4", app], capture_output=True, text=True, timeout=60).stderr
    except (OSError, subprocess.TimeoutExpired):
        return {}
    auth = re.search(r"^Authority=(.+)$", o, re.M)
    return {"adhoc": "Signature=adhoc" in o, "authority": auth.group(1) if auth else ""}


def do_sign(a):
    got = do_get(a)
    app, name = got["app"], got["name"]
    d = os.path.dirname(app)
    marker = os.path.join(d, "signed.json")
    notarize = not a.no_notarize
    prev = read_json(marker)
    sig = signature(app)
    signed = prev.get("signed") is True and sig.get("authority") == prev.get("identity") and not sig.get("adhoc")
    accepted = prev.get("notarized") is True and prev.get("notary_status") == "Accepted" and prev.get("notary_submission")
    if signed and not a.force and (not notarize or (accepted and prev.get("stapled") is True)):
        return {"name": name, "app": app, "skipped": True, **prev}
    ident = developer_id()
    if not ident:
        raise ValueError("no Developer ID Application certificate in this Mac's keychain: sign on the MacBook "
                         "(an ssh session cannot use the keychain)")
    sh_path = os.path.join(ide_dir(), "sign.sh")
    result_path = os.path.join(d, "notary-result.json")
    # Clear both records before mutating the app. An earlier ticket is not proof for the new bytes,
    # and a failed/older sign.sh must never inherit an Accepted result from an earlier attempt.
    write_json(result_path, {})
    info = {"identity": ident, "signed": False, "notarized": False, "stapled": False, "at": now(),
            "authority": "", "notary_status": "Not submitted" if notarize else "Not requested",
            "notary_submission": "", "notary_result": result_path}
    write_json(marker, info)
    # Notarization is best effort here: Apple slow or offline must not cost a signed local build
    # (audit 17). A signed, not notarized build installs and runs on this Mac; the next sign retries.
    e = dict(os.environ, DISPATCH_SIGNING_IDENTITY=ident, DISPATCH_NOTARIZE="1" if notarize else "0",
             DISPATCH_NOTARIZE_REQUIRED="0", DISPATCH_NOTARY_RESULT=result_path)
    print(f"signing {app} as {ident}" + (" and notarizing (a few minutes)" if notarize else ""), file=sys.stderr, flush=True)
    p = subprocess.run(["bash", sh_path, app], env=e, stdout=sys.stderr, stderr=sys.stderr)
    result = read_json(result_path)
    info.update(authority=signature(app).get("authority", ""), notary_status=result.get("status", info["notary_status"]),
                notary_submission=result.get("id", ""), stapled=result.get("stapled") is True)
    info["signed"] = result.get("signed") is True and info["authority"] == ident
    info["notarized"] = notarize and info["notary_status"] == "Accepted" and bool(info["notary_submission"])
    if result.get("log"):
        info["notary_log"] = result["log"]
    if not info["signed"]:
        write_json(marker, info)
        if p.returncode != 0:
            raise ValueError(f"sign.sh exited {p.returncode}; notarization {info['notary_status']}, "
                             f"submission {info['notary_submission'] or 'none'} (see {result_path})")
        raise ValueError(f"sign.sh did not confirm a Developer ID signature (see {result_path})")
    if notarize and (p.returncode != 0 or not info["notarized"] or not info["stapled"]):
        info["notary_warning"] = (f"signed, not notarized: notarization {info['notary_status']}, submission "
                                  f"{info['notary_submission'] or 'none'}{', not stapled' if info['notarized'] else ''}. "
                                  f"It installs and runs on this Mac; another Mac may show a Gatekeeper warning. "
                                  f"`dispatch build sign {name}` tries again (see {result_path})")
        print(info["notary_warning"], file=sys.stderr, flush=True)
    write_json(marker, info)
    forget_app(app)
    return {"name": name, "app": app, "skipped": False, **info}


def running_from(dst):
    """The app at `dst` is open. Launch Services knows the app itself; Dispatch's terminal daemon runs the same binary
    (ELECTRON_RUN_AS_NODE) and outlives ⌘Q, so a match on the binary alone never saw the app quit."""
    try:
        p = subprocess.run(["lsappinfo", "find", f"bundlepath={dst}"], capture_output=True, text=True, timeout=10)
        if p.returncode == 0:
            return bool(p.stdout.strip())
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        p = subprocess.run(["ps", "-axo", "args"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return any(line.startswith(f"{dst}/Contents/MacOS/") and ".cjs" not in line and ".js" not in line for line in p.stdout.splitlines())


def do_install(a):
    host, name = find(a.target, a.on)
    app = os.path.join(local_copy(host, name), APP_NAME)
    if not os.path.isdir(app):
        raise ValueError(f"{name} is not on this Mac yet: dispatch build get {name}, then dispatch build sign {name}")
    signed = read_json(os.path.join(os.path.dirname(app), "signed.json"))
    if (not signed or signed.get("signed") is False) and not a.unsigned:
        raise ValueError(f"{name} is not signed yet: dispatch build sign {name} (or --unsigned to install the ad-hoc build)")
    dst = os.environ.get("DISPATCH_IDE_DEST") or "/Applications/Dispatch IDE.app"
    if running_from(dst):
        if getattr(a, "when_quit", False):
            return schedule_install(name, dst, a)
        raise ValueError(f"Dispatch IDE is running from {dst}: quit it (⌘Q), then run dispatch build install {name} again "
                         f"(or dispatch build install {name} --when-quit: it goes in by itself once you quit)")
    inst = os.path.join(ide_dir(), "install.sh")
    if not os.path.exists(inst):
        raise ValueError(f"no {inst}: this checkout is from before Dispatch IDE moved into the repository (ide/, 2026-10-07)")
    p = subprocess.run(["bash", inst] + (["--no-open"] if a.no_open else []), env=dict(os.environ, DISPATCH_IDE_SRC=app),
                       stdout=sys.stderr, stderr=sys.stderr)
    if p.returncode != 0:
        raise ValueError(f"install.sh exited {p.returncode}")
    note = ""
    if signed and signed.get("signed") is not False and signed.get("notarized") is not True:
        note = f"signed but not notarized; `dispatch build sign {name}` retries notarization"
    return {"name": name, "app": app, "installed": dst, "signed": bool(signed), "note": note}


# ---------------------------------------------------------------- installed when the person quits (task-fuqs8)

INSTALL_WAIT_DAYS = 7


def pending_install_path():
    return os.path.join(builds_dir(), "install-on-quit.json")


def _install_flags(a):
    """The install's own choices, carried to the process that waits for the quit."""
    return (["--unsigned"] if getattr(a, "unsigned", False) else []) + (["--no-open"] if getattr(a, "no_open", False) else []) \
        + (["--on", a.on] if getattr(a, "on", None) else [])


def _is_waiter(pid):
    try:
        p = subprocess.run(["ps", "-o", "args=", "-p", str(int(pid))], capture_output=True, text=True, timeout=10)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False
    return "_installwait" in p.stdout


def schedule_install(name, dst, a=None):
    """Dispatch IDE is open: a process of its own waits for the person to quit it, then installs `name` and opens it
    again (and says so in a notification). A newer schedule replaces an older one: the latest build goes in."""
    path = pending_install_path()
    old = read_json(path) or {}
    # the older waiter, only when that pid is still it (a reused pid is someone else's process)
    if old.get("pid") and old.get("pid") != os.getpid() and _is_waiter(old["pid"]):
        try:
            os.kill(int(old["pid"]), signal.SIGTERM)
        except (OSError, ValueError):
            pass
    os.makedirs(builds_dir(), exist_ok=True)
    log = open(os.path.join(builds_dir(), "install-on-quit.log"), "ab")
    argv = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), "build", "_installwait", name] + _install_flags(a)
    p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
    write_json(path, {"name": name, "pid": p.pid, "dest": dst, "at": time.time()})
    return {"name": name, "installed": "", "scheduled": True, "pid": p.pid,
            "note": f"Dispatch IDE is open: {name} goes in by itself once you quit it (⌘Q), and opens again"}


def notify(title, text):
    try:
        # AppleScript reads a JSON string's escaped quotes and backslashes, not its \uXXXX escapes: the text goes as it is (⌘, Chinese)
        q = lambda x: json.dumps(x, ensure_ascii=False)
        subprocess.run(["osascript", "-e", f"display notification {q(text)} with title {q(title)}"], timeout=10, capture_output=True)
    except (OSError, subprocess.TimeoutExpired):
        pass


def do_install_wait(name, a=None, sleep=time.sleep, now=time.time):
    """The waiting side of schedule_install: until the person quits Dispatch IDE (a week at most), then the install.
    A newer schedule (another name in the file) means this one is no longer wanted."""
    dst = os.environ.get("DISPATCH_IDE_DEST") or "/Applications/Dispatch IDE.app"
    until = now() + INSTALL_WAIT_DAYS * 86400
    while running_from(dst):
        if now() > until or (read_json(pending_install_path()) or {}).get("name") != name:
            return 0
        sleep(2)
    if (read_json(pending_install_path()) or {}).get("name") != name:
        return 0
    sleep(2)  # the app's last processes let go of the bundle
    try:
        r = do_install(argparse.Namespace(target=name, on=getattr(a, "on", None), unsigned=getattr(a, "unsigned", False),
                                          no_open=getattr(a, "no_open", False), when_quit=False))
    except ValueError as e:
        notify("Dispatch IDE was not updated", str(e))
        print(f"install of {name} failed: {e}", file=sys.stderr)
        return 1
    finally:
        try:
            os.remove(pending_install_path())
        except OSError:
            pass
    notify("Dispatch IDE updated", f"{name} is installed and open" + (f" ({r['note']})" if r.get("note") else ""))
    print(f"installed {name} after the person quit")
    return 0


# ---------------------------------------------------------------- the queue at a glance (the Agents window's bottom bar)

QUEUE_DONE_FRESH = 120          # a build that finished this many seconds ago still shows as "built just now"
QUEUE_FAILED_FRESH = 2 * 3600   # a failure this recent still shows; older ones only count in "recent"
QUEUE_RECENT = 24 * 3600
QUEUE_DEFAULT_ESTIMATE = 8 * 60


def _last_request(b):
    reqs = b.get("requests") or []
    return (reqs[-1].get("request") or {}) if reqs else {}


def _finished_at(b):
    """When a build ended (epoch seconds), or None: its newest request's result, else its start plus its time."""
    ends = [(rq.get("result") or {}).get("finished") for rq in b.get("requests") or []]
    ends = [e for e in ends if isinstance(e, (int, float))]
    if ends:
        return max(ends)
    if b.get("started") and b.get("seconds") is not None:
        return b["started"] + b["seconds"]
    return None


def queue_label(b, titles=None):
    """What a person calls a build: its task's title, else the branch it was asked for, else its commits."""
    titles = titles or {}
    for rq in reversed(b.get("requests") or []):
        t = (rq.get("request") or {}).get("task")
        if t and titles.get(t):
            return titles[t]
    last = _last_request(b)
    ref = last.get("ref") or last.get("ide_ref") or ""
    if ref and not re.fullmatch(r"[0-9a-f]{7,40}", ref):
        return ref
    subject = ((b.get("commits") or {}).get("commit") or {}).get("subject") or ""
    return f"{b['name'].split('-')[0][:7]} · {subject}" if subject else b["name"].split("-")[0][:7]


def build_kind(b):
    """"yours" for a build someone will install (a full package; dispatch-update's builds have no request at all),
    "agents" for an agent's test build: a development build (-dev), or a package every request of which only asked
    for its end-to-end checks. The bottom bar stays quiet about the second kind (task-7ve7v)."""
    if is_dev(b["name"]):
        return "agents"
    reqs = [rq.get("request") or {} for rq in b.get("requests") or []]
    return "agents" if reqs and all(r.get("e2e") or r.get("dev") for r in reqs) else "yours"


def retry_command(b):
    """What builds it again: the same commit, from scratch (--rebuild), as a full package."""
    m = re.fullmatch(r"([0-9a-f]{12})(-min)?", b["name"])
    if not m:
        return ""
    return f"dispatch build start {m.group(1)} --rebuild" + (" --min" if m.group(2) else "")


def queue_summary(rows, now_=None, titles=None):
    """The build queue as the bottom bar shows it: what is building (with how far along, by the usual build
    time), what waits (first in line first), failures of the last two hours, builds that just finished, and how
    many built or failed today. Pure: rows are `all_builds()` rows."""
    t = now_ if now_ is not None else time.time()
    lists = {kind: {"building": [], "waiting": [], "failed": [], "done": [], "recent": {"built": 0, "failed": 0, "checks_failed": 0}}
             for kind in ("yours", "agents")}
    took = sorted((b.get("build_seconds") or b.get("seconds") or 0, _finished_at(b) or 0) for b in rows
                  if b.get("state") == "ok" and (b.get("build_seconds") or b.get("seconds")))
    # the usual time: the median of the last ten that built
    last10 = sorted(s for s, _ in sorted(took, key=lambda x: x[1])[-10:])
    estimate = last10[len(last10) // 2] if last10 else QUEUE_DEFAULT_ESTIMATE
    # a failure that was tried again since (same task, else same branch) is not news any more
    def key(b):
        last = _last_request(b)
        task = next(((rq.get("request") or {}).get("task") for rq in reversed(b.get("requests") or []) if (rq.get("request") or {}).get("task")), "")
        return task or last.get("ref") or last.get("ide_ref") or b["name"]
    newest = {}
    for b in rows:
        k = key(b)
        newest[k] = max(newest.get(k, 0), b.get("started") or 0)
    for b in rows:
        st = state_word(b)
        if st in ("failed", "e2e failed") and (b.get("started") or 0) < newest.get(key(b), 0):
            continue
        k = key(b)
        kind = build_kind(b)
        building, waiting, failed, done, recent = (lists[kind][x] for x in ("building", "waiting", "failed", "done", "recent"))
        base = {"name": b["name"], "host": b.get("host") or "local", "label": queue_label(b, titles), "task": k if k.startswith("task-") else "", "kind": kind}
        if b.get("state") == "building":
            since = b.get("building_since") or b.get("started") or t
            building.append(dict(base, stage="build", since=since, seconds=max(0, int(t - since)), estimate=int(estimate)))
            continue
        if st == "testing":
            building.append(dict(base, stage="checks", since=_finished_at(b) or t, seconds=0, estimate=int(estimate)))
            continue
        if b.get("state") == "queued":
            waiting.append(dict(base, position=b.get("position") or 999, waited=max(0, int(t - (b.get("started") or t)))))
            continue
        end = _finished_at(b)
        if end is None:
            continue
        age = t - end
        if st == "ok":
            if age <= QUEUE_RECENT:
                recent["built"] += 1
            if age <= QUEUE_DONE_FRESH:
                done.append(dict(base, ago=max(0, int(age))))
        elif st in ("failed", "e2e failed"):
            stage = "checks" if st == "e2e failed" else "build"
            if age <= QUEUE_RECENT:
                recent["checks_failed" if stage == "checks" else "failed"] += 1
            if age <= QUEUE_FAILED_FRESH:
                f = dict(base, stage=stage, ago=max(0, int(age)))
                if kind == "yours":
                    f.update(failure_details(b, stage))
                failed.append(f)
    for x in lists.values():
        x["building"].sort(key=lambda x: x["since"])
        x["waiting"].sort(key=lambda x: (x["host"] != "mini", x["position"], -x["waited"]))
        x["failed"].sort(key=lambda x: x["ago"])
        x["done"].sort(key=lambda x: x["ago"])
    # the top level is the person's own builds (what an older bottom bar shows); the agents' test builds apart
    return dict(lists["yours"], agents=lists["agents"], estimate=int(estimate), at=int(t))


def failure_details(b, stage):
    """For a failure the bottom bar tells the person about: the step it stopped at, the last line its log said,
    where the log is and what builds it again."""
    out = {"retry": retry_command(b)}
    if stage == "checks":
        res = next(((rq.get("result") or {}) for rq in reversed(b.get("requests") or []) if (rq.get("result") or {}).get("stage") == "e2e"), {})
        runs = (res.get("e2e") or {}).get("runs") or []
        out.update(step="checks", why=", ".join(r.get("scenario", "") for r in runs if r.get("status") == "failed")[:200],
                   log=(res.get("e2e") or {}).get("log") or res.get("log") or "")
    else:
        f = b.get("failure") or {}
        out.update(step=f.get("step") or "start", why=f.get("why") or "", log=b.get("log") or os.path.join(b.get("dir") or "", "build.log"))
    return out


def task_titles(ids):
    """{task id: title} for the builds' tasks, in one bd call; {} when the board does not answer."""
    ids = sorted({i for i in ids if i and re.fullmatch(r"[A-Za-z0-9._-]{1,64}", i)})
    if not ids:
        return {}
    try:
        p = subprocess.run(["bd", "show", *ids, "--json"], capture_output=True, text=True, timeout=15)
        data = json.loads(p.stdout[p.stdout.find("["):]) if "[" in p.stdout else []
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return {}
    return {x["id"]: x.get("title") or "" for x in data if isinstance(x, dict) and x.get("id")}


def build_service_used():
    """Whether this Mac uses the build service at all: it keeps builds (~/dispatch-builds), has started one (its
    records), or names a mini (DISPATCH_MINI). Someone who never built Dispatch has none of these: the bottom bar
    then has no Builds block, and its poll asks no one, not even the default mini over SSH."""
    return bool(os.environ.get("DISPATCH_MINI")) or os.path.isdir(builds_dir()) or bool(glob.glob(os.path.join(state_dir(), "*.json")))


def do_queue(a):
    if not build_service_used():
        out = queue_summary([])
        out["notes"] = []
        out["unused"] = True
        return out
    r = all_builds(a.on)
    ids = [(rq.get("request") or {}).get("task") for b in r["rows"] if b.get("state") in ("building", "queued") or (_finished_at(b) or 0) > time.time() - QUEUE_FAILED_FRESH
           for rq in b.get("requests") or []]
    out = queue_summary(r["rows"], titles=task_titles(ids))
    out["notes"] = r.get("notes") or []
    return out


def queue_text(q):
    lines = []
    for b in q["building"]:
        what = "checking" if b["stage"] == "checks" else f"building {dur(b['seconds'])} of about {dur(b['estimate'])}"
        lines.append(f"{b['host']:<6} {what:<32} {b['label']}")
    for b in q["waiting"]:
        lines.append(f"{b['host']:<6} {'waiting #' + str(b['position']) + ' · ' + dur(b['waited']):<32} {b['label']}")
    for b in q["failed"]:
        lines.append(f"{b['host']:<6} {('failed its checks' if b['stage'] == 'checks' else 'did not build') + ' · ' + dur(b['ago']) + ' ago':<32} {b['label']}")
        lines += [f"       {k}: {b[k]}" for k in ("step", "why", "log", "retry") if b.get(k)]
    for b in q["done"]:
        lines.append(f"{b['host']:<6} {'built just now':<32} {b['label']}")
    a = q.get("agents") or {}
    ab = [(b, "building") for b in a.get("building") or []] + [(b, "waiting") for b in a.get("waiting") or []] + \
         [(b, "failed its checks" if b["stage"] == "checks" else "did not build") for b in a.get("failed") or []]
    if ab:
        lines.append("agents' test builds:")
        lines += [f"  {b['host']:<6} {what:<30} {b['label']}" for b, what in ab]
    if not lines:
        lines.append("Nothing is building.")
    for n in q.get("notes") or []:
        lines.append(f"note: {n}")
    return "\n".join(lines)


# ---------------------------------------------------------------- the command

def emit(obj, as_json, text):
    if as_json:
        print(json.dumps(obj, ensure_ascii=False, indent=1))
    else:
        print(text(obj))
    return 0


def command(a):
    op = a.op
    if op == "start":
        return emit(do_start(a), a.json, start_text)
    if op == "list":
        r = all_builds(a.on)
        settle_all(r["rows"])
        return emit(r, a.json, list_text)
    if op == "queue":
        return emit(do_queue(a), a.json, queue_text)
    if op == "show":
        host, name = find(a.target, a.on)
        b = dict(host_data(host, "show", "--name", name), host=host)
        settle_all([b])
        return emit(b, a.json, show_text)
    if op == "log":
        host, name = find(a.target, a.on)
        if host == "mini" and not self_is_mini():
            ship_service()
            args_ = ["python3", shlex.quote(service_py()), "host", "log", "--dir", shlex.quote(remote_dir()), "--name", shlex.quote(name)]
            if a.follow:
                args_.append("--follow")
            if a.tail:
                args_ += ["--tail", str(a.tail)]
            argv = ssh_base() + [mini_addr(), "cd ~ && " + " ".join(args_)]
            try:
                return subprocess.run(argv).returncode
            except KeyboardInterrupt:
                print(f"\nstopped following; the build keeps going: dispatch build show {name}")
                return 130
        try:
            return host_log(builds_dir(), name, a.follow, a.tail)
        except KeyboardInterrupt:
            print(f"\nstopped following; the build keeps going: dispatch build show {name}")
            return 130
    if op == "get":
        return emit(do_get(a), a.json, lambda r: f"{r['app']}" + (f"  ({r['note']})" if r.get("note") else ""))
    if op == "sign":
        return emit(do_sign(a), a.json, lambda r: f"{'already signed' if r['skipped'] else 'signed'}: {r['app']} ({r['identity']}"
                    + (", notarized" if r.get("notarized") and r.get("stapled") else ", not notarized" if r.get("notary_warning") else "") + ")")
    if op == "install":
        return emit(do_install(a), a.json, lambda r: r["note"] if r.get("scheduled") else f"installed {r['name']} into {r['installed']}" + (f" ({r['note']})" if r.get("note") else ""))
    if op == "_installwait":
        return do_install_wait(a.target, a)
    if op == "_watch":
        return do_watch(a.target)
    raise ValueError(f"unknown op {op}")


def run(a, d_module=None):
    global D
    if d_module is not None:
        D = d_module
    try:
        return command(a)
    except ValueError as e:
        if getattr(a, "json", False):
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        else:
            print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "host":
        sys.exit(host_main(sys.argv[2:]))
    print("usage: builds.py host start|list|show|log|job --dir <builds dir> …  (the build host's side of dispatch build)", file=sys.stderr)
    sys.exit(2)
