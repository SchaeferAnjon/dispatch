# -*- coding: utf-8 -*-
"""`dispatch mobile`: the phone's way in to this Mac (protocol: docs/mobile-protocol.md).

    dispatch mobile pair [--json] [--svg FILE]   one-time pairing code: a QR (terminal) plus six digits
                         [--inline] [--replace ID]  --json: the QR as SVG text (svg_text; the title bar's phone
                                                 popover); a pending code this one replaces
    dispatch mobile status [--json]              the service, its addresses, the paired phones; when it is on
                                                 but not running, why (problem: reason, message, fix)
    dispatch mobile on | off [--json]            phone access: off on a new Mac, on as soon as you pair a phone
    dispatch mobile devices [--json]             paired phones
    dispatch mobile revoke <pair or device id>   forget a phone (it can no longer connect)
    dispatch mobile serve [--port N]             run the service in the foreground (chatd runs it otherwise)
    dispatch mobile helper-keys --json           the pairs' secrets, for the Mac helper that carries the
                                                 remote channels (only for this user; see the protocol)
    dispatch mobile config [key] [value]         assistant_agent, port, relay_url, cloud_container
    dispatch mobile notify [test] [--kind K]     what each phone is told (finished, stopped, waiting for
                                                 you) and how; test: a test notice to every phone now

Phone access is off until the person pairs a phone (task-lj06.19, the person's choice of 2026-10-07: "turn on
only when pairing"); a Mac that already had a phone paired keeps it on. One small resident service, hosted by chatd
(a thread next to its door) while phone access is on, so a request never starts a process: the API answers from the same functions the CLI prints, called in
process (`Cli`), and talks to sessions through chatd's door like `dispatch agent` does.

Two listeners: HTTPS on every interface (the phone on the same network; the certificate is
self-signed and pinned by the fingerprint in the pairing code) and plain HTTP on 127.0.0.1 only (the
Mac helper that forwards requests the phone sent over the relay or iCloud). Every request is signed
with a key derived from the pairing secret (HMAC-SHA256 over method, path, time and body hash); the
secret itself never travels after the QR code. The service advertises itself on the network
(Bonjour `_dispatch._tcp`, TXT mac=<id>) so the phone finds it again after the address changes.
"""
import base64
import hashlib
import hmac
import io
import json
import os
import secrets
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

PROTOCOL = 1
DEFAULT_PORT = 7788
PAIR_TTL = 600            # an unused pairing code is good for ten minutes
CODE_TRIES = 5            # wrong six-digit codes before a pairing code stops taking them
SKEW = 300                # seconds a signed request may be off the Mac's clock
SALT = b"dispatch-link-v1"
KEY_LAN = "dispatch/lan-auth"      # signs requests to this service (LAN and loopback)
KEY_RELAY = "dispatch/relay-auth"  # proves the pair to the relay (the relay learns this key, nothing else)
KEY_BOX = "dispatch/box"           # end-to-end encryption of remote envelopes (the phone and the Mac helper)
SERVICE_TYPE = "_dispatch._tcp"


def dispatch_dir():
    return os.environ.get("DISPATCH_DIR") or os.path.join(os.path.expanduser("~"), "tasks", ".dispatch")


def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def unb64url(s):
    s = str(s or "")
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# ---- keys and signatures ----------------------------------------------------------------------

def hkdf(secret, info, length=32, salt=SALT):
    """HKDF-SHA256 (RFC 5869): the per-purpose keys from the pairing secret (CryptoKit's HKDF on the phone)."""
    prk = hmac.new(salt, secret, hashlib.sha256).digest()
    out, t, i = b"", b"", 1
    while len(out) < length:
        t = hmac.new(prk, t + (info if isinstance(info, bytes) else info.encode("utf-8")) + bytes([i]), hashlib.sha256).digest()
        out += t
        i += 1
    return out[:length]


def canonical(method, path, ts, body, nonce=""):
    return "\n".join([method.upper(), path, str(int(ts)), nonce, hashlib.sha256(body or b"").hexdigest()]).encode("utf-8")


def sign(key, method, path, ts, body=b"", nonce=""):
    return b64url(hmac.new(key, canonical(method, path, ts, body, nonce), hashlib.sha256).digest())


def verify(key, method, path, ts, body, sig, nonce=""):
    return hmac.compare_digest(sign(key, method, path, ts, body, nonce), str(sig or ""))


# ---- state: pairs, devices, settings ---------------------------------------------------------

