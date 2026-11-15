# -*- coding: utf-8 -*-
"""`dispatch hosts discover | add | set | remove`: the other Macs this one knows (hosts.json) and the SSH
aliases Dispatch IDE opens their windows with (~/.dispatch/ssh/config). Dispatch IDE's "Add a device"
and "Manage devices" call these.

  dispatch hosts discover --json
      Macs this one could add: Tailscale peers (`tailscale status --json`; Windows ones are listed with
      supported: false) and SSH services on the local network (Bonjour _ssh._tcp, best effort, ~2 s).
      This Mac is left out; Macs already in hosts.json come with known: true and their id.
  dispatch hosts add <address> --user <u> [--name <n>] [--check] [--password-stdin] --json
      --check runs four steps and prints one JSON line per step as it goes (NDJSON): reach (port 22),
      login (ssh with a key; no key there yet: need_password), dispatch (the CLI there) and engines
      (claude / codex there), then {"done": true, "ok": ..., "suggested_name": ...}. With
      --password-stdin the password read from stdin installs this Mac's public key there once
      (ssh-copy-id); it is never written anywhere. With a --name and every step ok (or without --check)
      the Mac goes into hosts.json and gets its block in ~/.dispatch/ssh/config.
  dispatch hosts set <id> [--name N] [--address A] [--user U] [--id I] --json
  dispatch hosts remove <id> --json
      Edit or drop an entry. hosts.json is copied to backups/hosts/ first and the SSH config follows.
      A new name or id keeps the old ones as aliases, so records that name the Mac the old way (move
      records, project owners, serve.json) still find it.

One Mac, one name: the name in hosts.json is what every view shows and, when it is a plain word, the
SSH alias too (`ssh mini`, Remote-SSH's ssh-remote+mini); a name with spaces or CJK characters uses the
id as its alias. ~/.dispatch/ssh/config starts with `Include ~/.ssh/config`, so the person's own
entries and keys keep working (and win over ours).
"""
import sys

sys.dont_write_bytecode = True

import datetime
import ipaddress
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import tempfile
import threading
import time

import dplatform as P

D = None  # dispatch, bound by command() or _d()

SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$")
USER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9._-]{0,63}$")
HOSTNAME_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*\.?$")
TAILNET = ipaddress.ip_network("100.64.0.0/10")
TAILNET6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")
SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new"]
INCLUDE = "Include ~/.ssh/config"
MARK = "# dispatch: "  # the line before each block Dispatch writes (the hosts.json id follows)
STEPS = ("reach", "login", "dispatch", "engines")
NAME_MAX = 60
BUNDLED_CLI = "/Applications/Dispatch.app/Contents/Resources/cli/dispatch.py"


def _d():
    global D
    if D is None:
        here = os.path.dirname(os.path.abspath(__file__))
        if here not in sys.path:
            sys.path.insert(0, here)
        import dispatch as mod  # noqa: E402
        D = mod
    return D


# ---- one entry --------------------------------------------------------------------------------

def split_ssh(ssh):
    """("apple", "100.64.0.11") for "apple@100.64.0.11"; ("", "mini") for a bare alias."""
    user, _, addr = (ssh or "").strip().rpartition("@")
    return user, addr


def address_of(h):
    return ((h or {}).get("ip") or split_ssh((h or {}).get("ssh"))[1] or "").strip()


def user_of(h):
    return split_ssh((h or {}).get("ssh"))[0]


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")


def ssh_alias(h):
    """The SSH alias of a hosts.json entry: its name when that is a plain word, else its id."""
    for v in ((h or {}).get("name"), (h or {}).get("id"), slug((h or {}).get("name"))):
        if isinstance(v, str) and SAFE.match(v) and v.lower() != "local":
            return v
    return ""


def names_of(h):
    return [n for n in [(h or {}).get("id"), (h or {}).get("name")] + list((h or {}).get("aliases") or []) if isinstance(n, str) and n]


def match(hosts, key):
    """The hosts.json entry an id, name or alias (any case), ssh target or address stands for; None
    when none does. Names are tried before addresses, so an id always wins over another entry's address."""
    k = (key or "").strip()
    if not k:
        return None
    low = k.casefold()
    for h in hosts or []:
        if any(n.casefold() == low for n in names_of(h)):
            return h
    for h in hosts or []:
        if k in (h.get("ssh"), address_of(h)):
            return h
    return None


def via_of(address):
    """How an address is reached: "tailscale" (100.64/10, a .ts.net name), "lan" (a private address, a
    .local name) or None (a public address, an ssh alias, nothing)."""
    a = (address or "").strip().rstrip(".").lower()
    if not a:
        return None
    if a.endswith(".ts.net"):
        return "tailscale"
    if a.endswith(".local"):
        return "lan"
    try:
        ip = ipaddress.ip_address(a)
    except ValueError:
        return None
    if ip in (TAILNET if ip.version == 4 else TAILNET6):
        return "tailscale"
    if ip.is_private or ip.is_link_local:
        return "lan"
    return None


