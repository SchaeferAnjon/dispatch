// 10-06 收尾 · UI 组 (kanban design/complete-1006/c-ui): what the bars, Settings and the terminal still missed, walked
// the way a person does it. Terminal and Editor beside the session title (10-11); the title bar's "folder › session" and its menu; the
// bottom bar's Run filling up with the port of a real dev server, the cup steaming while an agent works, Busy and
// Restart to update (Developer › Preview the Bottom Bar's Rare Blocks on a Mac that is neither); Settings' picture and
// name, Motion's Less, pi and Hermes with their own marks, Editor window settings opening the editor window's Settings
// on Tab completion and ⌘K (a change there saved in Dispatch); the terminal's keys listed and changed in the editor
// window's Keyboard Shortcuts and known to the Agents window. Checked from the DOM and the CLI; pictures are kept.
// Test model for the one real session: OpenCode GLM 5.3 Flash (DeepSeek Flash or a free Flash when it is missing).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

export const meta = { instance: { motion: true }, needs: ['opencode'], title: '收尾 UI 组', description: 'Terminal 和 Editor 在标题栏标题两边、在哪菜单、Run 端口、杯子冒气、Busy 和更新方块、设置头像、Less 动效、pi/Hermes 图标、编辑器窗口的 Tab 补全设置、终端快捷键。', timeout: 1500 };

const facts = {};
let OUT = '';
const note = (k, v) => { facts[k] = v; fs.writeFileSync(path.join(OUT, 'facts.json'), JSON.stringify(facts, null, 1)); };
const BAR = '.dispatch-status-bar';
const fresh = '.sessions-chat-editor';

function cliEnv(ui) {
  const env = { ...process.env, BEADS_DIR: ui.rec.beads_dir, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home, DISPATCH_E2E_INSTANCE: ui.rec.name };
  if (ui.rec.fixture_home) env.HOME = ui.rec.fixture_home;
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE') || k.startsWith('CODEX_')) delete env[k];
  return env;
}
const cli = (ui, args) => JSON.parse(execFileSync('python3', [ui.rec.cli, ...args, '--json'], { env: cliEnv(ui), cwd: ui.rec.root, encoding: 'utf8', timeout: 60000 }));

async function until(ui, fn, what, ms = 60000, every = 400) {
  const end = Date.now() + ms * SCALE;
  let last;
  while (Date.now() < end) {
    last = await fn().catch(() => undefined);
    if (last) return last;
    await ui.sleep(every);
  }
  throw new Error(`Timed out: ${what}`);
}

async function closeTips(ui) {
  for (let i = 0; i < 5 && (await ui.exists({ css: 'button.dispatch-tour-close' })); i++) {
    await ui.click({ css: 'button.dispatch-tour-close' });
    await ui.sleep(500);
  }
}

/** A key with modifiers (Alt 1, Ctrl 2, Meta 4, Shift 8), as a hand presses it. */
async function chord(ui, key, code, keyCode, modifiers) {
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers });
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
}

/** The command palette: type its name, run the first match. */
async function palette(ui, name) {
  await ui.press('F1');
  await ui.waitFor({ css: '.quick-input-widget .quick-input-box input' }, { timeoutMs: 10000 });
  await ui.type(name, { into: { css: '.quick-input-widget .quick-input-box input' } });
  // the row named exactly so (not "... (JSON)" or a recently used neighbour that happens to be first)
  const at = `[...document.querySelectorAll('.quick-input-list .monaco-list-row')].filter(r => r.offsetParent).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).findIndex(r => { const t = r.querySelector('.monaco-highlighted-label')?.innerText.trim() || ''; return t === ${JSON.stringify(name)} || t.endsWith(': ' + ${JSON.stringify(name)}); })`;
  const n = await until(ui, async () => { const i = await ui.eval(at); return i >= 0 ? i + 1 : null; }, `the palette lists ${name}`, 15000);
  for (let i = 1; i < n; i++) await ui.press('ArrowDown');
  await ui.press('Enter');
}

