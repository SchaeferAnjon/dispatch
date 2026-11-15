// The settings-area bugs of the 10-06 bug hunt, walked the way a new person meets them (kanban
// design/bughunt-1006; the fix-settings round). Two parts, picked by the instance:
//   a new person (this file: a fresh instance, meta.instance): the wizard with a quick
//     Continue (task-7qq8), banners on this Mac in Settings (task-3dn4), What's new (task-4z1k), the bottom
//     bar with no Builds and no motion under Motion None (task-20vu), the same sign-in words in Settings
//     (task-pb21), plain words in Abilities (task-83rs), Knowledge's side bar row on a preference (task-68ho),
//     the browser profile list (task-co9j);
//   this Mac's accounts (fix-settings-accounts.mjs: the seeded instance with the demo project): Waiting for you with one
//     item (task-ckyq), the allowance in the bottom bar and the account panel (task-pss5), an OpenCode session
//     on the cheap test model running a command in Full auto (task-l0vc) with its chip and the model menu (task-8hy0).
// Writes facts.json. The OpenCode part sends one short message to the cheap test model (GLM-5.3-Flash or a free Flash).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

export const meta = { instance: { motion: true, onboarding: 'fresh' }, title: '设置一带的 bug：新用户和本机账号两段', description: '向导快点 Continue、Mac 横幅开关、What\'s new、底栏 Builds 和减少动态、登录说法、Abilities 的人话、Knowledge 左栏、浏览器身份、Waiting 去重、额度说法、OpenCode 的 Full auto 和模型芯片。', timeout: 1500 };

const facts = {};
const save = ui => fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 1));

async function until(ui, fn, what, ms = 60000) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await ui.sleep(500);
  }
  throw new Error(`Timed out: ${what}`);
}

async function closeTips(ui) {
  for (let i = 0; i < 6 && (await ui.exists({ css: 'button.dispatch-tour-close', webview: false })); i++) {
    await ui.click({ css: 'button.dispatch-tour-close', webview: false }).catch(() => undefined);
    await ui.sleep(500);
  }
}

function cliEnv(ui) {
  const env = { ...process.env, BEADS_DIR: ui.rec.beads_dir, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home, DISPATCH_E2E_INSTANCE: ui.rec.name };
  if (ui.rec.fixture_home) env.HOME = ui.rec.fixture_home;
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE') || k.startsWith('CODEX_')) delete env[k];
  return env;
}
const cli = (ui, args) => JSON.parse(execFileSync('python3', [ui.rec.cli, ...args, '--json'], { env: cliEnv(ui), cwd: ui.rec.root, encoding: 'utf8', timeout: 60000 }));

const PAGE_TEXT = "(document.querySelector('.dispatch-settings-page')?.innerText || '')";
async function openSettings(ui) {
  if (!(await ui.exists({ css: '.dispatch-settings-nav', webview: false }))) await ui.press('Cmd+,');
  await ui.waitFor({ css: '.dispatch-settings-nav', webview: false }, { timeoutMs: 20000 });
}
async function nav(ui, page, wait) {
  await ui.click({ css: `.dispatch-settings-nav .dsn-row[data-page="${page}"]`, webview: false });
  await ui.sleep(1200);
  if (wait) await until(ui, async () => (await ui.eval(PAGE_TEXT)).includes(wait) || (await ui.eval('document.body.innerText')).includes(wait), `${page} shows ${wait}`, 30000);
}
async function closeSettings(ui) {
  for (let i = 0; i < 4 && (await ui.exists({ css: '.dispatch-settings-nav', webview: false })); i++) {
    await ui.click({ css: '.dispatch-settings-nav .dsn-back', webview: false }).catch(() => ui.press('Escape'));
    await ui.sleep(800);
  }
}

// ---------------------------------------------------------------- a new person

