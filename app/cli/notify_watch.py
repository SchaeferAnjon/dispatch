#!/usr/bin/env python3
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
import json, os, sys, time

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
import dispatch as D  # noqa: E402

STATE_FILE = os.path.join(D.DISPATCH_DIR, "notify-watch.json")
AGENT_NAMES = {"claude-code": "Claude Code", "codex": "Codex", "pi": "pi", "zcode": "ZCode", "opencode": "OpenCode", "hermes": "Hermes", "gemini": "Gemini"}
KEEP = 600  # remembered reply / attention ids


def load_state(path=STATE_FILE):
    try:
        d = json.load(open(path))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_state(st, path=STATE_FILE):
    for k in ("replies", "attention"):
        v = st.get(k) or []
        st[k] = v[-KEEP:]
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(tmp, "w") as f:
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


def tick(rows, settings, st, send, link, now=None, first=False, live=()):
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
        agent = AGENT_NAMES.get(s.get("agent", ""), s.get("agent", ""))
        sid = s.get("session_id", "")
        mark = f"{s.get('agent')}:{sid}|{int(float(s.get('last_at') or 0))}"
        if mark in seen_a:
            continue
        seen_a.add(mark); st["attention"] = list(seen_a)
        if not first and wanted(settings, "notify_attention"):
            title = (s.get("title") or s.get("project") or "").strip()
            # Same dedup key as the Claude Code hook's own push, so one confirmation rings once.
            sent.append(send(f"{agent} 等你确认 · {s.get('project') or title}", title or "打开会话看确认请求", level="high",
                             url=link(f"/#/sessions/{sid}"), key=f"presence:{s.get('agent')}:{sid}"))
    for s in rows:
        if s.get("scheduled") or s.get("remote") or s.get("daemon"):
            continue
        key = s.get("key") or f"{s.get('agent')}:{s.get('session_id')}"
        agent = AGENT_NAMES.get(s.get("agent", ""), s.get("agent", ""))
        title = (s.get("title") or s.get("project") or "").strip()
        proj = (s.get("project") or "").strip()
        rid = s.get("reply_id") or ""
        if rid and s.get("unread"):
            mark = f"{key}|{rid}"
            if mark not in seen_r:
                seen_r.add(mark); st["replies"] = list(seen_r)
                if not first and wanted(settings, "notify_reply") and now - float(s.get("reply_at") or 0) < 6 * 3600:
                    body = (s.get("reply_preview") or "").strip().replace("\n", " ")[:160] or "本轮结束，打开看看"
                    sent.append(send(f"{agent} 回复了 · {proj or title}", f"{title}\n{body}" if title and title != proj else body,
                                     url=link(f"/#/sessions/{s.get('session_id', '')}"), key=f"reply:{mark}"))
    return sent


def run_once(path=STATE_FILE):
    import notify
    from activity import activity_list
    if not phone_channel_ready(notify):
        return {"ok": True, "skipped": "no phone channel (NTFY_URL / BARK_KEY)", "sent": 0}
    st = load_state(path)
    first = not os.path.exists(path)
    rows = activity_list(D.HOME, D.DISPATCH_DIR, D.load_index())
    try:
        live = D.live_sessions(local_only=True)
    except Exception:
        live = []
    try:
        settings = D.settings_load()
    except Exception:
        settings = {}
    sent = tick(rows, settings, st, notify.send, notify.serve_link, first=first, live=live)
    save_state(st, path)
    return {"ok": True, "sent": len(sent), "first": first, "results": sent[:10]}


def loop(interval=20, log=None):
    """Forever, in the phone server's thread. Errors are logged and the loop goes on."""
    while True:
        try:
            r = run_once()
            if log and r.get("sent"):
                log(f"phone push: {r['sent']} sent")
        except Exception as e:  # never take the web server down
            if log:
                log(f"phone push failed: {str(e)[:200]}")
        time.sleep(interval)


def main(a):
    D.out(run_once(), getattr(a, "json", False), lambda r: print(f"推送了 {r.get('sent', 0)} 条" + (f"（{r['skipped']}）" if r.get("skipped") else "")))
