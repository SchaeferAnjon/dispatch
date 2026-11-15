// A new person's first run, the parts after "which agents": sign in to Claude Code, how much agents may do on
// their own, light or dark, notifications and keeping the Mac awake, What's new waiting for the wizard, landing on
// a new chat, the same choices again in Settings (⌘,): Agents (what agents may do on their own) and Keep awake, and New
// after setup going back to the folder used before it.
// Start the instance with: DISPATCH_FIXTURE_CLAUDE_SIGNED_OUT=1 dispatch ide instance start firstrun --onboarding fresh --agents
// (the fixture HOME has Claude Code signed out, Codex, OpenCode, and Gemini CLI, Aider and Kiro CLI as small scripts).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const meta = { instance: { onboarding: 'fresh', env: { DISPATCH_FIXTURE_CLAUDE_SIGNED_OUT: '1' } }, title: '首次运行：Agent 权限、外观、通知、不休眠', description: '新用户在向导里登录 Claude、看默认的 Full auto 并来回切换、选外观、开通知、关不休眠，走完后 What\'s new 才出现并落在新对话页，设置页 Agents 和 Keep awake 显示向导里的选择，改了写回同一个值；在项目上开过新会话后重走设置，点 New 回到那个项目。' };

const cli = (ui, args) => JSON.parse(execFileSync('python3', [ui.rec.cli, ...args], {
  env: { ...process.env, HOME: ui.rec.fixture_home, BEADS_DIR: ui.rec.beads_dir, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home },
  encoding: 'utf8', timeout: 60000,
}));
const settings = ui => cli(ui, ['settings', '--json']);
// wait until some text is anywhere in the window (a long sentence is not one element the locator can match)
async function seen(ui, needle, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await ui.eval('document.body.innerText')).includes(needle)) return;
    await ui.sleep(500);
  }
  throw new Error(`never appeared: ${needle}`);
}
const text = ui => ui.eval("document.querySelector('.dispatch-onboarding')?.innerText || ''");
const checked = (ui, label) => ui.eval(`document.querySelector('.dispatch-onboarding [aria-label="${label}"]')?.getAttribute('aria-checked')`);

async function setSwitch(ui, label, want, within = '.dispatch-onboarding') {
  const state = () => ui.eval(`document.querySelector('${within} [aria-label="${label}"]')?.getAttribute('aria-checked')`);
  for (let i = 0; i < 4 && (await state()) !== String(want); i++) {
    await ui.click({ aria: label, exact: true });
    await ui.sleep(900);
  }
  assert.equal(await state(), String(want), `${label} is ${want}`);
}

