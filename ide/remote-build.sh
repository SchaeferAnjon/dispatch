#!/bin/bash
# Build Dispatch IDE on the Mac mini (the second build machine) for one commit of this repository, without
# touching this Mac's build directory. `dispatch build` (app/cli/builds.py) drives it; by hand:
#
# On the MacBook, in this repository:
#   ide/remote-build.sh [<ref>] [--fetch] [--min] [--rebuild] [--no-follow]
#       ref defaults to main. Pushes the commit to the mini (refs/builds/<sha>, and main -> main when it
#       fast-forwards), starts the full package there and follows its log. The build runs detached: Ctrl-C or a
#       dropped ssh only stops the following, not the build. --fetch copies the finished build to ide/staging/<name>/.
#   ide/remote-build.sh --follow <name>   re-attach to a build's log until it ends (add --fetch before it to fetch)
#   ide/remote-build.sh --get <name>      copy a finished build to ide/staging/<name>/ here
#   ide/remote-build.sh --list            builds on the mini: name, status, time, size
# On the build machine itself:
#   bash <repo>/ide/remote-build.sh --here [<ref>] [--min] [--rebuild]   the full package, detached
#   bash <repo>/ide/remote-build.sh --dev-run <sha> <name>                a development build, in the foreground
#
# Full packages go one at a time (lock ~/dispatch-builds/.lock, first come first built) in a git worktree that stays
# between builds, ~/dispatch-builds/work/dispatch (its node_modules and caches are reused); each result is
# ~/dispatch-builds/<sha12>[-min]/ with Dispatch IDE.app, build.log, info.json and status ("ok <secs>" or
# "failed <rc> <secs>").
# Development builds (ide/dev.sh) compile in place in a second worktree, ~/dispatch-builds/work/dev, which keeps its
# compiled output between builds, so only what changed since the previous one is compiled; its result folder is
# <sha12>-dev/ and the app is the tree itself (ide/vscode). builds.py runs them one at a time and keeps the tree on
# that commit until the build's end-to-end scenarios are done.
# Signing: an ssh session cannot use the mini's keychain (codesign says errSecInternalComponent), so mini builds are
# signed ad-hoc (DISPATCH_SIGNING_IDENTITY=-); `dispatch build sign` re-signs a fetched build here.
# Maintainer tooling with no defaults: DISPATCH_MINI (user@host of the build Mac) and DISPATCH_MINI_REPO (its checkout)
# on the MacBook side, DISPATCH_BUILD_REPO (the checkout to build from) on the build machine. Without a second Mac,
# `dispatch build start … --on local` builds on this one.
set -euo pipefail

MINI="${DISPATCH_MINI:-}"
MINI_REPO="${DISPATCH_MINI_REPO:-}"
B="${DISPATCH_BUILDS_DIR:-$HOME/dispatch-builds}"
W="$B/work"
BUILD_REPO="${DISPATCH_BUILD_REPO:-}"  # the repository on the build machine (the mini, or this Mac for --on local)
BUILD_REPO="${BUILD_REPO/#\~/$HOME}"

die() { echo "remote-build: $*" >&2; exit 1; }
need_repo() { [ -n "$BUILD_REPO" ] || die "set DISPATCH_BUILD_REPO to the checkout of this repository on this machine"; }

# ---------------------------------------------------------------- build machine side
mini_env() {
  export FNM_DIR="$HOME/.local/share/fnm"
  export PATH="$FNM_DIR/node-versions/v24.18.0/installation/bin:$FNM_DIR:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
}

