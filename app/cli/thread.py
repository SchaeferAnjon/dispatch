# -*- coding: utf-8 -*-
"""`dispatch thread`: the 脉络 page: one line per idea.

A line is a tree of tasks: its root is a task with no parent (no `discovered-from` /
`parent-child` dependency and no `discussed-in:` label), and every task split off it, at any depth,
belongs to the same line. The line reads top to bottom in time. Each record is a *beat* of one of a
few kinds, worked out here so the page only draws:

  ask      你说      the user's own words (description 「用户提出…」, a human comment, 「用户追加：」)
  discuss  讨论      one round of 【讨论】 comments, folded into one row
  decide   结论      【结论】 / 【决定】 (`dispatch decide`) / 【分工】 / 「用户决定：」「用户认可」
  claim    接手      「接手：」 and 「… 通过 dispatch agent 派给 X」
  did      做了      any other progress note; three or more in a row fold into one row
  done     收尾      close_reason + closed_at, with the task's commits and 已验证 / 未验证
  fork     分出      a task split off here, folded; opening it shows that task's own line
  open     开着      an unfinished task at the tail (state open / wait = 等你 / run = 在跑)
  gap                more than GAP_DAYS between two beats
  created            the root was opened and nobody's words are on record

A project's 脉络 (`dispatch thread <project>`) puts every line of the project in one timeline, one
chapter per line, the newest move at the bottom: three boxes for the whole project (走到哪 / 剩下 /
这个项目), the recent chapters listed (older ones behind 更早), the few moving ones opened with their
records, the rest opened on demand with `dispatch thread <root>`.

Everything is structured data (counts, ids, timestamps); the page builds the sentences, so they
translate. `dispatch decide <task> "一句话"` writes the 【决定】 comment the line marks blue.
"""
import json, os, re, sys, time
from lang import t as _t

import dispatch as D
import lineage as L

GAP_DAYS = 3
FOLD_MIN = 3
RECENT_DAYS = 14
SHOW_CHAPTERS = 20      # a project's 脉络 shows its newest lines; the rest wait behind 更早
EXPAND_CHAPTERS = 3     # and opens the most recent moving ones with their records
NO_PROJECT = "未分项目"  # the 脉络 board for lines nobody gave a project
TREE_DEPS = ("discovered-from", "parent-child")
HUMAN_SAYS = ("用户追加", "用户补充", "用户反馈", "用户说", "用户要求", "用户提出", "用户：", "用户:")
HUMAN_DECIDES = ("用户决定", "用户拍板", "用户定", "用户认可", "用户确认")
DECIDE_TAGS = ("【结论】", "【决定】", "【分工】")
BOTS = D.AGENT_ACTORS | {"dispatch", "system"}
HASH = r"(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,12}"
HASH_RE = re.compile(rf"(?<![0-9a-zA-Z]){HASH}(?![0-9a-zA-Z])")


# ---------------------------------------------------------------- small text helpers

def squash(text):
    return re.sub(r"\s+", " ", text or "").strip()


def first_sentence(text, cap=200):
    s = L.first_sentence(text or "")
    return s[:cap]


LOOSE = r"[0-9a-f]{7,12}"
SEP = r"\s*(?:、|,|，|/|…|\.\.\.|和|and)\s*|\s+"


def strip_hashes(text):
    """A close reason without its commit list: 「…，提交 9156854、b7a14cf，已 push」 → 「…，已 push」."""
    t = text or ""
    # After 「提交」, or two or more in a row, an all-digit hash counts too.
    t = re.sub(rf"(?:提交|commits?)[：: ]*(?:{LOOSE}(?:{SEP}))*{LOOSE}(?![0-9a-zA-Z])", "", t)
    t = re.sub(rf"(?<![0-9a-zA-Z])(?:{LOOSE}(?:{SEP}))+{LOOSE}(?![0-9a-zA-Z])", lambda m: "" if HASH_RE.search(m.group(0)) else m.group(0), t)
    t = HASH_RE.sub("", t)
    t = re.sub(r"（(未核验|已核验)）|\s*\((?:not verified|verified)\)|（\s*）|\(\s*\)", "", t)
    t = re.sub(r"[，,、]\s*(?=[，。,.；;])", "", t)
    t = re.sub(r"^[，,、。\s]+", "", t)
    return squash(t)


def hashes_in(text):
    seen, out = set(), []
    found = [(m.start(), m.group(0)) for m in HASH_RE.finditer(text or "")]
    for m in re.finditer(rf"(?:提交|commits?)[：: ]*((?:{LOOSE}(?:{SEP}))*{LOOSE})(?![0-9a-zA-Z])", text or ""):
        found += [(m.start(1) + x.start(), x.group(0)) for x in re.finditer(LOOSE, m.group(1))]
    for _, h in sorted(found):
        if h[:7] not in seen:
            seen.add(h[:7])
            out.append(h[:7])
    return out


def numbers_of(text):
    """What a folded step shows in its one-line summary: the measured change, else its start."""
    m = re.search(r"\d[\d.,]*\s*[A-Za-z%]*\s*(?:→|->)\s*\d[\d.,]*\s*[A-Za-z%]*", text or "")
    if m:
        return squash(m.group(0))
    head = re.split(r"[，,：:；;。]", first_sentence(text), maxsplit=1)[0]
    return head[:18] + ("…" if len(head) > 18 else "")


def is_human(author):
    a = (author or "").lower()
    return bool(a) and a not in BOTS


def project_of(t):
    return next((l.split(":", 1)[1] for l in t.get("labels") or [] if l.startswith("project:")), "")


def sessions_of(t):
    return {l.split(":", 1)[1] for l in t.get("labels") or [] if l.startswith(("session:", "session-origin:"))}


def is_open(t):
    """Still to do: 搁置 (deferred) is out of the way, as in 项目回顾's 还没做完."""
    return t.get("status") not in ("closed", "deferred")


def origin_session(t):
    return next((l.split(":", 1)[1] for l in t.get("labels") or [] if l.startswith("session-origin:")), "")


# ---------------------------------------------------------------- the forest

def board_issues(rows=None):
    return line_issues(L.board_export() if rows is None else rows)


def line_issues(rows):
    """Everything on the board a line can hold: outcomes, recycled and tombstoned tasks drop out."""
    keep = []
    for t in rows:
        labels = t.get("labels") or []
        if t.get("status") == "tombstone" or "dispatch:outcome" in labels or "dispatch:trashed" in labels:
            continue
        keep.append(t)
    return keep


def parent_of(t, ids):
    """The task this one was split off: the earliest-listed tree dependency, else `discussed-in:`."""
    for d in t.get("dependencies") or []:
        if d.get("type") in TREE_DEPS and d.get("depends_on_id") in ids and d.get("depends_on_id") != t.get("id"):
            return d["depends_on_id"]
    for l in t.get("labels") or []:
        if l.startswith("discussed-in:") and l.split(":", 1)[1] in ids:
            return l.split(":", 1)[1]
    return ""


def forest(issues):
    """(by id, parent map, children map oldest first). A dependency cycle is cut where it closes."""
    by = {t["id"]: t for t in issues if t.get("id")}
    parent = {}
    for tid, t in by.items():
        p = parent_of(t, by)
        # Walk up from p: if we come back to tid, linking would close a loop; leave tid a root.
        seen, x = {tid}, p
        while x and x not in seen:
            seen.add(x)
            x = parent.get(x, "")
        if p and x != tid:
            parent[tid] = p
    children = {}
    for c, p in parent.items():
        children.setdefault(p, []).append(c)
    for p in children:
        children[p].sort(key=lambda c: (by[c].get("created_at") or "", c))
    return by, parent, children


def root_of(tid, parent):
    seen = set()
    while parent.get(tid) and tid not in seen:
        seen.add(tid)
        tid = parent[tid]
    return tid


def subtree(root, children):
    out, stack = [], [root]
    while stack:
        x = stack.pop()
        out.append(x)
        stack.extend(reversed(children.get(x) or []))
    return out


# ---------------------------------------------------------------- context shared by every line

class Ctx:
    """One board read, one git log per repo, one look at the live sessions, for a whole report."""

    def __init__(self, issues, live=None, index=None, cwd=""):
        self.by, self.parent, self.children = forest(line_issues(issues))
        self.cwd = cwd
        self._live = live
        self._index = index
        self._commits = {}
        self._logs = {}
        self._names = None
        self._home = None

    def home(self, tid):
        """The project a task counts under: its own project label, else the nearest ancestor's
        (a task split off without a label stays with its line), else "" (no project)."""
        if self._home is None:
            self._home = {}
        if tid not in self._home:
            x, seen = tid, set()
            while x and x not in seen:
                seen.add(x)
                p = project_of(self.by[x])
                if p:
                    break
                x = self.parent.get(x, "")
            self._home[tid] = project_of(self.by[x]) if x and x in self.by else ""
        return self._home[tid]

    def home_root(self, tid):
        """The top of `tid`'s line inside its own project: a task of project X that was split off a
        line of project Y starts a chapter of X there."""
        want = self.home(tid).lower()
        x, seen = tid, set()
        while self.parent.get(x) and x not in seen and self.home(self.parent[x]).lower() == want:
            seen.add(x)
            x = self.parent[x]
        return x

    def within(self, ids):
        """The same board seen through one project: only `ids`, split where a line crosses into
        another project. Sessions, commits and project names still come from the whole board."""
        return SubCtx(self, ids)

    def names(self):
        if self._names is None:
            self._names = D.project_names(list(self.by.values()))
        return self._names

    def roots(self):
        """The workspace roots from 设置, read once per report."""
        if getattr(self, "_roots", None) is None:
            try:
                self._roots = D.settings_load().get("workspace_roots") or []
            except Exception:
                self._roots = []
        return self._roots

    def live_rows(self):
        """`live_sessions()` once per report: the open column and the line states share it."""
        if getattr(self, "_live_rows", None) is None:
            try:
                self._live_rows = D.live_sessions()
            except Exception:
                self._live_rows = []
        return self._live_rows

    def live(self):
        """session id → state (working / idle) for conversations running right now."""
        if self._live is None:
            rows = self.live_rows()
            self._live = {r.get("session_id"): (r.get("state") or "unknown") for r in rows if r.get("alive") and r.get("session_id")}
        return self._live

    def index(self):
        if self._index is None:
            self._index = {}
            for e in (D.load_index() or {}).values():
                if e.get("session_id") and not e.get("subagent"):
                    self._index.setdefault(e["session_id"], e)
        return self._index

    def commits(self, proj):
        """task id → [(ts, short hash, subject)] from the project's repo, the whole history."""
        if proj in self._commits:
            return self._commits[proj]
        got = {}
        try:
            root = D.git_root_of(L.project_base(proj, self.cwd or os.getcwd(), self.names(), self.roots()))
        except Exception:
            root = ""
        log = []
        if root:
            code, o, _ = D.sh(["git", "-C", root, "log", "--date=iso-strict", "--pretty=%h%x1f%cI%x1f%s"], timeout=30)
            if code == 0:
                for line in o.splitlines():
                    parts = line.split("\x1f")
                    if len(parts) != 3:
                        continue
                    row = (L.iso_epoch(parts[1]), parts[0][:7], parts[2][:200])
                    log.append(row)
                    for tid in set(re.findall(r"task-[a-z0-9]{2,}", parts[2])):
                        got.setdefault(tid, []).append(row)
        for v in got.values():
            v.sort()
        self._commits[proj] = got
        self._logs[proj] = log
        return got

    def log(self, proj):
        """Every commit of the project's repo, newest first: (ts, short hash, subject)."""
        if proj not in self._logs:
            self.commits(proj)
        return self._logs.get(proj) or []


