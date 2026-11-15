// When something goes wrong in the Changes tab, Dispatch says it in plain words and offers one button, "Let the agent
// fix it"; the commit message is written by the default agent and marked as such (kanban app/cli/fixit.py,
// Dispatch IDE patches/345-fixit.patch). Real clicks on a new session in the demo project:
//   1 a commit a project check refuses → the card, its details, the button → the agent fixes it in the chat
//   2 Commit again → "Committed “…”" and "Message written by Codex"; the commit on disk has that message, no trailer
//   3 a merge that stopped on overlapping lines → "Two changes touch the same lines" without pressing anything
//   4 a pull request whose check failed (a stand-in gh on the instance's PATH) → "A check failed on your pull request"
// The writing agent and the session's agent are Codex (no Claude quota in tests); start with: dispatch ide instance start <name>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const meta = { needs: ['codex'], timeout: 2400, title: '出错时一键让 Agent 修，提交信息由 Agent 写', description: 'Changes 页签：提交被项目检查拦下时说人话、一个按钮交给 Agent；提交信息由默认 Agent 写并标出是谁写的；冲突和失败的检查也在同一张卡里。' };

const ENGINE = process.env.FIXIT_ENGINE || 'Codex';
const WRITER = process.env.FIXIT_WRITER || 'codex';
// The scenario's own git never reads this Mac's global or system settings: a global core.hooksPath would send the
// project's hook into a folder every repository on the Mac uses (10-02 a test hook landed in ~/.git-hooks)
const E2E_ROOT = path.join(os.homedir(), 'fixit-e2e');
const GIT_GLOBAL = path.join(E2E_ROOT, 'gitconfig');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: GIT_GLOBAL, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Dispatch e2e', GIT_AUTHOR_EMAIL: 'e2e@localhost', GIT_COMMITTER_NAME: 'Dispatch e2e', GIT_COMMITTER_EMAIL: 'e2e@localhost' } }).trim();
const gitTry = (cwd, ...args) => { try { return git(cwd, ...args); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } };
const write = (file, text, mode) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); if (mode) fs.chmodSync(file, mode); };
// the card on screen (there is one in the diff and one in the list of files; only one shows at a time)
const card = ui => ui.eval(`(() => { const c = [...document.querySelectorAll('.dispatch-fix-card')].find(e => e.offsetParent && e.innerText.trim()); return c ? { cls: c.className, text: c.innerText } : null; })()`);

async function waitCard(ui, kind, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    last = await card(ui);
    if (last && last.cls.includes(`is-${kind}`) && (!label || last.text.includes(label))) return last;
    await ui.sleep(1000);
  }
  throw new Error(`the card did not become ${kind}${label ? ` (${label})` : ''} in ${timeoutMs / 1000} s; last: ${JSON.stringify(last)}`);
}

function setUpProject(demo) {
  // the project's own check: no console.log in src/, run before every commit (as husky or lint-staged would)
  write(path.join(demo, 'scripts', 'lint.sh'), [
    '#!/bin/sh',
    'bad=$(grep -n "console.log" src/*.js || true)',
    'if [ -n "$bad" ]; then',
    '  echo "eslint: no-console"',
    '  echo "$bad" | sed "s/^/  error  Unexpected console statement  /"',
    '  echo "✖ 1 problem (1 error, 0 warnings)"',
    '  exit 1',
    'fi', ''].join('\n'), 0o755);
  write(path.join(demo, 'src', 'cart.js'), 'export function total(items) {\n  let sum = 0;\n  for (const item of items) {\n    sum += item.price * item.qty;\n  }\n  return sum;\n}\n');
  git(demo, 'add', '-A');
  git(demo, 'commit', '-qm', 'feat: the cart adds up prices');
  git(demo, 'config', 'user.name', 'Dispatch e2e');
  git(demo, 'config', 'user.email', 'e2e@localhost');
  // the hook goes in this project's own .git/hooks, and the project says so in its own settings, which win over a
  // global core.hooksPath when Dispatch IDE commits; never where `git rev-parse --git-path hooks` points (that can be global)
  const hooks = path.join(demo, '.git', 'hooks');
  git(demo, 'config', 'core.hooksPath', hooks);
  assert.ok(path.resolve(hooks).startsWith(path.resolve(demo) + path.sep), hooks);
  write(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexec sh scripts/lint.sh\n', 0o755);
}


/** The test window goes off-screen as soon as it is there: it must not jump in front of the person (shared brief). */
async function offscreen(ui) {
  try {
    const { windowId } = await ui.cdp.send('Browser.getWindowForTarget', {});
    await ui.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -3000, top: -3000 } });
  } catch { /* an older Electron without the Browser domain on the page: leave it */ }
}

