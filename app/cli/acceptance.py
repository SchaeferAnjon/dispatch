# -*- coding: utf-8 -*-
"""Agent-owned completion checklist, with read compatibility for old task records."""
import re

_BOX = re.compile(r"^[-*]\s*(\[( |x|X)\])?\s*(.*)$")
_BOXLINE = re.compile(r"^[-*]\s*\[( |x|X)\]")
_OPEN_TAG = re.compile(r"\s+#(claimed|failed|ask):([\w.-]+)\s*$")
_DONE_TAG = re.compile(r"\s+#(?:(waived)|sig:([0-9a-f]{8,64}))\s*$")
_TAIL_SIG = re.compile(r"\s+@([\w.-]+)\s*$")


def item_mask(lines):
    """For each raw line: is it an acceptance item? Box lines are; when the text has no box line
    at all, every non-empty line is (old lists). Headings and notes next to boxes are not."""
    stripped = [l.strip() for l in lines]
    any_box = any(_BOXLINE.match(s) for s in stripped)
    return [bool(s) and (not any_box or bool(_BOXLINE.match(s))) for s in stripped]

def _parse_line(s, n):
    m = _BOX.match(s)
    if not m:
        return {"n": n, "done": False, "text": s, "by": "", "tags": {}, "box": False}
    done = (m.group(2) or " ").lower() == "x"
    rest, tags, by = m.group(3), {}, ""
    while True:
        if done:
            t = _DONE_TAG.search(rest)
            if t:
                if t.group(1):
                    tags.setdefault("waived", "")
                else:
                    tags.setdefault("sig", t.group(2))
                rest = rest[:t.start()]
                continue
            g = _TAIL_SIG.search(rest) if not by else None
            if g:
                by = g.group(1)
                rest = rest[:g.start()]
                continue
        else:
            # an open line's `@name` is part of its text, and a state tag always names who
            t = _OPEN_TAG.search(rest)
            if t:
                tags.setdefault(t.group(1), t.group(2))
                rest = rest[:t.start()]
                continue
        break
    return {"n": n, "done": done, "text": rest.strip(), "by": by, "tags": tags, "box": m.group(1) is not None}

def parse_items(text):
    """The acceptance items, numbered from 1 in order (the app numbers them the same way).
    Trailing `#state:actor` tags, the `@who` signature and `#sig:` are taken off the text."""
    lines = (text or "").splitlines()
    items = []
    for line, is_item in zip(lines, item_mask(lines)):
        if is_item:
            items.append(_parse_line(line.strip(), len(items) + 1))
    return items

def rewrite(text, changed):
    """The acceptance text with only the items in `changed` ({n: item}) rewritten: every other
    line (notes included) keeps its exact bytes, so old data is never reformatted as a side effect."""
    lines = (text or "").splitlines()
    out, n = [], 0
    for line, is_item in zip(lines, item_mask(lines)):
        if is_item:
            n += 1
            if n in changed:
                out.append(line_of(changed[n]))
                continue
        out.append(line)
    return "\n".join(out)

def pick(items, spec):
    """Item numbers named by `spec`: "2", "2,3", or words matched against the item text
    (the old `--tick 关键词` form). Unknown numbers raise."""
    tokens = [t for t in re.split(r"[,\s，]+", " ".join(spec) if isinstance(spec, (list, tuple)) else str(spec or "")) if t]
    ns = []
    for t in tokens:
        if t.isdigit():
            n = int(t)
            if not 1 <= n <= len(items):
                import lang as L
                raise ValueError(L.t(f"There is no item {n}: the checklist has {len(items)} item{'' if len(items) == 1 else 's'}",
                                     f"没有第 {n} 项（共 {len(items)} 项）"))
            ns.append(n)
        else:
            ns += [it["n"] for it in items if t.lower() in it["text"].lower()]
    return sorted(set(ns))

def line_of(it):
    """Write plain checklist items; old checker tags are never created again."""
    return f"- [{'x' if it['done'] else ' '}] {it['text']}" + (f" @{it['by']}" if it['done'] and it.get('by') else '')


def status(issue, comments=()):
    """Return checklist progress and the latest recorded evidence for each item."""
    evidence = {}
    for c in comments or []:
        text = (c.get("text") or "").strip()
        m = re.match(r"^(?:【(?:自查|自审|待验收)】|\[self-check\]\s*)\s*([\d,，\s]+?)\s*·\s*([\w.-]+)\s*·\s*(?:证据|evidence)[:：]\s*(.*)$", text, re.S)
        if m:
            for n in re.findall(r"\d+", m[1]):
                evidence[int(n)] = {"by": m[2], "evidence": m[3].strip(), "at": c.get("created_at", "")}
    rows = []
    for it in parse_items(issue.get("acceptance_criteria")):
        ev = evidence.get(it["n"], {})
        rows.append({"n": it["n"], "text": it["text"], "done": it["done"],
                     "state": "done" if it["done"] else "todo", "by": it["by"] or ev.get("by", ""),
                     "evidence": ev.get("evidence", ""), "at": ev.get("at", "")})
    done = sum(r["done"] for r in rows)
    return {"items": rows, "progress": {"done": done, "todo": len(rows) - done}, "total": len(rows)}


def describe(rows):
    return "\n".join(f"{r['n']}. {'[x]' if r['done'] else '[ ]'} {r['text']}" + (f" · {r['evidence']}" if r.get('evidence') else '') for r in rows)
