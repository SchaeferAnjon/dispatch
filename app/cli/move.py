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
     that Mac's Dispatch/Herdr with a hand-off prompt;
  5. hand the project over: stop the original once it is idle (so two copies never fork), name
     other sessions still working on it here, record that Mac as the project's owner (new sessions
     for the project default to it) and verify the Git state over there matches.
Supports Claude Code and Codex (both resume by id). pi keeps its sessions in its own store.
"""
import base64, hashlib, json, os, re, shlex, signal, subprocess, sys, time

import dispatch as D

EXCLUDES = [".DS_Store", "node_modules/.cache", "*.pyc", "__pycache__"]
# Tools a conversation used, mapped to what installs them on the other Mac. Anything else
# that is missing is reported so the agent (and you) know before it trips over it.
BREW = {"node": "node", "npm": "node", "npx": "node", "pnpm": "pnpm", "yarn": "yarn", "python3": "python", "pip3": "python", "cargo": "rust", "rustc": "rust", "go": "go", "java": "openjdk",
        "gh": "gh", "jq": "jq", "rg": "ripgrep", "fd": "fd", "bat": "bat", "eza": "eza", "tmux": "tmux", "dolt": "dolt", "bd": "beads", "herdr": "herdr", "ffmpeg": "ffmpeg", "pdftotext": "poppler", "pdftoppm": "poppler",
        "pandoc": "pandoc", "wget": "wget", "tree": "tree", "watchman": "watchman", "pod": "cocoapods", "xcodegen": "xcodegen", "swiftlint": "swiftlint", "fastlane": "fastlane", "docker": "docker", "psql": "libpq", "sqlite3": "sqlite", "uv": "uv", "bun": "bun", "deno": "deno"}
KNOWN = set(BREW) | {"xcodebuild", "xcrun", "swift", "simctl", "claude", "codex", "pi", "gemini", "make", "cmake", "pytest", "mvn", "gradle", "flutter", "dart", "ruby", "bundle", "gem", "php", "composer", "dotnet", "kubectl", "terraform", "aws", "gcloud", "redis-cli", "mysql", "adb", "vite", "tsc", "eslint", "prettier", "playwright", "conda", "poetry", "pipx", "ollama", "hugo", "zola", "mkdocs", "latexmk", "pdflatex", "xelatex", "convert", "magick", "exiftool", "yt-dlp", "sox", "whisper", "rustup", "wasm-pack", "protoc", "nvim", "vim", "code", "cursor"}
MANUAL = {"xcodebuild": "Xcode（App Store）", "xcrun": "Xcode（App Store）", "swift": "Xcode 或 Swift toolchain", "simctl": "Xcode", "claude": "Claude Code（npm i -g @anthropic-ai/claude-code）", "codex": "Codex CLI（npm i -g @openai/codex）", "open": "", "osascript": ""}
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
    return subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", h["ssh"], bash_line(PATH_PREFIX + script)],
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
        manual[m] = MANUAL.get(m, BREW.get(m, "") and f"brew install {BREW[m]}") or "自己装"
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
        raise RuntimeError(f"本机没有这个会话：{session_id}")
    return refs[0]


def host_by(name):
    for h in D.hosts():
        if name.lower() in (h["id"].lower(), h["name"].lower()) or name in (h.get("aliases") or []):
            return h
    raise RuntimeError(f"hosts.json 里没有 {name}；先在那台电脑的首次设置里接入这台，或者反过来")


def remote_path(cwd, remote_home):
    if cwd.startswith(D.HOME + "/"):
        return remote_home + cwd[len(D.HOME):]
    if cwd == D.HOME:
        return remote_home
    return cwd  # outside home (e.g. /opt/x): same absolute path


def claude_project_dir(cwd):
    # Claude Code names the history folder after the working directory, "/" and "." -> "-".
    return re.sub(r"[/.]", "-", cwd.rstrip("/") or "/")


def transcript_target(agent, path, cwd, remote_home, remote_cwd):
    """Where the transcript goes on the other Mac, and whether its text needs the home path rewritten."""
    if agent == "claude-code":
        return f"{remote_home}/.claude/projects/{claude_project_dir(remote_cwd)}/{os.path.basename(path)}", True
    if agent == "codex":
        rel = os.path.relpath(path, os.path.join(D.HOME, ".codex"))
        if rel.startswith(".."):
            raise RuntimeError("Codex 会话文件不在 ~/.codex 下，不知道该放哪")
        return f"{remote_home}/.codex/{rel}", True
    raise RuntimeError(f"{agent} 的会话还不支持迁移（目前支持 Claude Code 和 Codex）")


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
        raise RuntimeError(f"读不到 {h['name']} 上 {cwd} 的 Git 状态：{(r.stderr or r.stdout).strip()[-200:]}")


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
        return [] if not remote.get("git") else ["对方这个目录是 Git 仓库，这边不是：不像同一个项目"]
    if not remote.get("git"):
        return ["对方已有同名目录但不是 Git 仓库：合并进去会混在一起"]
    out = []
    if local.get("remote") and remote.get("remote") and not same_remote(local["remote"], remote["remote"]):
        out.append(f"两边不是同一个仓库：这边 {local['remote']}，对方 {remote['remote']}")
        return out
    rhead = remote.get("head") or ""
    if rhead and rhead != local.get("head") and not is_ancestor(rhead):
        out.append(f"对方有这边没有的提交（对方 HEAD {rhead[:7]} 不在这边的历史里）：先在对方 push，这边 pull 后再迁")
    changed = [p for p, h in (remote.get("dirty") or {}).items() if h != local_file_hash(p)]
    if changed:
        more = f" 等 {len(changed)} 个" if len(changed) > 5 else ""
        out.append("对方有未提交的改动与这边不同，会被覆盖：" + "、".join(sorted(changed)[:5]) + more)
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


def push_history(h, top, remote_top, local):
    """Both Macs have the repo: bring the target's history to the source's with Git itself instead of
    copying .git. The two object stores are laid out differently (loose here, packed there: rsync wanted
    to resend 9,133 objects for two commits), and the target's own stash, reflog and packed refs must
    survive. Push HEAD to a private ref, point the same branch at it and reset only the index — the
    working tree then comes over with rsync, so uncommitted edits end up exactly as they are here."""
    sha, branch = local.get("head") or "", local.get("branch") or "HEAD"
    if not sha:
        return {"pushed": False}
    env = {**os.environ, "GIT_SSH_COMMAND": "ssh -o BatchMode=yes -o ConnectTimeout=8"}
    r = subprocess.run(["git", "-C", top, "push", "-q", "--no-verify", "--receive-pack=git receive-pack", f"ssh://{h['ssh']}{remote_top}", f"+{sha}:refs/dispatch/moved"],
                       capture_output=True, text=True, errors="replace", timeout=1800, env=env)
    if r.returncode != 0:
        raise RuntimeError(f"推送 Git 历史到 {h['name']} 失败：{r.stderr.strip()[-300:]}")
    q = shlex.quote
    point = (f"git symbolic-ref HEAD {q('refs/heads/' + branch)} && git update-ref {q('refs/heads/' + branch)} {sha}" if branch != "HEAD"
             else f"git update-ref --no-deref HEAD {sha}")
    r = run_remote(h, f"cd {q(remote_top)} && {point} && git reset -q {sha} && git update-ref -d refs/dispatch/moved", timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"{h['name']} 上切到 {sha[:7]} 失败：{(r.stderr or r.stdout).strip()[-300:]}")
    return {"pushed": True, "head": sha[:7], "branch": branch}


def protected_paths(remote):
    """What --delete must never remove over there: everything Git ignores on that Mac (its build/
    holds device and simulator products the source's build/ does not — mirroring deleted ~10k files
    in the first dry run) and .git itself (its own stash, packed refs and objects; the source's refs
    and objects are still copied in)."""
    return sorted(set(remote.get("ignored") or []) | ({".git/"} if remote.get("git") else set()))


# Ignored directories that are build output or caches: rebuilt or reinstalled on the other Mac, never
# copied (atrium's build/ is 37 GB). Other ignored paths — .env files, Sources/Private — do travel.
BUILD_DIRS = re.compile(r"^(build(-.+)?|DerivedData|\.build|dist|target|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache|coverage|node_modules|Pods|\.gradle|\.venv|venv)$")


def build_excludes(local):
    return sorted(p for p in (local.get("ignored") or []) if p.endswith("/") and BUILD_DIRS.match(os.path.basename(p.rstrip("/"))))


# ---------------------------------------------------------------- files

def rsync_args(cwd, h, remote_cwd, protect, delete, dry, skip=(), history=False):
    # -c: compare contents, not mtimes — a clone over there has fresh mtimes on identical files.
    args = ["rsync", "-a", "-c"] + (["-n", "-i"] if dry else [])
    if history:
        skip = [*skip, ".git/"]  # Git carries the history (push_history); the stores stay their own
    if delete:
        # Mirror deletions (a file removed here must not come back over there), but never touch
        # what only that Mac should own (see protected_paths).
        args += ["--delete"] + [f"--filter=P /{p.rstrip('/')}{'/' if p.endswith('/') else ''}" for p in protect]
    # Excluded paths are neither sent nor deleted (no --delete-excluded).
    args += [x for e in EXCLUDES for x in ("--exclude", e)] + [f"--exclude=/{p.rstrip('/')}/" for p in skip]
    return args + ["-e", "ssh -o BatchMode=yes", cwd.rstrip("/") + "/", f"{h['ssh']}:{shlex.quote(remote_cwd.rstrip('/'))}/"]


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
        raise RuntimeError(f"预览同步失败：{r.stderr.strip()[-300:]}")
    return {**parse_itemized(r.stdout), "delete_enabled": delete, "protected": git["protect"][:20], "skipped": (git.get("skip") or [])[:20]}


def sync_files(h, cwd, remote_cwd, git):
    ssh(h, f"mkdir -p {shlex.quote(remote_cwd)}")
    delete = bool(git["local"].get("git")) and not git["conflicts"]
    if git.get("history"):
        git["pushed"] = push_history(h, git.get("_top") or cwd, remote_cwd, git["local"])
    r = subprocess.run(rsync_args(cwd, h, remote_cwd, git["protect"], delete, dry=False, skip=git.get("skip") or (), history=git.get("history")), capture_output=True, text=True, errors="replace", timeout=3600)
    if r.returncode != 0:
        raise RuntimeError(f"同步项目文件失败：{r.stderr.strip()[-300:]}")


def verify_git(h, cwd, remote_cwd):
    local, remote = git_state_local(cwd), git_state_remote(h, remote_cwd)
    if not local.get("git"):
        return {"checked": False}
    same_dirty = (local.get("dirty") or {}) == (remote.get("dirty") or {})
    return {"checked": True, "head_match": local.get("head") == remote.get("head"), "dirty_match": same_dirty,
            "head": (remote.get("head") or "")[:7], "branch": remote.get("branch")}


# ---------------------------------------------------------------- Claude specifics

TRUST_SCRIPT = r"""
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


