#!/bin/bash
# The full package: Dispatch IDE.app for this Mac (arm64) from the source in ide/vscode (VS Code 1.139.1 with
# Dispatch's changes, kept in this repository): package, drop Copilot and the other colour themes, add Dispatch's
# parts (parts.sh: theme, Codex's agent SDK, What's new, bd / Dolt / tools, Open Remote - SSH, dispatch-bridge and the CLI),
# the remote server, ad-hoc sign. Output: ide/VSCode-darwin-arm64/Dispatch IDE.app. MIN=1 for the minified build.
# For trying a change, the development build (dev.sh build) is ready in seconds; this one takes minutes.
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
V="$HERE/vscode"
[ -f "$V/product.json" ] || { echo "no VS Code source in $V" >&2; exit 1; }

# dispatch-shell.css styles VS Code's own classes: each one must still exist in the source, or the override
# silently does nothing after VS Code's code moved. Fail here instead.
missing=""
for cls in $(grep -v '^\s*/\?\*' "$V/src/vs/sessions/browser/media/dispatch-shell.css" | grep -oE '\.[a-zA-Z][a-zA-Z0-9_-]+' | sort -u | sed 's/^\.//'); do
  grep -rqF --include='*.ts' --include='*.css' --exclude=dispatch-shell.css -- "$cls" "$V/src/vs" || missing="$missing $cls"
done
[ -z "$missing" ] || { echo "dispatch-shell.css: classes no longer in src/vs:$missing" >&2; exit 1; }

NODE="$(cat "$V/.nvmrc")"
[ "$(node -v 2>/dev/null)" = "v$NODE" ] || command -v fnm >/dev/null || { echo "Dispatch IDE builds with Node $NODE (ide/vscode/.nvmrc): put that node first on PATH, or install fnm (brew install fnm && fnm install $NODE)" >&2; exit 1; }
run() { if [ "$(node -v 2>/dev/null)" = "v$NODE" ]; then (cd "$V" && "$@"); else (cd "$V" && fnm exec --using "$NODE" "$@"); fi; }
./dev.sh deps
# product.json's commit is our own build id: the update feed is keyed by it (…/dispatch/<commit>, release.sh), so
# every build gets its own. 40 hex, or gulp ignores it.
export BUILD_SOURCEVERSION="${BUILD_SOURCEVERSION:-$( { git rev-parse HEAD; git diff --no-ext-diff HEAD -- .; date +%s; } | shasum | cut -d' ' -f1)}"
echo "build id: $BUILD_SOURCEVERSION"
# with BUILD_SOURCEVERSION set the copilot extension's build counts as CI and wants VSCODE_QUALITY; copilot is
# dropped below, and to the rest of the build (builtInExtensions) "stable" means what unset did
export VSCODE_QUALITY="${VSCODE_QUALITY:-stable}"
run npm run gulp "vscode-darwin-arm64${MIN:+-min}"
APP="VSCode-darwin-arm64/Dispatch IDE.app"
RES="$APP/Contents/Resources/app"
rm -rf "$RES/extensions/copilot"
# one theme only (2026-09-27): drop Code's other colour themes; theme-defaults stays (Code falls back to it and the
# high-contrast themes live there), theme-seti is the file icon theme
for d in abyss kimbie-dark monokai monokai-dimmed quietlight red solarized-dark solarized-light tomorrow-night-blue; do
  rm -rf "$RES/extensions/theme-$d"
done
# another update feed for this build (a local test server): DISPATCH_UPDATE_URL
if [ -n "${DISPATCH_UPDATE_URL:-}" ]; then
  python3 -c 'import json, sys; p = sys.argv[1]; d = json.load(open(p)); d["updateUrl"] = sys.argv[2]; json.dump(d, open(p, "w"), indent="\t", ensure_ascii=False); open(p, "a").write("\n")' "$RES/product.json" "$DISPATCH_UPDATE_URL"
  echo "update feed: $DISPATCH_UPDATE_URL"
fi

./parts.sh "$RES"
# our own remote server (REH) at the app's commit, for windows on another Mac
./build-server.sh "$RES"
# product.json's checksums after the parts went in, then sign
./update-bridge.sh --sign-only
echo "built: $PWD/$APP"
