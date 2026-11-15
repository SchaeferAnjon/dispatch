#!/bin/bash
# Dispatch IDE's own remote server (REH) for macOS arm64, built from the same checkout as the app and
# stamped with the app's commit, so a window connected over Open Remote - SSH talks to a server of exactly
# its own version (VSCodium's servers are other versions: their extension host exits with 55, version
# mismatch). dispatch-bridge goes in as a built-in extension of the server too, so it runs on the other
# Mac and calls that Mac's dispatch. The result is packed into the app:
#   Resources/app/server/<serverApplicationName>-darwin-arm64.tar.gz
# dispatch-bridge puts it on the other Mac (~/<serverDataFolderName>/bin/<commit>/) before a machine's
# window opens, where Open Remote - SSH finds it and skips its own download.
# usage: build-server.sh <app>/Contents/Resources/app   (run by build.sh after the app is built and parts.sh ran)
set -euo pipefail
cd "$(dirname "$0")"
RES="$1"
PRODUCT="$RES/product.json"
read -r COMMIT APPNAME < <(python3 -c 'import json, sys; p = json.load(open(sys.argv[1])); print(p["commit"], p["serverApplicationName"])' "$PRODUCT")
NODE="$(cat vscode/.nvmrc)"
[ "$(node -v 2>/dev/null)" = "v$NODE" ] || command -v fnm >/dev/null || { echo "Dispatch IDE builds with Node $NODE (ide/vscode/.nvmrc): put that node first on PATH, or install fnm (brew install fnm && fnm install $NODE)" >&2; exit 1; }
run() { if [ "$(node -v 2>/dev/null)" = "v$NODE" ]; then (cd vscode && "$@"); else (cd vscode && fnm exec --using "$NODE" "$@"); fi; }
# the server's product.json must carry the app's commit: the client refuses a server of another commit
export BUILD_SOURCEVERSION="$COMMIT"
export VSCODE_QUALITY="${VSCODE_QUALITY:-stable}"
run npm run gulp "vscode-reh-darwin-arm64${MIN:+-min}"
SRV="$PWD/vscode-reh-darwin-arm64"
rm -rf "$SRV/extensions/copilot"
got="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["commit"])' "$SRV/product.json")"
[ "$got" = "$COMMIT" ] || { echo "server commit $got, app commit $COMMIT" >&2; exit 1; }
[ -x "$SRV/bin/$APPNAME" ] || { echo "no $SRV/bin/$APPNAME" >&2; exit 1; }
# dispatch-bridge on the server side: the one parts.sh put into the app (build.sh runs this after it)
[ -d "$RES/extensions/dispatch-bridge" ] || { echo "no dispatch-bridge in $RES (parts.sh first)" >&2; exit 1; }
rm -rf "$SRV/extensions/dispatch-bridge"
cp -R "$RES/extensions/dispatch-bridge" "$SRV/extensions/"
mkdir -p "$RES/server"
TAR="$RES/server/$APPNAME-darwin-arm64.tar.gz"
tar -czf "$TAR" -C "$PWD" "vscode-reh-darwin-arm64"
echo "server: $TAR ($(du -h "$TAR" | cut -f1), commit $COMMIT)"
