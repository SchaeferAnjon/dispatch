# -*- coding: utf-8 -*-
"""The Usage page's reading of the agents' own records (`dispatch usage`, usage.py): tokens by model and day, what models
billed per call cost, and every tool, skill, sub-agent, hook and slash command an agent ran, with its failures.

Read from what each engine keeps on this Mac, nothing else:

  Claude Code   ~/.claude/projects/**/*.jsonl (sub-agents in <session>/subagents/): `usage` of each answer (one answer is
                logged once per content block: counted once per requestId), `tool_use` blocks (MCP tools are
                `mcp__<server>__<tool>`, skills the Skill tool, sub-agents the Agent / Task tool), `tool_result.is_error`,
                the hook records (`hook_success`, `hook_*_error`, `stop_hook_summary`), the MCP tools a session was
                offered (`deferred_tools_*`), slash commands (`<command-name>`).
  Codex         ~/.codex/sessions/**/rollout-*.jsonl: `token_count` (cumulative; the deltas are the turns), the model of
                `turn_context`, `function_call` / `custom_tool_call` names, skills as the SKILL.md a tool call reads
                (only real tool calls: a `compacted` record repeats the whole system prompt and its skill list). Codex
                writes no failure flag.
  Pi            ~/.pi/agent/sessions/**/*.jsonl: `usage` with Pi's own `cost`, `toolCall` / `toolResult.isError`.
  OpenCode,     their SQLite stores (opencode.db, ZCode's): each answer's tokens and `cost`, tool parts with their status.
  ZCode

A JSON-lines transcript is read once: each file's summary keeps the byte offset it got to and grows with what is appended
(the files only grow); the summaries live in <dispatch dir>/usage/scan.json. The first reading of a busy Mac (about 9 GB)
is split over helper processes (`python usage_scan.py --worker`), one per core minus two.

A summary counts per local day, so the page can show any window (7, 30, 90 days) from the same reading.
"""
import sys

sys.dont_write_bytecode = True

import json
import os
import re
import subprocess
import threading
import time
from datetime import datetime, timezone

SCAN_V = 1
CHUNK = 16 << 20
KEEP_DAYS = 92  # transcripts untouched for longer than this are not read (the longest window is 90 days)

# ---- prices -----------------------------------------------------------------------------------------------------------
# Anthropic's list prices per million tokens (the claude-api reference, cached 2026-10-06): input, output, cache read.
# A cache write costs 1.25x the input price for the 5-minute cache and 2x for the 1-hour one. The first prefix that
# matches a model id wins, so the more specific ids come first.
CLAUDE_PRICES = (
    ("claude-fable-5-1", 10.0, 50.0, 0.25),
    ("claude-mythos-5-1", 10.0, 50.0, 0.25),
    ("claude-fable-5", 10.0, 50.0, 1.0),
    ("claude-mythos-5", 10.0, 50.0, 1.0),
    ("claude-opus-5-5", 4.0, 20.0, 0.20),
    ("claude-opus-5", 5.0, 25.0, 0.50),
    ("claude-opus-4-8", 5.0, 25.0, 0.50),
    ("claude-opus-4-7", 5.0, 25.0, 0.50),
    ("claude-opus-4-6", 5.0, 25.0, 0.50),
    ("claude-opus-4-5", 5.0, 25.0, 0.50),
    ("claude-opus-4", 15.0, 75.0, 1.50),
    ("claude-sonnet-5", 2.0, 10.0, 0.20),
    ("claude-sonnet-4", 3.0, 15.0, 0.30),
    ("claude-3-7-sonnet", 3.0, 15.0, 0.30),
    ("claude-haiku-5-5", 0.10, 0.50, 0.01),
    ("claude-haiku-4-5", 1.0, 5.0, 0.10),
    ("claude-3-5-haiku", 0.80, 4.0, 0.08),
)
PRICES_AS_OF = "2026-10-06"


def claude_price(model):
    m = (model or "").lower()
    for prefix, i, o, cr in CLAUDE_PRICES:
        if m.startswith(prefix):
            return i, o, cr
    return None


def api_value(model, t):
    """What tokens [in, out, cache read, cache write 5m, cache write 1h] of a Claude model cost at the list price
    (None for a model Anthropic does not price)."""
    p = claude_price(model)
    if not p:
        return None
    i, o, cr = p
    return (t[0] * i + t[1] * o + t[2] * cr + t[3] * i * 1.25 + t[4] * i * 2.0) / 1e6


