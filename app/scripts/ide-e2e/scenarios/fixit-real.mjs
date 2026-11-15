// The Changes tab's card with nothing faked (kanban task-sf8ry, app/cli/fixit.py, Dispatch IDE
// patches/345-fixit.patch and 345-fixit.patch). Three real paths:
//   1 a push the server refuses: the project's remote is a bare repository on this Mac whose server-side check takes
//     changes to main only through a pull request; Sync → "This branch only takes changes through a pull request" →
//     Let the agent fix it → the agent puts the work on its own branch and sends that
//   2 a pull request whose check failed, read by the real gh from GitHub: a clone of a public repository on the
//     branch of an open pull request with a failed check → the card comes by itself, Details has the check's log
//   3 Create PR on a new branch of that clone: the form fills in a title and a description the default agent wrote,
//     says who wrote it, and the person can change them; nothing is sent (the repository is not ours)
// Needs gh signed in on this Mac (paths 2 and 3) and Codex (the session's agent and the writer).
//   FIXIT_REAL_PR=owner/repo#number   the pull request to read (default: the first open one found with a failed check)
//   FIXIT_REAL_PARTS=push,checks,pr   which parts to walk
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const meta = { needs: ['codex'], timeout: 2400, title: '一键修真跑：推送被拒、PR 检查失败、Agent 写 PR', description: '本地裸仓库当远端，推到 main 被服务器拒绝，卡片说人话、交给 Agent 修；真 gh 读一个公开仓库里检查失败的 PR，卡片自己出来；新分支上 Create PR，Agent 写标题和描述，用户能改。' };