// The new session page on the demo project: through an editor window when the instance has one, else from the
// Projects page (a busy Mac may start the instance with the Agents window alone)
async function newSessionOn(ui, demo, name = path.basename(demo)) {
  try {
    await ui.attach('editor', 20000);
    await offscreen(ui);
    await ui.newSession(demo);
    return;
  } catch { /* no editor window */ }
  await ui.attach('agents', 120000);
  await offscreen(ui);
  for (let i = 0; i < 4 && (await ui.exists({ css: '.dispatch-tour' })); i++) { await ui.press('Escape'); await ui.sleep(500); }
  for (let i = 0; i < 3 && !(await ui.exists({ text: name, exact: true, within: '.customviewgridpart' })); i++) {
    await ui.click('Projects');
    for (let k = 0; k < 60 && !(await ui.exists({ text: name, exact: true, within: '.customviewgridpart' })); k++) await ui.sleep(1000);
  }
  await ui.click({ text: name, exact: true, within: '.customviewgridpart' });
  await ui.waitFor({ aria: 'New Session', exact: true, within: '.customviewgridpart' }, { timeoutMs: 30000 });
  await ui.click({ aria: 'New Session', exact: true, within: '.customviewgridpart' });
  await ui.sleep(2000);
}


// the first-run tips (Waiting for you, Getting started) sit over the window: close them, as a person would
async function closeTips(ui) {
  for (let i = 0; i < 4 && (await ui.exists({ css: '.dispatch-tour' })); i++) {
    if (await ui.exists({ aria: 'Close', within: '.dispatch-tour' })) await ui.click({ aria: 'Close', within: '.dispatch-tour' });
    else await ui.press('Escape');
    await ui.sleep(500);
  }
}


// the Changes tab of the side pane, opening the side pane first when it is closed (after the Projects page it is)
async function openChanges(ui) {
  await closeTips(ui);
  const tab = { css: '.tabs-container .session-changes-editor-label', webview: false };
  const paneWidth = () => ui.eval(`document.getElementById('workbench.parts.auxiliarybar')?.offsetWidth || 0`);
  if (!(await ui.exists(tab)) && !(await paneWidth())) {
    await ui.showSidePane();
    for (let k = 0; k < 60 && !(await paneWidth()); k++) await ui.sleep(500);
  }
  for (let k = 0; k < 60 && !(await ui.exists(tab)); k++) await ui.sleep(500); // a busy Mac lays the pane out slowly
  await ui.click(tab);
  await ui.sleep(1500);
  await closeTips(ui);
}

// the agent's turn is over: no Stop button, no question waiting, and the files have stopped changing. The agent asks
// before running commands outside its sandbox (reading a file is one): answer the way a person would here.
async function answerAgent(ui, answer = 'Allow') {
  if (!(await ui.eval(`document.body.innerText.includes('confirmation pending')`))) return false;
  for (const spec of [{ text: answer, exact: true, webview: false }, { aria: answer, webview: false }]) {
    try { await ui.click(spec); return true; } catch { /* the next way to find it */ }
  }
  return true;
}

