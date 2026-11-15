// A real OpenCode session on a cheap model hands a small job to the built-in engineer and one to the built-in tester.
// Start the instance with: dispatch ide instance start <name> --agents (real logins; OpenCode's config folder is the
// instance's own, so the agents are installed there, not in your real one).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cli, closeTips, focusInput, pickModel, until } from './chat-capture.mjs';

export const meta = { needs: ['opencode'],
  title: '内置 Agent 真会话：OpenCode 派 engineer 和 tester',
  description: '装上内置 Agent 后开一个 OpenCode 会话（便宜模型），让它派 engineer 建一个文件、派 tester 读这个文件，两个都真跑了。',
  timeout: 1800,
};

export default async function (ui) {
  const files = cli(ui, ['builtin-agents', 'sync', '--json']).files;
  fs.writeFileSync(path.join(ui.out, 'sync.json'), JSON.stringify(files, null, 1));
  const xdg = ui.rec.root + '/xdg-config';
  for (const n of ['engineer', 'tester']) {
    const f = files.find(x => x.engine === 'opencode' && x.name === n);
    assert.ok(f && f.path.startsWith(ui.rec.root) && fs.existsSync(f.path), `${n} installed for OpenCode inside the instance: ${JSON.stringify(f)}`);
  }
  assert.ok(fs.existsSync(path.join(xdg, 'opencode', 'agents', 'engineer.md')));

  const folder = ui.demoFolder;
  await ui.attach('agents', 60000);
  await ui.press('Escape');   // a Settings page left open
  await closeTips(ui).catch(() => {});
  await ui.openAgents(folder);
  await ui.newSession(folder);
  await ui.pickEngine('OpenCode', 360000);
  const model = await pickModel(ui);
  fs.writeFileSync(path.join(ui.out, 'chat-model.txt'), model);
  await focusInput(ui);
  await ui.type('This is a quick check of the built-in helper agents, not real work. First use the engineer subagent (task tool, subagent_type "engineer") with exactly this job: "Create the file hello-engineer.txt in the current folder containing the single line: made by engineer. This is a check, so do not make a copy of the project, do not commit, do not run tests, no delivery page; just create the file and reply with its path." Then use the tester subagent (subagent_type "tester") with exactly this job: "Read hello-engineer.txt in the current folder and report whether it says made by engineer. This is a check: do not start the app, change nothing, just read the file and answer in one line." When both are done, reply with one line: ENGINEER=<what engineer said> TESTER=<what tester said>.');
  await ui.press('Enter', { send: true });
  // a new session works in its own copy of the project (<project>.worktrees/<session>), or in the folder itself
  const found = () => [folder, ...(fs.existsSync(`${folder}.worktrees`) ? fs.readdirSync(`${folder}.worktrees`).map(d => path.join(`${folder}.worktrees`, d)) : [])]
    .map(d => path.join(d, 'hello-engineer.txt')).find(f => fs.existsSync(f));
  const made = await until(ui, found, 'engineer made the file', 900000, 3000);
  await until(ui, async () => /TESTER=[^<\s]/.test(await ui.eval('document.body.innerText')), 'the session answered with what tester said', 900000, 3000);
  await ui.sleep(3000);
  // the last answer in view (the reply text is split across elements, so find it by its words in the page)
  await ui.eval(`(() => { const all = [...document.querySelectorAll('.interactive-item-container, .monaco-list-row')].filter(e => /TESTER=/.test(e.innerText || '')); all.at(-1)?.scrollIntoView({ block: 'center' }); })()`);
  await ui.sleep(1000);
  await ui.screenshot('05-chat');
  fs.writeFileSync(path.join(ui.out, 'chat-text.txt'), await ui.eval('document.body.innerText'));
  assert.equal(fs.readFileSync(made, 'utf8').trim(), 'made by engineer');
  // OpenCode ran them as its own sub-agents: their messages carry the agent's name
  const db = path.join(ui.rec.root, 'xdg-data', 'opencode', 'opencode.db');
  const agents = execFileSync('sqlite3', [db, "select json_extract(data, '$.agent') a, count(*) from message group by a"], { encoding: 'utf8' });
  fs.writeFileSync(path.join(ui.out, 'opencode-agents.txt'), agents);
  for (const n of ['engineer', 'tester']) assert.match(agents, new RegExp(`^${n}\\|`, 'm'), `OpenCode ran ${n}`);
}
