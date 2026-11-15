import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const meta = { instance: { onboarding: 'fresh' }, title: '新用户第一次打开 Dispatch', description: '在全新 HOME 和临时任务板里，真点两屏或四屏向导、跳过后继续、导入及撤销。' };

async function theme(ui, dark) {
  // the title bar has no theme button any more; the wizard covers Settings, so step through the modes from the
  // command palette ("Theme: System, Light, Dark")
  for (let i = 0; i < 4; i++) {
    const isDark = await ui.eval("!!document.querySelector('.monaco-workbench.vs-dark')");
    if (isDark === dark) return;
    await ui.press('F1');
    await ui.type('Theme: System, Light, Dark');
    await ui.press('Enter');
    await ui.sleep(600);
  }
  throw new Error('Theme did not change');
}

async function screenshotPair(ui, name) {
  await theme(ui, false);
  await ui.screenshot(name + '-light');
  const metrics = await ui.eval(`(() => {
    const root = document.querySelector('.dispatch-onboarding');
    if (!root) return null;
    const rect = root.getBoundingClientRect();
    const title = root.querySelector('.dob-title');
    const buttons = [...root.querySelectorAll('.dob-foot .dob-btn')];
    return { title: title.textContent, font: getComputedStyle(title).fontSize,
      width: rect.width, height: rect.height, overflow: root.scrollWidth > root.clientWidth + 2,
      buttons: buttons.map(b => { const r = b.getBoundingClientRect(); return { text: b.textContent, bottom: r.bottom, visible: r.top >= 0 && r.bottom <= innerHeight }; }) };
  })()`);
  if (metrics) {
    assert.equal(metrics.overflow, false, JSON.stringify(metrics));
    assert.equal(metrics.font, '17px');
    assert.ok(metrics.buttons.every(b => b.visible), JSON.stringify(metrics));
  }
  await theme(ui, true);
  await ui.screenshot(name + '-dark');
  await theme(ui, false);
}

// the three first-run screens between the agents and the rules: continue until `heading` shows
async function continuePast(ui, heading) {
  for (let i = 0; i < 4 && !(await ui.exists(heading)); i++) {
    await ui.waitFor({ css: '.dob-foot .dob-btn.fill' }, { timeoutMs: 30000 });
    await ui.click({ css: '.dob-foot .dob-btn.fill' });
    await ui.sleep(700);
  }
  await ui.waitFor(heading, { timeoutMs: 30000 });
}

