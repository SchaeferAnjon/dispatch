#!/bin/bash
# Put the built app into /Applications as "Dispatch IDE.app" (Spotlight, Dock, Launchpad find it there)
# and open it. Refuses while the installed copy is running: replacing the files under a running
# instance leaves its windows with a stale text table (every label off by a few entries) until
# it is restarted. Quit it (⌘Q) and run again.
# Usage: ./install.sh [--no-open]; DISPATCH_IDE_SRC=<app> installs that build (kanban's dispatch-update passes
# the signed one fetched from the mini); DISPATCH_IDE_DEST=<folder>/Dispatch IDE.app installs elsewhere (a dry
# run: no keychain change).
set -euo pipefail
cd "$(dirname "$0")"
SRC="${DISPATCH_IDE_SRC:-VSCode-darwin-arm64/Dispatch IDE.app}"  # or a build fetched from the mini (staging/<name>/)
DST="${DISPATCH_IDE_DEST:-/Applications/Dispatch IDE.app}"
[ -d "$SRC" ] || { echo "no build at $SRC; run ./build.sh first" >&2; exit 1; }
if pgrep -f "$DST/Contents/MacOS/Dispatch IDE" >/dev/null; then
  echo "Dispatch IDE is running from $DST; quit it (⌘Q) first" >&2
  exit 2
fi
# The keychain key "Dispatch IDE Safe Storage" trusts the signature of the app that made it. When the
# new build is signed by someone else (ad-hoc, or the first build with a fixed identity), drop the key
# so the next launch makes a fresh one instead of asking for the login password. With the same fixed
# identity as before (update-bridge.sh) the key stays.
requirement() { codesign -d -r- "$1" 2>/dev/null | sed -n 's/^designated => //p'; }
if [ -d "$DST" ] && [ -z "${DISPATCH_IDE_DEST:-}" ]; then
  old="$(requirement "$DST")"; new="$(requirement "$SRC")"
  if [ -z "$new" ] || [ "$old" != "$new" ] || codesign -dv "$SRC" 2>&1 | grep -q 'Signature=adhoc'; then
    security delete-generic-password -s "Dispatch IDE Safe Storage" >/dev/null 2>&1 || true
    echo "signature changed: dropped the \"Dispatch IDE Safe Storage\" key (a new one is made on launch)"
  fi
fi
rm -rf "$DST.new"
ditto "$SRC" "$DST.new"
rm -rf "$DST"
mv "$DST.new" "$DST"
echo "installed: $DST"
# only the installed copy in LaunchServices: the build it came from (staging/…) is forgotten, so the Dock and
# Spotlight open this one (launchservices.sh; dispatch-update also unregisters every other copy)
if [ -z "${DISPATCH_IDE_DEST:-}" ]; then
  bash launchservices.sh forget "$SRC"
  bash launchservices.sh register "$DST"
fi
[ "${1:-}" = "--no-open" ] || open -a "$DST"
