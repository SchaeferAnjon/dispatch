# -*- coding: utf-8 -*-
"""`dispatch deliver <task> --from DIR [--kind impl|proposal] [--title …] [--model "Opus 5.5 · high"] [--show]`:
the delivery page. One self-contained index.html made from what an Agent leaves in DIR, with the
delivery-page skill's template (agent/skills/delivery-page/template.html), then registered in the
project's Docs, hung on the task and, with --show, opened in Dispatch Agent's right panel.

What DIR holds (the skill's SKILL.md says the same to the Agent):

  notes.md        the words. `# title` in the user's words, the conclusion right under it, then `##`
                  sections. Known headings become components (在哪, 改了什么, 这一刻各做什么, 场景,
                  改前改后, 诊断, 方向 A: … / 方向 B: …, 推荐, 证据, 没做的); any other heading is a plain
                  section. Without notes.md a README.md is read the same way (it stays the source).
  *.png / *.jpg   the screenshots notes.md refers to (relative paths). `x.png#crop=x,y,w,h` shows one
                  region; a list of `- 平时: a.png 说明` lines is one strip of states.
  00-where.json   the「在哪」picture's boxes: {"image", "size": [w, h], "scale"?, "items": [{"n", "box":
                  [x, y, w, h], "what", "where", "how"}]} in picture pixels. Missing: made from steps.json's
                  marks (`dispatch ide e2e annotate`), else the picture is shown whole with its list.
  <pic>.boxes.json  numbered boxes drawn over <pic> (the 诊断 block): {"size": [w, h], "items":
                  [{"n", "box": [x, y, w, h], "color"?: "red" | "green"}]}.
  steps.json      the output of `dispatch ide e2e run`: build, scenario, marks, shots; goes into 证据.
  *.json / *.log  records a line can open in place: `- [性能记录](benchmark.json)`.

Every section reads like 在哪 (direction A「就地看图」, 2026-10-01): a list line that starts with a link to a picture
in the folder (`- [加账号](02-panel.png#mark=3)：…`, `- [验收帧](steps.json#step=5)`) zooms the section's own frame to
that numbered box (looked up in <pic>.boxes.json, 00-where.json, steps.json); a pair moves both pictures to the
same number; a strip of states is tabs over one frame, its boxes and lines going with their tab; a line to a
record opens it under the list; a line of words stays words. A box that is not there keeps the line (whole
picture) and prints a hint with the notes line.

  <name>.html     a prototype: the designer's own clickable HTML, in the same folder. `![说明](proto.html#size=1440x887)`
                  runs it inside the page (an iframe, scaled to the page's width, Fit / 1:1 / Enlarge, light and dark
                  following the page); a fenced block "```prototype 1440x887 名字" holds one inline. Inside a list of
                  labelled lines it becomes a state tab like a screenshot does.

Two kinds, one template: `impl` (在哪, what changed, scenes, before / after, evidence) registered as
交付 (the Docs tab's Delivered); `proposal` (diagnosis, two directions, recommendation with Choose A / B) registered as 设计 and
put into Waiting for you as a Decide, exactly like `dispatch flow finish`. Both get the same page: the header
(who made it, the conclusion as bullets), a contents column, the sections in the standard order (在哪 first;
证据, 没做的, 推荐 last), pairs and pictures laid out by the page's width. The Choose buttons record
the pick (`dispatch flow pick`) only when the page is opened by Dispatch Agent's right panel, through
dispatch-bridge's local page server (app/ide-ext/src/deliveryPage.ts); anywhere else they only show
what would happen.
"""
import datetime, html, json, os, re, struct, sys, time, unicodedata

import tasks_view as T
from lang import t as _t

D = None  # dispatch.py, bound by run()

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = "delivery-page"
GENERATOR = '<meta name="generator" content="dispatch deliver">'
IMG_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif")
KINDS = ("impl", "proposal")
DOC_KIND = {"impl": "交付", "proposal": "设计"}  # the Docs tab groups them: Delivered, Designs
ROLE = {"impl": "实现", "proposal": "出稿"}
ROLE_EN = {"impl": "Built by", "proposal": "Drafted by"}
STATE_WORDS = ("平时", "出现时", "点开后", "离线", "首次", "空", "加载", "出错", "悬停", "深色", "浅色")
# A task id is task- and a short hash, maybe with a child number (task-eidb, task-in7q.2). Not one inside a longer
# name (no-task-ids-for-user, design/task-model/, task-board.md), not a placeholder (task-xxxx) and not a word
# that often follows task- (task-board, task-graph).
_ID = (r"task-(?!x+\b)(?!(?:board|model|graph|ids?|list|tree|flow|workflow|page|tabs?|cards?|rows?|panel|view|things?)\b)"
       r"[a-z0-9]{3,8}(?:\.\d+)*")
TASK_ID = re.compile(r"(?<![A-Za-z0-9_/.-])" + _ID + r"(?![A-Za-z0-9_/-]|\.[A-Za-z])")
BRACKETED_ID = re.compile(r"\s*[（(]\s*" + _ID + r"\s*[)）]")
DIRECTION = re.compile(r"^(?:方向\s*|Direction\s+)?([A-F])\s*[:：.、·]\s*(.+?)\s*$", re.I)


class DeliverError(ValueError):
    pass


# ---------------------------------------------------------------- where things are

def skill_dir():
    """The delivery-page skill: next to the CLI in the repo or the app bundle, else the skill pool."""
    cands = [os.path.join(HERE, "..", "..", "agent", "skills", SKILL), os.path.join(HERE, "..", "agent", "skills", SKILL),
             os.path.join(HERE, "agent", "skills", SKILL)]
    pool = getattr(D, "POOL", "") if D is not None else ""
    if pool:
        cands.append(os.path.join(pool, SKILL))
    cands.append(os.path.join(os.path.expanduser("~"), ".dispatch", "skills", SKILL))
    for c in cands:
        if os.path.isfile(os.path.join(c, "template.html")):
            return os.path.abspath(c)
    raise DeliverError(_t("The delivery-page skill's template.html was not found (agent/skills/delivery-page)", "没找到 delivery-page 技能的 template.html（agent/skills/delivery-page）"))


def image_size(path):
    """(w, h) of a PNG / JPEG / GIF / WebP without Pillow; (0, 0) when unknown."""
    try:
        with open(path, "rb") as f:
            head = f.read(32)
            if head.startswith(b"\x89PNG\r\n\x1a\n"):
                return struct.unpack(">II", head[16:24])
            if head[:6] in (b"GIF87a", b"GIF89a"):
                return struct.unpack("<HH", head[6:10])
            if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
                if head[12:16] == b"VP8X":
                    return (int.from_bytes(head[24:27], "little") + 1, int.from_bytes(head[27:30], "little") + 1)
                return (0, 0)
            if head.startswith(b"\xff\xd8"):
                f.seek(2)
                while True:
                    b = f.read(1)
                    while b and b != b"\xff":
                        b = f.read(1)
                    while b == b"\xff":
                        b = f.read(1)
                    if not b:
                        return (0, 0)
                    marker = b[0]
                    seglen = struct.unpack(">H", f.read(2))[0]
                    if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                        f.read(1)
                        h, w = struct.unpack(">HH", f.read(4))
                        return (w, h)
                    f.seek(seglen - 2, 1)
    except (OSError, struct.error, IndexError):
        pass
    return (0, 0)


# ---------------------------------------------------------------- markdown (the subset notes use)

def esc(s):
    return html.escape(str(s if s is not None else ""), quote=True)


def scrub(text):
    """Task ids stay off the page: a bracketed one goes, a bare one becomes「任务」."""
    text = BRACKETED_ID.sub("", text)
    return TASK_ID.sub(_t("task", "任务"), text)


INLINE = re.compile(r"(`+)(.+?)\1|!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|__(.+?)__")


def inline(text, ctx=None):
    """Markdown inline → HTML (code, images, links, bold). Everything else is escaped."""
    out, pos = [], 0
    text = scrub(text)
    for m in INLINE.finditer(text):
        out.append(esc(text[pos:m.start()]))
        if m.group(1):
            out.append("<code>" + esc(m.group(2).strip()) + "</code>")
        elif m.group(4) is not None:
            out.append(ctx.picture(m.group(4), m.group(3)) if ctx else "")
        elif m.group(6) is not None:
            href = m.group(6)
            safe = href if re.match(r"^(https?:|mailto:|#|[\w./-])", href) and not href.lower().startswith("javascript:") else "#"
            out.append(f'<a href="{esc(safe)}">{inline(m.group(5))}</a>')
        else:
            out.append("<b>" + inline(m.group(7) or m.group(8), ctx) + "</b>")
        pos = m.end()
    out.append(esc(text[pos:]))
    return "".join(out)


IMG_ONLY = re.compile(r"^!\[([^\]]*)\]\(([^)\s]+)\)\s*(.*)$", re.S)
LIST_ITEM = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")


def blocks_of(lines):
    """Lines → [(kind, payload)]: heading (level, text), code (lang, text), table (rows), list
    (ordered, [item text]), para (text)."""
    out, i, n = [], 0, len(lines)
    while i < n:
        line = lines[i]
        s = line.strip()
        if not s:
            i += 1
            continue
        m = re.match(r"^(#{1,6})\s+(.*?)\s*#*\s*$", s)
        if m:
            out.append(("heading", (len(m.group(1)), m.group(2))))
            i += 1
            continue
        if s.startswith("```") or s.startswith("~~~"):
            fence, lang, body = s[:3], s[3:].strip(), []
            i += 1
            while i < n and not lines[i].strip().startswith(fence):
                body.append(lines[i])
                i += 1
            i += 1
            out.append(("code", (lang, "\n".join(body))))
            continue
        if s.startswith("|"):
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not all(re.match(r"^:?-{2,}:?$", c) for c in cells if c):
                    rows.append(cells)
                i += 1
            out.append(("table", rows))
            continue
        m = LIST_ITEM.match(line)
        if m:
            ordered = m.group(2)[0].isdigit()
            items, base = [], len(m.group(1))
            while i < n:
                mm = LIST_ITEM.match(lines[i])
                if mm and len(mm.group(1)) <= base + 1:
                    items.append(mm.group(3).strip())
                    i += 1
                    continue
                if lines[i].strip() and (lines[i].startswith("  ") or lines[i].startswith("\t")) and items:
                    items[-1] += " " + lines[i].strip()
                    i += 1
                    continue
                if not lines[i].strip() and items:
                    # a blank line, then a line indented under the item: still the same item (a loose list)
                    j = i
                    while j < n and not lines[j].strip():
                        j += 1
                    if j < n and (lines[j].startswith("  ") or lines[j].startswith("\t")) and not LIST_ITEM.match(lines[j]):
                        items[-1] += " " + lines[j].strip()
                        i = j + 1
                        continue
                break
            out.append(("list", (ordered, items)))
            continue
        para = [s]
        i += 1
        while i < n and lines[i].strip() and not re.match(r"^(#{1,6}\s|```|~~~|\|)", lines[i].strip()) and not LIST_ITEM.match(lines[i]):
            para.append(lines[i].strip())
            i += 1
        out.append(("para", " ".join(para) if not para[0].startswith("![") else "\n".join(para)))
    return out


# ---------------------------------------------------------------- reading the folder

