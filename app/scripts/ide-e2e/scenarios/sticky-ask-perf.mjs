// How smooth the pinned line at the top of the conversation is (task-vk9nq, the one line of task-wdjpl / sticky-ask
// B): the user saw a hitch when it appears. A real OpenCode session on a cheap model answers two long lists, then the
// conversation is wheeled down to the bottom and back up three times at a steady pace (30px every 16 ms, like a
// trackpad) while the page records every frame (requestAnimationFrame), the long tasks and the long animation frames,
// and the moments the line appears, goes and changes to the other message. One more pass runs under a DevTools trace,
// and every frame over 16.7 ms is broken down into what the main thread did in it (script, style, layout, paint, and
// the stack that forced a layout). Numbers go to qa.json (perf; noBlur is the same passes with the line's blur off); the run fails when a frame at the moment the line
// appears or goes, or while scrolling, is over 33 ms.
export const meta = { needs: ['opencode'], instance: { motion: true },
  title: "钉住那一行出现、消失时的帧时间",
  description: "真实 OpenCode 会话回两段长列表，滚轮匀速（每 16ms 30px）从顶滚到底再滚回顶，来回三遍，页面里逐帧记 requestAnimationFrame、long task 和 long animation frame，记下那一行出现、消失、换句的那一帧；再在 DevTools trace 下滚一遍，把每个超过 16.7ms 的帧拆成脚本、样式、布局、绘制和强制布局的调用栈。数写进 qa.json 的 perf；出现、消失那一刻或滚动中有超过 33ms 的帧就判失败。",
  timeout: 1500,
};

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { until, offscreen, onDemo, toDemo, focusInput, chooseCheapModel, closeTips } from "./session-now.mjs";

const ASK1 = "Reply with a plain numbered list of 60 lines, 1 to 60, one short sentence per line about the number. No tools, no headings.";
const ASK2 = "Now continue the same list from 61 to 120, same style. No tools, no headings.";
const LIST = ".interactive-session .interactive-list > .monaco-list";
const STEP = 30;
const PACE = 16;
const BUDGET = 33.4; // two frames at 60 Hz: the goal is no frame longer than this
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** In the page: record every frame, long tasks, long animation frames and the pinned line's state per frame. Only
 *  cheap reads (classList, attributes, style.top), so the recorder itself never forces a layout. */
const START = `(() => {
  const list = document.querySelector('${LIST}');
  const P = window.__dispatchPerf = { frames: [], marks: [], longtasks: [], loaf: [], on: true, t0: performance.now() };
  const sc = list.querySelector(':scope > .monaco-scrollable-element > .monaco-tree-sticky-container');
  const state = () => {
    const row = sc && sc.querySelector(':scope > .monaco-tree-sticky-row');
    if (!row || sc.classList.contains('empty')) return 'none';
    return (row.classList.contains('source-node-partially-visible') ? 'hidden:' : 'shown:') + row.getAttribute('data-index');
  };
  let last = state();
  P.marks.push({ t: P.t0, s: last });
  const f = (t) => {
    P.frames.push(t);
    const s = state();
    if (s !== last) { P.marks.push({ t, s, from: last }); last = s; }
    if (P.on) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
  try {
    P.obs1 = new PerformanceObserver(l => { for (const e of l.getEntries()) P.longtasks.push({ t: e.startTime, d: e.duration }); });
    P.obs1.observe({ type: 'longtask' });
  } catch {}
  try {
    P.obs2 = new PerformanceObserver(l => { for (const e of l.getEntries()) P.loaf.push({ t: e.startTime, d: e.duration, render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0, styleLayout: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0, scripts: (e.scripts || []).map(s => ({ d: Math.round(s.duration), forced: Math.round(s.forcedStyleAndLayoutDuration), fn: s.sourceFunctionName, url: (s.sourceURL || '').split('/').slice(-2).join('/'), at: s.sourceCharPosition, invoker: s.invoker })) }); });
    P.obs2.observe({ type: 'long-animation-frame' });
  } catch {}
  performance.mark('dispatch-perf-start');
  return P.t0;
})()`;
const STOP = `(() => { const P = window.__dispatchPerf; P.on = false; P.obs1 && P.obs1.disconnect(); P.obs2 && P.obs2.disconnect(); return { frames: P.frames, marks: P.marks, longtasks: P.longtasks, loaf: P.loaf, t0: P.t0 }; })()`;