OTHER_MODELS = (
    (r"^deepseek-v(\d+(?:\.\d+)?)-(flash|pro|chat)", lambda m: "DeepSeek V%s %s" % (m.group(1), m.group(2).capitalize())),
    (r"^deepseek-(flash|chat|reasoner|pro)$", lambda m: "DeepSeek %s" % m.group(1).capitalize()),
    (r"^glm-(\d+(?:\.\d+)?)(?:-(flash|air|plus))?$", lambda m: ("GLM %s %s" % (m.group(1), (m.group(2) or "").capitalize())).strip()),
    (r"^gpt-(\d+(?:\.\d+)?)(?:-(codex|mini))?$", lambda m: ("GPT-%s %s" % (m.group(1), (m.group(2) or "").capitalize())).strip()),
)


def model_label(model):
    """claude-opus-5-5 → Opus 5.5; claude-sonnet-4-5-20250929 → Sonnet 4.5; deepseek-v4.1-flash-expires-on-0910 →
    DeepSeek V4.1 Flash; glm-5.3-flash → GLM 5.3 Flash; others as they are."""
    for rx, fmt in OTHER_MODELS:
        m = re.match(rx, (model or "").lower())
        if m:
            return fmt(m)
    m = re.match(r"^claude-(?:(\d)-(\d)-)?(opus|sonnet|haiku|fable|mythos)(?:-(\d+))?(?:-(\d))?(?:-\d{8})?$", model or "")
    if not m:
        return model
    old_a, old_b, family, a, b = m.groups()
    ver = f"{old_a}.{old_b}" if old_a else (f"{a}.{b}" if b else (a or ""))
    return f"{family.capitalize()} {ver}".strip()


# ---- days ---------------------------------------------------------------------------------------------------------------

_DAY_CACHE = {}


def day_of_iso(ts):
    """'2026-10-09T13:55:01.123Z' → the local day; memoised per UTC hour (one conversion per hour of transcript)."""
    if not ts or len(ts) < 13:
        return ""
    key = ts[:13]
    d = _DAY_CACHE.get(key)
    if d is None:
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            # the minutes of the zone offset (India, Nepal) move the day within the hour: convert the exact time then
            off = dt.astimezone().utcoffset()
            if off is not None and off.total_seconds() % 3600:
                return dt.astimezone().strftime("%Y-%m-%d")
            d = dt.astimezone().strftime("%Y-%m-%d")
        except ValueError:
            return ""
        _DAY_CACHE[key] = d
    return d


def day_of_ms(ms):
    try:
        return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OverflowError, OSError):
        return ""


# ---- one file's summary -----------------------------------------------------------------------------------------------

def new_summary(path, engine):
    return {"v": SCAN_V, "eng": engine, "off": 0, "size": 0, "mtime": 0, "sid": "", "sub": "/subagents/" in path,
            "cwd": "", "first": "", "last": "", "lr": "", "ctot": None, "model": "",
            "tok": {}, "usd": {}, "prov": {}, "tl": {}, "sk": {}, "ag": {}, "hk": {}, "hke": {}, "cm": {}, "mo": [],
            "pend": {}}


def _touch(s, day):
    if day:
        if not s["first"] or day < s["first"]:
            s["first"] = day
        if day > s["last"]:
            s["last"] = day


def _bump(table, name, day, n=1, err=0):
    if not name or not day:
        return
    cell = table.setdefault(name, {}).setdefault(day, [0, 0])
    cell[0] += n
    cell[1] += err


def _err(table, name, day):
    if name and day:
        table.setdefault(name, {}).setdefault(day, [0, 0])[1] += 1


def _tokens(s, day, model, parts):
    if not day or not any(parts):
        return
    row = s["tok"].setdefault(day, {}).setdefault(model or "?", [0, 0, 0, 0, 0])
    for i, v in enumerate(parts):
        row[i] += v


def _num(v):
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


RE_TOOL_USE_ID = re.compile(r'"tool_use_id":"([^"]+)"')
RE_COMMAND = re.compile(r"<command-name>/?([^<\s]{1,60})</command-name>")
RE_SKILL_FILE = re.compile(r'skills/(?:[^/"\s\\]+/)*([A-Za-z0-9][\w.-]*)/SKILL\.md')
RE_HOOK_TAG = re.compile(r"#\s*([\w.-]+)\s*$")


