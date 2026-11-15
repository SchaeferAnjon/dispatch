# -*- coding: utf-8 -*-
"""The agent engines Dispatch knows: the registry of their adapters, and the tools every engine shares.

The registry: one file per engine in this folder (claude.py, codex.py, opencode.py, ...) defines `ENGINE`, an
`engines.base.Engine`; the agents Dispatch only recognizes are rows in catalog.py. The rest of Dispatch asks
`get(name)` (an id, a session-key prefix, an alias or an Agents-window provider id) and calls the adapter; it never
branches on an engine's name. Adding an agent is adding one file here.

The shared tools (`dispatch engines`): for each engine Dispatch installs (one with an npm package), installed or
not, where, which version, the newest version on npm (cached for an hour in DISPATCH_DIR/engines-latest.json) and
how to update it, worked out from where the binary lives: the engine's own installer (`claude update`,
`opencode upgrade`), npm (`npm i -g`), bun (`bun add -g`) or Homebrew (`brew upgrade`).

`dispatch engines upgrade <id>` runs that command (or installs the engine when it is not there) and answers with
the version before and after.

`search_path()` is where Dispatch looks for these and for bd / dolt: Dispatch IDE's own bin folder
first (DISPATCH_IDE_BIN, set by dispatch-bridge), then the folders npm-style installers use (the app
is started from the Dock, not a login shell), then PATH."""
import glob, json, os, re, shutil, subprocess, sys, time

from engines.base import Engine, Unsupported  # noqa: F401 - the interface, for callers: engines.Unsupported

HOME = os.path.expanduser("~")
DISPATCH_DIR = os.environ.get("DISPATCH_DIR") or os.path.join(HOME, "tasks", ".dispatch")
CACHE = os.path.join(DISPATCH_DIR, "engines-latest.json")
TTL = 3600
REGISTRY = os.environ.get("DISPATCH_NPM_REGISTRY", "https://registry.npmjs.org").rstrip("/")
_VERSION = re.compile(r"(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)")


# ---------------------------------------------------------------- the registry
_REGISTRY = None


def _load():
    """{name: Engine} for every word that names an engine, and the engines in list order. Read once: each module in
    this folder that defines ENGINE, then catalog.py's rows for the agents without a file."""
    global _REGISTRY
    if _REGISTRY is None:
        import importlib
        from engines import catalog
        adapters = {}
        names = sorted({f[:-3] for d in __path__ if os.path.isdir(d) for f in os.listdir(d)
                        if f.endswith(".py") and not f.startswith("_") and f[:-3] not in ("base", "catalog")})
        for name in names:
            eng = getattr(importlib.import_module("engines." + name), "ENGINE", None)
            if isinstance(eng, Engine) and eng.id:
                adapters[eng.id] = eng
        known = list(adapters.values()) + [Engine(**row) for row in catalog.AGENTS if row["id"] not in adapters]
        rank = {i: n for n, i in enumerate(catalog.ORDER)}
        ordered = sorted(known, key=lambda e: rank.get(e.id, len(rank)))
        names = {}
        for e in ordered:
            for n in e.names:
                names.setdefault(n, e)
        _REGISTRY = (names, ordered)
    return _REGISTRY


def find(name):
    """The engine `name` means (id, session-key prefix, alias or provider id), or None."""
    return _load()[0].get(name or "")


def get(name):
    """The engine `name` means; a name nobody knows gets an Engine that only has that name and supports nothing."""
    return find(name) or Engine(id=str(name or ""))


def known():
    """Every engine Dispatch knows, in the order lists show them."""
    return list(_load()[1])


def adapters():
    """The engines with an adapter file of their own."""
    return [e for e in known() if type(e) is not Engine]


def runnable():
    """The engines Dispatch starts and drives sessions with."""
    return [e for e in known() if e.runnable]


def managed():
    """The engines Dispatch installs and updates (`dispatch engines`): the ones with an npm package."""
    return [e for e in known() if e.package]


