// The Task graph slides sideways (kanban task-e1qsa, preference 「任务图左右滑动」): every day is a slot side by side, the
// day under the focus is open by the hour, the rest folded; a trackpad swipe, Shift and the wheel, a drag, a click on a
// day or the arrow keys move the focus, and the page glides to the nearest day when the movement stops. World:
// fixtures/task_graph_days.py (51 tasks in 8 things over 26 days). Real wheel and mouse events through CDP, the DOM read
// after each (which day is open, which are folded, whether the open day is whole in the viewport), and a
// requestAnimationFrame sampler over a long swipe for the frame times.
import { writeFileSync } from "node:fs";

export const meta = {
  instance: { fixture: "task-graph-days", motion: true },
  timeout: 900,
  title: "Task graph 左右滑动",
  description: "Task graph 的时间轴一天一格、左右滑动：触控板横滑、Shift 加滚轮、拖拽、点某天、方向键；滑到哪天哪天展开、其他天收起，默认停今天，停手后滑到最近的一天；右列标题放宽到 360。",
};

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);

function closeTipsBeforePictures(ui) {
  const shoot = ui.screenshot.bind(ui);
  ui.screenshot = async (...args) => {
    for (let i = 0; i < 4 && (await ui.exists({ css: ".dispatch-tour-close" })); i++) { await ui.click({ css: ".dispatch-tour-close" }); await ui.sleep(400); }
    return shoot(...args);
  };
}

const STATE = `(() => {
  const g = document.querySelector('.dispatch-tg');
  const vp = g.querySelector('.dispatch-tg-axisview').getBoundingClientRect();
  const cells = [...g.querySelectorAll('.dispatch-tg-daycell')].map(c => { const r = c.getBoundingClientRect(); return { day: +c.dataset.day, e: +c.dataset.e, w: Math.round(r.width * 10) / 10, l: Math.round(r.left * 10) / 10, r: Math.round(r.right * 10) / 10 }; });
  return { g: +g.dataset.g, pan: +g.dataset.pan, focus: +g.dataset.focus, frameMs: g.dataset.frameMs ? +g.dataset.frameMs : null, vp: { l: vp.left, r: vp.right, w: vp.width }, cells,
    marks: g.querySelectorAll('.mk').length };
})()`;

async function resize(ui, w, h) {
  await ui.eval(`window.resizeTo(${w}, ${h})`);
  for (let i = 0; i < 20 && (await ui.eval("innerWidth")) !== w; i++) await ui.sleep(250);
  await ui.sleep(1500);
}

