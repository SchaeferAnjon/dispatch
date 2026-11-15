// The side pane's Docs tab, direction A (design/docs-tab/redesign): the list, a delivery that opens by
// itself, the reader and its way back, "Where to look", the task link, Open in editor, the
// prototype page, Search, Remove from Docs, the empty state, Ask Question, light and dark.
// It delivers one document for a task it makes on the instance's own board (never the real board).
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

export const meta = {
  instance: { fixture: "docs-project" },
  timeout: 900,
  title: "右栏 Docs 页签（方向 A：列表 + 就地打开）",
  description: "Agents 窗口右栏的 Docs 页签：按 Delivered / Designs 分组的列表（只放交付页和方案稿），交付一到自动在右栏打开，‹ Docs 和 Esc 回列表，在哪图的编号能点。",
};

// the instance's demo project with design drafts, deliveries and prototypes in it (fixtures/docs_project.py)
let KANBAN = "";
let DELIVERED = "";
const PROJECT = "demo";

/** The instance's own dispatch CLI, on the instance's board and data (never the caller's). */
function cli(ui, args) {
  const rec = ui.rec;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(VSCODE_|ELECTRON_|CLAUDE_CODE_|DISPATCH_|BEADS_|CODEX_THREAD|CODEX_SESSION)/.test(k) && k !== "CLAUDECODE") env[k] = v;
  }
  Object.assign(env, {
    BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home, DISPATCH_BIN: rec.cli,
    DISPATCH_E2E_INSTANCE: rec.name, PATH: `${path.join(rec.app, "Contents", "Resources", "app", "tools")}:${process.env.PATH || "/usr/bin:/bin"}`,
  });
  const r = spawnSync("python3", [rec.cli, ...args], { env, encoding: "utf8", timeout: 90000 });
  if (r.status !== 0) throw new Error(`dispatch ${args.join(" ")}: ${(r.stderr || r.stdout || "").trim().slice(-400)}`);
  return r.stdout;
}

/** The Agents window's theme: its user settings file, which the window reads again on change. */
async function theme(ui, which) {
  for (const dir of [ui.rec.user_data_dir, ui.rec.agents_user_data_dir]) {
    const f = path.join(dir, "User", "settings.json");
    let s = {};
    try {
      s = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      s = {};
    }
    Object.assign(s, { "window.autoDetectColorScheme": false, "git.ignoreLimitWarning": true, "workbench.colorTheme": which === "light" ? "Dispatch Light" : "Dispatch Dark" });
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(s, null, 2));
  }
  const want = which === "light" ? "vs" : "vs-dark";
  for (let i = 0; i < 30; i++) {
    if (await ui.eval(`document.querySelector('.monaco-workbench').classList.contains(${JSON.stringify(want)})`)) break;
    await ui.sleep(300);
  }
  await ui.sleep(800);
}

/** Drags the sash on the side pane's left edge until the pane is `width` wide. */
async function paneWidth(ui, width) {
  const info = JSON.parse(await ui.eval(`(() => { const g = [...document.querySelectorAll('.part.editor')].find(e => e.getBoundingClientRect().width > 0); const r = g.getBoundingClientRect(); const s = [...document.querySelectorAll('.monaco-sash.vertical')].map(e => e.getBoundingClientRect()).filter(b => b.height > 200 && Math.abs(b.x + b.width / 2 - r.x) < 12)[0]; return JSON.stringify({ right: r.right, sash: s ? { x: s.x + s.width / 2, y: s.y + s.height / 2 } : null }); })()`));
  if (!info.sash) return;
  const to = info.right - width;
  await ui.mouse("mouseMoved", info.sash.x, info.sash.y);
  await ui.mouse("mousePressed", info.sash.x, info.sash.y, { button: "left", clickCount: 1 });
  for (let i = 1; i <= 10; i++) await ui.mouse("mouseMoved", info.sash.x + ((to - info.sash.x) * i) / 10, info.sash.y, { button: "left", buttons: 1 });
  await ui.mouse("mouseReleased", to, info.sash.y, { button: "left", clickCount: 1 });
  await ui.sleep(600);
}