def from_env(env=None):
    """The engine whose markers the environment carries (Engine.env_markers), or None. An agent started inside another
    inherits the outer one's markers too: later engines in the list are looked at first (Codex inside Claude Code is
    Codex's)."""
    env = os.environ if env is None else env
    return next((e for e in reversed(known()) if any(env.get(k) for k in e.env_markers)), None)


def session_env_names():
    """The variables that name the session a command runs in, the most specific first: Dispatch's own, then each
    engine's (Engine.session_env; later engines first, as from_env)."""
    return ("DISPATCH_SESSION_ID",) + tuple(v for e in reversed(known()) for v in e.session_env)


def session_from_env(env=None):
    """(engine, session id) of the engine session a command runs in, by that engine's own variables; (None, '')."""
    env = os.environ if env is None else env
    for e in reversed(known()):
        for k in e.session_env:
            if env.get(k):
                return e, env[k]
    return None, ""


def agent_env(env):
    """`env` without what marks a command as running inside an engine session (markers, session ids, an engine's own
    prefixed variables): for a child that must not pass itself off as that session."""
    names = {v for e in known() for v in (*e.env_markers, *e.session_env)}
    prefixes = tuple(e.env_prefix for e in known() if e.env_prefix)
    return {k: v for k, v in env.items() if k not in names and not (prefixes and k.startswith(prefixes))}


def by_bin(name):
    """The engine whose command is `name` (claude, cursor-agent), or None."""
    return next((e for e in known() if name in e.bins), None)


def by_process(base, word):
    """The engine whose program a process is (`base`: its file name, lower case; `word`: its whole path or command
    word), or None. Engines whose command names other tools share (Engine.verify) are left out: a process name alone
    says too little about them."""
    return next((e for e in known() if not e.verify and e.is_command(base, word)), None)


def foreign_session(agent, sid):
    """Whether a hook that says it is `agent` runs in another engine's session: `sid` has the shape of another engine's
    own ids (an OpenCode plugin replaying Claude Code's hooks hands over OpenCode's ses_… id)."""
    me = find(agent)
    return any(e.owns_session_id(str(sid or "")) for e in known() if e is not me)


def agent_of(name):
    """The session-key prefix of the engine `name` means ('claude' -> 'claude-code'); an unknown name stays as it is."""
    return get(name).agent


def provider_of(name):
    """The Agents-window provider id of the engine `name` means ('claude-code' -> 'claude', 'copilot' -> 'copilotcli');
    a name without one stays as it is."""
    eng = find(name)
    return eng.provider if eng and eng.provider else str(name or "")


def id_of(name):
    """The catalog id of the engine `name` means ('claude-code' -> 'claude'); an unknown name stays as it is."""
    return get(name).id


def skill_dirs(home=None, env=None):
    """Engine skill discovery roots; the first is the writable mount destination. Each engine names its own
    (`Engine.skills`); engines following the shared Agent Skills convention keep the default."""
    env = os.environ if env is None else env
    home = home or HOME
    values = dict(home=home, config=env.get("XDG_CONFIG_HOME") or os.path.join(home, ".config"),
                  claude=env.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude"),
                  codex=env.get("CODEX_HOME") or os.path.join(home, ".codex"))
    return {e.id: [os.path.normpath(p.format(**values)) for p in e.skills] for e in managed()}


