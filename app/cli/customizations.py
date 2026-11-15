# -*- coding: utf-8 -*-
"""Dispatch's inventory in the existing Customizations pages.

Only commands with Dispatch's ownership marker can be toggled. Undo operates on
known sources, checks current content, and preserves unrelated settings and files.
No engine is started by an inventory read.
"""
import contextlib
import copy
import datetime
import fcntl
import hashlib
import importlib.util
import json
import io
import os
from pathlib import Path
import re
import shutil
import tempfile

import dispatch as D
import dispatch_dir as DD
import engines as E

GROUPS = {
    "prime": ("Session brief", "SessionStart", "New sessions will not receive tasks, preferences or nearby sessions."),
    "presence": ("Session activity", "Session activity events", "Session status and the last active time will no longer stay up to date."),
    "plan": ("Task plans", "PostToolUse", "The agent's plan will no longer appear on its task automatically."),
    "edit-guard": ("File ownership", "PreToolUse / PostToolUse", "Agents will no longer be warned when another session owns a file."),
}
BUILTINS = ("task-board", "delivery-page", "built-in-browser", "computer-use", "designer", "teaching-master", "animation-director", "leader", "neat-freak")
BUILTIN_DESCRIPTIONS = {"task-board": "Track tasks, shared knowledge and agent work with Dispatch.",
                        "delivery-page": "Deliver changes with screenshots, explanations and evidence.",
                        "built-in-browser": "Open, read, click and fill pages in Dispatch's browser, with the sign-ins you pick.",
                        "computer-use": "Use another app on this Mac after you allow it, with a Stop button on screen.",
                        "designer": "Judge and plan how a screen looks against the project's DESIGN.md; the designer agent's method.",
                        "teaching-master": "Review and plan how a lesson teaches against the project's TEACHING.md; the teaching-master agent's method.",
                        "animation-director": "Design, review and export teaching animations and explainer clips; the animation-director agent's method.",
                        "leader": "Turn a one-line idea into a task an agent can finish on its own: brief, plan, checks, on the board.",
                        "neat-freak": "Check docs, rules, memory and Dispatch's knowledge against the code; changes only what you pick."}


def home():
    # A disposable IDE instance must never edit the person's engine settings. An instance that already
    # runs on its own fixture HOME (inside the instance folder) edits that one: it is what the first-run
    # setup installed into, so setup and Customizations see the same hooks and skills.
    root = os.environ.get("DISPATCH_SESSION_ROOT")
    if not root:
        return Path(D.HOME)
    real_home = os.path.realpath(D.HOME)
    for r in filter(None, root.split(os.pathsep)):
        r = os.path.realpath(r)
        if real_home == r or real_home.startswith(r.rstrip(os.sep) + os.sep):
            return Path(D.HOME)
    return Path(root.split(os.pathsep)[0], "customizations-home")


def scoped(path):
    p = Path(path)
    try:
        return home() / p.relative_to(D.HOME)
    except ValueError:
        return p


def state_path():
    return Path(DD.path("state", "customizations.json"))


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return copy.deepcopy(default)


