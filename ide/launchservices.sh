#!/bin/bash
# Keep one Dispatch IDE.app in LaunchServices: the installed one. Every build copy (ide/staging/*, ~/dispatch-builds/*,
# backups) carries the same bundle id, and the Dock, Spotlight and Finder may open any registered copy: on 10-09 a
# fresh install of 0.9.2 opened a backup from 10-01. Unregistering leaves the files alone; a copy still starts by its
# path (test instances do).
#   ./launchservices.sh forget <app>…   unregister these copies
#   ./launchservices.sh register <app>  register this one (the installed copy)
#   ./launchservices.sh tidy [<keep>]    unregister every other registered copy with <keep>'s bundle id (default
#                                        /Applications/Dispatch IDE.app), then register <keep>. Reads the whole
#                                        LaunchServices database: about a minute.
# DISPATCH_LSREGISTER replaces lsregister (the tests).
set -euo pipefail
LS="${DISPATCH_LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}"
[ -x "$LS" ] || { echo "launchservices: no lsregister at $LS, nothing to do"; exit 0; }

forget() { # <app>: a copy that is not registered (or gone) is fine as it is
  "$LS" -u "$1" >/dev/null 2>&1 || true
}

case "${1:-}" in
  forget)
    shift
    for app in "$@"; do forget "$app"; echo "launchservices: forgot $app"; done
    ;;
  register)
    "$LS" -f "${2:?register needs an app}"
    echo "launchservices: registered $2"
    ;;
  tidy)
    keep="${2:-/Applications/Dispatch IDE.app}"
    [ -d "$keep" ] || { echo "launchservices: no $keep to keep" >&2; exit 1; }
    id="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$keep/Contents/Info.plist")"
    n=0
    # one record per bundle: its "path:" line comes before its "identifier:" line; the path ends with " (0x…)"
    while IFS= read -r app; do
      [ "$app" = "$keep" ] && continue
      forget "$app"; n=$((n + 1))
    done < <("$LS" -dump 2>/dev/null | awk -v id="$id" '
      /^-----/ { p = "" }
      /^path:/ { sub(/^path:[ \t]+/, ""); sub(/ \(0x[0-9a-f]+\)$/, ""); p = $0 }
      /^identifier:/ { v = $0; sub(/^identifier:[ \t]+/, "", v); if (v == id && p != "") { print p; p = "" } }' | sort -u)
    "$LS" -f "$keep"
    echo "launchservices: $n other copies of $id unregistered, $keep registered"
    ;;
  *)
    echo "usage: $0 forget <app>… | register <app> | tidy [<keep>]" >&2; exit 2 ;;
esac
