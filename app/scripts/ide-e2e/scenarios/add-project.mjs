// Add a project: one dialog for a folder, a new project by name, and a copy from the internet. Opened from the
// Projects page's Add Project and from the new session's folder menu. Real clicks and typing; the folders and the
// registry are checked on disk. The copy needs the network (https://github.com/octocat/Hello-World).
// Start the instance with: dispatch ide instance start addproject --onboarding fresh --agents
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const meta = { instance: { onboarding: 'fresh' }, needs: ['internet'], timeout: 900, title: '添加项目', description: '一个对话框：选文件夹、只填名字新建、从网址复制；Projects 页和新会话文件夹菜单都能打开；新建出来的项目带空的第一次提交，复制的显示进度，出错写人话。' };

const dialogText = ui => ui.eval(`document.querySelector('.dispatch-ap')?.innerText || ''`);
// git as the new person's Mac has it: their HOME (the fixture's), so ~/.gitconfig is theirs
let personHome = '';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: personHome || process.env.HOME } }).trim();

// Click the dialog's main button and wait for it to close. A Mac under heavy load can make the task board miss its
// 20 s answer time; the dialog then says so in words and the button works again: try again, as a person would.
async function submit(ui, label, { tries = 4, afterClick } = {}) {
  for (let i = 1; ; i++) {
    await ui.click({ text: label, exact: true, within: '.dispatch-ap' });
    if (afterClick) await afterClick();
    const until = Date.now() + 300000;
    while (Date.now() < until) {
      if (!(await ui.exists({ css: '.dispatch-ap' }))) return;
      if (await ui.exists({ css: '.dispatch-ap .dap-note.dap-error' })) break;
      await ui.sleep(1000);
    }
    const text = await dialogText(ui);
    if (!text || !/did not answer in time/.test(text) || i >= tries) throw new Error(`${label} did not finish: ${text}`);
    await ui.screenshot(`busy-${label.replace(/\W+/g, '-')}-${i}`);
  }
}

async function openDialogFromProjects(ui) {
  await ui.click('Projects');
  await ui.waitFor({ css: '.dispatch-projects-toolbar' }, { timeoutMs: 30000 });
  await ui.click('Add Project');
  await ui.waitFor({ css: '.dispatch-ap' }, { timeoutMs: 15000 });
}