class SubCtx(Ctx):
    def __init__(self, base, ids):
        keep = set(ids)
        self.base = base
        self.by = {x: base.by[x] for x in base.by if x in keep}
        self.parent = {c: p for c, p in base.parent.items() if c in keep and p in keep}
        self.children = {}
        for p, cs in base.children.items():
            if p in keep:
                got = [c for c in cs if c in keep]
                if got:
                    self.children[p] = got
        self.cwd = base.cwd
        self._home = None

    def names(self):
        return self.base.names()

    def roots(self):
        return self.base.roots()

    def live_rows(self):
        return self.base.live_rows()

    def live(self):
        return self.base.live()

    def index(self):
        return self.base.index()

    def commits(self, proj):
        return self.base.commits(proj)

    def log(self, proj):
        return self.base.log(proj)

    def home(self, tid):
        return self.base.home(tid)


def project_key(proj):
    """What `home()` gives for this project: lower case, and "" for 未分项目."""
    p = (proj or "").strip()
    return "" if p == NO_PROJECT else p.lower()


def project_members(ctx, proj):
    want = project_key(proj)
    return [tid for tid in ctx.by if ctx.home(tid).lower() == want]


# ---------------------------------------------------------------- beats of one task

def comments_of(t):
    return sorted(t.get("comments") or [], key=lambda c: c.get("created_at") or "")


def task_commits(t, ctx):
    """Short hashes for a task, oldest first: its 「提交：」 notes, its close reason, and commits whose
    subject names it."""
    out, seen = [], set()

    def add(h):
        if h[:7] not in seen:
            seen.add(h[:7])
            out.append(h[:7])

    for c in comments_of(t):
        if (c.get("text") or "").lstrip().startswith("提交"):
            # `dispatch done` lists them newest first, like git log; the line reads oldest first.
            for line in reversed((c.get("text") or "").splitlines()):
                m = re.match(rf"\s*({HASH})\b", line)
                if m:
                    add(m.group(1))
    for h in hashes_in(t.get("close_reason") or ""):
        add(h)
    known = {h: ts for ts, h, _ in ctx.commits(project_of(t)).get(t["id"], [])}
    for h in known:
        add(h)
    # Oldest first where git knows the time; the rest keep the order they were written in.
    order = {h: i for i, h in enumerate(out)}
    return sorted(out, key=lambda h: (known.get(h, float("inf")) if known else 0, order[h]))


def verified_of(reason):
    if not reason:
        return None
    if "未核验" in reason or "未验证" in reason or "(not verified)" in reason:
        return False
    if "核验" in reason or "已验证" in reason or re.search(r"\bverified\b", reason, re.I):
        return True
    return None


CHECKER = "dispatch-checker"
VERIFY_TAG = "【验收】"
VERIFY_ITEM = re.compile(r"^\s*(\d+)\s*[.、．]\s*([✓✔×✗✘?？])\s*([^·]*?)\s*·\s*(.*)$")


def parse_verify(raw):
    """The independent checker's 【验收】 comment: 「【验收】claude:sonnet · 2026-09-25 14:21 · 耗时 37s」,
    then one line per acceptance item 「N. ✓ 已验证 · …」 / 「? 需要你确认」 / 「✗ 未通过」."""
    lines = (raw or "").strip().splitlines()
    head = re.sub(r"^【验收】\s*", "", lines[0] if lines else "")
    parts = [p.strip() for p in head.split(" · ")]
    secs = 0
    for p in parts:
        m = re.search(r"耗时\s*(\d+)\s*s", p)
        if m:
            secs = int(m.group(1))
    err = next((" · ".join(parts[i:]) for i, p in enumerate(parts) if p.startswith("没跑成")), "")
    items = []
    for line in lines[1:]:
        m = VERIFY_ITEM.match(line)
        if not m:
            continue
        mark = m.group(2)
        state = "ok" if mark in "✓✔" else "ask" if mark in "?？" else "fail"
        items.append({"n": int(m.group(1)), "state": state, "text": first_sentence(m.group(4), 200), "full": squash(m.group(4))[:800]})
    return {"ok": sum(1 for x in items if x["state"] == "ok"), "ask": sum(1 for x in items if x["state"] == "ask"),
            "fail": sum(1 for x in items if x["state"] == "fail"), "model": parts[0] if parts and not parts[0].startswith("没跑成") else "",
            "secs": secs, "error": first_sentence(re.sub(r"^没跑成[：:]\s*", "", err), 160) if err else "", "items": items}


def verify_words(v):
    """The checker's result in one sentence in the person's language, for the terminal and older pages."""
    if v.get("error") and not v["items"]:
        return _t("The check did not run: ", "验收没跑成：") + v["error"]
    bits = []
    if v["ok"]:
        bits.append(_t(f"{v['ok']} passed", f"{v['ok']} 项通过"))
    if v["ask"]:
        bits.append(_t(f"{v['ask']} for you to confirm", f"{v['ask']} 项要你确认"))
    if v["fail"]:
        bits.append(_t(f"{v['fail']} failed", f"{v['fail']} 项未通过"))
    return _t(", ", "，").join(bits) or _t("no acceptance items", "没有验收项")


def verify_beat(raw, ts, tid, who):
    v = parse_verify(raw)
    return {"kind": "verify", "ts": ts, "task": tid, "who": who or CHECKER, "text": verify_words(v), "full": squash(raw)[:1500], "verify": v}


def discussion_member(text):
    """「【讨论】codex（GPT-6）：…」 → ("codex", "GPT-6", "…")."""
    body = text[len("【讨论】"):].strip()
    m = re.match(r"^([^\s：:（(]{1,24})\s*(?:[（(]([^）)]{1,40})[）)])?\s*[：:]\s*(.*)$", body, re.S)
    if not m:
        return "", "", body
    return m.group(1), m.group(2) or "", m.group(3).strip()


def task_beats(t, ctx):
    """This task's own records, oldest first, before folding: comments, then the close."""
    tid = t["id"]
    beats, round_ = [], None
    for c in comments_of(t):
        raw = (c.get("text") or "").strip()
        text = squash(raw)
        ts = L.iso_epoch(c.get("created_at"))
        who = c.get("author") or ""
        if not text or text.startswith(("【系统】", "[system]", "提交：", "提交:", "Commits:")):
            continue
        if text.startswith("【讨论】"):
            name, model, body = discussion_member(raw)
            if name == "发起" or body.startswith(("发起", "邀请")) or text.startswith("【讨论】发起"):
                continue
            if round_ is None:
                round_ = {"kind": "discuss", "ts": ts, "task": tid, "who": who, "members": []}
                beats.append(round_)
            round_["members"].append({"ts": ts, "who": name or who, "model": model, "text": first_sentence(body), "full": squash(body)[:1200]})
            continue
        round_ = None
        if text.startswith(VERIFY_TAG) or (who or "").lower() == CHECKER:
            beats.append(verify_beat(raw, ts, tid, who))
            continue
        tag = next((x for x in DECIDE_TAGS if text.startswith(x)), "")
        if tag:
            body = text[len(tag):].strip()
            beats.append({"kind": "decide", "ts": ts, "task": tid, "who": who, "tag": tag.strip("【】"), "text": first_sentence(body, 300), "full": body[:1200]})
            continue
        said = next((x for x in HUMAN_DECIDES if text.startswith(x)), "")
        if said:
            body = re.sub(r"^[：:\s]+", "", text[len(said):]) if said.endswith(("决定", "拍板", "定")) else text
            beats.append({"kind": "decide", "ts": ts, "task": tid, "who": who, "tag": "拍板", "text": first_sentence(body, 300), "full": body[:1200]})
            continue
        m = re.match(r"^(\S+) 通过 dispatch agent 派给 (\S+?)（(.*)）", text)
        if m:
            beats.append({"kind": "claim", "ts": ts, "task": tid, "who": m.group(2), "text": "", "routed": True, "routed_by": m.group(1)})
            continue
        if is_human(who) or text.startswith(HUMAN_SAYS):
            body = re.sub(r"^用户[^：:]{0,4}[：:]\s*", "", text)
            beats.append({"kind": "ask", "ts": ts, "task": tid, "who": who, "text": first_sentence(body, 300), "full": body[:1200]})
            continue
        if re.match(r"^(接手|开工|开始)[：:]", text):
            body = re.sub(r"^(接手|开工|开始)[：:]\s*", "", text)
            last = beats[-1] if beats else None
            if last and last["kind"] == "claim" and last.get("routed") and not last["text"] and ts - last["ts"] < 3600:
                last.update(text=first_sentence(body, 300), full=body[:1200], who=who or last["who"])
            else:
                beats.append({"kind": "claim", "ts": ts, "task": tid, "who": who, "text": first_sentence(body, 300), "full": body[:1200]})
            continue
        body = re.sub(r"\s*（勾掉 \d+ 条验收项）", "", text)
        beats.append({"kind": "did", "ts": ts, "task": tid, "who": who, "text": first_sentence(body), "full": body[:1200], "commits": hashes_in(body)})
    if t.get("status") == "closed":
        reason = t.get("close_reason") or ""
        clean = strip_hashes(reason)
        beats.append({"kind": "done", "ts": L.iso_epoch(t.get("closed_at") or t.get("updated_at")), "task": tid, "who": t.get("assignee") or "",
                      "text": first_sentence(clean, 240), "full": clean[:1500], "commits": task_commits(t, ctx), "verified": verified_of(reason)})
    return beats


def fold_steps(beats):
    """Three or more 做了 in a row (same task) become one row; the steps sit inside it."""
    out, run = [], []

    def flush():
        if len(run) >= FOLD_MIN:
            out.append({"kind": "did", "ts": run[0]["ts"], "task": run[0]["task"], "who": run[0].get("who", ""), "fold": True,
                        "count": len(run), "from_ts": run[0]["ts"], "to_ts": run[-1]["ts"],
                        "summary": [numbers_of(b.get("full") or b["text"]) for b in run], "beats": list(run)})
        else:
            out.extend(run)
        run.clear()

    for b in beats:
        if b["kind"] == "did" and not b.get("fold") and (not run or run[-1]["task"] == b["task"]):
            run.append(b)
            continue
        flush()
        if b["kind"] == "did" and not b.get("fold"):
            run.append(b)
        else:
            out.append(b)
    flush()
    return out


def open_state(t, ctx):
    labels = t.get("labels") or []
    if t.get("status") == "in_progress" and any(ctx.live().get(s) == "working" for s in sessions_of(t)):
        return "run"
    if "dispatch:needs-you" in labels:
        return "wait"
    return "open"


def open_beat(t, ctx, from_id=""):
    frm = ctx.by.get(from_id) or {}
    return {"kind": "open", "ts": L.iso_epoch(t.get("updated_at") or t.get("created_at")), "task": t["id"], "title": display_title(t),
            "state": open_state(t, ctx), "status": t.get("status") or "open", "assignee": t.get("assignee") or "",
            "from": from_id, "from_title": short_title(frm) if frm else ""}


def descendants(tid, ctx):
    return subtree(tid, ctx.children)[1:]


