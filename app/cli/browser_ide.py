# -*- coding: utf-8 -*-
"""`dispatch browser --ide <op> …`: drive the built-in browser in Dispatch IDE's right panel from a
session that runs in a terminal (Claude Code, Codex), the same browser the Agents window's sessions
use, with the user's logins and the "an agent is using this page" overlay.

  browser --ide open <url>                        open a page in the right panel (and remember it)
  browser --ide read                              the page's title, URL and accessibility snapshot
  browser --ide click <text | eN>                 visible text, or a ref (e12) from `read`
  browser --ide type <text | eN> <value> [--submit]
  browser --ide press <key> [--on <text | eN>]    Enter, Escape, Meta+A, ArrowDown …
  browser --ide shot [--out F]                    screenshot → a file path
  browser --ide go <url> | status
  browser --ide size 1440x900 | off               lay the page out like a desktop window, scaled to fit the
                                                  panel (a site that shows its phone page there, like Higgsfield)
  browser --ide open <url> --profile <name>       open it with one of the browser's login identities
  browser --ide profiles [--add <name>]           the login identities (each keeps its own sign-ins)
  [--page ID] [--css SELECTOR] [--as claude|codex] [--json]

The channel is the one `dispatch ide show` uses (<DISPATCH_DIR>/ide/requests/): this writes
`<id>.json` = {id, kind: "browser", args, at}, dispatch-bridge in the Agents window runs the
workbench's `_dispatch.browser` and answers `<id>.done` = {ok, result}. When Dispatch IDE is not
open (no fresh agents-window.json, or a bridge that does not list "browser"), it says so and does
the same with the standalone browser (`dispatch browser …`, Playwright, browserd) instead.
"""
import sys

sys.dont_write_bytecode = True

import argparse
import base64
import json
import re
import os
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import ide_show  # noqa: E402
from lang import t as _t  # noqa: E402

TAKE_WAIT_S = 6.0      # the bridge takes a request within a second; longer means it is not there
ANSWER_WAIT_S = 150.0  # an action can wait up to 90 s for the user to click Resume
FALLBACK_NOTE = _t("Dispatch IDE is not open; using the separate browser instead", "IDE 没开，改用独立浏览器")
TURBO_NOTE = _t("Turbo's parts work in temporary copies: they use an unseen separate browser instead of the built-in one in your window", "Turbo 的部分在临时副本里工作：不占用户窗口里的内置浏览器，改用看不见的独立浏览器")
OLD_BRIDGE_NOTE = _t("This Dispatch IDE cannot drive its built-in browser yet; using the separate browser instead", "这个 Dispatch IDE 还不会驱动内置浏览器，改用独立浏览器")


class IdeUnavailable(Exception):
    """Dispatch IDE cannot take the request; the caller falls back to the standalone browser."""


def engine_name(explicit=""):
    """Which agent the overlay names: --as, else what the terminal session is."""
    if explicit:
        return explicit
    import engines
    eng = engines.from_env()
    return eng.id if eng else "agent"


def target_args(target, css=""):
    """`click Sign in` → the first element with that visible text; `click e12` → the ref from `read`."""
    if css:
        return {"selector": css, "element": target or css}
    t = (target or "").strip()
    if not t:
        return {}
    if t[0] == "e" and t[1:].isdigit():
        return {"ref": t, "element": t}
    # what getByText(t) builds: case-insensitive, part of the text is enough
    return {"selector": "internal:text=%si >> nth=0" % json.dumps(t, ensure_ascii=False), "element": t}


# roles a click or a type is meant for, best first (a heading "Sign in to Acme" must not win over the button "Sign in")
CLICK_ROLES = ("button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option", "combobox", "textbox")
TYPE_ROLES = ("textbox", "searchbox", "combobox", "spinbutton")
_SNAP_LINE = re.compile(r'^\s*-\s+([a-z]+)\s+"((?:[^"\\]|\\.)*)"[^\n]*?\[ref=(e\d+)\]')


