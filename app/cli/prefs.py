# -*- coding: utf-8 -*-
"""Preferences: how the person likes things done, remembered from what they say about deliveries.

  dispatch prefs add "<one sentence>" --like|--avoid [--name <short name>] [--area design|workflow|writing|tools]
                 [--scope everywhere|<project>[:<surface>]] [--quote "<their words>"] [--part "<file>#<region>"]
                 [--evidence <file or URL>]… [--replaces <name or id>]… [--batch] [--json]
  dispatch prefs list [--area A] [--project P] [--new] [--stale] [--all] [--ids a,b] [--thumbs chip] [--json]
  dispatch prefs show <name or id> [--thumbs card] [--json]
  dispatch prefs edit <name or id> [--text …] [--name …] [--like|--avoid] [--area …] [--scope …] [--quote …]
                 [--part …] [--evidence …] [--replaces …] [--json]
  dispatch prefs forget <name or id>… [--json]      out of the store, into ~/.dispatch/backups/preferences/
  dispatch prefs undo [<id>] [--json]               bring back what the last forget took out
  dispatch prefs cite <name or id>… [--by who] [--for what] [--ref <reply id>]   an agent followed it
  dispatch prefs keep <name or id>…                  "Still true? Yes": not asked again for 90 days
  dispatch prefs seen [<name or id>… | --all]        no longer New (the Knowledge page, once looked at)
  dispatch prefs stale [--days 21] [--json]          active ones nobody followed for that long
  dispatch prefs import [--from facts,memory,taste,profile,codex,design] [-P project] [--dry-run | --apply]
                 [--plan FILE] [--out FILE] [--json]
  dispatch prefs prime [-P project]                  the section `dispatch prime` injects

Where they come from (kanban design/knowledge/redesign/README.md 2, DECISIONS.md「Knowledge 和偏好记忆」):
after an agent delivers something it reads the person's next message as feedback. No verdict is neutral
and nothing is kept; "good" is a Like of the part they meant, "not good" an Avoid of it; picking a
direction is a Like of the picked one with the reason (the others are not Avoids); "from now on …" is
kept without a delivery, the words being the evidence. Kept at once, no confirmation: the window says
"Preference remembered" with Edit and Undo.

Storage, with Dispatch's other data (dispatch_dir: ~/.dispatch, DISPATCH_HOME for tests and instances):
  preferences.jsonl                 one entry per line
  preferences/evidence/<id>/        copies of the evidence (images as they were) and card.jpg / chip.jpg
  preferences/imports.json          what `import --apply` took from where, and when the sources may change
  backups/preferences/<time>.jsonl  what forget took out ({"op": "forget", "at", "entry"} a line)

An entry: id (pref-xxxx) · name (the short name agents cite) · text (one sentence an agent can follow) ·
polarity like|avoid · area · scope everywhere | <project> | <project>:<surface> · quote (their words) ·
quotes [{text, at, source}] · part "<file>#<region>" and part_path · evidence [file or URL] · thumbs ·
replaces [ids] · replaced_by · status active|replaced · created · updated · said {at, engine, session,
project, cwd} · seen · used · last_used · kept_at · sources [{kind, path, line, label, at}] · also_in
[rule files that already say it] · history [{at, event, detail}].
"""
import sys

sys.dont_write_bytecode = True

import base64
import contextlib
import datetime
import hashlib
import json
import os
import re
from lang import t as _t
import secrets
import shutil
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import dispatch_dir  # noqa: E402

D = None  # dispatch.py, bound by run(); imported on first use otherwise (tests)

AREAS = ("design", "workflow", "writing", "tools")
AREA_LABEL = {"design": "Design", "workflow": "Workflow", "writing": "Writing", "tools": "Tools"}
AREA_ZH = {"design": "设计", "workflow": "做事", "writing": "写作", "tools": "工具"}
AREA_DESC = {
    "design": "How interfaces look, and how design work is shown to you.",
    "workflow": "How agents plan, hand off, check and report.",
    "writing": "How text for you and for other people reads.",
    "tools": "Which models, services and tools to use.",
}
POLARITIES = ("like", "avoid")
STALE_DAYS = 21
KEEP_DAYS = 90
PRIME_LIMIT = 30
PRIME_CHARS = 1500
HISTORY_KEEP = 40
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".bmp", ".tif", ".tiff")
PAGE_EXT = (".html", ".htm")
CARD_W, CHIP_W = 480, 120
ID_RE = re.compile(r"^pref-[a-z0-9]{4,10}$")
REF_KEEP = 60


class PrefsError(ValueError):
    """A problem the person or agent can fix (unknown name, empty sentence); exit code 1."""


def _d():
    global D
    if D is None:
        import dispatch as _dispatch  # noqa: E402  (tests; the CLI binds D in run())
        D = _dispatch
    return D


# ---------------------------------------------------------------- time

def now():
    return datetime.datetime.now().astimezone()


def iso(t=None):
    return (t or now()).isoformat(timespec="seconds")


def parse_time(s):
    """An ISO time or a date (YYYY-MM-DD) as an aware datetime; None when it is neither."""
    if not s or not isinstance(s, str):
        return None
    s = s.strip()
    try:
        if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
            return datetime.datetime.strptime(s, "%Y-%m-%d").astimezone()
        t = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
        return t if t.tzinfo else t.astimezone()
    except ValueError:
        return None


def days_since(s, ref=None):
    t = parse_time(s)
    if not t:
        return None
    return ((ref or now()) - t).total_seconds() / 86400


# ---------------------------------------------------------------- files

def store_path():
    return dispatch_dir.path("preferences.jsonl")


def evidence_root():
    return dispatch_dir.path("preferences", "evidence")


def evidence_dir(pid):
    return os.path.join(evidence_root(), pid)


def backups_dir():
    return dispatch_dir.path("backups", "preferences")


def imports_path():
    return dispatch_dir.path("preferences", "imports.json")


@contextlib.contextmanager
def locked():
    """One writer at a time: agents in several sessions may add at once. fcntl where there is one;
    elsewhere the atomic replace alone (a lost race drops the other write, never corrupts the file)."""
    os.makedirs(dispatch_dir.path("preferences"), exist_ok=True)
    fh = None
    try:
        import fcntl
        fh = open(dispatch_dir.path("preferences", ".lock"), "a")
        fcntl.flock(fh, fcntl.LOCK_EX)
    except (ImportError, OSError):
        fh = None
    try:
        yield
    finally:
        if fh:
            fh.close()


def load(path=None):
    """Every entry in the store, in file order. A line that is not an entry is skipped (and kept out
    of the next write only if it cannot be parsed at all)."""
    out = []
    try:
        with open(path or store_path(), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if isinstance(e, dict) and e.get("id") and e.get("text"):
                    out.append(e)
    except FileNotFoundError:
        pass
    return out


def save(entries, path=None):
    path = path or store_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n")
    replace = getattr(_dplatform(), "replace_retry", None) or os.replace
    replace(tmp, path)


def _dplatform():
    try:
        import dplatform
        return dplatform
    except Exception:
        return os


def backup(op, entries, at=None):
    """Append removed entries to a backup file of this minute; returns its path."""
    at = at or now()
    d = backups_dir()
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, at.strftime("%Y%m%d-%H%M%S") + ".jsonl")
    with open(p, "a", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps({"op": op, "at": iso(at), "entry": e}, ensure_ascii=False) + "\n")
    return p


def backup_records():
    """Every record in the backups, oldest first: [(path, record)]."""
    rows = []
    d = backups_dir()
    try:
        names = sorted(n for n in os.listdir(d) if n.endswith(".jsonl"))
    except FileNotFoundError:
        return rows
    for n in names:
        p = os.path.join(d, n)
        try:
            with open(p, encoding="utf-8") as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(r, dict) and isinstance(r.get("entry"), dict):
                        rows.append((p, r))
        except OSError:
            continue
    return rows


# ---------------------------------------------------------------- text

_PUNCT = re.compile(r"[\s　-〿＀-￯`~!@#$%^&*()_+\-=\[\]{}|;:'\",.<>/?\\「」『』（）【】《》“”‘’…·—–]+")
# words that say nothing about what is preferred; single characters only where they cannot sit inside a word
_NOISE = re.compile(r"\d{4}-\d{2}(?:-\d{2})?|用户|他们|他|我们|我|你|的|了|一律|一定|所有|任何|这种|这个|那个")


def norm(s):
    s = (s or "").lower()
    s = _NOISE.sub("", s)
    return _PUNCT.sub("", s)


def grams(s):
    n = norm(s)
    if len(n) < 2:
        return {n} if n else set()
    return {n[i:i + 2] for i in range(len(n) - 1)}


def similarity(a, b):
    """0..1: how much two sentences say the same thing, by shared character pairs (Chinese has no
    spaces; English words share their letters too). The mean of the overlap coefficient (a short
    sentence inside a long one) and Jaccard (the two as a whole)."""
    A, B = grams(a), grams(b)
    if not A or not B:
        return 0.0
    inter = len(A & B)
    return (inter / min(len(A), len(B)) + inter / len(A | B)) / 2


SAME = 0.74      # the same preference said again
IMPORT_SAME = 0.5  # the old places say the same thing in different words (FACTS sums up design/taste)
CLOSE = 0.42     # worth showing as "close to" when a new one comes in

# a sentence that starts with a "don't", or says one of the strong ones anywhere; "…，结尾不挂菜单"
# after a positive main clause stays a Like
_AVOID_RE = re.compile(r"^(?:不要|别|不许|避免|不用|禁止|不喜欢|不能|不再|少用|avoid|don'?t|never|no )|(?:不要|不用|别用|不许|避免|禁止|不出现|不派)", re.I)


def guess_polarity(text):
    """avoid when the sentence starts with a "don't", says one of the strong ones anywhere, or its last
    clause is a "not …" (「课件是版权材料，不公开分发」); like otherwise."""
    t = (text or "").strip()
    if _AVOID_RE.search(t):
        return "avoid"
    clauses = depth_split(re.sub(r"[。.!！]+$", "", t), "，,；;")
    # "…选标题栏按钮，不选账号菜单" picks something: the "not" at the end is the contrast
    picks = len(clauses) > 1 and re.search(r"选|用|要|喜欢", clauses[0])
    return "avoid" if clauses and not picks and re.match(r"^(?:不|别|禁止)", clauses[-1]) else "like"


_AREA_WORDS = [
    ("tools", r"模型|Fable|Opus|Sonnet|Haiku|GLM|DeepSeek|Kimi|Whisper|ASR|API\b|API ?Key|端点|endpoint|FCP|Final Cut|Codex CLI|插件市场|数据库|密钥|dispatch env|humanizer"),
    ("writing", r"文案|写作|措辞|语气|汇报|报告|结论先|结尾|要不要我|英文|中文|德文|翻译|AI 味|去 AI|用词|标题|说明文字|口吻|大白话|破折号|邮件|消息"),
    ("workflow", r"派|子 ?Agent|任务|提交|commit|交付|designer|先.*再|流程|分工|讨论|验收|评审|复审|收尾|记住|确认|登记|挂到|推送|push|分支|构建|测试|步骤"),
    ("design", r"界面|设计|UI|布局|颜色|配色|字体|字号|图标|动效|动画|圆角|胶囊|开关|按钮|卡片?|列表|分组|侧栏|左栏|右栏|页签|页面|截图|原型|样子|审美|好看|丑|留白|间距|对齐|头像|弹层|输入框|暗色|深色|主题"),
]


def guess_area(text, default="workflow"):
    """design / workflow / writing / tools by the words in it; `default` when nothing says otherwise."""
    t = text or ""
    # a model or service by name says more than the verbs around it
    scores = {a: len(re.findall(p, t, re.I)) * (2 if a == "tools" else 1) for a, p in _AREA_WORDS}
    best = max(scores.items(), key=lambda kv: kv[1])
    return best[0] if best[1] else default


def clip(s, n):
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip("，,、；;：: ") + "…"


def _width(s):
    return sum(1 if re.match(r"[⺀-鿿＀-￯]", ch) else 0.5 for ch in s)


_LEAD_NEG = re.compile(r"^(?:不要|别再?|避免|不许|禁止|要[：:])\s*")


def derive_name(text, limit=12):
    """A short name when none was given: the sentence up to its first colon, comma or bracket, at most
    `limit` wide (a Chinese character counts 1, a Latin letter half), without a dangling word."""
    t = _LEAD_NEG.sub("", " ".join((text or "").split())).strip()
    m = re.match(r"^(.{4,60}?)(?:[：:，,；;。（(「]|、|——|\s-\s|$)", t)
    head = re.sub(r"[「」『』`]", "", (m.group(1) if m else t)).strip()
    out = ""
    for ch in head:
        if _width(out + ch) > limit:
            break
        out += ch
    if out != head and re.search(r"[A-Za-z]$", out) and " " in out:
        out = out.rsplit(" ", 1)[0]
    elif out != head:
        # cut in the middle of a word: back off to the last joint (…分段控件|用稍微圆 → …分段控件)
        joint = max((i for i, ch in enumerate(out) if ch in _JOINTS and _width(out[:i]) >= 4), default=-1)
        if joint > 0:
            out = out[:joint]
    return re.sub(r"[\s、，,；;：:的用是要和与在把被]+$", "", out) or head[:limit]