def read_notes(src):
    for name in ("notes.md", "README.md"):
        p = os.path.join(src, name)
        if os.path.isfile(p):
            with open(p, encoding="utf-8") as f:
                return p, f.read()
    return "", ""


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def split_sections(text):
    """(title, lead blocks, [{title, blocks, subs: [{title, blocks}]}])."""
    title, lead, secs = "", [], []
    for kind, payload in blocks_of(text.splitlines()):
        if kind == "heading":
            level, t = payload
            if level == 1 and not title and not secs:
                title = t
                continue
            if level <= 2:
                secs.append({"title": t, "blocks": [], "subs": []})
                continue
            if secs:
                if level == 3:
                    secs[-1]["subs"].append({"title": t, "blocks": []})
                    continue
            else:
                lead.append(("para", "**" + t + "**"))
                continue
        target = (secs[-1]["subs"][-1]["blocks"] if secs and secs[-1]["subs"] else secs[-1]["blocks"]) if secs else lead
        target.append((kind, payload))
    return title, lead, secs


def section_role(title):
    t = re.sub(r"^[\d.\s]+", "", title or "").strip()
    low = t.lower()
    m = DIRECTION.match(t)
    if m:
        return "direction"
    if "在哪" in t or low.startswith("where"):
        return "where"
    if "各做什么" in t or "这一刻" in t or "moment" in low:
        return "moment"
    if "改前改后" in t or "对照" in t or "并排" in t or "before" in low or "side by side" in low:
        return "beforeafter"
    if t.startswith("诊断") or "diagnos" in low or "为什么看不懂" in t:
        return "diag"
    if t.startswith("推荐") or low.startswith("recommend"):
        return "recommend"
    if t.startswith("证据") or t.startswith("提交") or "怎么跑出来" in t or "evidence" in low:
        return "evidence"
    if "没做" in t or "还没" in t or "not done" in low or "未完成" in t:
        return "left"
    if t.startswith("场景") or low.startswith("scene"):
        return "scenes"
    if t.startswith("改了什么") or "what changed" in low:
        return "changed"
    return "plain"


class Page:
    """Everything the renderer needs about the folder: pictures, their sizes, which exist."""

    def __init__(self, src, dpr=0, notes="", where=None, steps=None):
        self.src = src
        self.dpr = dpr
        self.used, self.missing = [], []
        self.sizes = {}
        self.notes = notes or ""
        self.where_raw = where if isinstance(where, dict) else None
        self.steps = steps if isinstance(steps, dict) else None
        self.warnings = []

    def warn(self, msg, line=""):
        """A line that points somewhere it cannot: the page keeps its words, the author hears where it is."""
        at = ""
        if line:
            key = line.strip()[:40]
            for no, text in enumerate(self.notes.splitlines(), 1):
                if key and key in text:
                    at = _t(f"notes.md line {no}: ", f"notes.md 第 {no} 行：")
                    break
        w = _t("Note: ", "提示：") + at + msg
        if w not in self.warnings:
            self.warnings.append(w)

    def size(self, rel):
        if rel not in self.sizes:
            self.sizes[rel] = image_size(os.path.join(self.src, rel))
        return self.sizes[rel]

    def css_scale(self, rel):
        w, _ = self.size(rel)
        if self.dpr:
            return 1.0 / self.dpr
        return 0.5 if w >= 1800 else 1.0

    def narrow(self, rel):
        w, h = self.size(rel)
        if not w or not h:
            return False
        css_w = w * self.css_scale(rel)
        return css_w < 700 or h > w * 1.1

    def narrow_src(self, src):
        """Is this picture (its crop, when it has one) a tall or small one, the kind that takes words beside it?"""
        if self.is_page(src):
            self.check(src)
            return False
        path = self.check(src)
        _, crop = self.parse_src(src)
        if crop:
            cw, ch = crop[2], crop[3]
            return cw * self.css_scale(path) < 700 or ch > cw * 1.1
        return self.narrow(path)

    def parse_src(self, src):
        path, _, frag = src.partition("#")
        crop = None
        m = re.search(r"crop=(\d+),(\d+),(\d+),(\d+)", frag)
        if m:
            crop = tuple(int(x) for x in m.groups())
        return path, crop

    def check(self, src):
        if re.match(r"^[a-z]+:", src):
            return src
        path, _ = self.parse_src(src)
        full = os.path.normpath(os.path.join(self.src, path))
        if not os.path.isfile(full):
            if path not in self.missing:
                self.missing.append(path)
        elif path not in self.used:
            self.used.append(path)
        return path

    def is_page(self, src):
        """A prototype (a designer's HTML file) rather than a picture."""
        return self.parse_src(src)[0].lower().endswith((".html", ".htm"))

    def picture(self, src, alt="", boxes=None):
        """<span class="pic"> with the picture; a crop shows only that region (click opens it whole). A prototype
        (.html) runs in a frame instead. `boxes` (a <pic>.boxes.json) draws its numbered boxes over it."""
        if self.is_page(src):
            return self.proto(src, alt)
        path = self.check(src)
        _, crop = self.parse_src(src)
        w, h = self.size(path)
        dims = f' width="{w}" height="{h}"' if w and h else ""
        cap = ""
        if crop and w and h:
            x, y, cw, ch = crop
            # a region is shown at its real size at most (a Retina capture at half its pixels)
            cap = f' style="--real:{round(cw * self.css_scale(path))}px"'
            inner = (f'<span class="crop" style="aspect-ratio:{cw}/{ch}"><img src="{esc(path)}" alt="{esc(alt)}" loading="lazy"{dims} '
                     f'style="width:{w / cw * 100:.3f}%;left:{-x / cw * 100:.3f}%;top:{-y / ch * 100:.3f}%"></span>')
        else:
            inner = f'<img src="{esc(path)}" alt="{esc(alt)}" loading="lazy"{dims}>'
        if boxes and w and h:
            inner += box_marks(boxes, w, h, crop if crop and w and h else None)
        return (f'<span class="pic" role="button" tabindex="0" aria-label="{esc(alt or path)}, open at full size" data-full="{esc(path)}" '
                f'data-w="{w}" data-h="{h}" data-s="{self.css_scale(path)}"{cap}>{inner}<span class="zoom" aria-hidden="true"><svg><use href="#i-enlarge"/></svg></span></span>')

    def proto_block(self, w, h, title, attr):
        """The frame around a prototype: title, Fit / 1:1, Enlarge; the page scales it to its width and keeps it clickable."""
        seg = ('<span class="sz" role="tablist" aria-label="Size"><button type="button" data-fit="fit" aria-selected="true">Fit</button>'
               '<button type="button" data-fit="one" aria-selected="false">1:1</button></span>')
        return (f'<div class="proto" data-w="{w}" data-h="{h}" {attr}><div class="pbar"><span class="pt">{esc(title)}</span>{seg}'
                '<button class="ghost enl-p" type="button"><svg><use href="#i-enlarge"/></svg>Enlarge</button>'
                '<button class="ghost cls-p" type="button"><svg><use href="#i-close"/></svg>Close</button></div>'
                f'<div class="pstage"><iframe title="{esc(title)}" sandbox="allow-scripts allow-forms"></iframe></div></div>')

    def proto(self, src, alt=""):
        """`![说明](proto.html#size=1440x887&scene=a1)`: the file in this folder, run in a frame. The page adds
        `#theme=light|dark` to its address and sends {type: "dispatch-theme"} when the theme changes; the
        prototype may send {type: "dispatch-size", w, h} to say how big it really is."""
        path = self.check(src)
        frag = src.partition("#")[2]
        m = re.search(r"size=(\d+)x(\d+)", frag)
        w, h = (int(m.group(1)), int(m.group(2))) if m else (PROTO_SIZE[0], PROTO_SIZE[1])
        return self.proto_block(w, h, alt or os.path.splitext(os.path.basename(path))[0], f'data-src="{esc(path + ("#" + frag if frag else ""))}"')

    def proto_inline(self, lang, text):
        """A fenced block "```prototype 1440x887 名字": the HTML (a whole document or a fragment) run in a frame."""
        words = lang.split()[1:]
        size = next((x for x in words if re.fullmatch(r"\d+x\d+", x)), "")
        w, h = (int(v) for v in size.split("x")) if size else PROTO_SIZE
        title = " ".join(x for x in words if x != size) or _t("prototype", "原型")
        return self.proto_block(w, h, title, f'data-doc="{esc(proto_doc(text))}"')


# What a prototype may rely on: the page's tokens (light, and dark under data-theme) and the theme message.
PROTO_SIZE = (1200, 800)
PROTO_LISTEN = ('<script>addEventListener("message",function(e){var d=e.data;if(d&&d.type==="dispatch-theme")'
                'document.documentElement.setAttribute("data-theme",d.theme)});var m=location.hash.match(/theme=(light|dark)/);'
                'if(m)document.documentElement.setAttribute("data-theme",m[1])</script>')
PROTO_BASE = ("<style>:root{--bg:#fff;--bg-2:#fafaf9;--sel:#f2f1f0;--text:#0c0a09;--text-2:#79716b;--hair:#e7e5e4;--chip:#f2f1f0;--chip-2:#f5f5f4;"
              "--fill:#252525;--fill-text:#fafaf9;--sans:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',system-ui,sans-serif;"
              "--mono:ui-monospace,'SF Mono',Menlo,monospace;color-scheme:light}"
              ":root[data-theme=dark]{--bg:#0c0a09;--bg-2:#1c1917;--sel:#292524;--text:#fafaf9;--text-2:#a6a09b;--hair:rgba(255,255,255,.1);"
              "--chip:#292524;--chip-2:rgba(255,255,255,.045);--fill:#fafaf9;--fill-text:#252525;color-scheme:dark}"
              "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 var(--sans)}</style>")


def proto_doc(text):
    """The document an inline prototype runs as: a fragment gets the tokens, a whole document only the theme listener."""
    if re.search(r"<html[\s>]", text, re.I):
        m = re.search(r"<head[^>]*>", text, re.I)
        return text[:m.end()] + PROTO_LISTEN + text[m.end():] if m else PROTO_LISTEN + text
    return '<!doctype html><html><head><meta charset="utf-8">' + PROTO_BASE + PROTO_LISTEN + "</head><body>" + text + "</body></html>"


# ---------------------------------------------------------------- components

def para_html(text, ctx):
    return "<p>" + inline(text, ctx) + "</p>"


def list_html(ordered, items, ctx, cls=""):
    tag = "ol" if ordered else "ul"
    c = f' class="{cls}"' if cls else ""
    return f"<{tag}{c}>" + "".join("<li>" + inline(it, ctx) + "</li>" for it in items) + f"</{tag}>"


def text_width(s):
    """How wide a cell's text is, a CJK character counting two."""
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in s.strip())


def table_html(rows, ctx):
    if not rows:
        return ""
    head, body = rows[0], rows[1:]
    # a column of short words (好 / 不好, 范围) stays on one line: beside a long sentence it would be squeezed to a
    # character a line
    short = {i for i in range(max(len(r) for r in rows)) if all(text_width(r[i]) <= 10 for r in rows if i < len(r))}
    # narrow (the right panel) the rows turn into cards: each cell carries its column's name for the label
    names = [re.sub(r"[`*_]", "", c).strip() for c in head]

    def cell(tag, i, c):
        cls = ' class="nw"' if i in short else ""
        name = f' data-h="{esc(names[i])}"' if tag == "td" and i < len(names) and names[i] else ""
        return f"<{tag}{cls}{name}>{inline(c, ctx)}</{tag}>"
    h = "".join(cell("th", i, c) for i, c in enumerate(head))
    b = "".join("<tr>" + "".join(cell("td", i, c) for i, c in enumerate(r)) + "</tr>" for r in body)
    return f'<div class="tblwrap"><table class="cmp"><thead><tr>{h}</tr></thead><tbody>{b}</tbody></table></div>'


