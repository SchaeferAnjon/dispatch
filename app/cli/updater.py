"""In-app update from GitHub Releases (`dispatch update check|apply`).

The repo is private for now, so the API needs a token: `gh auth token` if the gh CLI is
logged in, else GITHUB_TOKEN from `dispatch env`. Once the repo is public neither is needed.
`apply` downloads the zip for this CPU, unpacks it next to the app, swaps it into
/Applications with rsync (bundle identity stays, so permissions survive), clears the
quarantine flag and relaunches.
"""
import json, os, platform, re, shutil, subprocess, sys, tempfile, time, urllib.request

REPO = "SchaeferAnjon/dispatch"
HERE = os.path.dirname(os.path.abspath(__file__))
APP = "/Applications/Dispatch.app"
RELEASES_URL = f"https://github.com/{REPO}/releases"


def current_version():
    try:
        return open(os.path.join(HERE, "VERSION")).read().strip()
    except FileNotFoundError:
        return "dev"


def token():
    for cmd in (["gh", "auth", "token"], ["/opt/homebrew/bin/gh", "auth", "token"]):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            pass
    try:
        sys.path.insert(0, HERE)
        import dispatch as D
        return next((i["value"] for i in D.env_read() if i["name"] == "GITHUB_TOKEN"), "")
    except Exception:
        return ""


def api(url, tok, accept="application/vnd.github+json"):
    req = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "dispatch-updater", **({"Authorization": f"Bearer {tok}"} if tok else {})})
    return urllib.request.urlopen(req, timeout=30)


def vtuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3]) or (0,)


def check():
    tok = token()
    cur = current_version()
    try:
        with api(f"https://api.github.com/repos/{REPO}/releases/latest", tok) as r:
            rel = json.load(r)
    except Exception as e:
        return {"current": cur, "latest": "", "error": f"读不到发布信息：{e}" + ("" if tok else "（仓库是私有的，需要 gh 登录或在 dispatch env 里放 GITHUB_TOKEN）"), "url": RELEASES_URL, "needs_token": not tok}
    latest = (rel.get("tag_name") or "").lstrip("v")
    arch = "apple-silicon" if platform.machine() == "arm64" else "intel"
    asset = next((a for a in rel.get("assets", []) if a["name"].endswith(".zip") and arch in a["name"]), None) or next((a for a in rel.get("assets", []) if a["name"].endswith(".zip")), None)
    return {"current": cur, "latest": latest, "newer": vtuple(latest) > vtuple(cur) if cur != "dev" else True, "url": rel.get("html_url") or RELEASES_URL,
            "asset": asset and {"name": asset["name"], "url": asset["url"], "size": asset["size"]}, "notes": (rel.get("body") or "")[:2000], "published_at": rel.get("published_at", "")}


def apply(relaunch=True):
    info = check()
    if info.get("error"):
        raise RuntimeError(info["error"])
    if not info.get("asset"):
        raise RuntimeError("这个版本没有可下载的安装包")
    tok = token()
    tmp = tempfile.mkdtemp(prefix="dispatch-update-")
    zip_path = os.path.join(tmp, info["asset"]["name"])
    with api(info["asset"]["url"], tok, accept="application/octet-stream") as r, open(zip_path, "wb") as f:
        shutil.copyfileobj(r, f)
    subprocess.run(["ditto", "-x", "-k", zip_path, tmp], check=True)
    new_app = os.path.join(tmp, "Dispatch.app")
    if not os.path.isdir(new_app):
        raise RuntimeError("安装包里没有 Dispatch.app")
    subprocess.run(["xattr", "-dr", "com.apple.quarantine", new_app], capture_output=True)
    subprocess.run(["rsync", "-a", "--delete", new_app + "/", APP + "/"], check=True)
    shutil.rmtree(tmp, ignore_errors=True)
    restart_serve()
    if relaunch:
        # Quit the running app and start the new one from a detached shell, after this process has answered.
        subprocess.Popen(["/bin/sh", "-c", f"sleep 1; osascript -e 'quit app \"Dispatch\"' >/dev/null 2>&1; sleep 1.5; open '{APP}'"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return {"updated_to": info["latest"], "from": info["current"], "relaunching": relaunch}


SERVE_LABEL = "dev.schaefer.dispatch-serve"


def restart_serve():
    """The phone's web UI is a launchd daemon reading this bundle; after an update it must
    restart to serve the new files. Silent when the daemon is not installed."""
    uid = os.getuid()
    r = subprocess.run(["launchctl", "print", f"gui/{uid}/{SERVE_LABEL}"], capture_output=True)
    if r.returncode != 0:
        return False
    subprocess.run(["launchctl", "kickstart", "-k", f"gui/{uid}/{SERVE_LABEL}"], capture_output=True)
    return True


def main(a):
    try:
        res = check() if a.op in (None, "check") else apply(relaunch=not getattr(a, "no_relaunch", False))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False) if a.json else f"✗ {e}")
        sys.exit(1)
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    elif "updated_to" in res:
        print(f"已更新到 v{res['updated_to']}（原 v{res['from']}）" + ("，正在重启应用" if res["relaunching"] else ""))
    elif res.get("error"):
        print(f"✗ {res['error']}\n发布页：{res['url']}")
    else:
        print(f"当前 v{res['current']}，最新 v{res['latest']}" + ("，可以更新：dispatch update apply" if res.get("newer") else "，已是最新") + f"\n{res['url']}")