async function wizard(ui) {
  await ui.attach('agents', 60000);
  await ui.waitFor('Agents on this Mac', { timeoutMs: 90000 });
  // Continue at once, before the session history is read (task-7qq8): the pages that follow are asked all the same
  const titles = [];
  await ui.click({ css: '.dob-foot .dob-btn.fill' });
  const pageTitle = () => ui.eval("document.querySelector('.dispatch-onboarding h1, .dispatch-onboarding .dob-title')?.innerText || ''");
  await until(ui, async () => { const t = await pageTitle(); if (t && titles.at(-1) !== t) titles.push(t); return /Agent permissions/.test(t); }, 'the permissions page after a quick Continue', 90000);
  // the history read may finish after we got here: the page must stay
  await ui.sleep(5000);
  titles.push(await pageTitle());
  facts.wizardPages = titles;
  assert.match(titles.at(-1), /Agent permissions/, `a quick Continue left the permissions page: ${titles.join(' > ')}`);
  await ui.screenshot('a1-permissions');
  await ui.mark({ text: 'Agent permissions' }, { what: '快点 Continue 也先到权限这一屏', where: '首次设置第二屏', how: '第一屏一出来就点 Continue' });
  await ui.click({ css: '.dob-foot .dob-btn.fill' });
  await ui.waitFor('Pick how Dispatch looks', { timeoutMs: 30000 });
  await ui.click({ css: '.dob-foot .dob-btn.fill' });
  await ui.waitFor('Stay in the loop', { timeoutMs: 30000 });
  const label = 'Tell me when an agent finishes or needs me';
  for (let i = 0; i < 4 && (await ui.eval(`document.querySelector('.dispatch-onboarding [aria-label="${label}"]')?.getAttribute('aria-checked')`)) !== 'true'; i++) {
    await ui.click({ aria: label, exact: true });
    await ui.sleep(800);
  }
  await ui.click({ css: '.dob-foot .dob-btn.fill' });
  await ui.waitFor('Connect Dispatch to your agents', { timeoutMs: 30000 });
  await ui.waitFor({ text: 'Set up Dispatch', exact: true }, { timeoutMs: 60000 });
  await ui.clickWhenEnabled({ text: 'Set up Dispatch', exact: true });
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 180 && !(await ui.exists({ text: 'Start', exact: true })) && !(await ui.exists({ text: 'Retry setup', exact: true })); j++) await ui.sleep(1000);
    if (await ui.exists({ text: 'Start', exact: true })) break;
    await ui.click({ text: 'Retry setup', exact: true });
  }
  facts.notifyDesktopAfterWizard = cli(ui, ['settings']).notify_desktop;
  assert.equal(facts.notifyDesktopAfterWizard, 1, 'the wizard turned banners on');
  await ui.click({ text: 'Start', exact: true });
}

async function whatsNew(ui) {
  await ui.waitFor({ css: '.dispatch-whats-new-card', webview: false }, { timeoutMs: 60000 });
  await ui.sleep(1500);
  const card = await ui.eval(`(() => { const c = document.querySelector('.dispatch-whats-new-card'); return { head: c.querySelector('.wt')?.innerText.replace(/\\s+/g, ' '), rows: [...c.querySelectorAll('.wnrow .a')].map(a => a.textContent) }; })()`);
  facts.whatsNew = card;
  assert.match(card.head, /Welcome to Dispatch\s*5 things to try/, card.head);
  assert.deepEqual(card.rows, ['Assistant', 'Turbo', 'Next up', 'Agents in a terminal', 'Settings in one place']);
  await ui.screenshot('a2-whats-new');
  await ui.mark({ css: '.dispatch-whats-new-card .wt', webview: false }, { what: '标题下写「5 things to try」，和下面的条数对上', where: '首次设置走完弹出的 What\'s new', how: '走完首次设置自动弹出' });
  await ui.mark({ css: '.dispatch-whats-new-card .wnrows', webview: false }, { what: '这一版的五条新功能', where: '卡片中间', how: '点一条会带你去那个地方' });
  await ui.press('Escape');
  await ui.sleep(1500);
}

