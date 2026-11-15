// The Docs list survives its own refreshes: scroll position and folded groups stay when a delivery
// arrives while the tab is elsewhere or a reader is open and you come back with ‹ Docs, and an Esc that
// cleared a hover card stays cleared while the list rebuilds its rows under a resting pointer.
// Real pointer and keyboard on the instance's demo project; no engine messages.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const meta = { title: 'Docs 列表刷新不丢滚动、折叠和 Esc', description: '交付在别的页签或阅读页开着时进来，回 ‹ Docs 后滚动位置和折叠的组都在；Esc 清掉悬停卡后列表重建行，指针不动时卡片不重现。' };

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

async function away(ui) {
  // the card now opens left of the right panel, over the middle: leave through the title bar, and wait out the
  // card's grace period (VS Code-like, 400 ms)
  const r = await ui.eval(`({ x: Math.round(innerWidth / 2), y: 8 })`);
  await ui.mouse('mouseMoved', r.x, r.y);
  await ui.sleep(700);
}

export default async function(ui) {
  const task = ui.rec.seed.tasks.in_progress;
  const folder = ui.demoFolder;
  const notes = path.join(folder, 'NOTES.md');
  const checks = [];
  const expect = async (name, expression) => {
    const value = await ui.eval(expression);
    if (!value) throw new Error(`${name}: ${JSON.stringify(value)}`);
    checks.push(name);
    return value;
  };
  cli(ui, ['task', 'deliver', task, '--file', notes]);
  await ui.openAgents(folder);
  await ui.newSession();
  await ui.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await ui.openTab('Docs');
  await ui.waitFor({ css: '.dispatch-docs-scope [role="tab"]' }, { timeoutMs: 60000 });
  if (await ui.eval(`document.querySelector('.dispatch-docs-scope [role="tab"][aria-selected="true"]')?.textContent === 'This session'`)) await ui.click({ text: 'demo', exact: true, within: '.dispatch-docs-scope' });
  await expect('the project scope is on', `document.querySelectorAll('.dispatch-docs-scope [role="tab"]')[1]?.getAttribute('aria-selected') === 'true'`);
  const doc = `.dispatch-docs-row[data-doc-path=${JSON.stringify(notes)}]`;
  const preview = '.dispatch-linked-preview';
  await ui.waitFor({ css: doc }, { timeoutMs: 60000 });

  // Esc clears the hover card; rows rebuilt under the resting pointer stay quiet.
  await away(ui);
  await ui.hover({ css: doc });
  await ui.waitFor({ css: `${preview}:not(.loading)` }, { timeoutMs: 35000 });
  await ui.eval(`(() => { window.__rebuilt = 0; const list = document.querySelector('.dispatch-docs-list'); window.__rowObs = new MutationObserver(ms => { for (const m of ms) for (const n of m.removedNodes) if (n.nodeType === 1 && n.querySelector?.('.dispatch-docs-row, .dispatch-docs-group') || n.classList?.contains('dispatch-docs-list')) window.__rebuilt++; }); window.__rowObs.observe(document.querySelector('.dispatch-docs') || document.body, { childList: true, subtree: true }); window.__quiet = []; window.__quietObs = new MutationObserver(() => { if (document.querySelector('.dispatch-linked-preview,.dispatch-linked')) window.__quiet.push(Date.now()); }); window.__quietObs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }); })()`);
  await ui.press('Escape');
  await expect('Esc clears the hover card', `!document.querySelector('.dispatch-linked-preview,.dispatch-linked,.dispatch-linked-tab')`);
  // Make the Docs tab rebuild its rows now and then: a git commit in the project moves the session's workspace state.
  for (let i = 0; i < 40; i++) {
    if (i % 8 === 0) spawnSync('git', ['-C', folder, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '--allow-empty', '-qm', `e2e ${i}`]);
    await ui.sleep(500);
    const now = await ui.eval(`({ n: window.__quiet.length, rebuilt: window.__rebuilt, gone: !document.querySelector('.dispatch-linked-preview,.dispatch-linked,.dispatch-linked-tab') })`);
    if (!now.gone) throw new Error(`the hover card came back after Esc with the pointer at rest (rebuilt rows so far: ${now.rebuilt})`);
  }
  const rebuilt = await ui.eval('window.__rebuilt');
  fs.writeFileSync(path.join(ui.out, 'esc-rebuilds.json'), JSON.stringify({ rebuilt }, null, 2));
  checks.push(`Esc stays cleared for 20 s at rest (${rebuilt} list rebuilds seen)`);
  // The pointer really moving away and back is a new hover.
  await away(ui);
  await ui.hover({ css: doc });
  await ui.waitFor({ css: `${preview}:not(.loading)` }, { timeoutMs: 35000 });
  checks.push('a new hover after leaving works again');
  await away(ui);

  // Many deliveries: the list scrolls; fold Delivered, scroll, and deliver another one while Docs is not the visible tab.
  const dir = path.join(folder, 'docs-race');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 45; i++) {
    const file = path.join(dir, `doc-${String(i).padStart(2, '0')}.md`);
    fs.writeFileSync(file, `# Refresh race ${i}\n\nDocument ${i} for the Docs refresh scenario.\n`);
    cli(ui, ['task', 'deliver', task, '--file', file]);
  }
  await ui.openTab('Tasks');
  await ui.openTab('Docs');
  await ui.waitFor({ css: '.dispatch-docs-group-head' }, { timeoutMs: 30000 });
  // The deliveries above reach the list with the next refresh.
  await ui.sleep(10000); // let the deliveries' own CLI calls finish before the list asks again
  for (let i = 0; i < 20 && !(await ui.exists({ css: '.dispatch-docs-more' })); i++) {
    await ui.openTab('Tasks');
    await ui.openTab('Docs');
    await ui.sleep(8000);
  }
  for (let i = 0; i < 6; i++) {
    if (!(await ui.exists({ css: '.dispatch-docs-more' }))) break;
    await ui.eval(`document.querySelector('.dispatch-docs-more').scrollIntoView({ block: 'center' })`);
    await ui.click({ css: '.dispatch-docs-more' });
    await ui.sleep(250);
  }
  const groups = await ui.eval(`[...document.querySelectorAll('.dispatch-docs-group-head .name')].map(e => e.textContent)`);
  const room = await ui.eval(`(() => { const l = document.querySelector('.dispatch-docs-list'); return l.scrollHeight - l.clientHeight; })()`);
  if (room < 60) throw new Error(`the list is too short to scroll (${room}), groups ${JSON.stringify(groups)}, ${JSON.stringify(await ui.eval(`document.querySelector('.dispatch-docs')?.innerText.slice(0, 500)`))}`);
  // With a second group, fold it: the fold must survive too (one group only: nothing to fold, the scroll is the test).
  if (groups.length > 1) await ui.click({ css: '.dispatch-docs-list > section.dispatch-docs-group:nth-of-type(2) .dispatch-docs-group-head' });
  const room2 = await ui.eval(`(() => { const l = document.querySelector('.dispatch-docs-list'); return l.scrollHeight - l.clientHeight; })()`);
  const at = Math.min(300, Math.floor(room2 / 2));
  if (at < 30) throw new Error(`the list is too short to scroll after folding (${room2})`);
  const folded = await ui.eval(`document.querySelectorAll('.dispatch-docs-group.collapsed').length`);
  for (let round = 1; round <= 3; round++) {
    await ui.eval(`document.querySelector('.dispatch-docs-list').scrollTop = ${at}`);
    await ui.sleep(300);
    const before = await ui.eval(`document.querySelector('.dispatch-docs-list').scrollTop`);
    if (!(before > 20)) throw new Error(`round ${round}: the list did not scroll (${before})`);
    // A delivery arrives while another tab is in front: the Docs tab opens it in the reader.
    await ui.openTab('Tasks');
    const file = path.join(dir, `arrive-${round}.md`);
    fs.writeFileSync(file, `# Arrived ${round}\n\nDelivered while the Docs tab was hidden, round ${round}.\n`);
    await ui.cdp.send('Page.bringToFront');
    const shown = JSON.parse(cli(ui, ['task', 'deliver', task, '--file', file, '--show', '--json']));
    if (!shown.shown || !shown.shown.shown) throw new Error(`round ${round}: deliver --show did not open it: ${JSON.stringify(shown.shown)}`);
    await ui.waitFor({ css: '.dispatch-docs-reader' }, { timeoutMs: 45000 });
    // A second one while the reader is open: the list behind it refreshes.
    const second = path.join(dir, `arrive-${round}-b.md`);
    fs.writeFileSync(second, `# Arrived ${round} b\n\nDelivered while a reader was open, round ${round}.\n`);
    cli(ui, ['task', 'deliver', task, '--file', second]);
    await ui.sleep(2500);
    await ui.click({ css: '.dispatch-docs-back' });
    await ui.waitFor({ css: '.dispatch-docs-list' });
    await ui.sleep(800);
    const after = await ui.eval(`document.querySelector('.dispatch-docs-list').scrollTop`);
    if (Math.abs(after - before) > 2) throw new Error(`round ${round}: scroll not kept: ${before} -> ${after}`);
    await expect(`round ${round}: folded groups kept`, `document.querySelectorAll('.dispatch-docs-group.collapsed').length === ${folded}`);
    checks.push(`round ${round}: scroll kept at ${after}`);
  }
  fs.writeFileSync(path.join(ui.out, 'qa.json'), JSON.stringify({ checks, task, groups, at }, null, 2));
}
