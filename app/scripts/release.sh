#!/bin/bash
# Zip a Dispatch IDE that the build service built, signed and notarized, with the dispatch CLI, and publish a
# GitHub release. It never builds the app itself (ide/build.sh is not run by hand): first
#   dispatch build start main --on local, dispatch build sign <name>
# Usage: scripts/release.sh 0.8.0 --build <name> [--notes <file>]   (run from anywhere; needs `gh auth login` once)
#   --notes   the release notes, written by hand (default: release-notes/v<version>.md at the repository root);
#             nothing is taken from commit subjects. Missing: no release.
# DISPATCH_RELEASE_REPO   owner/name of the repository the release goes to (the public one, e.g.
#             SchaeferAnjon/dispatch). No default yet: it has to be set. Its main must already hold this commit's
#             snapshot (app/scripts/public-sync.sh, "sync: 同步到 <commit>"); the tag v<version> is made there.
# Assets: Dispatch-IDE-<v>-macos-<arch>.dmg and .zip (the app), dispatch-cli-<v>.tar.gz (the CLI, its skill and
# the phone's web page, listed in cli/bundle.json), SHA256SUMS.
# The IDE's update feed (ide/release.sh) is rewritten in docs/updates/ to point at the release's zip; commit it,
# public-sync and push afterwards, and the public repository's Pages (updateUrl in ide/vscode/product.json) serve it.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"
V="${1:?版本号，如 0.8.0}"; shift || true
NAME=""
HANDNOTES="$(cd .. && pwd)/release-notes/v${V}.md"
while [ $# -gt 0 ]; do
  case "$1" in
    --build) NAME="${2:-}"; shift 2 ;;
    --notes) HANDNOTES="${2:-}"; shift 2 ;;
    *) echo "不认识的参数：$1（用法：release.sh <版本> --build <构建名> [--notes <说明文件>]）" >&2; exit 2 ;;
  esac
done
[ -n "$NAME" ] || { echo "要给构建名：release.sh $V --build <名>（dispatch build list 里的，先 build sign）" >&2; exit 2; }
[ -s "$HANDNOTES" ] || { echo "没有手写的发布说明：${HANDNOTES}（写好再发，或用 --notes 指定文件；不再从提交标题生成）" >&2; exit 2; }
RELEASE_REPO="${DISPATCH_RELEASE_REPO:-}"
[ -n "$RELEASE_REPO" ] || { echo "没设 DISPATCH_RELEASE_REPO：要发到哪个仓库（owner/name，公开仓库），先设好再发" >&2; exit 2; }
# The public repository's main must be this commit's snapshot: the release's tag is made there, never pushed from here
HEAD_SHA="$(git rev-parse HEAD)"
PUBLIC_MSG="$(gh api "repos/$RELEASE_REPO/commits/main" -q .commit.message)"
[[ "$PUBLIC_MSG" == "sync: 同步到 $HEAD_SHA"* ]] || { echo "$RELEASE_REPO 的 main 不是这个提交的快照（它是：$(head -1 <<<"$PUBLIC_MSG")）：先 app/scripts/public-sync.sh 同步并推上去" >&2; exit 1; }
ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] && ARCH_LABEL="apple-silicon" || ARCH_LABEL="intel"
# Where this build's app lives: staging for a build copied from the mini, ~/dispatch-builds for one built here.
APP="$(cd cli && python3 -c 'import sys, os, builds; h, n = builds.find(sys.argv[1], ""); print(os.path.join(builds.local_copy(h, n), builds.APP_NAME))' "$NAME")"
[ -d "$APP" ] || { echo "构建产物不存在：${APP}（先 dispatch build get ${NAME}）" >&2; exit 1; }
# Every CLI module must be in the package list (a forgotten one only fails on users' Macs).
(cd cli && python3 -m unittest -q test_bundle >/dev/null 2>&1) || { echo "cli/test_bundle 没过：有 CLI 模块没写进 cli/bundle.json，不发布" >&2; exit 1; }
# Version lives in three files; they must already say $V (set on the branch the build came from). The IDE's
# product.json carries it for the About dialog.
python3 - "$V" <<'PY'
import json, sys
v = sys.argv[1]
have = (json.load(open("package.json"))["version"], open("cli/VERSION").read().strip(), json.load(open("../ide/vscode/product.json")).get("dispatchVersion"))
if have != (v, v, v):
    sys.exit(f"版本号不一致：package.json {have[0]}，cli/VERSION {have[1]}，ide/vscode/product.json dispatchVersion {have[2]}，要发的是 {v}")
PY
# The app must be the one this checkout's code went into.
BUILT_KANBAN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("kanban",""))' "$(dirname "$APP")/info.json")"
git merge-base --is-ancestor "$BUILT_KANBAN" HEAD || { echo "构建 $NAME 用的 kanban 提交 ${BUILT_KANBAN:0:12} 不在当前分支的历史里，不发布" >&2; exit 1; }
if ! git diff --quiet "$BUILT_KANBAN" HEAD -- ide-ext scripts/gen-ide-theme.mjs; then
  echo "注意：构建之后 ide-ext 或主题又改过，App 里没有这些改动：" >&2
  git diff --stat "$BUILT_KANBAN" HEAD -- ide-ext scripts/gen-ide-theme.mjs >&2