async function pickInQuickInput(ui, label) {
  await until(ui, async () => ui.eval(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].some(r => r.offsetParent && r.innerText.includes(${JSON.stringify(label)}))`), `the pick ${label}`, 10000);
  await ui.click({ text: label, exact: true, within: '.quick-input-widget' });
}

// ---------------------------------------------------------------- the side bar and the title bar

async function editorAndPlace(ui) {
  // Terminal and Editor sit beside the session title, Terminal on its left and Editor on its right (10-11, "Editor 和
  // Terminal 挨着标题"); Settings is the bottom bar's first block (editor-top.mjs walks the buttons at two widths)
  const geo = await ui.eval(`(() => {
    const tb = document.querySelector('.part.titlebar');
    const e = tb.querySelector('[data-part="editor-top"]');
    const t = tb.querySelector('[data-part="terminal-top"]');
    const p = tb.querySelector('[data-part="title-place"]');
    const foot = [...document.querySelectorAll('.part.sidebar > .sidebar-footer .action-item')].filter(x => x.offsetParent).map(x => x.innerText.replace(/\\s+/g, ' ').trim());
    const news = [...document.querySelectorAll('.agent-sessions-compact-new-button:not(.dispatch-title-side)')].filter(x => x.offsetParent).map(x => x.closest('.part.titlebar') ? 'titlebar' : 'sidebar');
    const r = x => x && (b => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }))(x.getBoundingClientRect());
    const text = p && p.querySelector('.dispatch-place-row') ? r(p.querySelector('.dispatch-place-row')) : r(p);
    return { editor: r(e), editorAria: e?.getAttribute('aria-label'), terminal: r(t), place: r(p), text, foot, news, sideBarEditor: !!document.querySelector('.part.sidebar [data-part="editor-entry"]'), width: innerWidth };
  })()`);
  note('titleBarEditor', geo);
  assert.ok(geo.editor && geo.terminal && geo.place, 'Terminal and Editor are in the title bar');
  assert.equal(geo.editorAria, 'Editor');
  const leftGap = geo.place.x - (geo.terminal.x + geo.terminal.w);
  const rightGap = geo.editor.x - (geo.place.x + geo.place.w);
  assert.ok(leftGap >= 0 && leftGap <= 40, `Terminal is next to the title, on its left (gap ${leftGap}px)`);
  assert.ok(rightGap >= 0 && rightGap <= 40, `Editor is next to the title, on its right (gap ${rightGap}px)`);
  assert.ok(!geo.sideBarEditor, 'the side bar has no Editor any more');
  assert.ok(!geo.foot.some(t => /^(Terminal|Editor)\b/.test(t)), `the side bar's last row has neither Terminal nor Editor: ${geo.foot.join(' | ')}`);
  assert.deepEqual(geo.news, ['sidebar'], `one New, the side bar's head, while the side bar is open: ${geo.news.join(', ')}`);
  await ui.screenshot('01-titlebar-editor');
  await ui.mark({ css: '[data-part="editor-top"]' }, { what: 'Editor：会话标题右边，和 New ⌘N 同一种胶囊（Terminal 在标题左边）', where: '标题栏中间，标题旁', how: '点一下在编辑器窗口打开这个文件夹' });

  // the new session page: "folder › New session", a click lists the sessions
  const place = () => ui.eval(`(() => { const p = document.querySelector('.part.titlebar [data-part="title-place"]'); if (!p) return null; return { text: p.innerText.replace(/\\s+/g, ' ').trim(), aria: p.closest('.agent-sessions-titlebar-container')?.getAttribute('aria-label') || '', state: p.querySelector('.dispatch-place-state .dispatch-block')?.className || '', chev: !!p.querySelector('.dispatch-place-chev:not([hidden])') }; })()`);
  const onNew = await until(ui, place, 'the place in the title bar', 20000);
  note('placeNew', onNew);
  assert.match(onNew.text, /›\s*New session/, `the new session page says so: ${onNew.text}`);
  assert.ok(!onNew.chev, 'no menu on the new session page');
  await ui.screenshot('02-place-new');
}

async function placeMenu(ui) {
  const place = await ui.eval(`(() => { const p = document.querySelector('.part.titlebar [data-part="title-place"]'); return p ? { text: p.innerText.replace(/\\s+/g, ' ').trim(), state: p.querySelector('.dispatch-place-state .dispatch-block')?.className || '', chev: !!p.querySelector('.dispatch-place-chev:not([hidden])') } : null; })()`);
  note('placeSession', place);
  assert.ok(place && /›/.test(place.text) && !/New session/.test(place.text), `a session shows its folder › its name: ${JSON.stringify(place)}`);
  assert.ok(place.chev, 'a session\'s place has its menu');
  await ui.click({ css: '.part.titlebar [data-part="title-place"]' });
  const items = await until(ui, async () => {
    const t = await ui.eval(`[...document.querySelectorAll('.context-view .monaco-menu .action-label')].filter(a => a.offsetParent).map(a => a.innerText.trim()).filter(Boolean)`);
    return t.length ? t : null;
  }, 'the session menu', 8000);
  note('placeMenu', items);
  for (const want of ['Rename…', 'Open in Editor', 'Archive', 'Switch Session…']) assert.ok(items.includes(want), `the menu has ${want}: ${items.join(', ')}`);
  await ui.screenshot('11-place-menu');
  await ui.mark({ css: '.part.titlebar [data-part="title-place"]' }, { what: '在哪：文件夹 › 会话名，后面是状态方块', where: '标题栏中间', how: '点开是 Rename、Open in Editor、Copy Link、Archive' });
  await ui.press('Escape');
}

// ---------------------------------------------------------------- a real session: Run, the cup

