// Direction A: the real controls on the five existing Customizations pages.
// No engine messages are sent. All mutable settings live inside the disposable profile; the Dispatch hooks
// are installed by first-run setup's own step (`dispatch init run agents`), not written by the test.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

export const meta = { title: 'Customizations 方向 A 各页', description: 'Overview、Instructions、Hooks、Skills 和 Migrations 的真实操作与浅深色截图；Dispatch 自带的钩子、简报和技能在设置 › Soul。' };
function put(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
// The HOME Customizations edits in this instance: the instance's own fixture HOME when it has one, else
// <instance>/customizations-home (the CLI never edits the person's real HOME from a test instance).
function fixtureHome(ui) { return ui.rec.fixture_home || path.join(ui.rec.root, 'customizations-home'); }
function env(ui) {
  return { ...process.env, DISPATCH_SESSION_ROOT: ui.rec.root, DISPATCH_HOME: ui.rec.dispatch_home,
    DISPATCH_DIR: ui.rec.dispatch_dir, BEADS_DIR: ui.rec.beads_dir, DISPATCH_FACTS_FILE: path.join(ui.rec.root, 'rules/FACTS.md') };
}
// First-run setup's own step, run on that HOME: the hooks the Hooks page shows are the ones setup really installs.
function installLikeSetup(ui, home) {
  const e = { ...env(ui), HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache') };
  const out = execFileSync('python3', [ui.rec.cli, 'init', 'run', 'agents', 'claude-code', 'codex', '--edit-guard', '--json'], { env: e, cwd: ui.demoFolder, encoding: 'utf8', timeout: 120000 });
  put(path.join(ui.out, 'init-run-agents.json'), out);
  return JSON.parse(out);
}

function cli(ui, args) {
  return JSON.parse(execFileSync('python3', [ui.rec.cli, ...args, '--json'], { env: env(ui), cwd: ui.demoFolder, encoding: 'utf8', timeout: 60000 }));
}
function seed(ui) {
  const home = fixtureHome(ui);
  const shared = '# Shared rules\n\nKeep changes focused and verify the result.\n';
  put(path.join(home, '.agents/rules/GLOBAL.md'), shared);
  put(path.join(home, '.claude/CLAUDE.md'), '# Claude Code\n\nUse concise replies.\n');
  put(path.join(home, '.codex/AGENTS.md'), '# Codex\n\nCheck the changed flow.\n');
  put(path.join(ui.rec.dispatch_home, 'rules/dispatch.md'), '# Dispatch rules\n\nTrack the task, verify the change, and deliver the result.\n');
  // the person's own settings and hook, which setup and the Hooks page must leave alone
  const settingsFile = path.join(home, '.claude/settings.json');
  if (!fs.existsSync(settingsFile)) put(settingsFile, JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo my-hook' }] }] } }, null, 2));
  const installed = installLikeSetup(ui, home);
  const listed = cli(ui, ['hooks', 'list']).groups;
  for (const agent of ['claude', 'codex']) {
    const on = listed.filter(g => g.agents[agent]?.enabled).map(g => g.id);
    assert.ok(on.includes('prime'), `setup did not install the session brief for ${agent}: ${JSON.stringify(on)} ${JSON.stringify(installed).slice(0, 300)}`);
  }
  const pool = path.join(ui.rec.dispatch_home, 'skills');
  put(path.join(pool, 'demo-review/SKILL.md'), '---\nname: demo-review\ndescription: Review a small change and explain the result.\n---\nReview the changed behavior.\n');
  const mount = path.join(home, '.claude/skills/demo-review');
  fs.mkdirSync(path.dirname(mount), { recursive: true });
  if (!fs.existsSync(mount)) fs.symlinkSync(path.join(pool, 'demo-review'), mount);
  const legacy = path.join(home, '.cc-switch/skills');
  put(path.join(legacy + '.pre-dispatch', 'kept.md'), 'Original skill pool stays recoverable.\n');
  if (!fs.existsSync(legacy)) fs.symlinkSync(pool, legacy);
  cli(ui, ['customizations', 'sync']);
  return { home, pool, legacy };
}
async function checked(ui, css) { return ui.eval(`document.querySelector(${JSON.stringify(css)})?.getAttribute('aria-checked')`); }
async function screen(ui, name) {
  await ui.sleep(600);
  const metrics = await ui.eval(`Array.from(document.querySelectorAll('.dispatch-customizations .dispatch-customization-row')).filter(e=>e.getBoundingClientRect().width).map(e=>{const r=e.getBoundingClientRect();const t=e.querySelector('.dispatch-customization-name'),d=e.querySelector('.dispatch-customization-description');return {text:t?.textContent,width:r.width,height:r.height,font:t&&getComputedStyle(t).fontSize,description:d&&getComputedStyle(d).fontSize,overflow:e.scrollWidth>e.clientWidth+2};})`);
  assert.ok(metrics.every(r => !r.overflow), 'Customizations rows must fit the available width');
  put(path.join(ui.out, `${name}-metrics.json`), JSON.stringify(metrics, null, 2));
  await ui.screenshot(name);
}

/** First-run tips (the Getting started tour) can sit over the page: close them before a picture, like a person would. */
function closeTipsBeforePictures(ui) {
  const shoot = ui.screenshot.bind(ui);
  ui.screenshot = async (...args) => {
    for (let i = 0; i < 4 && (await ui.exists({ css: ".dispatch-tour-close" })); i++) { await ui.click({ css: ".dispatch-tour-close" }); await ui.sleep(400); }
    return shoot(...args);
  };
}

export default async function (ui) {
  closeTipsBeforePictures(ui);
  const fixture = seed(ui);
  await ui.openAgents(ui.demoFolder);
  // the theme switch is in Settings › Appearance now
  await ui.setTheme('light');
  await ui.openCustomizations('Overview');
  await ui.waitFor('Installed by Dispatch', { timeoutMs: 30000 });
  await screen(ui, '01-overview-light');
  await ui.mark({ css: '.dispatch-overview' }, { what: 'Dispatch 装了什么', where: 'Find skills 页的 Installed by Dispatch', how: '一行指向 Soul，Imported 一行进 What Dispatch changed' });
  await ui.openCustomizations('Instructions');
  await ui.waitFor('Shared rules', { timeoutMs: 30000 }); // the inventory runs the CLI: slow on a busy Mac
  assert.equal(await ui.eval(`Array.from(document.querySelectorAll('.ai-customization-management-editor *')).filter(e=>e.textContent==='GLOBAL.md'&&e.getBoundingClientRect().width&&e.children.length===0).length`), 1);
  assert.equal(await ui.eval(`Array.from(document.querySelectorAll('.ai-customization-management-editor *')).filter(e=>e.textContent==='dispatch.md'&&e.getBoundingClientRect().width&&e.children.length===0).length`), 0, 'dispatch.md is on Soul, not in the list');
  assert.ok(await ui.exists({ css: '.dispatch-soul-link[data-soul-link="builtin-rules"]' }), 'Instructions points to Soul for dispatch.md');
  await ui.click({ css: '.dispatch-rule-targets summary' });
  await ui.click('Sync now');
  await ui.waitFor({ css: '.dispatch-rule-target' }, { timeoutMs: 15000 });
  assert.ok(cli(ui, ['customizations', 'list']).rules.targets.every(t => t.state === 'synced'));
  await screen(ui, '02-instructions-light');
  await ui.mark({ css: '.dispatch-rules' }, { what: '共享规则同步', where: 'Instructions 的 Shared rules', how: '展开 agent files 看各家状态，Sync now 同步托管块' });
  await ui.click({ text: 'Edit', exact: true, within: '.dispatch-rules' });
  await ui.waitFor({ css: '.ai-customization-management-editor [aria-roledescription="editor"][aria-autocomplete="both"]' });
  await ui.openCustomizations('Instructions');
  // Dispatch's hook is on Settings › Soul (pref 内置的放 Soul): Hooks keeps the person's own and a line to it
  await ui.openCustomizations('Hooks');
  await ui.waitFor({ css: '.dispatch-soul-link[data-soul-link="builtin-hooks"]' }, { timeoutMs: 30000 });
  assert.equal(await ui.exists({ css: '[data-dispatch-hook]' }), false, 'no Dispatch hook switch on the Hooks page');
  await screen(ui, '03a-hooks-yours');
  await ui.click({ css: '.dispatch-soul-link[data-soul-link="builtin-hooks"]' });
  const card = '.dispatch-settings-page [data-setting="builtin-hooks"]';
  const prime = `${card} [data-dispatch-hook="prime"] [aria-label="Claude Code: Session brief"]`;
  await ui.waitFor({ css: prime }, { timeoutMs: 30000 });
  assert.equal(await checked(ui, prime), 'true');
  // a switch saved draws the card again: it must not go blank while it reloads
  await ui.eval(`(() => { window.__e2eHooksBlank = 0; const page = document.querySelector('.dispatch-settings-page');
    new MutationObserver(() => { if (!document.querySelector('${card} [data-dispatch-hook]')) window.__e2eHooksBlank++; }).observe(page, { childList: true, subtree: true }); })()`);
  await ui.click({ css: prime });
  await ui.waitFor({ css: `${prime}[aria-checked="false"]:not([aria-disabled="true"])` }, { timeoutMs: 30000 }); // saved through the CLI: slow on a busy Mac
  assert.equal(cli(ui, ['hooks', 'list']).groups[0].agents.claude.enabled, false);
  await ui.click({ css: prime });
  await ui.waitFor({ css: `${prime}[aria-checked="true"]:not([aria-disabled="true"])` }, { timeoutMs: 30000 });
  assert.equal(cli(ui, ['hooks', 'list']).groups[0].agents.claude.enabled, true);
  // Codex has no File ownership hook: its box cannot be checked, and a click changes nothing
  const guard = `${card} [data-dispatch-hook="edit-guard"] [aria-label="Codex: File ownership"]`;
  assert.equal(await ui.eval(`document.querySelector('${guard}')?.getAttribute('aria-disabled')`), 'true', "Codex's File ownership box is disabled");
  await ui.eval(`document.querySelector('${guard}').click()`);
  await ui.sleep(1500);
  assert.equal(await checked(ui, guard), 'false');
  assert.equal(cli(ui, ['hooks', 'list']).groups.find(g => g.id === 'edit-guard').agents.codex.enabled, false);
  assert.equal(await ui.eval('window.__e2eHooksBlank'), 0, 'the hooks card never went blank while the switches were saved');
  assert.match(await ui.eval(`document.querySelector('${guard}').closest('.dset-bi-agent').title`), /no File ownership hook for Codex/);
  await ui.screenshot('03-hooks-light');
  await ui.mark({ css: card }, { what: '四组 Dispatch 钩子', where: '设置 › Soul 的 Hooks', how: '按引擎开关；每行的 If off 说明关闭后的影响' });
  const briefShow = '.dispatch-settings-page [data-setting="builtin-brief"] .dset-bi-show';
  await ui.eval(`document.querySelector('${briefShow}')?.scrollIntoView({ block: 'center' })`);
  await ui.click({ css: briefShow });
  await ui.waitFor({ css: '.dispatch-settings-page [data-setting="builtin-brief"] pre.dset-bi-text:not([hidden])' }, { timeoutMs: 60000 });
  await ui.sleep(1500);
  await ui.screenshot('04-session-brief-light');
  await ui.openCustomizations('Skills');
  await ui.waitFor({ aria: 'Codex: demo-review' }, { timeoutMs: 30000 });
  await ui.click({ aria: 'Codex: demo-review' });
  await ui.waitFor({ css: '.dispatch-skill-engines [aria-label="Codex: demo-review"][aria-pressed="true"]' });
  assert.equal(cli(ui, ['customizations', 'list']).skills.find(s => s.name === 'demo-review').agents.codex, true);
  await screen(ui, '05-skills-light');
  // Dispatch's own skills are on Soul, each opening read-only in place
  await ui.click({ css: '.dispatch-soul-link[data-soul-link="builtin-skills"]' });
  const skill = '.dispatch-settings-page [data-builtin-skill="task-board"]';
  await ui.waitFor({ css: skill }, { timeoutMs: 30000 });
  await ui.eval(`document.querySelector('${skill}').scrollIntoView({ block: 'center' })`);
  await ui.click({ css: `${skill} .dset-bi-show` });
  await ui.waitFor({ css: `${skill} + .dset-bi-body pre.dset-bi-text` }, { timeoutMs: 15000 });
  assert.match(await ui.eval(`document.querySelector('${skill} + .dset-bi-body pre.dset-bi-text').textContent`), /^---\nname: task-board/);
  await ui.screenshot('05a-builtin-readonly');
  // where a person finds it now: Settings › Abilities › More › What Dispatch changed on this Mac
  await ui.openCustomizations('Migrations');
  await ui.waitFor('Imported by Dispatch', { timeoutMs: 30000 });
  await ui.scrollTo('Imported by Dispatch');
  const receipt = cli(ui, ['imports', 'list']).find(r => r.kind === 'directory' && !r.undone);
  assert.ok(receipt, 'The seeded migration must have a reversible receipt');
  // one list of what Dispatch imported (task-qrzf): one heading, the receipt in it, no "Nothing imported yet" beside it
  await ui.waitFor({ css: `.dispatch-onboarding-migrations [data-dispatch-import="${receipt.id}"]` }, { timeoutMs: 60000 });
  const headings = await ui.eval(`[...document.querySelectorAll('h2, h3')].filter(h => h.textContent.trim() === 'Imported by Dispatch').length`);
  assert.equal(headings, 1, 'one Imported by Dispatch list');
  assert.equal(await ui.exists({ text: 'Nothing imported yet', exact: false }), false, 'no empty line while records are listed');
  await screen(ui, '06-migrations-light');
  await ui.mark({ css: `[data-dispatch-import="${receipt.id}"]` }, { what: '导入记录和撤销', where: 'Migrations 的 Imported by Dispatch', how: '逐条看 From、To，Undo 只撤销对应一项' });
  // the onboarding imports block above loads on its own (two CLI calls) and would push the receipt down mid-check
  await ui.waitFor({ css: '.dispatch-onboarding-migrations h2, .dispatch-onboarding-migrations .migration-empty' }, { timeoutMs: 60000 }).catch(() => undefined);
  await ui.sleep(500);
  // the receipt can sit below the dialog's visible part: bring it to the middle first, and make sure
  // the button is what a click there reaches (not the modal's backdrop, which closes Customizations)
  await ui.eval(`document.querySelector('[data-dispatch-import="${receipt.id}"]').scrollIntoView({ block: 'center' })`);
  await ui.sleep(400);
  const undoHit = await ui.eval(`(() => { const b = document.querySelector('[data-dispatch-import="${receipt.id}"] .monaco-button'); const r = b.getBoundingClientRect(); const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!at && (at === b || b.contains(at)); })()`);
  assert.ok(undoHit, 'The Undo button is visible and reachable before the click');
  const beforeY = await ui.eval(`document.querySelector('[data-dispatch-import="${receipt.id}"]').getBoundingClientRect().y`);
  await ui.click({ css: `[data-dispatch-import="${receipt.id}"] .monaco-button` });
  await ui.waitFor({ text: 'Undone', exact: true }, { timeoutMs: 45000 }); // the undo runs the CLI: slow on a busy Mac
  const afterY = await ui.eval(`document.querySelector('[data-dispatch-import="${receipt.id}"]').getBoundingClientRect().y`);
  assert.ok(Math.abs(beforeY-afterY)<3, 'Undo keeps the receipt in place');
  assert.equal(fs.lstatSync(fixture.legacy).isSymbolicLink(), false);
  assert.ok(fs.existsSync(path.join(fixture.legacy, 'kept.md')));
  assert.ok(fs.existsSync(path.join(fixture.pool, 'demo-review/SKILL.md')));
  await screen(ui, '07-migrations-undone');
  for (const [section, name] of [['Overview', '08-overview-dark'], ['Instructions', '09-instructions-dark'], ['Hooks', '10-hooks-dark'], ['Skills', '11-skills-dark']]) {
    if (section === 'Overview') await ui.setTheme('dark');
    await ui.openCustomizations(section);
    if (section === 'Skills') await ui.scrollTo('Built-in');
    await screen(ui, name);
  }
  // where a person finds it now: Settings › Abilities › More › What Dispatch changed on this Mac
  await ui.openCustomizations('Migrations');
  await ui.waitFor('Imported by Dispatch', { timeoutMs: 30000 });
  await ui.scrollTo('Imported by Dispatch');
  await screen(ui, '12-migrations-dark');
  const settings = JSON.parse(fs.readFileSync(path.join(fixture.home, '.claude/settings.json'), 'utf8'));
  // the person's own permission stays as it was; setup adds only Dispatch's own tools (its MCP server, dispatch_mcp.py)
  assert.deepEqual(settings.permissions, { allow: ['Read', 'mcp__dispatch'] });
  assert.ok(settings.hooks.Stop.some(g => g.hooks.some(h => h.command === 'echo my-hook')), 'the person\'s own Stop hook is kept');
  // leave the window as found: Settings closed (it holds the side bar)
  await ui.click({ css: '.dispatch-settings-nav .dsn-back', webview: false }); // ‹ Sessions
  await ui.waitFor({ css: '.part.sidebar.dispatch-settings-open .dispatch-settings-nav', webview: false }, { gone: true, timeoutMs: 10000 });
  put(path.join(ui.out, 'acceptance.json'), JSON.stringify({ hooksFromSetup: true, hookOffOn: true, skillMount: true, undoPreservesBothFolders: true, userHooksPreserved: true, fixtures: fixture }, null, 2));
}
