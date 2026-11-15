// Bug fixes of 2026-10-06, group nextup, on the seeded demo project with OpenCode and a cheap Flash model
// (nothing starts on Claude Code or Codex: Start by itself is off, Turbo's own default is a model that does not exist).
//   task-9rxf  "some day (not now)" and "later" go to Later; nothing starts while the session works
//   task-b83p  the agent takes what Dispatch noted for its chat; a chat with no project does not put noted things on twice
//   task-et0q  the turn Submit Feedback sends shows the note, not /act-on-feedback
//   task-e04j  an OpenCode question's "Type your own answer" is the text box; the typed answer reaches the agent
//   task-o8wx  Turbo splits with the agent and model picked in the input box
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cli, closeTips, focusInput, LINE_DOM, line, newSessionInProject, offScreen, openNewChat, pickModel, receipts, restPointer, until } from './chat-capture.mjs';

export const meta = { needs: ['opencode'],
  title: 'Next up, notes and Turbo in a chat',
  description: 'Later things wait in Later, the agent takes its own noted task, a diff note shows as the note, a typed answer reaches the agent, Turbo uses the picked agent.',
  timeout: 2700,
};

const A1 = 'In README.md change the first line "# Demo" to "# Demo site" and change nothing else. Separately, some day (not now) I would like a dark mode, and later a footer.';
const NOTE = 'Make this heading "# Demo website" instead.';
const ASK = 'Before anything else, use your question tool (not plain text) to ask me which git name and email to use. Give exactly two options: "Fixture <fixture@example.com>" and "Type your own answer". After I answer, reply with exactly NAME=<my answer> and do nothing else.';
const TYPED = 'Test User <test@example.com>';
const LATER_TWO = 'Two things for later, nothing to do now: some day add a print stylesheet to the demo project, and later a FAQ page for it. Just say OK.';
const JOB = 'Add a robots.txt and a humans.txt to the demo project';

const lastResponse = `(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return r ? r.innerText : ''; })()`;
const turnDone = (re) => `(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return !!r && !r.classList.contains('chat-response-loading') && ${re}.test(r.innerText); })()`;

async function approve(ui) {
  const ask = await ui.eval(`[...document.querySelectorAll('.interactive-session button, .chat-confirmation-widget button')].map(b => b.innerText.trim()).find(t => /^(Allow|Allow once|Approve|Continue|Yes)$/i.test(t)) || ''`);
  if (ask) await ui.click({ text: ask, exact: true });
}

/** Every task on the instance's board (its own bd, the app's own copy first). */
function tasks(ui) {
  const tools = ui.resources('tools');
  const bd = fs.existsSync(path.join(tools, 'bd')) ? path.join(tools, 'bd') : 'bd';
  const out = execFileSync(bd, ['list', '--all', '--json', '--limit', '0'], { encoding: 'utf8', env: { ...process.env, BEADS_DIR: ui.rec.beads_dir }, timeout: 60000 });
  return JSON.parse(out.slice(out.indexOf('[')));
}

export default async function (ui) {
  const result = {};
  const note = (k, v) => { result[k] = v; fs.writeFileSync(path.join(ui.out, 'result.json'), JSON.stringify(result, null, 2)); };
  try {
    await run(ui, note);
  } finally {
    try { note('final_line', line(ui)); note('final_receipts', receipts(ui).slice(-3)); } catch (e) { note('final_error', String(e)); }
  }
}

