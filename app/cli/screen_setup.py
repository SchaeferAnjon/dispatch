"""One-click phone screen sharing (`dispatch screen`).

novnc-setup.sh used to be a shell script people ran by hand on the Mac whose screen
the phone should show. The steps are the same; the app drives them now:

  tailscale  Tailscale installed and logged in — Serve publishes the HTTPS URL
  novnc      a shallow noVNC checkout under ~/tasks/.dispatch/novnc
  websockify a venv with websockify under ~/tasks/.dispatch/venv
  launchd    dev.schaefer.novnc keeps websockify on 127.0.0.1:6080 alive
  serve      `tailscale serve --https=<port>` fronts it over HTTPS on the tailnet
  screen     macOS Screen Sharing (VNC :5900) — the one switch only the user can flip

`dispatch screen status --json` is what the settings page renders; `dispatch screen
setup --json` runs the steps and reports what it did plus the one manual step left.
Everything is idempotent, so pressing 配置 again after fixing something by hand works.

HTTPS matters: Safari needs Web Crypto for macOS ARD authentication, and the old
http://<ip>:6080 page cannot log in. Serve stays private to the tailnet; never Funnel.
"""
import json
import os
import plistlib
import shutil
import subprocess
import sys
import time

import dispatch as D
from remote_screen import endpoint_from_config, tailscale_cli

LABEL = "dev.schaefer.novnc"
NOVNC_REPO = "https://github.com/novnc/noVNC"
LAUNCH_DIR = os.path.join(D.HOME, "Library", "LaunchAgents")
PLIST = os.path.join(LAUNCH_DIR, f"{LABEL}.plist")
VENV = os.path.join(D.DISPATCH_DIR, "venv")
WEBSOCKIFY = os.path.join(VENV, "bin", "websockify")
NOVNC_DIR = os.path.join(D.DISPATCH_DIR, "novnc")
LOCAL_PORT = 6080
VNC_PORT = 5900
LOG = "/tmp/novnc.log"


# ---------------------------------------------------------------- probes

def serve_port():
    """The HTTPS port Serve publishes on. The GUI does not inherit shell exports, so
    `dispatch env set DISPATCH_SCREEN_PORT 8443` (the app's 环境 page) also works."""
    if os.environ.get("DISPATCH_SCREEN_PORT"):
        return os.environ["DISPATCH_SCREEN_PORT"]
    try:
        for item in D.env_read():
            if item["name"] == "DISPATCH_SCREEN_PORT" and item["value"].strip():
                return item["value"].strip()
    except Exception:
        pass
    return "443"


def screen_sharing_on():
    return D.port_open("127.0.0.1", VNC_PORT, 0.5)


def websockify_ready():
    return os.access(WEBSOCKIFY, os.X_OK)


def novnc_ready():
    return os.path.exists(os.path.join(NOVNC_DIR, "vnc.html"))


def launchd_loaded():
    r = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{LABEL}"],
                       capture_output=True, text=True, timeout=5)
    return r.returncode == 0


def local_up():
    return D.port_open("127.0.0.1", LOCAL_PORT, 0.5)


def _run(args, timeout=600):
    e = dict(os.environ)
    e["PATH"] = D.PATH_EXTRA + ":" + e.get("PATH", "")
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=e)
        return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, "", str(e)


def _url(config=None):
    if config is None:
        _, config = tailscale_cli()
    return endpoint_from_config(config, D.tailscale_ip() or D.lan_ip())


def serve_conflict(config, port=None):
    """Another service already owns the root route on this HTTPS port; replacing it would
    break that service, so the caller must pick another port."""
    port = port or serve_port()
    for authority, web in (config or {}).get("Web", {}).items():
        if authority.endswith(":" + port):
            root = web.get("Handlers", {}).get("/", {})
            if root and not root.get("Proxy", "").endswith(f":{LOCAL_PORT}"):
                return True
    return False