async function bottomBar(ui) {
  await closeTips(ui);
  const items = await ui.eval("[...document.querySelectorAll('.dispatch-status-bar .dispatch-status-item')].filter(e => !e.hidden && e.offsetParent).map(e => e.innerText.replace(/\\s+/g, ' ').trim())");
  facts.bottomBar = items;
  assert.ok(!items.some(t => /Builds/.test(t)), `a new person sees a Builds block: ${items.join(' | ')}`);
  await ui.screenshot('a3-bottom-bar');
  await ui.mark({ css: '.dispatch-status-group.right', webview: false }, { what: '底栏右边没有 Builds 方块了', where: '窗口最下面一条的右边', how: '新用户打开就是这样' });
  // Motion None in Settings (what Reduced became: Full, Less, None) stops the bar's motion: a breathing block put in
  // the bar does not breathe
  await openSettings(ui);
  await nav(ui, 'appearance', 'Animations');
  await ui.click({ text: 'None', exact: true, within: '.dispatch-settings-page' });
  await ui.sleep(1200);
  facts.reducedMotion = await ui.eval(`(() => { const bar = document.querySelector('.dispatch-status-bar'); const b = document.createElement('span'); b.className = 'dispatch-status-qb run checks'; const i = document.createElement('i'); b.appendChild(i); bar.appendChild(b); const a = getComputedStyle(i).animationName; b.remove(); return { animation: a, reduceClass: !!document.querySelector('.monaco-reduce-motion') }; })()`);
  assert.equal(facts.reducedMotion.animation, 'none', `the bar still breathes with Motion None: ${JSON.stringify(facts.reducedMotion)}`);
  await ui.click({ text: 'Like my Mac', exact: true, within: '.dispatch-settings-page' });
  await ui.sleep(800);
}

async function signInWords(ui) {
  await openSettings(ui);
  await nav(ui, 'agents', 'Agents you use');
  const agents = await ui.eval(PAGE_TEXT);
  const claude = (agents.match(/Claude Code[\s\S]*?(Signed in[^\n·]*(?:· [A-Z][a-z]+ plan)?|Not signed in)/) || [])[1] || '';
  const codex = (agents.match(/Codex[\s\S]*?(Signed in[^\n]*?ChatGPT|Signed in with an API key|Signed in|Not signed in)/) || [])[1] || '';
  await nav(ui, 'overview', 'Keep awake');
  await until(ui, async () => !(await ui.eval(PAGE_TEXT)).includes('Could not read'), 'the overview tiles', 30000).catch(() => undefined);
  await ui.sleep(2500);
  const tiles = await ui.eval("[...document.querySelectorAll('.dset-tile')].filter(t => ['account'].includes(t.dataset.page)).map(t => t.innerText.replace(/\\s+/g, ' ').trim())");
  facts.signIn = { agentsPage: { claude, codex }, overviewTiles: tiles };
  assert.ok(claude && codex, `the Agents page phrases: ${agents.slice(0, 400)}`);
  assert.ok(tiles[0].includes(claude.replace(/\s+/g, ' ')), `Overview says something else for Claude: ${tiles[0]} / ${claude}`);
  assert.ok(tiles[1].includes(codex.replace(/\s+/g, ' ')), `Overview says something else for Codex: ${tiles[1]} / ${codex}`);
  await ui.screenshot('a4-overview');
  await ui.mark({ css: '.dset-tile[data-page="account"]', webview: false }, { what: 'Overview 的 Claude 和 Codex 和 Agents 页同一种说法', where: '设置 › Overview 第一排', how: '⌘, 打开设置' });
  await nav(ui, 'account');
  await ui.sleep(2500);
  facts.accountPage = (await ui.eval(PAGE_TEXT)).slice(0, 600);
  assert.ok(!/Sign in to Claude/.test(facts.accountPage) || /Not signed in/.test(claude), `Account page asks to sign in while the Agents page says ${claude}`);
  await ui.screenshot('a5-account');
  await ui.mark({ css: '[data-sign-in="claude"]', webview: false }, { what: '已登录就写已登录，和 Agents 页一样', where: '设置 › Account and usage', how: '左栏 Account and usage' }).catch(() => undefined);
}

