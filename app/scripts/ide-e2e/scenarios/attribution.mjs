// Who wrote which line (task-6qpx, task-m6hek): an OpenCode session appends four lines to NOTES.md; then a script,
// with no agent's turn open, writes a hook script of its own and appends a line to NOTES.md; then the person changes
// one of the agent's lines and adds one of their own by typing in the Changes diff and pressing ⌘S. Changes marks the
// person's lines with the person, the script's with a dashed block that says "Not from an agent in Dispatch", the
// agent's not at all; the agent's next turn hears about the person's two lines only. Test model: OpenCode DeepSeek
// Flash (GLM Flash, else OpenCode's free MiMo Flash).
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
export const meta = { needs: ['opencode'], title: 'Who wrote which line', description: 'The agent writes four lines, a script writes a file and a line, you type two in the editor; Changes marks yours with the person, the script\'s as not from an agent, the agent\'s not at all; the next turn hears about yours only.', timeout: 1500 };

const fresh = '.sessions-chat-editor';
const AGENT_LINES = ['- Alpha: written by the agent', '- Beta: written by the agent', '- Gamma: written by the agent', '- Delta: written by the agent'];
const PROMPT = `Append exactly these four lines to the end of NOTES.md, keep everything else as it is, use your file edit tool, then reply DONE:\n${AGENT_LINES.join('\n')}`;

/** Hover a mark until its hover says `re` (the editor's hover can miss the first pointer move). */
async function hoverText(ui, css, re) {
  const log = [];
  for (let i = 0; i < 5; i++) {
    await ui.hover({ css: '.monaco-editor .view-lines' });
    await ui.sleep(300);
    await ui.hover({ css });
    // the editor shows a glyph's hover once the pointer rests on it; its text has non-breaking spaces
    for (let j = 0; j < 16; j++) {
      await ui.sleep(500);
      const seen = await ui.eval(`[...document.querySelectorAll('.monaco-hover')].map(h => ({ w: Math.round(h.getBoundingClientRect().width), cls: String(h.className), text: (h.innerText || '').replace(/\\u00a0/g, ' ').slice(0, 120) }))`);
      log.push({ i, j, seen });
      const hit = (seen || []).find(h => h.w > 0 && new RegExp(re.slice(1, -1)).test(h.text));
      if (hit) {
        const full = await ui.eval(`[...document.querySelectorAll('.monaco-hover')].map(h => (h.innerText || '').replace(/\\u00a0/g, ' ')).find(x => ${re}.test(x)) || ''`);
        return full || hit.text;
      }
    }
  }
  writeFileSync(`${ui.out}/hover-log.json`, JSON.stringify(log, null, 1));
  const seen = await ui.eval(`(() => {
    const m = document.querySelector('${css}'); if (!m) return { mark: 'none' };
    const r = m.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const chain = []; for (let e = at; e && chain.length < 6; e = e.parentElement) chain.push(e.tagName + '.' + String(e.className).split(' ').slice(0, 3).join('.'));
    const hovers = [...document.querySelectorAll('[class*="hover"]')].filter(h => h.getBoundingClientRect().width > 0).map(h => String(h.className).slice(0, 60) + ': ' + (h.innerText || '').slice(0, 80));
    return { chain, hovers: hovers.slice(0, 8) };
  })()`);
  throw new Error(`No hover matching ${re} on ${css}: ${JSON.stringify(seen)}`);
}

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

const marks = (cls) => `document.querySelectorAll('.monaco-editor .dispatch-attr-mark.dispatch-attr-${cls}').length`;
/** The marks in one file's diff (Changes shows every changed file's diff at once): the one whose text has `needle`. */
const marksIn = (cls, needle) => `(() => {
  const d = [...document.querySelectorAll('.monaco-diff-editor')].find(d => (d.querySelector('.editor.modified')?.textContent || '').replace(/\\u00a0/g, ' ').includes(${JSON.stringify(needle)}));
  return d ? d.querySelectorAll('.dispatch-attr-mark.dispatch-attr-${cls}').length : 0;
})()`;
const NOTES = 'Alpha: written by the agent';
const TOOL = 'written by a tool';

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

