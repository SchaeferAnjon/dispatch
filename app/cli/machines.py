# -*- coding: utf-8 -*-
"""`dispatch machines`: this machine and the other Macs in hosts.json, one row each, for Dispatch IDE's
Devices (the account menu), the hint row under Waiting for you and the command palette
(design/machines/redesign/README.md).

  dispatch machines --json            [this machine first, then each peer in hosts.json order]:
      id ("local" | the hosts.json id), name (hosts.json's; for this machine its own name), local,
      online, last_seen, via (tailscale | lan | null), address, user, ssh (user@address), ssh_alias (its
      Host in ~/.dispatch/ssh/config), running / sessions (live sessions working / alive there),
      attention {approve, decide, unread, only_you, total, shared, as_of} counted from that machine's
      own Waiting for you, recent (its three most recent projects), dispatch_version, and hosts_file
      on this machine's row.
  dispatch machines sessions <host>   that machine's live sessions (newest first)

"local" is the machine the CLI runs on: in a Remote-SSH window the bridge calls the other Mac's own
dispatch, whose first row is that Mac. Which row is the current window is the bridge's business (it
matches remoteAuthority to ssh_alias). Peers are asked in parallel through remote_dispatch's cache
(`hosts --local`, `sessions --local`, `waiting --local`, `projects-view --json --local` there): a warm
cache answers at once and is refreshed in the background, a cold one costs at most ~4 s, and a Mac
that is off keeps its last counts together with when they were counted (attention.as_of).
"""
import sys

sys.dont_write_bytecode = True

import glob
import json
import os
import shlex
import subprocess
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import host_admin as H

D = None

HERE = os.path.dirname(os.path.abspath(__file__))
PEER_TIMEOUT = 1  # remote_dispatch(background=True) waits at most timeout + 3 s on a cold cache
TTL = {"sessions": 20, "waiting": 30, "projects": 300, "hosts": 120}
ARGS = {"sessions": ["sessions", "--local"], "projects": ["projects-view", "--json", "--local"], "hosts": ["hosts", "--local"]}


