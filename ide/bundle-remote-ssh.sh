#!/bin/bash
# Open Remote - SSH (github.com/jeanp413/open-remote-ssh, MIT, the one VSCodium ships) as a built-in
# extension of Dispatch IDE: Microsoft's Remote-SSH only runs in Microsoft's builds. The vsix comes from
# Open VSX at a pinned version and is checked against its sha256 (cached in .cache/vsix).
#
# The server on the other Mac is Dispatch IDE's own (build-server.sh, packed into the app at the app's
# commit): dispatch-bridge puts it in ~/.dispatch-ide-server/bin/<commit>/ before a window opens, so the
# extension finds it there and downloads nothing. Its defaults say so: the product's server name, the
# app's own version, no download source (VSCodium's servers are other versions and do not work).
# usage: bundle-remote-ssh.sh <app>/Contents/Resources/app
set -euo pipefail
cd "$(dirname "$0")"
RES="$1"
VERSION=0.3.1
SHA256=c6f16b225ab86925f2bd9e8cc5ba31e614978ccfa120f1509bdf6e99e5bef13f
URL="https://open-vsx.org/api/jeanp413/open-remote-ssh/$VERSION/file/jeanp413.open-remote-ssh-$VERSION.vsix"
CACHE="$PWD/.cache/vsix"
VSIX="$CACHE/jeanp413.open-remote-ssh-$VERSION.vsix"
mkdir -p "$CACHE"
if [ ! -s "$VSIX" ] || [ "$(shasum -a 256 "$VSIX" | cut -d' ' -f1)" != "$SHA256" ]; then
  curl -fsSL -o "$VSIX.part" "$URL"
  got="$(shasum -a 256 "$VSIX.part" | cut -d' ' -f1)"
  [ "$got" = "$SHA256" ] || { echo "open-remote-ssh $VERSION: sha256 $got, expected $SHA256" >&2; rm -f "$VSIX.part"; exit 1; }
  mv "$VSIX.part" "$VSIX"
fi
DEST="$RES/extensions/open-remote-ssh"
TMP="$(mktemp -d)"
unzip -q "$VSIX" 'extension/*' -d "$TMP"
rm -rf "$DEST" && mv "$TMP/extension" "$DEST" && rm -rf "$TMP"
python3 - "$DEST/package.json" <<'EOF'
import json, sys
p = sys.argv[1]
pkg = json.load(open(p, encoding="utf-8"))
props = pkg["contributes"]["configuration"]["properties"]
props["remote.SSH.serverVersion"]["default"] = "match"
props["remote.SSH.serverValidation"]["default"] = "strict"
props["remote.SSH.serverBinaryName"]["default"] = ""
json.dump(pkg, open(p, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
EOF
echo "open-remote-ssh $VERSION: $DEST"
