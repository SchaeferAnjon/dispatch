// The Docs tab's picker (All ⌄: Today, Deliveries, Designs, Reviews, Notes, All) and the plan circles that read
// done / in progress / not started (kanban task-p6mh). Everything on the instance's own board and demo project.
// On a build without the picker it only takes the "before" pictures, so the same scenario gives both sides.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const meta = {
  title: 'Docs 恢复 All 筛选，计划圆圈分清做完和没做',
  description: 'Docs 列表上方 All 下拉能选 Today、Deliveries、Designs、Reviews、Notes、All，每档里照旧分组；计划的圆圈：做完是实心勾，在做是圈，没开始是淡圈，悬停说人话；dispatch done 把剩下的步勾上。',
};

function env(ui) {
  const rec = ui.rec, out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(VSCODE_|ELECTRON_|CLAUDE_CODE_|DISPATCH_|BEADS_|CODEX_THREAD|CODEX_SESSION)/.test(k) && k !== 'CLAUDECODE') out[k] = v;
  }
  return Object.assign(out, { BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home, DISPATCH_BIN: rec.cli,
    DISPATCH_E2E_INSTANCE: rec.name, PATH: `${path.join(rec.app, 'Contents/Resources/app/tools')}:${process.env.PATH || '/usr/bin:/bin'}` });
}

function cli(ui, args) {
  const r = spawnSync('python3', [ui.rec.cli, ...args], { env: env(ui), encoding: 'utf8', timeout: 180000, cwd: ui.demoFolder });
  if (r.status !== 0) throw new Error(`dispatch ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim().slice(-400) || r.error?.message || `signal ${r.signal}`}`);
  return r.stdout;
}

function bd(ui, args) {
  const tool = ui.resources('tools', 'bd');
  const r = spawnSync(fs.existsSync(tool) ? tool : 'bd', args, { env: env(ui), encoding: 'utf8', timeout: 60000, cwd: path.dirname(ui.rec.beads_dir) });
  if (r.status !== 0) throw new Error(`bd ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim().slice(-400)}`);
  return r.stdout;
}

const taskId = out => (out.match(/\b(task-[a-z0-9]+)\b/) || [])[1];

function write(file, text, daysAgo = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (daysAgo) {
    const t = Date.now() / 1000 - daysAgo * 86400;
    fs.utimesSync(file, t, t);
  }
  return file;
}

async function theme(ui, which) {
  for (const dir of [ui.rec.user_data_dir, ui.rec.agents_user_data_dir]) {
    const f = path.join(dir, 'User', 'settings.json');
    let s = {};
    try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { s = {}; }
    Object.assign(s, { 'window.autoDetectColorScheme': false, 'workbench.colorTheme': which === 'light' ? 'Dispatch Light' : 'Dispatch Dark' });
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(s, null, 2));
  }
  const want = which === 'light' ? 'vs' : 'vs-dark';
  for (let i = 0; i < 40; i++) {
    if (await ui.eval(`document.querySelector('.monaco-workbench').classList.contains(${JSON.stringify(want)})`)) break;
    await ui.sleep(250);
  }
  await ui.sleep(600);
}

async function away(ui) {
  const r = await ui.eval(`({ x: Math.round(innerWidth / 2), y: 8 })`);
  await ui.mouse('mouseMoved', r.x, r.y);
  await ui.sleep(700);
}

