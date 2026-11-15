# -*- coding: utf-8 -*-
"""`dispatch aside`: ask about one piece of an Agent's work without interrupting it.

The right panel shows every change an Agent made and every command it ran. Hover one diff hunk or
one command, ask 「为什么这么改」, and the answer comes from a separate one-off `claude -p` on Haiku
(no session saved, no tools): it gets that hunk (or that command and its output), what you said
that round and what the Agent wrote that round, 8 000 characters at most. The main Agent never
sees the question. Answers are kept in ~/tasks/.dispatch/aside/<session>.json so the panel shows
them again after a reopen.

Hunk numbering (mirror: fileHunks in app/src/activityPanel.ts): a file's hunks are its changes in
the session in order; an Edit or Write is one hunk, a unified patch (Codex) is one hunk per `@@`
section. `--hunk app/src/a.ts:2` is the second one, counted from 1.
"""
import datetime
import difflib
import json
import os
import re
import shutil
import subprocess
import time
import uuid
from lang import t as _t

CONTEXT_MAX = 8000
MODEL = "claude-haiku-4-5-20251001"
TIMEOUT = 120
FOLLOW_UPS = 3  # questions on one piece; after that the panel points to the main conversation
_PROMPT_MAX = 600
_EXPLAIN_MAX = 2000
_PRIOR_MAX = 1500
TRUNC_NOTE = _t("(The context passed {n} characters; part of it was left out: {what}.)", "（上下文超过 {n} 字，已截掉一部分：{what}。）")

SYSTEM_EN = ("You sit next to the person and help them understand what a coding agent just did. They point at one change (or one command) of the agent and ask a question. "
             "Answer only from the context you are given, in the language of the question, in plain words: one sentence with the answer first, then two or three sentences of reasons, six sentences at most; "
             "write names from the code exactly as they are. When the context does not show it, say so; never state a guess as fact. "
             "No pleasantries, no headings or lists, use no tools.")
SYSTEM = ("你在旁边帮用户看懂一个编程 Agent 刚做的事。用户指着 Agent 的一处改动（或一条命令）问了一个问题。"
          "只根据给你的上下文回答：简体中文，大白话，先一句结论，再两三句理由，总共不超过 6 句；"
          "提到代码里的名字照原样写。上下文里看不出来的就直说「从这段看不出来」，不要把猜测说成事实。"
          "不要客套，不要用标题和列表，不要使用任何工具。")


# ---------------------------------------------------------------- hunks
def split_patch(text):
    """A unified diff → one string per `@@` section (the file header lines dropped)."""
    text = text or ""
    lines = text.split("\n")
    parts, cur = [], None
    for line in lines:
        if line.startswith("@@"):
            if cur is not None:
                parts.append("\n".join(cur).rstrip("\n"))
            cur = [line]
        elif cur is not None:
            cur.append(line)
    if cur is not None:
        parts.append("\n".join(cur).rstrip("\n"))
    return parts or [text]


def file_hunks(changes):
    """A file's changes in the session → its hunks in order (see the module note)."""
    out = []
    for c in changes or []:
        if c.get("kind") == "patch" and c.get("new"):
            for part in split_patch(c["new"]):
                out.append({"kind": "patch", "text": part, "ts": c.get("ts") or "", "op": c.get("op")})
        else:
            out.append({"kind": c.get("kind") or "edit", "old": c.get("old") or "", "new": c.get("new") or "", "ts": c.get("ts") or ""})
    return out


def hunk_text(h):
    """What the model reads for one hunk: a unified diff, or the whole new file for a Write."""
    if h["kind"] == "patch":
        return h["text"]
    if h["kind"] == "write" and not h.get("old"):
        return _t("(the whole file is new)\n", "（新写了整个文件）\n") + h["new"]
    diff = difflib.unified_diff(h.get("old", "").split("\n"), h.get("new", "").split("\n"), _t("before", "改之前"), _t("after", "改之后"), lineterm="", n=3)
    return "\n".join(diff)


