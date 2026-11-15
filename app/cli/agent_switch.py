# -*- coding: utf-8 -*-
"""Mid-conversation switches: `dispatch agent model <会话> <模型>` (same Agent, another model from
the next turn on) and `dispatch agent switch <会话> --to codex|claude|opencode` (another Agent in the
same folder, handed the conversation so far).

A switch cannot carry the other CLI's session over, so the new Agent gets one first message: the
last few rounds verbatim and a summary of everything before them, at most MAX_CHARS characters,
ending in "Continue:". The two conversations point at each other through their session
preferences (`switched_from` / `switched_to`), the old one is closed in chatd and its title starts
with "Switched to ...". A conversation that lives in the Dispatch IDE Agents window (`source: ide`) is
not opened here: the extension gets the first message as JSON and starts the new session itself.
"""
import os
import re
import sys

import dispatch as D
import engines as E
from lang import t as _t

MAX_CHARS = 8000        # the whole first message
RECENT_ROUNDS = 6       # rounds (a user message and the reply to it) kept verbatim
SUMMARY_CHARS = 1500    # the summary of the earlier rounds
SUMMARY_INPUT = 12000   # what the summary model reads of those rounds
# The first message is one language throughout: the person's (lang.py), English or Chinese, summary included
# (task-7lptn; it was always Chinese since 09-28). The session titles the interface shows stay English.
DEFAULT_NEXT_EN = "Go on from the last turn. If it was already finished, say where things stand in two or three sentences, then wait for my next message."
DEFAULT_NEXT = "接着上一轮做。上一轮已经做完的话，用两三句话说清现在的状态，然后等我的下一条消息。"
SUMMARY_PROMPT_EN = ("Below is an earlier part of a conversation between a person and a coding agent. Write a handoff summary of at most 300 words in English for the other agent who takes over: "
                     "what the person wants, what was already done (files changed, what was run, results), decisions made, what is still unfinished. "
                     "Facts only; keep file names, commands and numbers exactly; no headings, no lists.")
SUMMARY_PROMPT = ("下面是用户和一个编程 Agent 早先的对话。用简体中文写一段不超过 600 字的交接摘要，给接手的另一个 Agent 看："
                  "用户要什么、已经做了什么（改了哪些文件、跑了什么、结果）、定下来的决定、还没做完的事。"
                  "只写事实，保留文件名、命令、数字原文，不加标题、不用列表。")


# an earlier hand-over quoted again (OpenCode → Codex → OpenCode): its context stays, its header and its "Go on with"
# go (the new agent read two "Go on with" lines, 10-08)
_HANDOVER_HEAD = re.compile(r"^\s*(?:This conversation moved from .{1,40}? to .{1,40}?\. The context so far:|这段对话从 .{1,40}? 换到了 .{1,40}?。之前的上下文：)\s*", re.S)
_HANDOVER_TAIL = re.compile(r"\n\s*(?:Go on with: |接着做：)[^\n]*\s*\Z")


def unwrap_handovers(turns):
    """[(who, text)] with an earlier hand-over message (Dispatch's words, not the person's) as the context it carried."""
    out = []
    for who, text in turns:
        if who in ("User", "用户") and _HANDOVER_HEAD.match(text or ""):
            inner = _HANDOVER_TAIL.sub("", _HANDOVER_HEAD.sub("", text, count=1)).strip()
            if inner:
                out.append((_t("Before the previous switch", "上次换 Agent 之前"), inner))
            continue
        out.append((who, text))
    return out


def rounds_of(turns):
    """[(who, text)] → [[(who, text), …]]: a round starts at each user message."""
    out = []
    for who, text in turns:
        if who in ("User", "用户") or not out:
            out.append([])
        out[-1].append((who, text))
    return out


def render(rounds, per_message=None):
    lines = []
    for r in rounds:
        for who, text in r:
            t = text if per_message is None or len(text) <= per_message else text[:per_message] + _t("…(cut)", "……（截断）")
            lines.append(_t(f"{'Person' if who in ('User', '用户') else who}: {t}", f"{'用户' if who in ('User', '用户') else who}：{t}"))
    return "\n\n".join(lines)


