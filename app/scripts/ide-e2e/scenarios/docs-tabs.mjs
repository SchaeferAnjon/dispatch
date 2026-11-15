// A document opened from Docs is a tab of its own in the side pane's strip (user 2026-10-10: "when I open any doc,
// its tab can appear here", pointing after Changes / Files / Docs / Tasks). Three documents of different kinds from
// a real-size project (the demo project with a copy of this checkout's design/ and docs/: hundreds of pages),
// the strip read after each step:
// switch, open the same one again, close, hover for the path, two sessions keeping their own tabs, a narrow pane.
// Two short OpenCode messages on the cheap test model (two sessions have to exist for their tabs to be kept).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const meta = {
  title: 'Docs 里打开的文档成为右栏的标签',
  description: '开三篇不同类型的文档，各成一个标签；切换、重复打开不重复、关闭回上一个、悬停看路径、两个会话各记各的、窄右栏省略。',
  needs: ['opencode'],
  timeout: 1200,
};

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
/** Where the real-size documents come from (their .md and .html are copied; the source is only read). */
const SOURCE = process.env.DOCS_TABS_SOURCE || fileURLToPath(new URL('../../../../', import.meta.url)); // this checkout

const STRIP = `(() => {
  const t = [...document.querySelectorAll('.part.editor .tabs-container')].find(e => e.getBoundingClientRect().width > 0);
  if (!t) return null;
  const title = t.closest('.title');
  return {
    fit: title.classList.contains('dispatch-tabs-icons') ? 'icons' : title.classList.contains('dispatch-tabs-compact') ? 'compact' : 'names',
    scroll: [t.scrollWidth, t.clientWidth],
    tabs: [...t.querySelectorAll('.tab')].map(x => {
      const name = x.querySelector('.monaco-icon-label-container');
      const close = x.querySelector('.tab-actions .action-label');
      return {
        label: x.getAttribute('aria-label'), active: x.classList.contains('active'), w: Math.round(x.getBoundingClientRect().width),
        doc: !!x.querySelector('.tab-label.dispatch-doc-tab'),
        icon: [...(x.querySelector('.tab-label')?.classList || [])].find(c => c.startsWith('codicon-')) || null,
        nameShown: !!name && name.getBoundingClientRect().width > 0, cut: !!name && name.scrollWidth > name.clientWidth + 1,
        close: !!close && getComputedStyle(x.querySelector('.tab-actions')).visibility !== 'hidden',
      };
    }),
  };
})()`;

/** What the pane in front shows: the list, or the reader of which file. */
const SHOWN = `(() => {
  const roots = [...document.querySelectorAll('.dispatch-docs')].filter(e => e.getBoundingClientRect().width > 0);
  const r = roots[0];
  // a page (HTML) opens in the integrated browser in its own tab, not in the Docs reader (fb6a2ee2)
  if (!r) return { kind: document.querySelector('.part.editor .tabs-container .tab.active.dispatch-tab-doc') ? 'page' : 'other' };
  if (!r.classList.contains('reading')) return { kind: 'list', rows: r.querySelectorAll('.dispatch-docs-row').length };
  const addr = r.querySelector('.dispatch-docs-browser-bar .addr .f');
  const h1 = r.querySelector('h1.dispatch-docs-title, .dispatch-docs-reader-head .ht');
  return { kind: 'doc', title: h1 ? h1.textContent : '', file: addr ? addr.textContent : '', md: !!r.querySelector('.dispatch-docs-md .md-block') };
})()`;

const tabSel = (label) => ({ css: `.part.editor .tabs-container .tab[aria-label=${JSON.stringify(label)}]` });

