# -*- coding: utf-8 -*-
"""Scheduled jobs other tools set up on this Mac, read-only, for the Automations page.

`dispatch automations discover --json` lists what Hermes, OpenClaw, Codex, Claude (the desktop app's
scheduled tasks and Claude Code's saved loops), launchd and cron run on a schedule when what they run
is an agent: what each one does in plain words, when it runs next, its last runs and their output.
`--remote` asks the other Macs in hosts.json the same, over the ssh Dispatch already uses: this file
is sent to that Mac's python3 on stdin, so it works whatever Dispatch version that Mac has.

Nothing here writes to those tools: files are opened for reading, SQLite in read-only mode,
`launchctl list` and `crontab -l` only list. Changing a job is left to the tool that owns it.

Learned from Orca (github.com/stablyai/orca, MIT, Copyright (c) 2026 Lovecast Inc.):
src/main/automations/external-manager-discovery.ts, external-job-mappers.ts and hermes-cron-output*.ts
(where Hermes and OpenClaw keep their jobs and runs, how a Hermes output file says it failed).
This file is stdlib only and must stay so (it runs on the other Mac as a bare script).
"""
import datetime as _dt
import glob
import json
import os
import plistlib
import re
import shlex
import sqlite3
import subprocess
import sys
import time

RUNS_KEPT = 5            # last runs per job in the answer
OUTPUT_CAP = 12000       # characters of one run's output
PREVIEW_CAP = 180
PROMPT_CAP = 4000

# Agents a launchd job or a cron line may start: (word in the command, agent id, name).
AGENT_WORDS = [
    ("claude", "claude", "Claude Code"), ("codex", "codex", "Codex"), ("hermes", "hermes", "Hermes"),
    ("openclaw", "openclaw", "OpenClaw"), ("opencode", "opencode", "OpenCode"), ("gemini", "gemini", "Gemini CLI"),
    ("aider", "aider", "Aider"), ("goose", "goose", "Goose"), ("cursor-agent", "cursor", "Cursor"),
    ("amp", "amp", "Amp"), ("qwen", "qwen", "Qwen Code"), ("kimi", "kimi", "Kimi"), ("droid", "droid", "Droid"),
    ("crush", "crush", "Crush"), ("copilot", "copilot", "Copilot CLI"),
]
AGENT_NAMES = {a: n for _, a, n in AGENT_WORDS}
# Our own LaunchAgents are Dispatch itself, not someone's automation.
OWN_LABELS = re.compile(r"^(dev\.dispatch|dev\.schaefer\.(dispatch|dolt|chatd|sync|mobile|serve|browserd|notify))", re.I)
DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]


def home():
    return os.path.expanduser("~")


# ---------------------------------------------------------------- small helpers