export default async function (ui) {
  closeTipsBeforePictures(ui);
  const out = { checks: [] };
  const check = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); if (!ok) { writeFileSync(`${ui.out}/result.json`, JSON.stringify(out, null, 1)); throw new Error(`${name}: ${JSON.stringify(detail)}`); } };
  await ui.openAgents(ui.rec.folder || ui.demoFolder);
  await resize(ui, 1440, 900);
  await ui.setTheme("dark");
  await ui.newSession();
  await ui.openTab("Tasks");
  await ui.waitFor({ css: ".dispatch-tasks-graph" }, { timeoutMs: 60000 * SCALE });
  await ui.click({ css: ".dispatch-tasks-graph" });
  await ui.waitFor({ css: ".dispatch-tg-empty, .dispatch-tg-lane" }, { timeoutMs: 60000 * SCALE });
  if (!(await ui.exists({ css: ".dispatch-tg-lane" })) || (await ui.exists({ css: ".dispatch-tg-empty" }))) {
    // the new session has no tasks of its own: the page may open on its empty state; go to the project
    for (let i = 0; i < 4 && (await ui.exists({ css: ".dispatch-tour-close" })); i++) { await ui.click({ css: ".dispatch-tour-close" }); await ui.sleep(400); }
    await ui.click({ css: ".dispatch-tg-seg-btn", index: 1 });
  }
  await ui.waitFor({ css: ".dispatch-tg-lane" }, { timeoutMs: 60000 * SCALE });
  await ui.sleep(1500);
  const size = await ui.eval("[innerWidth, innerHeight]");
  out.window = size;

  const state = () => ui.eval(STATE);
  const settled = async (what, ms = 4000 * SCALE) => {
    let last = JSON.stringify((await state()).g), still = 0;
    for (const end = Date.now() + ms; Date.now() < end; await ui.sleep(120)) {
      const g = JSON.stringify((await state()).g);
      still = g === last ? still + 120 : 0;
      last = g;
      if (still >= 500) { return state(); }
    }
    throw new Error(`the page did not settle (${what})`);
  };
  // one day open whole and the rest folded, the open one whole inside the viewport
  const oneOpen = (s, what) => {
    const open = s.cells.filter(c => c.e > 0.999);
    const shut = s.cells.filter(c => c.e === 0);
    check(`${what}: exactly one day is open, the rest folded`, open.length === 1 && shut.length === s.cells.length - 1, { open: open.length, shut: shut.length, days: s.cells.length });
    const o = open[0];
    check(`${what}: the open day is whole inside the viewport`, o.l >= s.vp.l - 1.5 && o.r <= s.vp.r + 1.5, { l: o.l, r: o.r, vp: s.vp });
    check(`${what}: folded days are narrow, the open one wide`, shut.every(c => c.w >= 30 && c.w <= 130) && o.w >= (o === s.cells[s.cells.length - 1] ? 90 : 250), { open: o.w, shut: [Math.min(...shut.map(c => c.w)), Math.max(...shut.map(c => c.w))] });
    return o;
  };
  const dayName = (t) => new Date(t * 1000).toDateString();

  // ---- the page as it opens: today open, the page at the end, titles whole ----
  const s0 = await state();
  out.opens = { days: s0.cells.length, g: s0.g, pan: s0.pan, focus: dayName(s0.focus), chart: s0.vp.w };
  const today = oneOpen(s0, "on open");
  check("on open: the open day is today, the page is at the end", today.day === s0.cells[s0.cells.length - 1].day && s0.g === 1, { g: s0.g, focus: dayName(s0.focus) });
  check("on open: 26 days of tasks are 26 slots", s0.cells.length >= 26, s0.cells.length);
  const titles = await ui.eval(`[...document.querySelectorAll('.dispatch-tg-now-title')].map(t => ({ text: t.textContent, cut: t.parentElement.scrollWidth > t.parentElement.clientWidth + 1, w: Math.round(t.parentElement.clientWidth) }))`);
  out.titles = { rows: titles.length, cut: titles.filter(t => t.cut).map(t => t.text), column: titles[0]?.w };
  await ui.screenshot("01-before-today");
  await ui.mark({ css: ".dispatch-tg-axisview" }, { what: "一天一格的时间轴，今天展开", where: "图顶上一排", how: "触控板左右滑、Shift 加滚轮或拖拽；点某一天直接展开它" });
  await ui.mark({ css: ".dispatch-tg-now", index: 0 }, { what: "右列加宽，标题一行放得下", where: "右列", how: "悬停出完整详情" });

  const chart = await ui.eval(`(() => { const r = document.querySelector('.dispatch-tg-axisview').getBoundingClientRect(); const l = document.querySelector('.dispatch-tg-lane .dispatch-tg-chart').getBoundingClientRect(); return { x: r.left + r.width / 2, ay: r.top + 20, ly: l.top + l.height / 2, left: r.left, right: r.right }; })()`);
  // a trackpad swipe: wheel events 16 ms apart, the deltas dying away
  const swipe = async (total, { x = chart.x, y = chart.ly, shift = false, n = 36, gap = 16 } = {}) => {
    const w = Array.from({ length: n }, (_, i) => Math.exp(-i / (n / 3)));
    const sum = w.reduce((a, b) => a + b, 0);
    for (const k of w) {
      await ui.mouse("mouseWheel", x, y, { deltaX: shift ? 0 : (total * k) / sum, deltaY: shift ? (total * k) / sum : 0, modifiers: shift ? 8 : 0 });
      await ui.sleep(gap);
    }
  };

  // ---- 1. a swipe back in time: the page follows, then glides to a day and rests there ----
  await swipe(-340);
  const mid1 = await state();
  const s1 = await settled("swipe back");
  const o1 = oneOpen(s1, "after a swipe back");
  check("after a swipe back: it is an earlier day, not today", o1.day < today.day && s1.g < 1, { focus: dayName(s1.focus), g: s1.g });
  check("after a swipe back: the focus is exactly a day's own (rests on a day)", s1.g === s0.cells.map((_, i) => i / (s0.cells.length - 1)).map(v => Math.round(v * 1e4) / 1e4).find(v => Math.abs(v - s1.g) < 1e-4), s1.g);
  out.swipeBack = { duringG: mid1.g, restG: s1.g, focus: dayName(s1.focus), openW: o1.w, dayW: s1.cells.find(c => c.e === 0).w };
  await ui.screenshot("02-middle");
  await ui.mark({ css: ".dispatch-tg-axisview" }, { what: "滑到哪天哪天展开", where: "图顶上一排", how: "其余天收成一格，停手后停在最近的一天" });

  // a mark's card still works on the open day, at its new place
  const hits = await ui.eval(`[...document.querySelectorAll('.dispatch-tg-hit')].map(h => { const r = h.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, shown: getComputedStyle(h).display !== 'none' }; }).filter(h => h.shown && h.x > ${chart.left + 20} && h.x < ${chart.right - 20})`);
  if (hits.length) {
    const h = hits[Math.min(2, hits.length - 1)];
    await ui.mouse("mouseMoved", h.x, h.y, { button: "none" });
    await ui.waitFor({ css: ".workbench-hover-container" }, { timeoutMs: 6000 * SCALE }).catch(() => null);
    out.cardAfterSlide = await ui.exists({ css: ".workbench-hover-container" });
    await ui.screenshot("03-card-on-open-day");
    await ui.mouse("mouseMoved", chart.x, chart.ay, { button: "none" });
    await ui.sleep(400);
  }

  // ---- 2. a drag in the chart: the focus follows the pointer, it rests on a day when let go ----
  const drag = async (dx, { steps = 14, y = chart.ly } = {}) => {
    const x0 = chart.x;
    await ui.mouse("mouseMoved", x0, y, { button: "none" });
    await ui.mouse("mousePressed", x0, y, { clickCount: 1, buttons: 1 });
    for (let i = 1; i <= steps; i++) {
      await ui.mouse("mouseMoved", x0 + (dx * i) / steps, y, { buttons: 1 });
      await ui.sleep(16);
    }
    const during = await state();
    await ui.mouse("mouseReleased", x0 + dx, y, { clickCount: 1, buttons: 0 });
    return during;
  };
  const before2 = await state();
  const during2 = await drag(150);   // to the right: back in time
  const s2 = await settled("drag back");
  const o2 = oneOpen(s2, "after a drag");
  check("a drag to the right goes back in time", s2.g < before2.g && during2.g < before2.g, { before: before2.g, during: during2.g, rest: s2.g });
  check("the drag did not open a task page", !(await ui.exists({ css: ".dispatch-task-page" })), null);
  out.drag = { before: before2.g, during: during2.g, rest: s2.g, focus: dayName(s2.focus), openW: o2.w };
  const toLeft = await drag(-120);
  const s2b = await settled("drag forward");
  check("a drag to the left goes forward in time", s2b.g > s2.g, { was: s2.g, now: s2b.g });
  oneOpen(s2b, "after a drag forward");

  // ---- 3. Shift and the (vertical) wheel ----
  const before3 = await state();
  await swipe(-160, { shift: true, n: 20 });
  const s3 = await settled("shift wheel");
  check("Shift and the wheel move it sideways too", s3.g !== before3.g, { was: before3.g, now: s3.g });
  oneOpen(s3, "after Shift and the wheel");
  // a plain vertical wheel is not ours: the page scrolls, the focus stays
  const before3b = await state();
  await ui.mouse("mouseWheel", chart.x, chart.ly, { deltaX: 0, deltaY: 120 });
  await ui.sleep(700);
  check("a vertical wheel turn leaves the focus alone", (await state()).g === before3b.g, before3b.g);

  // ---- 4. a click on a day opens it, gliding there ----
  const target = s3.cells.filter(c => c.e === 0).sort((a, b) => Math.abs(a.l - (chart.left + 120)) - Math.abs(b.l - (chart.left + 120)))[0];
  await ui.mouse("mouseMoved", (target.l + target.r) / 2, chart.ay, { button: "none" });
  await ui.mouse("mousePressed", (target.l + target.r) / 2, chart.ay, { clickCount: 1 });
  await ui.mouse("mouseReleased", (target.l + target.r) / 2, chart.ay, { clickCount: 1 });
  const on = await state();
  const s4 = await settled("click a day");
  const o4 = oneOpen(s4, "after a click on a day");
  check("the day clicked is the open one", o4.day === target.day, { want: dayName(target.day), got: dayName(o4.day) });
  out.click = { day: dayName(target.day), gAtOnce: on.g, rest: s4.g };

  // ---- 5. arrow keys: one day ----
  await ui.eval("document.querySelector('.dispatch-tg').setAttribute('tabindex', '-1'), document.querySelector('.dispatch-tg').focus()");
  await ui.press("ArrowRight");
  const s5 = await settled("arrow right");
  const o5 = oneOpen(s5, "after ArrowRight");
  const i4 = s4.cells.findIndex(c => c.day === o4.day);
  check("ArrowRight opens the next day", o5.day === s4.cells[i4 + 1].day, { was: dayName(o4.day), now: dayName(o5.day) });

  // ---- 6. the frames of a long swipe: back across the month and forth again ----
  await ui.eval(`(() => { window.__fr = { t: [], on: true }; const f = ts => { if (!window.__fr.on) return; window.__fr.t.push(ts); requestAnimationFrame(f); }; requestAnimationFrame(f); })()`);
  let worstApply = 0;
  const watch = async () => { const m = (await state()).frameMs; if (m && m > worstApply) worstApply = m; };
  for (let rep = 0; rep < 2; rep++) {
    const total = rep % 2 ? 1400 : -1400;
    const n = 90;
    for (let i = 0; i < n; i++) {
      await ui.mouse("mouseWheel", chart.x, chart.ly, { deltaX: (total / n) * 2 * (1 - i / n), deltaY: 0 });
      await ui.sleep(16);
      if (i % 15 === 0) await watch();
    }
  }
  const s6 = await settled("long swipe");
  oneOpen(s6, "after a long swipe");
  const frames = await ui.eval(`(() => { window.__fr.on = false; const t = window.__fr.t; const d = []; for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]); d.sort((a, b) => a - b); const q = p => d[Math.min(d.length - 1, Math.floor(p * d.length))];
    return { n: d.length, p50: +q(.5).toFixed(1), p95: +q(.95).toFixed(1), p99: +q(.99).toFixed(1), max: +d[d.length - 1].toFixed(1), over20: d.filter(x => x > 20).length, over34: d.filter(x => x > 34).length }; })()`);
  out.frames = { ...frames, worstApplyMs: worstApply };

  // ---- 7. back to today: swipe forward until the page is at the end ----
  for (let i = 0; i < 6 && (await state()).g < 1; i++) {
    await swipe(1500, { n: 24 });
    await settled("towards today");
  }
  const s7 = await settled("today again");
  const o7 = oneOpen(s7, "back at today");
  check("back at today the page is at the end again", o7.day === s0.cells[s0.cells.length - 1].day && s7.g === 1, { g: s7.g });
  await ui.screenshot("04-back-to-today");

  // ---- 8. reduced motion: the same moves are jumps ----
  await ui.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await ui.sleep(300);
  await swipe(-500, { n: 6 });
  await ui.sleep(120);
  const s8 = await settled("reduced");
  oneOpen(s8, "reduced motion");
  out.reduced = { g: s8.g, focus: dayName(s8.focus) };
  await ui.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });

  // ---- 9. a narrow window (900) and the light theme: the same page, the chart narrower, the right column smaller ----
  await resize(ui, 900, 800);
  const narrow = await state();
  out.narrow = { innerWidth: await ui.eval("innerWidth"), chart: narrow.vp.w, days: narrow.cells.length, g: narrow.g };
  oneOpen(narrow, "in a narrow window");
  await ui.press("ArrowLeft");
  await settled("narrow arrow");
  await ui.screenshot("05-narrow-900-middle");
  await ui.setTheme("light");
  await ui.sleep(600);
  await ui.screenshot("06-light-900-middle");
  await resize(ui, 1440, 900);
  await ui.screenshot("07-light-1440-middle");
  writeFileSync(`${ui.out}/result.json`, JSON.stringify(out, null, 1));
  return out;
}
