"""One-paragraph summary of a conversation, written by a model (`dispatch session-summary`).

Uses whatever chat API key `dispatch env` already holds — DeepSeek, 智谱 GLM, Kimi,
MiniMax, OpenAI — through the OpenAI-compatible chat endpoint each of them offers, or the
Claude Code subscription through `claude -p` (`SUMMARY_MODEL=claude:haiku`).
`SUMMARY_MODEL=<provider>:<model>` in `dispatch env` picks one explicitly. The result is
stored in the session's preferences (next to starred/archived), so every view shows it
and it is not recomputed until the conversation moves on.
"""
import json, os, subprocess, sys, time, urllib.request

import dispatch as D

PROVIDERS = [
    # env key, provider id, base url, default model — first available wins unless SUMMARY_MODEL says otherwise.
    # 智谱 first: the user's GLM key is the one meant for this kind of housekeeping (see dispatch facts).
    ("ZHIPU_API_KEY", "zhipu", "https://open.bigmodel.cn/api/paas/v4", "glm-5.3-flash"),
    ("DEEPSEEK_API_KEY", "deepseek", "https://api.deepseek.com/v1", "deepseek-chat"),
    ("KIMI_API_KEY", "kimi", "https://api.moonshot.cn/v1", "moonshot-v1-8k"),
    ("MINIMAX_API_KEY", "minimax", "https://api.minimax.chat/v1", "MiniMax-Text-01"),
    ("OPENAI_API_KEY", "openai", "https://api.openai.com/v1", "gpt-4.1-mini"),
]
PROMPT = ("你是会话记录的总结者。下面是用户和一个编程 Agent 的对话摘录。用简体中文写一段不超过 120 字的总结，三层意思按顺序连成一段话：用户想要什么；Agent 实际做了什么、结果如何；还没做完或在等用户的事（没有就不写）。"
          "只写事实，不评价，不用「用户」「Agent」之外的称呼，不加标题、不用列表、不用引号。")


CLAUDE_BIN = next((p for p in (os.path.join(D.HOME, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude") if os.path.exists(p)), "")


def provider():
    """Which model writes summaries. `SUMMARY_MODEL=claude:haiku` (or sonnet / a full model id)
    runs `claude -p` on the Claude Code subscription — no API key, counts against its usage
    limits, a few seconds per call. Otherwise the first API key found, 智谱 first."""
    env = {i["name"]: i["value"] for i in D.env_read()}
    # The app's 设置 wins (shared through the board), then the env file, then whatever is available.
    pick = (D.settings_load().get("summary_model") or "").strip() or env.get("SUMMARY_MODEL", "")
    if pick and ":" in pick:
        pid, model = pick.split(":", 1)
        if pid == "claude" and CLAUDE_BIN:
            return {"id": "claude", "base": "", "model": model or "haiku", "key": ""}
        for key, p, base, _ in PROVIDERS:
            if p == pid and env.get(key):
                return {"id": p, "base": base, "model": model, "key": env[key]}
    for key, p, base, model in PROVIDERS:
        if env.get(key):
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


def auto(limit=2):
    """Summarize the conversations a person will actually look at, newest first, a few per call:
    fresh replies get a summary within minutes; older sessions fill in over time. Skips scheduled
    and archived sessions and anything summarized since it last changed."""
    from activity import session_preferences, set_preferences
    if not D.settings_load().get("summary_auto", 1):
        return {"done": [], "reason": "自动总结已关闭"}
    prefs = session_preferences(D.DISPATCH_DIR)
    idx = D.load_index() or D.refresh_index()
    rows = [(k, e) for k, e in idx.items() if not e.get("subagent") and (e.get("user_msgs") or 0) > 0 and e.get("agent") in ("claude-code", "codex", "pi", "zcode")]
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
        except Exception as ex:
            done.append({"key": key, "error": str(ex)[:160]})
        if len(done) >= limit:
            break
    return {"done": done, "tried": tried}


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


def chat(p, system, user, timeout=90):
    if p["id"] == "claude":
        # Headless Claude Code: the prompt is the system text, the transcript comes on stdin.
        # Strip the session markers so a summary started from inside a Claude session still saves nothing odd.
        env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}
        env["PATH"] = D.PATH_EXTRA + ":" + env.get("PATH", "")
        r = subprocess.run([CLAUDE_BIN, "-p", system, "--model", p["model"], "--output-format", "text", "--tools", ""], input=user, capture_output=True, text=True, timeout=timeout + 60, env=env, cwd=D.HOME)
        if r.returncode != 0 and not r.stdout.strip():
            raise RuntimeError("claude -p 失败：" + (r.stderr or "").strip()[-200:])
        return r.stdout.strip()
    req_body = {"model": p["model"], "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}], "temperature": 0.2, "max_tokens": 400}
    if p["id"] == "zhipu" and p["model"].startswith("glm-5"):
        # GLM-5 always reasons and spends max_tokens on it; ask for as little as it allows.
        req_body["reasoning_effort"] = "low"; req_body["max_tokens"] = 1200
    body = json.dumps(req_body).encode()
    req = urllib.request.Request(p["base"].rstrip("/") + "/chat/completions", data=body, headers={"Content-Type": "application/json", "Authorization": f"Bearer {p['key']}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.load(r)
    return (d.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()


def summarize(key, force=False):
    from activity import set_preferences, session_preferences
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
    text = chat(p, PROMPT, f"会话标题：{meta.get('title', '')}\n项目目录：{meta.get('cwd', '')}\n\n{excerpt}")
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


def project_summary(name, force=False, if_stale=False):
    key = D.INTERNAL_MEMORY_PREFIX + "project-summary-" + name
    code, o, _ = D.sh(["bd", "memories", "--json"])
    old = None
    try:
        raw = json.loads(o[o.find("{"):]).get(key) if code == 0 else None
        old = json.loads(raw) if raw else None
    except (ValueError, AttributeError):
        old = None
    if old and not force and not (if_stale and time.time() - old.get("at", 0) > 86400):
        return {**old, "cached": True}
    if if_stale and not force and old is None and not D.settings_load().get("summary_auto", 1):
        return {"summary": "", "cached": True}
    p = provider()
    if not p:
        raise RuntimeError("没有可用的模型：设置里选一个总结模型")
    m = project_material(name)
    if not m["sessions"] and not m["open"] and not m["closed"]:
        raise RuntimeError("这个项目还没有会话或任务")
    text = chat(p, PROJECT_PROMPT, f"项目：{name}\n\n{m['text']}", timeout=120).strip().strip('"“”').replace("\n", " ")[:500]
    if not text:
        raise RuntimeError("模型没有返回内容")
    rec = {"summary": text, "at": int(time.time()), "by": f"{p['id']}:{p['model']}", "sessions": m["sessions"], "open": m["open"], "closed": m["closed"]}
    D.wiki_store(key, json.dumps(rec, ensure_ascii=False))
    return {**rec, "cached": False}
