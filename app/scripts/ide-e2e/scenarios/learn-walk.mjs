// Walk me through (direction B「Talk while new」 frame 6, user 2026-11-15, task-fktjx, kanban design/learn-scene).
// Walked as a person does it, in an OpenCode session on a cheap model (never Claude). Turn A makes a new file and
// changes another file in two places: under Talk the pill "Walk me through · 3 stops" comes when the turn ends and does
// not take the keyboard; Quiet hides it, Talk brings it back. A click walks the turn: each stop opens its file in the
// editor with the lines lit, the card says "Stop N of 3", the file, what kind of change and one sentence; Next, →, Back
// go on and back; Ask about this quotes the lines into the conversation's input (OpenCode has no side chats); started
// again from the Now tab, Esc ends it, the card goes and the editor stays on the last file. Turn B under Quiet: no
// pill, but Now walks it. Back in Talk turn B's pill shows; turn C starting takes it away. Light and dark, facts in
// qa.json.
export const meta = { needs: ['opencode'], instance: { motion: true },
  title: "边干边学：Walk me through，一轮做完一站一站看改动",
  description: "OpenCode 会话新建一个文件、改另一个文件两处：Talk 下一轮结束亮「Walk me through · 3 stops」，不抢焦点；切 Quiet 收起、切回 Talk 再亮。点它逐站走：编辑器打开那个文件、高亮那几行，卡里「Stop N of 3」、文件、一句话；Next、→、Back；Ask about this 把那几行作为引用片放进原对话输入框；从 Now 再开，Esc 结束、卡收起、编辑器停在最后那个文件。Quiet 再跑一轮不亮，Now 里能走；切回 Talk 那颗亮着，下一轮开始时收走。浅色深色截图。",
  timeout: 2400,
};

import fs from "node:fs";
import path from "node:path";
import { until, offscreen, onDemo, toDemo, focusInput, chooseCheapModel, closeTips } from "./session-now.mjs";

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
const PILL = ".dispatch-walk-pill";
const CARD = ".dispatch-walk-card";
const RUNNING = `!!document.querySelector('.session-view .interactive-input-part .chat-execute-toolbar .codicon-stop-circle')`;
const LAST = `(() => { const r = [...document.querySelectorAll('.session-view .interactive-response')].at(-1); return r ? r.innerText.trim() : ''; })()`;

// a file the agent changes in two places far apart (lines 3 and 15), and one it makes
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
const TURN_A = "In the current folder, do exactly three things with your file tools and run no commands. First use your write tool to create the new file `walk/notes.ts` with exactly these two lines: `// Keeps the reading notes in one list.` and `export const notes: string[] = [];`. Then use your edit tool on the existing file `walk/app.ts` to replace the line `export const theme = 'light';` with `export const theme = 'dark';`. Then use your edit tool again on `walk/app.ts` to replace the line `export const pageSize = 10;` with `export const pageSize = 20;`. Do nothing else, then reply with the single word DONE.";
const TURN_B = "Use your edit tool on `walk/app.ts` to replace the line `export const pageSize = 20;` with `export const pageSize = 30;`. Run no commands and do nothing else, then reply with the single word DONE.";
const TURN_C = "Use your edit tool on `walk/app.ts` to replace the line `export const fontSize = 16;` with `export const fontSize = 18;`. Run no commands and do nothing else, then reply with the single word DONE.";

