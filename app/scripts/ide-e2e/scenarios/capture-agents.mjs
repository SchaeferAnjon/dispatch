// What you type to Claude Code and Codex in Dispatch's own terminal goes on the board by itself, and a task the board
// says is in progress with nobody on it can go back in Next up (task-7u056; design/chat-capture direction B).
//
// The prompt hook is what notes a message typed in the terminal (Dispatch's hook entry hook.py → life_hook.py →
// capture.from_hook). The person's
// installed hooks run the installed app's CLI; this run puts this build's hook in the test instance only: a project
// hook for Claude Code (.claude/settings.json in the demo project), the instance's own hooks.json for Codex (its
// CODEX_HOME, with a copy of config.toml so a trust answer stays in the instance). Claude Code runs on Haiku.
//
//   CAPTURE_STAGES=idle,claude,codex dispatch ide e2e run capture-agents --instance <name> --timeout 1500
//
// Stages (default idle,claude,codex):
//   idle    two tasks in progress in demo whose session is gone and that the board has not heard of for hours: the
//           Tasks tab shows them under "Nobody on it"; Back to Next up puts one at the end of the line, Line them all
//           up the rest
//   claude  ⌘T, Terminal, Claude Code: two things typed to it are noted under that terminal session, in its Tasks tab
//   codex   the same with Codex
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cli, until, offScreen, closeTips, restPointer, receipts, terminalText, typeInTerminal, NEXT_DOM } from './chat-capture-panes.mjs';

export const meta = { needs: ['codex'], env: { CAPTURE_STAGES: 'idle,codex' }, title: 'Terminal agents note what you say; tasks nobody works on go back in line', description: 'Claude Code and Codex in the terminal note your words as Next up; in-progress tasks with nobody on them show under Nobody on it and go back in Next up.', timeout: 1500 };

const SAY = {
  claude: 'Two small things for this project: add a file NOTICE.md that says "Third-party notices", and add a file SUPPORT.md that says "Ask in the issues". Line them up behind your work; reply only with OK and do not use any tools in this turn.',
  codex: 'Two more small things for this project: add a file AUTHORS.md that lists "The demo team", and add a file GOVERNANCE.md that says "Maintainers decide". Line them up behind your work; reply only with OK and do not use any tools in this turn.',
};
const NAMES = { claude: 'Claude Code', codex: 'Codex' };
const META = 4;

function assert(v, m) { if (!v) throw new Error(m); }
const sh = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });

