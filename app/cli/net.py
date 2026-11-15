# -*- coding: utf-8 -*-
"""This Mac's way out to the internet, for the engines Dispatch starts and the downloads it makes (`dispatch net`).

Proxy
    `apply(env)` puts the proxy into the environment of Claude Code, Codex and OpenCode (chatd's drivers, the Agents
    window's host through `dispatch net env`, engine installs): HTTPS_PROXY, HTTP_PROXY, ALL_PROXY, NO_PROXY and their
    lowercase twins. The setting `proxy` in DISPATCH_DIR/net.json (this Mac only, not the shared settings: a proxy
    address means nothing on another computer) says where it comes from:
      auto      (default) a proxy already in the environment (a shell profile that exports HTTPS_PROXY) is kept as it
                is; otherwise macOS's own settings (System Settings > Network > Details > Proxies, read with
                `scutil --proxy`): the automatic proxy configuration (PAC) file, run for the engines' servers, else
                the secure web proxy, the web proxy, the SOCKS proxy.
      off       no proxy: the inherited proxy variables are taken out too.
      <address> this proxy: http://host:port, socks5://host:port, or the address of a PAC file (…/x.pac, file://…).
    Claude Code and OpenCode speak to web (HTTP) proxies only; Codex also takes SOCKS (ALL_PROXY). A Mac with only a
    SOCKS proxy gets ALL_PROXY, and `status()` says the other two need the web proxy turned on in the proxy app.

Reachability
    `check()` asks Anthropic's and OpenAI's API servers, and the default download servers (npm, PyPI, GitHub), through
    that proxy whether they answer: a connection, a TLS handshake and one unauthenticated GET (no key is ever sent).
    A server that answers that it does not serve this region counts as not reachable. Cached for ten minutes in
    DISPATCH_DIR/net-check.json, per proxy. `blocked()` reads only the cache (no network).

Models that work from China
    When Claude Code's or Codex's server cannot be reached, the first-run wizard and the new-session page recommend
    OpenCode with a Chinese model maker's models (CHINA_MODELS): which account or key each needs and where to get it.
    Dispatch never stores or shows a key: OpenCode keeps them (`opencode auth login`).

Reconnecting
    `is_network_error(text)`: whether an engine's error means the connection dropped (not a refusal, not a bad key),
    which chatd (chat_retry.py) and the Agents window retry with the same message.
"""
import ipaddress
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True

HOME = os.path.expanduser("~")
CHECK_TTL = 600
PROXY_TTL = 30
PAC_TTL = 300
CHECK_TIMEOUT = 6.0
PROXY_VARS = ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY")
ALWAYS_DIRECT = ("localhost", "127.0.0.1", "::1", ".local")
MODES = ("auto", "off")

# What `check()` asks. `region` markers: the server answered that it does not serve this place.
TARGETS = {
    "anthropic": {"label": "Anthropic (Claude Code)", "host": "api.anthropic.com", "path": "/v1/models"},
    "openai": {"label": "OpenAI (Codex)", "host": "api.openai.com", "path": "/v1/models"},
    "npm": {"label": "npm", "host": "registry.npmjs.org", "path": "/-/ping"},
    "pypi": {"label": "PyPI", "host": "pypi.org", "path": "/simple/pip/"},
    "github": {"label": "GitHub", "host": "github.com", "path": "/"},
}
REGION_MARKERS = ("unsupported_country", "not available in your country", "not supported in your region",
                  "request not allowed", "unsupported_region")

# Chinese model makers OpenCode reaches without a proxy. `providers`: models.dev ids (what OpenCode calls them), the
# subscription first. Shown in plain words; the links are the makers' own pages for an account and a key.
CHINA_MODELS = [
    {"id": "deepseek", "name": "DeepSeek",
     "providers": ["deepseek"],
     "account": "A DeepSeek platform account (sign up with a phone number) and an API key. Pay as you go: top up a few yuan first.",
     "key_url": "https://platform.deepseek.com/api_keys", "plan_url": ""},
    {"id": "zhipu", "name": "Zhipu GLM",
     "providers": ["zhipuai-coding-plan", "zhipuai"],
     "account": "A Zhipu (bigmodel.cn) account and an API key. The GLM Coding Plan is a monthly plan made for coding agents; without it you pay per use.",
     "key_url": "https://bigmodel.cn/usercenter/proj-mgmt/apikeys", "plan_url": "https://bigmodel.cn/glm-coding"},
    {"id": "kimi", "name": "Kimi",
     "providers": ["kimi-code-plan-cn", "moonshotai-cn"],
     "account": "A Kimi membership with Kimi For Coding, or a Moonshot platform (platform.moonshot.cn) API key paid per use.",
     "key_url": "https://platform.moonshot.cn/console/api-keys", "plan_url": "https://www.kimi.com/code"},
    {"id": "qwen", "name": "Qwen (Tongyi)",
     "providers": ["alibaba-coding-plan-cn", "alibaba-cn"],
     "account": "An Alibaba Cloud account with Model Studio (Bailian) turned on and an API key. The Coding Plan is monthly; without it you pay per use.",
     "key_url": "https://bailian.console.aliyun.com/?tab=model#/api-key", "plan_url": "https://help.aliyun.com/zh/model-studio/coding-plan"},
]

