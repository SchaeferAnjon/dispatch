#!/usr/bin/env python3
"""Dispatch IDE's own icon font: engine marks that codicon does not have, drawn on codicon's 16 px grid
and kept as SVG next to the font (vscode/src/vs/workbench/contrib/chat/browser/agentSessions/media/).
Each SVG is one glyph made of axis-aligned rectangles (M/m, H/h, V/v, Z path commands; a rectangle
inside another is a hole, as with fill-rule="evenodd"); this writes dispatch-icons.ttf with the glyphs
at U+E900 upwards in GLYPHS order, so a mark renders like a codicon (currentColor, the font's size and
baseline). Needs fontTools (pip install fonttools).

    python3 make-icon-font.py        # rewrites the .ttf in ide/vscode; then commit it

Another feature's own font (its patch keeps its glyphs to itself):

    python3 make-icon-font.py --media <dir under vscode/src> --glyphs hermes,openclaw --name dispatch-agent-marks
"""
import os
import re
import sys

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

HERE = os.path.dirname(os.path.abspath(__file__))
MEDIA = os.path.join(HERE, "vscode", "src", "vs", "workbench", "contrib", "chat", "browser", "agentSessions", "media")
GLYPHS = ["opencode"]            # U+E900, U+E901, …
UPEM = 1600                      # 100 units per pixel of the 16 px grid; codicon's box: ascent = em, descent 0
FIRST = 0xE900


def rects(svg_text):
    """Every closed subpath of every path as its bounding rectangle (x0, y0, x1, y1), SVG pixels, y down."""
    out = []
    for d in re.findall(r'\sd="([^"]+)"', svg_text):
        tokens = re.findall(r"[MmHhVvZz]|-?\d*\.?\d+", d)
        x = y = 0.0
        start = (0.0, 0.0)
        pts = []
        cmd = None
        i = 0

        def flush():
            if len(pts) > 1:
                xs, ys = [p[0] for p in pts], [p[1] for p in pts]
                out.append((min(xs), min(ys), max(xs), max(ys)))

        while i < len(tokens):
            t = tokens[i]
            if t.isalpha():
                cmd = t
                i += 1
                if cmd in "Zz":
                    x, y = start          # closing returns to the subpath's first point
                    flush()
                    pts = []
                continue
            if cmd in "Mm":
                nx, ny = float(tokens[i]), float(tokens[i + 1])
                i += 2
                flush()
                x, y = (x + nx, y + ny) if cmd == "m" else (nx, ny)
                start = (x, y)
                pts = [(x, y)]
                cmd = "l" if cmd == "m" else "L"   # further pairs would be line-tos (not used here)
                continue
            v = float(t)
            i += 1
            if cmd == "h":
                x += v
            elif cmd == "H":
                x = v
            elif cmd == "v":
                y += v
            elif cmd == "V":
                y = v
            else:
                raise ValueError(f"only M/m H/h V/v Z paths are supported, got {cmd}")
            pts.append((x, y))
        flush()
    return out


def draw(pen, svg_text):
    """A rectangle inside an odd number of others is a hole: drawn counter-clockwise."""
    boxes = rects(svg_text)
    for k, (x0, y0, x1, y1) in enumerate(boxes):
        depth = sum(1 for j, (a0, b0, a1, b1) in enumerate(boxes) if j != k and a0 <= x0 and b0 <= y0 and a1 >= x1 and b1 >= y1)
        fx0, fx1 = round(x0 * 100), round(x1 * 100)
        top, bottom = round((16 - y0) * 100), round((16 - y1) * 100)
        corners = [(fx0, top), (fx1, top), (fx1, bottom), (fx0, bottom)]  # clockwise (y up): filled
        if depth % 2:
            corners.reverse()
        pen.moveTo(corners[0])
        for c in corners[1:]:
            pen.lineTo(c)
        pen.closePath()


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="Dispatch IDE's icon fonts from rectangle SVGs")
    ap.add_argument("--media", default=MEDIA, help="folder with <glyph>.svg; the .ttf is written there")
    ap.add_argument("--glyphs", default=",".join(GLYPHS), help="glyph names in code point order from U+E900")
    ap.add_argument("--name", default="dispatch-icons", help="font family and file name")
    a = ap.parse_args(argv)
    media = a.media if os.path.isabs(a.media) else os.path.join(HERE, a.media)
    names = [g for g in a.glyphs.split(",") if g]
    order = [".notdef"] + names
    fb = FontBuilder(UPEM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({FIRST + i: name for i, name in enumerate(names)})
    glyphs = {".notdef": TTGlyphPen(None).glyph()}
    lsb = {".notdef": 0}
    for name in names:
        with open(os.path.join(media, f"{name}.svg"), encoding="utf-8") as f:
            text = f.read()
        pen = TTGlyphPen(None)
        draw(pen, text)
        glyphs[name] = pen.glyph()
        # the left side bearing must be the glyph's xMin, or renderers shift the outline to x = 0
        lsb[name] = min(round(x0 * 100) for x0, _y0, _x1, _y1 in rects(text))
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({name: (UPEM, lsb[name]) for name in order})
    fb.setupHorizontalHeader(ascent=UPEM, descent=0)
    fb.setupNameTable({"familyName": a.name, "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=UPEM, sTypoDescender=0, usWinAscent=UPEM, usWinDescent=0)
    fb.setupPost()
    out = os.path.join(media, f"{a.name}.ttf")
    fb.save(out)
    print(f"{out}: {', '.join(f'U+{FIRST + i:04X} {n}' for i, n in enumerate(names))} ({os.path.getsize(out)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