async function newSessionInProject(ui, folder) {
  const name = folder.split('/').filter(Boolean).at(-1);
  await closeTips(ui);
  for (let attempt = 0; ; attempt++) {
    await ui.click('Projects');
    try { await ui.waitFor({ css: '.dispatch-projects-toolbar' }, { timeoutMs: 20000 }); await ui.click({ text: 'All', exact: true, within: '.dispatch-projects-toolbar' }); } catch { /* no filter bar */ }
    try { await ui.waitFor({ text: name, exact: true, within: '.dispatch-projects-page' }, { timeoutMs: 45000 }); break; } catch (e) { if (attempt >= 3) throw e; }
  }
  const pageButton = (label) => ui.eval(`(() => {
    const els = [...document.querySelectorAll('a, button, .monaco-button, .action-label')]
      .filter(e => ((e.getAttribute('aria-label') || '').split(' (')[0].trim() === ${JSON.stringify(label)} || (e.innerText || '').trim() === ${JSON.stringify(label)}))
      .map(e => ({ r: e.getBoundingClientRect() })).filter(x => x.r.width > 0 && x.r.left > 400).sort((a, b) => b.r.left - a.r.left);
    return els[0] ? { x: els[0].r.left + els[0].r.width / 2, y: els[0].r.top + els[0].r.height / 2 } : null;
  })()`);
  const press = async (b) => { await ui.mouse('mouseMoved', b.x, b.y); await ui.mouse('mousePressed', b.x, b.y, { clickCount: 1 }); await ui.mouse('mouseReleased', b.x, b.y, { clickCount: 1 }); };
  let first = null;
  for (let attempt = 0; attempt < 4 && !first; attempt++) {
    await closeTips(ui);
    try { await ui.click({ text: name, exact: true, within: '.dispatch-projects-page' }); } catch { /* open already */ }
    first = await until(ui, async () => (await pageButton('New Session')) || (await pageButton('Add as Project')) ? true : null, 'the project page buttons', 15000).catch(() => null);
  }
  if (!first) throw new Error('The project page did not open');
  if (!(await pageButton('New Session'))) await press(await pageButton('Add as Project'));
  await press(await until(ui, async () => pageButton('New Session'), "the project page's New Session", 60000));
  await until(ui, async () => ui.eval(`!!document.querySelector('.sessions-chat-session-type-picker')`), `a new session in ${name}`, 60000);
}

async function focusInput(ui) {
  for (let i = 0; i < 8; i++) {
    await ui.click({ css: i % 2 ? `${fresh} .view-lines` : fresh });
    await ui.sleep(400);
    if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('${fresh}')`)) return;
    await ui.sleep(800);
  }
  throw new Error('The message box does not take the focus');
}

async function pickModel(ui) {
  await focusInput(ui);
  await ui.type('/model');
  await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 30000 });
  const row = await until(ui, async () => {
    const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => ({ name: r.querySelector('.dsm-name')?.textContent }))`);
    return ui.cheapModel(rows);
  }, 'a test model', 45000);
  const typed = async () => ui.eval(`document.querySelector('${fresh} .view-lines')?.textContent || ''`);
  for (let i = 0; i < 40 && (await typed()).trim(); i++) await ui.press('Backspace');
  await ui.type(`/${row.name.replace(/\s+/g, '')}`);
  await until(ui, async () => ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row .dsm-name')].some(n => n.textContent === ${JSON.stringify(row.name)})`), `the menu row ${row.name}`, 20000);
  await ui.click({ text: row.name, exact: true, within: '.dispatch-slash-menu' });
  await ui.press('Escape');
  return row.name;
}

const PORT = 18765;