MODELS = (("mac mini", "mini"), ("mac studio", "studio"), ("macbook air", "air"), ("macbook pro", "macbook"),
          ("macbook", "macbook"), ("imac", "imac"), ("mac pro", "mac-pro"))


def short_name(computer_name, taken=()):
    """What to call a Mac by default: "mini" for "Kiwi的Mac mini", "air" for "Anna's MacBook Air", else
    its name without the owner part ("阁楼" stays "阁楼", "PC_Demo" becomes "pc-demo").
    Numbered when the name is taken ("mini-2")."""
    n = " ".join((computer_name or "").split())
    low = n.lower()
    base = next((short for model, short in MODELS if model in low), "")
    if not base:
        rest = re.sub(r"^.*?(?:'s|’s|的)\s*", "", n) or n
        base = slug(rest) if re.search(r"[A-Za-z0-9]", rest) else rest.strip()
    base = (base or "mac")[:NAME_MAX]
    taken = {t.casefold() for t in taken if isinstance(t, str) and t}
    name, i = base, 2
    while name.casefold() in taken:
        name, i = f"{base}-{i}", i + 1
    return name


def public(h):
    """An entry as the Manage devices page reads it."""
    return {"id": h.get("id") or "", "name": h.get("name") or "", "aliases": list(h.get("aliases") or []),
            "ssh": h.get("ssh") or "", "address": address_of(h), "user": user_of(h), "ssh_alias": ssh_alias(h),
            "via": via_of(address_of(h))}


# ---- checks on what a person typed --------------------------------------------------------------

def local_names():
    """Every name this Mac goes by (a peer must not take one of them)."""
    _d()
    names = {"local", "本机"}
    for fn in (D.local_host_name, D.local_host_aliases):
        try:
            v = fn()
            names |= set(v if isinstance(v, (list, tuple, set)) else [v])
        except Exception:
            pass
    return {n.casefold() for n in names if n}


def taken_names(hosts, skip=None):
    out = set()
    for h in hosts or []:
        if h is not skip:
            out |= {n.casefold() for n in names_of(h)}
    return out


def check_name(name, hosts, skip=None):
    n = " ".join(str(name or "").split())
    if not n:
        raise ValueError("Give the Mac a name.")
    if len(n) > NAME_MAX or any(ord(c) < 32 for c in n) or n.startswith("-"):
        raise ValueError(f"That is not a usable name (at most {NAME_MAX} characters).")
    if n.casefold() in local_names():
        raise ValueError(f"{n} is this Mac's own name.")
    if n.casefold() in taken_names(hosts, skip):
        raise ValueError(f"Another Mac in hosts.json is already called {n}.")
    return n


def check_id(hid, hosts, skip=None):
    hid = (hid or "").strip()
    if not SAFE.match(hid) or hid.lower() == "local":
        raise ValueError("An id is one word: letters, digits, dots, dashes, underscores.")
    if hid.casefold() in taken_names(hosts, skip):
        raise ValueError(f"Another Mac in hosts.json already goes by {hid}.")
    return hid


def check_address(address):
    a = (address or "").strip()
    try:
        ipaddress.ip_address(a)
        return a
    except ValueError:
        pass
    if not a or a.startswith("-") or not HOSTNAME_RE.match(a):
        raise ValueError(f"{address} is not an address: give an IP or a host name.")
    return a.rstrip(".")


def check_user(user):
    u = (user or "").strip()
    if not USER_RE.match(u):
        raise ValueError("Give the account name on that Mac (--user), for example apple.")
    return u


def unique_id(base, hosts):
    base = base if SAFE.match(base or "") and base.lower() != "local" else "mac"
    taken = taken_names(hosts)
    hid, i = base, 2
    while hid.casefold() in taken:
        hid, i = f"{base}-{i}", i + 1
    return hid


# ---- hosts.json -----------------------------------------------------------------------------------