# Connection errors, in the words Claude Code (Node), Codex (Rust) and OpenCode (Bun) use. Not here on purpose: a bad
# key (401), a refusal (403), a model that is busy (429/529); a retry would not help those or is the engine's own job.
_NET_ERRORS = re.compile("|".join([
    r"connection error", r"connection (?:was )?(?:reset|refused|closed|aborted|lost|dropped)", r"econnreset", r"econnrefused",
    r"econnaborted", r"etimedout", r"enotfound", r"eai_again", r"ehostunreach", r"enetunreach", r"epipe", r"socket hang up",
    r"socket connection was closed", r"other side closed", r"fetch failed", r"network ?error", r"network is unreachable",
    r"stream disconnected", r"error sending request", r"error trying to connect", r"unable to connect",
    r"poor internet connection", r"request timed out", r"connect(?:ion)? timed? ?out", r"timed out waiting",
    r"und_err_(?:socket|connect_timeout|headers_timeout|body_timeout)", r"tls handshake", r"proxy ?error",
    r"tunnel(?:ing)? (?:socket|connection) could not be established", r"failed to connect", r"dns error",
    r"name or service not known", r"nodename nor servname", r"temporary failure in name resolution",
    r"httpconnectionfailed", r"responsestreamdisconnected", r"responsestreamconnectionfailed",
]), re.I)
_NOT_NET = re.compile(r"\b(?:401|403|invalid api key|authentication|unauthori[sz]ed|permission denied|quota|insufficient|billing|"
                      r"overloaded|rate.?limit|context (?:length|window)|prompt is too long)\b", re.I)


def is_network_error(text):
    """True when an engine's error text means the connection dropped or could not be made."""
    text = str(text or "")
    if not text or not _NET_ERRORS.search(text):
        return False
    return not _NOT_NET.search(text) or bool(re.search(r"connection error|econnreset|stream disconnected|socket hang up", text, re.I))


# ---------------------------------------------------------------- where things live
def dispatch_dir():
    return os.environ.get("DISPATCH_DIR") or os.path.join(HOME, "tasks", ".dispatch")


def config_path(d=None):
    return os.path.join(d or dispatch_dir(), "net.json")


def check_path(d=None):
    return os.path.join(d or dispatch_dir(), "net-check.json")


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(path, data):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    except OSError:
        pass


def valid_proxy(value):
    """auto | off | an http(s):// or socks(4|5)(h):// address with a host and port | a PAC file's address. '' when not."""
    v = str(value or "").strip()
    if v in MODES:
        return v
    if is_pac_address(v):
        return v
    u = urllib.parse.urlparse(v if "://" in v else "http://" + v)
    if u.scheme not in ("http", "https", "socks4", "socks4a", "socks5", "socks5h") or not u.hostname:
        return ""
    try:
        port = u.port
    except ValueError:
        return ""
    if not port:
        return ""
    return f"{u.scheme}://{u.hostname}:{port}" if "://" in v else f"http://{u.hostname}:{port}"


def is_pac_address(v):
    v = str(v or "").strip()
    if v.startswith("file://"):
        return True
    u = urllib.parse.urlparse(v)
    return u.scheme in ("http", "https") and bool(re.search(r"\.(pac|js)$|[?&]pac\b|/pac\b|proxy\.pac", u.path + ("?" + u.query if u.query else ""), re.I))


def load(d=None):
    """{proxy, mirror} with defaults; a bad value reads as the default."""
    import mirrors
    raw = _read(config_path(d))
    proxy = valid_proxy(raw.get("proxy")) or "auto"
    mirror = raw.get("mirror") if raw.get("mirror") in mirrors.MODES else "auto"
    return {"proxy": proxy, "mirror": mirror}


def save(proxy=None, mirror=None, d=None):
    """Change the proxy or the download source. ValueError with a plain reason when the value is not one."""
    import mirrors
    cur = load(d)
    if proxy is not None:
        v = valid_proxy(proxy)
        if not v:
            raise ValueError("Use auto, off, or a proxy address such as http://127.0.0.1:7890, socks5://127.0.0.1:7891 or a PAC file's address.")
        cur["proxy"] = v
    if mirror is not None:
        if mirror not in mirrors.MODES:
            raise ValueError(f"The download source is one of {', '.join(mirrors.MODES)}.")
        cur["mirror"] = mirror
    _write(config_path(d), cur)
    _memo.clear()
    return cur


