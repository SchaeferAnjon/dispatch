// Who wrote which line (task-6qpx, task-m6hek): an OpenCode session appends four lines to NOTES.md; then a script,
// with no agent's turn open, writes a hook script of its own and appends a line to NOTES.md; then the person changes
// one of the agent's lines and adds one of their own by typing in the Changes diff and pressing ⌘S. The record knows
// whose lines are whose: the agent's next turn hears about the person's two lines only, nothing of the script's.
// Changes itself marks nobody's lines (VS Code's as it is, the user 2026-11-16, task-rinkm): no person blocks, no
// dashed blocks, no grey line above the diff, the A / M / D letters as VS Code draws them. Test model: OpenCode
// DeepSeek Flash (GLM Flash, else OpenCode's free MiMo Flash).
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
export const meta = { needs: ['opencode'], title: 'Who wrote which line', description: 'The agent writes four lines, a script writes a file and a line, you type two in the editor; Changes marks nobody\'s lines (VS Code\'s as it is); the next turn hears about yours only.', timeout: 1500 };

const fresh = '.sessions-chat-editor';
const AGENT_LINES = ['- Alpha: written by the agent', '- Beta: written by the agent', '- Gamma: written by the agent', '- Delta: written by the agent'];
const PROMPT = `Append exactly these four lines to the end of NOTES.md, keep everything else as it is, use your file edit tool, then reply DONE:\n${AGENT_LINES.join('\n')}`;

async function until(ui, fn, what, ms = 120000) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await ui.sleep(1000);
  }
  throw new Error(`Timed out: ${what}`);
}

/** The window goes off screen (the person's desktop stays theirs); clicks and screenshots still work. */
async function offScreen(ui) {
  try {
    const { windowId } = await ui.cdp.send('Browser.getWindowForTarget', {});
    await ui.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -3000, top: -3000 } });
  } catch { /* not every target answers: the run still works */ }
}

/** NOTES.md where the session works: the demo folder, or the session's own worktree. */
function notesFile(ui) {
  const out = execFileSync('git', ['-C', ui.demoFolder, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  const roots = out.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));
  for (const root of roots) {
    const p = `${root}/NOTES.md`;
    if (existsSync(p) && readFileSync(p, 'utf8').includes('Delta: written by the agent')) return p;
  }
  return '';
}

/** Every log line under `dir` (the instance's profile folders) that mentions attribution. */
function logLines(dir, out = [], depth = 0) {
  if (!dir || depth > 8 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) logLines(p, out, depth + 1);
    else if (name.endsWith('.log') && st.size < 50_000_000) {
      for (const line of readFileSync(p, 'utf8').split('\n')) if (/ttribution/.test(line)) out.push(`${p.slice(dir.length)}: ${line.slice(0, 600)}`);
    }
  }
  return out;
}

/** What the record holds when the run ends (also when it fails): the window's turn marks as it logged
 *  them, the marks the CLI kept, and its answer for NOTES.md in every checkout of the demo project. */
function diagnose(ui) {
  const rec = ui.rec || {};
  const d = { logs: [], marks: {}, show: {}, worktrees: '' };
  try { d.logs = logLines(rec.root).slice(-400); } catch (e) { d.logs = [String(e)]; }
  try {
    const base = join(rec.dispatch_dir || '', 'attribution');
    for (const name of existsSync(base) ? readdirSync(base) : []) {
      const f = join(base, name, 'marks.jsonl');
      if (!existsSync(f)) continue;
      d.marks[name] = readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => {
        try { const m = JSON.parse(l); return { ts: m.ts, event: m.event, session: m.session, source: m.source, turn: m.turn, head: (m.head || '').slice(0, 10), files: Object.keys(m.files || {}) }; } catch { return l; }
      });
    }
  } catch (e) { d.marks = String(e); }
  try {
    d.worktrees = execFileSync('git', ['-C', ui.demoFolder, 'worktree', 'list'], { encoding: 'utf8' });
    for (const line of d.worktrees.split('\n').filter(Boolean)) {
      const p = join(line.split(/\s+/)[0], 'NOTES.md');
      if (!existsSync(p)) continue;
      try { d.show[p] = JSON.parse(execFileSync(join(rec.bin_dir, 'dispatch'), ['attribution', 'show', p, '--json'], { encoding: 'utf8', timeout: 30000 })); } catch (e) { d.show[p] = String(e).slice(0, 400); }
    }
  } catch (e) { d.worktrees = String(e); }
  writeFileSync(`${ui.out}/diagnose.json`, JSON.stringify(d, null, 2));
}

