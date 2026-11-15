# -*- coding: utf-8 -*-
"""Small things the first-run wizard and Customizations do on this Mac.

    dispatch first-run notify-test        show a banner on this Mac (macOS asks to allow notifications the first time)
    dispatch first-run notify-settings    open System Settings at Notifications

The banner is the one Dispatch shows when an agent finishes or needs you and no phone channel is set up
(notify_watch.py, setting notify_desktop). `--json` answers {ok, message}.
"""
import json
import os
import subprocess
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
SETTINGS_URL = "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
TEST_TITLE = "Dispatch"
TEST_BODY = "Notifications are on. You will see one like this when an agent finishes or needs you."


def banners_muted():
    """A file `no-banners` in the Dispatch folder (test instances): the banner is not shown, the answer is the same."""
    d = os.environ.get("DISPATCH_DIR")
    if not d:
        if HERE not in sys.path:
            sys.path.insert(0, HERE)
        import engines
        d = engines.DISPATCH_DIR
    return os.path.exists(os.path.join(d, "no-banners"))


def notify_test(send=None):
    if sys.platform != "darwin":
        return {"ok": False, "message": "Banners are only shown on a Mac for now."}
    if send is None and banners_muted():
        return {"ok": True, "message": "A banner was sent. If you did not see it, open Notification settings and allow Dispatch."}
    if send is None:
        if HERE not in sys.path:
            sys.path.insert(0, HERE)
        import notify
        send = notify._local
    try:
        send(TEST_TITLE, TEST_BODY)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": f"The banner could not be shown: {str(e)[:120]}"}
    return {"ok": True, "message": "A banner was sent. If you did not see it, open Notification settings and allow Dispatch."}


def notify_settings(run=None):
    if sys.platform != "darwin":
        return {"ok": False, "message": "System Settings is only on a Mac."}
    r = (run or subprocess.run)(["open", SETTINGS_URL], capture_output=True, text=True, timeout=10)
    return {"ok": r.returncode == 0, "message": "System Settings is open." if r.returncode == 0 else "System Settings could not be opened."}


def command(a):
    out = notify_test() if a.op == "notify-test" else notify_settings()
    print(json.dumps(out, ensure_ascii=False) if getattr(a, "json", False) else out["message"], file=sys.stdout if out["ok"] else sys.stderr)
    sys.exit(0 if out["ok"] else 1)
