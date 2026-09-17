"""In-app update from GitHub Releases (`dispatch update check|apply`).

`check` asks the GitHub API for the latest release; when that is unavailable (the anonymous API
allows 60 calls an hour per address) it follows the public `releases/latest` redirect instead,
which has no such limit. `apply` downloads the zip built for this CPU, checks it against the
release's SHA256SUMS, unpacks it, swaps it into the installed bundle with rsync (bundle identity
stays, so permissions survive), clears the quarantine flag and relaunches.
"""
import hashlib, json, os, platform, plistlib, re, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.request

REPO = "SchaeferAnjon/dispatch"
HERE = os.path.dirname(os.path.abspath(__file__))


def installed_app():
    """The bundle this CLI runs from (…/Dispatch.app/Contents/Resources/cli), wherever the person
    put it (/Applications, ~/Applications…). From a source checkout: the usual /Applications copy."""
    m = re.match(r"^(.*?/[^/]+\.app)/Contents/Resources/cli/?$", HERE)
    return m.group(1) if m else "/Applications/Dispatch.app"


APP = installed_app()
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


def latest_without_api():
    """The latest release without the rate-limited API: github.com/<repo>/releases/latest redirects
    to …/tag/vX.Y.Z, and assets have predictable download URLs. No release notes this way."""
    try:
        req = urllib.request.Request(f"{RELEASES_URL}/latest", headers={"User-Agent": "dispatch-updater"})
        with urllib.request.urlopen(req, timeout=20) as r:
            final = r.geturl()
    except Exception:
        return None
    m = re.search(r"/tag/(v?[0-9][^/?#]*)$", final)
    if not m:
        return None
    tag = m.group(1)
    ver = tag.lstrip("v")
    assets = []
    for arch in ("apple-silicon", "intel"):
        name = f"Dispatch-{ver}-macos-{arch}.zip"
        url = f"{RELEASES_URL}/download/{tag}/{name}"
        try:
            req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "dispatch-updater"})
            with urllib.request.urlopen(req, timeout=20) as r:
                assets.append({"name": name, "url": url, "size": int(r.headers.get("Content-Length") or 0), "browser_download_url": url})
        except Exception:
            continue
    return {"tag_name": tag, "html_url": final, "assets": assets, "body": ""}


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def expected_sha256(tag, name):
    """The checksum the release published for `name` (a SHA256SUMS asset), or '' when the release
    has none (releases before checksums were introduced)."""
    try:
        req = urllib.request.Request(f"{RELEASES_URL}/download/{tag}/SHA256SUMS", headers={"User-Agent": "dispatch-updater"})
        with urllib.request.urlopen(req, timeout=20) as r:
            text = r.read().decode("utf-8", "replace")
    except Exception:
        return ""
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[-1].lstrip("*") == name:
            return parts[0].lower()
    return ""


def vtuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3]) or (0,)


def check():
    tok = token()
    cur = current_version()
    try:
        with api(f"https://api.github.com/repos/{REPO}/releases/latest", tok) as r:
            rel = json.load(r)
    except Exception as e:
        rel = latest_without_api()
        if rel is None:
            return {"current": cur, "latest": "", "error": f"GitHub 暂时读不到发布信息（{e}）：可能是网络不通或接口限流，稍后再试，或直接去发布页下载", "url": RELEASES_URL, "needs_token": False}
    latest = (rel.get("tag_name") or "").lstrip("v")
    arch = "apple-silicon" if platform.machine() == "arm64" else "intel"
    # Only a package built for this machine: an arm64 zip on an Intel Mac would not even launch.
    asset = next((a for a in rel.get("assets", []) if a["name"].endswith(".zip") and arch in a["name"]), None)
    if asset is None and any(a["name"].endswith(".zip") for a in rel.get("assets", [])):
        return {"current": cur, "latest": latest, "newer": False, "url": rel.get("html_url") or RELEASES_URL, "asset": None,
                "error": f"v{latest} 没有 {arch} 的包（目前只发布 Apple 芯片版）；Intel 机器请从源码构建：cd app && npm ci && npm run tauri build",
                "notes": (rel.get("body") or "")[:2000], "published_at": rel.get("published_at", "")}
    return {"current": cur, "latest": latest, "newer": vtuple(latest) > vtuple(cur) if cur != "dev" else True, "url": rel.get("html_url") or RELEASES_URL,
            "asset": asset and {"name": asset["name"], "url": asset["url"], "size": asset["size"], "download": asset.get("browser_download_url") or asset["url"]}, "tag": rel.get("tag_name") or "", "notes": (rel.get("body") or "")[:2000], "published_at": rel.get("published_at", "")}