async function sessionRunAndCup(ui) {
  // a run command for this project, the way Run's "Add" writes it (the person's tasks.json, shown in Agents)
  const tasksFiles = [ui.rec.user_data_dir, ui.rec.agents_user_data_dir].filter(Boolean).map(d => path.join(d, 'User', 'tasks.json'));
  for (const f of tasksFiles) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Serve the demo', type: 'shell', command: `python3 -m http.server ${PORT} --bind 127.0.0.1`, inAgents: true }] }, null, 1));
  }

  await newSessionInProject(ui, ui.demoFolder);
  await ui.pickEngine('OpenCode', 360000);
  note('model', await pickModel(ui));
  await focusInput(ui);
  await ui.type('Run `sleep 25` with your bash tool, then reply with the single word done.');
  await ui.press('Enter', { send: true });

  // while it works: the title bar's block breathes, the cup steams
  const working = await until(ui, async () => ui.eval(`(() => {
    const blk = document.querySelector('.part.titlebar [data-part="title-place"] .dispatch-place-state .dispatch-block');
    const cup = document.querySelector('${BAR} [data-part="keep-awake"]');
    const steam = cup && cup.querySelector('.steam');
    return blk && /working/.test(blk.className) ? { block: blk.className, cup: !!cup && !cup.hidden, cupWorking: !!cup && cup.classList.contains('working'), steam: steam ? getComputedStyle(steam).animationName : '' } : null;
  })()`), 'the session working', 240000, 300);
  note('working', working);
  // a long session title is what gets cut: the folder keeps its name
  const place = await ui.eval(`(() => { const f = document.querySelector('.part.titlebar .dispatch-place-folder-t'); const t = document.querySelector('.part.titlebar .dispatch-place-title'); return f && t ? { folder: f.textContent, folderCut: f.scrollWidth > f.clientWidth + 1, titleCut: t.scrollWidth > t.clientWidth + 1 } : null; })()`);
  note('placeTruncation', place);
  assert.ok(place && !place.folderCut, `the folder name is whole beside a long title: ${JSON.stringify(place)}`);
  await ui.screenshot('12-working-place');
  await placeMenu(ui);
  if (working.cup) {
    const steaming = await until(ui, async () => ui.eval(`(() => { const s = document.querySelector('${BAR} [data-part="keep-awake"].working .steam'); return s && getComputedStyle(s).animationName !== 'none' ? getComputedStyle(s).animationName : null; })()`), 'the cup steaming', 40000, 500);
    note('steam', steaming);
    await ui.screenshot('13-cup-steaming');
    await ui.mark({ css: `${BAR} [data-part="keep-awake"]` }, { what: '杯子冒热气：有 Agent 在干活，Mac 不睡', where: '底栏右边', how: '点开说为什么醒着' });
  } else {
    note('steam', 'no cup: Keep awake is off in this instance');
  }

  // Run: the block fills and says the port once the server prints it
  await until(ui, async () => ui.exists({ css: `${BAR} [data-part="run"]:not([hidden])` }), 'the Run block in a session', 30000);
  await ui.click({ css: `${BAR} [data-part="run"]` });
  const running = await until(ui, async () => ui.eval(`(() => { const r = document.querySelector('${BAR} [data-part="run"]'); return r && r.classList.contains('running') && /:${PORT}/.test(r.innerText) ? { text: r.innerText.trim(), filled: !!r.querySelector('.dispatch-status-bk.on') } : null; })()`), `Run says :${PORT}`, 60000, 400);
  note('running', running);
  assert.ok(running.filled, 'the Run block is filled while the app runs');
  await ui.screenshot('14-run-port');
  await ui.mark({ css: `${BAR} [data-part="run"]` }, { what: 'Run 跑起来：方块填满，旁边写端口', where: '底栏左边，Terminal 右边', how: '点开能在浏览器打开、看终端、停掉' });
  // the server really answers on it
  const answer = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${PORT}/`], { encoding: 'utf8', timeout: 20000 });
  note('serverAnswers', answer);
  assert.equal(answer, '200');
  await ui.click({ css: `${BAR} [data-part="run"]` });
  const panel = await until(ui, async () => ui.eval(`document.querySelector('.dispatch-status-panel.run')?.innerText`), 'the run panel', 8000);
  note('runPanel', panel);
  assert.match(panel, /Your app is running/);
  assert.match(panel, new RegExp(`localhost:${PORT}`));
  await ui.screenshot('15-run-panel');
  await ui.click({ text: 'Stop', exact: true, within: '.dispatch-status-panel.run' });
  const stopped = await until(ui, async () => ui.eval(`(() => { const r = document.querySelector('${BAR} [data-part="run"]'); return r && !r.classList.contains('running') ? r.innerText.trim() || 'Run' : null; })()`), 'Run empties after Stop', 15000);
  note('stopped', stopped);
  const gone = await until(ui, async () => {
    try { execFileSync('curl', ['-s', '--max-time', '2', `http://127.0.0.1:${PORT}/`], { timeout: 5000 }); return null; } catch { return 'closed'; }
  }, 'the server stopped', 20000, 1000);
  note('serverStopped', gone);
  await ui.screenshot('16-run-stopped');
  for (const f of tasksFiles) fs.rmSync(f, { force: true });
}

// ---------------------------------------------------------------- Busy and Restart to update

async function rareBlocks(ui) {
  const real = cli(ui, ['busy']);
  note('busyReal', real);
  await palette(ui, "Preview the Bottom Bar's Rare Blocks");
  await pickInQuickInput(ui, 'Both');
  await until(ui, async () => ui.exists({ css: `${BAR} [data-part="mac-busy"]:not([hidden])` }), 'the Busy block', 8000);
  await until(ui, async () => ui.exists({ css: `${BAR} [data-part="update"]:not([hidden])` }), 'the Restart block', 8000);
  const blocks = await ui.eval(`['mac-busy','update'].map(p => { const e = document.querySelector('${BAR} [data-part="' + p + '"]'); return { part: p, text: e.innerText.trim(), hot: e.classList.contains('hot') }; })`);
  note('rareBlocks', blocks);
  assert.ok(blocks.every(b => b.hot), 'both need you: filled and bold');
  await ui.screenshot('17-busy-update');
  await ui.mark({ css: `${BAR} [data-part="mac-busy"]` }, { what: 'Mac 太忙：只在内存或处理器吃紧时出现', where: '底栏右边', how: '点开能让闲着的 Agent 先睡' });
  await ui.mark({ css: `${BAR} [data-part="update"]` }, { what: '新版装好了：Restart to update', where: '底栏最右', how: '点开 Restart 或 Later' });

  await ui.click({ css: `${BAR} [data-part="mac-busy"]` });
  const busyPanel = await until(ui, async () => ui.eval(`document.querySelector('.dispatch-status-panel.busy')?.innerText`), 'the Busy panel', 8000);
  note('busyPanel', busyPanel);
  assert.match(busyPanel, /Your Mac is busy/);
  assert.match(busyPanel, /Let Idle Agents Sleep/);
  await ui.screenshot('18-busy-panel');
  const asked = path.join(ui.rec.dispatch_dir, 'agent-sleep-now.json');
  fs.rmSync(asked, { force: true });
  await ui.click({ text: 'Let Idle Agents Sleep', exact: true, within: '.dispatch-status-panel.busy' });
  await until(ui, async () => fs.existsSync(asked), 'dispatch sleep now asked every runner', 30000, 500);
  note('sleepAsked', JSON.parse(fs.readFileSync(asked, 'utf8')));
  const after = await until(ui, async () => ui.eval(`document.querySelector('.dispatch-status-panel.busy')?.innerText`), 'the Busy panel again', 8000);
  note('busyPanelAfter', after);
  assert.match(after, /going to sleep/i);
  await ui.screenshot('19-busy-asked');
  await ui.press('Escape');

  await ui.click({ css: `${BAR} [data-part="update"]` });
  const updatePanel = await until(ui, async () => ui.eval(`document.querySelector('.dispatch-status-panel.update')?.innerText`), 'the update panel', 8000);
  note('updatePanel', updatePanel);
  assert.match(updatePanel, /is ready/);
  assert.match(updatePanel, /Restart/);
  await ui.screenshot('20-update-panel');
  await ui.click({ text: 'Later', exact: true, within: '.dispatch-status-panel.update' });
  await until(ui, async () => ui.eval(`document.querySelector('${BAR} [data-part="update"]').hidden`), 'Later hides it', 8000);
  await palette(ui, "Preview the Bottom Bar's Rare Blocks");
  await pickInQuickInput(ui, 'Back to what is true');
  await ui.sleep(1500);
  note('busyAfterReal', await ui.eval(`!document.querySelector('${BAR} [data-part="mac-busy"]').hidden`));
}

