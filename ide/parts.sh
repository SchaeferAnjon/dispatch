#!/bin/bash
# Dispatch's own parts next to VS Code's, in an app root: the app's Contents/Resources/app (build.sh, the full
# package) or ide/vscode itself (dev.sh, the development build, which runs from the source tree).
#
#   ./parts.sh <app root> [--dev] [part …]
#
# Parts (all by default, in this order):
#   theme       暖石, Dispatch Light / Dark (from app/ide-ext/themes), the only theme: extensions/theme-dispatch
#   sdks        Codex's agent SDK the agent host would download (product.json agentSdks), checked against its
#               sha256: agent-sdks/. The Claude Agent SDK is not bundled; the agent host downloads it on first use
#   whats-new   this build's What's new pages (ide/whats-new): whats-new/
#   tools       bd and Dolt (bundle-bin.sh), OpenCode's plugin kit (bundle-opencode-kit.sh), the computer-use
#               helper (app/computer): tools/
#   remote-ssh  Open Remote - SSH as a built-in extension (bundle-remote-ssh.sh): extensions/open-remote-ssh
#   bridge      dispatch-bridge (app/ide-ext, built here) as a built-in extension, and the dispatch CLI the app
#               carries (app/cli/bundle.json): extensions/dispatch-bridge, dispatch-cli/
#
# --dev: a part whose sources have not changed since it was last put there is skipped (a stamp per part in
# <root>/.build/dispatch-parts), so a development build only redoes what changed.
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
REPO="$(cd .. && pwd)"  # the checkout this script is in: its app/ and agent/ go into the app
ROOT="${1:?usage: parts.sh <app root> [--dev] [part …]}"
shift
DEV=""
if [ "${1:-}" = "--dev" ]; then DEV=1; shift; fi
PARTS=("$@")
[ ${#PARTS[@]} -gt 0 ] || PARTS=(theme sdks whats-new tools remote-ssh bridge)
CACHE="$HERE/.cache"
STAMPS="$ROOT/.build/dispatch-parts"

# What a part is made from, as one hash: the files git knows under those paths (as committed, plus what is changed
# or new in the working tree), so the same sources give the same hash in any checkout.
sources() {
  local rel=() p
  for p in "$@"; do rel+=("${p#"$REPO"/}"); done
  {
    git -C "$REPO" ls-files -s -- "${rel[@]}"
    git -C "$REPO" diff --no-ext-diff HEAD -- "${rel[@]}"
    git -C "$REPO" ls-files -z --others --exclude-standard -- "${rel[@]}" | (cd "$REPO" && xargs -0 shasum 2>/dev/null) || true
  } | shasum | cut -d' ' -f1
}
# fresh <part> <sources…>: true (skip) in a --dev run when the part's stamp matches its sources now
fresh() {
  local part="$1"; shift
  [ -n "$DEV" ] || return 1
  local want; want="$(sources "$@" "$HERE/parts.sh")"
  [ "$(cat "$STAMPS/$part" 2>/dev/null)" = "$want" ] && { echo "parts: $part unchanged"; return 0; }
  echo "$want" >"$STAMPS/$part.want"
  return 1
}
done_part() { [ -z "$DEV" ] || mv -f "$STAMPS/$1.want" "$STAMPS/$1"; }
[ -z "$DEV" ] || mkdir -p "$STAMPS"

theme() {
  fresh theme "$REPO/app/ide-ext/themes/dispatch-light.json" "$REPO/app/ide-ext/themes/dispatch-dark.json" && return
  local t="$ROOT/extensions/theme-dispatch"
  rm -rf "$t" && mkdir -p "$t/themes"
  cp "$REPO/app/ide-ext/themes/dispatch-light.json" "$REPO/app/ide-ext/themes/dispatch-dark.json" "$t/themes/"
  cat >"$t/package.json" <<'EOF'
{
  "name": "theme-dispatch",
  "displayName": "Dispatch Themes",
  "description": "暖石: Dispatch Light and Dispatch Dark, the stone palette of Dispatch's DESIGN.md",
  "publisher": "dispatch",
  "version": "1.0.0",
  "license": "GPL-3.0-or-later",
  "engines": { "vscode": "*" },
  "categories": ["Themes"],
  "contributes": {
    "themes": [
      { "id": "Dispatch Light", "label": "Dispatch Light", "uiTheme": "vs", "path": "./themes/dispatch-light.json" },
      { "id": "Dispatch Dark", "label": "Dispatch Dark", "uiTheme": "vs-dark", "path": "./themes/dispatch-dark.json" }
    ]
  }
}
EOF
  done_part theme
}

# The agent SDKs Dispatch may redistribute inside the app, where agentSdkDownloader.ts looks first: Codex
# (Apache-2.0) works offline from the first launch. The Claude Agent SDK is under Anthropic's own terms, so it is
# not bundled: the agent host downloads it from product.json's URL the first time it is used. Each bundled
# tarball is pinned by id, version and sha256 (the darwin-arm64 tarball at product.json's urlTemplate); a new
# version in product.json fails here until its sha256 is added. Cached in .cache.
SDK_PINS="codex 0.153.0 5a656e113e28c10c0fe9504b3a6a582306b9476010afa4f246a4eeb40c81f0a5"
sdks() {
  fresh sdks "$HERE/vscode/product.json" && return
  mkdir -p "$CACHE/agent-sdks"
  rm -rf "$ROOT/agent-sdks"   # a development tree may still hold an SDK an older build bundled
  python3 - "$ROOT/product.json" <<'EOF' | while read -r id version url; do
import json, sys
for k, v in json.load(open(sys.argv[1]))["agentSdks"].items():
    print(k, v["version"], v["urlTemplate"].replace("{sdkTarget}", "darwin-arm64"))
EOF
    if [ "$id" = claude ]; then echo "agent sdk: $id $version not bundled (downloaded on first use)"; continue; fi
    local want
    want="$(awk -v id="$id" -v v="$version" '{ for (i = 1; i + 2 <= NF; i += 3) if ($i == id && $(i + 1) == v) print $(i + 2) }' <<<"$SDK_PINS")"
    [ -n "$want" ] || { echo "parts.sh: no sha256 pinned for the $id SDK $version (SDK_PINS); add it or leave it out" >&2; exit 1; }
    local tgz="$CACHE/agent-sdks/$id-$version-darwin-arm64.tgz"
    if [ ! -s "$tgz" ]; then curl -fsSL --max-time 900 -o "$tgz.part" "$url" && mv "$tgz.part" "$tgz"; fi
    local got
    got="$(shasum -a 256 "$tgz" | cut -d' ' -f1)"
    if [ "$got" != "$want" ]; then
      rm -f "$tgz"
      echo "parts.sh: sha256 mismatch for $url: got $got, want $want" >&2; exit 1
    fi
    local dest="$ROOT/agent-sdks/$id/$version/darwin-arm64"
    rm -rf "$dest" && mkdir -p "$dest"
    tar xzf "$tgz" -C "$dest"
    touch "$dest/.complete"
    echo "agent sdk: $id $version"
  done
  done_part sdks
}

# What's new (src/vs/sessions/contrib/dispatchWhatsNew): this build's new features, their pictures and marks
whats_new() {
  fresh whats-new "$HERE/whats-new" && return
  rm -rf "$ROOT/whats-new"
  [ -f whats-new/whats-new.json ] && cp -R whats-new "$ROOT/whats-new"
  done_part whats-new
}

tools() {
  local cu="$REPO/app/computer/DispatchComputer.swift"
  fresh tools "$HERE/bundle-bin.sh" "$HERE/bundle-opencode-kit.sh" "$HERE/opencode-kit" "$cu" && return
  ./bundle-bin.sh "$ROOT"
  # OpenCode's plugin kit next to them, so its first start does not wait for npm
  ./bundle-opencode-kit.sh "$ROOT"
  # the computer-use helper (`dispatch computer`, app/computer), so a new Mac needs no compiler; the CLI
  # compiles it from source only when this one is missing
  if [ -f "$cu" ]; then
    xcrun swiftc -O -swift-version 5 -o "$ROOT/tools/dispatch-computer" "$cu"
    echo "tools: dispatch-computer"
  fi
  done_part tools
}

remote_ssh() {
  fresh remote-ssh "$HERE/bundle-remote-ssh.sh" && return
  ./bundle-remote-ssh.sh "$ROOT"
  done_part remote-ssh
}

# dispatch-bridge as a built-in extension, and the dispatch CLI inside the app (Resources/app/dispatch-cli/dispatch/…,
# the same files as release.sh's dispatch-cli tarball, listed in app/cli/bundle.json), so a new Mac needs no
# separate download: the bridge runs it when no dispatch is installed; the first-run wizard links
# ~/.local/bin/dispatch to it.
bridge() {
  fresh bridge "$REPO/app/ide-ext" "$REPO/app/src" "$REPO/app/cli" "$REPO/app/termd" "$REPO/agent" \
    "$REPO/app/package.json" "$REPO/app/package-lock.json" "$REPO/app/vite.idechat.config.ts" "$REPO/app/vite.knowledge.config.ts" && return
  local lock_sum stamp="$REPO/app/node_modules/.dispatch-lock-sha"
  lock_sum="$(shasum "$REPO/app/package-lock.json" | cut -d' ' -f1)"
  if [ "$(cat "$stamp" 2>/dev/null)" != "$lock_sum" ]; then
    echo "app: npm ci"
    (cd "$REPO/app" && npm ci --no-audit --no-fund) && echo "$lock_sum" >"$stamp"
  fi
  (cd "$REPO/app" && npm run -s build:ext >/dev/null)
  local ext="$ROOT/extensions/dispatch-bridge"
  rm -rf "$ext" && mkdir -p "$ext"
  local f
  for f in package.json package.nls.json package.nls.de.json package.nls.zh-cn.json README.md out media l10n themes; do
    [ -e "$REPO/app/ide-ext/$f" ] && cp -R "$REPO/app/ide-ext/$f" "$ext/"
  done
  # the themes ship as their own built-in extension (theme above); the bridge keeps themes/ide-defaults.json but
  # does not register the themes a second time
  python3 -c 'import json, sys; p = json.load(open(sys.argv[1])); p.get("contributes", {}).pop("themes", None); json.dump(p, open(sys.argv[1], "w"), indent=2, ensure_ascii=False)' "$ext/package.json"
  local cli="$ROOT/dispatch-cli"
  rm -rf "$cli"
  python3 - "$REPO/app" "$cli/dispatch" <<'PY'
import json, os, shutil, sys
src, dst = sys.argv[1], sys.argv[2]
conf = json.load(open(os.path.join(src, "cli", "bundle.json")))
for f in conf["files"]:
    os.makedirs(os.path.dirname(os.path.join(dst, f)), exist_ok=True)
    shutil.copy2(os.path.join(src, f), os.path.join(dst, f))
for s, d in conf["dirs"].items():
    if os.path.isdir(os.path.join(src, s)):
        shutil.copytree(os.path.join(src, s), os.path.join(dst, d), dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"))
PY
  echo "bridge: dispatch-bridge and the dispatch CLI"
  done_part bridge
}

for p in "${PARTS[@]}"; do
  case "$p" in
    theme) theme ;;
    sdks) sdks ;;
    whats-new) whats_new ;;
    tools) tools ;;
    remote-ssh) remote_ssh ;;
    bridge) bridge ;;
    *) echo "parts.sh: no part $p" >&2; exit 2 ;;
  esac
done
