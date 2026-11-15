// OpenCode's skills from Find Skills (Settings › Abilities): a skill already in the pool gets Enable, a public one
// Install, each after the question; the mount is checked on disk in the instance's own OpenCode config folder (its
// XDG_CONFIG_HOME, a folder of its own since 10-07), so nothing outside the instance is touched.
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
export const meta = { needs: ['opencode', 'internet'], timeout: 600, title: "OpenCode 安装和启用技能", description: "在 OpenCode 会话里打开设置 › Abilities › Find Skills，实际点击 Enable 和 Install，检查结果及挂载文件。" };
async function search(ui, query, previous = '') {
  await ui.click('Search skills');
  await ui.press('End');
  for (const _ of previous) await ui.press('Backspace');
  await ui.type(query);
  await ui.press('Enter');
}
async function confirm(ui, action, name) {
  await ui.waitFor({ text: `${action} ${name}?`, exact: true }, { timeoutMs: 20000 });
  await ui.click({ text: action, exact: true, within: '.monaco-dialog-box' });
}
async function verifyMount(ui, name) {
  const source = await realpath(`${ui.rec.dispatch_home}/skills/${name}`);
  const mount = await realpath(path.join(ui.rec.root, 'xdg-config', 'opencode', 'skills', name));
  if (source !== mount) throw new Error(`Unexpected skill mount: ${mount}`);
  await realpath(`${mount}/SKILL.md`);
}
export default async function (ui) {
  const fixture = `${ui.rec.dispatch_home}/skills/gx-fixes-enable`;
  await mkdir(fixture, { recursive: true });
  await writeFile(`${fixture}/SKILL.md`, '---\nname: gx-fixes-enable\ndescription: An isolated skill fixture for the fixes acceptance check.\n---\nUse only for this acceptance check.\n');
  await ui.openAgents(ui.demoFolder);
  await ui.newSession();
  await ui.pickEngine('OpenCode');
  await ui.openCustomizations('Overview');
  await ui.scrollTo('Find Skills');
  await search(ui, 'gx-fixes-enable');
  // the results open below the box, out of view
  await ui.waitForText('In your pool', { timeoutMs: 60000 });
  await ui.scrollTo('gx-fixes-enable');
  await ui.click({ text: 'Enable', exact: true, within: '.dispatch-find-skills-results' });
  await confirm(ui, 'Enable', 'gx-fixes-enable');
  await ui.waitFor({ text: 'Enabled', exact: true, within: '.dispatch-find-skills-results' }, { timeoutMs: 30000 });
  await verifyMount(ui, 'gx-fixes-enable');
  await ui.screenshot('03-opencode-enabled');
  await ui.mark('Enabled', { what: 'OpenCode 已启用技能', where: 'Find Skills 的本地结果', how: '点击 Enable 并确认' });
  await search(ui, 'algorithmic-art', 'gx-fixes-enable');
  await ui.waitForText('On GitHub', { timeoutMs: 60000 });
  const official = '.dispatch-find-skills-item[title="https://github.com/anthropics/skills"]';
  await ui.eval(`document.querySelector('${official}')?.scrollIntoView({ block: 'center' })`);
  await ui.click({ text: 'Install', exact: true, within: official });
  await confirm(ui, 'Install', 'algorithmic-art');
  await ui.waitFor({ text: 'Enabled', exact: true, within: '.dispatch-find-skills-results' }, { timeoutMs: 180000 });
  await verifyMount(ui, 'algorithmic-art');
  await ui.screenshot('04-opencode-installed');
  await ui.mark('Enabled', { what: '从官方仓库安装并挂载成功', where: 'Find Skills 的本地结果', how: '点击 Install 并确认' });
}
