# -*- coding: utf-8 -*-
"""Gemini CLI (Google): `gemini`. Dispatch reads its conversations (~/.gemini/tmp/<project>/chats/session-*.json),
continues them in a terminal, and puts its rules in ~/.gemini/GEMINI.md.
Gemini CLI's local conversations, read the way Dispatch reads every other agent's.

Gemini CLI records each conversation as one JSON document (rewritten on every turn, not appended):

    ~/.gemini/tmp/<project>/chats/session-<YYYY-MM-DDTHH-MM>-<first 8 of the id>.json
    {sessionId, projectHash, startTime, lastUpdated, kind: "main" | "subagent", summary?,
     messages: [{id, timestamp, type: "user" | "gemini" | "info" | "error" | "warning",
                 content: str | [{text} | {inlineData} …], displayContent?,
                 thoughts?: [{subject, description, timestamp}], tokens?: {input, output, cached,
                 thoughts, tool, total}, model?, toolCalls?: [{id, name, args, result, status,
                 resultDisplay, timestamp, displayName}]}]}

<project> is a short slug (older versions: the sha256 of the project root); the folder's
.project_root file, or ~/.gemini/projects.json, names the directory it belongs to.
`gemini --resume <sessionId>` run in that directory continues it.
"""
import glob
import json
import os
import time
from lang import t as _t

from engines.base import Engine


class Gemini(Engine):
    id = "gemini"
    name = "Gemini CLI"
    short_name = "Gemini"
    maker = "Google"
    icon = "google-gemini"
    color = "#4b6fd8"
    about = "Google's coding assistant. Sign in with a Google account or use your own key."
    bins = ("gemini",)
    install_hint = "npm i -g @google/gemini-cli"

    config_home = "{home}/.gemini"
    rules_file = "{home}/.gemini/GEMINI.md"

    terminal_recipe = {"resume": "--resume latest"}

    def sign_in_local(self, home, env):
        return settings_sign_in(home, env, ".gemini", "Signed in with Google", "GEMINI_API_KEY")

    # ---------------------------------------------------------------- MCP servers: "mcpServers" in ~/.gemini/settings.json
    # {command, args, env} for a local server; httpUrl (streamable HTTP) or url (SSE) with headers for a remote one; a
    # server named in mcp.excluded is off. Headers and env take $VAR / ${VAR} from the environment.
    mcp_signin = "in a Gemini CLI session run /mcp auth {name} (a browser page opens)"

    def mcp_file(self, home, env):
        return os.path.join(env.get("GEMINI_CLI_HOME") or home, ".gemini", "settings.json")

    def mcp_rows(self, path, cwd=""):
        import mcp_config as M
        data = _settings(path)
        off = set((data.get("mcp") or {}).get("excluded") or [])
        rows = []
        for name, v in (data.get("mcpServers") or {}).items():
            v = v if isinstance(v, dict) else {}
            rows.append({"name": name, "engine": self.agent, "scope": "user",
                         "transport": "http" if v.get("httpUrl") else "sse" if v.get("url") else "stdio",
                         "command": str(v.get("command") or ""), "args": [str(x) for x in v.get("args") or []],
                         "url": str(v.get("httpUrl") or v.get("url") or ""), "env": M._names(v.get("env")),
                         "headers": M._names(v.get("headers")), "enabled": name not in off, "path": path})
        return rows

    def mcp_edit(self, path, name, spec):
        import mcp_config as M
        entry = None
        if spec and spec["url"]:
            entry = {"url" if spec["transport"] == "sse" else "httpUrl": spec["url"]}
            headers = {**spec["headers"], **{k: spec.get("header_prefix", {}).get(k, "") + "${" + v + "}"
                                             for k, v in spec.get("header_env", {}).items()}}
            if headers:
                entry["headers"] = headers
        elif spec:
            entry = {"command": spec["command"], "args": spec["args"], **({"env": spec["env"]} if spec["env"] else {})}
        return M.json_edit(path, name, entry)

    def mcp_raw(self, path, name):
        return (_settings(path).get("mcpServers") or {}).get(name)

    def mcp_spec(self, name, v):
        import mcp_config as M
        spec = M.blank_spec()
        spec.update(url=str(v.get("httpUrl") or v.get("url") or ""), transport="http" if v.get("httpUrl") or not v.get("url") else "sse",
                    command=str(v.get("command") or ""), args=[str(x) for x in v.get("args") or []],
                    env={k: str(x) for k, x in (v.get("env") or {}).items()},
                    headers={k: str(x) for k, x in (v.get("headers") or {}).items()})
        return spec

    def live_sessions(self, table):
        return live(table)

    def index_store(self, idx, seen, rx):
        index(idx, seen, rx.task, rx.claim_id)

    def detail(self, ref, limit, since=None):
        return detail(ref, limit, since)

    def activity_sessions(self, home, db):
        procs = False  # looked up once, and only when a file's last turn is open
        out = []
        for path, s in activity_files(home, db):
            if not s.get("last_at"):
                continue
            if s.get("open_tail") and procs is False:
                try:
                    procs = activity_processes()
                except Exception:  # noqa: BLE001
                    procs = None
            out.append((path, activity_settle(dict(s), None if procs is False else procs)))
        return out

    def history_read(self, path, row):
        """History's row of one conversation file: what was typed, the last message, the model."""
        history_read(path, row)

    def resume(self, sid, key=""):
        return ["--resume", sid], {}



