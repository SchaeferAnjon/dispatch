#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dispatch — the Agent-facing CLI for the global task board.

Everything Dispatch IDE shows, an Agent can ask for here (JSON with --json):

  dispatch sessions                 live Agent sessions (who is running where, busy or waiting)
  dispatch editing                  files each active session changed in the last 30 min, aggregated per file, with conflicts
  dispatch find <task-id>           sessions whose transcript mentions the task, with resume commands
  dispatch commits <task-id>        git commits of a task (id in the commit message, or hash in its close reason)
  dispatch resume <session|task>    print (or --copy) the command that resumes a session
  dispatch skills list|show|enable|disable|open|path|new|import|find   pool (~/.dispatch/skills) + per-agent mounts; new writes the template, import pulls a public GitHub repo, find searches the pool and skills.sh
  dispatch prime [--hook-json]      compact session-start digest: identity, this project's tasks, relevant wiki, who else is in this dir, your quota
  dispatch claim <task> [--force]   claim without stealing: refuses a task another agent is working on
  dispatch wiki add|list|search|show   knowledge base: pits (坑), wins (做对), retros (复盘), howtos (方法)
  dispatch docs <project>           research / review / design documents of a project (design/, docs/, 研究/ + registered ones)
  dispatch docs add|rm|read <project> …   register a path/URL, remove one, or read its markdown
  dispatch wiki search "<句子>" --semantic   find entries by meaning (OpenAI text-embedding-3-small, else 智谱 embedding-3; sqlite-vec), not spelling
  dispatch wiki related <task-id>   the pits that mean the same as this task (task page 右栏)
  dispatch pit add|list|show        = wiki --kind pit
  dispatch insights [--days N] [--alerts] [--ack]   cross-agent signal counts, samples, per-session alerts, an improvement task
  dispatch insights report|list|show|open|schedule|due   the model-written /insights-style report (dated, scheduled, opens as a page)
  dispatch catalog [-q kw]          skills/plugins kept off by default; agents suggest one when it would help
  dispatch notify "标题" "正文"      push to the phone (ntfy / Bark, keys in `dispatch env`) or a macOS banner
  dispatch --host <id> <any subcommand>   run it on another Mac from hosts.json (ssh; stdin/stdout pass through)
  dispatch env list|get|set|unset|undo|export|import|forget-missing   API keys & secrets (~/.config/dispatch/env, 0600; prime lists names only; a write that would drop keys is refused; every change can be undone)
  dispatch agents list|show|new|rm|link|effort   sub-agent definitions (~/.dispatch/agents, <project>/.dispatch/agents); dispatch agent run <name> "…" runs one on Codex
  dispatch ide status|agents|native-open|back …   Dispatch IDE (our Code - OSS desktop build), its Agents window and its bridge extension; `dispatch ide --help`
  dispatch chatd install|uninstall|status   chatd as a LaunchAgent (派活 and phone replies with no window open)

Data lives in ~/tasks/.dispatch (session registry, transcript index) and the
Beads board at $BEADS_DIR. bd remains the tool for tasks themselves.
"""
import argparse, datetime, glob, hashlib, json, os, re, shutil, subprocess, sys, tarfile, tempfile, time
sys.dont_write_bytecode = True  # never write __pycache__ next to these files: inside Dispatch.app that breaks the code signature
if os.path.dirname(os.path.abspath(__file__)) not in sys.path:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dplatform as P  # every macOS / Windows difference goes through this module
import engines as E  # every engine-specific fact comes from the engine's adapter (engines/<id>.py)
import lang as L  # the person's language: what Dispatch writes to them and their agents (t(english, chinese))

HOME = os.path.expanduser("~")
# DISPATCH_DIR (env) moves this Mac's Dispatch data: tests and a source checkout can then run without
# touching what the installed app and the phone service are using.
DISPATCH_DIR = os.environ.get("DISPATCH_DIR") or os.path.join(HOME, "tasks", ".dispatch")
SESS_DIR = os.path.join(DISPATCH_DIR, "sessions")
INDEX_FILE = os.path.join(DISPATCH_DIR, "transcript-index.json")
BEADS_DIR = os.environ.get("BEADS_DIR", os.path.join(HOME, "tasks", ".beads"))
def skill_pool():
    """Where shared skills live: ~/.dispatch/skills (`dispatch dir migrate` copies an older pool in and
    leaves a link at the old place). Before that migration, the older pool: cc-switch's
    ~/.cc-switch/skills, else ~/.agents/skill-pool. DISPATCH_SKILL_POOL overrides all of them."""
    env = os.environ.get("DISPATCH_SKILL_POOL", "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env))
    import dispatch_dir
    new = dispatch_dir.path("skills")
    if os.path.isdir(new):
        return new
    return dispatch_dir.legacy_pool() or new


POOL = skill_pool()
# Where each agent looks for skills. The first dir is where `enable` creates the
# symlink; the rest are also scanned (Codex reads both its own dir and the
# cross-agent ~/.agents/skills).
from engines import skill_dirs
AGENT_SKILL_DIRS = skill_dirs(HOME)
CC_SWITCH_DB = os.path.join(HOME, ".cc-switch", "cc-switch.db")


# OpenCode and ZCode (an OpenCode-based desktop app) keep conversations in one SQLite file each, with
# the same session / message / part tables; every query below runs against either store by agent name.
# Each engine that keeps them says where (its adapter's sqlite_store): `seq` is the column that orders parts
# (ZCode added `sequence`; OpenCode orders by id), `{seq}` in a query expands to it.
SQLITE_STORES = {e.agent: e.sqlite_store(HOME) for e in E.known() if e.supports("sqlite_store")}
RETIRED_AGENTS = frozenset({"qoder", "qoder-ide", "qodercli"})
PATH_EXTRA = os.pathsep.join(P.extra_bin_dirs())


def remote_beads(h=None):
    """`BEADS_DIR=…` for a command run on another Mac over ssh (a non-interactive shell has none of
    the person's environment). Each peer's board folder is recorded in hosts.json when it is added
    (`beads_dir`, written relative to its home); the default is where first-run setup puts it."""
    d = ((h or {}).get("beads_dir") or "").strip()
    if not d or "\n" in d:
        return "BEADS_DIR=$HOME/tasks/.beads"
    if d.startswith("~/"):
        return "BEADS_DIR=$HOME/" + shlex_quote_path(d[2:])
    return "BEADS_DIR=" + shlex_quote_path(d)


def shlex_quote_path(p):
    import shlex as _sh
    return _sh.quote(p)


def beads_dir_portable():
    """This Mac's board folder the way a peer should write it: relative to home when it is inside it."""
    real = os.path.abspath(BEADS_DIR)
    if P.IS_WIN:
        home = os.path.abspath(HOME)
        if P.is_under(real, home) and not P.same_path(real, home):
            return "~/" + P.to_slash(real[len(home.rstrip("\\/")):].lstrip("\\/"))
        return real
    home = HOME.rstrip("/") + "/"
    return "~/" + real[len(home):] if real.startswith(home) else real


def looks_like_task_id(key):
    """`<board prefix>-<id>`, with the prefix this board really uses (it can carry digits or capitals);
    the generic shape stays accepted so ids from another board's notes still resolve as tasks."""
    try:
        pre = re.escape(task_prefix())
    except Exception:
        pre = "task"
    # The generic shape is letters only: a session id prefix such as "b07cc9ed-5bed" must not pass.
    return bool(re.match(rf"^(?:{pre}|[a-z]+)-[a-z0-9]{{2,8}}$", key or ""))


def whoami():
    """Who this command speaks as on the board: the agent's own name when a hook or a launcher
    set BEADS_ACTOR, else the person at this Mac (their account name, like the desktop app)."""
    return os.environ.get("BEADS_ACTOR") or os.environ.get("DISPATCH_ACTOR") or os.path.basename(HOME.rstrip("/")) or "user"


# Two whole-board reads are asked for again and again inside one command (`prime` needed the
# memories four times and the task list twice, 0.15 s each). They are remembered for the life of
# the process, and forgotten the moment anything else talks to bd, so a write is never hidden.
_BD_READS = {("bd", "memories", "--json"), ("bd", "list", "--all", "--json")}
_bd_read_cache = {}
_BD_READ_TTL = 5.0


def sh(args, timeout=20, env=None):
    key = tuple(args) if env is None else None
    hit = _bd_read_cache.get(key) if key in _BD_READS else None
    # A few seconds only: one command finishes well within that, while a resident process (the
    # phone service and its push watcher) must notice a setting changed in the app or on the other Mac.
    if hit and time.time() - hit[0] < _BD_READ_TTL:
        return hit[1]
    if args and os.path.basename(str(args[0])) == "bd" and key not in _BD_READS:
        _bd_read_cache.clear()
    res = _sh(args, timeout, env)
    if key in _BD_READS and res[0] == 0:
        _bd_read_cache[key] = (time.time(), res)
    return res


BOARD_DOWN_MARKS = ("circuit breaker is open", "server appears down", "failed to open database", "connection refused", "project identity mismatch")
_board_revived = {"tried": False}


def _sh(args, timeout=20, env=None):
    if args and os.path.basename(str(args[0])) == "bd":
        # chatd's board service answers from memory and runs one bd at a time for everyone
        # (board_service.py); None: no service here, run bd ourselves as before
        try:
            via = _mod("board_client").call([str(x) for x in args[1:]], env, timeout, DISPATCH_DIR, BEADS_DIR)
        except Exception as e:
            debug("board_client", e)
            via = None
        if via is not None:
            return via
    return _sh_direct(args, timeout, env)


def _sh_direct(args, timeout=20, env=None):
    res = _sh_once(args, timeout, env)
    if res[0] != 0 and args and os.path.basename(str(args[0])) == "bd" and not _board_revived["tried"] and any(m in (res[2] + res[1]).lower() for m in BOARD_DOWN_MARKS):
        # The board's database server is not running (it died, or never came back after a
        # restart). Bring it back once per process and ask again, instead of handing the person
        # "dolt circuit breaker is open".
        _board_revived["tried"] = True
        try:
            fixed = _mod("init_wizard").ensure_board_server()
        except Exception as e:
            debug("ensure_board_server", e)
            fixed = {"ok": False, "log": ""}
        if fixed.get("started"):
            time.sleep(5.5)  # bd refuses for 5 s after a failed connect (its "cooldown")
            return _sh_once(args, timeout, env)
        if fixed.get("log"):
            return res[0], res[1], res[2].rstrip() + "\nThe task board database could not start. Last output:\n" + fixed["log"]
    return res


def _sh_once(args, timeout=20, env=None):
    e = P.path_env()
    e.setdefault("BEADS_DIR", BEADS_DIR)
    if env:
        e.update(env)
    if P.IS_WIN and args:
        # CreateProcess searches the parent's PATH, not env["PATH"], and does not run .cmd shims
        # (npm's codex / pi) by bare name: resolve the program first.
        exe = P.which(str(args[0]), e) if not os.path.isabs(str(args[0])) else None
        if exe:
            args = [exe] + list(args[1:])
    # bd truncates long values mid-character; decode leniently or every write with a
    # long Chinese memory blows up with UnicodeDecodeError (task-8xp).
    try:
        r = subprocess.run(args, capture_output=True, timeout=timeout, env=e, creationflags=P.no_window_flags())
    except FileNotFoundError:
        # A missing tool is a setup problem, not a crash: callers already handle code != 0.
        return 127, "", missing_tool_hint(args[0] if args else "")
    except subprocess.TimeoutExpired:
        # A busy board (many Agents at once) used to end the command with a traceback here.
        return 124, "", f"{os.path.basename(str(args[0])) if args else 'command'} did not answer within {int(timeout)} seconds"
    return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")


TOOL_FORMULA = {"bd": "beads", "dolt": "dolt", "git": "git", "rsync": "rsync", "ssh": "openssh"}


def debug(where, err):
    """Swallowed errors stay swallowed for people, and show up for whoever sets DISPATCH_DEBUG=1."""
    if os.environ.get("DISPATCH_DEBUG"):
        print(f"[dispatch debug] {where}: {type(err).__name__}: {err}", file=sys.stderr)


def missing_tool_hint(tool):
    name = P.exe_base(str(tool)) if P.IS_WIN else os.path.basename(str(tool))
    hint = P.install_hint(name) if name in TOOL_FORMULA else None
    if hint and not P.IS_WIN:
        hint = f"brew install {TOOL_FORMULA[name]}"
    return f"Command {name} not found" + (f". Run {hint} in a terminal to install it." if hint else ".")


def no_board(code, err):
    """True when bd failed because there is no task board yet (or bd itself is missing) — a state
    to say in one line, not an error to dump: sessions, skills and rules work without a board."""
    text = (err or "").lower()
    return code == 127 or "no beads database" in text or "no .beads" in text or "not initialized" in text or "bd init" in text


NO_BOARD_HINT = L.t("No task board yet. Adding a project makes one, or run `dispatch init ensure-board`. Sessions, skills and rules are available.",
                    "还没有任务板：添加一个项目就会建好，或者运行 `dispatch init ensure-board`。会话、技能和规则照常能用")


def bd_problem(code, err):
    """One line for stderr about a failed bd call."""
    return NO_BOARD_HINT if no_board(code, err) and code != 127 else (err or "").strip().splitlines()[-1][:300] if (err or "").strip() else f"bd exited with code {code}"


def _mod(name):
    """A sibling module (profile / memories / lineage / summarize …), imported on first use so
    `dispatch` stays quick to start."""
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    return __import__(name)


_PATH_KEYS = frozenset({"cwd", "path", "dir", "file", "html", "index", "home", "root", "link", "folder", "opened", "transcript", "files", "paths", "dirs"})
_WIN_ABS = re.compile(r"^([A-Za-z]:[\\/]|\\\\)")


def slash_paths(obj, key=""):
    """Windows: every path the app receives uses forward slashes (C:/Users/x/proj). Converts string
    values under path-like keys (cwd, path, …_path, …_dir) that are Windows absolute paths; lists
    under such keys too. Returns obj unchanged elsewhere; macOS never calls it."""
    if isinstance(obj, dict):
        return {k: slash_paths(v, k) for k, v in obj.items()}
    if isinstance(obj, list):
        return [slash_paths(v, key) for v in obj]
    if isinstance(obj, str) and key and (key in _PATH_KEYS or key.endswith(("_path", "_dir", "_cwd", "_file", "_home", "_root"))):
        return P.to_slash(obj) if _WIN_ABS.match(obj) or (key == "files" and "\\" in obj) else obj
    return obj


def out(obj, as_json, text_fn):
    if as_json:
        if P.IS_WIN:
            obj = slash_paths(obj)
        print(json.dumps(obj, ensure_ascii=False, indent=2))
    else:
        text_fn(obj)


def cwd_key(p):
    """A working directory as a dict key / for equality: trailing slash dropped; on Windows also
    case-folded and with one kind of separator (P.norm_path)."""
    if P.IS_WIN:
        return P.norm_path(p).rstrip("\\/") if p else ""
    return (p or "").rstrip("/")


def ui_path(p):
    """A path as the app receives it: forward slashes on Windows (C:/Users/x/proj), unchanged elsewhere."""
    return P.to_slash(p) if P.IS_WIN and isinstance(p, str) else p


def ago(epoch):
    if not epoch:
        return "?"
    m = max(0, int((time.time() - epoch) / 60))
    return "just now" if m < 1 else f"{m}m" if m < 60 else f"{m // 60}h" if m < 1440 else f"{m // 1440}d"


# ---------------------------------------------------------------- sessions

def ps_table():
    """{pid: (ppid, command)}: `ps` on macOS, a Toolhelp snapshot with image paths on Windows."""
    if P.IS_WIN:
        return P.ps_table()
    _, o, _ = sh(["ps", "-axo", "pid=,ppid=,comm="])
    t = {}
    for line in o.splitlines():
        p = line.strip().split(None, 2)
        if len(p) == 3:
            t[int(p[0])] = (int(p[1]), p[2])
    return t


def win_console_argv(argv):
    """Windows: resolve argv[0] on PATH; a .cmd / .bat shim (npm's codex, pi) runs through cmd /c."""
    argv = list(argv)
    if not argv:
        return argv
    exe = P.which(argv[0]) or argv[0]
    if exe.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", exe] + argv[1:]
    return [exe] + argv[1:]


def _exe(comm):
    """Program name of a ps_table command: the basename on macOS, without .exe (lower-case) on Windows."""
    return P.exe_base(comm) if P.IS_WIN else os.path.basename(comm)


def zcode_query(sql, params=(), agent="zcode"):
    """Read-only query against ZCode's or OpenCode's SQLite (see SQLITE_STORES); [] when the store
    is missing or the query fails (a table one store does not have, a locked file)."""
    store = SQLITE_STORES.get(agent) or SQLITE_STORES[next(iter(SQLITE_STORES))]
    return _sqlite_rows(store["db"], sql.replace("{seq}", store["seq"]), params)


def _sqlite_rows(db, sql, params=()):
    """Rows of a read-only query against another program's SQLite; [] when the file is missing or
    the query fails (a table it does not have, a locked file)."""
    if not os.path.exists(db):
        return []
    try:
        import sqlite3
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
        con.row_factory = sqlite3.Row
        rows = [dict(r) for r in con.execute(sql, params)]
        con.close()
        return rows
    except Exception:
        return []


def store_live(agent, table):
    """ZCode / OpenCode have no hooks; while their process runs, a session updated in the last few
    minutes counts as live (working if it wrote within 90 s)."""
    now = time.time()
    out = []
    for agent, store in [(agent, SQLITE_STORES[agent])] if agent in SQLITE_STORES else []:
        pids = [pid for pid, (_, comm) in table.items() if _exe(comm) == store["proc"]]
        if not pids:
            continue
        rows = zcode_query("select id, directory, title, time_created, time_updated from session where parent_id is null and time_archived is null and time_updated > ? order by time_updated desc", ((now - 30 * 60) * 1000,), agent=agent)
        for r in rows:
            last = r["time_updated"] / 1000
            state = "working" if now - last < 90 else "idle"
            out.append({"agent": agent, "session_id": r["id"], "cwd": r["directory"], "project": os.path.basename(r["directory"].rstrip("/")), "agent_pid": pids[0], "source_kind": store["entrypoint"], "source_app": store["app"], "entrypoint": "", "started_at": r["time_created"] / 1000, "last_at": last, "state": state, "prompts": 0, "alive": True, "registered": True, "title": r["title"]})
    return out


# ---------------------------------------------------------------- other Macs over Tailscale

HOSTS_FILE = os.path.join(DISPATCH_DIR, "hosts.json")
SELF_NAME_FILE = os.path.join(DISPATCH_DIR, "self-name.json")
REMOTE_DIR = os.path.join(DISPATCH_DIR, "remote")
_LOCAL_NAME = None


def local_host_name():
    """The system ComputerName (e.g. "阁楼的 Mac mini"), unless renamed from Settings —
    that override lives in SELF_NAME_FILE, separate from the system name so it survives
    across reinstalls and doesn't touch macOS's own ComputerName."""
    global _LOCAL_NAME
    if _LOCAL_NAME is None:
        try:
            _LOCAL_NAME = json.load(open(SELF_NAME_FILE, encoding="utf-8")).get("name", "").strip()
        except Exception:
            _LOCAL_NAME = ""
        if not _LOCAL_NAME:
            _LOCAL_NAME = P.host_name()
    return _LOCAL_NAME


def local_host_aliases():
    """Names this Mac went by before (renames, the system ComputerName): old host:<name> task
    labels and saved filters still resolve to it."""
    names = set()
    try:
        names |= set(json.load(open(SELF_NAME_FILE, encoding="utf-8")).get("aliases") or [])
    except Exception:
        pass
    try:
        sysname = P.host_name()
        if sysname:
            names.add(sysname)
    except Exception:
        pass
    return sorted(n for n in names if n and n != local_host_name())


def remember_peer_name(hid, name, aliases=()):
    hs = hosts()
    for h in hs:
        if h.get("id") == hid and h.get("name") != name:
            h["aliases"] = sorted((set(h.get("aliases") or []) | {h["name"]} | set(aliases)) - {name})
            h["name"] = name
            tmp = HOSTS_FILE + ".tmp"
            json.dump(hs, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
            P.replace_retry(tmp, HOSTS_FILE)
            return True
    return False


def hosts():
    """Other Macs that run the same dispatch checkout, reached over Tailscale by ssh.
    Edit ~/tasks/.dispatch/hosts.json to add one; an empty list turns the feature off."""
    try:
        return json.load(open(HOSTS_FILE, encoding="utf-8"))
    except Exception:
        return []  # no other Macs until `dispatch init` joins one


def _tag_host(rows, h):
    for r in rows or []:
        if isinstance(r, dict):
            r["host"], r["host_name"] = h["id"], h["name"]
    return rows or []


MOVES_FILE = os.path.join(DISPATCH_DIR, "moves.json")


def load_moves():
    try:
        with open(MOVES_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def host_label(hid):
    """Display name for a host id (or an id it had before) — looked up each time, so a rename shows everywhere at once."""
    if hid in (None, "", "local"):
        return local_host_name()
    h = host_entry(hid)
    return h["name"] if h else hid


def host_entry(x):
    """The hosts.json entry for an id, name, alias (any case), ssh address or IP; None when x is not a
    known peer. Old ids and names live on as aliases, so records written before a rename resolve."""
    return _mod("host_admin").match(hosts(), x) if x else None


def _host_admin():
    """host_admin.py (hosts discover / add / set / remove, ~/.dispatch/ssh/config) bound to this module."""
    m = _mod("host_admin")
    m.D = _THIS
    return m


def resolve_host_id(x):
    """hosts.json id for an id, name, alias, ssh address or IP; "" when it is not a known peer."""
    return (host_entry(x) or {}).get("id") or ""


def update_moves(change):
    """Read moves.json, let `change(moves)` edit it, write it back in one atomic replace. A lock keeps
    two writers (a project move marking its history while the peer marks a session) from dropping
    each other's keys."""
    os.makedirs(DISPATCH_DIR, exist_ok=True)
    lock = None
    try:
        import fcntl
        lock = open(MOVES_FILE + ".lock", "a")
        fcntl.flock(lock, fcntl.LOCK_EX)
    except (ImportError, OSError):
        lock = None
    try:
        moves = load_moves()
        result = change(moves)
        tmp = f"{MOVES_FILE}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(moves, f, ensure_ascii=False, indent=2)
        P.replace_retry(tmp, MOVES_FILE)
        return result
    finally:
        if lock:
            lock.close()


def move_record(moved_to=None, moved_from=None, at=None, **extra):
    rec = {"at": at or time.time()}
    if moved_to:
        rec["moved_to"] = moved_to
    if moved_from:
        rec["moved_from"] = moved_from
    rec.update({k: v for k, v in extra.items() if v not in (None, "", False)})
    return rec


def record_move(agent, sid, moved_to=None, moved_from=None, **extra):
    """A `dispatch move` leaves the same session id on two Macs. Remember which copy is the original
    (moved_to <host id>, plus the cwd it continues in over there) and which the new one (moved_from
    <host id>). `pending_peer` on an original means the other Mac has not confirmed its half yet:
    `dispatch move repair` finishes it."""
    rec = move_record(moved_to, moved_from, **extra)
    update_moves(lambda moves: moves.__setitem__(f"{agent}:{sid}", rec))
    return rec


def record_moves(recs):
    """Several records in one write: {"agent:sid": record}."""
    update_moves(lambda moves: moves.update(recs))
    return recs


def confirm_moves(keys):
    """The other Mac wrote its half: drop pending_peer from these originals."""
    def change(moves):
        for k in keys:
            if isinstance(moves.get(k), dict):
                moves[k].pop("pending_peer", None)
    update_moves(change)


def annotate_moves(rows):
    """Put moved_to/moved_from (host id + current name) on this Mac's rows. Peers annotate their own."""
    moves = load_moves()
    if not moves:
        return rows
    known = {}  # a record's host id (maybe one the Mac had before a rename) -> (id now, name)
    for r in rows or []:
        if not isinstance(r, dict) or r.get("host") not in (None, "local"):
            continue
        rec = moves.get(f"{r.get('agent')}:{r.get('session_id')}")
        for k in ("moved_to", "moved_from"):
            if rec and rec.get(k):
                if rec[k] not in known:
                    h = host_entry(rec[k])
                    known[rec[k]] = (h["id"], h["name"]) if h else (rec[k], rec[k])
                r[k], r[k + "_name"] = known[rec[k]]
        if rec and rec.get("at") and (rec.get("moved_to") or rec.get("moved_from")):
            r["moved_at"] = rec["at"]  # which of two contradicting records is newer, and whether a copy went on after the move
    return rows


def cmd_moves(a):
    if a.op == "confirm":
        rec = load_moves().get(a.key)
        if not isinstance(rec, dict):
            raise SystemExit(L.t(f"No move recorded for {a.key}", f"没有 {a.key} 的迁移记录"))
        confirm_moves([a.key])
        return out(load_moves().get(a.key), a.json, lambda r: print(L.t("Confirmed", "已确认"), json.dumps(r, ensure_ascii=False)))
    if a.op == "mark":
        if ":" not in a.key or not (a.to or a.from_):
            raise SystemExit(L.t("Usage: dispatch moves mark <agent:session_id> --to <host> | --from <host>", "用法：dispatch moves mark <agent:session_id> --to <主机> | --from <主机>"))
        agent, sid = a.key.split(":", 1)
        to = resolve_host_id(a.to) or a.to if a.to else None
        frm = resolve_host_id(a.from_) or a.from_ if a.from_ else None
        return out(record_move(agent, sid, moved_to=to, moved_from=frm), a.json, lambda r: print(L.t("Recorded", "已记录"), json.dumps(r, ensure_ascii=False)))
    rows = [{"key": k, **v, **({"moved_to_name": host_label(v["moved_to"])} if v.get("moved_to") else {}), **({"moved_from_name": host_label(v["moved_from"])} if v.get("moved_from") else {})} for k, v in load_moves().items()]
    out(rows, a.json, lambda rows: [print(f"{r['key']}  " + (L.t(f"moved to {r['moved_to_name']}", f"已迁往 {r['moved_to_name']}") if r.get("moved_to") else L.t(f"moved here from {r.get('moved_from_name')}", f"从 {r.get('moved_from_name')} 迁来"))) for r in rows] or None)


def remote_cache_path(h, args):
    """Where remote_dispatch keeps this host+command's answer; its mtime is how old it is."""
    return os.path.join(REMOTE_DIR, f"{h['id']}--" + re.sub(r"[^a-z0-9]+", "-", " ".join(args).lower()).strip("-") + ".json")


def remote_cache_age(h, args):
    """Seconds since that answer was written; None when there is none yet."""
    try:
        return max(0.0, time.time() - os.stat(remote_cache_path(h, args)).st_mtime)
    except OSError:
        return None


def _spawn_remote_refresh(h, args, timeout):
    """Let a detached `dispatch remote-refresh` do the ssh and write the cache, so the caller
    can answer now. The .lock keeps one refresh per host+command: the app polls every few
    seconds and the remote side takes seconds, so without it we would pile up ssh sessions."""
    lock = remote_cache_path(h, args)[:-5] + ".lock"
    try:
        if time.time() - os.stat(lock).st_mtime < timeout + 10:
            return  # one is already on its way (or died mid-flight less than a timeout ago)
    except OSError:
        pass
    try:
        os.makedirs(REMOTE_DIR, exist_ok=True)
        open(lock, "w", encoding="utf-8").close()
        devnull = subprocess.DEVNULL
        P.spawn_detached([sys.executable, os.path.abspath(__file__), "remote-refresh", h["id"], "--timeout", str(int(timeout)), "--"] + list(args),
                         stdin=devnull, stdout=devnull, stderr=devnull)
    except Exception:
        try:
            os.remove(lock)
        except OSError:
            pass


def remote_pending(h, args):
    """A background refresh of `dispatch <args>` on that host is still on its way (remote_dispatch background=True)."""
    return os.path.exists(remote_cache_path(h, args)[:-5] + ".lock")


def remote_dispatch(h, args, ttl, timeout=12, background=False, wait=None):
    """Run `dispatch <args> --json` on another host, cached for ttl seconds. Never blocks
    the caller for more than ~10s, and remembers an unreachable host for a minute so the
    app's 5-second presence polls stay cheap. Returns the stale cache (or None) on failure.

    background=True hands back whatever the cache holds and refreshes it in a detached process
    for the next call — *when there is a cache to hand back*. On a cold cache (this host+command
    has never answered before) a detached-only refresh would leave the very first caller with
    nothing, and — nothing else prompting a retry — the page can stay wrong until it is reopened.
    So a cold cache still blocks once, briefly (bounded by `timeout` the same as the blocking
    path below): it kicks the same detached refresh and polls for its cache file, rather than
    running its own second ssh, so two cold callers for the same host+command still make one ssh
    call between them. It stops waiting as soon as that refresh has actually finished — its lock
    file gone, or a `.down` marker freshly written during the wait — instead of always sitting
    out the full timeout when the host is simply unreachable (asleep, off Tailscale): otherwise
    every cold page-open against a down host would hang for the whole `timeout`. Use
    background=True where the page must paint now and slightly old remote rows are fine (`here`,
    `docs`); callers that need the answer itself keep the blocking default. `wait` (background only) caps that
    first wait below `timeout`, for a command that may take longer there than a page should wait for: the refresh
    goes on, and remote_pending() says so until it ends."""
    import shlex
    os.makedirs(REMOTE_DIR, exist_ok=True)
    cache = remote_cache_path(h, args)
    down = os.path.join(REMOTE_DIR, f"{h['id']}.down")
    now = time.time()

    def stale():
        try:
            return json.load(open(cache, encoding="utf-8"))
        except Exception:
            return None

    cache_exists = os.path.exists(cache)
    if cache_exists:
        try:
            if now - os.stat(cache).st_mtime < ttl:
                return stale()
        except OSError:
            cache_exists = False
    try:
        if now - os.stat(down).st_mtime < 60:
            return stale()
    except OSError:
        pass
    if background:
        if cache_exists:
            _spawn_remote_refresh(h, args, timeout)
            return stale()
        lock = remote_cache_path(h, args)[:-5] + ".lock"
        wait_start = time.time()
        _spawn_remote_refresh(h, args, timeout)   # creates/touches `lock` before returning — no race with the checks below
        deadline = wait_start + (timeout if wait is None else min(wait, timeout)) + 3  # slack past the subprocess's own ssh timeout for its startup
        while time.time() < deadline:
            got = stale()
            if got is not None:
                return got
            if not os.path.exists(lock):
                return None   # the refresh (ours or another caller's) already ended with no cache — no point waiting out the timeout
            try:
                # Windows stamps files from a coarser clock than time.time() (up to a tick earlier);
                # any older .down already returned above (it is younger than 60 s).
                if os.stat(down).st_mtime >= wait_start - (1.0 if P.IS_WIN else 0):
                    return None   # ...or it just found the host unreachable and wrote a fresh .down
            except OSError:
                pass
            time.sleep(0.2)
        return stale()
    # The remote login shell is fish, so use `env` rather than FOO=bar prefixes.
    cmd = f"env {remote_beads(h)} {remote_cli(h)} " + " ".join(shlex.quote(x) for x in args) + " --json"
    try:
        r = subprocess.run(["ssh", "-o", "ConnectTimeout=3", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", h["ssh"], cmd], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, creationflags=P.no_window_flags())
        if r.returncode == 255:
            raise ConnectionError(r.stderr.strip()[:200])  # ssh itself failed: host unreachable
        if r.returncode != 0:
            debug(f"remote_dispatch {h.get('id')} {' '.join(args[:2])}", RuntimeError(f"exit {r.returncode}: {(r.stderr or r.stdout).strip()[:200]}"))
            return stale()  # the command failed there (old checkout, bad args): host is fine, don't mark it down
        s = r.stdout
        start = min(i for i in (s.find("["), s.find("{")) if i >= 0)
        data = json.loads(s[start:])
    except (ConnectionError, subprocess.TimeoutExpired) as e:
        debug(f"remote_dispatch {h.get('id')} unreachable", e)
        try:
            open(down, "w", encoding="utf-8").close()
        except OSError:
            pass
        return stale()
    except Exception as e:
        debug(f"remote_dispatch {h.get('id')} {' '.join(args[:2])}", e)
        return stale()
    try:
        tmp = cache + ".tmp"
        json.dump(data, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
        P.replace_retry(tmp, cache)
        if os.path.exists(down):
            os.remove(down)
    except OSError:
        pass
    return data


def cmd_remote_refresh(a):
    """The detached half of remote_dispatch(background=True): do the ssh, write the cache, drop
    the lock. Not meant to be typed — prints nothing, so it can be spawned and forgotten.

    The lock always comes off, exception included: a cold caller in remote_dispatch is watching
    it (and the `.down` marker) to know the refresh has ended even when it produced no cache, so
    a stuck lock would make that caller sit out its full wait for no reason."""
    h = next((x for x in hosts() if x.get("id") == a.host), {"id": a.host})
    try:
        if h.get("ssh"):
            remote_dispatch(h, a.args, 0, timeout=max(5, a.timeout))
    finally:
        try:
            os.remove(remote_cache_path(h, a.args)[:-5] + ".lock")  # even when the host is gone, or the next open never refreshes
        except OSError:
            pass


def tailscale_ip():
    cands = (["tailscale", "ip", "-4"], ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "ip", "-4"])
    if P.IS_WIN:
        exe = P.which("tailscale") or os.path.join(os.environ.get("ProgramFiles") or "C:\\Program Files", "Tailscale", "tailscale.exe")
        cands = ([exe, "ip", "-4"],)
    for cmd in cands:
        try:
            ip = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=3, creationflags=P.no_window_flags()).stdout.strip().split("\n")[0].strip()
            if ip.startswith("100."):
                return ip
        except Exception:
            pass
    if P.IS_WIN:
        return ""  # no ifconfig; without the tailscale CLI there is no tailnet address to find
    try:
        m = re.search(r"inet (100\.\d+\.\d+\.\d+)", subprocess.run(["ifconfig"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=3).stdout)
        return m.group(1) if m else ""
    except Exception:
        return ""


_SSH_ENDPOINTS = {}


def ssh_endpoint(target):
    """(address, port) that ssh itself connects to for `target` (user@host or an alias): the person's ssh config can name
    another address or port for it (Host mac / HostName … / Port 2222), which `ssh -G` resolves without connecting.
    Without ssh, or when it cannot tell: the part after @ and port 22."""
    t = (target or "").strip()
    if not t:
        return ("", 22)
    if t not in _SSH_ENDPOINTS:
        host, port = t.split("@")[-1], 22
        try:
            r = subprocess.run(["ssh", "-G", t], capture_output=True, text=True, timeout=5)
            for line in r.stdout.splitlines() if r.returncode == 0 else []:
                k, _, v = line.partition(" ")
                if k == "hostname" and v.strip():
                    host = v.strip()
                elif k == "port" and v.strip().isdigit():
                    port = int(v.strip())
        except (OSError, subprocess.SubprocessError):
            pass
        _SSH_ENDPOINTS[t] = (host, port)
    return _SSH_ENDPOINTS[t]


def reachable_over_ssh(h, timeout=1.0):
    """Whether another Mac's ssh port answers: its address and port as ssh resolves its entry (ssh_endpoint), or the
    entry's own `ip` on 22."""
    if h.get("ip"):
        return port_open(h["ip"], 22, timeout)
    host, port = ssh_endpoint(h.get("ssh", ""))
    return bool(host) and port_open(host, port, timeout)


def port_open(ip, port, timeout=1.0):
    import socket
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except Exception:
        return False


def _app_present(*globs):
    for g in globs:
        if glob.glob(g):
            return True
    return False


def overlay_network():
    """Which private overlay this Mac is on, and its address there. Tailscale (and Headscale,
    same client) hand out 100.x; Netbird uses the same range; ZeroTier is a zt* interface."""
    ip = tailscale_ip()
    if ip:
        return {"kind": "tailscale", "ip": ip}
    try:
        o = subprocess.run(["netbird", "status", "--json"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=3, creationflags=P.no_window_flags()).stdout
        m = re.search(r'"netbirdIp":\s*"([0-9.]+)', o)
        if m:
            return {"kind": "netbird", "ip": m.group(1)}
    except Exception:
        pass
    if P.IS_WIN:
        return {"kind": "", "ip": ""}
    try:
        o = subprocess.run(["ifconfig"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=3).stdout
        m = re.search(r"^(zt\w+|feth\d+|utun\d+):.*?\n\s+inet (\d+\.\d+\.\d+\.\d+)", o, re.S | re.M)
        if m and m.group(1).startswith("zt"):
            return {"kind": "zerotier", "ip": m.group(2)}
    except Exception:
        pass
    return {"kind": "", "ip": ""}


def _route_ip():
    """This machine's address on the default route (a UDP connect sends nothing)."""
    import socket
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sk:
            sk.connect(("8.8.8.8", 80))
            return sk.getsockname()[0]
    except Exception:
        return ""


def lan_ip():
    if P.IS_WIN:
        ip = _route_ip()
        return ip if re.match(r"^(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$", ip) else ""
    try:
        o = subprocess.run(["ifconfig"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=3).stdout
        m = re.search(r"inet (192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)", o)
        return m.group(1) if m else ""
    except Exception:
        return ""


def rustdesk_id():
    for p in (os.path.join(HOME, "Library", "Preferences", "com.carriez.RustDesk", "RustDesk.toml"),):
        try:
            m = re.search(r"^id\s*=\s*'?\"?([0-9]{6,12})", open(p, encoding="utf-8").read(), re.M)
            if m:
                return m.group(1)
        except OSError:
            pass
    return ""


def detect_remote_backends():
    """What this Mac can be reached with. Dispatch never ships a video pipeline of its own;
    it detects the engines people already use — different ones in China and elsewhere —
    and recommends the first that works without extra setup."""
    from remote_screen import secure_screen_url
    ov = overlay_network()
    ip = ov["ip"] or lan_ip()
    screen_url = secure_screen_url(ip)
    screen_http = port_open("127.0.0.1", 6080, 0.5) or (bool(ip) and port_open(ip, 6080, 0.5))
    b = {
        "overlay": ov,
        "lan_ip": lan_ip(),
        "screen_sharing": port_open("127.0.0.1", 5900, 0.5),
        "novnc_up": bool(screen_url) and screen_http,
        "novnc": screen_url,
        "novnc_issue": "" if screen_url else L.t("Seeing the screen from a phone needs Tailscale HTTPS turned on; an old HTTP link cannot sign in to the Mac in Safari.", "手机看屏幕需要开启 Tailscale HTTPS；旧 HTTP 链接无法在 Safari 登录 Mac。") if screen_http else "",
        "vnc": f"vnc://{ip}" if ip else "",
        "rustdesk": _app_present("/Applications/RustDesk.app"),
        "rustdesk_id": rustdesk_id(),
        "sunshine": _app_present("/Applications/Sunshine.app", "/opt/homebrew/bin/sunshine", "/usr/local/bin/sunshine"),
        "sunshine_ui": f"https://{ip}:47990" if ip else "",
        "uu": _app_present("/Applications/*UU*远程*.app", "/Applications/UU Remote*.app", "/Applications/网易UU远程.app"),
    }
    # Recommendation, in the order that costs the user the least.
    if ov["kind"] and b["novnc_up"]:
        rec, why = "novnc", L.t(f"Already on the {ov['kind']} network; a browser opens it over HTTPS", f"已在 {ov['kind']} 网里，浏览器通过 HTTPS 打开")
    elif ov["kind"] and b["screen_sharing"]:
        rec, why = "vnc", L.t(f"Already on the {ov['kind']} network and Screen Sharing is on; Settings › Screen access › Set up lets a phone see it", f"已在 {ov['kind']} 网里，屏幕共享已开；设置页「屏幕访问」点「配置」就能手机看")
    elif b["rustdesk"]:
        rec, why = "rustdesk", L.t("No private network needed: connect with an ID and password (works in and outside China, you can run your own relay)", "不用虚拟网，ID + 密码直连（国内外都好用，可自建中继）")
    elif b["sunshine"]:
        rec, why = "moonlight", L.t("The sharpest picture; install Moonlight on the phone, pair, then connect", "画质最高；手机装 Moonlight，配对后连")
    elif b["uu"]:
        rec, why = "uu", L.t("NetEase UU Remote is installed: connect with it (closed source, Dispatch can only open it)", "已装网易UU远程，用它连（闭源，只能打开）")
    elif b["novnc_up"] or b["screen_sharing"]:
        rec, why = "novnc" if b["novnc_up"] else "vnc", L.t("Works on the same local network only; for away from home install Tailscale/Netbird or RustDesk", "只能在同一局域网里用；出门要装 Tailscale/Netbird 或 RustDesk")
    else:
        rec, why = "", L.t("No way to reach this Mac remotely: install Tailscale (outside China) or RustDesk (in China), then turn on Screen Sharing", "没有可用的远程方式：装 Tailscale（国外）/ RustDesk（国内）之一，再开系统屏幕共享")
    b["recommend"], b["why"] = rec, why
    return b


def host_rows(local_only=False):
    """This Mac plus the others in hosts.json, each with the remote-desktop backends it
    actually has (detected on that machine) and a recommendation."""
    rows = []
    b = detect_remote_backends()
    ip = b["overlay"]["ip"] or b["lan_ip"]
    rows.append({"id": "local", "name": local_host_name(), "aliases": local_host_aliases(), "ip": ip, "ssh": "", "online": True, "local": True, **{k: v for k, v in b.items()},
                 "dispatch_version": _mod("machines").version()})  # peers read it from their cached `hosts --local` answer
    if local_only:
        return rows
    for h in hosts():
        hip = h.get("ip") or (h.get("ssh", "").split("@")[-1])
        down = os.path.join(REMOTE_DIR, f"{h['id']}.down")
        try:
            recently_down = time.time() - os.stat(down).st_mtime < 60
        except OSError:
            recently_down = False
        online = (not recently_down) and reachable_over_ssh(h)
        row = {"id": h["id"], "name": h["name"], "aliases": h.get("aliases") or [], "ip": hip, "ssh": h.get("ssh", ""), "online": online, "local": False,
               "novnc": "", "novnc_up": False, "novnc_issue": "", "vnc": f"vnc://{hip}",
               "screen_sharing": online and port_open(hip, 5900), "rustdesk": False, "rustdesk_id": "", "sunshine": False, "sunshine_ui": "", "uu": False, "overlay": {"kind": "", "ip": hip}, "recommend": "", "why": ""}
        if online:
            det = remote_dispatch(h, ["hosts", "--local"], 120)
            if isinstance(det, list) and det:
                d = det[0]
                # One Mac, one name: hosts.json's name is what this Mac calls it (the SSH alias too). What
                # that Mac calls itself joins the aliases, so records under its own name still resolve.
                if d.get("name") and d["name"] != h["name"]:
                    _host_admin().remember_aliases(h["id"], [d["name"]] + list(d.get("aliases") or []))
                    row["aliases"] = sorted(set(row["aliases"]) | {d["name"]} | set(d.get("aliases") or []) - {h["name"]})
                for k in ("rustdesk", "rustdesk_id", "sunshine", "uu", "screen_sharing", "novnc", "novnc_up", "novnc_issue"):
                    row[k] = d.get(k, row[k])
                # Older peers may still advertise the broken HTTP endpoint.
                if not row["novnc"].startswith("https://"):
                    row["novnc"], row["novnc_up"] = "", False
                    if row["screen_sharing"]:
                        row["novnc_issue"] = L.t("Seeing the screen from a phone needs Tailscale HTTPS turned on on that Mac.", "手机看屏幕需要在这台机器开启 Tailscale HTTPS。")
                if isinstance(d.get("overlay"), dict) and d["overlay"].get("kind"):
                    row["overlay"] = d["overlay"]
                row["sunshine_ui"] = f"https://{hip}:47990" if d.get("sunshine") else ""
        if row["novnc_up"]:
            row["recommend"], row["why"] = "novnc", L.t("a browser opens it over HTTPS", "浏览器通过 HTTPS 打开")
        elif row["screen_sharing"]:
            row["recommend"], row["why"] = "vnc", L.t("Screen Sharing is on; that Mac's Settings › Screen access › Set up lets a phone see it", "屏幕共享已开；在那台的设置页「屏幕访问」点「配置」就能手机看")
        elif row["rustdesk"]:
            row["recommend"], row["why"] = "rustdesk", L.t("connect with an ID and password", "ID + 密码直连")
        elif row["sunshine"]:
            row["recommend"], row["why"] = "moonlight", L.t("install Moonlight on the phone and pair", "手机装 Moonlight 配对")
        elif not online:
            row["recommend"], row["why"] = "", L.t("offline", "离线")
        else:
            row["recommend"], row["why"] = "", L.t("that Mac has no way to be reached remotely", "那台机器上没有可用的远程方式")
        rows.append(row)
    return rows


# ---------------------------------------------------------------- hand work to another agent (an in-app chat in Dispatch)

def target_host(host):
    """None for this Mac, else the hosts.json entry (by id, name or an alias)."""
    if not host or host in ("local", "本机"):
        return None
    h = host_entry(host)
    if h:
        return h
    raise SystemExit(L.t(f"No Mac called {host} in hosts.json", f"hosts.json 里没有叫 {host} 的机器"))


def project_of_folder(host, cwd):
    """The project a folder (on `host`, None = this Mac) belongs to, '' outside a project.
    Another Mac's folder is matched home-relative against the workspace roots (~/Projects/<x>)."""
    try:
        if host is None:
            return project_of_cwd(cwd, {})
        rel = home_relative(cwd, host)
        for r in settings_load().get("workspace_roots") or []:
            r = r.rstrip("/")
            if rel.startswith(r + "/"):
                return re.sub(r"-wt$", "", rel[len(r) + 1:].split("/")[0])
    except Exception:
        pass
    return ""


def claim_for_agent(task, actor, where):
    """Claim `task` for the agent just started and record who handed it over (labels + a comment)."""
    me = whoami()
    sh(["bd", "update", task, "--claim", "--json"], env={"BEADS_ACTOR": actor})
    # who handed the task to whom: labels the views read, a comment for the record
    sh(["bd", "update", task, "--add-label", f"delegated-by:{me}", "--add-label", f"delegated-to:{actor}", "--json"], env={"BEADS_ACTOR": me})
    note = L.t(f"{me} handed this to {actor} through dispatch agent ({where})", f"{me} 通过 dispatch agent 派给 {actor}（{where}）")
    sh(["bd", "comments", "add", task, note], env={"BEADS_ACTOR": me})


def auto_name_wanted(label, prompt):
    """Name the session from its first message unless the caller gave a real label (a task
    title, 「迁移检查 · …」): no label, or one that is only the message's first characters."""
    label, prompt = " ".join((label or "").split()), " ".join((prompt or "").split())
    return bool(prompt) and (not label or prompt.startswith(label))


# The namer reads at most this much of the first message (the model gets 1500 characters, the
# transcript match 60), so a huge pasted prompt never fills the stdin pipe and blocks the launch.
NAMER_MESSAGE_CHARS = 2000


def _transcript_user_text(path, limit=80):
    """The first thing the person typed in a Claude or Codex transcript (injected context such as
    <environment_context> or <recommended_plugins> skipped), to match a transcript to a launch.
    Codex: its `user_message` event; the raw user items also carry AGENTS.md, so they only count
    when a transcript has no such event."""
    raw = ""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for n, line in enumerate(f):
                if n > limit:
                    break
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                p = d.get("payload") or {}
                text = ""
                if d.get("type") == "user":
                    c = (d.get("message") or {}).get("content")
                    text = c if isinstance(c, str) else " ".join(x.get("text", "") for x in c or [] if isinstance(x, dict) and x.get("type") == "text")
                elif d.get("type") == "event_msg" and p.get("type") == "user_message":
                    text = p.get("message") or ""
                elif d.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
                    item = " ".join(x.get("text", "") for x in p.get("content") or [] if isinstance(x, dict))
                    if not raw and item.strip() and not item.lstrip().startswith(("<", "# AGENTS.md")):
                        raw = item
                if text.strip() and not text.lstrip().startswith("<"):
                    return text
    except OSError:
        pass
    return raw


def _same_message(a, b):
    a, b = " ".join((a or "").split()), " ".join((b or "").split())
    return bool(a and b) and a[:60] == b[:60]


def launched_transcript(kind, since, message, sid=""):
    """The transcript of a session launched at `since` (epoch seconds): the file named after its
    session id when that is known, else the newest one written since then whose first message
    is `message`."""
    files = [p for p, _ in E.get(kind).transcript_files(HOME) if "/subagents/" not in P.to_slash(p)]
    if sid:
        exact = [f for f in files if sid in os.path.basename(f)]
        if exact:
            return exact[0]
    rows = []
    for f in files:
        try:
            m = os.stat(f).st_mtime
        except OSError:
            continue
        if m >= since - 5:
            rows.append((m, f))
    return next((f for _, f in sorted(rows, reverse=True)[:40] if _same_message(_transcript_user_text(f), message)), "")


def own_title(kind, path, sid=""):
    """The title the agent gave its conversation so far, or "" (its adapter reads it: Claude Code's ai-title record,
    Codex's thread name). Agents that name their conversations themselves do it a few seconds after the first message;
    the summary model names every session, these titles are only the fallback when the model gives nothing."""
    return E.get(kind).own_title(path, sid, HOME)


def short_enough(title, cjk_limit=10, word_limit=4):
    """Short enough to name a conversation as is: up to ~10 Chinese characters or 4 English words."""
    import summarize as S
    t = " ".join(str(title or "").split())
    if any(S._is_cjk(ch) for ch in t):
        return sum(1 for ch in t if S._is_cjk(ch)) <= cjk_limit and len(t) <= cjk_limit * 2
    return len(t.split(" ")) <= word_limit


def pick_short_name(own, message, limit):
    """(name, source): the agent's own title as is when it is already short ("agent"), else the
    summary model's few words for that title or, failing that, for the first message ("model")."""
    import summarize as S
    if own and S.clean_name(own) == own and short_enough(own):
        return own, "agent"
    name = S.short_name(own, limit) if own else ""
    if not name:
        name = S.short_name(message, limit)
    return name, "model"


def name_session(key, message, path="", timeout=None, title_wait=180, poll=2.0):
    """A short name for a conversation that runs in Dispatch's in-app chat. `claude -p` never writes an ai-title, so a Claude chat is
    usually named by the model; an agent that names its thread after the first turn (Codex) waits
    up to `title_wait` seconds for that name first. A model's name becomes the conversation's title
    in Dispatch (unless the person already named it). Returns {name, source, saved}."""
    import summarize as S
    from activity import session_preferences, set_preferences
    res = {"key": key, "name": "", "source": "", "saved": False}
    if (session_preferences(DISPATCH_DIR).get(key) or {}).get("title_override"):
        return res
    agent, _, sid = key.partition(":")
    eng = E.get(agent)
    own = own_title(agent, path) if path and not eng.titles_after_turn else ""
    if eng.titles_after_turn:  # it names its thread after the first turn (Codex): wait for that name
        deadline = time.monotonic() + title_wait
        while True:
            own = own_title(agent, path, sid)
            if own or time.monotonic() >= deadline:
                break
            time.sleep(poll)
    # A resumed chat: its first message names it, not the one that just resumed it.
    message = (_transcript_user_text(path) if path else "") or message
    name, source = pick_short_name(own, (message or "")[:NAMER_MESSAGE_CHARS], S.NAME_TIMEOUT if timeout is None else timeout)
    res.update(name=name, source=source if name else "")
    # An own title that is already short is what Dispatch shows anyway; only a model name is stored.
    if name and source == "model" and not (session_preferences(DISPATCH_DIR).get(key) or {}).get("title_override"):
        set_preferences(DISPATCH_DIR, key, {"title_override": name})
        res["saved"] = True
    return res


def home_relative(cwd, host=None):
    """`~/…` for a folder under that Mac's home (host None = this Mac), so another Mac can expand it
    under its own home (dispatch move keeps home-relative paths); other folders as given."""
    home = HOME if host is None else ("/Users/" + host["ssh"].split("@")[0] if "@" in host.get("ssh", "") else "")
    home = home.rstrip("/\\")
    if home and (cwd == home or cwd.startswith(home + "/") or (host is None and P.IS_WIN and cwd.startswith(home + "\\"))):
        return "~" + cwd[len(home):].replace("\\", "/")
    return cwd


def agent_start_argv(a, host_id, cwd):
    """`dispatch --host <id> agent start …` repeating this call's options, for proxy_to_host."""
    argv = ["--host", host_id, "agent", "start", a.kind]
    for key in ("label", "model", "task", "resume", "prompt", "extra", "timeout", "lines"):
        value = getattr(a, key, None)
        if value is not None and value != "":
            argv.append(f"--{key}={value}")
    if cwd:
        argv.append(f"--cwd={cwd}")
    if not getattr(a, "wait", True): argv.append("--no-wait")
    if getattr(a, "auto", False): argv.append("--auto")
    if getattr(a, "json", False): argv.append("--json")
    return argv


# 派活 and every other Agent Dispatch starts run as in-app chats: chatd on the Mac that owns the
# project drives the official CLI (`claude -p` / `codex app-server`). The engines it drives are E.runnable().
def chat_engine(name):
    """The engine `name` means when chatd can drive it (claude and claude-code are one), else None."""
    eng = E.find(name or "")
    return eng if eng and eng.runnable else None


def agent_host_argv(host_id):
    """This `dispatch agent …` call as `--host <id> agent …` (its own --host dropped), for proxy_to_host."""
    argv, skip = [], False
    for x in sys.argv[1:]:
        if skip:
            skip = False
        elif x == "--host":
            skip = True
        elif not x.startswith("--host="):
            argv.append(x)
    return ["--host", host_id] + argv


def chat_client():
    import chat_client as CC
    try:
        return CC.ChatClient.connect(DISPATCH_DIR)
    except CC.NotRunning as e:
        raise SystemExit(str(e))


def chat_target(c, target):
    """chatd session key for a target: a session key, a session id (or its start), the label or the
    task of a session chatd holds, or a known transcript of Claude / Codex / OpenCode (opened again, resumed)."""
    if not target:
        raise SystemExit(L.t("Name a session: its id, label or task id (see dispatch agent list)", "要给会话：会话 ID、标签或任务 ID（dispatch agent list 看）"))
    rows = c.request("list")["sessions"]
    for test in (lambda r: r["session"] == target,
                 lambda r: r["session"].split(":", 1)[-1].startswith(target),
                 lambda r: target in (r.get("task"), r.get("label")),
                 lambda r: target in (r.get("label") or "")):
        hit = [r for r in rows if test(r)]
        if hit:
            return hit[0]["session"]
    refs = [r for r in resolve(load_index(), target) if chat_engine(r["agent"])]
    if not refs:  # a conversation newer than the index (e.g. one chatd ran a minute ago)
        refs = [r for r in resolve(refresh_index(), target) if chat_engine(r["agent"])]
    if not refs:
        raise SystemExit(L.t(f"Dispatch has no session {target} (dispatch agent list shows the open ones)", f"Dispatch 里没有 {target} 这个会话（dispatch agent list 看开着的）"))
    ref = refs[0]
    return c.request("open", agent=ref["agent"], cwd=ref.get("cwd") or HOME, resume=ref["session_id"], timeout=120)["session"]


def permission_what(e):
    """What a permission_request asks for: the tool and what it touches (`Write · /p/a.txt`)."""
    name, summary, path = e.get("tool_name") or "", e.get("summary") or "", (e.get("diff") or {}).get("path") or ""
    parts = [name] if name else []
    if summary and summary != name:
        parts.append(summary)
    if path and path not in summary:
        parts.append(path)
    return " · ".join(parts)


def chat_turn(c, key, text, wait, timeout_ms):
    """Send `text` to session `key`. With `wait`, follow the turn to its end and return what the
    Agent wrote; otherwise return once the message went out (or was queued behind a running turn)."""
    mid = c.new_id()
    reply = c.request("send", session=key, message_id=mid, text=text, timeout=180)
    res = {"prompt_sent": True, "status": "queued" if reply["ev"] == "queued" else "working", "output": "", "warning": ""}
    if not wait:
        return res
    turn = reply.get("turn_id")
    texts = []

    def mine(e):
        nonlocal turn
        if e.get("session") != key:
            return False
        # Queued behind a running turn: that turn's text and end are not this message's.
        if e["ev"] == "turn_started" and turn is None and e.get("message_id") == mid:
            turn = e.get("turn_id")
        if e["ev"] in ("text_done", "turn_done") and (turn is None or e.get("turn_id") not in (None, turn)):
            return False
        if turn and e.get("turn_id") not in (None, turn):
            return False
        if e["ev"] == "text_done":
            texts.append(e.get("text") or "")
        if e["ev"] == "permission_request":
            res["status"] = "blocked"
            res["warning"] = L.t(f"Waiting for the person to confirm: {permission_what(e)} (allow or deny it in Dispatch)", f"在等人确认：{permission_what(e)}（到 Dispatch 里点允许或拒绝）")[:200]
            return True
        return e["ev"] == "turn_done" or e["ev"] == "closed"

    done = c.wait(mine, timeout_ms / 1000)
    res["output"] = "\n\n".join(t for t in texts if t)
    if done is None:
        res["status"], res["warning"] = "working", L.t(f"The turn did not end within {timeout_ms // 1000} s and the agent is still working; dispatch agent wait {key} waits on", f"{timeout_ms // 1000} 秒内这一轮没结束，Agent 还在做；dispatch agent wait {key} 接着等")
    elif done["ev"] == "turn_done":
        res["status"] = "idle" if done.get("status") == "success" else done.get("status") or "idle"
        if done.get("error"):
            res["warning"] = str(done["error"])[:200]
    elif done["ev"] == "closed":
        res["status"], res["warning"] = "closed", f"Session closed: {done.get('reason') or ''}"
    return res


def last_reply(key, lines):
    """What the Agent wrote since the last user message, from the transcript (works after it closed too)."""
    agent, _, sid = key.partition(":")
    refs = [r for r in resolve(load_index(), sid) if r["agent"] == agent] or [r for r in resolve(refresh_index(), sid) if r["agent"] == agent]
    if not refs:
        return ""
    msgs = read_session_detail(refs[0], limit=60)["messages"]
    tail = []
    for m in reversed(msgs):
        if m.get("role") == "user" and (m.get("text") or "").strip():
            break
        if m.get("role") == "assistant" and (m.get("text") or "").strip():
            tail.append(m["text"])
    text = "\n\n".join(reversed(tail))
    return "\n".join(text.splitlines()[-lines:]) if lines else text


def cmd_agent(a):
    if getattr(a, "timeout", None) is not None:
        a.timeout = timeout_to_ms(a.timeout, default_ms=120000, floor_ms=15000)  # milliseconds; a small number is seconds
    if a.op == "run":
        import agents_defs
        return agents_defs.cmd_run(a, out)
    host = target_host(a.host)
    if host is not None and a.op != "start":
        return proxy_to_host(agent_host_argv(host["id"]))
    where = local_host_name()
    if a.op == "keys":
        raise SystemExit(L.t("An in-app chat has no terminal keys: to answer, dispatch agent ask <session> \"…\"; confirmations are clicked in Dispatch", "应用内对话没有终端按键：要回答就 dispatch agent ask <会话> \"…\"，确认框到 Dispatch 里点"))

    if a.op == "start":
        kind = a.kind or ""
        if not chat_engine(kind):
            raise SystemExit(f"Dispatch supports {E.join_words(e.short_name for e in E.runnable())} (received {kind or 'no engine'}): "
                             f"dispatch agent start {'|'.join(e.id for e in E.runnable())}")
        kind = chat_engine(kind).id
        actor = E.agent_of(kind)
        cwd = a.cwd
        if cwd and host is None:
            cwd = os.path.abspath(os.path.expanduser(cwd))
        if not cwd and host is None:
            # From the app there is no meaningful "current directory": use the task's project folder, else home.
            if a.task:
                issue = bd_json(["show", a.task, "--json"])
                cwd = task_project_dir(issue) if issue.get("id") else ""
                if cwd == os.getcwd() and not any(l.startswith("project:") for l in issue.get("labels") or []):
                    cwd = HOME
            cwd = cwd or (os.getcwd() if sys.stdin.isatty() else HOME)
        if host is not None:
            # A folder under this Mac's home (dispatch discuss --host passes the task's project folder) is the same place under that Mac's.
            cwd = home_relative(cwd) if cwd else cwd
            remote_home = "/Users/" + host["ssh"].split("@")[0] if "@" in host.get("ssh", "") else ""
            cwd = (cwd or remote_home).replace("~", remote_home, 1) if remote_home else (cwd or "~")
        # 派活 runs on the project's own Mac: a peer runs the same command there with its own CLI;
        # when this Mac is the owner, a start aimed at a peer comes back here.
        owner = owner_elsewhere(cwd, host)
        if owner and owner["here"]:
            cwd = os.path.abspath(os.path.expanduser(home_relative(cwd, host)))
            host = None
        elif owner and owner["peer"]:
            print(L.t(f"Project {owner['project']} belongs to {owner['host']}: starting it there.", f"项目 {owner['project']} 归「{owner['host']}」，派到 {owner['host']} 上起。"), file=sys.stderr)
            return proxy_to_host(agent_start_argv(a, owner["peer"]["id"], home_relative(cwd, host)))
        elif owner:
            raise SystemExit(owner_refusal(owner))
        if host is not None:
            return proxy_to_host(agent_start_argv(a, host["id"], home_relative(cwd, host)))
        if not os.path.isdir(cwd):
            raise SystemExit(f"Folder does not exist: {cwd}")
        opts = {}
        if a.model:
            opts["model"] = a.model
        if a.auto or a.task:
            opts["permission_mode"] = "bypassPermissions"
        extra = (a.extra or "").split()
        if "--effort" in extra and extra.index("--effort") + 1 < len(extra):
            opts["effort"] = extra[extra.index("--effort") + 1]
        elif extra:
            print(L.t(f"An in-app chat takes no extra command-line arguments; ignored: {a.extra}", f"应用内对话不接受额外的命令行参数，忽略：{a.extra}"), file=sys.stderr)
        if a.task:
            opts["task"] = a.task
        if getattr(a, "resume", None):
            opts["resume"] = a.resume
            if os.environ.get("DISPATCH_MOVE"):
                opts["moving"] = True
        label = a.label or ""
        if a.prompt and auto_name_wanted(label, a.prompt):
            import summarize as S
            label = S.fallback_name(a.prompt) or label
        if label:
            opts["label"] = label
        with chat_client() as c:
            import chat_client as CC
            try:
                opened = c.request("open", agent=E.get(kind).agent, cwd=cwd, timeout=120, **opts)
            except CC.ChatError as e:
                raise SystemExit(f"Could not start {kind}: {e}")
            key = opened["session"]
            if a.label and label == a.label:  # named by the caller: its title from the start, the namer leaves it
                from activity import set_preferences
                set_preferences(DISPATCH_DIR, key, {"title_override": a.label})
            if a.task:
                claim_for_agent(a.task, actor, L.t(f"Dispatch in-app chat {key} @ {where}, folder {cwd}", f"Dispatch 应用内对话 {key} @ {where}，目录 {cwd}"))
            res = {"host": where, "pane_id": key, "session": key, "tab_id": "", "name": label or key, "kind": kind, "actor": actor,
                   "cwd": ui_path(cwd), "status": "idle", "task": a.task or "", "task_title": "", "output": ""}
            if a.task:
                res["task_title"] = bd_json(["show", a.task, "--json"]).get("title") or ""
            if a.prompt:
                try:
                    res.update(chat_turn(c, key, a.prompt, a.wait, a.timeout))
                except CC.ChatError as e:
                    res.update(prompt_sent=False, status="stalled", warning=L.t(f"The first message was not sent: {e}", f"第一句话没发出去：{e}")[:200])

        def text(r):
            print(L.t(f"Started {r['kind']} ({r['actor']}) on {r['host']} · {r['session']} · {r['cwd']}", f"已在 {r['host']} 起了 {r['kind']}（{r['actor']}）· {r['session']} · {r['cwd']}") + (L.t(f" · claimed \"{r.get('task_title') or r['task']}\" ({r['task']})", f" · 认领「{r.get('task_title') or r['task']}」（{r['task']}）") if r["task"] else ""))
            if r["output"]:
                print(r["output"].rstrip())
            elif a.prompt:
                print((L.t("Prompt sent", "提示词已发") if r.get("prompt_sent") else r.get("warning", L.t("Not confirmed that the prompt arrived", "未确认提示词送达"))) + L.t(f", status {r['status']}; dispatch agent read {r['session']}", f"，状态 {r['status']}；dispatch agent read {r['session']}") + (f" --host {a.host}" if a.host else "") + L.t(" shows the output", " 看输出"))
        return out(res, a.json, text)

    if a.op in ("switch", "model"):
        import agent_switch
        return agent_switch.cmd(a)

    import chat_client as CC
    with chat_client() as c:
        if a.op == "list":
            rows = [{"pane_id": r["session"], "session": r["session"], "agent": getattr(chat_engine(r["session"].split(":", 1)[0]), "id", ""),
                     "status": r.get("lifecycle"), "title": r.get("label") or "", "task": r.get("task") or "", "cwd": r.get("cwd") or "", "host": where}
                    for r in c.request("list")["sessions"]]

            def text(rows):
                for r in rows:
                    print(f"{(r['title'] or r['session'])[:48]:<48} {r['agent']:<7} {r['status'] or '':<10} {(r['cwd'] or '').replace(HOME, '~')}  （{r['session']}）")
                if not rows:
                    print(L.t(f"No agent is open in Dispatch on {where}", f"{where} 的 Dispatch 里没有开着的 Agent"))
            return out(rows, a.json, text)
        try:
            key = chat_target(c, a.target)
            if a.op == "ask":
                if not a.text:
                    raise SystemExit(L.t("Give it a message: dispatch agent ask <session> \"…\"", "要给一句话：dispatch agent ask <会话> \"…\""))
                r = chat_turn(c, key, a.text, a.wait, a.timeout)
                res = {"host": where, "pane_id": key, "session": key, "status": r["status"], "warning": r["warning"], "output": r["output"]}
                return out(res, a.json, lambda x: print((x["output"].rstrip() + ("\n[!] " + x["warning"] if x["warning"] else "")) if x["output"] else L.t(f"Sent, status {x['status']}", f"已发，状态 {x['status']}") + (L.t(f"; {x['warning']}", f"；{x['warning']}") if x["warning"] else "")))
            if a.op == "read":
                return out({"host": where, "pane_id": key, "session": key, "output": last_reply(key, a.lines)}, a.json, lambda x: print(x["output"].rstrip()))
            if a.op == "wait":
                state = next((r for r in c.request("list")["sessions"] if r["session"] == key), {})
                status = state.get("lifecycle") or "stopped"
                if status in ("waiting_permission", "waiting_input"):  # already asking: no new permission_request will come
                    status = "blocked"
                elif status in ("running", "starting"):
                    e = c.wait(lambda e: e.get("session") == key and e["ev"] in ("turn_done", "closed", "permission_request"), a.timeout / 1000)
                    status = "working" if e is None else {"turn_done": "idle", "closed": "closed", "permission_request": "blocked"}[e["ev"]]
                return out({"host": where, "pane_id": key, "session": key, "status": status}, a.json, lambda x: print(L.t(f"{x['session']} is {x['status']} now", f"{x['session']} 现在 {x['status']}")))
            if a.op == "close":
                c.request("close", session=key, timeout=30)
                return out({"closed": key}, a.json, lambda x: print(L.t(f"Closed {x['closed']}", f"已关 {x['closed']}")))
        except CC.ChatError as e:
            raise SystemExit(str(e))


def cmd_serve(a):
    import runpy
    what = getattr(a, "what", "run")
    args = ["url"] if what == "url" else (["qr"] + (["--svg"] if getattr(a, "svg", False) else [])) if what == "qr" else []
    if what in ("install", "uninstall", "status"):
        args = [what] + (["--lan"] if getattr(a, "lan", False) else []) + (["--no-lan"] if getattr(a, "no_lan", False) else []) + (["--json"] if getattr(a, "json", False) else [])
    if what == "login-link":
        args = ["login-link", "--ttl", str(getattr(a, "ttl", 300) or 300)] + (["--to", a.to] if getattr(a, "to", "") else [])
    if what == "host":
        args = ["host"] + ([a.target] if getattr(a, "target", None) else []) + (["--json"] if getattr(a, "json", False) else [])
    sys.argv = ["serve"] + args
    runpy.run_path(os.path.join(os.path.dirname(os.path.realpath(__file__)), "serve.py"), run_name="__main__")


def cmd_hosts(a):
    if getattr(a, "op", None) in ("discover", "add", "set", "remove"):
        sys.exit(_host_admin().command(a))  # Add a device / Manage devices in Dispatch IDE
    if getattr(a, "op", None) == "rename":
        if len(a.args) != 2:
            raise SystemExit(L.t("Usage: dispatch hosts rename <id|local|name> <new name>", "用法：dispatch hosts rename <id|local|名字> <新名字>"))
        target, name = a.args
        import init_wizard as W
        if target in ("local", "本机") or target == local_host_name() or target in local_host_aliases():
            res = W.rename_self(name)  # writes self-name.json and pushes to every peer's hosts.json
        else:
            hid = resolve_host_id(target)
            if not hid:
                raise SystemExit(L.t(f"No {target} in hosts.json", f"hosts.json 里没有 {target}"))
            h = next(x for x in hosts() if x["id"] == hid)
            import shlex
            r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", h["ssh"], f"env {remote_beads(h)} {h.get('dispatch', 'dispatch')} init rename-self {shlex.quote(name)} --json"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60, creationflags=P.no_window_flags())
            remember_peer_name(hid, name.strip()[:60])  # the push back may not reach us; keep our copy right anyway
            _host_admin().sync_config_quietly()  # its SSH alias follows the name
            res = {"name": name.strip()[:60], "host": hid, "remote_ok": r.returncode == 0}
        if res.get("error"):
            raise SystemExit(res["error"])
        return out(res, a.json, lambda r: print(L.t(f"Renamed to {r['name']}", f"已改名为 {r['name']}") + (L.t(f", synced to {', '.join(r['pushed'])}", f"，已同步到 {'、'.join(r['pushed'])}") if r.get("pushed") else "") + (L.t(f"; not synced to {', '.join(r['failed'])} (dispatch hosts catches up once it is online)", f"；没同步到 {'、'.join(r['failed'])}（它上线后 dispatch hosts 会自动对齐）") if r.get("failed") else "")))
    refresh = getattr(a, "refresh", "")
    if refresh:
        for p in glob.glob(os.path.join(REMOTE_DIR, f"{refresh}.down")) + glob.glob(os.path.join(REMOTE_DIR, f"{refresh}--*.json")):
            try:
                os.remove(p)
            except OSError:
                pass
    rows = host_rows(local_only=getattr(a, "local", False))

    def text(rows):
        for r in rows:
            have = [k for k in ("novnc_up", "screen_sharing", "rustdesk", "sunshine", "uu") if r.get(k)]
            ov = (r.get("overlay") or {}).get("kind") or "-"
            print(f"{r['name']:<12} {r['ip']:<16} {L.t('online', '在线') if r['online'] else L.t('offline', '离线')}  {L.t('net', '网')}:{ov:<10} {L.t('has', '有')}:{','.join(have) or L.t('none', '无'):<36} {L.t('suggested', '推荐')}:{r.get('recommend') or L.t('none', '无')}  {r.get('why', '')}")
    out(rows, a.json, text)


def cmd_screen(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import screen_setup
    screen_setup.main(a)


def _only_theirs(rows):
    """A host answers with its own sessions only; anything it merged from *other* hosts
    (including ours, mirrored back) is dropped, otherwise two Macs amplify each other."""
    return [r for r in rows or [] if isinstance(r, dict) and r.get("agent") not in RETIRED_AGENTS and not r.get("remote") and r.get("host") in (None, "local")]


def remote_sessions():
    out = []
    for h in hosts():
        for s in _tag_host(_only_theirs(remote_dispatch(h, ["sessions", "--local"], 20)), h):
            s["remote"] = True
            out.append(s)
    return out


def remote_refs():
    out = []
    for h in hosts():
        for r in _tag_host(_only_theirs(remote_dispatch(h, ["list", "--cached", "--limit", "200", "--local"], 120)), h):
            r["remote"] = True
            r["resume_cmd"] = f"ssh -t {h['ssh']} {json.dumps(r.get('resume_cmd', ''))}"
            r["path"] = f"remote:{h['id']}:{r.get('path', '')}"
            out.append(r)
    return out


def live_sessions(local_only=False):
    table = ps_table()
    sessions = [s for e in E.known() for s in e.live_sessions(table)]  # the engines without hooks: from their process
    seen = set()
    seen_sids = set()
    for p in glob.glob(os.path.join(SESS_DIR, "*.json")):
        try:
            r = json.load(open(p, encoding="utf-8"))
        except Exception:
            continue
        if r.get("agent") in RETIRED_AGENTS:
            continue
        pid = r.get("agent_pid")
        if pid and pid not in table:
            continue
        r["alive"] = True
        r["registered"] = True
        seen.add(pid)
        seen_sids.add((r.get("agent"), r.get("session_id")))
        sessions.append(r)
    reconcile_with_transcripts(sessions)
    idx = None
    node_cmds = None
    for pid, (ppid, comm) in table.items():
        base = _exe(comm).lstrip("-")
        if P.IS_WIN and base == "node" and pid not in seen:
            # npm installs run as node.exe; the package path in the command line says which agent.
            node_cmds = P.process_cmdlines() if node_cmds is None else node_cmds
            cl = P.to_slash(node_cmds.get(pid) or "")
            base = next((e.bin for e in E.known() if e.hook_presence and e.package and e.package in cl), base)
        stray = E.find(base)
        if stray and stray.hook_presence and pid not in seen:
            # No hook wrote a record (another person's terminal, hooks not installed): still
            # say where it runs and which transcript it most likely is, so it can be adopted.
            cwd = pid_cwd(pid)
            kind, app = host_of(pid, table)
            idx = idx if idx is not None else (load_index() or {})
            row = {"agent": stray.agent, "session_id": f"pid-{pid}", "agent_pid": pid, "cwd": cwd, "project": os.path.basename(cwd.rstrip("/\\")) if cwd else "", "source_kind": kind, "source_app": app, "state": "unknown", "alive": True, "registered": False, "started_at": 0, "last_at": 0}
            guess = probable_session(idx, row["agent"], cwd)
            if guess:
                row["probable_session_id"] = guess["session_id"]; row["title"] = guess.get("title", ""); row["last_at"] = guess.get("mtime", 0)
            sessions.append(row)
    from activity import in_session_root, session_root
    if session_root():
        sessions = [s for s in sessions if in_session_root(s.get("cwd"))]
    merge_ide_sessions(sessions)
    for s in sessions:
        s.setdefault("host", "local")
        s.setdefault("host_name", local_host_name())
    annotate_moves(sessions)
    if not local_only:
        sessions.extend(remote_sessions())
    sessions.sort(key=lambda s: (s.get("state") != "working", -(s.get("last_at") or 0)))
    return sessions


def merge_ide_sessions(sessions):
    """Sessions of the Agents window (Dispatch IDE / VS Code agent host, ide_sessions.py) join the
    list as `source: "ide"` rows; one the hooks also saw takes the Agent Host's title and status.
    The catalog is not a public contract: any failure leaves the list as it was."""
    try:
        I = _mod("ide_sessions")
        I.merge(sessions, I.scan())
    except Exception as e:
        debug("merge_ide_sessions", e)


def reconcile_with_transcripts(sessions):
    """Hooks miss the end of an interrupted turn (Esc, a closed picker): the record stays
    'working' for hours while the transcript shows the reply finished. When the transcript's
    last word is idle and at least as recent as the hook's, the transcript wins."""
    from activity import transcript_states
    stuck = [s for s in sessions if s.get("registered") and s.get("state") == "working" and s.get("state_source") == "hook"]
    if not stuck:
        return
    try:
        states = transcript_states(DISPATCH_DIR, [s["session_id"] for s in stuck])
    except Exception:
        return
    for s in stuck:
        state, last_at = states.get(s["session_id"], ("", 0))
        if state == "idle" and last_at >= (s.get("last_at") or 0) - 120:
            s["state"], s["attention"], s["state_source"] = "idle", None, "transcript"


def pid_cwd(pid):
    """Working directory of a process (lsof; ~50 ms, only used for unregistered agents). Windows has
    no lsof: the row goes without a cwd."""
    return P.pid_cwd(pid)


# Where a conversation was started, in one vocabulary for every agent: the transcript index and
# the phone/desktop views show it as 终端 / 桌面端 / VS Code / SDK / 定时任务. Claude Code writes
# `entrypoint` on every record ("cli", "claude-desktop", "claude-vscode", "sdk-cli"…); Codex writes
# `originator` + `source` once, in session_meta ("codex_vscode"/"vscode", "Codex Desktop", "codex_exec"…).
ORIGIN_V = 2  # bump to re-derive every Codex row's origin from its session_meta
ORIGIN_ALIASES = {"claude-desktop": "desktop", "claude-vscode": "vscode", "vscode-extension": "vscode", "codex_vscode": "vscode",
                  "codex desktop": "desktop", "codex_work_desktop": "desktop", "codex_exec": "exec", "exec": "exec",
                  "codex-tui": "cli", "codex_cli_rs": "cli", "codex-cli": "cli", "terminal": "cli"}


def origin_of(*raw):
    """The first non-empty value among `raw` (a Claude `entrypoint`, a Codex `source`, a Codex
    `originator`), mapped to the shared vocabulary; unknown values pass through as they are."""
    for v in raw:
        if not v:
            continue
        if isinstance(v, dict):
            # Codex writes `source: {"subagent": {...}}` on threads another Codex spawned.
            return "subagent" if "subagent" in v else ""
        v = str(v).strip()
        return ORIGIN_ALIASES.get(v.lower(), v)
    return ""


def host_of(pid, table):
    """(source_kind, label) of the app hosting a bare agent process — the same classifier the
    hooks use, so a `claude` the VS Code extension spawned reads as VS Code, not as a terminal."""
    chain, p = [], pid
    for _ in range(30):
        ent = table.get(p)
        if not ent:
            break
        ppid, comm = ent
        chain.append(comm)
        if ppid <= 1:
            break
        p = ppid
    if P.IS_WIN:
        label, _ = win_host_app_of(pid, table)
        kinds = {"VS Code": "editor", "Cursor": "editor", "Windsurf": "editor", "Claude 桌面端": "desktop", "Codex 桌面端": "desktop"}
        return (kinds.get(label, "terminal"), label) if label else ("unknown", "未登记")
    kind, label = _mod("presence").classify(chain)
    if (kind, label) == ("terminal", "终端"):
        app = host_app_of(pid, table)
        return ("terminal", app) if app else ("unknown", "未登记")
    return kind, label


def probable_session(idx, agent, cwd, within=6 * 3600):
    """The transcript an unregistered live process is most likely writing: same agent and
    directory, touched recently. A guess — callers say so."""
    if not cwd:
        return None
    now = time.time()
    cands = [e for e in idx.values() if e.get("agent") == agent and not e.get("subagent") and e.get("cwd") == cwd and now - (e.get("mtime") or 0) < within]
    return max(cands, key=lambda e: e.get("mtime") or 0) if cands else None


def cmd_sessions(a):
    if getattr(a, "op", None) == "history":
        H = _mod("session_history")
        H.D = sys.modules[__name__]
        res = H.command(a)
        out(res, a.json, H.text)
        return
    s = live_sessions(local_only=getattr(a, "local", False))
    # The files each session touched, from the hook registry only: cheap enough for the
    # 5-second presence poll, and it covers agents the transcript index does not parse.
    edits = session_edit_map(window=30 * 60, with_activity=False)
    for x in s:
        if x.get("host") not in (None, "local"):
            continue  # a peer's copy of the same id reports its own edits
        rec = edits.get(x.get("session_id"))
        if rec and rec["files"]:
            x["editing"] = [{"path": f, "ts": ts} for f, ts in sorted(rec["files"].items(), key=lambda kv: -kv[1])]

    def text(s):
        if not s:
            print(L.t("No sessions found", "没有检测到会话"))
        for x in s:
            st = L.t("to confirm", "等确认") if x.get("attention") == "input" and x.get("state") != "working" else {"working": L.t("working", "在跑"), "idle": L.t("waiting", "等你"), "unknown": L.t("unknown", "未登记")}.get(x.get("state"), x.get("state"))
            title = x.get("title") or ""
            name = L.t(f"\"{title}\" ({x['session_id'][:8]})", f"「{title}」（{x['session_id'][:8]}）") if title else x["session_id"]
            moved = L.t(f"  moved to {x['moved_to_name']}", f"  已迁往 {x['moved_to_name']}") if x.get("moved_to") else L.t(f"  moved here from {x['moved_from_name']}", f"  从 {x['moved_from_name']} 迁来") if x.get("moved_from") else ""
            print(f"{x['agent']:<12} {st:<4} {x.get('project') or '?':<18} {x.get('host_name') or '':<14} {x.get('source_app', ''):<8} {ago(x.get('last_at'))!s:<5} {name}" + moved)
    out(s, a.json, text)


# ---------------------------------------------------------------- transcript index

def task_prefix():
    try:
        return json.load(open(os.path.join(BEADS_DIR, "metadata.json"), encoding="utf-8")).get("dolt_database", "task")
    except Exception:
        return "task"


def _read_index():
    try:
        with open(INDEX_FILE, encoding="utf-8") as f:
            return {path: row for path, row in json.load(f).items()
                    if row.get("agent") not in RETIRED_AGENTS}
    except Exception:
        return {}


def in_session_root_only(idx):
    """The index rows a session root (DISPATCH_SESSION_ROOT, activity.session_root) lets through."""
    from activity import in_session_root, session_root
    root = session_root()
    return {p: e for p, e in idx.items() if in_session_root(e.get("cwd"), root)} if root else idx


def load_index():
    return in_session_root_only(_read_index())


def codex_home():
    return os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")


def save_index(idx):
    os.makedirs(DISPATCH_DIR, exist_ok=True)
    tmp = INDEX_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False)
    P.replace_retry(tmp, INDEX_FILE)




def first_prompt_of(agent, buf):
    """The user's opening message — what this conversation was about, in their words (its adapter reads the records)."""
    eng = E.get(agent)
    pos = 0
    for _ in range(400):  # the first 400 lines, without copying the rest of a big buffer
        nl = buf.find("\n", pos)
        line = buf[pos:] if nl < 0 else buf[pos:nl]
        pos = len(buf) if nl < 0 else nl + 1
        # Skip non-user records cheaply, including transcripts with JSON whitespace.
        if not line.startswith("{") or '"user"' not in line:
            if nl < 0:
                break
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        txt = eng.first_prompt(d) if isinstance(d, dict) else None
        if txt is None:
            continue
        txt = re.sub(r"<[^>]{1,40}>[\s\S]*?</[^>]{1,40}>", "", txt).strip()
        if txt and not txt.startswith("<") and not txt.startswith("[Image"):
            return txt[:240]
    return ""


STATS_V = 4  # bump to force a full re-parse when the per-session stats shape changes

# A skill is "used" when the agent opens its SKILL.md. Codex has no Skill tool: it expands the
# skills listed in its system prompt (r0/task-board/SKILL.md) and cats the file. ZCode does have a
# Skill tool. Both spellings end in skills/<name>/SKILL.md, whatever the root (pool, .agents, plugins).
RE_SKILL_FILE = re.compile(r'skills/(?:[^/"\s]+/)*([^/"\s]+)/SKILL\.md')


def stats_fields():
    return {"tokens": {"in": 0, "out": 0, "cr": 0, "cw": 0, "think": 0}, "models": {}, "days": {}, "hours": {}, "skills": {}, "subs": {}, "last_req": "", "codex_prev": 0}


def bump_time(e, dt, msgs=0, tok=0, parts=None):
    """Attribute activity to the local day and to the weekday×hour bucket."""
    if dt is None:
        return
    day = dt.strftime("%Y-%m-%d")
    d = e["days"].setdefault(day, [0, 0, 0, 0, 0, 0])  # msgs, tokens, in, out, cache_read, cache_write
    d[0] += msgs
    d[1] += tok
    if parts:
        for i, v in enumerate(parts):
            d[2 + i] += v
    if msgs:
        k = f"{dt.weekday()}-{dt.hour}"
        e["hours"][k] = e["hours"].get(k, 0) + msgs


def local_dt(ts):
    from datetime import datetime as _dt
    try:
        return _dt.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
    except Exception:
        return None


def local_dt_ms(ms):
    from datetime import datetime as _dt
    try:
        return _dt.fromtimestamp(ms / 1000)
    except Exception:
        return None


def parse_zcode_stats(e, sid, agent="zcode"):
    for m in zcode_query("select data, time_created from message where session_id=?", (sid,), agent=agent):
        try:
            d = json.loads(m["data"])
        except Exception:
            continue
        tok = 0
        if d.get("role") == "assistant":
            tk = d.get("tokens") or {}
            c = tk.get("cache") or {}
            i, o, cr, cw, th = tk.get("input", 0) or 0, tk.get("output", 0) or 0, c.get("read", 0) or 0, c.get("write", 0) or 0, tk.get("reasoning", 0) or 0
            T = e["tokens"]
            T["in"] += i; T["out"] += o; T["cr"] += cr; T["cw"] += cw; T["think"] += th
            tok = i + o + cr + cw
            mid = d.get("modelID")
            if mid:
                e["models"][mid] = e["models"].get(mid, 0) + 1
            bump_time(e, local_dt_ms(m["time_created"]), 1, tok, (i, o, cr, cw))
        else:
            bump_time(e, local_dt_ms(m["time_created"]), 1, 0)
    for r in zcode_query("select json_extract(data,'$.state.input.skill') sk from part where session_id=? and json_extract(data,'$.type')='tool' and json_extract(data,'$.tool')='Skill'", (sid,), agent=agent):
        if r["sk"]:
            e["skills"][r["sk"]] = e["skills"].get(r["sk"], 0) + 1


# Transcripts left by Dispatch's own headless `claude -p` runs (session / project summaries, before they were
# started with --no-session-persistence): one prompt beginning with the summarizer's system text.
INTERNAL_PROMPTS = ("你是会话记录的总结者", "你是项目记录的总结者", "You summarize a coding session's record", "You summarize a project's record")


def _internal_run(e):
    # `claude -p` writes entrypoint sdk-cli: one of Dispatch's own runs when it starts with one of its prompts
    return e.get("entrypoint") == "sdk-cli" and (e.get("first_prompt") or "").startswith(INTERNAL_PROMPTS)


# ---- transcript index build --------------------------------------------------------------------
# The first build reads every transcript (about 9 GB on a busy Mac), so it is done by helper processes
# (`dispatch index-worker`, one per core, each taking the next file when it finishes one), a big file is read
# a piece at a time, and the builder keeps a small progress file that anything can read: `dispatch index
# --status`, and the Projects page while it draws "Reading your sessions · 1,200 of 2,535".
INDEX_PROGRESS_FILE = os.path.join(DISPATCH_DIR, "index-progress.json")
INDEX_LOCK_FILE = os.path.join(DISPATCH_DIR, "index.lock")
INDEX_START_LOCK_FILE = os.path.join(DISPATCH_DIR, "index-start.lock")
INDEX_CHUNK = max(1024, int(os.environ.get("DISPATCH_INDEX_CHUNK") or (16 << 20)))
INDEX_PARALLEL_BYTES = int(os.environ.get("DISPATCH_INDEX_PARALLEL_BYTES") or (48 << 20))
INDEX_PROGRESS_MIN = 25                # a build of fewer files than this leaves the progress file alone
INDEX_SAVE_EVERY = 4                   # seconds between the partial index files of a long build
INDEX_WAIT_SECONDS = 30                # another build is running: wait this long for it before answering with what it has


def index_progress():
    """State of the transcript index build, from the file the builder keeps up to date:
    {"state": "none" (never built, or nothing worth reporting) | "running" | "done" | "interrupted" (the builder is gone),
     "done", "total" (files and sessions read so far / to read), "started_at", "updated_at", "finished_at", "pid",
     "indexed" (there is an index file: a build that was cut short leaves what it read)}."""
    try:
        with open(INDEX_PROGRESS_FILE, encoding="utf-8") as f:
            rec = json.load(f)
        if not isinstance(rec, dict):
            rec = {}
    except (OSError, ValueError):
        rec = {}
    state = rec.get("state") if rec.get("state") in ("running", "done", "interrupted") else "none"
    if state == "running" and not P.pid_alive(rec.get("pid")):
        state = "interrupted"
    return {"state": state, "done": int(rec.get("done") or 0), "total": int(rec.get("total") or 0),
            "started_at": rec.get("started_at") or 0, "updated_at": rec.get("updated_at") or 0,
            "finished_at": rec.get("finished_at") or 0, "pid": rec.get("pid") or 0, "indexed": os.path.exists(INDEX_FILE)}


def index_start_background():
    """Start the index build in a process of its own unless one is running; returns index_progress(). Nothing waits for
    it: the caller polls index_progress() (or `dispatch index --status`)."""
    with _index_lock(path=INDEX_START_LOCK_FILE) as held:
        cur = index_progress()
        if not held or cur["state"] == "running":
            return cur
        os.makedirs(DISPATCH_DIR, exist_ok=True)
        proc = P.spawn_detached([sys.executable, os.path.realpath(__file__), "index", "--json"], stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        # The child's first progress write takes this same lock. Even an empty build
        # cannot finish before this record and then be overwritten as running.
        _index_progress_write({"state": "running", "done": 0, "total": 0, "started_at": time.time(), "updated_at": time.time(), "pid": proc.pid})
        return index_progress()


def index_ensure():
    """What a page that needs the index calls: nothing to do while an index exists and no build was cut short; otherwise
    the build is started in the background. Returns index_progress() when a build is (now) running, else None."""
    cur = index_progress()
    if cur["state"] == "running":
        return cur
    if not cur["indexed"] or cur["state"] == "interrupted":
        if cur["state"] == "interrupted" and time.time() - cur["updated_at"] < 60:
            return cur  # Show the interruption during the retry backoff.
        return index_start_background()
    return None


def _index_progress_write(rec):
    try:
        os.makedirs(DISPATCH_DIR, exist_ok=True)
        tmp = f"{INDEX_PROGRESS_FILE}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(rec, f)
        P.replace_retry(tmp, INDEX_PROGRESS_FILE)
    except OSError as e:
        debug("index progress", e)


class _IndexProgress:
    """The builder's side of index_progress(): counts what is read and rewrites the file (at most every 0.4 s)."""

    def __init__(self, total):
        import threading
        self.total, self.done, self.started, self.last = total, 0, time.time(), 0.0
        self.lock = threading.Lock()
        with _index_lock(path=INDEX_START_LOCK_FILE):
            cur = index_progress()
            self.on = total >= INDEX_PROGRESS_MIN or (cur["state"] == "running" and cur["pid"] == os.getpid())
            self.write("running")

    def write(self, state):
        if not self.on:
            return
        now = time.time()
        rec = {"state": state, "done": self.done, "total": self.total, "started_at": self.started, "updated_at": now, "pid": os.getpid()}
        if state != "running":
            rec["finished_at"] = now
        _index_progress_write(rec)
        self.last = now

    def tick(self):
        with self.lock:
            self.done += 1
            if time.time() - self.last >= 0.4:
                self.write("running")

    def finish(self, state):
        with self.lock:
            self.write(state)


def _index_lock(path=None):
    """Held while the index is built: one builder at a time (a second `dispatch list` while the first build runs would
    read every transcript again). A context manager giving True when this process holds it, False when another kept it
    for INDEX_WAIT_SECONDS. Windows has no lock: every caller builds."""
    import contextlib

    @contextlib.contextmanager
    def held():
        try:
            import fcntl
            os.makedirs(DISPATCH_DIR, exist_ok=True)
            lock = open(path or INDEX_LOCK_FILE, "a")
        except (ImportError, OSError):
            yield True
            return
        got, t0 = False, time.time()
        try:
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    got = True
                    break
                except OSError:
                    if time.time() - t0 >= INDEX_WAIT_SECONDS:
                        break
                    time.sleep(0.25)
            yield got
        finally:
            lock.close()  # closing releases the lock
    return held()


def _index_rx(prefix):
    """The patterns one transcript is read with (built once per process)."""
    import types
    return types.SimpleNamespace(
        task=re.compile(r"\b" + re.escape(prefix) + r"-[a-z0-9]{2,8}\b"),
        task_tail=re.compile(r"-[a-z0-9]{2,8}\b"),
        prefix=prefix,
        cwd=re.compile(r'"cwd":"([^"]+)"'),
        title=re.compile(r'"aiTitle":"((?:[^"\\]|\\.)*)"'),
        # Commands that work on a task, not just mention it: this session took it over or reported on
        # it. Read from the session's own tool calls only (claims_of), never from tool output.
        claim_id=re.compile(r"^" + re.escape(prefix) + r"-[a-z0-9]{2,8}$"),
        entry=re.compile(r'"entrypoint":"([^"]+)"'),
        branch=re.compile(r'"gitBranch":"([^"]*)"'),
        ts=re.compile(r'"timestamp":"([^"]+)"'),
        needle=prefix + "-")


def task_mentions(buf, rx):
    """Every task id written in `buf`, in order: what rx.task.finditer(buf) finds, without the regex engine looking at every
    character (a text search for "task-" first, then the id's own pattern where one is)."""
    prefix, n = rx.prefix, len(rx.prefix)
    needle = prefix + "-"
    pos = 0
    while True:
        i = buf.find(needle, pos)
        if i < 0:
            return
        pos = i + 1
        if i and (buf[i - 1].isalnum() or buf[i - 1] == "_"):
            continue  # not at the start of a word: \b
        m = rx.task_tail.match(buf, i + n)
        if m:
            yield buf[i:m.end()]
            pos = m.end()


def lines_containing(buf, needle):
    """The lines of `buf` (split at newlines) that contain `needle`, each once, without splitting the rest."""
    pos = 0
    while True:
        i = buf.find(needle, pos)
        if i < 0:
            return
        e = buf.find("\n", i)
        e = len(buf) if e < 0 else e
        yield buf[buf.rfind("\n", 0, i) + 1:e]
        pos = e + 1


def _index_row_new(path, agent):
    return {"agent": agent, "session_id": "", "cwd": "", "title": "", "mtime": 0, "size": 0, "off": 0, "tasks": {}, "claims": [], "subagent": "/subagents/" in (P.to_slash(path) if P.IS_WIN else path), "entrypoint": "", "branch": "", "first_ts": "", "last_ts": "", "user_msgs": 0, "assistant_msgs": 0, "tools": {}, "first_prompt": ""}


def _index_fold(path, agent, e, buf, rx, first):
    """Fold one piece of a transcript (whole lines; `first` when it starts the file) into the session's row."""
    eng = E.get(agent)
    if first:
        eng.index_head(e, buf)
    if not e["cwd"]:
        m = rx.cwd.search(buf)
        if m:
            e["cwd"] = m.group(1)
    for m in rx.title.finditer(buf):
        e["title"] = json.loads('"' + m.group(1) + '"')
    for tid in task_mentions(buf, rx):
        e["tasks"][tid] = e["tasks"].get(tid, 0) + 1
    e["claims"].extend(claims_of(buf, rx.claim_id, rx.needle))
    if not e["entrypoint"]:
        m = rx.entry.search(buf)
        if m:
            e["entrypoint"] = origin_of(m.group(1))
    if not e["first_prompt"]:
        e["first_prompt"] = first_prompt_of(agent, buf)
        if not e["subagent"] and _internal_run(e):
            e["subagent"] = True
    if not e["branch"]:
        m = rx.branch.search(buf)
        if m:
            e["branch"] = m.group(1)
    if not e["first_ts"]:
        m = rx.ts.search(buf)
        if m:
            e["first_ts"] = m.group(1)
    i = buf.rfind('"timestamp":"')
    while i >= 0:  # the last timestamp of the piece: not a list of all of them
        m = rx.ts.match(buf, i)
        if m:
            e["last_ts"] = m.group(1)
            break
        i = buf.rfind('"timestamp":"', 0, i)
    eng.index_fold(e, buf, rx.ts)  # its messages, tools and usage stats
    for m in re.finditer(r'"type":"tool_use","id":"[^"]+","name":"([^"]+)"', buf):
        e["tools"][m.group(1)] = e["tools"].get(m.group(1), 0) + 1


def _index_read_file(path, agent, e, rx):
    """Read what a transcript gained since row `e` last saw it and fold it into `e`. A big file is read a piece at a
    time (whole lines, INDEX_CHUNK bytes), so a 500 MB transcript never sits in memory whole."""
    st = os.stat(path)
    if st.st_size < e["off"]:
        e = {**_index_row_new(path, agent), "stats_v": STATS_V, **stats_fields()}
    if not e["session_id"]:
        E.get(agent).index_session(e, path)
    end, pos, first = st.st_size, e["off"], True
    with open(path, "rb") as f:
        f.seek(pos)
        while True:
            raw = f.read(min(INDEX_CHUNK, max(0, end - pos)))
            pos += len(raw)
            if raw and pos < end and not raw.endswith(b"\n"):
                rest = f.readline(max(0, end - pos))
                raw += rest
                pos += len(rest)
            if raw and pos >= end and not raw.endswith(b"\n"):
                tail = raw.rsplit(b"\n", 1)[-1]
                try:
                    json.loads(tail)
                except (ValueError, UnicodeDecodeError):
                    # A live writer may be halfway through a JSON record. Leave it
                    # for the next refresh, including a split UTF-8 character.
                    raw = raw[:-len(tail)]
                    pos -= len(tail)
                    end = pos
            _index_fold(path, agent, e, raw.decode("utf-8", "replace"), rx, first)
            first = False
            if not raw or pos >= end:
                break
    e["off"], e["mtime"], e["size"] = pos, st.st_mtime, st.st_size
    return e


def cmd_index_worker(a):
    """A helper of the index build (`dispatch index-worker --prefix task`): reads one JSON line {path, agent, row} per
    file from stdin, answers one {row} or {error} line on stdout each. Started by _index_parallel, not by hand."""
    out_fd = os.fdopen(os.dup(1), "w", encoding="utf-8")
    sys.stdout = sys.stderr  # nothing else may write into the answers
    if hasattr(os, "nice"):
        try:
            os.nice(10)  # the app stays responsive while the helpers read
        except OSError:
            pass
    rx = _index_rx(a.prefix)
    for line in sys.stdin:
        try:
            req = json.loads(line)
            ans = {"row": _index_read_file(req["path"], req["agent"], req["row"], rx)}
        except Exception as ex:  # the parent reads this file itself, once, and says what went wrong
            ans = {"error": f"{type(ex).__name__}: {ex}"}
        out_fd.write(json.dumps(ans, ensure_ascii=False) + "\n")
        out_fd.flush()


def _index_parallel(todo, prefix, workers, on_row):
    """Read the (path, agent, row) of `todo` with `workers` helper processes; on_row(path, row) is called as each file is
    done (one at a time). Returns the paths a helper could not read (it died or said no): the caller reads them itself."""
    import queue
    import threading
    work = queue.Queue()
    for item in todo:
        work.put(item)
    failed, lock = [], threading.Lock()

    def helper():
        proc = None
        try:
            proc = subprocess.Popen([sys.executable, os.path.realpath(__file__), "index-worker", "--prefix", prefix],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
                                    env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, creationflags=P.no_window_flags())
            while True:
                try:
                    path, agent, row = work.get_nowait()
                except queue.Empty:
                    return
                try:
                    proc.stdin.write(json.dumps({"path": path, "agent": agent, "row": row}, ensure_ascii=False) + "\n")
                    proc.stdin.flush()
                    ans = json.loads(proc.stdout.readline() or "null")
                except (OSError, ValueError):
                    ans = None
                if isinstance(ans, dict) and isinstance(ans.get("row"), dict):
                    with lock:
                        on_row(path, ans["row"])
                else:
                    with lock:
                        failed.append((path, agent, row))
                    if ans is None:  # the helper is gone: the rest goes to the others
                        return
        except OSError:
            pass
        finally:
            if proc:
                try:
                    proc.stdin.close()
                except OSError:
                    pass
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    debug("index worker", f"terminating pid {proc.pid}")
                    proc.terminate()
                    proc.wait(timeout=5)
                proc.stdout.close()

    threads = [threading.Thread(target=helper, daemon=True) for _ in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    while not work.empty():  # every helper failed to start
        failed.append(work.get_nowait())
    return failed


def index_workers():
    """How many helper processes read transcripts: a couple of cores stay free for the app."""
    try:
        return max(1, min(8, int(os.environ.get("DISPATCH_INDEX_WORKERS") or 0) or (os.cpu_count() or 4) - 2))
    except Exception:
        return 2


def _index_sqlite_row(idx, agent, store, r, rx):
    e = {"agent": agent, "session_id": r["id"], "cwd": r["directory"], "title": r["title"], "mtime": r["time_updated"] / 1000, "size": 0, "off": 0, "tasks": {}, "claims": [], "subagent": False, "entrypoint": store["entrypoint"], "branch": "", "first_ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r["time_created"] / 1000)), "last_ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r["time_updated"] / 1000)), "user_msgs": 0, "assistant_msgs": 0, "tools": {}, "first_prompt": "", "stats_v": STATS_V, **stats_fields()}
    parse_zcode_stats(e, r["id"], agent)
    fp = zcode_query("select p.data from part p join message m on m.id=p.message_id where p.session_id=? and json_extract(m.data,'$.role')='user' and json_extract(p.data,'$.type')='text' order by p.time_created limit 1", (r["id"],), agent=agent)
    if fp:
        try:
            e["first_prompt"] = (json.loads(fp[0]["data"]).get("text") or "").strip()[:240]
        except Exception:
            pass
    for m in zcode_query("select json_extract(data,'$.role') role, count(*) n from message where session_id=? group by role", (r["id"],), agent=agent):
        if m["role"] == "user":
            e["user_msgs"] = m["n"]
        elif m["role"] == "assistant":
            e["assistant_msgs"] = m["n"]
    for t in zcode_query("select json_extract(data,'$.tool') tool, count(*) n from part where session_id=? and json_extract(data,'$.type')='tool' group by tool", (r["id"],), agent=agent):
        if t["tool"]:
            e["tools"][t["tool"]] = t["n"]
    blob = "\n".join(p["data"] for p in zcode_query("select data from part where session_id=? and json_extract(data,'$.type') in ('text','tool')", (r["id"],), agent=agent))
    for m in rx.task.finditer(blob):
        e["tasks"][m.group(0)] = e["tasks"].get(m.group(0), 0) + 1
    e["claims"].extend(claims_of_events((p["data"] for p in zcode_query("select data from part where session_id=? and json_extract(data,'$.type')='tool'", (r["id"],), agent=agent)), rx.claim_id, in_call=True))
    e["size"] = len(blob)
    idx[f"{agent}:{r['id']}"] = e


def refresh_index():
    """Incrementally scan Claude Code / Codex transcripts for task ids, titles, cwd. One builder at a time; a first
    build reports how far it is (index_progress) and saves what it has every few seconds."""
    with _index_lock() as held:
        if not held:
            return in_session_root_only(_read_index())  # another build is still running: what it has so far
        return _refresh_index()


def _refresh_index():
    prefix = task_prefix()
    rx = _index_rx(prefix)
    from activity import folder_may_be_in_root
    files = []
    for eng in E.known():  # the engines that keep JSON-lines transcripts (Claude Code, Codex, pi)
        for p, folder in eng.transcript_files(HOME):
            if not folder or folder_may_be_in_root(folder):
                files.append((p, eng.agent))
    idx = _read_index()
    disk = {path: dict(row) for path, row in idx.items()}  # what the index file says now, for the partial saves of a long build
    seen = set()
    todo = []          # (path, agent, row, size): transcripts with something new to read
    for path, agent in files:
        seen.add(path)
        try:
            st = os.stat(path)
        except OSError:
            continue
        e = idx.get(path) or _index_row_new(path, agent)
        for k, v in (("entrypoint", ""), ("branch", ""), ("first_ts", ""), ("last_ts", ""), ("user_msgs", 0), ("assistant_msgs", 0), ("tools", {}), ("first_prompt", "")):
            e.setdefault(k, v)
        if not e["subagent"] and _internal_run(e):
            e["subagent"] = True  # Dispatch's own model calls (summaries) are not conversations: hide them like subagents
        if e.get("stats_v") != STATS_V:
            # Shape changed: re-read the whole file once so the counters start from zero.
            e.update(off=0, mtime=0, tasks={}, claims=[], user_msgs=0, assistant_msgs=0, tools={}, stats_v=STATS_V, **stats_fields())
        unchanged = e["mtime"] == st.st_mtime and e["size"] == st.st_size
        E.get(agent).index_cached(e, path, unchanged)
        if unchanged:
            idx[path] = e
            continue
        idx[path] = e  # its place in the index is where the file came up; the row is replaced when it has been read
        todo.append((path, agent, e, st.st_size - e["off"] if st.st_size >= e["off"] else st.st_size))

    # ZCode / OpenCode sessions live in SQLite, not files; key them as <agent>:<id>.
    sql_todo = []
    for agent, store in SQLITE_STORES.items():
        for r in zcode_query("select id, parent_id, directory, title, time_created, time_updated from session where parent_id is null", agent=agent):
            key = f"{agent}:{r['id']}"
            seen.add(key)
            e = idx.get(key)
            if e and e.get("mtime") == r["time_updated"] / 1000 and e.get("stats_v") == STATS_V:
                continue
            sql_todo.append((agent, store, r))
    # stores of their own schema (Hermes' state.db): the rows the engine says changed, read with the databases
    own_todo = [(eng, r) for eng in E.known() for r in eng.index_pending(idx, seen)]

    progress = _IndexProgress(len(todo) + len(sql_todo) + len(own_todo))
    state, t_start = "interrupted", time.time()
    debug("index", f"{len(todo)} files, {len(sql_todo)} sqlite and {len(own_todo)} other database sessions to read, {sum(t[3] for t in todo) >> 20} MB")
    extra = {}         # what the databases give: read here while the helpers read the files, added after them
    stores_failed = []

    def read_databases():
        try:
            for agent, store, r in sql_todo:
                _index_sqlite_row(extra, agent, store, r, rx)
                progress.tick()
            for eng, r in own_todo:
                eng.index_row(extra, r, rx)
                progress.tick()
        except BaseException as ex:  # said again by the builder once the files are read
            stores_failed.append(ex)

    import threading
    stores = threading.Thread(target=read_databases, daemon=True) if sql_todo or own_todo else None
    try:
        if stores:
            stores.start()
        if todo:
            pending = {t[0] for t in todo}
            last_save = [time.time()]

            def got(path, row):
                idx[path] = row
                pending.discard(path)
                progress.tick()
                if progress.on and time.time() - last_save[0] >= INDEX_SAVE_EVERY:
                    last_save[0] = time.time()
                    # what has been read, and for the files still to read what the index file already said
                    save_index({p: (disk[p] if p in pending and p in disk else row2) for p, row2 in idx.items() if p not in pending or p in disk})

            # the biggest few first (one per helper), then the rest smallest first: the count moves from the start
            # and no big file is left for the end
            order = sorted(todo, key=lambda t: t[3])
            workers = index_workers()
            head = sorted(order, key=lambda t: -t[3])[:workers]
            picked = {t[0] for t in head}
            order = head + [t for t in order if t[0] not in picked]
            todo_bytes = sum(t[3] for t in todo)
            failed = []
            if workers > 1 and len(todo) > 1 and todo_bytes >= INDEX_PARALLEL_BYTES:
                failed = _index_parallel([(p, a, e) for p, a, e, _ in order], prefix, min(workers, len(todo)), got)
            else:
                failed = [(p, a, e) for p, a, e, _ in order]
            for path, agent, e in failed:  # read here: the small builds, and any file a helper could not read
                try:
                    got(path, _index_read_file(path, agent, e, rx))
                except OSError as ex:
                    debug(f"index {path}", ex)
                    pending.discard(path)
                    progress.tick()
        debug("index", f"files read after {time.time() - t_start:.1f}s")
        if stores:
            stores.join()
            if stores_failed:
                raise stores_failed[0]
            idx.update(extra)
        debug("index", f"databases read after {time.time() - t_start:.1f}s")
        for eng in E.known():  # a store of its own kind (Gemini CLI's JSON files)
            eng.index_store(idx, seen, rx)
        for p in list(idx):
            if p not in seen:
                del idx[p]
        save_index(idx)
        debug("index", f"saved after {time.time() - t_start:.1f}s")
        state = "done"
    finally:
        progress.finish(state)
    return in_session_root_only(idx)


CALL_TYPES = {"tool_use", "function_call", "local_shell_call", "toolCall", "tool_call", "custom_tool_call"}
RESULT_TYPES = {"tool_result", "function_call_output", "custom_tool_call_output", "local_shell_call_output", "toolResult"}
_JS_CMD_RE = re.compile(r"\bcmd\s*:\s*\"((?:[^\"\\]|\\.)*)\"")


def tool_commands(obj, in_call=False):
    """Shell commands an Agent itself ran, from one transcript event: the tool calls' command /
    cmd (Claude tool_use, Codex function_call / local_shell_call / custom_tool_call, pi toolCall),
    never what a tool printed (a session that read another transcript would otherwise look like
    it ran that session's commands)."""
    out = []

    def walk(o, call):
        if isinstance(o, list):
            for x in o:
                walk(x, call)
            return
        if not isinstance(o, dict):
            return
        t = o.get("type")
        t = t if isinstance(t, str) else ""  # some events carry an object under "type"
        if t in RESULT_TYPES:
            return
        call = call or t in CALL_TYPES
        if call:
            for k in ("command", "cmd"):
                v = o.get(k)
                if isinstance(v, str) or (isinstance(v, list) and v and all(isinstance(x, str) for x in v)):
                    out.append(v)
            args = o.get("arguments")
            if isinstance(args, str) and args.lstrip().startswith("{"):
                try:
                    walk(json.loads(args), True)
                except ValueError:
                    pass
            if t == "custom_tool_call" and isinstance(o.get("input"), str):
                for m in _JS_CMD_RE.finditer(o["input"]):
                    try:
                        out.append(json.loads('"' + m.group(1) + '"'))
                    except ValueError:
                        pass
        for k, v in o.items():
            if k == "toolUseResult":
                continue  # Claude's copy of a tool's output
            if isinstance(v, (dict, list)):
                walk(v, call)

    walk(obj, in_call)
    return out


def claims_of_events(events, id_re, in_call=False, needle=""):
    """Task ids the Agent ran a task command on, from JSON events (strings or parsed). `needle`: text a line must
    contain to hold any (the id prefix and its dash: an id is written out in the command, so a line without one has none)."""
    presence = _mod("presence")
    ids = []
    for ev in events:
        if isinstance(ev, str):
            if ("dispatch" not in ev and "bd" not in ev) or (needle and needle not in ev):
                continue
            try:
                ev = json.loads(ev)
            except ValueError:
                continue
        try:
            cmds = tool_commands(ev, in_call)
        except RecursionError:
            continue
        for cmd in cmds:
            ids += [t for t in presence.task_cmd_ids(cmd) if id_re.match(t)]
        ids += [t for t in presence.mcp_task_ids(ev) if id_re.match(t)]  # through Dispatch's MCP server
    return ids


def claims_of(buf, id_re, needle=""):
    """claims_of_events over a JSONL transcript chunk (only its lines with `needle` are looked at, when there is one)."""
    return claims_of_events(lines_containing(buf, needle) if needle else buf.splitlines(), id_re, needle=needle)


def _tool_summary(inp):
    if not isinstance(inp, dict):
        return str(inp or "")[:200]
    for k in ("command", "file_path", "filePath", "path", "query", "pattern", "description", "url", "prompt"):
        if inp.get(k):
            return str(inp[k])[:200]
    return ""


def _tool_file_change(name, inp, ts, files):
    """Edit/Write-style tool inputs, whatever the agent calls its tools."""
    if not isinstance(inp, dict):
        return
    fp = inp.get("file_path") or inp.get("filePath") or inp.get("path")
    if not fp:
        return
    n = name.lower()
    if "old_string" in inp or "oldString" in inp:
        files.setdefault(fp, []).append({"kind": "edit", "old": inp.get("old_string") or inp.get("oldString") or "", "new": inp.get("new_string") or inp.get("newString") or "", "ts": ts})
    elif "content" in inp and any(w in n for w in ("write", "create", "save")):
        files.setdefault(fp, []).append({"kind": "write", "old": "", "new": inp.get("content") or "", "ts": ts})


def resume_command(agent, sid, cwd):
    """The shell line that resumes a session: POSIX sh on macOS, PowerShell on Windows (its adapter's resume)."""
    eng = E.get(agent)
    try:
        args, _ = eng.resume(sid)
    except E.Unsupported:
        if not eng.desktop_app:
            return ""
        # a desktop app without a resume command; the session id identifies it inside the app
        return L.t(f"# {eng.name} is not supported on Windows yet (session {sid})", f"# Windows 版暂不支持 {eng.name}（会话 {sid}）") if P.IS_WIN else f"open -a {eng.desktop_app}  # " + L.t("session", "会话") + f" {sid}"
    run = " ".join([eng.bin, *args])
    if P.IS_WIN:
        return P.cd_and(cwd, run) if cwd else run
    cd = f"cd '{cwd.replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}' && " if cwd else ""
    return f"{cd}{run}"


def subagents_of(path, agent):
    """The sub-agents of one conversation: child sessions in OpenCode's tables (ZCode adds a task-link table with each
    one's type and label), else what the engine's adapter finds (Claude Code's transcripts next to the parent,
    Hermes' delegations)."""
    if agent in SQLITE_STORES and ":" in path:
        sid = path.split(":", 1)[1]
        if SQLITE_STORES[agent].get("task_links"):
            rows = zcode_query("select s.id, s.title, s.time_updated, s.summary_files, l.agent_type, l.label, l.depth from session s left join session_task_link l on l.child_session_id = s.id where s.parent_id = ? order by s.time_created", (sid,), agent=agent)
            return [{"agent_id": r["id"], "type": r["agent_type"] or L.t("sub-session", "子会话"), "description": r["label"] or r["title"], "tool_use_id": "", "depth": r["depth"] or 1, "size": 0, "last_at": r["time_updated"] / 1000, "path": f"{agent}:" + r["id"]} for r in rows]
        rows = zcode_query("select id, title, time_updated from session where parent_id = ? order by time_created", (sid,), agent=agent)
        return [{"agent_id": r["id"], "type": L.t("sub-session", "子会话"), "description": r["title"], "tool_use_id": "", "depth": 1, "size": 0, "last_at": r["time_updated"] / 1000, "path": f"{agent}:" + r["id"]} for r in rows]
    return E.get(agent).subagents(path)


def in_app_chats():
    """Keys of the conversations that ran in Dispatch's in-app chat (their transcripts say "sdk-cli")."""
    try:
        import chat_protocol
        return chat_protocol.read_started(DISPATCH_DIR)
    except Exception:
        return {}


def ref_of(path, e, task_id=None):
    eng = E.get(e['agent'])
    if eng.supports("own_titles"):  # the title it gave the conversation itself (Codex's thread name) wins
        from activity import user_text
        e = dict(e, title=eng.own_titles(HOME).get(e['session_id']) or user_text(e.get('title', '')))
    origin = "dispatch" if f"{e['agent']}:{e['session_id']}" in in_app_chats() else origin_of(e.get("entrypoint", ""))
    return {"agent": e["agent"], "session_id": e["session_id"], "cwd": e["cwd"], "project": git_root_name(e["cwd"]) or os.path.basename(e["cwd"].rstrip("/")), "title": e.get("title", ""), "first_prompt": e.get("first_prompt", ""), "last_at": e["mtime"], "first_ts": e.get("first_ts", ""), "last_ts": e.get("last_ts", ""), "entrypoint": origin, "branch": e.get("branch", ""), "user_msgs": e.get("user_msgs", 0), "assistant_msgs": e.get("assistant_msgs", 0), "tools": e.get("tools", {}), "tasks": e.get("tasks", {}), "mentions": e["tasks"].get(task_id, 0) if task_id else sum(e["tasks"].values()), "current_task": (e.get("claims") or [None])[-1], "resume_cmd": resume_command(e["agent"], e["session_id"], e["cwd"]), "path": path, "size": e.get("size", 0), "subagents": subagents_of(path, e["agent"])}


_KNOWN_IDS = None


def known_task_ids():
    """The regex also matches English like 'task-board'; keep only ids that exist on the board."""
    global _KNOWN_IDS
    if _KNOWN_IDS is None:
        try:
            code, o, _ = sh(["bd", "list", "--all", "-n", "0", "--json"], timeout=15)
            _KNOWN_IDS = {i["id"] for i in json.loads(o[o.find("["):])} if code == 0 else set()
        except Exception:
            _KNOWN_IDS = set()
    return _KNOWN_IDS


def session_refs(idx, task_id=None, session_id=None):
    refs = []
    known = known_task_ids()
    for path, e in idx.items():
        if not e.get("session_id") or e.get("subagent"):
            continue
        if task_id and task_id not in e["tasks"]:
            continue
        if session_id and not e["session_id"].startswith(session_id):
            continue
        if known:
            e = dict(e, tasks={k: v for k, v in e["tasks"].items() if k in known}, claims=[c for c in e.get("claims", []) if c in known])
        refs.append(ref_of(path, e, task_id))
    refs.sort(key=lambda r: -r["last_at"])
    return refs


def cmd_index(a):
    if getattr(a, "status", False) or getattr(a, "background", False):
        # --status: how far the build is; --background: start one (unless one runs) and answer at once. Both answer index_progress().
        res = index_progress() if a.status else index_start_background()
        out(res, a.json, lambda o: print({"none": L.t("No index is being built", "没有在建索引"), "running": L.t(f"Building the index: {o['done']} / {o['total']}", f"在建索引：{o['done']} / {o['total']}"), "done": L.t("The index is built", "索引建好了"), "interrupted": L.t("The last index build was interrupted", "上一次建索引中断了")}[o["state"]]))
        return
    idx = refresh_index()
    n = len([1 for e in idx.values() if not e.get("subagent")])
    out({"files": len(idx), "sessions": n, "index": INDEX_FILE}, a.json, lambda o: print(L.t(f"Indexed {o['files']} files, {o['sessions']} sessions → {o['index']}", f"索引 {o['files']} 个文件，{o['sessions']} 个会话 → {o['index']}")))


def cmd_folders(a):
    """Every directory an agent has worked in: who came, how often, when, what tasks."""
    idx = load_index() if a.cached else refresh_index()
    refs = session_refs(idx)
    folders = {}
    for r in refs:
        cwd = (r["cwd"] or "").rstrip("/\\" if P.IS_WIN else "/")
        if not cwd:
            continue
        f = folders.setdefault(cwd_key(cwd), {"cwd": ui_path(cwd), "name": os.path.basename(cwd) or cwd, "sessions": 0, "agents": {}, "last_at": 0, "first_at": None, "turns": 0, "tasks": set()})
        f["sessions"] += 1
        f["agents"][r["agent"]] = f["agents"].get(r["agent"], 0) + 1
        f["last_at"] = max(f["last_at"], r["last_at"])
        f["turns"] += r.get("user_msgs", 0)
        f["tasks"].update(r.get("tasks", {}).keys())
        if r.get("first_ts"):
            f["first_at"] = min(f["first_at"] or r["first_ts"], r["first_ts"])
    rows = sorted(folders.values(), key=lambda f: -f["last_at"])
    for f in rows:
        f["tasks"] = sorted(f["tasks"])
        f["exists"] = os.path.isdir(f["cwd"])
    if a.query:
        q = a.query.lower()
        rows = [f for f in rows if q in f["cwd"].lower()]

    def text(rows):
        for f in rows:
            ag = " ".join(f"{k}×{v}" for k, v in f["agents"].items())
            print(f"{ago(f['last_at']):<5} {f['sessions']:>3} " + L.t("sessions", "会话") + f"  {ag:<40} {f['cwd'].replace(HOME, '~')}")
        print(L.t(f"\n{len(rows)} folders", f"\n{len(rows)} 个目录"))
    out(rows, a.json, text)


def _rank_sum(a_list, b_list, key, nums):
    """Add two rank lists (tools / skills / subagents / projects / models) by their name."""
    out = {}
    for x in (a_list or []) + (b_list or []):
        name = x.get(key) or ""
        cur = out.get(name)
        if cur is None:
            cur = dict(x)
            if "by" in x:
                cur["by"] = dict(x.get("by") or {})
            out[name] = cur
            continue
        for f in nums:
            cur[f] = cur.get(f, 0) + x.get(f, 0)
        if "by" in x or "by" in cur:
            cur["by"] = dict(cur.get("by") or {})
            for ag, n in (x.get("by") or {}).items():
                cur["by"][ag] = cur["by"].get(ag, 0) + n
        for f in ("cwd", "agent"):
            if not cur.get(f):
                cur[f] = x.get(f, "")
    return list(out.values())


def merge_stats(base, extra):
    """Fold another Mac's `dispatch stats --cached --local` into this one. Day buckets and
    the weekday×hour grid are added; ranks and projects are added by name; the day, streak
    and active-hour counts are recomputed from the merged buckets so a day both Macs worked
    on is not counted twice."""
    if not extra or not isinstance(extra, dict):
        return base
    days = {d["date"]: dict(d, by=dict(d.get("by") or {})) for d in base.get("days") or []}
    for d in extra.get("days") or []:
        cur = days.get(d["date"])
        if cur is None:
            days[d["date"]] = dict(d, by=dict(d.get("by") or {}))
            continue
        for k in ("msgs", "tokens", "in", "out", "cr", "cw"):
            cur[k] = cur.get(k, 0) + d.get(k, 0)
        for ag, n in (d.get("by") or {}).items():
            cur["by"][ag] = cur["by"].get(ag, 0) + n
    hours = [row[:] for row in (base.get("hours") or [[0] * 24 for _ in range(7)])]
    for w, row in enumerate(extra.get("hours") or []):
        if w >= len(hours):
            continue
        for h, n in enumerate(row):
            if h < len(hours[w]):
                hours[w][h] += n
    agents = {}
    for A in (base.get("agents") or []) + (extra.get("agents") or []):
        cur = agents.setdefault(A["agent"], {"agent": A["agent"], "sessions": 0, "msgs": 0, "tokens": {k: 0 for k in ("in", "out", "cr", "cw", "think")}, "total": 0, "days": 0})
        cur["sessions"] += A.get("sessions", 0)
        cur["msgs"] += A.get("msgs", 0)
        cur["total"] += A.get("total", 0)
        for k, n in (A.get("tokens") or {}).items():
            cur["tokens"][k] = cur["tokens"].get(k, 0) + n
    day_list = sorted(days.values(), key=lambda d: d["date"])
    active = [d["date"] for d in day_list if d.get("msgs", 0) > 0]
    from datetime import datetime as _dt
    cur = longest = run = 0
    prev = None
    for day in active:
        dd = _dt.strptime(day, "%Y-%m-%d").date()
        run = run + 1 if prev and (dd - prev).days == 1 else 1
        longest = max(longest, run)
        prev = dd
    from datetime import date as _date
    if prev and (_date.today() - prev).days <= 1:
        cur = run
    tot = {k: 0 for k in ("in", "out", "cr", "cw", "think")}
    for A in agents.values():
        for k in tot:
            tot[k] += (A["tokens"] or {}).get(k, 0)
        # No per-agent message count per day in the JSON; token presence is the best proxy.
        A["days"] = sum(1 for d in day_list if (d.get("by") or {}).get(A["agent"]))
    total_tokens = tot["in"] + tot["out"] + tot["cr"] + tot["cw"]
    bt, et = base.get("total") or {}, extra.get("total") or {}
    tools = _rank_sum(base.get("tools"), extra.get("tools"), "name", ("count",))
    skills = _rank_sum(base.get("skills"), extra.get("skills"), "name", ("count",))
    subs = _rank_sum(base.get("subagents"), extra.get("subagents"), "name", ("count",))
    projects = _rank_sum(base.get("projects"), extra.get("projects"), "name", ("tokens", "msgs", "sessions"))
    models = _rank_sum(base.get("models"), extra.get("models"), "model", ("msgs",))
    res = dict(base)
    res.update({
        "total": {
            "tokens": tot, "total": total_tokens,
            "sub_tokens": bt.get("sub_tokens", 0) + et.get("sub_tokens", 0),
            "msgs": sum(d.get("msgs", 0) for d in day_list),
            "sessions": sum(A["sessions"] for A in agents.values()),
            "active_days": len(active), "streak_cur": cur, "streak_max": longest,
            "tools_distinct": len(tools),
            "active_hours": sum(1 for row in hours for n in row if n) if not base.get("range_days") else None,
            "first_day": active[0] if active else "", "last_day": active[-1] if active else "",
        },
        "agents": sorted(agents.values(), key=lambda A: -A["total"]),
        "days": day_list, "hours": hours,
        "models": sorted(models, key=lambda m: -m.get("msgs", 0)),
        "tools": sorted(tools, key=lambda t: -t.get("count", 0))[:30],
        "skills": sorted(skills, key=lambda t: -t.get("count", 0))[:30],
        "subagents": sorted(subs, key=lambda t: -t.get("count", 0))[:30],
        "projects": sorted(projects, key=lambda p: -p.get("tokens", 0))[:20],
        "generated_at": max(base.get("generated_at", 0), extra.get("generated_at", 0)),
    })
    return res


def cmd_stats(a):
    """Everything the agents burned, across all of them: tokens, activity by day and hour,
    tools / skills / subagents, models, projects. Ranges filter days by activity date and
    sessions (tools, models, projects) by their last activity. Other Macs in hosts.json are
    merged in (`--local` skips them); their day buckets and hour grid are added."""
    from datetime import date, timedelta
    idx = load_index() if a.cached else refresh_index()
    days_n = a.days or 0
    cutoff = (date.today() - timedelta(days=days_n - 1)).strftime("%Y-%m-%d") if days_n else ""
    cutoff_epoch = time.mktime(time.strptime(cutoff, "%Y-%m-%d")) if cutoff else 0
    agents = {}
    days = {}
    hours = [[0] * 24 for _ in range(7)]
    models, tools, skills, subs, projects = {}, {}, {}, {}, {}
    tok_sub = 0
    for path, e in idx.items():
        ag = e["agent"]
        if a.agent and ag != a.agent:
            continue
        if not e.get("days") and not e.get("tokens"):
            continue
        A = agents.setdefault(ag, {"agent": ag, "sessions": 0, "msgs": 0, "tokens": {"in": 0, "out": 0, "cr": 0, "cw": 0, "think": 0}, "total": 0, "days": set()})
        for day, v in (e.get("days") or {}).items():
            if cutoff and day < cutoff:
                continue
            D = days.setdefault(day, {"date": day, "msgs": 0, "tokens": 0, "in": 0, "out": 0, "cr": 0, "cw": 0, "by": {}})
            D["msgs"] += v[0]; D["tokens"] += v[1]; D["in"] += v[2]; D["out"] += v[3]; D["cr"] += v[4]; D["cw"] += v[5]
            D["by"][ag] = D["by"].get(ag, 0) + v[1]
            A["msgs"] += v[0]; A["total"] += v[1]
            for k, i in (("in", 2), ("out", 3), ("cr", 4), ("cw", 5)):
                A["tokens"][k] += v[i]
            if v[0]:
                A["days"].add(day)
            if e.get("subagent"):
                tok_sub += v[1]
        in_range = not cutoff or e.get("mtime", 0) >= cutoff_epoch
        if not in_range:
            continue
        A["tokens"]["think"] += (e.get("tokens") or {}).get("think", 0)
        if not e.get("subagent") and e.get("session_id"):
            A["sessions"] += 1
        # Only activity within the range; the weekday×hour grid is filtered the same way.
        if not cutoff:
            for k, n in (e.get("hours") or {}).items():
                w, h = k.split("-")
                hours[int(w)][int(h)] += n
        for m, n in (e.get("models") or {}).items():
            M = models.setdefault(m, {"model": m, "agent": ag, "msgs": 0})
            M["msgs"] += n
        for t, n in (e.get("tools") or {}).items():
            T = tools.setdefault(t, {"name": t, "count": 0, "by": {}})
            T["count"] += n; T["by"][ag] = T["by"].get(ag, 0) + n
        for s, n in (e.get("skills") or {}).items():
            S = skills.setdefault(s, {"name": s, "count": 0, "by": {}})
            S["count"] += n; S["by"][ag] = S["by"].get(ag, 0) + n
        for s, n in (e.get("subs") or {}).items():
            S = subs.setdefault(s, {"name": s, "count": 0, "by": {}})
            S["count"] += n; S["by"][ag] = S["by"].get(ag, 0) + n
        cwd = (e.get("cwd") or "").rstrip("/")
        if cwd and not e.get("subagent"):
            # Same naming as the sessions list: the git root wins over the leaf folder; the home directory is "零散会话", not the user name.
            pname = L.t("loose sessions", "零散会话") if (P.same_path(cwd, HOME) if P.IS_WIN else cwd == HOME.rstrip("/")) else (git_root_name(cwd) or os.path.basename(cwd) or cwd)
            PR = projects.setdefault(pname, {"name": pname, "cwd": cwd, "tokens": 0, "msgs": 0, "sessions": 0, "by": {}})
            tk = e.get("tokens") or {}
            tt = sum(v for k, v in tk.items() if k != "think")
            PR["tokens"] += tt; PR["sessions"] += 1; PR["msgs"] += e.get("user_msgs", 0) + e.get("assistant_msgs", 0)
            PR["by"][ag] = PR["by"].get(ag, 0) + tt
    if cutoff:
        # Hour grid for a range: rebuild from the sessions' day buckets is impossible (no hour per day), so
        # approximate with sessions active in the range.
        for e in idx.values():
            if (a.agent and e["agent"] != a.agent) or e.get("mtime", 0) < cutoff_epoch:
                continue
            for k, n in (e.get("hours") or {}).items():
                w, h = k.split("-")
                hours[int(w)][int(h)] += n
    day_list = sorted(days.values(), key=lambda d: d["date"])
    active = sorted(d["date"] for d in day_list if d["msgs"] > 0)
    # streaks
    from datetime import datetime as _dt
    cur = longest = run = 0
    prev = None
    for d in active:
        dd = _dt.strptime(d, "%Y-%m-%d").date()
        run = run + 1 if prev and (dd - prev).days == 1 else 1
        longest = max(longest, run)
        prev = dd
    if prev and (date.today() - prev).days <= 1:
        cur = run
    tot = {"in": 0, "out": 0, "cr": 0, "cw": 0, "think": 0}
    for A in agents.values():
        for k in tot:
            tot[k] += A["tokens"][k]
        A["days"] = len(A["days"])
    total_tokens = tot["in"] + tot["out"] + tot["cr"] + tot["cw"]
    active_hours = sum(1 for row in hours for n in row if n) if not cutoff else None
    res = {
        "range_days": days_n,
        "agent": a.agent or "",
        "total": {"tokens": tot, "total": total_tokens, "sub_tokens": tok_sub, "msgs": sum(d["msgs"] for d in day_list), "sessions": sum(A["sessions"] for A in agents.values()),
                  "active_days": len(active), "streak_cur": cur, "streak_max": longest, "tools_distinct": len(tools), "active_hours": active_hours,
                  "first_day": active[0] if active else "", "last_day": active[-1] if active else ""},
        "agents": sorted(agents.values(), key=lambda A: -A["total"]),
        "days": day_list,
        "hours": hours,
        "models": sorted(models.values(), key=lambda m: -m["msgs"]),
        "tools": sorted(tools.values(), key=lambda t: -t["count"])[:30],
        "skills": sorted(skills.values(), key=lambda t: -t["count"])[:30],
        "subagents": sorted(subs.values(), key=lambda t: -t["count"])[:30],
        "projects": sorted(projects.values(), key=lambda p: -p["tokens"])[:20],
        "generated_at": time.time(),
    }
    if not getattr(a, "local", False):
        merged = []
        for h in hosts():
            rargs = ["stats", "--cached", "--local", "--days", str(days_n)] + (["--agent", a.agent] if a.agent else [])
            other = remote_dispatch(h, rargs, 120)
            if not other:
                continue
            res = merge_stats(res, other)
            merged.append(h["name"])
        if merged:
            res["hosts"] = [local_host_name()] + merged

    def text(r):
        t = r["total"]
        print(L.t(f"tokens {t['total']:,} (in {t['tokens']['in']:,} · out {t['tokens']['out']:,} · cache read {t['tokens']['cr']:,} · cache write {t['tokens']['cw']:,}) · messages {t['msgs']:,} · sessions {t['sessions']} · active {t['active_days']} days (streak {t['streak_cur']}, longest {t['streak_max']})",
                 f"token {t['total']:,}（输入 {t['tokens']['in']:,} · 输出 {t['tokens']['out']:,} · 缓存读 {t['tokens']['cr']:,} · 缓存写 {t['tokens']['cw']:,}） · 消息 {t['msgs']:,} · 会话 {t['sessions']} · 活跃 {t['active_days']} 天（当前连续 {t['streak_cur']}，最长 {t['streak_max']}）"))
        for A in r["agents"]:
            print(L.t(f"  {A['agent']:<12} tokens {A['total']:>13,}  messages {A['msgs']:>7,}  sessions {A['sessions']:>4}  active {A['days']} days", f"  {A['agent']:<12} token {A['total']:>13,}  消息 {A['msgs']:>7,}  会话 {A['sessions']:>4}  活跃 {A['days']} 天"))
        print(L.t("Tools:", "工具:"), " · ".join(f"{x['name']} {x['count']}" for x in r["tools"][:10]))
        print(L.t("Skills:", "技能:"), " · ".join(f"{x['name']} {x['count']}" for x in r["skills"][:10]) or "—")
        print(L.t("Sub-agents:", "子 Agent:"), " · ".join(f"{x['name']} {x['count']}" for x in r["subagents"][:8]) or "—")
        print(L.t("Models:", "模型:"), " · ".join(f"{x['model']} {x['msgs']}" for x in r["models"][:8]))
        print(L.t("Projects:", "项目:"), " · ".join(f"{x['name']} {x['tokens']:,}" for x in r["projects"][:8]))
    out(res, a.json, text)


def cmd_list(a):
    idx = load_index() if a.cached else refresh_index()
    refs = session_refs(idx)
    from projects_view import is_automation
    from ide_sessions import sidebar_entries
    in_app = in_app_chats()
    entries = sidebar_entries(idx, in_app)
    from activity import session_preferences, apply_preferences
    preferences = session_preferences(DISPATCH_DIR)
    for r in refs:
        apply_preferences(r, preferences.get(r["agent"] + ":" + r["session_id"], {}))
        key = f"{E.provider_of(r['agent'])}:{r['session_id']}"
        r["one_shot"] = is_automation(entries.get(key, r), in_app)
        r["host"], r["host_name"] = "local", local_host_name()
    annotate_moves(refs)
    if not getattr(a, "local", False):
        refs = sorted(refs + remote_refs(), key=lambda r: -(r.get("last_at") or 0))
    if a.agent:
        refs = [r for r in refs if r["agent"] == a.agent]
    if a.cwd:
        want = cwd_key(os.path.expanduser(P.from_msys(a.cwd) if P.IS_WIN else a.cwd))
        refs = [r for r in refs if cwd_key(r["cwd"]) == want]
    if a.project:
        refs = [r for r in refs if r["project"] == a.project]
    if a.query:
        q = a.query.lower()
        refs = [r for r in refs if q in (r["title"] or "").lower() or q in r["cwd"].lower() or q in r["session_id"]]
    refs = catalog_window(refs, a.limit)

    def text(refs):
        for r in refs:
            print(f"{r['agent']:<12} {r['project']:<18} {ago(r['last_at']):<8} {r['user_msgs']:>4} turns {len(r['subagents']):>2} sub-agents  {r['title'] or '(untitled)'}  {r['session_id'][:8]}")
    out(refs, a.json, text)


def catalog_window(refs, limit, routine_cap=None, per_project=3):
    """The newest `limit` conversations a person would look for — not the newest `limit` files.
    Routine runs (Hermes cron every half hour, sessions marked scheduled) take a small slice of
    the window instead of the whole: 306 of 500 slots went to flomo archiving and a project idle
    for nine days showed 「0 个会话」 while its transcripts sat in the index. Every project keeps
    its newest few conversations even past the cut, so the catalog still knows it exists."""
    if not limit or len(refs) <= limit:
        return refs
    routine = lambda r: bool(r.get("scheduled")) or r.get("entrypoint") == "cron"
    cap = routine_cap if routine_cap is not None else max(20, limit // 10)
    people = [r for r in refs if not routine(r)]
    keep = people[:limit] + [r for r in refs if routine(r)][:cap]
    chosen = {id(r) for r in keep}
    seen = {}
    for r in people[:limit]:
        seen[r.get("project") or ""] = seen.get(r.get("project") or "", 0) + 1
    for r in people[limit:]:
        proj = r.get("project") or ""
        if proj and seen.get(proj, 0) < per_project and id(r) not in chosen:
            seen[proj] = seen.get(proj, 0) + 1
            keep.append(r)
    return sorted(keep, key=lambda r: -(r.get("last_at") or 0))


def _text_images(txt, cwd):
    """Attachment ids for pictures a message names by path (see attachments.scan)."""
    import hashlib
    from attachments import BARE_IMAGE, local_path
    ids = []
    for m in BARE_IMAGE.finditer(txt or ""):
        path = local_path(m[0], cwd)
        if path and os.path.isfile(path):
            key = hashlib.sha256(path.encode()).hexdigest()[:24]
            if key not in ids:
                ids.append(key)
    return ids


def _block_images(content):
    """Attachment ids for the pictures in a message (pasted, or returned by a tool), matching attachments.scan()."""
    import hashlib
    ids = []
    blocks = []
    for b in content if isinstance(content, list) else []:
        if not isinstance(b, dict):
            continue
        blocks.append(b)
        if b.get("type") == "tool_result" and isinstance(b.get("content"), list):
            blocks.extend(x for x in b["content"] if isinstance(x, dict))
    for b in blocks:
        if b.get("type") == "image" and (b.get("source") or {}).get("type") == "base64":
            src = b["source"]
            url = f"data:{src.get('media_type', 'image/png')};base64,{src.get('data', '')}"
            ids.append("embedded:" + hashlib.sha256(url.encode()).hexdigest()[:24])
    return ids


def _block_text(content):
    if isinstance(content, str):
        return content
    parts = []
    for b in content or []:
        if isinstance(b, dict) and b.get("type") == "text":
            parts.append(b.get("text", ""))
    return "\n".join(parts)


# ---- the block timeline ---------------------------------------------------------------
# Every parsed message carries `blocks`, the same shape for all four agents (field names are
# a contract with the app, keep them verbatim):
#   {"type": "thinking",  "text": …}
#   {"type": "text",      "text": …}
#   {"type": "tool_call", "id", "name", "summary", "input": {compact}, "status": running|done|error|incomplete,
#                         "result": short text, "result_ts": ts}
# `text` and `tools` stay on the message for the older readers (reply box, sibling merge).
# `input` on an edit-shaped call (Edit/MultiEdit/Write/NotebookEdit/apply_patch/…, see EDIT_TOOLS)
# keeps its old/new text large enough to diff (capped, see _cap_diff_text) instead of the small
# INPUT_CHARS clip every other tool argument gets; `input.truncated: true` marks a clipped one.
LONG_TEXT = 24000
LONG_NOTE_EN = "\n(This message is too long; see the rest in the original session.)"
LONG_NOTE = "\n（这条消息过长，剩余内容请在原会话查看）"
RESULT_CHARS = 600
INPUT_CHARS = 400
RUNNING_GRACE = 180  # a tool call still unanswered this long after the last write is "incomplete", not "running"

# Edit-shaped tool calls (across all agents) whose old/new text the UI turns into a diff in the
# timeline — these keep a much larger (but still capped) copy of their diff-relevant fields; every
# other tool argument stays at INPUT_CHARS. Kept in sync with the EDIT set in src/timeline.ts.
EDIT_TOOLS = {"Edit", "MultiEdit", "Write", "NotebookEdit", "edit", "write", "edit_file", "write_file", "apply_patch", "patch"}
DIFF_FIELDS = {"old_string", "new_string", "content", "new_source", "oldText", "newText", "input"}
DIFF_LINE_CAP = 400   # ~ what a terminal Edit/Write diff shows at once
DIFF_BYTE_CAP = 40_000


def _cap_diff_text(s):
    """Trim one diff-relevant string to at most DIFF_LINE_CAP lines and DIFF_BYTE_CAP bytes,
    whichever hits first. Returns (text, truncated)."""
    s = s or ""
    truncated = False
    lines = s.split("\n")
    if len(lines) > DIFF_LINE_CAP:
        lines = lines[:DIFF_LINE_CAP]
        truncated = True
    s = "\n".join(lines)
    b = s.encode("utf-8", "replace")
    if len(b) > DIFF_BYTE_CAP:
        s = b[:DIFF_BYTE_CAP].decode("utf-8", "ignore")
        truncated = True
    return s, truncated


def _clip(txt, n=LONG_TEXT):
    txt = txt or ""
    return txt[:n] + (L.t(LONG_NOTE_EN, LONG_NOTE) if len(txt) > n else "")


def _result_text(content):
    """The visible part of a tool result: a string, or the text blocks of a list."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(b.get("text", ""))
            elif isinstance(b, dict) and b.get("type") == "image":
                parts.append(L.t("[image]", "[图片]"))
        return "\n".join(parts)
    if isinstance(content, dict):
        return _result_text(content.get("output") or content.get("text") or content.get("content") or "")
    return "" if content is None else str(content)


def _summarize_result(content, limit=RESULT_CHARS):
    txt = _result_text(content).strip()
    if len(txt) <= limit:
        return txt
    head = txt[: limit // 2].rstrip()
    tail = txt[-(limit // 4):].lstrip()
    return f"{head}\n…" + L.t(f"({len(txt) - len(head) - len(tail)} characters left out)", f"（省略 {len(txt) - len(head) - len(tail)} 字）") + f"…\n{tail}"


def _compact_input(inp, name=""):
    """Tool arguments small enough to ship to the UI: strings clipped, nested values summarized.

    An edit-shaped call (see EDIT_TOOLS) keeps its old/new text — the UI renders a diff from it —
    at the bigger DIFF_LINE_CAP/DIFF_BYTE_CAP; every other argument still clips to INPUT_CHARS.
    A call whose diff text got clipped carries `truncated: true` (a new field; never repurposed)."""
    if not isinstance(inp, dict):
        return {"value": str(inp)[:INPUT_CHARS]} if inp not in (None, "") else {}
    is_edit = name.split(".")[-1] in EDIT_TOOLS
    out = {}
    truncated = False
    for k, v in list(inp.items())[:12]:
        if k == "questions" and isinstance(v, list):
            out[k] = v  # AskUserQuestion: the UI renders the choices and answers them
        elif k == "edits" and is_edit and isinstance(v, list):
            # MultiEdit: each hunk's old/new text, capped the same way a single Edit is.
            edits = []
            for e in v[:40]:
                if not isinstance(e, dict):
                    continue
                old, t1 = _cap_diff_text(str(e.get("old_string", "")))
                new, t2 = _cap_diff_text(str(e.get("new_string", "")))
                truncated = truncated or t1 or t2
                edits.append({"old_string": old, "new_string": new, **({"replace_all": e["replace_all"]} if "replace_all" in e else {})})
            truncated = truncated or len(v) > 40
            out[k] = edits
        elif is_edit and k in DIFF_FIELDS and isinstance(v, str):
            capped, t = _cap_diff_text(v)
            truncated = truncated or t
            out[k] = capped
        elif isinstance(v, str):
            out[k] = v[:INPUT_CHARS] + ("…" if len(v) > INPUT_CHARS else "")
        elif isinstance(v, (int, float, bool)) or v is None:
            out[k] = v
        else:
            s = json.dumps(v, ensure_ascii=False)
            out[k] = s[:INPUT_CHARS] + ("…" if len(s) > INPUT_CHARS else "")
    if truncated:
        out["truncated"] = True
    return out


class _Timeline:
    """Collects messages/blocks while a transcript is read; pairs tool results with their calls."""

    def __init__(self):
        self.msgs, self.files, self.tool_names = [], {}, {}
        self.pending = {}    # tool id -> block still waiting for its result
        self.resolved = []   # results whose call was read before this pass (incremental reads)

    def add(self, ts, role, blocks=None, **extra):
        blocks = [b for b in (blocks or []) if b.get("type") != "text" or b.get("text", "").strip()]
        text = "\n".join(b["text"] for b in blocks if b["type"] == "text")
        tools = [{"name": b["name"], "summary": b["summary"], "id": b["id"]} for b in blocks if b["type"] == "tool_call"]
        m = {"ts": ts, "role": role, "text": _clip(text), "tools": tools, "blocks": blocks, **extra}
        if role == "user" and not extra.get("synthetic"):
            # Dispatch IDE's Quote: the `>` paragraphs in front of the person's words, as quote cards
            from session_reply import parse_quotes
            quotes = parse_quotes(text)
            if quotes:
                m["quotes"] = quotes
        self.msgs.append(m)
        return m

    def tool(self, ts, id_, name, inp, summary):
        self.tool_names[name] = self.tool_names.get(name, 0) + 1
        # The activity strip used to translate Codex's orchestration source into a readable
        # operation. Keep that summary on the original call, with its input/result available.
        if name.split(".")[-1] in ("exec", "apply_patch"):
            from activity import operation_summary
            summary = operation_summary(name, inp if isinstance(inp, dict) else {},
                                        inp.get("input", summary) if isinstance(inp, dict) else summary)
        b = {"type": "tool_call", "id": str(id_ or ""), "name": name, "summary": str(summary or "")[:200], "input": _compact_input(inp, name), "status": "running", "ts": ts}
        if b["id"]:
            self.pending[b["id"]] = b
        return b

    def resolve(self, id_, content, is_error, ts, status=None):
        status = status or ("error" if is_error else "done")
        b = self.pending.pop(str(id_ or ""), None)
        if b is None:
            if id_:
                self.resolved.append({"id": str(id_), "status": status, "result": _summarize_result(content), "result_ts": ts})
            return
        b["status"], b["result"], b["result_ts"] = status, _summarize_result(content), ts

    def note_file(self, path, kind, old, new, ts):
        self.files.setdefault(path, []).append({"kind": kind, "old": old or "", "new": new or "", "ts": ts})

    def finish(self, live):
        for b in self.pending.values():
            # A question to the person waits as long as it takes; it is still running.
            if b["status"] == "running" and not live and b["name"] != "AskUserQuestion":
                b["status"] = "incomplete"
        self.pending = {}


def _thinking_block(text, note=""):
    text = (text or "").strip()
    if not text and not note:
        note = L.t("Not recorded (the model kept only a signature)", "内容未记录（模型只留签名）")
    return {"type": "thinking", "text": text[:LONG_TEXT], **({"note": note} if note else {})}


def _zcode_status(state):
    s = (state or {}).get("status") or ""
    return {"completed": "done", "error": "error", "pending": "running", "running": "running"}.get(s, "done" if s else "running")


def read_zcode_detail(ref, limit, since=None):
    sid = ref["session_id"]
    tl = _Timeline()
    sql = "select p.data pdata, m.data mdata, p.time_created ts, p.time_updated tu from part p join message m on m.id = p.message_id where p.session_id=?"
    params = [sid]
    if since:
        sql += " and p.time_updated > ?"; params.append(int(since))
    rows = zcode_query(sql + " order by p.time_created, p.{seq}", tuple(params), agent=ref.get("agent") or "zcode")
    offset = int(since or 0)
    last, last_mid = None, None
    for r in rows:
        try:
            p = json.loads(r["pdata"]); m = json.loads(r["mdata"])
        except Exception:
            continue
        offset = max(offset, int(r.get("tu") or r["ts"] or 0))
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r["ts"] / 1000))
        role = "user" if m.get("role") == "user" else "assistant"
        mid = p.get("messageID") or m.get("id")
        # One assistant turn spans several parts (reasoning, text, tool…): one message with several blocks.
        if last is None or last_mid != mid or last["role"] != role:
            last = None
        t = p.get("type")
        # OpenCode rewrites a part while it streams; the part id lets a later read replace the earlier copy.
        if t == "text" and p.get("text", "").strip():
            block = {"type": "text", "text": p["text"][:LONG_TEXT], **({"id": p["id"]} if p.get("id") else {})}
        elif t == "reasoning":
            if not (p.get("text") or "").strip():
                continue
            block = {**_thinking_block(p.get("text", "")), **({"id": p["id"]} if p.get("id") else {})}
        elif t == "tool":
            name = p.get("tool", "")
            st = p.get("state") or {}
            inp = st.get("input") or {}
            summary = inp.get("command") or inp.get("filePath") or inp.get("file_path") or inp.get("description") or inp.get("pattern") or st.get("title") or ""
            block = tl.tool(ts, p.get("callID") or p.get("id"), name, inp, summary)
            status = _zcode_status(st)
            if status != "running":
                tl.resolve(block["id"], st.get("output") or st.get("error") or "", status == "error", ts, status)
            fp = inp.get("filePath") or inp.get("file_path")
            if fp and name.lower() == "edit":
                tl.note_file(fp, "edit", inp.get("oldString", ""), inp.get("newString", ""), ts)
            elif fp and name.lower() == "write":
                tl.note_file(fp, "write", "", inp.get("content", ""), ts)
        else:
            continue
        if last is not None and role == "assistant":
            last["blocks"].append(block)
            if block["type"] == "text":
                last["text"] = _clip("\n".join(b["text"] for b in last["blocks"] if b["type"] == "text"))
            elif block["type"] == "tool_call":
                last["tools"].append({"name": block["name"], "summary": block["summary"], "id": block["id"]})
        else:
            last = tl.add(ts, role, [block], **({"mid": mid} if mid and role == "assistant" else {})); last_mid = mid
    return _finish_detail(ref, tl, limit, since, offset, live=bool(rows) and time.time() - offset / 1000 < RUNNING_GRACE)


def _finish_detail(ref, tl, limit, since, offset, live):
    tl.finish(live)
    msgs = tl.msgs
    if since is None and len(msgs) > limit:
        msgs = msgs[:40] + [{"ts": "", "role": "gap", "text": L.t(f"…{len(msgs) - limit} messages left out…", f"…省略 {len(msgs) - limit} 条…"), "tools": [], "blocks": []}] + msgs[-(limit - 40):]
    # The model it last answered with, for the reply box's status line.
    meta = {**ref, "model": tl.model} if getattr(tl, "model", "") else ref
    d = {"meta": meta, "messages": msgs, "files": [{"path": p, "changes": c} for p, c in tl.files.items()], "tool_counts": tl.tool_names, "offset": offset}
    if since is not None:
        d["partial"] = True
        d["since"] = since
        d["resolved"] = tl.resolved
    return d


class _DetailContext:
    """One session page being read from a JSON-lines transcript: the timeline, the session's ref, and the assistant
    message still being assembled (records of one reply, or of one Codex turn, join it)."""

    def __init__(self, tl, ref):
        self.tl, self.ref = tl, ref
        self.last, self.last_mid = None, None
        self.state = {"seen_tool_images": [], "turn": ""}  # what an engine's reader keeps from one record to the next

    def assistant(self, ts, mid, blocks, **extra):
        last = self.last
        if last is not None and mid and self.last_mid == mid:
            last["blocks"].extend(b for b in blocks if b.get("type") != "text" or b.get("text", "").strip())
            if extra.get("images"):
                last["images"] = [*last.get("images", []), *[i for i in extra["images"] if i not in last.get("images", [])]]
            last["text"] = _clip("\n".join(b["text"] for b in last["blocks"] if b["type"] == "text"))
            last["tools"] = [{"name": b["name"], "summary": b["summary"], "id": b["id"]} for b in last["blocks"] if b["type"] == "tool_call"]
            return last
        self.last = self.tl.add(ts, "assistant", blocks, **({"mid": mid} if mid else {}), **extra)
        self.last_mid = mid
        return self.last

    def other(self, m):
        self.last = None
        return m


def read_session_detail(ref, limit=400, since=None):
    """Parse one transcript into a block timeline + file changes (from Edit/Write tool calls).

    `since` is the byte offset (zcode: time_updated) a previous read stopped at; with it only the
    new records are parsed and the result carries `partial`, `resolved` (results for tool calls
    already shown) and the new `offset` to continue from."""
    if ref["agent"] in SQLITE_STORES:
        return read_zcode_detail(ref, limit, since)
    if E.get(ref["agent"]).supports("detail"):
        return E.get(ref["agent"]).detail(ref, limit, since)
    tl = _Timeline()
    path = ref["path"]
    eng = E.get(ref["agent"])
    cx = _DetailContext(tl, ref)  # what the engine's record reader works with (its adapter's detail_record)
    offset = int(since or 0)
    try:
        st = os.stat(path)
    except OSError:
        st = None
    with open(path, "rb") as f:
        if offset:
            f.seek(offset)
        while True:
            raw = f.readline()
            if not raw:
                break
            if not raw.endswith(b"\n"):
                break  # an in-flight record: read it next time
            offset = f.tell()
            try:
                d = json.loads(raw.decode("utf-8", "replace"))
            except Exception:
                continue
            if not isinstance(d, dict):
                continue
            eng.detail_record(d, cx)
    live = bool(st) and time.time() - st.st_mtime < RUNNING_GRACE
    return _finish_detail(ref, tl, limit, since, offset, live)


def remote_session_detail(key):
    """A session that is not in the local index may live on another Mac."""
    for h in hosts():
        d = remote_dispatch(h, ["session", key], 3)
        if isinstance(d, dict) and d.get("meta"):
            _tag_host([d["meta"]], h)
            d["meta"]["remote"] = True
            d["meta"]["resume_cmd"] = f"ssh -t {h['ssh']} {json.dumps(d['meta'].get('resume_cmd', ''))}"
            return d
    return None


def cmd_activity(a):
    from activity import activity_list
    rows = activity_list(HOME, DISPATCH_DIR, load_index())
    annotate_moves(_tag_host(rows, {"id": "local", "name": local_host_name()}))
    key = getattr(a, "key", "") or ""
    if key:
        rows = [r for r in rows if r.get("key") == key or r.get("session_id") == key]
    if not getattr(a, "events", False):
        # The per-session event log is 80 % of this payload and only the open session's page reads
        # it (`--events --key <key>`); the app polls this every few seconds, so leave it out here.
        for r in rows:
            r["events"] = []
    unavailable = []
    if not a.local and not key:
        for h in hosts():
            remote = remote_dispatch(h, ["activity", "--local"], 5)
            if not isinstance(remote, dict) or time.time() - remote.get("updated_at", 0) > 25:
                unavailable.append(h["name"])
            if isinstance(remote, dict):
                more = _tag_host(_only_theirs(remote.get("sessions", [])), h)
                for r in more:
                    r["remote"] = True
                    if h["name"] in unavailable: r["stale"] = True
                rows.extend(more)
    out({"sessions": sorted(rows, key=lambda r: -r["last_at"]), "updated_at": time.time(), "unavailable_hosts": unavailable}, a.json, lambda x: print(json.dumps(x, ensure_ascii=False)))


def cmd_session_preferences(a):
    from activity import set_preferences
    out(set_preferences(DISPATCH_DIR, a.key, json.loads(a.changes)), a.json, lambda x: print(json.dumps(x, ensure_ascii=False)))


def cmd_session_delete(a):
    from session_delete import command
    command(sys.modules[__name__], a)


def cmd_seen(a):
    from activity import acknowledge, unacknowledge
    if a.reply == "unread":  # the same transport, reversed: drop the receipt
        return out(unacknowledge(DISPATCH_DIR, a.key), a.json, lambda _: print(L.t("Marked unread", "已标为未读")))
    out(acknowledge(DISPATCH_DIR, a.key, a.reply), a.json, lambda _: print(L.t("Marked read", "已读")))


# ---------------------------------------------------------------- commits: what a task became in git

_HASH_RE = re.compile(r"\b[0-9a-f]{7,40}\b")


def git_root_of(path):
    if not path:
        return ""  # `git -C ""` silently means the current directory — never what the caller asked
    code, o, _ = sh(["git", "-C", path, "rev-parse", "--show-toplevel"], timeout=5)
    return o.strip() if code == 0 else ""


def task_commits(tid, issue=None, comments=None):
    """Commits that belong to a task: those whose message names the task id, plus hashes
    written into its close reason / comments (`commit 3abefc0`). Looked up in the project's
    repo (the task's project dir → git root)."""
    if issue is None:
        code, o, _ = sh(["bd", "show", tid, "--json"])
        if code != 0:
            return {"root": "", "commits": []}
        d = json.loads(o[o.find("[") if o.find("[") >= 0 and o.find("[") < o.find("{") else o.find("{"):])
        issue = d[0] if isinstance(d, list) else d
    if comments is None:
        comments = bd_comments(tid)
    root = git_root_of(task_project_dir(issue))
    if not root:
        return {"root": "", "commits": []}
    seen, out = set(), []

    def add(h):
        code, o, _ = sh(["git", "-C", root, "show", "-s", "--format=%H%x1f%h%x1f%ad%x1f%an%x1f%s", "--date=iso-strict", h], timeout=5)
        if code != 0 or not o.strip():
            return
        full, short, date, author, subject = o.strip().split("\x1f", 4)
        if full in seen:
            return
        seen.add(full)
        _, st, _ = sh(["git", "-C", root, "show", "--stat=200", "--format=", full], timeout=5)
        files = [l.split("|")[0].strip() for l in st.splitlines() if "|" in l]
        m = re.search(r"(\d+) insertion", st); n = re.search(r"(\d+) deletion", st)
        out.append({"hash": full, "short": short, "date": date, "author": author, "subject": subject, "files": files[:40], "file_count": len(files), "add": int(m.group(1)) if m else 0, "del": int(n.group(1)) if n else 0})

    code, o, _ = sh(["git", "-C", root, "log", "--all", "--format=%H", f"--grep={re.escape(tid)}", "-n", "50"], timeout=10)
    for h in (o.split() if code == 0 else []):
        add(h)
    text = " ".join([issue.get("close_reason") or "", issue.get("notes") or ""] + [c.get("text", "") for c in comments])
    for h in _HASH_RE.findall(text):
        if len(h) >= 7 and not h.isdigit():
            add(h)
    out.sort(key=lambda c: c["date"], reverse=True)
    remote = ""
    code, o, _ = sh(["git", "-C", root, "remote", "get-url", "origin"], timeout=5)
    if code == 0:
        u = o.strip()
        m = re.match(r"(?:git@github\.com:|https://github\.com/)([^/]+/[^/.]+?)(?:\.git)?$", u)
        remote = f"https://github.com/{m.group(1)}" if m else ""
    return {"root": root, "remote": remote, "commits": out}


def cmd_save_image(a):
    """Store a pasted picture for a discussion (base64 JSON on stdin) and print its path, so the
    agents' Read tool can look at it. ~/tasks/.dispatch/images/<stamp>-<n>.<ext>."""
    import base64
    d = json.loads(sys.stdin.read() or "{}")
    data = d.get("data", "")
    if data.startswith("data:"):
        data = data.split(",", 1)[1]
    if len(data) * 3 // 4 > 20 * 1024 * 1024:
        raise SystemExit(L.t("The image is over 20 MB", "图片超过 20 MB"))
    try:
        raw = base64.b64decode(data, validate=False)
    except Exception:
        raise SystemExit(L.t("The image is not valid base64; nothing was saved", "图片内容不是有效的 base64，没有保存"))
    if len(raw) > 20 * 1024 * 1024:
        raise SystemExit(L.t("The image is over 20 MB", "图片超过 20 MB"))
    ext = "jpg" if raw[:3] == b"\xff\xd8\xff" else "png" if raw[:4] == b"\x89PNG" else "gif" if raw[:3] == b"GIF" else "webp" if raw[8:12] == b"WEBP" else "bin"
    folder = os.path.join(DISPATCH_DIR, "images")
    os.makedirs(folder, exist_ok=True)
    name = re.sub(r"[^\w.-]", "_", (d.get("name") or "image"))[:40].rsplit(".", 1)[0]
    path = os.path.join(folder, f"{time.strftime('%Y%m%d-%H%M%S')}-{name}.{ext}")
    open(path, "wb").write(raw)
    out({"path": path, "size": len(raw)}, a.json, lambda x: print(x["path"]))


def cmd_save_file(a):
    """Store any attachment (base64 JSON on stdin: {name, data}) under ~/tasks/.dispatch/files/ and
    print its path — the words 「附件（用 Read 看）：<path>」 then travel with the message. Keeps the
    original extension so the Agent's Read tool knows what it is; 50 MB cap."""
    import base64
    d = json.loads(sys.stdin.read() or "{}")
    data = d.get("data", "")
    if data.startswith("data:"):
        data = data.split(",", 1)[1]
    if len(data) * 3 // 4 > 50 * 1024 * 1024:
        raise SystemExit(L.t("The file is over 50 MB", "文件超过 50 MB"))
    try:
        raw = base64.b64decode(data, validate=False)
    except Exception:
        raise SystemExit(L.t("The file is not valid base64; nothing was saved", "文件内容不是有效的 base64，没有保存"))
    if len(raw) > 50 * 1024 * 1024:
        raise SystemExit(L.t("The attachment is over 50 MB", "附件超过 50 MB"))
    folder = os.path.join(DISPATCH_DIR, "files")
    os.makedirs(folder, exist_ok=True)
    orig = os.path.basename(d.get("name") or "file")
    stem, ext = (orig.rsplit(".", 1) + [""])[:2] if "." in orig else (orig, "")
    stem = re.sub(r"[^\w.-]", "_", stem)[:60] or "file"
    ext = re.sub(r"[^A-Za-z0-9]", "", ext)[:12]
    path = os.path.join(folder, f"{time.strftime('%Y%m%d-%H%M%S')}-{stem}" + (f".{ext}" if ext else ""))
    open(path, "wb").write(raw)
    out({"path": path, "size": len(raw)}, a.json, lambda x: print(x["path"]))


def cmd_commits(a):
    r = task_commits(a.task)

    def text(r):
        if not r["commits"]:
            print(L.t("No commits found for this task (put the task id in commit messages, or the commit hash in the done reason, and they match up)", "没有找到这个任务的提交（提交信息里带任务 id，或在完成说明里写 commit 哈希，就能对上）"))
        for c in r["commits"]:
            print(f"{c['short']}  {c['date'][:16]}  +{c['add']} −{c['del']}  {c['subject'][:90]}")
    out(r, a.json, text)


def cmd_session_control(a):
    from session_control import command
    command(sys.modules[__name__], a)


class _QuoteAction(argparse.Action):
    """`dispatch reply send --quote "原文" [--quote-from NOTES.md:9] …`: each --quote opens a quote, a
    --quote-from after it says where that one is from (argparse keeps them in one ordered list)."""
    def __call__(self, parser, ns, values, option_string=None):
        quotes = list(getattr(ns, self.dest, None) or [])
        quotes.append({"text": values})
        setattr(ns, self.dest, quotes)


class _QuoteFromAction(argparse.Action):
    def __call__(self, parser, ns, values, option_string=None):
        quotes = list(getattr(ns, self.dest, None) or [])
        if not quotes or quotes[-1].get("from"):
            parser.error("--quote-from goes right after the --quote it belongs to")
        quotes[-1] = {**quotes[-1], "from": values}
        setattr(ns, self.dest, quotes)


def cmd_reply(a):
    from session_reply import command
    command(sys.modules[__name__], a)


def cmd_attachment(a):
    from attachments import read, catalog, local_path, thumbs
    if "/sub/" in a.key:
        ref = subagent_ref(load_index(), a.key)
        refs = [ref] if ref else []
    else:
        refs = resolve(load_index(), a.key)
        if not refs: refs = resolve(refresh_index(), a.key)
    if not refs: raise ValueError(L.t("This Mac has no such session", "本机找不到这个会话"))
    first = refs[0]
    if a.ref == "--thumbs" or getattr(a, "thumbs", False):
        return out(thumbs(first), True, None)
    for ref in refs:
        if (ref['agent'], ref['session_id']) != (first['agent'], first['session_id']): continue
        path = local_path(a.ref, ref.get('cwd',''))
        if any(x['id'] == a.ref or (path and x['path'] == path) for x in catalog(ref)):
            return out(read(ref, a.ref), a.json, lambda d: print(json.dumps(d, ensure_ascii=False)))
    raise ValueError(L.t('The file is not attached or linked in this session', '文件未附加或链接在此会话中'))


def subagent_ref(idx, key):
    """`<session-key>/sub/<agent-id>`: the transcript of one sub-agent a session dispatched,
    presented as a session of its own (same agent kind and cwd, its description as title)."""
    parent_key, aid = key.split("/sub/", 1)
    refs = resolve(idx, parent_key) or resolve(refresh_index(), parent_key)
    for r in refs:
        for sub in subagents_of(r["path"], r["agent"]):
            if sub["agent_id"] == aid or sub["agent_id"].startswith(aid):
                return dict(r, path=sub["path"], session_id=f"{r['session_id']}/sub/{sub['agent_id']}", title=f"↳ {sub['type'] or L.t('sub-agent', '子 Agent')} · {sub['description'] or aid[:8]}",
                            subagents=[], subagent_view=True, parent_session_id=r["session_id"], user_msgs=0, size=sub["size"], resume_cmd="")
    return None


def cmd_session(a):
    if a.key == "life":
        return _mod("session_life").command(a)
    idx = load_index()
    if "/sub/" in a.key:
        ref = subagent_ref(idx, a.key)
        if not ref:
            # The parent session may live on another Mac (the phone is served by the mini): ask there.
            d = remote_session_detail(a.key)
            if not d:
                print(L.t(f"No sub-agent {a.key}", f"找不到子 Agent {a.key}"), file=sys.stderr); sys.exit(1)
            return out(d, a.json, lambda d: print(L.t(f"{d['meta']['title']} · {len(d['messages'])} messages · {len(d['files'])} files changed", f"{d['meta']['title']} · {len(d['messages'])} 条 · 改动文件 {len(d['files'])}")))
        d = read_session_detail(ref)
        from attachments import catalog
        d["attachments"] = catalog(ref)
        return out(d, a.json, lambda d: print(L.t(f"{d['meta']['title']} · {len(d['messages'])} messages · {len(d['files'])} files changed", f"{d['meta']['title']} · {len(d['messages'])} 条 · 改动文件 {len(d['files'])}")))
    refs = resolve(idx, a.key)
    if not refs: refs = resolve(refresh_index(), a.key)
    since = getattr(a, "since", None)
    if since is not None:
        # Live tail: only what was appended after the offset a previous read returned.
        if not refs:
            print(L.t(f"Not found: {a.key}", f"找不到 {a.key}"), file=sys.stderr); sys.exit(1)
        d = read_session_detail(refs[0], since=max(0, int(since)))
        return out(d, a.json, lambda d: print(L.t(f"+{len(d['messages'])} messages · {len(d['resolved'])} tools finished · offset {d['offset']}", f"+{len(d['messages'])} 条 · 已完成工具 {len(d['resolved'])} · offset {d['offset']}")))
    # Freeze the reply cursor before parsing the displayed content: a concurrently
    # appended reply must never be acknowledged before it was actually returned.
    st = {}
    if refs and E.get(refs[0]['agent']).activity_stream:
        from activity import read_stream, connect
        from contextlib import closing
        with closing(connect(DISPATCH_DIR)) as db, db:
            st = read_stream(db, refs[0]['path'], refs[0]['agent'])
    d = read_session_detail(refs[0]) if refs else remote_session_detail(a.key)
    if d and refs:
        from activity import workspace_changes, session_preferences, apply_preferences
        from attachments import catalog
        d['meta'] = apply_preferences(dict(d['meta']), session_preferences(DISPATCH_DIR).get(refs[0]['agent'] + ':' + refs[0]['session_id'], {}))
        siblings = [r for r in refs if (r['agent'],r['session_id']) == (refs[0]['agent'],refs[0]['session_id'])]
        assets = {}; messages = {}
        for ref in reversed(siblings):
            for asset in catalog(ref): assets[asset['id']] = asset
            part = d if ref['path'] == refs[0]['path'] else read_session_detail(ref)
            for message in part['messages']:
                key = (message['ts'],message['role'],message['text'],json.dumps(message.get('tools',[]),sort_keys=True))
                messages[key] = message
        d['attachments'] = list(assets.values())
        d['messages'] = sorted(messages.values(), key=lambda m: m['ts'])
        d['workspace'] = workspace_changes(refs[0]['cwd'])
        d['activity_version'] = st.get('version')
        d['reply_id'] = st.get('reply_id')
    if not d:
        print(L.t(f"Not found: {a.key}", f"找不到 {a.key}"), file=sys.stderr)
        sys.exit(1)
    if getattr(a, "brief", False):
        # The task page only lists what a linked conversation changed and produced; the whole
        # timeline would cross the bridge and be parsed by the window for nothing.
        d = {"meta": d["meta"], "files": d.get("files", []), "attachments": d.get("attachments", []), "messages": []}

    def text(d):
        m = d["meta"]
        print(f"{m['title'] or L.t('(untitled)', '(无标题)')}  ·  {m['agent']}  ·  {m['cwd']}  ·  {m['session_id']}")
        print(L.t(f"{m['user_msgs']} rounds · {len(m['subagents'])} sub-agents · {len(d['files'])} files changed", f"{m['user_msgs']} 轮 · 子 Agent {len(m['subagents'])} · 改动文件 {len(d['files'])}"))
        for s in m["subagents"]:
            print(L.t(f"  ↳ sub-agent {s['type']}: {s['description']}", f"  ↳ 子Agent {s['type']}: {s['description']}"))
        for f in d["files"]:
            print(L.t(f"  ✎ {f['path']}  ({len(f['changes'])} changes)", f"  ✎ {f['path']}  ({len(f['changes'])} 处)"))
        print(L.t("--- timeline ---", "--- 时间线 ---"))
        for x in d["messages"][-30:]:
            for b in x.get("blocks") or []:
                if b["type"] == "thinking":
                    print(f"[{x['role']}] 💭 {(b.get('text') or b.get('note') or '')[:120].replace(chr(10), ' ')}")
                elif b["type"] == "tool_call":
                    mark = {"done": "✓", "error": "✗", "running": "…", "incomplete": "?"}.get(b["status"], "")
                    print(f"[{x['role']}] ⚙ {b['name']} {b['summary'][:80]}  {mark}{(' ' + b['result'][:60].replace(chr(10), ' ')) if b.get('result') else ''}")
                else:
                    print(f"[{x['role']}] {b['text'][:160].replace(chr(10), ' ')}")
            if not x.get("blocks") and x.get("text"):
                print(f"[{x['role']}] {x['text'][:160].replace(chr(10), ' ')}")
    out(d, a.json, text)


def cmd_aside(a):
    """Ask about one hunk or one command of a session on the side (aside.py), list what was asked,
    or keep an answer in the wiki as a 做对 entry."""
    import aside as AS
    refs = resolve(load_index(), a.key) or resolve(refresh_index(), a.key)
    if not refs:
        return fail_json(a, L.t(f"No session {a.key}", f"找不到会话 {a.key}"))
    ref = refs[0]
    session = f"{ref['agent']}:{ref['session_id']}"
    if a.save:
        data = AS.load(DISPATCH_DIR, session)
        item = next((i for i in data["items"] if i.get("id") == a.save), None)
        if not item:
            return fail_json(a, L.t(f"No such follow-up question {a.save}", f"没有这条追问 {a.save}"))
        project = ref.get("project_override") or ref.get("project") or None
        text = f"{item['label'].split('（')[0]}：{item['q']}"
        key = WIKI_KINDS["win"]["prefix"] + "aside-" + item["id"]
        wiki_store(key, wiki_compose("win", text, {"why": re.sub(r"\s+", " ", item["answer"]).strip()}, project))
        item["saved"] = key
        AS.save(DISPATCH_DIR, session, data)
        return out(item, a.json, lambda i: print(L.t(f"Saved to the wiki: {key}", f"已存进 wiki：{key}")))
    if a.list:
        data = AS.load(DISPATCH_DIR, session)
        return out({"session": session, "items": data["items"]}, a.json,
                   lambda d: [print(L.t(f"[{i['label']}] Q: {i['q']}\n  A: {i['answer']}", f"[{i['label']}] 问：{i['q']}\n  答：{i['answer']}")) for i in d["items"]] or print(L.t("No follow-up questions yet", "还没追问过")))
    if not (a.hunk or a.tool) or not a.q:
        return fail_json(a, L.t("Usage: dispatch aside <session> --hunk <file>:<which change> | --tool <tool_id> -q \"question\"", "用法：dispatch aside <会话> --hunk <文件>:<第几处> | --tool <tool_id> -q \"问题\""))
    detail = read_session_detail(ref)
    try:
        item = AS.ask(detail, DISPATCH_DIR, session, a.q, hunk=a.hunk, tool=a.tool)
    except (LookupError, RuntimeError, subprocess.TimeoutExpired) as e:
        return fail_json(a, str(e) if not isinstance(e, subprocess.TimeoutExpired) else L.t("Haiku did not answer within two minutes; ask again later", "Haiku 两分钟没回答，稍后再问"))
    out(item, a.json, lambda i: print(i["answer"] + (L.t("\n(The context was too long; left out: " + ", ".join(i["cut"]) + ")", "\n（上下文太长，截掉了：" + "、".join(i["cut"]) + "）") if i["truncated"] else "")))


def fail_json(a, message):
    """An error the panel shows as is: one line on stderr (what the app's bridge passes on), plus
    {"error": …} on stdout with --json; exit 1."""
    if getattr(a, "json", False):
        print(json.dumps({"error": message}, ensure_ascii=False))
    print(message, file=sys.stderr)
    sys.exit(1)


def cmd_find(a):
    idx = refresh_index()
    refs = session_refs(idx, task_id=a.task)
    for r in refs:
        r["host"], r["host_name"] = "local", local_host_name()
    annotate_moves(refs)
    refs += [r for r in remote_refs() if a.task in (r.get("tasks") or {})]

    def text(refs):
        if not refs:
            print(L.t(f"No session mentions {a.task}", f"没有会话提到过 {a.task}"))
        for r in refs:
            print(f"{r['agent']:<12} {r.get('host_name') or '':<14} {r['project']:<18} {ago(r['last_at']):<5} {r.get('mentions', 0):>3}{L.t('x', '次')}  {r['title'] or ''}\n    {r['resume_cmd']}")
    out(refs, a.json, text)


def resolve(idx, key):
    """key may be a session id (prefix ok) or a task id."""
    if ':' in key:
        agent, sid = key.split(':', 1)
        return [r for r in session_refs(idx, session_id=sid) if r['agent'] == agent]
    if looks_like_task_id(key):
        return session_refs(idx, task_id=key)
    return session_refs(idx, session_id=key)


def refs_everywhere(key, on=""):
    """resolve() here plus the same id on the other Macs: [(host id, host name, ref)], one per host."""
    found = []
    if on not in ("", "local") and on != local_host_name():
        on = resolve_host_id(on) or on  # an old id or name (before a rename) still picks that Mac
    if on in ("", "local") or on == local_host_name():
        mine = [dict(r, host="local", host_name=local_host_name()) for r in resolve(refresh_index(), key)[:1]]
        found += [("local", local_host_name(), r) for r in annotate_moves(mine)]
    if on not in ("local",) and on != local_host_name() and not looks_like_task_id(key):
        agent, sid = key.split(":", 1) if ":" in key else ("", key)
        seen = set()
        for r in remote_refs():
            if r.get("session_id", "").startswith(sid) and (not agent or r.get("agent") == agent) and r["host"] not in seen:
                if not on or on in (r["host"], r.get("host_name")):
                    seen.add(r["host"])
                    found.append((r["host"], r.get("host_name"), r))
    return found


def pick_host(found, key, verb):
    """One candidate: take it. Several Macs run the same id (after `dispatch move`): list them and stop."""
    if len({h for h, _, _ in found}) <= 1:
        return found[0] if found else None
    print(L.t(f"{key} exists on {len(found)} Macs (it forked after a move); add --on to pick one:", f"{key} 在 {len(found)} 台电脑上都有（迁移后分叉了），加 --on 选一台："), file=sys.stderr)
    for hid, name, r in found:
        mark = L.t(f", moved to {r['moved_to_name']}", f"，已迁往 {r['moved_to_name']}") if r.get("moved_to") else L.t(f", moved here from {r['moved_from_name']}", f"，从 {r['moved_from_name']} 迁来") if r.get("moved_from") else ""
        print(L.t(f"  {name} ({hid}) · last {ago(r.get('last_at'))}{mark}\n    dispatch {verb} {key} --on {hid}", f"  {name}（{hid}）· 最近 {ago(r.get('last_at'))}{mark}\n    dispatch {verb} {key} --on {hid}"), file=sys.stderr)
    sys.exit(2)


def cmd_resume(a):
    hit = pick_host(refs_everywhere(a.key, getattr(a, "on", "")), a.key, "resume")
    if not hit:
        print(L.t(f"Not found: {a.key}", f"找不到 {a.key}"), file=sys.stderr)
        sys.exit(1)
    if P.IS_WIN and E.get(hit[2].get("agent")).desktop_app:
        P.unsupported(L.t(f"Resuming a {E.get(hit[2].get('agent')).name} session", f"{E.get(hit[2].get('agent')).name} 会话的恢复"))
    cmd = hit[2]["resume_cmd"]
    if a.copy:
        if P.IS_WIN:
            P.copy_to_clipboard(cmd)
        else:
            subprocess.run(["pbcopy"], input=cmd, text=True, encoding="utf-8", errors="replace")
        print(L.t(f"Copied to the clipboard: {cmd}", f"已复制到剪贴板：{cmd}"))
    else:
        print(cmd)


def host_app_of(pid, table):
    """Walk up from a pid to the .app that owns it (e.g. Ghostty hosting Herdr). Skips the
    `claude` CLI's own updater wrapper (~/.local/share/claude/ClaudeCode.app/…) — that's part
    of the agent's own process, not the terminal/editor hosting it — and keeps climbing past it
    for the real host."""
    if P.IS_WIN:
        label = win_host_app_of(pid, table)[0]
        if label:
            return label
    for _ in range(30):
        ent = table.get(pid)
        if not ent:
            return None
        ppid, comm = ent
        if "/.local/share/claude/" not in comm:
            m = re.search(r"/([^/]+)\.app/", comm)
            if m:
                return m.group(1)
        if ppid <= 1:
            return None
        pid = ppid


# Windows: the program that hosts an agent, by exe name (P.exe_base) up the parent chain.
WIN_HOST_EXES = {"windowsterminal": "Windows Terminal", "openconsole": "终端", "conhost": "终端", "code": "VS Code",
                 "cursor": "Cursor", "windsurf": "Windsurf", "wezterm-gui": "WezTerm", "alacritty": "Alacritty",
                 "warp": "Warp", "codex": "Codex 桌面端", "chatgpt": "Codex 桌面端", "claude": "Claude 桌面端", "herdr": "Herdr"}


def win_host_label(comm):
    """WIN_HOST_EXES label for one image path, or None. `claude.exe` only counts as the desktop app
    under %LOCALAPPDATA%\\AnthropicClaude (the CLI is claude.exe too); `codex.exe` only outside npm
    and ~/.local (the CLI again)."""
    base = P.exe_base(comm)
    label = WIN_HOST_EXES.get(base)
    path = P.to_slash(comm or "").lower()
    if base == "claude" and "/anthropicclaude/" not in path:
        return None
    if base == "codex" and ("/npm/" in path or "/node_modules/" in path or "/.local/" in path or "/" not in path):
        return None
    return label


def win_host_app_of(pid, table):
    """(label, pid of that program) for the first host program above `pid` (the process itself is
    skipped: it is the agent, or the Herdr client whose host we want); (None, None) when none."""
    ent = table.get(pid)
    for _ in range(30):
        if not ent:
            return None, None
        ppid = ent[0]
        if not ppid or ppid == pid:
            return None, None
        pid, ent = ppid, table.get(ppid)
        if ent:
            label = win_host_label(ent[1])
            if label:
                return label, pid
    return None, None


def activate(app_name, pid=None):
    """Bring an app to the front: `open -a` on macOS; on Windows the top window of `pid`, or of the
    first running process whose WIN_HOST_EXES label is `app_name` (failure is ignored)."""
    if not app_name and not pid:
        return
    if not P.IS_WIN:
        sh(["open", "-a", app_name], timeout=5)
        return
    try:
        import winproc
        if not pid:
            pid = next((p for p, (_, comm) in P.ps_table().items() if win_host_label(comm) == app_name), None)
        if pid:
            winproc.bring_to_front(pid)
    except Exception as e:
        debug("activate", e)


# ---------------------------------------------------------------- skills

def read_frontmatter(skill_dir):
    p = os.path.join(skill_dir, "SKILL.md")
    fm = {"name": os.path.basename(skill_dir), "description": ""}
    try:
        with open(p, encoding="utf-8") as f:
            txt = f.read(4000)
        if txt.startswith("---"):
            body = txt.split("---", 2)[1]
            key = None
            for line in body.splitlines():
                if line[:1] not in (" ", "\t") and ":" in line:
                    k, v = line.split(":", 1)
                    key = k.strip()
                    v = v.strip()
                    fm[key] = "" if v in (">", "|", ">-", "|-") else v.strip('"').strip("'")
                elif key and line.strip():
                    # continuation of a folded / literal / indented multi-line value
                    fm[key] = (fm[key] + " " + line.strip()).strip()
            for k in fm:
                if isinstance(fm[k], str):
                    fm[k] = re.sub(r"\s+", " ", fm[k]).strip('"').strip("'")
    except Exception:
        pass
    return fm


def mounted(agent):
    """name -> (mount path, real path) for every skill an agent can see."""
    res = {}
    for d in AGENT_SKILL_DIRS[agent]:
        if not os.path.isdir(d):
            continue
        for n in os.listdir(d):
            p = os.path.join(d, n)
            if os.path.isdir(p) and not n.startswith(".") and n not in res:
                res[n] = (p, os.path.realpath(p))
    return res


def all_skills():
    from customizations import is_builtin_skill
    names = {}
    if os.path.isdir(POOL):
        for n in sorted(os.listdir(POOL)):
            if os.path.isdir(os.path.join(POOL, n)) and not n.startswith("_") and not n.startswith("."):
                names[n] = os.path.join(POOL, n)
    m = {ag: mounted(ag) for ag in AGENT_SKILL_DIRS}
    for ag in m:
        for n, (_, real) in m[ag].items():
            names.setdefault(n, real)
    usage, last = skill_usage()
    rows = []
    for n, path in sorted(names.items()):
        fm = read_frontmatter(path)
        rows.append({"name": n, "path": path, "in_pool": path.startswith(POOL), "description": fm.get("description", ""), "agents": {ag: n in m[ag] for ag in m}, "mounts": {ag: (m[ag][n][0] if n in m[ag] else None) for ag in m},
                     "usage": usage.get(n, {}), "last_used": last.get(n, ""), "builtin": is_builtin_skill(n, path)})
    return rows


def skill_usage():
    """Per-skill invocation counts by agent, from the transcript index. Claude Code records
    Skill tool and slash-command calls; Codex records reads of a skill's SKILL.md (it has no
    Skill tool); ZCode records its Skill tool calls."""
    usage, last = {}, {}
    for e in (load_index() or {}).values():
        for k, v in (e.get("skills") or {}).items():
            n = k.lstrip("/")
            usage.setdefault(n, {})
            usage[n][e["agent"]] = usage[n].get(e["agent"], 0) + int(v or 0)
            ts = (e.get("last_ts") or "")[:10]
            if ts > last.get(n, ""):
                last[n] = ts
    return usage, last


def cmd_skills_improve(a):
    """A ready-to-run agent task: review the skills actually used recently against the
    recent sessions and improve them. Printed (and copied) rather than executed, so the
    user picks which agent runs it."""
    days = a.days or 14
    rows = all_skills()
    used = sorted([r for r in rows if r["usage"]], key=lambda r: -sum(r["usage"].values()))
    top = ", ".join(f"{r['name']}({sum(r['usage'].values())})" for r in used[:10]) or L.t("(the index has no skill use yet)", "（索引里还没有技能调用记录）")
    prompt = L.t(
        f"Improve the skills from how I worked over the last {days} days. Steps: 1) `dispatch stats --days {days} --json` for each agent's tools, skills and projects; "
        f"`dispatch list --limit 40 --json` for recent sessions, and `dispatch session <id>` to read the parts about skills (where a skill was bypassed, where by-hand work repeated what a skill should do). "
        f"2) The most used skills: {top}. Read each one's SKILL.md (`dispatch skills path <name>`) against the sessions and find stale paths or commands, missing trigger words, wordy parts. "
        f"3) For work done by hand again and again that no skill covers, propose a new skill (ask me once first). "
        f"4) Change SKILL.md directly (skill pool {POOL.replace(HOME, '~')}), one commit per skill, no AI attribution; afterwards record one thing that worked with `dispatch wiki add --kind win`. "
        f"5) Finish with a table: skill, what changed, why. Start a task with dispatch begin before you change anything.",
        f"根据我最近 {days} 天的工作流改进技能。步骤：1) `dispatch stats --days {days} --json` 看各 Agent 的工具/技能/项目分布；"
              f"`dispatch list --limit 40 --json` 找最近会话，用 `dispatch session <id>` 读其中和技能相关的几段（哪里绕过了技能、哪里重复手工做了技能该做的事）。"
              f"2) 最常用技能：{top}。逐个读 `dispatch skills path <name>` 的 SKILL.md，对照会话找过时的路径/命令、缺失的触发词、写得啰嗦的部分。"
              f"3) 最近反复手工做、但没有技能覆盖的流程，提议新技能（先问我一次要不要）。"
              f"4) 直接改 SKILL.md（技能池 {POOL.replace(HOME, '~')}），每个技能一个 commit，不带 AI 署名；改完 `dispatch wiki add --kind win` 记一条做对的做法。"
              f"5) 最后给我一张表：技能、改了什么、为什么。用 dispatch begin 建任务再动手。")
    cmd = f"cd {P.shell_quote(POOL)} && claude {json.dumps(prompt, ensure_ascii=False)}"
    if a.copy:
        P.copy_to_clipboard(cmd)
    out({"prompt": prompt, "command": cmd, "top": [{"name": r["name"], "usage": r["usage"], "last_used": r["last_used"]} for r in used[:10]]}, a.json,
        lambda o: print(prompt + L.t("\n\nCommand to start it" + (" (copied)" if a.copy else "") + ":\n", "\n\n启动命令" + ("（已复制）" if a.copy else "") + "：\n") + cmd))


# A new skill starts from the same four fields every useful SKILL.md has: the name and the
# one-line trigger in the frontmatter, then 触发条件 / 关键约束 in the body. Anything longer is
# the agent's job to fill in once the skill is actually used.
SKILL_TEMPLATE = '''---
name: {name}
description: "{description}"
---

# {name}

{description}

## {when_heading}

- {trigger}

## {rules_heading}

- {constraint}
'''


def skill_template(**fields):
    """SKILL_TEMPLATE in the person's language: the headings of a new skill's two sections."""
    return SKILL_TEMPLATE.format(when_heading=L.t("When to use", "触发条件"), rules_heading=L.t("Key constraints", "关键约束"), **fields)


def safe_skill_name(n):
    """A skill is a folder in the pool: no separators, no leading dot, keep CJK."""
    n = (n or "").strip()
    if not n or n in (".", "..") or n.startswith("."):
        return ""
    if not re.fullmatch(r"[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff._-]*", n):
        return ""
    return n


def want_agents(a):
    """--agent may repeat (registered engine ids or all); none = create without mounting."""
    raw = a.agent if isinstance(a.agent, list) else ([a.agent] if a.agent else [])
    if "all" in raw:
        return list(AGENT_SKILL_DIRS)
    picked = []
    for x in raw:
        if x in AGENT_SKILL_DIRS and x not in picked:
            picked.append(x)
    return picked


def win_recycle(path):
    """Windows: send a folder to the Recycle Bin through .NET's VisualBasic FileSystem. False on failure."""
    ps = ("Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory("
          + P.shell_quote(path) + ", 'OnlyErrorDialogs', 'SendToRecycleBin')")
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True, timeout=60,
                           creationflags=P.no_window_flags())
        return r.returncode == 0 and not os.path.exists(path)
    except Exception as e:
        debug("win_recycle", e)
        return False


def mount_skill(name, path, agents):
    """Symlink the skill into each agent's first skills dir (what `skills enable` does)."""
    mounts = {}
    for ag in agents:
        seen = mounted(ag).get(name) if E.get(ag).reads_shared_skills else None
        if seen:
            # OpenCode already reads it from Claude Code's or the shared folder
            cc_switch_flag(name, ag, True)
            mounts[ag] = seen[0]
            continue
        d = AGENT_SKILL_DIRS[ag][0]
        os.makedirs(d, exist_ok=True)
        link = os.path.join(d, name)
        if not (P.is_link(link) or os.path.exists(link)):
            P.mount_link(path, link)  # a symlink; a directory junction on Windows
        cc_switch_flag(name, ag, True)
        mounts[ag] = link
    return mounts


def cmd_skills_new(a):
    name = safe_skill_name(a.name)
    if not name:
        print("Invalid skill name. Use letters, numbers, CJK characters, dots, underscores or hyphens; no slashes or leading dot.", file=sys.stderr)
        sys.exit(2)
    dest = os.path.join(POOL, name)
    if os.path.exists(dest):
        print(f"{name} already exists ({dest}). Choose another name, or remove it from the Skills page first.", file=sys.stderr)
        sys.exit(2)
    description = (a.description or "").strip() or L.t(f"Use when the person wants to do something about {name}.", f"用户要做{name}相关的事时用。")
    body = skill_template(
        name=name,
        description=description.replace('"', "'"),
        trigger=(a.trigger or L.t(f"The person clearly asks for something about {name}.", f"用户明确要做{name}相关的事时用。")).strip(),
        constraint=(a.constraint or L.t("Check the real paths and commands on this Mac first; write only what a model cannot work out by itself.", "先确认本机实际路径与命令；只写模型推不出来的内容。")).strip(),
    )
    os.makedirs(dest, exist_ok=True)
    with open(os.path.join(dest, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write(body)
    agents = want_agents(a)
    mounts = mount_skill(name, dest, agents)
    res = {"name": name, "path": dest, "description": description, "agents": agents, "mounts": mounts}
    out(res, a.json, lambda r: print(L.t(f"Created {r['name']}: {r['path']}", f"已新建 {r['name']}：{r['path']}") +
                                     (L.t(f"\nGiven to {', '.join(r['agents'])} (new sessions see it)", f"\n已挂给 {', '.join(r['agents'])}（新会话生效）") if r["agents"]
                                      else L.t("\nNot given to any agent yet: tick it on the Skills page", "\n还没挂给任何 Agent——在技能页勾选即可"))))


# ---- import a skill from a public GitHub repo ----

GH_URL_RE = re.compile(r"^https?://(?:www\.)?github\.com/([^/]+)/([^/]+?)(?:\.git)?(?:/tree/([^/]+)(?:/(.*))?)?/?$")
GH_RAW_RE = re.compile(r"^https?://raw\.githubusercontent\.com/([^/]+)/([^/]+)/([^/]+)/(.+)$")


def parse_github_ref(url):
    """owner/repo[@branch][/sub/path] or a GitHub URL → (owner, repo, branch, subpath)."""
    u = (url or "").strip().rstrip("/")
    if not u:
        return None
    m = GH_RAW_RE.match(u)
    if m:
        owner, repo, branch, path = m.groups()
        return owner, repo, branch, os.path.dirname(path)
    m = GH_URL_RE.match(u)
    if m:
        owner, repo, branch, path = m.group(1), m.group(2), m.group(3) or "", (m.group(4) or "").strip("/")
        return owner, repo, branch, path
    m = re.match(r"^([\w.-]+)/([\w.-]+?)(?:@([\w.-]+))?(?:/(.+))?$", u)
    if m:
        return m.group(1), m.group(2), m.group(3) or "", (m.group(4) or "").strip("/")
    return None


def gh_fetch_text(url, timeout=20):
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "dispatch-skill-import", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def github_default_branch(owner, repo):
    try:
        return json.loads(gh_fetch_text(f"https://api.github.com/repos/{owner}/{repo}")).get("default_branch") or ""
    except Exception:
        return ""


def download_repo(owner, repo, branch):
    """codeload tarball → a temp dir. Tries the given branch, then main/master, then the API default."""
    import urllib.request
    tried, errors = [], []
    for b in ([branch] if branch else []) + ["main", "master", github_default_branch(owner, repo)]:
        b = (b or "").strip()
        if not b or b in tried:
            continue
        tried.append(b)
        tmp = tempfile.mkdtemp(prefix="dispatch-skill-")
        tgz = os.path.join(tmp, "repo.tar.gz")
        try:
            req = urllib.request.Request(f"https://codeload.github.com/{owner}/{repo}/tar.gz/refs/heads/{b}", headers={"User-Agent": "dispatch-skill-import"})
            with urllib.request.urlopen(req, timeout=300) as r, open(tgz, "wb") as f:
                shutil.copyfileobj(r, f)
            with tarfile.open(tgz, "r:gz") as tf:
                try:
                    tf.extractall(tmp, filter="data")   # Python 3.12+ guards path traversal
                except TypeError:
                    tf.extractall(tmp)
            os.remove(tgz)
            roots = [os.path.join(tmp, n) for n in os.listdir(tmp)]
            root = next((p for p in roots if os.path.isdir(p)), tmp)
            return os.path.realpath(root), b, tmp
        except Exception as e:
            errors.append(f"{b}: {e}")
            shutil.rmtree(tmp, ignore_errors=True)
    raise RuntimeError(f"Could not download {owner}/{repo} (tried {', '.join(tried) or 'the default branch'}). Check the repository URL and public access." +
                       ("\n" + "\n".join(errors[:3]) if errors else ""))


def find_skill_dirs(root, subpath=""):
    base = os.path.realpath(os.path.join(root, subpath)) if subpath else os.path.realpath(root)
    if not os.path.isdir(base) or not base.startswith(os.path.realpath(root)):
        return []
    hits = []
    for dp, dns, fns in os.walk(base):
        dns[:] = [d for d in dns if d not in (".git", "node_modules", "__pycache__")]
        if "SKILL.md" in fns:
            hits.append(dp)
    return hits


def repo_license(root, sub=""):
    for base in ([sub, root] if sub and sub != root else [root]):
        for n in ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "COPYING.md"):
            if os.path.isfile(os.path.join(base, n)):
                return os.path.join(base, n)
    return ""


def add_frontmatter_source(skill_md, url):
    """Record where an imported skill came from, without touching the rest of the file."""
    try:
        txt = open(skill_md, encoding="utf-8").read()
    except Exception:
        return
    if re.search(r"^source:", txt, re.M) or not txt.startswith("---"):
        return
    end = txt.find("\n---", 3)
    if end < 0:
        return
    open(skill_md, "w", encoding="utf-8").write(txt[:end + 1] + f"source: {url}\n" + txt[end + 1:])


def cmd_skills_import(a):
    ref = parse_github_ref(a.name)
    if not ref:
        print(f"Invalid repository: {a.name}. Use owner/repo or https://github.com/owner/repo[/tree/branch/path]", file=sys.stderr)
        sys.exit(2)
    owner, repo, branch, subpath = ref
    subpath = (a.path or subpath or "").strip("/")
    src_url = a.name.strip() if str(a.name).strip().startswith("http") else \
        f"https://github.com/{owner}/{repo}" + (f"/tree/{branch}/{subpath}" if branch and subpath else (f"/tree/{branch}" if branch else ""))
    root, used_branch, tmp = download_repo(owner, repo, branch)
    try:
        hits = find_skill_dirs(root, subpath)
        if a.path and not hits:
            print(f"No skill directory at {a.path} in this repository (SKILL.md is required)", file=sys.stderr)
            sys.exit(2)
        want = safe_skill_name(a.as_name) or repo
        if hits:
            src = next((h for h in hits if os.path.basename(h) == want), None) \
                or next((h for h in hits if read_frontmatter(h).get("name") == want), None) \
                or (hits[0] if len(hits) == 1 else None)
            if src is None:
                rels = "、".join(os.path.relpath(h, root) for h in hits[:12])
                print(f"This repository has multiple skills. Choose one with --path: {rels}", file=sys.stderr)
                sys.exit(2)
        else:
            src = None
        fm = read_frontmatter(src) if src else {}
        target = safe_skill_name(a.as_name or fm.get("name") or (os.path.basename(src) if src else "")) or \
            safe_skill_name(re.sub(r"[^A-Za-z0-9\u4e00-\u9fff._-]+", "-", repo).strip("-")) or repo
        dest = os.path.join(POOL, target)
        if os.path.exists(dest):
            if not a.force:
                print(f"{target} already exists ({dest}). Use --as to choose a name, or --force to replace it.", file=sys.stderr)
                sys.exit(2)
            _mod("backups").save(dest, move=True)
        os.makedirs(POOL, exist_ok=True)
        if src:
            shutil.copytree(src, dest, ignore=shutil.ignore_patterns(".git", "__pycache__", "node_modules"))
        else:
            os.makedirs(dest, exist_ok=True)
        lic = repo_license(root, src or "")
        lic_name = os.path.basename(lic) if lic else ""
        if lic and not os.path.exists(os.path.join(dest, lic_name)):
            shutil.copy2(lic, os.path.join(dest, lic_name))
        prov = [L.t(f"Source: {src_url}", f"来源：{src_url}"), L.t(f"Repository: {owner}/{repo}", f"仓库：{owner}/{repo}") + (L.t(f" (branch {used_branch})", f"（分支 {used_branch}）") if used_branch else "")]
        if subpath:
            prov.append(L.t(f"Folder: {subpath}", f"目录：{subpath}"))
        prov.append(L.t(f"License: {lic_name} (copied along)", f"许可证：{lic_name}（已一并复制）") if lic else L.t("License: the repository has no LICENSE; check before you use it", "许可证：仓库里没找到 LICENSE，使用前自己确认"))
        if src:
            add_frontmatter_source(os.path.join(dest, "SKILL.md"), src_url)
            with open(os.path.join(dest, "SOURCE.md"), "w", encoding="utf-8") as f:
                f.write(L.t("# Source", "# 来源") + "\n\n" + "\n".join(f"- {p}" for p in prov) + "\n")
        else:
            # No SKILL.md in the repo: write the entry point ourselves, the way skill-from-github
            # would — point at the project, keep the licence and the source, let the agent extract.
            description = (a.description or "").strip() or L.t(f"Use when the person wants to work the way {owner}/{repo} does.", f"用户要参考 {owner}/{repo} 的做法时用。")
            body = skill_template(name=target, description=description.replace('"', "'"),
                                  trigger=L.t(f"The person wants something {owner}/{repo} solves, or to borrow how it does it.", f"用户要做 {owner}/{repo} 能解决的事、想借用它的做法时用。"),
                                  constraint=L.t("Extract only the interfaces, formats and pitfalls a model cannot work out; do not copy the repository's docs; follow the license below.", "只提炼模型推不出来的接口/格式/坑，不要照抄整仓文档；遵守下面的许可证。"))
            body += L.t("\n## Source and what to extract\n\n", "\n## 来源与提炼\n\n") + "\n".join(f"- {p}" for p in prov) + \
                    L.t("\n\nRead the repository's README, core scripts and examples, and write the reusable ways of working into this skill.\n",
                        "\n\n读仓库里的 README、核心脚本和示例，把可复用的做法写进本技能。\n")
            with open(os.path.join(dest, "SKILL.md"), "w", encoding="utf-8") as f:
                f.write(body)
        agents = want_agents(a)
        mounts = mount_skill(target, dest, agents)
        res = {"name": target, "path": dest, "source": src_url, "branch": used_branch, "license": lic_name,
               "generated": not bool(src), "agents": agents, "mounts": mounts}
        out(res, a.json, lambda r: print(L.t(f"Imported {r['name']}: {r['path']}", f"已导入 {r['name']}：{r['path']}") +
                                         (L.t(" (the repository has no SKILL.md; an entry point was written, still to be filled in)", "（仓库里没有 SKILL.md，已生成入口待提炼）") if r["generated"] else "") +
                                         (L.t(f"\nGiven to {', '.join(r['agents'])} (new sessions see it)", f"\n已挂给 {', '.join(r['agents'])}（新会话生效）") if r["agents"] else "")))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def cc_switch_flag(name, agent, on):
    """Keep cc-switch's own switches in step, for people who use it. Without its database there
    is nothing to update (and sqlite3.connect would create an empty one)."""
    if os.environ.get("DISPATCH_E2E_INSTANCE") or not os.path.isfile(CC_SWITCH_DB):
        return
    try:
        import sqlite3
        col = "enabled_" + re.sub(r"\W", "", agent)
        con = sqlite3.connect(CC_SWITCH_DB, timeout=2)
        if col not in {r[1] for r in con.execute("pragma table_info(skills)")}:
            con.close()
            return  # an engine CC Switch has no column for
        con.execute(f"update skills set {col}=?, updated_at=? where name=?", (1 if on else 0, int(time.time()), name))
        con.commit()
        con.close()
    except Exception as e:
        debug("cc_switch_flag", e)


def cmd_skills(a):
    if a.op == "roots":
        # Folders a skill file may be edited in: the pool, each agent's skills folder, and the workspace
        # roots (project-local skills). The desktop shell and the phone server both ask here.
        roots = [POOL] + [d for dirs in AGENT_SKILL_DIRS.values() for d in dirs]
        try:
            roots += [os.path.expanduser(r) for r in (settings_load().get("workspace_roots") or [])]
        except Exception:
            pass
        print("\n".join(dict.fromkeys(os.path.realpath(r) for r in roots)))
        return
    if a.op == "improve":
        return cmd_skills_improve(a)
    if a.op == "new":
        return cmd_skills_new(a)
    if a.op in ("import", "install"):
        return cmd_skills_import(a)
    if a.op == "find":
        import skills_find
        return skills_find.cmd(a, all_skills, out)
    if a.op == "list":
        rows = all_skills()
        only = want_agents(a)
        if only:
            rows = [r for r in rows if any(r["agents"].get(x) for x in only)]
        if a.query:
            q = a.query.lower()
            rows = [r for r in rows if q in r["name"].lower() or q in r["description"].lower()]

        def text(rows):
            for r in rows:
                flags = " ".join(f"{ag}{'✓' if on else '·'}" for ag, on in r["agents"].items())
                print(f"{r['name']:<32} {flags:<16} {r['description'][:70]}")
            print(f"\n{len(rows)} skills (✓ = enabled for this agent)")
        out(rows, a.json, text)
        return
    rows = {r["name"]: r for r in all_skills()}
    r = rows.get(a.name)
    if not r:
        print(f"Skill {a.name} not found. Use `dispatch skills list` to see available skills.", file=sys.stderr)
        sys.exit(1)
    if r.get("builtin") and a.op in ("trash", "write"):
        print("This skill is installed by Dispatch and is read-only.", file=sys.stderr)
        sys.exit(2)
    # A skill is a folder: SKILL.md plus whatever it links to (detail-*.md, references/…).
    # --file picks one of those; it must stay inside the skill folder.
    def skill_file(rel):
        rel = (rel or "SKILL.md").lstrip("/")
        full = os.path.realpath(os.path.join(r["path"], rel))
        if not full.startswith(os.path.realpath(r["path"]) + os.sep) and full != os.path.realpath(os.path.join(r["path"], "SKILL.md")):
            print(f"{rel} is outside the skill directory", file=sys.stderr)
            sys.exit(2)
        return full
    if a.op == "path":
        print(skill_file(a.file))
    elif a.op == "show":
        if a.json:
            files = sorted(os.path.relpath(os.path.join(dp, fn), r["path"]) for dp, _, fns in os.walk(r["path"]) for fn in fns if fn.endswith((".md", ".txt", ".py", ".sh", ".json", ".yaml", ".yml")) and not fn.endswith(".bak") and not any(seg.startswith(".") for seg in dp[len(r["path"]):].split(os.sep)))
            print(json.dumps(slash_paths({**r, "files": files}) if P.IS_WIN else {**r, "files": files}, ensure_ascii=False, indent=2))
        else:
            print(open(skill_file(a.file), encoding="utf-8").read())
    elif a.op == "open":
        if P.IS_WIN:
            P.open_path(skill_file(a.file), reveal=bool(a.reveal))
        else:
            subprocess.run(["open", "-R", skill_file(a.file)] if a.reveal else ["open", skill_file(a.file)])
    elif a.op == "trash":
        # Unmount everywhere, then move the folder to the Trash (Finder), so it is recoverable.
        import shutil
        real = os.path.realpath(r["path"])
        for ag, dirs in AGENT_SKILL_DIRS.items():
            for d in dirs:
                p = os.path.join(d, a.name)
                if P.is_link(p):
                    P.unlink_link(p)
        if not real.startswith(os.path.realpath(POOL) + os.sep):
            print(f"{a.name} is outside the skill pool ({real}). Mounts removed; skill files kept.", file=sys.stderr)
            sys.exit(2)
        if P.IS_WIN:
            if not win_recycle(real):
                trash = os.path.join(HOME, ".dispatch-trash")
                os.makedirs(trash, exist_ok=True)
                shutil.move(real, os.path.join(trash, f"{os.path.basename(real)}-{int(time.time())}"))
                if P.is_link(r["path"]):
                    P.unlink_link(r["path"])
                print(L.t(f"{a.name} moved to {trash} (the Recycle Bin is not available; drag it back to {POOL} to restore it)", f"{a.name} 已移到 {trash}（回收站不可用；拖回 {POOL} 即可恢复）"))
                return
        else:
            script = f'tell application "Finder" to delete POSIX file "{real}"'
            code, o, e = sh(["osascript", "-e", script], timeout=20)
            if code != 0:
                trash = os.path.join(HOME, ".Trash", os.path.basename(real))
                shutil.move(real, trash)
        if P.is_link(r["path"]):
            P.unlink_link(r["path"])
        bin_ = L.t('the Recycle Bin' if P.IS_WIN else 'the Trash', '回收站' if P.IS_WIN else '废纸篓')
        print(L.t(f"{a.name} moved to {bin_} (drag it back from {bin_} to {POOL} to restore it)", f"{a.name} 已移到{bin_}（可从{bin_}拖回 {POOL}）"))
    elif a.op == "write":
        new = sys.stdin.read()
        if not new.strip():
            print("stdin is empty; nothing was written", file=sys.stderr)
            sys.exit(2)
        f = skill_file(a.file)
        kept = _mod("backups").save(f)
        os.makedirs(os.path.dirname(f), exist_ok=True)
        open(f, "w", encoding="utf-8").write(new)
        where = kept.replace(HOME, "~", 1) if kept else ""
        print(L.t(f"{a.name}/{os.path.relpath(f, r['path'])} saved" + (f" (the old one is in {where})" if where else " (git keeps the old one)" if os.path.exists(f) else ""),
                  f"{a.name}/{os.path.relpath(f, r['path'])} 已保存" + (f"（旧版在 {where}）" if where else "（旧版在 git 里）" if os.path.exists(f) else "")))
    elif a.op in ("enable", "disable"):
        agents = want_agents(a) or list(AGENT_SKILL_DIRS)
        for ag in agents:
            existing = mounted(ag).get(a.name)
            if a.op == "enable":
                if existing:
                    print(f"{ag}: already enabled ({existing[0]})")
                else:
                    d = AGENT_SKILL_DIRS[ag][0]
                    os.makedirs(d, exist_ok=True)
                    link = os.path.join(d, a.name)
                    P.mount_link(r["path"], link)
                    print(f"{ag}: enabled {link} -> {r['path']}")
                cc_switch_flag(a.name, ag, True)
            else:
                if not existing:
                    print(f"{ag}: already disabled")
                elif E.get(ag).reads_shared_skills and os.path.dirname(existing[0]) != AGENT_SKILL_DIRS[ag][0]:
                    # OpenCode sees it in Claude Code's or the shared folder: unmounting there takes it from them too
                    print(f"{ag}: OpenCode reads this skill from {os.path.dirname(existing[0])}, shared with other agents. The shared mount is unchanged. "
                          f"To disable it for all agents: dispatch skills disable {a.name} --agent all")
                elif P.is_link(existing[0]):
                    P.unlink_link(existing[0])
                    print(f"{ag}: disabled (skill files remain at {r['path']})")
                else:
                    print(f"{ag}: {existing[0]} is a directory. Move it into the skill pool at {POOL}, then enable it as a link.")
                cc_switch_flag(a.name, ag, False)
        print("Restart agent sessions to apply skill changes.")


# ---------------------------------------------------------------- task workflow (begin / log / done)

def bd_json(argv):
    code, o, err = sh(["bd"] + argv)
    if code != 0:
        print(err.strip() or o.strip(), file=sys.stderr)
        sys.exit(code)
    j = o[o.find("[") if o.find("[") >= 0 and (o.find("{") < 0 or o.find("[") < o.find("{")) else o.find("{"):]
    try:
        d = json.loads(j)
        return d[0] if isinstance(d, list) and d else d
    except Exception:
        return {}


def cmd_task(a):
    issue = bd_json(['show', a.task, '--json'])
    if not issue or not issue.get('id'): raise ValueError(L.t('No such task', '任务不存在'))
    labels = issue.get('labels', [])
    trashed = 'dispatch:trashed' in labels
    if (a.op == 'trash') == trashed:
        return out({'id': a.task, 'unchanged': True}, a.json, lambda _: print(L.t('Nothing changed', '状态未变')))
    argv = ['update', a.task]
    if a.op == 'trash':
        argv += ['--status', 'deferred', '--add-label', 'dispatch:trashed', '--add-label', 'dispatch:previous:' + issue['status']]
    else:
        previous = next((x.split(':', 2)[2] for x in labels if x.startswith('dispatch:previous:')), 'open')
        if previous not in ('open', 'in_progress', 'blocked', 'closed', 'deferred'): previous = 'open'
        argv += ['--status', previous, '--remove-label', 'dispatch:trashed']
        for label in labels:
            if label.startswith('dispatch:previous:'): argv += ['--remove-label', label]
    result = bd_json([*argv, '--json'])
    out(result, a.json, lambda _: print(L.t('Moved to the trash', '已移到回收站') if a.op == 'trash' else L.t('Task restored', '已恢复任务')))


def similar(a_, b_):
    import difflib
    return difflib.SequenceMatcher(None, a_.lower(), b_.lower()).ratio()


def begin_warnings(title, project, cwd):
    """Things worth knowing before creating a task: someone already on something alike, or in this directory."""
    warns = []
    code, o, err = sh(["bd", "list", "--status", "in_progress", "--json"])
    try:
        for t in (json.loads(o[o.find("["):]) if code == 0 else []):
            proj = next((l.split(":", 1)[1] for l in t.get("labels") or [] if l.startswith("project:")), "")
            if project and proj and proj != project:
                continue
            if similar(title, t.get("title", "")) >= 0.5:
                if "from-chat" in (t.get("labels") or []):
                    # noted from the person's words in another conversation (claim_noted would have handed it over
                    # if it were this one's): that conversation's agent does it, this one does not take it
                    warns.append(f"\"{t.get('title', '')}\" ({t['id']}) looks like this one and is what the person asked for in another conversation; that conversation's agent does it. If this is the same work, tell the person instead of doing it twice.")
                    continue
                warns.append(f"\"{t.get('title', '')}\" ({t['id']}, {t.get('assignee') or '?'}) is in progress and looks like this one. Check it with `bd show {t['id']}`; if it is the same work, `dispatch claim {t['id']}` or agree on a split.")
    except Exception:
        pass
    for s_ in neighbours(cwd, session_self(), skip_pids=ancestor_pids())[:4]:
        warns.append(f"{s_['agent']} {s_['session_id'][:8]} is working in this folder (active {ago(s_.get('last_at') or 0)} ago): leave the files it is changing alone. `dispatch session {s_['session_id'][:8]}` shows what it is doing.")
    return warns


def _in_chat_session(a):
    """`dispatch begin` from an agent whose session has no project folder (Chats: dispatch_dir.chats_folder). A
    person at a terminal who names a project gets it, wherever they are."""
    import dispatch_dir
    return bool(getattr(a, "session", None) or session_from_env()) and dispatch_dir.chats_folder(os.getcwd())


def _noted_for_chat(issue, sid=""):
    """A task Dispatch noted from the person's message as what that conversation does now and claimed on its behalf,
    not yet taken by an agent (capture.py `chat.now`): the agent in that conversation (`sid`) takes it, no refusal.
    An agent in another conversation does not (task-lj06.17)."""
    if "from-chat" not in (issue.get("labels") or []):
        return False
    m = issue.get("metadata")
    if isinstance(m, str):
        try:
            m = json.loads(m)
        except ValueError:
            m = {}
    m = m if isinstance(m, dict) else {}
    chat = m.get("chat") if isinstance(m.get("chat"), dict) else {}
    if not (bool(chat.get("now")) and not chat.get("taken")):
        return False
    C = _mod("capture")
    C.D = _THIS
    return C.whose(issue, sid) != "other"


def cmd_claim(a):
    """Claim a task, refusing to steal one that another actor is already working on (unless --force)."""
    issue = bd_json(["show", a.task, "--json"])
    actor = os.environ.get("BEADS_ACTOR") or ""
    owner = issue.get("assignee") or ""
    name = issue.get("title") or a.task
    sid = session_self() or ""
    sid = sid if _SID_RE.fullmatch(sid) else ""
    noted_here = _noted_for_chat(issue, sid)
    # what the person asked for in a conversation is that conversation's: an agent of the same engine in another one
    # signs with the same board name, so the holder alone does not tell (capture claims under the agent's name)
    # Only what a conversation said it is doing now (chat.now), and only when this session is known: a task noted for
    # later and started by Next up in a session of its own, or a claim with no session id, goes by the holder as before
    elsewhere = False
    if "from-chat" in (issue.get("labels") or []) and issue.get("status") == "in_progress" and not a.force and not noted_here and sid:
        C = _mod("capture")
        C.D = _THIS
        elsewhere = bool(C.chat_of(issue).get("now")) and C.whose(issue, sid) == "other"
    if ((owner and owner != actor) or elsewhere) and issue.get("status") == "in_progress" and not a.force and not noted_here:
        if "from-chat" in (issue.get("labels") or []):
            print(L.t(f"\"{name}\" ({a.task}) is what the person asked for in another conversation, and that conversation's agent does it. Leave it to that conversation; to take it anyway, add --force.",
                      f"「{name}」（{a.task}）是用户在另一个会话里要的，由那个会话的 Agent 做。留给那个会话；一定要接手加 --force。"), file=sys.stderr)
            sys.exit(3)
        print(f"\"{name}\" ({a.task}) is claimed by {owner} and in progress. Agree on a split first (`dispatch find {a.task}` shows which session); to take it anyway, add --force.", file=sys.stderr)
        sys.exit(3)
    if noted_here:
        # Dispatch claimed it for the agent in that conversation (capture.py): that agent takes it over
        # bd guards a task someone holds: Dispatch claimed it on this conversation's behalf, so its agent takes it over
        bd_json(["update", a.task, "--assignee", actor or whoami(), "--status", "in_progress", "--set-metadata", "claim_session=" + sid, "--force", "--json"])
        C = _mod("capture")
        C.D = _THIS
        C.taken(a.task)
    elif owner and owner != actor:
        # taken over (--force, or a task held but not in progress): bd's --claim refuses a task someone else holds, and
        # bd's own guard wants --force for it
        bd_json(["update", a.task, "--assignee", actor or whoami(), "--status", "in_progress", "--set-metadata", "claim_session=" + sid, "--force", "--json"])
    else:
        bd_json(["update", a.task, "--claim", "--set-metadata", "claim_session=" + sid, "--json"])
    link_session(a.task, sid=sid, labels=issue.get("labels") or [])
    print(f"\"{name}\" ({a.task}) claimed" + (f" (taken over from {owner})" if owner and owner != actor else ""))


# A task card is read by a person weeks later, cold. The title must say what changes and why;
# the description must carry the trigger. Vague titles are refused so the board stays readable.
_VAGUE_TITLES = re.compile(r"^(修复|修改|优化|改进|更新|调整|处理|完善|继续|测试|检查|fix|update|improve|refactor|wip|todo|misc|杂项|其他|bug|问题)[\s:：]*$", re.I)


def title_problems(title, desc):
    """Why a task title/description would leave the next reader guessing; empty when fine."""
    t = (title or "").strip()
    probs = []
    if len(t) < 8:
        probs.append("The title is too short: say what changes and why, for example \"Session diff scrolls sideways: the right half was cut off on phones\"")
    elif _VAGUE_TITLES.match(t):
        probs.append("The title is only a verb: write \"<what> <how it changes>: <why>\"")
    if len(t) > 80:
        probs.append("The title is over 80 characters: keep it to one line and put the details in the description")
    if not any(sep in t for sep in ("：", ":", "，", "—", "→", "（", "(")) and len(t) < 16:
        probs.append("The title does not say why: add the reason or the result you expect after a colon")
    d = (desc or "").strip()
    if len(d) < 20:
        probs.append("The description (-d) is too short: write at least what happened (who ran into what, when) and the result you expect, so whoever picks it up does not have to guess")
    return probs


TITLE_MAX = 40
TITLE_BREAKS = "，。；：、,;: （(「【"


def trim_title(title, n=TITLE_MAX):
    """(title, cut?) — a title longer than `n` is cut at the last punctuation / space in its
    first `n` characters (never mid-word, never leaving an open bracket), since it is shown as-is
    in prime and session lists. The caller keeps the whole title in the description."""
    t = (title or "").strip()
    if len(t) <= n:
        return t, False
    head = t[:n]
    at = max((m.start() for m in re.finditer(f"[{re.escape(TITLE_BREAKS)}]", head) if m.start() >= n // 2), default=n)
    return (head[:at].rstrip(TITLE_BREAKS) or head).strip(), True


def _begin_noted(a, title):
    """Dispatch already noted this work from the person's chat (capture.py): take that task instead of making a
    second one. True when it was taken (or is already being worked on), and the answer is printed."""
    try:
        C = _mod("capture")
        C.D = _THIS
        sid = getattr(a, 'session', None) or session_self()
        got = C.claim_noted(title, a.project or "", sid)
    except Exception as e:
        debug("begin.noted", e)
        return False
    if not isinstance(got, dict) or not got.get("id"):
        return False
    tid = got["id"]
    if got["state"] == "later":
        # the person said it is for another time: not now, and not a second task either
        out({"id": tid, "title": got["title"], "project": a.project, "noted": True, "later": True}, a.json,
            lambda o: print(f"\"{got['title']}\" ({tid}) is something the person said is for later, and Dispatch keeps it in Later: not now, and no second task. When they ask for it now, take it (task_claim {tid})."))
        return True
    if got["state"] == "working" and not got.get("for_this_chat"):
        out({"id": tid, "title": got["title"], "project": a.project, "noted": True, "already": True}, a.json,
            lambda o: print(f"\"{got['title']}\" ({tid}) was noted by Dispatch from the conversation and another agent is already on it, so no second task. To carry on, write the plan and progress on it (task_plan / task_log {tid})."))
        return True
    claim_sid = sid if sid and re.fullmatch(r'[A-Za-z0-9_-]{8,120}', sid) else ""
    argv = ["update", tid, "--claim", "--remove-label", C.NEXT, "--remove-label", C.LATER, "--set-metadata", "claim_session=" + claim_sid, "--json"]
    if claim_sid:
        argv[3:3] = ["--add-label", "session:" + claim_sid]
    if got["state"] == "working":
        # Dispatch claimed it for this conversation: hand it over to the agent in it (bd's guard wants --force for that)
        argv[3:3] = ["--assignee", whoami(), "--status", "in_progress", "--force"]
        argv.remove("--claim")
    argv += _noted_details(tid, a)
    bd_json(argv)
    C.taken(tid)
    out({"id": tid, "title": got["title"], "project": a.project, "noted": True}, a.json,
        lambda o: print(f"\"{got['title']}\" ({tid}) is the same work Dispatch noted from the person's message, and it is yours: claimed by you, no second task. Write the plan now (task_plan {tid}); when it is done, task_done {tid} with the reason."))
    return True


def _noted_details(tid, a):
    """The `bd update` arguments that keep what the agent wrote when it takes a task Dispatch noted (task-lj06.24): its
    checklist (`--acceptance`, added after any items the task has) and its description, after the person's words."""
    acc = (getattr(a, "acceptance", "") or "").strip()
    desc = (getattr(a, "desc", "") or "").strip()
    if not acc and not desc:
        return []
    try:
        have = bd_json(["show", tid, "--json"])
    except SystemExit:
        have = {}
    have = have if isinstance(have, dict) else {}
    argv = []
    if acc:
        old = (have.get("acceptance_criteria") or "").rstrip()
        argv += ["--acceptance", (old + "\n" + acc) if old and acc not in old else (old or acc)]
    if desc:
        old = (have.get("description") or "").rstrip()
        if desc not in old:
            argv += ["--description", (old + "\n\n" + desc) if old else desc]
    return argv


def cmd_begin(a):
    """Create + claim a task in one go: the first thing an Agent does once it knows what it is doing."""
    full = (a.title or "").strip()
    title, cut = trim_title(full)
    if cut:
        # the task is made at once with the plain cut; the summary model's few words (like an agent's own short
        # title) replace it in the background, so a slow model never holds the command up (it took over 20 s on
        # the build Mac, 10-02). The whole title goes into the description either way.
        print(L.t(f"⚠ The title is over {TITLE_MAX} characters: the task was made with \"{title}\", and the summary model shortens it to a few words in the background; the whole title is the first line of the description (next time write a title of a few words)",
                  f"⚠ 标题超过 {TITLE_MAX} 字，先截为「{title}」建好任务，概括模型在后台改成几个字；完整标题记进描述第一行（下次直接写几个字的标题）"), file=sys.stderr)
        if full not in (a.desc or ""):
            a.desc = (L.t("Original title: ", "原标题：") + f"{full}\n\n{a.desc or ''}").rstrip()
    probs = title_problems(title, a.desc)
    if probs and cut and not title_problems(full, a.desc):
        probs = []  # only the shortening lost the "why"; the full title in the description has it
    if probs and not getattr(a, "force", False):
        print("Task not created: make the title and description clear first (or add --force)", file=sys.stderr)
        for pr in probs:
            print("  · " + pr, file=sys.stderr)
        sys.exit(2)
    for pr in probs:
        print("⚠ " + pr, file=sys.stderr)
    if a.project and _in_chat_session(a):
        # an agent in a session without a project folder (Chats): its work belongs to no project, whichever one the
        # agent names (it was told to name one and picked the folder Dispatch's own repository happens to be in)
        print(L.t(f"⚠ This session has no project folder: the task is kept in Chats, not in {a.project}.",
                  f"⚠ 这个会话没有项目文件夹：任务记在 Chats，不进 {a.project}。"), file=sys.stderr)
        a.project = ""
    # what Dispatch already noted from the person's message is this agent's to take: no warnings about it
    if not getattr(a, "force", False) and _begin_noted(a, title):
        return
    for w in begin_warnings(title, a.project, os.getcwd()):
        print("⚠ " + w, file=sys.stderr)
    labels = [f"project:{a.project}"] if a.project else []
    labels.append(f"host:{local_host_name()}")  # which Mac this work runs on — Dispatch filters by it
    sid = getattr(a, 'session', None) or session_from_env()
    if sid and re.fullmatch(r'[A-Za-z0-9_-]{8,120}', sid): labels.extend(['session:' + sid, 'session-origin:' + sid])
    claim_sid = sid if sid and re.fullmatch(r'[A-Za-z0-9_-]{8,120}', sid) else ""
    # the thing it is about and the task this session was on (the Task graph's rows and branches), worked out
    # first and stored by `bd create` itself: two writes (create, claim) where there were three; at load 190
    # each one took seconds (task-p03j)
    got = _mod("tasks_view").begin_thing("", getattr(a, "thing", "") or "", claim_sid, a.project or "", _THIS) or {}
    argv = ["create", title, "-t", a.type, "-p", str(a.priority), "--json",
            "--metadata", json.dumps({"claim_session": claim_sid, **got}, ensure_ascii=False)]
    if labels:
        argv += ["-l", ",".join(labels)]
    if a.desc:
        argv += ["--description", a.desc]
    if a.acceptance:
        argv += ["--acceptance", a.acceptance]
    if a.deps:
        argv += ["--deps", a.deps]
    issue = bd_json(argv)
    tid = issue.get("id")
    if not tid:
        print("Could not create the task", file=sys.stderr)
        sys.exit(1)
    bd_json(["update", tid, "--claim", "--json"])
    if cut:
        _retitle_later(tid, title, full)
    thing_note = f"Filed under \"{got['thing']}\" (not right? `dispatch task thing {tid} \"<thing>\"`). " if got.get("thing") else ""
    if getattr(a, "owns", ""):
        _mod("tasks_view").begin_owns(tid, a.owns, _THIS)
    out({"id": tid, "title": title, "project": a.project, "thing": got.get("thing") or "", "from": got.get("from") or ""}, a.json, lambda o: print(f"\"{title}\" ({tid}) created and claimed. {thing_note}Now write the plan: `dispatch task plan {tid} --set \"first step\" --set \"second step\"` (2 to 5 short steps, shown in the side pane); progress with `dispatch log {tid} \"…\"`; when it is done, commit, `dispatch task deliver {tid} --commit`, then `dispatch done {tid} --reason \"…\"`."))


def _retitle_later(tid, cut, full):
    """`dispatch title-summary` in the background: the summary model's few words for an over-long title. Nothing
    starts when the summary use is off or no model is set up (the plain cut stays). Returns whether it started."""
    try:
        S = _mod("summarize")
        if not S.use_enabled("session_name") or not S.provider():
            return False
        devnull = subprocess.DEVNULL
        P.spawn_detached([sys.executable, os.path.abspath(__file__), "title-summary", tid, "--was", cut, "--", full],
                         stdin=devnull, stdout=devnull, stderr=devnull)
        return True
    except Exception:  # noqa: BLE001
        return False


def cmd_title_summary(a):
    """The background half of `dispatch begin` with an over-long title: the summary model shortens it, and the task
    takes the short one unless its title changed meanwhile (the agent or the person renamed it)."""
    full = " ".join(a.full or []).strip()
    short = _mod("summarize").short_title(full, TITLE_MAX, timeout=a.timeout)
    if not short or short == a.was:
        return
    try:
        now = (bd_json(["show", a.id, "--json"]) or {}).get("title") or ""
    except Exception:  # noqa: BLE001
        return
    if now != a.was:
        return
    bd_json(["update", a.id, "--title", short, "--json"])


def cmd_need_you(a):
    """File something only the person can do (send the email, pay, log in, present): a task
    labelled dispatch:needs-you. It sits in the 只能你做 column of the project's task board and
    the person ticks it off there."""
    title, cut = trim_title(a.title or "")
    if cut:
        print(f"⚠ The title is over {TITLE_MAX} characters, cut to \"{title}\"; the whole sentence is in the description", file=sys.stderr)
        a.desc = f"{(a.title or '').strip()}\n\n{a.desc or ''}".rstrip()
    labels = ["dispatch:needs-you", f"host:{local_host_name()}"] + ([f"project:{a.project}"] if a.project else [])
    sid = session_from_env()
    if sid and re.fullmatch(r'[A-Za-z0-9_-]{8,120}', sid):
        labels.append('session-origin:' + sid)
    argv = ["create", title, "-t", "task", "-p", str(a.priority), "--json", "-l", ",".join(labels)]
    desc = (a.desc or "").strip()
    if a.task:
        desc = (desc + f"\n\nFrom task {a.task}").strip()
    if desc:
        argv += ["--description", desc]
    issue = bd_json(argv)
    tid = issue.get("id")
    if not tid:
        print("Could not create the task", file=sys.stderr)
        sys.exit(1)
    phone_push("notify_needs_you", L.t(f"Only you can do · {a.project or ''}", f"只有你能做 · {a.project or ''}").rstrip(" ·"), title + (f"\n{(a.desc or '')[:120]}" if a.desc else ""), f"/#/board/task/{tid}", level="high")
    story = (getattr(a, "why", None) or "").strip()
    if story:
        code, stdout, stderr = sh(["bd", "update", tid, "--set-metadata", "story=" + story])
        if code:
            print(L.t(f"Task {tid} was made, but saving its background failed: {stderr or stdout}", f"任务 {tid} 已创建，但背景保存失败：{stderr or stdout}"), file=sys.stderr)
            sys.exit(code)
    if a.task:
        sh(["bd", "comments", "add", a.task, L.t(f"Needs the person: \"{title}\" ({tid})", f"需要你出面：「{title}」（{tid}）")], env={"BEADS_ACTOR": whoami()})
    out({"id": tid, "title": title, "project": a.project}, a.json, lambda o: print(f"\"{title}\" ({tid}) is on the Only you can do list; the person ticks it off on the project's task board when it is done."))


def cmd_waiting(a):
    """What waits for the person across every project (waiting.py): sessions that stopped for an
    approval, a decision or an unread reply, and the tasks only they can do. allow / deny / read act on a row."""
    m = _mod("waiting")
    m.D = _THIS
    sys.exit(m.command(a))


class _ThisModule:
    """This module's names, looked up at call time: what links.py uses as `D`, so they
    see this very module whether it runs as __main__, as `dispatch`, or loaded by a test."""
    def __getattr__(self, name):
        try:
            return globals()[name]
        except KeyError:
            raise AttributeError(name)


_THIS = _ThisModule()


SESSION_ENV = E.session_env_names()
_SID_RE = re.compile(r"^[A-Za-z0-9_-]{8,120}$")


def _presence_by_pid(records=None):
    if records is None:
        records = []
        for f in glob.glob(os.path.join(SESS_DIR, "*.json")):
            try:
                with open(f, encoding="utf-8") as fh:
                    records.append(json.load(fh))
            except (OSError, ValueError):
                pass
    by_pid = {}
    for r in records:
        try:
            by_pid[int(r.get("agent_pid") or 0)] = r
        except (TypeError, ValueError):
            pass
    by_pid.pop(0, None)
    return by_pid


# Who is behind a command, read from the process tree (macOS / Linux). The first ancestor that
# says something decides: an Agent binary, or a place only the person types into or clicks.
# An Agent's detached background job (`( … ) &`, nohup, launchd) is reparented to pid 1 and
# reaches neither: "unknown", which is refused like an Agent for ticks, waivers and closing.
# tmux / Herdr panes are not the person's either: an Agent can start a command in one without a
# window anywhere. Editors are left out for the same reason (their agents run in the terminal).
# An Agent binary is any engine's program the registry knows (engines.by_process).
PERSON_APP_RE = re.compile(r"/(Terminal|iTerm2?|Ghostty|Warp|kitty|Alacritty|WezTerm|Hyper)\.app/")
# The installed (retired) Dispatch.app: a copy under any other path (an Agent can compile a
# stand-in that spawns the CLI) does not speak for the person.
DISPATCH_APP_PATHS = (r"^/Applications/Dispatch\.app/Contents/MacOS/dispatch$", "^" + re.escape(os.path.expanduser("~/Applications/Dispatch.app/Contents/MacOS/dispatch")) + "$")
DISPATCH_APP_RE = re.compile("|".join(f"(?:{p})" for p in DISPATCH_APP_PATHS))
PERSON_BINS = {"login", "sshd", "sshd-session"}


def _proc_args(pid):
    code, o, _ = sh(["ps", "-o", "command=", "-p", str(pid)], timeout=5)
    return o.strip() if code == 0 else ""


def _ancestor_kind(pid, comm, by_pid):
    """("agent", record) / ("person", why) / ("app", why) / ("", "") for one ancestor."""
    r = by_pid.get(pid)
    if r:
        return "agent", r
    base = os.path.basename(comm or "").lower()
    if E.by_process(base, comm or ""):
        return "agent", {}
    if DISPATCH_APP_RE.search(comm or ""):
        return "app", "Dispatch"
    if base.startswith("python") and re.search(r"/serve\.py(\s|$)", _proc_args(pid)):
        return "app", L.t("Dispatch remote", "Dispatch 远程")
    if PERSON_APP_RE.search(comm or "") or base in PERSON_BINS:
        return "person", base
    return "", ""


def _walk(pid=None, table=None, records=None):
    """(kind, detail) for the process tree above us: kind is agent / app / person / unknown."""
    by_pid = _presence_by_pid(records)
    table = table if table is not None else ps_table()
    cur = pid or os.getppid()
    for _ in range(40):
        ent = table.get(cur)
        kind, detail = _ancestor_kind(cur, ent[1] if ent else "", by_pid)
        if kind:
            return kind, detail
        if not ent or cur <= 1 or ent[0] <= 1:
            break
        cur = ent[0]
    return "unknown", ""


def ancestor_pids(pid=None, table=None):
    """The pids above this process (its parent, the parent's parent, …), for "is that session me"."""
    out = set()
    try:
        table = table if table is not None else ps_table()
        cur = pid or os.getppid()
        for _ in range(40):
            if not cur or cur <= 1 or cur in out:
                break
            out.add(cur)
            ent = table.get(cur)
            if not ent:
                break
            cur = ent[0]
    except Exception as e:
        debug("ancestor_pids", e)
    return out


def presence_session(pid=None, table=None, records=None):
    """(agent, session id) of the registered Agent session this process runs under: walk up the
    process tree from our parent and match each pid against the presence records' agent_pid.
    ("", "") when none matches (a person's terminal, the app, a launchd job). The walk stops at
    the Dispatch app: an app started from an Agent's shell still speaks for the person."""
    try:
        by_pid = _presence_by_pid(records)
        if not by_pid:
            return "", ""
        table = table if table is not None else ps_table()
        cur = pid or os.getppid()
        for _ in range(30):
            r = by_pid.get(cur)
            if r and _SID_RE.match(str(r.get("session_id") or "")):
                return r.get("agent") or "", r["session_id"]
            ent = table.get(cur)
            if not ent or cur <= 1:
                break
            if DISPATCH_APP_RE.search(ent[1] or ""):
                break
            cur = ent[0]
    except Exception as e:
        debug("presence_session", e)
    return "", ""


def caller_origin(pid=None, table=None, records=None):
    """agent / person / unknown for this command, from the process tree. Windows keeps the old
    answer (person unless the environment or the presence registry says Agent)."""
    if P.IS_WIN:
        return "agent" if presence_session(pid, table, records)[1] else "person"
    try:
        kind, _ = _walk(pid, table, records)
    except Exception as e:
        debug("caller_origin", e)
        return "unknown"
    return "person" if kind in ("person", "app") else kind


def session_from_env():
    """The id an Agent runtime exports for its conversation (Claude Code, Codex, OpenCode through
    Dispatch's plugin, a Dispatch launch), or ""."""
    for k in SESSION_ENV:
        v = (os.environ.get(k) or "").strip()
        if _SID_RE.match(v):
            return v
    return ""


def session_self():
    """The Agent conversation this command is running inside, or "": the id its runtime exports,
    else the presence registry by process ancestry."""
    return session_from_env() or presence_session()[1]


AGENT_ENV_MARKERS = tuple(m for e in E.known() for m in e.env_markers)  # what each engine sets for its commands


def is_agent_caller():
    """Could an Agent be running this command? Its board name says so, a runtime marker is in the
    environment, `dispatch --host` said so from the other Mac, or the process tree does not lead
    to the person (an Agent session up the tree, or nothing that identifies anyone: a detached
    background job). Used for caller attribution and permission-sensitive operations."""
    actor = (os.environ.get("BEADS_ACTOR") or os.environ.get("DISPATCH_ACTOR") or "").lower()
    if actor in AGENT_ACTORS or actor == "dispatch-checker":
        return True
    if any(os.environ.get(k) for k in AGENT_ENV_MARKERS) or os.environ.get("DISPATCH_CALLER") == "agent":
        return True
    return caller_origin() != "person"


def agent_runtime(table=None, records=None):
    """The nearest Agent up the process tree, by its board name: a registered session's agent, or
    the Agent binary we run under. "" when none is found."""
    try:
        by_pid = _presence_by_pid(records)
        table = table if table is not None else ps_table()
        cur = os.getppid()
        for _ in range(40):
            r = by_pid.get(cur)
            if r and (r.get("agent") or "").lower():
                a = (r.get("agent") or "").lower()
                return E.agent_of(a)
            ent = table.get(cur)
            if not ent:
                break
            comm = ent[1] or ""
            if DISPATCH_APP_RE.search(comm):
                break
            base = os.path.basename(comm).lower()
            eng = E.by_process(base, comm)
            if eng:
                return eng.agent
            if cur <= 1 or ent[0] <= 1:
                break
            cur = ent[0]
    except Exception as e:
        debug("agent_runtime", e)
    return ""


def agent_actor(table=None, records=None):
    """The Agent's board name for a 自审 tick: BEADS_ACTOR when it is an Agent's name, else the
    nearest Agent up the process tree, else the runtime the environment names, else "agent"
    (an Agent nobody named still signs as an Agent, never as another one)."""
    who = whoami()
    if (who or "").lower() in AGENT_ACTORS:
        return who.lower()
    rt = agent_runtime(table, records)
    if rt:
        return rt if rt in AGENT_ACTORS else "agent"
    eng = E.from_env()
    return eng.agent if eng else "agent"


def _acceptance():
    return _mod("acceptance")


def check_items(tid, issue, ns, evidence="", done=True):
    """Record the actor's own checklist update and evidence."""
    C = _acceptance()
    items = C.parse_items(issue.get("acceptance_criteria"))
    actor = agent_actor() if is_agent_caller() else whoami()
    changed = {n: dict(items[n - 1], done=done, by=actor if done else "", tags={}) for n in ns}
    if changed:
        if evidence.strip():
            code, _, err = sh(["bd", "comments", "add", tid, L.t(f"[self-check] {','.join(map(str, ns))} · {actor} · evidence: {evidence.strip()}", f"【自查】{','.join(map(str, ns))} · {actor} · 证据：{evidence.strip()}")])
            if code:
                raise SystemExit(err or L.t("Writing the self-check evidence failed", "自查证据写入失败"))
        bd_json(["update", tid, "--acceptance", C.rewrite(issue.get("acceptance_criteria") or "", changed), "--json"])
    return ns


def cmd_log(a):
    issue = bd_json(["show", a.task, "--json"])
    if not issue.get("id"):
        raise SystemExit(L.t(f"No such task: {a.task}", f"没有这个任务：{a.task}"))
    spec = getattr(a, "claim", None) or getattr(a, "tick", None)
    structured = any(getattr(a, k, None) for k in ("worker", "step", "evidence", "next", "state"))
    if structured:
        if spec:
            raise SystemExit(L.t("Record structured progress and checklist ticks separately", "结构化进度和清单勾选请分开记录"))
        import workers
        try:
            entry = workers.progress_entry(getattr(a, "worker", ""), getattr(a, "step", ""),
                                            getattr(a, "evidence", ""), getattr(a, "next", ""),
                                            getattr(a, "state", None) or "running", a.text or "")
        except ValueError as e:
            raise SystemExit(str(e))
        code, _, err = sh(["bd", "comments", "add", a.task, workers.progress_comment(entry)])
        if code:
            raise SystemExit(err or L.t("Writing the progress failed", "进展写入失败"))
        link_session(a.task, labels=issue.get("labels") or [])
        print(f"{entry['worker']} [{entry['state']}]: {entry['step']}")
        return
    if spec:
        if not (a.text or "").strip():
            raise SystemExit(L.t("A self-check needs evidence: name the commit, file, command or result", "自查要带证据：写清提交、文件、命令或结果"))
        try:
            ns = _acceptance().pick(_acceptance().parse_items(issue.get("acceptance_criteria")), spec)
        except ValueError as e:
            raise SystemExit(str(e))
        if not ns:
            raise SystemExit(L.t(f"No checklist item matches: {spec}", f"没有对上的清单项：{spec}"))
        check_items(a.task, issue, ns, a.text)
    elif a.text:
        code, _, err = sh(["bd", "comments", "add", a.task, a.text])
        if code:
            raise SystemExit(err or L.t("Writing the progress failed", "进展写入失败"))
    link_session(a.task, labels=issue.get("labels") or [])
    print(f"\"{issue.get('title') or a.task}\" ({a.task}) logged")


def cmd_check(a):
    """Read a checklist, or mark the actor's completed items with evidence."""
    C = _acceptance()
    issue = bd_json(["show", a.task, "--json"])
    if not issue.get("id"):
        raise SystemExit(L.t(f"No such task: {a.task}", f"没有这个任务：{a.task}"))
    claim = getattr(a, "claim", None)
    tick, untick = getattr(a, "tick", False), getattr(a, "untick", False)
    if getattr(a, "status", False) or (claim is None and not tick and not untick):
        st = C.status(issue, bd_comments(a.task))
        return out(dict(st, task=a.task), a.json, lambda r: print(C.describe(r["items"]) or L.t("No checklist items", "没有清单项")))
    if not a.items:
        raise SystemExit(L.t('Say which item: dispatch check TASK <n> --claim "evidence"', '说明哪一项：dispatch check TASK <n> --claim "证据"'))
    if claim is not None and not claim.strip():
        raise SystemExit(L.t("A self-check needs evidence: name the commit, file, command or result", "自查要带证据：写清提交、文件、命令或结果"))
    try:
        ns = C.pick(C.parse_items(issue.get("acceptance_criteria")), a.items)
    except ValueError as e:
        raise SystemExit(str(e))
    if not ns:
        raise SystemExit(L.t(f"No checklist item matches: {a.items}", f"没有对上的清单项：{a.items}"))
    check_items(a.task, issue, ns, claim or "", done=not untick)
    link_session(a.task, labels=issue.get("labels") or [])
    return out({"task": a.task, "checked": [] if untick else ns, "unchecked": ns if untick else []}, a.json,
               lambda r: print(L.t(f"Item {','.join(map(str, ns))} {'unticked' if untick else 'ticked as self-checked'}", f"第 {','.join(map(str, ns))} 项已{'取消勾选' if untick else '自查打勾'}")))


def link_session(tid, sid=None, labels=None):
    """Label the task with the conversation working on it (`session:<id>`), once. Whoever touches
    a task through dispatch is linked to it; session-origin (who started it) is never changed.
    Returns the id linked, or ""."""
    sid = sid if sid is not None else session_self()
    if not sid or not _SID_RE.match(sid):
        return ""
    try:
        if labels is None:
            code, o, _ = sh(["bd", "show", tid, "--json"])
            if code != 0:
                return ""
            d = json.loads(o[o.find("[") if o.find("[") >= 0 and (o.find("{") < 0 or o.find("[") < o.find("{")) else o.find("{"):])
            labels = (d[0] if isinstance(d, list) and d else d).get("labels") or []
        if f"session:{sid}" in labels:
            return sid
        code, _, err = sh(["bd", "update", tid, "--add-label", f"session:{sid}", "--json"])
        if code != 0:
            debug("link_session", err)
            return ""
        return sid
    except Exception as e:
        debug("link_session", e)
        return ""


def cmd_review(a):
    """Record an independent review with its author and evidence."""
    actor = os.environ.get("BEADS_ACTOR") or os.environ.get("DISPATCH_ACTOR") or ""
    issue = bd_json(["show", a.task, "--json"])
    if not actor or actor == issue.get("assignee"):
        raise SystemExit(L.t("A review has to be recorded by an agent other than the one who did the work; set the real BEADS_ACTOR.", "复核需由执行者以外的 Agent 记录；请设置真实的 BEADS_ACTOR。"))
    if issue.get("status") != "closed":
        raise SystemExit(L.t("The task is not finished yet; a review of the delivery cannot be recorded.", "任务尚未完成，不能记录交付复核。"))
    reviewers = [x[9:] for x in issue.get("labels", []) if x.startswith("reviewer:")]
    if reviewers and actor not in reviewers:
        raise SystemExit(L.t("Another agent is named to review this task.", "本任务已指定其他复核 Agent。"))
    if not a.reason.strip():
        raise SystemExit(L.t("Write what you checked, the result and the evidence.", "请填写检查内容、结果和依据。"))
    text = L.t(f"[agent review · {'passed' if a.verdict == 'pass' else 'changes needed'}] {actor}\n{a.reason.strip()}", f"【Agent 复核 · {'通过' if a.verdict == 'pass' else '需修改'}】{actor}\n{a.reason.strip()}")
    code, _, err = sh(["bd", "comments", "add", a.task, text], env={"BEADS_ACTOR": actor})
    if code:
        raise SystemExit(err or L.t("Writing the review failed", "复核记录写入失败"))
    args = ["update", a.task, "--remove-label", "review-requested"]
    if a.verdict == "pass":
        args += ["--add-label", "reviewed", "--remove-label", "review-changes"]
    else:
        args += ["--status", "open", "--remove-label", "reviewed", "--add-label", "review-changes"]
    bd_json(args + ["--json"])
    print(L.t(f"Review of \"{issue.get('title') or a.task}\" ({a.task}) recorded: {a.verdict}", f"「{issue.get('title') or a.task}」（{a.task}）复核已记录：{a.verdict}"))


def parent_autoclose(tid, issue):
    """Close the parent of a split when every child is closed; returns a note for the caller."""
    parents = [d for d in issue.get("dependencies") or [] if (d.get("dependency_type") or "parent-child") == "parent-child"]
    for p in parents:
        pid = p.get("id")
        if not pid:
            continue
        par = bd_json(["show", pid, "--json"])
        if not par.get("id") or par.get("status") == "closed":
            continue
        kids = [d for d in par.get("dependents") or [] if (d.get("dependency_type") or "parent-child") == "parent-child"]
        open_kids = [k for k in kids if k.get("status") != "closed" and k.get("id") != tid]
        if open_kids:
            continue
        bd_json(["close", pid, "--reason", L.t(f"All sub-tasks are done (the last one {tid}); closed by itself.", f"子任务全部完成（最后一个 {tid}），自动关闭。"), "--json"])
        return f"its parent task {pid} is closed too"
    return ""


def cmd_done(a):
    """Close the task based on the completing agent's report."""
    reason = a.reason.strip()
    if not reason:
        raise SystemExit(L.t("The done reason cannot be empty: say what was delivered and how it was checked", "完成说明不能为空：写清交付和验证结果"))
    if not a.verified:
        reason = reason + L.t(" (not verified)", "（未核验）") if "核验" not in reason and not re.search(r"\bverified\b", reason, re.I) else reason
    cur = bd_json(["show", a.task, "--json"])
    link_session(a.task, labels=cur.get("labels") or [])
    ticked = 0
    try:
        ticked_meta, ticked = _mod("tasks_view").finished_plan(cur)
        if ticked_meta is not None:
            bd_json(["update", a.task, "--metadata", json.dumps(ticked_meta, ensure_ascii=False), "--json"])
    except (Exception, SystemExit) as e:  # ticking the plan never stops the task from closing
        debug("done: plan", e)
        ticked = 0
    bd_json(["close", a.task, "--reason", reason, "--json"])
    _mod("ownership").forget(a.task)  # its territory is free again
    if getattr(a, "review_by", None):
        bd_json(["update", a.task, "--add-label", "review-requested", "--add-label", "reviewer:" + a.review_by, "--remove-label", "reviewed", "--json"])
    created = []
    issue = bd_json(["show", a.task, "--json"])
    proj = next((l.split(":", 1)[1] for l in issue.get("labels", []) if l.startswith("project:")), "")
    for nxt in a.next or []:
        argv = ["create", nxt, "-t", "task", "-p", "2", "--deps", f"discovered-from:{a.task}", "--json"]
        if proj:
            argv += ["-l", f"project:{proj}"]
        d = bd_json(argv)
        if d.get("id"):
            created.append(d["id"])
    retro_key = ""
    if getattr(a, "retro", None):
        retro_key = "retro-" + a.task
        wiki_store(retro_key, wiki_compose("retro", a.retro, {}, proj, a.task))
    # The commits this task became: those in the current repo naming the task id, plus hashes
    # in the reason. Recorded as a comment so the task page (and anyone reading bd) sees them.
    commits = []
    root = git_root_of(os.getcwd())
    if root:
        code, o, _ = sh(["git", "-C", root, "log", "--format=%h %s", f"--grep={re.escape(a.task)}", "-n", "20"], timeout=10)
        commits = [l for l in o.splitlines() if l.strip()] if code == 0 else []
        for h in _HASH_RE.findall(reason):
            if len(h) >= 7 and not h.isdigit() and not any(l.startswith(h[:7]) for l in commits):
                code, o, _ = sh(["git", "-C", root, "log", "-1", "--format=%h %s", h], timeout=5)
                if code == 0 and o.strip():
                    commits.append(o.strip())
        if commits:
            sh(["bd", "comments", "add", a.task, L.t("Commits:\n", "提交：\n") + "\n".join(commits[:20])])
    # A split is complete when all its children are complete.
    parent_msg = parent_autoclose(a.task, issue)
    archived = archive_ide_sessions(issue) if getattr(a, "archive", False) else []
    tidy = ""
    try:  # Settings › Agents › Tidy up after work (neat_auto.py): never in the way of closing the task
        folder = (project_home(proj) if proj else "") or root or ""
        tidy = _mod("neat_auto").after_done(folder)
    except Exception as e:
        debug("done: neat", e)
    phone_push("notify_done", L.t(f"Task done · {proj or a.task}", f"任务完成 · {proj or a.task}"), (issue.get("title") or a.task) + (f"\n{reason[:120]}" if reason else ""), f"/#/board/task/{a.task}")
    msg = f"\"{issue.get('title') or a.task}\" ({a.task}) done" + (" (verified)" if a.verified else " (not verified: see the reason)")
    if getattr(a, "review_by", None):
        msg += f"; waiting for {a.review_by} to review it (no agent is started for that)"
    if created:
        msg += f"; next tasks: {', '.join(created)}"
    if retro_key:
        msg += f"; the retro is in the knowledge base as {retro_key}"
    if ticked:
        msg += f"; ticked the {ticked} plan steps still open"
    if parent_msg:
        msg += "; " + parent_msg
    for r in archived:
        msg += "; " + r["message"]
    if tidy:
        msg += "; " + tidy
    if commits:
        msg += f"; {len(commits)} commit{'s' if len(commits) != 1 else ''} linked"
    elif root:
        msg += "; no commit names this task (end a commit message with the task id to link it)"
    out({"closed": a.task, "next": created, "retro": retro_key, "commits": commits, "archived": archived, "plan_ticked": ticked}, a.json, lambda o: print(msg))


def archive_ide_sessions(issue):
    """`dispatch done --archive`: the task's conversations (session:<id> labels) that live in an
    Agents window go to its Archived list, through `dispatch ide archive-session`. A session the
    editor does not know, or an editor that is not running, is skipped with a note."""
    out = []
    for l in issue.get("labels") or []:
        if not l.startswith("session:"):
            continue
        try:
            # a terminal conversation the host only discovered is not the window's to archive
            r = _mod("ide_sessions").archive(l.split(":", 1)[1], include_external=False)
        except Exception as e:
            debug("archive_ide_sessions", e)
            continue
        if r.get("skipped") != "not_found":
            out.append(r)
    return out


# ---------------------------------------------------------------- lineage graph (tasks as a thread)

def cmd_graph(a):
    """Nodes = every task, edges = bd dependencies. bd's dot output is the one call
    that carries edge *types*; direction is normalised to upstream → downstream
    (a task points at the ones it spawned / unblocks)."""
    code, o, err = sh(["bd", "list", "--all", "-n", "0", "--json"])
    if code != 0:
        print(bd_problem(code, err), file=sys.stderr)
        if no_board(code, err):
            return out({"nodes": [], "edges": [], "no_board": True}, True, None)
        sys.exit(code)
    try:
        issues = json.loads(o[o.find("["):])
    except ValueError:
        issues = []
    code, dot, err = sh(["bd", "list", "--all", "-n", "0", "--format", "dot"])
    edges = []
    for m in re.finditer(r'"([a-z]+-[a-z0-9]+)"\s*->\s*"([a-z]+-[a-z0-9]+)"\s*\[([^\]]*)\]', dot):
        src, dst, attrs = m.group(1), m.group(2), m.group(3)
        lm = re.search(r'label="([^"]*)"', attrs)
        typ = lm.group(1) if lm else "blocks"
        # "A -> B" in bd's dot means A depends on B (A was discovered from B / A is blocked by B)
        edges.append({"from": dst, "to": src, "type": typ})
    nodes = [{k: i.get(k) for k in ("id", "title", "status", "priority", "issue_type", "assignee", "created_at", "updated_at", "closed_at", "labels", "acceptance_criteria")} for i in issues]
    out({"nodes": nodes, "edges": edges}, a.json, lambda g: [print(f"{e['from']} → {e['to']}  ({e['type']})") for e in g["edges"]] and print(L.t(f"{len(g['nodes'])} tasks, {len(g['edges'])} edges", f"{len(g['nodes'])} 个任务，{len(g['edges'])} 条边")))


# ---------------------------------------------------------------- quota (usage limits per agent)

QUOTA_DIR = os.path.join(DISPATCH_DIR, "quota")


CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_USAGE_TTL = 300  # seconds between calls; the app polls every minute, the API sees one call per 5


def _iso_epoch(s):
    from datetime import datetime as _dt
    try:
        return _dt.fromisoformat(s.replace("Z", "+00:00")).timestamp() if s else None
    except Exception:
        return None


def _account_quota(engine):
    """The saved account in use (`dispatch accounts`), so quota, the phone and the title bar agree."""
    try:
        return _mod("accounts").quota_row(engine)
    except Exception:
        return None


def _switched_at(engine):
    try:
        return _mod("accounts").switched_at(engine)
    except Exception:
        return 0


def quota_of(engine):
    """An engine's allowance: the saved account in use when there is one (`dispatch accounts`), else this Mac's own
    sign-in (its adapter's own_quota). Unsupported for an engine that reports none."""
    eng = E.get(engine)
    return _account_quota(eng.id) or eng.own_quota()


def cmd_quota(a):
    # Only the agents this Mac has: a missing one is not 「没拿到数据」, it is simply not here.
    rows = [quota_of(e.id) for e in E.known() if e.supports("own_quota") and os.path.isdir(e.home_dir(HOME))]
    for r in rows:
        r["host"], r["host_name"] = "local", local_host_name()
    if not getattr(a, "local", False):
        for h in hosts():
            for r in _tag_host(_only_theirs(remote_dispatch(h, ["quota", "--local"], 60)), h):
                r["remote"] = True
                rows.append(r)

    def until(epoch):
        m = int((epoch - time.time()) / 60)
        return L.t(f"resets in {m}m", f"{m}m 后重置") if m < 60 else L.t(f"resets in {m // 60}h{m % 60:02d}", f"{m // 60}h{m % 60:02d} 后重置") if m < 2880 else L.t(f"resets in {m // 1440}d", f"{m // 1440}d 后重置")

    def text(rows):
        for r in rows:
            parts = [f"{w['label']} {round(w['used_percent']) if w['used_percent'] is not None else '?'}%" + (f"（{until(w['resets_at'])}）" if w.get("resets_at") and w["resets_at"] > time.time() else "") for w in r["windows"]]
            print(f"{r.get('host_name', ''):<10} {r['agent']:<12} {r['plan']:<14} {' · '.join(parts) if parts else r['note']}" + (L.t(f"   [data from {ago(r['updated_at'])} ago]", f"   [数据 {ago(r['updated_at'])} 前]") if r.get("updated_at") else ""))
    out(rows, a.json, text)


# ---------------------------------------------------------------- global rules (one file → every agent)

# Machine-wide rules live next to the cross-agent skills dir, not inside any one agent's home.
RULES_FILE = os.path.join(HOME, ".agents", "rules", "GLOBAL.md")
RULES_BEGIN = "<!-- BEGIN DISPATCH GLOBAL RULES"
RULES_END = "<!-- END DISPATCH GLOBAL RULES -->"
# Where each agent reads machine-wide instructions (its adapter's rules_file, engines/). Claude Code can @import a
# file; the others get the content inlined inside the managed block.
# "home" is the agent's config dir: an agent that is not installed gets no file written.
RULE_TARGETS = {e.id: e.rules_target(HOME) for e in E.known() if e.rules_file}
rule_agents_installed = lambda: [ag for ag, t in RULE_TARGETS.items() if not t.get("home") or os.path.isdir(t["home"])]
# The engines Dispatch itself supports. A machine that never synced before gets rules for the ones of
# these that are installed; a machine that already syncs to others (ZCode, Pi, Gemini) keeps them, and
# gains the supported ones, because the rules no longer travel in `dispatch prime`.
RULE_DEFAULT_AGENTS = tuple(e.id for e in E.runnable())
# `dispatch rules targets --set …` writes the person's own choice here; without it the targets follow the rule above
RULE_TARGETS_FILE = os.path.join(DISPATCH_DIR, "rules-targets.json")


# ---------------------------------------------------------------- facts: 常用信息（服务器/域名/数据库/API 名字、常说的话）
# One markdown file next to GLOBAL.md. `## 通用` is for everyone; `## <项目名>` sections are
# injected by `dispatch prime` only when the session runs inside that project. Secrets never go
# here — they live in `dispatch env`; this file names them and says what they are for.
FACTS_FILE = os.path.join(HOME, ".agents", "rules", "FACTS.md")
FACTS_GENERAL = ("通用", "general", "common")


def facts_heading(heading):
    return "General" + heading[2:] if heading == "通用" or heading.startswith("通用（") else heading


def facts_topic_name(topic):
    return "Design preferences" + topic[6:] if topic.startswith("我的设计偏好") else topic


def facts_normalize(text):
    """Only the headings owned by Dispatch, never the person's facts or decisions."""
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        body = line.rstrip("\r\n")
        ending = line[len(body):]
        if body.startswith("# 常用信息"):
            lines[i] = "# Facts" + ending
        elif body.startswith("## "):
            lines[i] = "## " + facts_heading(body[3:]) + ending
        elif body.startswith("**我的设计偏好"):
            lines[i] = "**" + facts_topic_name(body[2:]) + ending
    return "".join(lines)


def facts_text():
    try:
        return open(FACTS_FILE, encoding="utf-8").read()
    except FileNotFoundError:
        return ""


def facts_sections(text):
    """Split on `## ` headings → [(heading, body)]; text before the first heading is dropped."""
    out, head, buf = [], None, []
    for line in text.splitlines():
        if line.startswith("## "):
            if head is not None:
                out.append((head, "\n".join(buf).strip()))
            head, buf = line[3:].strip(), []
        elif head is not None:
            buf.append(line)
    if head is not None:
        out.append((head, "\n".join(buf).strip()))
    return out


def facts_key(heading):
    """`myapp（MyApp · 说明）` → `myapp`: the first word, lowercased."""
    return re.split(r"[\s（(·:：,，/]", heading.strip(), maxsplit=1)[0].lower()


FACTS_PROJECT_FILE = "FACTS.md"


def facts_project_path(proj, names=None, index=None, roots=None):
    """<project dir>/FACTS.md — facts that belong to one project only (its servers, logins,
    who to ask). Read on demand with `dispatch facts … -P <project>`; prime lists the topics
    but never injects the body, so other projects' sessions never carry it."""
    d = project_home(proj, names, index, roots) if proj else ""
    return os.path.join(d, FACTS_PROJECT_FILE) if d else ""


def facts_project_text(proj, names=None):
    path = facts_project_path(proj, names)
    try:
        return open(path, encoding="utf-8").read() if path else ""
    except OSError:
        return ""


def facts_for(proj, text=None, project_text=None):
    """Sections for a session: the general one(s) from the machine-wide FACTS.md, the legacy
    `## <project>` section there, and every section of the project's own FACTS.md.
    `text`/`project_text` replace the files (tests); giving only `text` reads no disk."""
    secs = facts_sections(facts_text() if text is None else text)
    want = {k for k in FACTS_GENERAL}
    if proj:
        want.add(proj.lower())
    picked = [(h, b) for h, b in secs if facts_key(h) in want and b]
    if proj:
        ptext = facts_project_text(proj) if (text is None and project_text is None) else (project_text or "")
        picked += [(h, b) for h, b in facts_sections(ptext) if b]
    return picked


def facts_topics(body):
    """A section body is a list of `**topic**` blocks → [(topic, block_text)]; lines before
    the first bold heading form a topic named ''."""
    out, head, buf = [], "", []
    for line in body.splitlines():
        m = re.match(r"^\*\*(.+?)\*\*\s*(.*)$", line.strip())
        if m and not line.strip().startswith("-"):
            if head or buf:
                out.append((head, "\n".join(buf).strip()))
            head, buf = m.group(1).strip(), ([m.group(2)] if m.group(2) else [])
        else:
            buf.append(line)
    if head or buf:
        out.append((head, "\n".join(buf).strip()))
    return [(h, b) for h, b in out if b]


_MD_BULLET = re.compile(r"^\s{0,3}(?:[-*+]|\d+[.)])\s+")


def md_items(lines, start, end):
    """The entries of a Markdown block, lines[start:end] (0-based): each bullet with its indented
    continuation, or each paragraph. [{line, end, text}] with 1-based line numbers (end exclusive);
    text without the bullet marker. The Knowledge page lists facts and About me by these."""
    out, cur = [], None

    def close(j):
        if cur is not None:
            cur["end"] = j + 1
            cur["text"] = "\n".join(cur.pop("buf")).strip()
            out.append(cur)

    for i in range(start, end):
        line = lines[i]
        if not line.strip():
            close(i); cur = None
            continue
        bullet = _MD_BULLET.match(line)
        if bullet or cur is None or (cur.get("bullet") and not line.startswith((" ", "\t"))):
            close(i)
            cur = {"line": i + 1, "bullet": bool(bullet), "buf": [line[bullet.end():] if bullet else line.strip()]}
        else:
            cur["buf"].append(line.strip())
    close(end)
    for it in out:
        it.pop("bullet", None)
    return out


def md_drop_item(text, line, expect):
    """The Markdown with the entry that starts at `line` (1-based) taken out. `expect` is that
    entry's text as the caller saw it; ValueError when the file moved on in between."""
    lines = text.split("\n")
    for it in md_items(lines, 0, len(lines)):
        if it["line"] == line:
            if it["text"].strip() != (expect or "").strip():
                raise ValueError("This entry has changed. Refresh before deleting it.")
            del lines[it["line"] - 1:it["end"] - 1]
            return "\n".join(lines)
    raise ValueError(f"Line {line} is not the start of an entry. Refresh before deleting it.")


_FACTS_TOPIC_LINE = re.compile(r"^\*\*(.+?)\*\*\s*(.*)$")


def facts_blocks(text):
    """Every `**topic**` block of a FACTS.md with where it sits: [{section, topic, note, body,
    start, end}]. `note` is what follows the bold title on its line, `body` the lines after it;
    start is the title's line, end the first line of the next topic or section (0-based)."""
    lines = text.split("\n")
    rows, section, cur = [], "", None

    def close(i):
        if cur is not None:
            cur["end"] = i
            cur["body"] = "\n".join(lines[cur["start"] + 1:i]).strip()
            rows.append(cur)

    for i, line in enumerate(lines):
        if line.startswith("## "):
            close(i); cur = None
            section = line[3:].strip()
            continue
        m = _FACTS_TOPIC_LINE.match(line.strip())
        if section and m and not line.strip().startswith("-"):
            close(i)
            cur = {"section": section, "topic": m.group(1).strip(), "note": m.group(2).strip(), "start": i}
    close(len(lines))
    return rows


def facts_replace_body(text, topic, body, section=""):
    """FACTS.md with one topic's body replaced (its title line stays). Raises KeyError when the
    topic is not there, ValueError when the title matches in more than one section."""
    hits = [b for b in facts_blocks(text) if facts_topic_name(b["topic"]) == facts_topic_name(topic) and (not section or facts_heading(b["section"]) == facts_heading(section))]
    if not hits:
        raise KeyError(topic)
    if len(hits) > 1:
        raise ValueError(f"Topic {topic} appears in multiple sections ({', '.join(b['section'] for b in hits)}). Choose one with --section.")
    b = hits[0]
    lines = text.split("\n")
    tail = lines[b["start"] + 1:b["end"]]
    gap = 0
    while gap < len(tail) and not tail[len(tail) - 1 - gap].strip():
        gap += 1
    new = [l.rstrip() for l in body.strip("\n").split("\n")] if body.strip() else []
    return "\n".join(lines[:b["start"] + 1] + new + [""] * gap + lines[b["end"]:])


def facts_get(query, proj="", text=None, project_text=None):
    """Topic blocks whose title contains the query (case-insensitive), from the general
    section, this project's legacy section and the project's own FACTS.md."""
    q = query.strip().lower()
    hits = []
    for h, b in facts_for(proj, text, project_text):
        for topic, block in facts_topics(b):
            if facts_topic_name(q).lower() in facts_topic_name(topic).lower() or (not topic and q in h.lower()):
                hits.append((h, topic, block))
    return hits


def facts_search(query, docs_text):
    """Lines matching every word of the query, across [(doc_name, text)], with their topic."""
    words = [w for w in query.lower().split() if w]
    rows = []
    for name, text in docs_text:
        topic = ""
        for line in text.splitlines():
            m = re.match(r"^\*\*(.+?)\*\*", line.strip())
            if m:
                topic = m.group(1).strip()
            elif line.startswith("## "):
                topic = line[3:].strip()
            low = line.lower()
            if line.strip() and all(w in low for w in words):
                rows.append((name, topic, line.strip()))
    return rows


FACT_WORDS = re.compile(r"(tailscale|100\.\d+\.\d+\.\d+|mac mini|macbook|ssh |hetzner|vps|supabase|cloudflare|stripe|\bR2\b|github|api[ _-]?key|密钥|token|域名|dns|数据库|postgres|sqlite|redis|apple id|xcode|udid|team|obsidian|hermes|telegram|deepseek|kimi|minimax|openai|zhipu|智谱|豆包|端口|port \d|launchagent|cron)", re.I)


def facts_candidates(sources, existing_text):
    """Paragraph-sized snippets from other agents' memory files that look like cross-project
    facts (machines, accounts, keys, tools) and are not already in FACTS.md.
    sources: [(path, text)] → [(path, snippet)] deduplicated."""
    def norm(s):
        return re.sub(r"[\s`*_#>\-·。，,.:：;；()（）\[\]]+", "", s.lower())
    have = norm(existing_text)
    seen, out = set(), []
    for path, text in sources:
        text = re.sub(r"^---\n[\s\S]*?\n---\n", "", text)  # frontmatter
        for para in re.split(r"\n\s*\n", text):
            para = para.strip()
            if len(para) < 20 or len(para) > 1200 or not FACT_WORDS.search(para):
                continue
            key = norm(para)[:160]
            if key in seen or (len(key) > 40 and key in have):
                continue
            seen.add(key)
            out.append((path, para))
    return out


def facts_docs():
    """The documents the 常用信息 page edits: the machine-wide FACTS.md plus, for every project
    the board knows (task labels, or the starred/archived list) whose directory can be found,
    that project's own FACTS.md. Project facts are read on demand (`dispatch facts … -P`) —
    not AGENTS.md, which every agent loads whole on every turn."""
    docs = [{"key": "general", "name": "General (all projects)", "path": FACTS_FILE, "dir": "", "exists": os.path.exists(FACTS_FILE),
             "hint": "Included in every session (dispatch prime)"}]
    names = project_names()
    try:
        for k in project_flags_load():
            names.setdefault(k.lower(), k)
    except Exception:
        pass
    try:
        index, roots = load_index(), (settings_load().get("workspace_roots") or [])
    except Exception:
        index, roots = {}, []
    for key in sorted(names):
        d = project_home(names[key], names, index, roots)
        if not d:
            continue
        path = os.path.join(d, FACTS_PROJECT_FILE)
        docs.append({"key": key, "name": names[key], "path": path, "dir": d, "exists": os.path.exists(path),
                     "hint": f"Project facts, read on demand: `dispatch facts show -P {names[key]}` / `get -P {names[key]} <topic>`"})
    return docs


def facts_doc_path(a):
    """--path must be one of facts_docs(); otherwise the page could write anywhere.
    `-P <project>` without --path means that project's FACTS.md."""
    if not getattr(a, "path", ""):
        proj = getattr(a, "project", "")
        if not proj:
            return FACTS_FILE
        path = facts_project_path(proj)
        if not path:
            print(f"Project folder for {proj} is unknown. Register the project folder first.", file=sys.stderr)
            sys.exit(1)
        return path
    want = os.path.realpath(a.path)
    for d in facts_docs():
        if os.path.realpath(d["path"]) == want:
            return d["path"]
    print(f"{a.path} is not a registered Facts document. See `dispatch facts docs`.", file=sys.stderr)
    sys.exit(2)


def guarded_whole_file_text(a, target):
    """`facts write` / `profile write` replace the whole file with stdin. Refuse what would wipe it: no stdin
    (a terminal), empty or blank stdin, or --text (that belongs to `drop`); keep the old file in ~/.dispatch/backups.
    2026-10-06: `facts write --section General --text "…"` read an empty stdin and blanked a 94-line FACTS.md."""
    if getattr(a, "text", None):
        raise SystemExit(L.t("write replaces the whole file and reads it from standard input: `dispatch facts write < new-file`. --text is for drop; to add one line, edit the file (`dispatch facts open`).", "write 替换整份文件，内容从标准输入读：`dispatch facts write < 新文件`。--text 是 drop 用的；要加一条请编辑文件（`dispatch facts open`）。"))
    if sys.stdin is None or sys.stdin.isatty():
        raise SystemExit(L.t("write reads the whole new content from standard input (`… write < file`); there was none, nothing changed.", "write 要从标准输入读整份新内容（`… write < 文件`），没有输入，什么都没改。"))
    text = sys.stdin.read()
    if not text.strip():
        raise SystemExit(L.t("Standard input is empty: write would empty the whole file, so nothing was written.", "标准输入是空的：write 会把整份文件清空，所以没写。"))
    try:
        _mod("backups").save(target)
    except OSError as e:
        debug("backup before write", e)
    return text


def cmd_facts(a):
    if a.op == 'vaults':
        from pathlib import Path
        config = Path(P.OBSIDIAN_CONFIG) if P.IS_WIN else Path(HOME) / 'Library/Application Support/obsidian/obsidian.json'
        if not config.exists(): config = Path(HOME) / '.config/obsidian/obsidian.json'
        try:
            data = json.loads(config.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        rows = []
        for ident, vault in data.get('vaults', {}).items():
            path = Path(vault.get('path', ''))
            if not str(vault.get('path', '')).strip(): continue
            if path.name == 'Obsidian Sandbox' and ('Application Support/obsidian' in str(path) or (P.IS_WIN and '/obsidian/' in P.to_slash(str(path)).lower())): continue  # Obsidian's own demo vault
            rows.append({'id': ident, 'name': path.name, 'path': ui_path(str(path)), 'exists': path.is_dir(), 'open': bool(vault.get('open'))})
        out(rows, a.json, lambda rs: print(json.dumps(rs, ensure_ascii=False)))
    elif a.op == "topics":
        secs = facts_sections(facts_project_text(a.project)) if a.project else facts_sections(facts_text())
        rows = [{"section": h, "topic": t, "lines": len(b.splitlines())} for h, b in secs for t, b2 in facts_topics(b) for b in [b2]]
        out(rows, a.json, lambda rs: [print(f"{r['section']:<10} {r['topic']}") for r in rs] or (a.project and not rs and print(L.t(f"{a.project} has no FACTS.md or no **topic** in it; `dispatch facts show -P {a.project}` shows the file", f"{a.project} 没有 FACTS.md 或里面没有 **主题**；`dispatch facts show -P {a.project}` 看原文"), file=sys.stderr)))
    elif a.op == "get":
        if not a.query:
            print(L.t("Usage: dispatch facts get <topic> (`dispatch facts topics` lists them)", "用法：dispatch facts get <主题词>（`dispatch facts topics` 列主题）"), file=sys.stderr); sys.exit(2)
        hits = facts_get(a.query, a.project or project_of_cwd(os.getcwd(), project_names()))
        if a.json:
            print(json.dumps([{"section": h, "topic": t, "text": b} for h, t, b in hits], ensure_ascii=False)); return
        if not hits:
            print(f"Topic {a.query} not found. Use `dispatch facts topics` or `dispatch facts search {a.query}`.", file=sys.stderr); sys.exit(1)
        for h, t, b in hits:
            print(f"### {t or h}\n{b}\n")
    elif a.op == "search":
        if not a.query:
            print(L.t("Usage: dispatch facts search <word>", "用法：dispatch facts search <关键词>"), file=sys.stderr); sys.exit(2)
        docs = [(d["name"], open(d["path"], encoding="utf-8").read()) for d in facts_docs()
                if d["exists"] and (not a.project or d["key"] in (*FACTS_GENERAL, a.project.lower()))]
        rows = facts_search(a.query, docs)
        if a.json:
            print(json.dumps([{"doc": n, "topic": t, "line": l} for n, t, l in rows], ensure_ascii=False)); return
        if not rows:
            print(L.t("Not found; `dispatch facts topics` lists the topics, or ask the person.", "没找到；`dispatch facts topics` 看主题，或问用户。"), file=sys.stderr); sys.exit(1)
        for n, t, l in rows[:40]:
            print(f"[{n} · {t}] {l}")
    elif a.op == "import":
        import glob, datetime
        sources = []
        for pat in [os.path.join(HOME, ".claude", "projects", "*", "memory", "*.md"), os.path.join(HOME, ".codex", "memories", "raw_memories.md")]:
            for path in sorted(glob.glob(pat)):
                if os.path.basename(path) == "MEMORY.md":
                    continue
                try:
                    sources.append((path, open(path, encoding="utf-8").read()))
                except OSError:
                    pass
        cands = facts_candidates(sources, facts_text())
        report = L.t([f"# Memory import list ({datetime.date.today()})", "", f"Read {len(sources)} memory files and took out {len(cands)} passages that look like cross-project facts and are not in FACTS.md yet.", "Go through them: keep what belongs in FACTS.md, delete the rest; then `dispatch facts import --apply` appends the list as it is to the \"to sort\" block at the end of FACTS.md's general section. The memory files stay as they are.", ""],
                     [f"# 记忆导入清单（{datetime.date.today()}）", "", f"扫描 {len(sources)} 个记忆文件，抽出 {len(cands)} 段像跨项目事实、且 FACTS.md 里还没有的内容。", "逐段看：该进 FACTS.md 的留下，其余删掉；确认后 `dispatch facts import --apply` 会把清单原样追加到 FACTS.md「通用」节末尾的「待整理」块，原记忆文件不动。", ""])
        by = {}
        for path, para in cands:
            by.setdefault(path, []).append(para)
        for path, paras in by.items():
            report.append(f"## {path.replace(HOME, '~')}")
            for p_ in paras:
                report.append(p_); report.append("")
        os.makedirs(DISPATCH_DIR, exist_ok=True)
        out_path = a.out or os.path.join(DISPATCH_DIR, "facts-import.md")
        open(out_path, "w", encoding="utf-8").write("\n".join(report))
        if a.apply:
            if not cands:
                print(L.t("Nothing to append", "没有可追加的内容")); return
            block = [f"\n**To review ({datetime.date.today()}, imported from agent memories)**"]
            for path, para in cands:
                block.append(f"- （{os.path.basename(os.path.dirname(os.path.dirname(path))) if '/memory/' in path else 'codex'}）" + re.sub(r"\s*\n\s*", " ", para))
            text = facts_text()
            secs = facts_sections(text)
            gen = next((h for h, b in secs if facts_key(h) in FACTS_GENERAL), None)
            if gen is None:
                text = text.rstrip() + "\n\n## 通用\n" + "\n".join(block) + "\n"
            else:
                idx = text.index("## " + gen)
                nxt = re.search(r"^## ", text[idx + 3:], re.M)
                end = idx + 3 + nxt.start() if nxt else len(text)
                text = text[:end].rstrip() + "\n" + "\n".join(block) + "\n\n" + text[end:]
            open(FACTS_FILE, "w", encoding="utf-8").write(facts_normalize(text))
            print(L.t(f"Appended {len(cands)} passages to the to-sort block at the end of FACTS.md's general section; the list is in {out_path}", f"已把 {len(cands)} 段追加到 FACTS.md「通用」末尾的待整理块；清单在 {out_path}"))
        else:
            print(L.t(f"List written to {out_path} ({len(cands)} passages from {len(by)} files). After reading it, `dispatch facts import --apply` appends it to FACTS.md, or copy what you pick by hand.", f"清单写到 {out_path}（{len(cands)} 段，来自 {len(by)} 个文件）。看过后 `dispatch facts import --apply` 追加进 FACTS.md，或手动挑选粘贴。"))
    elif a.op == "docs":
        rows = facts_docs()
        out(rows, a.json, lambda rs: [print(f"{r['key']:<12} {L.t('yes', '有') if r['exists'] else L.t('no', '无'):<3} {r['path']}") for r in rs])
    elif a.op == "path":
        print(facts_doc_path(a))
    elif a.op == "open":
        if P.IS_WIN:
            P.open_path(facts_doc_path(a))
        else:
            subprocess.run(["open", facts_doc_path(a)])
    elif a.op == "write":
        target = facts_doc_path(a)
        text = guarded_whole_file_text(a, target)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        open(target, "w", encoding="utf-8").write(facts_normalize(text if text.endswith("\n") else text + "\n"))
        print(L.t(f"Wrote {target} ({len(text.splitlines())} lines)", f"已写入 {target}（{len(text.splitlines())} 行）"))
    elif a.op == "list":
        path = facts_doc_path(a)
        try:
            text = open(path, encoding="utf-8").read()
        except FileNotFoundError:
            text = ""
        lines = text.split("\n")
        rows = [{"section": facts_heading(b["section"]), "topic": facts_topic_name(b["topic"]), "note": b["note"], "body": b["body"], "path": path, "line": b["start"] + 1,
                 "items": md_items(lines, b["start"] + 1, b["end"])} for b in facts_blocks(text)]
        out(rows, a.json, lambda rs: [print(f"{r['section']:<10} {r['topic']}") for r in rs] or print(L.t(f"\n{len(rs)} topics ({path})", f"\n{len(rs)} 个主题（{path}）")))
    elif a.op == "drop":
        # the Knowledge page's Delete on one fact: `dispatch facts drop <line> --text "<the entry>"`
        path = facts_doc_path(a)
        try:
            line = int((a.query or "").strip())
            new = md_drop_item(open(path, encoding="utf-8").read(), line, a.text)
        except (ValueError, FileNotFoundError) as e:
            fail_answer(a.json, str(e) if not isinstance(e, FileNotFoundError) else f"File not found: {path}", 1)
        open(path, "w", encoding="utf-8").write(facts_normalize(new))
        out({"ok": True, "line": line, "path": path}, a.json, lambda o: print(L.t(f"Removed the entry on line {o['line']} ({o['path']})", f"已删掉第 {o['line']} 行那条（{o['path']}）")))
    elif a.op == "edit":
        a.query = (a.query or "").strip()  # a leading space keeps a topic that starts with "-" positional
        if not a.query:
            print("Usage: dispatch facts edit <topic> [--section section] < body", file=sys.stderr); sys.exit(2)
        path = facts_doc_path(a)
        try:
            text = open(path, encoding="utf-8").read()
            new = facts_replace_body(text, a.query, sys.stdin.read(), a.section)
        except (FileNotFoundError, KeyError):
            fail_answer(a.json, f"Topic {a.query} not found. Use `dispatch facts list` to see available topics.", 1)
        except ValueError as e:
            fail_answer(a.json, str(e), 2)
        open(path, "w", encoding="utf-8").write(facts_normalize(new))
        out({"ok": True, "topic": a.query, "path": path}, a.json, lambda o: print(L.t(f"Updated \"{o['topic']}\" ({o['path']})", f"已更新「{o['topic']}」（{o['path']}）")))
    elif a.op == "sections":
        src = facts_doc_path(a)
        rows = [{"heading": h, "key": facts_key(h), "lines": len(b.splitlines())} for h, b in facts_sections(facts_project_text(a.project) if a.project else facts_text())]
        out(rows, a.json, lambda rs: [print(f"{r['key']:<16} {r['lines']:>4} " + L.t("lines", "行") + f"  {r['heading']}") for r in rs] or print(L.t(f"\n{len(rs)} sections ({src})", f"\n{len(rs)} 节（{src}）")))
    else:  # show
        if a.project and not a.path:
            # The project's own file, whole; plus the legacy `## <project>` section of the global file
            # so nothing written under the old scheme goes missing.
            path = facts_project_path(a.project)
            t = facts_project_text(a.project)
            legacy = [(h, b) for h, b in facts_for(a.project, facts_text(), "") if facts_key(h) not in FACTS_GENERAL]
            if a.json:
                print(json.dumps({"path": path, "content": t, "exists": bool(path) and os.path.exists(path),
                                  "legacy": [{"heading": h, "body": b} for h, b in legacy]}, ensure_ascii=False))
            else:
                if t:
                    print(t, end="" if t.endswith("\n") else "\n")
                else:
                    print(L.t(f"{a.project} has no FACTS.md yet (it belongs in {path or 'the project folder'}). Write one with `dispatch facts write -P {a.project} < file`, "
                              f"organized as `## section` + `**topic**`, only short facts this project alone uses; keys go to `dispatch env set NAME value -P {a.project}`.",
                              f"{a.project} 还没有 FACTS.md（应在 {path or '项目目录'}）。写法：`dispatch facts write -P {a.project} < 文件`，"
                              f"内容按 `## 节` + `**主题**` 组织，只放这个项目才用的短事实；密钥放 `dispatch env set 名 值 -P {a.project}`。"), file=sys.stderr)
                for h, b in legacy:
                    print(L.t(f"\n## {h} (old: a project section in the global FACTS.md; move it into the project's FACTS.md)\n{b}", f"\n## {h}（旧：全局 FACTS.md 里的项目节，可搬进项目 FACTS.md）\n{b}"))
                if not t and not legacy:
                    sys.exit(1)
        else:
            target = facts_doc_path(a)
            try:
                t = open(target, encoding="utf-8").read()
            except FileNotFoundError:
                t = ""
            print(json.dumps({"path": target, "content": t, "exists": os.path.exists(target)}, ensure_ascii=False) if a.json else t, end="" if (t.endswith("\n") and not a.json) else "\n")


# ---------------------------------------------------------------- profile: 关于我 → profile.py
def cmd_profile(a):
    return _mod("profile").cmd_profile(a)


# ---------------------------------------------------------------- agent memories → memories.py
def cmd_memories(a):
    return _mod("memories").cmd_memories(a)


def cmd_prefs(a):
    """Preferences (prefs.py): how the person likes things done, from their feedback on deliveries."""
    sys.exit(_mod("prefs").run(a, _THIS) or 0)


def rules_text():
    try:
        return open(RULES_FILE, encoding="utf-8").read()
    except FileNotFoundError:
        return ""


def rules_hash(text, dispatch_text="", soul_text=""):
    """One hash for what an agent's block carries: the person's GLOBAL.md, their Soul (when on) and Dispatch's own rules."""
    import hashlib
    return hashlib.sha256((text + ("\n\0soul\n" + soul_text if soul_text else "") + ("\n\0dispatch\n" + dispatch_text if dispatch_text else "")).encode("utf-8")).hexdigest()[:12]


def soul_rules(install=False):
    """(path of the person's SOUL.md, its text, or "" when Soul is off). `install`: create it from the default or follow
    a newer default first (only `rules sync` and `dispatch soul` do; looking must not change files)."""
    soul = _mod("soul")
    if install and soul.is_on():
        try:
            soul.ensure()
        except OSError as e:
            debug("SOUL.md install", e)
    return soul.path(), soul.text_for_rules()


def dispatch_rules(install=False):
    """(path of the installed dispatch.md, its text): Dispatch's own agent rules. `install`: make the installed copy
    current first (only `rules sync` does, so a Claude import of the file and the text inlined for the others say the
    same thing; looking must not change files)."""
    import dispatch_dir
    p = dispatch_dir.path("rules", "dispatch.md")
    if install:
        try:
            p = dispatch_dir.install_shipped_rules() or p
        except OSError as e:
            debug("dispatch.md install", e)
    return p, dispatch_dir.dispatch_rules_text()


def rules_digest():
    """The hash `rules status` and `rules sync` compare each agent's block against."""
    return rules_hash(rules_text(), dispatch_rules()[1], soul_rules()[1])


def block_agents():
    """The agents whose rules file already carries the managed block."""
    out = []
    for ag, t in RULE_TARGETS.items():
        try:
            if RULES_BEGIN in open(t["path"], encoding="utf-8").read():
                out.append(ag)
        except OSError:
            pass
    return out


def rule_sync_targets():
    """Who `dispatch rules sync` writes to, and why: [{agent, installed, syncing, why}] for every agent Dispatch knows.
    The person's own choice (`rules targets --set`) wins. Otherwise: every agent that already has the block (a machine
    that synced before keeps its ZCode, Pi or Gemini file) plus the installed ones Dispatch supports (Claude Code,
    Codex, OpenCode), so a new install gets those three and nothing else."""
    installed = rule_agents_installed()
    try:
        with open(RULE_TARGETS_FILE, encoding="utf-8") as f:
            saved = json.load(f).get("agents")
        saved = [ag for ag in saved if ag in RULE_TARGETS] if isinstance(saved, list) else None
    except (OSError, ValueError, AttributeError):
        saved = None
    has = block_agents()
    rows = []
    for ag in RULE_TARGETS:
        if saved is not None:
            on, why = ag in saved and ag in installed, "chosen"
        elif ag in RULE_DEFAULT_AGENTS and ag in installed:
            on, why = True, "supported"
        elif ag in has and ag in installed:
            on, why = True, "already synced"
        else:
            on, why = False, "not installed" if ag not in installed else "not supported"
        rows.append({"agent": ag, "installed": ag in installed, "syncing": on, "why": why, "path": RULE_TARGETS[ag]["path"]})
    return rows


def rule_sync_agents():
    return [r["agent"] for r in rule_sync_targets() if r["syncing"]]


def render_block(agent, text, h, dispatch_text="", dispatch_file="", soul_text="", soul_file=""):
    """The managed block: the person's GLOBAL.md, their Soul (when on), then Dispatch's rules. Claude Code imports
    the files with @, the others get the text inlined."""
    mode = RULE_TARGETS[agent]["mode"]
    soul_on = bool(soul_text and soul_file)
    if mode == "import":
        body = f"@{RULES_FILE}\n" + (f"@{soul_file}\n" if soul_on else "") + (f"@{dispatch_file}\n" if dispatch_text and dispatch_file else "")
    else:
        body = text.rstrip() + "\n" + ("\n" + soul_text.rstrip() + "\n" if soul_text else "") + ("\n" + dispatch_text.rstrip() + "\n" if dispatch_text else "")
    # "soul:" and "dispatch:" come before "source:": the instructions audit reads the source path up to the closing arrow
    where = (f" soul:{soul_file}" if soul_on else "") + (f" dispatch:{dispatch_file}" if dispatch_text and dispatch_file else "")
    return f"{RULES_BEGIN} hash:{h}{where} source:{RULES_FILE} -->\n{body}{RULES_END}\n"


def target_state(agent, h):
    p = RULE_TARGETS[agent]["path"]
    if not os.path.exists(p):
        return "missing", p, ""
    s = open(p, encoding="utf-8").read()
    i = s.find(RULES_BEGIN)
    if i < 0:
        return "absent", p, s
    m = re.search(r"hash:([0-9a-f]+)", s[i:i + 200])
    return ("synced" if m and m.group(1) == h else "stale"), p, s


def cmd_rules(a):
    if a.op in ('inspect', 'optimize', 'check', 'apply', 'restore'):
        from instructions import command
        project = None
        if getattr(a, 'project', ''):
            project = next((d['dir'] for d in facts_docs() if d['key'] == a.project and d['dir']), None)
            if not project: raise ValueError(L.t('Pick one of the projects found', '请选择已检测到的项目'))
        try:
            result = command(a, HOME, project=project)
        except ValueError as e:
            msg = str(e)
            if "托管块" in msg:
                msg = L.t("What is between BEGIN/END DISPATCH GLOBAL RULES in this file is managed: it is made from ~/.agents/rules/GLOBAL.md, so changing it here does nothing and is not allowed. To change the shared rules, edit \"Rules for every agent\". Everything outside that block is yours to change.",
                  "这份文件里「BEGIN/END DISPATCH GLOBAL RULES」之间的内容是托管块，由 ~/.agents/rules/GLOBAL.md 生成，改它没用、也不能在这里改。要改共同规则请编辑左边的「所有 Agent 的共同规则」。托管块之外的内容可以随便改。")
            print(json.dumps({"error": msg}, ensure_ascii=False) if a.json else f"✗ {msg}")
            sys.exit(2)
        out(result, a.json, lambda d: print(json.dumps(d, ensure_ascii=False, indent=2)))
        return
    if a.op == "path":
        print(RULES_FILE)
        return
    if a.op == "show":
        print(rules_text() or L.t(f"(no rules file yet: {RULES_FILE})", f"（还没有规则文件：{RULES_FILE}）"))
        return
    if a.op == "write":
        new = sys.stdin.read()
        if not new.strip():
            print("stdin is empty; nothing was written", file=sys.stderr)
            sys.exit(2)
        os.makedirs(os.path.dirname(RULES_FILE), exist_ok=True)
        _mod("backups").save(RULES_FILE)
        open(RULES_FILE, "w", encoding="utf-8").write(new)
        a.op, a.force = "sync", True
        return cmd_rules(a)
    if a.op == "open":
        if P.IS_WIN:
            P.open_path(RULES_FILE)
        else:
            subprocess.run(["open", RULES_FILE])
        return
    if a.op == "targets":
        return rules_targets(a)
    if a.op == "sync" and getattr(a, "if_set_up", False) and not block_agents():
        # the Agents window runs this at every start, so an update's dispatch.md and Soul arrive; a Mac whose agents
        # never got Dispatch's block (no setup) is left alone, nothing installed or written
        out({"results": [], "skipped": "not set up"}, a.json, lambda o: print(L.t("No agent has Dispatch's rules yet; nothing synced.", "还没有 Agent 带 Dispatch 的规则，没有同步。")))
        return
    text = rules_text()
    dfile, dtext = dispatch_rules(install=(a.op == "sync"))
    sfile, stext = soul_rules(install=(a.op == "sync"))
    h = rules_hash(text, dtext, stext)
    if a.op == "status":
        rows = []
        for ag in rule_sync_agents():
            st, p, _ = target_state(ag, h)
            rows.append({"agent": ag, "path": p, "state": st, "mode": RULE_TARGETS[ag]["mode"]})
        out({"hash": h, "source": RULES_FILE, "dispatch": dfile, "soul": sfile if stext else "", "targets": rows}, a.json, lambda o: [print(f"{r['agent']:<8} {r['state']:<8} {r['path']}") for r in o["targets"]])
        return
    if a.op == "sync":
        if not text.strip():
            print(L.t(f"The rules file is empty: {RULES_FILE}", f"规则文件为空：{RULES_FILE}"), file=sys.stderr)
            sys.exit(1)
        results = rules_write_blocks(text, h, dtext, dfile, stext, sfile, a.force)
        out({"hash": h, "results": results}, a.json, lambda o: [print(f"{r['agent']:<8} {r['action']:<10} {r['path']}") for r in o["results"]] and print(L.t("New sessions get it", "新会话生效")))
        return


def rules_write_blocks(text, h, dtext, dfile, stext, sfile, force=False):
    """Put the managed block into every agent `rules sync` writes to; [{agent, path, action}]."""
    results = []
    for ag in rule_sync_agents():
        st, p, s = target_state(ag, h)
        if st == "synced" and not force:
            results.append({"agent": ag, "path": p, "action": "unchanged"})
            continue
        block = render_block(ag, text, h, dtext, dfile, stext, sfile)
        if st in ("missing", "absent"):
            head = "" if st == "missing" else s.rstrip() + "\n\n"
            new = head + block
            action = "created" if st == "missing" else "appended"
        else:
            i = s.find(RULES_BEGIN)
            j = s.find(RULES_END, i)
            j = j + len(RULES_END) if j >= 0 else len(s)
            if s[j:j + 1] == "\n":
                j += 1
            new = s[:i] + block + s[j:]
            action = "updated"
        os.makedirs(os.path.dirname(p), exist_ok=True)
        _mod("backups").save(p, daily=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(new)
        results.append({"agent": ag, "path": p, "action": action})
    return results


def rules_sync_now(force=False):
    """`dispatch rules sync`, for callers inside the CLI (`dispatch soul`): the results; [] when GLOBAL.md is empty or no
    agent has Dispatch's block yet (a Mac that was never set up gets nothing written into its agents)."""
    text = rules_text()
    if not text.strip() or not block_agents():
        return []
    dfile, dtext = dispatch_rules(install=True)
    sfile, stext = soul_rules(install=True)
    return rules_write_blocks(text, rules_hash(text, dtext, stext), dtext, dfile, stext, sfile, force)


def cmd_soul(a):
    return _mod("soul").command(a, rules_sync_now)


def rules_targets(a):
    """`dispatch rules targets [--set claude,codex] [--reset]`: which agents `rules sync` writes to."""
    chosen = getattr(a, "set", None)
    if getattr(a, "reset", False):
        try:
            os.remove(RULE_TARGETS_FILE)
        except OSError:
            pass
    elif chosen is not None:
        names = [n.strip() for n in chosen.split(",") if n.strip()]
        bad = [n for n in names if n not in RULE_TARGETS]
        if bad:
            print(L.t(f"Unknown agent: {', '.join(bad)} (choose from: {', '.join(RULE_TARGETS)})", f"不认识的 Agent：{', '.join(bad)}（可选：{', '.join(RULE_TARGETS)}）"), file=sys.stderr)
            sys.exit(2)
        os.makedirs(os.path.dirname(RULE_TARGETS_FILE), exist_ok=True)
        with open(RULE_TARGETS_FILE, "w", encoding="utf-8") as f:
            json.dump({"agents": names}, f, ensure_ascii=False)
    rows = rule_sync_targets()
    out({"targets": rows, "choice": os.path.exists(RULE_TARGETS_FILE)}, a.json,
        lambda o: [print(f"{r['agent']:<8} {L.t('synced', '同步') if r['syncing'] else L.t('not synced', '不同步'):<10} {r['why']:<14} {r['path']}") for r in o["targets"]])


# ---------------------------------------------------------------- wiki: pits, wins, retros, howtos (bd memories)

# One convention, four kinds. Content starts with the kind's head marker; optional
# labelled fields follow; `#project:` / `#task:` tags at the end. Keys carry the prefix.
WIKI_KINDS = {
    "pit":   {"prefix": "pit-",   "head": "【坑】",   "fields": [("fix", "【解法】")],                                   "label": "坑"},
    "win":   {"prefix": "win-",   "head": "【做对】", "fields": [("why", "【为什么】")],                                 "label": "做对"},
    "retro": {"prefix": "retro-", "head": "【复盘】", "fields": [("tech", "【技术】"), ("good", "【做对】"), ("bad", "【做错】")], "label": "复盘"},
    "howto": {"prefix": "howto-", "head": "【方法】", "fields": [],                                                    "label": "方法"},
}
_ALL_LABELS = sorted({lab for k in WIKI_KINDS.values() for _, lab in k["fields"]} | {k["head"] for k in WIKI_KINDS.values()}, key=len, reverse=True)


def wiki_compose(kind, text, fields, project=None, task=None):
    k = WIKI_KINDS[kind]
    body = text.strip()
    if not body.startswith(k["head"]):
        body = k["head"] + body
    for name, label in k["fields"]:
        v = (fields or {}).get(name)
        if v and label not in body:
            body += f" {label}{v.strip()}"
    if project:
        body += f" #project:{project}"
    if task:
        body += f" #task:{task}"
    return body


def wiki_kind_of(key, value):
    for kind, k in WIKI_KINDS.items():
        if key.startswith(k["prefix"]) or value.lstrip().startswith(k["head"]):
            return kind
    return None


def wiki_parse(key, value):
    kind = wiki_kind_of(key, value)
    tag = lambda n: (re.search(rf"#{n}:(\S+)", value) or [None, ""])[1] if re.search(rf"#{n}:(\S+)", value) else ""
    body = re.sub(r"#(project|task):\S+", "", value).strip()
    fields = {}
    if kind:
        pat = "(" + "|".join(re.escape(l) for l in _ALL_LABELS) + ")"
        parts = re.split(pat, body)
        cur = None
        for piece in parts:
            if piece in _ALL_LABELS:
                cur = piece
                fields.setdefault(cur, "")
            elif cur is not None:
                fields[cur] = (fields[cur] + piece).strip()
        head = WIKI_KINDS[kind]["head"]
        text = fields.pop(head, body)
    else:
        text = body
    return {"key": key, "kind": kind, "text": text, "fields": fields, "project": tag("project"), "task": tag("task"), "raw": value}


# The wiki lives in ~/.dispatch/wiki, one file an entry (wiki/<key>.md holds exactly what the board's
# memory held), so it travels between Macs with the rest of what Dispatch knows about the user
# (knowledge_sync.py). Dispatch's own bookkeeping (keys starting with INTERNAL_MEMORY_PREFIX: settings,
# project flags, docs) stays in the board's memories. Before `dispatch wiki migrate` (or the first wiki
# write, which migrates first) a Mac with entries in the board keeps reading them there.

def wiki_dir():
    return _mod("dispatch_dir").path("wiki")


def wiki_file(key):
    import urllib.parse
    return os.path.join(wiki_dir(), urllib.parse.quote(key, safe="") + ".md")


def wiki_files_on():
    return os.path.isdir(wiki_dir())


def wiki_file_write(key, content):
    os.makedirs(wiki_dir(), exist_ok=True)
    p = wiki_file(key)
    tmp = f"{p}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content if content.endswith("\n") else content + "\n")
    os.replace(tmp, p)


def wiki_file_entries():
    """{key: content} from ~/.dispatch/wiki."""
    import urllib.parse
    out = {}
    try:
        names = sorted(os.listdir(wiki_dir()))
    except OSError:
        return out
    for n in names:
        if not n.endswith(".md") or n.startswith("."):
            continue
        try:
            with open(os.path.join(wiki_dir(), n), encoding="utf-8") as f:
                text = f.read()
        except OSError:
            continue
        out[urllib.parse.unquote(n[:-3])] = text.rstrip("\n")
    return out


def wiki_board_entries():
    """{key: content} of the wiki entries still in the board's memories; None when the board cannot be read."""
    code, o, err = sh(["bd", "memories", "--json"])
    if code != 0:
        print(bd_problem(code, err), file=sys.stderr)
        return None
    try:
        d = json.loads(o[o.find("{"):])
    except ValueError:
        return {}
    return {k: v for k, v in d.items() if k != "schema_version" and isinstance(v, str) and not k.startswith(INTERNAL_MEMORY_PREFIX)}


def wiki_migrate():
    """Copy every wiki entry from the board's memories into ~/.dispatch/wiki (a file that is already
    there wins). The board keeps its copies, so going back is possible. -> {copied, kept, total, dir}"""
    board = wiki_board_entries()
    if board is None:
        raise RuntimeError("the task board cannot be read, nothing was migrated")
    have = wiki_file_entries()
    copied, kept = [], []
    staging = wiki_dir() + f".migrating-{os.getpid()}"
    os.makedirs(staging, exist_ok=True)
    import urllib.parse
    for k, v in board.items():
        if k in have:
            kept.append(k)
            continue
        with open(os.path.join(staging, urllib.parse.quote(k, safe="") + ".md"), "w", encoding="utf-8") as f:
            f.write(v + "\n")
        copied.append(k)
    os.makedirs(wiki_dir(), exist_ok=True)
    for n in os.listdir(staging):
        os.replace(os.path.join(staging, n), os.path.join(wiki_dir(), n))
    os.rmdir(staging)
    try:
        wiki_dates(sorted(board), board=True)  # first-written dates from the board's history, before it stops being the source
    except Exception:
        pass
    return {"copied": len(copied), "kept": len(kept), "total": len(board), "dir": wiki_dir()}


def wiki_migrate_first():
    """The first wiki write on a Mac whose entries are still in the board copies them over first."""
    if wiki_files_on():
        return
    try:
        wiki_migrate()
    except RuntimeError as e:
        print(f"{e}; `dispatch wiki migrate` copies them later", file=sys.stderr)
        os.makedirs(wiki_dir(), exist_ok=True)


def wiki_store(key, content):
    if not key.startswith(INTERNAL_MEMORY_PREFIX):
        wiki_migrate_first()
        wiki_file_write(key, content)
        return key
    code, o, err = sh(["bd", "remember", content, "--key", key])
    if code != 0:
        msg = err.strip() or o.strip()
        if "too large for column" in msg:
            # bd's own message is the whole value (65 KB) inside "Error 1105: string '…' is too large"
            n = len(content.encode())
            msg = L.t(f"Could not save the board entry {key}: it is {n:,} bytes and the task board keeps at most "
                      f"{MEMORY_MAX_BYTES:,} bytes in one entry (bd's \"Error 1105 … too large for column 'value'\"). "
                      "Make it shorter and run the command again.",
                      f"任务板的条目 {key} 存不进：它有 {n:,} 字节，任务板一个条目最多存 {MEMORY_MAX_BYTES:,} 字节"
                      f"（bd 报的「Error 1105 … too large for column 'value'」）。把它删短后再运行一次。")
        print(msg, file=sys.stderr)
        sys.exit(code)
    return key


def wiki_all():
    """Every knowledge-base entry; an empty list (and one line on stderr) when there is no board
    yet, so `prime` — a SessionStart hook for every Claude Code session — never hard-fails."""
    if wiki_files_on():
        d = wiki_file_entries()
    else:
        d = wiki_board_entries() or {}
    return [wiki_parse(k, v) for k, v in d.items()]


# ---------------------------------------------------------------- project flags (star / archive)
# Projects are labels, not records, so their two switches live in one shared bd memory
# (synced between the Macs with the board). Keys under this prefix are Dispatch's own
# bookkeeping and stay out of the wiki, prime and the knowledge-base view.
INTERNAL_MEMORY_PREFIX = "dispatch-"
MEMORY_MAX_BYTES = 65535  # bd stores a memory in a Dolt TEXT column; one byte more is "Error 1105 … too large"
PROJECT_FLAGS_KEY = "dispatch-projects"
PROJECT_FLAG_FIELDS = ("starred", "archived")
PROJECT_CMD_FIELDS = ("test_cmd", "installed_probe")
# Preserve legacy project metadata when unrelated flags change.
PROJECT_SUGGEST_FIELDS = ("test_cmd_suggested", "test_cmd_dismissed")


def portable_normpath(p):
    """normpath by the path's own kind, not this machine's: the board is shared between a Mac
    ("/Users/x/p") and a PC ("C:\\Users\\x\\p"), and neither may rewrite the other's folders."""
    import ntpath, posixpath
    return ntpath.normpath(p) if re.match(r"^([A-Za-z]:[\\/]|\\\\)", p) else posixpath.normpath(p)


def project_flags_parse(raw):
    try:
        d = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    if not isinstance(d, dict):
        return {}
    out = {}
    for name, v in d.items():
        if isinstance(v, dict):
            flags = {f: True for f in PROJECT_FLAG_FIELDS if v.get(f) is True}
            # 显示名 set in the app: not a flag this command edits, but it must survive a --star here.
            alias = v.get("alias")
            if isinstance(alias, str) and alias.strip() and alias.strip() != name:
                flags["alias"] = alias.strip()[:80]
            # Home folder chosen when the project was created in the app (`project --dir`): the
            # project exists before any session or task does, and sessions there belong to it.
            d = v.get("dir")
            if isinstance(d, str) and P.is_abs(d.strip()) and "\0" not in d:
                flags["dir"] = portable_normpath(d.strip())[:400]
            # Existing project command metadata, never executed automatically.
            for k in PROJECT_CMD_FIELDS + PROJECT_SUGGEST_FIELDS:
                c = v.get(k)
                if isinstance(c, str) and c.strip() and "\0" not in c:
                    flags[k] = c.strip()[:400]
            if flags:
                out[name] = flags
    return out


def project_flags_apply(flags, name, changes):
    name = (name or "").strip()
    if not name or len(name) > 120 or any(ord(c) < 32 for c in name):
        raise ValueError(L.t("Not a valid project name", "无效的项目名称"))
    if set(changes) - set(PROJECT_FLAG_FIELDS) or any(type(v) is not bool for v in changes.values()):
        raise ValueError(L.t("Only starred / archived can be set, to true or false", "只能设置 starred / archived，值为布尔"))
    cur = {**flags.get(name, {}), **changes}
    alias, home = cur.get("alias"), cur.get("dir")
    cmds = {k: cur.get(k) for k in PROJECT_CMD_FIELDS + PROJECT_SUGGEST_FIELDS if isinstance(cur.get(k), str) and cur.get(k)}
    cur = {f: True for f in PROJECT_FLAG_FIELDS if cur.get(f)}
    if isinstance(alias, str) and alias:
        cur["alias"] = alias
    if isinstance(home, str) and home:
        cur["dir"] = home
    cur.update(cmds)
    out = {k: v for k, v in flags.items() if k != name}
    if cur:
        out[name] = cur
    return out


_PROJECT_DIRS = None


def project_dirs(reload=False):
    """lowercase project name -> home folder, for projects created in the app with a folder.
    Cached per process: callers loop over every session."""
    global _PROJECT_DIRS
    if _PROJECT_DIRS is None or reload:
        try:
            _PROJECT_DIRS = {k.lower(): v["dir"] for k, v in project_flags_load().items() if isinstance(v, dict) and v.get("dir")}
        except Exception:
            _PROJECT_DIRS = {}
    return _PROJECT_DIRS


def project_dir_names():
    """lowercase -> name as written, for the projects in project_dirs()."""
    try:
        return {k.lower(): k for k, v in project_flags_load().items() if isinstance(v, dict) and v.get("dir")}
    except Exception:
        return {}


def project_flags_load(strict=False):
    """The star / archive / folder switches. Readers get {} when the board cannot be read; a writer
    passes strict=True so a failed read can never be saved back as "no projects flagged"."""
    code, o, err = sh(["bd", "memories", "--json"])
    if code != 0:
        print(bd_problem(code, err), file=sys.stderr)
        if strict:
            sys.exit(code)
        return {}
    try:
        d = json.loads(o[o.find("{"):])
    except ValueError:
        if strict:
            print(L.t("The board's answer could not be read; nothing was saved", "任务板返回的内容读不出来，没有保存"), file=sys.stderr)
            sys.exit(1)
        return {}
    return project_flags_parse(d.get(PROJECT_FLAGS_KEY, ""))


# Which Mac a project lives on after `dispatch move` handed it over. Shared board memory, so both
# Macs agree; a Mac is named the way it names itself (local_host_name) plus its Tailscale IP, since
# the two Macs know each other under different hosts.json ids.
PROJECT_OWNERS_KEY = "dispatch-project-owners"


def project_owners_parse(raw):
    try:
        d = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    if not isinstance(d, dict):
        return {}
    return {k: {"host": v["host"], "ip": v.get("ip") or "", "at": v.get("at") or 0} for k, v in d.items()
            if isinstance(k, str) and isinstance(v, dict) and isinstance(v.get("host"), str) and v["host"]}


def project_owners_load():
    code, o, _ = sh(["bd", "memories", "--json"])
    try:
        return project_owners_parse(json.loads(o[o.find("{"):]).get(PROJECT_OWNERS_KEY, "")) if code == 0 else {}
    except ValueError:
        return {}


def project_owner_set(project, host, ip):
    project = (project or "").strip()
    if not project or len(project) > 120 or any(ord(c) < 32 for c in project):
        raise ValueError(L.t("Not a valid project name", "无效的项目名称"))
    owners = project_owners_load()
    if host:
        owners[project] = {"host": host, "ip": ip or "", "at": int(time.time())}
    else:
        owners.pop(project, None)
    wiki_store(PROJECT_OWNERS_KEY, json.dumps(owners, ensure_ascii=False, sort_keys=True))
    return {"project": project, **owners.get(project, {"host": ""})}


def project_owner_is_here(rec):
    """True when an owner record names this Mac (by its own name, an old name, or its Tailscale IP)."""
    if not rec:
        return False
    return rec.get("host") in ({local_host_name()} | set(local_host_aliases())) or (bool(rec.get("ip")) and rec.get("ip") == tailscale_ip())


# A project's Agents start only on the Mac it belongs to (dispatch-project-owners): new sessions,
# resumes, 手机继续, 接管 and 派活 alike. `dispatch move` sets DISPATCH_MOVE=1 for the resume it
# runs on the new Mac before the owner record changes hands.
def owner_elsewhere(cwd, host=None):
    """For a folder (on `host`, None = this Mac) whose project belongs to another Mac:
    {"project", "host": the owner's name, "peer": its hosts.json entry or None, "here": owner is this
    Mac}. None when the folder is not in a project, the project has no owner, or `host` is the owner."""
    if os.environ.get("DISPATCH_MOVE"):
        return None
    project = project_of_folder(host, cwd) if cwd else ""
    if not project:
        return None
    try:
        owners = project_owners_load()
    except Exception:
        return None
    rec = next((v for k, v in owners.items() if k.lower() == project.lower()), None)
    if not rec:
        return None
    here = project_owner_is_here(rec)
    hid = "" if here else (resolve_host_id(rec["host"]) or (rec.get("ip") and resolve_host_id(rec["ip"])) or "")
    if (host is None and here) or (host is not None and hid == host.get("id")):
        return None
    peer = next((h for h in hosts() if h.get("id") == hid), None) if hid else None
    return {"project": project, "host": local_host_name() if here else rec["host"], "peer": peer, "here": here}


def owner_refusal(o, resume=False):
    """What the person reads when a start or resume is refused because the project lives elsewhere."""
    name = o["host"]
    msg = L.t(f"Project {o['project']} belongs to {name}: its sessions open only on {name}, so no agent was started on {local_host_name()}. ", f"项目 {o['project']} 归「{name}」，它的会话只在 {name} 上开，没有在 {local_host_name()} 上起 Agent。")
    if resume:
        return msg + L.t(f"This session's record is on {local_host_name()}: move it to {name} first (right-click the session › Move to another Mac, or dispatch move), then go on.", f"这个会话的记录在 {local_host_name()} 上：先把它迁到 {name}（会话右键「迁到另一台」，或 dispatch move）再接着做。")
    if not o.get("here") and not o.get("peer"):
        return msg + L.t(f"This Mac's hosts.json has no {name}; add it on the Macs page first.", f"这台的 hosts.json 里没有 {name}，先在「电脑」页把它加进来。")
    return msg + L.t(f"Pick {name} as the Mac when you start the session.", f"新建会话时主机选 {name}。")


# ---------------------------------------------------------------- settings (shared, one bd memory)
SETTINGS_KEY = "dispatch-settings"
# Who each discussion member is (one line) and the group's rules on length: stable
# configuration that goes into the system prompt, so a round's prompt is just the new messages.
DISCUSS_RULES_DEFAULT = L.t("Small talk stays small, two lines at most; real matters get one or two paragraphs, about 100 words, more only to argue a point; answer only the latest message and what others already said, do not repeat, do not write risks and splits to fill space; with nothing new, reply only SKIP.",
                            "闲聊就闲聊，两句以内；正事默认一两段、150 字左右，要论证再展开；只回应最新消息和别人已经说过的观点，不重复，不为了凑段落写风险和拆分；没有新东西就只回 SKIP。")
DISCUSS_PERSONA_DEFAULT = {e.id: e.discuss_persona for e in E.known() if e.discuss_persona}  # each engine's own line
SETTING_DEFAULTS = {"session_archive_days": 30, "task_archive_days": 0, "home_expanded": 2, "sdk_sessions_scheduled": 1, "workspace_roots": ["~/Projects"], "summary_auto": 0, "summary_model": "", "retired_providers": "", "human_aliases": "",
                    "notify_reply": 1, "notify_attention": 1, "notify_done": 1, "notify_needs_you": 1, "keep_awake": 1, "notify_desktop": 0, "notify_mac_finished": 1, "notify_mac_needs_you": 1, "notify_mac_stopped": 0, "notify_sound": "default", "summary_uses": {}, "list_density": "comfortable",
                    "discuss_rules": DISCUSS_RULES_DEFAULT, **{f"discuss_persona_{k}": v for k, v in DISCUSS_PERSONA_DEFAULT.items()},
                    # Dispatch IDE (dispatch ide): Tab completion (off until asked, daily cap in USD), ⌘K model
                    "ide_tab_completion": 1, "ide_tab_daily_cap_usd": 0.5, "ide_tab_model": "deepseek-flash", "ide_edit_model": "claude:sonnet",
                    # an in-app conversation idle this long is closed by chatd (the next message resumes it); 0 = never
                    "chat_idle_close_minutes": 30,
                    # an agent that finished and sat untouched this long is put to sleep to free memory, chatd's and the
                    # Agents window's alike (sleep.py); opening it wakes it. 0 = never
                    "agent_sleep_minutes": 30,
                    "session_life_tokens": -1, "session_life_warning_percent": 80, "session_life_auto_handoff": 1,
                    # 新工作树 under the new-Agent box: only remembered for now (the switch starts nothing yet)
                    "new_worktree": 0}
# free-text settings and their length caps; everything else numeric except workspace_roots
SETTING_STRINGS = {"notify_sound": 40, "ide_tab_model": 80, "ide_edit_model": 80, "list_density": 20, "summary_model": 80, "retired_providers": 120, "human_aliases": 200, "discuss_rules": 600,
                   **{f"discuss_persona_{k}": 300 for k in DISCUSS_PERSONA_DEFAULT}}


def settings_parse(raw):
    try:
        d = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    if not isinstance(d, dict):
        return {}
    out = {k: v for k, v in d.items() if k in SETTING_DEFAULTS and k not in SETTING_STRINGS and k != "summary_uses" and isinstance(v, (int, float)) and not isinstance(v, bool) and (v >= 0 or (k == "session_life_tokens" and v == -1))}
    for k, cap in SETTING_STRINGS.items():
        if isinstance(d.get(k), str):
            out[k] = d[k].strip()[:cap]
    if isinstance(d.get("workspace_roots"), list):
        out["workspace_roots"] = [x.strip() for x in d["workspace_roots"] if isinstance(x, str) and x.strip()]
    if isinstance(d.get("summary_uses"), dict):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import summarize as S
        known = {k for k, _, _, _ in S.SUMMARY_USES}
        out["summary_uses"] = {k: int(bool(v)) for k, v in d["summary_uses"].items()
                               if k in known and isinstance(v, (int, float)) and not isinstance(v, bool)}
    return out


def settings_raw():
    """The stored settings object as written (unknown keys from newer builds included), or {}."""
    code, o, err = sh(["bd", "memories", "--json"])
    if code != 0:
        return None
    try:
        d = json.loads(o[o.find("{"):])
        raw = json.loads(d.get(SETTINGS_KEY) or "{}")
    except Exception:
        return {}
    return raw if isinstance(raw, dict) else {}


def settings_load():
    raw = settings_raw()
    out = {**SETTING_DEFAULTS, **settings_parse(json.dumps(raw))} if raw is not None else dict(SETTING_DEFAULTS)
    if raw is not None:
        try:
            import session_life
            session_life.cache_settings(out, DISPATCH_DIR)
        except Exception as e:  # noqa: BLE001 - a cache for the lifetime hook never fails settings
            debug("life settings cache", e)
        try:
            import sleep as _sleep
            _sleep.write_mirror(DISPATCH_DIR, _sleep.minutes_of(out))  # the Agents window's host reads this copy
        except Exception as e:  # noqa: BLE001 - a mirror never fails settings
            debug("sleep mirror", e)
    return out


def settings_write(changes):
    """Merge known settings while preserving unrelated keys from other builds."""
    old = settings_raw()
    new = dict(old) if isinstance(old, dict) else {}
    for k, v in settings_parse(json.dumps(changes)).items():
        if k == "summary_uses":
            new[k] = {**(new.get(k) if isinstance(new.get(k), dict) else {}), **v}
        else:
            new[k] = v
    # Silently discard retired options on old boards.
    for k in ("check_mode", "check_model", "gate_sig"):
        new.pop(k, None)
    if isinstance(new.get("summary_uses"), dict):
        new["summary_uses"].pop("check", None)
    wiki_store(SETTINGS_KEY, json.dumps(new, ensure_ascii=False, sort_keys=True))
    return new


def settings_save(cur):
    """Write the init wizard settings."""
    changes = {k: v for k, v in cur.items() if k in SETTING_DEFAULTS}
    settings_write(changes)


def cmd_settings(a):
    if getattr(a, "save", False):
        # the app's save: a JSON object of the changed settings on stdin, merged into what is stored
        try:
            payload = json.loads(sys.stdin.read() or "{}")
        except ValueError:
            payload = None
        if not isinstance(payload, dict):
            raise SystemExit(L.t("settings --save needs one JSON object on standard input", "settings --save 需要标准输入里的一个 JSON 对象"))
        changes = settings_parse(json.dumps(payload))
        settings_write(changes)
        cur = settings_load()
        return out(cur, a.json, lambda x: print(L.t("Settings saved", "设置已保存")))
    cur = settings_load()
    if a.key and a.key not in SETTING_DEFAULTS:
        print(L.t(f"No such setting: {a.key}; available: {', '.join(SETTING_DEFAULTS)}", f"没有这个设置：{a.key}；可用：{', '.join(SETTING_DEFAULTS)}"), file=sys.stderr)
        sys.exit(2)
    if a.key and a.value is not None:
        if a.key == "workspace_roots":
            val = [x.strip() for x in a.value.split(",") if x.strip()]
        elif a.key == "summary_uses":
            try:
                raw = json.loads(a.value)
            except ValueError:
                raw = None
            if not isinstance(raw, dict):
                print(L.t('summary_uses needs a JSON object such as {"session": 1, "project": 0}', 'summary_uses 需要一个 JSON 对象，如 {"session": 1, "project": 0}'), file=sys.stderr)
                sys.exit(2)
            val = settings_parse(json.dumps({"summary_uses": raw})).get("summary_uses", {})
        elif a.key in SETTING_STRINGS:
            val = a.value.strip()
        else:
            try:
                val = int(a.value)
                if val < 0 and not (a.key == "session_life_tokens" and val == -1):
                    raise ValueError
            except ValueError:
                print(L.t("The value must be a whole number, 0 or more", "值必须是非负整数"), file=sys.stderr)
                sys.exit(2)
        settings_write({a.key: val})
        cur = settings_load()
    shown = {a.key: cur[a.key]} if a.key else cur
    notes_en = {"session_life_tokens": "-1 = Auto: 80% of the engine context window; 0 = Off; positive tokens = override, capped at the window",
                "human_aliases": "comma list: these names on the board also count as you (after a user name change, or when two Macs have different user names)",
                "retired_providers": "comma list of provider ids (such as deepseek): never picked by itself or as a fallback; picking it by hand still works",
                "notify_reply": "1 = send to the phone when an agent's reply is done", "notify_attention": "1 = send to the phone when an agent waits for a confirmation",
                "notify_done": "1 = send to the phone when a task is done", "notify_needs_you": "1 = send to the phone when something only you can do comes up",
                "notify_desktop": "1 = without phone notifications, show a banner on this Mac when an agent replies or waits for you (the notifications step of setup turns it on)",
                "notify_mac_finished": "1 = a banner on this Mac when an agent finishes a turn (the window, the bell and background banners all follow this)",
                "notify_mac_needs_you": "1 = a banner on this Mac when an agent waits for your confirmation or answer",
                "notify_mac_stopped": "1 = also a banner when an agent stops on an error, runs out of allowance or its process is gone (default 0: only the bell)",
                "notify_sound": "the banner's sound: default = the system sound, none = silent, or a system sound name such as Glass or Ping",
                "keep_awake": "keep the Mac from sleeping while an agent works or a phone is connected: 1 = the Mac stays awake (the screen still turns off), 2 = the screen stays on too, 0 = sleep as usual (chatd holds caffeinate; closing the lid still sleeps unless on power with an external display)",
                "session_archive_days": "days without activity before an ordinary session is archived; starred ones never are",
                "chat_idle_close_minutes": "minutes an in-app session may sit idle before chatd closes its process (the next message picks it up again); 0 = never",
                "task_archive_days": "days after a task is done before it gets the dispatch:archived label; 0 = never",
                "home_expanded": "how many projects the home page opens by default", "sdk_sessions_scheduled": "1 = sessions started through the SDK count as scheduled sessions",
                "workspace_roots": "workspace root folders: each folder directly inside one is a project",
                "summary_auto": "1 = write a summary of a session after each turn (older sessions too, a few at a time)",
                "summary_model": "the model for summaries, such as claude:haiku (subscription) or zhipu:glm-5.3-flash (API key); empty = picked by itself",
                "summary_uses": 'switches for each use, JSON such as {"session": 0}; the keys are in `dispatch summarize uses`',
                "discuss_rules": "the rules of a discussion (how long to speak, when to SKIP), part of every member's system prompt",
                **{f"discuss_persona_{k}": f"one sentence about who {k} is in a discussion" for k in DISCUSS_PERSONA_DEFAULT},
                "list_density": "list row height: comfortable = 40px, compact = 34px",
                "new_worktree": "the \"new copy\" switch under the new-agent box (only remembered, not used yet): 1 on, 0 off"}
    notes_zh = {"session_life_tokens": "-1 = Auto: 80% of the engine context window; 0 = Off; positive tokens = override, capped at the window", "human_aliases": "逗号分隔：板上这些署名也算「你」（换过用户名、两台电脑用户名不同时用）", "retired_providers": "逗号分隔的供应商 id（如 deepseek）：不再自动选用，也不作回退；显式选它仍可用", "notify_reply": "1=Agent 回复完成时推到手机", "notify_attention": "1=Agent 等确认时推到手机", "notify_done": "1=任务完成时推到手机", "notify_needs_you": "1=「只能你做」时推到手机", "notify_desktop": "1=没配手机推送时，Agent 回复或等你确认就在这台 Mac 上弹通知横幅（首次设置里的通知步骤打开）", "notify_mac_finished": "1=Agent 做完一轮时这台 Mac 弹横幅（窗口、铃铛、后台横幅都照这个）", "notify_mac_needs_you": "1=Agent 等你确认或回答时这台 Mac 弹横幅", "notify_mac_stopped": "1=Agent 出错、额度用完或进程没了停下时也弹横幅（默认 0：只进铃铛）", "notify_sound": "横幅的提示音：default=系统提示音，none=不响，或系统声音名如 Glass、Ping", "keep_awake": "有 Agent 在干活或手机连着时不让 Mac 自动休眠：1=Mac 不睡（屏幕照常熄），2=屏幕也不熄，0=照常休眠（chatd 持有 caffeinate；合盖仍会睡，除非接电源和外接显示器）", "session_archive_days": "天，普通会话无活动后自动归档；收藏的不归档", "chat_idle_close_minutes": "分钟，应用内会话空闲这么久后 chatd 自动关掉它的进程（再发一句会续上）；0=不自动关", "task_archive_days": "天，已完成任务超过这些天自动打 dispatch:archived 标签；0=不自动", "home_expanded": "工作台默认展开前几个项目", "sdk_sessions_scheduled": "1=SDK 启动的会话自动当作定时会话", "workspace_roots": "工作区根目录，其直接子文件夹各算一个项目", "summary_auto": "1 = 一轮结束后自动给会话写总结（含以前的会话，逐步补齐）", "summary_model": "总结用的模型，如 claude:haiku（订阅）或 zhipu:glm-5.3-flash（API Key）；空 = 自动选", "summary_uses": '各用途的开关，JSON 如 {"session": 0}；键见 `dispatch summarize uses`',
             "discuss_rules": "讨论群的规矩（发言长度、什么时候 SKIP），进每个成员的系统提示", **{f"discuss_persona_{k}": f"讨论里 {k} 的一句人设" for k in DISCUSS_PERSONA_DEFAULT}, "list_density": "列表行高：comfortable = 舒适 40px，compact = 紧凑 34px", "new_worktree": "新建 Agent 框下的「新工作树」开关（先只记住，不起作用）：1 开 0 关"}
    notes = L.t(notes_en, notes_zh)
    out(shown, a.json, lambda x: [print(f"{k} = {v}" + (L.t(f" ({notes[k]})", f"（{notes[k]}）") if notes.get(k) else "")) for k, v in x.items()])


def cmd_project_moves(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import move
    jobs = move.list_jobs()
    def text(rows):
        for j in rows:
            print(f"{j['state']:<8} {j['project']} → {j['to']}  {j.get('percent', 0):>3}%  {j.get('label', '')}" + (f"  ✗ {j['error']}" if j.get('error') else ""))
        if not rows:
            print(L.t("No project move in progress or recent", "没有进行中或最近的项目迁移"))
    out(jobs, a.json, text)


def cmd_project(a):
    if a.move_to:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import move
        return move.main_project(a)
    if a.owner:
        if a.owner == "none":
            r = project_owner_set(a.name, "", "")
        elif a.owner == "local":
            r = project_owner_set(a.name, local_host_name(), tailscale_ip() or "")
        else:
            h = next((x for x in hosts() if a.owner in (x["id"], x["name"]) or a.owner in (x.get("aliases") or [])), None)
            if not h:
                raise SystemExit(L.t(f"No {a.owner} in hosts.json", f"hosts.json 里没有 {a.owner}"))
            r = project_owner_set(a.name, h["name"], h.get("ssh", "").split("@")[-1])
        return out(r, a.json, lambda r: print(f"{a.name}: " + (L.t(f"belongs to {r['host']}", f"归 {r['host']}") if r.get("host") else L.t("any Mac", "不指定电脑"))))
    flags = project_flags_load(strict=True)
    if getattr(a, "forget_dir", False):
        cur = {k: v for k, v in dict(flags.get(a.name.strip(), {})).items() if k != "dir"}
        flags = {k: v for k, v in flags.items() if k != a.name.strip()}
        if cur:
            flags[a.name.strip()] = cur
        wiki_store(PROJECT_FLAGS_KEY, json.dumps(flags, ensure_ascii=False, sort_keys=True))
        project_dirs(reload=True)
        return out({"name": a.name.strip(), "dir": ""}, a.json, lambda r: print(L.t(f"{r['name']}: its folder is forgotten (the folder itself is untouched)", f"{r['name']}：已忘记主目录（目录本身没动）")))
    cmd_changes = {k: getattr(a, k) for k in PROJECT_CMD_FIELDS if getattr(a, k, None) is not None}
    if getattr(a, "dir", None):
        # Create (or adopt) a folder as this project's home: the project shows up before any session.
        home = os.path.normpath(os.path.expanduser(a.dir))
        if not os.path.isabs(home):
            raise SystemExit(L.t("--dir needs a full path", "--dir 要完整路径"))
        if not os.path.isdir(home):
            if not getattr(a, "create", False):
                raise SystemExit(L.t(f"Folder does not exist: {home} (add --create to make it)", f"Folder does not exist: {home}（加 --create 新建）"))
            os.makedirs(home, exist_ok=True)
        if getattr(a, "git", False) and not os.path.isdir(os.path.join(home, ".git")):
            sh(["git", "-C", home, "init", "-q"], timeout=20)
        name = a.name.strip()
        cur = dict(flags.get(name, {}))
        cur["dir"] = home
        if not cur.get("archived"):
            cur["starred"] = True
        for k, v in cmd_changes.items():
            if v.strip():
                cur[k] = v.strip()[:400]
            else:
                cur.pop(k, None)
        if "test_cmd" in cmd_changes and cur.get("test_cmd_suggested"):
            cur["test_cmd_dismissed"] = cur.pop("test_cmd_suggested")  # the person decided: not offered again
        flags = {k: v for k, v in flags.items() if k != name}
        flags[name] = cur
        wiki_store(PROJECT_FLAGS_KEY, json.dumps(flags, ensure_ascii=False, sort_keys=True))
        project_dirs(reload=True)
        return out({"name": name, "dir": home, "git": os.path.isdir(os.path.join(home, ".git")), "flags": cur}, a.json,
                   lambda r: print(L.t(f"Project {r['name']} → {r['dir']}", f"项目 {r['name']} → {r['dir']}") + (L.t(" (git repository)", "（git 仓库）") if r["git"] else "")
                                   + "".join(f" · {lab} {cur[k]}" for k, lab in (("test_cmd", L.t("test command", "测试命令")), ("installed_probe", L.t("install check", "安装探针"))) if cur.get(k))))
    if cmd_changes:
        name = a.name.strip()
        cur = dict(flags.get(name, {}))
        for k, v in cmd_changes.items():
            if v.strip():
                cur[k] = v.strip()[:400]
            else:
                cur.pop(k, None)
        if "test_cmd" in cmd_changes and cur.get("test_cmd_suggested"):
            cur["test_cmd_dismissed"] = cur.pop("test_cmd_suggested")  # the person decided: not offered again
        flags = {k: v for k, v in flags.items() if k != name}
        if cur:
            flags[name] = cur
        wiki_store(PROJECT_FLAGS_KEY, json.dumps(flags, ensure_ascii=False, sort_keys=True))
        return out({"name": name, **{k: cur.get(k, "") for k in PROJECT_CMD_FIELDS}}, a.json,
                   lambda r: print(L.t(f"{name}: test command {r['test_cmd'] or '(none: no tests are run when checking)'} · install check {r['installed_probe'] or '(none)'}", f"{name}：测试命令 {r['test_cmd'] or '（无：验收时不跑测试）'} · 安装探针 {r['installed_probe'] or '（无）'}")))
    changes = {}
    if a.star: changes["starred"] = True
    if a.unstar: changes["starred"] = False
    if a.archive: changes["archived"] = True
    if a.unarchive: changes["archived"] = False
    if changes:
        try:
            flags = project_flags_apply(flags, a.name, changes)
        except ValueError as e:
            print(str(e), file=sys.stderr)
            sys.exit(2)
        wiki_store(PROJECT_FLAGS_KEY, json.dumps(flags, ensure_ascii=False, sort_keys=True))
    cur = flags.get(a.name.strip(), {})
    out({"name": a.name.strip(), **{f: bool(cur.get(f)) for f in PROJECT_FLAG_FIELDS}}, a.json,
        lambda x: print(f"{x['name']}: " + L.t(f"{'★ starred' if x['starred'] else 'not starred'} · {'archived' if x['archived'] else 'not archived'}", f"{'★ 已收藏' if x['starred'] else '未收藏'} · {'已归档' if x['archived'] else '未归档'}")))


def cmd_projects(a):
    flags = project_flags_load()
    rows = [{"name": k, **{f: bool(v.get(f)) for f in PROJECT_FLAG_FIELDS}} for k, v in sorted(flags.items())]
    if a.json:
        # with where each one lives (folder, Mac, label, git): the Agents window groups its sessions by these
        pv = _mod("projects_view")
        pv.D = _THIS
        print(json.dumps(pv.sidebar_registry() if getattr(a, "sidebar", False) else pv.registry() if flags else rows, ensure_ascii=False))
        return
    if not rows:
        print(L.t("No starred or archived projects. `dispatch project <name> --star` stars one, `--archive` archives it.", "没有收藏或归档的项目。`dispatch project <名> --star` 收藏，`--archive` 归档。"))
    for r in rows:
        print(f"{'★' if r['starred'] else ' '} {r['name']}{L.t(' (archived)', '（已归档）') if r['archived'] else ''}")


# Closed tasks stay in the done column forever unless something labels them. The manual
# button does 30 days once; this runs the same rule every day using the shared setting.
TASK_ARCHIVED_LABEL = "dispatch:archived"
TASK_ARCHIVE_SKIP = (TASK_ARCHIVED_LABEL, "dispatch:trashed", "dispatch:outcome")


def task_archive_candidates(issues, days, now=None):
    """Ids of tasks closed more than `days` days ago, not already archived/trashed/outcomes."""
    if days <= 0:
        return []
    cutoff = (time.time() if now is None else now) - days * 86400
    ids = []
    for it in issues:
        if it.get("status") != "closed":
            continue
        if any(l in TASK_ARCHIVE_SKIP for l in it.get("labels") or []):
            continue
        ts = _iso_epoch(it.get("closed_at") or it.get("updated_at") or "")
        if ts is not None and ts < cutoff:
            ids.append(it["id"])
    return ids


def cmd_task_archive(a):
    days = a.days if a.days is not None else int(settings_load().get("task_archive_days") or 0)
    if days <= 0:
        out({"days": 0, "archived": [], "count": 0}, a.json,
            lambda _: print(L.t("task_archive_days=0: no task was archived (turn it on in Settings or with `dispatch settings task_archive_days <days>`)", "task_archive_days=0，没有自动归档任何任务（在设置页或 `dispatch settings task_archive_days <天>` 打开）")))
        return
    code, o, _ = sh(["bd", "list", "--all", "--json"], timeout=60)
    issues = []
    if code == 0:
        try:
            issues = json.loads(o[o.find("["):])
        except Exception:
            issues = []
    done = []
    for tid in task_archive_candidates(issues, days):
        code, _, _ = sh(["bd", "update", tid, "--add-label", TASK_ARCHIVED_LABEL, "--json"], timeout=20)
        if code == 0:
            done.append(tid)
    out({"days": days, "archived": done, "count": len(done)}, a.json,
        lambda x: print(L.t(f"Archived {x['count']} tasks done more than {x['days']} days ago" + (": " + ", ".join(x["archived"]) if x["archived"] else ""), f"已归档 {x['count']} 项完成超过 {x['days']} 天的任务" + ("：" + "、".join(x["archived"]) if x["archived"] else ""))))


# ---------------------------------------------------------------- project documents (the 文档 tab)
# A project's research and review write-ups live in its repo (design/, docs/, 研究/), which the
# project page could not see. This scans those folders and adds explicitly registered paths/URLs
# (one shared bd memory per project, like dispatch-projects). The app only renders what this returns.
DOC_DIR_NAMES = ("design", "docs", "研究")
DOC_EXTS = (".md", ".html", ".htm")
DOC_KINDS = ("调研", "复审", "设计", "文档", "其他", "交付", "截图", "handoff")
DOCS_KEY_PREFIX = INTERNAL_MEMORY_PREFIX + "docs-"   # dispatch-docs-<project>
DOC_MAX_READ = 4 * 1024 * 1024
DOC_MAX_ASSET = 20 * 1024 * 1024


def docs_key(project):
    return DOCS_KEY_PREFIX + (project or "").strip()


def docs_id(path):
    return hashlib.sha256(os.path.expanduser(path).encode("utf-8", "replace")).hexdigest()[:16]


def docs_is_url(value):
    return bool(re.match(r"^[a-zA-Z][\w+.-]*://", (value or "").strip()))


def docs_kind_of(name):
    """research/调研 → 调研, review/复审 → 复审, anything else in a doc folder → 文档."""
    low = (name or "").lower()
    if "research" in low or "调研" in name:
        return "调研"
    if "review" in low or "复审" in name:
        return "复审"
    return "文档"


def docs_kind_in_design(path, kind):
    """A plain document under a design/ folder is a design document: the Artifact tool registers its
    pages as 文档, and a scanned file without research/review in its name comes out as 文档 too.
    调研 and 复审 stay what they were registered as, so the Research and Review filters still work
    in a project that keeps everything under design/."""
    if kind in ("文档", "其他", "", None) and path and not docs_is_url(path) and "design" in os.path.normpath(path).split(os.sep)[:-1]:
        return "设计"
    return kind


def docs_title(path, limit=80):
    """First `# heading` (or <title>/<h1>), else the file name without its suffix."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            head = f.read(8192)
    except OSError:
        return os.path.splitext(os.path.basename(path))[0][:limit]
    if path.lower().endswith((".html", ".htm")):
        m = re.search(r"<title[^>]*>(.*?)</title>", head, re.S | re.I) or re.search(r"<h1[^>]*>(.*?)</h1>", head, re.S | re.I)
        if m:
            t = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", m.group(1))).strip()
            if t:
                return t[:limit]
    for line in head.splitlines():
        m = re.match(r"^#\s+(.+?)\s*#*\s*$", line)
        if m:
            return m.group(1).strip()[:limit]
    return os.path.splitext(os.path.basename(path))[0][:limit]


def docs_entries_parse(raw):
    try:
        rows = json.loads(raw) if raw else []
    except ValueError:
        return []
    if not isinstance(rows, list):
        return []
    out = []
    for r in rows:
        if not isinstance(r, dict) or not isinstance(r.get("path"), str) or not r["path"].strip():
            continue
        kind = r.get("kind") if r.get("kind") in DOC_KINDS else ""
        e = {"id": r.get("id") or docs_id(r["path"]), "path": r["path"].strip(),
             "title": (r.get("title") or "").strip(), "kind": kind,
             "added_at": float(r.get("added_at") or 0)}
        # what the Docs tab adds (docs_view.py): the tasks it was delivered for, the session that
        # registered it, when it was delivered and seen, and a tombstone for "Remove from Docs"
        if isinstance(r.get("tasks"), list):
            e["tasks"] = [t for t in r["tasks"] if isinstance(t, str) and t]
        if isinstance(r.get("sources"), list):
            e["sources"] = [s for s in r["sources"] if isinstance(s, str) and s]
        for k in ("session",):
            if isinstance(r.get(k), str) and r[k]:
                e[k] = r[k]
        for k in ("delivered_at", "seen_at"):
            if isinstance(r.get(k), (int, float)) and r[k]:
                e[k] = int(r[k])
        if r.get("hidden"):
            e["hidden"] = True
        out.append(e)
    return out


def docs_registered(project):
    code, o, _ = sh(["bd", "memories", "--json"])
    if code != 0:
        return []
    try:
        d = json.loads(o[o.find("{"):])
    except Exception:
        return []
    return docs_entries_parse(d.get(docs_key(project), ""))


# bd keeps a memory in one Dolt column of 65,535 bytes (MEMORY_MAX_BYTES). A project's Docs list grows by one entry per
# delivery and handoff: canvas-notes reached the limit at 188 entries, and from then on every handoff and delivery
# failed with "Error 1105 … too large for column 'value'" (task-w97qw). The list keeps some room below the limit.
DOCS_MAX_BYTES = 60000


def _docs_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def docs_fit(entries, keep="", limit=DOCS_MAX_BYTES):
    """`entries` cut to `limit` bytes, the oldest first within each group, in this order: tombstones of files that are
    gone, handoffs (each stays on its task as a comment and in `dispatch handoff show`), other documents (a delivery
    stays in its task's deliverables, a file under design/ or docs/ comes back through the scan), tombstones of files
    that are still there. `keep` (the id just registered) stays."""
    total = len(_docs_json(entries).encode())
    if total <= limit:
        return entries

    def rank(i):
        e = entries[i]
        if e.get("hidden"):
            group = 3 if docs_is_url(e["path"]) or os.path.exists(e["path"]) else 0
        else:
            group = 1 if e.get("kind") == "handoff" else 2
        return group, e.get("added_at") or 0

    drop = set()
    for i in sorted((i for i, e in enumerate(entries) if e["id"] != keep), key=rank):
        if total <= limit:
            break
        drop.add(i)
        total -= len(_docs_json(entries[i]).encode()) + 2  # the entry and its ", "
    return [e for i, e in enumerate(entries) if i not in drop]


def docs_save(project, entries, keep=""):
    wiki_store(docs_key(project), _docs_json(docs_fit(entries, keep)))


def docs_git_root(path):
    """The folder holding .git (a directory, or the file of a linked worktree), walking up from
    `path`; '' if none. A filesystem walk: one `git rev-parse` per session folder made `docs list`
    take seconds on a board with a few hundred worktree sessions."""
    d = os.path.abspath(path or "")
    while d and d != os.path.dirname(d):
        if os.path.exists(os.path.join(d, ".git")):
            return d
        d = os.path.dirname(d)
    return ""


def docs_project_dirs(project, names=None):
    """Where this project's files live: the git roots of its sessions' working directories, the folder it was
    added with, and ~/Projects/<name>. Mirrors task_project_dir, without one bd call per task. `names`:
    project_names() when the caller has them (from the board export it holds anyway)."""
    name = (project or "").strip()
    out, seen = [], set()

    def add(d):
        d = os.path.abspath(os.path.expanduser(d or ""))
        if not d or d in seen or not os.path.isdir(d):
            return
        # A git worktree (.git is a file pointing at the main repo) holds a copy of the same
        # documents: read them from the main repository instead, once.
        dotgit = os.path.join(d, ".git")
        if os.path.isfile(dotgit):
            try:
                gitdir = open(dotgit, encoding="utf-8").read().strip().split("gitdir:", 1)[1].strip()
                main = os.path.abspath(os.path.join(gitdir.split("/.git/worktrees/")[0]))
                if os.path.isdir(main):
                    d = main
            except Exception:
                return
            if d in seen:
                return
        seen.add(d); out.append(d)

    try:
        names = names if names is not None else project_names()
        roots = settings_load().get("workspace_roots") or []
        by_cwd = {}
        for e in load_index().values():
            cwd = (e.get("cwd") or "").rstrip("/")
            if not cwd or not os.path.isdir(cwd):
                continue
            if cwd not in by_cwd:
                by_cwd[cwd] = project_of_cwd(cwd, names, roots).lower() == name.lower()
            if by_cwd[cwd]:
                add(docs_git_root(cwd) or cwd)
    except Exception:
        pass
    # the folder the project was added with (Add Project, `projects-view add`), sessions there or not
    add(project_dirs().get(name.lower()) or "")
    add(os.path.join(HOME, "Projects", name))
    return out


DOC_SKIP_DIRS = {"node_modules", "manual", "demo", "dist", "build", "assets", "_site", "site", "public", "static", "vendor"}


def docs_scan(dirs, max_depth=2):
    """Every .md/.html under design/, docs/ and 研究/ of the given roots, at most two folders deep."""
    rows, seen = [], set()
    for base in dirs:
        for sub in DOC_DIR_NAMES:
            root = os.path.abspath(os.path.join(base, sub))
            if not os.path.isdir(root):
                continue
            for cur, dnames, fnames in os.walk(root):
                rel = os.path.relpath(cur, root)
                depth = 0 if rel == "." else rel.count(os.sep) + 1
                # Published-site folders (the manual's translations, the demo build, screenshots) are not
                # this project's working documents; a two-letter folder is a translation directory.
                dnames[:] = [d for d in dnames if d not in DOC_SKIP_DIRS and not d.startswith(".") and not (len(d) == 2 and d.isalpha() and d.islower())]
                if depth >= max_depth:
                    dnames[:] = []
                for fname in fnames:
                    if os.path.splitext(fname)[1].lower() not in DOC_EXTS:
                        continue
                    real = os.path.realpath(os.path.join(cur, fname))
                    if real in seen:
                        continue
                    seen.add(real)
                    try:
                        st = os.stat(real)
                    except OSError:
                        continue
                    rows.append({"id": docs_id(real), "title": docs_title(real), "kind": docs_kind_of(fname),
                                 "path": real, "size": st.st_size, "mtime": st.st_mtime, "source": "scan",
                                 "ext": os.path.splitext(fname)[1].lower().lstrip("."), "dir": os.path.dirname(real)})
    return rows


def docs_registered_rows(entries):
    rows = []
    for e in entries:
        url = docs_is_url(e["path"])
        row = {"id": e["id"], "title": e["title"], "kind": e["kind"], "path": e["path"], "url": url,
               "source": "registered", "mtime": e.get("added_at") or 0}
        for k in ("session", "delivered_at", "seen_at", "hidden"):
            if e.get(k):
                row[k] = e[k]
        if e.get("tasks"):
            row["tasks_registered"] = list(e["tasks"])
        if e.get("sources"):
            row["sources"] = list(e["sources"])
        if url:
            if not row["title"]:
                row["title"] = e["path"].rstrip("/").rsplit("/", 1)[-1] or e["path"]
            if not row["kind"]:
                row["kind"] = "其他"
        else:
            path = os.path.abspath(os.path.expanduser(e["path"]))
            row["path"] = path
            row["dir"] = os.path.dirname(path)
            row["ext"] = os.path.splitext(path)[1].lower().lstrip(".")
            if os.path.isfile(path):
                try:
                    st = os.stat(path)
                    row["size"], row["mtime"] = st.st_size, st.st_mtime
                except OSError:
                    pass
                if not row["title"]:
                    row["title"] = docs_title(path)
                if not row["kind"]:
                    row["kind"] = docs_kind_of(os.path.basename(path))
            if not row["title"]:
                row["title"] = os.path.basename(path)
            if not row["kind"]:
                row["kind"] = "文档"
        rows.append(row)
    return rows


def docs_merge(scanned, registered):
    """Scanned files plus registered paths/URLs, newest first; a registration wins on title/kind."""
    by = {}
    for r in scanned:
        by[os.path.realpath(r["path"])] = r
    for r in registered:
        key = r["path"] if r.get("url") else os.path.realpath(r["path"])
        old = by.get(key)
        if not old:
            by[key] = r
            continue
        merged = dict(old)
        for k, v in r.items():
            if v not in ("", None, 0, 0.0, False) or k in ("url", "size", "mtime"):
                merged[k] = v
        merged["source"] = "registered"
        by[key] = merged
    rows = list(by.values())
    for r in rows:
        r["kind"] = docs_kind_in_design(r.get("path"), r.get("kind"))
    rows.sort(key=lambda r: r.get("mtime") or 0, reverse=True)
    return rows


def docs_project_of_folder(folder, names=None):
    """The project a folder belongs to, for `docs list --folder`: a linked worktree counts as the
    repository it was made from."""
    folder = os.path.abspath(os.path.expanduser(folder or ""))
    if not os.path.isdir(folder):
        raise ValueError("Folder does not exist: " + folder)
    name = project_of_cwd(folder, names if names is not None else project_names())
    if not name:
        raise ValueError("This folder does not belong to a project: " + folder)
    return name


def docs_list(project, dirs=None):
    name = (project or "").strip()
    if not name:
        raise ValueError("Provide a project name")
    return docs_merge(docs_scan(dirs if dirs is not None else docs_project_dirs(name)),
                      docs_registered_rows(docs_registered(name)))


DOCS_REMOTE_TTL = 120


def merge_remote_docs(project, rows):
    """A Mac without this project's directory scans nothing local — ask every other Mac in
    hosts.json for its own `docs <project> --local --json` and fold in what it found, tagged
    `host` so the UI reads (and later, opens) those through that host instead of this one."""
    hosts_seen, unavailable = [], []
    seen = {r["id"] for r in rows}
    for h in hosts():
        rargs = ["docs", project, "--local", "--json"]
        r = remote_dispatch(h, rargs, DOCS_REMOTE_TTL, timeout=12, background=True)
        if not isinstance(r, dict) or "docs" not in r:
            unavailable.append(h["name"])
            continue
        hosts_seen.append(h["name"])
        for d in r.get("docs") or []:
            if not isinstance(d, dict) or d.get("id") in seen:
                continue
            seen.add(d.get("id"))
            rows.append(dict(d, host=h["id"], host_name=h["name"]))
    rows.sort(key=lambda r: r.get("mtime") or 0, reverse=True)
    return rows, hosts_seen, unavailable


def docs_register(project, value, title="", kind=""):
    name = (project or "").strip()
    if not name:
        raise ValueError("Provide a project name")
    value = (value or "").strip().strip("<>")
    if not value:
        raise ValueError(L.t("Give the document's path or URL", "请给出文档路径或 URL"))
    if kind and kind not in DOC_KINDS:
        raise ValueError(L.t("The kind must be one of: ", "类型只能是：") + " / ".join(DOC_KINDS))
    url = docs_is_url(value)
    path = value if url else os.path.abspath(os.path.expanduser(value))
    if not url:
        if not os.path.isfile(path):
            raise ValueError(L.t("No such file: ", "找不到这个文件：") + path)
        if not title:
            title = docs_title(path)
    entry = {"id": docs_id(path), "path": path, "title": (title or "").strip()[:120],
             "kind": docs_kind_in_design(path, kind or ("其他" if url else docs_kind_of(os.path.basename(path)))),
             "added_at": time.time()}
    entries = [e for e in docs_registered(name) if e["id"] != entry["id"]]
    entries.append(entry)
    docs_save(name, entries)
    return docs_registered_rows([entry])[0]


def docs_unregister(project, doc_id):
    entries = docs_registered(project)
    keep = [e for e in entries if e["id"] != doc_id]
    if len(keep) == len(entries):
        return False
    docs_save(project, keep)
    return True


def docs_read(project, doc_id, asset=""):
    """Markdown body (html/URL stay on disk — the app opens those with openPath)."""
    row = next((r for r in docs_list(project) if r["id"] == doc_id), None)
    if not row:
        raise ValueError(L.t("No such document: ", "找不到这份文档：") + doc_id)
    if row.get("url"):
        if asset:
            raise ValueError(L.t("A web document has no local attachments", "网页文档没有本地附件"))
        return {**row, "html": True, "text": ""}
    path = row["path"]
    if not os.path.isfile(path):
        raise ValueError(L.t("The file is gone: ", "文件不在了：") + path)
    if asset:
        return docs_asset(path, asset)
    if os.path.splitext(path)[1].lower() in (".html", ".htm"):
        return {**row, "html": True, "text": ""}
    if os.path.getsize(path) > DOC_MAX_READ:
        raise ValueError(L.t("The document is over 4 MB; open it in another app", "文档超过 4 MB，请在外部应用打开"))
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    return {**row, "html": False, "text": text, "dir": os.path.dirname(path)}


def docs_asset(doc_path, rel):
    """An image/file next to a document, for relative references inside the markdown."""
    import base64, mimetypes
    base = os.path.realpath(os.path.dirname(doc_path))
    target = os.path.realpath(os.path.join(base, (rel or "").split("#")[0].split("?")[0]))
    if target != base and not target.startswith(base + os.sep):
        raise ValueError(L.t("Only files in the document's own folder can be read", "只允许读取文档同目录下的文件"))
    if not os.path.isfile(target):
        raise ValueError(L.t("The file is gone: ", "文件不在了：") + rel)
    if os.path.getsize(target) > DOC_MAX_ASSET:
        raise ValueError(L.t("The attachment is over 20 MB; open it in its own app", "附件超过 20 MB，请在原应用打开"))
    data = open(target, "rb").read()
    mime = mimetypes.guess_type(target)[0] or "application/octet-stream"
    if data.startswith(b"\xff\xd8\xff"):
        mime = "image/jpeg"
    elif data.startswith(b"\x89PNG\r\n"):
        mime = "image/png"
    return {"name": os.path.basename(target), "path": target, "mime": mime,
            "size": len(data), "data": base64.b64encode(data).decode()}


def cmd_docs(a):
    import docs_view
    docs_view.D = sys.modules[__name__]
    op = (a.op or "").strip()
    project, extra = (a.project or "").strip(), list(a.extra or [])
    if op not in ("add", "rm", "read", "list", "seen"):
        # `dispatch docs <project>` — the project is the first positional argument.
        extra = ([project] if project else []) + extra
        project, op = op, "list"
    try:
        folder = (getattr(a, "folder", "") or "").strip()
        if folder and op != "list" and project and not extra:
            # `docs seen --folder <dir> <id>`: the one positional is the document
            extra, project = [project], ""
        issues = names = None
        if op == "list":
            # one board export for the project names, the folder's project and the documents' tasks: each
            # `bd list --all` it replaces took seconds while other agents kept the board busy (2026-10-09)
            from board_export import export_issues
            issues = export_issues(sh, beads_dir=BEADS_DIR, dispatch_dir=DISPATCH_DIR, home=HOME)
            names = project_names(issues)
        if folder and not project:
            # Dispatch IDE's Docs tab only knows the session's folder (often a worktree)
            project = docs_project_of_folder(folder, names)
        if op == "list":
            dirs = docs_project_dirs(project, names) if project else []
            rows, counts, reader = docs_view.list_view(project, dirs, issues=issues, session=getattr(a, "session", "") or "",
                                                       include_all=bool(getattr(a, "all", False)), with_reader=True,
                                                       which=getattr(a, "filter", "") or "all")
            hosts_seen, unavailable = [], []
            if not getattr(a, "local", False):
                rows, hosts_seen, unavailable = merge_remote_docs(project, rows)
            # reader: rows the list leaves out, for the reader's "for <task>" line only (not listed, not counted)
            result = {"project": project, "docs": rows, "counts": counts, "reader": reader, "dirs": dirs, "hosts": hosts_seen, "unavailable_hosts": unavailable}
            out(result, a.json, lambda r: print(docs_view.text(r)))
            return
        if op == "read":
            if not extra:
                raise ValueError(L.t("Usage: dispatch docs read <project> <document id>", "用法：dispatch docs read <项目> <文档 id>"))
            row = docs_read(project, extra[0], a.asset or "")
            out(row, a.json, lambda r: print(r.get("text") or r["path"]))
            return
        if op == "add":
            if not extra:
                raise ValueError(L.t("Usage: dispatch docs add <project> <path or URL> [--title …] [--kind …] [--task <id>]…", "用法：dispatch docs add <项目> <路径或 URL> [--title …] [--kind …] [--task <id>]…"))
            row = docs_view.register(project, extra[0], title=a.title or "", kind=a.kind or "",
                                     tasks=getattr(a, "task", None) or [],
                                     session=docs_view.current_session(getattr(a, "session", "") or ""))
            out(row, a.json, lambda r: print(L.t(f"Registered: {r['kind']} · {r['title']} → {r['path']}", f"已登记：{r['kind']} · {r['title']} → {r['path']}")))
            return
        if op == "seen":
            if not extra:
                raise ValueError(L.t("Usage: dispatch docs seen <project> <document id>", "用法：dispatch docs seen <项目> <文档 id>"))
            ok = docs_view.mark_seen(project, extra[0])
            out({"seen": ok, "id": extra[0], "project": project}, a.json, lambda r: print(L.t("Marked as seen", "已记下看过") if r["seen"] else L.t("This one is not registered; nothing marked", "这份没登记，不记")))
            return
        if not extra:
            raise ValueError(L.t("Usage: dispatch docs rm <project> <document id>", "用法：dispatch docs rm <项目> <文档 id>"))
        removed = docs_view.remove(project, extra[0])
        out({"removed": removed, "project": project}, a.json,
            lambda r: print(L.t(f"Removed from {r['project']}'s Docs", f"已从 {r['project']} 的 Docs 移除") if r["removed"] else L.t("No such document", "没找到这份文档")))
    except ValueError as e:
        if a.json:
            print(json.dumps({"error": str(e)}, ensure_ascii=False))
        else:
            print(f"✗ {e}", file=sys.stderr)
        sys.exit(1)


# The wiki keeps its Chinese markers on disk (wiki_parse reads them); what an English speaker sees says them in English.
WIKI_LABELS_EN = {"坑": "pitfall", "做对": "worked", "复盘": "retro", "方法": "how-to", "记忆": "memory",
                  "【解法】": "Fix: ", "【为什么】": "Why: ", "【技术】": "Tech: ", "【做对】": "Went right: ", "【做错】": "Went wrong: "}


def wiki_label(label):
    return L.t(WIKI_LABELS_EN.get(label, label), label)


def wiki_line(it, width=170):
    lab = wiki_label(WIKI_KINDS[it["kind"]]["label"] if it["kind"] else "记忆")
    body = it["text"]
    for label, v in it["fields"].items():
        if v:
            body += f" {wiki_label(label)}{v}"
    body = re.sub(r"\s+", " ", body)
    return f"[{lab}] {it['key']}" + L.t(": ", "：") + f"{body[:width]}{'…' if len(body) > width else ''}"


def wiki_related(a, all_items):
    """`dispatch wiki related <task>`: the entries that mean the same thing as this task.
    Semantic first (智谱 embedding + sqlite-vec); falls back to the old project tag when the
    key is missing, the index cannot be built, or the semantic hits are empty."""
    limit = getattr(a, "limit", 8) or 8
    tid = (a.text or "").strip()
    issue = bd_json(["show", tid, "--json"])
    if not issue or not issue.get("id"):
        print(L.t(f"No task {tid}", f"没有任务 {tid}"), file=sys.stderr)
        sys.exit(1)
    kind = getattr(a, "kind", "pit") or "pit"
    proj = next((l.split(":", 1)[1] for l in issue.get("labels") or [] if l.startswith("project:")), "")
    query = "\n".join(x for x in [issue.get("title") or "", (issue.get("description") or "")[:1200]] if x)
    rows, why = [], ""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import semantic
        rows = semantic.related(tid, query, all_items, limit=limit, kind=kind)
    except Exception as e:
        why = str(e)[:120]
    if not rows:
        rows = [{**it, "score": None} for it in all_items
                if (kind == "all" or it["kind"] == kind) and (it["task"] == tid or (proj and it["project"].lower() == proj.lower()))]
        rows.sort(key=lambda it: (it["task"] != tid,))
        rows = rows[:limit]
        if why:
            print(L.t(f"Semantic search is not available ({why}); matching by project instead", f"语义搜索不可用（{why}），改用项目匹配"), file=sys.stderr)
    semantic_hits = any(it.get("score") is not None for it in rows)

    def text(rs):
        for it in rs:
            score = f" {it['score']:.3f}" if it.get("score") is not None else ""
            print(wiki_line(it, 400) + score)
        print(L.t(f"\n{len(rs)} entries" + (" (semantic)" if semantic_hits else " (by project)"), f"\n{len(rs)} 条" + ("（语义）" if semantic_hits else "（按项目）")))
    out(rows, a.json, text)


def fail_answer(as_json, msg, code):
    """Stop with an error: `{"ok": false, "error": …}` on stdout for callers that read JSON
    (the IDE bridge), the message on stderr otherwise."""
    if as_json:
        print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    else:
        print(msg, file=sys.stderr)
    sys.exit(code)


def wiki_find(items, key):
    """The entry with this key; the kind prefix may be left out (`show` accepts the same)."""
    key = (key or "").strip()
    for it in items:
        if it["key"] == key or any(it["key"] == k["prefix"] + key for k in WIKI_KINDS.values()):
            return it
    return None


def wiki_edited(it, body=None, fields=None, project=None):
    """The new content of an entry: the body and the given fields replaced, the rest kept.
    fields: {name: value}; None keeps a field, "" clears it. The #project / #task tags stay
    unless `project` is given ("" drops the tag)."""
    kind = it["kind"]
    text = it["text"] if body is None else body.strip()
    proj = it["project"] if project is None else project.strip()
    if not kind:
        content = text + (f" #project:{proj}" if proj else "") + (f" #task:{it['task']}" if it["task"] else "")
        return content
    k = WIKI_KINDS[kind]
    if text.startswith(k["head"]):
        text = text[len(k["head"]):].strip()
    have = {name: it["fields"].get(label, "") for name, label in k["fields"]}
    for name, v in (fields or {}).items():
        if name in have and v is not None:
            have[name] = v
    return wiki_compose(kind, text, have, proj or None, it["task"] or None)


def wiki_change(a, all_items):
    """`dispatch wiki edit <key> [--body …] [--fix …]` and `dispatch wiki rm <key>`: the
    Knowledge page in Dispatch IDE edits and deletes entries; an agent can do the same."""
    it = wiki_find(all_items, a.text)
    if not it:
        fail_answer(a.json, f"Entry not found: {a.text}", 1)
    if a.op == "rm":
        wiki_migrate_first()
        try:
            os.remove(wiki_file(it["key"]))
        except FileNotFoundError:
            pass
        out({"ok": True, "key": it["key"], "removed": True}, a.json, lambda o: print(L.t(f"Deleted {o['key']}", f"已删除 {o['key']}")))
        return
    body = a.body
    if body == "-":
        body = sys.stdin.read()
    fields = {"fix": a.fix, "why": a.why, "tech": a.tech, "good": a.good, "bad": a.bad}
    if body is None and all(v is None for v in fields.values()) and a.project is None:
        print("No changes specified. Use --body or --fix / --why / --tech / --good / --bad / -P", file=sys.stderr)
        sys.exit(2)
    if body is not None and not body.strip():
        print("The body cannot be empty. Use dispatch wiki rm to delete this entry.", file=sys.stderr)
        sys.exit(2)
    content = wiki_edited(it, body, fields, a.project)
    wiki_store(it["key"], content)
    out({"ok": True, "key": it["key"], "item": wiki_parse(it["key"], content)}, a.json, lambda o: print(L.t(f"Updated {o['key']}", f"已更新 {o['key']}")))


WIKI_DATES_FILE = os.path.join(DISPATCH_DIR, "wiki-dates.json")


def wiki_dates(keys, board=False):
    """When each entry was first written, from the board's Dolt history (`bd sql`), kept in
    wiki-dates.json so only new keys cost a query (about 3 s). {key: "2026-09-26T19:01:13Z"};
    an entry the history does not have yet is dated when it was first seen."""
    try:
        with open(WIKI_DATES_FILE, encoding="utf-8") as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    if not board and wiki_files_on() and any(k not in cache for k in keys):
        # entries written as files: the date the file first appeared here (or arrived from another Mac)
        for k in keys:
            if k not in cache:
                try:
                    st = os.stat(wiki_file(k))
                    cache[k] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(getattr(st, "st_birthtime", st.st_mtime)))
                except OSError:
                    pass
        try:
            os.makedirs(DISPATCH_DIR, exist_ok=True)
            with open(WIKI_DATES_FILE, "w", encoding="utf-8") as f:
                json.dump(cache, f)
        except OSError:
            pass
    if any(k not in cache for k in keys):
        code, o, _err = sh(["bd", "sql", "--json", "select `key`, min(commit_date) as d from dolt_history_config where `key` like 'kv.memory.%' group by `key`"], timeout=60)
        if code == 0:
            try:
                for r in json.loads(o[o.find("["):]):
                    k = str(r.get("key", ""))[len("kv.memory."):]
                    if k and r.get("d"):
                        cache[k] = str(r["d"])
                seen = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                for k in keys:  # not in the history yet (uncommitted working set, a board without Dolt): first seen now
                    cache.setdefault(k, seen)
                os.makedirs(DISPATCH_DIR, exist_ok=True)
                with open(WIKI_DATES_FILE, "w", encoding="utf-8") as f:
                    json.dump(cache, f)
            except ValueError:
                pass
    return {k: cache.get(k, "") for k in keys}


def cmd_wiki(a):
    if a.op == "migrate":
        try:
            r = wiki_migrate()
        except RuntimeError as e:
            fail_answer(a.json, str(e), 1)
        out(r, a.json, lambda o: print(f"Copied {o['copied']} entries into {o['dir']} ({o['kept']} were there already, {o['total']} in the board). "
                                       "The board keeps its copies; wiki commands now read the files."))
        return
    if a.op == "add":
        if getattr(a, "body", None):  # --body / --body - (stdin): text that may start with "-"
            a.text = sys.stdin.read() if a.body == "-" else a.body
        a.text = (a.text or "").strip()
        if not a.text:
            fail_answer(a.json, L.t("Write what to record", "需要写内容"), 2)
        kind = a.kind or "pit"
        fields = {"fix": a.fix, "why": a.why, "tech": a.tech, "good": a.good, "bad": a.bad}
        content = wiki_compose(kind, a.text, fields, a.project, a.task)
        pre = WIKI_KINDS[kind]["prefix"]
        slug = re.sub(r"[^a-z0-9]+", "-", a.text.lower()).strip("-")[:40] or str(int(time.time()))
        key = a.key or (pre + slug)
        if not key.startswith(pre):
            key = pre + key
        if not a.key:
            # a slug made from the text can repeat (Chinese text keeps only its ASCII words): never
            # overwrite another entry by accident; --key is the way to replace one on purpose
            taken = {it["key"] for it in wiki_all()}
            base, n = key, 2
            while key in taken:
                key, n = f"{base}-{n}", n + 1
        wiki_store(key, content)
        if a.json:
            print(json.dumps({"ok": True, "key": key, "item": wiki_parse(key, content)}, ensure_ascii=False))
            return
        print(L.t(f"Recorded {key} ({wiki_label(WIKI_KINDS[kind]['label'])}). Agents in this project see it when their next session starts; `dispatch wiki search <word>` finds it any time.", f"已记录 {key}（{WIKI_KINDS[kind]['label']}）。同项目的 Agent 下次会话启动会看到；任何时候 `dispatch wiki search 关键词` 可查。"))
        return
    all_items = wiki_all()
    if a.op == "show":
        for it in all_items:
            if it["key"] == a.text or any(it["key"] == k["prefix"] + (a.text or "") for k in WIKI_KINDS.values()):
                print(it["raw"])
                return
        print(L.t("No such entry", "没有这条"), file=sys.stderr)
        sys.exit(1)
    if a.op == "related":
        return wiki_related(a, all_items)
    if a.op in ("edit", "rm"):
        return wiki_change(a, all_items)
    kind = getattr(a, "kind", "") or ""
    q = (a.text or "").strip().lower()
    if not a.all:
        all_items = [it for it in all_items if it["kind"]]
    items = [it for it in all_items if (not kind or kind == "all" or it["kind"] == kind)]
    if a.project:
        items = [it for it in items if it["project"] == a.project]
    keyword = lambda xs: [it for it in xs if q in it["raw"].lower() or q in it["key"].lower()]
    if getattr(a, "semantic", False) and q:
        # Meaning, not spelling: the query is embedded and the nearest entries come back.
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import semantic
            if not semantic.available():
                print(L.t("No ZHIPU_API_KEY; matching by keyword instead", "没有 ZHIPU_API_KEY，改用关键字匹配"), file=sys.stderr)
                items = keyword(items)
            else:
                hits = semantic.search(a.text, all_items, limit=getattr(a, "limit", 8) or 8,
                                       kind=kind if kind != "all" else "", project=a.project or "")
                items = hits or keyword(items)
        except Exception as e:
            print(L.t(f"Semantic search is not available ({str(e)[:120]}); matching by keyword instead", f"语义搜索不可用（{str(e)[:120]}），改用关键字匹配"), file=sys.stderr)
            items = keyword(items)
    elif q:
        items = keyword(items)

    if getattr(a, "dated", False):
        dates = wiki_dates([it["key"] for it in items])
        items = [{**it, "created": dates.get(it["key"], "")} for it in items]
        items.sort(key=lambda it: it["created"], reverse=True)

    def text(items):
        for it in items:
            score = f" {it['score']:.3f}" if it.get("score") is not None else ""
            print(wiki_line(it, 400) + score)
        print(L.t(f"\n{len(items)} entries", f"\n{len(items)} 条"))
    out(items, a.json, text)


def cmd_pit(a):
    """Backwards-compatible alias: dispatch pit add|list|show == dispatch wiki --kind pit."""
    a.kind = "pit"
    for f in ("why", "tech", "good", "bad"):
        setattr(a, f, None)
    if a.op == "list" and not getattr(a, "all", False):
        a.all = False
    cmd_wiki(a)


# ---------------------------------------------------------------- insights: how the agents behaved lately (the cross-agent /insights)

# Signals read straight off the transcripts. Every pattern is a *cue*, not a verdict — the
# report shows samples so a person (or an agent) can judge.
_I_APPROVE = re.compile(r"^\s*(y|yes|ok|okay|好|好的|可以|行|是|是的|对|嗯|go|do it|proceed|开始|做吧|同意|确认|没问题|就这样|按你说的|你决定|你来定|随便|都行)[。.!！\s]*$", re.I)
_I_CONTINUE = re.compile(r"^\s*(继续|接着|go on|continue|然后呢|接下来|下一步|继续做|接着做|继续吧)", re.I)
_I_CORRECT = re.compile(r"(别问|不要问|不用问|直接做|直接改|不要再|别再|怎么还|怎么又|为什么没|为什么不|你没|没做|没改|不对|错了|不是这个|不是我要|我说的是|我说了|算了|废话|啰嗦|太长|简短|说重点|别停|不要停|为什么停|做完|全部做|一次做完|又一遍|已经说过|前面说了|你忘|不记得|你不会用|为什么不用)")
_I_ASKTAIL = re.compile(r"(要不要|需不需要|需要我|要我|可以吗|好吗|行吗|哪种|哪个|请确认|请告诉我|请选择|你希望|你想|你定|你确认|等你|说一声|点头|shall i|should i|would you like|do you want|which (one|option)|let me know|继续吗|开始吗|\?\s*$|？\s*$)", re.I)
_I_OVERFLOW = re.compile(r"(Prompt is too long|compaction failed|context window)", re.I)
_I_BOARD = re.compile(r"\bdispatch\s+(begin|claim|log|done)\b")
_I_BOARD_TOOL = re.compile(r"dispatch(?:__|_|\.|/)task_(begin|claim|log|done)$")  # the same through Dispatch's MCP server
_I_LONG = 60
_I_BOARD_MIN = 15          # a session this long should have a task on the board
INSIGHTS_SEEN = os.path.join(DISPATCH_DIR, "insights-seen.json")

# What each signal means and how it is detected — shown in the app so the numbers are not a black box.
INSIGHT_RULES_EN = [
    {"key": "asktail", "name": "Ends on a question or options", "how": "The last 260 characters of an assistant message hold a confirmation such as \"shall I / do you want / please confirm / which one / ?\", and the next message is the person's. When the person does not answer with a short \"ok / yes / go on\" but says something else, the question counts as not answered: it most likely did not need asking."},
    {"key": "correction", "name": "The person corrects or pushes", "how": "A message of the person (600 characters or less) holds words such as \"don't ask / just do it / again? / why didn't you / wrong / get to the point / don't stop / you forgot / why not use\". Each comes with the assistant's line before it as a sample, for a person to sort: no tool used, overdid it, stopped too early, a needless confirmation, forgot to record."},
    {"key": "overflow", "name": "Context overflow", "how": "The assistant's output says Prompt is too long / compaction failed / context window. Such sessions should have been split into a new session earlier."},
    {"key": "long", "name": "Very long session", "how": f"The person spoke {_I_LONG} times or more in one session. The rule is one task per session, with progress on the board."},
    {"key": "ends_on_question", "name": "Stopped on a question", "how": "The session's last message is a question from the assistant and the person did not reply: a needless confirmation, or really stuck."},
    {"key": "tool_errors", "name": "Tool errors", "how": "How often a tool_result in the transcript is marked is_error (a command failed, a file did not exist, an edit did not match). More than 8 in one session usually means going in circles."},
    {"key": "no_board", "name": "Long session not on the board", "how": f"The person spoke {_I_BOARD_MIN} times or more, but the session never ran dispatch begin / claim / log / done. The work is not on the board, so other agents and the phone cannot see it."},
    {"key": "approve", "name": "Bare approval", "how": "The person only answered with one or two words such as \"ok / yes / go on / do it\". Usually the assistant stopped for a confirmation it did not need."},
]
INSIGHT_RULES_ZH = [
    {"key": "asktail", "name": "问句/选项收尾", "how": "助手一条消息的最后 260 字里有「要不要 / 需要我 / 请确认 / 哪个 / ？」这类确认句式，且下一条是用户消息。若用户没有用「好 / 可以 / 继续」之类短句回答，而是直接说了别的事，就算「没被回答」——说明这个问题多半不必问。"},
    {"key": "correction", "name": "用户纠错/催促", "how": "用户消息（600 字以内）含「别问 / 直接做 / 怎么又 / 为什么没 / 不对 / 错了 / 说重点 / 别停 / 你忘 / 为什么不用」等词。每条都附上助手前一句作样本，由人判断属于哪类：没用工具、做过头、停太早、无效确认、忘记录。"},
    {"key": "overflow", "name": "上下文溢出", "how": "助手输出里出现 Prompt is too long / compaction failed / context window。这类会话应更早拆成新会话。"},
    {"key": "long", "name": "超长会话", "how": f"一个会话里用户发言 ≥ {_I_LONG} 轮。规则是一个任务一个会话，进度写到板上。"},
    {"key": "ends_on_question", "name": "停在问句上", "how": "会话最后一条是助手的问句，用户没有再回——可能是多余的确认，也可能是真卡住。"},
    {"key": "tool_errors", "name": "工具报错", "how": "转录里 tool_result 标了 is_error 的次数（命令失败、文件不存在、编辑没匹配到）。一个会话里超过 8 次通常是在原地打转。"},
    {"key": "no_board", "name": "长会话没上板", "how": f"用户发言 ≥ {_I_BOARD_MIN} 轮，但整个会话没有跑过 dispatch begin / claim / log / done。任务没记到板上，其他 Agent 和手机端都看不到它。"},
    {"key": "approve", "name": "纯确认回复", "how": "用户只回了「好 / 可以 / 继续 / 做吧」这类一两个字。多说明助手停下来等了一个本可不问的确认。"},
]
INSIGHT_RULES = L.t(INSIGHT_RULES_EN, INSIGHT_RULES_ZH)


def insights_scan(days):
    from datetime import datetime, timedelta
    idx = load_index() or refresh_index()
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%dT") if days else ""
    per_agent, sessions, samples = {}, [], {"asktail": [], "correction": [], "overflow": []}
    # Per-session results are remembered under the transcript's (mtime, size): a new message in one
    # conversation re-reads that conversation, not all hundred of them.
    cache = insights_session_cache_load()
    fresh = {}
    rec = [None]
    def bump(ag, k, n=1):
        per_agent.setdefault(ag, {"sessions": 0, "user_turns": 0, "approve": 0, "continue": 0, "correction": 0, "asktail": 0, "ends_on_question": 0, "long": 0, "overflow": 0, "tool_errors": 0, "no_board": 0})[k] += n
        if rec[0] is not None:
            rec[0][k] = rec[0].get(k, 0) + n
    for key, e in idx.items():
        if e.get("subagent") or not e.get("user_msgs"):
            continue
        if cutoff and (e.get("last_ts") or "") < cutoff:
            continue
        sig = [e.get("mtime") or 0, e.get("size") or 0]
        hit = cache.get(key)
        if hit and hit.get("sig") == sig and hit.get("v") == INSIGHTS_SESSION_V:
            fresh[key] = hit
            if hit.get("row"):
                for k, n in (hit.get("bumps") or {}).items():
                    bump(hit["row"]["agent"], k, n)
                for kind, items in (hit.get("samples") or {}).items():
                    samples.setdefault(kind, []).extend(items)
                sessions.append(hit["row"])
            continue
        ref = dict(e); ref["path"] = key; ref.setdefault("subagents", [])
        try:
            d = read_session_detail(ref, limit=100000)
        except Exception:
            continue
        rec[0] = {}
        before = {k: len(v) for k, v in samples.items()}
        fresh[key] = {"sig": sig, "v": INSIGHTS_SESSION_V, "row": None}  # replaced below when the session counts
        msgs = [m for m in d["messages"] if m["role"] in ("user", "assistant") and not m["text"].startswith(("The TodoWrite", "<ide_", "<system", "<task-notification", "# In app browser", "# Files mentioned", "# Applications mentioned"))]
        U = [m for m in msgs if m["role"] == "user"]
        if not U:
            continue
        ag = e["agent"]
        bump(ag, "sessions"); bump(ag, "user_turns", len(U))
        row = {"agent": ag, "session_id": e["session_id"], "cwd": e.get("cwd", ""), "title": (e.get("title") or "")[:60], "last_ts": (e.get("last_ts") or "")[:10], "last_at": e.get("last_ts") or "", "user_turns": len(U), "approve": 0, "continue": 0, "correction": 0, "asktail": 0, "overflow": 0, "ends_on_question": False, "tool_errors": 0, "no_board": False}
        for i, m in enumerate(msgs):
            t = m["text"].strip()
            if m["role"] == "user":
                if _I_APPROVE.match(t): row["approve"] += 1; bump(ag, "approve")
                if _I_CONTINUE.match(t): row["continue"] += 1; bump(ag, "continue")
                if _I_CORRECT.search(t) and len(t) < 600:
                    row["correction"] += 1; bump(ag, "correction")
                    prev = next((x["text"].strip()[-220:] for x in reversed(msgs[:i]) if x["role"] == "assistant" and x["text"].strip()), "")
                    samples["correction"].append({"agent": ag, "session_id": e["session_id"], "ts": row["last_ts"], "assistant": prev, "user": t[:220]})
            else:
                if not t:
                    continue
                if _I_OVERFLOW.search(t): row["overflow"] += 1; bump(ag, "overflow")
                if _I_ASKTAIL.search(t[-260:]) and i + 1 < len(msgs) and msgs[i + 1]["role"] == "user":
                    nxt = msgs[i + 1]["text"].strip()
                    answered = bool(_I_APPROVE.match(nxt)) or len(nxt) < 40
                    row["asktail"] += 1; bump(ag, "asktail")
                    if not answered:
                        samples["asktail"].append({"agent": ag, "session_id": e["session_id"], "ts": row["last_ts"], "assistant": t[-220:], "user": nxt[:160]})
        last = next((x for x in reversed(msgs) if x["text"].strip()), None)
        if last and last["role"] == "assistant" and _I_ASKTAIL.search(last["text"].strip()[-260:]):
            row["ends_on_question"] = True; bump(ag, "ends_on_question")
        if len(U) >= _I_LONG:
            bump(ag, "long")
        row["tool_errors"] = tool_error_count(key)
        bump(ag, "tool_errors", row["tool_errors"])
        used_board = any(_I_BOARD.search(t.get("summary", "")) or _I_BOARD_TOOL.search(t.get("name") or "") for m in msgs for t in m.get("tools", []))
        if len(U) >= _I_BOARD_MIN and not used_board:
            row["no_board"] = True; bump(ag, "no_board")
        sessions.append(row)
        fresh[key] = {"sig": sig, "v": INSIGHTS_SESSION_V, "row": row, "bumps": rec[0], "samples": {k: v[before.get(k, 0):] for k, v in samples.items()}}
        rec[0] = None
    rec[0] = None
    insights_session_cache_save(fresh)
    sessions.sort(key=lambda r: -(r["correction"] * 3 + r["asktail"] + r["overflow"] * 3 + r["continue"] + min(r["tool_errors"], 10) // 2 + (3 if r["no_board"] else 0)))
    return {"days": days, "per_agent": per_agent, "sessions": sessions[:12], "all_sessions": sessions, "samples": {k: v[-8:] for k, v in samples.items()}, "total_sessions": len(sessions)}


INSIGHTS_CACHE = os.path.join(DISPATCH_DIR, "insights-cache.json")
INSIGHTS_SESSIONS_CACHE = os.path.join(DISPATCH_DIR, "insights-sessions.json")
INSIGHTS_SESSION_V = 1  # bump when the per-session signals change shape


def insights_session_cache_load():
    try:
        d = json.load(open(INSIGHTS_SESSIONS_CACHE, encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def insights_session_cache_save(rows):
    try:
        os.makedirs(DISPATCH_DIR, exist_ok=True)
        tmp = INSIGHTS_SESSIONS_CACHE + ".tmp"
        json.dump(rows, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
        P.replace_retry(tmp, INSIGHTS_SESSIONS_CACHE)
    except OSError:
        pass


def insights_scan_cached(days):
    """The scan reads every recent transcript (seconds); the app asks for it on every visit.
    Keyed by the transcript index's mtime+size, so it is only recomputed when a session changed."""
    try:
        st = os.stat(INDEX_FILE); key = f"{days}:{int(st.st_mtime)}:{st.st_size}"
    except OSError:
        return insights_scan(days)
    try:
        c = json.load(open(INSIGHTS_CACHE, encoding="utf-8"))
        if c.get("key") == key and c.get("days") == days:
            return c["rep"]
    except Exception:
        pass
    rep = insights_scan(days)
    try:
        os.makedirs(DISPATCH_DIR, exist_ok=True)
        tmp = INSIGHTS_CACHE + ".tmp"
        json.dump({"key": key, "days": days, "rep": rep}, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
        P.replace_retry(tmp, INSIGHTS_CACHE)
    except OSError:
        pass
    return rep


def tool_error_count(path):
    """How many tool results the transcript marked as errors; a cheap substring scan."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return sum(line.count('"is_error":true') + line.count('"is_error": true') for line in f if "is_error" in line)
    except OSError:
        return 0


def insights_alerts(rep):
    """Session-level events worth telling a person about *now*, each with a stable id so the
    app can notify once. This is the proactive half of /insights."""
    out = []
    for r in rep.get("all_sessions", rep["sessions"]):
        sid, tag = r["session_id"], f"{r['agent']} {r['session_id'][:8]}"
        name = r.get("title") or (r.get("cwd") or "").replace(HOME, "~")[-40:] or sid[:8]
        if r["correction"] >= 3:
            out.append({"id": f"corr:{sid}:{r['correction'] // 3}", "kind": "correction", "session_id": sid, "agent": r["agent"], "ts": r["last_at"], "text": L.t(f"In \"{name}\" you corrected or pushed {r['correction']} times: worth reading again to see which kind of problem repeats.", f"「{name}」里你纠错/催促了 {r['correction']} 次——这个会话值得回看，看是哪类问题在重复。")})
        if r["overflow"]:
            out.append({"id": f"ovf:{sid}", "kind": "overflow", "session_id": sid, "agent": r["agent"], "ts": r["last_at"], "text": L.t(f"\"{name}\" hit the context limit {r['overflow']} times: have it write its progress to the board and go on in a new session.", f"「{name}」撞到上下文上限 {r['overflow']} 次：让它把进度写到板上，开新会话续做。")})
        if r["tool_errors"] >= 8:
            out.append({"id": f"err:{sid}:{r['tool_errors'] // 8}", "kind": "tool_errors", "session_id": sid, "agent": r["agent"], "ts": r["last_at"], "text": L.t(f"\"{name}\" had {r['tool_errors']} tool errors; it may be going in circles.", f"「{name}」有 {r['tool_errors']} 次工具报错，可能在原地打转。")})
        if r["no_board"]:
            out.append({"id": f"board:{sid}:{r['user_turns'] // 15}", "kind": "no_board", "session_id": sid, "agent": r["agent"], "ts": r["last_at"], "text": L.t(f"\"{name}\" is {r['user_turns']} rounds long and not on the board (it never ran dispatch begin/log/done).", f"「{name}」已经 {r['user_turns']} 轮却没有上任务板（没跑过 dispatch begin/log/done）。")})
        if r["user_turns"] >= _I_LONG:
            out.append({"id": f"long:{sid}:{r['user_turns'] // 30}", "kind": "long", "session_id": sid, "agent": r["agent"], "ts": r["last_at"], "text": L.t(f"\"{name}\" is {r['user_turns']} rounds long: time for a new session.", f"「{name}」已经 {r['user_turns']} 轮：该拆新会话了。")})
    out.sort(key=lambda x: x["ts"], reverse=True)
    return out


def insights_seen_load():
    try:
        return json.load(open(INSIGHTS_SEEN, encoding="utf-8"))
    except Exception:
        return {"seen": [], "acked_at": 0}


def insights_seen_save(d):
    os.makedirs(DISPATCH_DIR, exist_ok=True)
    tmp = INSIGHTS_SEEN + ".tmp"
    json.dump(d, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
    P.replace_retry(tmp, INSIGHTS_SEEN)


def insights_findings(rep):
    """Turn counts into plain sentences; the ranking is what a reviewer should look at first."""
    out = []
    tot = lambda k: sum(a[k] for a in rep["per_agent"].values())
    n = rep["total_sessions"] or 1
    if tot("asktail"):
        out.append(L.t(f"The assistant ended on a question or options {tot('asktail')} times, and {len(rep['samples']['asktail'])}+ times the person did not answer but went on to the next thing: these questions need not be asked; do it, or leave it out.", f"助手以问句/选项收尾 {tot('asktail')} 次，其中 {len(rep['samples']['asktail'])}+ 次用户没有回答而是直接说下一件事——这些问句可以不问，直接做或不提。"))
    if tot("correction"):
        out.append(L.t(f"The person corrected or pushed {tot('correction')} times (see the samples): first see which kind: no tool used, overdid it, stopped too early, forgot to record.", f"用户纠错/催促 {tot('correction')} 次（见样本）：优先看是哪类——没用工具、做过头、停太早、忘了记录。"))
    if tot("overflow"):
        out.append(L.t(f"{tot('overflow')} times Prompt is too long / compaction failed: these sessions should have been split earlier.", f"{tot('overflow')} 次撞到 Prompt is too long / 压缩失败：这些会话应该更早拆成新会话。"))
    if tot("long"):
        out.append(L.t(f"{tot('long')} sessions are over {_I_LONG} rounds: one task per session, progress on the board.", f"{tot('long')} 个会话超过 {_I_LONG} 轮：一个任务一个会话，进度写板上。"))
    if tot("ends_on_question"):
        out.append(L.t(f"{tot('ends_on_question')} sessions stopped on the assistant's question (the person did not reply): a needless confirmation, or really stuck.", f"{tot('ends_on_question')} 个会话停在助手的问句上（用户没再回）：可能是没必要的确认，也可能是真卡住了。"))
    if tot("tool_errors"):
        worst = max(rep["sessions"], key=lambda r: r["tool_errors"], default=None)
        out.append(L.t(f"{tot('tool_errors')} tool errors" + (f", {worst['tool_errors']} in the worst session ({worst['agent']} {worst['session_id'][:8]})" if worst and worst["tool_errors"] >= 8 else "") + ": errors in a row mean going in circles; change approach or ask.",
                       f"工具报错 {tot('tool_errors')} 次" + (f"，最多的一个会话 {worst['tool_errors']} 次（{worst['agent']} {worst['session_id'][:8]}）" if worst and worst["tool_errors"] >= 8 else "") + "：连续报错说明在原地打转，该换思路或问人。"))
    if tot("no_board"):
        out.append(L.t(f"{tot('no_board')} sessions of {_I_BOARD_MIN}+ rounds never ran dispatch begin/log/done: the work is not on the board, other agents and the phone cannot see it.", f"{tot('no_board')} 个 ≥ {_I_BOARD_MIN} 轮的会话从没跑过 dispatch begin/log/done：工作没记到板上，其他 Agent 和手机端看不到。"))
    if not out:
        out.append(L.t("No clear signals in this period.", "这段时间没有明显的行为信号。"))
    return out


def cmd_insights(a):
    if getattr(a, "op", None):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import insights_report
        if P.IS_WIN and a.op == "open":
            reps = [r for r in insights_report.all_reports() if not r["error"] and (not a.id or r["id"] == a.id or r["id"].startswith(a.id))]
            if not reps:
                raise SystemExit(L.t("No report yet", "还没有报告"))
            P.open_path(reps[0]["html"])
            return out({"opened": ui_path(reps[0]["html"])}, a.json, lambda x: print(x["opened"]))
        return insights_report.main(a)
    rep = insights_scan_cached(a.days)
    rep["findings"] = insights_findings(rep)
    rep["rules"] = INSIGHT_RULES
    seen = insights_seen_load()
    alerts = insights_alerts(rep)
    rep["alerts"] = [dict(x, seen=x["id"] in seen["seen"]) for x in alerts]
    rep.pop("all_sessions", None)
    if getattr(a, "ack", False):
        seen["seen"] = sorted(set(seen["seen"]) | {x["id"] for x in alerts})[-500:]
        seen["acked_at"] = time.time()
        insights_seen_save(seen)
    if getattr(a, "alerts", False):
        fresh = [x for x in rep["alerts"] if not x["seen"]]
        return out(fresh, a.json, lambda xs: [print(f"- [{x['agent']} {x['session_id'][:8]}] {x['text']}") for x in xs] or (print(L.t("No new insight alerts", "没有新的洞察告警")) if not xs else None))
    top = ", ".join(L.t(f"{r['agent']} {r['session_id'][:8]} (corrections {r['correction']} · questions {r['asktail']} · {r['user_turns']} rounds)", f"{r['agent']} {r['session_id'][:8]}（纠错 {r['correction']}·问句 {r['asktail']}·{r['user_turns']} 轮）") for r in rep["sessions"][:5])
    prompt = L.t(
        f"Do a cross-agent retrospective of the sessions of the last {a.days} days and put the improvements in place. 1) `dispatch insights --days {a.days} --json` for the signal counts and samples; the sessions most worth reading: {top}. "
        f"Read the parts around corrections and questions in them with `dispatch session <id>` and sort each into a kind (no tool used / overdid it / stopped too early / needless confirmation / forgot to record). "
        f"2) Give each kind one rule or habit that can be followed; what fits ~/.agents/rules/GLOBAL.md goes straight in, then `dispatch rules sync`; what belongs to a skill goes into that SKILL.md. "
        f"3) Record the conclusions: pitfalls `dispatch wiki add --kind pit …`, what worked `--kind win …`, and finally a retrospective with `dispatch done --retro`. "
        f"4) Give me a table: what happened, evidence (session ids), what changed. Start a task with `dispatch begin` before you change anything.",
        f"按最近 {a.days} 天的会话做一次跨 Agent 复盘并落地改进。1) `dispatch insights --days {a.days} --json` 拿信号统计和样本；最值得看的会话：{top}。"
              f"用 `dispatch session <id>` 读这些会话里纠错和问句附近的几段，判断每条是哪类问题（没用工具 / 做过头 / 停太早 / 无效确认 / 忘记录）。"
              f"2) 每类给一条可执行的规则或习惯，能落到 ~/.agents/rules/GLOBAL.md 的直接改并 `dispatch rules sync`；跟某个技能有关的改那个 SKILL.md。"
              f"3) 结论写进知识库：坑 `dispatch wiki add --kind pit …`、做对 `--kind win …`，最后 `dispatch done --retro` 写一条复盘。"
              f"4) 给我一张表：现象、证据（会话 id）、改了什么。先 `dispatch begin` 建任务再动手。")
    rep["prompt"] = prompt
    rep["command"] = f"cd ~ && claude {json.dumps(prompt, ensure_ascii=False)}"
    if a.copy:
        P.copy_to_clipboard(rep["command"])

    def text(rep):
        print(L.t(f"# Insights · last {a.days} days · {rep['total_sessions']} sessions", f"# 洞察 · 最近 {a.days} 天 · {rep['total_sessions']} 个会话"))
        for f in rep["findings"]:
            print("- " + f)
        print(L.t("\n## By agent", "\n## 按 Agent"))
        print(L.t(f"{'agent':<11}{'sess':>5}{'rnds':>6}{'ok':>5}{'go':>5}{'corr':>5}{'asks':>5}{'stop?':>6}{'long':>5}{'ovfl':>5}{'errs':>5}{'noBrd':>6}", f"{'agent':<11}{'会话':>5}{'轮':>6}{'确认':>5}{'继续':>5}{'纠错':>5}{'问句':>5}{'停问':>5}{'长':>4}{'溢出':>5}{'报错':>5}{'没上板':>6}"))
        for ag, c in rep["per_agent"].items():
            print(f"{ag:<11}{c['sessions']:>5}{c['user_turns']:>6}{c['approve']:>5}{c['continue']:>5}{c['correction']:>5}{c['asktail']:>5}{c['ends_on_question']:>5}{c['long']:>4}{c['overflow']:>5}{c['tool_errors']:>5}{c['no_board']:>6}")
        if rep["alerts"]:
            print(L.t("\n## Insights (not acknowledged)", "\n## 主动洞察（未确认的）"))
            for x in rep["alerts"]:
                if not x["seen"]:
                    print(f"- [{x['agent']} {x['session_id'][:8]}] {x['text']}")
        print(L.t("\n## Sessions most worth reading again", "\n## 最值得回看的会话"))
        for r in rep["sessions"][:8]:
            print(L.t(f"- {r['agent']} {r['session_id'][:12]} {r['last_ts']} · {r['user_turns']} rounds · corrections {r['correction']} · questions {r['asktail']} · overflows {r['overflow']} · …{(r['cwd'] or '')[-30:]}", f"- {r['agent']} {r['session_id'][:12]} {r['last_ts']} · {r['user_turns']} 轮 · 纠错 {r['correction']} · 问句 {r['asktail']} · 溢出 {r['overflow']} · …{(r['cwd'] or '')[-30:]}"))
        for kind, title in (("correction", L.t("Samples of corrections", "用户纠错样本")), ("asktail", L.t("Samples of questions not answered", "问句没被回答的样本"))):
            if rep["samples"][kind]:
                print(f"\n## {title}")
                for smp in rep["samples"][kind][-5:]:
                    print(f"- [{smp['agent']} {smp['session_id'][:8]}] " + L.t(f"assistant…\"{smp['assistant'][-120:].replace(chr(10), ' ')}\" → person \"{smp['user'][:100].replace(chr(10), ' ')}\"", f"助手…「{smp['assistant'][-120:].replace(chr(10), ' ')}」 → 用户「{smp['user'][:100].replace(chr(10), ' ')}」"))
        print(L.t("\nStart the improvement task" + (" (command copied)" if a.copy else "") + ":", "\n启动改进任务" + ("（命令已复制）" if a.copy else "") + "：") + f"\n{rep['command'][:200]}…")
    out(rep, a.json, text)


# ---------------------------------------------------------------- catalog: capabilities kept OFF by default, enabled on request

def catalog_items():
    """Skills in the pool that nobody has mounted, and Claude Code plugins that are disabled.
    prime shows only counts + a few names; agents suggest one when it would clearly help."""
    items = []
    for r in all_skills():
        if r["in_pool"] and not any(r["agents"].values()):
            items.append({"kind": "skill", "name": r["name"], "desc": (r["description"] or "")[:70], "enable": f"dispatch skills enable {r['name']} --agent claude|codex"})
    try:
        st = json.load(open(os.path.join(HOME, ".claude", "settings.json"), encoding="utf-8"))
        for name, on in sorted((st.get("enabledPlugins") or {}).items()):
            if on:
                continue
            pl, _, mk = name.partition("@")  # a plugin installed without a marketplace has no "@"
            mk = mk or "*"
            desc = ""
            for d in sorted(glob.glob(os.path.join(HOME, ".claude", "plugins", "cache", mk, pl, "*", ".claude-plugin", "plugin.json")))[-1:]:
                try:
                    desc = (json.load(open(d, encoding="utf-8")).get("description") or "")[:70]
                except Exception:
                    pass
            items.append({"kind": "plugin", "name": name, "desc": desc, "enable": f"claude plugin enable {name}"})
    except Exception:
        pass
    return items


def catalog_line():
    items = catalog_items()
    if not items:
        return ""
    sk = [i for i in items if i["kind"] == "skill"]
    pl = [i for i in items if i["kind"] == "plugin"]
    names = "、".join(i["name"].split("@")[0] for i in pl[:4])
    return L.t(f"Available when needed (not loaded by default): {len(sk)} skills, {len(pl)} plugins ({names}…). When one would clearly help, suggest it to the person in one sentence and turn it on once they agree: `dispatch catalog -q <word>`.",
               f"可按需启用（默认不注入）：技能 {len(sk)} 个、插件 {len(pl)} 个（{names}…）。明显有用时建议用户一句，同意再启用：`dispatch catalog -q 词`。")


def cmd_catalog(a):
    items = catalog_items()
    if a.kind:
        items = [i for i in items if i["kind"] == a.kind]
    if a.query:
        q = a.query.lower()
        items = [i for i in items if q in i["name"].lower() or q in i["desc"].lower()]

    def text(items):
        for i in items:
            print(f"{i['kind']:<7}{i['name']:<40}{i['desc']:<72} → {i['enable']}")
        print(L.t(f"\n{len(items)} items (skills not given to an agent + plugins turned off; new sessions see what you turn on)", f"\n{len(items)} 项（未挂载技能 + 已禁用插件；启用后新会话生效）"))
    out(items, a.json, text)


# ---------------------------------------------------------------- env: API keys and other secrets, one file, 0600

ENV_DIR = os.path.join(HOME, ".config", "dispatch")
ENV_FILE = os.path.join(ENV_DIR, "env")          # `# 用途` line above each `KEY=value`
ENV_FISH = os.path.join(ENV_DIR, "env.fish")     # regenerated on every write; fish config sources it
ENV_SH = os.path.join(ENV_DIR, "env.sh")         # the same for zsh / bash
# The names (never the values) each store held after its last write, kept in another folder: when the store's
# folder is gone or the file lost keys, a write refuses instead of starting over with what it was given
# (10-08: ~/.config/dispatch vanished and the next `env set` made a new store holding 1 key of 68).
ENV_KNOWN = os.path.join(HOME, ".dispatch", "state", "env-names.json")
_ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class EnvKeysWouldBeLost(RuntimeError):
    """A write would leave out keys the store had: the file is gone or someone else removed them."""


_ENV_PROJECT = re.compile(r"^(?:project|项目)\s*[:：]\s*(\S.*)$", re.I)


def env_read():
    """[{name, value, note, project}] in file order. Never reaches bd/Dolt or the wiki.
    A `# project: X` line above a key ties it to one project: prime lists it only there,
    the project page shows it, `dispatch env list -P X` filters to it."""
    items, note, project = [], "", ""
    if not os.path.exists(ENV_FILE):
        return items
    for line in open(ENV_FILE, encoding="utf-8"):
        line = line.rstrip("\n")
        if not line.strip():
            note, project = "", ""
            continue
        if line.lstrip().startswith("#"):
            comment = line.lstrip("# ").strip()
            m = _ENV_PROJECT.match(comment)
            if m:
                project = m.group(1).strip()
            else:
                note = comment
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            items.append({"name": k.strip(), "value": v, "note": note, "project": project})
            note, project = "", ""
    return items


def _env_known_all():
    try:
        with open(ENV_KNOWN, encoding="utf-8") as f:
            d = json.load(f)
    except FileNotFoundError:
        return {}
    return d if isinstance(d, dict) else {}


def env_known():
    """The names this store held after its last write ([] when nothing was recorded for it)."""
    return list((_env_known_all().get(os.path.abspath(ENV_FILE)) or {}).get("names") or [])


def _env_known_save(names):
    d = _env_known_all()
    d[os.path.abspath(ENV_FILE)] = {"names": sorted(names), "at": datetime.datetime.now().isoformat(timespec="seconds")}
    os.makedirs(os.path.dirname(ENV_KNOWN), exist_ok=True)
    tmp = ENV_KNOWN + f".tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=1)
    os.replace(tmp, ENV_KNOWN)


def env_missing():
    """Names the store had at its last write that are not in the file now (the file or its folder gone)."""
    have = {it["name"] for it in env_read()}
    return sorted(set(env_known()) - have)


def env_lost_text(lost):
    shown = ", ".join(lost[:8]) + (L.t(f" and {len(lost) - 8} more", f" 等 {len(lost)} 个") if len(lost) > 8 else "")
    where = ENV_FILE if os.path.exists(ENV_FILE) else L.t(f"{ENV_FILE}, the file is gone", f"{ENV_FILE}，文件不在了")
    return L.t(f"The key store has {len(lost)} key(s) fewer than at its last write: {shown} ({where}). "
               f"Put the file back from a backup or another Mac; if they were removed on purpose, `dispatch env forget-missing` accepts that.",
               f"密钥库比上次写入时少了 {len(lost)} 个 key：{shown}（{where}）。"
               f"先从备份或另一台 Mac 把文件放回来；如果是有意删掉的，`dispatch env forget-missing` 认下这件事。")


def _write_private(path, text):
    """Secrets never exist on disk with open permissions, not even for a moment: the file is
    created 0600, written next to its destination and moved into place in one step."""
    tmp = path + f".tmp{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        P.replace_retry(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


# Kept in the store (`dispatch env get`) but never exported to shells: each one makes every `claude`
# started from a terminal sign in as that token or key instead of the account `/login` chose.
ENV_NOT_IN_SHELL = {"CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"}


def env_write(items, removed=()):
    """Write the whole store. Every key the store has now, or had at its last write, must be in `items` unless it is
    named in `removed`; otherwise nothing is written (EnvKeysWouldBeLost)."""
    have = {it["name"] for it in items}
    lost = sorted((set(env_known()) | {it["name"] for it in env_read()}) - have - set(removed))
    if lost:
        raise EnvKeysWouldBeLost(L.t("Nothing was written. ", "这次什么都没写。") + env_lost_text(lost))
    os.makedirs(ENV_DIR, mode=0o700, exist_ok=True)
    os.chmod(ENV_DIR, 0o700)
    body = L.t("# Dispatch's keys and environment: kept by `dispatch env`; agents read a value with `dispatch env get <NAME>`. Do not copy it into other files.\n\n",
               "# Dispatch 环境/密钥库：`dispatch env` 维护；Agent 用 `dispatch env get <NAME>` 取值。不要复制到其他文件。\n\n")
    for it in items:
        if it.get("project"):
            body += f"# project: {it['project']}\n"
        if it.get("note"):
            body += f"# {it['note']}\n"
        body += f"{it['name']}={env_quote(it['value'])}\n\n"
    _write_private(ENV_FILE, body)
    shell = [it for it in items if it["name"] not in ENV_NOT_IN_SHELL]
    _write_private(ENV_FISH, "# generated by `dispatch env`; sourced from config.fish\n" + "".join(f"set -gx {it['name']} {env_quote(it['value'])}\n" for it in shell))
    # zsh / bash: `source ~/.config/dispatch/env.sh` from ~/.zshrc (macOS's default shell is zsh).
    _write_private(ENV_SH, "# generated by `dispatch env`; source it from ~/.zshrc or ~/.bashrc\n" + "".join(f"export {it['name']}={sh_quote(it['value'])}\n" for it in shell))
    _env_known_save(have)


def sh_quote(v):
    return "'" + v.replace("'", "'\\''") + "'"


def env_quote(v):
    return "'" + v.replace("'", "'\\''") + "'" if re.search(r"[\s#$\"'\\]", v) else v


def env_mask(v):
    """Enough to tell two keys apart, never the whole of a short one."""
    return "…" if len(v) <= 8 else v[:3] + "…" + v[-3:]


def env_note_known():
    """Record the names of a store no write has recorded yet (one written before the record existed)."""
    if env_known() or not os.path.exists(ENV_FILE):
        return
    names = {it["name"] for it in env_read()}
    if names:
        try:
            _env_known_save(names)
        except OSError as e:  # a sandbox that cannot write ~/.dispatch: the next write records them
            debug("env names record", e)


def env_brief_line():
    """For the session brief: the store lost keys since its last write (its folder gone, say). Records the names of
    a store that has none recorded, so every Mac has them after its next session start."""
    env_note_known()
    lost = env_missing()
    return env_lost_text(lost) if lost else ""


def env_summary_line(proj=""):
    """The key names a session may fetch: machine-wide ones plus those tied to this project.
    Keys of other projects are left out, so a project's secrets stay its own."""
    items = [it for it in env_read() if not it.get("project") or (proj and it["project"].lower() == proj.lower())]
    if not items:
        return ""
    short = lambda n: re.split(r"[（(，,；;]", n)[0][:14]
    return (L.t("Keys (`dispatch env get NAME`; never ask the person to paste them again): ", "Key（`dispatch env get 名`，别让用户重贴）：")
            + L.t(", ", "，").join(f"{it['name']}" + (f"={short(it['note'])}" if it["note"] else "") + (L.t(" [this project]", "［本项目］") if it.get("project") else "") for it in items))


def cmd_project_summary(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import summarize
    if not summarize.use_enabled("project"):
        return out({"skipped": True, "reason": summarize.gate_message("project")}, a.json, lambda x: print(x["reason"]))
    try:
        r = summarize.project_summary(a.name, force=a.force, if_stale=a.if_stale, local_only=getattr(a, "local", False))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False) if a.json else f"✗ {e}")
        sys.exit(1)
    out(r, a.json, lambda x: print(x.get("summary") or L.t("(no summary yet)", "（还没有总结）")))


def cmd_session_summary(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import summarize
    summarize.main(a)


def cmd_summarize(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import summarize
    summarize.cli(a)


def summary_off(key):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import summarize
    return None if summarize.use_enabled(key) else summarize.gate_message(key)


# ---------------------------------------------------------------- here / lineage → lineage.py
def cmd_here(a):
    return _mod("lineage").cmd_here(a)


def cmd_lineage(a):
    return _mod("lineage").cmd_lineage(a)


# ---------------------------------------------------------------- thread / decide → thread.py
def cmd_thread(a):
    return _mod("thread").cmd_thread(a)


def cmd_decide(a):
    res = _mod("thread").cmd_decide(a)
    link_session(a.task)
    return res


def hook_task_ids(command):
    """Task ids a shell command works on (`bd update X --claim`, `dispatch log X …`), only where
    the verb is the command itself (presence.task_cmd_ids): not inside a quoted argument."""
    return _mod("presence").task_cmd_ids(command or "")


def cmd_link(a):
    """Link a conversation to a task (`session:<id>`). `--hook-json`: read a PostToolUse hook
    payload on stdin and link when its command worked on a task. `backfill`: link past sessions
    from the transcript index (--dry-run first)."""
    if a.task == "backfill":
        return _mod("links").backfill(_THIS, a)
    if a.hook_json:
        try:
            raw = getattr(sys.stdin, "buffer", None)
            data = json.loads(raw.read().decode("utf-8", "replace")) if raw is not None else json.load(sys.stdin)
        except Exception:
            return
        cmd = ((data.get("tool_input") or {}) if isinstance(data.get("tool_input"), dict) else {}).get("command") or ""
        sid = str(data.get("session_id") or data.get("thread_id") or "")
        for tid in hook_task_ids(cmd):
            link_session(tid, sid=sid or None)
        return
    if not a.task:
        raise SystemExit("dispatch link TASK [--session ID] | --hook-json | backfill [--dry-run]")
    sid = link_session(a.task, sid=a.session or None)
    out({"task": a.task, "session": sid}, a.json, lambda r: print(L.t(f"{a.task} is linked to session {sid}", f"{a.task} 已关联会话 {sid}") if sid else L.t("Not sure which session: add --session <id>, or run it inside the agent's session", "不知道是哪个会话：加 --session <id>，或在 Agent 会话里跑")))


def cmd_move(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import move
    move.main(a)


def cmd_update(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import updater
    updater.main(a)


def cmd_init(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import init_wizard
    init_wizard.main(a)


def phone_push(setting_key, title, body, path, level="normal"):
    """A phone push (ntfy / Bark) for an event the person wants on the phone, if that channel
    is configured and the setting is on. Never raises: a missing channel just returns."""
    try:
        N = _mod("notify")
        if N.channel()[0] not in ("ntfy", "bark"):
            return
        if int(settings_load().get(setting_key, 1) or 0) == 0:
            return
        N.send(title, body, url=N.serve_link(path), level=level, key=f"{setting_key}:{path}")
    except Exception:
        pass


def cmd_agents_installed(a):
    """Which agents this Mac has (their config folder exists): the app defaults dialogs to one of them."""
    rows = [{"id": r["id"], "name": r["name"], "found": r["found"]} for r in _mod("init_wizard").agents_status()]
    out(rows, a.json, lambda rs: [print(("✓ " if r["found"] else "· ") + r["name"]) for r in rs])


def cmd_models(a):
    _mod("models").command(a)


def cmd_notify(a):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import notify
    notify.main(a)


def _env_by(a):
    """Who changed a key, for the toast: Settings › Keys says so; otherwise an agent's session or a terminal."""
    by = getattr(a, "by", None)
    if by:
        return by
    return "agent" if any(os.environ.get(k) for k in ("CLAUDECODE", "CODEX_THREAD_ID", "OPENCODE", "DISPATCH_SESSION_ID")) else "terminal"


def _env_say(name, note):
    """The line for the agent that saved a key: what to call it in its reply (the person saw the toast)."""
    if note:
        return L.t(f"In your reply call it {name} ({note}) and never write its value; the person saw \"Key saved: {name}\" with Show and Undo.",
                   f"回复里就叫它 {name}（{note}），不要写出值；用户那边已弹出「Key saved: {name}」，能点 Show 查看或 Undo 撤回。")
    return L.t(f"In your reply call it {name} and never write its value; the person saw \"Key saved: {name}\" with Show and Undo. It has no purpose yet: add one with `dispatch env set {name} --note \"what it is for\"`.",
               f"回复里就叫它 {name}，不要写出值；用户那边已弹出「Key saved: {name}」，能点 Show 查看或 Undo 撤回。它还没写用途：`dispatch env set {name} --note \"做什么用\"` 补上。")


def _env_backup():
    """The whole store as it is, kept in ~/.dispatch/backups/<date>/ before it changes."""
    if os.path.exists(ENV_FILE):
        _mod("backups").save(ENV_FILE)


def _env_answer(a, obj, text):
    out(obj, getattr(a, "json", False), lambda _o: print(text))


def cmd_env(a):
    try:
        _cmd_env(a)
    except EnvKeysWouldBeLost as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)


def _cmd_env(a):
    items = env_read()
    by = {it["name"]: it for it in items}
    if a.op in ("list", "get"):
        env_note_known()
        lost = env_missing()
        if lost:
            print(env_lost_text(lost), file=sys.stderr)
    if a.op == "forget-missing":
        lost = env_missing()
        _env_known_save(by)
        print(L.t(f"Forgot {len(lost)} missing key(s): {', '.join(lost)}" if lost else "Nothing is missing",
                  f"不再记着少掉的 {len(lost)} 个 key：{', '.join(lost)}" if lost else "没有少掉的 key"))
    elif a.op == "path":
        print(ENV_FILE)
    elif a.op == "list":
        if a.project:
            items = [it for it in items if (it.get("project") or "").lower() == a.project.lower()]
        rows = [{"name": it["name"], "note": it["note"], "project": it.get("project", ""), "masked": env_mask(it["value"]), "length": len(it["value"])} for it in items]
        out(rows, a.json, lambda rs: [print(f"{r['name']:<28} {r['masked']:<14} {('[' + r['project'] + '] ') if r['project'] else ''}{r['note']}") for r in rs]
            or print(L.t(f"\n{len(rs)} (file {ENV_FILE}, 0600)" + (f", project {a.project} only" if a.project else ""), f"\n{len(rs)} 个（文件 {ENV_FILE}，0600）" + (f"，只看项目 {a.project}" if a.project else ""))))
    elif a.op == "get":
        if a.name not in by:
            print(L.t(f"No {a.name}. `dispatch env list` shows what there is", f"没有 {a.name}。`dispatch env list` 看有哪些"), file=sys.stderr)
            sys.exit(1)
        print(by[a.name]["value"])
    elif a.op == "set":
        if not _ENV_KEY.match(a.name or ""):
            print(L.t("A name may only have letters, digits and underscores", "变量名只能是字母、数字、下划线"), file=sys.stderr)
            sys.exit(2)
        # No value and something piped in: read it, so `pbpaste | dispatch env set NAME` just works.
        value = sys.stdin.read().strip() if (a.stdin or (a.value is None and not sys.stdin.isatty())) else a.value
        if a.value is not None and value == a.value and sys.stdin.isatty():
            # Still accepted (scripts rely on it), but a key typed on the command line stays in the
            # shell history and is visible in `ps` while this runs.
            print(L.t(f"Note: a value typed on the command line stays in the shell's history. Next time use `dispatch env set NAME --stdin`, or `{P.paste_hint()}dispatch env set NAME`.", f"提示：值写在命令行里会留在 shell 历史里。下次用 `dispatch env set NAME --stdin`，或 `{P.paste_hint()}dispatch env set NAME`。"), file=sys.stderr)
        # a key that is there, no value, a new purpose or project: only those change (Settings › Keys, Edit)
        describe = not value and a.name in by and (a.note is not None or a.project is not None)
        if (value is None or value == "") and not describe:
            print(L.t("Give a value: `dispatch env set NAME --stdin` and paste it (best: it stays out of the shell history and the process list), or as an argument", "需要值：`dispatch env set NAME --stdin` 后粘贴（推荐，值不会进 shell 历史和进程列表），或作为位置参数给出"), file=sys.stderr)
            sys.exit(2)
        before = dict(by[a.name]) if a.name in by else None
        index = next((i for i, it in enumerate(items) if it["name"] == a.name), len(items))
        if a.name in by:
            if not describe:
                by[a.name]["value"] = value
            if a.note is not None:
                by[a.name]["note"] = a.note
            if a.project is not None:
                by[a.name]["project"] = a.project
        else:
            items.append({"name": a.name, "value": value, "note": a.note or "", "project": a.project or ""})
        after = by.get(a.name, items[-1])
        if before is not None and before == after:
            return _env_answer(a, {"ok": True, "name": a.name, "note": after["note"], "project": after.get("project") or "", "changed": False},
                               L.t(f"{a.name} is already saved like that; nothing changed.", f"{a.name} 本来就是这样，没有改动。"))
        _env_backup()
        env_write(items)
        ev = _mod("env_changes").record("edit" if describe else "set", a.name, before, after, by=_env_by(a), index=index)
        tag = after.get("project") or ""
        say = _env_say(a.name, after["note"])
        text = (L.t(f"{a.name} saved ({len(after['value'])} characters)" + (f", for project {tag}" if tag else "") + f". Agents read it with `dispatch env get {a.name}`, from their next call on; to have it as an environment variable in your own terminal, add `source ~/.config/dispatch/env.sh` to ~/.zshrc (zsh/bash) or `source ~/.config/dispatch/env.fish` (fish).",
                    f"{a.name} 已保存（{len(after['value'])} 个字符）" + (f"，属于项目 {tag}" if tag else "") + f"。Agent 下一次用 `dispatch env get {a.name}` 就能取到；要在自己的终端里直接当环境变量用：zsh/bash 在 ~/.zshrc 里加一行 `source ~/.config/dispatch/env.sh`，fish 加 `source ~/.config/dispatch/env.fish`。")
                if not describe else L.t(f"{a.name}: purpose and project saved; the value is unchanged.", f"{a.name}：用途和项目已保存，值没变。"))
        _env_answer(a, {"ok": True, "name": a.name, "note": after["note"], "project": tag, "changed": True, "created": before is None,
                        "change": ev["id"], "length": len(after["value"]), "say": say}, text + "\n" + say)
    elif a.op == "unset":
        if a.name not in by:
            print(L.t(f"There was no {a.name}", f"本来就没有 {a.name}"), file=sys.stderr)
            sys.exit(1)
        index = next(i for i, it in enumerate(items) if it["name"] == a.name)
        _env_backup()
        env_write([it for it in items if it["name"] != a.name], removed=[a.name])
        ev = _mod("env_changes").record("unset", a.name, by[a.name], None, by=_env_by(a), index=index)
        _env_answer(a, {"ok": True, "name": a.name, "note": by[a.name]["note"], "project": by[a.name].get("project") or "", "change": ev["id"]},
                    L.t(f"{a.name} deleted. `dispatch env undo {ev['id']}` brings it back.", f"{a.name} 已删除。`dispatch env undo {ev['id']}` 能找回。"))
    elif a.op == "undo":
        C = _mod("env_changes")
        res, err = C.undo(a.name, items)
        if err:
            if a.json:
                return _env_answer(a, {"ok": False, "error": err}, err)
            print(err, file=sys.stderr)
            sys.exit(1)
        _env_backup()
        # Undo of a new key takes it out on purpose: named, so the guard against lost keys lets it go
        env_write(items, removed=[res["name"]] if res["restored"] == "removed" else ())
        now = next((it for it in items if it["name"] == res["name"]), None)
        C.record("undo", res["name"], res["after_item"], now, by=_env_by(a))
        text = (L.t(f"{res['name']} is back as it was.", f"{res['name']} 已恢复原样。") if res["restored"] == "value"
                else L.t(f"{res['name']} removed again (it was new).", f"{res['name']} 已撤掉（它是新加的）。"))
        _env_answer(a, {"ok": True, "name": res["name"], "restored": res["restored"]}, text)
    elif a.op == "export":
        for it in items:
            print(f"set -gx {it['name']} {env_quote(it['value'])}" if a.fish else f"export {it['name']}={env_quote(it['value'])}")
    elif a.op == "import":
        n = 0
        for line in open(a.name, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip().replace("export ", "")
            v = v.strip().strip("\"'")
            if _ENV_KEY.match(k) and v:
                if k in by:
                    by[k]["value"] = v
                else:
                    items.append({"name": k, "value": v, "note": a.note or L.t(f"imported from {os.path.basename(a.name)}", f"从 {os.path.basename(a.name)} 导入"), "project": a.project or ""})
                    by[k] = items[-1]
                n += 1
        env_write(items)
        print(L.t(f"Imported {n}", f"导入 {n} 个"))


# ---------------------------------------------------------------- prime: compact session-start digest

def project_names(rows=None):
    """lowercase name -> the name as written, from the `project:` labels on the board.
    Pass `rows` when the caller already holds every issue (a `bd export`, say): the labels are
    the same and one whole-board round-trip per call is what `here` was spending 0.3s on."""
    names = {}
    if rows is None:
        code, o, err = sh(["bd", "list", "--all", "--json"])
        if code != 0:
            return names
        try:
            rows = json.loads(o[o.find("["):])
        except Exception:
            return names
    for it in rows or []:
        for l in it.get("labels") or []:
            if l.startswith("project:"):
                names[l.split(":", 1)[1].lower()] = l.split(":", 1)[1]
    return names


# a linked worktree's main checkout, per worktree folder, for this process: `projects-view` asks for the same few
# folders hundreds of times (one `git` each, 116 of 155 processes on the author's Mac, kanban task-mpidn)
_WORKTREE_MAIN = {}


def git_project_root(cwd):
    """The main checkout containing cwd, including linked worktrees outside HOME."""
    if not cwd:
        return ""
    d = os.path.realpath(os.path.expanduser(cwd))
    while d and d != os.path.dirname(d):
        if os.path.isdir(os.path.join(d, ".git")):
            return d
        if os.path.isfile(os.path.join(d, ".git")):
            if d not in _WORKTREE_MAIN:
                _WORKTREE_MAIN[d] = _worktree_main(d)
            return _WORKTREE_MAIN[d]
        d = os.path.dirname(d)
    return ""


def _worktree_main(d):
    # Git also resolves relative gitdir paths and nested worktree folders.
    try:
        r = subprocess.run(["git", "-C", d, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                           capture_output=True, text=True, timeout=5)
        common = r.stdout.strip()
        if r.returncode == 0 and os.path.basename(common) == ".git":
            return os.path.dirname(os.path.realpath(common))
    except (OSError, subprocess.TimeoutExpired):
        pass
    return d


def git_root_name(cwd):
    return os.path.basename(git_project_root(cwd))


def workspace_project(cwd, roots=None):
    """~/Projects/<x>/… is <x> for every root in settings; '' when cwd is not under one."""
    cwd = os.path.normpath(cwd or "")
    for r in (roots if roots is not None else settings_load().get("workspace_roots") or []):
        root = os.path.normpath(os.path.expanduser(r))
        if (P.is_under(cwd, root) and not P.same_path(cwd, root)) if P.IS_WIN else cwd.startswith(root + os.sep):
            # `<project>-wt/<branch>` holds git worktrees of <project>: same project. So does
            # `<project>.worktrees/<name>`, where the Agents window (Dispatch IDE) puts its worktrees.
            return re.sub(r"(-wt|\.worktrees)$", "", cwd[len(root) + 1:].split(os.sep)[0])
    return ""


def project_of_cwd(cwd, names, roots=None):
    # Same precedence as the sidebar (projects_view._session_project): a registered project's folder first (a project
    # renamed with `projects-view rename --key` keeps its folder: ~/Projects/Quillbench can be "ALG"), then the workspace
    # root, the git repo root, a known project name on the path.
    # Pass `roots` when calling in a loop: looking them up means a `bd memories` round-trip.
    norm = os.path.normpath(cwd)
    for key, home in sorted(project_dirs().items(), key=lambda kv: -len(kv[1])):
        if (P.is_under(norm, home) if P.IS_WIN else norm == home or norm.startswith(home.rstrip("/") + "/")):
            return project_dir_names().get(key, key)
    ws = workspace_project(cwd, roots)
    if ws:
        # <folder>-wt/… of a registered folder whose project has another name is that project
        return next((project_dir_names().get(key, key) for key, home in project_dirs().items() if os.path.basename(home) == ws), ws)
    main = git_project_root(cwd)
    if main:
        for key, home in project_dirs().items():
            if os.path.realpath(home) == main:
                return project_dir_names().get(key, key)
        name = os.path.basename(main)
        return names.get(name.lower(), name)
    parts = [x.lower() for x in norm.split(os.sep) if x]
    for part in reversed(parts):
        if part in names:
            return names[part]
    return ""


def neighbours(cwd, self_id="", local_only=False, skip_pids=()):
    """Other live sessions working in this directory (or a parent/child of it). `local_only`
    skips the other Macs: asking them is an ssh per peer (12 s each when one is asleep), which the
    SessionStart hook cannot afford — and a session on another Mac does not edit this folder.
    `skip_pids`: this command's own process tree, so the agent running it is not its own neighbour
    (its window's id and the engine's own id often differ)."""
    cwd = os.path.normpath(cwd)
    rows = []
    try:
        live = live_sessions(local_only=local_only)
    except Exception:
        return rows
    skip = set(skip_pids or ())
    for s in live:
        if not s.get("alive") or (self_id and self_id in (s.get("session_id"), s.get("native_session_id"))):
            continue
        try:
            if skip and int(s.get("agent_pid") or 0) in skip:
                continue
        except (TypeError, ValueError):
            pass
        c = os.path.normpath(s.get("cwd") or "")
        if not c or c == "/":
            continue
        nested = cwd not in (HOME, "/") and c not in (HOME, "/") and (cwd.startswith(c + os.sep) or c.startswith(cwd + os.sep))
        if c == cwd or nested:
            rows.append(s)
    return rows


EDITS_DIR = os.path.join(DISPATCH_DIR, "edits")


def session_edit_map(window=30 * 60, with_activity=True):
    """Recent file edits per session inside `window` seconds.

    Two sources, because neither is complete alone: the edit-guard registry (Pre/PostToolUse
    hooks — exact timestamp, but only agents that installed the hook) and the incremental
    transcript index (every Edit/Write a conversation ran, whichever agent). Keyed by
    session_id; files are absolute paths, values are epoch seconds.
    """
    now = time.time()
    out = {}

    def add(sid, agent, path, ts, source, cwd=""):
        if not sid or not path:
            return
        rec = out.setdefault(sid, {"session_id": sid, "agent": agent or "", "cwd": cwd or "", "files": {}, "source": {}})
        if agent and not rec["agent"]:
            rec["agent"] = agent
        if cwd and not rec["cwd"]:
            rec["cwd"] = cwd
        p = os.path.abspath(path)
        if p not in rec["files"] or ts > rec["files"][p]:
            rec["files"][p] = ts
        if source == "edit-guard" or p not in rec["source"]:
            rec["source"][p] = source

    for n in os.listdir(EDITS_DIR) if os.path.isdir(EDITS_DIR) else []:
        try:
            r = json.load(open(os.path.join(EDITS_DIR, n), encoding="utf-8"))
        except Exception:
            continue
        ts = r.get("ts", 0)
        if now - ts <= window:
            add(r.get("session_id", ""), r.get("agent", ""), r.get("file", ""), ts, "edit-guard")
    if with_activity:
        try:
            from activity import activity_list
            for s in activity_list(HOME, DISPATCH_DIR, load_index()):
                for f, ts in (s.get("files") or {}).items():
                    if now - ts <= window:
                        add(s.get("session_id", ""), s.get("agent", ""), f, ts, "activity", s.get("cwd", ""))
        except Exception:
            pass
    return out


def session_cwd_map():
    """session_id → cwd for live sessions (edit-guard records carry no directory)."""
    m = {}
    try:
        for s in live_sessions(local_only=True):
            sid = s.get("session_id")
            if sid and s.get("cwd"):
                m.setdefault(sid, s["cwd"])
    except Exception:
        pass
    return m


def _edit_in_dir(rec, cwd):
    """Same directory or nested below it — matching neighbours(); falls back to the file
    paths when the session has no recorded cwd."""
    d = os.path.normpath(cwd)
    c = os.path.normpath(rec.get("cwd") or "")
    if c and (c == d or c.startswith(d + os.sep) or d.startswith(c + os.sep)):
        return True
    return any(f == d or f.startswith(d + os.sep) for f in rec["files"])


def cmd_editing(a):
    """Who is editing which file right now, and where two sessions landed on the same one."""
    window = max(1, int(getattr(a, "window", 30))) * 60
    edits = session_edit_map(window)
    cwds = session_cwd_map()
    for rec in edits.values():
        if not rec["cwd"]:
            rec["cwd"] = cwds.get(rec["session_id"], "")
    d = os.path.abspath(os.path.expanduser(a.dir)) if getattr(a, "dir", None) else ""
    recs = [r for r in edits.values() if r["files"] and (not d or _edit_in_dir(r, d))]
    by_file = {}
    for r in recs:
        for f, ts in r["files"].items():
            e = by_file.setdefault(f, {"file": f, "editors": []})
            e["editors"].append({"agent": r["agent"], "session_id": r["session_id"], "cwd": r["cwd"], "ts": ts, "source": r["source"].get(f, "")})
    for e in by_file.values():
        e["editors"].sort(key=lambda x: -x["ts"])
        e["conflict"] = len({x["session_id"] for x in e["editors"]}) > 1
    files = sorted(by_file.values(), key=lambda e: (not e["conflict"], -max(x["ts"] for x in e["editors"])))
    recs.sort(key=lambda r: -max(r["files"].values()))
    sessions = [{"agent": r["agent"], "session_id": r["session_id"], "cwd": r["cwd"],
                 "files": [f for f, _ in sorted(r["files"].items(), key=lambda kv: -kv[1])]} for r in recs]
    report = {"window_minutes": window // 60, "dir": d or None, "files": files, "sessions": sessions}

    def text(o):
        if not o["files"]:
            print(L.t(f"No session changed a file in the last {o['window_minutes']} minutes", f"最近 {o['window_minutes']} 分钟没有会话改动文件"))
            return
        print(L.t(f"In the last {o['window_minutes']} minutes {len(o['sessions'])} sessions changed {len(o['files'])} files", f"最近 {o['window_minutes']} 分钟有 {len(o['sessions'])} 个会话改过 {len(o['files'])} 个文件"))
        for e in o["files"]:
            who = "、".join(f"{x['agent'] or '?'} {x['session_id'][:8]}" for x in e["editors"])
            print(f"{L.t('⚠ clash ', '⚠ 冲突 ') if e['conflict'] else '   '}{e['file']}  ← {who}")
    out(report, a.json, text)


def quota_for(actor):
    """Quota windows for this agent from the cached collectors (fresh enough for a session start)."""
    try:
        return quota_of(actor)
    except Exception:  # E.Unsupported too: an engine without a readable allowance
        return None


def quota_line(actor):
    q = quota_for(actor)
    if not q or not q.get("windows"):
        return "", None
    parts, worst = [], 0
    for w in q["windows"]:
        pct = w.get("used_percent")
        if pct is None:
            continue
        worst = max(worst, pct)
        left = ""
        if w.get("resets_at") and w["resets_at"] > time.time():
            m = int((w["resets_at"] - time.time()) / 60)
            left = L.t(f", resets in {m // 60}h{m % 60:02d}", f"，{m // 60}h{m % 60:02d} 后重置") if m < 2880 else L.t(f", resets in {m // 1440}d", f"，{m // 1440}d 后重置")
        parts.append(f"{w['label']} {round(pct)}%{left}")
    if not parts:
        return "", None
    return L.t(f"Allowance ({actor}): ", f"额度（{actor}）：") + " · ".join(parts) + L.t(".", "。"), worst


AGENT_ACTORS = {n for e in E.known() for n in (e.id, e.agent)} | {"agent"}  # the board names agents sign with


def bd_comments(tid):
    code, o, err = sh(["bd", "comments", tid, "--json"])
    if code != 0:
        return []
    try:
        d = json.loads(o[o.find("["):])
    except Exception:
        return []
    return sorted(d, key=lambda c: c.get("created_at", "")) if isinstance(d, list) else []


def human_note(comments, actor):
    """The user's latest note on a task, while no agent has answered it since.
    The task detail's 留言 box has no other reader; this is how it reaches the agent."""
    if not comments:
        return ""
    last = comments[-1]
    author = (last.get("author") or "").lower()
    if not author or author in AGENT_ACTORS or author == (actor or "").lower():
        return ""
    return re.sub(r"\s+", " ", last.get("text") or "").strip()[:240]


# ---------------------------------------------------------------- dynamic workflow: discuss, then split
# A task can be talked over by several agents before anyone touches code: each one reads
# the task and the earlier voices, leaves exactly one 【讨论】 comment, and stops. The
# initiator then splits the task into sub-tasks and hands each to an agent.
DISCUSS_TAG = "【讨论】"
SPLIT_TAG = "【分工】"


def self_cmd():
    return [sys.executable, os.path.realpath(__file__)]


def project_home(proj, names=None, index=None, roots=None):
    """The directory a project lives in: its most recently active conversation folder, else
    ~/Projects/<project>; "" when nothing is known. Pass `index`/`roots` when calling in a
    loop — each lookup otherwise re-reads the session index and the settings."""
    if not proj:
        return ""
    try:
        home = project_dirs().get(proj.lower())
        if home and os.path.isdir(home):
            return home
    except Exception:
        pass
    names = names if names is not None else project_names()
    # Same rule as the app's projectHome(): the folder with the most sessions, latest activity
    # breaking ties — so a sub-repo opened once does not become the project's home.
    stats = {}
    try:
        roots = (settings_load().get("workspace_roots") or []) if roots is None else roots
        index = load_index() if index is None else index
        mine = {}
        for e in index.values():
            cwd = (e.get("cwd") or "").rstrip("/")
            if not cwd:
                continue
            if cwd not in mine:
                mine[cwd] = os.path.isdir(cwd) and project_of_cwd(cwd, names, roots).lower() == proj.lower()
            if mine[cwd]:
                st = stats.setdefault(cwd, [0, 0])
                st[0] += 1
                st[1] = max(st[1], e.get("mtime", 0))
    except Exception:
        pass
    if stats:
        return max(stats, key=lambda c: (stats[c][0], stats[c][1]))
    guess = os.path.join(HOME, "Projects", proj)
    return guess if os.path.isdir(guess) else ""


def task_project_dir(issue, names=None):
    """Where an agent working on this task should sit: the project's latest conversation
    folder, else ~/Projects/<project>, else here."""
    proj = next((l.split(":", 1)[1] for l in issue.get("labels") or [] if l.startswith("project:")), "")
    if not proj:
        return os.getcwd()
    return project_home(proj, names) or os.getcwd()


DISCUSSION_LABEL = "dispatch:discussion"   # a task that exists only to hold a discussion (topic / project)


DISCUSS_GUIDE_EN = ("How to speak: you are one member of a discussion group and speak as yourself (agent name + model), like a colleague with opinions, not like a form. "
                    "First look at what the person who started it said last: a greeting, small talk or one short line gets one or two natural lines back (say hello, ask what they want to talk about), no format, no analysis, no risks or task splits; "
                    "a proposal or question that can be acted on gets your judgement (do it / don't / do it another way) and the reasons, with how to do it, a split (one line per sub-task: title · who should do it · why) and risks only where you have something to say. "
                    "Answer what others already said instead of repeating it; change no code and claim no task; leave exactly one comment and stop. Write in the language the discussion uses.")
DISCUSS_GUIDE = ("说话的规矩：你是讨论群里的一个成员，用自己的身份（Agent 名 + 模型）说话，像一个有主见的同事，不像表单。"
                 "先看发起人最新说的是什么：如果只是打招呼、闲聊或一句短话，就自然地回一两句（比如问好、问对方想聊什么），不要套任何格式、不要分析、不要写风险和拆分；"
                 "如果是一个可以做的提议或问题，再给出你的判断（做 / 不做 / 换个做法）和理由，需要时附做法、拆分建议（每个子任务一行：标题 · 建议谁做 · 为什么）和风险，但只写有内容的部分，别为了凑段落硬写。"
                 "针对别人已经说过的观点回应，不重复；不改代码、不认领任务；一次只留一条评论，写完就停。")


def discuss_prompt(tid, title, round_no, question="", topic=False, project="", who=""):
    ctx = ""
    if topic:
        ctx = L.t("This is a discussion of an idea or topic, not a decided task."
                  + (f" It belongs to project \"{project}\": when needed, `dispatch project-summary {project}` shows where the project stands, `bd list -l project:{project} --json` its open tasks, `dispatch wiki search {project}` its pitfalls." if project else ""),
                  "这是一个念头/主题的讨论，不是已定的任务。"
                  + (f" 它挂在项目「{project}」下：需要时用 `dispatch project-summary {project}` 看项目现状、`bd list -l project:{project} --json` 看未完成任务、`dispatch wiki search {project}` 看这个项目踩过的坑。" if project else ""))
    sign = L.t(f" Start your statement with your signature \"{who}：\".", f" 发言开头署名「{who}」。") if who else ""
    if L.lang() == "en":
        if round_no <= 1:
            return (f"You take part in the discussion of {'topic' if topic else 'task'} {tid} \"{title}\". {ctx} {DISCUSS_GUIDE_EN}{sign} "
                    f"Steps: 1) `bd show {tid}` for the background (if the description lists image paths, look at them with Read first); 2) `bd comments {tid}` for what was said (the ones tagged {DISCUSS_TAG}, including the starter's interjections); "
                    f"3) write exactly one comment: `dispatch log {tid} \"{DISCUSS_TAG}<signature>：…\"`." + (f" The starter's question: {question}" if question else ""))
        return (f"Round {round_no}: read `bd comments {tid}` again, especially the starter's latest words and the others' {DISCUSS_TAG} statements (look at image paths in them with Read), and answer with one `dispatch log {tid} \"{DISCUSS_TAG}<signature>：…\"`. {DISCUSS_GUIDE_EN}{sign}")
    if round_no <= 1:
        return (f"你参加{'主题' if topic else '任务'} {tid}「{title}」的讨论。{ctx}{DISCUSS_GUIDE}{sign}"
                f"步骤：1) `bd show {tid}` 读背景（描述里若列了附图路径，先用 Read 看图）；2) `bd comments {tid}` 读已有发言（带{DISCUSS_TAG}的，发起人插话也在里面）；"
                f"3) 只写一条评论：`dispatch log {tid} \"{DISCUSS_TAG}<署名>：…\"`。" + (f" 发起人的问题：{question}" if question else ""))
    return (f"第 {round_no} 轮：`bd comments {tid}` 再读一遍，特别是发起人最新插的话和别人的{DISCUSS_TAG}发言（发言里若有附图路径，用 Read 看），用一条 `dispatch log {tid} \"{DISCUSS_TAG}<署名>：…\"` 回应。{DISCUSS_GUIDE}{sign}")


# ---- headless rounds: the CLI calls claude -p / codex exec / pi -p directly, feeds the thread
# in the prompt and writes the reply as the member's 【讨论】 comment. No terminal, no shell
# start-up, no `bd show` + `bd comments` + `dispatch log` round trips per statement.
DISCUSSIONS_DIR = os.path.join(DISPATCH_DIR, "discussions")
# the engines that take part in discussions (a persona of their own) and answer in the background
HEADLESS_KINDS = tuple(e.id for e in E.known() if e.discuss_persona and e.supports("headless_argv"))
IMG_RE = re.compile(r"((?:~|/|[A-Za-z]:[\\/])[^\s\"'`<>()\[\]]+?\.(?:png|jpe?g|gif|webp|bmp))", re.I)


def node_bin_dirs():
    """Where npm-installed CLIs (codex, pi, gemini…) live when the caller is the app, not a
    login shell: the global npm prefix, volta/bun, the newest nvm node."""
    if P.IS_WIN:
        appdata = os.environ.get("APPDATA") or os.path.join(HOME, "AppData", "Roaming")
        dirs = [os.path.join(appdata, "npm"), os.path.join(HOME, ".volta", "bin"), os.path.join(HOME, ".bun", "bin"),
                os.path.join(os.environ.get("ProgramFiles") or "C:\\Program Files", "nodejs")]
        return [d for d in dirs if os.path.isdir(d)]
    dirs = [os.path.join(HOME, "npm-global", "bin"), os.path.join(HOME, ".npm-global", "bin"), os.path.join(HOME, ".volta", "bin"), os.path.join(HOME, ".bun", "bin")]
    dirs += sorted(glob.glob(os.path.join(HOME, ".nvm", "versions", "node", "*", "bin")), reverse=True)[:1]
    return [d for d in dirs if os.path.isdir(d)]


def child_env():
    """Environment for a headless CLI child: PATH extended (incl. npm's global bin, since the
    app's PATH is not a login shell's), every CLAUDE* variable stripped (a claude started from
    inside a Claude Code session refuses to nest otherwise), BEADS_DIR set."""
    e = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}
    # a session started from inside a Dispatch terminal is not that terminal's conversation (capture.py)
    e.pop("DISPATCH_TERMINAL_SESSION", None)
    old = e.pop("Path", "") if P.IS_WIN and "PATH" not in e else ""
    e["PATH"] = os.pathsep.join([PATH_EXTRA] + node_bin_dirs() + [e.get("PATH", old)])
    e.setdefault("BEADS_DIR", BEADS_DIR)
    return e


def discussion_images(*texts):
    """Picture paths mentioned in the idea or a statement (the app writes them in as lines)."""
    seen, found = set(), []
    for t in texts:
        for m in IMG_RE.findall(t or ""):
            p = os.path.expanduser(m)
            if p not in seen and os.path.isfile(p):
                seen.add(p); found.append(p)
    return found


def discussion_lines(comments):
    """The 【讨论】 statements as `[author] text` lines, in order."""
    rows = []
    for c in comments:
        t = (c.get("text") or "").strip()
        if t.startswith(DISCUSS_TAG):
            rows.append(f"[{c.get('author')}] {t[len(DISCUSS_TAG):].strip()}")
    return rows


def discussion_thread(issue, comments):
    """The whole thread as one block of text: the idea, then every statement in order."""
    desc = (issue.get("description") or "").split("\n\n## 讨论文档", 1)[0].strip()
    title = (issue.get("title") or "").replace(DISCUSS_TAG, "", 1).strip()
    return L.t(f"Topic: {title}\n{desc}\n\nStatements (in order):\n", f"主题：{title}\n{desc}\n\n发言（按时间）：\n") + "\n\n".join(discussion_lines(comments))


def discussion_system(who, kind, settings):
    """The member's standing identity — persona from settings, the group's rules, the output
    contract — injected at system level (claude/pi --append-system-prompt, codex
    developer_instructions), so no round has to repeat it."""
    persona = (settings.get(f"discuss_persona_{kind}") or "").strip()
    rules = (settings.get("discuss_rules") or DISCUSS_RULES_DEFAULT).strip()
    if L.lang() == "en":
        return (f"You are \"{who}\", a member of a discussion group: speak like a colleague with opinions, not like a form. " + (f"Who you are: {persona} " if persona else "")
                + f"The group's rules: {rules} "
                "First look at what the latest message says: a greeting or small talk gets one or two natural lines (say hello, ask what they want to talk about), no analysis, no format; only a proposal or question that can be acted on gets a judgement (do it / don't / do it another way) and the reasons, with how to do it or a split when needed (one line per sub-task: title · who should do it · why). "
                f"Your output is the body of this one statement: no signature, no {DISCUSS_TAG}, no Markdown headings; change no code, claim no task; use tools only for what the thread does not say. Write in the language the discussion uses.")
    return (f"你是讨论群里的成员「{who}」，像一个有主见的同事说话，不像表单。" + (f"你的人设：{persona}" if persona else "")
            + f"群里的规矩：{rules}"
            "先看最新一条说的是什么：打招呼或闲聊就自然回一两句（问好、问对方想聊什么），不要分析、不要套格式；是一个可以做的提议或问题，才给判断（做 / 不做 / 换个做法）和理由，需要时附做法或拆分建议（每个子任务一行：标题 · 建议谁做 · 为什么）。"
            "你的输出就是这一条发言的正文：不署名、不加【讨论】、不用 Markdown 标题；不改代码、不认领任务；线程里没有的情况才用工具查。")


def headless_prompt(tid, title, round_no, thread, who, question="", topic=False, project="", images=()):
    ctx = ""
    if topic:
        ctx = L.t("This is a discussion of an idea or topic, not a decided task."
                  + (f" It belongs to project \"{project}\" (where it stands: `dispatch project-summary {project}`, `bd list -l project:{project} --json`, `dispatch wiki search {project}`)." if project else ""),
                  "这是一个念头/主题的讨论，不是已定的任务。"
                  + (f" 它挂在项目「{project}」下（项目现状：`dispatch project-summary {project}`、`bd list -l project:{project} --json`、`dispatch wiki search {project}`）。" if project else ""))
    if L.lang() == "en":
        head = (f"You take part in the discussion of {'topic' if topic else 'task'} {tid} \"{title}\" (round {round_no}). {ctx} The whole thread is below, no need to read the board; reply with your statement, or only SKIP when you have nothing new."
                + (f" The starter's question: {question}" if question else "")
                + ("\nImages (look at them with Read before you speak):\n" + "\n".join(images) if images else ""))
        return head + "\n\n=== Thread ===\n" + thread
    head = (f"你参加{'主题' if topic else '任务'} {tid}「{title}」的讨论（第 {round_no} 轮）。{ctx}线程完整贴在下面，不用再读板；回你的发言，没有新东西就只回 SKIP。"
            + (f" 发起人的问题：{question}" if question else "")
            + ("\n附图（发言前用 Read 工具看一遍）：\n" + "\n".join(images) if images else ""))
    return head + "\n\n=== 线程 ===\n" + thread


def timeout_to_ms(value, default_ms=600000, floor_ms=60000):
    """`--timeout` on discuss / agent is in milliseconds, but people and agents write seconds
    (`--timeout 1200` meaning twenty minutes ended a member's turn with 「1 秒没说完」). Nobody
    wants a turn shorter than ten seconds, so a value under 10 000 is read as seconds; and no
    member gets less than a minute."""
    try:
        v = int(value)
    except (TypeError, ValueError):
        return default_ms
    if v <= 0:
        return default_ms
    if v < 10000:
        v *= 1000
    return max(floor_ms, v)


def headless_call(kind, model, prompt, cwd, timeout_ms, images=(), system="", session="", resume=False, on_event=None, thinking=""):
    """One statement from one member. Returns {text, session, error, secs}. The session id is
    what the next round resumes with (claude --resume, codex exec resume, pi --session-id).
    `thinking` is pi's --thinking level (a discussion turn runs it low: GLM-class models
    otherwise think for a minute before a two-line reply).
    on_event(status, text_so_far, step) is called as the reply streams in (claude and pi send
    text deltas; codex only says when it is thinking and when it is done). `step` names what the
    member is doing besides typing: 想：<the thought so far> or 查：<tool> <what> — the app's
    bubble shows it as 在想 / 在查."""
    t0 = time.time()
    env = child_env()
    eng = E.get(kind)
    if not eng.supports("run_result"):
        return {"text": "", "session": "", "error": L.t(f"{kind} has no headless mode", f"{kind} 没有无头模式"), "secs": 0}
    lastfile = sdir = ""
    if eng.headless_lastfile:
        lastfile = os.path.join(DISPATCH_DIR, "tmp", f"{kind}-{os.getpid()}-{int(t0 * 1000)}.txt")
        os.makedirs(os.path.dirname(lastfile), exist_ok=True)
    if eng.headless_session_dir:
        sdir = os.path.join(DISCUSSIONS_DIR, f"{kind}-sessions")
        os.makedirs(sdir, exist_ok=True)
    session = session or ("" if resume else eng.headless_new_session())
    stdin_prompt = P.IS_WIN and eng.headless_stdin_prompt  # Windows' command line is short: the prompt on stdin
    argv = eng.headless_argv(model, prompt, cwd, images=images, system=system, session=session, resume=resume,
                             lastfile=lastfile, stdin_prompt=stdin_prompt, session_dir=sdir, thinking=thinking)
    raw_emit = on_event or (lambda status, text, step="": None)

    def emit(status, text, step=""):
        try:
            raw_emit(status, text, step)
        except TypeError:  # an older callback that only takes (status, text)
            raw_emit(status, text)
    emit("thinking", "")
    lines, partial = [], []
    thought, tool_json, cur = [], [], {"block": ""}  # the thinking / tool-input block being streamed

    def tool_step(name, args):
        inp = {}
        try:
            inp = json.loads(args) if args else {}
        except Exception:
            pass
        what = inp.get("command") or inp.get("file_path") or inp.get("path") or inp.get("pattern") or inp.get("description") or inp.get("prompt") or "" if isinstance(inp, dict) else ""
        return (L.t("Looking up: ", "查：") + f"{name} {str(what)[:80]}").strip()

    def stream_line(line):
        """Live text for the typing bubble (the engine's own events, read by its adapter); the final parse below reads
        the whole output again."""
        try:
            ev = json.loads(line)
        except Exception:
            return
        for what, *arg in eng.live_events(ev) if isinstance(ev, dict) else ():
            if what == "block_start":
                cur["block"] = arg[0]
                if arg[0] == "thinking":
                    thought.clear(); emit("thinking", "".join(partial), L.t("Thinking: ", "想："))
                elif arg[0] == "tool_use":
                    tool_json.clear(); cur["tool"] = arg[1]; emit("thinking", "".join(partial), tool_step(cur["tool"], ""))
            elif what == "text_delta":
                partial.append(arg[0]); emit("typing", "".join(partial))
            elif what == "text_reset":
                partial.clear()
            elif what == "thinking_delta":
                thought.append(arg[0]); emit("thinking", "".join(partial), L.t("Thinking: ", "想：") + "".join(thought)[-160:])
            elif what == "thinking":
                emit("thinking", "".join(partial), L.t("Thinking: ", "想：") + arg[0][-160:])
            elif what == "input_delta":
                tool_json.append(arg[0])
                if len(tool_json) % 8 == 0:  # the arguments take shape; refresh the "查：" line now and then
                    emit("thinking", "".join(partial), tool_step(cur.get("tool", ""), "".join(tool_json)))
            elif what == "block_stop" and cur["block"] == "tool_use":
                emit("thinking", "".join(partial), tool_step(cur.get("tool", ""), "".join(tool_json)))
            elif what == "tool":
                emit("thinking", "".join(partial), tool_step(arg[0], arg[1]))
            elif what == "command":
                emit("thinking", "".join(partial), L.t("Looking up: ", "查：") + f"{str(arg[0])[:80]}")
            elif what == "message":
                if not partial:  # a whole message (after tool use the text so far is repeated): start the bubble over
                    emit("typing", arg[0])
            elif what == "tool_result":
                emit("thinking", "".join(partial), "")  # the tool answered; the member reads it and goes on

    stdin_text = prompt if stdin_prompt else None
    if P.IS_WIN:
        exe = P.which(argv[0], env)
        if exe:
            argv = [exe] + argv[1:]
    try:
        if stdin_text is None:
            proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, env=env, cwd=cwd, creationflags=P.no_window_flags())
        else:
            proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.PIPE, env=env, cwd=cwd,
                                    creationflags=P.no_window_flags())
    except FileNotFoundError:
        emit("error", L.t(f"{kind} is not installed", f"没装 {kind}"))
        return {"text": "", "session": session, "error": L.t(f"{kind} is not installed", f"没装 {kind}"), "secs": round(time.time() - t0, 1)}
    import threading as _th
    err_buf = []
    reader = _th.Thread(target=lambda: err_buf.append(proc.stderr.read()), daemon=True)
    reader.start()
    if stdin_text is not None:
        def feed():
            try:
                proc.stdin.write(stdin_text.encode("utf-8"))
            except OSError:
                pass
            finally:
                try:
                    proc.stdin.close()
                except OSError:
                    pass
        _th.Thread(target=feed, daemon=True).start()
    deadline = t0 + max(30, timeout_ms // 1000)
    timed_out = False
    try:
        for raw in proc.stdout:
            line = raw.decode("utf-8", "replace")
            lines.append(line)
            stream_line(line)
            if time.time() > deadline:
                timed_out = True
                proc.kill()
                break
    except BaseException:
        proc.kill()  # we are being stopped (SIGTERM turned into SystemExit, Ctrl-C): no orphan model run
        raise
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
    reader.join(timeout=5)
    if timed_out:
        waited = int(time.time() - t0)
        emit("error", L.t(f"not finished after {waited} s", f"{waited} 秒没说完"))
        return {"text": "", "session": session, "error": L.t(f"not finished after {waited} s (the limit is {max(30, timeout_ms // 1000)} s; `--timeout` changes it)", f"{waited} 秒没说完（超时上限 {max(30, timeout_ms // 1000)} 秒，`--timeout` 可调）"), "secs": round(time.time() - t0, 1)}
    o, err = "".join(lines), (err_buf[0] if err_buf else b"").decode("utf-8", "replace")
    returncode = proc.returncode
    r = eng.run_result(o, err, lastfile, session)
    text, sid, error, usage = r["text"], r["session"], r["error"], r["usage"]
    if returncode != 0 and not text:
        error = error or (err or o).strip()[-300:] or L.t(f"exit code {returncode}", f"退出码 {returncode}")
    emit("error" if error and not text else ("skip" if is_skip(text) else "done"), text.strip())
    return {"text": text.strip(), "session": sid, "error": error, "secs": round(time.time() - t0, 1), "usage": usage, "prompt_chars": len(prompt)}


def discussion_state_path(tid):
    return os.path.join(DISCUSSIONS_DIR, f"{tid}.json")


def discussion_state_load(tid):
    try:
        d = json.load(open(discussion_state_path(tid), encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def discussion_state_save(tid, state):
    os.makedirs(DISCUSSIONS_DIR, exist_ok=True)
    tmp = discussion_state_path(tid) + ".tmp"
    json.dump(state, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    P.replace_retry(tmp, discussion_state_path(tid))


def headless_followup_prompt(tid, round_no, new_lines, who, question="", images=()):
    """For a member whose session is resumed: only what was said since it last spoke."""
    if L.lang() == "en":
        return (f"Round {round_no}: the new statements are below (do not repeat what you said); reply with your statement, or only SKIP when you have nothing new."
                + (f" The starter's question: {question}" if question else "")
                + ("\nImages (look at them with Read):\n" + "\n".join(images) if images else "")
                + "\n\n=== New statements ===\n" + ("\n\n".join(new_lines) if new_lines else "(no new statements)"))
    return (f"第 {round_no} 轮，新发言在下面（你自己说过的不再重复）；回你的发言，没有新东西就只回 SKIP。"
            + (f" 发起人的问题：{question}" if question else "")
            + ("\n附图（用 Read 工具看）：\n" + "\n".join(images) if images else "")
            + "\n\n=== 新发言 ===\n" + ("\n\n".join(new_lines) if new_lines else "（没有新发言）"))


class DiscussionLive:
    """discussions/<task>.live.json — what each member is doing right now (queued / thinking /
    typing + the text so far / done / skip / error), rewritten as the replies stream in; the
    app polls it to draw the typing bubbles."""

    def __init__(self, tid, round_no, members, judge=None):
        import threading as _th
        self.path = os.path.join(DISCUSSIONS_DIR, f"{tid}.live.json")
        self.lock = _th.Lock()
        self.last_write = 0.0
        self.state = {"task": tid, "round": round_no, "started": int(time.time()), "at": int(time.time()), "members": {who: {"kind": kind, "status": "queued", "text": "", "at": int(time.time())} for who, kind in members}, **({"judge": judge} if judge else {})}
        self.flush(force=True)

    def update(self, who, status, text, step=""):
        with self.lock:
            m = self.state["members"].setdefault(who, {})
            changed = m.get("status") != status or (m.get("step") or "") != (step or "")
            m.update({"status": status, "text": text[-4000:], "step": (step or "")[:200], "at": int(time.time())})
            self.flush(force=changed)   # a status / step change lands at once; text deltas are throttled

    def flush(self, force=False):
        now = time.time()
        if not force and now - self.last_write < 0.4:
            return
        self.last_write = now
        self.state["at"] = int(now)
        try:
            os.makedirs(DISCUSSIONS_DIR, exist_ok=True)
            tmp = self.path + ".tmp"
            json.dump(self.state, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
            P.replace_retry(tmp, self.path)
        except Exception:
            pass

    def finish(self):
        with self.lock:
            self.state["finished"] = int(time.time())
            self.flush(force=True)


def cmd_discuss_live(a):
    path = os.path.join(DISCUSSIONS_DIR, f"{a.task}.live.json")
    try:
        d = json.load(open(path, encoding="utf-8"))
    except Exception:
        d = {}
    out(d, True, None)


def clean_statement(text, who):
    """The model was told not to sign; drop a signature or tag if it did anyway."""
    t = text.strip()
    t = re.sub(r"^【讨论】\s*", "", t)
    for name in (who, who.split("（")[0]):
        if name and t.startswith(name):
            rest = t[len(name):].lstrip()
            if rest[:1] in ("：", ":"):
                t = rest[1:].strip(); break
    return t


def is_skip(text):
    t = text.strip().strip("`*_ 。.").upper()
    return t in ("SKIP", "【SKIP】", "跳过") or (t.startswith("SKIP") and len(t) <= 12)


MENTION_ALL = ("all", "everyone", "大家", "所有人", "各位", "全体")
MENTION_RE = re.compile(r"@([A-Za-z][\w.-]*(?:[（(:][\w.-]+[）)]?)?|大家|所有人|各位|全体)")
# A member is "challenged" when someone else names it in a sentence that questions or refers
# to what it said — not when the name is just the CLI being talked about (`claude -p 直调`).
CHALLENGE_RE = re.compile(r"[?？]|不对|不同意|反对|质疑|有问题|存疑|不认同|错了|说错|未必|不一定|不见得|说的|说得|讲的|的方案|的提议|的建议|的观点|的看法|的判断|的说法|的结论|的做法|回应|解释|澄清|反驳|商榷|担心|顾虑|怎么看|什么看法|什么意见|你觉得|你认为|请.{0,6}(说|讲|答|解)")
SENTENCE_RE = re.compile(r"[。！？!?\n；;]+")


def member_names(kind, model):
    """How people write a member's name: the kind, the model, kind（model）/ kind:model, its actor."""
    names = {kind.lower(), E.agent_of(kind).lower()}
    if model:
        names |= {model.lower(), f"{kind}（{model}）".lower(), f"{kind}({model})".lower(), f"{kind}:{model}".lower()}
    return names


def discussion_judge(fresh, parts, member_actors=None):
    """The cheap referee: who has to speak this round, decided from what was said since the
    last round — no model call. Returns {"everyone": bool, "picked": [index…], "reasons": {index: [why…]}, "why": str}.
    Rules, in order: `@all` or a fresh line from a person that names nobody → everyone; `@name`
    → that member (kind, model, kind（model）); a member named by someone else in a sentence that
    questions or refers to what it said (CHALLENGE_RE) → that member; nobody named and no fresh
    line from a person → everyone (the members skip themselves)."""
    actors = member_actors or {e.agent for e in E.known()}
    names = [member_names(k, m) for k, m in parts]
    whos = [f"{k}{'（' + m + '）' if m else ''}" for k, m in parts]
    picked, reasons, everyone, why = [], {}, False, []

    def pick(i, reason):
        if i not in picked:
            picked.append(i)
        reasons.setdefault(i, [])
        if reason not in reasons[i]:
            reasons[i].append(reason)

    def by_name(token):
        t = token.lower().replace("(", "（").replace(")", "）").rstrip("）")
        hits = [i for i, ns in enumerate(names) if t in ns or t + "）" in ns]
        if not hits and "（" in t:   # @claude（opus → kind + model
            k, _, m = t.partition("（")
            hits = [i for i, (kind, model) in enumerate(parts) if kind.lower() == k and (model or "").lower() == m]
        return hits

    for c in fresh:
        text = (c.get("text") or "").strip()
        body = text[len(DISCUSS_TAG):].lstrip() if text.startswith(DISCUSS_TAG) else text
        author = (c.get("author") or "").strip()
        person = author not in actors
        opener = body.startswith("发起")
        if opener:   # 【讨论】发起：me 邀请 … ：question — the question is the part after the last colon
            body = body.split("：", 2)[-1] if body.count("：") >= 2 else ""
        # Who is talking: the signature (pi（deepseek）：…) tells two members of one kind apart;
        # a member never picks itself, whether it @'s or questions its own name.
        sig = body.split("：", 1)[0].strip() if not opener else ""
        selves = {i for i, w in enumerate(whos) if w == sig} or ({i for i, (k, m) in enumerate(parts) if E.agent_of(k) == author} if not person else set())
        speaker = author if person else (whos[next(iter(selves))] if len(selves) == 1 else sig or author)
        named_here = False
        for m in MENTION_RE.finditer(body):
            token = m.group(1)
            if token.lower() in MENTION_ALL:
                everyone = True; why.append(f"{speaker} @{token}"); named_here = True; continue
            for i in by_name(token):
                if i not in selves:
                    pick(i, L.t(f"@'d by {speaker}", f"被 {speaker} @")); named_here = True
        for sent in SENTENCE_RE.split(body):
            low = sent.lower()
            if not sent.strip() or not CHALLENGE_RE.search(sent):
                continue
            for i, ns in enumerate(names):
                if i in selves:
                    continue   # talking about yourself is not being challenged
                if any(re.search(r"(?<![\w@-])" + re.escape(n) + r"(?![\w-])", low) for n in ns if n):
                    pick(i, L.t(f"questioned by {speaker}", f"被 {speaker} 质疑")); named_here = True
        if person and body.strip() and not named_here:
            everyone = True; why.append(L.t(f"{speaker} spoke to everyone", f"{speaker} 对大家说"))
    if not fresh or (not picked and not everyone):
        everyone = True
        if fresh:
            why.append(L.t("nobody was named", "没人被点名"))
        else:
            why.append(L.t("no new statements", "没有新发言"))
    if everyone:
        return {"everyone": True, "picked": list(range(len(parts))), "reasons": {}, "why": L.t("everyone: ", "全员：") + L.t("; ", "；").join(why)}
    return {"everyone": False, "picked": picked, "reasons": reasons, "why": "、".join(f"{whos[i]}（{'，'.join(reasons[i])}）" for i in picked)}


CONCLUSION_HEADING = "## 讨论结论"


def description_sections(desc):
    """(original idea text, conclusion block or "", document block or "") — the three parts a
    discussion task's description is made of; each block keeps its own heading line."""
    desc = desc or ""
    doc = ""
    if "\n\n## 讨论文档" in desc:
        desc, doc = desc.split("\n\n## 讨论文档", 1)
        doc = "## 讨论文档" + doc
    con = ""
    if "\n\n" + CONCLUSION_HEADING in desc:
        desc, con = desc.split("\n\n" + CONCLUSION_HEADING, 1)
        con = CONCLUSION_HEADING + con
    elif desc.startswith(CONCLUSION_HEADING):
        con, desc = desc, ""
    return desc.rstrip(), con.strip(), doc.strip()


def description_join(original, conclusion, doc):
    return "\n\n".join(x for x in (original.rstrip(), conclusion.strip(), doc.strip()) if x)


def conclusion_of(issue, comments=()):
    """The current conclusion: the single block in the description, else (older threads) the
    last 【结论】 comment. Returns (text, when, by)."""
    _, con, _ = description_sections(issue.get("description") or "")
    if con:
        head, _, body = con.partition("\n")
        m = re.search(r"（(.+?) · (.+?)）", head)
        return body.strip(), (m.group(1) if m else ""), (m.group(2) if m else "")
    last = [c for c in comments if (c.get("text") or "").lstrip().startswith("【结论】")]
    if last:
        c = last[-1]
        return c["text"].lstrip()[4:].strip(), c.get("created_at", ""), c.get("author", "")
    return "", "", ""


LEADER_RE = re.compile(r"^领队[:：]\s*([a-z0-9_-]+)(?::([^\s]+))?\s*$", re.M | re.I)


def discussion_leader(issue, override=""):
    """(kind, model) of the discussion's leader: --leader on the command line, else the
    「领队：kind:model」 line the discussion task's description carries; ("", "") if none."""
    spec = (override or "").strip()
    if not spec:
        m = LEADER_RE.search(issue.get("description") or "")
        spec = (m.group(1) + (":" + m.group(2) if m.group(2) else "")) if m else ""
    if not spec:
        return "", ""
    kind, _, model = spec.partition(":")
    return kind.strip().lower(), model.strip()


def leader_chat(kind, model, system, prompt, cwd, timeout=180):
    """One answer from the leader's own model (a fresh headless session, no tools needed) —
    used for the conclusion and the document, so they carry the leader's judgement, not a
    cheap summariser's. Returns "" when the CLI is missing or fails (caller falls back)."""
    if kind not in HEADLESS_KINDS:
        return ""
    res = headless_call(kind, model, prompt, cwd or HOME, timeout * 1000, system=system)
    return "" if (res.get("error") and not res.get("text")) else (res.get("text") or "").strip()


def discussion_writer(issue, comments=(), leader=None):
    """Who writes the conclusion/document: the leader's model when there is one and its CLI
    answers, else the summary model. Returns (chat(system, user, timeout) -> text, label)."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import summarize
    if not summarize.use_enabled("discuss"):
        return None, ""
    kind, model = leader if leader is not None else discussion_leader(issue)
    if kind in HEADLESS_KINDS:
        label = f"{kind}:{model or 'default'}" + L.t(" (lead)", "（领队）")
        cwd = task_project_dir(issue) if issue.get("id") else HOME

        def chat(system, user, timeout=180):
            text = leader_chat(kind, model, system, user, cwd, timeout)
            if text:
                return text
            p = summarize.provider()
            return summarize.chat(p, system, user, timeout=timeout, use="discuss") if p else ""
        return chat, label
    p = summarize.provider()
    if not p:
        return None, ""
    return (lambda system, user, timeout=180: summarize.chat(p, system, user, timeout=timeout, use="discuss")), f"{p['id']}:{p['model']}"


def discussion_conclude(tid, title, comments, issue=None, leader=None):
    """The summary model reads every 【讨论】 statement and writes one conclusion — where they
    agree, where they differ, what the next step is. It is one block in the task's description
    (## 讨论结论), replaced each time, never a growing pile of stale 【结论】 comments."""
    issue = issue or bd_json(["show", tid, "--json"])
    chat, by = discussion_writer(issue, comments, leader)
    if not chat:
        return ""
    said = [c for c in comments if (c.get("text") or "").startswith(DISCUSS_TAG) and not (c.get("text") or "")[len(DISCUSS_TAG):].lstrip().startswith("发起")]
    body = "\n\n".join(f"{c.get('author')}：{(c.get('text') or '')[len(DISCUSS_TAG):].strip()}" for c in said)
    if not body.strip():
        return ""
    leads = "领队" in by or "(lead)" in by
    if L.lang() == "en":
        role = "You lead this discussion; below is what everyone (you included) said, in order." if leads else "You keep the record of a discussion. Below is what several AI agents (and the person who started it) said about one topic, in order."
        prompt = (role + " Write a conclusion of at most 120 words in the language of the discussion, in this order: what everyone agrees on; where they differ and why; what is still open and the suggested next steps (at most three, one sentence each). "
                  + ("As the lead, give your decision and reason where they differ; " if leads else "Only sum up what was said, add no opinion of your own; ")
                  + "the agents agreeing is not the starter's decision: only what the starter said clearly is decided. No headings, no quotes, no tools; output the paragraph itself.")
    else:
        role = "你是这场讨论的领队，下面是大家（含你自己）的发言，按时间排列。" if leads else "你是讨论的记录员。下面是几个 AI Agent（和发起人）对同一个主题的发言，按时间排列。"
        prompt = (role + "用简体中文写一段不超过 200 字的结论，按顺序：大家一致的判断；分歧在哪、各自理由；还没定的事和建议的下一步（最多三条，每条一句）。"
                  + ("作为领队，分歧处给出你的决定和理由；" if leads else "只归纳发言，不加自己的观点；")
                  + "Agent 的共识不等于发起人的决定，发起人明确说了的才算定了。不用标题、不用引号，不用工具，直接输出这段话。")
    try:
        text = chat(prompt, L.t(f"Topic: {title}\n\n{body}", f"主题：{title}\n\n{body}"), timeout=120).strip().replace("\n", " ")[:600]
    except Exception:
        return ""
    if not text:
        return ""
    original, _, doc = description_sections(issue.get("description") or "")
    block = f"{CONCLUSION_HEADING}（{time.strftime('%Y-%m-%d %H:%M')} · {by}）\n{text}"
    bd_json(["update", tid, "--description", description_join(original, block, doc), "--json"])
    return text


def cmd_discuss_conclude(a):
    issue = bd_json(["show", a.task, "--json"])
    if not issue.get("id"):
        raise SystemExit(L.t(f"No task {a.task}", f"没有任务 {a.task}"))
    comments = bd_comments(a.task)
    text = discussion_conclude(a.task, issue.get("title", ""), comments, issue)
    if not text:
        raise SystemExit(summary_off("discuss") or L.t("No conclusion could be written: nobody spoke, or there is no summary model (pick one in Settings)", "写不出结论：没有发言，或没有可用的总结模型（设置里选一个）"))
    out({"task": a.task, "conclusion": text}, a.json, lambda x: print(x["conclusion"]))


def split_spec(spec):
    """`codex:标题|说明` → (kind, title, description)."""
    if ":" not in spec:
        raise ValueError(L.t(f"The format is kind:title[|description]; got: {spec}", f"格式是 kind:标题[|说明]，收到：{spec}"))
    kind, rest = spec.split(":", 1)
    title, _, desc = rest.partition("|")
    if not kind.strip() or not title.strip():
        raise ValueError(L.t(f"Neither kind nor title may be empty: {spec}", f"kind 和标题都不能空：{spec}"))
    return kind.strip(), title.strip(), desc.strip()


def discussion_of(comments):
    return [c for c in comments if (c.get("text") or "").lstrip().startswith(DISCUSS_TAG)]


DISCUSSION_DOC_PROMPT_EN = ("You tidy up a discussion. Below is an idea as it was written and what several AI agents said about it (maybe with the starter's interjections and a conclusion). Turn it into a Markdown document another agent can start work from, in the language of the discussion, always with this structure:\n"
                            "# <title (at most 8 words)>\n## Background\n(what the idea is, why it is discussed now)\n## Conclusion\n(what the discussion decided: do it / don't / how, one paragraph)\n## Plan\n(how exactly, 3 to 8 points)\n## Steps\n(the steps in order, one a line, each with who should do it: Claude Code / Codex / pi)\n## Risks\n(the risks and pitfalls mentioned, one sentence each)\n## Acceptance\n(how to tell it is done, a - [ ] list)\n"
                            "Only sum up what was said, add nothing that was not; write \"none\" for an empty section. Do not wrap the whole document in a code block.")
DISCUSSION_DOC_PROMPT = ("你是讨论的整理者。下面是一个念头的原文和几个 AI Agent 的发言（以及可能有的发起人插话和一段结论）。把它整理成一份可以直接交给另一个 Agent 开工的 Markdown 文档，用简体中文，结构固定：\n"
                         "# <标题（≤30 字）>\n## 背景\n（这个念头是什么、为什么现在讨论）\n## 结论\n（讨论达成的判断，做/不做/怎么做，一段话）\n## 方案\n（具体怎么做，3–8 条要点）\n## 步骤\n（按顺序的执行步骤，每步一行，标出建议由谁做：Claude Code / Codex / pi）\n## 风险与注意\n（发言里提到的风险和坑，各一句）\n## 验收\n（做完怎么算做完，- [ ] 列表）\n"
                         "只归纳发言，不加发言里没有的内容；没有的段落写「无」。不要代码块包裹整份文档。")


def discussion_doc(tid):
    """Turn the thread into a document the next agent can start from; it becomes the task's
    description (so `bd show` is enough) and a file under ~/tasks/.dispatch/discussions/."""
    issue = bd_json(["show", tid, "--json"])
    if not issue.get("id"):
        raise SystemExit(L.t(f"No task {tid}", f"没有任务 {tid}"))
    comments = bd_comments(tid)
    chat, by = discussion_writer(issue, comments)
    if not chat:
        raise SystemExit(summary_off("discuss") or L.t("No model to use: pick a summary model in Settings, or give the discussion a lead", "没有可用的模型：设置里选一个总结模型，或给讨论指定领队"))
    said = [c for c in comments if (c.get("text") or "").startswith(DISCUSS_TAG)]
    if not said:
        raise SystemExit(L.t("Nobody has spoken in this discussion yet", "这个讨论还没有发言"))
    # 收尾 = 先把结论写成一条（覆盖旧的），再整理成文档。
    conclusion = discussion_conclude(tid, issue.get("title", ""), comments, issue)
    issue = bd_json(["show", tid, "--json"])
    original, con_block, _ = description_sections(issue.get("description") or "")
    if not conclusion:
        conclusion = conclusion_of(issue, comments)[0]
    body = L.t("Idea: ", "念头：") + f"{issue.get('title', '').replace('【讨论】', '')}\n{original}\n\n" + "\n\n".join(f"{c.get('author')}：{(c.get('text') or '')[len(DISCUSS_TAG):].strip()}" for c in said) + (L.t(f"\n\nConclusion: {conclusion}", f"\n\n结论：{conclusion}") if conclusion else "")
    leads = "领队" in by or "(lead)" in by
    doc = chat(L.t(DISCUSSION_DOC_PROMPT_EN, DISCUSSION_DOC_PROMPT) + (L.t(" You lead this discussion: where they differ, write your decision; the plan and steps must be ready to start. No tools; output the document itself.", "你是这场讨论的领队：分歧处按你的决定写，方案和步骤要能直接开工。不用工具，直接输出文档。") if leads else ""), body, timeout=240).strip()
    if doc.startswith("```"):
        doc = re.sub(r"^```\w*\n|\n```$", "", doc).strip()
    if not doc:
        raise SystemExit(L.t("The model returned no document", "模型没有返回文档"))
    folder = os.path.join(DISPATCH_DIR, "discussions")
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{tid}.md")
    open(path, "w", encoding="utf-8").write(doc + "\n")
    new_desc = description_join(original, con_block, f"## 讨论文档（{time.strftime('%Y-%m-%d %H:%M')} · {by}）\n\n" + doc)
    bd_json(["update", tid, "--description", new_desc, "--json"])
    m = re.search(r"##\s*(?:验收|Acceptance)\s*\n((?:\s*- \[[ x]\].*\n?)+)", doc)
    if m and not (issue.get("acceptance_criteria") or "").strip():
        bd_json(["update", tid, "--acceptance", m.group(1).strip(), "--json"])
    kind, model = discussion_leader(issue)
    return {"task": tid, "path": path, "doc": doc, "conclusion": conclusion, "by": by, "leader": {"kind": kind, "model": model} if kind else None}


ASIDE_SYSTEM_EN = (
    "You are the person's classmate, sitting next to them and explaining quietly. They are watching a discussion between several AI agents and did not understand something, so they ask you. "
    "First give the intuition in plain words with one small concrete example; then say what it means in this discussion and why someone brought it up. "
    "At most 150 words, no headings, do not judge who is right, do not decide for them. "
    "When unsure, say \"my guess is…\". Answer in the language they ask in."
)
ASIDE_SYSTEM = (
    "你是用户的同学，坐在旁边小声给 ta 讲。ta 正在看一场多个 AI Agent 的讨论，有个地方没听懂，来问你。"
    "先用大白话给直觉，配一个具体的小例子；再说这个东西在这场讨论里指什么、为什么有人提它。"
    "不超过 220 字，不用小标题，不评价讨论谁对谁错，不替 ta 做决定。"
    "不确定就直说「我猜是…」。用 ta 提问的语言回答。"
)


def aside_path(tid):
    return os.path.join(DISCUSSIONS_DIR, f"{tid}.aside.json")


def aside_load(tid):
    try:
        rows = json.load(open(aside_path(tid), encoding="utf-8"))
        return rows if isinstance(rows, list) else []
    except Exception:
        return []


def aside_save(tid, rows):
    os.makedirs(DISCUSSIONS_DIR, exist_ok=True)
    tmp = aside_path(tid) + ".tmp"
    json.dump(rows[-60:], open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
    P.replace_retry(tmp, aside_path(tid))


def aside_chat(issue):
    """Who answers a by-the-way question: the summary model (fast and cheap) when one is set,
    else the discussion leader's own CLI. Returns (chat(system, user) -> text, label)."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import summarize
    if not summarize.use_enabled("discuss"):
        return None, ""
    p = summarize.provider()
    if p:
        return (lambda system, user: summarize.chat(p, system, user, timeout=90, max_tokens=900, use="discuss")), f"{p['id']}:{p['model']}"
    kind, model = discussion_leader(issue)
    if kind in HEADLESS_KINDS:
        cwd = task_project_dir(issue) if issue.get("id") else HOME
        return (lambda system, user: leader_chat(kind, model, system, user, cwd, 150)), f"{kind}:{model or 'default'}"
    return None, ""


def aside_prompt(issue, comments, earlier, question, quote=""):
    thread = discussion_thread(issue, comments)
    if len(thread) > 9000:  # the idea and the most recent statements matter most
        thread = thread[:2500] + "\n……\n" + thread[-6500:]
    if L.lang() == "en":
        before = "\n\n".join(f"They asked: {r.get('q', '')}\nYou answered: {r.get('a', '')}" for r in earlier[-3:] if r.get("a"))
        return (f"[The discussion]\n{thread}\n\n" + (f"[What you just talked about]\n{before}\n\n" if before else "")
                + (f"[The words they marked]\n{quote.strip()[:600]}\n\n" if quote.strip() else "") + f"[What they ask now]\n{question.strip()}")
    before = "\n\n".join(f"ta 问：{r.get('q', '')}\n你答：{r.get('a', '')}" for r in earlier[-3:] if r.get("a"))
    return (f"【讨论内容】\n{thread}\n\n" + (f"【你们刚才聊过】\n{before}\n\n" if before else "")
            + (f"【ta 划出来的原话】\n{quote.strip()[:600]}\n\n" if quote.strip() else "") + f"【ta 现在问】\n{question.strip()}")


def cmd_discuss_aside(a):
    """顺便问：a question about the discussion answered on the side. Nothing is written to the
    task, so the members never see it and the discussion is not affected."""
    if a.clear:
        try:
            os.remove(aside_path(a.task))
        except OSError:
            pass
        return out({"task": a.task, "items": []}, a.json, lambda _: print(L.t("Cleared", "已清空")))
    rows = aside_load(a.task)
    question = (sys.stdin.read() if a.stdin else " ".join(a.question or [])).strip()
    if not question:
        return out({"task": a.task, "items": rows}, a.json, lambda d: print("\n\n".join(L.t(f"Q: {r['q']}\nA: {r.get('a') or r.get('error') or ''}", f"问：{r['q']}\n答：{r.get('a') or r.get('error') or ''}") for r in d["items"]) or L.t("Nothing asked yet", "还没问过")))
    issue = bd_json(["show", a.task, "--json"])
    if not issue.get("id"):
        raise SystemExit(L.t(f"No task {a.task}", f"没有任务 {a.task}"))
    chat, by = aside_chat(issue)
    if not chat:
        raise SystemExit(summary_off("discuss") or L.t("No model to use: pick a summary model in Settings, or give the discussion a lead", "没有可用的模型：设置里选一个总结模型，或给讨论指定领队"))
    row = {"id": f"{int(time.time() * 1000):x}", "q": question[:2000], "quote": (a.quote or "").strip()[:600], "at": time.time(), "by": by}
    try:
        row["a"] = (chat(L.t(ASIDE_SYSTEM_EN, ASIDE_SYSTEM), aside_prompt(issue, bd_comments(a.task), rows, question, a.quote or "")) or "").strip()
    except Exception as e:
        debug("discuss-aside", e)
        row["a"] = ""
        row["error"] = str(e)[:300]
    if not row["a"] and not row.get("error"):
        row["error"] = L.t("The model did not answer", "模型没有回答")
    rows = aside_load(a.task) + [row]  # reload: another window may have asked meanwhile
    aside_save(a.task, rows)
    out({"task": a.task, "items": rows, "asked": row["id"]}, a.json, lambda d: print(row["a"] or row["error"]))


def cmd_discuss_doc(a):
    r = discussion_doc(a.task)
    out(r, a.json, lambda x: print(x["doc"] + L.t(f"\n\nWritten into {x['task']}'s description ({x['by']}), file {x['path']}; to hand it to an agent: ", f"\n\n已写进 {x['task']} 的描述（{x['by']}），文件 {x['path']}；派人：") + f"dispatch agent start {(x.get('leader') or {}).get('kind') or 'claude'}" + (f" --model {x['leader']['model']}" if (x.get("leader") or {}).get("model") else "") + f" --task {x['task']}"))


def discuss_parts(spec):
    """`claude:opus,codex` — or a list of those, one per repeated --with."""
    parts = []
    for k in ",".join(spec if isinstance(spec, list) else [spec or ""]).split(","):
        k = k.strip()
        if k:
            kind, _, model = k.partition(":")
            parts.append((kind, model))
    return parts


def cmd_discuss_judge(a):
    parts = discuss_parts(a.with_)
    if not parts:
        raise SystemExit(L.t("Name the members: --with codex,claude:opus,pi", "要指定成员：--with codex,claude:opus,pi"))
    state = discussion_state_load(a.task)
    members = state.get("members") or {}
    judged = set(state["judged"]) if isinstance(state.get("judged"), list) else set().union(*[set(m.get("seen") or []) for m in members.values()]) if members else set()
    disc = discussion_of(bd_comments(a.task))
    member_actors = {E.agent_of(k) for k, _ in parts}
    fresh = [c for c in disc if c.get("id") not in judged]
    if not any(c.get("author") in member_actors for c in disc):
        r = {"everyone": True, "picked": [f"{k}{'（' + m + '）' if m else ''}" for k, m in parts], "why": L.t("everyone: the members have not spoken yet (first round)", "全员：成员还没说过话（第一轮）"), "fresh": len(fresh)}
    else:
        j = discussion_judge(fresh, parts, member_actors)
        r = {**j, "picked": [f"{parts[i][0]}{'（' + parts[i][1] + '）' if parts[i][1] else ''}" for i in j["picked"]], "fresh": len(fresh)}
    out(r, a.json, lambda x: print(L.t(f"Next round calls: {', '.join(x['picked'])}\n{x['why']} ({x['fresh']} new statements since the last call)", f"下一轮叫：{'、'.join(x['picked'])}\n{x['why']}（上次裁判后有 {x['fresh']} 条新发言）")))


def cmd_discuss(a):
    a.timeout = timeout_to_ms(getattr(a, "timeout", None))  # seconds or milliseconds, never under a minute
    # Participants: `kind` or `kind:model`, repeated as often as wanted (claude:opus,claude:haiku,codex).
    parts = discuss_parts(a.with_)
    if not parts:
        raise SystemExit(L.t("Name the agents in the discussion: --with codex,claude or claude:opus,claude:haiku", "要指定参加讨论的 Agent：--with codex,claude 或 claude:opus,claude:haiku"))
    # The leader: one of the members (kind[:model]); it speaks last each round, and the
    # conclusion, the document and the hand-off default to it. Not in --with → added.
    leader_spec = (getattr(a, "leader", "") or "").strip()
    lead_kind, lead_model = "", ""
    if leader_spec:
        lead_kind, _, lead_model = leader_spec.partition(":")
        lead_kind, lead_model = lead_kind.strip().lower(), lead_model.strip()
        if (lead_kind, lead_model) not in parts:
            parts.append((lead_kind, lead_model))
    kinds = [k for k, _ in parts]
    me = whoami()
    topic = bool(getattr(a, "topic", ""))
    project = getattr(a, "project", "") or ""
    if topic:
        # A thought, not a task: make a task to hold the discussion (it can be split later).
        labels = [DISCUSSION_LABEL] + ([f"project:{project}"] if project else [])
        images = [os.path.abspath(os.path.expanduser(x)) for x in (getattr(a, "image", None) or []) if x]
        members = ', '.join(f'{k}:{m}' if m else k for k, m in parts)
        desc = a.topic.strip() + L.t((f"\n\nProject: {project}" if project else "") + (f"\n\nThe starter's question: {a.question}" if a.question else "") + ("\n\nImages (look at them with Read before you speak):\n" + "\n".join(images) if images else "") + f"\n\nMembers: {members}.",
                                     (f"\n\n项目：{project}" if project else "") + (f"\n\n发起人的问题：{a.question}" if a.question else "") + ("\n\n附图（发言前用 Read 工具看一遍）：\n" + "\n".join(images) if images else "") + f"\n\n参加：{members}。") \
            + (f"\n领队：{lead_kind}{':' + lead_model if lead_model else ''}\n" if lead_kind else "") \
            + L.t("This is a discussion; the conclusion is in the comments. To act on it, split it into sub-tasks with dispatch split.", "这是一次讨论，结论在评论里；要做就用 dispatch split 拆成子任务。")
        issue = bd_json(["create", "【讨论】" + a.topic.strip()[:70], "-t", "task", "-p", "3", "-l", ",".join(labels), "--description", desc, "--json"])
        if not issue.get("id"):
            raise SystemExit(L.t("Could not make the discussion task", "建不了讨论任务"))
        a.task = issue["id"]
        if getattr(a, "create_only", False):
            # The app creates first so it can watch the comments land, then runs the rounds on the id.
            return out({"task": a.task, "title": issue.get("title", "")}, a.json, lambda x: print(L.t(f"{x['task']} made: dispatch discuss {x['task']} --with … starts the discussion", f"{x['task']} 已建：dispatch discuss {x['task']} --with … 开始讨论")))
    else:
        issue = bd_json(["show", a.task, "--json"])
        if not issue.get("id"):
            raise SystemExit(L.t(f"No task {a.task}", f"没有任务 {a.task}"))
        topic = DISCUSSION_LABEL in (issue.get("labels") or [])
        project = project or next((l.split(":", 1)[1] for l in issue.get("labels") or [] if l.startswith("project:")), "")
        if not lead_kind:
            lead_kind, lead_model = discussion_leader(issue)
            if lead_kind and (lead_kind, lead_model) not in parts:
                parts.append((lead_kind, lead_model)); kinds = [k for k, _ in parts]
    leader_i = next((i for i, (k, m) in enumerate(parts) if (k, m) == (lead_kind, lead_model)), -1) if lead_kind else -1
    title = issue.get("title", "")
    cwd = a.cwd or (task_project_dir(issue) if project or not topic else HOME)
    existing = discussion_of(bd_comments(a.task))
    before = len(existing)
    # The opener line once per thread (or whenever there is a question to put): later rounds are
    # just the members answering what was said since, no ceremony in between.
    if a.question or not any((c.get("text") or "")[len(DISCUSS_TAG):].lstrip().startswith("发起") for c in existing):
        sh(["bd", "comments", "add", a.task, f"{DISCUSS_TAG}发起：{me} 邀请 {', '.join(kinds)} 讨论" + (f"：{a.question}" if a.question else "")], env={"BEADS_ACTOR": me})
    hostargs = ["--host", a.host] if a.host else []
    # Headless (claude -p / codex exec / pi -p) on this Mac is the normal path; --tui or a remote
    # host gives each member an in-app chat in that Mac's Dispatch (dispatch agent start).
    tui = bool(getattr(a, "tui", False) or a.host)
    # Each member keeps its session between rounds (~/tasks/.dispatch/discussions/<task>.json):
    # the next round resumes it and feeds only what was said since, so it remembers what it
    # said and the prompt stays small. --fresh starts everyone over with the whole thread.
    state = {} if getattr(a, "fresh", False) else discussion_state_load(a.task)
    state["task"] = a.task
    settings = settings_load() if not tui else {}
    members = state.setdefault("members", {})
    member_actors = {E.agent_of(k) for k, _ in parts}
    panes, missing, skipped, idle, timing, judges = {}, [], [], [], [], []
    import threading
    t_start = time.time()
    for r in range(1, max(1, a.rounds) + 1):
        now = bd_comments(a.task)
        disc_now = discussion_of(now)
        seen_before = {c.get("id") for c in disc_now}
        thread_text = discussion_thread(issue, now)
        images = discussion_images(issue.get("description"), *[c.get("text") for c in disc_now])
        results = {}
        # The cheap referee (no model call): once the members have spoken, a round only wakes
        # who was @'d or named-and-questioned in what was said since the last round; a fresh
        # line from a person that names nobody, or --everyone, calls the whole group.
        judge = None
        if not tui and not getattr(a, "everyone", False) and any(c.get("author") in member_actors for c in disc_now):
            judged = set(state["judged"]) if isinstance(state.get("judged"), list) else set().union(*[set(m.get("seen") or []) for m in members.values()]) if members else set()
            judge = discussion_judge([c for c in disc_now if c.get("id") not in judged], parts, member_actors)
            judges.append({"round": r, **judge, "picked": [f"{parts[i][0]}{'（' + parts[i][1] + '）' if parts[i][1] else ''}" for i in judge["picked"]]})
            if not a.json:
                print(L.t(f"· round {r} call: {judge['why']}", f"· 第 {r} 轮裁判：{judge['why']}"))
        chosen = set(judge["picked"]) if judge else set(range(len(parts)))
        live = None if tui else DiscussionLive(a.task, r, [(f"{kind}{'（' + model + '）' if model else ''}", kind) for i, (kind, model) in enumerate(parts) if i in chosen], judge=judges[-1] if judge else None)

        def run_tui(i, kind, model, who):
            prompt = discuss_prompt(a.task, title, r, a.question, topic=topic, project=project, who=who)
            if i not in panes:
                argv = self_cmd() + ["agent", "start", kind, "--cwd", cwd, "--label", L.t(f"Discussion \"{title[:20]}\" · {who}", f"讨论「{title[:20]}」· {who}"), "-p", prompt, "--auto", "--timeout", str(a.timeout), "--lines", "40", "--json"] + (["--model", model] if model else []) + hostargs
            else:
                argv = self_cmd() + ["agent", "ask", panes[i], prompt, "--timeout", str(a.timeout), "--lines", "40", "--json"] + hostargs
            t0 = time.time()
            code, o, err = sh(argv, timeout=a.timeout // 1000 + 240)
            try:
                res = json.loads(o[o.find("{"):])
            except Exception:
                res = {}
            results[i] = ("tui", who, code, res, (err or o).strip()[:300], round(time.time() - t0, 1))

        def run_headless(i, kind, model, who):
            claude = E.get(kind).headless_reads_pictures   # Claude Code reads pictures itself with Read; the others get them attached
            thinking = E.get(kind).discuss_thinking
            key = f"{kind}:{model}#{i}"
            mem = members.get(key) or {}
            system = discussion_system(who, kind, settings) + (L.t(" You lead this discussion: speak last each round; read what the others said first, then sum up where they differ and give your decision and the next step; no summing up for small talk.", "你是这场讨论的领队：每轮最后发言，先看完其他人说的，再归纳分歧、给出你的决定和下一步；闲聊时不用归纳。") if i == leader_i else "")
            on_event = (lambda status, text, step="", who=who: live.update(who, status, text, step)) if live else None
            resumed = bool(mem.get("session")) and mem.get("kind") == kind and (mem.get("model") or "") == (model or "")
            res = None
            if resumed:
                seen = set(mem.get("seen") or [])
                fresh_cs = [c for c in disc_now if c.get("id") not in seen]
                imgs = discussion_images(*[c.get("text") for c in fresh_cs])
                prompt = headless_followup_prompt(a.task, r, discussion_lines(fresh_cs), who, a.question, images=imgs if claude else ())
                res = headless_call(kind, model, prompt, cwd, a.timeout, images=() if claude else imgs, system=system, session=mem["session"], resume=True, on_event=on_event, thinking=thinking)
                if res["error"] and not res["text"]:
                    resumed = False   # the session is gone (or the CLI could not resume it): start over with the whole thread
            if not resumed:
                prompt = headless_prompt(a.task, title, r, thread_text, who, a.question, topic=topic, project=project, images=images if claude else ())
                res = headless_call(kind, model, prompt, cwd, a.timeout, images=() if claude else images, system=system, on_event=on_event, thinking=thinking)
            res["resumed"] = resumed
            # The statement lands on the board the moment it is ready, so the app shows the
            # quick members while the slow one is still thinking.
            own = ""
            if res["text"] and not is_skip(res["text"]):
                text = clean_statement(res["text"], who)
                code, o, err = sh(["bd", "comments", "add", a.task, f"{DISCUSS_TAG}{who}：{text}", "--json"], env={"BEADS_ACTOR": E.agent_of(kind)}, timeout=60)
                res["written"] = code == 0
                res["write_error"] = "" if code == 0 else (err or o).strip()[:120]
                res["chars"] = len(text)
                try:
                    own = json.loads(o[o.find("{"):]).get("id") or ""
                except Exception:
                    own = ""
                if live:
                    live.update(who, "posted" if code == 0 else "error", text if code == 0 else res["write_error"])
            if res.get("session"):
                members[key] = {"kind": kind, "model": model, "who": who, "session": res["session"], "rounds": (mem.get("rounds") or 0) + 1, "last_at": int(time.time()),
                                "seen": sorted(set(mem.get("seen") or []) | {c.get("id") for c in disc_now} | ({own} if own else set()))}
            results[i] = ("headless", who, res)

        # Everyone speaks at the same time — except the leader, who goes after the others so
        # it can read them (its prompt/session picks up their statements from the board).
        threads = []
        for i, (kind, model) in enumerate(parts):
            who = f"{kind}{'（' + model + '）' if model else ''}"
            if i not in chosen:
                results[i] = ("idle", who); continue
            use_tui = tui or kind not in HEADLESS_KINDS
            threads.append((i, use_tui, threading.Thread(target=run_tui if use_tui else run_headless, args=(i, kind, model, who), daemon=True)))
        for i, use_tui, t in threads:
            if i == leader_i:
                continue
            t.start()
            if use_tui:
                time.sleep(1.5)  # stagger the starts a little
        for i, _, t in threads:
            if i != leader_i:
                t.join()
        if leader_i in chosen:
            now = bd_comments(a.task)
            disc_now = discussion_of(now)
            thread_text = discussion_thread(issue, now)
            images = discussion_images(issue.get("description"), *[c.get("text") for c in disc_now])
            t = next(t for i, _, t in threads if i == leader_i)
            t.start(); t.join()
        if not tui:
            state["judged"] = sorted(x for x in seen_before if x)   # next round's referee looks at what was said from here on
            discussion_state_save(a.task, state)
        if live:
            live.finish()
        after = [c for c in discussion_of(bd_comments(a.task)) if c.get("id") not in seen_before]
        for i, (kind, model) in enumerate(parts):
            row = results.get(i)
            actor = E.agent_of(kind)
            if not row:
                missing.append({"who": kind, "round": r, "reason": L.t("no result", "没有结果")}); continue
            if row[0] == "idle":
                idle.append({"who": row[1], "round": r})
                if not a.json:
                    print(L.t(f"· round {r}: {row[1]} was not named, not called", f"· 第 {r} 轮 {row[1]} 没被点名，不叫"))
                continue
            if row[0] == "headless":
                _, who, res = row
                timing.append({"who": who, "round": r, "secs": res["secs"], "resumed": res.get("resumed", False), "prompt_chars": res.get("prompt_chars", 0), "usage": res.get("usage") or {}})
                if res["error"] and not res["text"]:
                    print(L.t(f"⚠ {who} did not get to speak in round {r}: {res['error']}", f"⚠ {who} 第 {r} 轮没说上话：{res['error']}"), file=sys.stderr)
                    missing.append({"who": who, "round": r, "reason": res["error"][:160]}); continue
                if is_skip(res["text"]):
                    skipped.append({"who": who, "round": r})
                    if not a.json:
                        print(L.t(f"· round {r}: {who} passes ({res['secs']}s)", f"· 第 {r} 轮 {who} 这轮不说（{res['secs']}s）"))
                    continue
                if not res.get("written"):
                    missing.append({"who": who, "round": r, "reason": L.t("the statement could not be written to the board: ", "发言写不进板：") + res.get("write_error", "")}); continue
                if not a.json:
                    u = res.get("usage") or {}
                    print(L.t(f"· round {r}: {who} said {res.get('chars', 0)} characters ({res['secs']}s{', resumed session' if res.get('resumed') else ''}, prompt {res.get('prompt_chars', 0)} characters" + (f", input {u.get('input', 0)} + cache {u.get('cached', 0)} tokens" if u else "") + ")",
                          f"· 第 {r} 轮 {who} 说了 {res.get('chars', 0)} 字（{res['secs']}s{'，续接会话' if res.get('resumed') else ''}，提示 {res.get('prompt_chars', 0)} 字" + (f"，输入 {u.get('input', 0)}+缓存 {u.get('cached', 0)} token" if u else "") + "）"))
                continue
            _, who, code, res, errtxt, secs = row
            timing.append({"who": who, "round": r, "secs": secs})
            if code != 0 or not res:
                print(L.t(f"⚠ {who} did not start in round {r}: {errtxt}", f"⚠ {who} 第 {r} 轮没跑起来：{errtxt}"), file=sys.stderr)
                missing.append({"who": who, "round": r, "reason": errtxt[:160] or L.t("did not start", "没跑起来")})
                continue
            panes.setdefault(i, res.get("pane_id"))
            if a.host and not any(c.get("author") == actor for c in after):
                # It wrote on that Mac's board: the statement arrives here with the next board sync (every 2 minutes).
                if not a.json:
                    print(L.t(f"· {who}'s statement is on {a.host}'s board and syncs over within minutes", f"· {who} 的发言写在 {a.host} 的任务板上，几分钟内同步过来"))
            elif not any(c.get("author") == actor for c in after):
                missing.append({"who": who, "round": r, "reason": L.t("finished but left no statement (maybe stuck on a permission or sign-in dialog, or it chose not to speak)", "跑完了但没留下发言（可能被权限或登录对话框卡住，或它决定不说）")})
            if not a.json:
                print(L.t(f"· round {r}: {who} ({res.get('pane_id')}) {res.get('status')} ({secs}s)", f"· 第 {r} 轮 {who}（{res.get('pane_id')}）{res.get('status')}（{secs}s）") + (f" · {res.get('warning')}" if res.get("warning") else ""))
    comments = discussion_of(bd_comments(a.task))
    new = comments[before:]
    # A quiet round: nobody had anything new (all skipped, or only one-line acknowledgements).
    # Two in a row and the app suggests wrapping up; the conclusion itself is written on demand
    # (--conclude here, discuss-conclude, or 整理成文档), one block, replaced each time.
    spoke = [c for c in new if not (c.get("text") or "")[len(DISCUSS_TAG):].lstrip().startswith("发起")]
    quiet = not tui and (not spoke or all(len((c.get("text") or "")) < len(DISCUSS_TAG) + 60 for c in spoke))
    state["quiet_rounds"] = (state.get("quiet_rounds") or 0) + 1 if quiet else 0
    if not tui:
        discussion_state_save(a.task, state)
    conclusion = discussion_conclude(a.task, title, comments, issue, leader=(lead_kind, lead_model)) if getattr(a, "conclude", False) and spoke else ""
    if a.close:
        for pane in panes.values():
            if pane:
                sh(self_cmd() + ["agent", "close", pane] + hostargs, timeout=60)
    if missing:
        for m in missing:
            sh(["bd", "comments", "add", a.task, L.t(f"[system] {m['who']} did not speak in round {m['round']}: {m['reason']}", f"【系统】{m['who']} 第 {m['round']} 轮没有发言：{m['reason']}")], env={"BEADS_ACTOR": "dispatch"})
    elapsed = round(time.time() - t_start, 1)
    result = {"task": a.task, "participants": [f"{k}{':' + m if m else ''}" for k, m in parts], "missing": missing, "skipped": skipped, "idle": idle, "judge": judges, "rounds": a.rounds, "mode": "tui" if tui else "headless",
              "panes": {f"{parts[i][0]}{':' + parts[i][1] if parts[i][1] else ''}#{i}": p for i, p in panes.items()}, "comments": new, "conclusion": conclusion, "topic": topic, "elapsed": elapsed, "timing": timing, "quiet_rounds": state.get("quiet_rounds", 0), "leader": {"kind": lead_kind, "model": lead_model} if lead_kind else None}
    try:
        import notify
        spoken = "；".join(re.sub(r"\s+", " ", (c.get("text") or "")[len(DISCUSS_TAG):]).strip() for c in spoke)
        notify.send(L.t(f"Discussion over: {title}", f"讨论结束：{title}"), (re.sub(r"\s+", " ", conclusion or "").strip() or spoken or L.t("No new statements this round", "本轮没有新发言"))[:100])
    except Exception:
        pass
    if a.json:
        print(json.dumps(result, ensure_ascii=False)); return
    print(L.t(f"\nDiscussion over: {len(new)} new statements (the opening included), {elapsed}s.", f"\n讨论结束：{len(new)} 条新发言（含发起），{elapsed}s。") + (L.t(f"\nConclusion: {conclusion}", f"\n结论：{conclusion}") if conclusion else "") + (L.t("\nTwo rounds without a new proposal; time to wrap up: dispatch discuss-doc ", "\n连续两轮没有新提议了，可以收尾：dispatch discuss-doc ") + a.task if state.get("quiet_rounds", 0) >= 2 else ""))
    for c in new:
        # Outside the f-string: Python < 3.12 forbids a backslash inside one.
        said = re.sub(r"\s+", " ", (c.get("text") or "")[len(DISCUSS_TAG):]).strip()[:400]
        print(f"· {c.get('author')}：{said}")
    if panes and not a.close:
        print(L.t("\nThe discussion's agents are still open: ", "\n讨论用的 Agent 还开着：") + "、".join(f"{k}={p}" for k, p in result["panes"].items()) + L.t(" (`dispatch agent close <pane>` closes one)", "（`dispatch agent close <pane>` 关掉）"))
    print(L.t(f"\nNext you decide the split: dispatch split {a.task} --to codex:\"sub-task title|description\" --to claude:\"…\"", f"\n下一步由你拍板拆分：dispatch split {a.task} --to codex:\"子任务标题|说明\" --to claude:\"…\""))


def cmd_split(a):
    parent = bd_json(["show", a.task, "--json"])
    if not parent.get("id"):
        raise SystemExit(L.t(f"No task {a.task}", f"没有任务 {a.task}"))
    try:
        specs = [split_spec(s) for s in (a.to or [])]
    except ValueError as e:
        raise SystemExit(str(e))
    if not specs:
        raise SystemExit(L.t("Give at least one --to kind:\"title|description\"", "要给至少一个 --to kind:\"标题|说明\""))
    me = whoami()
    proj = next((l.split(":", 1)[1] for l in parent.get("labels") or [] if l.startswith("project:")), "")
    cwd = a.cwd or task_project_dir(parent)
    hostargs = ["--host", a.host] if a.host else []
    made = []
    for kind, title, desc in specs:
        argv = ["create", title, "-t", "task", "-p", str(parent.get("priority", 2)), "--deps", f"parent-child:{a.task}", "--json"]
        labels = [f"discussed-in:{a.task}"] + ([f"project:{proj}"] if proj else [])
        argv += ["-l", ",".join(labels)]
        argv += ["--description", (desc + "\n\n" if desc else "") + L.t(f"Part of parent task {a.task} \"{parent.get('title', '')}\", split out by {me} from the discussion.\n\ndiscussed-in: {a.task} (`bd comments {a.task}` for who said what, `bd show {a.task}` for the conclusion and the document)", f"父任务 {a.task}「{parent.get('title', '')}」的分工，由 {me} 按讨论拆出。\n\ndiscussed-in: {a.task}（`bd comments {a.task}` 看谁说过什么，`bd show {a.task}` 看结论和文档）")]
        sub = bd_json(argv)
        sid = sub.get("id")
        if not sid:
            print(L.t(f"⚠ Could not make the sub-task: {title}", f"⚠ 建不出子任务：{title}"), file=sys.stderr)
            continue
        row = {"id": sid, "title": title, "kind": kind, "started": False}
        if not a.no_start:
            prompt = L.t(f"You take over sub-task {sid} \"{title}\" (parent task {a.task}). First read the discussion's conclusion with `bd show {sid}` and `bd comments {a.task}`, finish it to its acceptance items, record progress with dispatch log and close with dispatch done --reason.", f"你接手子任务 {sid}「{title}」（父任务 {a.task}）。先 `bd show {sid}` 和 `bd comments {a.task}` 读讨论结论，按验收项做完，进展 dispatch log，收尾 dispatch done --reason。")
            code, o, err = sh(self_cmd() + ["agent", "start", kind, "--cwd", cwd, "--task", sid, "--label", title[:24], "-p", prompt, "--no-wait", "--json"] + hostargs, timeout=240)
            row["started"] = code == 0
            try:
                row["pane_id"] = json.loads(o[o.find("{"):]).get("pane_id")
            except Exception:
                pass
            if code != 0:
                print(L.t(f"⚠ {kind} did not start ({sid} is made and can be handed out later): {(err or o).strip()[:200]}", f"⚠ {kind} 没起来（{sid} 已建好，可以稍后派）：{(err or o).strip()[:200]}"), file=sys.stderr)
        made.append(row)
    note = SPLIT_TAG + "；".join(f"{r['id']} {r['title']} → {r['kind']}" + ("" if r["started"] else L.t(" (not started)", "（未起）")) for r in made)
    sh(["bd", "comments", "add", a.task, note], env={"BEADS_ACTOR": me})
    if a.json:
        print(json.dumps({"task": a.task, "subtasks": made}, ensure_ascii=False)); return
    for r in made:
        print(f"{r['title']}（{r['id']}）  → {r['kind']}" + (f" · {r.get('pane_id')}" if r.get("pane_id") else "") + ("" if r["started"] else L.t("  (not handed out)", "  （未派出）")))
    print(L.t(f"Parent task {a.task} has the {SPLIT_TAG} record; each sub-task closes with its own dispatch done, and you close the parent last.", f"父任务 {a.task} 已留{SPLIT_TAG}记录；子任务做完各自 dispatch done，父任务最后由你收尾。"))


def starred_sessions(prefs, idx, proj, names, limit=5):
    """Conversations the user marked 追踪中 in this project: the long threads an agent
    should know exist before it starts a new one."""
    rows = []
    for path, e in idx.items():
        pref = prefs.get(f"{e.get('agent')}:{e.get('session_id')}") or {}
        if not pref.get("starred") or pref.get("archived"):
            continue
        p = pref.get("project_override") or project_of_cwd(e.get("cwd", ""), names) or os.path.basename((e.get("cwd") or "").rstrip("/"))
        if proj and p.lower() != proj.lower():
            continue
        rows.append({"agent": e.get("agent", ""), "session_id": e.get("session_id", ""), "title": (e.get("title") or "")[:70], "last_at": e.get("mtime", 0)})
    rows.sort(key=lambda r: -(r["last_at"] or 0))
    return rows[:limit]


def prime_file(actor, proj):
    """An immutable snapshot: another session must not overwrite an agent's spill file."""
    import uuid
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", f"{actor or 'agent'}-{proj or 'all'}")[:80]
    name = f"{stem}-{uuid.uuid4().hex[:12]}.md"
    return os.path.join(DISPATCH_DIR, "prime", name)


def peer_lines(nb, cwd, edits):
    """The sessions in this folder, one line each, and the one line about the files they changed."""
    rows = []
    for s_ in nb:
        mark = "◐" if s_.get("state") == "working" else "○"
        working = s_.get("state") == "working"
        when = ago(s_.get('last_at') or 0)
        when = L.t("active just now" if when == "just now" else f"active {when} ago", "刚刚活动" if when == "just now" else f"{when}前活动")
        rows.append(f"{mark} {s_['agent']} {s_['session_id'][:8]} · {L.t('working' if working else 'waiting for the person', '在跑' if working else '等用户')} · {when} · "
                    + L.t("folder", "目录") + f" …{(s_.get('cwd') or '')[-28:]}" + (f" · {s_['host_name']}" if s_.get("host") not in (None, "local") else ""))
    per_file = {}
    for s_ in nb:
        rec = edits.get(s_["session_id"]) or {}
        for f, ts in (rec.get("files") or {}).items():
            per_file.setdefault(f, []).append((s_["session_id"], s_["agent"], ts))
    conflict = ""
    if per_file:
        ordered = sorted(per_file.items(), key=lambda kv: (len({sid for sid, _, _ in kv[1]}) < 2, -max(t for _, _, t in kv[1])))
        parts = [f"{'⚠' if len({sid for sid, _, _ in eds}) > 1 else ''}{os.path.basename(f)}" for f, eds in ordered[:4]]
        more = '…' if len(ordered) > 4 else ''
        conflict = L.t(f"They changed lately: {', '.join(parts)}{more} (⚠ two sessions are changing it). Leave these files alone.",
                       f"它们最近改了：{'、'.join(parts)}{more}（⚠ 是两个会话都在改）。别碰这些文件。")
    return rows, conflict


def cmd_prime(a):
    """The session brief: what is going on right now, in the order that matters (prime_brief.py): this project's
    tasks in progress and waiting for the person, the sessions in this folder, what is due in 3 days, the
    preferences that apply, the newest pits, and one line that says where the rest is. The rules are not in it;
    they are in every agent's rules file (`dispatch rules sync`)."""
    import prime_brief as B
    import tasks_view
    cwd = a.cwd or os.getcwd()
    actor = os.environ.get("BEADS_ACTOR") or os.environ.get("DISPATCH_ACTOR") or ""
    self_id = os.environ.get("DISPATCH_SESSION_ID") or ""
    hook = {}
    if a.hook_json and not sys.stdin.isatty():
        try:
            hook = json.loads(sys.stdin.read() or "{}")
            self_id = hook.get("session_id") or hook.get("sessionId") or ""
            cwd = a.cwd or hook.get("cwd") or cwd
        except Exception:
            hook = {}
    if getattr(a, "source", "") and not hook:
        # OpenCode's plugin after a compaction (`prime --opencode --source compact`): the same
        # handoff section a SessionStart hook with source=compact gets.
        hook = {"source": a.source, "session_id": self_id, "cwd": cwd}
    if a.hook_json and str(self_id).startswith("ses_"):
        # an OpenCode session (ses_…) running Claude Code's hooks through an OpenCode plugin such as
        # oh-my-openagent: OpenCode gets its brief from Dispatch's own OpenCode plugin (`prime --opencode`)
        print("{}")
        return
    real = bool(a.hook_json or getattr(a, "opencode", False))  # a session is starting, not someone reading it in a terminal
    if P.IS_WIN:
        cwd = P.from_msys(cwd)  # Git Bash hands over /c/Users/x
    # One `bd list` serves both the project names and the task digest below.
    code, o, err = sh(["bd", "list", "--all", "--json"])
    tasks = []
    try:
        tasks = json.loads(o[o.find("["):]) if code == 0 else []
    except Exception:
        tasks = []
    names = project_names(tasks)
    proj = project_of_cwd(cwd, names)
    identity = "# Dispatch · " + (L.t(f"project {proj}", f"当前项目 {proj}") if proj else L.t("no project matches this folder", "没有对上项目")) + (L.t(f" · you are {actor}", f" · 你是 {actor}") if actor else "")
    sections = []
    # Restored context comes first, so an over-budget brief cannot hide the handoff.
    try:
        import handoff
        restored = handoff.prime_section(self_id, hook, tasks)
        if restored:
            sections.append((L.t("handoff", "交接"), restored))
    except Exception as e:
        debug("prime handoff", e)
    # Worker notifications that came in while nobody was awake: a dispatcher must see them before the board.
    # They are marked read once the brief has gone out: the session-start hook stops a slow brief (hook.py).
    read_later = []
    try:
        import workers
        sections.append((L.t("notifications", "通知"), workers.notification_section(_THIS, self_id, read_later=read_later)))
    except Exception as e:
        debug("prime notifications", e)
    # Git cannot sign a commit here yet: the agent asks the person instead of making a name up (task-pog4t)
    try:
        line = _mod("git_identity").brief_line(cwd)
        if line:
            sections.append((L.t("commit identity", "提交身份"), [line]))
    except Exception as e:
        debug("prime git identity", e)
    # The key store lost keys since its last write: said before anyone writes over it (10-08, task-s9u1g)
    try:
        line = env_brief_line()
        if line:
            sections.append((L.t("keys", "密钥"), [line]))
    except Exception as e:
        debug("prime keys", e)
    # 1. tasks
    board_head = []
    if code != 0 and no_board(code, err):
        board_head = [L.t("(" + (missing_tool_hint("bd") if code == 127 else NO_BOARD_HINT) + " Until then begin / log / done cannot record tasks; everything else works.)",
                          "（" + (missing_tool_hint("bd") if code == 127 else NO_BOARD_HINT).rstrip("。.") + "。在那之前 begin / log / done 记不了任务，其余照常。）")]
    sections.append((L.t("board", "板上"), board_head + B.board(tasks, proj, tasks_view.status_of, actor, lambda t: human_note(bd_comments(t["id"]), actor))))
    import workers
    sections.append((L.t("dispatching", "调度"), workers.prime_section(_THIS, self_id)))
    # 2. who else is here, and the conversations the person follows
    try:
        from activity import session_preferences
        def tracked_row(r):
            w = ago(r['last_at'])
            title = B.clip(r['title'], 40)
            return L.t(f"★ {r['agent']} \"{title}\" ({r['session_id'][:8]}) · {w if w == 'just now' else w + ' ago'} · `dispatch session {r['session_id'][:8]}`",
                       f"★ {r['agent']} 「{title}」（{r['session_id'][:8]}）· {'刚刚' if w == 'just now' else w + '前'} · `dispatch session {r['session_id'][:8]}`")
        tracked = [tracked_row(r) for r in starred_sessions(session_preferences(DISPATCH_DIR), load_index(), proj, names)]
    except Exception as e:
        tracked = []
        debug("prime tracked sessions", e)
    nb = neighbours(cwd, self_id, local_only=True)
    rows, conflict = peer_lines(nb, cwd, session_edit_map()) if nb else ([], "")
    sections.append((L.t("this folder", "同目录"), B.peers(rows, conflict, tracked)))
    # 3. Fill this slot after all other sections are ready, so only reminders that
    # survive the final budget are marked delivered, under the receipt lock.
    due_slot = len(sections)
    sections.append((L.t("due", "到期"), []))
    # 4. preferences
    try:
        pm = _mod("prefs")
        pm.D = _THIS
        sections.append((L.t("preferences", "偏好"), pm.prime_section(proj, cwd=cwd, limit=B.PREF_ITEMS, max_chars=B.PREF_CHARS, max_bytes=B.PREFS_BYTES)))
    except Exception as e:
        debug("prime prefs", e)
    # 5. pits
    try:
        pit_items = [it for it in wiki_all() if it["kind"] == "pit" and
                     (not it.get("project") or (proj and it["project"].lower() == proj.lower()))]
        dates = wiki_dates([it["key"] for it in pit_items])
        pit_items.sort(key=lambda it: (dates.get(it["key"], ""), it["key"]))
        sections.append((L.t("pitfalls", "坑"), B.pits(pit_items, proj, wiki_line)))
    except Exception as e:
        debug("prime pits", e)

    def save(full):
        p = prime_file(actor, proj)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        from instructions import atomic_write
        atomic_write(p, full + "\n")
        return p.replace(HOME, "~", 1)

    def render(due_lines):
        sections[due_slot] = (L.t("due", "到期"), B.due(due_lines))
        return B.build(identity, sections, save=save)[0]

    try:
        pm = _mod("profile")
        text = pm.profile_prime_brief(pm.profile_text(), render, mark=real)
    except Exception as e:
        debug("prime due", e)
        text = render([])
    if a.hook_json:
        def output(value):
            return json.dumps({"continue": True, "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": value}}, ensure_ascii=False)
        if len(output(text)) >= B.CLAUDE_CHARS or len(output(text).encode("utf-8")) >= B.CODEX_BYTES:
            text = L.t(f"The whole brief is in {save(text)}. Read that file in full before you go on; it has the complete brief and the handoff.",
                       f"全文在 {save(text)}。请先完整读取该文件，再继续；其中包含完整 prime 和交接。")
        print(output(text))
    else:
        print(text)
    sys.stdout.flush()
    if real and not hook.get("agent_id") and read_later:
        import wake
        wake.mark_read(_THIS, read_later, "prime")


# ---------------------------------------------------------------- main

REMOTE_BUNDLED_CLI = "/Applications/Dispatch.app/Contents/Resources/cli/dispatch.py"


def remote_cli(h):
    """Default remote entry: the CLI installed at ~/.local/bin/dispatch there (the one kept current since
    the Tauri Dispatch.app retired, 2026-09-27); the copy inside an old Dispatch.app only when that is
    missing or broken (a dangling link), then `dispatch` on PATH. Explicit custom CLI commands remain
    overrides."""
    import shlex
    configured = h.get("dispatch") or "dispatch"
    if configured not in ("dispatch", "$HOME/.local/bin/dispatch", "~/.local/bin/dispatch"):
        return configured
    bundle = shlex.quote(REMOTE_BUNDLED_CLI)
    script = ('export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; '
              'if [ -x "$HOME/.local/bin/dispatch" ]; then exec "$HOME/.local/bin/dispatch" "$@"; '
              f'elif [ -f {bundle} ]; then exec python3 {bundle} "$@"; '
              'else exec dispatch "$@"; fi')
    return "/bin/bash -c " + shlex.quote(script) + " dispatch"


def migration_command(args):
    return bool(args) and (args[0] == "move" or (args[0] == "project" and "--move-to" in args))


def command_timeout(args, default=60):
    # Transfers and per-session resumes already have individual timeouts. A fixed outer
    # deadline kills the SSH client while the remote migration can still be running.
    return (180 if "--dry-run" in args else None) if migration_command(args) else default


def proxy_to_host(argv):
    """`dispatch --host mini <subcommand …>`: run the same command on another Mac from hosts.json
    over ssh. stdin, stdout and the exit code pass straight through, so every subcommand
    (rules write, env set, skills enable…) works remotely without knowing about hosts."""
    import shlex
    if len(argv) < 2 or argv[0] != "--host":
        return None
    hid, rest = argv[1], argv[2:]
    if hid in ("local", "", local_host_name()):
        return rest  # caller continues locally
    h = host_entry(hid)
    if not h:
        print(L.t(f"No Mac called {hid} in hosts.json (this Mac is local)", f"hosts.json 里没有叫 {hid} 的机器（本机用 local）"), file=sys.stderr)
        sys.exit(2)
    # the other Mac sees an ssh login, which reads as the person: say so when an Agent asked here
    caller = "DISPATCH_CALLER=agent " if is_agent_caller() else ""
    cmd = f"env {caller}{remote_beads(h)} {remote_cli(h)} " + " ".join(shlex.quote(x) for x in rest)
    timeout = command_timeout(rest)
    try:
        r = subprocess.run(["ssh", "-o", "ConnectTimeout=4", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "StrictHostKeyChecking=accept-new", h["ssh"], cmd],
                           stdin=(subprocess.DEVNULL if sys.stdin.isatty() else sys.stdin), stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        print(L.t(f"{h['name']} did not answer within {timeout} seconds" + (" (the move's pre-check did not finish; nothing was moved)" if migration_command(rest) else ""), f"{h['name']} 没在 {timeout} 秒内响应" + ("（迁移预检尚未完成，没有开始迁移）" if migration_command(rest) else "")), file=sys.stderr)
        sys.exit(124)
    err = (r.stderr or "").strip()
    if r.returncode == 255:
        if migration_command(rest) and "--dry-run" not in rest:
            print(L.t("The connection dropped during the move and the result is not confirmed; check the sessions and project owner on the other Mac before moving again.", "迁移连接中断，结果尚未确认；请先查看目标机器的会话和项目归属，避免重复迁移。"), file=sys.stderr)
        if "Permission denied" in err:
            print(L.t(f"{h['name']} refused the ssh sign-in ({h['ssh']}): it does not have this Mac's public key. Add ~/.ssh/id_*.pub to its ~/.ssh/authorized_keys, or use an alias from ~/.ssh/config in hosts.json.", f"{h['name']} 拒绝了 ssh 登录（{h['ssh']}）：那台机器没有本机的公钥。把 ~/.ssh/id_*.pub 加进它的 ~/.ssh/authorized_keys，或在 hosts.json 里改成 ~/.ssh/config 里的别名。"), file=sys.stderr)
        else:
            print(L.t(f"Cannot reach {h['name']} ({h['ssh']}): Tailscale is off, or that Mac is offline. {err[:120]}", f"连不上 {h['name']}（{h['ssh']}）：Tailscale 没开，或那台机器离线。{err[:120]}"), file=sys.stderr)
    elif err:
        print(err, file=sys.stderr)
    sys.exit(r.returncode)


def main():
    P.utf8_stdio()
    try:
        _main()
    except P.Unsupported as e:
        if "--json" in sys.argv[1:]:
            print(json.dumps({"ok": False, "unsupported": True, "message": str(e)}, ensure_ascii=False))
            sys.exit(0)
        print(str(e), file=sys.stderr)
        sys.exit(2)


# Commands that only make sense between Macs or with macOS services; on Windows they answer with the
# standard "Windows 版暂不支持…" message (JSON: {"ok": false, "unsupported": true}).
WIN_UNSUPPORTED = L.t({"moves": "Records of sessions moved between Macs", "project-moves": "Moving projects",
                       "notify-watch": "Watching for phone notifications (the phone's resident service)"},
                      {"moves": "多机会话迁移记录", "project-moves": "项目迁移",
                       "notify-watch": "手机推送监视（手机端常驻服务）"})


def win_empty_listing(a):
    """The read-only listings among WIN_UNSUPPORTED: nothing is ever moved on Windows, so the answer is
    an empty list, the shape every caller (the app polls `project-moves --json`) expects."""
    return a.cmd == "project-moves" or (a.cmd == "moves" and a.op == "list")


# `dispatch <cmd> …` handed whole to a sibling module's main(argv): the full IDE and its Agent tools.
DELEGATED = {"ide": "ide", "checkpoint": "checkpoint", "code-search": "code_search", "browser": "browser", "computer": "computer", "attribution": "attribution", "point-talk": "point_talk"}


def parse_args_compat(p, sub, argv=None):
    """parse_args, the same on every Python. Before 3.12 argparse gives an optional positional (nargs ?/*)
    its value only from words before the first option, so `wiki add --kind pit "text" --fix "..."` failed
    with "unrecognized arguments: text" on the Command Line Tools' Python 3.9 of a new Mac. Words left
    over like that go to the subcommand's optional positionals that are still empty, in order."""
    a, rest = p.parse_known_args(argv)
    if not rest:
        return a
    sp = sub.choices.get(getattr(a, "cmd", None))
    slots = [act for act in (sp._actions if sp is not None else [])
             if not act.option_strings and act.nargs in ("?", "*") and act.dest not in ("help",)]
    filled, left = set(), []
    for tok in rest:
        if tok.startswith("-") and tok != "-":
            left.append(tok)
            continue
        for act in slots:
            val = act.type(tok) if callable(act.type) else tok
            if act.choices is not None and val not in act.choices:
                continue
            cur = getattr(a, act.dest, None)
            if act.nargs == "*":
                setattr(a, act.dest, list(cur or []) + [val])
                break
            if act.dest not in filled and cur in (None, act.default, ""):
                setattr(a, act.dest, val)
                filled.add(act.dest)
                break
        else:
            left.append(tok)
    if left:
        p.error("unrecognized arguments: " + " ".join(left))
    return a


def _main():
    rest = proxy_to_host(sys.argv[1:])
    if rest is not None:
        sys.argv = [sys.argv[0]] + rest
    if len(sys.argv) > 1 and sys.argv[1] in DELEGATED:
        # these modules parse their own arguments (so their owners never touch this file)
        sys.exit(_mod(DELEGATED[sys.argv[1]]).main(sys.argv[2:]) or 0)
    p, sub = _parser()
    _run_parsed(p, sub)


_PARSER = None
_KEEP_PARSER = False


def keep_parser(on):
    """While on, the command line is built once and used for every command run in this process (`dispatch
    settings-page` runs a dozen); otherwise each run builds its own, so a test's stand-in for a command is the one called."""
    global _PARSER, _KEEP_PARSER
    _KEEP_PARSER = bool(on)
    if not on:
        _PARSER = None


def _parser():
    global _PARSER
    if _PARSER is not None:
        return _PARSER
    p = argparse.ArgumentParser(prog="dispatch", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    import workers
    workers.add_parser(sub, _THIS)
    import mobile
    mobile.add_parser(sub, _THIS)
    import turbo
    turbo.add_parser(sub, _THIS)
    s = sub.add_parser('task', help='tasks of a project or session (list / show / graph), their plan and deliverables (plan / deliver / follow; tasks_view.py), recoverable removal (trash / restore)'); s.add_argument('op', choices=['list', 'show', 'graph', 'plan', 'deliver', 'follow', 'trash', 'restore', 'own', 'conflicts', 'thing', 'things']); s.add_argument('task', nargs='?', default='', help='the task; things: list (default) or migrate'); s.add_argument('prev', nargs='?', default='', help='follow: the task this one carries on; thing: the name of its thing')
    s.add_argument('--project', '-P', default=''); s.add_argument('--folder', default='', help='list/graph: the project of this folder (a worktree counts as its repository)'); s.add_argument('--session', default='', help='list/graph: one session (id, or the Agents window resource)'); s.add_argument('--status', choices=['all', 'open', 'done'], default='all'); s.add_argument('--limit', type=int, default=200); s.add_argument('--days', type=int, default=None, help='list/graph: the tasks touched in the last N days, plus any still in progress or waiting (default 30; 0 = all)'); s.add_argument('--archived', action='store_true', help='list: the tasks before that window instead, newest first (the project page\'s Archive)'); s.add_argument('--brief', action='store_true', help='show: without the commits (a title lookup)')
    s.add_argument('--set', action='append', help='plan: one short direction (repeat, replaces the plan)'); s.add_argument('--from-json', dest='from_json', help="plan: Claude's TodoWrite todos or Codex's update_plan as JSON (file, or - for stdin)"); s.add_argument('--hook', action='store_true', help="plan: as the PostToolUse hook for Claude Code's TodoWrite or Codex's update_plan (hook JSON on stdin; the list becomes the plan of that session's current task)"); s.add_argument('--done', default='', help='plan: numbers of the steps done (1,2)'); s.add_argument('--active', default='', help='plan: the step being done now'); s.add_argument('--follows', default='', help='plan: this task carries on that one')
    s.add_argument('--url'); s.add_argument('--file'); s.add_argument('--draft'); s.add_argument('--commit', nargs='?', const='', help='deliver: a commit (default HEAD of this folder)'); s.add_argument('--label', default='')
    s.add_argument('--show', action='store_true', help='deliver: also open it in the right panel of the running Dispatch Agent (dispatch ide show)'); s.add_argument('--add', default='', help='own: paths or globs this task owns, comma separated'); s.add_argument('--rm', default='', help='own: territory to give up, comma separated')
    s.add_argument('--rules', default='', help='things migrate: title rules, JSON {"rules": [[thing, regex], …], "override": {task: thing}} (default: the session rule)'); s.add_argument('--dry-run', dest='dry_run', action='store_true', help='things migrate: show what each task would get, write nothing')
    s.add_argument('--json', action='store_true'); s.set_defaults(fn=lambda a: cmd_task(a) if a.op in ('trash', 'restore') else sys.exit(_mod('tasks_view').run(a, _THIS) or 0))
    s = sub.add_parser('build', help='build Dispatch IDE (ide/) for a commit as a service (builds.py): start (queued on the mini, or this Mac; --dev: a development build in seconds), list, queue (what builds and waits, at a glance), show, log, get (to this Mac), sign (Developer ID + notarize), install'); s.add_argument('op', choices=['start', 'list', 'queue', 'show', 'log', 'get', 'sign', 'install', '_watch', '_installwait']); s.add_argument('target', nargs='?', default='', help='start: commit or branch (default main; HEAD and branches resolve in this folder when it is a checkout of this repository); the others: the build name or its start')
    s.add_argument('--kanban', default='', help=argparse.SUPPRESS); s.add_argument('--dev', action='store_true', help='start: a development build: only what changed since the previous one is compiled, in a tree that stays on the build machine (seconds, not minutes); its scenarios run there; nothing to get, sign or install'); s.add_argument('--task', default='', help='start: put the result on this task as a deliverable (kind build)'); s.add_argument('--e2e', action='extend', nargs='+', default=[], metavar='SCENARIO', help='start: end-to-end scenario files to run against the build (dispatch ide e2e run)'); s.add_argument('--on', choices=['mini', 'local'], help='start: where to build (default mini; falls back to this Mac when the mini is not reachable); the others: which machine the build is on')
    s.add_argument('--min', action='store_true', help='start: the minified build'); s.add_argument('--rebuild', action='store_true', help='start: build again even when the pair is built'); s.add_argument('--follow', action='store_true', help='log: until the build ends'); s.add_argument('--tail', type=int, default=0, help='log: only the last N lines')
    s.add_argument('--no-notarize', dest='no_notarize', action='store_true', help='sign: Developer ID only'); s.add_argument('--force', action='store_true', help='sign: sign again'); s.add_argument('--no-open', dest='no_open', action='store_true', help='install: do not open it'); s.add_argument('--unsigned', action='store_true', help='install: allow the ad-hoc build'); s.add_argument('--when-quit', dest='when_quit', action='store_true', help='install: when Dispatch IDE is open, install it by itself once the person quits it (and open it again)')
    s.add_argument('--json', action='store_true'); s.set_defaults(fn=lambda a: sys.exit(_mod('builds').run(a, _THIS) or 0))
    s = sub.add_parser('busy', help='is this Mac too busy (memory or processors) and with how many agents and builds: the bottom bar\'s Busy block (busy.py)'); s.add_argument('--json', action='store_true'); s.set_defaults(fn=lambda a: sys.exit(_mod('busy').run(a, _THIS) or 0))
    s = sub.add_parser('settings-page', help="everything the Agents window's Settings shows that is kept on this Mac, read in one process (settings_snapshot.py)"); s.add_argument('--json', action='store_true'); s.set_defaults(fn=lambda a: sys.exit(_mod('settings_snapshot').run(a, _THIS) or 0))
    s = sub.add_parser('me', help='who uses this Mac: the GitHub account whose picture the title bar shows (me.py)'); s.add_argument('--json', action='store_true'); s.set_defaults(fn=lambda a: sys.exit(_mod('me').run(a, _THIS) or 0))
    s = sub.add_parser("moves", help="sessions moved between Macs (dispatch move): which copy is the original"); s.add_argument("op", nargs="?", choices=["list", "mark", "confirm"], default="list"); s.add_argument("key", nargs="?", default=""); s.add_argument("--to", default=""); s.add_argument("--from", dest="from_", default=""); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_moves)
    s = sub.add_parser("sessions", help="live Agent sessions; `sessions history`: every session on this Mac, to look at and search (nothing is imported)"); s.add_argument("op", nargs="?", choices=["history"], help="history: the session history list"); s.add_argument("--local", action="store_true", help="this Mac only (what other Macs ask for)"); s.add_argument("--json", action="store_true"); _mod("session_history").add_arguments(s); s.set_defaults(fn=cmd_sessions)
    s = sub.add_parser("attachment", help="read a file linked in a conversation; --thumbs returns every image as a small thumbnail in one call"); s.add_argument("key"); s.add_argument("ref", nargs="?", default=""); s.add_argument("--thumbs", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_attachment)
    _mod("project_custom").add_parser(sub, _THIS)
    _mod("copy_ready").add_parser(sub)
    s = sub.add_parser("activity", help="incremental conversation activity and unread replies"); s.add_argument("--local", action="store_true"); s.add_argument("--events", action="store_true", help="include each session's event log (large; the session page asks for one session with --key)"); s.add_argument("--key", default="", help="only this session (agent:session_id or session id)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_activity)
    s = sub.add_parser("editing", help="files each active session changed in the last 30 min, aggregated per file, with conflicts"); s.add_argument("--dir", help="only sessions working in this directory (default: every directory)"); s.add_argument("--window", type=int, default=30, help="minutes back to look (default 30)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_editing)
    s = sub.add_parser("settings", help="shared settings (bd memory dispatch-settings): session_archive_days / task_archive_days"); s.add_argument("key", nargs="?"); s.add_argument("value", nargs="?"); s.add_argument("--json", action="store_true"); s.add_argument("--save", action="store_true", help="merge the JSON object of changed settings on stdin (the app's save); keys this build does not know are kept"); s.set_defaults(fn=cmd_settings)
    s = sub.add_parser("task-archive", help="archive closed tasks older than task_archive_days (default: the setting)"); s.add_argument("--days", type=int); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_task_archive)
    s = sub.add_parser("project", help="star / archive a project, or hand it to another Mac (shared across machines)"); s.add_argument("name"); s.add_argument("--star", action="store_true"); s.add_argument("--unstar", action="store_true"); s.add_argument("--archive", action="store_true"); s.add_argument("--unarchive", action="store_true"); s.add_argument("--background", action="store_true", help="--move-to: runs in the background and returns a task id at once; project-moves shows the progress"); s.add_argument("--job", help=argparse.SUPPRESS)
    s.add_argument("--dir", help="the project's home folder (a new project exists before any session; the sessions in this folder belong to it)"); s.add_argument("--create", action="store_true", help="--dir: make the folder when it does not exist"); s.add_argument("--git", action="store_true", help="--dir: git init when there is no repository in it"); s.add_argument("--forget-dir", action="store_true", help="forget the home folder set with --dir (no file is deleted)"); s.add_argument("--test-cmd", dest="test_cmd", help="record the project's test command (never run by itself)"); s.add_argument("--installed-probe", dest="installed_probe", help="record the command that tells the installed version (never run by itself)");
    s.add_argument("--move-to", help="hand the whole project (folder, Git, running sessions) to this Mac"); s.add_argument("--owner", help="only record which Mac the project belongs to (name; local = this Mac; none = clear)"); s.add_argument("--dry-run", action="store_true"); s.add_argument("--force", action="store_true"); s.add_argument("--keep-original", action="store_true"); s.add_argument("--open-session", choices=["claude", "claude-code", "codex", "pi", "none"], help="with --move-to and no running session here: which session to open over there (claude / codex / pi; none = none; default: the agent of the project's latest session)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_project)
    s = sub.add_parser("project-moves", help="progress of project moves in the background (running ones and those that ended within 24 hours)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_project_moves)
    s = sub.add_parser("projects", help="list starred / archived projects"); s.add_argument("--sidebar", action="store_true", help="include CLI session visibility and worktree grouping policy"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_projects)
    s = sub.add_parser("projects-view", help="Dispatch IDE's Projects page: each project's tasks, sessions, documents, state and last 14 days (--project for one); add <folder> registers one (git init when there is no repository; another folder of the same name gets its parent folder added), new <folder or name> makes one and registers it (a bare name goes into ~/Projects, git init plus one empty commit), clone <url> copies a project from a URL, defaults says where new projects go and whether git works, rename <project> --name <display name> changes what the window calls it (--key: its name itself, and its tasks, documents, preferences and knowledge move along; --dry-run counts them first), open <session> --on <Mac> opens another Mac's session in a terminal over ssh; --host <Mac> asks that Mac"); s.add_argument("op", nargs="?", default="list", choices=["list", "add", "new", "clone", "defaults", "rename", "open"]); s.add_argument("arg", nargs="?", default=""); s.add_argument("--project", default=""); s.add_argument("--name", default=""); s.add_argument("--parent", default="", help="new / clone: the folder to put it in (default ~/Projects)"); s.add_argument("--progress-file", default="", help="clone: write the progress (JSON) to this file; the window polls it"); s.add_argument("--on", default=""); s.add_argument("--host", default=""); s.add_argument("--days", type=int, default=14); s.add_argument("--local", action="store_true"); s.add_argument("--key", action="store_true", help="rename: the project's name itself, everything filed under it moves along"); s.add_argument("--dry-run", action="store_true", help="rename --key: say what would move, change nothing"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: sys.exit(_mod("projects_view").command(a, _THIS)))
    s = sub.add_parser("session-preferences", help="classify a conversation without changing its transcript"); s.add_argument("key"); s.add_argument("changes"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_session_preferences)
    s = sub.add_parser("session-delete", help="move a conversation's transcript to the Trash and drop it from every list"); s.add_argument("key", help="<agent>:<session id>"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_session_delete)
    s = sub.add_parser("seen", help="acknowledge exactly one observed reply; reply=unread drops the receipt"); s.add_argument("key"); s.add_argument("reply", help="reply id, or `unread` to mark the session unread again"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_seen)
    s = sub.add_parser("session-control", help="folder picker (browse), a folder's git branch (branch) and taking a session over into Dispatch (release)"); s.add_argument("op", choices=["browse", "branch", "release"]); s.set_defaults(fn=cmd_session_control)
    s = sub.add_parser("reply", help="reply to an exact Agent session through the running Dispatch (chatd); `commands` lists the slash commands it accepts"); s.add_argument("op", choices=["status", "send", "commands", "control"]); s.add_argument("key"); s.add_argument("--agent", required=True); s.add_argument("--request"); s.add_argument("--mode", choices=["queue", "interrupt"], default="queue", help="while the agent works: queue for its next turn, or Esc first (steer it now)"); s.add_argument("--image", action="append", default=[], help="send: a picture to attach (repeat for several); Claude Code gets them as attachments, others as paths in the text"); s.add_argument("--quote", action=_QuoteAction, dest="quote", default=[], help="send: a passage to quote in front of the message, as Dispatch IDE's Quote does (repeat for several, in order)"); s.add_argument("--quote-from", action=_QuoteFromAction, dest="quote", help="send: where the --quote before it is from, file:line (NOTES.md:9); without it the quote is from a reply"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_reply)
    s = sub.add_parser("save-image", help="store a pasted image (base64 JSON on stdin: {name, data}) and print its path"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_save_image)
    s = sub.add_parser("save-file", help="store an attachment (base64 JSON on stdin: {name, data}) under ~/tasks/.dispatch/files and print its path"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_save_file)
    s = sub.add_parser("commits", help="git commits that belong to a task (id in the message, or hashes in its close reason / comments)"); s.add_argument("task"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_commits)
    s = sub.add_parser("find", help="sessions that mention a task"); s.add_argument("task"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_find)
    s = sub.add_parser("index", help="refresh the transcript index (a first build reads every transcript with several helper processes and keeps index-progress.json up to date); --status: how far it is; --background: start it and return at once"); s.add_argument("--status", action="store_true", help="print the build's progress {state: none|running|done|interrupted, done, total, indexed, …} and do nothing else"); s.add_argument("--background", action="store_true", help="start the build in a process of its own unless one is running; print its progress"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_index)
    s = sub.add_parser("index-worker", help=argparse.SUPPRESS); s.add_argument("--prefix", default="task"); s.set_defaults(fn=cmd_index_worker)
    s = sub.add_parser("folders", help="directories agents have worked in"); s.add_argument("--query", "-q"); s.add_argument("--cached", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_folders)
    s = sub.add_parser("list", help="browse all sessions"); s.add_argument("--local", action="store_true", help="this Mac only, skip other hosts"); s.add_argument("--agent", help="claude-code | codex | pi | zcode | opencode | hermes | gemini"); s.add_argument("--project"); s.add_argument("--cwd", help="only sessions in this directory"); s.add_argument("--query", "-q"); s.add_argument("--limit", type=int, default=200); s.add_argument("--cached", action="store_true", help="use the cached index without rescanning"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_list)
    s = sub.add_parser("session", help="timeline and file changes; session life <session> measures context lifetime"); s.add_argument("key", help="session id (prefix ok), task id, or life"); s.add_argument("target", nargs="?", default="", help="life: session to measure"); s.add_argument("--since", type=int, help="only the records after the offset returned last time (a live tail)"); s.add_argument("--brief", action="store_true", help="only the changed files and outputs, without the timeline"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_session)
    s = sub.add_parser("now", help="one line of what this session is doing right now, in plain words (the Now tab, a session row); no text: read it with the session's task, plan, deliveries and handoffs (now_line.py)")
    s.add_argument("text", nargs="*", help="what you are doing now, a few plain words")
    s.add_argument("--session", default="", help="the session (default: the agent's own, from its environment)")
    s.add_argument("--clear", action="store_true", help="take the line away")
    s.add_argument("--live", action="store_true", help="reading: also what the session's process shows this moment (the step it is on, its last reply); a few seconds")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=lambda a: sys.exit(_mod("now_line").run(a, _THIS) or 0))
    s = sub.add_parser("handoff", help="write/show durable context handoffs, linked to a task, Docs and the conversation boundary")
    s.add_argument("op", choices=["write", "show", "hook", "assess", "resume", "fail"], help="fail: the handoff turn was cancelled or failed (the Agents window says so), so session life shows failed"); s.add_argument("target", nargs="?", default="")
    s.add_argument("--reason", default="", help="fail: why, one line")
    s.add_argument("--cwd", default="", help="resume: working folder for prime")
    s.add_argument("--session", default=""); s.add_argument("--stdin", action="store_true", help="write: Markdown or structured JSON from stdin")
    s.add_argument("--from", dest="from_file", default="", help="write: Markdown or JSON file")
    s.add_argument("--request", default="", help="write: idempotent automatic handoff request id")
    s.add_argument("--agent", choices=[e.agent for e in E.runnable()], default="claude-code", help="hook: engine")
    s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: _mod("handoff").command(a))
    s = sub.add_parser("aside", help="ask about one change or one command (Haiku answers once, the main agent is not interrupted); --list shows what was asked, --save keeps it in the wiki"); s.add_argument("key", help="session id (a prefix is enough) or claude-code:<id>"); s.add_argument("--hunk", help="<file>:<which change>; the file can be a path inside the project, an absolute path or a file name"); s.add_argument("--tool", help="tool call id (a command)"); s.add_argument("-q", "--question", dest="q", help="the question"); s.add_argument("--list", action="store_true", help="list what was asked in this session"); s.add_argument("--save", metavar="ID", help="keep this answer in the wiki (as something that worked)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_aside)
    s = sub.add_parser("resume", help="print the resume command"); s.add_argument("key", help="session id (prefix ok) or task id"); s.add_argument("--copy", action="store_true"); s.add_argument("--on", default="", help="same id on several Macs (after dispatch move): which one — host id, name or local"); s.set_defaults(fn=cmd_resume)
    _mod("customizations").add_parsers(sub)
    _mod("agent_plugins").add_parsers(sub)
    s = sub.add_parser("skills", help="skill pool + per-agent mounts"); s.add_argument("op", choices=["list", "show", "path", "open", "enable", "disable", "improve", "write", "trash", "new", "import", "install", "find", "roots"]); s.add_argument("name", nargs="?", help="skill name; for import / install a repository (owner/repo or a GitHub URL); for find the words to search"); s.add_argument("--local", action="store_true", help="find: search only this Mac's skill pool"); s.add_argument("--file", help="a file in the skill's folder (default SKILL.md)"); s.add_argument("--reveal", action="store_true", help="open: show it in Finder"); s.add_argument("--agent", action="append", choices=[*AGENT_SKILL_DIRS, "all"], help="repeat for multiple engines; default: enable/disable all, new/import without mounts"); s.add_argument("--query", "-q"); s.add_argument("--days", type=int, default=14, help="improve: look back over the last N days"); s.add_argument("--copy", action="store_true", help="improve: copy the command that starts it to the clipboard"); s.add_argument("--description", help="new/import: one sentence on when to use it (goes into the frontmatter)"); s.add_argument("--trigger", help="new: when to use it"); s.add_argument("--constraint", help="new: key constraints"); s.add_argument("--path", help="import: a folder inside the repository"); s.add_argument("--as", dest="as_name", help="import: its name in the skill pool"); s.add_argument("--force", action="store_true", help="import: replace a skill of the same name (the old one moves to ~/.dispatch/backups/<date>/)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_skills)
    import dispatch_dir; dispatch_dir.add_parser(sub)
    _mod("backups").add_parser(sub)
    _mod("soul").add_parser(sub, cmd_soul)
    s = sub.add_parser("waiting", help="Waiting for you: approvals, decisions, unread replies and tasks only you can do (all projects); allow / deny <id> approves or denies, pick <id> <option> answers a question or picks a design direction, read <id> | --all marks read (unread undoes it), done <task> | --all closes an Only you can do task (reopen undoes it), snooze <task> puts it off (unsnooze undoes it), reply <task> gives the folder and opening line to start a session, seen records when the page was opened"); s.add_argument("op", nargs="?", default="list", choices=["list", "watch", "allow", "deny", "pick", "read", "unread", "done", "reopen", "snooze", "unsnooze", "reply", "seen"]); s.add_argument("id", nargs="?", help="the row's id (the id in list --json, such as ide:claude:/<id> or chat:claude-code:<id>; done / reopen / snooze / unsnooze / reply take task ids, several separated by commas; pick for a design direction takes task:<task id>)"); s.add_argument("option", nargs="?", help="pick: the option's id, text or 1..9 for an agent's question; A / B for a design direction"); s.add_argument("--reason", default="", help="pick a design direction: why (kept in FACTS.md with the choice)"); s.add_argument("--request", default="", help="allow / deny: answer only this request (tool call id or permission id); nothing happens when the session already answered or asks something new (used by Allow / Deny on phone notifications)"); s.add_argument("--until", default=None, help="snooze: tomorrow (default, 8 am), next-week (Monday 8 am) or a timestamp"); s.add_argument("--all", action="store_true", help="read: everything unread; done: every Only you can do task (only what this Mac lists)"); s.add_argument("--host", default="", help="list: ask another Mac for its own Waiting for you (its id, name or alias in hosts.json)"); s.add_argument("--local", action="store_true", help="list: this Mac only (the default; another Mac asking over ssh passes it)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_waiting)
    s = sub.add_parser("inbox", help="the bell: what the agents did while you looked elsewhere (finished / needs_you / stopped, decided by each agent's own end-of-turn signal); list, add, read / unread <id…> | --session S | --all, clear"); s.add_argument("op", nargs="?", default="list", choices=["list", "add", "read", "unread", "clear", "prefs", "sound"]); s.add_argument("ids", nargs="*", help="read / unread: event ids from list --json; sound: the sound to play (default: the one set)"); s.add_argument("--kind", default="", choices=["", "finished", "needs_you", "stopped"]); s.add_argument("--status", default="", help="add: the engine's own status instead of --kind (success, completed, interrupted, error, needs_input …)"); s.add_argument("--session", default="", help="add: the session the event belongs to (the Agents window's resource, or <agent>:<id>); read / unread: every event of it"); s.add_argument("--source", default="ide", choices=["ide", "chat", "terminal"]); s.add_argument("--agent", default=""); s.add_argument("--title", default=""); s.add_argument("--project", default=""); s.add_argument("--cwd", default=""); s.add_argument("--text", default="", help="add: the last words of the reply, or the question"); s.add_argument("--why", default="", help="add: why it stopped"); s.add_argument("--by-you", action="store_true", help="add: you stopped it yourself (filed already read, no sound)"); s.add_argument("--by", default="you", choices=["you", "working", "stopped", "newer"], help="read: who saw it"); s.add_argument("--all", action="store_true"); s.add_argument("--unread", action="store_true", help="list: only the unread ones"); s.add_argument("--user-data", default="", help="add / list: the Agents window's user data folder (finds a finished session's last words)"); s.add_argument("--limit", type=int, default=50); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: _mod("inbox").command(a, _THIS))
    s = sub.add_parser("sleep", help="idle agents sleep to free memory and wake when you open them: status (who is asleep), on, off, after <minutes> (default 30), now (the idle ones sleep at once)"); s.add_argument("op", nargs="?", default="status", choices=["status", "on", "off", "after", "now"]); s.add_argument("minutes", nargs="?", default=""); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: _mod("sleep").command(a, _THIS))
    s = sub.add_parser("need-you", help="something only the person can do (send an email, pay, sign in, demo in person…): recorded as an Only you can do task that the person ticks off on the project's board"); s.add_argument("title", help="one sentence on what the person has to do"); s.add_argument("--project", "-P"); s.add_argument("--desc", "-d", help="why, how, and where the material is"); s.add_argument("--why", help="one or two sentences of background, shown in the Only you can do details"); s.add_argument("--task", help="the task it comes from (a note is left on that task)"); s.add_argument("--priority", "-p", type=int, default=1); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_need_you)
    s = sub.add_parser("annotate", help="a \"where is what\" picture: numbered red boxes on a screenshot, one line per box below it (\"what · where · how\"), and a .json of the same name next to it (for the top of a delivery README; the Docs tab's viewfinder reads it)"); s.add_argument("src", help="the screenshot"); s.add_argument("-o", "--out", required=True, help="the output png"); s.add_argument("--box", action="append", help="x,y,w,h (screenshot pixels), repeatable, numbered in order"); s.add_argument("--note", action="append", help="one line per box, in the order of --box"); s.add_argument("--title", default="", help="the first line of the notes"); s.add_argument("--boxes-only", action="store_true", help="draw only the boxes and numbers, no notes below the picture (they go in the README's numbered list); the .json is still written"); s.add_argument("--where", action="store_true", help="also write 00-where.json in the same folder (each box on the original screenshot and its line); the delivery page's viewfinder reads it"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: _mod("annotate").cmd(a, out))
    s = sub.add_parser("flow", help="fixed multi-agent flows (flows.py): design <task> runs designer for two directions and waits for you to pick; pick <task> A records the choice and makes the implementation task; finish | show")
    s.add_argument("op", choices=["design", "pick", "finish", "show"]); s.add_argument("task", nargs="?", default=""); s.add_argument("option", nargs="?", default="", help="pick: the direction (A / B)")
    s.add_argument("--brief", default="", help="design: a file with more to say to the designer"); s.add_argument("--name", default="", help="design: the folder under design/ (default from the title, else the task id)"); s.add_argument("--project", default="", help="design: the project folder (default the git repository here)"); s.add_argument("--engine", default="claude", choices=["claude", "codex"]); s.add_argument("--timeout", type=int, default=3600000, help="design: ms to wait for the designer"); s.add_argument("--bg", action="store_true", help="design: run in the background; the Decide shows up in Waiting for you when it is done")
    s.add_argument("--dir", default="", help="finish: the folder the designer wrote to"); s.add_argument("--reason", default="", help="pick: why this one (goes into FACTS.md with the pick)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: sys.exit(_mod("flows").run(a, _THIS) or 0))
    s = sub.add_parser("deliver", help="the delivery page (deliver.py, skill delivery-page): index.html from a folder of screenshots + notes.md (+ 00-where.json, steps.json), registered in Docs, hung on the task, --show opens it in the right panel"); s.add_argument("task", nargs="?", default=""); s.add_argument("--from", dest="src", default="", help="the folder: screenshots, notes.md, 00-where.json, steps.json, prototype .html files"); s.add_argument("--kind", choices=["impl", "proposal"], default="impl", help="impl: what was built; proposal: diagnosis, two directions, Choose A / B"); s.add_argument("--title", default="", help="the page title in the user's words (default: notes.md's # line)"); s.add_argument("--model", default="", help='who made it, for the byline: "Opus 5.5 · high"'); s.add_argument("--show", action="store_true", help="open it in Dispatch Agent's right panel"); s.add_argument("--out", default="index.html", help="file name in the folder (the page; prototypes live next to it under other names)"); s.add_argument("--force", action="store_true", help="overwrite an index.html this command did not write"); s.add_argument("--test-log", action="append", help="a file with test output for the evidence block (repeatable)"); s.add_argument("--session", default=""); s.add_argument("--project", "-P", default="", help="register in this project's Docs (default: the task's)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: sys.exit(_mod("deliver").run(a, _THIS) or 0))
    s = sub.add_parser("begin", help="create + claim a task (do this once you know what you're doing); the title must say what + why, the description the trigger"); s.add_argument("title", help="\"<what> <how it changes>: <why>\", 8 to 80 characters"); s.add_argument("--project", "-P"); s.add_argument("--desc", "-d", help="what triggered it + the expected result, 20 characters or more"); s.add_argument("--force", action="store_true", help="create even when the title/description checks fail"); s.add_argument("--acceptance", "-a", help="one '- [ ] …' per line"); s.add_argument("--type", "-t", default="task"); s.add_argument("--priority", "-p", type=int, default=2); s.add_argument("--deps"); s.add_argument("--json", action="store_true"); s.add_argument("--session", help="explicit conversation id; otherwise use Agent session environment"); s.add_argument("--owns", default="", help="territory: files, folders or globs this task will change, comma separated (parallel work: edit-guard points out edits in another task's territory)"); s.add_argument("--thing", default="", help="the thing this request is about: a short name (about 12 characters) in the user's words, the same name to carry on an existing thing (`dispatch task things -P …`); default: the thing of this session's previous task"); s.set_defaults(fn=cmd_begin)
    s = sub.add_parser("claim", help="claim a task; refuses one another agent is working on unless --force"); s.add_argument("task"); s.add_argument("--force", action="store_true"); s.set_defaults(fn=cmd_claim)
    s = sub.add_parser("log", help="progress note on a task"); s.add_argument("task"); s.add_argument("text", nargs="?", default=""); s.add_argument("--claim", help="checklist number or words; tick it yourself with the progress as evidence"); s.add_argument("--tick", nargs="*", help="old spelling, same as --claim"); s.set_defaults(fn=cmd_log)
    s.add_argument("--worker", default=""); s.add_argument("--step", default=""); s.add_argument("--evidence", default=""); s.add_argument("--next", default=""); s.add_argument("--state", choices=["running", "blocked", "done"], default=None)
    s = sub.add_parser("check", help="the agent's self-check list: --claim <evidence> ticks an item; without arguments or with --status it shows the list")
    s.add_argument("task"); s.add_argument("items", nargs="?", default="", help="checklist number 2 or 2,3, or words")
    action = s.add_mutually_exclusive_group()
    action.add_argument("--claim", help="evidence for a finished item; ticks it")
    action.add_argument("--tick", action="store_true", help=argparse.SUPPRESS)
    action.add_argument("--untick", action="store_true", help="untick the chosen items")
    action.add_argument("--status", action="store_true", help="show each item's state and self-check evidence")
    s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_check)
    s = sub.add_parser("link", help="link a session to a task (session:<id>); --hook-json is for the PostToolUse hook; backfill fills it in from transcripts (--dry-run first)")
    s.add_argument("task", nargs="?", default="", help="task id, or backfill"); s.add_argument("--session", default="", help="session id (default: the current agent's session)"); s.add_argument("--hook-json", action="store_true")
    s.add_argument("--dry-run", action="store_true"); s.add_argument("--days", type=int, default=30); s.add_argument("--status", default="in_progress,closed"); s.add_argument("--only", default="", help="backfill: only these tasks (comma separated)"); s.add_argument("--verbose", action="store_true", help="backfill: also list tasks with only skipped items")
    s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_link)
    s = sub.add_parser("done", help="close a task; --next creates follow-ups; --retro writes the retrospective to the wiki"); s.add_argument("task"); s.add_argument("--reason", "-r", required=True); s.add_argument("--verified", action="store_true", help="you actually checked that the delivered work works"); s.add_argument("--retro", help="retrospective: what was done 【技术】what was used 【做对】what went right 【做错】what went wrong → wiki retro-<task>"); s.add_argument("--next", nargs="*", help="follow-up task titles"); s.add_argument("--json", action="store_true"); s.add_argument("--review-by", help="request peer review from this Agent, without launching it"); s.add_argument("--archive", action="store_true", help="also archive the task's conversations in the Agents window (Dispatch IDE / VS Code), via `dispatch ide archive-session`"); s.set_defaults(fn=cmd_done)
    s = sub.add_parser("review", help="record independent Agent review and its evidence"); s.add_argument("task"); s.add_argument("--verdict", choices=["pass", "changes"], required=True); s.add_argument("--reason", required=True); s.set_defaults(fn=cmd_review)
    s = sub.add_parser("graph", help="task lineage: nodes + typed edges"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_graph)
    s = sub.add_parser("stats", help="tokens, activity heatmap, tools/skills across all agents"); s.add_argument("--agent", help="claude-code | codex | pi | zcode | opencode | hermes | gemini"); s.add_argument("--days", type=int, default=0, help="only the last N days (0 = all)"); s.add_argument("--local", action="store_true", help="this Mac only (other Macs are merged in by default)"); s.add_argument("--cached", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_stats)
    s = sub.add_parser("discuss-live", help="what each discussion member is doing right now (the typing bubbles): discussions/<task>.live.json"); s.add_argument("task"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_discuss_live)
    s = sub.add_parser("discuss-conclude", help="write (replace) the discussion's conclusion — one block in the task's description"); s.add_argument("task"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_discuss_conclude)
    s = sub.add_parser("discuss-aside", help="ask on the side: something in a discussion you did not understand, asked of a classmate next to you; not written into the task, the discussion goes on"); s.add_argument("task"); s.add_argument("question", nargs="*"); s.add_argument("--stdin", action="store_true", help="read the question from stdin"); s.add_argument("--quote", default="", help="the words you marked"); s.add_argument("--clear", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_discuss_aside)
    s = sub.add_parser("discuss-doc", help="turn a discussion into a document (background / conclusion / plan / steps / risks / acceptance) written into the task, ready for an agent to start from"); s.add_argument("task"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_discuss_doc)
    s = sub.add_parser("discuss", help="several agents each leave one 【讨论】 (discussion) comment on a task, or on a topic or idea (--topic, optionally under a project); the summary model writes the conclusion"); s.add_argument("task", nargs="?", default="", help="task id; omit with --topic"); s.add_argument("--topic", default="", help="discuss an idea instead of a task: creates a 【讨论】 (discussion) task to hold it"); s.add_argument("--project", "-P", default="", help="with --topic: the project the idea belongs to (context for the agents)"); s.add_argument("--conclude", action="store_true", help="after the rounds, write (replace) the model's conclusion in the task's description"); s.add_argument("--no-conclude", action="store_true", help=argparse.SUPPRESS); s.add_argument("--create-only", action="store_true", help="with --topic: create the discussion task and stop"); s.add_argument("--image", action="append", help="with --topic: a picture the agents should look at (path; repeatable)"); s.add_argument("--with", dest="with_", action="append", required=True, help="participants: kind or kind:model, repeatable — claude:opus,claude:haiku,codex"); s.add_argument("--leader", default="", help="the leader, kind[:model] (added to the members if missing): speaks last each round, writes the conclusion and the document, gets the hand-off by default"); s.add_argument("--rounds", type=int, default=1); s.add_argument("--question", "-q", default="", help="what you want them to decide"); s.add_argument("--cwd"); s.add_argument("--host"); s.add_argument("--timeout", type=int, default=600000, help="how long to wait for each member each round: milliseconds; a number under 10000 counts as seconds (1200 = 20 minutes); never under 60 seconds"); s.add_argument("--close", action="store_true", help="close the discussion agents afterwards (--tui path)"); s.add_argument("--tui", action="store_true", help="run each member as an in-app chat in Dispatch (claude / codex) instead of headless claude -p / codex exec / pi -p"); s.add_argument("--fresh", action="store_true", help="forget the members' saved sessions: everyone reads the whole thread again"); s.add_argument("--everyone", action="store_true", help="skip the referee: every member speaks this round (by default, once the members have spoken, a round only wakes who was @'d or named-and-questioned since the last round)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_discuss)
    s = sub.add_parser("discuss-judge", help="dry run of the discussion referee: who the next round would wake, and why"); s.add_argument("task"); s.add_argument("--with", dest="with_", required=True, help="the members, as for discuss"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_discuss_judge)
    s = sub.add_parser("split", help="dynamic workflow step 2: create sub-tasks from the discussion and hand each to an agent"); s.add_argument("task"); s.add_argument("--to", action="append", help="kind:\"title|description\", repeatable"); s.add_argument("--cwd"); s.add_argument("--host"); s.add_argument("--no-start", action="store_true", help="only create the sub-tasks"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_split)
    s = sub.add_parser("agent", help="hand work to another agent as an in-app chat in the running Dispatch (chatd): list | start claude|codex | ask <session> <text> | read | wait | close | model <session> <model> | switch <session> --to codex|claude")
    s.add_argument("op", choices=["list", "start", "ask", "read", "wait", "keys", "close", "model", "switch", "run"])  # keys: refused with a hint (old callers); run: a sub-agent definition (dispatch agents) as its own session
    s.add_argument("target_or_kind", nargs="?", help="start: claude | codex | opencode; others: session key or id, label, or task id")
    s.add_argument("text", nargs="?", help="ask: the message; model: the model from the next turn on")
    s.add_argument("--to", help="switch: the Agent to go on with, codex | claude (new session in the same folder, handed the conversation so far)")
    s.add_argument("more", nargs="*", help="keys: further key names (enter, esc, down, up, tab, y, n …)")
    s.add_argument("--host", help="another Mac from hosts.json (id or name); default this one")
    s.add_argument("--cwd", help="start: the project folder the Agent works in")
    s.add_argument("--label", help="start: the conversation's title in Dispatch")
    s.add_argument("--model", help="start / switch: model the Agent starts with")
    s.add_argument("--task", help="start: claim this task for the new agent and note who handed it over")
    s.add_argument("--resume", help="start: go on with this conversation id instead of a new one")
    s.add_argument("--prompt", "-p", help="start: first prompt to send once the agent is ready; switch: what to go on with (after \"Go on with:\")")
    s.add_argument("--no-wait", dest="wait", action="store_false", help="don't wait for the agent to finish the prompt")
    s.add_argument("--timeout", type=int, default=600000, help="ms to wait for the agent (default 10 min)")
    s.add_argument("--lines", type=int, default=80, help="read: last lines of the reply to print")
    s.add_argument("--json", action="store_true")
    s.add_argument("--extra", default="", help="start: only --effort <level> is used (e.g. --extra '--effort high')")
    s.add_argument("--auto", action="store_true", help="start: unattended mode (Codex bypasses sandbox approvals, Claude skips permissions, OpenCode's questions are answered yes); implied by --task")
    s.add_argument("--engine", choices=[e.id for e in E.runnable()], help="run: which engine runs the definition (default: its engine:, else codex)")
    s.add_argument("--project", help="run: the project folder (its .dispatch/agents first); default a new folder in ~/.dispatch/chats")
    s.set_defaults(fn=cmd_agent)
    import agents_defs; agents_defs.add_parser(sub).set_defaults(fn=lambda a: agents_defs.cmd_agents(a, out))
    import builtin_agents; builtin_agents.add_parser(sub)
    import agent_builtins; agent_builtins.add_parser(sub)
    import neat_auto; neat_auto.add_parser(sub)
    s = sub.add_parser("hook", help="Dispatch's one hook entry (hook.py), for an agent that cannot run hook.py itself: the hook JSON on stdin"); s.add_argument("agent"); s.add_argument("rest", nargs=argparse.REMAINDER); s.set_defaults(fn=lambda a: sys.exit(_mod("hook").main([a.agent] + a.rest)))
    import lang; lang.add_parser(sub)
    import knowledge_sync; knowledge_sync.add_parser(sub).set_defaults(fn=lambda a: knowledge_sync.command(a, out))
    s = sub.add_parser("serve", help="serve the web/phone version of Dispatch over HTTP (Tailscale); `serve url` prints the link, `serve qr` prints a scannable QR, `serve host [<id>|local]` shows/sets which Mac the phone link points at"); s.add_argument("what", nargs="?", choices=["run", "url", "qr", "host", "install", "uninstall", "status", "login-link"], default="run"); s.add_argument("--to", default="", help="login-link: the page to open after signing in, such as #/sessions/<id>"); s.add_argument("--ttl", type=int, default=300, help="login-link: seconds it stays valid"); s.add_argument("target", nargs="?", default=None, help="host: a hosts.json id/name, or `local` for this Mac"); s.add_argument("--svg", action="store_true", help="qr: print SVG instead of terminal blocks"); s.add_argument("--json", action="store_true"); s.add_argument("--lan", action="store_true", help="install: without Tailscale, let devices on the same local network in too"); s.add_argument("--no-lan", action="store_true", help="install: take local network access back"); s.set_defaults(fn=cmd_serve)
    s = sub.add_parser("hosts", help="this Mac and the others: overlay network, remote-desktop backends detected, recommendation"); s.add_argument("--local", action="store_true", help="only this Mac (used over ssh by other hosts)"); s.add_argument("--refresh", help="clear the cached probe for this host id first, forcing a fresh ssh check"); s.add_argument("op", nargs="?", choices=["rename", "discover", "add", "set", "remove"], help="rename <id|local|name> <new name>: one name for that Mac everywhere, pushed to the other Macs; discover: Macs on Tailscale and this network that could be added; add <address> --user U [--name N] [--check] [--password-stdin]: check (one JSON line per step) and add one; set <id> [--name] [--address] [--user] [--id]; remove <id> (hosts.json backed up first, ~/.dispatch/ssh/config follows)"); s.add_argument("args", nargs="*"); s.add_argument("--user", default=None, help="add / set: the account name on that Mac"); s.add_argument("--name", default=None, help="add / set: what to call that Mac (also its SSH alias when it is one word)"); s.add_argument("--address", default=None, help="set: its IP or host name"); s.add_argument("--id", dest="new_id", default=None, help="set: a new hosts.json id (the old one stays an alias)"); s.add_argument("--check", action="store_true", help="add: run reach / login / dispatch / engines first and add only when all pass"); s.add_argument("--password-stdin", dest="password_stdin", action="store_true", help="add --check: read that account's password from stdin to install this Mac's SSH key there once (never stored)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_hosts)
    s = sub.add_parser("screen", help="one-step setup to see the screen from a phone (noVNC + websockify kept running + Tailscale Serve HTTPS)"); s.add_argument("op", nargs="?", choices=["status", "setup"], default="status"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_screen)
    s = sub.add_parser("usage", help="Dispatch IDE's Usage page (usage.py): every account's allowance now and over 14 days, tokens and money by engine, model, project and session, tools / MCP / skills / sub-agents / hooks with their failures, a year of sessions per engine. Answers at once from the last reading and refreshes it in the background; --refresh reads now, --record only records the allowance readings"); s.add_argument("--days", type=int, default=365, help="days in the heat map"); s.add_argument("--recent", type=int, default=14, help="days of allowance readings"); s.add_argument("--record", action="store_true"); s.add_argument("--refresh", action="store_true", help="read everything now (the background refresh)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: sys.exit(_mod("usage").command(a, _THIS)))
    s = sub.add_parser("machines", help="Dispatch IDE's Devices: one row for this Mac and each Mac in hosts.json (online, last seen, SSH alias, sessions, that Mac's own Waiting for you count, the last 3 projects, Dispatch version); sessions <Mac> lists that Mac's sessions"); s.add_argument("op", nargs="?", default="list", choices=["list", "sessions", "open"]); s.add_argument("host", nargs="?", default=""); s.add_argument("--land", choices=["waiting"], default=None); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: sys.exit(_mod("machines").command(a, _THIS)))
    s = sub.add_parser("capture", help="what the person asks for in a chat goes on the board by itself (From chat) and lines up as Next up: note --session <s> --cwd <folder> \"<message>\" reads one message; list the receipts with each thing's state; front | later | lineup | drop | undo <task>, requeue <task> (in progress with nobody on it: back in Next up), edit <task> \"<title>\", merge <task> <into>, targets <task>, keep <receipt> <n>, noteit <receipt> <n>, seen: what the line under a message offers; hook --agent <a>: a prompt typed in a Dispatch terminal (the agent's prompt hook JSON on stdin); settle --session <s> --agent <a> [--text -]: at the end of a turn, close what was noted for that conversation and the reply says is done or not needed")
    s.add_argument("op", choices=["note", "hook", "settle", "list", "front", "later", "lineup", "drop", "undo", "requeue", "edit", "merge", "targets", "keep", "noteit", "seen"]); s.add_argument("args", nargs="*")
    s.add_argument("--agent", default="claude-code", help="hook: the agent whose prompt hook (stdin, its JSON) this is: claude-code | codex | opencode")
    s.add_argument("--session", default="", help="the session's resource or id"); s.add_argument("--cwd", default="", help="note: the session's folder"); s.add_argument("--project", default="")
    s.add_argument("--text", default="", help="note: the message (- reads stdin)"); s.add_argument("--reply", default="", help="note: the agent's last reply, for context"); s.add_argument("--title", default="", help="note: the session's title")
    s.add_argument("--chat", action="store_true", help="note: the session has no project folder (the Agents window's Chats): nothing goes into a project or lines up")
    s.add_argument("--days", type=int, default=0); s.add_argument("--json", action="store_true")
    s.set_defaults(fn=lambda a: sys.exit(_mod("capture").command(a, _THIS)))
    s = sub.add_parser("nextup", help="the line of things noted from chats: list | settings | pause | resume | retry (a start that failed: try again now) | idle (in progress with nobody on it) | requeue (all of those back in Next up) | limit <n> | engine <claude|codex|opencode|default> [--model m] | tick (start the first one when fewer than <limit> sessions work)")
    s.add_argument("op", nargs="?", default="list", choices=["list", "settings", "pause", "resume", "retry", "idle", "requeue", "limit", "engine", "tick"]); s.add_argument("args", nargs="*"); s.add_argument("--model", default="")
    s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: sys.exit(_mod("capture").nextup_command(a, _THIS)))
    s = sub.add_parser("assistant", help="the assistant across projects: ~/.dispatch/assistant/ (made with ASSISTANT.md when missing) and its resident session's id, state and last line; overview: sessions, tasks and activity on every Mac; home: the home page's three cards (waiting for you, in progress, delivered today); turns <session> reads the last turns; send <session> \"words\" passes words into a session (marked From Assistant, --wait <seconds> waits for the answer); survey: what is unfinished in each project; similar <title>: whether the board already has the same work; add <title> records what the person agreed to as a to-do (not when the board already has it); look <folder> takes a look at a folder (without registering it as a project) (--host <Mac> does turns / send on another Mac)"); s.add_argument("op", nargs="?", default="status", choices=["status", "overview", "home", "now", "turns", "send", "survey", "similar", "add", "look"]); s.add_argument("args", nargs="*", help="turns / send: the session key (the key in overview); send is followed by the words, - reads them from standard input"); s.add_argument("--host", default=""); s.add_argument("--local", action="store_true", help="overview / survey: this Mac only (another Mac asking over ssh passes it)"); s.add_argument("--quick", action="store_true", help="status: leave out the Agents window's catalog (a busy Mac takes seconds over it): the folder and the session as the engines' history shows it; what the window asks for at start"); s.add_argument("--wait", type=int, default=0, help="send: seconds to wait for the session to answer and bring the answer back"); s.add_argument("-n", type=int, default=0, help="turns: how many recent turns"); s.add_argument("--project", default="", help="survey / similar / add: that project"); s.add_argument("--desc", default="", help="add: the task's description"); s.add_argument("--thing", default="", help="add: the work it belongs to"); s.add_argument("--force", action="store_true", help="add: add it even when the board has something similar"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: sys.exit(_mod("assistant").command(a, _THIS)))
    s = sub.add_parser("accounts", help="several Claude and Codex accounts on this Mac: list, add, use (switch), remove, rename; status = usage of the one in use; limits = sessions that stopped on a limit; continue = switch and let such a session go on; watch = status and new limits in one answer (the title bar)")
    s.add_argument("accounts_cmd", nargs="?", default="list", choices=["list", "status", "use", "add", "remove", "rename", "remember", "limits", "continue", "watch", "generation"])
    s.add_argument("engine", nargs="?", choices=[e.id for e in E.known() if e.accounts_driver]); s.add_argument("target", nargs="?", help="account id, email or label (continue: the session id)")
    s.add_argument("--to", default="", help="continue: the account to switch to (default: the one with the most allowance left)")
    s.add_argument("--label", default="", help="add / rename: a short name, like Work"); s.add_argument("--use", action="store_true", help="add: switch to the new account right away")
    s.add_argument("--since", type=float, help="limits: only stops after this time (epoch seconds)"); s.add_argument("--claim", action="store_true", help="limits: report each stop once across every caller")
    s.add_argument("--no-usage", action="store_true", help="list: names only, no usage numbers"); s.add_argument("--json", action="store_true")
    s.set_defaults(fn=lambda a: sys.exit(_mod("accounts").command(a, _THIS)))
    s = sub.add_parser("quota", help="usage limits per agent (5h / weekly), every Mac"); s.add_argument("--local", action="store_true", help="this Mac only"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_quota)
    s = sub.add_parser("rules", help="machine-wide rules for every agent: GLOBAL.md, Soul (dispatch soul) and Dispatch's own dispatch.md, in each agent's rules file (targets: which agents)"); s.add_argument("op", choices=["show", "path", "open", "status", "sync", "targets", "write", "inspect", "optimize", "check", "apply", "restore"]); s.add_argument("--set", default=None, help="targets: sync to exactly these agents (comma separated)"); s.add_argument("--reset", action="store_true", help="targets: forget the choice, back to the default"); s.add_argument("--force", action="store_true"); s.add_argument("--json", action="store_true"); s.add_argument("--path", default=""); s.add_argument("--profile", choices=["auto", "codex", "claude", "general"], default="auto"); s.add_argument("--model", default=""); s.add_argument("--backup", default=""); s.add_argument("--project", default=""); s.add_argument("--if-set-up", dest="if_set_up", action="store_true", help="sync: only when an agent already has Dispatch's block (what the Agents window runs at start, so an update's rules arrive)"); s.set_defaults(fn=cmd_rules)
    s = sub.add_parser("pit", help="pitfall log (= wiki --kind pit)"); s.add_argument("op", choices=["add", "list", "show"]); s.add_argument("text", nargs="?"); s.add_argument("--fix"); s.add_argument("--project", "-P"); s.add_argument("--task"); s.add_argument("--key"); s.add_argument("--all", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_pit)
    s = sub.add_parser("facts", help="facts: the global FACTS.md goes into every session; a project's FACTS.md is read only with -P <project>"); s.add_argument("op", choices=["show", "path", "open", "write", "sections", "docs", "vaults", "topics", "get", "search", "import", "list", "edit", "drop"]); s.add_argument("--section", default="", help="edit: the section the topic is in (needed when several sections have a topic of that name)"); s.add_argument("--text", default="", help="drop: that entry's exact words (so the wrong one is never removed)"); s.add_argument("query", nargs="?", default=""); s.add_argument("--apply", action="store_true", help="import: append to FACTS.md"); s.add_argument("--out", default="", help="import: path of the list"); s.add_argument("--project", "-P", default=""); s.add_argument("--path", default="", help="one file of the docs list (default the global FACTS.md)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_facts)
    s = sub.add_parser("profile", help="the person's own profile (~/.agents/rules/PROFILE.md): their situation and plans, kept up to date by agents"); s.add_argument("op", choices=["show", "path", "write", "add", "upcoming", "done", "inventory", "edit", "drop", "migrate"]); s.add_argument("args", nargs="*"); s.add_argument("--text", default="", help="drop: that entry's exact words (so the wrong one is never removed)"); s.add_argument("--actor", default=""); s.add_argument("--task", default=""); s.add_argument("--refresh", action="store_true"); s.add_argument("--due", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_profile)
    s = sub.add_parser("zcode-plugin", help="ZCode plugin: puts dispatch prime into a session at its start and brings the task-board skill (install | status | remove)"); s.add_argument("op", nargs="?", choices=["install", "status", "remove"], default="status"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: _mod("zcode_plugin").command(a))
    s = sub.add_parser("memories", help="each agent's own long-term memory (Claude Code / Codex / ZCode): list, show, archive, have a model summarize it"); s.add_argument("op", nargs="?", choices=["list", "show", "archive", "summary"], default="list"); s.add_argument("query", nargs="?", default="", help="show: file path"); s.add_argument("--agent", default="", help="list: claude-code | codex | zcode"); s.add_argument("--path", default="", help="show / archive: file path"); s.add_argument("--project", "-P", default="", help="summary: only this project"); s.add_argument("--force", action="store_true", help="summary: write it again, ignore the cache"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_memories)
    s = sub.add_parser("prefs", help="preferences: what the person said they like and dislike in deliveries (~/.dispatch/preferences.jsonl); part of the session brief, shown in Knowledge › Preferences"); s.add_argument("op", choices=["add", "list", "show", "edit", "forget", "undo", "cite", "keep", "seen", "stale", "thumbs", "import", "prime"]); s.add_argument("args", nargs="*", help="add: one sentence that can be followed (- reads standard input); otherwise: short name or id"); s.add_argument("--like", action="store_true", help="something the person liked"); s.add_argument("--avoid", action="store_true", help="something the person disliked"); s.add_argument("--name", help="short name to quote in replies (such as: square switch)"); s.add_argument("--area", choices=["design", "workflow", "writing", "tools"]); s.add_argument("--scope", help="everywhere | <project> | <project>:<screen>; the narrower wins"); s.add_argument("--quote", help="the person's own words"); s.add_argument("--part", help="where it hangs: <delivery file>#<area>"); s.add_argument("--evidence", action="append", help="evidence: a file (screenshot, prototype) or URL, repeatable"); s.add_argument("--replaces", action="append", help="the older preference it replaces (short name or id), repeatable"); s.add_argument("--text", help="edit: the new sentence (- reads standard input)"); s.add_argument("--batch", action="store_true", help="add: read several from standard input (a JSON list or one JSON object a line)"); s.add_argument("--project", "-P", default="", help="list: only those that apply to this project; import: only read this project's engine memory; prime: pick for this project"); s.add_argument("--new", action="store_true", help="list: those the person has not seen yet"); s.add_argument("--stale", action="store_true", help="list: those not used for 3 weeks"); s.add_argument("--all", action="store_true", help="list: include replaced ones; seen: all"); s.add_argument("--ids", default="", help="list: only these ids (comma separated), forgotten ones included"); s.add_argument("--thumbs", choices=["chip", "card"], help="list / show: thumbnails as data: URIs"); s.add_argument("--days", type=int, default=21, help="stale: days without use before one counts as old"); s.add_argument("--by", default="", help="cite: who followed it"); s.add_argument("--for", dest="for_", default="", help="cite: for which piece of work"); s.add_argument("--ref", default="", help="cite: the reply's id; one reply counts once"); s.add_argument("--make", action="store_true", help="thumbs: make thumbnails"); s.add_argument("--just-said", dest="just_said", action="store_true", help="forget: the Undo right after recording; for one that existed before, only the words just added go, not the whole preference"); s.add_argument("--from", dest="sources", default="", help="import: facts,memory,taste,profile,codex,design,claude_md,agents_md (default all)"); s.add_argument("--dry-run", action="store_true", help="import: only list, write nothing (the default)"); s.add_argument("--apply", action="store_true", help="import: write into preferences.jsonl (the source files stay as they are)"); s.add_argument("--sure-only", dest="sure_only", action="store_true", help="import --apply: write only the clear ones; unsure ones wait in preferences/pending-import.json for the person to pick"); s.add_argument("--pick", default="", help="import --apply: write only these numbers of the list (3,5,9-12)"); s.add_argument("--plan", default="", help="import: write from this list (made by --dry-run --out and editable; pending-import.json works too)"); s.add_argument("--out", default="", help="import --dry-run: write the list to this file"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_prefs)
    s = sub.add_parser("wiki", help="knowledge base: pits / wins / retros / howtos, one file an entry in ~/.dispatch/wiki (the same on all your Macs); migrate: copy the entries from the task board once"); s.add_argument("op", choices=["add", "list", "search", "show", "related", "edit", "rm", "migrate"]); s.add_argument("text", nargs="?", help="related: task id; search: a sentence; show / edit / rm: the entry's key"); s.add_argument("--body", help="add / edit: the text (- reads standard input); edit without it only changes the fields given"); s.add_argument("--kind", "-k", choices=list(WIKI_KINDS) + ["all"]); s.add_argument("--semantic", action="store_true", help="search: by meaning (Zhipu embedding-3 + sqlite-vec), not by keyword"); s.add_argument("--limit", type=int, default=8, help="search/related: at most how many"); s.add_argument("--fix", help="pit: the fix"); s.add_argument("--why", help="win: why it worked"); s.add_argument("--tech", help="retro: technique"); s.add_argument("--good", help="retro: what went right"); s.add_argument("--bad", help="retro: what went wrong"); s.add_argument("--project", "-P"); s.add_argument("--task"); s.add_argument("--key"); s.add_argument("--all", action="store_true", help="include plain memories"); s.add_argument("--dated", action="store_true", help="list / search: with the time each was first written (created), newest first"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_wiki)
    s = sub.add_parser("insights", help="cross-agent review: signal counts (default) or the model-written report (report/list/show/open/schedule/due)"); s.add_argument("op", nargs="?", choices=["report", "list", "show", "open", "schedule", "due"], help="omit for the signal counts"); s.add_argument("id", nargs="?", default="", help="report id for show/open (default latest)"); s.add_argument("--days", type=int, default=14); s.add_argument("--model", default=None); s.add_argument("--wait", action="store_true", help="report: generate in the foreground"); s.add_argument("--force", action="store_true"); s.add_argument("--every", type=int, default=None, help="schedule: 0 (off) / 7 / 14 / 30 days"); s.add_argument("--copy", action="store_true", help="copy the improvement-task command"); s.add_argument("--alerts", action="store_true", help="only the per-session alerts not yet acknowledged (proactive insights)"); s.add_argument("--ack", action="store_true", help="mark the current alerts as seen"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_insights)
    s = sub.add_parser("catalog", help="capabilities kept off by default: unmounted skills, disabled plugins"); s.add_argument("--query", "-q"); s.add_argument("--kind", choices=["skill", "plugin"]); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_catalog)
    s = sub.add_parser("notify", help="push a message to the phone (ntfy / Bark) or a macOS banner; channels come from dispatch env NTFY_URL / BARK_KEY"); s.add_argument("title"); s.add_argument("body", nargs="?", default=""); s.add_argument("--url", default="", help="link to open when the notification is tapped"); s.add_argument("--level", choices=["normal", "high"], default="normal"); s.add_argument("--key", default="", help="dedup key: the same key inside 5 minutes is sent once"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_notify)
    s = sub.add_parser("editor", help="agent hunks for Dispatch IDE's bridge extension, and opening a folder in VS Code / Cursor, as JSON"); s.add_argument("op"); s.add_argument("rest", nargs=argparse.REMAINDER, help="<path> --root R [--sid S] [--hunk ID] [--all] [--app code|cursor] [--line N] --json"); s.set_defaults(fn=lambda a: sys.exit(_mod("editor").main(a) or 0))
    s = sub.add_parser("chatd", help="chat sidecar: no argument = JSON lines on stdin/stdout (app/cli/chat_protocol.py; relayed to the resident chatd when it is installed); install|uninstall|status = the resident LaunchAgent; run = what launchd starts"); s.add_argument("op", nargs="?", choices=["install", "uninstall", "status", "run", "ensure"]); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: sys.exit((_mod("chatd_service").main(a) if a.op else _mod("chatd").main(a)) or 0))
    s = sub.add_parser("board", help="the task board service in chatd (one owner of the board: reads from memory, writes one at a time, changes pushed to the window): status|stats = what it did; refresh = read everything again"); s.add_argument("op", nargs="?", choices=["status", "stats", "refresh"], default="status"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: sys.exit(_mod("board_client").command(a) or 0))
    s = sub.add_parser("agents-installed", help="which agents exist on this Mac"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_agents_installed)
    s = sub.add_parser("models", help="models each agent can start with, from Anthropic's /v1/models and Codex's own cache"); s.add_argument("--agent", default="", help="claude / codex / pi (default all)"); s.add_argument("--refresh", action="store_true", help="ignore the 6-hour cache"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_models)
    s = sub.add_parser("doctor", help="check the hooks, chatd, task board, engine versions, machine id, disk, links and knowledge sync with your other Macs, one line each (ok / warn / fail); --fix repairs what can be repaired safely"); s.add_argument("--fix", action="store_true", help="reinstall missing hooks, restart chatd (only when no session runs), start the board server, recreate machine-id and links"); s.add_argument("--json", action="store_true", help="{schema, at, host, ok, counts, checks: [{name, status, message, fix, fixable, detail}], fixed}"); s.set_defaults(fn=lambda a: _mod("doctor").command(a))
    s = sub.add_parser("mcp", help="MCP servers of every engine Dispatch runs in one place, and Dispatch's own: serve (the server Claude Code, Codex and OpenCode start: the board's tools), register [--engine …] (add it to each engine, also done by setup and at every start of the Agents window), status, on / off (Settings' switch for it: off takes it out of every engine and keeps it out); list (--json for the Customizations page), add <name> (--url URL | -- command args…) [--engine claude-code,codex,…] [--env K=V] [--header K=V], remove <name>; add <preset> (presets: known hosted services such as higgsfield) needs no URL; each write keeps the old file in ~/.dispatch/backups/<date>/"); s.add_argument("op", nargs="?", choices=["list", "add", "remove", "presets", "serve", "register", "status", "on", "off"], default="list"); s.add_argument("name", nargs="?", default=""); s.add_argument("--engine", default="", help="comma list of engines: claude-code, codex, opencode… (default: every engine whose MCP servers Dispatch reads; register: the engines picked in setup and those on this Mac)"); s.add_argument("--agent", default="", help="serve: the engine that started it (claude-code, codex, opencode): the board name its calls sign with"); s.add_argument("--if-set-up", dest="if_set_up", action="store_true", help="register: only on a Mac that went through setup, and not when the server was removed (what the Agents window runs at start)"); s.add_argument("--url", default="", help="add: a remote (HTTP) server"); s.add_argument("--transport", choices=["http", "sse"], default="http", help="add --url: http (default) or sse"); s.add_argument("--env", action="append", default=[], help="add: KEY=VALUE for a local server, repeatable"); s.add_argument("--header", action="append", default=[], help="add --url: KEY=VALUE header, repeatable"); s.add_argument("--replace", action="store_true", help="add: overwrite a server of the same name"); s.add_argument("--from", dest="from_engine", default="", choices=["", *sorted({n for e in E.known() if e.supports("mcp_file") for n in (e.id, e.agent)})], help="add: copy the server of this name from that engine, env and headers included (values never printed)"); s.add_argument("--cwd", default="", help="list: also this folder's project and local Claude Code servers"); s.add_argument("--json", action="store_true"); s.add_argument("command", nargs="*", help="add: after --, the command and its arguments"); s.set_defaults(fn=lambda a: _mod("mcp_config").command(a))
    s = sub.add_parser("autonomy", help="how much agents may do on their own: ask-every | ask-risky | auto (default); `autonomy set <level>` saves it"); s.add_argument("op", nargs="?", choices=["get", "set"], default="get"); s.add_argument("level", nargs="?", default=""); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: _mod("autonomy").command(a))
    s = sub.add_parser("star", help="ask once for a GitHub star, after a week and ten sessions, once the repository is public; `star check` (the app), `star claim` (the one window that asks), `star answer open|later`"); s.add_argument("op", nargs="?", choices=["status", "check", "claim", "answer"], default="status"); s.add_argument("what", nargs="?", default=""); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: sys.exit(_mod("star").command(a)))
    s = sub.add_parser("awake", help="keep the Mac awake while an agent works or a phone is connected (setting keep_awake); `awake` shows what is held now, `awake check` what a pass would see, `awake tick` does one pass, `awake set system|display|off` changes the mode"); s.add_argument("op", nargs="?", choices=["status", "tick", "check", "set"], default="status"); s.add_argument("mode", nargs="?", default="", help="set: system (the Mac stays awake, the screen sleeps) | display (the screen stays on too) | off"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: _mod("awake").command(a))
    s = sub.add_parser("net", help="this Mac's network for the engines (net.py): the proxy they get (auto = this Mac's proxy settings, PAC included; off; or an address), whether Anthropic's and OpenAI's servers answer, the download source (official servers or mirrors in China) and the Chinese models OpenCode can use; `net env` is the proxy as variables for the Agents window's host"); s.add_argument("op", nargs="?", choices=["status", "check", "env", "set"], default="status"); s.add_argument("what", nargs="?", choices=["proxy", "mirror"], help="set: proxy (auto | off | an address) or mirror (auto | official | china)"); s.add_argument("value", nargs="?", default=None); s.add_argument("--refresh", action="store_true", help="status: ask the servers now, not the ten-minute cache"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: _mod("net").command(a))
    s = sub.add_parser("first-run", help="first-run helpers: `first-run notify-test` shows a banner on this Mac, `first-run notify-settings` opens System Settings at Notifications"); s.add_argument("op", choices=["notify-test", "notify-settings"]); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: _mod("firstrun").command(a))
    s = sub.add_parser("engines", help="Claude Code / Codex / OpenCode: installed version, newest on npm (cached an hour), how to update; `engines upgrade <id>` runs the update; `engines detect` finds every agent CLI on this Mac, `engines use` picks the ones Dispatch uses, `engines login <claude|codex>` opens the sign-in page; `engines opencode-kit` puts OpenCode's plugin kit from inside Dispatch IDE into its config folders, so its first start does not wait for npm"); s.add_argument("op", nargs="?", choices=["list", "upgrade", "status", "install-plugin", "uninstall-plugin", "opencode-kit", "detect", "enabled", "use", "login"], default="list"); s.add_argument("name", nargs="?", default="", help="claude | codex | opencode (status / install-plugin / uninstall-plugin: opencode)"); s.add_argument("--cwd", default="", help="opencode-kit: also the .opencode folders of this project"); s.add_argument("--kit", default="", help="opencode-kit: the kit file (default: the one inside Dispatch IDE)"); s.add_argument("--on", default=None, help="use: the agents Dispatch cannot run yet that are turned on (comma list, replaces the saved one)"); s.add_argument("--off", default=None, help="use: the agents Dispatch runs that are turned off (comma list, replaces the saved one)"); s.add_argument("--default", default=None, help="use: the agent a new session starts with ('' = the first one that is on)"); s.add_argument("--reset", action="store_true", help="use: back to the default, no choice saved"); s.add_argument("--refresh", action="store_true", help="ask npm now, not the one-hour cache"); s.add_argument("--offline", action="store_true", help="list: never ask npm (installed versions only, the last cached newest)"); s.add_argument("--dry-run", action="store_true", help="upgrade: print the command only"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: _mod("engines").command(a))
    s = sub.add_parser("automations", help="the Automations page: `automations discover` lists what Hermes, OpenClaw, Codex, Claude, launchd and cron run on a schedule when it starts an agent (what it does, when it runs next, its last runs and their output), read-only; --remote asks the other Macs in hosts.json over ssh, --host one of them"); s.add_argument("op", choices=["discover"]); s.add_argument("--remote", action="store_true", help="the other Macs instead of this one"); s.add_argument("--host", default="", help="one other Mac (hosts.json id, name or alias)"); s.add_argument("--fresh", action="store_true", help="ask the other Macs now instead of using an answer up to 2 minutes old"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: sys.exit(_mod("automations_discover").command(a, _THIS)))
    _mod("fixit").add_parsers(sub)  # dispatch fix … / dispatch write … (fixit.py)
    _mod("git_identity").add_parser(sub)  # dispatch git-identity: the name and email on commits, asked not made up (task-pog4t)
    s = sub.add_parser("terminal", help="the Agents window's terminal: `terminal agents` lists the agents on this Mac that can run in it with the command that starts each; `terminal ghostty` says what the terminal would take from the person's Ghostty settings; `terminal daemon start|status|stop` is the process that keeps the terminals running while Dispatch is closed; `terminal snippets list|add|update|remove` keeps words sent to agents often"); s.add_argument("op", choices=["agents", "ghostty", "daemon", "snippets"]); s.add_argument("sub", nargs="?", default="", help="daemon: start|status|stop; snippets: list|add|update|remove"); s.add_argument("--app-root", default="", help="daemon start: Dispatch IDE's Resources/app"); s.add_argument("--if-kept", action="store_true", help="daemon start: only when there are terminals to bring back"); s.add_argument("--id", default=""); s.add_argument("--name", default=None); s.add_argument("--text", default=None); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: _mod("terminal_cmd").command(a))
    s = sub.add_parser("slash", help="the Agents window's slash menu: commands a Claude Code / Codex / OpenCode session cannot run here, why, and where to do them instead (grey rows)"); s.add_argument("--engine", choices=["claude", "codex", "opencode"], default=""); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: _mod("slash").command(a))
    s = sub.add_parser("notify-watch", help="one pass of the phone watcher: push unread agent replies and confirmations (the phone server runs this every 20 s)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: _mod("notify_watch").main(a))
    s = sub.add_parser("docs", help="the project page's documents and the Agents window's Docs tab: the .md/.html under design/ docs/ 研究/, plus registered paths and URLs"); s.add_argument("op", nargs="?", default="", help="add | rm | read | seen (without it the first argument is the project's name and its documents are listed)"); s.add_argument("project", nargs="?"); s.add_argument("extra", nargs="*", help="add/read/rm: path or URL, document id"); s.add_argument("--title", help="add: the title to show (default the first # line or the file name)"); s.add_argument("--kind", choices=list(DOC_KINDS), help="add: kind"); s.add_argument("--asset", default="", help="read: a file next to the document (an image), returned as base64"); s.add_argument("--local", action="store_true", help="list: this Mac only (used when another Mac asks)"); s.add_argument("--folder", default="", help="list / add / seen / rm: without a project name, find the project by this folder (it may be a copy of the project)"); s.add_argument("--task", action="append", default=[], help="add: the task this document delivers (repeatable)"); s.add_argument("--session", default="", help="list: mark this session's documents (in_session); add: record its session (default the current agent's session)"); s.add_argument("--all", action="store_true", help="list: include copies, duplicates and removed ones"); s.add_argument("--filter", default="all", choices=["today", "delivered", "design", "research", "notes", "all"], help="list: only this filter of the Docs tab (today: delivered or changed today; delivered: delivery pages; design: design drafts; research: reviews and research; notes: final versions, plans, reports, briefs, handoffs); counts still cover everything"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_docs)
    s = sub.add_parser("project-summary", help="have a model sum up a project in one paragraph: what it is, where it stands, what was done lately, what is missing"); s.add_argument("name"); s.add_argument("--force", action="store_true", help="write it again even if there is one"); s.add_argument("--if-stale", action="store_true", help="write it only when there is none or it is over a day old"); s.add_argument("--local", action="store_true", help="answer only for this Mac (ask no other Mac); used when another Mac asks, so they never ask each other in circles"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_project_summary)
    for _here_name in ("here", "project-view"):
        s = sub.add_parser(_here_name, help="a project as it is now: a paragraph on where it stands, the last 14 days, unfinished tasks, whether the live sessions in this folder can be closed (default the current folder)"); s.add_argument("project", nargs="?", default=""); s.add_argument("--project", "-P", dest="project_opt", default=""); s.add_argument("--dir", help="this folder (default the current folder)"); s.add_argument("--days", type=int, default=14, help="days of timeline (default 14)"); s.add_argument("--no-summary", action="store_true", help="call no model and skip the paragraph"); s.add_argument("--refresh-summary", action="store_true", help="write the paragraph again, ignore the cache"); s.add_argument("--summary-model", default="", help="the model for the paragraph (default the summary model in Settings)"); s.add_argument("--local", action="store_true", help="this Mac only (by default the other Mac's commits and sessions are merged in)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_here)
    s = sub.add_parser("lineage", help="project → task → session → progress: who works on which task in which session, how far along, whether it can be closed"); s.add_argument("project", nargs="?", default=""); s.add_argument("--project", "-P", dest="project_opt", default=""); s.add_argument("--dir"); s.add_argument("--days", type=int, default=14); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_lineage)
    s = sub.add_parser("thread", help="the story of a project: with a project, the whole story (how far it got, what is left, one chapter per line of work in time order); with a task id, the whole line it is on; --projects lists every project, --lines a project's lines"); s.add_argument("target", nargs="?", default="", help="project name or task id (default: the project of this directory)"); s.add_argument("--projects", action="store_true", help="list every project that has lines, one row each"); s.add_argument("--lines", action="store_true", help="list the project's lines instead of its story"); s.add_argument("--task", default="", help="with a project: open the chapter holding this task; with --timeline: only this task's rows"); s.add_argument("--in", dest="inside", default="", help="with a task id: its line as a chapter of this project (only that project's tasks, starting where the line enters it)"); s.add_argument("--all", action="store_true", help="list the lines, also single tasks that never split off anything (implies --lines)"); s.add_argument("--all-projects", action="store_true", help="lines from every project"); s.add_argument("--timeline", action="store_true", help="with a project: the project page v3, what was done newest first (folded) plus the open work"); s.add_argument("--days", type=int, default=None, help="--timeline: calendar days back from today (default 7; 0 = the whole history), or with --before the days before it (default 14)"); s.add_argument("--before", type=float, default=None, help="--timeline: the page before this epoch (the Earlier loader's next_before)"); s.add_argument("--only", choices=["done"], default="", help="--timeline: only completion and conclusion records"); s.add_argument("--no-sessions", action="store_true", help="--timeline: skip the live sessions"); s.add_argument("--no-open", action="store_true", help="--timeline: skip the open work (the Earlier pages)"); s.add_argument("--dir"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_thread)
    s = sub.add_parser("decide", help="record one sentence the person decided (a 【决定】 decision comment); the story marks it as a conclusion"); s.add_argument("task"); s.add_argument("text"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_decide)
    s = sub.add_parser("session-summary", help="have a model write a summary of a session (Claude subscription or a key in dispatch env)"); s.add_argument("op", nargs="?", default="run", choices=["run", "provider", "providers", "auto", "unread"]); s.add_argument("key", nargs="?", help="session key such as claude-code:<session_id> (unread: the summary of the turn not read yet)"); s.add_argument("--force", action="store_true", help="write it again even if there is one"); s.add_argument("--limit", type=int, default=2, help="auto: at most how many sessions to summarize this time"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_session_summary)
    s = sub.add_parser("summarize", help="the model for summaries and the switch for each use: providers (models to pick) / set-key (save a key from stdin) / uses (the table of uses)"); s.add_argument("op", nargs="?", default="providers", choices=["providers", "set-key", "uses"]); s.add_argument("provider", nargs="?", help="set-key: zhipu | deepseek | kimi | minimax | openai"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_summarize)
    s = sub.add_parser("move", help="move a session with its project folder to another Mac and go on there; move repair fills in move records missing between two Macs"); s.add_argument("session", help="session id (a prefix is enough), or repair"); s.add_argument("--to", default="", help="the Mac's id or name in hosts.json (for repair, only this one is checked)"); s.add_argument("--key", default="", help="repair: only this session (agent:id or an id prefix)"); s.add_argument("--prompt", help="extra words to pass on with the handoff"); s.add_argument("--no-files", action="store_true", help="do not sync the project folder (the other Mac has it)"); s.add_argument("--dry-run", action="store_true", help="only check first: Git conflicts, which files change, which tools are missing"); s.add_argument("--force", action="store_true", help="move even when the Git check finds conflicts (overwrites the other side's changes)"); s.add_argument("--keep-original", action="store_true", help="keep the original session here running"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_move)
    s = sub.add_parser("update", help="check for / install a new version from GitHub Releases"); s.add_argument("op", nargs="?", choices=["check", "apply"]); s.add_argument("--no-relaunch", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_update)
    s = sub.add_parser("init", help="first-run setup: install what is needed, make or join a task board, pick agents, sync rules and skills (no arguments = interactive)"); s.add_argument("op", nargs="?", choices=["wizard", "status", "run", "hub-info", "add-host", "rename-self", "rename-peer", "remove-host", "skip", "finish", "reset", "peers", "ensure-board"]); s.add_argument("args", nargs="*", help="run: <deps|cli|board|agents|rules|review|reverse-ssh> [arguments…]; rename-self <new name>; rename-peer <ssh or id> <new name>; remove-host <id>"); s.add_argument("--edit-guard", dest="edit_guard", action="store_const", const=True, default=None, help="run agents: give Claude Code the hook that keeps two agents from editing one file"); s.add_argument("--no-edit-guard", dest="edit_guard", action="store_const", const=False, help="run agents: leave that hook out"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_init)
    s = sub.add_parser("onboard", help="the first-run setup wizard's backend (onboarding.py): what is here, folders, preferences, rules, undo; always JSON"); s.add_argument("op", choices=["status", "unconnected", "scan", "scan-status", "folders", "register", "prefs", "prefs-apply", "rules", "apply-dir", "apply-rules", "apply-skills", "apply-command", "vscode", "vscode-apply", "vscode-extensions", "log-add", "log", "log-entry", "available", "undo", "step", "draft", "finish", "skip", "reset"]); s.add_argument("args", nargs="*"); s.add_argument("--pick", default="", help="prefs-apply: the plan's numbers (1,2,5-9)"); s.add_argument("--agents", default="", help="apply-rules / apply-skills: claude,codex,opencode"); s.add_argument("--also-git", dest="also_git", action="store_true", help="undo projects: also remove the .git folders Dispatch made (empty ones only)"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=lambda a: sys.exit(_mod("onboarding").command(a, _THIS) or 0))
    # Listed for --help only: _main hands these to their modules before argparse runs.
    for name, help_ in (("ide", "Dispatch IDE: status|agents|show|native-open|back|folder-session|recommend|edit|usage|signal|archive-session; instance start|list|stop and e2e run|annotate|scenarios (UI end-to-end tests, ide_e2e.py)"),
                        ("checkpoint", "per-turn file checkpoints: snapshot|list|diff|restore"),
                        ("attribution", "who wrote each changed line, the agent or you: mark|show|files|note|steps|config|prune"),
                        ("code-search", "semantic code search over a project: \"<question>\" --root DIR | index | status"),
                        ("browser", "a Chromium window an Agent drives: open|shot|click|type|press|eval|logs|snapshot|close; --ide drives the built-in browser in Dispatch IDE's right panel"),
                        ("computer", "an Agent uses another Mac app after the person allows it: check|apps|start|look|click|fill|type|press|scroll|stop|status (computer.py)"),
                        ("point-talk", "Point and talk's speech recognition (Soniox, your SONIOX_API_KEY): status|key|transcribe FILE (point_talk.py)")):
        s = sub.add_parser(name, help=help_); s.add_argument("args", nargs=argparse.REMAINDER)
    s = sub.add_parser("env", help="API keys / secrets store (~/.config/dispatch/env, 0600)"); s.add_argument("op", choices=["list", "get", "set", "unset", "undo", "export", "import", "path", "forget-missing"], help="forget-missing: accept that keys the store had at its last write are gone (a write refuses until then)"); s.add_argument("name", nargs="?", help="the key; undo: the change id `set` / `unset` printed"); s.add_argument("value", nargs="?"); s.add_argument("--note", help="what it is for, in one sentence"); s.add_argument("--project", "-P", default=None, help="set/import: belongs to this project only; list: this project's only. An empty string clears it"); s.add_argument("--stdin", action="store_true", help="set: read the value from stdin (it stays out of the shell's history)"); s.add_argument("--fish", action="store_true", help="export: fish syntax"); s.add_argument("--by", default=None, help=argparse.SUPPRESS); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_env)
    s = sub.add_parser("title-summary", help=argparse.SUPPRESS); s.add_argument("id"); s.add_argument("--was", default=""); s.add_argument("--timeout", type=float, default=45.0); s.add_argument("full", nargs="*"); s.set_defaults(fn=cmd_title_summary)
    s = sub.add_parser("remote-refresh", help=argparse.SUPPRESS); s.add_argument("host"); s.add_argument("--timeout", type=int, default=45); s.add_argument("args", nargs="*"); s.set_defaults(fn=cmd_remote_refresh)
    s = sub.add_parser("prime", help="compact session-start digest (SessionStart hook)"); s.add_argument("--hook-json", action="store_true"); s.add_argument("--opencode", action="store_true", help="OpenCode's plugin asks with this; the brief is the same, and a session start is assumed"); s.add_argument("--source", default="", choices=["", "compact", "clear"], help="--opencode after a compaction: include the latest handoff"); s.add_argument("--cwd"); s.set_defaults(fn=cmd_prime)
    if _KEEP_PARSER:
        _PARSER = (p, sub)
    return p, sub


def _run_parsed(p, sub):
    argv, tail = sys.argv[1:], None
    if argv[:1] == ["mcp"] and "--" in argv:
        # `dispatch mcp add <name> [options] -- command args…`: the command is taken as is (Python 3.9's
        # argparse does not hand words after -- to a positional that follows optional ones)
        argv, tail = argv[:argv.index("--")], argv[argv.index("--") + 1:]
    a = parse_args_compat(p, sub, argv)
    if tail is not None:
        a.command = tail
    if a.cmd == "agent":
        a.kind = a.target = a.target_or_kind
        if a.op != "list" and not a.target_or_kind:
            p.error("start needs a kind (claude|codex…); the others need a target (pane id / name / title / task id)")
        if a.op == "ask" and not a.text:
            p.error("ask needs a prompt")
    if a.cmd == "skills" and a.op not in ("list", "improve", "roots") and not a.name:
        p.error("a skill name is needed")
    if a.cmd in ("pit", "wiki") and a.op == "add" and not a.text and not getattr(a, "body", None):
        p.error("write what to record")
    if a.cmd == "wiki" and a.op == "related" and not a.text:
        p.error("a task id is needed")
    if a.cmd == "wiki" and a.op in ("edit", "rm") and not a.text:
        p.error("an entry's key is needed (the key in dispatch wiki list)")
    if a.cmd == "env" and a.op in ("get", "set", "unset", "undo", "import") and not a.name:
        p.error("a variable name is needed" if a.op != "import" else "a file path is needed")
    if a.cmd == "wiki" and a.op == "search":
        a.op = "list"
    if P.IS_WIN and a.cmd in WIN_UNSUPPORTED:
        if win_empty_listing(a):
            return out([], a.json, lambda _: print(L.t("%s is not supported on Windows yet; for now it only works on a Mac", "Windows 版暂不支持%s，这一功能目前只在 Mac 上可用") % WIN_UNSUPPORTED[a.cmd]))
        P.unsupported(WIN_UNSUPPORTED[a.cmd])
    try:
        a.fn(a)
    except FileNotFoundError as e:
        # An external tool this command shells out to is not installed (or a file it needs is gone).
        name = P.exe_base(str(e.filename or "")) if P.IS_WIN else os.path.basename(str(e.filename or ""))
        if name and (os.sep not in str(e.filename) or name in TOOL_FORMULA):
            print(missing_tool_hint(name), file=sys.stderr)
            sys.exit(127)
        raise
    finally:
        # preferences, wiki, rules, skills, sub-agents: a write becomes a commit a few seconds later (knowledge_sync.py)
        try:
            _mod("knowledge_sync").after_command(sys.argv[1:], a)
        except Exception:
            pass


if __name__ == "__main__":
    main()