def code_html(lang, text):
    lines = text.split("\n")
    pre = f'<pre class="term">{esc(scrub(text))}</pre>'
    if len(lines) > 24:
        first = next((l for l in lines if l.strip()), "")[:80]
        return f"<details><summary>{esc(scrub(first))} · {len(lines)} lines</summary>{pre}</details>"
    return pre


ITEM_IMG = re.compile(r"^(?:\*\*)?([^:：!*`]{1,16}?)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*(.*)$", re.S)
ITEM_LEAD_IMG = re.compile(r"^!\[([^\]]*)\]\(([^)\s]+)\)\s*(.*)$", re.S)
# a line that only names a picture: `设计稿 1A:` / `**改前**` (in a list, or a paragraph of its own)
ITEM_LABEL = re.compile(r"^(?:\*\*)?([^:：!*`]{1,16}?)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*([^!]*)$", re.S)
PARA_LABEL = re.compile(r"^(?:\*\*)?([^:：!*`]{1,16}?)(?:\*\*)?\s*[:：]?\s*(?:\*\*)?$")
# labels that say two pictures are one pair: before / after, a design and the built screen
PAIR_WORDS = re.compile(r"改前|改后|之前|之后|前后|设计稿|原型|实机|真机|现状|旧版|新版|before|after|prototype|mock|design|built|real", re.I)
# a sub heading with a key in front: `A1 Agents found`, `1. 悬停前` -> a dark circle with the key, then the words
SUBKEY = re.compile(r"^(?:([A-F]\d{1,2})[\s.、:：)]+|(\d{1,2})[.、)]\s*)(.+)$")


def plain(text):
    """A heading as plain words (for the contents)."""
    return re.sub(r"[`*_]", "", scrub(text)).strip()


def h3_html(title, sid=""):
    idattr = f' id="{sid}"' if sid else ""
    m = SUBKEY.match(title.strip())
    if m:
        return f'<h3{idattr} class="sh"><span class="key">{esc(m.group(1) or m.group(2))}</span>{inline(m.group(3))}</h3>'
    return f"<h3{idattr}>{inline(title)}</h3>"


def labelled_items(items):
    """`平时: ![](a.png) 说明` → [(label, alt, src, caption)] when every item is one; else None."""
    out = []
    for it in items:
        m = ITEM_IMG.match(it)
        if not m:
            return None
        out.append((m.group(1).strip(), m.group(2), m.group(3), m.group(4).strip()))
    return out or None


def image_items(items):
    """`![](a.png) 说明` → [(alt, src, caption)] when every item starts with a picture."""
    out = []
    for it in items:
        m = ITEM_LEAD_IMG.match(it)
        if not m:
            return None
        out.append((m.group(1), m.group(2), m.group(3).strip()))
    return out or None


def is_pair(lab):
    """Labelled pictures that are a comparison (改前 / 改后, 设计稿 / 实机), whatever the section is called."""
    return len(lab) >= 2 and all(PAIR_WORDS.search(l[0]) for l in lab)


def picture_para(block):
    """(alt, src, caption) of a paragraph that is one picture and its words; else None."""
    if block[0] != "para":
        return None
    m = IMG_ONLY.match(block[1])
    return (m.group(1), m.group(2), m.group(3).strip()) if m and "![" not in m.group(3) else None


def merge_label_pics(blocks):
    """Notes are not always written the one way. A list of bare labels with the pictures under it (`- 设计稿 1A:` then
    the picture on its own paragraph), or bare label paragraphs each followed by a picture, become the standard
    `- 标签: ![](图) 说明` list, so they lay out as a pair or a strip too."""
    out, i = [], 0
    while i < len(blocks):
        kind, payload = blocks[i]
        if kind == "list":
            ordered, items = payload
            if items and all(ITEM_LABEL.match(it) and "![" not in it for it in items):
                pics = []
                j = i + 1
                while j < len(blocks) and len(pics) < len(items) and picture_para(blocks[j]):
                    pics.append(picture_para(blocks[j]))
                    j += 1
                if len(pics) == len(items):
                    merged = []
                    for it, (alt, src, cap) in zip(items, pics):
                        m = ITEM_LABEL.match(it)
                        merged.append(f"{m.group(1).strip()}: ![{alt}]({src}) {(m.group(2).strip() + ' ' + cap).strip()}")
                    out.append(("list", (ordered, merged)))
                    i = j
                    continue
        if kind == "para" and PARA_LABEL.match(payload.strip()) and "![" not in payload:
            merged, j = [], i
            while j + 1 < len(blocks) and blocks[j][0] == "para" and PARA_LABEL.match(blocks[j][1].strip()) and picture_para(blocks[j + 1]):
                alt, src, cap = picture_para(blocks[j + 1])
                merged.append(f"{PARA_LABEL.match(blocks[j][1].strip()).group(1).strip()}: ![{alt}]({src}) {cap}".strip())
                j += 2
            if len(merged) >= 2:
                out.append(("list", (False, merged)))
                i = j
                continue
        out.append((kind, payload))
        i += 1
    # A label list followed by its own picture produces one list per picture. Join adjacent
    # comparison lists so this equally common spelling still becomes one pair.
    merged = []
    for block in out:
        lab = labelled_items(block[1][1]) if block[0] == "list" else None
        prev = labelled_items(merged[-1][1][1]) if merged and merged[-1][0] == "list" else None
        if lab and prev and is_pair(prev + lab):
            ordered, items = merged[-1][1]
            merged[-1] = ("list", (ordered, items + block[1][1]))
        else:
            merged.append(block)
    return merged


def figure(ctx, src, alt, caption_html, side=None):
    """A picture and its words. A wide picture: the words under it. A tall one: the words beside it (wide page) or
    under it (narrow page); with no words it is narrowed and centred."""
    narrow = ctx.narrow_src(src) if side is None else side
    cap = f"<figcaption>{caption_html}</figcaption>" if caption_html else ""
    cls = ' class="fig-side"' if narrow and caption_html else (' class="solo"' if narrow else "")
    return f"<figure{cls}>{ctx.picture(src, alt)}{cap}</figure>"


def strip_html(ctx, items, title="", sid=""):
    """States of one thing on one strip: tabs over one big picture, or side by side when narrow."""
    narrow = len(items) == 1 or all(ctx.narrow_src(src) for _, _, src, _ in items)
    tabs = "".join(f'<button role="tab" aria-selected="{"true" if i == 0 else "false"}" tabindex="{0 if i == 0 else -1}">{inline(lab)}</button>'
                   for i, (lab, _, _, _) in enumerate(items))
    figs = "".join(f'<figure class="{"on" if i == 0 else ""}"><div class="lab">{inline(lab)}</div>{ctx.picture(src, alt or lab)}'
                   + (f"<figcaption>{inline(cap, ctx)}</figcaption>" if cap else "") + "</figure>"
                   for i, (lab, alt, src, cap) in enumerate(items))
    h = h3_html(title, sid) if title else ""
    cls = "scene row" + (" one" if len(items) == 1 else "") if narrow else "scene"
    return f'<div class="{cls}" style="--cols:{min(len(items), 3)}">{h}<div class="seg" role="tablist">{tabs}</div><div class="frames">{figs}</div></div>'


def gallery_html(ctx, items):
    """Pictures with words: two across (wide pictures) or three across (tall ones) on a wide page, one column on a narrow one."""
    narrow = all(ctx.narrow_src(src) for _, src, _ in items)
    figs = "".join(figure(ctx, src, alt, inline(cap, ctx), side=False) for alt, src, cap in items)
    return f'<div class="gal{" narrow" if narrow else ""}" style="--cols:{min(len(items), 3 if narrow else 2)}">{figs}</div>'


def box_marks(data, w, h, crop=None):
    """Numbered boxes from a <pic>.boxes.json as percentages of the picture (or of its crop)."""
    sw, sh = data.get("size") or [w, h]
    kx, ky = w / float(sw), h / float(sh)  # boxes.json in other pixels (a half-size capture) scale to the file
    ox, oy, cw, ch = crop or (0, 0, w, h)
    out = []
    for it in data.get("items") or []:
        try:
            x, y, bw, bh = (float(v) for v in it["box"])
            n = str(it.get("n"))
        except (KeyError, TypeError, ValueError):
            continue
        x, y, bw, bh = x * kx - ox, y * ky - oy, bw * kx, bh * ky
        g = " g" if it.get("color") == "green" else ""
        pos = f"left:{x / cw * 100:.3f}%;top:{y / ch * 100:.3f}%"
        out.append(f'<b class="rb{g}" data-n="{esc(n)}" style="{pos};width:{bw / cw * 100:.3f}%;height:{bh / ch * 100:.3f}%"></b>'
                   f'<b class="k{g}" data-n="{esc(n)}" style="{pos}">{esc(n)}</b>')
    return "".join(out)


def ba_html(ctx, items):
    """改前 / 改后 pairs, side by side on a wide page; a <pic>.boxes.json circles what changed on each."""
    figs = []
    for lab, alt, src, cap in items:
        boxes = None if ctx.is_page(src) else boxes_for(ctx, ctx.check(src))
        if boxes is None and not ctx.is_page(src):
            print(_t(f"Note: before/after \"{plain(lab)}\" {ctx.parse_src(src)[0]} has no boxes: write <picture>.boxes.json to mark what changed", f"提示：改前改后「{plain(lab)}」{ctx.parse_src(src)[0]} 没有框：写 <图名>.boxes.json 圈出改动处"), file=sys.stderr)
        figs.append(f'<figure><span class="lab">{inline(lab)}</span>{ctx.picture(src, alt or lab, boxes)}'
                    + (f"<figcaption>{inline(cap, ctx)}</figcaption>" if cap else "") + "</figure>")
    return '<div class="ba">' + "".join(figs) + "</div>"


def boxes_for(ctx, path):
    stem = os.path.splitext(path)[0]
    for cand in (stem + ".boxes.json",):
        d = read_json(os.path.join(ctx.src, cand))
        if isinstance(d, dict) and isinstance(d.get("items"), list):
            return d
    return None


def diag_html(ctx, src, alt, items, cap=""):
    """The screenshot with numbered red boxes and the same numbers beside it."""
    path = ctx.check(src)
    w, h = ctx.size(path)
    data = boxes_for(ctx, path) or {}
    sw, sh = (data.get("size") or [w, h]) if data else (w, h)
    marks, green = [], set()
    for it in data.get("items") or []:
        try:
            x, y, bw, bh = (float(v) for v in it["box"])
            n = str(it.get("n"))
        except (KeyError, TypeError, ValueError):
            continue
        g = " g" if it.get("color") == "green" else ""
        if g:
            green.add(n)
        pos = f"left:{x / sw * 100:.3f}%;top:{y / sh * 100:.3f}%;width:{bw / sw * 100:.3f}%;height:{bh / sh * 100:.3f}%"
        marks.append(f'<b class="rb{g}" data-n="{esc(n)}" style="{pos}"></b><b class="k{g}" data-n="{esc(n)}" style="left:{x / sw * 100:.3f}%;top:{y / sh * 100:.3f}%">{esc(n)}</b>')
    lis = []
    for i, it in enumerate(items, 1):
        gcls = ' class="g"' if str(i) in green else ""
        lis.append(f'<li data-n="{i}"{gcls}><span class="n">{i}</span><div>{inline(it, ctx)}</div></li>')
    narrow = ctx.narrow_src(src)
    figcap = f"<figcaption>{cap}</figcaption>" if cap else ""
    return (f'<div class="diag {"side" if narrow else "wide"}"><div class="dfig"><figure class="shot"><img src="{esc(path)}" alt="{esc(alt)}" width="{w}" height="{h}">'
            + "".join(marks) + f'</figure>{figcap}</div><ol class="nl">{"".join(lis)}</ol></div>')


