// Notes on a diff go back to the agent, with Codex (task-ttsd; diffnotes.mjs is the same with OpenCode): a Codex session writes greet.py; in Changes you
// select a line of its diff, write a note, add a second note on another line, and press Submit Feedback;
// the agent's next turn gets both notes with their file and lines and acts on them.
// Codex runs on this Mac's ChatGPT login (the instance links it); the smallest model its menu offers.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
export const meta = { needs: ['codex'], title: 'Notes on a diff go back to Codex', description: 'Select lines in Changes, write notes, Submit Feedback: the agent acts on them.', timeout: 1200 };

const fresh = '.sessions-chat-editor';
const FILE = 'greet.py';
// one line: the message box keeps a line's indent on the next line, so a typed code block would arrive indented
const PROMPT = `Create the file ${FILE} with your file edit tool: a top-level function greet(name) whose body is return "Hello " + name, a blank line, then a top-level function bye(name) whose body is return "Bye " + name, four spaces of indent, nothing else. Then reply DONE.`;
const NOTE1 = 'Say "Hi, " instead of "Hello " here.';
const NOTE2 = 'Rename this function to farewell.';

async function until(ui, fn, what, ms = 120000) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await ui.sleep(1000);
  }
  throw new Error(`Timed out: ${what}`);
}

async function offScreen(ui) {
  try {
    const { windowId } = await ui.cdp.send('Browser.getWindowForTarget', {});
    await ui.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -3000, top: -3000 } });
  } catch { /* not every target answers: the run still works */ }
}

/** greet.py where the session works: the demo folder, or the session's own worktree. */
function sessionFile(ui) {
  const out = execFileSync('git', ['-C', ui.demoFolder, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  for (const root of out.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9))) {
    const p = `${root}/${FILE}`;
    if (existsSync(p) && readFileSync(p, 'utf8').includes('def bye')) return p;
  }
  return '';
}

const lastResponse = `(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return r ? r.innerText : ''; })()`;
const turnDone = (re) => `(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return !!r && !r.classList.contains('chat-response-loading') && ${re}.test(r.innerText); })()`;

async function approveAndWait(ui, check, what, ms) {
  return until(ui, async () => {
    const ask = await ui.eval(`[...document.querySelectorAll('.interactive-session button, .chat-confirmation-widget button')].map(b => b.innerText.trim()).find(t => /^(Allow|Allow once|Approve|Continue|Yes)$/i.test(t)) || ''`);
    if (ask) await ui.click({ text: ask, exact: true });
    const t = await ui.eval(lastResponse);
    if (/401|unauthori[sz]ed|quota|insufficient balance/i.test(t)) throw new Error(`The test model failed: ${t.slice(0, 200)}`);
    return check();
  }, what, ms);
}

/** Drag across one line of the diff's modified side, the way a person selects it. */
async function selectLine(ui, text) {
  const box = await ui.eval(`(() => {
    const ed = [...document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line')].find(l => l.textContent.replace(/\u00a0/g, ' ').includes(${JSON.stringify(text)}));
    if (!ed) return null;
    const span = ed.querySelector('span > span:last-child') || ed;
    const first = ed.querySelector('span > span');
    const a = first.getBoundingClientRect(), b = span.getBoundingClientRect();
    return { x1: a.left + 1, x2: b.right - 1, y: a.top + a.height / 2 };
  })()`);
  if (!box) throw new Error(`No line with ${text} in the diff`);
  await ui.mouse('mouseMoved', box.x1, box.y);
  await ui.mouse('mousePressed', box.x1, box.y, { clickCount: 1 });
  for (let i = 1; i <= 6; i++) await ui.mouse('mouseMoved', box.x1 + (box.x2 - box.x1) * i / 6, box.y, { buttons: 1 });
  await ui.mouse('mouseReleased', box.x2, box.y, { clickCount: 1 });
  await ui.sleep(600);
}