def ref_for(text, snapshot, op="click"):
    """The ref of the element whose name is exactly `text` in a `read` snapshot, the kind of element the
    action is for first; None when no name matches exactly (then the text selector finds it)."""
    want = " ".join((text or "").split()).casefold()
    if not want or not snapshot:
        return None
    roles = TYPE_ROLES if op == "type" else CLICK_ROLES
    best = None
    for line in snapshot.splitlines():
        m = _SNAP_LINE.match(line)
        if not m or " ".join(m.group(2).split()).casefold() != want:
            continue
        rank = roles.index(m.group(1)) if m.group(1) in roles else len(roles)
        if best is None or rank < best[0]:
            best = (rank, m.group(3))
    return best[1] if best else None


def ide_ready(now=None):
    """The Agents window's heartbeat when its bridge can drive the browser; raises IdeUnavailable."""
    if ide_show.turbo_part():
        # a Turbo part's page would stay in the person's panel after its copy is gone: the standalone browser, unseen
        raise IdeUnavailable(TURBO_NOTE)
    rec = ide_show.agents_window(now)
    if not rec:
        raise IdeUnavailable(FALLBACK_NOTE)
    if "browser" not in (rec.get("features") or []):
        raise IdeUnavailable(OLD_BRIDGE_NOTE)
    return rec


def send(args, take_wait=TAKE_WAIT_S, answer_wait=ANSWER_WAIT_S, sleep=time.sleep):
    """Hand one browser command to the Agents window and wait for its answer (the `_dispatch.browser` result)."""
    ide_ready()
    ide_show._sweep(time.time())
    rid = uuid.uuid4().hex[:12]
    req = os.path.join(ide_show.requests_dir(), rid + ".json")
    done = os.path.join(ide_show.requests_dir(), rid + ".done")
    ide_show._write(req, {"id": rid, "kind": "browser", "args": args, "at": time.time()})
    start = time.time()
    while True:
        if os.path.exists(done):
            try:
                with open(done, encoding="utf-8") as f:
                    ack = json.load(f)
            except (OSError, ValueError):
                ack = {"ok": False, "error": "unreadable answer"}
            try:
                os.remove(done)
            except OSError:
                pass
            if not ack.get("ok"):
                return {"ok": False, "error": ack.get("error") or "the bridge could not run it"}
            return ack.get("result") or {"ok": False, "error": "empty answer"}
        waited = time.time() - start
        if waited > take_wait and os.path.exists(req):
            # nobody took it: take it back so it does not run later
            try:
                os.remove(req)
            except OSError:
                pass
            raise IdeUnavailable(FALLBACK_NOTE)
        if waited > answer_wait:
            return {"ok": False, "error": "Dispatch IDE did not answer in %d s" % answer_wait}
        sleep(0.1)


def shots_dir():
    return os.path.join(ide_show.dispatch_dir(), "browser", "shots")


def save_shot(res, out=""):
    """Write the screenshot the IDE sent (base64) to a file; the answer then carries the path, not the bytes."""
    data = res.pop("image", None)
    if not data:
        return res
    ext = ".png" if (res.get("mime") or "").endswith("png") else ".jpg"
    path = os.path.abspath(os.path.expanduser(out)) if out else os.path.join(shots_dir(), "ide-%s%s" % (time.strftime("%Y%m%d-%H%M%S"), ext))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(base64.b64decode(data))
    res["path"] = path
    return res


def parser():
    p = argparse.ArgumentParser(prog="dispatch browser --ide", description="drive the browser built into Dispatch IDE's side pane (the separate browser when the IDE is not open)")
    sub = p.add_subparsers(dest="op", required=True)

    def add(name, help_):
        s = sub.add_parser(name, help=help_)
        s.add_argument("--json", action="store_true")
        s.add_argument("--page", default="", help="page id (default: the page opened last, else the one the side pane shows)")
        s.add_argument("--as", dest="engine", default="", help="who the page says is using it: claude / codex (default: guessed from the terminal)")
        return s

    s = add("open", "open a URL in the side pane's built-in browser")
    s.add_argument("url")
    s.add_argument("--profile", default="", help="the sign-in identity to open it with (a name such as Work); default: the one the person picked last")
    s = add("go", "go to another URL in the current page")
    s.add_argument("url")
    add("read", "read the page: title, URL, accessibility tree (elements carry a ref for click / type)")
    s = add("click", "click: visible text, or a ref from read (e12)")
    s.add_argument("target")
    s.add_argument("--css", default="", help="find the element with a CSS / Playwright selector")
    s = add("type", "type into an input")
    s.add_argument("target", help="the input: visible text (label, placeholder) or a ref")
    s.add_argument("text")
    s.add_argument("--submit", action="store_true", help="press Enter afterwards")
    s.add_argument("--css", default="")
    s = add("press", "press a key: Enter, Escape, Meta+A …")
    s.add_argument("key")
    s.add_argument("--on", default="", help="focus this element first (text or ref)")
    s.add_argument("--css", default="")
    s = add("shot", "take a screenshot; answers with the file path")
    s.add_argument("--out", default="", help="save it here (default <DISPATCH_DIR>/browser/shots/)")
    s = add("size", "lay the page out at this width and height (like a desktop browser window): some sites, such as Higgsfield, show their phone version in a narrow side pane")
    s.add_argument("size", help="width x height such as 1440x900; off goes back to the side pane's own size")
    add("status", "the pages open in the side pane, and whether an agent uses them")
    s = add("profiles", "the built-in browser's sign-in identities (each keeps its own sign-ins)")
    s.add_argument("--add", default="", metavar="NAME", help="make a new identity (empty; the person signs in on the page)")
    return p