// ---------------------------------------------------------------- Settings

async function openSettings(ui) {
  if (!(await ui.exists({ css: '.dispatch-settings-nav', webview: false }))) await ui.press('Cmd+,');
  await ui.waitFor({ css: '.dispatch-settings-nav', webview: false }, { timeoutMs: 20000 });
}

async function settingsPages(ui) {
  await openSettings(ui);
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="overview"]', webview: false });
  const me = await until(ui, async () => ui.eval(`(() => { const m = document.querySelector('.dispatch-settings-page [data-part="settings-me"]'); if (!m) return null; const img = m.querySelector('img'); return { name: m.querySelector('.dset-me-name')?.innerText, sub: m.querySelector('.dset-me-sub')?.innerText, img: img ? img.getAttribute('src') : null, loaded: img ? img.complete && img.naturalWidth > 0 : false, person: !!m.querySelector('.codicon-account'), letters: /^[A-Z]{1,2}$/.test(m.querySelector('.dset-me-pic')?.innerText.trim() || '') }; })()`), 'you at the top of Overview', 20000);
  await ui.sleep(2500);
  Object.assign(me, await ui.eval(`(() => { const img = document.querySelector('.dispatch-settings-page [data-part="settings-me"] img'); return { loaded: img ? img.complete && img.naturalWidth > 0 : false }; })()`));
  note('me', me);
  assert.ok(me.name, 'a name');
  assert.match(me.sub, /Dispatch /);
  assert.ok(me.img || me.person, 'a picture or the outline person');
  assert.ok(!me.letters, 'never letters');
  await ui.screenshot('21-settings-me');
  await ui.mark({ css: '.dispatch-settings-page [data-part="settings-me"]' }, { what: 'Overview 顶上：GitHub 头像和名字', where: '设置 › Overview 最上面', how: '⌘, 打开设置' });

  // Motion: four choices; Less stops the decoration and keeps what says something works
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="appearance"]', webview: false });
  const seg = await until(ui, async () => ui.eval(`(() => { const s = document.querySelector('.dispatch-settings-page [data-setting="motion"] .dset-seg'); return s ? [...s.querySelectorAll('button')].map(b => b.innerText.trim()) : null; })()`), 'the Motion choices', 10000);
  note('motionChoices', seg);
  assert.deepEqual(seg, ['Like my Mac', 'Full', 'Less', 'None']);
  await ui.click({ text: 'Less', exact: true, within: '.dispatch-settings-page [data-setting="motion"]' });
  await until(ui, async () => ui.eval(`document.body.classList.contains('dispatch-motion-less')`), 'Less on the window', 10000);
  const less = await ui.eval(`(() => {
    const anim = sel => { const e = document.querySelector(sel); return e ? getComputedStyle(e).animationName : 'missing'; };
    return { steam: anim('.dispatch-settings-page [data-part="motion-preview"] .deco .dset-steam i'), working: anim('.dispatch-settings-page [data-part="motion-preview"] .dispatch-block.working .b') , spinner: anim('.dispatch-settings-page [data-part="motion-preview"] .codicon-loading') };
  })()`);
  note('lessAnimations', less);
  assert.equal(less.steam, 'none', 'Less stops the steam');
  assert.notEqual(less.working, 'none', 'Less keeps a working block breathing');
  assert.notEqual(less.spinner, 'none', 'Less keeps a spinner turning');
  const settingsFile = path.join(ui.rec.user_data_dir, 'User', 'settings.json');
  await until(ui, async () => /"dispatch\.motion":\s*"less"/.test(fs.readFileSync(settingsFile, 'utf8')), 'dispatch.motion saved', 10000);
  await ui.screenshot('22-motion-less');
  await ui.mark({ css: '.dispatch-settings-page [data-part="appearance-motion"], .dispatch-settings-page [data-setting="motion"]' }, { what: 'Motion 多了 Less：装饰停下，表示在干活的动效留着', where: '设置 › Appearance › Motion', how: '点 Less' });
  await ui.click({ text: 'Full', exact: true, within: '.dispatch-settings-page [data-setting="motion"]' });
  await until(ui, async () => ui.eval(`!document.body.classList.contains('dispatch-motion-less')`), 'Full again', 10000);

  // Agents: pi and Hermes with their own marks wherever they are listed
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="agents"]', webview: false });
  await ui.sleep(3000);
  const opener = await ui.eval(`(() => { const b = [...document.querySelectorAll('.dispatch-settings-page button, .dispatch-settings-page .dset-row')].find(e => /more agents you can install/i.test(e.innerText)); if (b) { b.click(); return true; } return false; })()`);
  await ui.sleep(1500);
  const marks = await ui.eval(`(() => ['pi', 'hermes'].map(id => { const e = document.querySelector('.dispatch-settings-page .codicon-dispatch-agent-' + id); if (!e) return { id, shown: false }; const m = getComputedStyle(e, '::before'); return { id, shown: true, mask: (m.webkitMaskImage || m.maskImage || '').replace(/^url\\("?|"?\\)$/g, '').split('/').pop(), generic: e.classList.contains('codicon-hubot') }; }))()`);
  note('agentMarks', { opened: opener, marks });
  for (const m of marks.filter(x => x.shown)) assert.match(m.mask, new RegExp(`dispatch-agent-${m.id}`), `${m.id} has its own mark`);
  // bring pi and Hermes into view: they are listed under the agents you use
  const rows = await ui.eval(`(() => { const out = []; for (const id of ['pi', 'hermes']) { const e = document.querySelector('.dispatch-settings-page .codicon-dispatch-agent-' + id); if (!e) continue; let r = e; for (let i = 0; i < 6 && r.parentElement && r.getBoundingClientRect().width < 400; i++) r = r.parentElement; r.setAttribute('data-e2e-agent', id); out.push(id); } const f = document.querySelector('[data-e2e-agent]'); if (f) f.scrollIntoView({ block: 'center' }); return out; })()`);
  note('agentRows', rows);
  await ui.sleep(600);
  await ui.screenshot('23-agents-marks');
  if (rows.length) await ui.mark({ css: '.dispatch-settings-page [data-e2e-agent]' }, { what: 'pi 和 Hermes 用各自的图标，不再是通用的机器人', where: '设置 › Agents', how: '往下滚到它们那一行' });

  // Editor window settings: the editor window comes forward with Tab completion and ⌘K in its own Settings
  const row = await ui.eval(`document.querySelector('.dispatch-settings-nav .dsn-row[data-page="editor"]')?.innerText.trim()`);
  note('editorRow', row);
  assert.match(row, /Editor window settings/);
  await ui.mark({ css: '.dispatch-settings-nav .dsn-row[data-page="editor"]' }, { what: 'Tab 补全和 ⌘K 挪到编辑器窗口的设置里，这一行指过去', where: '设置左栏最下面', how: '点它，编辑器窗口出来并打开那几项' });
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="editor"]', webview: false });
}

