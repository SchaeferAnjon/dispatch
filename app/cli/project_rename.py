# -*- coding: utf-8 -*-
"""A project's real rename: its name itself (the key Dispatch files things under), not only what the window shows.

`dispatch projects-view rename <old> --name=<new> --key [--dry-run] --json` (kanban task-ysxde). `rename` without
`--key` stays what it was: the label the window shows (projects_view.rename). With `--key` everything this Mac keeps
under the old name moves to the new one:

  flags      the registry entry (folder, star, archive, test command; dispatch-projects), first, so a run that
             stops half way is picked up by the next one (old gone and new there: it carries on)
  owners     which Mac it lives on (dispatch-project-owners)
  custom     its look and copies (dispatch-project-custom)
  docs       its documents (dispatch-docs-<name>), merged into the new name's when there is one
  summary    its page summary (dispatch-project-summary-<name>)
  tasks      every task labelled project:<old> (done and in the bin too), relabelled in batches of BATCH
  wiki       knowledge entries tagged #project:<old>
  prefs      preferences scoped <old> or <old>:<surface>
  capture    "From chat" receipts naming it (a task made from one later takes that name)
  env        keys tied to it (`# project: <old>` in the key store), through env_read / env_write

Left as they are: notes of what happened (handoffs, history, session briefs), FACTS.md sections, the old app's
per-session project override, Turbo runs (they name the folder) and the window's own remembered sections.

Each Mac has its own board: run it on every Mac that has the project. It can be run again: what moved is not
found under the old name any more. `--dry-run` counts what would move and writes nothing. A failed write stops
there and says which step and how far it got; running it again continues.
"""
import json
import os
import re
import sys

D = None
BATCH = 50
STEPS = ("flags", "owners", "custom", "docs", "summary", "tasks", "wiki", "prefs", "capture", "env")


class Stopped(ValueError):
    pass


def _dispatch():
    global D
    if D is None:
        here = os.path.dirname(os.path.abspath(__file__))
        if here not in sys.path:
            sys.path.insert(0, here)
        import dispatch as mod  # noqa: E402
        D = mod
    return D


def _memories():
    code, o, err = D.sh(["bd", "memories", "--json"])
    if code != 0:
        raise Stopped((err or o or "").strip() or "Dispatch could not read the task board. Nothing was changed.")
    try:
        d = json.loads(o[o.find("{"):])
    except ValueError:
        raise Stopped("Dispatch could not read the task board. Nothing was changed.")
    return d if isinstance(d, dict) else {}


def _json_map(raw):
    try:
        d = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    return d if isinstance(d, dict) else {}


def _same(a, b):
    return (a or "").casefold() == (b or "").casefold()


def _key_in(d, name):
    return next((k for k in d if _same(k, name)), None)


def _tasks():
    T = D._mod("tasks_view")
    T.D = D
    return T.board_export()


def _project_labels(issue, name):
    return [l for l in issue.get("labels") or [] if l.lower().startswith("project:") and _same(l.split(":", 1)[1], name)]


_WIKI_TAG = r"#project:{}(?=\s|$)"


def _wiki_hits(old):
    if not D.wiki_files_on():
        return []
    pat = re.compile(_WIKI_TAG.format(re.escape(old)), re.IGNORECASE)
    out = []
    for f in sorted(os.listdir(D.wiki_dir())):
        p = os.path.join(D.wiki_dir(), f)
        if f.endswith(".md") and os.path.isfile(p):
            with open(p, encoding="utf-8") as fh:
                if pat.search(fh.read()):
                    out.append(p)
    return out


def _scope_moved(scope, old, new):
    p, sep, surface = (scope or "").partition(":")
    return f"{new}{sep}{surface}" if _same(p, old) else None


