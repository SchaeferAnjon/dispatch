// The side pane's History tab (Dispatch IDE patches/450-history.patch, kanban app/cli/session_history.py):
// every agent session on the Mac, also ones never opened in Dispatch, without importing any. It seeds a few
// Claude Code and Codex conversations in folders under the instance (a project with a copy, a second project, a
// folder that is gone), then walks the person's path: open History from +, the project / this folder / All
// switch, search (title, reply, what was typed), the view options, a row opened, Continue (a terminal session
// picking the conversation up), a session whose folder is gone, Open in New Window, light and dark, and the
// Tasks tab next to it for comparison. The Claude transcripts it writes are removed at the end.
import fs from "fs";
import path from "path";
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

export const meta = {
  timeout: 1200, // a first look reads the whole history: minutes on a busy Mac
  title: "右栏 History 页签：电脑上所有会话，能看能搜，默认不导入",
  description: "Agents 窗口右栏的 History 页签：按项目分组列出这台 Mac 上 Claude Code、Codex 等 Agent 留下的所有会话（包括从没在 Dispatch 里开过的），能切 This folder / 项目 / All、能搜标题和内容，点 Continue 在聊天或终端里接着聊；看不会把任何会话加进左栏。",
};

const line = (o) => JSON.stringify(o) + "\n";
const iso = (t) => new Date(t * 1000).toISOString();

function claudeLines(cwd, t0, turns, model = "claude-opus-5-5") {
  let s = "";
  turns.forEach(([ask, answer], i) => {
    const t = t0 + i * 120;
    s += line({ type: "user", cwd, sessionId: "x", timestamp: iso(t), message: { role: "user", content: ask } });
    s += line({ type: "assistant", cwd, timestamp: iso(t + 30), message: { model, role: "assistant", content: [{ type: "text", text: answer }] } });
  });
  return s;
}

function codexLines(sid, cwd, t0, turns, model = "gpt-6-astra", parent = "") {
  const meta = { id: sid, cwd, originator: "codex_cli_rs", source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : "cli" };
  if (parent) meta.parent_thread_id = parent;
  let s = line({ timestamp: iso(t0), type: "session_meta", payload: meta });
  s += line({ timestamp: iso(t0), type: "turn_context", payload: { model, cwd } });
  turns.forEach(([ask, answer], i) => {
    const t = t0 + i * 90;
    s += line({ timestamp: iso(t), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: ask }] } });
    s += line({ timestamp: iso(t + 20), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] } });
  });
  return s;
}

