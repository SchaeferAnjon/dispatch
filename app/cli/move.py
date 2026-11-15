# -*- coding: utf-8 -*-
"""Move a conversation — or a whole project — to another Mac and carry on there (`dispatch move`,
`dispatch project <名> --move-to <主机>`).

A conversation is a transcript file plus a working directory. Moving it means handing the project
over, not copying a snapshot:
  1. Git preflight on both Macs: same remote, the target has no commits or uncommitted edits the
     source lacks. Any conflict stops the move (--force overrides) so nothing over there is lost;
  2. rsync the project folder (uncommitted changes and .git included) to the same place relative to
     the other Mac's home, deleting what the source deleted but protecting ignored build output that
     only exists over there; a dry run lists the changes first;
  3. check the tools the conversation used are installed there (brew what can be);
  4. copy the transcript into that Mac's agent history, home paths rewritten, and resume it through
     that Mac's Dispatch with a hand-off prompt;
  5. hand the project over: stop the original once it is idle (so two copies never fork), name
     other sessions still working on it here, record that Mac as the project's owner (new sessions
     for the project default to it) and verify the Git state over there matches.
Supports Claude Code and Codex (both resume by id). A project with no conversation running moves
on its own: the folder is synced and a new session opens in it over there.
"""
import base64, hashlib, json, os, re, shlex, signal, subprocess, sys, time
from lang import t as _t

import dispatch as D
import dplatform as P
import engines as E

FEATURE = _t("Moving a project", "项目搬家")

# Never copied, at any depth: caches and dependency trees the other Mac rebuilds or reinstalls, and
# the git worktrees Claude Code's sub-agents leave under .claude/ (one real project had 107k files in there —
# a 72 s dry run for a project of a few hundred files).
EXCLUDES = [".DS_Store", "*.pyc", "__pycache__/", "node_modules/", ".venv/", "venv/", ".claude/worktrees/", "DerivedData/",
            ".turbo/", ".cache/", ".parcel-cache/", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/"]
# One ssh connection per Mac, reused by every ssh / rsync / git call of a move (ControlMaster): each
# fresh connection to the other Mac costs ~0.7 s and a move makes dozens of them.
# Windows' OpenSSH has no ControlMaster: plain connections there (kept so the move can be switched on later).
SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"] + ([] if P.IS_WIN else ["-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/dispatch-ssh-%C", "-o", "ControlPersist=180"])
SSH_CMD = "ssh " + " ".join(SSH_OPTS)
# Tools a conversation used, mapped to what installs them on the other Mac. Anything else
# that is missing is reported so the agent (and you) know before it trips over it.
BREW = {"node": "node", "npm": "node", "npx": "node", "pnpm": "pnpm", "yarn": "yarn", "python3": "python", "pip3": "python", "cargo": "rust", "rustc": "rust", "go": "go", "java": "openjdk",
        "gh": "gh", "jq": "jq", "rg": "ripgrep", "fd": "fd", "bat": "bat", "eza": "eza", "tmux": "tmux", "dolt": "dolt", "bd": "beads", "ffmpeg": "ffmpeg", "pdftotext": "poppler", "pdftoppm": "poppler",
        "pandoc": "pandoc", "wget": "wget", "tree": "tree", "watchman": "watchman", "pod": "cocoapods", "xcodegen": "xcodegen", "swiftlint": "swiftlint", "fastlane": "fastlane", "docker": "docker", "psql": "libpq", "sqlite3": "sqlite", "uv": "uv", "bun": "bun", "deno": "deno"}
KNOWN = set(BREW) | {"xcodebuild", "xcrun", "swift", "simctl", "claude", "codex", "pi", "gemini", "make", "cmake", "pytest", "mvn", "gradle", "flutter", "dart", "ruby", "bundle", "gem", "php", "composer", "dotnet", "kubectl", "terraform", "aws", "gcloud", "redis-cli", "mysql", "adb", "vite", "tsc", "eslint", "prettier", "playwright", "conda", "poetry", "pipx", "ollama", "hugo", "zola", "mkdocs", "latexmk", "pdflatex", "xelatex", "convert", "magick", "exiftool", "yt-dlp", "sox", "whisper", "rustup", "wasm-pack", "protoc", "nvim", "vim", "code", "cursor"}
MANUAL = {"xcodebuild": _t("Xcode (App Store)", "Xcode（App Store）"), "xcrun": _t("Xcode (App Store)", "Xcode（App Store）"),
          "swift": _t("Xcode or the Swift toolchain", "Xcode 或 Swift toolchain"), "simctl": "Xcode", "open": "", "osascript": "",
          # an engine the conversation ran: how it installs (its adapter's npm package)
          **{e.bins[0]: _t(f"{e.name} (npm i -g {e.package})", f"{e.name}（npm i -g {e.package}）") for e in E.managed() if e.package and e.bins}}
SKIP = {"cd", "echo", "cat", "ls", "export", "set", "source", "env", "sudo", "time", "sleep", "true", "false", "test", "printf", "read", "for", "if", "while", "do", "done", "then", "fi", "command", "which", "type", "mkdir", "rm", "cp", "mv", "touch", "chmod", "chown", "ln", "head", "tail", "grep", "sed", "awk", "sort", "uniq", "wc", "cut", "tr", "xargs", "find", "tee", "date", "kill", "pkill", "pgrep", "ps", "git", "ssh", "scp", "rsync", "curl", "python", "bash", "sh", "zsh", "fish", "nohup", "exit", "return", "pwd", "dirs", "basename", "dirname", "realpath", "stat", "du", "df", "diff", "patch", "tar", "zip", "unzip", "gzip", "open", "osascript", "pbcopy", "pbpaste", "say", "defaults", "launchctl", "xattr", "ditto", "security", "screencapture", "lsof", "netstat", "ping", "dig", "nc", "brew", "dispatch", "timeout"}
PATH_PREFIX = "export PATH=$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH; "


def commands_used(path, agent):
    """Executables the agent ran in this conversation (first word of each shell command)."""
    seen = set()
    try:
        for line in open(path, encoding="utf-8", errors="replace"):
            if '"command"' not in line and '"cmd"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            blocks = []
            m = d.get("message") or {}
            content = m.get("content") if isinstance(m, dict) else None
            for b in content if isinstance(content, list) else []:
                if isinstance(b, dict) and b.get("type") == "tool_use" and isinstance(b.get("input"), dict):
                    c = b["input"].get("command")
                    if isinstance(c, str):
                        blocks.append(c)
                elif isinstance(b, dict) and b.get("type") == "toolCall" and isinstance(b.get("arguments"), dict):  # pi
                    c = b["arguments"].get("command")
                    if isinstance(c, str):
                        blocks.append(c)
            p = d.get("payload") or {}
            if isinstance(p, dict) and p.get("type") in ("function_call", "custom_tool_call"):
                args = p.get("arguments")
                try:
                    aj = json.loads(args) if isinstance(args, str) else (args or {})
                    c = aj.get("cmd") or aj.get("command")
                    if isinstance(c, list):
                        c = " ".join(map(str, c))
                    if isinstance(c, str):
                        blocks.append(c)
                except Exception:
                    pass
            for c in blocks:
                c = c.split("<<", 1)[0]  # heredoc bodies are data, not commands
                for seg in re.split(r"&&|\|\||\||;|\n", c):
                    words = seg.strip().split()
                    while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):
                        words.pop(0)
                    if words:
                        w = os.path.basename(words[0].strip("()\"'"))
                        if w in KNOWN and w not in SKIP:
                            seen.add(w)
    except OSError:
        pass
    return sorted(seen)


# ---------------------------------------------------------------- running things over there

def bash_line(script):
    """A command line that runs `script` under bash whatever the login shell is. The Mac mini logs
    in to fish, which cannot parse `for …; do`, `$?` or `export PATH=a:$PATH` (every bash snippet
    sent before silently failed there), and fish single quotes still eat `\\\\`. Base64 has neither
    quotes nor backslashes, and stdin stays free for data."""
    b64 = base64.b64encode(script.encode()).decode()
    return f"/bin/bash -c 'eval \"$(printf %s {b64} | /usr/bin/base64 --decode)\"'"


def run_remote(h, script, timeout=60, input=None):
    return subprocess.run(["ssh", *SSH_OPTS, h["ssh"], bash_line(PATH_PREFIX + script)],
                          input=input, capture_output=True, text=True, errors="replace", timeout=timeout)


def ssh(h, cmd, timeout=60, check=True):
    r = run_remote(h, cmd, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"{h['name']}：{(r.stderr or r.stdout).strip()[-300:]}")
    return r.stdout


def preflight(h, path, agent, install=True):
    """Which of the tools this conversation used are missing over there; brew what it can."""
    used = commands_used(path, agent)
    if not used:
        return {"used": [], "missing": [], "installed": [], "manual": {}}
    script = "for c in " + " ".join(shlex.quote(u) for u in used) + '; do command -v "$c" >/dev/null 2>&1 || echo "$c"; done'
    missing = [x for x in ssh(h, script, timeout=60, check=False).split() if x]
    installed, manual = [], {}
    if install and missing:
        formulas = sorted({BREW[m] for m in missing if m in BREW})
        if formulas and run_remote(h, "brew install --quiet " + " ".join(formulas), timeout=1800).returncode == 0:
            installed = formulas
        missing = [x for x in ssh(h, script, timeout=60, check=False).split() if x]
    for m in missing:
        manual[m] = MANUAL.get(m, BREW.get(m, "") and f"brew install {BREW[m]}") or _t("install it yourself", "自己装")
    return {"used": used, "missing": missing, "installed": installed, "manual": manual}


def find_ref(session_id):
    refs = D.session_refs(D.load_index(), session_id=session_id)
    if not refs:
        # A conversation started seconds ago is not indexed yet.
        try:
            D.refresh_index()
        except Exception:
            pass
        refs = D.session_refs(D.load_index(), session_id=session_id)
    if not refs:
        raise RuntimeError(_t(f"This Mac has no such session: {session_id}", f"本机没有这个会话：{session_id}"))
    return refs[0]


def host_by(name):
    for h in D.hosts():
        if name.lower() in (h["id"].lower(), h["name"].lower()) or name in (h.get("aliases") or []):
            return h
    raise RuntimeError(_t(f"No {name} in hosts.json; join this Mac in that Mac's first-run setup first, or the other way round", f"hosts.json 里没有 {name}；先在那台电脑的首次设置里接入这台，或者反过来"))


