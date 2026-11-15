// The line of things noted from chats, everywhere a person looks (task-tix5, design/chat-capture direction B, B1 and B4):
// a message with two things to line up lines them up; the session's Tasks tab shows them as Next up, numbered, with a
// head over the message they came from, and on hover Move to front, Not now (to Later), Line it up, ⋯ Not a task with
// Undo, ⋯ Edit; Start by itself / Pause on the group's head. The Now tab (direction A, 2026-11-11) no longer carries
// the line with its Pause: once the session is done it folds what comes next into "Next in demo". Settings ›
// Agents: Work at once, Starts with, Start by itself, the same values as `dispatch nextup`. In a terminal session,
// what is typed to OpenCode is noted too and shows in that session's Tasks tab. Test model: OpenCode GLM 5.3 Flash.
//
// The terminal part: Dispatch's OpenCode plugin is what notes a prompt typed in the terminal. On this Mac OpenCode
// loads the installed app's plugin from ~/.config/opencode; this run adds the build's own plugin to the demo project
// (.opencode/plugin) so the terminal runs this build's plugin and CLI, as it will once this build is installed.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
const { join } = path;

export const meta = { needs: ['opencode'], title: 'Next up in the side pane, Settings and the terminal', description: 'The line shows in the Tasks and Now tabs, its settings in Settings › Agents, and a terminal session notes what is typed to its agent.', timeout: 1500 };

// the same helpers as chat-capture.mjs (the build service runs a scenario file on its own, without its neighbours)
const fresh = '.sessions-chat-editor';
export const MODEL = process.env.E2E_OPENCODE_MODEL || process.env.DISPATCH_E2E_OPENCODE_MODEL || 'zhipuai-coding-plan/glm-5.3-flash'; // the model the run was given (e2e_suite)

// no "later" in it: what is said for later waits in Later (task-9rxf); these two line up as Next up
export const MESSAGE = 'Two small things for this project: add a file CHANGELOG.md with the line "First release", and add a file CONTRIBUTING.md that says "Pull requests welcome". Line them up behind your work; reply only with OK and do not use any tools in this turn.';

export function cli(ui, args, timeout = 60000) {
  const out = execFileSync(join(ui.rec.bin_dir, 'dispatch'), args, { encoding: 'utf8', timeout });
  const i = Math.min(...['{', '['].map(c => out.indexOf(c)).filter(x => x >= 0));
  return JSON.parse(out.slice(i));
}

export async function until(ui, fn, what, ms = 120000, every = 1000) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await ui.sleep(every);
  }
  throw new Error(`Timed out: ${what}`);
}

export async function offScreen(ui) {
  try {
    const { windowId } = await ui.cdp.send('Browser.getWindowForTarget', {});
    await ui.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -3000, top: -3000 } });
  } catch { /* the run still works */ }
}

export async function closeTips(ui) {
  for (let i = 0; i < 5 && (await ui.exists({ css: 'button.dispatch-tour-close' })); i++) {
    await ui.click({ css: 'button.dispatch-tour-close' });
    await ui.sleep(600);
  }
}

export async function restPointer(ui) {
  await ui.mouse('mouseMoved', 1300, 640);
  await ui.sleep(700);
}