# ---------------------------------------------------------------- the viewfinder (取景框)

# Every section reads the way 在哪 does (task 2026-10-01, direction A「就地看图」): the section's own
# pictures in a frame, its lines under or beside it; a line with a place zooms that picture to its numbered
# box, Whole picture comes back, Enlarge fills the window. A pair (改前 / 改后) is two frames side by side
# moved together by the same number; a strip of states (场景) is tabs over one frame, or frames side by side
# when the pictures are tall. A line can also open a record (a JSON or text file in the folder), or be words
# only. The boxes come from the files that already hold them: <pic>.boxes.json, 00-where.json, steps.json.

ROW_LINK = re.compile(r"^\[([^\]]+)\]\(([^)\s]+)\)\s*(.*)$", re.S)
RECORD_EXT = (".json", ".txt", ".log", ".md", ".csv", ".tsv", ".yaml", ".yml", ".out")
RECORD_MAX = 200_000


def row_link(ctx, item):
    """(words, href, rest) when a list line starts with a link to a picture or a record in the folder
    (`[首次打开显示读取数量](frame-1.png#mark=2)`, `[性能记录](benchmark.json)`, `[验收帧](steps.json#step=5)`); else None."""
    m = ROW_LINK.match(item.strip())
    if not m:
        return None
    href = m.group(2)
    if re.match(r"^[a-z]+:", href, re.I) or href.startswith("#"):
        return None
    path = href.partition("#")[0].lower()
    if not (path.endswith(IMG_EXT) or path.endswith(RECORD_EXT)):
        return None
    return m.group(1), href, m.group(3).strip()


def row_words(ctx, words, rest):
    """A line's words: what the link says (the thing to look at) first, then the rest of the line."""
    head = "<em>" + inline(words, ctx) + "</em>"
    if not rest:
        return head
    return head + ("" if re.match(r"^[：:，,。.;；、)）]", rest) else " ") + inline(rest, ctx)


def frag_n(href, key):
    m = re.search(r"(?:^|[#&])" + key + r"=([\w.-]+)", "#" + href.partition("#")[2])
    return m.group(1) if m else ""


def _scaled(box, size, to):
    sw, sh = size or to
    kx, ky = to[0] / float(sw or to[0] or 1), to[1] / float(sh or to[1] or 1)
    x, y, w, h = (float(v) for v in box)
    return [round(x * kx), round(y * ky), round(w * kx), round(h * ky)]


def free_boxes(ctx, path, size):
    """The numbered boxes a <pic>.boxes.json draws on this picture, in the frame's pixels: [(n, box, green, what)]."""
    d = boxes_for(ctx, path) or {}
    out = []
    for it in d.get("items") or []:
        try:
            out.append((str(it.get("n")), _scaled(it["box"], d.get("size"), size), it.get("color") == "green", str(it.get("what") or "")))
        except (KeyError, TypeError, ValueError):
            continue
    return out


def steps_box(ctx, frame, box, vw=0):
    """A box steps.json writes in the window's CSS pixels, in the picture's pixels (as 00-where.json from marks)."""
    fw, _ = ctx.size(frame)
    vp = (ctx.steps or {}).get("viewport") or {}
    k = fw / float(vw or vp.get("w") or fw or 1)
    return [round((box["x"] - 4) * k), round((box["y"] - 4) * k), round((box["w"] + 8) * k), round((box["h"] + 8) * k)]


def find_box(ctx, path, n, size):
    """Box number n on this picture: from <pic>.boxes.json, else 00-where.json, else steps.json's marks. (box, green) or None."""
    for bn, box, green, _ in free_boxes(ctx, path, size):
        if bn == str(n):
            return box, green
    wh = ctx.where_raw or {}
    top = wh.get("image") or ""
    for it in wh.get("items") or []:
        img = it.get("image") or top
        if img == path and str(it.get("n")) == str(n) and isinstance(it.get("box"), (list, tuple)) and len(it["box"]) == 4:
            sz = it.get("size") or (wh.get("size") if img == top else None) or ctx.size(path)
            return _scaled(it["box"], sz, size), it.get("color") == "green"
    for m in (ctx.steps or {}).get("marks") or []:
        if m.get("frame") == path and str(m.get("n")) == str(n) and isinstance(m.get("box"), dict):
            return _scaled(steps_box(ctx, path, m["box"], m.get("vw")), ctx.size(path), size), False
    return None


def new_frame(ctx, src, cap="", label="", alt="", free=False, size=None, scale=0, drawn=False):
    path = ctx.check(src)
    _, crop = ctx.parse_src(src)
    w, h = size if size and size[0] else ctx.size(path)
    fr = {"path": path, "w": int(w), "h": int(h), "s": scale or ctx.css_scale(path), "crop": crop, "cap": cap,
          "label": label, "alt": alt, "drawn": drawn, "marks": []}
    if free:
        fr["marks"] = [[None, n, box, green] for n, box, green, _ in free_boxes(ctx, path, (fr["w"], fr["h"]))]
    return fr


def record_html(ctx, path, title):
    """A record a line opens in place: a JSON file's top-level facts and the whole thing, or a text file as it is."""
    full = os.path.join(ctx.src, path)
    try:
        with open(full, "rb") as f:
            raw = f.read(RECORD_MAX + 1)
    except OSError:
        return ""
    cut = len(raw) > RECORD_MAX
    raw = raw[:RECORD_MAX]
    if b"\x00" in raw[:4096]:
        return ""
    text = raw.decode("utf-8", errors="replace")
    facts, body = "", text
    if path.lower().endswith(".json") and not cut:
        try:
            data = json.loads(text)
            body = json.dumps(data, ensure_ascii=False, indent=2)
            if isinstance(data, dict):
                rows = [(k, v) for k, v in data.items() if isinstance(v, (str, int, float, bool)) and len(str(v)) <= 120][:8]
                for k, v in data.items():
                    if isinstance(v, dict) and len(rows) < 8:
                        rows += [(f"{k}.{kk}", vv) for kk, vv in v.items() if isinstance(vv, (str, int, float, bool)) and len(str(vv)) <= 120][:8 - len(rows)]
                if rows:
                    facts = '<dl class="facts-t">' + "".join(f"<dt>{esc(scrub(str(k)))}</dt><dd>{esc(scrub(str(v)))}</dd>" for k, v in rows) + "</dl>"
        except ValueError:
            facts = '<p class="muted">Not valid JSON, shown as text.</p>'
    lines = body.count("\n") + 1
    pre = f'<pre class="term">{esc(scrub(body.rstrip()))}</pre>'
    note = '<p class="muted">Cut at 200 KB.</p>' if cut else ""
    raw_block = f'<details{"" if facts else " open"}><summary>{esc(path)} · {lines} lines</summary>{pre}{note}</details>'
    return (f'<div class="rec-h"><b>{inline(title)}</b><span class="sp"></span><button class="ghost rec-x" type="button">'
            f'<svg><use href="#i-close"/></svg>Close</button></div>{facts}{raw_block}')


def link_target(ctx, href, line=""):
    """What a line's link points at: ("pic", path, box|None, green, src) / ("rec", path) / None with a warning."""
    path = ctx.check(href)
    if path in ctx.missing:
        return None
    if path.lower().endswith(IMG_EXT):
        n = frag_n(href, "mark")
        crop_src = path + ("#crop=" + ",".join(map(str, ctx.parse_src(href)[1])) if ctx.parse_src(href)[1] else "")
        if not n:
            return ("pic", path, None, False, crop_src)
        got = find_box(ctx, path, n, ctx.size(path))
        if not got:
            ctx.warn(_t(f"{href}: the picture has no box {n} (not in {path[:-4] if '.' in path else path}.boxes.json, 00-where.json or steps.json); this line shows the whole picture", f"{href}：图上没有编号 {n} 的框（{path[:-4] if '.' in path else path}.boxes.json、00-where.json、steps.json 里都没找到），这一行只显示整图"), line)
            return ("pic", path, None, False, crop_src)
        return ("pic", path, got[0], got[1], crop_src)
    if os.path.basename(path) == "steps.json" and ctx.steps and (frag_n(href, "step") or frag_n(href, "mark")):
        st, mk = frag_n(href, "step"), frag_n(href, "mark")
        hit = None
        if st:
            hit = next((s for s in ctx.steps.get("steps") or [] if str(s.get("i")) == st), None)
            if hit and not hit.get("shot"):
                hit = None
        else:
            m = next((m for m in ctx.steps.get("marks") or [] if str(m.get("n")) == mk), None)
            hit = {"shot": m.get("frame"), "box": m.get("box"), "vw": m.get("vw")} if m else None
        if not hit or not os.path.isfile(os.path.join(ctx.src, hit["shot"])):
            ctx.warn(_t(f"{href}: steps.json has no screenshot of this step; this line shows only words", f"{href}：steps.json 里没有这一步的截图，这一行只放文字"), line)
            return None
        frame = ctx.check(hit["shot"])
        box = steps_box(ctx, frame, hit["box"], hit.get("vw")) if isinstance(hit.get("box"), dict) else None
        return ("pic", frame, box, False, frame)
    return ("rec", path)