/** The pill, the card and the editor the walk lights: what they say and where. */
const STATE = `(() => {
  const box = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) }; };
  const shown = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const part = [...document.querySelectorAll('.part.editor')].find(e => e.getBoundingClientRect().width > 0);
  const pill = document.querySelector('${PILL}');
  const card = document.querySelector('${CARD}');
  const t = (root, part) => { const e = root && root.querySelector('[data-part="' + part + '"]'); return e ? e.textContent.trim() : ''; };
  const eds = [...document.querySelectorAll('.part.editor .monaco-editor')].filter(e => shown(e) && !e.closest('.monaco-diff-editor') && e.querySelector('.view-lines'));
  const ed = eds.find(e => e.querySelector('.dispatch-walk-gutter')) || eds[0];
  const uri = ed ? (ed.getAttribute('data-uri') || (ed.querySelector('[data-uri]') || {}).getAttribute?.('data-uri') || '') : '';
  const lit = ed ? [...ed.querySelectorAll('.margin-view-overlays > div')].filter(d => d.querySelector('.dispatch-walk-gutter')).map(d => Number(((d.querySelector('.line-numbers') || {}).textContent || '').trim())).filter(Boolean).sort((a, b) => a - b) : [];
  const litBg = ed && ed.querySelector('.dispatch-walk-line') ? getComputedStyle(ed.querySelector('.dispatch-walk-line')).backgroundColor : '';
  const back = card && card.querySelector('[data-part="walk-back"]');
  return {
    part: box(part),
    pill: shown(pill) ? { text: pill.innerText.replace(/\\s+/g, ' ').trim(), box: box(pill), tabbable: [...pill.querySelectorAll('button')].map(b => b.tabIndex), radius: getComputedStyle(pill).borderTopLeftRadius } : null,
    card: card ? { ...card.dataset, box: box(card), radius: getComputedStyle(card).borderTopLeftRadius, bg: getComputedStyle(card).backgroundColor,
      head: (card.querySelector('.dwk-head') || {}).innerText?.replace(/\\s+/g, ' ').trim(), file: t(card, 'walk-file'), where: t(card, 'walk-where'), say: t(card, 'walk-say'),
      page: t(card, 'walk-page'), next: t(card, 'walk-next'), backShown: !!back && getComputedStyle(back).visibility !== 'hidden', more: t(card, 'walk-more'),
      sayFont: (() => { const s = card.querySelector('[data-part="walk-say"]'); return s ? getComputedStyle(s).fontSize + '/' + getComputedStyle(s).lineHeight : ''; })() } : null,
    editor: ed ? { uri, lit, litBg } : null,
    focusInCard: !!(document.activeElement && document.activeElement.closest('${CARD}')),
    focusOn: document.activeElement && document.activeElement.closest('${CARD}') ? (document.activeElement.dataset.part || 'card') : '',
    cardOutline: card ? getComputedStyle(card).outlineStyle + ' ' + getComputedStyle(card).borderTopColor : '',
    files: [...document.querySelectorAll('.part.auxiliarybar')].some(e => e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden'),
    focusInPill: !!(document.activeElement && document.activeElement.closest('${PILL}')),
    talkCards: document.querySelectorAll('.dispatch-talk-card:not(.leaving)').length,
  };
})()`;

/** Whether the changed characters are on screen and nothing covers them (the minimap, the card, a list beside the
 *  editor): the token's box inside the editor and elementFromPoint at both its ends inside the editor's lines. */
const SEEN = (token) => `(() => {
  const ed = [...document.querySelectorAll('.part.editor .monaco-editor')].find(e => e.getClientRects().length && e.querySelector('.dispatch-walk-gutter'));
  if (!ed) return { ok: false, why: 'no lit editor' };
  const guard = (ed.querySelector('.overflow-guard') || ed).getBoundingClientRect();
  for (const vl of ed.querySelectorAll('.view-lines .view-line')) {
    const walker = document.createTreeWalker(vl, NodeFilter.SHOW_TEXT); let n;
    while ((n = walker.nextNode())) {
      const at = n.textContent.indexOf(${JSON.stringify(token)});
      if (at < 0) continue;
      const r = document.createRange(); r.setStart(n, at); r.setEnd(n, at + ${JSON.stringify(token)}.length);
      const b = r.getBoundingClientRect(); const y = b.top + b.height / 2;
      const hits = [b.left + 1, b.right - 1].map(x => { const e = document.elementFromPoint(x, y); return e ? (e.closest('.view-lines') && ed.contains(e) ? 'lines' : (e.className || e.tagName).toString().slice(0, 40)) : 'nothing'; });
      const inside = b.left >= guard.left && b.right <= guard.right && b.top >= guard.top && b.bottom <= guard.bottom;
      const mm = ed.querySelector('.minimap');
      return { ok: inside && hits.every(h => h === 'lines'), box: [Math.round(b.left), Math.round(b.right), Math.round(b.top)], guard: [Math.round(guard.left), Math.round(guard.right)], hits, minimap: !!mm && mm.getBoundingClientRect().width > 0 };
    }
  }
  return { ok: false, why: 'not on screen' };
})()`;
/** The changed characters each stop has to show. */
const tokenOf = (file, start) => file === "notes.ts" ? "string" : start === 3 ? "dark" : "20";

