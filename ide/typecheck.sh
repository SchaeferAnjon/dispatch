#!/bin/bash
# Type-check Dispatch's code in ide/vscode. Both builds compile with esbuild, which does not check types, so a type
# error only shows up here. Checks every .ts file under src/ that differs from VS Code 1.139.1 as released (the commit
# that brought it into this repository) and what they import, not all of VS Code, and each extension project
# (tsconfig.json) with a changed file: the native tsc, about 20 s and 2.5 GB, fine next to a build.
#
# With isolatedModules on: the development build (dev.sh) compiles one file at a time, and there a type re-exported
# without `export type` breaks the page that loads it (the package does not notice, it compiles the whole graph).
# TS18055 (an enum member's string type) is the one isolatedModules complaint esbuild does not mind; it is left out.
#
# node_modules: ide/vscode's own when it has them (dev.sh deps), else another checkout's (VSCODE_NODE_MODULES, or the
# build service's trees in ~/dispatch-builds/work), linked for the run. Electron's typings are not in node_modules
# (VS Code downloads Electron itself); they come from npm once, the version in .npmrc, and are kept in .cache.
#
#   ./typecheck.sh          # prints the errors; exits 1 when there are any
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
V="$HERE/vscode"
C="$HERE/.cache/typecheck"
mkdir -p "$C"
cleanup=()
trap 'for f in "${cleanup[@]:-}"; do [ -n "$f" ] && rm -rf "$f"; done' EXIT

if [ ! -e "$V/node_modules" ]; then
  donor="${VSCODE_NODE_MODULES:-}"
  for c in "$donor" "$HOME/dispatch-builds/work/dev/ide/vscode/node_modules" "$HOME/dispatch-builds/work/dispatch/ide/vscode/node_modules" \
           "$HOME/dispatch-builds/work/dispatch-ide/vscode/node_modules"; do
    if [ -n "$c" ] && [ -d "$c/typescript" ]; then donor="$c"; break; fi
  done
  [ -d "$donor/typescript" ] || { echo "no node_modules for ide/vscode: ./dev.sh deps, or set VSCODE_NODE_MODULES" >&2; exit 2; }
  ln -s "$donor" "$V/node_modules"
  cleanup+=("$V/node_modules")
  # the extensions' own packages, for their projects below
  for e in "$(dirname "$donor")"/extensions/*/node_modules "$(dirname "$donor")"/extensions/node_modules; do
    rel="${e#"$(dirname "$donor")"/}"
    if [ -d "$e" ] && [ ! -e "$V/$rel" ]; then ln -s "$e" "$V/$rel"; cleanup+=("$V/$rel"); fi
  done
fi

ELECTRON="$(sed -n 's/^target="\(.*\)"/\1/p' "$V/.npmrc")"
if [ ! -f "$C/electron-$ELECTRON/electron.d.ts" ]; then
  (cd "$C" && npm pack "electron@$ELECTRON" --silent >/dev/null && mkdir -p "electron-$ELECTRON" && tar xzf "electron-$ELECTRON.tgz" -C "electron-$ELECTRON" --strip-components 1 && rm -f "electron-$ELECTRON.tgz")
fi

# VS Code as released: the commit that added ide/vscode (git diff from it is everything Dispatch changed)
BASE="$(git log --format=%H --diff-filter=A -- vscode/package.json | tail -1)"
[ -n "$BASE" ] || { echo "cannot find the commit that brought VS Code in" >&2; exit 2; }
git diff --name-only "$BASE" -- vscode/src | sed 's#^ide/vscode/src/##' | grep '\.ts$' | grep -v '\.d\.ts$' | sort -u >"$C/files.txt" || true
# also what is changed and not committed yet
git status --porcelain --untracked-files=all -- vscode/src | sed 's#^...##; s#^ide/vscode/src/##; s#^vscode/src/##' | grep '\.ts$' | grep -v '\.d\.ts$' >>"$C/files.txt" || true
CFG="$V/src/tsconfig.dispatch-check.json"
cleanup+=("$CFG")
python3 - "$C/files.txt" "$V/src" "$C/electron-$ELECTRON" <<'PY'
import json, os, re, sys
files = sorted({f for f in open(sys.argv[1]).read().split() if os.path.exists(os.path.join(sys.argv[2], f))})
base = open(os.path.join(sys.argv[2], "tsconfig.base.json")).read()
# tsconfig.base.json is JSON with comments and trailing commas
base = json.loads(re.sub(r",(\s*[}\]])", r"\1", re.sub(r"^\s*//.*$", "", base, flags=re.M)))
paths = dict(base.get("compilerOptions", {}).get("paths") or {})
paths["electron"] = [os.path.join(sys.argv[3], "electron.d.ts")]
json.dump({"extends": "./tsconfig.json", "compilerOptions": {"noEmit": True, "isolatedModules": True, "plugins": [], "paths": paths},
           "include": ["./vs/**/*.d.ts", "./typings", "./vscode-dts/vscode.proposed.*.d.ts", "./vscode-dts/vscode.d.ts"],
           "files": files}, open(os.path.join(sys.argv[2], "tsconfig.dispatch-check.json"), "w"), indent=1)
print(f"checking {len(files)} files Dispatch changed or added under src/")
PY
cd "$V"
fail=0
out="$(node_modules/.bin/tsc -p src/tsconfig.dispatch-check.json 2>&1 || true)"
errors="$(printf '%s\n' "$out" | grep -E 'error TS[0-9]+' | grep -v 'error TS18055' || true)"
if [ -n "$errors" ]; then printf '%s\n' "$errors"; fail=1; fi
# the extension projects Dispatch changed, with each extension's own packages
for ext in $(cd "$HERE" && git diff --name-only "$BASE" -- vscode/extensions | sed 's#^ide/vscode/extensions/\([^/]*\)/.*#\1#' | sort -u); do
  for cfg in "extensions/$ext/tsconfig.json" extensions/"$ext"/*/tsconfig.json; do
    [ -f "$cfg" ] || continue
    dir="$(dirname "$cfg")"
    if [ "$dir" = "extensions/$ext" ]; then sub="vscode/extensions/$ext/src"; else sub="vscode/$dir"; fi
    [ -n "$(cd "$HERE" && git diff --name-only "$BASE" -- "$sub")" ] || continue
    echo "checking $cfg"
    node_modules/.bin/tsc -p "$cfg" --noEmit || fail=1
  done
done
if [ $fail = 0 ]; then echo "no type errors"; else exit 1; fi