def search_path(env=None):
    """PATH for finding engines, bd and dolt: DISPATCH_IDE_BIN (the binaries inside Dispatch IDE)
    first, then where npm / bun / Claude Code's installer put their commands, then PATH."""
    env = os.environ if env is None else env
    if env.get("DISPATCH_ENGINE_PATH"):
        # exactly these folders (a test instance standing in for a Mac that has nothing else: fixtures/old_opencode.py);
        # PATH will not do, the bridge adds Homebrew's and the other usual places to it
        # (the system's own folders after them: the commands run with this PATH need sh, sed and the like)
        return os.pathsep.join(d for d in [env.get("DISPATCH_IDE_BIN") or ""] + env["DISPATCH_ENGINE_PATH"].split(os.pathsep)
                               + ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] if d)
    extra = [env.get("DISPATCH_IDE_BIN") or "",
             os.path.join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin",
             os.path.join(HOME, "npm-global", "bin"), os.path.join(HOME, ".npm-global", "bin"),
             os.path.join(HOME, ".volta", "bin"), os.path.join(HOME, ".bun", "bin"),
             os.path.join(HOME, ".opencode", "bin"), os.path.join(HOME, ".cargo", "bin"), os.path.join(HOME, ".amp", "bin"),
             os.path.join(HOME, ".local", "share", "pnpm"), os.path.join(HOME, ".yarn", "bin")]
    extra += sorted(glob.glob(os.path.join(HOME, ".nvm", "versions", "node", "*", "bin")), reverse=True)[:1]
    # bd and dolt inside Dispatch IDE when nothing set DISPATCH_IDE_BIN (a Terminal, chatd): agents run `dispatch`
    import dplatform
    extra += dplatform.app_tools_dirs()
    seen, dirs = set(), []
    for d in [d for d in extra if d and os.path.isdir(d)] + (env.get("PATH") or "").split(os.pathsep):
        if d and d not in seen:
            seen.add(d)
            dirs.append(d)
    return os.pathsep.join(dirs)


def which(name, env=None):
    return shutil.which(name, path=search_path(env))


def candidates(name, env=None):
    """Every executable `name` on the search path, in search order, one per real file."""
    seen, out = set(), []
    for d in search_path(env).split(os.pathsep):
        p = os.path.join(d, name)
        if not (os.path.isfile(p) and os.access(p, os.X_OK)):
            continue
        real = os.path.realpath(p)
        if real not in seen:
            seen.add(real)
            out.append(p)
    return out


def min_version_text(eng):
    m = get(eng).min_version if isinstance(eng, str) else eng.min_version
    return ".".join(map(str, m)) if m else ""


def pick(eng, env=None, version_of=None):
    """The copy of an engine Dispatch runs: {path, version, supported, candidates: [{path, version}]}.
    With a minimum version (Engine.min_version) it is the first candidate at or above it; when every copy is
    older, the newest one with supported False; without a minimum, the first one (what `which` finds)."""
    version_of = version_of or installed_version
    found = [{"path": p, "version": version_of(p)} for p in candidates(eng.bin, env)]
    minimum = eng.min_version
    if not found:
        return {"path": "", "version": "", "supported": False, "candidates": []}
    if not minimum:
        return dict(found[0], supported=True, candidates=found)
    for c in found:
        if c["version"] and vtuple(c["version"]) >= minimum + (1,):
            return dict(c, supported=True, candidates=found)
    best = max(found, key=lambda c: vtuple(c["version"]) if c["version"] else (-1,))
    return dict(best, supported=False, candidates=found)


def engine_path(eng, env=None):
    """The executable to run for an engine: `pick`'s choice, or what `which` finds for one without a minimum."""
    return (pick(eng, env)["path"] if eng.min_version else which(eng.bin, env)) or ""


def vtuple(v):
    """'2.1.283' → (2, 1, 283, 1); a pre-release sorts before its release: '1.0.0-beta' → (1, 0, 0, 0)."""
    m = _VERSION.search(v or "")
    if not m:
        return (0,)
    core, _, pre = m.group(1).partition("-")
    return tuple(int(x) for x in core.split(".")) + ((0,) if pre else (1,))


def parse_version(text):
    m = _VERSION.search(text or "")
    return m.group(1) if m else ""


def _child_env():
    env = dict(os.environ)
    env["PATH"] = search_path(env)
    import net
    return net.apply(env)  # this Mac's proxy (net.py): sign-in and updates go out through it


