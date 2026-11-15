#!/bin/bash
# OpenCode's plugin kit inside the app (Resources/app/tools/opencode-plugin-kit.tgz), so a new Mac's first chat with
# OpenCode does not wait for npm (kanban task-lj06.13). OpenCode installs the npm package @opencode-ai/plugin into
# each config folder it reads before it answers when any plugin is loaded (Dispatch's own included): about five
# minutes when npm cannot be reached. The dispatch CLI unpacks this copy into those folders first
# (kanban app/cli/opencode_kit.py: first-run setup, an OpenCode install, and the Agents window before it starts
# OpenCode), and OpenCode then finds it installed.
#
# Pinned in opencode-kit/: package.json is what OpenCode itself writes there, package-lock.json pins every package
# with its integrity hash (npm ci checks them). Without the optional packages: they are native code (msgpackr-extract),
# which would need signing inside the app, and msgpackr works without them. Cached in .cache/opencode-kit by the
# lock's hash. To move to a newer OpenCode: change the version in opencode-kit/package.json and run
# `npm install --package-lock-only --ignore-scripts` there.
# build.sh runs it after bundle-bin.sh; alone: ./bundle-opencode-kit.sh "<App>/Contents/Resources/app"
set -euo pipefail
cd "$(dirname "$0")"
RES="${1:?usage: bundle-opencode-kit.sh <App>/Contents/Resources/app}"
KEY="$(cat opencode-kit/package.json opencode-kit/package-lock.json | shasum | cut -c1-12)"
C="$PWD/.cache/opencode-kit/$KEY"
KIT="$C/opencode-plugin-kit.tgz"

npm_() {
  if command -v fnm >/dev/null && [ -f vscode/.nvmrc ]; then fnm exec --using "$(cat vscode/.nvmrc)" npm "$@"; else npm "$@"; fi
}

if [ ! -s "$KIT" ]; then
  W="$C.tmp"
  rm -rf "$W" && mkdir -p "$W"
  cp opencode-kit/package.json opencode-kit/package-lock.json "$W/"
  ci() { (cd "$W" && rm -rf node_modules && npm_ ci --omit=optional --ignore-scripts --no-audit --no-fund --loglevel=error "$@"); }
  # npm's own registry, else the npmmirror copy (the same packages; the lock's hashes are checked either way)
  ci || ci --registry https://registry.npmmirror.com
  if find "$W/node_modules" -type f \( -name '*.node' -o -name '*.dylib' \) | grep -q .; then
    echo "opencode-kit: native code in the kit, which the app's signature would not cover:" >&2
    find "$W/node_modules" -type f \( -name '*.node' -o -name '*.dylib' \) >&2
    exit 1
  fi
  (cd "$W" && COPYFILE_DISABLE=1 tar -czf opencode-plugin-kit.tgz package.json package-lock.json node_modules)
  mkdir -p "$C"
  mv "$W/opencode-plugin-kit.tgz" "$KIT"
  rm -rf "$W"
fi

mkdir -p "$RES/tools/licenses"
install -m 644 "$KIT" "$RES/tools/opencode-plugin-kit.tgz"
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["dependencies"]["@opencode-ai/plugin"])' opencode-kit/package.json)"
cat >> "$RES/tools/licenses/README" <<EOF
opencode-plugin-kit.tgz: @opencode-ai/plugin $VERSION (https://github.com/anomalyco/opencode, MIT) and its dependencies
from npm (MIT, ISC, Apache-2.0, BSD-3-Clause; each package's licence is in its folder under node_modules).
Unmodified, as OpenCode installs them.
EOF
echo "tools: opencode plugin kit $VERSION ($(du -h "$KIT" | cut -f1 | tr -d ' '))"