async function run(ui, note) {
  // Turbo's own default would fail at once: the run below must come from the input box's pick
  cli(ui, ['turbo', 'config', '--engine', 'codex', '--model', 'no-such-model-e2e', '--json']);
  note('nextup_settings', cli(ui, ['nextup', 'settings', '--json']));

  await ui.openAgents(ui.demoFolder);
  await offScreen(ui);
  await newSessionInProject(ui, ui.demoFolder);
  await ui.sleep(2000);
  await closeTips(ui); // a first-time tip can come up a moment after the page
  await ui.pickEngine('OpenCode', 360000);
  note('model', await pickModel(ui));

  // 1 task-9rxf: the person says what to do now and two things for some other time
  await focusInput(ui);
  await ui.type(A1);
  await ui.press('Enter', { send: true });
  const first = await until(ui, async () => { const d = await ui.eval(LINE_DOM); return d && /Noted/.test(d.line) ? d : null; }, 'the line under the message', 120000, 500);
  note('line_first', first);
  const r1 = await until(ui, async () => receipts(ui).find(r => /some day/.test(r.text || '')), 'the receipt', 30000);
  note('receipt_a1', r1);
  const later = r1.items.filter(i => /dark|footer/i.test(i.title));
  assert.ok(later.length >= 1, 'the later things were not noted: ' + JSON.stringify(r1.items));
  assert.ok(later.every(i => i.state === 'later'), 'a thing said for later is not in Later: ' + JSON.stringify(later));
  assert.equal(line(ui).paused, true, 'Start by itself is on');
  await ui.click({ css: '.dispatch-capture-line' });
  await ui.waitFor({ css: '.dispatch-capture-panel' }, { timeoutMs: 15000 });
  await restPointer(ui);
  await ui.screenshot('01-later-things-wait-in-later');
  await ui.mark({ css: '.dispatch-capture-panel' }, { what: '说了以后再做的 dark mode、footer 进 Later，不排队、不开工', where: '会话里你那句话下面', how: '点那一行展开' });
  if (await ui.exists({ css: '.dispatch-capture-hint' })) {
    await ui.mark({ css: '.dispatch-capture-hint' }, { what: '第一次记下时问要不要自己开工（Start by itself），默认不开', where: '那一行下面', how: '只出现一次' });
  }

  // the agent does the README change; nothing else starts meanwhile
  await until(ui, async () => { await approve(ui); return ui.eval(turnDone('/./')); }, 'the agent finishing the README change', 300000, 2000);
  await ui.sleep(25000); // a chatd tick or two
  const sessionsNow = cli(ui, ['agent', 'list', '--json']);
  note('sessions_after_turn', sessionsNow);
  assert.equal(line(ui).next.length, 0, 'something is lined up to start: ' + JSON.stringify(line(ui)));
  assert.ok(sessionsNow.length <= 1, 'another session started by itself: ' + JSON.stringify(sessionsNow));

  // task-b83p: the README change is one task, the agent's (not a second one, not refused)
  const all = tasks(ui);
  const readme = all.filter(t => /demo site|readme|heading|first line/i.test(t.title || ''));
  note('readme_tasks', readme.map(t => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee, labels: t.labels })));
  const said = (await ui.eval(`[...document.querySelectorAll('.interactive-response')].map(r => r.innerText).join('\\n')`)) || '';
  note('agent_said_refused', /已由 .* 认领|already claimed/i.test(said));
  assert.ok(readme.length <= 1, 'the same work is on the board twice: ' + JSON.stringify(readme.map(t => t.title)));
  assert.ok(!/已由 .* 认领并在进行中/.test(said), 'the agent was refused its own task');

  // 2 task-et0q: a note on the diff, Submit Feedback
  const turns = await ui.eval(`document.querySelectorAll('.interactive-request').length`);
  await ui.openTab('Changes');
  await ui.waitFor({ text: 'README.md', exact: true, within: '.changes-file-list', webview: false }, { timeoutMs: 60000 });
  await ui.click({ text: 'README.md', exact: true, within: '.changes-file-list', webview: false });
  await ui.waitFor({ css: '.monaco-diff-editor .editor.modified .view-line' }, { timeoutMs: 30000 });
  await ui.sleep(3000);
  await closeTips(ui);
  await ui.sleep(800);
  await closeTips(ui);
  const box = await ui.eval(`(() => {
    const ed = [...document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line')].find(l => l.textContent.replace(/\\u00a0/g, ' ').includes('Demo site'));
    if (!ed) return null; const s = ed.querySelector('span > span'); const e = ed.querySelector('span > span:last-child') || s;
    const a = s.getBoundingClientRect(), b = e.getBoundingClientRect(); return { x1: a.left + 1, x2: b.right - 1, y: a.top + a.height / 2 };
  })()`);
  assert.ok(box, 'no heading line in the diff');
  await ui.mouse('mouseMoved', box.x1, box.y);
  await ui.mouse('mousePressed', box.x1, box.y, { clickCount: 1 });
  for (let i = 1; i <= 6; i++) await ui.mouse('mouseMoved', box.x1 + (box.x2 - box.x1) * i / 6, box.y, { buttons: 1 });
  await ui.mouse('mouseReleased', box.x2, box.y, { clickCount: 1 });
  await ui.waitFor({ css: '.agent-feedback-input-widget textarea' }, { timeoutMs: 15000 });
  await ui.click({ css: '.agent-feedback-input-widget textarea' });
  await ui.type(NOTE);
  await ui.press('Enter', { send: true });
  await ui.sleep(1200);
  const submit = await until(ui, async () => ui.eval(`[...document.querySelectorAll('a, button, .action-label, .monaco-button')].map(b => (b.getAttribute('aria-label') || b.textContent || '').trim()).find(t => /^Submit Feedback/.test(t)) || ''`), 'Submit Feedback', 20000);
  await ui.click({ aria: submit, exact: true });
  await until(ui, async () => (await ui.eval(`document.querySelectorAll('.interactive-request').length`)) > turns, 'the feedback turn', 30000);
  await ui.sleep(1500);
  // every request row on screen (the sticky header repeats the first one at the end of the list)
  const rows = await until(ui, async () => { const r = await ui.eval(`[...document.querySelectorAll('.interactive-request')].map(r => r.innerText)`); return r.some(t => t.includes('Demo website')) ? r : null; }, 'the note in the chat', 30000).catch(async () => ui.eval(`[...document.querySelectorAll('.interactive-request')].map(r => r.innerText)`));
  const sent = rows.find(t => t.includes('Demo website')) || rows.join('\n---\n');
  const prompts = await ui.eval(`[...document.querySelectorAll('[aria-label^="Prompt: "]')].map(e => e.getAttribute('aria-label'))`);
  note('feedback_turn', { sent, prompts });
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot('02-feedback-turn-shows-the-note');
  await ui.mark({ text: 'Make this heading "# Demo website" instead.', exact: true }, { what: '批注发出的那一轮显示你写的批注（原来是 /act-on-feedback）', where: '对话里最新一条你的消息', how: 'Changes 里选一行写批注，点 Submit Feedback' });
  assert.ok(sent.includes('Demo website'), 'the turn does not show the note: ' + sent);
  assert.ok(!rows.some(t => /\/act-on-feedback/.test(t)), 'a turn still shows /act-on-feedback: ' + JSON.stringify(rows));
  assert.ok(!prompts.some(p => /act-on-feedback/.test(p)), 'the prompts list shows /act-on-feedback: ' + JSON.stringify(prompts));
  if (prompts.length) assert.ok(prompts.some(p => /Demo website/.test(p)), 'the prompts list does not show the note: ' + JSON.stringify(prompts));
  await until(ui, async () => { await approve(ui); return ui.eval(turnDone('/./')); }, 'the agent acting on the note', 300000, 2000);

  // 3 task-e04j: the agent asks with its question tool; "Type your own answer" is the text box
  await focusInput(ui, '.interactive-session .chat-input-container .monaco-editor, .interactive-input-part .monaco-editor');
  await ui.type(ASK);
  await ui.press('Enter', { send: true });
  const card = await until(ui, async () => ui.eval(`(() => {
    const c = [...document.querySelectorAll('.chat-question-carousel-widget-container, .chat-question-carousel-container')].at(-1);
    if (!c || !c.offsetParent) return null;
    return { text: c.innerText.replace(/\\s+/g, ' ').trim(), options: [...c.querySelectorAll('[role="option"]')].map(o => o.innerText.replace(/\\s+/g, ' ').trim()),
      box: !!c.querySelector('textarea, input[type="text"]') };
  })()`), 'the question card', 240000, 1000).catch(e => { note('question_card_missing', String(e)); return null; });
  note('question_card', card);
  if (card) {
    await restPointer(ui);
    await ui.screenshot('03-question-card');
    await ui.mark({ css: '.chat-question-carousel-container' }, { what: '提问卡：「Type your own answer」不再是一个会直接交空答案的选项，下面是输入框', where: '对话里 Agent 提问时', how: 'Agent 用提问工具问你时' });
    assert.ok(!card.options.some(o => /type your own answer/i.test(o)), 'the card lists "Type your own answer" as a choice: ' + JSON.stringify(card.options));
    // the Agents window takes a typed answer in the message box under the card ("Pick an option above, or type your own answer")
    const hint = await ui.eval(`(document.querySelector('.interactive-input-part .monaco-editor')?.closest('.interactive-input-part')?.innerText || '').replace(/\\s+/g, ' ')`);
    note('question_input_hint', hint.slice(0, 200));
    await focusInput(ui, '.interactive-session .chat-input-container .monaco-editor, .interactive-input-part .monaco-editor');
    await ui.type(TYPED);
    await ui.press('Enter', { send: true });
    await until(ui, async () => { await approve(ui); return ui.eval(turnDone('/NAME=/')); }, 'the agent saying what it got', 240000, 2000);
    const got = await ui.eval(lastResponse);
    note('question_answer', got.slice(0, 400));
    await restPointer(ui);
    await ui.screenshot('04-typed-answer-reached-the-agent');
    assert.ok(/Test User/.test(got), 'the typed answer did not reach the agent: ' + got.slice(0, 300));
  }

  // 4 task-b83p in a chat with no project (the Assistant's place until 2026-11-11): two things for later go on the board once each
  await openNewChat(ui);
  await ui.sleep(2000);
  await closeTips(ui);
  await ui.pickEngine('OpenCode', 360000);
  note('assistant_model', await pickModel(ui));
  await focusInput(ui);
  await ui.type(LATER_TWO);
  await ui.press('Enter', { send: true });
  await until(ui, async () => { await approve(ui); return ui.eval(turnDone('/./')); }, 'the Assistant answering', 300000, 2000);
  await ui.sleep(15000);
  const board = tasks(ui);
  const print = board.filter(t => /print/i.test(t.title || ''));
  const faq = board.filter(t => /faq/i.test(t.title || ''));
  note('assistant_tasks', { print: print.map(t => [t.id, t.title, t.status, t.labels]), faq: faq.map(t => [t.id, t.title, t.status, t.labels]) });
  await restPointer(ui);
  await ui.screenshot('05-assistant-noted-once');
  assert.ok(print.length <= 1 && faq.length <= 1, 'the same thing is on the board twice: ' + JSON.stringify({ print, faq }));
  assert.ok(print.length + faq.length >= 1, 'nothing was noted');

  // 5 task-o8wx: Turbo with the agent picked in the input box (a new chat's page)
  await openNewChat(ui);
  await ui.sleep(2000);
  await closeTips(ui);
  await ui.pickEngine('OpenCode', 360000);
  const picked = await pickModel(ui);
  note('turbo_model', picked);
  await ui.waitFor({ css: '.dispatch-turbo-chip' }, { timeoutMs: 30000 });
  if (!(await ui.eval(`document.body.classList.contains('dispatch-turbo-on')`))) await ui.click({ text: 'Turbo', exact: true, within: '.dispatch-turbo-chip' });
  await ui.click({ css: '.sessions-chat-editor' });
  await ui.sleep(400);
  await ui.type(JOB);
  await ui.press('Enter', { send: true });
  const run = await until(ui, async () => (cli(ui, ['turbo', 'list', '--json']) || []).find(r => /robots/i.test(r.title || '')), 'the Turbo run', 60000, 1000);
  note('turbo_run', run);
  assert.equal(run.engine, 'opencode', 'Turbo did not use the picked agent: ' + JSON.stringify(run));
  const ended = await until(ui, async () => { const r = (cli(ui, ['turbo', 'list', '--json']) || []).find(x => x.id === run.id); return r && r.state !== 'planning' ? r : null; }, 'the split ending', 600000, 3000);
  const full = cli(ui, ['turbo', 'status', run.id, '--json']);
  note('turbo_split', { state: ended.state, engine: full.engine, model: full.model, error: full.error || '', parts: (full.parts || []).map(p => p.name) });
  await restPointer(ui);
  await ui.screenshot('06-turbo-plan-with-opencode');
  await ui.mark({ css: '.dispatch-timeline' }, { what: 'Turbo 用输入框上选的 OpenCode 和模型拆分', where: 'Assistant 首页 Timeline', how: '选好 Agent 和模型，打开 Turbo 发一句话' });
  assert.equal(full.engine, 'opencode');
  if (ended.state === 'failed') assert.match(full.error || '', /OpenCode/, 'a failed split does not name the agent: ' + full.error);
  try { cli(ui, ['turbo', 'cancel', run.id, '--json']); } catch { /* already over */ }
}