def vw_html(ctx, panes, rows, cls="", title="", tabs=False, side_first=""):
    """The viewfinder. panes: [{label, cap, frames: [frame]}]; rows: [{kind: pic|rec|txt, n, html, t: [(pane, frame,
    box|None, green)], rec}]. A pane with several frames shows one at a time (tabs, or the line that is picked)."""
    linked = any(r["kind"] == "pic" and r.get("t") for r in rows) or any(m for p in panes for f in p["frames"] for m in f["marks"] if not f["drawn"])
    still = bool(panes) and not linked
    multi = len(panes) > 1
    for i, r in enumerate(rows):
        for pi, fi, box, green in r.get("t") or []:
            if not box:
                continue
            marks = panes[pi]["frames"][fi]["marks"]
            same = next((m for m in marks if m[2] == box and m[0] is None), None)
            if same:
                same[0] = i
            else:
                marks.append([i, r["n"], box, green])
    pane_html = []
    for pi, p in enumerate(panes):
        stages, caps = [], []
        for fi, f in enumerate(p["frames"]):
            ms = []
            if not f["drawn"]:
                for i, n, box, green in f["marks"]:
                    g = " g" if green else ""
                    key = f'data-i="{i}"' if i is not None else f'data-n="{esc(n)}"'
                    x, y, bw, bh = box
                    ms.append(f'<b class="rb{g}" {key} style="left:{x:.0f}px;top:{y:.0f}px;width:{bw:.0f}px;height:{bh:.0f}px">'
                              f'<i class="k{g}">{esc(n)}</i></b>')
            crop = f' data-crop="{",".join(str(v) for v in f["crop"])}"' if f["crop"] else ""
            lazy = ' loading="lazy"' if fi else ""
            stages.append(f'<div class="stage{" on" if fi == 0 else ""}" data-w="{f["w"]}" data-h="{f["h"]}" data-s="{f["s"]}"{crop} '
                          f'style="width:{f["w"]}px;height:{f["h"]}px"><img src="{esc(f["path"])}" alt="{esc(f["alt"])}" width="{f["w"]}" '
                          f'height="{f["h"]}" draggable="false"{lazy}>{"".join(ms)}</div>')
            if f["cap"]:
                caps.append(f'<figcaption data-f="{fi}"{"" if fi == 0 else " hidden"}>{f["cap"]}</figcaption>')
        chip = ('<span class="lab">' + p["label"] + "</span>") if p.get("label") else ""
        lab = (f'<div class="plab">{chip}<span class="pnote" hidden>Not marked on this picture</span></div>') if multi or chip else ""
        label = plain(re.sub(r"<[^>]+>", "", p.get("label") or title or "")) or "picture"
        pcap = "".join(caps) if multi else ""
        pane_html.append(f'<div class="pane">{lab}<div class="vp" role="img" aria-label="{esc(label)}">{"".join(stages)}'
                         f'<i class="mask" hidden></i></div>{pcap}</div>')
    tab_html = ""
    if tabs and panes:
        tab_html = ('<div class="seg vtabs" role="tablist">' + "".join(
            f'<button role="tab" aria-selected="{"true" if fi == 0 else "false"}" tabindex="{0 if fi == 0 else -1}" data-f="{fi}">{f["label"]}</button>'
            for fi, f in enumerate(panes[0]["frames"])) + "</div>")
    lines, recs = [], []
    for i, r in enumerate(rows):
        if r["kind"] == "pic" and r.get("t") and not still:
            t = "|".join(f'{pi}:{fi}:{",".join(str(int(round(float(v)))) for v in box) if box else ""}' for pi, fi, box, _ in r["t"])
            fr = f' data-f="{r["t"][0][1]}"' if tabs and r["t"] else ""
            hid = " hidden" if tabs and r["t"] and r["t"][0][1] != 0 else ""
            lines.append(f'<li tabindex="0" data-i="{i}" data-t="{t}"{fr}{hid}><span class="n">{esc(r["n"])}</span><span>{r["html"]}</span></li>')
        elif r["kind"] == "rec":
            lines.append(f'<li class="r" tabindex="0" data-i="{i}" data-rec="{i}"><span class="n ic"><svg><use href="#i-rec"/></svg></span>'
                         f'<span>{r["html"]}</span><small>Record</small></li>')
            recs.append(f'<div class="rec" data-rec="{i}" hidden>{r["rec"]}</div>')
        elif r["kind"] == "pic":
            lines.append(f'<li data-i="{i}"><span class="n">{esc(r["n"])}</span><span>{r["html"]}</span></li>')
        else:
            tag = f'<small>{r["tag"]}</small>' if r.get("tag") else ""
            lines.append(f'<li class="x" data-i="{i}"><span class="n ic"></span><span>{r["html"]}</span>{tag}</li>')
    single_caps = ""
    if panes and not multi:
        single_caps = "".join(f'<figcaption data-f="{fi}"{"" if fi == 0 else " hidden"}>{f["cap"]}</figcaption>'
                              for fi, f in enumerate(panes[0]["frames"]) if f["cap"])
    leg_cls = "leg" + (" body" if "where" not in cls else "")
    side_inner = (side_first + (f'<div class="caps">{single_caps}</div>' if single_caps else "")
                  + (f'<ol class="{leg_cls}">{"".join(lines)}</ol>' if lines else "")
                  + (f'<div class="recs">{"".join(recs)}</div>' if recs else ""))
    btns = ('<span class="pnote1"></span><button class="ghost all" type="button" hidden>Whole picture</button><span class="sp"></span>'
            '<button class="ghost enl" type="button"><svg><use href="#i-enlarge"/></svg>Enlarge</button>') if not still else '<span class="sp"></span>'
    vpbox = (f'<div class="vpbox">{tab_html}<div class="panes">{"".join(pane_html)}</div><div class="wbar">{btns}</div></div>') if panes else ""
    split = bool(panes) and not multi and bool(side_inner)
    classes = " ".join(x for x in ("vw", cls, "still" if still else "", "multi" if multi else "", "split" if split else "",
                                   "bare" if not panes else "") if x)
    style = f' style="--cols:{min(len(panes), 3)}"' if multi else ""
    ftitle = (f'<div class="ftitle">{inline(title) if title else ""}<span class="sp"></span><button class="ghost close" type="button">'
              f'<svg><use href="#i-close"/></svg>Close</button></div>') if panes else ""
    return f'<div class="{classes}"{style}>{ftitle}{vpbox}' + (f'<div class="side">{side_inner}</div>' if side_inner else "") + "</div>"


def rows_viewer(ctx, items, title=""):
    """A list whose lines point somewhere (改了什么, 证据, any section): one frame with every picture the lines name,
    numbered in order; a record line opens its record under the list; a line of words stays words."""
    frames, rows, n = [], [], 0
    for it in items:
        rl = row_link(ctx, it)
        tgt = link_target(ctx, rl[1], it) if rl else None
        if rl and rl[1].partition("#")[0] in ctx.missing:
            continue
        words = row_words(ctx, rl[0], rl[2]) if rl else inline(it, ctx)
        if not tgt:
            rows.append({"kind": "txt", "html": words, "tag": "No picture" if not rl else "Not found"})
            continue
        if tgt[0] == "rec":
            rec = record_html(ctx, tgt[1], rl[0])
            if not rec:
                ctx.warn(_t(f"{rl[1]}: cannot be read (not text); this line shows only words", f"{rl[1]}：读不出来（不是文本），这一行只放文字"), it)
                rows.append({"kind": "txt", "html": words, "tag": "Record unavailable"})
            else:
                rows.append({"kind": "rec", "html": words, "rec": rec})
            continue
        _, path, box, green, src = tgt
        fi = next((j for j, f in enumerate(frames) if f["path"] == path), None)
        if fi is None:
            frames.append(new_frame(ctx, src, alt=plain(rl[0])))
            fi = len(frames) - 1
        n += 1
        rows.append({"kind": "pic", "n": str(n), "html": words, "t": [(0, fi, box, green)]})
    panes = [{"frames": frames}] if frames else []
    return vw_html(ctx, panes, rows, "rows", title)


def take_rows(ctx, blocks, j):
    """The lines of a list right after a pair or a strip that only point at pictures: (items, next index)."""
    if j < len(blocks) and blocks[j][0] == "list" and blocks[j][1][1] and all(row_link(ctx, it) for it in blocks[j][1][1]):
        return blocks[j][1][1], j + 1
    return [], j


def split_lab(ctx, items):
    """A list of labelled pictures, maybe with lines that point into them: (labelled, lines) or (None, None)."""
    lab, rest = [], []
    for it in items:
        if row_link(ctx, it):
            rest.append(it)
            continue
        m = ITEM_IMG.match(it)
        if not m:
            return None, None
        lab.append((m.group(1).strip(), m.group(2), m.group(3), m.group(4).strip()))
    return (lab, rest) if lab else (None, None)


def explicit_rows(ctx, row_items):
    """Lines that point into a pair or a strip: [(words html, path, n, href, line)]."""
    out = []
    for it in row_items:
        words, href, rest = row_link(ctx, it)
        out.append((row_words(ctx, words, rest), ctx.check(href), frag_n(href, "mark"), href, it))
    return out


def pair_html(ctx, lab, row_items=(), title=""):
    """改前 / 改后 (设计稿 / 实机): two frames side by side, each with its own boxes; a line moves both to the same
    number, each zoomed by itself. A side without that number shows whole and says so."""
    if any(ctx.is_page(src) for _, _, src, _ in lab):
        return ba_html(ctx, lab)
    panes = []
    for lb, alt, src, cap in lab:
        path = ctx.check(src)
        if not boxes_for(ctx, path):
            print(_t(f"Note: before/after \"{plain(lb)}\" {path} has no boxes: write <picture>.boxes.json to mark what changed", f"提示：改前改后「{plain(lb)}」{path} 没有框：写 <图名>.boxes.json 圈出改动处"), file=sys.stderr)
        fr = new_frame(ctx, src, inline(cap, ctx) if cap else "", inline(lb), alt or plain(lb), free=True)
        panes.append({"label": inline(lb), "frames": [fr], "what": {n: w for n, _, _, w in free_boxes(ctx, path, (fr["w"], fr["h"])) if w}})
    rows = []
    numbers = []
    for p in panes:
        for _, n, _, _ in p["frames"][0]["marks"]:
            if n not in numbers:
                numbers.append(n)
    exp = explicit_rows(ctx, row_items)
    if exp:
        pairs = [(words, n, href, line) for words, _, n, href, line in exp]
    else:
        pairs = []
        for n in sorted(numbers, key=lambda x: (not x.isdigit(), int(x) if x.isdigit() else 0, x)):
            what = next((p["what"][n] for p in panes if p["what"].get(n)), "")
            # the heading is right above: the line says what it does rather than repeat it
            pairs.append((inline(what) if what else f"Box {esc(n)} on both pictures", n, "", ""))
    for words, n, href, line in pairs:
        t = []
        for pi, p in enumerate(panes):
            fr = p["frames"][0]
            got = find_box(ctx, fr["path"], n, (fr["w"], fr["h"])) if n else None
            t.append((pi, 0, got[0] if got else None, got[1] if got else False))
        if n and not any(x[2] for x in t):
            ctx.warn(_t(f"{href}: neither picture has box {n}; this line shows the whole picture", f"{href}：两张图上都没有编号 {n} 的框，这一行只显示整图"), line)
        rows.append({"kind": "pic", "n": n or str(len(rows) + 1), "html": words, "t": t})
    return vw_html(ctx, panes, rows, "pair", title)