def history_read(path, row):
    import session_history as SH
    d = load(path)
    if d is None:
        return
    typed, last = [], None
    for m in d.get("messages") or []:
        if not isinstance(m, dict):
            continue
        if m.get("type") == "user" and not is_tool_echo(m):
            t = SH.clean(user_text(m))
            if t:
                typed.append(t)
                last = ("user", t)
        elif m.get("type") == "gemini":
            t = SH.clean(reply(m)[1])
            if t:
                last = ("agent", t)
            if m.get("model"):
                row["last_model"] = m["model"]
    row["n_prompts"], row["prompts"] = len(typed), "\n".join(typed)[:SH.PROMPTS_CAP]
    if last:
        row["last_role"], row["last_text"] = last[0], last[1][:SH.PREVIEW_CAP]
    st = os.stat(path)
    row["mtime"], row["size"], row["off"] = st.st_mtime, st.st_size, st.st_size



# ---------------------------------------------------------------- the index, the session page and presence
def index(idx, seen, re_task, re_claim_id):
    """Gemini CLI conversations, keyed by their file. The file is rewritten on every turn, so a
    change means one full read of it."""
    import dispatch as D
    for path in chat_files(D.HOME):
        seen.add(path)
        try:
            st = os.stat(path)
        except OSError:
            continue
        e = idx.get(path)
        if e and e.get("mtime") == st.st_mtime and e.get("size") == st.st_size and e.get("stats_v") == D.STATS_V:
            continue
        d = load(path)
        if d is None:
            if e:
                idx[path] = e  # being rewritten right now: keep the last good read
            continue
        msgs = [m for m in d["messages"] if isinstance(m, dict)]
        e = {"agent": "gemini", "session_id": d.get("sessionId") or "", "cwd": project_root(path, D.HOME), "title": (d.get("summary") or "").strip(), "mtime": st.st_mtime, "size": st.st_size, "off": st.st_size, "tasks": {}, "claims": [], "subagent": (d.get("kind") or "main") != "main", "entrypoint": "cli", "branch": "", "first_ts": d.get("startTime") or (msgs[0].get("timestamp", "") if msgs else ""), "last_ts": d.get("lastUpdated") or (msgs[-1].get("timestamp", "") if msgs else ""), "user_msgs": 0, "assistant_msgs": 0, "tools": {}, "first_prompt": "", "stats_v": D.STATS_V, **D.stats_fields()}
        texts, calls = [], []
        for m in msgs:
            if m.get("type") == "user" and not is_tool_echo(m):
                e["user_msgs"] += 1
                txt = user_text(m)
                texts.append(txt)
                if not e["first_prompt"] and txt.strip():
                    e["first_prompt"] = txt.strip()[:240]
            elif m.get("type") == "gemini":
                e["assistant_msgs"] += 1
                texts.append(reply(m)[1])
                for tc in tool_calls(m):
                    name = tc.get("name") or ""
                    if name:
                        e["tools"][name] = e["tools"].get(name, 0) + 1
                    calls.append({"args": tool_args(tc)})
                    texts.append(json.dumps(tool_args(tc), ensure_ascii=False))
        for m in re_task.finditer("\n".join(texts)):
            e["tasks"][m.group(0)] = e["tasks"].get(m.group(0), 0) + 1
        e["claims"].extend(D.claims_of_events(calls, re_claim_id, in_call=True))
        parse_stats(e, d)
        idx[path] = e


