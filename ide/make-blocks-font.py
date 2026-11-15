#!/usr/bin/env python3
"""Dispatch's block symbols as an icon font (kanban design/identity/bold A4, proto-icons.html).

The glyphs are drawn here on codicon's 16 px grid from the same shapes as the prototype: rounded
blocks, 1.5 px lines with round ends, and for the seven states a coloured block with its mark cut
out (the mark shows the row behind it, so it reads on any background and for anyone who can't tell
the colours apart). Lines are turned into outlines and the cut-outs subtracted with skia-pathops, so
every glyph is one plain outline that renders like a codicon (currentColor, the font's size and
baseline). Writes, into vscode/src/vs/sessions/contrib/dispatchBlocks/browser/media/:

    dispatch-blocks.ttf          the font, glyphs at U+E900 upwards in GLYPHS order
    dispatchBlockGlyphs.css      .codicon-dispatch-<name>::before (and on .monaco-icon-label, tab icons) { font-family; content }
    glyphs/<name>.svg            each glyph as a filled SVG (for review and for the delivery page)

and the list of names into ../dispatchBlockGlyphs.ts. Needs fontTools and skia-pathops:

    python3 -m venv /tmp/fontenv && /tmp/fontenv/bin/pip install fonttools skia-pathops
    /tmp/fontenv/bin/python make-blocks-font.py     # then commit what it rewrote under vscode/
"""
import math
import os
import sys

import pathops
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(HERE, "vscode", "src", "vs", "sessions", "contrib", "dispatchBlocks", "browser")
MEDIA = os.path.join(BASE, "media")
UPEM = 1600          # 100 units a pixel; codicon's box: ascent = em, descent 0
FIRST = 0xE900
LINE = 1.5           # DESIGN.md: icons are 1.5 px lines with round ends
MARK = 1.8           # the mark cut out of a state block


def rrect(x, y, w, h, r):
    r = min(r, w / 2, h / 2)
    return (f"M{x + r} {y}H{x + w - r}A{r} {r} 0 0 1 {x + w} {y + r}V{y + h - r}A{r} {r} 0 0 1 {x + w - r} {y + h}"
            f"H{x + r}A{r} {r} 0 0 1 {x} {y + h - r}V{y + r}A{r} {r} 0 0 1 {x + r} {y}Z")


def circle(cx, cy, r):
    return f"M{cx - r} {cy}A{r} {r} 0 1 0 {cx + r} {cy}A{r} {r} 0 1 0 {cx - r} {cy}Z"


BLOCK = rrect(2, 2, 12, 12, 3.6)          # a state: the colour is the state
FRAME = rrect(2.5, 2.5, 11, 11, 3.2)      # a thing or a place: the block as a line


def rays():
    d = ""
    for i in range(10):
        a = i * math.pi / 5 + .3
        r1, r2 = 2.1, (5 if i % 2 else 6.2)
        d += f"M{8 + r1 * math.cos(a):.2f} {8 + r1 * math.sin(a):.2f}L{8 + r2 * math.cos(a):.2f} {8 + r2 * math.sin(a):.2f}"
    return d


