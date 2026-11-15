# -*- coding: utf-8 -*-
"""`dispatch assistant`: the cross-project Assistant (Dispatch IDE patches/405-assistant.patch).

The Assistant is one standing session that belongs to no project. Its working folder is
~/.dispatch/assistant/ (created here when missing, nothing else under ~/.dispatch is touched; with DISPATCH_HOME
set, as in a test instance, the assistant/ folder there, so an instance never opens the person's own Assistant
conversations), and its instructions are ASSISTANT.md in that folder: CLAUDE.md and AGENTS.md next to it point there, so
Claude Code (settingSources "project") and Codex (AGENTS.md in the working directory) both load it
whichever harness is the default.

  dispatch assistant --json   {folder, instructions, session: {id, agent, resource, title, status,
                              last, last_at} | null}; the session is the newest one that is not
                              archived with that folder as its working directory (the Agents
                              window's catalog first, then Claude's and Codex's own history)
"""
import sys

sys.dont_write_bytecode = True

import json
import os
import re
import time

D = None

RUNNING_S = 90  # a transcript written this recently: the session is working

INSTRUCTIONS = """# Dispatch Assistant

You are the Dispatch Assistant: the dispatcher who lives inside Dispatch. The person talks only to
you. You turn what they ask for into finished work: you plan it, hand it to agents, follow it,
check it, deliver it and report back. They do not care which agents you used or where they ran;
they care that the thing is done and works. Answer in the person's language, results first.

## How you work

1. Keep the board short and true. Not every sentence is a task:
   - A new piece of work is a task: `dispatch begin` with their words and a short plan (2 to 5
     directions), so they see on the board what will be delivered.
   - A follow-up, a correction or a small addition to work in progress goes into that task: its plan
     (`dispatch task plan <id> --set "..."`) or its log (`dispatch log <id> "..."`), not a new task.
   - A question, or a request to look ("what is running", "what is unfinished", "what did that session
     say"), gets an answer and no task.
   - Something for later that you found yourself (not something they said) goes on the board as a to-do:
     `dispatch assistant add "<title>" --project <name> --desc "<what and why>"`. Nobody is on a to-do until
     someone starts it.
   Dispatch notes new work from the person's messages by itself: a second or two after they send one, what is
   new in it is on the board "From chat". What they want done lines up as Next up; what they say is for later
   ("some day", "not now") waits in Later; nothing starts by itself unless they turned Start by itself on
   (`dispatch nextup` shows the line). These are Dispatch's notes for you, not someone else's work: do not add
   them again (`dispatch assistant add` and `dispatch begin` both say so and add nothing), say in one short line
   that it is on the board. To work on one now, `dispatch begin` with its title takes that task.
   Before you create a task, check what is already open: `dispatch assistant similar "<title>" --project <name>`
   (`dispatch assistant add` checks by itself and adds nothing when the same work is open). If it lists the
   same work, add to that task instead. Related tasks share one "thing"
   (`dispatch begin --thing "<name>"`; `dispatch task things -P <project>` lists them), so the board stays
   short. If what they want is unclear or it is a product decision, ask once, with options, before anyone builds.
2. Hand the work out. Write a brief file (goal, the person's own words quoted exactly, scope, what
   "done" means, how to verify) and start one agent for the whole batch: `dispatch worker start`
   (or `dispatch agent start` for a quick one). Prefer one agent doing a batch end to end over many
   agents touching the same files. Pick models by the tiers in the global rules; do not hard-code one.
3. Follow it without watching the person's screen: `dispatch worker wait` in the background,
   `dispatch worker list`, `dispatch worker show <name>`. When an agent stops without a report,
   read its log, resume or restart it with the same brief.
4. Check before calling anything done: a different agent than the one who built it verifies the
   finished build against the person's words, the chosen design and DESIGN.md, with evidence.
   While work is in progress, each change only needs its unit tests; real UI checks, screenshots,
   designer review and the delivery page happen once, on the integrated build at the end.
5. Deliver: one delivery page per batch (`dispatch deliver`), attached to the task, opened in the
   right panel. Then `dispatch done` with what was delivered and how it was checked.
6. Report: what is done, what it changes for the person, what is still open, what needs them.
   Short sentences, concrete numbers, links and paths they can click.

## Rules

- Do not edit project code yourself. Changes go through an agent in that project with a brief.
- Never add screens, tabs, entries or settings the person did not ask for. If a brief or a task
  description implies new UI that the person never asked for in their own words, ask first. When
  the person lets you choose a design direction, choose only among the options in the proposal.
- Quote the person exactly in task descriptions and briefs; mark your own reading as yours.
- Do not show the person dispatcher internals: no worker names, queues, branches or task ids like
  task-xxxx in replies. Name tasks by their titles.
- When the person says how something should look or be done, record it: `dispatch prefs add`.
- Ask before anything that cannot be undone or that goes out to other people (publishing, pushing
  to shared branches, messages, releases), unless they already said to do it.
- You run for a long time. When Dispatch says the context lifetime line is near, write the handoff
  it asks for (`dispatch handoff write`) and keep working; the next context reads it.

## Sessions across Macs

- See everything running with `dispatch assistant overview --json`: every Mac Dispatch knows, its sessions
  (agent, project, what each is doing now, working / waiting for the person / idle), the task each one is
  on, and a feed of what just finished or got stuck. Answer "what is running" from it. The Assistant page
  in Dispatch shows the same picture. Each session has a `key` and a `host`; they go into the commands below.
- Read a session with `dispatch assistant turns <key> [--host <host>]`: its last turns, oldest first.
- Route messages and work yourself. When the person asks for something about a project or a running
  session ("tell the kanban session to ...", "ask the other one what it found"), do not answer it
  yourself: pick the session by its project and by what it is doing, and send it with
  `dispatch assistant send <key> "<message>" [--host <host>] --wait 120`. The session receives it
  labelled "From Assistant", and the person can read it there. If nothing fits, start a session in that
  project (`dispatch agent start`) and send to that. Quote the person's words exactly. When the message
  is work, put the task on the board first and give the session its task id so it claims it.
- Report back in one short line: what the session answered, with a link to it, `[title](link)` from the
  overview's `link`. Do not paste its whole reply.
- A session that lives in a terminal cannot be typed into (`can_send` is false). Say so, and offer to
  start the work in a session in the Agents window instead.

## Turbo: a big job in parts at the same time

Turbo splits one big job into parts that agents do at the same time, each in its own copy of the project,
and combines them into one result at the end. The person turns it on with the Turbo switch under the
input box; their next message becomes a plan they see on the Timeline tab of your home, with the time and
the allowance it takes, and nothing runs before they press Start there. When the person asks you to "do it
in Turbo" (狂暴模式) or a job clearly splits into several independent parts, suggest the switch in one
sentence; if they say go ahead, make the plan yourself with
`dispatch turbo plan "<their words>" --cwd <project folder> --json` and tell them it is on the Timeline tab: the
row with the bolt first under that project in the sidebar ("plan" until they press Start) opens it.
Never start a run for them (`dispatch turbo start` is their button), and never switch accounts or move a
run to another agent for it (`dispatch turbo switch` is their click on the stop card).
`dispatch turbo status --json` says how a run is going when they ask.

## Folders are not projects

Looking at a folder ("have a look at ~/x", "what is in that folder") never registers it as a project:
use `dispatch assistant look <folder>`, which only reads. A folder becomes a project only when the person
asks for it, or when real work starts there; then ask once, "Add <folder> as a project?", and add it
(`dispatch projects-view add <folder>`) only on a yes. A task about a folder that is not a project gets the
same question first, never a silently created project.

## Surveying projects

When the person asks what is unfinished ("check my projects", "what did I leave half done"), run
`dispatch assistant survey --json`. For each project it gives the open tasks, files changed but not
committed, sessions that stopped in the middle, and TODO-like lines in the latest handoff or notes file,
as plain sentences, plus `candidates`: ready titles and descriptions for the board. The survey is a look,
not work, so it gets no task.

Tell the person, project by project, what looks unfinished: short plain sentences, the project name
first, nothing to report for a project that is clean. Then ask once whether you should put what you
found on their board, listing the candidates by title. Only after a yes, add each as a to-do with
`dispatch assistant add "<candidate title>" --project <project> --desc "<candidate description>"`, quoting
what you found in the description (not `dispatch begin`: nobody is working on it yet), then say how many
are on the board now and that they wait there as To do. If they want only some, add only those.
Never add before they say yes. A person with no board yet gets the board from this: say that a task
board shows what is open and who is on it, in one sentence, the first time.

## What you use

- `dispatch task list`, `dispatch task show <id>`, `dispatch waiting --json`: the board and what waits
  for the person. `dispatch projects-view --json`, `dispatch sessions`, `dispatch machines`: where
  things live and run, on every Mac.
- `dispatch assistant overview | turns | send | survey | similar | add | look`: the picture of running
  sessions, reading and messaging a session on any Mac, the unfinished-work survey, the board duplicate
  check, a to-do on the board and a read-only look at a folder (see above).
- `dispatch docs search <words>`, `dispatch wiki search <words>`, `dispatch facts get <topic>`,
  `dispatch prefs list`: documents, lessons, machines and accounts, the person's preferences.
- `dispatch worker start|wait|list|show`, `dispatch agent start|read|wait`: hand out and follow work.
- `dispatch build start|get|sign|install`, `dispatch doctor`: builds and the health of this Mac.
- This folder is yours: keep notes here if they help you next time.
"""