_JOINTS = set("的用是要和与跟在把被时前后里上中都只")


def lead_of(text):
    """The part of a sentence that names the thing: before its first colon, without a leading 不要."""
    t = _LEAD_NEG.sub("", " ".join((text or "").split()))
    return re.split(r"[：:]", t, maxsplit=1)[0]


def same_thing(a, b):
    """How much two candidates mean the same preference, whichever way round they say it: the whole
    sentences, and the lead of each against the other (a summary "同一功能多个入口" against a full
    "一个功能一个入口：……")."""
    la, lb = lead_of(a), lead_of(b)
    # a lead of a few characters says too little to decide on, and two sentences that both start with
    # the same topic ("多机器方案：a" / "多机器方案：b") are two things said about it
    both = depth_colon(_LEAD_NEG.sub("", a)) >= 0 and depth_colon(_LEAD_NEG.sub("", b)) >= 0
    leads = similarity(la, lb) if not both and min(len(norm(la)), len(norm(lb))) >= 5 else 0.0
    return max(similarity(_LEAD_NEG.sub("", a), _LEAD_NEG.sub("", b)), leads)


def scope_parse(s):
    """everywhere | <project> | <project>:<surface>, normalised: 'Everywhere', '', 'all' → everywhere."""
    s = " ".join((s or "").split())
    if not s or s.lower() in ("everywhere", "all", "global", "*", "全局", "所有", "到处"):
        return "everywhere"
    if ":" in s:
        p, surface = s.split(":", 1)
        p, surface = p.strip(), surface.strip()
        if not p:
            raise PrefsError("scope: the project before the colon is missing")
        return f"{p}:{surface}" if surface else p
    return s


def scope_parts(scope):
    scope = scope or "everywhere"
    if scope == "everywhere":
        return "", ""
    p, _, surface = scope.partition(":")
    return p, surface


def scope_rank(scope):
    """2 a surface of a project, 1 a project, 0 everywhere: the narrow one wins."""
    p, surface = scope_parts(scope)
    return 2 if surface else (1 if p else 0)


def scope_applies(scope, project):
    p, _ = scope_parts(scope)
    return not p or (bool(project) and p.lower() == (project or "").lower())


def scope_label(scope):
    p, surface = scope_parts(scope)
    if not p:
        return "Everywhere"
    return f"{p} · {surface}" if surface else p


# ---------------------------------------------------------------- the caller

def caller_said(cwd=None):
    """Who is remembering this and where: the engine and session of the agent running us (its env,
    else the presence registry), the project of the working folder, now."""
    cwd = os.path.abspath(cwd or os.getcwd())
    engine, session = "", ""
    try:
        d = _d()
        session = d.session_self() or ""
        engine = d.agent_actor() if d.is_agent_caller() else "person"
    except Exception:
        pass
    if engine == "agent":
        engine = ""
    return {"at": iso(), "engine": engine, "session": session, "project": project_of(cwd), "cwd": cwd}


def project_of(cwd):
    """The project a folder belongs to: the repository it is in (a worktree counts as its
    repository), without asking the board."""
    try:
        return _d().git_root_name(cwd) or ""
    except Exception:
        return ""


def repo_root(cwd):
    d = os.path.abspath(cwd or os.getcwd())
    while d and d != os.path.dirname(d):
        g = os.path.join(d, ".git")
        if os.path.isdir(g):
            return d
        if os.path.isfile(g):
            try:
                import ide_sessions
                return ide_sessions.repo_root(d) or d
            except Exception:
                return d
        d = os.path.dirname(d)
    return ""


def rules_file(name):
    """~/.dispatch/rules/<name>; before `dispatch dir migrate`, ~/.agents/rules/<name>. With
    DISPATCH_HOME set (tests, a test instance) only that folder counts."""
    p = dispatch_dir.path("rules", name)
    if os.path.isfile(p) or os.environ.get("DISPATCH_HOME", "").strip():
        return p
    return os.path.join(os.path.expanduser("~"), ".agents", "rules", name)


def rules_files(cwd=None):
    """The rule files the person writes by hand, whose sentences prime does not repeat: GLOBAL.md and
    the project's CLAUDE.md / AGENTS.md. [(label, path)] of the ones that exist."""
    out = []
    g = rules_file("GLOBAL.md")
    if os.path.isfile(g):
        out.append(("GLOBAL.md", g))
    root = repo_root(cwd) if cwd else ""
    for name in ("CLAUDE.md", "AGENTS.md"):
        p = os.path.join(root, name) if root else ""
        if p and os.path.isfile(p):
            out.append((f"{os.path.basename(root)} {name}", p))
    return out


_RULE_CACHE = {}


def _rule_grams(path):
    """The bigram sets of a rule file's lines, cached per (path, mtime): prime checks every entry."""
    try:
        mt = os.path.getmtime(path)
    except OSError:
        return []
    hit = _RULE_CACHE.get(path)
    if hit and hit[0] == mt:
        return hit[1]
    text = _read(path)
    rows = [grams(l.strip(" -*>\t")) for l in text.splitlines() if len(l.strip()) > 8]
    rows = [g for g in rows if g]
    _RULE_CACHE[path] = (mt, rows)
    return rows


def also_in(text, cwd=None, files=None):
    """The rule files that already say this (one of their lines holds the sentence almost whole):
    prime leaves it out, the page says "also in GLOBAL.md"."""
    A = grams(text)
    if len(A) < 4:
        return []
    hits = []
    for label, path in (files if files is not None else rules_files(cwd)):
        for B in _rule_grams(path):
            inter = len(A & B)
            if inter / len(A) >= 0.8 and (inter / min(len(A), len(B)) + inter / len(A | B)) / 2 >= 0.5:
                hits.append(label)
                break
    return hits


# FACTS.md's topic of design preferences: Chinese in older files, English once Dispatch rewrote the file's
# headings (dispatch.facts_normalize). The two names are one topic.
DESIGN_TOPICS = ("我的设计偏好", "Design preferences")


def topic_names(label):
    """A FACTS.md topic and the other name it goes by."""
    return set(DESIGN_TOPICS) if label in DESIGN_TOPICS else {label}


def imported_topics(entries=None):
    """The FACTS.md topics whose entries now live here (an import took them, none of them still waits
    for the person's pick): prime stops giving them as facts. {'我常说的话', '我的设计偏好', 'Design preferences'}
    or a part of it."""
    out = set()
    for e in load() if entries is None else entries:
        for src in e.get("sources") or []:
            label = src.get("label") or ""
            if src.get("kind") == "facts" and "·" in label:
                out |= topic_names(label.split("·")[1].strip())
    return out - pending_topics()


# ---------------------------------------------------------------- lookups

def new_id(taken):
    while True:
        pid = "pref-" + "".join(secrets.choice("abcdefghijkmnpqrstuvwxyz23456789") for _ in range(4))
        if pid not in taken:
            return pid


def find(entries, key, statuses=("active",)):
    """The entry a person or agent means: its id, its short name, or a unique part of the name or
    sentence. PrefsError when there is none or several."""
    key = (key or "").strip()
    if not key:
        raise PrefsError("which preference? give its short name or id")
    pool = [e for e in entries if not statuses or e.get("status", "active") in statuses]
    for e in pool:
        if e["id"] == key:
            return e
    exact = [e for e in pool if (e.get("name") or "").lower() == key.lower()]
    if len(exact) == 1:
        return exact[0]
    part = [e for e in pool if key.lower() in (e.get("name") or "").lower() or key.lower() in e["text"].lower()]
    if len(part) == 1:
        return part[0]
    if not exact and not part:
        raise PrefsError(f"no preference called 「{key}」 (dispatch prefs list)")
    names = "、".join(f"{e.get('name')} ({e['id']})" for e in (exact or part)[:6])
    raise PrefsError(f"「{key}」 matches several: {names}; use the id")


def similar(entries, text, area=None, skip=(), limit=5):
    rows = []
    for e in entries:
        if e.get("status", "active") != "active" or e["id"] in skip:
            continue
        if area and e.get("area") != area:
            continue
        s = similarity(text, e["text"])
        if s >= CLOSE:
            rows.append((s, e))
    rows.sort(key=lambda x: -x[0])
    return rows[:limit]


def event(e, what, detail="", at=None, **extra):
    h = e.setdefault("history", [])
    rec = {"at": iso(at), "event": what}
    if detail:
        rec["detail"] = detail
    rec.update({k: v for k, v in extra.items() if v not in (None, "", [], {})})
    h.append(rec)
    if len(h) > HISTORY_KEEP:
        del h[: len(h) - HISTORY_KEEP]


# ---------------------------------------------------------------- evidence

def _is_url(s):
    return bool(re.match(r"^https?://", s or "", re.I))


def split_part(part, cwd):
    """'<file>#<region>' → (as given, absolute path of the file when it exists, region)."""
    part = (part or "").strip()
    if not part:
        return "", "", ""
    if _is_url(part):
        base, _, region = part.partition("#")
        return part, base, region
    path, _, region = part.partition("#")
    p = os.path.abspath(os.path.join(cwd, os.path.expanduser(path))) if path else ""
    return part, (p if p and os.path.exists(p) else ""), region


def page_title(path):
    """The <title> of an HTML delivery, for the evidence card; "" when it has none."""
    if not path or not path.lower().endswith(PAGE_EXT):
        return ""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            head = f.read(65536)
    except OSError:
        return ""
    m = re.search(r"<title[^>]*>(.*?)</title>", head, re.I | re.S)
    return " ".join(m.group(1).split())[:120] if m else ""


def _run(argv, timeout=60):
    try:
        return subprocess.run(argv, capture_output=True, timeout=timeout).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def make_thumb(src, dst, width):
    """A JPEG `width` wide (never wider than the source) from an image: sips on macOS, else Pillow,
    else a plain copy. True when dst exists afterwards."""
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    sips = shutil.which("sips") or ("/usr/bin/sips" if os.path.exists("/usr/bin/sips") else "")
    if sips and _run([sips, "-s", "format", "jpeg", "-s", "formatOptions", "82", "--resampleWidth", str(width), src, "--out", dst]):
        return os.path.exists(dst)
    try:
        from PIL import Image
        with Image.open(src) as im:
            im = im.convert("RGB")
            if im.width > width:
                im = im.resize((width, max(1, round(im.height * width / im.width))))
            im.save(dst, "JPEG", quality=82)
        return True
    except Exception:
        pass
    try:
        shutil.copyfile(src, dst)
        return True
    except OSError:
        return False


CHROME_PATHS = ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")


def page_shot(target, dst, width=1280, height=800):
    """A screenshot of a page (a file or URL, `#region` scrolls it into view) with headless Chrome.
    False when there is no Chrome. A fresh profile reaches for the login keychain unless told not to,
    and with no keychain at hand (a test's HOME) macOS puts "A keychain cannot be found" on the screen."""
    chrome = next((p for p in CHROME_PATHS if os.path.exists(p)), "")
    if not chrome:
        return False
    url = target if _is_url(target) else "file://" + target
    prof = os.path.join(os.path.dirname(dst), ".chrome")
    ok = _run([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
               "--use-mock-keychain", "--password-store=basic", f"--user-data-dir={prof}", f"--window-size={width},{height}",
               "--virtual-time-budget=3000", f"--screenshot={dst}", url], timeout=60)
    shutil.rmtree(prof, ignore_errors=True)
    return ok and os.path.exists(dst)


def thumb_source(e):
    """The image the thumbnails are made from, or a page to photograph: [(kind, path_or_url)] in
    order of preference: an image of the evidence, the delivery's own preview image, the page."""
    out = []
    for ev in e.get("evidence") or []:
        if not _is_url(ev) and ev.lower().endswith(IMAGE_EXT) and os.path.exists(ev):
            out.append(("image", ev))
    pp = e.get("part_path") or ""
    if pp and pp.lower().endswith(IMAGE_EXT):
        out.append(("image", pp))
    pages = [pp] if pp and pp.lower().endswith(PAGE_EXT) else []
    pages += [ev for ev in e.get("evidence") or [] if (not _is_url(ev) and ev.lower().endswith(PAGE_EXT)) or _is_url(ev)]
    for page in pages:
        if not _is_url(page):
            for name in ("preview.png", "00-where-is-what.png", "preview.jpg"):
                p = os.path.join(os.path.dirname(page), name)
                if os.path.exists(p):
                    out.append(("image", p))
                    break
    region = (e.get("part") or "").partition("#")[2]
    for page in pages:
        out.append(("page", page + (f"#{region}" if region and not _is_url(page) and page == pp else "")))
    return out


