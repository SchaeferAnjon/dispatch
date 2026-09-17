"""One-paragraph summary of a conversation, written by a model (`dispatch session-summary`).

Uses whatever chat API key `dispatch env` already holds — DeepSeek, 智谱 GLM, Kimi,
MiniMax, OpenAI — through the OpenAI-compatible chat endpoint each of them offers, or the
Claude Code subscription through `claude -p` (`SUMMARY_MODEL=claude:haiku`).
`SUMMARY_MODEL=<provider>:<model>` in `dispatch env` picks one explicitly. The result is
stored in the session's preferences (next to starred/archived), so every view shows it
and it is not recomputed until the conversation moves on.
"""
import json, os, subprocess, sys, time, urllib.error, urllib.request

import dispatch as D

PROVIDERS = [
    # env key, provider id, base url, default model — first available wins unless SUMMARY_MODEL says otherwise.
    # 智谱 first: a cheap, fast model is what this kind of housekeeping needs.
    # The key is on the GLM Coding Plan: its quota lives behind /api/coding/paas/v4. The pay-as-you-go
    # endpoint (/api/paas/v4) answers 429 code 1113 「余额不足」 for the same key — not a money problem.
    ("ZHIPU_API_KEY", "zhipu", "https://open.bigmodel.cn/api/coding/paas/v4", "glm-5.3-flash"),
    ("DEEPSEEK_API_KEY", "deepseek", "https://api.deepseek.com/v1", "deepseek-chat"),
    ("KIMI_API_KEY", "kimi", "https://api.moonshot.cn/v1", "moonshot-v1-8k"),
    ("MINIMAX_API_KEY", "minimax", "https://api.minimax.chat/v1", "MiniMax-Text-01"),
    ("OPENAI_API_KEY", "openai", "https://api.openai.com/v1", "gpt-4.1-mini"),
]
PROMPT = ("你是会话记录的总结者。下面是用户和一个编程 Agent 的对话摘录。用简体中文写一段不超过 120 字的总结，三层意思按顺序连成一段话：用户想要什么；Agent 实际做了什么、结果如何；还没做完或在等用户的事（没有就不写）。"
          "只写事实，不评价，不用「用户」「Agent」之外的称呼，不加标题、不用列表、不用引号。")

# Nothing is sent to a model until the person says so (first-run setup → 「模型与总结」, or 设置 →
# 总结): every use that runs on its own defaults to off. 「讨论结论」 stays on because a discussion
# only exists when the person started one, and its text already went to the agents in it.
SUMMARY_USES = [
    ("session", "会话总结", "一轮结束后给会话写一段摘要，显示在工作台/会话列表/项目页", 0),
    ("project", "项目现状", "项目页「现状」那段话", 0),
    ("here", "dispatch here", "在终端跑 dispatch here 时的现状与结论", 0),
    ("discuss", "讨论结论", "多 Agent 讨论后由 leader 写的结论与文档", 1),
    ("insights", "洞察报告", "跨 Agent 的 /insights 复盘报告", 0),
    ("memories", "记忆总结", "Agent 记忆页的总体与项目总结", 0),
    ("profile_inventory", "设备盘点", "把各机器实测写成人话", 0),
    ("semantic", "语义搜索索引", "wiki 语义搜索的 embedding（发任务标题、描述和知识库条目给 OpenAI 或智谱）", 0),
]
DEFAULT_USES = {k: d for k, _, _, d in SUMMARY_USES}


def retired_providers():
    """Providers the person told Dispatch to stop picking on its own (设置 → 总结, a comma list):
    never the default nor a fallback; an explicit summary_model still works. Empty by default."""
    try:
        raw = D.settings_load().get("retired_providers") or ""
    except Exception:
        raw = ""
    return {x.strip().lower() for x in str(raw).replace("，", ",").split(",") if x.strip()}


def use_name(key):
    return next((n for k, n, _, _ in SUMMARY_USES if k == key), key)


def gate_message(key):
    return f"「{use_name(key)}」没开：它要把内容发给模型，所以默认关着；在 设置 → 总结 里打开"


def use_enabled(key):
    """A use is on unless the shared setting says otherwise; session falls back to the old summary_auto."""
    s = D.settings_load()
    uses = s.get("summary_uses") or {}
    if key in uses:
        return bool(uses[key])
    if key == "session" and "summary_auto" in s:
        return bool(s["summary_auto"])
    return bool(DEFAULT_USES.get(key, 1))


