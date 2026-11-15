#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""edit-guard — file-level "who is editing what" for agents that share a machine.

Hooked into Claude Code / Codex before and after file edits. Registry lives in
~/tasks/.dispatch/edits/<hash>.json = {file, agent, session_id, ts, host}. Rules:
  * PreToolUse: if another live session touched this file within WINDOW minutes and this
    session has not been warned about it yet, DENY once with an explanation (the agent
    reads it, decides, and simply retries). Own edits and stale records never block.
  * PostToolUse: record the edit so the other agents see it (and `dispatch prime` can
    list "正在改：…" next to the neighbour).
  * Territory (ownership.py): before the edit, a file inside the territory of another task that
    is In progress or Waiting for you (`dispatch begin --owns`, <DISPATCH_DIR>/owns.json) is
    pointed out. The session's permission mode decides how: bypassPermissions lets it through
    with one line of warning in the session (and a record in owns-log.jsonl); the asking modes
    hold it back once with whose territory it is, and the retry goes through (15 minutes).
Usage: edit-guard.py <agent> pre|post   (hook JSON on stdin; exit 0 always)
"""
import hashlib, json, os, re, sys, time
sys.dont_write_bytecode = True  # never write __pycache__ next to these files: inside Dispatch.app that breaks the code signature
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dplatform as P
import ownership as O
from lang import t as _t

DIR = os.path.join(os.environ.get("DISPATCH_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".dispatch"), "edits")
WINDOW = 30 * 60
WARN_TTL = 15 * 60
# modes where the person already said "don't ask": a territory is only pointed out
PASS_MODES = ("bypassPermissions", "bypass", "danger-full-access", "never")


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


def _node():
    """Network name of this machine (os.uname on macOS / Linux; Windows has no os.uname)."""
    return os.uname().nodename if hasattr(os, "uname") else P.host_name()


def key(path):
    return hashlib.sha1(os.path.abspath(path).encode()).hexdigest()[:16]


def load(path):
    try:
        return json.load(open(os.path.join(DIR, key(path) + ".json"), encoding="utf-8"))
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
    """`edit-guard.py <agent> pre|post`, the hook JSON on stdin: what pi's extension runs (agent/pi/dispatch.ts).
    Claude Code reaches check() through Dispatch's one hook entry (hook.py)."""
    agent, phase = (sys.argv + ["", ""])[1:3]
    try:
        hook = json.loads(sys.stdin.read() or "{}")
    except Exception:
        hook = {}
    out = check(agent, phase, hook if isinstance(hook, dict) else {})
    if out:
        print(json.dumps(out, ensure_ascii=False))


def check(agent, phase, hook):
    """pre: the hook answer that holds the edit back or points something out, None to let it through quietly.
    post: records the edit (None)."""
    sid = hook.get("session_id") or hook.get("sessionId") or ""
    paths = files_of(hook.get("tool_name", ""), hook.get("tool_input"))
    if not paths or not sid:
        return None
    os.makedirs(DIR, exist_ok=True)
    prune()
    now = time.time()
    if phase == "post":
        for p in paths:
            rec = load(p) or {}
            rec.update({"file": os.path.abspath(p), "agent": agent, "session_id": sid, "ts": now, "host": _node()})
            json.dump(rec, open(os.path.join(DIR, key(p) + ".json"), "w", encoding="utf-8"))
        return None
    # pre: another task's territory first, then another session's recent edit
    mode = str(hook.get("permission_mode") or hook.get("permissionMode") or "")
    reasons, notes = [], []
    for p in paths:
        r = territory(p, sid, agent, mode, hook.get("cwd") or None, now)
        if r:
            (notes if r[0] == "note" else reasons).append(r[1])
    if reasons:
        return deny(" ".join(reasons))
    if notes:
        text = " ".join(notes)
        return {"systemMessage": text, "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": text}}
    # warn once per (file, other session) — a second attempt goes through
    for p in paths:
        rec = load(p)
        if not rec or rec.get("session_id") == sid or now - rec.get("ts", 0) > WINDOW:
            continue
        warned = rec.setdefault("warned", {})
        if now - warned.get(sid, 0) < WARN_TTL:
            continue
        warned[sid] = now
        json.dump(rec, open(os.path.join(DIR, key(p) + ".json"), "w", encoding="utf-8"))
        mins = int((now - rec["ts"]) / 60)
        reason = _t(f"⚠ {os.path.basename(p)} was changed {mins} min ago by {rec['agent']} session {rec['session_id'][:8]}, which may still be working on it. "
                    f"First see what it does with `dispatch session {rec['session_id'][:8]}` and make sure you are not changing the same place; if you are sure, just try again and it goes through (this file is not stopped again for 15 minutes).",
                    f"⚠ {os.path.basename(p)} 在 {mins} 分钟前被 {rec['agent']} 会话 {rec['session_id'][:8]} 改过，它可能还在改。"
                    f"先 `dispatch session {rec['session_id'][:8]}` 看它在做什么、确认你们不是在改同一处；如果确定要改，直接再试一次即可放行（15 分钟内不再拦这个文件）。")
        return deny(reason)
    return None