def trust_folder(h, remote_cwd, apply=True):
    """Claude Code asks "Do you trust the files in this folder?" the first time it runs in a
    directory, and a resumed session sits blocked behind that dialog. Mark the folder trusted in
    the other Mac's ~/.claude.json (projects[<cwd>].hasTrustDialogAccepted, the flag the dialog
    itself writes), after a backup to ~/.claude.json.dispatch-bak. Returns already / set / needed."""
    r = run_remote(h, "/usr/bin/python3 - " + shlex.quote(remote_cwd) + (" 1" if apply else " 0"), input=TRUST_SCRIPT)
    return (r.stdout.strip().splitlines() or ["failed"])[-1] if r.returncode == 0 else "failed"


def memory_dir(home, cwd):
    return os.path.join(home, ".claude", "projects", claude_project_dir(cwd), "memory")


def sync_memory(h, cwd, remote_home, remote_cwd, dry=False):
    """The project's Claude auto-memory (~/.claude/projects/<encoded cwd>/memory/) belongs with the
    conversation. Merge it into the other Mac's folder for the new path; newer files there win."""
    src = memory_dir(D.HOME, cwd)
    files = sorted(f for f in os.listdir(src)) if os.path.isdir(src) else []
    if not files or dry:
        return {"files": len(files), "synced": False}
    dst = memory_dir(remote_home, remote_cwd)
    ssh(h, f"mkdir -p {shlex.quote(dst)}")
    r = subprocess.run(["rsync", "-a", "--update", "-e", "ssh -o BatchMode=yes", src + "/", f"{h['ssh']}:{shlex.quote(dst)}/"], capture_output=True, text=True, errors="replace", timeout=600)
    return {"files": len(files), "synced": r.returncode == 0, **({"error": r.stderr.strip()[-200:]} if r.returncode else {})}