# ---------------------------------------------------------------- macOS proxy settings
def parse_scutil(text):
    """`scutil --proxy` → dict (nested <array> → list, <dictionary> → dict, values as strings)."""
    root, stack = {}, []
    cur = root
    for line in (text or "").splitlines():
        s = line.strip()
        if not s or s == "<dictionary> {":
            continue
        if s == "}":
            if stack:
                cur = stack.pop()
            continue
        m = re.match(r"^(\S+)\s*:\s*<(array|dictionary)>\s*\{$", s)
        if m:
            child = [] if m.group(2) == "array" else {}
            if isinstance(cur, list):
                cur.append(child)
            else:
                cur[m.group(1)] = child
            stack.append(cur)
            cur = child
            continue
        m = re.match(r"^(\S+)\s*:\s*(.*)$", s)
        if m:
            if isinstance(cur, list):
                cur.append(m.group(2))
            else:
                cur[m.group(1)] = m.group(2)
    return root


def _hostport(d, key):
    host, port = (d.get(key + "Proxy") or "").strip(), (d.get(key + "Port") or "").strip()
    if d.get(key + "Enable") != "1" or not host:
        return ""
    return f"{host}:{port}" if port else host


def system_proxy(run=None):
    """macOS's proxy settings: {http, https, socks, pac, exceptions, simple_direct}; empty strings when off.
    Not a Mac, or scutil missing: all empty."""
    if sys.platform != "darwin" and run is None:
        return {"http": "", "https": "", "socks": "", "pac": "", "exceptions": [], "simple_direct": False}
    try:
        r = (run or subprocess.run)(["scutil", "--proxy"], capture_output=True, text=True, timeout=5)
        d = parse_scutil(r.stdout if r.returncode == 0 else "")
    except (OSError, subprocess.SubprocessError):
        d = {}
    http, https, socks = _hostport(d, "HTTP"), _hostport(d, "HTTPS"), _hostport(d, "SOCKS")
    pac = (d.get("ProxyAutoConfigURLString") or "").strip() if d.get("ProxyAutoConfigEnable") == "1" else ""
    exceptions = [str(x).strip() for x in (d.get("ExceptionsList") or []) if isinstance(x, str) and x.strip()]
    return {"http": f"http://{http}" if http else "", "https": f"http://{https}" if https else "",
            "socks": f"socks5h://{socks}" if socks else "", "pac": pac, "exceptions": exceptions,
            "simple_direct": d.get("ExcludeSimpleHostnames") == "1"}


def no_proxy_entry(exc):
    """A macOS exception (`*.local`, `169.254/16`, `example.com`) as a NO_PROXY entry, or '' when it has none."""
    e = exc.strip()
    if e.startswith("*."):
        return e[1:]
    if e.startswith("*"):
        return ""
    if "/" in e:
        base, _, bits = e.partition("/")
        parts = base.split(".")
        if all(p.isdigit() for p in parts) and bits.isdigit():
            return ".".join(parts + ["0"] * (4 - len(parts))) + "/" + bits
        return ""
    return e


def _matches_exception(host, exceptions, simple_direct):
    if simple_direct and "." not in host:
        return True
    for exc in exceptions:
        e = exc.strip().lower()
        if not e:
            continue
        if "/" in e:
            try:
                ip = ipaddress.ip_address(host)
                base, _, bits = e.partition("/")
                parts = base.split(".")
                net = ipaddress.ip_network(".".join(parts + ["0"] * (4 - len(parts))) + "/" + bits, strict=False)
                if ip in net:
                    return True
            except ValueError:
                pass
            continue
        pat = "^" + re.escape(e).replace(r"\*", ".*") + "$"
        if re.match(pat, host.lower()):
            return True
    return False


