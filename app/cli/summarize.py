# -*- coding: utf-8 -*-
"""One-paragraph summary of a conversation, written by a model (`dispatch session-summary`).

Uses whatever chat API key `dispatch env` already holds — DeepSeek, 智谱 GLM, Kimi,
MiniMax, OpenAI — through the OpenAI-compatible chat endpoint each of them offers, or the
Claude Code subscription through `claude -p` (`SUMMARY_MODEL=claude:haiku`).
`SUMMARY_MODEL=<provider>:<model>` in `dispatch env` picks one explicitly. The result is
stored in the session's preferences (next to starred/archived), so every view shows it
and it is not recomputed until the conversation moves on.
"""
import json, os, re, subprocess, sys, time, urllib.error, urllib.request

import dispatch as D
import dplatform as P
from lang import t as _t
import engines as E

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
# What the summaries say is shown in the window, so they are written in the person's language (lang.py). The English
# prompts start "You summarize a" so dispatch.py's INTERNAL_PROMPTS keeps their `claude -p` runs out of the session list.
PROMPT_EN = ("You summarize a coding session's record. Below is an excerpt of a conversation between a person and a coding agent. Write one paragraph of at most 60 words in English, "
             "three points in order: what the person wants; what the agent actually did and the result; what is unfinished or waiting for the person (leave it out when there is none). "
             "Facts only, no judgement, call them only \"the person\" and \"the agent\", no heading, no list, no quotes.")
PROMPT = ("你是会话记录的总结者。下面是用户和一个编程 Agent 的对话摘录。用简体中文写一段不超过 120 字的总结，三层意思按顺序连成一段话：用户想要什么；Agent 实际做了什么、结果如何；还没做完或在等用户的事（没有就不写）。"
          "只写事实，不评价，不用「用户」「Agent」之外的称呼，不加标题、不用列表、不用引号。")

