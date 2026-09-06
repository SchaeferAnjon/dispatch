#!/usr/bin/env python3
"""Dispatch over HTTP: the same React UI as the desktop app, served from this Mac so a
phone (or any browser) on the tailnet can use it. Every desktop command maps 1:1 to a
CLI call here (`bd … --json` / `dispatch … --json`), exactly like the Tauri layer does.

    dispatch serve            # foreground; prints the URL with the token
    dispatch serve url        # just the URL (for the phone)

Config: ~/tasks/.dispatch/serve.json {token, bind, port, actor}. Binds to the Tailscale
address by default (fallback: LAN address); never to 0.0.0.0 unless bind says so.
Auth: Bearer token or the cookie set by opening /?token=… once (the PWA keeps it).
"""
import json, os, re, secrets, subprocess, sys, time, urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
DISPATCH_DIR = os.path.join(HOME, "tasks", ".dispatch")
CONF = os.path.join(DISPATCH_DIR, "serve.json")
BEADS_DIR = os.environ.get("BEADS_DIR", os.path.join(HOME, "tasks", ".beads"))
HERE = os.path.dirname(os.path.abspath(__file__))
DISPATCH_PY = os.path.join(HERE, "dispatch.py")
DIST = os.environ.get("DISPATCH_DIST") or os.path.join(os.path.dirname(HERE), "dist")
ICON = os.path.join(os.path.dirname(HERE), "src-tauri", "icons", "icon.png")
PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + os.path.join(HOME, ".local", "bin") + ":" + os.environ.get("PATH", "")
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


def run_dispatch(args):
    return sh(["python3", DISPATCH_PY] + args, timeout=300)


def _skill_file(name):
    p = os.path.realpath(run_dispatch(["skills", "path", name]).strip())
    allowed = [os.path.join(HOME, d) for d in (".cc-switch/skills", ".claude/skills", ".agents/skills", "Projects")]
    if not any(p.startswith(os.path.realpath(d) + os.sep) for d in allowed if os.path.exists(d)):
        raise RuntimeError(f"不在技能目录里，拒绝：{p}")
    return p


def _rules_path():
    return run_dispatch(["rules", "path"]).strip()


# cmd -> (args dict, actor) -> result (str stays a string; anything else is JSON)
def commands():
    def dispatch_on(a, actor):
        argv = a.get('args')
        if not isinstance(argv, list) or not argv or not all(isinstance(x,str) for x in argv): raise ValueError('无效的命令参数')
        host = a.get('host')
        full = ['--host', host] if host and host != 'local' else []
        return sh(['python3', DISPATCH_PY, *full, *argv], env={'BEADS_ACTOR': actor}, timeout=300, input=a.get('stdin'))
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
        a = ["agent", "start", args["kind"], "--json"]
        for k, flag in (("host", "--host"), ("cwd", "--cwd"), ("model", "--model"), ("task", "--task"), ("prompt", "--prompt"), ("label", "--label")):
            if args.get(k):
                a += [flag, str(args[k])]
        a += ["--timeout", str(args.get("timeout") or 600000)]
        return run_dispatch(a)

    def agent_ask(args, actor):
        a = ["agent", "ask", args["target"], args["text"], "--json", "--timeout", str(args.get("timeout") or 600000)]
        if args.get("host"):
            a += ["--host", args["host"]]
        return run_dispatch(a)

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
        "session_detail": lambda a, _: run_dispatch(["session", a["id"], "--json"]),
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


def manifest():
    return json.dumps({"name": "Dispatch", "short_name": "Dispatch", "start_url": "/", "scope": "/", "display": "standalone", "background_color": "#F4F3EF", "theme_color": "#F4F3EF", "icons": [{"src": "/icon.png", "sizes": "512x512", "type": "image/png"}]})


SW = "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});"
INJECT = '<script>window.__DISPATCH_SERVE__=1;if("serviceWorker" in navigator)navigator.serviceWorker.register("/sw.js").catch(()=>{});</script><link rel="manifest" href="/manifest.webmanifest"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="Dispatch"><link rel="apple-touch-icon" href="/icon.png"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'


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
        tok = self.conf["token"]
        auth = self.headers.get("Authorization", "")
        if auth == f"Bearer {tok}":
            return True
        cookie = self.headers.get("Cookie", "")
        return f"dispatch_token={tok}" in cookie

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(u.query)
        if "token" in q:
            ok = q["token"][0] == self.conf["token"]
            self.send_response(302)
            self.send_header("Location", "/" if ok else "/?bad=1")
            if ok:
                self.send_header("Set-Cookie", f"dispatch_token={self.conf['token']}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if u.path == "/manifest.webmanifest":
            return self._send(200, manifest(), MIME[".webmanifest"])
        if u.path == "/sw.js":
            return self._send(200, SW, MIME[".js"])
        if u.path == "/icon.png" and os.path.exists(ICON):
            return self._send(200, open(ICON, "rb").read(), "image/png", {"Cache-Control": "max-age=86400"})
        if u.path == "/api/health":
            return self._send(200, json.dumps({"ok": True, "authed": self._authed()}))
        if not self._authed():
            return self._send(401, "<meta charset=utf-8><p style='font:16px system-ui;padding:24px'>需要令牌：在 Mac 上跑 <code>dispatch serve url</code>，用它给的完整链接打开一次。</p>", "text/html; charset=utf-8")
        path = "/index.html" if u.path in ("", "/") else u.path
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
            res = fn(args, self.conf.get("actor", "schaefer"))
            payload = {"result": res} if isinstance(res, str) else {"value": res}
            return self._send(200, json.dumps(payload, ensure_ascii=False))
        except Exception as e:
            return self._send(500, json.dumps({"error": str(e)[:800]}, ensure_ascii=False))


def bind_address(conf):
    if conf.get("bind"):
        return conf["bind"]
    sys.path.insert(0, HERE)
    import dispatch as d
    return d.tailscale_ip() or d.lan_ip() or "127.0.0.1"


def url(conf, ip):
    return f"http://{ip}:{conf.get('port', 7799)}/?token={conf['token']}"


def main():
    conf = load_conf()
    ip = bind_address(conf)
    if len(sys.argv) > 1 and sys.argv[1] == "url":
        print(url(conf, ip))
        return
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        sys.exit(f"没有构建产物 {DIST}/index.html：先在 app/ 里 npm run build")
    H.conf = conf
    srv = ThreadingHTTPServer((ip, int(conf.get("port", 7799))), H)
    srv.daemon_threads = True
    print(f"Dispatch 网页版：{url(conf, ip)}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