async function addNote(ui, line, note) {
  await selectLine(ui, line);
  await ui.waitFor({ css: '.agent-feedback-input-widget textarea' }, { timeoutMs: 15000 });
  await ui.click({ css: '.agent-feedback-input-widget textarea' });
  await ui.type(note);
  await ui.press('Enter', { send: true });
  await ui.sleep(1200);
}

/** The pointer goes to an empty part of the window before a picture, as a hand rests off the buttons. */
async function restPointer(ui) {
  await ui.mouse('mouseMoved', 1300, 640);
  await ui.sleep(800);
}

/** First-run tips can sit over what the person looks at: close them, as a person would. */
async function closeTips(ui) {
  for (let i = 0; i < 5 && (await ui.exists({ css: 'button.dispatch-tour-close' })); i++) {
    await ui.click({ css: 'button.dispatch-tour-close' });
    await ui.sleep(600);
  }
}

/** A new session in the demo project, the way a person starts one there: Projects, the project, the
 *  project page's New Session (top right; the sidebar's New starts in the Assistant's own folder). */
async function newSessionInProject(ui, folder) {
  const name = folder.split('/').filter(Boolean).at(-1);
  await closeTips(ui);
  // the list fills in once Dispatch has read the sessions (slower on a busy Mac): open it again if it is late
  for (let attempt = 0; ; attempt++) {
    await ui.click('Projects');
    try { await ui.waitFor({ css: '.dispatch-projects-toolbar' }, { timeoutMs: 20000 }); await ui.click({ text: 'All', exact: true, within: '.dispatch-projects-toolbar' }); } catch { /* no filter bar */ }
    try { await ui.waitFor({ text: name, exact: true, within: '.dispatch-projects-page' }, { timeoutMs: 45000 }); break; } catch (e) { if (attempt >= 3) throw e; }
  }
  // the project page's buttons (top right): Add as Project when Dispatch does not know the folder yet, then New Session
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
  // open the project (a first-run tip can appear over the list at any moment: close it and try again)
  let first = null;
  for (let attempt = 0; attempt < 4 && !first; attempt++) {
    await closeTips(ui);
    try { await ui.click({ text: name, exact: true, within: '.dispatch-projects-page' }); } catch { /* the project page is open already */ }
    first = await until(ui, async () => (await pageButton('New Session')) || (await pageButton('Add as Project')) ? true : null, 'the project page buttons', 15000).catch(() => null);
  }
  if (!first) throw new Error('The project page did not open');
  if (first && !(await pageButton('New Session'))) {
    await press(await pageButton('Add as Project'));
  }
  await press(await until(ui, async () => pageButton('New Session'), "the project page's New Session", 60000));
  await until(ui, async () => ui.eval(`(document.querySelector('.part.titlebar')?.innerText || '').includes(${JSON.stringify(name)}) && !!document.querySelector('.sessions-chat-session-type-picker')`), `a new session in ${name}`, 60000);
}

/** Click into the message box until it has the keyboard focus (right after the engine changes it can
 *  still be settling). */
