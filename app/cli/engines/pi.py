# -*- coding: utf-8 -*-
"""pi (Mario Zechner's pi-coding-agent): `pi`. Dispatch runs it in discussions (`pi -p --mode json`) and reads its
conversations (~/.pi/agent/sessions/.../<timestamp>_<id>.jsonl)."""
import glob
import json
import os
import re

from engines.base import Engine
from lang import t as _t


class Pi(Engine):
    id = "pi"
    name = "pi"
    color = "#5a7d2f"
    about = "A small, free, open-source assistant. You bring your own AI service key."
    bins = ("pi",)
    install_hint = "npm i -g @mariozechner/pi-coding-agent"
    real_match = "pi-coding-agent"  # `pi` is a common name: only its own package counts

    config_home = "{home}/.pi"
    rules_file = "{home}/.pi/agent/AGENTS.md"  # its global context file (plus AGENTS.md up from the folder)
    discuss_persona = _t("Short and direct: says only the most important point at a time, prefers the smallest version that can be checked, and says so when something is overdesigned.", "短句直给：一次只说最重要的一点，倾向先做最小可验证的版本，看到过度设计会直说。")

    # ---------------------------------------------------------------- its transcripts (~/.pi/agent/sessions/<folder>/<ts>_<id>.jsonl)
    transcript_by_folder = True

    def transcript_root(self, home):
        return os.path.join(home, ".pi", "agent", "sessions")

    def transcript_files(self, home):
        root = self.transcript_root(home)
        return [(p, os.path.relpath(p, root).split(os.sep)[0]) for p in glob.glob(os.path.join(root, "*", "*.jsonl"))]

    def index_session(self, e, path):
        # <timestamp>_<id>.jsonl; scripted runs (bots, batch jobs) use custom ids, not UUIDs: hidden like subagents
        b = os.path.splitext(os.path.basename(path))[0]
        e["session_id"] = b.split("_", 1)[1] if "_" in b else b
        e["subagent"] = not re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-", e["session_id"])
        e["entrypoint"] = "cli"

    def index_fold(self, e, buf, re_ts):
        e["user_msgs"] += len(re.findall(r'"type":"message"[^\n]{0,200}?"role":"user"', buf))
        e["assistant_msgs"] += len(re.findall(r'"type":"message"[^\n]{0,200}?"role":"assistant"', buf))
        for m in re.finditer(r'"type":"toolCall"[^}]*?"name":"([^"]+)"', buf):
            e["tools"][m.group(1)] = e["tools"].get(m.group(1), 0) + 1
        parse_stats(e, buf, re_ts)

    user_markers = (b'"role":"user"',)

    def history_message(self, d):
        m = d.get("message") or {}
        if d.get("type") == "message" and m.get("role") in ("user", "assistant"):
            return ("user" if m["role"] == "user" else "agent"), m.get("content")
        return None

    def detail_record(self, d, cx):
        """One transcript record into the session page's timeline."""
        import dispatch as D
        t = d.get("type")
        if t != "message":
            return
        m = d.get("message") or {}
        role, ts, c = m.get("role", ""), d.get("timestamp", ""), m.get("content")
        blocks_in = c if isinstance(c, list) else [{"type": "text", "text": c or ""}]
        blocks = []
        for b in blocks_in:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text":
                blocks.append({"type": "text", "text": (b.get("text") or "")[:D.LONG_TEXT]})
            elif bt == "thinking":
                blocks.append(D._thinking_block(b.get("thinking") or b.get("text") or "", _t("the content is redacted", "内容被打码") if b.get("redacted") else ""))
            elif bt == "toolCall":
                name = b.get("name", ""); inp = b.get("arguments") or b.get("input") or {}
                blocks.append(cx.tl.tool(ts, b.get("id"), name, inp, inp.get("command") or inp.get("path") or inp.get("file_path") or ""))
                fp = inp.get("path") or inp.get("file_path")
                if fp and name in ("edit", "write"):
                    cx.tl.note_file(fp, name, inp.get("oldText", ""), inp.get("newText", inp.get("content", "")), ts)
            elif bt == "toolResult":
                cx.tl.resolve(b.get("toolCallId") or b.get("id"), b.get("content") or b.get("output") or b.get("result"), bool(b.get("isError") or b.get("is_error")), ts)
        if role == "toolResult":
            cx.tl.resolve(m.get("toolCallId") or m.get("id"), c, bool(m.get("isError")), ts)
            return
        if role in ("user", "assistant") and any(b["type"] != "text" or b["text"].strip() for b in blocks):
            if role == "assistant":
                cx.assistant(ts, m.get("id") or d.get("id"), blocks)
            else:
                cx.other(cx.tl.add(ts, "user", blocks))
        return

    def first_prompt(self, d):
        m = d.get("message") or {}
        if d.get("type") != "message" or m.get("role") != "user":
            return None
        c = m.get("content")
        return c if isinstance(c, str) else "\n".join(b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text")

    def resume(self, sid, key=""):
        # a session file of its own is opened by its path
        is_file = key.startswith("/") or (len(key) > 2 and key[1] == ":" and key[2] in "\\/")
        return ["--session", key if is_file else sid], {}

    def models(self, refresh=False):
        # its configured default only (its full catalog is hundreds of provider models)
        d = default_model()
        return [{"id": "", "label": _t(f"Default ({d})", f"默认（{d}）") if d else _t("Default", "默认"), "default": d}]

    # ---------------------------------------------------------------- one run in the background
    headless_session_dir = True
    discuss_thinking = "low"  # its default level makes GLM-class models think longer than they talk

    def headless_new_session(self):
        import uuid
        return str(uuid.uuid4())

    def headless_argv(self, model, prompt, cwd, *, images=(), system="", session="", resume=False, lastfile="",
                      effort="", stdin_prompt=False, error_log=False, session_dir="", thinking=""):
        # it always runs under the id it is given (--session-id), new or resumed; pictures go along as @file
        return (["pi", "-p", "--mode", "json"] + (["--session-dir", session_dir] if session_dir else [])
                + (["--session-id", session] if session else []) + (["--model", model] if model else [])
                + (["--thinking", thinking] if thinking else []) + (["--append-system-prompt", system] if system else [])
                + ["--"] + [f"@{p}" for p in images] + [prompt])

    def live_events(self, ev):
        if ev.get("type") == "message_update":
            d = ev.get("assistantMessageEvent") or {}
            t = d.get("type")
            if t == "text_delta" and d.get("delta"):
                return [("text_delta", d["delta"])]
            if t == "text_start":
                return [("text_reset",)]
            if t == "thinking_start":
                return [("block_start", "thinking", "")]
            if t == "thinking_delta" and d.get("delta"):
                return [("thinking_delta", d["delta"])]
            if t == "toolcall_start":
                return [("block_start", "tool_use", (d.get("toolCall") or d.get("partial") or {}).get("name") or d.get("name") or "")]
            return []
        if ev.get("type") == "tool_execution_start":
            return [("tool", ev.get("toolName") or "", json.dumps(ev.get("args") or {}, ensure_ascii=False))]
        return []

    def run_result(self, stdout, stderr="", lastfile="", session=""):
        # --mode json: one event per line; the last assistant message_end carries text + usage
        text, error, usage = "", "", {}
        for line in stdout.splitlines():
            try:
                ev = json.loads(line)
            except Exception:
                continue
            m = ev.get("message") or {}
            if ev.get("type") == "message_end" and m.get("role") == "assistant":
                text = "".join(c.get("text", "") for c in m.get("content", []) if c.get("type") == "text") or text
                u = m.get("usage") or {}
                usage = {"input": u.get("input", 0), "cached": u.get("cacheRead", 0), "output": u.get("output", 0)}
            elif ev.get("type") == "error":
                error = (ev.get("message") or ev.get("error") or _t("pi reported an error", "pi 报错"))[:200]
        if not text and not error and stdout.strip() and not stdout.lstrip().startswith("{"):
            text = stdout.strip()
        return {"text": text, "session": session, "error": error, "usage": usage}



def default_model():
    import os
    import dispatch as D
    try:
        s = json.load(open(os.path.join(D.HOME, ".pi", "agent", "settings.json")))
        return s.get("defaultModel") or ""
    except Exception:
        return ""



# ---------------------------------------------------------------- the index's usage stats of a transcript
def parse_stats(e, buf, re_ts):
    """pi session files: {"type":"message","message":{role, content, provider, model, usage{input,output,cacheRead,cacheWrite}}}."""
    import dispatch as D
    for line in buf.split("\n"):
        if not line.startswith("{") or '"type":"message"' not in line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        m = d.get("message") or {}
        ts = d.get("timestamp", "")
        if m.get("role") == "assistant":
            u = m.get("usage") or {}
            i, o, cr, cw = (u.get("input", 0) or 0), (u.get("output", 0) or 0), (u.get("cacheRead", 0) or 0), (u.get("cacheWrite", 0) or 0)
            T = e["tokens"]; T["in"] += i; T["out"] += o; T["cr"] += cr; T["cw"] += cw
            if m.get("model"):
                e["models"][m["model"]] = e["models"].get(m["model"], 0) + 1
            D.bump_time(e, D.local_dt(ts), 1, i + o + cr + cw, (i, o, cr, cw))
        elif m.get("role") == "user":
            D.bump_time(e, D.local_dt(ts), 1, 0)


ENGINE = Pi()
