// Which agents the person uses: the wizard's agents step lists every agent found on the Mac with a switch,
// the choice is saved by "Set up Dispatch", the new session picker shows only the agents that are on, and the
// same list in Settings › Agents changes the picker at once.
// Start the instance with: dispatch ide instance start agents --onboarding fresh --agents
// (the fixture HOME has Claude Code, Codex and OpenCode, plus Gemini CLI, Aider and Kiro CLI as small scripts).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const meta = { instance: { onboarding: 'fresh' }, title: '选用哪几个 Agent', description: '向导列出 Mac 上所有 Agent 并带开关，Set up 保存，新会话选择器只显示打开的，设置 › Agents 里同一份列表即时生效。' };

const wizardRows = ui => ui.eval(`[...document.querySelectorAll('.dispatch-onboarding .dob-row')].map(r => ({ name: r.querySelector('.dob-n')?.textContent.trim(), about: r.querySelector('.dob-why')?.textContent.trim() || '', icon: r.querySelector('.dob-gl')?.className || '', mark: r.querySelector('.dob-gl') ? getComputedStyle(r.querySelector('.dob-gl'), '::before').webkitMaskImage : '', on: r.querySelector('[role=checkbox]')?.getAttribute('aria-checked') })).filter(r => r.on)`);   // agent rows have a switch; "Reading earlier sessions" is progress

// a new plain chat (no folder in this instance), the way a person starts one: the + on the side bar's Chats row
// (New on the title bar starts in the folder the last session had, here the Assistant's); its session type picker
async function newChat(ui) {
  await ui.closeOverlays();
  await ui.hover({ text: 'Chats', exact: true, within: '.part.sidebar', webview: false });
  await ui.sleep(400);
  await ui.click({ aria: 'New Quick Chat', exact: true, within: '.part.sidebar', webview: false });
  await ui.waitFor({ css: '.sessions-chat-session-type-picker .sessions-chat-dropdown-label' }, { timeoutMs: 30000 });
}

// a row's status after the name while the agent starts (OpenCode's model list on a fresh Mac)
const NO_MODELS = /(No models available|Getting ready…)$/;
async function sessionTypes(ui) {
  await ui.click({ css: '.sessions-chat-session-type-picker' });
  await ui.waitFor({ css: '.context-view .monaco-list-row' }, { timeoutMs: 15000 });
  const items = await ui.eval(`[...document.querySelectorAll('.context-view .monaco-list-row')].map(r => r.textContent.trim())`);
  await ui.press('Escape');
  return items.map(t => t.replace(NO_MODELS, ''));
}
const shown = ui => ui.eval("document.querySelector('.sessions-chat-session-type-picker')?.innerText.trim().replace(/No models available$/, '')");

// click a switch and wait until it shows the new state (a click that lands while the page redraws is retried)
async function setSwitch(ui, label, want) {
  const state = () => ui.eval(`document.querySelector('[aria-label="${label}"]')?.getAttribute('aria-checked')`);
  for (let i = 0; i < 4 && (await state()) !== String(want); i++) {
    await ui.click({ aria: label, exact: true });
    await ui.sleep(900);
  }
  assert.equal(await state(), String(want), `${label} is ${want}`);
}

