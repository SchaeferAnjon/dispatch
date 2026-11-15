"""The Agents window's left column at the size of a real person's (2026-10-10): their registered projects, and Claude
Code conversations in each as many as they had (counted with `dispatch projects --sidebar`), titles synthetic.
Three projects have a conversation in the last four days (ALG, TUTOR, kanban), the rest are older and sit behind
"N more". ALG's only conversation runs in a worktree outside the project folder (an Orca workspace), kanban has
nine of its own and fourteen in sibling worktrees (kanban-wt/<name>) and two under .claude/worktrees, TUTOR one of its
own and one worktree. Each project with a worktree gets a "Worktrees" group under it. A few one-shot runs are
there too; they never show. Written before the app starts (`instance start --fixture sidebar-groups`); no agent
turn is sent, and nothing outside the instance's folder is written."""
import datetime
import json
import os
import re
import subprocess
import time
import uuid

import ide_e2e

DAY = 86400
# (name, folder under the instance, own conversations, worktree conversations, days since the newest one)
PROJECTS = [
    ("ALG", "icloud:河湾大学/2025WS/ALG", 0, 1, 0.2),
    ("TUTOR", "icloud:河湾大学/河湾大学兼职/TUTOR", 9, 1, 0.5),
    ("kanban", "Projects/kanban", 9, 16, 0.05),
    ("harbor", "Projects/harbor", 30, 4, 9),
    ("Signals and Systems", "icloud:河湾大学/2026ss/Signals and Systems", 8, 1, 12),
    ("redraft", "Projects/redraft", 10, 0, 15),
    ("bookmark", "Projects/bookmark", 5, 0, 20),
    ("tutor2", "icloud:河湾大学/河湾大学兼职/tutor2", 5, 0, 22),
    ("自媒体", "Documents/自媒体", 4, 0, 25),
    ("雅思刷题网站", "Projects/雅思刷题网站", 4, 0, 30),
    ("ReadOut", "Projects/ReadOut", 2, 0, 33),
    ("手机ai摄影", "Projects/手机ai摄影", 2, 0, 36),
    ("GetNewWord", "Projects/GetNewWord", 1, 0, 40),
    ("pipeline", "Projects/media/nas/pipeline", 1, 0, 45),
    ("typefree", "Documents/github_projects/typefree", 1, 0, 50),
    ("workflow", "Projects/workflow", 1, 0, 55),
]


def git(*args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, timeout=60)


def worktree_dir(root, places, name, folder, i):
    """Where the i-th worktree of a project lives, the way the person's are laid out."""
    if name == "ALG":
        return os.path.join(root, "orca", "workspaces", "ALG", "hake")
    if name == "kanban" and i >= 14:
        return os.path.join(folder, ".claude", "worktrees", "agent-%d" % i)
    if name == "kanban":
        return os.path.join(places, "Projects", "kanban-wt", "branch-%02d" % i)
    return folder + ".worktrees/" + "copy-%d" % i


def prepare(rec):
    root = rec["root"]
    places = os.path.join(root, "places")
    icloud = os.path.join(root, "home", "Library", "Mobile Documents", "com~apple~CloudDocs")
    config = os.path.join(root, "claude-home")
    env = ide_e2e.instance_env(rec)
    now = time.time()
    index, flags, expected = {}, {}, {}

    def conversation(title, cwd, when, entrypoint="cli"):
        sid = str(uuid.uuid5(uuid.NAMESPACE_URL, "dispatch-e2e-sidebar-groups:" + title))
        project = os.path.join(config, "projects", re.sub(r"[^A-Za-z0-9]", "-", cwd))  # how Claude Code names it
        os.makedirs(project, exist_ok=True)
        path = os.path.join(project, sid + ".jsonl")
        stamp = datetime.datetime.fromtimestamp(when, datetime.timezone.utc).isoformat()
        user = {"type": "user", "sessionId": sid, "cwd": cwd, "entrypoint": entrypoint, "timestamp": stamp,
                "uuid": str(uuid.uuid4()), "parentUuid": None, "isSidechain": False, "version": "2.1.82",
                "message": {"role": "user", "content": title}}
        reply = {**user, "type": "assistant", "uuid": str(uuid.uuid4()), "parentUuid": user["uuid"],
                 "message": {"role": "assistant", "content": [{"type": "text", "text": "Fixture response."}],
                             "id": "fixture", "model": "fixture", "stop_reason": "end_turn",
                             "usage": {"input_tokens": 0, "output_tokens": 0}}}
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(json.dumps(r, ensure_ascii=False) for r in (user, reply, {"type": "custom-title", "sessionId": sid, "customTitle": title})) + "\n")
        os.utime(path, (when, when))
        index[path] = {"agent": "claude-code", "session_id": sid, "cwd": cwd, "title": title, "first_prompt": title,
                       "entrypoint": entrypoint, "mtime": when, "size": os.path.getsize(path), "tasks": {}, "claims": [],
                       "user_msgs": 1, "assistant_msgs": 1}

    for name, rel, own, worktrees, newest in PROJECTS:
        folder = os.path.join(icloud, rel[len("icloud:"):]) if rel.startswith("icloud:") else os.path.join(places, rel)
        os.makedirs(folder, exist_ok=True)
        git("init", "-q", "-b", "main", cwd=folder)
        git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "start", cwd=folder)
        flags[name] = {"dir": folder, "starred": True}
        expected[name] = {"own": [], "worktrees": []}
        for i in range(own):
            title = "%s conversation %d" % (name, i + 1)
            if name == "kanban" and i == 0:  # a title too long for the row: it ends in an ellipsis, hovered or not
                title = "[Image #1] 你这是怎么回事啊 the engine icon moves when I hover a row in the sessions list"
            conversation(title, folder, now - (newest + i * 0.7) * DAY)
            expected[name]["own"].append(title)
        for i in range(worktrees):
            wt = worktree_dir(root, places, name, folder, i)
            if not os.path.isdir(wt):
                os.makedirs(os.path.dirname(wt), exist_ok=True)
                git("worktree", "add", "-q", "--detach", wt, cwd=folder)
            title = "%s worktree conversation %d" % (name, i + 1)
            conversation(title, wt, now - (newest + 0.1 + i * 0.5) * DAY)
            expected[name]["worktrees"].append(title)
        # one-shot runs (an SDK call nobody opened in the app): the sidebar never shows them
        conversation("%s one-shot run" % name, folder, now - newest * DAY, entrypoint="sdk-cli")

    code = subprocess.run(["bd", "memories", "--json"], env=env, capture_output=True, text=True, timeout=60)
    if code.returncode == 0 and code.stdout.strip():
        mem = json.loads(code.stdout[code.stdout.find("{"):])
        flags = {**json.loads(mem.get("dispatch-projects") or "{}"), **flags}
    subprocess.run(["bd", "remember", json.dumps(flags, ensure_ascii=False), "--key", "dispatch-projects"],
                   env=env, check=True, capture_output=True, text=True, timeout=60)
    state = rec["dispatch_dir"]
    with open(os.path.join(state, "transcript-index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False)
    with open(os.path.join(state, "chat-sessions.json"), "w", encoding="utf-8") as f:
        json.dump({}, f)
    return {"env": {"CLAUDE_CONFIG_DIR": config}, "record": {"sidebar_groups": expected}}
