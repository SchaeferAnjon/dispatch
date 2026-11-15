// The helper agents that come with Dispatch (engineer, tester, researcher, designer), on a new Mac.
// Start the instance with: dispatch ide instance start <name> --onboarding fresh --agents
//   BUILTIN_AGENTS_MINE=1  a designer of your own is in ~/.claude/agents before setup: it must stay as it is
// builtin-agents-chat.mjs is the other half: a real session hands work to two of them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

export const meta = { instance: { onboarding: 'fresh' },
  title: '内置 Agent：首次设置装上，设置 › Soul 里列出，能关能开',
  description: '新用户走完首次设置，engineer、tester、researcher、designer、teaching-master、animation-director 装进 Claude Code、Codex、OpenCode 各自的位置；已有同名的不覆盖；设置 › Soul 的 Sub-agents 卡片列出它们带开关，Sub-agents 页只列你自己的并指向 Soul；关掉文件就走，再开回来。',
  timeout: 1800,
};

const NAMES = ['animation-director', 'designer', 'engineer', 'researcher', 'teaching-master', 'tester'];
const MINE = '---\nname: designer\ndescription: My own designer, the one I wrote\nmodel: sonnet\n---\n\nMy own way of reviewing screens.\n';

const exists = p => fs.existsSync(p);
const read = p => fs.readFileSync(p, 'utf8');
async function until(ui, fn, what, ms = 60000) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await ui.sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}
const cli = (ui, args) => {
  const out = execFileSync('python3', [ui.rec.cli, ...args], {
    env: { ...process.env, HOME: ui.rec.fixture_home, BEADS_DIR: ui.rec.beads_dir, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home,
      CODEX_HOME: path.join(ui.rec.fixture_home, '.codex'), XDG_CONFIG_HOME: path.join(ui.rec.fixture_home, '.config'), CLAUDE_CONFIG_DIR: path.join(ui.rec.fixture_home, '.claude') },
    encoding: 'utf8', timeout: 60000,
  });
  return JSON.parse(out.slice(Math.min(...['{', '['].map(c => out.indexOf(c)).filter(x => x >= 0))));
};

