"""Synthetic Claude Code history in the instance's own Claude folder, written before the app launches
(scenarios/cli-sidebar.mjs declares it: meta.instance.fixture). No agent turn is sent, and no real transcript or user
configuration is changed."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid



def fixtures(rec, folder):
    root, demo = Path(rec["root"]), Path(folder)
    wt = root / "projects/demo-wt/feature"
    wt.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "-C", str(demo), "worktree", "add", "--detach", str(wt)], check=True, capture_output=True)
    config = root / "claude-home"
    now = time.time()
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    index, started = {}, {}
    for title, cwd, ep, in_app in (
        ("CLI Conversation", demo, "cli", False),
        ("CLI App Conversation", demo, "sdk-cli", True),
        ("CLI One-shot", demo, "sdk-cli", False),
        ("CLI Worktree", wt, "cli", False),
    ):
        sid = str(uuid.uuid5(uuid.NAMESPACE_URL, "dispatch-e2e:" + title))
        project = config / "projects" / str(cwd).replace("/", "-")
        project.mkdir(parents=True, exist_ok=True)
        file = project / (sid + ".jsonl")
        user = {"type": "user", "sessionId": sid, "cwd": str(cwd), "entrypoint": ep, "timestamp": stamp,
                "uuid": str(uuid.uuid4()), "parentUuid": None, "isSidechain": False, "version": "2.1.82",
                "message": {"role": "user", "content": title}}
        assistant = {**user, "type": "assistant", "uuid": str(uuid.uuid4()), "parentUuid": user["uuid"],
                     "message": {"role": "assistant", "content": [{"type": "text", "text": "Fixture response."}],
                                 "id": "fixture", "model": "fixture", "stop_reason": "end_turn", "usage": {"input_tokens": 0, "output_tokens": 0}}}
        file.write_text("\n".join(json.dumps(r) for r in (user, assistant, {"type": "custom-title", "sessionId": sid, "customTitle": title})) + "\n")
        index[str(file)] = {"agent": "claude-code", "session_id": sid, "cwd": str(cwd), "title": title,
                            "first_prompt": title, "entrypoint": ep, "mtime": now, "size": file.stat().st_size,
                            "tasks": {}, "claims": [], "user_msgs": 1, "assistant_msgs": 1}
        if in_app:
            started["claude-code:" + sid] = now
    state = Path(rec["dispatch_dir"])
    (state / "transcript-index.json").write_text(json.dumps(index))
    (state / "chat-sessions.json").write_text(json.dumps(started))
    (root / "cli-sidebar-fixture.json").write_text(json.dumps({"sessions": list(index.values()), "worktree": str(wt)}, indent=2))


def prepare(rec):
    """`instance start --fixture cli-sidebar` (the scenario's meta.instance): four Claude Code conversations in the
    instance's own Claude folder before the app starts."""
    fixtures(rec, rec["folder"])
    return {"env": {"CLAUDE_CONFIG_DIR": os.path.join(rec["root"], "claude-home")}}
