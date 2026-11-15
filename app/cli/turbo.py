# -*- coding: utf-8 -*-
"""`dispatch turbo`: a big job split into parts that run at the same time, combined into one result at the end.

The person turns Turbo on in the Assistant, says the job, sees the plan (the parts, which ones run together, who
waits for whom, the files kept for the end, the time and the allowance), presses Start, and watches the Timeline tab
fill in. Everything lives in one file per run, DISPATCH_DIR/turbo/<run>/run.json, written under a lock by the commands
below and by one background runner per run.

  plan <job> [--cwd DIR] [--parts FILE|-]   a run in state "planning" (a model splits the job in the background) or,
                                            with --parts, "planned" right away
  replan <run> --at-a-time N                how many parts run at once; the time is worked out again
  start <run>                               copies are made, parts start, the runner follows them
  status [<run>] / list / timeline          what the Timeline tab draws (timeline: the Assistant's other agents too)
  step / ask                                what a part's agent calls: what it is doing now, a question for the person
  answer <run> <part> <text>                the person's answer; the part carries on
  add <run> <what>                          one more part, also while it runs
  pause / resume / cancel / keep / land     the person's buttons
  switch <run> --engine E [--model M]       stopped for the allowance: go on with another agent (the person's click)

Each part works in its own copy of the project (a git worktree on branch turbo/<run>/part-<n>, made from the combined
branch when the part starts, so it sees the parts combined before it). A finished part is merged into
turbo/<run>/combined; files several parts would change are kept for the end and changed once. Then the finals:
shared files, tests, a second check by another agent, and bringing the result into the branch the person works on.

Allowance (the person's rules for Turbo, 2026-10-01): no reserve of its own. It reads the allowance of the account in
use every minute; when the reading reaches 80% or the pace says the limit comes before the refill, it halves how many
parts run at once (once per allowance period, back to normal after the refill); 3% before the limit it stops cleanly:
running parts finish the step at hand, commit, write a handoff, and the run carries on after the refill.
OpenCode has no allowance reading (it runs on whichever provider the person set up: Zhipu, DeepSeek, …), so Turbo
reads what that provider answers instead (OpenCode's own error log, which each part writes next to its output): "too
many requests" (429, rate limit, Zhipu's 1302) halves how many parts run at once, again if it keeps saying so, and
the normal number comes back after 10 quiet minutes; "the balance or plan ran out" (Zhipu's 1113, insufficient
balance or quota) stops the parts cleanly, and Turbo tries again every 30 minutes unless the person goes on with
another agent. Switching to
another account happens only when the person clicks it (dispatch accounts use), and so does going on with another
agent (`switch`): the parts that stopped take their work so far with them, as a handoff, and the parts that start
after the first agent's refill go back to it.
"""
import sys

sys.dont_write_bytecode = True

import datetime
import json
import math
import os
import re
import shlex
import shutil
import signal
import subprocess
import time
import uuid

import dplatform as P
import engines as E

D = None  # the dispatch module, set by run()

RUNNING_S = 90           # a transcript written this recently: that session is working (as the Assistant's home says)
TICK = 5                 # seconds between the runner's looks at its parts
QUOTA_EVERY = 60         # seconds between allowance readings
SLOTS_DEFAULT = 4
SLOTS_MAX = 8
PACE_MIN, PACE_MAX = 0.1, 3.0  # what one minute of a split's estimate really took, as learned (learned_pace), kept within these
# before an agent has a run of its own to learn from: the splits' minutes ran 5 to 7 times the real time (task-npkp3: 46
# forecast, 8 taken; task-lj06.29: 22 forecast, 3 taken), so the first forecast takes them at 0.7 of their word
PACE_FIRST = 0.7
PARTS_MAX = 28
RATE_DEFAULT = 4.0 / 60  # % of a 5-hour allowance one agent uses in a minute (about 4% an hour, measured 2026-10-01)
SLOW_AT = 80             # % used: from here Turbo runs half as many parts at once
STOP_BEFORE = 3          # % before the limit: running parts stop at a clean point
MERGE_MIN = 0.5          # minutes a merge takes in the forecast (git merges in seconds; the runner looks every 5 s)
NEEDS_GUESS_MIN = 10     # minutes the forecast gives the person to answer
FINALS = (("shared", "Shared files", 8), ("tests", "Tests", 10), ("check", "Second check", 10), ("land", "Bring in", 1))
ACTIVE = ("planning", "planned", "running", "paused", "combining")
# An engine without an allowance reading (OpenCode): what its provider says, read from its error log (it retries these
# itself and says nothing on its output; its adapter's provider_errors picks the messages out)
PROVIDER_OUT = re.compile(r"余额不足|资源包|充值|insufficient[ _.-]?(balance|quota|credit)|exceeded your current quota|quota[ _.-]?exceeded|"
                          r"out of credit|payment required|billing|\b1113\b|\b402\b", re.I)
PROVIDER_RATE = re.compile(r"\b429\b|rate[ _.-]?limit|too many requests|\b1302\b|\b1305\b|并发|频繁|访问量过大|overloaded|"
                           r"tokens per min|requests per min|\bTPM\b|\bRPM\b", re.I)
RATE_AGAIN = 180         # seconds slowed down and still told "too many requests": half as many again
RATE_QUIET = 600         # seconds without "too many requests": back to the normal number of parts
OUT_RETRY = 1800         # seconds after "the balance ran out" before Turbo tries the provider again


def _name(engine):
    """Whose allowance the run uses, in words (Claude, ChatGPT · Codex); an unknown engine by its own name."""
    return E.get(engine).plan_name


RUN_ID = re.compile(r"^tb-[0-9]{4}-[0-9]{4}-[0-9a-f]{4}$")


class UserError(Exception):
    pass


# ---------------------------------------------------------------- store

def root():
    return os.path.join(D.DISPATCH_DIR, "turbo")


def run_dir(rid):
    if not RUN_ID.fullmatch(rid or ""):
        raise UserError("No Turbo run %r." % rid)
    return os.path.join(root(), rid)