def _s(v):
    return v.strip() if isinstance(v, str) and v.strip() else None


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _epoch(v):
    """Seconds since 1970 from an ISO string, epoch seconds or epoch milliseconds; None when unreadable."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) / 1000.0 if v > 1e11 else float(v)
    s = _s(v)
    if not s:
        return None
    if re.fullmatch(r"\d+(\.\d+)?", s):
        return _epoch(float(s))
    try:
        d = _dt.datetime.fromisoformat(s.replace("Z", "+00:00").replace(" ", "T", 1))
    except ValueError:
        return None
    if d.tzinfo is None:
        return time.mktime(d.timetuple()) + d.microsecond / 1e6
    return d.timestamp()


def _read(path, cap=None):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read(cap) if cap else f.read()
    except OSError:
        return None


def _read_tail(path, cap=OUTPUT_CAP):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - cap * 2))
            text = f.read().decode("utf-8", errors="replace")
        return text[-cap:]
    except OSError:
        return None


def _json(path):
    text = _read(path)
    if text is None:
        return None
    return json.loads(text)


def _sqlite(path):
    """A read-only connection that never creates or changes the file (and no -wal side files)."""
    uri = "file:" + path.replace("?", "%3f").replace("#", "%23") + "?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=1)


def _cap(text, n):
    if text is None:
        return None
    return text if len(text) <= n else text[: n - 1] + "…"


def _strip_frontmatter(text):
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text or "", re.S)
    if not m:
        return {}, text or ""
    meta = {}
    for line in m.group(1).splitlines():
        k, sep, v = line.partition(":")
        if sep and k.strip() and not line.startswith((" ", "\t")):
            meta[k.strip()] = v.strip().strip("'\"")
    return meta, text[m.end():]


def plain(text, cap=PREVIEW_CAP):
    """One line of readable words from a prompt or an output: no markdown marks, code blocks or tags."""
    if not text:
        return ""
    t = re.sub(r"```.*?(```|$)", " ", text, flags=re.S)
    t = re.sub(r"<[^>\n]{1,200}>", " ", t)
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", t)
    t = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"(^|\n)\s{0,3}(#{1,6}|[-*+>]|\d+[.)])\s+", r"\1", t)
    t = re.sub(r"[*_`#|]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return _cap(t, cap)


CONTEXT_SENTENCE = re.compile(r"^(现在是|当前时间|今天是|now it is|it is now|it's now|the time is|current time|today is)", re.I)


def does(prompt, fallback=""):
    """What a job does in one sentence: the prompt's first sentence that says what to do (a leading
    "It is now 7:00 AM." only sets the scene), or the fallback."""
    p = plain(prompt, 800)
    if not p:
        return fallback
    parts = [x.strip() for x in re.split(r"(?<=[。！？])|(?<=[.!?])(?=\s|$)", p) if x and x.strip()]
    while len(parts) > 1 and CONTEXT_SENTENCE.match(parts[0]) and len(parts[0]) < 60:
        parts.pop(0)
    first = parts[0] if parts else p
    if len(first) < 12 and len(parts) > 1:
        first = first + (" " if first[-1:] in ".!?" else "") + parts[1]
    return _cap(first, 160)


# ---------------------------------------------------------------- schedules in plain words

def _clock(h, m):
    suffix = "AM" if h < 12 else "PM"
    hh = h % 12 or 12
    return f"{hh}:{m:02d} {suffix}"


def _field(spec, lo, hi, names=None):
    """The set of values a cron field allows; None for *."""
    spec = spec.strip().lower()
    if spec in ("*", "?"):
        return None
    out = set()
    for part in spec.split(","):
        step = 1
        if "/" in part:
            part, st = part.split("/", 1)
            step = int(st)
        if part in ("*", ""):
            a, b = lo, hi
        elif "-" in part:
            x, y = part.split("-", 1)
            a, b = _val(x, names), _val(y, names)
        else:
            a = _val(part, names)
            b = hi if step > 1 else a
        if a < lo or b > hi or a > b or step < 1:
            raise ValueError(spec)
        out.update(range(a, b + 1, step))
    return out


def _val(x, names):
    if names and x[:3] in names:
        return names.index(x[:3])
    return int(x)


MACROS = {"@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0",
          "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *"}


def parse_cron(expr):
    """(minutes, hours, days, months, weekdays) sets (None = any) of a 5-field cron line; raises ValueError."""
    expr = MACROS.get(expr.strip().lower(), expr.strip())
    parts = expr.split()
    if len(parts) == 6:  # seconds first (some tools write it): drop them
        parts = parts[1:]
    if len(parts) != 5:
        raise ValueError(expr)
    mins = _field(parts[0], 0, 59)
    hours = _field(parts[1], 0, 23)
    days = _field(parts[2], 1, 31)
    months = _field(parts[3], 1, 12, ["", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])
    wd = _field(parts[4].replace("7", "0") if parts[4].strip() == "7" else parts[4], 0, 7, ["sun", "mon", "tue", "wed", "thu", "fri", "sat"])
    if wd is not None and 7 in wd:
        wd = (wd - {7}) | {0}
    return mins, hours, days, months, wd


def next_cron(expr, after=None):
    """Epoch seconds of the next minute (local time) the cron line fires after `after`; None if none within a year."""
    try:
        mins, hours, days, months, wd = parse_cron(expr)
    except (ValueError, IndexError):
        return None
    t = _dt.datetime.fromtimestamp(after if after is not None else time.time()).replace(second=0, microsecond=0) + _dt.timedelta(minutes=1)
    end = t + _dt.timedelta(days=366)
    while t < end:
        if months is not None and t.month not in months:
            t = (t.replace(day=1, hour=0, minute=0) + _dt.timedelta(days=32)).replace(day=1)
            continue
        dom_ok = days is None or t.day in days
        dow_ok = wd is None or (t.isoweekday() % 7) in wd
        day_ok = (dom_ok or dow_ok) if (days is not None and wd is not None) else (dom_ok and dow_ok)
        if not day_ok:
            t = (t + _dt.timedelta(days=1)).replace(hour=0, minute=0)
            continue
        if hours is not None and t.hour not in hours:
            t = (t + _dt.timedelta(hours=1)).replace(minute=0)
            continue
        if mins is not None and t.minute not in mins:
            t += _dt.timedelta(minutes=1)
            continue
        return time.mktime(t.timetuple())
    return None


def _join(words):
    words = list(words)
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]


def say_cron(expr):
    """A cron line as a person would say it: 'Every day at 9:00 AM', 'Weekdays at 6:30 PM', 'Every 15 minutes'."""
    try:
        mins, hours, days, months, wd = parse_cron(expr)
    except (ValueError, IndexError):
        return f"Custom schedule ({expr.strip()})"
    raw = MACROS.get(expr.strip().lower(), expr.strip()).split()
    raw = raw[1:] if len(raw) == 6 else raw
    if days is None and months is None and wd is None:
        if hours is None:
            if mins is None:
                return "Every minute"
            if raw and raw[0].startswith("*/"):
                n = int(raw[0][2:])
                return "Every minute" if n == 1 else f"Every {n} minutes"
            if len(mins) == 1:
                m = next(iter(mins))
                return "Every hour, on the hour" if m == 0 else f"Every hour at :{m:02d}"
        if raw[1].startswith("*/") and mins is not None and len(mins) == 1:
            n = int(raw[1][2:])
            return "Every hour" if n == 1 else f"Every {n} hours"
    if hours is not None and mins is not None and len(mins) == 1 and len(hours) > 4 and months is None and days is None \
            and sorted(hours) == list(range(min(hours), max(hours) + 1)):
        m = next(iter(mins))
        span = f"from {_clock(min(hours), m)} to {_clock(max(hours), m)}"
        every = "Every hour" if m == 0 else f"Every hour at :{m:02d}"
        if wd is None:
            return f"{every} {span}"
        if wd == {1, 2, 3, 4, 5}:
            return f"{every} {span} on weekdays"
    if hours is not None and mins is not None and len(hours) * len(mins) <= 4:
        at = "at " + _join(_clock(h, m) for h in sorted(hours) for m in sorted(mins))
        if months is None and days is None:
            if wd is None:
                return f"Every day {at}"
            if wd == {1, 2, 3, 4, 5}:
                return f"Weekdays {at}"
            if wd == {0, 6}:
                return f"Weekends {at}"
            return f"Every {_join(DAYS[d] for d in sorted(wd))} {at}"
        if months is None and wd is None and len(days) == 1:
            d = next(iter(days))
            return f"Monthly on the {d}{_ordinal(d)} {at}"
    return f"Custom schedule ({expr.strip()})"


def _ordinal(n):
    return "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")


def say_every(seconds):
    s = int(seconds or 0)
    if s <= 0:
        return "Repeats"
    for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60)):
        if s % size == 0:
            n = s // size
            return f"Every {unit}" if n == 1 else f"Every {n} {unit}s"
    return f"Every {s} seconds"


def say_once(at):
    if at is None:
        return "Once"
    return "Once, " + _dt.datetime.fromtimestamp(at).strftime("%b %-d at ") + _clock(*_hm(at))


def _hm(at):
    d = _dt.datetime.fromtimestamp(at)
    return d.hour, d.minute


def launchd_cron(cal):
    """StartCalendarInterval (a dict or a list of dicts) as cron lines."""
    items = cal if isinstance(cal, list) else [cal]
    out = []
    for c in items:
        if not isinstance(c, dict):
            continue
        out.append(" ".join(str(c[k]) if isinstance(c.get(k), int) else "*" for k in ("Minute", "Hour", "Day", "Month", "Weekday")))
    return out


def rrule_cron(rrule):
    """A Codex RRULE (FREQ=DAILY;BYHOUR=9;BYMINUTE=0, FREQ=WEEKLY;BYDAY=MO,…) as (cron line or None, words)."""
    kv = dict(p.split("=", 1) for p in (rrule or "").upper().split(";") if "=" in p)
    freq, n = kv.get("FREQ", ""), int(kv.get("INTERVAL", "1") or 1)
    mins = kv.get("BYMINUTE", "0")
    hours = kv.get("BYHOUR")
    days = kv.get("BYDAY")
    codes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
    if freq == "MINUTELY":
        return None, say_every(60 * n)
    if freq == "HOURLY" and not hours:
        return (f"{mins} */{n} * * *" if n > 1 else f"{mins} * * * *"), say_every(3600 * n)
    if freq in ("DAILY", "WEEKLY", "HOURLY") and hours and n == 1:
        wd = "*"
        if days:
            wd = ",".join(str(codes.index(d[-2:])) for d in days.split(",") if d[-2:] in codes)
        expr = f"{mins} {hours} * * {wd}"
        return expr, say_cron(expr)
    if freq == "DAILY":
        return None, "Every day" if n == 1 else f"Every {n} days"
    if freq == "WEEKLY":
        return None, "Every week" if n == 1 else f"Every {n} weeks"
    return None, f"Custom schedule ({rrule})" if rrule else "Schedule unknown"


# ---------------------------------------------------------------- one job, one run

def job(source, jid, name, **kw):
    """A job row; every source fills the same keys."""
    row = {"id": f"{source}:{jid}", "source": source, "source_label": SOURCE_LABELS.get(source, source),
           "agent": kw.pop("agent", source), "name": name, "does": "", "prompt": None, "schedule": "",
           "schedule_raw": None, "enabled": True, "state": "scheduled", "next_run": None, "last_run": None,
           "last_status": None, "last_error": None, "workdir": None, "where": None, "manage": "",
           "note": None, "run_count": 0, "runs": []}
    row.update(kw)
    row["agent_label"] = AGENT_NAMES.get(row["agent"], SOURCE_LABELS.get(row["agent"], row["agent"]))
    row["prompt"] = _cap(row.get("prompt"), PROMPT_CAP)
    runs = sorted(row["runs"], key=lambda r: r.get("at") or 0, reverse=True)
    row["run_count"] = max(row.get("run_count") or 0, len(runs))
    row["runs"] = runs[:RUNS_KEPT]
    if runs and not row["last_run"]:
        row["last_run"] = runs[0].get("at")
    if runs and not row["last_status"]:
        row["last_status"] = runs[0].get("status")
    return row


def run(at, status, output=None, preview=None, error=None, path=None, title=None):
    status = {"completed": "ok", "success": "ok", "succeeded": "ok", "ok": "ok", "error": "failed", "failed": "failed",
              "failure": "failed", "running": "running", "claimed": "running", "skipped": "skipped"}.get((status or "").lower(), "unknown")
    out = _cap(output, OUTPUT_CAP) if output else None
    return {"at": at, "status": status, "title": title, "preview": preview if preview is not None else plain(out or error or ""),
            "output": out, "error": _cap(error, 600) if error else None, "path": path}


SOURCE_LABELS = {"hermes": "Hermes", "openclaw": "OpenClaw", "codex": "Codex", "claude": "Claude",
                 "claude-code": "Claude Code", "launchd": "Login items", "cron": "cron"}


# ---------------------------------------------------------------- Hermes (~/.hermes/cron)

def hermes_home():
    return os.environ.get("HERMES_HOME", "").strip() or os.path.join(home(), ".hermes")


def parse_hermes_output(text):
    """(status, preview, error) of one Hermes run file: '# Cron Job: … (FAILED)' or a '## Error' heading
    means failed, a '## Response' heading means it finished (Orca hermes-cron-output-markdown.ts)."""
    failed = bool(re.search(r"^#.*Cron Job:.*\(FAILED\)", text, re.M))
    err_m = re.search(r"^## Error\s*$", text, re.M)
    resp_m = re.search(r"^## Response\s*$", text, re.M)
    error = None
    if err_m:
        failed = True
        rest = text[err_m.end():]
        nxt = re.search(r"^## ", rest, re.M)
        error = plain(rest[: nxt.start()] if nxt else rest, 400) or None
        fence = re.search(r"```[^\n]*\n(.*?)```", rest, re.S)
        if fence:
            error = plain(fence.group(1), 400) or error
    body = text[resp_m.end():] if resp_m else text
    status = "failed" if failed else "ok" if resp_m else "unknown"
    return status, plain(body), error


def _hermes_runs(job_id, out_dir, db_rows):
    runs = []
    d = os.path.join(out_dir, job_id)
    for f in sorted(glob.glob(os.path.join(glob.escape(d), "*.md")), reverse=True)[:40]:
        m = re.match(r"(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)\.md$", os.path.basename(f))
        if not m:
            continue
        at = time.mktime(_dt.datetime(*map(int, m.groups())).timetuple())
        text = _read(f) or ""
        status, preview, error = parse_hermes_output(text)
        # what the agent answered (or the error), not the prompt it was given; the whole file is one click away
        # (an answer starts at its first word: the "Response" heading over it says nothing; an error keeps its heading)
        m = re.search(r"^## (Response|Error)\s*$", text, re.M)
        out = text if not m else text[m.end():].strip() if m.group(1) == "Response" else text[m.start():]
        runs.append(run(at, status, output=out, preview=preview, error=error, path=f))
    seen = {round(r["at"] / 60) for r in runs}
    for row in db_rows.get(job_id, []):
        at = _epoch(row["started_at"] or row["claimed_at"])
        if at is None or round(at / 60) in seen:
            continue
        runs.append(run(at, row["status"], error=row["error"]))
    return runs


def _hermes_executions(path):
    rows = {}
    if not os.path.exists(path):
        return rows
    try:
        con = _sqlite(path)
        try:
            con.row_factory = sqlite3.Row
            for r in con.execute("SELECT job_id, status, claimed_at, started_at, finished_at, error FROM executions ORDER BY claimed_at DESC LIMIT 400"):
                rows.setdefault(r["job_id"], []).append(dict(r))
        finally:
            con.close()
    except sqlite3.Error:
        pass
    return rows


def _hermes_schedule(j):
    sch = j.get("schedule")
    disp = _s(j.get("schedule_display"))
    if isinstance(sch, dict):
        kind = (_s(sch.get("kind")) or "").lower()
        expr = _s(sch.get("expr")) or _s(sch.get("cron"))
        if expr:
            return say_cron(expr), expr
        if kind == "interval" and _num(sch.get("minutes")):
            return say_every(sch["minutes"] * 60), disp
        if kind == "once" or sch.get("run_at"):
            return say_once(_epoch(sch.get("run_at"))), disp
        return disp or _s(sch.get("display")) or _s(sch.get("value")) or "Schedule unknown", disp
    if isinstance(sch, str) and sch.strip():
        try:
            parse_cron(sch)
            return say_cron(sch), sch
        except (ValueError, IndexError):
            m = re.fullmatch(r"(?:every\s+)?(\d+)\s*([mhd])", sch.strip().lower())
            if m:
                return say_every(int(m.group(1)) * {"m": 60, "h": 3600, "d": 86400}[m.group(2)]), sch
            return sch, sch
    return disp or "Schedule unknown", disp


def hermes():
    base = hermes_home()
    jobs_file = os.path.join(base, "cron", "jobs.json")
    if not os.path.exists(jobs_file):
        return {"id": "hermes", "label": "Hermes", "found": os.path.isdir(base), "where": jobs_file, "error": None}, []
    try:
        data = _json(jobs_file)
    except (ValueError, OSError) as e:
        return {"id": "hermes", "label": "Hermes", "found": True, "where": jobs_file, "error": f"Could not read its job list: {e}"}, []
    raw = data if isinstance(data, list) else (data.get("jobs") if isinstance(data, dict) else None) or []
    db_rows = _hermes_executions(os.path.join(base, "cron", "executions.db"))
    out = []
    for j in raw:
        if not isinstance(j, dict) or not _s(j.get("id")):
            continue
        jid = j["id"]
        prompt = _s(j.get("prompt"))
        script = _s(j.get("script"))
        skills = [str(s) for s in j.get("skills") or [] if s]
        fallback = (f"Runs the script {os.path.basename(script)}" if script and j.get("no_agent")
                    else f"Uses the skills {', '.join(skills)}" if skills else "")
        schedule, raw_sched = _hermes_schedule(j)
        enabled = j.get("enabled") is not False and j.get("state") != "paused"
        state = _s(j.get("state")) or ("scheduled" if enabled else "paused")
        if state == "completed":
            enabled = False
        out.append(job("hermes", jid, _s(j.get("name")) or plain(prompt, 60) or jid,
                       does=does(prompt, fallback), prompt=prompt, schedule=schedule, schedule_raw=raw_sched,
                       enabled=enabled, state=state, next_run=_epoch(j.get("next_run_at")) if enabled else None,
                       last_run=_epoch(j.get("last_run_at")),
                       last_status=run(0, j.get("last_status"))["status"] if _s(j.get("last_status")) else None,
                       last_error=_s(j.get("last_error")) or _s(j.get("last_delivery_error")),
                       workdir=_s(j.get("workdir")), where=jobs_file,
                       manage="To change or stop it, open Hermes.",
                       runs=_hermes_runs(jid, os.path.join(base, "cron", "output"), db_rows)))
    return {"id": "hermes", "label": "Hermes", "found": True, "where": jobs_file, "error": None}, out


# ---------------------------------------------------------------- OpenClaw (~/.openclaw/cron)

def openclaw_home():
    return os.environ.get("OPENCLAW_STATE_DIR", "").strip() or os.path.join(home(), ".openclaw")


def _openclaw_runs(base, jid):
    runs = []
    for f in (os.path.join(base, "cron", "runs", f"{jid}.jsonl"),):
        text = _read_tail(f, 200000)
        if not text:
            continue
        for line in text.splitlines()[-200:]:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if not isinstance(e, dict) or (e.get("action") not in (None, "finished")):
                continue
            at = _epoch(e.get("runAtMs") or e.get("ts"))
            summary = _s(e.get("summary"))
            runs.append(run(at, e.get("status"), output=summary, error=_s(e.get("error")), path=f))
    return runs


def openclaw():
    base = openclaw_home()
    jobs_file = os.path.join(base, "cron", "jobs.json")
    src = {"id": "openclaw", "label": "OpenClaw", "found": os.path.isdir(base), "where": jobs_file, "error": None}
    if not os.path.exists(jobs_file):
        return src, []
    try:
        data = _json(jobs_file)
    except (ValueError, OSError) as e:
        src["error"] = f"Could not read its job list: {e}"
        return src, []
    raw = data if isinstance(data, list) else (data.get("jobs") if isinstance(data, dict) else None) or []
    out = []
    for j in raw:
        if not isinstance(j, dict) or not _s(j.get("id")):
            continue
        jid = j["id"]
        sch = j.get("schedule") if isinstance(j.get("schedule"), dict) else {}
        kind = _s(sch.get("kind"))
        expr = _s(sch.get("expr")) or _s(sch.get("cron"))
        if kind == "every":
            schedule = say_every((_num(sch.get("everyMs")) or 0) / 1000)
        elif kind == "at":
            schedule = say_once(_epoch(sch.get("at") or sch.get("atMs")))
        elif expr:
            schedule = say_cron(expr) + (f" ({sch['tz']})" if _s(sch.get("tz")) else "")
        else:
            schedule = _s(j.get("schedule")) or "Schedule unknown"
        payload = j.get("payload") if isinstance(j.get("payload"), dict) else {}
        prompt = _s(payload.get("message")) or _s(payload.get("text"))
        st = j.get("state") if isinstance(j.get("state"), dict) else {}
        enabled = j.get("enabled") is not False
        out.append(job("openclaw", jid, _s(j.get("name")) or plain(prompt, 60) or jid,
                       does=_s(j.get("description")) or does(prompt), prompt=prompt, schedule=schedule, schedule_raw=expr,
                       enabled=enabled, state="disabled" if not enabled else "running" if _num(st.get("runningAtMs")) else "scheduled",
                       next_run=_epoch(st.get("nextRunAtMs")) if enabled else None, last_run=_epoch(st.get("lastRunAtMs")),
                       last_status=run(0, st.get("lastRunStatus") or st.get("lastStatus"))["status"] if (st.get("lastRunStatus") or st.get("lastStatus")) else None,
                       last_error=_s(st.get("lastError")) or _s(st.get("lastDeliveryError")), where=jobs_file,
                       manage="To change or stop it, open OpenClaw.",
                       runs=_openclaw_runs(base, jid)))
    return src, out


# ---------------------------------------------------------------- Codex app automations (~/.codex/sqlite)

def codex_homes():
    """CODEX_HOME when set, and ~/.codex (the Codex app keeps its automations there whatever a shell sets)."""
    homes = [os.environ.get("CODEX_HOME", "").strip(), os.path.join(home(), ".codex")]
    return list(dict.fromkeys(h for h in homes if h))


def codex_db():
    for base in codex_homes():
        for name in ("codex-dev.db", "codex.db"):
            db = os.path.join(base, "sqlite", name)
            if os.path.exists(db):
                return db
    return os.path.join(codex_homes()[-1], "sqlite", "codex.db")


def codex():
    db = codex_db()
    src = {"id": "codex", "label": "Codex", "found": os.path.exists(db), "where": db, "error": None}
    if not src["found"]:
        return src, []
    out = []
    try:
        con = _sqlite(db)
        try:
            con.row_factory = sqlite3.Row
            tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "automations" not in tables:
                return src, []
            runs = {}
            if "automation_runs" in tables:
                cols = {r[1] for r in con.execute("PRAGMA table_info(automation_runs)")}
                pick = [c for c in ("automation_id", "status", "thread_title", "inbox_title", "inbox_summary", "created_at",
                                    "archived_assistant_message", "source_cwd") if c in cols]
                for r in con.execute(f"SELECT {', '.join(pick)} FROM automation_runs ORDER BY created_at DESC LIMIT 500"):
                    r = dict(r)
                    text = r.get("archived_assistant_message") or r.get("inbox_summary")
                    runs.setdefault(r["automation_id"], []).append(
                        run(_epoch(r.get("created_at")), _codex_status(r.get("status")), output=text,
                            preview=plain(r.get("inbox_summary") or text or r.get("inbox_title") or ""), title=r.get("inbox_title") or r.get("thread_title")))
            for a in con.execute("SELECT * FROM automations ORDER BY updated_at DESC"):
                a = dict(a)
                expr, words = rrule_cron(a.get("rrule"))
                status = (a.get("status") or "ACTIVE").upper()
                enabled = status == "ACTIVE"
                try:
                    cwds = [c for c in json.loads(a.get("cwds") or "[]") if isinstance(c, str)]
                except ValueError:
                    cwds = []
                out.append(job("codex", a["id"], _s(a.get("name")) or plain(a.get("prompt"), 60) or a["id"],
                               does=does(a.get("prompt")), prompt=a.get("prompt"), schedule=words, schedule_raw=a.get("rrule"),
                               enabled=enabled, state="scheduled" if enabled else status.lower(),
                               next_run=_epoch(a.get("next_run_at")) if enabled else None, last_run=_epoch(a.get("last_run_at")),
                               workdir=cwds[0] if cwds else None, where=db,
                               manage="To change or stop it, open Automations in the Codex app.",
                               note=None if enabled else "Paused in the Codex app.",
                               runs=runs.get(a["id"], [])))
        finally:
            con.close()
    except sqlite3.Error as e:
        src["error"] = f"Could not read the Codex app's automations: {e}"
    return src, out


def _codex_status(s):
    s = (s or "").upper()
    return {"ACCEPTED": "ok", "ARCHIVED": "ok", "PENDING_REVIEW": "ok", "COMPLETED": "ok", "DONE": "ok", "FAILED": "failed",
            "ERROR": "failed", "RUNNING": "running", "IN_PROGRESS": "running"}.get(s, "unknown")


# ---------------------------------------------------------------- Claude: desktop scheduled tasks and Claude Code loops

def claude_task_dirs():
    return [os.path.join(home(), "Documents", "Claude", "Scheduled"), os.path.join(home(), ".claude", "scheduled-tasks")]


def _claude_desktop_runs():
    """Runs of the Claude app's scheduled tasks: each run is a session record with its scheduledTaskId."""
    runs = {}
    base = os.path.join(home(), "Library", "Application Support", "Claude", "local-agent-mode-sessions")
    files = glob.glob(os.path.join(glob.escape(base), "*", "*", "local_*.json"))
    files.sort(key=lambda f: os.path.getmtime(f) if os.path.exists(f) else 0, reverse=True)
    for f in files[:800]:
        try:
            if os.path.getsize(f) > 4_000_000:
                continue
            d = _json(f)
        except (ValueError, OSError):
            continue
        tid = d.get("scheduledTaskId") if isinstance(d, dict) else None
        if not tid:
            continue
        title = _s(d.get("title"))
        runs.setdefault(tid, []).append(run(_epoch(d.get("createdAt")), "ok" if d.get("lastActivityAt") else "unknown",
                                            preview=title or "", title=title))
    return runs