class Store:
    """<DISPATCH_DIR>/mobile/state.json (0600): this Mac's id, the port, settings and the pairs.

    pair: {id, secret (b64url, 32 bytes), code (six digits while pending), code_tries, created,
           expires (pending only), status: pending | paired, device, device_name, paired_at, last_seen}"""

    def __init__(self, d=None):
        self.dir = os.path.join(d or dispatch_dir(), "mobile")
        self.path = os.path.join(self.dir, "state.json")
        self.lock = threading.RLock()

    def load(self):
        with self.lock:
            try:
                with open(self.path, encoding="utf-8") as f:
                    s = json.load(f)
            except (OSError, ValueError):
                s = {}
            if not isinstance(s, dict):
                s = {}
            changed = False
            if not s.get("mac"):
                s["mac"] = "mac-" + secrets.token_hex(8)
                changed = True
            s.setdefault("port", DEFAULT_PORT)
            s.setdefault("pairs", {})
            s.setdefault("settings", {})
            if changed:
                self.save(s)
            return s

    def save(self, s):
        with self.lock:
            os.makedirs(self.dir, mode=0o700, exist_ok=True)
            tmp = f"{self.path}.{os.getpid()}.tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(s, f, indent=1, ensure_ascii=False)
            os.replace(tmp, self.path)

    def new_pair(self, now=None, replace=None):
        """A fresh pending pair. `replace`: a pending pair this one takes the place of (the popover's "New
        code"); a pair that is already paired is never touched."""
        now = now or time.time()
        with self.lock:
            s = self.load()
            self.expire(s, now)
            old = s["pairs"].get(replace or "")
            if old and old.get("status") == "pending":
                del s["pairs"][replace]
            pid = "p-" + secrets.token_hex(6)
            code = f"{secrets.randbelow(1_000_000):06d}"
            s["pairs"][pid] = {"id": pid, "secret": b64url(secrets.token_bytes(32)), "code": code, "code_tries": 0,
                               "created": now, "expires": now + PAIR_TTL, "status": "pending"}
            self.save(s)
            return s["pairs"][pid], s

    @staticmethod
    def expire(s, now):
        for pid in [p for p, v in s["pairs"].items() if v.get("status") == "pending" and v.get("expires", 0) < now]:
            del s["pairs"][pid]

    def get(self, pid):
        return self.load()["pairs"].get(pid)

    def bind(self, pid, device, name, now=None):
        """First signed request of a pending pair: the phone that sent it owns the pair from now on."""
        now = now or time.time()
        with self.lock:
            s = self.load()
            p = s["pairs"].get(pid)
            if not p:
                return None
            if p.get("status") == "pending":
                p.update(status="paired", device=device, device_name=name or "iPhone", paired_at=now)
                p.pop("code", None)
                p.pop("expires", None)
                p.pop("code_tries", None)
            if now - p.get("last_seen", 0) > 30:
                p["last_seen"] = now
                self.save(s)
            elif p.get("paired_at") == now:
                self.save(s)
            return p

    def by_code(self, code, now=None):
        """The pending pair this six-digit code belongs to, or None (a wrong code counts against all of them)."""
        now = now or time.time()
        with self.lock:
            s = self.load()
            self.expire(s, now)
            hit = None
            for p in s["pairs"].values():
                if p.get("status") != "pending" or not p.get("code"):
                    continue
                if hmac.compare_digest(p["code"], str(code or "").replace(" ", "")):
                    hit = p
                    p.pop("code", None)  # one use
                else:
                    p["code_tries"] = p.get("code_tries", 0) + 1
                    if p["code_tries"] >= CODE_TRIES:
                        p.pop("code", None)
            self.save(s)
            return hit, s

    def revoke(self, ident):
        with self.lock:
            s = self.load()
            gone = [pid for pid, p in s["pairs"].items() if ident in (pid, p.get("device"))]
            for pid in gone:
                del s["pairs"][pid]
            self.save(s)
            return gone

    def setting(self, key, default=None):
        return self.load()["settings"].get(key, default)


def access_on(state, now=None):
    """Phone access: what the person set (`on` when they pair a phone, `off` when they turn it off); without that, on
    only when a phone is already paired (a Mac that had a phone keeps it after the update; a new Mac starts off).
    On also needs a phone to talk to: a paired one, a pairing code still waiting to be used, or a pairing started in
    the last ten minutes (the code comes once the service answers). Nobody paired by then: off again, "on only while
    pairing", the person's choice (10-09: a Mac said "Phone access is on" with no phone, from a Pair a phone tried
    before the app existed)."""
    settings = state.get("settings") or {}
    v = settings.get("access")
    pairs = (state.get("pairs") or {}).values()
    paired = any(p.get("status") == "paired" for p in pairs)
    if v == "off":
        return False
    if v != "on" or paired:
        return paired
    now = time.time() if now is None else now
    return now - (settings.get("access_since") or 0) < PAIR_TTL or any(
        p.get("status") == "pending" and p.get("expires", 0) > now for p in pairs)


def set_access(store, on):
    with store.lock:
        s = store.load()
        s["settings"]["access"] = "on" if on else "off"
        if on:
            s["settings"]["access_since"] = time.time()  # the pairing window access_on keeps it on for
        else:
            s["settings"].pop("access_since", None)
        store.save(s)
        return s


def service_file(d=None):
    return os.path.join(d or dispatch_dir(), "mobile", "service.json")


def write_service(d, rec):
    """What the chatd that hosts the service last found: running, failed (and why) or off."""
    path = service_file(d)
    try:
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({**rec, "pid": os.getpid(), "at": time.time()}, f)
        os.replace(tmp, path)
    except OSError:
        pass


def read_service(d=None):
    try:
        with open(service_file(d), encoding="utf-8") as f:
            r = json.load(f)
        return r if isinstance(r, dict) else {}
    except (OSError, ValueError):
        return {}


def _alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def port_holder(port, run=subprocess.run):
    """The program listening on this port ("Python", "node"), or ''."""
    try:
        text = run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fpc"], capture_output=True, text=True, timeout=5).stdout or ""
    except (OSError, subprocess.TimeoutExpired):
        return ""
    for line in text.splitlines():
        if line.startswith("c"):
            return line[1:].strip()
    return ""


def why_not_started(err, port):
    """A failure to start, as the person reads it: (reason, message, fix)."""
    import errno
    if isinstance(err, OSError) and err.errno in (errno.EADDRINUSE, 48, 98):
        who = port_holder(port) or port_holder(port + 1)
        return ("port_in_use",
                f"Another program{f' ({who})' if who else ''} is already using port {port}, so your phone cannot reach Dispatch on this Mac.",
                "Quit that program and try again, or let Dispatch use another port.")
    if isinstance(err, OSError) and err.errno in (errno.EACCES, errno.EPERM):
        return ("not_allowed", f"This Mac did not let Dispatch use port {port}.", "Let Dispatch use another port.")
    return ("failed", f"Dispatch could not start phone access: {err}", "Try again. If it keeps failing, restart Dispatch.")


