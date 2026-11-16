// A side chat opens in a pane under the side pane's tab (direction B「Split pane」, user 2026-11-16, task-5im8n,
// design/side-chat-now; before it a card in the corner, task-23iin), not in a second narrow column beside the
// conversation, and over nothing: the tab's content is laid out shorter by the pane's height. A real session answers
// once; a document opens in the side pane's Docs reader; a paragraph is dragged over with the mouse, Ask Question is
// typed into and sent; the pane's answer comes. Then, as a person would: the pointer on the pane's quote lights the
// passage, a click on it scrolls the document back; a follow-up is sent in the pane and the pane is folded to its
// head with a click on it while it answers (the head says Answering, then 1 new answer in 500), another click opens
// it; Add to chat puts the answer into the conversation's input as a quote card (not sent); Keep as comment leaves it
// on the passage; the title bar's session menu lists the side chat; × closes it and the menu brings it back; a second
// side chat, switched to and back from the head's ⋯, renamed and deleted; Ask Question on the conversation's own reply
// opens the same pane. Light and dark, and a window 1100 wide where the pane keeps the old card's height. Sizes and
// places are read from the page into qa.json. Dragging the line, double-clicking it, Now's one line and the pinned
// question are side-chat-split.mjs.
//
// The engine is Codex on the instance's cheap test model (ide_e2e.CODEX_TEST_MODEL, low effort): side chats need an
// engine that branches a chat (multipleChats.sideChat), which only Claude and Codex advertise; OpenCode does not, and
// tests never open Claude Code sessions (CLAUDE.md). The side chat is part of the session, so the session is Codex too.
export const meta = { needs: ['codex'], instance: { motion: true },
  title: "旁聊开在右栏页签下面的一格里",
  description: "Docs 里选一段字点 Ask Question：旁聊是右栏页签下面的一格（占满右栏宽、贴底、默认占页签下面的 55%），上面的文档或 Now 变矮、不被盖；原对话还是整列一栏；格头 28 高、⋯ × 指上去才出现；引用卡在消息最上面，指上去文档那段亮、点它文档滚回那段；点格头收起成一条头，回答到了写 1 new answer 字变 500，再点展开；Add to chat 进原对话输入框成引用卡不发送；Keep as comment 留成那段话上的批注；标题栏会话菜单列出旁聊，× 关掉后从那里打开；第二个旁聊用格头的 ⋯ 切换、改名、删除；回复里选字问也开同一格；1100 宽窗口下格高照旧卡的高度；浅色深色各截图；圆角按 VS Code 方圆角（输入框 8、气泡 6、按钮 4）。",
  timeout: 2400,
};

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { until, offscreen, onDemo, toDemo, focusInput, closeTips } from "./session-now.mjs";