async function waitAgentIdle(ui, demo, answer = 'Allow', timeoutMs = 600000) {
  const until = Date.now() + timeoutMs;
  let last = '', same = 0;
  while (Date.now() < until && same < 4) {
    await ui.sleep(3000);
    const asked = await answerAgent(ui, answer);
    const running = await ui.eval(`!![...document.querySelectorAll('[aria-label]')].find(e => e.offsetParent && /^(Stop|Cancel)\\b/.test(e.getAttribute('aria-label')))`);
    const now = gitTry(demo, 'status', '--porcelain') + gitTry(demo, 'diff');
    same = !running && !asked && now === last ? same + 1 : 0;
    last = now;
  }
}

export default async function (ui) {
  // the project lives in the home folder: Codex's sandbox does not let it work under /tmp, where the instance is
  const demo = path.join(E2E_ROOT, 'work', 'shop');
  fs.rmSync(demo, { recursive: true, force: true });
  fs.mkdirSync(demo, { recursive: true });
  write(GIT_GLOBAL, '');
  git(demo, 'init', '-q', '-b', 'main');
  write(path.join(demo, 'README.md'), '# Demo\n\nA small shop.\n');
  git(demo, 'add', '-A');
  git(demo, 'commit', '-qm', 'docs: readme');
  setUpProject(demo);
  execFileSync(process.env.DISPATCH_PYTHON || 'python3', [ui.rec.cli, 'projects-view', 'add', demo, '--name', 'shop', '--json'], {
    encoding: 'utf8', env: { ...process.env, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home, BEADS_DIR: ui.rec.beads_dir } });
  // the default agent writes: the one the instance's settings name
  write(path.join(ui.rec.dispatch_dir, 'agents.json'), JSON.stringify({ off: [], on: [], default: WRITER }));
  const fixitCache = path.join(ui.rec.dispatch_dir, 'state', 'fixit');

  await newSessionOn(ui, demo);
  await ui.sleep(2000);
  await closeTips(ui);
  await ui.pickEngine(ENGINE);
  // work in the project folder itself, not a new copy, so the Changes tab shows the uncommitted work
  if (await ui.exists({ css: '.sessions-chat-isolation-checkbox' })) {
    const checked = await ui.eval(`!!document.querySelector('.sessions-chat-isolation-checkbox .monaco-custom-toggle.checked, .sessions-chat-isolation-checkbox [aria-checked="true"]')`);
    if (checked) await ui.click({ css: '.sessions-chat-isolation-checkbox' });
  }
  // the work: the session's agent adds a discount, with a debug line the project's check refuses
  await ui.click({ text: 'What should we do?', webview: false });
  await ui.type('In src/cart.js let total() take an optional discount (0 to 1) and round the result to cents. Put the rate in a new file src/discount.js as STUDENT_DISCOUNT = 0.1. Keep a console.log("total before discount", sum) line in total() for now. Only change these two files, and do not commit.');
  await ui.press('Enter', { send: true });
  const workDone = () => fs.existsSync(path.join(demo, 'src', 'discount.js')) && /discount/.test(fs.readFileSync(path.join(demo, 'src', 'cart.js'), 'utf8'));
  for (const until = Date.now() + 600000; Date.now() < until && !workDone(); ) {
    await answerAgent(ui);
    await ui.sleep(3000);
  }
  await waitAgentIdle(ui, demo, 'Allow');
  assert.ok(workDone(), 'the agent made the change');
  if (!fs.readFileSync(path.join(demo, 'src', 'cart.js'), 'utf8').includes('console.log')) {
    // the agent left the debug line out after all: put it back, so the project's check has something to refuse
    const cart = path.join(demo, 'src', 'cart.js');
    write(cart, fs.readFileSync(cart, 'utf8').replace(/(\n\s*return )/, '\n  console.log("total before discount");$1'));
  }
  await openChanges(ui);
  await ui.waitFor({ text: 'discount.js', within: '.session-changes-editor', webview: false }, { timeoutMs: 180000 });
  await closeTips(ui);
  await ui.screenshot('01-before-commit');

  // 1 Commit: the default agent writes the message, the project's check refuses the commit. Pressed in the title bar
  // while the side pane shows Files: the Changes tab comes forward with the card (task-ljmg: nothing showed)
  await ui.openTab('Files');
  assert.equal(await card(ui), null, 'no card while Files is in front');
  await ui.click({ text: 'Commit', exact: true, webview: false });
  const writing = await card(ui);
  const problem = await waitCard(ui, 'problem', 240000);
  assert.ok(await ui.eval(`!!document.querySelector('.tabs-container .tab.active .session-changes-editor-label')`), 'the Changes tab came forward');
  assert.ok(problem.text.includes("The commit didn't go through"), problem.text);
  assert.ok(problem.text.includes('code style check before every commit'), problem.text);
  assert.ok(problem.text.includes('Let the agent fix it'), problem.text);
  const words = problem.text.split('Let the agent fix it')[0];
  assert.ok(!/\b(hook|lint|stage|index|stderr|exit code)\b/i.test(words), `plain words only: ${words}`);
  assert.equal(git(demo, 'log', '-1', '--format=%s'), 'feat: the cart adds up prices', 'nothing was committed');
  await closeTips(ui);
  await ui.screenshot('02-commit-refused');
  await ui.mark({ css: '.dispatch-fix-card' }, { what: '提交没成功：大白话说明加一个按钮', where: '右栏 Changes 页签顶部', how: '点 Commit 被项目的检查拦下时出现' });
  await ui.click({ text: 'Details', exact: true, within: '.dispatch-fix-card' });
  await ui.waitFor({ css: '.dispatch-fix-card .dfc-details.open' });
  const details = await ui.eval(`[...document.querySelectorAll('.dispatch-fix-card')].find(e => e.offsetParent && e.innerText.trim())?.querySelector('.dfc-details')?.innerText || ''`);
  assert.ok(details.includes('Unexpected console statement'), details);
  await closeTips(ui);
  await ui.screenshot('03-details');
  await ui.click({ text: 'Hide details', exact: true, within: '.dispatch-fix-card' });

  // the button: the session's agent gets everything it needs and fixes it
  await ui.click({ text: 'Let the agent fix it', within: '.dispatch-fix-card' });
  const sent = await waitCard(ui, 'sent', 30000);
  assert.ok(/is fixing it/.test(sent.text), sent.text);
  for (const until = Date.now() + 90000; Date.now() < until && !(await ui.eval(`document.body.innerText.includes('Fix the failed commit')`)); ) await ui.sleep(1000);
  assert.ok(await ui.eval(`document.body.innerText.includes('Fix the failed commit')`), 'the message reached the session');
  await closeTips(ui);
  await ui.screenshot('04-sent-to-agent');
  await ui.mark({ css: '.interactive-item-container.interactive-request' }, { what: '交给 Agent 的消息', where: '会话里', how: '点 Let the agent fix it 后自动发出，带出错输出和改动的文件' });
  const fixedBy = Date.now() + 600000;
  while (Date.now() < fixedBy && fs.readFileSync(path.join(demo, 'src', 'cart.js'), 'utf8').includes('console.log')) {
    await answerAgent(ui);
    await ui.sleep(3000);
  }
  assert.ok(!fs.readFileSync(path.join(demo, 'src', 'cart.js'), 'utf8').includes('console.log'), 'the agent removed the debug line');
  // let the agent finish its turn (its reply) before committing again
  await waitAgentIdle(ui, demo, 'Allow');
  // the card stops saying the agent is fixing it once it answered (task-mrdg: it said so long after)
  const answered = await waitCard(ui, 'fixed', 90000);
  assert.ok(!/is fixing it/.test(answered.text) && /(answered in the chat|Committed|Fixed)/.test(answered.text), answered.text);
  await ui.sleep(1000);
  await closeTips(ui);
  await ui.screenshot('05-agent-answered');

  // 2 Commit again: the agent-written message, marked as such
  await openChanges(ui);
  await ui.click({ text: 'Commit', exact: true, webview: false });
  const written = await waitCard(ui, 'written', 240000);
  const subject = git(demo, 'log', '-1', '--format=%s');
  assert.notEqual(subject, 'feat: the cart adds up prices', 'committed');
  assert.ok(written.text.includes(`Committed “${subject}”`), `${written.text} / ${subject}`);
  assert.ok(/Message written by (Codex|Claude Code|OpenCode)/.test(written.text), written.text);
  assert.ok(!/co-authored-by|signed-off-by|claude-session|generated with/i.test(git(demo, 'log', '-1', '--format=%B')), 'no AI signature in the commit');
  await closeTips(ui);
  await ui.screenshot('06-committed-written-by');
  await ui.mark({ css: '.dispatch-fix-card' }, { what: 'Agent 写的提交信息和标记', where: '右栏 Changes 页签顶部', how: '点 Commit，默认 Agent 写好提交信息直接提交，12 秒后收起' });

  // 3 a merge that stopped on the same lines: the card comes by itself
  git(demo, 'checkout', '-q', '-b', 'opening-hours', 'HEAD~1');
  write(path.join(demo, 'README.md'), '# Demo\n\nOpen Monday to Friday.\n');
  git(demo, 'commit', '-qam', 'docs: opening hours');
  git(demo, 'checkout', '-q', '-');
  write(path.join(demo, 'README.md'), '# Demo\n\nOpen every day.\n');
  git(demo, 'commit', '-qam', 'docs: open every day');
  gitTry(demo, 'merge', 'opening-hours');
  fs.rmSync(fixitCache, { recursive: true, force: true });
  const conflict = await waitCard(ui, 'problem', 90000, 'Two changes touch the same lines');
  assert.ok(conflict.text.includes('README.md changed both here'), conflict.text);
  await closeTips(ui);
  await ui.screenshot('07-conflict');
  await ui.mark({ css: '.dispatch-fix-card' }, { what: '冲突：两边改了同一处', where: '右栏 Changes 页签顶部', how: '合并停在冲突上时自动出现，按钮交给 Agent 合并' });
  git(demo, 'merge', '--abort');

  // 4 the pull request's check failed (gh answers from a stand-in on the instance's PATH)
  const gh = path.join(ui.rec.bin_dir, 'gh');
  const pr = { number: 12, title: 'Student discount', url: 'https://github.com/demo/shop/pull/12', state: 'OPEN',
    statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE', detailsUrl: 'https://github.com/demo/shop/actions/runs/77/job/1' }, { name: 'build', conclusion: 'SUCCESS' }] };
  write(gh, ['#!/bin/sh',
    'case "$1 $2" in',
    `  "pr view") echo '${JSON.stringify(pr)}' ;;`,
    `  "repo view") echo '{"owner":{"login":"demo"},"name":"shop"}' ;;`,
    `  "api graphql") echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}' ;;`,
    '  "run view") echo "FAIL cart.test.js  total() applies the discount  expected 9 received 10" ;;',
    '  *) exit 1 ;;',
    'esac', ''].join('\n'), 0o755);
  try {
    fs.rmSync(fixitCache, { recursive: true, force: true });
    const checks = await waitCard(ui, 'problem', 90000, 'A check failed on your pull request');
    assert.ok(checks.text.includes('The “test” check failed.'), checks.text);
    await ui.screenshot('08-check-failed');
    await ui.mark({ css: '.dispatch-fix-card' }, { what: 'PR 的检查没过', where: '右栏 Changes 页签顶部', how: '有 PR 且检查失败时自动出现（经 gh），按钮交给 Agent 修' });
    await ui.click({ aria: 'Close', within: '.dispatch-fix-card' });
    await ui.waitFor({ css: '.dispatch-fix-card' }, { gone: true, timeoutMs: 10000 });
  } finally {
    fs.rmSync(gh, { force: true });
  }
  return { writing: writing?.cls || '', subject: git(demo, 'log', '-1', '--format=%s') };
}
