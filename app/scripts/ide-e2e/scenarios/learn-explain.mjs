// Learning while the agent works, the third part (user 2026-11-15, task-39x97, kanban design/learn-scene frames 1, 4
// and 5): "see it" and "ask it". Walked as a person does it, in an OpenCode session on a cheap model (never Claude).
// Turn A: the agent first says in one sentence what it will do and why, then makes a file and changes another one in
// two places, then answers with commit (twice) and dependency. The Now tab's head shows that first sentence under the
// agent's line, while it works and once it is done. The reply's words get a dotted line, each only its first time;
// pointing at one shows VS Code's hover with a plain sentence and Ask more, and Tab onto one shows it too; Ask more puts
// the word into the conversation's input (OpenCode has no side chats). Settings › Learning › Explain terms off: the
// lines go, on again: back. Changes is VS Code's as it is (the user, 2026-11-16, task-rinkm): no Why / More on a block,
// no step filter, no marks of who wrote a line; asking about a block goes through the selection's Quote / Ask Question,
// so a selected line is quoted into the input from there. The walk of the turn asks its own one model call. Light and
// dark, facts in qa.json.
export const meta = { needs: ['opencode'], instance: { motion: true },
  title: "边干边学：Now 一句为什么、术语悬停、Changes 照 VS Code 原样",
  description: "OpenCode 会话先说一句计划再建一个文件、改另一个文件两处，回复里带 commit、dependency。Now 头下一行就是 Agent 开头那句；回复里的词下面点线、同一个词只标第一次，悬停和 Tab 都出解释和 Ask more，Ask more 把词放进原对话输入框；Settings 里 Explain terms 关掉点线没了。Changes 照 VS Code 原样：悬停一块没有 Why / More、没有按轮胶囊和谁写的标记；选中一行出 Quote / Ask Question，Quote 把那行放进输入框；导览自己问一次模型。浅色深色截图。",
  timeout: 2400,
};

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { until, offscreen, onDemo, toDemo, focusInput, chooseCheapModel, closeTips } from "./session-now.mjs";

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
const RUNNING = `!!document.querySelector('.session-view .interactive-input-part .chat-execute-toolbar .codicon-stop-circle')`;
const LAST = `(() => { const r = [...document.querySelectorAll('.session-view .interactive-response')].at(-1); return r ? r.innerText.trim() : ''; })()`;
const PLAN = "I will add a notes file and switch the app to a dark theme so reading at night is easier.";
const ANSWER = "Done. I made no commit yet, so you can make the commit yourself when you are happy; no new dependency was needed.";

const APP = [
  "// The reading app's settings.",
  "",
  "export const theme = 'light';",
  "export const fontSize = 16;",
  "export const lineHeight = 1.6;",
  "export const margins = 24;",
  "export const showClock = true;",
  "export const showBattery = true;",
  "export const nightShift = false;",
  "export const autoSync = true;",
  "export const syncEvery = 15;",
  "export const language = 'en';",
  "export const dictionary = 'oxford';",
  "export const highlights = 'yellow';",
  "export const pageSize = 10;",
  "export const fontFamily = 'serif';",
  "export const justify = true;",
  "export const hyphenate = false;",
  "export const pageTurn = 'slide';",
  "export const version = 1;",
  "",
].join("\n");
const TURN_A = `In the current folder do exactly this. Before you use any tool, write exactly this sentence as the start of your reply: "${PLAN}" Then, with your file tools and no commands: use your write tool to create the new file \`explain/notes.ts\` with exactly these two lines: \`// Keeps the reading notes in one list.\` and \`export const notes: string[] = [];\`. Then use your edit tool on the existing file \`explain/app.ts\` to replace the line \`export const theme = 'light';\` with \`export const theme = 'dark';\`. Then use your edit tool again on \`explain/app.ts\` to replace the line \`export const pageSize = 10;\` with \`export const pageSize = 20;\`. Do nothing else. When you are done, end your reply with exactly this text: "${ANSWER}"`;

