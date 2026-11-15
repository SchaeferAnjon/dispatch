# -*- coding: utf-8 -*-
"""browserd: the resident Chromium behind `dispatch browser` (see browser.py).

Runs in the Playwright venv (~/tasks/.dispatch/venv), started by browser.py on the first `open`:

  python browserd.py --dir ~/tasks/.dispatch/browser [--idle 1800] [--headless]

It launches one Chromium (Playwright's own build when it is in ~/Library/Caches/ms-playwright,
else the installed Google Chrome), keeps one browser context with an "active" page, and records
console messages, uncaught page errors, failed requests and HTTP responses >= 400 in a ring buffer.
Commands arrive one JSON line per connection on a unix socket (<dir>/browserd.sock, mode 0600;
Windows: 127.0.0.1 on a random port with a token from browserd.json) and are answered with one
JSON line. Commands run one at a time. It exits after `--idle` seconds without a command, when
the browser goes away (the person quit Chromium), or on `close`.

Nothing here imports Playwright at module level, so the helpers can be tested without it.
"""
import sys
from lang import t as _t

sys.dont_write_bytecode = True

import argparse
import asyncio
import collections
import json
import os
import re
import secrets
import signal
import struct
import time

IS_WIN = os.name == "nt"
LOG_MAX = 1000
RESULT_MAX = 100000
SNAPSHOT_MAX = 40000
NAV_TIMEOUT_MS = 30000
ACT_TIMEOUT_MS = 10000
VIEWPORT = {"width": 1280, "height": 800}

# Prefixes Playwright's selector engine understands as-is.
SELECTOR_PREFIX = re.compile(r"^(?:text=|role=|css=|xpath=|id=|data-testid=|internal:|nth=|//|\.\.|[#.\[*])")
CSS_CHARS = re.compile(r"[#.\[\]>:=~+*()\"']")
TAGS = {"a", "button", "input", "textarea", "select", "form", "img", "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "ul", "ol",
        "table", "tr", "td", "th", "nav", "header", "footer", "main", "section", "article", "label", "span", "div", "summary",
        "details", "dialog", "canvas", "video", "iframe", "body", "option"}


# Errors that only the parser raises (so nothing ran yet) and that a function body fixes.
PARSE_ONLY_RE = re.compile(r"Illegal return statement|await is only valid in async function")


def as_function_body(js):
    return "async () => {\n%s\n}" % js


def normalize_url(url):
    """A bare host or path gets a scheme: `localhost:3000` → http://localhost:3000, `/x/y.html` → file://."""
    u = (url or "").strip()
    if not u:
        return "about:blank"
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", u) and not re.match(r"^(localhost|127\.0\.0\.1|\[::1\]|[\w.-]+):\d+", u):
        return u
    if u.startswith("/") or u.startswith("~"):
        return "file://" + os.path.abspath(os.path.expanduser(u))
    return "http://" + u


def selector_kind(target):
    """css / text: how to read what an Agent wrote after `click` or `type`. Anything with a
    selector prefix or CSS punctuation, or a bare tag name, is a selector; other words are text."""
    t = (target or "").strip()
    if SELECTOR_PREFIX.match(t) or CSS_CHARS.search(t) or t.lower() in TAGS:
        return "css"
    return "text"


def playwright_cache():
    if os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
        return os.environ["PLAYWRIGHT_BROWSERS_PATH"]
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Caches", "ms-playwright")
    if IS_WIN:
        return os.path.join(os.environ.get("LOCALAPPDATA", home), "ms-playwright")
    return os.path.join(home, ".cache", "ms-playwright")