const run = promisify(execFile);
/** The instance's own dispatch CLI in the instance's environment. */
export async function cli(ui, ...args) {
  const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; env=dict(E.instance_env(r)); os.execve(sys.executable,[sys.executable,r['cli'],*sys.argv[2:]],env)";
  const r = await run("python3", ["-c", bootstrap, JSON.stringify(ui.rec), ...args], { env: process.env, maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
  return r.stdout;
}

const FIRST = "Reply with one short sentence saying you are ready. Do not use any tools.";
const QUESTION = "In one short sentence, what is still left to do in this passage? Do not use any tools.";
const FOLLOW = "Now say it in at most eight words. Do not use any tools.";
const SECOND = "Reply with the single word OK. Do not use any tools.";
const REPLY_Q = "Is this a full sentence? Answer yes or no. Do not use any tools.";
export const PASSAGE = "任务：Folio Reader 迁到本机并对照 Folioread 补齐功能。上一个会话把导入和搜索基本做完、请 designer 出了阅读页的设计；阅读页还没按新设计改，书签、夜间模式、导出、快捷键、打包也还没做。";
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

export const PANE = ".dispatch-side-chat-pane";
const MAIN_INPUT = ".session-view .interactive-input-part";

/** Where things are and how big, read from the page (CSS px). */
export const STATE = `(() => {
  const box = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) }; };
  const shown = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && Number(getComputedStyle(e).opacity) > 0.5;
  const visible = e => !!e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
  const view = document.querySelector('.session-view.is-active') || document.querySelector('.session-view');
  const groups = view ? [...view.querySelectorAll('.chat-group-view')].filter(g => g.getBoundingClientRect().width > 0) : [];
  const pane = document.querySelector('${PANE}');
  const open = !!pane && !pane.classList.contains('hidden') && visible(pane);
  const part = pane ? pane.parentElement : [...document.querySelectorAll('.part.editor')].find(e => e.getBoundingClientRect().width > 0);
  const group = part && [...part.querySelectorAll('.editor-group-container')].find(visible);
  const title = group && group.querySelector(':scope > .title');
  const editor = group && group.querySelector(':scope > .editor-container');
  const aux = part && [...part.querySelectorAll('.docked-auxiliarybar')].find(e => visible(e) && getComputedStyle(e).display !== 'none');
  const head = pane && pane.querySelector('.dsc-head');
  const btn = p => { const e = pane && pane.querySelector('[data-part="side-chat-' + p + '"]'); return e ? { inHead: !!head && head.contains(e), opacity: Number(getComputedStyle(e).opacity) } : null; };
  const q = pane && pane.querySelector('.dsc-quote');
  const badge = pane && pane.querySelector('.dsc-badge');
  const acts = pane && pane.querySelector('.dsc-acts');
  const sash = pane && pane.querySelector(':scope > .monaco-sash');
  const now = document.querySelector('.dispatch-now-tab');
  // a reply's words, without its footer (time, how long it took, the model)
  const responses = pane ? [...pane.querySelectorAll('.interactive-response')].map(r => ((r.querySelector('.value') || r).innerText || '').trim()).filter(Boolean) : [];
  const mainAsks = view ? [...view.querySelectorAll('.interactive-list .monaco-list-row.request')].length : 0;
  const quotes = [...document.querySelectorAll('${MAIN_INPUT} .dispatch-quote')].map(e => ({ text: (e.querySelector('.dispatch-quote-text') || {}).textContent || '', src: (e.querySelector('.dispatch-quote-src') || {}).textContent || '' }));
  const left = s => { const e = pane && pane.querySelector(s); return e && visible(e) ? Math.round(e.getBoundingClientRect().left - pane.getBoundingClientRect().left) : null; };
  return {
    window: innerWidth,
    groups: groups.length, column: groups.map(g => Math.round(g.getBoundingClientRect().width)),
    part: box(part), group: box(group), tabs: box(title), editor: box(editor), aux: aux ? box(aux) : null,
    pane: open ? box(pane) : null, folded: !!pane && pane.classList.contains('folded'), top: pane ? Number(pane.dataset.top) : null,
    look: pane ? { radius: getComputedStyle(pane).borderTopLeftRadius, shadow: getComputedStyle(pane).boxShadow, line: getComputedStyle(pane).borderTopWidth } : null,
    sash: sash ? { box: box(sash), cls: sash.className } : null,
    head: head ? { h: Math.round(head.getBoundingClientRect().height), text: head.innerText.replace(/\\s+/g, ' ').trim(), more: btn('more'), close: btn('close'), minimize: btn('minimize'), expanded: head.getAttribute('aria-expanded') } : null,
    badge: badge ? { text: badge.textContent, shown: visible(badge), weight: getComputedStyle(badge).fontWeight, answering: badge.classList.contains('answering') } : null,
    quote: q ? { box: box(q), one: (q.querySelector('.dsc-quote-1') || {}).textContent || '', two: (q.querySelector('.dsc-quote-2') || {}).textContent || '', radius: getComputedStyle(q).borderTopLeftRadius, inRows: !!q.closest('.monaco-list-rows') } : null,
    acts: !!acts && acts.classList.contains('on') && shown(acts), responses, mainAsks, quotes,
    now: now ? { oneLine: now.classList.contains('one-line'), h: Math.round(now.getBoundingClientRect().height), shown: visible(now) } : null,
    columnHeads: view ? [...view.querySelectorAll('.chat-composite-bar-header')].filter(e => e.getClientRects().length).length : 0,
    inside: open ? {
      input: box(pane.querySelector('.interactive-input-part')),
      acts: acts && acts.classList.contains('on') ? box(acts) : null,
      actButtons: (() => { const e = pane.querySelector('.dsc-acts.on .dispatch-side-chat-act'); return e ? Math.round(e.getBoundingClientRect().bottom) : null; })(),
      actRadius: (() => { const e = pane.querySelector('.dispatch-side-chat-act'); return e ? getComputedStyle(e).borderTopLeftRadius : ''; })(),
      origins: [...pane.querySelectorAll('.chat-request-origin')].filter(e => e.getClientRects().length).length,
      wide: [...pane.querySelectorAll('*')].filter(e => !e.closest('.monaco-editor') && !e.closest('.monaco-sash') && !e.classList.contains('shadow')).filter(e => { const b = e.getBoundingClientRect(); const c = pane.getBoundingClientRect(); return b.width > 0 && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && (b.right > c.right + 1 || b.left < c.left - 1); }).map(e => e.className && String(e.className).slice(0, 60)).slice(0, 5),
      inputBox: box(pane.querySelector('.interactive-input-part .chat-input-container')),
      inputRadius: (() => { const e = pane.querySelector('.interactive-input-part .chat-input-container'); return e ? getComputedStyle(e).borderTopLeftRadius : ''; })(),
      bubble: (() => { const b = pane.querySelector('.monaco-list-row:not(.monaco-tree-sticky-row) .interactive-request .value .rendered-markdown'); if (!b) return null; const cs = getComputedStyle(b); return { radius: cs.borderTopLeftRadius, pad: cs.paddingTop + ' ' + cs.paddingLeft, w: Math.round(b.getBoundingClientRect().width), row: Math.round(b.closest('.interactive-item-container').getBoundingClientRect().width), y: Math.round(b.getBoundingClientRect().top) }; })(),
      model: (() => { const m = pane.querySelector('.interactive-input-part .model-picker-split'); if (!m) return null; return { text: m.innerText.trim(), cut: [...m.querySelectorAll('*')].concat([m]).some(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow === 'ellipsis') }; })(),
      shownBits: { engine: !!pane.querySelector('.dispatch-harness-picker-item') && pane.querySelector('.dispatch-harness-picker-item').getClientRects().length > 0, status: [...pane.querySelectorAll('.chat-secondary-toolbar')].some(e => e.getClientRects().length > 0), answerIcons: [...pane.querySelectorAll('.chat-footer-toolbar')].some(e => e.getClientRects().length > 0) },
      lefts: { head: left('.dsc-head .dsc-car'), quote: left('.dsc-quote'), answer: left('.monaco-list-row:not(.monaco-tree-sticky-row) .interactive-response .value .rendered-markdown'), input: left('.interactive-input-part .chat-input-container') },
    } : null,
  };
})()`;

export const LIGHT = `(() => { const h = CSS.highlights; const t = n => { const x = h && h.get(n); return x ? [...x].map(r => r.toString()).join(' | ') : null; }; return { soft: t('dispatch-side-chat-soft'), strong: t('dispatch-side-chat-strong'), commented: t('dispatch-doc-commented') }; })()`;

/** How many of the pane's messages are drawn inside the list's visible box, with words in them. */
export const ROWS_SHOWN = `(() => { const pane = document.querySelector('${PANE}'); const list = pane && pane.querySelector('.interactive-list'); if (!list) return { shown: 0 }; const L = list.getBoundingClientRect(); const sc = list.querySelector('.monaco-scrollable-element'); const rc = list.querySelector('.monaco-list-rows'); const rows = [...pane.querySelectorAll('.monaco-list-row:not(.monaco-tree-sticky-row) .interactive-item-container')].map(e => { const b = e.getBoundingClientRect(); const v = e.querySelector('.value'); return { top: Math.round(b.top - L.top), bottom: Math.round(b.bottom - L.top), left: Math.round(b.left - L.left), w: Math.round(b.width), words: v ? v.innerText.trim().length : 0 }; }); return { list: [Math.round(L.width), Math.round(L.height)], scroll: sc ? [sc.scrollTop, rc ? Math.round(rc.getBoundingClientRect().height) : 0, rc ? rc.style.top : ''] : null, listRows: list.querySelectorAll('.monaco-list-row').length, rows, shown: rows.filter(r => r.bottom > 0 && r.top < L.height && r.left >= -1 && r.w > L.width * 0.8 && r.words > 0).length }; })()`;

export const MENU_LABELS = `(() => { const all = (root, out) => { root.querySelectorAll('.context-view .action-menu-item .action-label, .monaco-menu .action-menu-item .action-label').forEach(e => out.push(e)); root.querySelectorAll('*').forEach(e => e.shadowRoot && all(e.shadowRoot, out)); return out; }; return [...new Set(all(document, []).filter(e => e.getClientRects().length).map(e => e.textContent.trim()).filter(Boolean))]; })()`;

/** The pane's default height with its line, as dispatchSideChatModel.ts's defaultPaneHeight. */
export const defaultPane = (room, windowWidth) => windowWidth <= 1200 ? Math.min(420, Math.round(room * 0.58)) + 1 : room - Math.round(room * 0.45);

/** Moves the pointer onto an element the way a hand does, in a few steps from just left of it (one jump to its middle
 *  does not always count as entering it in the test window). */
export async function pointTo(ui, css) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const b = await ui.eval(`(() => { const e = document.querySelector(${JSON.stringify(css)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left }; })()`);
    if (!b) throw new Error(`nothing to point at: ${css}`);
    for (let i = 0; i <= 5; i++) {
      await ui.mouse("mouseMoved", b.l - 20 - attempt * 3 + (b.x - b.l + 20 + attempt * 3) * i / 5, b.y + attempt);
      await ui.sleep(40);
    }
    await ui.sleep(300);
    if (await ui.eval(`!!document.querySelector(${JSON.stringify(css)})?.matches(':hover')`)) return true;
  }
  return false;
}