fi
# Developer ID signature and notarization come from `dispatch build sign` (it skips an app that is already
# signed, notarized and stapled). A downloaded copy then opens without the Gatekeeper warning.
python3 cli/dispatch.py build sign "$NAME" >/dev/null
xcrun stapler validate "$APP" >/dev/null || { echo "$APP 没有公证票据，不发布" >&2; exit 1; }
# Capture first: with pipefail, grep -q exiting early would SIGPIPE codesign and fail the pipeline.
SIG="$(codesign -dv --verbose=2 "${APP}" 2>&1 || true)"
grep -q '^Authority=Developer ID Application' <<<"$SIG" || { echo "${APP} 不是 Developer ID 签名，不发布" >&2; exit 1; }
npm run -s build >/dev/null
OUTDIR="$(mktemp -d)"
OUT="$OUTDIR/Dispatch-IDE-${V}-macos-${ARCH_LABEL}.zip"
CLI="$OUTDIR/dispatch-cli-${V}.tar.gz"
# ditto keeps the bundle's resource forks and symlinks; Finder can unzip it.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT"
# The DMG most people expect: open it, drag the app onto Applications. Signed, notarized and stapled
# like the app, so it opens without the Gatekeeper warning.
DMG="$OUTDIR/Dispatch-IDE-${V}-macos-${ARCH_LABEL}.dmg"
DMGSRC="$OUTDIR/dmg-src"; mkdir -p "$DMGSRC"
ditto "$APP" "$DMGSRC/$(basename "$APP")"
ln -s /Applications "$DMGSRC/Applications"
hdiutil create -volname "Dispatch IDE ${V}" -srcfolder "$DMGSRC" -ov -format UDZO -imagekey zlib-level=9 "$DMG" -quiet
rm -rf "$DMGSRC"
IDENT="$(sed -n 's/^Authority=\(Developer ID Application: .*\)$/\1/p' <<<"$SIG" | head -1)"
codesign --sign "$IDENT" --timestamp "$DMG"
# Capture first: with pipefail, grep -q exiting early would SIGPIPE notarytool and fail the pipeline.
NOTARY="$(xcrun notarytool submit "$DMG" --keychain-profile dispatch-notary --wait 2>&1 || true)"
grep -q 'status: Accepted' <<<"$NOTARY" \
  || { echo "DMG 公证没通过，不发布（多半是屏幕锁着、钥匙串锁了）：" >&2; echo "$NOTARY" | tail -5 >&2; exit 1; }
xcrun stapler staple "$DMG" >/dev/null
python3 - "$CLI" <<'PY'
import json, os, sys, tarfile
conf = json.load(open("cli/bundle.json"))
with tarfile.open(sys.argv[1], "w:gz") as t:
    for f in conf["files"]:
        t.add(f, arcname="dispatch/" + f)
    for src, dst in conf["dirs"].items():
        # a folder of Python (cli/engines/) may hold bytecode the tests wrote: never pack it
        t.add(src, arcname="dispatch/" + dst.rstrip("/"),
              filter=lambda ti: None if "__pycache__" in ti.name.split("/") or ti.name.endswith(".pyc") else ti)
PY
NOTES="$OUTDIR/notes.md"
cat > "$NOTES" <<MD
## 安装（macOS · ${ARCH_LABEL}）

1. 下载 \`Dispatch-IDE-${V}-macos-${ARCH_LABEL}.dmg\`，双击打开，把 **Dispatch IDE.app** 拖到旁边的「应用程序」上。也可以下载同名 .zip，双击解压后拖进「应用程序」。
2. 这个包已经过 Apple 公证，第一次打开时 macOS 只会问一次「是否打开从互联网下载的 App」。
3. 终端命令 \`dispatch\`：下载 \`dispatch-cli-${V}.tar.gz\`，解压到 \`~/.dispatch-cli\`，再 \`ln -sf ~/.dispatch-cli/dispatch/cli/dispatch.py ~/.local/bin/dispatch\`。手机回复和派活要常驻的 chatd：\`dispatch chatd install\`。

需要 macOS 14+ 和 Homebrew。

MD
cat "$HANDNOTES" >> "$NOTES"
# the private tag marks which commit went out; the public one is made by gh on the public repository's main
git tag -f "v${V}"
# the update feed: builds released before now point at this release's zip (docs/updates/, served by Pages)
ZIP="$OUT" UPDATE_DIR="$(cd .. && pwd)/docs/updates" DOWNLOAD_BASE="https://github.com/$RELEASE_REPO/releases/download/v${V}" bash ../ide/release.sh "$APP" | sed -n 1,2p
( cd "$OUTDIR" && shasum -a 256 "$(basename "$DMG")" "$(basename "$OUT")" "$(basename "$CLI")" > SHA256SUMS )
gh release create "v${V}" "$DMG" "$OUT" "$CLI" "$OUTDIR/SHA256SUMS" -R "$RELEASE_REPO" --target main --title "Dispatch v${V}" --notes-file "$NOTES" --latest
rm -rf "$OUTDIR"
echo "已发布 v${V}：$(gh release view "v${V}" -R "$RELEASE_REPO" --json url -q .url)"
echo "更新通道：提交 docs/updates/，再 app/scripts/public-sync.sh 同步并推到 $RELEASE_REPO，Pages 就指向这个 Release"