# Nothing is sent to a model until the person says so (first-run setup → 「模型与总结」, or 设置 →
# 总结): every use that runs on its own defaults to off. 「讨论结论」 stays on because a discussion
# only exists when the person started one, and its text already went to the agents in it.
SUMMARY_USES = [
    ("session", "Session summaries", "Summarize completed turns for session and project views", 0),
    ("project", "Project status", "The status paragraph on the project page", 0),
    ("here", "dispatch here", "Status and conclusions from dispatch here", 0),
    ("discuss", "Discussion conclusions", "The leader writes conclusions after a multi-agent discussion", 1),
    ("insights", "Insights reports", "Insights across agent sessions", 0),
    ("memories", "Memory summaries", "Overall and project summaries on the Memory page", 0),
    ("profile_inventory", "Device inventory", "Summarize measurements from each machine", 0),
    ("session_name", "Session titles", "Create a short title from the first message; use the engine title when disabled or unavailable", 1),
    ("capture", "Notes from chat", "Read each message you send to put the new things you ask for on the task board", 1),
    ("semantic", "Semantic search index", "Embed task titles, descriptions and knowledge entries for semantic search", 0),
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
    return f"{use_name(key)} is disabled. Enable it in Settings > Summaries to send content to the selected model."


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


def agent_bin(engine):
    """The program of an engine that answers on the person's own subscription (Claude Code's `claude -p`, Codex's
    `codex exec` on their ChatGPT plan: no API key of ours involved), or "" when it is not on this Mac."""
    eng = E.find(engine)
    if not eng or not eng.supports("answer_models"):
        return ""
    # Windows: PATH plus the usual install folders (npm's codex.cmd, ~/.local/bin/claude.exe), Store stubs skipped
    return (P.which(eng.bin) or "") if P.IS_WIN else (E.which(eng.bin) or "")


def subscription_engines():
    """The engines that answer on the person's subscription and are on this Mac, in list order."""
    return [e for e in E.runnable() if e.supports("answer_models") and agent_bin(e.id)]


PROVIDER_ENV = {p: key for key, p, _, _ in PROVIDERS}
PROVIDER_LABELS = {"zhipu": "Zhipu", "deepseek": "DeepSeek", "kimi": "Kimi", "minimax": "MiniMax", "openai": "OpenAI"}


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
        if agent_bin(pid):
            eng = E.get(pid)
            return {"id": eng.id, "base": "", "model": model or eng.answer_models("summary")[0]["id"], "key": ""}
        for key, p, base, _ in PROVIDERS:
            if p == pid and env.get(key):
                return {"id": p, "base": base, "model": model, "key": env[key]}
    for key, p, base, model in PROVIDERS:
        if env.get(key) and p not in retired_providers():
            return {"id": p, "base": base, "model": model, "key": env[key]}
    for eng in subscription_engines():
        return {"id": eng.id, "base": "", "model": eng.answer_models("summary")[0]["id"], "key": ""}
    return None


def _subscription_label(m):
    return f"{m['label']} (subscription" + (f", {m['note']})" if m.get("note") else ")")


def providers():
    """Every model the settings page can offer: the Claude subscription (when the CLI is installed)
    and each API key in `dispatch env`, with the default model each one gets."""
    env = {i["name"]: i["value"] for i in D.env_read()}
    out = [{"id": f"{eng.id}:{m['id']}", "label": _subscription_label(m)} for eng in subscription_engines() for m in eng.answer_models("summary")]
    for key, p, base, model in PROVIDERS:
        if env.get(key):
            out.append({"id": f"{p}:{model}", "label": f"{model}（{p}，API Key）"})
    return out


def model_catalog():
    """Every model the settings page can pick — Claude subscription first, then each provider —
    with its env key and whether it is usable on this machine right now."""
    env = {i["name"]: i["value"] for i in D.env_read()}
    rows = [{"id": f"{eng.id}:{m['id']}", "provider": eng.id, "label": _subscription_label(m), "env": "", "configured": bool(agent_bin(eng.id)),
             "model": m["id"], "subscription": True}
            for eng in E.runnable() if eng.supports("answer_models") for m in eng.answer_models("summary")]
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
    import engines
    adapters = {e.agent: e for e in engines.adapters()}  # the engines whose conversations Dispatch reads
    rows = [(k, e) for k, e in idx.items() if not e.get("subagent") and (e.get("user_msgs") or 0) > 0 and e.get("agent") in adapters
            and not adapters[e["agent"]].runs_on_its_own(e)]
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


UNREAD_PROMPT_EN = ("You summarize a coding session's record. Between [excerpt start] and [excerpt end] in the user message is what a coding agent said in the turn after the person's last message; the part marked [final reply] is the reply the person reads, what comes before it are progress notes along the way. "
                    "Compress the final reply into one paragraph of at most 45 words in English: the conclusion or result it tells the person, and what it asks them to do (leave that out when nothing). Do not count tool calls or commands; use the progress notes only when the final reply is unclear. However short the excerpt, write from it; never say you cannot see it or ask for more. Facts only, no judgement, no heading, no list, no quotes.")
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
    if _t("en", "zh") == "en":
        return (f"(progress notes along the way)\n{notes}\n\n" if notes else "") + "[final reply]\n" + final
    return (f"（过程中的进度说明）\n{notes}\n\n" if notes else "") + "【最终回复】\n" + final


def summarize_unread(key, reply_id, force=False):
    """A digest of what the Agent did since the person's last message — what an unread reply
    means — cached per reply id in the session's preferences."""
    from activity import set_preferences, session_preferences
    if not use_enabled("session"):
        raise RuntimeError(gate_message("session"))
    p = provider()
    if not p:
        raise RuntimeError("No model is available")
    prefs = session_preferences(D.DISPATCH_DIR).get(key, {})
    if not force and prefs.get("unread_summary") and prefs.get("unread_summary_reply") == reply_id:
        return {"key": key, "unread_summary": prefs["unread_summary"], "cached": True}
    r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), "session", key, "--json"], capture_output=True, text=True, encoding="utf-8", timeout=120, env={**os.environ, "BEADS_DIR": D.BEADS_DIR, "PYTHONUTF8": "1"}, creationflags=P.no_window_flags())
    if r.returncode != 0:
        raise RuntimeError(f"Could not read the session: {(r.stderr or r.stdout).strip()[-200:]}")
    d = json.loads(r.stdout[r.stdout.find("{"):])
    try:
        reply_at = float(str(reply_id).split(":")[0])
    except ValueError:
        reply_at = None
    excerpt = unread_turn(d.get("messages") or [], reply_at)
    if not excerpt.strip():
        raise RuntimeError("This turn has no reply to summarize yet")
    meta = d.get("meta", {})
    text = chat(p, _t(UNREAD_PROMPT_EN, UNREAD_PROMPT),
                _t(f"Session title: {meta.get('title', '')}\n\n[excerpt start]\n{excerpt}\n[excerpt end]\n\nWrite this turn's summary.",
                   f"会话标题：{meta.get('title', '')}\n\n【摘录开始】\n{excerpt}\n【摘录结束】\n\n请写这一轮的摘要。"), use="session")
    text = text.strip().strip('"“”').replace("\n", " ")[:240]
    if not text:
        raise RuntimeError("The model returned no content")
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


