// The new-session page's blocks, its first suggestions and a session that runs outside the window (0.9.2 on the
// person's Mac: from the home, New: a heap of coloured blocks on the ✕ at the top left that did not move,
// three empty suggestion cards, and "This session runs outside this window." staying at the bottom right).
//
// What is checked, from the canvas's own pixels and the page's elements (no hook in the app):
//   - the swarm: no block pixel on any control, icon or word of the page, in key frames after New, on a new chat's
//     page, narrow and wide, with the side bar shut and open, and with
//     motion reduced and Motion › Less, where the blocks also stand still; with motion on they swim;
//   - the suggestions: never on a project's page; on a new chat's page (Chats' +, the Assistant's place until
//     2026-11-11) cards with words (or a line saying why they
//     did not load), never empty frames; a card used once: gone, after a reload too, and Getting started ticks;
// Self-contained: the build service runs a copy of this file.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const meta = {
  instance: { motion: true },
  title: 'New-session page: blocks, first suggestions, outside sessions',
  description: 'The blocks never cover a control or a word and stand still when motion is reduced; the first suggestions only on a new chat page and only until used.',
  timeout: 1200,
};

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
/** A new chat's page: the input with no folder picked (Chats' +). */
const HOME = '.sessions-chat-editor';

function assert(v, m) { if (!v) throw new Error(m); }

/** Every control, icon and word in the sessions part, and the swarm's pixels on top of them. */
const MEASURE = `(() => {
  const part = document.querySelector('.part.sessionspart');
  const water = part && part.querySelector('.agents-aquarium-water.dispatch-swarm');
  if (!water) return { water: false };
  const canvas = water.querySelector('canvas');
  const wr = canvas.getBoundingClientRect();
  if (!wr.width || !wr.height || !canvas.width) return { water: true, size: false, display: getComputedStyle(water).display };
  const sx = canvas.width / wr.width, sy = canvas.height / wr.height;
  const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const opaque = (l, t, r, b) => {
    const x0 = Math.max(0, Math.floor((l - wr.left) * sx)), x1 = Math.min(canvas.width, Math.ceil((r - wr.left) * sx));
    const y0 = Math.max(0, Math.floor((t - wr.top) * sy)), y1 = Math.min(canvas.height, Math.ceil((b - wr.top) * sy));
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (img[(y * canvas.width + x) * 4 + 3] > 128) n++;
    return n;
  };
  const all = opaque(wr.left, wr.top, wr.right, wr.bottom);
  const shown = (el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const name = (el) => (el.getAttribute('aria-label') || el.innerText || el.className || el.tagName).toString().replace(/\\s+/g, ' ').trim().slice(0, 60);
  const hits = [];
  const sel = 'button, a, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="combobox"], [role="textbox"], .monaco-editor, .monaco-button, .codicon, .dispatch-block, svg, img';
  let targets = 0;
  for (const el of part.querySelectorAll(sel)) {
    if (water.contains(el) || !shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.width * r.height > wr.width * wr.height * 0.4) continue;
    targets++;
    const n = opaque(r.left, r.top, r.right, r.bottom);
    if (n) hits.push({ what: name(el), px: n, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
  }
  const walker = document.createTreeWalker(part, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let words = 0;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const el = t.parentElement;
    if (!el || !t.nodeValue.trim() || water.contains(el) || !shown(el)) continue;
    range.selectNodeContents(t);
    for (const r of range.getClientRects()) {
      words++;
      const n = opaque(r.left, r.top, r.right, r.bottom);
      if (n) hits.push({ what: 'text: ' + t.nodeValue.trim().slice(0, 50), px: n, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
    }
  }
  // the close button at the top left, by itself: where 0.9.2's heap sat
  const toggle = part.querySelector('.agents-aquarium-toggle');
  const tr = toggle && toggle.getBoundingClientRect();
  // opaque pixels per 64 px tile (canvas pixels), to see where two frames differ
  const T = 64, tiles = [];
  for (let ty = 0; ty < canvas.height; ty += T) for (let tx = 0; tx < canvas.width; tx += T) {
    let n = 0;
    for (let y = ty; y < Math.min(canvas.height, ty + T); y++) for (let x = tx; x < Math.min(canvas.width, tx + T); x++) if (img[(y * canvas.width + x) * 4 + 3] > 128) n++;
    tiles.push(n);
  }
  const tw = Math.ceil(canvas.width / T);
  // a fingerprint of the blocks' pixels, to tell standing still from swimming
  let sig = 0;
  for (let i = 3; i < img.length; i += 4 * 97) sig = (sig * 31 + (img[i] > 128 ? 1 : 0)) % 1000000007;
  // the biggest things on the page, to tell what leaves the blocks no room
  const big = [...part.querySelectorAll('*')].filter(el => !water.contains(el) && el.checkVisibility()).map(el => { const r = el.getBoundingClientRect(); return { el, a: r.width * r.height, r }; })
    .filter(x => x.a > wr.width * wr.height * 0.25 && x.a < wr.width * wr.height * 1.5).slice(-6).map(x => (x.el.className || x.el.tagName).toString().slice(0, 60) + ' ' + Math.round(x.r.width) + 'x' + Math.round(x.r.height));
  return {
    tiles, tw, sx, cw: canvas.width,
    out: water.dataset.out, keep: water.dataset.keep, drawn: water.dataset.drawn, icon: water.dataset.icon, big,
    water: true, size: [Math.round(wr.width), Math.round(wr.height)], display: getComputedStyle(water).display,
    blockPx: all, targets, words, hits: hits.sort((a, b) => b.px - a.px).slice(0, 12), hitCount: hits.length,
    onClose: tr ? opaque(tr.left, tr.top, tr.right, tr.bottom) : null, sig,
    reduce: !!document.querySelector('.monaco-workbench.monaco-reduce-motion'), less: document.body.classList.contains('dispatch-motion-less'),
  };
})()`;