# ---------------------------------------------------------------- PAC files
# The standard PAC helpers, for osascript's JavaScript. dnsResolve and myIpAddress answer from what Python looked up
# beforehand (__dns, __myip); the date and time helpers say true (a PAC that switches by the clock is rare).
PAC_HELPERS = r"""
function isPlainHostName(h){return h.indexOf('.')<0}
function dnsDomainIs(h,d){h=String(h).toLowerCase();d=String(d).toLowerCase();return h.length>=d.length&&h.substring(h.length-d.length)===d}
function localHostOrDomainIs(h,d){return h===d||(h.indexOf('.')<0&&d.indexOf(h+'.')===0)}
function dnsResolve(h){if(/^\d+\.\d+\.\d+\.\d+$/.test(h))return h;return __dns[h]||null}
function isResolvable(h){return !!dnsResolve(h)}
function myIpAddress(){return __myip||'127.0.0.1'}
function dnsDomainLevels(h){return String(h).split('.').length-1}
function convert_addr(ip){var p=String(ip).split('.');return((+p[0]<<24)>>>0)+(+p[1]<<16)+(+p[2]<<8)+(+p[3])}
function isInNet(h,pat,mask){var ip=dnsResolve(h);if(!ip)return false;var m=convert_addr(mask);return(convert_addr(ip)&m)>>>0===(convert_addr(pat)&m)>>>0}
function shExpMatch(s,p){var r=String(p).replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.');return new RegExp('^'+r+'$').test(s)}
function weekdayRange(){return true}
function dateRange(){return true}
function timeRange(){return true}
function isInNetEx(){return false}
function dnsResolveEx(h){return dnsResolve(h)||''}
function myIpAddressEx(){return myIpAddress()}
"""
_PAC_ENTRY = re.compile(r"^\s*(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5|DIRECT)(?:\s+([^\s;]+))?\s*$", re.I)
_pac_cache = {}


def fetch_pac(url, timeout=4.0):
    """The PAC file's text ('' when it cannot be read). Asked directly: a PAC is never fetched through a proxy."""
    hit = _pac_cache.get(url)
    if hit and time.time() - hit[0] < PAC_TTL:
        return hit[1]
    text = ""
    try:
        if url.startswith("file://"):
            with open(urllib.parse.unquote(urllib.parse.urlparse(url).path), encoding="utf-8", errors="replace") as f:
                text = f.read(4 * 1024 * 1024)
        else:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(urllib.request.Request(url, headers={"User-Agent": "dispatch-net"}), timeout=timeout) as r:
                text = r.read(4 * 1024 * 1024).decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 - an unreadable PAC means no proxy from it
        text = ""
    _pac_cache[url] = (time.time(), text)
    return text


def pac_entry(result):
    """The first usable entry of a FindProxyForURL answer, as a proxy URL ('' = direct)."""
    for part in str(result or "").split(";"):
        m = _PAC_ENTRY.match(part)
        if not m:
            continue
        kind, where = m.group(1).upper(), m.group(2) or ""
        if kind == "DIRECT":
            return ""
        if not where:
            continue
        if kind in ("PROXY", "HTTP"):
            return "http://" + where
        if kind == "HTTPS":
            return "https://" + where
        if kind == "SOCKS4":
            return "socks4://" + where
        return "socks5h://" + where
    return ""


def _resolve(hosts, timeout=2.0):
    out = {}

    def one(h):
        try:
            out[h] = socket.gethostbyname(h)
        except OSError:
            pass
    threads = [threading.Thread(target=one, args=(h,), daemon=True) for h in hosts]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout)
    return dict(out)


def _my_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def run_pac(script, hosts, run=None, resolve=None):
    """{host: FindProxyForURL answer} for https://<host>/, run by macOS's JavaScript (osascript). When that fails, the
    first PROXY / SOCKS entry written in the file stands for every host (most PAC files from proxy apps have one)."""
    hosts = list(dict.fromkeys(hosts))
    if not script.strip():
        return {h: "DIRECT" for h in hosts}
    dns = (resolve or _resolve)(hosts) if re.search(r"dnsResolve|isInNet|isResolvable", script) else {}
    js = (PAC_HELPERS + "\nvar __dns=" + json.dumps(dns) + ";var __myip=" + json.dumps(_my_ip()) + ";\n" + script
          + "\n;(function(){var o={};var hs=" + json.dumps(hosts) + ";for(var i=0;i<hs.length;i++){try{o[hs[i]]=String(FindProxyForURL('https://'+hs[i]+'/',hs[i]))}catch(e){o[hs[i]]=''}}return JSON.stringify(o)})()")
    try:
        r = (run or subprocess.run)(["osascript", "-l", "JavaScript", "-"], input=js, capture_output=True, text=True, timeout=10)
        out = json.loads((r.stdout or "").strip() or "{}") if r.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, ValueError):
        out = None
    if isinstance(out, dict):
        return {h: str(out.get(h) or "DIRECT") for h in hosts}
    m = re.search(r"\b(PROXY|SOCKS5?|HTTPS?)\s+([\w.\-\[\]:]+:\d+)", script)
    guess = f"{m.group(1)} {m.group(2)}" if m else "DIRECT"
    return {h: guess for h in hosts}


# ---------------------------------------------------------------- the proxy Dispatch uses
_memo = {}


def _env_proxy(env):
    """The proxy variables a shell left in the environment, upper case winning."""
    out = {}
    for k in PROXY_VARS:
        v = env.get(k) or env.get(k.lower())
        if v:
            out[k] = v
    return out