def unblock_start(h, remote_cwd, label):
    """`agent start` failed because the agent sat on a start-up dialog: find that pane over there
    and answer the dialog, so the session comes up instead of waiting for someone at the screen."""
    try:
        agents = D.herdr_list_agents(h)
    except BaseException:
        return None
    panes = [a for a in agents if (a.get("cwd") or "").rstrip("/") == remote_cwd.rstrip("/") and a.get("agent_status") == "blocked"]
    if not panes:
        return None
    pane = panes[-1]
    pressed = D.dismiss_startup_dialogs(h, pane["pane_id"])
    return {"pane_id": pane["pane_id"], "tab_id": pane.get("tab_id"), "dismissed": pressed}


# ---------------------------------------------------------------- hand-over

def running_remote(h, agent, sid):
    """Is this id already running over there (moved before, or resumed by hand)?"""
    dcmd = h.get("dispatch", "$HOME/.local/bin/dispatch")
    r = run_remote(h, f"BEADS_DIR=$HOME/tasks/.beads {dcmd} sessions --local --json", timeout=40)
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


def stop_original(agent, sid, keep=False, force=True):
    """Close this Mac's copy — the process and its Herdr pane — so the moved one is the only writer of
    the transcript. A working one is closed too unless force=False: handing the project over is what
    was asked for, and the transcript is copied after it stops, so nothing it wrote is lost. Never the
    process running this command."""
    live = next((s for s in D.live_sessions(local_only=True) if s.get("session_id") == sid and s.get("agent") == agent), None)
    if not live:
        return {"state": "not-running"}
    pid = live.get("agent_pid")
    if keep:
        return {"state": "kept", "pid": pid}
    was_working = live.get("state") == "working"
    if was_working and not force:
        return {"state": "working", "pid": pid}
    if not pid or pid in own_ancestors():
        return {"state": "self", "pid": pid}
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
                os.kill(int(pid), signal.SIGKILL)
            except OSError:
                pass
        time.sleep(0.25)
    else:
        return {"state": "failed", "pid": pid}
    try:
        os.remove(os.path.join(D.SESS_DIR, f"{agent}__{sid}.json"))
    except OSError:
        pass
    pane = (live.get("herdr") or {}).get("pane_id")
    if pane:
        try:
            D.herdr(None, ["pane", "close", pane])
        except Exception:
            pane = None
    return {"state": "stopped", "pid": pid, "was_working": was_working, "pane_closed": bool(pane)}


