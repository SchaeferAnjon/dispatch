// Direction A of the terminal design (design/terminal-merge, A3 and A5): the sub-agents a session sends out are rows
// under it in the sessions list (name, model, how long; working first, the finished ones behind "Show N finished"; a
// count at the end of the session's row folds them away and back), opening one shows its own record read only, and
// a terminal session has its own tabs ("+ Shell", side by side or one at a time).
// It opens Claude Code in a terminal (its own screen only: nothing is sent to it) and writes the record Claude Code
// would write for two sub-agents into ~/.claude/projects/<the demo folder>/ (removed at the end). Stops the
// instance's terminal daemon at the end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

export const meta = { title: '子 Agent 挂在会话下', description: '会话派出的子 Agent 列在左栏这条会话下面：名字、模型、跑了多久；在跑的在前，做完的收进「Show N finished」；行尾数字一点收起；点开读它的记录（只读）。终端会话自己的页签：+ Shell、并排或一次一个。' };

const META = 4;

async function closeTips(ui) {
  for (let i = 0; i < 4 && await ui.exists({ css: '.dispatch-tour-close' }); i++) {
    await ui.click({ css: '.dispatch-tour-close' });
    await ui.sleep(500);
  }
}

/** The rows under the Claude Code terminal session in the sessions list. */
// only this session's rows: an earlier scenario in the same instance may have left a session with sub-agents of its own
const MINE = `(() => {
  const rows = [...document.querySelectorAll('.session-item, .session-chat-item')].filter(e => e.offsetParent)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const at = rows.findIndex(e => e.classList.contains('session-item') && /Claude Code/.test(e.innerText));
  if (at < 0) return { session: null, chats: [] };
  const chats = [];
  for (const e of rows.slice(at + 1)) { if (e.classList.contains('session-item')) break; chats.push(e); }
  return { session: rows[at], chats };
})()`;
const subRows = ui => ui.eval(`(() => ${MINE}.chats.map(e => ({
  text: e.innerText.replace(/\\s+/g, ' ').trim(), sub: e.classList.contains('dispatch-subagent'), more: e.classList.contains('dispatch-subagent-more'), title: e.title || '' })))()`);

/** Marks this session's count (data-e2e-mine) so a click or a mark finds it and not another session's. */
const MY_COUNT = '.dispatch-subagent-count[data-e2e-mine]';
const markMine = ui => ui.eval(`(() => { document.querySelectorAll('[data-e2e-mine]').forEach(e => e.removeAttribute('data-e2e-mine')); const s = ${MINE}.session; const b = s && s.querySelector('.dispatch-subagent-count'); if (b) b.setAttribute('data-e2e-mine', ''); return !!b; })()`);

const count = ui => ui.eval(`(() => { const s = ${MINE}.session; const b = s && [...s.querySelectorAll('.dispatch-subagent-count')].find(e => e.offsetParent); return b ? { text: b.innerText.trim(), title: b.title } : null; })()`);

async function until(ui, test, what, ms = 20000) {
  let last;
  for (const end = Date.now() + ms * SCALE; Date.now() < end; await ui.sleep(400)) {
    last = await test();
    if (last && last.ok) return last;
  }
  throw new Error(`${what}: ${JSON.stringify(last)}`);
}