/** Anything Changes used to add about who wrote a line: marks in the diffs, the grey line, the person on a file row. */
const ADDED = `({ marks: document.querySelectorAll('.monaco-editor .dispatch-attr-mark').length, hint: document.querySelectorAll('.dispatch-attr-hint').length,
  grey: /Lines without a mark/.test(document.querySelector('.session-changes-editor')?.innerText || ''),
  rowChips: document.querySelectorAll('.changes-file-list .dispatch-attr-chip, .changes-file-list .dispatch-attr-row').length,
  letters: [...document.querySelectorAll('.changes-file-list .changes-decoration-badge')].map(e => ({ text: e.textContent, display: getComputedStyle(e).display })) })`;
const none = (a) => !a.marks && !a.hint && !a.grey && !a.rowChips;

/** The pointer goes to an empty part of the window before a picture, as a hand rests off the buttons
 *  (a tooltip left under it would cover the diff's header). */
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
  try {
    await run(ui);
  } finally {
    diagnose(ui);
  }
}

/** The editor's screen reader mode off (an instance can switch it on by itself): with it on, a narrow diff stays side by
 *  side and wraps a line of NOTES.md over several rows, and the line a person clicks is not one row any more. */
export function screenReaderOff(ui) {
  for (const dir of [ui.rec.user_data_dir, ui.rec.agents_user_data_dir].filter(Boolean)) {
    const f = join(dir, 'User', 'settings.json');
    let j = {};
    try { j = JSON.parse(readFileSync(f, 'utf8')); } catch { j = {}; }
    j['editor.accessibilitySupport'] = 'off';
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(j, null, 1));
  }
}

