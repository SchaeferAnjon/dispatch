# -*- coding: utf-8 -*-
"""`dispatch annotate <screenshot> -o <out.png> --box x,y,w,h … --note "…" …`: the「在哪」picture
every delivery README starts with. Numbered red boxes on the screenshot, and under it one line
per box, "1  what it is · where · how to use it", so a person who opens the README sees at once
where the thing lives in the app. Red is only the boxes and their numbers on the screenshot; the
numbers of the lines under it are black dots (DESIGN.md「第四处颜色」).

Coordinates are pixels of the screenshot (a Retina capture is twice the points). Needs Pillow.
Fonts are files that are really on this Mac: SF for the numbers, PingFang (under
/System/Library/AssetsV2 on current macOS) or Hiragino Sans GB for the lines; none found is an error,
never a silent fallback to a font without Chinese (that drew the arrow as a tofu box).

Next to the picture goes `<name>.json` = {image, size, items: [{n, box: [x,y,w,h], what, where, how}]}:
the Agents window's Docs tab reads it for the "Where to look" viewport and the numbered lines under it.
`--boxes-only` draws the boxes and numbers without the lines under the picture (they then live in
the README's numbered list).
"""
import glob, json, os

RED = (220, 38, 38)  # #dc2626, DESIGN.md「第四处颜色」: the boxes on the screenshot
INK = (41, 37, 36)  # the caption's text colour: its numbers are black dots
TEXT_FONTS = ("/System/Library/AssetsV2/com_apple_MobileAsset_Font*/*/AssetData/PingFang.ttc",
              "/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/Hiragino Sans GB.ttc",
              "/Library/Fonts/Arial Unicode.ttf", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")
NUMBER_FONTS = ("/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Helvetica.ttc") + TEXT_FONTS


def parse_box(spec):
    parts = [p for p in spec.replace(" ", "").split(",") if p]
    if len(parts) != 4:
        raise ValueError(f"a box is x,y,w,h in pixels: {spec}")
    x, y, w, h = (int(float(p)) for p in parts)
    if w <= 0 or h <= 0:
        raise ValueError(f"a box needs a width and a height: {spec}")
    return x, y, w, h


def font_path(candidates=TEXT_FONTS):
    """The first font file of `candidates` (globs) that is really here."""
    for pat in candidates:
        for path in sorted(glob.glob(pat)):
            if os.path.isfile(path):
                return path
    raise ValueError("no font with Chinese found (looked for PingFang, Hiragino Sans GB): " + ", ".join(candidates))


def _font(size, candidates=TEXT_FONTS):
    from PIL import ImageFont
    return ImageFont.truetype(font_path(candidates), size)


def split_note(note):
    parts = [p.strip() for p in (note or "").split(" · ")]
    return {"what": parts[0] if parts else "", "where": parts[1] if len(parts) > 1 else "", "how": " · ".join(parts[2:])}


def picture_json(out, size, boxes, notes):
    """The boxes and lines next to the picture, `<out without .png>.json`."""
    items = []
    for i, b in enumerate(boxes, 1):
        items.append({"n": i, "box": list(b), **split_note(notes[i - 1] if i - 1 < len(notes) else "")})
    path = os.path.splitext(out)[0] + ".json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"image": os.path.basename(out), "size": list(size), "items": items}, f, ensure_ascii=False, indent=1)
    return path


def annotate(src, out, boxes, notes, title="", boxes_only=False):
    """Draw it; returns {"out", "width", "height", "boxes"}."""
    from PIL import Image, ImageDraw
    if not boxes:
        raise ValueError("give at least one --box")
    img = Image.open(src).convert("RGB")
    W, H = img.size
    scale = max(1.0, W / 1600)  # line widths and type grow with a Retina capture
    lw, r = max(3, int(3 * scale)), int(16 * scale)
    num_font = _font(int(20 * scale), NUMBER_FONTS)
    note_font = None if boxes_only else _font(int(19 * scale))
    draw = ImageDraw.Draw(img)
    for i, (x, y, w, h) in enumerate(boxes, 1):
        draw.rounded_rectangle([x, y, x + w, y + h], radius=int(6 * scale), outline=RED, width=lw)
        cx, cy = max(r, x - r // 2), max(r, y - r // 2)  # the number sits on the box's top left corner
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=RED)
        draw.text((cx, cy), str(i), fill="white", font=num_font, anchor="mm")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    if boxes_only:
        img.save(out)
        js = picture_json(os.path.abspath(out), (W, H), boxes, notes)
        return {"ok": True, "out": os.path.abspath(out), "json": js, "width": W, "height": H, "boxes": len(boxes)}
    lines = []
    if title:
        lines.append(("", title))
    for i in range(len(boxes)):
        lines.append((str(i + 1), notes[i] if i < len(notes) else ""))
    pad, row = int(18 * scale), int(34 * scale)
    bar = pad * 2 + row * len(lines)
    canvas = Image.new("RGB", (W, H + bar), (250, 248, 245))
    canvas.paste(img, (0, 0))
    d = ImageDraw.Draw(canvas)
    y = H + pad
    for num, text in lines:
        x = pad
        if num:
            rr = int(12 * scale)
            d.ellipse([x, y + row // 2 - rr, x + 2 * rr, y + row // 2 + rr], fill=INK)
            d.text((x + rr, y + row // 2), num, fill="white", font=_font(int(15 * scale), NUMBER_FONTS), anchor="mm")
            x += 2 * rr + int(10 * scale)
        d.text((x, y + row // 2), text, fill=INK, font=note_font if num else _font(int(21 * scale)), anchor="lm")
        y += row
    canvas.save(out)
    js = picture_json(os.path.abspath(out), (W, H + bar), boxes, notes)
    return {"ok": True, "out": os.path.abspath(out), "json": js, "width": W, "height": H + bar, "boxes": len(boxes)}


def where_json(src, out, boxes, notes):
    """00-where.json next to the picture, for a delivery page (`dispatch deliver`): the boxes on the
    real screenshot (the page draws them itself and zooms to each), each number's line split into
    what · where · how. The screenshot is copied next to it when it lives elsewhere."""
    import json, shutil
    folder = os.path.dirname(os.path.abspath(out))
    src = os.path.abspath(src)
    if os.path.dirname(src) != folder:
        dest = os.path.join(folder, os.path.basename(src))
        if os.path.abspath(dest) != src:
            shutil.copyfile(src, dest)
        src = dest
    from PIL import Image
    with Image.open(src) as im:
        size = list(im.size)
    items = []
    for i, (x, y, w, h) in enumerate(boxes, 1):
        parts = [p.strip() for p in (notes[i - 1] if i - 1 < len(notes) else "").split(" · ")]
        items.append({"n": i, "box": [x, y, w, h], "what": parts[0] if parts else "", "where": parts[1] if len(parts) > 1 else "",
                      "how": " · ".join(parts[2:])})
    path = os.path.join(folder, "00-where.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"image": os.path.basename(src), "size": size, "items": items}, f, ensure_ascii=False, indent=1)
    return path


def cmd(a, out_fn):
    try:
        boxes = [parse_box(b) for b in a.box or []]
        r = annotate(os.path.expanduser(a.src), os.path.expanduser(a.out), boxes, a.note or [], a.title or "", boxes_only=bool(getattr(a, "boxes_only", False)))
        if getattr(a, "where", False):
            r["where"] = where_json(os.path.expanduser(a.src), os.path.expanduser(a.out), boxes, a.note or [])
    except (ValueError, OSError, ImportError) as e:
        raise SystemExit(f"annotate: {e}")
    return out_fn(r, a.json, lambda r: print(r["out"]))