def deny(reason):
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}


def _warned_path():
    return os.path.join(DIR, "owns-warned.json")


def territory(path, sid, agent, mode, cwd, now):
    """("deny" | "note", text) when `path` is in another live task's territory and this session
    was not told about that task in the last WARN_TTL; else None. Every hit goes to owns-log.jsonl."""
    try:
        hits = O.owners_of(path, sid, cwd)
    except Exception:
        return None
    if not hits:
        return None
    task, where = hits[0]
    try:
        with open(_warned_path(), encoding="utf-8") as f:
            warned = json.load(f)
    except Exception:
        warned = {}
    warned = {k: v for k, v in warned.items() if now - v < WARN_TTL}
    key = f"{sid}|{task['id']}"
    passing = mode in PASS_MODES
    action = "passed" if passing else ("allowed-after-warning" if key in warned else "held")
    try:
        with open(os.path.join(os.path.dirname(DIR), "owns-log.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": int(now), "session": sid, "agent": agent, "file": os.path.abspath(os.path.join(cwd or os.getcwd(), path)), "task": task["id"],
                                "territory": O.label(where), "mode": mode, "action": action}, ensure_ascii=False) + "\n")
    except OSError:
        pass
    if key in warned:
        return None
    warned[key] = now
    try:
        with open(_warned_path(), "w", encoding="utf-8") as f:
            json.dump(warned, f)
    except OSError:
        pass
    who = task.get("agent") or "?"
    name = os.path.basename(path)
    if passing:
        return ("note", _t(f"⚠ {name} is in {O.label(where)}, the area claimed by the task in progress \"{task['title']}\" ({task['id']}, {who}). Bypass mode does not stop it: it went through and was recorded; make sure you do not collide with it (`dispatch task show {task['id']}`).",
                           f"⚠ {name} 在进行中任务「{task['title']}」（{task['id']}，{who}）登记的地盘 {O.label(where)} 里。bypass 模式不拦，这次已放行并记录；改之前确认没和它撞车（`dispatch task show {task['id']}`）。"))
    return ("deny", _t(f"⚠ {name} is in {O.label(where)}, the area claimed by the task in progress \"{task['title']}\" ({task['id']}, {who}), so it was stopped this time. "
                       f"First see what that task does with `dispatch task show {task['id']}` and split the work; if you are sure, try again (this task's area is not stopped again for 15 minutes), "
                       f"or ask it to give the area up with `dispatch task own {task['id']} --rm \"{O.label(where)}\"`.",
                       f"⚠ {name} 在进行中任务「{task['title']}」（{task['id']}，{who}）登记的地盘 {O.label(where)} 里，这次先拦下。"
                       f"先 `dispatch task show {task['id']}` 看它在做什么、和它分工；确定要改就再试一次（15 分钟内这个任务的地盘不再拦），"
                       f"或者请它 `dispatch task own {task['id']} --rm \"{O.label(where)}\"` 让出来。"))


if __name__ == "__main__":
    main()