def copy_images(e):
    """Every screenshot of the evidence copied into the entry's folder (the detail page shows each one,
    and a moved or deleted original still shows)."""
    d = evidence_dir(e["id"])
    for ev in e.get("evidence") or []:
        if _is_url(ev) or not ev.lower().endswith(IMAGE_EXT) or not os.path.exists(ev):
            continue
        copy = os.path.join(d, os.path.basename(ev))
        if os.path.exists(copy) or os.path.abspath(ev) == os.path.abspath(copy):
            continue
        try:
            os.makedirs(d, exist_ok=True)
            shutil.copyfile(ev, copy)
        except OSError:
            pass


def make_thumbs(e, allow_page=True):
    """card.jpg and chip.jpg in the entry's evidence folder, from its first image (copied in first,
    so a moved or deleted original still shows) or a photo of its page. Returns the paths made."""
    d = evidence_dir(e["id"])
    made = []
    copy_images(e)
    for kind, src in thumb_source(e):
        if kind == "image":
            os.makedirs(d, exist_ok=True)
            copy = os.path.join(d, os.path.basename(src))
            if os.path.abspath(src) != os.path.abspath(copy):
                try:
                    shutil.copyfile(src, copy)
                except OSError:
                    continue
            base = copy
        elif allow_page:
            base = os.path.join(d, "page.png")
            os.makedirs(d, exist_ok=True)
            if not page_shot(src, base):
                continue
        else:
            continue
        for name, w in (("card.jpg", CARD_W), ("chip.jpg", CHIP_W)):
            if make_thumb(base, os.path.join(d, name), w):
                made.append(os.path.join(d, name))
        if made:
            return made
    return made


def thumb_paths(e):
    d = evidence_dir(e["id"])
    return {k: os.path.join(d, f"{k}.jpg") for k in ("card", "chip") if os.path.exists(os.path.join(d, f"{k}.jpg"))}


def evidence_images(e):
    """Images copied into the entry's evidence folder (its own screenshots), for the detail page."""
    d = evidence_dir(e["id"])
    try:
        return [os.path.join(d, n) for n in sorted(os.listdir(d)) if n.lower().endswith(IMAGE_EXT) and n not in ("card.jpg", "chip.jpg", "page.png")]
    except FileNotFoundError:
        return []


def data_uri(path, limit=600_000):
    try:
        if os.path.getsize(path) > limit:
            return ""
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return ""
    ext = os.path.splitext(path)[1].lower()
    mime = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp"}.get(ext, "application/octet-stream")
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def spawn_thumbs(pid):
    """Photograph a page in the background, so `add` returns at once (Chrome takes a second or two)."""
    try:
        argv = [sys.executable, os.path.join(HERE, "dispatch.py"), "prefs", "thumbs", pid, "--make"]
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        pass


# ---------------------------------------------------------------- views

def is_stale(e, ref=None, days=STALE_DAYS):
    """Active and nobody followed it for `days` (by its last use, else when it was said), and not
    confirmed with "Still true? Yes" in the last KEEP_DAYS days."""
    if e.get("status", "active") != "active":
        return False
    kept = days_since(e.get("kept_at"), ref)
    if kept is not None and kept < KEEP_DAYS:
        return False
    base = e.get("last_used") or (e.get("said") or {}).get("at") or e.get("created")
    age = days_since(base, ref)
    return age is not None and age > days


def view(e, thumbs=""):
    """The entry as the page and agents read it: the stored fields plus stale, the scope in words and
    the thumbnails (paths; data: URIs of `thumbs` chip|card when asked)."""
    out = dict(e)
    out.setdefault("status", "active")
    out["stale"] = is_stale(e)
    out["scope_label"] = scope_label(e.get("scope"))
    tp = thumb_paths(e)
    out["thumb_paths"] = tp
    if thumbs in ("chip", "card") and tp.get(thumbs):
        out["thumb"] = data_uri(tp[thumbs])
    if thumbs == "card":
        out["images"] = [{"path": p, "uri": data_uri(p)} for p in evidence_images(e)[:6]]
    return out


def order_key(e):
    return (e.get("updated") or e.get("created") or "")


def listing(entries, area="", project="", new=False, stale=False, include_all=False, ids=None):
    rows = entries
    if ids:
        want = set(ids)
        rows = [e for e in rows if e["id"] in want]
    elif not include_all:
        rows = [e for e in rows if e.get("status", "active") == "active"]
    if area:
        rows = [e for e in rows if e.get("area") == area]
    if project:
        rows = [e for e in rows if scope_applies(e.get("scope"), project)]
    if new:
        rows = [e for e in rows if not e.get("seen")]
    if stale:
        rows = [e for e in rows if is_stale(e)]
    return sorted(rows, key=order_key, reverse=True)


# ---------------------------------------------------------------- operations

def _clean_list(values):
    out = []
    for v in values or []:
        for x in (v if isinstance(v, (list, tuple)) else [v]):
            x = (x or "").strip() if isinstance(x, str) else ""
            if x and x not in out:
                out.append(x)
    return out


def _resolve_evidence(values, cwd):
    out = []
    for v in _clean_list(values):
        if _is_url(v):
            out.append(v)
        else:
            p = os.path.abspath(os.path.join(cwd, os.path.expanduser(v)))
            out.append(p if os.path.exists(p) else v)
    return out


def prepare(item, cwd, said=None):
    """A new entry from what `add` was given (a dict: text, polarity, name, area, scope, quote, part,
    evidence, replaces), checked. Does not touch the store."""
    text = " ".join(str(item.get("text") or "").split())
    if not text:
        raise PrefsError("the preference is empty: one sentence an agent can follow")
    pol = (item.get("polarity") or "").lower()
    if pol not in POLARITIES:
        pol = guess_polarity(text)
    area = (item.get("area") or "").lower()
    if area and area not in AREAS:
        raise PrefsError(f"area is one of {', '.join(AREAS)}")
    part, part_path, _region = split_part(item.get("part"), cwd)
    said = dict(said or caller_said(cwd))
    if item.get("said_at"):
        said["at"] = item["said_at"]
    elif item.get("imported"):
        said["at"] = ""  # the old note had no date: unknown, not the day of the import
    e = {
        "id": "",
        "name": " ".join(str(item.get("name") or "").split())[:40] or derive_name(text),
        "text": text,
        "polarity": pol,
        "area": area or guess_area(text + " " + (item.get("quote") or "")),
        "scope": scope_parse(item.get("scope")),
        "quote": " ".join(str(item.get("quote") or "").split()),
        "part": part,
        "evidence": _resolve_evidence(item.get("evidence"), cwd),
        "replaces": [],
        "status": "active",
        "created": iso(),
        "said": said,
        "seen": bool(item.get("seen", False)),
        "used": 0,
        "last_used": None,
    }
    if part_path:
        e["part_path"] = part_path
        title = page_title(part_path)
        if title:
            e["part_title"] = title
    for k in ("sources", "quotes", "imported"):
        if item.get(k):
            e[k] = item[k]
    return e


def _merge_into(old, new):
    """The same preference said again: the old entry gets the new words, part and evidence.
    The event keeps what was added, so Undo right after can take exactly that back out."""
    took = {"seen": bool(old.get("seen", False)), "updated": old.get("updated", "")}
    if new.get("quote") and new["quote"] != old.get("quote") and new["quote"] not in [q.get("text") for q in old.get("quotes") or []]:
        if old.get("quote"):
            old.setdefault("quotes", []).append({"text": new["quote"], "at": new["said"].get("at"), "session": new["said"].get("session", ""), "engine": new["said"].get("engine", "")})
            took["quote_added"] = new["quote"]
        else:
            # the entry's first words: when and where they were said, not when the entry was made
            old["quote"] = new["quote"]
            old["quote_said"] = {k: new["said"].get(k, "") for k in ("at", "engine", "session")}
            took["quote_set"] = True
    for ev in new.get("evidence") or []:
        if ev not in (old.get("evidence") or []):
            old.setdefault("evidence", []).append(ev)
            took.setdefault("evidence", []).append(ev)
    if new.get("part") and not old.get("part"):
        old["part"] = new["part"]
        took["part_set"] = True
        if new.get("part_path"):
            old["part_path"] = new["part_path"]
    for s in new.get("sources") or []:
        if s not in (old.get("sources") or []):
            old.setdefault("sources", []).append(s)
            took.setdefault("sources", []).append(s)
    old["updated"] = iso()
    old["seen"] = False
    event(old, "said-again", new["quote"] or new["text"], by=new["said"].get("engine"), session=new["said"].get("session"), took=took)


def _unsay(e):
    """Take back the last said-again: the entry is as it was before those words came in."""
    last = (e.get("history") or [{}])[-1]
    took = last.get("took") or {}
    if took.get("quote_added"):
        e["quotes"] = [q for q in e.get("quotes") or [] if q.get("text") != took["quote_added"]]
        if not e["quotes"]:
            e.pop("quotes")
    if took.get("quote_set"):
        e.pop("quote", None)
        e.pop("quote_said", None)
        if e.get("quotes"):
            # an older quote list without a first quote: the first of them becomes it
            q = e["quotes"].pop(0)
            e["quote"] = q.get("text", "")
            e["quote_said"] = {k: q.get(k, "") for k in ("at", "engine", "session")}
            if not e["quotes"]:
                e.pop("quotes")
    for ev in took.get("evidence") or []:
        if ev in (e.get("evidence") or []):
            e["evidence"].remove(ev)
    if took.get("part_set"):
        e.pop("part", None)
        e.pop("part_path", None)
    for s in took.get("sources") or []:
        if s in (e.get("sources") or []):
            e["sources"].remove(s)
    e["seen"] = took.get("seen", True)
    if took.get("updated"):
        e["updated"] = took["updated"]
    else:
        e.pop("updated", None)
    event(e, "unsaid", "Undo right after it was said again: kept as it was before")


def add(items, cwd=None, said=None, thumbs=True):
    """Remember one or more preferences (a dict or a list of dicts). A sentence already remembered
    (same area, same scope, saying the same) takes the new words instead of making a second entry.
    `replaces` (names or ids) retires older ones: they stay in the store, out of prime.
    Returns {remembered: [entry], merged: [ids], replaced: [ids], similar: {id: [(score, entry)]}}."""
    cwd = os.path.abspath(cwd or os.getcwd())
    items = items if isinstance(items, list) else [items]
    said = said or caller_said(cwd)
    rules = rules_files(cwd)
    out = {"remembered": [], "merged": [], "replaced": [], "similar": {}}
    with locked():
        entries = load()
        taken = {e["id"] for e in entries}
        for item in items:
            e = prepare(item, cwd, said)
            dup = next((o for o in entries if o.get("status", "active") == "active" and o.get("area") == e["area"]
                        and o.get("scope") == e["scope"] and o.get("polarity") == e["polarity"]
                        and similarity(o["text"], e["text"]) >= SAME), None)
            replaces = [find(entries, r)["id"] for r in _clean_list(item.get("replaces"))]
            if dup and dup["id"] not in replaces:
                _merge_into(dup, e)
                out["merged"].append(dup["id"])
                out["remembered"].append(dup)
                continue
            e["id"] = new_id(taken)
            taken.add(e["id"])
            e["also_in"] = also_in(e["text"], files=rules)
            event(e, "imported" if e.get("imported") else "remembered", detail=(e.get("sources") or [{}])[0].get("label", ""),
                  by=said.get("engine"), project=said.get("project"), session=said.get("session"))
            for rid in replaces:
                old = next(o for o in entries if o["id"] == rid)
                old["status"] = "replaced"
                old["replaced_by"] = e["id"]
                old["updated"] = iso()
                event(old, "replaced", f"by {e['name']}", by=e["id"])
                e["replaces"].append(rid)
                event(e, "replaces", f"「{clip(old['text'], 60)}」", id=rid, was=(old.get("said") or {}).get("at") or old.get("created"))
                out["replaced"].append(rid)
            sim = similar(entries, e["text"], e["area"], skip=set(replaces) | {e["id"]})
            if sim:
                out["similar"][e["id"]] = sim
            entries.append(e)
            out["remembered"].append(e)
        save(entries)
    for e in out["remembered"]:
        # a merged one gets thumbnails too when it had none and now has evidence
        if thumbs and (e["id"] not in out["merged"] or not thumb_paths(e)):
            srcs = thumb_source(e)
            if any(k == "image" for k, _ in srcs):
                make_thumbs(e, allow_page=False)
            elif srcs:
                spawn_thumbs(e["id"])
    return out


EDITABLE = ("text", "name", "polarity", "area", "scope", "quote", "part")


