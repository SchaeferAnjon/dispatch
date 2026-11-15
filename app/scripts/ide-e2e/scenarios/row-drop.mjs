// A running session's small icon is design/icon-motion's 落块 as it is (user 2026-11-15, task-dw425): in a real
// session's row (and wherever else the running icon shows: the title bar, the Now tab's head) the ten blocks fall 220ms
// apart from above, faster and faster, bounce twice, the full icon rests 1s, empties and falls again. Read frame by
// frame from the page (each block's transform on every animation frame), written to frames.json; zoomed crops of the
// row on disk. Reduce motion: the icon is still. The real session runs on OpenCode with a cheap model, never Claude.
export const meta = { instance: { motion: true }, needs: ['opencode'], timeout: 900,
  title: "会话行在跑时的落块：方案三原样",
  description: "真会话在跑时，左栏会话行的小图标十块 220ms 一块从上面落下、越落越快、落地弹两下，落满停 1 秒清空再来；逐帧读每块的位置存 frames.json；标题栏和 Now 头的同一个图标不压到别的字；减少动态效果时静止。",
};

import fs from "node:fs";
import path from "node:path";
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const results = [];
const check = (name, ok, got) => { results.push({ name, ok: !!ok, got }); if (!ok) throw new Error(`${name}: ${JSON.stringify(got)}`); };

