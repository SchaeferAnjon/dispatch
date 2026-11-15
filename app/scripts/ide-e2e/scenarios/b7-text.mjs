// What Dispatch says and sends, the way a person meets it (bug round 10-07, group b7-text):
//   settings  Settings › Agents › Tidy up after work names the command people really type, /neat-freak, and says
//             it reports first (task-90c85, task-8bhyl)
//   plain     the new-session chip says Separate copy, not New Worktree; Hooks explain themselves (task-d5n3c)
//   english   a person whose language is English (`dispatch language en`, as Settings would set it): the session
//             brief is English, the agent answers in English, a thing said for later goes on the board with an
//             English title (task-7lptn)
//   neat      /neat → completes to /neat-freak → sent: the agent reports and asks, changes no file, makes no commit,
//             adds no preference; your message shows as /neat-freak, also after the window reloads (task-8bhyl,
//             task-wkq5g)
//   fixit     a commit the project's check refuses → Let the agent fix it: what Dispatch sends in your place does
//             not go on the board as your request (task-6degw)
// Test model: OpenCode GLM 5.3 Flash, else DeepSeek Flash (chat-capture's pickModel). B7_PARTS picks parts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

// helpers as in chat-capture.mjs (a build request copies each scenario alone, so nothing is imported from beside it)
const fresh = '.sessions-chat-editor';

function cli(ui, args, timeout = 60000) {
  const out = execFileSync(join(ui.rec.bin_dir, 'dispatch'), args, { encoding: 'utf8', timeout });
  const i = Math.min(...['{', '['].map(c => out.indexOf(c)).filter(x => x >= 0));
  return JSON.parse(out.slice(i));
}

async function until(ui, fn, what, ms = 120000, every = 1000) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await ui.sleep(every);
  }
  throw new Error(`Timed out: ${what}`);
}

async function offScreen(ui) {
  try {
    const { windowId } = await ui.cdp.send('Browser.getWindowForTarget', {});
    await ui.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -3000, top: -3000 } });
  } catch { /* the run still works */ }
}

async function closeTips(ui) {
  for (let i = 0; i < 5 && (await ui.exists({ css: 'button.dispatch-tour-close' })); i++) {
    await ui.click({ css: 'button.dispatch-tour-close' });
    await ui.sleep(600);
  }
}

async function restPointer(ui) {
  await ui.mouse('mouseMoved', 1300, 640);
  await ui.sleep(700);
}

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

