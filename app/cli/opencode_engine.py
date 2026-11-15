# -*- coding: utf-8 -*-
"""OpenCode, the third engine (`dispatch engines status opencode`): what the Agents window's OpenCode
page and account menu show about it, read from OpenCode's own files. Nothing here changes OpenCode:
models, providers, keys and permissions stay in its config (~/.config/opencode/opencode.json) and
its credentials (~/.local/share/opencode/auth.json, written by `opencode auth login`).

- providers: every provider OpenCode can use and where its key comes from (auth.json API key or
  OAuth login, an environment variable such as ZHIPU_API_KEY, the config file, or none needed for
  OpenCode Zen's free models). Only whether there is a key and where it is; never the key.
- default_model: the `model` of its global config.
- quota: what a provider tells about the key's allowance, for the providers that have an endpoint
  for it (DeepSeek's balance, Zhipu AI Coding Plan's 5-hour and weekly limits). Cached for five
  minutes in DISPATCH_DIR/opencode-quota.json. Two providers reporting the very same allowance (two
  keys of one account, as Zhipu's and Z.AI's coding plans can be) are one account: the second one
  says `same_quota_as` the first, and the account menus show it once.
- plugin: whether Dispatch's OpenCode plugin (agent/opencode/dispatch.js: the session id for
  `dispatch` in OpenCode's shell, the todo list as the task's plan) is installed.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import engines

HOME = os.path.expanduser("~")
QUOTA_TTL = 300
# models.dev's provider ids of the providers whose allowance has an endpoint
DEEPSEEK = "deepseek"
ZHIPU_CODING = ("zhipuai-coding-plan", "zai-coding-plan")
# Zhipu's quota `unit`: the window's time unit (3 hours, 4 days, 5 months, 6 weeks)
ZHIPU_UNITS = {1: "minute", 2: "minute", 3: "hour", 4: "day", 5: "month", 6: "week"}
PLUGIN_NAME = "dispatch.js"
PLUGIN_SOURCE = next((p for p in (
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "agent", "opencode", PLUGIN_NAME),
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "agent", "opencode", PLUGIN_NAME),
) if os.path.isfile(p)), "")


def paths(env=None):
    """OpenCode's folders; it follows the XDG variables on every platform."""
    env = os.environ if env is None else env
    return {
        "config": os.path.join(env.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config"), "opencode"),
        "data": os.path.join(env.get("XDG_DATA_HOME") or os.path.join(HOME, ".local", "share"), "opencode"),
        "cache": os.path.join(env.get("XDG_CACHE_HOME") or os.path.join(HOME, ".cache"), "opencode"),
    }


def strip_jsonc(text):
    """JSON with // and /* */ comments and trailing commas → JSON (strings left alone)."""
    out, i, n, in_str = [], 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
        else:
            out.append(c)
            i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def read_json(path, jsonc=False):
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return None
    try:
        value = json.loads(strip_jsonc(text) if jsonc else text)
    except ValueError:
        try:
            value = json.loads(strip_jsonc(text))
        except ValueError:
            return None
    return value if isinstance(value, dict) else None


def config_files(env=None):
    """The global config files OpenCode merges, lowest precedence first (and OPENCODE_CONFIG)."""
    env = os.environ if env is None else env
    d = paths(env)["config"]
    files = [os.path.join(d, "config.json"), os.path.join(d, "opencode.json"), os.path.join(d, "opencode.jsonc")]
    if env.get("OPENCODE_CONFIG"):
        files.append(env["OPENCODE_CONFIG"])
    return files


def config_file(env=None):
    """The file the OpenCode page opens and writes the default model into: the global config that
    exists (opencode.jsonc before opencode.json before config.json), else opencode.json."""
    d = paths(env)["config"]
    for name in ("opencode.jsonc", "opencode.json", "config.json"):
        p = os.path.join(d, name)
        if os.path.isfile(p):
            return p
    return os.path.join(d, "opencode.json")


def merged_config(env=None):
    env = os.environ if env is None else env
    merged = {}
    for p in config_files(env):
        c = read_json(p, jsonc=True)
        if c:
            providers = dict(merged.get("provider") or {})
            providers.update(c.get("provider") or {})
            merged.update(c)
            merged["provider"] = providers
    if env.get("OPENCODE_CONFIG_CONTENT"):
        try:
            c = json.loads(strip_jsonc(env["OPENCODE_CONFIG_CONTENT"]))
            if isinstance(c, dict):
                merged.update(c)
        except ValueError:
            pass
    return merged


def catalog(env=None):
    """models.dev's providers as OpenCode caches them: {id: {name, env: [VAR, ...]}}."""
    data = read_json(os.path.join(paths(env)["cache"], "models.json")) or {}
    out = {}
    for pid, p in data.items():
        if isinstance(p, dict):
            out[pid] = {"name": str(p.get("name") or pid), "env": [e for e in p.get("env") or [] if isinstance(e, str)]}
    return out


def auth(env=None):
    """{provider id: login type} from OpenCode's credentials; the values are never read out."""
    data = read_json(os.path.join(paths(env)["data"], "auth.json")) or {}
    return {pid: str((v or {}).get("type") or "api") for pid, v in data.items() if isinstance(v, dict)}


def providers(env=None, cat=None, logins=None, config=None):
    """[{id, name, sources: [{kind, detail}]}]: every provider that has a key or a login, and OpenCode
    Zen, whose free models need none. kind is api | oauth | env | config | free."""
    env = os.environ if env is None else env
    cat = catalog(env) if cat is None else cat
    logins = auth(env) if logins is None else logins
    config = merged_config(env) if config is None else config
    rows = {}

    def add(pid, kind, detail=""):
        name = ((config.get("provider") or {}).get(pid) or {}).get("name") or (cat.get(pid) or {}).get("name") or pid
        row = rows.setdefault(pid, {"id": pid, "name": name, "sources": []})
        if not any(s["kind"] == kind and s["detail"] == detail for s in row["sources"]):
            row["sources"].append({"kind": kind, "detail": detail})

    for pid, kind in logins.items():
        add(pid, "oauth" if kind == "oauth" else "api", "auth.json")
    for pid, p in cat.items():
        for var in p["env"]:
            if env.get(var):
                add(pid, "env", var)
                break
    for pid, p in (config.get("provider") or {}).items():
        options = (p or {}).get("options") or {}
        if isinstance(options, dict) and options.get("apiKey"):
            add(pid, "config", "opencode.json")
    add("opencode", "free", "")  # OpenCode Zen: its free models need no key
    zen = rows["opencode"]
    if len(zen["sources"]) > 1:
        zen["sources"] = [s for s in zen["sources"] if s["kind"] != "free"]
    return sorted(rows.values(), key=lambda r: r["name"].lower())


# ---------------------------------------------------------------- allowance

def _key(pid, env):
    try:
        with open(os.path.join(paths(env)["data"], "auth.json"), encoding="utf-8") as f:
            v = (json.load(f) or {}).get(pid) or {}
    except (OSError, ValueError):
        v = {}
    if v.get("key"):
        return v["key"]
    for var in (catalog(env).get(pid) or {}).get("env") or []:
        if env.get(var):
            return env[var]
    return ""


def _get(url, headers, timeout=10):
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "dispatch-cli", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def deepseek_balance(data):
    """DeepSeek's /user/balance → quota rows: one per currency with money on it."""
    rows = []
    for b in (data or {}).get("balance_infos") or []:
        try:
            total = float(b.get("total_balance") or 0)
        except (TypeError, ValueError):
            continue
        if total > 0 or not rows:
            rows.append({"kind": "balance", "label": "Balance", "amount": round(total, 2), "currency": b.get("currency") or ""})
    rows = [r for r in rows if r["amount"] > 0] or rows[:1]
    return rows


def zhipu_limits(data):
    """Zhipu AI Coding Plan's quota/limit → rows: the plan level and each window's used percent."""
    d = (data or {}).get("data") or {}
    rows = []
    for lim in d.get("limits") or []:
        unit = ZHIPU_UNITS.get(lim.get("unit"))
        number = lim.get("number") or 1
        if not unit:
            continue
        window = f"{number}-{unit}" if number != 1 else {"hour": "hourly", "day": "daily", "week": "weekly", "month": "monthly"}.get(unit, unit)
        resets = lim.get("nextResetTime")
        rows.append({"kind": "window", "label": window, "used_percent": lim.get("percentage"),
                     "resets_at": int(resets / 1000) if isinstance(resets, (int, float)) and resets > 1e11 else resets,
                     "plan": str(d.get("level") or "")})
    return rows


def fetch_quota(pid, env=None, get=_get):
    env = os.environ if env is None else env
    key = _key(pid, env)
    if not key:
        return []
    if pid == DEEPSEEK:
        return deepseek_balance(get("https://api.deepseek.com/user/balance", {"Authorization": f"Bearer {key}"}))
    if pid in ZHIPU_CODING:
        host = "open.bigmodel.cn" if pid == "zhipuai-coding-plan" else "api.z.ai"
        return zhipu_limits(get(f"https://{host}/api/monitor/usage/quota/limit", {"Authorization": key}))
    return []


def quota(provider_ids, env=None, refresh=False, now=None, get=_get):
    """{provider id: [rows]} for the providers that can tell, cached for QUOTA_TTL seconds."""
    env = os.environ if env is None else env
    now = time.time() if now is None else now
    cache_path = os.path.join(engines.DISPATCH_DIR, "opencode-quota.json")
    try:
        with open(cache_path) as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    wanted = [p for p in provider_ids if p == DEEPSEEK or p in ZHIPU_CODING]
    out, changed = {}, False
    for pid in wanted:
        hit = cache.get(pid) or {}
        if not refresh and now - float(hit.get("at") or 0) < QUOTA_TTL:
            out[pid] = hit.get("rows") or []
            continue
        try:
            rows = fetch_quota(pid, env, get)
        except (urllib.error.URLError, OSError, ValueError, TimeoutError):
            rows = hit.get("rows") or []
        out[pid] = rows
        cache[pid] = {"at": now, "rows": rows}
        changed = True
    if changed:
        try:
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            tmp = cache_path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(cache, f)
            os.replace(tmp, cache_path)
        except OSError:
            pass
    return out


# ---------------------------------------------------------------- the plugin

def plugin_path(env=None):
    return os.path.join(paths(env)["config"], "plugins", PLUGIN_NAME)


def plugin_state(env=None):
    """installed: something is at the plugin's place; current: it is Dispatch's plugin as this install ships it."""
    p = plugin_path(env)
    installed = os.path.lexists(p)
    current = False
    if installed and PLUGIN_SOURCE:
        try:
            if os.path.islink(p):
                current = os.path.realpath(p) == os.path.realpath(PLUGIN_SOURCE)
            else:
                with open(p, encoding="utf-8") as a, open(PLUGIN_SOURCE, encoding="utf-8") as b:
                    current = a.read() == b.read()
        except OSError:
            current = False
    return {"installed": installed, "current": current, "path": p}


def install_plugin(path=None, source=None, env=None, link=True):
    """Put Dispatch's OpenCode plugin where OpenCode loads plugins from (its config's plugins/ folder):
    a link to the file this install ships (as ~/.pi/agent/extensions/dispatch.ts is for pi), so it
    follows Dispatch's updates; a copy where links are not possible. What was there before, if it
    is not already Dispatch's plugin, is kept in ~/.dispatch/backups/<date>/."""
    source = source or PLUGIN_SOURCE
    path = path or plugin_path(env)
    if not source or not os.path.isfile(source):
        return {"path": path, "skipped": "the plugin source is not in this install"}
    if not os.path.isdir(os.path.dirname(os.path.dirname(path))):
        return {"path": path, "skipped": "no OpenCode config folder"}
    if os.path.islink(path) and os.path.realpath(path) == os.path.realpath(source):
        return {"path": path, "unchanged": True, "link": True, **_with_kit(env)}
    with open(source, encoding="utf-8") as f:
        text = f.read()
    old = None
    if os.path.lexists(path):
        try:
            with open(path, encoding="utf-8") as f:
                old = f.read()
        except OSError:
            old = ""
    if old == text and not link:
        return {"path": path, "unchanged": True, **_with_kit(env)}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    backup = ""
    if old is not None and old != text:
        import backups
        backup = backups.save(path)
    tmp = path + ".dispatch-tmp"
    if os.path.lexists(tmp):
        os.unlink(tmp)
    linked = False
    if link:
        try:
            os.symlink(os.path.realpath(source), tmp)
            linked = True
        except (OSError, NotImplementedError):
            linked = False
    if not linked:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
    os.replace(tmp, path)
    return {"path": path, "link": linked, "backup": backup, **_with_kit(env)}


def _with_kit(env):
    """With a plugin in place OpenCode waits for its plugin kit from npm before the first answer (minutes when
    npm cannot be reached): Dispatch IDE's copy goes into its config folders now (opencode_kit.py)."""
    try:
        import opencode_kit
        return {"kit": opencode_kit.seed(env=env)}
    except Exception:  # noqa: BLE001 - OpenCode installs the kit itself then
        return {}


def uninstall_plugin(path=None, source=None, env=None):
    """Disable only Dispatch's plugin, moving it to ~/.dispatch/backups/<date>/, outside OpenCode's *.js/*.ts scan.
    Config files and other plugins stay byte-for-byte unchanged. Old install backups remain
    available, but are not auto-restored: they could be another version of Dispatch's plugin."""
    path = path or plugin_path(env)
    source = source or PLUGIN_SOURCE
    if not os.path.lexists(path):
        return {"path": path, "unchanged": True}
    owned = bool(source and os.path.islink(path) and os.path.realpath(path) == os.path.realpath(source))
    if not owned:
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
            owned = text.startswith("// Dispatch integration for OpenCode")
            if not owned and source:
                with open(source, encoding="utf-8") as f:
                    owned = text == f.read()
        except (OSError, UnicodeError):
            pass
    if not owned:
        return {"path": path, "skipped": "not a Dispatch plugin; left unchanged"}
    import backups
    backup = backups.save(path, move=True)
    return {"path": path, "removed": True, "backup": backup}


# ---------------------------------------------------------------- status

def mark_shared_quota(provs):
    """Providers whose allowance is the very same rows as another's are the same account: the one
    logged in through OpenCode (auth.json) stands for it, else the first by name; the others get
    `same_quota_as` its id."""
    def logged_in(p):
        return any(s["kind"] in ("api", "oauth") for s in p["sources"])
    owners = {}
    for p in sorted(provs, key=lambda p: (not logged_in(p), p["name"].lower())):
        if not p.get("quota"):
            continue
        key = json.dumps(p["quota"], sort_keys=True)
        if key in owners:
            p["same_quota_as"] = owners[key]
        else:
            owners[key] = p["id"]
    return provs


# macOS keeps Desktop, Documents, Downloads and iCloud Drive behind its privacy settings (Files and Folders): an app
# reading there is asked about once, and a program started from a background service (Dispatch's chat service, a
# test's OpenCode) can be kept waiting with nobody to answer. OpenCode reads every file its config names as it starts,
# so a plugin, an instruction file or a {file:...} key there can stop it before it lists a model (the build Mac, 10-06).
PROTECTED_FOLDERS = (("Desktop", "Desktop"), ("Documents", "Documents"), ("Downloads", "Downloads"),
                     (os.path.join("Library", "Mobile Documents"), "iCloud Drive"))
_FILE_KEY = re.compile(r"\{file:([^}]+)\}")
_FILE_URL = re.compile(r"file://(\S+)")


def _paths_in(text):
    """The paths a config string names: a whole path, a {file:...} key, a file:// URL."""
    t = text.strip()
    if t.startswith(("~/", "/")):
        yield t
    for m in _FILE_KEY.finditer(text):
        yield m.group(1).strip()
    for m in _FILE_URL.finditer(text):
        yield urllib.parse.unquote(m.group(1))


def _config_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _config_strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _config_strings(v)


def protected_refs(cfg=None, env=None, home=None):
    """The files OpenCode's config names inside a folder macOS guards (Desktop, Documents, Downloads, iCloud Drive):
    [{path, folder, exists}], each once. Not on macOS: none."""
    env = os.environ if env is None else env
    if (env.get("DISPATCH_PLATFORM") or sys.platform) != "darwin":
        return []
    home = home or os.path.expanduser("~")
    cfg = merged_config(env) if cfg is None else cfg
    out, seen = [], set()
    for text in _config_strings(cfg):
        for raw in _paths_in(text):
            if not raw.startswith(("~/", "/")):
                continue
            p = os.path.normpath(home + raw[1:] if raw.startswith("~") else raw)
            for sub, label in PROTECTED_FOLDERS:
                root = os.path.join(home, sub)
                if (p == root or p.startswith(root + os.sep)) and p not in seen:
                    seen.add(p)
                    out.append({"path": p, "folder": label, "exists": os.path.exists(p)})
    return out


def protected_text(refs, home=None):
    """One plain sentence for the person, or "" when there is nothing to say."""
    if not refs:
        return ""
    home = home or os.path.expanduser("~")
    r = refs[0]
    shown = "~" + r["path"][len(home):] if r["path"].startswith(home) else r["path"]
    more = f" (and {len(refs) - 1} more)" if len(refs) > 1 else ""
    gone = " It is not there any more." if not r["exists"] else ""
    return (f"OpenCode's settings name {shown}{more}, in your {r['folder']} folder. macOS can keep apps from reading "
            f"that folder, and OpenCode then stops at start with no models.{gone} Move the file out of {r['folder']} "
            f"(for example into ~/.config/opencode) and change the setting, or remove the line.")


def status(refresh=False, env=None, row=None, get=_get):
    env = os.environ if env is None else env
    row = row if row is not None else engines.status(engines.get("opencode"), "", 0)
    cfg = merged_config(env)
    model = cfg.get("model") if isinstance(cfg.get("model"), str) else ""
    provs = providers(env, config=cfg)
    q = quota([p["id"] for p in provs], env, refresh=refresh, get=get) if row.get("installed") else {}
    for p in provs:
        p["quota"] = q.get(p["id"]) or []
    mark_shared_quota(provs)
    refs = protected_refs(cfg, env)
    return {
        "installed": bool(row.get("installed")), "path": row.get("path") or "", "version": row.get("version") or "",
        "config": {"path": config_file(env), "exists": os.path.isfile(config_file(env)), "dir": paths(env)["config"]},
        "auth_path": os.path.join(paths(env)["data"], "auth.json"),
        "default_model": model, "default_provider": model.split("/", 1)[0] if "/" in model else "",
        "providers": provs, "plugin": plugin_state(env),
        # files the config names in Desktop, Documents, Downloads or iCloud Drive, and what to tell the person
        "protected": refs, "protected_text": protected_text(refs),
    }


def status_text(s):
    lines = [f"OpenCode {s['version'] or '(not installed)'}", f"config: {s['config']['path']}" + ("" if s["config"]["exists"] else " (not there yet)"),
             f"default model: {s['default_model'] or '(OpenCode decides)'}"]
    for p in s["providers"]:
        src = ", ".join((x["kind"] + (f" {x['detail']}" if x["detail"] else "")) for x in p["sources"])
        extra = "; ".join(
            f"{r['label']} {r['amount']} {r['currency']}" if r["kind"] == "balance" else f"{r['label']} {r.get('used_percent')}% used"
            for r in p.get("quota") or [])
        lines.append(f"  {p['name']:<32} {src}" + (f"  ({extra})" if extra else ""))
    lines.append("plugin: " + ("installed" if s["plugin"]["installed"] else "not installed") + f" ({s['plugin']['path']})")
    if s.get("protected_text"):
        lines.append("warning: " + s["protected_text"])
    return "\n".join(lines)