async function banners(ui) {
  await openSettings(ui);
  await nav(ui, 'notifications', 'On this Mac');
  const row = '[data-notify="notify_desktop"]';
  await ui.waitFor({ css: row, webview: false }, { timeoutMs: 20000 });
  const state = () => ui.eval(`document.querySelector('${row} [aria-checked]')?.getAttribute('aria-checked')`);
  facts.bannerSwitch = await state();
  assert.equal(facts.bannerSwitch, 'true', 'Settings shows the wizard\'s banners on');
  await ui.screenshot('a6-notifications');
  await ui.mark({ css: row, webview: false }, { what: 'Mac 横幅开关，和向导里是同一个', where: '设置 › Notifications 最上面 On this Mac', how: '左栏 Notifications' });
  await ui.click({ css: `${row} [aria-checked]`, webview: false });
  await until(ui, async () => cli(ui, ['settings']).notify_desktop === 0, 'banners turned off', 20000);
  facts.bannerOff = true;
  // the page draws the switch again once Dispatch has saved: click it when it shows off, as a person does
  await until(ui, async () => (await state()) === 'false', 'the switch showing off', 20000);
  await ui.sleep(500);
  await ui.click({ css: `${row} [aria-checked]`, webview: false });
  await until(ui, async () => cli(ui, ['settings']).notify_desktop === 1, 'banners turned back on', 20000);
  await nav(ui, 'overview', 'Keep awake');
  await ui.sleep(1500);
  facts.notifyTile = await ui.eval("document.querySelector('.dset-tile[data-page=\"notifications\"]')?.innerText.replace(/\\s+/g, ' ')");
  assert.match(facts.notifyTile, /Banners on this Mac/);
}

async function plainWords(ui) {
  await openSettings(ui);
  const read = async () => ui.eval("document.querySelector('.dispatch-settings-page')?.innerText || document.querySelector('.part.editor')?.innerText || ''");
  await nav(ui, 'skills', 'Skills');
  await ui.sleep(2000);
  const skills = await read();
  await ui.screenshot('a7-skills');
  await ui.mark({ text: 'Folders of instructions', webview: false }, { what: 'Skills 的说明不再提 Copilot', where: '设置 › Abilities › Skills 顶上', how: '左栏 Skills' }).catch(() => undefined);
  await nav(ui, 'plugins', 'Plugins');
  await ui.sleep(4000);
  const plugins = await read();
  await ui.screenshot('a8-plugins');
  await ui.mark({ css: '.installed-plugins-section', webview: false }, { what: '只剩这台 Mac 上的插件，Copilot 市场那 170 个不再列出', where: '设置 › Abilities › Plugins', how: '左栏 Plugins' }).catch(() => undefined);
  await nav(ui, 'hooks', 'Hooks');
  await ui.sleep(2000);
  const hooks = await read();
  // Tab completion and ⌘K are in the editor window's own Settings now (c-ui.mjs checks their words there)
  facts.plainWords = { skills: /Copilot/.test(skills), pluginsAvailable: /\bAvailable\b/.test(plugins), pluginsInstall: /\bInstall\b(?! from)/.test(plugins), hooksOld: /hooks from your settings|PostToolUse|SessionStart/.test(hooks) };
  assert.deepEqual(facts.plainWords, { skills: false, pluginsAvailable: false, pluginsInstall: false, hooksOld: false }, JSON.stringify(facts.plainWords));
}

async function knowledge(ui) {
  const store = path.join(ui.rec.dispatch_home, 'preferences.jsonl');
  if (!fs.existsSync(store) || !fs.readFileSync(store, 'utf8').trim()) {
    execFileSync('python3', [ui.rec.cli, 'prefs', 'add', 'Square toggles, not pills', '--like', '--name', 'square toggles', '--area', 'design', '--quote', 'make the switch square'], { env: cliEnv(ui), cwd: ui.rec.root, encoding: 'utf8', timeout: 60000 });
  }
  await openSettings(ui);
  await nav(ui, 'knowledge');
  await ui.waitFor({ text: 'Preferences', exact: true }, { timeoutMs: 60000 });
  await ui.click({ text: 'Preferences', exact: true });
  await ui.waitFor({ text: 'New Preference', exact: true }, { timeoutMs: 30000 });
  await ui.click({ css: '.sec .row' });
  await ui.waitFor({ text: 'Kind', exact: true }, { timeoutMs: 30000 });
  await ui.sleep(800);
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="knowledge"]', webview: false });
  await until(ui, async () => (await ui.exists({ text: 'What Dispatch knows about you' })) && !(await ui.exists({ text: 'Kind', exact: true })), 'Knowledge home after its side bar row', 20000);
  facts.knowledgeHome = true;
  await ui.screenshot('a10-knowledge');
  await ui.mark({ text: 'Knowledge', exact: true, within: '.dispatch-settings-nav', webview: false }, { what: '在偏好详情页点左栏 Knowledge 回到首页', where: '设置左栏 Abilities 下的 Knowledge', how: 'Knowledge › Preferences › 点一条，再点左栏 Knowledge' });
  await closeSettings(ui);
}