def copy_transcript(h, agent, path, sid, target, rewrite, remote_home):
    """This conversation's transcript (and a Claude conversation's sub-agent transcripts) into the other
    Mac's agent history, home paths rewritten so tool results point at files over there."""
    text = open(path, encoding="utf-8", errors="replace").read()
    if rewrite and D.HOME != remote_home:
        text = text.replace(D.HOME, remote_home)
    ssh(h, f"mkdir -p {shlex.quote(os.path.dirname(target))}")
    r = run_remote(h, f"cat > {shlex.quote(target)}", timeout=600, input=text)
    if r.returncode != 0:
        raise RuntimeError(f"复制会话记录失败：{r.stderr.strip()[-300:]}")
    subdir = os.path.join(os.path.dirname(path), sid)
    if agent == "claude-code" and os.path.isdir(subdir):
        subprocess.run(["rsync", "-a", "-e", "ssh -o BatchMode=yes", subdir + "/", f"{h['ssh']}:{shlex.quote(os.path.dirname(target) + '/' + sid)}/"], capture_output=True, text=True, errors="replace", timeout=600)


def mark_moved(h, keys):
    """Both Macs now hold these ids: this Mac marks its copies moved to h, h marks its copies moved from
    here — lists then show each conversation once, where it lives now."""
    for agent, sid in keys:
        D.record_move(agent, sid, moved_to=h["id"])
    me_ip = D.tailscale_ip()
    if me_ip and keys:
        dcmd = h.get("dispatch", "$HOME/.local/bin/dispatch")
        run_remote(h, "; ".join(f"BEADS_DIR=$HOME/tasks/.beads {dcmd} moves mark {shlex.quote(a + ':' + s)} --from {shlex.quote(me_ip)} >/dev/null" for a, s in keys), timeout=30 + 5 * len(keys))


