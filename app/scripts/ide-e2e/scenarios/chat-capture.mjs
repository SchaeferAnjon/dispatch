// What you ask for in a chat goes on the board by itself and lines up (task-tix5, design/chat-capture direction B).
// The person's path: in a session in the demo project they mention two things for later in one message; a line
// under the message says "Noted 2 · later": what they said is for later waits in Later and nothing starts
// (task-9rxf); they open it and line both up (Line it up), take one off and put it back (Not a task, Undo), move
// the second to the front; Start by itself is off until they turn it on, so both wait ("on hold"); "thanks" gets no
// line. The project's Tasks tab shows Next up with the two lined up, on hold (since 2026-11-11 the place the line lives;
// the Assistant's Now that showed it is gone). Start by itself:
// the first one starts by itself, and when it is done the next one starts by itself. Test model: OpenCode GLM 5.3
// Flash (the line's own reading uses the same key).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
export const meta = { needs: ['opencode'], title: 'Noted from the chat, lined up', description: 'Two things said in passing go on the board, line up, and start one after the other.', timeout: 1800 };

const fresh = '.sessions-chat-editor';
// E2E_OPENCODE_MODEL=<provider/model>: a cheap model the Mac running the test has (the mini has OpenCode's free ones)
export const MODEL = process.env.E2E_OPENCODE_MODEL || process.env.DISPATCH_E2E_OPENCODE_MODEL || 'zhipuai-coding-plan/glm-5.3-flash'; // the model the run was given (e2e_suite)
export const MESSAGE = 'Two small things for this project, for later: add a file CHANGELOG.md with the line "First release", and add a file CONTRIBUTING.md that says "Pull requests welcome". Do not do them now and do not use any tools. Just reply OK.';

function assert(v, m) { if (!v) throw new Error(m); }

export function cli(ui, args, timeout = 60000) {
  const out = execFileSync(join(ui.rec.bin_dir, 'dispatch'), args, { encoding: 'utf8', timeout });
  const i = Math.min(...['{', '['].map(c => out.indexOf(c)).filter(x => x >= 0));
  return JSON.parse(out.slice(i));
}

export async function until(ui, fn, what, ms = 120000, every = 1000) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await ui.sleep(every);
  }
  throw new Error(`Timed out: ${what}`);
}

export async function offScreen(ui) {
  try {
    const { windowId } = await ui.cdp.send('Browser.getWindowForTarget', {});
    await ui.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -3000, top: -3000 } });
  } catch { /* the run still works */ }
}

export async function closeTips(ui) {
  for (let i = 0; i < 5 && (await ui.exists({ css: 'button.dispatch-tour-close' })); i++) {
    await ui.click({ css: 'button.dispatch-tour-close' });
    await ui.sleep(600);
  }
}

export async function restPointer(ui) {
  await ui.mouse('mouseMoved', 1300, 640);
  await ui.sleep(700);
}

/** A new session in the demo project the way a person starts one: Projects, the project, New Session. */
export async function newSessionInProject(ui, folder) {
  const name = folder.split('/').filter(Boolean).at(-1);
  await closeTips(ui);
  for (let attempt = 0; ; attempt++) {
    await ui.click('Projects');
    try { await ui.waitFor({ css: '.dispatch-projects-toolbar' }, { timeoutMs: 20000 }); await ui.click({ text: 'All', exact: true, within: '.dispatch-projects-toolbar' }); } catch { /* no filter bar */ }
    try { await ui.waitFor({ text: name, exact: true, within: '.dispatch-projects-page' }, { timeoutMs: 45000 }); break; } catch (e) { if (attempt >= 3) throw e; }
  }
  const pageButton = (label) => ui.eval(`(() => {
    const els = [...document.querySelectorAll('a, button, .monaco-button, .action-label')]
      .filter(e => ((e.getAttribute('aria-label') || '').split(' (')[0].trim() === ${JSON.stringify(label)} || (e.innerText || '').trim() === ${JSON.stringify(label)}))
      .map(e => ({ r: e.getBoundingClientRect() })).filter(x => x.r.width > 0 && x.r.left > 400)
      .sort((a, b) => b.r.left - a.r.left);
    return els[0] ? { x: els[0].r.left + els[0].r.width / 2, y: els[0].r.top + els[0].r.height / 2 } : null;
  })()`);
  const press = async (b) => {
    await ui.mouse('mouseMoved', b.x, b.y);
    await ui.mouse('mousePressed', b.x, b.y, { clickCount: 1 });
    await ui.mouse('mouseReleased', b.x, b.y, { clickCount: 1 });
  };
  let first = null;
  for (let attempt = 0; attempt < 4 && !first; attempt++) {
    await closeTips(ui);
    try { await ui.click({ text: name, exact: true, within: '.dispatch-projects-page' }); } catch { /* open already */ }
    first = await until(ui, async () => (await pageButton('New Session')) || (await pageButton('Add as Project')) ? true : null, 'the project page buttons', 15000).catch(() => null);
  }
  if (!first) throw new Error('The project page did not open');
  if (!(await pageButton('New Session'))) await press(await pageButton('Add as Project'));
  await press(await until(ui, async () => pageButton('New Session'), "the project page's New Session", 60000));
  await until(ui, async () => ui.eval(`(document.querySelector('.part.titlebar')?.innerText || '').includes(${JSON.stringify(name)}) && !!document.querySelector('.sessions-chat-session-type-picker')`), `a new session in ${name}`, 60000);
}

