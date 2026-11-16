// 10-10 用户拍板（偏好「Editor 和 Terminal 挨着标题」, task-24xd4; replaces 10-09's「Editor 回右上」): Terminal sits
// left of the session title in the middle of the title bar and Editor right of it, both New ⌘N's button with the
// icon in front of the word, only the icons in a narrow window; Settings is the first block of the bottom bar, where
// Terminal was, and the side bar has no foot. New ⌘N shows once: in the side bar's head while the side bar is open,
// in the title bar once it is closed. Walked as a person does it: Terminal, Settings and Editor clicked, the side
// bar closed and opened with its title bar toggle. Checked from the DOM; pictures are kept at 1000 and 1600 wide.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);

export const meta = { title: 'Terminal 和 Editor 挨着标题、Settings 在底栏', description: 'Terminal 在会话标题胶囊左边、Editor 在右边（窄窗只剩图标、不和胶囊重叠），Settings 是底栏第一块、侧栏没有底部那行；侧栏开着 New 只在侧栏头，收起才在标题栏；真点 Terminal、Settings、Editor。' };

const facts = {};
let OUT = '';
const note = (k, v) => { facts[k] = v; fs.writeFileSync(path.join(OUT, 'facts.json'), JSON.stringify(facts, null, 1)); };

async function until(ui, fn, what, ms = 20000, every = 300) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await ui.sleep(every);
  }
  throw new Error(`Timed out: ${what}`);
}

/** Where Terminal, the title, Editor, Settings, the bottom bar and every visible New are. */
const layout = (ui) => ui.eval(`(() => {
  const r = x => x && (b => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }))(x.getBoundingClientRect());
  const vis = e => !!e && !!e.offsetParent && e.getBoundingClientRect().width > 0;
  const tb = document.querySelector('.part.titlebar');
  const editor = tb.querySelector('[data-part="editor-top"]');
  const terminal = tb.querySelector('[data-part="terminal-top"]');
  const pill = tb.querySelector('.command-center .agent-sessions-titlebar-pill');
  const footItems = [...document.querySelectorAll('.part.sidebar > .sidebar-footer .action-item')].filter(vis);
  const barItems = [...document.querySelectorAll('.dispatch-status-bar .dispatch-status-item')].filter(vis).sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
  const settings = document.querySelector('.dispatch-status-bar [data-part="settings"]');
  const capsule = e => e && vis(e) ? { ...r(e), text: e.innerText.trim(), aria: e.getAttribute('aria-label'), pressed: e.getAttribute('aria-pressed'), radius: getComputedStyle(e).borderRadius, labelShown: vis(e.querySelector('.dispatch-title-side-t')), icon: r(e.querySelector('.dispatch-editor-top-ic, .dispatch-terminal-top-ic')) } : null;
  const news = [...document.querySelectorAll('.agent-sessions-compact-new-button:not(.dispatch-title-side)')].filter(vis);
  const leftNew = news.filter(n => n.closest('.part.titlebar'));
  return {
    width: innerWidth,
    sidebar: vis(document.querySelector('.part.sidebar')),
    editor: capsule(editor), terminal: capsule(terminal), pill: vis(pill) ? r(pill) : null,
    firstInBar: barItems[0] ? barItems[0].dataset.part : null,
    settingsOpen: settings ? settings.getAttribute('aria-pressed') : null,
    panelOpen: !!document.querySelector('.part.panel') && vis(document.querySelector('.part.panel')),
    newPill: leftNew[0] ? { radius: getComputedStyle(leftNew[0]).borderRadius, h: Math.round(leftNew[0].getBoundingClientRect().height), font: getComputedStyle(leftNew[0]).fontSize } : null,
    footItems: footItems.map(e => e.innerText.replace(/\\s+/g, ' ').trim()),
    settings: r(settings), sidebarBox: r(document.querySelector('.part.sidebar')),
    bottomBar: r(document.querySelector('.dispatch-status-bar')),
    news: news.map(n => ({ where: n.closest('.part.titlebar') ? 'titlebar' : n.closest('.part.sidebar') ? 'sidebar' : 'other', ...r(n) })),
  };
})()`);

async function width(ui, w) {
  await ui.cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 0, mobile: false });
  await ui.sleep(1200);
}

async function toggleSideBar(ui, open) {
  await ui.click({ aria: 'Toggle Side Bar', webview: false, within: '.part.titlebar' });
  await until(ui, async () => (await layout(ui)).sidebar === open, `the side bar ${open ? 'open' : 'closed'}`, 10000);
  await ui.sleep(700);
}

