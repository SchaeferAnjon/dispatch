#!/bin/bash
# Dispatch IDE's side of `dispatch-update`: regenerate Dispatch Light / Dark from styles.css, then
# rebuild the bridge into Dispatch IDE (the dispatch-ide repo's update-bridge.sh; without that repo
# just the .vsix), only when what goes into it changed since the last rebuild:
#   app/ide-ext/** (not node_modules, out, dist, media/chat), app/src/idechat/**,
#   app/scripts/gen-ide-theme.mjs, and styles.css's token section (the top of the file up to the
#   first rule that is not :root / @media, i.e. the blocks gen-ide-theme.mjs reads).
# The hash of those after the last rebuild is in ~/tasks/.dispatch/ide-bridge.hash.
#   DISPATCH_SKIP_IDE=1   skip all of it        DISPATCH_FORCE_IDE=1   rebuild even when nothing changed
#   --print-hash          print the current hash and exit (no generation, no rebuild)
set -euo pipefail
cd "$(dirname "$0")/.."

inputs_hash() {
  {
    find ide-ext src/idechat -type f \
      -not -path 'ide-ext/node_modules/*' -not -path 'ide-ext/out/*' -not -path 'ide-ext/dist/*' -not -path 'ide-ext/media/chat/*' \
      -not -name '.DS_Store' -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256
    shasum -a 256 scripts/gen-ide-theme.mjs
    # the token section: stop at the first top-level rule whose selector is not :root or @media
    awk '/^[A-Za-z.#*\[]/ { exit } { print }' src/styles.css | shasum -a 256 | sed 's/-$/styles.css tokens/'
  } | shasum -a 256 | cut -d' ' -f1
}

if [ "${1:-}" = "--print-hash" ]; then inputs_hash; exit 0; fi
if [ "${DISPATCH_SKIP_IDE:-}" = 1 ]; then echo "Dispatch IDE：DISPATCH_SKIP_IDE=1，跳过主题和 bridge"; exit 0; fi

node scripts/gen-ide-theme.mjs >/dev/null
STAMP="${DISPATCH_DIR:-$HOME/tasks/.dispatch}/ide-bridge.hash"
NOW="$(inputs_hash)"
if [ "${DISPATCH_FORCE_IDE:-}" != 1 ] && [ -s "$STAMP" ] && [ "$(cat "$STAMP")" = "$NOW" ]; then
  echo "Dispatch IDE：bridge 和主题自上次重打没变，不重打（DISPATCH_FORCE_IDE=1 强制）"
  exit 0
fi
IDE_DIR="$(cd .. && pwd)/ide"
if [ -x "$IDE_DIR/update-bridge.sh" ] && [ -d "$IDE_DIR/VSCode-darwin-arm64" ]; then
  "$IDE_DIR/update-bridge.sh"
else
  npm run -s build:ext
fi
mkdir -p "$(dirname "$STAMP")"
printf '%s\n' "$NOW" > "$STAMP"
