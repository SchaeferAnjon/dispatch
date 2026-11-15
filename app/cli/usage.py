# -*- coding: utf-8 -*-
"""`dispatch usage`: the Usage page in Dispatch IDE's Settings (Account and usage › Usage), everything from what this
Mac already has:

  allowance  every subscription's limits now, one card per account: each Claude account Dispatch keeps (`dispatch
             accounts`), Codex, the GLM Coding Plan and DeepSeek's balance (OpenCode's keys, opencode-quota.json);
             and fourteen days of each account's weekly and 5-hour readings.
               - Claude keeps only the latest reading, so Dispatch records them: usage/quota.jsonl, one line per
                 reading, with the account it was read for (`account`, the email). Readings recorded before the
                 account was written down are told apart by their weekly reset: every account's week starts at its
                 own hour of the week (`resets_at` modulo seven days), and the accounts' own readings give theirs.
               - Codex writes `rate_limits` into its rollouts (engines/codex.py quota_history).
  spend      tokens by engine, model, project and session, what Claude's tokens would cost at the API list price,
             and what models billed per call cost (OpenCode's and Pi's own `cost`, Tab completion's ledger), for the
             last 7, 30 and 90 days (usage_scan.py reads the transcripts).
  tools      every tool, MCP server, skill, sub-agent, hook and slash command: calls, failures, sessions, projects,
             last use, and what is installed or offered but was not used.
  heatmap    sessions per day for a year, per engine (the transcript index `dispatch stats` keeps).

The page opens on the last answer (usage/page.json) at once; `dispatch usage --json` starts a refresh in the background
when that answer is older than REFRESH_AFTER, and says so (`refreshing`). The first refresh of a busy Mac reads every
transcript once (about a minute); later ones read only what was appended. `--refresh` does it in the foreground.

Only reads, except the files under <dispatch dir>/usage/. Nothing here calls a paid service: the allowance readings
are the ones the account menu already takes (the engines' own usage endpoints, DeepSeek's balance, Zhipu's quota),
at most once every five minutes per account.
"""
import sys

sys.dont_write_bytecode = True

import json
import os
import re
import time
from datetime import date, datetime, timedelta

import usage_scan as S

D = None  # the dispatch module, set by command()

HEATMAP_DAYS = 365
RECENT_DAYS = 14
WINDOWS = (7, 30, 90)
RECORD_MIN_S = 10 * 60  # two readings of one account closer than this: keep the first unless a value changed
BUCKET_S = 15 * 60  # an engine's own points (Codex's): one per window per 15 minutes
WEEK = 7 * 86400
ANCHOR_STEP = 900  # weekly resets are compared to the quarter hour
REFRESH_AFTER = 5 * 60
PAGE_V = 2
TOP_SESSIONS = 12

ENGINE_LABELS = {"claude-code": "Claude Code", "codex": "Codex", "opencode": "OpenCode", "pi": "Pi", "zcode": "ZCode",
                 "gemini": "Gemini", "hermes": "Hermes", "goose": "Goose", "qwen": "Qwen Code", "copilot": "Copilot"}
# providers whose answers are billed per call (the others named in a transcript are subscriptions: coding plans)
PLAN_PROVIDERS = ("zhipuai-coding-plan", "zai-coding-plan", "zai-coding-cn", "zai-coding", "kimi-for-coding", "opencode")