def edit(key, changes, cwd=None):
    """Change fields of one entry; `evidence` adds, `replaces` retires the named ones. Returns the entry."""
    cwd = os.path.abspath(cwd or os.getcwd())
    with locked():
        entries = load()
        e = find(entries, key, statuses=("active", "replaced"))
        changed = []
        for k in EDITABLE:
            if k not in changes or changes[k] is None:
                continue
            v = changes[k]
            if k == "text":
                v = " ".join(str(v).split())
                if not v:
                    raise PrefsError("the preference is empty")
            elif k == "polarity":
                v = str(v).lower()
                if v not in POLARITIES:
                    raise PrefsError("like or avoid")
            elif k == "area":
                v = str(v).lower()
                if v not in AREAS:
                    raise PrefsError(f"area is one of {', '.join(AREAS)}")
            elif k == "scope":
                v = scope_parse(v)
            elif k == "part":
                part, pp, _ = split_part(v, cwd)
                v = part
                e.pop("part_title", None)
                if pp:
                    e["part_path"] = pp
                    if page_title(pp):
                        e["part_title"] = page_title(pp)
                else:
                    e.pop("part_path", None)
            else:
                v = " ".join(str(v).split())
            if e.get(k) != v:
                e[k] = v
                changed.append(k)
        for ev in _resolve_evidence(changes.get("evidence"), cwd):
            if ev not in (e.get("evidence") or []):
                e.setdefault("evidence", []).append(ev)
                changed.append("evidence")
        for r in _clean_list(changes.get("replaces")):
            old = find(entries, r)
            if old["id"] == e["id"]:
                raise PrefsError("a preference cannot replace itself")
            old["status"] = "replaced"
            old["replaced_by"] = e["id"]
            old["updated"] = iso()
            event(old, "replaced", f"by {e['name']}", by=e["id"])
            e.setdefault("replaces", []).append(old["id"])
            event(e, "replaces", f"「{clip(old['text'], 60)}」", id=old["id"])
            changed.append("replaces")
        if changed:
            e["updated"] = iso()
            if "text" in changed:
                e["also_in"] = also_in(e["text"], cwd)
            event(e, "edited", ", ".join(dict.fromkeys(changed)))
        save(entries)
    if "evidence" in changed or "part" in changed:
        make_thumbs(e, allow_page=False) or (thumb_source(e) and spawn_thumbs(e["id"]))
    return e


def forget(keys, just_said=False):
    """Take entries out of the store; they go to a backup file first. An entry the forgotten one had
    replaced comes back into use. `just_said` is the Undo right after an add: an entry that add only
    said again (it was there before) loses those words and stays. Returns {forgotten: [entry],
    backup: path, restored: [ids], kept: [entry]}."""
    keys = _clean_list(keys)
    if not keys:
        raise PrefsError("which preference? give its short name or id")
    with locked():
        entries = load()
        gone = []
        kept = []
        for k in keys:
            e = find(entries, k, statuses=("active", "replaced"))
            if just_said and ((e.get("history") or [{}])[-1].get("event") == "said-again"):
                if e not in kept:
                    _unsay(e)
                    kept.append(e)
                continue
            if e not in gone:
                gone.append(e)
        if not gone:
            save(entries)
            return {"forgotten": [], "backup": "", "restored": [], "kept": kept}
        at = now()
        path = backup("forget", gone, at)
        ids = {e["id"] for e in gone}
        restored = []
        for o in entries:
            if o.get("replaced_by") in ids and o["id"] not in ids:
                o["status"] = "active"
                o.pop("replaced_by", None)
                o["updated"] = iso(at)
                event(o, "restored", "the one that replaced it was forgotten")
                restored.append(o["id"])
        save([e for e in entries if e["id"] not in ids])
    return {"forgotten": gone, "backup": path, "restored": restored, "kept": kept}


def forgotten(ids=None):
    """The entries forget took out that are not back in the store: {id: (record, path)}, newest last."""
    present = {e["id"] for e in load()}
    out = {}
    for path, r in backup_records():
        if r.get("op") != "forget":
            continue
        e = r["entry"]
        if e.get("id") in present or (ids and e.get("id") not in ids):
            continue
        out[e["id"]] = (r, path)
    return out


def undone_note(session):
    """For the agent's next prompt (hook.py): the preferences it recorded in this conversation that the person then
    took back (Undo under its reply, Forget), each told once. Without it the agent goes by what it remembers doing, and
    "record it after all" got "already recorded, not adding it twice" (10-08). "" when there is nothing new."""
    session = (session or "").strip()
    if not session:
        return ""
    mine = [(rid, r) for rid, (r, _) in forgotten().items() if (r["entry"].get("said") or {}).get("session") == session]
    if not mine:
        return ""
    path = dispatch_dir.path("preferences", "undone-noted.json")
    with locked():
        try:
            with open(path, encoding="utf-8") as f:
                noted = json.load(f)
        except (OSError, ValueError):
            noted = {}
        told = set(noted.get(session) or [])
        new = [(rid, r) for rid, r in mine if rid not in told]
        if not new:
            return ""
        noted[session] = sorted(told | {rid for rid, _ in new})
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(noted, f)
        os.replace(tmp, path)
    lines = "\n".join(f"- {r['entry'].get('name') or rid}: {r['entry'].get('text') or r['entry'].get('quote') or ''}" for rid, r in new)
    return ("The person took back these preferences you recorded in this conversation; they are not saved any more "
            "(if they ask for one again, record it again with prefs_add):\n" + lines)


def undo(key=""):
    """Put back what forget took out: the entry with this id, or everything the last forget took."""
    gone = forgotten()
    if not gone:
        raise PrefsError("nothing to undo: no forgotten preference")
    if key:
        k = key.strip()
        pick = [rid for rid, (r, _) in gone.items() if rid == k or (r["entry"].get("name") or "").lower() == k.lower()]
        if not pick:
            raise PrefsError(f"「{key}」 was not forgotten (or is back already)")
    else:
        last = max(r["at"] for r, _ in gone.values())
        pick = [rid for rid, (r, _) in gone.items() if r["at"] == last]
    with locked():
        entries = load()
        have = {e["id"] for e in entries}
        back = []
        for rid in pick:
            if rid in have:
                continue
            e = dict(gone[rid][0]["entry"])
            e["updated"] = iso()
            event(e, "restored", "undo")
            # what it had replaced goes back out of use
            for o in entries:
                if o["id"] in (e.get("replaces") or []) and o.get("status", "active") == "active":
                    o["status"] = "replaced"
                    o["replaced_by"] = e["id"]
                    event(o, "replaced", f"by {e.get('name')}", by=e["id"])
            entries.append(e)
            back.append(e)
        save(entries)
    return {"restored": back}


def touch(keys, fn):
    keys = _clean_list(keys)
    with locked():
        entries = load()
        hit = []
        for k in keys:
            e = find(entries, k, statuses=("active", "replaced"))
            if fn(e) is not False:
                hit.append(e)
        if hit:
            save(entries)
    return hit


def cite(keys, by="", for_="", ref=""):
    """An agent followed these: used + 1, last_used now. A reply cites a name once however often the
    window renders it (`ref`: the reply's id)."""
    def f(e):
        refs = e.setdefault("cited_refs", [])
        if ref and ref in refs:
            return False
        if ref:
            refs.append(ref)
            del refs[: max(0, len(refs) - REF_KEEP)]
        e["used"] = int(e.get("used") or 0) + 1
        e["last_used"] = iso()
        event(e, "used", for_, by=by)
    return touch(keys, f)


def keep(keys):
    def f(e):
        e["kept_at"] = iso()
        event(e, "still-true")
    return touch(keys, f)


def seen(keys=None, everything=False):
    with locked():
        entries = load()
        hit = []
        if everything:
            pool = [e for e in entries if not e.get("seen")]
        else:
            pool = [find(entries, k, statuses=("active", "replaced")) for k in _clean_list(keys)]
        for e in pool:
            if not e.get("seen"):
                e["seen"] = True
                hit.append(e)
        if hit:
            save(entries)
    return hit


def make_thumbs_for(key):
    e = find(load(), key, statuses=("active", "replaced"))
    return make_thumbs(e, allow_page=True)


# ---------------------------------------------------------------- prime

def prime_section(project="", cwd=None, limit=PRIME_LIMIT, max_chars=PRIME_CHARS, entries=None, max_bytes=None):
    """The lines `dispatch prime` injects: the active preferences for this project and everywhere,
    by area, the narrow ones first, newest first; never a replaced one, never one a rule file
    already says; at most `limit` entries and about `max_chars` characters. How to record a new one
    is a rule (dispatch.md, Preferences), not part of the list."""
    entries = load() if entries is None else entries
    rows = [e for e in entries if e.get("status", "active") == "active" and scope_applies(e.get("scope"), project)
            and not e.get("also_in")]
    none_yet = [_t("## Preferences (the person's; none recorded yet)", "## 偏好（用户的；还没有记下的）")]
    if not rows:
        return none_yet
    files = rules_files(cwd) if cwd else []
    if files:
        rows = [e for e in rows if not also_in(e["text"], files=files)]
    # the same thing said twice at the same scope: the newer one
    kept = []
    for e in sorted(rows, key=order_key, reverse=True):
        if any(k.get("scope") == e.get("scope") and k.get("area") == e.get("area") and similarity(k["text"], e["text"]) >= SAME for k in kept):
            continue
        kept.append(e)
    # what to keep when there are too many: narrow first, then the ones agents follow, then new
    ranked = sorted(kept, key=lambda e: (scope_rank(e.get("scope")), int(e.get("used") or 0), order_key(e)), reverse=True)

    def line(e):
        _, surface = scope_parts(e.get("scope"))
        name = clip(e.get("name") or derive_name(e["text"]), 40)
        text = clip(e["text"], 90)
        # an Avoid whose sentence does not say "not" itself gets it said
        if e.get("polarity") == "avoid" and not re.search(r"不|别|避免|禁止|never|don'?t|avoid", text, re.I):
            text = _t("Avoid: ", "避免：") + text
        where = _t(f" ({clip(surface, 40)})", f"（{clip(surface, 40)}）") if surface else ""
        # the short name is what a reply cites; a sentence that starts with it is not repeated
        if norm(text).startswith(norm(name)):
            return f"- {text}{where}"
        return f"- {name}{where}" + _t(": ", "：") + text

    # every area gets its share: taken in turns, the narrow and the followed first within each
    queues = {a: [e for e in ranked if e.get("area") == a] for a in AREAS}
    queues[""] = [e for e in ranked if e.get("area") not in AREAS]
    turns = []
    while any(queues.values()):
        for q in queues.values():
            if q:
                turns.append(q.pop(0))
    picked, used = [], 0
    for e in turns:
        if len(picked) >= limit:
            break
        n = len(line(e)) + 1
        if picked and used + n > max_chars:
            continue
        picked.append(e)
        used += n
    if not picked:
        return none_yet
    def render():
        where = clip(project, 40) + ' + ' if project else ''
        more = len(kept) - len(picked)
        lines = [_t(f"## Preferences (the person's; {where}everywhere, {len(picked)}" + (f", {more} more in `dispatch prefs list`" if more > 0 else "") + ")",
                    f"## 偏好（用户的；{where}全局，{len(picked)} 条" + (f"，还有 {more} 条 `dispatch prefs list`" if more > 0 else "") + "）")]
        for area in [*AREAS, ""]:
            group = [e for e in picked if (e.get("area") if e.get("area") in AREAS else "") == area]
            if group:
                lines.append(_t(AREA_LABEL.get(area, "Other"), AREA_ZH.get(area, "其他")))
                group.sort(key=lambda e: (scope_rank(e.get("scope")), order_key(e)), reverse=True)
                lines.extend(line(e) for e in group)
        return lines
    lines = render()
    while max_bytes is not None and picked and len(("\n".join(lines) + "\n").encode("utf-8")) > max_bytes:
        picked.pop()
        lines = render()
    return lines


# ---------------------------------------------------------------- import: the places preferences lived before

def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def _sha(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:16]
    except OSError:
        return ""


def facts_file():
    return os.environ.get("DISPATCH_FACTS_FILE") or rules_file("FACTS.md")


def profile_file():
    return os.environ.get("DISPATCH_PROFILE_FILE") or rules_file("PROFILE.md")


def taste_file(cwd=None):
    env = os.environ.get("DISPATCH_TASTE_FILE")
    if env:
        return env
    root = repo_root(cwd or os.getcwd())
    for base in ([root] if root else []) + [os.path.join(os.path.expanduser("~"), "Projects", "kanban")]:
        p = os.path.join(base, "design", "taste", "我的设计偏好.md")
        if os.path.isfile(p):
            return p
    return ""


def design_file(cwd=None):
    env = os.environ.get("DISPATCH_DESIGN_FILE")
    if env:
        return env
    root = repo_root(cwd or os.getcwd())
    p = os.path.join(root, "DESIGN.md") if root else ""
    return p if p and os.path.isfile(p) else ""


