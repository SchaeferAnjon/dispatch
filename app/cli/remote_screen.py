"""Discover noVNC's HTTPS endpoint from the local Tailscale Serve configuration."""
import json
import shutil
import subprocess
from urllib.parse import urlsplit


def tailscale_cli():
    # Homebrew's daemon may be in use even when the GUI app is also installed.
    candidates = [shutil.which("tailscale"), "/opt/homebrew/bin/tailscale",
                  "/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
    for path in dict.fromkeys(p for p in candidates if p):
        try:
            result = subprocess.run([path, "serve", "status", "--json"], capture_output=True, text=True, timeout=4)
            if result.returncode == 0:
                return path, json.loads(result.stdout)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            continue
    return "", {}


def endpoint_from_config(config, local_ip=""):
    """Only root proxies to this Mac's noVNC qualify; unrelated Serve routes don't."""
    for authority, web in config.get("Web", {}).items():
        try:
            endpoint = urlsplit("https://" + authority)
            if not endpoint.hostname or not endpoint.hostname.endswith(".ts.net"):
                continue
            port = endpoint.port or 443
            if not config.get("TCP", {}).get(str(port), {}).get("HTTPS"):
                continue
            proxy = urlsplit(web.get("Handlers", {}).get("/", {}).get("Proxy", ""))
            if (proxy.scheme == "http" and proxy.hostname in {"127.0.0.1", "localhost", local_ip}
                    and proxy.port == 6080 and proxy.path in ("", "/")):
                origin = "https://" + endpoint.hostname + (f":{port}" if port != 443 else "")
                return origin + "/vnc.html?autoconnect=1&resize=scale&show_dot=1"
        except (ValueError, TypeError, AttributeError):
            continue
    return ""


def secure_screen_url(local_ip=""):
    _, config = tailscale_cli()
    return endpoint_from_config(config, local_ip)


if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["--cli"]:
        cli, _ = tailscale_cli()
        if not cli:
            raise SystemExit("没有找到已连接的 Tailscale，请先登录 Tailscale。")
        print(cli)
    else:
        print(secure_screen_url())