def usage_dir():
    base = os.environ.get("DISPATCH_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".dispatch")
    return os.path.join(base, "usage")


def _p(name):
    return os.path.join(usage_dir(), name)


def _read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def _day(ts):
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


# ---- heatmap ---------------------------------------------------------------------------------

def sessions_per_day(index, days=HEATMAP_DAYS, today=None):
    """{date: {engine: sessions that had a message that day}} for the last `days` days, main sessions only (a
    sub-agent is part of its parent's session)."""
    today = today or date.today()
    start = (today - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    end = today.strftime("%Y-%m-%d")
    counts = {}
    for e in index.values():
        if e.get("subagent") or not e.get("session_id"):
            continue
        ag = e.get("agent") or "?"
        for day, v in (e.get("days") or {}).items():
            if start <= day <= end and v and v[0]:
                row = counts.setdefault(day, {})
                row[ag] = row.get(ag, 0) + 1
    return counts


def heatmap(index, days=HEATMAP_DAYS, today=None):
    today = today or date.today()
    counts = sessions_per_day(index, days, today)
    by = {}
    for row in counts.values():
        for ag, n in row.items():
            by[ag] = by.get(ag, 0) + n
    totals = [sum(r.values()) for r in counts.values()]
    return {
        "days": days,
        "from": (today - timedelta(days=days - 1)).strftime("%Y-%m-%d"),
        "to": today.strftime("%Y-%m-%d"),
        "counts": dict(sorted(counts.items())),
        "by_engine": dict(sorted(by.items(), key=lambda kv: -kv[1])),
        "max": max(totals) if totals else 0,
        "total": sum(totals),
        "active_days": len(counts),
    }


# ---- allowance readings ------------------------------------------------------------------------

def _window_key(w):
    """A `dispatch quota` window → "session" (5 hours) | "weekly" (7 days) | None (per-model etc.)."""
    kind = w.get("kind")
    if kind in ("session", "weekly"):
        return kind
    label = (w.get("label") or "").lower()
    if kind is None and label in ("5 小时", "5h", "5 hours"):
        return "session"
    if kind is None and label in ("每周", "weekly"):
        return "weekly"
    return None


def reading_of(row, now=None, account=""):
    """One `dispatch quota` row (or an account's usage) → {agent, at, plan, account, session, weekly}, or None when it
    has no windows."""
    wins = {}
    for w in row.get("windows") or []:
        k = _window_key(w)
        if k and k not in wins and isinstance(w.get("used_percent"), (int, float)):
            wins[k] = {"used": round(float(w["used_percent"]), 1), "resets_at": w.get("resets_at")}
    if not wins:
        return None
    r = {"agent": row.get("agent"), "at": round(float(row.get("updated_at") or now or time.time()), 1), "plan": row.get("plan") or ""}
    acct = account or row.get("account_email") or ""
    if acct:
        r["account"] = acct
    r.update(wins)
    return r


def history_path():
    return _p("quota.jsonl")


def load_history(path=None):
    out = []
    try:
        with open(path or history_path(), encoding="utf-8") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get("agent") and isinstance(r.get("at"), (int, float)):
                    out.append(r)
    except OSError:
        pass
    return out


def _who(r):
    return (r.get("agent"), r.get("account") or "")


def record(readings, path=None, history=None):
    """Append the readings that are new: a later `at` than the account's last recorded one, and at least RECORD_MIN_S
    after it unless a value changed. Returns the rows written."""
    path = path or history_path()
    history = load_history(path) if history is None else history
    last = {}
    for r in history:
        if r["at"] >= last.get(_who(r), {}).get("at", 0):
            last[_who(r)] = r
    new = []
    for r in readings:
        if not r:
            continue
        prev = last.get(_who(r))
        if prev and r["at"] <= prev["at"]:
            continue
        same = prev and all((prev.get(k) or {}).get("used") == (r.get(k) or {}).get("used") for k in ("session", "weekly"))
        if prev and same and r["at"] - prev["at"] < RECORD_MIN_S:
            continue
        new.append(r)
        last[_who(r)] = r
    if new:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            for r in new:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    return new


def _bucket(points, bucket_s):
    """Keep the last point of every bucket (the curve does not need every token_count)."""
    out = {}
    for p in points:
        out[int(p[0] // bucket_s)] = p
    return [out[k] for k in sorted(out)]


def anchor_of(resets_at):
    """The hour of the week an account's weekly window starts over, to the quarter hour (None without a reset time)."""
    if not isinstance(resets_at, (int, float)) or resets_at <= 0:
        return None
    return int(round((resets_at % WEEK) / ANCHOR_STEP)) % (WEEK // ANCHOR_STEP)


def _same_anchor(a, b):
    if a is None or b is None:
        return False
    n = WEEK // ANCHOR_STEP
    return min((a - b) % n, (b - a) % n) <= 1


def next_reset(resets_at, now):
    """The first weekly reset after `now`, from any earlier or later reset time of the same account."""
    if not isinstance(resets_at, (int, float)):
        return None
    r = float(resets_at)
    while r <= now:
        r += WEEK
    while r - WEEK > now:
        r -= WEEK
    return r


def _tier(a, live_oauth):
    """"Max 20x", "Max 5x", "Pro" from what the account's login says of its rate tier, else its plan word."""
    oa = a.get("oauth_account") or {}
    if (live_oauth or {}).get("emailAddress") and live_oauth.get("emailAddress") == a.get("email") and not oa.get("organizationRateLimitTier"):
        oa = live_oauth
    tier = oa.get("organizationRateLimitTier") or oa.get("userRateLimitTier") or ""
    m = re.search(r"max_(\d+)x", tier or "")
    if m:
        return "Max %sx" % m.group(1)
    plan = (a.get("plan") or "").strip()
    return plan[:1].upper() + plan[1:] if plan else ""


def _short_name(a):
    if a.get("label"):
        return a["label"]
    email = a.get("email") or ""
    return email.split("@")[0] if email else "this account"


def claude_accounts():
    """The Claude accounts Dispatch keeps: [{id, email, name, plan, active, usage: {at, windows}}] (names and numbers
    only, from accounts.json and the per-account usage cache; nothing asked over the network)."""
    import accounts as A
    st = A.load()
    try:
        live = A.Accounts().current("claude", st)
    except Exception:
        live = (None, None)
    ident, cur = live if isinstance(live, tuple) else (None, live)
    live_email = (ident or {}).get("email") or (cur or {}).get("email") or ""
    live_oauth = A._load_json(A.claude_global_config(), {}).get("oauthAccount") or {}
    rows = []
    for a in A.accounts_of(st, "claude"):
        if a.get("kind") == "apikey":
            continue
        u = A._load_json(A._p("usage", a["id"] + ".json"), {}) if a.get("id") else {}
        rows.append({"id": a.get("id") or "", "email": a.get("email") or "", "name": _short_name(a), "plan": _tier(a, live_oauth),
                     "active": bool(live_email) and a.get("email") == live_email, "usage": u if isinstance(u, dict) else {}})
    for r in rows:
        if r["active"] and not (r["usage"] or {}).get("windows"):
            # the account in use has no usage answer of its own yet: Claude Code's status line speaks for it
            try:
                q = D.quota_of("claude") if D else {}
            except Exception:
                q = {}
            wins = [{"kind": w.get("kind"), "used_percent": w.get("used_percent"), "resets_at": w.get("resets_at")} for w in (q or {}).get("windows") or [] if w.get("kind")]
            if wins and (q or {}).get("updated_at"):
                r["usage"] = {"at": q["updated_at"], "windows": wins}
    if live_email and not any(r["active"] for r in rows):
        rows.insert(0, {"id": "", "email": live_email, "name": live_email.split("@")[0], "plan": _tier({"email": live_email, "plan": (ident or {}).get("plan") or ""}, live_oauth),
                        "active": True, "usage": {}})
    rows.sort(key=lambda r: (not r["active"], r["email"]))
    return rows


def _usage_reading(agent, acct):
    u = acct.get("usage") or {}
    if not u.get("windows") or not u.get("at"):
        return None
    return reading_of({"agent": agent, "updated_at": u["at"], "windows": u["windows"]}, account=acct.get("email") or "")


def claude_tracks(history, accounts, now, since):
    """The Claude readings of the last days, one track per account: readings that name their account go to it, the
    others to the account whose week starts at the same hour, and readings of an hour no account has to a track of
    their own ("unnamed")."""
    anchors = {}
    for a in accounts:
        for r in sorted((h for h in history if h.get("agent") == "claude-code" and h.get("account") == a["email"]), key=lambda h: h["at"]):
            anc = anchor_of((r.get("weekly") or {}).get("resets_at"))
            if anc is not None:
                anchors[a["email"]] = anc
        if a["email"] not in anchors:
            ws = [w for w in (a.get("usage") or {}).get("windows") or [] if w.get("kind") == "weekly"]
            anc = anchor_of(ws[0].get("resets_at")) if ws else None
            if anc is not None:
                anchors[a["email"]] = anc
    tracks = {a["email"]: {"key": a["email"], "rows": []} for a in accounts}
    unnamed = {}
    for r in sorted((h for h in history if h.get("agent") == "claude-code"), key=lambda h: h["at"]):
        who = r.get("account") or ""
        if who in tracks:
            tracks[who]["rows"].append(r)
            continue
        anc = anchor_of((r.get("weekly") or {}).get("resets_at"))
        owner = next((e for e, x in anchors.items() if _same_anchor(x, anc)), None)
        if owner:
            tracks[owner]["rows"].append(r)
        elif anc is not None:
            key = next((k for k in unnamed if _same_anchor(k, anc)), anc)
            unnamed.setdefault(key, {"key": "anchor-%d" % key, "rows": [], "anchor": key})["rows"].append(r)
    out = []
    for a in accounts:
        out.append({**tracks[a["email"]], "account": a})
    for k in sorted(unnamed, key=lambda k: -len(unnamed[k]["rows"])):
        out.append({**unnamed[k], "account": None})
    for t in out:
        t["rows"] = [r for r in t["rows"] if r["at"] >= since - WEEK]
    return out


def _series(rows, key, since):
    pts = [(r["at"], (r.get(key) or {}).get("used")) for r in rows if r["at"] >= since and (r.get(key) or {}).get("used") is not None]
    return [[round(t, 1), v] for t, v in _bucket(pts, BUCKET_S)]


def _window_now(w, now):
    """A window as the card shows it: the reading, or 0 once its reset time has passed (with when it reset)."""
    if not w:
        return None
    used, at = w.get("used"), w.get("resets_at")
    if isinstance(at, (int, float)) and at and at <= now:
        return {"used": 0, "resets_at": None, "reset_at": at, "was": used}
    return {"used": used, "resets_at": at}


def _weekday_time(epoch):
    d = datetime.fromtimestamp(epoch)
    return d.strftime("%a %H:%M")


def allowance(now=None, recent=RECENT_DAYS, history=None, accounts=None, codex=None, oc_quota=None, codex_points=None, deepseek_spent=None):
    """Cards (one per account) and tracks (fourteen days of readings per account)."""
    now = now or time.time()
    since = now - recent * 86400
    history = load_history() if history is None else history
    accounts = claude_accounts() if accounts is None else accounts
    cards, tracks = [], []
    unnamed_n = 0
    for t in claude_tracks(history, accounts, now, since):
        a = t["account"]
        rows = t["rows"]
        latest = rows[-1] if rows else None
        own = _usage_reading("claude-code", a) if a else None
        if own and (not latest or own["at"] >= latest["at"]):
            latest = own
        if a:
            title, name, plan, active = "Claude · %s" % a["name"], a["email"], a["plan"], a["active"]
        else:
            unnamed_n += 1
            title, name, plan, active = "Claude · %s" % ("2nd", "3rd", "4th", "5th")[min(unnamed_n - 1, 3)] if accounts else "Claude", "", "", False
        weekly_reset = None
        for r in reversed(rows + ([own] if own else [])):
            ra = (r.get("weekly") or {}).get("resets_at")
            if ra:
                weekly_reset = next_reset(ra, now)
                break
        card = {"id": "claude:%s" % (name or t["key"]), "kind": "claude", "engine": "claude-code", "title": title, "account": name,
                "plan": plan, "in_use": active, "unnamed": a is None,
                "session": _window_now(latest.get("session"), now) if latest else None,
                "weekly": _window_now(latest.get("weekly"), now) if latest else None,
                "read_at": latest["at"] if latest else None, "weekly_reset": weekly_reset,
                "track": t["key"] if rows else None}
        if not latest:
            card["note"] = "No reading yet. Dispatch reads it every five minutes while the window is open."
        cards.append(card)
        if rows:
            wk = _series(rows, "weekly", since - WEEK)
            tracks.append({"id": t["key"], "title": title, "engine": "claude-code", "weekly": wk, "session": _series(rows, "session", since),
                           "reset": weekly_reset, "readings": len([r for r in rows if r["at"] >= since]),
                           "first_at": rows[0]["at"], "now": (card["weekly"] or {}).get("used") if latest and latest["at"] > now - 3 * 3600 else None})
    # Codex: its rollouts, plus what Dispatch recorded and the account's own usage answer
    cx = codex or {}
    pts = sorted(set(tuple(p) for p in (codex_points or [])) | {(r["at"], (r.get("session") or {}).get("used"), (r.get("weekly") or {}).get("used")) for r in history if r.get("agent") == "codex"})
    cx_usage = cx.get("usage") or {}
    latest_w = next(((t, w) for t, s_, w in reversed(pts) if w is not None), None)
    latest_s = next(((t, s_) for t, s_, w in reversed(pts) if s_ is not None), None)
    card = {"id": "codex", "kind": "codex", "engine": "codex", "title": "Codex", "account": cx.get("email") or "",
            "plan": (cx.get("plan") or "").capitalize(), "in_use": bool(cx.get("email")), "unnamed": False,
            "session": None, "weekly": None, "read_at": None, "track": "codex" if pts else None}
    wins = {w.get("kind"): w for w in cx_usage.get("windows") or []}
    if wins.get("weekly") or wins.get("session"):
        card["session"] = _window_now({"used": (wins.get("session") or {}).get("used_percent"), "resets_at": (wins.get("session") or {}).get("resets_at")}, now) if wins.get("session") else None
        card["weekly"] = _window_now({"used": (wins.get("weekly") or {}).get("used_percent"), "resets_at": (wins.get("weekly") or {}).get("resets_at")}, now) if wins.get("weekly") else None
        card["read_at"] = cx_usage.get("at")
    elif latest_w or latest_s:
        last_t = max(x[0] for x in (latest_w, latest_s) if x)
        fresh = now - last_t < 5 * 3600
        if fresh:
            card["weekly"] = {"used": latest_w[1], "resets_at": None} if latest_w else None
            card["session"] = {"used": latest_s[1], "resets_at": None} if latest_s and now - latest_s[0] < 5 * 3600 else None
            card["read_at"] = last_t
        else:
            silent = cx.get("last_session_at")
            parts = []
            if silent and silent > last_t:
                parts.append("No reading: Codex's last session (%s) reported no limits." % _short_time(silent))
            else:
                parts.append("No reading since %s." % _short_time(last_t))
            if latest_w:
                parts.append("Last known: week %d%% on %s%s." % (round(latest_w[1]), _short_day(latest_w[0]),
                                                                 ", so it has reset since" if now - latest_w[0] > WEEK else ""))
            card["note"] = " ".join(parts)
    else:
        card["note"] = "No reading yet. Codex writes its limits into its session logs as it works."
    if cx.get("email") or pts:
        cards.append(card)
    if pts:
        cx_week = [[round(t, 1), w] for t, s_, w in _bucket([p for p in pts if p[0] >= since - WEEK and p[2] is not None], BUCKET_S)]
        cx_five = [[round(t, 1), s_] for t, s_, w in _bucket([p for p in pts if p[0] >= since and p[1] is not None], BUCKET_S)]
        # a reading: one per quarter hour (Codex writes one with every answer)
        tracks.append({"id": "codex", "title": "Codex", "engine": "codex", "weekly": cx_week, "session": cx_five,
                       "reset": None, "readings": len({int(p[0] // BUCKET_S) for p in pts if p[0] >= since}), "first_at": pts[0][0], "now": None})
    # the services OpenCode has a key for
    oc = oc_quota or {}
    glm = next((oc[k] for k in ("zhipuai-coding-plan", "zai-coding-plan") if (oc.get(k) or {}).get("rows")), None)
    if glm:
        wins = {}
        for w in glm["rows"]:
            key = "session" if w.get("label") in ("5-hour", "5-hourly", "hourly") or "hour" in (w.get("label") or "") else "weekly" if "week" in (w.get("label") or "") else None
            if key and key not in wins and isinstance(w.get("used_percent"), (int, float)):
                wins[key] = {"used": float(w["used_percent"]), "resets_at": w.get("resets_at")}
        plan = next((w.get("plan") for w in glm["rows"] if w.get("plan")), "")
        cards.append({"id": "glm", "kind": "glm", "engine": "opencode", "title": "GLM Coding Plan", "plan": plan.capitalize(), "via": "OpenCode",
                      "in_use": False, "unnamed": False, "session": _window_now(wins.get("session"), now), "weekly": _window_now(wins.get("weekly"), now),
                      "read_at": glm.get("at"), "track": None})
    ds = (oc.get("deepseek") or {})
    bal = next((r for r in ds.get("rows") or [] if r.get("kind") == "balance"), None)
    if bal:
        cards.append({"id": "deepseek", "kind": "deepseek", "engine": "opencode", "title": "DeepSeek", "plan": "Pay per call", "via": "OpenCode, Pi",
                      "in_use": False, "unnamed": False, "session": None, "weekly": None,
                      "balance": {"amount": bal.get("amount"), "currency": bal.get("currency") or "CNY"},
                      "spent_30d": round(deepseek_spent or 0, 4), "read_at": ds.get("at"), "track": None})
    return {"days": recent, "from": since, "to": now, "cards": cards, "tracks": tracks}


def _short_day(epoch):
    d = datetime.fromtimestamp(epoch)
    return "%s %d" % (d.strftime("%b"), d.day)


def _short_time(epoch):
    d = datetime.fromtimestamp(epoch)
    return "%s %d, %s" % (d.strftime("%b"), d.day, d.strftime("%H:%M"))


# ---- spend and tools -------------------------------------------------------------------------------

def _days(n, today):
    return [(today - timedelta(days=n - 1 - i)).strftime("%Y-%m-%d") for i in range(n)]


def _billed_provider(provider):
    return bool(provider) and provider not in PLAN_PROVIDERS


class _Projects:
    """cwd → the project name the rest of Dispatch shows, once per folder."""

    def __init__(self, resolve=None):
        self.cache, self.resolve = {}, resolve
        self.home = os.path.expanduser("~").rstrip("/")

    def __call__(self, cwd):
        cwd = (cwd or "").rstrip("/")
        if cwd in self.cache:
            return self.cache[cwd]
        if not cwd:
            name = "unknown folder"
        elif cwd == self.home:
            name = "loose sessions"
        else:
            name = ""
            if self.resolve:
                try:
                    name = self.resolve(cwd)
                except Exception:
                    name = ""
            if not name and cwd.startswith(("/private/tmp", "/tmp/", "/var/folders", "/private/var/folders")):
                name = "temp folders"  # scratch folders, each with a name of its own: one row
            name = name or os.path.basename(cwd)
        self.cache[cwd] = name
        return name


def _mcp_name(server):
    """`plugin_playwright_playwright` → "Playwright (plugin)", `claude_ai_Google_Drive` → "Google Drive", `claude-in-chrome` →
    "Claude in Chrome"."""
    if server.startswith("claude_ai_"):
        return server[len("claude_ai_"):].replace("_", " ")
    m = re.match(r"^plugin_([^_]+(?:-[^_]+)*)_(.+)$", server)
    if m:
        plugin, srv = m.groups()
        nice = srv.replace("_", " ").replace("-", " ")
        nice = nice[:1].upper() + nice[1:]
        return "%s (plugin)" % nice if plugin.replace("-", "") == srv.replace("-", "").replace("_", "") else "%s (%s plugin)" % (nice, plugin)
    return {"claude-in-chrome": "Claude in Chrome", "computer-use": "Computer use"}.get(server, server)


SIGN_IN_TOOLS = {"authenticate", "complete_authentication"}


def aggregate(summaries, today=None, windows=WINDOWS, project_of=None, titles=None, installed_skills=None, agent_defs=None,
              extra_billed=None, offered_tools=None):
    """{window: {spend, tools}} from the file summaries. `titles`: {(engine, session id): title}; `installed_skills`: skill
    names a person has; `agent_defs`: sub-agent names a person defined; `extra_billed`: {day: {label: usd}} (Tab completion);
    `offered_tools`: {server: set of tool names offered} for telling sign-in connectors."""
    today = today or date.today()
    project_of = project_of or _Projects()
    titles = titles or {}
    out = {}
    for n in windows:
        days = _days(n, today)
        start, dayset = days[0], set(days)
        di = {d: i for i, d in enumerate(days)}
        engines = {}
        models = {}
        projects = {}
        sessions = {}
        billed_by = {}
        tools, mcp, skills, agents, hooks, cmds = {}, {}, {}, {}, {}, {}
        offered = {}
        tot_calls = tot_err = 0

        def eng_row(e):
            return engines.setdefault(e, {"tokens": [0, 0, 0, 0], "total": 0, "value": 0.0, "billed": 0.0,
                                          "daily_tokens": [0] * n, "daily_value": [0.0] * n})

        for key, s in summaries.items():
            if not s.get("last") or s["last"] < start:
                continue
            e = s["eng"]
            proj = project_of(s.get("cwd"))
            sk = (e, s.get("sid") or key)
            sess = sessions.get(sk)
            if sess is None:
                sess = sessions[sk] = {"engine": e, "id": s.get("sid") or "", "title": "", "project": proj, "subagents": 0,
                                       "tokens": 0, "value": 0.0, "billed": 0.0, "last": "", "models": {}, "main": False}
            if s.get("sub"):
                if s["last"] >= start:
                    sess["subagents"] += 1
            else:
                sess["main"] = True
                sess["project"] = proj
                if s.get("title"):
                    sess["title"] = s["title"]
            sess["last"] = max(sess["last"], s["last"])
            for day, per_model in (s.get("tok") or {}).items():
                if day not in dayset:
                    continue
                for model, t in per_model.items():
                    total = t[0] + t[1] + t[2] + t[3] + t[4]
                    val = S.api_value(model, t) if e == "claude-code" else None
                    E = eng_row(e)
                    E["tokens"][0] += t[0]; E["tokens"][1] += t[1]; E["tokens"][2] += t[2]; E["tokens"][3] += t[3] + t[4]
                    E["total"] += total
                    E["daily_tokens"][di[day]] += total
                    if val:
                        E["value"] += val
                        E["daily_value"][di[day]] += val
                    M = models.setdefault(model, {"model": model, "label": S.model_label(model), "engine": e, "tokens": [0, 0, 0, 0], "total": 0,
                                                       "value": 0.0, "billed": 0.0, "priced": val is not None, "provider": (s.get("prov") or {}).get(model, "")})
                    M["tokens"][0] += t[0]; M["tokens"][1] += t[1]; M["tokens"][2] += t[2]; M["tokens"][3] += t[3] + t[4]
                    M["total"] += total
                    M["value"] += val or 0
                    P = projects.setdefault(proj, {"name": proj, "value": 0.0, "billed": 0.0, "tokens": 0, "by": {}, "tokens_by": {}, "sessions": set()})
                    P["tokens"] += total
                    P["tokens_by"][e] = P["tokens_by"].get(e, 0) + total
                    if val:
                        P["value"] += val
                        P["by"][e] = P["by"].get(e, 0) + val
                    P["sessions"].add(sk)
                    sess["tokens"] += total
                    sess["value"] += val or 0
                    sess["models"][model] = sess["models"].get(model, 0) + total
            for day, per_model in (s.get("usd") or {}).items():
                if day not in dayset:
                    continue
                for model, usd in per_model.items():
                    prov = (s.get("prov") or {}).get(model, "")
                    if not _billed_provider(prov):
                        continue
                    E = eng_row(e)
                    E["billed"] += usd
                    E["daily_value"][di[day]] += usd
                    M = models.setdefault(model, {"model": model, "label": S.model_label(model), "engine": e, "tokens": [0, 0, 0, 0], "total": 0,
                                                       "value": 0.0, "billed": 0.0, "priced": False, "provider": prov})
                    M["billed"] += usd
                    P = projects.setdefault(proj, {"name": proj, "value": 0.0, "billed": 0.0, "tokens": 0, "by": {}, "tokens_by": {}, "sessions": set()})
                    P["billed"] += usd
                    P["by"][e] = P["by"].get(e, 0) + usd
                    sess["billed"] += usd
                    label = "%s via %s" % (_provider_label(prov), ENGINE_LABELS.get(e, e))
                    b = billed_by.setdefault(label, {"label": label, "provider": prov, "engine": e, "usd": 0.0})
                    b["usd"] += usd

            # tools of every kind
            def fold(table, src, kind_engine=True):
                nonlocal tot_calls, tot_err
                for name, per_day in (src or {}).items():
                    cnt = err = 0
                    last = ""
                    for day, (c, x) in per_day.items():
                        if day in dayset:
                            cnt += c
                            err += x
                            last = max(last, day)
                    if not cnt:
                        continue
                    row = table.setdefault(name, {"name": name, "count": 0, "errors": 0, "sessions": set(), "projects": {}, "last": "", "engines": {}})
                    row["count"] += cnt
                    row["errors"] += err
                    row["sessions"].add(sk)
                    row["projects"][proj] = row["projects"].get(proj, 0) + cnt
                    row["last"] = max(row["last"], last)
                    row["engines"][e] = row["engines"].get(e, 0) + cnt
                    if table is tools:
                        tot_calls += cnt
                        tot_err += err

            fold(tools, s.get("tl"))
            fold(skills, s.get("sk"))
            fold(agents, s.get("ag"))
            fold(hooks, s.get("hk"))
            for name, per_day in (s.get("cm") or {}).items():
                c = sum(v[0] for d, v in per_day.items() if d in dayset)
                if c:
                    row = cmds.setdefault(name, {"name": name, "count": 0, "sessions": set(), "last": ""})
                    row["count"] += c
                    row["sessions"].add(sk)
                    row["last"] = max([row["last"]] + [d for d in per_day if d in dayset])
            for name in s.get("hke") or {}:
                if name in hooks:
                    hooks[name]["event"] = s["hke"][name]
            if not s.get("sub"):
                for srv in s.get("mo") or []:
                    offered.setdefault(srv, set()).add(sk)

        # Tab completion's ledger and the like
        for day, per in (extra_billed or {}).items():
            if day not in dayset:
                continue
            for label, usd in per.items():
                b = billed_by.setdefault(label, {"label": label, "provider": "", "engine": "", "usd": 0.0})
                b["usd"] += usd

        # MCP servers from the tool names (`mcp__<server>__<tool>`)
        builtin = []
        for name, row in tools.items():
            if name.startswith("mcp__"):
                srv, _, tool = name[5:].partition("__")
                m = mcp.setdefault(srv, {"id": srv, "name": _mcp_name(srv), "calls": 0, "errors": 0, "tools": {}, "sessions": set(),
                                         "projects": {}, "last": "", "engines": {}})
                m["calls"] += row["count"]
                m["errors"] += row["errors"]
                m["tools"][tool] = {"count": row["count"], "errors": row["errors"]}
                m["sessions"] |= row["sessions"]
                for p, c in row["projects"].items():
                    m["projects"][p] = m["projects"].get(p, 0) + c
                m["last"] = max(m["last"], row["last"])
                for k, c in row["engines"].items():
                    m["engines"][k] = m["engines"].get(k, 0) + c
            elif name not in ("Skill", "Agent", "Task"):
                builtin.append(row)
        for srv, sess_set in offered.items():
            m = mcp.setdefault(srv, {"id": srv, "name": _mcp_name(srv), "calls": 0, "errors": 0, "tools": {}, "sessions": set(),
                                     "projects": {}, "last": "", "engines": {}})
            m["offered"] = len(sess_set)
        for srv, m in mcp.items():
            m.setdefault("offered", 0)
            names = (offered_tools or {}).get(srv) or set()
            m["connector"] = bool(names) and set(names) <= SIGN_IN_TOOLS

        def rows_of(table, key="count"):
            res = []
            for r in table.values():
                r = dict(r)
                r["sessions"] = len(r["sessions"])
                if "projects" in r:
                    r["projects"] = [p for p, _ in sorted(r["projects"].items(), key=lambda kv: -kv[1])][:4]
                res.append(r)
            return sorted(res, key=lambda r: (-r.get(key, 0), r["name"] if "name" in r else ""))

        engines_known_fail = {"codex"}  # Codex writes no failure flag
        builtin_rows = rows_of({r["name"]: r for r in builtin})
        for r in builtin_rows:
            if set(r["engines"]) <= engines_known_fail:
                r["errors"] = None
        skill_rows = rows_of(skills)
        for r in skill_rows:
            if set(r["engines"]) <= engines_known_fail:
                r["errors"] = None
        used_skills = {r["name"] for r in skill_rows}
        agent_rows = rows_of(agents)
        defined = set(agent_defs or [])
        for r in agent_rows:
            r["defined"] = r["name"] in defined
        used_agents = {r["name"] for r in agent_rows}
        mcp_rows = sorted(({**m, "sessions": len(m["sessions"]), "projects": [p for p, _ in sorted(m["projects"].items(), key=lambda kv: -kv[1])][:4],
                            "tools": len(m["tools"]), "tool_rows": sorted(({"tool": k, **v} for k, v in m["tools"].items()), key=lambda r: -r["count"])}
                           for m in mcp.values()), key=lambda m: (-m["calls"], -m["offered"], m["name"]))
        hook_rows = rows_of(hooks)
        for r in hook_rows:
            r.setdefault("event", "")
        cmd_rows = sorted(({**r, "sessions": len(r["sessions"])} for r in cmds.values()), key=lambda r: (-r["count"], r["name"]))

        proj_rows = sorted(({**p, "sessions": len(p["sessions"])} for p in projects.values()), key=lambda p: (-(p["value"] + p["billed"]), -p["tokens"]))
        model_rows = sorted(models.values(), key=lambda m: (-(m["value"] + m["billed"]), -m["total"]))
        sess_rows = []
        for sk, x in sessions.items():
            if not x["main"] or not x["tokens"]:
                continue
            x = dict(x)
            x["title"] = x["title"] or titles.get(sk, "") or ""
            x["models"] = [m for m, _ in sorted(x["models"].items(), key=lambda kv: -kv[1])][:3]
            x.pop("main")
            sess_rows.append(x)
        sess_rows.sort(key=lambda x: (-(x["value"] + x["billed"]), -x["tokens"]))
        totals = sum(E["total"] for E in engines.values())
        cache_read = sum(E["tokens"][2] for E in engines.values())
        out[str(n)] = {
            "days": days,
            "spend": {
                "engines": engines,
                "tokens_total": totals,
                "cache_share": cache_read / totals if totals else 0,
                "api_value": round(sum(E["value"] for E in engines.values()), 4),
                "billed": round(sum(b["usd"] for b in billed_by.values()), 6),
                "billed_by": sorted(({**b, "usd": round(b["usd"], 6)} for b in billed_by.values()), key=lambda b: -b["usd"]),
                "projects": proj_rows[:20],
                "models": model_rows[:20],
                "sessions": sess_rows[:TOP_SESSIONS],
            },
            "tools": {
                "totals": {"calls": tot_calls, "errors": tot_err, "distinct": len(tools)},
                "builtin": builtin_rows[:60],
                "mcp": mcp_rows,
                "skills": skill_rows,
                "unused_skills": sorted(set(installed_skills or ()) - used_skills),
                "agents": agent_rows,
                "unused_agents": sorted(defined - used_agents),
                "hooks": hook_rows,
                "commands": cmd_rows[:40],
            },
        }
    return out


def _provider_label(prov):
    return {"deepseek": "DeepSeek", "zhipuai": "Zhipu AI", "zai": "Z.AI", "moonshot": "Moonshot", "kimi": "Kimi", "openai": "OpenAI",
            "anthropic": "Anthropic", "openrouter": "OpenRouter", "google": "Google"}.get(prov, prov)


# ---- what is installed ----------------------------------------------------------------------------

def installed_skills():
    names = set()
    try:
        if os.path.isdir(D.POOL):
            names |= {n for n in os.listdir(D.POOL) if os.path.isdir(os.path.join(D.POOL, n)) and not n.startswith((".", "_"))}
        for ag in D.AGENT_SKILL_DIRS:
            names |= set(D.mounted(ag))
    except Exception:
        pass
    return sorted(names)


def agent_definitions():
    try:
        import agents_defs
        return sorted({d["name"] for d in agents_defs.defs()})
    except Exception:
        return []


def offered_tools(summaries_paths):
    """{server: tool names} a session was offered (deferred_tools_record entries), for telling sign-in connectors (only
    `authenticate`) from servers with real tools. Read from the newest Claude Code transcript that has a record."""
    out = {}
    for path in summaries_paths[:20]:
        try:
            with open(path, "rb") as f:
                f.seek(max(0, os.path.getsize(path) - (32 << 20)))
                buf = f.read().decode("utf-8", "replace")
        except OSError:
            continue
        for line in buf.split("\n"):
            if '"deferred_tools_' not in line:
                continue
            try:
                a = json.loads(line).get("attachment") or {}
            except ValueError:
                continue
            names = a.get("addedNames") or [e.get("name") for e in a.get("entries") or [] if isinstance(e, dict)]
            for n in names or []:
                if isinstance(n, str) and n.startswith("mcp__"):
                    srv, _, tool = n[5:].partition("__")
                    out.setdefault(srv, set()).add(tool)
        if out:
            break
    return out


# ---- the command ---------------------------------------------------------------------------------

def current_quota():
    """This Mac's `dispatch quota` rows for the engines Dispatch keeps accounts of, with the account they are for."""
    import engines
    rows = []
    for eng in (e for e in engines.known() if e.accounts):
        try:
            rows.append(D.quota_of(eng.id))
        except Exception:
            continue
    return rows


def _live_email(engine):
    try:
        import accounts as A
        ident, cur = A.Accounts().current(engine, A.load())
        return (ident or {}).get("email") or (cur or {}).get("email") or ""
    except Exception:
        return ""


def record_now(refresh_accounts=False):
    """Record the allowance readings this Mac has now: the engines' quota rows (for the account in use) and, with
    `refresh_accounts`, every saved account's own usage (the account menu's reading, at most once per five minutes)."""
    now = time.time()
    readings = []
    for row in current_quota():
        engine = "claude" if row.get("agent") == "claude-code" else row.get("agent")
        readings.append(reading_of(row, now, account=_live_email(engine) if row.get("agent") in ("claude-code", "codex") else ""))
    if refresh_accounts:
        try:
            import accounts as A
            A.Accounts().overview(["claude"], usage=True)
        except Exception:
            pass
    for a in claude_accounts():
        r = _usage_reading("claude-code", a)
        if r:
            readings.append(r)
    return record(readings)


def _codex_info():
    info = {}
    try:
        import accounts as A
        ov = A.Accounts().overview(["codex"], usage=False)[0]
        act = ov.get("active") or {}
        info = {"email": act.get("email") or "", "plan": act.get("plan") or ""}
        if act.get("id"):
            info["usage"] = A._load_json(A._p("usage", act["id"] + ".json"), {})
    except Exception:
        pass
    cache = _read_json(_p("codex-limits.json"), {}) or {}
    newest = 0
    for path, ent in (cache.get("files") or {}).items():
        try:
            mt = float(str(ent.get("key") or "0:").split(":")[0])
        except ValueError:
            continue
        if not ent.get("points"):
            newest = max(newest, mt)
    if newest:
        info["last_session_at"] = newest
    return info


def _oc_quota(fetch):
    try:
        import opencode_engine as O
        if fetch:
            return O.quota([O.DEEPSEEK, *O.ZHIPU_CODING])
    except Exception:
        pass
    cache = _read_json(os.path.join(os.path.dirname(usage_dir()), "opencode-quota.json"), {}) or {}
    return {k: v for k, v in cache.items() if isinstance(v, dict)}


def _oc_quota_with_at(fetch):
    rows = _oc_quota(fetch)
    cache = _read_json(os.path.join(os.path.dirname(usage_dir()), "opencode-quota.json"), {}) or {}
    return {k: {"rows": v if isinstance(v, list) else (v or {}).get("rows") or [], "at": (cache.get(k) or {}).get("at")} for k, v in rows.items()}


def tab_ledger():
    """{day: {"Tab completion (DeepSeek)": usd}} from Dispatch IDE's Tab completion ledger."""
    ledger = _read_json(os.path.join(os.path.dirname(usage_dir()), "ide", "tab-usage-days.json"), {}) or {}
    return {d: {"Tab completion (DeepSeek)": float((v or {}).get("usd") or 0)} for d, v in ledger.items() if (v or {}).get("usd")}


def _titles(index):
    out = {}
    for e in index.values():
        if e.get("subagent") or not e.get("session_id"):
            continue
        t = (e.get("title") or e.get("first_prompt") or "").strip().split("\n")[0][:120]
        if t:
            out[(e.get("agent"), e["session_id"])] = t
    return out


def _project_resolver():
    try:
        names = D.project_names()
    except Exception:
        names = {}
    try:
        roots = D.settings_load().get("workspace_roots") or []
    except Exception:
        roots = []
    return lambda cwd: D.project_of_cwd(cwd, names, roots)


def _progress(state, done=0, total=0, started=None):
    _write_json(_p("progress.json"), {"state": state, "done": done, "total": total, "pid": os.getpid(),
                                       "started_at": started or time.time(), "updated_at": time.time()})


def read_progress():
    p = _read_json(_p("progress.json"), {}) or {}
    if p.get("state") == "running":
        import dplatform as P
        if not P.pid_alive(p.get("pid")):
            p["state"] = "interrupted"
    return p


def build(days=HEATMAP_DAYS, recent=RECENT_DAYS, fetch=None):
    """Everything the page shows, read now (the slow path: the background refresh and `--refresh`). `fetch`: ask the
    accounts' usage endpoints and OpenCode's services for fresh numbers; never in a test instance
    (DISPATCH_E2E_INSTANCE), whose made-up accounts must not reach this Mac's keychain or a server."""
    if fetch is None:
        fetch = not os.environ.get("DISPATCH_E2E_INSTANCE")
    t0 = time.time()
    _progress("running", started=t0)
    now = time.time()
    record_now(refresh_accounts=fetch)
    try:
        index = D.refresh_index()
    except Exception:
        index = D.load_index()
    last = [0.0]

    def prog(done, total):
        if time.time() - last[0] > 0.5 or done == total:
            last[0] = time.time()
            _progress("running", done, total, t0)

    summaries = S.scan(_p("scan.json"), progress=prog)
    from activity import in_session_root, session_root
    if session_root():
        # a test instance (DISPATCH_SESSION_ROOT) counts only its own sessions, as every other page does
        summaries = {k: v for k, v in summaries.items() if in_session_root(v.get("cwd"))}
    since_ms = int((now - (max(WINDOWS) + 1) * 86400) * 1000)
    for agent in ("opencode", "zcode"):
        if agent in getattr(D, "SQLITE_STORES", {}):
            summaries.update(S.sqlite_summaries(agent, lambda sql, args, a=agent: D.zcode_query(sql, args, agent=a), since_ms))
    claude_paths = sorted((p for p, s in summaries.items() if s.get("eng") == "claude-code" and s.get("mo")), key=lambda p: -summaries[p].get("mtime", 0))
    agg = aggregate(summaries, project_of=_Projects(_project_resolver()), titles=_titles(index), installed_skills=installed_skills(),
                    agent_defs=agent_definitions(), extra_billed=tab_ledger(), offered_tools=offered_tools(claude_paths))
    w30 = agg.get("30") or {}
    ds_spent = sum(b["usd"] for b in (w30.get("spend") or {}).get("billed_by") or [] if b.get("provider") == "deepseek" or "DeepSeek" in b["label"])
    import engines
    try:
        codex_pts = engines.get("codex").quota_history(now - (recent + 7) * 86400)
    except Exception:
        codex_pts = []
    res = {
        "v": PAGE_V,
        "generated_at": time.time(),
        "took": round(time.time() - t0, 1),
        "today": date.today().strftime("%Y-%m-%d"),
        "engines": ENGINE_LABELS,
        "prices_as_of": S.PRICES_AS_OF,
        "heatmap": heatmap(index, days),
        "allowance": allowance(now, recent, codex=_codex_info(), oc_quota=_oc_quota_with_at(fetch), codex_points=codex_pts, deepseek_spent=ds_spent),
        "windows": agg,
    }
    _write_json(_p("page.json"), res)
    _progress("done", started=t0)
    return res


def _refresh_lock():
    """A held lock file while one refresh runs (None when another holds it)."""
    try:
        import fcntl
    except ImportError:
        return open(os.devnull, "a")
    os.makedirs(usage_dir(), exist_ok=True)
    f = open(_p("refresh.lock"), "a")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    return f


def start_refresh():
    """Start `dispatch usage --refresh` in a process of its own unless one is running; True when one runs now."""
    p = read_progress()
    if p.get("state") == "running":
        return True
    import dplatform as P
    import subprocess
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py")
    P.spawn_detached([sys.executable, script, "usage", "--refresh", "--json"], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    _progress("running")
    return True


def page(now=None):
    """The page as last read, at once, and a refresh started when it is older than REFRESH_AFTER (or missing, or of an
    older shape). {"state": "counting", progress} when there is nothing to show yet."""
    now = now or time.time()
    res = _read_json(_p("page.json"))
    fresh = isinstance(res, dict) and res.get("v") == PAGE_V
    refreshing = read_progress().get("state") == "running"
    if not fresh or now - float(res.get("generated_at") or 0) > REFRESH_AFTER:
        refreshing = start_refresh()
    if not fresh:
        return {"v": PAGE_V, "state": "counting", "refreshing": True, "progress": read_progress()}
    res["state"] = "ready"
    res["refreshing"] = refreshing
    res["progress"] = read_progress() if refreshing else None
    return res


def command(a, dispatch_module=None):
    global D
    if dispatch_module is not None:
        D = dispatch_module
    days = max(7, min(int(getattr(a, "days", 0) or HEATMAP_DAYS), 3 * 366))
    recent = max(2, min(int(getattr(a, "recent", 0) or RECENT_DAYS), 90))
    if getattr(a, "record", False):
        new = record_now()
        res = {"ok": True, "recorded": len(new)}
        print(json.dumps(res) if a.json else "recorded %d reading(s)" % len(new))
        return 0
    if getattr(a, "refresh", False):
        lock = _refresh_lock()
        if lock is None:
            res = page()
        else:
            try:
                res = build(days, recent)
            except BaseException:
                _progress("failed")
                raise
            finally:
                lock.close()
            res["state"], res["refreshing"] = "ready", False
    else:
        res = page()

    def text(r):
        if r.get("state") == "counting":
            p = r.get("progress") or {}
            print("Counting for the first time: %s of %s transcripts read. Ask again in a minute." % (p.get("done", 0), p.get("total", "?")))
            return
        h = r["heatmap"]
        print("sessions: %d over %d active days (%s to %s), busiest day %d" % (h["total"], h["active_days"], h["from"], h["to"], h["max"]))
        for c in r["allowance"]["cards"]:
            parts = ["%s %s%%" % (k, round(c[k]["used"])) for k in ("session", "weekly") if c.get(k) and c[k].get("used") is not None]
            if c.get("balance"):
                parts.append("balance %s %s" % (c["balance"]["amount"], c["balance"]["currency"]))
            print("%-32s %-12s %s" % (c["title"], c.get("plan") or "-", " · ".join(parts) or c.get("note") or "no reading"))
        w = r["windows"]["30"]["spend"]
        print("last 30 days: %.1fB tokens, Claude Code at API prices $%.0f, billed per call $%.2f" % (w["tokens_total"] / 1e9, w["api_value"], w["billed"]))
        t = r["windows"]["30"]["tools"]["totals"]
        print("tool calls: %d, %.1f%% failed, %d kinds" % (t["calls"], 100 * t["errors"] / max(1, t["calls"]), t["distinct"]))
        if r.get("refreshing"):
            print("(refreshing in the background)")
    D.out(res, a.json, text)
    return 0