USAGE_FILE = "summary-usage.json"


def usage_path():
    return os.path.join(D.DISPATCH_DIR, USAGE_FILE)


def usage_load():
    try:
        with open(usage_path(), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def record_use(use, tokens, model):
    """Remember the last model call per use. Best-effort: a logging failure never breaks the call."""
    if not use:
        return
    try:
        data = usage_load()
        data[use] = {"at": int(time.time()), "tokens": int(tokens or 0), "model": model or ""}
        os.makedirs(D.DISPATCH_DIR, exist_ok=True)
        with open(usage_path(), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception:
        pass


CLAUDE_BIN = next((p for p in (os.path.join(D.HOME, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude") if os.path.exists(p)), "")
PROVIDER_ENV = {p: key for key, p, _, _ in PROVIDERS}
PROVIDER_LABELS = {"zhipu": "智谱", "deepseek": "DeepSeek", "kimi": "Kimi", "minimax": "MiniMax", "openai": "OpenAI"}


def provider(model=""):
    """Which model writes summaries. `SUMMARY_MODEL=claude:haiku` (or sonnet / a full model id)
    runs `claude -p` on the Claude Code subscription — no API key, counts against its usage
    limits, a few seconds per call. Otherwise the first API key found, 智谱 first.

    `model` (provider:model) forces one for this call, before the shared setting (`dispatch here
    --summary-model`)."""
    env = {i["name"]: i["value"] for i in D.env_read()}
    # An explicit request wins, then the app's 设置 (shared through the board), then the env file,
    # then whatever is available.
    pick = (model or "").strip() or (D.settings_load().get("summary_model") or "").strip() or env.get("SUMMARY_MODEL", "")
    if pick and ":" in pick:
        pid, model = pick.split(":", 1)
        if pid == "claude" and CLAUDE_BIN:
            return {"id": "claude", "base": "", "model": model or "haiku", "key": ""}
        for key, p, base, _ in PROVIDERS:
            if p == pid and env.get(key):
                return {"id": p, "base": base, "model": model, "key": env[key]}
    for key, p, base, model in PROVIDERS:
        if env.get(key) and p not in retired_providers():
            return {"id": p, "base": base, "model": model, "key": env[key]}
    if CLAUDE_BIN:
        return {"id": "claude", "base": "", "model": "haiku", "key": ""}
    return None


def providers():
    """Every model the settings page can offer: the Claude subscription (when the CLI is installed)
    and each API key in `dispatch env`, with the default model each one gets."""
    env = {i["name"]: i["value"] for i in D.env_read()}
    out = []
    if CLAUDE_BIN:
        out += [{"id": "claude:haiku", "label": "Claude Haiku（订阅，最省）"}, {"id": "claude:sonnet", "label": "Claude Sonnet（订阅）"}]
    for key, p, base, model in PROVIDERS:
        if env.get(key):
            out.append({"id": f"{p}:{model}", "label": f"{model}（{p}，API Key）"})
    return out


def model_catalog():
    """Every model the settings page can pick — Claude subscription first, then each provider —
    with its env key and whether it is usable on this machine right now."""
    env = {i["name"]: i["value"] for i in D.env_read()}
    rows = [{"id": f"claude:{m}", "provider": "claude", "label": lbl, "env": "", "configured": bool(CLAUDE_BIN), "model": m, "subscription": True}
            for m, lbl in (("haiku", "Claude Haiku（订阅）"), ("sonnet", "Claude Sonnet（订阅）"))]
    for key, p, base, model in PROVIDERS:
        rows.append({"id": f"{p}:{model}", "provider": p, "label": f"{model}（{PROVIDER_LABELS.get(p, p)}）", "env": key,
                     "configured": bool(env.get(key)), "model": model, "subscription": False})
    return rows


def auto(limit=2):
    """Summarize the conversations a person will actually look at, newest first, a few per call:
    fresh replies get a summary within minutes; older sessions fill in over time. Skips scheduled
    and archived sessions and anything summarized since it last changed."""
    from activity import session_preferences, set_preferences
    if not use_enabled("session"):
        return {"done": [], "tried": 0, "skipped": True, "reason": gate_message("session")}
    prefs = session_preferences(D.DISPATCH_DIR)
    idx = D.load_index() or D.refresh_index()
    rows = [(k, e) for k, e in idx.items() if not e.get("subagent") and (e.get("user_msgs") or 0) > 0 and e.get("agent") in ("claude-code", "codex", "pi", "zcode", "opencode", "hermes") and not (e.get("agent") == "hermes" and e.get("entrypoint") == "cron")]
    rows.sort(key=lambda kv: kv[1].get("mtime", 0), reverse=True)
    done, tried = [], 0
    for path, e in rows:
        key = f"{e['agent']}:{e['session_id']}"
        pr = prefs.get(key, {})
        if pr.get("scheduled") or pr.get("archived"):
            continue
        if pr.get("summary") and pr.get("summary_mtime") == e.get("mtime"):
            continue
        if not pr.get("summary") and time.time() - (e.get("mtime") or 0) > 60 * 86400:
            break  # older than two months without a summary: not worth the calls
        tried += 1
        try:
            r = summarize(key, force=bool(pr.get("summary")))
            set_preferences(D.DISPATCH_DIR, key, {"summary_mtime": e.get("mtime")})
            done.append({"key": key, "summary": r["summary"][:80], "cached": r.get("cached", False)})
        except QuotaExhausted as ex:
            done.append({"key": key, "error": str(ex)[:200]})
            return {"done": done, "tried": tried, "unread": [], "quota": str(ex)[:300]}
        except Exception as ex:
            done.append({"key": key, "error": str(ex)[:160]})
        if len(done) >= limit:
            break
    unread = auto_unread(limit)
    return {"done": done, "tried": tried, "unread": unread}


UNREAD_PROMPT = ("你是会话记录的总结者。用户消息里「摘录开始」和「摘录结束」之间，是一个编程 Agent 在用户上一条消息之后这一轮说的话；标着【最终回复】的那段是它最后给用户的回复，前面的只是过程中的进度说明。"
                 "用简体中文把【最终回复】的内容压缩成不超过 80 字的一段：它告诉用户什么结论或结果、要用户做什么（没有就不写）。不要写它调用了几次工具、跑了几条命令这类过程；进度说明只在最终回复没说清时才参考。摘录再短也按它写，不要说看不到内容、不要索要材料。只写事实，不评价，不加标题、不用列表、不用引号。")


def _msg_epoch(m):
    try:
        from datetime import datetime as _dt
        return _dt.fromisoformat((m.get("ts") or "").replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0


def unread_turn(msgs, reply_at=None):
    """The Agent's side of the turn that ended with the unread reply (at `reply_at`, epoch s; default
    the latest): every assistant text after the person's message that started it, with the tools it
    called, oldest first. Empty when there is no assistant text in that turn."""
    last_user = -1
    for i, m in enumerate(msgs):
        if m.get("role") == "user" and (m.get("text") or "").strip() and (reply_at is None or _msg_epoch(m) <= reply_at + 1):
            last_user = i
    parts = []
    for m in msgs[last_user + 1:]:
        if m.get("role") != "assistant":
            continue
        if reply_at is not None and _msg_epoch(m) > reply_at + 2:
            break
        if (m.get("text") or "").strip():
            parts.append(m["text"].strip())
    if not parts:
        return ""
    # The last text is the reply the person reads; earlier ones are progress notes along the way.
    final = parts[-1][:3000]
    notes = "\n".join(p[:300] for p in parts[:-1])[-2500:]
    return (f"（过程中的进度说明）\n{notes}\n\n" if notes else "") + "【最终回复】\n" + final


def summarize_unread(key, reply_id, force=False):
    """A digest of what the Agent did since the person's last message — what an unread reply
    means — cached per reply id in the session's preferences."""
    from activity import set_preferences, session_preferences
    if not use_enabled("session"):
        raise RuntimeError(gate_message("session"))
    p = provider()
    if not p:
        raise RuntimeError("没有可用的模型")
    prefs = session_preferences(D.DISPATCH_DIR).get(key, {})
    if not force and prefs.get("unread_summary") and prefs.get("unread_summary_reply") == reply_id:
        return {"key": key, "unread_summary": prefs["unread_summary"], "cached": True}
    r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), "session", key, "--json"], capture_output=True, text=True, timeout=120, env={**os.environ, "BEADS_DIR": D.BEADS_DIR})
    if r.returncode != 0:
        raise RuntimeError(f"读不到会话：{(r.stderr or r.stdout).strip()[-200:]}")
    d = json.loads(r.stdout[r.stdout.find("{"):])
    try:
        reply_at = float(str(reply_id).split(":")[0])
    except ValueError:
        reply_at = None
    excerpt = unread_turn(d.get("messages") or [], reply_at)
    if not excerpt.strip():
        raise RuntimeError("这一轮还没有可总结的回复")
    meta = d.get("meta", {})
    text = chat(p, UNREAD_PROMPT, f"会话标题：{meta.get('title', '')}\n\n【摘录开始】\n{excerpt}\n【摘录结束】\n\n请写这一轮的摘要。", use="session")
    text = text.strip().strip('"“”').replace("\n", " ")[:240]
    if not text:
        raise RuntimeError("模型没有返回内容")
    data = set_preferences(D.DISPATCH_DIR, key, {"unread_summary": text, "unread_summary_reply": reply_id, "unread_summary_at": int(time.time()), "unread_summary_by": f"{p['id']}:{p['model']}"})
    return {"key": key, "unread_summary": data["unread_summary"], "cached": False}


def auto_unread(limit=3):
    """For every unread reply without a digest yet: write one (newest first, a few per call)."""
    from activity import activity_list, session_preferences
    if not use_enabled("session"):
        return []
    idx = D.load_index() or {}
    # Only conversations the index knows (Dispatch's own headless runs and sub-agents are not in it).
    rows = [a for a in activity_list(D.HOME, D.DISPATCH_DIR, idx) if a.get("unread") and a.get("reply_id") and not a.get("scheduled") and not a.get("archived") and a.get("path") in idx and not idx[a["path"]].get("subagent")]
    rows.sort(key=lambda a: -(a.get("reply_at") or 0))
    prefs = session_preferences(D.DISPATCH_DIR)
    done = []
    for a in rows:
        key = a["key"]
        if (prefs.get(key) or {}).get("unread_summary_reply") == a["reply_id"]:
            continue
        try:
            r = summarize_unread(key, a["reply_id"])
            done.append({"key": key, "unread_summary": r["unread_summary"][:80]})
        except Exception as ex:
            done.append({"key": key, "error": str(ex)[:160]})
        if len(done) >= limit:
            break
    return done


def transcript_excerpt(key, limit=12000):
    """User messages in full (trimmed) and the last reply of each turn, oldest first."""
    r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), "session", key, "--json"], capture_output=True, text=True, timeout=120, env={**os.environ, "BEADS_DIR": D.BEADS_DIR})
    if r.returncode != 0:
        raise RuntimeError(f"读不到会话：{(r.stderr or r.stdout).strip()[-200:]}")
    d = json.loads(r.stdout[r.stdout.find("{"):])
    msgs = d.get("messages") or []
    turns, last_reply = [], None
    for m in msgs:
        if m.get("role") == "user" and m.get("text", "").strip():
            if last_reply:
                turns.append(("Agent", last_reply)); last_reply = None
            turns.append(("用户", m["text"].strip()))
        elif m.get("role") == "assistant" and m.get("text", "").strip():
            last_reply = m["text"].strip()
    if last_reply:
        turns.append(("Agent", last_reply))
    # Keep the beginning and the end when it is long: the goal and the outcome matter most.
    parts = [f"{who}：{text[:700]}" for who, text in turns]
    text = "\n\n".join(parts)
    if len(text) > limit:
        head, tail = text[: limit // 3], text[-(limit * 2 // 3):]
        text = head + "\n\n……（中间省略）……\n\n" + tail
    return text, d.get("meta", {}), (d.get("reply_id") or d.get("activity_version") or "")


class QuotaExhausted(RuntimeError):
    """The provider refused for money/rate reasons (429 / 402, 「余额不足」): retrying the same
    key later changes nothing; another configured key might."""


def _quota_error(code, body):
    text = (body or "")[:300]
    return code in (402, 429) or "余额" in text or "insufficient" in text.lower() or "quota" in text.lower()


def fallback_providers(p):
    """Other API-key providers, in PROVIDERS order, that could write this summary instead of `p`.
    The Claude subscription is never picked up silently — it is only used when chosen."""
    env = {i["name"]: i["value"] for i in D.env_read()}
    return [{"id": pid, "base": base, "model": model, "key": env[key]}
            for key, pid, base, model in PROVIDERS if env.get(key) and pid != p.get("id") and pid not in retired_providers()]


def chat(p, system, user, timeout=90, max_tokens=None, use=None):
    """One completion. When the provider is out of balance, the next configured API key takes
    over for this call and `p` is updated in place, so the caller records the model that actually
    wrote the text. All out of balance: QuotaExhausted names them."""
    try:
        return _chat(p, system, user, timeout, max_tokens, use)
    except QuotaExhausted as first:
        errors = [str(first)]
        for q in fallback_providers(p):
            try:
                text = _chat(q, system, user, timeout, max_tokens, use)
            except QuotaExhausted as e:
                errors.append(str(e))
                continue
            p.update(q)
            return text
        raise QuotaExhausted("；".join(errors))


def _chat(p, system, user, timeout=90, max_tokens=None, use=None):
    if p["id"] == "claude":
        # Headless Claude Code: the prompt is the system text, the transcript comes on stdin.
        # Strip the session markers so a summary started from inside a Claude session still saves nothing odd.
        env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}
        env["PATH"] = D.PATH_EXTRA + ":" + env.get("PATH", "")
        # --no-session-persistence: a summary run must not leave a transcript behind — otherwise every run
        # becomes a new "session" under ~ that floods the index (pushing real projects out of the app's
        # newest-500 window) and then gets summarized itself, on the subscription's quota, for ever.
        r = subprocess.run([CLAUDE_BIN, "-p", system, "--model", p["model"], "--output-format", "text", "--tools", "", "--no-session-persistence"], input=user, capture_output=True, text=True, timeout=timeout + 60, env=env, cwd=D.HOME)
        if r.returncode != 0 and not r.stdout.strip():
            raise RuntimeError("claude -p 失败：" + (r.stderr or "").strip()[-200:])
        record_use(use, 0, f"{p['id']}:{p['model']}")
        return r.stdout.strip()
    req_body = {"model": p["model"], "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}], "temperature": 0.2, "max_tokens": max_tokens or 400}
    if p["id"] == "zhipu" and p["model"].startswith("glm-5"):
        # GLM-5 always reasons and spends max_tokens on it; ask for as little as it allows.
        req_body["reasoning_effort"] = "low"; req_body["max_tokens"] = max_tokens or 1200
    body = json.dumps(req_body).encode()
    req = urllib.request.Request(p["base"].rstrip("/") + "/chat/completions", data=body, headers={"Content-Type": "application/json", "Authorization": f"Bearer {p['key']}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        if _quota_error(e.code, detail):
            raise QuotaExhausted(f"{PROVIDER_LABELS.get(p['id'], p['id'])} 拒绝（HTTP {e.code}）：{detail[:120] or '余额或额度不足'}")
        raise
    record_use(use, (d.get("usage") or {}).get("total_tokens") or 0, f"{p['id']}:{p['model']}")
    return (d.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()


def summarize(key, force=False):
    from activity import set_preferences, session_preferences
    if not use_enabled("session"):
        raise RuntimeError(gate_message("session"))
    p = provider()
    if not p:
        raise RuntimeError("没有可用的模型：装了 Claude Code 就能用订阅（SUMMARY_MODEL=claude:haiku），或在 dispatch env 里放 DEEPSEEK_API_KEY / ZHIPU_API_KEY / KIMI_API_KEY / MINIMAX_API_KEY / OPENAI_API_KEY 之一")
    excerpt, meta, version = transcript_excerpt(key)
    if meta.get("agent") and meta.get("session_id"):
        key = f"{meta['agent']}:{meta['session_id']}"  # the full key preferences are stored under
    if not excerpt.strip():
        raise RuntimeError("这段会话还没有可总结的内容")
    prefs = session_preferences(D.DISPATCH_DIR).get(key, {})
    if not force and prefs.get("summary") and prefs.get("summary_version") == version:
        return {"key": key, "summary": prefs["summary"], "cached": True, "provider": prefs.get("summary_by", "")}
    text = chat(p, PROMPT, f"会话标题：{meta.get('title', '')}\n项目目录：{meta.get('cwd', '')}\n\n{excerpt}", use="session")
    text = text.strip().strip('"“”').replace("\n", " ")[:300]
    if not text:
        raise RuntimeError("模型没有返回内容")
    mtime = next((e.get("mtime") for e in (D.load_index() or {}).values() if f"{e.get('agent')}:{e.get('session_id')}" == key and not e.get("subagent")), None)
    data = set_preferences(D.DISPATCH_DIR, key, {"summary": text, "summary_at": int(time.time()), "summary_version": version, "summary_by": f"{p['id']}:{p['model']}", "summary_mtime": mtime})
    return {"key": key, "summary": data["summary"], "cached": False, "provider": data["summary_by"]}


def main(a):
    if a.op == "providers":
        res = {"providers": providers(), "current": (D.settings_load().get("summary_model") or "")}
        print(json.dumps(res, ensure_ascii=False, indent=2) if a.json else "\n".join(f"{x['id']:<28} {x['label']}" for x in res["providers"]))
        return
    if a.op == "auto":
        res = auto(a.limit)
        print(json.dumps(res, ensure_ascii=False, indent=2) if a.json else (res.get("reason") or "\n".join(f"{d['key'][:28]}  {d.get('summary') or d.get('error')}" for d in res["done"]) or "没有需要总结的会话"))
        return
    if a.op == "unread":
        from activity import activity_list
        row = next((x for x in activity_list(D.HOME, D.DISPATCH_DIR, D.load_index() or {}) if x["key"] == a.key or x["session_id"] == a.key), None)
        if not row or not row.get("reply_id"):
            print(json.dumps({"error": "这个会话没有待读的回复"}, ensure_ascii=False) if a.json else "✗ 这个会话没有待读的回复")
            sys.exit(1)
        try:
            res = summarize_unread(row["key"], row["reply_id"], force=a.force)
        except Exception as e:
            print(json.dumps({"error": str(e)}, ensure_ascii=False) if a.json else f"✗ {e}")
            sys.exit(1)
        print(json.dumps(res, ensure_ascii=False, indent=2) if a.json else res["unread_summary"])
        return
    if a.op == "provider":
        p = provider()
        res = {"available": bool(p), **({"id": p["id"], "model": p["model"]} if p else {}), "hint": "" if p else "装了 Claude Code 就能用订阅（SUMMARY_MODEL=claude:haiku），或在 dispatch env 里放 DEEPSEEK_API_KEY / ZHIPU_API_KEY / KIMI_API_KEY / MINIMAX_API_KEY / OPENAI_API_KEY 之一；SUMMARY_MODEL=provider:model 可指定"}
    else:
        try:
            res = summarize(a.key, force=a.force)
        except Exception as e:
            print(json.dumps({"error": str(e)}, ensure_ascii=False) if a.json else f"✗ {e}")
            sys.exit(1)
    print(json.dumps(res, ensure_ascii=False, indent=2) if a.json else (res.get("summary") or json.dumps(res, ensure_ascii=False)))


def cli(a):
    """`dispatch summarize providers|set-key|uses`: the settings page's model picker and use table."""
    op = getattr(a, "op", "providers") or "providers"
    if op == "providers":
        res = {"current": (D.settings_load().get("summary_model") or ""), "providers": model_catalog()}
        if a.json:
            print(json.dumps(res, ensure_ascii=False, indent=2))
        else:
            print(f"当前：{res['current'] or '自动选择'}")
            for x in res["providers"]:
                print(f"{x['id']:<28} {x['label']:<22} {'已配置' if x['configured'] else '未配置'}")
        return
    if op == "set-key":
        env_key = PROVIDER_ENV.get(getattr(a, "provider", "") or "")
        if not env_key:
            print("set-key 需要一个 API Key 提供方：zhipu | deepseek | kimi | minimax | openai（claude 是订阅，不用 Key）", file=sys.stderr)
            sys.exit(2)
        key = sys.stdin.read().strip()
        if not key:
            print("没有从 stdin 读到 Key", file=sys.stderr)
            sys.exit(2)
        items = D.env_read()
        hit = next((it for it in items if it["name"] == env_key), None)
        if hit:
            hit["value"] = key
        else:
            items.append({"name": env_key, "value": key, "note": f"{PROVIDER_LABELS.get(a.provider, a.provider)} API Key", "project": ""})
        D.env_write(items)
        res = {"ok": True, "provider": a.provider, "env": env_key, "configured": True}
        print(json.dumps(res, ensure_ascii=False) if a.json else f"已保存 {env_key}（值不显示）")
        return
    if op == "uses":
        usage = usage_load()
        res = [{"key": k, "name": n, "desc": d, "enabled": use_enabled(k), "last": usage.get(k) or None} for k, n, d, _ in SUMMARY_USES]
        if a.json:
            print(json.dumps(res, ensure_ascii=False, indent=2))
        else:
            for x in res:
                last = x["last"] or {}
                when = time.strftime("%m-%d %H:%M", time.localtime(last["at"])) if last.get("at") else "从未"
                print(f"{'✓' if x['enabled'] else '✗'} {x['name']:<12} {x['desc']}（上次：{when}）")
        return
    print(f"未知操作：{op}", file=sys.stderr)
    sys.exit(2)


# ---------------------------------------------------------------- project summary: the whole project in a paragraph

PROJECT_PROMPT = ("你是项目记录的总结者。下面是一个项目的材料：最近的会话总结（每段会话一条）、任务板上未完成和最近完成的任务。用简体中文写一段不超过 200 字的项目总结，四层意思按顺序连成一段话："
                  "这个项目是什么；现在做到哪了；最近在做什么、结果如何；还差什么或下一步。只写事实，不评价，不用「用户」「Agent」之外的称呼，不加标题、不用列表、不用引号。")


def project_material(name):
    """What the model reads: this project's session summaries (or first prompts), open tasks, recent closes."""
    from activity import session_preferences
    prefs = session_preferences(D.DISPATCH_DIR)
    names = D.project_names()
    roots = D.settings_load().get("workspace_roots") or []
    idx = D.load_index() or D.refresh_index()
    by_cwd = {}
    sessions = []
    for k, e in idx.items():
        if e.get("subagent") or not e.get("user_msgs"):
            continue
        cwd = (e.get("cwd") or "").rstrip("/")
        if cwd not in by_cwd:
            by_cwd[cwd] = D.project_of_cwd(cwd, names, roots).lower() == name.lower() if cwd else False
        if not by_cwd[cwd]:
            continue
        key = f"{e['agent']}:{e['session_id']}"
        pr = prefs.get(key, {})
        if pr.get("scheduled") or pr.get("archived"):
            continue
        sessions.append((e.get("mtime", 0), time.strftime("%Y-%m-%d", time.localtime(e.get("mtime", 0))), pr.get("summary") or (e.get("title") or "") + "：" + (e.get("first_prompt") or "")[:200]))
    sessions.sort(reverse=True)
    lines = [f"[{d}] {t}" for _, d, t in sessions[:20] if t.strip(" ：")]
    code, o, _ = D.sh(["bd", "list", "--all", "--json"])
    open_t, closed_t = [], []
    try:
        for it in (json.loads(o[o.find("["):]) if code == 0 else []):
            if not any(l.lower() == f"project:{name.lower()}" for l in it.get("labels") or []):
                continue
            if it.get("status") == "closed":
                closed_t.append((it.get("closed_at") or "", f"{it.get('title', '')}｜{(it.get('close_reason') or '')[:120]}"))
            elif it.get("status") not in ("tombstone",):
                open_t.append(f"[{it.get('status')}] {it.get('title', '')}")
    except Exception:
        pass
    closed_t.sort(reverse=True)
    return {"sessions": len(sessions), "open": len(open_t), "closed": len(closed_t),
            "text": "## 最近的会话\n" + "\n".join(lines) + "\n\n## 未完成的任务\n" + "\n".join(open_t[:15]) + "\n\n## 最近完成的任务\n" + "\n".join(t for _, t in closed_t[:10])}


PROJECT_SUMMARY_REMOTE_TTL = 300


def _summary_trusted(rec, has_dir):
    """Whether a stored summary was (or, read on this host right now, effectively still is)
    written by a Mac that actually had material for the project — never a guess made from bare
    task titles alone. New records always carry `trusted` explicitly (set when they are written);
    a legacy record from before this existed has no marker at all, and the only signal left for
    one of those is whether the host serving it right now has the project's own directory —
    that is what `bd memories` turned out NOT to make safe to assume across Macs (each Mac's copy
    of a key can drift; a summary one Mac wrote blind can sit under the same key on another Mac
    indefinitely, never invalidated by the good one existing elsewhere)."""
    if rec is None:
        return False
    if "trusted" in rec:
        return bool(rec["trusted"])
    return has_dir


def fetch_remote_summary(name):
    """This host has neither the project's directory nor any of its sessions — ask every other
    Mac in hosts.json for its OWN project summary (`--local` so that Mac answers only for
    itself and never asks a third one back — one hop, no recursion) and take the newest one that
    is actually trusted. Never adopts another Mac's guess just because it answered first."""
    best = None
    for h in D.hosts():
        r = D.remote_dispatch(h, ["project-summary", name, "--local", "--json"], PROJECT_SUMMARY_REMOTE_TTL, timeout=20, background=True)
        if not isinstance(r, dict) or not r.get("summary") or not r.get("trusted"):
            continue
        if best is None or (r.get("at") or 0) > (best.get("at") or 0):
            best = dict(r, from_host=h.get("id", ""), from_host_name=h.get("name", ""))
    return best


def project_summary(name, force=False, if_stale=False, model="", use="project", local_only=False):
    if not use_enabled(use):
        raise RuntimeError(gate_message(use))
    key = D.INTERNAL_MEMORY_PREFIX + "project-summary-" + name
    code, o, _ = D.sh(["bd", "memories", "--json"])
    old = None
    try:
        raw = json.loads(o[o.find("{"):]).get(key) if code == 0 else None
        old = json.loads(raw) if raw else None
    except (ValueError, AttributeError):
        old = None
    has_dir = bool(D.project_home(name))
    trusted_old = _summary_trusted(old, has_dir)
    p = provider(model)
    want = f"{p['id']}:{p['model']}" if p else ""
    other_model = bool(old and want and old.get("by") != want)
    if trusted_old and old and not force and not other_model and not (if_stale and time.time() - old.get("at", 0) > 86400):
        return {**old, "trusted": True, "cached": True}
    if if_stale and not force and old is None and not D.settings_load().get("summary_auto", 1):
        return {"summary": "", "cached": True}
    m = project_material(name)
    if not m["sessions"] and not m["open"] and not m["closed"]:
        raise RuntimeError("这个项目还没有会话或任务")
    # A Mac that has never had this project's own directory has no session material for it
    # either (project_material only sees sessions whose cwd resolved to this project) — it must
    # not write a summary blind to what actually happened, from bare task titles alone.
    have_material = bool(m["sessions"]) or has_dir
    if not have_material:
        if not local_only:
            remote = fetch_remote_summary(name)
            if remote:
                rec = {"summary": remote["summary"], "at": remote.get("at") or int(time.time()),
                       "by": remote.get("by", ""), "sessions": remote.get("sessions", 0),
                       "open": remote.get("open", 0), "closed": remote.get("closed", 0),
                       "trusted": True, "material_sessions": remote.get("material_sessions", 0),
                       "from_host": remote.get("from_host", ""), "from_host_name": remote.get("from_host_name", "")}
                D.wiki_store(key, json.dumps(rec, ensure_ascii=False))
                return {**rec, "cached": False}
        # No peer answered with something trustworthy (unreachable, none configured, or `--local`
        # asked us not to try) — fall back to our own cache only if it is itself trustworthy;
        # never synthesize one here.
        if trusted_old:
            return {**old, "trusted": True, "cached": True}
        raise RuntimeError("这台机器没有这个项目的目录和会话记录" + ("" if local_only else "，也连不上有记录的机器") + "，等有记录的机器生成总结")
    if not p:
        raise RuntimeError("没有可用的模型：设置里选一个总结模型")
    text = chat(p, PROJECT_PROMPT, f"项目：{name}\n\n{m['text']}", timeout=120, use=use).strip().strip('"“”').replace("\n", " ")[:500]
    if not text:
        raise RuntimeError("模型没有返回内容")
    rec = {"summary": text, "at": int(time.time()), "by": f"{p['id']}:{p['model']}", "sessions": m["sessions"], "open": m["open"], "closed": m["closed"],
           "trusted": True, "material_sessions": m["sessions"]}
    D.wiki_store(key, json.dumps(rec, ensure_ascii=False))
    return {**rec, "cached": False}
