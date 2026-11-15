import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const meta = { needs: ['opencode'],
  title: 'Agent 自己完成任务',
  description: 'OpenCode 的便宜模型（GLM 5.3 Flash、DeepSeek Flash 或免费 Flash）在演示项目完成任务，Tasks 卡直接显示 Done，没有验收入口。',
};

export default async function (ui) {
  const rec = ui.rec;
  const env = { ...process.env, BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home, DISPATCH_BIN: rec.cli };
  const cli = (...args) => execFileSync('python3', [rec.cli, ...args], { env, cwd: ui.demoFolder, encoding: 'utf8', timeout: 120000 });
  const title = 'Complete the agent checklist demo';
  // Reuse the real task when only the post-completion UI checks need repeating.
  const existing = process.env.NOCHECKER_TASK;
  const task = existing ? JSON.parse(cli('task', 'show', existing, '--json'))
    : JSON.parse(cli('begin', title, '-P', 'demo', '-d', 'Write a demo result file, verify its content, and complete the task with evidence in this isolated instance.', '-a', '- [ ] result.txt contains NOCHECKER_OK\n- [ ] content assertion passes', '--json'));
  await ui.openAgents(ui.demoFolder);
  if (!existing) {
    cli('task', 'plan', task.id, '--set', 'Write the result file', '--set', 'Verify and record completion');
    writeFileSync(path.join(ui.demoFolder, 'AGENTS.md'), `# Isolated demo\n\nUse python3 ${rec.cli} for every Dispatch command. Work only in this folder or its IDE worktree. The task is ${task.id}. There is no remote to push. Record your result and test evidence before marking the task done.\n`);
    await ui.newSession(ui.demoFolder); // the demo project itself, not whatever page the window is on
    const picker = '.sessions-chat-session-type-picker';
    await ui.pickEngine('OpenCode');
    // the cheap test model (GLM 5.3 Flash, DeepSeek Flash or a free Flash), picked in the model chip: never another
    const model = await ui.pickCheapModel();
    writeFileSync(path.join(ui.out, 'selected-model.json'), JSON.stringify(model, null, 2));
    await ui.click({ css: '.sessions-chat-editor' });
    await ui.type(`完成演示任务 ${task.id}：在当前项目创建 result.txt，内容为 NOCHECKER_OK 加换行，用 Python 断言文件内容正确，再记录测试证据并完成这条任务。所有 Dispatch 命令都用 python3 ${rec.cli}。只操作这个演示项目，不调用其他模型。`);
    await ui.press('Enter', { send: true });
  }
  let result;
  const until = Date.now() + 240000;
  do {
    await ui.sleep(3000);
    result = JSON.parse(cli('task', 'show', task.id, '--json'));
  } while (result.bd_status !== 'closed' && Date.now() < until);
  writeFileSync(path.join(ui.out, 'completed-task.json'), JSON.stringify(result, null, 2));
  if (result.bd_status !== 'closed') throw new Error('The agent did not complete its task.');
  // The native provider can create a worktree for the conversation. Restrict discovery to
  // this task's worktree inside the isolated instance, never to the user's projects.
  const worktrees = ui.demoFolder + '.worktrees';
  const candidates = [path.join(ui.demoFolder, 'result.txt'),
    // a separate copy is named after the conversation now, not the task: any copy of the demo project (this instance's own)
    ...(existsSync(worktrees) ? readdirSync(worktrees).map(n => path.join(worktrees, n, 'result.txt')) : [])];
  const resultFile = candidates.find(p => existsSync(p));
  if (!resultFile || readFileSync(resultFile, 'utf8') !== 'NOCHECKER_OK\n') throw new Error('Unexpected file content.');
  writeFileSync(path.join(ui.out, 'verified-result.json'), JSON.stringify({ task: task.id, file: resultFile, expected: 'NOCHECKER_OK\n' }, null, 2));
  await ui.screenshot('01-agent-completed');
  // Full-page task details have no editor tab strip. Return to a session page on reruns.
  if (existing) await ui.newSession();
  await ui.openTab('Tasks');
  await ui.waitFor({ text: 'This session', within: '.dispatch-tasks' });
  await ui.click({ text: 'demo', exact: true, within: '.dispatch-tasks' });
  const foldedDone = { css: '.dispatch-tasks button.dispatch-task-group-head[aria-expanded="false"]' };
  if (await ui.exists(foldedDone)) await ui.click(foldedDone);
  await ui.waitFor({ text: title, within: '.dispatch-tasks' }, { timeoutMs: 30000 });
  const controls = await ui.eval(`Array.from(document.querySelectorAll('.dispatch-tasks button,.dispatch-tasks [role=button]')).map(e => e.textContent + ' ' + (e.getAttribute('aria-label') || ''))`);
  if (controls.some(t => /验收|免验|waive|check now|check all|verify all/i.test(t))) throw new Error('Retired verification control is visible.');
  writeFileSync(path.join(ui.out, 'task-controls.json'), JSON.stringify(controls, null, 2));
  await ui.screenshot('02-tasks-done');
  await ui.mark({ text: title, within: '.dispatch-tasks' }, { what: 'Agent 已完成的任务', where: '右栏 Tasks，demo 项目列表', how: 'Agent 交付并记录证据后自动显示完成' });
  await ui.click({ text: title, within: '.dispatch-tasks' });
  await ui.waitFor({ text: title, exact: true }, { timeoutMs: 30000 });
  const detail = await ui.eval('document.body.innerText');
  if (!detail.includes('Done')) throw new Error('Task detail does not show completion.');
  await ui.screenshot('03-task-detail');
}