/** Drags the sash on the side pane's left edge until the pane is `width` wide (docs-fast.mjs). */
async function paneWidth(ui, width) {
  for (let round = 0; round < 3; round++) {
    const info = await ui.eval(`(() => { const g = [...document.querySelectorAll('.part.editor')].find(e => e.getBoundingClientRect().width > 0); const r = g.getBoundingClientRect(); const s = [...document.querySelectorAll('.monaco-sash.vertical')].map(e => e.getBoundingClientRect()).filter(b => b.height > 200 && Math.abs(b.x + b.width / 2 - r.x) < 12)[0]; return { w: r.width, right: r.right, sash: s ? { x: s.x + s.width / 2, y: s.y + s.height / 2 } : null }; })()`);
    if (!info.sash || Math.abs(info.w - width) < 6) return Math.round(info.w);
    const to = info.right - width;
    await ui.mouse('mouseMoved', info.sash.x, info.sash.y);
    await ui.mouse('mousePressed', info.sash.x, info.sash.y, { button: 'left', clickCount: 1 });
    for (let i = 1; i <= 10; i++) await ui.mouse('mouseMoved', info.sash.x + ((to - info.sash.x) * i) / 10, info.sash.y, { button: 'left', buttons: 1 });
    await ui.mouse('mouseReleased', to, info.sash.y, { button: 'left', clickCount: 1 });
    await ui.sleep(700);
  }
  return ui.eval(`Math.round([...document.querySelectorAll('.part.editor')].find(e => e.getBoundingClientRect().width > 0).getBoundingClientRect().width)`);
}