def manual_steps(state=None):
    """What the user has to do that Dispatch cannot do for them."""
    state = state or status()
    out = []
    if not state["tailscale"]:
        out.append({"id": "tailscale", "title": "安装并登录 Tailscale",
                    "detail": "手机要和这台 Mac 在同一个 Tailscale 网络里，HTTPS 链接也由它提供。"})
    if not state["screen_sharing"]:
        out.append({"id": "screen_sharing", "title": "打开 macOS 屏幕共享",
                    "detail": "系统设置 → 通用 → 共享 → 屏幕共享，打开开关。这一步要管理员权限，Dispatch 不能替你按。"})
    return out


# ---------------------------------------------------------------- status

def status():
    cli, config = tailscale_cli()
    url = _url(config)
    sharing = screen_sharing_on()
    s = {
        "screen_sharing": sharing,
        "tailscale": bool(cli),
        "novnc": novnc_ready(),
        "websockify": websockify_ready(),
        "launchd": launchd_loaded() if websockify_ready() else False,
        "local_up": local_up(),
        "serve_https": bool(url),
        "url": url,
        "port": serve_port(),
    }
    s["ready"] = bool(url) and s["local_up"] and sharing
    s["issue"] = ("没有找到可用的 Tailscale：装好并登录后再点配置。" if not cli else
                  "这台 Mac 的屏幕共享还没开（系统设置 → 通用 → 共享 → 屏幕共享）。" if not sharing else
                  "Tailscale Serve 的 HTTPS 还没配上，点「配置」。" if not url else
                  "noVNC 服务没在跑，点「配置」。" if not s["local_up"] else "")
    s["steps"] = [
        {"id": "tailscale", "title": "Tailscale", "ok": s["tailscale"], "detail": "已登录，用来提供 HTTPS 链接" if s["tailscale"] else "没找到已登录的 Tailscale"},
        {"id": "novnc", "title": "noVNC 网页客户端", "ok": s["novnc"], "detail": NOVNC_DIR if s["novnc"] else "还没装"},
        {"id": "websockify", "title": "websockify", "ok": s["websockify"], "detail": WEBSOCKIFY if s["websockify"] else "还没装"},
        {"id": "launchd", "title": "常驻服务", "ok": s["launchd"], "detail": f"开机自启（{LABEL}）" if s["launchd"] else "还没注册"},
        {"id": "serve", "title": "Tailscale Serve HTTPS", "ok": s["serve_https"], "detail": s["url"] or f"还没配 HTTPS（端口 {s['port']}）"},
        {"id": "screen_sharing", "title": "macOS 屏幕共享", "ok": s["screen_sharing"], "detail": "已开启（VNC 5900）" if s["screen_sharing"] else "要手动打开"},
    ]
    s["manual"] = manual_steps(s)
    return s


# ---------------------------------------------------------------- setup

