// What Orca's terminal does that Dispatch's terminal now does too (kanban design/terminal/orca-compare): panes in one
// terminal session (⌘D right, ⌘⇧D down, ⌘] next, ⌘⇧Enter one pane big and back, ⌘W closes a pane, the panes come back
// after the window reloads), a copy without the margin an agent draws its reply behind, a program's OSC 52 copy
// reaching the Mac's clipboard, links a program marks itself (OSC 8) opening the same small menu as a plain link, an
// agent's own end-of-turn signal reaching the bell and the session row (its hooks: Dispatch's entry app/cli/hook.py --terminal, run by
// hand here as the agent would), and a flood of output (1.5 million lines) the window keeps up with.
// Runs in a plain seeded instance; it uses this Mac's clipboard (run it on the mini), and stops the instance's
// terminal daemon at the end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const meta = { exclusive: true, title: '终端和 Orca 对齐', description: '同一个终端会话里分格（⌘D、⌘⇧D、⌘]、⌘⇧Enter、⌘W，重载后还在）；复制去掉 Agent 的左边距；OSC 52 复制到剪贴板；OSC 8 链接弹菜单；Agent 自己说做完了，铃铛和会话行跟着变；一百五十万行输出窗口跟得上。', timeout: 900 };

const META = 4;
const SHIFT = 8;

async function key(ui, k, code, vk, modifiers) {
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await ui.sleep(500);
}

async function closeTips(ui) {
  for (let i = 0; i < 4 && await ui.exists({ css: '.dispatch-tour-close' }); i++) {
    await ui.click({ css: '.dispatch-tour-close' });
    await ui.sleep(500);
  }
}

// xterm ignores inserted text right after a key it handled itself: a Shift press in between, as a person's next key
async function typeIn(ui, text) {
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: SHIFT });
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
  await ui.type(text);
}

async function shellLine(ui, text) {
  await typeIn(ui, text);
  await ui.press('Enter');
}

/** The panes of the visible terminal session: their id, whether the keyboard is in them, and their text. */
const panes = ui => ui.eval(`(() => {
  const v = [...document.querySelectorAll('.dispatch-terminal-view')].find(e => e.offsetParent);
  if (!v) return [];
  return [...v.querySelectorAll('.dispatch-terminal-pane')].filter(p => p.offsetParent).map(p => {
    const el = p.querySelector('.dispatch-xterm'); const t = el && el.xterm;
    const lines = [];
    if (t) { const b = t.buffer.active; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (!l) continue; if (l.isWrapped && lines.length) lines[lines.length - 1] += l.translateToString(true); else lines.push(l.translateToString(true)); } }
    const r = p.getBoundingClientRect();
    return { id: p.dataset.pane, focused: p.classList.contains('focused'), active: p.contains(document.activeElement), text: lines.join('\\n'), box: { x: r.x, y: r.y, w: r.width, h: r.height } };
  });
})()`);

async function waitPanes(ui, test, what, ms = 20000) {
  let ps;
  for (const until = Date.now() + ms; Date.now() < until; await ui.sleep(300)) {
    ps = await panes(ui);
    if (test(ps)) return ps;
  }
  fs.writeFileSync(path.join(ui.out, 'panes-at-failure.json'), JSON.stringify(ps || [], null, 1));
  throw new Error(`${what}: ${JSON.stringify((ps || []).map(p => ({ id: p.id, focused: p.focused, active: p.active, tail: p.text.trimEnd().slice(-200) })))}`);
}

const activePane = ps => ps.find(p => p.active);
const menuItems = ui => ui.eval(`[...document.querySelectorAll('.monaco-menu-container .action-label')].filter(e => e.offsetParent).map(e => e.textContent.trim()).filter(Boolean)`);