def parse_stats(e, d):
    """Tokens, models, skills and activity by hour of one Gemini CLI conversation (the whole file)."""
    import dispatch as D
    T = e["tokens"]
    for m in d.get("messages") or []:
        if not isinstance(m, dict) or m.get("type") not in ("user", "gemini"):
            continue
        dt = D.local_dt(m.get("timestamp") or "")
        if m["type"] == "user":
            if not is_tool_echo(m):
                D.bump_time(e, dt, 1, 0)
            continue
        i, o, cr, th = tokens(m)
        T["in"] += i; T["out"] += o; T["cr"] += cr; T["think"] += th
        if m.get("model"):
            e["models"][m["model"]] = e["models"].get(m["model"], 0) + 1
        D.bump_time(e, dt, 1, i + o + cr, (i, o, cr, 0))
        for tc in tool_calls(m):
            if tc.get("name") == "activate_skill" and tool_args(tc).get("name"):
                sk = tool_args(tc)["name"]
                e["skills"][sk] = e["skills"].get(sk, 0) + 1


def detail(ref, limit, since=None):
    """A Gemini CLI conversation file. Gemini rewrites the whole file and keeps adding tool calls to
    the reply that asked for them, so `since` is a message count and a tail read re-sends the last
    reply too: its text and thinking carry ids (the view replaces them), its tool calls ids (the
    view updates their status)."""
    import dispatch as D
    tl = D._Timeline()
    path = ref["path"]
    d = load(path) or {"messages": []}
    msgs = d["messages"]
    start = int(since or 0)
    if start and start <= len(msgs) and (msgs[start - 1] or {}).get("type") == "gemini":
        start -= 1
    for m in msgs[start:]:
        if not isinstance(m, dict):
            continue
        t, ts, mid = m.get("type"), m.get("timestamp") or "", m.get("id") or ""
        if t == "user":
            if is_tool_echo(m):
                continue
            txt = user_text(m)
            if not txt.strip() and has_image(m.get("content")):
                txt = _t("[image]", "[图片]")
            if txt.strip():
                tl.add(ts, "user", [{"type": "text", "text": txt[:D.LONG_TEXT]}])
            continue
        if t in ("info", "error", "warning"):
            txt = text_of(m.get("content")).strip()
            if txt:
                tl.add(ts, "user", [{"type": "text", "text": (_t("Error: ", "出错：") if t == "error" else "") + txt[:600]}], synthetic=True)
            continue
        if t != "gemini":
            continue
        blocks = []
        leaked, txt = reply(m)
        think = "\n\n".join(x for x in (thoughts_text(m), leaked) if x)
        if think:
            blocks.append({**D._thinking_block(think), "id": mid + ":thinking"})
        if txt.strip():
            blocks.append({"type": "text", "text": txt[:D.LONG_TEXT], "id": mid + ":text"})
        for tc in tool_calls(m):
            name, inp = tc.get("name") or "", tool_args(tc)
            blocks.append(tl.tool(ts, tc.get("id"), name, inp, D._tool_summary(inp)))
            D._tool_file_change(name, inp, ts, tl.files)
            status = tool_status(tc)
            if status != "running":
                tl.resolve(tc.get("id"), tool_result(tc), status == "error", tc.get("timestamp") or ts)
        if blocks:
            tl.add(ts, "assistant", blocks, mid=mid)
    try:
        live = time.time() - os.stat(path).st_mtime < D.RUNNING_GRACE
    except OSError:
        live = False
    return D._finish_detail(ref, tl, limit, since, len(msgs), live=live)


