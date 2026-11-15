# -*- coding: utf-8 -*-
"""One agent engine as Dispatch knows it: the interface every adapter (engines/<id>.py) implements.

Dispatch is a face for the official agent CLIs (Claude Code, Codex, OpenCode, Gemini CLI, pi ...). Everything it
needs to know about one of them sits in that engine's own file: what it is called, how it is installed, how a chat
with it starts and reads, how it runs once in the background, its allowance, its models, its sub-agents, where its
conversations are kept and how one is continued, how it runs in a terminal. The rest of Dispatch asks the registry
(`engines.get(name)`) and never branches on an engine's name.

A capability an engine does not have raises `Unsupported` with one plain sentence the window can show (OpenCode has
no allowance to read, Gemini CLI cannot be driven from the chat). `supports(name)` asks without trying.

An engine Dispatch only recognizes (most of the catalog in engines/catalog.py) is a plain `Engine` built from its
row: a name, its commands and how to install it, nothing else.
"""
import re
from lang import t as _t


class Unsupported(Exception):
    """The engine has no such capability. `str(e)` is one plain sentence for the person."""


class Engine:
    # ---------------------------------------------------------------- who it is
    id = ""              # the catalog id: claude, codex, opencode, gemini, pi ...
    agent = ""           # the prefix of its session keys and transcripts ("claude-code"); "" means the id
    name = ""            # the product's name: Claude Code, Gemini CLI
    maker = ""           # who makes it (Anthropic): "signed out by Anthropic"
    short_name = ""      # the brand word in sentences: Claude, Gemini; "" means the name
    plan_name = ""       # whose allowance a run uses (ChatGPT · Codex); "" means the short name
    aliases = ()         # other words for it (an old id, a binary name)
    provider = ""        # the Agents window's session provider id (claude, codex, copilotcli); "" when it has none
    icon = "terminal"    # codicon of its sessions
    glyph = ("", "")     # (font file, character) of its own mark, drawn outside the workbench (computer.py)
    color = ""           # its colour in charts
    commit_trailer = ""  # its Co-authored-by line; "" means "<short name> <noreply@dispatch.invalid>"
    about = ""           # one plain sentence for the list of agents
    bins = ()            # command names, in the order they are looked for
    env_markers = ()     # variables its process sets for the commands it runs (CLAUDECODE): a command with one is its
    session_env = ()     # the variables that name its current session in the commands it runs, the most specific first
    env_prefix = ""      # the prefix all its variables share (CLAUDE): a child started for another engine drops them
    activity_stream = False  # activity.py reads its transcript as a live stream (state, replies, the read cursor)
    reads_shared_skills = False  # it also reads skills from other agents' folders: one mounted there needs no mount here
    process_patterns = ()  # regexes that mark its process in a command line, besides its command names and package
    install_hint = ""    # what a person would type to install it (the catalog's line)
    url = ""             # its home page
    # a short or common command name: the file only counts as the agent when these hold (agents_catalog.find)
    real_match = ""
    reject_real = ""
    reject_output = ""
    verify = False

    # ---------------------------------------------------------------- where it keeps its things
    config_home = ""     # its own folder ("{home}/.claude"); "" when Dispatch does not know one
    config_home_env = ""  # the variable that moves that folder (HERMES_HOME)
    rules_file = ""      # where it reads machine-wide instructions ("{home}/.codex/AGENTS.md"); "" for none
    rules_import = False  # it can @import a file (Claude Code); the others get the rules inlined in the block
    hooks_text = ""      # what Dispatch adds to it besides the rules, in a few words for first-run setup
    hooks_note = ""      # one more plain sentence about that, when it needs one
    service = ""         # the maker's server it needs (a key of net.TARGETS: anthropic, openai); "" when it takes any
    servers = "the server"  # whose servers a dropped connection was to, for the retry notice
    discuss_persona = ""  # its one-line character as a discussion member (the default of discuss_persona_<id>)

    # ---------------------------------------------------------------- Dispatch's hook in it: one entry for every event
    # Dispatch puts exactly one hook into an engine, its entry (hook.py), on each event in hook_routes; the entry
    # runs the features listed there. Installing, removing and bringing it up to date is hooks_setup.py.
    hooks_json = False      # the entry goes into a JSON settings file of its own (hooks_file), checked and repaired
    hooks_plugin = False    # the entry is a plugin it loads (plugin_state says whether it is in place)
    hook_routes = {}        # its hook event -> the features of the entry that answer it, in order (hook.py)
    hook_options = {}       # event -> more fields of the group the entry sits in (matcher, timeout ...)
    hook_trust = False      # it runs a hook only once the person trusted it (Codex): installing trusts the entry there
    presence_tools = ()     # after a tool, presence only for these tools; () = every tool
    edit_tools = ()         # the tools that edit a file (the edit guard)
    plan_tools = ()         # the tool whose input is its to-do list (the plan)
    life_hooks = ()         # its hook events the context lifetime follows (handoff.py, life_hook.py)
    hook_children = False   # its hook events of a sub-agent carry agent_id (and a transcript of their own)

    def hooks_file(self, home):
        """Where Dispatch's entry goes in it (a settings file or the plugin), '' when nowhere."""
        return ""

    def install_hooks(self, path=None, env=None, trust=None):
        """Put Dispatch's entry in, or bring it up to date: older Dispatch hooks are taken out, the person's own stay
        as they are (into `path` instead of its own file when given: `dispatch doctor` and Customizations compare
        with a scratch copy). `trust` (hook_trust): have it trust the entry; None = when it is its own file.
        {path, changed, ..., skipped?: why not}."""
        if not self.hooks_json:
            raise Unsupported(f"Dispatch has no hooks for {self.name}.")
        import hooks_setup
        return hooks_setup.install(self, path or self.hooks_file(hooks_setup.home()), env=env, trust=trust)

    def uninstall_hooks(self, path=None, env=None):
        """Take Dispatch's entry (and any older Dispatch hook) out again; False when there was nothing to take out."""
        if not self.hooks_json:
            return False
        import hooks_setup
        return hooks_setup.uninstall(self, path or self.hooks_file(hooks_setup.home()))

    def hooks_state(self, path=None, env=None, deep=False):
        """{path, installed, current, old, trusted} of Dispatch's entry in it now (`deep`: also ask whether it runs
        it, for an engine that needs to trust it); None when it has none."""
        if not self.hooks_json:
            return None
        import hooks_setup
        return hooks_setup.state(self, path or self.hooks_file(hooks_setup.home()), env=env, deep=deep)

    # an engine that runs a hook only once it is trusted (hook_trust) answers these three
    def hook_listing(self, path, env=None):
        """Its own list of the hooks in `path` with their trust ([{key, event, command, hash, trust, enabled}]), so
        trust the person gave can follow their hook to a new place; None when it cannot be asked."""
        return None

    def trust_hook(self, path, command, before=None, env=None):
        """Have it trust Dispatch's entry (exactly `command`) in `path`, and keep the trust of the person's hooks the
        change moved (`before`: hook_listing from before). {ok, trusted, kept, why}."""
        return {"ok": True, "why": "it runs every hook"}

    def hook_trusted(self, path, command, env=None):
        """Whether it runs Dispatch's entry in `path` now; None when it cannot be asked."""
        return True

    def plugin_state(self, env=None):
        """{path, installed, current, config_exists, shipped} of Dispatch's plugin in it (hooks_plugin)."""
        raise Unsupported(f"Dispatch has no plugin for {self.name}.")

    # ---------------------------------------------------------------- MCP servers (mcp_config.py)
    mcp_in_home = False  # its MCP file sits right in the home folder: listed and written even before it was set up
    mcp_signin = ""      # how it signs in to a hosted server the first time ({name}: the server's name)

    def mcp_file(self, home, env):
        """The file it keeps its own MCP servers in (under `home`, its env variables read from `env`)."""
        raise Unsupported(f"Dispatch cannot read {self.name}'s MCP servers.")

    def mcp_rows(self, path, cwd=""):
        """Its servers in mcp_config's row format (user scope; with `cwd`, that folder's own ones too)."""
        raise Unsupported(f"Dispatch cannot read {self.name}'s MCP servers.")

    def mcp_edit(self, path, name, spec):
        """Write server `name` from an mcp_config spec into its file (spec None removes it), in its own format and
        leaving the rest as it was. The backup path ('' when there was no file), None when nothing changed."""
        raise Unsupported(f"Dispatch cannot change {self.name}'s MCP servers.")

    def mcp_raw(self, path, name):
        """Server `name` as its file has it, secrets included (never printed)."""
        return None

    def mcp_spec(self, name, raw):
        """An mcp_config spec (mcp_config.blank_spec) from mcp_raw, to copy the server to another engine."""
        raise Unsupported(f"Dispatch cannot copy {self.name}'s MCP servers.")

    def mcp_current(self, path, name, spec):
        """Whether server `name` in its file already has what `spec` asks of it beyond the command (the variables it
        passes on, running its tools without asking): Dispatch's own server is rewritten when not."""
        return True

    def mcp_allow_file(self, home):
        """The file mcp_allow writes, '' when it has none."""
        return ""

    def mcp_allow(self, name, home=None):
        """Let its sessions use server `name`'s tools without asking each time (Dispatch's own server, whose tools
        only touch Dispatch's records). The file it changed, or None when it needs nothing (or already had it)."""
        return None

    def mcp_project(self, folder, user_path, env):
        """Which servers its agents get in one project folder: {"servers": [(name, row, origin "everyone" |
        "project", {has, on, state "on" | "off" | "ask", where})], "files": {key: path}, "extra": {...}}."""
        return {"servers": [], "files": {}}

    def mcp_project_set(self, folder, name, on, state, user_path, listing):
        """Turn one server on or off for its agents in one project folder, in its own per-project place:
        (path, backup, note). `state` is the server's row for it in `listing` (mcp_config.project_tools)."""
        raise Unsupported(f"Dispatch cannot switch {self.name}'s MCP servers per project.")

    # ---------------------------------------------------------------- where a session the Agents window shows was started
    def entrypoint_files(self, sid, cwd):
        """Its transcript files for session `sid`, read for where it was started before the index has it (ide_sessions)."""
        return []

    def entrypoint_in(self, record):
        """Where the session was started (cli, exec, desktop…) when this transcript record says so; None: read on."""
        return str(record["entrypoint"]) if record.get("entrypoint") else None

    # ---------------------------------------------------------------- moving a conversation to another Mac (move.py)
    move_trust_script = ""  # a Python script run over there that marks a folder trusted the way its own dialog does
    #                         (argv: folder, "1" to write / "0" to only look; prints already / set / needed)

    def move_target(self, path, remote_home, remote_cwd):
        """(where its transcript goes on the other Mac, whether its text needs the home path rewritten): a conversation
        of it can move and be resumed over there."""
        raise Unsupported(f"{self.name}'s conversations cannot move to another Mac yet.")


    def move_prepare(self, h, cwd, remote_home, remote_cwd, dry=False):
        """What it needs over there before the conversation resumes (host `h`): {plan key: result}."""
        return {}

    # ---------------------------------------------------------------- a project's own settings it reads (agent_files.py)
    project_files = ()  # (path in the project, "instructions" | "rules" (a folder of .md) | "hooks" | "plugins" (a folder))

    def project_notes(self, folder, own):
        """[{id, text}]: what the project's own settings files of it (`own`: the rows agent_files found) change for
        Dispatch, said as a consequence."""
        return []

    def user_notes(self, home, dispatch):
        """The same for the person's own settings of it (`dispatch`: the rows of what Dispatch added for them)."""
        return []

    # ---------------------------------------------------------------- the instruction files it reads (instructions.py audit)
    instructions_url = ""       # its documentation on instruction files
    instructions_model_re = ""  # the models it runs (a regex on the model name): the audit then gives its own advice
    instructions_note = ""      # that advice, one line

    def instruction_files(self, home, project=None, env=None):
        """[(path, active)] of the instruction files it reads: machine-wide, and with `project` that folder's own.
        `active` False: present but shadowed (Codex's AGENTS.md next to a non-empty AGENTS.override.md)."""
        from pathlib import Path
        return [(Path(self.rules_file.format(home=str(home))), True)] if self.rules_file else []

    def instruction_model(self, home, env=None):
        """{agent, model, source[, limit]}: the model its settings pick and its budget for instruction text, or None."""
        return None

    def instruction_findings(self, doc, models):
        """[(message, suggestion)] about one instruction file it reads (too long for it, over its budget)."""
        return []

    # ---------------------------------------------------------------- its own long-term memory (memories.py)
    memory_one_file = False  # its memories are one file of many entries (memory_rows splits it): nothing to archive one by one

    def memory_files(self, home):
        """A glob of its memory files (or the one file, memory_one_file), '' when it keeps no memory of its own."""
        return ""

    def memory_where(self, path, ctx):
        """(project, project_dir, expired) of one memory file: the project folder it belongs to and whether that is
        gone. `ctx` (memories.Context) has the project names, workspace roots and a cache for lookups."""
        return _t("General", "通用"), "", False

    def memory_rows(self, path, ctx):
        """The entries of its one memory file (memory_one_file), in the memories page's row format."""
        return []

    setup_args = ()   # the `dispatch …` arguments first-run setup runs to put Dispatch's plugin into it, when it has one
    setup_label = ""  # how that step is named in the setup result

    slash_skills = False  # its skills and the command files in <folder>/commands are slash commands in a session
    slash_folder = ""    # that folder in a project or the home folder ("{home}/.claude")

    signin_files = ()  # files under home (a/b/c) whose presence means it is signed in, for sign_in_local

    def sign_in_local(self, home, env):
        """One phrase about its sign-in from the files it keeps locally (it is not run; never an email, a login or a
        key), '' when unknown: the agents list (agents_catalog.py)."""
        import os
        if self.signin_files:
            found = any(os.path.exists(os.path.join(home, *f.split("/"))) for f in self.signin_files)
            return "Signed in" if found else "Not signed in"
        return ""

    def sign_in_status(self, path, env):
        """One phrase about its sign-in for the first screen (never an email or a key), '' when it cannot tell."""
        return ""

    # ---------------------------------------------------------------- installing and updating it
    package = ""         # npm package; an engine with one shows up in `dispatch engines` and can be installed
    brew = ()            # Homebrew arguments after `brew install`
    install_script = ""  # its own installer (`curl … | bash`), preferred where there is curl
    min_version = None   # the oldest version Dispatch can drive, as a tuple
    min_version_why = ""  # what goes wrong with an older one, in a few words
    chat_min_version = None  # the oldest version its chat driver was verified against ("" means min_version)
    stray_runs = ()      # the arguments of its one-shot runs (`opencode run`): one nobody collects is a hang

    def config_problems(self, home, env):
        """A plain sentence when its own config stands in the way of starting it, else ''."""
        return ""

    self_update_args = ()  # its own updater (`claude update`), used for a copy its own installer put there
    mirror_self_update = False  # its own updater downloads from GitHub: from the mirrors in China use npm instead
    login_args = None    # the arguments that open its sign-in page; None when Dispatch cannot sign it in
    no_installer_message = ""  # what to say when this Mac has no way to install it
    skills = ("{home}/.agents/skills",)  # where it looks for skills; the first is where Dispatch mounts them

    # ---------------------------------------------------------------- in a terminal (terminal_agents.py)
    # After Orca's agent catalog (launchCmd) and resume table (getAgentResumeArgv); MIT, notice in engines/catalog.py.
    terminal_args = ""   # what follows its command to open its terminal interface ("chat --tui")
    # how it goes on after Dispatch's terminal restarts and how a copy of its conversation starts: {start, resume,
    # fork}, each the arguments after its command; {session} is the id Dispatch gives it at start, {new} a fresh one
    terminal_recipe = {}

    def terminal_turn_env(self, env):
        """`VAR=value` put in front of its command so its turns reach Dispatch's terminal (terminal_hook.py); ''."""
        return ""

    def terminal_turn_args(self, env):
        """Arguments after its command that make it tell Dispatch its turn ended (terminal_hook.py); ''."""
        return ""

    def terminal_permission_args(self, mode):
        """Arguments after its command that start it in the permission mode (chat_protocol.PERMISSION_MODES) the
        person chose for new sessions (autonomy.chat_mode), the way its chat sessions start; '' = its own default."""
        return ""

    def turn_state(self, event, payload):
        """(state, text, why) for one of its own end-of-turn signals in the terminal (working, finished, needs_you,
        stopped), or (None, '', '') when the signal is neither a turn starting nor ending."""
        return None, "", ""

    # ---------------------------------------------------------------- its conversations (the index, History, Continue)
    desktop_app = ""     # the app its conversations live in when it has no command to continue one (ZCode)
    hook_presence = False  # its sessions say where they are through Dispatch's hooks; its process without a hook record is
                           # still listed (another person's terminal, hooks not installed) so it can be adopted

    def sqlite_store(self, home):
        """{db, proc, app, seq, entrypoint} when it keeps its conversations in OpenCode's SQLite tables (session,
        message, part): the file, its process name, the app's name, the column that orders parts, where its
        conversations come from. Unsupported for any other store."""
        raise Unsupported(f"{self.name} does not keep OpenCode's tables.")

    def live_sessions(self, table):
        """Its conversations that run now, for an engine with no hooks to say so (presence rows); [] for the others.
        `table`: {pid: (ppid, command)}."""
        return []

    # conversations kept as JSON-lines files (Claude Code, Codex, pi): the index reads them a piece at a time
    transcript_by_folder = False  # its transcripts sit in one folder per project (the folder's name stands for it)

    def transcript_root(self, home):
        """The folder its JSON-lines transcripts are under, '' when it keeps none."""
        return ""

    titles_after_turn = False  # it names a conversation itself only after its first turn (Codex): worth a wait

    def own_title(self, path, sid, home):
        """The title it gave conversation `sid` (transcript `path`) itself so far, or ''."""
        return ""

    def own_titles(self, home):
        """{session id: the title it gave the conversation itself} when it keeps them apart (Codex's
        session_index.jsonl); {} for the others."""
        return {}

    def transcript_files(self, home):
        """[(path, folder)] of its transcripts; `folder` names the project folder a path stands for ('' when the path
        does not say), so the index can leave out the ones outside the session root."""
        return []

    def index_session(self, e, path):
        """Fill the index row's session_id (and subagent, parent, entrypoint) from the transcript's file name."""

    def index_head(self, e, buf):
        """The transcript's first piece: what only its head says (Codex's session_meta)."""

    def index_fold(self, e, buf, re_ts):
        """Count one piece of its transcript into the row: messages, tools and the usage stats."""

    def index_cached(self, e, path, unchanged):
        """An index row read before: fix what older index versions kept wrong (one read, then cached)."""

    database = False  # its conversations are rows in a database, kept as <agent>:<id> (OpenCode, ZCode, Hermes)
    user_markers = ()  # bytes that mark a record of what the person typed in its transcript (for a cheap scan)
    lists_subthreads = False  # its helper threads stay in History (Codex: counted under the thread that started them)

    def history_message(self, d):
        """(role "user" | "agent", content) of one transcript record (parsed) a person would read: what was typed or
        what it wrote back (content: a string or its message blocks); None for tool calls, tool output, system
        records."""
        return None

    def typed_skip(self, line):
        """Whether a user record (raw bytes) is not something the person typed, without parsing it."""
        return False

    def attachment_message(self, record):
        """{role, content} of one transcript record whose pictures and files the session page lists as attachments
        (tool results included), None for the others. The default reads the common {type, message} shape."""
        if record.get("type") not in ("user", "assistant", "message"):
            return None
        return record.get("message") or {}

    def index_store(self, idx, seen, rx):
        """Add its conversations to the index when it keeps them in a store of its own (not JSON-lines files, not
        OpenCode's tables): rows keyed by their file or <agent>:<id>, each key added to `seen`."""

    def runs_on_its_own(self, row):
        """Whether an index row is a conversation it ran on a schedule of its own (Hermes' cron), not one a person had."""
        return False

    def activity_sessions(self, home, db):
        """[(key, row)] of its conversations for the activity list when it keeps them in a store of its own (not
        JSON-lines transcripts, not OpenCode's tables): rows in the shape activity.observe() produces, cached in `db`'s
        streams table by the store's own version."""
        raise Unsupported(f"{self.name}'s conversations are read by the generic transcript readers.")

    def detail(self, ref, limit, since=None):
        """The session page of one conversation in a store of its own: the same shape read_session_detail gives.
        Unsupported for the others (the generic readers handle them)."""
        raise Unsupported(f"{self.name} keeps its conversations where the generic readers look.")

    def index_pending(self, idx, seen):
        """For a database of its own schema (Hermes): the rows the index has to read again (each key added to `seen`);
        `index_row` then reads one. [] for the others."""
        return []

    def index_row(self, idx, row, rx):
        """Read one row `index_pending` gave into the index (keyed <agent>:<id>)."""

    def subagents(self, path):
        """[{agent_id, type, description, tool_use_id, depth, size, last_at, path, running?}] of the conversation kept at
        `path`; [] when it has none Dispatch can see."""
        return []

    def child_counts(self):
        """{session id: how many child sessions} from a store of its own; {} for the others."""
        return {}

    def transcript_parent(self, path):
        """The conversation a helper thread was started from, read from its transcript ('' for a conversation)."""
        return ""

    def transcript_of(self, sid, home, cwd=""):
        """Where its conversation `sid` is kept: [transcript paths], or None to look it up in the index."""
        return None

    def side_folder(self, path, sid):
        """The folder next to a transcript that belongs to that conversation (its sub-agents' transcripts, big tool
        results): it moves and goes to the Trash with it. '' when it keeps none."""
        return ""

    def folder_transcripts(self, home, folder):
        """[(mtime, session id, path)] of its conversations that work in `folder`, from its own files."""
        return []

    def detail_record(self, d, cx):
        """Read one JSON-lines transcript record (parsed) into the session page: `cx` is dispatch._DetailContext (the
        timeline `tl`, the session's `ref`, `assistant(ts, mid, blocks)` to add to the reply being assembled,
        `other(message)` after anything else, `state` for what a reader keeps between records)."""

    def life_skips(self, row, subagent):
        """Whether a transcript record is not this conversation's own context (a sub-agent's, in the parent's file)."""
        return False

    def life_feed(self, meter, row, ordinal):
        """Count one transcript record (parsed) into the context lifetime meter (session_life.Meter)."""

    def owns_session_id(self, sid):
        """Whether `sid` has the shape of its own session ids (OpenCode's ses_…): a hook that names another engine
        with such an id is this engine replaying that engine's hooks."""
        return False

    def first_prompt(self, d):
        """The person's words in one transcript record (parsed), or None when it is not a message of theirs."""
        return None

    def resume(self, sid, key=""):
        """(arguments after its command, environment) that continue conversation `sid`; `key` is where it is kept (a
        transcript path or <agent>:<id>). Unsupported when it cannot be continued outside its own app."""
        raise Unsupported(f"Dispatch does not know how to continue {self.name} sessions yet.")

    # ---------------------------------------------------------------- one run in the background (Turbo, workers, discussions)
    headless_lastfile = False      # it writes its last answer to a file (`-o`): callers give it one
    headless_stdin_prompt = False  # it can read the prompt on stdin (Windows' command line is short)
    headless_reads_pictures = False  # it opens pictures itself (Claude Code's Read): their paths go in the prompt,
                                     # not along with the run
    discuss_thinking = ""  # how hard it thinks in a discussion turn, for an engine that takes a level (pi's --thinking)
    headless_session_dir = False   # it keeps a discussion's sessions in a folder its caller names (pi's --session-dir)

    def headless_new_session(self):
        """The session id to give a new run, when it takes one from its caller (Claude Code's --session-id); '' when it
        names its own sessions."""
        return ""

    def headless_argv(self, model, prompt, cwd, *, images=(), system="", session="", resume=False, lastfile="",
                      effort="", stdin_prompt=False, error_log=False, session_dir="", thinking=""):
        """The command line of one run that does the work without asking (no shell involved; the caller owns stdio and
        lifetime). `session`: resume it (`resume`) or start a new one under that id; `error_log`: its provider's errors
        on stderr (Turbo listens to them); `session_dir`, `thinking`: where a run keeps its sessions and how hard it
        thinks, for an engine that takes them."""
        raise Unsupported(f"{self.name} cannot run in the background here.")

    def live_events(self, ev):
        """One line of its output (parsed JSON) as the live events a discussion bubble shows, in order:
        ("block_start", kind, name) a thinking or tool block begins, ("block_stop",), ("text_delta", text),
        ("text_reset",), ("thinking_delta", text), ("thinking", whole thought), ("input_delta", partial JSON of a tool's
        input), ("tool", name, input JSON), ("command", shell command), ("message", a whole reply), ("tool_result",)."""
        return []

    def steps(self, ev):
        """One line of its output (parsed JSON) as what it did, in order: ("tool", name, input dict) and ("text", text)."""
        return []

    def record_steps(self, record):
        """The same for one record of its transcript file: [("tool", name, input) | ("text", text)]. An engine without
        it has no transcript file Dispatch tails (the Assistant asks the session's last words instead)."""
        raise Unsupported(f"Dispatch does not read {self.name}'s transcript records.")

    def session_in(self, line):
        """Its own session id when this raw output line names it, else ''."""
        return ""

    def final_text(self, stdout, lastfile=""):
        """The answer of a finished run, from its output (and the file it wrote it to)."""
        return stdout or ""

    def run_result(self, stdout, stderr="", lastfile="", session=""):
        """{text, session, error, usage: {input, cached, output, cost_usd?}} of a finished discussion turn."""
        raise Unsupported(f"{self.name} cannot take part in a discussion here.")

    # ---------------------------------------------------------------- one answer, nothing else (summaries, names, commit lines)
    answer_startup = 60  # seconds its program may take to start, on top of a caller's timeout

    def answer(self, path, system, user, *, model="", timeout=90, cwd=None, env=None,
               no_tools="Do not use any tools and do not read or write files. Answer directly."):
        """One answer from its program at `path`, without tools and without leaving a conversation behind; the answer's
        text ('' when it gave none but exited well). RuntimeError(why) when it failed."""
        raise Unsupported(f"{self.name} cannot write an answer here.")

    def model_window(self, model, provider=""):
        """The context window of `model` when it knows it (Claude's own models; OpenCode's models.dev cache), else 0."""
        return 0

    def api_keys(self):
        """[(provider id in summarize.PROVIDERS, base URL, model, key)]: plain API keys the person gave it that Dispatch
        may use for its own quick model calls (the capture model), never printed."""
        return []

    def answer_models(self, purpose="summary"):
        """[{id, label, note?}] it can answer with on the person's own subscription, for `purpose`: "summary" (summaries
        and names: the cheap ones first) or "code" (Tab completion and ⌘K). Unsupported for an engine whose answers are
        not offered as a model of their own."""
        raise Unsupported(f"{self.name} offers no subscription models here.")

    # ---------------------------------------------------------------- its allowance (`dispatch quota`, Turbo, the title bar)
    accounts_driver = None  # (module, class) of the accounts.Login that keeps several sign-ins of it and switches them
    quota_names_plan = True  # its quota row's "plan" is the plan's name (Claude Code's is the status line's model)

    def own_quota(self):
        """{agent, plan, windows: [{label, kind, used_percent, resets_at}], updated_at, source, note}: what this Mac's own
        sign-in has used. Unsupported when it reports no allowance Dispatch can read (OpenCode: its providers bill)."""
        raise Unsupported(f"{self.name} does not report an allowance Dispatch can read.")

    def ai_providers(self, env=None):
        """[{id, ...}] of the AI services it is connected to, for an engine that takes any (OpenCode)."""
        raise Unsupported(f"{self.name} uses its maker's own service.")

    def provider_error(self, line):
        """For an engine without an allowance reading whose provider Turbo listens to (OpenCode): the message of a
        request its provider refused, from one line of its error log, else ''. Unsupported for the others."""
        raise Unsupported(f"Dispatch does not read {self.name}'s provider errors.")

    def quota_history(self, since):
        """[(at, session % used, weekly % used)] it recorded itself since `since` (charts start before Dispatch read)."""
        return []

    # ---------------------------------------------------------------- effort and model names
    default_effort = ""  # the effort a worker gets when none was asked for ("" leaves it to the engine)

    def effort_name(self, effort):
        """Its own word for an effort level (low, medium, high, xhigh, max)."""
        return effort

    def takes_model(self, model):
        """Whether a model name means something to it (a Claude alias means nothing to Codex)."""
        return True

    # ---------------------------------------------------------------- sub-agents Dispatch defines (builtin_agents.py)
    def subagent_folder(self, home, env):
        """(folder Dispatch writes its agent definitions to, file extension, other folders where a same-named file is
        the person's), or None when it reads none or is not on this Mac."""
        return None

    def subagent_text(self, d):
        """One agent definition ({fm, body, text}, Claude Code's format) in its own format."""
        raise Unsupported(f"{self.name} has no agent definitions.")

    # ---------------------------------------------------------------- its models (`dispatch models`)
    def models(self, refresh=False):
        """[{id, label, latest?, note?, default?}] it can be started with, read from where its maker publishes them; the
        first, id "", is its own default. Unsupported when Dispatch cannot list them (the picker then offers only that)."""
        raise Unsupported(f"Dispatch cannot list {self.name}'s models.")

    # ---------------------------------------------------------------- its chat in the Agents window
    chat_driver = None   # (module, class) of the chat_protocol.Adapter that drives a session; None: no chat
    # how chatd treats its sessions (chatd never asks an engine's name):
    chat_picks_session_id = False  # chatd makes the session id up before the start (Claude Code's --session-id)
    chat_single_writer = False     # its transcript takes one writer: a session a terminal holds is not opened here too
    chat_sleeps_when_idle = False  # an idle process is closed after chat_idle_close_minutes, resumed on the next message
    # after `dispatch accounts use`: "process" closes an idle process so the next message resumes it signed in anew;
    # "daemon" restarts its one shared server (chat_restart_daemon) once none of its turns runs; "" does nothing
    chat_account_restart = ""
    chat_takes_terminal = False  # a conversation running in a terminal can be handed to the in-app chat (session_control)
    # the permission modes (chat_protocol.PERMISSION_MODES) a session of it can open with
    chat_permission_modes = ("default", "acceptEdits", "plan", "bypassPermissions")
    slash_commands = ()  # the slash commands Dispatch runs in its sessions (slash.py)
    terminal_commands = {}  # the ones it has only in its terminal: {name: (where, go)} (slash.py); never mutated
    builtin_commands = ()  # the built-in commands the reply page offers in its sessions: ((name, what it does), ...)

    def __init__(self, **fields):
        for k, v in fields.items():
            if not hasattr(type(self), k) or k.startswith("_"):
                raise TypeError(f"{type(self).__name__} has no field {k!r}")
            setattr(self, k, v)
        self.agent = self.agent or self.id
        self.name = self.name or self.id
        self.short_name = self.short_name or self.name
        self.plan_name = self.plan_name or self.short_name
        self.bins = tuple(self.bins) or ((self.id,) if self.id else ())

    def __repr__(self):
        return f"<engine {self.id}>"

    @property
    def bin(self):
        """The command a person types to start it."""
        return self.bins[0] if self.bins else self.id

    @property
    def accounts(self):
        """Dispatch keeps several sign-ins of it and switches between them (accounts.py)."""
        return bool(self.accounts_driver)

    @property
    def runnable(self):
        """Dispatch can start and drive sessions with it (the session pickers offer it)."""
        return bool(self.chat_driver)

    @property
    def names(self):
        """Every word that means this engine to the registry."""
        return tuple(dict.fromkeys(n for n in (self.id, self.agent, self.provider, *self.aliases) if n))

    def supports(self, capability):
        """True when this engine implements `capability` (a method or field of the interface)."""
        mine = getattr(type(self), capability, None)
        base = getattr(Engine, capability, None)
        if callable(base):
            return mine is not base
        return bool(getattr(self, capability, None))

    def home_dir(self, home=None, env=None):
        """Its own folder on this Mac (whether it exists or not), or ''."""
        import os
        env = os.environ if env is None else env
        if self.config_home_env and env.get(self.config_home_env):
            return env[self.config_home_env]
        return os.path.normpath(self.config_home.format(home=home or os.path.expanduser("~"))) if self.config_home else ""

    def rules_target(self, home=None):
        """{path, mode, home} of its rules file for `dispatch rules`, or None when it reads none."""
        import os
        if not self.rules_file:
            return None
        return {"path": os.path.normpath(self.rules_file.format(home=home or os.path.expanduser("~"))),
                "mode": "import" if self.rules_import else "inline", "home": self.home_dir(home, env={})}

    def is_command(self, base, word):
        """Whether one word of a command line starts this engine: `base` is the word's file name without .js, `word`
        the whole word (a path into its npm package or its own versions folder counts)."""
        if base in self.bins or any(base.startswith(b + "-") for b in self.bins):
            return True
        if self.package and f"/{self.package}/" in word:
            return True
        return any(re.search(p, word) for p in self.process_patterns)

    def chat_class(self):
        """The chat_protocol.Adapter subclass that drives its sessions, imported on first use."""
        if not self.chat_driver:
            raise Unsupported(f"Dispatch cannot start {self.name} sessions in its chat.")
        import importlib
        mod, cls = self.chat_driver
        return getattr(importlib.import_module(mod), cls)

    def chat_probe(self):
        """{available, version, supported, reason} for chatd's `hello`: its driver module's probe(). A missing or broken
        driver answers unsupported with the reason, never raises."""
        try:
            if not self.chat_driver:
                raise Unsupported(f"Dispatch cannot start {self.name} sessions in its chat.")
            import importlib
            return importlib.import_module(self.chat_driver[0]).probe()
        except Exception as e:  # noqa: BLE001
            return {"available": False, "version": "", "supported": False, "reason": str(e)[:200]}

    def chat_owns_process(self, pid, session_id):
        """Whether process `pid` is one chatd started for this session (a dead chatd's orphan to stop); False for an
        engine whose sessions share one server."""
        return False

    def chat_restart_daemon(self):
        """Restart the shared server its sessions talk to (chat_account_restart "daemon")."""
        raise Unsupported(f"{self.name} has no shared server to restart.")

    def catalog_row(self):
        """The row agents_catalog.py detects it by."""
        row = {"id": self.id, "name": self.name, "about": self.about, "bins": self.bins}
        for k in ("real_match", "reject_real", "reject_output", "url"):
            if getattr(self, k):
                row[k] = getattr(self, k)
        if self.install_hint:
            row["install"] = self.install_hint
        if self.verify:
            row["verify"] = True
        if self.runnable:
            row["runnable"] = True
        return row

    # ---------------------------------------------------------------- installing and updating it
    def native_install(self, real_path):
        """Whether the copy at `real_path` came from the engine's own installer (then its own updater updates it)."""
        return False

    def after_install(self):
        """Called after it was installed or updated; returns what to add to the answer ({} for nothing)."""
        return {}
