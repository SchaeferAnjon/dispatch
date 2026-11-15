// A chat without a project folder keeps to itself (task-p0za2). The person's path, from a real report: in a new
// chat (the side bar's Chats +) they paste a garage's German email and ask for a reply, then tell the agent how to
// word it. Nothing of it goes into a project, nothing lines up in Next up or starts by itself, the email's own
// sentences are not taken for requests, and the Tasks tab and the Task graph show This session only (the report:
// "This session | kanban", the whole kanban project, 632 tasks). Then in a project session the same email under a
// line of the person's own: only their words are noted. Then the Task graph's card on a point: every line starts on
// one left edge, as far in as Open task is from the right and bottom border. Test model: OpenCode's cheap one.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
const fresh = '.sessions-chat-editor';
// true in the copy run on a build from before the fix (the delivery page's "before"): checks are written down, none stops it
const BEFORE = false;

// the helpers chat-capture.mjs has, here too: a scenario sent to the build service runs from a folder of its own

export const meta = {
  needs: ['opencode'],
  title: 'A chat without a project keeps to itself',
  description: '无文件夹的聊天里贴德语邮件让它起草回复：不建进项目、不排 Next up、不把邮件内容当需求；Tasks 和 Task graph 只有 This session；项目会话里贴同一封邮件只记用户自己的话；图上任务卡各行左边对齐、四周内边距一致。',
  timeout: 1800,
};

const EMAIL = 'Guten Tag Herr Weber, die Kollegen haben Ihr Auto geprüft und folgendes festgestellt: der Wählhebel hat einen Defekt, dieser sollte repariert werden. Sowie eine Getriebeölwechsel mit Spülung durchgeführt werden. Aus- und Einbau des Wählhebels 300,00 € zzgl. MwSt. Reparatur des Wählhebels 350,00 € zzgl. MwSt. Bitte geben Sie uns Bescheid wie Sie weiterverfahren möchten. MfG Anna Becker Empfang Muster Getriebe GmbH Tel: 0049 30 1234567';
const ASK_CHAT = '帮我起草一封德语回复，不要用任何工具，直接把邮件写出来：' + EMAIL;
const WORDING = '你就说：先只修选档杆，问一下什么时候能取车，不用代步车。不要用任何工具，直接改好给我';
const ASK_PROJECT = '帮我记一下：给 demo 项目加一个 NOTES.md 文件，写上修车厂邮件的要点。下面是邮件，不要用任何工具，只回复 OK：' + EMAIL;

function cli(ui, args, timeout = 60000) {
  const out = execFileSync(join(ui.rec.bin_dir, 'dispatch'), args, { encoding: 'utf8', timeout });
  const i = Math.min(...['{', '['].map(c => out.indexOf(c)).filter(x => x >= 0));
  return JSON.parse(out.slice(i));
}

