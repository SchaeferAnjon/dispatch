#!/bin/bash
# Sign (and notarize) Dispatch IDE.app: update-bridge.sh calls this after every local build, kanban's
# install.sh (dispatch-update) on a build fetched from the mini (remote-build.sh --fetch), release.sh too.
# Usage: ./sign.sh [app]   (default VSCode-darwin-arm64/Dispatch IDE.app)
#
# Identity: DISPATCH_SIGNING_IDENTITY, else the name in ~/.config/dispatch/signing-identity, else the first
# "Developer ID Application" certificate in the keychain, else ad-hoc ("-" asks for ad-hoc).
#   Developer ID: sign.mjs (hardened runtime, VS Code's entitlements, every Mach-O inside out). The
#     designated requirement is the team's certificate, the same after every rebuild: macOS keeps the
#     privacy grants and the "Dispatch IDE Safe Storage" key keeps trusting the app. Then it is
#     notarized (a few minutes online; DISPATCH_NOTARIZE=0 skips it): submitted to Apple with the keychain
#     profile DISPATCH_NOTARY_PROFILE (default "dispatch-notary", made once with `xcrun notarytool
#     store-credentials`), then the ticket is stapled, so a downloaded copy opens without the Gatekeeper
#     warning. A failed notarization only warns, unless DISPATCH_NOTARIZE_REQUIRED=1 (release.sh and
#     dispatch build sign). DISPATCH_NOTARY_RESULT records the actual status and submission ID even
#     when notarization fails or times out; its default is notary-result.json beside the app.
#   ad-hoc: a new identity to the keychain on every build, so the IDE's own "Safe Storage" key is dropped
#     (the next launch makes a fresh one instead of asking for the login password; it only guards the
#     IDE's own secrets).
set -euo pipefail
cd "$(dirname "$0")"
# Apple's timestamp service fails a signature now and then: every codesign below (osx-sign's too) goes through the
# wrapper in codesign-retry/, which signs that one file again after 10 s, at most 3 times (task-7mmi3)
export PATH="$PWD/codesign-retry:$PATH"
APP="${1:-VSCode-darwin-arm64/Dispatch IDE.app}"
[ -d "$APP" ] || { echo "no app at $APP" >&2; exit 1; }
# Keep the machine-readable result outside the sealed app, including failed/unfinished submissions.
RESULT="${DISPATCH_NOTARY_RESULT:-$(dirname "$APP")/notary-result.json}"
python3 - "$RESULT" <<'PY'
import json, os, pathlib, sys
p = pathlib.Path(sys.argv[1])
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps({"signed": False, "stapled": False,
                         "status": "Not submitted" if os.environ.get("DISPATCH_NOTARIZE", "1") == "1" else "Not requested"}) + "\n")
PY

IDENTITY="${DISPATCH_SIGNING_IDENTITY:-}"
ADHOC=0; [ "$IDENTITY" = "-" ] && { ADHOC=1; IDENTITY=""; }
if [ "$ADHOC" = 0 ] && [ -z "$IDENTITY" ] && [ -s "$HOME/.config/dispatch/signing-identity" ]; then
  IDENTITY="$(head -1 "$HOME/.config/dispatch/signing-identity")"
fi
IDS="$(security find-identity -v -p codesigning 2>/dev/null || true)"
if [ "$ADHOC" = 0 ] && [ -z "$IDENTITY" ]; then
  IDENTITY="$(printf '%s\n' "$IDS" | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
fi
if [ -n "$IDENTITY" ] && ! printf '%s\n' "$IDS" | grep -qF "\"$IDENTITY"; then
  echo "signing identity \"$IDENTITY\" is not a valid code signing certificate in the keychain; signing ad-hoc" >&2
  IDENTITY=""
fi

if [ -z "$IDENTITY" ]; then
  codesign --force --deep -s - "$APP"
  # only for the build itself: signing a copy elsewhere (a test) leaves the keychain alone
  # (and not for a build of remote-build.sh, DISPATCH_KEEP_KEYCHAIN=1: install.sh drops the key when it installs)
  [ -z "${DISPATCH_KEEP_KEYCHAIN:-}" ] && [ "$APP" = "VSCode-darwin-arm64/Dispatch IDE.app" ] && { security delete-generic-password -s "Dispatch IDE Safe Storage" >/dev/null 2>&1 || true; }
  echo "signed ad-hoc (no Developer ID Application certificate in the keychain)"
  exit 0
fi

# @electron/osx-sign cannot see inside archives. Sign the REH before the app seals its tarball.
# Match VS Code's build/darwin/sign-server.ts, including its Node/extension-host entitlements.
python3 - "$APP" "$IDENTITY" "$PWD/vscode/build/azure-pipelines/darwin/server-entitlements.plist" <<'PY'
import copy, os, pathlib, shutil, subprocess, sys, tarfile, tempfile
app, identity, entitlements = sys.argv[1:]
magic = {bytes.fromhex(n) for n in (
    "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca")}
