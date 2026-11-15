# -*- coding: utf-8 -*-
"""GitHub Copilot CLI: `copilot`. Dispatch recognizes it, opens it in its terminal, and tells whether it is signed in."""
import json
import os

from engines.base import Engine


class Copilot(Engine):
    id = "copilot"
    name = "GitHub Copilot CLI"
    short_name = "Copilot"
    icon = "copilot"
    provider = "copilotcli"  # the Agents window's session provider for it
    about = "GitHub's coding assistant. Needs a GitHub Copilot plan."
    bins = ("copilot",)
    install_hint = "npm i -g @github/copilot"
    commit_trailer = "Copilot <noreply@github.com>"

    def sign_in_local(self, home, env):
        try:
            with open(os.path.join(env.get("COPILOT_HOME") or os.path.join(home, ".copilot"), "config.json"), encoding="utf-8") as f:
                cfg = json.load(f)
        except (OSError, ValueError):
            cfg = {}
        cfg = cfg if isinstance(cfg, dict) else {}
        if cfg.get("logged_in_users") or cfg.get("last_logged_in_user") or cfg.get("copilot_tokens"):
            return "Signed in with GitHub"
        if env.get("COPILOT_GITHUB_TOKEN") or env.get("GH_TOKEN") or env.get("GITHUB_TOKEN"):
            return "Using a GitHub token"
        return "Not signed in"


ENGINE = Copilot()