def live(table):
    """Gemini CLI has no hooks Dispatch installs, so presence comes from the process and the file:
    each running gemini is working on the newest conversation of its directory. Working while a
    shell runs below it or the file shows the turn still open (live_state, the rule
    the Sessions page uses too); idle otherwise. A conversation idle for more than 30 min (a gemini
    just opened, or left alone) is only named as a guess on an idle row for the process. Where a process's directory
    cannot be read (Windows), every conversation written in the last 30 minutes counts."""
    import dispatch as D
    found = pids(table)
    if not found:
        return []
    now = time.time()
    chats = {}  # realpath of the project -> [(mtime, path, conversation)] newest first
    for path in chat_files(D.HOME):
        try:
            mtime = os.stat(path).st_mtime
        except OSError:
            continue
        root = project_root(path, D.HOME)
        chats.setdefault(os.path.realpath(root) if root else "", []).append((mtime, path, root))
    for rows in chats.values():
        rows.sort(reverse=True)

    def newest_main(rows, recent_only):
        for mtime, path, root in rows:
            if recent_only and now - mtime > 30 * 60:
                break
            d = load(path)
            if d and (d.get("kind") or "main") == "main" and d.get("sessionId"):
                return mtime, d, root
        return None

    def row(pid, sid, cwd, d, last, state):
        kind, app = D.host_of(pid, table)
        started = D.local_dt((d or {}).get("startTime") or "")
        return {"agent": "gemini", "session_id": sid, "cwd": cwd, "project": os.path.basename(cwd.rstrip("/\\")), "agent_pid": pid, "source_kind": kind, "source_app": app, "entrypoint": "cli", "started_at": started.timestamp() if started else last, "last_at": last, "state": state, "prompts": 0, "alive": True, "registered": True, "title": (d or {}).get("summary") or ""}

    out, seen = [], set()
    blind = []
    for pid in found:
        cwd = D.pid_cwd(pid)
        if not cwd:
            blind.append(pid)
            continue
        hit = newest_main(chats.get(os.path.realpath(cwd), []), recent_only=False)
        state = live_state(hit[1], hit[0], now, running_shell(pid, table)) if hit else "idle"
        if hit and (now - hit[0] <= 30 * 60 or state == "working"):
            mtime, d, root = hit
            if d["sessionId"] in seen:
                continue
            seen.add(d["sessionId"])
            out.append(row(pid, d["sessionId"], root or cwd, d, mtime, state))
        else:
            r = row(pid, f"pid-{pid}", cwd, None, hit[0] if hit else 0, "idle")
            if hit:
                r["probable_session_id"] = hit[1]["sessionId"]; r["title"] = hit[1].get("summary") or ""
            out.append(r)
    if blind:
        for rows in chats.values():
            for mtime, path, root in rows:
                if now - mtime > 30 * 60:
                    break
                d = load(path)
                if not d or (d.get("kind") or "main") != "main" or not d.get("sessionId") or d["sessionId"] in seen:
                    continue
                seen.add(d["sessionId"])
                out.append(row(blind[0], d["sessionId"], root, d, mtime, live_state(d, mtime, now, any(running_shell(p, table) for p in blind))))
    return out


def pids(table):
    """Running Gemini CLI processes (see find_pids)."""
    import dispatch as D
    return find_pids(table, D.P.process_cmdlines)


def _settings(path):
    """Its settings.json, {} when missing; a file that does not parse is refused (writing it would lose it)."""
    import mcp_config as M
    text = M._read(path)
    data = json.loads(text) if text else {}
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a settings object")
    return data

# ---------------------------------------------------------------- its sign-in, from its settings (Qwen Code keeps the same file)
def settings_sign_in(home, env, folder, google_text, key_env):
    try:
        with open(os.path.join(home, folder, "settings.json"), encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        cfg = {}
    cfg = cfg if isinstance(cfg, dict) else {}
    kind = ((cfg.get("security") or {}).get("auth") or {}).get("selectedType") or cfg.get("selectedAuthType") or ""
    if kind == "oauth-personal" or (not kind and os.path.exists(os.path.join(home, folder, "oauth_creds.json"))):
        return google_text
    if kind == "vertex-ai":
        return "Using Google Cloud"
    if kind or env.get(key_env):
        return "Using an API key"
    return "Not signed in"


# ---------------------------------------------------------------- its conversation files
REFERENCED = "--- Content from referenced files ---"  # what follows is the @file's content, not the person's words


def gemini_home(home):
    return os.path.join(os.environ.get("GEMINI_CLI_HOME") or home, ".gemini")


def chat_files(home):
    """Every recorded conversation file, newest first is up to the caller."""
    return glob.glob(os.path.join(gemini_home(home), "tmp", "*", "chats", "session-*.json"))


def project_root(path, home):
    """The directory a chat file's conversation ran in, or '' when Gemini did not record it."""
    folder = os.path.dirname(os.path.dirname(path))
    slug = os.path.basename(folder)
    for marker in (os.path.join(folder, ".project_root"), os.path.join(gemini_home(home), "history", slug, ".project_root")):
        try:
            with open(marker, encoding="utf-8") as f:
                root = f.read().strip()
            if root:
                return root
        except OSError:
            pass
    try:
        with open(os.path.join(gemini_home(home), "projects.json"), encoding="utf-8") as f:
            projects = json.load(f).get("projects") or {}
        for root, s in projects.items():
            if s == slug:
                return root
    except (OSError, ValueError, AttributeError):
        pass
    return ""


def load(path):
    """The parsed conversation, or None while it is being rewritten / unreadable."""
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) and isinstance(d.get("messages"), list) else None


