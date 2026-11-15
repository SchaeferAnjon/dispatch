// Turbo (狂暴模式) and the Timeline page, the way the person uses them (kanban task "狂暴模式：大活拆成并行块同时做",
// design/frenzy direction A). Real model messages only go to OpenCode with deepseek-flash (never Claude).
//
//   dispatch ide e2e run turbo --instance <name> --out design/frenzy/impl/run          (stage ui, no model: the mini)
//   TURBO_STAGES=real dispatch ide e2e run turbo --instance <name> --timeout 1800 ...    (a real job with deepseek-flash)
//
// Stages (TURBO_STAGES, comma separated; default ui,many):
//   ui    the home's two tabs, Home and Timeline; the sessions lanes and Names; the Turbo switch under the input and
//         its first-time line; a message sent with it on becomes a plan instead of a session (no OpenCode on the mini:
//         the split says so, Dismiss); a plan (parts given): folder, agent, 2/4/6 at a time; Start; parts that cannot
//         start ask Try again / Leave it out; leaving them out ends in the summary card
//   many  12 parts, 3 at a time (OpenCode deepseek-flash): the parts not started fold into one row, open on a click,
//         fold back; the run's row under the demo folder in the sessions list (blocks and n/12, its parts under the
//         caret); hovering a lane lights the same part in the list and a click opens its card, and the other way round; once
//         two parts are combined they fold into one row too, open and fold back; then the run is stopped
//   switch  a run on Claude whose allowance is at 98% (a stand-in reading, Claude never starts): it stops before any
//         part starts, the bottom bar's Claude gauge has the bolt and the stripes, the stop card offers another
//         agent; "Go on with OpenCode" and the parts are done by deepseek-flash to the end
//   real  the same path with a real job split and done by OpenCode deepseek-flash in the demo project: the plan, Start,
//         the lanes filling in, Combine, the ten blocks in colour, the delivery page
//   provider  a run on OpenCode whose provider says no (a stand-in provider on 127.0.0.1, the test instance's OpenCode
//         config only): "too many requests" halves how many parts run and the band says so; "the balance ran out"
//         stops the parts and the stop card says it in the provider's words
//   midway  a run on Codex (real) with a stand-in allowance reading: part 1 is half done when the reading says 98%,
//         the run stops, "Go on with OpenCode" carries part 1 on from its handoff with deepseek-flash, the reading
//         refills, and the next part starts on Codex again
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);

export const meta = { needs: ['opencode'], timeout: 2400, title: 'Turbo: the Timeline page and the Turbo switch', description: 'The Timeline page (a run’s row in the sessions list); the Turbo switch on a new chat turns a message into a plan; Start, the lanes, the questions, the summary.' };

const run = promisify(execFile);
function assert(v, m) { if (!v) throw new Error(m); }
/** The instance's own dispatch CLI, in the instance's environment (its board, its HOME). */
async function cli(ui, ...args) {
  const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; os.execve(sys.executable,[sys.executable,r['cli'],*sys.argv[2:]],E.instance_env(r))";
  const r = await run('python3', ['-c', bootstrap, JSON.stringify(ui.rec), ...args], { env: process.env, maxBuffer: 16 * 1024 * 1024, timeout: 240000 }).catch(e => e);
  return r.stdout || '';
}
async function cliJson(ui, ...args) {
  const out = await cli(ui, ...args, '--json');
  const i = out.indexOf('{') >= 0 && (out.indexOf('[') < 0 || out.indexOf('{') < out.indexOf('[')) ? out.indexOf('{') : out.indexOf('[');
  return JSON.parse(out.slice(i));
}
async function offscreen(ui) {
  try {
    const { windowId } = await ui.cdp.send('Browser.getWindowForTarget', {});
    await ui.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -3000, top: -3000 } });
  } catch { /* an older Electron without the Browser domain on the page: leave it */ }
}
async function clearOverlays(ui) {
  // a hover card left under the pointer (the Assistant row's) covers a tip's close button: the pointer goes away first
  await ui.mouse('mouseMoved', 900, 760).catch(() => undefined);
  await ui.sleep(400);
  for (let i = 0; i < 3 && await ui.exists('Welcome to Dispatch'); i++) { await ui.press('Escape'); await ui.sleep(500); }
  for (let i = 0; i < 4 && await ui.exists({ css: '.dispatch-tour-close' }); i++) { await ui.click({ css: '.dispatch-tour-close' }); await ui.sleep(400); }
}
const TIMELINE = `(() => {
  const t = document.querySelector('.dispatch-timeline');
  const tab = [{ tab: 'timeline', on: !!document.querySelector('.dispatch-timeline-page .dispatch-timeline') }];
  if (!t) return { tab };
  return { tab,
    title: t.querySelector('.dt-title')?.innerText.trim() || '',
    line: t.querySelector('.dt-line')?.innerText.trim() || '',
    lanes: [...t.querySelectorAll('.dt-lane:not(.dt-fold)')].map(l => ({ n: l.querySelector('.dt-n')?.innerText.trim(), name: l.querySelector('.dt-name')?.innerText.trim(), shown: !!l.querySelector('.dt-name')?.offsetParent, side: l.querySelector('.dt-side')?.innerText.trim(), bars: l.querySelectorAll('.dt-bar').length, boxes: l.querySelectorAll('.dt-box').length, inFold: l.classList.contains('in-fold') })),
    folds: [...t.querySelectorAll('.dt-fold')].map(l => ({ parts: (l.dataset.parts || '').split(' ').filter(Boolean).length, name: l.querySelector('.dt-name')?.innerText.trim(), open: l.getAttribute('aria-expanded') === 'true' })),
    deps: [...t.querySelectorAll('.dt-deps path')].map(p => p.dataset.from + '>' + p.dataset.to),
    needs: [...t.querySelectorAll('.dt-need')].map(n => n.innerText.replace(/\\s+/g, ' ').trim()),
    plan: t.querySelector('.dt-plan')?.innerText.replace(/\\s+/g, ' ').trim() || '',
    seg: [...t.querySelectorAll('.dt-seg button')].map(b => ({ k: b.innerText.trim(), on: b.classList.contains('on') })),
    band: t.querySelector('.dt-band')?.innerText.replace(/\\s+/g, ' ').trim() || '',
    combine: t.querySelector('.dt-combine')?.innerText.replace(/\\s+/g, ' ').trim() || '',
    summary: t.querySelector('.dt-summary')?.innerText.replace(/\\s+/g, ' ').trim() || '',
    mark: { lit: t.querySelectorAll('.dispatch-turbo-mark .cell.lit').length, done: !!t.querySelector('.dispatch-turbo-mark.done') },
    buttons: [...t.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean) };
})()`;
async function timeline(ui, name) {
  const v = await ui.eval(TIMELINE);
  fs.writeFileSync(path.join(ui.out, `${name}.json`), JSON.stringify(v, null, 2));
  return v;
}
async function waitTimeline(ui, test, what, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  let v;
  while (Date.now() < until) {
    v = await ui.eval(TIMELINE);
    if (test(v)) return v;
    await ui.sleep(1500);
  }
  throw new Error(`Timeline never showed ${what}: ${JSON.stringify(v && { ...v, lanes: undefined, folds: v.folds, needs: v.needs, lanes2: v.lanes }).slice(0, 2400)}`);
}

const SIDEBAR = `(() => {
  const row = document.querySelector('.dispatch-turbo-row');
  const parts = [...document.querySelectorAll('.dispatch-turbo-part-row')];
  const listRow = row?.closest('.monaco-list-row');
  let folder = '';
  if (listRow) {
    let r = listRow.previousElementSibling;
    const rows = [...listRow.parentElement.children].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
    const i = rows.indexOf(listRow);
    for (let k = i - 1; k >= 0; k--) { const s = rows[k].querySelector('.session-section:not(.dispatch-turbo-row):not(.dispatch-turbo-part-row)'); if (s) { folder = s.querySelector('.session-section-label')?.innerText.trim() || ''; break; } }
  }
  return { row: !!row, text: row?.innerText.replace(/\\s+/g, ' ').trim() || '', title: row?.getAttribute('title') || '', folder,
    expanded: listRow?.getAttribute('aria-expanded'), bolt: row?.querySelector('.dispatch-turbo-bolt')?.className || '',
    mark: !!row?.querySelector('.dispatch-turbo-mark'), parts: parts.map(p => ({ text: p.innerText.trim(), hl: p.classList.contains('hl'), block: p.querySelector('.dispatch-block')?.classList[1] || '', count: !!p.querySelector('.session-section-count')?.offsetParent })) };
})()`;

