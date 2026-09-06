#!/bin/bash
# Web remote desktop for a Mac over Tailscale: macOS Screen Sharing (VNC :5900) fronted by
# websockify + noVNC, bound to the Tailscale IP only, kept alive by a LaunchAgent.
# Usage: bash novnc-setup.sh <tailscale-ip>     (run on the Mac itself, or: ssh host bash -s <ip> < novnc-setup.sh)
# Then open http://<ip>:6080/vnc.html from any device on the tailnet; log in with the Mac user password.
set -e
IP="$1"; D="$HOME/tasks/.dispatch"; mkdir -p "$D"
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
    <string>$IP:6080</string>
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
launchctl bootstrap gui/$U "$HOME/Library/LaunchAgents/dev.schaefer.novnc.plist"
sleep 2; curl -s -o /dev/null -w "novnc http %{http_code} on $IP:6080\n" "http://$IP:6080/vnc.html"