async function editorWindowSettings(ui) {
  await ui.attach('editor', 60000);
  const rows = await until(ui, async () => {
    const t = await ui.eval(`(() => { const q = document.querySelector('.settings-editor .suggest-input-container .view-lines, .settings-editor .settings-header input'); const items = [...document.querySelectorAll('.settings-editor .setting-item-contents')].filter(e => e.offsetParent).map(e => e.innerText.replace(/\\s+/g, ' ').trim()); return items.length >= 4 ? { query: q ? (q.value || q.innerText) : '', items } : null; })()`);
    return t;
  }, 'the editor window\'s Settings on Tab completion and ⌘K', 60000, 800);
  note('editorSettings', rows);
  const all = rows.items.join(' | ');
  for (const want of [/Tab Completion/, /Daily Cap/, /Rewrite Model/, /Grey suggestions as you type/]) assert.match(all, want);
  await ui.screenshot('24-editor-window-settings');
  await ui.mark({ css: '.settings-editor .settings-body' }, { what: '编辑器窗口自己的设置：Tab 补全开关、模型、每日上限和今天花了多少、⌘K 模型', where: '编辑器窗口 ⌘, › Tab Completion and ⌘K', how: '从 Agents 设置左栏最下面那一行过来，或在编辑器窗口按 ⌘, 搜 tab completion' });

  // a change here is saved in Dispatch
  const before = cli(ui, ['ide', 'editor-settings']);
  note('capBefore', before.tab.cap_usd);
  const target = before.tab.cap_usd === 0.5 ? 0.75 : 0.5;
  const capInput = `.settings-editor .setting-item[data-key="dispatch.editor.tabCompletionDailyCap"] input`;
  const hasKey = await ui.exists({ css: capInput });
  const input = hasKey ? capInput : `.settings-editor .setting-item-contents input[type="number"]`;
  // as a hand does it: click into the box, go to the end, delete what is there, type the number
  // the page draws its rows again once Dispatch's values are in: a click before that lands on a box that is replaced
  await until(ui, async () => Number(await ui.eval(`document.querySelector(${JSON.stringify(input)})?.value`)) === Number(before.tab.cap_usd), 'the cap Dispatch has, in the box', 20000, 500).catch(() => undefined);
  const setCap = async (v) => {
    for (let i = 0; i < 4; i++) {
      await ui.click({ css: input });
      if (await ui.eval(`document.activeElement === document.querySelector(${JSON.stringify(input)})`)) break;
      await ui.sleep(700); // the box was drawn again under the click: click it again, as a person does
    }
    await ui.press('End');
    for (let i = 0; i < 8; i++) await ui.press('Backspace');
    await ui.type(String(v));
  };
  // a pause in the middle: the first number is on its way to Dispatch when the second is typed; the second stays
  await setCap(0.6);
  await ui.sleep(1300);
  await setCap(target);
  await ui.press('Tab');
  const saved = await until(ui, async () => { const s = cli(ui, ['ide', 'editor-settings']); return s.tab.cap_usd === target ? s.tab : null; }, `the cap ${target} saved in Dispatch`, 40000, 1500);
  await ui.sleep(3000); // the first save's answer is back by now: it must not put 0.6 back in the box
  const after = { box: await ui.eval(`document.querySelector(${JSON.stringify(input)})?.value`), dispatch: cli(ui, ['ide', 'editor-settings']).tab.cap_usd, file: (fs.readFileSync(path.join(ui.rec.user_data_dir, 'User', 'settings.json'), 'utf8').match(/"dispatch\.editor\.tabCompletionDailyCap":\s*([\d.]+)/) || [])[1] };
  note('capAfterBothSaves', after);
  assert.equal(Number(after.box), target, `the box keeps ${target}: ${JSON.stringify(after)}`);
  assert.equal(after.dispatch, target, `Dispatch keeps ${target}: ${JSON.stringify(after)}`);
  note('capSaved', saved.cap_usd);
  await ui.screenshot('25-editor-cap-saved');
  // put it back as it was
  execFileSync('python3', [ui.rec.cli, 'settings', '--save', '--json'], { env: cliEnv(ui), cwd: ui.rec.root, encoding: 'utf8', timeout: 60000, input: JSON.stringify({ ide_tab_daily_cap_usd: before.tab.cap_usd }) });
}

