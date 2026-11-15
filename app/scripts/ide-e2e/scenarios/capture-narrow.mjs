// The line under the person's message when the chat is narrow (task-v0a2f, found in the b8-core walk 10-08): with
// the side pane open, the first-time note under "Noted 1" ("Dispatch writes down what you ask for…") came out one
// word a line and stretched the bubble far down. The person's path: a new session in the demo project, Tasks open in
// the side pane, a message with a thing for later, OpenCode's DeepSeek Flash answering. Then the note and the open
// panel are measured (lines, words a line, widths) in the dark and the light theme, and once more with the side
// pane dragged wider so the chat is narrower still. Self-contained: the build service runs a copy of this file.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const meta = { needs: ['opencode'], title: 'Noted line in a narrow chat', description: 'The note under a message wraps at the bubble\'s width, not one word a line.', timeout: 1200 };

const fresh = '.sessions-chat-editor';
const MESSAGE = 'One small thing for this project, for later: add a file NOTES.md with the line "Read me first". Do not do it now. Just reply OK.';

function assert(v, m) { if (!v) throw new Error(m); }

function cli(ui, args, timeout = 60000) {
  const out = execFileSync(join(ui.rec.bin_dir, 'dispatch'), args, { encoding: 'utf8', timeout });
  const i = Math.min(...['{', '['].map(c => out.indexOf(c)).filter(x => x >= 0));
  return JSON.parse(out.slice(i));
}

async function until(ui, fn, what, ms = 120000, every = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await ui.sleep(every);
  }
  throw new Error(`Timed out: ${what}`);
}

async function closeTips(ui) {
  for (let i = 0; i < 5 && (await ui.exists({ css: 'button.dispatch-tour-close' })); i++) {
    await ui.click({ css: 'button.dispatch-tour-close' });
    await ui.sleep(600);
  }
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

async function focusInput(ui) {
  for (let i = 0; i < 8; i++) {
    await ui.click({ css: i % 2 ? `${fresh} .view-lines` : fresh });
    await ui.sleep(400);
    if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('${fresh}')`)) return;
    await ui.sleep(800);
  }
  throw new Error('The message box does not take the focus');
}

/** DeepSeek Flash from the slash menu (the test model of this project), a free Flash when it is missing. */
async function pickModel(ui) {
  await focusInput(ui);
  await ui.type('/model');
  await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 30000 });
  let seen = '';
  const row = await until(ui, async () => {
    const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => ({name:r.querySelector('.dsm-name')?.textContent}))`);
    seen = rows.map(r => r.name).join(', ');
    return rows.find(r => /DeepSeek.*Flash/i.test(r.name || '')) || rows.find(r => /Flash.*Free|Free.*Flash/i.test(r.name || ''));
  }, 'a test model', 45000).catch(e => { throw new Error(`${e.message}; the menu had: ${seen}`); });
  const typed = async () => ui.eval(`document.querySelector('${fresh} .view-lines')?.textContent || ''`);
  for (let i = 0; i < 40 && (await typed()).trim(); i++) await ui.press('Backspace');
  await ui.type(`/${row.name.replace(/\s+/g, '')}`);
  await until(ui, async () => ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row .dsm-name')].some(n => n.textContent === ${JSON.stringify(row.name)})`), `the menu row ${row.name}`, 20000);
  await ui.click({ text: row.name, exact: true, within: '.dispatch-slash-menu' });
  await ui.press('Escape');
  return row.name;
}

/** The note and the line under the message as laid out: how many lines the note's words take, the fewest words on
 *  a line, and the widths of the bubble, the line's host and the note. */
const MEASURE = `(() => {
  const host = [...document.querySelectorAll('.dispatch-capture')].find(h => h.querySelector('.dispatch-capture-line'));
  if (!host) return null;
  const box = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
  const linesOf = el => {
    if (!el) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const rows = new Map();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const re = /\\S+/g; let m;
      while ((m = re.exec(n.data))) {
        const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
        const top = Math.round(r.getBoundingClientRect().top);
        rows.set(top, (rows.get(top) || 0) + 1);
      }
    }
    const counts = [...rows.values()];
    return { lines: counts.length, words: counts.reduce((a, b) => a + b, 0), fewest: counts.length ? Math.min(...counts.slice(0, -1).concat(counts.length === 1 ? counts : [])) : 0 };
  };
  const row = host.closest('.interactive-item-container');
  const chain = []; for (let e = host.parentElement, i = 0; e && i < 4; e = e.parentElement, i++) { const cs = getComputedStyle(e); chain.push({ cls: String(e.className).slice(0, 70), display: cs.display, dir: cs.flexDirection, w: box(e).w }); }
  return {
    chat: box(host.closest('.interactive-session')),
    row: box(row),
    bubble: box(row?.querySelector('.value .rendered-markdown')),
    host: box(host),
    line: box(host.querySelector('.dispatch-capture-line')),
    lineText: host.querySelector('.dispatch-capture-line')?.innerText.replace(/\\s+/g, ' ').trim() || '',
    hint: box(host.querySelector('.dispatch-capture-hint')),
    hintWords: linesOf(host.querySelector('.dispatch-capture-hint-words')),
    hintText: host.querySelector('.dispatch-capture-hint')?.innerText.replace(/\\s+/g, ' ').trim() || '',
    panel: box(host.querySelector('.dispatch-capture-panel')),
    foot: linesOf(host.querySelector('.dispatch-capture-foot-words')),
    rows: [...host.querySelectorAll('.dispatch-capture-row')].map(r => ({ row: box(r), title: box(r.querySelector('.dispatch-capture-title')), sub: box(r.querySelector('.dispatch-capture-sub')) })),
    chain,
  };
})()`;

