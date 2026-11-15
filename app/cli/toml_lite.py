# -*- coding: utf-8 -*-
"""TOML for Codex's config.toml on any Python: `tomllib` when there is one (3.11+), else a small reader
for what a config.toml holds (tables and dotted tables, strings, numbers, booleans, flat arrays).
A new Mac has only the Command Line Tools' Python 3.9, and `dispatch` runs on it."""
import json
import re


def loads(text):
    try:
        import tomllib
        return tomllib.loads(text)
    except ImportError:
        return _loads(text)


_BARE = re.compile(r"[A-Za-z0-9_-]+")


def _key_parts(s):
    parts, s = [], s.strip()
    while s:
        if s[0] in "\"'":
            q = s[0]
            end = s.index(q, 1)
            parts.append(s[1:end])
            s = s[end + 1:].lstrip()
        else:
            m = _BARE.match(s)
            if not m:
                raise ValueError("bad key: " + s)
            parts.append(m.group(0))
            s = s[m.end():].lstrip()
        if s.startswith("."):
            s = s[1:].lstrip()
        elif s:
            raise ValueError("bad key: " + s)
    return parts


def _strip_comment(line):
    out, q = [], None
    for i, c in enumerate(line):
        if q:
            if c == q and (q == "'" or line[i - 1] != "\\"):
                q = None
        elif c in "\"'":
            q = c
        elif c == "#":
            break
        out.append(c)
    return "".join(out).strip()


def _value(v):
    v = v.strip()
    if v.startswith('"'):
        return json.loads(v)
    if v.startswith("'"):
        return v[1:-1]
    if v in ("true", "false"):
        return v == "true"
    if v.startswith("["):
        inner = v[1:-1].strip()
        if not inner:
            return []
        items, cur, q = [], "", None
        for c in inner:
            if q:
                cur += c
                if c == q:
                    q = None
            elif c in "\"'":
                q = c
                cur += c
            elif c == ",":
                items.append(cur)
                cur = ""
            else:
                cur += c
        if cur.strip():
            items.append(cur)
        return [_value(x) for x in items]
    n = v.replace("_", "")
    if re.fullmatch(r"[+-]?\d+", n):
        return int(n)
    try:
        return float(n)
    except ValueError:
        raise ValueError("unsupported value: " + v)


def _loads(text):
    root = {}
    table = root
    for raw in text.splitlines():
        line = _strip_comment(raw)
        if not line:
            continue
        if line.startswith("[["):
            raise ValueError("arrays of tables are not supported")
        if line.startswith("["):
            table = root
            for part in _key_parts(line[1:line.rindex("]")]):
                table = table.setdefault(part, {})
            continue
        if "=" not in line:
            raise ValueError("bad line: " + line)
        k, v = line.split("=", 1)
        parts = _key_parts(k)
        t = table
        for part in parts[:-1]:
            t = t.setdefault(part, {})
        t[parts[-1]] = _value(v)
    return root
