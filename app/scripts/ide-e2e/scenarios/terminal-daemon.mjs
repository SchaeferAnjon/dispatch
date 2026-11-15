// The Agents window's terminal on Dispatch's own terminal daemon (app/termd, after Orca's): it keeps running when
// the window goes away and comes back with its screen; ⌘V pastes a screenshot as a file path for the agent; a click
// on a file path opens a small menu; the right-click menu has Snippets, Continue in a New Session, Fork Session and
// Copy Context; Chinese and emoji take the right width. Runs in a plain seeded instance; it puts a picture and some
// text on this Mac's clipboard (run it on the mini), and stops the instance's terminal daemon at the end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const meta = { exclusive: true, title: '终端常驻和顺手', description: '终端由 Dispatch 自己的常驻进程托管：重载窗口、进程重启后终端和内容都在；⌘V 粘图、点路径弹菜单、右键菜单（快捷命令、在新会话中继续、派生、复制上下文）、中文和 emoji 宽度。' };

// a 4×4 red PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fxQ6/AAAAAElFTkSuQmCC';

const screen = ui => ui.eval(`(() => {
  const el = [...document.querySelectorAll('.dispatch-terminal-view .dispatch-xterm')].find(e => e.offsetParent);
  const t = el && el.xterm;
  if (!t) return { text: '', gpu: false };
  const b = t.buffer.active;
  const lines = [];
  for (let i = 0; i < b.length; i++) {
    const l = b.getLine(i);
    if (!l) continue;
    if (l.isWrapped && lines.length) lines[lines.length - 1] += l.translateToString(true); else lines.push(l.translateToString(true));
  }
  return { text: lines.join('\\n'), gpu: !!el.querySelector('.xterm-screen canvas'), cols: t.cols, rows: t.rows, bracketed: t.modes.bracketedPasteMode };
})()`);

// where a piece of visible ASCII text sits on screen (CSS pixels)
const cellOf = (ui, needle, offset = 2) => ui.eval(`(() => {
  const el = [...document.querySelectorAll('.dispatch-terminal-view .dispatch-xterm')].find(e => e.offsetParent);
  const t = el.xterm, b = t.buffer.active;
  const box = el.querySelector('.xterm-screen').getBoundingClientRect();
  const cell = t._core._renderService.dimensions.css.cell;
  for (let r = t.rows - 1; r >= 0; r--) {
    const s = b.getLine(b.viewportY + r)?.translateToString(true) || '';
    const i = s.lastIndexOf(${JSON.stringify(needle)});
    if (i >= 0) return { x: box.left + (i + ${offset} + 0.5) * cell.width, y: box.top + (r + 0.5) * cell.height };
  }
  return null;
})()`);

/** The width xterm gave each character of the first line holding `text`. */
const widths = (ui, text) => ui.eval(`(() => {
  const el = [...document.querySelectorAll('.dispatch-terminal-view .dispatch-xterm')].find(e => e.offsetParent);
  const b = el.xterm.buffer.active;
  for (let y = b.length - 1; y >= 0; y--) {
    const l = b.getLine(y); const s = l.translateToString(true);
    if (s.includes(${JSON.stringify(text)}) && !s.includes('echo')) {
      const out = [];
      for (let x = 0; x < l.length; x++) { const c = l.getCell(x); if (c && c.getWidth() > 0 && c.getChars()) out.push([c.getChars(), c.getWidth()]); }
      return out;
    }
  }
  return null;
})()`);

async function waitScreen(ui, re, ms = 20000) {
  let s;
  for (const until = Date.now() + ms; Date.now() < until; await ui.sleep(300)) {
    s = await screen(ui);
    if (re.test(s.text)) return s;
  }
  fs.writeFileSync(path.join(ui.out, 'screen-at-failure.txt'), (s && s.text) || '');
  const state = await ui.eval(`(() => { const el = [...document.querySelectorAll('.dispatch-terminal-view .dispatch-xterm')].find(e => e.offsetParent); const c = el && el.xterm && el.xterm._core; return { active: document.activeElement && document.activeElement.className, keyPressHandled: c && c._keyPressHandled, keyDownSeen: c && c._keyDownSeen, keyDownHandled: c && c._keyDownHandled }; })()`).catch(() => ({}));
  fs.writeFileSync(path.join(ui.out, 'focus-at-failure.json'), JSON.stringify(state));
  throw new Error(`the terminal never showed ${re}: ${(s && s.text || '').slice(-600)}`);
}

