#!/bin/bash
# Dispatch IDE's development build: ide/vscode compiled in place and run from source with VS Code's own Electron
# (.build/electron), the way VS Code's developers run it. Only what changed since the last build is compiled again
# (VS Code's build-fast: esbuild per file), so after a change to a few files it is ready to run in seconds. The
# full package (.app, signed, notarized) is build.sh's job.
#
#   ./dev.sh build        npm ci when the package locks changed; compile what changed (out/, extensions/*/out);
#                         Electron and the marketplace built-ins when missing; Dispatch's parts (bridge, CLI, theme,
#                         tools, SDKs) when theirs changed (parts.sh --dev). Writes vscode/.build/dispatch-dev.json,
#                         which `dispatch ide instance start --app <this ide/vscode>` reads to start a test instance.
#   ./dev.sh watch        keep compiling as files are saved (VS Code's watch-client-transpile); reload the window
#                         (Developer: Reload Window, ⌘R) to see a change
#   ./dev.sh run [args]   open the development build in a window of its own: its own user data ("Dispatch IDE Dev"),
#                         secrets in memory, no keychain
#   ./dev.sh launch       print the development build's launch line as JSON (what `run` and test instances use)
#
# First build in a fresh checkout: npm ci (about 5 min) and a full compile (about 15 s on the mini). Then a change to
# a file is compiled in under a second.
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
V="$HERE/vscode"
REPO="$(cd .. && pwd)"  # the checkout this script is in: its app/ and agent/ go into the app
NODE="$(cat "$V/.nvmrc")"
MANIFEST="$V/.build/dispatch-dev.json"

node_run() { # the Node VS Code pins (.nvmrc): the one on PATH when it is that version, else through fnm
  [ "$(node -v 2>/dev/null)" = "v$NODE" ] || command -v fnm >/dev/null || { echo "Dispatch IDE builds with Node $NODE (ide/vscode/.nvmrc): put that node first on PATH, or install fnm (brew install fnm && fnm install $NODE)" >&2; exit 1; }
  if [ "$(node -v 2>/dev/null)" = "v$NODE" ]; then (cd "$V" && "$@"); else (cd "$V" && fnm exec --using "$NODE" "$@"); fi
}

lock_sum() { # what node_modules is made from: .nvmrc, every package-lock.json and .npmrc in the tree
  (cd "$V" && { git ls-files -s -- .nvmrc ':(glob)**/package-lock.json' ':(glob)**/.npmrc'; git diff --no-ext-diff HEAD -- .nvmrc ':(glob)**/package-lock.json' ':(glob)**/.npmrc'; } | shasum | cut -d' ' -f1)
}

deps() { # npm ci in ide/vscode when its package locks changed since the last npm ci there
  local sum stamp="$V/node_modules/.dispatch-lock-sha"
  sum="$(lock_sum)"
  if [ -d "$V/node_modules" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$sum" ]; then return; fi
  echo "dev: npm ci (the package locks changed or there is no node_modules yet)"
  node_run npm ci
  echo "$sum" >"$stamp"
}

electron_bin() {
  local name exe
  name="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["nameLong"])' "$V/product.json")"
  exe="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["nameShort"])' "$V/product.json")"
  echo "$V/.build/electron/$name.app/Contents/MacOS/$exe"
}

manifest() { # the development build's launch line: binary, arguments before the caller's, environment
  python3 - "$V" "$(electron_bin)" "$REPO" "$@" <<'PY'
import json, os, subprocess, sys, time
v, binary, repo = sys.argv[1:4]
seconds = sys.argv[4] if len(sys.argv) > 4 else ""
git = lambda *a: subprocess.run(["git", "-C", repo, *a], capture_output=True, text=True).stdout.strip()
# what the full package leaves out (build.sh): GitHub Copilot and VS Code's other colour themes; the API tests
# extension is never in a package
off = ["vscode.vscode-api-tests", "GitHub.copilot-chat"] + [f"vscode.theme-{t}" for t in
       ("abyss", "kimbie-dark", "monokai", "monokai-dimmed", "quietlight", "red", "solarized-dark", "solarized-light", "tomorrow-night-blue")]
m = {
    "kind": "dispatch-ide-dev",
    "root": v,
    "binary": binary,
    "args": [v] + [f"--disable-extension={x}" for x in off],
    # scripts/code.sh's environment: run from source
    # DISPATCH_DEV_KEEP_HIDDEN: a test instance hides its windows; from source VS Code would bring a window that is
    # still hidden after 10 s to the front with its developer tools (windowImpl.ts)
    "env": {"NODE_ENV": "development", "VSCODE_DEV": "1", "VSCODE_CLI": "1", "ELECTRON_ENABLE_STACK_DUMPING": "1", "DISPATCH_DEV_KEEP_HIDDEN": "1"},
    "repo": repo,
    "commit": git("rev-parse", "HEAD"),
    "dirty": bool(git("status", "--porcelain", "--untracked-files=no", "--", ".")),
    "cli": os.path.join(repo, "app", "cli", "dispatch.py"),
    "built": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
}
if seconds:
    m["build_seconds"] = int(seconds)
os.makedirs(os.path.join(v, ".build"), exist_ok=True)
tmp = os.path.join(v, ".build", "dispatch-dev.json.tmp")
json.dump(m, open(tmp, "w"), indent=1)
os.replace(tmp, os.path.join(v, ".build", "dispatch-dev.json"))
print(json.dumps(m, indent=1))
PY
}

build() {
  local t0=$SECONDS
  deps
  node_run npm run -s build-fast
  # Electron (.build/electron, renamed to the product) and the marketplace built-ins (js-debug …) when missing;
  # it compiles nothing here (out/ is there)
  if ! node_run node build/lib/preLaunch.ts; then
    echo "dev: preLaunch failed once (a download?), trying again"
    node_run node build/lib/preLaunch.ts || [ -x "$(electron_bin)" ] || { echo "dev: no Electron at $(electron_bin)" >&2; exit 1; }
  fi
  ./parts.sh "$V" --dev
  # its Electron has the installed app's bundle id: out of LaunchServices, so the Dock never opens it (task-7ve7v)
  bash launchservices.sh forget "$(dirname "$(dirname "$(dirname "$(electron_bin)")")")" >/dev/null
  manifest "$((SECONDS - t0))" >/dev/null
  echo "dev: built in $((SECONDS - t0))s: $MANIFEST"
}

case "${1:-}" in
  build) build ;;
  watch) node_run npm run watch-client-transpile ;;
  deps) deps ;;
  lock-sum) lock_sum ;;  # build.sh and remote-build.sh: node_modules adopted from another checkout of the same locks
  launch) [ -s "$MANIFEST" ] && cat "$MANIFEST" || { echo "no development build yet: ./dev.sh build" >&2; exit 1; } ;;
  run)
    shift
    [ -s "$MANIFEST" ] || build
    readarray_compat() { python3 -c 'import json, sys; m = json.load(open(sys.argv[1])); print("\0".join([m["binary"]] + m["args"]), end="")' "$MANIFEST"; }
    argv=()
    while IFS= read -r -d '' a; do argv+=("$a"); done < <(readarray_compat; printf '\0')
    exec env NODE_ENV=development VSCODE_DEV=1 VSCODE_CLI=1 ELECTRON_ENABLE_STACK_DUMPING=1 \
      "${argv[@]}" --use-inmemory-secretstorage --use-mock-keychain "$@" ;;
  *) sed -n '2,22p' "$0"; exit 2 ;;
esac
