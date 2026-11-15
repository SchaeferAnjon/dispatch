// The message you sent, pinned once it has scrolled away (user 2026-11-15, task-wdjpl, design/sticky-ask B): one quiet
// line at the top of the conversation, 12px grey, cut to one line with a thin ↑, see-through with a light blur, 28 high;
// a click scrolls smoothly back to the message. It fades in and out in 150 ms (task-vk9nq); with reduced motion it
// just appears and goes. Nothing is pinned while any of the message is still on screen, and the
// session's own title row above the conversation is gone (the title bar names the session). A real OpenCode session on
// DeepSeek's flash model answers two long lists, the conversation is scrolled with the wheel, the line is read from the
// page (height, text, background alpha, blur), clicked, and shot in light and dark.
export const meta = { needs: ['opencode'], instance: { motion: true },
  title: "对话顶上钉住的那句话收成一行",
  description: "真实 OpenCode 会话回两段 60 行的列表，滚轮往下滚：滚过你那句话以后顶上只有一行 12px 灰字、半透明加模糊、28 高，字是你那句话；一轮问了两句时钉的是当前这一段对应的那句；点它平滑滚回那句话；滚回顶上它消失；对话上面不再有重复的会话标题，标题栏的 Rename… 改成弹框问名字。出现、消失各 150ms 淡入淡出（逐帧读透明度），跳回顶上时留一份淡出的副本，减少动态效果时直接出现、消失。浅色深色各截一张。",
  timeout: 1500,
};

import fs from "node:fs";
import path from "node:path";
import { until, offscreen, onDemo, toDemo, focusInput, chooseCheapModel, closeTips } from "./session-now.mjs";

const ASK1 = "Reply with a plain numbered list of 60 lines, 1 to 60, one short sentence per line about the number. No tools, no headings.";
const ASK2 = "Now continue the same list from 61 to 120, same style. No tools, no headings.";
const LIST = ".interactive-session .interactive-list > .monaco-list";

/** Every frame for ms milliseconds: the line's opacity and visibility, and the fading copy a line leaves when it is taken away. */
const SAMPLE = (ms) => `(() => { window.__dispatchFade = []; const me = window.__dispatchFadeRun = {}; const t0 = performance.now(); const f = () => {
  const sc = document.querySelector('${LIST} > .monaco-scrollable-element > .monaco-tree-sticky-container:not(.dispatch-sticky-ask-ghost)');
  const row = sc && sc.querySelector(':scope > .monaco-tree-sticky-row');
  const bar = row && !sc.classList.contains('empty') && row.querySelector('.interactive-item-container.interactive-request');
  const ghost = document.querySelector('${LIST} .dispatch-sticky-ask-ghost .interactive-item-container.interactive-request');
  const cs = bar && getComputedStyle(bar);
  window.__dispatchFade.push({ t: Math.round(performance.now() - t0), o: cs ? Math.round(parseFloat(cs.opacity) * 100) / 100 : null, v: cs ? cs.visibility : null, partial: !!row && row.classList.contains('source-node-partially-visible'), g: ghost ? Math.round(parseFloat(getComputedStyle(ghost).opacity) * 100) / 100 : null, ga: ghost ? getComputedStyle(ghost).animationName : '' });
  if (window.__dispatchFadeRun === me && performance.now() - t0 < ${ms}) requestAnimationFrame(f); }; requestAnimationFrame(f); })()`;
const TRANSITION = `(() => { const b = document.querySelector('${LIST} > .monaco-scrollable-element > .monaco-tree-sticky-container > .monaco-tree-sticky-row .interactive-item-container.interactive-request'); if (!b) return null; const cs = getComputedStyle(b); return { property: cs.transitionProperty, duration: cs.transitionDuration, timing: cs.transitionTimingFunction }; })()`;
/** Opacities strictly between 0 and 1 seen on the way (a fade), and where it ended. */
const between = (xs, key) => xs.map(x => x[key]).filter(o => o !== null && o > 0.04 && o < 0.96);

