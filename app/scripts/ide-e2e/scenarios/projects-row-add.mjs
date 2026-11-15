// 10-09 用户（偏好「Projects 悬停加项目」）: the pointer on the side bar's Projects row shows one +, Add Project, where a
// double tick (Mark All as Done, nothing to do on a row without sessions) was. A click goes the way the Projects
// page's Add Project goes: the Add a project dialog, a new project by name, its page. Real hover, real clicks and
// typing; the folder is checked on disk.
// Start the instance with: dispatch ide instance start rowadd --onboarding fresh --agents
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);

export const meta = { instance: { onboarding: 'fresh' }, timeout: 600, title: 'Projects 悬停加项目', description: '左栏 Projects 那一行悬停只出一个 +（Add Project），点了和 Projects 页右上 Add Project 一样：对话框、起名新建、打开项目页。' };

const facts = {};
let OUT = '';
const note = (k, v) => { facts[k] = v; fs.writeFileSync(path.join(OUT, 'facts.json'), JSON.stringify(facts, null, 1)); };
const dialogText = ui => ui.eval(`document.querySelector('.dispatch-ap')?.innerText || ''`);

async function until(ui, fn, what, ms = 20000, every = 300) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await ui.sleep(every);
  }
  throw new Error(`Timed out: ${what}`);
}

/** The side bar row whose label is `label`: its middle, and the toolbar actions that can be seen on it. */
const row = (ui, label) => ui.eval(`(() => {
  const r = [...document.querySelectorAll('.part.sidebar .monaco-list-row')].find(r => r.querySelector('.session-section-label')?.innerText.trim() === ${JSON.stringify(label)});
  if (!r) return null;
  const b = r.getBoundingClientRect();
  const seen = e => { const s = getComputedStyle(e); const q = e.getBoundingClientRect(); return q.width > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const tb = r.querySelector('.session-section-toolbar');
  const actions = tb && seen(tb) ? [...tb.querySelectorAll('.action-label')].filter(seen).map(a => {
    const q = a.getBoundingClientRect();
    return { aria: a.getAttribute('aria-label'), icon: [...a.classList].find(c => c.startsWith('codicon-')) || '', x: Math.round(q.x + q.width / 2), y: Math.round(q.y + q.height / 2) };
  }) : [];
  return { x: Math.round(b.x + 60), y: Math.round(b.y + b.height / 2), actions };
})()`);

export default async function (ui) {
  OUT = ui.out;
  assert.ok(ui.rec.fixture_home, 'Start this instance with --onboarding fresh');
  const home = ui.rec.fixture_home;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: home } }).trim();
  await ui.attach('agents', 60000);
  try { await ui.waitFor('Welcome to Dispatch', { timeoutMs: 60000 }); await ui.press('Escape'); } catch { /* already dismissed */ }
  await ui.sleep(1000);
  await ui.openAgents(ui.demoFolder);
  for (let i = 0; i < 5 && (await ui.exists({ css: 'button.dispatch-tour-close' })); i++) { await ui.click({ css: 'button.dispatch-tour-close' }); await ui.sleep(500); }

  // the pointer away: the row shows no button
  const away = await until(ui, () => row(ui, 'Projects'), 'the Projects row in the side bar', 30000);
  await ui.mouse('mouseMoved', 600, 400);
  await ui.sleep(500);
  note('awayActions', (await row(ui, 'Projects')).actions);
  assert.deepEqual((await row(ui, 'Projects')).actions, [], 'no button on the Projects row until the pointer is on it');

  // the pointer on other rows first (rows are drawn again with another row's toolbar), then on Projects: one +
  for (const other of ['Automations', 'Chats']) {
    const o = await row(ui, other);
    if (o) { await ui.mouse('mouseMoved', o.x, o.y); await ui.sleep(400); }
  }
  await ui.mouse('mouseMoved', away.x, away.y);
  const on = await until(ui, async () => { const r = await row(ui, 'Projects'); return r.actions.length ? r : undefined; }, 'a button on the Projects row under the pointer', 5000);
  note('hoverActions', on.actions);
  assert.deepEqual(on.actions.map(a => [a.aria, a.icon]), [['Add Project', 'codicon-add']], `one + on the Projects row, Add Project: ${JSON.stringify(on.actions)}`);
  assert.ok(!on.actions.some(a => /check-all|Mark All/i.test(a.icon + a.aria)), 'no double tick');

  // the tip of the +
  const plus = on.actions[0];
  await ui.mouse('mouseMoved', plus.x, plus.y);
  const tip = await until(ui, () => ui.eval(`[...document.querySelectorAll('.workbench-hover, .monaco-hover')].filter(h => h.offsetParent || h.getBoundingClientRect().width).map(h => h.innerText.trim()).find(t => t) || ''`), 'the tip of the +', 8000);
  note('tip', tip);
  assert.equal(tip, 'Add Project');
  await ui.screenshot('01-projects-row-hover');
  await ui.mark({ css: '.dispatch-projects-section .session-section-toolbar .action-label' }, { what: 'Projects 那一行悬停：+ Add Project（原来是双勾 Mark All as Done）', where: '左栏 Projects 那一行右边', how: '鼠标放上去出现，点了加项目' });

  // a click: the Add a project dialog of the Projects page
  await ui.mouse('mousePressed', plus.x, plus.y, { clickCount: 1 });
  await ui.mouse('mouseReleased', plus.x, plus.y, { clickCount: 1 });
  await ui.waitFor({ css: '.dispatch-ap' }, { timeoutMs: 15000 });
  await ui.waitFor({ text: 'Choose a folder', exact: true, within: '.dispatch-ap' });
  const first = await dialogText(ui);
  for (const want of ['Add a project', 'Choose a folder', 'Start a new project', 'Copy a project from the internet']) assert.ok(first.includes(want), `${want} in: ${first}`);
  note('behindTheDialog', await ui.eval(`!!document.querySelector('.dispatch-projects-toolbar') ? 'the Projects page' : 'where it was'`));
  await ui.screenshot('02-add-project-dialog');

  // a new project by name, as from the Projects page: the folder, one first commit, its page
  await ui.click({ text: 'Start a new project', exact: true, within: '.dispatch-ap' });
  await ui.waitFor({ css: '.dispatch-ap input[data-field="name"]' });
  await ui.type('Row app', { into: { css: '.dispatch-ap input[data-field="name"]' } });
  for (const [field, value] of [['gitName', 'Fixture Person'], ['gitEmail', 'fixture@example.com']]) {
    if (!(await ui.exists({ css: `.dispatch-ap input[data-field="${field}"]` }))) continue;
    const now = await ui.eval(`document.querySelector('.dispatch-ap input[data-field="${field}"]').value`);
    if (!now) await ui.type(value, { into: { css: `.dispatch-ap input[data-field="${field}"]` } });
  }
  await ui.click({ text: 'Create project', exact: true, within: '.dispatch-ap' });
  await until(ui, async () => !(await ui.exists({ css: '.dispatch-ap' })), 'the dialog closes after Create project', 120000, 1000);
  const made = path.join(home, 'Projects', 'Row app');
  assert.ok(fs.existsSync(path.join(made, '.git')), `${made} is a repository`);
  assert.equal(git(made, 'rev-list', '--count', 'HEAD'), '1', 'one empty first commit');
  await ui.waitFor('Rename Project', { timeoutMs: 120000 });
  assert.ok((await ui.eval('document.body.innerText')).includes('Row app'), 'the new project\'s page');
  note('created', made);
  await ui.screenshot('03-project-page');
}
