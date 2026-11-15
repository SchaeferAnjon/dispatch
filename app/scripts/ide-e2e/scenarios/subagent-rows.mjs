// A chat session's sub-agents as rows under it in the sessions list (task-pqj6, design/terminal-merge direction A,
// A3). The person's path: a new OpenCode session in the demo project asks for two subagent tasks; while one works its
// row sits under the session with the purple block breathing, its name, "· model" and the time; once both are back
// they fold into "Show 2 finished"; the session's row has a chip "⌄ 2" that folds them away and back; pointing at a
// sub-agent shows the hover card; a click opens it read only, with the prompt it was given and its answer.
// Test model: OpenCode GLM 5.3 Flash (DeepSeek Flash or a free Flash when it is missing).
import { writeFileSync } from 'node:fs';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
export const meta = { instance: { motion: true }, needs: ['opencode'], title: '子 Agent 挂在聊天会话下', description: 'OpenCode 聊天会话派出两个子 Agent：在跑时紫色方块在动，回来后收进 Show 2 finished；父行胶囊「⌄ 2」收起展开；悬停出卡片；点开只读，看得到它每一步；重启后子 Agent 和它的步骤都回来。', timeout: 1500 };

const fresh = '.sessions-chat-editor';
const MESSAGE = 'Use your task tool twice, one after the other, to start two general subagents. First: description "Count files", prompt "Run ls -A in the current folder and report how many entries there are. Reply with the number only.". Second: description "Read the README", prompt "Report the first line of README.md in the current folder, or say there is none.". After both are back, reply with one short line saying what they found.';

function assert(v, m) { if (!v) throw new Error(m); }

async function until(ui, fn, what, ms = 120000, every = 500) {
  const end = Date.now() + ms * SCALE;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await ui.sleep(every);
  }
  throw new Error(`Timed out: ${what}`);
}

async function offScreen(ui) {
  try {
    const { windowId } = await ui.cdp.send('Browser.getWindowForTarget', {});
    await ui.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -3000, top: -3000 } });
  } catch { /* the run still works */ }
}

async function closeTips(ui) {
  for (let i = 0; i < 5 && (await ui.exists({ css: 'button.dispatch-tour-close' })); i++) {
    await ui.click({ css: 'button.dispatch-tour-close' });
    await ui.sleep(600);
  }
}