/** What the top of the conversation shows: the pinned row, the messages on screen, the header row. */
const STATE = `(() => {
  const list = document.querySelector('${LIST}');
  if (!list) return null;
  const lr = list.getBoundingClientRect();
  const alpha = c => { const m = /\\/\\s*([\\d.]+)\\s*\\)$/.exec(c) || /^rgba\\([^)]*,\\s*([\\d.]+)\\)$/.exec(c); return c === 'transparent' ? 0 : m ? Number(m[1]) : 1; };
  const sc = list.querySelector(':scope > .monaco-scrollable-element > .monaco-tree-sticky-container');
  const row = sc && sc.querySelector(':scope > .monaco-tree-sticky-row');
  const bar = row && row.querySelector('.interactive-item-container.interactive-request');
  const bubble = bar && bar.querySelector('.value .rendered-markdown');
  // the row stays in the page while the message is still on screen; its line is faded out and hidden (task-vk9nq)
  const shown = !!bar && !row.classList.contains('source-node-partially-visible') && getComputedStyle(bar).visibility === 'visible' && row.getBoundingClientRect().height > 0;
  const br = bar && bar.getBoundingClientRect();
  const cs = bar && getComputedStyle(bar);
  const after = bar && getComputedStyle(bar, '::after');
  const asks = [...list.querySelectorAll(':scope > .monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.request')].map(r => {
    const b = r.querySelector('.value .rendered-markdown'); if (!b) return null;
    const x = b.getBoundingClientRect(); return { text: b.innerText.trim(), top: Math.round(x.top - lr.top), bottom: Math.round(x.bottom - lr.top) };
  }).filter(Boolean);
  const view = document.querySelector('.session-view.is-active') || document.querySelector('.session-view');
  const head = view && view.querySelector('.chat-composite-bar.session-header-bar > .chat-composite-bar-header');
  const titleEl = view && view.querySelector('.chat-composite-bar-session-title-text');
  const place = document.querySelector('.dispatch-place');
  // what is drawn right under the pinned line: the reply's words, not the pinned row
  const under = document.elementFromPoint(lr.left + lr.width / 2, lr.top + 40);
  const slider = list.querySelector(':scope > .monaco-scrollable-element > .scrollbar.vertical > .slider');
  return {
    listTop: Math.round(lr.top), listW: Math.round(lr.width),
    pinned: !!row, shown, partial: !!row && row.classList.contains('source-node-partially-visible'), ours: !!row && row.classList.contains('dispatch-sticky-ask'),
    containerH: sc ? Math.round(sc.getBoundingClientRect().height) : 0, containerAlpha: sc ? alpha(getComputedStyle(sc).backgroundColor) : null,
    containerPointer: sc ? getComputedStyle(sc).pointerEvents : '',
    barH: br ? Math.round(br.height) : 0, barW: br ? Math.round(br.width) : 0, barTop: br ? Math.round(br.top - lr.top) : null,
    barText: bubble ? bubble.innerText.trim() : '', barLines: bubble ? Math.round(bubble.getBoundingClientRect().height / parseFloat(getComputedStyle(bubble).lineHeight)) : 0,
    barFont: bubble ? getComputedStyle(bubble).fontSize : '', barColor: cs ? cs.color : '', barBg: cs ? cs.backgroundColor : '', barAlpha: cs ? alpha(cs.backgroundColor) : null,
    barBlur: cs ? (cs.backdropFilter || cs.webkitBackdropFilter || '') : '', barBorder: cs ? cs.borderBottomWidth + ' ' + cs.borderBottomStyle : '',
    arrow: after ? after.content : '', cursor: cs ? cs.cursor : '', dir: cs ? cs.flexDirection : '',
    lineAlpha: cs ? alpha(cs.borderBottomColor) : null,
    words: (() => { if (!bubble || !br) return null; const p = bubble.querySelector('p') || bubble; const range = document.createRange(); range.selectNodeContents(p); const w = range.getBoundingClientRect(); const pad = parseFloat(cs.paddingLeft); return { left: Math.round(w.left - br.left - pad), top: Math.round(bubble.getBoundingClientRect().top - br.top), roomRight: Math.round(br.right - parseFloat(cs.paddingRight) - bubble.getBoundingClientRect().right) }; })(),
    text2: (() => { const e = document.createElement('span'); e.style.color = 'var(--vscode-descriptionForeground)'; list.appendChild(e); const c = getComputedStyle(e).color; e.remove(); return c; })(),
    under: under ? (under.closest('.monaco-tree-sticky-container') ? 'sticky' : under.closest('.interactive-response') ? 'reply' : under.className) : null,
    asks, editing: !!document.querySelector('.interactive-item-container.interactive-request.editing'),
    headShown: !!head && head.getClientRects().length > 0, titleShown: !!titleEl && titleEl.getClientRects().length > 0,
    title: titleEl ? titleEl.textContent : '', place: place ? place.innerText.replace(/\\s+/g, ' ').trim() : '',
    sole: !!view && view.classList.contains('dispatch-sole-session'),
    slider: slider ? parseFloat(slider.style.top) || 0 : null,
  };
})()`;

