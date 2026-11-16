// The sub-agent strip above the message box, direction A (the person picked it 2026-11-12, task-1rzdr; kanban
// design/subagent-strip/proto.html#dir=a). A real OpenCode session sends out two general sub-agents one after the
// other (session-now.mjs's message); while one works the strip sits 8 above the message box, as wide as it, with a row
// for the sub-agent: its dot, its name, how long, the step it is on. The clock is seen to move; the head folds the
// strip into one line and opens it again (with the mouse and the keyboard); Stop is there only where the engine can
// stop one sub-agent alone; a click on a row opens its own conversation; once none works the strip goes and Now still
// lists both. Cheap models only (GLM-5.3-Flash or DeepSeek's flash), never Claude.
export const meta = { instance: { motion: true }, needs: ["opencode"],
  title: "子 Agent 条：输入框上方看得见每个子 Agent 在做什么",
  description: "真起一段 OpenCode 会话，让它先后派两个 general 子 Agent 各数一会儿数：输入框上方出现一块（间距 8，和输入框同宽），一行一个在跑的子 Agent，圆点、名字、时间在走；点头一行收成一行（后面接第一个在做什么）再展开，键盘也能收起；OpenCode 停不了单个子 Agent，所以没有 Stop；点一行打开它自己的对话；都跑完条消失，右栏 Now 里照旧有这两个。",
  timeout: 2400,
};

import fs from "node:fs";
import path from "node:path";
import { READ, until, offscreen, onDemo, toDemo, focusInput, chooseCheapModel, closeTips } from "./session-now.mjs";

// session-now.mjs's message, with one shell call first in each sub-agent's prompt: counting is words only, and a sub-agent
// that runs no tool has no step to show
const MESSAGE = 'Use your task tool twice, one after the other, to start two general subagents. First: description "Count to 1500 A", prompt "SUBCOUNT A: first run the shell command sleep 45 with your bash tool, then count from 1 to 3000, one number per line, then reply DONE.". Second: description "Count to 1500 B", prompt "SUBCOUNT B: first run the shell command sleep 45 with your bash tool, then count from 1 to 3000, one number per line, then reply DONE.". After both are back, reply with one short line: BLOCKS DONE.';

/** The strip as the page draws it, with its sizes and where it sits against the message box. */
const STRIP = `(() => {
  const s = document.querySelector('.dispatch-subagents');
  if (!s || !s.getClientRects().length) return null;
  const r = e => e ? e.getBoundingClientRect() : null;
  const cs = (e, p) => e ? getComputedStyle(e)[p] : '';
  const font = e => e ? cs(e, 'fontSize') + '/' + cs(e, 'fontWeight') : '';
  const input = s.closest('.interactive-input-part');
  const box = input && [...input.querySelectorAll('.chat-input-container, .interactive-input-and-side-toolbar')].find(e => e.getClientRects().length);
  const head = s.querySelector('.dsa-head');
  const rows = [...s.querySelectorAll('.dsa-row')].map(e => {
    const dot = e.querySelector('.dsa-slot > .dispatch-mark');
    return {
      state: e.dataset.state, name: (e.querySelector('.dsa-name') || {}).textContent || '', meta: (e.querySelector('.dsa-meta') || {}).textContent || '',
      step: (e.querySelector('.dsa-step') || {}).textContent || '', ago: (e.querySelector('.dsa-ago') || {}).textContent || '',
      stop: !!e.querySelector('.dsa-stop, button'),
      dot: dot ? { w: Math.round(r(dot).width), cls: String(dot.getAttribute('class')), color: cs(dot, 'color') } : null, check: !!e.querySelector('.dsa-slot > .codicon-pass-filled.dispatch-mark.seen'),
      shimmer: (() => { const st = e.querySelector('.dsa-step'); return st ? cs(st, 'animationName') : ''; })(),
      h: Math.round(r(e).height), h1: Math.round(r(e.querySelector('.dsa-l1')).height), h2: e.querySelector('.dsa-l2') ? Math.round(r(e.querySelector('.dsa-l2')).height) : 0,
      nameFont: font(e.querySelector('.dsa-name')), metaFont: font(e.querySelector('.dsa-meta')) + ' ' + cs(e.querySelector('.dsa-meta'), 'fontVariantNumeric'),
      stepFont: font(e.querySelector('.dsa-step')), aria: e.getAttribute('aria-label') || '', tab: e.tabIndex,
    };
  });
  const fin = s.querySelector('.dsa-fin');
  return {
    gap: box ? Math.round(r(box).top - r(s).bottom) : null,
    width: Math.round(r(s).width), boxWidth: box ? Math.round(r(box).width) : null, left: Math.round(r(s).left), boxLeft: box ? Math.round(r(box).left) : null,
    above: box ? r(s).bottom <= r(box).top : null,
    height: Math.round(r(s).height), radius: cs(s, 'borderRadius'), padding: cs(s, 'padding'), bg: cs(s, 'backgroundColor'),
    under: (() => { for (let e = s.parentElement; e; e = e.parentElement) { const c = cs(e, 'backgroundColor'); if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; } return ''; })(),
    ring: !!s.querySelector(':focus-visible'),
    head: head ? { text: (head.querySelector('.dsa-headline') || {}).textContent || '', line: (head.querySelector('.dsa-line') || {}).textContent || '', expanded: head.getAttribute('aria-expanded'), aria: head.getAttribute('aria-label') || '', h: Math.round(r(head).height), font: font(head), icon: !!head.querySelector('.codicon-agent'), lineShown: cs(head.querySelector('.dsa-line'), 'visibility') !== 'hidden' } : null,
    rows,
    finished: fin ? { text: fin.textContent, expanded: fin.getAttribute('aria-expanded'), h: Math.round(r(fin).height) } : null,
    unnamed: [...s.querySelectorAll('button, [role="button"]')].filter(b => !(b.getAttribute('aria-label') || b.textContent.trim())).length,
    blockGlyphs: s.querySelectorAll('.dispatch-status-blocks, [class*="dispatch-block-"], .codicon-check-all').length,
    // the colours the symbol table's marks must have, resolved in this theme (DESIGN.md「符号表」)
    tokens: (() => { const t = {}; for (const [k, v] of Object.entries({ plan: '--dispatch-state-plan', stopped: '--dispatch-state-stopped', text2: '--vscode-descriptionForeground' })) { const e = document.createElement('span'); e.style.color = 'var(' + v + ')'; s.appendChild(e); t[k] = getComputedStyle(e).color; e.remove(); } return t; })(),
  };
})()`;

