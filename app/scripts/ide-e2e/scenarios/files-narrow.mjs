// The Files tab in a narrow side pane (user 2026-10-10: at ~400 px the tab was a 100 px strip of "Select a file from
// the Files view" cut to "elect a file fro" beside the file tree, with a divider running past the pane's bottom).
// At 360, 480 and 720 px: Files with no file open is the file list over the whole pane; a file opened from the list
// takes a narrow pane on its own (the list folds away; Toggle File List brings it back over the whole pane) and sits
// beside the list in a wide one; closing the file gives the whole list back. Nothing clips its text.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const meta = {
  title: '窄右栏的 Files 页',
  description: '360 / 480 / 720 px 下 Files：没开文件时文件树占满；开文件后窄时只显示文件、宽时并排；关掉回到整棵树；没有被截断的文字，分隔线不越出面板。',
  needs: ['opencode'],
  timeout: 900,
};

const LAYOUT = `(() => {
  const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const editor = document.getElementById('workbench.parts.editor');
  const aux = document.getElementById('workbench.parts.auxiliarybar');
  const auxShown = !!aux && getComputedStyle(aux).display !== 'none' && aux.getBoundingClientRect().width > 0;
  const content = [...editor.querySelectorAll('.editor-group-container > .editor-container')].find(e => e.getBoundingClientRect().height > 0);
  const empty = [...editor.querySelectorAll('.empty-file-editor')].find(e => e.getBoundingClientRect().width > 0);
  const seen = e => { const r = e.getBoundingClientRect(); if (!r.width || !r.height) return false; const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && (hit === e || e.contains(hit)); };
  // text that does not fit its box and is not meant to end in "…"
  const clipped = [...editor.querySelectorAll('*')].filter(e => {
    if (e.children.length || !(e.textContent || '').trim() || e.getBoundingClientRect().width === 0 || !seen(e)) return false;
    const cs = getComputedStyle(e);
    return e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0 && cs.textOverflow !== 'ellipsis' && cs.overflow !== 'visible';
  }).map(e => ({ t: e.textContent.trim().slice(0, 40), cls: String(e.className).slice(0, 60), sw: e.scrollWidth, cw: e.clientWidth }));
  // a word per line: an element with text narrower than 160 px whose text wraps
  // (only what is on screen: something under the file list is not seen)
  const squeezed = [...editor.querySelectorAll('.sessions-empty-state-description, .sessions-empty-state-title, .empty-file-editor-actions')].filter(e => seen(e) && e.getBoundingClientRect().width < 160).map(e => ({ t: e.textContent.trim().slice(0, 40), w: Math.round(e.getBoundingClientRect().width) }));
  const pane = box(editor);
  const lines = [...editor.querySelectorAll('.monaco-sash.vertical:not(.disabled)')].map(box).filter(b => b.h > 0);
  const tab = document.querySelector('.part.editor .tabs-container .tab.active');
  return {
    pane, aux: auxShown ? box(aux) : null, content: box(content), emptyShown: !!empty, active: tab && tab.getAttribute('aria-label'),
    clipped, squeezed, lines, linesPastPane: lines.filter(l => l.bottom > pane.bottom + 1 || l.y < pane.y - 1).length,
    page: [document.scrollingElement.scrollWidth, document.scrollingElement.clientWidth],
  };
})()`;

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
  return ui.eval(`Math.round(document.getElementById('workbench.parts.editor').getBoundingClientRect().width)`);
}