def transcript_turns(key):
    """[(who, text)] oldest first: each user message and the last reply of its turn, untrimmed;
    plus the session meta and its reply version."""
    r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), "session", key, "--json"], capture_output=True, text=True, encoding="utf-8", timeout=120, env={**os.environ, "BEADS_DIR": D.BEADS_DIR, "PYTHONUTF8": "1"}, creationflags=P.no_window_flags())
    if r.returncode != 0:
        raise RuntimeError(f"Could not read the session: {(r.stderr or r.stdout).strip()[-200:]}")
    d = json.loads(r.stdout[r.stdout.find("{"):])
    msgs = d.get("messages") or []
    turns, last_reply = [], None
    import activity as A
    for m in msgs:
        said = A.user_text(m.get("text") or "") if m.get("role") == "user" and not m.get("synthetic") else ""
        if said:
            # what the person wrote: not the window's or the harness's notes sent as user messages (task-lj06.31)
            if last_reply:
                turns.append(("Agent", last_reply)); last_reply = None
            turns.append(("User", said))
        elif m.get("role") == "assistant" and m.get("text", "").strip():
            last_reply = m["text"].strip()
    if last_reply:
        turns.append(("Agent", last_reply))
    return turns, d.get("meta", {}), (d.get("reply_id") or d.get("activity_version") or "")