export default async function (ui) {
  assert.ok(ui.rec.fixture_home, 'Start this instance with --onboarding fresh');
  const home = ui.rec.fixture_home;
  const mine = process.env.BUILTIN_AGENTS_MINE === '1';
  const where = {
    claude: n => path.join(ui.rec.dispatch_home, 'agents', `${n}.md`),
    codex: n => path.join(home, '.codex', 'agents', `${n}.toml`),
    opencode: n => path.join(home, '.config', 'opencode', 'agents', `${n}.md`),
  };
  const myDesigner = path.join(home, '.claude', 'agents', 'designer.md');
  if (mine) {
    fs.mkdirSync(path.dirname(myDesigner), { recursive: true });
    fs.writeFileSync(myDesigner, MINE);
  }
  for (const n of NAMES) assert.equal(exists(where.claude(n)), false, `${n} is not there before setup`);
  fs.writeFileSync(path.join(ui.out, 'before.json'), JSON.stringify({ mine, files: Object.fromEntries(Object.entries(where).map(([e, f]) => [e, NAMES.filter(n => exists(f(n)))])) }, null, 1));

  // 1 first-run setup, as a new person clicks through it
  await ui.attach('agents', 60000);
  await ui.waitFor('Agents on this Mac', { timeoutMs: 120000 });
  await ui.sleep(4000);
  for (let i = 0; i < 12 && !(await ui.exists({ text: 'Set up Dispatch', exact: true })); i++) {
    if (await ui.exists({ css: '.dob-foot .dob-btn.fill' })) await ui.click({ css: '.dob-foot .dob-btn.fill' });
    await ui.sleep(3000);
  }
  await ui.waitFor({ text: 'Set up Dispatch', exact: true }, { timeoutMs: 60000 });
  // the button only works once the plan is read (history, rules): press it until the steps start
  fs.writeFileSync(path.join(ui.out, 'connect-text.txt'), await ui.eval("document.querySelector('.dispatch-onboarding')?.innerText || ''"));
  for (let i = 0; i < 30 && !(await ui.exists({ text: "Adding Dispatch's skills and helper agents" })); i++) {
    // the button in the foot of the setup (the title bar's Set up pill has the same words)
    if (await ui.exists({ css: '.dob-foot .dob-btn.fill' })) await ui.click({ css: '.dob-foot .dob-btn.fill' });
    await ui.sleep(10000);
  }
  await ui.waitFor({ text: "Adding Dispatch's skills and helper agents" }, { timeoutMs: 60000 });
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 240 && !(await ui.exists({ text: 'Start', exact: true })) && !(await ui.exists({ text: 'Retry setup', exact: true })); j++) await ui.sleep(1000);
    if (await ui.exists({ text: 'Start', exact: true })) break;
    await ui.click({ text: 'Retry setup', exact: true });
  }
  await ui.waitFor({ text: 'Start', exact: true }, { timeoutMs: 60000 });
  const setupText = await ui.eval("document.querySelector('.dispatch-onboarding')?.innerText || ''");
  assert.ok(setupText.includes("Adding Dispatch's skills and helper agents"), 'the setup step says what it adds');
  await ui.screenshot('01-setup-done');
  await ui.mark({ text: "Adding Dispatch's skills and helper agents" }, { what: '首次设置装内置 Agent 的那一步', where: '首次设置最后一屏，Set up Dispatch 之后的步骤列表', how: '点 Set up Dispatch，这一步打勾就装好了' });

  // 2 the files: four for each engine; a designer of yours stays as it was
  for (const [engine, f] of Object.entries(where)) {
    for (const n of NAMES) assert.ok(exists(f(n)), `${engine}: ${n} installed at ${f(n)}`);
  }
  if (mine) {
    assert.equal(read(where.claude('designer')), MINE, 'your own designer is kept, not replaced by Dispatch\'s');
  } else {
    assert.match(read(where.claude('designer')), /^---\nname: designer\n/);
  }
  assert.match(read(where.codex('engineer')), /developer_instructions = /);
  assert.match(read(where.opencode('tester')), /\nmode: subagent\n/);
  const listed = cli(ui, ['builtin-agents', 'list', '--json']);
  fs.writeFileSync(path.join(ui.out, 'after-setup.json'), JSON.stringify({ files: Object.fromEntries(Object.entries(where).map(([e, f]) => [e, NAMES.filter(n => exists(f(n)))])), listed }, null, 1));
  const designerRow = listed.find(r => r.name === 'designer');
  assert.deepEqual(designerRow.yours, mine ? ['Claude Code'] : []);
  assert.ok(exists(path.join(ui.rec.dispatch_home, 'skills', 'designer', 'SKILL.md')) || mine, 'the designer skill came with it');

  await ui.click({ text: 'Start', exact: true });
  await ui.waitFor('Welcome to Dispatch', { timeoutMs: 30000 }).catch(() => {});
  await ui.press('Escape');
  await ui.sleep(4000);

  // 3 Settings > Sub-agents points to Soul; Settings > Soul lists them with a switch each (pref 内置的放 Soul)
  await ui.openCustomizations('Agents');
  await ui.waitFor({ css: '.dispatch-soul-link[data-soul-link="builtin-agents"]', webview: false }, { timeoutMs: 60000 });
  const listText = await ui.eval("document.querySelector('.ai-customization-list-widget, .aiCustomizationListWidget, .ai-customization-management-editor')?.innerText || document.body.innerText");
  fs.writeFileSync(path.join(ui.out, 'list-text.txt'), listText);
  await ui.screenshot('02a-sub-agents-link');
  await ui.click({ css: '.dispatch-soul-link[data-soul-link="builtin-agents"]', webview: false });
  const card = '.dispatch-settings-page [data-setting="builtin-agents"]';
  fs.writeFileSync(path.join(ui.out, 'sub-agents-dom.json'), await ui.eval(`JSON.stringify({ title: document.querySelector('.custom-view-node[data-view-id="dispatch.settings"] .custom-view-header-title')?.textContent, text: document.body.innerText.slice(0, 3000) })`));
  await ui.waitFor({ css: `${card} [data-dispatch-builtin-agent="engineer"]`, webview: false }, { timeoutMs: 60000 });
  const rows = () => ui.eval(`[...document.querySelectorAll('${card} [data-dispatch-builtin-agent]')].map(r => ({ name: r.dataset.dispatchBuiltinAgent, text: r.innerText, on: r.querySelector('.monaco-custom-toggle')?.getAttribute('aria-checked') }))`);
  // Settings draws what it read last (here: before setup installed them) and the fresh read a moment later: wait for it
  const before = await until(ui, async () => { const r = await rows(); return r.length === NAMES.length && r.every(x => /\b(For|Off\.|your own)\b/.test(x.text)) ? r : null; }, 'the card shows where each one is installed', 120000);
  fs.writeFileSync(path.join(ui.out, 'card.json'), JSON.stringify(before, null, 1));
  assert.deepEqual(before.map(r => r.name).sort(), NAMES);
  assert.equal(await ui.eval(`document.querySelector('${card} .dset-bi-count')?.textContent`), String(NAMES.length));
  for (const r of before) {
    assert.equal(r.on, 'true', `${r.name}: On`);
    if (r.name === 'designer' && mine) assert.ok(/your own designer is kept for Claude Code/.test(r.text), r.text);
    else assert.ok(/For Claude Code, Codex, OpenCode/.test(r.text), `${r.name}: ${r.text}`);
  }
  await ui.screenshot('02-sub-agents');
  await ui.mark({ css: card, webview: false }, { what: '内置 Agent 卡片', where: '设置 › Soul 的 Built into every agent', how: '⌘, 打开设置点 Soul（或 Sub-agents 页顶上那一行）；每个一行，右边开关' });
  if (mine) await ui.mark({ css: `${card} [data-dispatch-builtin-agent="designer"]`, webview: false }, { what: '你自己的 designer 留着', where: '内置 Agent 卡片的 designer 行', how: '第二行写着 Claude Code 用的是你自己的那份' });

  // 4 off: Dispatch's copies go, the row says Off; on again: they are back
  const toggle = `${card} [data-dispatch-builtin-agent="researcher"] .monaco-custom-toggle`;
  // the row in the middle of the page, not under the page's title bar (a mark scrolls what it marks to the top)
  const center = () => ui.eval(`document.querySelector('${toggle}')?.scrollIntoView({ block: 'center' })`);
  await center();
  await ui.click({ css: toggle, webview: false });
  await until(ui, () => !exists(where.claude('researcher')) && !exists(where.codex('researcher')) && !exists(where.opencode('researcher')), 'researcher removed from all three');
  await until(ui, async () => (await rows()).find(r => r.name === 'researcher')?.text.includes('Off.'), 'the row says Off');
  await ui.screenshot('03-researcher-off');
  await ui.mark({ css: `${card} [data-dispatch-builtin-agent="researcher"]`, webview: false }, { what: '关掉 researcher', where: 'Soul 页的 Sub-agents 卡片', how: '点开关，三个引擎里的副本都拿走，更新也不会装回来' });
  assert.equal(cli(ui, ['builtin-agents', 'sync', '--json']).files.filter(f => f.name === 'researcher').every(f => f.action === 'off'), true, 'an update keeps it off');
  await until(ui, async () => (await ui.eval(`document.querySelector('${toggle}')?.getAttribute('aria-checked')`)) === 'false', 'the switch shows off');
  await center();
  await ui.click({ css: toggle, webview: false });
  const back = () => exists(where.claude('researcher')) && exists(where.codex('researcher')) && exists(where.opencode('researcher'));
  await until(ui, back, 'researcher back in all three', 20000).catch(async () => {
    // the card was being drawn again under the pointer: the click went to the old switch
    fs.appendFileSync(path.join(ui.out, 'notes.txt'), 'second click on the On switch\n');
    await center();
    if ((await ui.eval(`document.querySelector('${toggle}')?.getAttribute('aria-checked')`)) !== 'true') await ui.click({ css: toggle, webview: false });
    await until(ui, back, 'researcher back in all three', 60000);
  });
  await until(ui, async () => (await rows()).find(r => r.name === 'researcher')?.on === 'true', 'the switch is on again');
  await ui.screenshot('04-researcher-on');
}