function checkRow(L, wide) {
  assert.ok(L.pill, `the session title is in the title bar at ${L.width}`);
  for (const [k, word] of [['terminal', 'Terminal'], ['editor', 'Editor']]) {
    const c = L[k];
    assert.ok(c, `${word} is in the title bar at ${L.width}`);
    assert.equal(c.aria, word);
    assert.equal(c.labelShown, wide, wide ? `the word ${word} shows in a wide window` : 'only the icon in a narrow window');
    if (wide) assert.equal(c.text, word);
    assert.ok(c.icon && c.icon.w >= 12, `the ${word} icon is drawn`);
    assert.ok(c.h >= 22 && c.h <= 26, `${word} capsule height ${c.h}`);
    assert.ok(Math.abs((c.y + c.h / 2) - (L.pill.y + L.pill.h / 2)) <= 2, `${word} on the title's line`);
  }
  const leftGap = L.pill.x - (L.terminal.x + L.terminal.w);
  const rightGap = L.editor.x - (L.pill.x + L.pill.w);
  assert.ok(leftGap >= 2 && leftGap <= 16, `Terminal right beside the title, left of it: ${leftGap}px`);
  assert.ok(rightGap >= 2 && rightGap <= 16, `Editor right beside the title, right of it: ${rightGap}px`);
}

function checkFoot(L) {
  assert.deepEqual(L.footItems, [], `the side bar has no foot row: ${JSON.stringify(L.footItems)}`);
  assert.ok(L.settings, 'Settings is in the bottom bar');
  assert.equal(L.firstInBar, 'settings', 'Settings is the first block of the bottom bar');
  assert.ok(L.settings.x - L.bottomBar.x <= 16, `Settings sits at the bar's left: ${L.settings.x - L.bottomBar.x}px in`);
}

