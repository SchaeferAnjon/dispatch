"""Move a conversation to another Mac and carry on there (`dispatch move`).

A conversation is a transcript file plus a working directory. Moving it means:
  1. rsync the project folder (uncommitted changes included) to the same place
     relative to the other Mac's home;
  2. copy the transcript into that Mac's agent history, with home paths rewritten;
  3. start the agent there through its Dispatch/Herdr with `--resume <id>` and a
     hand-off prompt that says where the files now live;
  4. leave a note on the task the session was working on.
The session on this Mac is left untouched; close it when the other side has taken over.
Supports Claude Code and Codex (both resume by id). pi keeps its sessions in its own
store and is not moved yet.
"""
import json, os, re, shlex, subprocess, sys

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


def preflight(h, path, agent, install=True):
    """Which of the tools this conversation used are missing over there; brew what it can."""
    used = commands_used(path, agent)
    if not used:
        return {"used": [], "missing": [], "installed": [], "manual": {}}
    script = "for c in " + " ".join(shlex.quote(u) for u in used) + '; do command -v "$c" >/dev/null 2>&1 || echo "$c"; done'
    missing = [x for x in ssh(h, f"export PATH=$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH; {script}", timeout=60, check=False).split() if x]
    installed, manual = [], {}
    if install and missing:
        formulas = sorted({BREW[m] for m in missing if m in BREW})
        if formulas:
            r = subprocess.run(["ssh", "-o", "BatchMode=yes", h["ssh"], "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; brew install --quiet " + " ".join(formulas)], capture_output=True, text=True, timeout=1800)
            if r.returncode == 0:
                installed = formulas
        still = [x for x in ssh(h, f"export PATH=$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH; {script}", timeout=60, check=False).split() if x]
        missing = still
    for m in missing:
        manual[m] = MANUAL.get(m, BREW.get(m, "") and f"brew install {BREW[m]}") or "自己装"
    return {"used": used, "missing": missing, "installed": installed, "manual": manual}


def ssh(h, cmd, timeout=60, check=True):
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", h["ssh"], cmd], capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"{h['name']}：{(r.stderr or r.stdout).strip()[-300:]}")
    return r.stdout


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
        if name.lower() in (h["id"].lower(), h["name"].lower()):
            return h
    raise RuntimeError(f"hosts.json 里没有 {name}；先在那台电脑的首次设置里接入这台，或者反过来")


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


