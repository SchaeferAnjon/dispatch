#!/bin/bash
# bd (Dispatch's task board, MIT) and Dolt (its database, Apache-2.0) inside the app, so a new Mac needs
# neither Homebrew nor a separate install: pinned arm64 release binaries, checked against the sha256s
# below, cached in .cache/bin-tools, put in Resources/app/tools with their licences. dispatch-bridge gives
# the dispatch CLI that folder as DISPATCH_IDE_BIN and the CLI looks there first. Not Resources/app/bin:
# that is VS Code's own `code` script, which must not shadow the real `code` on the CLI's PATH.
# build.sh runs it; alone: ./bundle-bin.sh "<App>/Contents/Resources/app"
set -euo pipefail
cd "$(dirname "$0")"
RES="${1:?usage: bundle-bin.sh <App>/Contents/Resources/app}"
CACHE="$PWD/.cache/bin-tools"

# the versions this board runs on (bd 1.2.2 on Dolt 2.3.1); bump both lines together with their sha256
BD_VERSION=1.2.2
BD_SHA256=2aa1245c666419900d2d6993a05049e92c40e0e601d19579cca5b07a7bb8021d
DOLT_VERSION=2.3.1
DOLT_SHA256=d738b9f523289e9c51dbe0e9f2623c8e032924c62fa72a443703020adf099d27

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
fetch() { # url sha256 file
  local url=$1 sum=$2 out=$3
  if [ -s "$out" ] && [ "$(sha "$out")" = "$sum" ]; then return; fi
  curl -fsSL -o "$out.part" "$url"
  if [ "$(sha "$out.part")" != "$sum" ]; then
    echo "sha256 mismatch for $url: got $(sha "$out.part"), want $sum" >&2
    exit 1
  fi
  mv "$out.part" "$out"
}

mkdir -p "$CACHE"
BD_TGZ="$CACHE/beads_${BD_VERSION}_darwin_arm64.tar.gz"
DOLT_TGZ="$CACHE/dolt-${DOLT_VERSION}-darwin-arm64.tar.gz"
fetch "https://github.com/gastownhall/beads/releases/download/v$BD_VERSION/beads_${BD_VERSION}_darwin_arm64.tar.gz" "$BD_SHA256" "$BD_TGZ"
fetch "https://github.com/dolthub/dolt/releases/download/v$DOLT_VERSION/dolt-darwin-arm64.tar.gz" "$DOLT_SHA256" "$DOLT_TGZ"

BIN="$RES/tools"
rm -rf "$BIN"
mkdir -p "$BIN/licenses"
tmp="$(mktemp -d "$CACHE/unpack.XXXXXX")"
tar xzf "$BD_TGZ" -C "$tmp" ./bd ./LICENSE
tar xzf "$DOLT_TGZ" -C "$tmp" dolt-darwin-arm64/bin/dolt dolt-darwin-arm64/LICENSES
install -m 755 "$tmp/bd" "$BIN/bd"
install -m 755 "$tmp/dolt-darwin-arm64/bin/dolt" "$BIN/dolt"
cp "$tmp/LICENSE" "$BIN/licenses/bd-LICENSE"
cp "$tmp/dolt-darwin-arm64/LICENSES" "$BIN/licenses/dolt-LICENSES"
rm -rf "$tmp"
cat > "$BIN/licenses/README" <<EOF
bd $BD_VERSION (https://github.com/gastownhall/beads, MIT, bd-LICENSE)
dolt $DOLT_VERSION (https://github.com/dolthub/dolt, Apache-2.0, dolt-LICENSES)
Unmodified release binaries for darwin-arm64.
EOF
echo "tools: bd $("$BIN/bd" version 2>/dev/null | head -1), dolt $DOLT_VERSION"
