# -*- coding: utf-8 -*-
"""Dispatch's one hook entry in each agent: put it in, take it out, bring it up to date, say how it stands.

Every agent gets exactly one Dispatch hook, the entry `~/.dispatch/bin/dispatch-hook <agent> # dispatch-hook`, once on
each event its adapter routes (the shim runs <cli>/hook.py and never stops the agent, shim_text) (engines/<id>.py `hook_routes`); hook.py runs the features from there. In a JSON settings
file (Claude Code's ~/.claude/settings.json, Codex's ~/.codex/hooks.json) that is one group per event:

  * the person's own hooks (and other tools' hooks: Orca, Beads) are never changed, moved inside their group or
    dropped; Dispatch only takes out what it wrote itself: its entry, and the hooks older versions wrote
    (`# dispatch-prime | presence | plan | edit-guard | life`, an unmarked `dispatch prime --hook-json`)
  * an upgrade replaces those older hooks with the entry, in the place the first of them had (`dispatch hooks sync`,
    which the Agents window runs at each start, and first-run setup); the file as it was is kept next to it as
    <file>.dispatch-bak, the person's file from before Dispatch ever touched it as <file>.pre-dispatch
  * nothing changes when the entry is already as it should be (the file is not even written)
  * an edit guard the person had installed, or a hook group they had turned off in Customizations, carries over as
    a switch of the entry (hook.py reads them from ~/.dispatch/config.json)

Codex runs a hook only once it is trusted: it keeps a hash per hook, keyed by the hook's file, event and position, in
config.toml ([hooks.state]). After writing the file, Dispatch asks Codex itself (`codex app-server`: hooks/list, then
config/batchWrite on hooks.state, the calls Codex's own /hooks Trust makes) to trust Dispatch's entry, and only that
exact command. Hooks of the person's that the change moved to another position keep the trust they had (the same
hook, same hash, at its new key); the person's untrusted hooks stay untrusted. See engines/codex.py.

`dispatch hooks status | sync | install | uninstall [--agent a,b] [--json]` (registered with Customizations' `hooks`
list / on / off, customizations.py).
"""
import copy
import json
import os
import re
import shlex
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
MARK = "# dispatch-hook"
ENTRY = re.compile(r"#\s*dispatch-hook(?![\w-])")
OLD = re.compile(r"#\s*dispatch-(prime|presence|plan|edit-guard|life)(?=\s|$)")


def home():
    """The home whose agents get the entry: the person's, or a test instance's scratch home (customizations.home)."""
    try:
        import customizations
        return str(customizations.home())
    except Exception:  # noqa: BLE001
        return os.path.expanduser("~")


# ---------------------------------------------------------------- the entry
APP_HOOK = "/Applications/Dispatch IDE.app/Contents/Resources/app/dispatch-cli/dispatch/cli/hook.py"
SHIM_NAME = "dispatch-hook"


def hook_script():
    return os.path.join(HERE, "hook.py")


def shim_path(h=None):
    """The stable entry the agents' settings name: a small script in ~/.dispatch/bin that is not inside the app, so
    replacing or updating the app never leaves the agents pointing at a file that is gone (a missing hook.py made
    Python exit 2, which Claude Code and Codex take as "block this tool call": every agent stuck, 10-09).
    `h`: a scratch home (a test instance's customizations-home) keeps its own."""
    h = h or home()
    import dispatch_dir as DD
    if os.path.realpath(h) == os.path.realpath(DD.home()):
        return DD.path("bin", SHIM_NAME)
    return os.path.join(h, ".dispatch", "bin", SHIM_NAME)


def shim_text(python=None, script=None):
    """The shim: runs hook.py of the Dispatch installed now and lets the agent go on whatever happens. hook.py
    missing (the app being replaced, moved, removed): exit 0 without a word. hook.py failing: its error goes to
    ~/.dispatch/state/hook-errors.log, the exit is 0. Only an answer hook.py gives on purpose (the edit guard's
    deny) can stop a tool."""
    python = python or sys.executable or "python3"
    script = script or hook_script()
    q = shlex.quote
    return f"""#!/bin/sh
# Dispatch's hook entry, written by Dispatch (`dispatch hooks sync` rewrites it; do not edit).
# The agents' settings run this instead of hook.py inside the app: it never stops an agent. No Dispatch here (the
# app being replaced or removed): exit 0. hook.py failing: logged to hook-errors.log, exit 0.
hook={q(script)}
[ -f "$hook" ] || hook={q(APP_HOOK)}
[ -f "$hook" ] || exit 0
python={q(python)}
[ -x "$python" ] || python=$(command -v python3) || exit 0
dir="${{DISPATCH_HOME:-$HOME/.dispatch}}/state"
[ -d "$dir" ] || mkdir -p "$dir" 2>/dev/null || dir=/tmp
"$python" "$hook" "$@" 2>>"$dir/hook-errors.log"
code=$?
[ "$code" = 0 ] || echo "$(date '+%Y-%m-%d %H:%M:%S') dispatch-hook $*: exit $code ($hook)" >>"$dir/hook-errors.log" 2>/dev/null
exit 0
"""


