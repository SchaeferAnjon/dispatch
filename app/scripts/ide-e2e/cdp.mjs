// A small Chrome DevTools Protocol client for Dispatch IDE test instances: no dependencies, runs on
// Node 22+ (global fetch and WebSocket), which includes the app's own Electron with
// ELECTRON_RUN_AS_NODE=1. Only 127.0.0.1: an instance's port is local by construction.

import { execFileSync } from "child_process";

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
    ws.addEventListener("close", () => {
      for (const { reject, method } of this.pending.values()) reject(new Error(`${method}: connection closed`));
      this.pending.clear();
    });
  }

  send(method, params = {}, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  /** Evaluate an expression in the page; returns its value (JSON-serialisable) or throws the page's error. */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    return r.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/** The targets of this instance: pages by default; a type list can include embedded delivery frames. */
export async function targets(port, type = "page") {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`CDP port ${port}: HTTP ${res.status}`);
  const types = Array.isArray(type) ? type : [type];
  return (await res.json()).filter((t) => types.includes(t.type));
}

/** Which window a target is: "agents" (sessions.html), "editor" (workbench.html) or "other". A development
 * build (ide/dev.sh, run from source) loads sessions-dev.html and workbench-dev.html. */
export function windowKind(url) {
  if (/\/sessions\/[^/]*\/sessions(-dev)?\.html/.test(url) || /sessions(-dev)?\.html(\?|$)/.test(url)) return "agents";
  if (/workbench(-dev)?\.html(\?|$)/.test(url) || /workbench\.esm\.html/.test(url)) return "editor";
  return "other";
}

export async function connect(target, { page = true } = {}) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error(`cannot connect to ${target.webSocketDebuggerUrl}`)), { once: true });
  });
  const c = new Cdp(ws);
  await c.send("Runtime.enable");
  if (page) await c.send("Page.enable");
  return c;
}

/** The instance's windows the person can see now: [[x, y, w, h], …] of the app with this pid that are on the
 *  screen and not fully transparent (macOS, CGWindowListCopyWindowInfo through osascript); null when that
 *  cannot be read (not macOS, no pid). */
export function onScreen(pid) {
  if (process.platform !== "darwin" || !pid) return null;
  const js = `ObjC.import('CoreGraphics');
function run(argv) {
  var pid = parseInt(argv[0], 10), out = [];
  var all = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0));
  for (var i = 0; i < all.count; i++) {
    var w = all.objectAtIndex(i);
    if (w.objectForKey('kCGWindowOwnerPID').intValue !== pid || w.objectForKey('kCGWindowLayer').intValue !== 0) continue;
    if (w.objectForKey('kCGWindowAlpha').doubleValue < 0.01) continue;  // fully transparent: nothing to see
    var b = w.objectForKey('kCGWindowBounds');
    out.push([b.objectForKey('X').intValue, b.objectForKey('Y').intValue, b.objectForKey('Width').intValue, b.objectForKey('Height').intValue]);
  }
  return JSON.stringify(out);
}`;
  try {
    return JSON.parse(execFileSync("osascript", ["-l", "JavaScript", "-e", js, String(pid)], { encoding: "utf8", timeout: 15000 }).trim());
  } catch {
    return null;
  }
}

/** Keep the instance off the person's screen (user 2026-10-01): `dispatch ide instance start` makes its windows
 *  transparent, click-through and never activating from inside the main process (hide-windows.mjs, through
 *  the --inspect port in the record). Here: the page acts as focused although the app never is (VS Code would
 *  otherwise behave as an unfocused window), the hiding is put in again when a window can be seen, and a
 *  window that still can be is reported, never swallowed. Returns the visible windows ([] when none, null
 *  when that cannot be read). */
export async function offscreen(rec, cdp) {
  if (cdp) await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, 5000).catch(() => {});
  if (process.env.DISPATCH_E2E_SHOW === "1" || !rec) return null;
  let shown = onScreen(rec.pid);
  if (shown && shown.length && rec.inspect_port) {
    await hideMain(rec.inspect_port, 5000).catch(() => null);
    await new Promise((r) => setTimeout(r, 300));
    shown = onScreen(rec.pid);
  }
  if (shown && shown.length) console.error(`warning: ${shown.length} window(s) of the test instance (pid ${rec.pid}) can be seen on the screen: ${JSON.stringify(shown)}`);
  return shown;
}

// ---- the main process: windows transparent, click-through, never activating (hide-windows.mjs) ----------

const hideSleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a busy main process takes the connection and does not answer (15 s seen): a fetch stops at the deadline, not 300 s later
const hideLeft = (until) => AbortSignal.timeout(Math.max(1, until - Date.now()));

const HIDE_HOOK = `(() => {
  const { app, BrowserWindow } = require("electron");
  if (!app || !app.isReady || !app.isReady() || typeof BrowserWindow?.getAllWindows !== "function") return { ready: false };
  const out = { ready: true, windows: 0, again: !!globalThis.__dispatchE2EHidden };
  const hide = (w) => {
    try { if (!w.isDestroyed()) { w.setOpacity(0); w.setIgnoreMouseEvents(true); } } catch (e) { /* a closing window */ }
  };
  if (!out.again) {
    const P = BrowserWindow.prototype;
    P.show = function () { hide(this); return this.showInactive(); };
    P.focus = function () { hide(this); };
    app.focus = () => {};
    app.on("browser-window-created", (_e, w) => { hide(w); w.on("show", () => hide(w)); });
    try { if (app.dock) app.dock.hide(); } catch (e) { /* not macOS */ }
    globalThis.__dispatchE2EHidden = true;
  }
  for (const w of BrowserWindow.getAllWindows()) { hide(w); out.windows++; }
  return out;
})()`;

/** Install the hiding in the main process behind this inspector port (hide-windows.mjs says what and why).
 *  Returns {windows, again}; throws when there is no inspector or the hook fails. */
export async function hideMain(port, waitMs = 30000, cdpPort = 0) {
  const until = Date.now() + waitMs;
  // the app's DevTools port answers once its browser side is up (after ready, before VS Code's first window):
  // nothing in the main process is touched before that
  for (let up = !cdpPort; !up && Date.now() < until; ) {
    up = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: hideLeft(until) }).then((res) => res.ok, () => false);
    if (!up) await hideSleep(50);
  }
  let target = null;
  while (Date.now() < until && !target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: hideLeft(until) })).json();
      target = list.find((t) => t.webSocketDebuggerUrl);
    } catch {
      /* not listening yet */
    }
    if (!target) await hideSleep(50);
  }
  if (!target) throw new Error(`no inspector on port ${port}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("cannot connect to the inspector")), { once: true });
  });
  const c = new Cdp(ws);
  // `require` comes with the command line API. Hooking while the app was still starting broke a start on the
  // build Mac (10-06): wait for the DevTools port above and for app.isReady().
  let r = null;
  let last = "";
  while (Date.now() < until) {
    r = await c.send("Runtime.evaluate", { expression: HIDE_HOOK, includeCommandLineAPI: true, returnByValue: true }, 10000).catch((e) => ({ exceptionDetails: { text: String(e.message || e) } }));
    if (!r.exceptionDetails && r.result?.value?.ready) break;
    last = r.exceptionDetails ? (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : "the app is not ready yet";
    r = null;
    await hideSleep(100);
  }
  c.close();
  if (!r) throw new Error(last || "timed out");
  return r.result.value;
}
