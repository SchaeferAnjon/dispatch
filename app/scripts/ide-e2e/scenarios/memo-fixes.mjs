// The person's memo of 2026-10-19 (task-h62), the parts a click shows: a project added a moment ago is in the left
// column before its first session; a task is marked done from the Tasks tab and opened again from Done
// (the file-list button: file-list-toggle.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const meta = {
  title: '备忘录修复：左栏新项目、任务点完成',
  description: '新加的项目没有会话也出现在左栏（No sessions yet）；Tasks 页签里卡片上的 ✓ 把任务标完成，Done 里的 ↺ 再打开；Context 卡浮在窗口里、点别处就关；窄的输入框里模型名留着。',
  needs: ['opencode'],
  timeout: 1200,
};

function cli(ui, args) {
  const out = execFileSync(path.join(ui.rec.bin_dir, 'dispatch'), args, { encoding: 'utf8', timeout: 60000 });
  const i = Math.min(...['{', '['].map(c => out.indexOf(c)).filter(x => x >= 0));
  return JSON.parse(out.slice(i));
}

export default async function (ui) {
  const qa = { checks: [], failed: [] };
  const note = () => fs.writeFileSync(path.join(ui.out, 'qa.json'), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
    console.error(`${ok ? 'ok' : 'FAILED'}: ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
    note();
  };
  const until = async (fn, ms, step = 500) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch(() => undefined); if (v) return v; await ui.sleep(step); } return v; };

  await ui.openAgents(ui.demoFolder);
  await ui.closeOverlays();

  // ---- 1 a project added a moment ago is in the left column, before its first session
  // next to the demo project: folders in the system's temp folder never become sidebar projects (sidebar_registry)
  const folder = path.join(path.dirname(ui.demoFolder), 'fresh-proj');
  fs.mkdirSync(folder, { recursive: true });
  cli(ui, ['projects-view', 'add', folder, '--name', 'fresh-proj', '--json']);
  // the window asks for the projects again when the board says so, and whenever the person comes back to the window
  await ui.eval(`document.dispatchEvent(new Event('visibilitychange'))`);
  const sidebar = () => ui.eval(`(() => { const s = document.querySelector('.part.sidebar'); return s ? s.innerText : ''; })()`);
  const shown = await until(async () => { const t = await sidebar(); return /fresh-proj/.test(t) ? t : undefined; }, 60000);
  check('the new project is in the left column', !!shown);
  check('it says it has no session yet', !!shown && /No sessions yet/.test(shown));
  await ui.screenshot('01-new-project-in-sidebar');
  await ui.mark({ text: 'fresh-proj', exact: true, within: '.part.sidebar' }, { what: '刚加的项目', where: '左栏 Projects 下', how: '加完项目就在，不用先开会话' });

  // ---- 2 Tasks tab: ✓ marks a task done, ↺ in Done opens it again
  await ui.newSession(ui.demoFolder);
  await ui.openTab('Tasks');
  const project = (ui.rec.seed && ui.rec.seed.project) || 'demo';
  await ui.waitFor({ text: 'This session', within: '.dispatch-tasks' }, { timeoutMs: 20000 });
  await ui.click({ text: project, exact: true, within: '.dispatch-tasks' });
  await ui.waitFor({ css: '.dispatch-task-card[data-task-id]' }, { timeoutMs: 20000 });
  const card = await ui.eval(`(() => { const c = document.querySelector('.dispatch-task-card[data-task-id]'); return c ? { id: c.dataset.taskId, title: c.querySelector('.dispatch-task-title')?.textContent || '' } : null; })()`);
  check('an open task card is there', !!card, card);
  if (card) {
    const cardCss = `.dispatch-task-card[data-task-id="${card.id}"]`;
    await ui.hover({ css: cardCss });
    await ui.sleep(300);
    check('hovering a card shows Mark done', await ui.eval(`(() => { const b = document.querySelector('${cardCss} .dispatch-task-check'); return !!b && getComputedStyle(b).opacity === '1' && b.getAttribute('aria-label') === 'Mark done'; })()`));
    await ui.screenshot('02-mark-done-on-hover');
    await ui.mark({ css: `${cardCss} .dispatch-task-check` }, { what: 'Mark done', where: 'Tasks 页签里任务卡片右上角，悬停出现', how: '点 ✓ 任务就完成，移到 Done 里' });
    await ui.click({ css: `${cardCss} .dispatch-task-check` });
    const done = await until(async () => {
      const state = await ui.eval(`(() => ({ card: !!document.querySelector('${cardCss}'), row: !!document.querySelector('.dispatch-task-row[data-task-id="${card.id}"]'), folded: [...document.querySelectorAll('.dispatch-task-group-head')].some(h => h.getAttribute('aria-expanded') === 'false') }))()`);
      if (!state.card && !state.row && state.folded) { await ui.click({ css: '.dispatch-task-group-head[aria-expanded="false"]' }); return undefined; }
      return !state.card && state.row ? state : undefined;
    }, 20000);
    check('after ✓ the task is in Done', !!done, done);
    const status = cli(ui, ['task', 'show', card.id, '--json']);
    check('the board has it closed', /closed|done/i.test(String(status.status || status.state || '')), { status: status.status || status.state });
    await ui.screenshot('03-in-done');
    const rowCss = `.dispatch-task-row[data-task-id="${card.id}"]`;
    if (done) {
      await ui.hover({ css: rowCss });
      await ui.sleep(300);
      await ui.click({ css: `${rowCss} .dispatch-task-check` });
      const back = await until(async () => (await ui.eval(`!!document.querySelector('${cardCss}')`)) || undefined, 20000);
      check('↺ Open again brings the card back', !!back);
    }
  }

  // ---- 2b the project page: a task's circle is a checkbox (memo: "tasks need to be completable right on this page")
  await ui.click({ text: 'Projects', exact: true, within: '.part.sidebar' });
  await ui.waitFor({ text: project, exact: true, within: '.dispatch-projects-page' }, { timeoutMs: 20000 });
  await ui.click({ text: project, exact: true, within: '.dispatch-projects-page' });
  const circle = await until(async () => (await ui.eval(`(() => { const r = document.querySelector('.dispatch-project-item .dispatch-project-item-check'); return r ? r.closest('.dispatch-project-item').querySelector('.dispatch-project-item-title').textContent : ''; })()`)) || undefined, 20000);
  check('the project page lists tasks with a circle to tick', !!circle, circle);
  if (circle) {
    await ui.hover({ css: '.dispatch-project-item .dispatch-project-item-check' });
    await ui.sleep(300);
    await ui.screenshot('03b-project-page-check');
    await ui.mark({ css: '.dispatch-project-item .dispatch-project-item-check' }, { what: '任务前的圆圈', where: '项目页 Tasks 里每一行前面', how: '悬停变成 ✓，点一下任务完成' });
    await ui.click({ css: '.dispatch-project-item .dispatch-project-item-check' });
    const gone = await until(async () => (await ui.eval(`![...document.querySelectorAll('.dispatch-project-item-title')].some(e => e.textContent === ${JSON.stringify(circle)} && !e.closest('.dispatch-project-item.done'))`)) || undefined, 20000);
    check('a click on the circle closes the task (crossed out, then gone from the open tasks)', !!gone);
    const open = cli(ui, ['task', 'list', '--project', project, '--status', 'open', '--json']).tasks.map(t => t.title);
    check('the board no longer has it open', !open.includes(circle), open);
  }

  // ---- 3 one short turn (OpenCode's cheap test model): the Context card, and the model's name on a narrow input
  // a file another session (or the person) left uncommitted in the project folder before this session started
  fs.writeFileSync(path.join(ui.demoFolder, 'left-by-someone.txt'), 'not this session\n');
  await ui.newSession(ui.demoFolder);
  await ui.pickEngine('OpenCode', 240000);
  await ui.pickCheapModel();
  await ui.click({ css: '.sessions-chat-editor' });
  await ui.type('Reply exactly MEMOOK. Do not use any tools.');
  await ui.press('Enter', { send: true });
  await ui.waitFor({ text: 'MEMOOK', within: '.interactive-response' }, { timeoutMs: 360000 });
  // Changes lists this session's own work only (memo 2026-10-21: a new session that said hello listed 17 files)
  // the pill over the message box ("2 Files +3 -0") and, once opened, the Changes tab's list
  const pill = () => ui.eval(`(() => { const t = [...document.querySelectorAll('.interactive-session *')].map(e => (e.innerText || '').trim()).filter(x => /^\\d+ Files?\\b/.test(x)).sort((a, b) => a.length - b.length)[0] || ''; return /^\\d+ Files?/.exec(t)?.[0] || ''; })()`);
  await ui.sleep(4000);
  const pill1 = await pill();
  check('after a reply that changed nothing, there is no changes pill (nothing it did)', pill1 === '', pill1);
  await ui.click({ css: '.interactive-input-part .monaco-editor' });
  await ui.type('Create a file named memo-own.txt in the project folder containing the word hi. Do nothing else.');
  await ui.press('Enter', { send: true });
  const pill2 = await until(async () => {
    const ask = await ui.eval(`[...document.querySelectorAll('.interactive-session button, .chat-confirmation-widget button')].map(b => b.innerText.trim()).find(t => /^(Allow|Allow once|Approve|Continue|Yes)$/i.test(t)) || ''`);
    if (ask) { await ui.click({ text: ask, exact: true, within: '.interactive-session' }); return undefined; }
    return fs.existsSync(path.join(ui.demoFolder, 'memo-own.txt')) ? (await pill()) || undefined : undefined;
  }, 360000, 3000);
  check('the file is really there', fs.existsSync(path.join(ui.demoFolder, 'memo-own.txt')));
  check('the pill counts the one file this session made', pill2 === '1 File', pill2);
  await ui.openTab('Changes');
  await ui.sleep(2500);
  const list = await ui.eval(`(document.querySelector('.part.editor')?.innerText || '')`);
  check('Changes lists the file this session made, not the one left before it', /memo-own\.txt/.test(list) && !/left-by-someone\.txt/.test(list), list.slice(0, 300));
  await ui.screenshot('04b-changes-own-only');
  if (await until(async () => (await ui.exists({ css: '.dispatch-life-context' })) || undefined, 30000)) {
    // the breakdown comes from Claude Code after each turn (dispatchContextUsage.ts); tests run OpenCode, so the same
    // file Claude's agent host writes is put there for this session, with the rows /context gives
    const live = JSON.parse(execFileSync(path.join(ui.rec.bin_dir, 'dispatch'), ['sessions', '--json'], { encoding: 'utf8', timeout: 60000 }));
    const mine = live.find(r => r.agent === 'opencode' && r.source === 'ide') || live.find(r => r.agent === 'opencode');
    check('the OpenCode session is listed', !!mine, live.map(r => [r.agent, r.session_id, r.source]));
    if (mine) {
      const dir = path.join(ui.rec.dispatch_dir, 'context-usage');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${mine.session_id}.json`), JSON.stringify({ total: 92000, max: 200000, model: 'test', categories: [
        { name: 'System prompt', tokens: 3000 }, { name: 'System tools', tokens: 14000 }, { name: 'MCP tools', tokens: 9000 },
        { name: 'MCP tools (deferred)', tokens: 30000, deferred: true }, { name: 'Memory files', tokens: 6000 }, { name: 'Skills', tokens: 4000 },
        { name: 'Messages', tokens: 56000 }, { name: 'Free space', tokens: 75000 }, { name: 'Autocompact buffer', tokens: 33000 }] }));
    }
    await ui.sleep(12000); // the entry reads again every 10 s
    await ui.click({ css: '.dispatch-life-context' });
    await ui.waitFor({ css: '.dispatch-life-detail:not([hidden])' });
    const card = await ui.eval(`(() => {
      const e = document.querySelector('.dispatch-life-detail:not([hidden])'); const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      const wb = getComputedStyle(document.querySelector('.monaco-workbench'));
      return { inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, overInput: !e.closest('.interactive-input-part'),
        inWorkbench: !!e.closest('.monaco-workbench'), bg: cs.backgroundColor, font: cs.fontFamily, workbenchFont: wb.fontFamily,
        cells: e.querySelectorAll('.dispatch-life-cell').length, coloredCells: [...e.querySelectorAll('.dispatch-life-cell')].filter(c => getComputedStyle(c).backgroundColor !== 'rgba(0, 0, 0, 0)').length,
        legend: [...e.querySelectorAll('.dispatch-life-row')].map(x => x.innerText.replace(/\\s+/g, ' ').trim()),
        total: e.querySelector('.dispatch-life-total')?.textContent || '', r: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }; })()`);
    qa.card = card;
    check('the Context card is inside the window, over the page (not inside the input)', card.inside && card.overInput, card.r);
    check('the card has the theme: inside the workbench, a solid background, the window\'s font', card.inWorkbench && card.bg !== 'rgba(0, 0, 0, 0)' && card.font === card.workbenchFont && !/times/i.test(card.font), { bg: card.bg, font: card.font });
    check('a grid of 100 squares, one per percent of the window', card.cells === 100, card.cells);
    check('the legend has skills, MCP, conversation and system with tokens and percent', ['Skills 4.0k 2%', 'MCP tools 9.0k 4.5%', 'Conversation 56.0k 28%', 'System and tools 23.0k 11.5%'].every(t => card.legend.includes(t)), card.legend);
    check('the head says how much is used', /92\.0k of 200k tokens · 46%/.test(card.total), card.total);
    await ui.screenshot('04-context-card');
    await ui.mark({ css: '.dispatch-life-detail:not([hidden])' }, { what: 'Context 卡', where: '输入框右下 Context 点开', how: '方格图一格是窗口的 1%，右边是 Skills、MCP、对话、系统各占多少' });
    await ui.click({ css: '.interactive-session .interactive-list' });
    check('a click elsewhere closes it', await until(async () => (await ui.eval(`!document.querySelector('.dispatch-life-detail:not([hidden])')`)) || undefined, 3000));
  } else {
    check('the Context entry is under the input', false);
  }
  // the agent's chip keeps its icon, the model's chip is its name only (memo item 12)
  const icons = await ui.eval(`(() => { const p = document.querySelector('.interactive-input-part .model-picker-split'); return { model: p ? p.querySelectorAll('.codicon').length - p.querySelectorAll('.codicon-chevron-down, .codicon-settings-gear, .codicon-settings').length : -1, text: p ? p.innerText.trim() : '' }; })()`);
  check('the model chip shows its name without an icon', icons.model === 0 && icons.text.length > 0, icons);
  // narrow: the agent and mode chips go to icons first, the model keeps its name
  await ui.cdp.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 882, deviceScaleFactor: 0, mobile: false });
  await ui.sleep(1500);
  const model = await ui.eval(`(() => { const c = document.querySelector('.interactive-input-part .model-picker-split, .interactive-input-part .chat-input-picker-item'); const l = document.querySelector('.interactive-input-part .model-picker-split .chat-input-picker-label'); return { label: l ? l.textContent : '', shown: !!l && l.getBoundingClientRect().width > 0, compact: document.querySelectorAll('.interactive-input-part .compact-picker').length }; })()`);
  check('on a narrow input the model chip still shows the model name', model.shown && model.label.length > 0, model);
  await ui.screenshot('05-narrow-input');
  await ui.cdp.send('Emulation.clearDeviceMetricsOverride');

  // ---- 4 Settings › Skills: Built-in lists the app's own skills once (a fresh Mac showed 98: one copy per engine)
  await ui.openCustomizations('Skills');
  await ui.scrollTo('Built-in');
  const skills = await ui.eval(`(() => { const t = document.querySelector('.dispatch-settings-page')?.innerText || ''; const m = /Built-in\\s*(\\d+)/.exec(t); const synced = (t.match(/^\\s*\\d{6,}:[a-z-]+/gm) || []).length; return { builtIn: m ? Number(m[1]) : null, synced }; })()`);
  const plugins = path.join(path.dirname(ui.rec.bin_dir), 'agent-plugins');
  skills.syncedCopiesOnDisk = fs.existsSync(plugins) ? fs.readdirSync(plugins).filter(n => n.startsWith('vscode-synced-customization')).length : 0;
  check('Built-in counts each built-in skill once, and no engine copies (a number:name row) are listed', skills.builtIn !== null && skills.builtIn <= 20 && skills.synced === 0, skills);
  await ui.screenshot('06-skills-built-in');

  // ---- 5 Settings › Agents: "Use other apps without asking" (memo item 18), the switch writes what the CLI reads
  if (!(await ui.exists({ css: '.part.sidebar.dispatch-settings-open .dispatch-settings-nav', webview: false }))) await ui.press('Cmd+,');
  await ui.waitFor({ css: '.dispatch-settings-nav .dsn-row[data-page="agents"]' }, { timeoutMs: 20000 });
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="agents"]', webview: false });
  await ui.waitFor({ text: 'Use other apps without asking', within: '.dispatch-settings-page' }, { timeoutMs: 20000 });
  await ui.scrollTo('Use other apps without asking');
  const allNow = () => JSON.parse(execFileSync(path.join(ui.rec.bin_dir, 'dispatch'), ['computer', 'allowed', '--json'], { encoding: 'utf8', timeout: 60000 }).trim().split('\n').pop()).all;
  check('the switch starts off', allNow() === false);
  const tagSwitch = () => ui.eval(`(() => { const t = [...document.querySelectorAll('.dispatch-settings-page .dset-row')].find(r => /Use other apps without asking/.test(r.innerText)); const c = t && t.querySelector('.monaco-custom-toggle, input[type=checkbox], [role=checkbox], [role=switch]'); if (!c) return ''; c.setAttribute('data-memo', 'computer-all'); return '[data-memo="computer-all"]'; })()`);
  const swCss = await tagSwitch();
  check('the switch is on the page', !!swCss);
  if (swCss) {
    await ui.screenshot('07-other-apps-switch');
    await ui.mark({ css: swCss }, { what: 'Use other apps without asking', where: '设置 › Agents，What agents may do on their own 下面', how: '打开后 Agent 用任何 App 都不再弹询问窗口' });
    await ui.click({ css: swCss });
    check('turning it on is saved', !!(await until(async () => allNow() === true || undefined, 10000)));
    await ui.sleep(500);
    await tagSwitch(); // the page draws the switch again once it is saved
    await ui.click({ css: swCss });
    check('turning it off again is saved', !!(await until(async () => allNow() === false || undefined, 10000)));
  }

  if (qa.failed.length) throw new Error(`${qa.failed.length} checks failed: ${qa.failed.join('; ')}`);
}