export default async function (ui) {
  const qa = { checks: [], failed: [], states: {} };
  const note = () => fs.writeFileSync(path.join(ui.out, "qa.json"), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
    console.error(`${ok ? "ok" : "FAILED"}: ${name}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400)}`);
    note();
  };
  const read = () => ui.eval(STATE);
  const box = async () => ui.eval(`(() => { const r = document.querySelector('${LIST}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const wheel = async (dy, times = 1) => { const b = await box(); for (let i = 0; i < times; i++) { await ui.mouse("mouseWheel", b.x, b.y, { deltaX: 0, deltaY: dy }); await ui.sleep(70); } await ui.sleep(450); };
  const toTop = async () => { for (let i = 0; i < 40; i++) { await wheel(-400, 4); const s = await read(); if (s.slider === 0) break; } };
  // a turn: the stop block comes, then goes; the reply is a list (an <ol>, so its numbers are not in the text)
  const RUNNING = `!!document.querySelector('.interactive-input-part .chat-execute-toolbar .codicon-stop-circle, .sessions-list-control .dispatch-status-blocks.running')`;
  const lastItems = () => ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-list .monaco-list-rows .interactive-response')].at(-1); return r ? r.querySelectorAll('li').length : 0; })()`);
  const turn = async (what) => {
    await until(ui, () => ui.eval(RUNNING), 90000, `${what}: the agent to start`, 500).catch(() => {});
    await until(ui, async () => !(await ui.eval(RUNNING)), 420000, `${what}: the turn to end`, 2000);
    await ui.sleep(3000);
    const items = await lastItems();
    check(`${what}: the reply is long enough to scroll (a list of 30 or more lines)`, items >= 30, items);
  };
  const send = async (text) => {
    await focusInput(ui, ".interactive-session .interactive-input-part");
    await ui.type(text);
    await ui.press("Enter", { send: true });
    await turn(text.slice(0, 30));
  };

  await offscreen(ui);
  await onDemo(ui);
  await closeTips(ui);
  await ui.newSession();
  await toDemo(ui);
  await ui.pickEngine("OpenCode", 180000);
  await ui.sleep(1500);
  await chooseCheapModel(ui, ".sessions-chat-editor");
  await focusInput(ui, ".sessions-chat-editor");
  await ui.type(ASK1);
  await ui.press("Enter", { send: true });
  await turn("first ask");
  await closeTips(ui);

  // 1. at the top: the message is where it is, nothing pinned, no title row over the conversation
  await ui.setTheme("light");
  await ui.sleep(800);
  await toTop();
  const top = qa.states.top = await read();
  check("at the top nothing is pinned (the message is in place)", !top.shown, top);
  check("the message is on screen at the top, its bubble 24 under the pane's top", top.asks.some(a => a.text === ASK1 && a.top === 24), top.asks);
  check("no session title row above the conversation (the title bar names it)", top.sole && !top.headShown && !top.titleShown, { sole: top.sole, head: top.headShown, title: top.titleShown, place: top.place });
  check("the title bar still names the session", !!top.place && top.place.includes(top.title || "\u0000"), { place: top.place, title: top.title });
  await ui.screenshot("01-top-light");

  // 2. down with the wheel a little at a time: while any of the message shows nothing is pinned; once it has gone
  //    the one line is there
  const walk = [];
  for (let i = 0; i < 14; i++) {
    await wheel(40);
    const s = await read();
    const ask = s.asks.find(a => a.text === ASK1);
    walk.push({ shown: s.shown, partial: s.partial, ask: ask ? [ask.top, ask.bottom] : null, barH: s.barH });
    if (s.shown && !ask) break;
  }
  qa.states.walk = walk;
  check("while the message is still on screen below the line, nothing is pinned", walk.every(w => !(w.shown && w.ask && w.ask[1] > 29)), walk);
  check("once the message has gone above, the line is pinned", walk.some(w => w.shown), walk);
  await wheel(240, 3);

  const mid = qa.states.mid = await read();
  check("one line at the top: ours, shown, not the half-visible state", mid.ours && mid.shown && !mid.partial, mid);
  check("the line is at most 30 high (28)", mid.barH > 0 && mid.barH <= 30 && mid.containerH <= 30, { bar: mid.barH, container: mid.containerH });
  check("the line sits at the very top of the conversation", mid.barTop === 0, mid.barTop);
  check("its words are the message you sent, on one line", mid.barText === ASK1 && mid.barLines === 1, { text: mid.barText, lines: mid.barLines });
  check("12px in --text-2", mid.barFont === "12px" && mid.barColor === mid.text2, { font: mid.barFont, color: mid.barColor, text2: mid.text2 });
  check("a thin ↑ at its end", /↑/.test(mid.arrow), mid.arrow);
  check("the ↑ is on the same row, after the words (a row, room kept on the right)", mid.dir === "row" && mid.words && mid.words.roomRight >= 8, { dir: mid.dir, words: mid.words });
  check("the words start at the column's left, like a reply's", mid.words && mid.words.left === 0, mid.words);
  check("the words sit in the middle of the 28 (20 high, 3 or 4 from the top)", mid.words && (mid.words.top === 3 || mid.words.top === 4), mid.words);
  check("the 1px line under it is drawn (not a see-through colour)", mid.lineAlpha > 0, mid.lineAlpha);
  check("see-through: the line's background is not solid (about 88%) and blurs what is under it", mid.barAlpha !== null && mid.barAlpha < 0.95 && mid.barAlpha > 0.5 && /blur\(8px\)/.test(mid.barBlur), { bg: mid.barBg, alpha: mid.barAlpha, blur: mid.barBlur });
  check("no solid band behind it: the pinned area is transparent", mid.containerAlpha === 0, mid.containerAlpha);
  check("a 1px line under it", mid.barBorder === "1px solid", mid.barBorder);
  check("right under the line the reply shows, not a band", mid.under === "reply", mid.under);
  check("the line is as wide as the conversation column (the message rows, at most 950)", mid.barW > 300 && mid.barW <= Math.min(950, mid.listW), { bar: mid.barW, list: mid.listW });
  check("the line points like a button", mid.cursor === "pointer", mid.cursor);
  check("still no session title row", !mid.headShown && !mid.titleShown);

  // light and dark, the line marked
  await ui.setTheme("light");
  await ui.sleep(800);
  await ui.screenshot("02-pinned-light");
  await ui.mark({ css: ".monaco-tree-sticky-row.dispatch-sticky-ask .interactive-item-container" }, { what: "滚过你那句话以后顶上只剩这一行：12px 灰字、单行截断、行尾细 ↑，半透明加模糊，28 高", where: "对话顶上", how: "点它平滑滚回那句话" });
  await ui.setTheme("dark");
  await ui.sleep(800);
  const dark = qa.states.dark = await read();
  check("dark: the same line, see-through, 12px --text-2", dark.shown && dark.barH <= 30 && dark.barAlpha < 0.95 && dark.containerAlpha === 0 && dark.barColor === dark.text2, dark);
  await ui.screenshot("03-pinned-dark");
  await ui.mark({ css: ".monaco-tree-sticky-row.dispatch-sticky-ask .interactive-item-container" }, { what: "深色下同一行", where: "对话顶上", how: "点它平滑滚回那句话" });
  await ui.setTheme("light");
  await ui.sleep(800);

  // 2b. it fades (task-vk9nq): out as the message comes back into view at the top, in as it leaves again; 150 ms on
  //     opacity only; taken away while shown (a jump to the top), a copy fades out where it was
  const transition = qa.states.transition = await ui.eval(TRANSITION);
  check("the line's opacity has a 150 ms transition (nothing that moves the layout)", !!transition && /opacity/.test(transition.property) && /0\.15s/.test(transition.duration) && !/height|top|width|margin|padding/.test(transition.property), transition);
  const b0 = await box();
  const fadeRun = async (dy, until2) => {
    await ui.eval(SAMPLE(1600));
    for (let i = 0; i < 20; i++) { await ui.mouse("mouseWheel", b0.x, b0.y, { deltaX: 0, deltaY: dy }); await ui.sleep(40); if (until2(await read())) break; }
    await ui.sleep(1700);
    return ui.eval(`window.__dispatchFade`);
  };
  const out = await fadeRun(-20, s => !s.shown);
  qa.states.fadeOut = out;
  check("scrolling up until the message shows again: the line fades out (opacities between 0 and 1 on the way), then is hidden", between(out, 'o').length >= 2 && out.at(-1).o === 0 && out.at(-1).v === 'hidden' && out.at(-1).partial, { between: between(out, 'o'), end: out.at(-1) });
  const fadeIn = await fadeRun(20, s => s.shown);
  qa.states.fadeIn = fadeIn;
  check("scrolling down past it again: the line fades in (opacities between 0 and 1 on the way), then is fully there", between(fadeIn, 'o').length >= 2 && fadeIn.at(-1).o === 1 && fadeIn.at(-1).v === 'visible', { between: between(fadeIn, 'o'), end: fadeIn.at(-1) });
  const fadeMs = (xs) => { const i = xs.findIndex(x => x.o !== null && x.o > 0.04 && x.o < 0.96); const j = xs.findLastIndex(x => x.o !== null && x.o > 0.04 && x.o < 0.96); return i < 0 ? 0 : xs[j].t - xs[i].t; };
  check("each fade takes about 150 ms (the in-between frames span 60 to 220 ms)", [out, fadeIn].every(xs => { const d = fadeMs(xs); return d >= 60 && d <= 220; }), { out: fadeMs(out), in: fadeMs(fadeIn) });
  // a fast flick up: whichever way the line leaves (its message coming back into view, or the line taken away), it
  // fades; nothing pops
  await ui.eval(SAMPLE(1200));
  for (let i = 0; i < 6; i++) await ui.mouse("mouseWheel", b0.x, b0.y, { deltaX: 0, deltaY: -1500 });
  await ui.sleep(1400);
  const jump = qa.states.jump = await ui.eval(`window.__dispatchFade`);
  check("a fast flick up while it is shown: the line fades out (itself, or a copy where it was), nothing pops", between(jump, 'o').length >= 2 || between(jump, 'g').length >= 2, { line: between(jump, 'o'), copy: between(jump, 'g') });
  check("after the flick no copy is left behind", jump.at(-1).g === null && !(await ui.exists({ css: ".dispatch-sticky-ask-ghost" })), jump.at(-1));
  for (let i = 0; i < 30; i++) { await wheel(40); if ((await read()).shown) break; }
  await wheel(240, 3);
  check("down again: the line is back", (await read()).shown);

  // 3. click it: a smooth scroll back to the message, which is then in place, and nothing is pinned or edited
  await ui.eval(`(() => { const s = document.querySelector('${LIST} > .monaco-scrollable-element > .scrollbar.vertical > .slider'); window.__dispatchSamples = []; const t0 = performance.now(); const f = () => { window.__dispatchSamples.push(parseFloat(s.style.top) || 0); if (performance.now() - t0 < 1500) requestAnimationFrame(f); }; requestAnimationFrame(f); })()`);
  await ui.click({ css: ".monaco-tree-sticky-row.dispatch-sticky-ask .interactive-item-container" });
  await ui.sleep(1400);
  const samples = await ui.eval(`window.__dispatchSamples`);
  const distinct = [...new Set(samples)];
  qa.states.samples = distinct;
  check("the click scrolls smoothly (several steps on the way, not one jump)", distinct.length >= 4 && distinct[0] > distinct.at(-1), distinct);
  const back = qa.states.back = await read();
  const ask1 = back.asks.find(a => a.text === ASK1);
  check("after the click the message is back on screen at the top", !!ask1 && ask1.top >= 0 && ask1.top < 80, back.asks);
  check("after the click nothing is pinned", !back.shown, back);
  check("the click did not start editing the message", !back.editing);
  await ui.screenshot("04-after-click");

  // with reduced motion the click jumps straight back
  await ui.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await ui.sleep(1500);
  await wheel(240, 4);
  const still = await read();
  if (still.shown) {
    const rt = qa.states.reducedTransition = await ui.eval(TRANSITION);
    check("reduced motion: no transition on the line", !!rt && rt.duration.split(',').every(d => parseFloat(d) === 0), rt);
    const rOut = await fadeRun(-20, s => !s.shown);
    const rIn = await fadeRun(20, s => s.shown);
    qa.states.reducedFade = { out: rOut, in: rIn };
    check("reduced motion: it goes and comes back at once (no opacity between 0 and 1)", !between(rOut, 'o').length && !between(rIn, 'o').length && rIn.at(-1).o === 1, { out: between(rOut, 'o'), in: between(rIn, 'o'), end: rIn.at(-1) });
    await wheel(240, 2);
    await ui.eval(`(() => { const s = document.querySelector('${LIST} > .monaco-scrollable-element > .scrollbar.vertical > .slider'); window.__dispatchSamples = []; const t0 = performance.now(); const f = () => { window.__dispatchSamples.push(parseFloat(s.style.top) || 0); if (performance.now() - t0 < 1500) requestAnimationFrame(f); }; requestAnimationFrame(f); })()`);
    await ui.eval(SAMPLE(1200));
    await ui.click({ css: ".monaco-tree-sticky-row.dispatch-sticky-ask .interactive-item-container" });
    await ui.sleep(1400);
    const jump = [...new Set(await ui.eval(`window.__dispatchSamples`))];
    const rGhost = (await ui.eval(`window.__dispatchFade`)).filter(x => x.g !== null);
    const after = await read();
    check("reduced motion: the click jumps straight back (no steps on the way)", jump.length <= 2 && !after.shown && after.asks.some(a => a.text === ASK1 && a.top >= 0), { jump, shown: after.shown });
    check("reduced motion: the line taken away leaves no fading copy", !rGhost.length, rGhost.slice(0, 5));
  } else {
    check("reduced motion: the line is pinned before the click", false, still);
  }
  await ui.cdp.send("Emulation.setEmulatedMedia", { features: [] });
  await ui.sleep(800);

  // 4. the second ask in the same session: the line pins the message of the part you are reading
  await send(ASK2);
  await toTop();
  await ui.eval(SAMPLE(240000));
  const seen = [];
  for (let i = 0; i < 80; i++) {
    await wheel(160);
    const s = await read();
    if (s.shown) seen.push({ text: s.barText === ASK1 ? 1 : s.barText === ASK2 ? 2 : s.barText, asks: s.asks.map(a => [a.text === ASK1 ? 1 : a.text === ASK2 ? 2 : '?', a.top, a.bottom]) });
    if (seen.length && seen.at(-1).text === 2 && seen.filter(x => x.text === 2).length > 3) break;
  }
  qa.states.seen = seen;
  // the line of the first message is taken away while shown as the second comes up: it leaves a copy that fades out
  const copies = qa.states.copies = await ui.eval(`(() => { window.__dispatchFadeRun = null; return window.__dispatchFade.filter(x => x.g !== null); })()`);
  await ui.sleep(600);
  check("when the second message takes over, the first line fades out as a copy (150 ms, then gone)", copies.length >= 2 && copies.every(x => x.ga === 'dispatch-sticky-ask-out') && copies.some(x => x.g > 0.04 && x.g < 0.96) && !(await ui.exists({ css: ".dispatch-sticky-ask-ghost" })), copies.slice(0, 20));
  const firstTwo = seen.findIndex(x => x.text === 2);
  check("in the first reply the line says the first message", seen.some(x => x.text === 1), seen.slice(0, 3));
  check("in the second reply the line says the second message", firstTwo >= 0, seen.slice(-3));
  check("it never says the second before the first is passed", firstTwo < 0 || seen.slice(firstTwo).every(x => x.text === 2), seen.map(x => x.text));
  check("whenever a line is pinned, its message is not on screen below it", seen.every(x => !x.asks.some(a => a[0] === x.text && a[2] > 29)), seen);
  const second = qa.states.second = await read();
  check("a short message also starts at the column's left, the ↑ at the row's end", second.shown && second.barText === ASK2 && second.words && second.words.left === 0 && second.dir === "row", { text: second.barText, words: second.words, dir: second.dir });
  await ui.screenshot("05-second-ask-pinned");

  // 5. back to the very top: the line goes
  await toTop();
  const end = qa.states.end = await read();
  check("scrolled back to the top: the line is gone", !end.shown, end);

  // 6. Rename… in the title bar's menu: the title row is gone, so it asks for the name in a box
  await ui.click({ css: ".dispatch-place" });
  await ui.sleep(600);
  await ui.click({ text: "Rename…", within: ".context-view" });
  await ui.sleep(800);
  const box2 = await ui.eval(`(() => { const q = document.querySelector('.quick-input-widget'); const shown = !!q && getComputedStyle(q).display !== 'none'; const input = q && q.querySelector('input'); return { shown, value: input ? input.value : '' }; })()`);
  check("Rename… asks for the name in a box (the title row is not there to edit)", box2.shown && !!box2.value, box2);
  await ui.screenshot("06-rename-box");
  await ui.press("Escape");
  await ui.sleep(400);

  // 7. the session's own ⋯ menu was on the title row; its actions are in the title bar's menu now. First what the old
  //    ⋯ held: the row shown again for a moment (the class that hides it taken off), its More Actions opened and read.
  const MENU_LABELS = `(() => { const all = (root, out) => { root.querySelectorAll('.context-view .action-menu-item .action-label, .monaco-menu .action-menu-item .action-label').forEach(e => out.push(e)); root.querySelectorAll('*').forEach(e => e.shadowRoot && all(e.shadowRoot, out)); return out; }; return [...new Set(all(document, []).filter(e => e.getClientRects().length).map(e => e.textContent.trim()).filter(Boolean))]; })()`;
  const VIEW = ".session-view.is-active";
  await ui.eval(`document.querySelector('${VIEW}').classList.remove('dispatch-sole-session')`);
  await ui.sleep(600);
  let oldMenu = [];
  if (await ui.exists({ css: `${VIEW} .chat-composite-bar-header .codicon-toolbar-more` })) {
    await ui.click({ css: `${VIEW} .chat-composite-bar-header .codicon-toolbar-more` });
    await ui.sleep(700);
    oldMenu = await ui.eval(MENU_LABELS);
    await ui.press("Escape");
    await ui.sleep(400);
  }
  await ui.eval(`document.querySelector('${VIEW}').classList.add('dispatch-sole-session')`);
  await ui.sleep(600);
  qa.states.oldMenu = oldMenu;
  check("the old ⋯ menu could be read for comparison", oldMenu.length > 0, oldMenu);

  const openPlace = async () => { await ui.click({ css: ".dispatch-place" }); await ui.sleep(700); return ui.eval(MENU_LABELS); };
  const placeMenu = qa.states.placeMenu = await openPlace();
  await ui.screenshot("07-title-bar-menu");
  await ui.mark({ css: ".dispatch-place" }, { what: "标题栏会话名的下拉菜单：原来对话上面 ⋯ 里的 New Chat in This Session、Show Chat Tabs、Pin、Close 等挪到这里", where: "标题栏中间", how: "点会话名" });
  // the old menu's Rename... and Archive ("Mark as Done", the same command) are the menu's own Rename… and Archive
  const missing = oldMenu.filter(l => !/^Rename/.test(l) && !(l === "Mark as Done" && placeMenu.includes("Archive")) && !placeMenu.includes(l));
  check("everything the old ⋯ menu held is in the title bar's menu", !missing.length, { missing, oldMenu, placeMenu });
  check("Pin and Close are there", placeMenu.includes("Pin") && placeMenu.includes("Close"), placeMenu);
  check("Rename is there once, Archive once (no doubles from the ⋯ menu)", placeMenu.filter(l => /^Rename/.test(l)).length === 1 && placeMenu.filter(l => l === "Archive").length <= 1, placeMenu);

  // Pin: click it, the menu then offers Unpin; Unpin puts it back
  await ui.click({ text: "Pin", exact: true, within: ".context-view" });
  await ui.sleep(800);
  const pinned = await openPlace();
  check("Pin works: the menu now offers Unpin", pinned.includes("Unpin") && !pinned.includes("Pin"), pinned);
  await ui.click({ text: "Unpin", exact: true, within: ".context-view" });
  await ui.sleep(800);
  const unpinned = await openPlace();
  check("Unpin works: Pin is back", unpinned.includes("Pin") && !unpinned.includes("Unpin"), unpinned);

  // New Chat in This Session: a new, empty chat in the same session
  const chats = () => ui.eval(`(() => ({ tabs: [...document.querySelectorAll('${VIEW} .chat-composite-bar-tab')].filter(t => t.getClientRects().length).length, asks: [...document.querySelectorAll('${VIEW} .interactive-session .interactive-list .monaco-list-rows .monaco-list-row.request')].filter(r => r.getClientRects().length).length, place: (document.querySelector('.dispatch-place')?.innerText || '').replace(/\\s+/g, ' ').trim() }))()`);
  if (unpinned.includes("New Chat in This Session")) {
    const before = await chats();
    await ui.click({ text: "New Chat in This Session", exact: true, within: ".context-view" });
    await ui.sleep(2000);
    const after = qa.states.newChat = { before, after: await chats() };
    check("New Chat in This Session works: a second chat, empty, in the same session", after.after.tabs > before.tabs && after.after.asks === 0 && after.after.place === before.place, after);
    await ui.screenshot("08-new-chat");
  } else {
    await ui.press("Escape");
    // OpenCode sessions have one chat (only Claude, Codex and Copilot advertise multipleChats): neither menu offers it
    check("New Chat in This Session: not offered for this OpenCode session, and the old ⋯ menu did not offer it either", !oldMenu.includes("New Chat in This Session"), { oldMenu, placeMenu: unpinned });
  }

  if (qa.failed.length) throw new Error(`${qa.failed.length} check(s) failed: ${qa.failed.join(" | ").slice(0, 1500)}`);
}
