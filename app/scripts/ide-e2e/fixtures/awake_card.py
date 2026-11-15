"""The cup's panel sets Keep awake right there (scenarios/awake-card.mjs, meta.instance.fixture "awake-card"): the cup
shows only while the background service holds the Mac, so this instance has one agent at work, and nothing it holds
touches the Mac's power settings.

- An agent at work: a session record in the instance's Dispatch data (state working) whose process is a `sleep` the
  fixture starts; `live_sessions` counts it like a hook-registered agent. The scenario ends that `sleep`, and it ends by
  itself after 30 minutes anyway.
- No real power assertion: a `caffeinate` of our own comes first on the instance's PATH (its window chatd runs
  `caffeinate -is|-dis -t 90` by name, app/cli/awake.py). It writes each call to a log the scenario reads and sleeps for
  the time asked, so the service sees a hold that lasts; the Mac's idle sleep and screen are left as they are.
- A HOME of its own (<instance>/home): nothing the instance runs writes to the person's home folder."""
import json
import os
import stat
import subprocess
import time


def prepare(rec):
    root = rec["root"]
    fake = os.path.join(root, "fake-bin")
    os.makedirs(fake, exist_ok=True)
    log = os.path.join(root, "caffeinate.log")
    script = os.path.join(fake, "caffeinate")
    with open(script, "w", encoding="utf-8") as f:
        f.write("#!/bin/sh\n# a stand-in for caffeinate: holds nothing, says what it was asked\n"
                f"echo \"$(date +%s) $*\" >> '{log}'\n"
                "t=90\nwhile [ $# -gt 0 ]; do [ \"$1\" = -t ] && t=\"$2\"; shift; done\nexec sleep \"$t\"\n")
    os.chmod(script, os.stat(script).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    open(log, "a").close()

    worker = subprocess.Popen(["sleep", "1800"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              start_new_session=True)
    sessions = os.path.join(rec["dispatch_dir"], "sessions")
    os.makedirs(sessions, exist_ok=True)
    now = time.time()
    with open(os.path.join(sessions, "awake-card.json"), "w", encoding="utf-8") as f:
        json.dump({"agent": "opencode", "session_id": "awake-card-worker", "agent_pid": worker.pid, "cwd": rec.get("folder") or root,
                   "project": os.path.basename(rec.get("folder") or root), "state": "working", "state_source": "fixture",
                   "title": "Keeps the Mac awake for the test", "started_at": now, "last_at": now}, f)

    home = os.path.join(root, "home")
    os.makedirs(home, exist_ok=True)
    return {"env": {"PATH_PREPEND": fake, "HOME": home},
            "record": {"caffeinate_log": log, "fake_caffeinate": script, "worker_pid": worker.pid, "fake_home": home}}