def claude_desktop():
    out = []
    dirs = [d for d in claude_task_dirs() if os.path.isdir(d)]
    src = {"id": "claude", "label": "Claude", "found": bool(dirs), "where": dirs[0] if dirs else claude_task_dirs()[0], "error": None}
    if not dirs:
        return src, out
    runs = _claude_desktop_runs()
    seen = set()
    for d in dirs:
        for skill in sorted(glob.glob(os.path.join(glob.escape(d), "*", "SKILL.md"))):
            name = os.path.basename(os.path.dirname(skill))
            if name in seen:
                continue
            seen.add(name)
            meta, body = _strip_frontmatter(_read(skill) or "")
            out.append(job("claude", name, meta.get("name") or name, agent="claude",
                           does=_cap(meta.get("description"), 200) or does(body), prompt=body.strip() or None,
                           schedule="Set in the Claude app", where=skill,
                           manage="To change or stop it, open Scheduled in the Claude app.",
                           note="The Claude app keeps the time it runs, so Dispatch cannot tell when it runs next.",
                           runs=runs.get(name, [])))
    return src, out


def claude_code(folders=()):
    """Claude Code's saved loops (/loop and CronCreate with durable on): <folder>/.claude/scheduled_tasks.json.
    They only fire while a Claude Code session in that folder is open."""
    out = []
    files = []
    roots = [home()] + list(folders)
    for parent in ("Projects", "Developer", "code", "src"):
        roots += [p for p in glob.glob(os.path.join(glob.escape(os.path.join(home(), parent)), "*")) if os.path.isdir(p)]
    seen = set()
    for r in roots:
        f = os.path.join(r, ".claude", "scheduled_tasks.json")
        rp = os.path.realpath(f)
        if rp in seen or not os.path.isfile(f):
            continue
        seen.add(rp)
        files.append((r, f))
    for folder, f in files:
        try:
            data = _json(f)
        except (ValueError, OSError):
            continue
        tasks = data.get("tasks") if isinstance(data, dict) else data if isinstance(data, list) else []
        for t in tasks or []:
            if not isinstance(t, dict):
                continue
            expr = _s(t.get("cron")) or _s(t.get("schedule"))
            prompt = _s(t.get("prompt"))
            tid = _s(t.get("id")) or plain(prompt, 20)
            recurring = t.get("recurring") is not False
            out.append(job("claude-code", f"{folder}:{tid}", plain(prompt, 60) or tid, agent="claude",
                           does=does(prompt), prompt=prompt,
                           schedule=(say_cron(expr) if recurring else "Once, " + say_cron(expr)[0].lower() + say_cron(expr)[1:]) if expr else "Schedule unknown",
                           schedule_raw=expr, next_run=next_cron(expr) if expr else None, workdir=folder, where=f,
                           manage="Claude Code runs it while it is open in that folder. To stop it, ask Claude Code there to cancel the loop.",
                           note="Runs only while Claude Code is open in this folder."))
    return {"id": "claude-code", "label": "Claude Code", "found": bool(files), "where": None, "error": None}, out