def write_shim(h=None, python=None, script=None):
    """Writes the shim when it is missing or says something else; returns its path."""
    path = shim_path(h)
    text = shim_text(python, script)
    try:
        with open(path, encoding="utf-8") as f:
            if f.read() == text and os.access(path, os.X_OK):
                return path
    except OSError:
        pass
    from instructions import atomic_write
    os.makedirs(os.path.dirname(path), exist_ok=True)
    atomic_write(path, text)
    os.chmod(path, 0o755)
    return path


def shim_current(h=None):
    try:
        with open(shim_path(h), encoding="utf-8") as f:
            return f.read() == shim_text() and os.access(shim_path(h), os.X_OK)
    except OSError:
        return False


def command(eng):
    """The one command line Dispatch's hook runs for `eng`, the same on every event: the shim (shim_path)."""
    import dplatform as P
    if P.IS_WIN:
        import init_wizard as I
        return f"{I.hook_path(I.hook_python())} {I.hook_path(hook_script())} {eng.agent} {MARK}"
    return f"{shlex.quote(shim_path())} {eng.agent} {MARK}"


def kind(cmd):
    """'entry' for Dispatch's entry, the feature name for a hook an older Dispatch wrote, else None (not ours)."""
    cmd = cmd if isinstance(cmd, str) else ""
    if ENTRY.search(cmd):
        return "entry"
    m = OLD.search(cmd)
    if m:
        return m.group(1)
    if "prime --hook-json" in cmd:  # older setups wrote `dispatch prime --hook-json` without a marker
        return "prime"
    return None


def groups(eng):
    """{event: the group Dispatch's entry sits in}: matcher on the group, timeout and the like on the hook."""
    cmd = command(eng)
    out = {}
    for event in eng.hook_routes:
        opts = dict(eng.hook_options.get(event) or {})
        group = {}
        if "matcher" in opts:
            group["matcher"] = opts.pop("matcher")
        group["hooks"] = [{"type": "command", "command": cmd, **opts}]
        out[event] = group
    return out


# ---------------------------------------------------------------- reading and writing the file
def _read(path):
    """(raw text, document) or raises ValueError for a file Dispatch must leave alone."""
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    except FileNotFoundError:
        return "", {}
    d = json.loads(raw) if raw.strip() else {}
    if not isinstance(d, dict) or not isinstance(d.get("hooks", {}), dict):
        raise ValueError("has another shape")
    for gs in d.get("hooks", {}).values():
        if not isinstance(gs, list) or any(not isinstance(g, dict) or not isinstance(g.get("hooks", []), list) for g in gs):
            raise ValueError("has another shape")
    return raw, d


def _write(path, d, raw):
    from instructions import atomic_write
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if raw:
        with open(path + ".dispatch-bak", "w", encoding="utf-8") as f:
            f.write(raw)
    atomic_write(path, json.dumps(d, ensure_ascii=False, indent=2) + "\n")


def strip(d, drop_empty=True):
    """Take every hook Dispatch wrote out of the document. {event: the index of the first group it was in}, and the
    older features found ({feature, ...}). `drop_empty`: an event left with no group goes (else it keeps its place)."""
    hooks = d.get("hooks") or {}
    first, found = {}, set()
    for event, gs in list(hooks.items()):
        kept = []
        for g in gs:
            mine = [h for h in g.get("hooks", []) if isinstance(h, dict) and kind(h.get("command"))]
            if mine:
                found.update(kind(h.get("command")) for h in mine)
                g["hooks"] = [h for h in g.get("hooks", []) if h not in mine]
                # the entry goes where the first of them was: in place of a group that held only Dispatch's hooks, or
                # right after one it shared with the person's, so their group keeps its place
                first.setdefault(event, len(kept) + (1 if g["hooks"] else 0))
                if not g["hooks"]:
                    continue
            kept.append(g)
        if kept or not drop_empty:
            hooks[event] = kept
        else:
            del hooks[event]
    return first, found - {"entry"}


