#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Push what changed to the phone (ntfy / Bark) without the desktop app being open.

The phone web server runs `loop()` in a thread; `dispatch notify watch --once` runs one pass by
hand. Each pass reads the same activity snapshot the app polls and sends, at most once each:

  reply      an agent finished its turn and the answer is unread     (settings notify_reply)
  attention  a session stopped at a confirmation / question           (settings notify_attention)

Tasks closed with `dispatch done` and 只能你做 items from `dispatch need-you` are pushed by
those commands themselves (see dispatch.py) so they arrive the moment they happen.

Nothing is sent while only the macOS banner channel is configured: the desktop app already
shows those, and a headless Mac would just pile up banners nobody sees.
"""
import fcntl, json, os, sys, threading, time
sys.dont_write_bytecode = True  # never write __pycache__ next to these files: inside Dispatch.app that breaks the code signature
from lang import t as _t

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
import dispatch as D  # noqa: E402
import engines as E  # noqa: E402

STATE_FILE = os.path.join(D.DISPATCH_DIR, "notify-watch.json")
KEEP = 600  # remembered reply / attention ids


def load_state(path=STATE_FILE):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_state(st, path=STATE_FILE):
    for k in ("replies", "attention"):
        v = st.get(k) or []
        st[k] = v[-KEEP:]
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(tmp, path)


def phone_channel_ready(notify):
    return notify.channel()[0] in ("ntfy", "bark")


def wanted(settings, key, default=1):
    v = settings.get(key, default)
    try:
        return int(v) != 0
    except (TypeError, ValueError):
        return bool(v)


def tick(rows, settings, st, send, link, now=None, first=False, live=(), english=False):
    """One pass over activity rows (`rows`, unread replies) and live process rows (`live`,
    confirmations: the hook registry / desktop overlay carry `attention`). Returns the
    messages sent (for tests / --once). `first` (state file did not exist): remember what
    is there now and send nothing, so switching the feature on does not replay every unread
    reply of the past month."""
    now = now or time.time()
    sent = []
    seen_r = set(st.get("replies") or [])
    seen_a = set(st.get("attention") or [])
    for s in live:
        if s.get("attention") != "input" or s.get("state") == "working" or s.get("remote") or s.get("scheduled"):
            continue
        agent = E.get(s.get("agent", "")).name
        sid = s.get("session_id", "")
        mark = f"{s.get('agent')}:{sid}|{int(float(s.get('last_at') or 0))}"
        if mark in seen_a:
            continue
        seen_a.add(mark); st["attention"] = list(seen_a)
        if not first and wanted(settings, "notify_attention"):
            title = (s.get("title") or s.get("project") or "").strip()
            # Same dedup key as the Claude Code hook's own push, so one confirmation rings once.
            sent.append(send((f"{agent} needs you · {s.get('project') or title}" if english else f"{agent} 等你确认 · {s.get('project') or title}"),
                             title or ("Open the session to see what it asks" if english else "打开会话看确认请求"), level="high",
                             url=link(f"/#/sessions/{sid}"), key=f"presence:{s.get('agent')}:{sid}"))
    for s in rows:
        if s.get("scheduled") or s.get("remote") or s.get("daemon"):
            continue
        key = s.get("key") or f"{s.get('agent')}:{s.get('session_id')}"
        agent = E.get(s.get("agent", "")).name
        title = (s.get("title") or s.get("project") or "").strip()
        proj = (s.get("project") or "").strip()
        rid = s.get("reply_id") or ""
        if rid and s.get("unread"):
            mark = f"{key}|{rid}"
            if mark not in seen_r:
                seen_r.add(mark); st["replies"] = list(seen_r)
                if not first and wanted(settings, "notify_reply") and now - float(s.get("reply_at") or 0) < 6 * 3600:
                    body = (s.get("reply_preview") or "").strip().replace("\n", " ")[:160] or ("Finished. Open the session to read it." if english else "本轮结束，打开看看")
                    sent.append(send((f"{agent} replied · {proj or title}" if english else f"{agent} 回复了 · {proj or title}"), f"{title}\n{body}" if title and title != proj else body,
                                     url=link(f"/#/sessions/{s.get('session_id', '')}"), key=f"reply:{mark}"))
    return sent


def desktop_wanted(settings):
    """Banners on this Mac (setting notify_desktop, off until the person turns it on in setup or Customizations)."""
    return wanted(settings, "notify_desktop", 0)


def run_once(path=STATE_FILE):
    import notify
    from activity import activity_list
    try:
        settings = D.settings_load()
    except Exception:
        settings = {}
    desktop = False
    if not phone_channel_ready(notify):
        # no phone channel: this Mac's own banners, when the person asked for them
        if not desktop_wanted(settings):
            return {"ok": True, "skipped": "no phone channel (NTFY_URL / BARK_KEY)", "sent": 0}
        desktop = True
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".lock", "a") as lock:
        # the phone service and chatd both run this loop: one pass at a time, so a message goes out once
        fcntl.flock(lock, fcntl.LOCK_EX)
        st = load_state(path)
        first = not os.path.exists(path)
        rows = activity_list(D.HOME, D.DISPATCH_DIR, D.load_index())
        try:
            live = D.live_sessions(local_only=True)
        except Exception:
            live = []
        send, gates = notify.send, settings
        if desktop:
            # this Mac's banners follow Settings › Notifications: which kinds, and the sound
            import notify_prefs as NP
            sound = NP.applescript_sound(settings.get("notify_sound", "default"))
            send = lambda *a, **k: notify.send(*a, sound=sound, **k)  # noqa: E731
            gates = {**settings, "notify_reply": int(NP.wants(settings, "finished")), "notify_attention": int(NP.wants(settings, "needs_you"))}
        sent = tick(rows, gates, st, send, notify.serve_link, first=first, live=live, english=desktop)
        save_state(st, path)
    return {"ok": True, "sent": len(sent), "first": first, "results": sent[:10]}


def loop(interval=20, log=None, delay=0, stop=None):
    """In the phone server's thread or chatd's, until `stop` is set (forever without one). Errors are logged and
    the loop goes on."""
    stop = stop or threading.Event()
    if delay and stop.wait(delay):
        return
    while not stop.is_set():
        try:
            r = run_once()
            if log and r.get("sent"):
                log(f"phone push: {r['sent']} sent")
        except Exception as e:  # never take the web server down
            if log:
                log(f"phone push failed: {str(e)[:200]}")
        stop.wait(interval)


def start_thread(log=None):
    """chatd runs the loop too, so banners on this Mac do not need the phone service (setting notify_desktop).
    Returns the Event that ends it: chatd sets it when it stops serving."""
    stop = threading.Event()
    t = threading.Thread(target=loop, kwargs={"interval": 20, "log": log, "delay": 10, "stop": stop}, name="desktop-banners", daemon=True)
    t.start()
    return stop


def main(a):
    D.out(run_once(), getattr(a, "json", False), lambda r: print(_t(f"Sent {r.get('sent', 0)}" + (f" ({r['skipped']})" if r.get("skipped") else ""), f"推送了 {r.get('sent', 0)} 条" + (f"（{r['skipped']}）" if r.get("skipped") else ""))))