/** A new session in the demo project the way a person starts one: Projects, the project, New Session. */
async function newSessionInProject(ui, folder) {
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

async function focusInput(ui, css = fresh) {
  for (let i = 0; i < 8; i++) {
    await ui.click({ css: i % 2 ? `${css} .view-lines` : css });
    await ui.sleep(400);
    if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('${css}')`)) return;
    await ui.sleep(800);
  }
  throw new Error('The message box does not take the focus');
}

/** The session's own model: GLM 5.3 Flash from the slash menu (DeepSeek Flash or a free Flash when it is missing). */
async function pickModel(ui) {
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

/** This session's row and the rows under it (another scenario in the same instance may have sessions with sub-agents). */
const MINE = `(() => {
  const rows = [...document.querySelectorAll('.session-item, .session-chat-item')].filter(e => e.offsetParent)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  // the session this scenario started: its first words, or (once it has named itself) the one with sub-agents
  let at = rows.findIndex(e => e.classList.contains('session-item') && /Use your task tool/.test(e.innerText));
  if (at < 0) at = rows.findIndex(e => e.classList.contains('session-item') && e.querySelector('.dispatch-has-subagents, .dispatch-subagent-count:not([style*="none"])'));
  if (at < 0) return { session: null, chats: [] };
  const chats = [];
  for (const e of rows.slice(at + 1)) { if (e.classList.contains('session-item')) break; chats.push(e); }
  return { session: rows[at], chats };
})()`;

/** The rows under this session, as a person sees them. */
const ROWS = `(() => ${MINE}.chats.map(e => ({
  text: (e.innerText || '').replace(/\\s+/g, ' ').trim(),
  sub: e.classList.contains('dispatch-subagent'), more: e.classList.contains('dispatch-subagent-more'),
  block: e.querySelector('.dispatch-subagent-block .dispatch-block')?.className.replace('dispatch-block', '').trim() || '',
  model: e.querySelector('.dispatch-subagent-model')?.textContent || '', time: e.querySelector('.dispatch-subagent-time')?.textContent || '',
  icon: !!(e.querySelector('.session-chat-icon') && e.querySelector('.session-chat-icon').offsetParent),
})))()`;

const COUNT = `(() => { const s = ${MINE}.session; const b = s && [...s.querySelectorAll('.dispatch-subagent-count')].find(e => e.offsetParent); if (!b) return null; const r = b.getBoundingClientRect(); return { text: b.innerText.trim(), title: b.title, x: r.left + r.width / 2, y: r.top + r.height / 2, shut: !!b.querySelector('.shut') }; })()`;

async function pressAt(ui, p) {
  await ui.mouse('mouseMoved', p.x, p.y);
  await ui.sleep(300);
  await ui.mouse('mousePressed', p.x, p.y, { clickCount: 1 });
  await ui.mouse('mouseReleased', p.x, p.y, { clickCount: 1 });
  await ui.sleep(700);
}

const rowAt = (ui, test) => ui.eval(`(() => { const e = ${MINE}.chats.find(e => ${test}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + Math.min(80, r.width / 2), y: r.top + r.height / 2 }; })()`);

export default async function (ui) {
  const facts = { steps: [] };
  const note = (k, v) => { facts[k] = v; writeFileSync(`${ui.out}/facts.json`, JSON.stringify(facts, null, 1)); };

  await ui.openAgents(ui.demoFolder);
  await offScreen(ui);
  await newSessionInProject(ui, ui.demoFolder);
  await ui.pickEngine('OpenCode', 360000);
  note('model', await pickModel(ui));
  await focusInput(ui);
  await ui.type(MESSAGE);
  const sentAt = Date.now();
  await ui.press('Enter', { send: true });

  // 1 while a sub-agent works: its row under the session, the purple block breathing, "· model", the time
  const working = await until(ui, async () => {
    const rows = await ui.eval(ROWS);
    const w = rows.find(r => r.sub && /sub-agent/.test(r.block));
    return w ? { rows, w } : null;
  }, 'a working sub-agent row under the session', 300000, 250);
  note('working_after_ms', Date.now() - sentAt);
  note('working_rows', working.rows);
  assert(/breathe/.test(working.w.block), `the working block breathes: ${working.w.block}`);
  assert(/^· /.test(working.w.model), `the row names the model: ${JSON.stringify(working.w)}`);
  assert(/^\d+s$|^\d+m$/.test(working.w.time), `the row says how long: ${working.w.time}`);
  assert(!working.w.icon, 'the state block takes the place of the status icon');
  const breath = await ui.eval(`(() => { const b = document.querySelector('.dispatch-subagent-block .dispatch-block.sub-agent .b'); return b ? getComputedStyle(b).animationName : ''; })()`);
  note('working_animation', breath);
  assert(breath && breath !== 'none', `the working block moves (animation ${breath})`);
  const countWorking = await ui.eval(COUNT);
  note('count_working', countWorking);
  assert(countWorking && /\d+ sub-agents?, [1-9]\d* working/.test(countWorking.title), `the chip says how many work: ${JSON.stringify(countWorking)}`);
  await ui.screenshot('01-working');
  await ui.mark({ css: '.session-chat-item.dispatch-subagent' }, { what: '在跑的子 Agent：紫色方块在动，名字、· 模型、跑了多久', where: '左栏，派它的会话下面', how: '会话派出子 Agent 时自己出现' });
  await ui.mark({ css: '.dispatch-subagent-count' }, { what: '父行的胶囊：一共几个，悬停写几个在跑', where: '会话名字后面', how: '点它收起或展开' });

  // 2 both back: they fold into "Show 2 finished"; the chip says 2, none working
  const done = await until(ui, async () => {
    const rows = await ui.eval(ROWS);
    const count = await ui.eval(COUNT);
    return rows.some(r => r.more && /Show 2 finished/.test(r.text)) && !rows.some(r => r.sub && !r.more) && count && /2 sub-agents, 0 working/.test(count.title) ? { rows, count } : null;
  }, 'both sub-agents back behind "Show 2 finished"', 420000, 1000);
  note('done_rows', done.rows);
  note('count_done', done.count);
  assert(done.count.text === '2', `the chip reads 2: ${done.count.text}`);
  await ui.sleep(1500);
  await ui.screenshot('02-finished-folded');
  await ui.mark({ css: '.session-chat-item.dispatch-subagent-more' }, { what: '做完的收进一行 Show 2 finished，不占地方', where: '会话下面', how: '子 Agent 回来后自动收起' });

  // 3 "Show 2 finished" shows them: the teal done blocks, model, how long each took
  await pressAt(ui, await rowAt(ui, `e.classList.contains('dispatch-subagent-more')`));
  const shown = await until(ui, async () => {
    const rows = (await ui.eval(ROWS)).filter(r => r.sub && !r.more);
    return rows.length === 2 && rows.every(r => /done/.test(r.block)) ? rows : null;
  }, 'the two finished sub-agents shown with done blocks', 20000);
  note('shown_rows', shown);
  assert(shown.some(r => /Count files/i.test(r.text)) && shown.some(r => /README/i.test(r.text)), `the rows are named after their tasks: ${JSON.stringify(shown)}`);
  await ui.mouse('mouseMoved', 1300, 640);
  await ui.sleep(800);
  await ui.screenshot('03-finished-shown');
  await ui.mark({ css: '.session-chat-item.dispatch-subagent' }, { what: '做完的子 Agent：青色方块，名字、· 模型、用了多久', where: '点 Show 2 finished 以后', how: '点那一行' });

  // 4 pointing at one shows the hover card
  // the way a hand rests on a row: onto it, a little drift, wait; again if the list drew the row anew meanwhile
  const cardText = () => ui.eval(`(() => { const c = [...document.querySelectorAll('.dispatch-hover-card')].find(e => e.offsetParent); return c ? c.innerText.replace(/\\s+/g, ' ').trim() : null; })()`);
  let target, card = null;
  for (let attempt = 0; attempt < 6 && !card; attempt++) {
    target = await rowAt(ui, `e.classList.contains('dispatch-subagent') && /Count files/i.test(e.innerText)`);
    await ui.mouse('mouseMoved', target.x - 40, target.y + 30);
    await ui.sleep(200);
    await ui.mouse('mouseMoved', target.x, target.y);
    await ui.sleep(150);
    await ui.mouse('mouseMoved', target.x + 2, target.y);
    card = await until(ui, cardText, 'the hover card of a sub-agent', 4000, 300).catch(() => null);
  }
  note('hover_attempts', card ? 'shown' : 'never');
  assert(card, 'the hover card of a sub-agent');
  note('hover_card', card);
  assert(/Count files/i.test(card) && /Finished, took (\d+s|\d+m|\d+h \d+m)\b/.test(card) && /Sent by/.test(card) && /read only/i.test(card) && !/· ·/.test(card), `the card: ${card}`);
  await ui.screenshot('04-hover-card');
  // the card can close on its own once shot (the list draws the row again): the mark is a nice-to-have
  await ui.mark({ css: '.dispatch-hover-card' }, { what: '悬停卡：做了多久、模型、谁派的、只读', where: '指着一个子 Agent', how: '停半秒' }).catch(() => undefined);

  // 5 a click opens it read only: the prompt it was given, its answer, no box to type in
  await pressAt(ui, target);
  const opened = await until(ui, async () => ui.eval(`(() => {
    const req = [...document.querySelectorAll('.interactive-request')].filter(e => e.offsetParent).map(e => e.innerText).join(' ');
    const res = [...document.querySelectorAll('.interactive-response')].filter(e => e.offsetParent).map(e => e.innerText).join(' ');
    const box = [...document.querySelectorAll('.interactive-input-part, ${fresh}')].some(e => e.offsetParent && e.getBoundingClientRect().height > 20);
    return /ls -A/.test(req) ? { req: req.slice(0, 300), res: res.slice(0, 300), box } : null;
  })()`), 'the sub-agent opened with its prompt', 20000, 500);
  note('opened', opened);
  assert(opened.res.trim().length > 0, 'its answer is there');
  // task-4bkhf: its own steps are there too (OpenCode's server carries the child session's tool calls), folded under
  // "Finished with N steps" as in any finished turn: open it as a person does
  const stepsFold = { text: 'Finished with', within: '.interactive-response' };
  note('steps_folded', await ui.eval(`[...document.querySelectorAll('.interactive-response')].filter(e => e.offsetParent).map(e => e.innerText).join(' ').match(/Finished with \\d+ steps?/)?.[0] || ''`));
  // a getting-started tip can show up by now (Waiting for you got its first item) and sit over the chat
  for (let i = 0; i < 5 && (await ui.exists({ css: 'button.dispatch-tour-close' })); i++) { await ui.click({ css: 'button.dispatch-tour-close' }); await ui.sleep(500); }
  if (await ui.exists(stepsFold)) await ui.click(stepsFold);
  const steps = await until(ui, async () => ui.eval(`(() => { const res = [...document.querySelectorAll('.interactive-response')].filter(e => e.offsetParent).map(e => e.innerText).join(' '); return /ls -A/.test(res) ? res.slice(0, 400) : null; })()`), "the sub-agent's own steps (its ls -A)", 20000, 500);
  note('opened_steps', steps);
  await ui.screenshot('05-opened-read-only');
  await ui.mark({ css: '.interactive-response' }, { what: '子 Agent 的每一步：它跑的命令、读的文件、最后的回答', where: '点开左栏的子 Agent', how: '在跑时一步步出来，重开后还在' }).catch(() => undefined);

  // 6 the chip folds them away and brings them back
  const isFolded = async () => {
    const rows = await ui.eval(ROWS);
    const c = await ui.eval(COUNT);
    return !rows.some(r => r.sub || r.more) && c && c.shut ? c : null;
  };
  // the chip stays where it is when the pointer comes onto the row: the row's own buttons (Pin, Done) come in at its
  // end on hover, and a chip that moved for them put Pin under the pointer (10-09: a press on the chip pinned the session)
  const before = await ui.eval(COUNT);
  await ui.mouse('mouseMoved', before.x, before.y);
  await ui.sleep(800);
  const hovered = await ui.eval(`(() => { const c = ${COUNT}; const p = ${JSON.stringify({ x: before.x, y: before.y })}; const e = document.elementFromPoint(p.x, p.y); return { c, under: e ? (e.closest('.dispatch-subagent-count') ? 'count' : (e.closest('.action-item')?.querySelector('[aria-label]')?.getAttribute('aria-label') || e.className || e.tagName).toString().slice(0, 80)) : null }; })()`);
  note('chip_on_hover', { before, after: hovered.c, under: hovered.under });
  assert(hovered.under === 'count' && Math.abs(hovered.c.x - before.x) < 1, `the chip stays under the pointer when the row shows its buttons: was at ${before.x}, now ${hovered.c?.x}, under the pointer ${hovered.under}`);
  // a press that lands while the list is drawn again (a session's status changing) does nothing: pressed again, at
  // where the chip is now, only while nothing folded
  for (let attempt = 0; attempt < 3 && !(await isFolded()); attempt++) {
    await pressAt(ui, await ui.eval(COUNT));
    for (let i = 0; i < 8 && !(await isFolded()); i++) await ui.sleep(500);
  }
  const folded = await until(ui, isFolded, 'the chip folds the sub-agents away', 10000).catch(async (e) => {
    throw new Error(`${e.message}; rows ${JSON.stringify(await ui.eval(ROWS).catch(() => null))}; count ${JSON.stringify(await ui.eval(COUNT).catch(() => null))}; at the count: ${await ui.eval(`(() => { const c = ${COUNT}; if (!c) return null; const e = document.elementFromPoint(c.x, c.y); return e ? (e.className || e.tagName).toString().slice(0, 80) : null; })()`).catch(() => null)}`);
  });
  note('folded', folded);
  assert(/Click to show them/.test(folded.title), `the chip says it shows them now: ${folded.title}`);
  await ui.screenshot('06-folded');
  await pressAt(ui, await ui.eval(COUNT));
  const back = await until(ui, async () => (await ui.eval(ROWS)).filter(r => r.sub || r.more).length ? true : null, 'the chip brings them back', 10000);
  note('unfolded', back);

  // 7 task-4bkhf: after the agents' host starts again (as after reopening Dispatch), the sub-agents come back
  // under the session, and one opened shows its steps again (read back from OpenCode's own record)
  await ui.press('F1');
  await ui.waitFor({ css: '.quick-input-widget .quick-input-box input' }, { timeoutMs: 10000 });
  await ui.type('Restart Local Agent Host', { into: { css: '.quick-input-widget .quick-input-box input' } });
  await until(ui, async () => ui.eval(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].some(r => r.offsetParent && /Restart Local Agent Host/.test(r.innerText))`), 'the restart command', 15000);
  await ui.press('Enter');
  await ui.sleep(8000);
  const sessionRow = await until(ui, async () => ui.eval(`(() => { const s = ${MINE}.session; if (!s) return null; const r = s.getBoundingClientRect(); return { x: r.left + 80, y: r.top + r.height / 2 }; })()`), 'the session row after the restart', 120000, 1000);
  await pressAt(ui, sessionRow);
  const restored = await until(ui, async () => {
    const rows = await ui.eval(ROWS);
    return rows.some(r => r.sub || r.more) ? rows : null;
  }, 'the sub-agents back under the session after the restart', 180000, 1500);
  note('restored_rows', restored);
  if (restored.some(r => r.more)) await pressAt(ui, await rowAt(ui, `e.classList.contains('dispatch-subagent-more')`));
  const again = await until(ui, async () => rowAt(ui, `e.classList.contains('dispatch-subagent') && /Count files/i.test(e.innerText)`), 'the Count files sub-agent after the restart', 30000);
  await ui.screenshot('07-restored-rows');
  await pressAt(ui, again);
  const restoredSteps = await until(ui, async () => ui.eval(`(() => { const res = [...document.querySelectorAll('.interactive-response')].filter(e => e.offsetParent).map(e => e.innerText).join(' '); return /ls -A/.test(res) ? res.slice(0, 400) : null; })()`), "the sub-agent's steps after the restart", 60000, 1000);
  note('restored_steps', restoredSteps);
  await ui.screenshot('08-restored-steps');
  await ui.mark({ css: '.interactive-response' }, { what: '重开以后子 Agent 还在，点开每一步都在', where: '左栏会话下面的子 Agent', how: '重开 Dispatch 后点它' }).catch(() => undefined);
  note('took_ms', Date.now() - sentAt);
}
