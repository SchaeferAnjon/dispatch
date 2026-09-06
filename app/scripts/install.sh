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
echo "已更新 ${DST} ($(date '+%H:%M:%S'))"

if [ "$LAUNCH" = 1 ]; then
  open "$DST"
fi
