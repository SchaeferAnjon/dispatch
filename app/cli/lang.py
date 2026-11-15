# -*- coding: utf-8 -*-
"""The person's language for what Dispatch writes to them and to their agents (`dispatch language`).

The session brief, the answers of the commands agents run (`dispatch begin`, `dispatch browser` …) and the
summaries the cheap model writes follow it: English for an English speaker, Chinese for a Chinese one. The
Agents window itself is English while Dispatch is being built; this is about the words behind it.

Where it comes from, first match wins:
  1. DISPATCH_LANG (en | zh): tests, and anyone who wants to force it for one command
  2. ~/.dispatch/config.json "language" (en | zh), set with `dispatch language en|zh`; "auto" or nothing goes on
  3. Dispatch IDE's display language (~/.dispatch-ide/argv.json "locale"), when the person picked one
  4. the "Usual language" first-run setup wrote into the profile (PROFILE.md)
  5. the Mac's first preferred language (~/Library/Preferences/.GlobalPreferences.plist AppleLanguages)
  6. LANG / LC_ALL / LC_MESSAGES when they say Chinese
  7. English
Only English and Chinese are told apart for now; every other language gets English.
"""
import json
import os
import re
import sys

LANGS = ("en", "zh")
_cache = {}


def _home():
    return os.path.expanduser("~")


def _norm(value):
    v = str(value or "").strip().lower()
    if not v or v == "auto":
        return ""
    if v.startswith("zh") or "chinese" in v or "中文" in v or "汉语" in v or "普通话" in v:
        return "zh"
    if v.startswith("en") or "english" in v or "英文" in v or "英语" in v:
        return "en"
    return "en" if re.match(r"^[a-z]{2}(?:[-_].*)?$", v) else ""


def config_path():
    env = os.environ.get("DISPATCH_HOME", "").strip()
    root = os.path.abspath(os.path.expanduser(env)) if env else os.path.join(_home(), ".dispatch")
    return os.path.join(root, "config.json")


def _config():
    try:
        with open(config_path(), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _ide_locale():
    """argv.json is JSON with comments (VS Code writes `// …` lines into it)."""
    try:
        with open(os.path.join(_home(), ".dispatch-ide", "argv.json"), encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return ""
    text = re.sub(r"^\s*//.*$", "", text, flags=re.M)
    try:
        d = json.loads(text)
    except ValueError:
        m = re.search(r'"locale"\s*:\s*"([^"]+)"', text)
        return m.group(1) if m else ""
    return d.get("locale", "") if isinstance(d, dict) else ""


def _profile_language():
    for p in (os.path.join(_home(), ".dispatch", "rules", "PROFILE.md"), os.path.join(_home(), ".agents", "rules", "PROFILE.md")):
        try:
            with open(p, encoding="utf-8") as f:
                for line in f:
                    m = re.search(r"(?:Usual language|常用语言)\s*[:：]\s*(.+)", line)
                    if m:
                        return m.group(1).strip()
        except OSError:
            continue
    return ""


def _mac_language():
    if sys.platform != "darwin":
        return ""
    try:
        import plistlib
        with open(os.path.join(_home(), "Library", "Preferences", ".GlobalPreferences.plist"), "rb") as f:
            d = plistlib.load(f)
        langs = d.get("AppleLanguages") or []
        return langs[0] if langs else (d.get("AppleLocale") or "")
    except Exception:
        return ""


def _env_language():
    for k in ("LC_ALL", "LC_MESSAGES", "LANG"):
        v = os.environ.get(k, "")
        if v.lower().startswith("zh"):
            return "zh"
    return ""


def detect():
    """(language, where it came from)."""
    forced = _norm(os.environ.get("DISPATCH_LANG"))
    if forced:
        return forced, "DISPATCH_LANG"
    key = (_home(), config_path())
    if key in _cache:
        return _cache[key]
    found = ("en", "default")
    for source, read in (("setting", lambda: _config().get("language")), ("Dispatch IDE display language", _ide_locale),
                         ("profile", _profile_language), ("Mac language", _mac_language), ("environment", _env_language)):
        try:
            v = _norm(read())
        except Exception:
            v = ""
        if v:
            found = (v, source)
            break
    _cache[key] = found
    return found


def lang():
    """'en' or 'zh'."""
    return detect()[0]


def zh():
    return lang() == "zh"


def t(en, zh_text):
    """The English or the Chinese words, by the person's language."""
    return zh_text if lang() == "zh" else en


def has_cjk(text):
    return bool(re.search(r"[㐀-鿿豈-﫿]", str(text or "")))


def set_language(value):
    """`dispatch language en|zh|auto`: saved in ~/.dispatch/config.json."""
    v = str(value or "").strip().lower()
    if v not in ("en", "zh", "auto"):
        raise SystemExit("language must be en, zh or auto")
    p = config_path()
    d = _config()
    if v == "auto":
        d.pop("language", None)
    else:
        d["language"] = v
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, p)
    _cache.clear()
    return detect()


def command(a):
    if getattr(a, "value", ""):
        set_language(a.value)
    code, source = detect()
    if getattr(a, "json", False):
        print(json.dumps({"language": code, "source": source}))
    else:
        print({"en": "English", "zh": "Chinese (中文)"}[code] + f"  ({source})")


def add_parser(sub):
    s = sub.add_parser("language", help="the language Dispatch writes to you and your agents in (the session brief, command answers, summaries): "
                                         "`dispatch language` shows it and where it came from, `dispatch language en|zh` sets it, `auto` follows the Mac again")
    s.add_argument("value", nargs="?", default="", choices=["", "en", "zh", "auto"])
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=command)
