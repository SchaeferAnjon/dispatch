"""First-run setup for Dispatch (`dispatch init`).

One machine at a time, in this order, each step idempotent so the wizard can be
re-run after fixing something by hand:

  deps    Homebrew, Dolt, Beads (bd), Herdr, tmux; Tailscale optional
  cli     `dispatch` on PATH -> the CLI bundled inside Dispatch.app
  board   the task board: start a new one here (this Mac becomes the hub) or join
          the board of a Mac that already runs Dispatch; joining also asks the hub to
          ssh back, since 远程登录 (a GUI toggle) is what lets it merge this Mac's sessions
  agents  which agents live here; hooks for Claude Code
  rules   one GLOBAL.md for every agent + a shared skills pool (copied from the hub
          when joining), then `dispatch rules sync`
  review  optional: hand an agent the job of auditing rules and skills
  done    marks setup finished (or skipped) so the app stops showing the guide

`dispatch init status --json` describes every step for the desktop app; the app
calls `dispatch init run <step> ...` for each button. The terminal wizard
(`dispatch init`) walks the same steps with prompts.
"""
import json, os, plistlib, re, secrets, shlex, shutil, socket, subprocess, sys, time

import dispatch as D

INIT_FILE = os.path.join(D.DISPATCH_DIR, "init.json")
HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = os.path.join(D.HOME, ".beads", "shared-server")
DOLT_CONFIG = os.path.join(SHARED, "dolt", "config.yaml")
REMOTESAPI_PORT = 3309
SYNC_USER = "sync"
LAUNCH_DIR = os.path.join(D.HOME, "Library", "LaunchAgents")
BREW = shutil.which("brew") or ("/opt/homebrew/bin/brew" if os.path.exists("/opt/homebrew/bin/brew") else "/usr/local/bin/brew")
AGENT_HOMES = {
    "claude-code": ("Claude Code", os.path.join(D.HOME, ".claude")),
    "codex": ("Codex", os.path.join(D.HOME, ".codex")),
    "pi": ("pi", os.path.join(D.HOME, ".pi")),
    "zcode": ("ZCode", os.path.join(D.HOME, ".zcode")),
    "gemini": ("Gemini CLI", os.path.join(D.HOME, ".gemini")),
    "opencode": ("OpenCode", os.path.join(D.HOME, ".config", "opencode")),
}
DEPS = [
    # name, binary, brew formula/cask, why, required
    ("brew", "brew", None, "macOS 的包管理器，下面几样都靠它装", True),
    ("dolt", "dolt", "dolt", "任务板的数据库（带版本历史，能在两台电脑之间同步）", True),
    ("bd", "bd", "beads", "任务板本身（Beads），Agent 用它记任务", True),
    ("herdr", "herdr", "herdr", "终端里的 Agent 多路复用器，Dispatch 用它派活给 Agent", True),
    ("tmux", "tmux", "tmux", "让 Herdr 在后台常驻，Dispatch 随时能把活派给 Agent（不用先开终端）", True),
    ("tailscale", "tailscale", None, "两台电脑不在同一 Wi‑Fi 时互相访问；只有一台电脑可以不装", False),
]


# ---------------------------------------------------------------- state

def load_state():
    try:
        return json.load(open(INIT_FILE))
    except Exception:
        return {}


def save_state(**kw):
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    s = load_state()
    s.update(kw)
    json.dump(s, open(INIT_FILE, "w"), ensure_ascii=False, indent=2)
    return s


def which(name):
    p = shutil.which(name, path=D.PATH_EXTRA + ":" + os.environ.get("PATH", ""))
    if p:
        return p
    if name == "tailscale" and os.path.exists("/Applications/Tailscale.app/Contents/MacOS/Tailscale"):
        return "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    return ""


def run(args, timeout=600, env=None, input_text=None, cwd=None):
    e = dict(os.environ)
    e["PATH"] = D.PATH_EXTRA + ":" + e.get("PATH", "")
    e.setdefault("BEADS_DIR", D.BEADS_DIR)
    e["BD_NON_INTERACTIVE"] = "1"
    if env:
        e.update(env)
    r = subprocess.run(args, capture_output=True, timeout=timeout, env=e, input=input_text.encode() if input_text else None, cwd=cwd)
    return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return ""


def machine():
    ov = D.overlay_network() if hasattr(D, "overlay_network") else {}
    return {"name": D.local_host_name(), "user": os.environ.get("USER") or os.path.basename(D.HOME), "arch": os.uname().machine,
            "tailscale_ip": D.tailscale_ip() or "", "lan_ip": lan_ip(), "overlay": ov}


# ---------------------------------------------------------------- deps

def deps_status():
    rows = []
    for name, binary, formula, why, required in DEPS:
        path = which(binary)
        rows.append({"name": name, "found": bool(path), "path": path, "formula": formula, "why": why, "required": required,
                     "installable": bool(formula) and bool(which("brew"))})
    return rows


def deps_install(names):
    """brew install what is missing. Homebrew itself needs an admin password, so that one
    is a command for the user to paste into Terminal."""
    done, failed = [], []
    for name in names:
        dep = next((d for d in DEPS if d[0] == name), None)
        if not dep:
            failed.append({"name": name, "error": "unknown"}); continue
        _, binary, formula, _, _ = dep
        if which(binary):
            done.append(name); continue
        if name == "brew":
            failed.append({"name": name, "error": "Homebrew 要在终端里装（需要管理员密码）", "command": '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'}); continue
        if name == "tailscale":
            failed.append({"name": name, "error": "Tailscale 是带系统扩展的图形应用，去 App Store 装，或 https://tailscale.com/download", "command": "open https://tailscale.com/download/mac"}); continue
        if not which("brew"):
            failed.append({"name": name, "error": "先装 Homebrew"}); continue
        code, o, e = run([which("brew"), "install", "--quiet", formula], timeout=1800)
        if code == 0 and which(binary):
            done.append(name)
        else:
            failed.append({"name": name, "error": (e or o).strip()[-800:]})
    return {"installed": done, "failed": failed}


# ---------------------------------------------------------------- cli on PATH

def bundled_cli():
    return os.path.join(HERE, "dispatch.py")


def cli_status():
    link = os.path.join(D.HOME, ".local", "bin", "dispatch")
    target = os.path.realpath(link) if os.path.islink(link) or os.path.exists(link) else ""
    on_path = bool(shutil.which("dispatch"))
    return {"link": link, "exists": os.path.exists(link), "target": target, "bundled": bundled_cli(), "in_app": "/Contents/Resources/" in HERE, "on_path": on_path}