def scene_html(ctx, lab, row_items=(), title="", sid="", role="scenes"):
    """States of one thing (平时 / 出现时 / 点开后): tabs over one frame for wide pictures, frames side by side for
    tall ones. A state's boxes and lines go with it; picking a line of another state switches to it."""
    h = h3_html(title, sid) if title else ""
    if any(ctx.is_page(src) for _, _, src, _ in lab):
        return '<div class="scene-wrap">' + strip_html(ctx, lab, title, sid) + "</div>"
    narrow = len(lab) > 1 and all(ctx.narrow_src(src) for _, _, src, _ in lab)
    # a proposal's direction reuses the diagnosis picture as「平时」: the diagnosis boxes stay in the diagnosis
    free = role != "direction"
    frames = [new_frame(ctx, src, inline(cap, ctx) if cap else "", inline(lb), alt or plain(lb), free=free) for lb, alt, src, cap in lab]
    panes = ([{"label": f["label"], "frames": [f]} for f in frames] if narrow
             else [{"frames": frames, "label": frames[0]["label"] if len(frames) == 1 else ""}])
    loc = (lambda fi: (fi, 0)) if narrow else (lambda fi: (0, fi))
    rows, covered = [], set()
    for words, path, n, href, line in explicit_rows(ctx, row_items):
        fi = next((j for j, f in enumerate(frames) if f["path"] == path), None)
        if fi is None:
            ctx.warn(_t(f"{href}: this picture is not among this group's states; the line was left out", f"{href}：这张图不在这一组状态里，这一行没放进去"), line)
            continue
        f = frames[fi]
        got = find_box(ctx, path, n, (f["w"], f["h"])) if n else None
        if n and not got:
            ctx.warn(_t(f"{href}: the picture has no box {n}; this line shows the whole picture", f"{href}：图上没有编号 {n} 的框，这一行只显示整图"), line)
        pi, ffi = loc(fi)
        covered.add(fi)
        rows.append({"kind": "pic", "n": n or str(len(rows) + 1), "html": words, "t": [(pi, ffi, got[0] if got else None, got[1] if got else False)]})
    for fi, (f, (lb, _, src, cap)) in enumerate(zip(frames, lab)):
        if fi in covered:
            continue
        boxes = free_boxes(ctx, f["path"], (f["w"], f["h"])) if free else []
        for n, box, green, what in boxes:
            words = inline(what) if what else (inline(cap, ctx) if cap and len(boxes) == 1 else inline(lb) + " " + esc(n))
            pi, ffi = loc(fi)
            rows.append({"kind": "pic", "n": n, "html": words, "t": [(pi, ffi, box, green)]})
    # a state's caption is said once: under the picture, or in the line when the line already says it
    for r in rows:
        pi, ffi = r["t"][0][0], r["t"][0][1]
        f = panes[pi]["frames"][ffi]
        if f["cap"] and r["html"] == f["cap"]:
            f["cap"] = ""
    return '<div class="scene-wrap">' + h + vw_html(ctx, panes, rows, "scene", title, tabs=not narrow and len(frames) > 1) + "</div>"


def generic_blocks(ctx, blocks, role="plain", title=""):
    """Blocks in order; pictures become figures (wide: words under; narrow: words beside), a list of
    labelled pictures becomes a strip (or a pair when the labels say so), a list of pictures a gallery, a picture
    followed by a numbered list a diagnosis block when it has boxes, a ```prototype block a running prototype.
    A pair, a strip of pictures and a list whose lines point at pictures or records are viewfinders (vw_html)."""
    blocks = merge_label_pics(blocks)
    out, i = [], 0
    while i < len(blocks):
        kind, payload = blocks[i]
        nxt = blocks[i + 1] if i + 1 < len(blocks) else (None, None)
        if kind == "para":
            m = IMG_ONLY.match(payload)
            if m and "![" not in m.group(3):
                alt, src, rest = m.group(1), m.group(2), m.group(3).strip()
                path = ctx.check(src)
                # a picture with boxes and a numbered list after it: the diagnosis block
                if nxt[0] == "list" and nxt[1][0] and (boxes_for(ctx, path) or role == "diag") and not ctx.is_page(src):
                    out.append(diag_html(ctx, src, alt, nxt[1][1], inline(rest, ctx) if rest else ""))
                    i += 2
                    continue
                cap = inline(rest, ctx) if rest else ""
                if nxt[0] == "list" and not cap and ctx.narrow_src(src):
                    out.append(f'<figure class="fig-side">{ctx.picture(src, alt)}<figcaption>{list_html(nxt[1][0], nxt[1][1], ctx)}</figcaption></figure>')
                    i += 2
                    continue
                if nxt[0] == "para" and not cap and "![" not in nxt[1] and ctx.narrow_src(src):
                    out.append(figure(ctx, src, alt, inline(nxt[1], ctx)))
                    i += 2
                    continue
                out.append(figure(ctx, src, alt, cap))
                i += 1
                continue
            # "…：" right before a picture introduces it: the picture first, these words under it
            if nxt[0] == "para" and re.search(r"[:：]$", payload.strip()) and IMG_ONLY.match(nxt[1] or "") and "![" not in IMG_ONLY.match(nxt[1]).group(3):
                m = IMG_ONLY.match(nxt[1])
                cap = inline(payload.strip().rstrip(":："), ctx) + ("。" + inline(m.group(3), ctx) if m.group(3).strip() else "")
                out.append(figure(ctx, m.group(2), m.group(1), cap))
                i += 2
                continue
            out.append(para_html(payload, ctx))
        elif kind == "list":
            ordered, items = payload
            lab, rows = split_lab(ctx, items)
            imgs = None if lab else image_items(items)
            if lab:
                more, i = take_rows(ctx, blocks, i + 1)
                rows = list(rows) + list(more)
                if role == "beforeafter" or (role != "scenes" and is_pair(lab)):
                    out.append(pair_html(ctx, lab, rows, title))
                else:
                    out.append(scene_html(ctx, lab, rows, role=role))
                continue
            elif role not in ("lead", "left") and any(row_link(ctx, it) for it in items):
                out.append(rows_viewer(ctx, items, title))
            elif imgs:
                out.append(gallery_html(ctx, imgs))
            else:
                out.append(list_html(ordered, items, ctx, "left" if role == "left" else ""))
        elif kind == "table":
            out.append(table_html(payload, ctx))
        elif kind == "code":
            if payload[0].split()[:1] == ["prototype"]:
                out.append(ctx.proto_inline(*payload))
            else:
                out.append(code_html(*payload))
        elif kind == "heading":
            out.append(h3_html(payload[1]))
        i += 1
    return "".join(out)


def sub_html(ctx, sub, role, sid=""):
    """A ### subsection: in 场景 its labelled list is the strip under the subsection's title (a pair stays a pair)."""
    blocks = merge_label_pics(sub["blocks"])
    if role in ("scenes", "direction", "plain", "changed"):
        for j, (k, p) in enumerate(blocks):
            lab, rows = split_lab(ctx, p[1]) if k == "list" else (None, None)
            if lab and not (role != "scenes" and is_pair(lab)):
                more, nj = take_rows(ctx, blocks, j + 1)
                rest = blocks[:j] + blocks[nj:]
                return scene_html(ctx, lab, list(rows) + list(more), sub["title"], sid, role) + generic_blocks(ctx, rest, role, sub["title"])
    return h3_html(sub["title"], sid) + generic_blocks(ctx, blocks, role, sub["title"])


def where_items(ctx, where, sec):
    """[(item, frame index)], [frames {src, w, h, drawn}] from 00-where.json; without it the lines of
    the 在哪 list and the section's first picture (or 00-where-is-what.png), not linked."""
    frames, items = [], []

    def frame_of(src, size=None, drawn=False):
        for i, f in enumerate(frames):
            if f["src"] == src:
                return i
        path = ctx.check(src)
        w, h = (size or [0, 0]) if size else ctx.size(path)
        if not w:
            w, h = ctx.size(path)
        frames.append({"src": path, "w": int(w), "h": int(h), "drawn": bool(drawn)})
        return len(frames) - 1

    if where and isinstance(where.get("items"), list):
        top = where.get("image") or ""
        drawn = bool(where.get("drawn"))
        for it in where["items"]:
            src = it.get("image") or top
            if not src:
                continue
            fi = frame_of(src, it.get("size") or (where.get("size") if src == top else None), drawn)
            items.append((it, fi))
    if not items and sec:
        for k, p in sec["blocks"]:
            if k == "list":
                for t in p[1]:
                    parts = [x.strip() for x in re.split(r"\s+·\s+", t)]
                    items.append(({"what": parts[0], "where": " · ".join(parts[1:2]), "how": " · ".join(parts[2:])}, 0))
                break
    if not frames:
        img = ""
        for k, p in (sec["blocks"] if sec else []):
            m = IMG_ONLY.match(p) if k == "para" else None
            if m:
                img = ctx.parse_src(m.group(2))[0]
                break
        if not img and os.path.isfile(os.path.join(ctx.src, "00-where-is-what.png")):
            img = "00-where-is-what.png"
        if img:
            frame_of(img, drawn=True)
    return items, frames


def where_heading(sec, page_title):
    """The 在哪 section is named after the feature it shows (user 2026-09-28: not the word 在哪): a
    heading「在哪：斜杠命令菜单」shows as「斜杠命令菜单」; with no name of its own it takes the page's."""
    t = (sec["title"] if sec else "").strip()
    t = re.sub(r"^(在哪(儿)?|where( is (it|what))?)\s*[：:·\-]?\s*", "", t, flags=re.I).strip()
    return t or page_title or _t("Where", "在哪")


def where_html(ctx, where, sec):
    """The 在哪 block: the whole screenshot with every numbered box first, the numbered lines beside it (wide) or
    under it (narrow); a line (or a box) zooms to its place, Whole picture comes back, Enlarge fills the window. The
    boxes are drawn by the page over the real screenshot; a picture that already has them (`drawn`) only gets the
    zoom. Without boxes: the picture whole, the lines not linked. The same viewfinder every section uses."""
    items, frames = where_items(ctx, where, sec)
    if not items and not frames:
        return ""
    linked = bool(items) and bool(frames) and all(isinstance(it.get("box"), (list, tuple)) and len(it["box"]) == 4 for it, _ in items)
    scale = float((where or {}).get("scale") or 0)
    fr = [{"path": f["src"], "w": f["w"], "h": f["h"], "s": scale or (0.5 if f["w"] >= 1800 else 1.0), "crop": None, "cap": "",
           "label": "", "alt": "", "drawn": f["drawn"], "marks": []} for f in frames]
    rows = []
    for i, (it, fi) in enumerate(items):
        text = "<em>" + inline(it.get("what") or "") + "</em>" + "".join(" · " + inline(it[k]) for k in ("where", "how") if it.get(k))
        box = [float(v) for v in it["box"]] if linked else None
        rows.append({"kind": "pic" if linked else "pic", "n": str(it.get("n") or i + 1), "html": text,
                     "t": [(0, fi, box, it.get("color") == "green")] if linked else []})
    if not linked:
        for f in fr:
            f["marks"] = []
    return vw_html(ctx, [{"frames": fr}] if fr else [], rows, "where", sec["title"] if sec else _t("Where", "在哪"))


def moment_html(ctx, sec):
    """Four cards: who does what at this moment (Agent / CLI / window / you)."""
    cards = []
    for sub in sec["subs"]:
        who, _, t = sub["title"].partition("：") if "：" in sub["title"] else sub["title"].partition(":")
        head = f'<span class="who">{inline(who.strip())}</span>' + (f'<b class="t">{inline(t.strip())}</b>' if t.strip() else "")
        body = "".join(para_html(p, ctx) if k == "para" else list_html(p[0], p[1], ctx) if k == "list" else "" for k, p in sub["blocks"])
        cards.append(f'<div class="step">{head}{body}</div>')
    return generic_blocks(ctx, sec["blocks"]) + f'<div class="moment">{"".join(cards)}</div>'