def hook_label(cmd):
    """A hook's command → the short name a person knows it by: its `# tag` (Dispatch's hooks end in one), else the
    program and its subcommand ("dispatch prime", "cc-status-hook")."""
    cmd = (cmd or "").strip()
    if not cmd:
        return ""
    m = RE_HOOK_TAG.search(cmd)
    if m:
        return m.group(1)
    if re.match(r"^(if|case|for|while|\{|\()[\s(]", cmd):
        # a shell script in the hook itself (Orca's): name it after the first program file it calls, and the hidden
        # folder it lives in ("${HOME}/.orca/agent-hooks/claude-hook.cmd" → "orca claude-hook")
        for m in re.finditer(r"(?:\$\{?HOME-?\}?|~|/)[^\s\"';|&]*/([\w.-]+)", cmd):
            base = re.sub(r"\.(cmd|sh|py|js|mjs|ps1|exe)$", "", m.group(1))
            if base.lower() in ("cat", "printf", "powershell", "sh", "bash", "null", "env"):
                continue
            home = re.search(r"/\.([\w-]+)/", m.group(0))
            return ("%s %s" % (home.group(1), base) if home else base)[:60]
        return "shell script"
    words = [w.strip("'\"") for w in cmd.split()]
    words = [w for w in words if not re.match(r"^[A-Z_][A-Z0-9_]*=", w)]
    out = []
    for w in words:
        base = w.rsplit("/", 1)[-1]
        if not out:
            if re.match(r"^(python[\d.]*|node|bash|sh|zsh|bun|deno|uv|npx)$", base):
                continue
            out.append(re.sub(r"\.(py|js|mjs|sh|ts)$", "", base))
            continue
        if w.startswith("-") or "/" in w or "$" in w or len(out) >= 3:
            break
        out.append(w)
    return " ".join(out)[:60]


def _hook_cmd_of_error(a):
    be = a.get("blockingError")
    text = be.get("blockingError") if isinstance(be, dict) else (be or "")
    m = re.match(r"^\[(.+?)\]:", text or "")
    if m:
        return m.group(1)
    m = re.search(r'"(.+?)" exited', a.get("stderr") or "")
    return m.group(1) if m else a.get("command") or ""


# -- Claude Code

