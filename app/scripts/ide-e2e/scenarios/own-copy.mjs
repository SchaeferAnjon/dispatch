// A session changes the project folder itself (task-lj06.16, the person's choice of 2026-10-07): a new session's
// Separate copy is off; OpenCode says DONE and the file is in the project folder already. Two sessions at once: the
// second one says it works in a separate copy, and when it is done its commit is in the folder by itself. Both sides
// change the same line: no half merge in the folder, a question card asks in plain words; Let the agent combine
// them, and the combined change goes in. Test model: OpenCode DeepSeek Flash (or GLM Flash, or OpenCode's free Flash).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

export const meta = { needs: ['opencode'], title: 'Agents change the project folder; a copy only next to another agent', description: 'Done means the change is in the folder. A second session at the same time works in a copy that goes back by itself; overlapping lines get a question card.', timeout: 2400 };

const fresh = '.sessions-chat-editor';

// the helpers of chat-capture-panes.mjs, here so the build service can run this file on its own
async function until(ui, fn, what, ms = 120000, every = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
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

async function restPointer(ui) {
  await ui.mouse('mouseMoved', 1300, 640);
  await ui.sleep(700);
}

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

const ID = ['-c', 'user.name=Dispatch Test', '-c', 'user.email=test@dispatch.invalid', '-c', 'commit.gpgsign=false'];
function assert(v, m) { if (!v) throw new Error(m); }
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8' }).trim();
const transcript = (ui) => ui.eval(`(() => [...document.querySelectorAll('.interactive-item-container')].map(e => e.innerText).join('\\n'))()`);
const lastReply = `(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return r ? { text: (r.querySelector('.value') || r).innerText, done: !r.classList.contains('chat-response-loading') } : null; })()`;

async function pickTestModel(ui) {
  await focusInput(ui);
  await ui.type('/model');
  await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 30000 });
  let seen = '';
  const t0 = Date.now();
  // cheap models with a key of their own first; OpenCode's free ones only when none is there after the list settled
  // (on the mini only OpenCode's free ones answer: Big Pickle and MiMo Flash did on 2026-10-07)
  const model = await until(ui, async () => {
    const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => ({name:r.querySelector('.dsm-name')?.textContent}))`);
    seen = rows.map(r => r.name).join(', ');
    const own = rows.find(r => /DeepSeek.*Flash/i.test(r.name || '')) || rows.find(r => /GLM-5\.3-Flash/i.test(r.name || ''));
    const free = rows.find(r => /^Big Pickle$/i.test((r.name || '').trim())) || rows.find(r => /MiMo.*Flash.*Free/i.test(r.name || '')) || rows.find(r => /Flash.*Free|Free.*Flash/i.test(r.name || ''));
    return own || (Date.now() - t0 > 15000 ? free : null);
  }, 'a test model', 60000).catch(e => { throw new Error(`${e.message}; the menu had: ${seen}`); });
  const typed = async () => ui.eval(`document.querySelector('${fresh} .view-lines')?.textContent || ''`);
  for (let i = 0; i < 40 && (await typed()).trim(); i++) await ui.press('Backspace');
  await ui.type(`/${model.name.replace(/\s+/g, '')}`);
  await until(ui, async () => ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row .dsm-name')].some(n => n.textContent === ${JSON.stringify(model.name)})`), `the menu row ${model.name}`, 20000);
  await ui.click({ text: model.name, exact: true, within: '.dispatch-slash-menu' });
  await ui.press('Escape');
  return model.name;
}

/** The new session page's Separate copy checkbox: { found, checked }. */
const copyChip = (ui) => ui.eval(`(() => {
  const box = document.querySelector('.sessions-chat-isolation-checkbox');
  if (!box) return { found: false };
  const t = box.querySelector('[aria-checked], .monaco-custom-toggle, input[type=checkbox]');
  const checked = t ? (t.getAttribute('aria-checked') === 'true' || t.classList.contains('checked') || t.checked === true) : null;
  return { found: true, checked, text: box.innerText.trim() };
})()`);

