# -*- coding: utf-8 -*-
"""Claude Code (Anthropic): `claude`. Its chat runs `claude -p` with stream-json (chat_claude.py)."""
import glob
import json
import os
import re
import shlex
import sys

from engines.base import Engine
from lang import t as _t


# what claude -p prints instead of an answer when the account is out of allowance
LIMIT_NOTICE = re.compile(r"^(?:you(?:'|\u2019)ve (?:hit|reached) your (?:[\w-]+ )*limit\b|claude ai usage limit reached\b)", re.I)

class Claude(Engine):
    id = "claude"
    agent = "claude-code"
    name = "Claude Code"
    short_name = "Claude"
    maker = "Anthropic"
    provider = "claude"
    icon = "claude"
    glyph = ("codicon.ttf", "\uec82")
    color = "#c8693a"
    commit_trailer = "Claude <noreply@anthropic.com>"
    about = "Anthropic's coding assistant. Works with a Claude subscription or an Anthropic API key."
    bins = ("claude",)
    # its own installer keeps one binary per version under ~/.local/share/claude
    env_markers = ("CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT")
    session_env = ("CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID")
    env_prefix = "CLAUDE"
    activity_stream = True
    process_patterns = (r"/claude/versions/[^/]+$", r"/\.local/share/claude/")

    config_home = "{home}/.claude"
    rules_file = "{home}/.claude/CLAUDE.md"
    rules_import = True
    hooks_text = "one Dispatch hook (session brief, activity, task plans, context reminders) and the status line"
    hooks_note = "your own hooks and status line keep running"
    service = "anthropic"
    servers = "Claude's servers"
    discuss_persona = _t("Leans to architecture and acceptance: asks first whether it is worth doing and how it will be checked, and splits a plan into steps that can be delivered.", "偏架构和验收：先问值不值得做、做完怎么验证，习惯把方案拆成可交付的步骤。")

    chat_min_version = (2, 1, 200)  # what the spike verified (2026-09-25); older is refused at hello and at open

    package = "@anthropic-ai/claude-code"
    brew = ("--cask", "claude-code")
    install_script = "https://claude.ai/install.sh"
    self_update_args = ("update",)
    login_args = ("auth", "login")
    skills = ("{claude}/skills",)

    # slash commands Dispatch runs in its sessions, and the ones it has only in its own terminal with Dispatch's
    # way to the same thing: (where, go) (slash.py explains the grey rows)
    slash_commands = ("compact", "context", "usage", "init", "security-review", "recap", "goal")
    terminal_commands = {
        "resume": ("Your sessions are in Sessions on the left", "sessions"),
        "config": ("Claude Code's settings are in Customizations › Claude Code", "customizations:harnessSettings"),
        "permissions": ("Use the permission picker under the input", "permissions"),
        "memory": ("CLAUDE.md files are in Customizations › Instructions", "customizations:instructions"),
        "login": ("Sign in from Accounts in the title bar", "accounts"),
        "logout": ("Sign out from Accounts in the title bar", "accounts"),
        "status": ("Account and model are in Accounts in the title bar; /usage shows the limits here", "accounts"),
        "reset": ("Here it is /clear", "alias:clear"),
        "settings": ("Claude Code's settings are in Customizations › Claude Code", "customizations:harnessSettings"),
        "effort": ("Pick the effort next to the model under the input", ""),
        "fast": ("Pick the model and effort under the input", ""),
        "keybindings": ("", ""),
        "color": ("", ""),
        "autocompact": ("", ""),
        "usage-credits": ("", ""),
        "ultrareview": ("", ""),
        "heapdump": ("", ""),
        "doctor": ("", ""),
        "vim": ("", ""),
        "statusline": ("", ""),
        "terminal-setup": ("", ""),
        "theme": ("", ""),
        "add-dir": ("", ""),
        "export": ("", ""),
        "rewind": ("", ""),
        "ide": ("", ""),
        "exit": ("", ""),
        "help": ("", ""),
        "feedback": ("", ""),
        "bug": ("", ""),
        "release-notes": ("", ""),
        "upgrade": ("", ""),
        "privacy-settings": ("", ""),
        "output-style": ("", ""),
        "install-github-app": ("", ""),
    }

    # ---------------------------------------------------------------- its transcripts (~/.claude/projects/<folder>/<id>.jsonl)
    transcript_by_folder = True

    def rules_target(self, home=None):
        # CLAUDE_CONFIG_DIR's CLAUDE.md when Claude Code keeps its folder there (it reads its rules from there then)
        t = super().rules_target(home)
        if t and os.environ.get("CLAUDE_CONFIG_DIR"):
            folder = config_dir(home or os.path.expanduser("~"))
            t = dict(t, path=os.path.join(folder, "CLAUDE.md"), home=folder)
        return t

    def transcript_root(self, home):
        return os.path.join(config_dir(home), "projects")

    def transcript_files(self, home):
        root = self.transcript_root(home)
        return [(p, os.path.relpath(p, root).split(os.sep)[0]) for p in glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True)]

    def index_session(self, e, path):
        import dplatform as P
        e["session_id"] = os.path.splitext(os.path.basename(path))[0]
        if e["subagent"]:
            e["parent"] = (P.to_slash(path) if P.IS_WIN else path).split("/subagents/")[0].rsplit("/", 1)[-1]

    def index_fold(self, e, buf, re_ts):
        e["user_msgs"] += buf.count('"type":"user"')
        e["assistant_msgs"] += buf.count('"type":"assistant"')
        parse_stats(e, buf, re_ts)

    user_markers = (b'"type":"user"',)

    def history_message(self, d):
        t = d.get("type")
        if t not in ("user", "assistant") or d.get("isSidechain") or d.get("isMeta"):
            return None
        c = (d.get("message") or {}).get("content")
        if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
            return None
        return ("user" if t == "user" else "agent"), c

    def attachment_message(self, record):
        if record.get("type") == "attachment":
            # a message queued while it worked: its pasted pictures ride in the prompt's blocks
            a = record.get("attachment") if isinstance(record.get("attachment"), dict) else {}
            if a.get("type") != "queued_command" or not isinstance(a.get("prompt"), list):
                return None
            return {"role": "user", "content": a["prompt"]}
        return super().attachment_message(record)

    def typed_skip(self, line):
        return b'"tool_use_id"' in line or b'"isMeta":true' in line or b'"isSidechain":true' in line

    def transcript_of(self, sid, home, cwd=""):
        if cwd:  # the folder it keeps a project's transcripts in is the folder's path with every other character a dash
            import chat_claude
            return [chat_claude.transcript_path(cwd, sid)]
        return glob.glob(os.path.join(config_dir(home), "projects", "*", f"{sid}.jsonl"))

    def side_folder(self, path, sid):
        return os.path.join(os.path.dirname(path), sid)

    def folder_transcripts(self, home, folder):
        out = []
        for f in glob.glob(os.path.join(transcript_folder(home, folder), "*.jsonl")):
            try:
                out.append((os.path.getmtime(f), os.path.basename(f)[:-6], f))
            except OSError:
                pass
        return out

    def own_title(self, path, sid, home):
        # an `ai-title` record in its transcript (also its terminal title); the last one wins
        title = ""
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if '"ai-title"' in line:
                        try:
                            title = json.loads(line).get("aiTitle") or title
                        except ValueError:
                            pass
        except OSError:
            pass
        return title.strip()

    def subagents(self, path):
        """Its sub-agents' transcripts sit next to the parent's: <sid>/subagents/agent-<id>.{jsonl,meta.json}."""
        import time
        base = os.path.splitext(path)[0]
        res = []
        for meta in sorted(glob.glob(os.path.join(base, "subagents", "*.meta.json"))):
            try:
                m = json.load(open(meta, encoding="utf-8"))
            except Exception:
                m = {}
            jl = meta.replace(".meta.json", ".jsonl")
            aid = os.path.basename(meta).replace(".meta.json", "").replace("agent-", "")
            st = os.stat(jl) if os.path.exists(jl) else None
            # a background sub-agent keeps appending to its transcript; one that stopped writing two minutes ago is done
            res.append({"agent_id": aid, "type": m.get("agentType", ""), "description": m.get("description", ""), "tool_use_id": m.get("toolUseId", ""),
                        "depth": m.get("spawnDepth", 1), "size": st.st_size if st else 0, "last_at": st.st_mtime if st else 0, "path": jl,
                        "running": bool(st) and time.time() - st.st_mtime < 120})
        return res

    def detail_record(self, d, cx):
        """One transcript record into the session page's timeline (a message the person queued while it worked is
        their message at that moment; sub-agent records only on a sub-agent's own page)."""
        import dispatch as D
        import activity as A
        t = d.get("type")
        if t == "attachment":
            # A message the person queued while Claude Code was working: it never becomes a user
            # turn — Claude Code folds it into the running turn and logs this record at that moment.
            # Show it as the person's message so the conversation reads the way it happened.
            att = d.get("attachment") if isinstance(d.get("attachment"), dict) else {}
            # A queued message with a pasted picture arrives as content blocks, not a string.
            raw_prompt = att.get("prompt")
            prompt = D._block_text(raw_prompt) if isinstance(raw_prompt, list) else str(raw_prompt or "")
            q_images = D._block_images(raw_prompt) if isinstance(raw_prompt, list) else []
            if att.get("type") == "queued_command" and (prompt.strip() or q_images):
                ts_q = d.get("timestamp") or att.get("timestamp") or ""
                if A.is_synthetic_user(prompt):
                    # Background-task notices ride the same queue: a system event, not the person.
                    m2 = re.search(r"<summary>([\s\S]*?)</summary>", prompt)
                    cx.other(cx.tl.add(ts_q, "user", [{"type": "text", "text": (m2.group(1).strip() if m2 else prompt.strip())[:600]}], synthetic=True))
                else:
                    extra = {"images": q_images} if q_images else {}
                    cx.other(cx.tl.add(ts_q, "user", [{"type": "text", "text": prompt[:D.LONG_TEXT]}], queued=True, **extra))
            return
        if t not in ("user", "assistant"):
            return
        if d.get("isSidechain") and not cx.ref.get("subagent_view"):
            return
        m = d.get("message") or {}
        content = m.get("content")
        ts = d.get("timestamp", "")
        if t == "assistant" and m.get("model") and not str(m["model"]).startswith("<"):  # "<synthetic>": Claude Code's own notices
            cx.tl.model = m["model"]
        if t == "user":
            if isinstance(content, list) and content and isinstance(content[0], dict) and content[0].get("type") == "tool_result":
                cx.state["seen_tool_images"] = D._block_images(content)  # a picture the agent looked at; shown with the caption turn that follows
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        cx.tl.resolve(b.get("tool_use_id"), b.get("content"), bool(b.get("is_error")), ts)
                return
            txt = D._block_text(content)
            if re.fullmatch(r"\s*(\[Image:[^\]]*\]\s*)+", txt) and not D._block_images(content):
                if cx.state["seen_tool_images"]:
                    cx.other(cx.tl.add(ts, "tool", [{"type": "text", "text": _t("looked at an image", "查看了图片")}], images=cx.state["seen_tool_images"]))
                cx.state["seen_tool_images"] = []
                return
            # Slash-command echoes and caveats are injected by the CLI, not typed by the user.
            if txt.lstrip().startswith(("<local-command", "<command-name>", "<command-message>", "<system-reminder>")):
                return
            images = D._block_images(content)
            if images:
                # The "[Image: original …]" caption only describes the picture; show the picture.
                txt = re.sub(r"\[Image:[^\]]*\]", "", txt).strip()
            images += [i for i in D._text_images(txt, cx.ref.get("cwd", "")) if i not in images]
            if A.is_synthetic_user(txt):
                # Hook output / background-task notice: shown as a system event, never as "you said".
                # A sub-agent's notice can carry a picture it produced (a QR code, a screenshot): keep it.
                m2 = re.search(r"<summary>([\s\S]*?)</summary>", txt)
                cx.other(cx.tl.add(ts, "user", [{"type": "text", "text": (m2.group(1).strip() if m2 else txt.strip())[:600]}], synthetic=True, **({"images": images} if images else {})))
                return
            if txt.strip() or images:
                cx.other(cx.tl.add(ts, "user", [{"type": "text", "text": txt[:D.LONG_TEXT]}], **({"images": images} if images else {})))
        else:
            blocks = []
            for b in content if isinstance(content, list) else ([{"type": "text", "text": content}] if isinstance(content, str) else []):
                if not isinstance(b, dict):
                    continue
                bt = b.get("type")
                if bt == "text":
                    blocks.append({"type": "text", "text": (b.get("text") or "")[:D.LONG_TEXT]})
                elif bt == "thinking":
                    blocks.append(D._thinking_block(b.get("thinking") or ""))
                elif bt == "redacted_thinking":
                    blocks.append(D._thinking_block("", _t("the content is redacted", "内容被打码")))
                elif bt == "tool_use":
                    name = b.get("name", "")
                    inp = b.get("input") or {}
                    summary = inp.get("command") or inp.get("file_path") or inp.get("description") or inp.get("prompt") or inp.get("pattern") or inp.get("url") or ""
                    blocks.append(cx.tl.tool(ts, b.get("id", ""), name, inp, summary))
                    fp = inp.get("file_path")
                    if name == "Edit" and fp:
                        cx.tl.note_file(fp, "edit", inp.get("old_string", ""), inp.get("new_string", ""), ts)
                    elif name == "Write" and fp:
                        cx.tl.note_file(fp, "write", "", inp.get("content", ""), ts)
                    elif name in ("NotebookEdit",) and fp:
                        cx.tl.note_file(fp, "edit", "", inp.get("new_source", ""), ts)
            if any(b["type"] != "text" or b["text"].strip() for b in blocks):
                shots = D._text_images("\n".join(b["text"] for b in blocks if b["type"] == "text"), cx.ref.get("cwd", ""))
                cx.assistant(ts, m.get("id") or d.get("requestId"), blocks, **({"images": shots} if shots else {}))

    def life_skips(self, row, subagent):
        # a sub-agent's records in the parent's transcript are not the parent's context
        return not subagent and bool(row.get("isSidechain") or row.get("parent_tool_use_id"))

    def life_feed(self, meter, row, ordinal):
        """One transcript record into the context lifetime meter (session_life.Meter): rounds, messages, tool steps, usage; a
        compact_boundary starts a new context."""
        import session_life as L
        d = meter.data
        typ = row.get("type")
        if typ == "system" and row.get("subtype") == "compact_boundary":
            meter.reset()
        msg = row.get("message") or {}
        content = msg.get("content") or []
        ident = row.get("uuid") or msg.get("id") or str(ordinal)
        if typ == "user" and not row.get("isMeta"):
            if isinstance(content, str) or any(b.get("type") == "text" for b in content if isinstance(b, dict)):
                if meter.once("user", ident):
                    d["rounds"] += 1
                    d["messages"] += 1
        elif typ == "assistant":
            d["model"] = msg.get("model") or d["model"]
            rid = row.get("requestId") or msg.get("id") or ident
            if msg.get("usage"):
                meter.usage(L.claude_usage(msg["usage"]), rid)
            if meter.once("assistant", msg.get("id") or rid):
                d["messages"] += 1
            for b in content if isinstance(content, list) else []:
                if isinstance(b, dict) and b.get("type") == "tool_use" and meter.once("tool", b.get("id") or ident):
                    d["tool_steps"] += 1

    def first_prompt(self, d):
        if d.get("type") != "user" or d.get("isSidechain"):
            return None
        c = (d.get("message") or {}).get("content")
        return c if isinstance(c, str) else "\n".join(b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text")

    def resume(self, sid, key=""):
        return ["--resume", sid], {}

    terminal_recipe = {"start": "--session-id {session}", "resume": "--resume {session}",
                       "fork": "--resume {session} --fork-session --session-id {new}"}

    # the built-in commands the reply page offers in its sessions: (name, what it does)
    builtin_commands = (
        ('compact', '压缩对话上下文，后面可加一句要保留的重点'),
        ('clear', '清空对话，开始新任务'),
        ('context', '看当前上下文占用'),
        ('cost', '看本会话用量与额度'),
        ('status', '会话与账号状态'),
        ('model', '切换模型'),
        ('memory', '查看/编辑记忆文件'),
        ('review', '审查当前改动'),
        ('rewind', '回退到之前的对话或代码状态'),
        ('resume', '恢复另一个会话'),
        ('init', '生成 CLAUDE.md'),
        ('permissions', '权限设置'),
        ('mcp', 'MCP 服务器'),
        ('export', '导出对话'),
        ('doctor', '诊断安装'),
        ('help', '帮助'),
    )

    def terminal_turn_args(self, env):
        # its hooks in a settings file of its own: added to the person's settings, not written into them
        return f"--settings {shlex.quote(write_terminal_settings())}"

    def terminal_permission_args(self, mode):
        return f"--permission-mode {mode}" if mode in ("acceptEdits", "bypassPermissions") else ""

    def turn_state(self, event, payload):
        import terminal_hook
        state = TURN_EVENTS.get(event)
        if state == "needs_you" and payload.get("notification_type") not in TERMINAL_ASKS:
            return None, "", ""
        if state == "finished":
            text = payload.get("last_assistant_message") or last_words(payload.get("transcript_path") or "")
            return state, terminal_hook.last_line(text), ""
        if state == "needs_you":
            return state, payload.get("message") or "", ""
        if state == "stopped":
            return state, "", str(payload.get("error") or payload.get("reason") or "")
        return state, "", ""

    # ---------------------------------------------------------------- one run in the background
    headless_stdin_prompt = True
    headless_reads_pictures = True

    def headless_new_session(self):
        import uuid
        return str(uuid.uuid4())

    def headless_argv(self, model, prompt, cwd, *, images=(), system="", session="", resume=False, lastfile="",
                      effort="", stdin_prompt=False, error_log=False, session_dir="", thinking=""):
        # `claude -p` without a prompt argument reads it from stdin; it reads pictures itself (Read), so none go along
        return (["claude", "-p"] + ([] if stdin_prompt else [prompt])
                + ["--output-format", "stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions"]
                + (["--model", model] if model else []) + (["--effort", effort] if effort else [])
                + (["--append-system-prompt", system] if system else [])
                + (["--resume", session] if resume and session else ["--session-id", session] if session else []))

    def live_events(self, ev):
        t = ev.get("type")
        if t == "stream_event":
            e = ev.get("event") or {}
            d = e.get("delta") or {}
            if e.get("type") == "content_block_start":
                cb = e.get("content_block") or {}
                return [("block_start", cb.get("type", ""), cb.get("name", ""))]
            if d.get("type") == "text_delta" and d.get("text"):
                return [("text_delta", d["text"])]
            if d.get("type") == "thinking_delta" and d.get("thinking"):
                return [("thinking_delta", d["thinking"])]
            if d.get("type") == "input_json_delta":
                return [("input_delta", d.get("partial_json") or "")]
            if e.get("type") == "content_block_stop":
                return [("block_stop",)]
            return []
        if t == "assistant":
            # a whole message (after tool use the text so far is repeated)
            parts = [c.get("text", "") for c in ((ev.get("message") or {}).get("content") or []) if c.get("type") == "text"]
            return [("message", "".join(parts))] if parts else []
        if t == "user":
            return [("tool_result",)]  # the tool answered; it reads it and goes on
        return []

    def steps(self, ev):
        return self.record_steps(ev)  # its stream-json events and its transcript records have the same shape

    def model_window(self, model, provider=""):
        model = model.lower().replace(" ", "-").replace(".", "-")
        if "[1m]" in model:
            return 1000000
        for name, window in WINDOWS.items():
            if re.search(r"(?:^|[-/])" + name + r"(?:$|-(?:\d{8})(?:$|[^0-9])|[:\[])", model):
                return window
        return 0

    def record_steps(self, record):
        if record.get("type") != "assistant":
            return []
        content = (record.get("message") or {}).get("content")
        if isinstance(content, str):
            return [("text", content)]
        out = []
        for b in content or []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use":
                out.append(("tool", b.get("name") or "", b.get("input")))
            elif b.get("type") == "text":
                out.append(("text", b.get("text") or ""))
        return out

    def final_text(self, stdout, lastfile=""):
        for line in (stdout or "").splitlines():
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "result":
                return ev.get("result") or ""
        return stdout or ""

    def run_result(self, stdout, stderr="", lastfile="", session=""):
        d, sid, text, error, usage = {}, session, "", "", {}
        for line in stdout.splitlines():
            try:
                ev = json.loads(line)
            except Exception:
                continue
            if ev.get("type") == "result":
                d = ev
            elif ev.get("type") == "system" and ev.get("subtype") == "init":
                sid = ev.get("session_id") or sid
        if d:
            text = d.get("result") or ""
            sid = d.get("session_id") or sid
            u = d.get("usage") or {}
            usage = {"input": u.get("input_tokens", 0), "cached": u.get("cache_read_input_tokens", 0), "output": u.get("output_tokens", 0)}
            if d.get("total_cost_usd") is not None:
                usage["cost_usd"] = d.get("total_cost_usd")
            if d.get("is_error"):
                error = (text or d.get("subtype") or _t("claude reported an error", "claude 报错"))[:200]
        else:
            error = (stderr or stdout).strip()[-300:] or _t("claude gave no output", "claude 没有输出")
        return {"text": text, "session": sid, "error": error, "usage": usage}

    accounts_driver = ("accounts", "ClaudeLogin")
    quota_names_plan = False  # the status line's model, not the plan: the plan comes from the login

    def own_quota(self):
        return own_quota()

    default_effort = "high"

    def subagent_folder(self, home, env):
        # Claude Code's folder is ~/.dispatch/agents itself: Dispatch's own place
        import dispatch_dir as DD
        claude = env.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude")
        return DD.path("agents"), ".md", [os.path.join(claude, "agents")]

    def subagent_text(self, d):
        return d["text"]

    def models(self, refresh=False):
        return model_options(fetch_models(refresh), extra_models())

    # ---------------------------------------------------------------- one answer, nothing else
    def answer(self, path, system, user, *, model="", timeout=90, cwd=None, env=None,
               no_tools="Do not use any tools and do not read or write files. Answer directly."):
        # the prompt is the system text, the rest comes on stdin; --no-session-persistence: an answer must not leave a
        # transcript behind (every run would become a "session" that floods the index and gets summarized itself)
        import shutil
        import subprocess
        import tempfile
        import dplatform as P
        work = tempfile.mkdtemp(prefix="dispatch-answer-")
        try:
            r = subprocess.run([path, "-p", system, "--model", model or "haiku", "--output-format", "text", "--tools", "",
                                "--no-session-persistence"], input=user, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=timeout, env=env, cwd=cwd or work, creationflags=P.no_window_flags())
        finally:
            shutil.rmtree(work, ignore_errors=True)
        text = r.stdout.strip()
        # a failed run's words are not an answer: "You've hit your weekly limit" became a separate copy's folder name
        if r.returncode != 0 or LIMIT_NOTICE.match(text):
            why = (r.stderr or "").strip() or text or f"exit {r.returncode}"
            raise RuntimeError("claude -p failed: " + why[-200:])
        return text

    def answer_models(self, purpose="summary"):
        if purpose == "summary":
            return [{"id": "haiku", "label": "Claude Haiku", "note": "lowest cost"}, {"id": "sonnet", "label": "Claude Sonnet"}]
        return [{"id": f, "label": "Claude " + f.capitalize()} for f in FAMILIES]

    hook_presence = True
    hooks_json = True
    # Dispatch's entry (hook.py) on these events of ~/.claude/settings.json, and what it does on each
    hook_routes = {"SessionStart": ("presence", "prime"), "UserPromptSubmit": ("presence", "life"),
                   "PreToolUse": ("presence", "edit-guard"), "PostToolUse": ("presence", "edit-guard", "plan", "life"),
                   "PostToolUseFailure": ("presence",), "Notification": ("presence",), "PermissionRequest": ("presence",),
                   "Stop": ("presence", "life"), "SubagentStop": ("life",), "SessionEnd": ("presence",)}
    hook_options = {e: {"timeout": 30} for e in hook_routes}
    hook_options["SessionStart"] = {"matcher": "", "timeout": 45}  # every start: new, resumed, cleared, compacted
    edit_tools = ("Edit", "Write", "MultiEdit", "NotebookEdit")
    plan_tools = ("TodoWrite",)
    life_hooks = ("UserPromptSubmit", "PostToolUse", "Stop", "SubagentStop")
    hook_children = True

    def hooks_file(self, home):
        return os.path.join(config_dir(home), "settings.json")

    def install_hooks(self, path=None, env=None, trust=None):
        import hooks_setup
        path = path or self.hooks_file(hooks_setup.home())
        res = hooks_setup.install(self, path, env=env, trust=trust)
        if not res.get("skipped"):
            res["kept_statusline"] = install_statusline(path)
        return res

    def uninstall_hooks(self, path=None, env=None):
        import hooks_setup
        path = path or self.hooks_file(hooks_setup.home())
        removed = hooks_setup.uninstall(self, path)
        return uninstall_statusline(path) or removed

    def sign_in_status(self, path, env):
        import onboarding
        env = dict(env)
        env.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
        code, out, _ = onboarding._run([path, "auth", "status", "--json"], 12, env)
        try:
            d = json.loads(out)
        except ValueError:
            return "Sign-in unknown"
        if not d.get("loggedIn"):
            return "Not signed in"
        plan = (d.get("subscriptionType") or "").strip()
        return "Signed in" + (f" · {plan.capitalize()} plan" if plan else "")

    chat_driver = ("chat_claude", "ClaudeAdapter")
    chat_picks_session_id = True
    chat_single_writer = True  # Claude Code has no lock: two writers fork the transcript silently
    chat_sleeps_when_idle = True
    chat_account_restart = "process"
    chat_takes_terminal = True

    slash_skills = True
    slash_folder = "{home}/.claude"

    def chat_owns_process(self, pid, session_id):
        """A `claude -p` started for this session (not a reused pid)."""
        try:
            import subprocess
            out = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout
        except Exception:
            return False
        return "claude" in out and session_id in out and "stream-json" in out

    def native_install(self, real_path):
        return "/.local/share/claude/" in real_path or "/.claude/local/" in real_path

    # ---------------------------------------------------------------- MCP servers
    # ~/.claude.json (or $CLAUDE_CONFIG_DIR/.claude.json) "mcpServers" (user scope); projects[<folder>].mcpServers
    # (local scope) and <folder>/.mcp.json (project scope). Per project: projects[<folder>] disabledMcpServers (servers
    # of the user or of that folder), enabledMcpjsonServers / disabledMcpjsonServers (the folder's .mcp.json, which
    # Claude Code asks about the first time): the same lists its own /mcp writes.
    mcp_in_home = True
    mcp_signin = "in a Claude Code session run /mcp, pick {name}, Authenticate (a browser page opens)"

    def mcp_file(self, home, env):
        folder = env.get("CLAUDE_CONFIG_DIR")
        return os.path.join(folder, ".claude.json") if folder else os.path.join(home, ".claude.json")

    def mcp_rows(self, path, cwd=""):
        import mcp_config as M
        text = M._read(path)
        data = json.loads(text) if text else {}
        rows = [M.json_row(name, v, "user", path, self.agent) for name, v in (data.get("mcpServers") or {}).items()]
        if cwd:
            folder = os.path.realpath(cwd)
            for name, v in (((data.get("projects") or {}).get(folder) or {}).get("mcpServers") or {}).items():
                rows.append(M.json_row(name, v, "local", path, self.agent))
            shared = os.path.join(folder, ".mcp.json")
            for name, v in (json.loads(M._read(shared) or "{}").get("mcpServers") or {}).items():
                rows.append(M.json_row(name, v, "project", shared, self.agent))
        return rows

    def mcp_edit(self, path, name, spec):
        import mcp_config as M
        return M.json_edit(path, name, M.json_entry(spec) if spec else None)

    def mcp_raw(self, path, name):
        import mcp_config as M
        return (json.loads(M._read(path) or "{}").get("mcpServers") or {}).get(name)

    def mcp_allow_file(self, home):
        return os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude"), "settings.json")

    def mcp_allow(self, name, home=None):
        # settings.json permissions.allow: "mcp__<server>" lets every tool of that server run without a prompt. One the
        # person denied (permissions.deny) stays denied: deny wins in Claude Code, and Dispatch does not take it out.
        import mcp_config as M
        import dispatch as D
        path = self.mcp_allow_file(home or D.HOME)
        text = M._read(path)
        data = json.loads(text) if text and text.strip() else {}
        perms = data.setdefault("permissions", {})
        allow = perms.setdefault("allow", [])
        rule = "mcp__" + name
        if rule in allow or rule in (perms.get("deny") or []):
            return None
        allow.append(rule)
        M._write(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        return path

    def mcp_spec(self, name, raw):
        import mcp_config as M
        return M.json_spec(raw)

    def mcp_project(self, folder, user_path, env):
        import mcp_config as M
        data = M._json_file(user_path)
        project = (data.get("projects") or {}).get(folder) or {}
        disabled = set(project.get("disabledMcpServers") or [])
        json_on = set(project.get("enabledMcpjsonServers") or [])
        json_off = set(project.get("disabledMcpjsonServers") or [])
        json_all = project.get("enableAllProjectMcpServers") is True
        shared = os.path.join(folder, ".mcp.json")
        out = []
        for scope, origin, servers in (("user", "everyone", data.get("mcpServers")), ("local", "project", project.get("mcpServers"))):
            for name, v in (servers or {}).items():
                out.append((name, M.json_row(name, v, scope, user_path, self.agent), origin,
                            {"has": True, "on": name not in disabled, "state": "off" if name in disabled else "on", "where": user_path}))
        for name, v in (M._json_file(shared).get("mcpServers") or {}).items():
            state = "off" if name in json_off else "on" if (name in json_on or json_all) else "ask"
            out.append((name, M.json_row(name, v, "project", shared, self.agent), "project",
                        {"has": True, "on": state == "on", "state": state, "where": shared}))
        return {"servers": out, "files": {self.agent: user_path, "mcp_json": shared if os.path.isfile(shared) else ""}}

    def mcp_project_set(self, folder, name, on, state, user_path, listing):
        import mcp_config as M
        data = M._json_file(user_path)
        proj = data.setdefault("projects", {}).setdefault(folder, {})
        if state["where"].endswith(".mcp.json"):
            on_list = [x for x in proj.get("enabledMcpjsonServers") or [] if x != name]
            off_list = [x for x in proj.get("disabledMcpjsonServers") or [] if x != name]
            (on_list if on else off_list).append(name)
            proj["enabledMcpjsonServers"], proj["disabledMcpjsonServers"] = on_list, off_list
        else:
            off = [x for x in proj.get("disabledMcpServers") or [] if x != name]
            if not on:
                off.append(name)
            proj["disabledMcpServers"] = off
        return user_path, M._write(user_path, json.dumps(data, ensure_ascii=False, indent=2) + "\n"), ""

    def entrypoint_files(self, sid, cwd):
        if not cwd:
            return []
        home = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
        return [os.path.join(home, "projects", re.sub(r"[^A-Za-z0-9]", "-", p), sid + ".jsonl")
                for p in dict.fromkeys([cwd, os.path.realpath(cwd)])]

    # ---------------------------------------------------------------- moving a conversation to another Mac
    # It asks "Do you trust the files in this folder?" the first time it runs in a directory, and a resumed session
    # sits blocked behind that dialog: move_trust_script marks the folder trusted in the other Mac's ~/.claude.json
    # (projects[<cwd>].hasTrustDialogAccepted, the flag the dialog itself writes), after a backup to
    # ~/.claude.json.dispatch-bak.
    def move_target(self, path, remote_home, remote_cwd):
        return f"{remote_home}/.claude/projects/{folder_name(remote_cwd)}/{os.path.basename(path)}", True

    def move_prepare(self, h, cwd, remote_home, remote_cwd, dry=False):
        import move
        return {"trust": move.trust_folder(h, self.id, remote_cwd, apply=not dry),
                "memory": move_memory(h, cwd, remote_home, remote_cwd, dry=dry)}

    # ---------------------------------------------------------------- a project's own settings it reads
    project_files = (("CLAUDE.md", "instructions"), (".claude/CLAUDE.md", "instructions"), ("CLAUDE.local.md", "instructions"),
                     (".claude/rules", "rules"), (".claude/settings.json", "hooks"), (".claude/settings.local.json", "hooks"))

    def project_notes(self, folder, own):
        import agent_files
        notes = []
        for rel, kind in self.project_files:
            data = agent_files._json(os.path.join(folder, rel)) if kind == "hooks" else None
            if not data or data.get("_invalid"):
                continue
            if data.get("disableAllHooks") is True:
                notes.append({"id": "hooks-off", "text": f"{rel} turns all hooks off. Claude Code then runs Dispatch's hooks here neither, so Dispatch cannot show what Claude is doing in this project."})
            if isinstance(data.get("statusLine"), dict) and data["statusLine"].get("command"):
                notes.append({"id": "statusline", "text": f"{rel} has its own status line. Claude Code shows it here instead of yours, so Dispatch's usage meter does not count sessions in this project."})
        return notes

    # ---------------------------------------------------------------- the instruction files it reads
    instructions_url = "https://code.claude.com/docs/en/memory"
    instructions_model_re = r"claude"
    instructions_note = "Claude：共同约定放 CLAUDE.md，按文件范围的内容放 .claude/rules；引用用于组织内容，不会自动节省上下文。"
    instructions_note_en = "Claude: shared conventions go in CLAUDE.md, what applies to some files in .claude/rules; references organize content but save no context by themselves."

    def _instruction_home(self, home, env):
        from pathlib import Path
        return Path((env or {}).get("CLAUDE_CONFIG_DIR") or Path(home) / ".claude")

    def instruction_files(self, home, project=None, env=None):
        from pathlib import Path
        own = self._instruction_home(home, env)
        files = [(own / "CLAUDE.md", True)] + [(p, True) for p in sorted((own / "rules").glob("**/*.md"))][:80]
        if project:
            root = Path(project)
            files += [(root / "CLAUDE.md", True)] + [(p, True) for p in sorted((root / ".claude/rules").glob("**/*.md"))][:80]
        return files

    def instruction_model(self, home, env=None):
        import instructions
        path = self._instruction_home(home, env) / "settings.json"
        try:
            cfg = json.loads(instructions.text(path) or "{}")
        except ValueError:
            return None
        return {"agent": self.id, "model": cfg.get("model", ""), "source": str(path)}

    def instruction_findings(self, doc, models):
        if doc["lines"] > 200:
            return [(_t("CLAUDE.md is over the roughly 200 lines the official docs advise", "CLAUDE.md 超过官方建议的约 200 行"), _t("Move what only some cases need into rules loaded by path, or into skills; @import by itself loads no less.", "把仅在特定场景需要的内容移入按路径加载的 rules 或技能；@import 本身不会减少加载量。"))]
        return []

    # ---------------------------------------------------------------- its long-term memory
    def memory_files(self, home):
        return os.path.join(config_dir(home), "projects", "*", "memory", "*.md")

    def memory_where(self, path, ctx):
        folder = os.path.basename(os.path.dirname(os.path.dirname(path)))
        return memory_location(folder, ctx.once("claude-dirs", project_dirs), ctx.names, ctx.roots)


# ---------------------------------------------------------------- in Dispatch's terminal (terminal_hook.py)
TERMINAL_ASKS = {"permission_prompt", "elicitation_dialog"}  # Notification types that are a question for the person
# its hook event -> the turn state; Notification is decided by its notification_type
TURN_EVENTS = {"UserPromptSubmit": "working", "Stop": "finished", "StopFailure": "stopped", "Notification": "needs_you"}
TEXT_FROM_TRANSCRIPT_BYTES = 256 * 1024


def last_words(path):
    """The last thing the assistant said, from the end of Claude Code's transcript (JSON lines)."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - TEXT_FROM_TRANSCRIPT_BYTES))
            lines = f.read().decode("utf-8", "replace").splitlines()
    except Exception:
        return ""
    for line in reversed(lines):
        try:
            row = json.loads(line)
        except Exception:
            continue
        msg = row.get("message") if isinstance(row, dict) else None
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, list):
            texts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
            text = "\n".join(t for t in texts if t).strip()
            if text:
                return text
    return ""


def terminal_settings(python, script):
    """The settings Claude Code is started with in Dispatch's terminal (`--settings`): its turn signals go to Dispatch's
    hook entry with --terminal (the event is in the hook JSON). Added for that launch, not to the person's settings.
    `python` None: `script` is the stable shim (hooks_setup.shim_text), which runs on its own."""
    run = shlex.quote(script) if python is None else f"{shlex.quote(python)} {shlex.quote(script)}"

    def hook(event, matcher=None):
        entry = {"hooks": [{"type": "command", "command": f"{run} claude-code --terminal", "timeout": 10}]}
        if matcher:
            entry["matcher"] = matcher
        return [entry]
    return {"hooks": {"UserPromptSubmit": hook("UserPromptSubmit"), "Stop": hook("Stop"),
                      "StopFailure": hook("StopFailure"),
                      "Notification": hook("Notification", "|".join(sorted(TERMINAL_ASKS)))}}


def write_terminal_settings(python=None, script=None, base=None):
    """Writes the settings file (when it changed) and returns its path. By default the turn signals go through the
    stable shim, so a Claude Code still running while the app is replaced is never stopped by a missing hook.py."""
    import terminal_hook
    import dplatform as P
    if python is None and script is None and not P.IS_WIN:
        import hooks_setup
        script = hooks_setup.write_shim()
    else:
        python = python or sys.executable or "python3"
        script = script or terminal_hook.HOOK_SCRIPT
    d = os.path.join(base or terminal_hook.dispatch_dir(), "termd")
    p = os.path.join(d, "claude-settings.json")
    text = json.dumps(terminal_settings(python, script), indent=2)
    try:
        with open(p) as f:
            if f.read() == text:
                return p
    except Exception:
        pass
    os.makedirs(d, mode=0o700, exist_ok=True)
    with open(p + ".tmp", "w") as f:
        f.write(text)
    os.replace(p + ".tmp", p)
    return p


# ---------------------------------------------------------------- its models (models.py)
# Anthropic's GET /v1/models with the Claude Code login (the OAuth token the quota view already uses), cached for
# MODELS_TTL; offline a stale copy, no login the CLI aliases.
# Verified 2026-09-29 against https://platform.claude.com/docs/en/models/opus-5-5/overview
# and https://platform.claude.com/docs/en/models/overview. Unknown models stay at 200K (session_life.FALLBACK_WINDOW).
WINDOWS = {"opus-5-5": 1000000, "sonnet-5-5": 1000000, "fable-5-1": 1000000,
           "sonnet-5": 1000000, "haiku-4-5": 200000}
MODELS_URL = "https://api.anthropic.com/v1/models?limit=100"
MODELS_TTL = 6 * 3600
FAMILIES = ("fable", "opus", "sonnet", "haiku")


def models_cache():
    import dispatch as D
    return os.path.join(D.QUOTA_DIR, "claude-models.json")


def fetch_models(refresh=False):
    """[{id, display_name, created_at}] newest first, or None when never fetched and unreachable."""
    import time
    import urllib.request
    cache = models_cache()
    try:
        if not refresh and time.time() - os.stat(cache).st_mtime < MODELS_TTL:
            return json.load(open(cache))
    except Exception:
        pass
    tok = oauth_token()
    if tok:
        req = urllib.request.Request(MODELS_URL, headers={"Authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01", "User-Agent": "dispatch-cli"})
        try:
            rows = [{k: m.get(k) for k in ("id", "display_name", "created_at")} for m in json.loads(urllib.request.urlopen(req, timeout=10).read()).get("data") or [] if m.get("id")]
            if rows:
                os.makedirs(os.path.dirname(cache), exist_ok=True)
                tmp = cache + ".tmp"
                with open(tmp, "w") as fh:
                    json.dump(rows, fh)
                os.replace(tmp, cache)
                return rows
        except Exception:
            pass
    try:
        return json.load(open(cache))
    except Exception:
        return None


def model_family(model_id):
    return next((f for f in FAMILIES if re.search(rf"(^|-){f}(-|$|\[)", model_id or "")), "")


def model_options(rows, extra=()):
    """The newest model of each family first (what `opus` means today), then the older ones.
    `extra` is Claude Code's own additional picker entries (~/.claude.json), e.g. a 1M-context Fable."""
    latest, older, seen = [], [], set()
    for m in sorted(rows or [], key=lambda m: m.get("created_at") or "", reverse=True):
        fam = model_family(m["id"])
        opt = {"id": m["id"], "label": (m.get("display_name") or m["id"]).replace("Claude ", "", 1), "family": fam}
        if fam and fam not in seen:
            seen.add(fam)
            latest.append(dict(opt, latest=True))
        else:
            older.append(dict(opt, latest=False))
    if not latest:
        # No login and nothing cached: the CLI's aliases always mean the newest of the family.
        latest = [{"id": f, "label": f.capitalize(), "family": f, "latest": True} for f in FAMILIES]
    latest.sort(key=lambda o: FAMILIES.index(o["family"]) if o["family"] in FAMILIES else 99)
    ids = {o["id"] for o in latest + older}
    added = []
    for x in extra:
        v = x.get("value") or ""
        if v and v not in ids:
            name = (x.get("description") or "").split(" · ")[0].strip() or x.get("label") or v
            added.append({"id": v, "label": name + (" · 1M" if "[1m]" in v else ""), "family": model_family(v), "latest": True, "note": x.get("description") or ""})
    return [{"id": "", "label": _t("Default", "默认")}] + latest + added + older


def extra_models():
    import dispatch as D
    try:
        return json.load(open(os.path.join(D.HOME, ".claude.json"))).get("additionalModelOptionsCache") or []
    except Exception:
        return []


# ---------------------------------------------------------------- its allowance
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
USAGE_TTL = 300  # seconds between calls; the app polls every minute, the API sees one call per 5
TOKEN_NOTE = ""


def oauth_token():
    """Claude Code's own login token, read from the keychain entry it maintains.
    Read-only: never refreshed here, never written anywhere, never printed."""
    global TOKEN_NOTE
    import subprocess
    import time
    import dplatform as P
    TOKEN_NOTE = ""
    if P.IS_WIN:
        # Claude Code on Windows keeps the login in a plain file, not a keychain.
        try:
            c = (json.load(open(P.CLAUDE_CREDENTIALS, encoding="utf-8")) or {}).get("claudeAiOauth") or {}
        except FileNotFoundError:
            TOKEN_NOTE = "Claude Code login information was not found. Sign in to Claude Code on this computer."
            return None
        except Exception:
            return None
        if not c.get("accessToken") or (c.get("expiresAt") or 0) / 1000 < time.time():
            return None
        return c["accessToken"]
    if os.environ.get("DISPATCH_FAKE_KEYCHAIN"):
        # a test instance's keychain is a folder (accounts.Keychain): the real one is never asked
        try:
            import accounts as accts
            c = accts.claude_oauth(accts.Vault().claude_live_read() or "")
        except Exception:
            return None
        if not c.get("accessToken") or (c.get("expiresAt") or 0) / 1000 < time.time():
            return None
        return c["accessToken"]
    try:
        import getpass
        r = subprocess.run(["security", "find-generic-password", "-s", "Claude Code-credentials", "-a", getpass.getuser(), "-w"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10)
        raw = r.stdout.strip()
        if r.returncode != 0:
            # macOS asks 「python3 想访问钥匙串」 the first time; a refusal used to leave the quota page
            # silently empty. Say what it was for and how to allow it.
            TOKEN_NOTE = ("Claude Code login information is unavailable. Keychain access may have been denied, or Claude Code is not signed in. "
                                  "Allow Keychain access to let Dispatch query your official usage from Anthropic.")
        c = (json.loads(raw) if raw else {}).get("claudeAiOauth") or {}
    except Exception:
        return None
    if not c.get("accessToken") or (c.get("expiresAt") or 0) / 1000 < time.time():
        return None
    return c["accessToken"]


def usage():
    """Official usage numbers (the same ones /usage and the desktop app show), cached for USAGE_TTL."""
    import time
    import urllib.request
    import dispatch as D
    import dplatform as P
    cache = os.path.join(D.QUOTA_DIR, "claude-usage.json")
    try:
        st = os.stat(cache)
        if time.time() - st.st_mtime < USAGE_TTL:
            return json.load(open(cache, encoding="utf-8")), st.st_mtime
    except Exception:
        pass
    tok = oauth_token()
    if not tok:
        return None, None
    req = urllib.request.Request(os.environ.get("DISPATCH_USAGE_URL") or USAGE_URL, headers={"Authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "dispatch-cli"})
    try:
        d = json.loads(urllib.request.urlopen(req, timeout=10).read())
    except Exception:
        try:  # offline: a stale answer beats none, the age is shown in the UI
            st = os.stat(cache)
            return json.load(open(cache, encoding="utf-8")), st.st_mtime
        except Exception:
            return None, None
    os.makedirs(D.QUOTA_DIR, exist_ok=True)
    tmp = cache + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(d, fh)
    P.replace_retry(tmp, cache)
    return d, time.time()


def own_quota():
    """Prefer the official usage API (has the per-model window, e.g. Fable); fall back to the
    rate_limits Claude Code feeds its statusline, which statusline-tee.sh caches."""
    import dispatch as D
    p = os.path.join(D.QUOTA_DIR, "claude-code.json")
    try:
        sl = json.load(open(p, encoding="utf-8"))
    except Exception:
        sl = {}
    plan = (sl.get("model") or {}).get("display_name", "")
    use, ts = usage()
    if use:
        wins = []
        for lim in use.get("limits") or []:
            if lim.get("percent") is None:
                continue
            kind = lim.get("kind")
            scope = ((lim.get("scope") or {}).get("model") or {}).get("display_name")
            label = {"session": "5h", "weekly_all": "Weekly"}.get(kind)
            if kind == "weekly_scoped":
                label = f"Weekly · {scope or 'Model'}"
            if not label:
                continue
            # kind: session | weekly | weekly_model, for readers that must not match the (Chinese) label
            wins.append({"label": label, "kind": {"session": "session", "weekly_all": "weekly"}.get(kind, "weekly_model"),
                         "used_percent": lim["percent"], "resets_at": D._iso_epoch(lim.get("resets_at"))})
        if wins:
            return {"agent": "claude-code", "plan": plan, "windows": wins, "updated_at": ts, "source": "oauth", "note": ""}
    try:
        st = os.stat(p)
    except Exception:
        return {"agent": "claude-code", "plan": "", "windows": [], "updated_at": None, "source": "statusline", "note": TOKEN_NOTE or "No usage data yet. Send a message in a new Claude Code session to record it."}
    if st.st_mtime < D._switched_at("claude"):  # the status line still speaks for the account before the switch
        return {"agent": "claude-code", "plan": "", "windows": [], "updated_at": None, "source": "statusline", "note": "No usage numbers for this account yet."}
    rl = sl.get("rate_limits") or {}
    wins = []
    for key, label, kind in (("five_hour", "5h", "session"), ("seven_day", "Weekly", "weekly")):
        w = rl.get(key) or {}
        if w:
            wins.append({"label": label, "kind": kind, "used_percent": w.get("used_percentage"), "resets_at": w.get("resets_at")})
    return {"agent": "claude-code", "plan": plan, "windows": wins, "updated_at": st.st_mtime, "source": "statusline", "note": "" if wins else "No rate_limits in the statusline data. This account may use API billing."}



# ---------------------------------------------------------------- the index's usage stats of a transcript
def parse_stats(e, buf, re_ts):
    """Token usage (deduped by requestId: one API response is logged once per content block),
    model, skills (Skill tool + slash commands), subagents (Task/Agent tool), activity by time."""
    import dispatch as D
    for line in buf.split("\n"):
        if not line.startswith("{"):
            continue
        if '"type":"assistant"' in line:
            try:
                d = json.loads(line)
            except Exception:
                continue
            msg = d.get("message") or {}
            rid = d.get("requestId") or d.get("uuid") or ""
            u = msg.get("usage") or {}
            if u and rid != e["last_req"]:
                e["last_req"] = rid
                from session_life import claude_usage
                parts = claude_usage(u)
                i, o, cr, cw = (parts[k] for k in ("input", "output", "cache_read", "cache_write"))
                th = (u.get("output_tokens_details") or {}).get("thinking_tokens", 0) or 0
                T = e["tokens"]
                T["in"] += i; T["out"] += o; T["cr"] += cr; T["cw"] += cw; T["think"] += th
                m = msg.get("model")
                if m:
                    e["models"][m] = e["models"].get(m, 0) + 1
                D.bump_time(e, D.local_dt(d.get("timestamp", "")), 1, i + o + cr + cw, (i, o, cr, cw))
            for b in msg.get("content") or []:
                if not isinstance(b, dict) or b.get("type") != "tool_use":
                    continue
                inp = b.get("input") or {}
                if b.get("name") == "Skill" and inp.get("skill"):
                    e["skills"][inp["skill"]] = e["skills"].get(inp["skill"], 0) + 1
                elif b.get("name") in ("Task", "Agent") and inp.get("subagent_type"):
                    e["subs"][inp["subagent_type"]] = e["subs"].get(inp["subagent_type"], 0) + 1
        elif '"type":"user"' in line and '"tool_use_id"' not in line:
            m = re_ts.search(line)
            if m:
                D.bump_time(e, D.local_dt(m.group(1)), 1, 0)
    for m in re.finditer(r"<command-name>/?([^<\s]{1,60})</command-name>", buf):
        k = "/" + m.group(1)
        e["skills"][k] = e["skills"].get(k, 0) + 1



# ---------------------------------------------------------------- its memory folders (~/.claude/projects/<folder>/memory)
def project_dirs():
    """Claude names each project folder by replacing every non-alphanumeric character of the
    cwd with "-" (spaces and Chinese included), which is lossy; recover the real path from the
    cwds the session index knows, and fall back to a readable guess."""
    import dispatch as D
    import dplatform as P
    known = {}
    try:
        for r in D.session_refs(D.load_index()):
            cwd = (r.get("cwd") or "").rstrip("/")
            if P.IS_WIN and len(cwd) > 3:
                cwd = cwd.rstrip("\\")
            if cwd:
                known.setdefault(re.sub(r"[^A-Za-z0-9]", "-", cwd), cwd)
    except Exception:
        pass
    return known


TCC_FOLDERS = {"Documents", "Desktop", "Downloads", "Pictures", "Movies", "Music", "Library"}


def decode_dir(enc, base="/", depth=0):
    """Walk the filesystem to undo Claude's lossy encoding: at each level pick the entry whose
    encoded name is a prefix of what is left. Returns None when no existing directory fits.
    A Windows cwd encodes its drive too: C:\\Users\\x\\proj -> C--Users-x-proj, decoded from C:\\."""
    import dplatform as P
    m = re.match(r"^([A-Za-z])--", enc or "") if depth == 0 else None
    if m:
        return decode_dir(enc[2:], m.group(1).upper() + ":" + os.sep, 1)
    if not enc:
        return base
    if not enc.startswith("-") or depth > 24:
        return None
    rest = enc[1:]
    try:
        entries = sorted(os.listdir(base), key=len, reverse=True)
    except OSError:
        return None
    for name in entries:
        e = re.sub(r"[^A-Za-z0-9]", "-", name)
        if e and rest.startswith(e) and (len(rest) == len(e) or rest[len(e)] == "-"):
            full = os.path.join(base, name)
            # Listing these makes macOS ask 「Dispatch 想访问“文稿”文件夹」 out of nowhere, just to
            # print a nicer folder name on the memory page. Not worth a permission prompt: a project
            # that lives there is found through the session index instead (see known_dirs above).
            if not P.IS_WIN and os.path.dirname(full) == os.path.expanduser("~") and name in TCC_FOLDERS:
                continue
            if os.path.isdir(full):
                hit = decode_dir(rest[len(e):], full, depth + 1)
                if hit:
                    return hit
    return None


def guess_path(folder):
    """Readable (lossy) path from a Claude project folder name: every "-" back to "/", a leading
    Windows drive (C--Users-x) back to C:/Users/x."""
    m = re.match(r"^([A-Za-z])--(.*)$", folder)
    if m:
        return m.group(1).upper() + ":/" + m.group(2).replace("-", "/")
    return folder.replace("-", "/")


def memory_location(folder, known, names, roots):
    """(project, project_dir, expired) for a `projects/<folder>/memory` directory. Expired = the decoded directory is
    missing or not a directory any more."""
    import memories
    real = known.get(folder) or decode_dir(folder)
    if real and os.path.isdir(real):
        return memories.project_name(real, names, roots), real, False
    if not real:                                    # readable fallback so expired folders still group
        guess = guess_path(folder)
        m = re.match(r"^(?:[A-Za-z]:)?/(?:Users|home)/([^/]+)/?$", guess)      # another machine's home dir
        if m:
            return _t(f"General ({m.group(1)})", f"通用（{m.group(1)}）"), "", True
        return os.path.basename(re.sub(r"^(?:[A-Za-z]:)?/Users/[^/]+", "~", guess).rstrip("/")) or _t("General", "通用"), "", True
    return memories.project_name(real, names, roots), real, True


# ---------------------------------------------------------------- moving a conversation to another Mac (move.py)
def config_dir(home):
    """Claude Code's own folder: CLAUDE_CONFIG_DIR when it is set (Claude Code keeps transcripts, settings, rules and
    memory there then: History listed none, 10-08), else <home>/.claude."""
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude")


def folder_name(cwd):
    """The folder it keeps a working directory's transcripts in (under ~/.claude/projects): "/" and "." become "-"."""
    return re.sub(r"[/.]", "-", cwd.rstrip("/") or "/")


def transcript_folder(home, cwd):
    """Where it keeps the transcripts of a working directory here (CLAUDE_CONFIG_DIR or ~/.claude)."""
    return os.path.join(config_dir(home), "projects", folder_name(cwd))


def move_memory_dir(home, cwd):
    return os.path.join(config_dir(home), "projects", folder_name(cwd), "memory")


def move_memory(h, cwd, remote_home, remote_cwd, dry=False):
    """The project's auto-memory (~/.claude/projects/<encoded cwd>/memory/) belongs with the conversation. Merge it
    into the other Mac's folder for the new path; newer files there win."""
    import shlex
    import subprocess
    import dispatch as D
    import move
    src = move_memory_dir(D.HOME, cwd)
    files = sorted(f for f in os.listdir(src)) if os.path.isdir(src) else []
    if not files or dry:
        return {"files": len(files), "synced": False}
    dst = move_memory_dir(remote_home, remote_cwd)
    move.ssh(h, f"mkdir -p {shlex.quote(dst)}")
    r = subprocess.run(["rsync", "-a", "--update", "-e", move.SSH_CMD, src + "/", f"{h['ssh']}:{shlex.quote(dst)}/"], capture_output=True, text=True, errors="replace", timeout=600)
    return {"files": len(files), "synced": r.returncode == 0, **({"error": r.stderr.strip()[-200:]} if r.returncode else {})}


MOVE_TRUST_SCRIPT = r"""
import json, os, shutil, sys, time
path, cwd, apply = os.path.expanduser("~/.claude.json"), sys.argv[1], sys.argv[2] == "1"
try:
    data = json.load(open(path))
except FileNotFoundError:
    data = {}
proj = data.setdefault("projects", {}).setdefault(cwd, {})
if proj.get("hasTrustDialogAccepted"):
    print("already"); sys.exit(0)
if not apply:
    print("needed"); sys.exit(0)
if os.path.exists(path):
    shutil.copy2(path, path + ".dispatch-bak")
proj["hasTrustDialogAccepted"] = True
tmp = path + ".dispatch-tmp"
json.dump(data, open(tmp, "w"), ensure_ascii=False, indent=2)
if os.path.exists(path):
    os.chmod(tmp, os.stat(path).st_mode & 0o777)
os.replace(tmp, path)
print("set")
"""


# ---------------------------------------------------------------- Dispatch's status line tee in ~/.claude/settings.json
# Dispatch's hook entry is hooks_setup.py; next to it in the same file, the status line runs through Dispatch's tee
# (the quota it shows is read there), and a status line the person already had keeps running behind it.
STATUSLINE_ORIG = ""  # the person's own status line, kept for the tee; "" is DISPATCH_DIR/statusline-orig
TEE_COMMAND = 'bash "$HOME/tasks/.dispatch/statusline-tee.sh"'


def statusline_orig():
    import dispatch as D
    return STATUSLINE_ORIG or os.path.join(D.DISPATCH_DIR, "statusline-orig")


def tee_command():
    import init_wizard as I
    import dplatform as P
    return f"bash {I.hook_path(os.path.join(I.HERE, 'statusline-tee.sh'))}" if P.IS_WIN else TEE_COMMAND


def install_statusline(path):
    """The quota tee in front of the person's status line. Returns whether there was one of theirs to keep."""
    import dispatch as D
    from instructions import atomic_write
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return False
    line = d.get("statusLine") if isinstance(d.get("statusLine"), dict) else {}
    cur = line.get("command", "") or ""
    if cur and "statusline-tee.sh" not in cur:
        os.makedirs(D.DISPATCH_DIR, exist_ok=True)
        with open(statusline_orig(), "w") as f:
            f.write(cur + "\n")
    want = {**line, "type": "command", "command": tee_command(), "padding": line.get("padding", 0)}
    if want != d.get("statusLine"):
        d["statusLine"] = want
        atomic_write(path, json.dumps(d, ensure_ascii=False, indent=2) + "\n")
    return bool(cur and "statusline-tee.sh" not in cur)


def uninstall_statusline(path):
    """The person's status line back (or none, when they had none). Whether anything changed."""
    import onboarding
    from instructions import atomic_write
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return False
    sl = d.get("statusLine") if isinstance(d.get("statusLine"), dict) else {}
    if "statusline-tee.sh" not in (sl.get("command") or ""):
        return False
    orig = onboarding._read(statusline_orig()).strip()
    if orig:
        d["statusLine"] = {**sl, "command": orig}
    else:
        d.pop("statusLine", None)
    if not d and not os.path.exists(path + ".dispatch-bak"):
        os.remove(path)  # there was no settings file before: none now
        return True
    atomic_write(path, json.dumps(d, ensure_ascii=False, indent=2) + "\n")
    return True


Claude.move_trust_script = MOVE_TRUST_SCRIPT
ENGINE = Claude()
