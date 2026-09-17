# -*- coding: utf-8 -*-
"""Names of Dispatch's LaunchAgents.

New installs use `dev.dispatch.<name>`. Macs set up before the rename carry `dev.schaefer.<name>`
jobs (the board's Dolt server, the sync timer, the phone service…): those keep their label for as
long as their plist exists, so an update never restarts a working daemon just to rename it.
"""
import os

PREFIX = "dev.dispatch"
OLD_PREFIX = "dev.schaefer"
LAUNCH_DIR = os.path.join(os.path.expanduser("~"), "Library", "LaunchAgents")


def label(name, launch_dir=None):
    old = f"{OLD_PREFIX}.{name}"
    if os.path.exists(os.path.join(launch_dir or LAUNCH_DIR, old + ".plist")):
        return old
    return f"{PREFIX}.{name}"