async function run(ui) {
  screenReaderOff(ui);
  await ui.openAgents(ui.demoFolder);
  await offScreen(ui);
  await newSessionInProject(ui, ui.demoFolder);
  await ui.pickEngine('OpenCode', 360000); // a busy Mac lists OpenCode's models slowly
  await focusInput(ui);
  await ui.type('/model');
  await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 30000 });
  const row = await until(ui, async () => {
    const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => ({name:r.querySelector('.dsm-name')?.textContent, desc:r.querySelector('.dsm-desc')?.textContent}))`);
    seenModels = rows.map(r => r.name).join(', ');
    // the cheap test models: DeepSeek Flash or GLM Flash with the person's keys; a Mac without them (the
    // build Mac) has OpenCode's free MiMo Flash, which writes files as asked
    return ui.cheapModel(rows);
  }, 'a test model (DeepSeek Flash, GLM Flash or a free Flash)', 45000).catch(e => { throw new Error(`${e.message}; the menu had: ${seenModels}`); });
  // narrow the list to that model (a long provider list scrolls), then pick it
  const typed = async () => ui.eval(`document.querySelector('${fresh} .view-lines')?.textContent || ''`);
  for (let i = 0; i < 40 && (await typed()).trim(); i++) await ui.press('Backspace');
  await ui.type(`/${row.name.replace(/\s+/g, '')}`);
  await until(ui, async () => ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row .dsm-name')].some(n => n.textContent === ${JSON.stringify(row.name)})`), `the menu row ${row.name}`, 20000);
  await ui.click({ text: row.name, exact: true, within: '.dispatch-slash-menu' });
  await ui.press('Escape');
  await focusInput(ui);
  await ui.type(PROMPT);
  await ui.press('Enter', { send: true });

  // the agent works; approve its edit when it asks
  const file = await until(ui, async () => {
    const ask = await ui.eval(`[...document.querySelectorAll('.interactive-session button, .chat-confirmation-widget button')].map(b => b.innerText.trim()).find(t => /^(Allow|Allow once|Approve|Continue|Yes)$/i.test(t)) || ''`);
    if (ask) await ui.click({ text: ask, exact: true });
    const t = await ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return r ? r.innerText : ''; })()`);
    if (/401|unauthori[sz]ed|quota|insufficient balance/i.test(t)) throw new Error(`The test model failed: ${t.slice(0, 200)}`);
    return notesFile(ui);
  }, 'the agent writing NOTES.md', 240000);
  await until(ui, async () => ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return !!r && !r.classList.contains('chat-response-loading') && /DONE/.test(r.innerText); })()`), 'the turn to end', 180000);
  await ui.sleep(4000); // the window records the end of the turn

  await ui.openTab('Changes');
  // the change list fills in a moment after the tab opens
  await ui.waitFor({ text: 'NOTES.md', exact: true, within: '.changes-file-list', webview: false }, { timeoutMs: 60000 });
  await ui.click({ text: 'NOTES.md', exact: true, within: '.changes-file-list', webview: false });
  await ui.waitFor({ css: '.monaco-diff-editor .editor.modified' }, { timeoutMs: 60000 });
  await ui.sleep(3000); // the marks used to come a moment after the diff: give them the time to (not) come
  await closeTips(ui);
  const before = await ui.eval(ADDED);
  await restPointer(ui);
  await ui.screenshot('01-agent-only');

  // something with no agent's turn open (bd writing its hook scripts, a code generator): a file of its own and a line
  // at the end of NOTES.md. Past the turn's end and its grace (a write within 6 s of it is the agent finishing up).
  await ui.sleep(8000);
  const root = dirname(file);
  const script = join(root, 'tools', 'post-commit');
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, '#!/bin/sh\n# written by a tool, not by you\nexec true\n');
  appendFileSync(file, '- Zeta: appended by a script\n');
  await ui.sleep(3000);

  // you: change the agent's Beta line and add a line of your own, typed in the Changes diff and saved with ⌘S
  await editInEditor(ui, file, { after: 'Beta: written by the agent', add: ', then edited by you', append: '- Epsilon: a line you added' });
  await until(ui, async () => readEdits(ui).some(e => e.event === 'save' && e.path === 'NOTES.md'), 'your save in the record', 30000);
  // Branch Changes lists only the session's own changes (task-0nr72): the script's file is not there, NOTES.md is
  await ui.sleep(5000);
  const after = await ui.eval(ADDED);
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot('02-your-lines-unmarked');

  // what the agent's next turn hears: your two lines, nothing of the script's (the plugin passes it on at the start)
  const turn1End = lastEnd(ui);
  const note = cli(ui, ['attribution', 'note', '--agent', 'opencode', '--session', turn1End.session.split(':').slice(1).join(':'), '--cwd', root, '--json']);
  await send(ui, 'Reply with just the word READY. Do not change any file.');
  await until(ui, async () => {
    const ask = await ui.eval(`[...document.querySelectorAll('.interactive-session button, .chat-confirmation-widget button')].map(b => b.innerText.trim()).find(t => /^(Allow|Allow once|Approve|Continue|Yes)$/i.test(t)) || ''`);
    if (ask) await ui.click({ text: ask, exact: true });
    return ui.eval(`(() => { const last = [...document.querySelectorAll('.interactive-response')].at(-1); return !!last && !last.classList.contains('chat-response-loading') && /READY/.test(last.innerText); })()`);
  }, 'the second turn to end', 240000);
  await until(ui, async () => (marksOf(ui).filter(m => m.event === 'start' && m.ts > turn1End.ts).length ? true : null), 'the second turn\'s start in the record', 60000);

  const edits = readEdits(ui);
  const result = { file, before, after, note, edits };
  writeFileSync(`${ui.out}/result.json`, JSON.stringify(result, null, 2));
  for (const [when, a] of [['after the agent\'s turn', before], ['after your edit', after]]) {
    if (!none(a)) throw new Error(`Changes marks who wrote a line ${when}: ${JSON.stringify(a)}`);
    if (a.letters.some(l => l.display === 'none' || !/^[AMD]$/.test(l.text))) throw new Error(`The A / M / D letters are not VS Code's ${when}: ${JSON.stringify(a.letters)}`);
  }
  if (!edits.some(e => e.event === 'save' && e.path === 'NOTES.md' && e.base && e.sha)) throw new Error(`The editor recorded no save of NOTES.md: ${JSON.stringify(edits)}`);
  if (!note.files || note.files.length !== 1 || note.files[0].path !== 'NOTES.md' || note.files[0].count !== 2) throw new Error(`The next turn would hear about more than your two lines: ${JSON.stringify(note)}`);
  if (/post-commit|Zeta/.test(note.text)) throw new Error(`The note names the script's changes: ${note.text}`);
}

/** The editor's record of your typing (attribution edits.jsonl), every project. */
function readEdits(ui) {
  const out = [];
  const base = join(ui.rec.dispatch_dir || '', 'attribution');
  for (const name of existsSync(base) ? readdirSync(base) : []) {
    const f = join(base, name, 'edits.jsonl');
    if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) { try { out.push(JSON.parse(l)); } catch { /* a torn line */ } }
  }
  return out;
}