async function browserProfile(ui) {
  await closeSettings(ui);
  await ui.sleep(2500);
  // setup lands on a new chat (no folder, no side pane tabs, 2026-11-11), and a fresh Mac has no folder for New to go
  // back to: a project, and a new session on it from its own page, the way a person picks one
  if (!(await ui.exists('Add Tab'))) {
    const folder = path.join(ui.rec.root, 'browser-profile');
    fs.mkdirSync(folder, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: folder });
    fs.writeFileSync(path.join(folder, 'README.md'), '# Browser profile\n');
    execFileSync('git', ['add', '-A'], { cwd: folder });
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-qm', 'readme'], { cwd: folder });
    cli(ui, ['project', 'browser-profile', '--dir', folder]);
    await ui.click({ text: 'Projects', exact: true, within: '.agent-sessions-viewpane' });
    await ui.waitFor({ text: 'browser-profile', exact: true, within: '.dispatch-projects-page' }, { timeoutMs: 60000 });
    await ui.click({ text: 'browser-profile', exact: true, within: '.dispatch-projects-page' });
    await ui.sleep(1500);
    const button = await ui.eval(`(() => { const els = [...document.querySelectorAll('a, button, .monaco-button, .action-label')].filter(e => ((e.getAttribute('aria-label') || '').split(' (')[0].trim() === 'New Session' || (e.innerText || '').trim() === 'New Session')).map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.left > 400).sort((a, b) => b.left - a.left); return els[0] ? { x: els[0].left + els[0].width / 2, y: els[0].top + els[0].height / 2 } : null; })()`);
    assert.ok(button, "the project page's New Session");
    await ui.mouse('mouseMoved', button.x, button.y);
    await ui.mouse('mousePressed', button.x, button.y, { clickCount: 1 });
    await ui.mouse('mouseReleased', button.x, button.y, { clickCount: 1 });
    const picker = () => ui.eval(`(document.querySelector('.sessions-workspace-picker-trigger')?.innerText || '').trim()`);
    for (let i = 0; i < 20 && !(await picker()).includes('browser-profile'); i++) await ui.sleep(500);
    assert.ok((await picker()).includes('browser-profile'), `the new session page is on the project: ${await picker()}`);
  }
  // a new person's side pane starts closed: open it the way a person does, with the title bar's toggle
  if (!(await ui.exists('Add Tab'))) {
    await ui.click({ css: '.action-label.codicon-agent-secondary-sidebar-toggle-closed', webview: false }).catch(() => undefined);
    await ui.waitFor('Add Tab', { timeoutMs: 15000 });
  }
  await ui.click('Add Tab');
  await ui.sleep(800);
  await ui.click({ text: 'Browser', exact: true, within: '.context-view, .monaco-menu-container, .quick-input-widget' });
  await ui.waitFor({ aria: 'Browser profile: Default', exact: true }, { timeoutMs: 20000 });
  await ui.sleep(1500);
  const t0 = Date.now();
  await ui.click({ aria: 'Browser profile: Default', exact: true });
  const SAMPLE = `(() => { const w = [...document.querySelectorAll('.quick-input-widget')].find(x => x.offsetParent); return w ? w.innerText.replace(/\\s+/g, ' ').slice(0, 160) : ''; })()`;
  const samples = [];
  let first = '';
  for (let i = 0; i < 30; i++) {
    const s = await ui.eval(SAMPLE);
    samples.push([Date.now() - t0, s]);
    if (/Browser profile/.test(s) && /Default/.test(s)) { first = s; break; }
    await ui.sleep(100);
  }
  facts.profilePicker = { first, ms: samples.at(-1)[0], zeroResults: samples.some(([, s]) => /^0 Results/.test(s)) };
  assert.ok(first, `the profile list did not come: ${JSON.stringify(samples.slice(-3))}`);
  assert.equal(facts.profilePicker.zeroResults, false, 'it showed 0 Results first');
  await ui.sleep(600);
  await ui.screenshot('a11-profile');
  await ui.mark({ css: '.quick-input-widget', webview: false }, { what: '一点就出身份列表，不再先空着写 0 Results', where: '右栏 Browser 页签地址栏左边的人像', how: '右栏 + › Browser，点地址栏左边的人像' });
  await ui.press('Escape');
}

