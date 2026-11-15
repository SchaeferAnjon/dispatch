# -*- coding: utf-8 -*-
"""OpenCode's plugin kit from inside Dispatch IDE, so OpenCode's first start does not wait for npm
(`dispatch engines opencode-kit`).

Why: OpenCode puts its plugin kit (the npm package @opencode-ai/plugin and what it needs, about 60 MB) into
every config folder it reads: ~/.config/opencode, ~/.opencode (where its own installer puts it) and a
project's .opencode folders. When any plugin is loaded (Dispatch's own dispatch.js counts), it waits for those
installs before the first answer: seconds on a good network, about five minutes when npm cannot be reached,
longer behind a slow link. It skips the install when the folder already has a node_modules folder and its
package-lock.json lists @opencode-ai/plugin (OpenCode 1.18 packages/core/src/npm.ts, install()).

Dispatch IDE ships that kit (Resources/app/tools/opencode-plugin-kit.tgz: package.json, package-lock.json and
node_modules, the same files OpenCode would install, pinned in dispatch-ide's opencode-kit/). `seed()` unpacks
it into each of those folders that exists and has no packages of its own yet, so OpenCode finds it installed.
A folder with its own package.json, package-lock.json or node_modules is left alone: those are the person's,
or OpenCode's from an earlier start.

Called by: first-run setup and `dispatch engines install-plugin opencode` (opencode_engine.install_plugin), an
OpenCode install from Dispatch (engines.upgrade), and the Agents window before it starts OpenCode (dispatch-ide
patches/230-opencode-kit.patch, with --cwd for a session's folder).
"""
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile

sys.dont_write_bytecode = True

KIT_NAME = "opencode-plugin-kit.tgz"
# what makes a folder "already has packages": OpenCode's own install looks at the first and the last
OWN = ("node_modules", "package.json", "package-lock.json")


def kit_path(explicit="", env=None):
    """The kit inside Dispatch IDE: `explicit` (the Agents window passes its own), else DISPATCH_IDE_BIN (the running
    app's tools folder, set by dispatch-bridge: only there when it is set), else the app this CLI ships in or the
    one in Applications. '' when there is none."""
    env = os.environ if env is None else env
    if explicit:
        return explicit if os.path.isfile(explicit) else ""
    if env.get("DISPATCH_IDE_BIN"):
        dirs = [env["DISPATCH_IDE_BIN"]]
    else:
        try:
            import dplatform
            dirs = dplatform.app_tools_dirs()
        except Exception:  # noqa: BLE001 - no app found: no kit
            dirs = []
    for d in dirs:
        p = os.path.join(d, KIT_NAME) if d else ""
        if p and os.path.isfile(p):
            return p
    return ""


def _git_root(start):
    d = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            return d
        up = os.path.dirname(d)
        if up == d:
            return ""
        d = up


def config_dirs(cwd="", env=None, home=None):
    """The folders OpenCode reads its config from (OpenCode 1.18 packages/opencode/src/config/paths.ts,
    directories()): its config folder, the .opencode folders from `cwd` up to the project's git root, and
    ~/.opencode; OPENCODE_CONFIG_DIR last. Only the ones that exist, each once."""
    env = os.environ if env is None else env
    home = home or os.path.expanduser("~")
    out = [os.path.join(env.get("XDG_CONFIG_HOME") or os.path.join(home, ".config"), "opencode")]
    if cwd and not env.get("OPENCODE_DISABLE_PROJECT_CONFIG"):
        stop = _git_root(cwd)
        d = os.path.abspath(cwd)
        while True:
            out.append(os.path.join(d, ".opencode"))
            up = os.path.dirname(d)
            if d == stop or up == d:
                break
            d = up
    out.append(os.path.join(home, ".opencode"))
    if env.get("OPENCODE_CONFIG_DIR"):
        out.append(env["OPENCODE_CONFIG_DIR"])
    seen, dirs = set(), []
    for d in out:
        r = os.path.realpath(d)
        if r not in seen and os.path.isdir(d):
            seen.add(r)
            dirs.append(d)
    return dirs


def needs_kit(d):
    """True when OpenCode would install its plugin kit into `d` from npm and Dispatch may put its copy there."""
    return os.path.isdir(d) and os.access(d, os.W_OK) and not any(os.path.lexists(os.path.join(d, n)) for n in OWN)


def _unpack(kit, into):
    """Unpack with the system's tar (fast: thousands of small files); Python's tarfile where there is none."""
    tar = shutil.which("tar") or ("/usr/bin/tar" if os.path.exists("/usr/bin/tar") else "")
    if tar:
        subprocess.run([tar, "-xzf", kit, "-C", into], check=True, stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=300)
        return
    with tarfile.open(kit, "r:gz") as t:
        root = os.path.realpath(into)
        inside = lambda p: os.path.realpath(p).startswith(root + os.sep)  # noqa: E731
        for m in t.getmembers():  # nothing outside `into` (older Pythons have no extraction filter)
            dest = os.path.join(into, m.name)
            if not inside(dest) or m.islnk() or (m.issym() and not inside(os.path.join(os.path.dirname(dest), m.linkname))):
                raise tarfile.TarError(f"unexpected entry {m.name}")
        t.extractall(into)


def seed_dir(d, kit):
    """Put the kit into one folder: unpacked next to it first, then moved in (package.json and the lock file
    before node_modules: OpenCode reads node_modules first). {dir, seeded} or {dir, skipped}."""
    if not needs_kit(d):
        return {"dir": d, "skipped": "has its own packages" if os.path.isdir(d) else "not there"}
    tmp = tempfile.mkdtemp(prefix=".dispatch-kit-", dir=d)
    try:
        _unpack(kit, tmp)
        if not all(os.path.lexists(os.path.join(tmp, n)) for n in OWN):
            return {"dir": d, "skipped": "the kit is incomplete"}
        if not needs_kit(d):  # OpenCode got there meanwhile
            return {"dir": d, "skipped": "has its own packages"}
        for n in ("package.json", "package-lock.json", "node_modules"):
            os.rename(os.path.join(tmp, n), os.path.join(d, n))
        return {"dir": d, "seeded": True}
    except (OSError, subprocess.SubprocessError, tarfile.TarError) as e:
        return {"dir": d, "skipped": f"could not unpack: {e}"}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def seed(cwd="", kit="", env=None, home=None):
    """{ok, kit, seeded: [dirs], skipped: {dir: why}}: the kit into every config folder OpenCode would install it into."""
    path = kit_path(kit, env)
    dirs = config_dirs(cwd, env, home)
    out = {"ok": True, "kit": path, "seeded": [], "skipped": {}}
    for d in dirs:
        if not needs_kit(d):
            out["skipped"][d] = "has its own packages"
            continue
        if not path:
            out["skipped"][d] = "no plugin kit in this install"
            continue
        r = seed_dir(d, path)
        if r.get("seeded"):
            out["seeded"].append(d)
        else:
            out["skipped"][d] = r["skipped"]
    return out


def command(a):
    import json
    r = seed(cwd=getattr(a, "cwd", "") or "", kit=getattr(a, "kit", "") or "")
    if getattr(a, "json", False):
        print(json.dumps(r, ensure_ascii=False))
        return
    if not r["kit"] and not r["seeded"]:
        print("No OpenCode plugin kit in this install (it ships inside Dispatch IDE).")
    for d in r["seeded"]:
        print(f"OpenCode's plugin kit put in {d}")
    for d, why in r["skipped"].items():
        print(f"{d}: {why}")