async function key(ui, k, code, vk, modifiers) {
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await ui.sleep(400);
}
const META = 4;

async function rightClick(ui, at) {
  await ui.mouse('mouseMoved', at.x, at.y);
  await ui.mouse('mousePressed', at.x, at.y, { button: 'right', clickCount: 1 });
  await ui.mouse('mouseReleased', at.x, at.y, { button: 'right', clickCount: 1 });
  for (let i = 0; i < 15 && !(await ui.exists({ css: '.monaco-menu-container' })); i++) await ui.sleep(200);
  await ui.sleep(300);
}

async function leftClick(ui, at, modifiers = 0) {
  await ui.mouse('mouseMoved', at.x, at.y, { modifiers });
  await ui.sleep(900); // the link under the mouse is looked up (the file is checked) before it can be clicked
  await ui.mouse('mousePressed', at.x, at.y, { clickCount: 1, modifiers });
  await ui.mouse('mouseReleased', at.x, at.y, { clickCount: 1, modifiers });
  await ui.sleep(800);
}

const menuItems = ui => ui.eval(`[...document.querySelectorAll('.monaco-menu-container .action-label')].filter(e => e.offsetParent).map(e => e.textContent.trim()).filter(Boolean)`);

async function closeTips(ui) {
  for (let i = 0; i < 4 && await ui.exists({ css: '.dispatch-tour-close' }); i++) {
    await ui.click({ css: '.dispatch-tour-close' });
    await ui.sleep(500);
  }
}

// xterm ignores inserted text right after a key it handled itself (it waits for that key's own input): a Shift
// press in between, as a person's next keystroke would be
async function typeIn(ui, text) {
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 });
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
  await ui.type(text);
}

async function shellLine(ui, text) {
  await typeIn(ui, text);
  await ui.press('Enter');
}