# ---------------------------------------------------------------- launchd and cron jobs that start an agent

def agent_in(words):
    """The agent a command starts (claude, codex…), from its words and, for a small script it runs, the script."""
    text = " ".join(words)
    for word, aid, _ in AGENT_WORDS:
        if re.search(rf"(^|[\s/'\"=]){re.escape(word)}(\s|$|['\";]|\.(js|sh|py|mjs)\b)", text, re.I):
            return aid
    for w in words:
        p = os.path.expanduser(w)
        if os.path.isabs(p) and os.path.isfile(p) and p.startswith(home()) and os.path.getsize(p) < 64_000:
            body = _read(p) or ""
            if "\x00" in body:
                continue
            for word, aid, _ in AGENT_WORDS:
                if re.search(rf"(^|[\s/;&|(`$]){re.escape(word)}\s+(-p|--print|exec|run|-m|--message|cron|chat)\b", body, re.I | re.M):
                    return aid
    return None


INTERPRETERS = {"sh", "bash", "zsh", "fish", "env", "python", "python3", "node", "bun", "deno", "ruby", "perl", "osascript", "cd", "nice", "caffeinate", "timeout"}


def script_name(words):
    """A readable name for a command: the script it runs (summarize-rss), else the program (claude)."""
    for w in words:
        if w in ("&&", ";", "|", "||") or w.startswith((">", "2>", "<")):
            continue
        base = os.path.basename(w)
        if not base or base.startswith("-") or base in INTERPRETERS or "=" in base:
            continue
        return re.sub(r"\.(sh|py|js|mjs|ts|rb|pl|command)$", "", base)
    return ""