export async function focusInput(ui, css = fresh) {
  for (let i = 0; i < 8; i++) {
    await ui.click({ css: i % 2 ? `${css} .view-lines` : css });
    await ui.sleep(400);
    if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('${css}')`)) return;
    await ui.sleep(800);
  }
  throw new Error('The message box does not take the focus');
}

/** The session's own model: GLM 5.3 Flash from the slash menu (DeepSeek Flash or a free Flash when it is missing). */
export async function pickModel(ui) {
  await focusInput(ui);
  await ui.type('/model');
  await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 30000 });
  let seen = '';
  const row = await until(ui, async () => {
    const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => ({name:r.querySelector('.dsm-name')?.textContent}))`);
    seen = rows.map(r => r.name).join(', ');
    return ui.cheapModel(rows);
  }, 'a test model', 45000).catch(e => { throw new Error(`${e.message}; the menu had: ${seen}`); });
  const typed = async () => ui.eval(`document.querySelector('${fresh} .view-lines')?.textContent || ''`);
  for (let i = 0; i < 40 && (await typed()).trim(); i++) await ui.press('Backspace');
  await ui.type(`/${row.name.replace(/\s+/g, '')}`);
  await until(ui, async () => ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row .dsm-name')].some(n => n.textContent === ${JSON.stringify(row.name)})`), `the menu row ${row.name}`, 20000);
  await ui.click({ text: row.name, exact: true, within: '.dispatch-slash-menu' });
  await ui.press('Escape');
  return row.name;
}

/** A new chat's page (Chats' +, a conversation with no project): where a job across projects is asked and the Turbo
 *  switch is (the Assistant's page until 2026-11-11). */
export async function openNewChat(ui) {
  await closeTips(ui);
  // the palette, for sure: an F1 right after the window comes up can go nowhere
  for (let p = 0; p < 5 && !(await ui.exists({ css: '.quick-input-widget input' })); p++) {
  	await ui.press('F1');
  	await ui.sleep(800);
  }
  await ui.type('New Quick Chat', { into: { css: '.quick-input-widget input' } });
  await ui.sleep(800);
  await ui.press('Enter');
  await ui.waitFor({ css: fresh }, { timeoutMs: 30000 });
  await closeTips(ui);
}

/** The receipts as the CLI has them, and the line as the window shows it. */
export const receipts = (ui) => cli(ui, ['capture', 'list', '--json']).receipts || [];
export const line = (ui) => cli(ui, ['nextup', '--json']);
export const LINE_DOM = `(() => {
  const host = [...document.querySelectorAll('.dispatch-capture')].find(h => !h.classList.contains('empty') && h.querySelector('.dispatch-capture-line'));
  if (!host) return null;
  return {
    line: host.querySelector('.dispatch-capture-line')?.innerText.replace(/\\s+/g, ' ').trim() || '',
    blocks: [...host.querySelectorAll('.dispatch-capture-line .dispatch-block')].map(b => b.className.replace('dispatch-block', '').trim()),
    hint: host.querySelector('.dispatch-capture-hint')?.innerText.replace(/\\s+/g, ' ').trim() || '',
    rows: [...host.querySelectorAll('.dispatch-capture-row')].map(r => ({ task: r.dataset.task, state: r.dataset.state, title: r.querySelector('.dispatch-capture-title')?.innerText || '', sub: r.querySelector('.dispatch-capture-sub')?.innerText || '' })),
    paused: host.querySelector('.dispatch-capture-pause')?.dataset.paused || '',
  };
})()`;