def backup():
    """Copy hosts.json to <DISPATCH_DIR>/backups/hosts/ before a change; the copy's path ("" when there
    is no hosts.json yet)."""
    src = D.HOSTS_FILE
    if not os.path.isfile(src):
        return ""
    folder = os.path.join(D.DISPATCH_DIR, "backups", "hosts")
    os.makedirs(folder, exist_ok=True)
    dst = os.path.join(folder, "hosts.json." + datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
    shutil.copy2(src, dst)
    return dst


def save(hosts, keep_backup=True):
    """Write hosts.json in one replace (backed up first unless keep_backup is False). Returns the backup."""
    b = backup() if keep_backup else ""
    os.makedirs(os.path.dirname(D.HOSTS_FILE), exist_ok=True)
    tmp = f"{D.HOSTS_FILE}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(hosts, f, ensure_ascii=False, indent=2)
    P.replace_retry(tmp, D.HOSTS_FILE)
    return b


def remember_aliases(hid, names):
    """Names another Mac goes by (what it calls itself, its old names) join its aliases, so they keep
    resolving; the name hosts.json gives it stays. Writes only when one is new. True when it wrote."""
    _d()
    hs = D.hosts()
    for h in hs:
        if h.get("id") != hid:
            continue
        mine = {n.casefold() for n in names_of(h)}
        others = taken_names(hs, h)
        new = sorted({n.strip() for n in names if isinstance(n, str) and n.strip() and n.strip().casefold() not in mine | others})
        if not new:
            return False
        h["aliases"] = sorted(set(h.get("aliases") or []) | set(new))
        save(hs, keep_backup=False)
        return True
    return False


# ---- ~/.dispatch/ssh/config -----------------------------------------------------------------------

def config_path():
    import dispatch_dir
    return dispatch_dir.path("ssh", "config")


def config_block(h):
    alias, addr, user = ssh_alias(h), address_of(h), user_of(h)
    if not alias or not addr:
        return ""
    lines = [MARK + (h.get("id") or alias), f"Host {alias}", f"  HostName {addr}"]
    if user:
        lines.append(f"  User {user}")
    return "\n".join(lines)


def render_config(existing, hosts):
    """The SSH config for these hosts: `Include ~/.ssh/config` first, the person's own lines kept as
    they are, then one block per Mac (a block after a `# dispatch: <id>` line is ours and is rewritten)."""
    kept, state = [], None  # state: None (their lines), "mark" (after our marker), "ours" (in our block)
    for line in (existing or "").splitlines():
        s = line.strip()
        low = s.lower()
        if s.startswith(MARK.strip()):
            state = "mark"
            continue
        if state == "mark":
            state = "ours" if low.startswith("host ") else None
            if state == "ours":
                continue
        elif state == "ours":
            if not s:
                state = None
                continue
            if not low.startswith(("host ", "match ")) and not s.startswith("#"):
                continue
            state = None
        if s == INCLUDE:
            continue
        kept.append(line.rstrip())
    while kept and not kept[0]:
        kept.pop(0)
    while kept and not kept[-1]:
        kept.pop()
    parts = [INCLUDE] + (["\n".join(kept)] if kept else []) + [b for b in (config_block(h) for h in hosts or []) if b]
    return "\n\n".join(parts) + "\n"


def sync_config(hosts=None):
    """Write ~/.dispatch/ssh/config from hosts.json, creating only that file and its folder. Nothing is
    created while there is no other Mac. Returns the path ("" when nothing was written)."""
    _d()
    hosts = D.hosts() if hosts is None else hosts
    path = config_path()
    try:
        with open(path, encoding="utf-8") as f:
            existing = f.read()
    except OSError:
        existing = None
    if existing is None and not hosts:
        return ""
    text = render_config(existing or "", hosts)
    if text != existing:
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, 0o600)
        P.replace_retry(tmp, path)
    return path


def sync_config_quietly(hosts=None):
    """sync_config for callers that only touch hosts.json on the side (a rename pushed by a peer)."""
    try:
        return sync_config(hosts)
    except Exception as e:
        _d().debug("host_admin.sync_config", e)
        return ""


# ---- set / remove -----------------------------------------------------------------------------------

def set_host(key, name=None, address=None, user=None, new_id=None):
    """Change a peer's name, address, account or id. The old name and id join its aliases."""
    _d()
    hs = D.hosts()
    h = match(hs, key)
    if not h:
        raise ValueError(f"No Mac called {key} in hosts.json.")
    changes = {}
    aliases = set(h.get("aliases") or [])
    if new_id is not None and new_id.strip() != h.get("id"):
        changes["id"] = check_id(new_id, hs, skip=h)
        aliases.add(h["id"])
    if name is not None and " ".join(name.split()) != h.get("name"):
        changes["name"] = check_name(name, hs, skip=h)
        if h.get("name"):
            aliases.add(h["name"])
    if address is not None or user is not None:
        a = check_address(address) if address is not None else address_of(h)
        u = check_user(user) if user is not None else user_of(h)
        ssh = f"{u}@{a}" if u else a
        if ssh != h.get("ssh"):
            changes["ssh"] = ssh
        if h.get("ip") and a != h["ip"]:
            changes["ip"] = a
    if not changes:
        return {"ok": True, "changed": [], "host": public(h), "backup": "", "ssh_config": ""}
    h.update(changes)
    left = sorted(x for x in aliases if x.casefold() not in {h["id"].casefold(), h["name"].casefold()})
    if left:
        h["aliases"] = left
    else:
        h.pop("aliases", None)
    b = save(hs)
    if "ssh" in changes or "ip" in changes:
        try:
            os.remove(os.path.join(D.REMOTE_DIR, f"{h['id']}.down"))  # the old address was down, not the new one
        except OSError:
            pass
    return {"ok": True, "changed": sorted(changes), "host": public(h), "backup": b, "ssh_config": sync_config_quietly(hs)}


