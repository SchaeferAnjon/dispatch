// Agent and task-board fixes of the 10-07 bug round (group b8-core), the way a person meets them:
//   cli       a thing Dispatch noted for conversation A is not handed to conversation B's agent; A's agent takes it
//             and keeps its checklist; a checklist number out of range is said in English (task-lj06.17, task-lj06.24)
//   question  the question card: Submit with nothing picked says so; a word typed in the message box is the answer
//             (task-lj06.15)
//   links     an agent that writes "(Add dark mode, task-x)" shows the title once (task-lj06.30)
//   browser   `dispatch browser --ide open` twice on one page: one tab (task-lj06.34)
//   settle    OpenCode is asked to make the Add button blue and commit (it already is), Codex to round its corners and
//             commit: no separate commit task, and the noted task is closed when the agent's turn ends (task-lj06.18)
//   switch    Codex → OpenCode → Codex: the hand-over quotes no window notes, and back on Codex the first turn runs on
//             the model it had there, which the model chip shows too (task-lj06.22, task-lj06.31)
//   turbo     a one-part Turbo plan says "1 part", offers no "At a time", forecasts minutes not half an hour, and ends
//             "Done · 1 part in …" (task-lj06.29)
//   continue  a conversation continued from History in the chat starts on Full auto (task-lj06.33)
//   terminal  Claude Code started from ⌘T starts in the mode Full auto means (task-lj06.33)
// Test models: OpenCode DeepSeek Flash (or GLM 5.3 Flash, else a free Zen model); Codex for a few short turns; no Claude turn.
// B8_PARTS picks parts (comma separated).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

export const meta = { needs: ['opencode', 'codex'], timeout: 3600, title: 'b8-core: agents and the task board', description: 'Question card answers, task names once, one tab per page, the board follows the conversation, the model and approvals carry over, Turbo for one part.' };

const ALL = 'cli,question,links,browser,settle,switch,turbo,continue,terminal';
// the build service passes no environment: a copy of this file with another DEFAULT runs only some parts
const DEFAULT = ALL;
const PARTS = (process.env.B8_PARTS || DEFAULT).split(',').map(s => s.trim()).filter(Boolean);
const run = promisify(execFile);
const TURBO_MODEL = 'opencode/mimo-v2.6-flash-free'; // a free model every OpenCode has
const STAMP = Date.now().toString(36).slice(-5);
const E2E_ROOT = path.join(os.homedir(), `b8-core-e2e-${STAMP}`);
const fresh = '.sessions-chat-editor';
// the question card still waiting for an answer (VS Code's chatQuestionCarouselPart.ts)
const CARD = '.chat-question-carousel-container:not(.chat-question-carousel-used)';
const chatInput = '.interactive-input-part .monaco-editor';

// ---------------------------------------------------------------- the instance's CLI, in the instance's environment
async function cli(ui, args, extraEnv = {}) {
  const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); x=json.loads(sys.argv[2]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; e=E.instance_env(r); e.update(x); os.execve(sys.executable,[sys.executable,r['cli'],*sys.argv[3:]],e)";
  const r = await run('python3', ['-c', bootstrap, JSON.stringify(ui.rec), JSON.stringify(extraEnv), ...args], { env: process.env, maxBuffer: 16 * 1024 * 1024, timeout: 240000 }).catch(e => e);
  return { out: r.stdout || '', err: r.stderr || '', code: r.code || 0 };
}
function json(text) {
  const i = [text.indexOf('{'), text.indexOf('[')].filter(x => x >= 0);
  if (!i.length) throw new Error('no JSON in: ' + text.slice(0, 300));
  return JSON.parse(text.slice(Math.min(...i)));
}
async function cliJson(ui, args, extraEnv) {
  const r = await cli(ui, [...args, '--json'], extraEnv);
  try { return json(r.out); } catch (e) { throw new Error(`dispatch ${args.join(' ')}: ${e.message}; stderr: ${r.err.slice(0, 400)}`); }
}

/** Python in the instance's environment with the CLI's folder on the path; prints what `code` prints. */
async function py(ui, code) {
  const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; e=E.instance_env(r); os.execve(sys.executable,[sys.executable,'-c','import sys,os; sys.path.insert(0,os.path.dirname(sys.argv[1])); exec(sys.argv[2])',r['cli'],sys.argv[2]],e)";
  const r = await run('python3', ['-c', bootstrap, JSON.stringify(ui.rec), code], { env: process.env, maxBuffer: 16 * 1024 * 1024, timeout: 120000 }).catch(e => e);
  return ((r.stdout || '') + (r.stderr || '')).trim();
}

async function until(ui, fn, what, ms = 120000, every = 1000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await ui.sleep(every);
  }
  throw new Error(`Timed out: ${what}`);
}