async function run(ui) {
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
  await ui.waitFor({ css: '.dispatch-attr-hint' }, { timeoutMs: 60000 });
  await closeTips(ui);
  const before = await ui.eval(`({ you: ${marks('you')}, mix: ${marks('mix')}, unsure: ${marks('unsure')}, hint: document.querySelector('.dispatch-attr-hint')?.textContent || '', rowChips: [...document.querySelectorAll('.dispatch-attr-row')].filter(e => !e.hidden).length })`);
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot('01-agent-only');
  await ui.mark({ css: '.dispatch-attr-hint' }, { what: '灰字：没标记的行是 Agent 写的', where: '右栏 Changes 里 diff 的上方', how: '会话改完文件后打开 Changes，点文件' });

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
  let reopened = 0;
  let lastOpen = Date.now();
  await until(ui, async () => {
    // (the script's line is checked below: a build before task-m6hek marks it with the person, which the pictures show)
    if ((await ui.eval(marksIn('you', NOTES))) >= 1 && (await ui.eval(marksIn('mix', NOTES))) >= 1 && (await ui.eval(`${marksIn('you', NOTES)} + ${marksIn('other', NOTES)}`)) >= 2) return true;
    // the diff can close while the change list refreshes (or a tip took a click): open the file again, as a person would
    const shown = await ui.eval(`[...document.querySelectorAll('.monaco-diff-editor .editor.modified')].some(e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0)`);
    if (!shown || Date.now() - lastOpen > 15000) {
      lastOpen = Date.now();
      reopened++;
      await closeTips(ui);
      await ui.click({ text: 'NOTES.md', exact: true, within: '.changes-file-list', webview: false });
    }
    return false;
  }, 'the marks on your two lines and the script\'s line', 90000);
  // the file row asks for its counts again once your save is in the record (a busy Mac answers in a few seconds)
  await until(ui, async () => ui.eval(`[...document.querySelectorAll('.dispatch-attr-row')].some(e => !e.hidden && /You changed 2 lines/.test(e.getAttribute('aria-label') || ''))`), 'the person mark on the file row', 30000).catch(() => null);
  await ui.sleep(1500);
  const counts = `({ you: ${marksIn('you', NOTES)}, mix: ${marksIn('mix', NOTES)}, unsure: ${marksIn('unsure', NOTES)}, other: ${marksIn('other', NOTES)}, hint: document.querySelector('.dispatch-attr-hint')?.textContent || '',
    rows: [...document.querySelectorAll('.changes-file-list .monaco-list-row')].map(r => ({ name: (r.innerText || '').split('\\n')[0].trim(), chip: [...r.querySelectorAll('.dispatch-attr-row')].filter(e => !e.hidden).map(e => e.getAttribute('aria-label')) })),
    letters: [...document.querySelectorAll('.changes-decoration-badge')].map(e => getComputedStyle(e).display) })`;
  const after = await ui.eval(counts);
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot('02-three-kinds');
  await ui.mark({ css: '.dispatch-attr-mark.dispatch-attr-mix' }, { what: '人形加星：Agent 写的、你在编辑器里又改过', where: 'diff 里那一行的左边', how: '在 Changes 的 diff 里改 Agent 写的一行，⌘S 存盘' });
  await ui.mark({ css: '.dispatch-attr-mark.dispatch-attr-you' }, { what: '人形：你在编辑器里自己加的行', where: 'diff 里那一行的左边', how: '在 diff 里打字加一行，⌘S 存盘' });
  if (after.other) await ui.mark({ css: '.dispatch-attr-mark.dispatch-attr-other' }, { what: '虚线方块：脚本加的行，不是 Agent 也不是你', where: 'diff 里那一行的左边', how: '没有 Agent 在跑、编辑器也没看到有人打字时改出来的行' });

  // the script's own file: no person anywhere, every line not from an agent
  await closeTips(ui);
  await ui.waitFor({ text: 'post-commit', exact: true, within: '.changes-file-list', webview: false }, { timeoutMs: 60000 });
  await ui.click({ text: 'post-commit', exact: true, within: '.changes-file-list', webview: false });
  const scriptFile = await until(ui, async () => {
    const c = await ui.eval(`({ you: ${marksIn('you', TOOL)}, mix: ${marksIn('mix', TOOL)}, other: ${marksIn('other', TOOL)} })`);
    return c.other + c.you + c.mix >= 3 ? c : null;
  }, 'marks on the script\'s three lines', 60000);
  await ui.sleep(1500);
  const rowsAfter = await ui.eval(counts);
  await restPointer(ui);
  await ui.screenshot('03-script-file');
  if (scriptFile.other) await ui.mark({ css: '.dispatch-attr-mark.dispatch-attr-other' }, { what: '工具生成的文件：每行虚线方块，没有人形', where: 'Changes 里 tools/post-commit 的 diff', how: '没人打字、也没 Agent 在跑时出现的文件' });
  const hoverScript = await hoverText(ui, '.dispatch-attr-mark.dispatch-attr-other, .dispatch-attr-mark.dispatch-attr-you', '/Not from an agent in Dispatch|You changed this line/');
  await ui.screenshot('04-hover-script-file');

  await closeTips(ui);
  await ui.click({ text: 'NOTES.md', exact: true, within: '.changes-file-list', webview: false });
  await until(ui, async () => (await ui.eval(marks('mix'))) >= 1, 'the marks of NOTES.md again', 30000);
  const hoverMix = await hoverText(ui, '.dispatch-attr-mark.dispatch-attr-mix', '/then you changed it/');
  await ui.screenshot('05-hover-mixed-line');
  await closeTips(ui);
  const hoverYou = await hoverText(ui, '.dispatch-attr-mark.dispatch-attr-you', '/You changed this line/');
  await ui.screenshot('06-hover-your-line');
  await closeTips(ui);
  const hoverOther = await hoverText(ui, '.dispatch-attr-mark.dispatch-attr-other', '/Not from an agent in Dispatch/');
  await ui.screenshot('07-hover-script-line');

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
  // the open diff asks again after each mark and once more a while after a turn starts (when the agent's plugin has
  // passed the note on): no need to open it again
  await ui.sleep(14000);
  await ui.click({ text: 'NOTES.md', exact: true, within: '.changes-file-list', webview: false });
  await until(ui, async () => (await ui.eval(marks('mix'))) >= 1, 'the marks of NOTES.md after the next turn', 30000);
  const told = await hoverText(ui, '.dispatch-attr-mark.dispatch-attr-you', '/was told to keep it/');
  const toldOther = await hoverText(ui, '.dispatch-attr-mark.dispatch-attr-other', '/Not from an agent in Dispatch/');
  await ui.screenshot('08-told-after-next-turn');

  const edits = readEdits(ui);
  const result = { file, before, after, hoverMix, hoverYou, hoverOther, hoverScript, scriptFile, rowsAfter, note, told, toldOther, edits, reopened };
  writeFileSync(`${ui.out}/result.json`, JSON.stringify(result, null, 2));
  if (before.you || before.mix || before.unsure) throw new Error(`The agent's own lines were marked: ${JSON.stringify(before)}`);
  if (!/written by OpenCode/.test(before.hint)) throw new Error(`The grey line says: ${before.hint}`);
  if (!edits.some(e => e.event === 'save' && e.path === 'NOTES.md' && e.base && e.sha)) throw new Error(`The editor recorded no save of NOTES.md: ${JSON.stringify(edits)}`);
  if (after.you !== 1 || after.mix !== 1 || after.other !== 1 || after.unsure !== 0) throw new Error(`Expected one your line, one mixed line and one script line: ${JSON.stringify(after)}`);
  if (!/Beta: written by the agent/.test(hoverMix)) throw new Error(`The mixed line's hover lacks the agent's text: ${hoverMix}`);
  if (scriptFile.you || scriptFile.mix || scriptFile.other < 3) throw new Error(`The script's file is marked as yours: ${JSON.stringify(scriptFile)}`);
  if (!/^\s*Not from an agent in Dispatch\s*$/.test(hoverOther) || !/^\s*Not from an agent in Dispatch\s*$/.test(hoverScript)) throw new Error(`The script line's hover says more than it knows: ${JSON.stringify(hoverOther)}`);
  const notesRow = rowsAfter.rows.find(r => r.name.startsWith('NOTES.md')), scriptRow = rowsAfter.rows.find(r => r.name.startsWith('post-commit'));
  if (!notesRow || !notesRow.chip.some(c => /You changed 2 lines/.test(c || ''))) throw new Error(`NOTES.md's row has no person mark for your 2 lines: ${JSON.stringify(rowsAfter.rows)}`);
  if (!scriptRow || scriptRow.chip.length) throw new Error(`The script's file row has a person mark: ${JSON.stringify(rowsAfter.rows)}`);
  if (after.letters.some(d => d !== 'none')) throw new Error('The A / M / D letter still shows');
  if (!note.files || note.files.length !== 1 || note.files[0].path !== 'NOTES.md' || note.files[0].count !== 2) throw new Error(`The next turn would hear about more than your two lines: ${JSON.stringify(note)}`);
  if (/post-commit|Zeta/.test(note.text)) throw new Error(`The note names the script's changes: ${note.text}`);
  if (!/OpenCode was told to keep it/.test(told)) throw new Error(`Your line's hover does not say OpenCode was told: ${told}`);
  if (/told/.test(toldOther)) throw new Error(`The script line says the agent was told: ${toldOther}`);
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