def projects_on(hid):
    """Registered projects the registry puts on that Mac (the page warns before removing it)."""
    try:
        pv = D._mod("projects_view")
        pv.D = D
        return [r["name"] for r in pv.registry(resolve_dirs=False) if r.get("host") == hid]
    except Exception:
        return []


def remove_host(key):
    _d()
    hs = D.hosts()
    h = match(hs, key)
    if not h:
        raise ValueError(f"No Mac called {key} in hosts.json.")
    rest = [x for x in hs if x is not h]
    projects = projects_on(h["id"])
    b = save(rest)
    return {"ok": True, "removed": h["id"], "name": h.get("name") or "", "backup": b,
            "ssh_config": sync_config_quietly(rest), "projects": projects}


# ---- add: the four checks ---------------------------------------------------------------------------

def _in_thread(fn, timeout, default=None):
    """fn() with a deadline (getaddrinfo on a .local name can hang for seconds)."""
    box = {}

    def run():
        try:
            box["v"] = fn()
        except Exception as e:  # noqa: BLE001
            box["e"] = e

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(timeout)
    if "e" in box:
        raise box["e"]
    return box.get("v", default)


def check_reach(address, port=22, timeout=3.0):
    """Port 22 answers? {"state", "detail", "fix", "ms", "via"}."""
    try:
        infos = _in_thread(lambda: socket.getaddrinfo(address, port, type=socket.SOCK_STREAM), timeout, [])
    except (OSError, UnicodeError):
        return {"state": "fail", "detail": f"{address} is not a name this Mac can find",
                "fix": "Check the spelling, or use the address Tailscale shows for that Mac."}
    if not infos:
        return {"state": "fail", "detail": f"Looking up {address} took too long",
                "fix": "Use the Mac's IP address instead (Tailscale shows it)."}
    why = "timeout"
    for fam, typ, proto, _, sa in infos[:3]:
        s = socket.socket(fam, typ, proto)
        s.settimeout(timeout)
        t0 = time.monotonic()
        try:
            s.connect(sa)
            ms = max(1, round((time.monotonic() - t0) * 1000))
            via = via_of(address) or via_of(sa[0])
            where = {"tailscale": " over Tailscale", "lan": " on the local network"}.get(via, "")
            return {"state": "ok", "detail": f"{ms} ms{where}", "ms": ms, "via": via}
        except ConnectionRefusedError:
            why = "refused"
        except OSError:
            pass
        finally:
            s.close()
    if why == "refused":
        return {"state": "fail", "detail": f"{address} is on but does not take SSH connections",
                "fix": "On that Mac, turn on Remote Login: System Settings > General > Sharing > Remote Login."}
    return {"state": "fail", "detail": f"No answer from {address} on port 22 within {int(timeout)} s",
            "fix": "Wake that Mac and check it is on the same Tailscale network or Wi-Fi as this one."}


def ssh_run(user, address, command, timeout=20, opts=SSH_OPTS):
    target = f"{user}@{address}" if user else address
    return subprocess.run(["ssh", *opts, target, command], capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=timeout, stdin=subprocess.DEVNULL, creationflags=P.no_window_flags())


def check_login(user, address):
    try:
        r = ssh_run(user, address, "true")
    except subprocess.TimeoutExpired:
        return {"state": "fail", "detail": "ssh did not answer within 20 s", "fix": "Try again; if it keeps happening, restart Remote Login on that Mac."}
    except FileNotFoundError:
        return {"state": "fail", "detail": "This Mac has no ssh command", "fix": "Install the Xcode Command Line Tools: xcode-select --install"}
    if r.returncode == 0:
        return {"state": "ok", "detail": f"Signed in as {user} with this Mac's SSH key"}
    err = (r.stderr or "").strip()
    if "Permission denied" in err or "Too many authentication failures" in err:
        return {"state": "need_password", "detail": f"{user} on that Mac does not know this Mac's SSH key yet",
                "fix": "Enter the password of that account once. Dispatch puts this Mac's SSH key there and does not keep the password."}
    if "Host key verification failed" in err or "IDENTIFICATION HAS CHANGED" in err:
        return {"state": "fail", "detail": "That Mac's host key is not the one this Mac saw before",
                "fix": f"If that Mac was reset or replaced, forget its old key and check again: ssh-keygen -R {address}"}
    if "Connection refused" in err:
        return {"state": "fail", "detail": "SSH connections are refused",
                "fix": "On that Mac, turn on Remote Login: System Settings > General > Sharing > Remote Login."}
    return {"state": "fail", "detail": (err.splitlines() or [f"ssh exited with {r.returncode}"])[-1][:200],
            "fix": f"Try ssh {user}@{address} in Terminal to see what it asks for."}