/** `<image>.boxes.json` for the delivery page: numbered boxes around what changed, in the screenshot's pixels. */
async function boxes(ui, image, items) {
  const out = [];
  for (const it of items) {
    const b = await ui.eval(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(it.css)})].pop(); if (!e) return null; const r = e.getBoundingClientRect(); const d = devicePixelRatio; return [r.x * d, r.y * d, r.width * d, r.height * d].map(Math.round); })()`);
    if (b && b[2] > 0) out.push({ n: it.n, box: b, what: it.what });
  }
  const size = await ui.eval(`[Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio)]`);
  fs.writeFileSync(path.join(ui.out, `${image}.boxes.json`), JSON.stringify({ size, items: out }));
}

/** Esc with no card open leaves a page for the session (the Timeline is a page since 2026-11-11): back on it. */
async function timelineShown(ui) {
  if (!(await ui.exists({ css: '.dispatch-timeline-page .dt-head' }))) await openTimeline(ui);
}

/** The Timeline page: the Turbo run's row in the sessions list (since 2026-11-15 its only way in: no side bar entry, not in the
 * Command Palette, task-ccmyi). */
async function openTimeline(ui) {
  for (let i = 0; i < 9; i++) {
    await clearOverlays(ui);
    // the run's row in the sessions list (the window reads the runs every 30 s: it can take that long to come)
    if (!(await ui.exists({ css: '.session-section.dispatch-turbo-row' }))) {
      await ui.sleep(8000);
      continue;
    }
    await ui.click({ css: '.session-section.dispatch-turbo-row .session-section-label' });
    await ui.sleep(1200);
    if (await ui.eval(`!!document.querySelector('.dispatch-timeline-page .dispatch-timeline')`)) return;
  }
  throw new Error('the Timeline page does not open');
}

async function home(ui) {
  await ui.attach('agents', 90000);
  await offscreen(ui);
  await clearOverlays(ui);
  // a new chat's page (Chats' +): where the Turbo switch is
  // the palette, for sure: an F1 right after the window comes up can go nowhere
  for (let p = 0; p < 5 && !(await ui.exists({ css: '.quick-input-widget input' })); p++) {
  	await ui.press('F1');
  	await ui.sleep(800);
  }
  await ui.type('New Quick Chat', { into: { css: '.quick-input-widget input' } });
  await ui.sleep(800);
  await ui.press('Enter');
  await ui.waitFor({ css: '.dispatch-turbo-chip' }, { timeoutMs: 60000 });
  await clearOverlays(ui);
}

/** The switch under a new chat's input, on; refuses to go on unless the page really says Turbo will take the message. */
async function turboOn(ui) {
  await ui.waitFor({ css: '.dispatch-turbo-chip' }, { timeoutMs: 30000 });
  if (!(await ui.eval(`document.body.classList.contains('dispatch-turbo-on')`))) await ui.click({ text: 'Turbo', exact: true, within: '.dispatch-turbo-chip' });
  await ui.waitFor({ css: '.dispatch-turbo-note' }, { timeoutMs: 10000 });
  const on = await ui.eval(`({ body: document.body.classList.contains('dispatch-turbo-on'), checked: document.querySelector('.dispatch-turbo-chip [aria-checked]')?.getAttribute('aria-checked') })`);
  assert(on.body && on.checked === 'true', 'the Turbo switch is not on: ' + JSON.stringify(on));
}

async function sendJob(ui, text) {
  await turboOn(ui);
  await ui.click({ css: '.sessions-chat-editor' });
  await ui.sleep(400);
  assert(await ui.eval(`document.body.classList.contains('dispatch-turbo-on')`), 'Turbo went off before sending');
  await ui.type(text);
  await ui.press('Enter', { send: true });
}

async function ui_(ui) {
  await home(ui);
  await cli(ui, 'turbo', 'config', '--engine', 'opencode', '--model', uiModel(ui));
  // 1 a new chat's page carries the Turbo switch (no Chat / Timeline tabs any more)
  await ui.screenshot('u01-new-chat');
  await ui.mark({ css: '.dispatch-turbo-chip' }, { what: 'Turbo 开关在新对话页', where: 'Chats 的 + 打开的新对话页，输入框下面', how: '打开后下一句话变成计划' });
  // 2 (gone 2026-11-15, task-ccmyi) the Timeline without a Turbo run has no way in until it is redone
  // 3 the switch: on, with its first-time line; a message becomes a plan, not a session
  await home(ui);
  await turboOn(ui);
  await ui.screenshot('u04-switch-on');
  await ui.mark({ css: '.dispatch-turbo-chip' }, { what: '狂暴模式开关（Turbo）', where: '输入框下面一行右边', how: '开了以后下一句话变成计划，不开会话' });
  await ui.mark({ css: '.dispatch-turbo-note' }, { what: '第一次打开时的说明', where: '输入框下面，不挡发送键', how: '开关打开时出现' });
  const sessionsBefore = await ui.eval(`document.querySelectorAll('.agent-sessions-viewpane .session-item, .agent-sessions-viewpane .monaco-list-row').length`);
  await sendJob(ui, 'Add a CHANGELOG and a short About section to the README');
  const t3 = await waitTimeline(ui, v => v.tab.find(x => x.tab === 'timeline')?.on && /Turbo|split|OpenCode|Splitting|parts/i.test(v.title + v.line), 'the plan for the message', 90000);
  await ui.screenshot('u05-message-became-plan');
  const sessionsAfter = await ui.eval(`document.querySelectorAll('.agent-sessions-viewpane .session-item, .agent-sessions-viewpane .monaco-list-row').length`);
  const off = await ui.eval(`!document.body.classList.contains('dispatch-turbo-on')`);
  fs.writeFileSync(path.join(ui.out, 'u05.json'), JSON.stringify({ t3, sessionsBefore, sessionsAfter, off }, null, 2));
  assert(off, 'the switch stayed on after it took the message');
  const runs = await cliJson(ui, 'turbo', 'list');
  assert(runs.length >= 1 && /CHANGELOG/.test(runs[0].title || ''), 'no run for the message: ' + JSON.stringify(runs).slice(0, 400));
  // no OpenCode on this Mac: the split says why; Dismiss
  const t4 = await waitTimeline(ui, v => v.buttons.includes('Dismiss') || !!v.plan, 'the split ending', 240000);
  await ui.screenshot('u06-split-ended');
  if (t4.buttons.includes('Dismiss')) await ui.click({ text: 'Dismiss', exact: true, within: '.dispatch-timeline' });
  else await ui.click({ text: 'Cancel', exact: true, within: '.dt-plan' });
  await ui.sleep(2000);
  // 4 a plan with its parts given (no model needed): the folder, the agent, how many at a time
  const parts = path.join(ui.out, 'parts.json');
  fs.writeFileSync(parts, JSON.stringify({ title: 'Changelog, about and footer', parts: [
    { name: 'Write the changelog', full: 'CHANGELOG.md lists this release', files: ['CHANGELOG.md'], minutes: 20 },
    { name: 'About section', full: 'README.md has an About section', files: ['README.md'], minutes: 15 },
    { name: 'Footer with the year', full: 'index.html has a footer with the year', files: ['index.html'], minutes: 25 },
    { name: 'Link the changelog', full: 'README.md links CHANGELOG.md', files: ['README.md'], minutes: 10, after: [1] }] }));
  const planOut = await cli(ui, 'turbo', 'plan', '--cwd', ui.demoFolder, '--parts', parts, '--engine', 'opencode', '--json', '--text=Changelog, about and footer');
  const plan = JSON.parse(planOut.slice(planOut.indexOf('{')));
  await openTimeline(ui);
  const t5 = await waitTimeline(ui, v => !!v.plan && v.lanes.length === 4, 'the plan', 60000);
  await clearOverlays(ui);
  await ui.screenshot('u07-plan');
  await ui.mark({ css: '.dt-plan' }, { what: '开工前的计划：文件夹、谁来做、一次几块、几点做完、额度', where: 'Timeline 页签顶上', how: '按 Start 之前什么都不跑' });
  await ui.mark({ css: '.dt-lanes' }, { what: '每块一条泳道，虚线框是预计几点做', where: '计划下面', how: '点一条泳道看它的卡片' });
  assert(t5.seg.find(s => s.on)?.k === '4', 'at a time: ' + JSON.stringify(t5.seg));
  assert(/demo/.test(t5.plan) && /OpenCode/.test(t5.plan) && /Done around/.test(t5.plan), 'plan words: ' + t5.plan);
  assert(t5.lanes.every(l => l.boxes === 1), 'every part has its dashed box: ' + JSON.stringify(t5.lanes));
  assert(t5.deps.includes('1>4'), 'no hook from part 1 to the part that waits for it: ' + JSON.stringify(t5.deps));
  await ui.click({ text: '2', exact: true, within: '.dt-seg' });
  const t6 = await waitTimeline(ui, v => v.seg.find(s => s.on)?.k === '2', '2 at a time', 30000);
  const r6 = await cliJson(ui, 'turbo', 'status', plan.id);
  assert(r6.slots === 2, 'slots in the run: ' + r6.slots);
  await ui.click({ css: '.dt-lane .dt-track' });
  await ui.waitFor({ css: '.dt-pop' }, { timeoutMs: 10000 });
  await ui.screenshot('u08-plan-lane-open');
  fs.writeFileSync(path.join(ui.out, 'u06.json'), JSON.stringify({ t5, t6 }, null, 2));
  // 5 Start. With OpenCode on this Mac the parts really run (deepseek-flash) and the run ends in its summary; without
  // it (the mini) the parts cannot start and ask Try again / Leave it out, and leaving them out ends the run the same way
  await clearOverlays(ui);
  await ui.click({ text: 'Start', exact: true, within: '.dt-plan' });
  const t7 = await waitTimeline(ui, v => v.needs.length > 0 || v.lanes.some(l => l.bars > 0), 'a question or a lane filling in', 180000);
  await clearOverlays(ui);
  await ui.screenshot(t7.needs.length ? 'u09-needs-you' : 'u09-running');
  if (t7.needs.length) {
    await ui.mark({ css: '.dt-need' }, { what: '要你回答的事，按钮就在旁边', where: 'Timeline 页签最上面', how: '点一个选项，那一块接着做' });
    assert(/Try again|Leave it out/.test(t7.needs[0]), 'question: ' + t7.needs[0]);
  } else {
    await ui.mark({ css: '.dt-lanes' }, { what: '泳道实时填满：灰条是做过的，绿点是正在做，青色勾是合进去了', where: 'Timeline 页签', how: '点一条泳道看它的卡片' });
  }
  // the parts' real work on a free model on a busy Mac takes longer: DISPATCH_E2E_TIME_SCALE stretches the wait too
  const until = Date.now() + 1500000 * SCALE;
  let t8;
  while (Date.now() < until) {
    t8 = await ui.eval(TIMELINE);
    if (t8.summary) break;
    if (await ui.exists({ text: 'Leave it out', exact: true, within: '.dt-need' })) await ui.click({ text: 'Leave it out', exact: true, within: '.dt-need' });
    else if (t8.needs.length) throw new Error('the run asks: ' + t8.needs.join(' | '));
    await ui.sleep(5000);
  }
  if (!t8?.summary) {
    fs.writeFileSync(path.join(ui.out, 'u10-run.json'), JSON.stringify(await cliJson(ui, 'turbo', 'status', plan.id).catch(e => String(e)), null, 1));
    throw new Error('no summary: ' + JSON.stringify(t8).slice(0, 600));
  }
  await ui.sleep(2500);
  await clearOverlays(ui);
  await ui.screenshot('u10-done');
  await ui.mark({ css: '.dt-summary' }, { what: '做完的总结卡', where: 'Timeline 页签', how: '只写实在的数，留给你的事列在这里' });
  assert(/Left for you|Nothing is left/.test(t8.summary), 'summary: ' + t8.summary);
  fs.writeFileSync(path.join(ui.out, 'u10.json'), JSON.stringify({ t7, t8 }, null, 2));
}

/** Nothing of a run outlives the test instance. */
async function cancelRuns(ui) {
  const rows = await cliJson(ui, 'turbo', 'list').catch(() => []);
  for (const r of rows) {
    if (['planning', 'planned', 'running', 'paused', 'combining'].includes(r.state)) await cli(ui, 'turbo', 'cancel', r.id);
  }
}

async function real(ui) {
  await home(ui);
  await cli(ui, 'turbo', 'config', '--engine', 'opencode', '--model', testModel(ui));
  const demo = ui.demoFolder;
  fs.writeFileSync(path.join(demo, 'index.html'), '<!doctype html>\n<title>Demo</title>\n<h1>Demo</h1>\n');
  await run('git', ['-C', demo, '-c', 'user.name=Dispatch e2e', '-c', 'user.email=e2e@localhost', 'add', 'index.html']);
  await run('git', ['-C', demo, '-c', 'user.name=Dispatch e2e', '-c', 'user.email=e2e@localhost', 'commit', '-qm', 'add the page']).catch(() => {});
  await home(ui);
  await sendJob(ui, 'In the demo project: add a CHANGELOG.md with one entry, add a short About section to README.md, and add a footer with the year to index.html');
  const p0 = await waitTimeline(ui, v => /Splitting/.test(v.line) || !!v.plan, 'the split starting', 60000);
  await ui.screenshot('r01-splitting');
  const p1 = await waitTimeline(ui, v => !!v.plan && v.lanes.length > 0, 'the plan', 300000);
  await clearOverlays(ui);
  await ui.screenshot('r02-plan');
  await ui.mark({ css: '.dt-plan' }, { what: '模型拆好的计划', where: 'Timeline 页签', how: '看完按 Start' });
  assert(/OpenCode/.test(p1.plan), 'not OpenCode: ' + p1.plan);
  await ui.click({ text: 'Start', exact: true, within: '.dt-plan' });
  const p2 = await waitTimeline(ui, v => v.lanes.some(l => l.bars > 0), 'a lane filling in', 180000);
  await ui.sleep(4000);
  await clearOverlays(ui);
  await ui.screenshot('r03-running');
  await ui.mark({ css: '.dt-lanes' }, { what: '泳道实时填满：灰条是做过的，绿点是正在做', where: 'Timeline 页签', how: '点一条泳道看它的卡片' });
  const p3 = await waitTimeline(ui, v => !!v.summary || v.needs.length > 0, 'the end', 1500000);
  if (p3.needs.length) {
    await ui.screenshot('r05-needs');
    fs.writeFileSync(path.join(ui.out, 'r-needs.json'), JSON.stringify(p3, null, 2));
    throw new Error('the run asked: ' + p3.needs.join(' | '));
  }
  await ui.sleep(3000);
  await ui.screenshot('r06-done');
  await ui.mark({ css: '.dispatch-turbo-mark' }, { what: '十个方块拼回图标的颜色', where: '标题左边', how: '全部合进去、装好时变色' });
  await ui.mark({ css: '.dt-summary' }, { what: '总结卡和交付页', where: 'Timeline 页签', how: '点 Open the delivery page' });
  const p4 = await timeline(ui, 'r06-done');
  assert(p4.mark.done && /Nothing is left for you/.test(p4.summary), 'not done cleanly: ' + p4.summary);
  const files = fs.readdirSync(demo);
  assert(files.includes('CHANGELOG.md'), 'the result is not in the demo project: ' + files.join(', '));
  await ui.click({ css: '.dt-lane' });
  await ui.sleep(1000);
  await ui.screenshot('r07-parts');
  await ui.click({ text: 'Open the delivery page', exact: true, within: '.dt-summary' });
  await ui.sleep(4000);
  await ui.screenshot('r08-delivery');
  fs.writeFileSync(path.join(ui.out, 'r.json'), JSON.stringify({ p0, p1, p2, p4, files }, null, 2));
}

/**
 * Many parts (Turbo is many sessions at once): 12 parts, 2 at a time, on OpenCode deepseek-flash. While 2 work, the 10
 * not started are one row; a click opens it (its parts follow, indented), another folds it back. The run is stopped
 * right after, so the model does a minute of work at most.
 */
async function many(ui) {
  await home(ui);
  await cancelRuns(ui);
  await cli(ui, 'turbo', 'config', '--engine', 'opencode', '--model', testModel(ui));
  const parts = path.join(ui.out, 'parts-many.json');
  const list = [];
  for (let n = 1; n <= 12; n++) list.push({ name: `Note ${n}`, full: `notes/${n}.md says "note ${n}"`, files: [`notes/${n}.md`], minutes: 5 + n, ...(n === 3 ? { after: [1] } : {}) });
  fs.writeFileSync(parts, JSON.stringify({ title: 'Twelve notes', parts: list }));
  const out = await cli(ui, 'turbo', 'plan', '--cwd', ui.demoFolder, '--parts', parts, '--engine', 'opencode', '--model', testModel(ui), '--at-a-time', '3', '--json', '--text=Twelve notes');
  const plan = JSON.parse(out.slice(out.indexOf('{')));
  await openTimeline(ui);
  const m0 = await waitTimeline(ui, v => !!v.plan && v.lanes.length === 12, 'the 12-part plan', 60000);
  assert(!m0.folds.length, 'a plan folds its parts: ' + JSON.stringify(m0.folds));
  await clearOverlays(ui);
  await ui.click({ text: 'Start', exact: true, within: '.dt-plan' });
  const m1 = await waitTimeline(ui, v => (v.folds.some(f => f.parts >= 6 && /up next/i.test(f.name)) && v.lanes.some(l => l.bars > 0)) || v.needs.length >= 2, 'three parts working and the ones not started as one row', 180000);
  await ui.sleep(4000);
  if (!m1.folds.length) {
    // no OpenCode here (the mini): every part fails to start at once, nothing waits, so there is nothing to fold
    fs.writeFileSync(path.join(ui.out, 'm.json'), JSON.stringify({ m0, m1, skipped: 'the parts could not start: ' + m1.needs[0] }, null, 2));
    await cli(ui, 'turbo', 'cancel', plan.id);
    return;
  }
  await ui.sleep(1500);
  await clearOverlays(ui);
  await ui.screenshot('m01-folded');
  await ui.mark({ css: '.dt-fold.f-later' }, { what: '没开始的几块收成一行', where: 'Timeline 页签，泳道最下面', how: '块多于 10 个时自动收；点一下展开' });
  assert(m1.lanes.length <= 5 && !m1.lanes.some(l => l.inFold), 'lanes besides the fold: ' + JSON.stringify(m1.lanes));
  assert(!(await ui.exists({ css: '.dt-pop' })), 'a card opened in the run before is open in this one');
  assert(await ui.eval(`(() => { const n = document.querySelector('.dt-fold .dt-name'); return !!n && n.scrollWidth <= n.clientWidth + 1; })()`), 'the fold\'s words are cut off');
  // deepseek-flash is quick: two parts may be combined already (their own row), so it is the row of those not started.
  // The pointer is first moved off the lanes, as a person's would be: a lane's card hangs below its lane
  await timelineShown(ui);
  await ui.hover({ css: '.dt-head' });
  await ui.click({ css: '.dt-fold.f-later' });
  const m2 = await waitTimeline(ui, v => v.folds.some(f => /up next/i.test(f.name) && f.open) && v.lanes.filter(l => l.inFold).length >= (v.folds.find(f => /up next/i.test(f.name))?.parts ?? 99), 'the fold opened', 20000);
  await ui.screenshot('m02-fold-open');
  await ui.mark({ css: '.dt-fold.f-later' }, { what: '点开后这一行留着，下面列出每一块（缩进）', where: '同一行', how: '再点一下收回' });
  await ui.click({ css: '.dt-fold.f-later' });
  const m3 = await waitTimeline(ui, v => v.folds.length && !v.folds.some(f => f.open) && !v.lanes.some(l => l.inFold), 'the fold closed again', 20000);
  // the run's row under the demo folder in the sessions list: the bolt, the ten blocks, n/12; 12 parts start folded
  const s0 = await waitSidebar(ui, v => v.row && /\d+\/12/.test(v.text), 'the run\'s row', 30000);
  assert(s0.folder === 'demo' || /demo/.test(s0.folder), 'the row is not under the demo folder: ' + JSON.stringify(s0));
  assert(s0.mark && /working|waiting/.test(s0.bolt), 'the row has no blocks or bolt: ' + JSON.stringify(s0));
  assert(s0.expanded === 'false' && !s0.parts.length, '12 parts should start folded: ' + JSON.stringify(s0));
  // folded: pointing at a lane lights the run's own row (there is no part row to light)
  const n0 = await ui.eval(`document.querySelector('.dt-lane[data-n]')?.dataset.n`);
  await ui.hover({ css: `.dt-lane[data-n="${n0}"] .dt-track` }, { settleMs: 1400 });
  const lit0 = await ui.eval(`!!document.querySelector('.dispatch-turbo-row.hl')`);
  assert(lit0, 'a lane hovered while the parts are folded did not light the run\'s row');
  await ui.screenshot('s00-folded-lane-hover');
  await boxes(ui, 's00-folded-lane-hover', [{ n: 9, css: '.monaco-list-row:has(.dispatch-turbo-row.hl)', what: '收起时，左栏 Turbo 行本身亮' }, { n: 3, css: '.dt-lane.hl', what: '悬停的泳道' }]);
  await ui.mark({ css: '.dispatch-turbo-row.hl' }, { what: '各块收起时，悬停泳道点亮左栏 Turbo 行本身', where: '左栏 demo 文件夹下第一行', how: '鼠标停在 Timeline 的一条泳道上' });
  await ui.press('Escape');
  await timelineShown(ui);
  await ui.hover({ css: '.dt-head' }, { settleMs: 600 });
  assert(!(await ui.eval(`!!document.querySelector('.dispatch-turbo-row.hl')`)), 'the run\'s row stays lit after the pointer left the lanes');
  s0.foldedHoverLit = lit0;
  await ui.screenshot('s01-sidebar-row');
  await boxes(ui, 's01-sidebar-row', [{ n: 1, css: '.monaco-list-row:has(.dispatch-turbo-row)', what: '左栏 demo 文件夹下的 Turbo 行' }, { n: 2, css: '.dispatch-status-allowances', what: '底栏额度' }]);
  await ui.mark({ css: '.dispatch-turbo-row' }, { what: '左栏 demo 文件夹下面的 Turbo 行：闪电、十个方块、合进几块', where: '左栏项目文件夹下第一行', how: '在跑时出现；点它打开 Timeline' });
  await ui.click({ css: '.dispatch-turbo-row-caret' });
  const s1 = await waitSidebar(ui, v => v.parts.length === 12, 'the parts under the run\'s row', 15000);
  // each part's block says how it is, as its lane does: the ones at work are green within seconds
  const working = (await ui.eval(TIMELINE)).lanes.filter(l => l.bars > 0).map(l => `Note ${l.n}`);
  const s1b = await waitSidebar(ui, v => working.every(w => ['working', 'handoff', 'done', 'stopped'].includes(v.parts.find(p => p.text === w)?.block)), 'the working parts as working', 15000);
  assert(!s1b.parts.some(p => p.count), 'a part row shows a number or dot: ' + JSON.stringify(s1b.parts));
  // hover a lane: the same part lit in the list; a click: its card
  let n = '';
  // the card comes after the pointer rests on the lane (a redraw under it can take the first rest): up to three rests
  let s2;
  for (let i = 0; ; i++) {
    await timelineShown(ui);
  await ui.hover({ css: '.dt-head' });
    // a lane on screen now (deepseek-flash is quick: a part may have folded into "combined" meanwhile)
    n = await ui.eval(`[...document.querySelectorAll('.dt-lane[data-n]')].find(l => l.querySelector('.dt-track')?.getBoundingClientRect().width > 0)?.dataset.n || ''`);
    await ui.hover({ css: `.dt-lane[data-n="${n}"] .dt-track` }, { settleMs: 1400 });
    s2 = await waitSidebar(ui, v => v.parts.some(p => p.hl), 'the part lit in the list', 10000).catch(() => undefined);
    if (s2) {
      await ui.click({ css: `.dt-lane[data-n="${n}"] .dt-track` });
      if (await ui.waitFor({ css: '.dt-pop' }, { timeoutMs: 8000 }).then(() => true, () => false)) break;
    }
    if (i >= 2) throw new Error('no card for the lane after three tries');
  }
  const card = await ui.eval(`(() => { const c = document.querySelector('.dt-pop'); return c ? c.innerText.replace(/\\s+/g, ' ').trim() : ''; })()`);
  assert(/Files/.test(card) && /Started/.test(card) && /OpenCode/.test(card), 'no lane card: ' + card);
  assert(s2.parts.filter(p => p.hl).length === 1 && s2.parts.find(p => p.hl).text.includes(`Note ${n}`), 'the wrong part lit: ' + JSON.stringify(s2.parts));
  await ui.screenshot('s02-lane-hover');
  await boxes(ui, 's02-lane-hover', [{ n: 3, css: '.dt-pop', what: '点泳道出卡片' }, { n: 6, css: '.monaco-list-row:has(.dispatch-turbo-part-row.hl)', what: '左栏同一块跟着亮' }]);
  await ui.mark({ css: '.dt-pop' }, { what: '点泳道出卡片：名字、现在在干什么、改哪些文件、副本、谁在做', where: 'Timeline 泳道下面', how: '点一条泳道' });
  await ui.mark({ css: '.dispatch-turbo-part-row.hl' }, { what: '左栏同一块跟着亮', where: '左栏 Turbo 行下面', how: '悬停泳道时' });
  // and the other way round: a part in the list lights its lane
  await ui.press('Escape');
  const other = await ui.eval(`(() => { const lanes = [...document.querySelectorAll('.dt-lane[data-n]')].map(l => l.dataset.n); return lanes.find(x => x !== '${n}') || ''; })()`);
  await ui.hover({ text: `Note ${other}`, exact: true, within: '.dispatch-turbo-part-row' }, { settleMs: 800 });
  const lit = await ui.eval(`[...document.querySelectorAll('.dt-lane.hl[data-n]')].map(l => l.dataset.n)`);
  assert(lit.length === 1 && lit[0] === other, 'the list did not light the lane: ' + JSON.stringify({ other, lit }));
  await ui.screenshot('s03-list-hover');
  await boxes(ui, 's03-list-hover', [{ n: 6, css: '.monaco-list-row:has(.dispatch-turbo-part-row.hl)', what: '悬停左栏的块' }, { n: 3, css: '.dt-lane.hl', what: '泳道跟着亮' }]);
  await ui.mark({ css: '.dt-lane.hl' }, { what: '反过来：悬停左栏的块，泳道跟着亮', where: 'Timeline', how: '鼠标停在左栏一块上' });
  // two combined: they fold into one row as well, open on a click, fold back
  const m4 = await waitTimeline(ui, v => v.folds.some(f => /combined/i.test(f.name) && f.parts >= 2) || v.needs.length > 0, 'two parts combined, as one row', 900000);
  assert(!m4.needs.length, 'the run asks: ' + m4.needs.join(' | '));
  await ui.sleep(1500);
  await clearOverlays(ui);
  await timelineShown(ui);
  await ui.hover({ css: '.dt-head' });
  await ui.screenshot('m03-combined-folded');
  await boxes(ui, 'm03-combined-folded', [{ n: 5, css: '.dt-fold.f-combined', what: '合完的块收成一行' }, { n: 1, css: '.monaco-list-row:has(.dispatch-turbo-row)', what: '左栏 Turbo 行，合进几块' }]);
  await ui.mark({ css: '.dt-fold.f-combined' }, { what: '合完的块收成一行', where: 'Timeline 泳道最上面', how: '块多于 8 个、合进两块以后自动收；点一下展开' });
  const cf = m4.folds.find(f => /combined/i.test(f.name));
  await ui.click({ css: '.dt-fold.f-combined' });
  const m5 = await waitTimeline(ui, v => v.folds.some(f => /combined/i.test(f.name) && f.open) && v.lanes.filter(l => l.inFold).length >= cf.parts, 'the combined row opened', 20000);
  await ui.screenshot('m04-combined-open');
  await boxes(ui, 'm04-combined-open', [{ n: 5, css: '.dt-fold.f-combined', what: '点开后合进去的每一块列在下面' }]);
  await ui.mark({ css: '.dt-fold.f-combined' }, { what: '点开：合进去的每一块列在下面', where: '同一行', how: '再点一下收回' });
  await ui.click({ css: '.dt-fold.f-combined' });
  const m6 = await waitTimeline(ui, v => v.folds.some(f => /combined/i.test(f.name) && !f.open), 'the combined row folded again', 20000);
  const s4 = await ui.eval(SIDEBAR);
  await cli(ui, 'turbo', 'cancel', plan.id);
  fs.writeFileSync(path.join(ui.out, 'm.json'), JSON.stringify({ m0, m1, m2, m3, m4, m5, m6, s0, s1, s2, s4, card, lit }, null, 2));
}

async function waitSidebar(ui, test, what, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  let v;
  while (Date.now() < until) {
    v = await ui.eval(SIDEBAR);
    if (test(v)) return v;
    await ui.sleep(1000);
  }
  throw new Error(`The sessions list never showed ${what}: ${JSON.stringify(v).slice(0, 800)}`);
}

/**
 * Stopped for the allowance, then on with another agent. The run is planned on Claude with a stand-in reading of 98%
 * (the run's own usage file), so it stops before any part starts and Claude never runs; the bottom bar's Claude gauge
 * carries the bolt and the stripes; the stop card offers OpenCode; a click and deepseek-flash does the parts to the end.
 */
async function switchAgent(ui) {
  await home(ui);
  await cancelRuns(ui);
  await cli(ui, 'turbo', 'config', '--engine', 'opencode', '--model', testModel(ui));
  const usage = path.join(ui.out, 'usage-claude.json');
  fs.writeFileSync(usage, JSON.stringify({ engine: 'claude', windows: [{ kind: 'session', used_percent: 98, resets_at: Math.floor(Date.now() / 1000) + 3 * 3600 }] }));
  const parts = path.join(ui.out, 'parts-switch.json');
  fs.writeFileSync(parts, JSON.stringify({ title: 'Three small notes', parts: [
    { name: 'Thanks note', full: 'THANKS.md thanks the people who helped, in two lines', files: ['THANKS.md'], minutes: 8 },
    { name: 'Contributing note', full: 'CONTRIBUTING.md says how to send a change, in three lines', files: ['CONTRIBUTING.md'], minutes: 8 },
    { name: 'Security note', full: 'SECURITY.md says how to report a problem, in two lines', files: ['SECURITY.md'], minutes: 8 }] }));
  const out = await cli(ui, 'turbo', 'plan', '--cwd', ui.demoFolder, '--parts', parts, '--engine', 'claude', '--usage-file', usage, '--at-a-time', '2', '--json', '--text=Three small notes');
  const plan = JSON.parse(out.slice(out.indexOf('{')));
  await openTimeline(ui);
  const w0 = await waitTimeline(ui, v => !!v.plan && v.lanes.length === 3, 'the plan on Claude', 60000);
  assert(/Claude/.test(w0.plan), 'not on Claude: ' + w0.plan);
  await clearOverlays(ui);
  await ui.click({ text: 'Start', exact: true, within: '.dt-plan' });
  const w1 = await waitTimeline(ui, v => v.needs.some(n => /Stopped at a clean point/.test(n)) && v.buttons.some(b => /Go on with OpenCode/.test(b)), 'the stop with another agent', 240000);
  const r1 = await cliJson(ui, 'turbo', 'status', plan.id);
  assert(r1.state === 'paused' && r1.parts.every(p => !p.started_at), 'a part started on Claude: ' + JSON.stringify(r1.parts.map(p => [p.n, p.status, p.started_at])));
  await clearOverlays(ui);
  await ui.screenshot('w01-stopped');
  await boxes(ui, 'w01-stopped', [{ n: 4, css: '.dt-stopped', what: '停下时可以换另一个引擎' }, { n: 2, css: '.dispatch-status-item[data-part="allowance-claude"]', what: '底栏 Claude 额度：闪电和斜纹' }, { n: 1, css: '.monaco-list-row:has(.dispatch-turbo-row)', what: '左栏 Turbo 行：停下时闪电变灰' }]);
  await ui.mark({ css: '.dt-stopped' }, { what: '额度到线停下：可以换同一个引擎的另一个号，也可以换另一个引擎接着做', where: 'Timeline 页签最上面', how: '点「Go on with …」才换，从不自己换' });
  // the bottom bar: the bolt before Claude, what the run still plans to use striped (when Claude's gauge shows here)
  const bar = await ui.eval(`(() => { const el = document.querySelector('.dispatch-status-item[data-part="allowance-claude"]'); return el && !el.hidden ? { bolt: !!el.querySelector('.dispatch-status-turbo'), plan: el.querySelectorAll('.dispatch-status-gauge .plan').length, tip: el.getAttribute('aria-label') || '' } : null; })()`);
  if (bar) {
    assert(bar.bolt, 'no bolt on the Claude gauge: ' + JSON.stringify(bar));
    await ui.mark({ css: '.dispatch-status-item[data-part="allowance-claude"]' }, { what: '底栏 Claude 额度前多一个闪电，这次运行还要用的那段画斜纹', where: '窗口右下角', how: 'Turbo 在跑时' });
    await ui.click({ css: '.sessions-account-titlebar-widget' });
    const menu = await ui.waitFor({ css: '.dispatch-turbo-usage' }, { timeoutMs: 15000 }).then(() => true, () => false);
    await ui.screenshot('w02-account-menu');
  // the account names (emails) are blurred on the delivery page: where they are
  fs.writeFileSync(path.join(ui.out, 'w02-account-menu.private.json'), JSON.stringify(await ui.eval(`[...document.querySelectorAll('.sessions-account-titlebar-panel-provider-name')].map(e => { const r = e.getBoundingClientRect(), d = devicePixelRatio; return [r.x * d, r.y * d, r.width * d, r.height * d].map(Math.round); })`)));
  await boxes(ui, 'w02-account-menu', [{ n: 7, css: '.dispatch-turbo-usage', what: '头像面板：闪电、斜纹小条、一句话' }]);
    if (menu) await ui.mark({ css: '.dispatch-turbo-usage' }, { what: '头像面板里 Claude 额度下面一行：闪电、已用加斜纹的小条、一句话', where: '右上角头像面板', how: '点右上角头像' });
    bar.menu = menu;
    await ui.press('Escape');
  }
  // the person's click: go on with OpenCode
  await ui.click({ text: 'Go on with OpenCode', within: '.dt-stopped' });
  const w2 = await waitTimeline(ui, v => !v.needs.some(n => /Stopped at a clean point/.test(n)) && v.lanes.some(l => l.bars > 0), 'the parts going on with OpenCode', 240000);
  const r2 = await cliJson(ui, 'turbo', 'status', plan.id);
  assert(r2.engine === 'opencode' && r2.switches?.[0]?.from === 'claude' && r2.allowance.stops.length === 1, 'not switched: ' + JSON.stringify({ engine: r2.engine, switches: r2.switches, stops: r2.allowance.stops }));
  assert(/Claude → OpenCode/.test(w2.band), 'the band has no hand-over mark: ' + w2.band);
  await ui.sleep(2000);
  await clearOverlays(ui);
  await timelineShown(ui);
  await ui.hover({ css: '.dt-head' });
  await ui.sleep(600);
  await ui.screenshot('w03-switched');
  await boxes(ui, 'w03-switched', [{ n: 8, css: '.dt-band', what: '停下那段斜纹，换引擎那一刻的标记' }]);
  await ui.mark({ css: '.dt-band' }, { what: '停下那段画斜纹，换引擎的那一刻标「Claude → OpenCode」', where: 'Timeline 额度带', how: '点 Go on with OpenCode 以后' });
  const w3 = await waitTimeline(ui, v => !!v.summary || v.needs.length > 0, 'the end on OpenCode', 1500000);
  assert(!w3.needs.length, 'the run asked: ' + w3.needs.join(' | '));
  await ui.sleep(2500);
  await timelineShown(ui);
  await ui.hover({ css: '.dt-head' });
  await ui.sleep(600);
  await ui.screenshot('w04-done');
  await ui.mark({ css: '.dt-summary' }, { what: '换到 OpenCode 以后做完', where: 'Timeline 页签', how: '全部合进去、装回 demo 项目' });
  const r3 = await cliJson(ui, 'turbo', 'status', plan.id);
  assert(r3.state === 'done' && r3.parts.every(p => p.status === 'combined' && /OpenCode/.test(p.engine_name || '')), 'not done on OpenCode: ' + JSON.stringify(r3.parts.map(p => [p.n, p.status, p.engine_name])));
  const files = fs.readdirSync(ui.demoFolder);
  assert(['THANKS.md', 'CONTRIBUTING.md', 'SECURITY.md'].every(f => files.includes(f)), 'the notes are not in the demo project: ' + files.join(', '));
  fs.writeFileSync(path.join(ui.out, 'w.json'), JSON.stringify({ w0, w1, w2, w3, bar, events: r3.events, switches: r3.switches, files }, null, 2));
}

/** The cheap model the instance's OpenCode starts on (ide_e2e.py link_xdg_config picks it for this Mac: GLM 5.3 Flash,
 *  DeepSeek Flash, else a free OpenCode Zen model); the parts' real work goes to it. */
function testModel(ui) {
  try { return JSON.parse(fs.readFileSync(opencodeConfig(ui), 'utf8')).model || 'deepseek/deepseek-flash'; } catch { return 'deepseek/deepseek-flash'; }
}

/** The ui stage's model. A quick cheap one (GLM 5.3 Flash, DeepSeek Flash): the four parts really run and the run ends
 *  in its summary within minutes. A Mac with only OpenCode's free models (the mini) takes an hour or more for them, so
 *  there the parts get a model that cannot start: they ask Try again / Leave it out, and leaving them out ends the run
 *  in the same summary (the stage as the mini always ran it). The many stage runs the free model for real. */
function uiModel(ui) {
  const m = testModel(ui);
  return /glm-5\.3-flash|deepseek-flash/i.test(m) ? m : 'e2e-none/not-on-this-mac';
}

/** The test instance's own OpenCode config (never the person's): where a stand-in provider goes. */
function opencodeConfig(ui) {
  const base = ui.rec.fixture_home ? path.join(ui.rec.fixture_home, '.config') : path.join(ui.rec.root, 'xdg-config');
  return path.join(base, 'opencode', 'opencode.json');
}

/** A provider that says no, on 127.0.0.1: "too many requests" (Zhipu's 1302) or "the balance ran out" (1113). */
async function busyProvider() {
  const state = { mode: 'rate', hits: [] };
  const server = http.createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      state.hits.push([Date.now(), state.mode]);
      const err = state.mode === 'rate'
        ? { error: { message: 'Rate limit reached for requests', type: 'rate_limit_error', code: '1302' } }
        : { error: { message: '余额不足或无可用资源包,请充值。', code: '1113' } };
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '4' });
      res.end(JSON.stringify(err));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  state.port = server.address().port;
  state.close = () => new Promise(r => server.close(r));
  return state;
}

async function provider(ui) {
  await home(ui);
  await cancelRuns(ui);
  const busy = await busyProvider();
  const cfgPath = opencodeConfig(ui);
  const before = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : null;
  const cfg = before ? JSON.parse(before) : { $schema: 'https://opencode.ai/config.json' };
  cfg.provider = { ...(cfg.provider || {}), busyai: { npm: '@ai-sdk/openai-compatible', name: 'Busy provider', options: { baseURL: `http://127.0.0.1:${busy.port}/v1`, apiKey: 'test' }, models: { busy: { name: 'Busy' } } } };
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  try {
    const parts = path.join(ui.out, 'parts-provider.json');
    fs.writeFileSync(parts, JSON.stringify({ title: 'Four notes', parts: [1, 2, 3, 4].map(n => ({ name: `Note ${n}`, full: `notes/${n}.md says "note ${n}"`, files: [`notes/${n}.md`], minutes: 6 })) }));
    const out = await cli(ui, 'turbo', 'plan', '--cwd', ui.demoFolder, '--parts', parts, '--engine', 'opencode', '--model', 'busyai/busy', '--at-a-time', '4', '--json', '--text=Four notes');
    const plan = JSON.parse(out.slice(out.indexOf('{')));
    await openTimeline(ui);
    const p0 = await waitTimeline(ui, v => !!v.plan && v.lanes.length === 4, 'the plan on OpenCode', 60000);
    assert(/listens to its provider/.test(p0.plan), 'the plan does not say how Turbo slows down on OpenCode: ' + p0.plan);
    await clearOverlays(ui);
    await ui.screenshot('p01-plan-on-opencode');
    await boxes(ui, 'p01-plan-on-opencode', [{ n: 1, css: '.dt-plan-rule', what: 'OpenCode 读不到额度：照它的服务商说的话放慢' }]);
    await ui.mark({ css: '.dt-plan-rule' }, { what: 'Turbo 用 OpenCode 时怎么放慢', where: 'Timeline 计划卡下面一行', how: '选 OpenCode 时' });
    await ui.click({ text: 'Start', exact: true, within: '.dt-plan' });
    // the provider says "too many requests": half as many parts at a time, and the band says why in its words
    const p1 = await waitTimeline(ui, v => /provider said too many requests/.test(v.band), 'the band saying the provider said too many requests', 240000);
    const r1 = await cliJson(ui, 'turbo', 'status', plan.id);
    assert(r1.slots_now === 2 && r1.allowance.slowed, 'not slowed to 2 at a time: ' + JSON.stringify({ slots_now: r1.slots_now, slowed: r1.allowance.slowed }));
    assert(/Rate limit reached/.test(p1.band), 'the band does not quote the provider: ' + p1.band);
    assert(r1.events.some(e => e.kind === 'slowed' && /too many requests/.test(e.text)), 'no event for the slow-down: ' + JSON.stringify(r1.events.slice(-4)));
    await ui.sleep(1500);
    await clearOverlays(ui);
    await timelineShown(ui);
  await ui.hover({ css: '.dt-head' });
    await ui.screenshot('p02-too-many-requests');
    await boxes(ui, 'p02-too-many-requests', [{ n: 2, css: '.dt-band', what: '服务商说请求太多：两块一起，照原话写' }]);
    await ui.mark({ css: '.dt-band' }, { what: '服务商说请求太多：一次跑的块减半，额度带照原话写', where: 'Timeline 额度带', how: 'OpenCode 的服务商回 429 时' });
    // now it says the balance ran out: the parts stop, the stop card says so and offers another agent
    busy.mode = 'out';
    const p2 = await waitTimeline(ui, v => v.needs.some(n => /balance or plan ran out/.test(n)), 'the stop for the balance', 240000);
    // the other agents it could go on with are read right after the stop (their accounts take a few seconds)
    await waitTimeline(ui, v => v.buttons.some(b => /Go on with/.test(b)), 'the other agents on the stop card', 90000).catch(() => undefined);
    const r2 = await cliJson(ui, 'turbo', 'status', plan.id);
    assert(r2.state === 'paused' && r2.allowance.paused_kind === 'provider', 'not stopped for the provider: ' + JSON.stringify({ state: r2.state, kind: r2.allowance.paused_kind }));
    const stopped = await ui.eval(`(() => { const c = document.querySelector('.dt-stopped'); return c ? c.innerText.replace(/\\s+/g, ' ').trim() : ''; })()`);
    assert(/余额不足/.test(stopped) && /tries again at/.test(stopped), 'the stop card does not say it in the provider\'s words: ' + stopped);
    await ui.sleep(1500);
    await clearOverlays(ui);
    await timelineShown(ui);
  await ui.hover({ css: '.dt-head' });
    await ui.screenshot('p03-balance-ran-out');
    await boxes(ui, 'p03-balance-ran-out', [{ n: 3, css: '.dt-stopped', what: '服务商说余额用完：停下，照原话写，30 分钟后再试' }, { n: 4, css: '.monaco-list-row:has(.dispatch-turbo-row)', what: '左栏 Turbo 行：停下时闪电变灰' }]);
    await ui.mark({ css: '.dt-stopped' }, { what: '服务商说余额或套餐用完：各块停下，30 分钟后再试，也可以换别的引擎', where: 'Timeline 最上面', how: '服务商回余额不足时' });
    await cli(ui, 'turbo', 'cancel', plan.id);
    fs.writeFileSync(path.join(ui.out, 'p.json'), JSON.stringify({ p0, p1, p2, stopped, hits: busy.hits.length, events: r2.events, allowance: r2.allowance }, null, 2));
  } finally {
    await busy.close();
    if (before === null) fs.rmSync(cfgPath, { force: true }); else fs.writeFileSync(cfgPath, before);
  }
}

