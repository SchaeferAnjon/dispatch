# -*- coding: utf-8 -*-
"""What reaches you on this Mac when an agent finishes, needs you or stops: which of the three kinds the bell
(inbox.py) also shows as a banner, and the sound it plays. Settings › Notifications in the Agents window
changes them; the window's own banners, the bell's and chatd's background banners (notify_watch.py) all follow.

    notify_mac_finished   1   a banner when an agent finished its turn
    notify_mac_needs_you  1   a banner when an agent waits for your OK or an answer
    notify_mac_stopped    0   a banner when an agent stopped without finishing (an error, a usage limit, its
                              process ended); off by default: the bell lists it either way
    notify_sound          "default" (the Mac's own alert sound), "none", or one of the Mac's sounds by name

    dispatch inbox prefs --json          {finished, needs_you, stopped, sound, sounds: [names], desktop}
    dispatch inbox sound [<name>]        play it (the current one when no name is given)
"""
import os
import subprocess
import sys

sys.dont_write_bytecode = True

KINDS = ("finished", "needs_you", "stopped")
KEYS = {"finished": "notify_mac_finished", "needs_you": "notify_mac_needs_you", "stopped": "notify_mac_stopped"}
DEFAULTS = {"notify_mac_finished": 1, "notify_mac_needs_you": 1, "notify_mac_stopped": 0, "notify_sound": "default"}
SOUNDS_DIR = "/System/Library/Sounds"
# What macOS ships; read from the folder when it is there, this list when it is not (another system, tests)
KNOWN_SOUNDS = ("Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink")
SPECIAL = ("default", "none")


def sounds(folder=SOUNDS_DIR):
    """The Mac's sounds by name, as Sound settings lists them."""
    try:
        names = sorted({os.path.splitext(f)[0] for f in os.listdir(folder) if f.lower().endswith((".aiff", ".aif", ".caf", ".wav"))})
    except OSError:
        names = []
    return names or list(KNOWN_SOUNDS)


def normal_sound(name, known=None):
    """A stored sound name made safe: one of SPECIAL or a known sound, else "default"."""
    n = str(name or "").strip()
    if n.lower() in SPECIAL:
        return n.lower()
    known = known if known is not None else sounds()
    return next((k for k in known if k.lower() == n.lower()), "default")


def alert_sound():
    """The file of the Mac's own alert sound (Sound settings › Alert sound), or ""."""
    try:
        r = subprocess.run(["defaults", "read", "-g", "com.apple.sound.beep.sound"], capture_output=True, text=True, timeout=3)
        p = r.stdout.strip()
        if p and os.path.isfile(p):
            return p
    except (OSError, subprocess.SubprocessError):
        pass
    for name in ("Tink", "Funk", "Glass"):
        p = sound_file(name)
        if p:
            return p
    return ""


def sound_file(name, folder=SOUNDS_DIR):
    """The file to play for a sound name; "" for none."""
    n = str(name or "").strip()
    if not n or n.lower() == "none":
        return ""
    if n.lower() == "default":
        return alert_sound()
    for ext in (".aiff", ".aif", ".caf", ".wav"):
        p = os.path.join(folder, n + ext)
        if os.path.isfile(p):
            return p
    return ""


def play(name, spawn=None):
    """Play a sound without waiting for it. Returns {ok, sound, file}."""
    n = normal_sound(name)
    f = sound_file(n)
    if not f:
        return {"ok": n == "none", "sound": n, "file": ""}
    try:
        (spawn or (lambda argv: subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)))(["afplay", f])
        return {"ok": True, "sound": n, "file": f}
    except OSError as e:
        return {"ok": False, "sound": n, "file": f, "error": str(e)[:200]}


def _on(settings, key):
    v = settings.get(key, DEFAULTS[key])
    try:
        return int(v) != 0
    except (TypeError, ValueError):
        return bool(v)


def wants(settings, kind):
    """Whether a kind shows a banner on this Mac."""
    return _on(settings or {}, KEYS[kind]) if kind in KEYS else False


def prefs(settings, known=None):
    s = settings or {}
    known = known if known is not None else sounds()
    out = {k: wants(s, k) for k in KINDS}
    out["sound"] = normal_sound(s.get("notify_sound", DEFAULTS["notify_sound"]), known)
    out["sounds"] = known
    try:
        out["desktop"] = int(s.get("notify_desktop", 0) or 0) != 0
    except (TypeError, ValueError):
        out["desktop"] = False
    return out


def applescript_sound(name):
    """The `sound name "…"` part of an AppleScript notification for a sound setting ("" = no sound)."""
    n = normal_sound(name)
    if n == "none":
        return ""
    if n == "default":
        f = alert_sound()
        n = os.path.splitext(os.path.basename(f))[0] if f else "Tink"
    return f' sound name "{n}"'