export default async function (ui) {
  const qa = { checks: [], failed: [], reads: {} };
  const note = () => fs.writeFileSync(path.join(ui.out, "qa.json"), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
    console.error(`${ok ? "ok" : "FAILED"}: ${name}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 500)}`);
    note();
  };
  const strip = () => ui.eval(STRIP);
  const waitStrip = (fn, what, ms = 60000) => until(ui, async () => { const s = await strip(); return fn(s) ? (s || true) : null; }, ms, what, 300);

  // a real session on the demo project, the way session-now.mjs starts one
  await offscreen(ui);
  await onDemo(ui);
  await offscreen(ui);
  await closeTips(ui);
  await ui.newSession();
  await toDemo(ui);
  await ui.pickEngine("OpenCode", 180000);
  await ui.sleep(1500);
  await chooseCheapModel(ui, ".sessions-chat-editor");
  await focusInput(ui, ".sessions-chat-editor");
  const before = await strip();
  check("no strip before anything is sent", before === null, before);
  await ui.type(MESSAGE);
  await ui.press("Enter", { send: true });

  // 1. a sub-agent at work: the strip above the message box
  const first = await waitStrip(s => s && s.rows.some(r => r.state === "sub-agent" && /^Count to 1500 [AB]$/.test(r.name)), "the strip with a sub-agent at work", 300000).catch(async e => { qa.reads.firstTimeout = await strip(); note(); throw e; });
  await ui.sleep(1500);
  const s1 = await strip();
  qa.reads.working = s1;
  check("the strip sits 8 above the message box", s1.above === true && s1.gap === 8, { gap: s1.gap, above: s1.above });
  check("as wide as the message box, on its left edge", s1.width === s1.boxWidth && s1.left === s1.boxLeft, { width: s1.width, box: s1.boxWidth, left: s1.left, boxLeft: s1.boxLeft });
  check("the block: 8 round (--dispatch-radius-card), 4 inside", s1.radius === "8px" && s1.padding === "4px", { radius: s1.radius, padding: s1.padding });
  check("the block stands off the conversation behind it (dark)", s1.bg !== s1.under, { bg: s1.bg, under: s1.under });
  check("the head: the agent mark, \"1 agent working\", open, 32 high, 12px", s1.head.icon && s1.head.text === "1 agent working" && s1.head.expanded === "true" && s1.head.h === 32 && /^12px/.test(s1.head.font), s1.head);
  const row = s1.rows.find(r => r.state === "sub-agent");
  check("a row: the sub-agent's name, 13/500", /^Count to 1500 [AB]$/.test(row.name) && row.nameFont === "13px/500", row);
  check("a row: the 14 px purple filled circle (--dispatch-state-plan), no block glyph", row.dot && row.dot.w === 14 && /codicon-circle-large-filled .*dispatch-mark sub-agent/.test(row.dot.cls) && row.dot.color === s1.tokens.plan && s1.blockGlyphs === 0, { dot: row.dot, token: s1.tokens.plan, blockGlyphs: s1.blockGlyphs });
  check("a row: two lines, 26 and 20 high", row.h1 === 26 && row.h2 === 20, { h1: row.h1, h2: row.h2 });
  check("a row: how long in 11px tabular numbers", /^\d+(m \d+)?s$/.test(row.meta) && /^11px/.test(row.metaFont) && /tabular-nums/.test(row.metaFont), row.meta + " " + row.metaFont);
  check("no engine gives a sub-agent's own tokens today: no number made up", !/k ·|^\d+ ·/.test(row.meta), row.meta);
  check("OpenCode cannot stop one sub-agent alone: no Stop that does nothing", !(await ui.exists({ css: ".dispatch-subagents .dsa-stop" })) && !row.stop, row);
  qa.reads.firstStep = row.step;
  check("every button has a name", s1.unnamed === 0, s1.unnamed);
  check("the row can be reached with the keyboard", row.tab === 0 && /Open its conversation/.test(row.aria), row.aria);
  await ui.screenshot("01-strip-working");
  await ui.mark({ css: ".dispatch-subagents" }, { what: "子 Agent 条：一行一个在跑的子 Agent", where: "输入框上方，间距 8", how: "点头一行收起；点一行打开它的对话" });

  // 2. the clock moves
  const t1 = (await strip()).rows.find(r => r.state === "sub-agent");
  await ui.sleep(3500);
  const s2 = await strip();
  const t2 = s2 && s2.rows.find(r => r.name === t1.name);
  qa.reads.clock = { before: t1 && t1.meta, after: t2 && t2.meta };
  check("the time runs: two reads 3.5 s apart differ", !!t2 && t1.meta !== t2.meta, qa.reads.clock);
  // the step it is on: OpenCode's sub-agent counts in words, so it may run no tool at all; whatever it shows is read
  const steps = new Set();
  let stepped = null;
  for (let i = 0; i < 80 && !stepped; i++) { const s = await strip(); stepped = s && s.rows.find(r => r.state === "sub-agent" && r.step); if (!stepped) await ui.sleep(500); }
  if (stepped) {
    steps.add(`${stepped.name}: ${stepped.step} (${stepped.ago})`);
    await ui.sleep(2500);
    const later = (await strip())?.rows.find(r => r.name === stepped.name);
    if (later) steps.add(`${later.name}: ${later.step} (${later.ago})`);
    check("the second line says the step it runs, with its own clock that moves", !!later && later.step === stepped.step && /^\d+(m \d+)?s$/.test(later.ago) && later.ago !== stepped.ago, { first: stepped, later });
    check("the step shimmers like Now's Right now", /dispatch-subagents-shimmer/.test(stepped.shimmer), stepped.shimmer);
    await ui.screenshot("01b-strip-step");
    await ui.setTheme("light");
    await ui.sleep(800);
    const light = await strip();
    qa.reads.light = light && { bg: light.bg, dot: light.rows[0] && light.rows[0].dot };
    check("the block stands off the conversation behind it (light)", !!light && light.bg !== light.under, light && { bg: light.bg, under: light.under });
    await ui.screenshot("01c-strip-step-light");
    await ui.setTheme("dark");
    await ui.sleep(500);
  } else {
    check("a step shows on the second line while the sub-agent runs its shell call", false, await strip());
  }
  qa.reads.steps = [...steps];
  const shimmer = t2 && t2.step ? t2.shimmer : "no step shown";
  qa.reads.shimmer = shimmer;

  // 3. fold with a click: one line, the first one and its step after the head
  await ui.click({ css: ".dispatch-subagents .dsa-head" });
  await ui.sleep(400);
  const folded = await strip();
  qa.reads.folded = folded;
  check("folded: only the head, 40 high with the block's inside", folded && folded.rows.length === 0 && folded.head.expanded === "false" && folded.height === 40, folded && { rows: folded.rows.length, h: folded.height, expanded: folded.head.expanded });
  check("folded: the head goes on with the name of the one working (and its step when known)", folded && folded.head.lineShown && /^Count to 1500 [AB](: .+)?$/.test(folded.head.line), folded && folded.head.line);
  check("folded: still 8 above the message box", folded && folded.gap === 8, folded && folded.gap);
  check("a mouse click leaves no focus ring on the strip", folded && folded.ring === false, folded && folded.ring);
  await ui.screenshot("02-strip-folded");
  await ui.mark({ css: ".dispatch-subagents" }, { what: "收起：只剩一行", where: "输入框上方", how: "几个在跑，第一个在做什么；再点展开" });

  // 4. open it again with the keyboard: focus on the head, Enter
  // the head is a button inside the input part: the runner holds Enter back there unless told it is meant (the message
  // box is empty and the focus is on the head, read first)
  await ui.eval(`document.querySelector('.dispatch-subagents .dsa-head').focus()`);
  check("the head takes the keyboard focus", await ui.eval(`document.activeElement && document.activeElement.classList.contains('dsa-head')`) === true);
  await ui.press("Enter", { send: true });
  await ui.sleep(400);
  const opened = await strip();
  check("Enter on the focused head opens it again", opened && opened.head.expanded === "true" && opened.rows.length >= 1, opened && { expanded: opened.head.expanded, rows: opened.rows.length });
  const focusKept = await ui.eval(`document.activeElement && document.activeElement.classList.contains('dsa-head')`);
  check("from the keyboard the ring shows", (await strip())?.ring === true);
  check("the focus stays on the head", focusKept === true, focusKept);
  const sentNothing = await ui.eval(`[...document.querySelectorAll('.interactive-request')].filter(e => e.offsetParent).length`);
  check("Enter on the head sent nothing (still the one message)", sentNothing === 1, sentNothing);
  await ui.press("Enter", { send: true });
  await ui.sleep(400);
  const keyFolded = await strip();
  check("Enter again folds it", keyFolded && keyFolded.head.expanded === "false" && keyFolded.rows.length === 0, keyFolded && keyFolded.head.expanded);
  await ui.click({ css: ".dispatch-subagents .dsa-head" });
  await ui.sleep(400);
  check("a click opens it again", (await strip())?.head.expanded === "true");

  // 5. reduce motion: the step stands still
  await ui.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await ui.sleep(1500);
  const still = await ui.eval(`(() => { const st = document.querySelector('.dispatch-subagents .dsa-step'); const s = document.querySelector('.dispatch-subagents'); return { step: st ? getComputedStyle(st).animationName : 'none', strip: s ? getComputedStyle(s).animationName : 'gone', car: s ? getComputedStyle(s.querySelector('.dsa-car')).transitionDuration : '' }; })()`);
  qa.reads.reduced = still;
  check("reduce motion: no shimmer, no motion", still.step === "none" && (still.strip === "none" || still.strip === "gone") && (/^0s/.test(still.car) || still.strip === "gone"), still);
  await ui.cdp.send("Emulation.setEmulatedMedia", { features: [] });

  // 5b. the one back while the other works: "1 finished", opening in place
  // (between the two the strip goes for a moment: the first is back and the second not started yet)
  const withFin = await waitStrip(s => s && s.finished && s.rows.some(r => r.state === "sub-agent"), "the strip with 1 finished while the other works", 240000).catch(() => null);
  if (withFin) {
    check("the one back folds into \"1 finished\", 28 high, closed", withFin.finished.text === "1 finished" && withFin.finished.h === 28 && withFin.finished.expanded === "false", withFin.finished);
    await ui.click({ css: ".dispatch-subagents .dsa-fin" });
    await ui.sleep(400);
    const fin = await strip();
    const done = fin && fin.rows.find(r => r.state === "done");
    qa.reads.finishedOpen = fin;
    check("1 finished opens in place: the grey filled check, its name, how long it took, one 34 high line", !!done && done.check && /^Count to 1500 [AB]$/.test(done.name) && /^\d+(m \d+)?s$/.test(done.meta) && done.h2 === 0 && done.h === 34, done);
    await ui.screenshot("03b-strip-finished-open");
    await ui.setTheme("light");
    await ui.sleep(800);
    await ui.screenshot("03c-strip-finished-open-light");
    await ui.setTheme("dark");
    await ui.sleep(500);
    await ui.mark({ css: ".dispatch-subagents" }, { what: "做完的收成一行 1 finished", where: "子 Agent 条最后一行", how: "点开就地展开：细线勾、名字、用了多久" });
  } else {
    check("the one back folds into \"1 finished\" while the other works", false, withFin);
  }

  // 6. a click on the row opens the sub-agent's own conversation, then back to the session
  const now = await strip();
  const target = now && now.rows.find(r => r.state === "sub-agent");
  if (target) {
    await ui.click({ css: `.dispatch-subagents .dsa-row[data-state="sub-agent"] .dsa-name` });
    const own = await until(ui, () => ui.eval(`(() => {
      const req = [...document.querySelectorAll('.interactive-request')].filter(e => e.offsetParent).map(e => e.innerText).join(' ');
      return /SUBCOUNT [AB]/.test(req) && !/Use your task tool/.test(req) ? req.slice(0, 200) : null;
    })()`), 30000, "the sub-agent's own conversation", 500).catch(() => null);
    check("a click on a row opens the sub-agent's own conversation", !!own, own);
    await ui.screenshot("03-subagent-opened");
    // back to the session's own conversation: its tab, the first in the session's chat tabs
    const mainShown = () => ui.eval(`(() => { const req = [...document.querySelectorAll('.interactive-request')].filter(e => e.offsetParent).map(e => e.innerText).join(' '); return /Use your task tool/.test(req) ? true : null; })()`);
    qa.reads.chatTabs = await ui.eval(`[...document.querySelectorAll('.chat-composite-bar-tab')].filter(e => e.offsetParent).map(e => e.innerText.trim().slice(0, 60))`);
    if (await ui.exists({ css: ".chat-composite-bar-tab" })) await ui.click({ css: ".chat-composite-bar-tab" });
    let back = await until(ui, mainShown, 10000, "the session's own conversation again", 500).catch(() => false);
    if (!back) {
      await ui.click({ text: "Use your task tool twice", within: ".agent-sessions-viewpane" });
      back = await until(ui, mainShown, 20000, "the session's own conversation again", 500).catch(() => false);
    }
    check("back on the session's own conversation", back === true);
    const again = await waitStrip(s => s && s.rows.some(r => r.state === "sub-agent"), "the strip again over the session's box", 20000).catch(() => null);
    if (again) check("back on the session while one works: the strip is there again", true);
    else {
      await ui.openNowTab();
      const n = await ui.eval(READ);
      check("back on the session: the strip is there again, or no sub-agent works any more", !!n && !n.agents.some(a => a.state === "sub-agent"), n && n.agents);
    }

  } else {
    check("a sub-agent still at work to open", false, now);
  }

  // 7. none works any more: the strip goes; Now still lists both. Between the two sub-agents the strip goes for a
  // moment too, so "none works" is read in Now: both back, "2 finished"
  await ui.openNowTab();
  const noneWorking = async () => { const n = await ui.eval(READ); return !!n && n.finished === "2 finished" && !n.agents.some(a => a.state === "sub-agent"); };
  await until(ui, async () => (await strip()) === null && await noneWorking() ? true : null, 900000, "no sub-agent at work", 1000).catch(async e => { qa.reads.goneTimeout = { strip: await strip(), now: await ui.eval(READ) }; note(); throw e; });
  check("no sub-agent at work: the strip is gone", (await strip()) === null);
  await ui.screenshot("04-strip-gone");
  await ui.openNowTab();
  const listed = await until(ui, async () => {
    const s = await ui.eval(READ);
    if (!s) return null;
    if (s.finished && !(await ui.eval(`document.querySelector('[data-part="finished"]')?.getAttribute('aria-expanded') === 'true'`))) await ui.click({ css: '[data-part="finished"]' });
    const again = await ui.eval(READ);
    return again && again.agents.length >= 2 ? again : null;
  }, 60000, "both sub-agents in Now", 1000).catch(async () => ui.eval(READ));
  qa.reads.now = listed && { finished: listed.finished, agents: listed.agents };
  check("Now still lists both sub-agents", !!listed && listed.agents.some(a => /Count to 1500 A/.test(a.text)) && listed.agents.some(a => /Count to 1500 B/.test(a.text)), listed && listed.agents.map(a => a.text));
  await ui.screenshot("05-now-lists-both");

  note();
  if (qa.failed.length) throw new Error(`${qa.failed.length} check(s) failed: ${qa.failed.join(" | ").slice(0, 1500)}`);
}