def text_of(content):
    """Readable text of a message's content: a plain string, or parts with text (inline files and
    pictures dropped; the contents of @-referenced files are cut off)."""
    if isinstance(content, str):
        return content
    out = []
    for part in content if isinstance(content, list) else []:
        if not isinstance(part, dict):
            continue
        t = part.get("text")
        if not isinstance(t, str):
            continue
        if t.strip() == REFERENCED:
            break
        out.append(t)
    return "".join(out)


def user_text(m):
    """What the person typed: displayContent when Gemini kept it, else the content."""
    dc = m.get("displayContent")
    txt = text_of(dc) if dc else ""
    return txt or text_of(m.get("content"))


def is_tool_echo(m):
    """A user-role record that only carries tool responses (a picture read_file returned): part of
    the model's turn, not something the person said."""
    c = m.get("content")
    return isinstance(c, list) and any(isinstance(p, dict) and "functionResponse" in p for p in c)


THOUGHT_MARK = "[Thought: true]"


def reply(m):
    """(leaked thinking, answer) of a model reply. Some Gemini models print their thought summary
    into the answer, ending it with "[Thought: true]"."""
    txt = text_of(m.get("content"))
    if THOUGHT_MARK in txt:
        head, _, tail = txt.rpartition(THOUGHT_MARK)
        return head.strip(), tail.lstrip()
    return "", txt


def has_image(content):
    return isinstance(content, list) and any(isinstance(p, dict) and isinstance(p.get("inlineData"), dict) and str(p["inlineData"].get("mimeType", "")).startswith("image/") for p in content)


def thoughts_text(m):
    parts = []
    for t in m.get("thoughts") or []:
        if not isinstance(t, dict):
            continue
        subject, desc = (t.get("subject") or "").strip(), (t.get("description") or "").strip()
        parts.append(f"**{subject}**\n{desc}" if subject and desc else subject or desc)
    return "\n\n".join(p for p in parts if p)


def tool_calls(m):
    return [tc for tc in m.get("toolCalls") or [] if isinstance(tc, dict)]


def tool_args(tc):
    a = tc.get("args")
    return a if isinstance(a, dict) else {}


def tool_status(tc):
    """done / error / running, in Dispatch's vocabulary."""
    s = (tc.get("status") or "").lower()
    if s in ("success", "completed", "done"):
        return "done"
    if s in ("error", "cancelled", "canceled"):
        return "error"
    return "running"


def tool_result(tc):
    """What a tool call returned: the model-facing output, else what the CLI displayed."""
    results = tc.get("result") if isinstance(tc.get("result"), list) else []
    for r in results:
        fr = r.get("functionResponse") if isinstance(r, dict) else None
        resp = fr.get("response") if isinstance(fr, dict) else None
        if isinstance(resp, dict):
            v = resp.get("output", resp.get("error"))
            if v is not None:
                return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    rd = tc.get("resultDisplay")
    if isinstance(rd, str):
        return rd
    if isinstance(rd, dict):
        return rd.get("fileDiff") or json.dumps(rd, ensure_ascii=False)
    return ""