/** A small, known history on disk: what the person would have left behind with their agents. */
function seedHistory(ui) {
  const rec = ui.rec;
  const real = (p) => fs.realpathSync(p);
  const demo = real(rec.folder || ui.demoFolder);
  const base = path.join(real(rec.root), "projects");
  const shop = path.join(base, "shop");
  const wt = path.join(base, "shop-wt", "one-page-checkout");
  const notes = path.join(base, "reading-notes");
  const gone = path.join(base, "old-experiment");
  fs.mkdirSync(path.join(shop, ".git", "worktrees", "one-page-checkout"), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${shop}/.git/worktrees/one-page-checkout\n`);
  fs.mkdirSync(path.join(notes, ".git"), { recursive: true });
  const claudeRoot = path.join(process.env.HOME || "", ".claude", "projects");
  const written = [];
  const now = Math.floor(Date.now() / 1000);
  const claude = (sid, cwd, ago, turns, subs = 0, model) => {
    const dir = path.join(claudeRoot, cwd.replace(/[^A-Za-z0-9]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${sid}.jsonl`);
    fs.writeFileSync(f, claudeLines(cwd, now - ago - 600, turns, model));
    for (let i = 0; i < subs; i++) {
      fs.mkdirSync(path.join(dir, sid, "subagents"), { recursive: true });
      fs.writeFileSync(path.join(dir, sid, "subagents", `agent-a${i}.jsonl`), claudeLines(cwd, now - ago - 500, [["look around", "done"]]));
    }
    fs.utimesSync(f, now - ago, now - ago);
    written.push(f, path.join(dir, sid));
    return f;
  };
  const codexDir = path.join(rec.root, "codex-home", "sessions", "2026", "10", "01");
  fs.mkdirSync(codexDir, { recursive: true });
  const codex = (sid, cwd, ago, turns, model, parent) => {
    const f = path.join(codexDir, `rollout-2026-10-01T00-00-00-${sid}.jsonl`);
    fs.writeFileSync(f, codexLines(sid, cwd, now - ago - 600, turns, model, parent));
    fs.utimesSync(f, now - ago, now - ago);
    return f;
  };
  const ids = {
    release: "e2e00001-0000-4000-8000-000000000001",
    cart: "e2e00002-0000-4000-8000-000000000002",
    invoice: "e2e00003-0000-4000-8000-000000000003",
    oldexp: "e2e00004-0000-4000-8000-000000000004",
    readme: "019e2e00-0000-7000-8000-000000000005",
    checkout: "019e2e00-0000-7000-8000-000000000006",
    helper: "019e2e00-0000-7000-8000-000000000007",
    notes: "019e2e00-0000-7000-8000-000000000008",
  };
  claude(ids.release, demo, 240, [["Make the demo release notes friendlier", "I rewrote the intro so it says what changed for people, not for developers."], ["Shorter please", "Done: three short lines now, one per change."]], 2);
  codex(ids.readme, demo, 3 * 3600, [["整理一下 demo 的 README，开头先说这是什么", "改好了：第一段说这是什么、给谁用，安装步骤挪到后面。"]], "gpt-6-astra");
  claude(ids.cart, shop, 1800, [["Fix the cart total: it shows 9.999 instead of 10.00", "Found it: the total was added up before rounding. I round each line first now, and added a test."]], 0, "claude-sonnet-5-5");
  claude(ids.invoice, shop, 2 * 86400, [["Why is the invoice PDF blank when the order has a discount?", "The template hid every row with a negative amount. Discounts now show as their own row."]], 3);
  codex(ids.checkout, wt, 5 * 3600, [["Try a one-page checkout in this copy, keep the old one working", "The one-page checkout works behind a switch; the old flow is untouched."]], "gpt-6-astra");
  codex(ids.helper, wt, 5 * 3600 + 60, [["check the tests", "all green"]], "gpt-6-mini", ids.checkout);
  codex(ids.notes, notes, 4 * 86400, [["Summarise my reading notes from September into three themes", "Three themes: attention, habits, and writing as thinking. Each with the notes it came from."]], "gpt-6-astra");
  claude(ids.oldexp, gone, 20 * 86400, [["Old experiment with the shop's search", "Search now ranks exact names first."]]);
  return { written, ids, demo, shop, wt, notes, gone };
}