/** The Now tab's head: the agent's line and the why under it. */
const NOW = `(() => {
  const h = document.querySelector('.dispatch-now-tab [data-part="now-head"]');
  if (!h) return null;
  const say = h.querySelector('[data-part="say"]'), why = h.querySelector('[data-part="why"]');
  const css = e => e ? { size: getComputedStyle(e).fontSize, weight: getComputedStyle(e).fontWeight, color: getComputedStyle(e).color, margin: getComputedStyle(e).marginTop, lh: getComputedStyle(e).lineHeight } : null;
  return { mode: h.dataset.mode, pieces: h.dataset.pieces, say: say ? say.innerText.trim() : '', why: why ? why.innerText.trim() : '', from: why ? why.dataset.from : '', css: css(why), sayCss: css(say),
    terms: [...h.querySelectorAll('.dispatch-term')].map(t => t.dataset.term) };
})()`;

/** The last reply: its words, the marked words and how they look. */
const REPLY = `(() => {
  const r = [...document.querySelectorAll('.session-view .interactive-response')].at(-1);
  if (!r) return null;
  const terms = [...r.querySelectorAll('.dispatch-term')].map(t => ({ term: t.dataset.term, text: t.textContent, off: t.classList.contains('off'), tab: t.tabIndex,
    line: getComputedStyle(t).textDecorationLine, style: getComputedStyle(t).textDecorationStyle, color: getComputedStyle(t).color, around: getComputedStyle(t.parentElement).color }));
  const text = r.innerText;
  return { text, terms, commits: (text.match(/\\bcommit\\b/gi) || []).length, plainColor: getComputedStyle(r.querySelector('.rendered-markdown p') || r).color };
})()`;

/** VS Code's hover over a word. */
const HOVER = `(() => {
  const h = [...document.querySelectorAll('.dispatch-term-hover')].find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  if (!h) return null;
  const b = h.getBoundingClientRect();
  return { nbsp: /\\u00a0/.test(h.textContent), text: h.innerText.replace(/\\s+/g, ' ').trim(), box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
    actions: [...h.querySelectorAll('.action-container, .action')].map(a => a.innerText.trim()).filter(Boolean),
    focusIn: !!(document.activeElement && h.contains(document.activeElement)) };
})()`;

/** The quotes in the conversation's input. */
const QUOTES = `[...document.querySelectorAll('.session-view .interactive-input-part .dispatch-quote')].filter(e => e.getClientRects().length).map(q => ({ text: (q.querySelector('.dispatch-quote-text') || {}).textContent || '', src: (q.querySelector('.dispatch-quote-src') || {}).textContent || '' }))`;

/** The Changes tab: its diffs, and anything Dispatch used to add there (Why / More, the step filter, marks of who wrote a line). */
const CHANGES = `(() => {
  const root = document.querySelector('.session-changes-editor');
  if (!root) return null;
  const n = css => [...document.querySelectorAll(css)].filter(e => e.getClientRects().length).length;
  return { diffs: [...root.querySelectorAll('.monaco-diff-editor')].filter(d => d.getClientRects().length).length,
    added: { hunkWhy: n('.dispatch-hunk-why, .dispatch-hunk-expl'), steps: n('.dispatch-attr-steps, .dispatch-attr-stepnote'),
      hint: n('.dispatch-attr-hint'), marks: n('.dispatch-attr-mark'), rowMarks: n('.changes-file-list .dispatch-attr-chip, .session-changes-editor .dispatch-attr-chip'),
      hintText: /Lines without a mark/.test(root.innerText) } };
})()`;

/** The selection box in a diff: its buttons in front of the input. */
const SELECTION_BOX = `[...document.querySelectorAll('.agent-feedback-input-widget .agent-feedback-input-leading-action')].filter(b => b.getClientRects().length).map(b => b.dataset.action + ':' + (b.innerText.trim() || b.getAttribute('aria-label') || ''))`;