_DATE = re.compile(r"(\d{4}-\d{2}-\d{2})")
_SENT_SPLIT = re.compile(r"(?<=[。；;！!？?])\s*")
_QUOTE = re.compile(r"「([^「」]{4,300})」")


def sentences(text):
    return [s.strip(" ；;。") for s in _SENT_SPLIT.split(text or "") if len(s.strip(" ；;。")) >= 4]


_OPEN, _CLOSE = "（(「【[『“", "）)」】]』”"


def depth_split(text, seps):
    """Pieces of text split at any of seps outside brackets and quotes."""
    out, buf, depth = [], "", 0
    for ch in text or "":
        if ch in _OPEN:
            depth += 1
        elif ch in _CLOSE:
            depth = max(0, depth - 1)
        if depth == 0 and ch in seps:
            out.append(buf)
            buf = ""
            continue
        buf += ch
    out.append(buf)
    return [p.strip(" \t") for p in out if p.strip(" \t")]


def depth_colon(text):
    """Where the first colon outside brackets is (not a time's 11:00); -1 when there is none."""
    depth = 0
    for i, ch in enumerate(text or ""):
        if ch in _OPEN:
            depth += 1
        elif ch in _CLOSE:
            depth = max(0, depth - 1)
        elif depth == 0 and ch in "：:" and not (ch == ":" and i and text[i - 1].isdigit()):
            return i
    return -1


def plain_dashes(s):
    """No dashes in text shown to the person (their rule): ——, — and – become a comma."""
    return re.sub(r"\s*(?:——|—|–)\s*", "，", s or "")


def _cand(text, kind, path, line, label, at="", quote="", polarity="", area="", scope="", name="", evidence=None, note="", default_area="workflow", sure=True, why=""):
    text = plain_dashes(" ".join((text or "").split())).strip(" ；;，,")
    if text and not re.search(r"[。.!！?？)）」]$", text):
        text += "。" if re.search(r"[\u4e00-\u9fff]", text) else "."
    return {"text": text, "polarity": polarity or guess_polarity(text), "area": area or guess_area(text + " " + quote, default_area),
            "scope": scope or "everywhere", "quote": quote, "name": name or derive_name(text), "evidence": evidence or [],
            "at": at, "sure": sure, "why": why,
            "sources": [{"kind": kind, "path": path, "line": line, "label": label, "at": at, **({"note": note} if note else {})}]}


LIKE_LABELS = ("点名喜欢", "喜欢的点", "喜欢", "要")
AVOID_LABELS = ("不喜欢的点", "不喜欢", "不要")
GROUP_LABELS = ("拍板",)
# a label that says something itself ("诊断现状的画法要像 Task graph 稿那样") rather than naming a topic ("多机器方案")
_STATEMENT = re.compile(r"要|用|选|像|喜欢|不|别|应该|改成|是")
# what a picked direction or a spec for one screen of Dispatch reads like: a decision more than a taste
_DECISION = re.compile(r"选方向|方向 [A-F]|拍板|照稿|额度|Devices|换台入口|改成先")


def facts_pieces(body):
    """A bullet of「我的设计偏好」split into what each says: [(text, polarity or "", quote, the piece alone)].
    A topic named at the start ("多机器方案：a；b") stays in front of each thing said about it, also in
    front of what was liked or disliked about it later in the bullet ("多机器方案，不喜欢的点：c")."""
    out, topic = [], ""
    for sentence in depth_split(body, "。"):
        c = depth_colon(sentence)
        label, rest = (sentence[:c].strip(), sentence[c + 1:].strip()) if c >= 0 else ("", sentence)
        quote = " ".join(_QUOTE.findall(label)) if label else ""
        clean = re.sub(r"[（(][^）)]*[）)]", "", label).strip()
        if label and clean in AVOID_LABELS + LIKE_LABELS + GROUP_LABELS:
            pol = "avoid" if clean in AVOID_LABELS else ("like" if clean in LIKE_LABELS else "")
            head = f"{topic}，{clean}：" if topic and pol else ""
            out += [(head + p, pol, quote, p) for p in depth_split(rest, "；;")]
        elif label and _STATEMENT.search(clean):
            out.append((sentence, "", quote, sentence))
        elif label:
            topic = clean
            out += [(f"{clean}：{p}", "", quote, p) for p in depth_split(rest, "；;")]
        else:
            out += [(p, "", "", p) for p in depth_split(sentence, "；;")]
    return out


def from_facts(path=None):
    """FACTS.md「我的设计偏好」and「我常说的话」: one bullet can hold several (要：a；b / 不要：a；b / a dated
    decision of several sentences); each becomes one candidate. The curated 要 / 不要 lists and the sayings
    are clear; the dated decisions are Dispatch's own screens, picked directions and specs (kept for review)."""
    path = path or facts_file()
    text = _read(path)
    out, skipped = [], []
    topic = ""
    for i, raw in enumerate(text.split("\n"), 1):
        line = raw.strip()
        m = re.match(r"^\*\*(.+?)\*\*", line)
        if m and not line.startswith("-"):
            topic = m.group(1)
            continue
        if raw.startswith("## "):
            topic = ""
            continue
        design = topic.startswith(DESIGN_TOPICS)
        if not line.startswith("- ") or not (design or topic.startswith("我常说的话")):
            continue
        body = line[2:].strip()
        label = next((t for t in DESIGN_TOPICS if topic.startswith(t)), "我常说的话")
        where = f"{os.path.basename(path)}:{i}"
        area_default = "design" if design else "workflow"
        dm = re.match(r"^(\d{4}-\d{2}-\d{2})\s*", body)
        date = dm.group(1) if dm else ""
        body = body[dm.end():] if dm else body
        if re.search(r"先读全文|动手前先读", body) and re.search(r"\.md", body):
            skipped.append({"text": clip(body, 80), "why": "a pointer to the full document, not a preference", "source": where})
            continue
        mm = re.match(r"^(要|不要)[：:](.*)$", body)
        if mm:
            pol = "like" if mm.group(1) == "要" else "avoid"
            for piece in depth_split(mm.group(2), "；;"):
                piece = piece.strip(" 。")
                if len(piece) >= 4:
                    c = _cand(piece, "facts", path, i, f"FACTS.md · {label}", at=date, polarity=pol, default_area=area_default)
                    c["summary_of"] = "taste"  # FACTS sums design/taste's list up: its pieces join the full items there
                    out.append(c)
            continue
        if label == "我常说的话":
            out.append(_cand(body, "facts", path, i, f"FACTS.md · {label}", at=date))
            continue
        for piece, pol, quote, alone in facts_pieces(body):
            if re.match(r"^(他|用户)是|^说不清|^他(很少|常)", piece):
                skipped.append({"text": clip(piece, 80), "why": "about the person, not a preference (Profile)", "source": where})
                continue
            if not quote and re.search(r"喜欢|点名|原话", piece):
                quote = " ".join(_QUOTE.findall(piece))
            dispatch = bool(_DISPATCH_SUBJECT.search(alone if pol else piece))
            # a direction picked or a spec written for one of Dispatch's screens: DECISIONS.md has it; whether
            # agents also get it as a preference is the person's call. What they liked or disliked is theirs.
            decision = not pol and (dispatch or bool(_DECISION.search(piece)))
            only_words = bool(re.fullmatch(r"「[^「」]+」[。.]?", piece.strip()))
            why = ("a direction picked or a spec written for one of Dispatch's screens (DECISIONS.md has it)" if decision
                   else "only the words, no sentence an agent can follow" if only_words else "")
            out.append(_cand(piece, "facts", path, i, f"FACTS.md · {label}", at=date, quote=quote, polarity=pol, default_area=area_default,
                             scope="kanban" if dispatch else "", sure=not why, why=why, name=derive_name(alone) if alone != piece else ""))
    return out, skipped


def _front(text):
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    if not m:
        return {}, text
    meta = {}
    for line in m.group(1).split("\n"):
        k, _, v = line.partition(":")
        if v and not line.startswith(" "):
            meta[k.strip()] = v.strip().strip('"')
    tm = re.search(r"^\s+type:\s*(\S+)", m.group(1), re.M)
    if tm and "type" not in meta:
        meta["type"] = tm.group(1)
    return meta, m.group(2)


_DISPATCH_WORDS = re.compile(r"Dispatch|dispatch|任务板|Waiting for you|Tasks 页签|Task graph|右栏|左栏|会话头像|引擎头像|\.composer|Agents 窗口|Customizations|kanban|Knowledge|Docs 页签|标题栏机器|账号菜单")


# a sentence about one of Dispatch's own screens or its repository (not one that merely says "in Dispatch")
_DISPATCH_SUBJECT = re.compile(r"^(?:右栏 )?(?:Tasks 页签|Task graph 选|Waiting for you|Knowledge 选|Docs 页签|引擎头像|会话头像|多机器方案|标注图|"
                               r"只把「Draw and ask|Dispatch[ /仓库里的]|任务板|kanban)")


def project_words(project):
    """What ties a sentence to this project: its name, and for Dispatch (whose repository is kanban) a
    sentence whose subject is one of its own screens."""
    p = re.escape(project)
    if project.lower() in ("kanban", "dispatch"):
        return re.compile("(?:" + p + ")|" + _DISPATCH_SUBJECT.pattern, re.I)
    return re.compile(p, re.I)


def from_memory(project="", agents=("claude-code",), entries=None):
    """Claude Code's own memory (and Codex's when asked): the files of type feedback or user, one
    candidate each, its one-line description as the sentence and the first quote in it as the words."""
    out, skipped = [], []
    if entries is None:
        try:
            m = _d()._mod("memories")
            entries = m.memory_entries()
        except Exception:
            # the board did not answer (the project names come from it): read Claude's folders directly
            entries = claude_memory_files()
    for r in entries:
        if r.get("agent") not in agents:
            continue
        if project and (r.get("project") or "").lower() != project.lower():
            continue
        typ = (r.get("type") or "").lower()
        path = r.get("path") or ""
        if typ not in ("feedback", "user"):
            if typ:
                skipped.append({"text": clip(r.get("description") or r.get("name") or "", 80), "why": f"type {typ}: facts or project notes, not a preference", "source": os.path.basename(path)})
            continue
        body = r.get("body") or ""
        desc = " ".join((r.get("description") or "").split())
        if not desc:
            continue
        quotes = _QUOTE.findall(body)
        dm = _DATE.search(body) or _DATE.search(desc)
        at = dm.group(1) if dm else (datetime.datetime.fromtimestamp(r["mtime"]).strftime("%Y-%m-%d") if r.get("mtime") else "")
        proj = r.get("project") or ""
        scope = proj if proj and proj.lower() not in ("通用", "general", "projects", "documents") and project_words(proj).search(desc) else "everywhere"
        agent = r.get("agent") or ""
        import engines
        label = f"{engines.get(agent).name} memory · {r.get('name') or os.path.basename(path)}"
        why = memory_doubt(typ, desc)
        out.append(_cand(desc, "memory", path, 1, label, at=at, quote=quotes[0] if quotes else "", scope=scope, sure=not why, why=why))
    return out, skipped


def claude_memory_files():
    """Claude Code's memory files without asking the board: the project is the last part of the folder
    Claude named after the working directory (-Users-me-Projects-kanban → kanban)."""
    rows = []
    for path in sorted(glob_memory()):
        if os.path.basename(path) == "MEMORY.md":
            continue
        text = _read(path)
        meta, body = _front(text)
        folder = os.path.basename(os.path.dirname(os.path.dirname(path)))
        rows.append({"agent": "claude-code", "project": folder.rstrip("-").split("-")[-1] or "通用", "path": path,
                     "name": meta.get("name") or os.path.splitext(os.path.basename(path))[0], "description": meta.get("description", ""),
                     "type": meta.get("type", ""), "body": body, "mtime": os.path.getmtime(path) if os.path.exists(path) else 0})
    return rows


def glob_memory():
    import glob
    return glob.glob(os.path.join(os.path.expanduser("~"), ".claude", "projects", "*", "memory", "*.md"))


# an engine's note is a preference when it tells an agent what to do; these read as something else
_MEMORY_DOUBTS = [
    (re.compile(r"^用户(的工作流|要求我|\s*\d{4}-\d{2}-\d{2}\s*拍板)"), "an engine's summary about you, not a sentence an agent can follow"),
    (re.compile(r"(必须写的|要写的)[两三四五六七八九十\d]+条$"), "names rules without saying them (they are in the note's body)"),
    (re.compile(r"Tauri|\.composer|\.cbox"), "about the retired Tauri app"),
    (re.compile(r"信息组织以|主轴|架构|取代"), "a product decision (the project's CLAUDE.md or DECISIONS.md holds those)"),
    (re.compile(r"分档|最多 ?\d+ ?个"), "how many and which sub-agents: GLOBAL.md says it too, and the numbers differ"),
]