async function focusInput(ui, css = fresh) {
  for (let i = 0; i < 8; i++) {
    await ui.click({ css: i % 2 ? `${css} .view-lines` : css });
    await ui.sleep(400);
    if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('${css}')`)) return;
    await ui.sleep(800);
  }
  throw new Error('The message box does not take the focus');
}

async function pickModel(ui) {
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

export const meta = { needs: ['opencode'], timeout: 3000, title: 'What Dispatch says and sends', description: 'Tidy up names /neat-freak and only reports; plain words on the new-session page; an English person gets English; Dispatch\'s own prompts are not your requests.' };

const PARTS = new Set((process.env.B7_PARTS || 'settings,plain,english,neat,fixit').split(',').map(s => s.trim()));
const CJK = /[一-鿿]/;
const E2E_ROOT = path.join(os.homedir(), 'b7-text-e2e');
const GIT_GLOBAL = path.join(E2E_ROOT, 'gitconfig');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: GIT_GLOBAL, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Dispatch e2e', GIT_AUTHOR_EMAIL: 'e2e@localhost', GIT_COMMITTER_NAME: 'Dispatch e2e', GIT_COMMITTER_EMAIL: 'e2e@localhost' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();
const gitTry = (cwd, ...args) => { try { return git(cwd, ...args); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } };
const write = (file, text, mode) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); if (mode) fs.chmodSync(file, mode); };
const text = (ui, css) => ui.eval(`[...document.querySelectorAll(${JSON.stringify(css)})].filter(e => e.offsetParent).map(e => e.innerText).join('\\n')`);
const dispatchText = (ui, args, cwd) => execFileSync(path.join(ui.rec.bin_dir, 'dispatch'), args, { encoding: 'utf8', timeout: 60000, cwd });
const receipts = (ui) => cli(ui, ['capture', 'list', '--json']).receipts || [];
const prefsCount = (ui) => { const d = cli(ui, ['prefs', 'list', '--json']); return (Array.isArray(d) ? d : d.prefs || d.items || []).length; };

/** A project of its own in the home folder (OpenCode's sandbox and Codex's do not work under /tmp). */
function makeProject(name) {
  const dir = path.join(E2E_ROOT, 'work', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  write(GIT_GLOBAL, '');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Dispatch e2e');
  git(dir, 'config', 'user.email', 'e2e@localhost');
  write(path.join(dir, 'README.md'), `# ${name}\n\nA small to-do web page. Run it with \`npm start\` (there is no build step).\n`);
  write(path.join(dir, 'index.html'), '<!doctype html><title>Todo</title><ul id="list"></ul><button id="add">Add</button>\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'feat: a to-do page');
  return dir;
}

/** The last reply has finished: no Stop button, not loading, and its words unchanged for three looks in a row;
 *  or the agent is waiting on a question card for the person. */
async function waitTurn(ui, ms = 900000) {
  let last = '', same = 0;
  return until(ui, async () => {
    const r = await ui.eval(`(() => {
      const running = [...document.querySelectorAll('[aria-label]')].some(e => e.offsetParent && /^(Stop|Cancel)\\b/.test(e.getAttribute('aria-label')));
      const r = [...document.querySelectorAll('.interactive-response')].at(-1);
      const asking = !!document.querySelector('.chat-question-carousel, .chat-confirmation-widget');
      return r ? { text: r.innerText, loading: r.classList.contains('chat-response-loading') || running, asking } : null;
    })()`);
    if (!r) return null;
    same = r.text === last ? same + 1 : 0;
    last = r.text;
    if (r.asking && same >= 1) return r;
    return !r.loading && same >= 2 && r.text.trim().length > 2 ? r : null;
  }, 'the end of the turn', ms, 3000);
}

/** An empty message box (a draft left from an earlier part would swallow the slash menu). */
async function clearBox(ui) {
  await focusInput(ui);
  await ui.press('End');
  const typed = () => ui.eval(`(document.querySelector('${fresh} .view-lines')?.textContent || '').replace(/\\u00a0/g, ' ').trim()`);
  for (let i = 0; i < 400 && (await typed()); i++) await ui.press('Backspace');
}

/** Work in the project folder itself (not a separate copy), so what the agent changes shows in the folder. */
async function thisFolder(ui) {
  if (await ui.exists({ css: '.sessions-chat-isolation-checkbox' })) {
    const on = await ui.eval(`!!document.querySelector('.sessions-chat-isolation-checkbox .monaco-custom-toggle.checked, .sessions-chat-isolation-checkbox [aria-checked="true"]')`);
    if (on) await ui.click({ css: '.sessions-chat-isolation-checkbox' });
  }
}

const lastRequest = (ui) => ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-request')].at(-1); return r ? r.innerText.trim() : ''; })()`);

async function sendTyped(ui, words) {
  await focusInput(ui);
  await ui.type(words);
  await ui.press('Enter', { send: true });
}

/** Find a leaf element by its words (case as written, not as styled), scroll it to the middle and tag it for mark(). */
async function tagText(ui, re, tag, within = 'body') {
  return ui.eval(`(() => {
    const re = ${re};
    const els = [...document.querySelectorAll(${JSON.stringify(within)} + ' *')].filter(e => e.offsetParent && re.test(e.textContent || ''));
    const leaf = els.filter(e => ![...e.children].some(c => re.test(c.textContent || ''))).at(0);
    if (!leaf) return false;
    leaf.scrollIntoView({ block: 'center' });
    leaf.setAttribute('data-b7', ${JSON.stringify(tag)});
    return leaf.textContent.trim().slice(0, 300);
  })()`);
}

async function partSettings(ui, out) {
  await ui.press('Cmd+,');
  await ui.waitFor({ css: '.part.sidebar.dispatch-settings-open .dispatch-settings-nav', webview: false }, { timeoutMs: 15000 });
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="agents"]', webview: false });
  await until(ui, () => tagText(ui, '/Tidy up after work/i', 'tidy-head', '.dispatch-settings-page'), 'Tidy up after work on the Agents page', 30000);
  // the rows come after the CLI answers ("Reading…" until then; seconds on a busy Mac)
  await until(ui, () => ui.eval(`(() => { const t = document.querySelector('.dispatch-settings-page')?.textContent || ''; const s = t.slice(t.search(/Tidy up after work/i)); return /Check by itself|could not read this/.test(s); })()`), 'the Tidy up rows after Reading…', 60000);
  await ui.sleep(800);
  const page = await ui.eval(`document.querySelector('.dispatch-settings-page')?.textContent || ''`);
  const at = page.search(/Tidy up after work/i);
  out.settings = page.slice(at, at + 700);
  assert.ok(/\/neat-freak/.test(out.settings), 'the setting names /neat-freak: ' + out.settings);
  assert.ok(!/\/neat(?![-\w])/.test(out.settings), 'no /neat without -freak: ' + out.settings);
  assert.ok(/reports first and changes only what you pick/.test(out.settings), 'it says the command reports first: ' + out.settings);
  out.tidyDetail = await tagText(ui, '/type \\/neat-freak in a session/', 'tidy-detail', '.dispatch-settings-page');
  await ui.sleep(500);
  await ui.screenshot('01-tidy-setting');
  await ui.mark({ css: '[data-b7="tidy-detail"]', webview: false }, { what: 'Names the command people really type, /neat-freak, and says it reports first', where: 'Settings › Agents › Tidy up after work', how: '⌘, then Agents, at the bottom' });
  await ui.press('Escape');
  await ui.sleep(800);
}

async function partPlain(ui, out, folder) {
  await newSessionInProject(ui, folder);
  await closeTips(ui);
  const page = await ui.eval('document.body.innerText');
  out.plain = { separateCopy: /Separate copy|This folder/.test(page), worktree: /New Worktree|Worktree/.test(page) };
  assert.ok(!/New Worktree/.test(page), 'the new-session page still says New Worktree');
  await ui.screenshot('02-new-session-chips');
  out.chip = await tagText(ui, '/^\\s*(Separate copy|This folder)\\s*$/', 'chip');
  if (out.chip) await ui.mark({ css: '[data-b7="chip"]', webview: false }, { what: 'Where the agent works, in plain words', where: 'the new session page, under the message box', how: 'click to switch between This folder and Separate copy' });
  await ui.openCustomizations('Hooks').catch(() => null);
  const hooks = await ui.eval('document.body.innerText');
  out.hooks = /Commands that run by themselves/.test(hooks);
  assert.ok(!/agentic lifecycle/.test(hooks), 'Hooks still say "agentic lifecycle"');
  await ui.screenshot('03-hooks');
  await ui.press('Escape');
  await ui.sleep(800);
}

async function partEnglish(ui, out, folder) {
  out.language = cli(ui, ['language', 'en', '--json']);
  const brief = dispatchText(ui, ['prime'], folder);
  // only Dispatch's own words: the headings and the first line (the board and reminders hold the instance's data)
  const own = brief.split('\n').filter(l => /^#/.test(l));
  out.briefHeadings = own;
  assert.ok(own.length && !own.some(l => CJK.test(l)), 'the brief has Chinese headings: ' + own.join(' | '));
  const before = receipts(ui).length;
  await newSessionInProject(ui, folder);
  await ui.pickEngine('OpenCode', 360000);
  await thisFolder(ui);
  await clearBox(ui);
  out.model = await pickModel(ui);
  await sendTyped(ui, 'Something for later, not now: add a LICENSE file with the MIT licence to this project. Do not do it now. Just reply OK and one sentence on what you noted.');
  const reply = await waitTurn(ui, 300000);
  out.englishReply = reply.text.slice(0, 400);
  assert.ok(!/Error from provider|Internal error/.test(reply.text), 'the test model did not answer: ' + out.englishReply);
  assert.ok(!CJK.test(reply.text), 'the agent answered in Chinese: ' + out.englishReply);
  const noted = await until(ui, async () => { const r = receipts(ui); return r.length > before ? r : null; }, 'the thing for later on the board', 120000, 2000).catch(() => receipts(ui));
  out.receipts = noted.slice(before);
  const titles = JSON.stringify(out.receipts);
  assert.ok(!CJK.test(titles), 'the noted title is Chinese: ' + titles);
  await restPointer(ui);
  await ui.screenshot('04-english-session');
  if (await ui.exists({ css: '.dispatch-capture-line', webview: false })) {
    await ui.mark({ css: '.dispatch-capture-line', webview: false }, { what: 'Noted in English', where: 'under your message', how: 'say something for later' });
  }
}

async function partNeat(ui, out, folder) {
  const head = git(folder, 'rev-parse', 'HEAD');
  const status = git(folder, 'status', '--porcelain');
  const prefs = prefsCount(ui);
  await newSessionInProject(ui, folder);
  await ui.pickEngine('OpenCode', 360000);
  await thisFolder(ui);
  await clearBox(ui);
  await pickModel(ui);
  await focusInput(ui);
  await ui.type('/neat');
  await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 30000 });
  // Enter on the open slash menu completes the command (it sends nothing); the runner asks to be told it is meant
  await ui.press('Enter', { send: true });
  await ui.sleep(800);
  const typed = await ui.eval(`(document.querySelector('.sessions-chat-editor .view-lines')?.textContent || '').replace(/\\u00a0/g, ' ').trim()`);
  out.completed = typed;
  assert.equal(typed, '/neat-freak', 'Enter after /neat completes to /neat-freak');
  await ui.press('Enter', { send: true });
  const sent = await until(ui, async () => (await lastRequest(ui)) || null, 'your message in the chat', 60000);
  out.sentShows = sent.slice(0, 300);
  const reply = await waitTurn(ui, 1500000);
  out.neatReply = reply.text.slice(0, 1500);
  out.neatAsking = reply.asking;
  out.afterNeat = { head: git(folder, 'rev-parse', 'HEAD'), status: git(folder, 'status', '--porcelain'), prefs: prefsCount(ui), agentsMd: fs.existsSync(path.join(folder, 'AGENTS.md')) };
  await restPointer(ui);
  await ui.screenshot('05-neat-report');
  assert.equal(out.afterNeat.head, head, 'the tidy-up made a commit');
  assert.equal(out.afterNeat.status, status, 'the tidy-up changed files: ' + out.afterNeat.status);
  assert.equal(out.afterNeat.prefs, prefs, 'the tidy-up added a preference');
  assert.ok(!/Base directory for this skill|Report first, change only what the person picks/.test(sent), 'your message shows the skill file: ' + out.sentShows);
  assert.ok(/\/neat-freak/.test(sent), 'your message shows /neat-freak: ' + out.sentShows);
  await ui.mark({ css: '.interactive-request', webview: false }, { what: 'Your message stays /neat-freak', where: 'the chat', how: 'type /neat, Enter, Enter' });

  // after the window reloads the session is read back from OpenCode: still /neat-freak
  const title = await ui.eval(`(document.querySelector('.agent-session-item.selected .agent-session-title, .monaco-list-row.selected .agent-session-title, .monaco-list-row.focused .agent-session-title')?.innerText || '').trim()`);
  out.sessionTitle = title;
  await ui.press('F1');
  await ui.type('Reload Window');
  await ui.sleep(800);
  await ui.press('Enter');
  await ui.sleep(8000);
  await ui.attach('agents', 120000);
  await offScreen(ui);
  await closeTips(ui);
  if (title) await ui.openSession(title).catch(() => null);
  const again = await until(ui, async () => (await lastRequest(ui)) || null, 'the session after the reload', 90000).catch(() => '');
  out.afterReload = again.slice(0, 300);
  await ui.screenshot('06-neat-after-reload');
  if (again) assert.ok(!/Base directory for this skill/.test(again) && /\/neat-freak/.test(again), 'after the reload your message shows: ' + out.afterReload);
}