def _write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.%s.tmp" % (path, uuid.uuid4().hex[:8])
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def load(rid):
    path = os.path.join(run_dir(rid), "run.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        raise UserError("No Turbo run %r." % rid)


def save(run):
    run["updated_at"] = time.time()
    _write_json(os.path.join(run_dir(run["id"]), "run.json"), run)


class locked:
    """The run's lock: every change to run.json happens inside one, short."""

    def __init__(self, rid):
        self.path = os.path.join(run_dir(rid), "run.lock")

    def __enter__(self):
        import fcntl
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.f = open(self.path, "a")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        import fcntl
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def change(rid, fn):
    """Load, change, save under the lock; returns what fn returns."""
    with locked(rid):
        run = load(rid)
        res = fn(run)
        save(run)
        return run if res is None else res


def run_ids():
    """Newest first, by when each run was made: two runs made in the same minute have ids that differ only in their
    random end, so the id alone does not say which came last (a plan dismissed and a new one made right after)."""
    try:
        names = [n for n in os.listdir(root()) if RUN_ID.fullmatch(n)]
    except OSError:
        return []

    def made(n):
        try:
            with open(os.path.join(root(), n, "run.json"), encoding="utf-8") as f:
                return float(json.load(f).get("created_at") or 0)
        except (OSError, ValueError, TypeError, AttributeError):
            return 0.0
    return sorted(names, key=lambda n: (made(n), n), reverse=True)


# ---------------------------------------------------------------- small helpers

def hm(epoch):
    return datetime.datetime.fromtimestamp(epoch).strftime("%H:%M") if epoch else ""


def parts_words(n):
    """"1 part", "3 parts" (the end of a run said "1 parts", task-lj06.29)."""
    return "%d %s" % (n, "part" if n == 1 else "parts")


def dur_words(minutes):
    m = max(0, int(round(minutes)))
    h, mm = divmod(m, 60)
    if h and mm:
        return "%d h %d min" % (h, mm)
    return "%d h" % h if h else "%d min" % mm


def ceil5(x):
    return int(math.ceil(max(0.0, x) / 5.0) * 5)


def event(run, kind, text, part=None, at=None):
    e = {"at": at or time.time(), "kind": kind, "text": text}
    if part is not None:
        e["part"] = part
    run.setdefault("events", []).append(e)
    del run["events"][:-200]


def seg(p, kind, now):
    """Extend the part's last stretch of `kind` to now, or start a new one."""
    segs = p.setdefault("segs", [])
    if segs and segs[-1][2] == kind and now - segs[-1][1] <= 3 * TICK + 30:
        segs[-1][1] = now
    else:
        if segs and segs[-1][2] != kind and now - segs[-1][1] <= 3 * TICK + 30:
            now0 = segs[-1][1]
        else:
            now0 = now
        segs.append([now0, now, kind])


def git(cwd, *args, timeout=60):
    try:
        r = subprocess.run(["git", "-C", cwd] + list(args), capture_output=True, text=True, timeout=timeout,
                           env=dict(os.environ, GIT_TERMINAL_PROMPT="0", LC_ALL="C"))
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, "", str(e)


def cli_cmd():
    return shlex.join([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py")])


def part_of(run, n):
    for p in run["parts"]:
        if p["n"] == n:
            return p
    raise UserError("This run has no part %s." % n)


def rate_of(run):
    return float(run.get("rate") or RATE_DEFAULT)


# ---------------------------------------------------------------- the parts a job splits into

SPLIT_PROMPT = """Split this job into parts that different agents can do at the same time, each in its own copy of this project ({cwd}).
Look at the project's files first, so each part names the files it will really change.

The job, in the person's own words:
\"\"\"{ask}\"\"\"

Rules:
- 1 to {most} parts. A part is work one agent finishes alone, at most about 90 minutes. A small job is one part.
- A part that has to see another part's result lists that part's number under "after"; keep these rare.
- Name each part in a few plain words, in the language the person wrote in. No jargon.
- "files": the files the part will change, relative to the project folder.
- "minutes": how long one agent really takes for the part, reading and checking included, with no padding. Agents are
  quick: a change of a line or two is 1 to 3 minutes, a small feature (a footer, a counter, a button, a form field) 3 to
  8, a feature across a few files 10 to 25, a large piece 30 to 90. When in doubt, the smaller number.

Reply with only this JSON and nothing else:
{{"title": "<the job in 3 to 8 words>", "parts": [{{"name": "...", "full": "<one sentence: what is true when this part is done>", "files": ["..."], "after": [], "minutes": 30}}]}}
"""


def parse_parts(text):
    """The JSON a model or the Assistant gave → (title, parts) checked and numbered; UserError when it is not usable."""
    obj = None
    if isinstance(text, dict):
        obj = text
    else:
        s = text or ""
        for m in reversed(list(re.finditer(r"\{", s))):
            try:
                cand = json.JSONDecoder().raw_decode(s[m.start():])[0]
            except ValueError:
                continue
            if isinstance(cand, dict) and isinstance(cand.get("parts"), list):
                obj = cand
                break
    if not obj or not isinstance(obj.get("parts"), list) or not obj["parts"]:
        raise UserError("The plan has no parts.")
    raw = obj["parts"][:PARTS_MAX]
    parts = []
    for i, r in enumerate(raw, 1):
        if not isinstance(r, dict):
            continue
        name = re.sub(r"\s+", " ", str(r.get("name") or "")).strip()[:80]
        if not name:
            continue
        files = [str(f).strip().lstrip("./")[:200] for f in (r.get("files") or []) if isinstance(f, str) and f.strip()][:20]
        try:
            minutes = int(round(float(r.get("minutes") or r.get("est") or 15)))
        except (TypeError, ValueError):
            minutes = 15
        after = []
        for x in r.get("after") or []:
            try:
                after.append(int(x))
            except (TypeError, ValueError):
                pass
        parts.append({"n": i, "name": name, "full": re.sub(r"\s+", " ", str(r.get("full") or name)).strip()[:400],
                      "files": list(dict.fromkeys(files)), "after": after, "est": max(2, min(240, minutes))})
    if not parts:
        raise UserError("The plan has no parts.")
    # renumber in order; "after" follows the renumbering and only points backwards (no cycles)
    old_to_new = {p["n"]: k for k, p in enumerate(parts, 1)}
    for k, p in enumerate(parts, 1):
        p["after"] = sorted({old_to_new[a] for a in p["after"] if a in old_to_new and old_to_new[a] < k})
        p["n"] = k
    title = re.sub(r"\s+", " ", str(obj.get("title") or "")).strip()[:80]
    return title, parts


def shared_files(parts):
    """Files more than one part would change: kept for the end and changed once, in the combined copy."""
    who = {}
    for p in parts:
        for f in p.get("files") or []:
            who.setdefault(f, []).append(p["n"])
    return [{"file": f, "parts": ns} for f, ns in sorted(who.items()) if len(ns) > 1]


# ---------------------------------------------------------------- the forecast: when each part runs, when it is done

def order_of(run):
    """Start order: parts others wait for first, then the long ones (the same rule as the plan shows)."""
    waited = {a for p in run["parts"] for a in p.get("after") or []}
    return [p["n"] for p in sorted(run["parts"], key=lambda p: (p["n"] not in waited, -p["est"], p["n"]))]


def pace_of(run):
    """How long this agent really took for a minute of estimate on the person's earlier runs (learned_pace), PACE_FIRST before any."""
    try:
        return min(PACE_MAX, max(PACE_MIN, float(run.get("pace") or PACE_FIRST)))
    except (TypeError, ValueError):
        return PACE_FIRST


def est_of(run, p):
    """The minutes the forecast gives a part: the split's estimate, times what this agent's earlier runs taught."""
    return max(1.0, p["est"] * pace_of(run))


def final_est(run, f):
    """The minutes the forecast gives a final step, sized to the job (task-npkp3: two one-line parts were forecast 29
    minutes of finals): no shared files, no shared-files step; tests and the second check take about a fifth of the
    parts' work each, 2 to 10 minutes; bringing the result in is a merge."""
    if f["id"] == "shared":
        return 0.0 if not run.get("shared") else min(f["est"], max(3.0, 2.0 * len(run["shared"])))
    if f["id"] == "land":
        return MERGE_MIN
    work = sum(est_of(run, p) for p in run["parts"])
    # a minute at least: a small job's tests and check took well under two each (task-lj06.29)
    return min(float(f["est"]), max(1.0, 0.15 * work))


def slots_now(run):
    s = int(run.get("slots") or SLOTS_DEFAULT)
    q = run.get("quota") or {}
    if q.get("slowed") and not run.get("hold_slots"):
        s = max(1, s // (2 ** max(1, int(q.get("halved") or 1))))
    return s


def forecast(run, now=None, slots=None):
    """When each part starts and ends, when the finals end, and the run is done; by simple list scheduling."""
    now = now or time.time()
    slots = slots or slots_now(run)
    q = run.get("quota") or {}
    hold_until = q.get("resume_at") if run.get("state") == "paused" and q.get("paused") else None
    if run.get("state") == "paused" and not hold_until:
        hold_until = now + 30 * 60  # paused by hand: the forecast assumes half an hour
    t0 = now if run.get("state") not in ("planned", "planning") else now
    ends, spans, merged_at = {}, {}, {}
    running = []
    for p in run["parts"]:
        st = p.get("status", "waiting")
        if st in ("combined", "skipped"):
            ends[p["n"]] = p.get("combined_at") or p.get("ended_at") or now
            merged_at[p["n"]] = ends[p["n"]]
            spans[p["n"]] = [p.get("started_at") or ends[p["n"]], ends[p["n"]]]
        elif st in ("working", "starting", "fixing", "done"):
            worked = sum(s[1] - s[0] for s in p.get("segs") or [] if s[2] in ("work", "fix")) / 60.0
            left = max(est_of(run, p) - worked, 0.15 * est_of(run, p), 1) if st != "done" else 0
            end = now + left * 60
            if hold_until and st != "done":
                end = max(end, hold_until + left * 60)
            running.append(end)
            ends[p["n"]] = end
            merged_at[p["n"]] = end + MERGE_MIN * 60
            spans[p["n"]] = [p.get("started_at") or now, end]
        elif st in ("needs", "paused"):
            worked = sum(s[1] - s[0] for s in p.get("segs") or [] if s[2] in ("work", "fix")) / 60.0
            left = max(est_of(run, p) - worked, 0.15 * est_of(run, p), 1)
            back = (hold_until or now) + (NEEDS_GUESS_MIN * 60 if st == "needs" else 0)
            ends[p["n"]] = back + left * 60
            merged_at[p["n"]] = ends[p["n"]] + MERGE_MIN * 60
            spans[p["n"]] = [p.get("started_at") or back, ends[p["n"]]]
            if st == "paused":
                running.append(ends[p["n"]])
    waiting = [n for n in order_of(run) if n not in ends]
    free_at = sorted(running)
    clock = max(t0, hold_until or 0)
    guard = 0
    while waiting and guard < 1000:
        guard += 1
        ready = [n for n in waiting if all(a in merged_at for a in part_of(run, n).get("after") or [])]
        if not ready:
            break
        n = ready[0]
        p = part_of(run, n)
        dep_ready = max([merged_at[a] for a in p.get("after") or []] or [clock])
        busy = sorted(free_at)
        if len(busy) >= slots:
            slot_free = busy[len(busy) - slots]
            busy_left = busy[:len(busy) - slots] + busy[len(busy) - slots + 1:]
        else:
            slot_free = clock
            busy_left = busy
        start = max(clock, dep_ready, slot_free)
        end = start + est_of(run, p) * 60
        spans[n] = [start, end]
        ends[n] = end
        merged_at[n] = end + MERGE_MIN * 60
        free_at = busy_left + [end]
        waiting.remove(n)
    parts_end = max(list(merged_at.values()) or [now])
    finals = {}
    t = max(parts_end, now)
    for f in run.get("finals") or []:
        if f["status"] in ("done", "skipped"):
            finals[f["id"]] = [f.get("started_at") or f.get("ended_at") or t, f.get("ended_at") or t]
            continue
        start = f.get("started_at") if f["status"] == "working" else t
        start = start or t
        end = max(now, start + final_est(run, f) * 60)
        finals[f["id"]] = [start, end]
        t = end
    return {"parts": {str(k): v for k, v in spans.items()}, "finals": finals, "done_at": t, "slots": slots}


def agent_minutes(run):
    return sum(est_of(run, p) for p in run["parts"]) + sum(final_est(run, f) for f in run.get("finals") or [] if f["id"] != "land")


def sequential_minutes(run):
    """One part after another: how long the same job takes without Turbo."""
    return agent_minutes(run) + MERGE_MIN * len(run["parts"])


def allowance_words(engine, pct):
    name = _name(engine)
    if not E.get(engine).accounts:
        return "%s's allowance is not readable, so Turbo cannot pace itself" % name
    if pct <= 100:
        return "About %d%% of a 5-hour %s allowance" % (max(5, pct), name)
    return "About %.1f of your 5-hour %s allowances" % (pct / 100.0, name)


def plan_view(run, now=None):
    """The numbers the plan shows, worked out again for the parts and the slots as they are now."""
    now = now or time.time()
    fc = forecast(run, now)
    pct = ceil5(rate_of(run) * agent_minutes(run))
    options = {}
    for k in ((2, 4, 6) if len(run["parts"]) > 1 else ()):  # one part runs alone: nothing to pick (task-lj06.29)
        if k <= SLOTS_MAX:
            options[str(k)] = forecast(dict(run, slots=k, quota={}), now, slots=k)["done_at"]
    return {"done_at": fc["done_at"], "done_words": "Done around %s" % hm(fc["done_at"]), "minutes": (fc["done_at"] - now) / 60.0,
            "sequential_minutes": sequential_minutes(run), "planned_pct": pct,
            "allowance": allowance_words(run.get("engine", ""), pct), "options": options, "forecast": fc}


# ---------------------------------------------------------------- allowance

def reading(engine, fake=""):
    """The allowance of the account in use for `engine`: {windows: [{kind, used_percent, resets_at}], used_percent,
    resets_at (the fullest window), at, account}, or None when it is not readable. It is the same reading as the
    title bar's usage and the account menu (`dispatch accounts status <engine>`).
    DISPATCH_TURBO_USAGE, or a run's own `usage_file` (`--usage-file`), names a JSON file with the same fields (test
    instances, and the person's own checks); a file with an "engine" field stands in for that agent only."""
    fake = fake or os.environ.get("DISPATCH_TURBO_USAGE")
    if fake and _fake_engine(fake) not in ("", engine):
        fake = ""
    if fake:
        try:
            with open(fake, encoding="utf-8") as f:
                d = json.load(f)
            wins = d.get("windows") or [{"kind": "session", "used_percent": d["used_percent"], "resets_at": d.get("resets_at")}]
            return _reading_of(wins, d.get("account") or "")
        except (OSError, ValueError, KeyError, TypeError):
            return None
    row = account_row(engine)
    if not row:
        return None
    wins = row.get("windows") or ([row["top"]] if row.get("top") else [])
    return _reading_of(wins, ((row.get("account") or {}).get("name") or ""))


def _fake_engine(path):
    try:
        with open(path, encoding="utf-8") as f:
            return str(json.load(f).get("engine") or "")
    except (OSError, ValueError, AttributeError):
        return ""


def account_row(engine):
    """`dispatch accounts status <engine>`'s row: signed in, the account in use, its windows; None when unknown."""
    qe = E.get(engine).id if E.get(engine).accounts else ""
    if not qe:
        return None
    try:
        r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"),
                            "accounts", "status", qe, "--json"], capture_output=True, text=True, timeout=45,
                           env=dict(D.child_env(), DISPATCH_DIR=D.DISPATCH_DIR) if D else None)
        rows = json.loads(r.stdout or "[]")
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    return next((x for x in rows if x.get("engine") == qe), None) if isinstance(rows, list) else None


def alternatives(run):
    """The other agents the stopped parts could go on with, best first: signed in with allowance left (Claude, Codex),
    or installed when the allowance is not readable here (OpenCode). Never the agent the run is on; the same agent's
    other accounts are the Timeline's own list (dispatch accounts)."""
    import engines
    c = config_load()
    out = []
    for eng in engines_ok():
        if eng == run.get("engine") or not engines.which(eng):
            continue
        model = c.get("model", "") if (c.get("engine") or "claude") == eng else ""
        row = {"engine": eng, "name": _name(eng), "model": model}
        if E.get(eng).accounts:
            own = run.get("usage_file") if _fake_engine(run.get("usage_file") or "") == eng else ""
            if own:
                rd = reading(eng, own)
            else:
                acct = account_row(eng)
                if not acct or not acct.get("signed_in") or (acct.get("account") or {}).get("needs_signin") or acct.get("level") == "out":
                    continue
                rd = _reading_of(acct.get("windows") or ([acct["top"]] if acct.get("top") else []), "")
            if rd is None:
                row["words"] = "%s: no usage numbers yet" % row["name"]
            elif rd["used_percent"] >= 100 - STOP_BEFORE:
                continue
            else:
                row["left"] = int(round(100 - rd["used_percent"]))
                row["words"] = "%d%% left%s" % (row["left"], (" until %s" % hm(rd["resets_at"])) if rd.get("resets_at") else "")
        else:
            row["words"] = "allowance not readable here"
        out.append(row)
    out.sort(key=lambda r: (r.get("left") is None, -(r.get("left") or 0)))
    return out


def handoff_text(run, p, old):
    """What a part that goes on with another agent is told: who started it, where its work is, its last words."""
    name = _name(old)
    last = _sentence(_read(os.path.join(os.path.dirname(p.get("log") or ""), "last-message.txt"), 4000)) if p.get("log") else ""
    last = last or last_activity(old, p.get("log")) or ""
    lines = ["%s started this part and stopped for its allowance before it finished; you carry it on." % name]
    if p.get("start_sha"):
        lines.append("Its work so far is committed in your copy: see git log %s..HEAD and the files there." % p["start_sha"][:12])
    if last:
        lines.append("Its last words: \"%s\"" % last[:300])
    lines.append("Check what is already done, then finish the part.")
    return " ".join(lines)


def switch_engine(run, engine, model, effort, now):
    """The person's click: the run goes on with another agent. Parts that started on the old one and are not finished
    lose their session (it belongs to the old agent) and start again from a handoff in their own copy; the parts
    that start after the old agent's refill go back to it."""
    old = run["engine"]
    q = run.get("quota") or {}
    for p in run["parts"]:
        if p.get("started_at") and p.get("status") in ("paused", "waiting", "needs", "failed") and (p.get("engine") or old) != engine:
            p["handoff"] = handoff_text(run, p, p.get("engine") or old)
            p["session"] = ""
            if p.get("status") == "paused":
                p["status"] = "waiting"
    back = q.get("resume_at") if q.get("paused") else None
    if old != engine and back and E.get(old).accounts:
        run["was"] = {"engine": old, "model": run.get("model") or "", "effort": run.get("effort") or "", "back_at": back}
    elif run.get("was", {}).get("engine") == engine:
        run.pop("was", None)
    stops = list(q.get("stops") or [])
    if q.get("paused") and q.get("paused_at"):
        stops.append([q["paused_at"], now])
    run.update(engine=engine, model=model, effort=effort, rate=learned_rate(engine))
    run["quota"] = {"stops": stops, "known": False}
    run.setdefault("switches", []).append({"at": now, "from": old, "to": engine, "model": model})
    run["state"] = "running"
    run["paused_by_hand"] = False
    left = sum(1 for p in run["parts"] if p.get("status") not in ("combined", "skipped", "cancelled"))
    event(run, "switched", "Going on with %s%s: %d part%s left%s" % (
        _name(engine), (" (%s)" % model.split("/")[-1]) if model else "", left, "" if left == 1 else "s",
        ("; parts that start after %s go back to %s" % (hm(back), _name(old))) if run.get("was") else ""))


def switch_back(run, now):
    """The first agent's allowance refilled: the parts that start from now go back to it (the ones at work keep theirs)."""
    was = run.pop("was")
    q = run.get("quota") or {}
    gone = run["engine"]
    run.update(engine=was["engine"], model=was.get("model") or "", effort=was.get("effort") or "", rate=learned_rate(was["engine"]))
    run["quota"] = {"stops": list(q.get("stops") or []), "known": False}
    run.setdefault("switches", []).append({"at": now, "from": gone, "to": was["engine"], "model": was.get("model") or "", "back": True})
    event(run, "switched", "%s refilled: the parts that start from now go back to it" % _name(was["engine"]))


def _reading_of(windows, account):
    now = time.time()
    wins = []
    for w in windows or []:
        try:
            used = float(w["used_percent"])
        except (KeyError, TypeError, ValueError):
            continue
        res = w.get("resets_at")
        if res and res < now - 60:
            continue  # a window that has already refilled says nothing about now
        wins.append({"kind": str(w.get("kind") or "session"), "used_percent": used, "resets_at": res})
    if not wins:
        return None
    top = max(wins, key=lambda w: w["used_percent"])
    return {"windows": wins, "used_percent": top["used_percent"], "resets_at": top["resets_at"], "kind": top["kind"],
            "at": now, "account": account}


def burn_per_min(points, running, rate, now=None):
    """% a minute: measured from the last 20 minutes of readings when there are enough, else the rate × parts running."""
    now = now or time.time()
    pts = [r for r in points or [] if r[0] >= now - 20 * 60]
    if len(pts) >= 2 and pts[-1][0] - pts[0][0] >= 5 * 60 and pts[-1][1] >= pts[0][1]:
        return (pts[-1][1] - pts[0][1]) / ((pts[-1][0] - pts[0][0]) / 60.0)
    return rate * max(0, running)


WINDOW_WORDS = {"session": "5-hour", "five_hour": "5-hour", "weekly": "weekly", "seven_day": "weekly", "weekly_model": "weekly"}


def govern(run, rd, now=None):
    """The allowance rules for one reading. Returns what changed: "", "slowed", "paused", "resumed", "restored".

    Turbo keeps no reserve of its own. Every window of the account counts (the 5-hour one and the weekly ones):
    at 80% of any of them, or when the pace says one of them fills before it refills (or before this run is done,
    whichever comes first), it runs half as many parts at once, once per allowance period; 3% before the limit of
    any window it stops cleanly and carries on when that window refills."""
    now = now or time.time()
    q = run.setdefault("quota", {})
    if not rd:
        q["known"] = False
        return ""
    q["known"] = True
    wins = rd.get("windows") or [{"kind": "session", "used_percent": rd["used_percent"], "resets_at": rd.get("resets_at")}]
    top = max(wins, key=lambda w: w["used_percent"])
    used, resets = float(top["used_percent"]), top.get("resets_at")
    q.update(used=used, resets_at=resets, window=top.get("kind") or "session", account=rd.get("account") or q.get("account") or "",
             read_at=rd.get("at") or now)
    series = q.setdefault("series", {})
    for w in wins:
        pts = series.setdefault(w["kind"], [])
        if pts and w["used_percent"] + 5 < pts[-1][1]:
            del pts[:]  # that window refilled
        pts.append([now, float(w["used_percent"]), w.get("resets_at")])
        del pts[:-120]
    # the line the band draws: the fullest window; what this run spent: the 5-hour window when there is one
    reads = q.setdefault("readings", [])
    reads.append([now, used])
    del reads[:-400]
    spend = next((w for w in wins if w["kind"] in ("session", "five_hour")), top)
    sp = q.setdefault("spend", [])
    if sp and spend["used_percent"] + 5 < sp[-1][1]:
        q["spent_before"] = q.get("spent_before", 0) + max(0, sp[-1][1] - q.get("period_start", sp[0][1]))
        q["period_start"] = spend["used_percent"]
    q.setdefault("period_start", spend["used_percent"])
    sp.append([now, float(spend["used_percent"])])
    del sp[:-400]
    q["peak"] = max(q.get("peak") or 0, used)
    changed = ""
    # a refill: a stop for the limit ends, and the normal number of parts comes back
    if q.get("paused") and q.get("resume_at") and now >= q["resume_at"] and all(w["used_percent"] < 100 - STOP_BEFORE for w in wins):
        q["paused"] = False
        q.pop("resume_at", None)
        changed = "resumed"
    if q.get("slowed"):
        k = q.get("slowed_kind") or "session"
        w = next((x for x in wins if x["kind"] == k), None)
        was = q.get("slowed_resets")
        if (w and was and w.get("resets_at") and w["resets_at"] > was + 60) or (changed == "resumed"):
            q["slowed"] = False
            changed = changed or "restored"
    if changed:
        return changed
    full = [w for w in wins if w["used_percent"] >= 100 - STOP_BEFORE]
    if full:
        if not q.get("paused"):
            q["paused"] = True
            q["paused_at"] = now
            q["paused_kind"] = full[0]["kind"]
            q["resume_at"] = max((w.get("resets_at") or now + 3600) for w in full)
            return "paused"
        return ""
    if q.get("slowed") or run.get("hold_slots") or int(run.get("slots") or SLOTS_DEFAULT) <= 1:
        return ""
    running = sum(1 for p in run["parts"] if p.get("status") in ("working", "starting", "fixing"))
    done_at = None
    for w in sorted(wins, key=lambda w: -w["used_percent"]):
        why = ""
        if w["used_percent"] >= SLOW_AT:
            why, projected = "at", w["used_percent"]
        else:
            if done_at is None:
                done_at = forecast(run, now)["done_at"]
            until = min(w.get("resets_at") or now + 5 * 3600, max(done_at, now))
            five = w["kind"] in ("session", "five_hour")
            pace = burn_per_min([p[:2] for p in series.get(w["kind"]) or []], running if five else 0, rate_of(run), now)
            projected = w["used_percent"] + pace * max(0.0, (until - now) / 60.0)
            if projected >= 100:
                why = "pace"
        if why:
            q.update(slowed=True, slowed_at=now, slowed_why=why, slowed_kind=w["kind"], slowed_resets=w.get("resets_at"),
                     projected=projected, slowed_window=WINDOW_WORDS.get(w["kind"], w["kind"]))
            return "slowed"
    return ""


def provider_kind(text):
    """What OpenCode's provider said, in one word: "out" (balance, plan or quota ran out), "rate" (too many
    requests for now) or "" (any other error, which Turbo leaves to the part's own retries)."""
    if PROVIDER_OUT.search(text or ""):
        return "out"
    if PROVIDER_RATE.search(text or ""):
        return "rate"
    return ""


def provider_said(p, limit=262144, engine=""):
    """The errors the engine's provider gave this part since the last look: [(kind, message)]. OpenCode keeps
    retrying a provider that says no and writes nothing on its output meanwhile; its error log goes to the part's
    log (launch, error_log), and its adapter picks the refused requests out of it (provider_errors)."""
    eng = E.get(engine or p.get("engine") or "")
    if not eng.supports("provider_error"):
        return []
    log = p.get("log") or ""
    try:
        size = os.path.getsize(log)
    except OSError:
        return []
    seen = int(p.get("oc_seen") or 0) if p.get("oc_log") == log else 0
    if size < seen:
        seen = 0
    if size == seen:
        return []
    start = max(seen, size - limit)
    try:
        with open(log, "rb") as f:
            f.seek(start)
            text = f.read(size - start).decode("utf-8", "replace")
    except OSError:
        return []
    cut = text.rfind("\n")
    if cut < 0:
        return []  # half a line: read it whole next time
    p["oc_seen"], p["oc_log"] = start + len(text[:cut + 1].encode("utf-8")), log
    out = []
    for line in text[:cut].splitlines():
        msg = eng.provider_error(line)
        kind = provider_kind(msg) if msg else ""
        if kind:
            out.append((kind, re.sub(r"^\w*Error:\s*", "", msg.split("Last error:")[-1].strip())))
    return out


def _watched(engine):
    """An engine whose provider Turbo listens to: it reports no allowance, its adapter reads its provider's errors."""
    return E.get(engine).supports("provider_error")


def watch_provider(run, now=None):
    """OpenCode's allowance rules, read from what its provider says (it has no allowance reading). Returns what
    changed: "", "slowed", "slower", "out", "restored", "retry". A part that hears "too many requests" says so as
    its step."""
    now = now or time.time()
    q = run.setdefault("quota", {})
    pv = q.setdefault("provider", {})
    hits = []
    for p in list(run["parts"]) + list(run.get("finals") or []):
        if p.get("status") in ("working", "starting", "fixing") and _watched(p.get("engine") or run["engine"]):
            said = provider_said(p, engine=p.get("engine") or run["engine"])
            if said:
                hits += said
                kind, msg = said[-1]
                p["activity"] = ("Waiting: the provider says too many requests" if kind == "rate"
                                 else "Stopped: the provider says the balance ran out")
    if hits:
        out = [m for k, m in hits if k == "out"]
        pv.update(last_at=now, count=int(pv.get("count") or 0) + len(hits))
        if out:
            pv.update(kind="out", text=out[-1][:200], out_at=now)
            if not q.get("paused"):
                q.update(paused=True, paused_at=now, paused_kind="provider", resume_at=now + OUT_RETRY)
                return "out"
            if q.get("paused_kind") == "provider":
                q["resume_at"] = now + OUT_RETRY
            return ""
        pv.update(kind="rate", text=hits[-1][1][:200], rate_at=now)
        if not q.get("slowed"):
            q.update(slowed=True, slowed_at=now, slowed_why="rate", slowed_kind="provider", halved=1)
            return "slowed" if not run.get("hold_slots") and int(run.get("slots") or SLOTS_DEFAULT) > 1 else ""
        if q.get("slowed_kind") == "provider" and now - (q.get("slowed_at") or now) >= RATE_AGAIN and slots_now(run) > 1 and not run.get("hold_slots"):
            q.update(halved=int(q.get("halved") or 1) + 1, slowed_at=now)
            return "slower"
        return ""
    if q.get("paused") and q.get("paused_kind") == "provider" and now >= (q.get("resume_at") or 0):
        q["stops"] = list(q.get("stops") or []) + [[q.get("paused_at") or now, now]]
        q["paused"] = False
        q.pop("resume_at", None)
        q.pop("paused_kind", None)
        pv["kind"] = "retry"
        return "retry"
    if q.get("slowed") and q.get("slowed_kind") == "provider" and now - (pv.get("rate_at") or 0) >= RATE_QUIET:
        q["slowed"] = False
        q.pop("halved", None)
        pv["kind"] = ""
        return "restored"
    return ""


def provider_words(run, now=None):
    """The band's words for an agent without an allowance reading (OpenCode): what its provider said, plainly."""
    q = run.get("quota") or {}
    pv = q.get("provider") or {}
    name = _name(run.get("engine"))
    said = (' ("%s")' % _sentence(pv["text"])[:80]) if pv.get("text") else ""
    if q.get("paused") and q.get("paused_kind") == "provider":
        return "%s's provider said the balance or plan ran out at %s%s. Turbo tries again at %s." % (
            name, hm(pv.get("out_at") or q.get("paused_at")), said, hm(q.get("resume_at")))
    if q.get("slowed") and q.get("slowed_kind") == "provider":
        return "%s's provider said too many requests at %s%s · %d at a time; back to %d after 10 quiet minutes" % (
            name, hm(pv.get("rate_at")), said, slots_now(run), int(run.get("slots") or SLOTS_DEFAULT))
    if pv.get("kind") == "retry":
        return "Trying %s's provider again since %s." % (name, hm((q.get("stops") or [[0, 0]])[-1][1]))
    return ("%s does not report an allowance. Turbo listens to its provider instead: it slows down when the provider "
            "says too many requests, and stops when it says the balance ran out." % name)


def projection(run, now=None):
    """Points for the dashed line: the allowance from now to the end at the plan's pace, dropping at refills."""
    now = now or time.time()
    q = run.get("quota") or {}
    if not q.get("known"):
        return []
    fc = forecast(run, now)
    used, resets = q.get("used") or 0.0, q.get("resets_at")
    rate = rate_of(run)
    pts, t = [[now, used]], now
    end = max(fc["done_at"], now)
    step = 5 * 60
    while t < end:
        t2 = min(end, t + step)
        n = 0
        for k, (s, e) in fc["parts"].items():
            if s < t2 and e > t:
                n += 1
        for k, (s, e) in fc["finals"].items():
            if s < t2 and e > t and k != "land":
                n += 1
        used += rate * n * (t2 - t) / 60.0
        if resets and t < resets <= t2:
            pts.append([resets, used])
            used = rate * n * (t2 - resets) / 60.0
            pts.append([resets, 0])
            resets = resets + 5 * 3600
        t = t2
        pts.append([t, min(used, 120)])
    return pts


# ---------------------------------------------------------------- copies of the project

def repo_of(cwd):
    code, top, err = git(cwd, "rev-parse", "--show-toplevel")
    if code or not top:
        raise UserError("Turbo works in a project that is a git repository; %s is not one." % cwd)
    code, sha, _ = git(top, "rev-parse", "--verify", "HEAD")
    if code or not sha:
        raise UserError("This project has no commit yet; commit once, then try Turbo.")
    branch = git(top, "symbolic-ref", "--quiet", "--short", "HEAD")[1]
    return top, branch, sha


def _exclude(repo, names):
    """Linked folders stay out of commits in every copy: one line each in the repository's own exclude file."""
    code, common, _ = git(repo, "rev-parse", "--git-common-dir")
    if code:
        return
    if not os.path.isabs(common):
        common = os.path.join(repo, common)
    path = os.path.join(common, "info", "exclude")
    try:
        with open(path, encoding="utf-8") as f:
            have = f.read().splitlines()
    except OSError:
        have = []
    add = [n for n in names if n not in have]
    if add:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(("\n" if have and have[-1] else "") + "# Dispatch Turbo: folders linked into each copy\n" + "\n".join(add) + "\n")


def link_deps(repo, copy):
    """What each copy needs and does not download again: node_modules folders are linked, .env files and local
    agent settings are copied. Returns the paths linked or copied."""
    done = []
    for base, dirs, files in os.walk(repo):
        rel = os.path.relpath(base, repo)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        if ".git" in dirs:
            dirs.remove(".git")
        if "node_modules" in dirs:
            dirs.remove("node_modules")
            src, dst = os.path.join(base, "node_modules"), os.path.join(copy, rel, "node_modules")
            if os.path.isdir(os.path.dirname(dst)) and not os.path.lexists(dst):
                os.symlink(src, dst)
                done.append(os.path.normpath(os.path.join(rel, "node_modules")))
        if depth >= 2:
            dirs[:] = []
        dirs[:] = [d for d in dirs if not d.startswith(".") or d == ".claude"]
        for f in files:
            if (depth == 0 and f.startswith(".env")) or (rel == ".claude" and f == "settings.local.json"):
                src, dst = os.path.join(base, f), os.path.join(copy, rel, f)
                if not os.path.exists(dst) and os.path.isdir(os.path.dirname(dst)):
                    shutil.copy2(src, dst)
                    done.append(os.path.normpath(os.path.join(rel, f)))
    # linked and copied things never go into a commit of a copy (a .env holds secrets)
    names = ["node_modules"] if any(d.endswith("node_modules") for d in done) else []
    names += ["/" + d for d in done if not d.endswith("node_modules") and git(repo, "check-ignore", "-q", d)[0] != 0]
    if names:
        _exclude(repo, names)
    return done


def make_copy(run, name, branch, start_point):
    path = os.path.join(run_dir(run["id"]), "copies", name)
    if os.path.isdir(path):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    code, _, err = git(run["repo"], "worktree", "add", "-B", branch, path, start_point, timeout=300)
    if code:
        raise UserError("Could not make a copy of the project: " + err[-300:])
    try:
        link_deps(run["repo"], path)
    except OSError:
        pass
    return path


def drop_copy(run, path):
    if path and os.path.isdir(path):
        git(run["repo"], "worktree", "remove", "--force", path, timeout=120)
    git(run["repo"], "worktree", "prune")


# ---------------------------------------------------------------- agents

def brief(run, p, extra=""):
    cli = cli_cmd()
    rid, n = run["id"], p["n"]
    shared = [s["file"] for s in run.get("shared") or []]
    lines = [
        "You are part %d of %d of a Turbo run: a bigger job split into parts that run at the same time, each in its own copy of the project." % (n, len(run["parts"])),
        "",
        "The whole job, in the person's own words:",
        '"""%s"""' % run["ask"],
        "",
        "Your part: %s" % p["full"],
    ]
    if p.get("files"):
        lines.append("Files you are expected to change: " + ", ".join(p["files"]))
    if shared:
        lines.append("Do not change these files: other parts need them too, and they are changed once at the end: %s. "
                     "If your part needs a change in one of them, describe it exactly under a heading \"## Shared files\" in your report." % ", ".join(shared))
    lines += [
        "",
        "Work only in %s (your own copy of the project, on branch %s). Commit your work there with clear messages. "
        "Do not push, do not merge into other branches, do not start other agents." % (p["copy"], p["branch"]),
        "At each step, say in a few plain words what you are doing (the person watches a timeline): %s turbo step %s %d \"Adding the setup question\"" % (cli, rid, n),
        "If you need the person to decide something you cannot decide yourself, ask once and end your turn: "
        "%s turbo ask %s %d \"<the question>\" --option \"<choice>\" --option \"<choice>\". You are resumed with the answer." % (cli, rid, n),
        "If the file %s appears, finish the step at hand, commit, write your report with what is left, and stop." % os.path.join(p["copy"], ".turbo-stop"),
        "When your part is done: commit, then write the report to %s: what you changed, how you checked it, what is left." % p["report"],
    ]
    return "\n".join(lines) + ("\n\n" + extra if extra else "")


def final_brief(run, f):
    cli = cli_cmd()
    rid = run["id"]
    reports = []
    for p in run["parts"]:
        try:
            with open(p.get("report") or "", encoding="utf-8") as fh:
                txt = fh.read()[:6000]
        except OSError:
            txt = ""
        reports.append("### Part %d: %s\n%s" % (p["n"], p["name"], txt.strip() or "(no report)"))
    head = ("You do one of the last steps of a Turbo run: a job split into %s that ran at the same time, now combined in %s (branch %s). "
            "The job, in the person's own words:\n\"\"\"%s\"\"\"\n\n" % (parts_words(len(run["parts"])), run["combine_copy"], run["combine_branch"], run["ask"]))
    if f["id"] == "shared":
        task = ("Your step: Shared files. These files were kept for the end because several parts need them: %s. "
                "Read the \"## Shared files\" sections in the part reports below and make those changes, one part at a time, then commit." %
                ", ".join(s["file"] for s in run.get("shared") or []))
    elif f["id"] == "tests":
        task = ("Your step: Tests. Find how this project runs its tests (README, package.json, Makefile, CLAUDE.md or AGENTS.md), run them, "
                "and fix what the combined parts broke. Commit the fixes. If the project has no tests, run what checks it has and say so.")
    else:
        task = ("Your step: Second check. You did not build any of this. Check each part against the person's words: is it really done? "
                "Read the combined changes (git log and git diff %s..HEAD), try what can be tried, fix small mistakes and commit them; list what is not done." % run["base_sha"][:12])
    tail = ("\n\nSay what you are doing at each step: %s turbo step %s %s \"<a few plain words>\".\n"
            "Work only in %s. Do not push and do not start other agents. When done, commit and write a short report to %s." %
            (cli, rid, f["id"], run["combine_copy"], f["report"]))
    return head + task + tail + "\n\nThe part reports:\n\n" + "\n\n".join(reports)


def _child_env(run):
    env = D.child_env()
    for k in (*E.session_env_names(), "DISPATCH_DISPATCHER_SESSION", "DISPATCH_LIFE_MANAGED", "DISPATCH_WORKER"):
        env.pop(k, None)
    actor = E.agent_of(run["engine"])
    env.update(DISPATCH_DIR=D.DISPATCH_DIR, BEADS_DIR=D.BEADS_DIR, BEADS_ACTOR=actor, DISPATCH_ACTOR=actor,
               DISPATCH_TURBO_RUN=run["id"], PYTHONDONTWRITEBYTECODE="1",
               # the standalone browser a part checks its pages in (dispatch browser) opens no window in front of the person
               DISPATCH_BROWSER_HEADLESS="1")
    try:
        import engines
        env["PATH"] = engines.search_path(env)
    except Exception:
        pass
    return env


_CHILDREN = {}  # pid -> Popen, so the runner reaps the agents it started


def launch(run, who, prompt, cwd, folder, resume=False):
    """Start one agent for a part or a final step. `who` is the part or final dict; it gets pid, log, session."""
    import engines
    # a resumed agent stays on the agent that has its session; anything new goes to the run's agent now
    own = resume and who.get("session") and who.get("engine")
    kind = who["engine"] if own else run["engine"]
    model = (who.get("model") or "") if own else (run.get("model") or "")
    eng = E.get(kind)
    binary = engines.which(eng.bin)
    if not binary:
        raise UserError("%s is not installed on this Mac." % _name(kind))
    os.makedirs(folder, exist_ok=True)
    who["engine"], who["model"] = kind, model
    session = who.get("session") or ""
    if not session:  # an engine that takes its session id from its caller (Claude Code) gets it now
        session = eng.headless_new_session()
        if session:
            who["session"] = session
    # error_log: the provider's errors on stderr (the part's log), the only place its "too many requests" shows up
    argv = eng.headless_argv(model, prompt, cwd, effort=run.get("effort") or "", session=session, resume=bool(resume and session),
                             lastfile=os.path.join(folder, "last-message.txt"), error_log=True)
    argv[0] = binary
    attempt = len(who.get("attempts") or []) + 1
    log = os.path.join(folder, "agent-%d.log" % attempt)
    spec = os.path.join(folder, "launch-%d.json" % attempt)
    exit_file = os.path.join(folder, "exit-%d" % attempt)
    _write_json(spec, {"argv": argv, "exit": exit_file})
    with open(log, "ab") as out:
        pr = P.spawn_detached([sys.executable, os.path.abspath(__file__), "_exec", spec], cwd=cwd, env=_child_env(run),
                              stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT)
    _CHILDREN[pr.pid] = pr
    who.setdefault("attempts", []).append({"at": time.time(), "log": log, "resume": bool(resume)})
    who.update(pid=pr.pid, log=log, exit_file=exit_file, launched_at=time.time())
    return pr.pid


def exec_spec(spec):
    """The wrapper each agent runs in: it waits for the engine and writes its exit code, so the runner knows the end."""
    with open(spec, encoding="utf-8") as f:
        job = json.load(f)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    child = subprocess.Popen(job["argv"])

    def stop(signum, frame):
        try:
            child.terminate()
        except OSError:
            pass
    signal.signal(signal.SIGTERM, stop)
    rc = child.wait()
    with open(job["exit"], "w") as f:
        f.write(str(rc))
    return rc


def alive(who):
    pid = who.get("pid")
    pr = _CHILDREN.get(pid)
    if pr is not None:
        if pr.poll() is None:
            return True
        _CHILDREN.pop(pid, None)
        return False
    if not pid or not P.pid_alive(pid):
        return False
    try:
        r = subprocess.run(["ps", "-p", str(int(pid)), "-o", "stat="], capture_output=True, text=True, timeout=3)
        return bool(r.stdout.strip()) and "Z" not in r.stdout
    except (OSError, subprocess.SubprocessError):
        return True


def stop_proc(who):
    pid = who.get("pid")
    if pid and alive(who):
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except OSError:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass


def _read(path, limit=None):
    try:
        with open(path or "", encoding="utf-8") as f:
            return f.read(limit) if limit else f.read()
    except OSError:
        return ""


def exit_code(who):
    try:
        return int(_read(who.get("exit_file")).strip())
    except ValueError:
        return None


def _tail(path, size=262144):
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            n = f.tell()
            f.seek(max(0, n - size))
            return f.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return []


def _short_path(p):
    p = str(p or "")
    return os.path.basename(p.rstrip("/")) or p


def _tool_words(name, inp):
    name = (name or "").lower()
    inp = inp if isinstance(inp, dict) else {}
    path = inp.get("file_path") or inp.get("filePath") or inp.get("path") or ""
    if name in ("edit", "write", "multiedit", "apply_patch", "patch") or name.endswith("edit"):
        return "Editing " + _short_path(path) if path else "Editing files"
    if name in ("read", "view"):
        return "Reading " + _short_path(path) if path else "Reading files"
    if name in ("bash", "shell", "command_execution", "exec"):
        cmd = str(inp.get("command") or inp.get("cmd") or "")
        if isinstance(inp.get("command"), list):
            cmd = " ".join(inp["command"])
        cmd = re.sub(r"\s+", " ", cmd).strip()
        if "turbo step" in cmd or "turbo ask" in cmd:
            return ""
        return "Running " + cmd[:60] if cmd else "Running a command"
    if name in ("grep", "glob", "search", "find", "list", "ls"):
        return "Looking through the project"
    if name in ("todowrite", "todo"):
        return "Planning the steps"
    return ""


def last_activity(kind, log):
    """What the agent did last, in a few words, read from its own output (its adapter's steps): an edit, a command, a
    sentence."""
    eng = E.get(kind)
    for line in reversed(_tail(log)):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        for step in reversed(eng.steps(ev) if isinstance(ev, dict) else []):
            if step[0] == "tool":
                w = _tool_words(step[1], step[2])
                if w:
                    return w
            elif step[0] == "text" and (step[1] or "").strip():
                return _sentence(step[1])
    return ""


def _sentence(text):
    s = re.sub(r"[`*#>_]+", "", text or "")
    s = re.sub(r"\s+", " ", s).strip()
    m = re.match(r"(.{8,90}?[.!?。！？])(\s|$)", s)
    return (m.group(1) if m else s[:90]).strip()


def session_of(kind, log):
    """The engine's own session id from its output, so a part can be resumed after a question or a stop."""
    eng = E.get(kind)
    for line in _tail(log, 65536)[:200] if os.path.exists(log or "") else []:
        sid = eng.session_in(line)
        if sid:
            return sid
    return ""


def hit_limit(log):
    for line in _tail(log, 32768)[-60:]:
        if re.search(r"hit your (session|usage|weekly) limit|usage.limit|rate.limit|exceeded your|insufficient.(balance|quota)|余额不足|额度", line, re.I):
            return True
        if PROVIDER_OUT.search(line) and ("stream error" in line or line.lstrip().startswith("{")):
            return True
    return False


def has_report(path):
    try:
        return os.path.getsize(path) > 0
    except OSError:
        return False


# ---------------------------------------------------------------- the runner: one tick

def _start_part(run, p, now, resume_text=""):
    if not p.get("copy"):
        p["copy"] = make_copy(run, "part-%d" % p["n"], p["branch"], run["combine_branch"])
        p["start_sha"] = git(p["copy"], "rev-parse", "HEAD")[1]
    folder = os.path.join(run_dir(run["id"]), "parts", str(p["n"]))
    try:
        os.remove(os.path.join(p["copy"], ".turbo-stop"))
    except OSError:
        pass
    resume = bool(resume_text) and bool(p.get("session"))
    prompt = resume_text if resume else brief(run, p, resume_text)
    launch(run, p, prompt, p["copy"], folder, resume=resume)
    if not p.get("started_at"):
        p["started_at"] = now
        event(run, "started", "Started: %s" % p["name"], p["n"])
    p["status"] = "working"
    p.pop("ended_at", None)


def _commit_leftovers(cwd, message):
    if git(cwd, "status", "--porcelain")[1]:
        git(cwd, "add", "-A")
        git(cwd, "commit", "-q", "-m", message, "--no-verify")


def _combine(run, p, now):
    """Merge a finished part into the combined copy. Returns True when it went in."""
    _commit_leftovers(p["copy"], "Turbo part %d: %s" % (p["n"], p["name"]))
    cc = run["combine_copy"]
    head = git(p["copy"], "rev-parse", "HEAD")[1]
    if head and head == p.get("start_sha"):
        p["empty"] = True
    else:
        code, _, err = git(cc, "merge", "--no-ff", "--no-edit", "-m", "Combine part %d: %s" % (p["n"], p["name"]), p["branch"], timeout=120)
        if code:
            git(cc, "merge", "--abort")
            p["conflict"] = err[-400:]
            return False
    if not p.get("empty"):
        # its own commits, before its branch goes: whose they are once they are in the person's branch (made_by)
        p["shas"] = [x for x in git(p["copy"], "rev-list", "%s..HEAD" % p["start_sha"])[1].split() if x][:200]
    run["combined_n"] = run.get("combined_n", 0) + 1
    p.update(status="combined", combined_at=now, combined_n=run["combined_n"], ended_at=p.get("ended_at") or now)
    p.pop("conflict", None)
    event(run, "combined", "Combined: %s (%s)" % (p["name"], _nth(run["combined_n"])), p["n"])
    drop_copy(run, p.get("copy"))
    git(run["repo"], "branch", "-D", p["branch"])
    return True


def _nth(n):
    return "%d%s" % (n, "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th"))


def _part_ended(run, p, now):
    """The agent of a part has exited: needs the person, was stopped for the allowance, finished, or failed."""
    log = p.get("log") or ""
    kind = p.get("engine") or run["engine"]
    p["session"] = p.get("session") or session_of(kind, log)
    p["ended_at"] = now
    if p.get("ask") and not p["ask"].get("answered"):
        p["status"] = "needs"
        seg(p, "needs", now)
        event(run, "needs", "%s asks: %s" % (p["name"], p["ask"]["question"]), p["n"])
        return
    stopping = os.path.exists(os.path.join(p.get("copy") or "", ".turbo-stop"))
    if (run.get("quota") or {}).get("paused") and (stopping or hit_limit(log)) or (hit_limit(log) and not has_report(p["report"])):
        p["status"] = "paused"
        p["resume_note"] = "stopped for the allowance"
        _commit_leftovers(p["copy"], "Turbo part %d: work so far (stopped for the allowance)" % p["n"])
        return
    if run.get("state") == "paused" and stopping:
        p["status"] = "paused"
        _commit_leftovers(p["copy"], "Turbo part %d: work so far (paused)" % p["n"])
        return
    head = git(p["copy"], "rev-parse", "HEAD")[1] if p.get("copy") else ""
    dirty = bool(git(p["copy"], "status", "--porcelain")[1]) if p.get("copy") else False
    if has_report(p["report"]) or (exit_code(p) == 0 and (head != p.get("start_sha") or dirty)):
        p["status"] = "done"
        if p.get("fixing"):
            p.pop("fixing", None)
        return
    tries = len(p.get("attempts") or [])
    if tries < 2:
        p["status"] = "waiting"
        p["retry"] = "The last attempt ended without a report: %s. Check what is already done in your copy, then carry on." % _sentence(
            " ".join(_tail(log, 4096)[-3:]))[:200]
        event(run, "retry", "%s stopped early; starting it again" % p["name"], p["n"])
        return
    p["status"] = "failed"
    p["failed"] = _sentence(" ".join(_tail(log, 4096)[-3:])) or "It stopped without a report."
    event(run, "failed", "%s stopped twice without finishing" % p["name"], p["n"])


def _final_ended(run, f, now):
    f["ended_at"] = now
    f["status"] = "done"
    _commit_leftovers(run["combine_copy"], "Turbo: %s" % f["name"])
    event(run, "final", "%s done" % f["name"])


def land(run, now=None, by_hand=False):
    """Bring the combined result into the branch the person works on, when that copy is clean and on that branch."""
    now = now or time.time()
    f = next((x for x in run["finals"] if x["id"] == "land"), None)
    repo, base = run["repo"], run.get("base_branch") or ""
    cur = git(repo, "symbolic-ref", "--quiet", "--short", "HEAD")[1]
    dirty = [l for l in git(repo, "status", "--porcelain", "--untracked-files=no")[1].splitlines() if l.strip()]
    if not base or cur != base or dirty:
        why = ("your copy of the project has changes that are not committed" if dirty else
               "your copy of the project is on %s now, not %s" % (cur or "a detached commit", base or "a branch"))
        f.update(status="needs", ask={"question": "The result is ready on its own branch (%s). I did not bring it into %s because %s." % (run["combine_branch"], base or "your branch", why),
                                      "options": ["Bring it in now", "Leave it on its own branch"]})
        if by_hand:
            raise UserError("Not brought in: %s." % why)
        return False
    _mark(run, "start")  # the lines the merge brings into the person's copy are Turbo's agent's, not the person's
    code, _, err = git(repo, "merge", "--no-ff", "--no-edit", "-m", "Turbo: %s" % run["title"], run["combine_branch"], timeout=180)
    _mark(run, "end")
    if code:
        git(repo, "merge", "--abort")
        f.update(status="needs", ask={"question": "Bringing the result into %s ran into a conflict with changes made there meanwhile. It is on its own branch (%s)." % (base, run["combine_branch"]),
                                      "options": ["Try again", "Leave it on its own branch"]})
        if by_hand:
            raise UserError("Not brought in: a conflict with %s." % base)
        return False
    f.update(status="done", ended_at=now, landed_sha=git(repo, "rev-parse", "HEAD")[1])
    f.pop("ask", None)
    made_by(run, f["landed_sha"])
    event(run, "landed", "Brought into %s" % base)
    return True


def _mark(run, event):
    """A mark in the project's attribution record (attribution.py), as a turn of the run's agent: what changes in the
    person's copy between the start and the end mark is that agent's. Best effort."""
    try:
        import attribution
        attribution.mark(run["repo"], event, run["engine"], "turbo:" + run["id"], text="Turbo: " + run["title"],
                         source="turbo", base=D.DISPATCH_DIR)
    except Exception:  # noqa: BLE001 - the record is a nicety; bringing the result in is the job
        pass


def made_by(run, landed):
    """Every commit the run brought into the person's branch, with the agent that made it (a part's own commits: that
    part's agent; the merges and the final steps: the run's), so the commit cards in the person's sessions say
    Turbo's agent made them rather than "You committed" (task-v6glz). Best effort."""
    owner = {}
    for p in run["parts"]:
        for sha in p.get("shas") or []:
            owner[sha] = p.get("engine") or run["engine"]
    rows = [{"sha": sha, "by": owner.get(sha) or run["engine"], "how": "turbo", "run": run["id"], "landed": sha == landed}
            for sha in git(run["repo"], "rev-list", "-n", "500", "%s..%s" % (run["base_sha"], landed))[1].split() if sha]
    try:
        import attribution
        attribution.note_made(run["repo"], rows, base=D.DISPATCH_DIR)
    except Exception:  # noqa: BLE001
        pass


def finish(run, now):
    """The run is done: the numbers for the summary card and one delivery page."""
    run["state"] = "done"
    run["done_at"] = now
    q = run.get("quota") or {}
    base = run["base_sha"]
    tip = git(run["repo"], "rev-parse", run["combine_branch"])[1]
    stat = git(run["repo"], "diff", "--shortstat", base, tip)[1] if tip else ""
    files = int((re.search(r"(\d+) files? changed", stat) or [0, 0])[1]) if stat else 0
    commits = len([l for l in git(run["repo"], "rev-list", "%s..%s" % (base, tip))[1].splitlines() if l]) if tip else 0
    spend = q.get("spend") or []
    used = None
    if spend:
        used = q.get("spent_before", 0) + max(0, spend[-1][1] - q.get("period_start", spend[0][1]))
    elapsed = (now - (run.get("started_at") or now)) / 60.0
    seq = sum(((p.get("ended_at") or now) - (p.get("started_at") or now)) / 60.0 for p in run["parts"] if p.get("started_at"))
    seq += sum(((f.get("ended_at") or now) - (f.get("started_at") or now)) / 60.0 for f in run["finals"] if f.get("started_at"))
    left = [p["name"] for p in run["parts"] if p["status"] in ("failed", "skipped")]
    left += [f["name"] for f in run["finals"] if f["status"] == "needs"]
    run["summary"] = {"minutes": elapsed, "sequential_minutes": max(seq, elapsed), "parts": len(run["parts"]),
                      "combined": sum(1 for p in run["parts"] if p["status"] == "combined"), "files": files, "commits": commits,
                      "used_pct": used, "planned_pct": run.get("planned_pct"), "peak": q.get("peak"), "left": left,
                      "branch": run["combine_branch"], "landed": next((f.get("landed_sha") for f in run["finals"] if f["id"] == "land"), "")}
    event(run, "done", "Done: %s in %s" % (parts_words(len(run["parts"])), dur_words(elapsed)))
    try:
        run["page"] = write_page(run)
    except OSError:
        run["page"] = ""
    for p in run["parts"]:
        if p.get("copy") and p["status"] == "combined":
            drop_copy(run, p["copy"])
        elif p.get("copy") and p["status"] in ("skipped", "failed") and git(p["copy"], "rev-parse", "HEAD")[1] == p.get("start_sha") \
                and not git(p["copy"], "status", "--porcelain")[1]:
            # left out before it did anything: nothing to keep
            drop_copy(run, p["copy"])
            git(run["repo"], "branch", "-D", p["branch"])
    if not left and run["finals"][-1]["status"] == "done":
        drop_copy(run, run.get("combine_copy"))
        # brought in: the combined branch is part of the person's branch now
        git(run["repo"], "branch", "-d", run["combine_branch"])
    try:
        remember_pace(run)
    except OSError:
        pass
    settle_task(run)


def tick(run, now=None, rd=False):
    """One look at the run: allowance rules, ended agents, merges, new starts, finals. `rd` is a reading or False."""
    now = now or time.time()
    if run["state"] not in ("running", "paused", "combining"):
        return
    q = run.setdefault("quota", {})
    if rd is not False:
        what = govern(run, rd, now)
        if what == "slowed":
            win = q.get("slowed_window") or "5-hour"
            event(run, "slowed", ("The %s allowance passed %d%%" % (win, SLOW_AT) if q.get("slowed_why") == "at" else
                                   "At this pace the %s allowance runs out before %s" % (win, hm(q.get("slowed_resets")) or "the refill")) +
                  ": %d at a time now instead of %d" % (slots_now(run), run["slots"]))
        elif what == "paused":
            run["state"] = "paused"
            for p in run["parts"]:
                if p.get("status") in ("working", "fixing") and p.get("copy"):
                    try:
                        open(os.path.join(p["copy"], ".turbo-stop"), "w").close()
                    except OSError:
                        pass
            event(run, "paused", "%d%% of the allowance used: the running parts finish their step and stop; I carry on at %s" % (int(q["used"]), hm(q["resume_at"])))
        elif what in ("resumed", "restored"):
            if run["state"] == "paused" and not run.get("paused_by_hand"):
                run["state"] = "running"
            event(run, "resumed", "The allowance refilled: carrying on with %d at a time" % slots_now(run))
    # an engine without an allowance reading (OpenCode): what its provider answers decides instead
    if any(_watched(p.get("engine") or run["engine"]) for p in list(run["parts"]) + list(run.get("finals") or [])
           if p.get("status") in ("working", "starting", "fixing")) or (q.get("paused_kind") == "provider"):
        what = watch_provider(run, now)
        pv = q.get("provider") or {}
        said = (' ("%s")' % _sentence(pv.get("text") or "")[:80]) if pv.get("text") else ""
        if what == "slowed":
            event(run, "slowed", "%s's provider said too many requests%s: %d at a time now instead of %d" % (_name(run["engine"]), said, slots_now(run), run["slots"]))
        elif what == "slower":
            event(run, "slowed", "The provider still says too many requests: %d at a time now" % slots_now(run))
        elif what == "restored":
            event(run, "resumed", "No more \"too many requests\" for 10 minutes: back to %d at a time" % slots_now(run))
        elif what == "out":
            run["state"] = "paused"
            for p in run["parts"]:
                if p.get("status") in ("working", "fixing") and p.get("copy"):
                    try:
                        open(os.path.join(p["copy"], ".turbo-stop"), "w").close()
                    except OSError:
                        pass
                    stop_proc(p)  # OpenCode would keep asking a provider that says no, without end
            event(run, "paused", "OpenCode's provider said the balance or plan ran out%s: the parts stopped with their work committed; Turbo tries again at %s" % (said, hm(q.get("resume_at"))))
        elif what == "retry":
            if run["state"] == "paused" and not run.get("paused_by_hand"):
                run["state"] = "running"
            event(run, "resumed", "Trying OpenCode's provider again")
    # agents that ended
    for p in run["parts"]:
        st = p.get("status")
        if st in ("working", "starting", "fixing"):
            if alive(p):
                seg(p, "fix" if st == "fixing" else "work", now)
                act = last_activity(p.get("engine") or run["engine"], p.get("log"))
                if act:
                    p["activity"] = act
            else:
                seg(p, "fix" if st == "fixing" else "work", now)
                _part_ended(run, p, now)
        elif st == "needs":
            seg(p, "needs", now)
        elif st == "paused":
            seg(p, "paused", now)
    # merge the finished ones, in the order they finished
    for p in sorted([p for p in run["parts"] if p.get("status") == "done"], key=lambda p: p.get("ended_at") or now):
        if not _combine(run, p, now):
            if p.get("fix_tries", 0) >= 2:
                p["status"] = "needs"
                p["ask"] = {"question": "%s could not be combined with the others (both changed the same lines). Try once more or leave it out?" % p["name"],
                            "options": ["Try again", "Leave it out"], "kind": "conflict"}
                event(run, "needs", "%s could not be combined" % p["name"], p["n"])
            else:
                p["fix_tries"] = p.get("fix_tries", 0) + 1
                p["fixing"] = True
                p["status"] = "fixing"
                folder = os.path.join(run_dir(run["id"]), "parts", str(p["n"]))
                os.remove(p["report"]) if has_report(p["report"]) else None
                text = ("Your part could not be combined with the parts finished before it: both changed the same lines. "
                        "In your copy, merge branch %s into your branch, resolve the conflicts keeping what both sides meant, "
                        "run what checks you can, commit, and write your report again to %s." % (run["combine_branch"], p["report"]))
                launch(run, p, text if p.get("session") else brief(run, p, text), p["copy"], folder, resume=bool(p.get("session")))
                event(run, "fixing", "%s is being fitted to the parts combined before it" % p["name"], p["n"])
    if run["state"] == "paused":
        return
    was = run.get("was")
    if was and was.get("back_at") and now >= was["back_at"]:
        switch_back(run, now)
    # start what can start
    busy = sum(1 for p in run["parts"] if p.get("status") in ("working", "starting", "fixing"))
    room = slots_now(run) - busy
    merged = {p["n"] for p in run["parts"] if p.get("status") in ("combined", "skipped")}
    for n in order_of(run):
        if room <= 0:
            break
        p = part_of(run, n)
        st = p.get("status", "waiting")
        if st == "paused" and q.get("paused"):
            continue
        if st not in ("waiting", "paused"):
            continue
        if any(a not in merged for a in p.get("after") or []):
            continue
        note = p.pop("handoff", "")
        if p.get("answer"):
            note = (note + "\n\n" if note else "") + "The person answered your question (%s): %s. Carry on." % (p["ask"]["question"], p.pop("answer"))
        elif note:
            p.pop("retry", None)
        elif st == "paused":
            note = "Continue where you left off: you were stopped for the allowance, which has refilled."
        elif p.get("retry"):
            note = p.pop("retry")
        try:
            _start_part(run, p, now, note)
        except UserError as e:
            p["status"] = "failed"
            p["failed"] = str(e)
            event(run, "failed", "%s could not start: %s" % (p["name"], e), p["n"])
            continue
        room -= 1
    # every part combined (or left out): the finals, one after another
    if all(p.get("status") in ("combined", "skipped") for p in run["parts"]):
        run["state"] = "combining"
        for f in run["finals"]:
            if f["status"] in ("done", "skipped"):
                continue
            if f["status"] == "needs":
                return
            if f["status"] == "working":
                if alive(f):
                    seg(f, "work", now)
                    act = last_activity(f.get("engine") or run["engine"], f.get("log"))
                    if act:
                        f["activity"] = act
                    return
                seg(f, "work", now)
                _final_ended(run, f, now)
                continue
            if f["id"] == "shared" and not run.get("shared"):
                f["status"] = "skipped"
                continue
            f["started_at"] = now
            if f["id"] == "land":
                if land(run, now):
                    continue
                return
            folder = os.path.join(run_dir(run["id"]), "finals", f["id"])
            f["status"] = "working"
            try:
                launch(run, f, final_brief(run, f), run["combine_copy"], folder)
            except UserError as e:
                f["status"] = "skipped"
                f["note"] = str(e)
                continue
            event(run, "final", "%s started" % f["name"])
            return
        finish(run, now)


def runner_alive(run):
    pid = (run.get("runner") or {}).get("pid")
    if not pid or not P.pid_alive(pid):
        return False
    try:
        r = subprocess.run(["ps", "-p", str(int(pid)), "-o", "command="], capture_output=True, text=True, timeout=3)
        return "turbo" in r.stdout and run["id"] in r.stdout
    except (OSError, subprocess.SubprocessError):
        return True


def spawn_runner(run):
    folder = run_dir(run["id"])
    with open(os.path.join(folder, "runner.log"), "ab") as out:
        pr = P.spawn_detached([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), "turbo", "run", run["id"]],
                              cwd=folder, env=dict(D.child_env(), DISPATCH_DIR=D.DISPATCH_DIR, BEADS_DIR=D.BEADS_DIR),
                              stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT)
    run["runner"] = {"pid": pr.pid, "at": time.time()}