async function offscreen(ui) {
  try {
    const { windowId } = await ui.cdp.send("Browser.getWindowForTarget", {});
    await ui.cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: -3000, top: -3000 } });
  } catch { /* no Browser domain on this page: leave it */ }
}
async function onDemo(ui) {
  const st = path.join(ui.rec.root || path.dirname(path.dirname(ui.demoFolder)), "agents-user-data", "User", "settings.json");
  if (fs.existsSync(st)) { const j = JSON.parse(fs.readFileSync(st, "utf8") || "{}"); j["dispatch.tips.enabled"] = false; fs.writeFileSync(st, JSON.stringify(j, null, 1)); await ui.sleep(1500); }
  try { await ui.openAgents(ui.demoFolder); } catch (e) {
    if (!/editor window/.test(String(e && e.message))) throw e;
    await ui.click({ aria: "Editor" });
    await ui.sleep(8000);
    await ui.openAgents(ui.demoFolder);
  }
}
async function toDemo(ui) {
  for (let i = 0; i < 4 && await ui.exists({ css: ".dispatch-tour-close" }); i++) { await ui.click({ css: ".dispatch-tour-close" }); await ui.sleep(400); }
  const FOLDER = ".sessions-workspace-picker-trigger .action-label";
  const folderNow = async () => (await ui.eval(`document.querySelector('${FOLDER}')?.innerText.trim() || ''`)) || "";
  for (let i = 0; i < 3 && !/^demo\b/.test(await folderNow()); i++) {
    await ui.sleep(1500);
    for (let j = 0; j < 6 && await ui.exists({ css: ".dispatch-tour-close" }); j++) { await ui.click({ css: ".dispatch-tour-close" }); await ui.sleep(500); }
    await ui.click({ css: FOLDER });
    await ui.sleep(1200);
    if (await ui.exists({ text: "demo", exact: true, within: ".action-widget" })) await ui.click({ text: "demo", exact: true, within: ".action-widget" });
    else await ui.press("Escape");
    await ui.sleep(1200);
  }
  const where = await folderNow();
  assert(/^demo\b/.test(where), "the new session is not in the demo project, refusing to send: " + where);
}
async function until(ui, fn, timeoutMs, what, every = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs * SCALE) { const v = await fn(); if (v) return v; await ui.sleep(every); }
  throw new Error(`timed out waiting for ${what}`);
}
const MENU = ".dispatch-slash-menu";
const inputText = (ui, input) => ui.eval(`(document.querySelector('${input} .view-lines')?.innerText || '').replace(/\\u00a0/g, ' ').trim()`);
const readMenu = (ui) => ui.eval(`(() => {
  const m = document.querySelector('${MENU}');
  if (!m) return null;
  const heads = [...m.querySelectorAll('.dsm-head')].map(h => ({ name: h.querySelector('.dsm-head-name')?.textContent }));
  const rows = [...m.querySelectorAll('.dsm-row')].map(r => ({ name: r.querySelector('.dsm-name')?.textContent, desc: r.querySelector('.dsm-desc')?.textContent || '', selected: r.classList.contains('selected') }));
  return { heads, rows };
})()`);
const waitMenu = (ui, ok, what, timeoutMs = 15000) => until(ui, async () => { const m = await readMenu(ui); return m && !(await ui.exists({ css: `${MENU} .dsm-loading` })) && ok(m) ? m : null; }, timeoutMs, `menu: ${what}`, 300);
async function focusInput(ui, input) {
  const has = () => ui.eval(`!!document.activeElement?.closest('${input}')`);
  for (let i = 0; i < 6 && !(await has()); i++) {
    await ui.click({ css: `${input} .monaco-editor .view-lines` });
    await ui.sleep(500);
    if (!(await has())) await ui.eval(`document.querySelector('${input} .native-edit-context, ${input} textarea')?.focus()`);
  }
  if (!(await has())) throw new Error("the input box does not take the keyboard focus");
}
async function clearInput(ui, input) {
  await focusInput(ui, input);
  await ui.press("End");
  for (let i = 0; i < 200 && (await inputText(ui, input)).length; i++) await ui.press("Backspace");
}
async function chooseCheapModel(ui, input) {
  await clearInput(ui, input);
  await ui.type("/model");
  const models = await waitMenu(ui, m => m.heads.length === 1 && m.heads[0].name === "Model", "Model group", 30000);
  const row = ui.cheapModel(models.rows);
  if (!row) throw new Error(`no cheap test model (listed: ${models.rows.map(r => r.name + " / " + r.desc).slice(0, 30).join("; ")})`);
  await clearInput(ui, input);
  await ui.type(`/${row.name.replace(/\s+/g, "")}`);
  let choices = await waitMenu(ui, m => m.rows.some(r => r.name === row.name && r.desc === row.desc), row.name);
  for (let n = 0; n < choices.rows.length + 2 && !choices.rows.some(r => r.selected && r.name === row.name && r.desc === row.desc); n++) {
    await ui.press("ArrowDown");
    choices = await readMenu(ui);
  }
  await ui.press("Enter", { send: true });
  await ui.sleep(1500);
  await clearInput(ui, input);
  await ui.press("Escape");
  return row;
}

/** Settings › Appearance › Motion (Full, Less, None), as newsession-anim.mjs sets it. */
async function setMotion(ui, label) {
  const nav = { css: ".part.sidebar.dispatch-settings-open .dispatch-settings-nav", webview: false };
  if (!(await ui.exists(nav))) {
    await ui.press("Cmd+,");
    await ui.waitFor(nav, { timeoutMs: 15000 });
  }
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="appearance"]', webview: false });
  await ui.waitFor({ css: '[data-setting="motion"] .dset-seg', webview: false }, { timeoutMs: 20000 });
  await ui.click({ text: label, exact: true, within: '[data-setting="motion"] .dset-seg' });
  await ui.sleep(1000);
  await ui.press("Escape");
  await ui.waitFor(nav, { gone: true, timeoutMs: 10000 });
  await ui.sleep(1200);
}

const ROW_ICON = ".sessions-list-control .dispatch-status-blocks.running";

/**
 * Every running icon on the page: where it is, what clips it (the first ancestor that does not let it out), how far
 * above its box a block starts, and any text of something else in the strip it falls through.
 */
