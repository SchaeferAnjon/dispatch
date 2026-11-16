"""A HOME of its own with an empty key store, for scenarios/point-talk-keys.mjs (meta.instance.fixture "soniox-home"):
no SONIOX_API_KEY and no other key, so Point and talk's camera brings the key card and Settings › Keys starts empty.
The app, its CLI and its terminals read and write <instance>/soniox-home/.config/dispatch/env, never the person's own
key store. Every value the scenario saves there is made up.
"""
import os
import shutil


def prepare(rec):
    home = os.path.join(rec["root"], "soniox-home")
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(os.path.join(home, ".config", "dispatch"), mode=0o700)
    # point_talk.py falls back to the process environment when the store has none: a SONIOX_API_KEY exported in the
    # shell that runs the test would reach the instance and skip the card
    return {"env": {"HOME": home, "SONIOX_API_KEY": ""}, "record": {"keys_home": home}}