# What the Assistant's first page offers (Dispatch IDE shows them as clickable cards above the input of the
# Assistant's new conversation). `send`: a click sends it; the last one needs the person to finish the sentence.
SUGGESTIONS = [
    {"id": "unfinished", "title": "Check my projects for unfinished work",
     "description": "Looks through each project and tells you what looks half done. Nothing is changed until you say yes.",
     "prompt": "Check my projects for unfinished work.", "send": True, "icon": "checklist"},
    {"id": "running", "title": "What is running right now?",
     "description": "Shows every session on your Macs: what it is doing, and which ones wait for you.",
     "prompt": "What is running right now?", "send": True, "icon": "pulse"},
    {"id": "connect", "title": "Connect two sessions",
     "description": "Passes a message from one running session to another, so you do not copy and paste between them.",
     "prompt": "Pass a message from one of my sessions to another: [which sessions and what to say]", "placeholder": "[which sessions and what to say]",
     "send": False, "icon": "arrow-swap"},
]


def home():
    return os.path.expanduser("~")


def folder():
    """<Dispatch's data folder>/assistant: ~/.dispatch/assistant, or DISPATCH_HOME's (dispatch_dir.root())."""
    import dispatch_dir
    return dispatch_dir.path("assistant")


# sha256 of earlier default ASSISTANT.md texts: a file still holding one of them was never edited by
# the person, so it is brought up to the current default (2026-09-30: the Assistant became the dispatcher)
OLD_DEFAULTS = {"713330acab39236645520ac6d37c8d585372de317fe3827480492364ef231fe5",
                "8461a2a738c4eb42e91e091223bd919b1f336407e52eb158dc766e048c180fa8",  # 2026-10-01: every request on the board
                "2f55d4214614e70a4ca7216bd87e4a678e739693c9234157e32ce86337378b2c",
                "b6d5f3875cf9002efa010bea48ce8e3c7b4721a8bb1806b46d5ef6168f3267aa",  # 2026-10-01: before sessions across Macs and the project survey
                "6096d95900c2d9c52f91a7a6f08de4ff0ede42af94bb40f815e782fdbc4cb4e7",  # 2026-10-01: survey findings went on the board in progress
                "9c68640c8e52a3eeb749c9c5fbb8c715accf95b81debc9c912470b3e2b24dfe3",  # 2026-10-06: before Dispatch noted new work from the chat by itself
                "9c1a128e083f74d454551984687e0ec34694cc37dbfbad31556b83a7f62ca6a1"}  # 2026-10-06: the Assistant added what Dispatch had noted again (task-b83p)