def evidence_html(ctx, sec, steps, tests):
    facts = []
    if steps:
        inst = steps.get("instance") or {}
        b = inst.get("build") or {}
        if b.get("name"):
            facts.append((_t("Build", "构建"), f'<span class="hash">{esc(b["name"])}</span>' + (f' · {esc(b.get("version"))}' if b.get("version") else "")))
        scen = steps.get("scenario") or ""
        if scen:
            name = os.path.splitext(os.path.basename(scen))[0]
            n = len(steps.get("steps") or [])
            ok = _t("passed", "通过") if steps.get("ok") else _t("failed: ", "失败：") + esc(((steps.get("error") or {}).get("message") or "")[:160])
            facts.append((_t("End to end", "端到端"), f"<code>dispatch ide e2e run {esc(name)}</code> · {n} " + _t("steps", "步") + f" · {ok}"))
        when = steps.get("finished") or steps.get("started") or ""
        if when:
            try:
                when = datetime.datetime.fromisoformat(when.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M")
            except ValueError:
                pass
            facts.append((_t("Screenshots taken", "截图时间"), esc(when)))
        if steps.get("shots"):
            facts.append((_t("Screenshots", "截图"), str(len(steps["shots"])) + _t(", each step in steps.json", " 张，每一步在 steps.json")))
    out = ""
    if facts:
        out += '<dl class="facts-t">' + "".join(f"<dt>{k}</dt><dd>{v}</dd>" for k, v in facts) + "</dl>"
    if sec:
        out += generic_blocks(ctx, sec["blocks"]) + "".join(sub_html(ctx, s, "evidence") for s in sec["subs"])
    for name, text in tests:
        out += f"<h3>{esc(name)}</h3>" + code_html("", text.rstrip())
    return out


def recommend_key(sec):
    """The direction the recommendation names in its first sentence (「推荐 B，…」), or ''."""
    first = next((p for k, p in sec["blocks"] if k == "para"), "")
    m = re.search(r"(?:推荐|选|Recommend(?:ed)?|Pick)\s*(?:方向\s*|direction\s+)?([A-F])\b", first, re.I)
    return m.group(1).upper() if m else ""


def recommend_html(ctx, sec, options):
    """The reasoning in a card, the comparison table under it, then Choose A / Choose B (a demo unless the page is
    opened from Dispatch Agent's right panel, where it records the pick)."""
    blocks = sec["blocks"]
    cut = next((i for i, (k, _) in enumerate(blocks) if k == "table"), len(blocks))
    card = '<div class="card rec">' + generic_blocks(ctx, blocks[:cut]) + "</div>" if blocks[:cut] else ""
    body = card + generic_blocks(ctx, blocks[cut:]) + "".join(sub_html(ctx, s, "recommend") for s in sec["subs"])
    rec = recommend_key(sec)
    btns = "".join(f'<button class="btn choose{" solid" if o["key"] == rec else ""}" type="button" data-key="{esc(o["key"])}">Choose {esc(o["key"])}</button>' for o in options)
    return (body + '<div class="pick" data-mode="demo"><div class="row">' + btns +
            '<input class="why" type="text" maxlength="300" placeholder="Why this one (optional)"></div>'
            '<p class="hint"></p>'
            '<div class="remembered" hidden><div class="rh"><svg><use href="#i-mark"/></svg>Remembered</div><div class="rt"></div><div class="rm"></div></div>'
            '<div class="toast" role="status" aria-live="polite"></div></div>')


# ---------------------------------------------------------------- the 在哪 picture from an e2e run

def where_from_steps(src, steps):
    """00-where.json from `dispatch ide e2e run` marks: every box on the real frame it was marked on,
    in that frame's pixels (the page draws the boxes; nothing is burnt into the screenshots)."""
    marks = [m for m in steps.get("marks") or [] if m.get("frame") and isinstance(m.get("box"), dict)]
    if not marks:
        return None
    vp = steps.get("viewport") or {}
    items = []
    for m in marks:
        fw, fh = image_size(os.path.join(src, m["frame"]))
        if not fw:
            return None
        vw = m.get("vw") or vp.get("w") or fw
        k = fw / float(vw)
        b = m["box"]
        items.append({"n": m.get("n"), "image": m["frame"], "size": [fw, fh],
                      "box": [round((b["x"] - 4) * k), round((b["y"] - 4) * k), round((b["w"] + 8) * k), round((b["h"] + 8) * k)],
                      "what": m.get("what") or m.get("label") or "", "where": m.get("where") or "", "how": m.get("how") or ""})
    dpr = vp.get("dpr") or 0
    return {"items": items, "scale": round(1.0 / dpr, 4) if dpr else 0, "from": "steps.json"}


# ---------------------------------------------------------------- the page

PERSON_SVG = ('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">'
              '<circle cx="8" cy="5.4" r="2.5"/><path d="M3.3 13.4c.7-2.4 2.5-3.7 4.7-3.7s4 1.3 4.7 3.7"/></svg>')


def attribution_html(att):
    """The header's line under who made the page (attribution direction B): who wrote what the delivery committed and
    how many of its lines you changed; nothing when Dispatch kept no record of those commits."""
    if not att:
        return ""
    names = [a["agent"] for a in att.get("agents") or [] if a.get("agent")]
    yours = int(att.get("yours") or 0)
    parts = []
    if names:
        parts.append(_t(f'<span class="pair">written by {esc(", ".join(names[:3]))}</span>', f'<span class="pair">{esc("、".join(names[:3]))} 写的</span>'))
    if yours:
        you = f'<span class="bd you">{PERSON_SVG}</span>'
        parts.append(_t(f'<span class="pair">{you}you changed {yours} lines</span>', f'<span class="pair">{you}你改了 {yours} 行</span>') if names else _t(f'<span class="pair">{you}written by you</span>', f'<span class="pair">{you}你写的</span>'))
    if not parts:
        return ""
    return '<div class="att" data-part="delivery-attribution">' + '<span class="sep">·</span>'.join(parts) + "</div>"


def task_commits(tid, issue, src, project_dir=""):
    """The commits a delivery stands for: the task's commit deliverables and every commit whose message names the task,
    in the delivery folder's repository and the project's: [(repo, sha)]."""
    import subprocess
    out, repos = [], []
    for x in T.clean_deliverables(T.meta(issue).get("deliverables")):
        if x["kind"] == "commit":
            repo = x.get("repo") or project_dir or src
            out.append((repo, x["ref"]))
            repos.append(repo)
    repos += [src, project_dir]
    seen = set()
    for repo in repos:
        if not repo or repo in seen or not os.path.isdir(repo):
            continue
        seen.add(repo)
        try:
            r = subprocess.run(["git", "-C", repo, "log", "--all", "-n", "60", "--format=%H", "--fixed-strings", f"--grep={tid}"],
                               capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.SubprocessError):
            continue
        if r.returncode == 0:
            out += [(repo, h) for h in r.stdout.split()]
    return out


def build(src, kind="impl", title="", model="", tests=(), today=None, attribution=None):
    """(html, info) for the folder. Raises DeliverError for what is missing."""
    if not os.path.isdir(src):
        raise DeliverError(_t(f"No such folder: {src}", f"没有这个目录：{src}"))
    if kind not in KINDS:
        raise DeliverError(_t("--kind is impl or proposal", "--kind 只能是 impl 或 proposal"))
    model = " ".join((model or "").split())
    if not model:
        raise DeliverError(_t("--model is missing: the page's header says who built or drafted it, \"<model> · <effort>\", such as --model \"Opus 5.5 · high\"", "缺 --model：页头要写「实现 / 出稿：<模型> · <档位>」，比如 --model \"Opus 5.5 · high\""))
    notes_path, notes = read_notes(src)
    steps = read_json(os.path.join(src, "steps.json")) if os.path.isfile(os.path.join(src, "steps.json")) else None
    if not notes and not steps:
        raise DeliverError(_t(f"{src} has no notes.md (nor README.md or steps.json): write notes.md first, as the delivery-page skill describes", f"{src} 里没有 notes.md（也没有 README.md 或 steps.json）：先写 notes.md，格式见 delivery-page 技能"))
    pics = sorted(n for n in os.listdir(src) if n.lower().endswith(IMG_EXT))
    if kind == "impl" and not pics:
        raise DeliverError(_t(f"{src} has no screenshots: a delivery page needs at least one screenshot of the real thing (dispatch ide e2e run --out {src})", f"{src} 里没有截图：实现交付页至少要一张真机截图（dispatch ide e2e run --out {src}）"))
    dpr = ((steps or {}).get("viewport") or {}).get("dpr") or 0
    ctx = Page(src, dpr, notes, read_json(os.path.join(src, "00-where.json")), steps)
    ntitle, lead, secs = split_sections(notes)
    title = " ".join((title or ntitle or ((steps or {}).get("meta") or {}).get("title") or "").split())
    if not title:
        raise DeliverError(_t("The title is missing: start notes.md with \"# <the title in the person's words>\", or give --title", "缺标题：notes.md 第一行写「# 用户的话说的标题」，或者 --title"))
    title = scrub(title)
    roles = [(section_role(s["title"]), s) for s in secs]
    options = []
    for r, s in roles:
        if r == "direction":
            m = DIRECTION.match(re.sub(r"^[\d.\s]+", "", s["title"]).strip())
            if m and m.group(1).upper() not in [o["key"] for o in options]:
                options.append({"key": m.group(1).upper(), "title": m.group(2).strip().strip("*「」\"")[:60]})
    if kind == "proposal" and len(options) < 2:
        raise DeliverError(_t("A proposal needs two directions: write \"## Direction A: <name>\" and \"## Direction B: <name>\" in notes.md", "方案稿要两个方向：notes.md 里写「## 方向 A: <名字>」和「## 方向 B: <名字>」"))

    where = read_json(os.path.join(src, "00-where.json"))
    made_where = None
    if not where and steps:
        where = made_where = where_from_steps(src, steps)
    ctx.where_raw = where if isinstance(where, dict) else None

    # header: the title, who made it, the theme switch, the conclusion as bullets
    today = today or datetime.date.today().isoformat()
    credit = f'<span>{_t(ROLE_EN[kind] + ": ", ROLE[kind] + "：")}{esc(model)}</span><span>{esc(today)}</span>'
    theme = '<span class="seg theme" role="tablist" aria-label="Theme"><button data-t="auto">Auto</button><button data-t="light">Light</button><button data-t="dark">Dark</button></span>'
    lead_html = generic_blocks(ctx, lead, "lead")
    if not lead_html and steps and (steps.get("meta") or {}).get("description"):
        lead_html = para_html(steps["meta"]["description"], ctx)
    header = (f'<header class="hd" id="top"><div class="hd-row"><div><h1>{inline(title)}</h1><div class="credit">{credit}</div>'
              f'{attribution_html(attribution)}</div>{theme}</div>'
              + (f'<div class="lead">{lead_html}</div>' if lead_html else "") + "</header>")

    # the sections, each as (role, id, label for the contents, html, sub headings for the contents)
    secs_out = []
    rec_key = next((recommend_key(s) for r, s in roles if r == "recommend"), "")
    TOC_SUBS = ("direction", "plain", "scenes", "changed", "beforeafter", "diag")

    def intro_first(body):
        return body.replace("<p>", '<p class="intro">', 1) if body.startswith("<p>") else body

    def add(role, sid, head, body, subs=None):
        if not body:
            return
        subs = [(f"{sid}-{j + 1}", plain(sb["title"])) for j, sb in enumerate(subs or [])] if role in TOC_SUBS and subs and len(subs) >= 2 else []
        html_ = f'<section class="sec" id="{sid}"><h2>{inline(head)}</h2>' + (body if role in ("recommend", "left", "evidence") else intro_first(body)) + "</section>"
        secs_out.append({"role": role, "id": sid, "label": esc(plain(head)), "html": html_, "subs": subs})

    def subs_html(subs, role, sid):
        return "".join(sub_html(ctx, sb, role, f"{sid}-{j + 1}") for j, sb in enumerate(subs))

    # 在哪 first (impl), even when notes has no section for it
    where_sec = next((s for r, s in roles if r == "where"), None)
    if kind == "impl" or where_sec:
        wh = where_html(ctx, where, where_sec)
        rest = ""
        if where_sec:
            rest = generic_blocks(ctx, [bk for bk in where_sec["blocks"] if not (bk[0] == "list" or (bk[0] == "para" and IMG_ONLY.match(bk[1])))])
            rest += "".join(sub_html(ctx, sb, "plain") for sb in where_sec["subs"])
        add("where", "where", where_heading(where_sec, ntitle), wh + rest)

    ev_sec = None
    for idx, (r, s) in enumerate(roles):
        sid = f"s{idx + 1}"
        if r == "where":
            continue
        if r == "evidence":
            ev_sec = s if ev_sec is None else {"title": ev_sec["title"], "blocks": ev_sec["blocks"] + s["blocks"], "subs": ev_sec["subs"] + s["subs"]}
            continue
        if r == "left":
            sid = "left"
        if r == "moment":
            add(r, sid, s["title"], moment_html(ctx, s))
        elif r == "recommend":
            add(r, "recommend", s["title"], recommend_html(ctx, s, options) if kind == "proposal" else generic_blocks(ctx, s["blocks"]))
        elif r == "direction":
            m = DIRECTION.match(re.sub(r"^[\d.\s]+", "", s["title"]).strip())
            key, name = m.group(1).upper(), m.group(2)
            did = f"dir-{key.lower()}"
            body = generic_blocks(ctx, s["blocks"], "direction") + subs_html(s["subs"], "direction", did)
            badge = _t('<span class="badge">Recommended</span>', '<span class="badge">推荐</span>') if key == rec_key else ""
            subs = [(f"{did}-{j + 1}", plain(sb["title"])) for j, sb in enumerate(s["subs"])] if len(s["subs"]) >= 2 else []
            secs_out.append({"role": r, "id": did, "label": f'<span class="key">{esc(key)}</span> <span>{esc(plain(name))}</span>', "subs": subs,
                             "html": f'<section class="sec dir" id="{did}"><h2 class="dir-h"><span class="key">{esc(key)}</span>{inline(name)}{badge}</h2>{intro_first(body)}</section>'})
        else:
            add(r, sid, s["title"], generic_blocks(ctx, s["blocks"], r) + subs_html(s["subs"], r, sid), s["subs"])
    if kind == "proposal" and not any(r == "recommend" for r, _ in roles):
        add("recommend", "recommend", _t("Pick a direction", "选一个方向"), recommend_html(ctx, {"blocks": [], "subs": []}, options))
    ev = evidence_html(ctx, ev_sec, steps, list(tests))
    if ev:
        add("evidence", "evidence", ev_sec["title"] if ev_sec else _t("Evidence", "证据"), ev)

    # The same section order for every delivery. Within a role, keep the author's order.
    order = {role: i for i, role in enumerate(("where", "diag", "changed", "moment", "scenes", "beforeafter",
                                              "direction", "plain", "evidence", "left", "recommend"))}
    ordered = sorted(secs_out, key=lambda x: order[x["role"]])

    def toc_item(x):
        subs = "".join(f'<li><a class="s" href="#{i}" data-t="{i}">{esc(t)}</a></li>' for i, t in x["subs"])
        return (f'<li><a href="#{x["id"]}" data-t="{x["id"]}">{x["label"]}</a>' + (f'<ol class="toc-sub">{subs}</ol>' if subs else "") + "</li>")
    toc_items = (_t('<li><a href="#top" data-t="top">Result</a></li>', '<li><a href="#top" data-t="top">结论</a></li>') if lead_html else "") + "".join(toc_item(x) for x in ordered)
    toc = ('<nav class="toc" aria-label="Contents"><div class="toc-cap"><span class="cap-t">Contents</span>'
           '<button class="toc-fold" type="button" aria-label="Hide contents" title="Hide contents" aria-expanded="true">'
           '<svg><use href="#i-side"/></svg></button></div>'
           '<button class="toc-btn" type="button" aria-expanded="false"><span class="tl">Contents</span><span class="tc"></span><svg><use href="#i-chev"/></svg></button>'
           f'<ol class="toc-list">{toc_items}</ol></nav>')
    parts = [header] + [x["html"] for x in ordered]

    if ctx.missing:
        raise DeliverError(_t("Pictures named in notes are not in the folder: ", "notes 里引用的图不在目录里：") + _t(", ", "、").join(ctx.missing))
    if kind == "impl" and not any(not ctx.is_page(u) for u in ctx.used):
        raise DeliverError(_t("notes.md names no screenshot: put screenshots into their sections with ![caption](01-xxx.png)", "notes.md 没有引用任何截图：用 ![说明](01-xxx.png) 把截图放进对应的段落"))

    tpl_path = os.path.join(skill_dir(), "template.html")
    with open(tpl_path, encoding="utf-8") as f:
        tpl = f.read()
    data = {"kind": kind, "title": title, "options": options, "model": model}
    page = (tpl.replace("{{LANG}}", _t("en", "zh-CN")).replace("{{KIND}}", kind).replace("{{TITLE}}", esc(title))
            .replace("{{DATA}}", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))
            .replace("{{TOC}}", toc)
            .replace("{{BODY}}", "\n".join(p for p in parts if p)))
    for w in ctx.warnings:
        print(w, file=sys.stderr)
    info = {"title": title, "kind": kind, "options": options, "notes": notes_path, "where": bool(where), "warnings": ctx.warnings,
            "made_where": made_where, "pictures": ctx.used, "unused": [p for p in pics if p not in ctx.used],
            "sections": [r for r, _ in roles]}
    return page, info


