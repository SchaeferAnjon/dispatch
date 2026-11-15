# -*- coding: utf-8 -*-
"""Keep the Mac awake while an agent is working or a phone is connected (setting `keep_awake`, on by default:
1 = keep the Mac awake (the screen still sleeps), 2 = keep the screen on too, 0 = let it sleep as usual).

macOS sleeps an idle Mac after a while, and a sleeping Mac stops every agent session. While at least one
session of any agent is working (the same list `dispatch sessions` shows: terminals, the Agents window,
Dispatch's own chat) or a paired phone has been in touch in the last 90 seconds, `Holder.tick` keeps a
`caffeinate -is -t 90` running: no idle sleep, and no system sleep on power. Each tick renews it; when
nothing is going on it is simply not renewed and ends by itself within 90 seconds, so there is no state to
clean up if Dispatch quits. chatd (kept running by launchd) runs `loop` in a thread.

Closing the lid still puts a MacBook to sleep unless it is on power with an external display: caffeinate
cannot change that, so the settings page says so in one line.

Each pass writes what it holds to `<DISPATCH_DIR>/awake.json` ({mode, holding, reason, working, until, at}),
so the settings page and the bottom bar read the state without asking for every session again.

`dispatch awake [status|tick|check] [--json]`: what is held now (from awake.json), one pass, or what a pass
would see right now (asks for the sessions; slower). `dispatch awake set system|display|off` changes the mode.
"""
import json
import os
import subprocess
import sys
import threading
import time

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
HOLD = 90          # seconds one caffeinate lasts (and how long after the last activity the Mac may sleep again)
PHONE_SEEN = 90    # a paired phone that called within this many seconds counts as connected
INTERVAL = 20      # seconds between passes
MODES = {0: "off", 1: "system", 2: "display"}
FLAGS = {"system": "-is", "display": "-dis"}
STATE = "awake.json"


def _dispatch():
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import dispatch as D
    return D


def phone_connected(state_path, now=None):
    """A paired phone has called within PHONE_SEEN seconds (mobile/state.json, written by the phone service)."""
    now = now or time.time()
    try:
        with open(state_path, encoding="utf-8") as f:
            pairs = (json.load(f) or {}).get("pairs") or {}
    except (OSError, ValueError, AttributeError):
        return False
    return any(isinstance(p, dict) and p.get("status") == "paired" and now - float(p.get("last_seen") or 0) < PHONE_SEEN for p in pairs.values())


def reason(sessions, phone):
    """Why the Mac should stay awake right now: '' (no reason), 'phone', or 'working' (an agent session is working)."""
    if any(isinstance(s, dict) and s.get("state") == "working" for s in sessions or []):
        return "working"
    return "phone" if phone else ""


