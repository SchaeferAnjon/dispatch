// A test instance keeps to its own task board and its own Assistant (10-07, the isolation group):
// 1. Dispatch's terminal: the person's ~/.zshrc sets BEADS_DIR to their real board (this Mac's and the mini's both do),
//    and a login shell used to take it, so a task made in the instance's terminal went onto the real board. The
//    terminal now puts Dispatch's variables back after the startup files: the shell shows the instance's board, and a
//    task made there with bd lands on it.
// 2. The Assistant: its folder was always ~/.dispatch/assistant, so the instance's Assistant row opened the person's
//    real Assistant conversation. It is now in the instance's own Dispatch folder (DISPATCH_HOME): a click there opens
//    the instance's Assistant, nothing of the person's.
// Pictures are taken before each check, so a run on an older build shows what was wrong. Stops the instance's terminal
// daemon at the end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

export const meta = { title: '测试实例不碰真实数据', description: '测试实例的终端用实例自己的任务板（你的 ~/.zshrc 设了 BEADS_DIR 也一样），终端里建的任务落在实例板上；左栏 Assistant 打开的是实例自己的 Assistant，不是你真实的对话。' };

const META = 4;

const screen = ui => ui.eval(`(() => {
  const el = [...document.querySelectorAll('.dispatch-terminal-view .dispatch-xterm')].find(e => e.offsetParent);
  const t = el && el.xterm;
  if (!t) return { text: '' };
  const b = t.buffer.active;
  const lines = [];
  for (let i = 0; i < b.length; i++) {
    const l = b.getLine(i);
    if (!l) continue;
    if (l.isWrapped && lines.length) lines[lines.length - 1] += l.translateToString(true); else lines.push(l.translateToString(true));
  }
  return { text: lines.join('\\n') };
})()`);

async function waitScreen(ui, re, ms = 30000) {
  let s;
  for (const until = Date.now() + ms; Date.now() < until; await ui.sleep(300)) {
    s = await screen(ui);
    if (re.test(s.text)) return s;
  }
  fs.writeFileSync(path.join(ui.out, 'screen-at-failure.txt'), (s && s.text) || '');
  throw new Error(`the terminal never showed ${re}: ${(s && s.text || '').slice(-600)}`);
}

async function key(ui, k, code, vk, modifiers) {
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await ui.sleep(400);
}

async function closeTips(ui) {
  for (let i = 0; i < 4 && await ui.exists({ css: '.dispatch-tour-close' }); i++) {
    await ui.click({ css: '.dispatch-tour-close' });
    await ui.sleep(500);
  }
}

// xterm ignores inserted text right after a key it handled itself: a Shift press in between, as a person's next
// keystroke would be (terminal-daemon.mjs)
async function shellLine(ui, text) {
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 });
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
  await ui.type(text);
  await ui.press('Enter');
}

const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
const under = (p, root) => real(p) === real(root) || real(p).startsWith(real(root) + path.sep);