def apply(relaunch=True):
    info = check()
    if info.get("error"):
        raise RuntimeError(info["error"])
    if not info.get("asset"):
        raise RuntimeError("这个版本没有可下载的安装包")
    tok = token()
    tmp = tempfile.mkdtemp(prefix="dispatch-update-")
    zip_path = os.path.join(tmp, info["asset"]["name"])
    try:
        with api(info["asset"]["url"], tok, accept="application/octet-stream") as r, open(zip_path, "wb") as f:
            shutil.copyfileobj(r, f)
    except urllib.error.HTTPError:
        # The API asset URL is rate-limited like the rest of the API; the public download URL is not.
        with api(info["asset"].get("download") or info["asset"]["url"], "", accept="application/octet-stream") as r, open(zip_path, "wb") as f:
            shutil.copyfileobj(r, f)
    want = expected_sha256(info.get("tag") or ("v" + info["latest"]), info["asset"]["name"])
    if want and sha256_of(zip_path) != want:
        shutil.rmtree(tmp, ignore_errors=True)
        raise RuntimeError("下载的安装包校验和不对（和发布页的 SHA256SUMS 不一致），没有安装。重试一次；还不对就去发布页手动下载。")
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


sys.path.insert(0, HERE)
import launchd_labels  # noqa: E402
SERVE_LABEL = launchd_labels.label("dispatch-serve")


def restart_serve():
    """Keep an installed phone service on the same build as the desktop app.
    Early setup scripts pinned a source checkout; kickstart alone leaves that code running.
    Silent when the daemon is not installed."""
    uid = os.getuid()
    label = f"gui/{uid}/{SERVE_LABEL}"
    r = subprocess.run(["launchctl", "print", label], capture_output=True)
    if r.returncode != 0:
        return False
    path = os.path.realpath(os.path.expanduser(f"~/Library/LaunchAgents/{SERVE_LABEL}.plist"))
    bundled = os.path.join(APP, 'Contents', 'Resources', 'cli', 'serve.py')
    if os.path.isfile(path) and os.path.isfile(bundled):
        with open(path, 'rb') as f:
            config = plistlib.load(f)
        args = config.get('ProgramArguments') or [sys.executable]
        env = config.get('EnvironmentVariables') or {}
        # Older installs logged to a world-readable /tmp file; the log now lives with Dispatch's data.
        log = os.path.join(os.path.expanduser('~'), 'tasks', '.dispatch', 'serve.log')
        stale_log = str(config.get('StandardOutPath') or '').startswith('/tmp/')
        if args[1:] != [bundled] or 'DISPATCH_DIST' in env or stale_log or env.get('PYTHONDONTWRITEBYTECODE') != '1':
            config['ProgramArguments'] = [args[0], bundled]
            env.pop('DISPATCH_DIST', None)
            env['PYTHONDONTWRITEBYTECODE'] = '1'  # a __pycache__ inside the .app breaks its code signature
            config['EnvironmentVariables'] = env
            if stale_log:
                os.makedirs(os.path.dirname(log), exist_ok=True)
                os.close(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600))
                config['StandardOutPath'] = config['StandardErrorPath'] = log
            # Preserve the rest of the job (user, board, logs), then reload its definition.
            with tempfile.NamedTemporaryFile(dir=os.path.dirname(path), delete=False) as f:
                tmp = f.name
                plistlib.dump(config, f)
            try:
                os.chmod(tmp, 0o600)
                os.replace(tmp, path)
            finally:
                if os.path.exists(tmp): os.unlink(tmp)
            # The app is already replaced at this point: a launchctl hiccup must not turn a
            # finished update into a reported failure (the daemon restarts at next login anyway).
            subprocess.run(['launchctl', 'bootout', label], capture_output=True)
            subprocess.run(['launchctl', 'bootstrap', f'gui/{uid}', path], capture_output=True)
            return True
    subprocess.run(["launchctl", "kickstart", "-k", label], capture_output=True)
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