def _is_old_default(md):
    import hashlib
    try:
        return hashlib.sha256(open(md, encoding="utf-8").read().encode()).hexdigest() in OLD_DEFAULTS
    except OSError:
        return False


def ensure(path=None):
    """The folder, ASSISTANT.md (default text when missing or still an earlier default, never over a
    text the person edited) and the CLAUDE.md /
    AGENTS.md links to it. Returns {folder, instructions, created: [names]}."""
    path = path or folder()
    created = []
    if not os.path.isdir(path):
        os.makedirs(path, exist_ok=True)
        created.append("folder")
    md = os.path.join(path, "ASSISTANT.md")
    if not os.path.exists(md) or _is_old_default(md):
        with open(md, "w", encoding="utf-8") as fh:
            fh.write(INSTRUCTIONS)
        created.append("ASSISTANT.md")
    for name in ("CLAUDE.md", "AGENTS.md"):
        p = os.path.join(path, name)
        if not os.path.lexists(p):
            os.symlink("ASSISTANT.md", p)
            created.append(name)
    return {"folder": path, "instructions": md, "created": created}


def plain(md):
    """Markdown to one plain line for a hover card: links keep their text, no backticks, emphasis or heading marks."""
    md = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", md)
    md = re.sub(r"`+", "", md)
    md = re.sub(r"(?<![\w*])(\*\*|__|\*|_)(?=\S)(.+?)(?<=\S)\1(?![\w*])", r"\2", md)
    md = re.sub(r"(?m)^\s{0,3}(#{1,6}\s+|[-*+]\s+|>\s?|\d+\.\s+)", "", md)
    return md