// ---------------------------------------------------------------- a project in the home folder (OpenCode's sandbox does not work under /tmp)
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(E2E_ROOT, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Dispatch e2e', GIT_AUTHOR_EMAIL: 'e2e@localhost', GIT_COMMITTER_NAME: 'Dispatch e2e', GIT_COMMITTER_EMAIL: 'e2e@localhost' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
function makeProject(name) {
  const dir = path.join(E2E_ROOT, 'work', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  write(gitEnv.GIT_CONFIG_GLOBAL, '');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Dispatch e2e');
  git(dir, 'config', 'user.email', 'e2e@localhost');
  write(path.join(dir, 'README.md'), `# ${name}\n\nA small to-do web page. Open index.html in a browser (no build step).\n`);
  write(path.join(dir, 'index.html'), '<!doctype html>\n<title>To-Do List</title>\n<h1>To-Do List</h1>\n<ul id="list"></ul>\n<input id="item">\n<button id="add" style="background: blue; color: white">Add</button>\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'feat: a to-do page');
  return dir;
}

// ---------------------------------------------------------------- the window
async function closeTips(ui) {
  await ui.mouse('mouseMoved', 900, 760).catch(() => undefined);
  for (let i = 0; i < 3 && await ui.exists('Welcome to Dispatch'); i++) { await ui.press('Escape'); await ui.sleep(500); }
  for (let i = 0; i < 5 && (await ui.exists({ css: 'button.dispatch-tour-close' })); i++) {
    await ui.click({ css: 'button.dispatch-tour-close' }).catch(() => undefined);
    await ui.sleep(500);
  }
}

/** Registers a project the way the Add a project dialog does; a board still busy right after the instance started
 * answers "Try again in a moment" (it went unseen, and the project never reached the Projects page). */
async function addProject(ui, dir, name) {
  let last = '';
  for (let i = 0; i < 6; i++) {
    const r = await cli(ui, ['projects-view', 'add', dir, '--name', name, '--json']);
    last = (r.out + r.err).trim().slice(-300);
    if (/"ok": true/.test(r.out)) return;
    await ui.sleep(10000);
  }
  throw new Error(`the project ${name} was not registered: ${last}`);
}

async function newSessionInProject(ui, folder) {
  const name = folder.split('/').filter(Boolean).at(-1);
  await closeTips(ui);
  for (let attempt = 0; ; attempt++) {
    // registering it again changes the board, and the window reads its projects again
    if (attempt) await addProject(ui, folder, name);
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
  await closeTips(ui);
}

async function pickAgent(ui, label) {
  const picker = '.sessions-chat-session-type-picker';
  if ((await ui.eval(`document.querySelector('${picker}')?.innerText.trim()`)) !== label) {
    await ui.click({ css: picker });
    await ui.click({ text: label, exact: true, within: '.context-view' });
    await until(ui, async () => (await ui.eval(`document.querySelector('${picker}')?.innerText.trim()`)) === label, `the ${label} chip`, 30000);
  }
}

/** Work in the project folder itself, so what the agent changes shows there. */
async function thisFolder(ui) {
  if (await ui.exists({ css: '.sessions-chat-isolation-checkbox' })) {
    const on = await ui.eval(`!!document.querySelector('.sessions-chat-isolation-checkbox .monaco-custom-toggle.checked, .sessions-chat-isolation-checkbox [aria-checked="true"]')`);
    if (on) await ui.click({ css: '.sessions-chat-isolation-checkbox' });
  }
}

async function focusInput(ui, css) {
  for (let i = 0; i < 8; i++) {
    await closeTips(ui);
    await ui.click({ css: i % 2 ? `${css} .view-lines` : css }).catch(() => undefined);
    await ui.sleep(400);
    if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('${css}')`)) return;
    await ui.sleep(800);
  }
  throw new Error('The message box does not take the focus: ' + css);
}

const inputCss = async (ui) => (await ui.exists({ css: fresh })) ? fresh : chatInput;

async function typed(ui) {
  const css = await inputCss(ui);
  return ui.eval(`(document.querySelector('${css} .view-lines')?.textContent || '').replace(/\\u00a0/g, ' ').trim()`);
}

async function clearBox(ui) {
  const css = await inputCss(ui);
  await focusInput(ui, css);
  await ui.press('End');
  for (let i = 0; i < 300 && (await typed(ui)); i++) await ui.press('Backspace');
}

/** The cheap test model through the /model menu: DeepSeek Flash or GLM 5.3 Flash when OpenCode has them, else OpenCode Zen's free MiMo Flash (the mini has no keys; Ling's endpoint was down on 10-07). */
async function pickModel(ui) {
  await focusInput(ui, fresh);
  await ui.type('/model');
  await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 30000 });
  let seen = '';
  const row = await until(ui, async () => {
    const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => ({name:r.querySelector('.dsm-name')?.textContent}))`);
    seen = rows.map(r => r.name).join(', ');
    return rows.find(r => /DeepSeek.*Flash/i.test(r.name || '')) || rows.find(r => /GLM-5\.3-Flash/i.test(r.name || '')) || rows.find(r => /MiMo.*Flash.*Free/i.test(r.name || '')) || rows.find(r => /Flash.*Free|Free.*Flash/i.test(r.name || ''));
  }, 'a test model', 45000).catch(e => { throw new Error(`${e.message}; the menu had: ${seen}`); });
  for (let i = 0; i < 40 && (await typed(ui)); i++) await ui.press('Backspace');
  await ui.type(`/${row.name.replace(/\s+/g, '')}`);
  await until(ui, async () => ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row .dsm-name')].some(n => n.textContent === ${JSON.stringify(row.name)})`), `the menu row ${row.name}`, 20000);
  await ui.click({ text: row.name, exact: true, within: '.dispatch-slash-menu' });
  await ui.press('Escape');
  for (let i = 0; i < 40 && (await typed(ui)); i++) await ui.press('Backspace');
  return row.name;
}

async function send(ui, words) {
  const css = await inputCss(ui);
  await focusInput(ui, css);
  await ui.type(words);
  await ui.press('Enter', { send: true });
}

const lastResponse = (ui) => ui.eval(`(() => {
  const rows = [...document.querySelectorAll('.interactive-response')];
  const r = rows.at(-1);
  const running = [...document.querySelectorAll('.interactive-input-part [aria-label]')].some(e => e.offsetParent && /^(Stop|Cancel)\\b/.test(e.getAttribute('aria-label'))); // the chat's own Stop, not the browser's Stop sharing
  return r ? { text: r.innerText, html: r.innerHTML.length, loading: r.classList.contains('chat-response-loading') || running, asking: !!document.querySelector('.chat-question-carousel-container:not(.chat-question-carousel-used)') } : null;
})()`);
const responseCount = (ui) => ui.eval(`document.querySelectorAll('.interactive-response').length`);

/** The end of the turn that follows `before` responses: no Stop button, its words unchanged for three looks; or a question card. */
async function waitTurn(ui, before, ms = 600000) {
  let last = '', same = 0;
  return until(ui, async () => {
    if ((await responseCount(ui)) <= before) return null;
    const r = await lastResponse(ui);
    if (!r) return null;
    same = r.text === last ? same + 1 : 0;
    last = r.text;
    if (r.asking && same >= 1) return r;
    return !r.loading && same >= 2 && r.text.trim().length > 1 ? r : null;
  }, 'the end of the turn', ms, 3000);
}

async function boxes(ui, image, items) {
  const out = [];
  for (const it of items) {
    const b = await ui.eval(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(it.css)})].filter(e => e.offsetParent).pop(); if (!e) return null; const r = e.getBoundingClientRect(); const d = devicePixelRatio; return [r.x * d, r.y * d, r.width * d, r.height * d].map(Math.round); })()`);
    if (b && b[2] > 0) out.push({ n: it.n, box: b, what: it.what });
  }
  const size = await ui.eval(`[Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio)]`);
  fs.writeFileSync(path.join(ui.out, `${image}.boxes.json`), JSON.stringify({ size, items: out }));
}

/** Tags the innermost visible element whose text matches, for a box or a mark. */
async function tag(ui, re, name, within = 'body') {
  return ui.eval(`(() => {
    const re = ${re};
    const els = [...document.querySelectorAll(${JSON.stringify(within)} + ' *')].filter(e => e.offsetParent && re.test(e.textContent || ''));
    const leaf = els.filter(e => ![...e.children].some(c => re.test(c.textContent || ''))).at(0);
    if (!leaf) return false;
    leaf.scrollIntoView({ block: 'center' });
    leaf.setAttribute('data-b8', ${JSON.stringify(name)});
    return leaf.textContent.trim().slice(0, 300);
  })()`);
}

// ---------------------------------------------------------------- parts

async function partCli(ui, o, dir) {
  await cli(ui, ['language', 'en']);
  const A = `aaaaaaaa-${STAMP}-4222-8333-944455556666`, B = `bbbbbbbb-${STAMP}-4333-8444-955566667777`;
  const say = async (text) => cliJson(ui, ['capture', 'note', '--session', `agent-host-opencode:/${A}`, '--project', 'todo-b8', '--cwd', dir, '--text', text]);
  let r = await say('Add a search box above the to-do list now, please.');
  let item = (r.items || []).find(i => i.kind === 'new');
  o.noted = { title: item?.title, task: item?.task, state: item?.state, by: r.by };
  assert.ok(item, 'nothing was noted: ' + JSON.stringify(r).slice(0, 400));
  const show = async (id) => (await cliJson(ui, ['task', 'show', id]));
  const before = await show(item.task);
  o.notedStatus = before.status; o.notedBd = before.bd_status;
  // B's agent begins the same work: its own task, not A's
  const b = await cliJson(ui, ['begin', 'Add a search box to the list: people find items faster', '--project', 'todo-b8', '-d', 'The person asked for a search box above the list in this conversation.', '--session', B]);
  o.b = { id: b.id, noted: !!b.noted };
  if (before.status === 'in_progress') {
    assert.notEqual(b.id, item.task, 'session B took the task noted for session A');
    assert.ok(!b.noted, 'B was told the noted task is its own');
  }
  // A's agent begins it with a checklist: it is A's, and the checklist is kept
  const acc = '- [ ] The search box is above the list\n- [ ] Typing filters the items';
  const a = await cliJson(ui, ['begin', 'Add a search box above the list: find items faster', '--project', 'todo-b8', '-d', 'The person asked for a search box above the list.', '--acceptance', acc, '--session', A]);
  o.a = { id: a.id, noted: !!a.noted };
  const log1 = await cli(ui, ['log', a.id, '--claim', '1', 'The box is in index.html above the list']);
  const log9 = await cli(ui, ['log', a.id, '--claim', '9', 'nothing']);
  o.log1 = (log1.out + log1.err).trim().slice(0, 300);
  o.log9 = (log9.out + log9.err).trim().slice(0, 300);
  assert.ok(!/[一-鿿]/.test(o.log9), 'the error is not English: ' + o.log9);
  assert.match(o.log9, /There is no item 9: the checklist has 2 items/, 'the checklist or the error: ' + o.log9);
  assert.ok(!/There is no item|没有第/.test(o.log1), 'ticking item 1 failed: ' + o.log1);
  fs.writeFileSync(path.join(ui.out, 'cli.txt'), JSON.stringify(o, null, 2));
}

async function partQuestion(ui, o, dir) {
  await newSessionInProject(ui, dir);
  await pickAgent(ui, 'OpenCode');
  await thisFolder(ui);
  o.model = await pickModel(ui);
  const n0 = await responseCount(ui);
  await send(ui, 'Use your question tool to ask me which footer colour I want, offering only red or green. Do not change any file. After my answer, reply with one sentence that names the colour I gave.');
  await until(ui, async () => ui.exists({ css: CARD }), 'the question card', 300000, 2000);
  await ui.sleep(1500);
  o.card = await ui.eval(`document.querySelector('${CARD}')?.innerText.replace(/\\s+/g, ' ').trim()`);
  o.pickedBefore = await ui.eval(`[...document.querySelectorAll('${CARD} .chat-question-list-item')].map(e => e.classList.contains('selected') || !!e.querySelector('.codicon-check'))`);
  assert.ok(!o.pickedBefore.some(Boolean), 'an option is picked before the person picked one: ' + JSON.stringify(o.pickedBefore));
  await ui.click({ text: 'Submit', exact: true, within: CARD });
  await ui.sleep(1000);
  o.nothingChosen = await ui.eval(`document.querySelector('${CARD}')?.innerText || ''`);
  assert.match(o.nothingChosen, /Pick an option, or type your answer in the message box/, 'Submit with nothing chosen: ' + o.nothingChosen);
  await tag(ui, '/Pick an option, or type your answer in the message box/', 'nothing', CARD);
  await ui.screenshot('q1-nothing-chosen');
  await boxes(ui, 'q1-nothing-chosen', [{ n: 1, css: '[data-b8="nothing"]', what: 'Submit with nothing picked says so' }]);
  await clearBox(ui);
  await focusInput(ui, chatInput);
  await ui.type('Purple');
  await ui.sleep(500);
  await ui.screenshot('q2-typed');
  await boxes(ui, 'q2-typed', [{ n: 1, css: CARD, what: 'the question card' }, { n: 2, css: chatInput, what: 'Purple typed in the message box' }]);
  await ui.click({ text: 'Submit', exact: true, within: CARD });
  o.boxAfter = await typed(ui);
  const r = await waitTurn(ui, n0, 300000);
  await ui.sleep(2000);
  const last = await lastResponse(ui);
  o.reply = last.text.slice(-600);
  o.chat = (await ui.eval(`[...document.querySelectorAll('.interactive-item-container')].map(e => e.innerText).join('\\n---\\n')`)).slice(-1500);
  assert.equal(o.boxAfter, '', 'the word stayed in the message box: ' + o.boxAfter);
  assert.match(o.chat, /purple/i, 'the answer is not Purple: ' + o.chat);
  assert.ok(!/you chose red|chose red|picked red|\bred\b footer/i.test(last.text), 'the agent got red: ' + last.text.slice(-300));
  await tag(ui, '/[Pp]urple/', 'purple', '.interactive-session');
  await ui.screenshot('q3-answered');
  await boxes(ui, 'q3-answered', [{ n: 1, css: '[data-b8="purple"]', what: 'the agent got Purple' }]);
}

async function partLinks(ui, o, dir) {
  const t = await cliJson(ui, ['begin', 'Add dark mode', '--project', 'todo-b8', '-d', 'The person would like a dark mode some day; not now.', '--force']);
  o.task = t.id;
  await newSessionInProject(ui, dir);
  await pickAgent(ui, 'OpenCode');
  await thisFolder(ui);
  o.model = await pickModel(ui);
  assert.ok(/OpenCode/.test(await ui.eval(`document.querySelector('.sessions-chat-session-type-picker')?.innerText || ''`)), 'not an OpenCode session');
  const n0 = await responseCount(ui);
  await send(ui, `Reply with exactly this sentence and nothing else, no tools: Dark mode is on the board in Later (Add dark mode, ${t.id}).`);
  await waitTurn(ui, n0, 300000);
  await ui.sleep(4000);
  const last = await lastResponse(ui);
  o.reply = last.text.slice(-300);
  // the answer's line, the last one: a model that shows its reasoning quotes the request (raw id included) above it
  const said = last.text.split('\n').filter(l => /Dark mode is on the board/.test(l)).at(-1) || last.text;
  o.line = said;
  o.count = (said.match(/Add dark mode/g) || []).length;
  o.link = await ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); const a = r && r.querySelector('.dispatch-task-link'); return a ? a.textContent : ''; })()`);
  assert.equal(o.count, 1, 'the title shows ' + o.count + ' times: ' + said);
  assert.ok(!/task-[a-z0-9]{2,8}/.test(said), 'the id shows: ' + said);
  await ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); const a = r && r.querySelector('.dispatch-task-link'); if (a) { a.scrollIntoView({ block: 'center' }); a.setAttribute('data-b8', 'link'); } })()`);
  await ui.screenshot('l1-title-once');
  await boxes(ui, 'l1-title-once', [{ n: 1, css: '[data-b8="link"]', what: 'the task title, once, as a link' }]);
}

async function partBrowser(ui, o, dir) {
  const url = 'file://' + path.join(dir, 'index.html');
  const one = await cliJson(ui, ['browser', '--ide', 'open', url]);
  const two = await cliJson(ui, ['browser', '--ide', 'open', url]);
  await ui.sleep(2000);
  const st = await cliJson(ui, ['browser', '--ide', 'status']);
  o.first = one.page; o.second = two.page; o.text = (two.text || '').slice(0, 200);
  o.pages = (st.pages || []).map(p => ({ id: p.id, url: p.url, title: p.title }));
  o.same = o.pages.filter(p => (p.url || '').replace(/#.*$/, '') === url).length;
  assert.equal(o.same, 1, 'tabs of that page: ' + JSON.stringify(o.pages));
  assert.equal(one.page, two.page, 'the second open made another page');
  await ui.screenshot('b1-one-tab');
}

// OpenCode is asked for what already is so (not needed), Codex for a one-line change it commits (done)
const SETTLE_RUNS = [
  { agent: 'OpenCode', words: 'Make the Add button blue. Then commit it.', match: /blue/i },
  { agent: 'Codex', words: 'Give the Add button rounded corners (border-radius: 6px). Then commit it.', match: /round|corner|radius/i },
];

async function partSettle(ui, o, dir) {
  const only = process.env.B8_SETTLE_AGENT;
  for (const run of SETTLE_RUNS.filter(r => !only || r.agent === only)) {
    const x = (o[run.agent] = {});
    try {
      await settleWith(ui, x, dir, run);
      x.ok = true;
    } catch (e) {
      x.ok = false;
      x.error = String(e?.message || e).slice(0, 600);
      await ui.screenshot(`x-settle-${run.agent.toLowerCase()}`).catch(() => undefined);
      await ui.press('Escape').catch(() => undefined);
    }
  }
  fs.writeFileSync(path.join(ui.out, 'settle.json'), JSON.stringify(o, null, 2));
  const failed = SETTLE_RUNS.filter(r => o[r.agent] && !o[r.agent].ok).map(r => `${r.agent}: ${o[r.agent].error}`);
  if (failed.length) throw new Error(failed.join(' | '));
}

async function settleWith(ui, o, dir, run) {
  await newSessionInProject(ui, dir);
  o.agent = run.agent;
  // the instance's Codex trusts Dispatch's hook entry the way the window does at its start (bug round E4)
  o.hooks = (await cli(ui, ['hooks', 'sync'])).out.slice(-300);
  await pickAgent(ui, o.agent);
  await thisFolder(ui);
  if (o.agent === 'OpenCode') o.model = await pickModel(ui);
  const words = run.words;
  const n0 = await responseCount(ui);
  await send(ui, words);
  const r = await waitTurn(ui, n0, 600000);
  o.reply = (await lastResponse(ui)).text.slice(-500);
  if (/usage limit|hit your limit/i.test(o.reply)) throw new Error(`${run.agent} is out of turns on this Mac: ${o.reply.slice(0, 200)}`);
  const receipt = await until(ui, async () => (await cliJson(ui, ['capture', 'list'])).receipts?.find(x => (x.text || '').includes(words)), 'the receipt of the message', 120000, 3000);
  o.items = (receipt.items || []).map(i => ({ kind: i.kind, title: i.title, task: i.task, state: i.state }));
  assert.ok(!o.items.some(i => /^commit/i.test(i.title || '')), 'a commit became its own task: ' + JSON.stringify(o.items));
  const main = o.items.find(i => run.match.test(i.title || ''));
  assert.ok(main, 'nothing noted for the work: ' + JSON.stringify(o.items));
  if (main) {
    const t = await until(ui, async () => { const x = await cliJson(ui, ['task', 'show', main.task]); return x.bd_status === 'closed' ? x : null; }, 'the noted task closed after the turn', 300000, 5000).catch(async e => ({ bd_status: (await cliJson(ui, ['task', 'show', main.task])).bd_status, error: e.message }));
    o.task = { id: main.task, status: t.bd_status, progress: JSON.stringify(t.progress || '').slice(0, 300) };
    if (t.bd_status !== 'closed') {
      // what the turn's end saw: the agents' hooks, the list of untaken tasks, the conversation's ids, and the
      // settle itself run by hand on the window's id
      const log = path.join(ui.rec.root, 'hook.log');
      o.hookLog = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(l => /"Stop"/.test(l)).slice(-6) : '(no hook log)';
      o.diag = await py(ui, `import json, dispatch as D, capture as C, tasks_view as TV