def move(session_id, to, prompt_extra="", sync_files=True, dry=False):
    ref = find_ref(session_id)
    h = host_by(to)
    agent, cwd, path, sid = ref["agent"], ref["cwd"], ref["path"], ref["session_id"]
    if not os.path.isfile(path):
        raise RuntimeError("找不到会话文件")
    remote_home = ssh(h, "echo $HOME").strip()
    if not remote_home:
        raise RuntimeError("拿不到对方的 HOME")
    if cwd.startswith(D.HOME + "/"):
        remote_cwd = remote_home + cwd[len(D.HOME):]
    elif cwd == D.HOME:
        remote_cwd = remote_home
    else:
        remote_cwd = cwd  # outside home (e.g. /opt/x): same absolute path
    target, rewrite = transcript_target(agent, path, cwd, remote_home, remote_cwd)
    plan = {"session": sid, "agent": agent, "from": D.local_host_name(), "to": h["name"], "cwd": cwd, "remote_cwd": remote_cwd, "transcript": target, "task": (ref.get("claims") or [None])[-1] if ref.get("claims") else ref.get("current_task")}
    plan["env"] = preflight(h, path, agent, install=not dry)
    if dry:
        return plan
    # 1. files
    if sync_files and cwd and cwd != D.HOME and os.path.isdir(cwd):
        ssh(h, f"mkdir -p {shlex.quote(remote_cwd)}")
        cmd = ["rsync", "-a", "--delete-excluded"] + [x for e in EXCLUDES for x in ("--exclude", e)] + ["-e", "ssh -o BatchMode=yes", cwd.rstrip("/") + "/", f"{h['ssh']}:{remote_cwd.rstrip('/')}/"]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
        if r.returncode != 0:
            raise RuntimeError(f"同步项目文件失败：{r.stderr.strip()[-300:]}")
        plan["files_synced"] = True
    # 2. transcript (+ sub-agent transcripts for Claude)
    text = open(path, encoding="utf-8", errors="replace").read()
    if rewrite and D.HOME != remote_home:
        text = text.replace(D.HOME, remote_home)
    ssh(h, f"mkdir -p {shlex.quote(os.path.dirname(target))}")
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", h["ssh"], f"cat > {shlex.quote(target)}"], input=text, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"复制会话记录失败：{r.stderr.strip()[-300:]}")
    subdir = os.path.join(os.path.dirname(path), sid)
    if agent == "claude-code" and os.path.isdir(subdir):
        subprocess.run(["rsync", "-a", "-e", "ssh -o BatchMode=yes", subdir + "/", f"{h['ssh']}:{os.path.dirname(target)}/{sid}/"], capture_output=True, text=True, timeout=600)
    # 3. resume over there, with a hand-off note
    handoff = (f"这段会话刚从 {D.local_host_name()} 迁移到了 {h['name']}。项目目录现在是 {remote_cwd}（原来是 {cwd}），工作区文件已经同步过来，包括未提交的改动。"
               f"先看上文里做到哪一步，然后在这台电脑上接着做；路径一律按新目录理解，需要的依赖没装就装。"
               + (f"\n这台电脑上还缺这些工具：" + "；".join(f"{k}（{v}）" for k, v in plan["env"]["manual"].items()) + "。能装的自己装，装不了的（比如 Xcode）告诉我。" if plan["env"]["manual"] else "")
               + (f"\n{prompt_extra}" if prompt_extra else ""))
    kind = {"claude-code": "claude", "codex": "codex"}[agent]
    resume_flag = "--resume" if agent == "claude-code" else "resume"
    dcmd = h.get("dispatch", "$HOME/.local/bin/dispatch")
    cmd = f"env BEADS_DIR=$HOME/tasks/.beads {dcmd} agent start {kind} --cwd {shlex.quote(remote_cwd)} --label {shlex.quote(ref.get('title') or '迁移的会话')} --extra {shlex.quote(resume_flag + ' ' + sid)} --prompt {shlex.quote(handoff)} --no-wait --json"
    out = ssh(h, cmd, timeout=240)
    try:
        started = json.loads(out[out.find("{"):])
    except ValueError:
        started = {"raw": out[-400:]}
    plan["started"] = started
    # 4. board note
    task = plan.get("task")
    if task:
        D.sh(["bd", "comment", task, f"会话 {sid[:8]} 已从 {D.local_host_name()} 迁移到 {h['name']}，在 {remote_cwd} 继续。"], timeout=30)
    return plan


def main(a):
    try:
        res = move(a.session, a.to, prompt_extra=a.prompt or "", sync_files=not a.no_files, dry=a.dry_run)
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False) if a.json else f"✗ {e}")
        sys.exit(1)
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    elif a.dry_run:
        env = res.get("env", {})
        print(f"会打包 {res['agent']} 会话 {res['session'][:8]}：{res['cwd']} → {res['to']}:{res['remote_cwd']}，记录放 {res['transcript']}")
        print(f"用过的工具 {len(env.get('used', []))} 个；对方缺：" + ("、".join(env["missing"]) if env.get("missing") else "无"))
    else:
        s = res.get("started") or {}
        print(f"已迁移到 {res['to']}：{res['remote_cwd']}" + (f" · Herdr {s.get('pane_id')}" if s.get("pane_id") else "") + "\n这台上的原会话可以关了；对方会话页能看到它继续。")