def last_line(path, agent):
    """The last thing the assistant said in that transcript, one line, at most 200 characters."""
    import engines
    eng = engines.get(agent)
    if not eng.supports("record_steps"):
        return ""
    try:
        with open(path, "rb") as fh:
            fh.seek(max(0, os.path.getsize(path) - 400_000))
            tail = fh.read().decode("utf-8", "replace")
    except OSError:
        return ""
    for line in reversed(tail.splitlines()):
        if not line.startswith("{"):
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        txt = "\n".join(step[1] for step in eng.record_steps(d) if step[0] == "text")
        txt = " ".join(plain(txt).split())
        if txt:
            return txt[:197] + "..." if len(txt) > 200 else txt
    return ""


def transcripts(path):
    """[(mtime, agent, session_id, file)] of the engines' own history for that folder (their adapters' folder_transcripts)."""
    import engines
    return sorted(((mtime, eng.agent, sid, f) for eng in engines.known() for mtime, sid, f in eng.folder_transcripts(home(), path)),
                  reverse=True)


def from_catalog(path):
    """The newest Agents-window session working in that folder, not archived (ide_sessions)."""
    try:
        S = D._mod("ide_sessions") if D else __import__("ide_sessions")
        rows = S.scan(include_all=True)
    except Exception:
        return None
    rows = [r for r in rows if (r.get("cwd") or "").rstrip("/") == path.rstrip("/") and not r.get("archived")]
    return max(rows, key=lambda r: r.get("last_at") or 0) if rows else None


def session_of(path, now=None, catalog=True):
    """The Assistant's newest session. `catalog=False` leaves out the Agents window's catalog (every editor's database
    and a socket to each running one: about half of the run, and the part a busy Mac makes slow): its answer is from the
    engines' own history only, a session's state is then guessed from how recently it was written."""
    now = now or time.time()
    row = from_catalog(path) if catalog else None
    files = transcripts(path)
    if row:
        f = next((x for x in files if x[2] == row["session_id"]), None)
        status = "working" if row.get("state") == "working" else "waiting" if row.get("attention") == "input" else "idle"
        return {
            "id": row["session_id"], "agent": row.get("agent") or "", "resource": row.get("ide_key") or "",
            "title": row.get("title") or "", "status": status,
            "last": last_line(f[3], f[1]) if f else "", "last_at": row.get("last_at") or (f[0] if f else 0),
        }
    if not files:
        return None
    mtime, agent, sid, f = files[0]
    import engines
    return {
        "id": sid, "agent": agent, "resource": engines.provider_of(agent) + ":/" + sid,
        "title": "", "status": "working" if now - mtime < RUNNING_S else "idle",
        "last": last_line(f, agent), "last_at": mtime,
    }


def welcome(session):
    """First run: the Assistant has never been talked to, so its first page offers the suggestions."""
    return {"fresh": session is None, "suggestions": SUGGESTIONS}


def _live():
    import assistant_live as L
    L.D = D
    return L


def _survey():
    import assistant_survey as S
    S.D = D
    return S


def _words(a):
    """The message of `send`: the words after the key, or stdin with `-`."""
    rest = list(getattr(a, "args", None) or [])
    if rest == ["-"]:
        return sys.stdin.read()
    return " ".join(rest)


def _proxy(a):
    """`--host <Mac>`: run the same op over there (stdin, stdout and the exit code pass through)."""
    argv = ["assistant", a.op] + list(a.args or [])
    for flag, val in (("--wait", a.wait), ("-n", a.n), ("--project", a.project)):
        if val:
            argv += [flag, str(val)]
    if a.json:
        argv.append("--json")
    D.proxy_to_host(["--host", a.host] + argv)
    return 0