def memory_doubt(typ, desc):
    """Why an engine's memory note needs the person's look before it becomes a preference; "" when it
    plainly says how they want things done."""
    for rx, why in _MEMORY_DOUBTS:
        if rx.search(desc):
            return why
    if typ == "user" and not re.search(r"喜欢|不要|别|讨厌", desc):
        return "a note about you rather than how you like things done"
    return ""


def from_taste(path=None):
    """design/taste/我的设计偏好.md: the dated notes at the top, section 4's 要 / 不要 (each numbered
    item with its bold lead as the short name, its figures as evidence) and 怎么拿给他看 (with quotes)."""
    path = path or taste_file()
    text = _read(path)
    out, skipped = [], []
    if not text:
        return out, skipped
    figs = os.path.join(os.path.dirname(path), os.path.splitext(os.path.basename(path))[0])
    files = sorted(os.listdir(figs)) if os.path.isdir(figs) else []

    def figure(n):
        return next((os.path.join(figs, f) for f in files if f.startswith(f"{int(n):02d}-")), "")

    section, sub = "", ""
    for i, raw in enumerate(text.split("\n"), 1):
        line = raw.strip()
        if raw.startswith("## "):
            section, sub = line[3:], ""
            continue
        if raw.startswith("### "):
            sub = line[4:]
            continue
        if line.startswith("> ") and _DATE.search(line[:40]):
            date = _DATE.search(line).group(1)
            body = re.sub(r"^>\s*\d{4}-\d{2}-\d{2}\s*用户(明确说|补充)?[：:，,]?\s*", "", line)
            quotes = _QUOTE.findall(body)
            # the screenshots it names are the evidence (`../refs/a.png` 和 `b.png`: b next to a)
            shots, last = [], os.path.dirname(path)
            for name in re.findall(r"`([^`]+\.(?:png|jpe?g|webp|gif))`", body, re.I):
                for base in (os.path.dirname(path), last):
                    p = os.path.normpath(os.path.join(base, name))
                    if os.path.isfile(p):
                        shots.append(p)
                        last = os.path.dirname(p)
                        break
            body = re.sub(r"，?截图\s*`[^`]+`(?:\s*和\s*`[^`]+`)*", "", body)
            out.append(_cand(body, "taste", path, i, "design/taste · 开头的补充", at=date, quote=quotes[0] if quotes else "", area="design", evidence=shots))
            continue
        if not section.startswith("4"):
            continue
        num = re.match(r"^(\d+)\.\s+(.*)$", line)
        if sub in ("要", "不要") and num:
            body = num.group(2)
            bold = re.match(r"^\*\*(.+?)\*\*\s*(.*)$", body)
            lead = bold.group(1).strip(" 。") if bold else ""
            rest = bold.group(2) if bold else body
            first = sentences(rest)[0] if sentences(rest) else rest
            sent = (lead + "：" + first) if lead else first
            ev = [f for f in (figure(n) for n in re.findall(r"图\s*(\d{1,2})", body)) if f]
            pol = "like" if sub == "要" else "avoid"
            if pol == "avoid":
                sent = re.sub(r"^不要", "", sent).strip()
                sent = "不要" + sent
            out.append(_cand(sent, "taste", path, i, f"design/taste · 4 {sub} · 第 {num.group(1)} 条", polarity=pol, area="design",
                             name=lead[:12] if lead else "", evidence=ev, at="2026-09-26"))
            continue
        if sub.startswith("怎么拿给他看") and line.startswith("- "):
            body = line[2:]
            quotes = _QUOTE.findall(body)
            dm = _DATE.search(body)
            head = re.split(r"[：:]「", body)[0]
            out.append(_cand(head, "taste", path, i, "design/taste · 4 怎么拿给他看", at=dm.group(1) if dm else "2026-09-26",
                             quote=quotes[0] if quotes else "", area="workflow"))
    return out, skipped


def from_profile(path=None):
    """PROFILE.md「我是谁」(「Who I am」once migrated): the entries that say how the person likes things
    (喜欢 / 偏好 / 审美 / 不要 …)."""
    path = path or profile_file()
    text = _read(path)
    out, skipped = [], []
    section = ""
    for i, raw in enumerate(text.split("\n"), 1):
        if raw.startswith("## "):
            section = raw[3:].strip()
            continue
        if not section.startswith(("我是谁", "Who I am")) or not raw.startswith("- "):
            continue
        body = raw[2:].strip()
        m = re.search(r"[（(](\d{4}-\d{2}-\d{2})?\s*(?:·\s*)?([\w .-]*)[)）]\s*$", body)
        at = m.group(1) if m and m.group(1) else ""
        body = body[: m.start()].strip() if m else body
        if re.search(r"喜欢|偏好|审美|不要|别用|习惯|希望|讨厌|要求|风格|口味", body):
            out.append(_cand(body, "profile", path, i, "PROFILE.md · " + ("Who I am" if section.startswith("Who I am") else "我是谁"), at=at))
    return out, skipped


def from_codex(path=None):
    """Codex's memory summary: the bullets under「User preferences」."""
    path = path or os.path.join(os.path.expanduser("~"), ".codex", "memories", "memory_summary.md")
    text = _read(path)
    out, skipped = [], []
    inside = False
    for i, raw in enumerate(text.split("\n"), 1):
        if re.match(r"^#+\s", raw):
            inside = bool(re.search(r"user preferences|用户偏好", raw, re.I))
            continue
        if inside and raw.strip().startswith("- "):
            out.append(_cand(raw.strip()[2:], "codex", path, i, "Codex memory · User preferences"))
    return out, skipped


def from_design(path=None):
    """The project's DESIGN.md「用户偏好」: its 要 / 不要 paragraphs, split at semicolons."""
    path = path or design_file()
    text = _read(path) if path else ""
    out, skipped = [], []
    inside = False
    for i, raw in enumerate(text.split("\n"), 1):
        if raw.startswith("## "):
            inside = "用户偏好" in raw
            continue
        m = re.match(r"^(要|不要)[：:](.*)$", raw.strip()) if inside else None
        if not m:
            continue
        pol = "like" if m.group(1) == "要" else "avoid"
        body = re.sub(r"[（(][^）)]*保留[^）)]*[)）]", "", m.group(2))
        for piece in re.split(r"[；;]", body):
            piece = piece.strip(" 。")
            if len(piece) >= 4:
                out.append(_cand(piece, "design", path, i, "DESIGN.md · 用户偏好", polarity=pol, area="design"))
    return out, skipped


# ---- the agents' own global rules files: CLAUDE.md, AGENTS.md ----------------------------------

_MARKDOWN_BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$")
# a line that tells an agent how to work, rather than describing a command or a folder
_DIRECTIVE = re.compile(r"\b(always|never|prefer|must|should|do not|don't|avoid|only|instead of|default to|use|keep|write|answer|ask|run)\b|一律|必须|不要|别|不用|不许|避免|喜欢|默认|优先|尽量|只用|总是|永远", re.I)
_RULE_FACT = re.compile(r"\b(lives? (?:in|under)|located (?:in|at)|built with|deployed (?:from|to)|the (?:repos?|project|server|machine|build script) (?:is|are|lives?))\b|仓库在|路径是|地址是|端口是|机器是", re.I)
_RULE_CREDENTIAL = re.compile(r"\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}\b|(?:api[_ -]?key|access[_ -]?token|密钥)\s*[:=]\s*[\"']?[A-Za-z0-9_/-]{20,}", re.I)
_NOT_A_SENTENCE = re.compile(r"^(?:`[^`]+`|\[[^\]]+\]\([^)]+\)|https?://\S+|[\w./~-]+\.(?:md|py|ts|js|json|sh))\s*[:：-]?\s*$")


def _outside_managed_block(text):
    """The file's own lines: what Dispatch's managed block (`dispatch rules sync`) wrote is not the person's."""
    begin, end = "<!-- BEGIN DISPATCH GLOBAL RULES", "<!-- END DISPATCH GLOBAL RULES -->"
    while True:
        i = text.find(begin)
        if i < 0:
            return text
        j = text.find(end, i)
        end_at = j + len(end) if j >= 0 else len(text)
        text = text[:i] + "\n" * text[i:end_at].count("\n") + text[end_at:]


def from_rules_file(path, kind, label):
    """The bullets of an agent's global rules file (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, OpenCode's
    AGENTS.md), outside Dispatch's managed block. A bullet that reads as an instruction (always, never,
    prefer, 不要, 一律 …) is clear; one that only states something waits for the person's look."""
    text = _outside_managed_block(_read(path))
    out, skipped = [], []
    fence = False
    for i, raw in enumerate(text.split("\n"), 1):
        if raw.strip().startswith(("```", "~~~")):
            fence = not fence
            continue
        m = None if fence else _MARKDOWN_BULLET.match(raw)
        if not m:
            continue
        line = re.sub(r"[*_]{1,3}([^*_]+)[*_]{1,3}", r"\1", m.group(1)).strip()
        if _RULE_CREDENTIAL.search(m.group(1)) or _RULE_CREDENTIAL.search(line):
            skipped.append({"text": "[credential omitted]", "why": "contains a credential, not imported", "source": os.path.basename(path)})
            continue
        if len(line) < (6 if re.search(r"[\u4e00-\u9fff]", line) else 14) or len(line) > 300 or _NOT_A_SENTENCE.match(line):
            skipped.append({"text": clip(line, 80), "why": "too short, or a path or link rather than a sentence", "source": os.path.basename(path)})
            continue
        directive = bool(_DIRECTIVE.search(line))
        if not directive and _RULE_FACT.search(line):
            skipped.append({"text": clip(line, 80), "why": "a project or machine fact, not a preference", "source": os.path.basename(path)})
            continue
        out.append(_cand(line, kind, path, i, label, sure=directive,
                         why="" if directive else "a line from your rules file that states something rather than asks for it"))
    return out, skipped


def from_claude_md(path=None):
    return from_rules_file(path or os.path.join(os.path.expanduser("~"), ".claude", "CLAUDE.md"), "claude_md", "CLAUDE.md")


def from_agents_md(paths=None):
    paths = paths or [os.path.join(os.path.expanduser("~"), ".codex", "AGENTS.md"),
                      os.path.join(os.path.expanduser("~"), ".config", "opencode", "AGENTS.md")]
    out, skipped = [], []
    for p in paths:
        o, sk = from_rules_file(p, "agents_md", "AGENTS.md")
        out += o
        skipped += sk
    return out, skipped


SOURCES = {
    "facts": ("FACTS.md", lambda o: from_facts()),
    "memory": ("Claude Code memory", lambda o: from_memory(o.get("project", ""), ("claude-code",))),
    "taste": ("design/taste", lambda o: from_taste(taste_file(o.get("cwd")))),
    "profile": ("PROFILE.md", lambda o: from_profile()),
    "codex": ("Codex memory", lambda o: from_codex()),
    "design": ("DESIGN.md", lambda o: from_design(design_file(o.get("cwd")))),
    "claude_md": ("CLAUDE.md", lambda o: from_claude_md()),
    "agents_md": ("AGENTS.md", lambda o: from_agents_md()),
}
DEFAULT_SOURCES = ("facts", "memory", "taste", "profile", "codex", "design", "claude_md", "agents_md")
# whose sentence a merged item keeps: the curated places first, an engine's own note last
KIND_RANK = {"taste": 0, "facts": 1, "profile": 2, "design": 3, "claude_md": 4, "agents_md": 4, "codex": 5, "memory": 6}


SUMMARY_JOIN = 0.33  # a FACTS summary piece joins the design/taste item it sums up at this much alike


def opening(text, n=3):
    """The first n characters that say something (no "不要", no punctuation): 「顺手改」, 「字用大」."""
    t = norm(_LEAD_NEG.sub("", text or ""))
    return t[:n] if len(t) >= n + 2 else ""


