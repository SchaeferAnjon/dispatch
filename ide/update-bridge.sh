#!/bin/bash
# Put a freshly built dispatch-bridge and dispatch CLI into the packaged app without packaging VS Code again (a
# minute instead of several), then its checksums and signature.
#   ./update-bridge.sh [app]        default VSCode-darwin-arm64/Dispatch IDE.app
#   ./update-bridge.sh --sign-only  only checksums and signature (build.sh, after parts.sh put everything in)
set -euo pipefail
cd "$(dirname "$0")"
SIGN_ONLY=""
if [ "${1:-}" = "--sign-only" ]; then SIGN_ONLY=1; shift; fi
APP="${1:-VSCode-darwin-arm64/Dispatch IDE.app}"
[ -d "$APP" ] || { echo "no app at $APP" >&2; exit 1; }
[ -n "$SIGN_ONLY" ] || ./parts.sh "$APP/Contents/Resources/app" bridge
python3 checksums.py "$APP"
# Developer ID when the keychain has one (hardened runtime), else ad-hoc. A local build is not notarized unless
# DISPATCH_NOTARIZE=1: Apple's queue can take long; `dispatch build sign` and release.sh notarize what they install
# or publish.
DISPATCH_NOTARIZE="${DISPATCH_NOTARIZE:-0}" ./sign.sh "$APP"
echo "bridge updated in $APP"