def write_bytes(path, content, expected=None):
    """Preserve a configured symlink, mode and concurrent edits."""
    p = Path(path).resolve()
    old = p.read_bytes() if p.exists() else b""
    if expected is not None and old != expected:
        raise ValueError("This file changed while it was being updated. Refresh and try again.")
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".dispatch-customizations-", dir=p.parent)
    try:
        os.fchmod(fd, p.stat().st_mode & 0o777 if p.exists() else 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(content)
        if expected is not None and (p.read_bytes() if p.exists() else b"") != expected:
            raise ValueError("This file changed while it was being updated. Refresh and try again.")
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def write_json(path, value, expected=None):
    write_bytes(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode(), expected)


@contextlib.contextmanager
def locked():
    p = state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(str(p) + ".lock", "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield


def hook_paths():
    """The JSON hook files of the engines Dispatch writes its hook entry into, by engine id."""
    import engines as E
    return {e.id: Path(e.hooks_file(str(home()))) for e in E.runnable() if e.hooks_json}


def plugin_hook_paths():
    """The engines whose Dispatch entry is a plugin they load (OpenCode), its file by engine id. The plugin asks the same
    entry (hook.py) for the same features under the same switches, so Hooks lists it next to the JSON ones (task-lj06.32)."""
    import engines as E
    return {e.id: Path(e.hooks_file(str(home()))) for e in E.runnable() if e.hooks_plugin}


def hook_document(path):
    data = read_json(path, {})
    if not isinstance(data, dict) or not isinstance(data.get("hooks", {}), dict):
        raise ValueError(f"Invalid hook settings in {path}; the file was left unchanged.")
    for groups in data.get("hooks", {}).values():
        if not isinstance(groups, list) or any(not isinstance(g, dict) or not isinstance(g.get("hooks", []), list) for g in groups):
            raise ValueError(f"Invalid hook settings in {path}; the file was left unchanged.")
    return data


def _feature_events(eng, group):
    """The events on which Dispatch's entry runs `group` for this engine; [] where it has no such feature."""
    if group == "edit-guard" and not eng.edit_tools or group == "plan" and not eng.plan_tools:
        return []
    return sorted(e for e, feats in eng.hook_routes.items() if group in feats)


def hooks_list():
    """Each feature of Dispatch's hook entry per engine (hook.py; on/off is a switch of the entry, the engine's file
    is not edited), and how many hooks of their own each engine file has."""
    import engines as E
    import hook
    import hooks_setup
    groups = [{"id": key, "name": v[0], "event": v[1], "if_off": v[2], "agents": {}} for key, v in GROUPS.items()]
    others, errors = [], []
    for agent, path in hook_paths().items():
        eng = E.get(agent)
        try:
            data = hook_document(path)
        except (ValueError, OSError) as e:
            errors.append(str(e))
            data = {}
        installed = bool(data) and bool(hooks_setup.state(eng, str(path))["events"])
        on = hook.switches(eng.agent, DD.path("config.json"))
        for row in groups:
            events = _feature_events(eng, row["id"])
            enabled = installed and bool(events) and on[row["id"]]
            row["agents"][agent] = {"enabled": enabled, "available": installed and bool(events), "supported": bool(events),
                                     "count": len(events) if enabled else 0, "events": events if enabled else [], "path": str(path)}
        for event, wrappers in data.get("hooks", {}).items():
            count = sum(1 for g in wrappers for h in g.get("hooks", []) if not hooks_setup.kind(h.get("command") if isinstance(h, dict) else ""))
            if count:
                others.append({"agent": agent, "event": event, "count": count, "path": str(path)})
    for agent, path in plugin_hook_paths().items():
        eng = E.get(agent)
        try:
            installed = bool(eng.plugin_state().get("installed"))
        except Exception as e:  # noqa: BLE001 - one engine's plugin folder never takes the list down
            errors.append(f"Could not read {eng.name}'s Dispatch plugin: {e}"[:300])
            installed = False
        on = hook.switches(eng.agent, DD.path("config.json"))
        for row in groups:
            events = _feature_events(eng, row["id"])
            enabled = installed and bool(events) and on[row["id"]]
            row["agents"][agent] = {"enabled": enabled, "available": installed and bool(events), "supported": bool(events),
                                     "count": len(events) if enabled else 0, "events": events if enabled else [], "path": str(path)}
    return {"groups": groups, "others": others, "errors": errors}


def _hook_fingerprint(agent, group, enabled):
    return "hooks-" + fingerprint(agent, group, "on" if enabled else "off")


def toggle_hook(group, agent, enabled, expected_id=None):
    """Turn one feature of Dispatch's hook entry on or off for one engine. Turning one on where the entry is not
    there yet puts the entry in (and has Codex trust it)."""
    import engines as E
    import hooks_setup
    agents = {**hook_paths(), **plugin_hook_paths()}
    if group not in GROUPS or agent not in agents:
        raise ValueError("Choose a Dispatch hook group and " + E.join_words([E.get(a).name for a in agents], "or") + ".")
    eng = E.get(agent)
    if not _feature_events(eng, group):
        raise ValueError("Dispatch has no such hook for this engine.")
    with locked():
        current = next(r for r in hooks_list()["groups"] if r["id"] == group)["agents"][agent]
        if expected_id and expected_id != _hook_fingerprint(agent, group, current["enabled"]):
            raise ValueError("This hook changed after the import was displayed. Refresh the list.")
        if current["enabled"] == enabled:
            return {"ok": True, "unchanged": True}
        hooks_setup.switch(eng.agent, group, enabled)
        if enabled and not current["available"]:
            res = eng.install_hooks()
            if res.get("skipped"):
                raise ValueError(res["skipped"])
    return {"ok": True, "group": group, "agent": agent, "enabled": enabled}


def shipped_skill(name):
    cli = Path(__file__).resolve().parent
    return next((p for p in (cli.parent.parent / "agent/skills" / name, cli.parent / "agent/skills" / name) if (p / "SKILL.md").is_file()), None)


def is_builtin_skill(name, path):
    shipped = shipped_skill(name) if name in BUILTINS else None
    if not shipped:
        return False
    import init_wizard
    if init_wizard.builtin_skill_content(str(path), name):
        # By name and content: an earlier setup copied it into the pool instead of linking it.
        return True
    roots = [shipped.resolve()]
    # A source worktree may inspect skills installed by the CLI in the main
    # checkout. Identify that installation by the command's real target.
    command = Path(D.HOME) / ".local/bin/dispatch"
    if command.is_symlink():
        cli = command.resolve()
        if cli.name == "dispatch.py" and cli.parent.name == "cli":
            roots.extend([cli.parent.parent.parent / "agent/skills" / name, cli.parent.parent / "agent/skills" / name])
    return Path(path).resolve() in [p.resolve() for p in roots]


def skills_list():
    if home() == Path(D.HOME):
        rows = D.all_skills()
    else:
        pool = Path(DD.path("skills"))
        import engines as E
        skill_roots = E.skill_dirs(str(home()), env={})
        rows = []
        for p in sorted(pool.iterdir()) if pool.is_dir() else []:
            if (p / "SKILL.md").is_file():
                rows.append({"name": p.name, "path": str(p), "description": D.read_frontmatter(str(p)).get("description", ""),
                             "in_pool": True, "agents": {ag: any(os.path.isdir(os.path.join(d, p.name)) for d in dirs) for ag, dirs in skill_roots.items()}, "mounts": {}})
    for row in rows:
        row["builtin"] = is_builtin_skill(row["name"], row["path"])
        if row["builtin"]:
            row["description"] = BUILTIN_DESCRIPTIONS[row["name"]]
    for name in BUILTINS:
        if not any(r["builtin"] and r["name"] == name for r in rows):
            p = shipped_skill(name)
            if p:
                rows.append({"name": name, "path": str(p), "description": BUILTIN_DESCRIPTIONS[name],
                             "builtin": True, "in_pool": True, "agents": {}, "mounts": {}})
    return rows


def rules_status():
    source = scoped(D.RULES_FILE)
    text = source.read_text() if source.is_file() else ""
    dfile, dtext = D.dispatch_rules()
    digest = D.rules_hash(text, dtext)
    targets = []
    configured = D.rule_sync_targets()
    for target in configured:
        p = scoped(target["path"])
        if home() != Path(D.HOME) and not p.exists():
            continue
        if home() == Path(D.HOME) and not target["syncing"]:
            continue
        raw = p.read_text() if p.is_file() else ""
        match = re.search(re.escape(D.RULES_BEGIN) + r"[^\n]*hash:([a-f0-9]+)", raw)
        state = "synced" if match and match[1] == digest else "outdated" if match else "absent" if raw else "missing"
        targets.append({"agent": target["agent"], "path": str(p), "state": state, "mode": D.RULE_TARGETS[target["agent"]]["mode"]})
    return {"source": str(source), "exists": source.is_file(), "dispatch": dfile, "dispatch_installed": Path(dfile).is_file(),
            "hash": digest, "targets": targets}


def fingerprint(*values):
    return hashlib.sha256("\0".join(str(v) for v in values).encode()).hexdigest()[:20]


def setup_receipts():
    """The first-run group owns this receipt and its Undo implementation."""
    entries = read_json(Path(D.DISPATCH_DIR) / "onboarding.json", {}).get("items", [])
    available = importlib.util.find_spec("onboarding") is not None
    rows = []
    for entry in entries:
        if not isinstance(entry, dict) or not entry.get("id"):
            continue
        data = entry.get("data") or {}
        target = data.get("target") or data.get("path") or data.get("link") or "Dispatch setup"
        source = data.get("source") or "Existing settings"
        rows.append({"id": "setup-" + fingerprint(entry["id"], json.dumps(data, sort_keys=True)), "kind": "setup",
                     "targets": list((data.get("changes") or {}).keys()), "pref_record_at": data.get("pref_record_at"),
                     "source_id": entry["id"], "name": entry.get("title") or "First-run setup", "detail": entry.get("detail") or "",
                     "from": source if isinstance(source, str) else "Existing settings", "to": target if isinstance(target, str) else "Dispatch setup",
                     "can_undo": available and not entry.get("undone"), "undone": bool(entry.get("undone")),
                     "reason": "" if available else "This receipt needs the setup component from the same Dispatch version."})
    return rows


def imports_list():
    rows = []
    # Historic directory migrations retained the original folder beside the link.
    for kind, old, new in DD.legacy_places():
        old = scoped(old)
        backups = sorted(old.parent.glob(old.name + ".pre-dispatch*")) if old.parent.exists() else []
        if old.is_symlink() and old.resolve() == Path(new).resolve():
            backup = next((p for p in backups if p.is_dir() and not p.is_symlink()), None)
            # no backup: there was no folder here to keep (a new Mac), so nothing is missing and nothing to undo (task-4o71)
            rows.append({"id": "dir-" + fingerprint(old, new, backup), "kind": "directory", "name": f"{kind.title()} folder",
                         "from": str(old), "to": new, "backup": str(backup or ""), "can_undo": bool(backup),
                         "detail": "Undo restores the original folder. The copy in Dispatch is kept." if backup
                         else "New link: there was no folder here before, so there is nothing to restore.",
                         "reason": ""})
    for target in rules_status()["targets"]:
        p = Path(target["path"])
        text = p.read_text() if p.is_file() else ""
        i, j = text.find(D.RULES_BEGIN), text.find(D.RULES_END)
        if i >= 0 and j >= i:
            block = text[i:j + len(D.RULES_END)]
            rows.append({"id": "rules-" + fingerprint(str(p), block), "kind": "rules", "name": f"Rules for {E.get(target['agent']).name}",
                         "from": str(scoped(D.RULES_FILE)), "to": str(p), "can_undo": True,
                         "detail": "Undo removes only the Dispatch managed block. Other instructions stay in place.", "reason": ""})
    for group in hooks_list()["groups"]:
        for agent, info in group["agents"].items():
            if info["enabled"]:
                rows.append({"id": _hook_fingerprint(agent, group["id"], True),
                             "kind": "hooks", "name": f"{group['name']} for {E.get(agent).name}", "from": "Dispatch setup", "to": info["path"],
                             "group": group["id"], "agent": agent, "can_undo": True, "reason": "",
                             "detail": "Undo turns off this group. You can turn it back on in Hooks."})
    # Old preference receipts lack item ids and before-images. Never guess which
    # preferences were new, merged, or edited after an import.
    import prefs
    for index, rec in enumerate(read_json(prefs.imports_path(), [])):
        if isinstance(rec, dict):
            rows.append({"id": "preferences-" + fingerprint(index, rec.get("at")), "kind": "preferences", "name": "Preferences",
                         "from": ", ".join(s.get("path", "") for s in rec.get("sources", [])), "to": str(Path(DD.root()) / "preferences.jsonl"),
                         "can_undo": False, "reason": "This older import has no reversible receipt. Manage individual preferences in Knowledge.",
                         "detail": f"{rec.get('items', 0)} preferences imported", "at": rec.get("at", "")})
    setup = setup_receipts()
    covered = {p for r in setup if not r["undone"] for p in [r["to"], *r.get("targets", [])]}
    pref_records = {r.get("pref_record_at") for r in setup if r.get("pref_record_at")}
    rows = [r for r in rows if r["to"] not in covered and not (r["kind"] == "preferences" and r.get("at") in pref_records)] + setup
    state = read_json(state_path(), {})
    for rec in state.get("adoptions", []):
        old, new = Path(rec["from"]), Path(rec["to"])
        if old.is_symlink() and old.resolve() == new.resolve():
            rows.append({**rec, "can_undo": Path(rec["backup"]).is_dir(), "reason": ""})
    active_ids = {r["id"] for r in rows}
    rows.extend(r for r in state.get("undone", []) if r["id"] not in active_ids)
    # Keep the acted-on row in place when it becomes Undone.
    order = {"directory": 0, "rules": 1, "hooks": 2, "preferences": 3, "setup": 4}
    return sorted(rows, key=lambda r: (order.get(r["kind"], 5), r["name"].casefold(), r["id"]))


def skill_change(name, agent=None, enabled=None, adopt=False):
    row = next((r for r in skills_list() if r["name"] == name), None)
    if not row:
        raise ValueError("This skill is no longer available. Refresh the list.")
    if row["builtin"]:
        raise ValueError("This skill is installed by Dispatch and is read-only.")
    if adopt:
        if row["in_pool"]:
            return {"ok": True, "unchanged": True}
        if not D.safe_skill_name(name):
            raise ValueError("Invalid skill name.")
        source, target = Path(row["path"]), Path(D.POOL) / name
        with locked():
            if target.exists() or target.is_symlink():
                raise ValueError("A skill with this name already exists in the pool.")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, target, symlinks=True)
            backup = DD.backup_name(str(source))
            DD.swap_in_link(str(source), str(target), backup)
            state = read_json(state_path(), {})
            state.setdefault("adoptions", []).append({"id": "skill-" + fingerprint(source, target, backup), "kind": "directory", "name": name,
                "from": str(source), "to": str(target), "backup": backup, "detail": "Added to the skill pool. Undo restores the original folder and keeps the pool copy."})
            write_json(state_path(), state)
        return {"ok": True}
    if agent not in E.skill_dirs() or not isinstance(enabled, bool):
        raise ValueError("Choose an agent and an enabled state.")
    if home() == Path(D.HOME):
        import types
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            D.cmd_skills(types.SimpleNamespace(op="enable" if enabled else "disable", name=name, agent=[agent]))
        current = next(r for r in D.all_skills() if r["name"] == name)
        if bool(current["agents"].get(agent)) != enabled:
            raise ValueError(output.getvalue().strip())
    else:
        link = Path(E.skill_dirs(home=str(home()), env={})[agent][0]) / name
        link.parent.mkdir(parents=True, exist_ok=True)
        if enabled and not link.exists():
            link.symlink_to(row["path"])
        elif not enabled and link.is_symlink():
            link.unlink()
    return {"ok": True}


def undo_import(key):
    # Re-discover each candidate; the caller cannot supply filesystem paths.
    row = next((r for r in imports_list() if r["id"] == key and not r.get("undone")), None)
    if not row or not row.get("can_undo"):
        raise ValueError((row or {}).get("reason") or "This import changed or was already undone. Refresh the list.")
    if row["kind"] == "hooks":
        toggle_hook(row["group"], row["agent"], False, key)
    elif row["kind"] == "setup":
        result = D._mod("onboarding").undo(row["source_id"])
        if not result.get("ok"):
            raise ValueError(result.get("message") or "The setup import could not be undone.")
    else:
        with locked():
            current = next((r for r in imports_list() if r["id"] == key and not r.get("undone")), None)
            if current != row:
                raise ValueError("This import changed. Refresh the list.")
            if row["kind"] == "rules":
                p = Path(row["to"])
                before = p.read_bytes()
                text = before.decode()
                i, j = text.find(D.RULES_BEGIN), text.find(D.RULES_END)
                end = j + len(D.RULES_END)
                if text[end:end + 1] == "\n":
                    end += 1
                import backups
                backups.save(str(p), home=str(home()))
                write_bytes(p, (text[:i] + text[end:]).encode(), before)
            elif row["kind"] == "directory":
                old, backup = Path(row["from"]), Path(row["backup"])
                parked = state_path().parent / (key + ".link")
                if parked.exists() or parked.is_symlink():
                    raise ValueError("A previous recovery link already exists; the folders were left unchanged.")
                old.rename(parked)
                try:
                    backup.rename(old)
                except OSError:
                    parked.rename(old)
                    raise
    with locked():
        state = read_json(state_path(), {})
        history = state.setdefault("undone", [])
        history[:] = [r for r in history if r["id"] != key]
        history.append({**row, "can_undo": False, "undone": True, "at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
        write_json(state_path(), state)
    return {"ok": True, "id": key, "undone": True}


def snapshot():
    return {"rules": rules_status(), "hooks": hooks_list(), "skills": skills_list(), "imports": imports_list(), "agents": builtin_agents_list()}


def builtin_agents_list():
    """The helper agents that come with Dispatch, for Sub-agents' Built-in card (builtin_agents.py)."""
    if home() != Path(D.HOME):
        return []  # a disposable instance on someone's real HOME: not its business
    import builtin_agents
    return builtin_agents.rows()


def sync_rules():
    info = rules_status()
    for target in info["targets"]:
        p = Path(target["path"])
        text = p.read_text() if p.is_file() else ""
        if D.RULES_BEGIN in text and (text.count(D.RULES_BEGIN) != 1 or text.count(D.RULES_END) != 1 or text.find(D.RULES_END) < text.find(D.RULES_BEGIN)):
            raise ValueError("A managed block is incomplete or duplicated. Review the file before syncing; nothing was changed.")
    if home() == Path(D.HOME):
        import types
        return D.cmd_rules(types.SimpleNamespace(op="sync", force=False, json=True))
    # Same managed-block operation, restricted to the disposable profile.
    source = Path(info["source"])
    if not source.is_file():
        raise ValueError("The shared rules file has not been created yet.")
    dfile, dtext = D.dispatch_rules()
    with locked():
        for target in info["targets"]:
            p = Path(target["path"])
            before = p.read_bytes() if p.exists() else b""
            text = before.decode()
            block = D.render_block(target["agent"], source.read_text(), info["hash"], dtext, dfile).replace(D.RULES_FILE, str(source))
            i, j = text.find(D.RULES_BEGIN), text.find(D.RULES_END)
            if i >= 0 and j < i:
                raise ValueError("The managed block is incomplete; the file was left unchanged.")
            new = text[:i] + block + text[j + len(D.RULES_END):].lstrip("\n") if i >= 0 else text.rstrip() + "\n\n" + block
            write_bytes(p, new.encode(), before)
    print(json.dumps({"ok": True}))


def command(a):
    try:
        if a.cmd == "hooks" and a.op in ("status", "sync", "install", "uninstall"):
            import hooks_setup
            return hooks_setup.command_line(a)
        if a.cmd == "hooks":
            result = hooks_list() if a.op == "list" else toggle_hook(a.name, a.agent, a.op == "on")
        elif a.cmd == "imports":
            result = imports_list() if a.op == "list" else undo_import(a.name)
        elif a.op == "sync":
            return sync_rules()
        elif a.op == "brief":
            import types
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                D.cmd_prime(types.SimpleNamespace(cwd=os.getcwd(), hook_json=False, opencode=False))
            result = {"text": buf.getvalue()}
        elif a.op in ("skill-on", "skill-off", "adopt"):
            result = skill_change(a.name, a.agent, a.op == "skill-on", a.op == "adopt")
        else:
            result = snapshot()
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError) as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        raise SystemExit(1)


def add_parsers(sub):
    import engines as E
    hooks_help = ("Dispatch's one hook entry in each agent (hook.py, hooks_setup.py): list / on / off <feature> --agent "
                  "turn one of its features on or off; status, sync (bring it up to date: older Dispatch hooks replaced, Codex "
                  "made to trust it; only where a Dispatch hook already is; the Agents window runs it at each start), install, uninstall")
    for name, ops in (("customizations", ["list", "sync", "brief", "skill-on", "skill-off", "adopt"]),
                      ("hooks", ["list", "on", "off", "status", "sync", "install", "uninstall"]), ("imports", ["list", "undo"])):
        s = sub.add_parser(name, help=hooks_help if name == "hooks" else "Dispatch customizations: inventory and reversible changes")
        s.add_argument("op", nargs="?", default="list", choices=ops)
        s.add_argument("name", nargs="?", default="")
        s.add_argument("--agent", default=None, help="an agent (claude, codex, opencode); status/sync/install/uninstall: a comma list")
        s.add_argument("--json", action="store_true")
        s.set_defaults(fn=command)
