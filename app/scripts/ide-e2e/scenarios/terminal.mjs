// The Agents window's terminal: open one for a project, run an agent's own text interface in it, see it in the
// sessions list with a Terminal marker, and the one-time offer to use the person's Ghostty look.
// The instance starts with a temporary HOME that has a sample Ghostty file and the real Claude Code linked in
// (fixtures/terminal_home.py, meta.instance.fixture); otherwise it is the usual seeded one with the demo project.
// The one-time Ghostty question is asked once per instance, so each run starts a new one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const meta = { instance: { fixture: 'terminal-home' }, title: '内置终端', description: '⌘T 给项目开一个终端，在里面跑 Claude Code 的文字界面，左侧列表里带 Terminal 标记，第一次问是否用 Ghostty 的外观。' };

// The terminal's text, read from the xterm the terminal session keeps on its screen element (dispatchXterm.ts).
const terminalText = ui => ui.eval(`(() => {
  const w = [...document.querySelectorAll('.dispatch-terminal-view .dispatch-xterm')].find(e => e.offsetParent);
  const b = w && w.xterm && w.xterm.buffer.active;
  if (!b) return '';
  const lines = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) lines.push(l.translateToString(true)); }
  return lines.join('\\n').trim();
})()`);

const sessionRows = ui => ui.eval(`[...document.querySelectorAll('.monaco-list-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim()).filter(t => /terminal/i.test(t))`);
const META = 4; // CDP's modifier bit for ⌘

/** ⌘T, the way a person opens a terminal; the panel says which project it is for. A fresh window can still be on
 *  the Assistant's page for a moment (no project there: ⌘T says so), so it is pressed again until the panel is up. */
async function openPanel(ui, name) {
  for (let i = 0; ; i++) {
    await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: META });
    await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: META });
    if (await ui.waitFor({ css: '.dispatch-new-picker' }, { timeoutMs: 8000 }).then(() => true, () => false)) break;
    if (i >= 3) throw new Error('⌘T does not open the new-session panel');
  }
  const where = await ui.eval(`(document.querySelector('.dispatch-new-picker .dnp-folder') || {}).textContent || ''`);
  assert.equal(where, name, 'the panel is for the project on screen');
  if (!(await ui.eval(`!!document.querySelector('.dispatch-new-picker .dnp-tab[aria-selected="true"]')?.textContent?.startsWith('Terminal')`))) {
    await ui.click({ text: 'Terminal', exact: true, within: '.dispatch-new-picker' });
  }
}

const CLAUDE_SCREEN = /Welcome to Claude Code|Let's get started|Choose the text style/;