export default async function (ui) {
  const rec = ui.rec;
  const env = { ...process.env, BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home };
  const cli = (...args) => execFileSync('python3', [rec.cli, ...args], { env, encoding: 'utf8', timeout: 60000 });
  const folder = ui.demoFolder;
  const facts = {};
  const save = () => fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 1));
  let made = '';
  try {
    await ui.attach('agents', 90000);
    await ui.sleep(4000);
    await closeTips(ui);
    await ui.openAgents(folder);
    await ui.newSession();
    await closeTips(ui);
    await ui.sleep(2000);

    // 0 Claude Code in a terminal
    await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: META });
    await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: META });
    await ui.waitFor({ text: 'Claude Code', within: '.dispatch-new-picker' }, { timeoutMs: 120000 });
    await ui.click({ text: 'Claude Code', within: '.dispatch-new-picker' });
    for (const end = Date.now() + 40000; Date.now() < end; await ui.sleep(500)) {
      if (await ui.exists("Use your Ghostty look in Dispatch's terminal?")) await ui.click({ text: 'Not now', exact: true });
      if (await ui.exists('Claude Code (terminal)')) break;
    }
    await ui.waitFor('Claude Code (terminal)', { timeoutMs: 30000 });
    const terminal = JSON.parse(cli('terminal', 'daemon', 'status', '--json')).sessions.find(s => s.agent && s.agent.id === 'claude');
    assert.ok(terminal && terminal.agentSession, 'Claude Code started with a conversation id of Dispatch\'s: ' + JSON.stringify(terminal));

    // 1 the record Claude Code writes when it sends out two sub-agents: one back already, one still working
    const physical = /^\/(tmp|var|etc)(\/|$)/.test(folder) ? `/private${folder}` : folder;
    const dir = path.join(os.homedir(), '.claude', 'projects', physical.replace(/[^a-zA-Z0-9]/g, '-'));
    assert.ok(!fs.existsSync(dir) || dir.includes('dide-e2e'), 'only a test folder\'s record is written');
    made = dir;
    fs.mkdirSync(path.join(dir, terminal.agentSession, 'subagents'), { recursive: true });
    const t0 = new Date(Date.now() - 4 * 60000).toISOString();
    const t1 = new Date(Date.now() - 3 * 60000).toISOString();
    const line = o => JSON.stringify(o) + '\n';
    const transcript = path.join(dir, `${terminal.agentSession}.jsonl`);
    fs.writeFileSync(transcript,
      line({ type: 'assistant', timestamp: t0, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read', name: 'Task', input: { description: 'Read the termd sources', subagent_type: 'Explore' } }] } }) +
      line({ type: 'assistant', timestamp: t0, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_port', name: 'Agent', input: { description: 'Port the restore code' } }] } }) +
      line({ type: 'user', timestamp: t0, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_port', content: 'Async agent launched successfully. agentId: a2' }] } }) +
      line({ type: 'user', timestamp: t1, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: [{ type: 'text', text: 'Read 6 files.' }] }] } }));
    const subs = path.join(dir, terminal.agentSession, 'subagents');
    fs.writeFileSync(path.join(subs, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Read the termd sources', toolUseId: 'toolu_read', model: 'sonnet' }));
    fs.writeFileSync(path.join(subs, 'agent-a2.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Port the restore code', toolUseId: 'toolu_port', model: 'claude-opus-5' }));
    fs.writeFileSync(path.join(subs, 'agent-a2.jsonl'),
      line({ type: 'user', isSidechain: true, timestamp: t0, message: { role: 'user', content: 'Port the restore code from Orca.' } }) +
      line({ type: 'assistant', isSidechain: true, timestamp: t0, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Porting the restore code now.' }] } }));

    // 2 the rows: the working one, then "Show 1 finished"; the count at the end of the session's row
    let rows = await until(ui, async () => { const r = await subRows(ui); return { ok: r.some(x => x.sub && x.text.startsWith('Port the restore code')) && r.some(x => x.more), rows: r }; }, 'the working sub-agent and Show 1 finished under the session');
    facts.rows = rows.rows;
    const port = rows.rows.find(x => x.sub);
    assert.match(port.text, /Port the restore code · Opus 5 \d+m/, 'name, model, how long: ' + port.text);
    assert.ok(rows.rows.find(x => x.more).text.includes('Show 1 finished'));
    facts.count = await count(ui);
    assert.equal(facts.count.text, '2');
    assert.match(facts.count.title, /^2 sub-agents, 1 working/);
    await ui.screenshot('01-sub-agents');
    await ui.mark('Port the restore code', { what: '子 Agent', where: '左栏，Claude Code 终端会话下面', how: '方块、名字、· 模型、跑了多久；在跑的在前' });
    await markMine(ui);
    await ui.mark({ css: MY_COUNT }, { what: '子 Agent 数', where: '会话行尾，Claude 的标前面', how: '悬停说几个在跑，点一下收起和展开' });
    await ui.click({ text: 'Show 1 finished' });
    rows = await until(ui, async () => { const r = await subRows(ui); return { ok: r.filter(x => x.sub).length === 2 && !r.some(x => x.more), rows: r }; }, 'Show 1 finished shows it');
    const read = rows.rows.find(x => x.text.startsWith('Read the termd sources'));
    assert.match(read.text, /· Sonnet 1m/, 'the finished one with its model and how long it ran: ' + read.text);
    facts.rowsAll = rows.rows;
    await ui.screenshot('02-finished-shown');
    save();

    // 3 opening a sub-agent: its own record, read only, and back
    await ui.click({ text: 'Port the restore code' });
    const head = await until(ui, async () => {
      const h = await ui.eval(`(() => { const v = [...document.querySelectorAll('.dispatch-terminal-view')].find(e => e.offsetParent); if (!v) return null; const head = v.querySelector('.dtc-record-head');
        return { head: head && head.offsetParent ? head.innerText.replace(/\\s+/g, ' ') : '', list: (v.querySelector('.dtc-list') || {}).innerText || '', composer: getComputedStyle(v.querySelector('.dtc-composer')).display }; })()`);
      return { ok: !!h && /Port the restore code/.test(h.head) && /Porting the restore code now/.test(h.list), ...h };
    }, 'the sub-agent\'s record opens read only');
    facts.record = head;
    assert.match(head.head, /Sub-agent · Opus 5 · Working/);
    assert.equal(head.composer, 'none', 'read only: no box to type in');
    await ui.screenshot('03-sub-agent-record');
    await ui.mark({ css: '.dtc-record-head' }, { what: '子 Agent 的记录', where: '点左栏的子 Agent 行', how: '只读，要指挥它回到派它的会话里说' });
    await ui.click({ text: 'Back to the session', exact: true });
    await until(ui, async () => { const s = await ui.eval(`(() => { const v = [...document.querySelectorAll('.dispatch-terminal-view')].find(e => e.offsetParent); return v ? getComputedStyle(v.querySelector('.dispatch-terminal-host')).display : ''; })()`); return { ok: s !== 'none' && s !== '', s }; }, 'back to the terminal');

    // 4 the background one comes back: nothing works any more
    fs.appendFileSync(transcript, line({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_port</tool-use-id>\n<status>completed</status>\n</task-notification>' } }));
    facts.countDone = await until(ui, async () => { const c = await count(ui); return { ok: !!c && /^2 sub-agents, 0 working/.test(c.title), ...c }; }, 'the count says none is working');
    facts.bar = await ui.eval(`(() => { const v = [...document.querySelectorAll('.dispatch-terminal-view')].find(e => e.offsetParent); return v ? v.querySelector('.dispatch-terminal-subs').innerText : ''; })()`);
    assert.match(facts.bar, /2 sub-agents, all done/);

    // 5 the count folds them away and back
    // the row's own buttons come on hover and the name gives them room: point at the count first, then press it
    await markMine(ui);
    await ui.hover({ css: MY_COUNT });
    await ui.sleep(400);
    await ui.click({ css: MY_COUNT });
    await ui.sleep(800);
    facts.countAfterClick = await count(ui);
    save();
    await until(ui, async () => { const r = await subRows(ui); return { ok: !r.some(x => x.sub || x.more), r, count: await count(ui) }; }, 'folded away');
    await markMine(ui);
    await ui.hover({ css: MY_COUNT });
    await ui.sleep(400);
    await ui.click({ css: MY_COUNT });
    await until(ui, async () => { const r = await subRows(ui); return { ok: r.some(x => x.sub || x.more), r }; }, 'back again');
    save();

    // 6 the session's own tabs: + Shell, side by side or one at a time
    const tabs = () => ui.eval(`(() => { const v = [...document.querySelectorAll('.dispatch-terminal-view')].find(e => e.offsetParent); return v ? { tabs: [...v.querySelectorAll('.dtt-tab')].map(t => t.innerText + (t.classList.contains('on') ? '*' : '')), panes: [...v.querySelectorAll('.dispatch-terminal-pane')].filter(p => p.offsetParent).length, layout: !!v.querySelector('.dtt-layout') } : null; })()`);
    facts.tabsBefore = await tabs();
    assert.deepEqual(facts.tabsBefore.tabs, ['Claude Code']);
    await ui.click({ css: '.dispatch-terminal-view .dtt-add' });
    facts.tabsShell = await until(ui, async () => { const t = await tabs(); return { ok: t && t.tabs.length === 2 && t.panes === 2, ...t }; }, '+ Shell opens a shell beside the agent');
    assert.deepEqual(facts.tabsShell.tabs, ['Claude Code', 'Shell*']);
    await ui.screenshot('04-shell-tab');
    await ui.mark({ css: '.dispatch-terminal-tabs' }, { what: '会话自己的页签', where: '终端会话顶上一行', how: 'Agent 一个，「+ Shell」再开一个同文件夹的 shell；右边切并排或一次一个' });
    await ui.click({ css: '.dispatch-terminal-view .dtt-layout' });
    facts.tabsOne = await until(ui, async () => { const t = await tabs(); return { ok: t && t.panes === 1, ...t }; }, 'one at a time');
    await ui.click({ text: 'Claude Code', exact: true, within: '.dispatch-terminal-tabs' });
    facts.tabsBack = await until(ui, async () => { const t = await tabs(); return { ok: t && t.panes === 1 && t.tabs[0] === 'Claude Code*', ...t }; }, 'the Claude Code tab takes the space');
    save();
  } finally {
    save();
    try { cli('terminal', 'daemon', 'stop', '--json'); } catch { /* already gone */ }
    if (made && made.includes('dide-e2e')) fs.rmSync(made, { recursive: true, force: true });
  }
}