def public_key(create=False):
    """This Mac's public key file (made with ssh-keygen when there is none and create is set), or ""."""
    ssh_dir = os.path.join(os.path.expanduser("~"), ".ssh")
    for n in ("id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"):
        p = os.path.join(ssh_dir, n)
        if os.path.isfile(p) and os.path.isfile(p[:-4]):
            return p
    if not create:
        return ""
    os.makedirs(ssh_dir, mode=0o700, exist_ok=True)
    key = os.path.join(ssh_dir, "id_ed25519")
    r = subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", f"dispatch@{socket.gethostname()}", "-f", key],
                       capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
    return key + ".pub" if r.returncode == 0 and os.path.isfile(key + ".pub") else ""


def install_key(user, address, password):
    """Put this Mac's public key into that account's authorized_keys, signing in once with the password
    (ssh-copy-id; an SSH_ASKPASS helper hands it the password from its own environment, so it is never
    written to a file and is gone when this returns)."""
    fix = {"state": "fail", "fix": f"Run ssh-copy-id {user}@{address} in Terminal once, then check again."}
    copy_id = shutil.which("ssh-copy-id")
    pub = public_key(create=True)
    if not copy_id or not pub:
        return dict(fix, detail="Could not install the SSH key from here")
    folder = tempfile.mkdtemp(prefix="dispatch-askpass-")
    try:
        helper = os.path.join(folder, "askpass")
        with open(helper, "w", encoding="utf-8") as f:
            f.write('#!/bin/sh\nprintf \'%s\\n\' "$DISPATCH_SSH_PASSWORD"\n')
        os.chmod(helper, 0o700)
        env = dict(os.environ, SSH_ASKPASS=helper, SSH_ASKPASS_REQUIRE="force", DISPLAY=os.environ.get("DISPLAY") or ":0",
                   DISPATCH_SSH_PASSWORD=password)
        r = subprocess.run([copy_id, "-i", pub, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=5",
                            "-o", "NumberOfPasswordPrompts=1", f"{user}@{address}"],
                           env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return dict(fix, detail="Installing the SSH key did not finish")
    finally:
        env = None
        shutil.rmtree(folder, ignore_errors=True)
    if r.returncode == 0:
        return {"state": "ok", "detail": "Installed this Mac's SSH key there"}
    if "Permission denied" in (r.stderr or "") + (r.stdout or ""):
        return {"state": "need_password", "detail": "That password did not work",
                "fix": "Check the password of that account on that Mac and enter it again."}
    return dict(fix, detail=((r.stderr or r.stdout or "").strip().splitlines() or ["ssh-copy-id failed"])[-1][:200])


PROBE = r'''export PATH="$HOME/.local/bin:$HOME/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
echo "computer=$(scutil --get ComputerName 2>/dev/null)"
d="$(command -v dispatch 2>/dev/null)"
p="$d"
if [ -z "$p" ] && [ -f "__BUNDLED__" ]; then p="__BUNDLED__"; d="$p"; fi
n=0
while [ -n "$p" ] && [ -L "$p" ] && [ $n -lt 20 ]; do l="$(readlink "$p")"; case "$l" in /*) p="$l";; *) p="$(dirname "$p")/$l";; esac; n=$((n+1)); done
echo "dispatch=$d"
if [ -n "$p" ]; then echo "version=$(head -n 1 "$(dirname "$p")/VERSION" 2>/dev/null)"; fi
__ENGINES__'''


def probe_remote(user, address):
    """What that Mac says about itself over ssh: {computer, dispatch, version, and each engine Dispatch runs by its id:
    claude, codex, opencode} (strings, "" for what is missing), or {"error": ...}."""
    import engines
    script = PROBE.replace("__BUNDLED__", BUNDLED_CLI).replace(
        "__ENGINES__", "".join(f'echo "{e.id}=$(command -v {e.bin} 2>/dev/null)"\n' for e in engines.runnable()))
    try:
        r = ssh_run(user, address, "/bin/bash -c " + shlex.quote(script), timeout=25)
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"error": str(e)[:200]}
    if r.returncode != 0:
        return {"error": ((r.stderr or "").strip().splitlines() or [f"exit {r.returncode}"])[-1][:200]}
    out = {k: "" for k in ("computer", "dispatch", "version", *(e.id for e in engines.runnable()))}
    for line in (r.stdout or "").splitlines():
        k, sep, v = line.partition("=")
        if sep and k in out:
            out[k] = v.strip()
    return out