/** Drag the sash on the chat's right edge (between the chat and the side pane) until the chat is about `want` px. */
async function narrowChat(ui, want) {
  const before = await ui.eval(`Math.round([...document.querySelectorAll('.interactive-session')].map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0).sort((a, b) => b.height - a.height)[0].width || 0)`);
  for (let i = 0; i < 3; i++) {
    const s = await ui.eval(`(() => {
      const c = [...document.querySelectorAll('.interactive-session')].map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0).sort((a, b) => b.height - a.height)[0];
      if (!c) return null;
      const right = c.right;
      const sashes = [...document.querySelectorAll('.monaco-sash.vertical')].map(e => e.getBoundingClientRect())
        .filter(r => r.height > 200 && r.width > 0).map(r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2, d: Math.abs(r.left + r.width / 2 - right) }))
        .sort((a, b) => a.d - b.d);
      return sashes[0] && sashes[0].d < 40 ? { ...sashes[0], w: c.width } : null;
    })()`);
    if (!s || s.w <= want + 60) break;
    const dx = s.w - want;
    await ui.mouse('mouseMoved', s.x, s.y);
    await ui.sleep(300);
    await ui.mouse('mousePressed', s.x, s.y, { clickCount: 1 });
    for (let k = 1; k <= 12; k++) {
      await ui.mouse('mouseMoved', s.x - (dx * k) / 12, s.y);
      await ui.sleep(40);
    }
    await ui.mouse('mouseReleased', s.x - dx, s.y, { clickCount: 1 });
    await ui.sleep(1000);
  }
  return { before, after: await ui.eval(`Math.round([...document.querySelectorAll('.interactive-session')].map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0).sort((a, b) => b.height - a.height)[0].width || 0)`) };
}

async function shoot(ui, name, m) {
  await ui.screenshot(name);
  if (m?.panel) await ui.mark({ css: '.dispatch-capture-panel' }, { what: 'the panel Noted 1 opens', where: 'under the person\'s message', how: 'click Noted 1' });
  else if (m?.hint) await ui.mark({ css: '.dispatch-capture-hint' }, { what: 'the first-time note under Noted 1', where: 'under the person\'s message', how: 'send a message with a thing for later' });
}

const look = async (ui) => { await ui.scrollTo('Dispatch writes down what you ask for').catch(() => undefined); await ui.sleep(700); return ui.eval(MEASURE); };

