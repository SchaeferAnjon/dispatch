// The Agents window's bars (kanban task-in8g, design/bars direction B "Status in blocks"). The bottom bar: it sits
// under the cards without covering them; every block is there or quiet for a reason; hovering a block says what it
// is; clicking opens its panel (the builds block the Builds panel, an allowance gauge the Accounts panel); a narrow
// window shows five cells and fewer blocks. The title bar: Terminal and Editor sit beside the session title (10-11), the
// terminal button opens the bottom panel; each other button is clicked once and what it opens is checked. Everything is checked from the DOM; the pictures are only kept.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export const meta = { title: "标题栏和底栏", description: "底栏每个方块在不在、悬停的字、点开的面板，窄窗口；标题栏每个按钮点一遍。" };

const BAR = ".dispatch-status-bar";
const TERMINAL = '.part.titlebar [data-part="terminal-top"]';
const items = (ui) => ui.eval(`[...document.querySelectorAll('${BAR} .dispatch-status-item')].filter(e => !e.hidden && e.offsetParent).map(e => ({ part: e.dataset.part, text: e.innerText.replace(/\\s+/g, ' ').trim(), hot: e.classList.contains('hot'), box: (r => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)])(e.getBoundingClientRect()), cells: e.querySelectorAll('.dispatch-status-gauge .cell').length, lit: [...e.querySelectorAll('.dispatch-status-gauge .fill')].length, blocks: e.querySelectorAll('.dispatch-status-qb').length }))`);
const hoverText = (ui) => ui.eval(`[...document.querySelectorAll('.monaco-hover, .workbench-hover')].filter(h => h.offsetParent).map(h => h.innerText.trim()).join('\\n---\\n')`);
const report = {};
const save = (ui) => fs.writeFileSync(path.join(ui.out, "bars.json"), JSON.stringify(report, null, 1));

async function hoverAndRead(ui, part) {
  await ui.hover({ css: `${BAR} [data-part="${part}"]` });
  await ui.sleep(1400);
  let t = await hoverText(ui);
  for (let i = 0; i < 16 && !t; i++) { await ui.sleep(300); t = await hoverText(ui); } // a busy Mac shows the tip later
  report.tips = report.tips || {};
  report.tips[part] = t;
  return t;
}

async function closePanels(ui) {
  await ui.press("Escape");
  await ui.sleep(300);
  await ui.hover({ css: ".agent-sessions-workbench" }).catch(() => {});
}