async function partFixit(ui, out) {
  const dir = makeProject('shop');
  write(path.join(dir, 'scripts', 'lint.sh'), '#!/bin/sh\nif grep -n "console.log" *.js 2>/dev/null; then echo "eslint: no-console"; echo "✖ 1 problem (1 error, 0 warnings)"; exit 1; fi\n', 0o755);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'chore: a lint check');
  const hooks = path.join(dir, '.git', 'hooks');
  git(dir, 'config', 'core.hooksPath', hooks);
  write(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexec sh scripts/lint.sh\n', 0o755);
  cli(ui, ['projects-view', 'add', dir, '--name', 'shop', '--json']);
  await newSessionInProject(ui, dir);
  await ui.pickEngine('OpenCode', 360000);
  await pickModel(ui);
  await thisFolder(ui);
  await clearBox(ui);
  await sendTyped(ui, 'Reply with exactly: READY. Do not run anything.');
  await waitTurn(ui, 300000);
  write(path.join(dir, 'app.js'), 'export function add(a, b) {\n  console.log("adding", a, b);\n  return a + b;\n}\n');
  const before = receipts(ui).length;
  await ui.openTab('Changes');
  await ui.waitFor({ text: 'app.js', webview: false }, { timeoutMs: 120000 });
  await ui.click({ text: 'Commit', exact: true, webview: false });
  await until(ui, async () => ui.exists({ text: 'Let the agent fix it', webview: false }), 'the card with Let the agent fix it', 300000, 2000);
  await ui.screenshot('07-fix-card');
  await ui.click({ text: 'Let the agent fix it', webview: false });
  const sent = await until(ui, async () => { const t = await lastRequest(ui); return t && !/READY/.test(t) ? t : null; }, 'the fix prompt in the chat', 60000);
  out.fixPrompt = sent.slice(0, 300);
  await ui.sleep(20000);
  const after = receipts(ui);
  out.fixReceipts = after.slice(before);
  const line = await ui.eval(`(() => { const l = [...document.querySelectorAll('.dispatch-capture-line')].at(-1); return l ? l.innerText : ''; })()`);
  out.fixLine = line;
  await restPointer(ui);
  await ui.screenshot('08-fix-sent');
  const noted = out.fixReceipts.filter(r => (r.noted || r.tasks || r.items || []).length || r.task);
  assert.equal(noted.length, 0, 'the fix prompt went on the board: ' + JSON.stringify(out.fixReceipts));
  assert.ok(!/Noted [1-9]/.test(line), 'a Noted line under the fix prompt: ' + line);
  await ui.mark({ css: '.interactive-request', webview: false }, { what: 'Dispatch\'s own prompt, not your request', where: 'the chat after Let the agent fix it', how: 'nothing is noted under it' });
  await waitTurn(ui, 600000).catch(() => null);
}