def resolve(env=None, cfg=None, sysproxy=None, run_pac_fn=None, fetch=None, hosts=None):
    """What Dispatch uses: {mode, source, proxy, socks_only, no_proxy, per_host, env_set, env_unset, note}.

    source: off | environment | custom | custom-pac | system-pac | system | none. `proxy` is the address the engines get
    ('' = direct). `per_host` is {host: proxy or ''} for the servers `check()` asks."""
    env = os.environ if env is None else env
    cfg = load() if cfg is None else cfg
    hosts = list(hosts or [t["host"] for t in TARGETS.values()])
    mode = cfg.get("proxy") or "auto"
    out = {"mode": mode if mode in MODES else "custom", "source": "none", "proxy": "", "socks_only": False, "no_proxy": "",
           "per_host": {h: "" for h in hosts}, "env_set": {}, "env_unset": [], "note": ""}
    if mode == "off":
        out["source"] = "off"
        out["env_unset"] = [v for k in PROXY_VARS for v in (k, k.lower()) if k != "NO_PROXY"]
        return out
    if mode == "auto":
        have = _env_proxy(env)
        if have.get("HTTPS_PROXY") or have.get("HTTP_PROXY") or have.get("ALL_PROXY"):
            p = have.get("HTTPS_PROXY") or have.get("HTTP_PROXY") or have.get("ALL_PROXY")
            out.update(source="environment", proxy=p, no_proxy=have.get("NO_PROXY", ""))
            out["per_host"] = {h: ("" if _bypassed(h, have.get("NO_PROXY", "")) else p) for h in hosts}
            return out
    exceptions, simple_direct, pac = [], False, ""
    fixed = ""
    if mode == "auto":
        sp = system_proxy() if sysproxy is None else sysproxy
        exceptions, simple_direct = sp.get("exceptions") or [], bool(sp.get("simple_direct"))
        if sp.get("pac"):
            pac, out["source"] = sp["pac"], "system-pac"
        else:
            fixed = sp.get("https") or sp.get("http") or ""
            socks = sp.get("socks") or ""
            if fixed or socks:
                out["source"] = "system"
            if not fixed and socks:
                fixed = socks
    elif is_pac_address(mode):
        pac, out["source"] = mode, "custom-pac"
    else:
        fixed, out["source"] = mode, "custom"
    if pac:
        script = (fetch or fetch_pac)(pac)
        answers = (run_pac_fn or run_pac)(script, hosts + [h for h in DOMESTIC_HOSTS if h not in hosts]) if script else {}
        per = {h: pac_entry(answers.get(h, "DIRECT")) for h in hosts}
        if not script:
            out["note"] = "The automatic proxy configuration file could not be read, so the engines connect directly."
        primary = per.get(TARGETS["anthropic"]["host"]) or next((p for p in per.values() if p), "")
        fixed = primary
        direct = [h for h in DOMESTIC_HOSTS if answers and not pac_entry(answers.get(h, "DIRECT"))]
        out["per_host"] = {h: ("" if _matches_exception(h, exceptions, simple_direct) else p) for h, p in per.items()}
    else:
        direct = []
        out["per_host"] = {h: ("" if _matches_exception(h, exceptions, simple_direct) else fixed) for h in hosts}
    if not fixed:
        if out["source"] in ("system", "system-pac") and not pac:
            out["source"] = "none"
        return out
    out["proxy"] = fixed
    no_proxy = list(dict.fromkeys([*ALWAYS_DIRECT, *[e for e in (no_proxy_entry(x) for x in exceptions) if e], *direct]))
    out["no_proxy"] = ",".join(no_proxy)
    socks = fixed.startswith("socks")
    out["socks_only"] = socks
    s = {"ALL_PROXY": fixed, "NO_PROXY": out["no_proxy"]}
    if not socks:
        s.update(HTTPS_PROXY=fixed, HTTP_PROXY=fixed)
    else:
        out["note"] = "Only a SOCKS proxy is set. Codex can use it; Claude Code and OpenCode need the proxy app's HTTP proxy turned on."
    out["env_set"] = {k2: v for k, v in s.items() for k2 in (k, k.lower())}
    if socks:
        out["env_unset"] = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
    return out


# Chinese model makers' API servers: a PAC that sends them direct gets them into NO_PROXY, so OpenCode reaches them
# the way the browser does.
DOMESTIC_HOSTS = ("api.deepseek.com", "open.bigmodel.cn", "api.moonshot.cn", "api.kimi.com", "dashscope.aliyuncs.com",
                  "coding.dashscope.aliyuncs.com", "api.minimax.cn", "api.siliconflow.cn", "ark.cn-beijing.volces.com",
                  "registry.npmmirror.com", "pypi.tuna.tsinghua.edu.cn", "mirrors.tuna.tsinghua.edu.cn")