def merged(eng, d):
    """(the document with Dispatch's entry as it should be, the older features that were in it)."""
    d = copy.deepcopy(d)
    first, found = strip(d, drop_empty=False)
    hooks = d.setdefault("hooks", {})
    for event, group in groups(eng).items():
        gs = hooks.setdefault(event, [])
        gs.insert(min(first.get(event, len(gs)), len(gs)), group)
    for event in [e for e, gs in hooks.items() if not gs]:
        del hooks[event]
    return d, found


# ---------------------------------------------------------------- switches (hook.py reads them)
def switch(agent, feature, on=None):
    """A feature of the entry for one agent: on or off now (`on`: set it first)."""
    import dispatch_dir as DD
    import hook
    if on is not None:
        cfg = DD.config_load()
        if not isinstance(cfg.get("hooks"), dict):
            cfg["hooks"] = {}
        if not isinstance(cfg["hooks"].get(agent), dict):
            cfg["hooks"][agent] = {}
        cfg["hooks"][agent][feature] = bool(on)
        DD.config_save(cfg)
    return hook.switches(agent, DD.path("config.json"))[feature]


def _saved(agent, feature):
    import dispatch_dir as DD
    return feature in (((DD.config_load().get("hooks") or {}).get(agent)) or {})


def carry_switches(eng, found):
    """What the older hooks said, as switches: an edit guard that was installed stays on; a group the person turned
    off in Customizations (customizations.json disabled_hooks) stays off. A switch already saved wins."""
    if "edit-guard" in found and eng.edit_tools and not _saved(eng.agent, "edit-guard"):
        switch(eng.agent, "edit-guard", True)
    try:
        import customizations
        state = customizations.read_json(customizations.state_path(), {})
        off = state.get("disabled_hooks") or {}
        changed = False
        for key in [k for k in off if k.startswith(eng.agent + ":")]:
            feature = key.split(":", 1)[1]
            if not _saved(eng.agent, feature):
                switch(eng.agent, feature, False)
            del off[key]
            changed = True
        if changed:
            customizations.write_json(customizations.state_path(), state)
    except Exception:  # noqa: BLE001 - an unreadable state file only loses an old choice
        pass


# ---------------------------------------------------------------- install, uninstall, state
def install(eng, path, env=None, trust=None):
    """Dispatch's entry in `path`, the older Dispatch hooks out, the person's own as they are. `trust` (an engine
    that only runs trusted hooks): have it trust the entry; None means "when this is its own file"."""
    if trust is None:
        trust = os.path.realpath(path) == os.path.realpath(eng.hooks_file(home()))
    if not os.path.isdir(os.path.dirname(path)):
        return {"path": path, "skipped": f"{eng.name} is not installed"}
    try:
        raw, d = _read(path)
    except ValueError:
        return {"path": path, "skipped": f"{os.path.basename(path)} cannot be read; left as it is"}
    new, found = merged(eng, d)
    changed = new != d or not raw
    before = None
    if changed and trust and eng.hook_trust and raw:
        before = eng.hook_listing(path, env=env)  # the trust the person's hooks have now, at their current places
    import dplatform as P
    shim = "" if P.IS_WIN else write_shim()
    res = {"path": path, "changed": changed, "command": command(eng), "migrated": sorted(found), "shim": shim}
    if changed:
        import init_wizard as I
        res["original"] = I.keep_original(path, raw)
        _write(path, new, raw)
        res["backup"] = path + ".dispatch-bak" if raw else ""
    carry_switches(eng, found)
    if trust and eng.hook_trust:
        res["trust"] = eng.trust_hook(path, command(eng), before=before, env=env)
    return res


def uninstall(eng, path):
    try:
        raw, d = _read(path)
    except ValueError:
        return False
    if not raw:
        return False
    first, _found = strip(d)
    if not first:
        return False
    if not d.get("hooks"):
        d.pop("hooks", None)
    _write(path, d, raw)
    return True


