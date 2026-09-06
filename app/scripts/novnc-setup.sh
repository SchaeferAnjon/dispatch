#!/bin/bash
# Web remote desktop for a Mac over Tailscale: macOS Screen Sharing (VNC :5900) fronted by
# websockify + noVNC on loopback, HTTPS via Tailscale Serve, kept alive by a LaunchAgent.
# Usage: bash novnc-setup.sh [legacy-tailscale-ip] (run from a checkout on the Mac itself).
# Safari needs HTTPS for macOS ARD authentication's Web Crypto calls.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TS="$(python3 "$HERE/../cli/remote_screen.py" --cli)"
D="$HOME/tasks/.dispatch"; mkdir -p "$D"
# Refuse to replace another service's root route. Use a separate HTTPS port if needed.
PORT="${DISPATCH_SCREEN_PORT:-443}"
"$TS" serve status --json | python3 -c '
import json, sys
c=json.load(sys.stdin); p=sys.argv[1]
for authority, web in c.get("Web", {}).items():
    if authority.endswith(":"+p):
        root=web.get("Handlers", {}).get("/", {})
        if root and not root.get("Proxy", "").endswith(":6080"):
            sys.exit("这个 HTTPS 端口已被其他服务使用；设置 DISPATCH_SCREEN_PORT=8443 后重试。")
' "$PORT"
[ -d "$D/novnc/.git" ] || git clone -q --depth 1 https://github.com/novnc/noVNC "$D/novnc"
[ -x "$D/venv/bin/websockify" ] || { python3 -m venv "$D/venv" && "$D/venv/bin/pip" -q install websockify; }
"$D/venv/bin/websockify" --help >/dev/null 2>&1 && echo "websockify ok"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$HOME/Library/LaunchAgents/dev.schaefer.novnc.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.schaefer.novnc</string>
  <key>ProgramArguments</key><array>
    <string>$D/venv/bin/websockify</string>
    <string>--web</string><string>$D/novnc</string>
    <string>127.0.0.1:6080</string>
    <string>127.0.0.1:5900</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>/tmp/novnc.log</string>
  <key>StandardErrorPath</key><string>/tmp/novnc.log</string>
</dict></plist>
PL
U=$(id -u); launchctl bootout gui/$U/dev.schaefer.novnc 2>/dev/null || true
# bootout returns before launchd finishes releasing the old service registration.
STARTED=0
for ATTEMPT in 1 2 3 4 5; do
  if launchctl bootstrap gui/$U "$HOME/Library/LaunchAgents/dev.schaefer.novnc.plist" 2>"$D/novnc-bootstrap.log"; then STARTED=1; break; fi
  sleep 1
done
[ "$STARTED" = 1 ] || { command cat "$D/novnc-bootstrap.log"; exit 1; }
sleep 2
curl --fail --silent --show-error --max-time 10 --output /dev/null "http://127.0.0.1:6080/vnc.html"
# The command prints an account setup link when HTTPS is not enabled on the tailnet.
# Serve stays private to the tailnet; do not use Funnel for screen sharing.
"$TS" serve --bg --https="$PORT" http://127.0.0.1:6080
URL="$(python3 "$HERE/../cli/remote_screen.py")"
[ -n "$URL" ] || { echo "HTTPS 尚未配置成功。"; exit 1; }
curl --fail --silent --show-error --max-time 60 --output /dev/null "$URL"
echo "手机看屏幕：$URL"