def cli_link():
    link = os.path.join(D.HOME, ".local", "bin", "dispatch")
    os.makedirs(os.path.dirname(link), exist_ok=True)
    if os.path.islink(link) or os.path.exists(link):
        os.remove(link)
    os.symlink(bundled_cli(), link)
    os.chmod(bundled_cli(), 0o755)
    # Helper scripts the hooks and LaunchAgents point at, kept as links so an app update carries them along.
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    for f in ("presence.py", "edit-guard.py", "statusline-tee.sh", "board-sync.sh"):
        src, dst = os.path.join(HERE, f), os.path.join(D.DISPATCH_DIR, f)
        if os.path.exists(src):
            if os.path.islink(dst) or os.path.exists(dst):
                os.remove(dst)
            os.symlink(src, dst)
    # PATH for the shells people actually use.
    added = []
    fish = os.path.join(D.HOME, ".config", "fish", "conf.d", "dispatch.fish")
    if not os.path.exists(fish):
        os.makedirs(os.path.dirname(fish), exist_ok=True)
        open(fish, "w").write("# Dispatch CLI\nfish_add_path -g $HOME/.local/bin /opt/homebrew/bin\n")
        added.append(fish)
    zprofile = os.path.join(D.HOME, ".zprofile")
    line = 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH" # dispatch'
    try:
        cur = open(zprofile).read()
    except FileNotFoundError:
        cur = ""
    if "# dispatch" not in cur:
        open(zprofile, "a").write(("\n" if cur and not cur.endswith("\n") else "") + line + "\n")
        added.append(zprofile)
    return {"link": link, "target": bundled_cli(), "path_files": added}


# ---------------------------------------------------------------- board

def dolt_port():
    try:
        return int(open(os.path.join(SHARED, "dolt-server.port")).read().strip())
    except Exception:
        return 3308


def dolt_sql(q, timeout=30):
    return run([which("dolt") or "dolt", "--host", "127.0.0.1", "--port", str(dolt_port()), "--user", "root", "--password", "", "--no-tls", "--use-db", "task", "sql", "-q", q], timeout=timeout)


def dolt_server_up():
    try:
        with socket.create_connection(("127.0.0.1", dolt_port()), timeout=1):
            return True
    except OSError:
        return False


def board_status():
    cfg = os.path.join(D.BEADS_DIR, "config.yaml")
    exists = os.path.exists(cfg)
    remote = ""
    if exists:
        m = re.search(r'remote:\s*"?([^"\n]+)"?', open(cfg).read())
        remote = m.group(1).strip() if m else ""
    st = load_state()
    return {"dir": D.BEADS_DIR, "exists": exists, "remote": remote, "mode": st.get("board_mode", ""), "hub": st.get("hub"), "reverse_ssh": st.get("reverse_ssh"),
            "server_up": dolt_server_up() if exists else False, "launchd": os.path.exists(os.path.join(LAUNCH_DIR, "dev.schaefer.beads-dolt.plist")),
            "sync_launchd": os.path.exists(os.path.join(LAUNCH_DIR, "dev.schaefer.beads-sync.plist")), "remotesapi": remotesapi_enabled()}


def write_plist(label, args, env=None, interval=None, keep_alive=False, log=None, cwd=None):
    os.makedirs(LAUNCH_DIR, exist_ok=True)
    p = os.path.join(LAUNCH_DIR, f"{label}.plist")
    d = {"Label": label, "ProgramArguments": args, "RunAtLoad": True,
         "EnvironmentVariables": {"PATH": D.PATH_EXTRA + ":/usr/bin:/bin", "BEADS_DIR": D.BEADS_DIR, "BD_NON_INTERACTIVE": "1", **(env or {})}}
    if interval:
        d["StartInterval"] = interval
    if keep_alive:
        d["KeepAlive"] = True
    if log:
        d["StandardOutPath"] = d["StandardErrorPath"] = log
    if cwd:
        d["WorkingDirectory"] = cwd
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{label}"], capture_output=True)
    with open(p, "wb") as f:
        plistlib.dump(d, f)
    r = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", p], capture_output=True, text=True)
    if r.returncode != 0:  # not in a GUI session (ssh): fall back to load
        subprocess.run(["launchctl", "load", p], capture_output=True)
    return p


def install_dolt_launchd(env=None):
    os.makedirs(SHARED, exist_ok=True)
    return write_plist("dev.schaefer.beads-dolt", [which("bd") or "bd", "dolt", "start"], env=env, interval=120, log=os.path.join(SHARED, "launchd.log"))


def wait_server(seconds=40):
    for _ in range(seconds):
        if dolt_server_up():
            return True
        time.sleep(1)
    return False


def remotesapi_enabled():
    try:
        return bool(re.search(r"^remotesapi:\s*\n\s+port:\s*\d+", open(DOLT_CONFIG).read(), re.M))
    except FileNotFoundError:
        return False


def remotesapi_up():
    try:
        with socket.create_connection(("127.0.0.1", REMOTESAPI_PORT), timeout=1):
            return True
    except OSError:
        return False


def enable_remotesapi(force=False):
    """Let other Macs pull/push this board over HTTP on :3309. `bd dolt start` launches
    dolt with flags only and ignores config.yaml, so the hub runs dolt itself from a
    LaunchAgent that reads the config; bd just connects to the port."""
    if remotesapi_enabled() and remotesapi_up() and not force:
        return False
    try:
        cfg = open(DOLT_CONFIG).read()
    except FileNotFoundError:
        cfg = "log_level: warning\n"
    if not remotesapi_enabled():
        if not re.search(r"^listener:", cfg, re.M):
            cfg = cfg.rstrip("\n") + f"\nlistener:\n  host: 127.0.0.1\n  port: {dolt_port()}\n"
        cfg = cfg.rstrip("\n") + f"\nremotesapi:\n  port: {REMOTESAPI_PORT}\n"
        os.makedirs(os.path.dirname(DOLT_CONFIG), exist_ok=True)
        open(DOLT_CONFIG, "w").write(cfg)
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/dev.schaefer.beads-dolt"], capture_output=True)
    try:
        os.remove(os.path.join(LAUNCH_DIR, "dev.schaefer.beads-dolt.plist"))
    except FileNotFoundError:
        pass
    run([which("bd") or "bd", "dolt", "stop"], timeout=60)
    for _ in range(20):
        if not dolt_server_up():
            break
        time.sleep(0.5)
    subprocess.run(["pkill", "-f", "dolt sql-server"], capture_output=True)
    time.sleep(1)
    write_plist("dev.schaefer.dolt-server", [which("dolt") or "dolt", "sql-server", "--config", DOLT_CONFIG], keep_alive=True, log=os.path.join(SHARED, "dolt-server.log"), cwd=os.path.dirname(DOLT_CONFIG))
    if not wait_server():
        raise RuntimeError("Dolt 服务没起来，看 ~/.beads/shared-server/dolt-server.log")
    for _ in range(20):
        if remotesapi_up():
            break
        time.sleep(0.5)
    return True


def ensure_sync_user():
    """A MySQL user other Macs authenticate with; the password lives in `dispatch env`."""
    items = D.env_read()
    pw = next((i["value"] for i in items if i["name"] == "DOLT_REMOTE_PASSWORD"), "")
    if not pw:
        pw = secrets.token_urlsafe(18)
        items = [i for i in items if i["name"] not in ("DOLT_REMOTE_USER", "DOLT_REMOTE_PASSWORD")]
        items += [{"name": "DOLT_REMOTE_USER", "value": SYNC_USER, "note": "任务板同步用户（其他电脑接入时用）"},
                  {"name": "DOLT_REMOTE_PASSWORD", "value": pw, "note": "任务板同步密码（dispatch init 生成）"}]
        D.env_write(items)
    code, o, e = dolt_sql(f"CREATE USER IF NOT EXISTS '{SYNC_USER}'@'%' IDENTIFIED BY '{pw}'; GRANT ALL PRIVILEGES ON *.* TO '{SYNC_USER}'@'%';")
    if code != 0:
        raise RuntimeError(f"建同步用户失败：{(e or o).strip()[-400:]}")
    return SYNC_USER, pw