// ---------------------------------------------------------------- the terminal's keys in Keyboard Shortcuts

async function terminalKeys(ui) {
  // still in the editor window, the focus on a setting's gear in the modal Settings: F1 and ⇧⌘P open the palette there
  // (VS Code 1.139's modal stopped them until Escape closed it; patches/075-modal-palette.patch)
  const paletteUp = () => ui.eval(`(() => { const w = document.querySelector('.quick-input-widget'); return !!w && w.style.display !== 'none' && !!w.offsetParent; })()`);
  const onGear = async () => {
    await ui.click({ css: '.settings-editor .setting-item-number input' });
    await ui.press('Tab');
    return ui.eval(`document.activeElement?.className || ''`);
  };
  const gear = await onGear();
  note('focusBeforeF1', gear);
  assert.match(gear, /settings-more-action/, `the focus is on a setting's gear: ${gear}`);
  await ui.press('F1');
  const f1 = await until(ui, paletteUp, 'the palette from F1 on a setting\'s gear', 5000, 250).catch(() => false);
  note('f1OnGear', f1);
  assert.ok(f1, 'F1 on a setting\'s gear opens the command palette');
  await ui.screenshot('26a-palette-over-settings');
  await ui.mark({ css: '.quick-input-widget' }, { what: '设置页开着、焦点在齿轮上，F1 和 ⇧⌘P 照样打开命令面板', where: '编辑器窗口 › 设置（浮在窗口上的那层）', how: '按 F1 或 ⇧⌘P' });
  await ui.press('Escape');
  await ui.sleep(400);
  assert.ok(await ui.exists({ css: '.settings-editor .setting-item-number input' }), 'Escape closes the palette and leaves Settings open');
  await onGear();
  await chord(ui, 'p', 'KeyP', 80, 4 | 8);
  const cmdP = await until(ui, paletteUp, 'the palette from ⇧⌘P on a setting\'s gear', 5000, 250).catch(() => false);
  note('cmdShiftPOnGear', cmdP);
  assert.ok(cmdP, '⇧⌘P on a setting\'s gear opens the command palette');
  await ui.press('Escape');
  await ui.sleep(400);
  await palette(ui, 'Preferences: Open Keyboard Shortcuts');
  await ui.waitFor({ css: '.keybindings-editor' }, { timeoutMs: 20000 });
  await ui.type('dispatch.terminal.', { into: { css: '.keybindings-editor .keybindings-header input' } });
  const list = await until(ui, async () => {
    const rows = await ui.eval(`[...document.querySelectorAll('.keybindings-editor .monaco-list-row')].filter(r => r.offsetParent).map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
    // the search filters a moment after typing: wait for the terminal's rows, not just any rows
    return rows.length >= 8 && rows.some(r => /Agents Terminal: Split Terminal Right/.test(r)) && rows.every(r => /Agents Terminal|dispatch\.terminal/i.test(r)) ? rows : null;
  }, 'the terminal keys listed', 20000, 600);
  note('keysListed', list);
  assert.ok(list.some(r => /Agents Terminal: Split Terminal Right/.test(r)), `Split Terminal Right is listed: ${list.join(' | ')}`);
  await ui.screenshot('26-keyboard-shortcuts');
  await ui.mark({ css: '.keybindings-editor .keybindings-body' }, { what: '终端的 11 个键列在快捷键页，能直接改', where: '编辑器窗口 › Keyboard Shortcuts，搜 dispatch.terminal.', how: '也可以在终端右键 More › Change Shortcuts...' });

  // change Split Terminal Right to ⌥⌘D the way a person does: double-click its row, press the keys, Enter
  const kbFile = path.join(ui.rec.user_data_dir, 'User', 'keybindings.json');
  const kbBefore = fs.existsSync(kbFile) ? fs.readFileSync(kbFile, 'utf8') : null;
  const at = await ui.eval(`(() => { const r = [...document.querySelectorAll('.keybindings-editor .monaco-list-row')].find(r => r.offsetParent && /Split Terminal Right/.test(r.innerText)); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 120, y: b.top + b.height / 2 }; })()`);
  await ui.mouse('mouseMoved', at.x, at.y);
  await ui.mouse('mousePressed', at.x, at.y, { clickCount: 1 });
  await ui.mouse('mouseReleased', at.x, at.y, { clickCount: 1 });
  await ui.mouse('mousePressed', at.x, at.y, { clickCount: 2 });
  await ui.mouse('mouseReleased', at.x, at.y, { clickCount: 2 });
  await ui.waitFor({ css: '.defineKeybindingWidget' }, { timeoutMs: 8000 });
  // the widget takes the focus a moment after it shows: keys before that go nowhere
  await until(ui, async () => ui.eval(`!!document.activeElement?.closest('.defineKeybindingWidget')`), 'the focus in the key widget', 5000, 100);
  await ui.sleep(300);
  await chord(ui, 'd', 'KeyD', 68, 1 | 4);
  await ui.sleep(400);
  note('keyRecorded', await ui.eval(`(() => { const w = document.querySelector('.defineKeybindingWidget'); return w ? { input: w.querySelector('input')?.value, shown: w.innerText.replace(/\\s+/g, ' ').slice(0, 120), active: (document.activeElement?.className || '') + '' } : null; })()`));
  await ui.press('Enter');
  await ui.sleep(800);
  note('afterEnter', await ui.eval(`(() => { const w = document.querySelector('.defineKeybindingWidget'); const r = [...document.querySelectorAll('.keybindings-editor .monaco-list-row')].find(r => r.offsetParent && /Split Terminal Right/.test(r.innerText)); return { widget: !!(w && w.offsetParent), row: r ? r.innerText.replace(/\\s+/g, ' ').slice(0, 120) : null }; })()`));
  const saved = await until(ui, async () => { const t = fs.existsSync(kbFile) ? fs.readFileSync(kbFile, 'utf8') : ''; return /dispatch\.terminal\.splitRight/.test(t) && /alt\+cmd\+d|cmd\+alt\+d/.test(t) ? t : null; }, 'keybindings.json has the new key', 15000);
  note('keybindingsJson', saved);
  await ui.screenshot('27-key-changed');

  // the Agents window knows it: its palette shows ⌥⌘D for Split Terminal Right
  await ui.attach('agents', 30000);
  await ui.press('F1');
  await ui.waitFor({ css: '.quick-input-widget .quick-input-box input' }, { timeoutMs: 10000 });
  await ui.type('Split Terminal Right', { into: { css: '.quick-input-widget .quick-input-box input' } });
  const shown = await until(ui, async () => ui.eval(`(() => { const r = [...document.querySelectorAll('.quick-input-list .monaco-list-row')].find(r => r.offsetParent && /Split Terminal Right/.test(r.innerText)); return r ? r.innerText.replace(/\\s+/g, ' ') : null; })()`), 'the Agents window palette row', 10000);
  note('agentsPaletteRow', shown);
  assert.match(shown, /⌥⌘D|⌥ ⌘ D|Option\+Cmd\+D/i, `the Agents window uses the new key: ${shown}`);
  await ui.screenshot('28-agents-knows-key');
  await ui.press('Escape');
  if (kbBefore === null) fs.rmSync(kbFile, { force: true }); else fs.writeFileSync(kbFile, kbBefore);
}

export default async function (ui) {
  OUT = ui.out;
  await ui.openAgents(ui.demoFolder).catch(() => ui.openAgents());
  try {
    const { windowId } = await ui.cdp.send('Browser.getWindowForTarget');
    await ui.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -3000, top: -3000, width: 1440, height: 900 } });
  } catch { /* stays where it is */ }
  await ui.waitFor({ css: BAR }, { timeoutMs: 30000 });
  await closeTips(ui);
  await ui.sleep(3000);
  await editorAndPlace(ui);
  await rareBlocks(ui);
  await sessionRunAndCup(ui);
  try {
    await settingsPages(ui);
    await editorWindowSettings(ui);
    await terminalKeys(ui);
  } finally {
    // the next scenario on this instance starts where this one ends: back from Settings to the sessions
    try {
      await ui.attach('agents', 15000);
      const open = () => ui.exists({ css: '.dispatch-settings-nav .dsn-back', webview: false });
      for (let i = 0; i < 3 && (await open()); i++) {
        await ui.sleep(500); // a palette closing a moment ago can take the click
        if (i === 0) await ui.click({ css: '.dispatch-settings-nav .dsn-back', webview: false }); else await ui.press('Escape');
        await ui.sleep(800);
      }
      note('settingsClosedAtEnd', !(await open()));
    } catch { /* the window is gone: nothing to put back */ }
  }
}