/** The side pane (and a card or menu left of it), with numbered boxes for the "where" picture. */
async function capture(ui, name, boxes = {}, within = '') {
  return ui.step('screenshot', name, async step => {
    const clip = await ui.eval(`(() => {
      const el = ${JSON.stringify(within)} ? document.querySelector(${JSON.stringify(within)}) : [...document.querySelectorAll('.part.editor .editor-group-container')].find(e => e.getBoundingClientRect().width > 0 && e.querySelector('.tabs-container'));
      const b = el.getBoundingClientRect();
      const extra = [...document.querySelectorAll('.dispatch-linked-preview, .context-view .monaco-menu, .monaco-hover')].map(e => e.getBoundingClientRect()).filter(r => r.width > 0);
      const x = Math.max(0, Math.min(b.x, ...extra.map(r => r.x - 8)));
      const bottom = Math.min(innerHeight, Math.max(b.y + 640, ...extra.map(r => r.bottom + 8)));
      return { x, y: b.y, width: b.right - x, height: Math.min(bottom, b.bottom) - b.y, scale: 1 };
    })()`);
    const image = await ui.cdp.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
    const file = `${name}.png`;
    const png = Buffer.from(image.data, 'base64');
    fs.writeFileSync(path.join(ui.out, file), png);
    step.shot = file; step.clip = clip; ui.shots.push(file);
    const size = [png.readUInt32BE(16), png.readUInt32BE(20)];
    const sx = size[0] / clip.width, sy = size[1] / clip.height;
    const items = [];
    let n = 0;
    for (const [selector, note] of Object.entries(boxes)) {
      n++;
      const b = await ui.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()`);
      if (b) items.push({ n, box: [(b[0] - clip.x) * sx, (b[1] - clip.y) * sy, b[2] * sx, b[3] * sy], color: 'red', ...note });
    }
    fs.writeFileSync(path.join(ui.out, `${name}.boxes.json`), JSON.stringify({ size, items }, null, 2));
    return file;
  });
}

export default async function (ui) {
  const demo = ui.demoFolder;
  const checks = [], errors = [];
  const results = { checks, before: false };
  const expect = async (name, expression) => {
    if (!(await ui.eval(expression))) {
      fs.writeFileSync(path.join(ui.out, 'failure-state.json'), JSON.stringify(await ui.eval(`({ bar: document.querySelector('.dispatch-docs-bar')?.outerHTML.slice(0, 2000), list: document.querySelector('.dispatch-docs-list')?.innerText.slice(0, 2000), menu: document.querySelector('.context-view')?.innerText, preview: document.querySelector('.dispatch-linked-preview')?.innerText, hover: [...document.querySelectorAll('.monaco-hover')].map(h => h.innerText) })`), null, 2));
      throw new Error(name);
    }
    checks.push(name);
  };

  // ---- a demo project with one doc of each kind, and three tasks whose plans say different things ----
  const delivery = write(path.join(demo, 'design/picker-delivery/impl/index.html'), '<!doctype html><meta name="generator" content="dispatch deliver">\n<title>Docs picker delivery</title><body><h1>Docs picker delivery</h1></body>');
  const proposal = write(path.join(demo, 'design/picker-proposal/README.md'), '# Two ways to list the docs\n\nA proposal from three days ago.\n', 3);
  const review = write(path.join(demo, 'design/picker-review/review.md'), '# Docs list review\n\nA designer review.\n');
  const report = write(path.join(demo, 'design/handoff/reports/picker-report.md'), '# Docs picker worker report\n\nWhat the worker did.\n');
  const decisions = write(path.join(demo, 'design/picker-plan/DECISIONS.md'), '# Docs decisions\n\nDecided four days ago.\n', 4);
  const handoff = write(path.join(demo, 'handoffs/picker-handoff.md'), '# Context handoff: docs picker\n\nWhere the last session stopped.\n');

  const shipped = taskId(cli(ui, ['begin', 'Ship the docs picker for the side pane', '-P', 'demo', '-d', 'Seeded by docs-picker: a plan with a step left open, closed with dispatch done.']));
  cli(ui, ['task', 'plan', shipped, '--set', 'Find the old filter', '--set', 'Bring the picker back', '--set', 'Try it on a test instance', '--done', '1', '--active', '2']);
  cli(ui, ['task', 'deliver', shipped, '--file', delivery]);
  const done = JSON.parse(cli(ui, ['done', shipped, '--reason', 'seeded: merged', '--json']));
  results.done_plan_ticked = done.plan_ticked;
  const old = taskId(cli(ui, ['begin', 'Review the docs list from last week', '-P', 'demo', '-d', 'Seeded by docs-picker: closed without dispatch done, one step never ticked.']));
  cli(ui, ['task', 'plan', old, '--set', 'Read the list', '--set', 'Write the review', '--done', '1']);
  cli(ui, ['docs', 'add', 'demo', review, '--kind', '复审', '--task', old]);
  cli(ui, ['docs', 'add', 'demo', handoff, '--kind', 'handoff', '--task', ui.rec.seed.tasks.in_progress]);
  // the demo project has no session yet, so nothing scans its folder: register what the list should hold
  for (const f of [proposal, report, decisions]) cli(ui, ['docs', 'add', 'demo', f]);
  // the task in progress (Read the wiki ✓, Draw the page now, Wire it to the CLI next) delivered NOTES.md
  cli(ui, ['task', 'deliver', ui.rec.seed.tasks.in_progress, '--file', path.join(demo, 'NOTES.md')]);
  bd(ui, ['close', old, '--reason', 'closed by hand']);

  const list = JSON.parse(cli(ui, ['docs', 'list', '--folder', demo, '--local', '--json']));
  fs.writeFileSync(path.join(ui.out, 'docs-list.json'), JSON.stringify({ counts: list.counts, rows: list.docs.map(d => [d.group, d.today, d.display_title]) }, null, 2));
  const plans = {};
  for (const id of [shipped, old]) plans[id] = (JSON.parse(cli(ui, ['task', 'show', id, '--json'])).plan || []).map(p => p.state);
  results.plans = plans;

  await ui.openAgents(demo);
  await ui.newSession();
  await ui.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  ui.cdp.on('Runtime.exceptionThrown', e => errors.push(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text));
  await theme(ui, 'light');
  await ui.openTab('Docs');
  await ui.waitFor({ css: '.dispatch-docs-group-head' }, { timeoutMs: 120000 });
  // the project, not only this session (the seeded docs belong to no session)
  await ui.click({ css: '.dispatch-docs-scope .dispatch-docs-pill:nth-child(2)' });
  await ui.waitFor({ css: '.dispatch-docs-row' }, { timeoutMs: 120000 });
  await ui.sleep(500);

  const hasPicker = await ui.eval(`!!document.querySelector('.dispatch-docs-filter')`);
  const groups = () => ui.eval(`JSON.stringify([...document.querySelectorAll('.dispatch-docs-group-head')].map(h => h.querySelector('.name').textContent + ' ' + h.querySelector('.cnt').textContent))`);
  const rows = () => ui.eval(`JSON.stringify([...document.querySelectorAll('.dispatch-docs-row .t')].map(t => t.textContent))`);
  const linked = (title) => `[...document.querySelectorAll('.dispatch-docs-row')].find(r => r.querySelector('.t')?.textContent === ${JSON.stringify(title)})`;

  if (!hasPicker) {
    // the build before task-p6mh: the list as it is, and the source task card with its bare "x / y"
    results.before = true;
    results.groups = JSON.parse(await groups());
    results.rows = JSON.parse(await rows());
    await capture(ui, 'before-1-list', { '.dispatch-docs-bar': { what: '列表上方', where: 'Docs 页签顶部', how: '只有 This session / 项目 和 Search，没有筛选' }, '.dispatch-docs-list': { what: '列表', where: '页签正文', how: '只有 Delivered 和 Designs 两组' } });
    await ui.eval(`${linked('Notes')}?.scrollIntoView({ block: 'center' })`);
    await away(ui);
    const notes = await ui.eval(`!!${linked('Notes')}`);
    if (notes) {
      await ui.eval(`(() => { const r = ${linked('Notes')}; r.dataset.pick = '1'; })()`);
      await ui.hover({ css: '.dispatch-docs-row[data-pick="1"]' });
      await ui.waitFor({ css: '.dispatch-linked-preview:not(.loading) .dispatch-linked-plan-toggle' }, { timeoutMs: 35000 });
      results.toggle = await ui.eval(`document.querySelector('.dispatch-linked-plan-toggle').innerText`);
      await capture(ui, 'before-2-plan', { '.dispatch-linked-plan-toggle': { what: '计划进度', where: '源任务卡', how: '只写 1 / 3' }, '.dispatch-linked-plan': { what: '计划的圆圈', where: '进度行下面', how: '勾、箭头、空圈，没有说明' } });
    }
    fs.writeFileSync(path.join(ui.out, 'results.json'), JSON.stringify(results, null, 2));
    return;
  }

  // ---- CLI side: dispatch done ticked the step left open, the hand-closed task kept its open step ----
  if (JSON.stringify(plans[shipped]) !== JSON.stringify(['done', 'done', 'done']) || results.done_plan_ticked !== 2) throw new Error(`dispatch done did not tick the plan: ${JSON.stringify(plans[shipped])} ${results.done_plan_ticked}`);
  checks.push('dispatch done ticked the two steps left open');
  if (JSON.stringify(plans[old]) !== JSON.stringify(['done', 'todo'])) throw new Error(`the hand-closed task's plan changed: ${JSON.stringify(plans[old])}`);
  checks.push('a task closed by hand keeps its plan as it was');

  // ---- the picker: All by default, every group under it ----
  await expect('the picker says All', `document.querySelector('.dispatch-docs-filter').innerText.trim() === 'All'`);
  results.all_groups = JSON.parse(await groups());
  await expect('All lists Delivered, Designs, Reviews, Handoffs and Notes', `(() => { const g = ${await groups()}.map(s => s.replace(/ \\d+$/, '')); return ['Delivered', 'Designs', 'Reviews', 'Handoffs', 'Notes'].every(n => g.includes(n)); })()`);
  await expect('the worker report and the decisions are rows again, under Notes', `(() => { const n = [...document.querySelectorAll('.dispatch-docs-group')].find(s => s.querySelector('.name').textContent === 'Notes'); const t = n ? n.innerText : ''; return t.includes('Docs picker worker report') && t.includes('Docs decisions'); })()`);
  await capture(ui, 'after-1-all', {
    '.dispatch-docs-filter': { what: 'All 筛选', where: 'Docs 页签顶部，项目名右边', how: '点开选 Today、Deliveries、Designs、Reviews、Notes、All' },
    '.dispatch-docs-list': { what: '分组照旧', where: '筛选下面的列表', how: '每档里还是 Delivered、Designs、Reviews、Notes 分组，组头能收起' },
  });

  // the menu: real click, every choice, the shown one checked
  await ui.click({ css: '.dispatch-docs-filter' });
  await ui.waitFor({ css: '.context-view .monaco-menu' }, { timeoutMs: 10000 });
  const menu = JSON.parse(await ui.eval(`JSON.stringify([...document.querySelectorAll('.context-view .action-item')].map(i => ({ label: i.querySelector('.action-label')?.textContent.trim(), checked: !!i.querySelector('[aria-checked="true"]'), disabled: i.classList.contains('disabled') })))`));
  results.menu = menu;
  const labels = menu.map(m => m.label.replace(/\s+\d+$/, ''));
  if (JSON.stringify(labels) !== JSON.stringify(['Today', 'Deliveries', 'Designs', 'Reviews', 'Notes', 'All'])) throw new Error(`menu: ${JSON.stringify(menu)}`);
  checks.push('the menu lists Today, Deliveries, Designs, Reviews, Notes, All');
  if (!menu[5].checked || menu.slice(0, 5).some(m => m.checked)) throw new Error(`checked: ${JSON.stringify(menu)}`);
  checks.push('All is checked');
  await expect('the button says the menu is open', `document.querySelector('.dispatch-docs-filter').getAttribute('aria-expanded') === 'true'`);
  await capture(ui, 'after-2-menu', { '.context-view .monaco-menu': { what: '筛选菜单', where: 'All 按钮下面', how: '当前这档打勾，没有文档的灰掉；条数在各组组头' } });

  // Today: what was delivered or changed today, still in its groups
  await ui.click({ text: 'Today', within: '.context-view' });
  await ui.waitFor({ css: '.dispatch-docs-filter.on' }, { timeoutMs: 10000 });
  await expect('the picker says Today', `document.querySelector('.dispatch-docs-filter').innerText.trim() === 'Today'`);
  const today = JSON.parse(await rows());
  results.today = today;
  if (!today.includes('Docs picker delivery') || !today.includes('Docs list review') || today.includes('Two ways to list the docs') || today.includes('Docs decisions')) throw new Error(`Today: ${JSON.stringify(today)}`);
  checks.push('Today keeps today\'s delivery and review, leaves out the proposal and decisions from days ago');
  await expect('Today keeps the groups', `document.querySelectorAll('.dispatch-docs-group-head').length >= 2`);
  await capture(ui, 'after-3-today', { '.dispatch-docs-filter': { what: 'Today', where: '筛选按钮', how: '选了别的档按钮字变深' }, '.dispatch-docs-list': { what: '今天交付或改过的', where: '列表', how: '照旧分组' } });

  // one group at a time
  for (const [label, group, want, not] of [['Reviews', 'Reviews', 'Docs list review', 'Docs picker delivery'], ['Notes', 'Notes', 'Docs decisions', 'Docs list review'], ['Deliveries', 'Delivered', 'Docs picker delivery', 'Docs decisions'], ['Designs', 'Designs', 'Two ways to list the docs', 'Docs picker delivery']]) {
    await ui.click({ css: '.dispatch-docs-filter' });
    await ui.waitFor({ css: '.context-view .monaco-menu' }, { timeoutMs: 10000 });
    await ui.click({ text: label, within: '.context-view' });
    await ui.sleep(300);
    const shown = JSON.parse(await rows());
    const heads = JSON.parse(await groups()).map(s => s.replace(/ \d+$/, ''));
    if (!shown.includes(want) || shown.includes(not)) throw new Error(`${label}: ${JSON.stringify(shown)}`);
    if (label === 'Notes' ? heads.some(h => !['Handoffs', 'Notes'].includes(h)) : JSON.stringify(heads) !== JSON.stringify([group])) throw new Error(`${label} groups: ${JSON.stringify(heads)}`);
    checks.push(`${label} shows only its own group${label === 'Notes' ? ' (with the handoffs)' : ''}`);
    if (label === 'Reviews') await capture(ui, 'after-4-reviews', { '.dispatch-docs-list': { what: 'Reviews', where: '列表', how: '复审和调研' } });
    if (label === 'Notes') await capture(ui, 'after-5-notes', { '.dispatch-docs-list': { what: 'Notes', where: '列表', how: '定稿、计划、报告、任务书和交接' } });
  }

  // the choice is remembered across the tab going away and coming back
  await ui.openTab('Tasks');
  await ui.openTab('Docs');
  await ui.waitFor({ css: '.dispatch-docs-filter' }, { timeoutMs: 20000 });
  await expect('the choice is kept (Designs)', `document.querySelector('.dispatch-docs-filter').innerText.trim() === 'Designs'`);

  // search stays inside the choice and says so
  await ui.click({ css: '.dispatch-docs-search-box' });
  await ui.waitFor({ css: '.dispatch-docs-search-input' }, { timeoutMs: 10000 });
  await ui.type('worker report', { into: { css: '.dispatch-docs-search-input' } });
  await ui.sleep(300);
  await expect('search in Designs names the choice', `document.querySelector('.dispatch-docs-empty')?.innerText.includes('No docs in Designs match')`);
  await ui.press('Escape');

  // back to All for the rest
  await ui.click({ css: '.dispatch-docs-filter' });
  await ui.waitFor({ css: '.context-view .monaco-menu' }, { timeoutMs: 10000 });
  await ui.click({ text: 'All', within: '.context-view' });
  await ui.sleep(300);
  await expect('back on All', `document.querySelector('.dispatch-docs-filter').innerText.trim() === 'All' && !document.querySelector('.dispatch-docs-filter.on')`);

  // ---- plan circles in the source task card of a Docs row ----
  const circleTip = async (selector, words) => {
    await ui.eval(`document.querySelectorAll('[data-pick]').forEach(e => delete e.dataset.pick)`);
    await ui.hover({ css: selector });
    for (let i = 0; i < 30; i++) {
      const tips = JSON.parse(await ui.eval(`JSON.stringify([...document.querySelectorAll('.monaco-hover')].filter(h => h.getBoundingClientRect().width > 0).map(h => h.innerText))`));
      if (tips.some(t => t.includes(words))) return tips.find(t => t.includes(words));
      await ui.sleep(200);
    }
    throw new Error(`no "${words}" card on ${selector}`);
  };
  const pick = async title => { await ui.eval(`(() => { document.querySelectorAll('[data-pick]').forEach(e => delete e.dataset.pick); ${linked(title)}.dataset.pick = '1'; ${linked(title)}.scrollIntoView({ block: 'center' }); })()`); };
  // the list draws its rows again when the board changes (a delivery, a plan step): a row marked just before that is
  // gone, so mark it again and point at it, as a person points at the row they see now
  const hoverRow = async (title) => {
    for (let i = 0; ; i++) {
      await pick(title);
      await away(ui);
      if (await ui.exists({ css: '.dispatch-docs-row[data-pick="1"]' })) {
        try { await ui.hover({ css: '.dispatch-docs-row[data-pick="1"]' }); return; } catch (e) { if (i >= 5) throw e; }
      } else if (i >= 5) throw new Error(`the row ${title} is not in the Docs list`);
      await ui.sleep(1000);
    }
  };
  const preview = '.dispatch-linked-preview:not(.loading)';
  const states = `JSON.stringify([...document.querySelectorAll('${preview} .dispatch-linked-plan li')].map(li => [li.className, li.querySelector('.codicon')?.className.match(/codicon-[a-z-]+/)?.[0], getComputedStyle(li.querySelector('.dispatch-plan-circle')).opacity]))`;

  for (const color of ['light', 'dark']) {
    await theme(ui, color);
    await ui.openTab('Docs');
    await ui.waitFor({ css: '.dispatch-docs-row' }, { timeoutMs: 20000 });
    // the task in progress, through the NOTES.md delivered for it (the same row the "before" picture hovers)
    await hoverRow('Notes');
    await ui.waitFor({ css: `${preview} .dispatch-linked-plan-toggle` }, { timeoutMs: 35000 });
    await expect(`${color}: progress in words`, `document.querySelector('${preview} .dispatch-linked-plan-toggle').innerText.includes('1 of 3 steps done · Draw the page')`);
    const st = JSON.parse(await ui.eval(states));
    if (JSON.stringify(st) !== JSON.stringify([['done', 'codicon-pass-filled', '1'], ['active', 'codicon-circle-large', '1'], ['todo', 'codicon-circle-large', '1']])) throw new Error(`${color}: circles ${JSON.stringify(st)}`);
    checks.push(`${color}: filled check, ring, ring (DESIGN.md「符号表」)`);
    // the circles' cards, with the real pointer: into the card, onto each circle
    const tips = [];
    for (const [i, words] of [[1, 'This step is finished.'], [2, 'The agent is working on this step now.'], [3, 'The agent has not started this step yet.']]) {
      tips.push(await circleTip(`${preview} .dispatch-linked-plan li:nth-child(${i}) .dispatch-plan-circle`, words));
      await expect(`${color}: the source card stays while a circle's card shows (${i})`, `!!document.querySelector('${preview}')`);
      if (i === 3) await capture(ui, `after-6-circles-${color}`, { [`${preview} .dispatch-linked-plan-toggle`]: { what: '进度说人话', where: '源任务卡', how: '「1 of 3 steps done · 正在做的那步」' }, [`${preview} .dispatch-linked-plan`]: { what: '三种圆圈', where: '进度下面', how: '实心勾做完，圈在做，淡圈没开始' }, '.monaco-hover': { what: '圆圈的说明', where: '指着圆圈', how: '悬停说 Done / In progress / Not started' } });
    }
    results[`tips_${color}`] = tips;
    await ui.press('Escape');
    await away(ui);

    // the task closed by dispatch done: every step ticked, no "step it is on"
    await hoverRow('Docs picker delivery');
    await ui.waitFor({ css: `${preview} .dispatch-linked-plan-toggle` }, { timeoutMs: 35000 });
    await expect(`${color}: a task closed by dispatch done reads 3 of 3`, `document.querySelector('${preview} .dispatch-linked-plan-toggle').innerText.trim() === '3 of 3 steps done' && [...document.querySelectorAll('${preview} .dispatch-linked-plan li')].every(li => li.className === 'done')`);
    if (color === 'light') await capture(ui, 'after-7-done-task', { [`${preview} .dispatch-linked-plan`]: { what: 'dispatch done 之后', where: '源任务卡', how: '剩下的步一起勾上' } });
    await ui.press('Escape');
    await away(ui);

    // the task closed by hand with a step never ticked: that step says "Not done"
    await hoverRow('Docs list review');
    await ui.waitFor({ css: `${preview} .dispatch-linked-plan-toggle` }, { timeoutMs: 35000 });
    await expect(`${color}: a finished task's open step has no "step it is on"`, `document.querySelector('${preview} .dispatch-linked-plan-toggle').innerText.trim() === '1 of 2 steps done'`);
    const notDone = await circleTip(`${preview} .dispatch-linked-plan li:nth-child(2) .dispatch-plan-circle`, 'Not done');
    if (!notDone.includes('The task was finished without ticking this step.')) throw new Error(`${color}: ${notDone}`);
    checks.push(`${color}: a finished task's open step says Not done`);
    if (color === 'light') await capture(ui, 'after-8-not-done', { [`${preview} .dispatch-linked-plan li:nth-child(2)`]: { what: '没勾的步', where: '已完成任务的计划', how: '悬停说 Not done' }, '.monaco-hover': { what: '说明', where: '圆圈旁', how: '' } });
    await ui.press('Escape');
    await away(ui);
  }
  await theme(ui, 'light');

  // ---- the same circles in the Tasks tab and on the task page ----
  await ui.openTab('Tasks');
  await ui.waitFor({ css: '.dispatch-tasks-scope' }, { timeoutMs: 20000 });
  await ui.click({ css: '.dispatch-tasks-scope button:nth-child(2)' });
  const card = `.dispatch-task-card[data-task-id="${ui.rec.seed.tasks.in_progress}"]`;
  await ui.waitFor({ css: card }, { timeoutMs: 20000 });
  const progress = await circleTip(`${card} .dispatch-task-progress`, 'steps done');
  if (!progress.includes('1 of 3 steps done')) throw new Error(`Tasks progress card: ${progress}`);
  checks.push('Tasks card: "1 / 3" says 1 of 3 steps done on hover');
  await away(ui);
  await ui.click({ css: `${card} .dispatch-task-caret` });
  await ui.waitFor({ css: `${card} .dispatch-task-plan li` }, { timeoutMs: 10000 });
  await ui.sleep(400);
  // the task has no session in this window, so the board's In progress is all there is: the step it is on is the green
  // filled circle (DESIGN.md「符号表」), as the task's own mark is
  const tStates = JSON.parse(await ui.eval(`JSON.stringify([...document.querySelectorAll('${card} .dispatch-task-plan li')].map(li => [li.className, li.querySelector('.codicon')?.className.match(/codicon-[a-z-]+/)?.[0], [...li.querySelector('.dispatch-mark').classList].find(c => ['seen', 'now', 'stop', 'todo'].includes(c))]))`));
  if (JSON.stringify(tStates) !== JSON.stringify([['done', 'codicon-pass-filled', 'seen'], ['active', 'codicon-circle-large-filled', 'now'], ['todo', 'codicon-circle-large', 'todo']])) throw new Error(`Tasks circles ${JSON.stringify(tStates)}`);
  checks.push('Tasks card: grey filled check, green filled circle, ring');
  await circleTip(`${card} .dispatch-task-plan li.active .dispatch-plan-circle`, 'In progress');
  checks.push('Tasks card: the ring says In progress');
  await capture(ui, 'after-9-tasks', { [`${card} .dispatch-task-plan`]: { what: 'Tasks 卡的计划', where: '展开的任务卡', how: '同样的三种圆圈，悬停有说明' } });
  await away(ui);

  const doneHead = '.dispatch-task-group-head';
  if (await ui.eval(`document.querySelector('${doneHead}')?.getAttribute('aria-expanded') === 'false'`)) await ui.click({ css: doneHead });
  const oldRow = `.dispatch-task-row[data-task-id="${old}"]`;
  await ui.waitFor({ css: oldRow }, { timeoutMs: 20000 });
  await ui.click({ css: `${oldRow} .dispatch-task-row-title` });
  await ui.waitFor({ css: '.dispatch-task-page-row.step' }, { timeoutMs: 20000 });
  const pStates = JSON.parse(await ui.eval(`JSON.stringify([...document.querySelectorAll('.dispatch-task-page-row.step')].map(r => [r.className.replace('dispatch-task-page-row step ', ''), r.querySelector('.codicon')?.className.match(/codicon-[a-z-]+/)?.[0]]))`));
  if (JSON.stringify(pStates) !== JSON.stringify([['done', 'codicon-pass-filled'], ['todo', 'codicon-circle-large']])) throw new Error(`task page: ${JSON.stringify(pStates)}`);
  checks.push('task page shows the plan as it is (no step painted done)');
  const pageTip = await circleTip('.dispatch-task-page-row.step.todo .dispatch-plan-circle', 'Not done');
  checks.push('task page: the open step of a finished task says Not done');
  results.page_tip = pageTip;
  await capture(ui, 'after-10-task-page', { '.dispatch-task-page-row.step.todo': { what: '任务页的计划', where: '任务页 Plan 一节', how: '照实显示，没勾的写 Not done' } }, '.dispatch-task-page');

  // where-is-what from the list picture
  const all = JSON.parse(fs.readFileSync(path.join(ui.out, 'after-1-all.boxes.json'), 'utf8'));
  const menuBoxes = JSON.parse(fs.readFileSync(path.join(ui.out, 'after-2-menu.boxes.json'), 'utf8'));
  const circles = JSON.parse(fs.readFileSync(path.join(ui.out, 'after-6-circles-light.boxes.json'), 'utf8'));
  let n = 0;
  const items = [...all.items.map(i => ({ ...i, image: 'after-1-all.png', size: all.size })), ...menuBoxes.items.map(i => ({ ...i, image: 'after-2-menu.png', size: menuBoxes.size })), ...circles.items.map(i => ({ ...i, image: 'after-6-circles-light.png', size: circles.size }))].map(i => ({ ...i, n: ++n }));
  fs.writeFileSync(path.join(ui.out, '00-where.json'), JSON.stringify({ image: 'after-1-all.png', items }, null, 2));

  if (errors.length) throw new Error(`runtime exceptions: ${errors.join('\n')}`);
  fs.writeFileSync(path.join(ui.out, 'results.json'), JSON.stringify(results, null, 2));
}