_VERSION_CACHE = {}
# `--version` answers kept on disk as well, per file (path, mtime, size), for VERSION_TTL: every `dispatch` run is a
# new process, and the Agents window's account panel asks for OpenCode's state every two minutes, Settings and the
# start a dozen times more; each asked every copy of OpenCode, Gemini and the rest again (10-10: 34 `--version`
# processes in the window's first three minutes). An upgrade replaces the file and asks again; the TTL covers a
# wrapper script that stays the same while what it runs changes.
VERSION_TTL = 6 * 3600


def _versions_file():
    base = os.environ.get("DISPATCH_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".dispatch")
    return os.path.join(base, "engines-versions.json")


def _read_versions():
    try:
        with open(_versions_file()) as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def forget_versions():
    """After an install or upgrade: every copy is asked again."""
    _VERSION_CACHE.clear()
    try:
        os.remove(_versions_file())
    except FileNotFoundError:
        pass


def version_output(path, timeout=20):
    """What `path --version` prints (stdout and stderr), remembered per file in this process and on disk while it
    names a version; '' when the file is not there, the copy does not start or it takes longer than `timeout`."""
    try:
        st = os.stat(path)
    except OSError:
        return ""
    key = (path, st.st_mtime_ns, st.st_size)
    if key in _VERSION_CACHE:
        return _VERSION_CACHE[key]
    saved = _read_versions().get(path)
    if (isinstance(saved, dict) and saved.get("mtime") == st.st_mtime_ns and saved.get("size") == st.st_size
            and time.time() - float(saved.get("at") or 0) < VERSION_TTL and isinstance(saved.get("text"), str)):
        _VERSION_CACHE[key] = saved["text"]
        return saved["text"]
    try:
        r = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=timeout, env=_child_env(), stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return ""
    text = (r.stdout or "") + (r.stderr or "")
    if parse_version(text):
        _VERSION_CACHE[key] = text
        saved = _read_versions()
        saved[path] = {"mtime": st.st_mtime_ns, "size": st.st_size, "at": time.time(), "text": text[:2000]}
        try:
            os.makedirs(os.path.dirname(_versions_file()), exist_ok=True)
            tmp = f"{_versions_file()}.{os.getpid()}.tmp"
            with open(tmp, "w") as fh:
                json.dump(saved, fh)
            os.replace(tmp, _versions_file())
        except OSError:
            pass  # a read-only data folder: asked again next time
    return text


def installed_version(path, timeout=20):
    """The version `path --version` names (version_output), '' when it names none."""
    out = version_output(path, timeout)
    m = _VERSION.search(out)
    return m.group(1) if m else ""


def method(eng, path):
    """How this copy was installed, from where it lives: (method, detail). detail is the npm prefix,
    the Homebrew name or ''."""
    real = os.path.realpath(path)
    if "/Caskroom/" in real or "/Cellar/" in real:
        m = re.search(r"/(Caskroom|Cellar)/([^/]+)/", real)
        return "brew", ("--cask " if m and m.group(1) == "Caskroom" else "") + (m.group(2) if m else eng.brew[-1])
    if eng.native_install(real):
        return "native", ""
    if "/.bun/" in path or "/.bun/" in real:
        return "bun", ""
    m = re.match(r"^(.*)/lib/node_modules/", real)
    if m:
        return "npm", m.group(1)
    if "/node_modules/" in real:
        # a local node_modules (bun's global folder can be the home folder): the package manager
        # that linked it into PATH decides
        return ("bun" if "/.bun/" in path else "npm"), ""
    return "unknown", ""


def upgrade_command(eng, meth, detail, path=""):
    """The argv that brings this copy to the newest version."""
    pkg = eng.package + "@latest"
    if meth == "native":
        return [path or eng.bin, *eng.self_update_args]
    if meth == "brew":
        return ["brew", "upgrade", *detail.split()]
    if meth == "bun":
        return [which("bun") or "bun", "add", "-g", pkg]
    if meth == "npm":
        npm = os.path.join(detail, "bin", "npm") if detail and os.path.exists(os.path.join(detail, "bin", "npm")) else (which("npm") or "npm")
        return [npm, "i", "-g", *(["--prefix", detail] if detail else []), pkg]
    # unknown: the engine's own updater where it has one, else npm
    if eng.self_update_args:
        return [path or eng.bin, *eng.self_update_args]
    return [which("npm") or "npm", "i", "-g", pkg]


def no_installer_message(eng):
    """What to say when this Mac has no way to install `eng` (an engine without its own no_installer_message)."""
    return (f"{eng.name} installs with Node.js, and this Mac has neither Node.js nor Homebrew. "
            "Install Node.js from nodejs.org, then click Install again.")


def install_command(eng):
    """How to put an engine on this Mac. Claude Code and OpenCode: their own installer script (`curl … | bash`, into
    ~/.local/bin and ~/.opencode/bin), which needs neither Node.js nor Homebrew: a new Mac has neither, and the
    Install button used to fail with half a sentence there (task-jvtg). Codex has no such script: npm, else Homebrew."""
    if eng.install_script and os.path.exists("/usr/bin/curl") and not P_IS_WIN():
        return ["/bin/bash", "-c", f"curl -fsSL {eng.install_script} | bash"]
    npm = which("npm")
    if npm:
        return [npm, "i", "-g", eng.package + "@latest"]
    if which("brew") and eng.brew:
        return ["brew", "install", *eng.brew]
    return []


def P_IS_WIN():
    return os.name == "nt"


def is_script(cmd):
    return len(cmd) == 3 and cmd[:2] == ["/bin/bash", "-c"] and cmd[2].startswith("curl ")


def _registry():
    """npm's address for the newest versions: DISPATCH_NPM_REGISTRY, else the mirror in China when the download source
    says so (mirrors.py; auto goes by the last network check, without asking the network here)."""
    if os.environ.get("DISPATCH_NPM_REGISTRY"):
        return REGISTRY
    try:
        import mirrors, net
        china = mirrors.effective(mirrors.mode(), (net._read(net.check_path()).get("results") or {}))["use"] == "china"
    except Exception:  # noqa: BLE001
        china = False
    return mirrors.NPM_CHINA if china else REGISTRY


def _fetch_latest(pkg, timeout=8):
    import urllib.parse, urllib.request  # only here: a hook that imports the registry should not pay for them
    url = f"{_registry()}/{urllib.parse.quote(pkg, safe='@')}/latest"
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "dispatch-cli"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r).get("version") or ""