BOARD_CONFIG = """# Dispatch global board — Beads shared-server mode (one Dolt server for the machine)
dolt:
    mode: server
    shared-server: true
    host: 127.0.0.1
    port: {port}
    user: root
    database: task
    auto-commit: "on"
no-git-ops: true
"""


def write_board_config(remote=""):
    """`bd init --shared-server` creates the database but, on a fresh Mac, leaves no
    config.yaml behind (it treats the workspace as embedded). Write the workspace files
    ourselves; they are what makes bd see the shared server."""
    import uuid
    os.makedirs(D.BEADS_DIR, exist_ok=True)
    cfg = BOARD_CONFIG.format(port=dolt_port())
    if remote:
        cfg += f'sync:\n    remote: "{remote}"\n'
    open(os.path.join(D.BEADS_DIR, "config.yaml"), "w").write(cfg)
    meta = os.path.join(D.BEADS_DIR, "metadata.json")
    if not os.path.exists(meta):
        json.dump({"database": "dolt", "backend": "dolt", "dolt_mode": "server", "dolt_database": "task", "project_id": str(uuid.uuid4())}, open(meta, "w"), indent=2)
    code, o, _ = run([which("bd") or "bd", "version"], timeout=20)
    m = re.search(r"(\d+\.\d+\.\d+)", o)
    if m:
        open(os.path.join(D.BEADS_DIR, ".local_version"), "w").write(m.group(1) + "\n")
    os.chmod(D.BEADS_DIR, 0o700)


def board_works():
    code, o, e = run([which("bd") or "bd", "list", "--json"], timeout=60, env={"BEADS_DIR": D.BEADS_DIR})
    return code == 0 and "[" in o, (e or o).strip()[-300:]


def board_first():
    """This Mac starts the board and becomes the hub other Macs join."""
    if not (which("bd") and which("dolt")):
        raise RuntimeError("先装 Beads 和 Dolt（上一步）")
    os.makedirs(D.BEADS_DIR, exist_ok=True)
    root = os.path.dirname(D.BEADS_DIR)
    if not os.path.exists(os.path.join(SHARED, "dolt", "task")):
        # Let bd create the shared server layout and the `task` database (it starts its own server for that).
        code, o, e = run([which("bd"), "init", "--shared-server", "--prefix", "task", "--non-interactive", "--quiet"], timeout=300, env={"BEADS_DIR": D.BEADS_DIR}, cwd=root)
        if code != 0 or not os.path.exists(os.path.join(SHARED, "dolt", "task")):
            raise RuntimeError(f"bd init 没建出数据库：{(e or o).strip()[-600:]}")
    write_board_config()
    # From here on dolt runs from config.yaml (so remotesapi works); bd only connects to the port.
    enable_remotesapi(force=True)
    ok, why = board_works()
    if not ok:
        raise RuntimeError(f"任务板建好了但 bd 连不上：{why}")
    user, pw = ensure_sync_user()
    save_state(board_mode="first", hub=None)
    return {"dir": D.BEADS_DIR, "root": root, "remote_for_others": f"http://{D.tailscale_ip() or lan_ip()}:{REMOTESAPI_PORT}/task", "sync_user": user}


def peers():
    """Other machines on this Tailscale network, so joining is a pick instead of typing an IP."""
    ts = which("tailscale")
    if not ts:
        return {"available": False, "peers": []}
    code, o, e = run([ts, "status", "--json"], timeout=15)
    if code != 0:
        return {"available": True, "peers": [], "error": (e or o).strip()[-200:]}
    try:
        st = json.loads(o)
    except ValueError:
        return {"available": True, "peers": []}
    rows = []
    for p in (st.get("Peer") or {}).values():
        ips = [ip for ip in (p.get("TailscaleIPs") or []) if "." in ip]
        if not ips:
            continue
        rows.append({"name": p.get("HostName") or p.get("DNSName", "").split(".")[0], "ip": ips[0], "online": bool(p.get("Online")), "os": p.get("OS", "")})
    rows.sort(key=lambda r: (not r["online"], r["name"]))
    return {"available": True, "self": {"name": (st.get("Self") or {}).get("HostName", ""), "ip": next((ip for ip in (st.get("Self") or {}).get("TailscaleIPs", []) if "." in ip), "")}, "peers": rows}


def ssh_key_setup(target, password):
    """Passwordless ssh to `target` without the user touching a terminal: make a key if
    there is none, run ssh-copy-id on a pty and type the password for it, then verify.
    The password is used once and never written anywhere."""
    import pty, select
    key = os.path.join(D.HOME, ".ssh", "id_ed25519")
    if not os.path.exists(key + ".pub"):
        os.makedirs(os.path.dirname(key), mode=0o700, exist_ok=True)
        run(["ssh-keygen", "-t", "ed25519", "-N", "", "-f", key, "-q"], timeout=30)
    ok, _ = ssh_target_ok(target)
    if ok:
        return {"ok": True, "note": "本来就能免密"}
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp("ssh-copy-id", ["ssh-copy-id", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", "-i", key + ".pub", target])
    out, sent = b"", 0
    deadline = time.time() + 60
    try:
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 1.0)
            if not r:
                continue
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
            low = out.lower()
            if b"(yes/no" in low and b"yes\n" not in out:
                os.write(fd, b"yes\n")
            elif (b"password:" in low or b"passphrase" in low) and sent < 2 and low.rstrip().endswith(b":"):
                os.write(fd, password.encode() + b"\n"); sent += 1; out = b""
    finally:
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        os.close(fd)
    ok, why = ssh_target_ok(target)
    if not ok:
        text = out.decode("utf-8", "replace")
        hint = "密码不对" if "permission denied" in text.lower() or sent >= 2 else "连不上：确认那台电脑打开了「远程登录」（系统设置 → 通用 → 共享），地址是 用户名@IP"
        raise RuntimeError(f"{hint}（{text.strip()[-200:] or why}）")
    return {"ok": True, "note": "已加入对方的 authorized_keys"}


def ssh_target_ok(target):
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "StrictHostKeyChecking=accept-new", target, "echo ok"], capture_output=True, text=True)
    return r.returncode == 0 and "ok" in r.stdout, (r.stderr or r.stdout).strip()[-300:]


REMOTE_LOGIN_STEP = "系统设置 → 通用 → 共享 → 打开「远程登录」"


def remote_login_on():
    """Is this Mac listening for ssh? 远程登录 opens port 22. The toggle itself is a GUI
    one (`systemsetup -setremotelogin` wants sudo), so all we can check is the port."""
    try:
        with socket.create_connection(("127.0.0.1", 22), timeout=1):
            return True
    except OSError:
        return False


