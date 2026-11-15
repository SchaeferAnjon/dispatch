// Your own commit gets its card too, and the delivery page says who wrote it (task-vqco9, attribution direction B):
// an OpenCode session writes four lines of NOTES.md, you change one in the editor, you press Commit in Changes (Dispatch has the
// default agent write the message, then commits); under that turn's reply a commit card says "You committed", who
// wrote the message and whose lines it holds; its arrow opens the message and leaves no ring after a click. Then a
// delivery for a task with that commit: the page's header says "OpenCode 写的 · 你改了 1 行". Test model: OpenCode
// DeepSeek Flash (or GLM Flash, or OpenCode's free Flash).
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { until, offScreen, closeTips, restPointer, newSessionInProject, focusInput } from './chat-capture-panes.mjs';
import { editInEditor } from './attribution.mjs';

export const meta = { needs: ['opencode'], title: 'Your own commit gets its card; the delivery page says who wrote it', description: 'You change a line the agent wrote and press Commit: a card under the reply says You committed, who wrote the message and whose lines it holds; a delivery with that commit says OpenCode 写的 · 你改了 1 行 in its header.', timeout: 1800 };

const fresh = '.sessions-chat-editor';
const AGENT_LINES = ['- Alpha: written by the agent', '- Beta: written by the agent', '- Gamma: written by the agent', '- Delta: written by the agent'];
const PROMPT = `Append exactly these four lines to the end of NOTES.md, keep everything else as it is, use your file edit tool, do not commit, then reply DONE:\n${AGENT_LINES.join('\n')}`;
const lastReply = `(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return r ? { text: (r.querySelector('.value') || r).innerText, done: !r.classList.contains('chat-response-loading') } : null; })()`;
const card = '.dispatch-attr-commit.own';

function assert(v, m) { if (!v) throw new Error(m); }
const dispatch = (ui, args, timeout = 120000, cwd = undefined) => execFileSync(join(ui.rec.bin_dir, 'dispatch'), args, { encoding: 'utf8', timeout, cwd });

function notesFile(ui) {
  const out = execFileSync('git', ['-C', ui.demoFolder, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  for (const root of out.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9))) {
    const p = `${root}/NOTES.md`;
    if (existsSync(p) && readFileSync(p, 'utf8').includes('Delta: written by the agent')) return p;
  }
  return '';
}

async function pickTestModel(ui) {
  // typed before the new-session page took its engine's commands (a busy start), "/model" stays plain text: cleared and
  // typed again, as a person does when no menu comes
  for (let attempt = 1; ; attempt++) {
    await focusInput(ui);
    await ui.type('/model');
    try {
      await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 10000 });
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await ui.press('End');
      for (let i = 0; i < 8; i++) await ui.press('Backspace');
      await ui.sleep(3000);
    }
  }
  let seen = '';
  const model = await until(ui, async () => {
    const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => ({name:r.querySelector('.dsm-name')?.textContent}))`);
    seen = rows.map(r => r.name).join(', ');
    return ui.cheapModel(rows);
  }, 'a test model', 45000).catch(e => { throw new Error(`${e.message}; the menu had: ${seen}`); });
  const typed = async () => ui.eval(`document.querySelector('${fresh} .view-lines')?.textContent || ''`);
  for (let i = 0; i < 40 && (await typed()).trim(); i++) await ui.press('Backspace');
  await ui.type(`/${model.name.replace(/\s+/g, '')}`);
  await until(ui, async () => ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row .dsm-name')].some(n => n.textContent === ${JSON.stringify(model.name)})`), `the menu row ${model.name}`, 20000);
  await ui.click({ text: model.name, exact: true, within: '.dispatch-slash-menu' });
  await ui.press('Escape');
  return model.name;
}

