// What works for a project right now, under the project in the sessions list (kanban task-y3z2s: 「我希望在看板这里能看到
// 正在运行 并且想在kanban哪里看到正在运行的会话」). The person's case: the Assistant (a session outside every project) sent
// out a sub-agent that works in the kanban project and claimed a kanban task; nothing under kanban showed it.
// Here: Claude Code in a terminal in a folder that is no project (its own screen only: nothing is sent to it), and the
// record Claude Code writes when it sends out a background sub-agent that claims a task of the demo project and works
// in its folder (written into ~/.claude/projects/<that folder>/ and the instance's claude-home, removed at the end). The sub-agent's row sits first
// under demo with its breathing block, what it was sent to do, model and time; not under the session that sent it.
// Pointing at it says the task; a click opens its record, read only; once it is back it leaves demo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

export const meta = { instance: { motion: true }, title: '项目下面看得到为它在跑的子 Agent', description: '不在任何项目里的会话派出的子 Agent，认领了 demo 的任务、在 demo 里干活：它的行排在左栏 demo 分组第一行（呼吸的紫块、派它去做什么、模型、跑了多久），不在派它的会话下面；悬停写在做哪个任务，点开看它的记录（只读），做完从 demo 下面消失。' };

const META = 4;
const SUB = 'Show what runs for demo';

async function closeTips(ui) {
  for (let i = 0; i < 4 && await ui.exists({ css: '.dispatch-tour-close' }); i++) {
    await ui.click({ css: '.dispatch-tour-close' });
    await ui.sleep(500);
  }
}

/** The list's rows top to bottom: kind, text, depth, the group they are in; the sub-agent row's block and its animation. */
const ROWS = `(() => {
  const rows = [...document.querySelectorAll('.monaco-list-row')].filter(r => r.offsetParent && r.querySelector('.session-section, .session-item, .session-chat-item'))
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  let group = '';
  return rows.map(r => {
    const e = r.querySelector('.session-section, .session-item, .session-chat-item');
    const kind = e.classList.contains('session-section') ? 'group' : e.classList.contains('session-item') ? 'session' : 'chat';
    const text = e.innerText.replace(/\\s+/g, ' ').trim();
    const depth = Number(r.getAttribute('aria-level') || 0);
    if (kind === 'group' && depth === 1) group = (e.querySelector('.session-section-label') || e).innerText.trim();
    const block = e.querySelector('.dispatch-subagent-block .dispatch-block');
    const anim = block ? [block, ...block.querySelectorAll('*')].map(x => getComputedStyle(x).animationName).find(n => n && n !== 'none') || 'none' : '';
    return { kind, text, depth, group, sub: e.classList.contains('dispatch-subagent'), block: block ? block.className.baseVal ?? block.className : '', anim, x: Math.round(e.getBoundingClientRect().left) };
  });
})()`;

async function until(ui, test, what, ms = 30000) {
  let last;
  for (const end = Date.now() + ms * SCALE; Date.now() < end; await ui.sleep(500)) {
    last = await test();
    if (last && last.ok) return last;
  }
  throw new Error(`${what}: ${JSON.stringify(last)}`);
}