def version():
    """The Dispatch version of this CLI (the VERSION file next to it), or None."""
    try:
        with open(os.path.join(HERE, "VERSION"), encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def session_row(s):
    return {
        "id": s.get("session_id") or "",
        "agent": s.get("agent") or "",
        "title": (s.get("title") or s.get("name") or "").strip(),
        "project": s.get("project") or os.path.basename((s.get("cwd") or "").rstrip("/")),
        "cwd": s.get("cwd") or "",
        "state": s.get("state") or "unknown",
        "last_at": s.get("last_at") or 0,
        "app": s.get("source_app") or "",
    }


def own_sessions(rows):
    """The alive sessions a machine lists as its own (its `sessions` rows tagged local, nothing it merged
    in from another Mac)."""
    return [s for s in rows or [] if isinstance(s, dict) and s.get("alive", True) and (s.get("host") or "local") == "local" and not s.get("remote")]


def live_counts(rows):
    mine = own_sessions(rows)
    return len(mine), sum(1 for s in mine if s.get("state") == "working")


def _safe(fn, *args, default=None):
    try:
        return fn(*args)
    except Exception as e:  # one source failing leaves its fields empty, never the list
        D.debug(f"machines.{getattr(fn, '__name__', 'fn')}", e)
        return default


# ---- this machine -------------------------------------------------------------------------------------

def local_address():
    ip = D.tailscale_ip()
    if ip:
        return ip, "tailscale"
    ip = D.lan_ip()
    return (ip, "lan") if ip else ("", None)


def _pv():
    PV = D._mod("projects_view")
    PV.D = D
    return PV


def local_registry():
    """(transcript index, registry): read once, shared by this machine's list, its recent projects and the
    filter for a peer whose dispatch is too old to filter its own list."""
    index = D.load_index()
    return index, _pv().registry(index=index)


def _where(f_reg):
    got = f_reg.result() if f_reg is not None else None
    return _pv().placements(got[1]) if got else None


def local_attention(f_reg=None):
    W = D._mod("waiting")
    W.D = D
    return W.attention(W.this_machine(W.collect(), _where(f_reg)))


def local_recent(live, f_reg=None):
    got = f_reg.result() if f_reg is not None else None
    return _pv().recent(index=got[0], reg=got[1], live=live) if got else _pv().recent(live=live)


# ---- another Mac ----------------------------------------------------------------------------------------

def reachable(h):
    """Its ssh port answers (1 s; the address and port ssh's config gives it), unless an ssh to it failed less than a
    minute ago (remote_dispatch's .down)."""
    from machines_watch import read_attention
    if read_attention(D, h) is not None:
        return True
    try:
        if time.time() - os.stat(os.path.join(D.REMOTE_DIR, f"{h['id']}.down")).st_mtime < 60:
            return False
    except OSError:
        pass
    return bool(H.address_of(h)) and D.reachable_over_ssh(h, 1.0)


def last_seen(h, online, now):
    """When that Mac last answered: now when it does; else the newest of the last successful probe and
    the answers remote_dispatch keeps for it (under its id or an id it had before)."""
    seen = os.path.join(D.REMOTE_DIR, f"{h['id']}.seen")
    if online:
        try:
            os.makedirs(D.REMOTE_DIR, exist_ok=True)
            with open(seen, "a", encoding="utf-8"):
                pass
            os.utime(seen, None)
        except OSError:
            pass
        return now
    paths = [seen]
    for k in [h["id"]] + [x for x in h.get("aliases") or [] if H.SAFE.match(x)]:
        paths += glob.glob(os.path.join(D.REMOTE_DIR, glob.escape(k) + "--*.json"))
    times = []
    for p in paths:
        try:
            times.append(os.stat(p).st_mtime)
        except OSError:
            pass
    return max(times) if times else None


def cached(h, args):
    """The last answer remote_dispatch keeps for that Mac and command, without ssh; None when there is none."""
    try:
        with open(D.remote_cache_path(h, args), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def fetch(h, args, ttl, online):
    """That Mac's answer: through remote_dispatch's cache (refreshed in the background) while it is
    online, the last one it gave while it is not."""
    if not online:
        return cached(h, args)
    return D.remote_dispatch(h, args, ttl, timeout=PEER_TIMEOUT, background=True)


def peer_attention(h, online, f_reg=None):
    from machines_watch import read_attention
    pushed = read_attention(D, h)
    if pushed is not None:
        return pushed
    W = D._mod("waiting")
    W.D = D
    data = W.remote_list(h, ttl=TTL["waiting"], timeout=PEER_TIMEOUT, background=True, cached_only=not online,
                         where=lambda: _where(f_reg))
    polled = W.attention(data) if data else None
    saved = read_attention(D, h, stale=True)
    # A dropped stream must not replace its last answer with an older polling cache.
    if saved and (not polled or (saved.get("as_of") or 0) > (polled.get("as_of") or 0)):
        return saved
    return polled


def peer_recent(h, online):
    data = fetch(h, ARGS["projects"], TTL["projects"], online)
    return _pv().theirs(data, h)["recent"] if isinstance(data, dict) else []


def peer_sessions(h, online):
    return fetch(h, ARGS["sessions"], TTL["sessions"], online) if online else None


def peer_version(h, online):
    det = fetch(h, ARGS["hosts"], TTL["hosts"], online)
    return det[0].get("dispatch_version") if isinstance(det, list) and det and isinstance(det[0], dict) else None


def peer_row(h, online, now, parts):
    user, addr = H.user_of(h), H.address_of(h)
    sessions, running = live_counts(parts.get("sessions")) if online else (0, 0)
    name = h.get("name") or h.get("id") or ""
    return {"id": h["id"], "name": name, "label": name, "local": False, "online": online, "last_seen": last_seen(h, online, now),
            "via": H.via_of(addr), "address": addr, "user": user, "ssh": h.get("ssh") or "", "ssh_alias": H.ssh_alias(h),
            "aliases": list(h.get("aliases") or []), "home": f"/Users/{user}" if user else "",
            "running": running, "working": running, "sessions": sessions, "attention": parts.get("attention"),
            "recent": parts.get("recent") or [], "dispatch_version": parts.get("version")}


# ---- the list ---------------------------------------------------------------------------------------------

def machines(hosts=None):
    now = time.time()
    peers = [h for h in (D.hosts() if hosts is None else hosts) if isinstance(h, dict) and h.get("id")]
    with ThreadPoolExecutor(max_workers=6 + 5 * len(peers)) as pool:
        f_live = pool.submit(_safe, D.live_sessions, True, default=[])
        f_reg = pool.submit(_safe, local_registry)
        f_att = pool.submit(_safe, local_attention, f_reg)
        f_addr = pool.submit(_safe, local_address, default=("", None))
        f_online = [pool.submit(_safe, reachable, h, default=False) for h in peers]
        online = [f.result() for f in f_online]
        jobs = []
        for h, on in zip(peers, online):
            jobs.append({"attention": pool.submit(_safe, peer_attention, h, on, f_reg),
                         **{k: pool.submit(_safe, fn, h, on) for k, fn in (("recent", peer_recent), ("sessions", peer_sessions), ("version", peer_version))}})
        live = f_live.result()
        recent = _safe(local_recent, live, f_reg, default=[])  # while the peers and this machine's list are still being asked
        sessions, running = live_counts(live)
        addr, via = f_addr.result()
        name = D.local_host_name()
        user = os.environ.get("USER") or os.path.basename(D.HOME.rstrip("/"))
        rows = [{"id": "local", "name": name, "label": name, "local": True, "online": True, "last_seen": now, "via": via, "address": addr,
                 "user": user, "ssh": "", "ssh_alias": "", "aliases": _safe(D.local_host_aliases, default=[]) or [], "home": D.HOME,
                 "running": running, "working": running, "sessions": sessions, "attention": f_att.result(), "recent": recent or [],
                 "dispatch_version": version(), "hosts_file": D.HOSTS_FILE}]
        for h, on, job in zip(peers, online, jobs):
            rows.append(peer_row(h, on, now, {k: f.result() for k, f in job.items()}))
    return rows


def find(key):
    """None for this machine ("local", its name or an old one), else the hosts.json entry; ValueError when
    neither."""
    k = (key or "").strip()
    here = {"local", "本机", (D.local_host_name() or "").casefold()} | {n.casefold() for n in _safe(D.local_host_aliases, default=[]) or []}
    if not k or k.casefold() in here:
        return None
    h = H.match(D.hosts(), k)
    if not h:
        raise ValueError(f"Unknown Mac: {k}")
    return h


def land_record(land, now=None):
    if land != "waiting":
        raise ValueError("Landing page must be waiting.")
    return {"land": land, "at": time.time() if now is None else now, "id": uuid.uuid4().hex}


def open_machine(key, land=None):
    """Prepare a one-shot landing on the destination. The IDE bridge opens/focuses its window.

    Pass JSON on stdin, never interpolate it into shell code. Atomic rename also makes two
    destination windows race safely when consuming the request.
    """
    h = find(key)
    rec = land_record(land) if land else None
    if rec:
        data = json.dumps(rec, ensure_ascii=False)
        if h is None:
            folder = os.environ.get("DISPATCH_DIR") or os.path.join(D.HOME, ".dispatch", "state")
            os.makedirs(folder, exist_ok=True)
            tmp = os.path.join(folder, f"land.{rec['id']}.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(data)
            os.replace(tmp, os.path.join(folder, "land.json"))
        else:
            script = ('umask 077; mkdir -p "$HOME/.dispatch/state" || exit; '
                      'f=$(mktemp "$HOME/.dispatch/state/land.XXXXXX") || exit; '
                      'cat > "$f" && mv "$f" "$HOME/.dispatch/state/land.json"')
            try:
                r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", h["ssh"],
                                    "/bin/sh -c " + shlex.quote(script)], input=data, text=True,
                                   capture_output=True, timeout=15)
            except (OSError, subprocess.TimeoutExpired) as e:
                raise ValueError(f"Could not open {h.get('name') or key}: {e}") from e
            if r.returncode:
                raise ValueError(f"Could not open {h.get('name') or key}: {(r.stderr or 'SSH failed').strip()}")
    return {"ok": True, "host": h["id"] if h else "local", "land": land}


def command(a, dispatch_module=None):
    global D
    if dispatch_module is not None:
        D = dispatch_module
    if D is None:
        D = H._d()
    op = getattr(a, "op", "") or "list"
    try:
        if op == "list":
            res = machines()
        elif op == "sessions":
            h = find(getattr(a, "host", "") or "")
            if h is None:
                rows = own_sessions(D.live_sessions(local_only=True))
            else:
                rows = own_sessions(D.remote_dispatch(h, ARGS["sessions"], TTL["sessions"]))
            res = sorted((session_row(s) for s in rows), key=lambda r: -(r["last_at"] or 0))
        elif op == "open":
            res = open_machine(getattr(a, "host", ""), getattr(a, "land", None))
        else:
            raise ValueError(f"unknown op {op}")
    except ValueError as e:
        if a.json:
            print(json.dumps({"ok": False, "message": str(e)}, ensure_ascii=False))
        else:
            print(str(e), file=sys.stderr)
        return 1

    def text(r):
        if isinstance(r, dict):
            print(f"Ready: {r['host']}" + (f" · {r['land']}" if r.get("land") else ""))
            return
        for x in r:
            if "online" in x:
                att = x.get("attention") or {}
                where = "this Mac" if x["local"] else ("online" if x["online"] else "offline")
                recent = ", ".join(p.get("label") or p.get("name") or "" for p in x.get("recent") or [])
                print(f"{x['name']:<12} {where:<8} {x['sessions']} sessions, {x['running']} working, {att.get('total', '?')} waiting"
                      + (f"  recent: {recent}" if recent else "") + (f"  ssh {x['ssh_alias']}" if x.get("ssh_alias") else ""))
            else:
                print(f"{x['state']:<8} {x['project']:<18} {x['title'] or x['id']}")
    D.out(res, a.json, text)
    return 0
