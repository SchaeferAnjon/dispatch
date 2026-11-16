// The bar that comes over a selection in a reply (Quote, a small input, the send arrow) closes once what was typed in
// it is sent: the side chat opens in the side pane with the passage and the question, and the bar is gone, emptied,
// the selection with it (task-28mnh; before, the side chat opened and the bar stayed over the conversation with the
// question still in it, because it waited for the conversation's chat to change and a side chat in the side pane
// leaves it as it is). Sent once with Enter, once with a click on the arrow; read from the page every 100 ms.
//
// The engine is Codex on the instance's cheap test model, as side-chat-pane.mjs: only Claude and Codex branch a chat
// into a side chat, and tests never open Claude Code sessions.
export const meta = { needs: ['codex'],
  title: "回复里选字问一句：发出后引用条收起",
  description: "在对话回复里选一段字，浮出的引用条（Quote、小输入框、发送箭头）里写一句：回车发出，右栏 Side chat 打开、收到引用和这句话，引用条同时收起、输入清空、选区取消；再选一次，点发送箭头，一样。",
  timeout: 900,
};

import { until, offscreen, onDemo, toDemo, focusInput, closeTips } from "./session-now.mjs";
import { checker, PANE, RUNNING } from "./side-chat-pane.mjs";

const FIRST = "Reply with one short sentence saying you are ready. Do not use any tools.";
const BY_ENTER = "翻译成中文";
const BY_ARROW = "Is this a full sentence? Answer yes or no. Do not use any tools.";
const BAR = ".session-view .agent-feedback-input-widget";

/** The bar, the selection and the side chat pane, read at once. */
const NOW = `(() => {
  const bar = document.querySelector('${BAR}');
  const ta = bar && bar.querySelector('textarea');
  const pane = document.querySelector('${PANE}');
  const open = !!pane && !pane.classList.contains('hidden') && pane.getBoundingClientRect().height > 0;
  const asked = open ? [...pane.querySelectorAll('.monaco-list-row.request')].map(e => e.innerText.trim()) : [];
  const q = pane && pane.querySelector('.dsc-quote-2');
  const acts = pane && pane.querySelector('.dsc-acts');
  const reply = open ? [...pane.querySelectorAll('.interactive-response')].map(r => ((r.querySelector('.value') || r).innerText || '').trim()).filter(Boolean).at(-1) || '' : '';
  const a = document.activeElement;
  return {
    bar: !!bar && getComputedStyle(bar).display !== 'none' && bar.getBoundingClientRect().height > 0,
    typed: ta ? ta.value : null,
    busy: !!bar && !!bar.querySelector('.agent-feedback-input-busy-indicator') && getComputedStyle(bar.querySelector('.agent-feedback-input-busy-indicator')).display !== 'none',
    selection: getSelection().toString(),
    pane: open, asked, quoteFrom: q ? q.textContent : '', answered: !!acts && acts.classList.contains('on'), reply,
    focus: a ? (a.closest('${PANE}') ? 'side chat' : a.closest('${BAR}') ? 'bar' : a.closest('.session-view') ? 'conversation' : a.tagName) : null,
  };
})()`;

/** Drags over the last reply's first paragraph with the mouse, as a person selects it; the bar comes. */
async function selectReply(ui) {
  const at = await ui.eval(`(() => {
    const r = [...document.querySelectorAll('.session-view .interactive-response .value .rendered-markdown')].at(-1);
    const range = document.createRange(); range.selectNodeContents(r.querySelector('p') || r);
    const rects = [...range.getClientRects()].filter(x => x.width > 0);
    const a = rects[0], z = rects[rects.length - 1];
    return { x1: a.left + 1, y1: a.top + a.height / 2, x2: z.right - 1, y2: z.top + z.height / 2 };
  })()`);
  await ui.mouse("mouseMoved", at.x1, at.y1);
  await ui.mouse("mousePressed", at.x1, at.y1, { button: "left", clickCount: 1 });
  for (let i = 1; i <= 6; i++) await ui.mouse("mouseMoved", at.x1 + (at.x2 - at.x1) * i / 6, at.y1 + (at.y2 - at.y1) * i / 6, { button: "left", buttons: 1 });
  await ui.mouse("mouseReleased", at.x2, at.y2, { button: "left", clickCount: 1 });
  await ui.sleep(700);
  await ui.waitFor({ css: `${BAR} textarea` }, { timeoutMs: 8000 });
  return ui.eval(NOW);
}

/** After the send: every 100 ms until the pane has the question and the bar is gone (or 60 s), when each came. */
async function follow(ui, question) {
  const t0 = Date.now();
  const when = { paneAsked: null, barGone: null };
  let last;
  while (Date.now() - t0 < 60000) {
    last = await ui.eval(NOW);
    const ms = Date.now() - t0;
    if (when.paneAsked === null && last.pane && last.asked.some(t => t.includes(question))) when.paneAsked = ms;
    if (when.barGone === null && !last.bar) when.barGone = ms;
    if (when.paneAsked !== null && when.barGone !== null) break;
    await ui.sleep(100);
  }
  // the side chat answers; the bar must not come back meanwhile
  await until(ui, async () => { const s = await ui.eval(NOW); return s.answered && s.reply.length > 0; }, 300000, "the side chat's answer", 1500);
  await ui.sleep(1500);
  return { when, last, settled: await ui.eval(NOW) };
}