def ide_args(a):
    args = {"action": a.op, "engine": engine_name(a.engine)}
    if a.page:
        args["page"] = a.page
    if a.op in ("open", "go"):
        args["url"] = a.url
        if a.op == "open" and a.profile:
            args["profile"] = a.profile
    elif a.op == "size":
        if (a.size or "").strip().lower() in ("off", "reset", "pane"):
            return args  # back to the pane's own size
        m = re.match(r"^\s*(\d+)\s*[x×*]\s*(\d+)\s*$", a.size or "")
        if not m:
            raise ValueError(_t("Write size as width x height, such as 1440x900; size off goes back to the side pane's own size", "size 要写成 宽x高，比如 1440x900；回到右栏本来的大小写 size off"))
        args.update(width=int(m.group(1)), height=int(m.group(2)))
    elif a.op == "profiles":
        if a.add:
            args.update(action="profile-add", name=a.add)
    elif a.op == "click":
        args.update(target_args(a.target, a.css))
    elif a.op == "type":
        args.update(target_args(a.target, a.css))
        args["text"] = a.text
        if a.submit:
            args["submit"] = True
    elif a.op == "press":
        args["key"] = a.key
        args.update(target_args(a.on, a.css))
    return args


def fallback_argv(a):
    """The same command for the standalone browser (`dispatch browser …`)."""
    if a.op == "open":
        return ["open", a.url]
    if a.op == "go":
        return ["open", a.url]
    if a.op == "read":
        return ["snapshot"]
    if a.op == "click":
        return ["click", a.css or a.target]
    if a.op == "type":
        return ["type", a.css or a.target, a.text] + (["--submit"] if a.submit else [])
    if a.op == "press":
        return ["press", a.key] + (["--selector", a.css or a.on] if (a.css or a.on) else [])
    if a.op == "shot":
        return ["shot"] + (["--out", a.out] if a.out else [])
    return ["status"]


def text_of(op, r):
    head = "%s  %s" % (r.get("title") or _t("(untitled)", "(无标题)"), r.get("url") or "")
    if op == "profiles":
        rows = r.get("profiles") or []
        return "\n".join("%s %s" % ("*" if p.get("current") else " ", p.get("name")) for p in rows) + \
            _t("\n(* is the identity new pages use; open <url> --profile <name> picks another)", "\n（* 是新页面默认用的身份；open <网址> --profile <名字> 换别的）")
    if r.get("profile"):
        head += _t("  [identity %s]", "  [身份 %s]") % r["profile"]
    if op == "status":
        pages = r.get("pages") or []
        if not pages:
            return _t("No page is open in the side pane", "右栏没有开着的页面")
        return "\n".join("%s %s  %s  %s%s" % ("*" if p.get("id") == r.get("page") else " ", p.get("id"), p.get("title") or _t("(untitled)", "(无标题)"), p.get("url") or "",
                                              ("" if p.get("agent") in (None, "idle") else "  [Agent %s]" % p["agent"]) +
                                              (_t("  [identity %s]", "  [身份 %s]") % p["profile"] if p.get("profile") else "")) for p in pages)
    if op == "shot":
        return r.get("path", "")
    if op == "open" and r.get("loading"):
        return head + _t("\nThe page is open and still loading (sites like this keep playing video and never finish loading): read again in a few seconds", "\n页面开了，还在加载（这类网站一直在放视频，等不到加载完）：过几秒 read 再看")
    if op == "size":
        return (_t("Done: the page is laid out at %s and scaled into the side pane  ", "好了：页面按 %s 排，缩小放进右栏  ") % r["size"] if r.get("size") else _t("Done: ", "好了：") + (r.get("text") or "") + "  ") + head
    if op in ("open", "go", "read"):
        return head + ("\n" + r["text"] if r.get("text") and op != "go" else "")
    return _t("Done: ", "好了：") + head