/** Marks the last reply line holding `text` (the window's text finder misses a line inside a longer reply). */
async function markLine(ui, text, note) {
  const ok = await ui.eval(`(() => { const all = [...document.querySelectorAll('.interactive-response .rendered-markdown p, .interactive-response .chat-system-notification, .interactive-response .value p, .interactive-item-container p, .interactive-item-container div')].filter(e => e.innerText && e.innerText.includes(${JSON.stringify(text)}) && e.children.length < 4); const e = all.at(-1); if (!e) return false; document.querySelectorAll('[data-oc-mark]').forEach(x => x.removeAttribute('data-oc-mark')); e.setAttribute('data-oc-mark', '1'); return true; })()`);
  if (ok) await ui.mark({ css: '[data-oc-mark="1"]' }, note);
}

async function startSession(ui, facts, prompt, key) {
  await newSessionInProject(ui, ui.demoFolder);
  await ui.pickEngine('OpenCode', 360000);
  facts.model = facts.model || await pickTestModel(ui);
  if (facts.model && !(await ui.eval(`document.body.innerText.includes(${JSON.stringify(facts.model)})`))) await pickTestModel(ui);
  facts[`${key}Chip`] = await copyChip(ui);
  await closeTips(ui);
  await focusInput(ui);
  await ui.type(prompt);
  await ui.press('Enter', { send: true });
}

/** Approves any permission the agent asks for, until `fn` says yes. */
async function untilApproving(ui, fn, what, ms) {
  return until(ui, async () => {
    const ask = await ui.eval(`[...document.querySelectorAll('.interactive-session button, .chat-confirmation-widget button')].map(b => b.innerText.trim()).find(t => /^(Allow|Allow once|Approve|Continue|Yes)$/i.test(t)) || ''`);
    if (ask) await ui.click({ text: ask, exact: true });
    return fn();
  }, what, ms, 1500);
}

// the agent's DONE, also when a line came after it (a copy's changes put back in the folder say so in a reply of their own)
const recentReplies = `(() => { const all = [...document.querySelectorAll('.interactive-request, .interactive-response')]; const last = all.map(e => e.classList.contains('interactive-request')).lastIndexOf(true); return all.slice(last + 1).filter(r => r.classList.contains('interactive-response')).map(r => ({ text: (r.querySelector('.value') || r).innerText, done: !r.classList.contains('chat-response-loading') })); })()`;

async function doneReply(ui, ms = 400000) {
  return untilApproving(ui, async () => { const rs = await ui.eval(recentReplies); return (rs || []).reverse().find(r => r.done && /DONE/.test(r.text)) || null; }, 'the reply DONE', ms);
}

export default async function (ui) {
  const facts = {};
  try {
    await run(ui, facts);
  } finally {
    writeFileSync(`${ui.out}/result.json`, JSON.stringify(facts, null, 2));
    for (const p of facts.fakePids || []) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
  }
}