def problem(state, d=None, running=None):
    """Why phone access is on but the phone cannot reach this Mac (not running, or a VPN takes the local network), or
    None."""
    if not access_on(state):
        return None
    if running is None:
        running = service_up(state["port"], state.get("mac"))
    if running:
        return reach_problem(state["port"])
    rec = read_service(d)
    if rec.get("state") == "failed" and _alive(rec.get("pid")):
        return {"reason": rec.get("reason") or "failed", "port": rec.get("port") or state["port"],
                "message": rec.get("message") or "", "fix": rec.get("fix") or ""}
    if not chatd_running(d):
        return {"reason": "no_background", "port": state["port"],
                "message": "Dispatch's background service is not running, so nothing answers your phone.",
                "fix": "Turn phone access on again; Dispatch starts its background service."}
    return {"reason": "starting", "port": state["port"], "message": "Phone access is starting.", "fix": ""}


# ---- where the phone finds this Mac -----------------------------------------------------------

TUNNELS = ("utun", "ipsec", "ppp", "gif", "stf", "tun", "tap")  # a VPN's interfaces: no phone on the Wi-Fi is behind them


def network_rows(run=subprocess.run):
    """This Mac's IPv4 addresses as [(interface, address, prefix length)]: not loopback, not link-local, not Tailscale's
    100.64/10."""
    rows, name = [], ""
    try:
        text = run(["/sbin/ifconfig"], capture_output=True, text=True, timeout=5).stdout or ""
    except (OSError, subprocess.TimeoutExpired):
        return rows
    for line in text.splitlines():
        if line and not line[0].isspace():
            name = line.split(":", 1)[0]
            continue
        bits = line.split()
        if len(bits) < 2 or bits[0] != "inet" or bits[1].startswith(("127.", "169.254.")):
            continue
        ip = bits[1]
        a, b = (int(x) for x in ip.split(".")[:2])
        if a == 100 and 64 <= b < 128:
            continue
        mask = bits[bits.index("netmask") + 1] if "netmask" in bits[:-1] else "0xffffffff"
        rows.append((name, ip, bin(int(mask, 16)).count("1")))
    return rows


def lan_addresses(rows=None):
    """The addresses a phone on the same network can try: the network_rows not on a VPN's tunnel (the address a VPN
    gave this Mac reaches nothing on the Wi-Fi; 10-10 a pairing code carried Cisco Secure Client's 147.142.8.34)."""
    return [ip for name, ip, _ in (network_rows() if rows is None else rows) if not name.startswith(TUNNELS)]


def route_interface(ip, run=subprocess.run):
    """The interface this Mac sends packets for `ip` out of ("en0", "utun13"), or ''."""
    try:
        text = run(["/sbin/route", "-n", "get", ip], capture_output=True, text=True, timeout=5).stdout or ""
    except (OSError, subprocess.TimeoutExpired):
        return ""
    for line in text.splitlines():
        if line.strip().startswith("interface:"):
            return line.split(":", 1)[1].strip()
    return ""


def lan_capture(rows=None, route=route_interface):
    """The VPN tunnel ("utun13") that takes this Mac's local networks, or '': for every local network, a neighbour's
    address (the last one before the broadcast) is routed into a tunnel instead of out of the network's own interface,
    so whatever a phone on the same Wi-Fi sends gets no answer. Cisco Secure Client with Allow local (LAN) access off
    does this, and also drops the packets a program sends out of en0 itself (10-10, a phone could not pair)."""
    import ipaddress
    lans = [r for r in (network_rows() if rows is None else rows) if not r[0].startswith(TUNNELS)]
    tunnels = set()
    for name, ip, bits in lans:
        if bits >= 31:
            return ""
        net = ipaddress.ip_network(f"{ip}/{bits}", strict=False)
        probe = net.broadcast_address - 1
        if str(probe) == ip:
            probe -= 1
        via = route(str(probe))
        if not via.startswith(TUNNELS):
            return ""
        tunnels.add(via)
    return sorted(tunnels)[0] if tunnels else ""


VPN_APPS = {"vpnagentd": "Cisco Secure Client", "PanGPS": "GlobalProtect"}


def vpn_name(run=subprocess.run):
    """The VPN app that runs on this Mac, by its agent's process, or ''."""
    try:
        text = run(["ps", "-A", "-o", "comm="], capture_output=True, text=True, timeout=5).stdout or ""
    except (OSError, subprocess.TimeoutExpired):
        return ""
    names = {os.path.basename(line.strip()) for line in text.splitlines()}
    return next((app for proc, app in VPN_APPS.items() if proc in names), "")


def reach_problem(port):
    """The service runs, but a phone on the same Wi-Fi cannot reach it: why and what to do, or None."""
    via = lan_capture()
    if not via:
        return None
    app = vpn_name()
    fix = ("Turn on Allow local (LAN) access in Cisco Secure Client's Preferences and reconnect, or disconnect the VPN."
           if app == "Cisco Secure Client" else f"Allow local network access in {app or 'the VPN'}'s settings, or disconnect it.")
    return {"reason": "vpn_blocks_lan", "port": port, "tunnel": via,
            "message": f"{app or 'A VPN'} routes this Mac's local network through the VPN, so your iPhone on the same Wi-Fi cannot reach it.",
            "fix": fix}


