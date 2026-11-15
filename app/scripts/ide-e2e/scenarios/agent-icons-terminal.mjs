// Every agent shows its own mark in the terminal parts of the Agents window too: the new-session panel ("+", ⌘T on
// Terminal) lists each agent with its icon, and a terminal session running Claude Code has Claude's mark in the
// sessions list, not the generic terminal icon (a blank terminal keeps that one, in the panel's last row).
// Runs in a plain seeded instance; the agents listed are the ones on this Mac (Claude Code at least).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const meta = { title: '终端里的 Agent 图标', description: '新建面板（⌘T 在 Terminal）里每个 Agent 带自己的图标，跑 Claude Code 的终端会话在会话列表里用 Claude 的图标。' };

const META = 4;

async function closeTips(ui) {
  for (let i = 0; i < 4 && await ui.exists({ css: '.dispatch-tour-close' }); i++) {
    await ui.click({ css: '.dispatch-tour-close' });
    await ui.sleep(500);
  }
}

export default async function (ui) {
  const rec = ui.rec;
  const env = { ...process.env, BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home };
  const cli = (...args) => execFileSync('python3', [rec.cli, ...args], { env, encoding: 'utf8', timeout: 60000 });
  try {
    await ui.attach('agents', 90000);
    await ui.sleep(4000);
    await closeTips(ui);
    await ui.openAgents(ui.demoFolder);
    await ui.newSession();
    await closeTips(ui);
    await ui.sleep(2000);

    // 1 the panel: each agent with its own mark. It opens for the folder of the page in front: a fresh window can
    //    still be on the Assistant's page, so it is opened again until it says the demo folder
    const name = ui.demoFolder.split('/').pop();
    for (let attempt = 0; ; attempt++) {
      await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: META });
      await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: META });
      // on the Assistant's page there is no project yet: ⌘T says so instead of opening the panel
      for (let i = 0; i < 20 && !(await ui.exists({ css: '.dispatch-new-picker' })); i++) await ui.sleep(500);
      const where = await ui.eval(`(document.querySelector('.dispatch-new-picker .dnp-folder') || {}).textContent || ''`);
      if (where === name || attempt >= 3) break;
      await ui.press('Escape');
      await ui.openAgents(ui.demoFolder);
      await ui.newSession();
      await ui.sleep(2000);
    }
    await ui.waitFor({ css: '.dispatch-new-picker' }, { timeoutMs: 5000 });
    await ui.waitFor({ text: 'Claude Code', within: '.dispatch-new-picker' }, { timeoutMs: 150000 });
    const picks = await ui.eval(`[...document.querySelectorAll('.dispatch-new-picker .dnp-row')].map(r => ({ text: r.innerText.replace(/\\s+/g, ' ').trim(), icons: [...r.querySelectorAll('.dnp-mark [class*="codicon-"], .dnp-mark.codicon')].map(i => i.className).join(' ') }))`);
    fs.writeFileSync(path.join(ui.out, 'picks.json'), JSON.stringify(picks, null, 1));
    const row = name => picks.find(p => p.text.startsWith(name));
    assert.match(row('Claude Code')?.icons ?? '', /codicon-claude\b/, JSON.stringify(picks));
    if (row('Codex')) assert.match(row('Codex').icons, /codicon-openai\b/, JSON.stringify(picks));          // listed when it is on this Mac
    if (row('OpenCode')) assert.match(row('OpenCode').icons, /codicon-dispatch-opencode\b/, JSON.stringify(picks));
    for (const p of picks.filter(p => !p.text.startsWith('Blank terminal'))) assert.doesNotMatch(p.icons, /codicon-terminal\b/, p.text);
    assert.match(row('Blank terminal')?.icons ?? '', /codicon-terminal\b/, 'a blank terminal keeps the terminal icon');
    await ui.screenshot('01-pick');
    await ui.mark({ css: '.dispatch-new-picker' }, { what: '新建面板', where: '⌘T，或会话列表的「+」', how: '每个 Agent 前面是它自己的图标' });

    // 2 a terminal session with Claude Code (its own screen only: nothing is sent to it): Claude's mark in the list
    await ui.click({ text: 'Claude Code', within: '.dispatch-new-picker' });
    for (const until = Date.now() + 40000; Date.now() < until; await ui.sleep(500)) {
      if (await ui.exists("Use your Ghostty look in Dispatch's terminal?")) await ui.click({ text: 'Not now', exact: true });
      if (await ui.exists('Claude Code (terminal)')) break;
    }
    await ui.waitFor('Claude Code (terminal)', { timeoutMs: 30000 });
    await ui.sleep(1000);
    const sessionRow = await ui.eval(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].find(r => r.innerText.includes('Claude Code (terminal)')); return r ? { icons: [...r.querySelectorAll('[class*="codicon-"]')].map(i => i.className).join(' '), status: !!r.querySelector('.session-icon *'), mark: (r.querySelector('.dispatch-row-mark') || {}).textContent || '' } : null; })()`);
    fs.writeFileSync(path.join(ui.out, 'session-row.json'), JSON.stringify(sessionRow, null, 1));
    assert.ok(sessionRow, 'the session is in the list');
    // a session's row shows its status as Dispatch's blocks, never the terminal icon; the end mark has the agent and >_
    assert.doesNotMatch(sessionRow.icons.replace(/[^ ]*dispatch-row-mark[^ ]*/g, ''), /codicon-terminal\b/, sessionRow.icons);
    assert.match(sessionRow.icons, /codicon-claude\b/, 'Claude\'s mark on the row: ' + sessionRow.icons);
    assert.ok(sessionRow.status, 'the row has its status icon');
    await ui.screenshot('02-terminal-session');
    await ui.mark('Claude Code (terminal)', { what: '终端会话', where: '左侧会话列表，项目下', how: '行尾是 Claude 的图标和 >_，行首是会话状态的方块' });
  } finally {
    try { cli('terminal', 'daemon', 'stop'); } catch { /* not running */ }
  }
}