/** Frame intervals and the frames at each change of the pinned line. */
function analyse(rec, from, to) {
  const frames = rec.frames.filter(t => t >= from && t <= to);
  const gaps = frames.slice(1).map((t, i) => ({ at: frames[i], d: t - frames[i] }));
  const ds = gaps.map(g => g.d).sort((a, b) => a - b);
  const pct = p => ds.length ? ds[Math.min(ds.length - 1, Math.floor(p * ds.length))] : 0;
  const round = x => Math.round(x * 10) / 10;
  // the gap the change landed in and the one after it (the change is seen at the start of a frame; its cost is in the
  // gap before when it came from the wheel event, in the gap after when it is drawn)
  const around = (t) => {
    const i = frames.indexOf(t);
    const before = i > 0 ? frames[i] - frames[i - 1] : 0;
    const after = i >= 0 && i < frames.length - 1 ? frames[i + 1] - frames[i] : 0;
    return round(Math.max(before, after));
  };
  const kind = (m) => {
    const was = (m.from || '').split(':'), now = m.s.split(':');
    if (now[0] === 'shown' && was[0] === 'shown') return 'switch';
    if (now[0] === 'shown') return was[0] === 'hidden' && was[1] === now[1] ? 'appear' : 'appear-new';
    if (was[0] === 'shown') return 'go';
    return 'quiet';
  };
  const changes = rec.marks.filter(m => m.from !== undefined && m.t >= from && m.t <= to).map(m => ({ kind: kind(m), s: m.s, from: m.from, frame: around(m.t), at: round(m.t - rec.t0) }));
  const loud = changes.filter(c => c.kind !== 'quiet');
  return {
    frames: frames.length, seconds: round((to - from) / 1000),
    median: round(pct(0.5)), p95: round(pct(0.95)), p99: round(pct(0.99)), max: round(ds.at(-1) || 0),
    // a 120 Hz screen draws every 8.3 ms: 12.5 or more is at least one frame missed
    missed: ds.filter(d => d >= 12.5).length, over16: ds.filter(d => d > 16.7).length, over33: ds.filter(d => d > BUDGET).length,
    missedAtChange: loudFrames(rec, from, to).missed, missedElsewhere: ds.filter(d => d >= 12.5).length - loudFrames(rec, from, to).missed,
    longest: gaps.sort((a, b) => b.d - a.d).slice(0, 6).map(g => ({ at: round(g.at - rec.t0), d: round(g.d) })),
    appearMax: Math.max(0, ...loud.filter(c => c.kind.startsWith('appear')).map(c => c.frame)),
    goMax: Math.max(0, ...loud.filter(c => c.kind === 'go').map(c => c.frame)),
    switchMax: Math.max(0, ...loud.filter(c => c.kind === 'switch').map(c => c.frame)),
    changes,
  };
}

/** How many missed frames sit at a change of the line (the frame it changed in or the one after). */
function loudFrames(rec, from, to) {
  const frames = rec.frames.filter(t => t >= from && t <= to);
  const near = new Set();
  for (const m of rec.marks) {
    if (m.from === undefined || m.t < from || m.t > to || !(m.s.startsWith('shown') || (m.from || '').startsWith('shown'))) continue;
    const i = frames.indexOf(m.t);
    if (i > 0) near.add(i - 1);
    if (i >= 0) near.add(i);
  }
  let missed = 0;
  for (const i of near) if (i + 1 < frames.length && frames[i + 1] - frames[i] >= 12.5) missed++;
  return { missed };
}

