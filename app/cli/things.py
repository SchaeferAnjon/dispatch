# -*- coding: utf-8 -*-
"""Things: what a task is about, and where it came from (the Task graph, design/task-graph/redesign/).

A *thing* is one piece of work the person keeps coming back to: "多机器和迁移", "the Projects page".
Its tasks are one row of the task graph, in the order they were asked. Two keys in a task's bd
metadata, next to plan, deliverables and follows:

    thing   the thing's name: short (about 12 characters), in the person's own words
    from    the task its session was on when this one was asked; the graph draws from it where a new
            thing branched off, and where an old one was picked up again

`dispatch begin --thing "<name>"` writes both; without --thing a task goes with the thing of the task
before it in its session. Tasks from before these keys get theirs once with
`dispatch task things migrate` (title rules from a JSON file, else that same session rule).

What the graph gets (tasks_view.build_graph):

    things  [{id, name, first_at, last_at, state, now_task, counts, n, parent, quiet}] in drawing
            order: a thing that branched off another comes right under it
    nodes   one per task, each with thing {id, name} and from {id, source} (or null)
    links   [{from, to, kind, gap_days, source}]: branch (the first task of a new thing, asked while its
            session was on another thing), merge (back to a thing a day or more after its last task,
            from another one), hop (a session going between two things within the day; only the session
            view draws those)

source: explicit when an agent wrote it down (`from` from `dispatch begin`, or the task carries on
another by `dispatch task follow`), inferred when it is only the order of the session's tasks (every
task from before these keys); the graph draws inferred lines lighter.
"""
import hashlib, json, re

DAY = 86400
QUIET_DAYS = 7         # a thing with nothing asked in this long folds away ("No activity in 7 days")
NAME_MAX = 40          # a stored name is cut here; the Agent is asked for about 12 characters
SHORT = 12             # a name made from a title
WORDS_SHORT = 20       # … from a title in words (English): whole words
_WIDE = re.compile(r"[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]")  # CJK: characters, not words
RANK = {"done": 0, "todo": 1, "in_progress": 2, "waiting": 3}
STATUSES = ("done", "in_progress", "waiting", "todo")
TASK_ID = re.compile(r"^[a-z][a-z0-9]*-[a-z0-9]{2,8}$")
THING_ID = re.compile(r"^th-[0-9a-f]{6}$")
_ID_IN_TITLE = re.compile(r"\s*[（(]\s*task-[a-z0-9]{2,8}\s*[）)]")
_BREAKS = "，。；：、,;:（(「【 -"


def clean_name(name):
    """A thing's name as it is stored: one line, at most NAME_MAX characters."""
    return " ".join(str(name or "").split())[:NAME_MAX].strip()


def thing_id(name):
    """A thing's id: stable for its name (case and spacing do not matter)."""
    return "th-" + hashlib.sha1(clean_name(name).lower().encode("utf-8")).hexdigest()[:6]