def check_reverse_ssh(target="", addr=""):
    """Ask the hub to ssh back to this Mac. board_join puts the hub's key into our
    authorized_keys, but this Mac also has to listen: 远程登录 is off by default and the
    toggle needs the GUI, so when it is off we can only point at where to turn it on."""
    st = load_state()
    target = target or (st.get("hub") or {}).get("ssh", "")
    if not target:
        return {"checked": False, "ok": False, "note": "这台是枢纽（没有接入别的电脑），不用反向检查"}
    me = machine()
    addr = addr or (st.get("me") or {}).get("ssh") or f"{me['user']}@{me['tailscale_ip'] or me['lan_ip']}"
    local = remote_login_on()
    reachable, why = ssh_target_ok(target)
    res = {"checked": True, "ok": False, "ssh": addr, "hub": target, "local_remote_login": local}
    if not reachable:
        res["detail"] = why
        last = (why or "").strip().splitlines()[-1] if why else ""
        res["hint"] = f"连不上枢纽 {target}：{last or '确认那台电脑开着，并在那边也打开「远程登录」'}"
    else:
        cmd = f"ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new {shlex.quote(addr)} echo ok"
        try:
            r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", target, cmd], capture_output=True, text=True, timeout=30)
            res["ok"] = r.returncode == 0 and "ok" in r.stdout
            res["detail"] = (r.stderr or r.stdout).strip()[-300:]
        except Exception as e:
            res["detail"] = str(e)
        if not res["ok"]:
            res["hint"] = (f"本机没在监听 ssh：「远程登录」没开。{REMOTE_LOGIN_STEP}，打开后点「检查一次」。"
                           if not local else
                           f"枢纽 {target} 连不回 {addr}：两台电脑要在同一个 Tailscale 网络，本机防火墙也别挡 ssh；还是不行就在 {REMOTE_LOGIN_STEP} 关掉再打开一次。")
    save_state(reverse_ssh=res)
    return res


def remote_dispatch_json(target, args, timeout=90):
    cmd = "env BEADS_DIR=$HOME/tasks/.beads $HOME/.local/bin/dispatch " + " ".join(args) + " --json"
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", target, cmd], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"对方执行失败：{(r.stderr or r.stdout).strip()[-400:]}")
    i = r.stdout.find("{")
    return json.loads(r.stdout[i:])


def hub_info():
    """Runs ON the hub, called over ssh by a Mac that wants to join: make sure the board is
    reachable from outside and hand back what the joiner needs."""
    if not os.path.exists(os.path.join(D.BEADS_DIR, "config.yaml")):
        raise RuntimeError("这台电脑还没有任务板，先在这里跑 dispatch init")
    if not dolt_server_up():
        install_dolt_launchd()
        wait_server()
    enable_remotesapi()
    user, pw = ensure_sync_user()
    m = machine()
    ip = m["tailscale_ip"] or m["lan_ip"]
    pub = ""
    for k in ("id_ed25519.pub", "id_rsa.pub"):
        p = os.path.join(D.HOME, ".ssh", k)
        if os.path.exists(p):
            pub = open(p).read().strip(); break
    return {"name": m["name"], "user": m["user"], "ip": ip, "tailscale_ip": m["tailscale_ip"], "lan_ip": m["lan_ip"],
            "remote": f"http://{ip}:{REMOTESAPI_PORT}/task", "sync_user": user, "sync_password": pw, "pubkey": pub,
            "rules_dir": os.path.dirname(D.RULES_FILE), "pool": D.POOL, "dispatch": "$HOME/.local/bin/dispatch"}


def board_retire():
    """Put the local board aside (never deleted) so this Mac can join another one instead:
    stop the servers, move ~/tasks/.beads and the dolt data to timestamped backups."""
    import shutil
    stamp = time.strftime("%Y%m%d-%H%M")
    uid = os.getuid()
    for label in ("dev.schaefer.dolt-server", "dev.schaefer.beads-dolt", "dev.schaefer.beads-sync"):
        subprocess.run(["launchctl", "bootout", f"gui/{uid}/{label}"], capture_output=True)
        try:
            os.remove(os.path.join(LAUNCH_DIR, f"{label}.plist"))
        except FileNotFoundError:
            pass
    run([which("bd") or "bd", "dolt", "stop"], timeout=60)
    subprocess.run(["pkill", "-f", "dolt sql-server"], capture_output=True)
    time.sleep(1)
    moved = []
    if os.path.exists(D.BEADS_DIR):
        dst = D.BEADS_DIR + f".retired-{stamp}"
        shutil.move(D.BEADS_DIR, dst); moved.append(dst)
    data = os.path.join(SHARED, "dolt", "task")
    if os.path.exists(data):
        dst = data + f".retired-{stamp}"
        shutil.move(data, dst); moved.append(dst)
    for f in ("dolt-server.lock", "dolt-server.pid", "dolt-server.port"):
        try:
            os.remove(os.path.join(SHARED, f))
        except FileNotFoundError:
            pass
    save_state(board_mode="", hub=None)
    return moved