def dispatch_step(info):
    if info.get("error"):
        return {"state": "fail", "detail": "Could not ask that Mac: " + info["error"], "fix": "Check the login step, then check again."}
    if not info.get("dispatch"):
        return {"state": "fail", "detail": "Dispatch is not installed there", "fix": "Install Dispatch on that Mac, then check again."}
    v = info.get("version") or ""
    return {"state": "ok", "detail": f"Dispatch {v}" if v else "Dispatch is there", "version": v or None}


def engines_step(info):
    if info.get("error"):
        return {"state": "fail", "detail": "Could not ask that Mac: " + info["error"], "fix": "Check the login step, then check again."}
    import engines
    every = engines.runnable()
    found = [e for e in every if info.get(e.id)]
    if not found:
        return {"state": "fail", "detail": "None of %s is on that Mac" % engines.join_words((e.name for e in every), "or"),
                "fix": "Install %s there." % engines.join_words(("%s (npm install -g %s)" % (e.name, e.package) for e in every), "or")}
    return {"state": "ok", "detail": " and ".join(e.name for e in found), "engines": [e.id for e in found]}


def write_new(address, user, name, hosts):
    """Append a Mac to hosts.json (id = slug of its name) and give it an SSH alias. Returns the entry."""
    n = check_name(name, hosts)
    entry = {"id": unique_id(slug(n), hosts), "name": n, "ssh": f"{user}@{address}", "dispatch": "$HOME/.local/bin/dispatch"}
    hs = list(hosts) + [entry]
    b = save(hs)
    knowledge_from(entry)
    return entry, b, sync_config_quietly(hs)


def knowledge_from(entry):
    """A new Mac is also a source of what the user knows: pull from it now, in the background (the
    resident chatd keeps doing it every 5 minutes)."""
    try:
        import knowledge_sync
        if knowledge_sync.autocommit_on():
            knowledge_sync._spawn(["knowledge", "sync", "--host", entry["id"]])
    except Exception:
        pass


def tailscale_name(address):
    """What Tailscale calls the Mac at this address (its own name), or ""."""
    st = tailscale_status(timeout=3) or {}
    for p in (st.get("Peer") or {}).values():
        ips = p.get("TailscaleIPs") or []
        dns = (p.get("DNSName") or "").rstrip(".")
        if address in ips or address.rstrip(".").lower() in (dns.lower(), dns.split(".")[0].lower()):
            return p.get("HostName") or ""
    return ""


def add(address, user, name="", check=False, password=None, emit=None):
    """`hosts add`: validate, run the checks when asked (each step reported through emit as it starts and
    as it ends), write on success. Returns the final line (also emitted)."""
    _d()
    emit = emit or (lambda d: None)
    hs = D.hosts()
    done = {"done": True, "ok": False, "id": None, "suggested_name": None, "written": False}

    def finish(**kw):
        done.update(kw)
        emit(done)
        return done

    try:
        if "@" in (address or "") and not user:
            user, address = split_ssh(address)
        address, user = check_address(address), check_user(user)
        if name:
            name = " ".join(name.split())
    except ValueError as e:
        return finish(message=str(e))
    known = match(hs, address) or next((h for h in hs if h.get("ssh") == f"{user}@{address}"), None)
    taken = [n for h in hs for n in names_of(h)] + list(local_names())
    if known:
        done.update(known=True, id=known["id"], name=known.get("name") or "")
    if not check:
        if known:
            return finish(message=f"{address} is already in hosts.json as {known.get('name')}.")
        if not name:
            return finish(message="Give the Mac a name (--name).")
        try:
            entry, b, cfg = write_new(address, user, name, hs)
        except ValueError as e:
            return finish(message=str(e))
        return finish(ok=True, written=True, id=entry["id"], name=entry["name"], ssh_alias=ssh_alias(entry), backup=b, ssh_config=cfg,
                      suggested_name=entry["name"])

    results, info = {}, {}

    def step(key, fn):
        emit({"step": key, "state": "running"})
        r = fn()
        emit({"step": key, **r})
        results[key] = r
        return r["state"] == "ok"

    def login():
        r = check_login(user, address)
        if r["state"] == "need_password" and password:
            emit({"step": "login", "state": "running", "detail": "Installing this Mac's SSH key there"})
            r = install_key(user, address, password)
            if r["state"] == "ok":
                r = check_login(user, address)
                if r["state"] == "need_password":  # the key went in but is not accepted (a server that only takes passwords)
                    r = {"state": "fail", "detail": "That Mac still asks for a password",
                         "fix": f"Check that Remote Login accepts keys, or run ssh-copy-id {user}@{address} in Terminal once."}
        return r

    def dispatch_there():
        info.update(probe_remote(user, address))  # one ssh round trip answers this step and the next
        return dispatch_step(info)

    ok = step("reach", lambda: check_reach(address)) and step("login", login)
    if ok:
        ok = step("dispatch", dispatch_there)
        ok = step("engines", lambda: engines_step(info)) and ok
    failed = next((k for k in STEPS if k in results and results[k]["state"] != "ok"), None) or next((k for k in STEPS if k not in results), None)
    own = info.get("computer") or ""
    suggested = (known.get("name") or known["id"]) if known else short_name(own or tailscale_name(address) or address, taken)
    extra = {"suggested_name": suggested, "computer_name": own, "failed": failed if not ok else None,
             "need_password": (results.get("login") or {}).get("state") == "need_password"}
    if not ok:
        return finish(**extra)
    if known or not name:
        return finish(ok=True, written=False, **extra)
    try:
        entry, b, cfg = write_new(address, user, name, hs)
    except ValueError as e:
        return finish(message=str(e), **extra)
    return finish(ok=True, written=True, id=entry["id"], name=entry["name"], ssh_alias=ssh_alias(entry), backup=b, ssh_config=cfg, **extra)


