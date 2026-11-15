#!/bin/bash
# Copy this commit to the public repository as one snapshot commit, without the private history (GPL-3.0-or-later).
# Development happens in the private repository; the public one gets a snapshot per sync, made only from files git
# tracks. Never pushes: it commits in a local checkout of the public repository and prints the push command.
#
#   app/scripts/public-sync.sh <public checkout> [--no-gitleaks]
#
# <public checkout>  a clone of the public repository, or an empty folder (it becomes a new repository there).
#                    Everything in it but .git is replaced by this commit's files.
# Left out of the snapshot (EXCLUDE below): the maintainer's own notes and rules for agents working on this
# repository (CLAUDE.md, DECISIONS.md), design drafts (design/, process.md, .claude/), and the list of private
# markers (app/cli/test_private_markers.py, it names what it guards).
# Checked in the export before the commit; any hit stops it and names the file or the key, never a value:
#   1. no path of this Mac's home folder;
#   2. no value of a `dispatch env` key (read from its file in memory, values of 8 characters or more; a key whose
#      value is known not to be secret, a public host name say, can be named in PUBLIC_SYNC_ENV_ALLOW="K1 K2");
#   3. none of the private markers in app/cli/test_private_markers.py;
#   4. gitleaks finds nothing (with .gitleaks.toml), when gitleaks is installed; --no-gitleaks skips it.
# The commit is "sync: 同步到 <private commit>（<version>）" by the private repository's user.name, with the
# GitHub no-reply address unless PUBLIC_SYNC_EMAIL says otherwise (the private address stays private).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
DEST="${1:?usage: app/scripts/public-sync.sh <public checkout> [--no-gitleaks]}"
LEAKS=1
[ "${2:-}" = "--no-gitleaks" ] && LEAKS=0
EXCLUDE=(CLAUDE.md DECISIONS.md design process.md .claude app/cli/test_private_markers.py)

[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "public-sync: uncommitted changes here; commit first" >&2; exit 1; }
SHA="$(git rev-parse HEAD)"
VERSION="$(python3 -c 'import json; print(json.load(open("app/package.json"))["version"])')"

mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"
case "$DEST/" in "$ROOT/"*) echo "public-sync: the public checkout must be outside this repository" >&2; exit 1 ;; esac
if [ ! -e "$DEST/.git" ]; then
  [ -z "$(ls -A "$DEST")" ] || { echo "public-sync: $DEST is neither a git repository nor empty" >&2; exit 1; }
  git -C "$DEST" init -q -b main
fi

# the snapshot: every tracked file but the excluded ones, in place of what the public checkout had
find "$DEST" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
PATHSPEC=(.)
for x in "${EXCLUDE[@]}"; do PATHSPEC+=(":(exclude)$x"); done
git ls-files -z -- "${PATHSPEC[@]}" | rsync -a --from0 --files-from=- ./ "$DEST/"
COUNT="$(git ls-files -- "${PATHSPEC[@]}" | wc -l | tr -d ' ')"
echo "exported $COUNT files of commit ${SHA:0:12} to $DEST (left out: ${EXCLUDE[*]})"

fail() { echo "public-sync: $*; nothing committed" >&2; exit 1; }

# 1. this Mac's home folder
HITS="$(grep -rIlF --exclude-dir=.git -e "$HOME/" -e "/Users/$(id -un)/" "$DEST" || true)"
[ -z "$HITS" ] || fail "paths of this Mac's home folder in: $(echo "$HITS" | sed "s#^$DEST/##" | head -10 | tr '\n' ' ')"
echo "check 1 ok: no path of this Mac's home folder"

# 2. the values in dispatch env, compared in memory; only key names are printed
python3 - "$DEST" "${DISPATCH_ENV_FILE:-$HOME/.config/dispatch/env}" "${PUBLIC_SYNC_ENV_ALLOW:-}" <<'PY'
import os, sys
dest, env_file, allow = sys.argv[1], sys.argv[2], set(sys.argv[3].split())
values = {}
if os.path.exists(env_file):
    for line in open(env_file, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        if len(v) >= 8 and k.strip() not in allow:
            values[k.strip()] = v.encode()
found = {}
for d, dirs, files in os.walk(dest):
    dirs[:] = [x for x in dirs if x != ".git"]
    for f in files:
        p = os.path.join(d, f)
        if os.path.islink(p):
            continue
        data = open(p, "rb").read()
        for k, v in values.items():
            if v in data:
                found.setdefault(k, []).append(os.path.relpath(p, dest))
if found:
    for k, where in sorted(found.items()):
        print(f"public-sync: the value of {k} is in {', '.join(where[:5])}", file=sys.stderr)
    sys.exit(1)
print(f"check 2 ok: none of {len(values)} dispatch env values (8+ characters) is in the export")
PY

# 3. the private markers
MARKERS="$(mktemp)"
trap 'rm -f "$MARKERS"' EXIT
python3 -c 'import sys; sys.path.insert(0, "app/cli"); import test_private_markers as m; print("\n".join(m.MARKERS))' > "$MARKERS"
HITS="$(grep -rIliE --exclude-dir=.git -f "$MARKERS" "$DEST" || true)"
[ -z "$HITS" ] || fail "private markers (app/cli/test_private_markers.py) in: $(echo "$HITS" | sed "s#^$DEST/##" | head -10 | tr '\n' ' ')"
echo "check 3 ok: none of $(wc -l < "$MARKERS" | tr -d ' ') private markers"

# 4. gitleaks over the export
if [ "$LEAKS" = 1 ] && command -v gitleaks >/dev/null; then
  (cd "$DEST" && GOMAXPROCS=2 gitleaks dir . --no-banner --redact --log-level error --config .gitleaks.toml) || fail "gitleaks found secrets (above)"
  echo "check 4 ok: gitleaks found nothing"
else
  echo "check 4 skipped: gitleaks $([ "$LEAKS" = 1 ] && echo "not installed" || echo "--no-gitleaks")"
fi

cd "$DEST"
git add -A --force   # every file here is tracked in the private repository, also the few its .gitignore would skip
if git diff --cached --quiet; then echo "the public checkout already holds this snapshot"; exit 0; fi
echo "to publish: $(git diff --cached --shortstat)"
NAME="$(git -C "$ROOT" config user.name)"
git -c user.name="$NAME" -c user.email="${PUBLIC_SYNC_EMAIL:-$NAME@users.noreply.github.com}" commit -q -m "sync: 同步到 $SHA（$VERSION）"
echo "committed $(git rev-parse --short HEAD) in $DEST: sync: 同步到 $SHA（$VERSION）"
echo "not pushed; to publish: git -C \"$DEST\" push origin main"