def _redirect_target(cmd):
    m = re.search(r"(?:^|\s)(?:1?>>?|&>>?)\s*(\S+)", cmd)
    return os.path.expanduser(m.group(1)) if m and not m.group(1).startswith("/dev/") else None


def _agent_prompt(words):
    """The prompt handed to the agent (`claude -p "…"`, `codex exec "…"`), if any."""
    for i, w in enumerate(words):
        if w in ("-p", "--print", "--prompt", "-m", "--message", "exec", "run") and i + 1 < len(words):
            nxt = words[i + 1]
            if not nxt.startswith("-"):
                return nxt
    return None


def launchctl_status():
    """label -> (pid or None, last exit status) from `launchctl list` (only lists)."""
    try:
        r = subprocess.run(["launchctl", "list"], capture_output=True, text=True, timeout=4)
    except (OSError, subprocess.SubprocessError):
        return {}
    out = {}
    for line in r.stdout.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) == 3:
            pid = int(parts[0]) if parts[0].isdigit() else None
            try:
                code = int(parts[1])
            except ValueError:
                code = None
            out[parts[2]] = (pid, code)
    return out


def launchd(status=None, dirs=None):
    dirs = dirs or [os.path.join(home(), "Library", "LaunchAgents"), "/Library/LaunchAgents"]
    out = []
    status = launchctl_status() if status is None else status
    for d in dirs:
        for f in sorted(glob.glob(os.path.join(glob.escape(d), "*.plist"))):
            try:
                with open(f, "rb") as fh:
                    pl = plistlib.load(fh)
            except Exception:
                continue
            if not isinstance(pl, dict):
                continue
            label = pl.get("Label") or os.path.basename(f)[:-6]
            if OWN_LABELS.match(label):
                continue
            words = [str(x) for x in (pl.get("ProgramArguments") or [])] or ([str(pl["Program"])] if pl.get("Program") else [])
            aid = agent_in(words)
            if not aid:
                continue
            cal, every = pl.get("StartCalendarInterval"), _num(pl.get("StartInterval"))
            crons = launchd_cron(cal) if cal else []
            if crons:
                schedule = _join(say_cron(c) for c in crons)
                nexts = [n for n in (next_cron(c) for c in crons) if n]
                nxt = min(nexts) if nexts else None
            elif every:
                schedule, nxt = say_every(every), None
            elif pl.get("RunAtLoad") and not pl.get("KeepAlive"):
                schedule, nxt = "When you log in", None
            else:
                continue  # a service that stays up, not something that runs on a schedule
            disabled = pl.get("Disabled") is True
            prompt = _agent_prompt(words)
            pid, code = status.get(label, (None, None))
            logs = [p for p in (pl.get("StandardOutPath"), pl.get("StandardErrorPath")) if isinstance(p, str)]
            runs = []
            for p in dict.fromkeys(logs):
                if os.path.isfile(p) and os.path.getsize(p) > 0:
                    text = _read_tail(p)
                    runs.append(run(os.path.getmtime(p), "running" if pid else ("ok" if code == 0 else "failed" if code else "unknown"),
                                    output=text, preview=plain((text or "").strip().splitlines()[-1] if (text or "").strip() else ""), path=p))
            runs = runs[:1]
            cmd = " ".join(shlex.quote(w) for w in words)
            out.append(job("launchd", label, label.rsplit(".", 1)[-1] if "." in label else label, agent=aid,
                           does=does(prompt) if prompt else f"Starts {AGENT_NAMES.get(aid, aid)}: {_cap(cmd, 140)}",
                           prompt=prompt or cmd, schedule=schedule, schedule_raw=json.dumps(cal) if cal else (f"every {int(every)}s" if every else None),
                           enabled=not disabled, state="running" if pid else "disabled" if disabled else "scheduled",
                           next_run=None if disabled else nxt,
                           last_status=None if code is None else ("ok" if code == 0 else "failed"),
                           last_error=f"Last run ended with code {code}" if code else None,
                           workdir=pl.get("WorkingDirectory"), where=f,
                           manage="macOS starts it at the set time. To stop it, turn it off in System Settings, General, Login Items.",
                           note="Its output file only keeps the latest text, so earlier runs are not listed." if runs else None,
                           runs=runs))
    return {"id": "launchd", "label": SOURCE_LABELS["launchd"], "found": True, "where": dirs[0], "error": None}, out