here() { # [ref] [--min] [--rebuild]
  mini_env
  local ref=main min="" rebuild=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --min) min=1; shift ;;
      --rebuild) rebuild=1; shift ;;
      -*) die "unknown option $1" ;;
      *) ref="$1"; shift ;;
    esac
  done
  local sha name d
  need_repo
  sha="$(git -C "$BUILD_REPO" rev-parse --verify -q "$ref^{commit}")" || die "no commit $ref in $BUILD_REPO"
  name="${sha:0:12}${min:+-min}"
  d="$B/$name"
  mkdir -p "$d"
  # an ok build whose app prune() removed is built again
  if [ -z "$rebuild" ] && [ -s "$d/status" ] && [ "$(cut -d' ' -f1 "$d/status")" = ok ] && [ -d "$d/Dispatch IDE.app" ]; then
    echo "name: $name"; echo "already built: $d ($(cat "$d/status"))"; return 0
  fi
  if [ ! -s "$d/status" ] && [ -s "$d/pid" ] && kill -0 "$(cat "$d/pid")" 2>/dev/null; then
    echo "name: $name"; echo "already running (pid $(cat "$d/pid"))"; return 0
  fi
  rm -f "$d/status"
  cp "${BASH_SOURCE[0]}" "$d/remote-build.sh"
  nohup bash "$d/remote-build.sh" --run "$sha" "$name" "$min" >"$d/build.log" 2>&1 </dev/null &
  echo $! >"$d/pid"
  echo "name: $name"
  echo "started (pid $!), log: $d/build.log"
}

worktree() { # <dir> <sha>: a worktree of the repository at that commit; files that did not change keep their times
  if [ ! -e "$1/.git" ]; then
    need_repo
    git -C "$BUILD_REPO" worktree prune
    git -C "$BUILD_REPO" worktree add -q --detach "$1" "$2"
  fi
  git -C "$1" checkout -q --force --detach "$2"
  git -C "$1" clean -fdq   # untracked leftovers only; ignored ones (node_modules, out/, .build/, .cache/) stay
}

# A new worktree takes its node_modules and download caches from a tree that has them for the same package locks,
# so its first build does not npm ci again: the checkout from before the IDE moved into this repository
# (work/dispatch-ide/vscode, a clone of the VS Code tag; moved, it is not used any more) or the other worktree
# (work/dev or work/dispatch; cloned, which on APFS takes no room until a file changes).
adopt() { # <new worktree>
  local new="$1" donor="" mode="" c p
  if [ ! -d "$new/ide/vscode/node_modules" ]; then
    for c in "$W/dispatch-ide/vscode:mv" "$W/dev/ide/vscode:cp" "$W/dispatch/ide/vscode:cp"; do
      p="${c%:*}"
      [ "$p" != "$new/ide/vscode" ] && [ -d "$p/node_modules" ] && cmp -s "$p/package-lock.json" "$new/ide/vscode/package-lock.json" || continue
      donor="$p"; mode="${c##*:}"; break
    done
    if [ -n "$donor" ]; then
      echo "== node_modules from $donor ($mode)"
      (cd "$donor" && find . -path ./.build -prune -o -name node_modules -type d -prune -print) | while read -r p; do
        mkdir -p "$new/ide/vscode/$(dirname "$p")"
        if [ "$mode" = mv ]; then mv "$donor/$p" "$new/ide/vscode/$p"; else cp -cR "$donor/$p" "$new/ide/vscode/$p"; fi
      done
      (cd "$new/ide" && bash dev.sh lock-sum) >"$new/ide/vscode/node_modules/.dispatch-lock-sha"
    fi
  fi
  for c in "$W/dispatch-ide/.cache" "$W/dev/ide/.cache" "$W/dispatch/ide/.cache"; do
    if [ ! -d "$new/ide/.cache" ] && [ -d "$c" ] && [ "$c" != "$new/ide/.cache" ]; then cp -cR "$c" "$new/ide/.cache"; fi
  done
  for c in "$W/kanban" "$W/dev" "$W/dispatch"; do
    if [ ! -d "$new/app/node_modules" ] && [ -d "$c/app/node_modules" ] && [ "$c" != "$new" ] && cmp -s "$c/app/package-lock.json" "$new/app/package-lock.json"; then
      cp -cR "$c/app/node_modules" "$new/app/node_modules"
    fi
  done
}

queue_live() { # the tickets of waiting builds, oldest first; tickets of builds that are gone are dropped
  local t
  for t in $(command ls -1 "$B/.queue" 2>/dev/null | sort -t- -k1,1n -k2,2n); do
    if kill -0 "${t#*-}" 2>/dev/null; then echo "$t"; else rm -f "$B/.queue/$t"; fi
  done
}
queue_head() { queue_live | head -1; }
queue_pos() { queue_live | grep -nx -- "$1" | cut -d: -f1; }

