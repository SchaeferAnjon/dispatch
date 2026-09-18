#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Dispatch over HTTP: the same React UI as the desktop app, served from this Mac so a
phone (or any browser) on the tailnet can use it. Every desktop command maps 1:1 to a
CLI call here (`bd … --json` / `dispatch … --json`), exactly like the Tauri layer does.

    dispatch serve            # foreground; prints the URL with the token
    dispatch serve url        # just the URL (for the phone)
    dispatch serve qr         # the same URL as a scannable QR in the terminal
    dispatch serve qr --svg   # the QR as SVG (the settings page embeds it)
    dispatch serve host [<id>|local]   # which Mac the phone link points at (settings dropdown)

Config: ~/tasks/.dispatch/serve.json {token, bind, port, actor, phone_host}. Binds to the
Tailscale address by default (fallback: LAN address); never to 0.0.0.0 unless bind says so.
Auth: Bearer token or the cookie set by opening /?token=… once (the PWA keeps it).
phone_host: a hosts.json id/name — `serve url` / `serve qr` then hand out THAT Mac's link
(asked over ssh, so it self-heals there too). Set it to the always-on Mac when this one
travels; the local daemon keeps running as a fallback.
"""
import json, os, re, secrets, subprocess, sys, time, urllib.parse
sys.dont_write_bytecode = True  # never write __pycache__ next to these files: inside Dispatch.app that breaks the code signature
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
DISPATCH_DIR = os.environ.get("DISPATCH_DIR") or os.path.join(HOME, "tasks", ".dispatch")
CONF = os.path.join(DISPATCH_DIR, "serve.json")
BEADS_DIR = os.environ.get("BEADS_DIR", os.path.join(HOME, "tasks", ".beads"))
HERE = os.path.dirname(os.path.abspath(__file__))
DISPATCH_PY = os.path.join(HERE, "dispatch.py")
DIST = os.environ.get("DISPATCH_DIST") or os.path.join(os.path.dirname(HERE), "dist")
STARTED = time.time()
try:
    SERVE_VERSION = open(os.path.join(HERE, "VERSION")).read().strip()
except OSError:
    SERVE_VERSION = ""
ICON = os.path.join(os.path.dirname(HERE), "src-tauri", "icons", "icon.png")
PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + os.path.join(HOME, ".local", "bin") + ":" + os.environ.get("PATH", "")
MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json"}


def load_conf():
    try:
        c = json.load(open(CONF))
    except Exception:
        c = {}
    if not c.get("token"):
        c["token"] = secrets.token_urlsafe(24)
        c.setdefault("port", 7799)
        c.setdefault("actor", os.environ.get("DISPATCH_ACTOR", os.path.basename(HOME)))
        os.makedirs(DISPATCH_DIR, exist_ok=True)
        json.dump(c, open(CONF, "w"), indent=2)
        os.chmod(CONF, 0o600)
    return c


def sh(args, env=None, timeout=120, input=None):
    e = dict(os.environ, PATH=PATH, BEADS_DIR=BEADS_DIR, BD_NON_INTERACTIVE="1", NO_COLOR="1")
    if env:
        e.update(env)
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=e, cwd=os.path.dirname(BEADS_DIR) if os.path.isdir(os.path.dirname(BEADS_DIR)) else HOME, input=input, stdin=subprocess.DEVNULL if input is None else None)
    if r.returncode != 0:
        raise RuntimeError((r.stderr.strip() or r.stdout.strip())[:600])
    return r.stdout


def json_only(s):
    i = min([x for x in (s.find("["), s.find("{")) if x >= 0] or [0])
    return s[i:]


def run_bd(args, actor):
    for attempt in range(3):
        try:
            return sh(["bd"] + args, env={"BEADS_ACTOR": actor})
        except RuntimeError as e:
            if "locked" in str(e) and attempt < 2:
                time.sleep(0.4 * (attempt + 1))
                continue
            raise


def run_dispatch(args, timeout=300):
    return sh(["python3", DISPATCH_PY] + args, timeout=timeout)


def _skill_file(name):
    p = os.path.realpath(run_dispatch(["skills", "path", name]).strip())
    allowed = [d for d in run_dispatch(["skills", "roots"]).splitlines() if d.strip()]
    if not any(p.startswith(os.path.realpath(d) + os.sep) for d in allowed if os.path.exists(d)):
        raise RuntimeError(f"不在技能目录里，拒绝：{p}")
    return p


def _rules_path():
    return run_dispatch(["rules", "path"]).strip()


# cmd -> (args dict, actor) -> result (str stays a string; anything else is JSON)
def commands():
    def dispatch_on(a, actor):
        import dispatch as d
        argv = a.get('args')
        if not isinstance(argv, list) or not argv or not all(isinstance(x,str) for x in argv): raise ValueError('无效的命令参数')
        host = a.get('host')
        full = ['--host', host] if host and host != 'local' else []
        return sh(['python3', DISPATCH_PY, *full, *argv], env={'BEADS_ACTOR': actor}, timeout=d.command_timeout(argv, default=300), input=a.get('stdin'))
    def bd(*a):
        return lambda args, actor: json_only(run_bd(list(a), actor))

    def C(cmd, *fixed):
        return lambda args, actor: json_only(run_bd([cmd, args["id"]] + list(fixed), actor))

    def bd_update(args, actor):
        f = args.get("fields") or {}
        a = ["update", args["id"]]
        for k, flag in (("title", "--title"), ("description", "--description"), ("priority", "--priority"), ("assignee", "--assignee"), ("acceptance", "--acceptance"), ("notes", "--notes")):
            if f.get(k) is not None:
                a += [flag, str(f[k])]
        return json_only(run_bd(a + ["--json"], actor))

    def bd_labels(args, actor):
        a = ["update", args["id"]]
        for l in args.get("add") or []:
            a += ["--add-label", l]
        for l in args.get("remove") or []:
            a += ["--remove-label", l]
        return json_only(run_bd(a + ["--json"], actor))

    def bd_create(args, actor):
        i = args["input"]
        a = ["create", i["title"]]
        if i.get("description"):
            a += ["--description", i["description"]]
        a += ["-t", i.get("issue_type") or "task", "-p", str(i.get("priority", 2))]
        if i.get("labels"):
            a += ["-l", ",".join(i["labels"])]
        if (i.get("acceptance") or "").strip():
            a += ["--acceptance", i["acceptance"]]
        if i.get("deps"):
            a += ["--deps", ",".join(i["deps"])]
        return json_only(run_bd(a + ["--json"], actor))

    def interactions(args, actor):
        p = os.path.join(BEADS_DIR, "interactions.jsonl")
        needle = f'"issue_id":"{args["id"]}"'
        try:
            lines = [l for l in open(p, encoding="utf-8", errors="replace") if needle in l]
        except OSError:
            lines = []
        return "[" + ",".join(l.strip() for l in lines) + "]"

    def resume_cmd(args, actor):
        cwd = args.get("cwd") or ""
        cd = f"cd '{cwd.replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}' && " if cwd else ""
        return cd + ("codex resume " if args.get("agent") == "codex" else "claude --resume ") + args["sessionId"]

    def memories_list(args, actor):
        raw = json.loads(json_only(run_bd(["memories", "--json"], actor)) or "{}")
        return sorted([{"key": k, "value": v} for k, v in raw.items() if k != "schema_version" and isinstance(v, str)], key=lambda m: m["key"])

    def stats(args, actor):
        a = ["stats", "--cached", "--json"]
        if args.get("agent"):
            a += ["--agent", args["agent"]]
        if args.get("days"):
            a += ["--days", str(args["days"])]
        return run_dispatch(a)

    def agent_start(args, actor):
        a = ["agent", "start", args["kind"], "--json", "--no-wait"]
        for k, flag in (("host", "--host"), ("cwd", "--cwd"), ("model", "--model"), ("task", "--task"), ("prompt", "--prompt"), ("label", "--label")):
            if args.get(k):
                a += [flag, str(args[k])]
        timeout = int(args.get("timeout") or 600000)
        # Return after startup and prompt delivery; the session continues in the background.
        a += ["--timeout", str(timeout), "--lines", str(args.get("lines") or 200)]
        return run_dispatch(a, timeout=timeout // 1000 + 200)

    def agent_ask(args, actor):
        timeout = int(args.get("timeout") or 600000)
        a = ["agent", "ask", args["target"], args["text"], "--json", "--timeout", str(timeout), "--lines", str(args.get("lines") or 200)]
        if args.get("host"):
            a += ["--host", args["host"]]
        return run_dispatch(a, timeout=timeout // 1000 + 200)

    return {
        "bd_info": lambda args, actor: {"bd_bin": "bd", "beads_dir": BEADS_DIR, "actor": actor, "version": run_bd(["version"], actor).strip(), "initial_view": None, "initial_task": None},
        "bd_list": bd("list", "--all", "-n", "0", "--json"),
        "bd_show": C("show", "--json"), "bd_comments": C("comments", "--json"), "bd_history": C("history", "--json"),
        "bd_interactions": interactions,
        "bd_claim": C("update", "--claim", "--json"),
        "bd_set_status": lambda args, actor: json_only(run_bd(["update", args["id"], "--status", args["status"], "--json"], actor)),
        "bd_close": lambda args, actor: json_only(run_bd(["close", args["id"], "--reason", args.get("reason", ""), "--json"], actor)),
        "bd_reopen": C("reopen", "--json"),
        "bd_comment": lambda args, actor: run_bd(["comments", "add", args["id"], args["text"]], actor),
        "bd_labels": bd_labels, "bd_update": bd_update, "bd_create": bd_create,
        "sessions": lambda a, _: run_dispatch(["sessions", "--json"]),
        "task_sessions": lambda a, _: run_dispatch(["find", a["id"], "--json"]),
        "session_list": lambda a, _: run_dispatch(["list", "--cached", "--limit", "500", "--json"]),
        "session_activity": lambda a, _: run_dispatch(["activity", "--json"]),
        "session_seen": lambda a, _: run_dispatch(["--host", a.get("host") or "local", "seen", a["key"], a["reply"], "--json"]),
        "session_detail": lambda a, _: run_dispatch(["session", a["id"], "--json"] + (["--brief"] if a.get("brief") else [])),
        "focus_session": lambda a, _: run_dispatch(["focus", a["id"]]),
        "resume_cmd": resume_cmd,
        "skills_list": lambda a, _: run_dispatch(["skills", "list", "--json"]),
        "skill_toggle": lambda a, _: run_dispatch(["skills", "enable" if a.get("on") else "disable", a["name"], "--agent", a["agent"]]),
        "skill_read": lambda a, _: open(_skill_file(a["name"]), encoding="utf-8").read(),
        "skill_write": lambda a, _: (lambda p: (open(p, "w", encoding="utf-8").write(a["content"]), p)[1])(_skill_file(a["name"])),
        "skill_open": lambda a, _: run_dispatch(["skills", "open", a["name"]]),
        "skills_improve": lambda a, _: run_dispatch(["skills", "improve", "--days", str(a.get("days", 14)), "--json"]),
        "insights": lambda a, _: run_dispatch(["insights", "--days", str(a.get("days", 14)), "--json"]),
        "env_list": lambda a, _: run_dispatch(["env", "list", "--json"]),
        "env_get": lambda a, _: run_dispatch(["env", "get", a["name"]]).rstrip("\n"),
        "env_set": lambda a, _: run_dispatch(["env", "set", a["name"], a["value"], "--note", a.get("note", "")]),
        "env_unset": lambda a, _: run_dispatch(["env", "unset", a["name"]]),
        "quota": lambda a, _: run_dispatch(["quota", "--json"]),
        "dispatch_on": dispatch_on,
        "stats": stats,
        "hosts": lambda a, _: run_dispatch(["hosts", "--json"]),
        "graph": lambda a, _: run_dispatch(["graph", "--json"]),
        "folders": lambda a, _: run_dispatch(["folders", "--cached", "--json"]),
        "open_path": lambda a, _: sh(["open", a["path"]]),
        "rules_read": lambda a, _: open(_rules_path(), encoding="utf-8").read(),
        "rules_write": lambda a, _: (open(_rules_path(), "w", encoding="utf-8").write(a["content"]), run_dispatch(["rules", "sync", "--json"]))[1],
        "rules_status": lambda a, _: run_dispatch(["rules", "status", "--json"]),
        "rules_sync": lambda a, _: run_dispatch(["rules", "sync", "--force", "--json"]),
        "memories_list": memories_list,
        "memory_set": lambda a, actor: json_only(run_bd(["remember", a["value"], "--key", a["key"], "--json"], actor)),
        "memory_forget": lambda a, actor: run_bd(["forget", a["key"]], actor),
        "agent_start": agent_start, "agent_ask": agent_ask,
        "agent_list": lambda a, _: run_dispatch(["agent", "list", "--json"] + (["--host", a["host"]] if a.get("host") else [])),
    }


CMDS = commands()


# Full-bleed, opaque icons for a phone's home screen (the desktop icon has transparent margins,
# which iOS paints black). They ship inside the web build, so the installed app has them too.
PHONE_ICONS = {"/apple-touch-icon.png": "apple-touch-icon.png", "/apple-touch-icon-precomposed.png": "apple-touch-icon.png",
               "/phone-icon-512.png": "phone-icon-512.png", "/icon.png": "phone-icon-512.png", "/favicon.ico": "apple-touch-icon.png"}


def phone_icon(path):
    full = os.path.join(DIST, PHONE_ICONS[path])
    if os.path.isfile(full):
        return full
    return ICON if os.path.isfile(ICON) else ""  # running from source before the first web build


def manifest():
    return json.dumps({"name": "Dispatch", "short_name": "Dispatch", "start_url": "/", "scope": "/", "display": "standalone", "background_color": "#F4F3EF", "theme_color": "#F4F3EF", "icons": [{"src": "/phone-icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"}, {"src": "/apple-touch-icon.png", "sizes": "180x180", "type": "image/png"}]})


SW = "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});"
INJECT = '<script>window.__DISPATCH_SERVE__=1;if("serviceWorker" in navigator)navigator.serviceWorker.register("/sw.js").catch(()=>{});</script><link rel="manifest" href="/manifest.webmanifest"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="Dispatch"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"><link rel="icon" type="image/png" href="/apple-touch-icon.png"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'


class H(BaseHTTPRequestHandler):
    conf = {}
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % a))

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        import hmac
        tok = self.conf["token"]
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].strip().encode(), tok.encode()):
            return True
        for part in self.headers.get("Cookie", "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "dispatch_token" and hmac.compare_digest(v.encode(), tok.encode()):
                return True
        return False

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(u.query)
        if "token" in q or "login" in q:
            import hmac
            # The pairing link carries the permanent token (shown only on this Mac: QR / copy link).
            # Links in phone notifications carry a single-use login code instead, so a notification
            # history that leaks (a public ntfy topic) cannot be replayed.
            ok = hmac.compare_digest(q["token"][0].encode(), self.conf["token"].encode()) if "token" in q else login_redeem(q["login"][0])
            self.send_response(302)
            to = (q.get("to") or [""])[0]
            destination = "/?" + urllib.parse.urlencode({"page": q["page"][0]}) if q.get("page") else ("/" + to if to.startswith("#/") else to if to.startswith("/insights/") else "/")
            # An expired login code still lands on the page: an already-paired phone has its cookie.
            self.send_header("Location", destination if ok or "login" in q else "/?bad=1")
            if ok:
                self.send_header("Set-Cookie", f"dispatch_token={self.conf['token']}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if u.path == "/manifest.webmanifest":
            return self._send(200, manifest(), MIME[".webmanifest"])
        if u.path == "/sw.js":
            return self._send(200, SW, MIME[".js"])
        if u.path in PHONE_ICONS:
            # Before the login check: iOS fetches the home-screen icon without the page's cookie.
            icon = phone_icon(u.path)
            if icon:
                return self._send(200, open(icon, "rb").read(), "image/png", {"Cache-Control": "max-age=86400"})
            return self._send(404, "", "text/plain")
        if u.path == "/api/health":
            # `version` lets an open phone page notice the Mac updated and offer a refresh.
            # `moved`: an open page learns that the phone's entry now lives on another Mac and reloads into the forward.
            return self._send(200, json.dumps({"ok": True, "authed": self._authed(), "version": SERVE_VERSION, "started": STARTED, "moved": bool(self._authed() and phone_home())}))
        if not self._authed():
            return self._send(401, "<meta charset=utf-8><p style='font:16px system-ui;padding:24px'>需要令牌：在 Mac 上跑 <code>dispatch serve url</code>，用它给的完整链接打开一次。</p>", "text/html; charset=utf-8")
        if u.path.startswith("/insights/"):
            # The report pages, for the phone: the desktop opens the file, the browser gets it here.
            rid = urllib.parse.unquote(u.path[len("/insights/"):]).removesuffix(".html")
            sys.path.insert(0, HERE)
            import insights_report
            hit = next((r for r in insights_report.all_reports() if r["id"] == rid and r.get("html") and os.path.isfile(r["html"])), None)
            if not hit:
                return self._send(404, "<meta charset=utf-8><p style='font:16px system-ui;padding:24px'>没有这份报告</p>", "text/html; charset=utf-8")
            return self._send(200, open(hit["html"], "rb").read(), "text/html; charset=utf-8")
        path = "/index.html" if u.path in ("", "/") else u.path
        if path == "/index.html" and "stay" not in q:
            # The phone was paired with this Mac before its entry moved to the always-on one:
            # take it there. If that Mac does not answer, keep serving here.
            home = phone_home()
            link = remote_login_link(home) if home else ""
            if link:
                return self._send(200, moved_page(link, home.get("name") or home["id"]), "text/html; charset=utf-8")
        full = os.path.realpath(os.path.join(DIST, path.lstrip("/")))
        if not full.startswith(os.path.realpath(DIST) + os.sep) or not os.path.isfile(full):
            full = os.path.join(DIST, "index.html")
        ext = os.path.splitext(full)[1]
        data = open(full, "rb").read()
        if full.endswith("index.html"):
            data = data.decode("utf-8").replace("<head>", "<head>" + INJECT, 1).encode("utf-8")
        cache = {"Cache-Control": "max-age=31536000, immutable"} if "/assets/" in full else None
        self._send(200, data, MIME.get(ext, "application/octet-stream"), cache)

    def do_POST(self):
        if self.path != "/api/call":
            return self._send(404, json.dumps({"error": "not found"}))
        if not self._authed():
            return self._send(401, json.dumps({"error": "需要令牌"}))
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
            cmd, args = body.get("cmd"), body.get("args") or {}
            fn = CMDS.get(cmd)
            if not fn:
                return self._send(400, json.dumps({"error": f"未知命令 {cmd}"}))
            res = fn(args, self.conf.get("actor") or os.path.basename(HOME.rstrip("/")) or "user")
            payload = {"result": res} if isinstance(res, str) else {"value": res}
            return self._send(200, json.dumps(payload, ensure_ascii=False))
        except Exception as e:
            return self._send(500, json.dumps({"error": str(e)[:800]}, ensure_ascii=False))


def detect_address(conf=None):
    """Tailscale's address when there is one. The LAN address only when the person allowed it
    (`serve install --lan`, or the switch in settings): the token grants running commands on this
    Mac, so listening to everything on a café Wi-Fi is not something to do silently."""
    sys.path.insert(0, HERE)
    import dispatch as d
    return d.tailscale_ip() or (d.lan_ip() if (conf or {}).get("allow_lan") else "")


def bind_address(conf, wait=0):
    """Tailscale address, else LAN address. Detection shells out with 3 s timeouts, and on
    a loaded machine (a `dispatch-update` build restarting this daemon) both can time out
    at once; a server that silently binds 127.0.0.1 then hands the phone a dead link, so
    the daemon keeps retrying for `wait` seconds before it accepts loopback."""
    if conf.get("bind"):
        return conf["bind"]
    deadline = time.time() + wait
    while True:
        ip = detect_address(conf)
        if ip or time.time() >= deadline:
            break
        time.sleep(3)
    if not ip:
        print("没有 Tailscale 地址，也没允许局域网访问：只监听 127.0.0.1（手机连不上）。设置 → 手机访问 里可以允许同一 Wi-Fi 的设备访问。", file=sys.stderr, flush=True)
    return ip or "127.0.0.1"


def url(conf, ip):
    return f"http://{ip}:{conf.get('port', 7799)}/?token={conf['token']}"


def plain_url(conf, ip):
    """The address without the token: what goes into logs."""
    return f"http://{ip}:{conf.get('port', 7799)}/"


LOGINS = os.path.join(DISPATCH_DIR, "serve-logins.json")
LOGIN_TTL = 24 * 3600


def _logins_load():
    try:
        d = json.load(open(LOGINS))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _logins_save(d):
    os.makedirs(DISPATCH_DIR, exist_ok=True)
    tmp = LOGINS + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(d, f)
    os.replace(tmp, LOGINS)


def login_issue(now=None, ttl=None):
    """A single-use code that `?login=` trades for the session cookie. Good for a day unless the
    caller asks for less (a link that travels through a public ntfy topic gets minutes, not a day)."""
    now = now or time.time()
    d = {k: v for k, v in _logins_load().items() if v > now}
    code = secrets.token_urlsafe(18)
    d[code] = now + min(LOGIN_TTL, ttl or LOGIN_TTL)
    if len(d) > 400:  # a phone that never opens its notifications must not grow this forever
        d = dict(sorted(d.items(), key=lambda kv: kv[1])[-400:])
    _logins_save(d)
    return code


def login_redeem(code, now=None):
    now = now or time.time()
    d = _logins_load()
    exp = d.pop(code, None)
    if exp is None:
        return False
    _logins_save({k: v for k, v in d.items() if v > now})
    return exp > now


def serve_log():
    return os.path.join(DISPATCH_DIR, "serve.log")


def service_status(conf):
    """Whether the phone service is installed (LaunchAgent), running, and where it listens."""
    sys.path.insert(0, HERE)
    import dispatch as d
    plist = os.path.expanduser(f"~/Library/LaunchAgents/{LAUNCHD_LABEL}.plist")
    loaded = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{LAUNCHD_LABEL}"], capture_output=True).returncode == 0
    ts, lan = d.tailscale_ip(), d.lan_ip()
    ip = conf.get("bind") or ts or (lan if conf.get("allow_lan") else "") or "127.0.0.1"
    return {"installed": os.path.exists(plist), "loaded": loaded, "running": reachable(ip, conf.get("port", 7799), 0.6), "address": ip, "port": conf.get("port", 7799),
            "tailscale": bool(ts), "tailscale_ip": ts or "", "lan_ip": lan or "", "allow_lan": bool(conf.get("allow_lan")),
            "phone_reachable": ip != "127.0.0.1", "log": serve_log(), "built": os.path.isfile(os.path.join(DIST, "index.html"))}


def service_install(conf, allow_lan=None):
    """Register this file as a LaunchAgent (what scripts/serve-setup.sh did, but shipped in the
    app): runs at login, restarts if it dies, logs to ~/tasks/.dispatch/serve.log (0600)."""
    import plistlib
    if allow_lan is not None:
        conf["allow_lan"] = bool(allow_lan)
        json.dump(conf, open(CONF, "w"), indent=2)
        os.chmod(CONF, 0o600)
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        raise SystemExit(f"没有网页资源 {DIST}/index.html：从源码跑的话先在 app/ 里 npm run build")
    agents = os.path.expanduser("~/Library/LaunchAgents")
    os.makedirs(agents, exist_ok=True)
    plist = os.path.join(agents, f"{LAUNCHD_LABEL}.plist")
    log = serve_log()
    os.makedirs(DISPATCH_DIR, exist_ok=True)
    os.close(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600))
    os.chmod(log, 0o600)
    body = {"Label": LAUNCHD_LABEL, "ProgramArguments": [sys.executable, os.path.join(HERE, "serve.py")],
            "EnvironmentVariables": {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + os.path.join(HOME, ".local", "bin"), "BEADS_DIR": BEADS_DIR, "PYTHONDONTWRITEBYTECODE": "1"},
            "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10, "StandardOutPath": log, "StandardErrorPath": log}
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LAUNCHD_LABEL}"], capture_output=True)
    fd = os.open(plist, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        plistlib.dump(body, f)
    r = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", plist], capture_output=True, text=True)
    if r.returncode != 0:  # not in a GUI session (ssh)
        subprocess.run(["launchctl", "load", plist], capture_output=True)
    st = {}
    for _ in range(24):
        time.sleep(0.5)
        st = service_status(conf)
        if st["running"]:
            break
    return st


def service_uninstall():
    plist = os.path.expanduser(f"~/Library/LaunchAgents/{LAUNCHD_LABEL}.plist")
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LAUNCHD_LABEL}"], capture_output=True)
    try:
        os.remove(plist)
    except FileNotFoundError:
        pass
    return {"installed": False}


sys.path.insert(0, HERE)
import launchd_labels  # noqa: E402
LAUNCHD_LABEL = launchd_labels.label("dispatch-serve")


def reachable(ip, port, timeout=1.0):
    import socket
    try:
        with socket.create_connection((ip, int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def ensure_reachable(conf, ip):
    """`serve url` is what the desktop copies for the phone: make sure the daemon actually
    answers at that address, and if it bound somewhere else (loopback after a failed
    detection) restart it through launchd and wait for it to come back."""
    port = conf.get("port", 7799)
    if reachable(ip, port):
        return
    job = f"gui/{os.getuid()}/{LAUNCHD_LABEL}"
    if subprocess.run(["launchctl", "print", job], capture_output=True).returncode != 0:
        raise SystemExit(f"手机访问还没开启：Dispatch → 设置 → 手机访问 → 开启，或在终端里 `dispatch serve install`")
    subprocess.run(["launchctl", "kickstart", "-k", job], capture_output=True)
    for _ in range(20):
        time.sleep(0.5)
        if reachable(ip, port):
            return
    raise SystemExit(f"网页版服务重启后仍连不上 {ip}:{port}，看 {serve_log()}")


def phone_url(conf, ip):
    """The link the phone should open: this Mac's, or the phone_host's when configured
    (the always-on Mac). Falls back to the local link, with a note, when that Mac is down."""
    target = conf.get("phone_host")
    if target:
        sys.path.insert(0, HERE)
        import dispatch as d
        h = next((x for x in d.hosts() if target in (x["id"], x["name"])), None)
        if h is None:
            print(f"serve.json 的 phone_host={target} 不在 hosts.json 里，先用本机链接", file=sys.stderr, flush=True)
        else:
            cmd = f"env {d.remote_beads(h)} {h.get('dispatch', 'dispatch')} serve url"
            try:
                r = subprocess.run(["ssh", "-o", "ConnectTimeout=3", "-o", "BatchMode=yes", h["ssh"], cmd], capture_output=True, text=True, timeout=25)
                u = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""
                if r.returncode == 0 and u.startswith("http"):
                    return u
                print(f"{h['name']} 上的网页版拿不到链接（{(r.stderr or r.stdout).strip()[:200]}），先用本机链接", file=sys.stderr, flush=True)
            except (OSError, subprocess.TimeoutExpired) as e:
                print(f"连不上 {h['name']}（{e}），先用本机链接", file=sys.stderr, flush=True)
    try:
        ensure_reachable(conf, ip)
    except SystemExit as e:
        if not target:
            raise
        print(e, file=sys.stderr, flush=True)
    return url(conf, ip)


def phone_home(conf=None):
    """The Mac the phone is meant to use (`serve host <id>`), as a hosts.json row; None when it is
    this Mac. Read fresh each time: the running service must notice a change made from settings."""
    if conf is None:
        try:
            conf = json.load(open(CONF))
        except Exception:
            return None
    target = conf.get("phone_host")
    if not target:
        return None
    sys.path.insert(0, HERE)
    import dispatch as d
    return next((x for x in d.hosts() if target in (x["id"], x["name"]) and x.get("ssh")), None)


_HOME_DOWN = {"at": 0.0}


def remote_login_link(h, to="", ttl=300):
    """A single-use link into the phone service on another Mac, asked for over ssh. '' when that
    Mac does not answer (remembered for 30 s, so a Mac that is off does not slow every request)."""
    import shlex
    if time.time() - _HOME_DOWN["at"] < 30:
        return ""
    sys.path.insert(0, HERE)
    import dispatch as d
    cmd = f"env {d.remote_beads(h)} {d.remote_cli(h)} serve login-link --ttl {int(ttl)}" + (f" --to {shlex.quote(to)}" if to else "")
    try:
        r = subprocess.run(["ssh", "-o", "ConnectTimeout=3", "-o", "BatchMode=yes", h["ssh"], cmd], capture_output=True, text=True, timeout=15)
        u = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""
        if r.returncode == 0 and u.startswith("http"):
            return u
    except (OSError, subprocess.TimeoutExpired):
        pass
    _HOME_DOWN["at"] = time.time()
    return ""


def login_link(conf, to="", ttl=300):
    """This Mac's own single-use link. Refuses when this Mac itself points the phone elsewhere:
    two Macs pointing at each other would bounce the phone back and forth."""
    if conf.get("phone_host"):
        raise SystemExit("这台电脑自己的手机入口也指向别的电脑（serve host），不发登录链接")
    ip = bind_address(conf, wait=0)
    if ip == "127.0.0.1":
        raise SystemExit("这台电脑的手机服务只监听本机，手机连不上")
    q = {"login": login_issue(ttl=ttl)}
    if to:
        q["to"] = to
    return f"http://{ip}:{conf.get('port', 7799)}/?" + urllib.parse.urlencode(q)


def moved_page(link, name):
    """What an already-paired phone gets from the old entry: it is taken to the new one (keeping
    the page it asked for), and told to save the new address."""
    import html
    return ("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Dispatch</title>"
            "<body style='font:16px/1.6 system-ui;padding:28px;max-width:30em;margin:auto'>"
            f"<p><b>手机入口已经搬到「{html.escape(name)}」。</b></p><p>正在带你过去。到了之后把新页面重新「添加到主屏幕」或存成书签，以后这台电脑关着也能打开。</p>"
            f"<p><a id=go href='{html.escape(link, quote=True)}'>没有自动跳转就点这里</a></p>"
            "<script>var a=document.getElementById('go'),h=location.hash;if(h&&h.length>2)a.href+='&to='+encodeURIComponent(h);location.replace(a.href);</script>")


def cmd_host(conf, argv):
    """`serve host` — which Mac the phone link points at; `serve host <id>|local` changes it.
    The desktop's settings page renders this as a dropdown (hosts.json plus this Mac)."""
    sys.path.insert(0, HERE)
    import dispatch as d
    want_json = "--json" in argv
    target = next((x for x in argv if not x.startswith("--")), None)
    others = d.hosts()
    if target is not None:
        if target in ("local", "本机", ""):
            conf.pop("phone_host", None)
        else:
            h = next((x for x in others if target in (x["id"], x["name"])), None)
            if h is None:
                raise SystemExit(f"hosts.json 里没有叫 {target} 的机器；可选：local、" + "、".join(x["id"] for x in others))
            conf["phone_host"] = h["id"]
        json.dump(conf, open(CONF, "w"), indent=2)
    cur = conf.get("phone_host") or "local"
    rows = [{"id": "local", "name": d.local_host_name(), "local": True}] + [{"id": x["id"], "name": x["name"], "local": False} for x in others]
    if cur != "local" and not any(r["id"] == cur for r in rows):
        rows.append({"id": cur, "name": f"{cur}（不在 hosts.json 里）", "local": False})
    if want_json:
        print(json.dumps({"phone_host": cur, "hosts": rows}, ensure_ascii=False))
    else:
        name = next(r["name"] for r in rows if r["id"] == cur)
        print(f"手机版跑在：{name}（{cur}）" + ("" if len(rows) > 1 else "；hosts.json 里没有别的机器"))