def crontab(text=None):
    if text is None:
        try:
            r = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=4)
            text = r.stdout if r.returncode == 0 else ""
        except (OSError, subprocess.SubprocessError):
            text = ""
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#") or re.match(r"^[A-Z_]+=", line):
            continue
        parts = line.split(None, 1 if line.startswith("@") else 5)
        if line.startswith("@"):
            if len(parts) < 2 or parts[0] == "@reboot":
                continue
            expr, cmd = parts[0], parts[1]
        else:
            if len(parts) < 6:
                continue
            expr, cmd = " ".join(parts[:5]), parts[5]
        try:
            words = shlex.split(cmd)
        except ValueError:
            words = cmd.split()
        aid = agent_in(words)
        if not aid:
            continue
        prompt = _agent_prompt(words)
        runs = []
        log = _redirect_target(cmd)
        if log and os.path.isfile(log) and os.path.getsize(log) > 0:
            text = _read_tail(log)
            runs.append(run(os.path.getmtime(log), "unknown", output=text,
                            preview=plain((text or "").strip().splitlines()[-1] if (text or "").strip() else ""), path=log))
        out.append(job("cron", f"line{n}", plain(prompt, 60) or script_name(words) or f"cron line {n}", agent=aid, runs=runs,
                       note="Its log only keeps the latest text, so earlier runs are not listed." if runs else None,
                       does=does(prompt) if prompt else f"Starts {AGENT_NAMES.get(aid, aid)}: {_cap(cmd, 140)}",
                       prompt=prompt or cmd, schedule=say_cron(expr), schedule_raw=expr, next_run=next_cron(expr),
                       where="crontab", manage="Your Mac's built-in timer (cron) starts it. To change or stop it, edit your crontab in Terminal (crontab -e)."))
    return {"id": "cron", "label": "cron", "found": bool(text), "where": "crontab", "error": None}, out