def merge_candidates(cands, threshold=IMPORT_SAME):
    """Group candidates that say the same thing (any polarity: "do A" and "don't do not-A" are one
    preference); each group becomes one item that keeps every source and quote. The sentence and
    short name of the group come from its most recent, most specific source. FACTS's 要 / 不要 lists
    sum design/taste's section 4 up in a few words each: those pieces join the item they sum up first."""
    groups = []

    def best_group(c):
        best, score = None, 0.0
        for g in groups:
            s_ = max(same_thing(c["text"], m["text"]) for m in g)
            if s_ > score:
                best, score = g, s_
        return best, score

    taste = [c for c in cands if c["sources"][0]["kind"] == "taste"]
    rest = [c for c in cands if c["sources"][0]["kind"] != "taste"]
    for c in taste + rest:
        g, score = best_group(c)
        # a FACTS summary piece joins the design/taste item it sums up at a lower bar, or when both open alike
        if c.get("summary_of") == "taste":
            same_start = next((t for t in groups if t[0]["sources"][0]["kind"] == "taste" and opening(t[0]["text"]) and opening(t[0]["text"]) == opening(c["text"])), None)
            if same_start is not None:
                same_start.append(c)
                continue
        bar = SUMMARY_JOIN if c.get("summary_of") == "taste" and g and g[0]["sources"][0]["kind"] == "taste" else threshold
        if g is not None and score >= bar:
            g.append(c)
        else:
            groups.append([c])
    items = []
    for g in groups:
        lead = sorted(g, key=lambda c: (not c.get("sure", True), KIND_RANK.get(c["sources"][0]["kind"], 9), -(len(c["text"]))))[0]
        sure = any(c.get("sure", True) for c in g)
        newest = max((c["at"] for c in g if c["at"]), default="")
        quotes, seen_q = [], set()
        for c in g:
            if c["quote"] and c["quote"] not in seen_q:
                seen_q.add(c["quote"])
                quotes.append({"text": c["quote"], "at": c["at"], "source": c["sources"][0]["label"]})
        evidence = []
        for c in g:
            for ev in c["evidence"]:
                if ev not in evidence:
                    evidence.append(ev)
        scopes = [c["scope"] for c in g if c["scope"] != "everywhere"]
        named = next((c["name"] for c in g if c["sources"][0]["kind"] == "taste" and c["name"]), "")
        items.append({
            "text": lead["text"], "name": named or lead["name"], "polarity": lead["polarity"], "area": lead["area"],
            "scope": scopes[0] if scopes and len(scopes) == len(g) else "everywhere",
            "quote": quotes[0]["text"] if quotes else "", "quotes": quotes[1:], "evidence": evidence,
            "said_at": newest, "sources": [s for c in g for s in c["sources"]],
            "sure": sure, "why": "" if sure else next((c.get("why") for c in g if c.get("why")), ""),
        })
    return items


_SUPERSEDES = re.compile(r"作废|失败作品|不算他|不再|已经不|改成|换成")


def mark_superseded(items):
    """A later note that takes an earlier one back ("…是失败作品，不算他的审美") leaves the earlier one for the
    person to look at: it is not imported as if nothing had changed."""
    for new in items:
        if not _SUPERSEDES.search(new["text"]):
            continue
        for old in items:
            if old is new or not old.get("sure", True):
                continue
            if (old.get("said_at") or "") <= (new.get("said_at") or "9999") and 0.4 <= same_thing(old["text"], new["text"]) < IMPORT_SAME:
                old["sure"] = False
                old["why"] = f"a later note takes it back: 「{clip(new['text'], 60)}」"
    return items


def plan_import(sources=DEFAULT_SOURCES, project="", cwd=None, existing=None):
    """What `import` would write: {items, skipped, places: {source: count}, raw}. Reads only."""
    cwd = os.path.abspath(cwd or os.getcwd())
    opts = {"project": project, "cwd": cwd}
    cands, skipped, places = [], [], {}
    for s in sources:
        if s not in SOURCES:
            raise PrefsError(f"unknown source {s}: {', '.join(SOURCES)}")
        got, skip = SOURCES[s][1](opts)
        places[s] = len(got)
        cands += got
        skipped += skip
    items = mark_superseded(merge_candidates(cands))
    if project:
        words = project_words(project)
        for it in items:
            if it["scope"] == "everywhere" and words.search(it["text"]):
                it["scope"] = project
    existing = load() if existing is None else existing
    files = rules_files(cwd)
    # the clear ones first, each area together: the numbers are what the person ticks (`--pick 3,5`)
    order = {a: i for i, a in enumerate(AREAS)}
    items.sort(key=lambda it: (not it.get("sure", True), order.get(it["area"], 9)))
    for n, it in enumerate(items, 1):
        it["n"] = n
        dup = next((e for e in existing if e.get("status", "active") == "active" and similarity(e["text"], it["text"]) >= SAME), None)
        it["already"] = dup["id"] if dup else ""
        it["also_in"] = also_in(it["text"], files=files)
    return {"items": items, "skipped": skipped, "places": places, "raw": len(cands),
            "sources": {s: SOURCES[s][0] for s in sources}}


def pick_items(plan, picks="", sure_only=False):
    """The items `--apply` writes: the numbers in `picks` ("3,5,9-12"), else the clear ones with
    `sure_only`, else all. The rest of the plan is what stays pending."""
    want = set()
    for part in re.split(r"[,\s]+", picks or ""):
        m = re.match(r"^(\d+)(?:-(\d+))?$", part)
        if m:
            want.update(range(int(m.group(1)), int(m.group(2) or m.group(1)) + 1))
        elif part:
            raise PrefsError(f"--pick takes numbers from the plan (3,5,9-12), not {part}")
    if want:
        return [it for it in plan["items"] if it.get("n") in want]
    return [it for it in plan["items"] if it.get("sure", True) or not sure_only]


def pending_path():
    return dispatch_dir.path("preferences", "pending-import.json")