export default async function (ui) {
  const qa = { checks: [], failed: [], steps: [] };
  const note = () => fs.writeFileSync(path.join(ui.out, 'qa.json'), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
    console.error(`${ok ? 'ok' : 'FAILED'}: ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
    note();
  };
  const read = async (step) => {
    const s = { step, ...(await ui.eval(LAYOUT)) };
    qa.steps.push(s);
    note();
    return s;
  };
  const clean = (s, at) => {
    check(`${at}: no text cut off or squeezed to a word a line`, !s.clipped.length && !s.squeezed.length, { clipped: s.clipped, squeezed: s.squeezed });
    check(`${at}: no divider past the pane`, s.linesPastPane === 0, s.lines);
  };

  await ui.openAgents(ui.demoFolder);
  if (await ui.exists({ text: "Don't Show Again", exact: true })) await ui.click({ text: "Don't Show Again", exact: true });
  // an existing session (the case the person saw): one short reply from OpenCode on the cheap test model
  await ui.newSession();
  await ui.pickEngine('OpenCode', 240000);
  await ui.pickCheapModel();
  await ui.click({ css: '.sessions-chat-editor' });
  await ui.type('Reply exactly FILES. Do not use any tools.');
  await ui.press('Enter', { send: true });
  await ui.waitFor({ text: 'FILES', within: '.interactive-response' }, { timeoutMs: 360000 });
  await ui.sleep(3000);
  // a plain text file: it opens in the text editor, which keeps the file list beside it (a Markdown file opens as a page, which has none)
  fs.writeFileSync(path.join(ui.demoFolder, 'hello.txt'), 'Hello from the Files tab.\n'.repeat(40));
  spawnSync('git', ['-C', ui.demoFolder, 'add', 'hello.txt'], { timeout: 20000 });
  spawnSync('git', ['-C', ui.demoFolder, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-qm', 'hello.txt'], { timeout: 20000 });
  const fileRow = { css: '.part.auxiliarybar .monaco-list-row[aria-label^="hello.txt"]' };

  const toggle = { css: '.part.editor .action-label[aria-label^="Toggle Details"], .part.editor .action-label[aria-label^="Show or Hide File List"]' };
  const closeActive = { css: '.part.editor .tabs-container .tab.active .tab-actions .action-label' };
  // a narrow strip scrolls: the tab in front is brought into view before its close button is clicked
  const closeFile = async () => {
    await ui.eval(`document.querySelector('.part.editor .tabs-container .tab.active')?.scrollIntoView({ inline: 'nearest' })`);
    await ui.sleep(300);
    // the close button shows under the pointer
    const tabBox = await ui.eval(`(() => { const r = document.querySelector('.part.editor .tabs-container .tab.active').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await ui.mouse('mouseMoved', tabBox.x, tabBox.y);
    await ui.sleep(300);
    const before = await ui.eval(`document.querySelector('.part.editor .tabs-container .tab.active')?.getAttribute('aria-label')`);
    const where = await ui.eval(`(() => { const b = document.querySelector('.part.editor .tabs-container .tab.active .tab-actions .action-label'); if (!b) return null; const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, hit: hit === b || b.contains(hit) ? 'button' : (hit ? hit.className : null) }; })()`);
    qa.steps.push({ step: 'close', tab: before, button: where });
    note();
    if (!where || !where.w || where.hit !== 'button') throw new Error(`the close button of the tab in front (${before}) cannot be clicked: ${JSON.stringify(where)}`);
    await ui.mouse('mouseMoved', where.x, where.y);
    await ui.mouse('mousePressed', where.x, where.y, { button: 'left', clickCount: 1 });
    await ui.mouse('mouseReleased', where.x, where.y, { button: 'left', clickCount: 1 });
    await ui.sleep(800);
  };
  for (const w of [360, 480, 720]) {
    await ui.openTab('Files');
    const got = await paneWidth(ui, w);
    await ui.sleep(800);
    // 1. Files, no file open: the list is the whole pane
    const list = await read(`${w}-files`);
    check(`${w} px (pane ${got}): Files with no file open is the file list over the whole pane`, !!list.aux && Math.abs(list.aux.w - list.pane.w) <= 2 && !list.emptyShown, { aux: list.aux, pane: list.pane, emptyShown: list.emptyShown });
    clean(list, `${w} px Files`);
    await ui.screenshot(`files-${w}-1-list`);

    // 2. A file from the list (opening a file gives the side pane back the width it had with a file in it)
    await ui.click(fileRow);
    await ui.sleep(1200);
    const open = await read(`${w}-file-open`);
    if (open.pane.w < 520) {
      check(`${w} px: the opened file has the pane to itself`, !open.aux && open.content && open.content.w >= open.pane.w - 4, { aux: open.aux, content: open.content, pane: open.pane });
    } else {
      check(`${w} px: the opened file sits beside the list (pane ${open.pane.w})`, !!open.aux && open.aux.w < open.pane.w && open.pane.w - open.aux.w >= 280, { aux: open.aux, pane: open.pane, active: open.active });
    }
    clean(open, `${w} px file open`);
    await ui.screenshot(`files-${w}-2-file`);

    // 3. Dragged to this width with the file open
    if (Math.abs(open.pane.w - w) > 6) {
      await paneWidth(ui, w);
      await ui.sleep(1000);
    }
    const dragged = await read(`${w}-file-dragged`);
    if (w < 520) {
      check(`${w} px: a file in a pane this narrow is shown alone (the list folds away)`, !dragged.aux && dragged.content && dragged.content.w >= dragged.pane.w - 4, { aux: dragged.aux, content: dragged.content, pane: dragged.pane });
      clean(dragged, `${w} px file alone`);
      await ui.screenshot(`files-${w}-3-file-alone`);
      // the list's toggle (⌥⌘L): the list over the whole pane; a file from it: the file again
      await ui.click(toggle);
      await ui.sleep(800);
      const toggled = await read(`${w}-list-toggled`);
      check(`${w} px: the toggle brings the list back over the whole pane`, !!toggled.aux && Math.abs(toggled.aux.w - toggled.pane.w) <= 2, { aux: toggled.aux, pane: toggled.pane });
      clean(toggled, `${w} px list toggled`);
      await ui.screenshot(`files-${w}-4-list-toggled`);
      await ui.click(fileRow);
      await ui.sleep(1000);
      const again = await read(`${w}-file-again`);
      check(`${w} px: opening the file from the list shows the file alone again`, !again.aux && again.content && again.content.w >= again.pane.w - 4, { aux: again.aux, pane: again.pane });
    } else {
      check(`${w} px: the file and the list side by side`, !!dragged.aux && dragged.pane.w - dragged.aux.w >= 280, { aux: dragged.aux, pane: dragged.pane });
      clean(dragged, `${w} px side by side`);
      await ui.screenshot(`files-${w}-3-side-by-side`);
    }

    // 4. Close the file: Files, the whole list again
    await closeFile();
    await ui.openTab('Files');
    await paneWidth(ui, w);
    await ui.sleep(800);
    const closed = await read(`${w}-closed`);
    check(`${w} px: after closing the file, Files is the whole list again`, !!closed.aux && Math.abs(closed.aux.w - closed.pane.w) <= 2, { aux: closed.aux, pane: closed.pane, active: closed.active });
    clean(closed, `${w} px after close`);
  }

  // 5. Dragged from narrow to wide with a file open: the list folded for room comes back beside it
  await ui.click(fileRow);
  await ui.sleep(1000);
  await paneWidth(ui, 400);
  await ui.sleep(800);
  const narrowFile = await read('drag-narrow');
  await paneWidth(ui, 760);
  await ui.sleep(1000);
  const wideFile = await read('drag-wide');
  check('dragged wide again, the list folded for room comes back beside the file', !narrowFile.aux && !!wideFile.aux && wideFile.aux.w < wideFile.pane.w, { narrow: narrowFile.aux, wide: wideFile.aux });
  await ui.screenshot('files-760-dragged-wide');
  await closeFile();

  note();
  if (qa.failed.length) throw new Error(`failed: ${qa.failed.join('; ')}`);
}
