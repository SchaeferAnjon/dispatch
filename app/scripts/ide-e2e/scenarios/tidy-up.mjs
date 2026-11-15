// Tidy up after work (kanban task-uf2dy): Settings › Agents turns the built-in neat-freak skill on after each task,
// with OpenCode; a task finished in the demo project starts a read-only check, and its one-line result lands in the
// bell. Start the instance with: dispatch ide instance start <name> --agents (real logins; OpenCode on a cheap model).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cli, closeTips, MODEL, until } from './chat-capture.mjs';

export const meta = { needs: ['opencode'],
  title: '干完活自动整理：设置里打开，做完一件任务后在铃铛里给一行结果',
  description: '设置 › Agents 的 Tidy up after work 默认关，选「After each task」和 OpenCode；在演示项目里完成一件任务，后台起一次只读检查，跑完铃铛里出一行结果，项目文件一个没改。',
  timeout: 1800,
};

const BELL = '.dispatch-inbox-button-label';
const PANEL = '.dispatch-inbox-panel';
const NAV = { css: '.part.sidebar.dispatch-settings-open .dispatch-settings-nav', webview: false };

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

export default async function (ui) {
  const demo = ui.demoFolder;
  await ui.attach('agents', 60000);
  await ui.press('Escape');
  await closeTips(ui).catch(() => {});
  assert.equal(cli(ui, ['neat', 'status', '--json']).auto, 'off', 'off until you turn it on');

  // 1 Settings › Agents › Tidy up after work
  await ui.press('Cmd+,');
  await ui.waitFor(NAV, { timeoutMs: 15000 });
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="agents"]', webview: false });
  // the Agents page looks for every agent on the Mac first; the section is at its foot, below the fold
  await until(ui, () => ui.eval(`!!document.querySelector('.dispatch-settings-page [data-setting="tidy-auto"]')`), 'Tidy up after work on the Agents page', 240000);
  await ui.eval(`document.querySelector('.dispatch-settings-page [data-setting="tidy-engine"]').scrollIntoView({ block: 'end' })`);
  await ui.sleep(800);
  await ui.waitFor({ text: 'Check by itself' }, { timeoutMs: 30000 });
  await ui.screenshot('01-tidy-off');
  await ui.mark({ text: 'Tidy up after work' }, { what: '干完活自动整理', where: '设置 › Agents 最下面', how: '⌘, 打开设置，点 Agents，往下翻' });
  await ui.click({ text: 'After each task', exact: true, within: '.dispatch-settings-page [data-setting="tidy-auto"]' });
  await until(ui, () => cli(ui, ['neat', 'status', '--json']).auto === 'task', 'the setting is saved', 20000);
  await ui.click({ text: 'OpenCode', exact: true, within: '.dispatch-settings-page [data-setting="tidy-engine"]' });
  await until(ui, () => cli(ui, ['neat', 'status', '--json']).engine === 'opencode', 'the agent is saved', 20000);
  await ui.screenshot('02-tidy-on');
  await ui.mark({ css: '.dispatch-settings-page [data-setting="tidy-auto"]', webview: false }, { what: '每完成一件任务后检查一次', where: 'Tidy up after work 的 Check by itself', how: '默认 Off，点 After each task 或 Once a day' });
  // a cheap model for the check (the window has no model picker for it; the command line sets one)
  cli(ui, ['neat', 'auto', '--model', MODEL, '--json']);
  await ui.press('Escape');

  // 2 a task finished in the demo project starts the check
  const before = git(demo, 'status', '--porcelain');
  const head = git(demo, 'rev-parse', 'HEAD').trim();
  const began = cli(ui, ['begin', 'Demo page: say hello in the footer', '-P', 'demo', '-d', 'A small task for the tidy-up check.', '--json']);
  const id = began.id || began.task || began.issue?.id;
  assert.ok(id, JSON.stringify(began));
  const done = execFileSync(path.join(ui.rec.bin_dir, 'dispatch'), ['done', id, '--reason', 'checked by hand'], { cwd: demo, encoding: 'utf8' });
  fs.writeFileSync(path.join(ui.out, 'done.txt'), done);
  assert.match(done, /tidying up demo in the background/);
  const ended = await until(ui, () => {
    const st = cli(ui, ['neat', 'status', '--json']);
    return st.last && st.last.status !== 'running' ? st : null;
  }, 'the check finished', 1500000, 5000);
  fs.writeFileSync(path.join(ui.out, 'neat-status.json'), JSON.stringify(ended, null, 1));
  assert.notEqual(ended.last.status, 'failed', ended.last.line);
  assert.ok(ended.last.line, 'a one-line result');
  assert.equal(git(demo, 'status', '--porcelain'), before, 'the check changed no file');
  assert.equal(git(demo, 'rev-parse', 'HEAD').trim(), head, 'and committed nothing');
  fs.copyFileSync(ended.last.report, path.join(ui.out, 'report.md'));

  // 3 the one line is in the bell
  const inbox = cli(ui, ['inbox', '--json']);
  const ev = (inbox.events || inbox).find?.(e => /Tidy up · demo/.test(e.title || ''));
  fs.writeFileSync(path.join(ui.out, 'inbox.json'), JSON.stringify(inbox, null, 1));
  assert.ok(ev, 'a bell row for the check');
  if (!(await ui.exists({ css: PANEL }))) await ui.click({ css: BELL });
  await ui.waitFor({ css: `${PANEL} .dispatch-inbox-row` }, { timeoutMs: 30000 });
  await until(ui, async () => (await ui.eval(`document.querySelector('${PANEL}')?.innerText || ''`)).includes('Tidy up · demo'), 'the bell lists the check', 60000);
  await ui.screenshot('03-bell');
  await ui.mark({ css: `${PANEL} .dispatch-inbox-row` }, { what: '整理结果在铃铛里一行', where: '标题栏铃铛', how: '点铃铛；点这一行打开那次检查的会话看全文' });
}