def setup(port=None):
    port = port or serve_port()
    steps = []

    def add(id_, title, ok, detail):
        steps.append({"id": id_, "title": title, "ok": bool(ok), "detail": detail})
        return bool(ok)

    def done(ok, extra=None):
        st = status()
        manual = st["manual"] + [m for m in (extra or []) if all(m["id"] != x["id"] for x in st["manual"])]
        return {"ok": bool(ok) and st["ready"], "url": st["url"], "port": st["port"],
                "steps": steps, "manual": manual, "state": st}

    cli, config = tailscale_cli()
    if not add("tailscale", "Tailscale", cli, "已登录" if cli else "没找到已登录的 Tailscale；装好并登录后再点配置。"):
        return done(False)
    if serve_conflict(config, port):
        add("serve", "Tailscale Serve HTTPS", False,
            f"HTTPS 端口 {port} 已被其他服务占用；`dispatch env set DISPATCH_SCREEN_PORT 8443` 后重试。")
        return done(False)

    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    if novnc_ready():
        add("novnc", "noVNC 网页客户端", True, f"已装好（{NOVNC_DIR}）")
    else:
        if os.path.isdir(NOVNC_DIR):
            shutil.rmtree(NOVNC_DIR, ignore_errors=True)  # a half-finished clone would shadow a retry
        rc, _, err = _run(["git", "clone", "-q", "--depth", "1", NOVNC_REPO, NOVNC_DIR], timeout=300)
        if not add("novnc", "noVNC 网页客户端", rc == 0 and novnc_ready(), err or f"下载到 {NOVNC_DIR}"):
            return done(False)

    if websockify_ready():
        add("websockify", "websockify", True, f"已装好（{WEBSOCKIFY}）")
    else:
        if not os.path.exists(os.path.join(VENV, "bin", "python")):
            rc, _, err = _run([sys.executable, "-m", "venv", VENV], timeout=180)
            if not add("websockify", "websockify", rc == 0, err or f"建虚拟环境 {VENV}"):
                return done(False)
        rc, _, err = _run([os.path.join(VENV, "bin", "pip"), "-q", "install", "websockify"], timeout=600)
        if not add("websockify", "websockify", rc == 0 and websockify_ready(), err or f"装到 {VENV}"):
            return done(False)

    try:
        write_plist()
    except OSError as e:
        add("launchd", "常驻服务", False, f"写 {PLIST} 失败：{e}")
        return done(False)
    started = bootstrap()
    for _ in range(10):
        if local_up():
            break
        time.sleep(1)
    if not add("launchd", "常驻服务", local_up(),
               f"websockify 已在 127.0.0.1:{LOCAL_PORT} 常驻，日志 {LOG}" if local_up()
               else f"服务没起来，看 {LOG}；{started}".strip()):
        return done(False)

    rc, out, err = _run([cli, "serve", "--bg", f"--https={port}", f"http://127.0.0.1:{LOCAL_PORT}"], timeout=60)
    # First use on a tailnet prints a one-time link to enable HTTPS in the admin console.
    hint = next((ln.strip() for ln in out.splitlines() if "https://login.tailscale.com" in ln), "")
    url = ""
    for _ in range(3):
        url = _url()
        if url:
            break
        time.sleep(1)
    add("serve", "Tailscale Serve HTTPS", bool(url), url or (hint or err or f"`tailscale serve --https={port}` 没有生效"))
    if not url:
        return done(False, [{"id": "tailscale_https", "title": "在 Tailscale 后台开启 HTTPS",
                             "detail": hint or "Tailscale 管理后台 → DNS → HTTPS Certificates 打开，再点一次「配置」。"}])

    # One last check that the HTTPS page really answers; a wrong proxy would 502 here.
    rc, _, err = _run(["curl", "--fail", "--silent", "--show-error", "--max-time", "30", "--output", "/dev/null", url], timeout=40)
    add("serve_check", "HTTPS 链接可用", rc == 0, url if rc == 0 else (err or "链接打不开"))
    return done(rc == 0)


def write_plist():
    os.makedirs(LAUNCH_DIR, exist_ok=True)
    plist = {
        "Label": LABEL,
        "ProgramArguments": [WEBSOCKIFY, "--web", NOVNC_DIR, f"127.0.0.1:{LOCAL_PORT}", f"127.0.0.1:{VNC_PORT}"],
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 15,
        "StandardOutPath": LOG,
        "StandardErrorPath": LOG,
    }
    with open(PLIST, "wb") as f:
        plistlib.dump(plist, f)


def bootstrap():
    u = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{u}/{LABEL}"], capture_output=True, text=True, timeout=10)
    # bootout returns before launchd finishes releasing the old registration.
    last = ""
    for _ in range(5):
        rc, _, err = _run(["launchctl", "bootstrap", f"gui/{u}", PLIST], timeout=15)
        if rc == 0:
            return ""
        last = err
        time.sleep(1)
    return last


# ---------------------------------------------------------------- cli

def main(a):
    op = getattr(a, "op", "status") or "status"
    r = setup() if op == "setup" else status()
    if getattr(a, "json", False):
        print(json.dumps(r, ensure_ascii=False, indent=2))
        return
    for st in r.get("steps", []):
        print(f"{'✓' if st['ok'] else '✗'} {st['title']}：{st['detail']}")
    if r.get("url"):
        print(f"\n手机看屏幕：{r['url']}")
    for m in r.get("manual", []):
        print(f"还差一步 · {m['title']}：{m['detail']}")
    if not r.get("ok") and not r.get("url"):
        sys.exit(1)
