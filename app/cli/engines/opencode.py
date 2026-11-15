# -*- coding: utf-8 -*-
"""OpenCode: `opencode`, free and open source, with the person's own AI services. Its chat runs `opencode acp`
(chat_opencode.py); its providers, keys and allowances are read in opencode_engine.py."""
import json
import os
import re
import shlex
import sys

from engines.base import Engine

# a refused request in its error log (`--print-logs --log-level ERROR`): one `stream error` line each
STREAM_ERROR = re.compile(r'level=ERROR\b.*?error\.error="((?:[^"\\]|\\.)*)"')
# its plugin event -> the turn state (terminal_hook.py)
TURN_EVENTS = {"busy": "working", "idle": "finished", "asks": "needs_you", "error": "stopped"}


class OpenCode(Engine):
    id = "opencode"
    name = "OpenCode"
    provider = "opencode"
    icon = "dispatch-opencode"
    glyph = ("dispatch-icons.ttf", "\ue900")  # Dispatch's icon font has OpenCode
    color = "#3b6fb6"
    commit_trailer = "OpenCode <noreply@opencode.ai>"
    about = "A free, open-source coding assistant. You connect the AI service you already pay for."
    bins = ("opencode",)
    reads_shared_skills = True  # https://opencode.ai/docs/skills/ : Claude Code's and the shared folders too

    config_home = "{home}/.config/opencode"
    rules_file = "{home}/.config/opencode/AGENTS.md"
    hooks_text = "a Dispatch plugin (session brief, task plans, context reminders)"
    servers = "the model's server"

    package = "opencode-ai"
    brew = ("opencode",)
    install_script = "https://opencode.ai/install"
    # OpenCode 1.14.x: `opencode acp` sends no auth header to its own server and every new session dies with 401; 1.18
    # fixed it. Same number as OPENCODE_MIN_VERSION in dispatch-ide patches/225-opencode-version.patch
    # (opencodeVersion.ts): change both together.
    min_version = (1, 18, 0)
    min_version_why = "older OpenCode answers 401"
    stray_runs = ("run",)  # `opencode run` waiting on its provider can sit there for hours (task-adpq)

    def config_problems(self, home, env):
        # a file its config names in Desktop / Documents / Downloads / iCloud Drive can stop it at start
        import opencode_engine as O
        try:
            return O.protected_text(O.protected_refs(env=env, home=home), home=home)
        except Exception:  # noqa: BLE001
            return ""
    self_update_args = ("upgrade",)
    mirror_self_update = True
    # OpenCode also discovers Claude Code's and the shared folders: https://opencode.ai/docs/skills/ . XDG_CONFIG_HOME
    # selects its global config directory.
    skills = ("{config}/opencode/skills", "{home}/.claude/skills", "{home}/.agents/skills")

    # slash commands Dispatch runs in its sessions, and the ones it has only in its own terminal with Dispatch's
    # way to the same thing: (where, go) (slash.py explains the grey rows)
    slash_commands = ("compact", "init", "review")
    terminal_commands = {
        "undo": ("", ""),
        "redo": ("", ""),
        "sessions": ("Your sessions are in Sessions on the left", "sessions"),
        "new": ("Start one with New at the top of Sessions", "new"),
        "models": ("Here it is /model", "alias:model"),
        "share": ("", ""),
        "unshare": ("", ""),
        "themes": ("", ""),
        "editor": ("", ""),
        "export": ("", ""),
        "details": ("", ""),
        "thinking": ("", ""),
        "help": ("", ""),
        "exit": ("", ""),
        "quit": ("", ""),
    }

    database = True

    def sqlite_store(self, home):
        data = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
        return {"db": os.path.join(data, "opencode", "opencode.db"), "proc": "opencode", "app": "OpenCode", "seq": "id", "entrypoint": "cli"}

    def live_sessions(self, table):
        import dispatch as D
        return D.store_live(self.agent, table)

    def resume(self, sid, key=""):
        return ["--session", sid], {}

    terminal_recipe = {"resume": "--continue", "fork": "--continue --fork"}

    # ---------------------------------------------------------------- one run in the background
    def headless_argv(self, model, prompt, cwd, *, images=(), system="", session="", resume=False, lastfile="",
                      effort="", stdin_prompt=False, error_log=False, session_dir="", thinking=""):
        # https://opencode.ai/docs/cli/#run : provider/model, and --variant for effort. Its error log on stderr is the
        # only place a provider's "too many requests" shows up.
        return (["opencode", "run"] + (["--print-logs", "--log-level", "ERROR"] if error_log else [])
                + ["--format", "json", "--auto"]
                + (["--model", model] if model else []) + (["--variant", effort] if effort else [])
                + (["--session", session] if resume and session else [])
                + [x for p in images for x in ("--file", p)]
                + ["--", (system + "\n\n" if system else "") + prompt])

    def steps(self, ev):
        part = ev.get("part") or {}
        if ev.get("type") == "tool_use":
            return [("tool", part.get("tool"), (part.get("state") or {}).get("input"))]
        if ev.get("type") == "text":
            return [("text", part.get("text") or "")]
        return []

    def session_in(self, line):
        m = re.search(r'"sessionID"\s*:\s*"(ses_[A-Za-z0-9]+)"', line)
        return m.group(1) if m else ""

    def final_text(self, stdout, lastfile=""):
        texts = []
        for line in (stdout or "").splitlines():
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "text":
                texts.append((ev.get("part") or {}).get("text") or "")
        return "\n".join(texts) if texts else stdout or ""

    # ---------------------------------------------------------------- one answer, nothing else
    def answer(self, path, system, user, *, model="", timeout=90, cwd=None, env=None,
               no_tools="Do not use any tools and do not read or write files. Answer directly."):
        import shutil
        import subprocess
        import tempfile
        work = tempfile.mkdtemp(prefix="dispatch-answer-")
        try:
            argv = [path, "run", "--pure", "--format", "json", "--title", "Dispatch: writing text"] + (["-m", model] if model else [])
            r = subprocess.run(argv + [f"{system}\n\n{no_tools}\n\n{user}"], capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=timeout, env=env, cwd=cwd or work, stdin=subprocess.DEVNULL)
            parts, session = [], ""
            for line in (r.stdout or "").splitlines():
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                session = session or ev.get("sessionID") or ""
                part = ev.get("part") or {}
                if ev.get("type") == "text" and part.get("text"):
                    parts.append(part["text"])
            if session:  # an answer is not a conversation: leave nothing in OpenCode's history
                subprocess.run([path, "session", "delete", session], capture_output=True, timeout=30, env=env, cwd=cwd or work,
                               stdin=subprocess.DEVNULL)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        text = "".join(parts).strip()
        if not text:
            raise RuntimeError("opencode: " + ((r.stderr or r.stdout or "").strip()[-200:] or f"exit {r.returncode}"))
        return text

    def ai_providers(self, env=None):
        import opencode_engine
        return opencode_engine.providers(env)

    hooks_plugin = True
    # what Dispatch's plugin (agent/opencode/dispatch.js) asks Dispatch's entry (hook.py) for: the brief before a
    # session's first request, a prompt's attribution mark (and the terminal's prompt to the board), the to-do list
    # as the task's plan, a turn's end (attribution, the context lifetime)
    hook_routes = {"SessionStart": ("prime",), "UserPromptSubmit": ("life",), "PostToolUse": ("plan",), "Stop": ("life",)}
    plan_tools = ("todowrite",)

    def hooks_file(self, home):
        import opencode_engine
        return opencode_engine.plugin_path()

    def install_hooks(self, path=None, env=None, trust=None):
        # it loads Dispatch's plugin from its config folder by itself: opencode.json is not touched
        import opencode_engine
        os.makedirs(opencode_engine.paths(env)["config"], exist_ok=True)
        return opencode_engine.install_plugin(env=env)

    def uninstall_hooks(self, path=None, env=None):
        try:
            import opencode_engine
            opencode_engine.uninstall_plugin()
            return True
        except Exception:  # noqa: BLE001
            return False

    # `dispatch` in its shell knows the session, its to-do list is the task's plan
    setup_args = ("engines", "install-plugin", "opencode")
    setup_label = "opencode-plugin"

    def sign_in_status(self, path, env):
        # the providers with a key or a sign-in (auth.json, an environment variable, opencode.json), counted as the
        # account menu counts them; OpenCode Zen's free models need neither (task-eibd9: 2 here, 3 there)
        import opencode_engine
        try:
            n = sum(1 for p in opencode_engine.providers(env=dict(os.environ, **(env or {})))
                    if any(s["kind"] != "free" for s in p["sources"]))
        except Exception:  # noqa: BLE001
            n = 0
        return f"{n} provider{'s' if n != 1 else ''} set up" if n else "No provider set up"

    def plugin_state(self, env=None):
        import opencode_engine as O
        st = O.plugin_state(env)
        return dict(st, config_exists=os.path.isdir(O.paths(env)["config"]), shipped=bool(O.PLUGIN_SOURCE))

    def model_window(self, model, provider=""):
        return model_window(model, provider)

    def api_keys(self):
        out = []
        for name, pid, base, model in API_KEYS:
            key = auth_key(name)
            if key:
                out.append((pid, base, model, key))
        return out

    def provider_error(self, line):
        # it has no allowance reading: what its provider refused, from one line of its error log or JSON output
        m = STREAM_ERROR.search(line)
        if m:
            return m.group(1).replace('\\"', '"')
        if line.startswith("{") and '"error"' in line:
            try:
                ev = json.loads(line)
            except ValueError:
                ev = None
            if isinstance(ev, dict) and ev.get("type") == "error":
                return error_message(ev)
        return ""

    def owns_session_id(self, sid):
        return str(sid or "").startswith("ses_")

    def takes_model(self, model):
        return "/" in (model or "")  # provider/model

    def subagent_folder(self, home, env):
        cfg = env.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
        if not os.path.isdir(os.path.join(cfg, "opencode")):
            return None
        return os.path.join(cfg, "opencode", "agents"), ".md", [os.path.join(cfg, "opencode", "agent")]

    def subagent_text(self, d):
        # OpenCode reads `tools` as a map and `model` as provider/model: the Claude values would not load, so the
        # session's own model and tools are used
        import builtin_agents as B
        return f"---\ndescription: {B.yaml_scalar(d['fm'].get('description', ''))}\nmode: subagent\n---\n\n{d['body']}"

    def terminal_turn_env(self, env):
        # Dispatch's plugin in an inline config, kept with whatever the person had there
        content = config_content(write_terminal_plugin(), env.get("OPENCODE_CONFIG_CONTENT", ""))
        return f"OPENCODE_CONFIG_CONTENT={shlex.quote(content)}"

    def turn_state(self, event, payload):
        import terminal_hook
        state = TURN_EVENTS.get(event)
        if state == "finished":
            return state, terminal_hook.last_line(payload.get("text") or ""), ""
        if state == "needs_you":
            return state, str(payload.get("text") or ""), ""
        if state == "stopped":
            return state, "", str(payload.get("error") or "")
        return state, "", ""

    chat_driver = ("chat_opencode", "OpenCodeAdapter")
    chat_permission_modes = ("bypassPermissions",)  # its own config decides the rest: Dispatch sets only "do it all"

    def native_install(self, real_path):
        return "/.opencode/" in real_path

    def after_install(self):
        # its installer made ~/.opencode, a folder OpenCode installs its plugin kit into from npm: Dispatch's copy instead
        try:
            import opencode_kit
            return {"kit": opencode_kit.seed()}
        except Exception:  # noqa: BLE001 - OpenCode installs the kit itself then
            return {}

    # a project's own settings it reads: Claude Code's CLAUDE.md as well as AGENTS.md
    project_files = (("CLAUDE.md", "instructions"), ("AGENTS.md", "instructions"),
                     (".opencode/plugin", "plugins"), (".opencode/plugins", "plugins"))

    # ---------------------------------------------------------------- MCP servers
    # opencode.json(c) in its config folder "mcp". Per project: <folder>/opencode.json "mcp": {"<name>": {"enabled": false}}
    mcp_signin = "opencode mcp auth {name}"

    def mcp_file(self, home, env):
        import opencode_engine
        return opencode_engine.config_file(env)

    def mcp_rows(self, path, cwd=""):
        return mcp_rows_in(path)

    def mcp_edit(self, path, name, spec):
        return mcp_edit_file(path, name, mcp_entry(spec) if spec else None)

    def mcp_raw(self, path, name):
        import opencode_engine
        return ((opencode_engine.read_json(path, jsonc=True) or {}).get("mcp") or {}).get(name)

    def mcp_spec(self, name, v):
        import mcp_config as M
        cmd = v.get("command") or []
        cmd = cmd if isinstance(cmd, list) else [cmd]
        spec = M.blank_spec()
        spec.update(url=str(v.get("url") or "") if v.get("type") == "remote" else "", command=str(cmd[0]) if cmd else "",
                    args=[str(x) for x in cmd[1:]], env={k: str(x) for k, x in (v.get("environment") or {}).items()},
                    headers={k: str(x) for k, x in (v.get("headers") or {}).items()})
        return spec

    def mcp_project(self, folder, user_path, env):
        import opencode_engine
        here_file = project_file(folder)
        user = ((opencode_engine.read_json(user_path, jsonc=True) or {}).get("mcp") or {}) if os.path.isfile(user_path) else {}
        here_all = ((opencode_engine.read_json(here_file, jsonc=True) or {}).get("mcp") or {}) if os.path.isfile(here_file) else {}
        out = []
        for source, servers in (("everyone", user), ("project", here_all)):
            for name, v in servers.items():
                v = v if isinstance(v, dict) else {}
                if source == "project" and name in user:
                    continue
                here = here_all.get(name) if isinstance(here_all.get(name), dict) else {}
                base = v if source == "everyone" else here
                if not (base.get("command") or base.get("url")):
                    continue
                on = (here.get("enabled") if "enabled" in here else v.get("enabled")) is not False
                cmd = base.get("command") or []
                cmd = cmd if isinstance(cmd, list) else [cmd]
                out.append((name, {"url": base.get("url"), "command": str(cmd[0]) if cmd else "", "args": [str(x) for x in cmd[1:]],
                                   "transport": "http" if base.get("type") == "remote" else "stdio"}, source,
                            {"has": True, "on": on, "state": "on" if on else "off", "where": here_file if "enabled" in here else user_path}))
        return {"servers": out, "files": {self.agent: here_file}}

    def mcp_project_set(self, folder, name, on, state, user_path, listing):
        import mcp_config as M
        import opencode_engine
        path = project_file(folder)
        text = M._read(path)
        if text and opencode_engine.strip_jsonc(text).strip() != text.strip():
            try:
                json.loads(text)
            except ValueError:
                raise ValueError(f"{path} has comments; Dispatch would drop them. Change its \"mcp\" part by hand.")
        data = json.loads(opencode_engine.strip_jsonc(text)) if text else {"$schema": "https://opencode.ai/config.json"}
        servers = data.setdefault("mcp", {})
        entry = servers.get(name) if isinstance(servers.get(name), dict) else {}
        user_has = name in (((opencode_engine.read_json(user_path, jsonc=True) or {}).get("mcp")) or {})
        if on and user_has and set(entry) <= {"enabled"}:
            servers.pop(name, None)
        else:
            entry["enabled"] = bool(on)
            servers[name] = entry
        if not servers:
            data.pop("mcp")
        if set(data) <= {"$schema"} and not text:
            return path, "", ""
        with open(path, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        return path, "", ""


# ---------------------------------------------------------------- MCP servers in opencode.json(c)

def mcp_rows_in(path):
    import mcp_config as M
    import opencode_engine
    data = opencode_engine.read_json(path, jsonc=True) or {}
    rows = []
    for name, v in (data.get("mcp") or {}).items():
        v = v if isinstance(v, dict) else {}
        cmd = v.get("command") or []
        cmd = cmd if isinstance(cmd, list) else [cmd]
        rows.append({"name": name, "engine": "opencode", "scope": "user", "transport": "http" if v.get("type") == "remote" else "stdio",
                     "command": str(cmd[0]) if cmd else "", "args": [str(x) for x in cmd[1:]], "url": str(v.get("url") or ""),
                     "env": M._names(v.get("environment")), "headers": M._names(v.get("headers")),
                     "enabled": v.get("enabled") is not False, "path": path})
    return rows


def mcp_entry(spec):
    if spec["url"]:
        e = {"type": "remote", "url": spec["url"], "enabled": True}
        headers = {**spec["headers"], **{k: spec.get("header_prefix", {}).get(k, "") + "{env:" + v + "}" for k, v in spec.get("header_env", {}).items()}}
        if headers:
            e["headers"] = headers
        return e
    e = {"type": "local", "command": [spec["command"], *spec["args"]], "enabled": True}
    if spec["env"]:
        e["environment"] = spec["env"]
    return e


def mcp_edit_file(path, name, entry):
    import mcp_config as M
    import opencode_engine
    text = M._read(path)
    if text and opencode_engine.strip_jsonc(text).strip() != text.strip():
        try:
            json.loads(text)
        except ValueError:
            raise ValueError(f"{path} has comments; writing it would drop them. Edit its \"mcp\" section by hand.")
    data = json.loads(opencode_engine.strip_jsonc(text)) if text else {"$schema": "https://opencode.ai/config.json"}
    servers = data.setdefault("mcp", {})
    if entry is None:
        if name not in servers:
            return None
        del servers[name]
    else:
        servers[name] = entry
    return M._write(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def project_file(folder):
    for name in ("opencode.json", "opencode.jsonc"):
        p = os.path.join(folder, name)
        if os.path.isfile(p):
            return p
    return os.path.join(folder, "opencode.json")


# ---------------------------------------------------------------- in Dispatch's terminal (terminal_hook.py)
# The plugin OpenCode loads from Dispatch's config folder. It runs this file on the root session's turns only (a
# subagent's child session says nothing), and only on a change: busy once a turn starts, idle once it ended.
TERMINAL_PLUGIN = r"""// Dispatch: tells Dispatch's terminal when OpenCode's turn ends (app/cli/engines/opencode.py writes this file).
// Learned from Orca's OpenCode status plugin (github.com/stablyai/orca, MIT, Copyright (c) 2026 Lovecast Inc.).
import { spawn } from "node:child_process";

const PYTHON = __PYTHON__;
const SCRIPT = __SCRIPT__;

export const DispatchTurns = async () => {
  const parent = new Map();   // session id -> its parent's id ("" for a root session)
  const busy = new Map();     // root session id -> busy now
  const role = new Map();     // message id -> "user" | "assistant"
  const said = new Map();     // root session id -> the assistant's last text
  const tell = (event, payload) => {
    if (!process.env.DISPATCH_TERMINAL_SESSION) return;
    try {
      const child = spawn(PYTHON, [SCRIPT, "opencode", "--terminal", event], { stdio: ["pipe", "ignore", "ignore"], env: process.env, detached: true });
      child.on("error", () => {});
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(payload || {}));
      child.unref();
    } catch {}
  };
  const isChild = id => !!(id && parent.get(id));
  return {
    event: async ({ event }) => {
      const p = (event && event.properties) || {};
      const info = p.info || {};
      if ((event.type === "session.created" || event.type === "session.updated") && info.id) {
        parent.set(info.id, info.parentID || "");
        return;
      }
      if (event.type === "message.updated" && info.id && info.role) {
        role.set(info.id, info.role);
        return;
      }
      if (event.type === "message.part.updated" && p.part && p.part.type === "text" && !isChild(p.part.sessionID)) {
        if (role.get(p.part.messageID) === "assistant" && p.part.text) said.set(p.part.sessionID, p.part.text);
        return;
      }
      const sid = p.sessionID;
      if (!sid || isChild(sid)) return;
      const status = event.type === "session.idle" ? "idle" : event.type === "session.status" ? (p.status && p.status.type) : "";
      if (status === "busy" || status === "retry") {
        if (!busy.get(sid)) { busy.set(sid, true); tell("busy", {}); }
      } else if (status === "idle") {
        if (busy.get(sid)) { busy.set(sid, false); tell("idle", { text: said.get(sid) || "" }); }
      } else if (event.type === "permission.asked" || event.type === "permission.updated" || event.type === "question.asked") {
        tell("asks", { text: p.title || p.question || "OpenCode asks for your permission" });
      } else if (event.type === "session.error") {
        busy.set(sid, false);
        const e = p.error || {};
        tell("error", { error: (e.data && e.data.message) || e.message || e.name || "" });
      }
    },
  };
};
"""

TERMINAL_PLUGIN_FILE = "opencode-turns.js"


def terminal_plugin(python, script):
    return TERMINAL_PLUGIN.replace("__PYTHON__", json.dumps(python)).replace("__SCRIPT__", json.dumps(script))


def _write_if_changed(path, text):
    try:
        with open(path) as f:
            if f.read() == text:
                return
    except Exception:
        pass
    with open(path + ".tmp", "w") as f:
        f.write(text)
    os.replace(path + ".tmp", path)


def write_terminal_plugin(python=None, script=None, base=None):
    """Writes the plugin (when it changed) next to the daemon's files and returns its path. Not a config folder:
    OpenCode installs packages into the folders it reads config from, and this needs none."""
    import terminal_hook
    python = python or sys.executable or "python3"
    script = script or terminal_hook.HOOK_SCRIPT
    d = os.path.join(base or terminal_hook.dispatch_dir(), "termd")
    os.makedirs(d, mode=0o700, exist_ok=True)
    p = os.path.join(d, TERMINAL_PLUGIN_FILE)
    _write_if_changed(p, terminal_plugin(python, script))
    return p


def config_content(plugin, current=""):
    """OPENCODE_CONFIG_CONTENT with the plugin added (an inline config OpenCode reads after the person's own
    folders, which stay as they are); whatever the person already had in it is kept."""
    try:
        cfg = json.loads(current) if current else {}
    except ValueError:
        cfg = {}
    cfg = cfg if isinstance(cfg, dict) else {}
    url = "file://" + plugin
    plugins = [x for x in (cfg.get("plugin") or []) if x != url] if isinstance(cfg.get("plugin"), list) else []
    cfg["plugin"] = plugins + [url]
    return json.dumps(cfg, separators=(",", ":"))



def error_message(ev):
    """The message of an error event of `opencode run --format json`, wherever it nests it."""
    found, stack = [], [ev.get("error") if isinstance(ev, dict) else None]
    while stack:
        x = stack.pop(0)
        if isinstance(x, dict):
            if isinstance(x.get("message"), str) and x["message"].strip():
                found.append(x["message"])
            stack += [v for v in x.values() if isinstance(v, dict)]
        elif isinstance(x, str) and x.strip():
            found.append(x)
    return found[-1] if found else json.dumps(ev.get("error"), ensure_ascii=False) if isinstance(ev, dict) else ""


# ---------------------------------------------------------------- the models it knows, the keys the person gave it
_MODELS = {}


def models_path():
    return os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache"), "opencode", "models.json")


def model_window(model, provider=""):
    """The context window OpenCode knows for a model (its models.dev cache, limit.context), or 0.
    DeepSeek V4.1 Flash and GLM 5.3 Flash are 1M there; without this they fell back to 200K."""
    if not model:
        return 0
    path = models_path()
    try:
        mtime = os.stat(path).st_mtime
    except OSError:
        return 0
    if _MODELS.get("path") != path or _MODELS.get("mtime") != mtime:
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = {}
        _MODELS.update(path=path, mtime=mtime, data=data if isinstance(data, dict) else {})
    data = _MODELS["data"]
    name = model.split("/", 1)[1] if "/" in model and not provider else model
    provider = provider or (model.split("/", 1)[0] if "/" in model else "")
    order = ([provider] if provider in data else []) + [p for p in data if p != provider]
    for prov in order:
        m = ((data.get(prov) or {}).get("models") or {}).get(name)
        if isinstance(m, dict):
            ctx = _number((m.get("limit") or {}).get("context"))
            if ctx:
                return ctx
    return 0


def _number(value):
    return max(0, int(value)) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


AUTH = os.path.join("~", ".local", "share", "opencode", "auth.json")
# its sign-ins that are plain API keys on an OpenAI-style endpoint summarize.py already knows
API_KEYS = (("zhipuai-coding-plan", "zhipu", "https://open.bigmodel.cn/api/coding/paas/v4", "glm-5.3-flash"),)


def auth_key(name):
    try:
        with open(os.path.expanduser(AUTH), encoding="utf-8") as f:
            v = (json.load(f) or {}).get(name) or {}
    except (OSError, ValueError, AttributeError):
        return ""
    return v.get("key") if isinstance(v, dict) and v.get("type") == "api" and isinstance(v.get("key"), str) else ""


ENGINE = OpenCode()