def main():
    if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help", "help"):
        print("用法：dispatch serve [install [--lan|--no-lan] | uninstall | status | url | qr | host … | login-link [--to 路径] [--ttl 秒]] [--json]\n不带子命令：在前台启动手机服务。")
        return
    conf = load_conf()
    if len(sys.argv) > 1 and sys.argv[1] == "host":
        return cmd_host(conf, sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] in ("install", "uninstall", "status"):
        op, rest = sys.argv[1], sys.argv[2:]
        r = service_install(conf, allow_lan=True if "--lan" in rest else False if "--no-lan" in rest else None) if op == "install" else service_uninstall() if op == "uninstall" else service_status(conf)
        if "--json" in rest:
            print(json.dumps(r, ensure_ascii=False))
        elif op == "uninstall":
            print("已关闭手机访问（常驻服务已卸载）")
        else:
            print(("手机访问已开启：" if r.get("running") else "常驻服务已装，但还没应答：" if r.get("installed") else "手机访问没开启：") + f"{r.get('address')}:{r.get('port')}"
                  + ("" if r.get("phone_reachable") else "（只监听本机：没有 Tailscale，也没允许局域网；`dispatch serve install --lan` 允许同一 Wi-Fi 的设备访问）"))
        return
    if len(sys.argv) > 1 and sys.argv[1] == "login-link":
        rest = sys.argv[2:]
        opt = lambda k, d="": rest[rest.index(k) + 1] if k in rest and rest.index(k) + 1 < len(rest) else d
        print(login_link(conf, to=opt("--to"), ttl=int(opt("--ttl", "300") or 300)))
        return
    ip = bind_address(conf, wait=0 if len(sys.argv) > 1 else 60)
    if len(sys.argv) > 1 and sys.argv[1] == "url":
        print(phone_url(conf, ip))
        return
    if len(sys.argv) > 1 and sys.argv[1] == "qr":
        # The settings page embeds the same QR as SVG; the terminal gets half blocks.
        try:
            u = phone_url(conf, ip)
        except SystemExit as e:
            # A QR for an address nothing answers on only produces 「无法连接」 on the phone.
            print(e, file=sys.stderr, flush=True)
            sys.exit(1)
        sys.path.insert(0, HERE)
        import qr as qrlib
        code = qrlib.matrix(u)
        if "--svg" in sys.argv[2:]:
            print(qrlib.render_svg(code))
        else:
            print(qrlib.render_blocks(code))
            print(f"\n手机相机扫这个二维码，或在手机上打开：{u}")
        return
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        sys.exit(f"没有构建产物 {DIST}/index.html：先在 app/ 里 npm run build")
    H.conf = conf
    try:
        srv = ThreadingHTTPServer((ip, int(conf.get("port", 7799))), H)
    except OSError as e:
        if e.errno == 48:  # EADDRINUSE: the launchd service (or another copy) already serves this port
            print(f"端口 {conf.get('port', 7799)} 已经有一个手机服务在跑（多半是常驻服务）。看状态：`dispatch serve status`；要换端口改 ~/tasks/.dispatch/serve.json 的 port。", file=sys.stderr)
            sys.exit(1)
        raise
    srv.daemon_threads = True
    # The phone only reaches an awake Mac: hold off idle sleep for as long as this daemon lives
    # (caffeinate exits with us). The display may still sleep — the desktop app handles that.
    try:
        subprocess.Popen(["caffeinate", "-is", "-w", str(os.getpid())], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass
    print(f"Dispatch 网页版：{plain_url(conf, ip)}（带令牌的配对链接用 `dispatch serve url` 取，不写进日志）", flush=True)
    # Phone pushes (ntfy / Bark) for finished replies and confirmations, so the phone hears
    # about them without the desktop app being open. No-op until a channel is configured.
    try:
        import threading
        sys.path.insert(0, HERE)
        import notify_watch
        threading.Thread(target=notify_watch.loop, kwargs={"interval": 20, "log": lambda m: print(m, file=sys.stderr, flush=True)}, daemon=True).start()
    except Exception as e:
        print(f"phone push watcher not started: {e}", file=sys.stderr, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