def fold_claude(s, buf):
    for line in buf.split("\n"):
        if not line.startswith("{"):
            continue
        if '"tool_use_id"' in line and '"type":"user"' in line:
            ids = RE_TOOL_USE_ID.findall(line)
            errs = set()
            if '"is_error":true' in line:
                try:
                    d = json.loads(line)
                    for b in (d.get("message") or {}).get("content") or []:
                        if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error"):
                            errs.add(b.get("tool_use_id"))
                except ValueError:
                    pass
            for tid in ids:
                p = s["pend"].pop(tid, None)
                if p and tid in errs:
                    kind, name, day = p
                    _err(s["tl"], name if kind == "t" else ("Skill" if kind == "s" else "Agent"), day)
                    if kind == "s":
                        _err(s["sk"], name, day)
                    elif kind == "a":
                        _err(s["ag"], name, day)
            continue
        if '"type":"assistant"' in line:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("type") != "assistant":
                continue
            if not s["cwd"] and d.get("cwd"):
                s["cwd"] = d["cwd"]
            if not s["sid"] and d.get("sessionId") and not s["sub"]:
                s["sid"] = d["sessionId"]
            day = day_of_iso(d.get("timestamp"))
            _touch(s, day)
            msg = d.get("message") or {}
            model = msg.get("model") or ""
            u = msg.get("usage") or {}
            rid = d.get("requestId") or msg.get("id") or d.get("uuid") or ""
            if u and model != "<synthetic>" and rid != s["lr"]:
                s["lr"] = rid
                cc = u.get("cache_creation") or {}
                cw = _num(u.get("cache_creation_input_tokens"))
                cw1 = _num(cc.get("ephemeral_1h_input_tokens")) if cc else 0
                cw5 = _num(cc.get("ephemeral_5m_input_tokens")) if cc else cw
                if cc and cw5 + cw1 < cw:
                    cw5 = cw - cw1
                _tokens(s, day, model, (_num(u.get("input_tokens")), _num(u.get("output_tokens")), _num(u.get("cache_read_input_tokens")), cw5, cw1))
            for b in msg.get("content") or []:
                if not isinstance(b, dict) or b.get("type") != "tool_use":
                    continue
                name, inp, tid = b.get("name") or "", b.get("input") or {}, b.get("id") or ""
                _bump(s["tl"], name, day)
                kind, sub = "t", name
                if name == "Skill" and isinstance(inp, dict) and inp.get("skill"):
                    kind, sub = "s", str(inp["skill"])
                    _bump(s["sk"], sub, day)
                elif name in ("Agent", "Task") and isinstance(inp, dict):
                    kind, sub = "a", str(inp.get("subagent_type") or "general-purpose")
                    _bump(s["ag"], sub, day)
                if tid:
                    s["pend"][tid] = [kind, sub, day]
            continue
        if '"type":"attachment"' in line and ('"hook_' in line or '"deferred_tools_' in line):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            a = d.get("attachment") or {}
            t = a.get("type") or ""
            day = day_of_iso(d.get("timestamp"))
            if t.startswith("deferred_tools_"):
                names = a.get("addedNames") or [e.get("name") for e in a.get("entries") or [] if isinstance(e, dict)]
                for n in names or []:
                    if isinstance(n, str) and n.startswith("mcp__"):
                        srv = n[5:].split("__", 1)[0]
                        if srv and srv not in s["mo"]:
                            s["mo"].append(srv)
                if not s["cwd"] and d.get("cwd"):
                    s["cwd"] = d["cwd"]
            elif t in ("hook_success", "hook_non_blocking_error", "hook_blocking_error", "hook_cancelled", "hook_error"):
                label = hook_label(a.get("command") or (_hook_cmd_of_error(a) if t != "hook_success" else "")) or a.get("hookName") or "?"
                failed = t in ("hook_non_blocking_error", "hook_blocking_error", "hook_error") or (t == "hook_success" and str(a.get("exitCode") or "0") not in ("0", ""))
                _bump(s["hk"], label, day, 1, 1 if failed else 0)
                s["hke"][label] = a.get("hookEvent") or (a.get("hookName") or "").split(":")[0]
            continue
        if '"type":"system"' in line and ('"stop_hook_summary"' in line or '"local_command"' in line):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            day = day_of_iso(d.get("timestamp"))
            if d.get("subtype") == "stop_hook_summary":
                errors = " ".join(str(x) for x in d.get("hookErrors") or [])
                for h in d.get("hookInfos") or []:
                    cmd = (h or {}).get("command") or ""
                    label = hook_label(cmd) or "?"
                    _bump(s["hk"], label, day, 1, 1 if cmd and cmd in errors else 0)
                    s["hke"].setdefault(label, "Stop")
            elif d.get("subtype") == "local_command":
                c = ((d.get("commandRun") or {}).get("command") or "").strip()
                if c:
                    _bump(s["cm"], "/" + c.lstrip("/"), day)
            continue
        if '"type":"user"' in line and "<command-name>" in line:
            m = re.search(r'"timestamp":"([^"]+)"', line)
            day = day_of_iso(m.group(1)) if m else ""
            for c in set(RE_COMMAND.findall(line)):
                _bump(s["cm"], "/" + c, day)


# -- Codex

def _codex_head(s, line):
    try:
        d = json.loads(line)
    except ValueError:
        return
    p = d.get("payload") or {}
    if d.get("type") != "session_meta":
        return
    s["sid"] = p.get("id") or s["sid"]
    s["cwd"] = p.get("cwd") or s["cwd"]
    src = p.get("source")
    if isinstance(src, dict) and ("subagent" in src or "sub_agent" in src) or src == "subagent":
        s["sub"] = True