def project_history(top, exclude):
    """This project's other Claude Code / Codex conversations (not running here): their transcripts go
    over too, so the whole history lives — and can be resumed — on the new Mac."""
    top = os.path.normpath(top)
    rows = []
    for p, r in (D.load_index() or {}).items():
        c = os.path.normpath(r.get("cwd") or "")
        if r.get("subagent") or r.get("agent") not in ("claude-code", "codex") or r.get("session_id") in exclude or not os.path.isfile(p):
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
    lines = [f"这段会话刚从 {D.local_host_name()} 迁移到了 {h['name']}，项目也一起交接过来了：以后这个项目在这台电脑上做。",
             f"项目目录现在是 {remote_cwd}（原来是 {cwd}），工作区已同步，包括 .git 和未提交的改动。",
             "先看上文做到哪一步，再在这台电脑上接着做；路径一律按新目录理解，缺依赖就装（npm ci、xcodegen 之类按项目约定来）。"]
    v = git.get("verify") or {}
    if v.get("checked") and not (v.get("head_match") and v.get("dirty_match")):
        lines.append("注意：同步后两边 Git 状态没对上，先 `git status` 核对再动手。")
    if env.get("manual"):
        lines.append("这台电脑上还缺这些工具：" + "；".join(f"{k}（{v}）" for k, v in env["manual"].items()) + "。能装的自己装，装不了的（比如 Xcode）告诉我。")
    if prompt_extra:
        lines.append(prompt_extra)
    return "\n".join(lines)


def move(session_id, to, prompt_extra="", sync=True, dry=False, force=False, keep_original=False, git_info=None):
    ref = find_ref(session_id)
    h = host_by(to)
    agent, cwd, path, sid = ref["agent"], ref["cwd"], ref["path"], ref["session_id"]
    if not os.path.isfile(path):
        raise RuntimeError("找不到会话文件")
    transcript_target(agent, path, cwd, "", "")  # unsupported agents fail before touching anything
    remote_home = ssh(h, "echo $HOME").strip()
    if not remote_home:
        raise RuntimeError("拿不到对方的 HOME")
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
    if agent == "claude-code":
        plan["trust"] = trust_folder(h, remote_cwd, apply=not dry)
        plan["memory"] = sync_memory(h, cwd, remote_home, remote_cwd, dry=dry)
    plan["others_here"] = others_here(root, sid) if files_here else []
    plan["project"] = project_name(cwd)
    if dry:
        return plan
    if git["conflicts"] and not force:
        raise RuntimeError("没有迁移，对方那边会丢东西：\n- " + "\n- ".join(git["conflicts"]) + "\n处理完再迁，确认可以覆盖就加 --force")
    # 1. files
    if files_here and not git_info:
        sync_files(h, root, remote_root, git)
        plan["files_synced"] = True
        plan["git"]["pushed"] = git.get("pushed")
        plan["git"]["verify"] = verify_git(h, root, remote_root)
    # 2. close this Mac's copy first: the transcript copied next is then complete, with one writer
    plan["original"] = stop_original(agent, sid, keep=keep_original)
    # 3. transcript (+ sub-agent transcripts for Claude)
    copy_transcript(h, agent, path, sid, target, rewrite, remote_home)
    # 4. resume over there, unless that copy already runs (a second resume would fork the transcript)
    dcmd = h.get("dispatch", "$HOME/.local/bin/dispatch")
    if plan["already_there"]:
        plan["started"] = {"already_running": True}
    else:
        kind = {"claude-code": "claude", "codex": "codex"}[agent]
        resume_flag = "--resume" if agent == "claude-code" else "resume"
        handoff = handoff_prompt(h, cwd, remote_cwd, plan["env"], plan["git"], prompt_extra)
        cmd = f"BEADS_DIR=$HOME/tasks/.beads {dcmd} agent start {kind} --cwd {shlex.quote(remote_cwd)} --label {shlex.quote(ref.get('title') or '迁移的会话')} --extra {shlex.quote(resume_flag + ' ' + sid)} --prompt {shlex.quote(handoff)} --no-wait --json"
        r = run_remote(h, cmd, timeout=240)
        out = r.stdout
        try:
            started = json.loads(out[out.find("{"):])
        except ValueError:
            started = {"raw": (out or r.stderr)[-400:]}
        if r.returncode != 0:
            # Typically "agent … is blocked during startup": a dialog the trust flag did not cover.
            fixed = unblock_start(h, remote_cwd, ref.get("title") or "")
            if not fixed:
                raise RuntimeError(f"{h['name']} 上没能起 Agent：{(r.stderr or out).strip()[-300:]}")
            started = dict(started if "raw" not in started else {}, **fixed, recovered=True)
        plan["started"] = started
    mark_moved(h, [(agent, sid)])
    # 5. hand the project over
    if files_here:
        plan["owner"] = set_owner(plan["project"], h)
    task = plan.get("task")
    if task:
        D.sh(["bd", "comment", task, f"会话 {sid[:8]} 已从 {D.local_host_name()} 迁移到 {h['name']}，在 {remote_cwd} 继续；项目 {plan['project']} 现在归 {h['name']}。"], timeout=30)
    return plan