/** The icon the blocks made: where the canvas drew its dot this frame (the swarm says it in data-dot and data-icon-box),
 *  in the icon's units from the blocks' top left corner (base/common/dispatchPalette.ts DISPATCH_ICON_RUNNING_DOT). */
const ICON_DOT = `(() => {
  const w = document.querySelector('.agents-aquarium-water.dispatch-swarm');
  if (!w || !w.dataset.dot || !w.dataset.iconBox) return null;
  const [x, y, r, a] = w.dataset.dot.split(',').map(Number);
  const [l, t, bw] = w.dataset.iconBox.split(',').map(Number);
  const k = bw / 600;
  return { cx: (x - l) / k, cy: (y - t) / k, r: r / k, alpha: a };
})()`;

/** The suggestion cards as the page has them (whatever CSS hides). */
const CARDS = `(() => {
  const box = document.querySelector('.new-session-prompt-options');
  const opts = [...document.querySelectorAll('.new-session-prompt-option')];
  return {
    shown: !!box && getComputedStyle(box).display !== 'none' && box.checkVisibility(),
    skeletons: opts.filter(o => o.classList.contains('new-session-prompt-option-skeleton')).length,
    cards: opts.filter(o => !o.classList.contains('new-session-prompt-option-skeleton')).map(o => ({
      title: (o.querySelector('.new-session-prompt-option-title')?.innerText || '').trim(),
      desc: (o.querySelector('.new-session-prompt-option-description')?.innerText || '').trim(),
    })),
    failed: (document.querySelector('.new-session-prompt-options-failed')?.innerText || '').trim(),
    home: false,
  };
})()`;

async function closeTips(ui) {
  for (let i = 0; i < 5 && (await ui.exists({ css: 'button.dispatch-tour-close' })); i++) {
    await ui.click({ css: 'button.dispatch-tour-close' });
    await ui.sleep(600);
  }
}

/** A new chat's page (Chats' +): the first suggestions are there until used. */
async function goHome(ui) {
  await closeTips(ui);
  for (let i = 0; !(await ui.exists({ css: HOME })); i++) {
    assert(i < 6, "a new chat's page did not open");
    // the palette, for sure: an F1 right after the window comes up can go nowhere
    for (let p = 0; p < 5 && !(await ui.exists({ css: '.quick-input-widget input' })); p++) {
    	await ui.press('F1');
    	await ui.sleep(800);
    }
    await ui.type('New Quick Chat', { into: { css: '.quick-input-widget input' } });
    await ui.sleep(800);
    await ui.press('Enter');
    for (let j = 0; j < 10 && !(await ui.exists({ css: HOME })); j++) await ui.sleep(1000 * SCALE);
  }
  await ui.sleep(1500);
}