/** A screenshot, and the side pane's box in it (rects.json next to them), to crop the pane for the side-by-side. */
async function pane(ui, name) {
  await ui.screenshot(name);
  const r = await ui.eval(`(() => { const g = [...document.querySelectorAll('.part.editor .editor-group-container')].find(e => e.getBoundingClientRect().width > 0 && e.querySelector('.tabs-container')); if (!g) return null; const b = g.getBoundingClientRect(); return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height, dpr: devicePixelRatio }); })()`);
  const f = path.join(ui.out, "rects.json");
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    all = {};
  }
  all[name] = r ? JSON.parse(r) : null;
  fs.writeFileSync(f, JSON.stringify(all, null, 1));
}

/** The boxes (CSS px, window coordinates) of some elements in the last picture, for the "where" figure. */
async function boxes(ui, name, sels) {
  const r = await ui.eval(`JSON.stringify(Object.fromEntries(${JSON.stringify(Object.entries(sels))}.map(([k, s]) => { const e = document.querySelector(s); const b = e && e.getBoundingClientRect(); return [k, b ? [b.x, b.y, b.width, b.height] : null]; })))`);
  const f = path.join(ui.out, "rects.json");
  const all = JSON.parse(fs.readFileSync(f, "utf8"));
  all[name + ":els"] = JSON.parse(r);
  fs.writeFileSync(f, JSON.stringify(all, null, 1));
}

const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;

/** The reader's Markdown sits under the 1:1 "Where to look" picture: wait for it, then scroll it into view. */
async function markdownInView(ui, sel = ".dispatch-docs-md", timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await ui.eval(`(() => { const m = document.querySelector(${JSON.stringify(sel)}); if (!m) return false; m.scrollIntoView({ block: 'start' }); return true; })()`)) break;
    if (Date.now() > until) throw new Error(`never appeared after ${timeoutMs} ms: ${sel}`);
    await ui.sleep(250);
  }
  await ui.sleep(200);
}

async function expect(ui, what, expr) {
  const v = await ui.eval(expr);
  if (!v) throw new Error(`check failed: ${what}`);
  console.error(`ok: ${what}`);
  return v;
}