def tokens(m):
    """(input without cache, output, cache read, thinking) of one reply; Gemini counts the cached
    part inside `input`."""
    tk = m.get("tokens") if isinstance(m.get("tokens"), dict) else {}
    cached = int(tk.get("cached") or 0)
    return max(0, int(tk.get("input") or 0) - cached), int(tk.get("output") or 0), cached, int(tk.get("thoughts") or 0)


# ---------------------------------------------------------------- where a turn stands

# Gemini CLI 0.36 writes the model's message (its text, empty when it only calls tools) as soon as
# the stream ends, and attaches `toolCalls` to it only when those calls have finished
# (GeminiChat.recordCompletedToolCalls). So while a tool runs, or waits for your approval, the file
# ends on a model message without tool calls, exactly like a finished answer. A text-free one is
# always a pending call (an answer without text is an error in 0.36); one with text is a finished
# answer only when no tool is running for that project (see `processes`) and it has had a moment
# to be followed by its tool calls.
SETTLE = 5  # s a trailing answer must sit unchanged before it counts as the end of the turn


def turn_tail(d):
    """Where the conversation's last turn stands, from the file alone:
    'user'    the person (or a tool result) spoke last: the model is working;
    'running' a recorded tool call has not finished;
    'next'    tool calls finished, the model is on its next step;
    'tool'    a model message without text and without tool calls: a tool call is pending;
    'reply'   a model message with text and no tool calls: the answer, or a tool call not yet recorded;
    None      the turn ended (an error, a cancellation) or nothing was said yet."""
    for m in reversed(d.get("messages") or []):
        if not isinstance(m, dict):
            continue
        t = m.get("type")
        if t == "user":
            return "user"
        if t == "gemini":
            calls = tool_calls(m)
            if any(tool_status(tc) == "running" for tc in calls):
                return "running"
            if calls:
                return "next"
            return "reply" if reply(m)[1].strip() else "tool"
        if t == "error" or (t == "info" and text_of(m.get("content")).strip().startswith("Request cancelled")):
            return None
        # other notices (warnings, info lines) do not end a turn
    return None


SHELLS = ("bash", "powershell", "pwsh")  # what run_shell_command starts (getShellConfiguration)


def exe(comm):
    base = comm.replace("\\", "/").rsplit("/", 1)[-1].lower()
    return base[:-4] if base.endswith(".exe") else base


def find_pids(table, cmdlines):
    """Running Gemini CLI processes in a {pid: (ppid, comm)} table. It is a node script (`gemini` →
    .../@google/gemini-cli/…), so the process is called node: the command line (`cmdlines()`, only
    asked when needed) says which one it is."""
    direct = [pid for pid, (_, comm) in table.items() if exe(comm) == "gemini"]
    if direct or not any(exe(comm) == "node" for _, comm in table.values()):
        return direct
    out = []
    for pid, cl in cmdlines().items():
        if pid not in table:
            continue
        # node [flags] <script> …: the script is gemini (the npm bin link) or inside the package.
        script = next((t for t in cl.replace("\\", "/").split()[1:] if not t.startswith("-")), "")
        if "/@google/gemini-cli/" in script or script.rsplit("/", 1)[-1] in ("gemini", "gemini.js"):
            out.append(pid)
    # Gemini relaunches itself as a child node process: keep the outermost one of each pair.
    return [pid for pid in out if table[pid][0] not in out]


def running_shell(pid, table):
    """True while a shell (a run_shell_command call) runs somewhere below the gemini process."""
    children = {}
    for p, (pp, _) in table.items():
        children.setdefault(pp, []).append(p)
    stack, seen = list(children.get(pid, [])), set()
    while stack:
        p = stack.pop()
        if p in seen:
            continue
        seen.add(p)
        if exe(table[p][1]) in SHELLS:
            return True
        stack.extend(children.get(p, []))
    return False


def live_state(d, mtime, now, shell):
    """working / idle of a conversation a running gemini holds, by the same rules the Sessions page
    uses (activity.gemini_settle): a shell below the process, or a turn the file shows open."""
    t = turn_tail(d)
    if shell or t in ("user", "running", "next", "tool"):
        return "working"
    if t == "reply" and now - mtime < SETTLE:
        return "working"
    return "idle"


# ---------------------------------------------------------------- its conversations in the activity list (activity.py)
ACTIVITY_PARSER = 3