# ---- discover ---------------------------------------------------------------------------------------

def tailscale_cmd():
    for c in ("tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"):
        p = shutil.which(c) if "/" not in c else (c if os.path.isfile(c) else None)
        if p:
            return p
    return ""


def tailscale_status(timeout=4):
    cmd = tailscale_cmd()
    if not cmd:
        return None
    try:
        r = subprocess.run([cmd, "status", "--json"], capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=timeout, stdin=subprocess.DEVNULL)
        return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip().startswith("{") else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def _epoch(iso):
    if not iso or iso.startswith("0001-"):
        return None
    try:
        return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def tailscale_peers(status):
    """Macs (and Windows PCs, not supported yet) on the tailnet: [{name, hostname, address, online, os,
    supported, last_seen}]."""
    out = []
    for p in ((status or {}).get("Peer") or {}).values():
        os_name = p.get("OS") or ""
        if os_name not in ("macOS", "windows"):
            continue
        v4 = next((ip for ip in p.get("TailscaleIPs") or [] if "." in ip), "")
        if not v4:
            continue
        out.append({"name": p.get("HostName") or "", "hostname": (p.get("DNSName") or "").split(".")[0], "address": v4,
                    "via": "tailscale", "online": bool(p.get("Online")), "os": os_name, "supported": os_name == "macOS",
                    "last_seen": _epoch(p.get("LastSeen"))})
    return out