async function until(ui, fn, what, ms = 120000, every = 1000) {
  const end = Date.now() + ms * SCALE;
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

/** Every receipt as written, the ones with nothing on them too (capture list leaves those out). */
const written = (ui) => { try { return readFileSync(join(ui.rec.dispatch_dir, 'capture', 'receipts.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
/** The receipt of the message that starts with these words. */
const receiptOf = (ui, words) => until(ui, async () => written(ui).filter(r => (r.text || '').startsWith(words.slice(0, 12))).at(-1) || null, `the receipt of "${words.slice(0, 12)}"`, 120000, 1500);

let soft = null;  // BEFORE: the checks that failed
/** BEFORE: a wait or a mark that fails is written down and the run goes on. */
const tolerate = (p, m) => p.catch(e => { if (!soft) throw e; soft.push(`${m}: ${e.message}`); return null; });
function assert(v, m) {
  if (v) return;
  if (soft) { soft.push(m); return; }
  throw new Error(m);
}

/** A new plain chat the way a person starts one: the + on the side bar's Chats row. */
async function newChat(ui) {
  await closeTips(ui);
  await ui.hover({ text: 'Chats', exact: true, within: '.part.sidebar', webview: false });
  await ui.sleep(400);
  await ui.click({ aria: 'New Quick Chat', exact: true, within: '.part.sidebar', webview: false });
  await ui.waitFor({ css: '.sessions-chat-session-type-picker .sessions-chat-dropdown-label' }, { timeoutMs: 30000 });
}

async function send(ui, text, css = '.sessions-chat-editor') {
  await focusInput(ui, css);
  await ui.type(text);
  await ui.press('Enter', { send: true });
}

/** The newest reply finished (not loading) and has some text. */
async function replied(ui, count, ms = 240000) {
  return until(ui, async () => ui.eval(`(() => { const rs = [...document.querySelectorAll('.interactive-response')]; const r = rs.at(-1); return rs.length >= ${count} && !!r && !r.classList.contains('chat-response-loading') && r.innerText.trim().length > 20; })()`), `reply ${count}`, ms, 1500);
}

/** What the capture line under each of the person's messages shows. */
const LINES = `[...document.querySelectorAll('.dispatch-capture')].map(h => ({ empty: h.classList.contains('empty'), line: h.querySelector('.dispatch-capture-line')?.innerText.replace(/\\s+/g, ' ').trim() || '' }))`;

export default async function (ui) {
  soft = BEFORE ? [] : null;
  const result = {};
  const note = (k, v) => { result[k] = v; writeFileSync(join(ui.out, 'result.json'), JSON.stringify(result, null, 2)); };
  await ui.openAgents(ui.demoFolder);
  await offScreen(ui);

  // 1 a new chat, no folder: paste the email and ask for a reply
  await newChat(ui);
  await ui.pickEngine('OpenCode', 360000);
  note('model', await pickModel(ui));
  await send(ui, ASK_CHAT);
  // the line under the message is read in the background: its receipt, the chat's own record of the message
  const r1 = await receiptOf(ui, ASK_CHAT);
  note('chat_receipt', r1);
  assert(r1.items.length === 0 && r1.left_out.length === 0, 'something of the chat went on the board: ' + JSON.stringify(r1));
  await replied(ui, 1);
  const sid = (r1.session || '').split('/').at(-1);
  note('chat_session', r1.session);

  // 2 telling the agent how to word its draft adds no step to anything
  await send(ui, WORDING, '.interactive-session .chat-input-container .monaco-editor, .interactive-input-part .monaco-editor');
  const r2 = await receiptOf(ui, WORDING);
  note('wording_receipt', r2);
  assert(r2.items.length === 0, 'wording the draft was noted as work: ' + JSON.stringify(r2.items));
  await replied(ui, 2);
  const line = cli(ui, ['nextup', '--json']);
  note('nextup_after_chat', line);
  assert((line.next || []).length === 0 && (line.later || []).length === 0, 'something waits in Next up or Later: ' + JSON.stringify(line));
  const lines = await ui.eval(LINES);
  note('lines_in_chat', lines);
  assert(lines.every(l => l.empty && !l.line), 'a line under a chat message says something was noted: ' + JSON.stringify(lines));
  // the board: whatever the agent or Dispatch filed for this chat is in no project
  const mine = cli(ui, ['task', 'list', '--session', sid, '--json']).tasks || [];
  note('chat_tasks', mine.map(t => ({ id: t.id, title: t.title, project: t.project })));
  assert(mine.every(t => !t.project), 'a task of the chat went into a project: ' + JSON.stringify(mine));
  await restPointer(ui);
  await ui.screenshot('01-chat-pasted-email-nothing-lined-up');
  await ui.mark({ css: '.interactive-request', index: 0 }, { what: '无文件夹的聊天里贴进来的德语邮件：下面没有 Noted 行，不排 Next up', where: '会话里你发的第一条消息', how: '侧栏 Chats 的 + 新建聊天，贴邮件让它起草回复' });

  // 3 the Task graph: This session only. A chat has no side pane tabs; the graph comes from the command palette's
  // Task Graph, which asks for the project's graph (the worst case: the report's page opened on the whole project)
  await ui.press('F1');
  await ui.type('Task Graph', { into: { css: '.quick-input-widget input' } });
  await ui.sleep(800);
  await ui.press('Enter');
  await tolerate(ui.waitFor({ css: '.dispatch-tg-empty, .dispatch-tg-lane' }, { timeoutMs: 40000 }), 'the graph of a chat drew nothing');
  await ui.sleep(800);
  const seg = await ui.eval(`[...document.querySelectorAll('.dispatch-tg-seg .dispatch-tg-seg-btn')].map(b => ({ text: b.textContent.trim(), on: b.classList.contains('on') }))`);
  const rows = await ui.eval(`Number(document.querySelector('.dispatch-graph-page')?.dataset.rows || 0)`);
  const desc = await ui.eval(`document.querySelector('.custom-view-header-description')?.textContent || ''`);
  note('chat_graph', { seg, rows, desc });
  assert(seg.length === 1 && seg[0].text === 'This session' && seg[0].on, 'the graph of a chat offers a project: ' + JSON.stringify(seg));
  assert(!/\bdemo\b|kanban/i.test(desc), 'the graph of a chat counts a project: ' + desc);
  const offer = await ui.eval(`document.querySelector('.dispatch-tg-empty-btn')?.textContent || ''`);
  assert(!offer, 'the empty graph of a chat offers a project: ' + offer);
  await ui.screenshot('03-chat-task-graph-this-session-only');
  await tolerate(ui.mark({ css: '.dispatch-tg-seg' }, { what: '无文件夹的聊天：只有 This session，没有项目标签', where: 'Task graph 页头下面', how: '命令面板 Task Graph（项目范围的入口也只给这条聊天）' }), 'no switch to mark');

  // 4 a project session: the same email under the person's own line, only their words are noted
  await newSessionInProject(ui, ui.demoFolder);
  await ui.pickEngine('OpenCode', 360000);
  await pickModel(ui);
  await send(ui, ASK_PROJECT);
  const r3 = await receiptOf(ui, ASK_PROJECT);
  note('project_receipt', r3);
  assert(r3.items.every(i => !/Wählhebel|Reparatur|Getriebe|Bescheid/i.test(i.title + ' ' + i.quote)), 'the email was taken for a request in a project: ' + JSON.stringify(r3.items));
  assert(r3.left_out.every(x => !/Bescheid|Wählhebel/i.test(x.quote)), 'the email\'s sentences were left out as questions: ' + JSON.stringify(r3.left_out));
  await replied(ui, 1).catch(() => null);
  await ui.sleep(3000);
  // the line under it, when there is one: whole, not under the message above it, and its row opens whole
  const geo = await ui.eval(`(() => {
    const host = [...document.querySelectorAll('.dispatch-capture')].find(h => !h.classList.contains('empty') && h.querySelector('.dispatch-capture-line'));
    if (!host) return null;
    const b = host.querySelector('.dispatch-capture-line').getBoundingClientRect();
    const bubble = host.previousElementSibling?.getBoundingClientRect();
    const words = host.querySelector('.dispatch-capture-words');
    return { line: host.querySelector('.dispatch-capture-line').innerText, top: b.top, bottom: b.bottom, bubbleBottom: bubble?.bottom ?? null, wordsCut: words ? words.scrollHeight > words.clientHeight + 1 : false };
  })()`);
  note('project_line', geo);
  if (geo) {
    assert(geo.bubbleBottom === null || geo.top >= geo.bubbleBottom - 0.5, 'the line sits under the message above it: ' + JSON.stringify(geo));
    await ui.click({ css: '.dispatch-capture-line' });
    await ui.waitFor({ css: '.dispatch-capture-panel' }, { timeoutMs: 10000 });
    await restPointer(ui);
    await ui.screenshot('04-project-noted-own-words-only');
  }

  // 4b the line a step added to an open task draws ("Added a step to …", the report: "+1 step on Wählhebel-Reparatur…"
  // half hidden under the message above it). The long pasted message's receipt is made to say so (Dispatch no longer
  // notes such a step from a pasted email, so the line is written in), the window reads it again, and the line has to
  // sit whole under the message: its words not cut, nothing over them.
  const seeded = ui.rec.seed && ui.rec.seed.tasks && ui.rec.seed.tasks.in_progress;
  if (seeded) {
    const file = join(ui.rec.dispatch_dir, 'capture', 'receipts.jsonl');
    const all = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const mineAt = all.map(r => r.id).lastIndexOf(r3.id);
    const own = (all[mineAt].items || []).find(i => i.kind === 'new');
    const step = { kind: 'part', task: seeded, title: 'Wählhebel-Reparatur bei Muster beauftragen (Aus-/Einbau plus Reparatur, 650 € zzgl. MwSt.)', step: '给 Muster 传话：先拆装再修变速箱、问推荐原因、尽早取车、不要代步车', quote: '帮我记一下：给 demo 项目加一个 NOTES.md 文件，写上修车厂邮件的要点' };
    const writeItems = async (items) => {
      all[mineAt] = { ...all[mineAt], items };
      writeFileSync(file, all.map(r => JSON.stringify(r)).join('\n') + '\n');
      await ui.reloadWindow();
      await ui.waitFor({ css: '.dispatch-capture-line' }, { timeoutMs: 60000 });
    };
    // first the report's line: the message added a step and nothing else
    await writeItems([step]);
    await ui.sleep(1500);
    const stepLine = await ui.eval(`(() => {
      const host = [...document.querySelectorAll('.dispatch-capture')].filter(h => !h.classList.contains('empty') && h.querySelector('.dispatch-capture-line')).at(-1);
      if (!host) return null;
      const btn = host.querySelector('.dispatch-capture-line');
      const b = btn.getBoundingClientRect();
      const words = host.querySelector('.dispatch-capture-words');
      const w = words.getBoundingClientRect();
      const bubble = host.previousElementSibling?.getBoundingClientRect();
      const probe = [0.1, 0.5, 0.9].map(f => { const el = document.elementFromPoint(w.left + w.width * f, w.top + w.height / 2); return !!el && (el === words || words.contains(el) || btn.contains(el)); });
      return { text: btn.innerText, top: b.top, height: b.height, bubbleBottom: bubble?.bottom ?? null, wordsHeight: w.height, lineHeight: parseFloat(getComputedStyle(words).lineHeight) || 0, visible: probe, fits: btn.scrollWidth <= btn.clientWidth + 1 };
    })()`);
    note('step_line', stepLine);
    assert(stepLine, 'the line is not under the message');
    if (stepLine) {
      assert(stepLine.bubbleBottom === null || stepLine.top >= stepLine.bubbleBottom - 0.5, 'the step line sits under the message above it: ' + JSON.stringify(stepLine));
      assert(stepLine.visible.every(Boolean), 'something covers the step line\'s words: ' + JSON.stringify(stepLine));
      assert(stepLine.fits, 'the step line\'s words run out of it: ' + JSON.stringify(stepLine));
      assert(/Added a step to /.test(stepLine.text), 'the step line does not say a step was added: ' + stepLine.text);
    }
    await restPointer(ui);
    await ui.screenshot('04b-step-line-whole');
    await ui.mark({ css: '.dispatch-capture-line' }, { what: '加到已有任务上的一步：标题行完整，不被上面的消息压住', where: '你发的消息正下方靠右', how: '消息给一件打开的任务加了一步时出现' });

    // then the step next to the person's own request (its quote the long message), for the panel
    await writeItems([step, ...(own ? [{ ...own, title: 'Add a NOTES.md to the demo project with the main points of the garage email, the prices and what to answer', quote: ASK_PROJECT.slice(0, 200) }] : [])]);
    await ui.sleep(1500);
    // the panel in a narrow chat (the side pane open): pointing at the step's row leaves its title readable (the
    // row's empty button strip used to cover the title line), and a cut title or quote opens whole with Show all
    await ui.click({ css: '.dispatch-capture-line' });
    await ui.waitFor({ css: '.dispatch-capture-panel' }, { timeoutMs: 10000 });
    await ui.eval(`(() => { const h = document.querySelector('.dispatch-capture-panel').closest('.dispatch-capture'); h.style.width = '420px'; h.style.marginLeft = 'auto'; return true; })()`);
    await ui.sleep(400);
    await ui.hover({ css: `.dispatch-capture-row[data-task="${seeded}"]` });
    await ui.sleep(400);
    const stepRow = await ui.eval(`(() => {
      const row = document.querySelector('.dispatch-capture-row[data-task="${seeded}"]');
      const t = row.querySelector('.dispatch-capture-title').getBoundingClientRect();
      const probe = [0.1, 0.5, 0.9].map(f => { const el = document.elementFromPoint(t.left + t.width * f, t.top + t.height / 2); return !!el && !!el.closest('.dispatch-capture-title'); });
      return { title: row.querySelector('.dispatch-capture-title').innerText, visible: probe, acts: row.querySelectorAll('.dispatch-capture-acts').length };
    })()`);
    note('step_row_hovered', stepRow);
    assert(/^(Added a step to) /.test(stepRow.title), 'the step row does not say what happened in plain words: ' + stepRow.title);
    assert(stepRow.visible.every(Boolean), 'pointing at the step row covers its title: ' + JSON.stringify(stepRow));
    await ui.screenshot('04c-step-row-hovered-narrow');
    await ui.mark({ css: `.dispatch-capture-row[data-task="${seeded}"]` }, { what: '窄聊天里指着「加了一步」那行：标题完整可读', where: 'Noted 面板', how: '点开消息下面那一行，指着它' });
    await restPointer(ui);
    // the row with the longest words: the person's own request when it was noted (its quote is the long message),
    // else the step row (its title is cut in the narrow chat)
    const target = own ? own.task : seeded;
    const full = own ? ASK_PROJECT.slice(0, 200).trim() : '';
    const rowOf = `.dispatch-capture-row[data-task="${target}"]`;
    const toggle = await ui.eval(`(() => { const t = document.querySelector('${rowOf} .dispatch-capture-whole'); return t && !t.hidden ? t.textContent : null; })()`);
    const look = await ui.eval(`(() => { const t = document.querySelector('${rowOf} .dispatch-capture-whole'); if (!t) return null; const c = getComputedStyle(t); return { underline: c.textDecorationLine, radius: c.borderRadius, size: c.fontSize }; })()`);
    note('show_all', { target, toggle, look });
    assert(!look || look.underline === 'none', 'Show all is drawn as an underlined link, not as the row\'s buttons: ' + JSON.stringify(look));
    assert(toggle === 'Show all', 'a cut row offers no Show all: ' + toggle);
    if (toggle) {
      const cut = await ui.eval(`(() => { const r = document.querySelector('${rowOf}'); const t = r.querySelector('.dispatch-capture-title'); const w = r.querySelector('.dispatch-capture-sub-words'); return { h: r.getBoundingClientRect().height, sub: w.innerText, titleCut: t.scrollWidth > t.clientWidth + 1 }; })()`);
      await ui.screenshot('05a-noted-row-cut');
      await ui.click({ css: `${rowOf} .dispatch-capture-whole` });
      await until(ui, async () => ui.eval(`!!document.querySelector('${rowOf}.whole')`), 'the row shown whole', 5000, 200);
      const whole = await ui.eval(`(() => { const r = document.querySelector('${rowOf}.whole'); const t = r.querySelector('.dispatch-capture-title'); return { h: r.getBoundingClientRect().height, sub: r.querySelector('.dispatch-capture-sub-words').innerText, titleCut: t.scrollWidth > t.clientWidth + 1, toggle: r.querySelector('.dispatch-capture-whole').textContent }; })()`);
      note('show_all_whole', { cut, whole });
      assert(whole.h > cut.h && whole.toggle === 'Show less' && !whole.titleCut, 'Show all did not open the row whole: ' + JSON.stringify({ cut, whole }));
      assert(!full || whole.sub.includes(full.slice(-40)), 'Show all did not show the whole quote: ' + whole.sub);
      await restPointer(ui);
      await ui.screenshot('05b-noted-row-shown-whole');
      await ui.mark({ css: `${rowOf}.whole .dispatch-capture-whole` }, { what: '截断的标题和原话：点 Show all 看全，Show less 收起', where: 'Noted 面板那一行第二行末尾', how: '点开消息下面那一行' });
      await ui.click({ css: `${rowOf}.whole .dispatch-capture-whole` });
      await until(ui, async () => ui.eval(`!document.querySelector('${rowOf}.whole')`), 'the row cut again', 5000, 200);
    }
  }

  // 5 the Task graph's card on a point: one left edge, the same padding on every side
  await ui.press('F1');
  await ui.type('Task Graph', { into: { css: '.quick-input-widget input' } });
  await ui.sleep(800);
  await ui.press('Enter');
  await ui.waitFor({ css: '.dispatch-tg-seg-btn' }, { timeoutMs: 40000 });
  const segs = await ui.eval(`[...document.querySelectorAll('.dispatch-tg-seg .dispatch-tg-seg-btn')].map(b => b.textContent.trim())`);
  note('project_graph_seg', segs);
  assert(segs.length === 2, 'a project session lost its project switch: ' + JSON.stringify(segs));
  if (!(await ui.exists({ css: '.dispatch-tg-seg-btn.on', index: 1 }))) await ui.click({ css: '.dispatch-tg-seg-btn', index: 1 });
  await ui.waitFor({ css: '.dispatch-tg-lane' }, { timeoutMs: 40000 });
  const hits = await ui.eval(`document.querySelectorAll('.dispatch-tg-hit').length`);
  let card = null;
  for (let i = 0; i < hits && !card; i++) {
    await ui.hover({ css: '.dispatch-tg-hit', index: i }, { settleMs: 900 });
    card = await ui.eval(`(() => {
      const c = document.querySelector('.workbench-hover-container .dispatch-tg-task-card');
      if (!c) return null;
      const box = c.closest('.monaco-hover').getBoundingClientRect();
      const kids = [...c.children].map(k => ({ cls: k.className, left: k.getBoundingClientRect().left - box.left }));
      const open = [...c.querySelectorAll('.dispatch-detail-btn')].find(b => b.textContent.trim() === 'Open task')?.getBoundingClientRect();
      return { kids, open: open && { right: box.right - open.right, bottom: box.bottom - open.bottom } };
    })()`);
    if (!card) await restPointer(ui);
  }
  note('task_card', card);
  if (soft) note('failed_checks', soft);
  assert(card, 'no point showed a task card');
  if (!card) return result;
  const lefts = card.kids.map(k => Math.round(k.left));
  assert(new Set(lefts).size === 1, 'the card\'s lines do not share one left edge: ' + JSON.stringify(card.kids));
  // the hover's 1px border is inside the box: the padding is the distance less that border
  const pad = lefts[0] - 1;
  assert(pad >= 12, 'the card\'s lines are too close to its border: ' + pad);
  assert(Math.abs(card.open.right - 1 - pad) <= 1 && Math.abs(card.open.bottom - 1 - pad) <= 1, 'Open task is not as far from the border as the lines: ' + JSON.stringify(card));
  await ui.screenshot('06-graph-task-card-aligned');
  await ui.mark({ css: '.workbench-hover-container .dispatch-tg-task-card' }, { what: '图上任务卡：各行左边对齐，四周内边距一致', where: 'Task graph 悬停一个点', how: '项目范围，指着一个点' });
  if (soft) note('failed_checks', soft);
  return result;
}