export default async function (ui) {
  const PROJECT = ui.demoFolder;
  for (const dir of ['design', 'docs']) {
    if (!fs.existsSync(path.join(PROJECT, dir)) && fs.existsSync(path.join(SOURCE, dir))) {
      // the documents only (design/ also holds gigabytes of screenshots, which OpenCode's snapshot of the project would copy)
      const r = spawnSync('rsync', ['-a', '--prune-empty-dirs', '--include=*/', '--include=*.md', '--include=*.html', '--exclude=*', `${path.join(SOURCE, dir)}/`, `${path.join(PROJECT, dir)}/`], { encoding: 'utf8', timeout: 120000 });
      if (r.status !== 0) throw new Error(`copy ${dir}: ${r.stderr}`);
    }
  }
  const qa = { checks: [], failed: [], steps: [] };
  const note = () => fs.writeFileSync(path.join(ui.out, 'qa.json'), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
    console.error(`${ok ? 'ok' : 'FAILED'}: ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
    note();
  };
  const record = async (step, extra = {}) => {
    const s = { step, strip: await ui.eval(STRIP), shown: await ui.eval(SHOWN), ...extra };
    qa.steps.push(s);
    note();
    return s;
  };

  /** A session on the project with one short reply, so it is a real session whose tabs are kept. */
  const startSession = async (word) => {
    await ui.newSession(PROJECT);
    await ui.pickEngine('OpenCode', 240000);
    await ui.pickCheapModel();
    await ui.sleep(1000);
    await ui.click({ css: '.sessions-chat-editor' });
    await ui.type(`Reply exactly ${word}. Do not use any tools.`);
    await ui.press('Enter', { send: true });
    await ui.waitFor({ text: word, within: '.interactive-response' }, { timeoutMs: 360000 * SCALE });
    await ui.sleep(4000);
    // its row in the sessions list, by the title the window gives it
    return ui.eval(`document.querySelector('.session-list-inset-row.selected .session-title, .session-list-inset-row.focused .session-title')?.textContent.trim() || ''`);
  };

  /** Opens the Docs list on the whole project (not only this session's documents). */
  const docsList = async () => {
    await ui.openTab('Docs');
    const project = { css: '.dispatch-docs-scope .dispatch-docs-pill:nth-child(2)' };
    await ui.waitFor(project, { timeoutMs: 30000 });
    if (await ui.eval(`document.querySelector('.dispatch-docs-scope .dispatch-docs-pill:nth-child(2)').getAttribute('aria-selected') !== 'true'`)) await ui.click(project);
    await ui.waitFor({ css: '.dispatch-docs-row' }, { timeoutMs: 120000 });
  };

  /** Clicks a row of the list and times it: click to the document's tab in front, and to its content on screen. */
  const openRow = async (docPath) => {
    const row = { css: `.dispatch-docs-row[data-doc-path=${JSON.stringify(docPath)}]` };
    if (!(await ui.exists(row))) {
      await ui.click({ css: '.dispatch-docs-search-box' });
      await ui.type(path.basename(path.dirname(docPath)), { into: { css: '.dispatch-docs-search-input' } });
      await ui.waitFor(row, { timeoutMs: 10000 });
    }
    // timed from the press of the mouse button on the row (the runner's own steps before it are not the app's)
    await ui.eval(`(() => { const f = window.__docTab = { t0: 0 }; addEventListener('mousedown', () => { if (!f.t0) f.t0 = performance.now(); }, { capture: true, once: true }); const o = new MutationObserver(() => {
      const now = performance.now();
      if (!f.t0) return;
      const active = document.querySelector('.part.editor .tabs-container .tab.active.dispatch-tab-doc');
      if (!f.tab && active) f.tab = now;
      const r = [...document.querySelectorAll('.dispatch-docs.reading')].find(e => e.getBoundingClientRect().width > 0);
      // a document: its reader drew it; a page: its browser tab is in front (the page itself paints natively)
      const page = active && !active.querySelector('.tab-label.dispatch-doc-tab');
      if (!f.content && ((r && r.querySelector('.dispatch-docs-md .md-block')) || page)) { f.content = now; o.disconnect(); }
    }); o.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }); })()`);
    await ui.click(row);
    for (let i = 0; i < 40 && !(await ui.eval('!!window.__docTab.content')); i++) await ui.sleep(100);
    return ui.eval(`(() => { const f = window.__docTab; return { tabMs: f.tab ? Math.round(f.tab - f.t0) : null, contentMs: f.content ? Math.round(f.content - f.t0) : null, command: window.__dispatchDocTabMs ?? null }; })()`);
  };

  await ui.openAgents(PROJECT);
  if (await ui.exists({ text: "Don't Show Again", exact: true })) await ui.click({ text: "Don't Show Again", exact: true });

  // 0. Session A: a real session on the project
  const titleA = await startSession('ALPHA');
  await docsList();
  await paneWidth(ui, 720);
  await record('a-list');
  await ui.screenshot('01-list');

  // 1. Three documents of three kinds: a delivery page (HTML), a design README, a review
  const pick = await ui.eval(`(() => {
    const rows = [...document.querySelectorAll('.dispatch-docs-row')].map(r => ({ p: r.dataset.docPath, t: r.querySelector('.t').textContent, g: r.closest('.dispatch-docs-group')?.querySelector('.dispatch-docs-group-head .name')?.textContent || '' }));
    const page = rows.find(r => /\\.html?$/.test(r.p));
    const readme = rows.find(r => /README\\.md$/.test(r.p) && r.p !== page?.p);
    const review = rows.find(r => r.g === 'Reviews') || rows.find(r => /review/i.test(r.p) && /\\.md$/.test(r.p));
    const handoff = rows.find(r => r.g === 'Handoffs' || r.g === 'Notes');
    return { page, readme, review, handoff };
  })()`);
  qa.picked = pick;
  check('the list has a page, a README and a review', !!pick.page && !!pick.readme && !!pick.review, pick);
  const opened = [];
  for (const [i, d] of [pick.page, pick.readme, pick.review].entries()) {
    await ui.openTab('Docs');
    const t = await openRow(d.p);
    await ui.sleep(600);
    const s = await record(`open-${i + 1}`, { doc: d, timing: t });
    const active = s.strip.tabs.find(x => x.active);
    opened.push(active?.label);
    check(`open ${i + 1}: its own tab, in front, named like the row`, !!active?.doc && active.label === d.t, { active, row: d.t });
    check(`open ${i + 1}: the tab shows in under ${400 * SCALE} ms and the document in under ${1500 * SCALE} ms`, t.tabMs !== null && t.tabMs < 400 * SCALE && t.contentMs !== null && t.contentMs < 1500 * SCALE, t);
    await ui.screenshot(`0${2 + i}-open-${i + 1}`);
  }
  const afterThree = qa.steps[qa.steps.length - 1].strip;
  const docTabs = afterThree.tabs.filter(t => t.doc).map(t => t.label);
  check('three documents: three tabs after Changes, Files, Docs, Tasks', docTabs.length === 3 && afterThree.tabs.slice(-3).every(t => t.doc), afterThree.tabs.map(t => t.label));
  check('a page has the globe icon, a Markdown file the text icon', afterThree.tabs.filter(t => t.doc).map(t => t.icon).join() === 'codicon-globe,codicon-file-text,codicon-file-text', afterThree.tabs.map(t => t.icon));
  await ui.mark(tabSel(opened[2]), { what: '打开的文档成为自己的标签', where: '右栏标签栏，Tasks 之后', how: 'Docs 里点任意一篇' });

  // 2. Hover: the whole path
  await ui.hover(tabSel(opened[1]));
  await ui.sleep(1500);
  const hover = await ui.eval(`[...document.querySelectorAll('.monaco-hover, .workbench-hover, .monaco-hover-content')].map(e => e.innerText).join(' | ')`);
  check('hovering a document tab shows its whole path', hover.includes(pick.readme.p), { hover });
  await ui.screenshot('05-hover');

  // 3. Switching: Docs is the list, a document's tab is its reader
  await ui.click(tabSel('Docs'));
  await ui.sleep(500);
  const list = await record('switch-docs');
  check('Docs: the list', list.shown.kind === 'list' && list.shown.rows > 0, list.shown);
  await ui.click(tabSel(opened[0]));
  await ui.sleep(800);
  const back0 = await record('switch-doc-1');
  check('the first document\'s tab: its page', back0.shown.kind === 'page' && back0.strip.tabs.find(t => t.active)?.label === opened[0], back0.shown);
  await ui.click(tabSel(opened[1]));
  await ui.sleep(500);
  const back1 = await record('switch-doc-2');
  check('the second document\'s tab: its reading page', back1.shown.kind === 'doc' && back1.shown.md, back1.shown);
  await ui.screenshot('06-switch');
  // "‹ Docs" in a document's head, and Esc: the Docs tab with its list
  await ui.click({ css: '.dispatch-docs.reading .dispatch-docs-back' });
  await ui.sleep(500);
  const viaBack = await record('back-button');
  check('"‹ Docs" brings the Docs tab and its list to the front', viaBack.strip.tabs.find(t => t.active)?.label === 'Docs' && viaBack.shown.kind === 'list', viaBack.shown);
  await ui.click(tabSel(opened[2]));
  await ui.sleep(500);
  await ui.press('Escape');
  await ui.sleep(500);
  const viaEsc = await record('escape');
  check('Esc in a document: the Docs list', viaEsc.strip.tabs.find(t => t.active)?.label === 'Docs' && viaEsc.shown.kind === 'list', viaEsc.shown);

  // 4. The same document again: no second tab, its tab comes to the front
  await ui.click(tabSel('Docs'));
  await openRow(pick.page.p);
  await ui.sleep(600);
  const again = await record('open-again');
  check('the same document again: still three document tabs, the page in front', again.strip.tabs.filter(t => t.doc).length === 3 && again.strip.tabs.find(t => t.active)?.label === opened[0], again.strip.tabs.map(t => [t.label, t.active]));

  // 5. Close: back to the one before (the second document, shown last before the Docs list)
  await ui.click(tabSel(opened[1]));
  await ui.sleep(400);
  await ui.click(tabSel(opened[0]));
  await ui.sleep(400);
  const closeBtn = await ui.eval(`(() => { const t = document.querySelector('.part.editor .tabs-container .tab.active'); const b = t && t.querySelector('.tab-actions .action-label'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, aria: b.getAttribute('aria-label') }; })()`);
  await ui.screenshot('07-before-close');
  await ui.click({ css: '.part.editor .tabs-container .tab.active .tab-actions .action-label' });
  await ui.sleep(600);
  const closed = await record('close', { closeBtn });
  check('closing the page\'s tab: two document tabs, the one shown before it is in front', closed.strip.tabs.filter(t => t.doc).length === 2 && closed.strip.tabs.find(t => t.active)?.label === opened[1], closed.strip.tabs.map(t => [t.label, t.active]));
  await ui.screenshot('08-after-close');

  // 6. Session B: its own tabs; then back to A, and to B again
  const titleB = await startSession('BRAVO');
  qa.sessions = { a: titleA, b: titleB };
  await docsList();
  const tB = await openRow(pick.handoff?.p || pick.page.p);
  await ui.sleep(800);
  const inB = await record('session-b', { timing: tB });
  check('session B starts without A\'s documents and gets its own', inB.strip.tabs.filter(t => t.doc).length === 1, inB.strip.tabs.map(t => t.label));
  await ui.screenshot('09-session-b');
  const sessionRow = (title) => ui.eval(`(() => { const r = [...document.querySelectorAll('.session-list-inset-row')].find(e => e.querySelector('.session-title')?.textContent.trim() === ${JSON.stringify(title)}); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, label: r.getAttribute('aria-label') }; })()`);
  const rowA = await sessionRow(titleA);
  qa.sessionRows = { a: rowA };
  check('session A is in the sessions list', !!rowA, rowA);
  if (rowA) {
    await ui.mouse('mouseMoved', rowA.x, rowA.y);
    await ui.mouse('mousePressed', rowA.x, rowA.y, { button: 'left', clickCount: 1 });
    await ui.mouse('mouseReleased', rowA.x, rowA.y, { button: 'left', clickCount: 1 });
    await ui.sleep(3000);
    const inA = await record('back-to-a');
    check('back in session A: its two document tabs, the second in front', inA.strip.tabs.filter(t => t.doc).map(t => t.label).join('|') === [opened[1], opened[2]].join('|'), inA.strip.tabs.map(t => [t.label, t.active]));
    await ui.screenshot('10-back-to-a');
    const rowB = await sessionRow(titleB);
    if (rowB) {
      await ui.mouse('mouseMoved', rowB.x, rowB.y);
      await ui.mouse('mousePressed', rowB.x, rowB.y, { button: 'left', clickCount: 1 });
      await ui.mouse('mouseReleased', rowB.x, rowB.y, { button: 'left', clickCount: 1 });
      await ui.sleep(3000);
      const inB2 = await record('back-to-b');
      check('back in session B: its one document tab', inB2.strip.tabs.filter(t => t.doc).length === 1, inB2.strip.tabs.map(t => [t.label, t.active]));
    }
    await ui.mouse('mouseMoved', rowA.x, rowA.y);
    await ui.mouse('mousePressed', rowA.x, rowA.y, { button: 'left', clickCount: 1 });
    await ui.mouse('mouseReleased', rowA.x, rowA.y, { button: 'left', clickCount: 1 });
    await ui.sleep(3000);
  }

  // 7. Many tabs in a narrow pane: names give way to icons, long names end in "…", nothing is cut under the buttons
  await docsList();
  const more = await ui.eval(`[...document.querySelectorAll('.dispatch-docs-row')].map(r => ({ p: r.dataset.docPath, t: r.querySelector('.t').textContent })).filter(r => !${JSON.stringify(opened)}.includes(r.t)).slice(0, 3)`);
  for (const d of more) {
    await ui.openTab('Docs');
    await openRow(d.p);
    await ui.sleep(300);
  }
  for (const w of [720, 480, 360]) {
    const got = await paneWidth(ui, w);
    await ui.sleep(800);
    const s = await record(`narrow-${w}`, { pane: got });
    check(`${w} px: the strip fits or scrolls, no tab name cut mid-glyph`, s.strip.tabs.every(t => !t.nameShown || !t.cut || t.doc), { fit: s.strip.fit, scroll: s.strip.scroll });
    await ui.screenshot(`11-narrow-${w}`);
  }
  await paneWidth(ui, 720);

  note();
  if (qa.failed.length) throw new Error(`failed: ${qa.failed.join('; ')}`);
}