def activity_state(d, path, home, mtime):
    """One Gemini CLI conversation file in the row shape activity.observe() produces."""
    import datetime
    import hashlib
    import activity as A
    sid = d.get('sessionId') or ''
    state = {'parser_version': ACTIVITY_PARSER, 'agent': 'gemini', 'session_id': sid, 'cwd': project_root(path, home), 'title': (d.get('summary') or '').strip()[:100],
             'last_at': mtime, 'state': 'idle', 'activity': '', 'events': [], 'version': f'0:{int(mtime * 1000)}', 'entrypoint': 'cli'}
    events = state['events']
    def event(ts, kind, summary, **extra):
        eid = hashlib.sha256((str(ts) + kind + summary).encode()).hexdigest()[:20]
        if not any(e['id'] == eid for e in events):
            events.append(dict(id=eid, ts=ts, kind=kind, text=summary[:400], **extra))
    def epoch(v):
        try: return datetime.datetime.fromisoformat(str(v).replace('Z', '+00:00')).timestamp()
        except ValueError: return 0
    msgs = [m for m in d.get('messages') or [] if isinstance(m, dict)]
    open_tail = turn_tail(d)
    last_reply = msgs[-1] if open_tail == 'reply' else None  # see turn_tail: maybe the answer, maybe a tool call not recorded yet
    for m in msgs:
        ts = epoch(m.get('timestamp') or '') or mtime
        if m.get('type') == 'info':
            if text_of(m.get('content')).strip().startswith('Request cancelled'):
                state['state'], state['activity'] = 'idle', _t('cancelled', '已取消')
            continue
        if m.get('type') == 'user':
            if is_tool_echo(m): continue
            text = A.user_text(user_text(m))
            if not text.strip(): continue
            state['user_at'] = ts
            A.remember_topic(state, text)
            state['state'], state['activity'] = 'working', _t('working on your message', '正在处理你的消息')
            if not state.get('title'): state['title'] = text.strip().split('\n')[0][:100]
            event(ts, 'user', text)
            continue
        if m.get('type') == 'error':
            text = text_of(m.get('content')).strip()
            if text: event(ts, 'error', text)
            state['state'], state['activity'] = 'idle', _t('an error happened', '出错了')
            continue
        if m.get('type') != 'gemini': continue
        calls = tool_calls(m)
        text = reply(m)[1]
        running = False
        for tc in calls:
            name, inp = tc.get('name') or '', tool_args(tc)
            summary = A.operation_summary(name, inp, json.dumps(inp, ensure_ascii=False))
            paths = [x for x in [inp.get('file_path') or inp.get('path') or inp.get('absolute_path')] if x] if any(w in name.lower() for w in ('write', 'edit', 'replace')) else []
            event(ts, 'tool', summary, tool=name, paths=paths)
            status = tool_status(tc)
            if status == 'running':
                running = True
                state['activity'] = f'{name} · {summary[:160]}'
                continue
            failed = status == 'error'
            rts = epoch(tc.get('timestamp') or '') or ts
            event(rts, 'error' if failed else 'result', (_t('failed · ', '失败 · ') if failed else _t('returned · ', '已返回 · ')) + name, paths=paths)
            if not failed:
                for fp in paths: state.setdefault('files', {})[fp] = rts
            state['activity'] = _t('a tool failed', '工具执行失败') if failed else _t(f'ran · {name}', f'已执行 · {name}')
        # A turn is over when the model answered without asking for another tool.
        finished = not calls
        if m is last_reply:
            # Settled at read time (activity_settle): an answer only once no tool runs for it.
            digest = hashlib.sha256(text.encode()).hexdigest()[:20]
            state['pending_reply'] = dict(event=dict(ts=ts, text=text), reply_id=f'{ts}:{digest}', reply_at=ts, reply_digest=digest, reply_preview=text[:280], question=A.question_of(text))
            state['state'], state['activity'] = 'working', _t('replying', '正在回复')
            continue
        if text.strip():
            event(ts, 'reply' if finished else 'message', text)
            if finished:
                digest = hashlib.sha256(text.encode()).hexdigest()[:20]
                if digest != state.get('reply_digest') or state.get('user_at', 0) > state.get('reply_at', 0):
                    state.update(reply_id=f'{ts}:{digest}', reply_at=ts, reply_digest=digest, reply_preview=text[:280], question=A.question_of(text))
            state['activity'] = _t('replied', '已回复') if finished else _t('replying', '正在回复')
        state['state'] = 'idle' if finished else 'working'
        if finished and not text.strip(): state['activity'] = _t('this turn is over', '本轮已结束')
        if running: state['state'] = 'working'
    if open_tail == 'tool':
        state['state'], state['activity'] = 'working', _t('using a tool', '正在调用工具')
    if open_tail in ('tool', 'reply'): state['open_tail'] = open_tail
    state['events'] = events[-80:]
    return state


