#!/usr/bin/env python3
"""Push a short message to the phone, or fall back to a macOS banner.

    dispatch notify "<title>" "<body>" [--url LINK] [--level normal|high] [--key KEY]

Channels come from `dispatch env`, so there is nothing else to configure:
  NTFY_URL   the topic address, e.g. https://ntfy.sh/my-topic (or a self-hosted server)
  BARK_KEY   the key in https://api.day.app/<key> (a full BARK_URL also works)
Both set → ntfy wins. Neither → osascript on this Mac. Pure urllib, no dependencies.

`--key` makes a message idempotent: the same key inside DEDUP_WINDOW seconds is sent
once. The presence hook uses it so a session that keeps asking does not ring the phone
on every hook event.

Callers that must never fail (hooks, report generation) import `send` directly; it
returns a dict and swallows network errors into `error` instead of raising.
"""
import argparse, json, os, subprocess, sys, time, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import dispatch as D

DEDUP_FILE = os.path.join(D.DISPATCH_DIR, "notify-dedup.json")
DEDUP_WINDOW = 300  # seconds
DEDUP_KEEP = 86400  # forget keys older than a day


def setting(name):
    """Value from `dispatch env` (the store agents use), then the process environment."""
    try:
        for it in D.env_read():
            if it["name"] == name and it["value"].strip():
                return it["value"].strip()
    except Exception:
        pass
    return (os.environ.get(name) or "").strip()


def channel():
    """('ntfy', url) | ('bark', key) | ('macos', '')."""
    ntfy = setting("NTFY_URL")
    if ntfy:
        return "ntfy", ntfy
    bark = setting("BARK_KEY")
    if bark:
        return "bark", bark
    return "macos", ""


def dedup_hit(key, window=DEDUP_WINDOW, path=None):
    """True when the same key was sent within `window` seconds; otherwise records it now."""
    if not key:
        return False
    path = path or DEDUP_FILE
    now = time.time()
    try:
        seen = json.load(open(path))
    except Exception:
        seen = {}
    try:
        last = float(seen.get(key) or 0)
    except (TypeError, ValueError):
        last = 0
    if now - last < window:
        return True
    seen = {k: v for k, v in seen.items() if now - float(v or 0) < DEDUP_KEEP}
    seen[key] = now
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        json.dump(seen, open(tmp, "w"))
        os.replace(tmp, path)
    except OSError:
        pass
    return False


def serve_link(path):
    """A page on `dispatch serve`, with the auth token, for the phone to open. '' if unset."""
    try:
        conf = json.load(open(os.path.join(D.DISPATCH_DIR, "serve.json")))
    except Exception:
        return ""
    if not conf.get("token"):
        return ""
    ip = conf.get("bind") or D.tailscale_ip() or D.lan_ip() or "127.0.0.1"
    return f"http://{ip}:{conf.get('port', 7799)}{path}?token={conf['token']}"


def _post(url, payload, timeout=10):
    req = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json; charset=utf-8"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status


def _ntfy(url, title, body, level, link):
    """ntfy JSON publish: the topic is the last path segment, the server is the rest."""
    p = urllib.parse.urlsplit(url if "://" in url else "https://" + url)
    segs = [s for s in p.path.split("/") if s]
    topic = segs[-1] if segs else "dispatch"
    base = urllib.parse.urlunsplit((p.scheme, p.netloc, "/" + "/".join(segs[:-1]) if len(segs) > 1 else "", "", "")) or url
    payload = {"topic": topic, "title": title, "message": body, "priority": 5 if level == "high" else 3}
    if link:
        payload["click"] = link
    return _post(base, payload)


def _bark(key, title, body, level, link):
    base = key.rstrip("/") if key.startswith("http") else "https://api.day.app/" + key.strip("/")
    payload = {"title": title, "body": body, "level": "timeSensitive" if level == "high" else "active", "group": "Dispatch"}
    if link:
        payload["url"] = link
    return _post(base, payload)


def _macos(title, body):
    def esc(s):
        return s.replace("\\", "\\\\").replace('"', '\\"')
    script = f'display notification "{esc(body)}" with title "{esc(title)}"'
    subprocess.run(["osascript", "-e", script], capture_output=True, timeout=10)


def send(title, body="", url="", level="normal", key=""):
    """Send one message. Never raises: failures come back as ok=False + error.

    If the configured channel fails (phone offline, bad URL) the Mac still gets a banner,
    so the message is not silently lost.
    """
    title = (title or "").strip() or "Dispatch"
    body = (body or "").strip()
    if key and dedup_hit(key):
        return {"ok": True, "channel": "dedup", "skipped": True}
    name, target = channel()
    if name == "macos":
        try:
            _macos(title, body)
            return {"ok": True, "channel": "macos"}
        except Exception as e:
            return {"ok": False, "channel": "macos", "error": str(e)[:200]}
    try:
        status = _ntfy(target, title, body, level, url) if name == "ntfy" else _bark(target, title, body, level, url)
        return {"ok": True, "channel": name, "status": status}
    except Exception as e:
        try:
            _macos(title, body)
            return {"ok": False, "channel": name, "error": str(e)[:200], "fallback": "macos"}
        except Exception:
            return {"ok": False, "channel": name, "error": str(e)[:200]}


def main(a):
    res = send(getattr(a, "title", ""), getattr(a, "body", "") or "", getattr(a, "url", "") or "",
               getattr(a, "level", "normal"), getattr(a, "key", "") or "")

    def text(r):
        if r.get("skipped"):
            print("5 分钟内发过同样的通知，跳过")
        elif r.get("ok"):
            print("已推到手机（ntfy）" if r["channel"] == "ntfy" else "已推到手机（Bark）" if r["channel"] == "bark"
                  else "已发本机通知。配 NTFY_URL 或 BARK_KEY 就能推到手机：dispatch env set NTFY_URL https://ntfy.sh/你的主题")
        else:
            print(f"通知没发出去（{r['channel']}）：{r.get('error', '')}" + ("，已退回本机通知" if r.get("fallback") else ""), file=sys.stderr)

    D.out(res, getattr(a, "json", False), text)
    if not res.get("ok") and not res.get("skipped"):
        sys.exit(1)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="push a message to the phone (ntfy / Bark) or a macOS banner")
    p.add_argument("title")
    p.add_argument("body", nargs="?", default="")
    p.add_argument("--url", default="")
    p.add_argument("--level", choices=["normal", "high"], default="normal")
    p.add_argument("--key", default="")
    p.add_argument("--json", action="store_true")
    main(p.parse_args())