const PLACES = `(() => {
  const out = [];
  for (const host of document.querySelectorAll('.dispatch-status-blocks.running')) {
    const svg = host.querySelector('svg');
    if (!svg || !host.offsetParent) continue;
    const box = svg.getBoundingClientRect();
    let clip = null, path = [];
    for (let e = svg.parentElement; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      path.push((e.className && typeof e.className === 'string' ? e.className.split(' ')[0] : e.tagName) + (cs.overflowY !== 'visible' ? '[' + cs.overflowY + ']' : ''));
      if (!clip && cs.overflowY !== 'visible') { const r = e.getBoundingClientRect(); clip = { cls: String(e.className).slice(0, 60), top: r.top, bottom: r.bottom, h: r.height, left: r.left }; }
      // a clip-path inset (the Now tab's status line) clips too: its top and left edges, outset by negative insets
      const m = /^inset\\(([-\\d.]+)px(?: ([-\\d.]+)px)?(?: ([-\\d.]+)px)?(?: ([-\\d.]+)px)?/.exec(cs.clipPath);
      if (!clip && m) { const r = e.getBoundingClientRect(); const v = m.slice(1).map(x => x === undefined ? undefined : Number(x)); const left = v[3] ?? v[1] ?? v[0]; clip = { cls: String(e.className).slice(0, 60) + ' (clip-path ' + cs.clipPath + ')', top: r.top + v[0], bottom: r.bottom, h: r.height, left: r.left + left }; }
    }
    // the highest a block starts: the top row's place less its fall (read off the drawing: width / 22 of 101.2px)
    const top = svg.querySelector('rect.blk[data-i="3"]');
    const k = Number(top.getAttribute('width')) / 22;
    const startTop = box.top + Number(top.getAttribute('y')) - 101.2 * k;
    const strip = { top: Math.max(startTop, clip ? clip.top : -1e9), bottom: box.top, left: box.left, right: box.right };
    // text of anything that is not this icon in that strip (hits: where the blocks are drawn; near: the whole height
    // they start from, the clip left aside)
    const hits = [], near = [];
    const free = { ...strip, top: startTop };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        const inside = (z) => r.width && r.height && r.right > z.left && r.left < z.right && r.bottom > z.top && r.top < z.bottom;
        if (inside(strip)) hits.push(n.textContent.trim().slice(0, 40));
        if (inside(free)) near.push(n.textContent.trim().slice(0, 40) + ' @' + Math.round(r.top) + '-' + Math.round(r.bottom));
      }
    }
    const where = host.closest('.sessions-list-control') ? 'session row' : host.closest('.dispatch-now-tab') ? 'Now head' : host.closest('.part.titlebar, .titlebar-container, .session-header-bar') ? 'title bar' : 'other';
    const row = host.closest('.monaco-list-row');
    out.push({ where, box: { top: box.top, left: box.left, w: box.width, h: box.height }, overflow: getComputedStyle(svg).overflow,
      startAbove: Math.round((box.top - startTop) * 100) / 100, clip, row: row ? { top: row.getBoundingClientRect().top, h: row.getBoundingClientRect().height } : null,
      seenFrom: Math.round((Math.max(startTop, clip ? clip.top : -1e9) - box.top) * 100) / 100, leftCut: clip ? Math.max(0, Math.round((clip.left - box.left) * 100) / 100) : 0, hits, near, path: path.slice(0, 8) });
  }
  return out;
})()`;

