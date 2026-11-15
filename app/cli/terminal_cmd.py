# -*- coding: utf-8 -*-
"""`dispatch terminal agents | ghostty | daemon | snippets`: what the Agents window's terminal needs (dispatch-bridge's
`dispatch.terminal` calls these). Every answer is one JSON object.

    dispatch terminal agents                  the agents on this Mac that can run in a terminal: the command that starts
                                              each, and how it goes on after a restart or starts a copy (start/resume/fork)
    dispatch terminal ghostty                 what Dispatch's terminal would take from the person's Ghostty settings
    dispatch terminal daemon start|status|stop
                                              the process that keeps the terminals running while Dispatch is closed
                                              (terminal_daemon.py)
    dispatch terminal snippets list|add|update|remove
                                              words sent to agents often (snippets.py)
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def answer(op, a=None):
    sub = getattr(a, "sub", "") or ""
    if op == "daemon":
        import terminal_daemon
        return terminal_daemon.command(sub or "status", getattr(a, "app_root", "") or "", bool(getattr(a, "if_kept", False)))
    if op == "snippets":
        import snippets
        return snippets.command(sub or "list", getattr(a, "id", "") or "", getattr(a, "name", None), getattr(a, "text", None))
    if op == "agents":
        import terminal_agents
        return {"ok": True, "agents": terminal_agents.rows()}
    if op == "ghostty":
        import ghostty_import
        return dict(ghostty_import.preview(), ok=True)
    return {"ok": False, "message": "dispatch terminal agents | ghostty | daemon | snippets"}


def command(a):
    out = answer(getattr(a, "op", ""), a)
    if getattr(a, "json", False) or not out["ok"] or a.op in ("daemon", "snippets"):
        print(json.dumps(out, ensure_ascii=False))
        sys.exit(0 if out["ok"] else 2)
    if a.op == "agents":
        for r in out["agents"]:
            print(f"{'on ' if r['enabled'] else 'off'} {r['name']:<20} {r['command']}")
    else:
        if not out["found"]:
            print("No Ghostty settings found.")
        else:
            s = out["summary"]
            print(f"Ghostty settings: {', '.join(out['paths'])}\nfont {s['font'] or '-'} {s['size'] or ''}  theme {s['theme'] or '-'}  cursor {s['cursor'] or '-'}")