def line_beats(tid, ctx, top=False):
    """A task's records merged with a 分出 row for every task split off it, oldest first."""
    t = ctx.by[tid]
    beats = task_beats(t, ctx)
    for cid in ctx.children.get(tid) or []:
        c = ctx.by[cid]
        inner = line_beats(cid, ctx)
        subs = descendants(cid, ctx)
        if c.get("status") != "closed" and not inner and not subs:
            b = open_beat(c, ctx, tid)
            b["ts"] = L.iso_epoch(c.get("created_at"))
            beats.append(b)
            continue
        opened = [ctx.by[x] for x in subs if ctx.by[x].get("status") != "closed"]
        # An unfinished split-off task ends its own fold with where it stands.
        if c.get("status") != "closed":
            inner = inner + [open_beat(c, ctx, tid)]
        beats.append({"kind": "fork", "ts": L.iso_epoch(c.get("created_at")), "task": cid, "title": display_title(c),
                      "status": c.get("status") or "open", "state": open_state(c, ctx) if c.get("status") != "closed" else "done",
                      "closed_at": L.iso_epoch(c.get("closed_at")) if c.get("status") == "closed" else 0,
                      "commits": task_commits(c, ctx) if c.get("status") == "closed" else [],
                      "open_after": len(opened), "tasks": 1 + len(subs), "beats": inner})
    beats.sort(key=lambda b: (b["ts"], 0 if b["kind"] != "fork" else 1))
    return fold_steps(beats)