def runner_loop(rid, once=False):
    """The background runner of one run: splits the job when asked, then ticks until the run is done."""
    import fcntl
    hold = open(os.path.join(run_dir(rid), "runner.lock"), "a")
    try:
        try:
            fcntl.flock(hold, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return 0  # another runner has this run
        change(rid, lambda r: r.update(runner={"pid": os.getpid(), "at": time.time()}))
        run = load(rid)
        if run["state"] == "planning":
            split_in_background(rid)
            return 0
        last_q = 0
        while True:
            now = time.time()
            rd = False
            if now - last_q >= QUOTA_EVERY:
                r0 = load(rid)
                rd = reading(r0.get("engine", ""), r0.get("usage_file") or "")
                last_q = now
            with locked(rid):
                run = load(rid)
                if run["state"] in ("done", "cancelled", "failed"):
                    save(run)
                    return 0
                try:
                    tick(run, now, rd)
                except Exception as e:  # one bad tick must not end the run; it is written down and tried again
                    event(run, "error", "The runner hit a problem and carries on: %s" % str(e)[:200])
                save(run)
                if run["state"] == "done":
                    remember_rate(run)
            # stopped for the allowance: which other agents could go on (read outside the lock, it asks the accounts)
            q1 = run.get("quota") or {}
            if run["state"] == "paused" and q1.get("paused") and time.time() - (q1.get("alts_at") or 0) > 300:
                alts = alternatives(run)
                change(rid, lambda r: r.setdefault("quota", {}).update(alternatives=alts, alts_at=time.time()) if r.get("quota", {}).get("paused") else None)
            if once:
                return 0
            time.sleep(TICK)
    finally:
        hold.close()


def split_in_background(rid):
    run = load(rid)
    folder = os.path.join(run_dir(rid), "split")
    os.makedirs(folder, exist_ok=True)
    prompt = SPLIT_PROMPT.format(cwd=run["repo"], ask=run["ask"], most=min(PARTS_MAX, 10))
    err = ""
    for attempt in range(2):
        text, failed = ask_model(run, prompt, folder, attempt)
        try:
            title, parts = parse_parts(text)
        except UserError:
            err = split_error(run, failed, text)
            prompt += "\n\nYour last answer was not that JSON. Reply with the JSON only."
            continue

        def put(r):
            set_parts(r, parts, title)
            r["state"] = "planned"
            event(r, "planned", "Split into %s" % parts_words(len(parts)))
        change(rid, put)
        return
    change(rid, lambda r: r.update(state="failed", error=(err or "I could not split the job.")[:400]))


def split_error(run, failed, text):
    """Why a split gave no plan, naming the agent that was asked (the one picked in the input box, task-o8wx)."""
    name = _name(run.get("engine")) or "The agent"
    model = (run.get("model") or "").split("/")[-1]
    who = "%s (%s)" % (name, model) if model else name
    if failed:
        f = " ".join(str(failed).split())
        if re.search(r"not installed", f, re.I):
            return "I could not split the job: %s" % f
        if re.search(r"log(?:ged)? ?in|sign(?:ed)? ?in|auth|credential|api key|\b401\b", f, re.I):
            return "I could not split the job: %s is not signed in on this Mac. %s" % (who, f[-160:])
        return "I could not split the job: %s stopped with an error. %s" % (who, f[-200:])
    if not (text or "").strip():
        return "I could not split the job: %s gave no answer. Try again, or pick another agent in the input box." % who
    return "I could not split the job: %s answered, but not with a plan of parts. Try again, or pick another agent in the input box." % who


def ask_model(run, prompt, folder, attempt):
    """One headless call that returns the model's final text; (text, error)."""
    import engines
    kind = run["engine"]
    eng = E.get(kind)
    binary = engines.which(eng.bin) if eng.supports("headless_argv") else None
    if not binary:
        return "", "%s is not installed on this Mac." % _name(kind)
    last = os.path.join(folder, "answer-%d.txt" % attempt)
    argv = eng.headless_argv(run.get("model") or "", prompt, run["repo"], lastfile=last)
    argv[0] = binary
    try:
        r = subprocess.run(argv, cwd=run["repo"], env=_child_env(run), capture_output=True, text=True, timeout=600, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as e:
        return "", str(e)
    with open(os.path.join(folder, "split-%d.log" % attempt), "w", encoding="utf-8") as f:
        f.write(r.stdout[-200000:] + "\n" + r.stderr[-20000:])
    return final_text(kind, r.stdout, last), ("" if r.returncode == 0 else (r.stderr or r.stdout)[-300:])


def final_text(kind, stdout, lastfile=""):
    return E.get(kind).final_text(stdout, lastfile)


# ---------------------------------------------------------------- making and changing runs

def set_parts(run, parts, title=""):
    rid = run["id"]
    for p in parts:
        p.setdefault("status", "waiting")
        p["branch"] = "turbo/%s/part-%d" % (rid, p["n"])
        p["report"] = os.path.join(run_dir(rid), "parts", str(p["n"]), "report.md")
    run["parts"] = parts
    run["shared"] = shared_files(parts)
    if title and not run.get("title_set"):
        run["title"] = title
    pv = plan_view(run)
    run["planned_pct"] = pv["planned_pct"]
    run["planned_done_at"] = pv["done_at"]


def new_run(ask, cwd, engine, model="", effort="", slots=SLOTS_DEFAULT, task="", title=""):
    if P.IS_WIN:
        raise UserError("Turbo works on macOS for now.")
    ask = (ask or "").strip()
    if not ask:
        raise UserError("Say what the job is.")
    repo, branch, sha = repo_of(os.path.abspath(os.path.expanduser(cwd or os.getcwd())))
    now = time.time()
    rid = "tb-%s-%s" % (datetime.datetime.fromtimestamp(now).strftime("%m%d-%H%M"), uuid.uuid4().hex[:4])
    run = {"id": rid, "version": 1, "ask": ask[:8000], "title": (title or re.sub(r"\s+", " ", ask)[:60]).strip(), "title_set": bool(title),
           "repo": repo, "project": os.path.basename(repo), "base_branch": branch, "base_sha": sha,
           "engine": engine or "claude", "model": model or "", "effort": effort or "",
           "slots": max(1, min(SLOTS_MAX, int(slots or SLOTS_DEFAULT))), "task": task or "",
           "created_at": now, "state": "planning", "parts": [], "shared": [], "events": [],
           "rate": learned_rate(engine or "claude"), "pace": learned_pace(engine or "claude"), "quota": {},
           "combine_branch": "turbo/%s/combined" % rid,
           "finals": [{"id": i, "name": n, "est": m, "status": "waiting",
                       "report": os.path.join(root(), rid, "finals", i, "report.md")} for i, n, m in FINALS]}
    os.makedirs(run_dir(rid), exist_ok=True)
    return run


def learned_rate(engine):
    try:
        with open(os.path.join(root(), "rates.json"), encoding="utf-8") as f:
            v = json.load(f).get(engine)
        return float(v) if v else RATE_DEFAULT
    except (OSError, ValueError, TypeError):
        return RATE_DEFAULT


def remember_rate(run):
    """After a run: how fast it really used the allowance, so the next estimate is closer (a running mean)."""
    s = run.get("summary") or {}
    agent_min = sum(sum(x[1] - x[0] for x in p.get("segs") or [] if x[2] in ("work", "fix")) for p in run["parts"]) / 60.0
    if not s.get("used_pct") or agent_min < 20:
        return
    measured = s["used_pct"] / agent_min
    path = os.path.join(root(), "rates.json")
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    old = float(d.get(run["engine"]) or RATE_DEFAULT)
    d[run["engine"]] = round(old * 0.6 + measured * 0.4, 5)
    _write_json(path, d)


def learned_pace(engine):
    """What one minute of a split's estimate really took this agent on the person's earlier runs (PACE_FIRST before any)."""
    try:
        with open(os.path.join(root(), "paces.json"), encoding="utf-8") as f:
            v = json.load(f).get(engine)
        return min(PACE_MAX, max(PACE_MIN, float(v))) if v else PACE_FIRST
    except (OSError, ValueError, TypeError):
        return PACE_FIRST


def remember_pace(run):
    """After a run: how long its parts really worked against what the split said, so the next forecast of this agent
    is closer (a running mean, like the allowance rate). Parts that waited for the person count only their work."""
    worked = est = 0.0
    for p in run["parts"]:
        if p.get("status") != "combined":
            continue
        w = sum(x[1] - x[0] for x in p.get("segs") or [] if x[2] in ("work", "fix")) / 60.0
        if w > 0:
            worked += w
            est += p["est"]
    if est <= 0 or worked <= 0:
        return
    measured = min(PACE_MAX, max(PACE_MIN, worked / est))
    path = os.path.join(root(), "paces.json")
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    old = d.get(run["engine"])
    d[run["engine"]] = round(measured if not old else float(old) * 0.5 + measured * 0.5, 4)
    _write_json(path, d)


def view(run, now=None):
    """run.json plus what the Timeline tab draws: the forecast, the allowance line, what waits for the person."""
    now = now or time.time()
    v = dict(run)
    v["parts"] = [dict(p) for p in run["parts"]]
    pv = plan_view(run, now)
    v["plan"] = {k: pv[k] for k in ("done_at", "done_words", "minutes", "sequential_minutes", "planned_pct", "allowance", "options")}
    if _watched(run.get("engine")):
        v["plan"]["rule"] = (_name(run.get("engine")) + " does not report an allowance, so Turbo listens to its provider: when it says too many requests, "
                             "half as many parts run at once until it has been quiet for 10 minutes; when it says the balance or plan ran out, "
                             "the parts stop with their work committed and Turbo tries again every 30 minutes. It never switches agents by itself.")
    v["forecast"] = pv["forecast"]
    v["now"] = now
    v["slots_now"] = slots_now(run)
    v["combined"] = sum(1 for p in run["parts"] if p.get("status") == "combined")
    v["total"] = len(run["parts"])
    q = run.get("quota") or {}
    v["allowance"] = {"known": bool(q.get("known")), "engine": run.get("engine"), "engine_name": _name(run.get("engine")),
                      "used": q.get("used"), "resets_at": q.get("resets_at"), "line": 100, "slow_at": SLOW_AT,
                      "readings": q.get("readings") or [], "projection": projection(run, now),
                      "slowed": bool(q.get("slowed")), "slowed_at": q.get("slowed_at"), "paused": bool(q.get("paused")),
                      "paused_at": q.get("paused_at"), "resume_at": q.get("resume_at"), "account": q.get("account") or "",
                      "words": allowance_now_words(run, now), "stops": q.get("stops") or [],
                      "watch": not E.get(run.get("engine")).accounts, "provider": dict(q.get("provider") or {}),
                      "paused_kind": q.get("paused_kind") or "",
                      "stopped_words": provider_words(run, now) if q.get("paused_kind") == "provider" and q.get("paused") else "",
                      "alternatives": q.get("alternatives") or [] if q.get("paused") else []}
    if run.get("was"):
        w = run["was"]
        v["was"] = {"engine": w["engine"], "engine_name": _name(w["engine"]), "back_at": w.get("back_at")}
    needs = []
    for p in run["parts"]:
        if p.get("status") == "needs" and p.get("ask"):
            needs.append({"part": p["n"], "name": p["name"], "question": p["ask"]["question"], "options": p["ask"].get("options") or []})
        elif p.get("status") == "failed":
            needs.append({"part": p["n"], "name": p["name"], "question": "%s stopped twice without finishing: %s" % (p["name"], p.get("failed") or ""),
                          "options": ["Try again", "Leave it out"], "kind": "failed"})
    for f in run.get("finals") or []:
        if f.get("status") == "needs" and f.get("ask"):
            needs.append({"part": f["id"], "name": f["name"], "question": f["ask"]["question"], "options": f["ask"].get("options") or []})
    v["needs"] = needs
    v["engine_name"] = _name(run.get("engine"))
    if run.get("state") in ("planned", "planning", "failed"):
        v["folders"] = folders()
    for p in v["parts"]:
        p["engine_name"] = _name(p.get("engine") or run.get("engine"))
        if p.get("model") or (not p.get("engine") and run.get("model")):
            p["engine_name"] += " · " + (p.get("model") or run.get("model")).split("/")[-1]
        p.pop("handoff", None)
        p["step"] = p.get("said") if p.get("said_at", 0) >= (p.get("launched_at") or 0) - 1 and p.get("said") else p.get("activity") or ""
    return v


def live_row(run, now):
    """A run in a list row: its parts in short, what waits for the person, and what is left of the allowance it plans
    to use (the left column's Turbo row, the bottom bar's bolt and stripes, the account menu)."""
    q = run.get("quota") or {}
    needs = sum(1 for p in run["parts"] if p.get("status") in ("needs", "failed")) + sum(1 for f in run.get("finals") or [] if f.get("status") == "needs")
    out = {"needs": needs, "engine_name": _name(run.get("engine")),
           "parts": [{"n": p["n"], "name": p["name"], "status": p.get("status") or "waiting"} for p in run["parts"]],
           "paused": bool(q.get("paused")), "slowed": bool(q.get("slowed")), "resume_at": q.get("resume_at"),
           "used": q.get("used") if q.get("known") else None, "plans_more": None}
    if q.get("known") and run.get("state") in ("running", "paused", "combining"):
        pts = projection(run, now)
        top = max([pt[1] for pt in pts] or [q.get("used") or 0])
        out["plans_more"] = max(0, int(round(min(100.0, top) - (q.get("used") or 0))))
    return out


def allowance_now_words(run, now):
    q = run.get("quota") or {}
    name = _name(run.get("engine"))
    if _watched(run.get("engine")) or q.get("paused_kind") == "provider":
        return provider_words(run, now)
    if not q.get("known"):
        return "%s's allowance is not readable here, so Turbo does not slow down on its own." % name if not E.get(run.get("engine")).accounts else "Reading the allowance…"
    left = max(0, 100 - int(round(q.get("used") or 0)))
    tail = " until %s" % hm(q["resets_at"]) if q.get("resets_at") else ""
    if q.get("paused"):
        return "Stopped at %d%% of the allowance; carries on at %s." % (int(q.get("used") or 0), hm(q.get("resume_at")))
    if q.get("slowed"):
        return "%d%% of %s left%s · %d at a time since %s" % (left, name, tail, slots_now(run), hm(q.get("slowed_at")))
    return "%d%% of %s left%s" % (left, name, tail)


def ensure_runner(rid):
    run = load(rid)
    if run["state"] in ("planning", "running", "paused", "combining") and not runner_alive(run):
        with locked(rid):
            run = load(rid)
            if not runner_alive(run):
                spawn_runner(run)
                save(run)
    return run


# ---------------------------------------------------------------- normal mode: the Assistant's other agents as lanes

def worker_lanes(now=None, hours=24):
    """The agents the Assistant handed work to (dispatch worker), as lanes: the same picture in normal mode."""
    now = now or time.time()
    try:
        import workers
        store = workers.Store(D)
        rows = workers.worker_rows(store.load(timeout=10))
    except Exception:
        return []
    lanes = []
    for r in rows:
        try:
            start = datetime.datetime.fromisoformat(str(r.get("started_at")).replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
        st = r.get("status")
        end = now
        if st not in ("running", "starting"):
            for path in (r.get("report"), r.get("log")):
                try:
                    end = os.path.getmtime(path)
                    break
                except (OSError, TypeError):
                    continue
        if end < now - hours * 3600:
            continue
        status = {"running": "working", "starting": "working", "failed": "failed", "reported": "done", "merged": "combined"}.get(st, "waiting")
        lanes.append({"id": r["name"], "name": r.get("task_title") or r["name"], "engine": r.get("engine"), "status": status,
                      "segs": [[start, end, "work"]], "step": last_activity(r.get("engine"), r.get("log")) if status == "working" else "",
                      "cwd": r.get("cwd"), "task": r.get("task")})
    lanes.sort(key=lambda x: x["segs"][0][0])
    return lanes


# ---------------------------------------------------------------- the person's defaults and the folders a run can work in

def engines_ok():
    """The engines Turbo can run parts on: the ones Dispatch runs that can work in the background."""
    return [e.id for e in E.runnable() if e.supports("headless_argv")]


def _not_ok(engine):
    return UserError("Turbo runs parts on %s, not %s." % (E.join_words((E.get(i).short_name for i in engines_ok()), "or"), engine))


def config_path():
    return os.path.join(root(), "config.json")


def config_load():
    try:
        with open(config_path(), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def config_save(**kw):
    d = config_load()
    for k, v in kw.items():
        if v is None:
            continue
        if v == "":
            d.pop(k, None)
        else:
            d[k] = v
    _write_json(config_path(), d)
    return d


def engine_choice(engine="", model="", effort=""):
    """The agent the parts run on: what was asked, else the person's Turbo default, else Claude. A model given for
    another agent than the one asked is not carried over."""
    c = config_load()
    eng = (engine or c.get("engine") or "claude").strip().lower()
    if eng not in engines_ok():
        raise _not_ok(eng)
    same = eng == (c.get("engine") or "claude")
    return eng, model or (c.get("model", "") if same else ""), effort or (c.get("effort", "") if same else "")


def folders(limit=8):
    """The git projects the person worked in lately, newest first: [{path, name}]. A worktree counts as its main checkout;
    Dispatch's own folders and Turbo's copies are left out."""
    seen, out = set(), []
    try:
        idx = D.load_index()
    except Exception:
        idx = {}
    own = os.path.realpath(os.path.expanduser(D.DISPATCH_DIR))
    rows = sorted(idx.values(), key=lambda e: -(e.get("mtime") or 0))
    extra = []
    try:
        extra = list(D.project_dirs().values())
    except Exception:
        pass
    for cwd in [e.get("cwd") or "" for e in rows] + extra:
        if not cwd or cwd in seen:
            continue
        seen.add(cwd)
        if "/turbo/tb-" in cwd or not os.path.isdir(cwd):
            continue
        top = D.git_project_root(cwd)
        if not top or top in seen and any(f["path"] == top for f in out):
            continue
        real = os.path.realpath(top)
        if real == own or real.startswith(own + os.sep) or os.path.basename(real) in (".dispatch", "assistant"):
            continue
        if any(f["path"] == top for f in out):
            continue
        out.append({"path": top, "name": os.path.basename(top)})
        if len(out) >= limit:
            break
    return out


def pick_folder(cwd, ask):
    """Where a run works: the folder given when it is a git project; else (the Assistant's own folder, nothing given)
    the recent project whose name the person used, else the one they worked in last."""
    if cwd:
        top = D.git_project_root(os.path.abspath(os.path.expanduser(cwd)))
        if top:
            return top
    cands = folders(limit=20)
    words = (ask or "").lower()
    for f in cands:
        n = f["name"].lower()
        if len(n) >= 3 and re.search(r"(?<![\w-])%s(?![\w-])" % re.escape(n), words):
            return f["path"]
    if cands:
        return cands[0]["path"]
    if cwd:
        return cwd  # repo_of says why it cannot be used
    raise UserError("Turbo works in a project that is a git repository; say which folder.")


# ---------------------------------------------------------------- normal mode: the agents of the last hours as lanes

LANE_GAP_S = 8 * 60       # a pause longer than this ends a stretch of work on a session's lane
LANE_TAIL = 4 * 1024 * 1024  # the most of a transcript read for its stretches (the end of it: the last hours)
_TS = re.compile(r'"timestamp":"([^"]+)"')
_PATHISH = re.compile(r"[^\s，。：:；;,()（）「」]*/[^\s，。：:；;,()（）「」]*")


def short_words(text, limit=40):
    """A few words for a lane from a long first message: its first sentence or clause, a path said by its file's
    name (proto-a, not design/frenzy/proto-a.html), cut at a word."""
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(t) <= limit and "/" not in t:
        return t.rstrip("。.")
    t = re.split(r"(?<=[。！？!?])|[。：:；;\n]|(?<=\.)\s|,\s|，", t, maxsplit=1)[0].strip()
    t = _PATHISH.sub(lambda m: os.path.splitext(m.group(0).rstrip("/").rsplit("/", 1)[-1])[0].strip("*"), t)
    t = re.sub(r"\s+", " ", t).strip(" ,，、-—\"'「。.")
    if len(t) <= limit:
        return t
    cut = t[:limit]
    sp = cut.rfind(" ")
    return (cut[:sp] if sp > limit // 2 else cut).rstrip(" ,，、") + "…"


def _lane_cache_path():
    return os.path.join(root(), "lanes-cache.json")


def activity(path, since, now, cache):
    """When a transcript was written, as stretches [[from, to, "work"], ...] since `since`: its timestamps, a pause
    longer than LANE_GAP_S between stretches. Read from its end (LANE_TAIL), remembered in `cache` by size."""
    try:
        st = os.stat(path)
    except (OSError, TypeError):
        return []
    hit = cache.get(path)
    if hit and hit.get("size") == st.st_size:
        stamps = hit["t"]
    else:
        try:
            with open(path, "rb") as f:
                f.seek(max(0, st.st_size - LANE_TAIL))
                buf = f.read().decode("utf-8", "replace")
        except OSError:
            return []
        seen = set()
        for m in _TS.finditer(buf):
            try:
                seen.add(int(datetime.datetime.fromisoformat(m.group(1).replace("Z", "+00:00")).timestamp()) // 60 * 60)
            except ValueError:
                continue
        stamps = sorted(seen)
        cache[path] = {"size": st.st_size, "t": stamps}
    segs = []
    for t in stamps:
        if t < since - 60:
            continue
        if segs and t - segs[-1][1] <= LANE_GAP_S:
            segs[-1][1] = t + 60
        else:
            segs.append([t, t + 60, "work"])
    for sg in segs:
        sg[1] = min(sg[1], now)
    return segs


def session_lanes(now=None, hours=8, limit=40, helpers_max=12):
    """The sessions of the last hours and the helpers they started, as lanes on the same time axis: the picture
    Turbo draws, for the work the person does without Turbo. A lane is named in a few words (the name Dispatch shows
    for the session, the title its agent gave it, else the start of its first message) and drawn as the stretches it
    worked; a helper (sub-agent) lane follows its session (the Timeline folds it into the session's lane), named by
    what its session asked it in a few words."""
    now = now or time.time()
    try:
        idx = D.load_index()
    except Exception:
        return []
    from activity import session_preferences, user_text
    try:
        prefs = session_preferences(D.DISPATCH_DIR)
    except Exception:  # no preferences database yet
        prefs = {}
    try:
        with open(_lane_cache_path(), encoding="utf-8") as f:
            cache = json.load(f)
        if not isinstance(cache, dict):
            cache = {}
    except (OSError, ValueError):
        cache = {}
    used = set()

    def ts(v):
        try:
            return datetime.datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
        except (TypeError, ValueError):
            return 0.0
    since = now - hours * 3600
    rows = []
    for key, e in idx.items():
        last = ts(e.get("last_ts")) or float(e.get("mtime") or 0)
        try:
            last = max(last, os.path.getmtime(key)) if os.path.isfile(key) else last  # the transcript itself is fresher than the index
        except OSError:
            pass
        first = ts(e.get("first_ts")) or last
        if last < since or not first:
            continue
        rows.append((key, e, max(first, since - 600), last))
    rows.sort(key=lambda r: -r[3])
    parents = [r for r in rows if not r[1].get("subagent")][:limit]

    def stretches(key, first, last, working):
        segs = activity(key, since, now, cache) if os.path.isfile(key) else []
        used.add(key)
        if not segs:
            segs = [[first, last, "work"]]
        if working:
            segs[-1][1] = now
        return segs

    def engine_name(agent):
        try:
            return E.get(agent).name if agent else ""
        except Exception:
            return agent or ""
    lanes = []
    for key, e, first, last in parents:
        sid = e.get("session_id") or key
        agent = e.get("agent") or ""
        working = now - last < RUNNING_S
        p = prefs.get("%s:%s" % (agent, sid)) or {}
        own = user_text(str(e.get("title") or ""))
        title = re.sub(r"\s+", " ", str(p.get("title_override") or own or "")).strip()
        title = title if title and len(title) <= 60 else short_words(title or e.get("first_prompt") or "")
        title = title or os.path.basename(e.get("cwd") or "") or "Session"
        segs = stretches(key, first, last, working)
        lane = {"id": sid, "name": title, "engine": agent, "engine_name": engine_name(agent), "status": "working" if working else "done",
                "segs": segs, "first": segs[0][0], "last": now if working else last, "cwd": e.get("cwd") or "",
                "project": os.path.basename(D.git_project_root(e.get("cwd") or "") or (e.get("cwd") or "").rstrip("/")), "kind": "session"}
        try:
            said = {s.get("path"): s.get("description") or "" for s in D.subagents_of(key, agent)} if os.path.isfile(key) else {}
        except Exception:
            said = {}
        subs = []
        for k2, e2, f2, l2 in rows:
            if e2.get("subagent") and (e2.get("parent") in (sid, key)):
                w2 = now - l2 < RUNNING_S
                s2 = stretches(k2, f2, l2, w2)
                subs.append({"id": e2.get("session_id") or k2, "name": short_words(said.get(k2) or e2.get("title") or e2.get("first_prompt") or ""),
                             "engine": e2.get("agent") or "", "engine_name": engine_name(e2.get("agent")), "status": "working" if w2 else "done",
                             "segs": s2, "first": s2[0][0], "last": now if w2 else l2, "parent": sid, "kind": "helper", "project": lane["project"]})
        subs.sort(key=lambda x: x["segs"][0][0])
        for i, h in enumerate(subs[-helpers_max:], 1):
            h["name"] = h["name"] or "Helper %d" % i
        lane["helpers"] = len(subs)
        if any(h["status"] == "working" for h in subs) and lane["status"] != "working":
            lane["status"] = "working"  # its helper is at it: the session is not done
            lane["last"] = now
        lanes.append(lane)
        lanes.extend(subs[-helpers_max:])
    try:
        _write_json(_lane_cache_path(), {k: v for k, v in cache.items() if k in used})
    except OSError:
        pass
    return lanes


# ---------------------------------------------------------------- the delivery page

def report_line(text):
    """The first plain sentence of a part's report: no headings, no list marks, no "What I changed" labels."""
    for line in (text or "").splitlines():
        t = re.sub(r"^[#>*\-\s\d.]+", "", line).strip()
        t = re.sub(r"(?i)^(part \d+ report|report|what i changed|summary)\s*[:\-—]*\s*", "", t).strip()
        if len(t) >= 6:
            return _sentence(t)
    return ""


def write_page(run):
    s = run.get("summary") or {}
    esc = lambda t: (str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    rows = "".join("<tr><td>%d</td><td>%s</td><td>%s</td><td>%s</td></tr>" % (
        p["n"], esc(p["name"]), esc(p.get("status")), esc(report_line(_read(p["report"]))))
        for p in run["parts"])
    nums = [(dur_words(s.get("minutes") or 0), "one part after another: about %s" % dur_words(s.get("sequential_minutes") or 0)),
            (parts_words(s.get("parts") or 0), "%d files, %d commits" % (s.get("files") or 0, s.get("commits") or 0))]
    if s.get("used_pct") is not None:
        nums.append(("%d%%" % round(s["used_pct"]), "of the allowance, planned %s%%" % (run.get("planned_pct") or 0)))
    where = ("Brought into %s as commit %s." % (esc(run.get("base_branch") or "your branch"), esc((s.get("landed") or "")[:12])) if s.get("landed")
             else "On its own branch %s in %s." % (esc(run["combine_branch"]), esc(run["repo"])))
    html = """<!doctype html><meta charset="utf-8"><title>Turbo · %s</title>
<style>body{font:14px/1.55 -apple-system,system-ui,"PingFang SC",sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#292524;background:#fafaf9}
h1{font-size:17px;font-weight:600}table{border-collapse:collapse;width:100%%}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #e7e5e4;vertical-align:top;font-weight:400}
th{font-size:12px;color:#78716c}.n{font-size:17px;font-weight:600}.k{color:#78716c;font-size:12px}.row{display:flex;gap:32px;margin:20px 0}
@media (prefers-color-scheme:dark){body{background:#1c1917;color:#e7e5e4}td,th{border-color:#44403c}.k,th{color:#a8a29e}}</style>
<h1>%s</h1><p class="k">%s</p>
<div class="row">%s</div>
<p>%s</p><table><tr><th>#</th><th>Part</th><th>State</th><th>From its report</th></tr>%s</table>
<p class="k">%s</p>""" % (
        esc(run["title"]), esc(run["title"]), esc(run["ask"][:400]),
        "".join('<div><div class="n">%s</div><div class="k">%s</div></div>' % (esc(a), esc(b)) for a, b in nums),
        "Nothing is left for you." if not s.get("left") else "Left for you: " + esc(", ".join(s["left"])), rows, where)
    path = os.path.join(run_dir(run["id"]), "delivery.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    return path


# ---------------------------------------------------------------- commands

def _out(a, obj, text):
    if getattr(a, "json", False):
        print(json.dumps(obj, ensure_ascii=False, indent=1))
    else:
        print(text)


def latest_run(active_only=False):
    for rid in run_ids():
        try:
            r = load(rid)
        except UserError:
            continue
        if not active_only or r.get("state") in ACTIVE:
            return r
    return None


def shown_run(now=None):
    """The run the Timeline tab shows: one going or planned; a split that failed in the last hour (until dismissed);
    a run that ran and ended in the last 12 hours. A plan dismissed before Start is not shown again."""
    now = now or time.time()
    r = latest_run()
    if not r:
        return None
    st = r.get("state")
    if st in ACTIVE:
        return view(ensure_runner(r["id"]), now)
    if st == "failed" and (r.get("created_at") or 0) > now - 3600:
        return view(r, now)
    if st in ("done", "cancelled") and r.get("started_at") and (r.get("done_at") or 0) > now - 12 * 3600:
        return view(r, now)
    return None


def _target(a):
    if getattr(a, "run", ""):
        return a.run
    r = latest_run(active_only=True)
    if not r:
        raise UserError("There is no Turbo run going.")
    return r["id"]


def _part_key(x):
    try:
        return int(x)
    except (TypeError, ValueError):
        return str(x)


def command(a):
    act = a.turbo_cmd
    now = time.time()
    if act == "config":
        if a.engine or a.model or a.effort or a.clear:
            if a.engine and a.engine not in engines_ok():
                raise _not_ok(a.engine)
            c = config_save(engine=a.engine or (None if not a.clear else ""), model=a.model if a.model or a.engine or a.clear else None,
                            effort=a.effort if a.effort or a.engine or a.clear else None)
        else:
            c = config_load()
        return _out(a, c, "Turbo parts run on %s%s." % (E.get(c.get("engine") or "claude").plan_name, (" (%s)" % c["model"]) if c.get("model") else ""))
    if act == "plan":
        engine, model, effort = engine_choice(a.engine, a.model, a.effort)
        run = new_run(a.text, pick_folder(a.cwd, a.text), engine, model, effort, a.at_a_time, a.task, a.title)
        if a.usage_file:
            run["usage_file"] = os.path.abspath(a.usage_file)
        if a.parts:
            raw = sys.stdin.read() if a.parts == "-" else _read(a.parts)
            title, parts = parse_parts(raw)
            set_parts(run, parts, title)
            run["state"] = "planned"
            event(run, "planned", "Split into %s" % parts_words(len(parts)))
            save(run)
        else:
            save(run)
            if not a.no_split:
                spawn_runner(run)
                save(run)
        v = view(run, now)
        return _out(a, v, "%s · %s · %s" % (run["id"], run["state"], parts_words(len(run["parts"]))))
    if act == "list":
        rows = []
        for rid in run_ids()[: a.limit]:
            try:
                r = load(rid)
            except UserError:
                continue
            row = {k: r.get(k) for k in ("id", "title", "state", "project", "repo", "created_at", "started_at", "done_at", "engine")}
            row.update(combined=sum(1 for p in r["parts"] if p.get("status") == "combined"), total=len(r["parts"]))
            if r.get("state") in ACTIVE or (r.get("state") == "done" and now - (r.get("done_at") or 0) < 3600):
                row.update(live_row(r, now))
            rows.append(row)
        return _out(a, rows, "\n".join("%s  %-10s %d/%d  %s" % (r["id"], r["state"], r["combined"], r["total"], r["title"]) for r in rows) or "No Turbo runs yet.")
    if act == "timeline":
        res = {"run": shown_run(now), "lanes": session_lanes(now) + worker_lanes(now), "now": now}
        return _out(a, res, "%s; %d other agents today" % (res["run"]["title"] if res["run"] else "No Turbo run", len(res["lanes"])))
    if act == "status":
        rid = a.run or ((latest_run() or {}).get("id"))
        if not rid:
            return _out(a, None, "No Turbo runs yet.")
        run = ensure_runner(rid)
        v = view(run, now)
        return _out(a, v, "%s · %s · %d of %d combined · %s" % (run["title"], run["state"], v["combined"], v["total"], v["plan"]["done_words"]))
    if act == "run":
        return runner_loop(a.run, once=a.once)
    rid = _target(a)
    if act == "replan":
        def f(r):
            if (a.cwd or a.engine or a.model) and r["state"] not in ("planned", "planning", "failed"):
                raise UserError("The folder and the agent can change only before Start.")
            if a.cwd:
                repo, branch, sha = repo_of(pick_folder(a.cwd, ""))
                if repo != r["repo"]:
                    if r["state"] == "planning":
                        raise UserError("Wait a moment: the job is still being split.")
                    # another project: the job is split again by looking at that one
                    r.update(repo=repo, project=os.path.basename(repo), base_branch=branch, base_sha=sha, parts=[], shared=[],
                             state="planning", error="")
                    r["resplit"] = True
            if a.engine or a.model:
                eng, model, effort = engine_choice(a.engine or r.get("engine"), a.model, a.effort)
                r.update(engine=eng, model=model, effort=effort, rate=learned_rate(eng), pace=learned_pace(eng))
            if a.usage_file:
                r["usage_file"] = os.path.abspath(a.usage_file)
            if a.at_a_time:
                r["slots"] = max(1, min(SLOTS_MAX, a.at_a_time))
            if a.parts:
                raw = sys.stdin.read() if a.parts == "-" else _read(a.parts)
                title, parts = parse_parts(raw)
                if r["state"] not in ("planned", "failed"):
                    raise UserError("The parts can change only before Start.")
                set_parts(r, parts, title)
                r["state"] = "planned"
            if r["state"] == "planned":
                pv = plan_view(r)
                r["planned_pct"], r["planned_done_at"] = pv["planned_pct"], pv["done_at"]
            return r
        run = change(rid, f)
        if run.pop("resplit", False):
            run = change(rid, lambda r: (r.pop("resplit", None), spawn_runner(r)) and None)
        return _out(a, view(run, now), "%d at a time · %s" % (min(run["slots"], len(run["parts"]) or run["slots"]), plan_view(run)["done_words"]))
    if act == "start":
        run = change(rid, lambda r: start_run(r, task=not a.no_task))
        return _out(a, view(run, now), "Started %s" % run["id"])
    if act == "step":
        key = _part_key(a.part)
        def f(r):
            who = part_of(r, key) if isinstance(key, int) else next((x for x in r["finals"] if x["id"] == key), None)
            if who is None:
                raise UserError("No such part.")
            who["said"] = re.sub(r"\s+", " ", a.text).strip()[:120]
            who["said_at"] = time.time()
        change(rid, f)
        return _out(a, {"ok": True}, "Noted.")
    if act == "ask":
        def f(r):
            p = part_of(r, int(a.part))
            p["ask"] = {"question": re.sub(r"\s+", " ", a.text).strip()[:400], "options": [o[:60] for o in (a.option or [])][:4], "at": time.time()}
        change(rid, f)
        return _out(a, {"ok": True}, "Asked. End your turn now; you are resumed with the answer.")
    if act == "answer":
        key = _part_key(a.part)

        def f(r):
            if isinstance(key, str):
                fl = next((x for x in r["finals"] if x["id"] == key), None)
                if not fl or fl.get("status") != "needs":
                    raise UserError("Nothing is asked there.")
                if fl["id"] == "land":
                    if re.match(r"(?i)leave", a.text):
                        fl.update(status="skipped", ended_at=time.time())
                        event(r, "answered", "Left on its own branch")
                    else:
                        land(r, by_hand=True)
                if r["state"] == "combining" and all(x["status"] in ("done", "skipped") for x in r["finals"]):
                    finish(r, time.time())
                return
            p = part_of(r, key)
            if p.get("status") == "failed":
                if re.match(r"(?i)leave|skip", a.text):
                    p.update(status="skipped", ended_at=time.time())
                    event(r, "answered", "Left out: %s" % p["name"], p["n"])
                else:
                    p.update(status="waiting", attempts=[], retry="Try this part again from where it is.")
                    event(r, "answered", "Trying again: %s" % p["name"], p["n"])
                return
            if p.get("status") != "needs" or not p.get("ask"):
                raise UserError("%s is not waiting for an answer." % p["name"])
            if p["ask"].get("kind") == "conflict":
                if re.match(r"(?i)leave|skip", a.text):
                    p.update(status="skipped", ended_at=time.time())
                else:
                    p.update(status="done", fix_tries=0)
                p["ask"]["answered"] = True
                return
            p["ask"]["answered"] = True
            p["answer"] = a.text.strip()[:2000]
            p["status"] = "waiting"
            event(r, "answered", "You answered %s: %s" % (p["name"], p["answer"][:80]), p["n"])
        run = change(rid, f)
        ensure_runner(rid)
        return _out(a, view(run, now), "Answered.")
    if act == "add":
        def f(r):
            if r["state"] in ("done", "cancelled", "combining"):
                raise UserError("This run is %s; parts can no longer be added." % r["state"])
            n = max([p["n"] for p in r["parts"]] or [0]) + 1
            name = re.sub(r"\s+", " ", a.text).strip()
            p = {"n": n, "name": name[:80], "full": name[:400], "files": [], "after": [], "est": a.minutes or 30, "status": "waiting",
                 "branch": "turbo/%s/part-%d" % (r["id"], n), "report": os.path.join(run_dir(r["id"]), "parts", str(n), "report.md"), "added": True}
            r["parts"].append(p)
            if r["state"] == "planned":
                set_parts(r, r["parts"])
            event(r, "added", "Added: %s" % p["name"], n)
        run = change(rid, f)
        return _out(a, view(run, now), "Added.")
    if act == "switch":
        if not a.engine:
            raise UserError("Say which agent goes on: dispatch turbo switch <run> --engine claude|codex|opencode.")

        def f(r):
            if r["state"] != "paused":
                raise UserError("Only a stopped run goes on with another agent; this one is %s." % r["state"])
            eng, model, effort = engine_choice(a.engine, a.model, a.effort)
            if eng == r["engine"] and model == (r.get("model") or ""):
                raise UserError("The run is already on %s." % _name(eng))
            import engines
            if not engines.which(eng):
                raise UserError("%s is not installed on this Mac." % _name(eng))
            switch_engine(r, eng, model, effort, time.time())
            return r
        run = change(rid, f)
        ensure_runner(rid)
        return _out(a, view(run, now), "Going on with %s." % _name(run["engine"]))
    if act in ("pause", "resume", "cancel", "keep", "land"):
        def f(r):
            if act == "pause":
                if r["state"] not in ("running", "combining"):
                    raise UserError("This run is %s." % r["state"])
                r["state"], r["paused_by_hand"] = "paused", True
                for p in r["parts"]:
                    if p.get("status") in ("working", "fixing") and p.get("copy"):
                        open(os.path.join(p["copy"], ".turbo-stop"), "w").close()
                event(r, "paused", "You paused it: the running parts finish their step and stop.")
            elif act == "resume":
                if r["state"] != "paused":
                    raise UserError("This run is not paused.")
                r["paused_by_hand"] = False
                q = r.setdefault("quota", {})
                q["paused"] = False
                q.pop("resume_at", None)
                r["state"] = "running"
                event(r, "resumed", "Carrying on.")
            elif act == "cancel":
                for p in r["parts"] + r["finals"]:
                    stop_proc(p)
                    if p.get("status") in ("working", "fixing", "starting", "waiting", "needs", "paused"):
                        p["status"] = "cancelled" if p.get("started_at") else "skipped"
                r["state"] = "cancelled"
                r["done_at"] = time.time()
                event(r, "cancelled", "You stopped the run. What was combined is on branch %s." % r["combine_branch"])
                settle_task(r)
            elif act == "keep":
                r["hold_slots"] = True
                q = r.setdefault("quota", {})
                q["slowed"] = False
                event(r, "keep", "You kept %d at a time." % r["slots"])
            elif act == "land":
                land(r, by_hand=True)
                if all(x["status"] in ("done", "skipped") for x in r["finals"]):
                    finish(r, time.time())
            return r
        run = change(rid, f)
        if act == "resume":
            ensure_runner(rid)
        return _out(a, view(run, now), "%s: %s" % (act, run["state"]))
    raise UserError("Unknown turbo command.")


def start_run(r, spawn=True, task=True):
    if r["state"] != "planned":
        raise UserError("This run is %s; only a plan can start." % r["state"])
    r["combine_copy"] = make_copy(r, "combined", r["combine_branch"], r["base_sha"])
    r["state"] = "running"
    r["started_at"] = time.time()
    r["quota"] = {}
    event(r, "start", ("Started 1 part" if len(r["parts"]) == 1 else "Started %d parts, %d at a time" % (len(r["parts"]), min(r["slots"], len(r["parts"])))))
    if not r.get("task") and task:
        r["task"] = make_task(r)
        r["own_task"] = bool(r["task"])
    if spawn:
        spawn_runner(r)
    return r


def _dispatch(*args, cwd=None):
    """One `dispatch` command for the run's task on the board: (ok, its output). Best effort, never raises."""
    try:
        r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), *args],
                           capture_output=True, text=True, timeout=120, cwd=cwd, env=dict(D.child_env(), DISPATCH_DIR=D.DISPATCH_DIR))
        return r.returncode == 0, r.stdout or ""
    except (OSError, subprocess.SubprocessError):
        return False, ""


def make_task(run):
    """The run's own task on the board, so its one delivery page hangs somewhere; best effort."""
    ok, out = _dispatch("begin", "Turbo: " + run["title"][:70], "--force", "-P", run["project"], "--json",
                        "-d", "Turbo run %s: %s at the same time.\n\nThe person's words: %s" % (run["id"], parts_words(len(run["parts"])), run["ask"][:1500]))
    try:
        return (json.loads(out[out.find("{"):]) or {}).get("id") or "" if "{" in out else ""
    except ValueError:
        return ""


def settle_task(run):
    """The run's task on the board follows the run (task-1wkxk): when the run ends, its delivery page and the commit it
    was brought in as hang on the task, and the task Turbo made for itself is closed with what happened, so the board
    does not say "in progress" for a run the Timeline says is done. A task the run was only given (`plan --task`) is
    someone else's to close: it gets a note. Once per run; best effort (the board may be out of reach)."""
    task = run.get("task")
    if not task or run.get("task_settled") or run.get("state") not in ("done", "cancelled"):
        return
    run["task_settled"] = True
    s = run.get("summary") or {}
    landed = (s.get("landed") or "")[:12]
    if run["state"] == "done":
        what = ["--file", run["page"]] if run.get("page") and os.path.isfile(run["page"]) else []
        what += ["--commit", landed] if landed else []
        if what:
            _dispatch("task", "deliver", task, *what, cwd=run["repo"])
        n, total = s.get("combined") or 0, s.get("parts") or len(run["parts"])
        where = ("brought into %s as %s" % (run.get("base_branch") or "your branch", landed) if landed
                 else "on its own branch %s" % run["combine_branch"])
        reason = "Turbo: %d of %s combined in %s, %s." % (n, parts_words(total), dur_words(s.get("minutes") or 0), where)
        if s.get("left"):
            reason += " Left for you: %s." % ", ".join(s["left"])
        checked = all(f["status"] == "done" for f in run.get("finals") or [] if f["id"] in ("tests", "check"))
        if checked:
            reason += " Its tests and a second check by another agent ran."
    else:
        n = sum(1 for p in run["parts"] if p.get("status") == "combined")
        reason = "Turbo stopped by you: %d of %s combined, on branch %s." % (n, parts_words(len(run["parts"])), run["combine_branch"])
        checked = False
    if run.get("own_task"):
        _dispatch("done", task, "--reason", reason, *(["--verified"] if checked else []), cwd=run["repo"])
    else:
        _dispatch("log", task, reason, cwd=run["repo"])


def add_parser(sub, d):
    s = sub.add_parser("turbo", help="Turbo: a big job split into parts that run at the same time in their own copies of the project, combined at the end; "
                                     "plan / replan / start / status / timeline / list / step / ask / answer / add / pause / resume / cancel / keep / land / switch / config")
    s.add_argument("turbo_cmd", choices=["plan", "replan", "start", "status", "timeline", "list", "step", "ask", "answer", "add",
                                         "pause", "resume", "cancel", "keep", "land", "switch", "config", "run"])
    s.add_argument("args", nargs="*", help="plan: the job; status/start/…: the run; step/ask/answer: run, part, text; add: run, text")
    s.add_argument("--cwd", default="", help="plan/replan: the project folder (default: here when it is a git project, else the recent "
                                                "project the job names, else the last one worked in)")
    s.add_argument("--parts", default="", help="plan/replan: the parts as JSON (a file, or - for stdin) instead of letting a model split the job")
    s.add_argument("--engine", default="", help="plan/replan/config/switch: which agent does the parts (claude, codex, opencode; default: dispatch turbo config, else claude)")
    s.add_argument("--usage-file", dest="usage_file", default="", help=argparse_hidden())
    s.add_argument("--model", default="")
    s.add_argument("--effort", default="")
    s.add_argument("--at-a-time", dest="at_a_time", type=int, default=0, help="how many parts run at once (default 4)")
    s.add_argument("--task", default="", help="plan: the task the run belongs to")
    s.add_argument("--title", default="")
    s.add_argument("--text", dest="text_opt", default=None, help="plan/answer/add/step/ask: the words, instead of after the run and part "
                                                               "(write --text=… for words that start with a dash)")
    s.add_argument("--option", action="append", help="ask: a choice to offer (repeatable)")
    s.add_argument("--minutes", type=int, default=0, help="add: the estimate")
    s.add_argument("--limit", type=int, default=20)
    s.add_argument("--no-split", action="store_true", help=argparse_hidden())
    s.add_argument("--no-task", action="store_true", help="start: do not put the run on the board")
    s.add_argument("--once", action="store_true", help=argparse_hidden())
    s.add_argument("--clear", action="store_true", help="config: back to Claude with its default model")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=lambda a: sys.exit(run(a, d)))


def argparse_hidden():
    import argparse
    return argparse.SUPPRESS


def _bind(a):
    """Positional words → the fields each command reads."""
    w = list(a.args or [])
    a.run, a.part, a.text = "", "", ""
    act = a.turbo_cmd
    if getattr(a, "text_opt", None) is not None:
        w.append(a.text_opt)
    if act == "plan":
        a.text = " ".join(w)
    elif act in ("step", "ask", "answer"):
        if len(w) < 3:
            raise UserError("Say the run, the part and the words: dispatch turbo %s <run> <part> \"…\"" % act)
        a.run, a.part, a.text = w[0], w[1], " ".join(w[2:])
    elif act == "add":
        if w and RUN_ID.fullmatch(w[0]):
            a.run, a.text = w[0], " ".join(w[1:])
        else:
            a.text = " ".join(w)
        if not a.text.strip():
            raise UserError("Say what to add.")
    else:
        a.run = w[0] if w else ""
    if a.at_a_time == 0 and act == "plan":
        a.at_a_time = SLOTS_DEFAULT
    return a


def run(a, d):
    global D
    D = d
    try:
        if a.turbo_cmd == "_exec":
            return exec_spec(a.args[0])
        _bind(a)
        command(a)
        return 0
    except UserError as e:
        if getattr(a, "json", False):
            print(json.dumps({"ok": False, "message": str(e)}, ensure_ascii=False))
        else:
            print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    # the agent wrapper: python turbo.py _exec <spec>
    if len(sys.argv) == 3 and sys.argv[1] == "_exec":
        sys.exit(exec_spec(sys.argv[2]))