/** One round of the row's icon, frame by frame: waits for the grid to empty, then every block's place on every frame for 4.2 s. */
const FRAMES = `new Promise((resolve) => {
  const svg = document.querySelector('${ROW_ICON} svg');
  const rects = [...svg.querySelectorAll('rect.blk')];
  const read = (r) => r.getAttribute('visibility') === 'hidden' ? null : Number((/translate\\(0 (-?[\\d.]+)\\)/.exec(r.getAttribute('transform') || '') || [0, 0])[1]);
  const k = Number(rects[0].getAttribute('width')) / 22;
  let t0 = 0; const frames = [];
  const f = (t) => {
    if (!svg.isConnected) return resolve({ error: 'the icon went away', frames });
    const ys = rects.map(read);
    if (!t0) {
      if (ys.every(y => y === null)) t0 = t; // the grid has just emptied: a round starts
      requestAnimationFrame(f); return;
    }
    frames.push({ t: Math.round((t - t0) * 10) / 10, y: Object.fromEntries(rects.map((r, n) => [r.dataset.i, ys[n]])) });
    if (t - t0 < 4200) requestAnimationFrame(f); else resolve({ block: Number(rects[0].getAttribute('width')), k, dpr: devicePixelRatio, frames });
  };
  requestAnimationFrame(f);
  setTimeout(() => resolve({ error: 'no round started in 8 s', frames }), 8000);
})`;

/** What the frames say: per block when it shows, when it first touches down, its speed while it falls, its bounces. */
function analyse(rec) {
  const order = [8, 9, 4, 5, 6, 7, 0, 1, 2, 3];
  const allNull = f => Object.values(f.y).every(y => y === null);
  // the round ends where the grid empties again (the next round's blocks are left out)
  const end = rec.frames.find(f => f.t > 500 && allNull(f));
  const round = rec.frames.filter(f => !end || f.t < end.t);
  const blocks = order.map(i => {
    const path = round.map(f => [f.t, f.y[i]]).filter(([, y]) => y !== null);
    const start = path[0];
    const land = path.findIndex(([, y]) => y === 0);
    // speed in px/ms over 40ms windows while it falls (frames come every 8 or 16ms and land on 0.01px: a single
    // frame's step jitters; a window's does not)
    const fall = path.slice(0, land + 1);
    const at = t => { const n = fall.findIndex(([u]) => u >= t); return n < 0 ? null : fall[n]; };
    const speeds = [];
    for (let t = start[0]; ; t += 40) {
      const a = at(t), b = at(t + 40);
      if (!a || !b || b[1] === 0) break;
      speeds.push(Math.round((b[1] - a[1]) / (b[0] - a[0]) * 10000) / 10000);
    }
    const ups = path.filter(([, y], n) => n && path[n - 1][1] === 0 && y < 0).length;
    const rest = path.findIndex(([, y], n) => y === 0 && path.slice(n).every(([, z]) => z === 0));
    const peaks = []; // how high each bounce goes, px
    for (let n = land + 1; n < rest; n++) if (path[n][1] < 0 && path[n][1] <= path[n - 1][1] && path[n][1] < (path[n + 1] || [0, 0])[1]) peaks.push(path[n][1]);
    return { block: i, shows: start && start[0], from: start && start[1], landsAt: land >= 0 ? path[land][0] : null, restsAt: rest >= 0 ? path[rest][0] : null,
      speeds, faster: speeds.every((s, n) => !n || s > speeds[n - 1]), bounces: ups, bounceHeights: peaks };
  });
  const shows = blocks.map(b => b.shows);
  const gaps = shows.slice(1).map((s, n) => Math.round(s - shows[n]));
  const steps = rec.frames.slice(1).map((f, n) => f.t - rec.frames[n].t).sort((a, b) => a - b);
  const frameMs = steps[Math.floor(steps.length / 2)];
  const full = Math.max(...blocks.map(b => b.restsAt ?? Infinity));
  return { blocks, gaps, frameMs, fullAt: full, emptiedAt: end ? end.t : null, restMs: end ? Math.round(end.t - full) : null };
}

/** A crop of the row around its icon, zoomed (the window's own pixels, `scale` times). */
async function crop(ui, name, scale = 6) {
  const r = await ui.eval(`(() => { const h = document.querySelector('.sessions-list-control .dispatch-status-blocks.running, .sessions-list-control .dispatch-status-blocks.still'); const row = h.closest('.monaco-list-row'); const a = row.getBoundingClientRect(); return { x: a.left, y: a.top - 34, w: Math.min(a.width, 240), h: a.height + 34 }; })()`);
  const shot = await ui.cdp.send("Page.captureScreenshot", { format: "png", clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale } });
  fs.writeFileSync(path.join(ui.out, name + ".png"), Buffer.from(shot.data, "base64"));
}