# ---------------------------------------------------------------- all of it

def discover(folders=(), launchctl=True, cron=True):
    """Everything this Mac runs on a schedule that starts an agent, newest-next first."""
    sources, jobs = [], []
    steps = [hermes, openclaw, codex, claude_desktop, lambda: claude_code(folders),
             lambda: launchd(None if launchctl else {})]
    if cron:
        steps.append(crontab)
    for step in steps:
        try:
            src, found = step()
        except Exception as e:  # one broken source must not hide the others
            src, found = {"id": getattr(step, "__name__", "?"), "label": getattr(step, "__name__", "?"), "found": True,
                          "where": None, "error": f"{type(e).__name__}: {e}"}, []
        src["count"] = len(found)
        sources.append(src)
        jobs += found
    now = time.time()
    jobs.sort(key=lambda j: (not j["enabled"], j["next_run"] is None, j["next_run"] or 0, -(j["last_run"] or 0), j["name"].lower()))
    return {"at": now, "sources": sources, "jobs": jobs}


# ---------------------------------------------------------------- the dispatch command, and the other Macs

def _tag(data, hid, name):
    for j in data.get("jobs") or []:
        j["id"] = f"{hid}/{j['id']}"
        j["host"], j["host_name"] = hid, name
    return data.get("jobs") or []