export default async function (ui) {
  assert.ok(ui.rec.fixture_home, 'Start this instance with --onboarding fresh');
  const home = ui.rec.fixture_home;
  personHome = home;
  const projects = path.join(home, 'Projects');
  await ui.attach('agents', 60000);
  try { await ui.waitFor('Welcome to Dispatch', { timeoutMs: 60000 }); await ui.press('Escape'); } catch { /* already dismissed */ }
  await ui.sleep(1000);
  await ui.openAgents(ui.demoFolder);

  // 1 the dialog from the Projects page, in plain words
  await openDialogFromProjects(ui);
  await ui.waitFor({ text: 'Choose a folder', exact: true, within: '.dispatch-ap' });
  const home1 = await dialogText(ui);
  for (const want of ['Add a project', 'Choose a folder', 'Start a new project', 'Copy a project from the internet', 'GitHub, GitLab']) assert.ok(home1.includes(want), `${want} in: ${home1}`);
  assert.ok(!/\b(clone|repository|repo|git init|PATH)\b/i.test(home1), `no developer words on the first screen: ${home1}`);
  await ui.screenshot('01-dialog');
  await ui.mark({ css: '.dispatch-ap .dap-ways' }, { what: '三种加项目的方式', where: 'Projects 页右上角 Add Project 打开的对话框', how: '选文件夹、只填名字新建、从网址复制' });
  await ui.mark({ css: '.dispatch-ap .dap-sub' }, { what: '加在哪台 Mac', where: '对话框标题下面', how: '只有这台 Mac 时写一句；有别的 Mac 时变成可选的一行' });

  // 2 Start a new project: a name, a preview of where it goes, one click
  await ui.click({ text: 'Start a new project', exact: true, within: '.dispatch-ap' });
  await ui.waitFor({ css: '.dispatch-ap input[data-field="name"]' });
  assert.equal(await ui.eval(`document.querySelector('.dispatch-ap .dap-foot .monaco-button.fill').classList.contains('disabled')`), true, 'no name, no button');
  await ui.type('Notes app', { into: { css: '.dispatch-ap input[data-field="name"]' } });
  const form = await dialogText(ui);
  assert.ok(form.includes('~/Projects/Notes app'), form);
  assert.ok(form.includes('start a history for it (Git)'), `Git is explained: ${form}`);
  await ui.screenshot('02-new-project');
  await ui.mark({ css: '.dispatch-ap .dap-form' }, { what: '起名新建', where: '对话框第二步', how: '只填名字，写明会放在哪个文件夹' });
  await ui.type('/x', { into: { css: '.dispatch-ap input[data-field="name"]' } });
  assert.ok((await dialogText(ui)).includes('cannot contain slashes'), 'a bad name is told at once');
  await ui.screenshot('03-bad-name');
  await ui.press('Backspace');
  await ui.press('Backspace');
  // a new Mac's git does not know the person yet: the dialog asks for the name and email that go on every commit
  // (the fixture HOME has no ~/.gitconfig), and Create waits for them
  assert.ok(await ui.exists({ css: '.dispatch-ap input[data-field="gitName"]' }), 'a Mac without a git name asks for one');
  assert.ok((await dialogText(ui)).includes('Git does not know your name on this Mac yet'), 'and says why');
  assert.equal(await ui.eval(`document.querySelector('.dispatch-ap .dap-foot .monaco-button.fill').classList.contains('disabled')`), true, 'no name on commits, no button');
  for (const [field, value] of [['gitName', 'Fixture Person'], ['gitEmail', 'fixture@example.com']]) {
    const now = await ui.eval(`document.querySelector('.dispatch-ap input[data-field="${field}"]').value`);
    if (!now) await ui.type(value, { into: { css: `.dispatch-ap input[data-field="${field}"]` } });
  }
  await ui.screenshot('03b-name-on-commits');
  await submit(ui, 'Create project');
  assert.equal(git(home, 'config', '--global', 'user.email'), 'fixture@example.com', 'the name on commits is saved for every project');
  const notes = path.join(projects, 'Notes app');
  assert.ok(fs.existsSync(path.join(notes, '.git')), 'the folder is a repository');
  assert.equal(git(notes, 'rev-list', '--count', 'HEAD'), '1', 'one empty first commit');
  // it opens the project's page
  await ui.waitFor('Rename Project', { timeoutMs: 300000 });
  assert.ok((await ui.eval('document.body.innerText')).includes('Notes app'));
  assert.equal(git(notes, 'branch', '--show-current'), 'main');
  await ui.screenshot('04-project-page');

  // 3 Copy a project from the internet: the address fills the folder name, progress, the project appears
  await openDialogFromProjects(ui);
  await ui.click({ text: 'Copy a project from the internet', exact: true, within: '.dispatch-ap' });
  await ui.waitFor({ css: '.dispatch-ap input[data-field="address"]' });
  assert.equal(await ui.eval(`document.querySelector('.dispatch-ap .dap-foot .monaco-button.fill').classList.contains('disabled')`), true);
  await ui.type('hello', { into: { css: '.dispatch-ap input[data-field="address"]' } });
  assert.equal(await ui.eval(`document.querySelector('.dispatch-ap .dap-foot .monaco-button.fill').classList.contains('disabled')`), true, 'not an address yet');
  await ui.press('Backspace'); await ui.press('Backspace'); await ui.press('Backspace'); await ui.press('Backspace'); await ui.press('Backspace');
  // 3a an address with nothing behind it: said in words, the dialog stays with what was typed
  await ui.type('https://github.com/octocat/this-project-does-not-exist-1234', { into: { css: '.dispatch-ap input[data-field="address"]' } });
  assert.equal(await ui.eval(`document.querySelector('.dispatch-ap input[data-field="folderName"]').value`), 'this-project-does-not-exist-1234');
  await ui.click({ text: 'Copy project', exact: true, within: '.dispatch-ap' });
  await ui.waitFor({ css: '.dispatch-ap .dap-note.dap-error' }, { timeoutMs: 90000 });
  const failed = await dialogText(ui);
  assert.ok(/Could not open that project|no project at that web address|Could not reach that address/.test(failed), failed);
  assert.ok(!/fatal:|clone/i.test(failed), `git's own words stay out: ${failed}`);
  assert.equal(fs.existsSync(path.join(projects, 'this-project-does-not-exist-1234')), false, 'nothing is left behind');
  await ui.screenshot('05-copy-error');
  await ui.mark({ css: '.dispatch-ap .dap-note.dap-error' }, { what: '复制失败的人话提示', where: '复制对话框里，按钮上方', how: '说发生了什么、该怎么办，已填的内容保留' });
  // 3b the real one
  await ui.click({ css: '.dispatch-ap input[data-field="address"]' });
  const addressValue = () => ui.eval(`document.querySelector('.dispatch-ap input[data-field="address"]').value`);
  for (let i = 0; i < 100 && (await addressValue()); i++) {
    await ui.eval(`(() => { const i = document.querySelector('.dispatch-ap input[data-field="address"]'); i.setSelectionRange(i.value.length, i.value.length); })()`);
    await ui.press('Backspace');
  }
  assert.equal(await addressValue(), '');
  // the folder name follows the address, but only until it is edited by hand
  await ui.type('https://github.com/octocat/Hello-World', { into: { css: '.dispatch-ap input[data-field="address"]' } });
  assert.equal(await ui.eval(`document.querySelector('.dispatch-ap input[data-field="folderName"]').value`), 'Hello-World');
  assert.ok((await dialogText(ui)).includes('~/Projects/Hello-World'));
  let sawBar = false;
  await submit(ui, 'Copy project', { afterClick: async () => {
    if (sawBar) return;
    try { await ui.waitFor({ css: '.dispatch-ap .dap-bar' }, { timeoutMs: 15000 }); sawBar = true; await ui.screenshot('06-copying'); } catch { /* finished or failed before it showed */ }
  } });
  assert.ok(sawBar, 'a progress bar was shown while copying');
  const hello = path.join(projects, 'Hello-World');
  assert.ok(fs.existsSync(path.join(hello, 'README')), 'the files are there');
  assert.ok(git(hello, 'remote', 'get-url', 'origin').includes('octocat/Hello-World'));
  await ui.waitFor('Rename Project', { timeoutMs: 300000 });
  assert.ok((await ui.eval('document.body.innerText')).includes('Hello-World'));
  await ui.screenshot('07-copied-project');

  // 4 both projects are on the Projects page
  await ui.click('Projects');
  await ui.waitFor({ css: '.dispatch-projects-toolbar' });
  await ui.click({ text: 'All', exact: true, within: '.dispatch-projects-toolbar' });
  await ui.waitFor({ text: 'Hello-World', exact: true, within: '.dispatch-projects-page' }, { timeoutMs: 90000 });
  assert.ok(await ui.exists({ text: 'Notes app', exact: true, within: '.dispatch-projects-page' }));
  await ui.screenshot('08-projects-page');
  await ui.mark({ text: 'Hello-World', exact: true, within: '.dispatch-projects-page' }, { what: '复制来的项目', where: 'Projects 页列表', how: '点它打开项目页，右上角 + Session 在里面开会话' });

  // 5 a session in the copied project: its page's New Session opens the composer on that folder
  await ui.click({ text: 'Hello-World', exact: true, within: '.dispatch-projects-page' });
  await ui.click('New Session');
  await ui.waitFor({ css: '.sessions-chat-workspace-picker, .sessions-chat-widget' }, { timeoutMs: 30000 });
  for (let i = 0; i < 120 && !(await ui.eval(`document.querySelector('.new-session-workspace-picker-container')?.innerText.includes('Hello-World')`)); i++) await ui.sleep(1000);
  assert.ok(await ui.eval(`document.querySelector('.new-session-workspace-picker-container')?.innerText.includes('Hello-World')`), 'the new session is in the copied project');
  await ui.screenshot('09-session-in-copy');

  // 6 the new session's folder menu has Add Project... : a name, and the session starts in the new folder
  await ui.newSession();
  await ui.sleep(2500);
  const trigger = await ui.eval(`(() => { const t = document.querySelector('.sessions-chat-workspace-picker, .sessions-chat-workspace-picker-trigger, [class*="workspace-picker"]'); return t ? (t.className + ' | ' + t.innerText) : 'none'; })()`);
  fs.writeFileSync(path.join(ui.out, 'workspace-picker-trigger.txt'), trigger);
  await ui.click({ css: '[class*="workspace-picker"]' });
  await ui.waitFor('Add Project...', { timeoutMs: 15000 });
  await ui.screenshot('10-folder-menu');
  await ui.mark('Add Project...', { what: '新会话文件夹菜单里的 Add Project...', where: '新会话页，项目名那个下拉菜单里', how: '点开同一个对话框，建好后会话直接开在新项目里' });
  await ui.click('Add Project...');
  await ui.waitFor({ css: '.dispatch-ap' }, { timeoutMs: 15000 });
  await ui.click({ text: 'Start a new project', exact: true, within: '.dispatch-ap' });
  await ui.waitFor({ css: '.dispatch-ap input[data-field="name"]' });
  await ui.type('Second project', { into: { css: '.dispatch-ap input[data-field="name"]' } });
  await ui.press('Enter');
  await ui.waitFor({ css: '.dispatch-ap' }, { gone: true, timeoutMs: 240000 });
  assert.ok(fs.existsSync(path.join(projects, 'Second project', '.git')));
  await ui.waitFor({ css: '.new-session-workspace-picker-container' }, { timeoutMs: 120000 });
  for (let i = 0; i < 120 && !(await ui.eval(`document.querySelector('.new-session-workspace-picker-container')?.innerText.includes('Second project')`)); i++) await ui.sleep(1000);
  assert.ok(await ui.eval(`document.querySelector('.new-session-workspace-picker-container')?.innerText.includes('Second project')`), 'the session starts in the new project');
  await ui.screenshot('11-session-in-new');

  // 7 Escape closes the dialog and changes nothing
  await openDialogFromProjects(ui);
  await ui.press('Escape');
  await ui.waitFor({ css: '.dispatch-ap' }, { gone: true });
  assert.equal(fs.readdirSync(projects).sort().join(','), 'Hello-World,Notes app,Second project');
}
