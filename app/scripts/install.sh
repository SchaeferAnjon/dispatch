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

# Code signing: the identity is NOT in the repository (anyone must be able to build from source).
# Tauri reads APPLE_SIGNING_IDENTITY; set it in the environment, or put the identity's name on one
# line in ~/.config/dispatch/signing-identity. With neither, the build is ad-hoc signed ("-"),
# which runs fine but makes macOS ask for the privacy grants again after every rebuild.
if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  if [ -s "$HOME/.config/dispatch/signing-identity" ]; then
    APPLE_SIGNING_IDENTITY="$(head -1 "$HOME/.config/dispatch/signing-identity")"
  else
    APPLE_SIGNING_IDENTITY="-"
  fi
fi
export APPLE_SIGNING_IDENTITY
if [ "$BUILD" = 1 ]; then
  npm run tauri build
fi
[ -d "$SRC" ] || { echo "构建产物不存在：$SRC"; exit 1; }

osascript -e 'quit app "Dispatch"' >/dev/null 2>&1 || true
sleep 1
# rsync keeps the bundle identity stable so the Dock icon and permissions survive.
rsync -a --delete "$SRC/" "$DST/"
# Privacy grants (Automation, Accessibility, notifications) are keyed to the code signature: a
# signed bundle keeps them across rebuilds, an ad-hoc one asks again every time. The identity
# comes from APPLE_SIGNING_IDENTITY or ~/.config/dispatch/signing-identity; say so if this build is ad-hoc.
if codesign -dv "$DST" 2>&1 | grep -q 'Signature=adhoc'; then
  echo "注意：这次是 ad-hoc 签名，系统会再次要权限。要固定签名：把证书名写进 ~/.config/dispatch/signing-identity（一行），或设 APPLE_SIGNING_IDENTITY。"
fi
echo "已更新 ${DST} ($(date '+%H:%M:%S'))"
# The phone's web UI (launchd daemon) serves from this bundle; restart it so it picks up the new files.
python3 - "$DST/Contents/Resources/cli" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from updater import restart_serve
if restart_serve():
    print("已重启网页版（dispatch serve）")
PY

if [ "$LAUNCH" = 1 ]; then
  open "$DST"
fi