def ask_mac(h, remote_dir, ttl=120, timeout=15):
    """This file run by that Mac's python3 over ssh, cached for ttl seconds; an unreachable Mac is not asked
    again for a minute (the `.down` marker Dispatch's other remote calls share). Returns (data or None, error)."""
    os.makedirs(remote_dir, exist_ok=True)
    cache = os.path.join(remote_dir, f"{h['id']}.automations.json")
    down = os.path.join(remote_dir, f"{h['id']}.down")
    now = time.time()

    def stale():
        try:
            return _json(cache)
        except (ValueError, OSError):
            return None
    try:
        if now - os.path.getmtime(cache) < ttl:
            return stale(), None
    except OSError:
        pass
    try:
        if now - os.path.getmtime(down) < 60:
            return stale(), "unreachable"
    except OSError:
        pass
    src = _read(os.path.abspath(__file__)) or ""
    try:
        r = subprocess.run(["ssh", "-o", "ConnectTimeout=4", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", h["ssh"],
                            "/usr/bin/env python3 -"], input=src, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        open(down, "w").close()
        return stale(), "unreachable"
    except OSError as e:
        return stale(), str(e)
    if r.returncode == 255:
        open(down, "w").close()
        return stale(), "unreachable"
    try:
        data = json.loads(r.stdout[r.stdout.index("{"):])
    except ValueError:
        return stale(), (r.stderr or r.stdout).strip()[-300:] or f"exit {r.returncode}"
    tmp = cache + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, cache)
    return data, None


def command(a, D):
    """`dispatch automations discover [--remote | --host <Mac>] [--json]`."""
    import threading
    if a.op != "discover":
        print(f"unknown: {a.op}", file=sys.stderr)
        return 2
    out = {"machines": [], "sources": [], "jobs": []}
    peers = D.hosts() if (a.remote or a.host) else []
    if a.host:
        h = D.host_entry(a.host)
        if not h:
            print(f"No Mac called {a.host} in hosts.json", file=sys.stderr)
            return 2
        peers = [h]
    if not (a.remote or a.host):
        data = discover()
        out["machines"].append({"id": "local", "name": D.local_host_name(), "local": True, "reachable": True, "error": None, "at": data["at"]})
        out["sources"] += [dict(s, host="local") for s in data["sources"]]
        out["jobs"] += _tag(data, "local", D.local_host_name())
    answers = {}

    def one(h):
        answers[h["id"]] = ask_mac(h, D.REMOTE_DIR, ttl=0 if a.fresh else 120)
    threads = [threading.Thread(target=one, args=(h,), daemon=True) for h in peers if h.get("ssh")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(20)
    for h in peers:
        if not h.get("ssh"):
            continue
        data, err = answers.get(h["id"], (None, "no answer"))
        out["machines"].append({"id": h["id"], "name": h.get("name") or h["id"], "local": False, "reachable": err is None,
                                "error": err, "at": (data or {}).get("at")})
        if data:
            out["sources"] += [dict(s, host=h["id"]) for s in data.get("sources") or []]
            out["jobs"] += _tag(data, h["id"], h.get("name") or h["id"])
    if a.json:
        print(json.dumps(out, ensure_ascii=False))
        return 0
    for m in out["machines"]:
        rows = [j for j in out["jobs"] if j["host"] == m["id"]]
        print(f"{m['name']}: {len(rows)} scheduled" + ("" if m["reachable"] else f" (not reachable now: {m['error']})"))
        for j in rows:
            nxt = time.strftime("%m-%d %H:%M", time.localtime(j["next_run"])) if j["next_run"] else "-"
            print(f"  [{j['source_label']}] {j['name']} · {j['schedule']} · next {nxt} · {j['does'][:70]}")
    return 0


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    folders = [a for a in argv if not a.startswith("--")]
    data = discover(folders, launchctl="--no-launchctl" not in argv, cron="--no-cron" not in argv)
    sys.stdout.write(json.dumps(data, ensure_ascii=False))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