export default async function (ui) {
  const result = {};
  const note = (k, v) => { result[k] = v; writeFileSync(`${ui.out}/narrow.json`, JSON.stringify(result, null, 2)); };
  await ui.openAgents(ui.demoFolder);
  await newSessionInProject(ui, ui.demoFolder);
  await ui.pickEngine('OpenCode', 360000);
  note('model', await pickModel(ui));
  await ui.openTab('Tasks');
  await ui.sleep(1000);
  await focusInput(ui);
  await ui.type(MESSAGE);
  await ui.press('Enter', { send: true });
  await until(ui, async () => { const d = await ui.eval(MEASURE); return d && /Noted/.test(d.lineText) && d.hint ? d : null; }, 'the line "Noted" and its first-time note', 120000, 500);
  await until(ui, async () => ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return !!r && !r.classList.contains('chat-response-loading') && /\\bOK\\b/i.test(r.innerText); })()`), 'the reply OK', 240000).catch(() => undefined);
  await ui.sleep(1500);
  await ui.mouse('mouseMoved', 5, 400);
  await closeTips(ui);

  const out = {};
  await ui.setTheme('dark');
  await closeTips(ui);
  out.wide = await look(ui);
  note('wide', out.wide);
  await shoot(ui, 'n0-wide-dark', out.wide);
  const openPanel = async () => {
    for (let i = 0; i < 4 && !(await ui.exists({ css: '.dispatch-capture-panel' })); i++) {
      await closeTips(ui);
      await ui.click({ css: '.dispatch-capture-line' });
      await ui.waitFor({ css: '.dispatch-capture-panel' }, { timeoutMs: 5000 }).catch(() => undefined);
    }
    await ui.waitFor({ css: '.dispatch-capture-panel' }, { timeoutMs: 5000 });
  };
  // the chat as narrow as in the b8-core walk (294 px there): the side pane dragged wider. Settings (where the theme
  // is picked) lays the window out again, so the chat is narrowed again after the switch to light
  for (const mode of ['dark', 'light']) {
    if (mode === 'light') {
      await ui.setTheme('light');
      await ui.sleep(1500);
    }
    await closeTips(ui);
    out[`drag_${mode}`] = await narrowChat(ui, 250);
    note(`drag_${mode}`, out[`drag_${mode}`]);
    await ui.mouse('mouseMoved', 5, 400);
    if (mode === 'dark' || !(await ui.exists({ css: '.dispatch-capture-panel' }))) {
      out[mode] = await look(ui);
      note(mode, out[mode]);
      await shoot(ui, `n1-narrow-${mode}`, out[mode]);
    }
    await openPanel();
    await closeTips(ui);
    out[`drag_panel_${mode}`] = await narrowChat(ui, 250); // a tip closed on the way can lay the window out again
    await ui.mouse('mouseMoved', 5, 400);
    await ui.sleep(800);
    out[`panel_${mode}`] = await ui.eval(MEASURE);
    note(`panel_${mode}`, out[`panel_${mode}`]);
    if (!out[mode]) out[mode] = out[`panel_${mode}`];
    await shoot(ui, `n2-panel-narrow-${mode}`, out[`panel_${mode}`]);
    if (mode === 'dark') {
      await narrowChat(ui, 250);
      await ui.hover({ css: '.dispatch-capture-row .dispatch-capture-title' });
      await ui.sleep(500);
      out.hover = await ui.eval(`(() => { const r = document.querySelector('.dispatch-capture-row'); const a = r?.querySelector('.dispatch-capture-acts'); const t = r?.querySelector('.dispatch-capture-title'); const b = x => { const q = x?.getBoundingClientRect(); return q ? { x: Math.round(q.left), w: Math.round(q.width), h: Math.round(q.height) } : null; }; const tr = t?.getBoundingClientRect(); const btn = a?.querySelector('button')?.getBoundingClientRect(); const hit = (x, y) => { const e = document.elementFromPoint(x, y); return e ? (e.closest('button')?.className || e.className || e.tagName) : ''; }; return { hitTitleStart: tr ? hit(tr.left + 8, tr.top + tr.height / 2) : '', hitButton: btn ? hit(btn.left + btn.width / 2, btn.top + btn.height / 2) : '', row: b(r), title: b(t), acts: b(a), visible: a ? getComputedStyle(a).visibility + '/' + getComputedStyle(a).opacity : '', buttons: [...(a?.querySelectorAll('button') || [])].map(x => x.innerText || x.getAttribute('aria-label')) }; })()`);
      note('hover', out.hover);
      await ui.screenshot('n3-row-hover-dark');
      await ui.mark({ css: '.dispatch-capture-row' }, { what: 'a row of the panel, its actions on hover', where: 'the panel under the message', how: 'point at the row' });
      await ui.mouse('mouseMoved', 5, 400);
    }
  }
  note('measured', out);
  note('receipts', (() => { try { return cli(ui, ['capture', 'list', '--json']).receipts?.slice(0, 2); } catch (e) { return String(e); } })());

  for (const k of ['dark', 'light', 'panel_dark', 'panel_light']) assert(out[k]?.chat?.w <= 320, `${k}: the chat did not get narrow: ${out[k]?.chat?.w} px`);
  // the note wraps at its own width: several words on every line but the last
  for (const k of ["wide", "dark", "panel_light"]) {
    const m = out[k];
    assert(m?.hint && m.hintWords, `${k}: no note under the line`);
    assert(m.hint.w >= Math.min(260, 0.7 * m.row.w), `${k}: the note is ${m.hint.w} px wide in a ${m.row.w} px row`);
    assert(m.hintWords.fewest >= 3, `${k}: a line of the note has ${m.hintWords.fewest} word(s) (${m.hintWords.lines} lines for ${m.hintWords.words} words, the words ${m.hintWords && m.words?.w} px wide)`);
  }
  assert(/dispatch-capture-title/.test(out.hover?.hitTitleStart || ''), `on hover the start of the title is covered: ${out.hover?.hitTitleStart}`);
  assert(/dispatch-capture-act|dispatch-capture-more/.test(out.hover?.hitButton || ''), `on hover the first action is not under the pointer: ${out.hover?.hitButton}`);
  for (const k of ['panel_dark', 'panel_light']) {
    const p = out[k];
    assert(p?.panel && p.rows.length, `${k}: the panel did not open`);
    assert(p.row.w <= p.chat.w, `${k}: the message row is ${p.row.w} px in a ${p.chat.w} px chat`);
    for (const r of p.rows) assert(r.title && r.title.w >= 0.5 * (r.row.w - 40), `${k}: a row's title is ${r.title?.w} px wide in a ${r.row.w} px row`);
    assert(p.foot && p.foot.fewest >= 3, `${k}: the foot's sentence: ${JSON.stringify(p.foot)}`);
  }
  return out;
}