def cached_chromiums(cache=None):
    """Chromium executables already downloaded by any Playwright version, newest revision first."""
    cache = cache or playwright_cache()
    try:
        names = os.listdir(cache)
    except OSError:
        return []
    revs = sorted((n for n in names if re.fullmatch(r"chromium-\d+", n)), key=lambda n: -int(n.split("-")[1]))
    rel = [("chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
           ("chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
           ("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
           ("chrome-linux64", "chrome"), ("chrome-linux", "chrome"), ("chrome-win64", "chrome.exe"), ("chrome-win", "chrome.exe")]
    out = []
    for n in revs:
        for parts in rel:
            p = os.path.join(cache, n, *parts)
            if os.path.isfile(p):
                out.append(p)
                break
    return out


def png_size(path):
    try:
        with open(path, "rb") as f:
            head = f.read(24)
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            w, h = struct.unpack(">II", head[16:24])
            return w, h
    except OSError:
        pass
    return 0, 0


def clip(value, limit=RESULT_MAX):
    """A JSON-able value, cut down when its JSON form is huge (a whole DOM, a big array)."""
    try:
        raw = json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return {"value": str(value)[:limit], "truncated": len(str(value)) > limit}
    if len(raw) <= limit:
        return {"value": value}
    return {"value": raw[:limit], "truncated": True}


def parse_since(since, now=None):
    """--since: epoch seconds, or a span back from now (30s, 5m, 2h). 0 / empty = everything."""
    if since in (None, "", 0, "0"):
        return 0.0
    now = time.time() if now is None else now
    s = str(since).strip()
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(ms|s|m|h)", s)
    if m:
        n = float(m.group(1))
        return now - n * {"ms": 0.001, "s": 1, "m": 60, "h": 3600}[m.group(2)]
    return float(s)


class Logs(object):
    """Ring buffer of what the page said: console, pageerror, requestfailed, http (>= 400)."""

    def __init__(self, size=LOG_MAX):
        self.items = collections.deque(maxlen=size)
        self.seq = 0

    def add(self, kind, text, **extra):
        self.seq += 1
        row = {"seq": self.seq, "ts": round(time.time(), 3), "type": kind, "text": (text or "")[:4000]}
        row.update({k: v for k, v in extra.items() if v not in (None, "")})
        self.items.append(row)
        return row

    def since(self, ts=0.0, limit=200, kinds=None):
        rows = [r for r in self.items if r["ts"] > ts and (not kinds or r["type"] in kinds)]
        return rows[-limit:] if limit else rows

    def clear(self):
        self.items.clear()


class Daemon(object):
    def __init__(self, state_dir, idle, headless):
        self.dir = state_dir
        self.idle = idle
        self.headless = headless
        self.logs = Logs()
        self.last = time.time()
        self.started = time.time()
        self.page = None
        self.stop = None
        self.lock = None
        self.browser = None
        self.context = None
        self.pw = None
        self.channel = ""
        self.adopted = set()
        self.token = secrets.token_hex(16) if IS_WIN else ""

    # ---- the browser --------------------------------------------------------------------------
    async def launch(self):
        from playwright.async_api import async_playwright
        self.pw = await async_playwright().start()
        args = ["--window-size=1320,960", "--no-first-run", "--no-default-browser-check"]
        err = None
        # Playwright's own Chromium; else an older one already in the cache; else Google Chrome.
        tries = [{}] + [{"executable_path": p} for p in cached_chromiums()] + [{"channel": "chrome"}]
        for extra in tries:
            try:
                self.browser = await self.pw.chromium.launch(headless=self.headless, args=args, **extra)
                self.channel = extra.get("channel") or next((seg for seg in extra.get("executable_path", "").split(os.sep) if seg.startswith("chromium-")), "chromium")
                break
            except Exception as e:  # missing executable → try the next one
                err = e
        if not self.browser:
            raise RuntimeError("missing_browser: %s" % (str(err).splitlines()[0] if err else ""))
        self.browser.on("disconnected", lambda *_: self.stop.set())
        self.context = await self.browser.new_context(viewport=VIEWPORT)
        self.context.on("page", self._adopt)

    def _adopt(self, page):
        """Every new page (ours or a popup) becomes the active one and reports into the log."""
        self.page = page
        if id(page) in self.adopted:
            return
        self.adopted.add(id(page))
        logs = self.logs

        def on_console(msg):
            loc = ""
            try:
                l = msg.location or {}
                loc = "%s:%s" % (l.get("url", ""), l.get("lineNumber", "")) if l.get("url") else ""
            except Exception:
                pass
            logs.add("console", msg.text, level=msg.type, url=page.url, location=loc)

        page.on("console", on_console)
        page.on("pageerror", lambda err: logs.add("pageerror", "%s" % (getattr(err, "stack", "") or err), url=page.url))
        page.on("requestfailed", lambda req: logs.add("requestfailed", "%s %s" % (req.method, req.url), failure=(req.failure or ""), url=page.url))

        def on_response(resp):
            if resp.status >= 400:
                logs.add("http", "%d %s %s" % (resp.status, resp.request.method, resp.url), status=resp.status, url=page.url)

        page.on("response", on_response)
        page.on("close", lambda *_: self._closed(page))

    def _closed(self, page):
        if self.page is page:
            pages = [p for p in self.context.pages if p is not page and not p.is_closed()] if self.context else []
            self.page = pages[-1] if pages else None

    async def need_page(self, create=False):
        if self.page is None or self.page.is_closed():
            self.page = None
            if not create:
                raise CommandError("no_page", _t("No page is open; dispatch browser open <url> first", "没有打开的页面，先 dispatch browser open <url>"))
            self._adopt(await self.context.new_page())
        return self.page

    def locate(self, target):
        page = self.page
        t = (target or "").strip()
        if not t:
            raise CommandError("usage", _t("Give a selector or text", "要给一个选择器或文字"))
        if selector_kind(t) == "css":
            return page.locator(t).first
        return page.get_by_text(t).first

    async def info(self):
        page = self.page
        if page is None or page.is_closed():
            return {"url": "", "title": ""}
        try:
            title = await page.title()
        except Exception:
            title = ""
        return {"url": page.url, "title": title}

    # ---- commands -----------------------------------------------------------------------------
    async def cmd_open(self, r):
        page = await self.need_page(create=True)
        if r.get("new_tab") and page.url not in ("about:blank", ""):
            page = await self.context.new_page()
            self._adopt(page)
        url = normalize_url(r.get("url", ""))
        status, warning = None, ""
        try:
            resp = await page.goto(url, wait_until=r.get("wait") or "load", timeout=int(r.get("timeout_ms") or NAV_TIMEOUT_MS))
            status = resp.status if resp else None
        except Exception as e:
            if "Timeout" not in type(e).__name__ and "timeout" not in str(e).lower():
                raise
            warning = _t("The page did not finish loading within %d s; answering with it as it is", "页面在 %d 秒内没加载完，先按现在的样子返回") % (int(r.get("timeout_ms") or NAV_TIMEOUT_MS) // 1000)
        out = dict(await self.info(), status=status)
        if warning:
            out["warning"] = warning
        return out

    async def cmd_shot(self, r):
        page = await self.need_page()
        out = r.get("out") or ""
        if not out:
            shots = os.path.join(self.dir, "shots")
            os.makedirs(shots, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S") + "-%03d" % (int(time.time() * 1000) % 1000)
            out = os.path.join(shots, "shot-%s.png" % stamp)
        out = os.path.abspath(os.path.expanduser(out))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        if r.get("selector"):
            await self.locate(r["selector"]).screenshot(path=out, timeout=ACT_TIMEOUT_MS)
        else:
            await page.screenshot(path=out, full_page=bool(r.get("full")))
        w, h = png_size(out)
        return dict(await self.info(), path=out, bytes=os.path.getsize(out), width=w, height=h)

    async def cmd_click(self, r):
        await self.need_page()
        await self.locate(r.get("target", "")).click(timeout=int(r.get("timeout_ms") or ACT_TIMEOUT_MS))
        await self._settle()
        return await self.info()

    async def cmd_type(self, r):
        await self.need_page()
        loc = self.locate(r.get("selector", ""))
        text = r.get("text", "")
        t = int(r.get("timeout_ms") or ACT_TIMEOUT_MS)
        if r.get("slow"):
            await loc.click(timeout=t)
            await loc.press_sequentially(text, delay=30, timeout=t)
        else:
            await loc.fill(text, timeout=t)
        if r.get("submit"):
            await loc.press("Enter", timeout=t)
            await self._settle()
        out = await self.info()
        try:
            out["value"] = await loc.input_value(timeout=1000)
        except Exception:
            pass
        return out

    async def cmd_press(self, r):
        page = await self.need_page()
        key = r.get("key", "")
        if not key:
            raise CommandError("usage", _t("Give a key, such as Enter, Escape, Meta+A", "要给一个键，比如 Enter、Escape、Meta+A"))
        if r.get("selector"):
            await self.locate(r["selector"]).press(key, timeout=ACT_TIMEOUT_MS)
        else:
            await page.keyboard.press(key)
        await self._settle()
        return await self.info()

    async def cmd_eval(self, r):
        page = await self.need_page()
        js = r.get("js", "")
        if not js.strip():
            raise CommandError("usage", _t("Give some JavaScript", "要给一段 JavaScript"))
        # Statements with a `return` (`const a = …; return a`) run as a function body. Which form
        # to use is decided before anything runs: retrying after a failed run would repeat its side
        # effects (clicks, requests) whenever the code itself threw a SyntaxError (JSON.parse).
        body = await self.parses_as_body_only(page, js)
        if body is None:
            try:
                value = await page.evaluate(js)
            except Exception as e:
                if not PARSE_ONLY_RE.search(str(e)):
                    raise
                value = await page.evaluate(as_function_body(js))
        else:
            value = await page.evaluate(as_function_body(js) if body else js)
        return dict(await self.info(), **clip(value))

    async def parses_as_body_only(self, page, js):
        """True when `js` is not a valid script (so eval would reject it) and should run as a
        function body; False when it is a valid script; None when the browser cannot tell (no CDP).
        Compiling runs nothing."""
        try:
            cdp = await page.context.new_cdp_session(page)
        except Exception:
            return None
        try:
            r = await cdp.send("Runtime.compileScript", {"expression": js, "sourceURL": "", "persistScript": False})
        except Exception:
            return None
        finally:
            try:
                await cdp.detach()
            except Exception:
                pass
        return bool(r.get("exceptionDetails"))

    async def cmd_logs(self, r):
        since = parse_since(r.get("since"))
        kinds = [k for k in (r.get("types") or "").split(",") if k] or None
        rows = self.logs.since(since, int(r.get("limit") or 200), kinds)
        if r.get("clear"):
            self.logs.clear()
        return {"now": round(time.time(), 3), "entries": rows, "count": len(rows)}

    async def cmd_snapshot(self, r):
        page = await self.need_page()
        loc = page.locator(r.get("selector") or "body")
        text = await loc.aria_snapshot(timeout=ACT_TIMEOUT_MS)
        out = dict(await self.info(), snapshot=text[:SNAPSHOT_MAX])
        if len(text) > SNAPSHOT_MAX:
            out["truncated"] = True
        return out

    async def cmd_status(self, r):
        return dict(await self.info(), pid=os.getpid(), headless=self.headless, browser=self.channel,
                    pages=len([p for p in self.context.pages if not p.is_closed()]) if self.context else 0,
                    idle_s=round(time.time() - self.last, 1), idle_limit_s=self.idle, started=round(self.started, 3),
                    logs=len(self.logs.items))

    async def cmd_close(self, r):
        self.stop.set()
        return {"closed": True}

    async def _settle(self):
        try:
            await self.page.wait_for_load_state("domcontentloaded", timeout=3000)
        except Exception:
            pass

    # ---- the socket ---------------------------------------------------------------------------
    async def handle(self, reader, writer):
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=10)
            try:
                req = json.loads(line.decode("utf-8") or "{}")
            except ValueError:
                req = {}
            if self.token and req.get("token") != self.token:
                resp = {"ok": False, "error": "forbidden", "message": _t("wrong token", "token 不对")}
            else:
                resp = await self.dispatch(req)
            writer.write((json.dumps(resp, ensure_ascii=False) + "\n").encode("utf-8"))
            await writer.drain()
        except Exception:
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    async def dispatch(self, req):
        cmd = req.get("cmd", "")
        fn = getattr(self, "cmd_" + cmd, None) if re.fullmatch(r"[a-z]+", cmd or "") else None
        if fn is None:
            return {"ok": False, "error": "usage", "message": _t("Unknown command: %s", "不认识的命令：%s") % cmd}
        async with self.lock:
            self.last = time.time()
            try:
                out = await fn(req)
                return dict(out, ok=True)
            except CommandError as e:
                return {"ok": False, "error": e.code, "message": str(e)}
            except Exception as e:
                name = type(e).__name__
                code = "timeout" if "Timeout" in name else "failed"
                return {"ok": False, "error": code, "message": ("%s: %s" % (name, e)).strip()[:1500]}
            finally:
                self.last = time.time()

    async def idle_watch(self):
        while not self.stop.is_set():
            await asyncio.sleep(min(5.0, max(self.idle / 4.0, 0.2)))
            if time.time() - self.last > self.idle and not self.lock.locked():
                self.stop.set()

    async def run(self, sock_path):
        self.stop = asyncio.Event()
        self.lock = asyncio.Lock()
        state_file = os.path.join(self.dir, "browserd.json")
        try:
            await self.launch()
        except Exception as e:
            write_state(state_file, {"pid": os.getpid(), "error": str(e)[:1000], "ts": time.time()})
            await self.shutdown()
            return 3
        if IS_WIN:
            server = await asyncio.start_server(self.handle, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            state = {"pid": os.getpid(), "transport": "tcp", "port": port, "token": self.token}
        else:
            try:
                os.unlink(sock_path)
            except OSError:
                pass
            old = os.umask(0o177)
            try:
                server = await asyncio.start_unix_server(self.handle, path=sock_path)
            finally:
                os.umask(old)
            state = {"pid": os.getpid(), "transport": "unix", "socket": sock_path}
        state.update({"headless": self.headless, "browser": self.channel, "started": self.started, "idle": self.idle})
        write_state(state_file, state)
        watcher = asyncio.ensure_future(self.idle_watch())
        try:
            await self.stop.wait()
            await asyncio.sleep(0.05)  # let the `close` answer go out
        finally:
            watcher.cancel()
            server.close()
            await self.shutdown()
            if not IS_WIN:
                try:
                    os.unlink(sock_path)
                except OSError:
                    pass
            try:
                cur = json.load(open(state_file))
                if cur.get("pid") == os.getpid():
                    os.unlink(state_file)
            except (OSError, ValueError):
                pass
        return 0

    async def shutdown(self):
        for step in (lambda: self.browser.close() if self.browser else None, lambda: self.pw.stop() if self.pw else None):
            try:
                c = step()
                if c is not None:
                    await asyncio.wait_for(c, timeout=10)
            except Exception:
                pass


class CommandError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code


def write_state(path, data):
    tmp = "%s.%d.tmp" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def main(argv=None):
    p = argparse.ArgumentParser(prog="browserd")
    p.add_argument("--dir", required=True)
    p.add_argument("--socket", default="")
    p.add_argument("--idle", type=float, default=1800)
    p.add_argument("--headless", action="store_true")
    a = p.parse_args(argv)
    os.makedirs(a.dir, exist_ok=True)
    d = Daemon(a.dir, a.idle, a.headless)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    if not IS_WIN:
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            try:
                loop.add_signal_handler(sig, lambda: d.stop.set() if d.stop else None)
            except (NotImplementedError, RuntimeError):
                pass
    try:
        return loop.run_until_complete(d.run(a.socket or os.path.join(a.dir, "browserd.sock")))
    finally:
        loop.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