def transcript_excerpt(key, limit=12000):
    """User messages in full (trimmed) and the last reply of each turn, oldest first."""
    turns, meta, version = transcript_turns(key)
    # Keep the beginning and the end when it is long: the goal and the outcome matter most.
    parts = [f"{who}：{text[:700]}" for who, text in turns]
    text = "\n\n".join(parts)
    if len(text) > limit:
        head, tail = text[: limit // 3], text[-(limit * 2 // 3):]
        text = head + _t("\n\n…(middle left out)…\n\n", "\n\n……（中间省略）……\n\n") + tail
    return text, meta, version


class Truncated(RuntimeError):
    """The model stopped at max_tokens (finish_reason "length"): the text is cut off. Raised only
    for callers that asked for a whole answer (`whole=True`), such as ⌘K replacing a selection."""


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


def chat(p, system, user, timeout=90, max_tokens=None, use=None, grace=None, whole=False):
    """One completion. When the provider is out of balance, the next configured API key takes
    over for this call and `p` is updated in place, so the caller records the model that actually
    wrote the text. All out of balance: QuotaExhausted names them. `grace`: extra seconds the
    `claude -p` / `codex exec` process may run past `timeout` (default: 60 and 120, for their start-up);
    0 kills it at `timeout`. `whole`: raise Truncated instead of returning an answer the model cut
    off at max_tokens."""
    try:
        return _chat(p, system, user, timeout, max_tokens, use, grace, whole)
    except QuotaExhausted as first:
        errors = [str(first)]
        for q in fallback_providers(p):
            try:
                text = _chat(q, system, user, timeout, max_tokens, use, grace, whole)
            except QuotaExhausted as e:
                errors.append(str(e))
                continue
            p.update(q)
            return text
        raise QuotaExhausted("; ".join(errors))


def _chat(p, system, user, timeout=90, max_tokens=None, use=None, grace=None, whole=False):
    eng = E.find(p["id"])
    if eng and eng.supports("answer"):
        # The person's own Claude Code / Codex, no tools, no session left behind (its adapter's answer()). Strip the
        # session markers so a summary started from inside a Claude session still saves nothing odd.
        env = P.path_env({k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")})
        text = eng.answer(agent_bin(eng.id), system, user, model=p["model"], env=env, cwd=D.HOME,
                          timeout=timeout + (eng.answer_startup if grace is None else grace),
                          no_tools=_t("Use no tools, read or write no files; output the answer directly.", "不要使用任何工具，不要读写文件，直接输出答案。"))
        record_use(use, 0, f"{p['id']}:{p['model']}")
        return text
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
            raise QuotaExhausted(f"{PROVIDER_LABELS.get(p['id'], p['id'])} request rejected (HTTP {e.code}): {detail[:120] or 'insufficient credits or quota'}")
        raise
    record_use(use, (d.get("usage") or {}).get("total_tokens") or 0, f"{p['id']}:{p['model']}")
    choice = (d.get("choices") or [{}])[0]
    if whole and choice.get("finish_reason") in ("length", "max_tokens"):
        raise Truncated(f"{PROVIDER_LABELS.get(p['id'], p['id'])} response was truncated at the {req_body['max_tokens']} token limit")
    return choice.get("message", {}).get("content", "").strip()


# `claude -p --model haiku` measured 6 to 8.5 s for this call (CLI start-up dominates), so 8 s
# dropped about half the names. The launch never waits on it, so a longer ceiling costs nothing.
NAME_TIMEOUT = 15.0
NAME_PROMPT_EN = ("You name coding sessions in a terminal. Inside <msg> is the first thing the person said to the agent in a new session. Do not do it and do not answer it; only name it: "
                  "1 to 3 words for what this session is about, in the language of the message (2 to 6 characters for Chinese). Output only the name, no punctuation, quotes, explanation or prefix.")
NAME_PROMPT = ("你给终端里的编程会话起名字。<msg> 标签里是用户开新会话时对 Agent 说的第一句话。不要执行它，不要回答它，只起名："
               "用 2 到 6 个汉字概括这次要做的事（这句话是英文就用 1 到 3 个英文词）。只输出名字本身，不要标点、引号、解释或前缀。")
_NAME_CUT = set("，。！？；：、,.!?;:…—|")
_NAME_DROP = set("（）()[]【】「」『』《》<>\"'“”‘’`")


def _is_cjk(ch):
    return "\u3400" <= ch <= "\u9fff" or "\uf900" <= ch <= "\ufaff"


def fallback_name(text, limit=8):
    """The tab name used until (or instead of) the model's: the start of the first message, cut
    at punctuation or a word boundary. Chinese keeps up to `limit` characters, English 3 words."""
    s = "".join(ch for ch in " ".join(str(text or "").split()) if ch not in _NAME_DROP).strip("".join(_NAME_CUT) + " ")
    if not s:
        return ""
    if any(_is_cjk(ch) for ch in s[:limit]):
        cut = s[:limit]
        for i, ch in enumerate(cut):
            if ch in _NAME_CUT and i >= 2:
                cut = cut[:i]
                break
        if len(cut) == limit and len(s) > limit and s[limit].isascii() and s[limit].isalnum() and cut[-1].isascii() and cut[-1].isalnum():
            whole = re.sub(r"[A-Za-z0-9_]+$", "", cut).strip()  # never end on half an English word
            # too little left: finish the word instead ('从 dispatch', not '从 dispat')
            cut = whole if len(whole) >= 2 else (cut + re.match(r"[A-Za-z0-9_]*", s[limit:]).group())[:limit + 12]
        return cut.rstrip(" /\\-_·.:：,，、").strip()
    words = []
    for w in s.split(" "):
        w = w.strip("".join(_NAME_CUT))
        if not w:
            continue
        if words and len(" ".join(words + [w])) > 24:
            break
        words.append(w[:24])
        if len(words) == 3:
            break
    return " ".join(words)


def clean_name(raw):
    """The model's answer as a tab name, or "" when it is not a short name (an answer to the
    message instead of a name, a sentence, an empty reply)."""
    import unicodedata
    line = next((l.strip() for l in str(raw or "").splitlines() if l.strip()), "")
    for prefix in ("名字：", "名字:", "名称：", "名称:", "Name:", "name:"):
        if line.startswith(prefix):
            line = line[len(prefix):]
    line = "".join(ch if not unicodedata.category(ch).startswith(("P", "S")) else " " for ch in line)
    name = " ".join(line.split())
    if not name:
        return ""
    cjk = sum(1 for ch in name if _is_cjk(ch))
    if cjk:
        name = "".join(ch for i, ch in enumerate(name) if ch != " " or not (_is_cjk(name[i - 1]) and i + 1 < len(name) and _is_cjk(name[i + 1])))
        return name if cjk <= 8 and len(name) <= 16 else ""
    return name if len(name.split()) <= 4 and len(name) <= 32 else ""


def short_name(message, timeout=NAME_TIMEOUT):
    """A few-character name for a session from its first message, written by the summary model.
    Only the message is sent. Returns "" when the use is off, no model is set up, the model is
    slower than `timeout` seconds, fails, or answers with something that is not a short name."""
    import threading
    message = str(message or "").strip()
    if not message or not use_enabled("session_name"):
        return ""
    p = provider()
    if not p:
        return ""
    result = {}

    def run():
        try:
            # the name is in the message's own language (task-7lptn): an English message gets the English prompt
            prompt = NAME_PROMPT if any(_is_cjk(ch) for ch in message[:400]) else NAME_PROMPT_EN
            result["text"] = chat(p, prompt, f"<msg>\n{message[:1500]}\n</msg>", timeout=max(int(timeout), 1), use="session_name", grace=0)
        except Exception as e:
            result["error"] = e

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    # grace=0: the `claude -p` / `codex exec` child is killed at the deadline, not left running for
    # another minute; the extra second lets that kill happen before this process can exit.
    worker.join(timeout + 1)
    name = clean_name(result.get("text", "")) if "text" in result else ""
    if name and not any(_is_cjk(ch) for ch in message) and any(_is_cjk(ch) for ch in name):
        return ""  # a Chinese name for an English message: the caller's fallback (the message's own words) instead
    return name


TITLE_PROMPT = ("Shorten this task title for a task board. Keep its language (Chinese stays Chinese). "
                "Keep the shape `what: why` (中文用全角冒号「：」), at most 24 characters for Chinese or 8 words "
                "for English, no quotes, no trailing punctuation. Answer with the title only.")


def short_title(title, limit=40, timeout=10.0):
    """A task title shortened by the summary model (`dispatch begin` with an over-long title, so the
    board never shows a title cut mid-thought). "" when the use is off, no model is set up, it is
    slower than `timeout`, fails, or answers with something longer than `limit`."""
    import threading
    title = str(title or "").strip()
    if not title or not use_enabled("session_name"):
        return ""
    p = provider()
    if not p:
        return ""
    result = {}

    def run():
        try:
            result["text"] = chat(p, TITLE_PROMPT, title[:600], timeout=max(int(timeout), 1), use="session_name", grace=0)
        except Exception as e:
            result["error"] = e

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(timeout + 1)
    line = next((l.strip() for l in str(result.get("text", "")).splitlines() if l.strip()), "")
    line = line.strip("\"'“”「」` ").rstrip("。.!！")
    if not any(_is_cjk(ch) for ch in title) and any(_is_cjk(ch) for ch in line):
        return ""  # the title keeps its language (task-7lptn): an English title never comes back Chinese
    return line if 0 < len(line) <= limit else ""


def summarize(key, force=False):
    from activity import set_preferences, session_preferences
    if not use_enabled("session"):
        raise RuntimeError(gate_message("session"))
    p = provider()
    if not p:
        raise RuntimeError("No model is available. Install Claude Code (SUMMARY_MODEL=claude:haiku), or set an API key in dispatch env.")
    excerpt, meta, version = transcript_excerpt(key)
    if meta.get("agent") and meta.get("session_id"):
        key = f"{meta['agent']}:{meta['session_id']}"  # the full key preferences are stored under
    if not excerpt.strip():
        raise RuntimeError("This session has no content to summarize yet")
    prefs = session_preferences(D.DISPATCH_DIR).get(key, {})
    if not force and prefs.get("summary") and prefs.get("summary_version") == version:
        return {"key": key, "summary": prefs["summary"], "cached": True, "provider": prefs.get("summary_by", "")}
    text = chat(p, _t(PROMPT_EN, PROMPT), _t(f"Session title: {meta.get('title', '')}\nProject folder: {meta.get('cwd', '')}\n\n{excerpt}",
                                         f"会话标题：{meta.get('title', '')}\n项目目录：{meta.get('cwd', '')}\n\n{excerpt}"), use="session")
    text = text.strip().strip('"“”').replace("\n", " ")[:300]
    if not text:
        raise RuntimeError("The model returned no content")
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
        print(json.dumps(res, ensure_ascii=False, indent=2) if a.json else (res.get("reason") or "\n".join(f"{d['key'][:28]}  {d.get('summary') or d.get('error')}" for d in res["done"]) or _t("No session needs a summary", "没有需要总结的会话")))
        return
    if a.op == "unread":
        from activity import activity_list
        row = next((x for x in activity_list(D.HOME, D.DISPATCH_DIR, D.load_index() or {}) if x["key"] == a.key or x["session_id"] == a.key), None)
        if not row or not row.get("reply_id"):
            print(json.dumps({"error": "This session has no unread reply"}, ensure_ascii=False) if a.json else _t("✗ This session has no unread reply", "✗ 这个会话没有待读的回复"))
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
        res = {"available": bool(p), **({"id": p["id"], "model": p["model"]} if p else {}), "hint": "" if p else _t("With Claude Code installed its subscription works (SUMMARY_MODEL=claude:haiku), or put one of DEEPSEEK_API_KEY / ZHIPU_API_KEY / KIMI_API_KEY / MINIMAX_API_KEY / OPENAI_API_KEY in dispatch env; SUMMARY_MODEL=provider:model picks one", "装了 Claude Code 就能用订阅（SUMMARY_MODEL=claude:haiku），或在 dispatch env 里放 DEEPSEEK_API_KEY / ZHIPU_API_KEY / KIMI_API_KEY / MINIMAX_API_KEY / OPENAI_API_KEY 之一；SUMMARY_MODEL=provider:model 可指定")}
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
            print(_t(f"Now: {res['current'] or 'picked by itself'}", f"当前：{res['current'] or '自动选择'}"))
            for x in res["providers"]:
                print(f"{x['id']:<28} {x['label']:<22} {_t('set up', '已配置') if x['configured'] else _t('not set up', '未配置')}")
        return
    if op == "set-key":
        env_key = PROVIDER_ENV.get(getattr(a, "provider", "") or "")
        if not env_key:
            print(_t("set-key needs an API key provider: zhipu | deepseek | kimi | minimax | openai (claude is a subscription and needs no key)", "set-key 需要一个 API Key 提供方：zhipu | deepseek | kimi | minimax | openai（claude 是订阅，不用 Key）"), file=sys.stderr)
            sys.exit(2)
        key = sys.stdin.read().strip()
        if not key:
            print(_t("No key on stdin", "没有从 stdin 读到 Key"), file=sys.stderr)
            sys.exit(2)
        items = D.env_read()
        hit = next((it for it in items if it["name"] == env_key), None)
        if hit:
            hit["value"] = key
        else:
            items.append({"name": env_key, "value": key, "note": f"{PROVIDER_LABELS.get(a.provider, a.provider)} API Key", "project": ""})
        D.env_write(items)
        res = {"ok": True, "provider": a.provider, "env": env_key, "configured": True}
        print(json.dumps(res, ensure_ascii=False) if a.json else _t(f"Saved {env_key} (the value is not shown)", f"已保存 {env_key}（值不显示）"))
        return
    if op == "uses":
        usage = usage_load()
        res = [{"key": k, "name": n, "desc": d, "enabled": use_enabled(k), "last": usage.get(k) or None} for k, n, d, _ in SUMMARY_USES]
        if a.json:
            print(json.dumps(res, ensure_ascii=False, indent=2))
        else:
            for x in res:
                last = x["last"] or {}
                when = time.strftime("%m-%d %H:%M", time.localtime(last["at"])) if last.get("at") else _t("never", "从未")
                print(f"{'✓' if x['enabled'] else '✗'} {x['name']:<12} {x['desc']}" + _t(f" (last: {when})", f"（上次：{when}）"))
        return
    print(_t(f"Unknown operation: {op}", f"未知操作：{op}"), file=sys.stderr)
    sys.exit(2)


# ---------------------------------------------------------------- project summary: the whole project in a paragraph

PROJECT_PROMPT_EN = ("You summarize a project's record. Below is a project's material: recent session summaries (one per session) and the open and recently finished tasks on its board. Write one paragraph of at most 100 words in English, "
                     "four points in order: what the project is; where it stands; what was done lately and with what result; what is missing or comes next. Facts only, no judgement, call them only \"the person\" and \"the agent\", no heading, no list, no quotes.")
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
    # 未分项目 (the 脉络 board for work nobody gave a project): sessions in folders that are no
    # project, tasks without a project label.
    unassigned = name == "未分项目"
    want = "" if unassigned else name.lower()
    for k, e in idx.items():
        if e.get("subagent") or not e.get("user_msgs"):
            continue
        cwd = (e.get("cwd") or "").rstrip("/")
        if cwd not in by_cwd:
            by_cwd[cwd] = (D.project_of_cwd(cwd, names, roots) or "").lower() == want if cwd else False
        if not by_cwd[cwd]:
            continue
        key = f"{e['agent']}:{e['session_id']}"
        pr = prefs.get(key, {})
        if pr.get("scheduled") or pr.get("archived"):
            continue
        # Outside any project most sessions are headless probes (`claude -p`, `codex exec`): they say nothing about the work.
        if unassigned and (e.get("entrypoint") in ("sdk-cli", "exec") or not (e.get("title") or "").strip()):
            continue
        sessions.append((e.get("mtime", 0), time.strftime("%Y-%m-%d", time.localtime(e.get("mtime", 0))), pr.get("summary") or (e.get("title") or "") + "：" + (e.get("first_prompt") or "")[:200]))
    sessions.sort(reverse=True)
    lines = [f"[{d}] {t}" for _, d, t in sessions[:20] if t.strip(" ：")]
    code, o, _ = D.sh(["bd", "list", "--all", "--json"])
    open_t, closed_t = [], []
    try:
        for it in (json.loads(o[o.find("["):]) if code == 0 else []):
            labels = [l.lower() for l in it.get("labels") or []]
            if unassigned:
                if any(l.startswith("project:") and l != "project:" for l in labels):
                    continue
            elif f"project:{want}" not in labels:
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
        raise RuntimeError(_t("This project has no sessions or tasks yet", "这个项目还没有会话或任务"))
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
        raise RuntimeError(_t("This Mac has neither the project's folder nor its sessions" + ("" if local_only else ", and no Mac that has them answers") + "; the summary comes from a Mac that has them",
                              "这台机器没有这个项目的目录和会话记录" + ("" if local_only else "，也连不上有记录的机器") + "，等有记录的机器生成总结"))
    if not p:
        raise RuntimeError(_t("No model to use: pick a summary model in Settings", "没有可用的模型：设置里选一个总结模型"))
    text = chat(p, _t(PROJECT_PROMPT_EN, PROJECT_PROMPT), _t(f"Project: {name}\n\n{m['text']}", f"项目：{name}\n\n{m['text']}"), timeout=120, use=use).strip().strip('"“”').replace("\n", " ")[:500]
    if not text:
        raise RuntimeError("The model returned no content")
    rec = {"summary": text, "at": int(time.time()), "by": f"{p['id']}:{p['model']}", "sessions": m["sessions"], "open": m["open"], "closed": m["closed"],
           "trusted": True, "material_sessions": m["sessions"]}
    D.wiki_store(key, json.dumps(rec, ensure_ascii=False))
    return {**rec, "cached": False}