export function checker(ui) {
  const qa = { checks: [], failed: [], states: {} };
  const note = () => fs.writeFileSync(path.join(ui.out, "qa.json"), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
    console.error(`${ok ? "ok" : "FAILED"}: ${name}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400)}`);
    note();
  };
  return { qa, check };
}

export const RUNNING = `!!document.querySelector('.session-view .interactive-input-part .chat-execute-toolbar .codicon-stop-circle')`;

/** A real Codex session that has answered once, and HANDOFF.md open in the side pane's Docs reader; returns its body's selector. */
export async function prepare(ui, qa) {
  const lastMain = () => ui.eval(`(() => { const r = [...document.querySelectorAll('.session-view .interactive-response')].at(-1); return r ? r.innerText.trim() : ''; })()`);
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
  const file = path.join(ui.demoFolder, "docs", "HANDOFF.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, DOC + "\n");
  await cli(ui, "ide", "show", file);
  const BODY = `.dispatch-docs-md[data-path=${JSON.stringify(file)}]`;
  await ui.waitFor({ css: BODY }, { timeoutMs: 30000 });
  await ui.sleep(800);
  return BODY;
}

/** Drags over a block of the document with the mouse, as a person selects it, and asks about it in the box that comes. */
export async function askOnBlock(ui, BODY, startsWith, question, scroll = "center") {
  const at = await ui.eval(`(() => {
    const body = document.querySelector(${JSON.stringify(BODY)});
    const p = [...body.querySelectorAll('.md-block')].find(b => b.textContent.includes(${JSON.stringify(startsWith)}));
    p.scrollIntoView({ block: ${JSON.stringify(scroll)} });
    const range = document.createRange(); range.selectNodeContents(p.querySelector('p') || p);
    const rects = [...range.getClientRects()].filter(r => r.width > 0);
    const a = rects[0], z = rects[rects.length - 1];
    return { line: Number(p.dataset.line), x1: a.left + 1, y1: a.top + a.height / 2, x2: z.right - 1, y2: z.top + z.height / 2 };
  })()`);
  await ui.mouse("mouseMoved", at.x1, at.y1);
  await ui.mouse("mousePressed", at.x1, at.y1, { button: "left", clickCount: 1 });
  for (let i = 1; i <= 8; i++) await ui.mouse("mouseMoved", at.x1 + (at.x2 - at.x1) * i / 8, at.y1 + (at.y2 - at.y1) * i / 8, { button: "left", buttons: 1 });
  await ui.mouse("mouseReleased", at.x2, at.y2, { button: "left", clickCount: 1 });
  await ui.sleep(600);
  at.selected = await ui.eval(`getSelection().toString()`);
  await ui.waitFor({ css: ".dispatch-docs-ask textarea" }, { timeoutMs: 8000 });
  if (question) {
    await ui.type(question, { into: { css: ".dispatch-docs-ask textarea" } });
    await ui.press("Enter", { send: true });
  }
  return at;
}

export default async function (ui) {
  const { qa, check } = checker(ui);
  const read = () => ui.eval(STATE);
  const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

  // ---- a real session that has answered once (Ask Question needs a reply to branch from), a document ----
  const BODY = await prepare(ui, qa);
  const before = qa.states.before = await read();
  check("before: the conversation is one column", before.groups === 1, before);
  check("before: no side chat, the document has the side pane's whole height under its tabs", !before.pane && !!before.editor && !!before.group && near(before.editor.b, before.group.b, 2), { editor: before.editor, group: before.group });

  // ---- drag over the paragraph with the mouse, as a person selects it; the Ask Question box comes ----
  const para = await askOnBlock(ui, BODY, "Folio Reader 迁到本机", "");
  check("the drag selected the paragraph's words", para.selected.includes("Folio Reader 迁到本机") && para.selected.includes("打包也还没做"), para.selected);
  await ui.screenshot("01-ask-question");
  await ui.mark({ css: ".dispatch-docs-ask" }, { what: "选中文字后浮出的 Ask Question 框", where: "Docs 阅读页，选中的那段下面", how: "打问题，回车" });

  // ---- Ask Question: typed, Enter; the pane comes and the answer is written in it ----
  await ui.type(QUESTION, { into: { css: ".dispatch-docs-ask textarea" } });
  await ui.press("Enter", { send: true });
  await ui.waitFor({ css: `${PANE}:not(.hidden)` }, { timeoutMs: 30000 });
  await until(ui, async () => (await read()).acts, 300000, "the side chat's answer", 1500);
  await ui.sleep(1200);
  const open = qa.states.open = await read();
  const room = open.top + (open.pane ? open.pane.h : 0);
  check("the conversation keeps its whole column: one column, the same width as before", open.groups === 1 && near(open.column[0], before.column[0]), { before: before.column, after: open.column });
  check("no title row over the conversation with a ⋯ of its own", open.columnHeads === 0, open.columnHeads);
  check("the pane spans the side pane's width at its bottom", !!open.pane && near(open.pane.x, open.group.x) && near(open.pane.w, open.group.w) && near(open.pane.b, open.group.b), { pane: open.pane, group: open.group });
  check("by default the pane has 55% of the room under the tabs (its line included)", !!open.pane && near(open.pane.h, defaultPane(room, open.window), 1), { pane: open.pane && open.pane.h, room, want: defaultPane(room, open.window) });
  check("nothing is covered: the document ends where the pane begins", !!open.editor && open.editor.b <= open.pane.y + 1 && open.editor.y >= open.tabs.b - 1, { editor: open.editor, pane: open.pane });
  check("the docked file list (when shown) ends there too", !open.aux || open.aux.b <= open.pane.y + 1, { aux: open.aux, pane: open.pane });
  check("the pane floats over nothing: no corner, no shadow, a 1px line on top", open.look.radius === "0px" && open.look.shadow === "none" && open.look.line === "1px", open.look);
  check("the line is VS Code's sash, on the pane's top edge", !!open.sash && near(open.sash.box.y + open.sash.box.h / 2, open.pane.y, 2) && near(open.sash.box.w, open.pane.w, 1), { sash: open.sash, pane: open.pane });
  check("the head is 28 high and says Side chat · from the session", open.head.h === 28 && /^Side chat · from /.test(open.head.text), open.head);
  check("the head's ⋯ and × are in it, hidden until the pointer is on the head; no – (a click on the head folds)", !!open.head.more && open.head.more.inHead && !!open.head.close && open.head.close.inHead && open.head.more.opacity < 0.1 && !open.head.minimize, open.head);
  check("at the top of the messages a quote of the passage: its words and HANDOFF.md · line N, scrolling with them", !!open.quote && open.quote.inRows && open.quote.one.startsWith("任务：Folio Reader") && open.quote.two === `HANDOFF.md · line ${para.line}` && open.quote.radius === "6px", open.quote);
  check("the answer is in the pane", open.responses.length >= 1 && open.responses.at(-1).length > 5, open.responses);
  check("the side chat's own input is at the pane's bottom, inside it", !!open.inside.input && open.inside.input.b <= open.pane.b && open.inside.input.b >= open.pane.b - 24, { input: open.inside.input, pane: open.pane });
  check("the answer's actions sit 8 over the input box on the pane's ground from edge to edge, buttons 4 round", !!open.inside.acts && !!open.inside.inputBox && near(open.inside.inputBox.y - open.inside.actButtons, 8, 2) && near(open.inside.acts.b, open.inside.inputBox.y, 1) && near(open.inside.acts.w, open.pane.w, 1) && open.inside.actRadius === "4px", { acts: open.inside.acts, buttons: open.inside.actButtons, inputBox: open.inside.inputBox, radius: open.inside.actRadius });
  check("everything starts 20 in from the side pane's edge, under Now's state mark (head chevron, quote, answer, input)", Object.values(open.inside.lefts).every(v => v !== null && v >= 19 && v <= 22), open.inside.lefts);
  check("the quote sits over the first message, 12 above its bubble at least, not on it", !!open.quote && !!open.inside.bubble && open.quote.box.b + 12 <= open.inside.bubble.y + 1, { quote: open.quote && open.quote.box, bubble: open.inside.bubble });
  check("the person's words are a bubble 6 round, at most 80% of the row", !!open.inside.bubble && open.inside.bubble.radius === "6px" && open.inside.bubble.w <= Math.ceil(open.inside.bubble.row * 0.8), open.inside.bubble);
  check("the pane's input box is 8 round", open.inside.inputRadius === "8px", open.inside.inputRadius);
  check("no engine switch, no status row under the input and no icon row under the answer in the pane", !open.inside.shownBits.engine && !open.inside.shownBits.status && !open.inside.shownBits.answerIcons, open.inside.shownBits);
  check("the model's name is whole in the pane's input", !!open.inside.model && !open.inside.model.cut, open.inside.model);
  check("the pane's input starts one line high (not two)", !!open.inside.inputBox && open.inside.inputBox.h <= 110, open.inside.inputBox);
  check("the chat's own from-row is not shown again under the quote", open.inside.origins === 0, open.inside.origins);
  check("nothing in the pane sticks out of it sideways", open.inside.wide.length === 0, open.inside.wide);
  check("Add to chat, Keep as comment and Copy are there once the answer is in", open.acts && await ui.eval(`['add','keep','copy'].every(p => !!document.querySelector('${PANE} [data-part="side-chat-' + p + '"]'))`));
  const lit0 = qa.states.lit0 = await ui.eval(LIGHT);
  check("while the pane is open the passage is lit softly", !!lit0.soft && lit0.soft.includes("Folio Reader 迁到本机") && !lit0.strong, lit0);
  const part = open.part;
  await ui.mouse("mouseMoved", part.x + 40, part.y + 60);
  await ui.sleep(400);
  await ui.screenshot("02-pane-light");
  await ui.mark({ css: PANE }, { what: "旁聊：右栏页签下面的一格，占满右栏宽，上面的文档变矮、不被盖", where: "右栏下半", how: "拖中间那条线调高低，双击回默认；点格头收起" });
  await pointTo(ui, `${PANE} .dsc-head .dsc-from`);
  const hovered = qa.states.headHover = await read();
  check("the pointer on the head shows its ⋯ and ×", hovered.head.more.opacity > 0.9 && hovered.head.close.opacity > 0.9, hovered.head);
  await ui.mark({ css: `${PANE} .dsc-head` }, { what: "格头：Side chat · from 会话名，指上去出现 ⋯ 和 ×", where: "下格顶上", how: "点它收起；⋯ 改名、删除、换别的旁聊；× 关掉" });

  // ---- the quote: the pointer on it lights the passage fully; a click scrolls the document back to it ----
  await pointTo(ui, `${PANE} .dsc-quote`);
  const lit1 = qa.states.lit1 = await ui.eval(LIGHT);
  qa.states.underPointer = await ui.eval(`(() => { const q = document.querySelector('${PANE} .dsc-quote').getBoundingClientRect(); const e = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return { cls: e ? String(e.className).slice(0, 80) : null, inQuote: !!e && !!e.closest('.dsc-quote'), q: [Math.round(q.top), Math.round(q.height)] }; })()`);
  check("the pointer on the quote lights the passage fully (its own words)", !!lit1.strong && lit1.strong.includes("Folio Reader 迁到本机") && lit1.strong.includes("打包也还没做"), lit1);
  await ui.screenshot("03-quote-hover");
  await ui.mouse("mouseMoved", part.x + 40, part.y + 60);
  await ui.sleep(300);
  const lit2 = await ui.eval(LIGHT);
  check("off the quote it is soft again", !!lit2.soft && !lit2.strong, lit2);
  const inView = `(() => { const body = document.querySelector(${JSON.stringify(BODY)}); const s = body.closest('.dispatch-docs-reader-scroll'); const p = [...body.querySelectorAll('.md-block')].find(b => b.textContent.includes('Folio Reader 迁到本机')); const a = s.getBoundingClientRect(), b = p.getBoundingClientRect(); return { top: Math.round(s.scrollTop), inView: b.top >= a.top && b.bottom <= a.bottom }; })()`;
  await ui.eval(`(() => { const s = document.querySelector(${JSON.stringify(BODY)}).closest('.dispatch-docs-reader-scroll'); s.scrollTop = s.scrollHeight; })()`);
  await ui.sleep(500);
  const away = await ui.eval(inView);
  check("scrolled to the end of the document, the passage is out of view", !away.inView && away.top > 200, away);
  const quoteBefore = (await read()).quote;
  await ui.click({ css: `${PANE} .dsc-quote` }, { settleMs: 100 });
  await ui.sleep(300);
  const lit3 = await ui.eval(LIGHT);
  await ui.sleep(700);
  const back = qa.states.back = await ui.eval(inView);
  qa.states.quoteAfterClick = { before: quoteBefore && quoteBefore.box, after: (await read()).quote?.box };
  check("a click on the quote scrolls the document back to the passage (in the half over the pane) and lights it", back.inView && !!lit3.strong, { back, lit3 });
  await ui.mouse("mouseMoved", part.x + 40, part.y + 60);
  await ui.sleep(2000);
  const lit4 = await ui.eval(LIGHT);
  check("a moment later it is lit softly again", !!lit4.soft && !lit4.strong, lit4);

  // ---- a follow-up in the pane; folded with a click on its head while it answers ----
  const firstSide = open.responses.at(-1);
  await focusInput(ui, `${PANE} .interactive-input-part`);
  await ui.type(FOLLOW);
  await ui.press("Enter", { send: true });
  await ui.sleep(300);
  await ui.click({ css: `${PANE} .dsc-head .dsc-t` });
  await ui.sleep(500);
  const folded = qa.states.folded = await read();
  check("a click on the head folds the pane: only its head is left, 28 and its line, at the side pane's bottom", folded.folded && !!folded.pane && folded.pane.h === 29 && near(folded.pane.b, folded.group.b) && folded.head.expanded === "false", { pane: folded.pane, folded: folded.folded });
  check("folded: the document has the room back, down to the head", !!folded.editor && near(folded.editor.b, folded.pane.y, 2), { editor: folded.editor, pane: folded.pane });
  const seen = [];
  await until(ui, async () => { const s = await read(); if (s.badge) seen.push(`${s.badge.text}/${s.badge.weight}`); return s.badge && /new answer/.test(s.badge.text); }, 300000, "the follow-up's answer, while folded", 500);
  const unread = qa.states.unread = await read();
  qa.states.badgeTexts = [...new Set(seen)];
  check("folded, the head says · Answering while it writes, then · 1 new answer in 500, no from", unread.badge.text === "· 1 new answer" && Number(unread.badge.weight) === 500 && unread.badge.shown && !/from/.test(unread.head.text), { seen: qa.states.badgeTexts, head: unread.head.text });
  check("while folded the passage is not lit", !(await ui.eval(LIGHT)).soft);
  await ui.screenshot("04-folded-light");
  await ui.mark({ css: `${PANE} .dsc-head` }, { what: "收起的旁聊：右栏底部只剩一条格头，回答到了写 1 new answer 字变粗", where: "右栏最下面", how: "点它展开" });
  await ui.click({ css: `${PANE} .dsc-head .dsc-t` });
  await ui.sleep(700);
  const reopened = qa.states.reopened = await read();
  qa.states.reopenedRows = await ui.eval(ROWS_SHOWN);
  check("opened again from its head: the same height as before, its messages drawn", !!reopened.pane && near(reopened.pane.h, open.pane.h, 1) && qa.states.reopenedRows.shown >= 1, { pane: reopened.pane, rows: qa.states.reopenedRows });
  check("the follow-up answered in it", reopened.responses.length > 0 && reopened.responses.at(-1) !== firstSide, reopened.responses);

  // ---- Add to chat: a quote card in the conversation's input, nothing sent ----
  const asksBefore = reopened.mainAsks;
  await ui.click({ css: `${PANE} [data-part="side-chat-add"]` });
  await ui.sleep(800);
  const added = qa.states.added = await read();
  check("Add to chat: the conversation's input has the answer as a quote card from the side chat", added.quotes.length === 1 && added.quotes[0].src.includes("Side chat · HANDOFF.md") && added.quotes[0].text.length > 0, added.quotes);
  check("nothing was sent to the conversation", added.mainAsks === asksBefore && !(await ui.eval(RUNNING)), { before: asksBefore, after: added.mainAsks });
  check("the keyboard is in the conversation's input", await ui.eval(`!!document.activeElement?.closest('${MAIN_INPUT}')`));

  // ---- Keep as comment: the answer stays on the passage ----
  await ui.click({ css: `${PANE} [data-part="side-chat-keep"]` });
  await ui.sleep(800);
  const kept = qa.states.kept = await ui.eval(`(() => { const body = document.querySelector(${JSON.stringify(BODY)}); const p = [...body.querySelectorAll('.md-block')].find(b => b.textContent.includes('Folio Reader 迁到本机')); const c = p.nextElementSibling; return { comment: !!c && c.classList.contains('dispatch-doc-comment'), head: c ? c.innerText.replace(/\\s+/g, ' ').trim() : '', button: (document.querySelector('${PANE} [data-part="side-chat-keep"]') || {}).innerText }; })()`);
  const litC = await ui.eval(LIGHT);
  check("Keep as comment: a comment under the passage, its words underlined", kept.comment && /^Comment/.test(kept.head) && !!litC.commented && litC.commented.includes("Folio Reader 迁到本机"), { kept, litC });
  await ui.eval(`document.querySelector(${JSON.stringify(BODY)}).querySelector('.dispatch-doc-comment').scrollIntoView({ block: 'center' })`);
  await ui.sleep(300);
  await ui.click({ css: `${BODY} .dispatch-doc-comment-head` });
  await ui.sleep(400);
  const commentOpen = await ui.eval(`(() => { const c = document.querySelector('${BODY} .dispatch-doc-comment'); const b = c && c.querySelector('.dispatch-doc-comment-body'); const car = c && c.querySelector('.dispatch-doc-comment-head .car'); return { open: !!c && c.classList.contains('open'), text: b ? b.innerText.trim() : '', caret: car ? getComputedStyle(car).transform : '' }; })()`);
  check("a click on the comment opens the whole answer", commentOpen.open && commentOpen.text.length > 5, commentOpen);
  await ui.screenshot("05-added-and-kept-light");
  await ui.mark({ css: `${MAIN_INPUT} .dispatch-quote` }, { what: "Add to chat 放进原对话输入框的引用卡", where: "对话输入框里", how: "你决定发不发" });
  await ui.mark({ css: `${BODY} .dispatch-doc-comment` }, { what: "Keep as comment 留在那段话上的批注", where: "文档里那段话下面", how: "点开看全文，可删，可回到旁聊" });

  // ---- the title bar's session menu lists the side chat; × closes the pane, the menu brings it back ----
  await ui.click({ css: ".dispatch-place" });
  await ui.sleep(700);
  const menu = qa.states.menu = await ui.eval(MENU_LABELS);
  check("the title bar's session menu has a Side chats group with this side chat, and no second Side Chats menu", menu.includes("Side chats") && menu.some(l => l.endsWith("· HANDOFF.md")) && !menu.includes("Side Chats"), menu);
  await ui.screenshot("06-title-menu");
  await ui.press("Escape");
  await ui.sleep(400);
  await pointTo(ui, `${PANE} .dsc-head .dsc-t`);
  await ui.click({ css: `${PANE} [data-part="side-chat-close"]` });
  await ui.sleep(600);
  const closed = qa.states.closed = await read();
  check("× closes it: no pane, the document has the whole height again", !closed.pane && !!closed.editor && near(closed.editor.b, closed.group.b, 2), { pane: closed.pane, editor: closed.editor, group: closed.group });
  check("after × the conversation is as it was: one column, its width, its input with the quote", closed.groups === 1 && near(closed.column[0], before.column[0]) && closed.quotes.length === 1, closed);
  const lit5 = await ui.eval(LIGHT);
  check("after × the passage is not lit", !lit5.soft && !lit5.strong, lit5);
  await ui.click({ css: ".dispatch-place" });
  await ui.sleep(700);
  const item = (await ui.eval(MENU_LABELS)).find(l => l.endsWith("· HANDOFF.md"));
  await ui.click({ text: item, exact: true, within: ".context-view" });
  await ui.sleep(1600);
  const again = qa.states.again = await read();
  qa.states.againRows = await ui.eval(ROWS_SHOWN);
  check("reopened, the pane's list shows its messages (not an empty list)", qa.states.againRows.shown >= 1, qa.states.againRows);
  check("the menu's side chat opens the pane again, with its answers", !!again.pane && again.responses.at(-1) === reopened.responses.at(-1), { pane: again.pane, last: again.responses.at(-1) });

  // ---- a second side chat on another passage; the head's ⋯ switches between them, renames and deletes ----
  const step = await askOnBlock(ui, BODY, "第 1 步要做的事", SECOND, "start");
  await until(ui, async () => { const s = await read(); return s.quote && s.quote.two === `HANDOFF.md · line ${step.line}` && s.acts; }, 300000, "the second side chat's answer", 1500);
  const second = qa.states.second = await read();
  check("a second Ask Question opens the pane on the new passage (one pane, the conversation still one column)", second.quote.one.startsWith("第 1 步要做的事") && second.groups === 1, { quote: second.quote, groups: second.groups });
  await pointTo(ui, `${PANE} .dsc-head .dsc-t`);
  await ui.click({ css: `${PANE} [data-part="side-chat-more"]` });
  await ui.sleep(600);
  const paneMenu = qa.states.paneMenu = await ui.eval(MENU_LABELS);
  check("the head's ⋯: Rename…, Delete Side Chat, and the other side chat to switch to", paneMenu.includes("Rename…") && paneMenu.includes("Delete Side Chat") && paneMenu.includes("Other Side Chats") && paneMenu.some(l => l.endsWith("· HANDOFF.md")), paneMenu);
  await ui.screenshot("06b-head-menu");
  await ui.mark({ css: `${PANE} [data-part="side-chat-more"]` }, { what: "格头自己的 ⋯：改名、删除、换到这个会话的别的旁聊", where: "格头右边，指上去才出现", how: "点它" });
  const other = paneMenu.find(l => l.endsWith("· HANDOFF.md") && l.startsWith("In one short sentence"));
  await ui.click({ text: other, exact: true, within: ".context-view" });
  await ui.sleep(1200);
  const switched = qa.states.switched = await read();
  check("switching from the head's ⋯ shows the first side chat again, on its passage", !!switched.quote && switched.quote.two === `HANDOFF.md · line ${para.line}` && switched.responses.length > 0, switched.quote);
  // back to the second one from the title bar's menu, rename it, delete it
  await ui.click({ css: ".dispatch-place" });
  await ui.sleep(700);
  const secondItem = (await ui.eval(MENU_LABELS)).find(l => l.endsWith("· HANDOFF.md") && !l.startsWith("In one short sentence"));
  await ui.click({ text: secondItem, exact: true, within: ".context-view" });
  await ui.sleep(1200);
  await pointTo(ui, `${PANE} .dsc-head .dsc-t`);
  await ui.click({ css: `${PANE} [data-part="side-chat-more"]` });
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
  await pointTo(ui, `${PANE} .dsc-head .dsc-t`);
  await ui.click({ css: `${PANE} [data-part="side-chat-more"]` });
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
  check("Delete Side Chat closes its pane and it is gone from the menu; the first one stays; the document has its room back", !deleted.pane && !afterDelete.some(l => l.startsWith("Step one check")) && afterDelete.some(l => l.startsWith("In one short sentence")) && near(deleted.editor.b, deleted.group.b, 2), { pane: deleted.pane, menu: afterDelete });
  const first = afterDelete.find(l => l.startsWith("In one short sentence"));
  await ui.click({ text: first, exact: true, within: ".context-view" });
  await ui.sleep(1200);
  check("the first side chat opens again from the menu", !!(await read()).pane);

  // ---- Ask Question on the conversation's own reply: the same pane, not a second column ----
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
  await until(ui, async () => { const s = await read(); return s.pane && s.quote && s.quote.two === "In the conversation" && s.acts; }, 300000, "the answer of the side chat asked on the reply", 1500);
  const onReply = qa.states.onReply = await read();
  check("Ask Question on a reply opens the same pane (the conversation still one column at its width), its quote says In the conversation", onReply.groups === 1 && near(onReply.column[0], before.column[0]) && onReply.quote.two === "In the conversation" && !!onReply.pane, { quote: onReply.quote, column: onReply.column });
  check("a side chat asked on a reply has no Keep as comment (no passage in a document)", !(await ui.exists({ css: `${PANE} [data-part="side-chat-keep"]` })) && (await ui.exists({ css: `${PANE} [data-part="side-chat-add"]` })));
  await ui.screenshot("06c-asked-on-reply");
  await ui.mark({ css: `${PANE} .dsc-quote` }, { what: "在对话回复里选字问：同一格，引用卡写 In the conversation", where: "下格消息最上面", how: "点它回到原对话那一轮" });

  // ---- dark ----
  await ui.setTheme("dark");
  await ui.sleep(800);
  await ui.mouse("mouseMoved", part.x + 40, part.y + 60);
  // Settings came over the window and went: the side pane was put away meanwhile
  qa.states.darkRows = await ui.eval(ROWS_SHOWN);
  qa.states.darkQuote = await ui.eval(`(() => { const q = document.querySelector('${MAIN_INPUT} .dispatch-quote'); const box = document.querySelector('${MAIN_INPUT} .chat-input-container'); if (!q || !box) return null; return { bg: getComputedStyle(q).backgroundColor, input: getComputedStyle(box).backgroundColor, border: getComputedStyle(q).borderTopColor, weight: getComputedStyle(q.querySelector('.dispatch-quote-text')).fontWeight }; })()`);
  check("dark: the quote card in the conversation's input is not darker than the input (--bg-2), its words 400", !!qa.states.darkQuote && qa.states.darkQuote.bg !== 'rgb(12, 10, 9)' && Number(qa.states.darkQuote.weight) === 400, qa.states.darkQuote);
  check("after Settings (the theme switch) the pane's list still shows its messages", qa.states.darkRows.shown >= 1, qa.states.darkRows);
  const dark = qa.states.dark = await read();
  check("after Settings the pane is where it was, the same height", !!dark.pane && near(dark.pane.h, onReply.pane.h, 1) && near(dark.pane.b, dark.group.b), { pane: dark.pane, before: onReply.pane });
  await ui.screenshot("07-pane-dark");
  await ui.mark({ css: PANE }, { what: "深色下的旁聊下格", where: "右栏下半", how: "同浅色" });
  await ui.click({ css: `${PANE} .dsc-head .dsc-t` });
  await ui.sleep(600);
  await ui.screenshot("08-folded-dark");
  await ui.mark({ css: `${PANE} .dsc-head` }, { what: "深色下收起的格头", where: "右栏最下面", how: "点它展开" });
  await ui.click({ css: `${PANE} .dsc-head .dsc-t` });
  await ui.sleep(600);
  await ui.setTheme("light");
  await ui.sleep(600);

  // ---- a window 1100 wide: the pane keeps the old card's height (58% of the room, 420 at most) ----
  qa.states.window = await ui.eval(`({ w: innerWidth, h: innerHeight })`);
  await ui.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 760, deviceScaleFactor: 0, mobile: false });
  await ui.eval("window.dispatchEvent(new Event('resize'))");
  await ui.sleep(1500);
  const narrow = qa.states.narrow = await read();
  qa.states.narrowRows = await ui.eval(ROWS_SHOWN);
  check("1100 wide: the pane's list shows its messages at the new width", qa.states.narrowRows.shown >= 1, qa.states.narrowRows);
  const nroom = narrow.top + (narrow.pane ? narrow.pane.h : 0);
  check("1100 wide: the pane spans the side pane's width at its bottom, 58% of the room (420 at most) and its line", !!narrow.pane && narrow.window === 1100 && near(narrow.pane.w, narrow.group.w) && near(narrow.pane.b, narrow.group.b) && near(narrow.pane.h, defaultPane(nroom, 1100), 1), { pane: narrow.pane, group: narrow.group, want: defaultPane(nroom, 1100) });
  check("1100 wide: the conversation is still one column", narrow.groups === 1, narrow.groups);
  await ui.screenshot("09-narrow-1100-light");
  await ui.mark({ css: PANE }, { what: "1100 宽窗口：下格高照旧卡的高度", where: "右栏下半", how: "同宽窗口" });
  await ui.setTheme("dark");
  await ui.sleep(800);
  await ui.screenshot("10-narrow-1100-dark");
  await ui.setTheme("light");
  await ui.cdp.send("Emulation.clearDeviceMetricsOverride");
  await ui.eval("window.dispatchEvent(new Event('resize'))");
  await ui.sleep(1200);

  // ---- closed at the end: the conversation and the document are as they were ----
  await pointTo(ui, `${PANE} .dsc-head .dsc-t`);
  await ui.click({ css: `${PANE} [data-part="side-chat-close"]` });
  await ui.sleep(600);
  const end = qa.states.end = await read();
  check("at the end, closed: one column at its width, no pane, the tab's content down to the bottom", !end.pane && end.groups === 1 && near(end.column[0], before.column[0]) && near(end.editor.b, end.group.b, 2), end);

  if (qa.failed.length) throw new Error(`${qa.failed.length} check(s) failed: ${qa.failed.join(" | ").slice(0, 1500)}`);
}
