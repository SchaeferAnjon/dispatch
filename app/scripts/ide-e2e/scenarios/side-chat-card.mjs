// A side chat opens in a card in the side pane's bottom right corner (direction A「Bottom-right card」, user 2026-11-15,
// task-23iin, kanban design/side-chat), not in a second narrow column beside the conversation. A real session answers
// once; a document opens in the side pane's Docs reader; a paragraph is dragged over with the mouse, Ask Question is
// typed into and sent; the card's answer comes. Then, as a person would: the pointer on the card's quote lights the
// passage, a click on it scrolls the document back; a follow-up is sent in the card and the card is folded into its
// pill while it answers (the pill's words turn 500 when the answer is in), the pill opens it again; Add to chat puts
// the answer into the conversation's input as a quote card (not sent); Keep as comment leaves it on the passage; the
// title bar's session menu lists the side chat; × closes it and the menu brings it back; a second side chat, switched to and back from the card's ⋯, renamed and deleted; Ask Question on the conversation's own reply opens the same card. Light and dark, and a window
// 1100 wide where the card fills the side pane's width. Sizes and places are read from the page into qa.json.
//
// The engine is Codex on the instance's cheap test model (ide_e2e.CODEX_TEST_MODEL, low effort): side chats need an
// engine that branches a chat (multipleChats.sideChat), which only Claude and Codex advertise; OpenCode does not, and
// tests never open Claude Code sessions (CLAUDE.md).
export const meta = { needs: ['codex'], instance: { motion: true },
  title: "旁聊开在右栏右下角的卡里",
  description: "Docs 里选一段字点 Ask Question：旁聊是右栏右下角一张卡（380 宽、至多 470 高、离角 16），原对话还是整列一栏；卡头 ⋯ – × 在卡里；卡顶引用卡指上去文档那段亮、点它文档滚回那段；– 收成胶囊，回答到了字变 500，点胶囊展开；Add to chat 进原对话输入框成引用卡不发送；Keep as comment 留成那段话上的批注；标题栏会话菜单列出旁聊，× 关掉后从那里打开；第二个旁聊用卡的 ⋯ 切换、改名、删除；回复里选字问也开同一张卡；1100 宽窗口卡撑满右栏；浅色深色各截图。",
  timeout: 2400,
};

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { until, offscreen, onDemo, toDemo, focusInput, closeTips } from "./session-now.mjs";

