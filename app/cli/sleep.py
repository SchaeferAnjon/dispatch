# -*- coding: utf-8 -*-
"""`dispatch sleep`: idle agents go to sleep to give memory back, and wake when you come back.

A session sleeps when all of these hold (the same rules in chatd and in the Agents window's host):
  - its last turn ended (nothing running), and it is not waiting for you (no permission, no question)
  - nobody has it open in front of them (the Agents window keeps the session you are looking at awake)
  - nothing happened in it for the setting's minutes (30 by default)
Sleeping ends the agent's process; the conversation stays on disk. Opening the session shows all of it
at once, and the next message starts the agent again on the same conversation (Claude `--resume`,
Codex `thread/resume`): nothing to click.

Setting: agent_sleep_minutes (shared settings, default 30, 0 = never). `dispatch sleep on|off|after N`
writes it, keeps chatd's older chat_idle_close_minutes in step, and mirrors it into
<DISPATCH_DIR>/agent-sleep.json ({"minutes": N}) for the Agents window's host, which cannot read the
board. A missing mirror reads as the default: on, 30 minutes.

Who is asleep: each runner writes its own list, <DISPATCH_DIR>/agent-sleep-<runner>.json
({"asleep": {key: {at, agent, title, cwd}}}): chatd as "chat", the Agents window's host as "ide".
`dispatch sleep` merges them.
"""
import json
from lang import t as _t
import os
import sys
import time

sys.dont_write_bytecode = True

DEFAULT_MINUTES = 30
MAX_MINUTES = 24 * 60
MIRROR = "agent-sleep.json"
NOW = "agent-sleep-now.json"
RUNNERS = ("chat", "ide")


def mirror_path(base):
    return os.path.join(base, MIRROR)


def runner_path(base, runner):
    return os.path.join(base, f"agent-sleep-{runner}.json")


def _read(p):
    try:
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(p, d):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = f"{p}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, p)


def minutes_of(settings):
    """The setting as whole minutes: agent_sleep_minutes, else the default."""
    m = (settings or {}).get("agent_sleep_minutes", DEFAULT_MINUTES)
    if isinstance(m, bool) or not isinstance(m, (int, float)) or m < 0:
        return DEFAULT_MINUTES
    return int(min(m, MAX_MINUTES))


def write_mirror(base, minutes, now=None):
    """Only when it changed: settings_load calls this on every read."""
    old = _read(mirror_path(base))
    if old.get("minutes") == minutes:
        return False
    try:
        _write(mirror_path(base), {"minutes": minutes, "at": now or time.time()})
        return True
    except OSError:
        return False


def now_path(base):
    return os.path.join(base, NOW)


def ask_now(base, now=None):
    """`dispatch sleep now` (the bottom bar's Let idle agents sleep): every session idle at this moment sleeps on
    its runner's next pass, whatever the minutes say. Each runner reads the time and puts to sleep what was quiet
    before it (chatd's reaper, the Agents window's host, which also watches the file)."""
    _write(now_path(base), {"at": now or time.time()})


def asked_at(base):
    """When `dispatch sleep now` last asked (epoch seconds), or 0."""
    at = _read(now_path(base)).get("at", 0)
    return at if isinstance(at, (int, float)) and not isinstance(at, bool) else 0


def mirrored_minutes(base):
    m = _read(mirror_path(base)).get("minutes", DEFAULT_MINUTES)
    return m if isinstance(m, int) and not isinstance(m, bool) and m >= 0 else DEFAULT_MINUTES


# ---- who is asleep -------------------------------------------------------------------------------

def note(base, runner, key, asleep, info=None, now=None):
    """Record that `key` fell asleep (with agent / title / cwd) or woke up. Never raises."""
    try:
        p = runner_path(base, runner)
        d = _read(p)
        cur = d.get("asleep") if isinstance(d.get("asleep"), dict) else {}
        if asleep:
            cur[key] = {"at": now or time.time(), **{k: v for k, v in (info or {}).items() if k in ("agent", "title", "cwd") and v}}
        elif key in cur:
            del cur[key]
        else:
            return
        _write(p, {"asleep": cur, "at": now or time.time()})
    except OSError:
        pass


def asleep(base):
    out = []
    for r in RUNNERS:
        d = _read(runner_path(base, r)).get("asleep")
        for key, info in (d or {}).items() if isinstance(d, dict) else ():
            if isinstance(info, dict):
                out.append({"session": key, "runner": r, **info})
    return sorted(out, key=lambda x: -float(x.get("at") or 0))


def status(base, settings):
    m = minutes_of(settings)
    rows = asleep(base)
    return {"on": m > 0, "minutes": m, "asleep": rows, "count": len(rows)}


# ---- the command ---------------------------------------------------------------------------------

def command(a, D):
    """dispatch sleep [status|on|off|after N|now]"""
    op = getattr(a, "op", "status") or "status"
    as_json = getattr(a, "json", False)
    base = D.DISPATCH_DIR
    if op == "now":
        ask_now(base)
    if op in ("status", "now"):
        # the bell asks every minute: the mirror says the same as the board without waiting for it
        settings = {"agent_sleep_minutes": mirrored_minutes(base)}
    else:
        settings = D.settings_load()
    if op in ("on", "off", "after"):
        if op == "off":
            m = 0
        elif op == "on":
            m = minutes_of(settings) or DEFAULT_MINUTES
        else:
            try:
                m = int(getattr(a, "minutes", "") or "")
            except ValueError:
                m = -1
            if not 1 <= m <= MAX_MINUTES:
                D.out({"ok": False, "error": f"minutes must be 1 to {MAX_MINUTES}"}, as_json, lambda r: print(_t("Minutes must be 1 to 1440", "分钟数要在 1 到 1440 之间"), file=sys.stderr))
                sys.exit(2)
        D.settings_write({"agent_sleep_minutes": m, "chat_idle_close_minutes": m})
        write_mirror(base, m)
        settings = {**settings, "agent_sleep_minutes": m}
    r = {"ok": True, **status(base, settings)}
    if op == "now":
        r["asked"] = True

    def text(r):
        if r.get("asked"):
            print(_t("Idle agents sleep now; opening the session wakes them", "闲着的 Agent 马上休眠，打开会话就接着用"))
        if not r["on"]:
            print(_t("Idle agents do not sleep (dispatch sleep on turns it on)", "闲着的 Agent 不休眠（dispatch sleep on 打开）"))
        else:
            print(_t(f"An agent nobody touched for {r['minutes']} minutes after finishing goes to sleep; opening the session wakes it", f"做完后 {r['minutes']} 分钟没人碰的 Agent 会休眠，打开会话就接着用"))
        if r["asleep"]:
            print(_t(f"Asleep now: {r['count']}", f"现在在睡：{r['count']} 个"))
            for x in r["asleep"]:
                print(f"  {x.get('title') or x['session']}  ({x['runner']})")

    D.out(r, as_json, text)
