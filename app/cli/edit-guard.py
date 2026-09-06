#!/usr/bin/env python3
"""edit-guard — file-level "who is editing what" for agents that share a machine.

Hooked into Claude Code / Codex before and after file edits. Registry lives in
~/tasks/.dispatch/edits/<hash>.json = {file, agent, session_id, ts, host}. Rules:
  * PreToolUse: if another live session touched this file within WINDOW minutes and this
    session has not been warned about it yet, DENY once with an explanation (the agent
    reads it, decides, and simply retries). Own edits and stale records never block.
  * PostToolUse: record the edit so the other agents see it (and `dispatch prime` can
    list "正在改：…" next to the neighbour).
Usage: edit-guard.py <agent> pre|post   (hook JSON on stdin; exit 0 always)
"""
import hashlib, json, os, re, sys, time

DIR = os.path.join(os.path.expanduser("~"), "tasks", ".dispatch", "edits")
WINDOW = 30 * 60
WARN_TTL = 15 * 60


def files_of(tool, inp):
    inp = inp or {}
    for k in ("file_path", "filePath", "path", "notebook_path"):
        if inp.get(k):
            return [inp[k]]
    # Codex apply_patch: paths are inside the patch text
    patch = inp.get("input") or inp.get("patch") or ""
    if isinstance(patch, str) and "*** Begin Patch" in patch:
        return re.findall(r"^\*\*\* (?:Update|Add|Delete) File: (.+)$", patch, re.M)
    return []


def key(path):
    return hashlib.sha1(os.path.abspath(path).encode()).hexdigest()[:16]


def load(path):
    try:
        return json.load(open(os.path.join(DIR, key(path) + ".json")))
    except Exception:
        return None


def prune():
    now = time.time()
    for n in os.listdir(DIR) if os.path.isdir(DIR) else []:
        p = os.path.join(DIR, n)
        try:
            if now - os.path.getmtime(p) > WINDOW:
                os.remove(p)
        except OSError:
            pass


def main():
    agent, phase = (sys.argv + ["", ""])[1:3]
    try:
        hook = json.loads(sys.stdin.read() or "{}")
    except Exception:
        hook = {}
    sid = hook.get("session_id") or hook.get("sessionId") or ""
    paths = files_of(hook.get("tool_name", ""), hook.get("tool_input"))
    if not paths or not sid:
        return
    os.makedirs(DIR, exist_ok=True)
    prune()
    now = time.time()
    if phase == "post":
        for p in paths:
            rec = load(p) or {}
            rec.update({"file": os.path.abspath(p), "agent": agent, "session_id": sid, "ts": now, "host": os.uname().nodename})
            json.dump(rec, open(os.path.join(DIR, key(p) + ".json"), "w"))
        return
    # pre: warn once per (file, other session) — a second attempt goes through
    for p in paths:
        rec = load(p)
        if not rec or rec.get("session_id") == sid or now - rec.get("ts", 0) > WINDOW:
            continue
        warned = rec.setdefault("warned", {})
        if now - warned.get(sid, 0) < WARN_TTL:
            continue
        warned[sid] = now
        json.dump(rec, open(os.path.join(DIR, key(p) + ".json"), "w"))
        mins = int((now - rec["ts"]) / 60)
        reason = (f"⚠ {os.path.basename(p)} 在 {mins} 分钟前被 {rec['agent']} 会话 {rec['session_id'][:8]} 改过，它可能还在改。"
                  f"先 `dispatch session {rec['session_id'][:8]}` 看它在做什么、确认你们不是在改同一处；如果确定要改，直接再试一次即可放行（15 分钟内不再拦这个文件）。")
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}, ensure_ascii=False))
        return


if __name__ == "__main__":
    main()