def latest_versions(refresh=False, fetch=None, now=None, offline=False):
    """{package: version} from npm, cached for an hour; offline, the last answer (or ''). `offline=True` never asks npm."""
    fetch = fetch or _fetch_latest
    now = time.time() if now is None else now
    cached = {}
    try:
        with open(CACHE) as fh:
            cached = json.load(fh)
    except Exception:
        cached = {}
    if offline:
        return dict(cached.get("versions") or {}), float(cached.get("checked_at") or 0)
    if not refresh and now - float(cached.get("checked_at") or 0) < TTL and all(e.package in (cached.get("versions") or {}) for e in managed()):
        return cached["versions"], cached["checked_at"]
    versions, ok = dict(cached.get("versions") or {}), False
    for e in managed():
        try:
            v = fetch(e.package)
            if v:
                versions[e.package] = v
                ok = True
        except Exception:
            pass
    if not ok:
        return versions, float(cached.get("checked_at") or 0)
    try:
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        tmp = CACHE + ".tmp"
        with open(tmp, "w") as fh:
            json.dump({"checked_at": now, "versions": versions}, fh)
        os.replace(tmp, CACHE)
    except Exception:
        pass
    return versions, now


def status(eng, latest, checked_at=0):
    path = engine_path(eng)
    row = {"id": eng.id, "name": eng.name, "package": eng.package, "installed": bool(path), "path": path or "",
           "version": "", "latest": latest or "", "update_available": False, "method": "", "command": "", "checked_at": checked_at,
           "min_version": min_version_text(eng), "supported": True}
    if not path:
        cmd = install_command(eng)
        row["command"] = " ".join(_short(cmd))
        return row
    row["version"] = installed_version(path)
    minimum = eng.min_version
    if minimum and row["version"]:
        # a copy whose --version did not answer (a busy Mac, a first start that sets up its data) is not called too
        # old: the window said "OpenCode ? is too old" over a 1.18.35 that was only slow to answer
        row["supported"] = vtuple(row["version"]) >= minimum + (1,)
    meth, detail = method(eng, path)
    row["method"] = meth
    row["command"] = " ".join(_short(upgrade_command(eng, meth, detail, path)))
    row["update_available"] = bool(latest and row["version"] and vtuple(latest) > vtuple(row["version"]))
    return row