def command(a, dispatch_module=None):
    global D
    if dispatch_module is not None:
        D = dispatch_module
    op = getattr(a, "op", "") or "status"
    host = getattr(a, "host", "") or ""
    if host and host != "local" and op in ("turns", "send"):
        return _proxy(a)
    if op == "overview":
        L = _live()
        res = L.overview(local_only=a.local)
        res["fresh"] = session_of(ensure()["folder"]) is None
        return D.out(res, a.json, lambda r: _overview_text(r)) or 0
    if op == "turns":
        if not a.args:
            raise SystemExit("dispatch assistant turns <session key> [-n 6] [--host <Mac>]")
        try:
            res = _live().turns(a.args[0], a.n or 6)
        except ValueError as e:
            raise SystemExit(str(e))
        return D.out(res, a.json, lambda r: _turns_text(r)) or 0
    if op == "send":
        if len(a.args) < 2:
            raise SystemExit('dispatch assistant send <session key> "<message>" [--wait 120] [--host <Mac>]   (message "-" reads stdin)')
        key, a.args = a.args[0], a.args[1:]
        try:
            res = _live().send(key, _words(a), a.wait or 0)
        except ValueError as e:
            raise SystemExit(str(e))
        D.out(res, a.json, lambda r: print((("Sent. " + r.get("note", "")).strip() if r["ok"] else "Not sent: " + r.get("note", "")) + (("\n" + r["reply"]) if r.get("reply") else "")))
        return 0 if res["ok"] else 1
    if op == "home":
        import assistant_home as H
        H.D = D
        res = H.home()
        return D.out(res, a.json, lambda r: print("\n".join(f"{name}: {r[name]['count']}" + "".join(f"\n  {i['title']}  ({i['sub']})" for i in r[name]["items"]) for name in ("waiting", "working", "delivered")))) or 0
    if op == "similar":
        if not a.args:
            raise SystemExit('dispatch assistant similar "<task title>" [--project <name>]')
        res = _survey().similar(" ".join(a.args), a.project or "")
        return D.out(res, a.json, lambda r: print("\n".join(f"{m['id']}  {m['status']:<12} {m['title']}" for m in r["matches"]) or "Nothing like it is open.")) or 0
    if op == "add":
        if not a.args:
            raise SystemExit('dispatch assistant add "<task title>" --project <name> [--desc "..."] [--thing "..."] [--force]')
        try:
            res = _survey().add(" ".join(a.args), a.project or "", getattr(a, "desc", "") or "", getattr(a, "thing", "") or "", bool(getattr(a, "force", False)))
        except ValueError as e:
            raise SystemExit(str(e))
        return D.out(res, a.json, lambda r: print(f"To do: {r['title']} ({r['id']})" if r["added"] else r["note"])) or 0
    if op == "look":
        if not a.args:
            raise SystemExit("dispatch assistant look <folder>")
        res = _survey().look(a.args[0])
        return D.out(res, a.json, _look_text) or 0
    if op == "survey":
        res = _survey().survey(project=a.project or "", local_only=a.local)
        return D.out(res, a.json, lambda r: _survey_text(r)) or 0
    res = ensure()
    res["session"] = session_of(res["folder"], catalog=not getattr(a, "quick", False))
    res.update(welcome(res["session"]))

    def text(r):
        print(f"folder: {r['folder']}")
        s = r["session"]
        if not s:
            print("no Assistant session yet: open Assistant in the Agents window")
        else:
            print(f"{s['agent']} {s['id']} · {s['status']}" + (f" · {s['title']}" if s["title"] else ""))
            if s["last"]:
                print(f"last: {s['last']}")
    D.out(res, a.json, text)
    return 0


def _ago(t, now=None):
    d = max(0, int((now or time.time()) - (t or 0)))
    return "just now" if d < 60 else f"{d // 60} min ago" if d < 3600 else f"{d // 3600} h ago" if d < 86400 else f"{d // 86400} d ago"


def _overview_text(r):
    for m in r["machines"]:
        c = m["counts"]
        print(f"{m['name']}{'' if m['online'] else ' (offline)'}: {c['working']} working, {c['waiting']} waiting for you, {c['idle']} idle")
        for s in m["sessions"]:
            print(f"  {s['agent_name']:<12} {s['project']:<18} {s['status_label']:<16} {s['doing'] or s['title']}  [{s['key']}]" + (f"  task: {s['task']['title']}" if s.get("task") else ""))
    for e in r["feed"][:6]:
        print(f"  {e['kind']:<9} {_ago(e['at'])}  {e['project']}: {e['text']}")


def _look_text(r):
    print(r["summary"])
    if not r.get("exists"):
        return
    if r.get("files"):
        print("Files: " + ", ".join(r["files"]) + (f" and {r['more_files']} more" if r.get("more_files") else ""))
    if r.get("readme"):
        print("README: " + r["readme"])
    if r.get("note"):
        for l in r["note"]["lines"]:
            print(f"  - {l}")
    if r.get("ask"):
        print("Not a project. It stays that way; ask the person only if they want work done there.")


def _turns_text(r):
    s = r["session"]
    print(f"{s['agent_name']} · {s['project']} · {s['title']}")
    for t in r["turns"]:
        who = "Assistant" if t["from_assistant"] else ("You" if t["role"] == "user" else s["agent_name"])
        print(f"[{who}] {t['text']}")


def _survey_text(r):
    print(r["summary"])
    for m in r["machines"]:
        for p in m["projects"]:
            if p["unfinished"]:
                print(f"{p['label']} ({m['name']}):")
                for l in p["lines"]:
                    print(f"  - {l}")