// ---------------------------------------------------------------- this Mac's accounts

const fresh = '.sessions-chat-editor';

async function waiting(ui) {
  await ui.openAgents(ui.demoFolder);
  await closeTips(ui);
  await ui.click({ css: '.dispatch-waiting-section', webview: false });
  await ui.waitFor({ css: '.dispatch-waiting-page', webview: false }, { timeoutMs: 30000 });
  // 2026-11-11 direction A: one row per thing, three columns, no project rows; a title still shows once
  await ui.waitFor({ css: '.dispatch-waiting-page .dispatch-waiting-row', webview: false }, { timeoutMs: 60000 });
  await ui.sleep(1500);
  const page = await ui.eval("document.querySelector('.dispatch-waiting-page').innerText");
  const titles = await ui.eval("[...document.querySelectorAll('.dispatch-waiting-page .dispatch-waiting-row .dispatch-waiting-title')].map(e => e.textContent.trim()).filter(Boolean)");
  facts.waiting = { titles };
  for (const t of titles) {
    assert.equal(page.split(t).length - 1, 1, `"${t}" shows more than once on the page`);
  }
  await ui.screenshot('b1-waiting');
  await ui.mark({ css: '.dispatch-waiting-page .dispatch-waiting-row', webview: false }, { what: '一件事一行：标题、项目、要你做什么、多久，标题只出现一次', where: 'Waiting for you 页', how: '左栏 Waiting for you' }).catch(() => undefined);
}

async function allowance(ui) {
  await closeTips(ui);
  await ui.sleep(5000); // the accounts are asked a moment after the window opens
  const items = await ui.eval("[...document.querySelectorAll('.dispatch-status-bar [data-part^=\"allowance-\"]')].filter(e => !e.hidden && e.offsetParent).map(e => ({ part: e.dataset.part, text: e.innerText.replace(/\\s+/g, ' ').trim(), aria: e.getAttribute('aria-label') || '' }))");
  facts.allowance = items;
  for (const it of items) {
    assert.ok(!/% left/.test(it.text + it.aria), `the bottom bar still says left: ${JSON.stringify(it)}`);
  }
  const withNumbers = items.filter(it => /%/.test(it.aria));
  if (withNumbers.length) {
    assert.ok(withNumbers.every(it => /% used/.test(it.aria)), JSON.stringify(withNumbers));
    assert.ok(withNumbers.some(it => /resets/.test(it.text + it.aria)), 'no reset time at the bottom');
  }
  await ui.screenshot('b2-bottom-bar');
  await ui.mark({ css: '.dispatch-status-bar [data-part^="allowance-"]', webview: false }, { what: '底栏额度写「用了多少」并带重置时间，和头像面板一个说法', where: '窗口最下面一条的右边', how: '悬停看每个窗口的用量和重置时间' }).catch(() => undefined);
  // the account panel from the title bar: the same words
  const avatar = { css: '.sessions-account-titlebar-widget', webview: false };
  if (await ui.exists(avatar)) {
    await ui.click(avatar).catch(() => undefined);
    await ui.sleep(2500);
    facts.accountPanel = (await ui.eval("document.querySelector('.sessions-account-titlebar-panel')?.innerText || ''")).replace(/\s+/g, ' ').slice(0, 600);
    if (facts.accountPanel) {
      assert.ok(!/% left/.test(facts.accountPanel), facts.accountPanel);
      await ui.screenshot('b3-account-panel');
      await ui.mark({ css: '.sessions-account-titlebar-panel', webview: false }, { what: '头像面板：Used 一列和重置时间', where: '标题栏右上角头像', how: '点头像' }).catch(() => undefined);
    }
    await ui.press('Escape');
  }
}