def board_join(target, replace=False):
    """Join the board of `target` (user@host that already runs Dispatch). With replace, a
    board this Mac already has is retired first (kept as a backup, never deleted)."""
    if not (which("bd") and which("dolt")):
        raise RuntimeError("先装 Beads 和 Dolt（上一步）")
    retired = []
    if os.path.exists(os.path.join(D.BEADS_DIR, "config.yaml")):
        if not replace:
            raise RuntimeError("这台已经有任务板了；要改为接入另一台，勾选「替换本机任务板」再试（本机的板会留备份）")
        retired = board_retire()
    ok, why = ssh_target_ok(target)
    if not ok:
        raise RuntimeError(f"ssh 连不上 {target}：{why or '要先在那台电脑打开「远程登录」，并把这台的公钥加过去（ssh-copy-id）'}")
    hub = remote_dispatch_json(target, ["init", "hub-info"])
    env = {"DOLT_REMOTE_USER": hub["sync_user"], "DOLT_REMOTE_PASSWORD": hub["sync_password"], "BEADS_DIR": D.BEADS_DIR}
    os.makedirs(D.BEADS_DIR, exist_ok=True)
    if not os.path.exists(os.path.join(D.BEADS_DIR, "config.yaml")):
        install_dolt_launchd(env={"DOLT_REMOTE_USER": hub["sync_user"], "DOLT_REMOTE_PASSWORD": hub["sync_password"]})
        wait_server()
        code, o, e = run([which("bd"), "init", "--shared-server", "--prefix", "task", "--remote", hub["remote"], "--non-interactive", "--quiet"], timeout=600, env=env, cwd=os.path.dirname(D.BEADS_DIR))
        if code != 0 or not os.path.exists(os.path.join(SHARED, "dolt", "task")):
            raise RuntimeError(f"从 {hub['name']} 克隆任务板失败：{(e or o).strip()[-600:]}")
        if not os.path.exists(os.path.join(D.BEADS_DIR, "config.yaml")):
            write_board_config(remote=hub["remote"])
        ok, why = board_works()
        if not ok:
            raise RuntimeError(f"任务板克隆了但 bd 连不上：{why}")
    else:
        install_dolt_launchd(env={"DOLT_REMOTE_USER": hub["sync_user"], "DOLT_REMOTE_PASSWORD": hub["sync_password"]})
        wait_server()
    # Same credentials here, so `dispatch env` and board-sync.sh agree with the LaunchAgent.
    items = [i for i in D.env_read() if i["name"] not in ("DOLT_REMOTE_USER", "DOLT_REMOTE_PASSWORD")]
    items += [{"name": "DOLT_REMOTE_USER", "value": hub["sync_user"], "note": f"任务板同步用户（枢纽：{hub['name']}）"},
              {"name": "DOLT_REMOTE_PASSWORD", "value": hub["sync_password"], "note": "任务板同步密码"}]
    D.env_write(items)
    # Two-way sync every 2 minutes.
    sync_sh = os.path.join(D.DISPATCH_DIR, "board-sync.sh")
    write_plist("dev.schaefer.beads-sync", ["/bin/bash", sync_sh], env={"BOARD_HUB": hub["ip"]}, interval=120, log=os.path.join(SHARED, "sync.log"))
    # Both Macs know each other.
    hub_entry = {"id": re.sub(r"[^a-z0-9]+", "-", hub["name"].lower()).strip("-") or "hub", "name": hub["name"], "ssh": f"{hub['user']}@{hub['ip']}", "dispatch": hub["dispatch"], "herdr_session": "main"}
    hs = [h for h in D.hosts() if h.get("ssh") != hub_entry["ssh"]] + [hub_entry]
    json.dump(hs, open(D.HOSTS_FILE, "w"), ensure_ascii=False, indent=2)
    me = machine()
    my_entry = {"id": re.sub(r"[^a-z0-9]+", "-", me["name"].lower()).strip("-") or "mac", "name": me["name"], "ssh": f"{me['user']}@{me['tailscale_ip'] or me['lan_ip']}", "dispatch": "$HOME/.local/bin/dispatch", "herdr_session": "main"}
    try:
        remote_dispatch_json(target, ["init", "add-host", "'" + json.dumps(my_entry, ensure_ascii=False) + "'"])
    except Exception as e:
        my_entry["registered_error"] = str(e)
    # Keys both ways: ours onto the hub (we can ssh there), theirs into ours.
    if hub.get("pubkey"):
        ak = os.path.join(D.HOME, ".ssh", "authorized_keys")
        os.makedirs(os.path.dirname(ak), mode=0o700, exist_ok=True)
        cur = open(ak).read() if os.path.exists(ak) else ""
        if hub["pubkey"] not in cur:
            open(ak, "a").write(("\n" if cur and not cur.endswith("\n") else "") + hub["pubkey"] + "\n")
            os.chmod(ak, 0o600)
    save_state(board_mode="join", hub={"name": hub["name"], "ssh": hub_entry["ssh"], "remote": hub["remote"]}, me=my_entry)
    # The hub can only merge this Mac's sessions if it can ssh back here.
    reverse = check_reverse_ssh(target=hub_entry["ssh"], addr=my_entry["ssh"])
    return {"hub": hub_entry, "me": my_entry, "remote": hub["remote"], "retired": retired, "reverse_ssh": reverse}


def add_host(entry):
    hs = [h for h in D.hosts() if h.get("ssh") != entry.get("ssh") and h.get("id") != entry.get("id")] + [entry]
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    json.dump(hs, open(D.HOSTS_FILE, "w"), ensure_ascii=False, indent=2)
    return {"hosts": hs}


# ---------------------------------------------------------------- agents

CLAUDE_SETTINGS = os.path.join(D.HOME, ".claude", "settings.json")
PRESENCE = 'python3 "$HOME/tasks/.dispatch/presence.py" claude-code {ev} # dispatch-presence'
GUARD = 'python3 "$HOME/tasks/.dispatch/edit-guard.py" claude-code {when} # dispatch-edit-guard'
EDIT_TOOLS = "Edit|Write|MultiEdit|NotebookEdit"


def agents_status():
    rows = []
    for aid, (label, home) in AGENT_HOMES.items():
        found = os.path.isdir(home)
        rows.append({"id": aid, "name": label, "found": found, "home": home, "hooks": claude_hooks_installed() if aid == "claude-code" and found else None,
                     "rules": aid in ("claude-code", "codex", "pi", "zcode")})
    return rows


def claude_hooks_installed():
    try:
        s = open(CLAUDE_SETTINGS).read()
    except FileNotFoundError:
        return False
    return "dispatch prime" in s and "dispatch-presence" in s


