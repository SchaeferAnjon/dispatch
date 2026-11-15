# -*- coding: utf-8 -*-
"""`dispatch busy`: is this Mac too busy, and with what. The Agents window's bottom bar shows "Busy" only then
(Dispatch IDE patches/120-status-bar.patch, kanban design/bars direction B: "Mac 太忙 · 底栏右，只在
吃紧时出现，带 Let idle agents sleep；平时不摆内存数字").

Busy means one of:
  - memory: macOS's own "memory free percentage" (memory_pressure -Q) under 20 %, where swapping starts to be felt;
  - the processors: the five-minute load above three times the number of cores (a minute's spike is not enough).
What uses it is said in words: how many agents run on this Mac (claude, codex, opencode and the other agents'
processes) and how many builds compile here. The numbers are in the answer for the panel, never on the bar.
"""
import json
from lang import t as _t
import os
import re
import subprocess

MEMORY_LOW = 20          # % free
LOAD_PER_CORE = 3.0      # five-minute load per core



def agent_names():
    """The processes that are agents: a command whose own name is one an engine is installed under (engines/: bins)."""
    import engines
    return {b for e in engines.known() for b in e.bins}


BUILD_MARKS = ("vscode-darwin", "vscode-reh")


def memory_free(run=subprocess.run):
    """% free as macOS reports it, or None."""
    try:
        out = run(["memory_pressure", "-Q"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.search(r"free percentage:\s*(\d+)%", out or "")
    return int(m.group(1)) if m else None


def load5():
    try:
        return round(os.getloadavg()[1], 1)
    except OSError:
        return None


def processes(run=subprocess.run):
    """(names, command lines) of every process: `ps -c` gives the executable's own name ("claude"), plain `ps` the
    whole command line; ([], []) when ps cannot be run."""
    def ps(*args):
        try:
            return (run(["ps", "-ax", *args], capture_output=True, text=True, timeout=10).stdout or "").splitlines()
        except (OSError, subprocess.TimeoutExpired):
            return []
    names = [x.strip() for x in ps("-c", "-o", "comm=") if x.strip()]
    lines = [x.strip() for x in ps("-o", "args=") if x.strip()]
    return names, lines


def count_users(names, lines):
    """How many agents and builds run here."""
    known = agent_names()
    agents = sum(1 for n in names if n in known)  # exact: "Claude" is the desktop app, "claude" the agent
    builds = sum(1 for line in lines if "gulp" in line and any(m in line for m in BUILD_MARKS))
    return agents, builds


def judge(free, load, cores):
    """('memory' | 'processors' | None): why the Mac counts as busy."""
    if free is not None and free < MEMORY_LOW:
        return "memory"
    if load is not None and cores and load > LOAD_PER_CORE * cores:
        return "processors"
    return None


def status(run=subprocess.run, cores=None):
    cores = cores or os.cpu_count() or 1
    free = memory_free(run)
    load = load5()
    agents, builds = count_users(*processes(run))
    why = judge(free, load, cores)
    return {"ok": True, "busy": why is not None, "why": why, "memory_free": free, "load": load, "cores": cores,
            "agents": agents, "builds": builds}


def run(a, d=None):
    r = status()
    if getattr(a, "json", False):
        print(json.dumps(r, ensure_ascii=False))
        return 0
    if not r["busy"]:
        print(_t("This Mac is not busy", "这台 Mac 不忙"))
    else:
        what = _t("memory is nearly full", "内存快用完了") if r["why"] == "memory" else _t("the processor cannot keep up", "处理器忙不过来")
        print(_t(f"This Mac is too busy: {what} ({r['agents']} agents and {r['builds']} builds running)", f"这台 Mac 太忙：{what}（{r['agents']} 个 Agent、{r['builds']} 个构建在跑）"))
    return 0
