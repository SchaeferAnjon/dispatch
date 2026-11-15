// The file list's toggle (upstream "Toggle Details", ⌥⌘L) stays in one place in the side pane's tab strip (user
// 2026-10-10: "why does this icon come and go? what is the logic?"). Switching Changes, Files, Docs, Tasks, a
// document's tab and a browser page: the button's box does not move. On a tab without a file list it is Show in File
// List (user 2026-10-19: "click it, the file list comes up at the document I am looking at").
import fs from 'node:fs';
import path from 'node:path';

export const meta = {
  title: '文件列表开关位置固定',
  description: 'Changes、Files、Docs、Tasks、文档标签、内置浏览器之间来回切，⌥⌘L 那颗按钮位置不变；没有文件列表的标签上它是 Show in File List，点了打开文件列表。',
  needs: ['opencode'],
  timeout: 900,
};

const BUTTON = `(() => {
  const b = [...document.querySelectorAll('.part.editor .editor-layout-actions .action-label')]
    .find(e => /^(Show or Hide File List|Show in File List)/.test(e.getAttribute('aria-label') || '') && e.getBoundingClientRect().width > 0);
  const tab = document.querySelector('.part.editor .tabs-container .tab.active');
  if (!b) return { tab: tab && tab.getAttribute('aria-label'), button: null };
  const r = b.getBoundingClientRect();
  return {
    tab: tab && tab.getAttribute('aria-label'),
    button: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    aria: b.getAttribute('aria-label'), title: b.getAttribute('title') || b.getAttribute('aria-label'),
    disabled: b.classList.contains('disabled') || b.getAttribute('aria-disabled') === 'true',
    icon: [...b.classList].find(c => c.startsWith('codicon-')) || null,
  };
})()`;

export default async function (ui) {
  const qa = { checks: [], failed: [], steps: [] };
  const note = () => fs.writeFileSync(path.join(ui.out, 'qa.json'), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
    console.error(`${ok ? 'ok' : 'FAILED'}: ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
    note();
  };

  // a page for the integrated browser and a document for Docs
  const page = path.join(ui.demoFolder, 'design', 'toggle-page', 'index.html');
  fs.mkdirSync(path.dirname(page), { recursive: true });
  fs.writeFileSync(page, '<!doctype html><title>Toggle page</title><body><h1>A page</h1></body>\n');

  await ui.openAgents(ui.demoFolder);
  if (await ui.exists({ text: "Don't Show Again", exact: true })) await ui.click({ text: "Don't Show Again", exact: true });
  await ui.newSession();
  await ui.pickEngine('OpenCode', 240000);
  await ui.pickCheapModel();
  await ui.click({ css: '.sessions-chat-editor' });
  await ui.type('Reply exactly TOGGLE. Do not use any tools.');
  await ui.press('Enter', { send: true });
  await ui.waitFor({ text: 'TOGGLE', within: '.interactive-response' }, { timeoutMs: 360000 });
  await ui.sleep(3000);

  // the browser page and the document's tab first, so every tab is in the strip
  await ui.openTab('Docs');
  const scope = { css: '.dispatch-docs-scope .dispatch-docs-pill:nth-child(2)' };
  await ui.waitFor(scope, { timeoutMs: 30000 });
  if (await ui.eval(`document.querySelector('.dispatch-docs-scope .dispatch-docs-pill:nth-child(2)').getAttribute('aria-selected') !== 'true'`)) await ui.click(scope);
  const row = { css: `.dispatch-docs-row[data-doc-path=${JSON.stringify(page)}]` };
  await ui.waitFor(row, { timeoutMs: 60000 });
  await ui.click(row);
  await ui.waitFor({ css: '.dispatch-docs.reading .dispatch-docs-frame' }, { timeoutMs: 15000 });
  await ui.click({ aria: 'More Actions', exact: true, within: '.dispatch-docs-reader-head' });
  await ui.click({ text: 'Open in Integrated Browser', within: '.context-view' });
  await ui.sleep(2500);

  const tabs = await ui.eval(`[...document.querySelectorAll('.part.editor .tabs-container .tab')].map(t => t.getAttribute('aria-label'))`);
  qa.tabs = tabs;
  const order = ['Changes', 'Files', 'Docs', 'Tasks', 'Toggle page', tabs.find(t => /index\.html|Toggle page/.test(t) && t !== 'Toggle page') || tabs[tabs.length - 1], 'Files', 'Changes', 'Docs'];
  let first = null;
  for (const name of order) {
    const sel = { css: `.part.editor .tabs-container .tab[aria-label=${JSON.stringify(name)}]` };
    if (!(await ui.exists(sel))) { check(`tab ${name} is in the strip`, false, tabs); continue; }
    await ui.click(sel);
    // the tab's detail is set up a moment after the tab comes to the front: the state it settles on, and when
    const hasList = name === 'Changes' || name === 'Files';
    const t0 = Date.now();
    let s = await ui.eval(BUTTON);
    while (Date.now() - t0 < 3000 && (!s.button || /Show in File List/.test(s.aria) === hasList)) { await ui.sleep(100); s = await ui.eval(BUTTON); }
    s.settledMs = Date.now() - t0;
    await ui.sleep(300);
    qa.steps.push(s);
    note();
    check(`${name}: the toggle is there`, !!s.button, s);
    if (!s.button) continue;
    first ??= s.button;
    check(`${name}: at the same place (${first.x}, ${first.y})`, s.button.x === first.x && s.button.y === first.y, s.button);
    if (hasList) check(`${name}: enabled, "Show or Hide File List (⌥⌘L)"`, !s.disabled && /Show or Hide File List/.test(s.aria) && /⌥⌘L/.test(s.title + s.aria), s);
    else check(`${name}: enabled, "Show in File List"`, !s.disabled && /Show in File List/.test(s.aria), s);
    await ui.screenshot(`toggle-${qa.steps.length}-${name.replace(/[^a-z]+/gi, '-').slice(0, 20)}`);
  }

  // on a tab without a file list: its hover says what it does, and a click opens the file list
  await ui.click({ css: '.part.editor .tabs-container .tab[aria-label="Docs"]' });
  await ui.sleep(600);
  const b = await ui.eval(BUTTON);
  await ui.mouse('mouseMoved', b.button.x + b.button.w / 2, b.button.y + b.button.h / 2);
  await ui.sleep(1500);
  const hover = await ui.eval(`[...document.querySelectorAll('.monaco-hover, .workbench-hover, .custom-hover, [role="tooltip"]')].map(e => e.innerText).join(' | ') || document.querySelector('.part.editor .action-label[aria-label^="Show in File List"]')?.getAttribute('title') || ''`);
  check('hovering it on Docs says it shows the file list', /file list/i.test(hover), { hover });
  await ui.screenshot('toggle-hover-docs');
  await ui.mouse('mousePressed', b.button.x + b.button.w / 2, b.button.y + b.button.h / 2, { button: 'left', clickCount: 1 });
  await ui.mouse('mouseReleased', b.button.x + b.button.w / 2, b.button.y + b.button.h / 2, { button: 'left', clickCount: 1 });
  let files = false;
  for (const end = Date.now() + 10000; !files && Date.now() < end; await ui.sleep(300)) {
    files = await ui.eval(`(() => { const v = document.querySelector('.explorer-folders-view, .files-empty-view-body'); return !!v && v.getBoundingClientRect().width > 0; })()`);
  }
  check('clicking it on Docs opens the file list', files);
  await ui.screenshot('toggle-click-docs');

  note();
  if (qa.failed.length) throw new Error(`failed: ${qa.failed.join('; ')}`);
}
