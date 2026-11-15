#!/bin/bash
# `dispatch-update`: build Dispatch IDE (on this Mac, or with ide/remote-build.sh on a second build Mac when DISPATCH_MINI is set)
# and fetch it, sign and notarize it here (ide/sign.sh: the Developer ID and the notary credentials live in this
# Mac's keychain), install it as /Applications/Dispatch IDE.app (ide/install.sh; refuses while it is running),
# unregister every other copy from LaunchServices, rebuild the phone's web page (app/dist) and move the phone service
# and chatd onto this checkout's CLI.
# Dispatch.app (Tauri) is retired: nothing here builds or opens it.
# Usage: scripts/install.sh [--local] [--no-build] [--no-launch]
#   --local       build on this Mac (ide/build.sh, waits for ide/.build.lock); the default when DISPATCH_MINI
#                 (user@host of a second build Mac, with DISPATCH_MINI_REPO its checkout) is not set
#   --no-build    sign and install the build of this commit (ide/staging or ~/dispatch-builds), else the newest fetched
#   --no-launch   do not open Dispatch IDE afterwards
# The mini builds from pushed commits: commit and push first.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"
IDE="$(cd .. && pwd)/ide"

BUILD=1; LAUNCH=1; LOCAL=0
for a in "$@"; do
  case "$a" in
    --no-build) BUILD=0 ;;
    --no-launch) LAUNCH=0 ;;
    --local) LOCAL=1 ;;
  esac
done
# no second build Mac named: build here
if [ "$LOCAL" = 0 ] && [ "$BUILD" = 1 ] && [ -z "${DISPATCH_MINI:-}" ]; then LOCAL=1; fi
[ -x "$IDE/remote-build.sh" ] || { echo "没找到 Dispatch IDE 的源码和构建脚本：${IDE}" >&2; exit 1; }

# The phone's web page is served from app/dist (dispatch serve).
npm run -s build >/dev/null
echo "网页版已构建：$PWD/dist"

if [ "$LOCAL" = 1 ]; then
  if [ "$BUILD" = 1 ]; then
    node scripts/gen-ide-theme.mjs >/dev/null
    while [ -e "$IDE/.build.lock" ]; do echo "等别人的构建（$IDE/.build.lock）"; sleep 30; done
    echo dispatch-update > "$IDE/.build.lock"
    trap 'rm -f "$IDE/.build.lock"' EXIT
    "$IDE/build.sh"   # signs at the end (update-bridge.sh); no notarization needed on this Mac
    rm -f "$IDE/.build.lock"; trap - EXIT
  fi
  APP="$IDE/VSCode-darwin-arm64/Dispatch IDE.app"
else
  if [ "$BUILD" = 1 ]; then
    OUT="$(mktemp)"
    "$IDE/remote-build.sh" main --fetch | tee "$OUT"
    APP="$(sed -n 's/^fetched: //p' "$OUT" | tail -1)"
    rm -f "$OUT"
    [ -n "$APP" ] || { echo "mini 上的构建没取回来（见上面的日志）" >&2; exit 1; }
  else
    # the build of this checkout's commit, or of the closest one before it (a script-only commit since is not in the
    # app): a build made on this Mac (the mini unreachable) stays in ~/dispatch-builds/<name> and is never copied to
    # staging, so the newest staging folder was an older build (10-10)
    APP=""
    for NAME in $(git rev-list -n 30 HEAD | cut -c1-12); do
      for d in "$IDE/staging/$NAME" "${DISPATCH_BUILDS_DIR:-$HOME/dispatch-builds}/$NAME"; do
        if [ -d "$d/Dispatch IDE.app" ]; then APP="$d/Dispatch IDE.app"; break 2; fi
      done
    done
    # else the newest fetch by its folder (get and sign write into it): the apps themselves all carry the build's fixed
    # 1980 timestamp, so their own times picked whichever one something had touched (an older 0.9.1, 10-09)
    if [ -z "$APP" ]; then
      DIR="$(ls -dt "$IDE"/staging/*/ 2>/dev/null | while read -r d; do [ -d "$d/Dispatch IDE.app" ] && echo "$d" && break; done)"
      APP="${DIR%/}/Dispatch IDE.app"; [ -n "$DIR" ] || APP=""
    fi
    echo "安装 ${APP}"
    [ -n "$APP" ] || { echo "$IDE/staging 里没有取回的构建，去掉 --no-build 再跑" >&2; exit 1; }
  fi
  # a build `dispatch build sign` already signed and notarized is installed as it is: signing it again would only
  # notarize the same bytes a second time, and a failed second try (Apple's timestamp service away, 10-09) leaves
  # the good copy half re-signed
  # A Developer ID copy that is not notarized (the notary credentials gone, 10-10) is kept too: sign.sh would
  # re-sign it with ~/.config/dispatch/signing-identity (an Apple Development certificate on this Mac), and the
  # changed signature costs the IDE its Safe Storage key. No `| grep -q` here: under pipefail grep quitting early
  # kills codesign with SIGPIPE and the test fails
  if [ "$BUILD" = 0 ] && codesign --verify --deep --strict "$APP" 2>/dev/null && xcrun stapler validate "$APP" >/dev/null 2>&1; then
    echo "已签名并公证：${APP}（不再重签）"
  elif [ "$BUILD" = 0 ] && codesign --verify --deep --strict "$APP" 2>/dev/null \
      && [[ "$(codesign -dvv "$APP" 2>&1)" == *$'\n'"Authority=Developer ID Application:"* ]]; then
    echo "已用 Developer ID 签名、未公证：${APP}（不再重签）"
  else
    "$IDE/sign.sh" "$APP"
  fi