/** Each frame over 16.7 ms of a traced pass, as what the renderer's main thread did in it. */
function breakdown(events, rec, startNow) {
  const markEv = events.find(e => e.name === 'dispatch-perf-start' && e.ph !== 'M');
  if (!markEv) return { error: 'no start mark in the trace' };
  const off = markEv.ts / 1000 - startNow; // trace ms = performance.now() + off
  const pid = markEv.pid, tid = markEv.tid;
  const main = events.filter(e => e.pid === pid && e.tid === tid && e.ph === 'X' && typeof e.dur === 'number');
  const names = ['EventDispatch', 'FunctionCall', 'TimerFire', 'FireAnimationFrame', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize', 'Commit', 'RunMicrotasks', 'ParseAuthorStyleSheet', 'HitTest', 'IntersectionObserverController::computeIntersections', 'ScheduleStyleRecalculation'];
  const gaps = rec.frames.slice(1).map((t, i) => ({ a: rec.frames[i], b: t })).filter(g => g.b - g.a >= 12.5 && g.a >= startNow);
  return gaps.slice(0, 40).map(g => {
    const a = (g.a + off) * 1000, b = (g.b + off) * 1000;
    const inside = main.filter(e => e.ts < b && e.ts + e.dur > a);
    const sum = {};
    for (const e of inside) if (names.includes(e.name)) sum[e.name] = Math.round((sum[e.name] || 0) + e.dur / 1000);
    const forced = inside.filter(e => (e.name === 'Layout' || e.name === 'UpdateLayoutTree') && e.args && (e.args.beginData?.stackTrace || e.args.data?.stackTrace)).map(e => ({ what: e.name, ms: Math.round(e.dur / 100) / 10, stack: (e.args.beginData?.stackTrace || e.args.data?.stackTrace).slice(0, 5).map(f => `${f.functionName || '(anon)'}@${(f.url || '').split('/').pop()}:${f.lineNumber}`) }));
    const events2 = inside.filter(e => e.name === 'EventDispatch').map(e => e.args?.data?.type);
    const calls = inside.filter(e => e.name === 'FunctionCall' && e.dur > 2000).map(e => ({ fn: e.args?.data?.functionName, url: (e.args?.data?.url || '').split('/').pop(), ms: Math.round(e.dur / 100) / 10 }));
    const tasks = inside.filter(e => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask').map(e => Math.round(e.dur / 100) / 10).filter(d => d > 4);
    return { at: Math.round(g.a - rec.t0), d: Math.round((g.b - g.a) * 10) / 10, tasks, sum, events: [...new Set(events2)], calls, forced: forced.slice(0, 6) };
  });
}

export default async function (ui) {
  const qa = { checks: [], failed: [], perf: {} };
  const note = () => fs.writeFileSync(path.join(ui.out, "qa.json"), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
    console.error(`${ok ? "ok" : "FAILED"}: ${name}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 600)}`);
    note();
  };
  const RUNNING = `!!document.querySelector('.interactive-input-part .chat-execute-toolbar .codicon-stop-circle, .sessions-list-control .dispatch-status-blocks.running')`;
  const turn = async (what) => {
    await until(ui, () => ui.eval(RUNNING), 90000, `${what}: the agent to start`, 500).catch(() => {});
    await until(ui, async () => !(await ui.eval(RUNNING)), 420000, `${what}: the turn to end`, 2000);
    await ui.sleep(3000);
  };
  const box = () => ui.eval(`(() => { const r = document.querySelector('${LIST}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: r.height }; })()`);
  const contentH = () => ui.eval(`parseFloat(document.querySelector('${LIST} .monaco-list-rows').style.height) || 0`);
  const slider = () => ui.eval(`parseFloat(document.querySelector('${LIST} > .monaco-scrollable-element > .scrollbar.vertical > .slider')?.style.top) || 0`);
  const wheel = (b, dy) => ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: b.x, y: b.y, deltaX: 0, deltaY: dy });
  const toTop = async () => { const b = await box(); for (let i = 0; i < 60 && (await slider()) > 0; i++) { for (let k = 0; k < 6; k++) await wheel(b, -600); await wait(120); } await wait(600); };
  /** Down to the bottom and back up at the steady pace; returns the page time it started and ended. */
  const sweep = async () => {
    const b = await box();
    const steps = Math.ceil(Math.max(0, (await contentH()) - b.h) / STEP) + 12;
    for (let i = 0; i < steps; i++) { await wheel(b, STEP); await wait(PACE); }
    await wait(150);
    for (let i = 0; i < steps; i++) { await wheel(b, -STEP); await wait(PACE); }
    await wait(300);
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
  await focusInput(ui, ".interactive-session .interactive-input-part");
  await ui.type(ASK2);
  await ui.press("Enter", { send: true });
  await turn("second ask");
  await ui.setTheme("light");
  await ui.sleep(1000);
  const items = await ui.eval(`document.querySelectorAll('.interactive-list .monaco-list-rows .interactive-response li').length`);
  qa.perf.content = { height: await contentH(), view: (await box()).h, items };
  check("the conversation is long enough to scroll well past both messages", qa.perf.content.height > qa.perf.content.view * 2, qa.perf.content);

  // warm up once (rows drawn once, fonts in), then three measured passes
  await toTop();
  await sweep();
  await toTop();
  await ui.sleep(1500);
  qa.perf.loadBefore = os.loadavg().map(x => Math.round(x * 10) / 10);
  const t0 = await ui.eval(START);
  for (let i = 0; i < 3; i++) await sweep();
  const rec = await ui.eval(STOP);
  qa.perf.loadAfter = os.loadavg().map(x => Math.round(x * 10) / 10);
  const passes = analyse(rec, t0, rec.frames.at(-1));
  qa.perf.measured = { ...passes, longtasks: rec.longtasks.map(l => ({ at: Math.round(l.t - rec.t0), d: Math.round(l.d) })), loaf: rec.loaf.slice(0, 20).map(l => ({ ...l, t: Math.round(l.t - rec.t0), d: Math.round(l.d), render: Math.round(l.render), styleLayout: Math.round(l.styleLayout) })) };
  note();
  console.error(`measured: max ${passes.max} ms, missed ${passes.missed} (at a change ${passes.missedAtChange}), over 16.7: ${passes.over16} of ${passes.frames}, over 33: ${passes.over33}, appear ${passes.appearMax}, go ${passes.goMax}, switch ${passes.switchMax}`);

  // the same three passes with the line's blur taken off, to see what the blur costs
  await toTop();
  await ui.eval(`(() => { const s = document.createElement('style'); s.id = 'dispatch-perf-noblur'; s.textContent = '.monaco-tree-sticky-row .interactive-item-container { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }'; document.head.appendChild(s); })()`);
  await ui.sleep(1000);
  const tb = await ui.eval(START);
  for (let i = 0; i < 3; i++) await sweep();
  const recb = await ui.eval(STOP);
  const nb = analyse(recb, tb, recb.frames.at(-1));
  qa.perf.noBlur = { frames: nb.frames, median: nb.median, p95: nb.p95, max: nb.max, missed: nb.missed, missedAtChange: nb.missedAtChange, over16: nb.over16, over33: nb.over33, appearMax: nb.appearMax, goMax: nb.goMax, switchMax: nb.switchMax };
  await ui.eval(`document.getElementById('dispatch-perf-noblur').remove()`);
  note();

  // one more pass under a trace: what each long frame was made of
  await toTop();
  await ui.sleep(1000);
  const events = [];
  ui.cdp.on("Tracing.dataCollected", p => events.push(...p.value));
  const done = new Promise(r => ui.cdp.on("Tracing.tracingComplete", r));
  await ui.cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { recordMode: "recordAsMuchAsPossible", includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.stack", "blink.user_timing", "toplevel"] } });
  const t1 = await ui.eval(START);
  await sweep();
  const rec2 = await ui.eval(STOP);
  await ui.cdp.send("Tracing.end");
  await Promise.race([done, wait(30000)]);
  qa.perf.traced = { ...analyse(rec2, t1, rec2.frames.at(-1)), frames_over_16: breakdown(events, rec2, t1) };
  note();

  const m = qa.perf.measured;
  check("the line appeared, went and changed to the other message during the passes", m.changes.some(c => c.kind.startsWith('appear')) && m.changes.some(c => c.kind === 'go'), m.changes.map(c => c.kind));
  check(`the frame the line appears in is at most ${BUDGET} ms`, m.appearMax <= BUDGET, m.appearMax);
  check(`the frame the line goes in is at most ${BUDGET} ms`, m.goMax <= BUDGET, m.goMax);
  check(`the frame the line changes to the other message in is at most ${BUDGET} ms`, m.switchMax <= BUDGET, m.switchMax);
  check(`no frame over ${BUDGET} ms while scrolling`, m.over33 === 0, { max: m.max, over33: m.over33, longest: m.longest });
  if (qa.failed.length) throw new Error(`${qa.failed.length} check(s) failed: ${qa.failed.join(" | ").slice(0, 1500)}`);
}