export default async function (ui) {
  await offscreen(ui);
  await onDemo(ui);
  await offscreen(ui);
  await ui.newSession();
  await toDemo(ui);
  await ui.pickEngine("OpenCode", 180000);
  await ui.sleep(1500);
  await chooseCheapModel(ui, ".sessions-chat-editor");
  await focusInput(ui, ".sessions-chat-editor");
  await ui.type("Write the whole numbers from 1 to 1000, one per line, each followed by its square and its cube. Do not use any tools. Then write ROWDROP DONE.");
  await ui.press("Enter", { send: true });
  await ui.waitFor({ css: ROW_ICON }, { timeoutMs: 60000 });
  await ui.sleep(1500);

  // 1. where the running icons are and what they may fall through
  const places = await ui.eval(PLACES);
  fs.writeFileSync(path.join(ui.out, "places.json"), JSON.stringify(places, null, 1));
  const row = places.find(p => p.where === 'session row');
  check("the row's icon lets its blocks out of its 16px box", row && row.overflow === 'visible', row);
  for (const p of places) check(`${p.where}: the falling blocks cross no other text`, p.hits.length === 0, p);

  // 2. a round, frame by frame
  const rec = await ui.eval(FRAMES);
  assert(!rec.error, rec.error + ` (${rec.frames && rec.frames.length} frames)`);
  const sum = analyse(rec);
  fs.writeFileSync(path.join(ui.out, "frames.json"), JSON.stringify({ about: "One round of the running session row's icon in a real session (task-dw425): t in ms from the frame the grid emptied, y per block (data-i) in px above its place, null while hidden. Blocks are " + rec.block + "px; the design's distances are scaled by " + rec.block + "/22.", dpr: rec.dpr, summary: sum, frames: rec.frames }, null, 1));
  check("ten blocks fall, 220ms apart (within a frame or two)", sum.blocks.every(b => b.shows != null) && sum.gaps.every(g => Math.abs(g - 220) <= 2 * sum.frameMs + 1), { gaps: sum.gaps, frameMs: sum.frameMs });
  check("each block falls faster and faster", sum.blocks.every(b => b.faster && b.speeds.length >= 6 && b.speeds.at(-1) > 6 * b.speeds[0]), sum.blocks.map(b => ({ block: b.block, speeds: b.speeds })));
  check("each block bounces twice", sum.blocks.every(b => b.bounces === 2), sum.blocks.map(b => [b.block, b.bounces, b.bounceHeights]));
  check("a round is full in about 2.2 s (the last block starts at 1.98 s)", sum.fullAt > 2200 && sum.fullAt < 2800, sum.fullAt);
  check("the full icon rests about 1 s, then the grid empties", sum.restMs != null && Math.abs(sum.restMs - 1000) <= 2 * sum.frameMs + 1, sum.restMs);

  // 3. what a person sees: zoomed crops of the row through a round, and the window
  // a round starts (the grid empties for a frame or so, the first block shows at its start height): watched on frames
  const started = await ui.eval(`new Promise(res => { const s = document.querySelector('${ROW_ICON} svg'); const r = [...s.querySelectorAll('rect.blk')]; const t0 = performance.now(); const f = () => { const y8 = r.find(x => x.dataset.i === '8'); const t = (/translate\\(0 (-?[\\d.]+)\\)/.exec(y8.getAttribute('transform') || '') || [0, 0])[1]; if (r.every(x => x.getAttribute('visibility') === 'hidden') || (y8.getAttribute('visibility') !== 'hidden' && Number(t) < -19)) return res(true); if (performance.now() - t0 > 8000) return res(false); requestAnimationFrame(f); }; requestAnimationFrame(f); })`);
  assert(started, "no round started on the row in 8 s");
  const t0 = Date.now();
  for (let n = 0; n < 12; n++) {
    await crop(ui, `row-${String(n).padStart(2, "0")}-${Date.now() - t0}ms`);
  }
  await ui.screenshot("01-row-running");

  // 4. the Now tab's head runs the same icon
  await ui.openNowTab();
  await ui.sleep(1500);
  const now = (await ui.eval(PLACES)).find(p => p.where === 'Now head');
  if (now) {
    check("Now head: the falling blocks cross no other text", now.hits.length === 0, now);
    check("Now head: the icon's left column is not cut", now.leftCut === 0, now);
    fs.writeFileSync(path.join(ui.out, "places-now.json"), JSON.stringify(now, null, 1));
  }
  await ui.screenshot("02-now-head");
  // the row, the title bar and the Now head keep one clock: the same block at the same height on the same frame
  const step = await ui.eval(`new Promise(res => {
    const icons = [...document.querySelectorAll('.dispatch-status-blocks.running svg')].filter(s => s.closest('.dispatch-status-blocks').offsetParent);
    const y = r => r.getAttribute('visibility') === 'hidden' ? null : Number((/translate\\(0 (-?[\\d.]+)\\)/.exec(r.getAttribute('transform') || '') || [0, 0])[1]);
    let frames = 0, apart = 0, most = 0;
    const f = () => {
      const all = icons.map(s => [...s.querySelectorAll('rect.blk')].map(y));
      let off = false;
      for (const other of all.slice(1)) other.forEach((v, n) => { const w = all[0][n]; if ((v === null) !== (w === null)) off = true; else if (v !== null) { most = Math.max(most, Math.abs(v - w)); if (Math.abs(v - w) > 0.6) off = true; } });
      frames++; apart += off ? 1 : 0;
      if (frames < 360) requestAnimationFrame(f); else res({ icons: icons.length, where: icons.map(s => s.closest('.sessions-list-control') ? 'row' : s.closest('.dispatch-now-tab') ? 'now' : 'title'), frames, apart, mostPx: Math.round(most * 100) / 100 });
    };
    requestAnimationFrame(f);
  })`);
  fs.writeFileSync(path.join(ui.out, "in-step.json"), JSON.stringify(step, null, 1));
  // a block that starts on a different frame in one of them is a frame apart for a moment: at most 3 frames in 100
  check("the running icons on screen are in step", step.icons >= 3 && step.apart <= step.frames * 0.03, step);
  // light theme: what the row and the Now head look like there
  await ui.setTheme("light");
  await ui.sleep(1500);
  await ui.screenshot("03-light");
  await crop(ui, "row-light");
  await ui.setTheme("dark");
  await ui.sleep(1000);

  // 5. reduce motion the way a person sets it (Settings › Appearance › Motion: None): the icon is whole and still
  await setMotion(ui, "None");
  const still = await until(ui, () => ui.eval(`document.querySelector('.sessions-list-control .dispatch-status-blocks.still') ? true : (document.querySelector('${ROW_ICON}') ? false : 'gone')`), 20000, "the still icon", 500);
  check("reduce motion: the row's icon is still", still === true, still);
  const moves = await ui.eval(`new Promise(r => { const s = document.querySelector('.sessions-list-control .dispatch-status-blocks.still svg'); const a = s.innerHTML; setTimeout(() => r({ same: s.innerHTML === a, transforms: s.querySelectorAll('[transform]').length, hidden: s.querySelectorAll('[visibility=hidden]').length }), 1500); })`);
  check("reduce motion: nothing moves, all ten in place", moves.same && moves.transforms === 0 && moves.hidden === 0, moves);
  await crop(ui, "row-reduce-motion");
  await setMotion(ui, "Full");
  fs.writeFileSync(path.join(ui.out, "checks.json"), JSON.stringify(results, null, 1));
}