async function theme(ui, which) {
  for (const dir of [ui.rec.user_data_dir, ui.rec.agents_user_data_dir]) {
    const f = path.join(dir, "User", "settings.json");
    let s = {};
    try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch { s = {}; }
    Object.assign(s, { "window.autoDetectColorScheme": false, "workbench.colorTheme": which === "light" ? "Dispatch Light" : "Dispatch Dark" });
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

const rowTitles = (ui) => ui.eval("JSON.stringify([...document.querySelectorAll('.dispatch-history-row .dispatch-history-title')].map(e => e.textContent))").then(JSON.parse);
// the sessions list on the left, as text: a seeded title showing up there would mean looking imported it
const sidebarText = (ui) => ui.eval("[...document.querySelectorAll('.session-item')].map(e => e.innerText).join('\\n')");

/** Waits until the list has a row with this title (in the list, scrolled into view or not). */
async function waitRow(ui, title, timeoutMs = 300000) {
  for (const until = Date.now() + timeoutMs; Date.now() < until; await ui.sleep(500)) {
    if ((await rowTitles(ui)).includes(title)) return;
  }
  throw new Error(`no row "${title}" after ${timeoutMs / 1000} s: ${JSON.stringify(await rowTitles(ui))}`);
}

// The terminal's text, read from the xterm VS Code keeps on the terminal's wrapper element (the screen is a canvas):
// the one asked for first, then every terminal on the page (Dispatch's own terminal view keeps it on
// .dispatch-xterm, dispatchXterm.ts), then the rows' DOM text.
const terminalText = (ui, css = ".dispatch-terminal-view .terminal-wrapper") => ui.eval(`(() => {
  const read = (w) => {
    const b = w && w.xterm && w.xterm.buffer && w.xterm.buffer.active;
    if (!b) return '';
    const lines = [];
    for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) lines.push(l.translateToString(true)); }
    return lines.join('\\n').trim();
  };
  const first = read(document.querySelector(${JSON.stringify(css)}));
  if (first) return first;
  const all = [...document.querySelectorAll('.dispatch-xterm, .terminal-wrapper')].map(read).filter(Boolean).join('\\n');
  if (all) return all;
  return [...document.querySelectorAll('.xterm-rows, .xterm-accessibility-tree')].map(e => e.textContent).join('\\n').trim();
})()`);

/** Waits until the DOM has it (scrolled into view or not). */
async function waitCss(ui, css, timeoutMs = 20000) {
  for (const until = Date.now() + timeoutMs; Date.now() < until; await ui.sleep(300)) {
    if (await ui.eval(`!!document.querySelector(${JSON.stringify(css)})`)) return;
  }
  throw new Error(`nothing matches ${css} after ${timeoutMs / 1000} s`);
}

/** Opens the row with this title (when it is not open yet) and clicks one of its buttons. */
async function rowButton(ui, title, label, inTerminal = true) {
  const isOpen = () => ui.eval(`[...document.querySelectorAll('.dispatch-history-row.open .dispatch-history-title')].some(e => e.textContent === ${JSON.stringify(title)})`);
  if (!(await isOpen())) {
    await ui.scrollTo(title);
    await ui.click({ text: title, within: ".dispatch-history-list" });
    for (let i = 0; i < 20 && !(await isOpen()); i++) await ui.sleep(300);
  }
  // the row, marked so the clicks below stay inside it
  await ui.eval(`(() => { document.querySelectorAll('[data-e2e-row]').forEach(r => delete r.dataset.e2eRow); const r = [...document.querySelectorAll('.dispatch-history-row.open')].find(r => r.querySelector('.dispatch-history-title')?.textContent === ${JSON.stringify(title)}); if (r) r.dataset.e2eRow = '1'; })()`);
  await ui.scrollTo(title);
  // Claude Code and Codex conversations can go on in the chat or a terminal: this walk takes the terminal
  // (history-continue-chat.mjs walks the chat)
  if (inTerminal && await ui.eval("!!document.querySelector('[data-e2e-row] .dispatch-history-continue-in')")) {
    await ui.click({ css: '[data-e2e-row] .dispatch-tasks-pill[data-continue-in="terminal"]', webview: false });
    await ui.sleep(300);
    const picked = await ui.eval("document.querySelector('[data-e2e-row] .dispatch-tasks-pill[aria-checked=\"true\"]')?.dataset.continueIn || ''");
    if (picked !== "terminal") throw new Error(`Continue in: ${picked || "nothing picked"}, not the terminal`);
  }
  await ui.click({ text: label, exact: true, within: '[data-e2e-row] .dispatch-history-buttons' });
}

async function search(ui, text) {
  await ui.click({ css: "input.dispatch-history-search-input" });
  await ui.eval("(() => { const i = document.querySelector('input.dispatch-history-search-input'); i.select(); })()");
  await ui.press("Backspace");
  if (text) await ui.type(text, { into: { css: "input.dispatch-history-search-input" } });
  await ui.sleep(1500);
}

const windows = (ui) => fetch(`http://127.0.0.1:${ui.rec.port}/json/list`).then((r) => r.json()).catch(() => []);

/** The Agents window on the demo project. A build that opens straight into the Agents window has no editor window,
 *  and the window only takes a folder from one (dispatch-bridge's agents-request): open the editor first. */
async function openOnFolder(ui, folder) {
  await ui.attach("agents", 30000).catch(() => ui.openAgents());
  const hasEditor = async () => (await windows(ui)).some((t) => /workbench(\.esm|-dev)?\.html/.test(t.url || ""));
  if (!(await hasEditor())) {
    await ui.click({ aria: "Editor", webview: false });
    for (let i = 0; i < 60 && !(await hasEditor()); i++) await ui.sleep(500);
    await ui.sleep(4000);
  }
  await ui.openAgents(folder);
}

/** A tip that came up closes, so it does not cover what comes next. */
async function closeTips(ui) {
  for (let i = 0; i < 4 && (await ui.exists({ css: ".dispatch-tour", webview: false })); i++) {
    await ui.click({ css: ".dispatch-tour-head button", webview: false }).catch(() => ui.press("Escape"));
    await ui.sleep(500);
  }
}

/** The History tab from the side pane's +, trying again when a tip or a late redraw got in the way. */
async function openHistory(ui) {
  await closeTips(ui);
  for (let i = 0; ; i++) {
    try { await ui.openTab("History"); return; } catch (e) { if (i === 2) throw e; await ui.press("Escape"); await closeTips(ui); await ui.sleep(1500); }
  }
}

export default async function (ui) {
  const seeded = seedHistory(ui);
  const results = {};
  try {
    await openOnFolder(ui, seeded.demo);
    await ui.newSession();
    await ui.sleep(1500);
    const before = await sidebarText(ui);

    // 1. History from the side pane's +: the project's sessions, newest first
    await openHistory(ui);
    // the tab keeps its search and scope: a run before this one on the same instance may have left words and All
    if (await ui.eval("!!document.querySelector('input.dispatch-history-search-input')?.value")) {
      await ui.click({ css: "button.dispatch-history-search-clear, .dispatch-history-search .codicon-close", webview: false }).catch(async () => {
        await ui.click({ css: "input.dispatch-history-search-input" });
        await ui.eval("(() => { const i = document.querySelector('input.dispatch-history-search-input'); i.select(); })()");
        await ui.press("Backspace");
      });
      await ui.sleep(1500);
    }
    await ui.click({ text: path.basename(seeded.demo), exact: true, within: ".dispatch-history-bar" }).catch(() => undefined);
    await ui.sleep(1000);
    await waitRow(ui, "Make the demo release notes friendlier", 360000); // a first look reads the whole history: minutes on a busy Mac
    await ui.sleep(1200);
    results.project = await rowTitles(ui);
    await ui.screenshot("01-project");
    await ui.mark({ aria: "History", exact: true, within: ".tabs-container" }, { what: "History 页签", where: "右栏页签条", how: "右栏 + › History" });
    await ui.mark({ css: ".dispatch-history-bar .dispatch-tasks-scope" }, { what: "范围：This folder / 项目 / All", where: "页签顶上", how: "点名字切换" });
    await ui.mark({ css: ".dispatch-history-search" }, { what: "搜索", where: "范围下面", how: "标题、回复、文件夹、模型、你打过的字都能搜" });
    await ui.mark({ css: ".dispatch-history-row", index: 0 }, { what: "一条会话", where: "按项目分组的列表", how: "标题、最后一条消息、Agent 图标、条数、子 Agent、多久前、模型" });
    await ui.mark({ css: ".dispatch-history-note" }, { what: "默认不导入", where: "计数这一行右边", how: "看不会把会话加进左栏，Continue 才加" });

    // 2. All: every project on this Mac, grouped
    await ui.click({ text: "All", exact: true, within: ".dispatch-history-bar" });
    await waitRow(ui, "Summarise my reading notes from September into three themes");
    results.groups = JSON.parse(await ui.eval("JSON.stringify([...document.querySelectorAll('.dispatch-history-group-name')].map(e => e.textContent))"));
    results.all = await rowTitles(ui);
    await ui.screenshot("02-all");

    // 3. search: a title, a reply, then what was typed only
    await search(ui, "cart");
    results.searchTitle = await rowTitles(ui);
    await search(ui, "rounding");
    results.searchReply = await rowTitles(ui);
    await search(ui, "shorter");
    results.searchTyped = await rowTitles(ui);
    results.snippet = await ui.eval("document.querySelector('.dispatch-history-row .dispatch-history-preview')?.textContent");
    await ui.screenshot("03-search");
    await search(ui, "");
    await waitRow(ui, "Summarise my reading notes from September into three themes");

    // 4. view options: agents, order, empty sessions
    await ui.click({ css: ".dispatch-history-tool", index: 0 });
    await ui.sleep(600);
    await ui.screenshot("04-options");
    // the count is every Codex session in the scope: runs before this one on the same instance add their own
    const codexItem = await ui.eval(`[...document.querySelectorAll('.context-view .action-label, .monaco-menu-container .action-label')].map(e => e.textContent.trim()).find(t => /^Codex \\(\\d+\\)$/.test(t)) || "Codex (3)"`);
    await ui.click({ text: codexItem, exact: true, within: ".context-view, .monaco-menu-container" });
    await ui.sleep(2500);
    results.onlyClaude = await rowTitles(ui);
    await ui.click({ css: ".dispatch-history-tool", index: 0 });
    await ui.sleep(600);
    await ui.click({ text: "Show All Agents", exact: true, within: ".context-view, .monaco-menu-container" });
    await ui.sleep(2500);

    // 5. a row opened: the first message, the folder, Continue / Open in New Window
    await ui.scrollTo("Fix the cart total: it shows 9.999 instead of 10.00");
    await ui.click({ text: "Fix the cart total: it shows 9.999 instead of 10.00", within: ".dispatch-history-list" });
    await waitCss(ui, ".dispatch-history-row.open .dispatch-history-button");
    await ui.sleep(500);
    await ui.screenshot("05-opened");
    await ui.mark({ text: "Continue", exact: true, within: ".dispatch-history-row.open" }, { what: "Continue", where: "点开的会话里", how: "在聊天或终端里接着聊（旁边 Chat | Terminal 选），会话进左栏" });
    await ui.mark({ text: "Open in New Window", exact: true, within: ".dispatch-history-row.open" }, { what: "Open in New Window", where: "Continue 右边", how: "开一个新窗口，在那里接着聊" });

    // 6. a session whose folder is gone: it says why it cannot go on
    await ui.scrollTo("Old experiment with the shop's search");
    await ui.click({ text: "Old experiment with the shop's search", within: ".dispatch-history-list" });
    await waitCss(ui, ".dispatch-history-row.open .dispatch-history-why");
    results.goneWhy = await ui.eval("document.querySelector('.dispatch-history-row.open .dispatch-history-why')?.textContent");
    results.goneDisabled = await ui.eval("[...document.querySelectorAll('.dispatch-history-row.open')].filter(r => r.querySelector('.dispatch-history-why')).every(r => [...r.querySelectorAll('.dispatch-history-button')].every(b => b.disabled))");
    await ui.scrollTo("The folder this session worked in is gone, so it can't be continued here.");
    await ui.screenshot("06-gone");

    // looking added nothing to the list on the left
    // (the window itself may list recent sessions it found on disk: the range picked at setup; that is not History's doing)
    results.sidebarBefore = before;
    results.sidebarAfterLooking = await sidebarText(ui);
    results.taggedInSessions = JSON.parse(await ui.eval("JSON.stringify([...document.querySelectorAll('.dispatch-history-row')].filter(r => r.querySelector('.dispatch-history-in')).map(r => r.querySelector('.dispatch-history-title').textContent))"));

    // 7. dark and light
    await theme(ui, "dark");
    await ui.screenshot("07-dark");
    await theme(ui, "light");
    await ui.screenshot("08-light");

    // 8. next to the Tasks tab: one family
    await ui.openTab("Tasks");
    await ui.sleep(1500);
    await ui.screenshot("09-tasks-next-door");
    await openHistory(ui);
    await ui.sleep(1000);

    // 9. Open in New Window: an editor window on the session's folder, the conversation picked up in a terminal there
    await rowButton(ui, "Why is the invoice PDF blank when the order has a discount?", "Open in New Window");
    let shopWindow;
    for (let i = 0; i < 80 * SCALE && !shopWindow; i++) {
      await ui.sleep(500);
      const list = await fetch(`http://127.0.0.1:${ui.rec.port}/json/list`).then((r) => r.json()).catch(() => []);
      shopWindow = list.find((t) => t.type === "page" && /\bshop\b/.test(t.title || "") && /workbench(\.esm|-dev)?\.html/.test(t.url || ""));
    }
    if (!shopWindow) throw new Error("Open in New Window did not open a window on the shop folder");
    results.newWindowTitle = shopWindow.title;
    await ui.attach("editor", 30000, shopWindow.title);
    await ui.waitFor({ css: ".xterm" }, { timeoutMs: 40000 });
    await ui.sleep(6000);
    results.newWindowTerminal = (await terminalText(ui, ".terminal-wrapper")).slice(0, 2000);
    await ui.screenshot("10-new-window");
    await ui.attach("agents");
    await ui.sleep(800);

    // 10. Continue: a terminal session in the session's folder, picking the conversation up
    // a Codex conversation: a recent Claude Code one is already in the window's list (VS Code picks up sessions
    // other apps made), and Continue just opens that one in the chat
    await search(ui, "");
    await rowButton(ui, "整理一下 demo 的 README，开头先说这是什么", "Continue");
    await ui.waitFor({ css: ".xterm" }, { timeoutMs: 30000 });
    await ui.sleep(3000);
    // Codex may first install its app-server daemon into the instance's CODEX_HOME: that line comes before the resume
    for (let i = 0; i < 90 && !(await terminalText(ui)).replace(/\s+/g, "").includes(seeded.ids.readme); i++) await ui.sleep(1000);
    results.terminalText = (await terminalText(ui)).slice(0, 2000);
    results.terminalSession = await ui.eval("[...document.querySelectorAll('.monaco-list-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim()).filter(t => /terminal/i.test(t))");
    results.sidebarAfterContinue = await sidebarText(ui);
    await ui.screenshot("11-continued");
    if (!results.terminalText.replace(/\s+/g, "").includes(seeded.ids.readme)) throw new Error(`the terminal did not get the resume line: ${results.terminalText.slice(0, 300)}`);
  } finally {
    for (const p of seeded.written) fs.rmSync(p, { recursive: true, force: true });
    for (const dir of new Set(seeded.written.map((p) => path.dirname(p)))) {
      try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* gone or not empty */ }
    }
  }
  const expect = (cond, what) => { if (!cond) throw new Error(`${what}: ${JSON.stringify(results)}`); };
  expect(results.project.includes("Make the demo release notes friendlier") && !results.project.includes("Fix the cart total: it shows 9.999 instead of 10.00"), "project scope lists the demo project only");
  expect(results.all.filter((t) => !/^Reply with exactly: (SEEDED|CONTINUED) /.test(t)).length === 7, "All lists the seven conversations (the helper thread is not one; seeds of other runs on this instance aside)");
  expect(results.searchTitle.length === 1, "search finds the cart session by its title");
  expect(results.searchReply.length === 1 && results.searchReply[0].startsWith("Fix the cart total"), "search finds a word of a reply");
  expect(results.searchTyped.length === 1 && /Shorter please/.test(results.snippet || ""), "search finds what was typed, and shows the line");
  expect(!results.onlyClaude.some((t) => /整理|one-page|reading notes/.test(t)), "unticking Codex hides its sessions");
  expect(results.goneDisabled && /gone/.test(results.goneWhy || ""), "a session whose folder is gone says why it cannot go on");
  expect(results.sidebarBefore === results.sidebarAfterLooking, "looking adds nothing to the left");
  expect(results.taggedInSessions.filter((t) => !/^Reply with exactly: (SEEDED|CONTINUED) /.test(t)).every((t) => results.sidebarBefore.includes(t.slice(0, 30))), "only sessions the left list has are marked In your sessions (a recent Claude Code one VS Code picked up is not)");
  expect((results.newWindowTerminal || "").replace(/\s+/g, "").includes(seeded.ids.invoice), "the new window continues the invoice session in its terminal");
  fs.writeFileSync(path.join(ui.out, "results.json"), JSON.stringify(results, null, 2));
  return results;
}