ls_forget() { # <app>…: out of LaunchServices (the file stays), so only /Applications' copy is ever opened by the Dock
  # or Spotlight (launchservices.sh; inline here because the mini runs a lone copy of this script)
  local L=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister a
  [ -x "$L" ] || return 0
  for a in "$@"; do [ -d "$a" ] && { "$L" -u "$a" >/dev/null 2>&1 || true; }; done
  return 0
}

header() { # <sha> <name> <what>
  echo "== $2 on $(hostname -s), $(date '+%Y-%m-%d %H:%M:%S'): $3"
  echo "commit $1 $(git -C "$BUILD_REPO" log -1 --format="%<(100,trunc)%s" "$1" | sed "s/ *$//")"
  echo "node $(node -v), fnm $(fnm --version 2>/dev/null | cut -d' ' -f2), free disk $(df -h "$HOME" | awk 'NR==2 {print $4}')"
}

info() { # <dir> <sha> <secs> <min> <dev> <app>
  python3 - "$@" <<'EOF'
import json, os, sys, socket, time
d, sha, secs, mini, dev, app = sys.argv[1:]
prod = json.load(open(os.path.join(app, "Contents/Resources/app/product.json") if dev != "1" else os.path.join(app, "product.json")))
json.dump({"commit": sha, "kanban": sha, "min": mini == "1", "dev": dev == "1", "app": app, "build_seconds": int(secs),
           "finished": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "host": socket.gethostname(),
           "version": prod.get("version"), "build_id": prod.get("commit")}, open(os.path.join(d, "info.json"), "w"), indent=2)
EOF
}

run() { # <sha> <name> <min>: the full package
  mini_env
  local sha="$1" name="$2" min="$3" d="$B/$2" t0=$SECONDS rc=0
  # the traps run after run() returns, when its locals are gone: expand d and B now
  trap "rc=\$?; [ -s '$d/status' ] || echo \"failed \$rc\" >'$d/status'" EXIT
  header "$sha" "$name" "full package${min:+, MIN=1}"

  # first come, first built: each waiting build holds a ticket <epoch>-<pid> in .queue/ and takes the lock only
  # when its ticket is the oldest one still alive (dispatch build list shows the position)
  local waited="" ticket
  mkdir -p "$B/.queue"
  ticket="$(date +%s)-$$"
  echo "$name" >"$B/.queue/$ticket"
  trap "rc=\$?; rm -f '$B/.queue/$ticket'; [ -s '$d/status' ] || echo \"failed \$rc\" >'$d/status'" EXIT
  until [ "$(queue_head)" = "$ticket" ] && shlock -f "$B/.lock" -p $$; do
    [ -n "$waited" ] || echo "waiting for the build lock: number $(queue_pos "$ticket") in the queue, building now: $(cat "$B/.lock.name" 2>/dev/null || echo "nothing (pid $(cat "$B/.lock" 2>/dev/null))")"
    waited=1; sleep 5
  done
  rm -f "$B/.queue/$ticket"
  echo "$name" >"$B/.lock.name"
  trap "rc=\$?; rm -f '$B/.lock' '$B/.lock.name'; [ -s '$d/status' ] || echo \"failed \$rc\" >'$d/status'" EXIT
  [ -z "$waited" ] || echo "got the lock after $((SECONDS - t0))s"

  echo "== checkout"
  mkdir -p "$W"
  worktree "$W/dispatch" "$sha"
  adopt "$W/dispatch"

  echo "== ide/build.sh"
  local tb=$SECONDS
  rm -rf "$W/dispatch/ide/VSCode-darwin-arm64"
  # DISPATCH_KEEP_KEYCHAIN: the ad-hoc signing leaves the keychain alone (install.sh decides that)
  (cd "$W/dispatch/ide" && DISPATCH_SIGNING_IDENTITY="${DISPATCH_SIGNING_IDENTITY:--}" DISPATCH_KEEP_KEYCHAIN=1 MIN="$min" bash build.sh) || rc=$?
  local secs=$((SECONDS - tb))
  if [ "$rc" -ne 0 ]; then
    echo "== FAILED: build.sh exited $rc after $((secs / 60))m$((secs % 60))s"
    echo "failed $rc $((SECONDS - t0))" >"$d/status"
    exit "$rc"
  fi
  rm -rf "$d/Dispatch IDE.app"
  mv "$W/dispatch/ide/VSCode-darwin-arm64/Dispatch IDE.app" "$d/"
  ls_forget "$d/Dispatch IDE.app"
  info "$d" "$sha" "$secs" "$min" 0 "$d/Dispatch IDE.app"
  echo "ok $((SECONDS - t0))" >"$d/status"
  prune
  echo "== ok: build.sh took $((secs / 60))m$((secs % 60))s"
  echo "app: $d/Dispatch IDE.app ($(du -sh "$d/Dispatch IDE.app" | cut -f1)), free disk $(df -h "$HOME" | awk 'NR==2 {print $4}')"
}