export default async function (ui) {
  const { qa, check } = checker(ui);

  // ---- a real Codex session that has answered once (a side chat branches from a reply) ----
  await offscreen(ui);
  await onDemo(ui);
  await closeTips(ui);
  await ui.newSession();
  await toDemo(ui);
  await ui.pickEngine("Codex", 180000);
  await ui.sleep(1500);
  qa.states.model = await ui.pickModel(/Luna/i, "Codex's small Luna model");
  await focusInput(ui, ".sessions-chat-editor");
  await ui.type(FIRST);
  await ui.press("Enter", { send: true });
  const lastMain = () => ui.eval(`(() => { const r = [...document.querySelectorAll('.session-view .interactive-response')].at(-1); return r ? r.innerText.trim() : ''; })()`);
  await until(ui, () => ui.eval(RUNNING), 90000, "the first turn to start", 500).catch(() => {});
  await until(ui, async () => !(await ui.eval(RUNNING)) && (await lastMain()).length > 0, 300000, "the first answer", 1500);
  const firstAnswer = await lastMain();
  if (/401|unauthori[sz]ed|quota|insufficient/i.test(firstAnswer)) ui.skip(`Codex could not answer on this Mac: ${firstAnswer.slice(0, 200)} (log in to Codex, or set DISPATCH_E2E_CODEX_MODEL)`);
  await closeTips(ui);
  await ui.setTheme("light");

  // ---- select, type, Enter ----
  const sel1 = qa.states.selected1 = await selectReply(ui);
  check("a drag over the reply selects its words and the bar comes", sel1.bar && sel1.selection.trim().length > 0, sel1);
  await ui.type(BY_ENTER, { into: { css: `${BAR} textarea` } });
  qa.states.typed1 = await ui.eval(NOW);
  check("the question is in the bar's input", qa.states.typed1.typed === BY_ENTER, qa.states.typed1.typed);
  await ui.screenshot("01-bar-typed");
  await ui.mark({ css: BAR }, { what: "回复里选字后浮出的引用条，里面写了一句", where: "选中那段下面", how: "回车或点箭头发出" });
  await ui.press("Enter", { send: true });
  const byEnter = qa.states.byEnter = await follow(ui, BY_ENTER);
  check("Enter: the side chat opens in the side pane with the question, quoted from the conversation", byEnter.when.paneAsked !== null && byEnter.last.quoteFrom === "In the conversation", { when: byEnter.when, quote: byEnter.last.quoteFrom });
  check("Enter: the bar is gone no later than the side chat shows the question", byEnter.when.barGone !== null && byEnter.when.barGone <= byEnter.when.paneAsked + 300, byEnter.when);
  check("Enter: the bar's input is empty and the selection is gone", byEnter.last.typed === "" && byEnter.last.selection === "", byEnter.last);
  check("Enter: the side chat answers", byEnter.settled.answered && byEnter.settled.reply.length > 0, byEnter.settled.reply);
  check("Enter: after the answer the bar is still gone", !byEnter.settled.bar && byEnter.settled.typed === "", byEnter.settled);
  await ui.screenshot("02-sent-by-enter");
  await ui.mark({ css: PANE }, { what: "回车发出后：右栏旁聊收到引用和这句话，对话上方的引用条已收起", where: "右栏下半；对话区", how: "选区也取消了" });

  // ---- select again, type, click the arrow ----
  const sel2 = qa.states.selected2 = await selectReply(ui);
  check("selected again: the bar comes back, empty", sel2.bar && sel2.typed === "" && sel2.selection.trim().length > 0, sel2);
  await ui.type(BY_ARROW, { into: { css: `${BAR} textarea` } });
  await ui.click({ css: `${BAR} .agent-feedback-input-actions .action-label` });
  const byArrow = qa.states.byArrow = await follow(ui, BY_ARROW);
  check("arrow: the side chat shows the second question", byArrow.when.paneAsked !== null, byArrow.when);
  check("arrow: the bar is gone no later than the side chat shows the question", byArrow.when.barGone !== null && byArrow.when.barGone <= byArrow.when.paneAsked + 300, byArrow.when);
  check("arrow: the bar's input is empty and the selection is gone", byArrow.last.typed === "" && byArrow.last.selection === "", byArrow.last);
  check("arrow: the side chat answers", byArrow.settled.answered && byArrow.settled.reply.length > 0, byArrow.settled.reply);
  check("arrow: after the answer the bar is still gone", !byArrow.settled.bar && byArrow.settled.typed === "", byArrow.settled);
  await ui.screenshot("03-sent-by-arrow");

  if (qa.failed.length) throw new Error(`${qa.failed.length} check(s) failed: ${qa.failed.join(" | ").slice(0, 1500)}`);
}
