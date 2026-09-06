#!/bin/bash
# Dispatch web/phone version as a LaunchAgent: `dispatch serve` on this Mac, bound to the
# Tailscale address (see cli/serve.py). Usage: bash serve-setup.sh   (run on the Mac itself)
# Prints the URL with the token to open once on the phone; then "Add to Home Screen".
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PY="$(command -v python3)"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$HOME/Library/LaunchAgents/dev.schaefer.dispatch-serve.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.schaefer.dispatch-serve</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$REPO/cli/serve.py</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin</string>
    <key>BEADS_DIR</key><string>$HOME/tasks/.beads</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/tmp/dispatch-serve.log</string>
  <key>StandardErrorPath</key><string>/tmp/dispatch-serve.log</string>
</dict></plist>
PL
U=$(id -u); launchctl bootout gui/$U/dev.schaefer.dispatch-serve 2>/dev/null || true
pkill -f "cli/serve.py" 2>/dev/null || true
launchctl bootstrap gui/$U "$HOME/Library/LaunchAgents/dev.schaefer.dispatch-serve.plist"
sleep 2
BEADS_DIR="$HOME/tasks/.beads" "$PY" "$REPO/cli/serve.py" url