export default async function (ui) {
  assert.ok(ui.rec.fixture_home, 'Start this instance with --onboarding fresh');
  const autonomyFile = path.join(ui.rec.dispatch_dir, 'autonomy.json');
  const userSettings = () => JSON.parse(fs.readFileSync(path.join(ui.rec.user_data_dir, 'User', 'settings.json'), 'utf8'));
  await ui.attach('agents', 60000);

  // 1 agents: What's new is not on top of the wizard; Claude Code is signed out and the button signs it in
  await ui.waitFor('Agents on this Mac', { timeoutMs: 90000 });
  await ui.sleep(2500);
  assert.equal(await ui.exists({ css: '.dispatch-whats-new-card' }), false, "What's new waits for the wizard");
  if ((await text(ui)).includes('Not signed in')) {   // a rerun on the same window keeps the signed-in state
    await ui.waitFor({ aria: 'Sign in', exact: true });
    await ui.screenshot('01-sign-in');
    await ui.mark({ aria: 'Sign in', exact: true }, { what: '登录按钮', where: '向导第一屏，没登录的 Claude Code 那一行', how: '点它，浏览器里登录，回来这行变成已登录' });
    await ui.click({ aria: 'Sign in', exact: true });
    await ui.waitFor({ text: 'Signed in · Max plan' }, { timeoutMs: 90000 });
    assert.equal(await ui.exists({ aria: 'Sign in', exact: true }), false, 'the button is gone once signed in');
  }
  await ui.click({ css: '.dob-foot .dob-btn.fill' });

  // 2 agent permissions: Full auto is ticked (the user's call), each choice has one plain line on what it means
  await ui.waitFor('Agent permissions', { timeoutMs: 30000 });
  const levels = await text(ui);
  for (const want of ['Always ask', 'Ask for risky actions', 'Full auto', 'Default', 'they can also delete or overwrite things']) assert.ok(levels.includes(want), want);
  assert.ok(!/YOLO|sandbox|dangerously/i.test(levels), 'no developer words');
  assert.equal(await checked(ui, 'Full auto'), 'true', 'Full auto is the default');
  assert.equal(await checked(ui, 'Always ask'), 'false');
  await ui.screenshot('02-autonomy');
  await ui.mark('Default', { what: 'Agent 权限三选一', where: '向导第二屏', how: '默认 Full auto，下面一行写着它也能删除、覆盖文件；想稳一点点 Always ask' });
  await setSwitch(ui, 'Always ask', true);
  assert.equal(await checked(ui, 'Full auto'), 'false', 'one choice at a time');
  await setSwitch(ui, 'Full auto', true);
  assert.equal(fs.existsSync(autonomyFile), false, 'nothing is saved while the wizard is clicked through');
  await ui.click({ css: '.dob-foot .dob-btn.fill' });

  // 3 appearance: choosing changes the window at once
  await ui.waitFor('Pick how Dispatch looks', { timeoutMs: 30000 });
  const dark = () => ui.eval("!!document.querySelector('.monaco-workbench.vs-dark')");
  await setSwitch(ui, 'Dark', true);
  for (let i = 0; i < 20 && !(await dark()); i++) await ui.sleep(300);
  assert.equal(await dark(), true, 'Dark applies at once');
  await ui.screenshot('03-appearance-dark');
  await setSwitch(ui, 'Light', true);
  for (let i = 0; i < 20 && (await dark()); i++) await ui.sleep(300);
  assert.equal(await dark(), false, 'Light applies at once');
  assert.equal(await ui.eval("document.querySelectorAll('.dispatch-onboarding .dob-swatch').length"), 3, 'a preview for each');
  await ui.screenshot('03-appearance-light');
  await ui.mark('Pick how Dispatch looks', { what: '外观三选一', where: '向导第三屏', how: '点哪个窗口立刻变成哪个，左边的小图是预览' });
  await ui.click({ css: '.dob-foot .dob-btn.fill' });

  // 4 notifications and keeping the Mac awake
  await ui.waitFor('Stay in the loop', { timeoutMs: 30000 });
  const stay = await text(ui);
  assert.ok(stay.includes('Closing the lid still puts a MacBook to sleep, unless it is plugged in and connected to an external display.'));
  assert.ok(stay.includes('macOS asks to allow it: click Allow.'));
  assert.equal(await checked(ui, 'Tell me when an agent finishes or needs me'), 'false', 'banners are off until asked for');
  assert.equal(await checked(ui, 'Keep this Mac awake while an agent is working'), 'true', 'keeping the Mac awake is on by default');
  await setSwitch(ui, 'Tell me when an agent finishes or needs me', true);
  await ui.click({ text: 'Send a test notification', exact: true });
  await seen(ui, 'A banner was sent.');
  await setSwitch(ui, 'Keep this Mac awake while an agent is working', false);
  await ui.screenshot('04-notifications');
  await ui.mark('Stay in the loop', { what: '通知和不休眠', where: '向导第四屏', how: '通知默认关，点测试会弹一条；不休眠默认开，下面一句话说明合盖还是会睡' });
  await ui.click({ css: '.dob-foot .dob-btn.fill' });

  // 5 set up: the answers are saved, in this order, and What's new comes only now
  await ui.waitFor('Connect Dispatch to your agents', { timeoutMs: 30000 });
  // the plan is drawn once the CLI answered; with six agents its last note sits below the fold of the scrolling list
  await ui.waitForText('Everything is listed in Settings', { timeoutMs: 60000 });
  await ui.scrollTo('Everything is listed in Settings');
  await ui.clickWhenEnabled({ text: 'Set up Dispatch', exact: true });
  await ui.waitFor({ text: 'Saving agent permissions', exact: true }, { timeoutMs: 60000 });
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 180 && !(await ui.exists({ text: 'Start', exact: true })) && !(await ui.exists({ text: 'Retry setup', exact: true })); j++) await ui.sleep(1000);
    if (await ui.exists({ text: 'Start', exact: true })) break;
    await ui.click({ text: 'Retry setup', exact: true });
  }
  await ui.waitFor({ text: 'Start', exact: true }, { timeoutMs: 60000 });
  const stepsText = await text(ui);
  for (const want of ['Saving agent permissions', 'Turning on notifications on this Mac', 'Letting this Mac sleep as usual']) assert.ok(stepsText.includes(want), want);
  assert.equal(await ui.exists({ css: '.dispatch-whats-new-card' }), false, "What's new still waits");
  assert.deepEqual(JSON.parse(fs.readFileSync(autonomyFile, 'utf8')), { level: 'auto' });
  const approvals = userSettings()['chat.defaultConfiguration']?.approvals;
  assert.equal(approvals, 'allowAll', `new sessions in the window start with no questions: ${JSON.stringify(userSettings()['chat.defaultConfiguration'])}`);
  const saved = settings(ui);
  assert.equal(saved.notify_desktop, 1, 'banners on this Mac are on');
  assert.equal(saved.keep_awake, 0, 'keeping awake was unticked');
  await ui.screenshot('05-setup-done');
  await ui.click({ text: 'Start', exact: true });

  // 6 What's new comes now, and the way in is a new chat with the first suggestions (the Assistant's place until 2026-11-11)
  await ui.waitFor('Welcome to Dispatch', { timeoutMs: 30000 });
  await ui.screenshot('06-whats-new-after');
  await ui.press('Escape');
  await ui.waitFor({ css: '.sessions-chat-widget' }, { timeoutMs: 30000 });
  assert.ok(await ui.exists({ css: '.sessions-chat-widget, .interactive-session' }), 'a new chat page is open');
  await ui.waitFor({ css: '.new-session-prompt-option, .new-session-prompt-options-failed' }, { timeoutMs: 30000 });
  await ui.screenshot('06b-new-chat-first-suggestions');
  await ui.mark({ css: '.new-session-prompt-option' }, { what: '三张入门建议卡', where: '首次设置后落在 Chats 的新对话页', how: '点一张，问题写好；用过一次或点 × 后不再出现' });
  fs.writeFileSync(path.join(ui.out, 'after-start-text.txt'), await ui.eval('document.body.innerText'));

  // 7 the same choices in Settings (⌘,): Agents asks what agents may do on their own, Keep awake has the mode; both
  //   show what the wizard saved and write back to the same place (autonomy.json and the window's approvals; keep_awake)
  const NAV = { css: '.part.sidebar.dispatch-settings-open .dispatch-settings-nav', webview: false };
  const title = () => ui.eval(`document.querySelector('.custom-view-node[data-view-id="dispatch.settings"] .custom-view-header-title')?.textContent || ''`);
  const page = async (id, name) => {
    await ui.click({ css: `.dispatch-settings-nav .dsn-row[data-page="${id}"]`, webview: false });
    for (let i = 0; i < 50 && !(await title()).endsWith(name); i++) await ui.sleep(200);
    assert.ok((await title()).endsWith(name), `Settings shows ${await title()}, not ${name}`);
  };
  const picked = attr => ui.eval(`document.querySelector('.dset-choice[data-${attr}][aria-checked="true"]')?.dataset['${attr}'] || ''`);
  await ui.press('Cmd+,');
  await ui.waitFor(NAV, { timeoutMs: 15000 });
  await page('agents', 'Agents');
  await ui.waitFor({ css: '.dset-choice[data-autonomy][aria-checked="true"]', webview: false }, { timeoutMs: 30000 });
  assert.equal(await picked('autonomy'), 'auto', 'the Agents page shows the wizard\'s Full auto');
  assert.equal(await ui.eval("document.querySelectorAll('.dset-choice[data-autonomy]').length"), 3, 'the same three choices as the wizard');
  await ui.screenshot('07-settings-agents');
  await ui.mark({ css: '.dset-choice[data-autonomy][aria-checked="true"]', webview: false }, { what: '向导里选的 Full auto', where: '设置 › Agents，What agents may do on their own', how: '⌘, 打开设置，点 Agents' });
  await ui.click({ css: '.dset-choice[data-autonomy="ask-risky"]', webview: false });
  for (let i = 0; i < 30 && JSON.parse(fs.readFileSync(autonomyFile, 'utf8')).level !== 'ask-risky'; i++) await ui.sleep(500);
  assert.equal(JSON.parse(fs.readFileSync(autonomyFile, 'utf8')).level, 'ask-risky');
  for (let i = 0; i < 30 && userSettings()['chat.defaultConfiguration']?.approvals !== 'assisted'; i++) await ui.sleep(500);
  assert.equal(userSettings()['chat.defaultConfiguration']?.approvals, 'assisted', 'new sessions ask before risky steps');
  assert.equal(await picked('autonomy'), 'ask-risky', 'one choice at a time');
  await page('awake', 'Keep awake');
  await ui.waitFor({ css: '.dset-choice[data-awake][aria-checked="true"]', webview: false }, { timeoutMs: 30000 });
  for (let i = 0; i < 20 && (await picked('awake')) !== 'off'; i++) await ui.sleep(500);
  assert.equal(await picked('awake'), 'off', 'Keep awake shows that the wizard let the Mac sleep');
  await ui.click({ css: '.dset-choice[data-awake="system"]', webview: false });
  for (let i = 0; i < 30 && settings(ui).keep_awake !== 1; i++) await ui.sleep(500);
  assert.equal(settings(ui).keep_awake, 1);
  await ui.screenshot('08-settings-changed');
  await ui.press('Escape');
  await ui.waitFor(NAV, { gone: true, timeoutMs: 15000 });

  // 8 setup's landing is a new chat, and New afterwards goes back to the folder the person used last (the chat page picks
  //   "No workspace", which VS Code would otherwise keep for every New). A fresh Mac has no folder yet, so: a project, a
  //   new session on it, setup again from F1, Start, then New
  const proj = path.join(ui.rec.fixture_home, 'Projects', 'shop');
  fs.mkdirSync(proj, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: proj });
  fs.writeFileSync(path.join(proj, 'README.md'), '# Shop\n');
  execFileSync('git', ['add', '-A'], { cwd: proj });
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-qm', 'readme'], { cwd: proj });
  cli(ui, ['project', 'shop', '--dir', proj, '--json']);
  const pickerText = () => ui.eval(`(document.querySelector('.sessions-workspace-picker-trigger')?.innerText || '').trim()`);
  const cards = () => ui.eval(`document.querySelectorAll('.new-session-prompt-option').length`);
  await ui.click({ text: 'Projects', exact: true, within: '.agent-sessions-viewpane' });
  await ui.waitFor({ text: 'shop', exact: true, within: '.dispatch-projects-page' }, { timeoutMs: 60000 });
  await ui.click({ text: 'shop', exact: true, within: '.dispatch-projects-page' });
  await ui.sleep(1500);
  const button = await ui.eval(`(() => { const els = [...document.querySelectorAll('a, button, .monaco-button, .action-label')].filter(e => ((e.getAttribute('aria-label') || '').split(' (')[0].trim() === 'New Session' || (e.innerText || '').trim() === 'New Session')).map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.left > 400).sort((a, b) => b.left - a.left); return els[0] ? { x: els[0].left + els[0].width / 2, y: els[0].top + els[0].height / 2 } : null; })()`);
  assert.ok(button, "the project page's New Session");
  await ui.mouse('mouseMoved', button.x, button.y);
  await ui.mouse('mousePressed', button.x, button.y, { clickCount: 1 });
  await ui.mouse('mouseReleased', button.x, button.y, { clickCount: 1 });
  for (let i = 0; i < 20 && !(await pickerText()).includes('shop'); i++) await ui.sleep(500);
  const before = await pickerText();
  assert.ok(before.includes('shop'), `the new session page is on shop: ${before}`);
  await ui.screenshot('09-new-session-on-shop');
  for (let i = 0; i < 5 && !(await ui.exists({ css: '.quick-input-widget input' })); i++) { await ui.press('F1'); await ui.sleep(600); }
  await ui.type('Set Up Dispatch', { into: { css: '.quick-input-widget input' } });
  await ui.sleep(800);
  await ui.press('Enter');
  await ui.waitFor({ css: '.dispatch-onboarding' }, { timeoutMs: 30000 });
  for (let i = 0; i < 8 && !(await ui.exists('Connect Dispatch to your agents')); i++) {
    await ui.waitFor({ css: '.dob-foot .dob-btn.fill' }, { timeoutMs: 30000 });
    await ui.click({ css: '.dob-foot .dob-btn.fill' });
    await ui.sleep(900);
  }
  await ui.waitFor('Connect Dispatch to your agents', { timeoutMs: 30000 });
  await ui.waitForText('Everything is listed in Settings', { timeoutMs: 60000 });
  await ui.scrollTo('Everything is listed in Settings');
  await ui.clickWhenEnabled({ text: 'Set up Dispatch', exact: true });
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 180 && !(await ui.exists({ text: 'Start', exact: true })) && !(await ui.exists({ text: 'Retry setup', exact: true })); j++) await ui.sleep(1000);
    if (await ui.exists({ text: 'Start', exact: true })) break;
    await ui.click({ text: 'Retry setup', exact: true });
  }
  await ui.click({ text: 'Start', exact: true });
  // setup lands on a new chat again
  for (let i = 0; i < 30 && !/^Chat$|no workspace/i.test(await pickerText()); i++) await ui.sleep(500);
  const landing = await pickerText();
  assert.ok(/^Chat$|no workspace/i.test(landing), `setup lands on a new chat: ${landing}`);
  await ui.screenshot('10-setup-again-landing');
  // New: the folder from before, its page without the chat's suggestions
  await ui.newSession();
  for (let i = 0; i < 20 && !(await pickerText()).includes('shop'); i++) await ui.sleep(500);
  const after = { picker: await pickerText(), cards: await cards() };
  fs.writeFileSync(path.join(ui.out, 'new-after-setup.json'), JSON.stringify({ before, landing, after }));
  assert.ok(after.picker.includes('shop') && after.cards === 0, `New after setup goes back to shop: ${JSON.stringify(after)}`);
  await ui.screenshot('11-new-after-setup');
  await ui.mark({ css: '.sessions-workspace-picker-trigger' }, { what: '设置结束后点 New', where: '新会话页的文件夹选择', how: '回到设置前用过的 shop，不是落地页的 Chat' });
}