for archive in sorted((pathlib.Path(app) / "Contents/Resources/app/server").glob("*darwin*.tar.gz")):
    with tempfile.TemporaryDirectory(prefix="dispatch-server-sign-") as tmp:
        root = pathlib.Path(tmp) / "unpacked"
        root.mkdir()
        # These are our build artifacts. Python preserves existing ._* archive entries as files;
        # macOS tar consumes them as AppleDouble metadata, which loses members when repacking.
        with tarfile.open(archive, "r:gz") as src:
            src.extractall(root, filter="fully_trusted")
        count = 0
        for p in sorted(root.rglob("*")):
            if p.is_symlink() or not p.is_file():
                continue
            with p.open("rb") as f:
                if f.read(4) not in magic:
                    continue
            print(f"Signing server binary: {p.relative_to(root)}", flush=True)
            subprocess.run(["codesign", "--force", "--sign", identity, "--options", "runtime", "--timestamp",
                            "--entitlements", entitlements, str(p)], check=True)
            subprocess.run(["codesign", "--verify", "--strict", str(p)], check=True)
            count += 1
        # Reuse the original member order and metadata, including modes, owners and link targets.
        # Only signed file sizes/content change. Do not add macOS AppleDouble resource-fork files.
        packed = pathlib.Path(tmp) / "signed.tar.gz"
        with tarfile.open(archive, "r:gz") as src, tarfile.open(packed, "w:gz") as dst:
            for member in src:
                info = copy.deepcopy(member)
                if member.isfile():
                    p = root / member.name
                    info.size = p.stat().st_size
                    info.pax_headers.pop("size", None)
                    with p.open("rb") as f:
                        dst.addfile(info, f)
                else:
                    dst.addfile(info)
        shutil.copystat(archive, packed)
        # The temporary directory may be on a different volume from staging.
        with tempfile.NamedTemporaryFile(dir=archive.parent, prefix=".signed-server-", delete=False) as f:
            replacement = pathlib.Path(f.name)
        try:
            shutil.copy2(packed, replacement)
            os.replace(replacement, archive)
        finally:
            replacement.unlink(missing_ok=True)
        print(f"Signed {count} Mach-O files in {archive}", flush=True)
PY

NODE="$(cat vscode/.nvmrc)"
node_run() { if [ "$(node -v 2>/dev/null)" = "v$NODE" ]; then "$@"; else fnm exec --using "$NODE" "$@"; fi; }
# @electron/osx-sign, the version VS Code's build pins (vscode/build/package-lock.json): from this checkout's
# vscode/build/node_modules when it has them (npm ci there), else installed once into .cache (a checkout that only
# signs builds fetched from the mini never ran npm ci)
OSX_SIGN="$PWD/vscode/build/node_modules/@electron/osx-sign"
if [ ! -f "$OSX_SIGN/dist/index.js" ]; then
  v="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["packages"]["node_modules/@electron/osx-sign"]["version"])' vscode/build/package-lock.json)"
  C="$PWD/.cache/osx-sign-$v"
  [ -f "$C/node_modules/@electron/osx-sign/dist/index.js" ] || node_run npm install --prefix "$C" --no-save --no-audit --no-fund --silent "@electron/osx-sign@$v" >/dev/null
  OSX_SIGN="$C/node_modules/@electron/osx-sign"
fi
DISPATCH_OSX_SIGN="$OSX_SIGN" node_run node sign.mjs "$APP" "$IDENTITY"
codesign --verify --deep --strict "$APP"

python3 - "$APP" "$RESULT" <<'PY'
import json, os, pathlib, subprocess, sys, tempfile
app, result_path = sys.argv[1], pathlib.Path(sys.argv[2])
result = json.loads(result_path.read_text())
result["signed"] = True

def save():
    result_path.write_text(json.dumps(result, indent=2) + "\n")

save()
if os.environ.get("DISPATCH_NOTARIZE", "1") != "1":
    sys.exit(0)
profile = os.environ.get("DISPATCH_NOTARY_PROFILE", "dispatch-notary")

def notary(*args):
    p = subprocess.run(["xcrun", "notarytool", *args, "--keychain-profile", profile,
                        "--output-format", "json"], stdout=subprocess.PIPE, text=True)
    print(p.stdout, end="", flush=True)
    try:
        data = json.loads(p.stdout)
    except ValueError:
        data = {}
    # A wait timeout or transport failure must not erase the submission ID from submit.
    for key in ("id", "status", "message"):
        if data.get(key):
            result[key] = data[key]
    save()
    return p.returncode

with tempfile.TemporaryDirectory(prefix="dispatch-notarize-") as tmp:
    archive = str(pathlib.Path(tmp) / "notarize.zip")
    subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, archive], check=True)
    rc = notary("submit", archive, "--no-wait")
    if rc == 0 and result.get("id"):
        # submit acknowledges the upload but may omit status. Keep that acknowledgement if
        # info is unavailable; otherwise persist Apple's current state before the long wait.
        if result.get("status") == "Not submitted":
            result["status"] = "Submitted"
            save()
        notary("info", result["id"])
        print(f"Waiting for notarization: {result['id']}", flush=True)
        notary("wait", result["id"], "--timeout", os.environ.get("DISPATCH_NOTARY_TIMEOUT", "30m"))

if result.get("status") != "Accepted" or not result.get("id"):
    if result.get("id") and result.get("status") in ("Invalid", "Rejected"):
        log = str(result_path.with_suffix(".log.json"))
        p = subprocess.run(["xcrun", "notarytool", "log", result["id"], "--keychain-profile", profile, log])
        if p.returncode == 0:
            result["log"] = log
            save()
    print(f"Notarization {result.get('status')}, submission {result.get('id', 'none')}; "
          f"signed but not notarized. Result: {result_path}", file=sys.stderr)
    sys.exit(1 if os.environ.get("DISPATCH_NOTARIZE_REQUIRED") == "1" else 0)

subprocess.run(["xcrun", "stapler", "staple", app], check=True)
subprocess.run(["xcrun", "stapler", "validate", app], check=True)
result["stapled"] = True
save()
subprocess.run(["spctl", "--assess", "--type", "execute", "-vv", app], check=True)
print(f"Notarized and stapled: {app} (submission {result['id']})")
PY