def tailscale_address():
    """The Tailscale address when Tailscale runs (an optional direct address, never required)."""
    for exe in ("tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"):
        try:
            r = subprocess.run([exe, "ip", "-4"], capture_output=True, text=True, timeout=3)
            ip = r.stdout.strip().splitlines()[0] if r.returncode == 0 and r.stdout.strip() else ""
            if ip:
                return ip
        except Exception:
            continue
    return ""


def mac_name():
    try:
        import dispatch as D
        n = D.local_host_name()
        if n:
            return n
    except Exception:
        pass
    try:
        r = subprocess.run(["scutil", "--get", "ComputerName"], capture_output=True, text=True, timeout=3)
        return r.stdout.strip() or socket.gethostname()
    except Exception:
        return socket.gethostname()


def local_host():
    """`<LocalHostName>.local`, the name the phone resolves on the network (mDNS)."""
    try:
        r = subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True, text=True, timeout=3)
        return (r.stdout.strip() or socket.gethostname().split(".")[0]) + ".local"
    except Exception:
        return socket.gethostname()


def mac_model():
    try:
        r = subprocess.run(["sysctl", "-n", "hw.model"], capture_output=True, text=True, timeout=3)
        m = r.stdout.strip()
        return "Mac mini" if m.startswith("Macmini") else "MacBook" if "Book" in m else "Mac"
    except Exception:
        return "Mac"


# ---- TLS ------------------------------------------------------------------------------------

def ensure_cert(d=None):
    """A self-signed certificate for the LAN listener (EC P-256, ten years), made once with openssl.
    Returns (certfile, keyfile, fingerprint: sha256 hex of the DER certificate)."""
    base = os.path.join(d or dispatch_dir(), "mobile")
    os.makedirs(base, mode=0o700, exist_ok=True)
    cert, key = os.path.join(base, "cert.pem"), os.path.join(base, "key.pem")
    if not (os.path.exists(cert) and os.path.exists(key)):
        subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
                        "-days", "3650", "-subj", "/CN=Dispatch on this Mac", "-keyout", key, "-out", cert],
                       check=True, capture_output=True, timeout=30)
        os.chmod(key, 0o600)
    with open(cert, encoding="ascii") as f:
        der = ssl.PEM_cert_to_DER_cert(f.read())
    return cert, key, hashlib.sha256(der).hexdigest()


# ---- the pairing code -------------------------------------------------------------------------

def pairing_payload(state, pair, fingerprint, lan=None, direct=None):
    """What the QR code carries (docs/mobile-protocol.md, "Pairing payload"). Everything the phone
    needs to reach this Mac at home (addresses, port, certificate) and away (the pair id and secret
    the relay and iCloud channels use), so pairing once is enough."""
    s = state["settings"]
    p = {"v": PROTOCOL, "mac": state["mac"], "name": mac_name(), "model": mac_model(), "pair": pair["id"], "secret": pair["secret"],
         "port": state["port"], "lan": lan if lan is not None else lan_addresses(), "fp": fingerprint}
    if direct:
        p["direct"] = direct
    if s.get("relay_url"):
        p["relay"] = s["relay_url"]
    if s.get("cloud_container"):
        p["cloud"] = s["cloud_container"]
    return p


