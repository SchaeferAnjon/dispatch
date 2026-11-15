// Learning while the agent works (direction B「Talk while new」, user 2026-11-15, task-q9x2r, kanban design/learn-scene).
// Walked as a person does it. An OpenCode session on a cheap model (never Claude) creates two files and runs an install:
// under Talk a small card comes in the side pane's corner for each kind, says the file's own first comment or the
// command, never takes the keyboard, fades after 7 seconds, and stays while the pointer is on it. Settings › Learning
// switches to Quiet; a second turn that does the same gets no card. Then a Codex session (side chats need an engine
// that branches chats; OpenCode does not, Claude Code is never opened in tests) on its small model, one message: Talk
// is switched back in Settings, the agent creates a file, the card comes, a click opens the side chat card on that
// file; the card's ⋯ switches Quiet and Talk; Ask Question on a line of the file in the editor, a line of its diff in
// Changes and the terminal's output each open the same card, its quote naming where (file · line, Changes, Terminal);
// a reply's selection brings the same box. Light (OpenCode) and dark (Codex), facts in qa.json.
export const meta = { needs: ['opencode', 'codex'], instance: { motion: true },
  title: "边干边学：Talk 小卡、Quiet / Talk 开关、各处选中 Ask Question",
  description: "OpenCode 会话建两个文件、跑一条装包命令：Talk 下右栏右下角冒小卡（文件开头注释、命令），不抢焦点，7 秒淡出，鼠标停住不淡；Settings › Learning 切 Quiet 再跑一轮不冒卡。Codex 会话建一个文件：小卡点开旁聊卡，引用卡是那个文件；旁聊卡 ⋯ 切 Quiet / Talk；编辑器里一行、Changes 的 diff 一行、终端输出一段各点 Ask Question 开同一张卡，引用卡写文件 · 行、Changes、Terminal；回复里选字出同一个框。浅色深色各截图。",
  timeout: 2400,
};

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { until, offscreen, onDemo, toDemo, focusInput, chooseCheapModel, closeTips } from "./session-now.mjs";

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
const CARD = ".dispatch-talk-card";
const SIDE = ".dispatch-side-chat-card";
const RUNNING = `!!document.querySelector('.session-view .interactive-input-part .chat-execute-toolbar .codicon-stop-circle')`;
const LAST = `(() => { const r = [...document.querySelectorAll('.session-view .interactive-response')].at(-1); return r ? r.innerText.trim() : ''; })()`;

const TURN1 = "In the current folder, use your write tool to create two new files. First `learn/reminder.ts` with exactly these two lines: `// Schedules the daily reading reminder.` and `export const at = '21:00';`. Then `learn/ReminderToggle.ts` with exactly these two lines: `// The switch in Settings that turns the reminder on or off.` and `export const on = true;`. After both files exist, run the shell command `rm learn/old-notes.txt`, and after that the shell command `npm install --dry-run --no-audit --no-fund left-pad`. Do nothing else, then reply with the single word DONE.";
const TURN2 = "Use your write tool to create one more new file, `learn/quiet.ts`, with exactly these two lines: `// Checks that Quiet stays quiet.` and `export const quiet = true;`. Then run this one shell command: `npm install --dry-run --no-audit --no-fund is-odd`. Do nothing else, then reply with the single word DONE.";
const CODEX = "Create the new file `learn/notes.ts` with exactly these two lines: `// Keeps the reading notes.` and `export const notes: string[] = [];`. Do nothing else and do not run tests. Then reply with the single word DONE.";

/** Every talk card the page shows, kept in the page: when it came, what it said, when it started to go, and where the
 *  keyboard was (a card must never take it). */
const WATCH = `(() => {
  if (window.__talk) return true;
  const log = window.__talk = [];
  const ids = new Map(); let n = 0; let lastActive = document.activeElement;
  const snap = el => ({ kind: el.dataset.kind, name: (el.querySelector('.dtc-name') || {}).textContent || '', tag: (el.querySelector('.dtc-tag') || {}).textContent || '', text: (el.querySelector('.dtc-l2') || {}).textContent || '' });
  setInterval(() => {
    const now = Date.now();
    const running = ${RUNNING};
    for (const el of document.querySelectorAll('${CARD}')) {
      let r = ids.get(el);
      const s = snap(el), k = JSON.stringify(s);
      if (!r) { r = { id: ++n, k: '', leaving: false }; ids.set(el, r); const b = el.getBoundingClientRect(); log.push({ t: now, id: r.id, ev: 'add', ...s, running, kept: document.activeElement === lastActive, focusIn: !!(document.activeElement && document.activeElement.closest('${CARD}')), w: Math.round(b.width), radius: getComputedStyle(el).borderTopLeftRadius }); }
      if (k !== r.k) { r.k = k; log.push({ t: now, id: r.id, ev: 'say', ...s }); }
      if (!r.leaving && el.classList.contains('leaving')) { r.leaving = true; log.push({ t: now, id: r.id, ev: 'leave' }); }
      if (document.activeElement && document.activeElement.closest('${CARD}')) log.push({ t: now, id: r.id, ev: 'focus-taken' });
    }
    for (const [el, r] of ids) if (!el.isConnected && !r.gone) { r.gone = true; log.push({ t: now, id: r.id, ev: 'gone' }); }
    lastActive = document.activeElement;
  }, 100);
  return true;
})()`;
const LOG = `JSON.stringify(window.__talk || [])`;