def fold_codex(s, buf, first):
    lines = buf.split("\n")
    if first and lines and lines[0].startswith("{"):
        _codex_head(s, lines[0])
    for line in lines:
        if not line.startswith("{"):
            continue
        if '"type":"token_count"' in line and '"total_token_usage"' in line:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            tu = ((d.get("payload") or {}).get("info") or {}).get("total_token_usage") or {}
            if not tu:
                continue
            cur = [_num(tu.get("input_tokens")), _num(tu.get("cached_input_tokens")), _num(tu.get("output_tokens")), _num(tu.get("cache_write_input_tokens"))]
            prev = s["ctot"] or [0, 0, 0, 0]
            if cur[0] < prev[0]:
                prev = [0, 0, 0, 0]  # a new count (a resumed thread starts over)
            delta = [max(0, c - p) for c, p in zip(cur, prev)]
            s["ctot"] = cur
            day = day_of_iso(d.get("timestamp"))
            _touch(s, day)
            _tokens(s, day, s["model"] or "?", (max(0, delta[0] - delta[1]), delta[2], delta[1], delta[3], 0))
        elif '"type":"turn_context"' in line:
            m = re.search(r'"model":"([^"]+)"', line)
            if m:
                s["model"] = m.group(1)
            if not s["cwd"]:
                m = re.search(r'"cwd":"([^"]+)"', line)
                if m:
                    s["cwd"] = m.group(1)
        elif '"type":"response_item"' in line and ('"payload":{"type":"function_call"' in line or '"payload":{"type":"custom_tool_call"' in line):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            p = d.get("payload") or {}
            day = day_of_iso(d.get("timestamp"))
            _touch(s, day)
            name = p.get("name") or ""
            _bump(s["tl"], name, day)
            args = p.get("arguments") if p.get("type") == "function_call" else p.get("input")
            for sk in set(RE_SKILL_FILE.findall(args if isinstance(args, str) else json.dumps(args or ""))):
                _bump(s["sk"], sk, day)


# -- Pi

def fold_pi(s, buf, first):
    for line in buf.split("\n"):
        if not line.startswith("{"):
            continue
        if first and not s["cwd"] and '"type":"session"' in line:
            try:
                d = json.loads(line)
                s["cwd"], s["sid"] = d.get("cwd") or "", d.get("id") or s["sid"]
            except ValueError:
                pass
            continue
        if '"type":"message"' not in line:
            continue
        if '"role":"toolResult"' in line:
            if '"isError":true' not in line:
                m = re.search(r'"toolCallId":"([^"]+)"', line)
                if m:
                    s["pend"].pop(m.group(1), None)
                continue
            try:
                m = (json.loads(line).get("message") or {})
            except ValueError:
                continue
            p = s["pend"].pop(m.get("toolCallId") or "", None)
            if p and m.get("isError"):
                _err(s["tl"], p[1], p[2])
            continue
        if '"role":"assistant"' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        m = d.get("message") or {}
        if m.get("role") != "assistant":
            continue
        day = day_of_iso(d.get("timestamp"))
        _touch(s, day)
        model = m.get("model") or "?"
        u = m.get("usage") or {}
        if u:
            _tokens(s, day, model, (_num(u.get("input")), _num(u.get("output")), _num(u.get("cacheRead")), _num(u.get("cacheWrite")), 0))
            cost = (u.get("cost") or {}).get("total") if isinstance(u.get("cost"), dict) else u.get("cost")
            if isinstance(cost, (int, float)) and cost > 0:
                row = s["usd"].setdefault(day, {})
                row[model] = row.get(model, 0) + float(cost)
            if m.get("provider"):
                s["prov"][model] = m["provider"]
        for b in m.get("content") or []:
            if isinstance(b, dict) and b.get("type") == "toolCall":
                _bump(s["tl"], b.get("name") or "", day)
                if b.get("id"):
                    s["pend"][b["id"]] = ["t", b.get("name") or "", day]


FOLDS = {"claude-code": lambda s, buf, first: fold_claude(s, buf), "codex": fold_codex, "pi": fold_pi}


def read_file(path, engine, s=None):
    """Fold what transcript `path` gained since summary `s` last saw it (whole lines; a record a live writer is still
    halfway through waits for the next reading). A file that shrank or a summary of an older shape is read again from
    the start."""
    st = os.stat(path)
    if not s or s.get("v") != SCAN_V or st.st_size < s.get("off", 0):
        s = new_summary(path, engine)
    if engine == "claude-code" and s["sub"] and not s["sid"]:
        s["sid"] = path.split("/subagents/")[0].rsplit("/", 1)[-1]
    if engine == "pi" and not s["sid"]:
        b = os.path.splitext(os.path.basename(path))[0]
        s["sid"] = b.split("_", 1)[1] if "_" in b else b
    if engine == "codex" and not s["sid"]:
        m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", os.path.basename(path))
        s["sid"] = m.group(1) if m else os.path.basename(path)
    fold = FOLDS[engine]
    end, pos = st.st_size, s["off"]
    first = pos == 0
    with open(path, "rb") as f:
        f.seek(pos)
        while pos < end:
            raw = f.read(min(CHUNK, end - pos))
            if not raw:
                break
            pos += len(raw)
            if pos < end and not raw.endswith(b"\n"):
                rest = f.readline(end - pos)
                raw += rest
                pos += len(rest)
            if pos >= end and not raw.endswith(b"\n"):
                tail = raw.rsplit(b"\n", 1)[-1]
                try:
                    json.loads(tail)
                except (ValueError, UnicodeDecodeError):
                    raw = raw[:-len(tail)]
                    pos -= len(tail)
                    end = pos
            fold(s, raw.decode("utf-8", "replace"), first)
            first = False
    s["off"], s["size"], s["mtime"] = pos, st.st_size, st.st_mtime
    if len(s["pend"]) > 2000:  # calls that never got an answer (a session killed mid-tool): keep the newest
        s["pend"] = dict(list(s["pend"].items())[-500:])
    return s