def _bypassed(host, no_proxy):
    for e in (x.strip().lower() for x in str(no_proxy or "").split(",")):
        if not e:
            continue
        if e == "*" or host == e or host.endswith(e if e.startswith(".") else "." + e):
            return True
    return False


def current(env=None, cfg=None):
    """resolve() remembered for half a minute (chatd starts sessions often; a PAC run takes a fraction of a second)."""
    cfg = load() if cfg is None else cfg
    key = (json.dumps(cfg, sort_keys=True), json.dumps(_env_proxy(os.environ if env is None else env), sort_keys=True))
    hit = _memo.get(key)
    if hit and time.time() - hit[0] < PROXY_TTL:
        return hit[1]
    r = resolve(env, cfg)
    _memo.clear()
    _memo[key] = (time.time(), r)
    return r


def apply(env, resolved=None):
    """Put the proxy into `env` (a dict the caller hands to a child process) and return it. Never raises."""
    try:
        r = resolved if resolved is not None else current(env)
    except Exception:  # noqa: BLE001 - a broken proxy setting never stops an engine from starting
        return env
    for k in r.get("env_unset") or []:
        env.pop(k, None)
    env.update(r.get("env_set") or {})
    return env


# ---------------------------------------------------------------- can the servers be reached
def _read_head(sock, limit=8192):
    data = b""
    while b"\r\n\r\n" not in data and len(data) < limit:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data += chunk
    return data


