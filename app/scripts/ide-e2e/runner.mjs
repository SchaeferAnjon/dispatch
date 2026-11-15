// Runs one e2e scenario against a Dispatch IDE test instance. Started by `dispatch ide e2e run`
// (app/cli/ide_e2e.py) with the instance's own Electron as Node (ELECTRON_RUN_AS_NODE=1), so it needs
// nothing installed. It connects only to the port in the instance record the CLI hands it.
//
//   runner.mjs --record <instance.json> --scenario <file.mjs> --out <dir> [--window agents|editor]
//
// A scenario is an ES module whose default export is `async (ui) => { … }`; `ui` is the object below.
// Every step goes into <out>/steps.json (written after each step, so a run that dies still leaves it).

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { connect, offscreen, onScreen, targets, windowKind } from "./cdp.mjs";
import { describeFocus, focusVerdict, sendsChat } from "./focus.mjs";
import { locate } from "./locate.mjs";
import { coveredPairs, measureScript } from "./keep-clear.mjs";

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** How much longer waits may take on a loaded Mac (DISPATCH_E2E_TIME_SCALE, e.g. 3 on a shared build Mac): the waits of
 *  waitFor / waitForText / find / the scenario's whole limit grow by it; what is checked does not change. */
export const TIME_SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);

export class E2EError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const KEYS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  F1: { key: "F1", code: "F1", keyCode: 112 },
  // ⌘, : Dispatch's own Settings in the Agents window, VS Code's settings in the editor window
  "Cmd+,": { key: ",", code: "Comma", keyCode: 188, modifiers: 4 },
};
/** Keys that never change text: allowed wherever the focus is (Tab is not one: it indents in an editor). */
const SAFE_KEYS = new Set(["Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "F1", "Cmd+,"]);

export class Ui {
  constructor(rec, out, opts = {}) {
    this.rec = rec;
    this.port = rec.port;
    this.out = out;
    this.steps = [];
    this.marks = [];
    this.frames = [];
    this.shots = [];
    this.covers = []; // cards that showed by themselves on a message box (keep-clear.mjs)
    this.dirty = true; // something changed on screen since the last picture
    this.lastShot = null;
    this.path = []; // what was clicked since the last navigation helper started: the "how to get there"
    this.started = Date.now();
    this.windowKind = opts.window || "agents";
    this.meta = opts.meta || {};
    this.scenario = opts.scenario || "";
  }

  // ---- plumbing ------------------------------------------------------------------------------

  async attach(kind = this.windowKind, timeoutMs = 20000, title) {
    const until = Date.now() + timeoutMs;
    let last = [];
    while (Date.now() < until) {
      last = await targets(this.port).catch(() => []);
      const t = last.find((x) => windowKind(x.url) === kind && (title === undefined || x.title === title));
      if (t) {
        if (this.cdp) this.cdp.close();
        for (const c of (this.frames_ || new Map()).values()) c.close();
        this.frames_ = new Map();
        this.cdp = await connect(t);
        // never in front of the person (user 2026-10-01): hidden, acting focused; a window left on the screen is reported
        this.onScreen = await offscreen(this.rec, this.cdp);
        this.windowKind = kind;
        this.target = { id: t.id, title: t.title, url: t.url };
        // the workbench is drawn (a window that just opened is an empty page for a moment)
        while (Date.now() < until && !(await this.cdp.eval("!!document.querySelector('.monaco-workbench')").catch(() => false))) await sleep(300);
        const [w, h, dpr] = await this.cdp.eval("[innerWidth, innerHeight, devicePixelRatio]");
        this.viewport = { w, h, dpr };
        return t;
      }
      await sleep(300);
    }
    throw new E2EError("no_window", `no ${kind}${title ? ` titled ${title}` : ""} window in the instance on port ${this.port} (windows: ${last.map((t) => `${windowKind(t.url)}: ${t.title}`).join(", ") || "none"})`);
  }

  write() {
    const doc = {
      scenario: this.scenario,
      meta: this.meta,
      instance: {
        name: this.rec.name,
        port: this.rec.port,
        pid: this.rec.pid,
        app: this.rec.app,
        build: this.rec.build || {},
      },
      window: this.target || null,
      viewport: this.viewport || null,
      on_screen: this.onScreen ?? null,
      started: new Date(this.started).toISOString(),
      finished: this.finished ? new Date(this.finished).toISOString() : null,
      ok: this.ok ?? null,
      skipped: this.skipped || null,
      error: this.error || null,
      covers: this.covers,
      steps: this.steps,
      frames: this.frames,
      marks: this.marks,
      shots: this.shots,
    };
    fs.writeFileSync(path.join(this.out, "steps.json"), JSON.stringify(doc, null, 2));
  }

  async step(action, target, fn) {
    const s = { i: this.steps.length + 1, t: new Date().toISOString(), ms: Date.now() - this.started, action, window: this.windowKind };
    if (target !== undefined) s.target = target;
    this.steps.push(s);
    try {
      const r = await fn(s);
      s.ok = true;
      return r;
    } catch (e) {
      s.ok = false;
      s.error = e.message;
      if (e.code) s.code = e.code;
      throw e;
    } finally {
      this.write();
    }
  }

  /** Candidates on screen now: the window's own page first, then the webviews in it (their boxes in window coordinates). */
  async candidates(spec) {
    // {webview: false}: the window's page only; {webview: true}: the webviews only
    const inPage = !(spec && spec.webview === true);
    const r = inPage ? await this.cdp.eval(`(${locate.toString()})(${JSON.stringify(spec)})`) : { count: 0, hits: [] };
    if (r.hits.length || (spec && spec.webview === false)) return r;
    for (const w of await this.webviews()) {
      const inner = await w.cdp
        .eval(`(() => { const f = document.getElementById("active-frame"); const d = f && f.contentDocument; if (!d) return { count: 0, hits: [] };
                 const fr = f.getBoundingClientRect(); const res = (${locate.toString()})(${JSON.stringify(spec)}, d);
                 for (const h of res.hits) { h.box.x += fr.left; h.box.y += fr.top; } return res; })()`)
        .catch(() => ({ count: 0, hits: [] }));
      if (inner.hits.length) {
        for (const h of inner.hits) {
          h.box.x += w.box.x;
          h.box.y += w.box.y;
          h.webview = true;
        }
        return inner;
      }
    }
    return r;
  }

  /** The webviews shown in this window: [{cdp, box}] (Knowledge and other pages drawn by extensions). */
  async webviews() {
    const out = [];
    const ts = (await targets(this.port, "iframe").catch(() => [])).filter((t) => t.url.startsWith("vscode-webview://"));
    for (const t of ts) {
      const id = new URL(t.url).searchParams.get("id");
      const box = await this.cdp.eval(`(() => { const f = [...document.querySelectorAll("iframe")].find((f) => (f.getAttribute("src") || "").includes(${JSON.stringify("id=" + id)}));
        if (!f) return null; const r = f.getBoundingClientRect(); return r.width > 2 && r.height > 2 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; })()`);
      if (!box) continue;
      this.frames_ = this.frames_ || new Map();
      if (!this.frames_.has(t.id)) this.frames_.set(t.id, await connect(t, { page: false }));
      out.push({ cdp: this.frames_.get(t.id), box, id });
    }
    return out;
  }

  async find(spec, { timeoutMs = 8000 } = {}) {
    const until = Date.now() + timeoutMs * TIME_SCALE;
    let r;
    do {
      r = await this.candidates(spec);
      if (r.hits.length) return r;
      await sleep(250);
    } while (Date.now() < until);
    throw new E2EError("not_found", `nothing on screen matches ${JSON.stringify(spec)}`);
  }

  async mouse(type, x, y, extra = {}) {
    await this.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra });
  }

  async focus() {
    let d = await this.cdp.eval(`(${describeFocus.toString()})()`);
    if (d && d.frame) {
      // a webview has the focus: ask inside it (its outer document holds the page in #active-frame)
      const w = (await this.webviews()).find((x) => d.src.includes("id=" + x.id));
      if (w) d = await w.cdp.eval(`(${describeFocus.toString()})()`);
    }
    return { desc: d, verdict: focusVerdict(d) };
  }

  async settle(ms = 350) {
    await sleep(ms);
  }

  // ---- what scenarios call -------------------------------------------------------------------

  /**
   * Switch to the Agents window (the default), opening it when it is not up. With a folder, the Agents
   * window moves to that folder: an editor window takes ide/agents-request from the instance's
   * DISPATCH_DIR through dispatch-bridge (the Agents window takes no folder from outside; its own picker
   * only offers Open Folder..., a native dialog). Without one, the editor's title bar button opens it.
   * Everything happens inside the instance: no launcher, no second app process.
   */
  async openAgents(folder) {
    return this.step("openAgents", folder, async (s) => {
      const kinds = async () => (await targets(this.port)).map((t) => windowKind(t.url));
      const abs = folder ? path.resolve(String(folder).replace(/^~(?=\/)/, process.env.HOME || "~")) : "";
      const onFolder = { aria: `Show Sessions: ${path.basename(abs)}`, exact: true, webview: false };
      if (folder && (await kinds()).includes("agents")) {
        await this.attach("agents");
        if (await this.exists(onFolder)) folder = ""; // already there: leave the window as it is
      }
      if (folder) {
        if (!(await kinds()).includes("editor") && (await kinds()).includes("agents")) {
          // a build that starts in the Agents window alone: Editor (the side bar's last row; the title bar's in older
          // builds) opens the editor window
          await this.attach("agents");
          if (await this.exists({ aria: "Editor", exact: true, webview: false })) {
            await this.click({ aria: "Editor", exact: true, webview: false });
            for (const until = Date.now() + 60000; Date.now() < until && !(await kinds()).includes("editor"); ) await sleep(500);
            await sleep(3000);
          }
        }
        if (!(await kinds()).includes("editor")) throw new E2EError("no_editor", "opening the Agents window on a folder needs an editor window in the instance (instance start --folder)");
        const req = path.join(this.rec.dispatch_dir, "ide", "agents-request");
        fs.mkdirSync(path.dirname(req), { recursive: true });
        const until = Date.now() + 90000;
        let taken = false;
        while (Date.now() < until && !taken) {
          // written again only when 10 s went by untaken (an editor window's bridge looks every half second): a request
          // written every 2 s reached a slow window twice, and the late copy took it away from what was opened next
          fs.writeFileSync(req + ".tmp", JSON.stringify({ root: abs, at: Date.now() / 1000 }));
          fs.renameSync(req + ".tmp", req);
          for (let i = 0; i < 40 && !taken; i++) {
            await sleep(250);
            taken = !fs.existsSync(req);
          }
        }
        if (!taken) {
          fs.rmSync(req, { force: true });
          throw new E2EError("no_bridge", "no editor window took the agents-request in 90 s (dispatch-bridge not running?)");
        }
        s.detail = abs;
        await this.attach("agents", 60000);
        // the window settles on the folder (title bar), then lays out its side pane once more
        for (const until = Date.now() + 20000; Date.now() < until && !(await this.exists(onFolder)); ) await sleep(300);
        await sleep(2500);
      } else if (!(await kinds()).includes("agents")) {
        await this.attach("editor");
        await this.click("Dispatch Agent");
      }
      await this.attach("agents", 60000);
      await this.closeOverlays();
      this.dirty = true;
      this.path = ["Open Dispatch Agent"];
    });
  }

  /** Close what an earlier scenario left open (the Customizations dialog, a menu, a picker) with Escape. */
  async closeOverlays() {
    const open = { css: ".management-sidebar, .context-view .monaco-menu, .quick-input-widget:not([style*='display: none'])", webview: false };
    for (let i = 0; i < 3 && (await this.exists(open)); i++) {
      await this.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await sleep(400);
    }
  }

  /** Switch to the editor window (it must be open). */
  async openEditor() {
    return this.step("openEditor", undefined, async (s) => {
      await this.attach("editor");
      this.dirty = true;
      s.detail = this.target.title;
    });
  }

  /** The new session page; with a folder, on that folder (see openAgents). Sends nothing. */
  async newSession(folder) {
    if (folder) await this.openAgents(folder);
    await this.click("New Session");
    this.path = ["New"];
  }

  /** Pick the engine on the new-session page. A fresh instance lists OpenCode as "No models available"
   *  (disabled) until its model list arrives, which takes a while on a busy Mac: wait for it. */
  async pickEngine(name, timeoutMs = 120000) {
    const picker = ".sessions-chat-session-type-picker";
    const until = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.eval(`document.querySelector('${picker}')?.innerText.trim()`)) === name) {
        // Claude Code runs on Haiku in a test (the cheapest; ide_e2e.CLAUDE_TEST_MODEL): the menu's choice beats the default
        if (name === "Claude Code") await this.pickModel(/Haiku/i, "Claude Code's Haiku");
        return;
      }
      await this.click({ css: picker });
      await this.sleep(500);
      const state = await this.eval(`(() => { const r = [...document.querySelectorAll('.context-view .monaco-list-row')].find(r => r.innerText.split('\\n')[0].trim() === ${JSON.stringify(name)}); return !r ? 'missing' : r.classList.contains('option-disabled') ? 'disabled' : 'ok'; })()`);
      if (state === "ok") {
        await this.click({ text: name, exact: true, within: ".context-view" });
        await this.sleep(500);
        continue;
      }
      await this.press("Escape");
      if (Date.now() > until) throw new Error(`${name} stays ${state} in the engine picker after ${timeoutMs / 1000} s`);
      await this.sleep(3000);
    }
  }

  /** Reload the window the way a person does (F1, Developer: Reload Window) and attach to the new page. A page
   *  reload from the page itself (location.reload()) is refused by the workbench: nothing restarts. Throws when the
   *  window did not come back as a new page. */
  async reloadWindow(kind = this.windowKind) {
    const before = await this.eval("performance.timeOrigin");
    // no Escape first: on a question card Escape skips the question (session-liveness); only a quick pick open is closed
    if (await this.exists({ css: ".quick-input-widget:not([style*='display: none'])", webview: false })) await this.press("Escape");
    await this.press("F1");
    await this.type("Developer: Reload Window", { into: { css: ".quick-input-widget input" } });
    await sleep(800);
    await this.press("Enter");
    const until = Date.now() + 120000 * TIME_SCALE;
    for (;;) {
      await sleep(1500);
      try {
        await this.attach(kind, 30000);
        if ((await this.eval("performance.timeOrigin")) !== before) return;
      } catch {
        /* the old page is gone and the new one is not up yet */
      }
      if (Date.now() > until) throw new E2EError("timeout", "Developer: Reload Window did not bring the window back as a new page");
    }
  }

  /** A path inside the build's Resources/app: a development build runs from its source tree (ide/vscode), which is
   *  its Resources/app (ide_e2e.app_resources). */
  resources(...parts) {
    const dev = fs.existsSync(path.join(this.rec.app, ".build", "dispatch-dev.json"));
    return dev ? path.join(this.rec.app, ...parts) : path.join(this.rec.app, "Contents", "Resources", "app", ...parts);
  }

  /** Pick the cheap test model (cheapModel: the run's DISPATCH_E2E_OPENCODE_MODEL first) in the new session's model
   *  chip, the way a person does: open the menu, click its row. Returns the chip's text; throws when the menu has no
   *  cheap model, so a scenario never sends on another one. */
  async pickCheapModel(timeoutMs = 60000) {
    const chip = ".model-picker-split";
    const shown = () => this.eval(`document.querySelector('${chip}')?.innerText.trim() || ''`);
    const until = Date.now() + timeoutMs * TIME_SCALE;
    let names = [];
    for (;;) {
      if (await this.exists({ css: chip })) {
        // the menu's choice, not the chip's: GLM on the chip is cheap too, but the run may have been given DeepSeek
        const want = names.length && cheapModel(names);
        if (want && (await shown()).includes(want)) return shown();
        await this.click({ css: chip });
        await this.sleep(800);
        names = await this.eval(`[...document.querySelectorAll('.context-view *')].filter(e => !e.children.length && e.offsetParent).map(e => (e.textContent || '').trim()).filter(Boolean)`);
        const pick = cheapModel(names);
        if (pick) {
          await this.click({ text: pick, exact: true, within: ".context-view" });
          await this.sleep(800);
          if ((await shown()).includes(pick)) return shown();
        } else await this.press("Escape");
      }
      if (Date.now() > until) throw new Error(`no cheap test model in the model menu, refusing to send: ${await shown()} (menu: ${names.slice(0, 20).join(" | ")})`);
      await this.sleep(2000);
    }
  }

  /** Pick the model whose menu name matches `re` on the chip under the input; throws (and sends nothing) when the
   *  menu never has it. */
  async pickModel(re, what = String(re), timeoutMs = 60000) {
    const chip = ".model-picker-split";
    const shown = () => this.eval(`document.querySelector('${chip}')?.innerText.trim() || ''`);
    const until = Date.now() + timeoutMs * TIME_SCALE;
    let names = [];
    for (;;) {
      if (re.test(await shown())) return shown();
      if (await this.exists({ css: chip })) {
        await this.click({ css: chip });
        await this.sleep(800);
        names = await this.eval(`[...document.querySelectorAll('.context-view *')].filter(e => !e.children.length && e.offsetParent).map(e => (e.textContent || '').trim()).filter(Boolean)`);
        const pick = names.find((n) => re.test(n));
        if (pick) {
          await this.click({ text: pick, exact: true, within: ".context-view" });
          await this.sleep(800);
          if (re.test(await shown())) return shown();
        } else await this.press("Escape");
      }
      if (Date.now() > until) throw new Error(`${what} is not in the model menu, refusing to send: ${await shown()} (menu: ${names.slice(0, 20).join(" | ")})`);
      await this.sleep(2000);
    }
  }

  /** A session in the Sessions list, by the start of its title. */
  async openSession(title) {
    this.path = [];
    await this.click(title);
  }

  /**
   * A page of what was Customizations, now in Settings (⌘,): Overview (Find Skills, the agents, Installed by
   * Dispatch) is Abilities › More › Find skills, Migrations is Abilities › More › What Dispatch changed on this Mac,
   * MCP Servers is the MCP servers page, Agents is Sub-agents, Claude / Codex / OpenCode are those agents' pages under
   * Agents. Editor (Tab completion and ⌘K) is in the editor window's own Settings now: not here.
   */
  async openCustomizations(section = "Overview") {
    this.path = ["Settings"];
    const names = { "MCP Servers": "MCP servers", "Agents": "Sub-agents" };
    const agent = { "Claude": "claude", "Codex": "codex", "OpenCode": "opencode" }[section];
    if (!(await this.exists({ css: ".part.sidebar.dispatch-settings-open .dispatch-settings-nav", webview: false }))) {
      await this.press("Cmd+,");
      await this.waitFor({ css: ".part.sidebar.dispatch-settings-open .dispatch-settings-nav", webview: false }, { timeoutMs: 15000 });
    }
    const more = { Overview: "findskills", Migrations: "changes" }[section];
    if (agent) {
      await this.click({ css: '.dispatch-settings-nav .dsn-row[data-page="agents"]', webview: false });
      await this.click({ css: `.dispatch-settings-page .dset-row[data-agent="${agent}"]`, webview: false });
    } else if (more) {
      await this.click({ text: "Abilities", exact: true, within: ".dispatch-settings-nav" });
      const row = `.dispatch-settings-page [data-ability="${more}"]`;
      await this.waitFor({ css: row, webview: false }, { timeoutMs: 15000 });
      // under More, at the end of the list: below the fold on a short window
      await this.eval(`document.querySelector('${row}').scrollIntoView({ block: 'center' })`);
      await this.sleep(300);
      await this.click({ css: row, webview: false });
    } else {
      await this.click({ text: names[section] || section, exact: true, within: ".dispatch-settings-nav" });
    }
    await this.waitFor({ css: ".dispatch-settings-page .dset-embed:not([hidden]) .ai-customization-management-editor", webview: false }, { timeoutMs: 15000 });
  }

  /** Light, dark or the Mac's, the way a person does it: Settings (⌘,) › Appearance; Settings closes again after. */
  async setTheme(mode) {
    const nav = { css: ".part.sidebar.dispatch-settings-open .dispatch-settings-nav", webview: false };
    const wasOpen = await this.exists(nav);
    const thm = { css: `.dset-thm[data-mode="${mode}"]`, webview: false };
    // a folder the window is still being handed (openAgents on a busy Mac) can close Settings under us: open it again
    for (let i = 0; ; i++) {
      if (!(await this.exists(nav))) {
        await this.press("Cmd+,");
        await this.waitFor(nav, { timeoutMs: 15000 });
      }
      await this.click({ css: '.dispatch-settings-nav .dsn-row[data-page="appearance"]', webview: false });
      // the page draws itself once Dispatch has answered: wait for the switch before clicking it
      try {
        await this.waitFor(thm, { timeoutMs: 20000 });
        break;
      } catch (e) {
        if (i >= 2 || (await this.exists(nav))) throw e;
      }
    }
    await this.click(thm);
    if (mode !== "system") {
      const dark = mode === "dark";
      const until = Date.now() + 10000;
      while ((await this.eval("!!document.querySelector('.monaco-workbench.vs-dark')")) !== dark) {
        if (Date.now() > until) throw new E2EError("timeout", `the window did not turn ${mode}`);
        await sleep(200);
      }
    }
    if (!wasOpen) {
      await this.press("Escape");
      await this.waitFor(nav, { gone: true, timeoutMs: 10000 });
    }
  }

  /** The demo project the instance was seeded with (instance start without --no-seed). */
  get demoFolder() {
    return (this.rec.seed && this.rec.seed.folder) || this.rec.folder || "";
  }

  /** A tab of the side pane (Changes, Files, Docs, Tasks); from its + menu when it is not open. */
  async openTab(name) {
    // tabs carry their name as aria-label (the active one's text is cut to fit its close button)
    const tab = { aria: name, exact: true, within: ".tabs-container", webview: false };
    const paneShown = () => this.exists({ css: ".tabs-container .tab", webview: false });
    const waitPane = async (ms) => {
      for (const until = Date.now() + ms; Date.now() < until; await sleep(250)) if (await paneShown()) return true;
      return false;
    };
    // the side pane is closed: its toggle says Show side panel (older builds: Toggle Side Panel)
    const show = [{ aria: "Show side panel", webview: false }, { aria: "Toggle Side Panel", webview: false }]; // "Show side panel (⌥⌘B)": the shortcut is in the label
    const closed = async () => { for (const t of show) if (await this.exists(t)) return t; return undefined; };
    const open = async () => {
      const toggle = await closed();
      if (toggle) {
        await this.click(toggle);
        await waitPane(4000);
        await sleep(800); // the pane slides in: let it stand still before a tab is clicked
      }
    };
    if (!(await waitPane(4000))) await open();
    // tabs on screen can be another part's: no Add Tab in sight means the side pane is still closed
    if (!(await this.exists(tab)) && !(await this.exists({ aria: "Add Tab", exact: true, webview: false }))) await open();
    if (!(await this.exists(tab))) {
      await this.click("Add Tab");
      const item = { text: name, exact: true, within: ".context-view, .monaco-menu-container, .quick-input-widget" };
      await this.click((await this.exists(item)) ? item : { text: name, exact: true, webview: false });
    }
    // the tab strip settles first: a side pane that just slid in still moves and re-fits its tabs (the ones behind
    // fold to icons), and a click on where a tab was a moment ago lands on nothing (linked-hover in a new window)
    const where = () => this.eval(`(() => { const t = [...document.querySelectorAll('.tabs-container .tab')].find(e => (e.getAttribute('aria-label') || '').trim() === ${JSON.stringify(name)}); if (!t) return ''; const b = t.getBoundingClientRect(); return [b.left, b.top, b.width].map(Math.round).join(','); })()`);
    for (let i = 0, last = ""; i < 20; i++) {
      const now = await where();
      if (now && now === last) break;
      last = now;
      await sleep(200);
    }
    const state = () => this.eval(`(() => { const t = [...document.querySelectorAll('.tabs-container .tab')].find(e => (e.getAttribute('aria-label') || '').trim() === ${JSON.stringify(name)}); return t ? (t.classList.contains('active') ? 'active' : 'there') : 'gone'; })()`);
    // on its name, as a person clicks it (the close button used to sit over the name and closed the tab, task-fecz)
    // a click while the pane still lays itself out (a busy Mac) can land beside the tab: click again, as a person does
    for (let k = 0; k < 3 && (await state()) !== "active"; k++) {
      await this.click(tab);
      for (let i = 0; i < 16 && (await state()) === "there"; i++) await sleep(250);
    }
    const now = await state();
    if (now === "gone") throw new Error(`Clicking the name of the ${name} tab closed it instead of opening it`);
    if (now !== "active") throw new Error(`The ${name} tab did not come to the front when its name was clicked`);
  }

  async click(spec, opts = {}) {
    return this.step("click", spec, async (s) => {
      const r = await this.find(spec, opts);
      const h = r.hits[0];
      s.box = h.box;
      s.detail = h.label;
      if (r.count > 1) s.note = `${r.count} matches, took the first`;
      // opts.left: near the left edge (a tab cut short has its close button in the middle)
      const x = opts.left ? h.box.x + Math.min(12, h.box.w / 4) : h.box.x + h.box.w / 2;
      const y = h.box.y + h.box.h / 2;
      await this.mouse("mouseMoved", x, y);
      // a hand arrives after the tooltip it left behind is gone: the jump here is instant, and a press at once
      // landed on the last button's hover lying over the target (Hide side panel over the Tasks tab, linked-hover)
      const underHover = `(() => { const e = document.elementFromPoint(${x}, ${y}); return !!e && !!e.closest('.monaco-hover, .workbench-hover'); })()`;
      for (let i = 0; i < 12 && (await this.eval(underHover).catch(() => false)); i++) await sleep(60);
      await this.mouse("mousePressed", x, y, { clickCount: 1 });
      await this.mouse("mouseReleased", x, y, { clickCount: 1 });
      this.dirty = true;
      this.path.push(typeof spec === "string" ? spec : spec.text || spec.aria || spec.any || h.label);
      await this.settle(opts.settleMs ?? 400);
      return h;
    });
  }

  async hover(spec, opts = {}) {
    return this.step("hover", spec, async (s) => {
      const r = await this.find(spec, opts);
      const h = r.hits[0];
      s.box = h.box;
      s.detail = h.label;
      await this.mouse("mouseMoved", h.box.x + h.box.w / 2, h.box.y + h.box.h / 2);
      this.dirty = true;
      await this.settle(opts.settleMs ?? 600);
      return h;
    });
  }

  /**
   * Type into the focused input box. With `into`, click it first. Refuses (and stops the scenario)
   * when the focus is not an input box: never into an open file.
   */
  async type(text, opts = {}) {
    if (opts.into !== undefined) await this.click(opts.into);
    return this.step("type", opts.into, async (s) => {
      s.text = text;
      const { desc, verdict } = await this.focus();
      s.focus = { kind: verdict.kind, reason: verdict.reason, label: desc && desc.label };
      if (!verdict.ok) {
        await this.picture("refused-type").catch(() => {});
        throw new E2EError("focus", `refusing to type: ${verdict.reason}`);
      }
      await this.cdp.send("Input.insertText", { text });
      this.dirty = true;
      await this.settle(200);
    });
  }

  /**
   * Press a key (Enter, Escape, Tab, arrows, Backspace, Delete). Keys that edit text follow type()'s
   * focus rule. Enter in a chat input sends the message to a real agent (the Agents window lists this
   * Mac's real Claude sessions), so it needs {send: true}.
   */
  async press(key, opts = {}) {
    return this.step("press", key, async (s) => {
      const k = KEYS[key];
      if (!k) throw new E2EError("usage", `press: unknown key ${key} (known: ${Object.keys(KEYS).join(", ")})`);
      if (!SAFE_KEYS.has(key)) {
        const { desc, verdict } = await this.focus();
        s.focus = { kind: verdict.kind, reason: verdict.reason };
        if (verdict.kind === "document") throw new E2EError("focus", `refusing to press ${key}: ${verdict.reason}`);
        if (key === "Enter" && !opts.send && sendsChat(desc)) throw new E2EError("send", "refusing to press Enter in a chat input: that sends the message to an agent (pass {send: true} to mean it)");
      }
      const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, ...(k.modifiers ? { modifiers: k.modifiers } : {}) };
      await this.cdp.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text } : {}) });
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      this.dirty = true;
      await this.settle(300);
    });
  }

  /** Wait until something is on screen (or, with {gone: true}, until it is not). */
  async waitFor(spec, { timeoutMs = 10000, gone = false } = {}) {
    timeoutMs *= TIME_SCALE;
    return this.step("waitFor", spec, async (s) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const r = await this.candidates(spec);
        if (gone ? !r.hits.length : r.hits.length) {
          if (r.hits.length) s.box = r.hits[0].box;
          return r.hits[0];
        }
        if (Date.now() > until) throw new E2EError("timeout", `${gone ? "still on screen" : "never appeared"} after ${timeoutMs} ms: ${JSON.stringify(spec)}`);
        await sleep(250);
      }
    });
  }

  /** Whether something is on screen now (no waiting, no step). */
  /** The session's Now tab in the side pane, the way a person gets to it: the side pane opened when it is closed, the
   *  Now tab (first in the strip) clicked when another tab shows. */
  async openNowTab(timeoutMs = 40000) {
    return this.step("openNowTab", undefined, async () => {
      const NOW = `[...document.querySelectorAll('.tabs-container .tab')].find(t => /^Now/.test(t.getAttribute('aria-label') || t.textContent.trim()))`;
      const t0 = Date.now();
      while (!(await this.exists({ css: ".dispatch-now-tab[data-session]" }))) {
        if (await this.cdp.eval(`!!${NOW}`)) {
          await this.cdp.eval(`${NOW}.setAttribute('data-e2e-now', '1')`);
          await this.click({ css: '.tabs-container .tab[data-e2e-now="1"]' });
          await sleep(1000);
        } else if (await this.exists({ aria: "Show side panel", webview: false })) {
          await this.showSidePane();
        }
        if (Date.now() - t0 > timeoutMs) throw new E2EError("not_found", "no Now tab in the session's side pane");
        await sleep(500);
      }
    });
  }

  /** Scroll with the mouse wheel over `over` (a selector) until `spec` is on screen, the way a person scrolls a long
   *  list that only draws the rows in view (VS Code's lists). Down first, then back up. */
  async wheelUntil(spec, { over, step = 240, max = 60 } = {}) {
    return this.step("wheelUntil", spec, async (s) => {
      const box = await this.cdp.eval(`(() => { const e = document.querySelector(${JSON.stringify(over)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 200) }; })()`);
      if (!box) throw new E2EError("not_found", `nothing to scroll over: ${over}`);
      for (const dir of [1, -1]) {
        for (let i = 0; i < max; i++) {
          if ((await this.candidates(spec)).hits.length) {
            s.detail = `${dir > 0 ? "down" : "up"} ${i}`;
            this.dirty = true;
            return;
          }
          await this.mouse("mouseWheel", box.x, box.y, { deltaX: 0, deltaY: dir * step });
          await sleep(200);
        }
      }
      throw new E2EError("not_found", `${JSON.stringify(spec)} never came into view while scrolling ${over}`);
    });
  }

  /** The cheap test model among the rows of a model menu ([{name, desc}] or names), or undefined: GLM 5.3 Flash on the
   *  Z.AI Coding Plan, else DeepSeek V4.1 Flash, else a free OpenCode Zen model, MiMo Flash first (CLAUDE.md: tests
   *  never use Claude or a big model). The mini has only the free ones. */
  cheapModel(rows) {
    return cheapModel(rows);
  }

  /** Open the side pane with the title bar's toggle ("Show side panel (⌥⌘B)"), the way a person does; nothing when it is open. */
  async showSidePane() {
    const show = { aria: "Show side panel", webview: false };
    if (await this.exists(show)) {
      await this.click(show);
      await sleep(1200);
    }
  }

  /** Click a button once it can be pressed: a button drawn disabled until its page has what it needs (the setup's
   *  Set up Dispatch waits for the plan) takes no click, and a person waits for it to light up. */
  async clickWhenEnabled(spec, { timeoutMs = 60000 } = {}) {
    timeoutMs *= TIME_SCALE;
    const until = Date.now() + timeoutMs;
    for (;;) {
      const hit = (await this.candidates(spec)).hits[0];
      if (hit) {
        const off = await this.cdp.eval(`(() => { const e = document.elementFromPoint(${hit.box.x + hit.box.w / 2}, ${hit.box.y + hit.box.h / 2});
          const b = e && e.closest('.monaco-button, button, [role="button"]'); return !!b && (b.classList.contains('disabled') || b.disabled || b.getAttribute('aria-disabled') === 'true'); })()`);
        if (!off) return this.click(spec);
      }
      if (Date.now() > until) throw new E2EError("timeout", `${hit ? "still disabled" : "never appeared"} after ${timeoutMs} ms: ${JSON.stringify(spec)}`);
      await sleep(300);
    }
  }

  /** Wait until the window's text has this anywhere, on screen or scrolled out of view (a long sentence, a note at the
   *  end of a scrolling list): for "it is there", where waitFor is for "a person can see and click it". */
  async waitForText(needle, { timeoutMs = 30000, gone = false } = {}) {
    timeoutMs *= TIME_SCALE;
    return this.step(gone ? "waitForTextGone" : "waitForText", needle, async () => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const has = String(await this.cdp.eval("document.body.innerText")).includes(needle);
        if (has !== gone) return;
        if (Date.now() > until) throw new E2EError("not_found", `${gone ? "still in" : "never in"} the window after ${timeoutMs} ms: ${needle}`);
        await sleep(400);
      }
    });
  }

  async exists(spec) {
    const r = await this.candidates(spec);
    return r.hits.length > 0;
  }

  async picture(name) {
    const file = `${String(name).replace(/[^\w.\-]+/g, "-")}.png`;
    const shot = await this.cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(this.out, file), Buffer.from(shot.data, "base64"));
    return file;
  }

  /** A screenshot of the whole window, <out>/<name>.png. It also checks the rule tips keep (keep-clear.mjs). */
  async screenshot(name) {
    return this.step("screenshot", name, async (s) => {
      await this.settle(250);
      const file = await this.picture(name);
      s.shot = file;
      this.shots.push(file);
      this.lastShot = file;
      this.dirty = false;
      await this.checkKeepClear(s, file);
      return file;
    });
  }

  /** A tip or the first welcome on a message box (kanban task-lj06.21): noted on the step and failing the run at its end. */
  async checkKeepClear(s, file) {
    if (this.windowKind !== "agents" || (this.meta && this.meta.allowCovers)) return;
    try {
      const measured = JSON.parse(await this.cdp.eval(measureScript()));
      const covers = coveredPairs(measured.cards, measured.controls);
      if (covers.length) {
        s.covers = covers;
        this.covers.push(...covers.map((c) => ({ ...c, shot: file })));
      }
    } catch {
      /* a page in the middle of a reload: the next screenshot checks again */
    }
  }

  /**
   * Note where something is, for the "where is what" picture (`dispatch ide e2e annotate`).
   * note: "what · where · how", or {what, where, how}; where and how are filled in when left out.
   */
  async mark(spec, note = {}) {
    return this.step("mark", spec, async (s) => {
      const r = await this.find(spec);
      const h = r.hits[0];
      if (this.dirty || !this.lastShot) {
        const file = await this.picture(`frame-${this.frames.length + 1}`);
        this.lastShot = file;
        this.dirty = false;
      }
      if (!this.frames.includes(this.lastShot)) this.frames.push(this.lastShot);
      const n = typeof note === "string" ? splitNote(note) : { ...note };
      if (!n.what) n.what = h.label;
      if (!n.where) n.where = whereOnScreen(h.box, this.viewport);
      if (!n.how) n.how = this.path.length ? "点 " + [...this.path].join(" › ") : "打开就在";
      // vw: the window's width in CSS pixels, so annotate scales this frame right when a run spans two windows
      const m = { n: this.marks.length + 1, frame: this.lastShot, box: h.box, vw: this.viewport && this.viewport.w, label: h.label, ...n };
      this.marks.push(m);
      s.box = h.box;
      s.shot = this.lastShot;
      s.detail = `${m.n}. ${m.what}`;
      return m;
    });
  }

  /** Scroll the element with this text (or aria-label) into the middle of its scroll area. */
  async scrollTo(text) {
    return this.step("scrollTo", text, async (s) => {
      const ok = await this.cdp.eval(`((want) => {
        const norm = (t) => String(t || "").replace(/\\s+/g, " ").trim();
        const own = (e) => norm([...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(""));
        const all = [...document.querySelectorAll("*")];
        // the whole text first, else the start of a sentence (as the locator matches)
        const e = all.find((e) => own(e) === want || norm(e.getAttribute("aria-label")) === want) || all.find((e) => own(e).startsWith(want));
        if (!e) return false;
        e.scrollIntoView({ block: "center" });
        return true;
      })(${JSON.stringify(text)})`);
      if (!ok) throw new E2EError("not_found", `nothing to scroll to: ${text}`);
      this.dirty = true;
      await this.settle(500);
      const r = await this.candidates(text);
      if (r.hits.length) s.box = r.hits[0].box;
    });
  }

  /**
   * A page open in the integrated browser (an HTML deliverable in the right panel, `dispatch ide show`):
   * its own CDP target, found by a piece of its URL. The window's clicks and screenshots do not reach
   * into it, so it gets its own: click(css) with real mouse events on that page, type(css, text) into a
   * text field of it, eval(expr), screenshot(name) of the page alone.
   */
  async browserPage(match, { timeoutMs = 15000 } = {}) {
    const t = await this.step("browserPage", match, async (s) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const all = await targets(this.port, ["page", "iframe"]).catch(() => []);
        const hit = all.find((x) => windowKind(x.url) === "other" && x.url.includes(match));
        if (hit) {
          s.detail = hit.url;
          return hit;
        }
        if (Date.now() > until) throw new E2EError("not_found", `no page with ${match} in the integrated browser (pages: ${all.map((x) => x.url).join(", ")})`);
        await sleep(300);
      }
    });
    const c = await connect(t);
    if (!this.frames_) this.frames_ = new Map();
    this.frames_.set("browser:" + t.id, c);
    const ui = this;
    // Docs embeds the served page inside a webview. Its CDP context can read the document,
    // but screenshots and pointer events belong to the top-level window.
    const frameBox = async () => {
      if (t.type !== "iframe") return null;
      for (const w of await ui.webviews()) {
        const box = await w.cdp.eval(`(() => {
          function find(doc, x, y) {
            for (const f of doc.querySelectorAll('iframe')) {
              const r = f.getBoundingClientRect();
              if (f.src === ${JSON.stringify(t.url)}) return { x: x+r.x, y: y+r.y, w: r.width, h: r.height };
              try { if (f.contentDocument) { const hit = find(f.contentDocument, x+r.x, y+r.y); if (hit) return hit; } } catch {}
            }
            return null;
          }
          return find(document, 0, 0);
        })()`);
        if (box && box.w > 0 && box.h > 0) return { ...box, x: box.x + w.box.x, y: box.y + w.box.y };
      }
      throw new E2EError("not_found", `embedded page is not visible in this window: ${t.url}`);
    };
    const center = async (css) => {
      const r = await c.eval(`(() => { const e = document.querySelector(${JSON.stringify(css)}); if (!e) return null;
        e.scrollIntoView({ block: "center", behavior: "instant" }); const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
      if (!r) throw new E2EError("not_found", `nothing matches ${css} in ${t.url}`);
      await sleep(250);
      return r;
    };
    return {
      url: t.url,
      eval: (expression) => ui.step("browserEval", expression.slice(0, 120), async () => c.eval(expression)),
      click: (css) => ui.step("browserClick", css, async (s) => {
        const b = await center(css);
        s.box = b;
        const frame = await frameBox(), pointer = frame ? ui.cdp : c;
        const x = b.x + b.w / 2 + (frame?.x || 0), y = b.y + b.h / 2 + (frame?.y || 0);
        await pointer.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await pointer.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await pointer.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        ui.dirty = true;
        await sleep(300);
      }),
      type: (css, text) => ui.step("browserType", css, async (s) => {
        const b = await center(css);
        s.box = b;
        const ok = await c.eval(`(() => { const e = document.querySelector(${JSON.stringify(css)}); if (!e || !/^(INPUT|TEXTAREA)$/.test(e.tagName)) return false; e.focus(); return document.activeElement === e; })()`);
        if (!ok) throw new E2EError("focus", `${css} is not a text field`);
        await (t.type === "iframe" ? ui.cdp : c).send("Input.insertText", { text });
        ui.dirty = true;
      }),
      screenshot: (name) => ui.step("browserScreenshot", name, async (s) => {
        await sleep(250);
        const file = `${String(name).replace(/[^\w.\-]+/g, "-")}.png`;
        const frame = await frameBox();
        const shot = await (frame ? ui.cdp : c).send("Page.captureScreenshot", {
          format: "png", ...(frame ? { clip: { x: frame.x, y: frame.y, width: frame.w, height: frame.h, scale: 1 } } : {}),
        });
        fs.writeFileSync(path.join(ui.out, file), Buffer.from(shot.data, "base64"));
        s.shot = file;
        ui.shots.push(file);
        return file;
      }),
    };
  }

  /** Evaluate an expression in the window (reading state; not for typing). */
  /** The instance's windows a person can see on the screen now ([] when none, null when that cannot be read). */
  windowsOnScreen() {
    return onScreen(this.rec.pid);
  }

  async eval(expression) {
    return this.step("eval", expression.slice(0, 120), async () => this.cdp.eval(expression));
  }

  async sleep(ms) {
    await sleep(ms);
  }

  /** Stop here without failing: something this scenario needs is not on this Mac (a second Mac, a GitHub sign-in).
   *  Say what is missing and how to provide it; the run is reported as skipped with that reason, never as passed. */
  skip(reason) {
    throw new E2EError("skipped", String(reason));
  }
}

/** The words an agent's account says when it has used up its allowance, or "". */
export function outOfAllowance(text) {
  const m = String(text || "").match(/You've hit your (?:usage|weekly|session|daily) limit[^\n]{0,80}|used up its allowance[^\n]{0,40}|Insufficient Balance[^\n]{0,40}/i);
  return m ? m[0].trim() : "";
}

const FREE_ORDER = [/MiMo.*Flash.*Free/i, /Nemotron.*Lightning.*Free/i, /Nemotron.*Ultra.*Free/i, /Big Pickle/i, /Flash.*Free|Free.*Flash/i];
export function cheapModel(rows, wanted = process.env.DISPATCH_E2E_OPENCODE_MODEL || "") {
  const list = (rows || []).map((r) => (typeof r === "string" ? { name: r, desc: "", row: r } : { ...r, row: r }));
  const name = (r) => r.name || "";
  // the model the suite found answering (e2e_suite.free_model): "opencode/nemotron-3.5-lightning-free" is the menu's
  // "Nemotron 3.5 Lightning Free"
  // (and "deepseek/deepseek-flash" is "DeepSeek V4.1 Flash" from DeepSeek: every word of the id in the name)
  const key = (t) => String(t).toLowerCase().replace(/^opencode\//, "").replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");
  const words = (t) => key(t).split("-").filter(Boolean);
  const [provider, model] = String(wanted).includes("/") ? String(wanted).split("/", 2) : ["", wanted];
  const fits = (r) => key(name(r)) === key(wanted) || (!!model && words(model).every((w) => words(name(r)).includes(w))
    && (!r.desc || provider === "opencode" ? /OpenCode Zen|opencode/i.test(r.desc || "opencode") : new RegExp(provider.split("-")[0], "i").test(r.desc)));
  const want = wanted && list.find(fits);
  if (want) return want.row;
  const hit = list.find((r) => /GLM-5\.3[- ]Flash/i.test(name(r)) && (!r.desc || /Coding Plan/i.test(r.desc)))
    || list.find((r) => /DeepSeek.*Flash/i.test(name(r)) && (!r.desc || /deepseek/i.test(r.desc)));
  if (hit) return hit.row;
  for (const re of FREE_ORDER) {
    const r = list.find((x) => re.test(name(x)) && (!x.desc || /OpenCode Zen|opencode/i.test(x.desc)));
    if (r) return r.row;
  }
  return undefined;
}

export function splitNote(note) {
  const parts = String(note).split(/\s+·\s+/);
  return { what: parts[0] || "", where: parts[1] || "", how: parts.slice(2).join(" · ") || "" };
}

/** Where a box sits in the window, in words (the "在哪" of a mark when the scenario gave none). */
export function whereOnScreen(box, vp) {
  if (!vp) return "";
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  if (cy < 44) return cx < vp.w / 3 ? "标题栏左边" : cx > (vp.w * 2) / 3 ? "标题栏右边" : "标题栏中间";
  if (cx < vp.w * 0.27) return cy < vp.h * 0.6 ? "左侧栏上半" : "左侧栏下半";
  if (cx > vp.w * 0.6) return cy < 80 ? "右栏顶部页签" : "右栏";
  return cy > vp.h * 0.6 ? "中间下方" : "中间";
}

async function main() {
  const a = args(process.argv.slice(2));
  if (!a.scenario || (!a["print-meta"] && (!a.record || !a.out))) {
    console.error("usage: runner.mjs --record <instance.json> --scenario <file.mjs> --out <dir> [--window agents|editor]");
    process.exit(2);
  }
  if (a["print-meta"]) {
    // what the scenario declares (title, timeout, the instance it wants, what it needs): read by `dispatch ide e2e`
    const mod = await import(pathToFileURL(path.resolve(a.scenario)).href);
    console.log(JSON.stringify(mod.meta || {}));
    process.exit(0);
  }
  const rec = JSON.parse(fs.readFileSync(a.record, "utf8"));
  fs.mkdirSync(a.out, { recursive: true });
  const mod = await import(pathToFileURL(path.resolve(a.scenario)).href);
  const fn = mod.default;
  const ui = new Ui(rec, a.out, { window: a.window || (mod.meta && mod.meta.window) || "agents", meta: mod.meta || {}, scenario: path.resolve(a.scenario) });
  // a scenario that waits on purpose (a model answering, a session left alone for minutes) says so in meta.timeout (seconds)
  const limit = Math.max(Number(a.timeout || 300), Number((mod.meta && mod.meta.timeout) || 0)) * 1000 * TIME_SCALE;
  let timer;
  try {
    if (typeof fn !== "function") throw new E2EError("usage", "the scenario has no default export function");
    // the window the scenario starts in; openAgents() opens the Agents window when only the editor is up
    await ui.attach(ui.windowKind, 5000).catch(() => ui.attach(ui.windowKind === "agents" ? "editor" : "agents"));
    await Promise.race([
      fn(ui),
      new Promise((_, rej) => (timer = setTimeout(() => rej(new E2EError("timeout", `scenario over ${limit / 1000} s`)), limit))),
    ]);
    if (ui.covers.length) {
      const c = ui.covers[0];
      throw new E2EError("covers", `a card that shows by itself sat on the message box: ${c.card} over ${c.control} in ${c.shot}` + (ui.covers.length > 1 ? ` (and ${ui.covers.length - 1} more)` : ""));
    }
    ui.ok = true;
  } catch (e) {
    if (e.code === "skipped") {
      ui.ok = null;
      ui.skipped = e.message;
    } else {
      ui.ok = false;
      ui.error = { code: e.code || "error", message: e.message };
      if (ui.cdp) {
        try {
          const f = await ui.picture("error");
          ui.error.shot = f;
          // what the window said when it stopped, as text: read without opening the picture
          const said = String(await ui.cdp.eval("document.body.innerText"));
          fs.writeFileSync(path.join(ui.out, "error.txt"), said);
          // the agent's account ran out of allowance (Codex's weekly limit, Claude's): nothing this build can do, the
          // run says so as a skip with the account's own words, unless the scenario is about that notice
          const out = !(mod.meta && mod.meta.allowance === "tested") && outOfAllowance(said);
          if (out) {
            ui.skipped = `the agent's account is out of allowance on this Mac (${out}); failed on: ${e.message}`.slice(0, 600);
            ui.ok = null;
            ui.error = undefined;
          }
        } catch {
          /* the window is gone */
        }
      }
    }
  } finally {
    clearTimeout(timer);
    ui.finished = Date.now();
    ui.write();
    if (ui.cdp) ui.cdp.close();
    for (const c of (ui.frames_ || new Map()).values()) c.close();
  }
  console.log(JSON.stringify({ ok: ui.ok, skipped: ui.skipped || null, out: a.out, steps: ui.steps.length, shots: ui.shots, marks: ui.marks.length, error: ui.error || null }));
  process.exit(ui.ok ? 0 : ui.skipped ? 3 : 1);
}

// Node loads the module by its real path: run from a link's name (/tmp is /private/tmp on macOS) it compared unequal and
// the runner quietly did nothing ("场景没跑起来" with no output, kanban task-mpidn)
const invoked = (() => { try { return fs.realpathSync(process.argv[1] || ""); } catch { return process.argv[1] || ""; } })();
if (import.meta.url === pathToFileURL(invoked).href) main();