export async function newSessionInProject(ui, folder) {
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
      .map(e => ({ r: e.getBoundingClientRect() })).filter(x => x.r.width > 0 && x.r.left > 400)
      .sort((a, b) => b.r.left - a.r.left);
    return els[0] ? { x: els[0].r.left + els[0].r.width / 2, y: els[0].r.top + els[0].r.height / 2 } : null;
  })()`);
  const press = async (b) => {
    await ui.mouse('mouseMoved', b.x, b.y);
    await ui.mouse('mousePressed', b.x, b.y, { clickCount: 1 });
    await ui.mouse('mouseReleased', b.x, b.y, { clickCount: 1 });
  };
  let first = null;
  for (let attempt = 0; attempt < 4 && !first; attempt++) {
    await closeTips(ui);
    try { await ui.click({ text: name, exact: true, within: '.dispatch-projects-page' }); } catch { /* open already */ }
    first = await until(ui, async () => (await pageButton('New Session')) || (await pageButton('Add as Project')) ? true : null, 'the project page buttons', 15000).catch(() => null);
  }
  if (!first) throw new Error('The project page did not open');
  if (!(await pageButton('New Session'))) await press(await pageButton('Add as Project'));
  await press(await until(ui, async () => pageButton('New Session'), "the project page's New Session", 60000));
  await until(ui, async () => ui.eval(`(document.querySelector('.part.titlebar')?.innerText || '').includes(${JSON.stringify(name)}) && !!document.querySelector('.sessions-chat-session-type-picker')`), `a new session in ${name}`, 60000);
}

export async function focusInput(ui, css = fresh) {
  for (let i = 0; i < 8; i++) {
    await ui.click({ css: i % 2 ? `${css} .view-lines` : css });
    await ui.sleep(400);
    if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('${css}')`)) return;
    await ui.sleep(800);
  }
  throw new Error('The message box does not take the focus');
}

export async function pickModel(ui) {
  await focusInput(ui);
  await ui.type('/model');
  await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 30000 });
  let seen = '';
  const row = await until(ui, async () => {
    const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => ({name:r.querySelector('.dsm-name')?.textContent}))`);
    seen = rows.map(r => r.name).join(', ');
    return ui.cheapModel(rows);
  }, 'a test model', 45000).catch(e => { throw new Error(`${e.message}; the menu had: ${seen}`); });
  const typed = async () => ui.eval(`document.querySelector('${fresh} .view-lines')?.textContent || ''`);
  for (let i = 0; i < 40 && (await typed()).trim(); i++) await ui.press('Backspace');
  await ui.type(`/${row.name.replace(/\s+/g, '')}`);
  await until(ui, async () => ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row .dsm-name')].some(n => n.textContent === ${JSON.stringify(row.name)})`), `the menu row ${row.name}`, 20000);
  await ui.click({ text: row.name, exact: true, within: '.dispatch-slash-menu' });
  await ui.press('Escape');
  return row.name;
}

export const receipts = (ui) => cli(ui, ['capture', 'list', '--json']).receipts || [];

export const line = (ui) => cli(ui, ['nextup', '--json']);

export const LINE_DOM = `(() => {
  const host = [...document.querySelectorAll('.dispatch-capture')].find(h => !h.classList.contains('empty') && h.querySelector('.dispatch-capture-line'));
  if (!host) return null;
  return {
    line: host.querySelector('.dispatch-capture-line')?.innerText.replace(/\\s+/g, ' ').trim() || '',
    blocks: [...host.querySelectorAll('.dispatch-capture-line .dispatch-block')].map(b => b.className.replace('dispatch-block', '').trim()),
    hint: host.querySelector('.dispatch-capture-hint')?.innerText.replace(/\\s+/g, ' ').trim() || '',
    rows: [...host.querySelectorAll('.dispatch-capture-row')].map(r => ({ task: r.dataset.task, state: r.dataset.state, title: r.querySelector('.dispatch-capture-title')?.innerText || '', sub: r.querySelector('.dispatch-capture-sub')?.innerText || '' })),
    paused: host.querySelector('.dispatch-capture-pause')?.dataset.paused || '',
  };
})()`;