export default async function (ui) {
  const rec = ui.rec;
  const env = { ...process.env, BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home };
  const cli = (...args) => execFileSync('python3', [rec.cli, ...args], { env, encoding: 'utf8', timeout: 180000 });
  const demo = ui.demoFolder;
  const elsewhere = path.join(path.dirname(demo), 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  const facts = {};
  const save = () => fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 1));
  let made = '';
  try {
    // a task of the demo project, on the instance's board
    const begun = JSON.parse(cli('begin', 'Show what runs for the demo project in its group', '--force', '-P', 'demo', '-d', 'The person wants to see under demo what works for it right now.', '--json').replace(/^[^{]*/, ''));
    facts.task = { id: begun.id, title: begun.title };
    assert.ok(begun.id, 'a demo task: ' + JSON.stringify(begun));

    await ui.attach('agents', 90000);
    await ui.sleep(4000);
    await closeTips(ui);
    await ui.openAgents(elsewhere);
    await ui.newSession();
    await closeTips(ui);
    await ui.sleep(2000);

    // 0 Claude Code in a terminal in a folder that is no project
    await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: META });
    await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: META });
    await ui.waitFor({ text: 'Claude Code', within: '.dispatch-new-picker' }, { timeoutMs: 120000 });
    await ui.click({ text: 'Claude Code', within: '.dispatch-new-picker' });
    for (const end = Date.now() + 40000; Date.now() < end; await ui.sleep(500)) {
      if (await ui.exists("Use your Ghostty look in Dispatch's terminal?")) await ui.click({ text: 'Not now', exact: true });
      if (await ui.exists('Claude Code (terminal)')) break;
    }
    await ui.waitFor('Claude Code (terminal)', { timeoutMs: 30000 });
    const sessions = JSON.parse(cli('terminal', 'daemon', 'status', '--json')).sessions;
    // the newest: a terminal of an earlier run in this instance can still be listed
    const terminal = sessions.filter(s => s.agent && s.agent.id === 'claude' && String(s.cwd || '').includes('elsewhere')).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    assert.ok(terminal && terminal.agentSession, 'Claude Code started with a conversation id of Dispatch\'s: ' + JSON.stringify(sessions));
    facts.terminal = { cwd: terminal.cwd, agentSession: terminal.agentSession };

    // 1 the record Claude Code writes when it sends out a background sub-agent that claims the demo task. The
    // terminal's reader looks in ~/.claude, the instance's CLI in its CLAUDE_CONFIG_DIR (claude-home): written to both
    const physical = /^\/(tmp|var|etc)(\/|$)/.test(elsewhere) ? `/private${elsewhere}` : elsewhere;
    const dir = path.join(os.homedir(), '.claude', 'projects', physical.replace(/[^a-zA-Z0-9]/g, '-'));
    assert.ok(dir.includes('dide-e2e'), 'only a test folder\'s record is written');
    made = dir;
    const claudeHome = rec.fixture_home ? path.join(rec.fixture_home, '.claude') : path.join(rec.root, 'claude-home');
    const subs = path.join(dir, terminal.agentSession, 'subagents');
    fs.mkdirSync(subs, { recursive: true });
    const t0 = new Date(Date.now() - 2 * 60000).toISOString();
    const line = o => JSON.stringify(o) + '\n';
    const transcript = path.join(dir, `${terminal.agentSession}.jsonl`);
    fs.writeFileSync(transcript,
      line({ type: 'assistant', timestamp: t0, cwd: elsewhere, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_demo_work', name: 'Agent', input: { description: SUB, subagent_type: 'opus-high', run_in_background: true, prompt: `You are in ${demo}. Claim ${begun.id}.` } }] } }) +
      line({ type: 'user', timestamp: t0, cwd: elsewhere, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_demo_work', content: 'Async agent launched successfully. agentId: w1' }] } }));
    fs.writeFileSync(path.join(subs, 'agent-w1.meta.json'), JSON.stringify({ agentType: 'opus-high', description: SUB, toolUseId: 'toolu_demo_work', model: 'claude-opus-5' }));
    fs.writeFileSync(path.join(subs, 'agent-w1.jsonl'),
      line({ type: 'user', isSidechain: true, timestamp: t0, cwd: elsewhere, message: { role: 'user', content: `You are in ${demo}. Claim ${begun.id} and show what runs for it.` } }) +
      line({ type: 'assistant', isSidechain: true, timestamp: t0, cwd: elsewhere, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'toolu_claim', name: 'mcp__dispatch__task_claim', input: { task: begun.id } }] } }) +
      line({ type: 'assistant', isSidechain: true, timestamp: t0, cwd: elsewhere, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'toolu_ls', name: 'Bash', input: { command: `cd ${demo} && git status --short` } }] } }) +
      line({ type: 'assistant', isSidechain: true, timestamp: t0, cwd: elsewhere, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Reading the sessions list now.' }] } }));
    const copy = path.join(claudeHome, 'projects', path.basename(dir));
    fs.rmSync(copy, { recursive: true, force: true });
    fs.cpSync(dir, copy, { recursive: true });
    const cliEnv = { CLAUDE_CONFIG_DIR: claudeHome, DISPATCH_SESSION_ROOT: rec.root }; // as the instance's own CLI runs
    facts.cli = JSON.parse(execFileSync('python3', [rec.cli, 'projects', '--sidebar', '--json'], { env: { ...env, ...cliEnv }, encoding: 'utf8', timeout: 60000 })).subagents;
    save();
    assert.equal(facts.cli && facts.cli.toolu_demo_work && facts.cli.toolu_demo_work.project, 'demo', 'the CLI places the sub-agent in demo: ' + JSON.stringify(facts.cli));

    // 2 its row: first under demo, a session's row's depth, the breathing sub-agent block; not under the session that sent it
    const placed = await until(ui, async () => {
      const rows = await ui.eval(ROWS);
      const row = rows.find(r => r.sub && r.text.startsWith(SUB));
      const demoAt = rows.findIndex(r => r.kind === 'group' && r.depth === 1 && r.group === 'demo');
      return { ok: !!row && row.group === 'demo' && rows[demoAt + 1] && rows[demoAt + 1].text.startsWith(SUB), row, rows };
    }, 'the sub-agent row first under demo', 90000);
    facts.rows = placed.rows;
    facts.row = placed.row;
    assert.match(placed.row.text, new RegExp(`^${SUB} · Opus 5 \\d+m`), 'what it was sent to do, model, how long: ' + placed.row.text);
    assert.match(placed.row.block, /dispatch-block sub-agent/, 'the purple sub-agent block: ' + placed.row.block);
    const sessionRow = placed.rows.find(r => r.kind === 'session' && /Claude Code/.test(r.text));
    const parentAt = placed.rows.indexOf(sessionRow);
    facts.underParent = sessionRow ? placed.rows.slice(parentAt + 1).filter((r, i, a) => a.slice(0, i + 1).every(x => x.kind === 'chat')).map(r => r.text) : null;
    assert.ok(!facts.underParent || !facts.underParent.some(t => t.startsWith(SUB)), 'not under the session that sent it: ' + JSON.stringify(facts.underParent));
    const sessionInDemo = placed.rows.filter(r => r.kind === 'session' && r.group === 'demo').map(r => r.depth);
    facts.depths = { sub: placed.row.depth, sessionsInDemo: sessionInDemo };
    save();
    await ui.screenshot('01-under-demo');
    await ui.mark({ text: SUB }, { what: '为 demo 在跑的子 Agent', where: '左栏 demo 分组第一行', how: '紫块在呼吸、派它去做什么、模型、跑了多久；它是别处的会话派出来的' });

    // 3 pointing at it: the task it is on, and who sent it
    await ui.hover({ text: SUB });
    const card = await until(ui, async () => {
      const t = await ui.eval(`(() => { const h = [...document.querySelectorAll('.monaco-hover, .workbench-hover, .dispatch-hover-card')].find(e => e.offsetParent); return h ? h.innerText.replace(/\\s+/g, ' ') : ''; })()`);
      return { ok: t.includes('Working on:') && t.includes(begun.title), t };
    }, 'the hover card says the task', 15000);
    facts.card = card.t;
    assert.match(card.t, /Sent by:/, 'who sent it: ' + card.t);
    await ui.screenshot('02-hover-card');
    save();

    // 4 a click opens its record, read only
    await ui.click({ text: SUB });
    const head = await until(ui, async () => {
      const h = await ui.eval(`(() => { const v = [...document.querySelectorAll('.dispatch-terminal-view')].find(e => e.offsetParent); if (!v) return null; const head = v.querySelector('.dtc-record-head');
        return { head: head && head.offsetParent ? head.innerText.replace(/\\s+/g, ' ') : '', list: (v.querySelector('.dtc-list') || {}).innerText || '', composer: getComputedStyle(v.querySelector('.dtc-composer')).display }; })()`);
      return { ok: !!h && h.head.includes(SUB) && /Reading the sessions list now/.test(h.list), ...h };
    }, 'its record opens', 30000);
    facts.record = head;
    assert.match(head.head, /Sub-agent · Opus 5 · Working/);
    assert.equal(head.composer, 'none', 'read only: no box to type in');
    await ui.screenshot('03-record');
    await ui.mark({ css: '.dtc-record-head' }, { what: '子 Agent 的记录', where: '点 demo 下面那一行', how: '只读；要指挥它回到派它的会话里说' });
    await ui.click({ text: 'Back to the session', exact: true });

    // 5 it comes back: it leaves demo
    const back = line({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: '<task-notification>\n<task-id>w1</task-id>\n<tool-use-id>toolu_demo_work</tool-use-id>\n<status>completed</status>\n</task-notification>' } });
    fs.appendFileSync(transcript, back);
    fs.appendFileSync(path.join(copy, path.basename(transcript)), back);
    const gone = await until(ui, async () => {
      const rows = await ui.eval(ROWS);
      return { ok: !rows.some(r => r.sub && r.text.startsWith(SUB) && r.group === 'demo'), rows };
    }, 'the finished sub-agent leaves demo', 60000);
    facts.after = gone.rows;
    await ui.screenshot('04-back-left-demo');
    save();
  } finally {
    save();
    try { cli('terminal', 'daemon', 'stop', '--json'); } catch { /* already gone */ }
    if (made && made.includes('dide-e2e')) fs.rmSync(made, { recursive: true, force: true });
    fs.rmSync(path.join(rec.fixture_home ? path.join(rec.fixture_home, '.claude') : path.join(rec.root, 'claude-home'), 'projects', path.basename(made || 'none')), { recursive: true, force: true });
  }
}
