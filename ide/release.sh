#!/bin/bash
# Publish a built Dispatch IDE as an update: zip it, hash it, and rewrite the static update feed.
#
# The app's updater (vscode/src/vs/platform/update, Dispatch's static feed) asks
#   <updateUrl>/api/update/darwin-arm64/<quality>/<commit>
# where commit is the running build's id (build.sh, BUILD_SOURCEVERSION); the version it shows ("Dispatch 0.9.5 is
# ready") is product.json's dispatchVersion. The feed is plain files: for every
# build released before, a JSON naming the newest zip ({url, name, version, productVersion, hash,
# sha256hash, timestamp}, and whatsNew: the new build's What's new for the tooltip's In this update);
# nothing for the newest build itself (404 = no update). So it can be served by
# anything static: GitHub Pages (updateUrl in vscode/product.json), or `python3 -m http.server` for a local test.
#
#   ./release.sh [path/to/Dispatch IDE.app]
#
# UPDATE_DIR     the feed folder (default ./updates; the zips go in its releases/)
# DISPATCH_RELEASE_REPO  owner/name of the repository whose Releases hold the zips (the public one, e.g.
#                SchaeferAnjon/dispatch); no default yet, set it (or DOWNLOAD_BASE)
# DOWNLOAD_BASE  where the zip will be downloadable (default: this build's GitHub Release,
#                https://github.com/$DISPATCH_RELEASE_REPO/releases/download/ide-<short id>)
# ZIP            a zip of this app made already (app/scripts/release.sh passes the release's own zip): the feed names
#                and hashes it as it is, and nothing is copied into releases/
# Nothing is uploaded: the script prints the gh command for the release and the folder to publish (the feed is
# served from the public repository's Pages, docs/updates/, which updateUrl in vscode/product.json names).
set -euo pipefail
cd "$(dirname "$0")"
APP="${1:-VSCode-darwin-arm64/Dispatch IDE.app}"
OUT="${UPDATE_DIR:-$PWD/updates}"
[ -d "$APP" ] || { echo "no app at $APP; run ./build.sh first" >&2; exit 1; }
PRODUCT="$APP/Contents/Resources/app/product.json"
read -r COMMIT QUALITY VERSION < <(python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); print(p.get("commit",""), p.get("quality",""), p.get("dispatchVersion") or json.load(open(sys.argv[2])).get("version",""))' "$PRODUCT" "$APP/Contents/Resources/app/package.json")
[ -n "$COMMIT" ] && [ -n "$QUALITY" ] || { echo "$PRODUCT has no commit or quality: build with the current build.sh" >&2; exit 1; }
SHORT="${COMMIT:0:10}"
ZIP_NAME="$(basename "${ZIP:-Dispatch-IDE-darwin-arm64-$SHORT.zip}")"
RELEASE_REPO="${DISPATCH_RELEASE_REPO:-}"
[ -n "$RELEASE_REPO" ] || [ -n "${DOWNLOAD_BASE:-}" ] || { echo "set DISPATCH_RELEASE_REPO (owner/name of the public repository) or DOWNLOAD_BASE" >&2; exit 1; }
BASE="${DOWNLOAD_BASE:-https://github.com/$RELEASE_REPO/releases/download/ide-$SHORT}"

mkdir -p "$OUT"
if [ -n "${ZIP:-}" ]; then
  [ -s "$ZIP" ] || { echo "no zip at $ZIP" >&2; exit 1; }
else
  mkdir -p "$OUT/releases"
  ZIP="$OUT/releases/$ZIP_NAME"
  # Squirrel.Mac wants the .app at the top of the zip; ditto keeps the signature's extended attributes
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP.part"
  mv "$ZIP.part" "$ZIP"
fi

python3 - "$OUT" "$ZIP" "$BASE/$ZIP_NAME" "$COMMIT" "$QUALITY" "$VERSION" "$APP/Contents/Resources/app/whats-new" <<'EOF'
import base64, hashlib, io, json, os, sys, time
out, zip_path, url, commit, quality, version, whats_new_dir = sys.argv[1:]