async function newSession(ui) {
  const name = ui.demoFolder.split('/').filter(Boolean).at(-1);
  for (let attempt = 0; attempt < 4; attempt++) {
    await closeTips(ui);
    await ui.click('Projects');
    try { await ui.waitFor({ text: name, exact: true, within: '.dispatch-projects-page' }, { timeoutMs: 45000 }); break; } catch (e) { if (attempt >= 3) throw e; }
  }
  const pageButton = (label) => ui.eval(`(() => {
    const els = [...document.querySelectorAll('a, button, .monaco-button, .action-label')]
      .filter(e => ((e.getAttribute('aria-label') || '').split(' (')[0].trim() === ${JSON.stringify(label)} || (e.innerText || '').trim() === ${JSON.stringify(label)}))
      .map(e => ({ r: e.getBoundingClientRect() })).filter(x => x.r.width > 0 && x.r.left > 400)
      .sort((a, b) => b.r.left - a.r.left);
    return els[0] ? { x: els[0].r.left + els[0].r.width / 2, y: els[0].r.top + els[0].r.height / 2 } : null;
  })()`);
  const press = async (b) => { await ui.mouse('mouseMoved', b.x, b.y); await ui.mouse('mousePressed', b.x, b.y, { clickCount: 1 }); await ui.mouse('mouseReleased', b.x, b.y, { clickCount: 1 }); };
  try { await ui.click({ text: name, exact: true, within: '.dispatch-projects-page' }); } catch { /* open already */ }
  await until(ui, async () => (await pageButton('New Session')) || (await pageButton('Add as Project')), 'the project page buttons', 30000);
  if (!(await pageButton('New Session'))) await press(await pageButton('Add as Project'));
  await press(await until(ui, async () => pageButton('New Session'), 'New Session', 60000));
  await until(ui, async () => ui.eval(`!!document.querySelector('.sessions-chat-session-type-picker')`), 'a new session page', 60000);
}