async function focusInput(ui) {
  for (let i = 0; i < 8; i++) {
    await ui.click({ css: i % 2 ? `${fresh} .view-lines` : fresh });
    await ui.sleep(400);
    if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('${fresh}')`)) return;
    await ui.sleep(800);
  }
  throw new Error('The message box does not take the focus');
}

let seenModels = '';

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  await offScreen(ui);
  await newSessionInProject(ui, ui.demoFolder);
  await ui.pickEngine('Codex', 180000);
  // the smallest model Codex offers, when its menu lists one (Codex's own default otherwise)
  await focusInput(ui);
  await ui.type('/model');
  const small = await until(ui, async () => {
    const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => ({name:r.querySelector('.dsm-name')?.textContent}))`);
    seenModels = rows.map(r => r.name).join(', ');
    return rows.length ? (rows.find(r => /mini|nano|spark/i.test(r.name || '')) || { name: '' }) : null;
  }, 'the model menu', 30000).catch(() => ({ name: '' }));
  const typed = async () => ui.eval(`document.querySelector('${fresh} .view-lines')?.textContent || ''`);
  if (small.name) {
    for (let i = 0; i < 40 && (await typed()).trim(); i++) await ui.press('Backspace');
    await ui.type(`/${small.name.replace(/\s+/g, '')}`);
    await until(ui, async () => ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row .dsm-name')].some(n => n.textContent === ${JSON.stringify(small.name)})`), `the menu row ${small.name}`, 20000);
    await ui.click({ text: small.name, exact: true, within: '.dispatch-slash-menu' });
  }
  await ui.press('Escape');
  for (let i = 0; i < 40 && (await typed()).trim(); i++) await ui.press('Backspace');
  await focusInput(ui);
  await ui.type(PROMPT);
  await ui.press('Enter', { send: true });

  const file = await approveAndWait(ui, async () => sessionFile(ui), `the agent writing ${FILE}`, 240000);
  await until(ui, async () => ui.eval(turnDone('/DONE/')), 'the turn to end', 180000);
  const turns = await ui.eval(`document.querySelectorAll('.interactive-request').length`);

  await ui.openTab('Changes');
  // the change list fills in a moment after the tab opens
  await ui.waitFor({ text: FILE, exact: true, within: '.changes-file-list', webview: false }, { timeoutMs: 60000 });
  await ui.click({ text: FILE, exact: true, within: '.changes-file-list', webview: false });
  await ui.waitFor({ css: '.monaco-diff-editor .editor.modified .view-line' }, { timeoutMs: 30000 });
  await ui.sleep(1500);
  await closeTips(ui);

  await addNote(ui, 'return "Hello', NOTE1);
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot('01-first-note');
  await ui.mark({ css: '.agent-feedback-widget-item' }, { what: '你写的批注，挂在选中的那一行下面', where: '右栏 Changes 的 diff 里', how: '在 diff 里拖选一行，写字，回车' });
  await addNote(ui, 'def bye', NOTE2);
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot('02-two-notes');
  const notes = await ui.eval(`document.querySelectorAll('.agent-feedback-widget-item').length`);

  const submit = await until(ui, async () => ui.eval(`[...document.querySelectorAll('a, button, .action-label, .monaco-button')].map(b => (b.getAttribute('aria-label') || b.textContent || '').trim()).find(t => /^Submit Feedback/.test(t)) || ''`), 'the Submit Feedback button', 20000);
  // the button reads "Submit 2"; its accessible name says the whole thing ("Submit Feedback (2)")
  await ui.mark({ aria: submit, exact: true }, { what: '把批注一起发给 Agent', where: '右栏 diff 底部的批注条', how: '写了批注以后点「Submit」' });
  await ui.click({ aria: submit, exact: true });
  await until(ui, async () => (await ui.eval(`document.querySelectorAll('.interactive-request').length`)) > turns, 'the feedback turn to start', 30000);
  const sent = await ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-request')].at(-1); return r ? r.innerText : ''; })()`);
  await closeTips(ui);
  await ui.screenshot('03-sent');

  const after = await approveAndWait(ui, async () => {
    const done = await ui.eval(`(() => { const all = document.querySelectorAll('.interactive-response'); const r = [...all].at(-1); return all.length > ${turns} && !!r && !r.classList.contains('chat-response-loading'); })()`);
    if (!done) return '';
    const t = readFileSync(file, 'utf8');
    return /Hi, /.test(t) && /^def farewell\(name\):/m.test(t) ? t : (done ? `unchanged:${t}` : '');
  }, 'the agent acting on the notes', 240000);
  const reply = await ui.eval(lastResponse);
  await closeTips(ui);
  await ui.screenshot('04-acted');
  const left = await ui.eval(`document.querySelectorAll('.agent-feedback-widget-item').length`);
  const result = { engine: 'Codex', model: small.name || 'default', models: seenModels, file, turns, notes, submit, sent, reply: reply.slice(0, 1500), after, left };
  writeFileSync(`${ui.out}/result.json`, JSON.stringify(result, null, 2));
  if (after.startsWith('unchanged:')) throw new Error(`The agent did not act on the notes: ${JSON.stringify(result).slice(0, 1500)}`);
}
