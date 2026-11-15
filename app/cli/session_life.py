# -*- coding: utf-8 -*-
"""Session lifetime, measured from engine requests, never from billing totals.

Claude input excludes cache; Codex input includes cache. These helpers are shared
by the transcript index, chatd adapters and the lifetime meter. Terminal meters
read only complete new JSONL lines and keep an incremental, private cache.
"""
import hashlib
from lang import t as _t
import json
import os
import re
import time
from datetime import datetime

import engines as E



class _Dispatch:
    """dispatch.py, imported on first use: the lifetime hook's fast path (life_hook.py) measures a
    transcript without loading the whole CLI."""

    def __getattr__(self, name):
        import dispatch
        return getattr(dispatch, name)


D = _Dispatch()

DEFAULT_LIMIT = -1  # Automatic; keep 0 as the explicit off switch.
FALLBACK_WINDOW = 200000
WARNING_PERCENT = 80
SETTINGS = {"session_life_tokens": DEFAULT_LIMIT, "session_life_warning_percent": WARNING_PERCENT,
            "session_life_auto_handoff": 1}


def number(value):
    return max(0, int(value)) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def model_window(model, provider=""):
    """The context window of a model, from the first engine that knows it (its adapter's model_window), else 200K."""
    import engines
    for eng in engines.known():
        window = eng.model_window(str(model or ""), provider)
        if window:
            return window
    return FALLBACK_WINDOW


def claude_usage(u):
    return {k: number(u.get(src)) for k, src in (("input", "input_tokens"), ("output", "output_tokens"),
            ("cache_read", "cache_read_input_tokens"), ("cache_write", "cache_creation_input_tokens"))}


def codex_usage(u, camel=False):
    cached = number(u.get("cachedInputTokens" if camel else "cached_input_tokens"))
    return {"input": max(0, number(u.get("inputTokens" if camel else "input_tokens")) - cached),
            "cache_read": cached, "cache_write": number(u.get("cache_write_input_tokens")),
            "output": number(u.get("outputTokens" if camel else "output_tokens"))}


def read_tokens(u):
    return sum(number(u.get(k)) for k in ("input", "cache_read", "cache_write"))


def key(value, agent=""):
    value = str(value or "")
    if ":" in value:
        engine, sid = value.split(":", 1)
        import engines
        return engines.agent_of(engine) + ":" + sid.lstrip("/")
    return f"{agent}:{value}" if agent and value else value