async function focusInput(ui) {
  // the new session page's box, or a running session's box once the first message went
  const box = (await ui.exists({ css: fresh, webview: false })) ? fresh : '.interactive-input-part .monaco-editor';
  for (let i = 0; i < 8; i++) {
    await ui.click({ css: i % 2 ? `${box} .view-lines` : box, webview: false });
    await ui.sleep(400);
    if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('${box}')`)) return;
    await ui.sleep(800);
  }
  throw new Error('The message box does not take the focus');
}

const chip = (ui) => ui.eval("(() => { const m = document.querySelector('.interactive-input-part .model-picker-item, .sessions-chat-editor .model-picker-item, [aria-label^=\"Models,\"]'); return m ? (m.getAttribute('aria-label') || m.innerText).replace(/\\s+/g, ' ').trim() : ''; })()");

async function opencode(ui) {
  await newSession(ui);
  await ui.pickEngine('OpenCode', 360000);
  facts.permissionLabel = await ui.eval("(() => { const p = document.querySelector('.sessions-chat-permission-picker'); return p ? ((p.querySelector('[aria-label]')?.getAttribute('aria-label') || '') + ' ' + p.innerText).replace(/\\s+/g, ' ').trim() : ''; })()");
  await focusInput(ui);
  await ui.type('/model');
  await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 30000 });
  // the cheap test model this Mac has (GLM-5.3-Flash with the Zhipu plan, else DeepSeek Flash, else a free Flash)
  const model = await until(ui, async () => ui.cheapModel(await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => ({ name: r.querySelector('.dsm-name')?.textContent || '', desc: r.querySelector('.dsm-desc')?.textContent || '' }))`)), 'a cheap test model in the menu', 30000);
  facts.model = model;
  await ui.click({ text: model.name, exact: true, within: '.dispatch-slash-menu' });
  await ui.press('Escape');
  await ui.sleep(800);
  const word = model.name.split(/[\s-]/)[0];   // what the chip and a search in the menu go by: GLM, DeepSeek, MiMo
  facts.chipBefore = await chip(ui);
  await focusInput(ui);
  facts.permissionAtSend = await ui.eval("(() => { const p = document.querySelector('.sessions-chat-permission-picker'); return p ? ((p.querySelector('[aria-label]')?.getAttribute('aria-label') || '') + ' ' + p.innerText).replace(/\\s+/g, ' ').trim() : ''; })()");
  // commands that change something: the ones OpenCode asked about in Full auto (git config, as in the bug hunt)
  await ui.type('In the terminal run git config user.name "Fix Settings Test" and then git config --get user.name, then reply DONE and nothing else.');
  await ui.press('Enter', { send: true });
  let asked = false;
  const lastResponse = `(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return r ? r.innerText : ''; })()`;
  await until(ui, async () => {
    const ask = await ui.eval(`[...document.querySelectorAll('.interactive-session button, .chat-confirmation-widget button, .chat-tool-confirmation-carousel-container button')].filter(b => b.offsetParent).map(b => b.innerText.trim()).find(t => /^(Allow|Allow once|Approve|Skip)$/i.test(t)) || ''`);
    if (ask) { asked = true; facts.askedText = await ui.eval(lastResponse); await ui.screenshot('b4-asked'); await ui.click({ text: 'Allow', exact: true }).catch(() => undefined); }
    const t = await ui.eval(lastResponse);
    if (/401|unauthori[sz]ed|quota|insufficient balance/i.test(t)) throw new Error(`The test model failed: ${t.slice(0, 200)}`);
    return ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return !!r && !r.classList.contains('chat-response-loading') && /DONE/.test(r.innerText); })()`);
  }, 'the OpenCode turn', 300000);
  facts.askedInFullAuto = asked;
  facts.reply = (await ui.eval(lastResponse)).slice(0, 600);
  facts.chipAfter = await chip(ui);
  await ui.sleep(20000); // the model list is read again after a session starts: give it time to drop a provider, if it would
  facts.chipLater = await chip(ui);
  await ui.screenshot('b5-opencode');
  await ui.mark({ css: '.interactive-input-part .model-picker-item', webview: false }, { what: '发完以后芯片还是选的那个模型', where: '输入框下面的模型芯片', how: '选便宜模型发一句' }).catch(() => undefined);
  await ui.mark({ css: '.interactive-response:last-of-type', webview: false }, { what: 'Full auto 下跑 git 命令不弹确认', where: '会话里这一轮回复', how: '设置里默认 Full auto' }).catch(() => undefined);
  // the model menu still lists the model's provider
  await focusInput(ui);
  await ui.type('/' + word);
  await ui.sleep(2500);
  facts.menuAfter = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row .dsm-name')].map(n => n.textContent).slice(0, 12)`);
  const typed2 = async () => ui.eval(`document.querySelector('.interactive-input-part .view-lines, ${fresh} .view-lines')?.textContent || ''`);
  for (let i = 0; i < 10 && (await typed2()).trim(); i++) await ui.press('Backspace');
  assert.ok(facts.chipAfter.includes(word) && facts.chipLater.includes(word), `the chip is not ${model.name}: ${facts.chipAfter} / ${facts.chipLater}`);
  assert.ok(facts.menuAfter.includes(model.name), `${model.name} is gone from the menu: ${facts.menuAfter.join(', ')}`);
  assert.equal(asked, false, `OpenCode asked in Full auto: ${facts.permissionLabel}`);
  assert.match(facts.permissionAtSend, /Full auto/, `the chat is not at Full auto: ${facts.permissionAtSend}`);
}

export default async function (ui) {
  try {
    if (ui.rec.fixture_home && process.env.FIX_SETTINGS_ONLY === 'browser') {
      await browserProfile(ui);
    } else if (ui.rec.fixture_home) {
      await wizard(ui);
      await whatsNew(ui);
      await bottomBar(ui);
      await banners(ui);
      await signInWords(ui);
      await plainWords(ui);
      await knowledge(ui);
      await browserProfile(ui);
    } else {
      await waiting(ui);
      await allowance(ui);
      if (process.env.FIX_SETTINGS_OPENCODE !== '0') await opencode(ui);
    }
  } finally {
    save(ui);
  }
}