def fit_recent(rounds, budget):
    """The rounds verbatim if they fit in `budget`; else each message cut shorter until they do;
    at worst the oldest part is dropped (the latest turn matters most)."""
    text = render(rounds)
    cap = 4000
    while len(text) > budget and cap >= 200:
        text = render(rounds, cap)
        cap = cap * 2 // 3
    if len(text) > budget:
        text = "……" + text[-(budget - 1):]
    return text


def mechanical_summary(rounds, limit=SUMMARY_CHARS):
    """No model to write a summary: the user's messages of the earlier rounds, shortened."""
    asks = [text for r in rounds for who, text in r if who in ("User", "用户")]
    per = max(60, limit // max(1, len(asks)))
    text = "\n".join(_t(f"- The person said: {a[:per]}", f"- 用户说：{a[:per]}") for a in asks)
    return text[-limit:] if len(text) > limit else text


def summarize_earlier(rounds, model_call=None):
    """(summary, by): a model's summary of the earlier rounds, or the mechanical one."""
    if not rounds:
        return "", ""
    material = render(rounds, 700)
    if len(material) > SUMMARY_INPUT:
        material = material[: SUMMARY_INPUT // 3] + _t("\n\n…(middle left out)…\n\n", "\n\n……（中间省略）……\n\n") + material[-(SUMMARY_INPUT * 2 // 3):]
    try:
        if model_call is None:
            import summarize as S
            p = S.provider()
            if not p:
                raise RuntimeError("no summary model")
            text = S.chat(p, _t(SUMMARY_PROMPT_EN, SUMMARY_PROMPT), material, timeout=90, use="session")
            by = f"{p['id']}:{p['model']}"
        else:
            text, by = model_call(material)
        text = re.sub(r"\n{3,}", "\n\n", (text or "").strip())
        if text:
            return text[:SUMMARY_CHARS], by
    except Exception as e:  # a summary is a nicety: the switch goes on without the model
        print(f"The summary model did not respond ({e}); using excerpts from the earlier turns.", file=sys.stderr)
    return mechanical_summary(rounds), "excerpt"


def first_message(turns, src, dst, next_step="", recent=RECENT_ROUNDS, model_call=None, limit=MAX_CHARS):
    """(message, info): the whole hand-off as one message of at most `limit` characters."""
    rounds = rounds_of(unwrap_handovers(turns))
    earlier, last = rounds[:-recent] if recent else rounds, rounds[-recent:] if recent else []
    summary, by = summarize_earlier(earlier, model_call)
    head = _t(f"This conversation moved from {E.get(src).name} to {E.get(dst).name}. The context so far:\n\n", f"这段对话从 {E.get(src).name} 换到了 {E.get(dst).name}。之前的上下文：\n\n")
    tail = _t("\n\nGo on with: ", "\n\n接着做：") + (next_step.strip() or _t(DEFAULT_NEXT_EN, DEFAULT_NEXT))
    parts = []
    if summary:
        parts.append(_t(f"Summary of the {len(earlier)} earlier rounds\n{summary}", f"更早 {len(earlier)} 轮的摘要\n{summary}"))
    budget = limit - len(head) - len(tail) - sum(len(p) + 2 for p in parts) - 40
    if last:
        parts.append(_t(f"The last {len(last)} rounds as they were\n", f"最近 {len(last)} 轮原文\n") + fit_recent(last, max(200, budget)))
    if not parts:
        parts.append(_t("(The original session has no messages yet.)", "（原会话还没有消息。）"))
    msg = head + "\n\n".join(parts) + tail
    if len(msg) > limit:  # only when the summary itself is huge
        msg = msg[: limit - len(tail) - 1] + "…" + tail
    return msg, {"rounds": len(rounds), "recent_rounds": len(last), "summarized_rounds": len(earlier), "summary_by": by, "chars": len(msg)}


# ---------------------------------------------------------------- where the conversation is

def chat_rows():
    import chat_client as CC
    try:
        with CC.ChatClient.connect(D.DISPATCH_DIR) as c:
            return c.request("list")["sessions"]
    except (CC.NotRunning, CC.ChatError, OSError):
        return []


def find_source(target, rows=None, live=None, index=None):
    """{key, agent, session_id, cwd, title, source, chat} of the conversation to switch away from:
    a chatd session (key, id or its start, label, task), else a transcript Dispatch knows."""
    rows = chat_rows() if rows is None else rows
    for test in (lambda r: r["session"] == target,
                 lambda r: r["session"].split(":", 1)[-1].startswith(target),
                 lambda r: target in (r.get("task"), r.get("label"))):
        hit = [r for r in rows if test(r)]
        if hit:
            r = hit[0]
            agent, _, sid = r["session"].partition(":")
            return {"key": r["session"], "agent": agent, "session_id": sid, "cwd": r.get("cwd") or "", "title": r.get("label") or "",
                    "source": "chat", "chat": r}
    sid = target.split(":", 1)[-1] if ":" in target else target
    live = D.live_sessions(local_only=True) if live is None else live
    row = next((x for x in live if (x.get("session_id") or "").startswith(sid) and (":" not in target or x.get("agent") == target.split(":", 1)[0])), None)
    if row:
        return {"key": f"{row['agent']}:{row['session_id']}", "agent": row["agent"], "session_id": row["session_id"], "cwd": row.get("cwd") or "",
                "title": row.get("title") or "", "source": row.get("source") or "live", "chat": None, "worktree": row.get("worktree") or ""}
    refs = D.resolve(D.load_index() if index is None else index, target)
    if not refs and index is None:
        refs = D.resolve(D.refresh_index(), target)
    if refs:
        r = refs[0]
        return {"key": f"{r['agent']}:{r['session_id']}", "agent": r["agent"], "session_id": r["session_id"], "cwd": r.get("cwd") or "",
                "title": r.get("title") or "", "source": "transcript", "chat": None}
    raise SystemExit(f"Session {target} not found. See dispatch agent list or dispatch sessions.")


def title_of(src):
    from activity import session_preferences
    return (session_preferences(D.DISPATCH_DIR).get(src["key"]) or {}).get("title_override") or src.get("title") or ""


def mark(old_key, new_key, dst, title):
    """Both directions of the switch in the session preferences; the old title says where it went."""
    from activity import set_preferences
    set_preferences(D.DISPATCH_DIR, new_key, {"switched_from": old_key, **({"title_override": title[:120]} if title else {})})
    label = f"Switched to {E.get(dst).name}" + (f": {title}" if title else "")
    set_preferences(D.DISPATCH_DIR, old_key, {"switched_to": new_key, "title_override": label[:120]})


# ---------------------------------------------------------------- commands

def switch(a):
    target = E.find((a.to or "").strip().lower())
    dst = target.agent if target and target.runnable else None
    if not dst:
        raise SystemExit("Choose a target: " + E.join_words(("--to " + e.id for e in E.runnable()), "or"))
    src = find_source(a.target)
    if not E.get(src["agent"]).runnable:
        raise SystemExit(f"Only {E.join_words(e.name for e in E.runnable())} sessions can switch engines (this session uses {src['agent']}).")
    if src["agent"] == dst:
        raise SystemExit(f"This session already uses {E.get(dst).name}. To change the model: dispatch agent model <session> <model>")
    if (src.get("chat") or {}).get("lifecycle") in ("running", "starting", "waiting_permission", "waiting_input"):
        raise SystemExit("The current turn is still running. Wait for it to finish (dispatch agent wait), or stop it before switching.")
    import summarize as S
    tkey = src["key"]
    if src["source"] == "ide":
        # the window's session id is the host's; the transcript goes by the SDK's own id
        import ide_sessions
        tkey = ide_sessions.transcript_key(src["key"]) or tkey
    try:
        turns, meta, _ = S.transcript_turns(tkey)
    except (RuntimeError, ValueError, OSError) as e:
        # said plainly in the window, not as a Python traceback
        raise SystemExit(f"The conversation could not be read for the hand-over: {e}")
    cwd = src["cwd"] or meta.get("cwd") or ""
    msg, info = first_message(turns, src["agent"], dst, getattr(a, "prompt", "") or "")
    # the handoff is Dispatch's words in the new session's first message; only what to do next is the person's
    import own_prompts
    own_prompts.remember(msg, user=getattr(a, "prompt", "") or "")
    model = getattr(a, "model", "") or ""
    if src["source"] == "ide":
        # The Agents window starts the new session itself (dispatch.switchAgent in the extension).
        res = {"first_message": msg, "cwd": cwd, "agent": dst, "model": model, "from": src["key"], **info}
        return D.out(res, a.json, lambda r: print(r["first_message"]))
    if not os.path.isdir(cwd):
        raise SystemExit(f"The original session folder no longer exists: {cwd or '(not recorded)'}")
    import chat_client as CC
    title = title_of(src)
    chat = src.get("chat") or {}
    opts = {k: chat[k] for k in ("task", "label") if chat.get(k)}
    import chat_protocol as cp
    if chat.get("permission_mode") in cp.PERMISSION_MODES:
        opts["permission_mode"] = chat["permission_mode"]
    if model:
        opts["model"] = model
    with D.chat_client() as c:
        try:
            opened = c.request("open", agent=dst, cwd=cwd, timeout=120, **opts)
        except CC.ChatError as e:
            raise SystemExit(f"Could not start {E.get(dst).name}: {e}")
        key = opened["session"]
        mark(src["key"], key, dst, title)
        closed = False
        if chat:
            try:
                c.request("close", session=src["key"], timeout=30)
                closed = True
            except CC.ChatError as e:
                print(f"Could not close the original session: {e}", file=sys.stderr)
        try:
            turn = D.chat_turn(c, key, msg, getattr(a, "wait", True), getattr(a, "timeout", 600000) or 600000)
        except CC.ChatError as e:
            turn = {"prompt_sent": False, "status": "stalled", "output": "", "warning": f"Could not send the first message: {e}"[:200]}
    res = {"from": src["key"], "session": key, "agent": dst, "model": opened.get("model") or model, "cwd": D.ui_path(cwd),
           "closed_original": closed, "first_message": msg, **info, **turn}

    def text(r):
        print(_t(f"Moved from {E.get(src['agent']).name} to {E.get(dst).name}: {r['session']} · {r['cwd']}"
                 f" (with the last {r['recent_rounds']} rounds as they were" + (f" and a summary of {r['summarized_rounds']} earlier rounds" if r["summarized_rounds"] else "") + f", {r['chars']} characters)",
                 f"已从 {E.get(src['agent']).name} 换到 {E.get(dst).name}：{r['session']} · {r['cwd']}"
                 f"（带了最近 {r['recent_rounds']} 轮原文" + (f"和更早 {r['summarized_rounds']} 轮的摘要" if r["summarized_rounds"] else "") + f"，{r['chars']} 字）"))
        print(_t("The original session is closed and its title says it moved to %s", "原会话已关，标题改成「已换到 %s」") % E.get(dst).name if r["closed_original"]
              else _t("The original session is not one of Dispatch's in-app chats, so it was not closed; only its title changed", "原会话不在 Dispatch 的应用内对话里，没有关它，只改了标题"))
        if r.get("output"):
            print(r["output"].rstrip())
        elif r.get("warning"):
            print(r["warning"])
    return D.out(res, a.json, text)


def set_model(a):
    model = (a.text or getattr(a, "model", "") or "").strip()
    if not model:
        raise SystemExit("Choose a model: dispatch agent model <session> <model>")
    import chat_client as CC
    effort = None
    extra = (getattr(a, "extra", "") or "").split()
    if "--effort" in extra and extra.index("--effort") + 1 < len(extra):
        effort = extra[extra.index("--effort") + 1]
    with D.chat_client() as c:
        key = D.chat_target(c, a.target)
        try:
            st = c.request("set_model", session=key, model=model, timeout=60, **({"effort": effort} if effort else {}))
        except CC.ChatError as e:
            raise SystemExit(f"Could not change the model: {e}")
    res = {"session": key, "model": st.get("model") or model, "effort": st.get("effort") or effort or ""}
    return D.out(res, a.json, lambda r: print(f"{r['session']}: Next turn uses {r['model']}" + (f" (effort {r['effort']})" if r["effort"] else "")))


def cmd(a):
    return switch(a) if a.op == "switch" else set_model(a)