dev_run() { # <sha> <name>: the development build, in the foreground (builds.py's job holds the dev tree meanwhile)
  mini_env
  local sha="$1" name="$2" d="$B/$2" t0=$SECONDS rc=0
  mkdir -p "$d"
  rm -f "$d/status"
  exec > >(tee "$d/build.log") 2>&1
  trap "rc=\$?; [ -s '$d/status' ] || echo \"failed \$rc \$((SECONDS - $t0))\" >'$d/status'" EXIT
  header "$sha" "$name" "development build"
  echo "== checkout"
  mkdir -p "$W"
  worktree "$W/dev" "$sha"
  adopt "$W/dev"
  echo "== ide/dev.sh build"
  (cd "$W/dev/ide" && bash dev.sh build) || rc=$?
  local secs=$((SECONDS - t0))
  if [ "$rc" -ne 0 ]; then
    echo "== FAILED: dev.sh build exited $rc after ${secs}s"
    echo "failed $rc $secs" >"$d/status"
    exit "$rc"
  fi
  ls_forget "$W/dev/ide/vscode/.build/electron/"*.app
  info "$d" "$sha" "$secs" 0 1 "$W/dev/ide/vscode"
  echo "ok $secs" >"$d/status"
  echo "== ok: development build in ${secs}s, app: $W/dev/ide/vscode"
}

prune() { # keep the newest $DISPATCH_KEEP_BUILDS apps (default 5); older build dirs keep their log and info
  local keep="${DISPATCH_KEEP_BUILDS:-5}" n=0 d
  for d in $(ls -1td "$B"/*/ 2>/dev/null); do
    [ -d "$d/Dispatch IDE.app" ] || continue
    n=$((n + 1))
    if [ "$n" -gt "$keep" ]; then rm -rf "$d/Dispatch IDE.app"; echo "pruned the app of $(basename "$d") (log kept)"; fi
  done
}

follow() { # <name>
  local d="$B/$1" t
  [ -d "$d" ] || die "no build $1 on $(hostname -s)"
  tail -n +1 -f "$d/build.log" & t=$!
  while [ ! -s "$d/status" ]; do
    if [ -s "$d/pid" ] && ! kill -0 "$(cat "$d/pid")" 2>/dev/null && [ ! -s "$d/status" ]; then
      sleep 2; [ -s "$d/status" ] || { echo "failed ? (build process gone)" >"$d/status"; }
    fi
    sleep 3
  done
  sleep 1; kill "$t" 2>/dev/null || true
  echo "status: $(cat "$d/status")   dir: $d"
  [ "$(cut -d' ' -f1 "$d/status")" = ok ]
}

list() {
  local d s
  for d in "$B"/*/; do
    [ -f "$d/build.log" ] || continue
    s="$(cat "$d/status" 2>/dev/null || echo running)"
    printf '%-32s %-18s %s\n' "$(basename "$d")" "$s" "$( [ -d "$d/Dispatch IDE.app" ] && du -sh "$d/Dispatch IDE.app" | cut -f1)"
  done
  echo "lock: $(cat "$B/.lock.name" 2>/dev/null || echo free), free disk $(df -h "$HOME" | awk 'NR==2 {print $4}')"
}

case "${1:-}" in
  --here) shift; here "$@"; exit ;;
  --run) shift; run "$@"; exit ;;
  --dev-run) shift; dev_run "$@"; exit ;;
  --follow-here) follow "$2"; exit ;;
  --list-here) list; exit ;;