/** The Now tab's head: its buttons. */
const NOW = `(() => { const h = document.querySelector('[data-part="now-head"]'); return h ? { mode: h.dataset.mode, buttons: [...h.querySelectorAll('.dispatch-now-btn')].map(b => ({ text: b.textContent, kind: ['fill', 'outline', 'ghost'].find(k => b.classList.contains(k)), part: b.dataset.part || '' })) } : null; })()`;

/** The quotes in the conversation's input. */
const QUOTES = `[...document.querySelectorAll('.session-view .interactive-input-part .dispatch-quote')].filter(e => e.getClientRects().length).map(q => ({ text: (q.querySelector('.dispatch-quote-text') || {}).textContent || '', src: (q.querySelector('.dispatch-quote-src') || {}).textContent || '' }))`;

export default async function (ui) {
  const qa = { checks: [], failed: [], states: {}, stops: [], model: [] };
  const note = () => fs.writeFileSync(path.join(ui.out, "qa.json"), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail).slice(0, 600)}`);
    console.error(`${ok ? "ok" : "FAILED"}: ${name}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400)}`);
    note();
  };
  const read = () => ui.eval(STATE);
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
  const send = async (text, what) => {
    await focusInput(ui, ".session-view .interactive-input-part");
    await ui.type(text);
    await ui.press("Enter", { send: true });
    await until(ui, () => ui.eval(RUNNING), 90000, `${what} to start`, 300).catch(() => {});
  };
  const closeSettings = async () => {
    const open = () => ui.eval(`!!document.querySelector('.part.sidebar.dispatch-settings-open .dispatch-settings-nav') && [...document.querySelectorAll('[data-part="learn-mode"]')].some(e => e.getClientRects().length)`);
    for (let i = 0; i < 4 && (await open()); i++) {
      await ui.press("Escape");
      await ui.sleep(1200);
    }
    if (await open()) throw new Error("Settings did not close on Escape");
  };
  const setMode = async (mode) => {
    await ui.press("Cmd+,");
    await ui.waitFor({ css: ".part.sidebar.dispatch-settings-open .dispatch-settings-nav", webview: false }, { timeoutMs: 15000 });
    await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="learning"]', webview: false });
    await ui.waitFor({ css: '[data-part="learn-mode"]' }, { timeoutMs: 15000 });
    await ui.click({ text: mode === "quiet" ? "Quiet" : "Talk", exact: true, within: '[data-part="learn-mode"]' });
    await until(ui, async () => learnSetting() === mode, 10000, `the setting to say ${mode}`, 300);
    await closeSettings();
  };
  const rest = async () => { await ui.mouse("mouseMoved", 700, 120); await ui.sleep(300); };
  const waitPill = (want, what, ms = 60000) => until(ui, async () => { const s = await read(); return (want ? !!s.pill : !s.pill) ? s : null; }, ms, what, 300);
  const waitStop = (index, what) => until(ui, async () => {
    const s = await read();
    return s.card && Number(s.card.index) === index && s.editor && s.editor.lit.length && s.editor.uri.endsWith(s.card.path.split("/").slice(-2).join("/")) ? s : null;
  }, 20000, what, 250);
  /** One stop as it should be: the card's file is the editor's, the lit lines are the card's lines (those on screen). */
  const checkStop = async (s, n, count, token) => {
    const c = s.card, start = Number(c.start), end = Number(c.end);
    check(`stop ${n}: the card says "Stop ${n} of ${count}" and this turn's ${count} stops`, c.page === `Stop ${n} of ${count}` && c.count === String(count) && /this turn, \d+ stops?/.test(c.head), { page: c.page, head: c.head });
    check(`stop ${n}: the editor shows the card's file (${c.file})`, s.editor.uri.endsWith(c.path.split("/").slice(-2).join("/")) && c.path.endsWith(c.file), { uri: s.editor.uri, path: c.path, file: c.file });
    check(`stop ${n}: the lit lines are the stop's lines ${start}–${end}`, s.editor.lit.length > 0 && s.editor.lit.every(l => l >= start && l <= end) && s.editor.lit.includes(start), { want: [start, end], lit: s.editor.lit });
    check(`stop ${n}: one sentence (${c.source})`, c.say.length > 3 && /[.!?。！？…]$/.test(c.say), { say: c.say, source: c.source });
    check(`stop ${n}: the kind of change and the lines under the file name`, new RegExp(`(New file|added|removed|changed|changes) · lines? ${start}(–${end})?$`).test(c.where), c.where);
    check(`stop ${n}: Back only after the first stop, Done on the last`, c.backShown === (n > 1) && c.next === (n === count ? "Done" : "Next"), { back: c.backShown, next: c.next });
    check(`stop ${n}: the file list beside the editor is put away while walking`, !s.files, s.files);
    check(`stop ${n}: the keyboard on Next, no ring round the card`, s.focusOn === "walk-next" && /^none /.test(s.cardOutline), { focus: s.focusOn, outline: s.cardOutline });
    const want = token ?? tokenOf(c.file, start);
    await ui.sleep(400); // a smooth scroll settles
    const seen = await ui.eval(SEEN(want));
    check(`stop ${n}: the changed characters "${want}" are on screen and nothing covers them`, seen.ok, seen);
    qa.stops.push({ n, file: c.file, path: c.path, seen, start, end, where: c.where, say: c.say, source: c.source, model: c.model, modelMs: c.modelMs, changes: c.changes, lit: s.editor.lit });
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
  fs.mkdirSync(path.join(ui.demoFolder, "walk"), { recursive: true });
  fs.writeFileSync(path.join(ui.demoFolder, "walk", "app.ts"), APP);
  await offscreen(ui);
  await onDemo(ui);
  await closeTips(ui);
  await ui.setTheme("light");
  check("Talk is the default", learnSetting() === undefined || learnSetting() === "talk", learnSetting());
  // every 100 ms: a pill on screen while a turn runs is counted (it must never show then, not even for a moment)
  const WATCH = `(() => { if (window.__walkWatch) return true; window.__walkWatch = { pillWhileRunning: 0, samples: 0 }; setInterval(() => { const run = ${RUNNING}; const p = document.querySelector('${PILL}'); if (run) { window.__walkWatch.samples++; if (p && p.getClientRects().length && getComputedStyle(p).display !== 'none') window.__walkWatch.pillWhileRunning++; } }, 100); return true; })()`;
  await ui.eval(WATCH);

  // ======== A. Talk: a new file and two changes in another; the pill when the turn ends ========
  await ui.newSession();
  await toDemo(ui);
  await ui.pickEngine("OpenCode", 180000);
  await ui.sleep(1500);
  qa.states.model = await chooseCheapModel(ui, ".sessions-chat-editor");
  await focusInput(ui, ".sessions-chat-editor");
  await ui.type(TURN_A);
  await ui.press("Enter", { send: true });
  await until(ui, () => ui.eval(RUNNING), 90000, "turn A to start", 500).catch(() => {});
  const whileRunning = await read();
  check("while the turn runs: no pill", !whileRunning.pill, whileRunning.pill);
  qa.states.answerA = (await turnEnds()).slice(0, 200);
  const appNow = fs.readFileSync(path.join(ui.demoFolder, "walk", "app.ts"), "utf8");
  check("the agent made the file and changed both lines", fs.existsSync(path.join(ui.demoFolder, "walk", "notes.ts")) && /theme = 'dark'/.test(appNow) && /pageSize = 20/.test(appNow), appNow.split("\n").filter(l => /theme|pageSize/.test(l)));
  // where the keyboard is when the pill comes
  await ui.eval(`window.__walkFocus = document.activeElement && (document.activeElement.closest('.interactive-input-part') ? 'input' : document.activeElement.tagName)`);
  let pillA = await waitPill(true, "the pill after turn A", 60000);
  check("the pill waits until the turn's small cards have gone (it would push them under the pointer)", pillA.talkCards === 0, pillA.talkCards);
  await ui.sleep(500); // its 200 ms rise has settled
  pillA = qa.states.pillA = await read();
  check("Talk: the pill comes when the turn ends, \"Walk me through · 3 stops\"", /Walk me through\s*3 stops/.test(pillA.pill.text), pillA.pill.text);
  check("the pill does not take the keyboard and is not a Tab stop", !pillA.focusInPill && pillA.pill.tabbable.every(t => t === -1), { focus: await ui.eval(`window.__walkFocus`), tabbable: pillA.pill.tabbable });
  check("the pill sits 16 from the side pane's right and bottom, a 32 high pill", !!pillA.part && Math.abs(pillA.part.r - pillA.pill.box.r - 16) <= 1.5 && Math.abs(pillA.part.b - pillA.pill.box.b - 16) <= 1.5 && pillA.pill.box.h === 32, { part: pillA.part, pill: pillA.pill.box });
  await rest();
  await ui.screenshot("01-walk-pill-light");
  await ui.mark({ css: PILL }, { what: "Walk me through 胶囊：这一轮做完了，3 站", where: "右栏右下角", how: "点它一站一站看；× 关掉；下一轮开始时自己收走" });
  await ui.sleep(5000);
  check("the pill stays while nobody clicks it", !!(await read()).pill);

  // Quiet hides it, Talk brings it back
  await setMode("quiet");
  const quietA = await read();
  check("switched to Quiet: the pill goes", !quietA.pill, quietA.pill);
  await setMode("talk");
  const talkA = await waitPill(true, "the pill again in Talk", 15000).catch(() => read());
  check("back to Talk: the pill is there again", !!talkA.pill, talkA.pill);

  // ---- the walk, from the pill ----
  await ui.click({ css: `${PILL} [data-part="walk-pill-go"]` });
  const s1 = await waitStop(0, "the first stop");
  check("the pill went when the walk began", !s1.pill, s1.pill);
  check("the card has the keyboard (← → Esc work at once)", s1.focusInCard, s1.focusInCard);
  check("the card is the side chat card's family: corner 12, 16 off the pane's corner", s1.card.radius === "12px" && !!s1.part && Math.abs(s1.part.r - s1.card.box.r - 16) <= 1.5 && Math.abs(s1.part.b - s1.card.box.b - 16) <= 1.5, { radius: s1.card.radius, part: s1.part, card: s1.card.box });
  const count = Number(s1.card.count);
  check("three stops: the new file, and each of the two changed blocks", count === 3, s1.card.count);
  await checkStop(s1, 1, count);
  await ui.screenshot("02-walk-stop-1-light");
  await ui.mark({ css: CARD }, { what: "站卡：第几站、文件、改了什么、一句话", where: "右栏右下角，旁聊卡的位置", how: "Next / → 下一站，Back / ← 上一站，Esc 结束" });
  await ui.mark({ css: ".part.editor .monaco-editor .dispatch-walk-line" }, { what: "这一站的那几行：整行淡亮，行号旁一条竖线", where: "编辑器里，滚到靠上", how: "换站时跟着换" });

  // Next with a click, → with the keyboard, Back with a click
  await ui.click({ css: `${CARD} [data-part="walk-next"]` });
  const s2 = await waitStop(1, "the second stop");
  await checkStop(s2, 2, count);
  await ui.screenshot("03-walk-stop-2-light");
  await ui.mark({ css: CARD }, { what: "第 2 站", where: "右栏右下角", how: "Back 回上一站" });
  await ui.mark({ css: ".part.editor .monaco-editor .dispatch-walk-line" }, { what: "第 2 站高亮的行", where: "编辑器", how: "看完点 Next" });
  await ui.press("ArrowRight");
  const s3 = await waitStop(2, "the third stop, by →");
  await checkStop(s3, 3, count);
  check("→ went on to the next stop", Number(s3.card.index) === 2);
  await ui.click({ css: `${CARD} [data-part="walk-back"]` });
  const back2 = await waitStop(1, "back to the second stop");
  check("Back: the second stop again, its file and lines lit again", back2.card.path === s2.card.path && back2.card.start === s2.card.start && JSON.stringify(back2.editor.lit) === JSON.stringify(s2.editor.lit), { back: [back2.card.path, back2.card.start, back2.editor.lit], was: [s2.card.path, s2.card.start, s2.editor.lit] });
  await ui.press("ArrowLeft");
  const back1 = await waitStop(0, "back to the first stop by ←");
  check("← went back to the first stop", back1.card.path === s1.card.path);
  check("the stops are the new file and the two changes in app.ts", new Set(qa.stops.slice(0, 3).map(s => `${s.file}:${s.start}`)).size === 3 && qa.stops.slice(0, 3).some(s => s.file === "notes.ts" && s.start === 1 && s.end === 2) && qa.stops.slice(0, 3).filter(s => s.file === "app.ts").map(s => s.start).sort((a, b) => a - b).join() === "3,15", qa.stops.slice(0, 3).map(s => [s.file, s.start, s.end]));
  const notes = qa.stops.find(s => s.file === "notes.ts");
  check("the new file says its own first comment", !!notes && notes.say === "Keeps the reading notes in one list." && notes.source === "comment", notes);

  // the sentences nothing said: one call to the session's own agent, at most once for the turn
  const answered = await until(ui, async () => { const s = await read(); return s.card && s.card.model && s.card.model !== "asking" ? s : null; }, 180000, "the agent's sentences", 500).catch(() => read());
  qa.model.push({ turn: "A", state: answered.card && answered.card.model, ms: answered.card && answered.card.modelMs, by: answered.card && answered.card.modelBy });
  // walk the stops again to read what they say now
  for (let i = 0; i < count; i++) {
    if (i === 0) { await ui.press("ArrowLeft"); await ui.press("ArrowLeft"); await waitStop(0, "stop 1 again"); const s = await read(); qa.stops.push({ again: true, n: 1, file: s.card.file, start: Number(s.card.start), end: Number(s.card.end), say: s.card.say, source: s.card.source, model: s.card.model, modelMs: s.card.modelMs, modelBy: s.card.modelBy }); continue; }
    await ui.press("ArrowRight");
    const s = await waitStop(i, `stop ${i + 1} again`);
    qa.stops.push({ again: true, n: i + 1, file: s.card.file, start: Number(s.card.start), end: Number(s.card.end), say: s.card.say, source: s.card.source, model: s.card.model, modelMs: s.card.modelMs, modelBy: s.card.modelBy });
    check(`stop ${i + 1} after the answer: a sentence from the comment, the agent, the model or its lines`, ["comment", "agent", "model", "lines"].includes(s.card.source) && s.card.say.length > 3, { source: s.card.source, say: s.card.say });
  }
  const last = await read();
  check("on the last stop: Done", last.card.next === "Done" && last.card.page === `Stop ${count} of ${count}`, last.card);
  await ui.screenshot("04-walk-last-stop-light");
  await ui.mark({ css: `${CARD} [data-part="walk-ask"]` }, { what: "Ask about this：就这几行接着问", where: "站卡里那句话下面", how: "OpenCode 不支持旁聊：放进原对话输入框做引用片" });

  // Ask about this: OpenCode has no side chats, the lines go into the conversation's input as a quote
  const askStop = { file: last.card.file, start: Number(last.card.start), end: Number(last.card.end) };
  await ui.click({ css: `${CARD} [data-part="walk-ask"]` });
  const quotes = await until(ui, async () => { const q = await ui.eval(QUOTES); return q.length ? q : null; }, 15000, "the quote in the input", 300).catch(() => []);
  const afterAsk = await read();
  const wantSrc = askStop.start === askStop.end ? `${askStop.file} · line ${askStop.start}` : `${askStop.file} · lines ${askStop.start}–${askStop.end}`;
  qa.states.quotes = quotes;
  check("Ask about this (OpenCode): the stop's lines are a quote in the conversation's input, its source the file and lines", quotes.length === 1 && quotes[0].src.includes(wantSrc) && quotes[0].text.length > 0, { quotes, wantSrc });
  check("…and the walk's card went", !afterAsk.card, afterAsk.card);
  check("…and the keyboard is in the conversation's input", await ui.eval(`!!document.activeElement?.closest('.session-view .interactive-input-part')`));
  await ui.screenshot("05-ask-quote-light");
  await ui.mark({ css: ".session-view .interactive-input-part .dispatch-quote" }, { what: "Ask about this 放进来的引用片：那几行和「文件 · 行」", where: "原对话输入框", how: "打问题发出去；不发就点 × 去掉" });
  // the quote is not sent with the next turn
  await ui.hover({ css: ".session-view .interactive-input-part .dispatch-quote" });
  await ui.click({ css: ".session-view .interactive-input-part .dispatch-quote .dispatch-quote-rm" });
  await until(ui, async () => (await ui.eval(QUOTES)).length === 0, 10000, "the quote to go", 300);

  // ---- again from the Now tab, in dark; Esc ends it ----
  await ui.setTheme("dark");
  await ui.openNowTab();
  const nowA = qa.states.nowA = await until(ui, async () => { const n = await ui.eval(NOW); return n && n.buttons.some(b => b.part === "walk-me-through") ? n : null; }, 20000, "Walk me through in Now", 400).catch(() => ui.eval(NOW));
  check("Now's head has Walk me through (also under Talk)", !!nowA && nowA.buttons.some(b => b.part === "walk-me-through"), nowA);
  check("Now: Walk me through is the outline button, See changes ghost beside it", !!nowA && nowA.buttons.some(b => b.part === "walk-me-through" && b.kind === "outline") && nowA.buttons.filter(b => b.text === "See changes").every(b => b.kind === "ghost"), nowA);
  await ui.screenshot("06-now-walk-button-dark");
  await ui.mark({ css: '[data-part="walk-me-through"]' }, { what: "Now 头里的 Walk me through", where: "右栏 Now，做完时的按钮行", how: "点它从第 1 站走" });
  await ui.click({ css: '[data-part="walk-me-through"]' });
  const d1 = await waitStop(0, "the first stop from Now");
  check("from Now: the walk starts at stop 1", Number(d1.card.index) === 0 && d1.card.page === `Stop 1 of ${count}`, d1.card.page);
  await ui.press("ArrowRight");
  const d2 = await waitStop(1, "stop 2 in dark");
  await ui.screenshot("07-walk-stop-dark");
  await ui.mark({ css: CARD }, { what: "站卡（深色）", where: "右栏右下角", how: "← → 换站，Esc 结束" });
  await ui.mark({ css: ".part.editor .monaco-editor .dispatch-walk-line" }, { what: "高亮的行（深色）", where: "编辑器", how: "换站跟着换" });
  qa.states.darkLit = d2.editor.litBg;
  await ui.press("ArrowRight");
  const d3 = await waitStop(2, "the last stop in dark");
  await ui.press("Escape");
  await until(ui, async () => !(await read()).card, 5000, "the card to go on Esc", 200).catch(() => {});
  const afterEsc = qa.states.afterEsc = await read();
  check("Esc: the card goes and the lines are no longer lit", !afterEsc.card && !!afterEsc.editor && afterEsc.editor.lit.length === 0, afterEsc);
  check("…and the file list beside the editor is back", afterEsc.files, afterEsc.files);
  check("…and the editor stays on the last stop's file", !!afterEsc.editor && afterEsc.editor.uri.endsWith(d3.card.path.split("/").slice(-2).join("/")), { uri: afterEsc.editor && afterEsc.editor.uri, last: d3.card.path });
  await ui.screenshot("08-after-esc-dark");

  // ======== B. Quiet: a turn that changes a file, no pill; Now walks it ========
  await ui.setTheme("light");
  await setMode("quiet");
  await send(TURN_B, "turn B");
  qa.states.answerB = (await turnEnds()).slice(0, 200);
  check("turn B changed the file", /pageSize = 30/.test(fs.readFileSync(path.join(ui.demoFolder, "walk", "app.ts"), "utf8")));
  await ui.sleep(6000 * SCALE);
  const quietB = await read();
  check("Quiet: no pill after the turn", !quietB.pill, quietB.pill);
  await ui.openNowTab();
  const nowB = qa.states.nowB = await until(ui, async () => { const n = await ui.eval(NOW); return n && n.buttons.some(b => b.part === "walk-me-through") ? n : null; }, 30000, "Walk me through in Now after turn B", 400).catch(() => ui.eval(NOW));
  check("Quiet: Now's head still has Walk me through", !!nowB && nowB.buttons.some(b => b.part === "walk-me-through"), nowB);
  await ui.screenshot("09-quiet-now-light");
  await ui.mark({ css: '[data-part="walk-me-through"]' }, { what: "Quiet 下不亮胶囊，入口在 Now 头", where: "右栏 Now", how: "点它走这一轮" });
  await ui.click({ css: '[data-part="walk-me-through"]' });
  const b1 = await waitStop(0, "turn B's walk");
  await checkStop(b1, 1, 1, "30");
  check("turn B's walk: one stop, app.ts line 15", b1.card.count === "1" && b1.card.file === "app.ts" && b1.card.start === "15" && b1.card.end === "15" && b1.card.page === "Stop 1 of 1" && b1.card.next === "Done", b1.card);
  const bAnswered = await until(ui, async () => { const s = await read(); return s.card && s.card.model && s.card.model !== "asking" ? s : null; }, 180000, "turn B's sentence", 500).catch(() => read());
  qa.model.push({ turn: "B", state: bAnswered.card && bAnswered.card.model, ms: bAnswered.card && bAnswered.card.modelMs, by: bAnswered.card && bAnswered.card.modelBy, say: bAnswered.card && bAnswered.card.say, source: bAnswered.card && bAnswered.card.source });
  await ui.screenshot("10-quiet-walk-light");
  await ui.mark({ css: CARD }, { what: "Quiet 下从 Now 开的站卡，只有一站", where: "右栏右下角", how: "Done 结束" });
  await ui.click({ css: `${CARD} [data-part="walk-next"]` });
  await until(ui, async () => !(await read()).card, 5000, "Done to end the walk", 200).catch(() => {});
  check("Done on the last stop ends the walk", !(await read()).card);

  // ======== C. back to Talk: turn B's pill shows; the next turn takes it away ========
  await ui.setTheme("dark");
  await setMode("talk");
  // B's pill was used by its walk from Now: a walk started anywhere uses the pill
  const talkB = await read();
  qa.states.talkAfterBWalked = talkB.pill;
  await send(TURN_C, "turn C");
  const cRunning = await read();
  check("turn C running: no pill", !cRunning.pill, cRunning.pill);
  await turnEnds();
  const pillC = await waitPill(true, "turn C's pill", 60000).catch(() => read());
  check("turn C ended under Talk: its pill, one stop", !!pillC.pill && /1 stop/.test(pillC.pill.text), pillC.pill);
  await rest();
  await ui.screenshot("11-walk-pill-dark");
  await ui.mark({ css: PILL }, { what: "Walk me through 胶囊（深色）", where: "右栏右下角", how: "不点就一直在；下一轮开始时收走" });
  // the next turn begins: the pill goes at once
  await focusInput(ui, ".session-view .interactive-input-part");
  await ui.type("Reply with the single word OK and do nothing else.");
  await ui.press("Enter", { send: true });
  const gone = await until(ui, async () => { const s = await read(); return !s.pill ? s : null; }, 15000, "the pill to go as the next turn starts", 100).catch(() => null);
  qa.states.pillGoneWhileRunning = gone ? await ui.eval(RUNNING) : null;
  check("the next turn starting takes the pill away", !!gone, gone);
  await turnEnds();
  await ui.sleep(4000);
  const noChange = await read();
  check("a turn that changed no file: no pill", !noChange.pill, noChange.pill);
  await ui.setTheme("light");
  qa.states.watch = await ui.eval(`window.__walkWatch`);
  check("in every turn, sampled every 100 ms while it ran: never a pill", !!qa.states.watch && qa.states.watch.samples > 20 && qa.states.watch.pillWhileRunning === 0, qa.states.watch);
  qa.states.final = await read();
  note();
  if (qa.failed.length) throw new Error(`${qa.failed.length} checks failed: ${qa.failed.join(" | ").slice(0, 1500)}`);
}