def ours(path):
    """An index.html this command wrote (safe to overwrite), or none there at all."""
    if not os.path.exists(path):
        return True
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return GENERATOR in f.read(4096)
    except OSError:
        return False


def deliver(tid, src, kind="impl", title="", model="", show=False, out="index.html", force=False, tests=(), session="", project=""):
    issue = T.show_issue(tid)
    src = os.path.abspath(os.path.expanduser(src))
    test_texts = []
    for t in tests or ():
        p = os.path.abspath(os.path.expanduser(t))
        if not os.path.isfile(p):
            raise DeliverError(_t(f"No such test output file: {p}", f"没有这个测试输出文件：{p}"))
        with open(p, encoding="utf-8", errors="replace") as f:
            test_texts.append((os.path.basename(p), f.read()[-20000:]))
    att = None
    if kind == "impl":
        try:
            import attribution as AT
            home = (D.project_home(T.project_of(issue)) if D is not None and T.project_of(issue) else "") or ""
            att = AT.delivery_line(task_commits(tid, issue, src, home))
        except Exception as e:  # the header's line is extra: a page without it beats no page
            if D is not None:
                D.debug("deliver.attribution", e)
    page, info = build(src, kind, title, model, test_texts, attribution=att)
    target = os.path.join(src, out)
    if not force and not ours(target):
        raise DeliverError(_t(f"{target} exists and was not written by dispatch deliver (a hand-written page or a prototype?): rename a prototype to something like proto.html in the same folder and leave index.html to the delivery page; or pick another --out name, or --force to overwrite it", f"{target} 已经在了而且不是 dispatch deliver 写的（手写的整页或原型？）：原型改名成 proto.html 这类名字放同目录、index.html 留给交付页；或换 --out 名字，或 --force 覆盖"))
    if info.get("made_where"):
        with open(os.path.join(src, "00-where.json"), "w", encoding="utf-8") as f:
            json.dump(info["made_where"], f, ensure_ascii=False, indent=1)
    tmp = target + f".{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(page)
    os.replace(tmp, target)

    proj = project or T.project_of(issue)
    doc = None
    if proj and D is not None:
        import docs_view
        docs_view.D = D
        doc = docs_view.register(proj, target, title=info["title"], kind=DOC_KIND[kind])
    now = int(time.time())
    items = T.clean_deliverables(T.meta(issue).get("deliverables"))
    label = "Proposal" if kind == "proposal" else "Delivery page"
    items = [x for x in items if not (x["kind"] == "file" and x["ref"] == target)] + [{"kind": "file", "ref": target, "label": label, "at": now}]
    changes = {"deliverables": items, "delivery": {"page": target, "kind": kind, "title": info["title"], "at": now}}
    if kind == "proposal":
        f = T.meta(issue).get("flow") or {}
        changes["flow"] = {"kind": "design", "state": "deciding", "dir": src, "prototype": target, "readme": info["notes"] or target,
                           "preview": f.get("preview", ""), "options": info["options"], "session": f.get("session", ""), "at": now}
    T.set_meta(tid, **changes)
    if kind == "proposal":
        T._sh(["bd", "update", tid, "--add-label", "dispatch:decide", "--add-label", "dispatch:waiting", "--json"])
    res = {"ok": True, "task": tid, "page": target, "kind": kind, "title": info["title"], "project": proj,
           "doc": doc, "pictures": len(info["pictures"]), "unused": info["unused"], "sections": info["sections"],
           "where": info["where"], "options": info["options"], "warnings": info.get("warnings") or []}
    if show:
        import ide_show
        res["shown"] = ide_show.show(target, session=session or "", task=tid, delivery=kind)
    return res


def text_of(r):
    if _t("en", "zh") == "en":
        lines = [f"Delivery page: {r['page']}", f"  {r['title']} ({'proposal' if r['kind'] == 'proposal' else 'delivery'}, {r['pictures']} pictures)"]
        lines.append(f"  Filed in {r['project']}'s Docs and attached to the task" if r.get("doc") else "  Attached to the task (it has no project, so it is not in Docs)")
        if r.get("unused"):
            lines.append("  Pictures in the folder not used: " + ", ".join(r["unused"][:8]))
        if r["kind"] == "proposal":
            lines.append("  Waiting for you asks the person to pick: " + " / ".join(o["key"] for o in r["options"]))
    else:
        lines = [f"交付页：{r['page']}", f"  {r['title']}（{'方案稿' if r['kind'] == 'proposal' else '实现交付'}，{r['pictures']} 张图）"]
        if r.get("doc"):
            lines.append(f"  已登记进 {r['project']} 的 Docs，已挂到任务上")
        else:
            lines.append("  已挂到任务上（任务没有项目，没登记 Docs）")
        if r.get("unused"):
            lines.append("  目录里没用上的图：" + "、".join(r["unused"][:8]))
        if r["kind"] == "proposal":
            lines.append("  Waiting for you 里等用户选：" + " / ".join(o["key"] for o in r["options"]))
    if "shown" in r:
        lines.append("  " + (r["shown"].get("message") or ""))
    return "\n".join(lines)


def run(a, d_module=None):
    global D
    if d_module is not None:
        D = d_module
        T.D = d_module
    try:
        if not a.task:
            raise DeliverError(_t("dispatch deliver <task> --from <folder> [--kind impl|proposal] --model \"<model> · <effort>\" [--show]", "dispatch deliver <任务> --from <目录> [--kind impl|proposal] --model \"<模型> · <档位>\" [--show]"))
        if not a.src:
            raise DeliverError(_t("--from <folder> is missing: the folder with the screenshots, notes.md and 00-where.json", "缺 --from <目录>：放截图、notes.md、00-where.json 的那个目录"))
        r = deliver(a.task, a.src, a.kind or "impl", a.title or "", a.model or "", a.show, a.out or "index.html", a.force,
                    a.test_log or [], getattr(a, "session", "") or "", getattr(a, "project", "") or "")
    except ValueError as e:
        if a.json:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        else:
            print(str(e), file=sys.stderr)
        return 1
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=1))
    else:
        print(text_of(r))
    return 0
