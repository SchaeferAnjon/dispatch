// Who wrote which line, step by step (task-6qpx, direction B): an OpenCode session writes four lines of NOTES.md;
// you change one and add one in the editor; a row under the reply says so and shows only your lines; Changes splits All / Turn 1 /
// You; Settings › Agents turns on the co-author line; the next turn names your lines; the agent's commit gets a card
// that counts your lines. Then the same pictures in light. Test model: OpenCode DeepSeek Flash (or GLM Flash, or
// OpenCode's free MiMo Flash).
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { editInEditor } from './attribution.mjs';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
export const meta = { needs: ['opencode'], title: 'Who wrote which line, step by step', description: 'You changed 2 lines under the reply, All / Turn 1 / You in Changes, the agent told at its next turn, the commit card, the co-author switch, light.', timeout: 2400 };

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


// what a person sees after they change the agent's lines: a row under the reply, Changes by step, the agent
// told at its next turn, a commit card that counts their lines, the switch in Settings › Agents
const row = '.interactive-response .dispatch-attr-yours';
const lastReply = `(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return r ? { text: (r.querySelector('.value') || r).innerText, done: !r.classList.contains('chat-response-loading') } : null; })()`;

/** The message box of a session that is going: click into it until it has the keyboard focus. */
async function focusChat(ui) {
  const box = '.interactive-input-part .monaco-editor';
  for (let i = 0; i < 8; i++) {
    await ui.click({ css: box, webview: false });
    await ui.sleep(400);
    if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('.interactive-input-part')`)) return;
    await ui.sleep(800);
  }
  throw new Error('The message box does not take the focus');
}

async function send(ui, text) {
  await closeTips(ui);
  if (await ui.exists({ css: fresh, webview: false })) await focusInput(ui);
  else await focusChat(ui);
  await ui.type(text);
  await ui.press('Enter', { send: true });
}

/** Wait for the reply to the message just sent: the last reply is a new one (its words differ from `before`, the
 *  last reply's words when it was sent; the list draws only the replies on screen, so counting them does not
 *  work), it is done and says DONE (approving its steps). */
async function replyDone(ui, before, what, ms = 300000) {
  return until(ui, async () => {
    const ask = await ui.eval(`[...document.querySelectorAll('.interactive-session button, .chat-confirmation-widget button')].map(b => b.innerText.trim()).find(t => /^(Allow|Allow once|Approve|Continue|Yes)$/i.test(t)) || ''`);
    if (ask) await ui.click({ text: ask, exact: true });
    const r = await ui.eval(lastReply);
    if (r && /401|unauthori[sz]ed|quota|insufficient balance/i.test(r.text)) throw new Error(`The test model failed: ${r.text.slice(0, 200)}`);
    return r && r.text !== before && r.done && /DONE/.test(r.text) ? r.text : null;
  }, what, ms);
}

const lastText = async (ui) => ((await ui.eval(lastReply)) || {}).text || '';

async function theme(ui, value) {
  for (const dir of [ui.rec.user_data_dir, ui.rec.agents_user_data_dir]) {
    const file = join(dir, 'User/settings.json');
    let settings = {};
    try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { /* a new profile */ }
    Object.assign(settings, { 'window.autoDetectColorScheme': false, 'workbench.colorTheme': value === 'light' ? 'Dispatch Light' : 'Dispatch Dark' });
    writeFileSync(file, JSON.stringify(settings, null, 2));
  }
  const wanted = value === 'light' ? 'vs' : 'vs-dark';
  for (let i = 0; i < 60; i++) {
    if (await ui.eval(`document.querySelector('.monaco-workbench').classList.contains('${wanted}')`)) return;
    await ui.sleep(250);
  }
  throw new Error(`theme did not change: ${value}`);
}

const steps = () => `({ buttons: [...document.querySelectorAll('.dispatch-attr-steps .seg-b')].map(b => ({ id: b.dataset.step, text: b.innerText.trim(), on: b.classList.contains('on'), w: Math.round(b.getBoundingClientRect().width) })),
  bar: Math.round(document.querySelector('.dispatch-attr-steps')?.getBoundingClientRect().width || 0),
  note: document.querySelector('.dispatch-attr-stepnote')?.innerText.replace(/\\s+/g, ' ').trim() || '',
  diffs: [...document.querySelectorAll('.monaco-diff-editor .editor.modified')].filter(e => e.getBoundingClientRect().width > 0).length,
  added: [...document.querySelectorAll('.monaco-diff-editor .editor.modified .line-insert, .monaco-diff-editor .editor.modified .char-insert')].length,
  you: ${marks('you')}, mix: ${marks('mix')} })`;

async function stepTo(ui, id, re) {
  await closeTips(ui); // a first-run tip about Changes can sit right over the choices
  await ui.click({ css: `.dispatch-attr-steps .seg-b[data-step="${id}"]`, webview: false });
  let seen;
  return until(ui, async () => { const s = seen = await ui.eval(steps()); return re.test(s.note) && s.buttons.find(b => b.id === id)?.on ? s : null; }, `the ${id} step`, 30000)
    .catch(e => { throw new Error(`${e.message}; last seen: ${JSON.stringify({ buttons: seen?.buttons, bar: seen?.bar, note: seen?.note })}`); });
}

export default async function (ui) {
  try {
    await run(ui);
  } finally {
    diagnose(ui);
  }
}

async function run(ui) {
  const facts = {};
  const save = () => writeFileSync(`${ui.out}/result.json`, JSON.stringify(facts, null, 2));
  await ui.openAgents(ui.demoFolder);
  await offScreen(ui);
  await newSessionInProject(ui, ui.demoFolder);
  await ui.pickEngine('OpenCode', 360000);
  await focusInput(ui);
  await ui.type('/model');
  await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 30000 });
  let seen = '';
  const model = await until(ui, async () => {
    const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => ({name:r.querySelector('.dsm-name')?.textContent}))`);
    seen = rows.map(r => r.name).join(', ');
    return ui.cheapModel(rows);
  }, 'a test model', 45000).catch(e => { throw new Error(`${e.message}; the menu had: ${seen}`); });
  facts.model = model.name;
  const typed = async () => ui.eval(`document.querySelector('${fresh} .view-lines')?.textContent || ''`);
  for (let i = 0; i < 40 && (await typed()).trim(); i++) await ui.press('Backspace');
  await ui.type(`/${model.name.replace(/\s+/g, '')}`);
  await until(ui, async () => ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row .dsm-name')].some(n => n.textContent === ${JSON.stringify(model.name)})`), `the menu row ${model.name}`, 20000);
  await ui.click({ text: model.name, exact: true, within: '.dispatch-slash-menu' });
  await ui.press('Escape');

  // turn 1: the agent writes four lines
  await send(ui, PROMPT);
  const file = await until(ui, async () => {
    const ask = await ui.eval(`[...document.querySelectorAll('.interactive-session button, .chat-confirmation-widget button')].map(b => b.innerText.trim()).find(t => /^(Allow|Allow once|Approve|Continue|Yes)$/i.test(t)) || ''`);
    if (ask) await ui.click({ text: ask, exact: true });
    return notesFile(ui);
  }, 'the agent writing NOTES.md', 240000);
  await replyDone(ui, '', 'the first turn to end');
  await ui.sleep(4000);
  facts.file = file;
  facts.rowBefore = await ui.exists({ css: row, webview: false });

  // you change Beta and add Epsilon, typed in the Changes diff and saved with ⌘S (only what the editor saw you type
  // counts as yours, task-m6hek)
  await ui.sleep(7000);
  await editInEditor(ui, file, { after: 'Beta: written by the agent', add: ', then edited by you', append: '- Epsilon: a line you added' });

  // 1. the row under the reply
  await until(ui, async () => /You changed 2 lines in NOTES\.md/.test(await ui.eval(`[...document.querySelectorAll('${row}')].map(r => r.innerText).join('|')`)), 'the row "You changed 2 lines in NOTES.md"', 90000);
  facts.row = await ui.eval(`[...document.querySelectorAll('${row}')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
  facts.rowLabel = await ui.eval(`document.querySelector('${row}')?.getAttribute('aria-label') || ''`);
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot('01-you-changed-row');
  await ui.mark({ css: row, webview: false }, { what: '对话里这一轮下面：You changed 2 lines in NOTES.md', where: '你改过的那一轮回复下面', how: 'Agent 写完后你在编辑器里改几行，存盘就出现；点它只看这两行' });

  // 2. click it: Changes shows only your two lines, the You step on
  await ui.click({ css: row, webview: false });
  facts.you = await until(ui, async () => { const s = await ui.eval(steps()); return /Your changes/.test(s.note) && s.diffs > 0 && s.buttons.find(b => b.on)?.text === 'You' ? s : null; }, 'Changes showing only your lines', 60000);
  facts.youMarks = await until(ui, async () => { const s = await ui.eval(steps()); return s.you + s.mix >= 2 ? s : null; }, 'the marks on your two lines in the You step', 30000).catch(() => null);
  facts.fileRows = await ui.eval(`[...document.querySelectorAll('.changes-file-list .monaco-list-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot('02-only-your-lines');
  await ui.mark({ css: '.dispatch-attr-steps', webview: false }, { what: 'All / Turn 1 / You：按轮看改动', where: '右栏 Changes 顶上', how: '点 Turn 1 只看 Agent 这一轮写的，点 You 只看你改的' });
  await ui.mark({ css: '.dispatch-attr-stepnote', webview: false }, { what: '正在看哪一步，Show all 回到全部', where: '按轮选择下面一行灰字', how: '点对话里那一行，或点上面的 You' });

  // 3. Turn 1, then All
  facts.turn = await stepTo(ui, 'turn:1', /Turn 1/); // the grey line under the choices still says which turn
  await restPointer(ui);
  await ui.screenshot('03-turn-1');
  await ui.mark({ css: '.dispatch-attr-steps .seg-b[data-step="turn:1"]', webview: false }, { what: '这一轮按你那条消息的开头命名：只看 Agent 这一轮写的四行', where: '右栏 Changes 顶上', how: '点它' });
  // the turn is named by the start of your message, not "Turn 1" (task-92l8p); its hover has the whole message and the file
  const turnButton = facts.turn.buttons.find(b => b.id === 'turn:1');
  if (!turnButton?.text.startsWith('Append exactly these four lines')) throw new Error(`the turn is not named by your message: ${JSON.stringify(turnButton)}`);
  const narrow = facts.turn.buttons.filter(b => b.w < (b.id.startsWith('turn:') ? 56 : 24));
  if (narrow.length) throw new Error(`a choice is squeezed: ${JSON.stringify(facts.turn.buttons)} in ${facts.turn.bar}px`);
  facts.turnLabelCut = await ui.eval(`(() => { const l = document.querySelector('.dispatch-attr-steps .seg-b[data-step="turn:1"] .lbl'); return l ? { shown: Math.round(l.getBoundingClientRect().width), full: l.scrollWidth } : null; })()`);
  await closeTips(ui);
  await ui.hover({ css: '.dispatch-attr-steps .seg-b[data-step="turn:1"]', webview: false });
  facts.turnTip = await until(ui, async () => {
    const t = await ui.eval(`[...document.querySelectorAll('.workbench-hover, .monaco-hover')].filter(h => h.getBoundingClientRect().width > 0).map(h => h.innerText).join('|')`);
    return /OpenCode changed NOTES\.md in turn 1/.test(t) ? t : null;
  }, 'the turn hover with your message and the file', 20000);
  if (!facts.turnTip.includes('Alpha: written by the agent')) throw new Error(`the hover lacks the whole message: ${facts.turnTip}`);
  await ui.screenshot('03b-turn-hover');
  await restPointer(ui);
  await closeTips(ui);
  await ui.click({ css: '.dispatch-attr-steps .seg-b[data-step="all"]', webview: false });
  facts.all = await until(ui, async () => { const s = await ui.eval(steps()); return !s.note && s.buttons.find(b => b.on)?.id === 'all' ? s : null; }, 'All again', 30000);

  // 3c. the same choices in light, before the agent commits (after its commit Changes has nothing left to show, so no You)
  await theme(ui, 'light');
  await ui.sleep(1500);
  await stepTo(ui, (await ui.eval(steps())).buttons.find(b => b.text === 'You')?.id || 'you:1', /Your changes/);
  await restPointer(ui);
  await ui.screenshot('08-light-only-your-lines');
  await ui.mark({ css: '.dispatch-attr-steps', webview: false }, { what: '浅色：All / 这一轮 / You', where: '右栏 Changes 顶上', how: '点 You' });
  await closeTips(ui);
  await ui.click({ css: '.dispatch-attr-steps .seg-b[data-step="all"]', webview: false });
  await theme(ui, 'dark');

  // 4. Settings › Agents: sign commits as co-authored by the AI (off by default), turned on
  await ui.press('Cmd+,');
  await ui.waitFor({ css: '.dispatch-settings-nav', webview: false }, { timeoutMs: 30000 });
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="agents"]', webview: false });
  // Commits is further down the page since Where agents make their changes came above it: scrolled to, as a person does
  for (let i = 0; i < 30 && !(await ui.exists({ css: '[data-setting="co-author"] .monaco-checkbox', webview: false })); i++) {
    await ui.eval(`document.querySelector('[data-setting="co-author"]')?.scrollIntoView({ block: 'center' })`);
    await ui.sleep(1000);
  }
  await ui.waitFor({ css: '[data-setting="co-author"] .monaco-checkbox', webview: false }, { timeoutMs: 30000 }).catch(async (e) => {
    const why = await ui.eval(`(() => { const b = [...document.querySelectorAll('[data-setting="co-author"]')]; return { blocks: b.length, page: document.querySelector('.dispatch-settings-nav .dsn-row.on, .dispatch-settings-nav [aria-current="page"]')?.textContent || '', html: b.map(x => x.outerHTML.replace(/\\s+/g, ' ').slice(0, 600)) }; })()`).catch(() => null);
    throw new Error(`${e.message}; ${JSON.stringify(why)}`);
  });
  facts.coAuthorBefore = await ui.eval(`document.querySelector('[data-setting="co-author"] .monaco-checkbox')?.getAttribute('aria-checked')`);
  await ui.click({ css: '[data-setting="co-author"] .monaco-checkbox', webview: false });
  facts.coAuthorAfter = await until(ui, async () => { const v = await ui.eval(`document.querySelector('[data-setting="co-author"] .monaco-checkbox')?.getAttribute('aria-checked')`); return v === 'true' ? v : null; }, 'the switch on', 15000);
  facts.coAuthorStored = JSON.parse(execFileSync(join(ui.rec.bin_dir, 'dispatch'), ['attribution', 'config', '--json'], { encoding: 'utf8', timeout: 30000 }));
  await ui.eval(`document.querySelector('[data-setting="co-author"]')?.scrollIntoView({ block: 'center' })`);
  await restPointer(ui);
  await ui.screenshot('04-settings-co-author');
  await ui.mark({ text: 'Sign commits as co-authored by the AI', exact: true, webview: false }, { what: '提交署名开关，默认关', where: '设置 › Agents › Commits', how: '⌘, 打开设置，点 Agents' });
  await ui.mark({ css: '[data-setting="co-author"] .monaco-checkbox', webview: false }, { what: '打开：每一轮请 Agent 在提交说明末尾署名', where: '这一行右边', how: '点一下' });
  // back to the session the way a person does: the side bar's ‹ Sessions (Esc too, once the switch lets go of it)
  await restPointer(ui);
  await ui.click({ text: 'Sessions', exact: true, within: '.part.sidebar', webview: false }).catch(() => ui.press('Escape'));
  await until(ui, async () => ui.exists({ css: '.interactive-input-part .monaco-editor', webview: false }), 'the session again after Settings', 30000);
  await ui.sleep(1000);

  // 5. turn 2: the agent was told which lines you changed
  const n1 = await lastText(ui);
  await send(ui, 'Did Dispatch tell you which lines of NOTES.md I changed since your last turn? Answer with those line numbers and their text, change nothing, then reply DONE.');
  facts.reply2 = (await replyDone(ui, n1, 'the second turn to end')).slice(0, 800);
  await ui.sleep(4000);
  facts.toldTip = await until(ui, async () => { const l = await ui.eval(`document.querySelector('${row}')?.getAttribute('aria-label') || ''`); return /was told/.test(l) ? l : null; }, 'the row saying the agent was told', 60000).catch(() => '');
  await ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); if (r) { r.dataset.e2eLast = '1'; r.scrollIntoView({ block: 'end' }); } })()`);
  await restPointer(ui);
  await ui.screenshot('05-agent-was-told');
  await ui.mark({ css: '.interactive-response[data-e2e-last="1"] .value', webview: false }, { what: '第 2 轮：Agent 说出了你改的那两行', where: '对话里第二轮回复', how: '你改了以后再发一句，Dispatch 在这一轮开头告诉它' });

  // 6. turn 3: the agent commits; the card counts your lines and the message ends with the co-author line
  const n2 = await lastText(ui);
  await send(ui, 'Commit NOTES.md with git now, with the message "Add notes". Then reply DONE.');
  await replyDone(ui, n2, 'the commit turn to end');
  await until(ui, async () => /Includes 2 lines you changed/.test(await ui.eval(`[...document.querySelectorAll('.dispatch-attr-commit')].map(c => c.innerText).join('|')`)), 'the commit card with your lines', 90000);
  await ui.click({ css: '.dispatch-attr-commit .more', webview: false });
  await ui.sleep(600);
  facts.card = await ui.eval(`document.querySelector('.dispatch-attr-commit')?.innerText.replace(/\\s+/g, ' ').trim() || ''`);
  facts.message = execFileSync('git', ['-C', file.replace(/\/NOTES\.md$/, ''), 'log', '-1', '--format=%B'], { encoding: 'utf8' });
  await ui.eval(`document.querySelector('.dispatch-attr-commit')?.scrollIntoView({ block: 'center' })`);
  await restPointer(ui);
  await ui.screenshot('06-commit-card');
  await ui.mark({ css: '.dispatch-attr-commit', webview: false }, { what: '提交卡：Message by OpenCode，Includes 2 lines you changed', where: 'Agent 提交那一轮回复下面', how: '让 Agent 提交；点右上角箭头看整段提交说明' });

  // 7. the same in light
  await theme(ui, 'light');
  await ui.sleep(1500);
  await ui.eval(`document.querySelector('${row}')?.scrollIntoView({ block: 'center' })`);
  await restPointer(ui);
  await ui.screenshot('07-light-row-and-card');
  save();
  await theme(ui, 'dark');
  save();

  if (facts.rowBefore) throw new Error('The row showed before you changed anything');
  if (!facts.youMarks) throw new Error(`The You step has no marks on your lines: ${JSON.stringify(facts.you)}`);
  if (!facts.toldTip) throw new Error('The row never said the agent was told');
  if (!/\b5\b|Beta/.test(facts.reply2) || !/\b8\b|Epsilon/.test(facts.reply2)) throw new Error(`The agent did not name your lines: ${facts.reply2}`);
  if (!/Message by OpenCode/.test(facts.card)) throw new Error(`The card: ${facts.card}`);
  if (!/^Co-authored-by: OpenCode/m.test(facts.message)) throw new Error(`The commit message has no co-author line: ${facts.message}`);
  if (facts.coAuthorBefore !== 'false' || !facts.coAuthorStored.co_author) throw new Error(`The switch: ${facts.coAuthorBefore} -> ${JSON.stringify(facts.coAuthorStored)}`);
}