const run = promisify(execFile);
/** The instance's own dispatch CLI in the instance's environment. */
async function cli(ui, ...args) {
  const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; env=dict(E.instance_env(r)); os.execve(sys.executable,[sys.executable,r['cli'],*sys.argv[2:]],env)";
  const r = await run("python3", ["-c", bootstrap, JSON.stringify(ui.rec), ...args], { env: process.env, maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
  return r.stdout;
}

const FIRST = "Reply with one short sentence saying you are ready. Do not use any tools.";
const QUESTION = "In one short sentence, what is still left to do in this passage? Do not use any tools.";
const FOLLOW = "Now say it in at most eight words. Do not use any tools.";
const SECOND = "Reply with the single word OK. Do not use any tools.";
const REPLY_Q = "Is this a full sentence? Answer yes or no. Do not use any tools.";
const PASSAGE = "任务：Folio Reader 迁到本机并对照 Folioread 补齐功能。上一个会话把导入和搜索基本做完、请 designer 出了阅读页的设计；阅读页还没按新设计改，书签、夜间模式、导出、快捷键、打包也还没做。";
const DOC = [
  "# Folio Reader 交接（2026-11-08）",
  "",
  PASSAGE,
  "",
  "## 用户已经定了的",
  "",
  "| 事 | 定成 | 出处 |",
  "|---|---|---|",
  "| 项目位置 | `~/Projects/folio-reader`；旧副本不动 | 2026-10-28 |",
  "| 阅读功能 | 照 Folioread 原版全部加上（清单 `docs/GAP.md`） | 用户原话 |",
  "| 额外要做 | 批注导出、多设备同步；插件市场不做 | 2026-10-28 |",
  "| 界面风格 | 跟同系列的另外两个应用统一 | 偏好 |",
  "| 强调色 | 墨黑（不用设计稿默认的靛蓝） | 2026-11-08 |",
  "",
  "## 接下来",
  "",
  ...Array.from({ length: 14 }, (_, i) => [`### 第 ${i + 1} 步`, "", `第 ${i + 1} 步要做的事写在这里：先读清单，再改界面，改完在新虚拟机里走一遍，截图放进交付页。这一段只是为了让文档够长，能往下滚。`, ""]).flat(),
].join("\n");

const CARD = ".dispatch-side-chat-card";
const PILL = ".dispatch-side-chat-pill";
const MAIN_INPUT = ".session-view .interactive-input-part";

/** Where things are and how big, read from the page (CSS px). */
const STATE = `(() => {
  const box = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) }; };
  const shown = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && Number(getComputedStyle(e).opacity) > 0.5;
  const view = document.querySelector('.session-view.is-active') || document.querySelector('.session-view');
  const groups = view ? [...view.querySelectorAll('.chat-group-view')].filter(g => g.getBoundingClientRect().width > 0) : [];
  const card = document.querySelector('${CARD}');
  const pill = document.querySelector('${PILL}');
  const part = card ? card.parentElement : [...document.querySelectorAll('.part.editor')].find(e => e.getBoundingClientRect().width > 0);
  const head = card && card.querySelector('.dsc-head');
  const inHead = p => { const e = card && card.querySelector('[data-part="side-chat-' + p + '"]'); return !!e && !!head && head.contains(e) && shown(e); };
  const q = card && card.querySelector('.dsc-quote');
  const pillT = pill && pill.querySelector('.dsc-pill-t');
  const acts = card && card.querySelector('.dsc-acts');
  // a reply's words, without its footer (time, how long it took, the model)
  const responses = card ? [...card.querySelectorAll('.interactive-response')].map(r => ((r.querySelector('.value') || r).innerText || '').trim()).filter(Boolean) : [];
  const mainAsks = view ? [...view.querySelectorAll('.interactive-list .monaco-list-row.request')].length : 0;
  const quotes = [...document.querySelectorAll('${MAIN_INPUT} .dispatch-quote')].map(e => ({ text: (e.querySelector('.dispatch-quote-text') || {}).textContent || '', src: (e.querySelector('.dispatch-quote-src') || {}).textContent || '' }));
  return {
    window: innerWidth,
    groups: groups.length, column: groups.map(g => Math.round(g.getBoundingClientRect().width)),
    part: box(part), card: shown(card) ? box(card) : null, cardRadius: card ? getComputedStyle(card).borderTopLeftRadius : '',
    head: { more: inHead('more'), minimize: inHead('minimize'), close: inHead('close'), text: head ? head.innerText.replace(/\\s+/g, ' ').trim() : '' },
    quote: q ? { box: box(q), one: (q.querySelector('.dsc-quote-1') || {}).textContent || '', two: (q.querySelector('.dsc-quote-2') || {}).textContent || '', radius: getComputedStyle(q).borderTopLeftRadius } : null,
    pill: shown(pill) ? { ...box(pill), text: pill.innerText.trim(), weight: pillT ? getComputedStyle(pillT).fontWeight : '', answering: pill.classList.contains('answering') } : null,
    acts: !!acts && acts.classList.contains('on') && shown(acts), responses, mainAsks, quotes,
    columnHeads: view ? [...view.querySelectorAll('.chat-composite-bar-header')].filter(e => e.getClientRects().length).length : 0,
    inside: card ? {
      input: box(card.querySelector('.interactive-input-part')),
      acts: acts && acts.classList.contains('on') ? box(acts) : null,
      origins: [...card.querySelectorAll('.chat-request-origin')].filter(e => e.getClientRects().length).length,
      wide: [...card.querySelectorAll('*')].filter(e => !e.closest('.monaco-editor') && !e.classList.contains('shadow')).filter(e => { const b = e.getBoundingClientRect(); const c = card.getBoundingClientRect(); return b.width > 0 && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && (b.right > c.right + 1 || b.left < c.left - 1); }).map(e => e.className && String(e.className).slice(0, 60)).slice(0, 5),
      font: getComputedStyle(card).fontFamily.split(',')[0],
      inputBox: box(card.querySelector('.interactive-input-part .chat-input-container')),
      inputRadius: (() => { const e = card.querySelector('.interactive-input-part .chat-input-container'); return e ? getComputedStyle(e).borderTopLeftRadius : ''; })(),
      bubble: (() => { const b = card.querySelector('.interactive-request .value .rendered-markdown'); if (!b) return null; const cs = getComputedStyle(b); return { radius: cs.borderTopLeftRadius, pad: cs.paddingTop + ' ' + cs.paddingLeft, w: Math.round(b.getBoundingClientRect().width), row: Math.round(b.closest('.interactive-item-container').getBoundingClientRect().width) }; })(),
      model: (() => { const m = card.querySelector('.interactive-input-part .model-picker-split'); if (!m) return null; const l = m.querySelector('.chat-input-picker-label') || m; return { text: m.innerText.trim(), cut: [...m.querySelectorAll('*')].concat([m]).some(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow === 'ellipsis') }; })(),
      shownBits: { engine: !!card.querySelector('.dispatch-harness-picker-item') && card.querySelector('.dispatch-harness-picker-item').getClientRects().length > 0, status: [...card.querySelectorAll('.chat-secondary-toolbar')].some(e => e.getClientRects().length > 0), answerIcons: [...card.querySelectorAll('.chat-footer-toolbar')].some(e => e.getClientRects().length > 0) },
      tools: [...card.querySelectorAll('.interactive-input-part .chat-input-toolbars .action-item')].filter(e => e.getClientRects().length).map(e => ({ cls: String(e.className).replace(/\s+/g, ' ').slice(0, 80), w: Math.round(e.getBoundingClientRect().width), text: e.innerText.trim().replace(/\s+/g, ' ').slice(0, 40) })),
      lefts: (() => { const c = card.getBoundingClientRect().left; const x = s => { const e = card.querySelector(s); return e ? Math.round(e.getBoundingClientRect().left - c) : null; }; return { head: x('.dsc-head .dsc-ic'), quote: x('.dsc-quote'), answer: x('.interactive-response .value .rendered-markdown'), input: x('.interactive-input-part .chat-input-container') }; })(),
    } : null,
  };
})()`;

const LIGHT = `(() => { const h = CSS.highlights; const t = n => { const x = h && h.get(n); return x ? [...x].map(r => r.toString()).join(' | ') : null; }; return { soft: t('dispatch-side-chat-soft'), strong: t('dispatch-side-chat-strong'), commented: t('dispatch-doc-commented') }; })()`;

/** How many of the card's messages are drawn inside the list's visible box, with words in them. */
const ROWS_SHOWN = `(() => { const card = document.querySelector('${CARD}'); const list = card && card.querySelector('.interactive-list'); if (!list) return { shown: 0 }; const L = list.getBoundingClientRect(); const sc = list.querySelector('.monaco-scrollable-element'); const rc = list.querySelector('.monaco-list-rows'); const rows = [...card.querySelectorAll('.interactive-item-container')].map(e => { const b = e.getBoundingClientRect(); const v = e.querySelector('.value'); return { top: Math.round(b.top - L.top), bottom: Math.round(b.bottom - L.top), left: Math.round(b.left - L.left), w: Math.round(b.width), words: v ? v.innerText.trim().length : 0 }; }); return { list: [Math.round(L.width), Math.round(L.height)], scroll: sc ? [sc.scrollTop, rc ? Math.round(rc.getBoundingClientRect().height) : 0, rc ? rc.style.top : ''] : null, listRows: list.querySelectorAll('.monaco-list-row').length, rows, shown: rows.filter(r => r.bottom > 0 && r.top < L.height && r.left >= -1 && r.w > L.width * 0.8 && r.words > 0).length }; })()`;

const MENU_LABELS = `(() => { const all = (root, out) => { root.querySelectorAll('.context-view .action-menu-item .action-label, .monaco-menu .action-menu-item .action-label').forEach(e => out.push(e)); root.querySelectorAll('*').forEach(e => e.shadowRoot && all(e.shadowRoot, out)); return out; }; return [...new Set(all(document, []).filter(e => e.getClientRects().length).map(e => e.textContent.trim()).filter(Boolean))]; })()`;

export default async function (ui) {
  const qa = { checks: [], failed: [], states: {} };
  const note = () => fs.writeFileSync(path.join(ui.out, "qa.json"), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
    console.error(`${ok ? "ok" : "FAILED"}: ${name}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400)}`);
    note();
  };
  const read = () => ui.eval(STATE);
  const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
  const RUNNING = `!!document.querySelector('.session-view .interactive-input-part .chat-execute-toolbar .codicon-stop-circle')`;
  const lastMain = () => ui.eval(`(() => { const r = [...document.querySelectorAll('.session-view .interactive-response')].at(-1); return r ? r.innerText.trim() : ''; })()`);

  // ---- a real session that has answered once (Ask Question needs a reply to branch from) ----
  // the test instance turns the screen reader mode on by itself: its pill in the title bar is not part of the pictures
  for (const dir of [ui.rec.user_data_dir, ui.rec.agents_user_data_dir].filter(Boolean)) {
    const f = path.join(dir, "User", "settings.json");
    let j = {};
    try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch { j = {}; }
    j["editor.accessibilitySupport"] = "off";
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(j, null, 1));
  }
  await offscreen(ui);
  await onDemo(ui);
  await closeTips(ui);
  await ui.newSession();
  await toDemo(ui);
  await ui.pickEngine("Codex", 180000);
  await ui.sleep(1500);
  // Codex's small model (the instance's config names it too, but the chip can start on the person's own)
  qa.states.model = await ui.pickModel(/Luna/i, "Codex's small Luna model");
  await focusInput(ui, ".sessions-chat-editor");
  await ui.type(FIRST);
  await ui.press("Enter", { send: true });
  await until(ui, () => ui.eval(RUNNING), 90000, "the first turn to start", 500).catch(() => {});
  await until(ui, async () => !(await ui.eval(RUNNING)) && (await lastMain()).length > 0, 300000, "the first answer", 1500);
  const firstAnswer = await lastMain();
  if (/401|unauthori[sz]ed|quota|insufficient/i.test(firstAnswer)) ui.skip(`Codex could not answer on this Mac: ${firstAnswer.slice(0, 200)} (log in to Codex, or set DISPATCH_E2E_CODEX_MODEL)`);
  await closeTips(ui);
  await ui.setTheme("light");

  // ---- a document in the side pane's Docs reader ----
  const file = path.join(ui.demoFolder, "docs", "HANDOFF.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, DOC + "\n");
  await cli(ui, "ide", "show", file);
  const BODY = `.dispatch-docs-md[data-path=${JSON.stringify(file)}]`;
  await ui.waitFor({ css: BODY }, { timeoutMs: 30000 });
  await ui.sleep(800);
  const before = qa.states.before = await read();
  check("before: the conversation is one column", before.groups === 1, before);

  // ---- drag over the paragraph with the mouse, as a person selects it; the Ask Question box comes ----
  const para = await ui.eval(`(() => {
    const body = document.querySelector(${JSON.stringify(BODY)});
    const p = [...body.querySelectorAll('.md-block')].find(b => b.textContent.includes('Folio Reader 迁到本机'));
    p.scrollIntoView({ block: 'center' });
    const range = document.createRange(); range.selectNodeContents(p.querySelector('p') || p);
    const rects = [...range.getClientRects()].filter(r => r.width > 0);
    const a = rects[0], z = rects[rects.length - 1];
    return { line: Number(p.dataset.line), x1: a.left + 1, y1: a.top + a.height / 2, x2: z.right - 1, y2: z.top + z.height / 2 };
  })()`);
  await ui.mouse("mouseMoved", para.x1, para.y1);
  await ui.mouse("mousePressed", para.x1, para.y1, { button: "left", clickCount: 1 });
  for (let i = 1; i <= 8; i++) await ui.mouse("mouseMoved", para.x1 + (para.x2 - para.x1) * i / 8, para.y1 + (para.y2 - para.y1) * i / 8, { button: "left", buttons: 1 });
  await ui.mouse("mouseReleased", para.x2, para.y2, { button: "left", clickCount: 1 });
  await ui.sleep(600);
  const selected = await ui.eval(`getSelection().toString()`);
  check("the drag selected the paragraph's words", selected.includes("Folio Reader 迁到本机") && selected.includes("打包也还没做"), selected);
  await ui.waitFor({ css: ".dispatch-docs-ask textarea" }, { timeoutMs: 8000 });
  await ui.screenshot("01-ask-question");
  await ui.mark({ css: ".dispatch-docs-ask" }, { what: "选中文字后浮出的 Ask Question 框", where: "Docs 阅读页，选中的那段下面", how: "打问题，回车" });

  // ---- Ask Question: typed, Enter; the card comes and the answer is written in it ----
  await ui.type(QUESTION, { into: { css: ".dispatch-docs-ask textarea" } });
  await ui.press("Enter", { send: true });
  await ui.waitFor({ css: `${CARD}:not(.hidden)` }, { timeoutMs: 30000 });
  await until(ui, async () => (await read()).acts, 300000, "the side chat's answer", 1500);
  await ui.sleep(1200);
  const open = qa.states.open = await read();
  const pane = open.part;
  const wantW = Math.min(380, pane.w - 32), wantH = Math.max(240, Math.min(470, pane.h - 96 - 16));
  check("the conversation keeps its whole column: one column, the same width as before", open.groups === 1 && near(open.column[0], before.column[0]), { before: before.column, after: open.column });
  check("no title row over the conversation with a ⋯ of its own", open.columnHeads === 0, open.columnHeads);
  check("the card sits in the side pane's bottom right corner, 16 from its right and bottom edges", !!open.card && near(pane.r - open.card.r, 16) && near(pane.b - open.card.b, 16), { card: open.card, pane });
  check("the card is 380 wide (or the pane less 32) and at most 470 high", !!open.card && near(open.card.w, wantW) && near(open.card.h, wantH), { card: open.card, want: [wantW, wantH] });
  qa.states.share = { width: open.card ? +(open.card.w / pane.w).toFixed(2) : null, height: open.card ? +(open.card.h / pane.h).toFixed(2) : null };
  check("about half the pane wide and a little more than half its height", qa.states.share.width >= 0.4 && qa.states.share.width <= 0.95 && qa.states.share.height >= 0.5, qa.states.share);
  check("the card's head has its own ⋯ – × (inside the card)", open.head.more && open.head.minimize && open.head.close, open.head);
  check("the head says Side chat · from the session", /^Side chat · from /.test(open.head.text), open.head.text);
  check("on top a quote of the passage: its words and HANDOFF.md · line N", !!open.quote && open.quote.one.startsWith("任务：Folio Reader") && open.quote.two === `HANDOFF.md · line ${para.line}`, open.quote);
  check("the answer is in the card", open.responses.length >= 1 && open.responses.at(-1).length > 5, open.responses);
  check("the side chat's own input is at the card's bottom, inside it", !!open.inside.input && open.inside.input.b <= open.card.b && open.inside.input.b >= open.card.b - 24 && open.inside.input.x >= open.card.x, { input: open.inside.input, card: open.card });
  check("the answer's actions sit 8 over the input box", !!open.inside.acts && !!open.inside.inputBox && near(open.inside.inputBox.y - open.inside.acts.b, 8, 2), { acts: open.inside.acts, inputBox: open.inside.inputBox });
  check("everything starts 12 in from the card's edge, like its head (head icon, quote, answer, input)", Object.values(open.inside.lefts).every(v => v !== null && v >= 12 && v <= 14), open.inside.lefts);
  check("the person's words are the conversation's bubble: 24 round, at most 80% of the row", !!open.inside.bubble && open.inside.bubble.radius === "24px" && open.inside.bubble.w <= Math.ceil(open.inside.bubble.row * 0.8), open.inside.bubble);
  check("the card's input box is 10 round", open.inside.inputRadius === "10px", open.inside.inputRadius);
  check("no engine switch, no status row under the input and no icon row under the answer in the card", !open.inside.shownBits.engine && !open.inside.shownBits.status && !open.inside.shownBits.answerIcons, open.inside.shownBits);
  check("the model's name is whole in the card's input", !!open.inside.model && !open.inside.model.cut, open.inside.model);
  check("the card's input starts one line high (not two)", !!open.inside.inputBox && open.inside.inputBox.h <= 110, open.inside.inputBox);
  check("the chat's own from-row is not shown again under the card's quote", open.inside.origins === 0, open.inside.origins);
  check("nothing in the card sticks out of it sideways", open.inside.wide.length === 0, open.inside.wide);
  check("Add to chat, Keep as comment and Copy are there once the answer is in", open.acts && await ui.eval(`['add','keep','copy'].every(p => !!document.querySelector('${CARD} [data-part="side-chat-' + p + '"]'))`));
  const lit0 = qa.states.lit0 = await ui.eval(LIGHT);
  check("while the card is open the passage is lit softly", !!lit0.soft && lit0.soft.includes("Folio Reader 迁到本机") && !lit0.strong, lit0);
  await ui.mouse("mouseMoved", pane.x + 40, pane.y + 60);
  await ui.sleep(400);
  await ui.screenshot("02-card-light");
  await ui.mark({ css: CARD }, { what: "旁聊卡：右栏右下角，约右栏一半宽、一半多高；原对话还是整列", where: "右栏右下角", how: "在卡里接着问；卡头 ⋯ 改名、删除、换别的旁聊，– 收起，× 关掉" });
  await ui.mark({ css: `${CARD} .dsc-quote` }, { what: "引用卡：问的是文档哪段话", where: "卡顶", how: "指上去文档那段亮，点它文档滚回那段" });

  // ---- the quote: the pointer on it lights the passage fully; a click scrolls the document back to it ----
  await ui.hover({ css: `${CARD} .dsc-quote` });
  await ui.sleep(300);
  const lit1 = qa.states.lit1 = await ui.eval(LIGHT);
  check("the pointer on the quote lights the passage fully (its own words)", !!lit1.strong && lit1.strong.includes("Folio Reader 迁到本机") && lit1.strong.includes("打包也还没做"), lit1);
  await ui.screenshot("03-quote-hover");
  await ui.mouse("mouseMoved", pane.x + 40, pane.y + 60);
  await ui.sleep(300);
  const lit2 = await ui.eval(LIGHT);
  check("off the quote it is soft again", !!lit2.soft && !lit2.strong, lit2);
  const inView = `(() => { const body = document.querySelector(${JSON.stringify(BODY)}); const s = body.closest('.dispatch-docs-reader-scroll'); const p = [...body.querySelectorAll('.md-block')].find(b => b.textContent.includes('Folio Reader 迁到本机')); const a = s.getBoundingClientRect(), b = p.getBoundingClientRect(); return { top: Math.round(s.scrollTop), inView: b.top >= a.top && b.bottom <= a.bottom }; })()`;
  await ui.eval(`(() => { const s = document.querySelector(${JSON.stringify(BODY)}).closest('.dispatch-docs-reader-scroll'); s.scrollTop = s.scrollHeight; })()`);
  await ui.sleep(500);
  const away = await ui.eval(inView);
  check("scrolled to the end of the document, the passage is out of view", !away.inView && away.top > 200, away);
  await ui.click({ css: `${CARD} .dsc-quote` });
  await ui.sleep(1000);
  const back = qa.states.back = await ui.eval(inView);
  const lit3 = await ui.eval(LIGHT);
  check("a click on the quote scrolls the document back to the passage and lights it", back.inView && !!lit3.strong, { back, lit3 });
  await ui.mouse("mouseMoved", pane.x + 40, pane.y + 60);
  await ui.sleep(2000);
  const lit4 = await ui.eval(LIGHT);
  check("a moment later it is lit softly again", !!lit4.soft && !lit4.strong, lit4);

  // ---- a follow-up in the card; folded while it answers: the pill, then its words in 500 ----
  const firstSide = open.responses.at(-1);
  await focusInput(ui, `${CARD} .interactive-input-part`);
  await ui.type(FOLLOW);
  await ui.press("Enter", { send: true });
  await ui.sleep(300);
  await ui.click({ css: `${CARD} [data-part="side-chat-minimize"]` });
  await ui.sleep(400);
  const folded = qa.states.folded = await read();
  check("– folds the card: the card is gone, a pill is at the corner", !folded.card && !!folded.pill && near(pane.r - folded.pill.r, 16) && near(pane.b - folded.pill.b, 16), folded.pill);
  const seen = [];
  await until(ui, async () => { const s = await read(); if (s.pill) seen.push(`${s.pill.text}/${s.pill.weight}`); return s.pill && /new answer/.test(s.pill.text); }, 300000, "the follow-up's answer, while folded", 500);
  const unread = qa.states.unread = await read();
  qa.states.pillTexts = [...new Set(seen)];
  check("the pill says Answering while it writes, then 1 new answer in 500", unread.pill.text === "Side chat · 1 new answer" && Number(unread.pill.weight) === 500, qa.states.pillTexts);
  check("while folded the passage is not lit", !(await ui.eval(LIGHT)).soft);
  await ui.screenshot("04-pill-light");
  await ui.mark({ css: PILL }, { what: "收起的旁聊：右下角一颗胶囊，回答到了字变粗", where: "右栏右下角", how: "点它展开" });
  await ui.click({ css: PILL });
  await ui.sleep(600);
  const reopened = qa.states.reopened = await read();
  qa.states.reopenedRows = await ui.eval(ROWS_SHOWN);
  check("opened from the pill, the card's list shows its messages", qa.states.reopenedRows.shown >= 2, qa.states.reopenedRows);
  // the list draws only the rows on screen: the follow-up's answer is the last one drawn, and not the first answer
  check("the pill opens the card again, the follow-up answered in it", !!reopened.card && !reopened.pill && reopened.responses.length > 0 && reopened.responses.at(-1) !== firstSide, { card: !!reopened.card, responses: reopened.responses });

  // ---- Add to chat: a quote card in the conversation's input, nothing sent ----
  const asksBefore = reopened.mainAsks;
  await ui.click({ css: `${CARD} [data-part="side-chat-add"]` });
  await ui.sleep(800);
  const added = qa.states.added = await read();
  check("Add to chat: the conversation's input has the answer as a quote card from the side chat", added.quotes.length === 1 && added.quotes[0].src.includes("Side chat · HANDOFF.md") && added.quotes[0].text.length > 0, added.quotes);
  check("nothing was sent to the conversation", added.mainAsks === asksBefore && !(await ui.eval(RUNNING)), { before: asksBefore, after: added.mainAsks });
  check("the keyboard is in the conversation's input", await ui.eval(`!!document.activeElement?.closest('${MAIN_INPUT}')`));

  // ---- Keep as comment: the answer stays on the passage ----
  await ui.click({ css: `${CARD} [data-part="side-chat-keep"]` });
  await ui.sleep(800);
  const kept = qa.states.kept = await ui.eval(`(() => { const body = document.querySelector(${JSON.stringify(BODY)}); const p = [...body.querySelectorAll('.md-block')].find(b => b.textContent.includes('Folio Reader 迁到本机')); const c = p.nextElementSibling; return { comment: !!c && c.classList.contains('dispatch-doc-comment'), head: c ? c.innerText.replace(/\\s+/g, ' ').trim() : '', button: (document.querySelector('${CARD} [data-part="side-chat-keep"]') || {}).innerText }; })()`);
  const litC = await ui.eval(LIGHT);
  check("Keep as comment: a comment under the passage, its words underlined", kept.comment && /^Comment/.test(kept.head) && !!litC.commented && litC.commented.includes("Folio Reader 迁到本机"), { kept, litC });
  await ui.click({ css: `${BODY} .dispatch-doc-comment-head` });
  await ui.sleep(400);
  const commentOpen = await ui.eval(`(() => { const c = document.querySelector('${BODY} .dispatch-doc-comment'); const b = c && c.querySelector('.dispatch-doc-comment-body'); return { open: !!c && c.classList.contains('open'), text: b ? b.innerText.trim() : '' }; })()`);
  check("a click on the comment opens the whole answer", commentOpen.open && commentOpen.text.length > 5, commentOpen);
  await ui.screenshot("05-added-and-kept-light");
  await ui.mark({ css: `${MAIN_INPUT} .dispatch-quote` }, { what: "Add to chat 放进原对话输入框的引用卡", where: "对话输入框里", how: "你决定发不发" });
  await ui.mark({ css: `${BODY} .dispatch-doc-comment` }, { what: "Keep as comment 留在那段话上的批注", where: "文档里那段话下面", how: "点开看全文，可删，可回到旁聊" });

  // ---- the title bar's session menu lists the side chat; × closes the card, the menu brings it back ----
  await ui.click({ css: ".dispatch-place" });
  await ui.sleep(700);
  const menu = qa.states.menu = await ui.eval(MENU_LABELS);
  check("the title bar's session menu has a Side chats group with this side chat, and no second Side Chats menu", menu.includes("Side chats") && menu.some(l => l.endsWith("· HANDOFF.md")) && !menu.includes("Side Chats"), menu);
  await ui.screenshot("06-title-menu");
  await ui.press("Escape");
  await ui.sleep(400);
  await ui.click({ css: `${CARD} [data-part="side-chat-close"]` });
  await ui.sleep(600);
  const closed = qa.states.closed = await read();
  check("× closes it: no card, no pill", !closed.card && !closed.pill, closed);
  check("after × the conversation is as it was: one column, its width, its input with the quote", closed.groups === 1 && near(closed.column[0], before.column[0]) && closed.quotes.length === 1, closed);
  const lit5 = await ui.eval(LIGHT);
  check("after × the passage is not lit", !lit5.soft && !lit5.strong, lit5);
  await ui.click({ css: ".dispatch-place" });
  await ui.sleep(700);
  const item = (await ui.eval(MENU_LABELS)).find(l => l.endsWith("· HANDOFF.md"));
  await ui.click({ text: item, exact: true, within: ".context-view" });
  await ui.sleep(1000);
  await ui.sleep(600);
  const again = qa.states.again = await read();
  qa.states.againRows = await ui.eval(ROWS_SHOWN);
  check("reopened, the card's list shows its messages inside the card (not an empty list)", qa.states.againRows.shown >= 2, qa.states.againRows);
  check("the menu's side chat opens the card again, with its answers", !!again.card && again.responses.at(-1) === reopened.responses.at(-1), { card: again.card, last: again.responses.at(-1) });

  // ---- a second side chat on another passage; the card's ⋯ switches between them, renames and deletes ----
  const step = await ui.eval(`(() => {
    const body = document.querySelector(${JSON.stringify(BODY)});
    const p = [...body.querySelectorAll('.md-block')].find(b => b.textContent.startsWith('第 1 步要做的事'));
    p.scrollIntoView({ block: 'start' }); // above the card, which covers the pane's bottom right
    const range = document.createRange(); range.selectNodeContents(p.querySelector('p') || p);
    const rects = [...range.getClientRects()].filter(r => r.width > 0);
    const a = rects[0], z = rects[rects.length - 1];
    return { line: Number(p.dataset.line), x1: a.left + 1, y1: a.top + a.height / 2, x2: z.right - 1, y2: z.top + z.height / 2 };
  })()`);
  await ui.mouse("mouseMoved", step.x1, step.y1);
  await ui.mouse("mousePressed", step.x1, step.y1, { button: "left", clickCount: 1 });
  for (let i = 1; i <= 8; i++) await ui.mouse("mouseMoved", step.x1 + (step.x2 - step.x1) * i / 8, step.y1 + (step.y2 - step.y1) * i / 8, { button: "left", buttons: 1 });
  await ui.mouse("mouseReleased", step.x2, step.y2, { button: "left", clickCount: 1 });
  await ui.sleep(600);
  await ui.waitFor({ css: ".dispatch-docs-ask textarea" }, { timeoutMs: 8000 });
  await ui.type(SECOND, { into: { css: ".dispatch-docs-ask textarea" } });
  await ui.press("Enter", { send: true });
  await until(ui, async () => { const s = await read(); return s.quote && s.quote.two === `HANDOFF.md · line ${step.line}` && s.acts; }, 300000, "the second side chat's answer", 1500);
  const second = qa.states.second = await read();
  check("a second Ask Question opens the card on the new passage (one card, the conversation still one column)", second.quote.one.startsWith("第 1 步要做的事") && second.groups === 1, { quote: second.quote, groups: second.groups });
  await ui.click({ css: `${CARD} [data-part="side-chat-more"]` });
  await ui.sleep(600);
  const cardMenu = qa.states.cardMenu = await ui.eval(MENU_LABELS);
  check("the card's ⋯: Rename…, Delete Side Chat, and the other side chat to switch to", cardMenu.includes("Rename…") && cardMenu.includes("Delete Side Chat") && cardMenu.includes("Other Side Chats") && cardMenu.some(l => l.endsWith("· HANDOFF.md")), cardMenu);
  await ui.screenshot("06b-card-menu");
  await ui.mark({ css: `${CARD} [data-part="side-chat-more"]` }, { what: "卡自己的 ⋯：改名、删除、换到这个会话的别的旁聊", where: "卡头右边", how: "点它" });
  const other = cardMenu.find(l => l.endsWith("· HANDOFF.md") && l.startsWith("In one short sentence"));
  await ui.click({ text: other, exact: true, within: ".context-view" });
  await ui.sleep(1200);
  const switched = qa.states.switched = await read();
  check("switching from the card's ⋯ shows the first side chat again, on its passage", !!switched.quote && switched.quote.two === `HANDOFF.md · line ${para.line}` && switched.responses.length > 0, switched.quote);
  // back to the second one from the title bar's menu, rename it, delete it
  await ui.click({ css: ".dispatch-place" });
  await ui.sleep(700);
  const secondItem = (await ui.eval(MENU_LABELS)).find(l => l.endsWith("· HANDOFF.md") && !l.startsWith("In one short sentence"));
  await ui.click({ text: secondItem, exact: true, within: ".context-view" });
  await ui.sleep(1200);
  await ui.click({ css: `${CARD} [data-part="side-chat-more"]` });
  await ui.sleep(500);
  await ui.click({ text: "Rename…", exact: true, within: ".context-view" });
  await ui.waitFor({ css: ".quick-input-widget input" }, { timeoutMs: 8000 });
  // the box comes with the old name selected: typing replaces it
  const sel = qa.states.renameSelected = await ui.eval(`(() => { const i = document.querySelector('.quick-input-widget input'); return { value: i.value, selected: i.selectionStart === 0 && i.selectionEnd === i.value.length && i.value.length > 0, focused: document.activeElement === i }; })()`);
  check("Rename… asks in a box with the old name selected", sel.selected && sel.focused, sel);
  await ui.type("Step one check");
  await ui.press("Enter");
  await ui.sleep(1500);
  await ui.click({ css: ".dispatch-place" });
  await ui.sleep(700);
  const renamed = qa.states.renamed = await ui.eval(MENU_LABELS);
  check("Rename… names the side chat: the title bar's menu says the new name", renamed.some(l => l.startsWith("Step one check")), renamed);
  await ui.press("Escape");
  await ui.sleep(300);
  await ui.click({ css: `${CARD} [data-part="side-chat-more"]` });
  await ui.sleep(500);
  await ui.click({ text: "Delete Side Chat", exact: true, within: ".context-view" });
  await ui.sleep(800);
  // the chat's own question before deleting (one question, not two)
  await ui.waitFor({ css: ".monaco-dialog-box" }, { timeoutMs: 8000 });
  qa.states.deleteAsk = await ui.eval(`document.querySelector('.monaco-dialog-box').innerText.replace(/\\s+/g, ' ').trim()`);
  await ui.click({ text: "Delete", exact: true, within: ".monaco-dialog-box" });
  await ui.sleep(800);
  check("deleting asks once", !(await ui.exists({ css: ".monaco-dialog-box" })), qa.states.deleteAsk);
  await ui.sleep(2000);
  const deleted = qa.states.deleted = await read();
  await ui.click({ css: ".dispatch-place" });
  await ui.sleep(700);
  const afterDelete = qa.states.afterDelete = await ui.eval(MENU_LABELS);
  check("Delete Side Chat closes its card and it is gone from the menu; the first one stays", !deleted.card && !afterDelete.some(l => l.startsWith("Step one check")) && afterDelete.some(l => l.startsWith("In one short sentence")), { card: deleted.card, menu: afterDelete });
  const first = afterDelete.find(l => l.startsWith("In one short sentence"));
  await ui.click({ text: first, exact: true, within: ".context-view" });
  await ui.sleep(1200);
  check("the first side chat opens again from the menu", !!(await read()).card);

  // ---- Ask Question on the conversation's own reply: the same card, not a second column ----
  const reply = await ui.eval(`(() => {
    const r = [...document.querySelectorAll('.session-view .interactive-response .value .rendered-markdown')].at(-1);
    const range = document.createRange(); range.selectNodeContents(r.querySelector('p') || r);
    const rects = [...range.getClientRects()].filter(x => x.width > 0);
    const a = rects[0], z = rects[rects.length - 1];
    return { x1: a.left + 1, y1: a.top + a.height / 2, x2: z.right - 1, y2: z.top + z.height / 2 };
  })()`);
  await ui.mouse("mouseMoved", reply.x1, reply.y1);
  await ui.mouse("mousePressed", reply.x1, reply.y1, { button: "left", clickCount: 1 });
  for (let i = 1; i <= 6; i++) await ui.mouse("mouseMoved", reply.x1 + (reply.x2 - reply.x1) * i / 6, reply.y1 + (reply.y2 - reply.y1) * i / 6, { button: "left", buttons: 1 });
  await ui.mouse("mouseReleased", reply.x2, reply.y2, { button: "left", clickCount: 1 });
  await ui.sleep(700);
  await ui.waitFor({ css: ".session-view .agent-feedback-input-widget textarea" }, { timeoutMs: 8000 });
  await ui.type(REPLY_Q, { into: { css: ".session-view .agent-feedback-input-widget textarea" } });
  await ui.press("Enter", { send: true });
  await until(ui, async () => { const s = await read(); return s.card && s.quote && s.quote.two === "In the conversation" && s.acts; }, 300000, "the answer of the side chat asked on the reply", 1500);
  const onReply = qa.states.onReply = await read();
  check("Ask Question on a reply opens the same card (the conversation still one column at its width), its quote says In the conversation", onReply.groups === 1 && near(onReply.column[0], before.column[0]) && onReply.quote.two === "In the conversation" && !!onReply.card, { quote: onReply.quote, column: onReply.column });
  check("a side chat asked on a reply has no Keep as comment (no passage in a document)", !(await ui.exists({ css: `${CARD} [data-part="side-chat-keep"]` })) && (await ui.exists({ css: `${CARD} [data-part="side-chat-add"]` })));
  await ui.screenshot("06c-asked-on-reply");
  await ui.mark({ css: `${CARD} .dsc-quote` }, { what: "在对话回复里选字问：同一张卡，引用卡写 In the conversation", where: "卡顶", how: "点它回到原对话那一轮" });

  // ---- dark ----
  await ui.setTheme("dark");
  await ui.sleep(800);
  await ui.mouse("mouseMoved", pane.x + 40, pane.y + 60);
  // Settings came over the window and went: the side pane was put away meanwhile
  qa.states.darkRows = await ui.eval(ROWS_SHOWN);
  qa.states.darkQuote = await ui.eval(`(() => { const q = document.querySelector('${MAIN_INPUT} .dispatch-quote'); const box = document.querySelector('${MAIN_INPUT} .chat-input-container'); if (!q || !box) return null; return { bg: getComputedStyle(q).backgroundColor, input: getComputedStyle(box).backgroundColor, border: getComputedStyle(q).borderTopColor, weight: getComputedStyle(q.querySelector('.dispatch-quote-text')).fontWeight }; })()`);
  check("dark: the quote card in the conversation's input is not darker than the input (--bg-2), its words 400", !!qa.states.darkQuote && qa.states.darkQuote.bg !== 'rgb(12, 10, 9)' && Number(qa.states.darkQuote.weight) === 400, qa.states.darkQuote);
  check("after Settings (the theme switch) the card's list still shows its messages", qa.states.darkRows.shown >= 2, qa.states.darkRows);
  await ui.screenshot("07-card-dark");
  await ui.mark({ css: CARD }, { what: "深色下的旁聊卡", where: "右栏右下角", how: "同浅色" });
  await ui.mark({ css: `${CARD} .dsc-quote` }, { what: "深色下的引用卡", where: "卡顶", how: "指上去文档那段亮" });
  await ui.click({ css: `${CARD} [data-part="side-chat-minimize"]` });
  await ui.sleep(600);
  await ui.screenshot("08-pill-dark");
  await ui.mark({ css: PILL }, { what: "深色下的胶囊", where: "右栏右下角", how: "点它展开" });
  await ui.click({ css: PILL });
  await ui.sleep(600);
  await ui.setTheme("light");
  await ui.sleep(600);

  // ---- a window 1100 wide: the card fills the side pane's width and stays inside it ----
  const size = await ui.eval(`({ w: innerWidth, h: innerHeight })`);
  qa.states.window = size;
  await ui.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 760, deviceScaleFactor: 0, mobile: false });
  await ui.eval("window.dispatchEvent(new Event('resize'))");
  await ui.sleep(1500);
  const narrow = qa.states.narrow = await read();
  qa.states.narrowRows = await ui.eval(ROWS_SHOWN);
  check("1100 wide: the card's list shows its messages at the new width", qa.states.narrowRows.shown >= 1, qa.states.narrowRows);
  const np = narrow.part;
  check("1100 wide: the card fills the side pane's width, 12 each side, and stays inside it", !!narrow.card && narrow.window === 1100 && near(narrow.card.x - np.x, 12) && near(np.r - narrow.card.r, 12) && near(np.b - narrow.card.b, 12), { card: narrow.card, pane: np });
  check("1100 wide: at most 58% of the pane's height (420 at most)", !!narrow.card && narrow.card.h <= Math.min(420, Math.round(np.h * 0.58)) + 1, { card: narrow.card, pane: np });
  check("1100 wide: the conversation is still one column", narrow.groups === 1, narrow.groups);
  await ui.screenshot("09-narrow-1100-light");
  await ui.mark({ css: CARD }, { what: "1100 宽窗口：卡撑满右栏宽", where: "右栏下半截", how: "同宽窗口" });
  await ui.setTheme("dark");
  await ui.sleep(800);
  await ui.screenshot("10-narrow-1100-dark");
  await ui.setTheme("light");
  await ui.cdp.send("Emulation.clearDeviceMetricsOverride");
  await ui.eval("window.dispatchEvent(new Event('resize'))");
  await ui.sleep(1200);

  // ---- closed at the end: the conversation is as it was ----
  await ui.click({ css: `${CARD} [data-part="side-chat-close"]` });
  await ui.sleep(600);
  const end = qa.states.end = await read();
  check("at the end, closed: one column at its width, no card", !end.card && end.groups === 1 && near(end.column[0], before.column[0]), end);

  if (qa.failed.length) throw new Error(`${qa.failed.length} check(s) failed: ${qa.failed.join(" | ").slice(0, 1500)}`);
}