/** Where the cards and the side chat card are, and what they say. */
const STATE = `(() => {
  const box = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) }; };
  const part = [...document.querySelectorAll('.part.editor')].find(e => e.getBoundingClientRect().width > 0);
  const cards = [...document.querySelectorAll('${CARD}:not(.leaving)')].map(c => ({ kind: c.dataset.kind, name: (c.querySelector('.dtc-name') || {}).textContent, tag: (c.querySelector('.dtc-tag') || {}).textContent, text: (c.querySelector('.dtc-l2') || {}).textContent, box: box(c), radius: getComputedStyle(c).borderTopLeftRadius, bg: getComputedStyle(c).backgroundColor, font: getComputedStyle(c.querySelector('.dtc-name')).fontSize + '/' + getComputedStyle(c.querySelector('.dtc-name')).fontWeight, tabbable: c.tabIndex }));
  const sides = [...document.querySelectorAll('${SIDE}')].filter(c => !c.classList.contains('hidden'));
  const side = sides[0];
  const q = side && side.querySelector('.dsc-quote');
  return { part: box(part), cards, sideCount: sides.length, side: side ? { box: box(side), q1: q ? q.querySelector('.dsc-quote-1').textContent : null, q2: q ? q.querySelector('.dsc-quote-2').textContent : null, icon: q ? (q.querySelector('.dsc-quote-ic') || {}).className : '', radius: getComputedStyle(side).borderTopLeftRadius, bg: getComputedStyle(side).backgroundColor } : null };
})()`;

const MENU = `(() => { const out = []; const all = (root) => { root.querySelectorAll('.monaco-menu .action-menu-item, .context-view .action-menu-item').forEach(e => out.push(e)); root.querySelectorAll('*').forEach(e => e.shadowRoot && all(e.shadowRoot)); }; all(document); return out.filter(e => e.getClientRects().length).map(e => { const l = e.querySelector('.action-label'); return { text: (l ? l.textContent : e.textContent).trim(), checked: e.classList.contains('checked') || (e.querySelector('[aria-checked]') || e).getAttribute('aria-checked') === 'true', disabled: e.classList.contains('disabled') }; }); })()`;