export default async function (ui) {
  KANBAN = ui.demoFolder;
  DELIVERED = ui.rec.docs_delivered || "";
  if (!fs.existsSync(DELIVERED)) throw new Error(`no ${DELIVERED}: the instance has no docs-project fixture`);
  await ui.openAgents(KANBAN);
  await theme(ui, "light");
  // a big project has more changes than git's limit: its warning toast would sit over the pane in every picture
  if (await ui.exists({ text: "Don't Show Again", exact: true })) await ui.click({ text: "Don't Show Again", exact: true });
  await ui.newSession();
  await ui.openTab("Docs");
  await ui.click({ css: ".tabs-container .tab[aria-label^='Docs']" });
  // a run before this one may have left a document open in the tab
  if (await ui.exists({ css: ".dispatch-docs-back" })) await ui.click({ css: ".dispatch-docs-back" });
  if (await ui.exists({ css: ".dispatch-docs-search-input" })) await ui.press("Escape");
  // a new session has no documents of its own yet: the project's, from the scope switch at the top
  // the second switch is the project (it carries the project's name once the list is read)
  const projectScope = { css: ".dispatch-docs-scope .dispatch-docs-pill:nth-child(2)" };
  await ui.waitFor(projectScope, { timeoutMs: 30000 });
  await ui.click(projectScope);
  await ui.waitFor({ css: ".dispatch-docs-row" }, { timeoutMs: 30000 });
  await ui.waitFor({ css: ".dispatch-docs-group-head" }, { timeoutMs: 20000 });
  await paneWidth(ui, 420); // the prototype's right panel
  await ui.sleep(800);

  // A1: the list
  await pane(ui, "01-list");
  await boxes(ui, "01-list", { tab: ".tabs-container .tab[aria-label^='Docs']", scope: ".dispatch-docs-scope", search: ".dispatch-docs-search-box", group: ".dispatch-docs-group-head", more: ".dispatch-docs-more" });
  await ui.mark({ css: ".dispatch-docs-scope" }, { what: "范围开关", where: "Docs 页签顶行左边", how: "This session 是这条会话的，项目名那格是整个项目的；和 Tasks 页签同一个开关" });
  await ui.mark({ css: ".dispatch-docs-search-box" }, { what: "Search", where: "列表顶上常驻的搜索框", how: "直接打字，⌘K 也行，Esc 清空" });
  await ui.mark({ css: ".dispatch-docs-group-head" }, { what: "分组", where: "列表里 Delivered / Designs", how: "点组头收起，按项目记住" });
  await ui.mark({ css: ".dispatch-docs-more" }, { what: "Show N more", where: "每组第 5 行下面", how: "每次再列 20 条" });

  // Show more in Designs, fold Delivered, scroll down: all kept when a document opens and ‹ Docs comes back
  const designsBefore = await ui.eval(`document.querySelectorAll('.dispatch-docs-list > section.dispatch-docs-group:nth-of-type(2) .dispatch-docs-row').length`);
  await ui.eval(`document.querySelector('.dispatch-docs-list > section.dispatch-docs-group:nth-of-type(2) .dispatch-docs-more').scrollIntoView({ block: 'center' })`);
  await ui.click({ css: ".dispatch-docs-list > section.dispatch-docs-group:nth-of-type(2) .dispatch-docs-more" });
  await ui.sleep(300);
  const designsAfter = await ui.eval(`document.querySelectorAll('.dispatch-docs-list > section.dispatch-docs-group:nth-of-type(2) .dispatch-docs-row').length`);
  if (!(designsAfter > designsBefore)) throw new Error(`Show more did not add rows (${designsBefore} -> ${designsAfter})`);
  console.error(`ok: Show more ${designsBefore} -> ${designsAfter} rows`);
  // the prototype rows sit further down in Designs since the list holds deliveries and proposals only
  // (the page's own document: a row drawn again a moment later is a new element, so look it up each time)
  for (let i = 0; i < 6 && !(await ui.eval(`!!${q(".dispatch-docs-row:not(.dispatch-docs-open-row) .dispatch-docs-acc")}`)); i++) {
    if (!(await ui.eval(`!!${q(".dispatch-docs-list > section.dispatch-docs-group:nth-of-type(2) .dispatch-docs-more")}`))) break;
    await ui.eval(`${q(".dispatch-docs-list > section.dispatch-docs-group:nth-of-type(2) .dispatch-docs-more")}.scrollIntoView({ block: 'center' })`);
    await ui.sleep(300);
    await ui.click({ css: ".dispatch-docs-list > section.dispatch-docs-group:nth-of-type(2) .dispatch-docs-more" });
    await ui.sleep(600);
  }
  if (!(await ui.eval(`!!${q(".dispatch-docs-row:not(.dispatch-docs-open-row) .dispatch-docs-acc")}`))) {
    throw new Error(`no row with a prototype in Designs (${await ui.eval(`document.querySelectorAll('.dispatch-docs-list > section.dispatch-docs-group:nth-of-type(2) .dispatch-docs-row').length`)} rows shown)`);
  }
  await ui.eval(`${q(".dispatch-docs-row:not(.dispatch-docs-open-row) .dispatch-docs-acc")}.scrollIntoView({ block: 'center' })`);
  await ui.mark({ css: ".dispatch-docs-row:not(.dispatch-docs-open-row) .dispatch-docs-acc" }, { what: "原型", where: "带原型的设计稿行尾的地球", how: "点行开说明，点地球直接开原型" });
  await ui.eval(`${q(".dispatch-docs-list")}.scrollTop = 0`);
  // a run before this one left Delivered folded (the fold is kept per project): unfold it first
  if (await ui.eval(`!!document.querySelector('.dispatch-docs-group.collapsed')`)) {
    await ui.click({ text: "Delivered", exact: true, within: ".dispatch-docs-list" });
    await ui.sleep(300);
  }
  await ui.click({ text: "Delivered", exact: true, within: ".dispatch-docs-list" });
  await expect(ui, "Delivered folds", `!!document.querySelector('.dispatch-docs-group.collapsed')`);
  await ui.eval(`${q(".dispatch-docs-list")}.scrollTop = 400`);
  await ui.sleep(300);
  const scrollBefore = await ui.eval(`${q(".dispatch-docs-list")}.scrollTop`);
  if (!(scrollBefore > 100)) throw new Error(`the list did not scroll (${scrollBefore})`);

  // A2: a delivery arrives; the pane opens it by itself and the Docs tab flashes
  const out = cli(ui, ["begin", "Docs 页签交付自测：交付一到右栏直接打开这份说明", "-P", PROJECT, "-d", "e2e docs-tab scenario: a task on the instance board to deliver a document for", "--force"]);
  const task = (out.match(/\b(task-[a-z0-9]+)\b/) || [])[1];
  if (!task) throw new Error("no task id in: " + out);
  await ui.eval(`(() => { window.__flashSeen = false; const o = new MutationObserver(() => { if (document.querySelector('.tabs-container .tab.dispatch-docs-flash')) window.__flashSeen = true; }); o.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] }); window.__flashObs = o; })()`);
  await ui.cdp.send("Page.bringToFront"); // with several Agents windows, the one in front takes the delivery
  const shown = JSON.parse(cli(ui, ["task", "deliver", task, "--file", DELIVERED, "--show", "--json"]));
  if (!shown.shown || !shown.shown.shown) throw new Error("deliver --show did not open it: " + JSON.stringify(shown.shown));
  await ui.waitFor({ css: ".dispatch-docs-reader .dispatch-docs-where" }, { timeoutMs: 45000 });
  await ui.waitFor({ text: "Delivered just now for", within: ".dispatch-docs-context" }, { timeoutMs: 20000 });
  await expect(ui, "the Docs tab flashed", `window.__flashSeen === true`);
  // a document has a tab of its own in the strip (direction B, task-fif4i), named by its title up to the colon
  await expect(ui, "its own tab, named by its title", `[...document.querySelectorAll('.tabs-container .tab.dispatch-tab-doc')].some(t => (t.getAttribute('aria-label') || '').startsWith('Docs 页签重设计'))`);
  await ui.sleep(600);
  await pane(ui, "02-delivered");
  await boxes(ui, "02-delivered", { tab: ".tabs-container .tab[aria-label^='Docs']", back: ".dispatch-docs-back", context: ".dispatch-docs-context", where: ".dispatch-docs-where", actions: ".dispatch-docs-reader-head .dispatch-docs-icon" });
  await ui.mark({ css: ".dispatch-docs-back" }, { what: "‹ Docs", where: "阅读页头行左边", how: "回列表，滚动位置和收起的组都在；Esc 也行" });
  await ui.mark({ css: ".dispatch-docs-context" }, { what: "Delivered just now for 任务名", where: "标题上面一行", how: "点任务名去 Tasks，那张卡展开闪一下" });
  await ui.mark({ css: ".dispatch-docs-where .vp" }, { what: "在哪取景框", where: "标题下面", how: "1:1 原图，框外压暗；能拖" });
  await ui.mark({ css: ".dispatch-docs-where .dispatch-where-leg" }, { what: "编号说明", where: "取景框下面", how: "点哪一行取景框移过去" });

  // Where to look: a line moves the viewport there
  const t0 = await ui.eval(`${q(".dispatch-docs-where .vp img")}.style.transform`);
  await ui.click({ css: ".dispatch-docs-where .dispatch-where-leg li:nth-child(3)" });
  await ui.sleep(400);
  const t1 = await ui.eval(`${q(".dispatch-docs-where .vp img")}.style.transform`);
  if (t0 === t1) throw new Error(`the viewport did not move (${t0})`);
  await expect(ui, "line 3 is the selected one", `document.querySelector('.dispatch-docs-where .dispatch-where-leg li:nth-child(3)').classList.contains('on')`);
  console.error(`ok: viewport ${t0} -> ${t1}`);
  await pane(ui, "03-where-3");

  // ‹ Docs: back to the list where it was
  await ui.click({ css: ".dispatch-docs-back" });
  await ui.waitFor({ css: ".dispatch-docs-list" });
  await ui.sleep(300);
  const scrollAfter = await ui.eval(`${q(".dispatch-docs-list")}.scrollTop`);
  if (Math.abs(scrollAfter - scrollBefore) > 2) throw new Error(`scroll not kept: ${scrollBefore} -> ${scrollAfter}`);
  await expect(ui, "Delivered still folded", `!!document.querySelector('.dispatch-docs-group.collapsed')`);
  console.error(`ok: scroll kept at ${scrollAfter}`);
  await pane(ui, "04-back-to-list");

  // Esc goes back too
  await ui.eval(`${q(".dispatch-docs-list")}.scrollTop = 0`);
  await ui.click({ css: ".dispatch-docs-group:not(.collapsed) .dispatch-docs-row .t" });
  await ui.waitFor({ css: ".dispatch-docs-reader" });
  await ui.press("Escape");
  await ui.waitFor({ css: ".dispatch-docs-list" });
  await expect(ui, "Esc is back on the list", `!document.querySelector('.dispatch-docs-reader')`);

  // open the delivered one again from the list (the reader has no Enlarge of its own any more: fb6a2ee2)
  await ui.click({ text: "Delivered", exact: true, within: ".dispatch-docs-list" });
  await expect(ui, "Delivered unfolds", `!document.querySelector('.dispatch-docs-group.collapsed')`);
  await ui.click({ text: "Docs 页签重设计", within: ".dispatch-docs-list" });
  await ui.waitFor({ css: ".dispatch-docs-where" });
  await expect(ui, "no Enlarge in the reader", `!document.querySelector('.dispatch-docs-enlarge')`);

  // dark: the same page
  await theme(ui, "dark");
  await pane(ui, "06-delivered-dark");
  await ui.click({ css: ".dispatch-docs-back" });
  await ui.waitFor({ css: ".dispatch-docs-list" });
  await ui.eval(`${q(".dispatch-docs-list")}.scrollTop = 0`);
  await ui.sleep(300);
  await pane(ui, "07-list-dark");
  await theme(ui, "light");

  // the task link: to the Tasks tab, that card opens and flashes
  await ui.click({ text: "Docs 页签重设计", within: ".dispatch-docs-list" });
  await ui.waitFor({ css: ".dispatch-docs-context a.task" });
  // the flash lasts two seconds: the card's id is written down the moment it lights
  await ui.eval(`(() => { window.__flashedId = ''; const o = new MutationObserver(() => { const c = document.querySelector('.dispatch-docs-flash-card'); if (c && !window.__flashedId) { window.__flashedId = c.dataset.taskId || '-'; o.disconnect(); } }); o.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true }); })()`);
  await ui.click({ css: ".dispatch-docs-context a.task" });
  await ui.waitFor({ css: ".dispatch-tasks" }, { timeoutMs: 15000 });
  for (let i = 0; i < 100 && !(await ui.eval(`window.__flashedId`)); i++) await ui.sleep(250);
  // the list may draw the card again: the picture marks that task's card by its id
  const flashed = (await ui.eval(`window.__flashedId`)).replace(/^-$/, '');
  if (!flashed) throw new Error("the flashed card has no task id");
  const card = { css: `.dispatch-tasks [data-task-id="${flashed}"]` };
  await ui.sleep(800); // the smooth scroll that brings it into view
  await pane(ui, "08-task");
  await ui.mark(card, { what: "那张任务卡", where: "Tasks 页签", how: "从文档第二行的任务名跳过来，闪一下" });

  // back on the document's own tab the reader is where it was; Open in editor opens the Markdown Editor tab
  await ui.click({ css: ".tabs-container .tab.dispatch-tab-doc[aria-label^='Docs 页签重设计']" });
  await ui.waitFor({ css: ".dispatch-docs-reader" });
  await ui.click({ aria: "More Actions", exact: true, within: ".dispatch-docs-reader-head" });
  await ui.click({ text: "Open in Editor", exact: true, within: ".context-view" });
  await ui.sleep(3500);
  await expect(ui, "a Markdown Editor tab opened", `[...document.querySelectorAll('.tabs-container .tab')].some(t => /README/.test(t.getAttribute('aria-label') || ''))`);
  await pane(ui, "09-open-in-editor");
  await ui.mark({ css: ".editor-group-header" }, { what: "Markdown Editor 页签表头", where: "Open in editor 打开的页签", how: "‹ Docs 回 Docs；面包屑不再被右边的 Markdown Editor 压住" });

  // the prototype page from a row's globe, Notes back to its README
  // the Docs tab is the list (a document read is a tab of its own, task-fif4i)
  await ui.click({ css: ".tabs-container .tab[aria-label^='Docs']" });
  await ui.waitFor({ css: ".dispatch-docs-list" });
  // the list is drawn again: the prototype row may be behind Show more or below the fold once more
  await ui.waitForText("Designs", { timeoutMs: 20000 }).catch(() => undefined);
  for (let i = 0; i < 8 && !(await ui.eval(`!!${q(".dispatch-docs-row:not(.dispatch-docs-open-row) .dispatch-docs-acc")}`)); i++) {
    if (!(await ui.eval(`!!${q(".dispatch-docs-list > section.dispatch-docs-group:nth-of-type(2) .dispatch-docs-more")}`))) { await ui.sleep(1000); continue; }
    await ui.eval(`${q(".dispatch-docs-list > section.dispatch-docs-group:nth-of-type(2) .dispatch-docs-more")}.scrollIntoView({ block: 'center' })`);
    await ui.sleep(300);
    await ui.click({ css: ".dispatch-docs-list > section.dispatch-docs-group:nth-of-type(2) .dispatch-docs-more" });
    await ui.sleep(600);
  }
  await ui.eval(`${q(".dispatch-docs-row:not(.dispatch-docs-open-row) .dispatch-docs-acc")}?.scrollIntoView({ block: 'center' })`);
  await ui.sleep(300);
  await ui.waitFor({ css: ".dispatch-docs-row:not(.dispatch-docs-open-row) .dispatch-docs-acc" });
  await ui.click({ css: ".dispatch-docs-row:not(.dispatch-docs-open-row) .dispatch-docs-acc" });
  // a prototype opens in the integrated browser, in its own tab (fb6a2ee2), not in the Docs reader
  await ui.waitFor({ css: ".tabs-container .tab.dispatch-tab-doc.active" }, { timeoutMs: 15000 });
  await ui.sleep(2500);
  await expect(ui, "the prototype is not drawn in the Docs reader", `!document.querySelector('.dispatch-docs-frame')`);
  await pane(ui, "10-prototype");
  await ui.mark({ css: ".tabs-container .tab.dispatch-tab-doc.active" }, { what: "原型页在自己的标签里", where: "右栏标签条", how: "点 Docs 里那一行的地球" });
  await ui.click({ css: ".tabs-container .tab[aria-label^='Docs']" });
  await ui.waitFor({ css: ".dispatch-docs-list" });

  // Search
  await ui.click({ css: ".dispatch-docs-search-box" });
  await ui.type("Waiting", { into: { css: ".dispatch-docs-search-input" } });
  await ui.sleep(500);
  await expect(ui, "search narrows the list", `[...document.querySelectorAll('.dispatch-docs-row .t')].every(t => /waiting/i.test(t.textContent) || /waiting/i.test(t.closest('.dispatch-docs-row').title))`);
  await pane(ui, "11-search");
  await ui.press("Escape");
  await ui.waitFor({ css: ".dispatch-docs-search-box" });

  // Remove from Docs (the one delivered above), through "…"; the list is drawn anew after the search: top, Delivered open
  await ui.waitFor({ css: ".dispatch-docs-list" });
  await ui.eval(`${q(".dispatch-docs-list")}.scrollTop = 0`);
  await ui.sleep(300);
  if (await ui.eval(`[...document.querySelectorAll('.dispatch-docs-group.collapsed')].some(g => /^Delivered/.test((g.innerText || '').trim()))`)) await ui.click({ text: "Delivered", exact: true, within: ".dispatch-docs-list" });
  await ui.waitFor({ text: "Docs 页签重设计", within: ".dispatch-docs-list" }, { timeoutMs: 20000 });
  await ui.click({ text: "Docs 页签重设计", within: ".dispatch-docs-list" });
  await ui.waitFor({ css: ".dispatch-docs-reader" });
  await ui.click({ aria: "More Actions", exact: true, within: ".dispatch-docs-reader-head" });
  await ui.waitFor({ text: "Remove from Docs" }, { timeoutMs: 5000 });
  await pane(ui, "12-more-menu");
  await ui.click({ text: "Remove from Docs" });
  await ui.waitFor({ css: ".dispatch-docs-list" });
  await ui.sleep(2500);
  await expect(ui, "the removed one is not listed", `![...document.querySelectorAll('.dispatch-docs-row .t')].some(t => t.textContent.startsWith('Docs 页签重设计'))`);
  const listed = JSON.parse(cli(ui, ["docs", "list", "--folder", KANBAN, "--local", "--json"]));
  if (listed.docs.some((d) => d.path === DELIVERED)) throw new Error("docs list still has the removed document");
  console.error("ok: removed from docs list");

  // the empty state of a session with nothing delivered
  await ui.click({ text: "This session", exact: true, within: ".dispatch-docs-scope" });
  // the empty state: what is missing, then what comes here (two lines, as before the onboarding change)
  await ui.waitFor({ text: "No docs in this session yet.", within: ".dispatch-docs-empty" });
  await ui.waitFor({ text: "When the agent delivers something, it opens here.", within: ".dispatch-docs-empty" });
  await pane(ui, "13-empty");
  await ui.click({ css: ".dispatch-docs-scope .dispatch-docs-pill:nth-child(2)" });

  // Ask Question on selected text
  await ui.click({ css: ".dispatch-docs-search-box" });
  await ui.type("Tasks 页签重设计", { into: { css: ".dispatch-docs-search-input" } });
  await ui.sleep(500);
  await ui.press("Enter", { send: false }); // Enter in the search box opens the first hit
  await markdownInView(ui, ".dispatch-docs-md p");
  await ui.eval(`(() => { const p = document.querySelector('.dispatch-docs-md p'); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); })()`);
  await ui.sleep(500);
  await expect(ui, "Ask Question shows on a selection", `(() => { const w = document.querySelector('.dispatch-docs-ask'); return !!w && w.style.display !== 'none' && w.offsetHeight > 0; })()`);
  await pane(ui, "14-ask");
  await ui.press("Escape");

  // a delivery page (`dispatch deliver … --show`) opens in the integrated browser from the bridge's page server
  const dp = path.join(ui.out, "_delivery");
  fs.mkdirSync(dp, { recursive: true });
  fs.copyFileSync(path.join(ui.out, "01-list.png"), path.join(dp, "01-list.png"));
  fs.writeFileSync(path.join(dp, "notes.md"), "# Docs 页签自测交付页\n\n列表按类分组，交付一到右栏直接打开。\n\n## 改了什么\n\n![列表](01-list.png)\n");
  await ui.cdp.send("Page.bringToFront");
  const dres = JSON.parse(cli(ui, ["deliver", task, "--from", dp, "--model", "Opus 5.5 · high", "--show", "--json"]));
  if (!dres.shown || !dres.shown.shown) throw new Error("deliver --show did not open it: " + JSON.stringify(dres.shown || dres));
  // it opens in the integrated browser from the bridge's page server (its Choose A / B records the pick)
  await ui.waitFor({ css: ".tabs-container .tab.dispatch-tab-doc.active" }, { timeoutMs: 30000 });
  const served = await ui.browserPage("127.0.0.1:", { timeoutMs: 20000 });
  await ui.sleep(2000);
  if (!(await served.eval("document.title")).includes("Docs 页签自测交付页")) throw new Error("the served page is not the delivery");
  console.error("ok: the delivery page opens in its own tab from the page server");
  await pane(ui, "15-delivery-page");
  await theme(ui, "dark");
}
