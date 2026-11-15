"""OpenCode's session storm (kanban task-mpidn, the opencode-storm scenario): the agent host knows 200 OpenCode
sessions that OpenCode no longer has, next to 100 that it does. 0.9.2 asked `opencode db` once per missing id,
again on every listing: about 45 processes at a time on the author's Mac.

Two starts make it, as on a real Mac (a session discovered once stays in the agent host's registry):
  STORM_PHASE=seed     the instance's opencode.db has the 100 sessions and the 200 to go, all with a message; the
                       scenario waits until the agent host listed them, then the caller stops the instance and keeps
                       its profile folders (user-data, agents-user-data, shared-data) in STORM_STASH.
  STORM_PHASE=measure  the profile folders come back from STORM_STASH, and opencode.db has only the 100: the 200 ids
                       the agent host knows are not in OpenCode any more.
Everything is in the instance: its own XDG_DATA_HOME (opencode.db), the stash folder the caller names.
"""
import os
import shutil
import sqlite3
import subprocess
import time

REAL = 100
GONE = 200
PROFILE = ("user-data", "agents-user-data", "shared-data")


def opencode():
    extra = [os.path.expanduser(p) for p in ("~/.opencode/bin", "~/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin")]
    found = shutil.which("opencode", path=os.pathsep.join([os.environ.get("PATH", "")] + extra))
    if not found:
        raise RuntimeError("opencode_storm: no opencode on this Mac (meta.needs has opencode)")
    return found


def make_database(root, folder, gone):
    data = os.path.join(root, "xdg-data")
    os.makedirs(os.path.join(data, "opencode"), exist_ok=True)
    env = dict(os.environ, XDG_DATA_HOME=data, XDG_CONFIG_HOME=os.path.join(root, "xdg-config"))
    # OpenCode makes its database and its tables itself
    subprocess.run([opencode(), "db", "SELECT count(*) FROM session", "--format", "json"], env=env, cwd=root,
                   stdin=subprocess.DEVNULL, capture_output=True, timeout=180, check=True)
    db = os.path.join(data, "opencode", "opencode.db")
    now = int(time.time() * 1000)
    con = sqlite3.connect(db, timeout=30)
    try:
        con.execute("INSERT OR IGNORE INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES ('global', '/', NULL, ?, ?, '[]')", (now, now))
        rows = [("real", i) for i in range(REAL)] + ([("gone", i) for i in range(GONE)] if gone else [])
        for kind, i in rows:
            sid = "ses_storm%s%07d" % (kind, i)
            # the ones to go are the newest: 0.9.2 lists the 300 most recent
            at = now - (3600_000 * 24 if kind == "real" else 3600_000) - i * 60_000
            title = "Storm %s session %d" % (kind, i + 1)
            con.execute("INSERT OR REPLACE INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) "
                        "VALUES (?, 'global', ?, ?, ?, '1.18.35', ?, ?)", (sid, "storm-%s-%d" % (kind, i), folder, title, at, at))
            mid = "msg_storm%s%07d" % (kind, i)
            con.execute("INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
                        (mid, sid, at, at, '{"role":"user","time":{"created":%d}}' % at))
            con.execute("INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
                        ("prt_storm%s%07d" % (kind, i), mid, sid, at, at, '{"type":"text","text":"%s"}' % title))
        con.commit()
    finally:
        con.close()
    return db


def prepare(rec):
    phase = os.environ.get("STORM_PHASE", "seed")
    root = rec["root"]
    folder = rec.get("folder") or root
    if phase == "measure":
        stash = os.environ.get("STORM_STASH", "")
        if not stash or not os.path.isdir(os.path.join(stash, "user-data")):
            raise RuntimeError("opencode_storm: STORM_STASH has no user-data from a seed run: %s" % stash)
        for name in PROFILE:
            src = os.path.join(stash, name)
            if os.path.isdir(src):
                dst = os.path.join(root, name)
                shutil.rmtree(dst, ignore_errors=True)
                shutil.copytree(src, dst, symlinks=True)
    db = make_database(root, folder, gone=(phase != "measure"))
    return {"env": {}, "record": {"storm_phase": phase, "storm_db": db, "storm_real": REAL, "storm_gone": GONE if phase != "measure" else 0}}
