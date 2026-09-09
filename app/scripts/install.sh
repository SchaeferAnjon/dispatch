#!/bin/bash
# Build Dispatch and sync it into /Applications, then relaunch it.
# Usage: scripts/install.sh [--no-build] [--no-launch]
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"

BUILD=1; LAUNCH=1
for a in "$@"; do
  case "$a" in
    --no-build) BUILD=0 ;;
    --no-launch) LAUNCH=0 ;;
  esac
done

SRC="src-tauri/target/release/bundle/macos/Dispatch.app"
DST="/Applications/Dispatch.app"

if [ "$BUILD" = 1 ]; then
  npm run tauri build
fi
[ -d "$SRC" ] || { echo "构建产物不存在：$SRC"; exit 1; }

osascript -e 'quit app "Dispatch"' >/dev/null 2>&1 || true
sleep 1
# rsync keeps the bundle identity stable so the Dock icon and permissions survive.
rsync -a --delete "$SRC/" "$DST/"
# Privacy grants (Automation, Accessibility, notifications) are keyed to the code signature: a
# signed bundle keeps them across rebuilds, an ad-hoc one asks again every time. The identity is
# set in tauri.conf.json (bundle.macOS.signingIdentity); say so if the build fell back to ad-hoc.
if codesign -dv "$DST" 2>&1 | grep -q 'Signature=adhoc'; then
  echo "注意：这次是 ad-hoc 签名，系统会再次要权限。检查钥匙串里的开发者证书是否可用。"
fi
echo "已更新 ${DST} ($(date '+%H:%M:%S'))"
# The phone's web UI (launchd daemon) serves from this bundle; restart it so it picks up the new files.
if launchctl print "gui/$(id -u)/dev.schaefer.dispatch-serve" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/dev.schaefer.dispatch-serve" && echo "已重启网页版（dispatch serve）"
fi

if [ "$LAUNCH" = 1 ]; then
  open "$DST"
fi
