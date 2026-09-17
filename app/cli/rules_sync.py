# -*- coding: utf-8 -*-
"""Shared machine-wide rule files (~/.agents/rules/{GLOBAL,FACTS,PROFILE,artifact}.md) — kept as
one copy across every Mac that runs Dispatch. `dispatch rules push|pull|peers|auto`.

Peer-to-peer, not a daemon: whichever Mac runs the command ssh's into the other one (hosts.json),
reads and writes the four files over one or two ssh round trips, and remembers the hash both sides
last agreed on (STATE_FILE) so a later run can tell "only I changed this" (fast-forward, copy it
over, no fuss) from "we both changed it since last time" (a real conflict). `push`/`pull` are
explicit human overrides: they only decide who wins a genuine conflict, never a fast-forward — that
would throw away the one side that has the only copy of an edit. `auto` is the unattended path (a
periodic app timer, and right after any Dispatch write to one of these files): newer mtime wins,
and the hub — the Mac `dispatch init` first ran on; a joiner's init.json records the hub it joined,
see init_wizard.load_state()['hub'] — wins a tie or a wash within TIE_TOLERANCE, so two clocks a
few seconds apart don't make the same pair of edits ping-pong forever.

Nothing is ever silently dropped: whichever side is about to be overwritten in a real conflict has
its previous content saved first, as `<file>.<host>.bak` next to it.

Remote shells: the Mini's login shell is fish (see move.bash_line's comment) — every ssh command
below runs the same way, base64 in, `/bin/bash -c` on the far end, never a bare script over ssh.
"""
import base64, hashlib, json, os, re, shutil, subprocess, sys, time

import dispatch as D

RULES_DIR = os.path.join(D.HOME, ".agents", "rules")
SYNCED_FILES = ["GLOBAL.md", "FACTS.md", "PROFILE.md", "artifact.md"]
STATE_FILE = os.path.join(D.DISPATCH_DIR, "rules-sync-state.json")
AUTO_STATE_FILE = os.path.join(D.DISPATCH_DIR, "rules-sync-auto.json")
AUTO_INTERVAL = 30 * 60   # background sweep throttle (app timer polls hourly; this just caps re-tries)
TIE_TOLERANCE = 5         # seconds of clock-skew slack before "newer mtime" gets to decide anything


# ---------------------------------------------------------------- local file state

def local_path(name):
    return os.path.join(RULES_DIR, name)


def _hash(content):
    return hashlib.sha256(content.encode("utf-8")).hexdigest() if content else ""


def local_state(name):
    p = local_path(name)
    try:
        with open(p, encoding="utf-8") as f:
            content = f.read()
        return {"exists": True, "content": content, "hash": _hash(content), "mtime": os.stat(p).st_mtime}
    except OSError:
        return {"exists": False, "content": "", "hash": "", "mtime": 0.0}


def _write_local(name, content, backup_suffix=None):
    p = local_path(name)
    os.makedirs(RULES_DIR, exist_ok=True)
    if backup_suffix and os.path.exists(p):
        shutil.copy2(p, p + f".{backup_suffix}.bak")
    with open(p, "w", encoding="utf-8") as f:
        f.write(content)


# ---------------------------------------------------------------- one ssh round trip each way

def _fetch_script():
    lines = ['mkdir -p "$HOME/.agents/rules"']
    for name in SYNCED_FILES:
        lines += [
            f'echo "==={name}==="',
            f'p="$HOME/.agents/rules/{name}"',
            'if [ -f "$p" ]; then stat -f %m "$p" 2>/dev/null || stat -c %Y "$p" 2>/dev/null; base64 < "$p" | tr -d "\\n"; echo; else echo MISSING; fi',
        ]
    return "\n".join(lines) + "\n"


