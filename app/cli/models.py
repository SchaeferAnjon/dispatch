# -*- coding: utf-8 -*-
"""Models an agent can be started with (`dispatch models`), read from where each agent's own maker publishes them, so a
new release shows up without an app update. Each engine reads its own (its adapter's models(), engines/): Claude Code
from Anthropic's model list with its login, Codex from the list it fetches for the ChatGPT account, pi its configured
default only.

An option's `id` is what goes after `--model`; "" means the agent's own default."""
import dispatch as D
import engines as E


def catalog(refresh=False):
    """{engine id: options} of every engine that can list its models."""
    return {e.id: e.models(refresh) for e in E.known() if e.supports("models")}


def command(a):
    r = catalog(getattr(a, "refresh", False))
    only = getattr(a, "agent", "") or ""
    if only:
        r = {k: v for k, v in r.items() if k == E.id_of(only)}

    def text(r):
        for kind, opts in r.items():
            print(kind)
            for o in opts:
                print(f"  {o['id'] or '（默认）':<28} {o['label']}" + ("" if o.get("latest", True) else "  · 旧"))
    D.out(r, a.json, text)