async function run(ui, facts) {
  const demo = ui.demoFolder;
  facts.demo = demo;
  await ui.openAgents(demo);
  await offScreen(ui);
  if (git(demo, 'status', '--porcelain')) {
    git(demo, 'add', '-A');
    git(demo, 'commit', '-qm', 'Before the own-copy test');
  }
  facts.worktreesBefore = git(demo, 'worktree', 'list').split('\n').length;

  // 1. a new session works in the folder: Separate copy is off; DONE means the file is there
  await startSession(ui, facts, 'Create a file named hello-dispatch.txt in the project folder containing exactly: hello from the folder\nDo not commit. Then reply DONE.', 'first');
  assert(facts.firstChip.found && facts.firstChip.checked === false, 'Separate copy should be off on a new session: ' + JSON.stringify(facts.firstChip));
  await doneReply(ui);
  facts.helloInFolder = existsSync(join(demo, 'hello-dispatch.txt')) && readFileSync(join(demo, 'hello-dispatch.txt'), 'utf8');
  assert(/hello from the folder/.test(facts.helloInFolder || ''), 'hello-dispatch.txt is not in the project folder when the agent says DONE');
  facts.worktreesAfterFirst = git(demo, 'worktree', 'list').split('\n').length;
  assert(facts.worktreesAfterFirst === facts.worktreesBefore, 'a copy was made for the first session');
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot('01-done-in-folder');
  await ui.mark({ css: '.interactive-response:last-of-type' }, { what: 'Agent 说 DONE 时文件已经在项目文件夹里，没开副本', where: '对话里', how: '新会话直接发消息' });
  git(demo, 'add', '-A');
  git(demo, 'commit', '-qm', 'hello file from the first session');

  // 2. two sessions at once: A works in the folder for a while; B, started meanwhile, gets a copy of its own
  await startSession(ui, facts, 'First run the shell command `sleep 45` and wait for it to finish. Then create a-file.txt containing exactly: from A\nDo not commit. Then reply DONE.', 'a');
  await untilApproving(ui, async () => ui.eval(`!!document.querySelector('.chat-response-loading') || /sleep 45/.test(document.body.innerText)`), 'A at work', 120000);
  await ui.sleep(4000);
  await startSession(ui, facts, 'Create b-file.txt containing exactly: from B\nThen commit it with the message "Add b-file". Then reply DONE.', 'b');
  await untilApproving(ui, async () => /works in a separate copy/.test(await transcript(ui)), 'the line saying B works in a separate copy', 180000);
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot('02-second-session-copy');
  await markLine(ui, 'Another agent is working in', { what: '同一个文件夹里已经有 Agent 在干活：第二个会话自动用单独副本，并说清楚', where: '第二个会话的第一条回复上面', how: '另一个会话还在跑时再开一个会话' });
  await doneReply(ui);
  const landed = await until(ui, async () => { const t = await transcript(ui); const m = /This session's changes are in [^\n]+ now[^\n]*/.exec(t); return m ? m[0] : null; }, 'the line saying B\'s changes are in the folder', 120000, 1500);
  facts.bLanded = landed;
  facts.bInFolder = existsSync(join(demo, 'b-file.txt')) && readFileSync(join(demo, 'b-file.txt'), 'utf8');
  facts.bLog = git(demo, 'log', '--format=%s', '-5');
  assert(/from B/.test(facts.bInFolder || ''), 'b-file.txt did not come back into the project folder');
  assert(/Add b-file/.test(facts.bLog), 'B\'s commit is not in the folder: ' + facts.bLog);
  await restPointer(ui);
  await ui.screenshot('03-second-session-back');
  await markLine(ui, "This session's changes are in", { what: '第二个会话做完，改动自己合回项目文件夹', where: '第二个会话的最后', how: '不用点 Merge Changes' });
  await until(ui, async () => existsSync(join(demo, 'a-file.txt')), 'A writing a-file.txt in the folder', 300000, 3000);
  facts.aInFolder = readFileSync(join(demo, 'a-file.txt'), 'utf8');
  await ui.sleep(8000);
  git(demo, 'add', '-A');
  git(demo, 'commit', '-qm', 'a file from the first of the two sessions');

  // 3. both change the same line: a stand-in agent works in the folder (an "opencode" process there), C makes its
  //    change in its copy, the folder changes the same line meanwhile; the question card asks, nothing half merged
  writeFileSync(join(demo, 'shared-note.txt'), 'line one\n');
  git(demo, 'add', 'shared-note.txt');
  git(demo, 'commit', '-qm', 'shared note');
  const fakeDir = join(ui.out, 'fake-agent');
  mkdirSync(fakeDir, { recursive: true });
  // a program of its own named opencode (a copy of /bin/sleep is killed by macOS: a system binary moved elsewhere)
  execFileSync('cc', ['-x', 'c', '-', '-o', join(fakeDir, 'opencode')], { input: '#include <unistd.h>\nint main(void){sleep(900);return 0;}\n' });
  const fake = spawn(join(fakeDir, 'opencode'), [], { cwd: demo, detached: true, stdio: 'ignore' });
  fake.unref();
  facts.fakePids = [fake.pid];
  await ui.sleep(1500);
  facts.fakeAlive = (() => { try { process.kill(fake.pid, 0); return true; } catch { return false; } })();
  assert(facts.fakeAlive, 'the stand-in agent did not stay up');
  await startSession(ui, facts, 'First run the shell command `sleep 30` and wait for it to finish. Then replace the whole content of shared-note.txt with exactly: line one, changed in the copy\nThen commit it with the message "Change the shared note in the copy". Then reply DONE.', 'c');
  const copiesBefore = git(demo, 'worktree', 'list').split('\n').length;
  await untilApproving(ui, async () => /works in a separate copy/.test(await transcript(ui)), 'the line saying C works in a separate copy', 180000);
  // the line comes first, the copy is made right after it: the folder changes only once the copy exists
  await until(ui, async () => git(demo, 'worktree', 'list').split('\n').length > copiesBefore, 'C\'s copy', 120000, 500);
  writeFileSync(join(demo, 'shared-note.txt'), 'line one, changed in the folder\n');
  git(demo, 'commit', '-qam', 'Change the shared note in the folder');
  const headBefore = git(demo, 'rev-parse', 'HEAD');
  await doneReply(ui);
  try { process.kill(fake.pid, 'SIGTERM'); } catch { /* gone */ }
  const card = await until(ui, async () => ui.eval(`(() => { const c = [...document.querySelectorAll('.chat-question-carousel-container')].filter(e => e.offsetHeight > 0).at(-1); return c ? c.innerText : null; })()`), 'the question card', 120000, 1500);
  facts.card = card;
  assert(/Changes overlap/.test(card) && /Let the agent combine them/.test(card) && /Keep them in the copy for now/.test(card), 'the card: ' + card);
  assert(!/worktree|conflict|rebase/i.test(card), 'developer words on the card: ' + card);
  facts.folderAtCard = { head: git(demo, 'rev-parse', 'HEAD'), note: readFileSync(join(demo, 'shared-note.txt'), 'utf8'), status: git(demo, 'status', '--porcelain') };
  assert(facts.folderAtCard.head === headBefore && facts.folderAtCard.note === 'line one, changed in the folder\n' && !facts.folderAtCard.status, 'the folder changed before anyone answered: ' + JSON.stringify(facts.folderAtCard));
  await closeTips(ui);
  await restPointer(ui);
  await ui.screenshot('04-question-card');
  await ui.mark({ css: '.chat-question-carousel-container' }, { what: '两边改了同一行：停下来用提问卡人话问你，项目文件夹没被改乱', where: '对话末尾的提问卡', how: '选 Let the agent combine them 再 Submit' });
  await ui.click({ css: '.chat-question-carousel-container .chat-question-list-item', index: 0 });
  await ui.sleep(500);
  if (await ui.exists({ css: '.chat-question-submit-button' })) await ui.click({ css: '.chat-question-submit-button' });
  const combined = await untilApproving(ui, async () => {
    const t = await transcript(ui);
    const ok = /This session's changes are in [^\n]+ now/.test(t.split('Let the agent combine them').at(-1) || '');
    return ok && git(demo, 'rev-parse', 'HEAD') !== headBefore ? t : null;
  }, 'the combined change in the folder', 600000);
  facts.afterCombine = { log: git(demo, 'log', '--format=%s', '-6'), note: readFileSync(join(demo, 'shared-note.txt'), 'utf8'), status: git(demo, 'status', '--porcelain') };
  assert(!/<<<<<<<|>>>>>>>/.test(facts.afterCombine.note), 'conflict marks in the folder: ' + facts.afterCombine.note);
  facts.combinedTail = combined.slice(-600);
  await restPointer(ui);
  await ui.screenshot('05-combined-back');
  await markLine(ui, "This session's changes are in", { what: 'Agent 合好两边的改动后，自动合回项目文件夹', where: '对话末尾', how: '在提问卡上选 Let the agent combine them' });
}