def short_name(title):
    """A thing's name from a task title, when nobody named it: the part before the first colon when
    that part is short, else the title's first whole words (English) or first dozen characters cut at
    punctuation (Chinese), with "…" when it is shorter than the title."""
    t = clean_name(_ID_IN_TITLE.sub("", title or ""))
    m = re.match(r"^(.{2,16}?)\s*[：:]", t)
    if m:
        return m.group(1).strip()
    if len(t) <= SHORT:
        return t or "Untitled"
    if not _WIDE.search(t):
        # words: whole words up to WORDS_SHORT characters, never a cut inside a word
        name = ""
        for word in t.split(" "):
            longer = f"{name} {word}".strip()
            if len(longer) > WORDS_SHORT:
                break
            name = longer
        name = (name or t[:WORDS_SHORT]).strip(_BREAKS)
    else:
        head = t[:SHORT]
        cut = max((i for i, ch in enumerate(head) if ch in _BREAKS and i >= SHORT // 2), default=SHORT)
        name = head[:cut].strip(_BREAKS) or head
    # a shortened title says so
    return name if name == t else name + "…"


def stored(m):
    """(thing, from) as a task's metadata has them; "" for what is missing or malformed."""
    frm = m.get("from") if isinstance(m.get("from"), str) and TASK_ID.match(m.get("from") or "") else ""
    return clean_name(m.get("thing") if isinstance(m.get("thing"), str) else ""), frm


def by_created(rows):
    return sorted(rows, key=lambda r: (r["created_at"], r["id"]))


def resolve(rows):
    """({task id: thing name}, {task id: from}, {task id: explicit | inferred}) for a project's task rows
    (tasks_view.task_row, which carries the stored `thing` and `from`). Stored values win. A task
    without a stored `from` came from the task before it in its session (inferred, unless the agent
    said which task it carries on). A task without a thing takes the thing of the task it follows,
    else of its `from`; one with neither starts a thing named after its title."""
    thing_of, from_of, source_of, last = {}, {}, {}, {}
    for r in by_created(rows):
        tid, sess = r["id"], r.get("session") or ""
        frm = r.get("from") or ""
        explicit = bool(frm and frm != tid) or bool(r.get("follows"))
        if not frm or frm == tid:
            frm = last.get(sess, "") if sess else ""
        from_of[tid] = frm
        source_of[tid] = "explicit" if explicit else "inferred"
        name = clean_name(r.get("thing"))
        if not name:
            for src in (r.get("follows"), frm):
                if src and src in thing_of:
                    name = thing_of[src]
                    break
        thing_of[tid] = name or short_name(r.get("title"))
        if sess:
            last[sess] = tid
    return thing_of, from_of, source_of


def links(rows, thing_of, from_of, source_of=None):
    """The places where a session went from one thing to another (see the module doc). `rows` are
    all of a project's tasks, so a thing's first task is its first ever, not the window's."""
    by_id = {r["id"]: r for r in rows}
    latest, out = {}, []
    for r in by_created(rows):
        tid = r["id"]
        th, frm = thing_of[tid], from_of.get(tid) or ""
        before = latest.get(th)
        if frm in by_id and thing_of.get(frm) != th:
            src = (source_of or {}).get(tid, "inferred")
            if before is None:
                out.append({"from": frm, "to": tid, "kind": "branch", "gap_days": 0, "source": src})
            else:
                gap = (r["created_at"] - before) / DAY
                out.append({"from": frm, "to": tid, "kind": "merge" if gap >= 1 else "hop", "gap_days": int(round(gap)), "source": src})
        latest[th] = max(before or 0, r["created_at"])
    return out


def plan_now(plan):
    """Where a task's plan stands: {n, text} of the step being done (else the next to do, else the
    last); None without a plan."""
    if not plan:
        return None
    i = next((k for k, p in enumerate(plan) if p.get("state") == "active"), None)
    if i is None:
        i = next((k for k, p in enumerate(plan) if p.get("state") == "todo"), len(plan) - 1)
    return {"n": i + 1, "text": plan[i].get("text") or ""}


def state_of(statuses):
    """Where a thing stands: waiting for you, else in progress, else to do, else done."""
    return max(statuses, key=RANK.get) if statuses else "done"


def now_task(tasks):
    """The task a thing's row names on the right: the newest one in the thing's state (the last
    one when everything is done). `tasks` are in the order they were asked."""
    st = state_of([t["status"] for t in tasks])
    pick = tasks[-1] if st == "done" else [t for t in tasks if t["status"] == st][-1]
    return {"id": pick["id"], "title": pick["title"], "status": pick["status"]}


def summarize(rows, thing_of, all_links, now, mine=None):
    """The things of the rows the graph draws, in drawing order: things with no parent by their first
    task, each followed by the things that branched off it (depth first). `mine`: the task ids of the
    session the graph is for (each thing then counts its own)."""
    groups = {}
    for r in by_created(rows):
        groups.setdefault(thing_of[r["id"]], []).append(r)
    parent = {}
    for l in all_links:
        if l["kind"] == "branch":
            parent.setdefault(thing_of[l["to"]], thing_of[l["from"]])
    things = {}
    for name, ts in groups.items():
        counts = {k: 0 for k in STATUSES}
        for t in ts:
            counts[t["status"]] += 1
        # quiet = nothing asked in 7 days: the row's dots are when tasks were asked, so a row outside the
        # fold always has a dot in the last week (closing an old task does not bring its row back)
        last = ts[-1]["created_at"]
        p = parent.get(name)
        th = {"id": thing_id(name), "name": name, "first_at": ts[0]["created_at"], "last_at": last,
              "state": state_of([t["status"] for t in ts]), "now_task": now_task(ts), "counts": counts, "n": len(ts),
              "parent": thing_id(p) if p and p in groups and p != name else None,
              "quiet": last < now - QUIET_DAYS * DAY}
        if mine is not None:
            th["mine"] = sum(1 for t in ts if t["id"] in mine)
        things[name] = th
    kids, roots = {}, []
    for name, th in sorted(things.items(), key=lambda kv: (kv[1]["first_at"], kv[0])):
        p = parent.get(name)
        (kids.setdefault(p, []) if th["parent"] else roots).append(name)
    out, seen = [], set()

    def walk(names):
        for n in names:
            if n in seen:
                continue
            seen.add(n)
            out.append(things[n])
            walk(kids.get(n, []))
    walk(roots)
    walk([n for n in sorted(things, key=lambda n: things[n]["first_at"]) if n not in seen])  # a cycle of parents: still drawn
    return out


# ---------------------------------------------------------------- migrating old tasks

def load_rules(path):
    """Title rules for `things migrate`: JSON {"rules": [[name, regex], ...], "override": {task id: name}}
    (or just the list). Rules match the title in order, first match wins; a last rule of "." catches
    the rest."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        data = {"rules": data}
    rules = []
    for it in data.get("rules") or []:
        if isinstance(it, (list, tuple)) and len(it) == 2 and clean_name(it[0]):
            rules.append((clean_name(it[0]), re.compile(str(it[1]))))
    over = {k: clean_name(v) for k, v in (data.get("override") or {}).items() if TASK_ID.match(k) and clean_name(v)}
    if not rules and not over:
        raise ValueError(f"no rules in {path}: want {{\"rules\": [[name, regex], …], \"override\": {{task: name}}}}")
    return {"rules": rules, "override": over}


def by_rules(rules, row):
    if row["id"] in rules["override"]:
        return rules["override"][row["id"]]
    for name, rx in rules["rules"]:
        if rx.search(row.get("title") or ""):
            return name
    return ""


def plan_migration(rows, rules=None):
    """{task id: thing name} for the rows that have no stored thing yet: by the rules when given,
    else (and for what no rule catches) by the session rule of resolve()."""
    thing_of = resolve(rows)[0]
    out = {}
    for r in by_created(rows):
        if r.get("thing"):
            continue
        out[r["id"]] = (by_rules(rules, r) if rules else "") or thing_of[r["id"]]
    return out


def migration_summary(rows, names):
    by = {}
    title = {r["id"]: r["title"] for r in rows}
    for tid, name in names.items():
        by.setdefault(name, []).append(tid)
    return [{"id": thing_id(n), "name": n, "n": len(ids), "titles": [title[i] for i in ids[-3:]]}
            for n, ids in sorted(by.items(), key=lambda kv: (-len(kv[1]), kv[0]))]


def bumped(ts):
    """An ISO time from bd, one second later: the import rewrites a row only when it is newer, and
    one second keeps the task where it was in time (a task touched by the migration is not "recent")."""
    from datetime import datetime, timedelta, timezone
    try:
        t = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return ts
    t = (t + timedelta(seconds=1)).astimezone(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S") + (".%06dZ" % t.microsecond if t.microsecond else "Z")


def import_rows(issues, names, meta_of):
    """JSONL for `bd import`: each issue as exported, its metadata with the thing, updated_at a second
    later. A task changed after the export (a newer updated_at on the board) is skipped by bd."""
    lines = []
    for t in issues:
        name = names.get(t.get("id"))
        if not name:
            continue
        m = dict(meta_of(t))
        m["thing"] = name
        row = {k: v for k, v in t.items() if k != "_type"}
        row.update(_type="issue", metadata=m, updated_at=bumped(t.get("updated_at")))
        lines.append(json.dumps(row, ensure_ascii=False))
    return "\n".join(lines) + ("\n" if lines else "")