# ---- every file ----------------------------------------------------------------------------------------------------------

def transcript_files(home=None):
    """(path, engine) of the JSON-lines transcripts: Claude Code's, Codex's and Pi's."""
    home = home or os.path.expanduser("~")
    import glob
    out = []
    claude_dirs = [os.path.join(home, ".claude", "projects")]
    cfg = os.environ.get("CLAUDE_CONFIG_DIR")
    if cfg:
        claude_dirs.append(os.path.join(os.path.expanduser(cfg), "projects"))
    seen = set()
    for d in claude_dirs:
        # sub-agents in <session>/subagents/, a workflow's in <session>/subagents/workflows/<run>/
        for p in glob.glob(os.path.join(d, "**", "*.jsonl"), recursive=True):
            if p not in seen:
                seen.add(p)
                out.append((p, "claude-code"))
    codex = os.environ.get("CODEX_HOME") or os.path.join(home, ".codex")
    for p in glob.glob(os.path.join(codex, "sessions", "**", "*.jsonl"), recursive=True):
        out.append((p, "codex"))
    for p in glob.glob(os.path.join(home, ".pi", "agent", "sessions", "*", "*.jsonl")):
        out.append((p, "pi"))
    return out


def workers():
    try:
        return max(1, min(8, int(os.environ.get("DISPATCH_USAGE_WORKERS") or 0) or (os.cpu_count() or 4) - 2))
    except ValueError:
        return 2