fi
# The agents' Dispatch hooks run ~/.dispatch/bin/dispatch-hook, a shim outside the app that never stops a tool call
# (hooks_setup.shim_text). Older installs pointed them at hook.py inside the app: while the app is being replaced
# that file is gone and every tool call of every agent was blocked (10-09). Move them to the shim before the app
# goes (the shim runs this checkout's hook.py meanwhile), then point the shim at the installed app.
python3 -B cli/dispatch.py hooks sync || echo "dispatch hooks sync（安装前）没成功，接着装" >&2
if [ "$LAUNCH" = 1 ]; then DISPATCH_IDE_SRC="$APP" "$IDE/install.sh"; else DISPATCH_IDE_SRC="$APP" "$IDE/install.sh" --no-open; fi
# Every other Dispatch IDE.app on this Mac (builds, staging, backups) out of LaunchServices, files left alone: the
# Dock and Spotlight then only ever open the one just installed (10-09: they opened a backup from 10-01). About a minute.
[ -n "${DISPATCH_IDE_DEST:-}" ] || "$IDE/launchservices.sh" tidy "/Applications/Dispatch IDE.app"
APP_CLI="${DISPATCH_IDE_DEST:-/Applications/Dispatch IDE.app}/Contents/Resources/app/dispatch-cli/dispatch/cli/dispatch.py"
if [ -f "$APP_CLI" ]; then
  python3 -B "$APP_CLI" hooks sync && echo "Agent 的钩子指向 ~/.dispatch/bin/dispatch-hook（App 被替换时不拦工具）"
fi

# The phone service and chatd run this checkout's CLI. An older install pointed the phone service into
# Dispatch.app's bundle; point it here (only when it is installed).
# chatd is restarted onto the new code only while it holds no session (a restart ends them).
python3 -B - "$PWD/cli" <<'PY'
import json, os, plistlib, subprocess, sys
cli = sys.argv[1]
sys.path.insert(0, cli)
import launchd, launchd_labels
serve = launchd_labels.label("dispatch-serve")
if launchd.installed(serve):
    args = plistlib.load(open(launchd.plist_path(serve), "rb")).get("ProgramArguments") or []
    if os.path.join(cli, "serve.py") not in args:
        subprocess.run([sys.executable, os.path.join(cli, "dispatch.py"), "serve", "install"], check=False)
        print("手机端常驻服务改为运行 " + os.path.join(cli, "serve.py"))
    else:
        launchd.kickstart(serve, restart=True)
        print("已重启网页版（dispatch serve）")
chatd = launchd_labels.label("chatd")
if launchd.installed(chatd):
    try:
        sessions = json.load(open(os.path.expanduser("~/tasks/.dispatch/chatd.json"))).get("sessions") or {}
    except (OSError, ValueError):
        sessions = {}
    if sessions:
        print("chatd 手里还有 %d 个会话，没重启；它们都结束后 `launchctl kickstart -k gui/%d/%s` 换上新代码" % (len(sessions), os.getuid(), chatd))
    else:
        subprocess.run(["launchctl", "kickstart", "-k", "gui/%d/%s" % (os.getuid(), chatd)], check=False)
        print("已重启 chatd 常驻服务")
PY