# ---------------------------------------------------------------- project owner

def set_owner(project, h):
    """Record which Mac a project now lives on, in the shared board memory next to its star/archive
    flags, so both Macs agree and new sessions for it default there."""
    try:
        return D.project_owner_set(project, h["name"], h.get("ssh", "").split("@")[-1])
    except Exception as e:
        return {"error": str(e)[:200]}


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
        raise RuntimeError(f"本机没有项目 {name} 的会话记录；直接给目录路径也行")
    return max(counts, key=counts.get)


def move_project(name, to, dry=False, force=False, keep_original=False, prompt_extra=""):
    """Hand a whole project over: sync its folder once, move every conversation still running in it
    here (they resume over there), record the new owner."""
    h = host_by(to)
    top = project_dir(name)
    remote_home = ssh(h, "echo $HOME").strip()
    remote_top = remote_path(top, remote_home)
    git = git_preflight(h, top, remote_top)
    plan = {"project": project_name(top), "to": h["name"], "cwd": top, "remote_cwd": remote_top,
            "git": {k: v for k, v in git.items() if not k.startswith("_")}, "files": plan_files(h, top, remote_top, git)}
    live = [s for s in D.live_sessions(local_only=True) if s.get("agent") in ("claude-code", "codex") and not str(s.get("session_id", "")).startswith("pid-")
            and (os.path.normpath(s.get("cwd") or "") == top or os.path.normpath(s.get("cwd") or "").startswith(top + os.sep))]
    plan["sessions"] = [{"session_id": s["session_id"], "agent": s["agent"], "title": s.get("title") or "", "state": s.get("state")} for s in live]
    history = project_history(top, {s["session_id"] for s in live})
    plan["history"] = {"count": len(history), "mb": round(sum(os.path.getsize(r["path"]) for r in history) / 1e6)}
    if dry:
        return plan
    if git["conflicts"] and not force:
        raise RuntimeError("没有迁移，对方那边会丢东西：\n- " + "\n- ".join(git["conflicts"]) + "\n处理完再迁，确认可以覆盖就加 --force")
    sync_files(h, top, remote_top, git)
    plan["git"]["pushed"] = git.get("pushed")
    plan["git"]["verify"] = verify_git(h, top, remote_top)
    moved = []
    for s in live:
        try:
            r = move(s["session_id"], to, prompt_extra=prompt_extra, sync=True, force=True, keep_original=keep_original, git_info=git)
            moved.append({"session_id": s["session_id"], "original": r.get("original"), "started": bool(r.get("started"))})
        except Exception as e:
            moved.append({"session_id": s["session_id"], "error": str(e)[:300]})
    plan["moved"] = moved
    copied, failed = [], []
    for r in history:
        try:
            remote_cwd = remote_path(r["cwd"], remote_home)
            target, rewrite = transcript_target(r["agent"], r["path"], r["cwd"], remote_home, remote_cwd)
            copy_transcript(h, r["agent"], r["path"], r["session_id"], target, rewrite, remote_home)
            copied.append((r["agent"], r["session_id"]))
        except Exception as e:
            failed.append({"session_id": r["session_id"], "error": str(e)[:200]})
    mark_moved(h, copied)
    plan["history"].update(copied=len(copied), failed=failed[:10])
    plan["owner"] = set_owner(plan["project"], h)
    return plan