/** The build's own prompt hook for both agents, in the test instance only. */
function hooks(ui) {
  const entry = path.join(path.dirname(ui.rec.cli), 'hook.py');
  // the terminal's login shell sets the person's own BEADS_DIR (~/.zshrc): the hook keeps to the instance's board,
  // as the instance's dispatch command does (write_cli_shim)
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const py = `env BEADS_DIR=${q(ui.rec.beads_dir)} DISPATCH_DIR=${q(ui.rec.dispatch_dir)} DISPATCH_HOME=${q(ui.rec.dispatch_home)} python3`;
  const folder = ui.demoFolder;
  fs.mkdirSync(path.join(folder, '.claude'), { recursive: true });
  const settings = path.join(folder, '.claude', 'settings.json');
  const s = fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings, 'utf8')) : {};
  s.hooks = { ...(s.hooks || {}), UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${py} "${entry}" claude-code # dispatch-hook (e2e)`, timeout: 15 }] }] };
  fs.writeFileSync(settings, JSON.stringify(s, null, 2) + '\n');
  sh(folder, 'add', '.claude/settings.json');
  if (sh(folder, 'diff', '--cached', '--name-only').trim()) sh(folder, 'commit', '-qm', 'chore: the build\'s prompt hook for the e2e run');
  // Codex: the instance's own CODEX_HOME (config.toml copied in place of the link to the person's, the folder trusted)
  const home = ui.rec.fixture_home ? path.join(ui.rec.fixture_home, '.codex') : path.join(ui.rec.root, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const cfg = path.join(home, 'config.toml');
  let text = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';
  if (fs.existsSync(cfg) && fs.lstatSync(cfg).isSymbolicLink()) fs.rmSync(cfg);
  const real = fs.realpathSync(folder);
  if (!text.includes(`[projects."${real}"]`)) text += `\n[projects."${real}"]\ntrust_level = "trusted"\n`;
  if (!/^\s*hooks\s*=\s*true/m.test(text)) text = text.replace(/^\[features\]\s*$/m, '[features]\nhooks = true') ;
  fs.writeFileSync(cfg, text);
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${py} '${entry}' codex # dispatch-hook (e2e)`, timeout: 15 }] }] } }, null, 2));
}

async function key(ui, k, code, vk, modifiers) {
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await ui.sleep(400);
}

/** ⌘T, Terminal, the agent: the person's way to run it in Dispatch's terminal; answers the agent's first questions
 *  (trust this folder, trust the hooks) the way a person does, and waits for its prompt. */
async function agentInTerminal(ui, agent) {
  for (let i = 0; ; i++) {
    await closeTips(ui);
    if (i) await ui.click({ css: '.agent-sessions-viewpane' }).catch(() => null);
    await key(ui, 't', 'KeyT', 84, META);
    if (await ui.waitFor({ css: '.dispatch-new-picker' }, { timeoutMs: 8000 }).then(() => true, () => false)) break;
    if (i >= 3) throw new Error('⌘T does not open the new session picker');
  }
  await ui.click({ text: 'Terminal', exact: true, within: '.dispatch-new-picker' });
  await ui.waitFor({ text: NAMES[agent], within: '.dispatch-new-picker' }, { timeoutMs: 60000 });
  await ui.click({ text: NAMES[agent], within: '.dispatch-new-picker' });
  for (const end = Date.now() + 40000; Date.now() < end; await ui.sleep(500)) {
    if (await ui.exists("Use your Ghostty look in Dispatch's terminal?")) await ui.click({ text: 'Not now', exact: true });
    if (await ui.exists({ css: '.dispatch-terminal-view .dispatch-xterm .xterm-screen' })) break;
  }
  await ui.waitFor({ css: '.dispatch-terminal-view .dispatch-xterm .xterm-screen' }, { timeoutMs: 20000 });
  let text = '';
  const answered = [];
  await until(ui, async () => {
    text = await terminalText(ui);
    const tail = text.slice(-1500);
    // Codex asks about new hooks first: Trust all and continue, as a person who just set Dispatch up does
    if (/Trust all and continue/.test(tail) && answered.length < 6) {
      answered.push('hooks: trust all and continue');
      await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' });
      await ui.press('ArrowDown');
      await ui.press('Enter');
      await ui.sleep(2500);
      return false;
    }
    // Codex lists hooks that need review: trust them all (t)
    if (/t trust all/.test(tail) && answered.length < 6) {
      answered.push('hooks: trust all');
      await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' });
      await ui.type('t');
      await ui.sleep(2500);
      if (/t trust all/.test((await terminalText(ui)).slice(-1500))) await ui.press('Escape');
      await ui.sleep(1500);
      return false;
    }
    // first-run questions: trust the folder, trust new hooks, what's new; the default answer is the first choice
    if (/Do you trust|trust the (files|contents)|Trust this (folder|directory)|hooks? (were|was) (added|changed)|Review (the )?hooks|new hooks?/i.test(tail) && answered.length < 4) {
      answered.push(tail.split('\n').filter(Boolean).slice(-3).join(' | '));
      await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' });
      // the person's answer is yes: when the highlighted choice is No (Claude Code puts "No, exit" first), one down
      if (/❯\s*(\d\.\s*)?No\b/.test(tail)) await ui.press('ArrowDown');
      await ui.press('Enter');
      await ui.sleep(2500);
      return false;
    }
    // (Claude Code 2.1.29x: an empty ❯ line between two rules, "shift+tab to cycle" under it)
    return agent === 'claude' ? /\? for shortcuts|Try "|╭─|>\s*$|shift\+tab to cycle|^\s*❯\s*$/m.test(tail) && !/Do you trust/i.test(tail)
      : /Ask Codex|for shortcuts|context left|›\s/m.test(tail) && !/Hooks need review|trust all/i.test(tail);
  }, `${NAMES[agent]}'s prompt in the terminal`, 120000, 1000).catch(e => { throw new Error(`${e.message}: ${text.slice(-600)}`); });
  // a question can come a moment after the prompt shows (Codex asks about new hooks once it has loaded them)
  for (let i = 0; i < 10; i++) {
    await ui.sleep(1500);
    const tail = (await terminalText(ui)).slice(-1500);
    if (/Trust all and continue/.test(tail)) {
      answered.push('hooks: trust all and continue (late)');
      await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' });
      await ui.press('ArrowDown');
      await ui.press('Enter');
      i = 0;
    } else if (/t trust all/.test(tail)) {
      answered.push('hooks: trust all (late)');
      await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' });
      await ui.type('t');
      i = 0;
    }
  }
  return { screen: (await terminalText(ui)).slice(-600), answered };
}

async function idle(ui, note) {
  const board = ui.rec.beads_dir;
  const bd = (...a) => execFileSync('bd', a, { encoding: 'utf8', env: { ...process.env, BEADS_DIR: board } });
  const make = (title) => cli(ui, ['begin', title, '--force', '-P', 'demo', '-d', 'An agent started this and its session closed before it said done; nobody works on it now.', '--json']).id;
  const a = make('Export the reading list as CSV');
  const b = make('Fix the date in the footer');
  // the board last heard of them three hours ago, and no session claims them any more
  for (const id of [a, b]) bd('update', id, '--set-metadata', 'claim_session=claude-code:gone-' + id, '--json');
  const old = new Date(Date.now() - 3 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const rows = bd('export').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => [a, b].includes(r.id)).map(r => ({ ...r, updated_at: old }));
  const file = path.join(ui.out, 'idle-rows.jsonl');
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  bd('import', '--allow-stale', file);
  const idleNow = cli(ui, ['nextup', 'idle', '--json']).idle.map(r => r.id);
  note('idle_cli', idleNow);
  assert([a, b].every(id => idleNow.includes(id)), 'the CLI does not call them idle: ' + JSON.stringify(idleNow));
  await ui.openTab('Tasks');
  // the project's tasks (the idle ones belong to no session)
  // the second switch is the project's (it says Project, or the project's name)
  await ui.waitFor({ css: '.dispatch-tasks-scope [role="tab"]' }, { timeoutMs: 30000 });
  if (await ui.eval(`document.querySelectorAll('.dispatch-tasks-scope [role="tab"]')[1]?.getAttribute('aria-selected') !== 'true'`)) await ui.click({ css: '.dispatch-tasks-scope [role="tab"]', index: 1 });
  const IDLE_DOM = `(() => { const g = [...document.querySelectorAll('.dispatch-nextup-group.idle')].find(e => e.offsetParent); return g ? { head: g.querySelector('.dispatch-nextup-head')?.innerText.replace(/\\s+/g, ' ').trim(), note: g.querySelector('.dispatch-nextup-note')?.innerText.trim(), rows: [...g.querySelectorAll('.dispatch-nextup-row')].map(r => ({ task: r.dataset.task, title: r.querySelector('.dispatch-nextup-title')?.textContent })) } : null; })()`;
  const g0 = await until(ui, async () => { const g = await ui.eval(IDLE_DOM); return g && [a, b].every(id => g.rows.some(r => r.task === id)) ? g : null; }, 'the Nobody on it group', 60000, 1500);
  note('idle_group', g0);
  assert(/Nobody on it/.test(g0.head) && /Line them all up/.test(g0.head), 'the group head: ' + g0.head);
  const cards = await ui.eval(`[...document.querySelectorAll('.dispatch-task-card')].filter(c => c.offsetParent).map(c => c.dataset.taskId)`);
  assert(![a, b].some(id => cards.includes(id)), 'an idle task is also drawn as a card: ' + JSON.stringify(cards));
  await closeTips(ui);
  await restPointer(ui);
  await ui.eval(`document.querySelector('.dispatch-nextup-group.idle')?.scrollIntoView({ block: 'center' })`);
  await ui.sleep(500);
  await ui.screenshot('i01-nobody-on-it');
  await ui.mark({ css: '.dispatch-nextup-group.idle' }, { what: '板上还写着在做、但一小时没人碰的任务', where: '右栏 Tasks 页签，项目范围', how: '自己出现；每行悬停有 Back to Next up，组头有 Line them all up' });
  // Back to Next up on one row (the tab draws again every few seconds: point at the row right before each step)
  const row = `.dispatch-nextup-row[data-task="${a}"]`;
  const pointAt = async (task) => {
    const r = `.dispatch-nextup-row[data-task="${task}"]`;
    for (let i = 0; i < 8; i++) {
      await closeTips(ui); // a first-time tip can sit over the rows
      await ui.eval(`document.querySelector('${r}')?.scrollIntoView({ block: 'center' })`);
      await restPointer(ui);
      await ui.hover({ css: r });
      await ui.sleep(300);
      if (await ui.eval(`(document.querySelector('${r} .dispatch-nextup-acts')?.getBoundingClientRect().width || 0) > 0`)) return r;
    }
    throw new Error('the buttons of ' + task + ' do not come');
  };
  await pointAt(a);
  await ui.screenshot('i02-back-to-next-up-hover');
  await ui.mark({ css: row }, { what: '指着这一行：Back to Next up 放回 Next up', where: 'Nobody on it 下面一行的右边', how: '指着这一行' });
  await pointAt(a);
  await ui.click({ text: 'Back to Next up', exact: true, within: row });
  const n1 = await until(ui, async () => { const d = await ui.eval(NEXT_DOM); return d && d.next.some(r => r.task === a) ? d : null; }, 'the task in Next up', 30000, 1000);
  note('after_one', n1);
  const shown = JSON.parse(bd('show', a, '--json'));
  const t = Array.isArray(shown) ? shown[0] : shown;
  note('task_after', { status: t.status, labels: t.labels });
  assert(t.status === 'open' && (t.labels || []).includes('nextup'), 'not back in Next up on the board: ' + JSON.stringify({ status: t.status, labels: t.labels }));
  assert(n1.next[n1.next.length - 1].task === a, 'it is not at the end of the line: ' + JSON.stringify(n1.next));
  await restPointer(ui);
  await ui.screenshot('i03-back-in-line');
  await ui.mark({ css: `.dispatch-nextup-row[data-task="${a}"]` }, { what: '回到 Next up 队尾', where: 'Next up 最后一行', how: '点了 Back to Next up 以后' });
  // the rest at once
  if (await ui.exists({ text: 'Line them all up', exact: true })) {
    await ui.click({ text: 'Line them all up', exact: true });
  } else {
    // one left: its own row
    await pointAt(b);
    await ui.click({ text: 'Back to Next up', exact: true, within: `.dispatch-nextup-row[data-task="${b}"]` });
  }
  const n2 = await until(ui, async () => { const d = await ui.eval(NEXT_DOM); const g = await ui.eval(IDLE_DOM); return d && d.next.some(r => r.task === b) && !g ? d : null; }, 'both back in line, the group gone', 30000, 1000);
  note('after_all', n2.next.map(r => r.task));
}

async function terminalAgent(ui, agent, note) {
  const before = new Set(receipts(ui).map(r => r.id));
  const opened = await agentInTerminal(ui, agent);
  note(`${agent}_screen`, opened);
  if (agent === 'claude') {
    // the cheap model (a slash command is never noted)
    await typeInTerminal(ui, '/model haiku');
    await ui.sleep(3000);
  }
  await typeInTerminal(ui, SAY[agent]);
  if (agent === 'codex') {
    // Codex takes a fast run of keys as a paste and an Enter right behind it as a new line: when the words still sit in
    // its input and it is not working, Enter once more, as a person would
    for (let i = 0; i < 3; i++) {
      await ui.sleep(4000);
      const screen = await terminalText(ui);
      if (/esc to interrupt|Working/.test(screen) || !screen.slice(-1500).includes(SAY.codex.slice(0, 40))) break;
      await ui.press('Enter');
    }
  }
  const typedAt = Date.now();
  const tr = await until(ui, async () => receipts(ui).find(r => !before.has(r.id) && (r.session || '').startsWith('dispatch-terminal:/') && r.items.length), `a receipt from ${NAMES[agent]} in the terminal`, 240000, 2000)
    .catch(async e => { note(`${agent}_screen_at_failure`, (await terminalText(ui)).slice(-1500)); throw e; });
  note(`${agent}_noted_after_s`, Math.round((Date.now() - typedAt) / 1000));
  note(`${agent}_receipt`, tr);
  const tids = tr.items.filter(i => i.kind === 'new').map(i => i.task);
  assert(tids.length === 2, `two things from ${NAMES[agent]}: ` + JSON.stringify(tr.items));
  await ui.openTab('Tasks');
  if (await ui.exists({ text: 'This session', exact: true, within: '.dispatch-tasks-scope' })) await ui.click({ text: 'This session', exact: true, within: '.dispatch-tasks-scope' });
  const stateOf = () => Object.fromEntries(receipts(ui).filter(r => r.id === tr.id).flatMap(r => r.items).map(i => [i.task, i.state]));
  const tt = await until(ui, async () => {
    const d = await ui.eval(NEXT_DOM);
    const st = stateOf();
    return d && tids.every(id => st[id] === 'next' ? d.next.some(r => r.task === id) : d.cards.includes(id)) ? d : null;
  }, `${NAMES[agent]}'s things in its Tasks tab`, 90000, 1000);
  note(`${agent}_tasks`, tt);
  const again = receipts(ui).filter(r => r.session === tr.session && r.key === tr.key);
  assert(again.length === 1, 'noted more than once: ' + JSON.stringify(again.map(r => r.items)));
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot(`t-${agent}-noted`);
  await ui.mark({ css: '.dispatch-terminal-view' }, { what: `在终端里跑的 ${NAMES[agent]}：你打的字也自动记`, where: '中间的终端会话', how: `⌘T，选 Terminal，再选 ${NAMES[agent]}` });
  await ui.mark({ css: tt.next.length ? '.dispatch-nextup-group[data-part="next-up"]' : '.dispatch-tasks-list' }, { what: '记下的两件进了这个终端会话的 Tasks，排在 Next up', where: '右栏 Tasks 页签', how: '几秒后自己出现' });
}

export default async function (ui) {
  const notes = {};
  const note = (k, v) => { notes[k] = v; fs.writeFileSync(path.join(ui.out, 'result.json'), JSON.stringify(notes, null, 2)); };
  // Claude Code's part is capture-agents-claude.mjs: it spends the Claude allowance, which tests leave alone unless asked
  const want = (process.env.CAPTURE_STAGES || 'idle,claude,codex').split(',').map(s => s.trim()).filter(Boolean);
  hooks(ui);
  await ui.openAgents(ui.demoFolder);
  await offScreen(ui);
  await closeTips(ui);
  if (want.includes('idle')) await idle(ui, note);
  for (const agent of ['claude', 'codex']) {
    if (want.includes(agent)) await terminalAgent(ui, agent, note);
  }
}