def in_this_update(folder):
    """The new build's What's new (src/vs/sessions/contrib/dispatchWhatsNew) for the update tooltip's In this update:
    title, where, and a 96×64 thumbnail of the feature's mark (its box outlined) when Pillow is there."""
    try:
        data = json.load(open(os.path.join(folder, "whats-new.json")))
    except (OSError, ValueError):
        return []
    try:
        from PIL import Image
    except ImportError:
        Image = None
    items = []
    for f in data.get("features", [])[:5]:
        if not f.get("title"):
            continue
        item = {"title": f["title"], "where": f.get("where", "")}
        if Image and f.get("image"):
            try:
                im = Image.open(os.path.join(folder, f["image"])).convert("RGB")
                box, drawn, color = None, False, (220, 38, 38)
                if isinstance(f.get("marks"), str):
                    shown = json.load(open(os.path.join(folder, f["marks"])))
                    marks = shown.get("marks", [])
                    drawn = shown.get("drawn") is True
                    want = [m for m in marks if m.get("n") == f.get("mark")] or marks[:1]
                    box = want[0]["box"] if want else None
                    if want and want[0].get("color") == "green":
                        color = (22, 163, 74)
                if box:
                    x, y, w, h = box
                    pad = 48
                    x0, y0, x1, y1 = x - pad, y - pad - 40, x + w + pad, y + h + pad
                    cw, ch = x1 - x0, y1 - y0
                    if cw / ch < 1.5:
                        x0 -= (ch * 1.5 - cw) / 2
                        cw = ch * 1.5
                    else:
                        y0 -= (cw / 1.5 - ch) / 2
                        ch = cw / 1.5
                    cw, ch = min(cw, im.width), min(ch, im.height)
                    x0 = max(0, min(x0, im.width - cw))
                    y0 = max(0, min(y0, im.height - ch))
                    # what a 96×64 cover of that region shows (the IDE's own thumbnail does the same)
                    k = max(96 / cw, 64 / ch)
                    cw, ch = 96 / k, 64 / k
                    if not drawn:
                        # the picture is a raw screenshot: outline its box, 1.5 px once it is 96 wide
                        from PIL import ImageDraw
                        ImageDraw.Draw(im).rectangle([x, y, x + w - 1, y + h - 1], outline=color, width=max(2, round(1.5 * min(cw, im.width) / 96)))
                    im = im.crop((int(x0), int(y0), int(x0 + cw), int(y0 + ch)))
                im.thumbnail((96, 64))
                buf = io.BytesIO()
                im.save(buf, "PNG", optimize=True)
                item["thumb"] = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
            except Exception:
                pass
        items.append(item)
    return items


data = open(zip_path, "rb").read()
stamp = int(time.time() * 1000)
entry = {
    "url": url,
    "name": f"{version} ({time.strftime('%Y-%m-%d %H:%M', time.localtime(stamp / 1000))})",
    "version": commit,
    "productVersion": f"{version} ({time.strftime('%Y-%m-%d %H:%M', time.localtime(stamp / 1000))})",
    "hash": hashlib.sha1(data).hexdigest(),
    "sha256hash": hashlib.sha256(data).hexdigest(),
    "timestamp": stamp,
}
entry["notes"] = commit  # Electron hands `notes` to VS Code as the update's version (the commit)
whats_new = in_this_update(whats_new_dir)
if whats_new:
    entry["whatsNew"] = whats_new  # the update tooltip's In this update, before the restart
index_path = os.path.join(out, "releases.json")
try:
    releases = json.load(open(index_path))
except FileNotFoundError:
    releases = []
releases = [r for r in releases if r.get("version") != commit] + [entry]
json.dump(releases, open(index_path, "w"), indent=2)
json.dump(entry, open(os.path.join(out, "latest.json"), "w"), indent=2)
feed = os.path.join(out, "api", "update", "darwin-arm64", quality)
os.makedirs(feed, exist_ok=True)
for r in releases:
    target = os.path.join(feed, r["version"])
    if r["version"] == commit:
        if os.path.exists(target):
            os.remove(target)  # the newest build has nothing newer
        continue
    json.dump(entry, open(target, "w"), indent=2)
print(f"feed: {len(releases) - 1} older build(s) now point at {commit[:10]} ({entry['productVersion']})")
print(f"zip: {zip_path}  sha256 {entry['sha256hash']}")
EOF
echo
echo "publish:"
echo "  gh release create ide-$SHORT \"$ZIP\" -R ${RELEASE_REPO:-<owner/name>} --title \"Dispatch IDE $VERSION ($SHORT)\""
echo "  then publish $OUT without releases/ (api/, latest.json, releases.json) as docs/updates/ of the public repository (updateUrl)"