def state(eng, path, env=None, deep=False):
    """{path, installed, current, old, events, missing, trusted}: installed = the entry is on every event it should
    be; current = exactly as this install writes it; old = features of older Dispatch hooks still there; trusted
    (an engine that only runs trusted hooks, `deep`: asks it) = it runs the entry."""
    out = {"path": path, "installed": False, "current": False, "old": [], "events": [], "missing": [], "trusted": None}
    try:
        _raw, d = _read(path)
    except ValueError:
        out["error"] = f"{os.path.basename(path)} cannot be read"
        return out
    want = groups(eng)
    have = {}
    for event, gs in (d.get("hooks") or {}).items():
        for g in gs:
            for h in g.get("hooks", []):
                k = kind(h.get("command")) if isinstance(h, dict) else None
                if k == "entry":
                    have.setdefault(event, []).append((g, h))
                elif k:
                    out["old"].append(k)
    out["old"] = sorted(set(out["old"]))
    out["events"] = sorted(have)
    out["missing"] = sorted(set(want) - set(have))
    out["installed"] = not out["missing"]
    import dplatform as P
    out["shim"] = True if P.IS_WIN else shim_current()
    out["current"] = out["installed"] and not out["old"] and out["shim"] and set(have) == set(want) and all(
        len(have[e]) == 1 and have[e][0][0] == want[e] for e in want)
    if deep and eng.hook_trust and have:
        out["trusted"] = eng.hook_trusted(path, command(eng), env=env)
    return out


# ---------------------------------------------------------------- up to date at each start
def engines_with_hooks():
    import engines as E
    return [e for e in E.runnable() if e.hooks_json]


def sync(agents=None, env=None, h=None):
    """Bring Dispatch's entry up to date wherever Dispatch's hooks are (the entry or an older hook): replace older
    hooks, rewrite a stale entry, have Codex trust it. An agent without any Dispatch hook is left alone (setup puts
    it in; a person who took it out keeps it out)."""
    h = h or home()
    out = {}
    for eng in engines_with_hooks():
        if agents and eng.agent not in agents and eng.id not in agents:
            continue
        path = eng.hooks_file(h)
        st = state(eng, path)
        if not st["events"] and not st["old"]:
            out[eng.agent] = {"path": path, "skipped": "no Dispatch hook there"}
            continue
        try:
            out[eng.agent] = install(eng, path, env=env, trust=True)
        except Exception as e:  # noqa: BLE001
            out[eng.agent] = {"path": path, "error": str(e)[:300]}
    return out


# ---------------------------------------------------------------- command line
def command_line(a):
    import engines as E
    picked = [x.strip() for x in (getattr(a, "agent", None) or "").split(",") if x.strip()]
    engs = [E.get(x) for x in picked] if picked else engines_with_hooks()
    if a.op == "sync":
        # no "set up yet?" gate: sync only ever touches a file that already has a Dispatch hook in it
        result = sync([e.agent for e in engs] if picked else None)
    elif a.op in ("install", "uninstall"):
        result = {}
        for eng in engs:
            if not (eng.hooks_json or eng.hooks_plugin):
                result[eng.agent] = {"skipped": f"Dispatch has no hook for {eng.name}"}
            elif a.op == "install":
                result[eng.agent] = eng.install_hooks()
            else:
                result[eng.agent] = {"removed": bool(eng.uninstall_hooks())}
    else:
        result = {e.agent: e.hooks_state(deep=True) for e in engs if e.hooks_json}
    if a.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    for agent, r in result.items() if isinstance(result, dict) else []:
        name = E.get(agent).name
        if not isinstance(r, dict):
            print(f"{name}: {r}")
        elif r.get("skipped") or r.get("error"):
            print(f"{name}: {r.get('skipped') or r.get('error')}")
        elif a.op == "status":
            trust = "" if r.get("trusted") is None else (", trusted" if r["trusted"] else ", NOT trusted (Codex will not run it)")
            print(f"{name}: " + ("entry in place" if r["current"] else "entry out of date" if r["installed"] else "no entry")
                  + (f", older Dispatch hooks: {', '.join(r['old'])}" if r["old"] else "") + trust + f" ({r['path']})")
        elif a.op == "uninstall":
            print(f"{name}: " + ("removed" if r.get("removed") else "nothing to remove"))
        else:
            t = r.get("trust") or {}
            print(f"{name}: " + ("updated" if r.get("changed") else "already up to date")
                  + (f", replaced older hooks ({', '.join(r['migrated'])})" if r.get("migrated") else "")
                  + ("" if not t else ", trusted in Codex" if t.get("ok") else f", Codex trust: {t.get('why') or 'failed'}")
                  + f" ({r.get('path', '')})")