# ---------------------------------------------------------------- output

def describe_files(f):
    if not f:
        return ""
    s = f"同步 {f['send']} 个文件" + (f"、删除 {f['delete']} 个（这边已删）" if f.get("delete") else "")
    if f.get("skipped"):
        s += f"；构建产物不搬（对方自己构建/安装）：{'、'.join(f['skipped'][:5])}"
    if f.get("protected"):
        s += f"；对方这些不删：{'、'.join(f['protected'][:6])}"
    return s


def describe_git(g):
    l, r = g.get("local") or {}, g.get("remote") or {}
    if not l.get("git"):
        return "不是 Git 仓库，按普通目录复制"
    if not r.get("exists"):
        return f"对方还没有这个目录，整个复制（{l.get('branch')} @ {(l.get('head') or '')[:7]}）"
    return (f"这边 {l.get('branch')} @ {(l.get('head') or '')[:7]}（未提交 {l.get('dirty')}）→ 对方 {r.get('branch')} @ {(r.get('head') or '')[:7]}（未提交 {r.get('dirty')}）"
            + ("；历史用 git push 过去，对方的 stash 和 reflog 保留" if g.get("history") else ""))


ORIGINAL = {"stopped": "这边的原会话已停掉", "working": "这边的原会话正在跑，没停：跑完后关掉它", "self": "这边的原会话就是执行迁移的这个，没停：说完这轮就关", "kept": "按要求保留了这边的原会话",
            "failed": "这边的原会话没停下来，手动关掉", "not-running": "这边的原会话没在跑"}


def main(a):
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
    print(f"已迁移到 {res['to']}：{res['remote_cwd']}" + (f" · Herdr {s.get('pane_id')}" if s.get("pane_id") else "") + (" · 对方本来就在跑，没再起" if s.get("already_running") else "")
          + ("（启动时卡在对话框，已自动按过）" if s.get("recovered") else ""))
    if v.get("checked"):
        print("Git 核对：" + ("两边一致" if v["head_match"] and v["dirty_match"] else f"没对上（HEAD {'一致' if v['head_match'] else '不同'}，未提交改动{'一致' if v['dirty_match'] else '不同'}）"))
    print(ORIGINAL.get((res.get("original") or {}).get("state"), ""))
    for o in res.get("others_here") or []:
        print(f"⚠ 这边还有会话在这个项目里：{o['title'] or o['session_id'][:8]}（{o['state']}，{o['where']}）——它们会继续改这边的文件")
    if (res.get("owner") or {}).get("host"):
        print(f"项目 {res['project']} 现在归 {res['owner']['host']}：新建会话默认开在那台")


def main_project(a):
    try:
        res = move_project(a.name, a.move_to, dry=a.dry_run, force=a.force, keep_original=a.keep_original)
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False) if a.json else f"✗ {e}")
        if a.json:
            print(f"✗ {e}", file=sys.stderr)  # the desktop app shows stderr when a command fails
        sys.exit(1)
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
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
    hist = res.get("history") or {}
    if hist.get("count"):
        print(f"历史会话：{hist['count']} 段（{hist['mb']} MB）" + (f"，已搬 {hist['copied']} 段" if "copied" in hist else "，记录会一起搬过去") + (f"，{len(hist['failed'])} 段没搬成" if hist.get("failed") else ""))
    v = g.get("verify") or {}
    if v.get("checked"):
        print("Git 核对：" + ("两边一致" if v["head_match"] and v["dirty_match"] else "没对上，去对方 git status 看看"))