export default async function (ui) {
  const out = {};
  const save = () => fs.writeFileSync(path.join(ui.out, 'result.json'), JSON.stringify(out, null, 2));
  try {
    // neat-freak is one of the skills setup gives every agent; a test instance skips setup, so give it to OpenCode
    // before any OpenCode session starts (a running agent reads its skills when it starts)
    const pool = path.join(ui.rec.dispatch_home, 'skills', 'neat-freak');
    if (!fs.existsSync(pool)) fs.cpSync(path.join(path.dirname(ui.rec.cli), '..', '..', 'agent', 'skills', 'neat-freak'), pool, { recursive: true });
    out.skillEnable = dispatchText(ui, ['skills', 'enable', 'neat-freak', '--agent', 'opencode']).trim();
    await ui.openAgents(ui.demoFolder);
    await offScreen(ui);
    await closeTips(ui);
    const todo = makeProject('todo-web');
    cli(ui, ['projects-view', 'add', todo, '--name', 'todo-web', '--json']);
    for (const [name, fn] of [['settings', partSettings], ['plain', partPlain], ['english', partEnglish], ['neat', partNeat], ['fixit', partFixit]]) {
      if (!PARTS.has(name)) continue;
      out.part = name;
      save();
      try {
        await fn(ui, out, todo);
        out[`${name}_ok`] = true;
      } catch (e) {
        out[`${name}_error`] = String(e && e.stack || e).slice(0, 1500);
        await ui.screenshot(`error-${name}`).catch(() => null);
        for (let i = 0; i < 3; i++) await ui.press('Escape').catch(() => null);
      }
      save();
    }
    out.part = 'done';
    const failed = Object.keys(out).filter(k => k.endsWith('_error'));
    if (failed.length) throw new Error('parts failed: ' + failed.join(', '));
  } finally {
    save();
  }
}