def _parse_fetch(output):
    """`===NAME===` then either `MISSING` or an mtime line + one base64 line -> {name: state}."""
    out = {}
    lines = output.splitlines()
    i = 0
    while i < len(lines):
        m = re.match(r"^===(.+)===$", lines[i])
        if not m:
            i += 1
            continue
        name = m.group(1)
        i += 1
        if i < len(lines) and lines[i].strip() == "MISSING":
            out[name] = {"exists": False, "content": "", "hash": "", "mtime": 0.0}
            i += 1
            continue
        mtime = float(lines[i].strip()) if i < len(lines) and lines[i].strip() else 0.0
        i += 1
        b64 = lines[i] if i < len(lines) else ""
        i += 1
        try:
            content = base64.b64decode(b64).decode("utf-8", "replace") if b64.strip() else ""
        except Exception:
            content = ""
        out[name] = {"exists": True, "content": content, "hash": _hash(content), "mtime": mtime}
    return out


def remote_fetch(h, timeout=20):
    """One ssh round trip: {filename: {exists, content, hash, mtime}} for every SYNCED_FILES entry on h."""
    move = D._mod("move")
    r = move.run_remote(h, _fetch_script(), timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "ssh 失败").strip()[:300])
    return _parse_fetch(r.stdout)


def remote_push(h, updates, timeout=20):
    """updates: {filename: {"content": str, "backup_suffix": str|None}}. One ssh round trip for
    every file that needs to move, whatever the direction analysis decided. A new GLOBAL.md is
    followed, in the same trip, by `dispatch rules sync` over there (see refresh_local_blocks)."""
    if not updates:
        return
    move = D._mod("move")
    lines = ['mkdir -p "$HOME/.agents/rules"']
    for name, u in updates.items():
        path = f'$HOME/.agents/rules/{name}'
        if u.get("backup_suffix"):
            lines.append(f'[ -f "{path}" ] && cp -p "{path}" "{path}.{u["backup_suffix"]}.bak"')
        b64 = base64.b64encode(u["content"].encode("utf-8")).decode()
        lines.append(f'printf %s {b64} | base64 -d > "{path}"')
    if "GLOBAL.md" in updates:
        lines.append(f'{D.remote_beads(h)} {h.get("dispatch", "$HOME/.local/bin/dispatch")} rules sync >/dev/null 2>&1 || true')
    r = move.run_remote(h, "\n".join(lines) + "\n", timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "ssh 失败").strip()[:300])


# ---------------------------------------------------------------- sync state (what both sides last agreed on)

