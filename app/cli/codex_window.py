# -*- coding: utf-8 -*-
"""Default to the largest context window a Codex model supports (task-3hc8, 2026-09-29).

Codex starts every model at `context_window` 272000 (auto-compacting near 95% of it) and only grows when
the user puts `model_context_window` in ~/.codex/config.toml. A new user never does, so Dispatch passes it:
`-c model_context_window=<max>` for `codex exec` workers, the same key in thread/start `config` for chatd's
app-server sessions (the Agents window's native host does it in its own patch). The user's own value wins:
when config.toml (top level or the active profile) sets one, nothing is passed. model_auto_compact_token_limit
is never set; Codex derives it.

Codex clamps the value to the model's `max_context_window` (codex-rs/models-manager/src/model_info.rs,
`with_config_overrides`: `context_window.min(max_context_window)`), so a value that is too large for the
model that ends up running is harmless; a model this table does not know gets nothing passed.

Sources of MAX_CONTEXT_WINDOW (checked 2026-09-29):
  * openai/codex, codex-rs/models-manager/models.json at 694d8d4 (2026-09-24): `max_context_window` per slug.
  * the live catalog Codex itself caches in $CODEX_HOME/models_cache.json (same fields; read first, so a model
    newer than this table still gets its real maximum once Codex has fetched the catalog).
  * Docs and posts on enabling 1M in Codex (config.toml `model_context_window = 1000000` for GPT-5.6 Sol and
    GPT-6 Astra; 1,050,000 tokens in the API): https://x.com/thsottiaux/status/2089082893804896524 and
    https://getunblocked.com/blog/codex-context-window/ . Codex's usable maximum is the catalog's 872000,
    which is 828400 after its 95% effective share (what the transcripts of workers with 1000000 configured show).
  * Cost: over 272K input tokens the API bills the whole request at 2x input and 1.5x output.
"""
import json
import os
import re

DEFAULT_WINDOW = 272000  # what Codex uses without `model_context_window`

# slug -> max_context_window. Models whose maximum equals DEFAULT_WINDOW (gpt-5.5) gain nothing and are left out.
MAX_CONTEXT_WINDOW = {
    "gpt-6-astra": 872000, "gpt-6-sol": 872000, "gpt-6-luna": 872000,
    "gpt-5.6-sol": 872000, "gpt-5.6-terra": 872000, "gpt-5.6-luna": 872000,
    "gpt-daybreak-blue-latest": 872000, "codex-auto-review": 872000,
    "gpt-daybreak-red-latest": 372000,
}


def codex_home():
    return os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")


def _config(home):
    try:
        with open(os.path.join(home, "config.toml"), encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return {}
    try:
        import toml_lite  # tomllib on 3.11+, a small reader on the Command Line Tools' 3.9
        return toml_lite.loads(text)
    except (ValueError, IndexError):
        return {}


def user_window(home=None):
    """The user's own model_context_window (top level or active profile), or None."""
    cfg = _config(home or codex_home())
    profile = (cfg.get("profiles") or {}).get(cfg.get("profile") or "", {})
    value = profile.get("model_context_window", cfg.get("model_context_window")) if isinstance(profile, dict) else cfg.get("model_context_window")
    return value if isinstance(value, int) and value > 0 else None


def catalog(home=None):
    """slug -> max_context_window from Codex's cached model catalog (empty when it has none yet)."""
    try:
        with open(os.path.join(home or codex_home(), "models_cache.json"), encoding="utf-8") as f:
            models = json.load(f).get("models") or []
    except (OSError, ValueError, AttributeError):
        return {}
    return {m["slug"]: m["max_context_window"] for m in models
            if isinstance(m, dict) and isinstance(m.get("slug"), str) and isinstance(m.get("max_context_window"), int)}


def window_for(model, home=None):
    """The window to pass, or None (user set one, unknown model, or nothing to gain).
    An empty model means "whatever Codex picks": the largest known value, which Codex clamps to that model."""
    home = home or codex_home()
    if user_window(home):
        return None
    known = dict(MAX_CONTEXT_WINDOW)
    known.update(catalog(home))
    if not model:
        cfg_model = _config(home).get("model")
        return window_for(cfg_model, home) if isinstance(cfg_model, str) and cfg_model else \
            (max(known.values()) if max(known.values()) > DEFAULT_WINDOW else None)
    size = known.get(model)
    return size if size and size > DEFAULT_WINDOW else None


def config_args(model, home=None):
    """`codex exec` arguments."""
    size = window_for(model, home)
    return ["-c", "model_context_window=%d" % size] if size else []


def thread_config(model, home=None):
    """thread/start | thread/resume `config` for the shared app-server daemon."""
    size = window_for(model, home)
    return {"model_context_window": size} if size else {}
