// Direction A, pair 1 only. Real input on the instance's demo project; no engine messages.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const meta = { title: 'Tasks、交付物与 Docs 双向联动', description: '浅深色双向三态、Tab 聚焦、Esc 清理、点击到对应文档和任务。' };

function cli(ui, args) {
  const rec = ui.rec, env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(VSCODE_|ELECTRON_|CLAUDE_CODE_|DISPATCH_|BEADS_|CODEX_THREAD|CODEX_SESSION)/.test(key) && key !== 'CLAUDECODE') env[key] = value;
  }
  Object.assign(env, { BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home, DISPATCH_BIN: rec.cli,
    DISPATCH_E2E_INSTANCE: rec.name, PATH: `${path.join(rec.app, 'Contents/Resources/app/tools')}:${process.env.PATH}` });
  const r = spawnSync('python3', [rec.cli, ...args], { env, encoding: 'utf8', timeout: 90000 });
  if (r.status !== 0) throw new Error(`dispatch ${args[0]}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

async function theme(ui, value) {
  for (const dir of [ui.rec.user_data_dir, ui.rec.agents_user_data_dir]) {
    const file = path.join(dir, 'User/settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(settings, { 'window.autoDetectColorScheme': false, 'workbench.colorTheme': value === 'light' ? 'Dispatch Light' : 'Dispatch Dark' });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  }
  const wanted = value === 'light' ? 'vs' : 'vs-dark';
  for (let i = 0; i < 40; i++) {
    if (await ui.eval(`document.querySelector('.monaco-workbench').classList.contains('${wanted}')`)) return;
    await ui.sleep(250);
  }
  throw new Error(`theme did not change: ${value}`);
}

async function paneWidth(ui, width) {
  const info = await ui.eval(`(() => {
    const g = [...document.querySelectorAll('.part.editor')].find(e => e.getBoundingClientRect().width > 0);
    const r = g.getBoundingClientRect();
    const sash = [...document.querySelectorAll('.monaco-sash.vertical')].map(e => e.getBoundingClientRect()).find(b => b.height > 200 && Math.abs(b.x + b.width / 2 - r.x) < 12);
    return { right: r.right, sash: sash ? { x: sash.x + sash.width / 2, y: sash.y + sash.height / 2 } : null };
  })()`);
  if (!info.sash) return;
  await ui.mouse('mouseMoved', info.sash.x, info.sash.y);
  await ui.mouse('mousePressed', info.sash.x, info.sash.y, { button: 'left', clickCount: 1 });
  for (let i = 1; i <= 10; i++) await ui.mouse('mouseMoved', info.sash.x + (info.right - width - info.sash.x) * i / 10, info.sash.y, { button: 'left', buttons: 1 });
  await ui.mouse('mouseReleased', info.right - width, info.sash.y, { button: 'left', clickCount: 1 });
  await ui.sleep(600);
}

async function away(ui) {
  // the card now opens left of the right panel, over the middle: leave through the title bar, and wait out the
  // card's grace period (VS Code-like, 400 ms)
  const r = await ui.eval(`({ x: Math.round(innerWidth / 2), y: 8 })`);
  await ui.mouse('mouseMoved', r.x, r.y);
  await ui.sleep(700);
}

const preview = '.dispatch-linked-preview:not(.loading)';
const selectedTab = name => `!!document.querySelector('.tabs-container .tab[aria-label^="${name}"][aria-selected="true"]')`;
const linkedTab = name => `!!document.querySelector('.tabs-container .tab[aria-label^="${name}"].dispatch-linked-tab')`;

async function expect(ui, checks, name, expression) {
  if (!(await ui.eval(expression))) {
    fs.writeFileSync(path.join(ui.out, 'failure-state.json'), JSON.stringify(await ui.eval(`({focus:document.activeElement?.outerHTML.slice(0,300),hasFocus:document.hasFocus(),size:[innerWidth,innerHeight],trace:window.linkedTrace,targets:[...document.querySelectorAll('[data-dispatch-linked-target]')].map(e=>({kind:e.dataset.dispatchLinkedTarget,hover:e.matches(':hover'),text:e.textContent.slice(0,80)}))})`),null,2));
    throw new Error(name);
  }
  checks.push(name);
}

/** Crop at capture time: the pane and, only if needed, its neighbouring summary. */
async function capture(ui, name) {
  return ui.step('screenshot', name, async step => {
    const clip = await ui.eval(`(() => {
      const el = [...document.querySelectorAll('.part.editor .editor-group-container')].find(e => e.getBoundingClientRect().width > 0 && e.querySelector('.tabs-container'));
      const b = el.getBoundingClientRect(), p = document.querySelector('.dispatch-linked-preview')?.getBoundingClientRect();
      const x = Math.min(b.x, p ? p.x - 4 : b.x), y = b.y;
      return { x, y, width: b.right - x, height: b.height, scale: 1 };
    })()`);
    const image = await ui.cdp.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
    const file = `${name}.png`;
    fs.writeFileSync(path.join(ui.out, file), Buffer.from(image.data, 'base64'));
    step.shot = file; step.clip = clip; ui.shots.push(file);
    step.elements = await ui.eval(`JSON.stringify([...document.querySelectorAll('.dispatch-task-card.dispatch-linked, .dispatch-task-deliverable.dispatch-linked, .dispatch-docs-row.dispatch-linked, .dispatch-linked-tab, .dispatch-linked-preview')].filter(e => e.getBoundingClientRect().width).map(e => { const b=e.getBoundingClientRect(); return { classes: e.className, box: [b.x,b.y,b.width,b.height] }; }))`);
    return file;
  });
}

export default async function(ui) {
  const task = ui.rec.seed.tasks.in_progress;
  const file = path.join(ui.demoFolder, 'NOTES.md');
  cli(ui, ['task', 'deliver', task, '--file', file]);
  cli(ui, ['task', 'plan', task, '--active', '2']);
  await ui.openAgents(ui.demoFolder);
  await ui.newSession();
  // The other allowed test window may be active on macOS. Keep this CDP page focused without
  // bringing it in front of the user's windows; intra-page focus/blur still uses real key events.
  await ui.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await ui.eval(`(() => { window.linkedTrace=[]; const add=(kind,data={})=>{window.linkedTrace.push({time:performance.now(),kind,...data});if(window.linkedTrace.length>200)window.linkedTrace.shift()};
    add('start',{w:innerWidth,h:innerHeight});
    for(const k of ['blur','resize'])window.addEventListener(k,()=>add(k,{w:innerWidth,h:innerHeight,focus:document.hasFocus()}));
    document.addEventListener('scroll',e=>{if(document.querySelector('.dispatch-linked-preview'))add('scroll',{tag:e.target.tagName,cls:e.target.className})},true);
    new MutationObserver(ms=>{for(const m of ms){if(m.target.classList?.contains('dispatch-tasks')||m.target.classList?.contains('dispatch-docs'))add('list-render',{cls:m.target.className,added:m.addedNodes.length,removed:m.removedNodes.length});for(const n of m.removedNodes){if(n.classList?.contains('dispatch-linked-preview'))add('preview-removed',{focus:document.activeElement?.tagName})}}}).observe(document.body,{childList:true,subtree:true});
  })()`);
  const errors = [], consoleMessages = [], checks = [];
  ui.cdp.on('Runtime.exceptionThrown', e => errors.push(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text));
  ui.cdp.on('Runtime.consoleAPICalled', e => { if (e.type === 'error' || e.type === 'warning') consoleMessages.push({ level: e.type, text: e.args.map(a => a.value ?? a.description ?? '').join(' ') }); });
  const card = `.dispatch-task-card[data-task-id="${task}"]`;
  const delivery = `${card} .dispatch-task-deliverable[data-deliverable=${JSON.stringify('file ' + file)}]`;
  const doc = `.dispatch-docs-row[data-doc-path=${JSON.stringify(file)}]`;
  await ui.openTab('Tasks');
  await ui.click({ css: '.dispatch-tasks-scope [role="tab"]', index: 1 });
  await ui.waitFor({ css: card }, { timeoutMs: 30000 });
  await paneWidth(ui, 420);
  // Let the startup Files view finish attaching before checking the side pane's settled layout.
  await ui.openTab('Docs');
  await ui.openTab('Tasks');
  await ui.waitFor({ css: card });

  for (const color of ['light', 'dark']) {
    await theme(ui, color);
    await ui.openTab('Tasks');
    await ui.waitFor({ css: card }, { timeoutMs: 30000 });
    if (await ui.exists({ css: `${card}:not(.open) .dispatch-task-caret` })) await ui.click({ css: `${card} .dispatch-task-caret` });
    await away(ui);
    await ui.sleep(400);
    const before = await ui.eval(`JSON.stringify([...document.querySelectorAll('.dispatch-task-card')].map(e => { const r=e.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; }))`);
    await capture(ui, `tasks-${color}-before`);
    await ui.hover({ css: delivery });
    await ui.waitFor({ css: preview }, { timeoutMs: 30000 });
    await expect(ui, checks, `${color}: task, delivery and Docs route`, `document.querySelector(${JSON.stringify(card)}).classList.contains('dispatch-linked') && document.querySelectorAll(${JSON.stringify(`${card} .dispatch-linked`)}).length >= 2 && ${linkedTab('Docs')}`);
    await expect(ui, checks, `${color}: document excerpt`, `document.querySelector('${preview}').innerText.includes('The Projects page counts open tasks per project.')`);
    await expect(ui, checks, `${color}: Tasks stays selected`, selectedTab('Tasks'));
    await expect(ui, checks, `${color}: no task layout shift`, `JSON.stringify([...document.querySelectorAll('.dispatch-task-card')].map(e => { const r=e.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; })) === ${JSON.stringify(before)}`);
    await capture(ui, `tasks-${color}-hover`);
    await away(ui);
    await expect(ui, checks, `${color}: task leave clears everything`, `!document.querySelector('.dispatch-linked-preview,.dispatch-linked,.dispatch-linked-tab')`);
    await capture(ui, `tasks-${color}-after`);
    // Use keyboard focus for the long polling check, while the physical pointer remains free.
    await away(ui);
    await ui.click({ css: '.dispatch-tasks-scope [role="tab"]', index: 1 });
    for (let i = 0; i < 24; i++) {
      await ui.press('Tab');
      if (await ui.eval(`document.activeElement?.matches(${JSON.stringify(card)})`)) break;
    }
    await ui.waitFor({ css: preview }, { timeoutMs: 35000 });
    cli(ui, ['task', 'plan', task, '--active', '3']);
    await ui.sleep(14000);
    await expect(ui, checks, `${color}: task refresh keeps the focused source and summary`, `!!document.querySelector('${preview}') && ${linkedTab('Docs')} && document.activeElement?.matches(${JSON.stringify(card)})`);
    cli(ui, ['task', 'plan', task, '--active', '2']);
    await ui.press('Escape');
    await away(ui);
    // Enter the floating summary by a real pointer move and open the original document.
    await ui.click({ css: '.dispatch-tasks-scope [role="tab"]', index: 1 });
    await ui.hover({ css: delivery });
    await ui.waitFor({ css: `${preview} button` }, { timeoutMs: 35000 });
    await ui.hover({ css: `${preview} button` });
    await ui.sleep(300);
    await ui.click({ css: `${preview} button` });
    await ui.waitFor({ css: '.dispatch-docs-md' }, { timeoutMs: 35000 });
    await expect(ui, checks, `${color}: click opens matching document`, `document.querySelector('.dispatch-docs-md').innerText.includes('The Projects page counts open tasks per project.')`);
    await ui.click({ css: '.dispatch-docs-back' });
    await ui.waitFor({ css: doc });
    await expect(ui, checks, `${color}: returning to Docs clears reader state`, `!document.querySelector('.dispatch-docs.reading')`);
    await away(ui);
    await capture(ui, `docs-${color}-before`);
    await ui.hover({ css: doc });
    await ui.waitFor({ css: preview }, { timeoutMs: 35000 });
    await expect(ui, checks, `${color}: document and Tasks route`, `document.querySelector(${JSON.stringify(doc)}).classList.contains('dispatch-linked') && ${linkedTab('Tasks')}`);
    await expect(ui, checks, `${color}: source task summary`, `document.querySelector('${preview}').innerText.includes('Add a Knowledge page') && document.querySelector('${preview}').innerText.includes('1 of 3 steps done · Draw the page')`);
    await expect(ui, checks, `${color}: Docs stays selected`, selectedTab('Docs'));
    await capture(ui, `docs-${color}-hover`);
    // The plan is open when the card appears; the frame does not move when it closes or opens: same top and bottom edges, same Show button.
    await expect(ui, checks, `${color}: the card appears with the plan open`, `document.querySelector('${preview} .dispatch-linked-plan-toggle').getAttribute('aria-expanded') === 'true' && !document.querySelector('${preview} .dispatch-linked-plan').hidden`);
    const frameOf = () => ui.eval(`(() => { const p = document.querySelector('${preview}').getBoundingClientRect(), b = document.querySelector('${preview} .dispatch-linked-open').getBoundingClientRect(); return JSON.stringify([p.top, p.bottom, p.left, p.right, b.top, b.bottom]); })()`);
    const frameOpen = await frameOf();
    await ui.hover({ css: `${preview} .dispatch-linked-plan-toggle` });
    await ui.click({ css: `${preview} .dispatch-linked-plan-toggle` });
    await expect(ui, checks, `${color}: plan closes`, `document.querySelector('${preview} .dispatch-linked-plan-toggle').getAttribute('aria-expanded') === 'false'`);
    if (await frameOf() !== frameOpen) throw new Error(`${color}: the hover card frame moved when the plan closed`);
    checks.push(`${color}: hover card top and bottom unchanged when the plan closes`);
    await ui.click({ css: `${preview} .dispatch-linked-plan-toggle` });
    if (await frameOf() !== frameOpen) throw new Error(`${color}: the hover card frame moved when the plan opened again`);
    checks.push(`${color}: hover card top and bottom unchanged when the plan opens again`);
    await away(ui);
    await expect(ui, checks, `${color}: doc leave clears everything`, `!document.querySelector('.dispatch-linked-preview,.dispatch-linked,.dispatch-linked-tab')`);
    await capture(ui, `docs-${color}-after`);
    await ui.hover({ css: doc });
    await ui.waitFor({ css: preview }, { timeoutMs: 35000 });
    await ui.press('Escape');
    await expect(ui, checks, `${color}: Esc clears without changing Docs`, `!document.querySelector('.dispatch-linked-preview,.dispatch-linked,.dispatch-linked-tab') && ${selectedTab('Docs')}`);
    // Close the source card so the reverse action must reveal and expand that exact task.
    await ui.openTab('Tasks');
    if (await ui.exists({ css: `${card}.open .dispatch-task-caret` })) await ui.click({ css: `${card} .dispatch-task-caret` });
    await expect(ui, checks, `${color}: source task is closed before reverse navigation`, `!document.querySelector(${JSON.stringify(card)}).classList.contains('open')`);
    await ui.openTab('Docs');
    await ui.waitFor({ css: doc });
    // Reach the row from its preceding group header, without resetting focus to the workbench.
    await away(ui);
    await ui.click({ css: '.dispatch-docs-group-head' });
    await ui.click({ css: '.dispatch-docs-group-head' });
    for (let i = 0; i < 20; i++) {
      await ui.press('Tab');
      if (await ui.eval(`document.activeElement?.matches(${JSON.stringify(doc)})`)) break;
    }
    await expect(ui, checks, `${color}: Tab reached the document`, `document.activeElement?.matches(${JSON.stringify(doc)})`);
    await ui.waitFor({ css: preview }, { timeoutMs: 35000 });
    await ui.press('Tab');
    await expect(ui, checks, `${color}: the plan toggle receives keyboard focus first`, `document.activeElement?.matches('.dispatch-linked-plan-toggle')`);
    await ui.press('Tab');
    await expect(ui, checks, `${color}: summary action receives keyboard focus`, `document.activeElement?.matches('.dispatch-linked-open')`);
    await ui.sleep(15000);
    await expect(ui, checks, `${color}: a late Docs refresh preserves keyboard focus`, `document.activeElement?.matches('.dispatch-linked-open') && !!document.querySelector('${preview}')`);
    await ui.press('Enter');
    await ui.waitFor({ css: `${card}.open` }, { timeoutMs: 25000 });
    await expect(ui, checks, `${color}: reverse click locates exact task`, selectedTab('Tasks'));
    await expect(ui, checks, `${color}: the expanded source task is in view`, `(() => { const b=document.querySelector(${JSON.stringify(card)}).getBoundingClientRect(); const r=document.querySelector('.dispatch-tasks').getBoundingClientRect(); return b.top >= r.top && b.bottom <= r.bottom; })()`);
    await ui.click({ css: '.dispatch-tasks-scope [role="tab"]', index: 1 });
    for (let i = 0; i < 24; i++) {
      await ui.press('Tab');
      if (await ui.eval(`document.activeElement?.matches(${JSON.stringify(card)})`)) break;
    }
    await expect(ui, checks, `${color}: Tab reached the task card`, `document.activeElement?.matches(${JSON.stringify(card)})`);
    await ui.waitFor({ css: preview }, { timeoutMs: 35000 });
    await expect(ui, checks, `${color}: task keyboard focus links Docs`, linkedTab('Docs'));
    await ui.press('Escape');
    await expect(ui, checks, `${color}: task Esc clears without navigation`, `!document.querySelector('.dispatch-linked-preview,.dispatch-linked,.dispatch-linked-tab') && ${selectedTab('Tasks')}`);
    await away(ui);
    await ui.hover({ css: delivery });
    await away(ui);
    await ui.sleep(650);
    await expect(ui, checks, `${color}: no delayed preview after fast leave`, `!document.querySelector('.dispatch-linked-preview,.dispatch-linked,.dispatch-linked-tab')`);
  }
  // Ordinary files still use the existing file hover; they are not registered as Docs.
  const plain = path.join(ui.demoFolder, 'REPORT.json');
  fs.writeFileSync(plain, '{"checks":"passed"}\n');
  cli(ui, ['task', 'deliver', task, '--file', plain]);
  // Delivery notifications can reveal Docs. Restore the pane under test before locating its row.
  await ui.openTab('Tasks');
  await ui.waitFor({ css: card }, { timeoutMs: 30000 });
  if (await ui.exists({ css: `${card}:not(.open) .dispatch-task-caret` })) await ui.click({ css: `${card} .dispatch-task-caret` });
  const plainRow = `${card} .dispatch-task-deliverable[data-deliverable=${JSON.stringify('file '+plain)}]`;
  await ui.waitFor({ css: plainRow }, { timeoutMs: 30000 });
  await ui.hover({ css: plainRow });
  await ui.sleep(1000);
  await expect(ui, checks, 'ordinary file keeps its original hover', `!document.querySelector(${JSON.stringify(plainRow)}).hasAttribute('data-dispatch-linked-target') && !!document.querySelector('.dispatch-text-hover') && !document.querySelector('.dispatch-linked-preview')`);
  await away(ui);

  // audit panels 8, three more: (1) a delivery page with a Where to look picture keeps its snippet card;
  // (2) a real pointer path from the source row to the summary's button reaches and clicks it;
  // (3) a report on the task that is not in Docs says nothing about Docs.
  const pageDir = path.join(ui.demoFolder, 'docs', 'where-page');
  fs.mkdirSync(pageDir, { recursive: true });
  fs.copyFileSync(path.join(ui.out, 'tasks-light-before.png'), path.join(pageDir, 'screen.png'));
  fs.writeFileSync(path.join(pageDir, 'notes.md'), '# Where page\n\n## 在哪\n\n![Screen](screen.png)\n\n1. Task card · right panel · open it\n');
  fs.writeFileSync(path.join(pageDir, '00-where.json'), JSON.stringify({ image: 'screen.png', items: [{ n: 1, box: [40, 80, 400, 160], what: 'Task card', where: 'Right panel', how: 'Open it' }] }));
  const wherePath = path.join(pageDir, 'notes.md');
  cli(ui, ['task', 'deliver', task, '--file', wherePath]);
  const report = path.join(ui.demoFolder, 'REPORT.md');
  fs.writeFileSync(report, '# Check report\n\nAll 12 checks passed on the demo project.\n');
  cli(ui, ['task', 'deliver', task, '--file', report]);
  // `task deliver` puts a .md into Docs; take this one out again (docs rm wants the document id)
  const listed = JSON.parse(cli(ui, ['docs', 'demo', '--all', '--json']));
  const reportDoc = (listed.docs || []).find(d => d.path === report);
  if (reportDoc) cli(ui, ['docs', 'rm', 'demo', reportDoc.id]);
  if ((JSON.parse(cli(ui, ['docs', 'demo', '--json'])).docs || []).some(d => d.path === report)) throw new Error('the report is still in Docs');
  await ui.openTab('Tasks');
  await ui.waitFor({ css: card }, { timeoutMs: 30000 });
  if (await ui.exists({ css: `${card}:not(.open) .dispatch-task-caret` })) await ui.click({ css: `${card} .dispatch-task-caret` });
  const whereRow = `${card} .dispatch-task-deliverable[data-deliverable=${JSON.stringify('file ' + wherePath)}]`;
  await ui.waitFor({ css: whereRow }, { timeoutMs: 40000 });
  await ui.hover({ css: whereRow });
  await ui.waitFor({ css: '.dispatch-where-snippet' }, { timeoutMs: 15000 });
  await expect(ui, checks, 'a delivery with a Where picture keeps its snippet card, no summary over it', `!!document.querySelector('.dispatch-where-snippet') && !document.querySelector('.dispatch-linked-preview')`);
  // the snippet carries the picture itself (zoomed to spot 1), not only its lines
  const pictured = `[...document.querySelectorAll('.dispatch-where-snippet img')].some(i => i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().width > 40)`;
  for (let i = 0; i < 40 && !(await ui.eval(pictured)); i++) await ui.sleep(250);
  await expect(ui, checks, 'the row\'s Where snippet shows the picture', pictured);
  await capture(ui, 'where-snippet');
  await away(ui);
  await ui.sleep(800);
  // the same snippet, with its picture, from the Where icon on the card's second line
  const whereIcon = `${card} .dispatch-task-deliverable-icon.where[data-deliverable=${JSON.stringify('file ' + wherePath)}]`;
  await ui.waitFor({ css: whereIcon }, { timeoutMs: 20000 });
  await ui.hover({ css: whereIcon });
  await ui.waitFor({ css: '.dispatch-where-snippet' }, { timeoutMs: 15000 });
  for (let i = 0; i < 40 && !(await ui.eval(pictured)); i++) await ui.sleep(250);
  await expect(ui, checks, 'the Where icon\'s snippet shows the picture, no summary over it', `${pictured} && !document.querySelector('.dispatch-linked-preview')`);
  await capture(ui, 'where-icon-snippet');
  await away(ui);
  await ui.sleep(800);
  // (2) the pointer walks from the row to the summary's button, 16 steps, and clicks it
  await ui.hover({ css: delivery });
  await ui.waitFor({ css: `${preview} .dispatch-linked-open` }, { timeoutMs: 35000 });
  const path2 = await ui.eval(`(() => { const a = document.querySelector(${JSON.stringify(delivery)}).getBoundingClientRect(), b = document.querySelector('${preview} .dispatch-linked-open').getBoundingClientRect(); return { x0: a.x + a.width / 2, y0: a.y + a.height / 2, x1: b.x + b.width / 2, y1: b.y + b.height / 2 }; })()`);
  for (let i = 1; i <= 16; i++) {
    await ui.mouse('mouseMoved', path2.x0 + (path2.x1 - path2.x0) * i / 16, path2.y0 + (path2.y1 - path2.y0) * i / 16);
    await ui.sleep(25);
  }
  await expect(ui, checks, 'a real pointer path keeps the summary open all the way to its button', `!!document.querySelector('${preview} .dispatch-linked-open')`);
  await ui.mouse('mousePressed', path2.x1, path2.y1, { button: 'left', clickCount: 1 });
  await ui.mouse('mouseReleased', path2.x1, path2.y1, { button: 'left', clickCount: 1 });
  await ui.waitFor({ css: '.dispatch-docs-md' }, { timeoutMs: 35000 });
  await expect(ui, checks, 'the button reached by the pointer opens the document', `document.querySelector('.dispatch-docs-md').innerText.includes('The Projects page counts open tasks per project.')`);
  await ui.openTab('Tasks');
  await ui.waitFor({ css: card }, { timeoutMs: 30000 });
  if (await ui.exists({ css: `${card}:not(.open) .dispatch-task-caret` })) await ui.click({ css: `${card} .dispatch-task-caret` });
  await away(ui);
  // (3) the report is not in Docs: its own tip, no Docs heading, no Open in Docs, no Docs tab lit
  const reportRow = `${card} .dispatch-task-deliverable[data-deliverable=${JSON.stringify('file ' + report)}]`;
  await ui.waitFor({ css: reportRow }, { timeoutMs: 30000 });
  await ui.hover({ css: reportRow });
  await ui.sleep(2500);
  await expect(ui, checks, 'a report that is not in Docs does not offer Open in Docs', `!document.body.innerText.includes('Open in Docs') && !document.body.innerText.includes('Docs · Related document') && !${linkedTab('Docs')}`);
  await capture(ui, 'report-not-in-docs');
  await away(ui);
  await expect(ui, checks, 'page identity and content', `/sessions(-dev)?\\.html/.test(location.href) && document.body.innerText.includes('Add a Knowledge page')`);
  if (errors.length) throw new Error(`runtime exceptions: ${errors.join('\n')}`);
  fs.writeFileSync(path.join(ui.out, 'qa.json'), JSON.stringify({ checks, errors, consoleMessages, task, file, browser: 'Browser plugin not available; repository e2e runner', focusEmulation: true, viewport: await ui.eval('({width: innerWidth, height: innerHeight})') }, null, 2));
}