C.D = D
t = next(x for x in C.issues() if x["id"] == ${JSON.stringify(main.task)})
said = str(C.chat_of(t).get("session") or "")
print(json.dumps({"untaken": C.untaken_ids(), "chat": C.chat_of(t), "said_in": said, "keys": TV.session_keys(said), "mine": [x["id"] for x in C.mine_untaken(said)], "window_of": {k: C.window_of(k) for k in __import__("re").findall(r'"session": "([^"]+)"', open(os.path.join(os.path.dirname(os.environ.get("DISPATCH_HOOK_LOG", "")), "hook.log")).read())[-3:]} if os.environ.get("DISPATCH_HOOK_LOG") else {}, "provider": bool(C.provider())}, default=str)[:3000])`);
      o.settleLog = await py(ui, `import capture as C, os
p = os.path.join(C.folder(), "settle.jsonl")
print(open(p).read()[-2000:] if os.path.exists(p) else "(no settle log)")`);
      fs.writeFileSync(path.join(ui.out, `settle-${run.agent}.json`), JSON.stringify(o, null, 2));
    }
    assert.equal(t.bd_status, 'closed', 'the noted task is still ' + t.bd_status);
  }
  await ui.openTab('Tasks').catch(() => undefined);
  await ui.sleep(2500);
  await ui.screenshot(`s1-board-after-${run.agent.toLowerCase()}`);
}

// the message box on screen: a switch leaves the previous session's input part in the page, hidden
// the message box on screen (a switch leaves the previous session's input part in the page, hidden), its words and
// its buttons' names: in a narrow chat column the model and approvals chips show only an icon
const chipText = (ui) => ui.eval(`(() => {
  const p = [...document.querySelectorAll('.interactive-input-part')].filter(e => e.offsetParent && e.getBoundingClientRect().width > 0).at(-1) || document.body;
  const names = [...p.querySelectorAll('[aria-label], [title]')].filter(e => e.offsetParent).map(e => e.getAttribute('aria-label') || e.getAttribute('title'));
  return (p.innerText + ' ' + names.join(' ')).replace(/\\s+/g, ' ');
})()`);
const footerModel = (text) => (/\d+(?:\.\d+)?\s*(?:s|min)\s*[•·]\s*([^\n•·]+)/.exec(text) || [])[1]?.trim() || '';

/** The turn ends, or after `ms` it is stopped with the chat's own Stop (a free model that stalls). */
async function endTurn(ui, before, ms) {
  try {
    return await waitTurn(ui, before, ms);
  } catch {
    await ui.click({ css: '.interactive-input-part [aria-label^="Stop"]' }).catch(() => undefined);
    await ui.sleep(5000);
    return null;
  }
}

async function switchTo(ui, label, from) {
  await ui.click({ css: '.dispatch-harness-picker' });
  await ui.click({ text: label, exact: true, within: '.context-view' });
  // the hand-over as the new session's first message in the chat (the sessions list shows it as a title first)
  await until(ui, async () => (await ui.eval(`[...document.querySelectorAll('.interactive-session .interactive-request')].some(e => e.innerText.includes('This conversation moved from ${from} to ${label}'))`)), `the ${label} session with the hand-over`, 240000, 2000);
}

async function partSwitch(ui, o) {
  await cli(ui, ['language', 'en']);  // the hand-over is written in the person's language; the test reads English
  // inside the instance folder: the instance indexes only sessions there, and the hand-over reads the conversation from the index
  const dir = path.join(fs.realpathSync(ui.rec.root), 'projects', 'switch-b8');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    write(path.join(dir, 'index.html'), '<!doctype html>\n<title>To-Do List</title>\n<h1>To-Do List</h1>\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'feat: a page');
    await addProject(ui, dir, 'switch-b8');
  }
  // Codex → OpenCode → Codex: Codex answers on the mini (its free OpenCode models stall), and coming back to Codex
  // shows both halves of the bug: the first turn after a switch, and the model the conversation had there
  await newSessionInProject(ui, dir);
  await pickAgent(ui, 'Codex');
  await thisFolder(ui);
  let n0 = await responseCount(ui);
  await send(ui, 'Reply with exactly: READY B8. Do not use any tools.');
  await waitTurn(ui, n0, 300000);
  o.codexChipBefore = await chipText(ui);
  o.codexFooterBefore = footerModel((await lastResponse(ui)).text);
  // a page the agent can use, so the window adds its note about shared pages to the next message
  await cliJson(ui, ['browser', '--ide', 'open', 'file://' + path.join(dir, 'index.html')]).catch(() => undefined);
  n0 = await responseCount(ui);
  await send(ui, 'Reply with exactly: SECOND B8. Do not use any tools.');
  await waitTurn(ui, n0, 300000);
  // to OpenCode
  await switchTo(ui, 'OpenCode', 'Codex');
  o.handoff = await ui.eval(`[...document.querySelectorAll('.interactive-request')].map(e => e.innerText).join('\\n---\\n')`);
  o.ocChip = await chipText(ui);
  await endTurn(ui, 0, 240000);
  assert.ok(!/browser pages are currently shared/.test(o.handoff), 'the hand-over quotes the window note');
  assert.ok(/READY B8|SECOND B8/.test(o.handoff), 'the hand-over lost the conversation: ' + o.handoff.slice(0, 400));
  await tag(ui, '/This conversation moved from Codex to OpenCode/', 'handoff', '.interactive-session');
  await ui.screenshot('w1-handoff');
  await boxes(ui, 'w1-handoff', [{ n: 1, css: '[data-b8="handoff"]', what: 'the hand-over: only what was said, no window notes' }]);
  // back to Codex: its first turn runs on the model the conversation had on Codex
  await switchTo(ui, 'Codex', 'OpenCode');
  await waitTurn(ui, 0, 600000);
  await ui.sleep(3000);
  o.codexChipAfter = await chipText(ui);
  o.codexFooterAfter = footerModel((await lastResponse(ui)).text);
  assert.ok(o.codexFooterAfter, 'no model under the first turn back on Codex');
  assert.equal(o.codexFooterAfter, o.codexFooterBefore, 'back on Codex the first turn ran on another model');
  assert.ok(o.codexChipAfter.includes(o.codexFooterAfter), `the chip says ${o.codexChipAfter.slice(0, 200)}, the turn ran on ${o.codexFooterAfter}`);
  await tag(ui, new RegExp(o.codexFooterAfter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).toString(), 'cxfooter', '.interactive-session');
  await ui.screenshot('w2-back-on-codex');
  await boxes(ui, 'w2-back-on-codex', [{ n: 1, css: '[data-b8="cxfooter"]', what: 'the first turn back on Codex ran on the model it had' }, { n: 2, css: '.interactive-input-part', what: 'the model chip shows the same' }]);
  fs.writeFileSync(path.join(ui.out, 'switch.json'), JSON.stringify(o, null, 2));
}

const TIMELINE = `(() => {
  const t = document.querySelector('.dispatch-timeline');
  if (!t) return null;
  return { line: t.querySelector('.dt-line')?.innerText.trim() || '', title: t.querySelector('.dt-title')?.innerText.trim() || '',
    plan: t.querySelector('.dt-plan')?.innerText.replace(/\\s+/g, ' ').trim() || '', seg: [...t.querySelectorAll('.dt-seg button')].map(b => b.innerText.trim()),
    summary: t.querySelector('.dt-summary')?.innerText.replace(/\\s+/g, ' ').trim() || '', all: t.innerText.replace(/\\s+/g, ' ').trim().slice(0, 2000),
    needs: [...t.querySelectorAll('.dt-need')].map(n => n.innerText.replace(/\\s+/g, ' ').trim()) };
})()`;

/** The Timeline page: the Turbo run's row in the sessions list (since 2026-11-15 its only way in: no side bar entry, not in the
 * Command Palette, task-ccmyi). */
async function home(ui) {
  for (let i = 0; i < 9; i++) {
    await closeTips(ui);
    // the run's row in the sessions list (the window reads the runs every 30 s: it can take that long to come)
    if (!(await ui.exists({ css: '.session-section.dispatch-turbo-row' }))) {
      await ui.sleep(8000);
      continue;
    }
    await ui.click({ css: '.session-section.dispatch-turbo-row .session-section-label' });
    await ui.sleep(1200);
    if (await ui.eval(`!!document.querySelector('.dispatch-timeline-page .dispatch-timeline')`)) return;
  }
  throw new Error('the Timeline page does not open');
}

async function partTurbo(ui, o, dir) {
  await cli(ui, ['turbo', 'config', '--engine', 'opencode', '--model', TURBO_MODEL]);
  const parts = path.join(ui.out, 'parts-one.json');
  fs.writeFileSync(parts, JSON.stringify({ title: 'Footer with the item count', parts: [{ name: 'Footer with the item count', full: 'index.html has a footer that says how many items the list has', files: ['index.html'], minutes: 5 }] }));
  const plan = json((await cli(ui, ['turbo', 'plan', '--cwd', dir, '--parts', parts, '--engine', 'opencode', '--model', TURBO_MODEL, '--json', '--text=Add a footer with the item count'])).out);
  o.run = plan.id || plan.run?.id;
  o.minutes = plan.plan?.minutes ?? plan.minutes;
  await home(ui);
  const p = await until(ui, async () => { const v = await ui.eval(TIMELINE); return v && v.plan && /Start/.test(v.plan) ? v : null; }, 'the one-part plan', 90000, 1500);
  o.plan = p.plan; o.seg = p.seg; o.line = p.line;
  assert.ok(!/\b1 parts\b/.test(p.all), '"1 parts": ' + p.all);
  assert.ok(!p.seg.length && !/At a time/.test(p.plan), 'one part offers parts at a time: ' + p.plan);
  if (typeof o.minutes === 'number') assert.ok(o.minutes < 12, 'forecast ' + o.minutes + ' minutes for a 5-minute part');
  await ui.screenshot('t1-plan');
  await boxes(ui, 't1-plan', [{ n: 1, css: '.dt-plan', what: 'one part: no At a time, minutes not half an hour' }]);
  await ui.click({ text: 'Start', exact: true, within: '.dt-plan' });
  const end = await until(ui, async () => { const v = await ui.eval(TIMELINE); return v && (v.summary || v.needs.length) ? v : null; }, 'the end of the run', 1500000, 5000);
  await ui.sleep(3000);
  const v = await ui.eval(TIMELINE);
  o.end = { line: v.line, summary: v.summary.slice(0, 400), needs: v.needs, title: v.title };
  assert.ok(!end.needs.length, 'the run asked: ' + end.needs.join(' | '));
  assert.ok(!/\b1 parts\b/.test(v.all), '"1 parts" at the end: ' + v.all.slice(0, 400));
  assert.match(v.all, /\b1 part\b/, 'the end says: ' + v.all.slice(0, 400));
  await ui.screenshot('t2-done');
  await boxes(ui, 't2-done', [{ n: 1, css: '.dt-line', what: 'Done · 1 part in …' }]);
  fs.writeFileSync(path.join(ui.out, 'turbo.json'), JSON.stringify(o, null, 2));
}

async function partContinue(ui, o) {
  const folder = path.join(fs.realpathSync(ui.rec.root), 'projects', `continue-b8-${STAMP}`);
  fs.mkdirSync(folder, { recursive: true });
  const words = `SEEDED B8 ${STAMP.toUpperCase()}`;
  // Codex by default (`codex exec`, its home in the instance): the mini's free OpenCode models stalled on 10-07
  const bin = (name) => [path.join(os.homedir(), '.local', 'bin', name), '/opt/homebrew/bin/' + name, '/usr/local/bin/' + name].find(p => fs.existsSync(p)) || name;
  if ((process.env.B8_CONTINUE_AGENT || 'codex') === 'codex') {
    const cenv = { ...process.env, CODEX_HOME: path.join(ui.rec.root, 'codex-home') };
    const out = execFileSync(bin('codex'), ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-C', folder, `Reply with exactly: ${words}`], { env: cenv, encoding: 'utf8', timeout: 300000 });
    assert.ok(out.includes(words), 'codex exec gave no answer: ' + out.slice(0, 300));
  } else {
    const oc = [path.join(os.homedir(), '.opencode', 'bin', 'opencode')].find(p => fs.existsSync(p)) || bin('opencode');
    const env = { ...process.env, PWD: folder, XDG_DATA_HOME: path.join(ui.rec.root, 'xdg-data'), XDG_CONFIG_HOME: path.join(ui.rec.root, 'xdg-config') };
    const seeded = execFileSync(oc, ['run', '--format', 'json', '-m', 'opencode/mimo-v2.6-flash-free', `Reply with exactly: ${words}`], { cwd: folder, env, encoding: 'utf8', timeout: 480000 });
    assert.ok(seeded.includes(words), 'opencode run gave no answer: ' + seeded.slice(0, 300));
  }
  await ui.newSession();
  await ui.sleep(1500);
  await closeTips(ui);
  await ui.openTab('History');
  if (await ui.exists({ text: 'All', exact: true, within: '.dispatch-history-bar' })) await ui.click({ text: 'All', exact: true, within: '.dispatch-history-bar' });
  const rows = () => ui.eval(`[...document.querySelectorAll('.dispatch-history-list .dispatch-history-row')].map(r => (r.querySelector('.dispatch-history-title') || r).innerText.split('\\n')[0].trim())`);
  const search = async () => {
    await ui.click({ css: 'input.dispatch-history-search-input' });
    await ui.eval(`(() => { const i = document.querySelector('input.dispatch-history-search-input'); i.select(); })()`);
    await ui.press('Backspace');
    await ui.type(words, { into: { css: 'input.dispatch-history-search-input' } });
    await ui.sleep(1500);
  };
  await search();
  for (let tries = 0; !(await rows()).length; tries++) {
    if (tries >= 12) throw new Error('the History row did not come');
    await ui.click({ aria: 'Look for new sessions now', webview: false }).catch(() => undefined);
    await ui.sleep(20000);
    await search();
  }
  const title = (await rows())[0];
  await ui.click({ text: title, within: '.dispatch-history-list' });
  await ui.waitFor({ css: '.dispatch-history-row.open .dispatch-history-continue-in', webview: false }, { timeoutMs: 20000 });
  if (!(await ui.eval(`[...document.querySelectorAll('.dispatch-history-row.open .dispatch-history-continue-in .dispatch-tasks-pill')].some(p => p.textContent === 'Chat' && p.classList.contains('on'))`))) {
    await ui.click({ text: 'Chat', exact: true, within: '.dispatch-history-row.open .dispatch-history-continue-in' });
  }
  await ui.click({ text: 'Continue', exact: true, within: '.dispatch-history-row.open' });
  await until(ui, async () => (await ui.eval(`[...document.querySelectorAll('.interactive-session .interactive-item-container')].map(e => e.innerText).join('\\n')`)).includes(words), 'the conversation in the chat', 240000);
  const chip = await until(ui, async () => { const t = await chipText(ui); return /Full auto/.test(t) ? t : null; }, 'Full auto on the continued conversation', 30000).catch(async () => chipText(ui));
  o.chip = chip.slice(0, 300);
  await tag(ui, '/^\\s*(Full auto|Always ask|Ask for risky actions)\\s*$/', 'perm', '.interactive-input-part');
  await ui.screenshot('c1-continued-full-auto');
  await boxes(ui, 'c1-continued-full-auto', [{ n: 1, css: '[data-b8="perm"]', what: 'the continued conversation starts on Full auto' }]);
  assert.match(o.chip, /Full auto/, 'the continued conversation: ' + o.chip);
  assert.ok(!/Always ask/.test(o.chip), 'the continued conversation: ' + o.chip);
  fs.rmSync(folder, { recursive: true, force: true });
}

const META = 8;
const terminalText = ui => ui.eval(`(() => {
  const w = [...document.querySelectorAll('.dispatch-terminal-view .dispatch-xterm')].find(e => e.offsetParent);
  const b = w && w.xterm && w.xterm.buffer.active;
  if (!b) return '';
  const lines = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) lines.push(l.translateToString(true)); }
  return lines.join('\\n').trim();
})()`);

async function partTerminal(ui, o, dir) {
  const agents = await cliJson(ui, ['terminal', 'agents']);
  const claude = (agents.agents || []).find(a => a.id === 'claude');
  o.command = claude ? claude.command.replace(os.homedir(), '~') : '(no Claude Code on this Mac)';
  assert.ok(claude, 'Claude Code is not on this Mac');
  assert.match(claude.command, /--permission-mode bypassPermissions/, 'the terminal command: ' + o.command);
  await newSessionInProject(ui, dir);
  // "Open a Terminal" from the command palette (the same picker as ⌘T and the terminal button)
  for (let attempt = 0; attempt < 3 && !(await ui.exists({ css: '.dispatch-new-picker' })); attempt++) {
    await closeTips(ui);
    await ui.press('F1');
    await ui.sleep(800);
    await ui.type('Open a Terminal');
    await ui.sleep(1200);
    await ui.press('Enter');
    for (let i = 0; i < 20 && !(await ui.exists({ css: '.dispatch-new-picker' })); i++) await ui.sleep(500);
  }
  await ui.waitFor({ text: 'Claude Code', within: '.dispatch-new-picker' }, { timeoutMs: 120000 });
  await ui.click({ text: 'Claude Code', within: '.dispatch-new-picker' });
  // a Mac with Ghostty settings is asked once whether to use its look: not now
  for (let i = 0; i < 10; i++) {
    if (await ui.exists({ css: '.monaco-dialog-box' })) { await ui.press('Escape'); break; }
    await ui.sleep(1000);
  }
  // a folder Claude Code has not seen: its own trust question comes first (No, exit / Yes, I trust this folder)
  const key = async (k, code, vk) => {
    await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk });
    await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  };
  const trust = await until(ui, async () => { const t = await terminalText(ui); return /Yes, I trust this folder|bypass permissions|Bypass Permissions mode/i.test(t) ? t : null; }, "Claude Code's first screen", 90000, 2000).catch(() => '');
  if (/Yes, I trust this folder/.test(trust)) {
    await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' }).catch(() => undefined);
    await key('ArrowDown', 'ArrowDown', 40);
    await ui.sleep(400);
    await key('Enter', 'Enter', 13);
    await ui.sleep(3000);
  }
  // Claude's screen in its bypass mode: its own one-time warning, or the mode line. A Claude Code that has not been
  // asked yet whether its rules file may import the machine-wide rules (outside the folder: ~/.agents/rules/GLOBAL.md,
  // what `dispatch rules sync` writes) asks that once first: the person allows it, as on their own Mac
  let allowed = false;
  const screen = await until(ui, async () => {
    const t = await terminalText(ui);
    if (!allowed && /Allow external CLAUDE\.md file imports/.test(t) && /Yes, allow external imports/.test(t)) {
      allowed = true;
      await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' }).catch(() => undefined);
      await key('ArrowDown', 'ArrowDown', 40);
      await ui.sleep(400);
      await key('Enter', 'Enter', 13);
      return null;
    }
    return /bypass permissions|Bypass Permissions mode|dangerously/i.test(t) ? t : null;
  }, "Claude Code's mode on its screen", 90000, 2000)
    .catch(async () => terminalText(ui));
  o.screen = screen.split('\n').filter(l => l.trim()).slice(-12).join('\n');
  await ui.screenshot('m1-terminal-claude');
  assert.match(screen, /bypass permissions|Bypass Permissions mode/i, 'the terminal Claude: ' + o.screen);
  assert.ok(!/manual mode on/i.test(screen), 'the terminal Claude is in manual mode');
  // leave Claude without starting anything: Ctrl+C twice
  for (let i = 0; i < 2; i++) {
    await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
    await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
    await ui.sleep(600);
  }
}

const RUN = { cli: partCli, question: partQuestion, links: partLinks, browser: partBrowser, settle: partSettle, switch: partSwitch, turbo: partTurbo, continue: partContinue, terminal: partTerminal };

export default async function (ui) {
  const results = {};
  fs.mkdirSync(E2E_ROOT, { recursive: true });
  try {
    await ui.attach('agents', 90000).catch(() => ui.openAgents(ui.demoFolder));
    await ui.closeOverlays?.().catch(() => undefined);
    await ui.sleep(4000);
    await closeTips(ui);
    const dir = makeProject('todo-b8');
    await addProject(ui, dir, 'todo-b8');
    for (const p of PARTS) {
      const o = (results[p] = {});
      const t0 = Date.now();
      try {
        await RUN[p](ui, o, dir);
        o.ok = true;
      } catch (e) {
        o.ok = false;
        o.error = String(e?.stack || e).slice(0, 1500);
        await ui.screenshot(`x-${p}-failed`).catch(() => undefined);
        await ui.press('Escape').catch(() => undefined);
      }
      o.seconds = Math.round((Date.now() - t0) / 1000);
      fs.writeFileSync(path.join(ui.out, 'results.json'), JSON.stringify(results, null, 2));
    }
  } finally {
    fs.writeFileSync(path.join(ui.out, 'results.json'), JSON.stringify(results, null, 2));
    fs.rmSync(E2E_ROOT, { recursive: true, force: true });
  }
  const failed = Object.entries(results).filter(([, o]) => !o.ok).map(([p, o]) => `${p}: ${o.error.split('\n')[0]}`);
  if (failed.length) throw new Error('parts failed: ' + failed.join(' | '));
  return results;
}