export default async function (ui) {
  const qa = { checks: [], failed: [], states: {}, codexMessages: 0 };
  const note = () => fs.writeFileSync(path.join(ui.out, "qa.json"), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail).slice(0, 600)}`);
    console.error(`${ok ? "ok" : "FAILED"}: ${name}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400)}`);
    note();
  };
  const read = () => ui.eval(STATE);
  const talkLog = async () => JSON.parse(await ui.eval(LOG));
  // the user's settings (the Agents window writes an application setting to the shared user data)
  const settingsFiles = [ui.rec.user_data_dir, ui.rec.agents_user_data_dir].filter(Boolean).map(d => path.join(d, "User", "settings.json"));
  const learnSetting = () => {
    for (const f of settingsFiles) {
      try {
        const v = JSON.parse(fs.readFileSync(f, "utf8"))["dispatch.learning.whileWorking"];
        if (v !== undefined) return v;
      } catch { /* not there */ }
    }
    return undefined;
  };
  /** The demo project and its worktrees: where an agent's files are. */
  const findFile = (rel) => {
    const roots = [ui.demoFolder];
    try {
      const out = execFileSync("git", ["-C", ui.demoFolder, "worktree", "list", "--porcelain"], { encoding: "utf8" });
      roots.push(...out.split("\n").filter(l => l.startsWith("worktree ")).map(l => l.slice(9)));
    } catch { /* not a git folder */ }
    return roots.map(r => path.join(r, rel)).find(p => fs.existsSync(p)) || "";
  };
  /** Allow what the agent asks to run (a test instance asks for risky calls), until `fn` says yes. */
  const approveUntil = (fn, what, ms) => until(ui, async () => {
    const ask = await ui.eval(`[...document.querySelectorAll('.interactive-session button, .chat-confirmation-widget button')].filter(b => b.offsetParent).map(b => b.innerText.trim()).find(t => /^(Allow|Allow once|Approve|Continue|Yes|Run)$/i.test(t)) || ''`);
    if (ask) await ui.click({ text: ask, exact: true });
    return fn();
  }, ms, what, 400);
  const turnEnds = async (ms = 300000) => {
    await approveUntil(async () => !(await ui.eval(RUNNING)) && (await ui.eval(LAST)).length > 0, "the turn to end", ms);
    const last = await ui.eval(LAST);
    if (/401|unauthori[sz]ed|quota|insufficient/i.test(last)) ui.skip(`the test model could not answer: ${last.slice(0, 200)}`);
    return last;
  };
  /** Escape closes Settings; one that only closed a hover first is pressed again, as a person does. */
  const closeSettings = async () => {
    const open = () => ui.eval(`!!document.querySelector('.part.sidebar.dispatch-settings-open .dispatch-settings-nav') && [...document.querySelectorAll('[data-part="learn-mode"]')].some(e => e.getClientRects().length)`);
    for (let i = 0; i < 4 && (await open()); i++) {
      await ui.press("Escape");
      await ui.sleep(1200);
    }
    if (await open()) throw new Error("Settings did not close on Escape");
  };
  const rest = async () => { await ui.mouse("mouseMoved", 700, 120); await ui.sleep(300); };

  // ---- the instance: no screen reader pill, and the terminal draws its rows as text (its words can be found) ----
  for (const dir of [ui.rec.user_data_dir, ui.rec.agents_user_data_dir].filter(Boolean)) {
    const f = path.join(dir, "User", "settings.json");
    let j = {};
    try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch { j = {}; }
    j["editor.accessibilitySupport"] = "off";
    j["terminal.integrated.gpuAcceleration"] = "off";
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(j, null, 1));
  }
  await offscreen(ui);
  await onDemo(ui);
  await closeTips(ui);
  await ui.setTheme("light");
  check("Talk is the default: the setting is not written yet", learnSetting() === undefined, learnSetting());
  // a file the agent is asked to delete
  fs.mkdirSync(path.join(ui.demoFolder, "learn"), { recursive: true });
  fs.writeFileSync(path.join(ui.demoFolder, "learn", "old-notes.txt"), "old notes\n");
  await ui.eval(WATCH);

  // ======== 1. OpenCode, Talk: two new files and an install ========
  await ui.newSession();
  await toDemo(ui);
  await ui.pickEngine("OpenCode", 180000);
  await ui.sleep(1500);
  qa.states.opencodeModel = await chooseCheapModel(ui, ".sessions-chat-editor");
  await focusInput(ui, ".sessions-chat-editor");
  await ui.type(TURN1);
  await ui.press("Enter", { send: true });
  await until(ui, () => ui.eval(RUNNING), 90000, "the first turn to start", 500).catch(() => {});
  await ui.eval(WATCH);

  // the install card: the pointer goes onto it at once and stays 10 s
  const installAdd = await approveUntil(async () => (await talkLog()).find(e => e.ev === "add" && e.kind === "install"), "the install card", 300000);
  await ui.hover({ css: `${CARD}[data-kind="install"]:not(.leaving)` });
  const hoverFrom = Date.now();
  await ui.sleep(400);
  const both = qa.states.talkLight = await read();
  await ui.screenshot("01-talk-cards-light");
  await ui.mark({ css: `${CARD}[data-kind="install"]` }, { what: "Talk 小卡：Agent 装了包，一句话说是什么（这里是命令本身）", where: "右栏右下角", how: "7 秒自己淡出；鼠标停在上面不走；点它在旁聊里接着问，× 关掉" });
  if (await ui.exists({ css: `${CARD}[data-kind="create"]:not(.leaving)` })) {
    await ui.mark({ css: `${CARD}[data-kind="create"]` }, { what: "新建文件的小卡：名字、New file、文件开头那句注释", where: "右栏右下角，新的在下", how: "同一轮的同类合成一张" });
  }
  await ui.sleep(Math.max(0, 10000 - (Date.now() - hoverFrom)));
  const held = await ui.eval(`!!document.querySelector('${CARD}[data-kind="install"]:not(.leaving)')`);
  check("the pointer on the install card: still there after 10 s (7 s is when it would go)", held, { since: Date.now() - installAdd.t });
  await rest();
  const leftAt = Date.now();
  const installGone = await until(ui, async () => (await talkLog()).find(e => e.ev === "leave" && e.id === installAdd.id), 15000, "the install card to fade after the pointer left", 200).catch(() => null);
  qa.states.installAfterLeave = installGone ? installGone.t - leftAt : null;
  check("the pointer off it: it fades in the time it had left (about 7 s less the moment before the pointer came)", !!installGone && installGone.t - leftAt > 5000 && installGone.t - leftAt < 8500, qa.states.installAfterLeave);

  const answer1 = await turnEnds();
  await ui.sleep(9000); // every card has gone by itself
  const log1 = qa.states.log1 = await talkLog();
  const r1 = findFile("learn/reminder.ts"), r2 = findFile("learn/ReminderToggle.ts");
  qa.states.turn1 = { answer: answer1.slice(0, 200), reminder: !!r1, toggle: !!r2 };
  check("the agent made both files", !!r1 && !!r2, qa.states.turn1);
  const creates = log1.filter(e => e.ev === "say" && e.kind === "create");
  const lastCreate = creates.at(-1);
  check("one card for the new files of the turn, never two at once", new Set(log1.filter(e => e.ev === "add" && e.kind === "create").map(e => e.id)).size >= 1
    && !log1.some((e, i) => e.ev === "add" && e.kind === "create" && log1.slice(0, i).some(x => x.ev === "add" && x.kind === "create" && !log1.slice(0, i).some(y => y.ev === "leave" && y.id === x.id))), creates);
  // the first file alone says itself, when the card came before the second file was there
  const sayFirst = creates.find(e => e.name === "reminder.ts");
  qa.states.firstFileAlone = !!sayFirst;
  if (sayFirst) {
    check("one new file: its name, New file, and its own first comment", sayFirst.tag === "New file" && sayFirst.text === "Schedules the daily reading reminder.", sayFirst);
  }
  check("both files in the turn: one card, \"2 new files · Created\", their names", !!lastCreate && lastCreate.name === "2 new files" && lastCreate.tag === "Created" && /reminder\.ts/.test(lastCreate.text) && /ReminderToggle\.ts/.test(lastCreate.text), lastCreate);
  const inst = log1.filter(e => e.ev === "say" && e.kind === "install").at(-1);
  check("the install card: left-pad, Installed, and what was run without its flags", !!inst && inst.name === "left-pad" && inst.tag === "Installed" && inst.text === "Ran npm install left-pad.", inst);
  const del = log1.filter(e => e.ev === "say" && e.kind === "delete").at(-1);
  check("the delete card: old-notes.txt, Deleted, the file it was", !!del && del.name === "old-notes.txt" && del.tag === "Deleted" && /learn\/old-notes\.txt/.test(del.text) && !fs.existsSync(path.join(ui.demoFolder, "learn", "old-notes.txt")), del);
  const adds = log1.filter(e => e.ev === "add");
  check("each card came while the agent was still working", adds.length >= 2 && adds.every(e => e.running), adds.map(e => [e.kind, e.running]));
  check("no card took the keyboard (the focus stayed where it was as each came, and never went into a card)", adds.every(e => e.kept && !e.focusIn) && !log1.some(e => e.ev === "focus-taken"), adds.map(e => [e.kind, e.kept, e.focusIn]));
  // the create card was not touched: from its last words to when it started to go
  const createId = lastCreate && lastCreate.id;
  const lastSay = log1.filter(e => e.id === createId && (e.ev === "say" || e.ev === "add")).at(-1);
  const createLeave = log1.find(e => e.id === createId && e.ev === "leave");
  qa.states.createShownMs = lastSay && createLeave ? createLeave.t - lastSay.t : null;
  check("left alone, a card goes 7 s after its last words", qa.states.createShownMs !== null && qa.states.createShownMs >= 6600 && qa.states.createShownMs <= 7800, qa.states.createShownMs);
  const wantW = both.part ? Math.min(340, both.part.w - 32) : 340;
  check("the cards are the side chat card's family: corner 12, 340 wide (the pane less 16 each side when narrower), line one 13px/500, not tabbable", !!both.cards.length && both.cards.every(c => c.radius === "12px" && Math.abs(c.box.w - wantW) <= 1 && c.font === "13px/500" && c.tabbable === -1), { wantW, cards: both.cards });
  check("16 from the side pane's right and bottom edges, newest at the bottom", !!both.part && both.cards.length >= 1 && Math.abs(both.part.r - both.cards.at(-1).box.r - 16) <= 1.5 && Math.abs(both.part.b - both.cards.at(-1).box.b - 16) <= 1.5, { part: both.part, cards: both.cards.map(c => c.box) });

  // ======== 2. Settings › Learning: Quiet; a second turn that does the same says nothing ========
  await ui.press("Cmd+,");
  await ui.waitFor({ css: ".part.sidebar.dispatch-settings-open .dispatch-settings-nav", webview: false }, { timeoutMs: 15000 });
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="learning"]', webview: false });
  await ui.waitFor({ css: '[data-part="learn-mode"]' }, { timeoutMs: 15000 });
  await ui.click({ text: "Quiet", exact: true, within: '[data-part="learn-mode"]' });
  await until(ui, async () => learnSetting() === "quiet", 10000, "the setting to say quiet", 300);
  qa.states.settingsQuiet = await ui.eval(`(() => { const s = document.querySelector('[data-setting="learn-mode"]'); return s ? s.innerText.replace(/\\s+/g, ' ').trim() : ''; })()`);
  check("Settings › Learning: Quiet is picked and written", learnSetting() === "quiet" && /Nothing shows up by itself/.test(qa.states.settingsQuiet), qa.states.settingsQuiet);
  await ui.screenshot("02-settings-learning-light");
  await ui.mark({ css: '[data-part="learn-mode"]' }, { what: "Quiet / Talk 开关（Settings › Learning）", where: "设置左栏 Learning 页", how: "点 Quiet 或 Talk，马上生效" });
  await closeSettings();

  const before2 = (await talkLog()).length;
  await focusInput(ui, ".session-view .interactive-input-part");
  await ui.type(TURN2);
  await ui.press("Enter", { send: true });
  await until(ui, () => ui.eval(RUNNING), 90000, "the second turn to start", 500).catch(() => {});
  const answer2 = await turnEnds();
  await ui.sleep(3000);
  const quietFile = findFile("learn/quiet.ts");
  const log2 = (await talkLog()).slice(before2);
  qa.states.quiet = { answer: answer2.slice(0, 200), file: !!quietFile, cards: log2 };
  check("Quiet: the agent made the file and ran the install, and no card came", !!quietFile && log2.filter(e => e.ev === "add").length === 0, qa.states.quiet);
  await ui.screenshot("03-quiet-no-card-light");

  // ======== 3. Codex, dark: Talk again in Settings, a new file, its card opens the side chat card ========
  await ui.setTheme("dark");
  await ui.press("Cmd+,");
  await ui.waitFor({ css: ".part.sidebar.dispatch-settings-open .dispatch-settings-nav", webview: false }, { timeoutMs: 15000 });
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="learning"]', webview: false });
  await ui.waitFor({ css: '[data-part="learn-mode"]' }, { timeoutMs: 15000 });
  await ui.click({ text: "Talk", exact: true, within: '[data-part="learn-mode"]' });
  await until(ui, async () => learnSetting() === "talk", 10000, "the setting to say talk", 300);
  await ui.screenshot("04-settings-learning-dark");
  await ui.mark({ css: '[data-part="learn-mode"]' }, { what: "切回 Talk", where: "Settings › Learning", how: "点 Talk" });
  await closeSettings();

  await onDemo(ui);
  await ui.newSession();
  await toDemo(ui);
  await ui.pickEngine("Codex", 180000);
  await ui.sleep(1500);
  qa.states.codexModel = await ui.pickModel(/Luna/i, "Codex's small Luna model");
  await focusInput(ui, ".sessions-chat-editor");
  await ui.type(CODEX);
  await ui.press("Enter", { send: true });
  qa.codexMessages++;
  await until(ui, () => ui.eval(RUNNING), 90000, "the Codex turn to start", 500).catch(() => {});
  await ui.eval(WATCH);
  const codexAdd = await approveUntil(async () => (await talkLog()).find(e => e.ev === "add" && e.kind === "create" && e.t > Date.now() - 600000 && /notes\.ts/.test(e.name)), "the Codex file's card", 300000).catch(() => null);
  check("Codex made a file: its card comes", !!codexAdd, codexAdd);
  if (!codexAdd) {
    const last = await ui.eval(LAST);
    if (/401|unauthori[sz]ed|quota|insufficient/i.test(last)) ui.skip(`Codex could not answer on this Mac: ${last.slice(0, 200)}`);
    throw new Error("no card for the Codex file: " + JSON.stringify(await talkLog()).slice(-1500));
  }
  // its colours before the pointer is on it (the pointer darkens it a little), then the pointer keeps it
  const codexCard = qa.states.codexCard = await read();
  check("the Codex card: notes.ts, New file, its own first comment", codexCard.cards.some(c => c.name === "notes.ts" && c.tag === "New file" && c.text === "Keeps the reading notes."), codexCard.cards);
  await ui.screenshot("05a-talk-card-dark-at-rest");
  await ui.mark({ css: `${CARD}[data-kind="create"]` }, { what: "Talk 小卡（深色，指针不在上面）", where: "右栏右下角", how: "7 秒后自己淡出" });
  await ui.hover({ css: `${CARD}[data-kind="create"]:not(.leaving)` });
  await ui.sleep(400);
  await ui.screenshot("05-talk-card-dark");
  await ui.mark({ css: `${CARD}[data-kind="create"]` }, { what: "Talk 小卡（深色）：新文件 notes.ts 和它开头那句注释", where: "右栏右下角", how: "点它在旁聊卡里问" });
  qa.states.clickedWhileRunning = await ui.eval(RUNNING);
  await ui.click({ css: `${CARD}[data-kind="create"]:not(.leaving)` });
  await ui.waitFor({ css: `${SIDE}:not(.hidden) .dsc-quote` }, { timeoutMs: 30000 });
  await ui.sleep(800);
  const fromCard = qa.states.fromCard = await read();
  check("a click on the card: the side chat card, its quote the file (learn/notes.ts · notes.ts · New file)", fromCard.sideCount === 1 && fromCard.side.q1 === "learn/notes.ts" && fromCard.side.q2 === "notes.ts · New file", fromCard.side);
  check("the small card went when the side chat card came", fromCard.cards.length === 0, fromCard.cards);
  check("the small card and the side chat card are one family: the same corner and background", !!codexCard.cards[0] && codexCard.cards[0].radius === fromCard.side.radius && codexCard.cards[0].bg === fromCard.side.bg, { card: codexCard.cards[0], side: fromCard.side });
  await rest();
  await ui.screenshot("06-side-chat-from-card-dark");
  await ui.mark({ css: `${SIDE} .dsc-quote` }, { what: "点小卡开的旁聊卡：引用卡是那个文件", where: "右栏右下角，卡顶", how: "点引用卡打开这个文件" });
  await turnEnds();

  // ---- the side chat card's ⋯: Quiet and Talk, the same setting ----
  await ui.click({ css: `${SIDE} [data-part="side-chat-more"]` });
  await ui.sleep(600);
  const menu1 = qa.states.menu1 = await ui.eval(MENU);
  check("the card's ⋯ has While the Agent Works: Quiet and Talk, Talk checked, and Learning Settings…", menu1.some(m => m.text === "While the Agent Works") && menu1.some(m => m.text === "Talk: Small Cards" && m.checked) && menu1.some(m => m.text === "Quiet: Only When You Ask" && !m.checked) && menu1.some(m => m.text === "Learning Settings…"), menu1);
  await ui.screenshot("07-card-menu-dark");
  await ui.mark({ text: "Quiet: Only When You Ask", exact: true }, { what: "旁聊卡 ⋯ 里的 Quiet / Talk（和 Settings 是同一个设置）", where: "旁聊卡头右边的 ⋯", how: "点一个就切" });
  await ui.click({ text: "Quiet: Only When You Ask", exact: true });
  await until(ui, async () => learnSetting() === "quiet", 10000, "quiet from the card's menu", 300);
  await ui.click({ css: `${SIDE} [data-part="side-chat-more"]` });
  await ui.sleep(600);
  const menu2 = qa.states.menu2 = await ui.eval(MENU);
  check("switched from the card's ⋯: Quiet is checked and written", learnSetting() === "quiet" && menu2.some(m => m.text === "Quiet: Only When You Ask" && m.checked), menu2);
  await ui.click({ text: "Talk: Small Cards", exact: true });
  await until(ui, async () => learnSetting() === "talk", 10000, "talk from the card's menu", 300);
  check("and back to Talk from the same menu", learnSetting() === "talk");

  // ---- Ask Question on a line of the new file in the editor ----
  await ui.click({ css: `${SIDE} .dsc-quote` });
  const EDITOR_LINE = `[...document.querySelectorAll('.part.editor .monaco-editor .view-line')].filter(l => !l.closest('.monaco-diff-editor') && l.getClientRects().length).find(l => l.textContent.replace(/\\u00a0/g, ' ').includes('export const notes'))`;
  await until(ui, () => ui.eval(`!!${EDITOR_LINE}`), 30000, "the file in the editor", 300);
  await ui.sleep(800);
  const dragLine = async (lineExpr) => {
    const b = await ui.eval(`(() => { const l = ${lineExpr}; if (!l) return null; const spans = l.querySelectorAll('span > span'); const a = spans[0].getBoundingClientRect(), z = spans[spans.length - 1].getBoundingClientRect(); return { x1: a.left + 1, x2: z.right - 1, y: a.top + a.height / 2 }; })()`);
    if (!b) throw new Error("no line to select: " + lineExpr);
    await ui.mouse("mouseMoved", b.x1, b.y);
    await ui.mouse("mousePressed", b.x1, b.y, { clickCount: 1 });
    for (let i = 1; i <= 6; i++) await ui.mouse("mouseMoved", b.x1 + (b.x2 - b.x1) * i / 6, b.y, { buttons: 1 });
    await ui.mouse("mouseReleased", b.x2, b.y, { clickCount: 1 });
    await ui.sleep(700);
  };
  await dragLine(EDITOR_LINE);
  await ui.waitFor({ css: '.part.editor .agent-feedback-input-widget [data-action="ask"]' }, { timeoutMs: 15000 });
  await ui.screenshot("08-editor-ask-dark");
  await ui.mark({ css: '.part.editor .agent-feedback-input-widget [data-action="ask"]' }, { what: "编辑器里选中 Agent 新建文件的一行：Ask Question", where: "选区下面浮出的框", how: "点 Ask Question" });
  await ui.click({ css: '.part.editor .agent-feedback-input-widget [data-action="ask"]' });
  await until(ui, async () => { const s = await read(); return s.side && /line 2/.test(s.side.q2 || "") ? s : null; }, 30000, "the side chat card on the editor's line", 400);
  const fromEditor = qa.states.fromEditor = await read();
  check("the editor's line: the same card, the quote `notes.ts · line 2`", fromEditor.sideCount === 1 && fromEditor.side.q2 === "notes.ts · line 2" && /export const notes/.test(fromEditor.side.q1), fromEditor.side);
  // the side pane widens for a file and gets shorter under the terminal: the card keeps its corner of the pane
  const corner = s => !!s.side && !!s.part && Math.abs(s.part.r - s.side.box.r - 16) <= 1.5 && Math.abs(s.part.b - s.side.box.b - 16) <= 1.5;
  check("the same card in the same corner as the one the small card opened (16 from the pane's right and bottom)", corner(fromCard) && corner(fromEditor), [fromCard.part, fromCard.side.box, fromEditor.part, fromEditor.side.box]);

  // ---- Ask Question on a line of its diff in Changes ----
  await ui.openTab("Changes");
  await ui.waitFor({ text: "notes.ts", exact: true, within: ".changes-file-list", webview: false }, { timeoutMs: 60000 });
  await ui.click({ text: "notes.ts", exact: true, within: ".changes-file-list", webview: false });
  const DIFF_LINE = `[...document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line')].filter(l => l.getClientRects().length).find(l => l.textContent.replace(/\\u00a0/g, ' ').includes('export const notes'))`;
  await until(ui, () => ui.eval(`!!${DIFF_LINE}`), 30000, "the diff of notes.ts", 300);
  await ui.sleep(1200);
  await closeTips(ui);
  await dragLine(DIFF_LINE);
  await ui.waitFor({ css: '.monaco-diff-editor .agent-feedback-input-widget [data-action="ask"]' }, { timeoutMs: 15000 });
  await ui.screenshot("09-changes-ask-dark");
  await ui.mark({ css: '.monaco-diff-editor .agent-feedback-input-widget [data-action="ask"]' }, { what: "Changes 的 diff 里选中一行：Ask Question", where: "右栏 Changes，选区下面", how: "点 Ask Question" });
  await ui.click({ css: '.monaco-diff-editor .agent-feedback-input-widget [data-action="ask"]' });
  await until(ui, async () => { const s = await read(); return s.side && /Changes$/.test(s.side.q2 || "") ? s : null; }, 30000, "the side chat card on the diff's line", 400);
  const fromDiff = qa.states.fromDiff = await read();
  check("the diff's line: the same card, the quote `notes.ts · line 2 · Changes`", fromDiff.sideCount === 1 && fromDiff.side.q2 === "notes.ts · line 2 · Changes", fromDiff.side);
  check("still the same corner", corner(fromDiff), [fromDiff.part, fromDiff.side.box]);

  // ---- Ask Question on the terminal's output ----
  await ui.click({ css: '[data-part="terminal-top"]' });
  const XTERM = `[...document.querySelectorAll('.part.panel .xterm')].find(e => e.getClientRects().length && e.getBoundingClientRect().height > 40)`;
  await until(ui, () => ui.eval(`!!${XTERM}`), 30000, "the terminal under the conversation", 400);
  await ui.sleep(2500);
  await ui.eval(`(${XTERM}).querySelector('textarea').focus()`);
  await ui.click({ css: ".part.panel .xterm .xterm-screen" });
  await ui.type("echo LEARN-TERMINAL-$((6*7))");
  await ui.press("Enter");
  const ROW = `[...(${XTERM}).querySelectorAll('.xterm-rows > div')].find(r => /^\\s*LEARN-TERMINAL-42\\s*$/.test(r.textContent))`;
  await until(ui, () => ui.eval(`!!${ROW}`), 20000, "the echo's output in the terminal", 300);
  const OUT = `(() => { const r = ${ROW}; const range = document.createRange(); const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT); const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode); const first = nodes.find(n => n.textContent.trim()); const last = [...nodes].reverse().find(n => n.textContent.trim()); range.setStart(first, first.textContent.indexOf('L')); range.setEnd(last, last.textContent.trimEnd().length); const rects = [...range.getClientRects()].filter(x => x.width); const a = rects[0], z = rects.at(-1); return { x1: a.left + 2, x2: z.right - 2, y: a.top + a.height / 2, left: a.left, bottom: a.bottom }; })()`;
  const TBOX = ".dispatch-terminal-ask .agent-feedback-input-widget";
  /** Drags over the echo's output, as a person selects it; the box comes. */
  const selectOutput = async () => {
    const out = await ui.eval(OUT);
    await ui.mouse("mouseMoved", out.x1, out.y);
    await ui.mouse("mousePressed", out.x1, out.y, { clickCount: 1 });
    for (let i = 1; i <= 8; i++) await ui.mouse("mouseMoved", out.x1 + (out.x2 - out.x1) * i / 8, out.y, { buttons: 1 });
    await ui.mouse("mouseReleased", out.x2, out.y, { clickCount: 1 });
    await ui.waitFor({ css: `${TBOX} textarea` }, { timeoutMs: 15000 });
    await ui.sleep(300);
    return out;
  };
  const out = await selectOutput();
  qa.states.terminalBox = await ui.eval(`(() => { const w = document.querySelector('${TBOX}'); const b = w.getBoundingClientRect(); return { actions: [...w.querySelectorAll('.agent-feedback-input-leading-action')].map(b => b.innerText.trim()), placeholder: w.querySelector('textarea').placeholder, left: Math.round(b.left), top: Math.round(b.top) }; })()`);
  qa.states.terminalSel = out;
  check("the terminal's box is the reply's box: Quote, then a field to ask in", JSON.stringify(qa.states.terminalBox.actions) === JSON.stringify(["Quote"]) && qa.states.terminalBox.placeholder === "Ask Question", qa.states.terminalBox);
  check("6 under the selection, its left edge where the selection starts", Math.abs(qa.states.terminalBox.top - (out.bottom + 6)) <= 4 && Math.abs(qa.states.terminalBox.left - out.left) <= 4, { box: qa.states.terminalBox, sel: out });
  await ui.screenshot("10-terminal-ask-dark");
  await ui.mark({ css: TBOX }, { what: "终端输出里选中一段：和回复里一样的 Quote | Ask Question 框", where: "对话下面的终端，选区下面 6", how: "打问题回车，答案在旁聊卡里" });
  await ui.click({ css: `${TBOX} textarea` });
  await ui.type("In five words, what is this output?");
  await ui.press("Enter", { send: true });
  qa.codexMessages++;
  await until(ui, async () => { const s = await read(); return s.side && s.side.q2 === "Terminal" ? s : null; }, 30000, "the side chat card on the terminal's output", 400);
  const fromTerminal = qa.states.fromTerminal = await read();
  check("the terminal's output: the same card, the quote `LEARN-TERMINAL-42 · Terminal`", fromTerminal.sideCount === 1 && fromTerminal.side.q1 === "LEARN-TERMINAL-42" && fromTerminal.side.q2 === "Terminal" && /codicon-terminal/.test(fromTerminal.side.icon), fromTerminal.side);
  check("still the same corner", corner(fromTerminal), [fromTerminal.part, fromTerminal.side.box]);
  await rest();
  await ui.screenshot("11-terminal-side-chat-dark");
  await ui.mark({ css: `${SIDE} .dsc-quote` }, { what: "终端里问的：引用卡第二行写 Terminal", where: "旁聊卡顶", how: "在卡里打问题接着问" });

  // ---- a reply's words bring the same box ----
  const reply = await ui.eval(`(() => { const v = [...document.querySelectorAll('.session-view .interactive-response .value .rendered-markdown')].filter(e => e.getClientRects().length && e.innerText.trim()).at(-1); if (!v) return null; const range = document.createRange(); range.selectNodeContents(v); const rects = [...range.getClientRects()].filter(r => r.width > 0); const a = rects[0], z = rects.at(-1); return { x1: a.left + 1, y1: a.top + a.height / 2, x2: z.right - 1, y2: z.top + z.height / 2 }; })()`);
  if (reply) {
    await ui.mouse("mouseMoved", reply.x1, reply.y1);
    await ui.mouse("mousePressed", reply.x1, reply.y1, { clickCount: 1 });
    for (let i = 1; i <= 6; i++) await ui.mouse("mouseMoved", reply.x1 + (reply.x2 - reply.x1) * i / 6, reply.y1 + (reply.y2 - reply.y1) * i / 6, { buttons: 1 });
    await ui.mouse("mouseReleased", reply.x2, reply.y2, { clickCount: 1 });
    const replyBox = await until(ui, () => ui.eval(`(() => { const w = [...document.querySelectorAll('.session-view .agent-feedback-input-widget')].find(e => e.offsetParent); return w ? { placeholder: w.querySelector('textarea').placeholder, actions: [...w.querySelectorAll('.agent-feedback-input-leading-action')].map(b => b.innerText.trim()) } : null; })()`), 10000, "the reply's box", 300).catch(() => null);
    qa.states.replyBox = replyBox;
    check("a reply's words: the Ask Question box (asking there opens the same card, side-chat-card.mjs sends one)", !!replyBox && replyBox.placeholder === "Ask Question", replyBox);
    if (replyBox) {
      await ui.screenshot("12-reply-ask-dark");
      await ui.mark({ css: ".session-view .agent-feedback-input-widget" }, { what: "回复里选字：同样的 Ask Question 框", where: "对话里选区下面", how: "打问题回车，答案在旁聊卡里" });
    }
    await ui.press("Escape");
  } else {
    check("a reply's words: the Ask Question box", false, "no reply text on screen");
  }

  // ---- light: the side chat card on the terminal's output, and the terminal's box ----
  await ui.setTheme("light");
  await rest();
  await ui.screenshot("13-terminal-side-chat-light");
  await selectOutput();
  await ui.screenshot("14-terminal-ask-light");
  await ui.mark({ css: TBOX }, { what: "终端的 Ask Question 框（浅色）", where: "选区下面", how: "Esc 关掉" });
  await ui.press("Escape");
  qa.states.final = await read();
  note();
  if (qa.failed.length) throw new Error(`${qa.failed.length} checks failed: ${qa.failed.join(" | ").slice(0, 1500)}`);
}
