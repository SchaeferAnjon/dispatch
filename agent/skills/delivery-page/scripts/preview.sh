#!/bin/bash
# A quick look at a delivery page the way people see it: the right panel (420) and a whole window
# (800 / 1200 / 1600), light and dark. Headless Chrome, nothing opens on screen.
#   preview.sh <folder or index.html> [out folder, default <folder>/.preview]
set -euo pipefail
page="${1:?preview.sh <folder or index.html> [out]}"
[ -d "$page" ] && page="$page/index.html"
[ -f "$page" ] || { echo "no page: $page" >&2; exit 1; }
page="$(cd "$(dirname "$page")" && pwd)/$(basename "$page")"
out="${2:-$(dirname "$page")/.preview}"
mkdir -p "$out"
prof=$(mktemp -d)
trap 'rm -rf "$prof"' EXIT
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$chrome" ] || { echo "needs Google Chrome at $chrome" >&2; exit 1; }
for w in 420 800 1200 1600; do
  for theme in light dark; do
    png="$out/$w-$theme.png"
    "$chrome" --headless=new --disable-gpu --virtual-time-budget=5000 --hide-scrollbars --window-size="$w,2400" \
      --use-mock-keychain --password-store=basic --user-data-dir="$prof" --no-first-run \
      --screenshot="$png" "file://$page#theme=$theme" >/dev/null 2>&1
    [ -f "$png" ] && echo "$png"
  done
done