/** Every mark of every project, oldest first. */
function marksOf(ui) {
  const out = [];
  const base = join(ui.rec.dispatch_dir || '', 'attribution');
  for (const name of existsSync(base) ? readdirSync(base) : []) {
    const f = join(base, name, 'marks.jsonl');
    if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) { try { out.push(JSON.parse(l)); } catch { /* a torn line */ } }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** The last end mark under the agent's own id (the plugin's), else any. */
function lastEnd(ui) {
  const ends = marksOf(ui).filter(m => m.event === 'end');
  return ends.filter(m => /^opencode:ses_/.test(m.session)).at(-1) || ends.at(-1);
}

function cli(ui, args, timeout = 60000) {
  const out = execFileSync(join(ui.rec.bin_dir, 'dispatch'), args, { encoding: 'utf8', timeout });
  return JSON.parse(out.slice(out.indexOf('{')));
}

/** The message box of a session that is going: click into it until it has the keyboard focus, type, send. */
async function send(ui, text) {
  await closeTips(ui);
  const box = '.interactive-input-part .monaco-editor';
  for (let i = 0; ; i++) {
    await ui.click({ css: box, webview: false });
    await ui.sleep(400);
    if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('.interactive-input-part')`)) break;
    if (i >= 8) throw new Error('The message box does not take the focus');
    await ui.sleep(800);
  }
  await ui.type(text);
  await ui.press('Enter', { send: true });
}

/** A key the editor gets (the runner's press() keeps away from open files; this is the demo project's file in a
 *  throwaway instance, and typing into it is what the scenario is about). */
async function editorKey(ui, key, code, keyCode, modifiers = 0, text = undefined) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, ...(modifiers ? { modifiers } : {}) };
  await ui.cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) });
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await ui.sleep(250);
}

/**
 * You change a file the way a person does in the Agents window: open it from Changes, click into the diff's own side
 * and type, then ⌘S. `after`: the text of a line to add `add` at its end; `append`: a new line after the last one.
 * Resolves once the saved file on disk has the change.
 */
export async function editInEditor(ui, file, { after, add, append }) {
  const name = basename(file);
  await ui.openTab('Changes');
  await closeTips(ui);
  await ui.waitFor({ text: name, exact: true, within: '.changes-file-list', webview: false }, { timeoutMs: 60000 });
  await ui.click({ text: name, exact: true, within: '.changes-file-list', webview: false });
  const modified = '.monaco-diff-editor .editor.modified';
  const where = (text) => ui.eval(`(() => {
    const ed = [...document.querySelectorAll('${modified}')].find(e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0);
    if (!ed) return null;
    const lines = [...ed.querySelectorAll('.view-line')].map(l => ({ l, t: l.textContent.replace(/\\u00a0/g, ' '), top: l.getBoundingClientRect().top })).filter(x => x.t.trim()).sort((a, b) => a.top - b.top);
    const hit = ${text === null ? 'lines.at(-1)' : `lines.find(x => x.t.includes(${JSON.stringify(text)}))`};
    if (!hit) return null;
    const spans = hit.l.querySelectorAll('span > span');
    const r = (spans[spans.length - 1] || hit.l).getBoundingClientRect();
    return { x: Math.round(r.right - 2), y: Math.round(r.top + r.height / 2), text: hit.t };
  })()`);
  const clickAt = async (p) => {
    await ui.mouse('mouseMoved', p.x, p.y);
    await ui.mouse('mousePressed', p.x, p.y, { clickCount: 1 });
    await ui.mouse('mouseReleased', p.x, p.y, { clickCount: 1 });
    await ui.sleep(400);
  };
  const before = readFileSync(file, 'utf8');
  if (after) {
    await clickAt(await until(ui, () => where(after), `the line "${after}" in the diff of ${name}`, 60000));
    await ui.press('End');
    await ui.cdp.send('Input.insertText', { text: add });
    await ui.sleep(500);
  }
  if (append) {
    await clickAt(await until(ui, () => where(null), `the last line in the diff of ${name}`, 30000));
    await ui.press('End');
    await editorKey(ui, 'Enter', 'Enter', 13, 0, '\r');
    await ui.cdp.send('Input.insertText', { text: append });
    await ui.sleep(500);
  }
  await ui.sleep(800);
  await editorKey(ui, 's', 'KeyS', 83, 4); // ⌘S
  const want = [after && add, append].filter(Boolean);
  return until(ui, async () => { const t = readFileSync(file, 'utf8'); return t !== before && want.every(w => t.includes(w)) ? t : null; }, `${name} saved with your change`, 30000);
}