def bonjour_ssh(browse=1.2, resolve=0.8):
    """SSH services on the local network (dns-sd, best effort): [{"name", "address"}] with the .local
    host name each one can be reached at; None when dns-sd is not there."""
    exe = shutil.which("dns-sd")
    if not exe:
        return None
    try:
        p = subprocess.Popen([exe, "-B", "_ssh._tcp", "local."], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    except OSError:
        return None
    time.sleep(browse)
    p.terminate()
    try:
        raw = p.communicate(timeout=2)[0]
    except subprocess.TimeoutExpired:
        p.kill()
        raw = p.communicate()[0]
    names = []
    for line in raw.decode("utf-8", "replace").splitlines():
        parts = line.split(None, 6)
        if len(parts) == 7 and parts[1] == "Add" and parts[5].startswith("_ssh._tcp") and parts[6].strip() not in names:
            names.append(parts[6].strip())
    procs = []
    for n in names:
        try:
            procs.append((n, subprocess.Popen([exe, "-L", n, "_ssh._tcp", "local."], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)))
        except OSError:
            pass
    if procs:
        time.sleep(resolve)
    out = []
    for n, q in procs:
        q.terminate()
        try:
            text = q.communicate(timeout=2)[0].decode("utf-8", "replace")
        except subprocess.TimeoutExpired:
            q.kill()
            text = q.communicate()[0].decode("utf-8", "replace")
        m = re.search(r"can be reached at (\S+?)\.?:(\d+)", text)
        out.append({"name": n, "address": m.group(1).rstrip(".") if m else "", "port": int(m.group(2)) if m else 22})
    return out


def local_host_label():
    try:
        r = subprocess.run(["/usr/sbin/scutil", "--get", "LocalHostName"], capture_output=True, text=True, timeout=3)
        return r.stdout.strip().lower() if r.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def discover(status=None, bonjour=None, hosts=None, me=None):
    """Macs this one could add. The arguments stand in for the sources (tests); each source is best effort."""
    _d()
    hs = D.hosts() if hosts is None else hosts
    status = tailscale_status() if status is None else status
    if bonjour is None:
        bonjour = bonjour_ssh() or []
    mine = local_names() if me is None else {n.casefold() for n in me}
    self_ips = set(((status or {}).get("Self") or {}).get("TailscaleIPs") or [])
    self_host = local_host_label() if me is None else ""
    rows = [r for r in tailscale_peers(status) if r["address"] not in self_ips and r["name"].casefold() not in mine]
    by_name = {r["name"].casefold(): r for r in rows if r["name"]}
    for b in bonjour:
        host = (b.get("address") or "").lower()
        if b["name"].casefold() in mine or (self_host and host.split(".")[0] == self_host):
            continue
        hit = by_name.get(b["name"].casefold())
        if hit:
            hit["lan_address"] = b.get("address") or ""
            continue
        if not b.get("address"):
            continue
        row = {"name": b["name"], "hostname": b["address"].split(".")[0], "address": b["address"], "via": "lan", "online": True,
               "os": "", "supported": True, "last_seen": None}
        rows.append(row)
        by_name[b["name"].casefold()] = row
    taken = [n for h in hs for n in names_of(h)] + list(mine)
    for r in rows:
        h = next((m for m in (match(hs, r["address"]), match(hs, r.get("lan_address")), match(hs, r["name"]), match(hs, r["hostname"])) if m), None)
        r["known"] = bool(h)
        if h:
            r["id"], r["known_name"] = h["id"], h.get("name") or ""
            r["suggested_name"] = h.get("name") or ""
        else:
            r["suggested_name"] = short_name(r["name"] or r["hostname"], taken)
    rows.sort(key=lambda r: (r["known"], not r["supported"], not r["online"], (r["name"] or r["hostname"]).casefold()))
    return rows


# ---- CLI ------------------------------------------------------------------------------------------

def _line(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def _say_step(d):
    if d.get("done"):
        print(("Added " + d.get("name", "") if d.get("written") else "Checks passed" if d.get("ok") else "Not added")
              + (f": {d['message']}" if d.get("message") else "") + (f"  (suggested name: {d['suggested_name']})" if d.get("suggested_name") else ""), flush=True)
    elif d.get("state") != "running":
        print(f"{d['step']:<9} {d['state']:<14} {d.get('detail', '')}" + (f"\n          {d['fix']}" if d.get("fix") and d["state"] != "ok" else ""), flush=True)


def command(a, dispatch_module=None):
    global D
    if dispatch_module is not None:
        D = dispatch_module
    _d()
    op = a.op
    args = list(getattr(a, "args", None) or [])
    as_json = bool(getattr(a, "json", False))
    try:
        if op == "add":
            if len(args) != 1:
                raise ValueError("usage: dispatch hosts add <address> --user <name> [--name <name>] [--check] [--password-stdin] --json")
            password = None
            if getattr(a, "password_stdin", False):
                password = (sys.stdin.readline() or "").rstrip("\r\n") or None
            res = add(args[0], getattr(a, "user", None) or "", getattr(a, "name", None) or "", check=bool(getattr(a, "check", False)),
                      password=password, emit=_line if as_json else _say_step)
            password = None
            return 0 if res.get("ok") else 1
        if op == "discover":
            res = discover()
        elif op == "set":
            if len(args) != 1:
                raise ValueError("usage: dispatch hosts set <id> [--name N] [--address A] [--user U] [--id I] --json")
            res = set_host(args[0], name=getattr(a, "name", None), address=getattr(a, "address", None), user=getattr(a, "user", None),
                           new_id=getattr(a, "new_id", None))
        elif op == "remove":
            if len(args) != 1:
                raise ValueError("usage: dispatch hosts remove <id> --json")
            res = remove_host(args[0])
        else:
            raise ValueError(f"unknown op {op}")
    except ValueError as e:
        if as_json:
            _line({"ok": False, "message": str(e)})
        else:
            print(str(e), file=sys.stderr)
        return 1
    if as_json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    elif op == "discover":
        for r in res:
            mark = f"known as {r.get('known_name')}" if r["known"] else ("not supported yet" if not r["supported"] else f"suggested name {r['suggested_name']}")
            print(f"{r['name'] or r['hostname']:<24} {r['address']:<28} {r['via']:<9} {'online' if r['online'] else 'offline':<7}  {mark}")
        if not res:
            print("No other Mac found on Tailscale or on this network.")
    else:
        print(json.dumps(res, ensure_ascii=False))
    return 0