def activity_settle(s, procs, now=None):
    """Finish a cached Gemini row whose file ends on a model message without tool calls
    (turn_tail): working while a gemini process in its project runs a shell command, or
    for SETTLE s after the write; then an answer ('reply') or, with no gemini left there, an
    ended turn ('tool'). `procs`: {realpath of a gemini process's directory: runs a shell}, or
    None when process directories cannot be read."""
    import hashlib
    tail, pending = s.pop('open_tail', None), s.pop('pending_reply', None)
    if not tail: return s
    now = time.time() if now is None else now
    cwd = s.get('cwd') or ''
    here = procs.get(os.path.realpath(cwd)) if procs is not None and cwd else None
    if here is not None: s['held'] = True  # a gemini runs in its project: a quiet file is not a dead session
    if here:
        s['state'], s['activity'] = 'working', _t('running a command', '正在跑命令')
    elif tail == 'tool':
        if procs is not None and cwd and here is None and now - s['last_at'] >= SETTLE:
            s['state'], s['activity'] = 'idle', _t('this turn is over', '本轮已结束')  # nobody runs it any more
        elif here is False:
            s['activity'] = _t('using a tool, or waiting in the terminal for your confirmation', '正在调用工具，或在终端等你确认')
    elif now - s['last_at'] >= SETTLE and pending:
        e = pending.pop('event')
        eid = hashlib.sha256((str(e['ts']) + 'reply' + e['text']).encode()).hexdigest()[:20]
        s['events'] = (s.get('events') or []) + [dict(id=eid, ts=e['ts'], kind='reply', text=e['text'][:400])]
        s.update(pending)
        s['state'], s['activity'] = 'idle', _t('replied', '已回复')
    return s


def activity_processes(table=None):
    """{realpath of each running gemini's directory: True while it runs a shell command}; None when
    directories cannot be read (Windows)."""
    import dplatform as P
    if P.IS_WIN: return None
    table = P.ps_table() if table is None else table
    out = {}
    for pid in find_pids(table, P.process_cmdlines):
        cwd = P.pid_cwd(pid)
        if cwd: out[os.path.realpath(cwd)] = out.get(os.path.realpath(cwd), False) or running_shell(pid, table)
    return out


def activity_files(home, db, limit=60):
    """Gemini CLI conversations (one JSON file each, rewritten every turn) as (path, row), newest
    first; cached in `streams` by file mtime."""
    files = []
    for path in chat_files(home):
        try: files.append((os.stat(path).st_mtime, path))
        except OSError: pass
    files.sort(reverse=True)
    rows = []
    for mtime, path in files[:limit]:
        version = int(mtime * 1000)
        cached = db.execute('SELECT off,data FROM streams WHERE path=?', (path,)).fetchone()
        if cached and cached[0] == version:
            state = json.loads(cached[1])
            if state.get('parser_version') == ACTIVITY_PARSER:
                if state.get('session_id'): rows.append((path, state))
                continue
        d = load(path)
        if d is None: continue
        if (d.get('kind') or 'main') != 'main' or not d.get('sessionId'):
            state = {'parser_version': ACTIVITY_PARSER, 'agent': 'gemini', 'session_id': ''}  # a sub-agent's run: remembered, not listed
        else:
            state = activity_state(d, path, home, mtime)
        db.execute('INSERT OR REPLACE INTO streams VALUES (?,?,?,?,?)', (path, 0, version, mtime, json.dumps(state, ensure_ascii=False)))
        if state.get('session_id'):
            db.execute('INSERT OR REPLACE INTO stream_sids VALUES (?,?)', (path, state['session_id']))
            rows.append((path, state))
    return rows


ENGINE = Gemini()