export default async function (ui) {
  const home = ui.rec.term_home;
  assert.ok(home && fs.existsSync(path.join(home, '.config', 'ghostty', 'config')), 'the instance has the terminal-home fixture');
  const folder = ui.demoFolder;
  const name = path.basename(folder);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), BEADS_DIR: ui.rec.beads_dir, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home, PATH: `${path.join(home, '.local', 'bin')}:${process.env.PATH}` };
  const dispatch = (...args) => execFileSync('python3', [ui.rec.cli, ...args], { env, encoding: 'utf8', timeout: 120000 });
  const agentsJson = JSON.parse(dispatch('terminal', 'agents', '--json'));
  assert.ok(agentsJson.agents.some(a => a.id === 'claude'), 'the CLI lists Claude Code');
  const ghosttyJson = JSON.parse(dispatch('terminal', 'ghostty', '--json'));
  assert.equal(ghosttyJson.found, true, 'the CLI finds the sample Ghostty file');
  fs.writeFileSync(path.join(ui.out, 'cli-ghostty.json'), JSON.stringify(ghosttyJson, null, 1));

  // the Agents window on the project: Projects, the project, New Session (the window has no folder of its own yet)
  await ui.attach('agents', 90000);
  await ui.click({ text: 'Projects', exact: true });
  await ui.waitFor(folder, { timeoutMs: 180000 });
  await ui.click({ text: folder });
  await ui.waitFor({ text: 'New Session', exact: true }, { timeoutMs: 60000 });
  await ui.click({ text: 'New Session', exact: true });
  await ui.sleep(3000);

  // 1 ⌘T: the new-session panel opens on Terminal for this project (a project without sessions has no "+" of its
  //   own in the list yet; ⌘T and Settings › Terminal › Open a Terminal are the ways in)
  await ui.screenshot('01-before');
  await openPanel(ui, name);
  const terminalTab = await ui.eval(`[...document.querySelectorAll('.dispatch-new-picker .dnp-tab')].map(t => t.textContent + ':' + t.getAttribute('aria-selected')).join(' ')`);
  assert.match(terminalTab, /Terminal:true/, 'the panel opens on Terminal: ' + terminalTab);
  await ui.waitFor({ text: 'Claude Code', within: '.dispatch-new-picker' }, { timeoutMs: 60000 });
  const picker = await ui.eval(`[...document.querySelectorAll('.dispatch-new-picker .dnp-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
  fs.writeFileSync(path.join(ui.out, 'picker.json'), JSON.stringify(picker, null, 1));
  assert.ok(picker.some(t => t.startsWith(`Blank terminal A shell in ${name}. Type any command.`)), JSON.stringify(picker));
  assert.ok(picker.some(t => /^Claude Code\s*Default/.test(t)), JSON.stringify(picker));
  for (const agent of ['Codex', 'OpenCode']) assert.ok(picker.some(t => t.startsWith(agent)), `${agent} listed: ${JSON.stringify(picker)}`);
  assert.ok(!picker.some(t => /\b(PATH|daemon|npm|binary)\b/.test(t)), 'no developer words');
  await ui.screenshot('02-picker');
  await ui.mark({ css: '.dispatch-new-picker' }, { what: '新建面板', where: '⌘T，在 Terminal 一栏', how: '空白终端或一个 Agent，每个带一句说明' });

  // 2 Claude Code: first the one-time Ghostty question
  await ui.click({ text: 'Claude Code', within: '.dispatch-new-picker' });
  await ui.waitFor("Use your Ghostty look in Dispatch's terminal?", { timeoutMs: 20000 });
  const dialog = await ui.eval(`document.querySelector('.monaco-dialog-box')?.innerText || ''`);
  fs.writeFileSync(path.join(ui.out, 'ghostty-question.txt'), dialog);
  assert.match(dialog, /the font \(Menlo, 15\), the colors \(Midnight\) and the cursor \(bar\)/);
  assert.match(dialog, /Your Ghostty settings stay as they are/);
  await ui.screenshot('03-ghostty-question');
  await ui.mark({ css: '.monaco-dialog-box' }, { what: 'Ghostty 的问题', where: '第一次开终端、Mac 上有 Ghostty 设置时', how: '用我的 Ghostty 外观 / 先不用；只问一次' });
  await ui.click({ text: 'Use my Ghostty look', exact: true });

  // 3 the session is in the list, marked as a terminal, and the terminal shows Claude Code's own screen
  await ui.waitFor('Claude Code (terminal)', { timeoutMs: 30000 });
  const rows = await sessionRows(ui);
  fs.writeFileSync(path.join(ui.out, 'session-rows.json'), JSON.stringify(rows, null, 1));
  assert.ok(rows.some(t => t.includes('Claude Code (terminal)')), JSON.stringify(rows));
  let text = '';
  for (let i = 0; i < 60; i++) {
    text = await terminalText(ui);
    if (CLAUDE_SCREEN.test(text)) break;
    await ui.sleep(1000);
  }
  fs.writeFileSync(path.join(ui.out, 'terminal-text.txt'), text);
  assert.ok(CLAUDE_SCREEN.test(text), `Claude Code's own screen is up: ${text.slice(0, 300)}`);
  await ui.screenshot('04-claude-in-terminal');
  await ui.mark('Claude Code (terminal)', { what: '终端会话', where: '左侧会话列表，项目下', how: '图标和名字里的 (terminal) 说明它是终端；点它回到这个终端' });

  // 4 the Ghostty look was written into the terminal settings
  const files = [path.join(ui.rec.agents_user_data_dir, 'User', 'settings.json'), path.join(ui.rec.user_data_dir, 'User', 'settings.json')];
  const settingsFile = files.find(p => fs.existsSync(p) && /terminal.integrated.fontFamily/.test(fs.readFileSync(p, 'utf8')));
  assert.ok(settingsFile, 'the terminal settings were written: ' + files.join(', '));
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(settings['terminal.integrated.fontFamily'], 'Menlo');
  assert.equal(settings['terminal.integrated.fontSize'], 15);
  assert.equal(settings['terminal.integrated.cursorStyle'], 'line');
  assert.equal(settings['workbench.colorCustomizations']['terminal.background'], '#0b1020');
  assert.equal(settings['workbench.colorCustomizations']['terminal.ansiRed'], '#ef5350');
  fs.writeFileSync(path.join(ui.out, 'settings-written.json'), JSON.stringify({ file: settingsFile, ...Object.fromEntries(Object.entries(settings).filter(([k]) => /^terminal|colorCustomizations/.test(k))) }, null, 1));

  // 5 a plain terminal next to it; the question is not asked again
  await openPanel(ui, name);
  await ui.waitFor({ text: 'Blank terminal', within: '.dispatch-new-picker' }, { timeoutMs: 60000 });
  await ui.click({ text: 'Blank terminal', within: '.dispatch-new-picker' });
  await ui.sleep(2500);
  assert.ok(!(await ui.exists("Use your Ghostty look in Dispatch's terminal?")), 'asked only once');
  const rows2 = await sessionRows(ui);
  fs.writeFileSync(path.join(ui.out, 'session-rows-2.json'), JSON.stringify(rows2, null, 1));
  assert.ok(rows2.some(t => /^Terminal\b/.test(t)) && rows2.some(t => t.includes('Claude Code (terminal)')), JSON.stringify(rows2));
  await ui.screenshot('05-two-terminals');

  // 6 back to Claude Code's terminal: still the same screen
  await ui.click('Claude Code (terminal)');
  await ui.sleep(1500);
  const again = await terminalText(ui);
  assert.ok(CLAUDE_SCREEN.test(again), 'the same terminal is back');
  await ui.screenshot('06-back');
}