# ---------------------------------------------------------------- rounds and targets
def _epoch(ts):
    if isinstance(ts, (int, float)):
        return float(ts)
    s = str(ts or "").strip()
    if not s:
        return 0.0
    try:
        return datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def is_round_start(m):
    return m.get("role") == "user" and not m.get("synthetic") and bool((m.get("text") or "").strip())


def rounds_of(messages):
    """[(start epoch, what you said, [what the Agent wrote])] in order; work before the first message of yours is round 0."""
    rounds = [[0.0, "", []]]
    for m in messages or []:
        if is_round_start(m):
            rounds.append([_epoch(m.get("ts")), (m.get("text") or "").strip(), []])
        elif m.get("role") == "assistant":
            for b in m.get("blocks") or []:
                if b.get("type") == "text" and (b.get("text") or "").strip():
                    rounds[-1][2].append(b["text"].strip())
            if not m.get("blocks") and (m.get("text") or "").strip():
                rounds[-1][2].append(m["text"].strip())
    if len(rounds) > 1 and not rounds[0][2]:
        rounds = rounds[1:]
    return rounds


def round_at(rounds, ts):
    at = _epoch(ts)
    pick = rounds[0]
    for r in rounds:
        if r[0] <= at:
            pick = r
    return pick


def _rel(path, cwd):
    if cwd and (path == cwd or path.startswith(cwd.rstrip("/") + "/")):
        return os.path.relpath(path, cwd)
    return path


def find_file(files, name, cwd=""):
    """The file entry `name` points to: its absolute path, its path under the project, or a unique file name."""
    name = (name or "").strip()
    home = os.path.expanduser("~")
    full = os.path.join(home, name[2:]) if name.startswith("~/") else name
    for f in files or []:
        if f["path"] == full or _rel(f["path"], cwd) == name:
            return f
    same = [f for f in files or [] if os.path.basename(f["path"]) == os.path.basename(name)]
    return same[0] if len(same) == 1 else None


def parse_hunk_arg(arg):
    """'app/a.ts:2' → ('app/a.ts', 2); a path without a number means its first hunk."""
    m = re.match(r"^(.*):(\d+)$", arg or "")
    return (m.group(1), int(m.group(2))) if m else (arg or "", 1)


def find_target(detail, hunk=None, tool=None):
    """The piece a question is about, with its round; raises LookupError in words the panel can show."""
    cwd = (detail.get("meta") or {}).get("cwd") or ""
    rounds = rounds_of(detail.get("messages") or [])
    if hunk:
        name, n = parse_hunk_arg(hunk)
        f = find_file(detail.get("files") or [], name, cwd)
        if not f:
            raise LookupError(_t(f"This session did not change {name}", f"这个会话没改过 {name}"))
        hunks = file_hunks(f["changes"])
        if not 1 <= n <= len(hunks):
            raise LookupError(_t(f"{os.path.basename(f['path'])} has only {len(hunks)} changes, no change {n}", f"{os.path.basename(f['path'])} 只有 {len(hunks)} 处改动，没有第 {n} 处"))
        h = hunks[n - 1]
        rel = _rel(f["path"], cwd)
        return {"kind": "hunk", "key": f"hunk:{rel}:{n}", "label": _t(f"{rel} change {n} of {len(hunks)}", f"{rel} 第 {n} 处（共 {len(hunks)} 处）"), "path": f["path"],
                "index": n, "of": len(hunks), "text": hunk_text(h), "round": round_at(rounds, h["ts"])}
    if tool:
        for m in detail.get("messages") or []:
            for b in m.get("blocks") or []:
                if b.get("type") == "tool_call" and b.get("id") == tool:
                    inp = b.get("input") or {}
                    cmd = inp.get("command") or inp.get("cmd") or b.get("summary") or b.get("name")
                    if isinstance(cmd, list):
                        cmd = " ".join(map(str, cmd))
                    return {"kind": "tool", "key": f"tool:{tool}", "label": f"{b.get('name')} · {str(cmd).splitlines()[0][:60] if cmd else ''}",
                            "name": b.get("name"), "command": str(cmd or ""), "output": b.get("result") or "", "status": b.get("status"),
                            "round": round_at(rounds, b.get("ts") or m.get("ts"))}
        raise LookupError(_t(f"No tool call {tool} in this session", f"这个会话里找不到工具调用 {tool}"))
    raise LookupError(_t("Say --hunk <file>:<which change> or --tool <tool_id>", "要指定 --hunk <文件>:<第几处> 或 --tool <tool_id>"))