def _short(argv):
    """The command as a person would type it: bare program names, ~ for home; an installer script as its curl line."""
    if is_script(list(argv)):
        return [argv[2]]
    out = []
    for i, a in enumerate(argv):
        if i == 0 and os.path.isabs(a) and shutil.which(os.path.basename(a), path=search_path()) == a:
            a = os.path.basename(a)
        out.append(a.replace(HOME, "~", 1) if a.startswith(HOME) else a)
    return out


def engines(refresh=False, only="", offline=False):
    versions, checked_at = latest_versions(refresh, offline=offline)
    return [status(e, versions.get(e.package, ""), checked_at) for e in managed() if not only or e.id == only]


def mirrored_command(eng, cmd, china):
    """The install or update command for downloads from the mirrors in China (mirrors.py): npm and bun get the mirror's
    registry; OpenCode's own updater (it downloads from GitHub) becomes an npm install of the same package when npm is
    here. Claude Code's own updater stays: a second copy from npm would not be the one that runs."""
    import mirrors
    if not china or not cmd:
        return list(cmd)
    if is_script(list(cmd)) and which("npm"):
        # the installer scripts download from claude.ai / GitHub: the same package from the mirror's npm instead
        return mirrors.with_registry([which("npm"), "i", "-g", eng.package + "@latest"], True)
    prog = os.path.basename(cmd[0])
    if eng.mirror_self_update and prog == eng.bin and which("npm"):
        return mirrors.with_registry([which("npm"), "i", "-g", eng.package + "@latest"], True)
    return mirrors.with_registry(cmd, True)


def _run_install(cmd, stream, china):
    import mirrors
    env = _child_env()
    env.update(mirrors.env(china))
    p = subprocess.run(cmd, stdout=stream, stderr=stream, stdin=subprocess.DEVNULL, timeout=900, env=env)
    return p.returncode


def upgrade(eng_id, dry_run=False, stream=sys.stderr, china=None):
    """Run the update (or install) for one engine; {ok, id, before, after, command, message, mirror}. `china`: download
    from the mirrors in China (None: the setting decides; auto tries the official server first and the mirrors after a
    failure)."""
    import mirrors
    eng = find(eng_id)
    if not eng or not eng.package:
        return {"ok": False, "error": "unknown", "message": f"unknown engine {eng_id}: one of {', '.join(e.id for e in managed())}"}
    eng_id = eng.id
    path = engine_path(eng)
    before = installed_version(path) if path else ""
    base = upgrade_command(eng, *method(eng, path), path) if path else install_command(eng)
    if not base:
        return {"ok": False, "id": eng_id, "error": "no_installer", "command": "", "message": eng.no_installer_message or no_installer_message(eng)}
    setting = mirrors.mode()
    china = mirrors.use_china(setting) if china is None else china
    cmd = mirrored_command(eng, base, china)
    res = {"id": eng_id, "before": before, "command": " ".join(_short(cmd)), "mirror": "china" if china else "official"}
    if dry_run:
        return dict(res, ok=True, after=before, dry_run=True)
    try:
        code = _run_install(cmd, stream, china)
        if code != 0 and not china and setting == "auto" and mirrored_command(eng, base, True) != list(base):
            # the official server failed: once more from the mirrors in China
            if hasattr(stream, "write"):
                print("Trying the mirrors in China (npmmirror) …", file=stream)
            cmd = mirrored_command(eng, base, True)
            res.update(command=" ".join(_short(cmd)), mirror="china")
            code = _run_install(cmd, stream, True)
    except Exception as e:
        return dict(res, ok=False, after=before, error="failed", message=str(e))
    forget_versions()
    path = engine_path(eng)
    after = installed_version(path) if path else ""
    if code != 0:
        return dict(res, ok=False, after=after, error="failed", message=f"`{res['command']}` exited with {code}")
    if after:
        res.update(eng.after_install())
    return dict(res, ok=bool(after), after=after, path=path or "",
                message=(f"{eng.name} {after}" if after else f"{eng.name} not found after `{res['command']}`"))