const ENGINE = process.env.FIXIT_ENGINE || 'Codex';
const WRITER = process.env.FIXIT_WRITER || 'codex';
const ghReady = () => { try { execFileSync(['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(p => fs.existsSync(p)) || 'gh', ['auth', 'status'], { stdio: 'ignore', timeout: 20000 }); return true; } catch { return false; } };
// the GitHub parts only where gh is signed in (a Mac without it walks the push alone)
const PARTS = new Set((process.env.FIXIT_REAL_PARTS || (ghReady() ? 'push,checks,pr' : 'push')).split(',').map(s => s.trim()));
const E2E_ROOT = path.join(os.homedir(), 'fixit-e2e');
const GIT_GLOBAL = path.join(E2E_ROOT, 'gitconfig');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: GIT_GLOBAL, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Dispatch e2e', GIT_AUTHOR_EMAIL: 'e2e@localhost', GIT_COMMITTER_NAME: 'Dispatch e2e', GIT_COMMITTER_EMAIL: 'e2e@localhost' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();
const gitTry = (cwd, ...args) => { try { return git(cwd, ...args); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } };
const write = (file, text, mode) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); if (mode) fs.chmodSync(file, mode); };
const ghBin = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(p => fs.existsSync(p)) || 'gh';
const gh = (cwd, ...args) => execFileSync(ghBin, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, timeout: 180000 }).trim();
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

function cli(ui, ...args) {
  return execFileSync(process.env.DISPATCH_PYTHON || 'python3', [ui.rec.cli, ...args], {
    encoding: 'utf8', env: { ...process.env, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home, BEADS_DIR: ui.rec.beads_dir } });
}

async function closeTips(ui) {
  for (let i = 0; i < 4 && (await ui.exists({ css: '.dispatch-tour' })); i++) {
    if (await ui.exists({ aria: 'Close', within: '.dispatch-tour' })) await ui.click({ aria: 'Close', within: '.dispatch-tour' });
    else await ui.press('Escape');
    await ui.sleep(500);
  }
}

async function openChanges(ui) {
  await closeTips(ui);
  const tab = { css: '.tabs-container .session-changes-editor-label', webview: false };
  const paneWidth = () => ui.eval(`document.getElementById('workbench.parts.auxiliarybar')?.offsetWidth || 0`);
  if (!(await ui.exists(tab)) && !(await paneWidth())) {
    await ui.showSidePane();
    for (let k = 0; k < 60 && !(await paneWidth()); k++) await ui.sleep(500);
  }
  for (let k = 0; k < 30 && !(await ui.exists(tab)); k++) await ui.sleep(500);
  // a narrow side pane shows the changed files without its tab strip: that is the Changes tab already
  if (await ui.exists(tab)) await ui.click(tab);
  await ui.sleep(1500);
  await closeTips(ui);
}

async function answerAgent(ui, answer = 'Allow') {
  if (!(await ui.eval(`document.body.innerText.includes('confirmation pending')`))) return false;
  for (const spec of [{ text: answer, exact: true, webview: false }, { aria: answer, webview: false }]) {
    try { await ui.click(spec); return true; } catch { /* the next way to find it */ }
  }
  return true;
}

/** A new session on the folder (the Projects page, as a person finds a project), one short turn so it exists. */
async function sessionOn(ui, folder, name, copy = false, fullAccess = false) {
  cli(ui, 'projects-view', 'add', folder, '--name', name, '--json');
  await ui.attach('agents', 30000).catch(() => ui.openAgents());
  await closeTips(ui);
  for (let i = 0; i < 3 && !(await ui.exists({ text: name, exact: true, within: '.customviewgridpart' })); i++) {
    await ui.click('Projects');
    for (let k = 0; k < 60 && !(await ui.exists({ text: name, exact: true, within: '.customviewgridpart' })); k++) await ui.sleep(1000);
  }
  await ui.click({ text: name, exact: true, within: '.customviewgridpart' });
  await ui.waitFor({ aria: 'New Session', exact: true, within: '.customviewgridpart' }, { timeoutMs: 30000 });
  await ui.click({ aria: 'New Session', exact: true, within: '.customviewgridpart' });
  await ui.sleep(2500);
  await closeTips(ui);
  await ui.pickEngine(ENGINE);
  if (await ui.exists({ css: '.sessions-chat-isolation-checkbox' })) {
    const on = await ui.eval(`!!document.querySelector('.sessions-chat-isolation-checkbox .monaco-custom-toggle.checked, .sessions-chat-isolation-checkbox [aria-checked="true"]')`);
    if (on !== copy) await ui.click({ css: '.sessions-chat-isolation-checkbox' });
  }
  if (fullAccess) {
    // the fix sends work to a server outside the project folder: the agent may do that without asking (a person
    // would pick this for a project of their own; the default asks first)
    try {
      await ui.click({ text: 'Ask for risky actions', webview: false });
      await ui.sleep(600);
      await ui.click({ text: 'Full auto', webview: false });
      await ui.sleep(600);
    } catch { /* the picker reads differently: keep the default */ }
  }
  await closeTips(ui);
  // the box may still hold a draft from before: empty it
  await ui.click({ css: '.sessions-chat-editor', webview: false });
  await ui.press('End');
  for (let i = 0; i < 200 && (await ui.eval(`(document.querySelector('.sessions-chat-editor .view-lines')?.innerText || '').replace(/\u00a0/g, ' ').trim()`)).length; i++) await ui.press('Backspace');
  await typeIn(ui, '.sessions-chat-editor', 'Reply with exactly: READY. Do not run anything.');
  await closeTips(ui);
  await ui.press('Enter', { send: true });
  await ui.sleep(3000);
  // a tip that came up over the box can take the Enter: send with the button then
  if (await ui.eval(`(document.querySelector('.sessions-chat-editor .view-lines')?.innerText || '').includes('READY')`)) {
    await closeTips(ui);
    await ui.click({ aria: 'Send', webview: false }).catch(() => ui.press('Enter', { send: true }));
  }
  for (const until = Date.now() + 240000; Date.now() < until; await ui.sleep(2000)) {
    await answerAgent(ui);
    if (await ui.eval(`[...document.querySelectorAll('.interactive-response')].some(r => r.innerText.includes('READY') && !r.classList.contains('chat-response-loading'))`)) return;
  }
  throw new Error('the session did not answer READY');
}

/** An open pull request on GitHub with a failed check (the real gh reads it). */
function findFailingPr() {
  const named = process.env.FIXIT_REAL_PR;
  const candidates = named ? [named] : ['supabase/supautils#237'];
  const failed = (repo, n) => {
    try {
      const pr = JSON.parse(execFileSync(ghBin, ['pr', 'view', n, '--repo', repo, '--json', 'state,statusCheckRollup'], { encoding: 'utf8' }));
      return pr.state === 'OPEN' && (pr.statusCheckRollup || []).some(c => /FAILURE|failure/.test(c.conclusion || c.state || ''));
    } catch { return false; }
  };
  for (const c of candidates) {
    const [repo, n] = c.split('#');
    if (failed(repo, n)) return { repo, number: n };
  }
  const found = JSON.parse(execFileSync(ghBin, ['search', 'prs', '--state', 'open', '--checks', 'failure', '--limit', '30', '--json', 'repository,number', '--', 'fix'], { encoding: 'utf8' }));
  for (const p of found) {
    const repo = p.repository.nameWithOwner;
    let size = 1e9;
    try { size = JSON.parse(execFileSync(ghBin, ['repo', 'view', repo, '--json', 'diskUsage'], { encoding: 'utf8' })).diskUsage; } catch { /* next */ }
    if (size < 20000 && failed(repo, String(p.number))) return { repo, number: String(p.number) };
  }
  throw new Error('no open pull request with a failed check to read');
}

/** Types into a box, putting the keyboard back in it first when a tip that came up took it away. */
async function typeIn(ui, css, text) {
  for (let i = 0; ; i++) {
    try {
      if (i) {
        for (let k = 0; k < 4 && (await ui.exists({ css: ".dispatch-tour", webview: false })); k++) {
          await ui.click({ css: ".dispatch-tour-head button", webview: false }).catch(() => ui.press("Escape"));
          await ui.sleep(500);
        }
        await ui.click({ css, webview: false });
      }
      await ui.type(text);
      return;
    } catch (e) {
      if (i >= 3) throw e;
      await ui.sleep(1500);
    }
  }
}

export default async function (ui) {
  const facts = {};
  write(GIT_GLOBAL, '');
  write(path.join(ui.rec.dispatch_dir, 'agents.json'), JSON.stringify({ off: [], on: [], default: WRITER }));

  // ---- 1 a push the server refuses ----------------------------------------------------------------------------
  if (PARTS.has('push')) {
    // a new folder each run: the Agents window keeps watching a project folder it has seen, and one deleted and made
    // again at the same place is not watched any more
    fs.rmSync(path.join(E2E_ROOT, 'push'), { recursive: true, force: true });
    const work = path.join(E2E_ROOT, 'push', Date.now().toString(36));
    fs.mkdirSync(work, { recursive: true });
    const remote = path.join(work, 'server.git');
    const repo = path.join(work, `garden-${path.basename(work)}`);
    git(work, 'init', '-q', '--bare', remote);
    // the server's own check (as GitHub's branch protection): main takes changes only through a pull request
    write(path.join(remote, 'hooks', 'pre-receive'), ['#!/bin/sh', 'while read old new ref; do',
      '  if [ "$ref" = "refs/heads/main" ] && [ "$old" != "0000000000000000000000000000000000000000" ]; then',
      '    echo "error: GH006: Protected branch update failed for refs/heads/main." >&2',
      '    echo "error: Changes must be made through a pull request." >&2', '    exit 1', '  fi', 'done', ''].join('\n'), 0o755);
    // the server's own setting wins over a global core.hooksPath of this Mac's user (the push runs as that user)
    git(remote, 'config', 'core.hooksPath', path.join(remote, 'hooks'));
    git(work, 'init', '-q', '-b', 'main', repo);
    git(repo, 'config', 'user.name', 'Dispatch e2e');
    git(repo, 'config', 'user.email', 'e2e@localhost');
    write(path.join(repo, 'README.md'), '# Garden\n\nWhat grows where.\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'docs: readme');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'main'); // the first push makes main; after that it is protected
    // a session there; the person commits, then Sync
    // the default permissions a person gets: the agent asks before sending outside the project, the run allows it
    await sessionOn(ui, repo, `garden-${path.basename(work)}`);
    write(path.join(repo, 'plants.md'), '- tomatoes: south bed\n- basil: pots\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'docs: where the plants go');
    await openChanges(ui);
    for (let i = 0; i < 240 && !(await ui.eval(`[...document.querySelectorAll('.monaco-button, .monaco-text-button, a.action-label')].some(b => b.offsetParent && /^(Sync|Push)/.test((b.innerText || b.getAttribute('aria-label') || '').trim()))`)); i++) await ui.sleep(1000);
    facts.syncLabel = await ui.eval(`[...document.querySelectorAll('.monaco-button, .monaco-text-button, a.action-label')].filter(b => b.offsetParent).map(b => (b.innerText || b.getAttribute('aria-label') || '').trim()).filter(t => /^(Sync|Push)/.test(t))`);
    assert.ok(facts.syncLabel.length, 'no Sync button in the Changes tab');
    await ui.click({ text: facts.syncLabel[0], exact: true, webview: false });
    const refused = await waitCard(ui, 'problem', 120000, 'only takes changes through a pull request');
    facts.pushCard = refused.text;
    assert.ok(/Your work is safe here/.test(refused.text), refused.text);
    assert.ok(!/\b(hook|pre-receive|stderr|exit code|GH006)\b/i.test(refused.text.split('Let the agent fix it')[0]), `plain words: ${refused.text}`);
    assert.equal(gitTry(remote, 'log', '-1', '--format=%s', 'main'), 'docs: readme', 'the server kept main as it was');
    await ui.screenshot('01-push-refused');
    await ui.mark({ css: '.dispatch-fix-card' }, { what: '推送被服务器拒了：说人话加一个按钮', where: '右栏 Changes 页签顶部', how: '点 Sync 推不上去时出现' });
    await ui.click({ text: 'Details', exact: true, within: '.dispatch-fix-card' });
    await ui.waitFor({ css: '.dispatch-fix-card .dfc-details.open' });
    facts.pushDetails = await ui.eval(`[...document.querySelectorAll('.dispatch-fix-card')].find(e => e.offsetParent)?.querySelector('.dfc-details')?.innerText || ''`);
    assert.ok(/Protected branch update failed/.test(facts.pushDetails), facts.pushDetails);
    await ui.click({ text: 'Hide details', exact: true, within: '.dispatch-fix-card' });
    await ui.click({ text: 'Let the agent fix it', within: '.dispatch-fix-card' });
    await waitCard(ui, 'sent', 30000);
    // the agent puts the work on a branch of its own and sends that
    let branches = '';
    for (const until = Date.now() + 600000; Date.now() < until; await ui.sleep(3000)) {
      await answerAgent(ui);
      branches = gitTry(remote, 'branch', '--format=%(refname:short)');
      if (branches.split('\n').some(b => b && b !== 'main') && /plants\.md/.test(gitTry(remote, 'log', '--all', '--name-only', '--format='))) break;
    }
    facts.remoteBranches = branches;
    facts.agentReply = (await ui.eval(`[...document.querySelectorAll('.interactive-response')].at(-1)?.innerText || ''`)).slice(0, 1200);
    facts.cardAfter = (await card(ui))?.text || '';
    assert.ok(branches.split('\n').some(b => b && b !== 'main'), `the agent did not send a branch: ${branches} / ${facts.agentReply.slice(0, 300)}`);
    await ui.sleep(5000);
    await ui.screenshot('02-push-fixed');
  }

  // ---- 2 a pull request whose check failed, read by the real gh ---------------------------------------------------
  let clone = '';
  if (PARTS.has('checks') || PARTS.has('pr')) {
    const pr = findFailingPr();
    facts.pr = pr;
    clone = path.join(E2E_ROOT, 'real', pr.repo.split('/')[1]);
    fs.rmSync(path.dirname(clone), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(clone), { recursive: true });
    gh(path.dirname(clone), 'repo', 'clone', pr.repo, clone, '--', '-q', '--depth', '50', '--no-single-branch');
    gh(clone, 'pr', 'checkout', pr.number);
    facts.branch = git(clone, 'rev-parse', '--abbrev-ref', 'HEAD');
    await sessionOn(ui, clone, path.basename(clone));
    await openChanges(ui);
  }
  if (PARTS.has('checks')) {
    const checks = await waitCard(ui, 'problem', 180000, 'A check failed on your pull request');
    facts.checksCard = checks.text;
    assert.ok(/The “[^”]+” check failed\./.test(checks.text), checks.text);
    await ui.screenshot('03-check-failed-real');
    await ui.mark({ css: '.dispatch-fix-card' }, { what: 'PR 检查没过（真 gh 读的 GitHub）', where: '右栏 Changes 页签顶部', how: '有 PR 且检查失败时自己出来' });
    await ui.click({ text: 'Details', exact: true, within: '.dispatch-fix-card' });
    await ui.waitFor({ css: '.dispatch-fix-card .dfc-details.open' });
    facts.checksDetails = (await ui.eval(`[...document.querySelectorAll('.dispatch-fix-card')].find(e => e.offsetParent)?.querySelector('.dfc-details')?.innerText || ''`)).slice(0, 1500);
    assert.ok(facts.checksDetails.trim().length > 40, `the check's log: ${facts.checksDetails}`);
    await ui.screenshot('04-check-details');
    await ui.click({ aria: 'Close', within: '.dispatch-fix-card' });
  }

  // ---- 3 Create PR: the agent writes, the person changes, nothing is sent ---------------------------------------------
  if (PARTS.has('pr')) {
    // a session in its own copy of the project (a folder session offers Create PR only once its branch is pushed,
    // and pushing to a repository that is not ours is not something this test does)
    const base = git(clone, 'remote', 'show', 'origin').match(/HEAD branch: (\S+)/)?.[1] || 'main';
    git(clone, 'checkout', '-q', base);
    const before = git(clone, 'worktree', 'list', '--porcelain');
    await sessionOn(ui, clone, path.basename(clone), true);
    let copy = '';
    for (let i = 0; i < 60 && !copy; i++) {
      const now = git(clone, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));
      copy = now.find(w => !before.includes(w) && w !== clone) || '';
      if (!copy) await ui.sleep(1000);
    }
    assert.ok(copy, 'the session made no copy of the project');
    facts.copy = copy;
    const readme = fs.readdirSync(copy).find(f => /^readme/i.test(f)) || 'README.md';
    fs.appendFileSync(path.join(copy, readme), '\n\n## Running the tests locally\n\nInstall the extension, then run `make installcheck` from the repository root.\n');
    git(copy, 'commit', '-qam', 'docs: say how to run the tests locally');
    await openChanges(ui);
    for (let i = 0; i < 120 && !(await ui.exists({ text: 'Create PR', exact: true, webview: false })); i++) await ui.sleep(1000);
    await ui.click({ text: 'Create PR', exact: true, webview: false });
    await ui.waitFor({ css: '.create-pull-request-widget' }, { timeoutMs: 20000 });
    const filled = async () => ui.eval(`(() => { const w = document.querySelector('.create-pull-request-widget'); if (!w) return null; const t = w.querySelector('input'); const d = w.querySelector('textarea'); const by = w.querySelector('.create-pr-written-by'); const err = w.querySelector('.create-pr-generation'); return { title: t?.value || '', description: d?.value || '', by: by && !by.hidden ? by.textContent : '', error: err && !err.hidden ? err.innerText : '' }; })()`);
    let form = null;
    for (const until = Date.now() + 240000; Date.now() < until; await ui.sleep(1500)) {
      form = await filled();
      if (form && (form.by || form.error)) break;
    }
    facts.form = form;
    assert.ok(form && form.title && form.description, `the form was not filled: ${JSON.stringify(form)}`);
    assert.ok(/^Written by (Codex|Claude Code|OpenCode)\./.test(form.by), `who wrote it: ${JSON.stringify(form)}`);
    await ui.screenshot('05-pr-written');
    await ui.mark({ css: '.create-pull-request-widget' }, { what: 'Create PR：Agent 写好标题和描述，写明是谁写的', where: '右栏 Changes 页签，点 Create PR', how: '改完再点 Create PR' });
    // the person changes the title
    await ui.click({ css: '.create-pull-request-widget input' });
    await ui.press('End');
    await ui.type(' (draft)');
    facts.editedTitle = (await filled()).title;
    assert.ok(facts.editedTitle.endsWith(' (draft)'), facts.editedTitle);
    await ui.screenshot('06-pr-edited');
    // not sent: the repository is not ours
    await ui.click({ text: 'Cancel', exact: true, within: '.create-pull-request-widget' });
  }
  fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 2));
  return facts;
}