def _jsonl(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().splitlines()
    except FileNotFoundError:
        return []


def _write_lines(path, lines):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("".join(line + "\n" for line in lines))
    os.replace(tmp, path)


def _prefs_lines(old, new):
    path = D._mod("prefs").store_path()
    lines, hits = _jsonl(path), 0
    out = []
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            out.append(line)
            continue
        moved = _scope_moved(e.get("scope"), old, new) if isinstance(e, dict) else None
        if moved is not None:
            e["scope"] = moved
            hits += 1
            line = json.dumps(e, ensure_ascii=False)
        out.append(line)
    return path, out, hits


def _capture_lines(old, new):
    C = D._mod("capture")
    path = C._path("receipts.jsonl")
    out, hits = [], 0
    for line in _jsonl(path):
        try:
            r = json.loads(line)
        except ValueError:
            out.append(line)
            continue
        changed = False
        if isinstance(r, dict):
            if _same(r.get("project"), old):
                r["project"], changed = new, True
            for it in r.get("items") or []:
                if isinstance(it, dict) and _same(it.get("project"), old):
                    it["project"], changed = new, True
        if changed:
            hits += 1
            line = json.dumps(r, ensure_ascii=False)
        out.append(line)
    return path, out, hits


def survey(old, new):
    """What moves: {step: count}, the old and new keys as written, and whether the new name is someone else's."""
    _dispatch()
    mem = _memories()
    flags = D.project_flags_parse(mem.get(D.PROJECT_FLAGS_KEY, ""))
    old_key, new_key = _key_in(flags, old), _key_in(flags, new)
    issues = _tasks()
    old_tasks = [t for t in issues if _project_labels(t, old)]
    new_tasks = [t for t in issues if _project_labels(t, new)]
    if old_key is None and new_key is None and not old_tasks:
        raise ValueError(f"No project called {old}.")
    if old_key is not None and (new_key is not None or new_tasks) and not _same(old, new):
        raise ValueError(f"There is already a project called {new}. Pick another name.")
    owners = _json_map(mem.get(D.PROJECT_OWNERS_KEY, ""))
    custom = _json_map(mem.get(D._mod("project_custom").CUSTOM_KEY, ""))
    docs = [k for k in mem if k.startswith(D.DOCS_KEY_PREFIX) and _same(k[len(D.DOCS_KEY_PREFIX):], old)]
    summary_prefix = D.INTERNAL_MEMORY_PREFIX + "project-summary-"
    summaries = [k for k in mem if k.startswith(summary_prefix) and _same(k[len(summary_prefix):], old)]
    counts = {
        "flags": int(old_key is not None),
        "owners": int(_key_in(owners, old) is not None),
        "custom": int(_key_in(custom, old) is not None),
        "docs": sum(len(D.docs_entries_parse(mem.get(k, ""))) for k in docs),
        "summary": len(summaries),
        "tasks": len(old_tasks),
        "wiki": len(_wiki_hits(old)),
        "prefs": _prefs_lines(old, new)[2],
        "capture": _capture_lines(old, new)[2],
        "env": sum(1 for it in D.env_read() if _same(it.get("project"), old)),
    }
    return {"old_key": old_key, "new_name": new, "counts": counts, "mem": mem, "flags": flags,
            "owners": owners, "custom": custom, "docs": docs, "summaries": summaries, "tasks": old_tasks}


def rename_key(old, new, dry_run=False):
    """Move everything filed under `old` to `new` on this Mac (see the top of this file)."""
    _dispatch()
    old = " ".join((old or "").split())
    new = " ".join((new or "").split())
    if not new or len(new) > 80 or any(ord(c) < 32 for c in new) or new.startswith("-") or "#" in new:
        raise ValueError("That is not a usable project name.")
    if old == new:
        raise ValueError(f"{old} is called that already.")
    s = survey(old, new)
    counts = s["counts"]
    answer = {"ok": True, "from": s["old_key"] or old, "name": new, "dry_run": bool(dry_run), "counts": counts}
    if dry_run:
        return answer
    done = []
    step = ""
    try:
        step = "flags"
        if s["old_key"] is not None:
            flags = dict(s["flags"])
            entry = dict(flags.pop(s["old_key"]) or {})
            if _same(entry.get("alias"), new):
                entry.pop("alias")
            flags[new] = entry
            D.wiki_store(D.PROJECT_FLAGS_KEY, json.dumps(flags, ensure_ascii=False, sort_keys=True))
        done.append(step)
        step = "owners"
        k = _key_in(s["owners"], old)
        if k is not None:
            owners = dict(s["owners"])
            owners[new] = owners.pop(k)
            D.wiki_store(D.PROJECT_OWNERS_KEY, json.dumps(owners, ensure_ascii=False, sort_keys=True))
        done.append(step)
        step = "custom"
        k = _key_in(s["custom"], old)
        if k is not None:
            custom = dict(s["custom"])
            custom[new] = custom.pop(k)
            D._mod("project_custom").save(custom)
        done.append(step)
        step = "docs"
        if s["docs"]:
            have = D.docs_entries_parse(s["mem"].get(D.docs_key(new), ""))
            seen = {e.get("id") for e in have}
            for key in s["docs"]:
                have += [e for e in D.docs_entries_parse(s["mem"].get(key, "")) if e.get("id") not in seen]
                seen |= {e.get("id") for e in have}
            D.docs_save(new, have)
            for key in s["docs"]:
                if key != D.docs_key(new):
                    _forget(key)
        done.append(step)
        step = "summary"
        for key in s["summaries"]:
            target = D.INTERNAL_MEMORY_PREFIX + "project-summary-" + new
            if key != target:
                D.wiki_store(target, s["mem"][key])
                _forget(key)
        done.append(step)
        step = "tasks"
        by_label = {}
        for t in s["tasks"]:
            for label in _project_labels(t, old):
                by_label.setdefault(label, []).append(t["id"])
        moved = 0
        for label, ids in sorted(by_label.items()):
            for i in range(0, len(ids), BATCH):
                part = ids[i:i + BATCH]
                code, o, err = D.sh(["bd", "update", *part, "--remove-label", label, "--add-label", f"project:{new}", "--json"], timeout=120)
                if code != 0:
                    raise Stopped(f"{moved} of {counts['tasks']} tasks moved; bd said: {(err or o or '').strip()[:300]}")
                moved += len(part)
        done.append(step)
        step = "wiki"
        pat = re.compile(_WIKI_TAG.format(re.escape(old)), re.IGNORECASE)
        for p in _wiki_hits(old):
            with open(p, encoding="utf-8") as fh:
                text = fh.read()
            tmp = f"{p}.{os.getpid()}.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(pat.sub(f"#project:{new}", text))
            os.replace(tmp, p)
        done.append(step)
        step = "prefs"
        path, lines, hits = _prefs_lines(old, new)
        if hits:
            _write_lines(path, lines)
        done.append(step)
        step = "capture"
        path, lines, hits = _capture_lines(old, new)
        if hits:
            _write_lines(path, lines)
        done.append(step)
        step = "env"
        items = D.env_read()
        if any(_same(it.get("project"), old) for it in items):
            D.env_write([dict(it, project=new) if _same(it.get("project"), old) else it for it in items])
        done.append(step)
    except (Stopped, SystemExit, OSError) as e:
        why = str(e) if isinstance(e, (Stopped, OSError)) else "bd could not save a change."
        err = Stopped(f"Renaming {old} to {new} stopped at {step} ({why}). Done before it: {', '.join(done) or 'nothing'}. "
                      f"Run the same rename again to carry on.")
        raise err from e
    D.project_dirs(reload=True)
    answer["done"] = done
    return answer


def _forget(key):
    code, o, err = D.sh(["bd", "forget", key])
    if code != 0:
        raise Stopped(f"bd could not drop {key}: {(err or o or '').strip()[:200]}")