def _tunnel(proxy, host, port, timeout):
    """A socket to host:port, through `proxy` ('' = directly)."""
    if not proxy:
        return socket.create_connection((host, port), timeout=timeout)
    u = urllib.parse.urlparse(proxy)
    ph, pp = u.hostname, u.port or (1080 if u.scheme.startswith("socks") else 80)
    s = socket.create_connection((ph, pp), timeout=timeout)
    try:
        if u.scheme in ("http", "https"):
            if u.scheme == "https":
                s = ssl.create_default_context().wrap_socket(s, server_hostname=ph)
            s.sendall(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nUser-Agent: dispatch-net\r\n\r\n".encode())
            head = _read_head(s).decode("latin-1", "replace")
            code = head.split(" ", 2)[1] if head.startswith("HTTP/") and len(head.split(" ")) > 1 else ""
            if code != "200":
                raise OSError(f"the proxy answered {head.splitlines()[0] if head else 'nothing'}")
            return s
        if u.scheme.startswith("socks5"):
            s.sendall(b"\x05\x01\x00")
            if s.recv(2) != b"\x05\x00":
                raise OSError("the SOCKS proxy wants a password")
            name = host.encode()
            s.sendall(b"\x05\x01\x00\x03" + bytes([len(name)]) + name + port.to_bytes(2, "big"))
            rep = s.recv(4)
            if len(rep) < 4 or rep[1] != 0:
                raise OSError("the SOCKS proxy could not connect")
            size = {1: 4, 4: 16}.get(rep[3]) or s.recv(1)[0]
            s.recv(size + 2)  # the bound address and port, not needed
            return s
        if u.scheme.startswith("socks4"):
            s.sendall(b"\x04\x01" + port.to_bytes(2, "big") + b"\x00\x00\x00\x01dispatch\x00" + host.encode() + b"\x00")
            rep = s.recv(8)
            if len(rep) < 2 or rep[1] != 0x5A:
                raise OSError("the SOCKS proxy could not connect")
            return s
        raise OSError(f"unknown proxy type {u.scheme}")
    except Exception:
        s.close()
        raise


def probe(host, path, proxy="", timeout=CHECK_TIMEOUT):
    """One GET https://host/path: {ok, status, ms, why}. ok: the server answered and did not turn this place away.
    No credentials are sent, so the certificate is not checked: this only asks whether the server is there."""
    t0 = time.time()
    try:
        raw = _tunnel(proxy, host, 443, timeout)
        raw.settimeout(timeout)
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        s = ctx.wrap_socket(raw, server_hostname=host)
        try:
            s.sendall(f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: dispatch-net-check\r\nAccept: */*\r\nConnection: close\r\n\r\n".encode())
            data = _read_head(s, 16384)
            try:
                s.settimeout(1.5)
                data += s.recv(4096)
            except OSError:
                pass
        finally:
            s.close()
    except socket.timeout:
        return {"ok": False, "status": 0, "ms": int((time.time() - t0) * 1000), "why": "timed out"}
    except (OSError, ssl.SSLError) as e:
        return {"ok": False, "status": 0, "ms": int((time.time() - t0) * 1000), "why": (str(e) or type(e).__name__)[:160]}
    return interpret(data, int((time.time() - t0) * 1000))


def interpret(data, ms=0):
    """A server's first bytes → {ok, status, ms, why}: any HTTP answer counts, unless it says this region is not served."""
    text = data.decode("utf-8", "replace") if isinstance(data, bytes) else str(data or "")
    m = re.match(r"HTTP/\d(?:\.\d)?\s+(\d{3})", text)
    status = int(m.group(1)) if m else 0
    if not status:
        return {"ok": False, "status": 0, "ms": ms, "why": "no answer"}
    low = text.lower()
    if status in (403, 451) and any(k in low for k in REGION_MARKERS):
        return {"ok": False, "status": status, "ms": ms, "why": "the server does not serve this region"}
    return {"ok": True, "status": status, "ms": ms, "why": ""}


def _fingerprint(r):
    return json.dumps([r.get("source"), r.get("proxy"), sorted((r.get("per_host") or {}).items())])


def check(refresh=False, only=None, now=None, probe_fn=None, resolved=None, d=None):
    """{checked_at, proxy, results: {target: {ok, status, ms, why, label, host, via}}} — cached ten minutes per proxy."""
    now = time.time() if now is None else now
    r = resolved if resolved is not None else current()
    fp = _fingerprint(r)
    cached = _read(check_path(d))
    names = list(only or TARGETS)
    if (not refresh and cached.get("fingerprint") == fp and now - float(cached.get("checked_at") or 0) < CHECK_TTL
            and all(n in (cached.get("results") or {}) for n in names)):
        return cached
    results = dict(cached.get("results") or {}) if cached.get("fingerprint") == fp else {}
    fn = probe_fn or probe
    lock = threading.Lock()

    def one(name):
        t = TARGETS[name]
        via = (r.get("per_host") or {}).get(t["host"], r.get("proxy", ""))
        res = fn(t["host"], t["path"], via)
        with lock:
            results[name] = dict(res, label=t["label"], host=t["host"], via=via)
    threads = [threading.Thread(target=one, args=(n,), daemon=True) for n in names]
    for t in threads:
        t.start()
    for t in threads:
        t.join(CHECK_TIMEOUT * 2 + 2)
    for n in names:
        results.setdefault(n, {"ok": False, "status": 0, "ms": 0, "why": "timed out", "label": TARGETS[n]["label"], "host": TARGETS[n]["host"], "via": ""})
    out = {"checked_at": now, "fingerprint": fp, "proxy": r.get("proxy", ""), "source": r.get("source", ""), "results": results}
    _write(check_path(d), out)
    return out


def blocked(d=None, now=None):
    """{anthropic: bool|None, openai: bool|None} from the last check (None = not known). No network."""
    cached = _read(check_path(d))
    now = time.time() if now is None else now
    res = cached.get("results") or {}
    fresh = now - float(cached.get("checked_at") or 0) < 24 * 3600
    return {k: (None if not fresh or k not in res else not res[k].get("ok")) for k in engine_services()}


def engine_services():
    """The makers' servers the engines Dispatch runs need (anthropic, openai: keys of TARGETS)."""
    import engines as E
    return tuple(dict.fromkeys(e.service for e in E.runnable() if e.service))


def recommend(blocked_map, engines_here=()):
    """The engine to suggest for a new session: one that works with any AI service (OpenCode) when the servers of every
    installed engine that needs its maker's server (Claude Code, Codex) are out of reach (or none is installed and one
    server is), else ''."""
    import engines as E
    fixed = [e for e in E.runnable() if e.service]
    here = [e for e in fixed if e.id in engines_here]
    looked = [e for e in (here or fixed) if blocked_map.get(e.service) is not None]
    if not looked:
        return ""
    open_one = next((e.id for e in E.runnable() if not e.service), "")
    return open_one if all(blocked_map.get(e.service) for e in looked) else ""


def china_models(env=None):
    """CHINA_MODELS with `ready`: the engine that takes any AI service (OpenCode) already has a key or login for one of
    the maker's providers."""
    try:
        import engines as E
        have = {p["id"] for e in E.runnable() if e.supports("ai_providers") for p in e.ai_providers(env)}
    except Exception:  # noqa: BLE001 - the list shows without OpenCode
        have = set()
    return [dict(m, ready=any(p in have for p in m["providers"]), ready_provider=next((p for p in m["providers"] if p in have), ""))
            for m in CHINA_MODELS]


# ---------------------------------------------------------------- one report for the wizard, the new-session page and Settings
SOURCE_TEXT = {
    "off": "No proxy (turned off in Dispatch)",
    "environment": "The proxy set in your shell",
    "custom": "The proxy you set in Dispatch",
    "custom-pac": "The proxy configuration file you set in Dispatch",
    "system-pac": "This Mac's automatic proxy configuration",
    "system": "This Mac's proxy settings",
    "none": "No proxy on this Mac",
}


def status(refresh=False, check_fn=None, engines_here=None, d=None):
    import mirrors
    cfg = load(d)
    r = current(cfg=cfg)
    c = (check_fn or check)(refresh=refresh, resolved=r, d=d)
    res = c.get("results") or {}
    b = {k: (not res[k].get("ok")) if k in res else None for k in engine_services()}
    if engines_here is None:
        try:
            import engines as E
            engines_here = [e.id for e in E.managed() if E.engine_path(e)]
        except Exception:  # noqa: BLE001
            engines_here = []
    m = mirrors.effective(cfg["mirror"], res)
    return {"ok": True, "proxy": {"setting": cfg["proxy"], "mode": r["mode"], "source": r["source"], "source_text": SOURCE_TEXT.get(r["source"], ""),
                                  "address": _safe_address(r["proxy"]), "socks_only": r["socks_only"], "note": r.get("note", "")},
            "reach": {k: {"ok": bool(v.get("ok")), "why": v.get("why", ""), "ms": v.get("ms", 0), "label": v.get("label", k)} for k, v in res.items()},
            "checked_at": c.get("checked_at", 0), "blocked": b, "recommend": recommend(b, engines_here),
            "mirror": {"setting": cfg["mirror"], **m}, "china_models": china_models()}


def _safe_address(p):
    """A proxy address without a user name or password in it."""
    if not p:
        return ""
    u = urllib.parse.urlparse(p)
    if u.username or u.password:
        host = u.hostname or ""
        return f"{u.scheme}://{host}:{u.port}" if u.port else f"{u.scheme}://{host}"
    return p


def npm_mirror_env(env=None, cfg=None, d=None, now=None):
    """{npm_config_registry: npmmirror} when downloads go to the mirrors in China (Settings > Network: China, or Auto
    and the last check, under a day old, found npm out of reach), else {}. For the engines the Agents window starts:
    OpenCode installs packages from npm itself (plugins named in its config, language servers), and in China npm
    does not answer. A registry the person set is left alone. Reads only files, no network."""
    import mirrors
    env = os.environ if env is None else env
    if env.get("npm_config_registry") or env.get("NPM_CONFIG_REGISTRY"):
        return {}
    cfg = load(d) if cfg is None else cfg
    cached = _read(check_path(d))
    now = time.time() if now is None else now
    fresh = now - float(cached.get("checked_at") or 0) < 24 * 3600
    use = mirrors.effective(cfg.get("mirror", "auto"), (cached.get("results") or {}) if fresh else {})["use"]
    return {"npm_config_registry": mirrors.NPM_CHINA} if use == "china" else {}


def env_for_host(env=None):
    """`dispatch net env`: {set, unset} for a process that starts engines itself (the Agents window's host): the
    proxy, and npm's registry when downloads go to the mirrors in China (npm_mirror_env)."""
    r = current(env)
    return {"ok": True, "set": {**(r.get("env_set") or {}), **npm_mirror_env(env)}, "unset": r.get("env_unset") or [],
            "source": r.get("source", ""), "proxy": _safe_address(r.get("proxy", ""))}


# ---------------------------------------------------------------- CLI
def _say(obj, as_json, text):
    if as_json:
        print(json.dumps(obj, ensure_ascii=False))
    else:
        print(text)


def _status_text(s):
    p = s["proxy"]
    lines = [f"Proxy: {p['source_text']}" + (f" ({p['address']})" if p["address"] else "")]
    if p["note"]:
        lines.append("  " + p["note"])
    for k, v in s["reach"].items():
        lines.append(f"  {v['label']:<24} {'reachable' if v['ok'] else 'not reachable'}" + (f" ({v['why']})" if v["why"] else ""))
    m = s["mirror"]
    lines.append(f"Downloads: {m['text']}")
    if s["recommend"]:
        import engines as E
        fixed = E.join_words(e.name for e in E.runnable() if e.service)
        lines.append(f"{fixed} cannot reach their servers from here. {E.get(s['recommend']).name} with a Chinese model works:")
        for cm in s["china_models"]:
            lines.append(f"  {cm['name']:<14} {'ready' if cm['ready'] else cm['key_url']}")
    return "\n".join(lines)


def command(a):
    as_json = getattr(a, "json", False)
    op = getattr(a, "op", "") or "status"
    if op == "env":
        return _say(env_for_host(), True, "")  # always JSON: the Agents window's host reads it
    if op == "set":
        try:
            cfg = save(proxy=a.value if a.what == "proxy" else None, mirror=a.value if a.what == "mirror" else None)
        except ValueError as e:
            _say({"ok": False, "message": str(e)}, as_json, str(e))
            sys.exit(1)
        out = status(refresh=True)
        out["saved"] = cfg
        return _say(out, as_json, _status_text(out))
    out = status(refresh=op == "check" or getattr(a, "refresh", False))
    return _say(out, as_json, _status_text(out))
