"""One-paragraph summary of a conversation, written by a model (`dispatch session-summary`).

Uses whatever chat API key `dispatch env` already holds — DeepSeek, 智谱 GLM, Kimi,
MiniMax, OpenAI — through the OpenAI-compatible chat endpoint each of them offers.
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


def provider():
    env = {i["name"]: i["value"] for i in D.env_read()}
    pick = env.get("SUMMARY_MODEL", "")
    if pick and ":" in pick:
        pid, model = pick.split(":", 1)
        for key, p, base, _ in PROVIDERS:
            if p == pid and env.get(key):
                return {"id": p, "base": base, "model": model, "key": env[key]}
    for key, p, base, model in PROVIDERS:
        if env.get(key):
            return {"id": p, "base": base, "model": model, "key": env[key]}
    return None


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
        raise RuntimeError("没有可用的模型 Key：在 dispatch env 里放 DEEPSEEK_API_KEY / ZHIPU_API_KEY / KIMI_API_KEY / MINIMAX_API_KEY / OPENAI_API_KEY 之一")
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
    data = set_preferences(D.DISPATCH_DIR, key, {"summary": text, "summary_at": int(time.time()), "summary_version": version, "summary_by": f"{p['id']}:{p['model']}"})
    return {"key": key, "summary": data["summary"], "cached": False, "provider": data["summary_by"]}


def main(a):
    if a.op == "provider":
        p = provider()
        res = {"available": bool(p), **({"id": p["id"], "model": p["model"]} if p else {}), "hint": "" if p else "在 dispatch env 里放 DEEPSEEK_API_KEY / ZHIPU_API_KEY / KIMI_API_KEY / MINIMAX_API_KEY / OPENAI_API_KEY 之一；SUMMARY_MODEL=provider:model 可指定"}
    else:
        try:
            res = summarize(a.key, force=a.force)
        except Exception as e:
            print(json.dumps({"error": str(e)}, ensure_ascii=False) if a.json else f"✗ {e}")
            sys.exit(1)
    print(json.dumps(res, ensure_ascii=False, indent=2) if a.json else (res.get("summary") or json.dumps(res, ensure_ascii=False)))
