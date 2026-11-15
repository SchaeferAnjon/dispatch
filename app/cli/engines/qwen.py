# -*- coding: utf-8 -*-
"""Qwen Code (Alibaba): `qwen`, a fork of Gemini CLI that keeps its settings in ~/.qwen the same way."""
from engines.base import Engine


class Qwen(Engine):
    id = "qwen"
    name = "Qwen Code"
    about = "Alibaba's coding assistant. Sign in with a Qwen account or use your own key."
    bins = ("qwen",)
    install_hint = "npm i -g @qwen-code/qwen-code"

    def sign_in_local(self, home, env):
        from engines.gemini import settings_sign_in
        return settings_sign_in(home, env, ".qwen", "Signed in", "OPENAI_API_KEY")


ENGINE = Qwen()