export default async function (ui) {
  const qa = { checks: [], failed: [], states: {}, model: [] };
  const note = () => fs.writeFileSync(path.join(ui.out, "qa.json"), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail).slice(0, 600)}`);
    console.error(`${ok ? "ok" : "FAILED"}: ${name}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400)}`);
    note();
  };
  const settingsFiles = [ui.rec.user_data_dir, ui.rec.agents_user_data_dir].filter(Boolean).map(d => path.join(d, "User", "settings.json"));
  const setting = (k) => {
    for (const f of settingsFiles) {
      try {
        const v = JSON.parse(fs.readFileSync(f, "utf8"))[k];
        if (v !== undefined) return v;
      } catch { /* not there */ }
    }
    return undefined;
  };
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
  // a mark on something that is not there fails the check it belongs to, not the whole run
  const markIf = async (spec, n) => { if (await ui.exists(spec)) { await ui.mark(spec, n); } else { check(`on screen to mark: ${JSON.stringify(spec)}`, false); } };
  // point at a word of the last reply, as a person does: the reply settles first (its steps fold away when it ends)
  const hoverTerm = async (term) => {
    for (let i = 0; i < 3; i++) {
      await rest();
      await ui.sleep(800);
      await ui.hover({ css: `.session-view .interactive-response .dispatch-term[data-term="${term}"]` }, { settleMs: 200 });
      const h = await until(ui, () => ui.eval(HOVER), 5000, `the hover over ${term}`, 150).catch(() => null);
      if (h) {
        qa.states[`hoverTries${term}`] = i + 1;
        return h;
      }
    }
    return null;
  };
  const rest = async () => { await ui.mouse("mouseMoved", 700, 120); await ui.sleep(400); };
  const closeSettings = async () => {
    const open = () => ui.eval(`!!document.querySelector('.part.sidebar.dispatch-settings-open .dispatch-settings-nav') && [...document.querySelectorAll('[data-part="learn-mode"]')].some(e => e.getClientRects().length)`);
    for (let i = 0; i < 4 && (await open()); i++) {
      await ui.press("Escape");
      await ui.sleep(1200);
    }
    if (await open()) throw new Error("Settings did not close on Escape");
  };
  const setTerms = async (on) => {
    await ui.press("Cmd+,");
    await ui.waitFor({ css: ".part.sidebar.dispatch-settings-open .dispatch-settings-nav", webview: false }, { timeoutMs: 15000 });
    await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="learning"]', webview: false });
    await ui.waitFor({ css: '[data-part="explain-terms"]' }, { timeoutMs: 15000 });
    const now = await ui.eval(`document.querySelector('[data-part="explain-terms"]').getAttribute('aria-checked')`);
    qa.states[`termsSwitchBefore${on ? "On" : "Off"}`] = now;
    if (!on) {
      // as it is the first time: on (ticked)
      check("Settings › Learning: Explain terms is ticked", now === "true" && await ui.eval(`document.querySelector('[data-part="explain-terms"]').classList.contains('checked')`), now);
      await ui.screenshot("06-settings-explain-terms-light");
      await markIf({ css: '[data-part="explain-terms"]' }, { what: "Explain terms 开关（默认开）", where: "Settings › Learning，Quiet / Talk 下面一行", how: "关掉后回复和 Now 里的点线马上没了" });
    }
    if ((now === "true") !== on) {
      await ui.click({ css: '[data-part="explain-terms"]' });
    }
    await until(ui, async () => (setting("dispatch.learning.explainTerms") !== false) === on, 10000, `Explain terms to be ${on ? "on" : "off"}`, 300);
    // the switch is turned off while it saves and the keyboard falls out of Settings: back onto the page's own row
    qa.states.focusAfterSwitch = await ui.eval(`document.activeElement ? document.activeElement.tagName + '.' + document.activeElement.className : ''`);
    await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="learning"]', webview: false });
    await closeSettings();
  };

  // ---- the instance and the demo project's files ----
  for (const dir of [ui.rec.user_data_dir, ui.rec.agents_user_data_dir].filter(Boolean)) {
    const f = path.join(dir, "User", "settings.json");
    let j = {};
    try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch { j = {}; }
    j["editor.accessibilitySupport"] = "off";
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(j, null, 1));
  }
  fs.mkdirSync(path.join(ui.demoFolder, "explain"), { recursive: true });
  fs.writeFileSync(path.join(ui.demoFolder, "explain", "app.ts"), APP);
  // the file was there before the session: committed, so Changes shows the agent's blocks, not a whole new file
  const git = (...a) => execFileSync("git", ["-C", ui.demoFolder, "-c", "user.name=Dispatch e2e", "-c", "user.email=e2e@dispatch.invalid", ...a], { encoding: "utf8", timeout: 20000 });
  try {
    git("rev-parse", "--is-inside-work-tree");
  } catch {
    git("init", "-q");
  }
  git("add", "explain/app.ts");
  git("commit", "-q", "-m", "the reading app's settings", "--", "explain/app.ts");
  await offscreen(ui);
  await onDemo(ui);
  await closeTips(ui);
  await ui.setTheme("light");
  check("Explain terms is on by default", setting("dispatch.learning.explainTerms") === undefined || setting("dispatch.learning.explainTerms") === true, setting("dispatch.learning.explainTerms"));

  // ======== A. a plan sentence, a new file, two changes, a reply with commit and dependency ========
  await ui.newSession();
  await toDemo(ui);
  await ui.pickEngine("OpenCode", 180000);
  await ui.sleep(1500);
  qa.states.model = await chooseCheapModel(ui, ".sessions-chat-editor");
  await focusInput(ui, ".sessions-chat-editor");
  await ui.type(TURN_A);
  await ui.press("Enter", { send: true });
  await until(ui, () => ui.eval(RUNNING), 90000, "turn A to start", 500).catch(() => {});
  await ui.openNowTab().catch(e => { qa.states.nowTabWhileRunning = String(e.message || e); });
  // while it works: the why line comes once the agent has said its sentence and begun (sampled until the turn ends)
  let whileRunning = null;
  await approveUntil(async () => {
    const n = await ui.eval(NOW);
    if (n && n.why && (await ui.eval(RUNNING))) {
      whileRunning = whileRunning || n;
    }
    return !(await ui.eval(RUNNING)) && (await ui.eval(LAST)).length > 0;
  }, "turn A to end", 300000);
  qa.states.nowWhileRunning = whileRunning;
  check("while the turn runs: the why line is under the agent's line, its words the agent's opening sentence", !!whileRunning && whileRunning.from === "plan" && /notes file/i.test(whileRunning.why) && /dark theme/i.test(whileRunning.why), whileRunning);
  const answerA = qa.states.answerA = (await ui.eval(LAST)).slice(0, 600);
  if (/401|unauthori[sz]ed|quota|insufficient/i.test(answerA)) ui.skip(`the test model could not answer: ${answerA.slice(0, 200)}`);
  const appNow = fs.readFileSync(path.join(ui.demoFolder, "explain", "app.ts"), "utf8");
  check("the agent made the file and changed both lines", fs.existsSync(path.join(ui.demoFolder, "explain", "notes.ts")) && /theme = 'dark'/.test(appNow) && /pageSize = 20/.test(appNow), appNow.split("\n").filter(l => /theme|pageSize/.test(l)));

  // ---- Now, done: the why line stays ----
  await ui.openNowTab();
  const nowDone = qa.states.nowDone = await until(ui, async () => { const n = await ui.eval(NOW); return n && n.mode !== "working" && n.why ? n : null; }, 30000, "the why line once done", 500).catch(() => ui.eval(NOW));
  check("done: the why line is still there, from the agent's opening words", !!nowDone && nowDone.from === "plan" && /notes file/i.test(nowDone.why), nowDone);
  check("the why line: 13px, the second grey, 6 under the agent's line, not the agent's line again", !!nowDone && nowDone.css && nowDone.css.size === "13px" && nowDone.css.margin === "6px" && nowDone.css.color !== nowDone.sayCss.color && nowDone.why !== nowDone.say, nowDone && { css: nowDone.css, say: nowDone.sayCss });
  await rest();
  await ui.screenshot("01-now-why-light");
  await markIf({ css: '.dispatch-now-tab [data-part="why"]' }, { what: "Now 里一句为什么：Agent 这一轮开头自己说的那句", where: "右栏 Now，Agent 那句话下面", how: "在跑和做完都在；没说就不显示，不另调模型" });

  // ---- the reply's words ----
  const reply = qa.states.reply = await until(ui, async () => { const r = await ui.eval(REPLY); return r && r.terms.length ? r : null; }, 20000, "the marked words in the reply", 500).catch(() => ui.eval(REPLY));
  const commits = reply ? reply.terms.filter(t => t.term === "Commit") : [];
  check("the reply's words are marked: Commit and Dependency", !!reply && commits.length >= 1 && reply.terms.some(t => t.term === "Dependency"), reply && reply.terms);
  check("commit comes twice in the reply but is marked once", !!reply && reply.commits >= 2 && commits.length === 1, reply && { commits: reply.commits, marked: commits.length });
  check("a marked word: a dotted line under it, its colour kept, a Tab stop", !!reply && reply.terms.every(t => t.line.includes("underline") && t.style === "dotted" && t.tab === 0 && t.color === t.around), reply && reply.terms);
  // point at it: VS Code's hover with the sentence and Ask more
  const hover = qa.states.hover = await hoverTerm("Commit");
  check("pointing at commit: a hover with the word, a plain sentence and Ask more", !!hover && /^Commit · A saved snapshot/.test(hover.text) && /Ask more/.test(hover.text), hover);
  check("…one paragraph that breaks at spaces, at most about 336 wide", !!hover && !hover.nbsp && hover.box[2] <= 340, hover && { nbsp: hover.nbsp, width: hover.box[2] });
  await ui.screenshot("02-term-hover-light");
  await markIf({ css: '.session-view .interactive-response .dispatch-term[data-term="Commit"]' }, { what: "回复里的 commit：下面一条淡点线，一条回复只标第一次", where: "对话里 Agent 的回复", how: "指上去或 Tab 到它上面出解释" });
  await markIf({ css: ".dispatch-term-hover" }, { what: "VS Code 自己的悬停框：一句人话 + Ask more", where: "那个词下面", how: "Ask more 在旁聊卡里接着问；OpenCode 放进原对话输入框" });
  // Ask more with the pointer: into the hover, click it
  const askBox = await ui.eval(`(() => { const h = [...document.querySelectorAll('.dispatch-term-hover')].find(e => e.getClientRects().length); const a = h && [...h.querySelectorAll('.action-container, a, [role="button"]')].find(x => /Ask more/.test(x.textContent)); if (!a) return null; const b = a.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (askBox) {
    await ui.mouse("mouseMoved", askBox.x, askBox.y - 12);
    await ui.sleep(150);
    await ui.mouse("mouseMoved", askBox.x, askBox.y);
    await ui.sleep(150);
    await ui.mouse("mousePressed", askBox.x, askBox.y, { button: "left", clickCount: 1 });
    await ui.mouse("mouseReleased", askBox.x, askBox.y, { button: "left", clickCount: 1 });
  }
  const termQuote = qa.states.termQuote = await until(ui, async () => { const q = await ui.eval(QUOTES); return q.length ? q : null; }, 10000, "the word in the input", 300).catch(() => []);
  check("Ask more (OpenCode): the word goes into the conversation's input as a quote, its source Term", !!askBox && termQuote.length === 1 && termQuote[0].text.trim() === "Commit" && /Term/.test(termQuote[0].src), { askBox, termQuote });
  check("…and the keyboard is in the conversation's input", await ui.eval(`!!document.activeElement?.closest('.session-view .interactive-input-part')`));
  await ui.screenshot("03-ask-more-quote-light");
  await markIf({ css: ".session-view .interactive-input-part .dispatch-quote" }, { what: "Ask more 放进来的引用片：这个词，来源 Term", where: "原对话输入框", how: "打问题发出去；不发就点 × 去掉" });
  await ui.hover({ css: ".session-view .interactive-input-part .dispatch-quote" });
  await ui.click({ css: ".session-view .interactive-input-part .dispatch-quote .dispatch-quote-rm" });
  await until(ui, async () => (await ui.eval(QUOTES)).length === 0, 10000, "the quote to go", 300);

  // the keyboard: onto the first word (a key press first, so the focus counts as the keyboard's), then Tab to the next
  await rest();
  await ui.press("Escape");
  await ui.eval(`(() => { const r = [...document.querySelectorAll('.session-view .interactive-response')].at(-1); const t = r && r.querySelector('.dispatch-term'); t && t.focus(); })()`);
  const first = await ui.eval(`document.activeElement && document.activeElement.classList.contains('dispatch-term') ? document.activeElement.dataset.term : ''`);
  await ui.press("Tab");
  await ui.sleep(500);
  const tabbed = qa.states.tabbed = await ui.eval(`(() => { const a = document.activeElement; return { term: a && a.classList.contains('dispatch-term') ? a.dataset.term : '', visible: !!a && a.matches(':focus-visible'), outline: a ? getComputedStyle(a).outlineStyle : '' }; })()`);
  const tabHover = qa.states.tabHover = await until(ui, () => ui.eval(HOVER), 4000, "the hover on Tab", 150).catch(() => null);
  check("Tab from one word to the next: the next word has the keyboard (a ring), and its hover shows at once", !!first && !!tabbed.term && tabbed.term !== first && tabbed.visible && !!tabHover && tabHover.text.startsWith(tabbed.term), { first, tabbed, tabHover });
  check("…the keyboard stays on the word", !!tabHover && !tabHover.focusIn);
  await ui.screenshot("04-term-keyboard-light");
  await markIf({ css: ".session-view .interactive-response .dispatch-term:focus" }, { what: "Tab 走到词上：焦点框，解释一样出来", where: "回复里", how: "Enter 进到解释框里，再 Tab 到 Ask more" });
  // Enter: into the hover, Tab to Ask more
  await ui.press("Enter");
  await ui.sleep(500);
  const entered = qa.states.entered = await ui.eval(HOVER);
  check("Enter on the word: the hover takes the keyboard (Ask more is a Tab away)", !!entered && entered.focusIn, entered);
  await ui.press("Escape");
  await ui.sleep(300);

  // ---- Explain terms off: the lines go; on: they come back ----
  await setTerms(false);
  const off = qa.states.termsOff = await ui.eval(REPLY);
  check("Explain terms off: no dotted line, no Tab stop", !!off && off.terms.length > 0 && off.terms.every(t => t.off && !t.line.includes("underline") && t.tab === -1), off && off.terms);
  await ui.hover({ css: '.session-view .interactive-response .dispatch-term[data-term="Commit"]' }, { settleMs: 200 });
  await ui.sleep(1500);
  const offHover = await ui.eval(HOVER);
  check("…and pointing at the word shows nothing", !offHover, offHover);
  await rest();
  await ui.screenshot("05-terms-off-light");
  await setTerms(true);
  const onAgain = qa.states.termsOn = await ui.eval(REPLY);
  check("Explain terms on again: the dotted lines are back", !!onAgain && onAgain.terms.length > 0 && onAgain.terms.every(t => !t.off && t.line.includes("underline") && t.tab === 0), onAgain && onAgain.terms);

  // ======== Changes: VS Code's as it is, the selection's Quote / Ask Question ========
  await rest();
  await ui.openTab("Changes");
  const ch0 = qa.states.changes0 = await until(ui, async () => { const c = await ui.eval(CHANGES); return c && c.diffs >= 2 ? c : null; }, 40000, "the diffs of Changes", 500).catch(() => ui.eval(CHANGES));
  const nothingAdded = c => !!c && c.added.hunkWhy === 0 && c.added.steps === 0 && c.added.hint === 0 && c.added.marks === 0 && c.added.rowMarks === 0 && !c.added.hintText;
  check("Changes: both files' diffs, and nothing Dispatch used to add (no Why / More, no step filter, no marks, no grey line)", !!ch0 && ch0.diffs >= 2 && nothingAdded(ch0), ch0);
  const lineOf = (token) => ui.eval(`(() => { const root = document.querySelector('.session-changes-editor'); const l = [...root.querySelectorAll('.editor.modified .view-line')].filter(v => v.getBoundingClientRect().width > 0 && v.getBoundingClientRect().height > 0).find(v => v.textContent.replace(/\\u00a0/g, ' ').includes(${JSON.stringify(token)})); if (!l) return null; const b = l.getBoundingClientRect(); const first = l.querySelector('span > span'), last = l.querySelector('span > span:last-child') || l; return { x: b.left + 40, y: b.top + b.height / 2, x1: first ? first.getBoundingClientRect().left + 1 : b.left + 1, x2: last.getBoundingClientRect().right - 1 }; })()`);
  /** A line of Changes on screen, the list wheeled to it as a person scrolls (the side pane is short). */
  const seeLine = async (token) => {
    for (let i = 0; i < 16; i++) {
      const at = await lineOf(token);
      const view = await ui.eval(`(() => { const b = document.querySelector('.session-changes-editor .session-changes-editor-body, .session-changes-editor').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      if (at && at.y > view.top + 80 && at.y < view.bottom - 200) return at;
      await ui.mouse("mouseWheel", view.x, view.y, { button: "none", deltaX: 0, deltaY: !at || at.y >= view.bottom - 200 ? 120 : -120 });
      await ui.sleep(250);
    }
    return lineOf(token);
  };
  // point at the pageSize block, as a person does: still nothing of Dispatch's on it (a narrow side pane shows the
  // list alone: the file is clicked first, as a person does)
  if (!(await lineOf("pageSize = 20")) && await ui.exists({ text: "app.ts", exact: true, within: ".changes-file-list" })) {
    await ui.click({ text: "app.ts", exact: true, within: ".changes-file-list" });
    await until(ui, () => lineOf("pageSize = 20"), 30000, "the diff of app.ts", 400).catch(() => null);
  }
  let at = await seeLine("pageSize = 20");
  if (at) await ui.mouse("mouseMoved", at.x, at.y);
  await ui.sleep(800);
  const ch1 = qa.states.changesHover = await ui.eval(CHANGES);
  check("pointing at the pageSize block: no Why / More shows", !!at && nothingAdded(ch1), ch1);
  await ui.screenshot("07-changes-vscode-light");
  // select the line: VS Code's box, with Quote and Ask Question in front
  if (at) {
    await ui.mouse("mouseMoved", at.x1, at.y);
    await ui.mouse("mousePressed", at.x1, at.y, { clickCount: 1 });
    for (let i = 1; i <= 6; i++) await ui.mouse("mouseMoved", at.x1 + (at.x2 - at.x1) * i / 6, at.y, { buttons: 1 });
    await ui.mouse("mouseReleased", at.x2, at.y, { clickCount: 1 });
  }
  const box = qa.states.selectionBox = await until(ui, async () => { const b = await ui.eval(SELECTION_BOX); return b.length ? b : null; }, 15000, "the selection box", 300).catch(() => []);
  check("selecting the line: the box has Quote and Ask Question", box.some(b => /Quote/.test(b)) && box.some(b => /Ask Question/.test(b)), box);
  await ui.screenshot("08-changes-selection-light");
  await markIf({ css: ".agent-feedback-input-widget .agent-feedback-input-leading" }, { what: "选中 diff 里的字：Quote / Ask Question", where: "右栏 Changes，选区下面 VS Code 自己的批注框前面", how: "拖选一行；问为什么这么改就用 Ask Question" });
  await ui.click({ css: '.agent-feedback-input-widget .agent-feedback-input-leading-action[data-action="quote"]' });
  const moreQuote = qa.states.moreQuote = await until(ui, async () => { const q = await ui.eval(QUOTES); return q.length ? q : null; }, 10000, "the line in the input", 300).catch(() => []);
  check("Quote: the line goes into the conversation's input, from app.ts", moreQuote.length === 1 && /pageSize = 20/.test(moreQuote[0].text) && /app\.ts/.test(moreQuote[0].src), moreQuote);
  await ui.hover({ css: ".session-view .interactive-input-part .dispatch-quote" });
  await ui.click({ css: ".session-view .interactive-input-part .dispatch-quote .dispatch-quote-rm" });
  await until(ui, async () => (await ui.eval(QUOTES)).length === 0, 10000, "the quote to go", 300);

  // ---- dark: Changes, and Now ----
  await ui.setTheme("dark");
  await ui.openTab("Changes");
  at = await seeLine("pageSize = 20");
  if (at) await ui.mouse("mouseMoved", at.x, at.y);
  await ui.sleep(500);
  const darkChanges = qa.states.changesDark = await ui.eval(CHANGES);
  check("dark: Changes adds nothing either", nothingAdded(darkChanges), darkChanges);
  await ui.screenshot("10-changes-vscode-dark");
  await ui.openNowTab();
  // the tab is drawn again when it comes back: its head first shows what it showed last, then the board's answer
  const nowDark = qa.states.nowDark = await until(ui, async () => { const n = await ui.eval(NOW); return n && n.why ? n : null; }, 20000, "the why line in dark", 300).catch(() => ui.eval(NOW));
  check("dark: the why line is there when Now comes back", !!nowDark && nowDark.from === "plan" && /notes file/i.test(nowDark.why), nowDark);
  await rest();
  await ui.screenshot("11-now-why-dark");
  await markIf({ css: '.dispatch-now-tab [data-part="why"]' }, { what: "Now 里一句为什么（深色）", where: "右栏 Now", how: "来自 Agent 开头那句" });
  const darkHover = await hoverTerm("Dependency");
  check("dark: pointing at dependency shows its sentence", !!darkHover && /^Dependency · /.test(darkHover.text), darkHover);
  await ui.screenshot("12-term-hover-dark");
  await markIf({ css: ".dispatch-term-hover" }, { what: "术语悬停（深色）", where: "dependency 下面", how: "Ask more 接着问" });
  await rest();

  // ---- the walk of the same turn: its own one model call ----
  await ui.setTheme("light");
  await ui.openNowTab();
  await until(ui, async () => !!(await ui.exists({ css: '[data-part="walk-me-through"]' })), 20000, "Walk me through in Now", 400).catch(() => {});
  if (await ui.exists({ css: '[data-part="walk-me-through"]' })) {
    await ui.click({ css: '[data-part="walk-me-through"]' });
    const stops = [];
    for (let i = 0; i < 6; i++) {
      const s = await until(ui, () => ui.eval(`(() => { const c = document.querySelector('.dispatch-walk-card'); return c ? { ...c.dataset, say: (c.querySelector('[data-part="walk-say"]') || {}).textContent || '' } : null; })()`), 10000, "the walk's card", 250).catch(() => null);
      if (!s) break;
      stops.push(s);
      if (Number(s.index) >= Number(s.count) - 1) break;
      await ui.press("ArrowRight");
      await ui.sleep(700);
    }
    await ui.press("Escape");
    qa.states.walkA = stops;
    const appStops = stops.filter(s => /app\.ts$/.test(s.path || ""));
    check("the walk of turn A: both app.ts stops, each with a sentence once its one call is back", appStops.length === 2 && appStops.every(s => s.say.trim().length > 0), stops.map(s => [s.path, s.source, s.model, s.say]));
  } else {
    check("Walk me through in Now after turn A", false);
  }

  qa.states.final = { now: await ui.eval(NOW), changes: await ui.eval(CHANGES) };
  note();
  if (qa.failed.length) throw new Error(`${qa.failed.length} checks failed: ${qa.failed.join(" | ").slice(0, 1500)}`);
}
