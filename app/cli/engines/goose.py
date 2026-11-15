# -*- coding: utf-8 -*-
"""Goose (Block): `goose`. Dispatch recognizes it, opens it in its terminal, and tells which AI service it uses."""
import os
import re

from engines.base import Engine


class Goose(Engine):
    id = "goose"
    name = "Goose"
    about = "Block's free, open-source assistant. You connect your own AI service."
    bins = ("goose",)
    install_hint = "brew install block-goose-cli"
    reject_real = "/Cellar/goose/"     # Homebrew's other `goose` (the database migration tool)
    reject_output = "goose version:"

    def sign_in_local(self, home, env):
        try:
            with open(os.path.join(env.get("XDG_CONFIG_HOME") or os.path.join(home, ".config"), "goose", "config.yaml"), encoding="utf-8") as f:
                m = re.search(r"^GOOSE_PROVIDER:\s*['\"]?([\w.-]+)", f.read(), re.M)
            return f"Uses {m.group(1)}" if m else "Not set up yet"
        except OSError:
            return "Not set up yet"


ENGINE = Goose()