def remote_path(cwd, remote_home):
    if cwd.startswith(D.HOME + "/"):
        return remote_home + cwd[len(D.HOME):]
    if cwd == D.HOME:
        return remote_home
    return cwd  # outside home (e.g. /opt/x): same absolute path


# Agents whose conversations move: the ones Dispatch's in-app chat resumes (`agent start --resume`).
MOVABLE = tuple(e.agent for e in E.known() if e.supports("move_target"))


def transcript_target(agent, path, cwd, remote_home, remote_cwd):
    """Where the transcript goes on the other Mac, and whether its text needs the home path rewritten."""
    eng = E.get(agent)
    if agent not in MOVABLE:
        raise RuntimeError(_t(f"{agent} sessions cannot be moved yet (for now: {E.join_words([E.get(a).name for a in MOVABLE], 'and')})", f"{agent} 的会话还不支持迁移（目前支持 {E.join_words([E.get(a).name for a in MOVABLE], '和')}）"))
    return eng.move_target(path, remote_home, remote_cwd)


# ---------------------------------------------------------------- Git preflight

# Runs with the same code on both Macs (python3 ships with the Command Line Tools). Reports the repo
# that holds `cwd`: remote, HEAD, every uncommitted path with a content hash, and ignored entries.
GIT_SCRIPT = r"""
import hashlib, json, os, subprocess, sys
cwd = sys.argv[1]
def git(*a, strip=True):
    try:
        r = subprocess.run(["git", "-C", cwd, *a], capture_output=True, text=True, errors="replace", timeout=120)
    except Exception:
        return None
    return (r.stdout.strip() if strip else r.stdout) if r.returncode == 0 else None
def digest(p):
    try:
        h = hashlib.sha1()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except IsADirectoryError:
        return "dir"
    except OSError:
        return None
out = {"exists": os.path.isdir(cwd), "git": False}
if out["exists"] and git("rev-parse", "--is-inside-work-tree") == "true":
    top = git("rev-parse", "--show-toplevel")
    out.update(git=True, top=top, head=git("rev-parse", "HEAD") or "", branch=git("rev-parse", "--abbrev-ref", "HEAD") or "",
               remote=git("config", "--get", "remote.origin.url") or "", stashes=(git("stash", "list", "--format=%H") or "").split())
    dirty, ignored = {}, []
    raw = (git("status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", strip=False) or "").split("\0")
    i = 0
    while i < len(raw):
        e = raw[i]; i += 1
        if len(e) < 4:
            continue
        xy, p = e[:2], e[3:]
        if xy[0] in "RC":
            i += 1  # the next entry is the rename's source path
        if xy == "!!":
            if len(ignored) < 300:
                ignored.append(p)
            continue
        if len(dirty) < 2000:
            dirty[p] = digest(os.path.join(top, p))
    out.update(dirty=dirty, ignored=ignored)
print(json.dumps(out))
"""


def git_state_local(cwd):
    r = subprocess.run(["/usr/bin/python3", "-", cwd], input=GIT_SCRIPT, capture_output=True, text=True, errors="replace", timeout=180)
    return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else {"exists": os.path.isdir(cwd), "git": False, "error": r.stderr.strip()[-200:]}


def git_state_remote(h, cwd):
    r = run_remote(h, "/usr/bin/python3 - " + shlex.quote(cwd), timeout=180, input=GIT_SCRIPT)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise RuntimeError(_t(f"Cannot read the Git state of {cwd} on {h['name']}: {(r.stderr or r.stdout).strip()[-200:]}", f"读不到 {h['name']} 上 {cwd} 的 Git 状态：{(r.stderr or r.stdout).strip()[-200:]}"))


def same_remote(a, b):
    """git@github.com:x/y.git, https://github.com/x/y and ssh://git@github.com/x/y are one repo."""
    def norm(u):
        u = (u or "").strip().lower()
        u = re.sub(r"^(ssh://)?git@([^:/]+)[:/]", r"\2/", u)
        u = re.sub(r"^https?://([^@/]*@)?", "", u)
        return re.sub(r"\.git$", "", u.rstrip("/"))
    return norm(a) == norm(b)


def local_hash(top, path):
    p = os.path.join(top, path)
    if os.path.isdir(p):
        return "dir"
    try:
        h = hashlib.sha1()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def git_conflicts(local, remote, is_ancestor, local_file_hash):
    """What moving would destroy over there. `is_ancestor(commit)`: is that commit in the source's
    history; `local_file_hash(path)`: the source's content for a path (None when absent). Pure, so
    the rules are tested without two Macs."""
    if not remote.get("exists"):
        return []
    if not local.get("git"):
        return [] if not remote.get("git") else [_t("That folder over there is a Git repository and this one is not: it does not look like the same project", "对方这个目录是 Git 仓库，这边不是：不像同一个项目")]
    if not remote.get("git"):
        return [_t("The other Mac has a folder of that name that is not a Git repository: merging into it would mix things up", "对方已有同名目录但不是 Git 仓库：合并进去会混在一起")]
    out = []
    if local.get("remote") and remote.get("remote") and not same_remote(local["remote"], remote["remote"]):
        out.append(_t(f"Not the same repository: here {local['remote']}, there {remote['remote']}", f"两边不是同一个仓库：这边 {local['remote']}，对方 {remote['remote']}"))
        return out
    rhead = remote.get("head") or ""
    if rhead and rhead != local.get("head") and not is_ancestor(rhead):
        out.append(_t(f"The other Mac has commits this one lacks (its HEAD {rhead[:7]} is not in this history): push there and pull here before moving", f"对方有这边没有的提交（对方 HEAD {rhead[:7]} 不在这边的历史里）：先在对方 push，这边 pull 后再迁"))
    changed = [p for p, h in (remote.get("dirty") or {}).items() if h != local_file_hash(p)]
    if changed:
        more = _t(f" and {len(changed) - 5} more", f" 等 {len(changed)} 个") if len(changed) > 5 else ""
        out.append(_t("The other Mac has uncommitted changes that differ from these and would be overwritten: ", "对方有未提交的改动与这边不同，会被覆盖：") + _t(", ", "、").join(sorted(changed)[:5]) + more)
    return out


def git_preflight(h, cwd, remote_cwd):
    local = git_state_local(cwd)
    remote = git_state_remote(h, remote_cwd)
    top = local.get("top") or cwd

    def is_ancestor(commit):
        if subprocess.run(["git", "-C", top, "cat-file", "-e", commit + "^{commit}"], capture_output=True).returncode != 0:
            return False
        return subprocess.run(["git", "-C", top, "merge-base", "--is-ancestor", commit, "HEAD"], capture_output=True).returncode == 0

    conflicts = git_conflicts(local, remote, is_ancestor, lambda p: local_hash(top, p))
    summary = lambda s: {k: s.get(k) for k in ("exists", "git", "head", "branch", "remote")} | {"dirty": len(s.get("dirty") or {})}
    return {"local": summary(local), "remote": summary(remote), "conflicts": conflicts, "history": bool(local.get("git") and remote.get("git")),
            "protect": protected_paths(remote), "skip": build_excludes(local), "_top": top}


def repo_top(cwd):
    r = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], capture_output=True, text=True, errors="replace")
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else ""