export default async function (ui) {
  const rec = ui.rec;
  const env = { ...process.env, BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home };
  const cli = (...args) => execFileSync('python3', [rec.cli, ...args], { env, encoding: 'utf8', timeout: 60000 });
  const hook = path.join(path.dirname(rec.cli), 'hook.py');
  const folder = ui.demoFolder;
  const facts = {};
  const save = () => fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 1));
  try {
    await ui.attach('agents', 90000);
    await ui.sleep(4000);
    await closeTips(ui);
    await ui.openAgents(folder);
    await ui.newSession();
    await closeTips(ui);
    await ui.sleep(2000);

    // 0 a blank terminal from the new-session panel (⌘T)
    await key(ui, 't', 'KeyT', 84, META);
    await ui.waitFor({ text: 'Blank terminal', within: '.dispatch-new-picker' }, { timeoutMs: 60000 });
    await ui.click({ text: 'Blank terminal', within: '.dispatch-new-picker' });
    for (const until = Date.now() + 40000; Date.now() < until; await ui.sleep(500)) {
      if (await ui.exists("Use your Ghostty look in Dispatch's terminal?")) await ui.click({ text: 'Not now', exact: true });
      if (await ui.exists({ css: '.dispatch-terminal-view .dispatch-terminal-pane .xterm-screen' })) break;
    }
    let ps = await waitPanes(ui, p => p.length === 1, 'one pane to start with');
    const main = ps[0].id;
    await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' });
    await shellLine(ui, 'echo MAIN-PANE-OK');
    await waitPanes(ui, p => /^MAIN-PANE-OK$/m.test(p[0].text), 'the shell answers');

    // 1 panes: ⌘D to the right, ⌘⇧D below, ⌘] to the next, ⌘⇧Enter one big and back, ⌘W closes one
    await key(ui, 'd', 'KeyD', 68, META);
    ps = await waitPanes(ui, p => p.length === 2 && p[1].active, '⌘D opens a pane to the right and the keyboard goes there');
    facts.afterSplitRight = ps.map(p => ({ id: p.id, box: p.box, focused: p.focused }));
    assert.ok(ps[1].box.x > ps[0].box.x + 50 && Math.abs(ps[1].box.y - ps[0].box.y) < 4, 'side by side: ' + JSON.stringify(facts.afterSplitRight));
    const right = ps[1].id;
    await shellLine(ui, 'echo RIGHT-PANE-OK; pwd');
    ps = await waitPanes(ui, p => /^RIGHT-PANE-OK$/m.test(p[1]?.text || ''), 'the new pane is a shell of its own');
    assert.ok(ps[1].text.includes(fs.realpathSync(folder)) || ps[1].text.includes(folder), 'in the same folder');
    assert.ok(!/RIGHT-PANE-OK/.test(ps[0].text), 'typing went to the new pane only');
    await key(ui, 'D', 'KeyD', 68, META | SHIFT);
    ps = await waitPanes(ui, p => p.length === 3 && p.find(x => x.active)?.id !== right && p.find(x => x.active)?.id !== main, '⌘⇧D opens a pane below');
    const below = activePane(ps).id;
    const rightBox = ps.find(p => p.id === right).box;
    const belowBox = ps.find(p => p.id === below).box;
    assert.ok(belowBox.y > rightBox.y + 30 && Math.abs(belowBox.x - rightBox.x) < 4, 'below the right pane: ' + JSON.stringify({ rightBox, belowBox }));
    await ui.screenshot('01-three-panes');
    await ui.mark({ css: '.dispatch-terminal-view' }, { what: '分格', where: '终端里 ⌘D（右边）、⌘⇧D（下面），或右键 Split Right / Split Down', how: '每一格是自己的 shell，在同一个文件夹；没在用的格子稍暗' });
    facts.focusedClass = ps.filter(p => p.focused).map(p => p.id);
    assert.deepEqual(facts.focusedClass, [below], 'the pane the keyboard is in is the bright one');
    await key(ui, ']', 'BracketRight', 221, META);
    ps = await waitPanes(ui, p => activePane(p)?.id === main, '⌘] goes round to the first pane');
    await key(ui, 'Enter', 'Enter', 13, META | SHIFT);
    ps = await waitPanes(ui, p => p.length === 1 && p[0].id === main, '⌘⇧Enter gives the pane the whole space');
    await ui.screenshot('02-expanded');
    await key(ui, 'Enter', 'Enter', 13, META | SHIFT);
    ps = await waitPanes(ui, p => p.length === 3, '⌘⇧Enter again brings the others back');
    // the right-click menu has the pane commands; Close Pane only on a pane that is not the session's own
    const at = ps.find(p => p.id === below).box;
    await ui.mouse('mouseMoved', at.x + 40, at.y + 20);
    await ui.mouse('mousePressed', at.x + 40, at.y + 20, { button: 'right', clickCount: 1 });
    await ui.mouse('mouseReleased', at.x + 40, at.y + 20, { button: 'right', clickCount: 1 });
    for (let i = 0; i < 15 && !(await ui.exists({ css: '.monaco-menu-container' })); i++) await ui.sleep(200);
    facts.paneMenu = await menuItems(ui);
    for (const want of ['Split Right', 'Split Down', 'Close Pane']) assert.ok(facts.paneMenu.includes(want), `${want} in ${JSON.stringify(facts.paneMenu)}`);
    await ui.screenshot('03-pane-menu');
    await ui.mark({ css: '.monaco-menu-container' }, { what: '格子的右键菜单', where: '在某一格里右键', how: 'Split Right / Split Down / Close Pane；Close Terminal 关掉整个会话' });
    await ui.click({ text: 'Close Pane', exact: true, within: '.monaco-menu-container' });
    ps = await waitPanes(ui, p => p.length === 2 && !p.some(x => x.id === below), 'Close Pane closes that pane');
    // ⌘W in a pane that is not the session's own closes it too
    await ui.click({ css: `.dispatch-terminal-pane[data-pane="${right}"] .dispatch-xterm` });
    await key(ui, 'D', 'KeyD', 68, META | SHIFT);
    ps = await waitPanes(ui, p => p.length === 3, 'another pane below the right one');
    await key(ui, 'w', 'KeyW', 87, META);
    ps = await waitPanes(ui, p => p.length === 2, '⌘W closes the pane the keyboard is in');
    // a pane moves by its grip: dragged onto the first pane's top edge it goes above it (Orca drops a tab on a
    // pane's edge); a real mouse drag, the browser's drag handed to the page as the window would
    ps = await panes(ui);
    const gripOf = id => ui.eval(`(() => { const g = document.querySelector('.dispatch-terminal-view .dispatch-terminal-pane[data-pane="${id}"] .dispatch-terminal-pane-grip'); if (!g) return null; const r = g.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, shown: getComputedStyle(g).display !== 'none' }; })()`);
    const mainBox = ps.find(p => p.id === main).box;
    await ui.mouse('mouseMoved', ps.find(p => p.id === right).box.x + 60, ps.find(p => p.id === right).box.y + 40);
    await ui.sleep(400);
    const grip = await gripOf(right);
    facts.grip = grip;
    assert.ok(grip && grip.shown, 'a split pane has a grip: ' + JSON.stringify(grip));
    const dropAt = { x: mainBox.x + mainBox.w / 2, y: mainBox.y + 12 };
    let dragged = null;
    ui.cdp.on('Input.dragIntercepted', e => { dragged = e.data; });
    await ui.cdp.send('Input.setInterceptDrags', { enabled: true });
    // what is under the pointer at the grip (a tip or toast left by an earlier scenario would take the press)
    facts.atGrip = [];
    for (let attempt = 0; attempt < 3 && !dragged; attempt++) {
      await closeTips(ui);
      await ui.mouse('mouseMoved', grip.x, grip.y - 30);
      await ui.sleep(300);
      await ui.mouse('mouseMoved', grip.x, grip.y);
      await ui.sleep(400);
      facts.atGrip.push(await ui.eval(`(() => { const e = document.elementFromPoint(${grip.x}, ${grip.y}); return e ? (e.className || e.tagName) + '' : null; })()`));
      await ui.mouse('mousePressed', grip.x, grip.y, { clickCount: 1, buttons: 1 });
      for (let i = 1; i <= 8; i++) await ui.mouse('mouseMoved', grip.x + (dropAt.x - grip.x) * i / 8, grip.y + (dropAt.y - grip.y) * i / 8, { buttons: 1 });
      for (let i = 0; i < 20 && !dragged; i++) await ui.sleep(100);
      if (!dragged) await ui.mouse('mouseReleased', dropAt.x, dropAt.y, { clickCount: 1 });
    }
    save();
    assert.ok(dragged, 'the grip starts a drag: ' + JSON.stringify(facts.atGrip));
    await ui.cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: dropAt.x, y: dropAt.y, data: dragged });
    await ui.cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: dropAt.x, y: dropAt.y, data: dragged });
    await ui.sleep(300);
    facts.dropHint = await ui.eval(`document.querySelector('.dispatch-terminal-pane-drop')?.className || ''`);
    await ui.screenshot('03b-pane-drag');
    await ui.mark({ css: '.dispatch-terminal-pane-drop' }, { what: '拖动一格', where: '分格后每格顶上的小把手', how: '拖到另一格的边上，那半边变色，松手就移过去' });
    await ui.cdp.send('Input.dispatchDragEvent', { type: 'drop', x: dropAt.x, y: dropAt.y, data: dragged });
    await ui.mouse('mouseReleased', dropAt.x, dropAt.y, { clickCount: 1 });
    await ui.cdp.send('Input.setInterceptDrags', { enabled: false });
    assert.ok(/\btop\b/.test(facts.dropHint), 'the top half of the first pane is tinted: ' + facts.dropHint);
    ps = await waitPanes(ui, p => {
      const r = p.find(x => x.id === right), m = p.find(x => x.id === main);
      return r && m && r.box.y + 30 < m.box.y && Math.abs(r.box.x - m.box.x) < 4;
    }, 'the dragged pane is above the first one now');
    facts.afterMove = ps.map(p => ({ id: p.id, box: p.box }));
    await ui.screenshot('03c-pane-moved');
    // this session's terminals (an earlier scenario's may be kept in the same instance)
    facts.daemonAfterPanes = JSON.parse(cli('terminal', 'daemon', 'status', '--json')).sessions.filter(s => s.id === main || s.parent === main).map(s => ({ id: s.id, parent: s.parent, layout: s.layout }));
    assert.equal(facts.daemonAfterPanes.length, 2, 'the closed panes ended in the daemon: ' + JSON.stringify(facts.daemonAfterPanes));
    save();

    // 2 the panes come back after the window reloads (as when Dispatch quits and opens again); ⇧⌘P, not F1: a
    //    terminal with the keyboard takes F1 for its program
    facts.beforeReload = (await panes(ui)).map(p => ({ id: p.id, text: p.text.trimEnd().slice(-400) }));
    await key(ui, 'p', 'KeyP', 80, META | SHIFT);
    await ui.type('Reload Window');
    await ui.sleep(800);
    await ui.press('Enter');
    await ui.sleep(4000);
    await ui.attach('agents', 90000);
    await ui.waitFor({ text: 'Terminal', exact: true, within: '.session-item' }, { timeoutMs: 60000 });
    await ui.click({ text: 'Terminal', exact: true, within: '.session-item' });
    ps = await waitPanes(ui, p => p.length === 2 && /RIGHT-PANE-OK/.test(p.find(x => x.id === right)?.text || '') && /MAIN-PANE-OK/.test(p.find(x => x.id === main)?.text || ''), 'both panes and what they showed are back', 40000);
    assert.ok(ps.find(x => x.id === right).box.y + 30 < ps.find(x => x.id === main).box.y, 'the moved pane is still above: ' + JSON.stringify(ps.map(p => ({ id: p.id, box: p.box }))));
    facts.sessionsAfterReload = await ui.eval(`[...document.querySelectorAll('.session-item')].map(e => e.innerText.split('\\n')[0])`);
    assert.equal(facts.sessionsAfterReload.filter(t => t === 'Terminal').length, 1, 'a pane is not a session of its own in the list: ' + JSON.stringify(facts.sessionsAfterReload));
    await ui.screenshot('04-panes-after-reload');
    await ui.mark({ css: '.dispatch-terminal-view' }, { what: '重开后格子还在', where: '重载窗口后点回这个终端', how: '两格和各自的内容都回来，列表里还是一个会话' });
    save();

    // 3 copying leaves out an agent's left margin; a program's OSC 52 copy reaches the clipboard
    // (E2E_NO_CLIPBOARD=1 leaves this Mac's clipboard alone: steps 3 and 4 are skipped, for a quick run on a Mac in use)
    const clipboard = process.env.E2E_NO_CLIPBOARD !== '1';
    if (clipboard) {
      await ui.click({ css: `.dispatch-terminal-pane[data-pane="${main}"] .dispatch-xterm` });
      await shellLine(ui, "clear; printf '  Done, the tests pass.\\n    - one fix\\n  Next step\\n'");
      await waitPanes(ui, p => /Next step/.test(p.find(x => x.id === main)?.text || ''), 'the indented reply is on screen');
      await ui.eval(`(() => { const t = document.querySelector('.dispatch-terminal-pane[data-pane="${main}"] .dispatch-xterm').xterm; const b = t.buffer.active;
        let first = -1; for (let i = 0; i < b.length; i++) { const s = b.getLine(i).translateToString(true); if (s.startsWith('  Done, the tests pass.')) first = i; }
        t.selectLines(first, first + 2); return first; })()`);
      execFileSync('bash', ['-c', 'printf "before" | pbcopy']);
      await key(ui, 'c', 'KeyC', 67, META);
      facts.copied = execFileSync('pbpaste', { encoding: 'utf8' });
      assert.equal(facts.copied.replace(/\s+$/, ''), 'Done, the tests pass.\n  - one fix\nNext step', 'copied without the shared margin');
      await shellLine(ui, "printf '\\033]52;c;%s\\a' \"$(printf osc52-copy-ok | base64)\"; echo sent");
      let clip = '';
      for (let i = 0; i < 20 && clip !== 'osc52-copy-ok'; i++) { await ui.sleep(300); clip = execFileSync('pbpaste', { encoding: 'utf8' }); }
      facts.osc52 = clip;
      assert.equal(clip, 'osc52-copy-ok', 'a program copied through OSC 52');
      save();

      // 4 a link the program marked itself (OSC 8): the same small menu as a plain link (the selection made for the copy
      //   above is let go first, as a person's next click would)
      await ui.eval(`document.querySelector('.dispatch-terminal-pane[data-pane="${main}"] .dispatch-xterm').xterm.clearSelection()`);
      await shellLine(ui, "clear; printf '\\033]8;;https://example.com/osc8\\033\\\\Marked link\\033]8;;\\033\\\\\\n'");
      await waitPanes(ui, p => /^Marked link$/m.test(p.find(x => x.id === main)?.text || ''), 'the marked link is on screen');
      const link = await ui.eval(`(() => { const el = document.querySelector('.dispatch-terminal-pane[data-pane="${main}"] .dispatch-xterm'); const t = el.xterm, b = t.buffer.active;
        const box = el.querySelector('.xterm-screen').getBoundingClientRect(); const cell = t._core._renderService.dimensions.css.cell;
        for (let r = t.rows - 1; r >= 0; r--) { const s = b.getLine(b.viewportY + r)?.translateToString(true) || ''; if (s === 'Marked link') return { x: box.left + 3.5 * cell.width, y: box.top + (r + 0.5) * cell.height }; }
        return null; })()`);
      assert.ok(link, 'found the link on screen');
      let items = [];
      for (let i = 0; i < 4 && !items.length; i++) {
        await ui.mouse('mouseMoved', link.x, link.y);
        await ui.sleep(700);
        await ui.mouse('mousePressed', link.x, link.y, { clickCount: 1, buttons: 1 });
        await ui.mouse('mouseReleased', link.x, link.y, { clickCount: 1 });
        await ui.sleep(700);
        items = await menuItems(ui);
    }
    facts.osc8Menu = items;
    assert.deepEqual(items.slice(0, 2), ['Open Link', 'Copy Link'], JSON.stringify(items));
    await ui.screenshot('05-osc8-menu');
    await ui.click({ text: 'Copy Link', exact: true, within: '.monaco-menu-container' });
    await ui.sleep(400);
    assert.equal(execFileSync('pbpaste', { encoding: 'utf8' }), 'https://example.com/osc8', 'the hidden address, not the words shown');
    save();
    }

    // 5 an agent says its turn ended (Claude Code's Stop hook, run here as Claude Code runs it): the bell hears it,
    //    and the row says there is something new while the person looks elsewhere
    const daemon = JSON.parse(cli('terminal', 'daemon', 'status', '--json'));
    const sid = daemon.sessions.find(s => !s.parent).id;
    // look elsewhere first: a new chat session page
    await ui.newSession();
    await ui.sleep(1500);
    const ran = execFileSync('python3', [hook, 'claude-code', '--terminal'], { env: { ...env, DISPATCH_TERMINAL_SESSION: sid }, input: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'Done. The tests pass.' }), encoding: 'utf8' });
    facts.hookOutput = ran;
    const inbox = JSON.parse(cli('inbox', 'list', '--json'));
    const ev = inbox.events.find(e => e.session === `dispatch-terminal:/${sid}`);
    facts.inboxEvent = ev;
    assert.ok(ev && ev.kind === 'finished' && ev.source === 'terminal' && ev.text === 'Done. The tests pass.' && !ev.read, 'filed in the inbox: ' + JSON.stringify(inbox.events.slice(0, 3)));
    let row;
    for (let i = 0; i < 30; i++) {
      await ui.sleep(500);
      row = await ui.eval(`(() => { const r = [...document.querySelectorAll('.session-item')].find(e => e.innerText.split('\\n')[0] === 'Terminal'); return r ? { cls: r.className, html: r.closest('.monaco-list-row')?.className || '', text: r.innerText } : null; })()`);
      if (row && /unread/.test(row.cls + ' ' + row.html)) break;
    }
    facts.rowAfterTurn = row;
    assert.match(row?.cls || '', /\bunread\b/, 'the row says there is something new: ' + JSON.stringify(row));
    let bell = '';
    for (let i = 0; i < 20 && !/\d/.test(bell); i++) { await ui.sleep(500); bell = await ui.eval(`(document.querySelector('.dispatch-inbox-button-label') || {}).textContent || ''`); }
    facts.bell = bell;
    assert.match(bell, /1/, 'the bell counts it');
    await ui.screenshot('06-bell');
    await ui.mark({ css: '.dispatch-inbox-button-label' }, { what: '铃铛', where: '标题栏', how: '终端里的 Agent 自己说做完了（它的 hook），铃铛记一条，Dock 也有数字' });
    // opening it from the bell goes to the terminal and marks it read
    await ui.click({ css: '.dispatch-inbox-button-label' });
    await ui.waitFor('Done. The tests pass.', { timeoutMs: 10000 });
    await ui.screenshot('07-bell-panel');
    await ui.click({ text: 'Done. The tests pass.' });
    await waitPanes(ui, p => p.length === 2, 'the bell row opens the terminal session', 15000);
    let read = false;
    for (let i = 0; i < 20 && !read; i++) { await ui.sleep(500); read = JSON.parse(cli('inbox', 'list', '--json')).events.find(e => e.id === ev.id)?.read; }
    assert.ok(read, 'opened, so read');
    save();

    // 6 a flood of output: 1.5 million lines; the window keeps drawing and every line reaches it in order
    await ui.click({ css: `.dispatch-terminal-pane[data-pane="${right}"] .dispatch-xterm` });
    await ui.eval(`(() => { window.__gaps = { max: 0, last: performance.now(), n: 0 }; const tick = now => { const g = window.__gaps; g.max = Math.max(g.max, now - g.last); g.last = now; g.n++; if (!g.stop) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`);
    const t0 = Date.now();
    await shellLine(ui, 'clear; seq -f %.0f 1 1500000; echo FLOOD-DONE');
    await waitPanes(ui, p => /^FLOOD-DONE$/m.test(p.find(x => x.id === right)?.text || ''), 'the end of the flood reached the screen', 180000);
    facts.floodSeconds = (Date.now() - t0) / 1000;
    facts.frames = await ui.eval(`(() => { const g = window.__gaps; g.stop = true; return { maxGapMs: Math.round(g.max), frames: g.n }; })()`);
    const tail = (await panes(ui)).find(p => p.id === right).text.split('\n').filter(l => /^\d+$/.test(l)).map(Number);
    facts.tailCount = tail.length;
    facts.tailContiguous = tail.every((n, i) => i === 0 || n === tail[i - 1] + 1);
    assert.equal(tail[tail.length - 1], 1500000, 'the last line is there');
    assert.ok(tail.length > 5000 && facts.tailContiguous, 'the lines kept are all there, in order (nothing dropped)');
    assert.ok(facts.frames.maxGapMs < 2000, 'the window kept drawing: ' + JSON.stringify(facts.frames));
    await shellLine(ui, 'echo STILL-TYPING-OK');
    await waitPanes(ui, p => /^STILL-TYPING-OK$/m.test(p.find(x => x.id === right)?.text || ''), 'typing works right after');
    await ui.screenshot('08-flood');
    save();

    // 7 the sessions of a folder are its tabs: ⌘⇧[ and ⌘⇧] go to the previous and next one (Orca's tab keys)
    await key(ui, 't', 'KeyT', 84, META);
    await ui.waitFor({ text: 'Blank terminal', within: '.dispatch-new-picker' }, { timeoutMs: 60000 });
    await ui.click({ text: 'Blank terminal', within: '.dispatch-new-picker' });
    await waitPanes(ui, p => p.length === 1, 'a second terminal session', 30000);
    await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' });
    await shellLine(ui, 'echo SECOND-SESSION-OK');
    await waitPanes(ui, p => p.length === 1 && /^SECOND-SESSION-OK$/m.test(p[0].text), 'the second session answers');
    await key(ui, '{', 'BracketLeft', 219, META | SHIFT);
    await waitPanes(ui, p => p.length === 2 && p.some(x => x.id === main), '⌘⇧[ goes to the earlier session with its two panes', 15000);
    await ui.click({ css: `.dispatch-terminal-pane[data-pane="${main}"] .dispatch-xterm` });
    await key(ui, '}', 'BracketRight', 221, META | SHIFT);
    await waitPanes(ui, p => p.length === 1 && /SECOND-SESSION-OK/.test(p[0].text), '⌘⇧] goes back to the second', 15000);
    facts.sessionKeys = 'ok';
    save();

    // 8 the keys are the person's to change (Orca lets every shortcut be changed): Split Terminal Right moved from
    //    ⌘D to ⌘⌥D in their key bindings; ⌘D no longer splits, ⌘⌥D does
    const keyFile = path.join(rec.user_data_dir, 'User', 'keybindings.json');
    const keysBefore = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : null;
    try {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, JSON.stringify([
        { key: 'cmd+alt+d', command: 'dispatch.terminal.splitRight', when: 'dispatchTerminalFocus' },
        { key: 'cmd+d', command: '-dispatch.terminal.splitRight' },
      ], null, 1));
      await ui.sleep(3000);
      await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' });
      const n0 = (await panes(ui)).length;
      await key(ui, 'd', 'KeyD', 68, META);
      await ui.sleep(1500);
      const n1 = (await panes(ui)).length;
      await key(ui, 'd', 'KeyD', 68, META | 1);
      ps = await waitPanes(ui, p => p.length === n0 + 1, '⌘⌥D splits once it is the key for it', 10000);
      facts.rebound = { before: n0, afterCmdD: n1, afterCmdAltD: ps.length };
      assert.equal(n1, n0, '⌘D does nothing once the person took it off');
      await ui.screenshot('09-rebound-key');
    } finally {
      if (keysBefore === null) fs.rmSync(keyFile, { force: true }); else fs.writeFileSync(keyFile, keysBefore);
    }
    save();
  } finally {
    save();
    try { cli('terminal', 'daemon', 'stop', '--json'); } catch { /* already gone */ }
  }
}