export default async function (ui) {
  assert.ok(ui.rec.fixture_home, 'Start this instance with --onboarding fresh or terminal');
  const terminal = ui.rec.onboarding_kind === 'terminal';
  const stateFile = path.join(ui.rec.dispatch_dir, 'onboarding.json');
  const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  await ui.attach('agents', 60000);
  // What's new waits for the wizard: it is not on top of it
  await ui.waitFor('Agents on this Mac', { timeoutMs: 90000 });
  await ui.sleep(2500);
  assert.equal(await ui.exists({ css: '.dispatch-whats-new-card' }), false, 'What\'s new must not open over the wizard');
  assert.equal(await ui.eval("document.querySelectorAll('.dispatch-onboarding .dob-bars i').length"), terminal ? 7 : 5);
  if (terminal) assert.equal(await ui.eval("document.querySelector('[aria-label=\"Import from VS Code\"]').getAttribute('aria-checked')"), 'false');
  await screenshotPair(ui, '01-agents');
  if (terminal) {
    await ui.click({ text: 'Choose', exact: true });
    await ui.waitFor('Take your settings and extensions', { timeoutMs: 60000 });
    await ui.waitFor({ aria: 'editor.fontSize', exact: true }, { timeoutMs: 60000 });
    const extensions = await ui.eval("[...document.querySelectorAll('.dob-row.tight')].filter(r=>r.querySelector('.dob-p')).map(r=>r.querySelector('[role=checkbox]')?.getAttribute('aria-label')).filter(Boolean)");
    for (const label of extensions) {
      if (label === 'Rainbow Csv') continue;
      await ui.scrollTo(label);
      await ui.click({ aria: label, exact: true });
    }
    await ui.scrollTo('editor.fontSize');
    await screenshotPair(ui, '01b-vscode-settings');
    await ui.click({ text: 'Done', exact: true });
  }
  await ui.mark('Continue', { what: '发现引擎', where: '首次打开的主区', how: '点 Continue，继续导入或直接连接引擎' });
  await ui.click({ text: 'Continue', exact: true });
  if (!terminal) await ui.waitFor('Agent permissions', { timeoutMs: 30000 });

  if (terminal) {
    await ui.waitFor('Bring your folders in as projects');
    await ui.waitFor({ aria: 'notes-site', exact: true }, { timeoutMs: 60000 });
    const selected = await ui.eval("[...document.querySelectorAll('.dob-row.folder [role=checkbox][aria-checked=true]')].map(e=>e.getAttribute('aria-label'))");
    assert.ok(selected.includes('notes-site')); assert.ok(!selected.includes('old-blog'));
    await screenshotPair(ui, '02-projects');
    await ui.click({ aria: 'External sessions time range' });
    await ui.click({ text: 'Last 90 Days', exact: true, within: '.monaco-select-box-dropdown-container' });
    assert.equal(await ui.eval("document.querySelector('.dob-range select').selectedOptions[0].textContent"), 'Last 90 Days');
    await ui.waitFor({ aria: 'old-blog', exact: true });
    assert.equal(await ui.eval("document.querySelector('[role=checkbox][aria-label=\"old-blog\"]').getAttribute('aria-checked')"), 'true');
    await ui.click({ aria: 'External sessions time range' });
    await ui.click({ text: 'All time', exact: true, within: '.monaco-select-box-dropdown-container' });
    assert.equal(await ui.eval("document.querySelector('.dob-range select').selectedOptions[0].textContent"), 'All time');
    const more = await ui.eval("document.querySelector('.dob-list > .dob-more')?.textContent");
    if (more) { await ui.scrollTo(more); await ui.click({ text: more, exact: true }); }
    await ui.waitFor({ aria: 'scratch-2025', exact: true });
    await ui.screenshot('03-all-time');
    await ui.click('Skip setup');
    await ui.waitFor({ aria: 'Finish setting up Dispatch' });
    assert.equal(readState().draft.range, 'allTime');
    // Reload the same profile: instance start would clear it and cannot test resuming.
    await ui.reloadWindow(); // a real reload (location.reload() is refused by the workbench)
    await ui.sleep(1500);
    await ui.attach('agents', 60000);
    await ui.waitFor({ aria: 'Finish setting up Dispatch' }, { timeoutMs: 60000 });
    assert.equal(await ui.exists({ css: '.dispatch-whats-new-auto' }), false);
    await ui.click({ aria: 'Finish setting up Dispatch' });
    await ui.waitFor('Bring your folders in as projects');
    await ui.waitFor({ css: '.dob-range select' }, { timeoutMs: 60000 });
    assert.equal(await ui.eval("document.querySelector('.dob-range select').selectedOptions[0].textContent"), 'All time');
    await ui.click({ css: '.dob-foot .dob-btn.fill' });
    await ui.waitFor('Bring your preferences');
    await ui.waitFor({ aria: 'Select all clear preferences' }, { timeoutMs: 60000 });
    await screenshotPair(ui, '04-preferences');
    await ui.click({ css: '.dob-foot .dob-btn.fill' });
  }

  await continuePast(ui, 'Connect Dispatch to your agents');
  await screenshotPair(ui, '05-rules');
  await ui.mark('Set up Dispatch', { what: '规则和钩子', where: '向导最后一屏', how: '核对选中的引擎，点 Set up Dispatch' });
  await ui.clickWhenEnabled({ text: 'Set up Dispatch', exact: true });
  for (let i = 0; i < 120; i++) {
    if (await ui.exists({ text: 'Start', exact: true }) || await ui.exists({ text: 'Retry setup', exact: true })) break;
    if (await ui.exists({ text: 'Trust Publisher & Install', exact: true, within: '.monaco-dialog-box' })) {
      await ui.click({ text: 'Trust Publisher & Install', exact: true, within: '.monaco-dialog-box' });
    }
    await ui.sleep(1000);
  }
  await ui.waitFor({ text: 'Start', exact: true }, { timeoutMs: 180000 });
  assert.equal(await ui.eval("document.querySelectorAll('.dob-pr.failed').length"), 0);
  assert.equal(readState().state, 'done');
  if (terminal) {
    const tasks = JSON.parse(execFileSync('python3', [ui.rec.cli, 'task', 'list', '--folder', path.join(ui.rec.fixture_home, 'Projects/notes-site'), '--json'], {
      env: { ...process.env, HOME: ui.rec.fixture_home, BEADS_DIR: ui.rec.beads_dir, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home },
      encoding: 'utf8', timeout: 20000,
    }));
    assert.deepEqual(tasks.tasks, [], 'Earlier conversations must not become tasks');
    const importedSettings = JSON.parse(fs.readFileSync(path.join(ui.rec.user_data_dir, 'User', 'settings.json'), 'utf8'));
    assert.equal(importedSettings['editor.fontSize'], 14);
    assert.ok(readState().items.some(x => x.kind === 'vscode' && x.data.extensions?.includes('mechatroner.rainbow-csv')), 'Selected Open VSX extension must be installed and recorded');
  }
  await screenshotPair(ui, '06-finished');
  await ui.click({ text: 'Start', exact: true });
  // now What's new opens, once
  await ui.waitFor('Welcome to Dispatch', { timeoutMs: 30000 });
  await ui.press('Escape');
  if (terminal) {
    await ui.waitFor({ text: 'notes-site', exact: true }, { timeoutMs: 45000 });
    await ui.screenshot('06b-imported-sidebar');
  }
  // no "Dispatch is set up." toast with What was imported any more (task-lj06.26: it sat on the message box's Turbo);
  // the setup's last page says the list is in Settings: the command that opens it, from F1
  await ui.press('F1');
  await ui.type('What Was Imported', { into: { css: '.quick-input-widget input' } });
  await ui.sleep(800);
  await ui.press('Enter');
  await ui.waitFor('Imported by Dispatch', { timeoutMs: 30000 });
  await ui.waitFor({ aria: 'Undo Terminal command' }, { timeoutMs: 30000 });
  await ui.screenshot('07-migrations');
  await ui.mark('Imported by Dispatch', { what: '导入记录', where: '设置 › Abilities › What Dispatch changed on this Mac', how: '每项可单独 Undo，项目文件夹保留' });
  if (terminal) {
    const project = readState().items.find(x => x.kind === 'projects');
    assert.ok(project.data.projects.length >= 8);
    assert.ok(readState().items.some(x => x.kind === 'prefs'));
    assert.ok(readState().items.some(x => x.kind === 'vscode'));
    const vscodeReceipt = readState().items.find(x => x.kind === 'vscode' && !x.undone);
    const originalFont = vscodeReceipt.data.settings['editor.fontSize'];
    await ui.scrollTo('Undo VS Code');
    await ui.click({ aria: 'Undo VS Code' });
    await ui.waitFor({ aria: 'Undo VS Code' }, { gone: true, timeoutMs: 30000 });
    // the button goes before the CLI has written the receipt as undone: wait for the file, then check
    const undone = async id => {
      for (let i = 0; i < 60 && !readState().items.find(x => x.id === id)?.undone; i++) await ui.sleep(500);
      return !!readState().items.find(x => x.id === id)?.undone;
    };
    assert.ok(await undone(vscodeReceipt.id), 'Undo VS Code marks its receipt undone');
    const restoredSettings = JSON.parse(fs.readFileSync(path.join(ui.rec.user_data_dir, 'User', 'settings.json'), 'utf8'));
    assert.equal(restoredSettings['editor.fontSize'], originalFont.existed ? originalFont.prev : undefined);
    await ui.scrollTo('Undo Projects');
    await ui.click({ aria: 'Undo Projects' });
    await ui.waitFor({ aria: 'Undo Projects' }, { gone: true, timeoutMs: 30000 });
    assert.ok(await undone(project.id), 'Undo Projects marks its receipt undone');
    assert.ok(project.data.projects.every(p => fs.existsSync(p.dir)), 'Undo preserves project folders');
    await ui.screenshot('08-undo-projects');
    for (const engine of ['Claude Code', 'Codex', 'OpenCode']) {
      await ui.waitFor({ aria: `Undo ${engine}`, exact: true }, { timeoutMs: 30000 });
      await ui.scrollTo(`Undo ${engine}`);
      await ui.click({ aria: `Undo ${engine}` });
      await ui.waitFor({ aria: `Undo ${engine}` }, { gone: true, timeoutMs: 30000 });
    }
    await ui.waitFor({ aria: 'Review Connect Dispatch to your agents' }, { timeoutMs: 30000 });
    await ui.scrollTo('Review Connect Dispatch to your agents');
    await ui.click({ aria: 'Review Connect Dispatch to your agents' });
    await ui.waitFor('Connect Dispatch to your agents');
    await ui.waitFor({ text: 'Set up Dispatch', exact: true }, { timeoutMs: 30000 });
    await ui.sleep(2000);
    await ui.clickWhenEnabled({ text: 'Set up Dispatch', exact: true });
    await ui.waitFor({ text: 'Start', exact: true }, { timeoutMs: 180000 });
    assert.ok(!readState().items.some(x => x.kind === 'projects' && !x.undone), 'Connecting agents must not re-import projects whose page was not reviewed');
    await ui.screenshot('09-connect-only');
  } else {
    assert.ok(!readState().items.some(x => x.kind === 'projects' || x.kind === 'prefs'));
    assert.ok(!fs.existsSync(path.join(ui.rec.root, 'projects', 'demo')));
    // What was imported opens Settings › Abilities › What Dispatch changed (Customizations moved into Settings); Esc goes back
    await ui.press('Escape');
    await ui.waitFor({ css: '.part.sidebar.dispatch-settings-open', webview: false }, { gone: true, timeoutMs: 15000 });
    await ui.click({ text: 'Projects', exact: true });
    await ui.waitFor('No projects yet', { timeoutMs: 45000 });   // the empty state of the Add a project dialog's page
    // the page the person opened right after setup stays: the window's landing gives way to it (10-07, the Assistant used to
    // take the window over six seconds after Start)
    await ui.sleep(9000);
    assert.ok(await ui.exists('No projects yet'), 'the Projects page stays open after setup; the new chat does not take it over');
    await screenshotPair(ui, '08-empty-projects');
    await ui.click({ text: 'Waiting for you', exact: true });
    await ui.waitFor('Nothing new needs you.');
    await screenshotPair(ui, '09-empty-waiting');
    assert.equal(await ui.exists({ aria: 'Finish setting up Dispatch' }), false);
  }
}