def install_claude_hooks():
    """Presence (what each session is doing), the SessionStart digest, the edit guard and
    the statusline tee. Managed entries carry a marker so re-running replaces, not duplicates."""
    try:
        d = json.load(open(CLAUDE_SETTINGS))
    except (FileNotFoundError, ValueError):
        d = {}
    hooks = d.setdefault("hooks", {})

    def managed(cmd):
        return any(t in cmd for t in ("dispatch-presence", "dispatch-edit-guard", "dispatch prime"))

    for ev, groups in list(hooks.items()):
        for g in groups:
            g["hooks"] = [h for h in g.get("hooks", []) if not managed(h.get("command", ""))]
        hooks[ev] = [g for g in groups if g.get("hooks")]
        if not hooks[ev]:
            del hooks[ev]

    def add(ev, cmd, matcher=None, timeout=None):
        entry = {"type": "command", "command": cmd}
        if timeout:
            entry["timeout"] = timeout
        group = {"hooks": [entry]}
        if matcher is not None:
            group["matcher"] = matcher
        hooks.setdefault(ev, []).append(group)

    add("SessionStart", '"$HOME/.local/bin/dispatch" prime --hook-json', matcher="", timeout=20)
    for ev in ("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "PermissionRequest", "Stop", "SessionEnd"):
        add(ev, PRESENCE.format(ev=ev), matcher="" if ev == "SessionStart" else None)
    add("PreToolUse", GUARD.format(when="pre"), matcher=EDIT_TOOLS)
    add("PostToolUse", GUARD.format(when="post"), matcher=EDIT_TOOLS)
    d["statusLine"] = {"type": "command", "command": 'bash "$HOME/tasks/.dispatch/statusline-tee.sh"', "padding": 0}
    os.makedirs(os.path.dirname(CLAUDE_SETTINGS), exist_ok=True)
    json.dump(d, open(CLAUDE_SETTINGS, "w"), ensure_ascii=False, indent=2)
    return {"path": CLAUDE_SETTINGS}


HERDR_SOCK = os.path.join(D.HOME, ".config", "herdr", "herdr.sock")
HERDR_MAIN_SOCK = os.path.join(D.HOME, ".config", "herdr", "sessions", "main", "herdr.sock")


def herdr_running():
    return os.path.exists(HERDR_SOCK) or os.path.exists(HERDR_MAIN_SOCK)


def ensure_herdr():
    """A Herdr that is always there to hand work to: `main` session inside tmux, kept
    alive by a LaunchAgent in the GUI login session (agents need the keychain login)."""
    if os.path.exists(HERDR_SOCK):
        return {"mode": "window", "note": "Herdr 窗口已在跑"}
    herdr, tmux = which("herdr"), which("tmux")
    if not (herdr and tmux):
        raise RuntimeError("先装 Herdr 和 tmux（第一步）")
    cmd = f"{tmux} has-session -t herdr 2>/dev/null || {tmux} new -d -s herdr -x 220 -y 60 \"{herdr} --session main\""
    write_plist("dev.schaefer.herdr", ["/bin/sh", "-c", cmd], interval=120, log="/tmp/herdr-launchd.log")
    for _ in range(20):
        if os.path.exists(HERDR_MAIN_SOCK):
            break
        time.sleep(0.5)
    return {"mode": "headless", "running": os.path.exists(HERDR_MAIN_SOCK), "note": "Herdr 在后台 tmux 里常驻（session main）"}


def agents_setup(selected):
    save_state(agents=selected)
    done = {}
    if "claude-code" in selected:
        done["claude-code"] = install_claude_hooks()
    try:
        done["herdr"] = ensure_herdr()
    except Exception as e:
        done["herdr"] = {"error": str(e)}
    return {"agents": selected, "installed": done}


# ---------------------------------------------------------------- rules and skills

STARTER_RULES = """# 全局规则（这台电脑上所有 Agent · 唯一来源 `~/.agents/rules/GLOBAL.md` · 改完跑 `dispatch rules sync`）

## 0. 自主性
- 目标清楚就一直推进到完成，中途的小判断自己定，汇报里写一句即可。
- 唯一需要等我点头的动作：对外发送（邮件、消息、PR、评论）。其余不用问。
- 汇报结尾不要挂「要不要我…」这类待办菜单。

## 1. 任务板（Dispatch）
- 明白要做什么 → `dispatch begin "标题" -P <项目> -d 背景 -a "- [ ] 验收项"`；进展 `dispatch log`；收尾 `dispatch done --reason … --retro …`。
- 动手前 `dispatch wiki search <词>`；踩坑 `dispatch wiki add --kind pit`，做对 `--kind win`。
- 密钥只放 `dispatch env`，不进板、不进 wiki、不进 commit。

## 2. 实现纪律
- 先做最简单能跑的方案，先验证地基再堆功能。
- 与改动相称的验证就够；收尾删掉临时文件。
- Git：验证后立即 commit + push；commit 信息 `<type>: <desc>`。

## 3. 沟通
- 先给结论和影响，再给行动和必要证据。
"""


SEED_LABEL = {"existing": "已有的 ~/.agents/rules/GLOBAL.md", "starter": "精简模板", "imported": "从已有的 Agent 规则文件导入", "copied": "从枢纽复制"}


def rules_status():
    st = load_state()
    have_rules = os.path.exists(D.RULES_FILE)
    have_pool = os.path.isdir(D.POOL)
    targets = []
    if have_rules:
        h = D.rules_hash(D.rules_text())
        for ag in D.rule_agents_installed():
            state, p, _ = D.target_state(ag, h)
            targets.append({"agent": ag, "state": state, "path": p})
    task_board = os.path.join(D.POOL, "task-board")
    return {"rules": D.RULES_FILE, "have_rules": have_rules, "pool": D.POOL, "have_pool": have_pool, "task_board_skill": os.path.exists(task_board),
            "targets": targets, "seeded_from": st.get("rules_seed", "")}


def bundled_skill_dir():
    for c in (os.path.join(HERE, "..", "agent", "skills"), os.path.join(HERE, "agent", "skills"), os.path.join(HERE, "..", "..", "agent", "skills")):
        if os.path.isdir(c):
            return os.path.abspath(c)
    return ""


def rules_setup(mode=None, target=None):
    """First machine: keep whatever rules the user already has (or seed a starter).
    Joining: copy the hub's GLOBAL.md, FACTS.md and skills pool. Then sync to every agent."""
    st = load_state()
    mode = mode or st.get("board_mode") or "first"
    seed = ""
    os.makedirs(os.path.dirname(D.RULES_FILE), exist_ok=True)
    if mode == "join":
        target = target or (st.get("hub") or {}).get("ssh")
        if not target:
            raise RuntimeError("不知道枢纽是哪台电脑，先做「任务板」那一步")
        rdir = os.path.dirname(D.RULES_FILE)
        r = subprocess.run(["rsync", "-a", "-e", "ssh -o BatchMode=yes", f"{target}:{rdir}/", rdir + "/"], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"从枢纽复制规则失败：{r.stderr.strip()[-300:]}")
        os.makedirs(D.POOL, exist_ok=True)
        r = subprocess.run(["rsync", "-a", "-e", "ssh -o BatchMode=yes", f"{target}:{D.POOL}/", D.POOL + "/"], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"从枢纽复制技能池失败：{r.stderr.strip()[-300:]}")
        seed = f"copied:{target}"
    elif os.path.exists(D.RULES_FILE):
        seed = "existing"
    else:
        # Import what the user already wrote for one agent, else the starter.
        for cand in (os.path.join(D.HOME, ".claude", "CLAUDE.md"), os.path.join(D.HOME, ".codex", "AGENTS.md"), os.path.join(D.HOME, ".pi", "agent", "AGENTS.md")):
            if os.path.exists(cand) and os.path.getsize(cand) > 200 and D.RULES_BEGIN not in open(cand).read():
                text = open(cand).read()
                open(D.RULES_FILE, "w").write(f"# 全局规则（从 {cand.replace(D.HOME, '~')} 导入 · 唯一来源 `~/.agents/rules/GLOBAL.md` · 改完跑 `dispatch rules sync`）\n\n" + text)
                seed = f"imported:{cand}"
                break
        else:
            open(D.RULES_FILE, "w").write(STARTER_RULES)
            seed = "starter"
    os.makedirs(D.POOL, exist_ok=True)
    # The task-board skill teaches agents the board; it ships with the app.
    src = bundled_skill_dir()
    if src and os.path.isdir(os.path.join(src, "task-board")) and not os.path.exists(os.path.join(D.POOL, "task-board")):
        shutil.copytree(os.path.join(src, "task-board"), os.path.join(D.POOL, "task-board"))
    # Sync rules into every installed agent, mount the skill for those with a skills dir.
    code, o, e = run([sys.executable, bundled_cli(), "rules", "sync", "--json"], timeout=60)
    synced = json.loads(o[o.find("{"):]) if code == 0 and "{" in o else {"error": (e or o).strip()[-300:]}
    mounted = []
    for ag in ("claude", "codex"):
        if os.path.isdir(os.path.dirname(D.AGENT_SKILL_DIRS[ag][0])):
            c, oo, ee = run([sys.executable, bundled_cli(), "skills", "enable", "task-board", "--agent", ag], timeout=60)
            mounted.append({"agent": ag, "ok": c == 0, "msg": (oo or ee).strip().splitlines()[:1]})
    save_state(rules_seed=seed)
    return {"seed": seed, "seed_label": SEED_LABEL.get(seed.split(":")[0], seed) + ((" " + seed.split(":", 1)[1].replace(D.HOME, "~")) if ":" in seed else ""), "rules": D.RULES_FILE, "pool": D.POOL, "sync": synced, "mounted": mounted}


# ---------------------------------------------------------------- review

# Which agents can be handed the review: those with a CLI Herdr can drive.
REVIEW_KINDS = {"claude-code": "claude", "codex": "codex", "pi": "pi", "gemini": "gemini", "opencode": "opencode"}


def review_agents():
    picked = load_state().get("agents") or []
    return [{"id": a, "kind": REVIEW_KINDS[a], "name": AGENT_HOMES[a][0]} for a in AGENT_HOMES if a in REVIEW_KINDS and (a in picked or os.path.isdir(AGENT_HOMES[a][1]))]


def review_prompt():
    agents = [AGENT_HOMES[a][0] for a in (load_state().get("agents") or []) if a in AGENT_HOMES]
    return (f"这台电脑（{D.local_host_name()}）刚装好 Dispatch。请审查并精简这里所有 Agent 共用的指令体系，然后直接改好。\n\n"
            f"范围：全局规则 {D.RULES_FILE}（它被同步到每个 Agent 的入口文件：`dispatch rules status`），技能池 {D.POOL}（`dispatch skills list --json`），以及各 Agent 入口文件里托管块之外的内容。用到的 Agent：{'、'.join(agents) or '未选择'}。\n\n"
            "判断原则：\n"
            "- 先做减法。为老模型补判断、补规划、补「别停下来」写的规则，删掉或弱化；当前模型不需要被手把手。\n"
            "- 给目标和边界，不写逐步菜谱。保留架构约束、兼容要求、安全边界、产品行为和有意义的验收标准；删掉「第一步必须…第二步必须…」，除非顺序本身是业务或安全约束。\n"
            "- 上下文按任务取。不要要求每次先通读仓库、全部文档或加载所有技能。\n"
            "- 全局与项目不重复：项目级文件只留「只有这个项目才需要知道」的内容（架构取舍的原因、不能随意改的实现、特殊目录和接口、项目特有的构建/测试/发布方式）。\n"
            "- 安全可逆的操作自主推进（读代码、改代码、本地构建、跑测试、修自己引入的失败、已授权的 commit/push）；只在不可逆、外发、或缺信息会改变产品决策时停下。\n"
            "- 任务推进到真正完成，但不要把这条扩写成一套固定流程。\n"
            "- 测试范围和改动风险匹配，删掉「一律跑完整套件」。\n"
            "- 技能少而准：合并覆盖同一任务的，收窄过宽的 description，删掉老模型辅助型技能；根 SKILL.md 只说何时用、怎么选，细节按需展开到子文件。\n"
            "- 每条规则至少有一个保留理由：模型确实常做错、项目行为和行业常规不同、违反代价明显、用户稳定偏好、或体现重要设计决策。普通工程常识不写成规则。\n"
            "- 规则冲突时先弄清真实意图，只留一条，不要再加规则去修补规则。\n\n"
            "做法：先列审计结果（建议删除/修改/保留的条目和理由、全局与项目的重复、技能的删并缩短建议、最可能限制发挥的地方），然后按结果直接改文件，改完跑 `dispatch rules sync`，最后用一段话说清改了什么、为什么。不要问「要不要」，也不要新增一套冗长的专用规则。")


HELPER_PROMPTS = {
    "ssh": lambda target: (f"帮我把这台电脑到 {target} 的免密 ssh 打通，然后接入它的 Dispatch 任务板。步骤：\n"
                           f"1) 本机没有 ~/.ssh/id_ed25519 就 ssh-keygen -t ed25519 -N '' 生成；\n"
                           f"2) ssh-copy-id {target}（会要对方的登录密码，提示我来输；如果连不上，告诉我去那台电脑 系统设置→通用→共享 打开「远程登录」）；\n"
                           f"3) 验证 ssh -o BatchMode=yes {target} echo ok；\n"
                           f"4) 通了就跑 `dispatch init run board join {target} --json`，把结果用一句话告诉我。"),
    "brew": lambda _: "帮我在这台 Mac 上装 Homebrew（官方脚本，需要我输管理员密码时提醒我），装完跑 `dispatch init run deps --json` 把 dolt、beads、herdr、tmux 装上，最后用一句话告诉我结果。",
}


def helper_start(topic, arg="", agent="claude"):
    """Hand a setup chore to the agent on this Mac; it can type, wait for passwords and retry."""
    make = HELPER_PROMPTS.get(topic)
    if not make:
        raise RuntimeError(f"没有这种帮手：{topic}")
    prompt = make(arg)
    err = ""
    for attempt in range(2):
        try:
            code, o, e = run([sys.executable, bundled_cli(), "agent", "start", agent, "--cwd", D.HOME, "--label", f"首次设置：{topic}", "--prompt", prompt, "--no-wait", "--json"], timeout=180)
            if code == 0 and "{" in o:
                return {"started": True, "result": json.loads(o[o.find("{"):]), "prompt": prompt}
            err = (e or o).strip()[-400:]
        except Exception as ex:
            err = str(ex)
        if "agent_pane_busy" not in err:
            break
        time.sleep(5)
    return {"started": False, "error": err, "prompt": prompt}


def review_start(agent="claude"):
    prompt = review_prompt()
    cwd = os.path.dirname(D.RULES_FILE)
    err = ""
    # Herdr sometimes reports the fresh tab's shell as busy for a while; one more go before giving up.
    for attempt in range(2):
        try:
            code, o, e = run([sys.executable, bundled_cli(), "agent", "start", agent, "--cwd", cwd, "--label", "首次设置：审查规则与技能", "--prompt", prompt, "--no-wait", "--json"], timeout=180)
            if code == 0 and "{" in o:
                return {"started": True, "result": json.loads(o[o.find("{"):]), "prompt": prompt}
            err = (e or o).strip()[-400:]
        except Exception as ex:
            err = str(ex)
        if "agent_pane_busy" not in err:
            break
        time.sleep(5)
    return {"started": False, "error": err, "prompt": prompt}


# ---------------------------------------------------------------- status / finish

def status():
    st = load_state()
    deps = deps_status()
    cli = cli_status()
    board = board_status()
    agents = agents_status()
    rules = rules_status()
    missing_required = [d["name"] for d in deps if d["required"] and not d["found"]]
    steps = [
        {"id": "deps", "title": "装依赖", "ok": not missing_required, "detail": ("缺 " + "、".join(missing_required)) if missing_required else "都在", "deps": deps},
        {"id": "cli", "title": "终端命令", "ok": cli["exists"] and bool(cli["target"]), "detail": cli["link"].replace(D.HOME, "~") + (" 已就绪" if cli["exists"] else " 还没有"), "cli": cli},
        {"id": "board", "title": "任务板", "ok": board["exists"] and board["server_up"], "detail": ("已接入 " + board["hub"]["name"]) if board.get("hub") else ("已建立，这台是枢纽" if board["exists"] else "还没有任务板"), "board": board},
        {"id": "agents", "title": "Agent", "ok": bool(st.get("agents")) and herdr_running(), "detail": ("、".join(AGENT_HOMES[a][0] for a in st.get("agents", []) if a in AGENT_HOMES) or "还没选") + ("" if herdr_running() else " · Herdr 没在跑"), "agents": agents, "herdr": herdr_running()},
        {"id": "rules", "title": "规则与技能", "ok": rules["have_rules"] and all(t["state"] == "synced" for t in rules["targets"] if os.path.isdir(os.path.dirname(t["path"]))), "detail": ("已同步" if rules["have_rules"] else "还没有共同规则"), "rules": rules},
        {"id": "review", "title": "审查优化", "ok": bool(st.get("reviewed")), "detail": "已派 Agent 审查" if st.get("reviewed") else "可选：派一个 Agent 审查规则和技能", "optional": True, "agents": review_agents()},
    ]
    return {"done": bool(st.get("done")), "skipped": bool(st.get("skipped")), "machine": machine(), "steps": steps, "state": st,
            "all_ok": all(s["ok"] or s.get("optional") for s in steps)}


def finish(skipped=False):
    save_state(done=True, skipped=skipped, finished_at=int(time.time()))
    return status()


def reset():
    try:
        os.remove(INIT_FILE)
    except FileNotFoundError:
        pass
    return status()


# ---------------------------------------------------------------- terminal wizard

def ask(q, default=""):
    try:
        v = input(f"{q}{f' [{default}]' if default else ''}: ").strip()
    except EOFError:
        v = ""
    return v or default


def wizard():
    m = machine()
    print(f"Dispatch 首次设置 · 这台电脑：{m['name']}（{m['tailscale_ip'] or m['lan_ip'] or '没连网'}）\n")
    st = status()
    # deps
    miss = [d for d in st["steps"][0]["deps"] if not d["found"]]
    print("1/6 依赖")
    for d in st["steps"][0]["deps"]:
        print(f"  {'✓' if d['found'] else ('·' if not d['required'] else '✗')} {d['name']:<10} {d['why']}")
    need = [d["name"] for d in miss if d["required"]]
    if need:
        if ask(f"  装上 {'、'.join(need)}？(y/n)", "y").lower().startswith("y"):
            r = deps_install(need)
            for f in r["failed"]:
                print(f"  ✗ {f['name']}：{f['error']}" + (f"\n    在终端跑：{f['command']}" if f.get("command") else ""))
            if r["failed"]:
                print("  装好缺的东西后再跑一次 dispatch init"); return
    print("2/6 终端命令"); r = cli_link(); print(f"  ✓ {r['link'].replace(D.HOME, '~')} → 应用内置 CLI")
    print("3/6 任务板")
    b = board_status()
    if b["exists"]:
        print(f"  ✓ 已有：{b['dir'].replace(D.HOME, '~')}" + (f"（接入 {b['hub']['name']}）" if b.get("hub") else ""))
    else:
        first = ask("  有没有别的电脑已经装了 Dispatch？没有=在这台新建任务板（这台成为枢纽），有=接入它 (n/y)", "n").lower().startswith("n")
        if first:
            r = board_first(); print(f"  ✓ 任务板已建立；其他电脑接入时填 {m['user']}@{m['tailscale_ip'] or m['lan_ip']}")
        else:
            t = ask("  那台电脑的 ssh 地址（用户名@Tailscale 或局域网 IP）")
            r = board_join(t); print(f"  ✓ 已接入 {r['hub']['name']}，每 2 分钟双向同步")
            rev = r.get("reverse_ssh") or {}
            if rev.get("ok"):
                print(f"  ✓ 枢纽 {r['hub']['name']} 能连回本机（{rev['ssh']}）")
            elif rev.get("checked"):
                print(f"  ✗ 枢纽连不回本机：{rev.get('hint', '')}")
    print("4/6 Agent")
    found = [a for a in agents_status() if a["found"]]
    print("  检测到：" + ("、".join(a["name"] for a in found) or "没有"))
    chosen = ask("  用哪些？逗号分隔 id", ",".join(a["id"] for a in found))
    r = agents_setup([x.strip() for x in chosen.split(",") if x.strip()])
    print("  ✓ " + ("Claude Code 的 hooks 已装" if "claude-code" in r["installed"] else "已记录"))
    print("5/6 规则与技能"); r = rules_setup(); print(f"  ✓ 规则来源：{SEED_LABEL.get(r['seed'].split(':')[0], r['seed'])}；已同步到各 Agent")
    print("6/6 审查优化（可选）")
    if ask("  现在派一个 Agent 审查规则和技能？(y/n)", "n").lower().startswith("y"):
        r = review_start("claude" if "claude-code" in (load_state().get("agents") or []) else "codex")
        print("  ✓ 已派出" if r["started"] else f"  没起成（{r.get('error','')}）。把下面这段发给任意 Agent：\n\n{r['prompt']}\n")
        save_state(reviewed=True)
    finish(); print("\n完成。打开 Dispatch.app，或在终端 `dispatch prime` 看看 Agent 会读到什么。")


# ---------------------------------------------------------------- CLI entry

def main(a):
    op = a.op or "wizard"
    try:
        if op == "wizard":
            wizard(); return
        if op == "status":
            res = status()
        elif op == "peers":
            res = peers()
        elif op == "hub-info":
            res = hub_info()
        elif op == "add-host":
            res = add_host(json.loads(a.args[0]))
        elif op == "skip":
            res = finish(skipped=True)
        elif op == "finish":
            res = finish()
        elif op == "reset":
            res = reset()
        elif op == "run":
            step, args = (a.args[0] if a.args else ""), a.args[1:]
            if step == "deps":
                res = deps_install(args or [d["name"] for d in deps_status() if d["required"] and not d["found"]])
            elif step == "cli":
                res = cli_link()
            elif step == "board":
                res = board_first() if (args[:1] or ["first"])[0] == "first" else board_join(args[1], replace="replace" in args[2:])
            elif step == "agents":
                res = agents_setup(args)
            elif step == "rules":
                res = rules_setup()
            elif step == "review":
                res = review_start(args[0] if args else (review_agents() or [{"kind": "claude"}])[0]["kind"]); save_state(reviewed=True)
            elif step == "reverse-ssh":
                res = check_reverse_ssh(args[0] if args else "")
            elif step == "ssh-key":
                pw = sys.stdin.read().rstrip("\n") if not sys.stdin.isatty() else ""
                if not pw:
                    raise RuntimeError("密码从标准输入传入")
                res = ssh_key_setup(args[0], pw)
            elif step == "helper":
                res = helper_start(args[0] if args else "", args[1] if len(args) > 1 else "", "claude" if "claude-code" in (load_state().get("agents") or ["claude-code"]) else "codex")
            else:
                raise RuntimeError(f"未知步骤 {step}")
        else:
            raise RuntimeError(f"未知操作 {op}")
    except Exception as e:
        if a.json:
            print(json.dumps({"error": str(e)}, ensure_ascii=False)); sys.exit(1)
        print(f"✗ {e}"); sys.exit(1)
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(res, ensure_ascii=False, indent=2))