export async function waitReply(ui, re, ms = 180000) {
  return until(ui, async () => ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return !!r && !r.classList.contains('chat-response-loading') && ${re}.test(r.innerText); })()`), `the reply ${re}`, ms);
}

/** For a run on a build without this feature (the delivery page's "before"): the same message, nothing else. */
export async function sendOnly(ui) {
  await newSessionInProject(ui, ui.demoFolder);
  await ui.pickEngine('OpenCode', 360000);
  await pickModel(ui);
  await focusInput(ui);
  await ui.type(MESSAGE);
  await ui.press('Enter', { send: true });
  await waitReply(ui, '/\\bOK\\b/i');
  await ui.sleep(6000);
  await restPointer(ui);
}

export default async function (ui) {
  const result = { steps: [] };
  const note = (k, v) => { result[k] = v; writeFileSync(`${ui.out}/result.json`, JSON.stringify(result, null, 2)); };
  try {
    await run(ui, note);
  } finally {
    try { note('final_receipts', receipts(ui)); note('final_line', line(ui)); } catch (e) { note('final_error', String(e)); }
  }
}

async function run(ui, note) {
  // the line starts the work with the cheap model, one at a time (Settings would say the same)
  cli(ui, ['nextup', 'engine', 'opencode', '--model', MODEL, '--json']);
  cli(ui, ['nextup', 'limit', '1', '--json']);

  await ui.openAgents(ui.demoFolder);
  await offScreen(ui);
  await newSessionInProject(ui, ui.demoFolder);
  await ui.pickEngine('OpenCode', 360000);
  note('model', await pickModel(ui));
  await focusInput(ui);
  await ui.type(MESSAGE);
  const sentAt = Date.now();
  await ui.press('Enter', { send: true });

  // 1 the line under the message: both things wait in Later, nothing starts, Start by itself is off (task-9rxf)
  assert(line(ui).paused, 'Start by itself is on for a new person: ' + JSON.stringify(line(ui)));
  const first = await until(ui, async () => {
    const d = await ui.eval(LINE_DOM);
    return d && /Noted 2/.test(d.line) ? d : null;
  }, 'the line "Noted 2" under the message', 90000, 300);
  note('noted_after_ms', Date.now() - sentAt);
  note('line_first', first);
  await ui.screenshot('01-noted-under-the-message');
  await ui.mark({ css: '.dispatch-capture-line' }, { what: '你那句话下面一行：记了 2 件，方块是它们的状态，排第几', where: '会话里，你发的消息正下方靠右', how: '发出带新事的话，一两秒后出现' });
  if (first.hint) await ui.mark({ css: '.dispatch-capture-hint' }, { what: '第一次出现时的一句说明', where: '那一行下面', how: '只出现一次，点 Got it 收起' });
  await ui.click({ css: '.dispatch-capture-line' });
  await ui.waitFor({ css: '.dispatch-capture-panel' }, { timeoutMs: 10000 });
  const said = receipts(ui).at(-1);
  note('said_later', said);
  assert(said.items.filter(i => i.kind === 'new').every(i => i.state === 'later'), 'what was said for later did not go to Later: ' + JSON.stringify(said.items));
  assert(line(ui).next.length === 0, 'something was lined up to start: ' + JSON.stringify(line(ui)));
  await ui.screenshot('01b-said-for-later-waits-in-later');
  // the person lines both up themselves
  for (const it of said.items.filter(i => i.kind === 'new')) {
    await ui.hover({ css: `.dispatch-capture-row[data-task="${it.task}"]` });
    await ui.click({ text: 'Back to Next up', exact: true, within: `.dispatch-capture-row[data-task="${it.task}"]` });
    await until(ui, async () => (await ui.eval(LINE_DOM))?.rows.find(r => r.task === it.task)?.state === 'next', 'the thing lined up', 30000);
  }
  const afterPause = line(ui);
  note('after_pause', afterPause);
  assert(afterPause.paused, 'Start by itself turned on by itself');
  assert(afterPause.next.length + (receipts(ui).at(-1)?.items || []).filter(i => i.state === 'working').length >= 2, 'two things were not noted: ' + JSON.stringify(afterPause));
  const r0 = receipts(ui).at(-1);
  note('receipt', r0);
  assert(r0.items.filter(i => i.kind === 'new').length === 2, 'expected two new things: ' + JSON.stringify(r0.items));
  assert(r0.items.every(i => i.project), 'a noted thing has no project: ' + JSON.stringify(r0.items));
  await until(ui, async () => (await ui.eval(LINE_DOM))?.paused === 'true', 'the panel saying Start by itself is off', 20000);

  // 2 one click takes one off the board, Undo brings it back
  const second = r0.items[1].task;
  await ui.hover({ css: `.dispatch-capture-row[data-task="${second}"]` });
  await ui.click({ text: 'Remove', exact: true, within: `.dispatch-capture-row[data-task="${second}"]` });
  await until(ui, async () => (await ui.eval(LINE_DOM))?.rows.find(r => r.task === second)?.state === 'gone', 'the thing taken off the board', 30000);
  const gone = await ui.eval(LINE_DOM);
  note('after_drop', gone);
  await restPointer(ui);
  await ui.screenshot('02-not-a-task');
  assert(/Noted 1/.test(gone.line), 'the line still counts the dropped one: ' + gone.line);
  await ui.hover({ css: `.dispatch-capture-row[data-task="${second}"]` });
  await ui.click({ text: 'Undo', exact: true, within: `.dispatch-capture-row[data-task="${second}"]` });
  await until(ui, async () => (await ui.eval(LINE_DOM))?.rows.find(r => r.task === second)?.state === 'next', 'the thing back in line', 30000);

  // 3 move the second to the front
  const order0 = line(ui).next.map(x => x.id);
  note('order_before', order0);
  const back = order0.at(-1);
  await ui.hover({ css: `.dispatch-capture-row[data-task="${back}"]` });
  await ui.click({ text: 'Move to front', exact: true, within: `.dispatch-capture-row[data-task="${back}"]` });
  await until(ui, async () => line(ui).next[0]?.id === back, 'the second one at the front', 30000);
  await until(ui, async () => /First in Next up/.test((await ui.eval(LINE_DOM))?.rows.find(r => r.task === back)?.sub || ''), 'the row saying First in Next up', 30000);
  const moved = await ui.eval(LINE_DOM);
  note('after_front', moved);
  await ui.hover({ css: `.dispatch-capture-row[data-task="${order0[0]}"]` });
  await ui.sleep(500);
  await ui.screenshot('03-panel-moved-to-front-paused');
  await ui.mark({ css: '.dispatch-capture-panel' }, { what: '点开：每件一行，排第几、原话；悬停出 Move to front、Not now、Not a task', where: '那一行下面', how: '点那一行' });
  await ui.mark({ css: '.dispatch-capture-pause' }, { what: 'Start by itself / Pause：新用户默认关，打开后排着的才自己开工', where: '面板最下面一行右边', how: '点一下' });
  if (moved.hint) {
    await ui.click({ text: 'Got it', exact: true, within: '.dispatch-capture-hint' });
    await until(ui, async () => !(await ui.exists({ css: '.dispatch-capture-hint' })), 'the hint gone', 20000);
  }

  // 4 chit-chat gets no line
  await waitReply(ui, '/\\bOK\\b/i');
  await focusInput(ui, '.interactive-session .chat-input-container .monaco-editor, .interactive-input-part .monaco-editor');
  const asked = await ui.eval(`document.querySelectorAll('.interactive-request').length`);
  await ui.type('thanks');
  await ui.press('Enter', { send: true });
  // "thanks" itself in the conversation, not the message before it (which has its line)
  await until(ui, async () => ui.eval(`(() => { const reqs = [...document.querySelectorAll('.interactive-request')]; return reqs.length > ${asked} && reqs.some(r => /^\\s*thanks\\s*$/m.test(r.innerText || '')); })()`), 'the "thanks" message', 30000);
  await ui.sleep(6000);
  // the list draws its rows out of order (it reuses them): the request that says thanks, by its words
  const chat = await ui.eval(`(() => { const reqs = [...document.querySelectorAll('.interactive-request')]; const last = reqs.find(r => /^\\s*thanks\\s*$/m.test(r.querySelector('.value, .rendered-markdown')?.innerText || r.innerText)) || reqs.at(-1); const h = last?.querySelector('.dispatch-capture'); return { text: last?.innerText.slice(0, 80) || '', shown: !!h && !h.classList.contains('empty') }; })()`);
  note('thanks_line', chat);
  assert(!chat.shown, 'a line under "thanks": ' + JSON.stringify(chat));

  // 5 the project's Tasks tab: Next up with the two lined up, on hold (Start by itself is off)
  const sessionTitle = await ui.eval(`(document.querySelector('.agent-sessions-viewpane .monaco-list-row.selected .session-title, .agent-sessions-viewpane .monaco-list-row.selected')?.innerText || '').split('\\n')[0].trim()`);
  note('session_title', sessionTitle);
  await ui.openTab('Tasks');
  const NEXT = '.dispatch-nextup-group';
  await until(ui, async () => ui.eval(`[...document.querySelectorAll('${NEXT}')].some(g => g.querySelectorAll('.dispatch-nextup-row:not(.dropped)').length >= 2)`), 'two in Next up', 60000);
  await ui.sleep(1500);
  const home = await ui.eval(`(() => {
    const g = [...document.querySelectorAll('${NEXT}')].find(g => g.querySelectorAll('.dispatch-nextup-row:not(.dropped)').length >= 2);
    return { next: [...g.querySelectorAll('.dispatch-nextup-row:not(.dropped)')].map(r => ({ task: r.dataset.task, text: r.innerText.replace(/\\s+/g, ' ').trim() })),
      note: [...g.querySelectorAll('.dispatch-nextup-note')].map(n => n.innerText.trim()).join(' ') };
  })()`);
  note('next_up', home);
  await restPointer(ui);
  await ui.screenshot('04-tasks-next-up');
  await ui.mark({ css: NEXT }, { what: 'Next up：按顺序，Start by itself 关着时写明不会自己开工', where: '项目的 Tasks 页签', how: '右栏 Tasks' });
  assert(home.next.length === 2, 'Next up does not show the two: ' + JSON.stringify(home.next));
  assert(/Start by itself is off/.test(home.note), 'Next up does not say it is on hold: ' + home.note);

  // 7 Start by itself: the first in line starts by itself; when it is done the next one starts by itself
  const [firstUp, secondUp] = line(ui).next.map(x => x.id);
  note('order_at_resume', [firstUp, secondUp]);
  await ui.click({ text: 'Turn on Start by itself', exact: true, within: NEXT });
  await until(ui, async () => !line(ui).paused, 'resumed', 20000);
  const startedAt = Date.now();
  const state = (tid) => (receipts(ui).flatMap(r => r.items).find(i => i.task === tid) || {}).state;
  await until(ui, async () => state(firstUp) === 'working' || state(firstUp) === 'done', 'the first one starting by itself', 180000, 3000);
  note('first_started_after_s', Math.round((Date.now() - startedAt) / 1000));
  note('second_while_first_runs', state(secondUp));
  assert(state(secondUp) === 'next', 'the second started together with the first: ' + state(secondUp));
  await ui.sleep(4000);
  await restPointer(ui);
  await ui.screenshot('06-home-first-started');
  await until(ui, async () => state(secondUp) === 'working' || state(secondUp) === 'done', 'the next one starting by itself after the first', 900000, 5000);
  note('second_started_after_s', Math.round((Date.now() - startedAt) / 1000));
  note('first_when_second_started', state(firstUp));
  await ui.sleep(4000);
  await restPointer(ui);
  await ui.screenshot('07-home-second-started');

  // 8 back in the session: the line follows (the blocks turn green, then teal)
  try {
    await ui.click({ text: sessionTitle, exact: true, within: '.agent-sessions-viewpane' });
    await until(ui, async () => ui.eval(LINE_DOM), 'the line in the session', 30000);
    // it reads the board again: the things that started or were delivered say so
    await until(ui, async () => {
      const d = await ui.eval(LINE_DOM);
      if (!d?.rows.length) await ui.click({ css: '.dispatch-capture-line' }).catch(() => null);
      return d && d.rows.length && d.rows.every(r => r.state !== 'next');
    }, 'the line catching up with what started', 45000, 2000);
    const after = await ui.eval(LINE_DOM);
    note('line_at_end', after);
    await restPointer(ui);
    await ui.screenshot('08-session-line-at-end');
  } catch (e) {
    note('line_at_end_error', String(e));
    throw e;
  }
}