export default async function (ui) {
  const rec = ui.rec;
  const env = { ...process.env, BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home };
  const cli = (...args) => execFileSync('python3', [rec.cli, ...args], { env, encoding: 'utf8', timeout: 60000 });
  const facts = {};
  const save = () => fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 1));
  try {
    // 0 what this Mac's own shell does with BEADS_DIR: a login shell started with the instance's board set
    const shell = process.env.SHELL || '/bin/zsh';
    const probe = spawnSync(shell, ['-l', '-i', '-c', 'printf "BOARD=%s" "$BEADS_DIR"'], { env, encoding: 'utf8', timeout: 30000 });
    facts.shell = shell;
    facts.yourShellConfigMovesTheBoard = !((probe.stdout || '').includes('BOARD=' + rec.beads_dir));
    facts.yourShellSays = ((probe.stdout || '').match(/BOARD=(\S*)/) || [])[1] || '';
    save();

    // ISOLATION_ONLY=assistant skips the terminal (to picture the Assistant on a build that still has the terminal leak)
    const only = process.env.ISOLATION_ONLY || '';
    // the Agents window on the demo project: from the editor window an instance starts with, or the Agents window
    // itself when it was started with --agents (openAgents handles both)
    await ui.openAgents(ui.demoFolder);
    await ui.sleep(3000);
    await closeTips(ui);
    await ui.newSession();
    await closeTips(ui);
    await ui.sleep(2000);

    if (only !== 'assistant') {
      // 1 a blank terminal: ⌘T, Terminal, Blank terminal
      // ⌘T; a window still settling (a first-run tip, focus not in it yet) can miss the first press
      let picker = false;
      for (let i = 0; i < 4 && !picker; i++) {
        if (i) {
          await closeTips(ui);
          await ui.press('Escape');
        }
        await key(ui, 't', 'KeyT', 84, META);
        picker = await ui.waitFor({ css: '.dispatch-new-picker' }, { timeoutMs: 8000 }).then(() => true, () => false);
      }
      assert.ok(picker, '⌘T brings up the new-session picker');
      await ui.waitFor({ text: 'Blank terminal', within: '.dispatch-new-picker' }, { timeoutMs: 60000 });
      // the agents' rows come in a moment later; a click before them lands on whatever row comes first
      for (let i = 0; i < 60 && !(await ui.exists({ css: '.dispatch-new-picker .dnp-list .dnp-row' })); i++) await ui.sleep(500);
      await ui.sleep(800);
      await ui.click({ text: 'Terminal', exact: true, within: '.dispatch-new-picker' });
      await ui.sleep(400);
      facts.picker = await ui.eval(`[...document.querySelectorAll('.dispatch-new-picker .dnp-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
      await ui.click({ css: '.dispatch-new-picker .dnp-foot .dnp-blank' });
      for (const until = Date.now() + 40000; Date.now() < until; await ui.sleep(500)) {
        if (await ui.exists("Use your Ghostty look in Dispatch's terminal?")) await ui.click({ text: 'Not now', exact: true });
        if (await ui.exists({ css: '.dispatch-terminal-view .dispatch-xterm .xterm-screen' })) break;
      }
      await ui.waitFor({ css: '.dispatch-terminal-view .dispatch-xterm .xterm-screen' }, { timeoutMs: 20000 });
      await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' });
      // a shell, not an agent: its prompt has drawn and nothing asks to trust the folder
      let first = await screen(ui);
      for (let i = 0; i < 40 && !first.text.trim(); i++, first = await screen(ui)) await ui.sleep(300);
      assert.ok(!/Trust this folder|Claude Code|OpenAI Codex/.test(first.text), 'a blank terminal opened, not an agent: ' + first.text.slice(0, 200));
      await shellLine(ui, 'clear; printf "BOARD=%s\\nDATA=%s\\n" "$BEADS_DIR" "$DISPATCH_HOME"');
      let s = await waitScreen(ui, /^DATA=.*$/m);
      facts.terminal = { board: (s.text.match(/^BOARD=(.*)$/m) || [])[1] || '', data: (s.text.match(/^DATA=(.*)$/m) || [])[1] || '' };
      save();

      await closeTips(ui);  // a first-run tip that came up meanwhile would cover what the picture is for
      await ui.screenshot('01-terminal-board');
      await ui.mark({ css: '.dispatch-terminal-view' }, { what: '终端用的是实例自己的任务板', where: '⌘T › Terminal › Blank terminal', how: 'BOARD= 是测试实例的板，DATA= 是实例的 Dispatch 文件夹' });
      // checked before anything is written: on a build without the fix the next step would make a task on the real board
      assert.ok(under(facts.terminal.board, rec.root), `the terminal's BEADS_DIR is the instance's board, not ${facts.terminal.board}`);
      assert.equal(real(facts.terminal.board), real(rec.beads_dir));
      assert.equal(real(facts.terminal.data), real(rec.dispatch_home));

      // 2 a task made in that terminal, as an agent in it would
      const title = `Isolation probe ${Date.now()}`;
      await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' });
      await shellLine(ui, `bd q "${title}" && echo PROBE-MADE || echo PROBE-FAILED`);
      s = await waitScreen(ui, /^PROBE-(MADE|FAILED)$/m, 60000);
      facts.probeInTerminal = (s.text.match(/^PROBE-(MADE|FAILED)$/m) || [])[1];
      // the instance's board, read with the bd the app brings (the one on PATH when it has none)
      const tools = path.join(rec.app, 'Contents', 'Resources', 'app', 'tools', 'bd');
      const bd = fs.existsSync(tools) ? tools : 'bd';
      const listed = JSON.parse(execFileSync(bd, ['list', '--all', '--json', '--title-contains', title], { env, encoding: 'utf8', timeout: 60000 }) || '[]');
      facts.probeOnInstanceBoard = (Array.isArray(listed) ? listed : []).some(r => (r.title || '') === title);
      save();
      await closeTips(ui);  // a first-run tip that came up meanwhile would cover what the picture is for
      await ui.screenshot('02-terminal-task');
      await ui.mark({ css: '.dispatch-terminal-view' }, { what: '终端里建的任务', where: '同一个终端', how: 'bd q 建的任务落在实例板上，不在你真实的板上' });
      assert.equal(facts.probeInTerminal, 'MADE', 'bd in the terminal made the task');
      assert.ok(facts.probeOnInstanceBoard, 'the task made in the terminal is on the instance board');
    }

    // 3 the instance's own Assistant folder (the CLI's `dispatch assistant`, which a new chat's first suggestions read;
    // the Mac's Assistant row went 2026-11-11): in the instance, no conversation of yours
    const mine = JSON.parse(cli('assistant', '--json'));
    facts.assistant = { folder: mine.folder, session: mine.session ? { id: mine.session.id, title: mine.session.title } : null };
    const home = os.homedir();
    const theirs = path.join(home, '.claude', 'projects', path.join(home, '.dispatch', 'assistant').replace(/[/.]/g, '-'));
    facts.yourRealAssistantChats = fs.existsSync(theirs) ? fs.readdirSync(theirs).filter(f => f.endsWith('.jsonl')).length : 0;
    save();
    assert.ok(under(mine.folder, rec.root), `the instance's Assistant folder is in the instance, not ${mine.folder}`);
    assert.equal(mine.session, null, 'a fresh instance has no Assistant conversation yet');
  } finally {
    save();
    try {
      cli('terminal', 'daemon', 'stop', '--json');
    } catch { /* already gone */ }
  }
}