export default async function (ui) {
  assert.ok(ui.rec.fixture_home, 'Start this instance with --onboarding fresh');
  const choiceFile = path.join(ui.rec.dispatch_dir, 'agents.json');
  const readChoice = () => JSON.parse(fs.readFileSync(choiceFile, 'utf8'));
  await ui.attach('agents', 60000);
  await ui.waitFor('Agents on this Mac', { timeoutMs: 90000 });
  await ui.sleep(2500);   // What's new waits for the wizard: nothing covers it

  // 1 the wizard lists what is on this Mac, in plain words
  await ui.waitFor('Other agents found', { timeoutMs: 60000 });
  const rows = await wizardRows(ui);
  const names = rows.map(r => r.name);
  for (const want of ['Claude Code', 'Codex', 'OpenCode', 'Gemini CLI', 'Aider', 'Kiro CLI']) assert.ok(names.includes(want), `${want} listed: ${names}`);
  fs.writeFileSync(path.join(ui.out, 'wizard-rows.json'), JSON.stringify(rows, null, 1));
  assert.ok(rows.every(r => r.about), `every row says in plain words what the agent is: ${rows.filter(r => !r.about).map(r => r.name)}`);
  assert.ok(!rows.some(r => /\b(CLI|PATH|npm|binary)\b/.test(r.about)), 'no developer words in the descriptions');
  // every agent shows its own mark, never the generic terminal icon
  assert.ok(rows.every(r => r.icon && !/codicon-terminal\b/.test(r.icon)), `own marks: ${rows.map(r => r.name + ' ' + r.icon)}`);
  assert.match(rows.find(r => r.name === 'Claude Code').icon, /codicon-claude\b/);
  assert.match(rows.find(r => r.name === 'Codex').icon, /codicon-openai\b/);
  assert.match(rows.find(r => r.name === 'Gemini CLI').mark, /dispatch-agent-gemini/);
  assert.match(rows.find(r => r.name === 'Kiro CLI').mark, /dispatch-agent-kiro/);
  assert.equal(rows.find(r => r.name === 'Codex').on, 'true');
  assert.equal(rows.find(r => r.name === 'Gemini CLI').on, 'false');
  assert.ok(await ui.exists('Dispatch cannot start sessions with these yet. Tick one to keep it in your list.'));
  await ui.screenshot('01-wizard-agents');
  await ui.mark('Other agents found', { what: '找到的其他 Agent', where: '首次打开向导的第一屏', how: '勾选想用的；Dispatch 还不能用它们开会话，页面上写明' });

  // 2 turn Codex off and Gemini CLI on, then set up
  await setSwitch(ui, 'Use Codex with Dispatch', false);
  await setSwitch(ui, 'Use Gemini CLI with Dispatch', true);
  const after = await wizardRows(ui);
  assert.equal(after.find(r => r.name === 'Codex').on, 'false');
  assert.equal(after.find(r => r.name === 'Gemini CLI').on, 'true');
  // OpenCode becomes the default (Claude Code is the default until then)
  assert.equal(await ui.eval("document.querySelectorAll('.dispatch-onboarding .dob-tag').length"), 1);
  await ui.click({ text: 'Set default', exact: true });
  assert.equal(await ui.eval("[...document.querySelectorAll('.dispatch-onboarding .dob-row')].find(r => r.querySelector('.dob-tag'))?.querySelector('.dob-n')?.textContent"), 'OpenCode');
  await ui.screenshot('02-wizard-toggled');
  assert.equal(fs.existsSync(choiceFile), false, 'nothing is saved while the wizard is being clicked through');
  // autonomy, appearance and notifications come between the agents and the rules: continue through them
  for (let i = 0; i < 4 && !(await ui.exists('Connect Dispatch to your agents')); i++) {
    await ui.click({ css: '.dob-foot .dob-btn.fill' });
    await ui.sleep(900);
  }
  await ui.waitFor('Connect Dispatch to your agents', { timeoutMs: 30000 });
  // the rules plan is loaded (the button is enabled): its last note, below the fold with six agents
  await ui.waitForText('Everything is listed in Settings', { timeoutMs: 60000 });
  await ui.clickWhenEnabled({ text: 'Set up Dispatch', exact: true });
  await ui.waitFor({ text: 'Saving which agents you use', exact: true }, { timeoutMs: 60000 });
  // a loaded Mac can time a step out: Retry setup runs the steps that did not finish
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 180 && !(await ui.exists({ text: 'Start', exact: true })) && !(await ui.exists({ text: 'Retry setup', exact: true })); j++) await ui.sleep(1000);
    if (await ui.exists({ text: 'Start', exact: true })) break;
    await ui.click({ text: 'Retry setup', exact: true });
  }
  await ui.waitFor({ text: 'Start', exact: true }, { timeoutMs: 60000 });
  assert.equal(await ui.eval("document.querySelectorAll('.dob-pr.failed').length"), 0);
  assert.deepEqual(readChoice(), { off: ['codex'], on: ['gemini'], default: 'opencode' });
  await ui.click({ text: 'Start', exact: true });
  await ui.waitFor('Welcome to Dispatch', { timeoutMs: 30000 });   // What's new, now that the wizard is over
  await ui.press('Escape');
  await ui.sleep(9000);   // the way in after setup is the Assistant: let it land before the next steps

  // 3 the new session picker offers Claude Code and OpenCode, not Codex
  await newChat(ui);
  const types = await sessionTypes(ui);
  fs.writeFileSync(path.join(ui.out, 'picker-codex-off.json'), JSON.stringify(types));
  await ui.screenshot('03-picker-without-codex');
  assert.ok(types.includes('Claude Code') && types.includes('OpenCode'), JSON.stringify(types));
  assert.ok(!types.includes('Codex'), `Codex is off: ${JSON.stringify(types)}`);
  assert.equal(types[0], 'OpenCode', `the default agent is first: ${JSON.stringify(types)}`);
  assert.equal(await shown(ui), 'OpenCode', 'a new session starts with the default');

  // 4 Settings › Agents has the same list (it moved there from Customizations): the agents Dispatch talks to with a
  //   switch each, the others found on this Mac listed for the terminal; turning Codex back on brings it into the
  //   picker at once
  const CHECK = (label) => ({ css: `.dispatch-settings-page [aria-label="${label}"]`, webview: false });
  const checked = (label) => ui.eval(`document.querySelector('.dispatch-settings-page [aria-label="${label}"]')?.getAttribute('aria-checked')`);
  await ui.press('Cmd+,');
  await ui.waitFor({ css: '.dispatch-settings-nav .dsn-row[data-page="agents"]', webview: false }, { timeoutMs: 15000 });
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="agents"]', webview: false });
  await ui.waitFor(CHECK('Use Codex with Dispatch'), { timeoutMs: 60000 });
  const listed = () => ui.eval(`[...document.querySelectorAll('.dispatch-settings-page [data-agent]')].map(r => ({ id: r.dataset.agent, text: r.innerText.replace(/\\s+/g, ' ').trim(), on: r.querySelector('[aria-label^="Use "]')?.getAttribute('aria-checked') ?? null, icon: r.querySelector('[class*="dispatch-agent-"]')?.className || '' }))`);
  let list = await listed();
  fs.writeFileSync(path.join(ui.out, 'settings-agents.json'), JSON.stringify(list, null, 1));
  assert.deepEqual(list.filter(r => r.on !== null).map(r => r.id), ['claude', 'codex', 'opencode'], 'a switch for each agent Dispatch talks to');
  assert.equal(list.find(r => r.id === 'codex').on, 'false');
  assert.ok(/Default/.test(list.find(r => r.id === 'opencode').text), 'OpenCode is the default the wizard set');
  const page = await ui.eval(`document.querySelector('.dispatch-settings-page')?.innerText || ''`);
  assert.ok(/Also on this Mac, opened in the terminal/.test(page), 'the other agents found are listed for the terminal');
  for (const name of ['Gemini CLI', 'Aider', 'Kiro CLI']) assert.ok(page.includes(name), `${name} is listed`);
  await ui.screenshot('04-settings-agents');
  await ui.mark(CHECK('Use Codex with Dispatch'), { what: 'Agent 列表', where: '设置 › Agents', how: '每个一行带开关，默认那个写着 Default；其余找到的列在下面，在终端里开' });
  await ui.click(CHECK('Use Codex with Dispatch'));
  for (let i = 0; i < 30 && readChoice().off.length; i++) await ui.sleep(500);
  assert.deepEqual(readChoice(), { off: [], on: ['gemini'], default: 'opencode' });
  // Make default changes what a new session starts with
  await ui.waitFor({ css: '.dispatch-settings-page [data-agent="claude"]', webview: false }, { timeoutMs: 30000 });
  await ui.click({ text: 'Make default', exact: true, within: '.dispatch-settings-page [data-agent="claude"]', webview: false });
  for (let i = 0; i < 30 && readChoice().default !== 'claude'; i++) await ui.sleep(500);
  assert.equal(readChoice().default, 'claude');
  // Settings stays where the person is (10-07: the new session waiting behind it switched agents and closed Settings)
  await ui.sleep(4000);
  assert.ok(await ui.exists({ css: '.part.sidebar.dispatch-settings-open', webview: false }), 'Settings stays open after Make default');
  // the page reads the agents again after the change (a few seconds on a busy Mac)
  const claudeRow = async () => (await listed()).find(r => r.id === 'claude')?.text || '';
  for (let i = 0; i < 120 && !/Default/.test(await claudeRow()); i++) await ui.sleep(500);
  assert.ok(/Default/.test(await claudeRow()), 'Default moves to Claude Code');
  await ui.waitFor({ text: 'Make default', exact: true, within: '.dispatch-settings-page [data-agent="opencode"]', webview: false }, { timeoutMs: 30000 });
  // the last agent Dispatch talks to cannot be turned off
  // one click, then what a person waits for: the choice saved and the page drawn again with the switch where it went
  // (the page reads the agents again after each change; a second click before that would land on the old switch)
  const setSwitchIn = async (label, want) => {
    const id = { 'Use Claude Code with Dispatch': 'claude', 'Use OpenCode with Dispatch': 'opencode', 'Use Codex with Dispatch': 'codex' }[label];
    const saved = () => readChoice().off.includes(id) === !want;
    for (let i = 0; i < 3 && !(saved() && (await checked(label)) === String(want)); i++) {
      if ((await checked(label)) !== String(want)) {
        await ui.waitFor(CHECK(label), { timeoutMs: 15000 });
        await ui.click(CHECK(label));
      }
      for (let j = 0; j < 60 && !(saved() && (await checked(label)) === String(want)); j++) await ui.sleep(500);
    }
    assert.ok(saved(), `${label} saved as ${want}: ${JSON.stringify(readChoice())}`);
    assert.equal(await checked(label), String(want), `${label} is ${want}`);
  };
  await setSwitchIn('Use Claude Code with Dispatch', false);
  await setSwitchIn('Use OpenCode with Dispatch', false);
  await ui.click(CHECK('Use Codex with Dispatch'));
  await ui.waitForText('Keep at least one agent on', { timeoutMs: 15000 });
  assert.equal(readChoice().off.length, 2);
  assert.equal(await checked('Use Codex with Dispatch'), 'true', 'the last one stays on');
  await ui.screenshot('05-last-agent');
  await setSwitchIn('Use Claude Code with Dispatch', true);
  await setSwitchIn('Use OpenCode with Dispatch', true);
  for (let i = 0; i < 30 && readChoice().off.length; i++) await ui.sleep(500);
  assert.deepEqual(readChoice().off, [], 'all three are on again');
  await ui.press('Escape');   // Settings goes back to the sessions
  await ui.waitFor({ css: '.part.sidebar.dispatch-settings-open', webview: false }, { gone: true, timeoutMs: 15000 });
  await ui.sleep(3000);   // a new session not sent yet follows the new default once Settings is closed
  await newChat(ui);
  const back = await sessionTypes(ui);
  fs.writeFileSync(path.join(ui.out, 'picker-all-on.json'), JSON.stringify(back));
  assert.ok(back.includes('Codex') && back.includes('Claude Code') && back.includes('OpenCode'), JSON.stringify(back));
  assert.equal(back[0], 'Claude Code', JSON.stringify(back));
  assert.equal(await shown(ui), 'Claude Code');
}