def load_state():
    try:
        d = json.load(open(STATE_FILE, encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_state(state):
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    json.dump(state, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_FILE)


def _slug(s):
    return re.sub(r"[^A-Za-z0-9_.\-一-鿿]+", "-", s or "").strip("-") or "local"


def local_is_hub():
    """This machine started the board (`dispatch init`'s first-run path leaves init.json's `hub`
    null); a joiner's init.json records the hub it joined. Only the 'auto' tie-break consults this
    — an explicit push/pull already says who should win."""
    try:
        return not bool(D._mod("init_wizard").load_state().get("hub"))
    except Exception:
        return True


# ---------------------------------------------------------------- the decision, per file

def _resolve(loc, rem, last_hash, prefer, is_hub):
    """-> (action, detail). action is one of: noop, to_remote, to_local, conflict_to_remote,
    conflict_to_local. A `conflict_*` action means both sides changed since the last sync (or
    there was no last sync and they already differ) — the loser's current content is backed up
    before being overwritten."""
    if not loc["exists"] and not rem["exists"]:
        return "noop", "都不存在"
    if loc["exists"] and rem["exists"] and loc["hash"] == rem["hash"]:
        return "noop", "已一致"
    if loc["exists"] and not rem["exists"]:
        return "to_remote", "对面还没有这份文件"
    if rem["exists"] and not loc["exists"]:
        return "to_local", "本机还没有这份文件"
    local_changed = last_hash is None or loc["hash"] != last_hash
    remote_changed = last_hash is None or rem["hash"] != last_hash
    if local_changed and not remote_changed:
        return "to_remote", "本机改过，对面没变，直接推过去"
    if remote_changed and not local_changed:
        return "to_local", "对面改过，本机没变，直接拉过来"
    if prefer == "push":
        return "conflict_to_remote", "两边都改过；push 以本机为准，对面旧版本存 .bak"
    if prefer == "pull":
        return "conflict_to_local", "两边都改过；pull 以对面为准，本机旧版本存 .bak"
    delta = loc["mtime"] - rem["mtime"]
    tie = abs(delta) <= TIE_TOLERANCE
    winner_local = is_hub if tie else delta > 0
    if winner_local:
        return "conflict_to_remote", ("两边都改过，时间相近，枢纽（本机）优先" if tie else "两边都改过，本机更新") + "；对面旧版本存 .bak"
    return "conflict_to_local", ("两边都改过，时间相近，枢纽（对面）优先" if tie else "两边都改过，对面更新") + "；本机旧版本存 .bak"


def select_peers(host_filter=""):
    peers = D.hosts()
    if not host_filter:
        return peers
    hf = host_filter.strip()
    return [h for h in peers if hf in (h.get("id"), h.get("name")) or hf in (h.get("aliases") or [])]


def refresh_local_blocks():
    """GLOBAL.md just arrived here from the other Mac. Claude Code reads it through an @import, but
    Codex, pi, OpenCode, Gemini and ZCode carry a pasted copy in their own instruction files: without
    this they keep following the old rules until someone runs `dispatch rules sync` by hand (seen
    2026-09-15: a rule changed on the Mini reached the MacBook's GLOBAL.md, its Codex still had the
    old text). Same command, so the managed-block logic stays in one place."""
    try:
        r = subprocess.run([sys.executable, os.path.abspath(D.__file__), "rules", "sync"], cwd=D.HOME,
                           capture_output=True, text=True, errors="replace", timeout=60)
        return r.returncode == 0
    except Exception:
        return False


def reconcile(h, prefer="auto", files=None, dry_run=False):
    """Reconcile every file in `files` (default SYNCED_FILES) between this Mac and host `h`.
    prefer: 'push' (local wins conflicts), 'pull' (remote wins), 'auto' (newer mtime wins, hub
    breaks a tie). dry_run=True computes and reports without writing anything anywhere (used by
    `peers`/status)."""
    files = files or SYNCED_FILES
    state = load_state()
    peer_state = dict(state.get(h["id"], {}))
    remote = remote_fetch(h)
    is_hub = local_is_hub()
    to_remote, report = {}, []
    for name in files:
        loc = local_state(name)
        rem = remote.get(name) or {"exists": False, "content": "", "hash": "", "mtime": 0.0}
        last = (peer_state.get(name) or {}).get("hash")
        action, detail = _resolve(loc, rem, last, prefer, is_hub)
        final_hash = loc["hash"] or rem["hash"]
        if action in ("to_remote", "conflict_to_remote"):
            final_hash = loc["hash"]
            if not dry_run:
                to_remote[name] = {"content": loc["content"], "backup_suffix": h["id"] if action == "conflict_to_remote" else None}
        elif action in ("to_local", "conflict_to_local"):
            final_hash = rem["hash"]
            if not dry_run:
                _write_local(name, rem["content"], backup_suffix=_slug(D.local_host_name()) if action == "conflict_to_local" else None)
        if name == "GLOBAL.md" and not dry_run and action != "noop":
            detail += "；本机各 Agent 的规则副本已刷新" if action in ("to_local", "conflict_to_local") else "；对面各 Agent 的规则副本随之刷新"
        report.append({"file": name, "action": action, "detail": detail})
        peer_state[name] = {"hash": final_hash, "at": time.time()}
    if to_remote:
        remote_push(h, to_remote)
    if not dry_run and any(r["file"] == "GLOBAL.md" and r["action"] in ("to_local", "conflict_to_local") for r in report):
        refresh_local_blocks()
    if not dry_run:
        state[h["id"]] = peer_state
        save_state(state)
    return report


# ---------------------------------------------------------------- unattended path (app timer + post-write hook)

def auto_sync_all(files=None):
    """Every configured peer, 'auto' rules. One unreachable peer never stops the others."""
    rows = []
    for h in D.hosts():
        try:
            rows.append({"host": h["id"], "name": h["name"], "report": reconcile(h, prefer="auto", files=files)})
        except Exception as e:
            rows.append({"host": h["id"], "name": h["name"], "error": str(e)[:200]})
    return rows


def auto_state():
    try:
        d = json.load(open(AUTO_STATE_FILE, encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _spawn(args):
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    full = [sys.executable, os.path.abspath(D.__file__)] + list(args)
    try:
        subprocess.Popen(full, cwd=D.HOME, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except Exception:
        pass


def auto_sync_due(now=None):
    """Called every hour by the app (same timer as `profile inventory --due`): start a background
    peer sync when the last one was more than AUTO_INTERVAL ago. No peers configured = nothing to do,
    so an idle single-Mac install never touches the network."""
    if not D.hosts():
        return {"due": False, "reason": "没有配置其他 Mac"}
    now = time.time() if now is None else now
    st = auto_state()
    last = float(st.get("at") or 0)
    if last and now - last < AUTO_INTERVAL:
        return {"due": False, "reason": f"不到 {AUTO_INTERVAL // 60} 分钟前同步过（{D.ago(last)}）"}
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    json.dump({"at": now}, open(AUTO_STATE_FILE, "w"), ensure_ascii=False)
    _spawn(["rules", "auto", "--refresh"])
    return {"due": True, "reason": "已开始同步"}


def push_after_edit(name):
    """A Dispatch write to one shared rules file just landed locally (profile add/write, facts
    write, rules write/apply). Get it to every configured peer without making the writer wait on
    ssh, or fail, when a peer happens to be asleep — a detached `rules push --file <name>` runs
    the same conflict handling (backup + newer-side-wins tie-break do not apply here: push always
    favors the edit that just happened) as every other path."""
    if name not in SYNCED_FILES or not D.hosts():
        return
    _spawn(["rules", "push", "--file", name])


# ---------------------------------------------------------------- CLI

def _print_reports(rows):
    for r in rows:
        print(f"— {r.get('name', r['host'])}（{r['host']}） —")
        if r.get("error"):
            print(f"  连不上：{r['error']}")
            continue
        for x in r["report"]:
            print(f"  {x['file']:<14} {x['action']:<20} {x['detail']}")


def cmd_rules_peer(a):
    as_json = getattr(a, "json", False)
    if a.op == "auto":
        refresh, due = getattr(a, "refresh", False), getattr(a, "due", False)
        if not refresh and not due:
            print("用法：dispatch rules auto --refresh（现在同步所有对端）或 --due（到期才同步，供后台调用）", file=sys.stderr)
            sys.exit(2)
        if refresh:
            D.out(auto_sync_all(), as_json, _print_reports)
        else:
            D.out(auto_sync_due(), as_json, lambda x: print(x["reason"]))
        return

    host_filter = getattr(a, "host", "") or ""
    targets = select_peers(host_filter)
    if not targets:
        if host_filter:
            print(f"hosts.json 里没有叫 {host_filter} 的机器", file=sys.stderr)
            sys.exit(1)
        # One Mac: nothing to sync is a fine outcome, not a failure.
        D.out({"skipped": True, "reason": "只有这一台电脑，不用同步", "peers": []}, getattr(a, "json", False), lambda x: print(x["reason"]))
        return
    files = [a.file] if getattr(a, "file", "") else None
    prefer = "auto" if a.op == "peers" else a.op  # "push" | "pull" | "peers"(status, dry-run)
    rows = []
    for h in targets:
        try:
            rows.append({"host": h["id"], "name": h["name"], "report": reconcile(h, prefer=prefer, files=files, dry_run=(a.op == "peers"))})
        except Exception as e:
            rows.append({"host": h["id"], "name": h["name"], "error": str(e)[:200]})
    D.out(rows, as_json, _print_reports)