# name -> [(op, d, width)]: fill adds the shape, line adds a 1.5 px line, cut / cutline take it away
GLYPHS = {
    # states (seven, plus a plan step's "now")
    "working": [("fill", BLOCK)],
    "waiting": [("fill", BLOCK), ("cut", circle(8, 8, 1.9))],
    "done": [("fill", BLOCK), ("cutline", "M5.2 8.3l1.9 1.9 3.7-3.9", MARK)],
    "handoff": [("fill", BLOCK), ("cutline", "M5 8h5.6M8.6 5.8L10.8 8l-2.2 2.2", MARK)],
    "stopped": [("fill", BLOCK), ("cutline", "M5.4 8h5.2", MARK)],
    "todo": [("line", rrect(2.75, 2.75, 10.5, 10.5, 3.2), 1.4)],
    "sub-agent": [("fill", rrect(3, 3, 10, 10, 3))],
    "step-now": [("line", rrect(2.75, 2.75, 10.5, 10.5, 3.2), 1.5), ("fill", rrect(5.4, 5.4, 5.2, 5.2, 1.5))],
    # things Dispatch keeps track of
    "assistant": [("fill", rrect(2, 2, 5.4, 5.4, 1.7)), ("fill", rrect(8.6, 2, 5.4, 5.4, 1.7)),
                  ("fill", rrect(2, 8.6, 5.4, 5.4, 1.7)), ("fill", circle(11.3, 11.3, 2.5))],
    "task": [("line", FRAME), ("line", "M5.6 6.3h4.8M5.6 9.7h2.8")],
    "plan": [("fill", rrect(1.6, 6.1, 3.8, 3.8, 1.1)), ("fill", rrect(6.1, 6.1, 3.8, 3.8, 1.1)),
             ("line", rrect(10.85, 6.35, 3.3, 3.3, 1))],
    "delivery": [("line", rrect(2.5, 3, 11, 10.5, 2.6)), ("line", "M2.5 6.6h11M6.6 6.6v2.3h2.8V6.6")],
    "delivery-new": [("line", rrect(2.5, 3, 11, 10.5, 2.6)), ("line", "M2.5 6.6h11M6.6 6.6v2.3h2.8V6.6"),
                     ("cut", circle(13, 3.3, 3.2)), ("fill", circle(13, 3.3, 2.3))],
    "pass-on": [("line", rrect(1.8, 3.5, 8, 9, 2.6)), ("line", "M6.8 8h7M11.6 5.6L14 8l-2.4 2.4")],
    # devices
    "macbook": [("line", rrect(3, 3.5, 10, 7, 1.6)), ("line", "M1.5 12.6h13")],
    "mac-mini": [("line", rrect(2, 5, 12, 6, 2)), ("line", "M5 13.2h6"), ("fill", circle(4.7, 8, .75))],
    "iphone": [("line", rrect(4.5, 1.5, 7, 13, 2.2)), ("line", "M7.1 12.4h1.8")],
    # places and actions
    "folder": [("line", "M2.5 5.2c0-.9.7-1.6 1.6-1.6h2.3c.5 0 .9.2 1.2.6l.6.8h3.7c.9 0 1.6.7 1.6 1.6v4.7c0 .9-.7 1.6-1.6 1.6H4.1c-.9 0-1.6-.7-1.6-1.6z")],
    "automations": [("line", FRAME), ("line", "M8 5.3V8l1.9 1.2")],
    "chats": [("line", "M5 2.75h6a2.5 2.5 0 0 1 2.5 2.5v3.5a2.5 2.5 0 0 1-2.5 2.5H7.6L4.8 13.3v-2.1A2.5 2.5 0 0 1 2.5 8.75v-3.5A2.5 2.5 0 0 1 5 2.75z")],
    "knowledge": [("line", FRAME), ("line", "M9.6 2.5v4.7L8.1 6.1 6.6 7.2V2.5")],
    "settings": [("line", "M2.5 5.5h11M2.5 10.5h11"), ("cut", rrect(3.45, 3.05, 4.9, 4.9, 1.6)), ("cut", rrect(7.85, 8.05, 4.9, 4.9, 1.6)),
                 ("line", rrect(4.2, 3.8, 3.4, 3.4, 1)), ("line", rrect(8.6, 8.8, 3.4, 3.4, 1))],
    "editor": [("line", FRAME), ("line", "M6.6 6.1L4.9 8l1.7 1.9M9.4 6.1L11.1 8 9.4 9.9")],
    "new": [("line", FRAME), ("line", "M8 5.6v4.8M5.6 8h4.8")],
    "plus": [("line", "M8 3.5v9M3.5 8h9")],
    "search": [("line", circle(7.2, 7.2, 4.2)), ("line", "M10.4 10.4l3.1 3.1")],
    "filter": [("line", "M3 4.5h10M5 8h6M7 11.5h2")],
    "sidebar": [("line", rrect(2, 3, 12, 10, 2.6)), ("line", "M6.4 3v10")],
    "right-panel": [("line", rrect(2, 3, 12, 10, 2.6)), ("line", "M9.6 3v10")],
    "theme": [("line", circle(8, 8, 5.5)), ("fill", "M8 2.5A5.5 5.5 0 0 1 8 13.5Z")],
    "permission": [("line", "M8 2.2l4.6 1.7v3.5c0 3-1.9 5.2-4.6 6.3-2.7-1.1-4.6-3.3-4.6-6.3V3.9z")],
    "branch": [("line", circle(5, 4, 1.5)), ("line", circle(5, 12, 1.5)), ("line", circle(11, 6, 1.5)), ("line", "M5 5.5v5M11 7.5c0 2.2-2.2 2.8-6 3")],
    "send": [("line", "M8 12.5V4M4.5 7.5L8 4l3.5 3.5")],
    "stop": [("fill", rrect(4.5, 4.5, 7, 7, 2.2))],
    "open": [("line", "M6 3.5H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5v-2M9 2.5h4.5V7M13.5 2.5L8 8")],
    "claude": [("line", rays(), 1.6)],
    # added later: new glyphs go at the end so the code points above stay put
    "now": [("line", FRAME), ("fill", rrect(5.6, 5.6, 4.8, 4.8, 1.4))],
    # a design proposal: two blocks side by side, one to pick (right panel tabs, task-fif4i)
    "proposal": [("line", rrect(1.75, 3, 5.4, 10, 1.9)), ("line", rrect(8.85, 3, 5.4, 10, 1.9))],
    # a prototype you can click: a block with a pointer in it
    "prototype": [("line", FRAME), ("fill", "M6 5.2L6 11.4L7.7 9.9L8.9 12.3L10.1 11.7L8.9 9.4L11 9.2Z")],
}