export default async function (ui) {
  OUT = ui.out;
  await ui.openAgents(ui.demoFolder).catch(() => ui.openAgents());
  for (let i = 0; i < 5 && (await ui.exists({ css: 'button.dispatch-tour-close' })); i++) { await ui.click({ css: 'button.dispatch-tour-close' }); await ui.sleep(500); }
  await until(ui, async () => (await layout(ui)).editor, 'Editor in the title bar', 30000);

  // wide: Terminal and Editor with their words beside the title; Settings first in the bottom bar; one New, in the side bar's head
  await width(ui, 1600);
  if (!(await layout(ui)).sidebar) await toggleSideBar(ui, true);
  const wide = await layout(ui);
  note('wideOpen', wide);
  checkRow(wide, true);
  checkFoot(wide);
  assert.equal(wide.news.length, 1, `one New with the side bar open: ${JSON.stringify(wide.news)}`);
  assert.equal(wide.news[0].where, 'sidebar', 'and it is the side bar\'s');
  assert.equal(wide.editor.radius, '4px', 'the same button corner as New ⌘N (--dispatch-radius-button)');
  await ui.screenshot('01-1600-sidebar-open');
  await ui.mark({ css: '[data-part="terminal-top"]' }, { what: 'Terminal：会话标题左边，和 New ⌘N 一样的胶囊', where: '标题栏中间', how: '点一下开关底部的终端，开着时按下' });
  await ui.mark({ css: '[data-part="editor-top"]' }, { what: 'Editor：会话标题右边', where: '标题栏中间', how: '点一下在编辑器窗口打开这个文件夹' });
  await ui.mark({ css: '.dispatch-status-bar [data-part="settings"]' }, { what: 'Settings：底栏第一块，原来 Terminal 的位置', where: '底栏最左', how: '点一下打开设置' });

  // Terminal: a click opens the terminal and the button stays pressed; a second click closes it
  const panelWas = wide.panelOpen;
  await ui.click({ css: '[data-part="terminal-top"]' });
  const opened1 = await until(ui, async () => { const L = await layout(ui); return L.panelOpen !== panelWas ? L : null; }, 'the terminal toggled by Terminal', 10000);
  assert.equal(opened1.terminal.pressed, String(opened1.panelOpen), 'Terminal is pressed while the terminal is open');
  note('terminalClick', { before: panelWas, after: opened1.panelOpen, pressed: opened1.terminal.pressed });
  await ui.screenshot('01b-terminal-toggled');
  await ui.click({ css: '[data-part="terminal-top"]' });
  await until(ui, async () => (await layout(ui)).panelOpen === panelWas, 'the terminal back as it was', 10000);

  // Settings: a click opens Settings in the middle and the block is pressed; Escape closes it
  await ui.click({ css: '.dispatch-status-bar [data-part="settings"]' });
  await until(ui, async () => (await layout(ui)).settingsOpen === 'true', 'Settings open from the bottom bar', 15000);
  await ui.screenshot('01c-settings-open');
  await ui.press('Escape');
  await until(ui, async () => (await layout(ui)).settingsOpen === 'false', 'Settings closed', 15000).catch(() => undefined);

  // the side bar closed: New moves to the title bar, still one
  await toggleSideBar(ui, false);
  const wideClosed = await layout(ui);
  note('wideClosed', wideClosed);
  assert.equal(wideClosed.news.length, 1, `one New with the side bar closed: ${JSON.stringify(wideClosed.news)}`);
  assert.equal(wideClosed.news[0].where, 'titlebar', 'and it is the title bar\'s');
  assert.equal(wideClosed.editor.radius, wideClosed.newPill.radius, 'Editor and New: the same radius');
  assert.equal(wideClosed.editor.h, wideClosed.newPill.h, 'and the same height');
  await ui.screenshot('02-1600-sidebar-closed');
  await toggleSideBar(ui, true);

  // narrow: only the icon; the same one New
  await width(ui, 1000);
  const narrow = await layout(ui);
  note('narrowOpen', narrow);
  checkRow(narrow, false);
  checkFoot(narrow);
  assert.equal(narrow.news.length, 1, `one New at 1000 with the side bar open: ${JSON.stringify(narrow.news)}`);
  assert.equal(narrow.news[0].where, 'sidebar');
  await ui.screenshot('03-1000-sidebar-open');
  await toggleSideBar(ui, false);
  const narrowClosed = await layout(ui);
  note('narrowClosed', narrowClosed);
  assert.equal(narrowClosed.news.length, 1);
  assert.equal(narrowClosed.news[0].where, 'titlebar');
  await ui.screenshot('04-1000-sidebar-closed');
  await toggleSideBar(ui, true);
  await width(ui, 1600);

  // a click on Editor opens an editor window on this folder. The instance already has one on it (openAgents went
  // through it), and VS Code brings that one forward instead of opening a second: close it first, as a person who
  // works in the Agents window alone (the scenario is copied alone to the build machine: no import of ../cdp.mjs)
  const editors = async () => (await (await fetch(`http://127.0.0.1:${ui.rec.port}/json/list`)).json()).filter(t => t.type === 'page' && /workbench(-dev)?\.html/.test(t.url));
  note('editorWindowsAtStart', (await editors()).map(t => t.title));
  for (const t of await editors()) {
    await ui.attach('editor', 30000, t.title);
    const k = { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, modifiers: 4 | 8 }; // ⇧⌘W: Close Window
    await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
    await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    await until(ui, async () => !(await editors()).some(x => x.id === t.id), `the editor window ${t.title} closed`, 20000, 500);
  }
  await ui.attach('agents', 30000);
  assert.equal((await editors()).length, 0, 'no editor window before the click');
  await ui.click({ aria: 'Editor', exact: true, webview: false, within: '.part.titlebar' });
  const folder = path.basename(ui.demoFolder);
  const opened = await until(ui, async () => (await editors()).find(t => t.title.includes(folder)), `an editor window on ${folder} after the click`, 60000, 500)
    .catch(async e => { note('editorWindowsAfter', (await editors()).map(t => t.title)); throw e; });
  note('editorWindowOpened', { title: opened.title });
  await ui.attach('editor', 30000, opened.title);
  await until(ui, () => ui.eval(`!!document.querySelector('.part.titlebar')`), 'the editor window drawn', 30000);
  await ui.sleep(1500);
  await ui.screenshot('05-editor-window');
  await ui.attach('agents', 30000);

  // dark: the same row and the same one New, in both widths
  await ui.setTheme('dark');
  await ui.sleep(800);
  const dark = await layout(ui);
  checkRow(dark, true);
  assert.deepEqual(dark.news.map(n => n.where), ['sidebar']);
  await ui.screenshot('06-1600-dark');
  await width(ui, 1000);
  checkRow(await layout(ui), false);
  await ui.screenshot('07-1000-dark');
  await toggleSideBar(ui, false);
  assert.deepEqual((await layout(ui)).news.map(n => n.where), ['titlebar']);
  await ui.screenshot('08-1000-dark-sidebar-closed');
  await toggleSideBar(ui, true);
  await ui.setTheme('light');
}