def push_history(h, top, remote_top, local, on_percent=None):
    """Both Macs have the repo: bring the target's history to the source's with Git itself instead of
    copying .git. The two object stores are laid out differently (loose here, packed there: rsync wanted
    to resend 9,133 objects for two commits), and the target's own stash, reflog and packed refs must
    survive. Push HEAD to a private ref, point the same branch at it and reset only the index — the
    working tree then comes over with rsync, so uncommitted edits end up exactly as they are here."""
    sha, branch = local.get("head") or "", local.get("branch") or "HEAD"
    if not sha:
        return {"pushed": False}
    env = {**os.environ, "GIT_SSH_COMMAND": SSH_CMD}
    # --progress: git writes "Writing objects:  45% (…)" to stderr as it goes (a 30 MB repo over a
    # relayed Tailscale link takes over a minute; the bar must not sit still meanwhile).
    proc = subprocess.Popen(["git", "-C", top, "push", "--progress", "--no-verify", "--receive-pack=git receive-pack", f"ssh://{h['ssh']}{remote_top}", f"+{sha}:refs/dispatch/moved"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace", env=env)
    tail, buf = [], ""
    while True:
        chunk = proc.stderr.read(256)
        if not chunk:
            break
        buf += chunk
        parts = re.split(r"[\r\n]", buf)
        buf = parts.pop()
        for line in parts:
            if line.strip():
                tail = (tail + [line])[-12:]
            m = re.search(r"(Writing|Compressing|Counting) objects:\s+(\d+)%", line)
            if m and on_percent:
                try:
                    on_percent({"Counting": 5, "Compressing": 25, "Writing": 100}[m.group(1)] * int(m.group(2)) / 100)
                except Exception:
                    pass
    if proc.wait() != 0:
        raise RuntimeError(_t(f"Pushing the Git history to {h['name']} failed: {' '.join(tail).strip()[-300:]}", f"推送 Git 历史到 {h['name']} 失败：{' '.join(tail).strip()[-300:]}"))
    q = shlex.quote
    point = (f"git symbolic-ref HEAD {q('refs/heads/' + branch)} && git update-ref {q('refs/heads/' + branch)} {sha}" if branch != "HEAD"
             else f"git update-ref --no-deref HEAD {sha}")
    r = run_remote(h, f"cd {q(remote_top)} && {point} && git reset -q {sha} && git update-ref -d refs/dispatch/moved", timeout=300)
    if r.returncode != 0:
        raise RuntimeError(_t(f"Switching to {sha[:7]} on {h['name']} failed: {(r.stderr or r.stdout).strip()[-300:]}", f"{h['name']} 上切到 {sha[:7]} 失败：{(r.stderr or r.stdout).strip()[-300:]}"))
    return {"pushed": True, "head": sha[:7], "branch": branch}


def protected_paths(remote):
    """What --delete must never remove over there: everything Git ignores on that Mac (its build/
    holds device and simulator products the source's build/ does not — mirroring deleted ~10k files
    in the first dry run) and .git itself (its own stash, packed refs and objects; the source's refs
    and objects are still copied in)."""
    return sorted(set(remote.get("ignored") or []) | ({".git/"} if remote.get("git") else set()))


# Ignored directories that are build output or caches: rebuilt or reinstalled on the other Mac, never
# copied (one real project's build/ was 37 GB). Other ignored paths — .env files, Sources/Private — do travel.
BUILD_DIRS = re.compile(r"^(build(-.+)?|DerivedData|\.build|dist|target|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache|coverage|node_modules|Pods|\.gradle|\.?venv([-_.].+)?|\.tox|\.mypy_cache|\.pytest_cache)$")


def build_excludes(local):
    return sorted(p for p in (local.get("ignored") or []) if p.endswith("/") and BUILD_DIRS.match(os.path.basename(p.rstrip("/"))))


# ---------------------------------------------------------------- files

def rsync_args(cwd, h, remote_cwd, protect, delete, dry, skip=(), history=False):
    # Size + mtime (rsync's default) decides what to send: -a keeps mtimes, so after the first move
    # identical files cost nothing. -c (checksum every file on both Macs) made a 100k-file tree take
    # over a minute just to plan.
    args = ["rsync", "-a", "--modify-window=2"] + (["-n", "-i"] if dry else ["-v"])
    if history:
        skip = [*skip, ".git/"]  # Git carries the history (push_history); the stores stay their own
    if delete:
        # Mirror deletions (a file removed here must not come back over there), but never touch
        # what only that Mac should own (see protected_paths).
        args += ["--delete"] + [f"--filter=P /{p.rstrip('/')}{'/' if p.endswith('/') else ''}" for p in protect]
    # Excluded paths are neither sent nor deleted (no --delete-excluded).
    args += [x for e in EXCLUDES for x in ("--exclude", e)] + [f"--exclude=/{p.rstrip('/')}/" for p in skip]
    return args + ["-e", SSH_CMD, cwd.rstrip("/") + "/", f"{h['ssh']}:{shlex.quote(remote_cwd.rstrip('/'))}/"]


def parse_itemized(text):
    """openrsync -i lines: '<f+++++++ path' sends a file to the other host ('>f' locally),
    '*deleting path' removes one. openrsync prints some lines twice, hence the sets."""
    send, delete = set(), set()
    for line in text.splitlines():
        if line.startswith("*deleting"):
            delete.add(line.split(None, 1)[1] if " " in line else "")
        elif line[:1] in ("<", ">") and line[1:2] in ("f", "L") and " " in line:
            send.add(line.split(None, 1)[1])
    send, delete = sorted(send), sorted(delete)
    return {"send": len(send), "delete": len(delete), "send_sample": send[:12], "delete_sample": delete[:12]}


def plan_files(h, cwd, remote_cwd, git):
    delete = bool(git["local"].get("git")) and not git["conflicts"]
    r = subprocess.run(rsync_args(cwd, h, remote_cwd, git["protect"], delete, dry=True, skip=git.get("skip") or (), history=git.get("history")), capture_output=True, text=True, errors="replace", timeout=1800)
    if r.returncode != 0 and "No such file" not in r.stderr:
        raise RuntimeError(_t(f"Previewing the sync failed: {r.stderr.strip()[-300:]}", f"预览同步失败：{r.stderr.strip()[-300:]}"))
    return {**parse_itemized(r.stdout), "delete_enabled": delete, "protected": git["protect"][:20], "skipped": (git.get("skip") or [])[:20]}


def remote_file_count(h, remote_cwd, skip_git=True):
    """Files present over there right now. `.git` is left out when Git itself carries the history
    (its objects arrive by push, not by the transfer being measured) and counted when the folder is
    copied whole — the same rule the planned count follows."""
    q = shlex.quote(remote_cwd)
    no_git = "-not -path '*/.git/*' " if skip_git else ""  # not nested in the f-string: Python < 3.12 rejects reused quotes
    r = run_remote(h, f"[ -d {q} ] && find {q} -type f {no_git}| wc -l || echo 0", timeout=60)
    try:
        return int(r.stdout.split()[-1])
    except (ValueError, IndexError):
        return 0


def sync_files(h, cwd, remote_cwd, git, on_file=None, planned=None, on_push=None):
    """`on_file(n)` hears how many files have arrived over there, for a progress bar. openrsync
    (macOS's rsync) prints its -v lines only at the end, so while it runs the count comes from
    asking the other Mac every few seconds how many files it has (over the shared ssh connection)."""
    import threading
    ssh(h, f"mkdir -p {shlex.quote(remote_cwd)}")
    delete = bool(git["local"].get("git")) and not git["conflicts"]
    if git.get("history"):
        git["pushed"] = push_history(h, git.get("_top") or cwd, remote_cwd, git["local"], on_percent=on_push)
    skip_git = bool(git.get("history"))
    before = remote_file_count(h, remote_cwd, skip_git) if on_file else 0
    args = rsync_args(cwd, h, remote_cwd, git["protect"], delete, dry=False, skip=git.get("skip") or (), history=git.get("history"))
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace")
    stop = threading.Event()

    def watch():
        while not stop.wait(3.0):
            try:
                n = remote_file_count(h, remote_cwd, skip_git) - before
                if n > 0:
                    on_file(min(n, planned) if planned else n)
            except Exception:
                pass
    watcher = threading.Thread(target=watch, daemon=True) if on_file else None
    if watcher:
        watcher.start()
    n = 0
    for line in proc.stdout:
        line = line.rstrip("\n")
        if not line or line.startswith(("sending ", "sent ", "total ", "building ", "delta-transmission", "created directory", "./")) or line.endswith("/"):
            continue
        n += 1
    err = proc.stderr.read()
    code = proc.wait()
    stop.set()
    if watcher:
        watcher.join(timeout=5)
    if code != 0:
        raise RuntimeError(_t(f"Syncing the project files failed: {err.strip()[-300:]}", f"同步项目文件失败：{err.strip()[-300:]}"))
    if on_file:
        on_file(planned or n)


def verify_git(h, cwd, remote_cwd):
    local, remote = git_state_local(cwd), git_state_remote(h, remote_cwd)
    if not local.get("git"):
        return {"checked": False}
    same_dirty = (local.get("dirty") or {}) == (remote.get("dirty") or {})
    return {"checked": True, "head_match": local.get("head") == remote.get("head"), "dirty_match": same_dirty,
            "head": (remote.get("head") or "")[:7], "branch": remote.get("branch")}


# ---------------------------------------------------------------- trusting the folder over there

def trust_folder(h, agent, remote_cwd, apply=True):
    """An engine that asks "Do you trust this folder?" the first time it runs in one (Claude Code, Codex) would sit
    blocked behind that question over there: mark the folder trusted on the other Mac the way the engine's own
    answer does (its adapter's move_trust_script, which backs the file up first). Returns already / set / needed /
    failed, None for an engine that does not ask."""
    script = E.get(agent).move_trust_script
    if not script:
        return None
    r = run_remote(h, "/usr/bin/python3 - " + shlex.quote(remote_cwd) + (" 1" if apply else " 0"), input=script)
    return (r.stdout.strip().splitlines() or ["failed"])[-1] if r.returncode == 0 else "failed"


# ---------------------------------------------------------------- hand-over

def running_remote(h, agent, sid):
    """Is this id already running over there (moved before, or resumed by hand)?"""
    dcmd = D.remote_cli(h)
    r = run_remote(h, f"{D.remote_beads(h)} {dcmd} sessions --local --json", timeout=40)
    try:
        rows = json.loads(r.stdout[r.stdout.find("["):])
    except ValueError:
        return None
    return next((s for s in rows if s.get("session_id") == sid and s.get("agent") == agent), None)


def own_ancestors():
    pids, pid, table = set(), os.getpid(), D.ps_table()
    for _ in range(40):
        pids.add(pid)
        ent = table.get(pid)
        if not ent or ent[0] <= 1:
            break
        pid = ent[0]
    return pids


def local_chat(agent, sid):
    """chatd's row for this conversation when it is an in-app chat here, else None."""
    import chat_client as CC
    try:
        with CC.ChatClient.connect(D.DISPATCH_DIR) as c:
            return next((r for r in c.request("list")["sessions"] if r["session"] == f"{agent}:{sid}"), None)
    except (CC.NotRunning, CC.ChatError, OSError):
        return None


def close_chat(key):
    import chat_client as CC
    with CC.ChatClient.connect(D.DISPATCH_DIR) as c:
        c.request("close", session=key, timeout=30)


def stop_original(agent, sid, keep=False, force=True):
    """Close this Mac's copy so the moved one is the only writer of the transcript: an in-app chat
    through chatd (it leaves Dispatch's list), anything else by its process. A working one is closed
    too unless force=False: handing the project over is what was asked for, and the transcript is
    copied after it stops, so nothing it wrote is lost. Never the process running this command."""
    live = next((s for s in D.live_sessions(local_only=True) if s.get("session_id") == sid and s.get("agent") == agent), None)
    chat = local_chat(agent, sid)
    if not live and not chat:
        return {"state": "not-running"}
    pid = (live or {}).get("agent_pid")
    if keep:
        return {"state": "kept", "pid": pid}
    was_working = (live or {}).get("state") == "working" or (chat or {}).get("lifecycle") == "running"
    if was_working and not force:
        return {"state": "working", "pid": pid}
    if (pid and pid in own_ancestors()) or not (pid or chat):
        return {"state": "self", "pid": pid}
    if chat:
        close_chat(chat["session"])
    else:
        try:
            os.kill(int(pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
        except PermissionError:
            return {"state": "failed", "pid": pid}
        for i in range(60):
            if int(pid) not in D.ps_table():
                break
            if i == 40:  # a busy agent can sit on SIGTERM; 10 s is enough grace
                try:
                    os.kill(int(pid), getattr(signal, "SIGKILL", signal.SIGTERM))
                except OSError:
                    pass
            time.sleep(0.25)
        else:
            return {"state": "failed", "pid": pid}
    try:
        os.remove(os.path.join(D.SESS_DIR, f"{agent}__{sid}.json"))
    except OSError:
        pass
    return {"state": "stopped", "pid": pid, "was_working": was_working}


def chat_title(agent, sid, ref):
    """The name Dispatch shows for this conversation here: the person's (or the caller's) own title first."""
    from activity import session_preferences
    return (session_preferences(D.DISPATCH_DIR).get(f"{agent}:{sid}") or {}).get("title_override") or ref.get("title") or _t("moved session", "迁移的会话")


def copy_transcript(h, agent, path, sid, target, rewrite, remote_home):
    """This conversation's transcript (and a Claude conversation's sub-agent transcripts) into the other
    Mac's agent history, home paths rewritten so tool results point at files over there."""
    text = open(path, encoding="utf-8", errors="replace").read()
    if rewrite and D.HOME != remote_home:
        text = text.replace(D.HOME, remote_home)
    ssh(h, f"mkdir -p {shlex.quote(os.path.dirname(target))}")
    r = run_remote(h, f"cat > {shlex.quote(target)}", timeout=600, input=text)
    if r.returncode != 0:
        raise RuntimeError(_t(f"Copying the session record failed: {r.stderr.strip()[-300:]}", f"复制会话记录失败：{r.stderr.strip()[-300:]}"))
    subdir = E.get(agent).side_folder(path, sid)
    if subdir and os.path.isdir(subdir):
        subprocess.run(["rsync", "-a", "-e", SSH_CMD, subdir + "/", f"{h['ssh']}:{shlex.quote(os.path.dirname(target) + '/' + sid)}/"], capture_output=True, text=True, errors="replace", timeout=600)


def copy_transcripts(h, rows, remote_home, on_each=None):
    """Every transcript of `rows` into the other Mac's agent history in one rsync: the rewritten copies
    are laid out under a temp dir exactly as they land under that Mac's home. One connection instead
    of two ssh round trips per conversation (191 MB / 8 transcripts took minutes that way)."""
    import shutil, tempfile
    copied, failed = [], []
    tmp = tempfile.mkdtemp(prefix="dispatch-move-")
    try:
        for i, r in enumerate(rows):
            try:
                remote_cwd = remote_path(r["cwd"], remote_home)
                target, rewrite = transcript_target(r["agent"], r["path"], r["cwd"], remote_home, remote_cwd)
                rel = os.path.relpath(target, remote_home)
                if rel.startswith(".."):
                    raise RuntimeError(_t("The target is not inside the other Mac's home folder: ", "目标不在对方主目录下：") + target)
                dst = os.path.join(tmp, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                text = open(r["path"], encoding="utf-8", errors="replace").read()
                if rewrite and D.HOME != remote_home:
                    text = text.replace(D.HOME, remote_home)
                with open(dst, "w", encoding="utf-8") as f:
                    f.write(text)
                subdir = E.get(r["agent"]).side_folder(r["path"], r["session_id"])
                if subdir and os.path.isdir(subdir):
                    shutil.copytree(subdir, os.path.join(os.path.dirname(dst), r["session_id"]), dirs_exist_ok=True, symlinks=True)
                copied.append((r["agent"], r["session_id"]))
            except Exception as e:
                failed.append({"session_id": r["session_id"], "error": str(e)[:200]})
            if on_each:
                on_each(i + 1)
        if copied:
            res = subprocess.run(["rsync", "-a", "-e", SSH_CMD, tmp + "/", f"{h['ssh']}:{shlex.quote(remote_home.rstrip('/'))}/"], capture_output=True, text=True, errors="replace", timeout=3600)
            if res.returncode != 0:
                failed += [{"session_id": sid, "error": "rsync：" + res.stderr.strip()[-200:]} for _, sid in copied]
                copied = []
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return copied, failed


def me_for_peer():
    """How the other Mac knows this one: its Tailscale address, else its LAN address (Macs paired on
    the same Wi-Fi have no Tailscale), else its name."""
    return D.tailscale_ip() or D.lan_ip() or D.local_host_name()


def mark_peer(h, marks):
    """Write records on the other Mac with its installed CLI (`dispatch moves mark`, which every
    released version has). `marks` is [(key, "--to"|"--from"|"confirm")]; "confirm" drops the peer's
    own pending_peer. Returns the keys it confirmed."""
    me = me_for_peer()
    if not me or not marks:
        return set()
    dcmd = f"{D.remote_beads(h)} {D.remote_cli(h)}"

    def one(k, flag):
        if flag == "confirm":
            # Drop the peer's own pending_peer. A CLI without `moves confirm` rewrites the same record instead.
            cmd = f"{{ {dcmd} moves confirm {shlex.quote(k)} || {dcmd} moves mark {shlex.quote(k)} --to {shlex.quote(me)}; }}"
        else:
            cmd = f"{dcmd} moves mark {shlex.quote(k)} {flag} {shlex.quote(me)}"
        return f"{cmd} >/dev/null 2>&1 && echo {shlex.quote('ok ' + k)}"
    script = "; ".join(one(k, flag) for k, flag in marks)
    try:
        r = run_remote(h, script, timeout=30 + 5 * len(marks))
    except Exception:
        return set()
    return {line[3:].strip() for line in (r.stdout or "").splitlines() if line.startswith("ok ")}


def mark_moved(h, keys, cwds=None):
    """Both Macs now hold these ids: this Mac marks its copies moved to h, h marks its copies moved from
    here, so lists show each conversation once, where it lives now.

    This Mac's half goes first and says `pending_peer` until the other Mac confirms its half. If the
    peer is unreachable, or this process dies in between, the original is still hidden here and
    `dispatch move repair` finds the pending record and writes the missing half."""
    keys = [f"{a}:{s}" for a, s in keys]
    if not keys:
        return {"marked": 0, "pending": []}
    cwds = cwds or {}
    now = time.time()
    D.record_moves({k: D.move_record(moved_to=h["id"], at=now, cwd=cwds.get(k), pending_peer=True) for k in keys})
    done = mark_peer(h, [(k, "--from") for k in keys])
    if done:
        D.confirm_moves(sorted(done))
    return {"marked": len(keys), "pending": [k for k in keys if k not in done]}


# ---------------------------------------------------------------- repair

REPAIR_GAP = 120  # seconds one copy must have gone on past the other before it counts as "continued"


def _content_time(r):
    """When the conversation last said something: the transcript's own last timestamp, not the file
    mtime (an idle process still appends title and bookkeeping lines to it)."""
    ts = r.get("last_ts") or ""
    if ts:
        try:
            from datetime import datetime
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return float(r.get("last_at") or 0)


def side_rows(refs, live, moves):
    """One Mac's view for the repair: {"agent:sid": {last, live, title, rec}}."""
    # A process without hook registration is listed as pid-<pid>; its transcript is
    # the probable_session_id, and that copy counts as running too.
    alive = {f"{s.get('agent')}:{x}" for s in live or [] if s.get("alive", True)
             for x in (s.get("session_id"), s.get("probable_session_id")) if x and not str(x).startswith("pid-")}
    rows = {}
    for r in refs or []:
        sid, agent = str(r.get("session_id") or ""), r.get("agent")
        if agent not in MOVABLE or not sid or sid.startswith("pid-") or r.get("subagent"):
            continue
        k = f"{agent}:{sid}"
        rows[k] = {"last": _content_time(r), "live": k in alive, "title": r.get("title") or "", "rec": (moves or {}).get(k) or {}}
    return rows


def _direction(ra, rb):
    """Which side the records say is the original: "here", "peer", "conflict" or None (no records).
    Each record claims a direction (moved_to: this side is the original, moved_from: the other side
    is). When the claims disagree, the newest record wins: after A to B and back to A, where the peer
    half of the move back failed, A still says moved_to B from the first move and B says moved_to A
    from the second. Records with the same time (or none) that disagree are a conflict.
    Returns (direction, at of the deciding record)."""
    claims = []
    for rec, me, other in ((ra, "here", "peer"), (rb, "peer", "here")):
        at = float(rec.get("at") or 0)
        if rec.get("moved_to"):
            claims.append((at, me))
        if rec.get("moved_from"):
            claims.append((at, other))
    if not claims:
        return None, 0
    sides = {c[1] for c in claims}
    if len(sides) == 1:
        return sides.pop(), max(c[0] for c in claims)
    newest = max(c[0] for c in claims)
    top = {c[1] for c in claims if c[0] == newest}
    return (top.pop(), newest) if len(top) == 1 and newest else ("conflict", 0)


def repair_plan(here, peer, gap=REPAIR_GAP):
    """Conversations both Macs hold, judged from what each side has: which copy is the original,
    whether the move records say so on both sides, and what is missing. `here`/`peer` are
    {"id", "name", "rows"}.

    The records decide the direction when there are any (the newest record when they disagree);
    without them the copy that went on at least `gap` seconds past the other is the one that took
    over. Nothing is written for a copy whose process still runs on the stale side, for records that
    contradict each other at the same time, for an original that went on after the move (forked), or
    when neither copy went on past the other."""
    out = []
    for k in sorted(set(here["rows"]) & set(peer["rows"])):
        a, b = here["rows"][k], peer["rows"][k]
        ra, rb = a["rec"], b["rec"]
        direction, moved_at = _direction(ra, rb)
        if direction == "conflict":
            state, old, new = "conflict", (here, a), (peer, b)
        elif direction:
            old, new = ((here, a), (peer, b)) if direction == "here" else ((peer, b), (here, a))
            state = None
        else:
            old, new = ((here, a), (peer, b)) if a["last"] <= b["last"] else ((peer, b), (here, a))
            state = "unclear" if abs(a["last"] - b["last"]) < gap else None
        (oh, o), (nh, n) = old, new
        c = {"key": k, "title": a["title"] or b["title"], "stale": oh["name"], "live": nh["name"], "stale_at": o["last"], "live_at": n["last"],
             "stale_is_here": oh is here, "writes": []}
        if moved_at:
            c["moved_at"] = moved_at
        if state == "conflict":
            pass
        elif o["live"] and n["live"]:
            state = "both_alive"
        elif o["live"]:
            state = "stale_alive"
        elif state == "unclear":
            pass
        elif o["last"] - n["last"] >= gap or (moved_at and o["last"] - moved_at >= gap):
            # The original went on after the hand-over: two endings, a person has to pick. Even with
            # both processes closed the records alone do not make that copy "from before the move".
            state = "forked"
        else:
            ro, rn = o["rec"], n["rec"]
            if not ro.get("moved_to") or ro.get("moved_from"):
                c["writes"].append({"side": "here" if oh is here else "peer", "field": "moved_to"})
            if not rn.get("moved_from") or rn.get("moved_to"):
                # Also rewrites a stale moved_to from an older move (A to B and back to A).
                c["writes"].append({"side": "here" if nh is here else "peer", "field": "moved_from"})
            pending = [side for side, r, h in (("here" if oh is here else "peer", ro, oh), ("here" if nh is here else "peer", rn, nh)) if r.get("pending_peer")]
            written = {w["side"] for w in c["writes"]}
            c["confirm"] = [s for s in pending if s not in written]
            state = "fix" if c["writes"] else "confirm" if c["confirm"] else "ok"
        c["state"] = state
        out.append(c)
    return out


MARK = "@@dispatch-repair@@"


def peer_view(h):
    """The other Mac's conversations, running processes and move records, in one ssh round trip, read
    with the CLI installed there."""
    base = f"{D.remote_beads(h)} {D.remote_cli(h)}"
    script = (f"echo {MARK}LIST; {base} list --cached --local --limit 100000 --json; echo {MARK}LIVE; {base} sessions --local --json; "
              f"echo {MARK}MOVES; {base} moves --json")
    r = run_remote(h, script, timeout=180)
    parts = {}
    for chunk in (r.stdout or "").split(MARK)[1:]:
        name, _, body = chunk.partition("\n")
        try:
            parts[name.strip()] = json.loads(body[body.find("["):]) if "[" in body else []
        except ValueError:
            parts[name.strip()] = None
    if parts.get("LIST") is None or parts.get("MOVES") is None:
        raise RuntimeError(_t(f"Cannot read the session list of {h['name']}: {(r.stderr or r.stdout or '').strip()[-200:]}", f"读不到 {h['name']} 的会话列表：{(r.stderr or r.stdout or '').strip()[-200:]}"))
    moves = {m["key"]: {k: v for k, v in m.items() if k in ("at", "moved_to", "moved_from", "cwd", "pending_peer")} for m in parts["MOVES"] if isinstance(m, dict) and m.get("key")}
    return {"id": h["id"], "name": h["name"], "rows": side_rows(parts["LIST"], parts.get("LIVE") or [], moves)}


def here_view():
    idx = D.load_index() or D.refresh_index()
    return {"id": "local", "name": D.local_host_name(), "rows": side_rows(D.session_refs(idx), D.live_sessions(local_only=True), D.load_moves())}


def repair(dry=True, key="", host=""):
    """`dispatch move repair`: conversations held by this Mac and another, where one copy stopped and
    the other went on, but the move records are missing (a move before records existed, a peer that
    was offline, a crash between the two halves). Writes the missing halves; with dry=True only lists."""
    peers = [h for h in D.hosts() if not host or D.resolve_host_id(host) == h.get("id")]
    if not peers:
        raise RuntimeError(_t("hosts.json has no other Mac", "hosts.json 里没有别的 Mac"))
    here = here_view()
    result = []
    for h in peers:
        try:
            peer = peer_view(h)
        except Exception as e:
            result.append({"host": h["name"], "error": str(e)[:300]})
            continue
        plan = [c for c in repair_plan(here, peer) if not key or c["key"] == key or c["key"].split(":", 1)[-1].startswith(key)]
        for c in plan:
            c["host"] = h["name"]
            if dry or c["state"] not in ("fix", "confirm"):
                continue
            peer_marks, done = [], []
            for w in c["writes"]:
                if w["side"] == "here":
                    extra = {"moved_to": h["id"]} if w["field"] == "moved_to" else {"moved_from": h["id"]}
                    # An original keeps where it went on (cwd); a copy that took over keeps nothing of an older record.
                    kept = {x: y for x, y in (D.load_moves().get(c["key"]) or {}).items() if x == "cwd"} if w["field"] == "moved_to" else {}
                    D.record_moves({c["key"]: {**kept, **D.move_record(**extra), "repaired": True}})
                    done.append(w)
                else:
                    peer_marks.append((c["key"], "--to" if w["field"] == "moved_to" else "--from"))
            confirm = c.get("confirm") or []
            if "peer" in confirm:
                peer_marks.append((c["key"], "confirm"))
            ok = mark_peer(h, peer_marks) if peer_marks else set()
            done += [w for w in c["writes"] if w["side"] == "peer" and c["key"] in ok]
            # This Mac's pending record is settled once the peer holds its half (it did before, or just wrote it).
            if "here" in confirm and (not peer_marks or c["key"] in ok):
                D.confirm_moves([c["key"]])
            settled = [x for x in confirm if x == "peer" and c["key"] in ok or x == "here" and (not peer_marks or c["key"] in ok)]
            c["written"] = len(done) + len(settled)
            c["failed"] = len(c["writes"]) + len(confirm) - c["written"]
        result += plan
    return result


REPAIR_STATE_EN = {"fix": "a record is missing: added", "confirm": "both records exist: the to-confirm mark is cleared", "ok": "the records are complete", "stale_alive": "the old copy's process is still open: left alone",
                   "both_alive": "both Macs have the same session open: left alone", "conflict": "the two records contradict each other: left alone", "forked": "after the move the original went on too, so both have their own end: left alone", "unclear": "both are about as new; which one went on is unclear: left alone"}
REPAIR_STATE = {"fix": "缺记录，补上", "confirm": "两边记录都在，清掉待确认标记", "ok": "记录齐全", "stale_alive": "旧副本的进程还开着，不动",
                "both_alive": "两台都开着同一个会话，不动", "conflict": "两边的记录互相矛盾，不动", "forked": "迁出后原来那份又接着写了，两份各有结尾，不动", "unclear": "两边差不多新，分不出谁接着做，不动"}


def main_repair(a):
    try:
        rows = repair(dry=a.dry_run, key=getattr(a, "key", "") or "", host=a.to or "")
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False) if a.json else f"✗ {e}")
        sys.exit(1)
    show = [r for r in rows if r.get("error") or r.get("state") != "ok" or getattr(a, "key", "")]
    if a.json:
        print(json.dumps(show, ensure_ascii=False, indent=2))
        return
    if not show:
        print(_t("Nothing to repair: sessions both Macs have carry complete move records", "没有要修的：两台都有的会话，迁移记录都齐"))
        return
    for r in show:
        if r.get("error"):
            print(f"✗ {r['host']}：{r['error']}")
            continue
        when = lambda t: time.strftime("%m-%d %H:%M", time.localtime(t)) if t else "?"
        if _t("en", "zh") == "en":
            writes = ", ".join(("here" if w["side"] == "here" else r["host"]) + (" records moved to" if w["field"] == "moved_to" else " records moved from") for w in r["writes"])
            done = "" if a.dry_run or r["state"] not in ("fix", "confirm") else f" (wrote {r.get('written', 0)}" + (f", {r['failed']} not written" if r.get("failed") else "") + ")"
            sides = (f"{r['stale']} (last {when(r['stale_at'])}) and {r['live']} (last {when(r['live_at'])})" if r["state"] in ("unclear", "conflict")
                     else f"old copy {r['stale']} (last {when(r['stale_at'])}), went on in {r['live']} (last {when(r['live_at'])})")
            moved = f", moved {when(r['moved_at'])}" if r.get("moved_at") else ""
            confirm = ", ".join(("here" if x == "here" else r["host"]) + " clears to-confirm" for x in r.get("confirm") or [])
            writes = ", ".join(x for x in (writes, confirm) if x)
            print(f"{r['key']}  {r['title'][:30]}\n    {sides}{moved}: {REPAIR_STATE_EN.get(r['state'], r['state'])}"
                  + (f"; {'would write' if a.dry_run else 'writes'}: {writes}" if writes else "") + done)
            continue
        writes = "、".join(("这边" if w["side"] == "here" else r["host"]) + ("记 已迁往" if w["field"] == "moved_to" else "记 迁移自") for w in r["writes"])
        done = "" if a.dry_run or r["state"] not in ("fix", "confirm") else f"（写了 {r.get('written', 0)} 条" + (f"，{r['failed']} 条没写成" if r.get("failed") else "") + "）"
        sides = (f"{r['stale']}（最后 {when(r['stale_at'])}）和 {r['live']}（最后 {when(r['live_at'])}）" if r["state"] in ("unclear", "conflict")
                 else f"旧副本 {r['stale']}（最后 {when(r['stale_at'])}），接着做的 {r['live']}（最后 {when(r['live_at'])}）")
        moved = f"，迁移于 {when(r['moved_at'])}" if r.get("moved_at") else ""
        confirm = "、".join(("这边" if x == "here" else r["host"]) + "清 待确认" for x in r.get("confirm") or [])
        writes = "、".join(x for x in (writes, confirm) if x)
        print(f"{r['key']}  {r['title'][:30]}\n    {sides}{moved}：{REPAIR_STATE.get(r['state'], r['state'])}"
              + (f"；{'会' if a.dry_run else ''}写：{writes}" if writes else "") + done)


def project_history(top, exclude):
    """This project's other Claude Code / Codex / pi conversations (not running here): their transcripts go
    over too, so the whole history lives — and can be resumed — on the new Mac."""
    top = os.path.normpath(top)
    rows = []
    for p, r in (D.load_index() or {}).items():
        c = os.path.normpath(r.get("cwd") or "")
        if r.get("subagent") or r.get("agent") not in MOVABLE or r.get("session_id") in exclude or not os.path.isfile(p):
            continue
        if c == top or c.startswith(top + os.sep):
            rows.append({**r, "path": p})
    return rows


def others_here(top, exclude_sid):
    top = os.path.normpath(top)
    rows = []
    for s in D.live_sessions(local_only=True):
        c = os.path.normpath(s.get("cwd") or "")
        if s.get("session_id") != exclude_sid and c and (c == top or c.startswith(top + os.sep)):
            rows.append({"session_id": s.get("session_id"), "agent": s.get("agent"), "title": s.get("title") or s.get("project") or "", "state": s.get("state"), "where": (s.get("herdr") or {}).get("tab_id") or s.get("source_app") or ""})
    return rows


def project_name(cwd):
    try:
        return D.project_of_cwd(cwd, D.project_names(), D.settings_load().get("workspace_roots") or []) or os.path.basename(cwd.rstrip("/"))
    except Exception:
        return os.path.basename(cwd.rstrip("/"))


def handoff_prompt(h, cwd, remote_cwd, env, git, prompt_extra):
    lines = _t([f"This session just moved from {D.local_host_name()} to {h['name']}, and the project came with it: from now on this project is worked on on this Mac.",
                f"The project folder is now {remote_cwd} (it was {cwd}); the work folder is synced, .git and uncommitted changes included.",
                "First see how far the conversation above got, then go on on this Mac; read every path as the new folder, and install what is missing (npm ci, xcodegen and the like, as the project does it)."],
               [f"这段会话刚从 {D.local_host_name()} 迁移到了 {h['name']}，项目也一起交接过来了：以后这个项目在这台电脑上做。",
                f"项目目录现在是 {remote_cwd}（原来是 {cwd}），工作区已同步，包括 .git 和未提交的改动。",
                "先看上文做到哪一步，再在这台电脑上接着做；路径一律按新目录理解，缺依赖就装（npm ci、xcodegen 之类按项目约定来）。"])
    v = git.get("verify") or {}
    if v.get("checked") and not (v.get("head_match") and v.get("dirty_match")):
        lines.append(_t("Note: after the sync the Git state of the two Macs does not match; check `git status` before changing anything.", "注意：同步后两边 Git 状态没对上，先 `git status` 核对再动手。"))
    if env.get("manual"):
        lines.append(_t("This Mac still lacks these tools: ", "这台电脑上还缺这些工具：") + _t("; ", "；").join(f"{k}" + _t(f" ({v})", f"（{v}）") for k, v in env["manual"].items()) + _t(". Install what you can; tell me about what you cannot (Xcode, for example).", "。能装的自己装，装不了的（比如 Xcode）告诉我。"))
    if prompt_extra:
        lines.append(prompt_extra)
    return "\n".join(lines)


def move(session_id, to, prompt_extra="", sync=True, dry=False, force=False, keep_original=False, git_info=None):
    if P.IS_WIN:
        P.unsupported(FEATURE)
    ref = find_ref(session_id)
    h = host_by(to)
    agent, cwd, path, sid = ref["agent"], ref["cwd"], ref["path"], ref["session_id"]
    if not os.path.isfile(path):
        raise RuntimeError(_t("The session file was not found", "找不到会话文件"))
    transcript_target(agent, path, cwd, "", "")  # unsupported agents fail before touching anything
    remote_home = ssh(h, "echo $HOME").strip()
    if not remote_home:
        raise RuntimeError(_t("Cannot get the other Mac's home folder", "拿不到对方的 HOME"))
    remote_cwd = remote_path(cwd, remote_home)
    target, rewrite = transcript_target(agent, path, cwd, remote_home, remote_cwd)
    plan = {"session": sid, "agent": agent, "from": D.local_host_name(), "to": h["name"], "cwd": cwd, "remote_cwd": remote_cwd, "transcript": target,
            "task": (ref.get("claims") or [None])[-1] if ref.get("claims") else ref.get("current_task")}
    files_here = sync and cwd and cwd != D.HOME and os.path.isdir(cwd)
    # A conversation in a subfolder still hands over the whole repository it belongs to.
    root = (repo_top(cwd) or cwd) if files_here else cwd
    remote_root = remote_path(root, remote_home)
    git = git_info or (git_preflight(h, root, remote_root) if files_here else {"local": {}, "remote": {}, "conflicts": [], "protect": []})
    plan["git"] = {k: v for k, v in git.items() if not k.startswith("_")}
    if files_here and not git_info:
        plan["files"] = plan_files(h, root, remote_root, git)
    plan["already_there"] = running_remote(h, agent, sid) is not None
    plan["env"] = preflight(h, path, agent, install=not dry)
    plan.update(E.get(agent).move_prepare(h, cwd, remote_home, remote_cwd, dry=dry))
    plan["others_here"] = others_here(root, sid) if files_here else []
    plan["project"] = project_name(cwd)
    if dry:
        return plan
    if git["conflicts"] and not force:
        raise RuntimeError(_t("Not moved: the other Mac would lose things:\n- ", "没有迁移，对方那边会丢东西：\n- ") + "\n- ".join(git["conflicts"]) + _t("\nSort them out and move again; add --force once you are sure they may be overwritten", "\n处理完再迁，确认可以覆盖就加 --force"))
    # 1. files
    if files_here and not git_info:
        sync_files(h, root, remote_root, git)
        plan["files_synced"] = True
        plan["git"]["pushed"] = git.get("pushed")
        plan["git"]["verify"] = verify_git(h, root, remote_root)
    chat = local_chat(agent, sid)  # its model carries over
    # 2. close this Mac's copy first: the transcript copied next is then complete, with one writer
    plan["original"] = stop_original(agent, sid, keep=keep_original)
    # 3. transcript (+ sub-agent transcripts for Claude)
    copy_transcript(h, agent, path, sid, target, rewrite, remote_home)
    # 4. resume over there, unless that copy already runs (a second resume would fork the transcript)
    dcmd = D.remote_cli(h)
    if plan["already_there"]:
        plan["started"] = {"already_running": True}
    else:
        kind = E.id_of(agent)
        handoff = handoff_prompt(h, cwd, remote_cwd, plan["env"], plan["git"], prompt_extra)
        label = chat_title(agent, sid, ref)
        model = (chat or {}).get("model")
        # DISPATCH_MOVE: the owner record changes hands only in step 5, after this resume.
        cmd = (f"DISPATCH_MOVE=1 {D.remote_beads(h)} {dcmd} agent start {kind} --cwd {shlex.quote(remote_cwd)} --label {shlex.quote(label)} --resume {shlex.quote(sid)}"
               + (f" --model {shlex.quote(model)}" if model else "") + f" --prompt {shlex.quote(handoff)} --no-wait --json")
        r = run_remote(h, cmd, timeout=240)
        out = r.stdout
        try:
            started = json.loads(out[out.find("{"):])
        except ValueError:
            started = {"raw": (out or r.stderr)[-400:]}
        if r.returncode != 0:
            raise RuntimeError(_t(f"No agent could be started on {h['name']}: {(r.stderr or out).strip()[-300:]}", f"{h['name']} 上没能起 Agent：{(r.stderr or out).strip()[-300:]}"))
        plan["started"] = started
    plan["marked"] = mark_moved(h, [(agent, sid)], {f"{agent}:{sid}": remote_cwd})
    # 5. hand the project over
    if files_here:
        plan["owner"] = set_owner(plan["project"], h)
    task = plan.get("task")
    if task:
        D.sh(["bd", "comment", task, _t(f"Session {sid[:8]} moved from {D.local_host_name()} to {h['name']} and goes on in {remote_cwd}; project {plan['project']} now belongs to {h['name']}.", f"会话 {sid[:8]} 已从 {D.local_host_name()} 迁移到 {h['name']}，在 {remote_cwd} 继续；项目 {plan['project']} 现在归 {h['name']}。")], timeout=30)
    return plan


# ---------------------------------------------------------------- project owner

def set_owner(project, h):
    """Write ownership on both Macs before returning; board sync may not have arrived yet."""
    result = {}
    errors = []
    try:
        result = D.project_owner_set(project, h["name"], h.get("ssh", "").split("@")[-1])
    except (Exception, SystemExit) as e:
        errors.append(_t(f"Recording the owner on the source Mac failed: {e}", f"来源机器归属记录失败：{e}"))
    try:
        dcmd = D.remote_cli(h)
        ssh(h, f"{D.remote_beads(h)} {dcmd} project {shlex.quote(project)} --owner local --json", timeout=40)
    except Exception as e:
        errors.append(_t(f"Recording the owner on the target Mac failed: {e}", f"目标机器归属记录失败：{e}"))
    if errors:
        result["error"] = "；".join(errors)[:400]
    return result


def project_dir(name):
    """The folder a project lives in here: the git top most of its indexed conversations ran in."""
    if os.path.isdir(os.path.expanduser(name)):
        return os.path.abspath(os.path.expanduser(name))
    idx = D.load_index() or D.refresh_index()
    names, roots, counts = D.project_names(), D.settings_load().get("workspace_roots") or [], {}
    for r in idx.values():
        c = r.get("cwd") or ""
        if r.get("subagent") or not c or not os.path.isdir(c) or c == D.HOME:
            continue
        if D.project_of_cwd(c, names, roots).lower() == name.lower():
            top = subprocess.run(["git", "-C", c, "rev-parse", "--show-toplevel"], capture_output=True, text=True, errors="replace").stdout.strip() or c
            counts[top] = counts.get(top, 0) + 1
    if not counts:
        raise RuntimeError(_t(f"This Mac has no session record of project {name}; giving the folder path works too", f"本机没有项目 {name} 的会话记录；直接给目录路径也行"))
    return max(counts, key=counts.get)


OPEN_KINDS = tuple(E.id_of(a) for a in MOVABLE) + ("none",)


def check_open_kind(open_kind):
    """--open-session takes the agent kind (claude / codex) or none; the CLI's own agent name
    (claude-code) means claude. Anything else stops the move before a file is touched."""
    kind = E.id_of(open_kind) if open_kind in MOVABLE else open_kind
    if kind not in OPEN_KINDS:
        raise RuntimeError(_t(f"--open-session must be {' / '.join(OPEN_KINDS)}; got \"{open_kind}\"", f"--open-session 只能是 {' / '.join(OPEN_KINDS)}，收到的是「{open_kind}」"))
    return kind


def new_session_kind(history, open_kind=None):
    """Which agent opens in the project over there when no conversation is running here to move:
    `open_kind` when given ("none": open nothing), else the agent of the project's latest conversation."""
    if open_kind:
        kind = check_open_kind(open_kind)
        return None if kind == "none" else kind
    latest = max(history, key=lambda r: r.get("mtime") or 0, default=None)
    agent = (latest or {}).get("agent")
    return E.id_of(agent if agent in MOVABLE else MOVABLE[0])


def open_session(h, kind, remote_cwd, label):
    """A new, empty session in the moved folder over there, so the project carries on there at once."""
    trust = trust_folder(h, kind, remote_cwd)
    cmd = f"{D.remote_beads(h)} {D.remote_cli(h)} agent start {shlex.quote(kind)} --cwd {shlex.quote(remote_cwd)} --label {shlex.quote(label)} --no-wait --json"
    r = run_remote(h, cmd, timeout=240)
    try:
        started = json.loads(r.stdout[r.stdout.find("{"):])
    except ValueError:
        started = {}
    if r.returncode != 0:
        return {"kind": kind, "error": (r.stderr or r.stdout).strip()[-300:] or _t("No agent could be started", "没能起 Agent")}
    return {"kind": kind, "session": started.get("session", ""), "trust": trust}


def move_project(name, to, dry=False, force=False, keep_original=False, prompt_extra="", progress=None, open_kind=None):
    """Hand a whole project over: sync its folder once, move every conversation still running in it
    here (they resume over there), record the new owner. With no conversation running here, a new
    session opens in the folder over there instead (`open_kind`, see new_session_kind). `progress(step, label, percent, detail)`
    hears every stage — the app draws it as a bar on the project."""
    if P.IS_WIN:
        P.unsupported(FEATURE)
    if open_kind:
        check_open_kind(open_kind)
    p = progress or (lambda *a, **k: None)
    h = host_by(to)
    top = project_dir(name)
    p("preflight", _t(f"Connecting to {h['name']}, checking Git and file differences", f"连接 {h['name']}，预检 Git 与文件差异"), 3)
    remote_home = ssh(h, "echo $HOME").strip()
    remote_top = remote_path(top, remote_home)
    git = git_preflight(h, top, remote_top)
    p("plan", _t("Counting the files to sync", "统计要同步的文件"), 8)
    plan = {"project": project_name(top), "to": h["name"], "cwd": top, "remote_cwd": remote_top,
            "git": {k: v for k, v in git.items() if not k.startswith("_")}, "files": plan_files(h, top, remote_top, git)}
    live = [s for s in D.live_sessions(local_only=True) if s.get("agent") in MOVABLE and not str(s.get("session_id", "")).startswith("pid-")
            and (os.path.normpath(s.get("cwd") or "") == top or os.path.normpath(s.get("cwd") or "").startswith(top + os.sep))]
    plan["sessions"] = [{"session_id": s["session_id"], "agent": s["agent"], "title": s.get("title") or os.path.basename(s.get("cwd") or ""), "state": s.get("state")} for s in live]
    history = project_history(top, {s["session_id"] for s in live})
    plan["history"] = {"count": len(history), "mb": round(sum(os.path.getsize(r["path"]) for r in history) / 1e6)}
    plan["new_session"] = None if live else new_session_kind(history, open_kind)
    if dry:
        return plan
    if git["conflicts"] and not force:
        raise RuntimeError(_t("Not moved: the other Mac would lose things:\n- ", "没有迁移，对方那边会丢东西：\n- ") + "\n- ".join(git["conflicts"]) + _t("\nSort them out and move again; add --force once you are sure they may be overwritten", "\n处理完再迁，确认可以覆盖就加 --force"))
    total = max(1, plan["files"]["send"])
    pushing = bool(git.get("history"))
    base = 28 if pushing else 12   # the file sync starts after the push's share of the bar
    p("files", (_t(f"Pushing the Git history to {h['name']}", f"推送 Git 历史到 {h['name']}") if pushing else _t(f"Syncing {plan['files']['send']} files", f"同步 {plan['files']['send']} 个文件")), 12)
    sync_files(h, top, remote_top, git, planned=total,
               on_push=lambda pct: p("push", _t(f"Pushing the Git history {int(pct)}%", f"推送 Git 历史 {int(pct)}%"), 12 + int(16 * min(100, pct) / 100)),
               on_file=lambda n: p("files", _t(f"Syncing files {min(n, total)}/{total}", f"同步文件 {min(n, total)}/{total}"), base + int((67 - base) * min(n, total) / total)))
    plan["git"]["pushed"] = git.get("pushed")
    p("verify", _t("Checking the other Mac's Git state", "核对对方的 Git 状态"), 70)
    plan["git"]["verify"] = verify_git(h, top, remote_top)
    moved = []
    for i, s in enumerate(live):
        p("sessions", _t(f"Moving session {i + 1}/{len(live)}: {s.get('title') or s['session_id'][:8]}", f"搬会话 {i + 1}/{len(live)}：{s.get('title') or s['session_id'][:8]}"), 73 + int(12 * i / len(live)))
        try:
            r = move(s["session_id"], to, prompt_extra=prompt_extra, sync=True, force=True, keep_original=keep_original, git_info=git)
            moved.append({"session_id": s["session_id"], "original": r.get("original"), "started": bool(r.get("started"))})
        except Exception as e:
            moved.append({"session_id": s["session_id"], "error": str(e)[:300]})
    plan["moved"] = moved
    if plan["new_session"]:
        p("sessions", _t(f"Opening a new {plan['new_session']} session in the project folder on {h['name']}", f"在 {h['name']} 的项目目录里新开一个 {plan['new_session']} 会话"), 80)
        plan["opened"] = open_session(h, plan["new_session"], remote_top, plan["project"])
    hist_n = max(1, len(history))
    p("history", _t(f"Moving {len(history)} past session records ({plan['history']['mb']} MB)", f"搬 {len(history)} 段历史会话记录（{plan['history']['mb']} MB）"), 86)
    copied, failed = copy_transcripts(h, history, remote_home, on_each=lambda n: p("history", _t(f"Sorting past records {n}/{len(history)}", f"整理历史记录 {n}/{len(history)}"), 86 + int(8 * n / hist_n))) if history else ([], [])
    p("history", _t("Records moved; marking the copies on both Macs", "记录已搬，标记两边的副本"), 96)
    cwd_of = {f"{r['agent']}:{r['session_id']}": remote_path(r["cwd"], remote_home) for r in history}
    plan["marked"] = mark_moved(h, copied, cwd_of)
    plan["history"].update(copied=len(copied), failed=failed[:10])
    p("owner", _t(f"Recording the project's owner: {h['name']}", f"记录项目归属：{h['name']}"), 98)
    plan["owner"] = set_owner(plan["project"], h)
    p("done", _t("Done", "完成"), 100)
    return plan


# ---------------------------------------------------------------- output

def describe_files(f):
    if not f:
        return ""
    s = _t(f"syncs {f['send']} files", f"同步 {f['send']} 个文件") + (_t(f", deletes {f['delete']} (deleted here)", f"、删除 {f['delete']} 个（这边已删）") if f.get("delete") else "")
    if f.get("skipped"):
        s += _t(f"; build output is not moved (the other Mac builds and installs it): {', '.join(f['skipped'][:5])}", f"；构建产物不搬（对方自己构建/安装）：{'、'.join(f['skipped'][:5])}")
    if f.get("protected"):
        s += _t(f"; kept on the other Mac: {', '.join(f['protected'][:6])}", f"；对方这些不删：{'、'.join(f['protected'][:6])}")
    return s


def describe_git(g):
    l, r = g.get("local") or {}, g.get("remote") or {}
    if not l.get("git"):
        return _t("not a Git repository: copied as a plain folder", "不是 Git 仓库，按普通目录复制")
    if not r.get("exists"):
        return _t(f"the other Mac lacks this folder: copied whole ({l.get('branch')} @ {(l.get('head') or '')[:7]})", f"对方还没有这个目录，整个复制（{l.get('branch')} @ {(l.get('head') or '')[:7]}）")
    return _t(f"here {l.get('branch')} @ {(l.get('head') or '')[:7]} (uncommitted {l.get('dirty')}) → there {r.get('branch')} @ {(r.get('head') or '')[:7]} (uncommitted {r.get('dirty')})"
              + ("; history goes over by git push, and the other Mac's stash and reflog are kept" if g.get("history") else ""),
              f"这边 {l.get('branch')} @ {(l.get('head') or '')[:7]}（未提交 {l.get('dirty')}）→ 对方 {r.get('branch')} @ {(r.get('head') or '')[:7]}（未提交 {r.get('dirty')}）"
              + ("；历史用 git push 过去，对方的 stash 和 reflog 保留" if g.get("history") else ""))


ORIGINAL_EN = {"stopped": "the original session here is stopped", "working": "the original session here is running, so it was not stopped: close it once it finishes", "self": "the original session here is the one doing the move, so it was not stopped: close it after this turn", "kept": "the original session here is kept, as asked",
               "failed": "the original session here did not stop: close it by hand", "not-running": "the original session here was not running"}
ORIGINAL = {"stopped": "这边的原会话已停掉", "working": "这边的原会话正在跑，没停：跑完后关掉它", "self": "这边的原会话就是执行迁移的这个，没停：说完这轮就关", "kept": "按要求保留了这边的原会话",
            "failed": "这边的原会话没停下来，手动关掉", "not-running": "这边的原会话没在跑"}


def _unsupported(a, e):
    """Windows: said plainly ({"unsupported": true}, exit 0 with --json; exit 2 otherwise)."""
    if a.json:
        print(json.dumps({"ok": False, "unsupported": True, "message": str(e)}, ensure_ascii=False))
        return
    print(e)
    sys.exit(2)


def main(a):
    if P.IS_WIN:
        try:
            P.unsupported(FEATURE)
        except P.Unsupported as e:
            return _unsupported(a, e)
    if a.session == "repair":
        return main_repair(a)
    if not a.to:
        print(_t("Usage: dispatch move <session> --to <host>; dispatch move repair --dry-run fills in missing move records", "用法：dispatch move <会话> --to <主机>；补迁移记录用 dispatch move repair --dry-run"))
        sys.exit(2)
    try:
        res = move(a.session, a.to, prompt_extra=a.prompt or "", sync=not a.no_files, dry=a.dry_run, force=a.force, keep_original=a.keep_original)
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False) if a.json else f"✗ {e}")
        if a.json:
            print(f"✗ {e}", file=sys.stderr)  # the desktop app shows stderr when a command fails
        sys.exit(1)
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return
    g = res.get("git") or {}
    if _t("en", "zh") == "en":
        if a.dry_run:
            env = res.get("env", {})
            print(f"Would hand {res['agent']} session {res['session'][:8]} and project {res['project']} to {res['to']}: {res['cwd']} → {res['remote_cwd']}")
            print("Git: " + describe_git(g))
            for c in g.get("conflicts") or []:
                print(f"  ✗ {c}")
            if res.get("files"):
                print("Files: " + describe_files(res["files"]))
            print(f"{len(env.get('used', []))} tools used; missing over there: " + (", ".join(env["missing"]) if env.get("missing") else "none"))
            if res.get("already_there"):
                print("The other Mac already runs this session: no second one is started")
            for o in res.get("others_here") or []:
                print(f"  ⚠ Another session here works in this project: {o['title'] or o['session_id'][:8]} ({o['state']}, {o['where']})")
            if "trust" in res:
                print("Trust: " + {"already": "the other Mac trusts this folder already", "needed": "the move marks it trusted in the other Mac's ~/.claude.json (backed up first)", "failed": "the other Mac's ~/.claude.json cannot be read"}.get(res["trust"], res["trust"]))
            return
        s = res.get("started") or {}
        v = g.get("verify") or {}
        print(f"Moved to {res['to']}: {res['remote_cwd']}" + (f" · {s.get('session')}" if s.get("session") else "") + (" · it was running there already, not started again" if s.get("already_running") else "")
              + (" (it stopped on a dialog at start, which was answered by itself)" if s.get("recovered") else ""))
        if v.get("checked"):
            print("Git check: " + ("both match" if v["head_match"] and v["dirty_match"] else f"no match (HEAD {'same' if v['head_match'] else 'differs'}, uncommitted changes {'same' if v['dirty_match'] else 'differ'})"))
        print(ORIGINAL_EN.get((res.get("original") or {}).get("state"), ""))
        for o in res.get("others_here") or []:
            print(f"⚠ Another session here works in this project: {o['title'] or o['session_id'][:8]} ({o['state']}, {o['where']}); it goes on changing the files here")
        if (res.get("owner") or {}).get("host"):
            print(f"Project {res['project']} now belongs to {res['owner']['host']}: new sessions open there by default")
        return
    g = res.get("git") or {}
    if a.dry_run:
        env = res.get("env", {})
        print(f"会把 {res['agent']} 会话 {res['session'][:8]} 和项目 {res['project']} 交给 {res['to']}：{res['cwd']} → {res['remote_cwd']}")
        print("Git：" + describe_git(g))
        for c in g.get("conflicts") or []:
            print(f"  ✗ {c}")
        if res.get("files"):
            print("文件：" + describe_files(res["files"]))
        print(f"用过的工具 {len(env.get('used', []))} 个；对方缺：" + ("、".join(env["missing"]) if env.get("missing") else "无"))
        if res.get("already_there"):
            print("对方已经在跑这个会话：不会再起一份")
        for o in res.get("others_here") or []:
            print(f"  ⚠ 这边还有会话在这个项目里：{o['title'] or o['session_id'][:8]}（{o['state']}，{o['where']}）")
        if "trust" in res:
            print("信任提示：" + {"already": "对方已信任这个目录", "needed": "迁移时会在对方 ~/.claude.json 标记信任（先备份）", "failed": "读不到对方 ~/.claude.json"}.get(res["trust"], res["trust"]))
        return
    s = res.get("started") or {}
    v = g.get("verify") or {}
    print(f"已迁移到 {res['to']}：{res['remote_cwd']}" + (f" · {s.get('session')}" if s.get("session") else "") + (" · 对方本来就在跑，没再起" if s.get("already_running") else "")
          + ("（启动时卡在对话框，已自动按过）" if s.get("recovered") else ""))
    if v.get("checked"):
        print("Git 核对：" + ("两边一致" if v["head_match"] and v["dirty_match"] else f"没对上（HEAD {'一致' if v['head_match'] else '不同'}，未提交改动{'一致' if v['dirty_match'] else '不同'}）"))
    print(ORIGINAL.get((res.get("original") or {}).get("state"), ""))
    for o in res.get("others_here") or []:
        print(f"⚠ 这边还有会话在这个项目里：{o['title'] or o['session_id'][:8]}（{o['state']}，{o['where']}）——它们会继续改这边的文件")
    if (res.get("owner") or {}).get("host"):
        print(f"项目 {res['project']} 现在归 {res['owner']['host']}：新建会话默认开在那台")


JOBS_DIR = os.path.join(D.DISPATCH_DIR, "moves")


class Job:
    """One project move running in the background: a JSON file the worker updates at every stage
    and the app polls (`dispatch project-moves`), so the bar survives page changes and reloads."""
    def __init__(self, jid):
        self.id = jid
        self.path = os.path.join(JOBS_DIR, jid + ".json")

    @classmethod
    def create(cls, project, to, cwd):
        import uuid
        os.makedirs(JOBS_DIR, exist_ok=True)
        job = cls(str(uuid.uuid4()))
        job._write({"id": job.id, "project": project, "to": to, "cwd": cwd, "state": "running", "step": "start", "label": _t("Starting…", "正在启动…"), "percent": 0, "detail": "",
                    "started": time.time(), "updated": time.time(), "pid": None})
        return job

    def read(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def _write(self, data):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, self.path)

    def update(self, **fields):
        data = self.read() or {"id": self.id}
        data.update(fields, updated=time.time())
        self._write(data)
        return data

    def progress(self, step, label, percent, detail=""):
        self.update(step=step, label=label, percent=max(0, min(100, int(percent))), detail=detail)

    def finish(self, result):
        v = (result.get("git") or {}).get("verify") or {}
        moved = result.get("moved") or []
        summary = {"to": result.get("to"), "remote_cwd": result.get("remote_cwd"), "git_ok": bool(v.get("checked") and v.get("head_match") and v.get("dirty_match")), "git_checked": bool(v.get("checked")),
                   "sessions": len(moved), "sessions_failed": sum(1 for m in moved if m.get("error")), "history": (result.get("history") or {}).get("copied", 0),
                   "history_failed": len((result.get("history") or {}).get("failed") or []), "owner_error": (result.get("owner") or {}).get("error", ""),
                   "opened": (result.get("opened") or {}).get("kind") if not (result.get("opened") or {}).get("error") else None, "open_error": (result.get("opened") or {}).get("error", "")}
        self.update(state="done", step="done", label=_t("Done", "完成"), percent=100, result=summary)

    def fail(self, error):
        self.update(state="failed", label=_t("Failed", "失败"), error=str(error)[:600])


def list_jobs(hours=24):
    """Running moves and the ones that ended within `hours`, newest first. A worker that died
    without saying so (no update for 20 minutes and no such process) is reported as failed."""
    out = []
    now = time.time()
    for name in (os.listdir(JOBS_DIR) if os.path.isdir(JOBS_DIR) else []):
        if not name.endswith(".json"):
            continue
        job = Job(name[:-5]); data = job.read()
        if not data:
            continue
        if data.get("state") == "running":
            pid = data.get("pid")
            alive = True
            if pid:
                alive = P.pid_alive(pid)
            if not alive or now - (data.get("updated") or 0) > 1200:
                data = job.update(state="failed", label=_t("Failed", "失败"), error=_t("The move process disappeared before it finished; check the folders on both Macs, then try again.", "迁移进程没有结束就消失了，看一下两边的目录状态再重试。"))
        if data.get("state") == "running" or now - (data.get("updated") or 0) < hours * 3600:
            out.append(data)
    out.sort(key=lambda d: -(d.get("started") or 0))
    return out


def main_project(a):
    if P.IS_WIN:
        try:
            P.unsupported(FEATURE)
        except P.Unsupported as e:
            return _unsupported(a, e)
    if getattr(a, "background", False) and not a.dry_run:
        top = project_dir(a.name)
        job = Job.create(project_name(top), host_by(a.move_to)["name"], top)
        log = open(os.path.join(JOBS_DIR, job.id + ".log"), "w")
        args = [sys.executable, D.__file__, "project", a.name, "--move-to", a.move_to, "--json", "--job", job.id] + (["--force"] if a.force else []) + (["--keep-original"] if a.keep_original else []) + (["--open-session", a.open_session] if getattr(a, "open_session", None) else [])
        proc = subprocess.Popen(args, cwd=D.HOME, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, env={**os.environ, "BEADS_DIR": D.BEADS_DIR})
        data = job.update(pid=proc.pid)
        print(json.dumps(data, ensure_ascii=False) if a.json else _t(f"Moving {data['project']} → {data['to']} in the background (job {job.id[:8]}): dispatch project-moves shows the progress", f"已在后台开始迁移 {data['project']} → {data['to']}（任务 {job.id[:8]}）：dispatch project-moves 看进度"))
        return
    job = Job(a.job) if getattr(a, "job", None) else None
    if job:
        job.update(pid=os.getpid())
    try:
        res = move_project(a.name, a.move_to, dry=a.dry_run, force=a.force, keep_original=a.keep_original, progress=job.progress if job else None, open_kind=getattr(a, "open_session", None))
        if job:
            job.finish(res)
    except Exception as e:
        if job:
            job.fail(e)
        print(json.dumps({"error": str(e)}, ensure_ascii=False) if a.json else f"✗ {e}")
        if a.json:
            print(f"✗ {e}", file=sys.stderr)  # the desktop app shows stderr when a command fails
        sys.exit(1)
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return
    g = res["git"]
    if _t("en", "zh") == "en":
        print(f"{'Would hand' if a.dry_run else 'Handed'} project {res['project']} to {res['to']}: {res['cwd']} → {res['remote_cwd']}")
        print("Git: " + describe_git(g))
        for c in g.get("conflicts") or []:
            print(f"  ✗ {c}")
        print("Files: " + describe_files(res["files"]))
        for s_ in res.get("moved") or res["sessions"]:
            state = s_.get("error") or ORIGINAL_EN.get((s_.get("original") or {}).get("state"), s_.get("state") or "")
            print(f"  session {s_['session_id'][:8]}: {state}")
        if not res["sessions"]:
            print("  no session running here")
        o = res.get("opened") or {}
        if o:
            print(f"  opened a new {o['kind']} session on {res['to']}" + (f" · {o['session']}" if o.get("session") else "") if not o.get("error") else f"  opening a session on {res['to']} failed: {o['error']}")
        elif a.dry_run and res.get("new_session"):
            print(f"  after the move a new {res['new_session']} session opens in the project folder on {res['to']}")
        hist = res.get("history") or {}
        if hist.get("count"):
            print(f"Past sessions: {hist['count']} ({hist['mb']} MB)" + (f", {hist['copied']} moved" if "copied" in hist else ", their records go along") + (f", {len(hist['failed'])} not moved" if hist.get("failed") else ""))
        v = g.get("verify") or {}
        if v.get("checked"):
            print("Git check: " + ("both match" if v["head_match"] and v["dirty_match"] else "no match; look at git status over there"))
        return
    g = res["git"]
    print(f"{'会把' if a.dry_run else '已把'}项目 {res['project']} 交给 {res['to']}：{res['cwd']} → {res['remote_cwd']}")
    print("Git：" + describe_git(g))
    for c in g.get("conflicts") or []:
        print(f"  ✗ {c}")
    print("文件：" + describe_files(res["files"]))
    for s in res.get("moved") or res["sessions"]:
        state = s.get("error") or ORIGINAL.get((s.get("original") or {}).get("state"), s.get("state") or "")
        print(f"  会话 {s['session_id'][:8]}：{state}")
    if not res["sessions"]:
        print("  这边没有在跑的会话")
    o = res.get("opened") or {}
    if o:
        print(f"  已在 {res['to']} 新开 {o['kind']} 会话" + (f" · {o['session']}" if o.get("session") else "") if not o.get("error") else f"  在 {res['to']} 新开会话失败：{o['error']}")
    elif a.dry_run and res.get("new_session"):
        print(f"  迁完在 {res['to']} 的项目目录里新开一个 {res['new_session']} 会话")
    hist = res.get("history") or {}
    if hist.get("count"):
        print(f"历史会话：{hist['count']} 段（{hist['mb']} MB）" + (f"，已搬 {hist['copied']} 段" if "copied" in hist else "，记录会一起搬过去") + (f"，{len(hist['failed'])} 段没搬成" if hist.get("failed") else ""))
    v = g.get("verify") or {}
    if v.get("checked"):
        print("Git 核对：" + ("两边一致" if v["head_match"] and v["dirty_match"] else "没对上，去对方 git status 看看"))