esac

# ---------------------------------------------------------------- MacBook side
cd "$(dirname "$0")"
REPO="$(cd .. && pwd)"
[ -n "$MINI" ] || die "set DISPATCH_MINI=user@host (the build Mac); without one, use: dispatch build start <ref> --on local"
[ -n "$MINI_REPO" ] || die "set DISPATCH_MINI_REPO to the build Mac's checkout of this repository (e.g. ~/Projects/dispatch)"
on_mini() { ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 "$MINI" "$@"; }
ship() { on_mini 'mkdir -p ~/dispatch-builds' && scp -q -o BatchMode=yes "$PWD/remote-build.sh" "$MINI:dispatch-builds/remote-build.sh"; }
fetch() {
  mkdir -p "staging/$1"
  rsync -a --delete "$MINI:dispatch-builds/$1/" "staging/$1/"
  ls_forget "$PWD/staging/$1/Dispatch IDE.app"
  echo "fetched: $PWD/staging/$1/Dispatch IDE.app"
}

ref=main do_fetch="" flags=() follow=1
while [ $# -gt 0 ]; do
  case "$1" in
    --fetch) do_fetch=1; shift ;;
    --min|--rebuild) flags+=("$1"); shift ;;
    --no-follow) follow=""; shift ;;
    --follow) ship; rc=0; on_mini "bash ~/dispatch-builds/remote-build.sh --follow-here '${2:?--follow needs a build name}'" || rc=$?
      [ -z "$do_fetch" ] || [ $rc -ne 0 ] || fetch "$2"; exit $rc ;;
    --get) fetch "${2:?--get needs a build name}"; exit ;;
    --list) ship; on_mini "bash ~/dispatch-builds/remote-build.sh --list-here"; exit ;;
    -h|--help) sed -n '2,30p' "$0"; exit ;;
    -*) die "unknown option $1" ;;
    *) ref="$1"; shift ;;
  esac
done

sha="$(git -C "$REPO" rev-parse --verify -q "$ref^{commit}")" || die "no commit $ref here"
echo "commit $sha ($ref) -> $MINI"

# the commit goes to refs/builds/<sha> (never checked out, so a dirty mini working copy does not matter); main also
# goes to main when it fast-forwards (the mini's working copy follows via updateInstead)
GIT_LFS_SKIP_PUSH=1 git -C "$REPO" push -q "ssh://$MINI/${MINI_REPO#/}" "$sha:refs/builds/$sha"
GIT_LFS_SKIP_PUSH=1 git -C "$REPO" push -q "ssh://$MINI/${MINI_REPO#/}" main:main 2>/dev/null || echo "note: the mini's main was not updated (diverged or its working copy is dirty)"

ship
out="$(on_mini "DISPATCH_BUILD_REPO=$(printf %q "$MINI_REPO") bash ~/dispatch-builds/remote-build.sh --here $sha ${flags[*]:-}")"
echo "$out"
name="$(printf '%s\n' "$out" | sed -n 's/^name: //p')"
[ -n "$name" ] || die "the mini did not start a build"
if printf '%s\n' "$out" | grep -q '^already built'; then
  echo "log on the mini: ~/dispatch-builds/$name/build.log (--rebuild to build again)"
  [ -z "$do_fetch" ] || fetch "$name"
  exit 0
fi
if [ -z "$follow" ]; then
  echo "follow: ide/remote-build.sh --follow $name   fetch: ide/remote-build.sh --get $name"
  exit 0
fi
trap 'echo; echo "stopped following; the build keeps running on the mini: ide/remote-build.sh --follow $name"; exit 130' INT
rc=0
on_mini "bash ~/dispatch-builds/remote-build.sh --follow-here '$name'" || rc=$?
echo "log on the mini: ~/dispatch-builds/$name/build.log"
if [ $rc -eq 0 ] && [ -n "$do_fetch" ]; then fetch "$name"; fi
exit $rc