export async function waitReply(ui, re, ms = 180000) {
  return until(ui, async () => ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return !!r && !r.classList.contains('chat-response-loading') && ${re}.test(r.innerText); })()`), `the reply ${re}`, ms);
}


export const TERMINAL_MESSAGE = 'Two more small things for this project: add a file SECURITY.md that says "Report issues by email", and add a file CODE_OF_CONDUCT.md that says "Be kind". Line them up behind your work; reply only with OK and do not use any tools in this turn.';

function assert(v, m) { if (!v) throw new Error(m); }

export const NEXT_DOM = `(() => {
  const g = [...document.querySelectorAll('.dispatch-nextup-group')].find(e => e.offsetParent && e.dataset.part === 'next-up');
  const l = [...document.querySelectorAll('.dispatch-nextup-group.later')].find(e => e.offsetParent);
  const rows = el => el ? [...el.querySelectorAll('.dispatch-nextup-row')].map(r => ({ task: r.dataset.task, kind: r.dataset.kind, pos: r.querySelector('.dispatch-nextup-pos')?.textContent || '', title: r.querySelector('.dispatch-nextup-title')?.textContent || '' })) : [];
  return {
    head: g?.querySelector('.dispatch-nextup-head')?.innerText.replace(/\\s+/g, ' ').trim() || '',
    note: g?.querySelector('.dispatch-nextup-note')?.innerText.trim() || '',
    source: [...(g?.querySelectorAll('.dispatch-nextup-source') || [])].map(s => s.innerText.replace(/\\s+/g, ' ').trim()),
    paused: g?.querySelector('.dispatch-nextup-pause')?.dataset.paused || '',
    next: rows(g),
    later: rows(l),
    cards: [...document.querySelectorAll('.dispatch-task-card')].filter(c => c.offsetParent).map(c => c.dataset.taskId),
  };
})()`;

const NOW_DOM = `(() => {
  const n = [...document.querySelectorAll('.dispatch-now-tab')].find(e => e.offsetParent);
  const head = n && n.querySelector('[data-part="now-head"]');
  const fold = n && n.querySelector('[data-part="fold-next"]');
  return head ? {
    mode: head.dataset.mode,
    line: !!n.querySelector('.dispatch-nextup-now'),
    fold: fold ? fold.innerText.replace(/\\s+/g, ' ').trim() : '',
    open: fold ? fold.getAttribute('aria-expanded') : '',
    rows: [...n.querySelectorAll('[data-part="fold-next-body"] .dispatch-now-rowbtn')].map(r => ({ task: r.dataset.task, text: r.innerText.replace(/\\s+/g, ' ').trim() })),
  } : null;
})()`;

const SETTINGS_DOM = `(() => {
  const r = k => document.querySelector('.dset-row[data-setting="' + k + '"]');
  const on = k => r(k)?.querySelector('.dset-seg button.on')?.textContent || '';
  const box = r('nextup-auto')?.querySelector('.monaco-custom-toggle');
  return {
    group: !!document.querySelector('.dset-rows[data-setting="nextup"]'),
    limit: on('nextup-limit'), limits: [...(r('nextup-limit')?.querySelectorAll('.dset-seg button') || [])].map(b => b.textContent),
    engine: on('nextup-engine'), engines: [...(r('nextup-engine')?.querySelectorAll('.dset-seg button') || [])].map(b => b.textContent),
    auto: box ? box.getAttribute('aria-checked') : '',
    text: document.querySelector('.dset-rows[data-setting="nextup"]')?.innerText.replace(/\\s+/g, ' ').trim() || '',
  };
})()`;

/** The build's Dispatch plugin for OpenCode, for the demo project (see the head of this file). */
export function buildPlugin(ui) {
  const cands = [
    path.join(ui.rec.app, 'Contents', 'Resources', 'app', 'dispatch-cli', 'dispatch', 'agent', 'opencode', 'dispatch.js'),
    path.join(path.dirname(path.dirname(path.dirname(ui.rec.cli))), 'agent', 'opencode', 'dispatch.js'),
    path.join(path.dirname(path.dirname(ui.rec.cli)), 'agent', 'opencode', 'dispatch.js'),
  ];
  return cands.find(p => fs.existsSync(p)) || '';
}

export function projectOpenCode(ui, plugin) {
  const folder = ui.demoFolder;
  // committed, so the folder a session works in (its own worktree of the project) has them too
  const commit = () => {
    execFileSync('git', ['-C', folder, 'add', 'opencode.json', ...(plugin ? ['.opencode'] : [])]);
    execFileSync('git', ['-C', folder, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-qm', 'chore: OpenCode for the e2e run'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  };
  // the cheap model for the terminal's OpenCode too
  fs.writeFileSync(path.join(folder, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: MODEL }, null, 2));
  if (!plugin) return commit();
  const dir = path.join(folder, '.opencode', 'plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dispatch-build.js'), `// written by the chat-capture-panes e2e: this build's Dispatch plugin, with this instance's CLI
