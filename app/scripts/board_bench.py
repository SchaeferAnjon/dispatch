#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Measure the task board under load, on a throwaway copy of a board (never the real one).

    board_bench.py agents --board big.tgz --n 10 --mode direct|service [--json out.json]
    board_bench.py views  --board big.tgz --rounds 5 --mode direct|service [--json out.json]

`--board` is a .tgz of a folder holding `.beads/` (make one with `bd export --all` on a real board,
`bd init` in an empty folder and `bd import`). Every run unpacks a fresh copy under /tmp, with its
own HOME and DISPATCH_DIR, so nothing touches ~/tasks or the person's chatd.

agents: N agents at once, each `dispatch begin`, then plan / log / log / plan / log / show, the way an
Agent reports its work. Prints each step's time, the wall time, how many bd processes were started,
the most bd and dispatch processes alive at one moment, CPU seconds, and checks every write landed.

views: what the Agents window asks when it refreshes its board views (Waiting for you, Tasks,
Projects), `--rounds` times, and how many bd processes that took.

--mode service starts `dispatch chatd run` in the copy first (the board service lives in it);
--mode direct runs without chatd, every read and write starting its own bd.
"""
import argparse
import json
import os
import resource
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(os.path.dirname(HERE), "cli", "dispatch.py")
REAL_BD = shutil.which("bd") or "/opt/homebrew/bin/bd"

VIEW_POLLS = [
    ["waiting", "--json"],                                  # Waiting for you: every 5 s
    ["task", "list", "--project", "bench", "--json"],       # Tasks tab: every 10 s while shown
    ["projects", "--sidebar", "--json"],                    # sessions grouped by project: every 60 s
    ["projects-view", "--json"],                            # Projects page: every 30 s while shown
]


def prepare(board_tgz):
    root = tempfile.mkdtemp(prefix="bb-", dir="/tmp")
    with tarfile.open(board_tgz) as t:
        t.extractall(root)
    board = next(os.path.join(root, d) for d in os.listdir(root) if os.path.isdir(os.path.join(root, d, ".beads")))
    home = os.path.join(root, "home")
    dd = os.path.join(home, "dd")
    shim = os.path.join(root, "shim")
    for p in (home, dd, shim):
        os.makedirs(p, exist_ok=True)
    log = os.path.join(root, "bd-spawns.log")
    with open(os.path.join(shim, "bd"), "w") as f:
        f.write("#!/bin/sh\necho \"$1\" >> %s\nexec %s \"$@\"\n" % (log, REAL_BD))
    os.chmod(os.path.join(shim, "bd"), 0o755)
    env = {
        "HOME": home, "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "BEADS_DIR": os.path.join(board, ".beads"), "DISPATCH_DIR": dd, "DISPATCH_IDE_BIN": shim,
        "PYTHONDONTWRITEBYTECODE": "1", "LANG": "en_US.UTF-8",
    }
    return {"root": root, "board": board, "env": env, "spawn_log": log}


def spawns(ctx):
    try:
        with open(ctx["spawn_log"]) as f:
            return [l.strip() for l in f]
    except OSError:
        return []


def start_chatd(ctx):
    log = open(os.path.join(ctx["root"], "chatd.log"), "a")
    p = subprocess.Popen([sys.executable, CLI, "chatd", "run"], env=ctx["env"], stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    reg = os.path.join(ctx["env"]["DISPATCH_DIR"], "chatd.json")
    end = time.time() + 30
    while time.time() < end:
        try:
            with open(reg) as f:
                r = json.load(f)
            if r.get("door") and r.get("board", {}).get("ready"):
                return p
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    return p


def stop(p):
    if p is None or p.poll() is not None:
        return
    p.send_signal(signal.SIGTERM)
    try:
        p.wait(30)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()


class Sampler:
    """How many bd and dispatch processes are alive, every 0.2 s (only this copy's: they carry its HOME)."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.peak_bd = self.peak_dispatch = 0
        self.sum_bd = self.sum_dispatch = self.n = 0
        self.stop = threading.Event()
        self.t = threading.Thread(target=self.run, daemon=True)

    def run(self):
        me = os.getpid()
        while not self.stop.is_set():
            out = subprocess.run(["ps", "-Ao", "pid=,ppid=,comm=,args="], capture_output=True, text=True).stdout
            rows = {}
            for line in out.splitlines():
                parts = line.split(None, 3)
                if len(parts) >= 3:
                    rows[int(parts[0])] = (int(parts[1]), parts[2], parts[3] if len(parts) > 3 else "")
            bd = dispatch = 0
            for pid, (ppid, comm, args) in rows.items():
                p, ours = ppid, False  # only this run's processes: they descend from this script
                for _ in range(12):
                    if p == me:
                        ours = True
                        break
                    if p not in rows:
                        break
                    p = rows[p][0]
                if not ours:
                    continue
                exe = os.path.basename((args.split() or [comm])[0])  # ps cuts comm at 16 characters
                if exe == "bd" and "send-metrics" not in args:
                    bd += 1
                elif "dispatch.py" in args and "chatd run" not in args:
                    dispatch += 1
            self.peak_bd = max(self.peak_bd, bd)
            self.peak_dispatch = max(self.peak_dispatch, dispatch)
            self.sum_bd += bd
            self.sum_dispatch += dispatch
            self.n += 1
            self.stop.wait(0.2)

    def __enter__(self):
        self.t.start()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        self.t.join()

    def summary(self):
        return {"peak_bd": self.peak_bd, "peak_dispatch": self.peak_dispatch,
                "mean_bd": round(self.sum_bd / max(self.n, 1), 1), "mean_dispatch": round(self.sum_dispatch / max(self.n, 1), 1)}


def run_cli(ctx, argv, env_extra=None, timeout=600):
    env = dict(ctx["env"], **(env_extra or {}))
    t = time.time()
    r = subprocess.run([sys.executable, CLI] + argv, env=env, capture_output=True, text=True, timeout=timeout,
                       cwd=ctx["board"])
    return r, time.time() - t


def agent(ctx, i, results):
    sid = str(uuid.uuid4())
    env = {"CLAUDE_CODE_SESSION_ID": sid, "BEADS_ACTOR": "claude-code"}
    steps = []
    r, dt = run_cli(ctx, ["begin", f"Bench agent {i}: load test", "-P", "bench", "-d",
                          f"Board load test agent {i}: begin, plan and log like a real Agent does", "--force", "--json"], env)
    steps.append(("begin", dt, r.returncode))
    try:
        tid = json.loads(r.stdout[r.stdout.find("{"):])["id"]
    except Exception:
        results[i] = {"steps": steps, "error": (r.stderr or r.stdout)[-400:]}
        return
    plan = None
    for k, argv in enumerate([
        ["task", "plan", tid, "--set", f"read the code {i};change it;check it"],
        ["log", tid, f"agent {i}: step one done"],
        ["log", tid, f"agent {i}: step two done"],
        ["task", "plan", tid, "--done", "1"],
        ["log", tid, f"agent {i}: step three done"],
        ["task", "show", tid, "--json"],
    ]):
        r, dt = run_cli(ctx, argv, env)
        steps.append((argv[0] if argv[0] != "task" else argv[1], dt, r.returncode))
        if r.returncode:
            steps[-1] += ((r.stderr or r.stdout)[-300:],)
    results[i] = {"id": tid, "steps": steps}


def check_writes(ctx, results):
    """Every comment and the plan of every agent is on the board (read with bd itself, no service)."""
    lost = []
    env = dict(ctx["env"], PATH="/opt/homebrew/bin:/usr/bin:/bin")
    for i, res in sorted(results.items()):
        tid = res.get("id")
        if not tid:
            lost.append(f"agent {i}: no task")
            continue
        o = subprocess.run([REAL_BD, "comments", tid, "--json"], env=env, capture_output=True, text=True).stdout
        texts = [c.get("text", "") for c in (json.loads(o or "[]") or [])]
        for k in ("one", "two", "three"):
            if not any(f"agent {i}: step {k} done" in t for t in texts):
                lost.append(f"agent {i}: log '{k}' missing")
        o = subprocess.run([REAL_BD, "show", tid, "--json"], env=env, capture_output=True, text=True).stdout
        d = json.loads(o)
        d = d[0] if isinstance(d, list) else d
        plan = (d.get("metadata") or {}).get("plan") or []
        if not plan or plan[0].get("state") != "done":
            lost.append(f"agent {i}: plan not updated ({plan})")
    return lost


def cmd_agents(a):
    ctx = prepare(a.board)
    chatd = start_chatd(ctx) if a.mode == "service" else None
    load0 = os.getloadavg()
    results = {}
    with Sampler(ctx) as s:
        t0 = time.time()
        threads = [threading.Thread(target=agent, args=(ctx, i, results)) for i in range(a.n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        wall = time.time() - t0
    load1 = os.getloadavg()
    lost = check_writes(ctx, results)
    stats = None
    if chatd is not None:
        r, _ = run_cli(ctx, ["board", "stats", "--json"])
        try:
            stats = json.loads(r.stdout)
        except ValueError:
            stats = r.stdout[-300:]
    stop(chatd)
    cpu = resource.getrusage(resource.RUSAGE_CHILDREN)
    per = {}
    errors = []
    for res in results.values():
        for st in res.get("steps", []):
            per.setdefault(st[0], []).append(st[1])
            if st[2]:
                errors.append(st)
        if res.get("error"):
            errors.append(res["error"])
    out = {
        "mode": a.mode, "agents": a.n, "wall_s": round(wall, 1),
        "steps": {k: {"n": len(v), "mean_s": round(sum(v) / len(v), 2), "max_s": round(max(v), 2)} for k, v in per.items()},
        "bd_started": len(spawns(ctx)), "processes": s.summary(),
        "cpu_s": round(cpu.ru_utime + cpu.ru_stime, 1), "load_before": round(load0[0], 1), "load_after": round(load1[0], 1),
        "lost_writes": lost, "errors": [str(e)[:300] for e in errors][:10], "service": stats,
    }
    finish(a, ctx, out)


def cmd_views(a):
    ctx = prepare(a.board)
    chatd = start_chatd(ctx) if a.mode == "service" else None
    rounds = []
    with Sampler(ctx) as s:
        for k in range(a.rounds):
            before = len(spawns(ctx))
            t = time.time()
            for argv in VIEW_POLLS:
                r, _ = run_cli(ctx, argv)
            rounds.append({"s": round(time.time() - t, 2), "bd": len(spawns(ctx)) - before})
    stop(chatd)
    cpu = resource.getrusage(resource.RUSAGE_CHILDREN)
    out = {"mode": a.mode, "rounds": rounds, "first_s": rounds[0]["s"],
           "later_mean_s": round(sum(r["s"] for r in rounds[1:]) / max(len(rounds) - 1, 1), 2),
           "bd_started": len(spawns(ctx)), "processes": s.summary(), "cpu_s": round(cpu.ru_utime + cpu.ru_stime, 1)}
    finish(a, ctx, out)


def finish(a, ctx, out):
    print(json.dumps(out, ensure_ascii=False, indent=1))
    if a.json:
        with open(a.json, "w") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
    if not a.keep:
        shutil.rmtree(ctx["root"], ignore_errors=True)
    else:
        print("kept", ctx["root"], file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="what", required=True)
    for name, fn in (("agents", cmd_agents), ("views", cmd_views)):
        s = sub.add_parser(name)
        s.add_argument("--board", required=True)
        s.add_argument("--mode", choices=("direct", "service"), default="direct")
        s.add_argument("--n", type=int, default=10)
        s.add_argument("--rounds", type=int, default=5)
        s.add_argument("--json")
        s.add_argument("--keep", action="store_true")
        s.set_defaults(fn=fn)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