# ---------------------------------------------------------------- context
def _head(text, n):
    return text if len(text) <= n else text[: max(0, n - 1)] + "…"


def _tail(text, n):
    return text if len(text) <= n else "…" + text[-max(0, n - 1):]


def _middle(text, n):
    if len(text) <= n:
        return text
    keep = max(0, n - 20)
    return text[: keep * 2 // 3] + _t("\n…(middle left out)…\n", "\n…（中间省略）…\n") + text[-(keep - keep * 2 // 3):] if keep else ""


def build_context(target, prior=(), limit=CONTEXT_MAX):
    """(context text, [what was cut]). The piece itself keeps as much room as possible; what you said
    that round, what the Agent wrote and earlier questions on the same piece get fixed shares."""
    _, said, notes = target["round"]
    cut = []
    said_t = said.strip()
    if len(said_t) > _PROMPT_MAX:
        said_t = _head(said_t, _PROMPT_MAX); cut.append(_t("what you said this round", "你这一轮说的话"))
    explain = "\n\n".join(notes).strip()
    if len(explain) > _EXPLAIN_MAX:
        explain = _tail(explain, _EXPLAIN_MAX); cut.append(_t("the agent's notes this round (the last part kept)", "Agent 这一轮的说明（留了最后一段）"))
    qa = "\n".join(_t(f"Q: {p.get('q', '')}\nA: {p.get('answer', '')}", f"问：{p.get('q', '')}\n答：{p.get('answer', '')}") for p in prior)
    if len(qa) > _PRIOR_MAX:
        qa = _tail(qa, _PRIOR_MAX); cut.append(_t("earlier questions", "之前的追问"))
    if target["kind"] == "hunk":
        head = _t(f"## This change: {target['label']}\n```diff\n", f"## 这处改动：{target['label']}\n```diff\n")
        piece, tail = target["text"], "\n```"
    else:
        head = _t(f"## This command\n$ {target['command']}\n\n## Its output" + (" (not finished)" if target.get("status") == "running" else "") + "\n```\n",
                  f"## 这条命令\n$ {target['command']}\n\n## 它的输出" + ("（没跑完）" if target.get("status") == "running" else "") + "\n```\n")
        piece, tail = target["output"] or _t("(no output)", "（没有输出）"), "\n```"
    parts_before = [_t(f"## What the person said this round\n{said_t or '(work from before this round; no words go with it)'}", f"## 用户这一轮说的\n{said_t or '（这一轮之前的工作，没有对应的话）'}"),
                    _t(f"## What the agent wrote to the person this round\n{explain or '(no notes this round)'}", f"## Agent 这一轮写给用户的说明\n{explain or '（这一轮没写说明）'}")]
    if qa:
        parts_before.append(_t(f"## Asked here before\n{qa}", f"## 之前在这里问过\n{qa}"))
    fixed = "\n\n".join(parts_before) + "\n\n" + head + tail
    middle = _t("the middle of this change", "这段改动的中间部分") if target["kind"] == "hunk" else _t("the middle of the command's output", "命令输出的中间部分")
    note_room = len(TRUNC_NOTE.format(n=limit, what="、".join(cut + [middle]))) + 2
    room = limit - len(fixed) - note_room
    if len(piece) > room:
        piece = _middle(piece, max(0, room)); cut.append(middle)
    text = "\n\n".join(parts_before) + "\n\n" + head + piece + tail
    if cut:
        text += "\n\n" + TRUNC_NOTE.format(n=limit, what=_t(", ", "、").join(cut))
    return text[:limit], cut


def user_message(context, question):
    return f"{context}\n\n" + _t("## The person's question", "## 用户的问题") + f"\n{question.strip()}"


# ---------------------------------------------------------------- the model
def claude_bin():
    found = shutil.which("claude")
    if found:
        return found
    for p in (os.path.expanduser("~/.local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"):
        if os.path.exists(p):
            return p
    return ""


def ask_model(user, run=subprocess.run, model=MODEL, timeout=TIMEOUT):
    """One throwaway `claude -p`: Haiku, no tools, nothing saved (no transcript, so no new session in
    the lists), none of the person's settings, hooks or MCP servers (Dispatch's own hooks never see
    it; measured 2.8 s against 5.8 s with them), none of the caller's CLAUDE* markers."""
    exe = claude_bin()
    if not exe:
        raise RuntimeError(_t("No claude command on this Mac: asking about a change uses this Mac's Claude Code", "这台电脑上没找到 claude 命令，追问要用本机的 Claude Code"))
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE") and k not in ("DISPATCH_SESSION_ID",)}
    argv = [exe, "-p", _t(SYSTEM_EN, SYSTEM), "--model", model, "--output-format", "text", "--tools", "", "--no-session-persistence",
            "--setting-sources", "", "--strict-mcp-config"]
    r = run(argv, input=user, capture_output=True, text=True, encoding="utf-8", timeout=timeout, env=env, cwd=os.path.expanduser("~"))
    answer = (r.stdout or "").strip()
    if r.returncode != 0 or not answer:
        raise RuntimeError(_t("claude -p gave no answer: ", "claude -p 没给出回答：") + ((r.stderr or "").strip()[-200:] or f"exit {r.returncode}"))
    return answer


# ---------------------------------------------------------------- the cache
def cache_path(dispatch_dir, session):
    return os.path.join(dispatch_dir, "aside", re.sub(r"[^A-Za-z0-9._-]", "_", session) + ".json")


def load(dispatch_dir, session):
    try:
        with open(cache_path(dispatch_dir, session), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) and isinstance(d.get("items"), list) else {"items": []}
    except (OSError, ValueError):
        return {"items": []}


def save(dispatch_dir, session, data):
    path = cache_path(dispatch_dir, session)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def ask(detail, dispatch_dir, session, question, hunk=None, tool=None, run=subprocess.run, now=None):
    """Answer one question about one piece and keep it. Returns the stored item."""
    question = (question or "").strip()
    if not question:
        raise LookupError(_t("The question is empty", "问题是空的"))
    target = find_target(detail, hunk=hunk, tool=tool)
    data = load(dispatch_dir, session)
    prior = [i for i in data["items"] if i.get("target") == target["key"]]
    if len(prior) >= FOLLOW_UPS:
        raise LookupError(_t(f"This piece was asked about {FOLLOW_UPS} times already; ask the agent itself in the main conversation", f"这块已经问了 {FOLLOW_UPS} 次，再问就在主对话里问 Agent 本人"))
    context, cut = build_context(target, prior[-FOLLOW_UPS:])
    t0 = time.time()
    answer = ask_model(user_message(context, question), run=run)
    item = {"id": uuid.uuid4().hex[:10], "target": target["key"], "label": target["label"], "q": question, "answer": answer,
            "at": now if now is not None else round(time.time(), 3), "secs": round(time.time() - t0, 1), "model": MODEL,
            "truncated": bool(cut), "cut": cut, "context_chars": len(context)}
    data["items"].append(item)
    save(dispatch_dir, session, data)
    return item