class Holder:
    """One caffeinate at a time, renewed by every tick that has a reason."""

    def __init__(self, spawn=None, clock=time.time):
        self.spawn = spawn or self._spawn
        self.clock = clock
        self.proc = None
        self.until = 0.0
        self.reason = ""
        self.mode = "system"

    @staticmethod
    def _spawn(mode="system"):
        return subprocess.Popen(["caffeinate", FLAGS.get(mode, "-is"), "-t", str(HOLD)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def _new(self, mode):
        try:
            return self.spawn(mode) if mode != "system" else self.spawn()
        except TypeError:  # a spawn that does not take the mode (tests)
            return self.spawn()

    def holding(self):
        return bool(self.proc and self.proc.poll() is None and self.clock() < self.until)

    def tick(self, why, mode="system"):
        """Hold (or keep holding) when there is a reason, let go otherwise. Returns what is held now.
        Mode off lets go at once; a new mode (screen on or not) takes a new caffeinate at once."""
        now = self.clock()
        if mode == "off":
            why = ""
            self.release()
        if why:
            if not self.holding() or self.until - now < HOLD / 2 or mode != self.mode:
                try:
                    new = self._new(mode)
                except OSError:
                    new = None
                self.mode = mode
                if new:
                    old, self.proc, self.until = self.proc, new, now + HOLD
                    if old and old.poll() is None:
                        old.terminate()
        elif self.proc and self.proc.poll() is None and now >= self.until:
            self.proc = None
        self.reason = why if self.holding() else ""
        return {"holding": self.holding(), "reason": self.reason, "until": self.until if self.holding() else 0}

    def release(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
        self.proc, self.until, self.reason = None, 0.0, ""


def mode_of(value):
    """The setting's value as a mode: 0 off, 1 system (the default), 2 display; the words work too."""
    if isinstance(value, str) and value.strip() in FLAGS.keys() | {"off"}:
        return value.strip()
    try:
        return MODES.get(int(value), "system")
    except (TypeError, ValueError):
        return "system"


def mode(D=None):
    D = D or _dispatch()
    try:
        return mode_of(D.settings_load().get("keep_awake", 1))
    except Exception:  # noqa: BLE001 - no board yet: the default applies
        return "system"


def enabled(D=None):
    return mode(D) != "off"


def current(D=None, now=None):
    """What a pass sees: {enabled, mode, reason, working} without holding anything."""
    D = D or _dispatch()
    m = mode(D)
    on = m != "off"
    if sys.platform != "darwin" or not on:
        return {"enabled": on, "mode": m, "reason": "", "working": 0}
    try:
        sessions = D.live_sessions(local_only=True)
    except Exception:  # noqa: BLE001
        sessions = []
    phone = phone_connected(os.path.join(D.DISPATCH_DIR, "mobile", "state.json"), now)
    return {"enabled": on, "mode": m, "reason": reason(sessions, phone), "working": sum(1 for s in sessions if s.get("state") == "working")}


def state_path(D=None):
    D = D or _dispatch()
    return os.path.join(D.DISPATCH_DIR, STATE)


def write_state(path, seen, held, now=None):
    """What this pass holds, for `dispatch awake` and the app (atomic: a reader never sees half a file)."""
    rec = {"mode": seen.get("mode", "system"), "holding": bool(held.get("holding")), "reason": held.get("reason", ""),
           "working": seen.get("working", 0), "until": held.get("until", 0), "at": now or time.time(), "pid": os.getpid()}
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(rec, f)
        os.replace(tmp, path)
    except OSError:
        pass
    return rec


def status(D=None, now=None):
    """What is held right now, from the last pass: {mode, holding, reason, working, running}. `running` is
    whether the background service made a pass lately; without it nothing holds the Mac awake."""
    D = D or _dispatch()
    now = now or time.time()
    m = mode(D)
    try:
        with open(state_path(D), encoding="utf-8") as f:
            rec = json.load(f) or {}
    except (OSError, ValueError):
        rec = {}
    fresh = now - float(rec.get("at") or 0) < INTERVAL * 3
    holding = bool(rec.get("holding")) and fresh and float(rec.get("until") or 0) > now and m != "off"
    return {"mode": m, "holding": holding, "reason": rec.get("reason", "") if holding else "",
            "working": int(rec.get("working") or 0) if fresh else 0, "running": fresh}


def loop(holder=None, interval=INTERVAL, stop=None, log=None, delay=0):
    """Forever, in a thread of chatd. A failed pass is skipped; the hold ends by itself if the loop stops.
    `delay`: seconds to wait before the first pass, so chatd's own start-up is not slowed down."""
    holder = holder or Holder()
    if delay:
        (stop.wait(delay) if stop else time.sleep(delay))
    while not (stop and stop.is_set()):
        try:
            D = _dispatch()
            seen = current(D)
            held = holder.tick(seen["reason"] if seen["enabled"] else "", seen.get("mode", "system"))
            write_state(state_path(D), seen, held)
        except Exception as e:  # noqa: BLE001
            if log:
                log(f"keep awake: {str(e)[:160]}")
        if stop:
            stop.wait(interval)
        else:
            time.sleep(interval)
    holder.release()


def start_thread(log=None):
    stop = threading.Event()
    t = threading.Thread(target=loop, kwargs={"stop": stop, "log": log, "delay": 10}, name="keep-awake", daemon=True)
    t.start()
    return stop


WORDS = {"working": "an agent is working", "phone": "your phone is connected"}


def command(a):
    D = _dispatch()
    as_json = getattr(a, "json", False)
    if a.op == "set":
        want = (getattr(a, "mode", "") or "").strip()
        if want not in ("system", "display", "off"):
            print("dispatch awake set system|display|off", file=sys.stderr)
            return 2
        D.settings_write({"keep_awake": {"off": 0, "system": 1, "display": 2}[want]})
        out = {"ok": True, **status(D)}
    elif a.op in ("tick", "check"):
        seen = current(D)
        out = {"ok": True, **seen}
        if a.op == "tick":
            out.update(Holder().tick(seen["reason"] if seen["enabled"] else "", seen["mode"]))
    else:
        out = {"ok": True, **status(D)}
    if as_json:
        print(json.dumps(out, ensure_ascii=False))
    elif out.get("mode") == "off":
        print("keep awake is off: the Mac sleeps as usual")
    elif out.get("holding") or (a.op != "status" and out.get("reason")):
        print("keeping the Mac awake: " + WORDS.get(out.get("reason"), out.get("reason") or "") + (" (screen on too)" if out.get("mode") == "display" else ""))
    else:
        print("nothing to hold: no agent is working and no phone is connected" + ("" if out.get("running", True) else " (Dispatch's background service is not running)"))
    return 0