export const DispatchBuild = async (ctx) => {
  process.env.DISPATCH_CLI = ${JSON.stringify(path.join(ui.rec.bin_dir, 'dispatch'))};
  const m = await import(${JSON.stringify(pathToFileURL(plugin).href)});
  return m.DispatchPlugin(ctx);
};
`);
  commit();
}

const META = 4;
async function key(ui, k, code, vk, modifiers) {
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await ui.sleep(400);
}

export const terminalText = ui => ui.eval(`(() => {
  const w = [...document.querySelectorAll('.dispatch-terminal-view .dispatch-xterm')].find(e => e.offsetParent);
  const b = w && w.xterm && w.xterm.buffer.active;
  if (!b) return '';
  const lines = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) lines.push(l.translateToString(true)); }
  return lines.join('\\n').trim();
})()`);

/** ⌘T, Terminal, OpenCode: the person's way to run OpenCode in Dispatch's terminal; waits for its own screen. */
export async function openCodeInTerminal(ui) {
  for (let i = 0; ; i++) {
    await closeTips(ui);
    // ⌘T goes to the window: not from inside a side pane tab that keeps the keys
    if (i) await ui.click({ css: '.agent-sessions-viewpane' }).catch(() => null);
    await key(ui, 't', 'KeyT', 84, META);
    if (await ui.waitFor({ css: '.dispatch-new-picker' }, { timeoutMs: 8000 }).then(() => true, () => false)) break;
    if (i >= 3) throw new Error('⌘T does not open the new session picker');
  }
  await ui.click({ text: 'Terminal', exact: true, within: '.dispatch-new-picker' });
  await ui.waitFor({ text: 'OpenCode', within: '.dispatch-new-picker' }, { timeoutMs: 60000 });
  await ui.click({ text: 'OpenCode', within: '.dispatch-new-picker' });
  for (const end = Date.now() + 40000; Date.now() < end; await ui.sleep(500)) {
    if (await ui.exists("Use your Ghostty look in Dispatch's terminal?")) await ui.click({ text: 'Not now', exact: true });
    if (await ui.exists({ css: '.dispatch-terminal-view .dispatch-xterm .xterm-screen' })) break;
  }
  await ui.waitFor({ css: '.dispatch-terminal-view .dispatch-xterm .xterm-screen' }, { timeoutMs: 20000 });
  let text = '';
  await until(ui, async () => {
    text = await terminalText(ui);
    return /ctrl\+p|commands|Ask anything|tab\s+agents|Build\s|enter\s+send/i.test(text);
  }, "OpenCode's own screen in the terminal", 120000, 1000).catch(e => { throw new Error(`${e.message}: ${text.slice(-400)}`); });
  await ui.sleep(2500);
  return text;
}

/** Types into the terminal as a person does (a Shift first: xterm drops text right after a key it handled itself). */
export async function typeInTerminal(ui, text) {
  await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' });
  await ui.sleep(500);
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 });
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
  await ui.type(text);
  await ui.sleep(800);
  await ui.press('Enter');
}

async function openSettingsAgents(ui) {
  await closeTips(ui);
  if (!(await ui.exists({ css: '.part.sidebar.dispatch-settings-open .dispatch-settings-nav', webview: false }))) {
    await ui.press('Cmd+,');
    await ui.waitFor({ css: '.part.sidebar.dispatch-settings-open .dispatch-settings-nav', webview: false }, { timeoutMs: 15000 });
  }
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="agents"]', webview: false });
  // further down the page than a short window shows: in the page first, then scrolled to
  await until(ui, async () => ui.eval(`!!document.querySelector('.dset-row[data-setting="nextup-limit"]')`), 'the Next up rows on the Agents page', 60000, 500);
  await ui.eval(`document.querySelector('.dset-rows[data-setting="nextup"]').scrollIntoView({ block: 'center' })`);
  await ui.sleep(600);
}

/** Points at a row until its hover buttons are out (a row drawn again under a still pointer only gets :hover on a move). */
async function hoverRow(ui, task) {
  const row = `.dispatch-nextup-row[data-task="${task}"]`;
  for (let i = 0; i < 6; i++) {
    await ui.eval(`document.querySelector('${row}')?.scrollIntoView({ block: 'center' })`);
    await restPointer(ui);
    await ui.hover({ css: row });
    await ui.sleep(300);
    if (await ui.eval(`(document.querySelector('${row} .dispatch-nextup-acts')?.getBoundingClientRect().width || 0) > 0`)) return row;
  }
  throw new Error('the hover buttons of ' + task + ' do not come');
}

/** ⋯ on a row, then one of its items (Edit, Merge into…, Not a task). */
async function menuPick(ui, task, label, note) {
  const row = await hoverRow(ui, task);
  await ui.click({ css: `${row} .dispatch-nextup-more` });
  const menu = await until(ui, async () => ui.eval(`[...document.querySelectorAll('.monaco-menu-container .action-label')].filter(e => e.offsetParent).map(e => e.textContent.trim())`).then(x => x.length ? x : null), 'the ⋯ menu', 8000, 300)
    .catch(async e => { note && note('menu_debug', await ui.eval(`({ more: (() => { const b = document.querySelector('${row} .dispatch-nextup-more'); return b ? JSON.stringify(b.getBoundingClientRect()) : 'none'; })(), row: JSON.stringify(document.querySelector('${row}')?.getBoundingClientRect()) })`)); throw e; });
  note && note('menu', menu);
  await ui.click({ text: label, exact: true, within: '.monaco-menu-container' });
}

async function rowAct(ui, task, label) {
  const row = await hoverRow(ui, task);
  await ui.click({ text: label, exact: true, within: row });
}

export default async function (ui) {
  const result = {};
  const note = (k, v) => { result[k] = v; fs.writeFileSync(`${ui.out}/result.json`, JSON.stringify(result, null, 2)); };
  try {
    await run(ui, note);
  } finally {
    try { note('final_line', line(ui)); } catch (e) { note('final_error', String(e)); }
  }
}

async function run(ui, note) {
  // nothing starts during the run: the line is paused (Start by itself off), one at a time, the cheap model
  cli(ui, ['nextup', 'engine', 'opencode', '--model', MODEL, '--json']);
  cli(ui, ['nextup', 'limit', '1', '--json']);
  cli(ui, ['nextup', 'pause', '--json']);
  const plugin = buildPlugin(ui);
  note('build_plugin', plugin);
  projectOpenCode(ui, plugin);

  await ui.openAgents(ui.demoFolder);
  await offScreen(ui);

  // 1 a message with two things to line up, in a chat session
  await newSessionInProject(ui, ui.demoFolder);
  await ui.pickEngine('OpenCode', 360000);
  note('model', await pickModel(ui));
  await focusInput(ui);
  await ui.type(MESSAGE);
  await ui.press('Enter', { send: true });
  await until(ui, async () => /Noted 2/.test((await ui.eval(LINE_DOM))?.line || ''), 'the line "Noted 2" under the message', 120000, 500);
  const r0 = receipts(ui).at(-1);
  note('receipt', r0);
  const ids = r0.items.filter(i => i.kind === 'new').map(i => i.task);
  assert(ids.length === 2, 'two things were not noted: ' + JSON.stringify(r0.items));
  await waitReply(ui, '/\\bOK\\b/i').catch(() => null);

  // 2 the Tasks tab: Next up, numbered, under a head with the message
  await ui.openTab('Tasks');
  let t = await until(ui, async () => {
    const d = await ui.eval(NEXT_DOM);
    return d && d.next.filter(r => ids.includes(r.task)).length === 2 ? d : null;
  }, 'Next up in the Tasks tab', 90000, 1000);
  note('tasks_first', t);
  assert(t.next.map(r => r.pos).join(',') === '1,2', 'the places are not 1, 2: ' + JSON.stringify(t.next));
  assert(/^Next up 2/.test(t.head) && /Start by itself/.test(t.head) && t.paused === 'true', 'the head: ' + JSON.stringify(t));
  assert(t.source.length === 1 && /Two small things for this project/.test(t.source[0]), 'the head over the message: ' + JSON.stringify(t.source));
  assert(!t.cards.some(c => ids.includes(c)), 'a lined-up thing is also drawn as a card: ' + JSON.stringify(t.cards));
  assert(/Start by itself is off/.test(t.note), 'the note says Start by itself is off: ' + t.note);
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot('p1-tasks-next-up');
  await ui.mark({ css: '.dispatch-nextup-group[data-part="next-up"]' }, { what: 'Next up：排着的事带序号，1 号先开工；组头是你那句话', where: '右栏 Tasks 页签，卡片下面', how: '在对话里说了以后要做的事就会出现' });
  await ui.mark({ css: '.dispatch-nextup-group[data-part="next-up"] .dispatch-nextup-pause' }, { what: 'Start by itself / Pause：默认关，打开后排着的才自己开工；在跑的照跑', where: 'Next up 组头右边', how: '点一下' });

  // 3 move the second to the front
  const [a, b] = t.next.map(r => r.task);
  await rowAct(ui, b, 'Move to front');
  await until(ui, async () => line(ui).next[0]?.id === b, 'the second at the front (CLI)', 30000);
  t = await until(ui, async () => { const d = await ui.eval(NEXT_DOM); return d.next[0]?.task === b && d.next[0]?.pos === '1' ? d : null; }, 'the second at the front (tab)', 30000);
  note('after_front', t.next);

  // 4 Not now: to Later; Line it up: back at the end
  await rowAct(ui, a, 'Save for later');
  await until(ui, async () => line(ui).later.some(x => x.id === a), 'not now (CLI)', 30000);
  t = await until(ui, async () => { const d = await ui.eval(NEXT_DOM); return d.later.some(r => r.task === a) ? d : null; }, 'Later in the tab', 30000);
  note('after_not_now', t);
  await closeTips(ui);
  await restPointer(ui);
  await ui.hover({ css: `.dispatch-nextup-row[data-task="${a}"]` });
  await ui.sleep(400);
  await ui.screenshot('p2-tasks-later');
  await ui.mark({ css: '.dispatch-nextup-group.later' }, { what: 'Later：说了先不做的，等你排回去', where: 'Next up 下面', how: '一行上悬停点 Not now；Line it up 排回队尾' });
  await ui.mark({ css: `.dispatch-nextup-row[data-task="${a}"] .dispatch-nextup-acts` }, { what: '悬停出 Line it up 和 ⋯（Edit、Merge into…、Not a task）', where: '那一行右边', how: '指着这一行' });
  await rowAct(ui, a, 'Back to Next up');
  await until(ui, async () => line(ui).next.at(-1)?.id === a, 'lined up again at the end (CLI)', 30000);
  await until(ui, async () => (await ui.eval(NEXT_DOM)).next.at(-1)?.task === a, 'lined up again (tab)', 30000);

  // 5 Not a task, then Undo
  await menuPick(ui, a, 'Remove from the board', note);
  await until(ui, async () => !line(ui).next.some(x => x.id === a), 'off the board (CLI)', 30000);
  await until(ui, async () => (await ui.eval(NEXT_DOM)).next.some(r => r.task === a && r.kind === 'dropped'), 'the row with Undo', 30000);
  note('after_drop', await ui.eval(NEXT_DOM));
  await ui.click({ text: 'Undo', exact: true, within: `.dispatch-nextup-row[data-task="${a}"][data-kind="dropped"]` });
  await until(ui, async () => line(ui).next.some(x => x.id === a), 'back in line (CLI)', 30000);
  await until(ui, async () => (await ui.eval(NEXT_DOM)).next.some(r => r.task === a && r.kind === 'next'), 'back in line (tab)', 30000);

  // 6 ⋯ Edit: a new title
  await menuPick(ui, a, 'Edit', note);
  await ui.waitFor({ css: 'input.dispatch-nextup-edit' }, { timeoutMs: 10000 });
  await ui.sleep(400);
  await ui.eval(`(() => { const i = document.querySelector('input.dispatch-nextup-edit'); i.value = ''; i.focus(); })()`);
  const newTitle = 'Add the CONTRIBUTING file';
  await ui.type(newTitle, { into: { css: 'input.dispatch-nextup-edit' } });
  await ui.press('Enter');
  await until(ui, async () => line(ui).next.find(x => x.id === a)?.title === newTitle, 'the new title (CLI)', 30000);
  await until(ui, async () => (await ui.eval(NEXT_DOM)).next.find(r => r.task === a)?.title === newTitle, 'the new title (tab)', 30000);

  // 7 Start by itself and Pause again on the group's head (quickly: nothing should start in between)
  await ui.click({ css: '.dispatch-nextup-group[data-part="next-up"] .dispatch-nextup-pause' });
  await until(ui, async () => !line(ui).paused, 'resumed from the Tasks tab', 20000, 300);
  await until(ui, async () => (await ui.eval(NEXT_DOM)).paused === 'false', 'the head says Pause', 20000, 300);
  await ui.click({ css: '.dispatch-nextup-group[data-part="next-up"] .dispatch-nextup-pause' });
  await until(ui, async () => line(ui).paused, 'paused again from the Tasks tab', 20000, 300);
  note('tasks_final', await ui.eval(NEXT_DOM));

  // 8 the Now tab once the session is done: no line with its Pause (that is the Tasks tab's), a fold "Next in demo"
  // with the two things, opened in place
  await ui.openTab('Now');
  const folded = await until(ui, async () => { const d = await ui.eval(NOW_DOM); return d && d.mode === 'done' && /^Next in demo 2$/.test(d.fold) ? d : null; }, 'Next in demo in the Now tab', 120000);
  note('now_folded', folded);
  assert(!folded.line && folded.open === 'false', 'the Now tab: ' + JSON.stringify(folded));
  await ui.click({ css: '.dispatch-now-tab [data-part="fold-next"]' });
  const now = await until(ui, async () => { const d = await ui.eval(NOW_DOM); return d && d.open === 'true' && d.rows.length === 2 ? d : null; }, 'the two things in Next in demo', 20000);
  note('now', now);
  assert(now.rows.map(r => r.task).sort().join() === [a, b].sort().join(), 'Next in demo lists the two things: ' + JSON.stringify(now));
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot('p3-now-next-up');
  await ui.mark({ css: '.dispatch-now-tab [data-part="fold-next"]' }, { what: 'Now 做完时多一行折叠 Next in demo：这个项目接着排着的事', where: '右栏 Now 页签，任务下面', how: '点它就地展开；点一行打开那件事' });

  // 9 Settings › Agents: the same values as the command line, both ways
  await openSettingsAgents(ui);
  let s = await ui.eval(SETTINGS_DOM);
  note('settings_first', s);
  assert(s.group && s.limit === '1' && s.engine === 'OpenCode' && s.auto === 'false', 'Settings shows what the CLI set: ' + JSON.stringify(s));
  await ui.click({ text: '3', exact: true, within: '.dset-row[data-setting="nextup-limit"]' });
  await until(ui, async () => cli(ui, ['nextup', 'settings', '--json']).limit === 3, 'Work at once 3 (CLI)', 20000);
  await ui.click({ text: 'Default', exact: true, within: '.dset-row[data-setting="nextup-engine"]' });
  await until(ui, async () => cli(ui, ['nextup', 'settings', '--json']).engine === '', 'Starts with Default (CLI)', 20000);
  await ui.click({ css: '.dset-row[data-setting="nextup-auto"] .monaco-custom-toggle' });
  await until(ui, async () => !cli(ui, ['nextup', 'settings', '--json']).paused, 'Start by itself on (CLI)', 20000, 300);
  await ui.click({ css: '.dset-row[data-setting="nextup-auto"] .monaco-custom-toggle' });
  await until(ui, async () => cli(ui, ['nextup', 'settings', '--json']).paused, 'Start by itself off again (CLI)', 20000, 300);
  // and the other way: the command line changes it, Settings shows it
  cli(ui, ['nextup', 'limit', '2', '--json']);
  cli(ui, ['nextup', 'engine', 'opencode', '--model', MODEL, '--json']);
  await ui.press('Escape');
  await ui.sleep(800);
  await openSettingsAgents(ui);
  s = await ui.eval(SETTINGS_DOM);
  note('settings_after_cli', s);
  assert(s.limit === '2' && s.engine === 'OpenCode' && s.auto === 'false', 'Settings after the CLI changed it: ' + JSON.stringify(s));
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot('p4-settings');
  await ui.mark({ css: '.dset-rows[data-setting="nextup"]' }, { what: 'Next up 的设置：同时开工几件、用哪个 Agent 开工、要不要自己开工', where: '设置 › Agents，Agent 列表下面', how: '⌘, 打开设置，点 Agents；和 dispatch nextup 命令读写同一个值' });
  await ui.press('Escape');
  await ui.sleep(800);

  // 10 a terminal session: what is typed to OpenCode there is noted too
  const before = receipts(ui).length;
  note('terminal_screen', (await openCodeInTerminal(ui)).slice(-600));
  await typeInTerminal(ui, TERMINAL_MESSAGE);
  const typedAt = Date.now();
  const tr = await until(ui, async () => receipts(ui).find(r => (r.session || '').startsWith('dispatch-terminal:/') && r.items.length), 'a receipt from the terminal', 180000, 2000)
    .catch(async e => { note('terminal_screen_at_failure', (await terminalText(ui)).slice(-1500)); note('receipts_at_failure', receipts(ui).slice(before)); throw e; });
  note('terminal_noted_after_s', Math.round((Date.now() - typedAt) / 1000));
  note('terminal_receipt', tr);
  const tids = tr.items.filter(i => i.kind === 'new').map(i => i.task);
  assert(tids.length === 2, 'two things from the terminal: ' + JSON.stringify(tr.items));
  assert(tr.items.every(i => i.project === 'demo'), 'the terminal things are in the demo project: ' + JSON.stringify(tr.items));
  await ui.openTab('Tasks');
  // the agent in the terminal may take one of them on itself (`dispatch begin` claims the noted task): then it is a card
  const stateOf = () => Object.fromEntries(receipts(ui).filter(r => r.id === tr.id).flatMap(r => r.items).map(i => [i.task, i.state]));
  const tt = await until(ui, async () => {
    const d = await ui.eval(NEXT_DOM);
    const st = stateOf();
    return d && tids.every(id => st[id] === 'next' ? d.next.some(r => r.task === id) && !d.cards.includes(id) : d.cards.includes(id)) ? d : null;
  }, "the terminal's things in its Tasks tab (in line as Next up, taken on as cards)", 90000, 1000);
  note('terminal_tasks', tt);
  const again = receipts(ui).filter(r => r.session === tr.session && r.key === tr.key);
  note('terminal_receipts_for_the_message', again.map(r => r.id));
  assert(again.length === 1, 'the message from the terminal was noted more than once: ' + JSON.stringify(again.map(r => r.items)));
  note('terminal_states', receipts(ui).flatMap(r => r.items).filter(i => tids.includes(i.task)).map(i => [i.task, i.state]));
  assert(!tt.next.length || tt.source.some(x => /SECURITY\.md/.test(x)), 'the head shows what was typed: ' + JSON.stringify(tt.source));
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot('p5-terminal-noted');
  await ui.mark({ css: '.dispatch-terminal-view' }, { what: '在终端里跑的 OpenCode：你打的字也自动记', where: '中间的终端会话', how: '⌘T，选 Terminal，再选 Agent' });
  await ui.mark({ css: tt.next.length ? '.dispatch-nextup-group[data-part="next-up"]' : '.dispatch-tasks-list' }, { what: '记下的两件进了这个终端会话的 Tasks，排着的在 Next up，组头是你在终端里打的那句', where: '这个终端会话的右栏 Tasks 页签', how: '几秒后自己出现' });
}