/** A button or action in the side pane (the right half) whose label is `label`, as a point to press. */
const sideButton = (ui, label) => ui.eval(`(() => {
  const els = [...document.querySelectorAll('a, button, .monaco-button, .action-label')]
    .filter(e => ((e.getAttribute('aria-label') || '').split(' (')[0].trim() === ${JSON.stringify(label)} || (e.innerText || '').trim() === ${JSON.stringify(label)}))
    .map(e => ({ r: e.getBoundingClientRect() })).filter(x => x.r.width > 0 && x.r.left > innerWidth / 2)
    .sort((a, b) => a.r.top - b.r.top);
  return els[0] ? { x: els[0].r.left + els[0].r.width / 2, y: els[0].r.top + els[0].r.height / 2 } : null;
})()`);
const sideLabels = (ui) => ui.eval(`[...document.querySelectorAll('a, button, .monaco-button, .action-label')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.left > innerWidth / 2; }).map(e => (e.getAttribute('aria-label') || e.innerText || '').trim()).filter(Boolean).slice(0, 80)`);

async function press(ui, b) {
  await ui.mouse('mouseMoved', b.x, b.y);
  await ui.mouse('mousePressed', b.x, b.y, { clickCount: 1 });
  await ui.mouse('mouseReleased', b.x, b.y, { clickCount: 1 });
}

export default async function (ui) {
  const facts = {};
  const save = () => writeFileSync(`${ui.out}/result.json`, JSON.stringify(facts, null, 2));
  try {
    await run(ui, facts);
  } finally {
    save();
  }
}