def _parallel(todo, n, on_done):
    """Read the (path, engine, summary) of `todo` with `n` helper processes. Returns what they could not read."""
    import queue
    work = queue.Queue()
    for t in todo:
        work.put(t)
    failed, lock = [], threading.Lock()

    def helper():
        proc = subprocess.Popen([sys.executable, os.path.abspath(__file__), "--worker"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
                                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        try:
            while True:
                try:
                    path, eng, s = work.get_nowait()
                except queue.Empty:
                    return
                try:
                    proc.stdin.write(json.dumps({"path": path, "eng": eng, "s": s}) + "\n")
                    proc.stdin.flush()
                    ans = json.loads(proc.stdout.readline() or "null")
                except (OSError, ValueError):
                    ans = None
                with lock:
                    if isinstance(ans, dict) and isinstance(ans.get("s"), dict):
                        on_done(path, ans["s"])
                    else:
                        failed.append((path, eng, s))
                if ans is None:
                    return
        finally:
            try:
                proc.stdin.close()
            except OSError:
                pass
            try:
                proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                proc.terminate()
                proc.wait(timeout=5)
            proc.stdout.close()

    threads = [threading.Thread(target=helper, daemon=True) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    while not work.empty():
        failed.append(work.get_nowait())
    return failed


def worker_main():
    if hasattr(os, "nice"):
        try:
            os.nice(10)
        except OSError:
            pass
    out = os.fdopen(os.dup(1), "w", encoding="utf-8")
    sys.stdout = sys.stderr
    for line in sys.stdin:
        try:
            req = json.loads(line)
            ans = {"s": read_file(req["path"], req["eng"], req.get("s"))}
        except Exception as ex:  # the parent reads this file itself and says what went wrong
            ans = {"error": f"{type(ex).__name__}: {ex}"}
        out.write(json.dumps(ans) + "\n")
        out.flush()


def scan(cache_path, files=None, now=None, progress=None, parallel_bytes=64 << 20):
    """Bring the summaries in `cache_path` up to date with the transcripts on disk; returns {path: summary}.
    `progress(done, total)` is called as files are read."""
    now = now or time.time()
    files = transcript_files() if files is None else files
    try:
        with open(cache_path, encoding="utf-8") as f:
            cache = json.load(f)
        if cache.get("v") != SCAN_V:
            cache = {}
    except (OSError, ValueError):
        cache = {}
    old = cache.get("files") or {}
    out, todo = {}, []
    for path, eng in files:
        try:
            st = os.stat(path)
        except OSError:
            continue
        if now - st.st_mtime > KEEP_DAYS * 86400:
            continue
        s = old.get(path)
        if s and s.get("v") == SCAN_V and s.get("size") == st.st_size and s.get("mtime") == st.st_mtime:
            out[path] = s
            continue
        todo.append((path, eng, s, st.st_size - (s or {}).get("off", 0) if s and st.st_size >= s.get("off", 0) else st.st_size))
    total, done = len(todo), [0]

    def got(path, s):
        out[path] = s
        done[0] += 1
        if progress:
            progress(done[0], total)

    if progress:
        progress(0, total)
    todo.sort(key=lambda t: -t[3])
    left = [(p, e, s) for p, e, s, _ in todo]
    if total > 1 and sum(t[3] for t in todo) >= parallel_bytes and workers() > 1:
        left = _parallel(left, min(workers(), total), got)
    for path, eng, s in left:
        try:
            got(path, read_file(path, eng, s))
        except OSError:
            continue
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    tmp = "%s.%d.tmp" % (cache_path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"v": SCAN_V, "files": out}, f, separators=(",", ":"))
    os.replace(tmp, cache_path)
    return out


# ---- the SQLite stores (OpenCode, ZCode) ---------------------------------------------------------------------------------

def sqlite_summaries(engine, query, since_ms):
    """One summary per session of an OpenCode-shaped store (message / part / session tables), for the sessions active
    since `since_ms`. `query(sql, args)` gives rows as dicts."""
    out = {}
    sessions = {r["id"]: r for r in query("select id, parent_id, directory, title from session where time_updated >= ?", (since_ms,))}

    def summary(sid):
        r = sessions.get(sid) or {}
        top = sid
        seen = set()
        while sessions.get(top, {}).get("parent_id") and top not in seen:
            seen.add(top)
            top = sessions[top]["parent_id"]
        s = out.get(sid)
        if s is None:
            s = out[sid] = new_summary("", engine)
            s.update(sid=top, sub=top != sid, cwd=r.get("directory") or "", title=r.get("title") or "")
        return s

    for m in query("select session_id, time_created, data from message where time_created >= ? and json_extract(data, '$.role') = 'assistant'", (since_ms,)):
        if m["session_id"] not in sessions:
            continue
        try:
            d = json.loads(m["data"])
        except ValueError:
            continue
        s = summary(m["session_id"])
        day = day_of_ms(m["time_created"])
        _touch(s, day)
        tk = d.get("tokens") or {}
        c = tk.get("cache") or {}
        model = d.get("modelID") or "?"
        _tokens(s, day, model, (_num(tk.get("input")), _num(tk.get("output")) + _num(tk.get("reasoning")), _num(c.get("read")), _num(c.get("write")), 0))
        cost = d.get("cost")
        if isinstance(cost, (int, float)) and cost > 0:
            row = s["usd"].setdefault(day, {})
            row[model] = row.get(model, 0) + float(cost)
        if d.get("providerID"):
            s["prov"][model] = d["providerID"]
    for p in query("select session_id, time_created, json_extract(data, '$.tool') tool, json_extract(data, '$.state.status') status, "
                   "json_extract(data, '$.state.input.name') skill from part where time_created >= ? and json_extract(data, '$.type') = 'tool'", (since_ms,)):
        if p["session_id"] not in sessions or not p["tool"]:
            continue
        s = summary(p["session_id"])
        day = day_of_ms(p["time_created"])
        failed = 1 if p["status"] == "error" else 0
        _bump(s["tl"], p["tool"], day, 1, failed)
        if p["tool"] == "skill" and p["skill"]:
            _bump(s["sk"], p["skill"], day, 1, failed)
    return {f"{engine}:{k}": v for k, v in out.items()}


if __name__ == "__main__" and "--worker" in sys.argv:
    worker_main()