/** Codex works on part 1 for real until the stand-in reading says 98%; OpenCode carries it on; Codex takes the next. */
async function midway(ui) {
  await home(ui);
  await cancelRuns(ui);
  await cli(ui, 'turbo', 'config', '--engine', 'opencode', '--model', testModel(ui));
  const usage = path.join(ui.out, 'usage-codex.json');
  const reading = (pct, inS) => fs.writeFileSync(usage, JSON.stringify({ engine: 'codex', windows: [{ kind: 'session', used_percent: pct, resets_at: Math.floor(Date.now() / 1000) + inS }] }));
  reading(30, 3 * 3600);
  const parts = path.join(ui.out, 'parts-midway.json');
  fs.writeFileSync(parts, JSON.stringify({ title: 'Notes, one by one', parts: [
    { name: 'Six short notes', full: 'In notes/, write six files 1.md to 6.md, one per step, each with the single line "note N". Do them one at a time: write a file, commit it, run the turbo step command, run `sleep 20` (the notes are paced on purpose), then look whether the stop file exists before the next one.', files: ['notes/1.md', 'notes/2.md', 'notes/3.md', 'notes/4.md', 'notes/5.md', 'notes/6.md'], minutes: 10 },
    { name: 'Thanks note', full: 'THANKS.md thanks the people who helped, in two lines', files: ['THANKS.md'], minutes: 5 },
    { name: 'Security note', full: 'SECURITY.md says how to report a problem, in two lines', files: ['SECURITY.md'], minutes: 5 }] }));
  const out = await cli(ui, 'turbo', 'plan', '--cwd', ui.demoFolder, '--parts', parts, '--engine', 'codex', '--usage-file', usage, '--at-a-time', '1', '--json', '--text=Notes, one by one');
  const plan = JSON.parse(out.slice(out.indexOf('{')));
  await openTimeline(ui);
  await waitTimeline(ui, v => !!v.plan && v.lanes.length === 3, 'the plan on Codex', 60000);
  await clearOverlays(ui);
  await ui.click({ text: 'Start', exact: true, within: '.dt-plan' });
  // part 1 on Codex: wait for its first commits in its own copy, then the reading jumps to 98%
  const git = async (cwd, ...a) => (await run('git', ['-C', cwd, ...a]).catch(e => e)).stdout || '';
  let r = null, codexCommits = 0;
  const until = Date.now() + 600000;
  while (Date.now() < until) {
    r = await cliJson(ui, 'turbo', 'status', plan.id);
    const p1 = r.parts[0];
    if (p1.copy && p1.start_sha) codexCommits = (await git(p1.copy, 'rev-list', '--count', `${p1.start_sha}..HEAD`)).trim() * 1;
    if (codexCommits >= 1 || ['done', 'combined'].includes(p1.status)) break;
    await ui.sleep(4000);
  }
  assert(r.parts[0].engine === 'codex' && codexCommits >= 1, 'Codex did not start part 1: ' + JSON.stringify({ p1: r.parts[0].status, engine: r.parts[0].engine, codexCommits }));
  assert(!['done', 'combined'].includes(r.parts[0].status), 'Codex finished part 1 before the reading could stop it');
  reading(98, 100);  // refills in 100 s: the parts that start after that go back to Codex
  const x1 = await waitTimeline(ui, v => v.needs.some(n => /Stopped at a clean point/.test(n)) && v.buttons.some(b => /Go on with OpenCode/.test(b)), 'the stop with part 1 half done', 300000);
  // the card comes as the run stops; part 1 finishes the step at hand first, commits and ends
  let r1;
  for (const end = Date.now() + 300000; Date.now() < end; await ui.sleep(4000)) {
    r1 = await cliJson(ui, 'turbo', 'status', plan.id);
    if (r1.parts[0].status !== 'working') break;
  }
  const p1 = r1.parts[0];
  const doneByCodex = (await git(p1.copy, 'rev-list', '--count', `${p1.start_sha}..HEAD`)).trim() * 1;
  const files1 = fs.existsSync(path.join(p1.copy, 'notes')) ? fs.readdirSync(path.join(p1.copy, 'notes')).sort() : [];
  assert(p1.status === 'paused' && files1.length < 6, 'part 1 is not half done: ' + JSON.stringify({ status: p1.status, files1 }));
  await clearOverlays(ui);
  await timelineShown(ui);
  await ui.hover({ css: '.dt-head' });
  await ui.screenshot('x01-stopped-half-done');
  await boxes(ui, 'x01-stopped-half-done', [{ n: 1, css: '.dt-stopped', what: '停下：第 1 块做了一半' }, { n: 2, css: '.dt-lane[data-n="1"]', what: '第 1 块：Codex 做了一半' }]);
  await ui.mark({ css: '.dt-stopped' }, { what: '额度到线停下：第 1 块 Codex 做了一半', where: 'Timeline 最上面', how: '点 Go on with OpenCode 换引擎' });
  await ui.click({ text: 'Go on with OpenCode', within: '.dt-stopped' });
  // part 1 goes on with OpenCode from its handoff
  const x2 = await waitTimeline(ui, v => !v.needs.some(n => /Stopped at a clean point/.test(n)) && v.lanes.some(l => l.bars > 0), 'part 1 going on with OpenCode', 240000);
  let r2;
  for (const end = Date.now() + 180000; Date.now() < end; await ui.sleep(3000)) {
    r2 = await cliJson(ui, 'turbo', 'status', plan.id);
    if (r2.parts[0].engine === 'opencode' && r2.parts[0].status !== 'waiting') break;
  }
  assert(r2.parts[0].engine === 'opencode' && r2.was?.engine === 'codex', 'part 1 is not on OpenCode: ' + JSON.stringify({ engine: r2.parts[0].engine, was: r2.was }));
  const launches = fs.readdirSync(path.dirname(r2.parts[0].log)).filter(f => /^launch-\d+\.json$/.test(f)).sort();
  const handoff = JSON.parse(fs.readFileSync(path.join(path.dirname(r2.parts[0].log), launches[launches.length - 1]), 'utf8')).argv.slice(-1)[0];
  assert(/started this part and stopped for its allowance/.test(handoff) && /git log/.test(handoff), 'no handoff for OpenCode: ' + handoff.slice(-600));
  fs.writeFileSync(path.join(ui.out, 'x-handoff.txt'), handoff);
  await ui.sleep(1500);
  await clearOverlays(ui);
  await timelineShown(ui);
  await ui.hover({ css: '.dt-head' });
  await ui.screenshot('x02-handoff-to-opencode');
  await boxes(ui, 'x02-handoff-to-opencode', [{ n: 3, css: '.dt-band', what: 'Codex → OpenCode，新块到点回 Codex' }, { n: 2, css: '.dt-lane[data-n="1"]', what: '第 1 块由 OpenCode 接着做' }]);
  await ui.mark({ css: '.dt-band' }, { what: '换到 OpenCode：额度带写着几点新块回 Codex', where: 'Timeline 额度带', how: '点 Go on with OpenCode 以后' });
  // Codex refilled: the stand-in reading says so; the next part starts on Codex
  reading(5, 5 * 3600);
  const x3 = await waitTimeline(ui, v => v.lanes.some(l => l.n === '2' && l.bars > 0), 'part 2 starting', 1200000);
  const r3 = await cliJson(ui, 'turbo', 'status', plan.id);
  assert(r3.parts[1].engine === 'codex' && r3.switches.some(s => s.back), 'part 2 did not go back to Codex: ' + JSON.stringify({ p2: r3.parts[1].engine, switches: r3.switches }));
  await ui.sleep(1500);
  await clearOverlays(ui);
  await timelineShown(ui);
  await ui.hover({ css: '.dt-head' });
  await ui.screenshot('x03-back-to-codex');
  await boxes(ui, 'x03-back-to-codex', [{ n: 4, css: '.dt-lane[data-n="2"]', what: '第 2 块回到 Codex' }, { n: 3, css: '.dt-band', what: '额度带：两次换引擎' }]);
  await ui.mark({ css: '.dt-lane[data-n="2"]' }, { what: 'Codex 额度恢复以后，新开的块回到 Codex', where: 'Timeline 第 2 条泳道', how: '到了刷新时间自动回去' });
  const x4 = await waitTimeline(ui, v => !!v.summary || v.needs.length > 0, 'the end', 1500000);
  assert(!x4.needs.length, 'the run asked: ' + x4.needs.join(' | '));
  const r4 = await cliJson(ui, 'turbo', 'status', plan.id);
  await ui.sleep(2000);
  await timelineShown(ui);
  await ui.hover({ css: '.dt-head' });
  await ui.screenshot('x04-done');
  const notes = fs.existsSync(path.join(ui.demoFolder, 'notes')) ? fs.readdirSync(path.join(ui.demoFolder, 'notes')).sort() : [];
  assert(r4.state === 'done' && notes.length === 6, 'not done with six notes: ' + JSON.stringify({ state: r4.state, notes }));
  fs.writeFileSync(path.join(ui.out, 'x.json'), JSON.stringify({ x1, x2, x3, x4, codexCommits, doneByCodex, files1, notes,
    engines: r4.parts.map(p => [p.n, p.engine_name, p.status]), switches: r4.switches, events: r4.events }, null, 2));
}

const STAGES = { ui: ui_, many, real, switch: switchAgent, provider, midway };

export default async function (ui) {
  const want = (process.env.TURBO_STAGES || 'ui,many').split(',').map(s => s.trim()).filter(Boolean);
  try {
    for (const name of want) {
      assert(STAGES[name], 'no stage ' + name);
      await STAGES[name](ui);
    }
  } finally {
    await cancelRuns(ui);
  }
}