export default async function (ui) {
  const rec = ui.rec;
  const env = { ...process.env, BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home };
  const cli = (...args) => execFileSync('python3', [rec.cli, ...args], { env, encoding: 'utf8', timeout: 60000 });
  const folder = ui.demoFolder;
  const name = path.basename(folder);
  const facts = {};
  const save = () => fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 1));
  try {
    // 0 the Agents window on the demo project
    // a plain launch opens only the Agents window: the Editor button brings up the editor window, which can take
    // the Agents window to a folder (as tours-places.mjs does); first-run tips are closed as they come
    await ui.attach('agents', 90000);
    await ui.sleep(6000);
    await closeTips(ui);
    // openAgents brings up the editor window with the title bar's Editor button when there is none, and waits for it
    await ui.openAgents(folder);
    await ui.newSession();
    await closeTips(ui);
    await ui.sleep(2500);

    // 1 a plain terminal for the project
    // "+" asks Chat or Terminal, then the agent (direction A): ⌘T opens it on Terminal
    assert.ok(!(await ui.exists({ aria: 'Open a Terminal' })), 'no separate terminal icon above the sessions list');
    await key(ui, 't', 'KeyT', 84, META);
    await ui.waitFor({ css: '.dispatch-new-picker' }, { timeoutMs: 15000 });
    await ui.waitFor({ text: 'Blank terminal', within: '.dispatch-new-picker' }, { timeoutMs: 60000 });
    for (let i = 0; i < 60 && !(await ui.exists({ css: '.dispatch-new-picker .dnp-list .dnp-row' })); i++) await ui.sleep(500);
    facts.pickerTerminal = await ui.eval(`[...document.querySelectorAll('.dispatch-new-picker .dnp-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
    await ui.screenshot('00-new-terminal');
    await ui.mark({ css: '.dispatch-new-picker' }, { what: '新建', where: '⌘T，或文件夹行「+」的菜单里 New Terminal', how: '先选 Chat 还是 Terminal，再选 Agent；Blank terminal 只开 shell' });
    await ui.click({ text: 'Chat', exact: true, within: '.dispatch-new-picker' });
    await ui.sleep(400);
    facts.pickerChat = await ui.eval(`[...document.querySelectorAll('.dispatch-new-picker .dnp-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
    await ui.screenshot('00-new-chat');
    await ui.click({ text: 'Terminal', exact: true, within: '.dispatch-new-picker' });
    await ui.click({ text: 'Blank terminal', within: '.dispatch-new-picker' });
    // on a Mac with Ghostty settings the first terminal asks once whether to use that look
    for (const until = Date.now() + 40000; Date.now() < until; await ui.sleep(500)) {
      if (await ui.exists("Use your Ghostty look in Dispatch's terminal?")) {
        await ui.click({ text: 'Not now', exact: true });
      }
      if (await ui.exists({ css: '.dispatch-terminal-view .dispatch-xterm .xterm-screen' })) break;
    }
    await ui.waitFor({ css: '.dispatch-terminal-view .dispatch-xterm .xterm-screen' }, { timeoutMs: 20000 });
    const daemon = JSON.parse(cli('terminal', 'daemon', 'status', '--json'));
    // an earlier scenario's terminals may be kept in the same instance: count the ones in this folder
    const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
    const here = daemon.sessions.filter(t => t.cwd && real(t.cwd) === real(folder));
    facts.daemon = { running: daemon.running, pid: daemon.pid, sessions: here.length };
    assert.ok(daemon.running && here.length === 1, 'the terminal lives in the daemon: ' + JSON.stringify(daemon));
    await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' });
    await shellLine(ui, 'echo "PID=$$"; echo "你好🙂 dispatch-ok"');
    let s = await waitScreen(ui, /PID=\d+[\s\S]*你好🙂 dispatch-ok/);
    facts.gpu = s.gpu;
    facts.pid = s.text.match(/PID=(\d+)/)[1];
    const w = await widths(ui, 'dispatch-ok');
    facts.widths = w && w.slice(0, 3);
    assert.deepEqual(w && w.slice(0, 3).map(([, n]) => n), [2, 2, 2], 'Chinese and emoji take two cells each: ' + JSON.stringify(w));
    save();
    facts.rowMark = await ui.eval(`[...document.querySelectorAll('.session-item .dispatch-row-mark:not(.empty)')].map(e => e.textContent + '|' + e.getAttribute('aria-label'))`);
    assert.ok(facts.rowMark.some(t => t.startsWith('>_')), 'the terminal row ends with >_: ' + JSON.stringify(facts.rowMark));
    await ui.screenshot('01-terminal');
    await ui.mark({ css: '.dispatch-terminal-view' }, { what: '终端会话', where: '会话区，左侧列表里的 Terminal', how: '中文和 emoji 宽度正确；关掉窗口它也在跑' });

    // 2 a file path: a click opens a small menu
    await shellLine(ui, 'printf "# hi\\n" > notes-for-link.md; ls notes-for-link.md');
    await waitScreen(ui, /^(?!.*printf).*notes-for-link\.md$/m); // ls may put an icon first (eza, lsd)
    let at = await cellOf(ui, 'notes-for-link.md', 3);
    let items = [];
    // the file is looked up when the mouse comes over it: on a busy Mac that can take a moment
    for (let i = 0; i < 4 && !items.length; i++) {
      await leftClick(ui, at);
      items = await menuItems(ui);
      if (!items.length) await ui.sleep(1500);
    }
    facts.pathMenu = items;
    assert.deepEqual(items.slice(0, 4), ['Open in Dispatch', 'Open with Default App', 'Reveal in Finder', 'Copy Path'], JSON.stringify(items));
    await ui.screenshot('02-path-menu');
    await ui.mark({ css: '.monaco-menu-container' }, { what: '路径菜单', where: '点终端里的文件路径', how: '在 Dispatch 里打开 / 用默认应用打开 / 在访达中显示 / 复制路径；⌘点直接打开，⇧⌘点用默认应用' });
    await ui.click({ text: 'Copy Path', exact: true, within: '.monaco-menu-container' });
    facts.copiedPath = execFileSync('pbpaste', { encoding: 'utf8' });
    assert.equal(fs.realpathSync(facts.copiedPath), fs.realpathSync(path.join(folder, 'notes-for-link.md')));
    save();

    // 3 ⌘V with a picture on the clipboard: the picture becomes a file, its path goes in
    const png = path.join(ui.out, 'clip.png');
    fs.writeFileSync(png, Buffer.from(PNG, 'base64'));
    execFileSync('osascript', ['-e', `set the clipboard to (read (POSIX file "${png}") as «class PNGf»)`]);
    await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' });
    await typeIn(ui, '/bin/ls -l '); // the system ls: a Mac with eza or lsd as ls writes the mode differently
    await key(ui, 'v', 'KeyV', 86, META);
    s = await waitScreen(ui, /dispatch-paste\/paste-\d+-[0-9a-f]+\.png/);
    await ui.press('Enter');
    s = await waitScreen(ui, /-rw-------.*dispatch-paste\/paste-\d+-[0-9a-f]+\.png/);
    facts.imagePaste = s.text.match(/.*dispatch-paste\/paste-\d+-[0-9a-f]+\.png.*/g).slice(-1)[0];
    await ui.screenshot('03-image-paste');
    // text on the clipboard pastes as text
    execFileSync('bash', ['-c', 'printf "echo pasted-text-ok" | pbcopy']);
    await key(ui, 'v', 'KeyV', 86, META);
    await ui.press('Enter');
    await waitScreen(ui, /^pasted-text-ok\s*$/m);
    save();

    // 4 the right-click menu
    at = await cellOf(ui, 'pasted-text-ok', 0);
    await rightClick(ui, at);
    items = await menuItems(ui);
    facts.menu = items;
    for (const want of ['Copy', 'Paste', 'Select All', 'Snippets', 'Continue in a New Session', 'Fork Session', 'Copy Context', 'Clear', 'More']) {
      assert.ok(items.includes(want), `${want} in ${JSON.stringify(items)}`);
    }
    assert.ok(!items.includes('Copy Session ID'), 'ids stay under More');
    await ui.screenshot('04-menu');
    await ui.mark({ css: '.monaco-menu-container' }, { what: '右键菜单', where: '终端里右键', how: '复制粘贴、快捷命令、在新会话中继续、派生会话、复制上下文、清屏；ID 和重置在 More 里' });
    await ui.hover({ text: 'Snippets', exact: true, within: '.monaco-menu-container' });
    await ui.sleep(800);
    items = await menuItems(ui);
    facts.snippets = items;
    assert.ok(items.includes('Run the tests and fix what fails') && items.includes('New Snippet...'), JSON.stringify(items));
    await ui.screenshot('05-snippets');
    await ui.mark({ text: 'Run the tests and fix what fails', within: '.monaco-menu-container' }, { what: '快捷命令', where: '右键 › Snippets', how: '点一条，话就放进终端（不发送）；New Snippet 存新的' });
    await ui.click({ text: 'Run the tests and fix what fails', within: '.monaco-menu-container' });
    s = await waitScreen(ui, /Run the tests\. Fix what fails, then run them again until they pass\.$/m);
    await key(ui, 'Backspace', 'Backspace', 8, META); // ⌘⌫ clears the line (Ctrl+U), as in iTerm2 and Ghostty
    s = await screen(ui);
    assert.ok(!/until they pass\.\s*$/.test(s.text.trimEnd().split('\n').slice(-1)[0]), '⌘⌫ cleared the line');
    // Copy Context
    let copied = '';
    for (let attempt = 0; attempt < 3 && !copied.includes('dispatch-ok'); attempt++) {
      await rightClick(ui, at);
      await ui.click({ text: 'Copy Context', exact: true, within: '.monaco-menu-container' });
      for (let i = 0; i < 20 && !copied.includes('dispatch-ok'); i++) {
        await ui.sleep(300); // the text comes from the terminal service, then goes on the clipboard
        copied = execFileSync('pbpaste', { encoding: 'utf8' });
      }
    }
    facts.copyContext = copied.slice(-300);
    assert.ok(copied.includes('dispatch-ok') && !copied.includes('\x1b['), 'the context is plain text with the conversation');
    save();

    // 5 the window reloads (as when Dispatch quits and opens again): the same terminal, same shell, same screen
    await ui.press('F1');
    await ui.type('Reload Window');
    await ui.sleep(800);
    await ui.press('Enter');
    await ui.sleep(4000);
    await ui.attach('agents', 90000);
    await ui.waitFor({ text: 'Terminal', exact: true, within: '.session-item' }, { timeoutMs: 60000 });
    await ui.click({ text: 'Terminal', exact: true, within: '.session-item' });
    s = await waitScreen(ui, /你好🙂 dispatch-ok/, 30000);
    await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' });
    await shellLine(ui, 'echo "AGAIN=$$"');
    s = await waitScreen(ui, /AGAIN=\d+/);
    facts.pidAfterReload = s.text.match(/AGAIN=(\d+)/)[1];
    assert.equal(facts.pidAfterReload, facts.pid, 'the same shell kept running');
    save();
    await ui.screenshot('06-after-reload');
    await ui.mark({ css: '.dispatch-terminal-view' }, { what: '重开后原样', where: '重载窗口后点回这个终端', how: '同一个 shell（PID 不变），之前的输出都在' });

    // 6 the terminal service itself stops (as after a Mac restart): it comes back from disk and starts again
    cli('terminal', 'daemon', 'stop', '--json');
    s = await waitScreen(ui, /started again in the same folder/, 40000);
    assert.ok(/你好🙂 dispatch-ok/.test(s.text), 'the earlier output is still there');
    await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' });
    await shellLine(ui, 'echo "COLD=$$"; pwd');
    s = await waitScreen(ui, /COLD=\d+/);
    facts.pidAfterColdRestore = s.text.match(/COLD=(\d+)/)[1];
    assert.notEqual(facts.pidAfterColdRestore, facts.pid, 'a new shell after the service restarted');
    assert.ok(s.text.includes(fs.realpathSync(folder)) || s.text.includes(folder), 'in the same folder');
    save();
    await ui.screenshot('07-cold-restore');
    await ui.mark({ css: '.dispatch-terminal-view' }, { what: '机器重启后', where: '终端里一行灰字', how: '之前的内容在上面，新 shell 在同一个文件夹；Agent 能续的会自己续上' });

    // 7 Continue in a New Session from a plain terminal: a chat session with the hand-over in its input
    at = await cellOf(ui, 'COLD=', 0);
    await rightClick(ui, at);
    await ui.click({ text: 'Continue in a New Session', exact: true, within: '.monaco-menu-container' });
    await ui.waitFor({ css: '.sessions-chat-editor' }, { timeoutMs: 30000 });
    let input = '';
    for (let i = 0; i < 30 && !/Go on with the work of an earlier Dispatch session/.test(input); i++) {
      await ui.sleep(500);
      input = await ui.eval(`[...document.querySelectorAll('.view-lines')].map(e => e.innerText).join('\\n')`);
      input = input.replace(/\u00a0/g, ' '); // Monaco draws spaces as no-break spaces
    }
    facts.continueInput = input.slice(0, 400);
    assert.match(input, /Go on with the work of an earlier Dispatch session/);
    save();
    await ui.screenshot('08-continue-in-chat');
    await ui.mark({ css: '.sessions-chat-editor' }, { what: '在新会话中继续', where: '右键 › Continue in a New Session', how: '新会话的输入框里是交接的话，看过再发' });
  } finally {
    save();
    try {
      cli('terminal', 'daemon', 'stop', '--json');
    } catch { /* already gone */ }
  }
}