export default async function (ui) {
  // the Agents window on the demo project; a build instance without an editor window opens it as it is
  await ui.openAgents(ui.demoFolder).catch(() => ui.openAgents());
  // out of the person's way: the window works the same off screen (clicks, hovers and pictures go through CDP)
  try {
    const { windowId } = await ui.cdp.send("Browser.getWindowForTarget");
    await ui.cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: -3000, top: -3000, width: 1440, height: 900 } });
  } catch { /* a build without the Browser domain: it stays where it is */ }
  await ui.waitFor({ css: BAR }, { timeoutMs: 30000 });
  // the CLI's queue and accounts are asked right away; give them a moment
  await ui.sleep(8000);

  // 1. the bar is under the cards, 28 high, at the window's bottom edge
  // what is drawn just above the bar's top edge must be the window, not the bar; what is drawn just under it must be
  // the bar (hidden parts keep stale sizes, so ask the page what is on top at those points)
  const geo = await ui.eval(`(() => {
    const bar = document.querySelector('${BAR}');
    const r = bar.getBoundingClientRect();
    const xs = [0.1, 0.3, 0.5, 0.7, 0.9].map(f => Math.round(innerWidth * f));
    const under = xs.map(x => bar.contains(document.elementFromPoint(x, r.top + 3)) || !!document.elementFromPoint(x, r.top + 3)?.closest('.monaco-hover'));
    const cards = [...document.querySelectorAll('.part.sessions, .part.sidebar, .part.editor, .part.auxiliarybar, .part.panel')].filter(e => e.offsetParent && e.getBoundingClientRect().height > 40 && getComputedStyle(e).visibility !== 'hidden');
    const covered = cards.filter(e => xs.some(x => { const t = document.elementFromPoint(x, r.top + 3); return t && e.contains(t); })).map(e => e.className.split(' ').slice(0, 3).join('.'));
    const grid = document.querySelector('.monaco-workbench > .monaco-grid-view');
    const views = [...document.querySelectorAll('.monaco-workbench > .monaco-grid-view .split-view-view')].filter(v => v.offsetParent && v.offsetHeight > 0).map(v => Math.round(v.getBoundingClientRect().bottom));
    return { top: Math.round(r.top), height: Math.round(r.height), bottom: Math.round(r.bottom), inner: innerHeight, barOnTop: under.every(Boolean), covered, gridBottom: grid ? Math.round(grid.getBoundingClientRect().bottom) : null, viewsBottom: views.length ? Math.max(...views) : null };
  })()`);
  report.geometry = geo;
  assert.equal(geo.height, 28, "the bottom bar is 28 high");
  assert.equal(geo.bottom, geo.inner, "the bottom bar sits on the window's bottom edge");
  assert.ok(geo.barOnTop && !geo.covered.length, `nothing covers the bar (${geo.covered.join(", ")})`);
  assert.ok(geo.viewsBottom === null || geo.viewsBottom <= geo.top, `the cards end above the bar (${geo.viewsBottom} > ${geo.top})`);
  assert.ok(geo.gridBottom === null || geo.gridBottom <= geo.top, `the cards' grid ends above the bar (${geo.gridBottom} > ${geo.top})`);
  await ui.screenshot("01-bar");
  report.items = await items(ui);
  save(ui);
  const parts = report.items.map((i) => i.part);
  assert.ok(!parts.includes("terminal"), "the terminal block left the bottom bar: Settings is its first cell now");
  assert.ok(parts.includes("settings"), "Settings is in the bottom bar");

  // 2. the Terminal button beside the session title: its tip, then it opens and closes the bottom panel
  await ui.hover({ css: TERMINAL });
  await ui.sleep(1400);
  let tTip = await hoverText(ui);
  for (let i = 0; i < 16 && !tTip; i++) { await ui.sleep(300); tTip = await hoverText(ui); }
  report.tips = report.tips || {};
  report.tips.terminal = tTip;
  assert.match(tTip, /terminal/i, "hovering the terminal button says what it does");
  await ui.mark({ css: TERMINAL }, { what: "Terminal button", where: "title bar, left of the session title", how: "click: the terminal opens below" });
  await ui.click({ css: TERMINAL });
  await ui.sleep(800);
  const panelOpen = await ui.eval(`!!document.querySelector('.part.panel') && document.querySelector('.part.panel').offsetHeight > 40 && document.querySelector('${TERMINAL}').classList.contains('on')`);
  report.terminalOpens = panelOpen;
  assert.ok(panelOpen, "clicking the terminal button opens the bottom panel and presses the button");
  await ui.screenshot("02-terminal-open");
  await ui.click({ css: TERMINAL });
  await ui.sleep(600);
  report.terminalCloses = await ui.eval(`!document.querySelector('${TERMINAL}').classList.contains('on')`);
  assert.ok(report.terminalCloses, "clicking it again closes it");

  // 3. builds: the queue as blocks, its tip and its panel
  if (parts.includes("builds") || parts.includes("build-failed")) {
    const part = parts.includes("builds") ? "builds" : "build-failed";
    report.buildsTip = await hoverAndRead(ui, part);
    assert.ok(report.buildsTip.length > 0, "hovering the builds block says something");
    await ui.mark({ css: `${BAR} [data-part="${part}"]` }, { what: "Builds", where: "bottom bar, right", how: "one block per build; click for the list" });
    await ui.click({ css: `${BAR} [data-part="${part}"]` });
    await ui.waitFor({ css: ".dispatch-status-panel.builds" }, { timeoutMs: 5000 });
    report.buildsPanel = await ui.eval(`document.querySelector('.dispatch-status-panel.builds').innerText`);
    assert.match(report.buildsPanel, /Builds/, "the Builds panel opens");
    await ui.screenshot("03-builds-panel");
    report.failedAfterPanel = await ui.eval(`!!document.querySelector('${BAR} [data-part="build-failed"]:not([hidden])')`);
    await closePanels(ui);
  } else {
    report.builds = "no builds on this Mac: the queue block stays quiet";
  }

  // 4. allowance: a gauge per signed-in engine, its tip, the Accounts panel
  const gauges = report.items.filter((i) => i.part.startsWith("allowance-"));
  report.gauges = gauges;
  for (const g of gauges) {
    report[`tip-${g.part}`] = await hoverAndRead(ui, g.part);
    assert.ok(/used|usage/i.test(report[`tip-${g.part}`]), `hovering ${g.part} says how much is used`);
    assert.ok(!/% left/.test(report[`tip-${g.part}`]), `hovering ${g.part} says left, not used as everywhere else (task-pss5)`);
    if (g.cells) assert.equal(g.cells, 10, "a gauge has ten cells in a wide window");
  }
  if (gauges.length) {
    await ui.mark({ css: `${BAR} [data-part="${gauges[0].part}"]` }, { what: "Allowance", where: "bottom bar, right", how: "ten cells, as many lit as are used; click to switch accounts" });
    await ui.click({ css: `${BAR} [data-part="${gauges[0].part}"]` });
    await ui.waitFor({ css: ".dispatch-accounts-panel" }, { timeoutMs: 8000 });
    report.accountsPanel = await ui.eval(`document.querySelector('.dispatch-accounts-panel').innerText`);
    await ui.screenshot("04-accounts-panel");
    await closePanels(ui);
  } else {
    report.allowance = "not signed in to Claude or Codex here: no gauges";
  }

  // 5. keep awake: the cup, when Keep awake holds the Mac
  if (parts.includes("keep-awake")) {
    report.awakeTip = await hoverAndRead(ui, "keep-awake");
    await ui.click({ css: `${BAR} [data-part="keep-awake"]` });
    await ui.waitFor({ css: ".dispatch-status-panel.awake" }, { timeoutMs: 5000 });
    report.awakePanel = await ui.eval(`document.querySelector('.dispatch-status-panel.awake').innerText`);
    await ui.screenshot("05-awake-panel");
    await closePanels(ui);
  }
  save(ui);

  // 6. a narrow window: five cells, at most three waiting blocks, no words but the ones that need you
  const [w, h] = await ui.eval("[innerWidth, innerHeight]");
  await ui.cdp.send("Emulation.setDeviceMetricsOverride", { width: 860, height: h, deviceScaleFactor: 0, mobile: false });
  await ui.eval("window.dispatchEvent(new Event('resize'))");
  await ui.sleep(1200);
  report.narrow = await items(ui);
  await ui.screenshot("06-narrow");
  for (const g of report.narrow.filter((i) => i.part.startsWith("allowance-") && i.cells)) {
    assert.equal(g.cells, 5, "a gauge has five cells in a narrow window");
  }
  const q = report.narrow.find((i) => i.part === "builds");
  if (q) assert.ok(q.blocks <= 4, "the queue shows the running build and at most three more");
  await ui.cdp.send("Emulation.clearDeviceMetricsOverride");
  await ui.eval("window.dispatchEvent(new Event('resize'))");
  await ui.sleep(800);
  report.wideAgain = (await ui.eval("innerWidth")) === w;
  save(ui);

  // 7. the title bar: what is there, what is gone, and each button clicked once
  const TB = ".part.titlebar";
  const tbItems = () => ui.eval(`[...document.querySelectorAll('${TB} .action-item, ${TB} .sessions-account-titlebar-widget')].filter(e => e.offsetParent && e.getBoundingClientRect().width > 4).map((e, i) => { const l = e.querySelector('[aria-label]') || e; const r = e.getBoundingClientRect(); return { i, label: (l.getAttribute('aria-label') || e.innerText || l.title || '').replace(/\\s+/g, ' ').trim(), cls: e.className, box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }; })`);
  const state = () => ui.eval(`({ hovers: [...document.querySelectorAll('.monaco-hover, .context-view, .quick-input-widget')].filter(h => h.offsetParent && getComputedStyle(h).display !== 'none').map(h => h.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160)), sidebar: !!document.querySelector('.part.sidebar') && document.querySelector('.part.sidebar').offsetWidth > 0, pane: [...document.querySelectorAll('.part.auxiliarybar')].some(a => a.offsetWidth > 0), newPage: !!document.querySelector('.new-chat-input-area') })`);
  const before = await tbItems();
  report.titleBar = before;
  await ui.screenshot("07-title-bar");
  // Terminal and Editor are beside the session title (their own checks: the terminal above, Editor in c-ui.mjs)
  assert.ok(before.some((x) => /^terminal$/i.test(x.label)) && before.some((x) => /^editor$/i.test(x.label)), "Terminal and Editor are in the title bar");
  const gone = before.filter((x) => /^(go )?back$|^(go )?forward$|^run\b|theme|what's new|getting started|show panel|hide panel|accounts and usage/i.test(x.label));
  report.titleBarGone = gone;
  assert.equal(gone.length, 0, `gone from the title bar: ${gone.map((x) => x.label).join(", ")}`);
  report.clicks = [];
  for (const it of before) {
    if (/close|minimi|zoom|maximi/i.test(it.label)) continue;
    if (/^(terminal|editor)$/i.test(it.label)) continue; // Terminal is checked above; Editor opens another window
    const s0 = await state();
    const [x, y, bw, bh] = it.box;
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + bw / 2, y: y + bh / 2 });
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x + bw / 2, y: y + bh / 2, button: "left", clickCount: 1 });
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + bw / 2, y: y + bh / 2, button: "left", clickCount: 1 });
    await ui.sleep(1200);
    const s1 = await state();
    const shot = `08-click-${String(it.i).padStart(2, "0")}`;
    await ui.screenshot(shot);
    const opened = s1.hovers.filter((h) => !s0.hovers.includes(h));
    report.clicks.push({ label: it.label, shot, opened, sidebar: [s0.sidebar, s1.sidebar], pane: [s0.pane, s1.pane], newPage: [s0.newPage, s1.newPage] });
    save(ui);
    await ui.press("Escape").catch(() => {});
    await ui.sleep(400);
    // a toggle: put it back
    if (s0.sidebar !== s1.sidebar || s0.pane !== s1.pane) {
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x + bw / 2, y: y + bh / 2, button: "left", clickCount: 1 });
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + bw / 2, y: y + bh / 2, button: "left", clickCount: 1 });
      await ui.sleep(800);
    }
  }
  report.avatar = await ui.eval(`(() => { const i = document.querySelector('${TB} img.sessions-account-titlebar-widget-avatar'); return i ? { visible: i.classList.contains('visible'), src: i.getAttribute('src') || '' } : null; })()`);
  save(ui);
}
