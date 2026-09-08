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
               f"先看上文里做到哪一步，然后在这台电脑上接着做；路径一律按新目录理解，需要的依赖没装就装。" + (f"\n{prompt_extra}" if prompt_extra else ""))
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
        print(f"会打包 {res['agent']} 会话 {res['session'][:8]}：{res['cwd']} → {res['to']}:{res['remote_cwd']}，记录放 {res['transcript']}")
    else:
        s = res.get("started") or {}
        print(f"已迁移到 {res['to']}：{res['remote_cwd']}" + (f" · Herdr {s.get('pane_id')}" if s.get("pane_id") else "") + "\n这台上的原会话可以关了；对方会话页能看到它继续。")