def to_path(d):
    p = pathops.Path()
    parse_path(d, p.getPen())
    return p


def outline(spec):
    """One pathops.Path for a glyph spec: the union of what it adds minus what it cuts, in order."""
    acc = pathops.Path()
    for op, d, *w in spec:
        p = to_path(d)
        if op in ("line", "cutline"):
            p.stroke(w[0] if w else LINE, pathops.LineCap.ROUND_CAP, pathops.LineJoin.ROUND_JOIN, 4)
            p.convertConicsToQuads()
        else:
            p.fillType = pathops.FillType.WINDING
        acc = pathops.op(acc, p, pathops.PathOp.DIFFERENCE if op.startswith("cut") else pathops.PathOp.UNION, fix_winding=True)
    acc.simplify(fix_winding=True)
    return acc


def main():
    names = list(GLYPHS)
    order = [".notdef"] + names
    fb = FontBuilder(UPEM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({FIRST + i: n for i, n in enumerate(names)})
    glyphs = {".notdef": TTGlyphPen(None).glyph()}
    metrics = {".notdef": (UPEM, 0)}
    os.makedirs(os.path.join(MEDIA, "glyphs"), exist_ok=True)
    for name in names:
        path = outline(GLYPHS[name])
        pen = TTGlyphPen(None)
        # SVG y runs down, the font's up: flip around the 16 px box and scale to font units
        path.draw(Cu2QuPen(TransformPen(pen, (100, 0, 0, -100, 0, UPEM)), max_err=1, reverse_direction=True))
        glyph = pen.glyph()
        glyph.recalcBounds(None)
        glyphs[name] = glyph
        metrics[name] = (UPEM, getattr(glyph, "xMin", 0))
        svg = SVGPathPen(None)
        path.draw(svg)
        with open(os.path.join(MEDIA, "glyphs", f"{name}.svg"), "w", encoding="utf-8") as f:
            f.write(f'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="{svg.getCommands()}"/></svg>\n')
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=UPEM, descent=0)
    fb.setupNameTable({"familyName": "dispatch-blocks", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=UPEM, sTypoDescender=0, usWinAscent=UPEM, usWinDescent=0)
    fb.setupPost()
    out = os.path.join(MEDIA, "dispatch-blocks.ttf")
    fb.save(out)

    css = ["/* generated by make-blocks-font.py (dispatch-ide repository): one rule per glyph of dispatch-blocks.ttf */", ""]
    for i, n in enumerate(names):
        # a tab's or a label's icon is a class on .monaco-icon-label without .codicon: both wear the glyph
        css.append(f'.codicon.codicon-dispatch-{n}::before, .monaco-icon-label.codicon-dispatch-{n}::before {{ font-family: "dispatch-blocks" !important; content: "\\{FIRST + i:x}" !important; }}')
    with open(os.path.join(MEDIA, "dispatchBlockGlyphs.css"), "w", encoding="utf-8") as f:
        f.write("\n".join(css) + "\n")
    ts = ["/*---------------------------------------------------------------------------------------------",
          " *  Dispatch IDE: generated by make-blocks-font.py (dispatch-ide repository). The glyphs of",
          " *  media/dispatch-blocks.ttf, in font order; each is the product icon `dispatch-<name>`.",
          " *--------------------------------------------------------------------------------------------*/",
          "",
          "export const DISPATCH_BLOCK_GLYPHS = [",
          *[f"\t'{n}'," for n in names],
          "] as const;",
          "",
          "export type DispatchBlockGlyph = typeof DISPATCH_BLOCK_GLYPHS[number];",
          ""]
    with open(os.path.join(BASE, "dispatchBlockGlyphs.ts"), "w", encoding="utf-8") as f:
        f.write("\n".join(ts))
    print(f"{out}: {len(names)} glyphs U+{FIRST:04X}..U+{FIRST + len(names) - 1:04X} ({os.path.getsize(out)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
