// Direction A of the terminal design (design/terminal-merge): a terminal session has two views, "Chat / Terminal",
// and the agent keeps running when the view changes; a terminal that kept running while nobody watched it says so.
// Checks a plain terminal keeps Chat greyed with a reason; with TERMINAL_VIEWS_CLAUDE=1 it also opens Claude Code in a
// terminal (its own screen only: nothing is sent to it) and switches to Chat and back. Stops the instance's terminal daemon at the end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const meta = { title: '终端会话的两种看法', description: '同一个终端会话「Chat / Terminal」一键切换，Agent 不重启；纯终端的 Chat 是灰的并写明原因。' };

const META = 4;

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

async function openFromPicker(ui, label) {
  // ⌘T is for the session area: after a look at the side pane, the person clicks back into the session first
  if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('.part.editor')`)) {
    await ui.click({ css: '.part.sessionspart', webview: false });
    await ui.sleep(300);
  }
  await key(ui, 't', 'KeyT', 84, META);
  await ui.waitFor({ css: '.dispatch-new-picker' }, { timeoutMs: 15000 });
  await ui.waitFor({ text: label, within: '.dispatch-new-picker' }, { timeoutMs: 60000 });
  await ui.click({ text: label, within: '.dispatch-new-picker' });
  for (const until = Date.now() + 40000; Date.now() < until; await ui.sleep(500)) {
    if (await ui.exists("Use your Ghostty look in Dispatch's terminal?")) await ui.click({ text: 'Not now', exact: true });
    if (await ui.exists({ css: '.dispatch-terminal-view .dispatch-xterm .xterm-screen' })) break;
  }
  await ui.sleep(1500);
}

const tabState = ui => ui.eval(`(() => {
  const v = [...document.querySelectorAll('.dispatch-terminal-view')].find(e => e.offsetParent);
  const [chat, term] = v ? v.querySelectorAll('.dts-tab') : [];
  return chat ? { chatDisabled: chat.disabled, chatTitle: chat.title, chatOn: chat.classList.contains('on'), termOn: term.classList.contains('on'),
    chatShown: getComputedStyle(v.querySelector('.dispatch-terminal-chat')).display !== 'none',
    termShown: getComputedStyle(v.querySelector('.dispatch-terminal-host')).display !== 'none',
    chatText: v.querySelector('.dispatch-terminal-chat').innerText.slice(0, 300) } : null;
})()`);

export default async function (ui) {
  const rec = ui.rec;
  const env = { ...process.env, BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home };
  const cli = (...args) => execFileSync('python3', [rec.cli, ...args], { env, encoding: 'utf8', timeout: 60000 });
  const facts = {};
  const save = () => fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 1));
  try {
    await ui.attach('agents', 90000);
    await ui.sleep(6000);
    await closeTips(ui);
    // openAgents brings up the editor window with the title bar's Editor button when there is none, and waits for it
    await ui.openAgents(ui.demoFolder);
    await ui.newSession();
    await closeTips(ui);

    // 1 a plain terminal: Chat is greyed and says why
    await openFromPicker(ui, 'Blank terminal');
    facts.plain = await tabState(ui);
    assert.ok(facts.plain.chatDisabled && /plain terminal/.test(facts.plain.chatTitle), JSON.stringify(facts.plain));
    assert.ok(facts.plain.termOn && facts.plain.termShown);
    save();
    await ui.screenshot('01-plain-terminal');
    await ui.mark({ css: '.dispatch-terminal-switch' }, { what: 'Chat / Terminal', where: '终端会话右上角', how: '纯终端没有对话，Chat 是灰的，悬停写原因' });
    // the Now tab speaks of the terminal in plain words, never the provider's own id (task-tt6y)
    const nowText = async () => {
      await ui.openTab('Now');
      await ui.sleep(1500);
      // the head of direction A (2026-11-11): the state line, the line, the terminal's last line; the engine's name is
      // the state line's tooltip
      return ui.eval(`(() => { const h = [...document.querySelectorAll('.dispatch-now-tab [data-part="now-head"]')].find(e => e.offsetParent); return h ? h.innerText + '\\n' + (h.querySelector('.dispatch-now-status')?.title || '') : ''; })()`);
    };
    facts.nowPlain = await nowText();
    assert.ok(!/dispatch-terminal/.test(facts.nowPlain) && /^In the terminal/.test(facts.nowPlain) && /Terminal/.test(facts.nowPlain) && /Type a command there/.test(facts.nowPlain), facts.nowPlain);
    save();

    // 2 Claude Code in a terminal: Chat shows the conversation read from its own record (none yet), Terminal is back
    const agents = JSON.parse(cli('terminal', 'agents', '--json')).agents;
    facts.hasClaude = agents.some(a => a.id === 'claude');
    // opening Claude Code is a real Claude Code session: only when asked (TERMINAL_VIEWS_CLAUDE=1), never by default
    if (facts.hasClaude && process.env.TERMINAL_VIEWS_CLAUDE === '1') {
      await openFromPicker(ui, 'Claude Code');
      let s = await tabState(ui);
      assert.ok(!s.chatDisabled, 'Chat is offered for Claude Code started by Dispatch: ' + JSON.stringify(s));
      await ui.screenshot('02-claude-terminal');
      await ui.click({ text: 'Chat', exact: true, within: '.dispatch-terminal-view' });
      await ui.sleep(1500);
      s = await tabState(ui);
      facts.chat = s;
      assert.ok(s.chatOn && s.chatShown && !s.termShown, JSON.stringify(s));
      assert.ok(await ui.exists({ css: '.dispatch-terminal-chat textarea.dtc-input' }));
      await ui.screenshot('03-claude-chat');
      await ui.mark({ css: '.dispatch-terminal-chat' }, { what: '同一会话的聊天看法', where: '点 Chat', how: '读 Claude Code 自己的对话记录；下面的框替你打进终端；Agent 没有重启' });
      const before = JSON.parse(cli('terminal', 'daemon', 'status', '--json')).sessions.map(x => x.pid).sort();
      await ui.click({ text: 'Terminal', exact: true, within: '.dispatch-terminal-view' });
      await ui.sleep(1000);
      const after = JSON.parse(cli('terminal', 'daemon', 'status', '--json')).sessions.map(x => x.pid).sort();
      facts.pids = { before, after };
      assert.deepEqual(after, before, 'switching views restarted nothing');
      s = await tabState(ui);
      assert.ok(s.termOn && s.termShown && !s.chatShown);
      await ui.screenshot('04-back-to-terminal');
    }
    // OpenCode in a terminal (its own screen only, nothing is sent): the Now tab names it and says to type there
    facts.hasOpenCode = agents.some(a => a.id === 'opencode');
    if (facts.hasOpenCode) {
      await openFromPicker(ui, 'OpenCode');
      // the card follows the terminal once OpenCode has started in it: a few seconds on a busy Mac
      for (let i = 0; i < 12 && !/OpenCode/.test(facts.nowOpenCode = await nowText()); i++) await ui.sleep(1500);
      assert.ok(!/dispatch-terminal/.test(facts.nowOpenCode) && /OpenCode/.test(facts.nowOpenCode), facts.nowOpenCode);
      save();
      await ui.screenshot('05-opencode-now');
      await ui.mark({ css: '.dispatch-now-tab [data-part="now-head"]' }, { what: 'Now 页签写终端里的 Agent', where: '右栏 Now', how: '终端会话写 OpenCode 和「在终端里打字」，不再露 dispatch-terminal' });
    }
    // 3 the rows end with the agent's mark and >_
    facts.rowMarks = await ui.eval(`[...document.querySelectorAll('.session-item .dispatch-row-mark:not(.empty)')].map(e => (e.getAttribute('aria-label') || '') + ' ' + e.textContent)`);
    assert.ok(facts.rowMarks.some(t => /terminal/i.test(t) && t.includes('>_')), JSON.stringify(facts.rowMarks));
    // the mark shows when the row is pointed at (blurt DIS-11, 10-31): the pointer on that row first
    await ui.hover({ css: '.session-item:has(.dispatch-row-mark:not(.empty))' });
    await ui.mark({ css: '.session-item .dispatch-row-mark:not(.empty)' }, { what: '行尾的标', where: '左侧会话行最后', how: 'Agent 自己的标；在终端里跑的再加 >_' });
    save();
  } finally {
    save();
    try {
      cli('terminal', 'daemon', 'stop', '--json');
    } catch { /* gone */ }
  }
}
