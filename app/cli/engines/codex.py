# -*- coding: utf-8 -*-
"""Codex (OpenAI): `codex`. Its chat talks to one shared `codex app-server` (chat_codex.py)."""
import glob
import json
import os
import re
import shlex
import sys

from engines.base import Engine
from lang import t as _t

PREAMBLE = "# AGENTS.md instructions"  # its injected project instructions, not something the person typed


class Codex(Engine):
    id = "codex"
    name = "Codex"
    maker = "OpenAI"
    plan_name = "ChatGPT · Codex"
    provider = "codex"
    icon = "openai"
    glyph = ("codicon.ttf", "\uec81")
    color = "#2f7d6b"
    commit_trailer = "Codex <noreply@openai.com>"
    about = "OpenAI's coding assistant. Works with a ChatGPT plan or an OpenAI API key."
    bins = ("codex",)
    env_markers = ("CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_MANAGED_BY_NPM")
    session_env = ("CODEX_THREAD_ID",)
    activity_stream = True

    config_home = "{home}/.codex"
    rules_file = "{home}/.codex/AGENTS.md"
    hooks_text = "one Dispatch hook (session brief, activity, task plans, context reminders)"
    hooks_note = "Codex runs a hook only once it is trusted; Dispatch trusts this one there, and your own hooks keep the trust they have"
    service = "openai"
    servers = "OpenAI's servers"
    discuss_persona = _t("Digs into implementation details: exactly what changes where, the edge cases, whether existing code can be reused; distrusts claims nobody checked.", "抠实现细节：关心具体改哪里、边界情况、能不能复用已有代码，不信没验证过的说法。")

    chat_min_version = (0, 157, 0)

    package = "@openai/codex"
    brew = ("codex",)
    login_args = ("login",)
    no_installer_message = ("Codex installs with Node.js, and this Mac has neither Node.js nor Homebrew. "
                            "Install Node.js from nodejs.org, then click Install again.")
    skills = ("{home}/.agents/skills", "{codex}/skills")

    # slash commands Dispatch runs in its sessions, and the ones it has only in its own terminal with Dispatch's
    # way to the same thing: (where, go) (slash.py explains the grey rows)
    slash_commands = ("compact", "review", "init", "status")
    terminal_commands = {
        "usage": ("Here it is /status", "alias:status"),
        "diff": ("Changes in the side pane shows the diff", "changes"),
        "mention": ("Type # in the input to attach a file", ""),
        "approvals": ("Use the permission picker under the input", "permissions"),
        "permissions": ("Use the permission picker under the input", "permissions"),
        "resume": ("Your sessions are in Sessions on the left", "sessions"),
        "new": ("Start one with New at the top of Sessions", "new"),
        "login": ("Sign in from Accounts in the title bar", "accounts"),
        "logout": ("Sign out from Accounts in the title bar", "accounts"),
        "goal": ("", ""),
        "personality": ("", ""),
        "experimental": ("", ""),
        "statusline": ("", ""),
        "theme": ("", ""),
        "feedback": ("", ""),
        "quit": ("", ""),
        "exit": ("", ""),
    }

    # ---------------------------------------------------------------- its transcripts ($CODEX_HOME/sessions/<y>/<m>/<d>/rollout-*.jsonl)
    def transcript_root(self, home):
        # this Mac's own home follows CODEX_HOME; another home (a Mac it reads over a mount) has its own .codex
        codex = os.path.join(home, ".codex")
        if os.environ.get("CODEX_HOME") and os.path.normpath(home) == os.path.normpath(os.path.expanduser("~")):
            codex = os.environ["CODEX_HOME"]
        return os.path.join(codex, "sessions")

    def transcript_files(self, home):
        root = os.environ.get("CODEX_HOME") or os.path.join(home, ".codex")
        return [(p, "") for p in glob.glob(os.path.join(root, "sessions", "**", "*.jsonl"), recursive=True)]

    titles_after_turn = True

    def own_title(self, path, sid, home):
        # its thread_name in session_index.jsonl; the thread's id from the rollout's first record when not given
        if not sid and path:
            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    sid = (json.loads(f.readline()).get("payload") or {}).get("id") or ""
            except (OSError, ValueError):
                sid = ""
        return self.own_titles(home).get(sid, "").strip() if sid else ""

    def own_titles(self, home):
        # it names a thread after its first turn, in session_index.jsonl next to its sessions
        titles = {}
        try:
            with open(os.path.join(os.path.dirname(self.transcript_root(home)), "session_index.jsonl")) as f:
                for line in f:
                    try:
                        row = json.loads(line)
                        if row.get("thread_name"):
                            titles[row["id"]] = row["thread_name"]
                    except (ValueError, KeyError):
                        continue
        except OSError:
            pass
        return titles

    def index_head(self, e, buf):
        import dispatch as D
        if e["session_id"]:
            return
        try:
            d = json.loads(buf.split("\n", 1)[0])
            p = d.get("payload", d)
            e["session_id"] = p.get("id", "")
            e["cwd"] = p.get("cwd", "")
            e["entrypoint"] = D.origin_of(p.get("source"), p.get("originator")) or "cli"
            e["origin_v"] = D.ORIGIN_V
            if e["entrypoint"] == "subagent":
                e["subagent"] = True  # a thread another Codex spawned: not a conversation of its own
        except Exception:
            pass

    def index_fold(self, e, buf, re_ts):
        # CLI rollouts carry event_msg user_message; the desktop app only has response_item messages
        e["user_msgs"] += len(re.findall(r'"role":"user","content":\[\{"type":"input_text","text":"(?!<)', buf))
        e["assistant_msgs"] += buf.count('"role":"assistant"')
        for m in re.finditer(r'"type":"function_call","name":"([^"]+)"', buf):
            e["tools"][m.group(1)] = e["tools"].get(m.group(1), 0) + 1
        parse_stats(e, buf, re_ts)

    def index_cached(self, e, path, unchanged):
        import dispatch as D
        if e.get("skills_v") != SKILLS_V:
            if e.get("off"):
                counted = recount_skills(path, e["off"])
                if counted is not None:
                    e["skills"] = counted
            e["skills_v"] = SKILLS_V
        if e["first_prompt"].startswith(PREAMBLE):
            # indexed before the preamble was skipped: one read of the file's head, then cached
            try:
                with open(path, "rb") as f:
                    e["first_prompt"] = D.first_prompt_of(self.agent, f.read(4 << 20).decode("utf-8", "replace"))
            except OSError:
                pass
        if unchanged and e.get("origin_v") != D.ORIGIN_V:
            e["entrypoint"] = meta_origin(path) or "cli"  # older index rows: one read of the first line, then cached
            e["origin_v"] = D.ORIGIN_V
            if e["entrypoint"] == "subagent":
                e["subagent"] = True  # a thread another Codex spawned: not a conversation of its own

    user_markers = (b'"role":"user"',)
    lists_subthreads = True

    def history_message(self, d):
        p = d.get("payload") or {}
        if d.get("type") == "response_item" and p.get("type") == "message" and p.get("role") in ("user", "assistant"):
            return ("user" if p["role"] == "user" else "agent"), p.get("content")
        return None

    def attachment_message(self, record):
        p = record.get("payload") or {}
        return p if record.get("type") == "response_item" and p.get("type") == "message" else None

    def typed_skip(self, line):
        # a very big record that is not a message (its base instructions, a pasted picture)
        return len(line) > (256 << 10) and b'"type":"response_item"' not in line[:200]

    def transcript_parent(self, path):
        """The thread a helper thread was started from (session_meta.parent_thread_id), "" for a conversation."""
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                d = json.loads(f.readline() or "{}")
            p = d.get("payload") or {}
            return p.get("parent_thread_id") or ""
        except (OSError, ValueError, AttributeError):
            return ""

    def transcript_of(self, sid, home, cwd=""):
        root = os.environ.get("CODEX_HOME") or os.path.join(home, ".codex")
        return glob.glob(os.path.join(root, "sessions", "*", "*", "*", f"rollout-*{sid}.jsonl"))

    def folder_transcripts(self, home, folder):
        out = []
        for f in glob.glob(os.path.join(os.environ.get("CODEX_HOME") or os.path.join(home, ".codex"), "sessions", "**", "*.jsonl"), recursive=True):
            try:
                with open(f, encoding="utf-8", errors="replace") as fh:
                    first = fh.readline()
                meta = (json.loads(first).get("payload") or {}) if first.startswith("{") else {}
            except (OSError, ValueError):
                continue
            if (meta.get("cwd") or "").rstrip("/") == folder.rstrip("/"):
                out.append((os.path.getmtime(f), meta.get("id") or os.path.basename(f), f))
        return out

    def detail_record(self, d, cx):
        """One rollout record ({type: event_msg | response_item, payload}) into the session page's timeline; a turn's
        records share one assistant message."""
        import dispatch as D
        import activity as A
        t = d.get("type")
        # Codex rollouts: {"type":"event_msg"/"response_item", payload:{...}}; content blocks are input_text/output_text.
        p = d.get("payload", {})
        ts = d.get("timestamp", "")
        pt = p.get("type")
        if t == "turn_context" and p.get("model"):
            cx.tl.model = p["model"]
        if t != "response_item":
            return
        if cx.last is None:
            cx.state["turn"] = ts or "turn"
        if pt == "message":
            role = p.get("role", "")
            txt = "\n".join(b.get("text", "") for b in p.get("content") or [] if isinstance(b, dict) and b.get("type") in ("input_text", "output_text", "text"))
            if role == "user":
                txt = A.user_text(txt)
            if txt.strip() and role == "user":
                cx.other(cx.tl.add(ts, "user", [{"type": "text", "text": txt[:D.LONG_TEXT]}]))
            elif txt.strip() and role == "assistant":
                cx.assistant(ts, cx.state["turn"], [{"type": "text", "text": txt[:D.LONG_TEXT]}])
        elif pt == "reasoning":
            summary = p.get("summary") or []
            txt = "\n".join((s.get("text") if isinstance(s, dict) else str(s)) or "" for s in summary).strip()
            cx.assistant(ts, cx.state["turn"], [D._thinking_block(txt) if txt else D._thinking_block("", _t("readable summaries are off (model_reasoning_summary)", "未开启可读摘要（model_reasoning_summary）"))])
        elif pt in ("function_call", "custom_tool_call"):
            name = p.get("name", "")
            args = p.get("arguments", p.get("input", ""))
            summary = args
            aj = {}
            try:
                aj = json.loads(args) if isinstance(args, str) else (args or {})
                if isinstance(aj, dict):
                    summary = aj.get("cmd") or aj.get("command") or aj.get("path") or aj.get("file_path") or args
                    if isinstance(summary, list):
                        summary = " ".join(map(str, summary))
                    fp = aj.get("path") or aj.get("file_path")
                    if name.split(".")[-1] == "apply_patch":
                        cx.tl.note_file("(apply_patch)", "edit", "", str(aj.get("input") or args)[:20000], ts)
                    elif fp and name in ("write_file", "edit_file"):
                        cx.tl.note_file(fp, "write", "", str(aj.get("content", ""))[:20000], ts)
                else:
                    aj = {}
            except Exception:
                aj = {}
            for fp in (A.patch_files(str(args)) if name.split(".")[-1] == "apply_patch" else []):
                cx.tl.note_file(fp, "patch", "", str(args)[:20000], ts)
            block = cx.tl.tool(ts, p.get("call_id") or p.get("id"), name, aj if aj else {"input": str(args)}, summary)
            cx.assistant(ts, cx.state["turn"], [block])
        elif pt in ("function_call_output", "custom_tool_call_output"):
            outp = p.get("output")
            if isinstance(outp, dict):
                is_err = bool(outp.get("is_error")) or (outp.get("metadata") or {}).get("exit_code") not in (None, 0)
                outp = outp.get("output") or outp.get("content") or outp
            else:
                is_err = False
            if isinstance(outp, str) and outp.startswith("Chunk ID:"):
                # exec_command wraps the output in a header; the exit code is the status.
                code = re.search(r"Process exited with code (\d+)", outp)
                is_err = is_err or bool(code and code.group(1) != "0")
                outp = outp.split("Output:\n", 1)[1] if "Output:\n" in outp else outp
            cx.tl.resolve(p.get("call_id"), outp, is_err, ts)
            cx.last = None
        return

    def life_feed(self, meter, row, ordinal):
        """One rollout record into the context lifetime meter: its token_count events carry the usage and the window."""
        import session_life as L
        d = meter.data
        typ = row.get("type")
        p = row.get("payload") or {}
        if typ == "turn_context":
            d["model"] = p.get("model") or d["model"]
        if typ == "compacted":
            meter.reset()
        if typ == "event_msg" and p.get("type") == "token_count":
            info = p.get("info") or {}
            if info.get("last_token_usage"):
                meter.usage(L.codex_usage(info["last_token_usage"]),
                           cumulative=L.codex_usage(info["total_token_usage"]) if info.get("total_token_usage") else None,
                           window=info.get("model_context_window"))
        elif typ == "response_item":
            ident = p.get("call_id") or p.get("id") or str(ordinal)
            if p.get("type") in ("function_call", "custom_tool_call", "web_search_call") and meter.once("tool", ident):
                d["tool_steps"] += 1
            elif p.get("type") == "message" and p.get("role") in ("user", "assistant") and meter.once("message", ident):
                d["messages"] += 1
                if p.get("role") == "user":
                    d["rounds"] += 1

    def first_prompt(self, d):
        p = d.get("payload") or {}
        if d.get("type") != "response_item" or p.get("type") != "message" or p.get("role") != "user":
            return None
        # it puts its AGENTS.md preamble and <environment_context> in user messages of their own (or blocks)
        return "\n".join(b.get("text", "") for b in p.get("content") or []
                         if isinstance(b, dict) and b.get("type") in ("input_text", "text") and not b.get("text", "").lstrip().startswith(PREAMBLE))

    def resume(self, sid, key=""):
        # a rollout of another CODEX_HOME (one moved here, an instance's) is found there only
        home = key.split("/sessions/", 1)[0] if "/sessions/" in (key or "") else ""
        import dispatch as D
        return ["resume", sid], ({"CODEX_HOME": home} if home and os.path.realpath(home) != os.path.realpath(D.codex_home()) else {})

    terminal_recipe = {"resume": "resume --last", "fork": "fork --last"}

    # the built-in commands the reply page offers in its sessions: (name, what it does)
    builtin_commands = (
        ('compact', '压缩对话上下文'),
        ('new', '开始新会话'),
        ('status', '状态与用量'),
        ('model', '切换模型'),
        ('approvals', '审批策略'),
        ('review', '审查当前改动'),
        ('diff', '看 git diff'),
        ('init', '生成 AGENTS.md'),
        ('mcp', 'MCP 服务器'),
    )

    def terminal_permission_args(self, mode):
        # Full auto, as its chat sessions (chat_codex.MODE_MAP): never ask, no sandbox. Its default already edits the project.
        return "--dangerously-bypass-approvals-and-sandbox" if mode == "bypassPermissions" else ""

    def terminal_turn_args(self, env):
        if has_own_notify(env):
            return ""
        import terminal_hook
        value = notify_program(sys.executable or "python3", terminal_hook.HOOK_SCRIPT)
        return f"-c {shlex.quote('notify=' + value)}"

    def turn_state(self, event, payload):
        if event != "notify" or payload.get("type") != "agent-turn-complete":
            return None, "", ""
        import terminal_hook
        return "finished", terminal_hook.last_line(payload.get("last-assistant-message") or ""), ""

    # ---------------------------------------------------------------- one run in the background
    headless_lastfile = True
    headless_stdin_prompt = True

    def headless_argv(self, model, prompt, cwd, *, images=(), system="", session="", resume=False, lastfile="",
                      effort="", stdin_prompt=False, error_log=False, session_dir="", thinking=""):
        import codex_window
        common = ["--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"]
        common += (["-o", lastfile] if lastfile else []) + (["-m", model] if model else [])
        common += ["-c", "developer_instructions=" + json.dumps(system, ensure_ascii=False)] if system else []
        common += ["-c", "model_reasoning_effort=" + json.dumps(effort)] if effort else []
        common += codex_window.config_args(model)  # largest window of the model unless config.toml sets one
        prefix = ["codex", "exec", "resume", session] if resume and session else ["codex", "exec", "-C", cwd]
        # -i consumes trailing arguments: the prompt must precede the images.
        return prefix + common + ["-" if stdin_prompt else prompt] + [x for p in images for x in ("-i", p)]

    def live_events(self, ev):
        item = ev.get("item") or {}
        if ev.get("type") == "item.started" and item.get("type") == "command_execution":
            return [("command", item.get("command") or "")]
        if ev.get("type") == "item.completed" and item.get("type") == "reasoning":
            return [("thinking", str(item.get("text") or ""))]
        if ev.get("type") == "item.completed" and item.get("type") == "agent_message":
            return [("message", item.get("text") or "")]
        return []

    def record_steps(self, record):
        p = record.get("payload") or {}
        if record.get("type") != "response_item" or not isinstance(p, dict):
            return []
        if p.get("type") in ("function_call", "custom_tool_call"):
            args = p.get("arguments") if p.get("arguments") is not None else p.get("input")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {"command": args}
            return [("tool", p.get("name") or "", args)]
        if p.get("type") == "message" and p.get("role") == "assistant":
            return [("text", "\n".join(c.get("text", "") for c in p.get("content") or []
                                       if isinstance(c, dict) and c.get("type") in ("text", "output_text")))]
        return []

    def steps(self, ev):
        if ev.get("type") not in ("item.started", "item.completed"):
            return []
        item = ev.get("item") or {}
        if item.get("type") == "command_execution":
            return [("tool", "bash", {"command": item.get("command")})]
        if item.get("type") == "file_change":
            ch = item.get("changes") or []
            return [("tool", "edit", {"path": (ch[0] or {}).get("path") if ch else ""})]
        if item.get("type") == "agent_message":
            return [("text", item.get("text") or "")]
        return []

    def session_in(self, line):
        m = re.search(r'"thread_id"\s*:\s*"([0-9a-f-]{20,})"', line)
        return m.group(1) if m else ""

    def final_text(self, stdout, lastfile=""):
        if lastfile and os.path.exists(lastfile):
            with open(lastfile, encoding="utf-8", errors="replace") as f:
                return f.read()
        texts = []
        for line in (stdout or "").splitlines():
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "item.completed" and (ev.get("item") or {}).get("type") == "agent_message":
                texts.append(ev["item"].get("text") or "")
        return "\n".join(texts) if texts else stdout or ""

    def run_result(self, stdout, stderr="", lastfile="", session=""):
        sid, text, error, usage = session, "", "", {}
        for line in stdout.splitlines():
            try:
                ev = json.loads(line)
            except Exception:
                continue
            if ev.get("type") == "thread.started":
                sid = ev.get("thread_id") or sid
            elif ev.get("type") == "item.completed" and (ev.get("item") or {}).get("type") == "agent_message":
                text = (ev["item"].get("text") or "") or text
            elif ev.get("type") == "turn.completed":
                u = ev.get("usage") or {}
                usage = {"input": u.get("input_tokens", 0) - u.get("cached_input_tokens", 0), "cached": u.get("cached_input_tokens", 0), "output": u.get("output_tokens", 0)}
            elif ev.get("type") == "error":
                error = (ev.get("message") or _t("codex reported an error", "codex 报错"))[:200]
        try:
            text = open(lastfile, encoding="utf-8").read().strip() or text
            os.unlink(lastfile)
        except Exception:
            pass
        return {"text": text, "session": sid, "error": error, "usage": usage}

    accounts_driver = ("accounts", "CodexLogin")

    def own_quota(self):
        return own_quota()

    def quota_history(self, since):
        return quota_history(since)

    default_effort = "high"

    def effort_name(self, effort):
        return {"max": "xhigh"}.get(effort, effort)  # Codex calls the top effort xhigh

    def takes_model(self, model):
        return bool(re.match(r"^(gpt|o\d|codex)", model or ""))

    def subagent_folder(self, home, env):
        codex = env.get("CODEX_HOME") or os.path.join(home, ".codex")
        return (os.path.join(codex, "agents"), ".toml", []) if os.path.isdir(codex) else None

    def subagent_text(self, d):
        import builtin_agents as B
        fm, body = d["fm"], d["body"]
        lines = [f"name = {json.dumps(fm.get('name', ''), ensure_ascii=False)}",
                 f"description = {json.dumps(fm.get('description', ''), ensure_ascii=False)}"]
        eff = self.effort_name(fm.get("effort", ""))
        if eff:
            lines.append(f"model_reasoning_effort = {json.dumps(eff)}")
        lines.append("developer_instructions = " + B.toml_string(body if body.endswith("\n") else body + "\n"))
        return "\n".join(lines) + "\n"

    def models(self, refresh=False):
        try:
            cache = json.load(open(models_cache()))
        except Exception:
            cache = None
        return model_options(cache, default_model())

    # ---------------------------------------------------------------- one answer, nothing else
    answer_startup = 120

    def answer(self, path, system, user, *, model="", timeout=90, cwd=None, env=None,
               no_tools="Do not use any tools and do not read or write files. Answer directly."):
        # the whole prompt on stdin, read-only sandbox, an empty folder as its working directory (nothing of the
        # person's to read), the answer from --output-last-message; --ephemeral: no session is saved
        import shutil
        import subprocess
        import tempfile
        import dplatform as P
        work = tempfile.mkdtemp(prefix="dispatch-codex-")
        out = os.path.join(work, "answer.txt")
        argv = [path, "exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "--color", "never", "-o", out, "-C", work]
        if model and model != "default":
            argv += ["-m", model]
        try:
            r = subprocess.run(argv + ["-"], input=f"{system}\n\n{no_tools}\n\n{user}", capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=timeout, env=env, cwd=work,
                               creationflags=P.no_window_flags())
            text = open(out, encoding="utf-8").read().strip() if os.path.exists(out) else ""
        finally:
            shutil.rmtree(work, ignore_errors=True)
        if not text:
            tail = ((r.stderr or "") + (r.stdout or "")).strip()[-300:]
            if "--ephemeral" in tail or "unexpected argument" in tail:
                raise RuntimeError("This Codex version does not support exec --ephemeral. Upgrade with brew upgrade codex or npm i -g @openai/codex.")
            raise RuntimeError("codex exec failed: " + (tail or f"exit {r.returncode}"))
        return text

    def answer_models(self, purpose="summary"):
        latest = latest_models()
        if purpose == "summary":
            return [{"id": "default", "label": "Codex", "note": "default model"}] + [{"id": m, "label": f"Codex {name}"} for m, name in latest]
        return [{"id": m, "label": "Codex " + m} for m, _ in latest] or [{"id": "default", "label": "Codex"}]

    hook_presence = True
    hooks_json = True
    # Dispatch's entry (hook.py) on these events of ~/.codex/hooks.json; SessionStart has no matcher, so the brief
    # also comes after a compaction (the handoff written at the line reaches the compacted context)
    hook_routes = {"SessionStart": ("prime",), "UserPromptSubmit": ("life",), "PostToolUse": ("presence", "plan", "life"),
                   "Stop": ("life",)}
    hook_options = {"SessionStart": {"timeout": 45, "additionalContextLimit": 2500}, "UserPromptSubmit": {"timeout": 30},
                    "PostToolUse": {"timeout": 30}, "Stop": {"timeout": 30}}
    hook_trust = True
    presence_tools = ("Bash",)  # its commands say which task the session works on (presence.link_tasks)
    plan_tools = ("update_plan",)
    life_hooks = ("UserPromptSubmit", "PostToolUse", "Stop")

    def hooks_file(self, home):
        return os.path.join(home, ".codex", "hooks.json")

    def hook_listing(self, path, env=None):
        return hook_listing(path, env)

    def trust_hook(self, path, command, before=None, env=None):
        return trust_hook(path, command, before, env)

    def hook_trusted(self, path, command, env=None):
        rows = hook_listing(path, env)
        if rows is None:
            return None
        mine = [r for r in rows if r["command"] == command]
        return bool(mine) and all(r["trust"] in ("trusted", "managed") and r["enabled"] for r in mine)

    def sign_in_status(self, path, env):
        import onboarding
        code, out, err = onboarding._run([path, "login", "status"], 12, env)
        text = (out + err).lower()
        if "chatgpt" in text:
            return "Signed in with ChatGPT"
        if "api key" in text:
            return "Signed in with an API key"
        return "Signed in" if code == 0 and "logged in" in text else "Not signed in"

    chat_driver = ("chat_codex", "CodexAdapter")
    chat_sleeps_when_idle = True
    chat_account_restart = "daemon"  # one `codex app-server` serves every Codex session
    chat_takes_terminal = True

    def chat_restart_daemon(self):
        import chat_codex
        chat_codex.restart_daemon()

    # ---------------------------------------------------------------- MCP servers
    # $CODEX_HOME/config.toml (~/.codex) [mcp_servers.<name>] tables. Per project: <folder>/.codex/config.toml
    # [mcp_servers.<name>] enabled = false (Codex reads that file in a folder it trusts; it asks the first time it runs there)
    mcp_signin = "codex mcp login {name}"

    def mcp_file(self, home, env):
        return os.path.join(env.get("CODEX_HOME") or os.path.join(home, ".codex"), "config.toml")

    def mcp_rows(self, path, cwd=""):
        return mcp_rows_in(path)

    def mcp_edit(self, path, name, spec):
        return mcp_edit_file(path, name, spec)

    def mcp_raw(self, path, name):
        import mcp_config as M
        return mcp_servers(M._read(path) or "").get(name)

    def mcp_current(self, path, name, spec):
        v = self.mcp_raw(path, name) or {}
        return (list(v.get("env_vars") or []) == list(spec.get("pass_env") or [])
                and (v.get("default_tools_approval_mode") == "approve") == bool(spec.get("trusted"))
                and int(v.get("tool_timeout_sec") or 0) == int(spec.get("timeout") or 0))

    def mcp_spec(self, name, v):
        import mcp_config as M
        if v.get("http_headers_helper"):
            raise ValueError(f"{name} in Codex gets its headers from a helper program; copy it by hand")
        spec = M.blank_spec()
        spec.update(url=str(v.get("url") or ""), command=str(v.get("command") or ""), args=[str(x) for x in v.get("args") or []],
                    env={k: str(x) for k, x in (v.get("env") or {}).items()},
                    headers={k: str(x) for k, x in (v.get("http_headers") or {}).items()})
        spec["header_env"] = {k: str(x) for k, x in (v.get("env_http_headers") or {}).items()}
        if v.get("bearer_token_env_var"):
            spec["header_env"]["Authorization"] = str(v["bearer_token_env_var"])
            spec["header_prefix"]["Authorization"] = "Bearer "
        if v.get("cwd"):
            raise ValueError(f"{name} in Codex runs in its own folder (cwd); copy it by hand")
        return spec

    def mcp_project(self, folder, user_path, env):
        import mcp_config as M
        here_file = os.path.join(folder, ".codex", "config.toml")
        user = mcp_servers(M._read(user_path) or "") if os.path.isfile(user_path) else {}
        here_all = mcp_servers(M._read(here_file) or "") if os.path.isfile(here_file) else {}
        trusted = trusts(folder, user_path)
        out = []

        def row(v):
            return {"url": v.get("url"), "command": v.get("command"), "args": [str(x) for x in v.get("args") or []],
                    "transport": "http" if v.get("url") else "stdio"}
        for name, v in user.items():
            v = v if isinstance(v, dict) else {}
            here = here_all.get(name) if isinstance(here_all.get(name), dict) else {}
            on = (here.get("enabled") if trusted and "enabled" in here else v.get("enabled")) is not False
            out.append((name, row(v), "everyone", {"has": True, "on": on, "state": "on" if on else "off",
                                                   "where": here_file if "enabled" in here else user_path}))
        for name, v in here_all.items():
            v = v if isinstance(v, dict) else {}
            if name in user or not (v.get("command") or v.get("url")):
                continue
            on = trusted and v.get("enabled") is not False
            out.append((name, row(v), "project", {"has": True, "on": on, "state": "on" if on else "off", "where": here_file}))
        return {"servers": out, "files": {self.agent: here_file}, "extra": {"codex_trusted": trusted}}

    def mcp_project_set(self, folder, name, on, state, user_path, listing):
        import mcp_config as M
        path = os.path.join(folder, ".codex", "config.toml")
        user_has = name in mcp_servers(M._read(user_path) or "")
        new = mcp_set_enabled(M._read(path) or "", name, on, drop_if_only=user_has)
        if new.strip():
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(new)
        elif os.path.exists(path):
            os.remove(path)
        note = "" if listing.get("codex_trusted") else "Codex follows this once it trusts this folder (it asks the first time it works here)."
        return path, "", note


    def entrypoint_files(self, sid, cwd):
        home = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
        return (glob.glob(os.path.join(home, "sessions", "*", "*", "*", "*" + sid + ".jsonl"))
                + glob.glob(os.path.join(home, "archived_sessions", "*" + sid + ".jsonl")))

    def entrypoint_in(self, record):
        if record.get("entrypoint"):
            return str(record["entrypoint"])
        if record.get("type") == "session_meta":
            import dispatch
            payload = record.get("payload") or {}
            if isinstance(payload, dict):
                return dispatch.origin_of(payload.get("source"), payload.get("originator"))
        return None

    # ---------------------------------------------------------------- moving a conversation to another Mac
    # It asks "Do you trust the contents of this directory?" in a folder it has not seen; answering Yes writes
    # [projects."<cwd>"] trust_level = "trusted" to ~/.codex/config.toml: move_trust_script writes that entry over
    # there first (backup to config.toml.dispatch-bak).
    def move_target(self, path, remote_home, remote_cwd):
        import dispatch as D
        rel = os.path.relpath(path, os.path.join(D.HOME, ".codex"))
        if rel.startswith(".."):
            raise RuntimeError(_t("The Codex session file is not under ~/.codex, so it is unclear where it belongs", "Codex 会话文件不在 ~/.codex 下，不知道该放哪"))
        return f"{remote_home}/.codex/{rel}", True

    # ---------------------------------------------------------------- a project's own settings it reads
    project_files = (("AGENTS.md", "instructions"), ("AGENTS.override.md", "instructions"), (".codex/hooks.json", "hooks"))

    def project_notes(self, folder, own):
        rels = {o["rel"] for o in own}
        if "AGENTS.override.md" in rels and "AGENTS.md" in rels:
            return [{"id": "agents-override", "text": "AGENTS.override.md is here, so Codex reads it instead of AGENTS.md in this project."}]
        return []

    def user_notes(self, home, dispatch):
        own = os.path.join(os.environ.get("CODEX_HOME") or os.path.join(home, ".codex"), "AGENTS.override.md")
        rules = self.rules_target(home)
        if os.path.isfile(own) and rules and any(d["file"] == rules["path"] for d in dispatch):
            return [{"id": "codex-override", "text": "Your ~/.codex/AGENTS.override.md wins over ~/.codex/AGENTS.md, so Codex does not read the rules Dispatch keeps there."}]
        return []

    # ---------------------------------------------------------------- the instruction files it reads
    instructions_url = "https://learn.chatgpt.com/docs/agent-configuration/agents-md"
    instructions_model_re = r"gpt|codex|o[134]"
    instructions_note = "Codex：尊重 override 优先级与项目文档预算；保留工具、验证和交付约定，避免重复项目上下文。"
    instructions_note_en = "Codex: respect the override order and the project document budget; keep the conventions for tools, checks and delivery, and do not repeat the project's context."

    def _instruction_home(self, home, env):
        from pathlib import Path
        return Path((env or {}).get("CODEX_HOME") or Path(home) / ".codex")

    def instruction_files(self, home, project=None, env=None):
        from pathlib import Path
        import instructions

        def pair(folder):
            # a non-empty AGENTS.override.md next to it: AGENTS.md is not read for that scope
            shadowed = bool(instructions.text(folder / "AGENTS.override.md").strip())
            return [(folder / "AGENTS.override.md", True), (folder / "AGENTS.md", not shadowed)]
        files = pair(self._instruction_home(home, env))
        if project:
            root = Path(project)
            files += [(root / "AGENTS.md", not bool(instructions.text(root / "AGENTS.override.md").strip())), (root / "AGENTS.override.md", True)]
        return files

    def instruction_model(self, home, env=None):
        import instructions
        path = self._instruction_home(home, env) / "config.toml"
        try:
            import toml_lite
            cfg = toml_lite.loads(instructions.text(path))
        except (ValueError, ImportError):
            return None
        return {"agent": self.id, "model": cfg.get("model", ""), "source": str(path), "limit": cfg.get("project_doc_max_bytes", 32768)}

    def instruction_findings(self, doc, models):
        limit = next((m.get("limit", 32768) for m in models if m["agent"] == self.id), 32768)
        if doc["bytes"] >= limit:
            return [(_t(f"Reaches the {limit}-byte document budget in Codex's configuration", f"达到 Codex 配置中的 {limit} 字节文档预算"), _t("Shorten the global content to leave room for project instructions; the budget includes the merged project documents.", "缩减全局内容，为项目指令留出空间；预算包括合并后的项目文档。"))]
        return []

    # ---------------------------------------------------------------- its long-term memory: one file, a `## Thread` block per entry
    memory_one_file = True

    def memory_files(self, home):
        return os.path.join(home, ".codex", "memories", "raw_memories.md")

    def memory_rows(self, path, ctx):
        """One entry per `## Thread` block; `### Task N:` only splits sub-parts of the same thread."""
        import memories
        try:
            st = os.stat(path)
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            return []
        rows = []
        chunks = re.split(r"(?m)^## Thread `([0-9a-fA-F-]{8,})`[^\n]*\n", text)
        for i in range(1, len(chunks) - 1, 2):
            uid, block = chunks[i], chunks[i + 1]
            f = memory_header(block)
            cwd = f.get("cwd", "")
            body = block.rstrip("\n")
            rows.append({
                "id": "codex:" + uid, "agent": self.agent, "project": memories.project_name(cwd, ctx.names, ctx.roots) if cwd else _t("General", "通用"),
                "project_dir": cwd, "expired": False, "path": path,
                "name": f.get("task") or f.get("description") or ("Thread " + uid[:8]),
                "description": f.get("description", ""), "type": "", "index": False,
                "size": len(body.encode("utf-8")), "mtime": st.st_mtime, "body": body,
            })
        return rows


# ---------------------------------------------------------------- moving a conversation to another Mac (move.py)
MOVE_TRUST_SCRIPT = r"""
import os, shutil, sys
cwd, apply = sys.argv[1], sys.argv[2:3] != ["0"]
path = os.path.expanduser("~/.codex/config.toml")
try:
    text = open(path).read()
except FileNotFoundError:
    text = ""
header = '[projects."%s"]' % cwd.replace("\\", "\\\\").replace('"', '\\"')
if header in text:
    print("already"); sys.exit(0)
if not apply:
    print("needed"); sys.exit(0)
os.makedirs(os.path.dirname(path), exist_ok=True)
if text:
    shutil.copy2(path, path + ".dispatch-bak")
with open(path, "a") as f:
    f.write(("" if not text or text.endswith("\n") else "\n") + header + '\ntrust_level = "trusted"\n')
print("set")
"""


# ---------------------------------------------------------------- its memory file
def memory_header(block):
    """Header fields right after a `## Thread` line (description / task / cwd / keywords…),
    fenced or not, with optional leading space; `### Task N:` ends the header section."""
    fields = {}
    for line in block.splitlines():
        if re.match(r"^#{2,}\s", line):
            break
        m = re.match(r"^\s*(description|task_group|task_outcome|task|cwd|keywords)\s*:\s*(.*)$", line)
        if m and m.group(1) not in fields:
            fields[m.group(1)] = m.group(2).strip()
    return fields


# ---------------------------------------------------------------- MCP servers in config.toml (edited as text)

def _toml_value(raw):
    raw = raw.strip()
    if raw.startswith(('"', "'")):
        q = raw[0]
        end = raw.find(q, 1)
        while q == '"' and end > 0 and raw[end - 1] == "\\":
            end = raw.find(q, end + 1)
        return json.loads(raw[:end + 1]) if q == '"' else raw[1:end]
    if raw.startswith("["):
        return [_toml_value(x) for x in re.findall(r'"(?:[^"\\]|\\.)*"|\'[^\']*\'', raw)]
    if raw.startswith("{"):
        return {k.strip().strip('"'): _toml_value(v) for k, v in re.findall(r'([\w"-]+)\s*=\s*("(?:[^"\\]|\\.)*"|\'[^\']*\'|[^,}]+)', raw)}
    if raw in ("true", "false"):
        return raw == "true"
    try:
        return int(raw)
    except ValueError:
        return raw


def _header(line):
    m = re.match(r"^\s*\[([^\[\]]+)\]\s*(#.*)?$", line)
    if not m:
        return None
    return [p.strip().strip('"').strip("'") for p in re.findall(r'"[^"]*"|\'[^\']*\'|[^.]+', m.group(1))]


def mcp_servers(text):
    """{name: {key: value, env: {...}, http_headers: {...}}} from config.toml text. tomllib when this
    Python has it; else a small reader for the shapes Codex writes (strings, arrays, inline tables)."""
    try:
        import tomllib
        return dict((tomllib.loads(text).get("mcp_servers") or {}))
    except ImportError:
        pass
    servers, current = {}, None
    for line in text.splitlines():
        if re.match(r"^\s*\[\[", line):
            current = None  # an array of tables ([[skills.config]]) is never an MCP server
            continue
        parts = _header(line)
        if parts is not None:
            current = None
            if len(parts) >= 2 and parts[0] == "mcp_servers":
                row = servers.setdefault(parts[1], {})
                current = row if len(parts) == 2 else row.setdefault(parts[2], {})
            continue
        if current is None or line.strip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        current[key.strip().strip('"')] = _toml_value(value)
    return servers


def mcp_rows_in(path):
    import mcp_config as M
    text = M._read(path)
    rows = []
    for name, v in mcp_servers(text or "").items():
        v = v if isinstance(v, dict) else {}
        rows.append({"name": name, "engine": "codex", "scope": "user", "transport": "http" if v.get("url") else "stdio",
                     "command": str(v.get("command") or ""), "args": [str(x) for x in v.get("args") or []], "url": str(v.get("url") or ""),
                     "env": M._names(v.get("env")), "headers": sorted(set(M._names(v.get("http_headers"))) | set(M._names(v.get("env_http_headers")))),
                     "enabled": v.get("enabled") is not False, "path": path})
    return rows


def _toml_key(name):
    import mcp_config as M
    return name if M.BARE.match(name) else json.dumps(name)


def _toml_str(value):
    return json.dumps(str(value), ensure_ascii=False)


def mcp_section(name, spec):
    key = "mcp_servers." + _toml_key(name)
    lines = [f"[{key}]"]
    if spec["url"]:
        lines.append(f"url = {_toml_str(spec['url'])}")
        if spec["headers"]:
            lines.append("http_headers = { " + ", ".join(f"{_toml_key(k)} = {_toml_str(v)}" for k, v in spec["headers"].items()) + " }")
        odd = [k for k, v in spec.get("header_prefix", {}).items() if v and not (k.lower() == "authorization" and v == "Bearer ")]
        if odd:
            raise ValueError("Codex cannot put text around an environment variable in a header (" + ", ".join(odd) + "); add it by hand")
        plain = {k: v for k, v in spec.get("header_env", {}).items() if not spec.get("header_prefix", {}).get(k)}
        if plain:
            lines.append("env_http_headers = { " + ", ".join(f"{_toml_key(k)} = {_toml_str(v)}" for k, v in plain.items()) + " }")
        bearer = [v for k, v in spec.get("header_env", {}).items() if k.lower() == "authorization" and spec.get("header_prefix", {}).get(k) == "Bearer "]
        if bearer:
            lines.append(f"bearer_token_env_var = {_toml_str(bearer[0])}")
    else:
        lines.append(f"command = {_toml_str(spec['command'])}")
        lines.append("args = [" + ", ".join(_toml_str(a) for a in spec["args"]) + "]")
        if spec.get("pass_env"):
            # Codex hands a local server only HOME, PATH and a few more; these come from its own environment too
            lines.append("env_vars = [" + ", ".join(_toml_str(v) for v in spec["pass_env"]) + "]")
    if spec.get("trusted"):
        lines.append('default_tools_approval_mode = "approve"')
    if spec.get("timeout"):
        lines.append(f"tool_timeout_sec = {int(spec['timeout'])}")
    if not spec["url"] and spec["env"]:
        lines.append(f"[{key}.env]")
        lines += [f"{_toml_key(k)} = {_toml_str(v)}" for k, v in spec["env"].items()]
    return "\n".join(lines) + "\n"


def mcp_without(text, name):
    """The text without [mcp_servers.<name>] and its sub-tables. Comments and blank lines right before
    the next table stay: they belong to it."""
    out, skipping, held = [], False, []
    for line in text.splitlines(keepends=True):
        parts = _header(line) or (["[["] if re.match(r"^\s*\[\[", line) else None)
        if parts is not None:
            mine = len(parts) >= 2 and parts[0] == "mcp_servers" and parts[1] == name
            if skipping and not mine:
                out += held
            held = []
            skipping = mine
            if mine:
                continue
        if skipping:
            if not line.strip() or line.lstrip().startswith("#"):
                held.append(line)
            else:
                held = []
            continue
        out.append(line)
    return "".join(out)


def mcp_edit_file(path, name, spec):
    import mcp_config as M
    text = M._read(path) or ""
    exists = name in mcp_servers(text)
    if spec is None and not exists:
        return None
    new = mcp_without(text, name) if exists else text
    if spec is not None:
        new = new.rstrip("\n") + ("\n\n" if new.strip() else "") + mcp_section(name, spec)
    return M._write(path, new)


def trusts(folder, user_path):
    """Codex reads <folder>/.codex/config.toml only in a folder trusted in its own config.toml."""
    import mcp_config as M
    text = M._read(user_path) or ""
    real = os.path.realpath(folder)
    try:
        import tomllib
        projects = tomllib.loads(text).get("projects") or {}
        return any(os.path.realpath(k) == real and (v or {}).get("trust_level") == "trusted" for k, v in projects.items())
    except ImportError:
        pass
    except ValueError:
        return False
    current = None
    for line in text.splitlines():
        parts = _header(line)
        if parts is not None:
            current = parts[1] if len(parts) == 2 and parts[0] == "projects" else None
            continue
        if current and os.path.realpath(current) == real and re.match(r'^\s*trust_level\s*=\s*"trusted"', line):
            return True
    return False


def mcp_set_enabled(text, name, enabled, drop_if_only=True):
    """<folder>/.codex/config.toml with [mcp_servers.<name>] enabled = <enabled>; a table that would only say
    `enabled = true` is taken out instead (the user's own server is on again). Other lines stay as they are."""
    lines = text.splitlines(keepends=True)
    start = end = None
    for i, line in enumerate(lines):
        parts = _header(line) or (["[["] if re.match(r"^\s*\[\[", line) else None)
        if parts is None:
            continue
        if start is not None and end is None:
            end = i
        if len(parts) == 2 and parts[0] == "mcp_servers" and parts[1] == name:
            start, end = i, None
    if start is None:
        if enabled and drop_if_only:
            return text
        body = text.rstrip("\n")
        return body + ("\n\n" if body else "") + f"[mcp_servers.{_toml_key(name)}]\nenabled = {'true' if enabled else 'false'}\n"
    end = len(lines) if end is None else end
    table = lines[start:end]
    keys = [l for l in table[1:] if l.strip() and not l.lstrip().startswith("#")]
    sub = any((_header(l) or [None])[:2] == ["mcp_servers", name] and len(_header(l)) > 2 for l in lines[end:end + 1])
    if enabled and drop_if_only and all(re.match(r"^\s*enabled\s*=", l) for l in keys) and not sub:
        out = lines[:start] + lines[end:]
        return "".join(out).rstrip("\n") + ("\n" if "".join(out).strip() else "")
    table = [l for l in table if not re.match(r"^\s*enabled\s*=", l)]
    table.insert(1, f"enabled = {'true' if enabled else 'false'}\n")
    return "".join(lines[:start] + table + lines[end:])



# ---------------------------------------------------------------- in Dispatch's terminal (terminal_hook.py)
def notify_program(python, script):
    """Codex's `-c notify=[...]` value: Codex runs it with the turn's JSON as the last argument."""
    return json.dumps([python, script, "codex", "--terminal", "notify"])


def has_own_notify(env=None):
    """The person set Codex's `notify` program themselves (config.toml): Dispatch leaves it alone."""
    env = os.environ if env is None else env
    home = env.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")
    try:
        with open(os.path.join(home, "config.toml"), encoding="utf-8") as f:
            return any(re.match(r"\s*notify\s*=", line) for line in f)
    except Exception:
        return False


# ---------------------------------------------------------------- its models (models.py): ~/.codex/models_cache.json,
# the list Codex itself fetches for the ChatGPT account
def models_cache():
    import dispatch as D
    return os.path.join(D.HOME, ".codex", "models_cache.json")


def default_model():
    import dispatch as D
    try:
        m = re.search(r'^model\s*=\s*"([^"]+)"', open(os.path.join(D.HOME, ".codex", "config.toml")).read(), re.M)
        return m.group(1) if m else ""
    except Exception:
        return ""


def model_options(cache, default=""):
    rows = sorted([m for m in (cache or {}).get("models") or [] if m.get("slug") and m.get("visibility", "list") == "list"], key=lambda m: m.get("priority", 999))
    name = next((m.get("display_name") for m in rows if m["slug"] == default), default)
    out = [{"id": "", "label": _t(f"Default ({name})", f"默认（{name}）") if name else _t("Default", "默认"), "default": name or ""}]
    for m in rows:
        note = ((m.get("upgrade") or {}).get("migration_markdown") or m.get("description") or "").strip()
        out.append({"id": m["slug"], "label": m.get("display_name") or m["slug"], "note": note, "latest": not m.get("upgrade")})
    return out



# ---------------------------------------------------------------- its allowance: the rate_limits it writes into its rollouts
def own_quota():
    """Codex writes a token_count event with rate_limits into each rollout; take the newest."""
    import glob
    import dispatch as D
    best = None
    files = sorted(glob.glob(os.path.join(D.HOME, ".codex", "sessions", "**", "*.jsonl"), recursive=True), key=os.path.getmtime, reverse=True)[:12]
    for f in files:
        try:
            with open(f, "rb") as fh:
                fh.seek(max(0, os.path.getsize(f) - 400_000))
                tail = fh.read().decode("utf-8", "replace")
        except OSError:
            continue
        for line in reversed(tail.splitlines()):
            if '"token_count"' not in line or '"rate_limits"' not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            rl = (d.get("payload") or {}).get("rate_limits")
            if not rl:
                continue
            ts = d.get("timestamp", "")
            if best is None or ts > best[0]:
                best = (ts, rl)
            break
    if not best:
        return {"agent": "codex", "plan": "", "windows": [], "updated_at": None, "source": "rollout", "note": "No Codex usage records found"}
    ts, rl = best
    if (D._iso_epoch(ts) or 0) < D._switched_at("codex"):  # written before the last account switch: the old account's
        return {"agent": "codex", "plan": "", "windows": [], "updated_at": None, "source": "rollout", "note": "No usage numbers for this account yet."}
    wins = []
    for key, label, kind in (("primary", "5h", "session"), ("secondary", "Weekly", "weekly")):
        w = rl.get(key) or {}
        if w:
            mins = w.get("window_minutes")
            lab = label if not mins else ("5h" if mins <= 360 else "Weekly" if mins >= 10000 else f"{mins // 60}h")
            # kind: session | weekly, as for Claude (readers must not match the Chinese label); the length wins over the slot
            kind = kind if not mins else ("session" if mins <= 360 else "weekly" if mins >= 10000 else kind)
            wins.append({"label": lab, "kind": kind, "used_percent": w.get("used_percent"), "resets_at": w.get("resets_at")})
    upd = D._iso_epoch(ts)
    return {"agent": "codex", "plan": rl.get("plan_type") or "", "windows": wins, "updated_at": upd, "source": "rollout", "note": ""}


def quota_points(text):
    """Codex rollout lines → [(epoch, session_used, weekly_used)] from its token_count rate_limits."""
    pts = []
    for line in text.splitlines():
        if '"rate_limits"' not in line or '"token_count"' not in line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        rl = (d.get("payload") or {}).get("rate_limits") or {}
        import dispatch as D
        ts = D._iso_epoch(d.get("timestamp", ""))
        if not rl or not ts:
            continue
        vals = {"session": None, "weekly": None}
        for key in ("primary", "secondary"):
            w = rl.get(key) or {}
            if not isinstance(w.get("used_percent"), (int, float)):
                continue
            mins = w.get("window_minutes") or (300 if key == "primary" else 10080)
            vals["session" if mins <= 360 else "weekly" if mins >= 10000 else key] = round(float(w["used_percent"]), 1)
        if vals["session"] is not None or vals["weekly"] is not None:
            pts.append((round(ts, 1), vals["session"], vals["weekly"]))
    return pts


def quota_history(since, home=None, cache_path=None):
    """Every rollout touched since `since`, read once per (mtime, size) and cached."""
    import glob
    import usage as U
    home = home or os.path.expanduser("~")
    cache_path = cache_path or os.path.join(U.usage_dir(), "codex-limits.json")
    cache = U._read_json(cache_path, {}) or {}
    files = cache.get("files") or {}
    seen, changed = {}, False
    for f in glob.glob(os.path.join(home, ".codex", "sessions", "**", "*.jsonl"), recursive=True):
        try:
            st = os.stat(f)
        except OSError:
            continue
        if st.st_mtime < since:
            continue
        key = "%d:%d" % (int(st.st_mtime), st.st_size)
        ent = files.get(f)
        if not ent or ent.get("key") != key:
            try:
                with open(f, encoding="utf-8", errors="replace") as fh:
                    ent = {"key": key, "points": quota_points(fh.read())}
            except OSError:
                continue
            changed = True
        seen[f] = ent
    if changed or len(seen) != len(files):
        U._write_json(cache_path, {"files": seen})
    pts = sorted(tuple(p) for ent in seen.values() for p in ent["points"] if p[0] >= since)
    return pts



# ---------------------------------------------------------------- the index's usage stats of a rollout
def parse_stats(e, buf, re_ts):
    """Codex logs a cumulative total_token_usage per turn; tokens = last total, activity = the deltas."""
    import dispatch as D
    for line in buf.split("\n"):
        if not line.startswith("{"):
            continue
        if '"token_count"' in line and '"total_token_usage"' in line:
            try:
                d = json.loads(line)
            except Exception:
                continue
            tu = ((d.get("payload") or {}).get("info") or {}).get("total_token_usage") or {}
            if not tu:
                continue
            total = tu.get("total_tokens", 0) or 0
            delta = max(0, total - e["codex_prev"])
            e["codex_prev"] = total
            from session_life import codex_usage
            parts = codex_usage(tu)
            e["tokens"] = {"in": parts["input"], "out": parts["output"], "cr": parts["cache_read"], "cw": parts["cache_write"], "think": tu.get("reasoning_output_tokens", 0) or 0}
            D.bump_time(e, D.local_dt(d.get("timestamp", "")), 0, delta, (0, 0, 0, 0))
        elif '"turn_context"' in line:
            m = re.search(r'"model":"([^"]+)"', line)
            if m:
                e["models"][m.group(1)] = e["models"].get(m.group(1), 0) + 1
        elif is_tool_call(line):
            for name in skills_read(line):
                e["skills"][name] = e["skills"].get(name, 0) + 1
        elif '"type":"response_item"' in line and '"type":"message"' in line and ('"role":"user"' in line or '"role":"assistant"' in line):
            m = re_ts.search(line)
            if m:
                D.bump_time(e, D.local_dt(m.group(1)), 1, 0)
# Skills a rollout used: the SKILL.md files its own tool calls read. Only a `response_item` that is a tool call counts:
# the system prompt lists every skill's SKILL.md path, and a `compacted` record repeats the whole history with that list
# (counted as use until 2026-10-09, kanban task-it54z: pdf, documents, presentations… 21 times a session).
SKILLS_V = 2


RE_TOOL_CALL = re.compile(r'"payload":\s*\{\s*"type":\s*"(?:function_call|custom_tool_call)"')


def is_tool_call(line):
    return '"response_item"' in line and RE_TOOL_CALL.search(line) is not None


def skills_read(line):
    import dispatch as D
    return [m.group(1) for m in D.RE_SKILL_FILE.finditer(line) if m.group(1)[:1].isalnum()]


def recount_skills(path, upto):
    """The skills of the first `upto` bytes of a rollout (what an index row counted before SKILLS_V), read again."""
    out = {}
    try:
        pos = 0
        with open(path, "rb") as fh:
            for raw in fh:
                pos += len(raw)
                if pos > upto:
                    break
                line = raw.decode("utf-8", "replace")
                if is_tool_call(line):
                    for name in skills_read(line):
                        out[name] = out.get(name, 0) + 1
    except OSError:
        return None
    return out


def meta_origin(path, limit=4 * 1024 * 1024):
    """Codex rollouts name their front end only in the first record (session_meta) — a long line,
    since it also carries the whole base_instructions text."""
    import dispatch as D
    try:
        with open(path, "rb") as f:
            first = f.readline(limit).decode("utf-8", "replace")
        p = json.loads(first)
        p = p.get("payload", p)
        return D.origin_of(p.get("source"), p.get("originator"))
    except Exception:
        return ""


def latest_models():
    """[(slug, display name)] of the current models its own list offers (no network); [] when that fails."""
    try:
        return [(r["id"], r["label"]) for r in ENGINE.models() if r.get("id") and r.get("latest", True)]
    except Exception:
        return []


# ---------------------------------------------------------------- Codex trusts Dispatch's hook (hooks_setup.py)
# Codex runs a hook from hooks.json only once it is trusted: config.toml [hooks.state."<file>:<event>:<group>:<hook>"]
# trusted_hash = the hash of that hook as Codex normalises it (codex-rs/hooks/src/engine/discovery.rs). Codex's own
# TUI trusts a hook by asking its app server for hooks/list (each hook's key, currentHash, trustStatus) and writing
# config/batchWrite {keyPath: "hooks.state", value: {key: {trusted_hash}}, mergeStrategy: upsert}
# (codex-rs/tui/src/hooks_rpc.rs). Dispatch does the same for its own entry, and nothing else of the person's.
APP_SERVER_TIMEOUT = 30


def app_server(calls, env=None, codex_home="", timeout=APP_SERVER_TIMEOUT):
    """Ask one short-lived `codex app-server` a few JSON-RPC calls in order: [result | {"error": ...}]; None when
    Codex cannot be started. `codex_home`: the Codex folder to ask about (CODEX_HOME)."""
    import subprocess
    import threading
    import engines as E
    env = dict(os.environ if env is None else env)
    if codex_home and not same_codex_home(codex_home, env):
        # only when it is not where Codex looks anyway: Codex keys a hook's trust by its file's path as it found it,
        # and an explicit CODEX_HOME reaches it by another spelling (/tmp vs /private/tmp) than $HOME/.codex does
        env["CODEX_HOME"] = codex_home
    env["PATH"] = E.search_path(env)
    path = E.which("codex", env)
    if not path:
        return None
    try:
        p = subprocess.Popen([path, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             env=env, text=True, cwd=codex_home or None)
    except OSError:
        return None
    timer = threading.Timer(timeout, p.kill)
    timer.start()
    out = []
    try:
        def send(msg):
            p.stdin.write(json.dumps(msg) + "\n")
            p.stdin.flush()

        def answer(i):
            for line in p.stdout:
                try:
                    m = json.loads(line)
                except ValueError:
                    continue
                if m.get("id") == i:
                    return m
            return None

        send({"id": 0, "method": "initialize", "params": {"clientInfo": {"name": "dispatch", "title": "Dispatch", "version": "1"}}})
        if not answer(0):
            return None
        send({"method": "initialized"})
        for i, (method, params) in enumerate(calls, 1):
            send({"id": i, "method": method, "params": params})
            m = answer(i)
            if m is None:
                return None
            out.append(m["result"] if "result" in m else {"error": (m.get("error") or {}).get("message") or "failed"})
        return out
    except (OSError, ValueError):
        return None
    finally:
        timer.cancel()
        try:
            p.stdin.close()
        except OSError:
            pass
        p.terminate()
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()


def same_codex_home(folder, env):
    """Whether `folder` is the Codex folder Codex uses with `env` (CODEX_HOME, else $HOME/.codex)."""
    default = env.get("CODEX_HOME") or os.path.join(env.get("HOME") or os.path.expanduser("~"), ".codex")
    return os.path.realpath(folder) == os.path.realpath(default)


def hook_listing(path, env=None):
    """The hooks Codex sees in `path`: [{key, event, command, hash, trust, enabled}], None when it cannot be asked."""
    home = os.path.dirname(os.path.abspath(path))
    r = app_server([("hooks/list", {"cwds": [os.path.dirname(home)]})], env, codex_home=home)
    if not r or "error" in r[0]:
        return None
    real = os.path.realpath(path)
    rows = []
    for entry in r[0].get("data") or []:
        for h in entry.get("hooks") or []:
            if os.path.realpath(str(h.get("sourcePath") or "")) != real or h.get("handlerType", "command") != "command":
                continue
            rows.append({"key": h.get("key") or "", "event": h.get("eventName") or "", "command": h.get("command") or "",
                         "hash": h.get("currentHash") or "", "trust": h.get("trustStatus") or "", "enabled": h.get("enabled", True) is not False})
    return rows


def trust_updates(rows, command, before=None):
    """{key: {trusted_hash?, enabled?}}: Dispatch's entry (exactly `command`) trusted; a hook of the person's that
    was trusted (or turned off) before keeps that at its new place. The same hook is the same event and hash; when
    several hooks are alike, they keep it in order."""
    import collections
    import hooks_setup
    updates = {}
    for r in rows:
        if r["command"] == command and r["trust"] not in ("trusted", "managed"):
            updates[r["key"]] = {"trusted_hash": r["hash"]}
    if before:
        theirs = [b for b in before if not hooks_setup.kind(b["command"])]
        trusted = collections.Counter((b["event"], b["hash"]) for b in theirs if b["trust"] == "trusted")
        off = collections.Counter((b["event"], b["hash"]) for b in theirs if not b["enabled"])
        for r in rows:
            if hooks_setup.kind(r["command"]):
                continue
            ident = (r["event"], r["hash"])
            if trusted[ident] > 0:
                trusted[ident] -= 1
                if r["trust"] != "trusted":
                    updates.setdefault(r["key"], {})["trusted_hash"] = r["hash"]
            if off[ident] > 0:
                off[ident] -= 1
                if r["enabled"]:
                    updates.setdefault(r["key"], {})["enabled"] = False
    return updates


def trust_hook(path, command, before=None, env=None):
    home = os.path.dirname(os.path.abspath(path))
    rows = hook_listing(path, env)
    if rows is None:
        return {"ok": False, "why": _t("Codex could not be asked (is it installed?); it runs Dispatch's hook once you trust it in Codex (/hooks)",
                                        "问不到 Codex（装了吗？）；在 Codex 里 /hooks 认可后它才会跑 Dispatch 的钩子")}
    mine = [r for r in rows if r["command"] == command]
    if not mine:
        return {"ok": False, "why": _t("Codex does not see Dispatch's hook in hooks.json", "Codex 没看到 hooks.json 里 Dispatch 的钩子")}
    updates = trust_updates(rows, command, before)
    kept = sum(1 for k in updates if k not in {r["key"] for r in mine})
    if updates:
        r = app_server([("config/batchWrite", {"edits": [{"keyPath": "hooks.state", "value": updates, "mergeStrategy": "upsert"}],
                                               "reloadUserConfig": True})], env, codex_home=home)
        if not r or "error" in r[0]:
            return {"ok": False, "why": (r[0]["error"] if r else _t("Codex did not answer", "Codex 没回应"))}
        rows = hook_listing(path, env) or []
        mine = [x for x in rows if x["command"] == command]
    ok = bool(mine) and all(x["trust"] in ("trusted", "managed") for x in mine)
    return {"ok": ok, "trusted": len(mine), "kept": kept, **({} if ok else {"why": _t("Codex did not take the trust", "Codex 没记下认可")})}


Codex.move_trust_script = MOVE_TRUST_SCRIPT
ENGINE = Codex()
