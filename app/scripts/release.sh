#!/bin/bash
# Build Dispatch, zip the .app and publish a GitHub release.
# Usage: scripts/release.sh 0.6.0 [--no-build]     (run from anywhere; needs `gh auth login` done once)
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
V="${1:?版本号，如 0.6.0}"; shift || true
BUILD=1; for a in "$@"; do [ "$a" = "--no-build" ] && BUILD=0; done
ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] && ARCH_LABEL="apple-silicon" || ARCH_LABEL="intel"
# Version lives in three files; keep them equal.
python3 - "$V" <<'PY'
import json, re, sys
v = sys.argv[1]
for p in ("package.json", "src-tauri/tauri.conf.json"):
    d = json.load(open(p)); d["version"] = v; json.dump(d, open(p, "w"), ensure_ascii=False, indent=2); open(p, "a").write("\n")
s = open("src-tauri/Cargo.toml").read()
open("src-tauri/Cargo.toml", "w").write(re.sub(r'^version = "[^"]+"', f'version = "{v}"', s, count=1, flags=re.M))
PY
[ "$BUILD" = 1 ] && npm run tauri build
APP="src-tauri/target/release/bundle/macos/Dispatch.app"
[ -d "$APP" ] || { echo "构建产物不存在：$APP"; exit 1; }
OUT="src-tauri/target/release/bundle/Dispatch-${V}-macos-${ARCH_LABEL}.zip"
rm -f "$OUT"
# ditto keeps the bundle's resource forks and symlinks; Finder can unzip it.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT"
NOTES="$(mktemp)"
cat > "$NOTES" <<MD
## 安装（macOS · ${ARCH_LABEL}）

1. 下载下面的 \`Dispatch-${V}-macos-${ARCH_LABEL}.zip\`，双击解压，把 **Dispatch.app** 拖进「应用程序」。
2. 这个包没有 Apple 签名，第一次打开会被拦。任选一种：
   - 打开「终端」，粘贴：\`xattr -dr com.apple.quarantine /Applications/Dispatch.app\`，再打开应用；
   - 或者先双击一次被拦，去 系统设置 → 隐私与安全性 → 最下面点「仍要打开」。
3. 打开后会出现**首次设置**：装依赖（Dolt、Beads、Herdr）、建或接入任务板、选 Agent、同步规则与技能。每一步都能重跑，也可以跳过以后再从「设置」里打开。
4. 终端里的 \`dispatch\` 命令由首次设置第 2 步建立；也可以手动：\`ln -sf /Applications/Dispatch.app/Contents/Resources/cli/dispatch.py ~/.local/bin/dispatch\`。

需要：macOS 14+，Homebrew（首次设置会给出安装命令）。两台电脑共用任务板时，第二台在首次设置里选「接入」，填第一台的 \`用户名@地址\`（同一 Wi‑Fi 用局域网 IP，出门用 Tailscale）。

## 变更
$(git log --pretty='- %s' "$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD" | grep -vE '^- (chore|docs): ' | head -40)
MD
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock 2>/dev/null || true
git commit -q -m "chore: release v${V}" || true
git tag -f "v${V}"
git push -q origin main --tags
gh release create "v${V}" "$OUT" --title "Dispatch v${V}" --notes-file "$NOTES" --latest
rm -f "$NOTES"
echo "已发布 v${V}：$(gh release view "v${V}" --json url -q .url)"