/** From a new chat's page to a project's new-session page, the way 0.9.2's person went: the project, then New. */
async function toProject(ui) {
  // the project picked for sure: a new chat's page leaves New on "No workspace" (VS Code remembers it), so the project's
  // own page and its New Session, the way a person picks a project
  await ui.openAgents(ui.demoFolder);
  await ui.sleep(1500);
  await closeTips(ui);
  const name = ui.demoFolder.split('/').filter(Boolean).at(-1);
  await ui.click({ text: 'Projects', exact: true, within: '.agent-sessions-viewpane' });
  await ui.waitFor({ text: name, exact: true, within: '.dispatch-projects-page' }, { timeoutMs: 45000 });
  await ui.click({ text: name, exact: true, within: '.dispatch-projects-page' });
  const button = await ui.eval(`(() => { const els = [...document.querySelectorAll('a, button, .monaco-button, .action-label')].filter(e => ((e.getAttribute('aria-label') || '').split(' (')[0].trim() === 'New Session' || (e.innerText || '').trim() === 'New Session')).map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.left > 400).sort((a, b) => b.left - a.left); return els[0] ? { x: els[0].left + els[0].width / 2, y: els[0].top + els[0].height / 2 } : null; })()`);
  assert(button, "the project page's New Session");
  await ui.mouse('mouseMoved', button.x, button.y);
  await ui.mouse('mousePressed', button.x, button.y, { clickCount: 1 });
  await ui.mouse('mouseReleased', button.x, button.y, { clickCount: 1 });
  await ui.sleep(1500);
  const picked = await ui.eval(`(document.querySelector('.sessions-workspace-picker-trigger')?.innerText || '').trim()`);
  assert(picked.includes(name), `the new session page is on ${name}: ${picked}`);
}

/** Settings › Appearance › Motion › Animations, the way a person does it; Settings closes again. */
async function setMotion(ui, label) {
  const nav = { css: '.part.sidebar.dispatch-settings-open .dispatch-settings-nav', webview: false };
  if (!(await ui.exists(nav))) {
    await ui.press('Cmd+,');
    await ui.waitFor(nav, { timeoutMs: 15000 });
  }
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="appearance"]', webview: false });
  await ui.waitFor({ css: '[data-setting="motion"] .dset-seg', webview: false }, { timeoutMs: 20000 });
  await ui.click({ text: label, exact: true, within: '[data-setting="motion"] .dset-seg' });
  await ui.sleep(1000);
  await ui.press('Escape');
  await ui.waitFor(nav, { gone: true, timeoutMs: 10000 });
  await ui.sleep(1200);
}