def main(argv=None):
    """Entry from `dispatch browser --ide …`."""
    a = parser().parse_args(argv)
    try:
        try:
            args = ide_args(a)
        except ValueError as e:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False) if a.json else str(e), file=sys.stdout if a.json else sys.stderr, flush=True)
            return 2
        if a.op == "profiles" or args.get("profile"):
            rec = ide_ready()
            if "browser-profiles" not in (rec.get("features") or []):
                # an older bridge would drop the identity and open the page as whoever is current
                msg = _t("This Dispatch IDE has no sign-in identities yet: ask the person to update Dispatch IDE, or open it without --profile", "这个 Dispatch IDE 还没有登录身份：请用户更新 Dispatch IDE，或不带 --profile 打开")
                if a.json:
                    print(json.dumps({"ok": False, "error": msg, "code": "old-ide"}, ensure_ascii=False), flush=True)
                else:
                    print(msg, file=sys.stderr)
                return 1
        if a.op == "size" and "browser-size" not in (ide_ready().get("features") or []):
            # an older bridge drops a request it does not know, and the CLI would wait for nothing
            msg = _t("This Dispatch IDE cannot lay pages out at desktop width yet: ask the person to update Dispatch IDE, or to make the side pane wider", "这个 Dispatch IDE 还不会按电脑宽度排页面：请用户更新 Dispatch IDE，或把右栏拉宽")
            if a.json:
                print(json.dumps({"ok": False, "error": msg, "code": "old-ide"}, ensure_ascii=False), flush=True)
            else:
                print(msg, file=sys.stderr)
            return 1
        target = a.on if a.op == "press" else getattr(a, "target", "")
        if args.get("selector", "").startswith("internal:text=") and not a.css:
            # a name given as text: find that element in the page's snapshot first
            snap = send({"action": "read", "engine": args["engine"], **({"page": a.page} if a.page else {})})
            ref = ref_for(target, snap.get("text") or "", a.op) if snap.get("ok") else None
            if ref:
                args.pop("selector")
                args["ref"] = ref
        res = send(args)
    except IdeUnavailable as e:
        if a.op == "profiles" or getattr(a, "profile", ""):
            # the identities live in Dispatch IDE's browser; the standalone browser has none
            msg = _t("Sign-in identities live in Dispatch IDE's built-in browser, and the IDE is not open: ask the person to open Dispatch IDE and try again", "登录身份在 Dispatch IDE 的内置浏览器里，IDE 现在没开：请用户打开 Dispatch IDE 再试")
            if a.json:
                print(json.dumps({"ok": False, "error": msg, "code": "ide-closed"}, ensure_ascii=False), flush=True)
            else:
                print(msg, file=sys.stderr)
            return 1
        print(str(e), file=sys.stderr, flush=True)
        import browser
        return browser.main(fallback_argv(a) + (["--json"] if a.json else []))
    if a.op == "open" and not res.get("ok"):
        # a page that keeps loading (video sites) runs past the wait but is open: say so, the next command uses it
        m = re.search(r"\(ID: ([\w-]+)\) is open", res.get("error") or "")
        if m:
            res = {"ok": True, "loading": True, "page": m.group(1), "url": a.url}
    if a.op == "shot" and res.get("ok"):
        res = save_shot(res, a.out)
    res.setdefault("ok", True)
    res["where"] = "ide"
    if a.json:
        print(json.dumps(res, ensure_ascii=False), flush=True)
    elif not res.get("ok"):
        print(res.get("error") or _t("It failed", "失败了"), file=sys.stderr)
    else:
        print(text_of(a.op, res))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