def pairing_url(payload):
    return "dispatch://pair?d=" + b64url(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def parse_pairing_url(url):
    q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    return json.loads(unb64url(q["d"][0]))


# ---- the CLI, called in process ------------------------------------------------------------------

class _ThreadOut(io.TextIOBase):
    """sys.stdout / sys.stderr stand-in: a thread that set a buffer writes into it, every other thread
    (chatd's event writer) goes straight to the real stream."""

    def __init__(self, real):
        self.real = real
        self.local = threading.local()

    def write(self, s):
        buf = getattr(self.local, "buf", None)
        if buf is not None:
            return buf.write(s)
        return self.real.write(s)

    def flush(self):
        if getattr(self.local, "buf", None) is None:
            try:
                self.real.flush()
            except Exception:
                pass

    def __getattr__(self, name):
        return getattr(self.real, name)


class Cli:
    """`dispatch <args>` inside this process: the same parser and the same functions, the printed
    output captured for this thread only. One at a time (the CLI keeps module state)."""
    lock = threading.RLock()
    _installed = False

    @classmethod
    def install(cls):
        if not cls._installed:
            sys.stdout = _ThreadOut(sys.stdout)
            sys.stderr = _ThreadOut(sys.stderr)
            cls._installed = True

    @classmethod
    def module(cls):
        import dispatch
        return dispatch

    @classmethod
    def run(cls, argv, timeout=None):
        cls.install()
        D = cls.module()
        out, err = io.StringIO(), io.StringIO()
        code = 0
        with cls.lock:
            old_argv = sys.argv
            sys.argv = ["dispatch", *argv]
            sys.stdout.local.buf, sys.stderr.local.buf = out, err
            try:
                D._main()
            except SystemExit as e:
                code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
            except Exception as e:  # a CLI bug must not take the service down
                code = 1
                err.write(f"{type(e).__name__}: {e}")
            finally:
                sys.stdout.local.buf = sys.stderr.local.buf = None
                sys.argv = old_argv
        return code, out.getvalue(), err.getvalue()

    @classmethod
    def json(cls, argv, default=None):
        code, out, err = cls.run(argv)
        text = out.strip()
        if not text:
            if default is not None:
                return default
            raise RuntimeError((err or f"dispatch {' '.join(argv)} printed nothing").strip()[:400])
        i = min([x for x in (text.find("{"), text.find("[")) if x >= 0] or [0])
        try:
            return json.loads(text[i:])
        except ValueError:
            if default is not None:
                return default
            raise RuntimeError(text[:400])


# ---- the Bonjour record ---------------------------------------------------------------------------

# Runs dns-sd and waits on stdin, a pipe only the service holds: end of input (the service stopped, quit or
# was killed) or a signal ends dns-sd too.
ADVERT_SH = ('trap \'kill "$c" 2>/dev/null\' EXIT; trap \'exit 0\' HUP INT TERM; '
             '"$@" </dev/null & c=$!; read _ ; exit 0')


def stop_advert(proc, wait=3):
    """End the record's process (the shell above, or a bare dns-sd from before): close its pipe, then SIGTERM."""
    if proc is None:
        return
    try:
        if proc.stdin:
            proc.stdin.close()
    except OSError:
        pass
    try:
        proc.wait(wait)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        proc.terminate()
        proc.wait(wait)
    except (OSError, subprocess.TimeoutExpired):
        pass


def stale_adverts(mac, rows):
    """The `dns-sd -R … _dispatch._tcp` processes of this user to clear before advertising: [pid]. Any whose
    parent is gone (re-parented to launchd: nothing will ever end it), and any other one for this Mac's id
    (a second record of the same Mac). `rows`: [(pid, ppid, command)]."""
    out = []
    for pid, ppid, cmd in rows:
        bits = cmd.split()
        if len(bits) < 2 or os.path.basename(bits[0]) != "dns-sd" or bits[1] != "-R" or SERVICE_TYPE not in bits:
            continue
        if ppid == 1 or (mac and ("mac=%s" % mac) in bits):
            out.append(pid)
    return out


def _my_processes():
    try:
        r = subprocess.run(["ps", "-U", str(os.getuid()), "-ww", "-o", "pid=,ppid=,command="], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return []
    rows = []
    for line in r.stdout.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            rows.append((int(parts[0]), int(parts[1]), parts[2]))
    return rows


def clear_stale_adverts(mac, rows=None, kill=os.kill):
    """SIGTERM the records stale_adverts finds; returns their pids."""
    pids = stale_adverts(mac, _my_processes() if rows is None else rows)
    for pid in pids:
        try:
            kill(pid, signal.SIGTERM)
        except OSError:
            pass
    return pids


# ---- the service ----------------------------------------------------------------------------------

class Service:
    """The HTTPS listener (LAN), the loopback listener (the Mac helper), the event hub and the
    Bonjour record. `start()` returns once both listeners are up."""

    def __init__(self, d=None, port=None, host="0.0.0.0", bonjour=True):
        self.d = d or dispatch_dir()
        self.store = Store(self.d)
        state = self.store.load()
        self.port = port or state["port"]
        self.host = host
        self.bonjour = bonjour
        self.servers = []
        self.dns_sd = None
        self.replay = {}
        self.replay_lock = threading.Lock()
        import mobile_api
        self.hub = mobile_api.EventHub(self.d)
        self.api = mobile_api.Api(self)
        import mobile_push
        self.notifier = mobile_push.Notifier(self)

    def _listen(self):
        """The LAN listener on the port and the loopback one on the port after it. Port 0 in the settings: the
        first free pair, taken by binding it (a port looked up as free and bound later can be taken by another
        process in between; two test suites on one Mac did), and written back so the pairing code shows it."""
        if self.port:
            lan = _Server((self.host, self.port), _Handler, self)
            try:
                return lan, _Server(("127.0.0.1", self.port + 1), _Handler, self)
            except OSError:
                lan.server_close()
                raise
        for _ in range(50):
            lan = _Server((self.host, 0), _Handler, self)
            port = lan.server_address[1]
            try:
                loop = _Server(("127.0.0.1", port + 1), _Handler, self)
            except OSError:  # the port after it is someone else's: let this one go and take another pair
                lan.server_close()
                continue
            self.port = port
            state = self.store.load()
            state["port"] = port
            self.store.save(state)
            return lan, loop
        raise OSError("no two free ports next to each other for the phone service")

    def start(self):
        cert, key, self.fingerprint = ensure_cert(self.d)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(cert, key)
        lan, loop = self._listen()
        lan.socket = ctx.wrap_socket(lan.socket, server_side=True, do_handshake_on_connect=False)
        self.servers = [lan, loop]
        for s in self.servers:
            threading.Thread(target=s.serve_forever, kwargs={"poll_interval": 0.5}, daemon=True).start()
        self.hub.start()
        self.notifier.start()
        if self.bonjour:
            self.advertise()
        return self

    def advertise(self):
        """`dns-sd -R`: macOS's own responder publishes the record as long as that process runs. It runs under a
        small shell that holds a pipe from this process: when this process ends, however it ends (SIGKILL, a
        crash), the pipe closes and the shell takes dns-sd with it, so no record outlives the service. Records
        an earlier service left behind are cleared first (task-9ca5: five of them, a phone saw the Mac five times)."""
        state = self.store.load()
        clear_stale_adverts(state["mac"])
        argv = ["dns-sd", "-R", f"Dispatch on {mac_name()}", SERVICE_TYPE, "local", str(self.port),
                f"mac={state['mac']}", f"v={PROTOCOL}", f"model={mac_model()}", f"host={local_host()}", f"port={self.port}", f"name={mac_name()}"]
        try:
            self.dns_sd = subprocess.Popen(["/bin/sh", "-c", ADVERT_SH, "dispatch-advert"] + argv, stdin=subprocess.PIPE,
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            self.dns_sd = None

    def stop(self):
        for s in self.servers:
            try:
                s.shutdown()
                s.server_close()
            except Exception:
                pass
        self.hub.stop()
        self.notifier.stop()
        stop_advert(self.dns_sd)
        self.dns_sd = None

    # authentication ----------------------------------------------------------------------------

    def authenticate(self, method, path, headers, body, now=None):
        """(pair, None) for a good signature, else (None, (status, code, message))."""
        now = now or time.time()
        pid, device = headers.get("X-Dispatch-Pair", ""), headers.get("X-Dispatch-Device", "")
        ts, sig = headers.get("X-Dispatch-Time", ""), headers.get("X-Dispatch-Sig", "")
        nonce = headers.get("X-Dispatch-Nonce", "") or ""
        p = self.store.get(pid) if pid else None
        if not p:
            return None, (401, "unknown_pair", "This phone is not paired with this Mac.")
        if p.get("status") == "pending" and p.get("expires", 0) < now:
            return None, (401, "pair_expired", "The pairing code expired. Run dispatch mobile pair again.")
        try:
            ts_i = int(ts)
        except ValueError:
            return None, (401, "bad_signature", "Missing or malformed signature.")
        if abs(now - ts_i) > SKEW:
            return None, (401, "clock_skew", "The phone's clock is too far from the Mac's.")
        key = hkdf(unb64url(p["secret"]), KEY_LAN)
        if not verify(key, method, path, ts_i, body, sig, nonce):
            return None, (401, "bad_signature", "Signature does not match.")
        with self.replay_lock:
            for k in [k for k, t in self.replay.items() if now - t > 2 * SKEW]:
                del self.replay[k]
            if sig in self.replay:
                return None, (401, "replayed", "This request was already received.")
            self.replay[sig] = now
        if p.get("status") == "paired" and p.get("device") and device and p["device"] != device:
            return None, (403, "other_device", "This pairing belongs to another phone.")
        name = urllib.parse.unquote(headers.get("X-Dispatch-Device-Name", "") or "")
        return self.store.bind(pid, device or "phone", name, now), None


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, service):
        self.service = service
        super().__init__(addr, handler)


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "DispatchMobile/1"

    def log_message(self, fmt, *a):
        if os.environ.get("DISPATCH_MOBILE_LOG"):
            sys.__stderr__.write("mobile: " + (fmt % a) + "\n")

    def setup(self):
        super().setup()
        if isinstance(self.connection, ssl.SSLSocket):
            self.connection.settimeout(15)
            try:
                self.connection.do_handshake()
            except (ssl.SSLError, OSError):
                self.close_connection = True
                raise ConnectionAbortedError
            self.connection.settimeout(None)

    def handle(self):
        try:
            super().handle()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, ssl.SSLError, TimeoutError):
            pass

    def send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 20 * 1024 * 1024:
            raise ValueError("too large")
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def route(self, method):
        svc = self.server.service
        try:
            body = self.body()
        except ValueError:
            return self.send_json(413, {"ok": False, "code": "too_large", "message": "Request too large."})
        path = self.path
        parsed = urllib.parse.urlparse(path)
        if parsed.path == "/v1/health":
            return self.send_json(200, {"ok": True, "protocol": PROTOCOL, "mac": svc.store.load()["mac"]})
        if parsed.path == "/v1/pair/code" and method == "POST":
            return self.send_json(*svc.api.pair_by_code(body, lan=self.server is svc.servers[0]))
        pair, err = svc.authenticate(method, path, self.headers, body)
        if err:
            status, code, msg = err
            return self.send_json(status, {"ok": False, "code": code, "message": msg})
        if parsed.path == "/v1/events":
            return svc.api.stream(self, pair)
        try:
            status, obj = svc.api.handle(method, parsed.path, urllib.parse.parse_qs(parsed.query), body, pair)
        except Exception as e:
            status, obj = 500, {"ok": False, "code": "internal", "message": f"{type(e).__name__}: {e}"[:400]}
        self.send_json(status, obj)


# ---- inside chatd ---------------------------------------------------------------------------------

_running = None
_last_error = None


def attach_to_chatd(d=None):
    """Called by chatd every few seconds: phone access on, the service runs in chatd's process; turned off, it
    stops. A failure to start is written down (service.json: why, in words) so the window and `mobile status` can
    say it, and logged once per kind. Never raises: the phone service failing must not take chatd down."""
    global _running, _last_error
    try:
        if os.environ.get("DISPATCH_MOBILE") == "0":
            return None
        store = Store(d)
        state = store.load()
        want = access_on(state)
        if _running is not None:
            if not want:
                detach_from_chatd()
                write_service(d, {"state": "off"})
            return _running
        if not want:
            if read_service(d).get("state") != "off":
                write_service(d, {"state": "off"})
            return None
        _running = Service(d).start()
        _last_error = None
        write_service(d, {"state": "running", "port": _running.port})
    except Exception as e:
        port = (locals().get("state") or {}).get("port") or DEFAULT_PORT
        reason, message, fix = why_not_started(e, port)
        if _last_error != (reason, str(e)):
            sys.__stderr__.write(f"mobile: not started: {e}\n")
            _last_error = (reason, str(e))
        write_service(d, {"state": "failed", "reason": reason, "port": port, "message": message, "fix": fix, "error": str(e)[:300]})
        _running = None
    return _running


def running_service():
    return _running


def detach_from_chatd():
    """chatd is going: stop the phone service it carries (and with it the Bonjour record)."""
    global _running
    svc, _running = _running, None
    if svc is not None:
        try:
            svc.stop()
        except Exception:
            pass


# ---- dispatch mobile … -------------------------------------------------------------------------

def _print(obj, as_json, text):
    if as_json:
        print(json.dumps(obj, ensure_ascii=False, indent=1))
    else:
        print(text(obj) if callable(text) else text)


def service_up(port, mac=None, timeout=1.0):
    """The phone service answers on this port; with `mac`, it is this Mac's own (another Dispatch, a test instance
    with its own data, can hold the port and answer too)."""
    try:
        with socket.create_connection(("127.0.0.1", port + 1), timeout=timeout) as s:
            s.sendall(b"GET /v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            data = b""
            while len(data) < 4096:
                chunk = s.recv(1024)
                if not chunk:
                    break
                data += chunk
                if b"\r\n\r\n" in data and data.rstrip().endswith(b"}"):
                    break
    except OSError:
        return False
    if b" 200 " not in data.split(b"\r\n", 1)[0] + b" ":
        return False
    if not mac:
        return True
    try:
        return json.loads(data.split(b"\r\n\r\n", 1)[1].decode("utf-8", "replace")).get("mac") == mac
    except (IndexError, ValueError, AttributeError):
        return False


def chatd_running(d=None):
    """A chatd is up (the app's or the resident one): it starts the phone service by itself when a pair exists."""
    try:
        import chatd_service
        return chatd_service.door_owner(d or dispatch_dir()) is not None
    except Exception:
        return False


def ensure_service(d=None, timeout=20.0):
    """Phone access is on: wait until the service answers. "running" (it already did), "started", "failed" (chatd
    tried and could not: service.json says why) or "not_running" (no chatd to run it; the caller runs `serve`)."""
    d = d or dispatch_dir()
    state = Store(d).load()
    port, mac = state["port"], state["mac"]
    if service_up(port, mac):
        return "running"
    if not chatd_running(d):
        return "not_running"
    since = time.time()
    while time.time() - since < timeout:
        time.sleep(0.25)
        state = Store(d).load()  # port 0 in the settings: the service writes the port it took
        if service_up(state["port"], mac):
            return "started"
        rec = read_service(d)
        if rec.get("state") == "failed" and rec.get("at", 0) >= since - 1:
            return "failed"
    return "failed" if read_service(d).get("state") == "failed" else "not_running"


def status_of(d, st):
    state = st.load()
    port = state["port"]
    running = service_up(port, state["mac"])
    _, _, fp = ensure_cert(d)
    return {"mac": state["mac"], "name": mac_name(), "port": port, "access": "on" if access_on(state) else "off",
            "running": running, "chatd": chatd_running(d), "problem": problem(state, d, running),
            "lan": lan_addresses(), "fingerprint": fp, "settings": state["settings"],
            "devices": [{k: v for k, v in p.items() if k not in ("secret", "code")} for p in state["pairs"].values()]}


def status_text(r):
    paired = len([p for p in r["devices"] if p.get("status") == "paired"])
    if r["access"] == "off":
        return f"Phone access is off · {paired} paired. It turns on when you pair a phone (dispatch mobile pair)."
    p = r.get("problem") or {}
    if r["running"]:
        if p:
            return f"Running on port {r['port']}, but your phone cannot reach it: {p.get('message')} {p.get('fix')}".strip()
        return f"Running on port {r['port']} · {paired} paired"
    return f"Not running: {p.get('message') or 'phone access is on but nothing answers'} {p.get('fix') or ''}".strip()


def command(a):
    d = dispatch_dir()
    st = Store(d)
    op = a.op or "status"
    if op == "pair":
        # pairing is what turns phone access on (off on a new Mac); no code while nothing answers the phone
        set_access(st, True)
        up = ensure_service(d)
        if up not in ("running", "started"):
            res = {"ok": False, "service": up, **status_of(d, st)}
            if a.json:
                return _print(res, True, None) or 0
            print(status_text(res) if up == "failed" else
                  "Nothing serves the phone yet: keep `dispatch mobile serve` running in another terminal, or open Dispatch, then pair again.")
            return 1
        direct = [x for x in [tailscale_address()] if x]
        settings = st.load()["settings"]
        if not (direct or settings.get("relay_url") or settings.get("cloud_container")):
            # the service answers, but a phone on the Wi-Fi gets nothing back (a VPN takes the local network) and
            # there is no other way in: say why, and no code that cannot connect
            blocked = reach_problem(st.load()["port"])
            if blocked:
                res = {"ok": False, "service": up, **status_of(d, st), "problem": blocked}
                if a.json:
                    return _print(res, True, None) or 0
                print(status_text(res))
                return 1
        pair, state = st.new_pair(replace=getattr(a, "replace", None))
        _, _, fp = ensure_cert(d)
        payload = pairing_payload(state, pair, fp, direct=direct)
        url = pairing_url(payload)
        res = {"ok": True, "pair": pair["id"], "code": pair["code"], "expires": pair["expires"],
               "expires_in": max(0, int(pair["expires"] - time.time())), "url": url, "service": up,
               "lan": payload["lan"], "port": payload["port"]}
        if getattr(a, "svg", None):
            import qr
            with open(a.svg, "w", encoding="utf-8") as f:
                f.write(qr.render_svg(qr.matrix(url.encode("utf-8"))))
            res["svg"] = a.svg
        if getattr(a, "inline", False):
            import qr
            res["svg_text"] = qr.render_svg(qr.matrix(url.encode("utf-8")))
        if a.json:
            return _print(res, True, None) or 0
        import qr
        print(qr.render_blocks(qr.matrix(url.encode("utf-8"))))
        print(f"Scan this with the Dispatch app on your iPhone (Sessions > Pair a Mac).")
        print(f"Or pick this Mac on the same Wi-Fi and type {pair['code'][:3]} {pair['code'][3:]}. Good for ten minutes.")
        return 0
    if op in ("on", "off"):
        set_access(st, op == "on")
        up = ensure_service(d) if op == "on" else "off"
        if op == "off":
            # chatd stops the service within a few seconds (it looks every MOBILE_CHECK): wait for that, then say off
            mac = st.load()["mac"]
            for _ in range(40):
                if not service_up(st.load()["port"], mac):
                    break
                time.sleep(0.25)
            res = {"ok": True, "service": "off", **status_of(d, st)}
            return _print(res, a.json, "Phone access is off. Paired phones stay paired and connect again when you turn it on.") or 0
        res = {"ok": up in ("running", "started"), "service": up, **status_of(d, st)}
        return _print(res, a.json, status_text) or (0 if res["ok"] else 1)
    if op == "status":
        return _print(status_of(d, st), a.json, status_text) or 0
    if op == "devices":
        rows = [{k: v for k, v in p.items() if k not in ("secret", "code")} for p in st.load()["pairs"].values()]
        return _print(rows, a.json, lambda r: "\n".join(f"{p['id']}  {p.get('device_name') or '(waiting for a phone)'}  {p['status']}" for p in r)
                      or "No phone paired") or 0
    if op == "revoke":
        gone = st.revoke(a.arg or "")
        return _print({"ok": bool(gone), "revoked": gone}, a.json, lambda r: f"Revoked {', '.join(r['revoked'])}" if r["ok"] else "Nothing matched") or (0 if gone else 1)
    if op == "helper-keys":
        # the Mac helper (relay and iCloud channels) needs the secrets; this user only, never printed as text
        state = st.load()
        rows = [{"pair": p["id"], "secret": p["secret"], "status": p["status"], "device": p.get("device", "")} for p in state["pairs"].values()]
        return _print({"mac": state["mac"], "port": state["port"], "pairs": rows, "settings": state["settings"]}, True, None) or 0
    if op == "config":
        state = st.load()
        known = ("assistant_agent", "port", "relay_url", "cloud_container")
        if not a.arg:
            return _print(state["settings"] | {"port": state["port"]}, a.json, lambda r: "\n".join(f"{k} = {v}" for k, v in r.items())) or 0
        if a.arg not in known:
            print(f"unknown setting {a.arg}; one of {', '.join(known)}", file=sys.stderr)
            return 2
        if a.value is None:
            return _print({a.arg: state["port"] if a.arg == "port" else state["settings"].get(a.arg)}, a.json, lambda r: str(list(r.values())[0])) or 0
        if a.arg == "port":
            state["port"] = int(a.value)
        else:
            state["settings"][a.arg] = a.value
        st.save(state)
        return _print({"ok": True, a.arg: a.value}, a.json, lambda r: "Saved") or 0
    if op == "notify":
        return notify_command(a, d, st)
    if op == "serve":
        if a.arg and a.arg.isdigit():
            state = st.load()
            state["port"] = int(a.arg)
            st.save(state)
        svc = Service(d).start()
        print(f"Dispatch mobile service on port {svc.port} (loopback {svc.port + 1}); Ctrl-C to stop", flush=True)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            svc.stop()
        return 0
    print(f"unknown op {op}", file=sys.stderr)
    return 2


def notify_command(a, d, st):
    """`dispatch mobile notify`: per phone, which kinds it gets and whether they also reach it with the
    app closed. `notify test`: a test notice through the running service, without ringing this Mac's bell."""
    import mobile_push
    state = st.load()
    if a.arg == "test":
        kind = getattr(a, "kind", None) or "finished"
        up = service_up(state["port"], state["mac"])
        if up:
            mobile_push.file_test_request(d, kind)
        res = {"ok": up, "kind": kind, "service": "running" if up else "not_running"}
        return _print(res, a.json, lambda r: f"Sent a test ({mobile_push.WORD[kind]}) to the paired phones." if r["ok"]
                      else "Nothing serves the phone right now (chatd or `dispatch mobile serve`), so no test was sent.") or (0 if up else 1)
    rows = []
    for p in state["pairs"].values():
        if p.get("status") != "paired":
            continue
        info = mobile_push.describe(p, state["settings"])
        rows.append({"pair": p["id"], "device": p.get("device_name") or "", **{k: v for k, v in info.items() if k != "ok"}})

    def text(rows):
        if not rows:
            return "No phone paired"
        out = []
        for r in rows:
            on = [mobile_push.WORD[k] for k in mobile_push.KINDS if r["kinds"][k]] or ["nothing"]
            how = "also with the app closed" if r["remote"] else ("only while the app is open (the phone has not registered with the relay)" if r["relay"] else "only while the app is open (no relay on this Mac)")
            last = r.get("last_push") or {}
            out.append(f"{r['device'] or r['pair']}: {', '.join(on)}; {how}" + (f"; last push {last.get('code')}" if last else ""))
        return "\n".join(out)
    return _print(rows, a.json, text) or 0


def add_parser(sub, D=None):
    s = sub.add_parser("mobile", help="the iPhone app's way in to this Mac: pair (QR code; turns phone access on), status, on / off, devices, revoke, serve, config, notify; protocol in docs/mobile-protocol.md")
    s.add_argument("op", nargs="?", default="status", choices=["pair", "status", "on", "off", "devices", "revoke", "serve", "helper-keys", "config", "notify"])
    s.add_argument("arg", nargs="?", default="", help="revoke: pair or device id; config: the setting; serve: port; notify: test")
    s.add_argument("value", nargs="?", default=None, help="config: the new value")
    s.add_argument("--svg", help="pair: also write the QR code as SVG to this file")
    s.add_argument("--inline", action="store_true", help="pair: with --json, the QR code as SVG text in svg_text")
    s.add_argument("--kind", choices=["finished", "stopped", "needs_you"], help="notify test: which kind (default finished)")
    s.add_argument("--replace", help="pair: a pending pair this one replaces (a paired phone is never touched)")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=lambda a: sys.exit(command(a) or 0))
