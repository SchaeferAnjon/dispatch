"""A Mac where every copy of OpenCode is older than Dispatch needs (oc-version-old): the instance gets a HOME of its
own whose ~/.opencode/bin holds only a fake `opencode` (the scenario writes what it says), and the folders the real
OpenCode lives in are taken off its PATH, so `dispatch engines check` finds nothing else. Nothing of the person's
OpenCode is read or changed.

  <instance>/ocv-home/.opencode/bin/opencode   the fake (oc-version-old.mjs FAKE: 1.14.31, `upgrade` bumps it)
"""
import os
import shutil

FOLDERS = (".opencode/bin", ".local/bin", ".bun/bin", ".npm-global/bin", "npm-global/bin")
# there from the start, as the scenario writes it (oc-version-old.mjs FAKE): the window reads the version when it starts
FAKE = """#!/bin/sh
# fake opencode for the version-gate test
VERSION=1.14.31
case "$1" in
  --version) echo "$VERSION" ;;
  models) echo deepseek/deepseek-flash ;;
  upgrade)
    if [ -e "$HOME/fail-upgrade" ]; then echo "upgrade failed (fake)" >&2; exit 1; fi
    if [ -e "$HOME/slow-upgrade" ]; then sleep 9; fi
    sed 's/^VERSION=.*/VERSION=1.18.32/' "$0" > "$0.new" && chmod 755 "$0.new" && mv "$0.new" "$0" ;;
  *) echo "fake opencode: $*" >&2; exit 1 ;;
esac
"""


def prepare(rec):
    home = os.path.join(rec["root"], "ocv-home")
    os.makedirs(os.path.join(home, ".opencode", "bin"), exist_ok=True)
    fake = os.path.join(home, ".opencode", "bin", "opencode")
    with open(fake, "w", encoding="utf-8") as f:
        f.write(FAKE)
    os.chmod(fake, 0o755)
    real = os.path.expanduser("~")
    # every folder a real OpenCode may be in: the usual ones and wherever this Mac's PATH finds one
    drop = {os.path.join(real, f) for f in FOLDERS}
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if d and os.path.isfile(os.path.join(d, "opencode")):
            drop.add(d)
    found = shutil.which("opencode", path=os.pathsep.join(d for d in os.environ.get("PATH", "").split(os.pathsep) if d not in drop))
    if found:
        drop.add(os.path.dirname(found))
    # updates from the official servers, as on a Mac whose npm answers: on "auto" a Mac where the npm check fails turns
    # OpenCode's own updater into an npm install from the mirrors in China, and the fake is never asked (net.py, mirrors.py)
    net = os.path.join(rec["dispatch_dir"], "net.json")
    os.makedirs(os.path.dirname(net), exist_ok=True)
    with open(net, "w", encoding="utf-8") as f:
        f.write('{"mirror": "official"}\n')
    # the other agents as they are (the scenario compares the input with another one picked): links in a folder of
    # their own, so the folder the real OpenCode shares with them (Homebrew's) stays out
    others = os.path.join(home, "other-agents")
    os.makedirs(others, exist_ok=True)
    for name in ("codex", "claude"):
        real = shutil.which(name, path=os.environ.get("PATH", "") + os.pathsep + "/opt/homebrew/bin:/usr/local/bin:" + os.path.join(os.path.expanduser("~"), ".local", "bin"))
        if real and not os.path.lexists(os.path.join(others, name)):
            os.symlink(os.path.realpath(real), os.path.join(others, name))
    # and nothing from the places Dispatch looks in besides these (Homebrew, npm, bun): the Mac has only the old copy
    return {"env": {"HOME": home, "OCV_HOME": home, "PATH_DROP": os.pathsep.join(sorted(drop)), "DISPATCH_ENGINE_PATH": os.pathsep.join([os.path.join(home, ".opencode", "bin"), others]),
                    "PATH_PREPEND": os.path.join(home, ".opencode", "bin")},
            "record": {"ocv_home": home}}