def with_gaps(beats):
    out = []
    for b in beats:
        if out and b["ts"] - out[-1]["ts"] > GAP_DAYS * 86400:
            out.append({"kind": "gap", "ts": out[-1]["ts"], "days": int((b["ts"] - out[-1]["ts"]) // 86400)})
        out.append(b)
    return out


def by_day(beats, now=None):
    now = now or time.time()
    today = time.strftime("%Y-%m-%d", time.localtime(now))
    days = []
    for b in beats:
        lt = time.localtime(b["ts"] or now)
        day = time.strftime("%Y-%m-%d", lt)
        if b["kind"] == "gap" and days:
            days[-1]["beats"].append(b)
            continue
        if not days or days[-1]["date"] != day:
            days.append({"date": day, "weekday": lt.tm_wday, "today": day == today, "beats": []})
        days[-1]["beats"].append(b)
    return days


# ---------------------------------------------------------------- titles, the user's words, the three boxes

def original_title(t):
    m = re.search(r"^(?:原标题|Original title)[：:]\s*(.+)$", t.get("description") or "", re.M)
    return squash(m.group(1)) if m else ""


def display_title(t):
    override = next((l.split(":", 1)[1] for l in t.get("labels") or [] if l.startswith("thread:")), "")
    title = re.sub(r"^【讨论】\s*", "", override or original_title(t) or squash(t.get("title") or t.get("id", "")))
    # A title cut off by the board (the discussion topic pasted whole) reads best up to its first full stop.
    head = re.split(r"。", title, maxsplit=1)[0].strip()
    return head if len(head) >= 4 else title


def short_title(t):
    """The list row's name: the title up to its first 「：」 or 「。」 when that part says enough."""
    full = display_title(t)
    head = re.split(r"[：:。]", full, maxsplit=1)[0].strip()
    balanced = head.count("（") == head.count("）") and head.count("(") == head.count(")")
    return head if len(head) >= 4 and head != full and balanced else full


def looks_like_words(text):
    """A session's opening message is the user's words only when it reads like a sentence, not a
    skill or document pasted in first."""
    s = (text or "").strip()
    return bool(s) and not s.startswith(("#", "<", "/", "{", "[", "```", "Base directory")) and "\n#" not in s[:200]


def original_words(t, ctx):
    """What the user asked for, in their words: the description's 「用户提出…」 paragraph, the
    「原标题」 line when it quotes the user, else the opening message of the conversation it
    started in."""
    desc = t.get("description") or ""
    at = L.iso_epoch(t.get("created_at"))
    for para in re.split(r"\n\s*\n", desc):
        m = re.search(r"用户(提出|反馈|说|要|希望|想)[^\n]*", para)
        if m:
            text = squash(para[m.start():])
            text = re.sub(r"^用户(提出|反馈的问题|反馈|说)[：:，,]?\s*", "", text)
            return {"text": text[:1200], "at": at, "source": "description", "session_id": ""}
    ot = original_title(t)
    if "用户" in ot:
        return {"text": ot[ot.index("用户"):][:1200], "at": at, "source": "description", "session_id": ""}
    sid = origin_session(t)
    e = ctx.index().get(sid) if sid else None
    if e and looks_like_words(e.get("first_prompt")):
        return {"text": squash(e["first_prompt"])[:1200], "at": L.iso_epoch(e.get("first_ts")) or at, "source": "session", "session_id": sid}
    return None


def flatten(beats):
    for b in beats:
        yield b
        for x in b.get("beats") or []:
            yield from flatten([x])


def line_state(tasks, ctx):
    states = [open_state(t, ctx) for t in tasks if is_open(t)]
    return "run" if "run" in states else "wait" if "wait" in states else "open" if states else "done"


def last_move(tasks):
    at = 0.0
    for t in tasks:
        at = max(at, L.iso_epoch(t.get("updated_at")), L.iso_epoch(t.get("closed_at")))
        for c in t.get("comments") or []:
            at = max(at, L.iso_epoch(c.get("created_at")))
    return at


def summary_row(root, ctx):
    ids = subtree(root, ctx.children)
    tasks = [ctx.by[x] for x in ids]
    t = ctx.by[root]
    open_ = [x for x in tasks if is_open(x)]
    return {"root": root, "title": display_title(t), "short": short_title(t), "project": ctx.home(root),
            "state": line_state(tasks, ctx), "open_count": len(open_), "task_count": len(tasks),
            "closed_count": sum(1 for x in tasks if x.get("status") == "closed"), "last_at": last_move(tasks), "single": len(tasks) == 1}


def thread_report(tid, ctx, now=None):
    """The whole line holding `tid`, from its root: header boxes, dated beats, the open tail."""
    root = root_of(tid, ctx.parent)
    t = ctx.by[root]
    ids = subtree(root, ctx.children)
    tasks = [ctx.by[x] for x in ids]
    row = summary_row(root, ctx)
    ask = original_words(t, ctx)
    beats = line_beats(root, ctx, top=True)
    host = next((c.get("author") or "" for c in comments_of(t) if (c.get("text") or "").startswith("【讨论】发起")), "")
    discussion = "dispatch:discussion" in (t.get("labels") or [])
    if ask:
        first = {"kind": "ask", "ts": L.iso_epoch(t.get("created_at")), "task": root, "who": "", "text": first_sentence(ask["text"], 300),
                 "full": ask["text"], "opening": True, "discussion": discussion, "host": host}
    else:
        first = {"kind": "created", "ts": L.iso_epoch(t.get("created_at")), "task": root, "who": t.get("created_by") or "",
                 "text": display_title(t), "opening": True, "discussion": discussion, "host": host}
    beats = [first] + beats
    top = with_gaps(beats)

    all_beats = list(flatten(beats))
    open_tasks = [x for x in tasks if is_open(x)]
    tail = [open_beat(x, ctx, ctx.parent.get(x["id"], "") if x["id"] != root else "") for x in open_tasks]
    tail.sort(key=lambda b: ({"run": 0, "wait": 1}.get(b["state"], 2), b["ts"]))

    closes = sorted((b for b in all_beats if b["kind"] == "done"), key=lambda b: b["ts"])
    main_close = next((b for b in closes if b["task"] == root), None)
    notes = [b for b in all_beats if b["kind"] in ("did", "decide", "claim", "ask", "done") and not b.get("fold") and b.get("text")]
    latest = max(notes, key=lambda b: b["ts"]) if notes else None
    forks = [x for x in ids if x != root]
    commits = set()
    for x in tasks:
        commits.update(task_commits(x, ctx))
    agents = []
    for x in tasks:
        for who in [x.get("assignee") or ""] + [c.get("author") or "" for c in comments_of(x)]:
            if who and who.lower() in D.AGENT_ACTORS and who not in agents:
                agents.append(who)
    sessions = set()
    for x in tasks:
        sessions |= sessions_of(x)
    return {
        "root": root, "selected": tid, "project": ctx.home(root), "title": row["title"],
        # The selected task's own project and the chapter it sits in there (a task of project X
        # split off a line of Y is a chapter of X): the page follows these, not the line's root.
        "home_project": ctx.home(tid), "home_root": ctx.home_root(tid), "short": row["short"], "state": row["state"],
        "task_count": len(tasks), "closed_count": row["closed_count"], "open_count": row["open_count"], "session_count": len(sessions),
        "last_at": row["last_at"], "ask": ask,
        "now": {
            "main": {"closed_at": main_close["ts"], "text": main_close["text"]} if main_close else None,
            "latest": {"at": latest["ts"], "text": latest["text"], "kind": latest["kind"], "task": latest["task"]} if latest else None,
            "branches": {"total": len(forks), "closed": sum(1 for x in forks if ctx.by[x].get("status") == "closed")},
            "last_at": row["last_at"],
        },
        "left": [{"id": b["task"], "title": b["title"], "short": short_title(ctx.by[b["task"]]), "state": b["state"], "status": b["status"], "assignee": b["assignee"], "from": b["from"], "from_title": b["from_title"]} for b in tail],
        "line": {"tasks": len(tasks), "closed": row["closed_count"], "decisions": sum(1 for b in all_beats if b["kind"] == "decide"),
                 "commits": len(commits), "agents": agents},
        "days": by_day(top, now),
        "tail": tail,
    }


def threads_list(ctx, proj="", everywhere=False, with_singles=False):
    """Every line whose root belongs to `proj` (or to any project), newest move first."""
    want = (proj or "").lower()
    rows = []
    for tid, t in ctx.by.items():
        if tid in ctx.parent:
            continue
        if not everywhere and project_of(t).lower() != want:
            continue
        rows.append(summary_row(tid, ctx))
    rows.sort(key=lambda r: -r["last_at"])
    # A task that never split off anything folds into one count, unless it is running or waits for
    # you right now: that is a line you are in the middle of.
    lines = [r for r in rows if not r["single"] or r["state"] in ("run", "wait")]
    singles = [r for r in rows if r["single"] and r["state"] not in ("run", "wait")]
    now = time.time()
    out = {"project": "" if everywhere else proj, "everywhere": everywhere, "threads": lines,
           "counts": {"moving": sum(1 for r in lines if r["state"] != "done"), "done": sum(1 for r in lines if r["state"] == "done"),
                      "today": sum(1 for r in lines if r["last_at"] and time.strftime("%Y-%m-%d", time.localtime(r["last_at"])) == time.strftime("%Y-%m-%d", time.localtime(now))),
                      "singles": len(singles), "recent_days": RECENT_DAYS}}
    if with_singles:
        out["singles"] = singles
    return out


# ---------------------------------------------------------------- a whole project

def is_decision(text):
    s = squash(text)
    return s.startswith(DECIDE_TAGS) or s.startswith(HUMAN_DECIDES)


def line_gist(tasks):
    """One grey sentence for a folded chapter: its latest close, else its latest note."""
    closed = [t for t in tasks if t.get("status") == "closed"]
    if closed:
        t = max(closed, key=lambda x: L.iso_epoch(x.get("closed_at") or x.get("updated_at")))
        text = first_sentence(strip_hashes(t.get("close_reason") or ""), 160)
        if text:
            return {"kind": "done", "text": text, "task": t["id"], "at": L.iso_epoch(t.get("closed_at") or t.get("updated_at"))}
    notes = []
    for t in tasks:
        for c in t.get("comments") or []:
            text = squash(c.get("text"))
            if text and not text.startswith(("【系统】", "[system]", "提交：", "提交:", "Commits:", "【讨论】发起", "[discussion] started")):
                notes.append((L.iso_epoch(c.get("created_at")), text, t["id"]))
    if notes:
        ts, text, tid = max(notes)
        body = re.sub(r"^【[^】]{1,6}】\s*", "", text)
        return {"kind": "note", "text": first_sentence(body, 160), "task": tid, "at": ts}
    return None


def chapter_row(root, ctx):
    """A line as a chapter of its project: the list row plus when it began and its last word."""
    ids = subtree(root, ctx.children)
    tasks = [ctx.by[x] for x in ids]
    row = summary_row(root, ctx)
    row["first_at"] = L.iso_epoch(ctx.by[root].get("created_at"))
    row["gist"] = line_gist(tasks)
    return row


def project_roots(ctx, proj):
    """The chapters of a project, in a view of the board narrowed to it (`project_view`)."""
    return [tid for tid in ctx.by if tid not in ctx.parent and project_key(ctx.home(tid)) == project_key(proj)]


def project_view(ctx, proj):
    """Every task that counts under `proj` (its own label, as 项目回顾 counts it), as one forest: a
    task sitting in another project's line starts its own chapter here and is left out there."""
    return ctx.within(project_members(ctx, proj))


def project_report(proj, ctx, now=None, focus=""):
    """The 脉络 of a whole project: every line is a chapter, oldest move first, the newest at the
    bottom next to 现在. Only the most recent chapters (and anything running or waiting) are shown;
    the rest sit behind 更早, and only the few active chapters carry their records, the others are
    read line by line when opened (`dispatch thread <root>`)."""
    now = now or time.time()
    ctx = project_view(ctx, proj)
    roots = project_roots(ctx, proj)
    name = NO_PROJECT if not project_key(proj) else next((ctx.home(r) for r in roots), proj)
    # A task outside this project has no chapter here: no focus rather than one that is not listed.
    focus_root = root_of(focus, ctx.parent) if focus and focus in ctx.by else ""
    chapters = [chapter_row(r, ctx) for r in roots]
    chapters.sort(key=lambda r: (r["last_at"], r["root"]))
    newest = sorted(chapters, key=lambda r: -r["last_at"])
    shown = {r["root"] for r in newest[:SHOW_CHAPTERS]} | {r["root"] for r in chapters if r["state"] in ("run", "wait")}
    # Opened with their records: what is running, then lines with more than one task that are still
    # moving; a lone task that only waits says all it has in its row.
    rank = [r for r in newest if r["state"] == "run"] + [r for r in newest if r["state"] != "run" and r["state"] != "done" and not r["single"]]
    expand = list(dict.fromkeys(r["root"] for r in rank))[:EXPAND_CHAPTERS] or [r["root"] for r in newest[:1]]
    if focus_root:
        shown.add(focus_root)
        if focus_root not in expand:
            expand.append(focus_root)
    for r in chapters:
        r["shown"] = r["root"] in shown
        r["expanded"] = r["root"] in expand
        if r["expanded"]:
            r["days"] = thread_report(r["root"], ctx, now)["days"]

    tasks = [ctx.by[x] for r in roots for x in subtree(r, ctx.children)]
    open_tasks = [t for t in tasks if is_open(t)]
    tail = [open_beat(t, ctx, ctx.parent.get(t["id"], "")) for t in open_tasks]
    for b in tail:
        rt = root_of(b["task"], ctx.parent)
        b["root"] = rt
        b["root_title"] = short_title(ctx.by[rt]) if rt != b["task"] else ""
    tail.sort(key=lambda b: ({"run": 0, "wait": 1}.get(b["state"], 2), -b["ts"]))

    closed = sorted((t for t in tasks if t.get("status") == "closed"), key=lambda t: -L.iso_epoch(t.get("closed_at") or t.get("updated_at")))
    closes = []
    for t in closed:
        text = first_sentence(strip_hashes(t.get("close_reason") or ""), 200)
        if text:
            rt = root_of(t["id"], ctx.parent)
            closes.append({"task": t["id"], "title": short_title(t), "root": rt, "text": text, "at": L.iso_epoch(t.get("closed_at") or t.get("updated_at"))})
        if len(closes) >= 3:
            break
    latest = None
    if not closes:
        gists = [r["gist"] for r in chapters if r.get("gist")]
        latest = max(gists, key=lambda g: g["at"]) if gists else None

    commits, agents, sessions, decisions = set(), [], set(), 0
    for t in tasks:
        commits.update(task_commits(t, ctx))
        sessions |= sessions_of(t)
        for c in t.get("comments") or []:
            if is_decision(c.get("text")):
                decisions += 1
        for who in [t.get("assignee") or ""] + [c.get("author") or "" for c in t.get("comments") or []]:
            if who and who.lower() in D.AGENT_ACTORS and who not in agents:
                agents.append(who)
    last_at = max((r["last_at"] for r in chapters), default=0)
    lines_moving = sum(1 for r in chapters if r["state"] != "done")
    states = [b["state"] for b in tail]
    return {
        "kind": "project", "project": name, "focus": focus, "focus_root": focus_root,
        "state": "run" if "run" in states else "wait" if "wait" in states else "open" if states else "done",
        "last_at": last_at, "task_count": len(tasks), "closed_count": sum(1 for t in tasks if t.get("status") == "closed"), "open_count": len(open_tasks),
        "session_count": len(sessions),
        "now": {"closes": closes, "latest": latest, "last_at": last_at,
                "lines": {"total": len(chapters), "moving": lines_moving, "closed": len(chapters) - lines_moving}},
        "left": [{"id": b["task"], "title": b["title"], "short": short_title(ctx.by[b["task"]]), "state": b["state"], "status": b["status"],
                  "assignee": b["assignee"], "from": b["from"], "from_title": b["from_title"], "root": b["root"], "root_title": b["root_title"]} for b in tail],
        "stats": {"lines": len(chapters), "tasks": len(tasks), "closed": sum(1 for t in tasks if t.get("status") == "closed"), "decisions": decisions,
                  "commits": len(commits), "agents": agents},
        "chapters": chapters,
        "hidden": sum(1 for r in chapters if not r["shown"]),
        "tail": tail,
    }


def projects_list(ctx, now=None):
    """Every project that has lines on the board, one row each, newest move first."""
    now = now or time.time()
    by, members = {}, {}
    for tid in ctx.by:
        p = ctx.home(tid) or NO_PROJECT
        members.setdefault(p.lower(), (p, []))[1].append(tid)
    for key, (p, ids) in members.items():
        view = ctx.within(ids)
        e = by.setdefault(key, {"name": p, "lines": 0, "moving": 0, "tasks": 0, "closed": 0, "open": 0, "run": 0, "wait": 0, "last_at": 0.0})
        for tid in view.by:
            if tid in view.parent:
                continue
            tasks = [view.by[x] for x in subtree(tid, view.children)]
            e["lines"] += 1
            e["tasks"] += len(tasks)
            for x in tasks:
                if x.get("status") == "closed":
                    e["closed"] += 1
                    continue
                if not is_open(x):
                    continue
                e["open"] += 1
                s = open_state(x, ctx)
                if s in ("run", "wait"):
                    e[s] += 1
            if any(is_open(x) for x in tasks):
                e["moving"] += 1
            e["last_at"] = max(e["last_at"], last_move(tasks))
    rows = sorted(by.values(), key=lambda e: -e["last_at"])
    for e in rows:
        e["state"] = "run" if e["run"] else "wait" if e["wait"] else "open" if e["open"] else "done"
    today = time.strftime("%Y-%m-%d", time.localtime(now))
    return {"projects": rows, "counts": {"moving": sum(1 for e in rows if e["state"] != "done"),
                                         "today": sum(1 for e in rows if e["last_at"] and time.strftime("%Y-%m-%d", time.localtime(e["last_at"])) == today),
                                         "recent_days": RECENT_DAYS}}


# ---------------------------------------------------------------- a project's timeline: what was done, newest first

TL_DAYS = 7              # the page opens on the last 7 calendar days
TL_PAGE = 14             # 更早 and 全部 read 14 days at a time
ABSORB = 24 * 3600       # a close takes in its task's steps and commits of the 24 hours before it
TOGETHER = 600           # closes (and a conclusion's closes) within 10 minutes belong together
VERIFY_RUN = 1800        # one checker's runs on the same day, less than half an hour apart, fold
VERIFY_SPAN = 3600       # ...and one folded row covers at most an hour
VERIFY_MAX = 8           # ...and at most 8 runs
TL_KINDS = ("done", "void", "decide", "verify", "commit", "reply", "did")
ONLY_DONE = ("done", "void", "decide", "verify")
AUTO_MERGE = re.compile(r"^Merge (branch|remote-tracking|pull request)\b")
VOID_RE = re.compile(r"^(作废|取消|不做了|随.{0,40}?(取消|作废))")
UNFINISHED_RE = re.compile(r"(被(用户)?中断|任务未完成|没有?完成|未能完成|无法完成|未被实际执行|没有被?实际执行|权限被拒|执行失败|未见记录|未显示 ?Agent)")
PROBE_ENTRY = ("sdk-cli", "exec")   # headless `claude -p` / `codex exec` runs: probes unless they worked on a task
NEEDS_YOU_RE = re.compile(r"^(用户(还)?需要|需要用户|需要你|要你)")
TESTS_RE = re.compile(r"(?:(?:pytest|vitest|npm test|cargo test|单测|测试|用例)\s*\d+\s*(?:个|项|条)?\s*(?:全过|通过|过|passed)?"
                      r"|\d+\s*(?:个|项|条)?\s*(?:单测|测试|用例|tests?)\s*(?:全过|通过|全绿|过|passed)?)")


def day_of(ts):
    return time.strftime("%Y-%m-%d", time.localtime(ts))


def day_start(ts):
    lt = time.localtime(ts)
    return time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))


def close_words(reason):
    """A close reason as the timeline says it: no 「workflow 收尾（…）：」 lead, no commit list."""
    r = squash(reason)
    r = re.sub(r"^(?:workflow|工作流)\s*收尾\s*[（(][^）)]*[）)]\s*[：:]\s*", "", r)
    r = re.sub(r"^(?:收尾|完成|已完成)[：:]\s*", "", r)
    return strip_hashes(r)


def tests_of(text):
    m = TESTS_RE.search(text or "")
    return squash(m.group(0)) if m else ""


def split_sentences(text):
    return [x.strip() for x in re.split(r"(?<=[。！？!?；;])\s*", squash(text)) if x.strip()]


def reply_words(summary):
    """A session's delivered summary: what the Agent did (its 「Agent …」 sentence, the user's
    request retold is dropped) and what it left to you (「用户需要…」)."""
    sents = split_sentences(summary)
    needs = next((x for x in sents if NEEDS_YOU_RE.match(x)), "")
    body = [x for x in sents if x != needs and not re.match(r"^(会话「[^」]*」[：:]\s*)?用户(想要|想|要求|希望|提出|让)", x)]
    said = next((x for x in body if x.startswith(("Agent", "agent"))), body[0] if body else "")
    said = re.sub(r"^(Agent|agent)\s*(?!的|\s)", "", said)
    needs = re.sub(r"^(用户(还)?需要|需要用户|需要你|要你)\s*", "", needs)
    return said.rstrip("。"), needs.rstrip("。")


def raw_events(ctx, proj, since, before):
    """Every record of the project in [since, before) that says what was done, oldest first,
    before any folding: closes, conclusions, checker runs, progress notes, commits, session replies."""
    tasks = [ctx.by[x] for x in ctx.by]
    tids = set(ctx.by)
    out = []
    for t in tasks:
        tid = t["id"]
        touched = max(L.iso_epoch(t.get("updated_at")), L.iso_epoch(t.get("closed_at")))
        if touched and touched < since and not any(L.iso_epoch(c.get("created_at")) >= since for c in t.get("comments") or []):
            continue
        title = short_title(t)
        root = root_of(tid, ctx.parent)
        for b in task_beats(t, ctx):
            if not (since <= b["ts"] < before):
                continue
            k = b["kind"]
            if k not in ("done", "decide", "verify", "did"):
                continue
            e = {"kind": k, "ts": b["ts"], "who": b.get("who") or "", "text": b.get("text") or "", "full": b.get("full") or "",
                 "task": tid, "task_title": title, "root": root}
            if k == "done":
                reason = t.get("close_reason") or ""
                words = close_words(reason)
                e.update(text=first_sentence(words, 240), full=words[:1500], commits=b.get("commits") or [], verified=b.get("verified"),
                         unchecked="未核验" in reason or "(not verified)" in reason, tests=tests_of(reason))
                if VOID_RE.match(words):
                    e["kind"] = "void"
                    words = re.sub(r"^(作废|取消)[：:，,]\s*", "", words)
                    e.update(text=first_sentence(words, 240), full=words[:1500])
            elif k == "decide":
                e["tag"] = b.get("tag") or "结论"
            elif k == "verify":
                e["verify"] = b["verify"]
            elif k == "did":
                words = re.sub(r"^(?:workflow|工作流)\s*收尾\s*[（(][^）)]*[）)]\s*[：:]\s*", "", squash(b.get("full") or b.get("text") or ""))
                e.update(text=first_sentence(words, 240), full=words[:1500])
                e["commits"] = b.get("commits") or []
                e["numbers"] = numbers_of(b.get("full") or b.get("text"))
            out.append(e)
    for ts, h, subject in ctx.log(proj):
        if not (since <= ts < before):
            continue
        tid = next((x for x in re.findall(r"task-[a-z0-9]{2,}", subject) if x in tids), "")
        out.append({"kind": "commit", "ts": ts, "who": "", "text": subject, "full": subject, "task": tid,
                    "task_title": short_title(ctx.by[tid]) if tid else "", "root": root_of(tid, ctx.parent) if tid else "",
                    "commits": [h], "merge": bool(AUTO_MERGE.match(subject))})
    out += reply_events(ctx, proj, since, before)
    out.sort(key=lambda e: (e["ts"], TL_KINDS.index(e["kind"])))
    return out


def reply_events(ctx, proj, since, before):
    """What sessions in the project's folders delivered: their cached summary, at their last write."""
    try:
        from activity import session_preferences
        prefs = session_preferences(D.DISPATCH_DIR)
    except Exception:
        return []
    names, roots = ctx.names(), ctx.roots()
    tasks = list(ctx.by.values())
    by_session = L.session_task_map(tasks)
    out, want = [], project_key(proj)
    for sid, e in ctx.index().items():
        if not e.get("user_msgs"):
            continue
        # The last message, not the file's mtime (a moved or re-indexed transcript is touched all at once).
        ts = L.iso_epoch(e.get("last_ts")) or e.get("mtime") or 0
        if not (since <= ts < before):
            continue
        summary = (prefs.get(f"{e.get('agent')}:{sid}") or {}).get("summary") or ""
        if not summary.strip():
            continue
        if (D.project_of_cwd(e.get("cwd") or "", names, roots) or "").lower() != want:
            continue
        said, needs = reply_words(summary)
        if not said:
            continue
        tid = next((x for x in reversed(e.get("claims") or []) if x in ctx.by), "") or by_session.get(sid, "")
        tid = tid if tid in ctx.by else ""
        if not reply_counts(e, tid, summary):
            continue
        out.append({"kind": "reply", "ts": ts, "who": e.get("agent") or "", "text": first_sentence(said, 240), "full": squash(summary)[:1500],
                    "task": tid, "task_title": short_title(ctx.by[tid]) if tid else "", "root": root_of(tid, ctx.parent) if tid else "",
                    "session_id": sid, "session_title": squash(e.get("title") or "")[:120], "needs_you": needs[:300]})
    return out


def reply_counts(e, tid, summary):
    """Whether a session's reply is something that was done: not a throwaway probe (a headless
    run, or an untitled one-question session, that worked on no task) and not work that was
    interrupted or never finished."""
    if UNFINISHED_RE.search(squash(summary)):
        return False
    if tid:
        return True
    if (e.get("entrypoint") or "") in PROBE_ENTRY:
        return False
    title = squash(e.get("title") or "")
    return bool(title) and (e.get("user_msgs") or 0) >= 2


def _sessions_of_task(ctx, tid):
    t = ctx.by.get(tid) or {}
    return sessions_of(t)


def fold_events(events, ctx=None):
    """The folding rules, on raw events oldest first. Returns rows oldest first and what was folded."""
    folded = {"steps": 0, "commits": 0}
    evs = [dict(e) for e in events]
    seen = {}
    for e in evs:
        base = e.get("id") or f"{e['kind']}:{e.get('task', '')}:{e['ts']}:{(e.get('commits') or [''])[0]}"
        # Two notes of one task in the same second: every row still needs its own id.
        seen[base] = seen.get(base, 0) + 1
        e["id"] = base if seen[base] == 1 else f"{base}#{seen[base]}"
    gone = set()

    # 3. A close takes in its task's steps and commits of the 24 hours before it; the commits it
    #    names never stand alone.
    #    (Indexed: the page folds the whole history, so this must not be closes x events.)
    order = {e["id"]: i for i, e in enumerate(evs)}
    by_hash, by_task_steps = {}, {}
    for x in evs:
        if x["kind"] == "commit":
            by_hash.setdefault(x["commits"][0][:7], []).append(x)
        if x["kind"] in ("commit", "did") and x.get("task"):
            by_task_steps.setdefault(x["task"], []).append(x)
    for e in evs:
        if e["kind"] not in ("done", "void"):
            continue
        named = {h[:7] for h in e.get("commits") or []}
        cand = {x["id"]: x for h in named for x in by_hash.get(h, [])}
        for x in by_task_steps.get(e["task"], []):
            if e["ts"] - ABSORB <= x["ts"] <= e["ts"]:
                cand[x["id"]] = x
        took = sorted((x for x in cand.values() if x["id"] not in gone and x is not e), key=lambda x: order[x["id"]])
        if took:
            for x in took:
                gone.add(x["id"])
            steps = sum(1 for x in took if x["kind"] == "did")
            commits = sum(1 for x in took if x["kind"] == "commit")
            folded["steps"] += steps
            folded["commits"] += commits
            e["before"] = {"steps": steps, "commits": commits, "events": [row_of(x) for x in took]}
    evs = [e for e in evs if e["id"] not in gone]

    # 6. A conclusion takes in the tasks of its line closed within 10 minutes after it.
    for e in evs:
        if e["kind"] != "decide":
            continue
        took = [x for x in evs if x["kind"] in ("done", "void") and x["id"] not in gone and x.get("root") == e.get("root")
                and e["ts"] <= x["ts"] <= e["ts"] + TOGETHER]
        if took:
            for x in took:
                gone.add(x["id"])
            e["closes"] = [{"task": x["task"], "title": x["task_title"], "text": x["text"], "ts": x["ts"]} for x in took]
    evs = [e for e in evs if e["id"] not in gone]

    # 7. A session's reply that only repeats a close it made within 10 minutes says nothing new.
    closes = [x for x in evs if x["kind"] in ("done", "void")]
    for e in evs:
        if e["kind"] != "reply":
            continue
        mine = e.get("session_id")
        for x in closes:
            if abs(x["ts"] - e["ts"]) > TOGETHER:
                continue
            same_session = x["task"] == e.get("task") or (ctx is not None and mine in _sessions_of_task(ctx, x["task"]))
            a, b = squash(e["text"]).rstrip("。"), squash(x["text"]).rstrip("。")
            if same_session and a and b and (a == b or a in b or b in a):
                gone.add(e["id"])
                break
    evs = [e for e in evs if e["id"] not in gone]

    # 4. Tasks closed together: the same session within 10 minutes, or one merge commit for all.
    out, group = [], None
    for e in evs:
        if e["kind"] not in ("done", "void"):
            continue
        hashes = {h[:7] for h in e.get("commits") or []}
        sess = _sessions_of_task(ctx, e["task"]) if ctx is not None else set()
        if group and ((e["ts"] - group["last"] <= TOGETHER and (sess & group["sessions"])) or (hashes & group["hashes"])):
            group["members"].append(e)
            group["last"] = e["ts"]
            group["sessions"] |= sess
            group["hashes"] |= hashes
            continue
        group = {"members": [e], "last": e["ts"], "sessions": set(sess), "hashes": set(hashes)}
        out.append(group)
    for g in out:
        ms = g["members"]
        if len(ms) < 2:
            continue
        head = ms[-1]
        for x in ms[:-1]:
            gone.add(x["id"])
        head["group"] = True
        head["closes"] = [{"task": x["task"], "title": x["task_title"], "text": x["text"], "ts": x["ts"], "verified": x.get("verified"),
                           "commits": x.get("commits") or [], "kind": x["kind"]} for x in reversed(ms)]
        head["from_ts"] = ms[0]["ts"]
        allc = []
        for x in ms:
            for h in x.get("commits") or []:
                if h not in allc:
                    allc.append(h)
        head["commits"] = allc
        vs = [x.get("verified") for x in ms]
        head["verified"] = False if False in vs else True if all(v is True for v in vs) else None
        head["unchecked"] = any(x.get("unchecked") for x in ms)
        before = [b for x in ms for b in ((x.get("before") or {}).get("events") or [])]
        if before:
            head["before"] = {"steps": sum(1 for b in before if b["kind"] == "did"), "commits": sum(1 for b in before if b["kind"] == "commit"), "events": before}
        head["kind"] = "done" if any(x["kind"] == "done" for x in ms) else "void"
    evs = [e for e in evs if e["id"] not in gone]

    # 5. One checker's runs the same day, less than half an hour apart, fold into one row.
    runs, run = [], []
    for e in evs:
        if e["kind"] != "verify":
            continue
        if run and (day_of(e["ts"]) != day_of(run[-1]["ts"]) or e["who"] != run[-1]["who"] or e["ts"] - run[-1]["ts"] > VERIFY_RUN
                    or e["ts"] - run[0]["ts"] > VERIFY_SPAN or len(run) >= VERIFY_MAX):
            runs.append(run)
            run = []
        run.append(e)
    if run:
        runs.append(run)
    for run in runs:
        if len(run) < 2:
            continue
        head = run[-1]
        for x in run[:-1]:
            gone.add(x["id"])
        v = {"ok": 0, "ask": 0, "fail": 0, "model": head["verify"].get("model", ""), "secs": 0, "error": "", "items": []}
        for x in run:
            xv = x["verify"]
            for k in ("ok", "ask", "fail", "secs"):
                v[k] += xv.get(k) or 0
            for it in xv.get("items") or []:
                v["items"].append({"n": it["n"], "state": it["state"], "text": it["text"][:140], "task": x["task"], "title": x["task_title"], "ts": x["ts"]})
        # Opening the row lists every item with its task; the runs themselves keep only their counts.
        runs_rows = []
        for x in reversed(run):
            r = row_of(x)
            r["verify"] = {k: x["verify"].get(k) for k in ("ok", "ask", "fail", "model", "secs", "error")}
            r.pop("full", None)
            runs_rows.append(r)
        head["fold"] = {"count": len(run), "from_ts": run[0]["ts"], "to_ts": run[-1]["ts"], "summary": [], "events": runs_rows}
        head["verify"] = v
        head["text"] = verify_words(v)
        head["tasks"] = len({x["task"] for x in run})
    evs = [e for e in evs if e["id"] not in gone]

    # 1 and 2. Three or more steps of one task in a row (the same day, nothing else of that task
    #    between) fold into one row; so do two or more commits. Commits that name no task are
    #    only 「in a row」 when nothing at all sits between them.
    pos = {e["id"]: i for i, e in enumerate(evs)}
    by_task = {}
    for e in evs:
        by_task.setdefault((e.get("task") or "", day_of(e["ts"])), []).append(e)
    for (tid, _), seq in by_task.items():
        run = []

        def flush(run=run):
            kind = run[0]["kind"] if run else ""
            need = FOLD_MIN if kind == "did" else 2
            if len(run) >= need:
                head = run[-1]
                for x in run[:-1]:
                    gone.add(x["id"])
                if kind == "did":
                    folded["steps"] += len(run)
                    head["fold"] = {"count": len(run), "from_ts": run[0]["ts"], "to_ts": run[-1]["ts"],
                                    "summary": [x.get("numbers") or numbers_of(x.get("full") or x["text"]) for x in run], "events": [row_of(x) for x in reversed(run)]}
                else:
                    folded["commits"] += len(run)
                    real = [x for x in run if not x.get("merge")]
                    pick = (real or run)[-1]
                    head["text"] = pick["text"]
                    head["commits"] = [x["commits"][0] for x in reversed(run)]
                    head["merges"] = len(run) - len(real)
                    head["fold"] = {"count": len(run), "from_ts": run[0]["ts"], "to_ts": run[-1]["ts"], "summary": [], "events": [row_of(x) for x in reversed(run)]}
                    head["merge"] = False
            run.clear()

        for e in seq:
            k = e["kind"]
            foldable = k in ("did", "commit") and not e.get("fold")
            if foldable and (not run or (run[-1]["kind"] == k and (tid or pos[e["id"]] == pos[run[-1]["id"]] + 1))):
                run.append(e)
                continue
            flush()
            if foldable:
                run.append(e)
        flush()
    # A lone 「Merge branch …」 is not something anybody did.
    evs = [e for e in evs if e["id"] not in gone and not (e["kind"] == "commit" and e.get("merge") and not e.get("fold"))]
    return [row_of(e, nested=False) for e in evs], folded


ROW_KEYS = ("kind", "ts", "who", "text", "full", "task", "task_title", "root", "session_id", "session_title", "commits", "verified",
            "unchecked", "tests", "merges", "fold", "verify", "closes", "needs_you", "before", "tag", "group", "from_ts", "tasks")


def row_of(e, nested=True):
    """A row as the page gets it. Rows inside a fold carry a shorter full text."""
    r = {k: e[k] for k in ROW_KEYS if k in e and (k == "verified" or e[k] not in (None, "", [], {}))}
    if nested and len(r.get("full") or "") > 400:
        r["full"] = r["full"][:400] + "…"
    r.setdefault("text", "")
    r["id"] = e.get("id") or f"{e['kind']}:{e.get('task', '')}:{e['ts']}"
    return r


def timeline_days(rows, now=None):
    now = now or time.time()
    today, yesterday = day_of(now), day_of(day_start(now) - 43200)
    days = []
    for r in sorted(rows, key=lambda r: -r["ts"]):
        d = day_of(r["ts"])
        if not days or days[-1]["date"] != d:
            days.append({"date": d, "weekday": time.localtime(r["ts"]).tm_wday, "today": d == today, "yesterday": d == yesterday, "count": 0, "events": []})
        days[-1]["events"].append(r)
        days[-1]["count"] += 1
    return days


def timeline_gaps(days):
    out = []
    for a, b in zip(days, days[1:]):
        newer = min(e["ts"] for e in a["events"])
        older = max(e["ts"] for e in b["events"])
        if newer - older > GAP_DAYS * 86400:
            out.append({"after": older, "before": newer, "days": int((newer - older) // 86400)})
    return out


def acceptance_items(t):
    """The task's acceptance checklist lines, in order (the checker numbers them 1, 2, …)."""
    return [first_sentence(re.sub(r"(\s+#[\w:.-]+)+$", "", x), 160) for x in re.findall(r"^\s*[-*]\s*\[[ xX]\]\s*(.+?)\s*$", t.get("acceptance_criteria") or "", re.M)]


def open_block(ctx, proj, now=None, sessions=None):
    """What is not done: 等你 (checker items only you can confirm, sessions waiting on you, tasks
    marked needs-you), 在做 (someone has it), 没人认领 (open, nobody has it, P1 first)."""
    now = now or time.time()
    live = ctx.live()
    wait, doing, unassigned, asks = [], [], [], []
    for tid, t in ctx.by.items():
        if not is_open(t):
            continue
        acc_done, acc_total = L.acceptance_progress(t)
        notes = comments_of(t)
        last_at = max([L.iso_epoch(t.get("updated_at"))] + [L.iso_epoch(c.get("created_at")) for c in notes[-1:]])
        parent = ctx.parent.get(tid, "")
        base = {"id": tid, "title": short_title(t), "status": t.get("status") or "open", "assignee": t.get("assignee") or "",
                "priority": t.get("priority") if isinstance(t.get("priority"), int) else 2, "acceptance_done": acc_done, "acceptance_total": acc_total,
                "last_at": last_at, "created_at": L.iso_epoch(t.get("created_at")),
                "from": parent, "from_title": short_title(ctx.by[parent]) if parent in ctx.by else "", "root": root_of(tid, ctx.parent)}
        checks = [c for c in notes if squash(c.get("text")).startswith(VERIFY_TAG) or (c.get("author") or "").lower() == CHECKER]
        if checks:
            last = checks[-1]
            v = parse_verify(last.get("text") or "")
            crit = acceptance_items(t)
            for it in v["items"]:
                if it["state"] == "ask":
                    # `item`: the acceptance line itself (what to confirm); `text`: the checker's why.
                    item = crit[it["n"] - 1] if 0 < it["n"] <= len(crit) else ""
                    asks.append({"task": tid, "title": base["title"], "n": it["n"], "item": item, "text": it["text"], "full": it["full"],
                                 "ts": L.iso_epoch(last.get("created_at"))})
        state = open_state(t, ctx)
        if state == "wait":
            wait.append(dict(base, state="wait"))
            continue
        if t.get("status") in ("in_progress", "blocked") or base["assignee"]:
            sids = sorted(sessions_of(t))
            run = next((s for s in sids if live.get(s) == "working"), "")
            idle = next((s for s in sids if s in live), "")
            doing.append(dict(base, state=state, session_id=run or idle, session_state="working" if run else live.get(idle, "") if idle else ""))
            continue
        unassigned.append(dict(base, state=state))
    wait.sort(key=lambda r: -r["last_at"])
    doing.sort(key=lambda r: (r["session_state"] != "working", r["status"] != "in_progress", -r["last_at"]))
    unassigned.sort(key=lambda r: (r["priority"] > 1, -r["created_at"]))
    asks.sort(key=lambda r: -r["ts"])
    waiting_sessions = []
    for s in sessions or []:
        if s.get("state") == "working":
            continue
        _, needs = reply_words(s.get("summary") or "")
        if needs:
            waiting_sessions.append({"session_id": s.get("session_id"), "agent": s.get("agent"), "title": s.get("title") or "", "text": needs[:300],
                                     "ts": s.get("last_at") or 0, "pane_id": s.get("pane_id") or ""})
    test_cmd = ""
    try:
        f = (D.project_flags_load() or {}).get(proj) or {}
        if not f.get("test_cmd") and f.get("test_cmd_suggested") and f.get("test_cmd_suggested") != f.get("test_cmd_dismissed"):
            test_cmd = f["test_cmd_suggested"]
    except Exception:
        pass
    return {"asks": asks, "waiting_sessions": waiting_sessions, "wait": wait, "doing": doing, "unassigned": unassigned,
            "sessions": sessions or [], "test_cmd": test_cmd,
            "counts": {"wait": len(asks) + len(waiting_sessions) + len(wait), "doing": len(doing), "unassigned": len(unassigned)}}


def project_stats(ctx, proj):
    roots = project_roots(ctx, proj)
    tasks = [ctx.by[x] for r in roots for x in subtree(r, ctx.children)]
    commits, agents, decisions, moving = set(), [], 0, 0
    for r in roots:
        if any(is_open(ctx.by[x]) for x in subtree(r, ctx.children)):
            moving += 1
    for t in tasks:
        commits.update(task_commits(t, ctx))
        for c in t.get("comments") or []:
            if is_decision(c.get("text")):
                decisions += 1
        for who in [t.get("assignee") or ""] + [c.get("author") or "" for c in t.get("comments") or []]:
            if who and who.lower() in D.AGENT_ACTORS and who not in agents:
                agents.append(who)
    return {"lines": len(roots), "moving": moving, "tasks": len(tasks), "closed": sum(1 for t in tasks if t.get("status") == "closed"),
            "open": sum(1 for t in tasks if is_open(t)), "decisions": decisions, "commits": len(commits), "agents": agents,
            "last_at": max((last_move([ctx.by[x] for x in subtree(r, ctx.children)]) for r in roots), default=0)}


def row_touches(r, tid):
    """Whether a timeline row is about this task (or its line): its own, a close or checker item in it."""
    return (r.get("task") == tid or r.get("root") == tid or any(x.get("task") == tid for x in r.get("closes") or [])
            or any(x.get("task") == tid for x in (r.get("verify") or {}).get("items") or []))


def timeline_report(proj, ctx, days=None, before=None, only="", now=None, sessions=None, with_open=True, task=""):
    """`dispatch thread <project> --timeline`: 现状's numbers, one newest-first timeline of what was
    done (folded), and the open work. `days` counts calendar days back from today (today is day 1),
    0 is the whole history; with `before`, the page is the `days` (default 14) whole days before
    that moment. `task` keeps only that task's rows (and counts only its older ones).

    The whole history is read and folded once, then cut to the page: a row folded into a row of a
    newer page never comes back on its own on an older one, and 之前还有 N 条 counts rows."""
    now = now or time.time()
    view = project_view(ctx, proj)
    roots = project_roots(view, proj)
    name = NO_PROJECT if not project_key(proj) else next((view.home(r) for r in roots), proj)
    whole = days == 0 and not before
    if whole:
        until, since = now + 86400, 0
    elif before:
        until = float(before)
        since = day_start(until - 1) - ((days or TL_PAGE) - 1) * 86400
    else:
        until = now + 86400
        since = day_start(now) - ((days or TL_DAYS) - 1) * 86400
    evs = raw_events(view, proj, 0, now + 86400)
    every, _ = fold_events(evs, view)
    if only == "done":
        every = [r for r in every if r["kind"] in ONLY_DONE]
    if task:
        every = [r for r in every if row_touches(r, task)]
    rows = [r for r in every if since <= r["ts"] < until]
    older = [r for r in every if r["ts"] < since]
    folded = {"steps": 0, "commits": 0}
    for r in rows:
        f, b = r.get("fold") or {}, r.get("before") or {}
        if r["kind"] == "did" and f:
            folded["steps"] += f["count"]
        if r["kind"] == "commit" and f:
            folded["commits"] += f["count"]
        folded["steps"] += b.get("steps", 0)
        folded["commits"] += b.get("commits", 0)
    newest_older = max((r["ts"] for r in older), default=0)
    next_before = None
    if older:
        # Skip a long quiet stretch: the next page starts at the newest older row.
        next_before = since if newest_older >= since - TL_PAGE * 86400 else newest_older + 1
    day_rows = timeline_days(rows, now)
    stats = project_stats(view, proj)
    report = {"kind": "timeline", "project": name, "since": since, "before": before or None,
              "days_back": 0 if whole else days or (TL_PAGE if before else TL_DAYS), "all": whole,
              "only": only or "", "task": task or "", "stats": stats, "last_at": stats["last_at"], "days": day_rows, "gaps": timeline_gaps(day_rows),
              "count": len(rows), "folded": folded, "older": len(older), "next_before": next_before}
    if with_open:
        report["open"] = open_block(view, proj, now, sessions)
    return report


def print_timeline(o):
    s = o["stats"]
    print(_t(f"# {o['project']} · {s['lines']} lines of work ({s['moving']} still moving) · {s['tasks']} tasks · {s['closed']} closed · {s['commits']} commits · {s['decisions']} decisions",
             f"# {o['project']} · {s['lines']} 条线（{s['moving']} 还在动） · {s['tasks']} 任务 · {s['closed']} 收尾 · {s['commits']} 提交 · {s['decisions']} 结论"))
    f = o["folded"]
    print(_t(f"{o['count']} entries · {f['steps']} steps and {f['commits']} commits folded", f"{o['count']} 条 · 折起 {f['steps']} 步、{f['commits']} 个提交"))
    for d in o["days"]:
        tag = _t(" (today)", "（今天）") if d["today"] else _t(" (yesterday)", "（昨天）") if d.get("yesterday") else ""
        print(f"\n{d['date']} {WEEKDAY(d['weekday'])}{tag} · {d['count']}" + _t(" entries", " 条"))
        for e in d["events"]:
            k = e["kind"]
            label = KIND().get(k, k)
            text = e.get("text") or ""
            fold = e.get("fold") or {}
            if k == "did" and fold:
                text = _t(f"{fold['count']} steps, {hm(fold['from_ts'])} to {hm(fold['to_ts'])}: ", f"{fold['count']} 步，{hm(fold['from_ts'])} 到 {hm(fold['to_ts'])}：") + " · ".join(fold["summary"])
            elif k == "commit" and fold:
                text = f"{fold['count']} · {text}"
            elif k == "verify" and fold:
                text = _t(f"checked {fold['count']} times ({e.get('tasks', 0)} tasks), {hm(fold['from_ts'])} to {hm(fold['to_ts'])}: {text}", f"验收 {fold['count']} 次（{e.get('tasks', 0)} 个任务），{hm(fold['from_ts'])} 到 {hm(fold['to_ts'])}：{text}")
            elif k in ("done", "void") and e.get("group"):
                text = _t(f"{len(e['closes'])} closed together: ", f"{len(e['closes'])} 项一起收尾：") + _t(", ", "、").join(x["title"] for x in e["closes"])
            extra = []
            if e.get("task"):
                extra.append(f"{e['task']} {e.get('task_title', '')[:30]}")
            if e.get("session_title"):
                extra.append(_t(f"session \"{e['session_title'][:30]}\"", f"会话「{e['session_title'][:30]}」"))
            if e.get("before"):
                extra.append(_t(f"{e['before']['steps']} steps and {e['before']['commits']} commits before", f"之前 {e['before']['steps']} 步、{e['before']['commits']} 个提交"))
            if e.get("closes") and k == "decide":
                extra.append(_t(f"closed {len(e['closes'])} along the way", f"顺手关掉 {len(e['closes'])} 项"))
            if e.get("needs_you"):
                extra.append(_t(f"for you to do: {e['needs_you'][:60]}", f"要你做的：{e['needs_you'][:60]}"))
            if k in ("done", "void"):
                extra.append({True: _t("verified", "已验证"), False: _t("not verified", "未验证")}.get(e.get("verified"), "") + (_t(" needs a check on the real thing", " 要真机核验") if e.get("unchecked") else ""))
            print(f"  {hm(e['ts'])} {label} {text[:120]}" + ("  [" + " · ".join(x for x in extra if x.strip()) + "]" if any(x.strip() for x in extra) else ""))
    for g in o["gaps"]:
        print(f"  ┆ {time.strftime('%m-%d', time.localtime(g['after']))} " + _t("to", "到") + f" {time.strftime('%m-%d', time.localtime(g['before']))} " + _t("nothing moved", "没动"))
    if o["next_before"]:
        print(_t(f"\nEarlier · {o['older']} more before {time.strftime('%m-%d', time.localtime(o['since']))}: --before {int(o['next_before'])}", f"\n更早 · {time.strftime('%m-%d', time.localtime(o['since']))} 之前还有 {o['older']} 条：--before {int(o['next_before'])}"))
    op = o.get("open")
    if op:
        c = op["counts"]
        print(_t(f"\nNot done yet: waiting for you {c['wait']} · in progress {c['doing']} · nobody on it {c['unassigned']}", f"\n还没做：等你 {c['wait']} · 在做 {c['doing']} · 没人认领 {c['unassigned']}"))
        for a in op["asks"][:6]:
            print(_t(f"  waiting for you · acceptance item {a['n']} · {a['task']} {a['title'][:30]}: {a['text'][:60]}", f"  等你 · 验收第 {a['n']} 项 · {a['task']} {a['title'][:30]}：{a['text'][:60]}"))
        for x in op["waiting_sessions"]:
            print(_t(f"  waiting for you · session \"{x['title'][:30]}\": {x['text'][:60]}", f"  等你 · 会话「{x['title'][:30]}」：{x['text'][:60]}"))
        for x in op["wait"][:6]:
            print(_t("  waiting for you · ", "  等你 · ") + f"{x['id']} {x['title'][:40]}")
        for x in op["doing"][:5]:
            acc = f" {x['acceptance_done']}/{x['acceptance_total']}" if x["acceptance_total"] else ""
            print(_t("  in progress · ", "  在做 · ") + f"{x['id']} {x['title'][:40]}{acc} · {x['assignee'] or '?'}" + (_t(" · working", " · 在跑") if x["session_state"] == "working" else ""))
        for x in op["unassigned"][:4]:
            print(_t("  nobody on it · ", "  没人认领 · ") + f"{x['id']} {x['title'][:40]}" + (" · P1" if x["priority"] <= 1 else ""))


# ---------------------------------------------------------------- commands

KIND_ZH = {"ask": "你说", "discuss": "讨论", "decide": "结论", "claim": "接手", "did": "做了", "done": "收尾", "fork": "分出",
           "open": "开着", "created": "开了", "gap": "", "verify": "验收", "void": "作废", "commit": "提交", "reply": "回复"}
STATE_ZH = {"run": "在跑", "wait": "等你", "open": "开着", "done": "收尾"}
KIND_EN = {"ask": "you said", "discuss": "discussion", "decide": "decision", "claim": "taken", "did": "did", "done": "closed", "fork": "split off",
           "open": "open", "created": "opened", "gap": "", "verify": "checked", "void": "dropped", "commit": "commit", "reply": "reply"}
STATE_EN = {"run": "working", "wait": "waiting for you", "open": "open", "done": "closed"}


def KIND():
    return _t(KIND_EN, KIND_ZH)


def STATE():
    return _t(STATE_EN, STATE_ZH)


def WEEKDAY(n):
    return _t(("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[n], "周" + "一二三四五六日"[n])


def hm(ts):
    return time.strftime("%H:%M", time.localtime(ts)) if ts else "     "


def print_beats(beats, indent="  "):
    for b in beats:
        k = b["kind"]
        if k == "gap":
            print(f"{indent}┆ " + _t(f"{b['days']} days with nothing moving", f"{b['days']} 天没动"))
            continue
        label = KIND().get(k, k)
        if k == "decide" and b.get("tag") not in ("结论", "决定"):
            label = b.get("tag") or label
        if k == "open":
            label = STATE().get(b["state"], label)
        who = f"[{b['who']}] " if b.get("who") and k not in ("ask",) else ""
        if k == "discuss":
            print(f"{indent}{hm(b['ts'])} {label} " + _t(f"{len(b['members'])} people: ", f"{len(b['members'])} 人：") + _t("; ", "；").join(f"{m['who']}" + _t(": ", "：") + f"{m['text'][:40]}" for m in b["members"]))
        elif k == "did" and b.get("fold"):
            print(f"{indent}{hm(b['ts'])} {label} " + _t(f"{b['count']} steps ({hm(b['from_ts'])} to {hm(b['to_ts'])}): ", f"{b['count']} 步（{hm(b['from_ts'])} 到 {hm(b['to_ts'])}）：") + " · ".join(b["summary"]))
        elif k == "fork":
            end = _t("closed ", "收尾 ") + time.strftime('%m-%d %H:%M', time.localtime(b['closed_at'])) if b["closed_at"] else STATE().get(b["state"], "")
            more = _t(f" · {b['open_after']} more split off, open", f" · 又分出 {b['open_after']} 项开着") if b["open_after"] else ""
            print(f"{indent}{hm(b['ts'])} {label} {b['title']}" + _t(f" ({b['task']})", f"（{b['task']}）") + f" · {end}{more}")
            print_beats(b["beats"], indent + "      ")
        elif k == "open":
            print(f"{indent}{hm(b['ts'])} {label} {b['title']}" + _t(f" ({b['task']})", f"（{b['task']}）") + ("" if b["assignee"] else _t(" · nobody on it", " · 没人认领")))
        else:
            extra = ""
            if k == "done":
                extra = (_t(f" · {len(b['commits'])} commits", f" · {len(b['commits'])} 个提交") if b["commits"] else "") + {True: _t(" · verified", " · 已验证"), False: _t(" · not verified", " · 未验证")}.get(b["verified"], "")
            print(f"{indent}{hm(b['ts'])} {label} {who}{b['text']}{extra}")


def cmd_thread(a):
    target = (getattr(a, "target", "") or "").strip()
    cwd = os.path.abspath(os.path.expanduser(getattr(a, "dir", "") or os.getcwd()))
    ctx = Ctx(board_issues(), cwd=cwd)
    if target and target in ctx.by:
        inside = (getattr(a, "inside", "") or "").strip()
        # `--in <project>`: the line as a chapter of that project, the way its 脉络 lists it.
        report = thread_report(target, project_view(ctx, inside) if inside and target in project_members(ctx, inside) else ctx)

        def text(o):
            print(f"# {o['title']}" + _t(f" ({o['root']} · {o['project']})", f"（{o['root']} · {o['project']}）"))
            print(_t(f"{o['task_count']} tasks · {o['session_count']} sessions · ", f"{o['task_count']} 个任务 · {o['session_count']} 条会话 · ") + STATE().get(o['state'], o['state']) + (_t(f" · {o['open_count']} left", f" · 剩 {o['open_count']}") if o["open_count"] else ""))
            if o["ask"]:
                print(_t(f"\nYour words ({time.strftime('%m-%d %H:%M', time.localtime(o['ask']['at']))}): {o['ask']['text']}", f"\n你的原话（{time.strftime('%m-%d %H:%M', time.localtime(o['ask']['at']))}）：{o['ask']['text']}"))
            n = o["now"]
            if n["main"]:
                print(_t(f"\nWhere it got to: the main line closed {time.strftime('%m-%d %H:%M', time.localtime(n['main']['closed_at']))}: {n['main']['text']}", f"\n走到哪：主线 {time.strftime('%m-%d %H:%M', time.localtime(n['main']['closed_at']))} 收尾：{n['main']['text']}"))
            elif n["latest"]:
                print(_t("\nWhere it got to: ", "\n走到哪：") + f"{time.strftime('%m-%d %H:%M', time.localtime(n['latest']['at']))} {n['latest']['text']}")
            if n["branches"]["total"]:
                print(_t(f"  {n['branches']['total']} side lines split off, {n['branches']['closed']} closed", f"  分出 {n['branches']['total']} 条支线，{n['branches']['closed']} 条已收尾"))
            print(_t("Left: ", "剩下：") + (_t(", ", "、").join(f"{x['title']}" + _t(f" ({x['id']}, {STATE().get(x['state'])}{'' if x['assignee'] else ', nobody on it'})", f"（{x['id']}，{STATE_ZH.get(x['state'])}{'' if x['assignee'] else '，没人认领'}）") for x in o["left"]) or _t("nothing", "没有")))
            ln = o["line"]
            print(_t(f"This line: {ln['tasks']} tasks · {ln['closed']} closed · {ln['decisions']} decisions · {ln['commits']} commits · {', '.join(ln['agents']) or 'no agent'}", f"这条线：{ln['tasks']} 任务 · {ln['closed']} 收尾 · {ln['decisions']} 结论 · {ln['commits']} 提交 · {'、'.join(ln['agents']) or '无 Agent'}"))
            for d in o["days"]:
                print(f"\n{d['date']} {WEEKDAY(d['weekday'])}" + (_t(" (today)", "（今天）") if d["today"] else ""))
                print_beats(d["beats"])
            if o["tail"]:
                print(_t(f"\nNow · nothing moved since {time.strftime('%m-%d %H:%M', time.localtime(o['last_at']))}", f"\n现在 · {time.strftime('%m-%d %H:%M', time.localtime(o['last_at']))} 起没动") if o["last_at"] < time.time() - 3600 else _t("\nNow", "\n现在"))
                print_beats(o["tail"])

        return D.out(report, a.json, text)
    if getattr(a, "projects", False):
        def text_projects(o):
            print(_t(f"# Stories · {len(o['projects'])} projects · {o['counts']['moving']} still moving", f"# 脉络 · {len(o['projects'])} 个项目 · {o['counts']['moving']} 个还在动"))
            for e in o["projects"]:
                tag = _t({"run": f"working {e['run']}", "wait": f"waiting for you {e['wait']}", "done": "closed"}, {"run": f"在跑 {e['run']}", "wait": f"等你 {e['wait']}", "done": "收尾"}).get(e["state"], _t(f"{e['open']} left", f"剩 {e['open']}"))
                print(f"{'◐' if e['state'] != 'done' else '●'} {e['name']} · {tag} · " + _t(f"{e['lines']} lines · {e['tasks']} tasks", f"{e['lines']} 条线 · {e['tasks']} 任务") + f" · {D.ago(e['last_at'])}")

        return D.out(projects_list(ctx), a.json, text_projects)
    # A missing task id is an error; anything else is a project name, even one shaped like an id
    # (beads-ui, vault-agent) whose folder only has sessions: its 脉络 is simply empty.
    m = re.match(r"^([a-z]+)-[a-z0-9]{2,8}$", target or "")
    if m and not getattr(a, "all_projects", False) and target.lower() not in ctx.names() and any(x.startswith(m.group(1) + "-") for x in ctx.by):
        print(_t(f"The board has no {target}", f"任务板上没有 {target}"), file=sys.stderr)
        sys.exit(1)
    everywhere = bool(getattr(a, "all_projects", False))
    proj = target
    if not proj and not everywhere:
        proj = D.project_of_cwd(cwd, ctx.names(), D.settings_load().get("workspace_roots") or []) or L.folder_name(cwd)
    if not everywhere and getattr(a, "timeline", False):
        with_open = not getattr(a, "no_open", False)
        return D.out(timeline_report(proj, ctx, days=getattr(a, "days", None), before=getattr(a, "before", None), only=getattr(a, "only", "") or "",
                                     sessions=None if getattr(a, "no_sessions", False) or not with_open else live_here(ctx, proj, cwd),
                                     with_open=with_open, task=(getattr(a, "task", "") or "").strip()), a.json, print_timeline)
    if not everywhere and not getattr(a, "lines", False) and not getattr(a, "all", False):
        return D.out(project_report(proj, ctx, focus=(getattr(a, "task", "") or "").strip()), a.json, print_project)
    report = threads_list(ctx, proj, everywhere, with_singles=getattr(a, "all", False))

    def text(o):
        c = o["counts"]
        print(_t(f"# {o['project'] or 'All projects'} · {c['moving']} lines still moving · {c['done']} closed · {c['singles']} that never split", f"# {o['project'] or '全部项目'} · {c['moving']} 条线还在动 · {c['done']} 条已收尾 · {c['singles']} 个没分出过任务的"))
        for r in o["threads"]:
            tag = STATE().get(r["state"], r["state"]) if r["state"] in ("run", "wait", "done") else _t(f"{r['open_count']} left", f"剩 {r['open_count']}")
            where = f"{r['project']} · " if o["everywhere"] else ""
            print(f"{'◐' if r['state'] != 'done' else '●'} {where}{r['short']}" + _t(f" ({r['root']})", f"（{r['root']}）") + f" · {tag} · {r['task_count']}" + _t(" tasks", " 任务") + f" · {D.ago(r['last_at'])}")
        for r in o.get("singles") or []:
            print(f"  · {r['short']}" + _t(f" ({r['root']})", f"（{r['root']}）") + f" · {STATE().get(r['state'], r['state'])}")

    D.out(report, a.json, text)


def live_here(ctx, proj, cwd):
    """The project's live conversations with their close-or-not verdict, as `dispatch here` has them."""
    try:
        names, roots = ctx.names(), ctx.roots()
        base = L.project_base(proj, cwd, names, roots)
        issues = [t for t in ctx.by.values() if project_of(t).lower() == project_key(proj)]
        return L.here_sessions(proj, True, base or cwd, issues, names, roots, live=ctx.live_rows())
    except Exception:
        return []


def print_project(o):
    ln = o["now"]["lines"]
    print(_t(f"# {o['project']} · {ln['total']} lines ({ln['moving']} still moving) · {o['task_count']} tasks" + (f" · {o['open_count']} left" if o["open_count"] else ""),
             f"# {o['project']} · {ln['total']} 条线（{ln['moving']} 还在动） · {o['task_count']} 个任务" + (f" · 剩 {o['open_count']}" if o["open_count"] else "")))
    n = o["now"]
    if n["closes"]:
        print(_t("\nWhere it got to:", "\n走到哪："))
        for x in n["closes"]:
            print(f"  {time.strftime('%m-%d %H:%M', time.localtime(x['at']))} " + _t(f"closed {x['title']} ({x['task']}): {x['text']}", f"收尾 {x['title']}（{x['task']}）：{x['text']}"))
    elif n["latest"]:
        print(_t("\nWhere it got to: ", "\n走到哪：") + f"{time.strftime('%m-%d %H:%M', time.localtime(n['latest']['at']))} {n['latest']['text']}")
    print(_t("Left: ", "剩下：") + (_t(", ", "、").join(f"{x['short']}" + _t(f" ({x['id']}, {STATE().get(x['state'])}{'' if x['assignee'] else ', nobody on it'})", f"（{x['id']}，{STATE_ZH.get(x['state'])}{'' if x['assignee'] else '，没人认领'}）") for x in o["left"][:8]) or _t("nothing", "没有"))
          + (_t(f" and {len(o['left']) - 8} more", f" 等 {len(o['left'])} 项") if len(o["left"]) > 8 else ""))
    s = o["stats"]
    print(_t(f"This project: {s['lines']} lines · {s['tasks']} tasks · {s['closed']} closed · {s['decisions']} decisions · {s['commits']} commits · {', '.join(s['agents']) or 'no agent'}", f"这个项目：{s['lines']} 条线 · {s['tasks']} 任务 · {s['closed']} 收尾 · {s['decisions']} 结论 · {s['commits']} 提交 · {'、'.join(s['agents']) or '无 Agent'}"))
    if o["hidden"]:
        print(_t(f"\n({o['hidden']} earlier lines not listed; `dispatch thread {o['project']} --lines` shows them all)", f"\n（更早 {o['hidden']} 条线没列出，`dispatch thread {o['project']} --lines` 看全部）"))
    for r in o["chapters"]:
        if not r["shown"]:
            continue
        tag = STATE().get(r["state"], r["state"]) if r["state"] in ("run", "wait", "done") else _t(f"{r['open_count']} left", f"剩 {r['open_count']}")
        print(f"\n{'▾' if r['expanded'] else '▸'} {time.strftime('%m-%d', time.localtime(r['last_at'] or 0))} {r['short']}" + _t(f" ({r['root']})", f"（{r['root']}）") + f" · {tag} · {r['task_count']}" + _t(" tasks", " 任务"))
        if r["expanded"]:
            for d in r["days"]:
                print(f"  {d['date']} {WEEKDAY(d['weekday'])}")
                print_beats(d["beats"], "    ")
        elif r.get("gist"):
            print(f"    {r['gist']['text']}")
    if o["tail"]:
        print(_t("\nNow", "\n现在"))
        print_beats(o["tail"])


def cmd_decide(a):
    """Record what the user settled, so the 脉络 line marks it as a conclusion."""
    text = squash(a.text)
    if not text:
        raise SystemExit(_t("Write one sentence on what was decided: dispatch decide <task> \"sentence\"", "写一句决定了什么：dispatch decide <任务> \"一句话\""))
    body = text if text.startswith("【决定】") else "【决定】" + text
    code, _, err = D.sh(["bd", "comments", "add", a.task, body])
    if code != 0:
        print((err or "").strip() or _t(f"bd exit code {code}", f"bd 退出码 {code}"), file=sys.stderr)
        sys.exit(code or 1)
    D.out({"task": a.task, "text": body}, getattr(a, "json", False), lambda o: print(_t(f"{o['task']} decision recorded: ", f"{o['task']} 记下决定：") + o['text'][len('【决定】'):]))
