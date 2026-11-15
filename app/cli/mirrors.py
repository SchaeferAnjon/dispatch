# -*- coding: utf-8 -*-
"""Where Dispatch downloads from: the official servers, or public mirrors in China when those do not answer.

The setting `mirror` in DISPATCH_DIR/net.json (`dispatch net set mirror …`, Settings > Network):
    auto      (default) the official servers; the mirrors when the last check (net.py) found npm out of reach, and
              again for an install that failed on the official server with a connection error
    official  always the official servers
    china     always the mirrors

Only public mirrors run by universities and large companies, the ones their own documentation tells people in China to
use: npmmirror (Alibaba) for npm packages, Playwright's browser and the engines published on npm (Claude Code,
Codex, OpenCode), Tsinghua University's TUNA for Python packages and Homebrew. Nothing here changes a file of the
person's: the mirror goes into the one command's environment or arguments.
"""
import os
import sys

sys.dont_write_bytecode = True

MODES = ("auto", "official", "china")
NPM_OFFICIAL = "https://registry.npmjs.org"
NPM_CHINA = "https://registry.npmmirror.com"
PYPI_OFFICIAL = "https://pypi.org/simple"
PYPI_CHINA = "https://pypi.tuna.tsinghua.edu.cn/simple"
TUNA = "https://mirrors.tuna.tsinghua.edu.cn"
HOMEBREW_CHINA = {
    "HOMEBREW_API_DOMAIN": TUNA + "/homebrew-bottles/api",
    "HOMEBREW_BOTTLE_DOMAIN": TUNA + "/homebrew-bottles",
    "HOMEBREW_BREW_GIT_REMOTE": TUNA + "/git/homebrew/brew.git",
    "HOMEBREW_CORE_GIT_REMOTE": TUNA + "/git/homebrew/homebrew-core.git",
    "HOMEBREW_PIP_INDEX_URL": PYPI_CHINA,
}
PLAYWRIGHT_CHINA = NPM_CHINA + "/-/binary/playwright"
# Homebrew's own installer from TUNA's copy (its documentation: mirrors.tuna.tsinghua.edu.cn/help/homebrew)
HOMEBREW_INSTALL_CHINA = ('export HOMEBREW_BREW_GIT_REMOTE="' + HOMEBREW_CHINA["HOMEBREW_BREW_GIT_REMOTE"] + '" HOMEBREW_CORE_GIT_REMOTE="'
                          + HOMEBREW_CHINA["HOMEBREW_CORE_GIT_REMOTE"] + '" HOMEBREW_API_DOMAIN="' + HOMEBREW_CHINA["HOMEBREW_API_DOMAIN"]
                          + '" HOMEBREW_BOTTLE_DOMAIN="' + HOMEBREW_CHINA["HOMEBREW_BOTTLE_DOMAIN"] + '"; git clone --depth=1 '
                          + TUNA + '/git/homebrew/install.git /tmp/brew-install && /bin/bash /tmp/brew-install/install.sh')
TEXT = {
    "official": "Official servers (npm, PyPI, Homebrew)",
    "china": "Mirrors in China (npmmirror, Tsinghua TUNA)",
}


def mode(cfg=None):
    if cfg is None:
        import net
        cfg = net.load()
    m = cfg.get("mirror") if isinstance(cfg, dict) else cfg
    return m if m in MODES else "auto"


def effective(setting, results=None):
    """{use: official|china, text, reason}: what the next download uses. `results`: net.check()'s (npm's row decides)."""
    if setting == "china":
        return {"use": "china", "text": TEXT["china"], "reason": "set"}
    if setting == "official":
        return {"use": "official", "text": TEXT["official"], "reason": "set"}
    npm = (results or {}).get("npm")
    if npm is not None and not npm.get("ok"):
        return {"use": "china", "text": TEXT["china"] + ", because npm did not answer", "reason": "auto"}
    return {"use": "official", "text": TEXT["official"] + ", mirrors in China when they do not answer", "reason": "auto"}


def use_china(setting=None, results=None, ask=None):
    """Whether the next download goes to the mirrors. auto with no check yet asks npm once (a few seconds)."""
    setting = mode() if setting is None else setting
    if setting != "auto":
        return setting == "china"
    if results is None:
        import net
        try:
            results = (ask or net.check)(only=["npm"]).get("results") or {}
        except Exception:  # noqa: BLE001 - when the check itself fails, the official server is tried
            results = {}
    return effective(setting, results)["use"] == "china"


def npm_registry(china):
    return NPM_CHINA if china else NPM_OFFICIAL


def env(china):
    """Variables for one install command: npm, pip, Homebrew and Playwright read these."""
    if not china:
        return {}
    return {"npm_config_registry": NPM_CHINA, "NPM_CONFIG_REGISTRY": NPM_CHINA, "PIP_INDEX_URL": PYPI_CHINA,
            "PLAYWRIGHT_DOWNLOAD_HOST": PLAYWRIGHT_CHINA, **HOMEBREW_CHINA}


def with_registry(argv, china):
    """An npm / bun / pnpm install command with the mirror's registry; other commands unchanged."""
    if not china or not argv:
        return list(argv)
    prog = os.path.basename(argv[0])
    if prog in ("npm", "pnpm") and any(a in ("i", "install", "add", "update", "up") for a in argv[1:3]):
        return [*argv, "--registry", NPM_CHINA]
    if prog == "bun" and len(argv) > 1 and argv[1] in ("add", "install", "i", "update"):
        return [*argv, "--registry", NPM_CHINA]
    return list(argv)


def pip_args(china):
    return ["-i", PYPI_CHINA] if china else []


def install_env(china, base=None):
    """The environment for one download command: this Mac's proxy (net.py) and, for the mirrors, their variables."""
    import net
    e = net.apply(dict(os.environ if base is None else base))
    e.update(env(china))
    return e


def run_with_mirrors(run, build, setting=None):
    """Run a download: `build(china)` → (argv, env); `run(argv, env)` → (code, out, err). auto: the official server
    first and, when that fails, once more from the mirrors. Returns the last (code, out, err)."""
    setting = mode() if setting is None else setting
    china = use_china(setting)
    res = run(*build(china))
    if res[0] != 0 and not china and setting == "auto":
        res = run(*build(True))
    return res