def apply_import(plan, cwd=None, picks="", sure_only=False):
    """Write a plan's items into the store: marked imported, seen (they are not news), with their
    sources; an item the store already has adds its sources and quotes to that entry. Also records
    what was read in preferences/imports.json: the sources stay as they are for at least 7 days.
    The items not written (not picked, or not clear with `sure_only`) wait in pending-import.json for the
    person to pick: `dispatch prefs import --apply --plan <it> --pick 3,5`."""
    cwd = os.path.abspath(cwd or os.getcwd())
    said = {"at": iso(), "engine": "import", "session": "", "project": "", "cwd": cwd}
    chosen = pick_items(plan, picks, sure_only)
    held = [it for it in plan["items"] if it not in chosen and not it.get("skip") and not it.get("already")]
    add_items = []
    for it in chosen:
        # skipped by hand, or in the store already (an import run again adds nothing, marks nothing new)
        if it.get("skip") or it.get("already"):
            continue
        item = {k: it.get(k) for k in ("text", "name", "polarity", "area", "scope", "quote", "evidence", "sources")}
        item["quotes"] = it.get("quotes") or []
        item["imported"] = True
        item["seen"] = True
        item["said_at"] = it.get("said_at") or ""
        item["replaces"] = []
        add_items.append(item)
    res = add(add_items, cwd=cwd, said=said, thumbs=True) if add_items else {"remembered": [], "merged": [], "replaced": [], "similar": {}}
    # an item the store has already: only the places it was also found in are added to that entry
    known = [it for it in chosen if it.get("already")]
    if known:
        with locked():
            entries = load()
            by_id = {e["id"]: e for e in entries}
            for it in known:
                e = by_id.get(it["already"])
                if not e:
                    continue
                added = []
                for src in it.get("sources") or []:
                    if src not in (e.get("sources") or []):
                        e.setdefault("sources", []).append(src)
                        added.append(src.get("label", ""))
                for ev in it.get("evidence") or []:
                    if ev not in (e.get("evidence") or []):
                        e.setdefault("evidence", []).append(ev)
                have = {e.get("quote")} | {q.get("text") for q in e.get("quotes") or []}
                for q in ([{"text": it["quote"], "at": it.get("said_at", "")}] if it.get("quote") else []) + list(it.get("quotes") or []):
                    if q.get("text") and q["text"] not in have:
                        if not e.get("quote"):
                            e["quote"] = q["text"]
                            e["quote_said"] = {"at": q.get("at", ""), "engine": "import", "session": ""}
                        else:
                            e.setdefault("quotes", []).append(q)
                        have.add(q["text"])
                if added:
                    event(e, "also-found", "; ".join(x for x in added if x), by="import")
            save(entries)
    # a plan may mark an item as replaced by another one (a conflict found when merging: the older
    # said one thing, the newer the opposite): the older stays, out of use
    by_text = {e["text"]: e for e in res["remembered"]}
    pairs = [(it["text"], it.get("replaced_by_text")) for it in plan["items"] if it.get("replaced_by_text")]
    if pairs:
        with locked():
            entries = load()
            ids = {e["text"]: e["id"] for e in entries}
            for old_t, new_t in pairs:
                o = next((e for e in entries if e["id"] == (by_text.get(old_t) or {}).get("id", ids.get(old_t))), None)
                n = next((e for e in entries if e["id"] == (by_text.get(new_t) or {}).get("id", ids.get(new_t))), None)
                if o and n and o is not n:
                    o["status"] = "replaced"
                    o["replaced_by"] = n["id"]
                    event(o, "replaced", f"by {n['name']} (import)")
                    n.setdefault("replaces", []).append(o["id"])
                    event(n, "replaces", f"「{clip(o['text'], 60)}」", id=o["id"])
            save(entries)
    rec = {"at": iso(), "items": len(res["remembered"]), "merged": len(res["merged"]), "held": len(held),
           "sources": [{"path": s["path"], "sha": _sha(s["path"])} for s in {s["path"]: s for it in plan["items"] for s in it["sources"]}.values()],
           "sources_may_change_after": iso(now() + datetime.timedelta(days=7))}
    log = []
    try:
        log = json.loads(_read(imports_path()) or "[]")
    except ValueError:
        log = []
    log.append(rec)
    os.makedirs(os.path.dirname(imports_path()), exist_ok=True)
    with open(imports_path(), "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, indent=1)
    # what waits for the person: the held items, the plan's numbers kept so a pick means the same thing
    pending = dict(plan, items=held)
    with open(pending_path(), "w", encoding="utf-8") as f:
        json.dump(pending, f, ensure_ascii=False, indent=1)
    return {"imported": res["remembered"], "merged": res["merged"], "held": held, "record": rec, "pending": pending_path()}


def pending_topics():
    """The FACTS.md topics some held-back item still comes from: they stay facts until it is decided."""
    try:
        plan = json.loads(_read(pending_path()) or "{}")
    except ValueError:
        return set()
    out = set()
    for it in plan.get("items") or []:
        for src in it.get("sources") or []:
            label = src.get("label") or ""
            if src.get("kind") == "facts" and "·" in label:
                out |= topic_names(label.split("·")[1].strip())
    return out


# ---------------------------------------------------------------- the command

def _say(obj, as_json, text):
    if as_json:
        print(json.dumps(obj, ensure_ascii=False, indent=1))
    else:
        print(text)


def _entry_line(e):
    pol = "Avoid" if e.get("polarity") == "avoid" else "Like"
    return f"{pol} · {AREA_LABEL.get(e.get('area'), e.get('area'))} · {scope_label(e.get('scope'))}"


def _add_text(res):
    rows = res["remembered"]
    if not rows:
        return "nothing remembered"
    names = [f"{e.get('name')}" for e in rows]
    # the ids are for commands; the person reads the reply (they asked for no internal ids on screen)
    say = "、".join(f"「{n}」" for n in names[:3])
    last = []
    if len(rows) == 1:
        e = rows[0]
        # the head goes last: the window reads the id from it (patches/335-preferences.patch, addedIds), and
        # an agent keeping only `| tail -3` of the output still leaves it there
        last = [("Already remembered" if e["id"] in res["merged"] else "Preference remembered")
                + f" · {e.get('name')}: in your reply call it {say}, not by the id ({e['id']})"]
        lines = [f"  {_entry_line(e)}", f"  {e['text']}"]
    else:
        more = f" and {len(rows) - 2} more" if len(rows) > 2 else ""
        lines = [f"{len(rows)} preferences remembered · {', '.join(names[:2])}{more}; in your reply call them {say}, not by the ids"]
        for e in rows:
            again = " · already remembered, said again" if e["id"] in res["merged"] else ""
            lines.append(f"  {e.get('name')} ({e['id']}) · {_entry_line(e)}{again}: {clip(e['text'], 80)}")
    for rid in res["replaced"]:
        lines.append(f"  replaces {rid}: it stays in the history, agents no longer get it")
    for pid, sim in (res.get("similar") or {}).items():
        lines.append(f"Close to ones already remembered (if {pid} supersedes one: dispatch prefs edit {pid} --replaces <id>):")
        lines += [f"  - {o.get('name')} ({o['id']}) {clip(o['text'], 70)}" for _, o in sim]
    return "\n".join(lines + last)


def _list_text(rows):
    if not rows:
        return "No preferences yet. They come from what the person says about deliveries: dispatch prefs add … (dispatch prefs --help)"
    out = []
    for area in AREAS:
        group = [e for e in rows if e.get("area") == area]
        if not group:
            continue
        out.append(f"{AREA_LABEL[area]} ({len(group)})")
        for e in group:
            flags = "".join(f" [{f}]" for f, on in (("new", not e.get("seen")), ("stale", is_stale(e)), (e.get("status"), e.get("status", "active") != "active")) if on)
            out.append(f"  {'Avoid' if e.get('polarity') == 'avoid' else 'Like '}  {e.get('name')} ({e['id']}) · {scope_label(e.get('scope'))}{flags}")
            out.append(f"         {clip(e['text'], 100)}")
    return "\n".join(out)


def _show_text(e):
    lines = [f"{e.get('name')} ({e['id']})", e["text"], "",
             f"Kind      {'Avoid' if e.get('polarity') == 'avoid' else 'Like'}",
             f"Group     {AREA_LABEL.get(e.get('area'), e.get('area'))}",
             f"Applies   {scope_label(e.get('scope'))}",
             f"Said      {(e.get('said') or {}).get('at') or e.get('created')} {(e.get('said') or {}).get('engine') or ''} {(e.get('said') or {}).get('project') or ''}".rstrip(),
             f"Used      {e.get('used') or 0}" + (f", last {e.get('last_used')}" if e.get("last_used") else "")]
    if e.get("status", "active") != "active":
        lines.append(f"Status    {e.get('status')}" + (f" by {e.get('replaced_by')}" if e.get("replaced_by") else ""))
    if e.get("quote"):
        lines.append(f"Words     「{e['quote']}」")
    for q in e.get("quotes") or []:
        lines.append(f"          「{q.get('text')}」")
    if e.get("part"):
        lines.append(f"Part      {e['part']}")
    for ev in e.get("evidence") or []:
        lines.append(f"Evidence  {ev}")
    for s in e.get("sources") or []:
        lines.append(f"From      {s.get('label')} ({s.get('path')}:{s.get('line')})")
    for h in e.get("history") or []:
        lines.append(f"History   {h.get('at')} {h.get('event')} {h.get('detail') or ''}".rstrip())
    return "\n".join(lines)


def _import_text(plan, applied=None):
    lines = []
    if applied:
        lines.append(f"Imported {len(applied['imported'])} preferences ({len(applied['merged'])} into ones already there); the sources are unchanged."
                     + (f" {len(applied['held'])} wait for your pick: {applied['pending']}" if applied.get("held") else ""))
    if plan.get("places"):
        lines.append(f"{plan.get('raw', len(plan['items']))} candidates from " + ", ".join(f"{plan['sources'][s]} {n}" for s, n in plan["places"].items())
                     + f" → {len(plan['items'])} after merging the ones that say the same thing.")
    for sure in (True, False):
        mine = [it for it in plan["items"] if bool(it.get("sure", True)) == sure]
        if not mine:
            continue
        lines.append(f"\n{'Clear' if sure else 'To look at'} ({len(mine)})")
        for area in AREAS:
            group = [it for it in mine if it["area"] == area]
            if not group:
                continue
            lines.append(f"\n{AREA_LABEL[area]} ({len(group)})")
            for it in group:
                flags = (" [already there]" if it.get("already") else "") + (f" [also in {', '.join(it['also_in'])}]" if it.get("also_in") else "")
                srcs = "; ".join(dict.fromkeys(s["label"] for s in it["sources"]))
                lines.append(f"  {it.get('n', ''):>3} {'Avoid' if it['polarity'] == 'avoid' else 'Like '}  {it['name']} · {scope_label(it['scope'])}{flags}")
                lines.append(f"         {clip(it['text'], 110)}")
                lines.append(f"         from {clip(srcs, 150)}")
                if not sure and it.get("why"):
                    lines.append(f"         why: {it['why']}")
    if plan.get("skipped"):
        lines.append(f"\nLeft out ({len(plan['skipped'])}):")
        lines += [f"  {s['source']}: {s['text']} ({s['why']})" for s in plan["skipped"]]
    if not applied:
        lines.append("\nNothing was written (--dry-run). --apply writes them into ~/.dispatch/preferences.jsonl (--sure-only: the clear ones, "
                     "the rest wait for a pick; --pick 3,5,9-12: those numbers); the sources are not touched.")
    return "\n".join(lines)


def _batch_polarity(row, n):
    """Like or avoid for one --batch row: `polarity`, or `kind` / `like: true` / `avoid: true`. A row that
    says neither is refused: guessing from the sentence once turned an Avoid into a Like (2026-10-01)."""
    pol = str(row.get("polarity") or row.get("kind") or "").strip().lower()
    if not pol:
        pol = "like" if row.get("like") is True else ("avoid" if row.get("avoid") is True else "")
    if pol not in ("like", "avoid"):
        raise PrefsError(f"--batch row {n}: say \"polarity\": \"like\" or \"avoid\"")
    row["polarity"] = pol
    return row


def _read_batch():
    raw = sys.stdin.read()
    raw = raw.strip()
    if not raw:
        raise PrefsError("--batch reads the preferences from stdin: a JSON list or one JSON object a line")
    try:
        data = json.loads(raw)
        rows = data if isinstance(data, list) else [data]
    except ValueError:
        rows = []
        for n, line in enumerate(raw.splitlines(), 1):
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    raise PrefsError(f"--batch line {n} is not JSON")
    return [_batch_polarity(r, n) if isinstance(r, dict) else r for n, r in enumerate(rows, 1)]


def _polarity(a):
    if getattr(a, "like", False) and getattr(a, "avoid", False):
        raise PrefsError("--like or --avoid, not both")
    return "like" if getattr(a, "like", False) else ("avoid" if getattr(a, "avoid", False) else "")


def command(a):
    op = a.op
    args = list(getattr(a, "args", None) or [])
    as_json = bool(getattr(a, "json", False))
    thumbs = getattr(a, "thumbs", "") or ""
    if op == "add":
        if getattr(a, "batch", False):
            items = _read_batch()
        else:
            text = " ".join(args).strip()
            if text == "-":
                text = sys.stdin.read().strip()
            items = [{"text": text, "polarity": _polarity(a), "name": a.name, "area": a.area, "scope": a.scope,
                      "quote": a.quote, "part": a.part, "evidence": a.evidence, "replaces": a.replaces}]
        res = add(items)
        rows = res["remembered"]
        toast = ("Preference remembered · " + rows[0]["text"]) if len(rows) == 1 else (
            f"{len(rows)} preferences remembered · " + ", ".join(e.get("name") for e in rows[:2]) + (f" and {len(rows) - 2} more" if len(rows) > 2 else ""))
        obj = {"ok": True, "remembered": [view(e) for e in rows], "merged": res["merged"], "replaced": res["replaced"],
               "similar": {k: [{"id": o["id"], "name": o.get("name"), "text": o["text"], "score": round(s, 2)} for s, o in v] for k, v in res["similar"].items()},
               "toast": toast, "store": store_path()}
        _say(obj, as_json, _add_text(res))
        return 0
    if op == "list":
        ids = [x for x in re.split(r"[,\s]+", getattr(a, "ids", "") or "") if x]
        entries = load()
        rows = listing(entries, area=a.area or "", project=a.project or "", new=a.new, stale=a.stale, include_all=a.all, ids=ids)
        gone = []
        if ids:
            missing = [i for i in ids if i not in {e["id"] for e in rows}]
            for rid, (r, _) in forgotten(set(missing)).items():
                g = dict(r["entry"])
                g["status"] = "forgotten"
                g["forgotten_at"] = r["at"]
                gone.append(g)
        active = [e for e in entries if e.get("status", "active") == "active"]
        obj = {"ok": True, "items": [view(e, thumbs) for e in rows] + [view(g, thumbs) for g in gone], "store": store_path(),
               "counts": {"active": len(active), "new": sum(1 for e in active if not e.get("seen")),
                          "stale": sum(1 for e in active if is_stale(e)),
                          "areas": {ar: sum(1 for e in active if e.get("area") == ar) for ar in AREAS}},
               "areas": [{"id": ar, "label": AREA_LABEL[ar], "description": AREA_DESC[ar]} for ar in AREAS]}
        _say(obj, as_json, _list_text(rows))
        return 0
    if op == "show":
        if not args:
            raise PrefsError("dispatch prefs show <name or id>")
        entries = load()
        try:
            e = find(entries, args[0], statuses=())
        except PrefsError:
            gone = forgotten({args[0]})
            if not gone:
                raise
            e = dict(next(iter(gone.values()))[0]["entry"])
            e["status"] = "forgotten"
        v = view(e, thumbs or ("card" if as_json else ""))
        rel = [x for x in entries if x["id"] in (e.get("replaces") or []) or x["id"] == e.get("replaced_by")]
        v["related"] = [{"id": x["id"], "name": x.get("name"), "text": x["text"], "status": x.get("status", "active"),
                         "said_at": (x.get("said") or {}).get("at") or x.get("created")} for x in rel]
        _say({"ok": True, "pref": v}, as_json, _show_text(e))
        return 0
    if op == "edit":
        if not args:
            raise PrefsError("dispatch prefs edit <name or id> --text … | --name … | --like | --avoid | --area … | --scope …")
        changes = {"text": a.text, "name": a.name, "polarity": _polarity(a) or None, "area": a.area, "scope": a.scope,
                   "quote": a.quote, "part": a.part, "evidence": a.evidence, "replaces": a.replaces}
        if changes["text"] == "-":
            changes["text"] = sys.stdin.read()
        e = edit(args[0], changes)
        _say({"ok": True, "pref": view(e)}, as_json, f"Updated · {e.get('name')} ({e['id']})\n  {_entry_line(e)}\n  {e['text']}")
        return 0
    if op == "forget":
        res = forget(args, just_said=bool(getattr(a, "just_said", False)))
        names = ", ".join(e.get("name") for e in res["forgotten"])
        lines = []
        if res["forgotten"]:
            lines.append(f"Forgotten · {names} (agents stop getting it from the next session; `dispatch prefs undo` brings it back)")
        for e in res["kept"]:
            lines.append(f"Kept as before · {e.get('name')} ({e['id']}): it was remembered before, only the words just said are gone")
        _say({"ok": True, "forgotten": [{"id": e["id"], "name": e.get("name"), "text": e["text"]} for e in res["forgotten"]],
              "kept": [{"id": e["id"], "name": e.get("name"), "text": e["text"]} for e in res["kept"]],
              "restored": res["restored"], "backup": res["backup"]}, as_json, "\n".join(lines))
        return 0
    if op == "undo":
        res = undo(args[0] if args else "")
        _say({"ok": True, "restored": [view(e) for e in res["restored"]]}, as_json,
             "Back · " + ", ".join(f"{e.get('name')} ({e['id']})" for e in res["restored"]))
        return 0
    if op in ("cite", "keep", "seen"):
        if op == "cite":
            hit = cite(args, by=a.by or "", for_=getattr(a, "for_", "") or "", ref=getattr(a, "ref", "") or "")
        elif op == "keep":
            hit = keep(args)
        else:
            hit = seen(args, everything=a.all or not args)
        _say({"ok": True, "ids": [e["id"] for e in hit]}, as_json, f"{op}: {', '.join(e.get('name') for e in hit) or 'nothing to change'}")
        return 0
    if op == "stale":
        rows = [e for e in load() if is_stale(e, days=a.days or STALE_DAYS)]
        _say({"ok": True, "items": [view(e) for e in rows]}, as_json, _list_text(rows))
        return 0
    if op == "thumbs":
        if getattr(a, "make", False):
            made = make_thumbs_for(args[0]) if args else []
            _say({"ok": True, "made": made}, as_json, "\n".join(made) or "no thumbnail")
            return 0
        entries = load()
        want = set(args)
        out = {e["id"]: data_uri(thumb_paths(e).get(thumbs or "chip", "")) for e in entries if (not want or e["id"] in want) and thumb_paths(e)}
        _say({"ok": True, "thumbs": out}, as_json, json.dumps(out)[:2000])
        return 0
    if op == "import":
        sources = [s.strip() for s in re.split(r"[,\s]+", getattr(a, "sources", "") or "") if s.strip()] or list(DEFAULT_SOURCES)
        if getattr(a, "plan", ""):
            plan = json.loads(_read(a.plan) or "{}")
            if not plan.get("items"):
                raise PrefsError(f"{a.plan} is not an import plan")
        else:
            plan = plan_import(sources, project=a.project or "")
        if getattr(a, "out", ""):
            if not getattr(a, "apply", False):
                with open(a.out, "w", encoding="utf-8") as f:
                    json.dump(plan, f, ensure_ascii=False, indent=1)
        if getattr(a, "apply", False):
            res = apply_import(plan, picks=getattr(a, "pick", "") or "", sure_only=bool(getattr(a, "sure_only", False)))
            _say({"ok": True, "dry_run": False, "plan": plan, "imported": [e["id"] for e in res["imported"]], "merged": res["merged"],
                  "held": [it.get("n") for it in res["held"]], "pending": res["pending"], "record": res["record"]},
                 as_json, _import_text(plan, res))
        else:
            _say({"ok": True, "dry_run": True, "plan": plan}, as_json, _import_text(plan))
        return 0
    if op == "prime":
        project = a.project or project_of(os.getcwd())
        print("\n".join(prime_section(project, cwd=os.getcwd())) or "No preferences for this project yet.")
        return 0
    raise PrefsError(f"unknown operation {op}")


def run(a, d_module=None):
    global D
    if d_module is not None:
        D = d_module
    try:
        return command(a)
    except PrefsError as e:
        if getattr(a, "json", False):
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        else:
            print(str(e), file=sys.stderr)
        return 1