def join_words(words, conj="and"):
    """'Claude Code and Codex', 'A, B and C' (or with `conj` "or"): for sentences that name engines."""
    words = list(words)
    return f" {conj} ".join(words) if len(words) < 3 else ", ".join(words[:-1]) + f" {conj} " + words[-1]


def login(eng_id, timeout=300, run=None):
    """Sign in to an engine that has a sign-in command (Claude Code's `auth login`, Codex's `login`): it opens the
    browser and waits for the person to finish there. {ok, id, message}; the account line is read again by the caller."""
    eng = find(eng_id)
    if not eng or eng.login_args is None:
        can = join_words(e.name for e in managed() if e.login_args is not None)
        return {"ok": False, "id": eng_id, "message": f"Dispatch can open the sign-in page for {can} only."}
    path = engine_path(eng)
    if not path:
        return {"ok": False, "id": eng_id, "message": f"{eng.name} is not installed yet."}
    env = _child_env()
    env.pop("CLAUDE_CODE_OAUTH_TOKEN", None)  # a leftover token would sign in as another account
    try:
        r = (run or subprocess.run)([path, *eng.login_args], capture_output=True, text=True, timeout=timeout, env=env, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return {"ok": False, "id": eng_id, "message": "The sign-in page was not finished in 5 minutes. Try again."}
    except OSError as e:
        return {"ok": False, "id": eng_id, "message": str(e)}
    tail = " ".join(((r.stdout or "") + " " + (r.stderr or "")).split())[-200:]
    if r.returncode != 0:
        return {"ok": False, "id": eng_id, "message": tail or f"{eng.name} could not sign in."}
    return {"ok": True, "id": eng_id, "message": f"Signed in to {eng.name}."}


def _agents_command(a, as_json):
    """`engines detect | enabled | use`: every agent CLI on this Mac and the choice of which ones Dispatch uses
    (agents_catalog.py). Answers {ok, ...}; a refused choice answers ok false with the reason."""
    import agents_catalog as AC
    if a.op == "detect":
        import onboarding
        out = {"ok": True, "agents": onboarding.agent_rows(), **AC.load_choice()}
    elif a.op == "enabled":
        out = {"ok": True, **AC.load_choice()}
    else:
        try:
            out = {"ok": True, **AC.save_choice(off=getattr(a, "off", None), on=getattr(a, "on", None), default=getattr(a, "default", None), reset=getattr(a, "reset", False))}
        except ValueError as e:
            out = {"ok": False, "message": str(e)}
    if out.get("ok"):
        # every answer that carries the choice also says what is here, so the window never offers what is not
        out.update(installed_and_default(out))
    if as_json:
        print(json.dumps(out, ensure_ascii=False))
    elif not out["ok"]:
        print(out["message"], file=sys.stderr)
    elif a.op == "detect":
        for r in out["agents"]:
            if r["installed"] or r["runnable"]:
                state = ("on*" if r["is_default"] else "on ") if r["enabled"] else "off"
                run = "" if r["runnable"] else "  (Dispatch cannot start sessions with it yet)"
                print(f"{state} {r['name']:<20} {r['version'] or '?':<14} {r['account']:<26} {r['path'] or 'not found'}{run}")
    else:
        print(f"off: {', '.join(out['off']) or '-'}   on: {', '.join(out['on']) or '-'}   default: {out['default'] or '-'}")
    sys.exit(0 if out["ok"] else 1)


def installed_and_default(choice):
    """Which of the agents Dispatch runs are on this Mac (a `which`, no version check), and the one a new session starts
    with: the saved default while it is here and on, else the first here and on. A new Mac with only OpenCode used to
    start every new session on Claude Code, which was not there to answer (task-6vw2)."""
    installed = [e.id for e in runnable() if which(e.bin)]
    here = [i for i in installed if i not in choice.get("off", [])]
    return {"installed": installed, "effective": choice.get("default") if choice.get("default") in here else (here[0] if here else "")}


def command(a):
    as_json = getattr(a, "json", False)
    if getattr(a, "op", "") in ("detect", "enabled", "use"):
        return _agents_command(a, as_json)
    if getattr(a, "op", "") == "login":
        out = login(a.name or "")
        print(json.dumps(out, ensure_ascii=False) if as_json else out["message"], file=sys.stdout if out["ok"] or as_json else sys.stderr)
        sys.exit(0 if out["ok"] else 1)
    if getattr(a, "op", "") == "opencode-kit":
        # OpenCode's plugin kit from inside Dispatch IDE into its config folders (opencode_kit.py)
        import opencode_kit
        return opencode_kit.command(a)
    if getattr(a, "op", "") in ("status", "install-plugin", "uninstall-plugin"):
        # OpenCode's providers, keys, default model, allowance and Dispatch's plugin (opencode_engine.py)
        if (a.name or "opencode") != "opencode":
            print("dispatch engines status|install-plugin|uninstall-plugin opencode", file=sys.stderr)
            sys.exit(2)
        import opencode_engine as O
        if a.op in ("install-plugin", "uninstall-plugin"):
            r = O.install_plugin() if a.op == "install-plugin" else O.uninstall_plugin()
            if as_json:
                print(json.dumps(r, ensure_ascii=False))
            else:
                label = "installed: " if a.op == "install-plugin" else "uninstalled: "
                print(r.get("skipped") or ("unchanged: " if r.get("unchanged") else label) + r["path"])
            sys.exit(1 if r.get("skipped") else 0)
        s = O.status(refresh=getattr(a, "refresh", False))
        print(json.dumps(s, ensure_ascii=False, indent=2) if as_json else O.status_text(s))
        return
    if getattr(a, "op", "") == "upgrade":
        if not a.name:
            print("dispatch engines upgrade <%s>" % "|".join(e.id for e in managed()), file=sys.stderr)
            sys.exit(2)
        r = upgrade(a.name, dry_run=a.dry_run, stream=sys.stderr)
        if as_json:
            print(json.dumps(r, ensure_ascii=False))
        else:
            print(("✓ " if r.get("ok") else "✗ ") + (r.get("message") or f"{r.get('before')} → {r.get('after')}  ({r.get('command')})"))
        sys.exit(0 if r.get("ok") else 1)
    rows = engines(refresh=getattr(a, "refresh", False), only=getattr(a, "name", "") or "", offline=getattr(a, "offline", False))
    if as_json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    for r in rows:
        if not r["installed"]:
            print(f"· {r['name']:<12} not installed      latest {r['latest'] or '?':<10} install: {r['command']}")
            continue
        state = f"update → {r['latest']}" if r["update_available"] else "up to date" if r["latest"] else "latest unknown"
        print(f"✓ {r['name']:<12} {r['version'] or '?':<18} {state:<22} {r['method']}: {r['command']}")