export default async function (ui) {
  const report = { frames: [], checks: {}, notTested: [] };
  const save = () => writeFileSync(join(ui.out, 'newsession-anim.json'), JSON.stringify(report, null, 2));
  const measure = async (label) => {
    const m = await ui.eval(MEASURE);
    report.frames.push({ label, at: Date.now(), ...m });
    save();
    return m;
  };
  /** No block pixel on a control or a word; the swarm is there and drawing. */
  const clear = async (label, { needBlocks = true } = {}) => {
    const m = await measure(label);
    assert(m.water, `${label}: no swarm on the page`);
    assert(m.display !== 'none', `${label}: the swarm is hidden (display none)`);
    if (needBlocks) assert(m.blockPx > 0, `${label}: no block drawn`);
    assert(m.hitCount === 0, `${label}: blocks cover ${m.hitCount} controls or words: ${JSON.stringify(m.hits.slice(0, 4))}`);
    return m;
  };
  // Standing still or swimming, from the pixels: a block that moves shifts hundreds of pixels between tiles; a frame
  // drawn again in the same place differs only at the edges, up to some 60 px a tile (Chromium may switch a canvas that is read back to
  // software drawing, which smooths edges a little differently)
  const stillFor = async (label, ms, wantStill) => {
    const a = await measure(label + ' (a)');
    await ui.sleep(ms);
    const b = await measure(label + ' (b)');
    const most = Math.max(0, ...a.tiles.map((n, i) => Math.abs(n - b.tiles[i])));
    report.checks[label + ' tile change'] = most;
    save();
    assert(wantStill ? most <= 150 : most > 400, `${label}: blocks ${wantStill ? 'move with reduced motion' : 'do not move with motion on'} (largest change in a 64 px tile: ${most} px)`);
  };

  await ui.attach('agents', 90000).catch(() => ui.openAgents(ui.demoFolder));
  await ui.sleep(3000);
  await closeTips(ui);
  // light first, as 0.9.2's screenshots were (the instance follows the Mac's appearance otherwise); dark in step 4
  await ui.setTheme('light');
  await setMotion(ui, 'Full');

  // 1 a new chat's page: the blocks clear of every row and word (the Timeline page has no way in since 2026-11-15, task-ccmyi)
  await goHome(ui);
  await ui.sleep(3000);
  await ui.screenshot('01-home');
  await clear('home');

  // 2 the suggestions on a new chat's page: words in every card (or why not), no empty frames
  let cards;
  for (const until = Date.now() + 30000 * SCALE; Date.now() < until; await ui.sleep(1000)) {
    cards = await ui.eval(CARDS);
    assert(!(cards.shown && cards.skeletons), `empty loading cards on show: ${JSON.stringify(cards)}`);
    if (!cards.skeletons && (cards.cards.length || cards.failed)) break;
  }
  report.checks.assistantCards = cards;
  save();
  assert(!cards.skeletons, `a new chat's page still shows ${cards.skeletons} loading cards after 30 s`);
  assert(cards.cards.length === 3 || cards.failed, `a new chat's page: no suggestions and no reason: ${JSON.stringify(cards)}`);
  for (const c of cards.cards) assert(c.title && c.desc, `an empty suggestion card: ${JSON.stringify(c)}`);

  // 3 New: the project's page, key frames while the swarm comes in
  await toProject(ui);
  const t0 = Date.now();
  for (const [i, ms] of [[0, 0], [1, 150], [2, 400], [3, 1000], [4, 2500], [5, 5000]]) {
    const wait = t0 + ms - Date.now();
    if (wait > 0) await ui.sleep(wait);
    await ui.screenshot(`10-new-kf${i}`);
    const m = await measure(`new kf${i}`);
    report.checks[`new kf${i} on close`] = m.onClose;
    if (ms >= 1000) await clear(`new page after ${ms} ms`);
  }
  const project = await ui.eval(CARDS);
  report.checks.projectCards = project;
  save();
  assert(!project.shown && !project.cards.length && !project.skeletons, `suggestions on a project's page: ${JSON.stringify(project)}`);

  // typing: the blocks nearest the input make the app icon above it, clear of every control; empty again, they swim on
  const typeInto = async (text) => {
    await ui.click({ css: '.new-chat-input-area .monaco-editor' });
    await ui.type(text);
  };
  const clearInput = async () => {
    for (let i = 0; i < 20; i++) await ui.press('Backspace');
  };
  await typeInto('Tidy the README');
  let iconState = '';
  for (const until = Date.now() + 6000; Date.now() < until && iconState !== 'whole'; await ui.sleep(250)) {
    iconState = (await clear('typing: the icon gathering', { needBlocks: false })).icon;
  }
  await ui.screenshot('12-typing-icon');
  const typed = await clear('typing: the icon above the input');
  report.checks.typingIcon = typed.icon;
  assert(typed.icon === 'whole', `typing: the icon did not form (${typed.icon || 'none'})`);
  // its dot: the logo's big green dot where the Dock has it, off the blocks' bottom right corner, in its glow (DESIGN.md:
  // the version before 10-10, chosen 10-21; base/common/dispatchPalette.ts DISPATCH_ICON_DOT 564, 484, measured from the
  // first block: 515, 442, r 53)
  const iconDot = await ui.eval(ICON_DOT);
  report.checks.iconDot = iconDot;
  save();
  assert(iconDot && Math.abs(iconDot.cx - 515.25) < 6 && Math.abs(iconDot.cy - 442.15) < 6 && iconDot.r > 48 && iconDot.r < 60, `the icon's dot is not the logo's big dot: ${JSON.stringify(iconDot)}`);
  await clearInput();
  await ui.sleep(2000);
  const emptied = await clear('input empty again');
  assert(!emptied.icon, `the icon stays after the input was emptied (${emptied.icon})`);

  // 4 narrow and wide windows, the side bar shut and open
  const sizes = [[900, 760], [1700, 1000]];
  try {
    for (const [w, h] of sizes) {
      await ui.cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 0, mobile: false });
      await ui.sleep(1500);
      await ui.screenshot(`20-window-${w}`);
      await clear(`window ${w}×${h}`);
    }
  } finally {
    await ui.cdp.send('Emulation.clearDeviceMetricsOverride', {}).catch(() => {});
    await ui.sleep(1200);
  }
  const sidebarWidth = () => ui.eval(`(() => { const s = document.querySelector('.part.sidebar'); return s && s.checkVisibility() ? Math.round(s.getBoundingClientRect().width) : 0; })()`);
  const before = await sidebarWidth();
  const toggleSidebar = async () => {
    await ui.press('F1');
    await ui.sleep(500);
    await ui.type('Toggle Primary Side Bar Visibility', { into: { css: '.quick-input-widget input' } });
    await ui.sleep(800);
    await ui.press('Enter');
    await ui.sleep(1500);
  };
  await toggleSidebar();
  const after = await sidebarWidth();
  if (after !== before) {
    await ui.screenshot('21-sidebar-toggled');
    await clear('side bar toggled');
    await toggleSidebar();
    await clear('side bar back');
  } else {
    report.notTested.push(`side bar toggle: the command did not change it (${before} px)`);
  }

  // dark: the same muted blocks on the dark page, clear of everything; typing makes the icon in its own dark colours
  await ui.setTheme('dark');
  await ui.sleep(1500);
  await ui.screenshot('22-dark');
  await clear('dark');
  await typeInto('Tidy the README');
  await ui.sleep(3000);
  await ui.screenshot('23-dark-typing-icon');
  const darkIcon = await clear('dark: the icon above the input');
  assert(darkIcon.icon === 'whole', `dark: the icon did not form (${darkIcon.icon || 'none'})`);
  await clearInput();
  await ui.setTheme('light');
  await ui.sleep(1500);

  // 5 motion: on, they swim; reduced and Less, they stand still; never on a control
  await stillFor('motion on', 1200, false);
  await setMotion(ui, 'None');
  assert(await ui.eval(`!!document.querySelector('.monaco-workbench.monaco-reduce-motion')`), 'Motion › None did not reduce motion');
  await ui.screenshot('30-reduced');
  await clear('reduced motion');
  await stillFor('reduced motion', 1500, true);
  await setMotion(ui, 'Less');
  assert(await ui.eval(`document.body.classList.contains('dispatch-motion-less')`), 'Motion › Less did not take');
  await ui.screenshot('31-less');
  await clear('motion less');
  await stillFor('motion less', 1500, true);
  // back on the home with motion Less: the blocks stand clear there too
  await goHome(ui);
  await ui.sleep(1500);
  await clear('home, motion less');
  await ui.screenshot('32-home-less');
  await setMotion(ui, 'Full');

  // 7 a suggestion card used once: gone, and after a reload too; Getting started ticks its item
  await goHome(ui);
  // a card that is a whole sentence sends itself: never on Claude Code (CLAUDE.md: test instances use OpenCode's cheap
  // model; a seeded instance runs with the person's own HOME, so Claude would be their real account)
  let cheap = true;
  try {
    await ui.pickEngine('OpenCode', 60000);
    await ui.pickCheapModel();
  } catch (e) {
    cheap = false;
    report.notTested.push(`using a card: no cheap OpenCode model to send it with (${String(e).slice(0, 120)})`);
  }
  cards = cheap ? await ui.eval(CARDS) : { cards: [] };
  if (!cheap) {
    // said above
  } else if (!cards.cards.length) {
    report.notTested.push(`using a card: none on a new chat's page (${cards.failed || 'no reason given'})`);
  } else {
    await ui.waitFor({ text: cards.cards[0].title, within: '.new-session-prompt-options' }, { timeoutMs: 20000 });
    await ui.screenshot('50-cards');
    await ui.click({ text: cards.cards[0].title, within: '.new-session-prompt-options' });
    await ui.sleep(4000 * SCALE);
    const used = await ui.eval(CARDS);
    const input = await ui.eval(`(document.querySelector('.new-chat-input-area .view-lines')?.innerText || '').trim()`);
    report.checks.afterUse = { ...used, input: input.slice(0, 80) };
    save();
    await ui.screenshot('51-card-used');
    assert(!used.cards.length && !used.skeletons, `the cards stay after one was used: ${JSON.stringify(used)}`);
    // the words are the person's now: the input is left empty for the rest
    await ui.eval(`(() => { const e = document.querySelector('.new-chat-input-area textarea'); e && e.focus(); })()`);
    for (let i = 0; i < input.length + 5; i++) await ui.press('Backspace');
    await ui.reloadWindow('agents');
    await ui.sleep(3000);
    await goHome(ui);
    await ui.sleep(6000);
    const reloaded = await ui.eval(CARDS);
    report.checks.afterReload = reloaded;
    save();
    await ui.screenshot('52-after-reload');
    assert(!reloaded.cards.length && !reloaded.skeletons && !reloaded.failed, `the cards came back after a reload: ${JSON.stringify(reloaded)}`);
    // Getting started: "Ask what is unfinished" is ticked
    const listShown = () => ui.eval(`[...document.querySelectorAll('button.row')].some(b => (b.innerText || '').includes('Ask what is unfinished'))`);
    for (let i = 0; i < 3 && !(await listShown()); i++) {
      await ui.press('F1');
      await ui.sleep(500);
      await ui.type('Getting Started', { into: { css: '.quick-input-widget input' } });
      await ui.sleep(1200);
      // the command itself, not one that only starts with the same words
      if (await ui.exists({ text: 'Getting Started', exact: true, within: '.quick-input-list' })) await ui.click({ text: 'Getting Started', exact: true, within: '.quick-input-list' });
      else await ui.press('Escape');
      await ui.sleep(2000);
    }
    const tick = await ui.eval(`(() => { const r = [...document.querySelectorAll('button.row')].find(b => (b.innerText || '').includes('Ask what is unfinished')); return r ? r.classList.contains('done') : null; })()`);
    report.checks.checklistTicked = tick;
    save();
    if (tick === null) report.notTested.push('Getting started: the list did not open');
    else assert(tick, 'Getting started: "Ask what is unfinished" is not ticked after a card was used');
    await ui.screenshot('53-getting-started');
    await ui.press('Escape');
  }
  // 8 the empty editor's icon: the same big dot (the splash and the empty Files view are the same
  //   numbers: ide/tests/palette.test.mjs)
  try {
    await ui.openEditor();
    await ui.waitFor({ css: '.editor-group-watermark .dispatch-mark .now', webview: false }, { timeoutMs: 20000 });
    await ui.sleep(3000);
    const mark = await ui.eval(`(() => {
      const m = document.querySelector('.editor-group-watermark .dispatch-mark');
      const blocks = [...m.querySelectorAll('rect.blk')].map(b => b.getBoundingClientRect());
      const first = blocks.reduce((a, b) => (b.left <= a.left && b.top <= a.top ? b : a));
      const dot = m.querySelector('.now .disc').getBoundingClientRect();
      const k = first.width / 120;
      return { cx: (dot.left + dot.width / 2 - first.left) / k, cy: (dot.top + dot.height / 2 - first.top) / k, r: dot.width / 2 / k };
    })()`);
    report.checks.editorMarkDot = mark;
    save();
    await ui.screenshot('60-empty-editor');
    // measured from the first block's own box: DISPATCH_ICON_DOT itself (564, 484, r 58)
    assert(Math.abs(mark.cx - 564) < 6 && Math.abs(mark.cy - 484) < 6 && mark.r > 52 && mark.r < 64, `the empty editor's dot is not the logo's big dot: ${JSON.stringify(mark)}`);
  } catch (e) {
    if (/not the logo's big dot/.test(String(e))) throw e;
    report.notTested.push(`empty editor icon: ${String(e).slice(0, 160)}`);
  }
  if (report.notTested.length) writeFileSync(join(ui.out, 'not-tested.json'), JSON.stringify(report.notTested, null, 2));
  save();
}