def dispatch_dir():
    """DISPATCH_DIR the way dispatch.py reads it, without importing it (the hook's fast path)."""
    import sys
    mod = sys.modules.get("dispatch")
    if mod is not None:
        return mod.DISPATCH_DIR
    return os.environ.get("DISPATCH_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".dispatch")


def directory(base=None):
    return os.path.join(base or dispatch_dir(), "life")


SETTINGS_CACHE_SECONDS = 600


def cache_settings(settings, base=None, now=None):
    """Keep the lifetime settings where the hook's fast path can read them without `bd` (dispatch
    settings_load calls this). Rewritten when they change or the copy is half-way to stale."""
    now = now or time.time()
    path = os.path.join(directory(base), "settings.json")
    values = {k: settings.get(k, v) for k, v in SETTINGS.items()}
    old = load(path)
    if old.get("values") == values and now - (old.get("at") or 0) < SETTINGS_CACHE_SECONDS / 2:
        return
    try:
        save(path, {"at": now, "values": values})
    except OSError:
        pass


def cached_settings(base=None, now=None):
    """The lifetime settings from cache_settings, or None when missing or older than 10 minutes."""
    old = load(os.path.join(directory(base), "settings.json"))
    if not isinstance(old.get("values"), dict) or (now or time.time()) - (old.get("at") or 0) > SETTINGS_CACHE_SECONDS:
        return None
    return old["values"]


def path_for(namespace, name, base=None):
    return os.path.join(directory(base), namespace, hashlib.sha256(name.encode()).hexdigest() + ".json")


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save(path, data):
    from instructions import atomic_write
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    atomic_write(path, json.dumps(data, ensure_ascii=False))
    os.chmod(path, 0o600)


def epoch(value):
    if isinstance(value, (int, float)):
        return value / 1000 if value > 1e11 else value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return 0


class Meter:
    def __init__(self, state=None):
        self.data = {"started_at": 0, "last_at": 0, "rounds": 0, "tool_steps": 0, "messages": 0,
                     "context_tokens": None, "cumulative_read_tokens": 0, "model": "", "model_context_window": None,
                     "epoch": 0, "request_reads": {}, "seen": {}, "codex_total": 0, **(state or {})}

    def once(self, kind, ident):
        name = f"{kind}:{ident}"
        if name in self.data["seen"]:
            return False
        self.data["seen"][name] = True
        return True

    def usage(self, u, request_id="", cumulative=None, window=None):
        n = read_tokens(u)
        if not request_id or request_id not in self.data["request_reads"] or request_id == self.data.get("last_request_id"):
            self.data["context_tokens"] = n
            self.data["last_request_id"] = request_id
        if window:
            self.data["model_context_window"] = number(window)
        if cumulative is not None:
            total = read_tokens(cumulative)
            self.data["cumulative_read_tokens"] += max(0, total - self.data["codex_total"])
            self.data["codex_total"] = total
        elif request_id:
            # Streaming content blocks can repeat a request, or fill its usage in later.
            old = self.data["request_reads"].get(request_id, 0)
            self.data["cumulative_read_tokens"] += max(0, n - old)
            self.data["request_reads"][request_id] = max(n, old)

    def reset(self):
        self.data["context_tokens"] = 0
        self.data["epoch"] += 1

    def feed(self, row, agent, ordinal=0, subagent=False):
        d = self.data
        if E.get(agent).life_skips(row, subagent):
            return
        ts = epoch(row.get("timestamp"))
        if ts:
            d["started_at"] = min(d["started_at"] or ts, ts)
            d["last_at"] = max(d["last_at"], ts)
        E.get(agent).life_feed(self, row, ordinal)  # its own records: rounds, messages, tools, usage, compactions

    def snapshot(self, settings=None, now=None):
        s = {**SETTINGS, **(settings or {})}
        d = {k: v for k, v in self.data.items() if k not in ("request_reads", "seen", "codex_total")}
        raw = s["session_life_tokens"]
        configured = DEFAULT_LIMIT if raw is None or raw == DEFAULT_LIMIT else number(raw)
        win = number(d.get("model_context_window")) or model_window(d.get("model"), d.get("provider") or "")
        d["model_context_window"] = win
        limit = int(win * 0.8) if configured == DEFAULT_LIMIT else min(configured, win)
        pct = round(100 * d["context_tokens"] / limit, 1) if limit and d["context_tokens"] is not None else None
        warn = min(100, max(1, number(s["session_life_warning_percent"])))
        d.update(elapsed_seconds=max(0, int((now or time.time()) - d["started_at"])) if d["started_at"] else 0,
                 limit_tokens=limit, configured_limit_tokens=configured, percent=pct, warning_percent=warn,
                 status="unknown" if pct is None else "limit" if pct >= 100 else "warning" if pct >= warn else "ok",
                 auto_handoff=bool(s["session_life_auto_handoff"]) and bool(limit))
        return d


def transcript_meter(path, agent, base=None, subagent=False):
    """Append-only scan. Partial final lines wait for the next call, rotations rebuild."""
    import fcntl
    cache = path_for("transcripts", os.path.realpath(path) + (":subagent" if subagent else ""), base)
    os.makedirs(os.path.dirname(cache), mode=0o700, exist_ok=True)
    with open(cache + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        st = os.stat(path)
        old = load(cache)
        if old.get("inode") != st.st_ino or old.get("offset", 0) > st.st_size:
            old = {}
        meter = Meter(old.get("meter"))
        with open(path, "rb") as f:
            f.seek(old.get("offset", 0))
            while True:
                pos = f.tell()
                line = f.readline()
                if not line or not line.endswith(b"\n"):
                    offset = pos
                    break
                try:
                    row = json.loads(line)
                    if isinstance(row, dict):
                        meter.feed(row, agent, pos, subagent=subagent)
                except (ValueError, UnicodeError):
                    pass
        save(cache, {"inode": st.st_ino, "offset": offset, "meter": meter.data})
        return meter


def store_meter(sid, agent="opencode"):
    """The lifetime of a conversation kept in OpenCode's SQLite tables (OpenCode, ZCode)."""
    meter = Meter()
    for row in D.zcode_query("select id, data, time_created from message where session_id=? order by time_created, id", (sid,), agent=agent):
        try:
            msg = json.loads(row["data"])
        except (ValueError, TypeError):
            continue
        ts = epoch(row.get("time_created"))
        meter.data["started_at"] = meter.data["started_at"] or ts
        meter.data["last_at"] = ts
        meter.data["messages"] += 1
        if msg.get("role") == "user":
            meter.data["rounds"] += 1
        elif msg.get("role") == "assistant" and (msg.get("summary") is True or msg.get("mode") == "compaction"):
            # OpenCode's compaction (auto, /compact or session.summarize): a new context epoch, as
            # Claude Code's compact_boundary. Its own usage is the summarising request, not the context.
            meter.reset()
        elif msg.get("role") == "assistant":
            u = msg.get("tokens") or {}
            if u and number(u.get("input")) + number((u.get("cache") or {}).get("read")) + number((u.get("cache") or {}).get("write")):
                cache = u.get("cache") or {}
                meter.usage({"input": u.get("input"), "cache_read": cache.get("read"), "cache_write": cache.get("write")}, row["id"])
            meter.data["model"] = msg.get("modelID") or meter.data["model"]
            meter.data["provider"] = msg.get("providerID") or meter.data.get("provider") or ""
    rows = D.zcode_query("select count(*) n from part where session_id=? and json_extract(data,'$.type')='tool'", (sid,), agent=agent)
    meter.data["tool_steps"] = rows[0]["n"] if rows else 0
    return meter


def measure(target, *, transcript="", agent="", settings=None, base=None, native_session="", cwd="", subagent=False):
    target = key(target, agent)
    runtime = load(path_for("runtime", target, base))
    source = {}
    if not native_session and not transcript and runtime.get("snapshot"):
        snapshot = runtime["snapshot"]
        import ide_sessions
        native = ide_sessions.transcript_key(target) or snapshot.get("native_session")
        if native:
            fresh = measure(target, native_session=native, cwd=snapshot.get("cwd", ""), settings=settings, base=base)
            if fresh["context_tokens"] is not None:
                contexts = dict(runtime.get("native_contexts") or {})
                contexts[native] = fresh
                totals = {k: sum(number(c.get(k)) for c in contexts.values()) for k in ("rounds", "tool_steps", "cumulative_read_tokens")}
                starts = [c["started_at"] for c in contexts.values() if c.get("started_at")]
                started = min(starts) if starts else fresh["started_at"]
                return {**fresh, **totals, "messages": snapshot.get("messages", fresh["messages"]), "started_at": started,
                        "elapsed_seconds": max(0, int(time.time() - started)) if started else 0}
        return {**snapshot, **Meter(snapshot).snapshot(settings if settings is not None else D.settings_load()), "usage_source": "cached"}
    if not transcript and runtime.get("meter"):
        return dict(Meter(runtime["meter"]).snapshot(settings if settings is not None else D.settings_load()),
                    session=target, native_session=runtime.get("native_session", target), source="chatd", cwd=runtime.get("cwd", ""))
    head, _, own_id = target.partition(":")
    owner = E.find(head)
    if not transcript and owner and agent in ("", owner.agent) and not native_session and owner.database and owner.owns_session_id(own_id):
        # an engine's own session in its database (OpenCode's plugin's turn-end hook). Looking the id up through chatd
        # (agent_switch.find_source) cost ten seconds when chatd was not up.
        source = {"key": target, "agent": owner.agent, "cwd": cwd, "source": owner.agent}
        native, agent = target, owner.agent
    elif not transcript:
        import agent_switch
        source = ({"key": target, "agent": native_session.split(":", 1)[0], "cwd": cwd, "source": "ide"}
                  if native_session else agent_switch.find_source(target))
        target = source["key"]
        agent = source["agent"]
        if not native_session and load(path_for("runtime", target, base)):
            return measure(target, settings=settings, base=base)
        import ide_sessions
        native = native_session or (ide_sessions.transcript_key(target) if source.get("source") == "ide" else None)
        native = native or target
        refs = D.resolve(D.load_index(), native)
        if refs:
            # resolve returns entries; paths live in the index keys.
            transcript = refs[0].get("path", "")
        if not transcript and not E.get(agent).database:
            paths = E.get(agent).transcript_of(native.split(":", 1)[-1], D.HOME, source.get("cwd", "")) or []
            transcript = next((p for p in paths if p and os.path.isfile(p)), "")
    else:
        native = target
        agent = agent or target.split(":", 1)[0]
    meter = (store_meter(native.split(":", 1)[-1], agent) if agent in D.SQLITE_STORES else
             transcript_meter(transcript, agent, base, subagent=subagent) if transcript and os.path.isfile(transcript) else Meter())
    return dict(meter.snapshot(settings if settings is not None else D.settings_load()), session=target,
                native_session=native, source=source.get("source", "transcript"), transcript=transcript, cwd=source.get("cwd", ""))


def context_breakdown(native, base=None):
    """What fills a Claude Code session's context window by kind, as its CLI counted it after the last turn (the data
    behind /context; Dispatch IDE's agent host writes it: platform/agentHost/node/claude/dispatchContextUsage.ts).
    {} for other engines (nothing writes theirs) and before the first turn."""
    sid = (native or "").split(":", 1)[-1]
    if not re.fullmatch(r"[\w-]{6,100}", sid):
        return {}
    return load(os.path.join(base or dispatch_dir(), "context-usage", sid + ".json"))


def command(a):
    if not a.target:
        raise ValueError(_t("Usage: dispatch session life <session> [--json]", "用法：dispatch session life <会话> [--json]"))
    r = measure(a.target)
    import handoff
    r.update(handoff.life_fields(*dict.fromkeys(k for k in (key(a.target), r.get("session")) if k)))
    r["breakdown"] = next(filter(None, (context_breakdown(k) for k in (r.get("native_session"), r.get("session"), a.target))), {})
    def life_text(d):
        if _t("en", "zh") == "en":
            return (f"{d['session']}\nrunning {d['elapsed_seconds']} s · {d['rounds']} rounds · {d['tool_steps']} tool steps\n"
                    f"context now {d['context_tokens'] if d['context_tokens'] is not None else 'unknown'} tokens · read so far {d['cumulative_read_tokens']} tokens\n"
                    f"{d['percent'] if d['percent'] is not None else 'unknown'}% of the limit · limit {d['limit_tokens']} tokens · {d['status']}"
                    + ("\nThe transcript is not available now; showing the latest snapshot." if d.get('usage_source') == 'cached' else "")
                    + (f"\nHandoff: {d['handoff_state']} ({d['handoff_phase']})" if d.get('handoff_state') else "")
                    + (f"\n{len(d['handoffs'])} handoffs, the latest {d['handoffs'][-1]['path']}" if d.get('handoffs') else ""))
        return (f"{d['session']}\n已跑 {d['elapsed_seconds']} 秒 · {d['rounds']} 轮 · {d['tool_steps']} 工具步\n"
                f"当前上下文 {d['context_tokens'] if d['context_tokens'] is not None else '未知'} token · 累计读入 {d['cumulative_read_tokens']} token\n"
                f"到线 {d['percent'] if d['percent'] is not None else '未知'}% · 线 {d['limit_tokens']} token · {d['status']}"
                + ("\n当前转录不可用，显示最近快照。" if d.get('usage_source') == 'cached' else "")
                + (f"\n交接：{d['handoff_state']}（{d['handoff_phase']}）" if d.get('handoff_state') else "")
                + (f"\n交接 {len(d['handoffs'])} 份，最新 {d['handoffs'][-1]['path']}" if d.get('handoffs') else ""))
    D.out(r, a.json, lambda d: print(life_text(d)))