async function run(ui, facts) {
  await ui.openAgents(ui.demoFolder);
  await offScreen(ui);
  await newSessionInProject(ui, ui.demoFolder);
  await ui.pickEngine('OpenCode', 360000);
  facts.model = await pickTestModel(ui);

  // the agent's turn: four lines, no commit
  await closeTips(ui);
  await focusInput(ui);
  await ui.type(PROMPT);
  await ui.press('Enter', { send: true });
  const file = await until(ui, async () => {
    const ask = await ui.eval(`[...document.querySelectorAll('.interactive-session button, .chat-confirmation-widget button')].map(b => b.innerText.trim()).find(t => /^(Allow|Allow once|Approve|Continue|Yes)$/i.test(t)) || ''`);
    if (ask) await ui.click({ text: ask, exact: true });
    return notesFile(ui);
  }, 'the agent writing NOTES.md', 300000);
  await until(ui, async () => { const r = await ui.eval(lastReply); return r && r.done && /DONE/.test(r.text) ? r : null; }, 'the turn to end', 300000);
  facts.file = file;
  const root = file.replace(/\/NOTES\.md$/, '');
  const head0 = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // past the turn's end as the record has it (the window marks it a few seconds after the reply shows on a busy Mac;
  // a file written within 6 s of that is the agent finishing up), as a person reads the reply first
  const lastEnd = () => {
    let t = 0;
    const base = join(ui.rec.dispatch_dir, 'attribution');
    for (const d of existsSync(base) ? readdirSync(base) : []) {
      const f = join(base, d, 'marks.jsonl');
      if (!existsSync(f)) continue;
      for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) { try { const m = JSON.parse(l); if (m.event === 'end') t = Math.max(t, m.ts); } catch { /* a torn line */ } }
    }
    return t;
  };
  await until(ui, async () => { const t = lastEnd(); return t && Date.now() / 1000 - t > 12 ? t : null; }, 'the turn\'s end in the record, and a moment after', 120000, 2000);

  // you change Beta, typed in the Changes diff and saved with ⌘S (only what the editor saw you type counts as yours,
  // task-m6hek); the line as the agent wrote it: a small model may leave out the list dash or put spaces before it
  const before = readFileSync(file, 'utf8');
  assert(/Beta: written by the agent/.test(before), 'the agent wrote a Beta line to change: ' + JSON.stringify(before.slice(-300)));
  await editInEditor(ui, file, { after: 'Beta: written by the agent', add: ', then edited by you' });
  await until(ui, async () => /You changed 1 line in NOTES\.md/.test(await ui.eval(`[...document.querySelectorAll('.interactive-response .dispatch-attr-yours')].map(r => r.innerText).join('|')`)), 'the row "You changed 1 line"', 90000);

  // Commit in Changes: Dispatch has the default agent write the message, then commits
  await ui.openTab('Changes');
  await closeTips(ui);
  // Commit is the toolbar's button, or in the menu next to its first button (Merge for a session's own copy)
  let commit = await until(ui, async () => sideButton(ui, 'Commit'), 'the Commit button in Changes', 15000).catch(() => null);
  const menuItem = `(() => { const it = [...document.querySelectorAll('.monaco-menu .action-item, .action-widget .monaco-list-row, .context-view .monaco-list-row')].find(e => /^Commit\\b/.test((e.innerText || '').trim()) && e.getBoundingClientRect().width > 0); if (!it) return null; const r = it.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: it.innerText.trim() }; })()`;
  if (!commit) {
    const toggles = await ui.eval(`[...document.querySelectorAll('.monaco-dropdown-button, .dropdown-action-container .action-label, a.action-label.codicon-chevron-down, .monaco-button-dropdown .monaco-dropdown-button')].map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.left > innerWidth / 2).map(r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))`);
    facts.toggles = toggles;
    for (const t of toggles) {
      await press(ui, t);
      await ui.sleep(900);
      commit = await ui.eval(menuItem);
      if (commit) break;
      await ui.press('Escape');
    }
    if (commit) {
      facts.commitFrom = 'menu: ' + commit.text;
      await ui.screenshot('c00-commit-menu');
    }
  }
  if (!commit) {
    // the toolbar of a session's own copy: More Actions next to it may hold Commit
    facts.toolbar = await ui.eval(`(() => { const m = [...document.querySelectorAll('[aria-label^="Bring this session\'s changes into"], [aria-label^="Commit any uncommitted changes"]')].find(e => e.getBoundingClientRect().width > 0); const t = m && (m.closest('.monaco-toolbar') || m.parentElement?.parentElement?.parentElement); return t ? t.outerHTML.slice(0, 4000) : ''; })()`);
    const mores = await ui.eval(`[...document.querySelectorAll('[aria-label="More Actions..."]')].map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.left > innerWidth / 2).map(r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))`);
    facts.menus = [];
    for (const t of mores) {
      await press(ui, t);
      await ui.sleep(900);
      facts.menus.push(await ui.eval(`[...document.querySelectorAll('.monaco-menu .action-label, .action-widget .monaco-list-row')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.innerText.trim())`));
      commit = await ui.eval(menuItem);
      if (commit) { facts.commitFrom = 'More Actions: ' + commit.text; await ui.screenshot('c00-commit-menu'); break; }
      await ui.press('Escape');
    }
  }
  if (!commit) {
    // Merge commits what is uncommitted first (Dispatch has the message written), then merges: the same press of a button
    commit = await ui.eval(`(() => { const m = [...document.querySelectorAll('[aria-label^="Bring this session\'s changes into"], [aria-label^="Commit any uncommitted changes"]')].find(e => e.getBoundingClientRect().width > 0); if (!m) return null; const r = m.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: m.innerText.trim() }; })()`);
    if (commit) facts.commitFrom = 'the toolbar button: ' + commit.text;
  }
  if (!commit) {
    facts.sideLabels = await sideLabels(ui);
    throw new Error('No Commit in Changes: ' + JSON.stringify(facts.sideLabels));
  }
  if (!facts.commitFrom) { await restPointer(ui); await ui.screenshot('c00-commit-button'); }
  await press(ui, commit);
  // Merge asks first ("uncommitted worktree changes will be committed first"): the person says yes
  if (await ui.waitFor({ text: 'Merge Changes', exact: true, within: '.monaco-dialog-box' }, { timeoutMs: 8000 }).then(() => true, () => false)) {
    await ui.screenshot('c00-merge-asks');
    await ui.click({ text: 'Merge Changes', exact: true, within: '.monaco-dialog-box' });
  }
  const head1 = await until(ui, async () => { const h = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); return h !== head0 ? h : null; }, 'the commit', 240000);
  facts.commit = execFileSync('git', ['-C', root, 'log', '-1', '--format=%h %s'], { encoding: 'utf8' }).trim();
  facts.message = execFileSync('git', ['-C', root, 'log', '-1', '--format=%B'], { encoding: 'utf8' });

  // the card under the reply
  const text = await until(ui, async () => { const t = await ui.eval(`document.querySelector('${card}')?.innerText.replace(/\\s+/g, ' ').trim() || ''`); return /You committed/.test(t) && /Holds/.test(t) ? t : null; }, 'the card of your commit', 90000);
  facts.card = text;
  assert(/Holds 3 lines OpenCode wrote · 1 line you changed/.test(text), 'whose lines: ' + text);
  assert(/Message by (OpenCode|Claude|Codex|Dispatch)/.test(text), 'who wrote the message: ' + text);
  await ui.eval(`document.querySelector('${card}')?.scrollIntoView({ block: 'center' })`);
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot('c01-your-commit-card');
  await ui.mark({ css: card, webview: false }, { what: '你自己提交的也出提交卡：You committed，谁写的提交说明，里面有几行是谁的', where: '那一轮回复下面', how: '在 Changes 点 Commit' });
  // the arrow: opens the message; a mouse click leaves no ring, the keyboard still shows one
  await ui.click({ css: `${card} .more`, webview: false });
  await ui.sleep(700);
  facts.ring = await ui.eval(`(() => { const b = document.querySelector('${card} .more'); return { focused: document.activeElement === b, outline: getComputedStyle(b).outlineStyle, open: document.querySelector('${card}').classList.contains('open') }; })()`);
  assert(facts.ring.open && (!facts.ring.focused || facts.ring.outline === 'none'), 'the arrow after a click: ' + JSON.stringify(facts.ring));
  await restPointer(ui);
  await ui.screenshot('c02-message-open-no-ring');
  await ui.mark({ css: `${card} .more`, webview: false }, { what: '点过的箭头不再留一圈焦点框', where: '提交卡右上角', how: '点它展开提交说明' });

  // a delivery with that commit: the page's header says who wrote it
  const begin = JSON.parse(dispatch(ui, ['begin', 'Notes for the demo', '--force', '-P', 'demo', '-d', 'The agent writes four notes and the person changes one before committing them.', '--json']).replace(/^[^{]*/, ''));
  const tid = begin.id;
  dispatch(ui, ['task', 'deliver', tid, '--commit', head1.slice(0, 12), '--json'], 120000, root);
  const dir = join(ui.rec.root, 'deliveries', 'notes');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(ui.out, 'c01-your-commit-card.png'), join(dir, '01-card.png'));
  writeFileSync(join(dir, 'notes.md'), '# 演示项目的笔记\n\n- NOTES.md 多了四行，其中一行你改过。\n\n## 改了什么\n\n- ![提交卡](01-card.png) 你提交以后对话里多一张提交卡。\n');
  facts.deliver = dispatch(ui, ['deliver', tid, '--from', dir, '--model', 'OpenCode · DeepSeek Flash', '--show', '--json']).slice(-400);
  const page = readFileSync(join(dir, 'index.html'), 'utf8');
  const att = (page.match(/<div class="att"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
  facts.att = att.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert(/OpenCode 写的/.test(facts.att) && /你改了 1 行/.test(facts.att), 'the header line: ' + facts.att);
  // the page as it opened in the side pane (when the integrated browser holds it; a delivery can also open as a webview)
  try {
    const shown = await ui.browserPage('index.html');
    await shown.eval(`document.querySelector('.att')?.scrollIntoView({ block: 'center' })`);
    await shown.screenshot('c03-delivery-header');
    facts.shownAtt = await shown.eval(`document.querySelector('.att')?.innerText.replace(/\\s+/g, ' ').trim() || ''`);
  } catch (e) {
    facts.shownAtt = 'not captured: ' + String(e.message || e).slice(0, 120);
    await ui.screenshot('c03-delivery-shown');
  }
  copyFileSync(join(dir, 'index.html'), join(ui.out, 'delivery-index.html'));
}
